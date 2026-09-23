// 지라 화면 한 벌 — 프로젝트 탭의 지라 띠 카드(값 세 칸·확인 절차를 거치는 바꾸기), 하위 티켓 목록,
// 직접 만든 그룹 프로젝트에 티켓을 거는 수동 연결, 배포 임박 판단(리마인드·목록의 조용한 날짜).
// app.js에서 그대로 옮긴 코드다. app.js의 공용 부품(uiIcon·uiMenu·uiKoDate·uiMoreButton·request·
// showNotice·load·latestData·workflowData·jiraIssuesByKey·diffDays)에 기대고, 그 반대는 없다.
// index.html에서 app.js보다 먼저 읽힌다. 설정 창(settings-ui.js)이 jiraLiveNote를 쓴다.

// ---------- 지라 띠 카드 (프로젝트 탭, 읽기 전용) ----------
// 지라에 연결된 프로젝트를 열면 제목 아래에 지라의 지금 상태를 한 장으로 보여 준다.
// 앱 서버가 API 토큰으로 직접 읽어 오고(AI를 거치지 않는다) 이 화면은 **보기만** 한다 —
// 바꾸기는 다음 단계에서 확인 절차와 함께 붙는다. 그래서 값 하나하나를 부품 함수(jiraCell)로
// 그려, 그 자리만 고르개로 갈아 끼우면 되게 해 둔다.
//
// 지금 보고 있는 프로젝트 하나만 기억한다(목록 전체를 미리 부르지 않는다).
// seq는 "늦게 온 응답"을 버리는 표다 — 다른 프로젝트로 빨리 옮기면 먼저 보낸 응답이 새 화면을 덮지 않는다.
let jiraCard = { key: null, state: 'idle', issue: null, error: '', at: 0, seq: 0 };
const JIRA_REFRESH_MS = 60 * 1000;

// 이 화면에서 지라 구역을 아예 그리지 않는 때: `integrations.jira`를 꺼 둔 설정.
function jiraUsed() {
  return latestData?.jiraSync?.used !== false;
}

// 손으로 걸어 둔 `그룹 이름 → 지라 키` 표. 서버가 목록과 함께 보내 주고(`workflows.projectLinks`),
// 여기서만 읽는다. 그룹이 없어져 고아가 된 연결은 아무도 묻지 않으므로 화면에 나타나지 않는다.
function jiraProjectLinks() {
  return (typeof workflowData === 'object' && workflowData && workflowData.projectLinks) || {};
}

// 이 프로젝트의 지라 키를 얻는 단 하나의 함수. `jira:KEY`는 키 그 자체이고, 직접 만든(그룹)
// 프로젝트는 사람이 손으로 걸어 둔 티켓이 있으면 그 키다 — 띠 카드도 `열린 항목 N · KEY` 줄도
// 여기서만 키를 얻어, 두 갈래의 프로젝트가 같은 길을 쓴다.
function jiraKeyOf(projectKey) {
  if (typeof projectKey !== 'string') return '';
  if (projectKey.startsWith('jira:')) return projectKey.slice('jira:'.length);
  if (projectKey.startsWith('group:')) return jiraProjectLinks()[projectKey.slice('group:'.length)] || '';
  return '';
}

// 상태는 범주로만 색이 붙는다(배지가 아니다): 진행=파란 글자 · 완료=성공색 글자 · 할 일=회색.
function jiraStatusTone(category) {
  return category === 'done' ? 'k-pos' : category === 'todo' ? 'k-dim' : 'k-acc';
}

// 배포 버전 한 칸의 말. 이름은 그대로 보여 주고, 날짜는 뒤에 조용히 붙인다.
// 색은 둘뿐이다 — 배포일이 3일 안이면 주의색, 지났는데 아직 배포 안 됐으면 급함 색.
function jiraVersionText(versions) {
  const list = Array.isArray(versions) ? versions.filter(Boolean) : [];
  if (!list.length) return null;
  const first = list[0];
  const name = (first.name || '') + (list.length > 1 ? ` 외 ${list.length - 1}개` : '');
  if (!first.releaseDate) return { name, note: '', tone: '', hint: '' };
  const day = uiKoDateShort(first.releaseDate);
  if (first.released) return { name, note: `· ${day} 배포함`, tone: '', hint: `${uiKoDate(first.releaseDate)}에 배포된 버전이에요` };
  const left = diffDays(first.releaseDate);
  if (Number.isNaN(left)) return { name, note: '', tone: '', hint: '' };
  if (left < 0) return { name, note: `· ${day} 배포 예정 · ${-left}일 지남`, tone: 'k-neg', hint: '배포 예정일이 지났는데 아직 배포되지 않았어요' };
  if (left === 0) return { name, note: '· 오늘 배포 예정', tone: 'k-warn', hint: `${uiKoDate(first.releaseDate)}에 배포할 버전이에요` };
  if (left <= 3) return { name, note: `· ${day} 배포 예정 · ${left}일 남음`, tone: 'k-warn', hint: `${uiKoDate(first.releaseDate)}에 배포할 버전이에요` };
  return { name, note: `· ${day} 배포 예정`, tone: '', hint: `${uiKoDate(first.releaseDate)}에 배포할 버전이에요` };
}

// 하위 티켓 진행률 — 하나도 없으면 줄 자체를 그리지 않는다(`0`은 찍지 않는다).
function jiraChildrenLabel(children) {
  if (!children || !children.total) return null;
  const done = Math.min(Math.max(children.done || 0, 0), children.total);
  return { text: `${children.total}개 중 ${done}개 완료`, ratio: Math.round((done / children.total) * 100) };
}

// ---------- 하위 티켓 목록 (3단계 — 읽기 전용) ----------
// 지라 것은 지라 카드 안에 둔다: 접힌 줄에 미완료의 담당별 개수, 펼치면 티켓마다
// 지라 상태 · 요약(지라 새 탭) · 담당자 · 배포 버전. 여기서 지라에 쓰는 길은 만들지 않는다 —
// 줄을 누르면 지라가 열릴 뿐이다.
const JIRA_CHILD_NONE = '담당 없음';
const JIRA_CHILD_NAMES = 4;      // 접힌 줄에 이름으로 적는 최대 인원 — 넘으면 `외 N명`
const JIRA_CHILD_DONE_FOLD = 5;  // 완료가 이보다 많으면 나머지를 `완료 N개 더 보기`로 접는다
const JIRA_CHILD_MAX = 100;      // 서버가 읽어 오는 최대 개수 — 다 차면 끝에 `지라에서 전체 보기`
const JIRA_CHILD_OPEN_KEY = 'jiraChildrenOpen';
// 펼침 여부는 프로젝트별로 기억한다. **켜고 끄는 값은 메모리의 이 Set이고** localStorage는
// 곁들이는 기억이다 — 저장이 막혀 있어도(사생활 보호 창 등) 펼치기는 그대로 동작한다.
let jiraChildOpen = null;
// 거르기는 기억하지 않는다(프로젝트를 옮기면 풀린다). 접어 둔 완료도 마찬가지다.
let jiraChildPick = null;
let jiraChildDoneOpen = false;

function jiraChildOpenSet() {
  if (jiraChildOpen) return jiraChildOpen;
  let saved = [];
  try {
    const raw = JSON.parse(localStorage.getItem(JIRA_CHILD_OPEN_KEY));
    if (Array.isArray(raw)) saved = raw.filter(entry => typeof entry === 'string');
  } catch {}
  jiraChildOpen = new Set(saved);
  return jiraChildOpen;
}
const jiraChildOpened = projectKey => jiraChildOpenSet().has(String(projectKey || ''));
function jiraChildRemember(projectKey, open) {
  const set = jiraChildOpenSet();
  if (open) set.add(String(projectKey || ''));
  else set.delete(String(projectKey || ''));
  try { localStorage.setItem(JIRA_CHILD_OPEN_KEY, JSON.stringify([...set].slice(-40))); } catch {}
}

// 접힌 줄의 담당별 요약 — **미완료만** 센다(많은 순, 같으면 가나다).
// 다 끝났으면 이름 대신 `모두 완료` 한 마디다.
function jiraChildSummary(items) {
  const open = (items || []).filter(item => item && item.status && item.status.category !== 'done');
  if (!open.length) return { names: [], extra: 0, allDone: true };
  const counts = new Map();
  open.forEach((item) => {
    const name = item.assignee || JIRA_CHILD_NONE;
    counts.set(name, (counts.get(name) || 0) + 1);
  });
  // `담당 없음`은 이름이 아니므로 같은 개수끼리는 맨 뒤로 보낸다.
  const all = [...counts].map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count
      || (a.name === JIRA_CHILD_NONE ? 1 : 0) - (b.name === JIRA_CHILD_NONE ? 1 : 0)
      || a.name.localeCompare(b.name, 'ko'));
  return { names: all.slice(0, JIRA_CHILD_NAMES), extra: Math.max(all.length - JIRA_CHILD_NAMES, 0), allDone: false };
}

// 순서: 미완료 먼저(진행 → 할 일), 완료는 맨 아래. 같은 범주 안에서는 지라가 준 차례 그대로다.
const JIRA_CHILD_RANK = { doing: 0, todo: 1, done: 2 };
function jiraChildOrder(items) {
  return (items || []).map((item, at) => ({ item, at }))
    .sort((a, b) => (JIRA_CHILD_RANK[a.item?.status?.category] ?? 0) - (JIRA_CHILD_RANK[b.item?.status?.category] ?? 0) || a.at - b.at)
    .map(entry => entry.item);
}

const jiraChildWhoOf = item => (item && item.assignee) || JIRA_CHILD_NONE;

// 값 한 칸(라벨 위 · 값 아래). `pick`을 주면 값 자리가 상세 카드와 같은 값 고르개가 된다
// (값 + 꺾쇠, hover 면). 고르개를 눌러도 곧바로 쓰지 않는다 — 확인 줄을 한 번 더 거친다.
function jiraCell(label, text, tone, hint, pick) {
  const cell = document.createElement('div');
  cell.className = 'cell';
  const lb = document.createElement('span');
  lb.className = 'lb';
  lb.textContent = label;
  const value = document.createElement('span');
  value.className = 'v' + (text ? (tone ? ` ${tone}` : '') : ' is-none');
  // 지라가 준 글자는 언제나 textContent로만 넣는다(새 innerHTML을 쓰지 않는다).
  value.textContent = text || '없음';
  cell.appendChild(lb);
  if (!pick) {
    if (hint) value.title = hint;
    cell.appendChild(value);
    return cell;
  }
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'd-dpick';
  button.setAttribute('aria-haspopup', 'true');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-label', `${label} — 눌러서 바꾸기`);
  if (hint) button.title = hint;
  if (pick.disabled) button.disabled = true;
  const caret = document.createElement('span');
  caret.className = 'cv';
  // 고정 마크업(꺾쇠 아이콘)만 붙는 자리다 — 지라가 준 글자는 위 textContent로만 들어간다.
  caret.insertAdjacentHTML('beforeend', uiIcon('chevron'));
  button.append(value, caret);
  button.addEventListener('click', (event) => {
    if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
    jiraPickOpen(button, pick.sections);
  });
  cell.appendChild(button);
  return cell;
}

// 조용한 한 줄 — 연결 안 됨·오류일 때 카드 대신 선다.
function jiraQuietLine(text, actionLabel, onAction, hint) {
  const line = document.createElement('div');
  line.className = 'd-jline';
  const words = document.createElement('span');
  words.textContent = text;
  line.append(words);
  if (actionLabel) {
    const sep = document.createElement('span');
    sep.className = 'sep';
    sep.textContent = '·';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'd-link';
    button.textContent = actionLabel;
    if (hint) button.title = hint;
    button.addEventListener('click', onAction);
    line.append(sep, button);
  }
  return line;
}

const JIRA_SETUP_HINT = 'README의 "지라 연결 설정" 절을 따라 workspace.config.json에 지라 항목을 넣어 주세요';

// 부르는 동안 서는 뼈대 — 카드와 높이가 같고 깜빡이지 않는다(움직이는 효과를 주지 않는다).
function jiraSkeleton() {
  const card = document.createElement('div');
  card.className = 'd-jira is-loading';
  card.setAttribute('aria-hidden', 'true');
  const top = document.createElement('div');
  top.className = 'top';
  const bar = (width) => { const el = document.createElement('span'); el.className = 'sk'; el.setAttribute('style', `width:${width}`); return el; };
  const spacer = document.createElement('span');
  spacer.className = 'sp';
  const round = document.createElement('span');
  round.className = 'sk round';
  // 카드의 첫 줄과 같은 칸들(표시 · 요약 · 링크 · 새로고침) 자리를 그대로 잡아 둔다.
  top.append(bar('34px'), bar('190px'), spacer, bar('82px'), round);
  const cells = document.createElement('div');
  cells.className = 'cells';
  ['92px', '150px', '76px'].forEach((width) => {
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.append(bar('52px'), bar(width));
    cells.appendChild(cell);
  });
  card.append(top, cells);
  return card;
}

// ---------- 지라 바꾸기 (2단계 — 지라에 쓴다, 전부 확인 절차) ----------
// 지키는 것: ① 확인 줄을 거치지 않으면 어떤 쓰기 요청도 나가지 않는다.
// ② 낙관적 갱신을 하지 않는다 — 성공한 뒤 `fresh=1`로 다시 읽어 지라가 준 값만 그린다.
// ③ 앱의 ⌘Z 대상이 아니다: `request()`를 타지 않아 `pushUndo`·`recordUndoFor`가 돌지 않는다.
// ④ 쓰는 동안 세 고르개가 모두 잠겨 한 카드에서 동시에 두 개를 쓰지 않는다.
const JIRA_OPTIONS_MS = 30 * 1000;
let jiraOptions = { key: null, at: 0, transitions: [], versions: [] };
let jiraBusy = false;
let jiraConfirm = null;
// 옮기기(BMOVE) 확인 줄 — 띠 카드 ⋯의 `IO-123으로 옮기기…`를 눌렀을 때만 값이 있다.
// `{ projectKey, key, busy }` — 지라에는 아무것도 쓰지 않으므로 jiraBusy(위 세 고르개용)와는 따로 잠근다.
let jiraStripMoveConfirm = null;

const jiraOpen = (url) => { if (typeof window !== 'undefined' && typeof window.open === 'function') window.open(url, '_blank', 'noopener'); };

// 고르개를 여는 순간에만 지라에서 선택지를 읽는다(카드를 그릴 때는 부르지 않는다).
async function jiraOptionsLoad(key) {
  if (jiraOptions.key === key && Date.now() - jiraOptions.at < JIRA_OPTIONS_MS) return jiraOptions;
  const response = await fetch(`/api/jira/options?key=${encodeURIComponent(key)}`);
  const data = await response.json();
  if (data.connected === false) throw new Error('지라 연결이 필요해요.');
  if (data.ok !== true) throw new Error(data.error || '지라에 연결하지 못했어요.');
  jiraOptions = { key, at: Date.now(), transitions: data.transitions || [], versions: data.versions || [] };
  return jiraOptions;
}

// 지라에 쓰는 단 하나의 길. 확인 줄의 `바꾸기`만 이 함수를 부른다.
async function jiraChangeSend(body) {
  const response = await fetch('/api/jira/change', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  let data = null;
  try { data = await response.json(); } catch { data = null; }
  if (!data || data.ok !== true) throw new Error((data && data.error) || '지라에 반영하지 못했어요.');
  return data;
}

// 카드 안에서 무언가를 찾는 자리 하나(가짜 창에서도 안전하게 흘러가게 물음표로 잇는다).
const jiraCardNode = () => document.getElementById('jiraStrip')?.querySelector?.('.d-jira') || null;

function jiraConfirmClose(repaint = true) {
  if (!jiraConfirm) return;
  const { onEsc, pickLabel } = jiraConfirm;
  escDrop(onEsc);
  jiraConfirm = null;
  if (!repaint) return;
  jiraStripPaint();
  // 닫으면 값을 고르던 그 고르개로 초점이 돌아간다(메뉴에서 값을 고른 뒤 초점이 머리로 튀지 않게).
  jiraCardNode()?.querySelector?.(`.d-dpick[aria-label^="${pickLabel}"]`)?.focus?.();
}
// 고른 값은 곧바로 나가지 않는다 — 카드 안에 확인 줄을 세우고 거기서만 보낸다.
function jiraConfirmOpen(plan) {
  jiraConfirmClose(false);
  plan.onEsc = () => jiraConfirmClose();
  escPush(plan.onEsc);
  jiraConfirm = plan;
  jiraStripPaint();
  // 그려 붙인 뒤에 초점을 옮긴다 — 읽는 프로그램이 묻는 말부터 읽고, Tab이 `취소`·`바꾸기`로 이어진다.
  jiraCardNode()?.querySelector?.('.d-jconfirm')?.focus?.();
}
// 바깥을 누르면 취소다(메뉴 안 클릭은 메뉴가 전파를 막으므로 여기 오지 않는다).
document.addEventListener('click', (event) => {
  if (!jiraConfirm) return;
  const row = jiraCardNode()?.querySelector?.('.d-jconfirm');
  if (row && typeof row.contains === 'function' && row.contains(event.target)) return;
  jiraConfirmClose();
});

// 쓰는 동안 카드의 고르개·새로고침을 그 자리에서 잠근다(다시 그리지 않는다 — 확인 줄이 살아 있어야 한다).
function jiraLockPicks(locked) {
  const card = jiraCardNode();
  if (!card || typeof card.querySelectorAll !== 'function') return;
  card.querySelectorAll('.d-dpick, .d-jref, .d-more').forEach((node) => { node.disabled = locked; });
}

// 고르개를 여는 길 하나. 선택지를 못 읽으면 알림만 띄우고 메뉴를 열지 않는다.
async function jiraPickOpen(button, sections) {
  if (jiraBusy) return;
  if (uiMenuOpen && uiMenuOpen.anchor === button) { uiMenuClose(); return; }
  // 떠 있던 확인 줄은 먼저 닫는다(다시 그린다) — 그러면 이 버튼이 떨어져 나가므로 같은 고르개를 다시 찾는다.
  const label = button.getAttribute('aria-label') || '';
  if (jiraConfirm) jiraConfirmClose();
  const anchor = (button.isConnected === false && jiraCardNode()?.querySelector?.(`.d-dpick[aria-label="${label}"]`)) || button;
  anchor.disabled = true;
  let built;
  try {
    built = await sections();
  } catch (error) {
    showNotice(error.message || '지라에 연결하지 못했어요.', true);
    return;
  } finally {
    anchor.disabled = false;
  }
  if (anchor.isConnected === false) return;
  uiMenu(anchor, built);
}

const jiraVersionOptionLabel = version => (version.releaseDate ? `${version.name} · ${uiKoDateShort(version.releaseDate)}` : version.name);

// 지라 상태: 지라가 허용하는 전환만 내놓는다. 추가 입력이 필요한 전환은 선택지에 두되 쓰지 않는다.
async function jiraStatusSections(issue) {
  const { transitions } = await jiraOptionsLoad(issue.key);
  const before = issue.status?.name || '';
  const items = transitions.map(entry => ({
    label: entry.name,
    tone: jiraStatusTone(entry.category),
    onClick: () => {
      if (entry.requiresInput) {
        showNotice('이 전환은 지라에서 직접 해 주세요', true, null, { label: '지라에서 열기', onClick: () => jiraOpen(issue.url) });
        return;
      }
      jiraConfirmOpen({
        key: issue.key, label: '지라 상태', pickLabel: '지라 상태', before, after: entry.name,
        body: { key: issue.key, kind: 'status', transitionId: entry.id },
      });
    },
  }));
  return [items.length ? items : [{ label: '지라에서 바꿀 수 있는 상태가 없어요', disabled: true, onClick: () => {} }]];
}

// 배포 버전: ① 이 티켓을 다른 버전으로 ② 이 버전 고치기(이름·배포일 — 모든 티켓에 적용된다).
async function jiraVersionSections(issue) {
  const { versions } = await jiraOptionsLoad(issue.key);
  const attached = Array.isArray(issue.versions) ? issue.versions.filter(Boolean) : [];
  const current = attached.length === 1 ? attached[0] : null;
  const head = [{ field: '이 티켓을 다른 버전으로' }];
  if (attached.length > 1) {
    return [[...head,
      { label: '버전이 여러 개라 지라에서 직접 바꿔 주세요', disabled: true, onClick: () => {} },
      { label: '지라에서 열기', onClick: () => jiraOpen(issue.url) },
    ]];
  }
  // 지금 걸린 버전이 미배포 목록에 없으면(이미 배포된 버전이면) 선택지에 함께 세운다.
  const choices = versions.some(version => current && version.id === current.id) || !current
    ? versions
    : [...versions, { id: current.id, name: current.name, releaseDate: current.releaseDate }];
  const move = choices
    .filter(version => !current || version.id !== current.id)
    .map(version => ({
      label: jiraVersionOptionLabel(version),
      onClick: () => jiraConfirmOpen({
        key: issue.key, label: '지라의 배포 버전', pickLabel: '배포 버전', before: current ? current.name : '', after: version.name,
        body: { key: issue.key, kind: 'version', versionId: version.id },
      }),
    }));
  if (current) {
    move.push({
      label: '버전 없음',
      onClick: () => jiraConfirmOpen({
        key: issue.key, label: '지라의 배포 버전', pickLabel: '배포 버전', before: current.name, after: '',
        body: { key: issue.key, kind: 'version', versionId: null },
      }),
    });
  }
  const first = [...head, ...(move.length ? move : [{ label: '고를 수 있는 미배포 버전이 없어요', disabled: true, onClick: () => {} }])];
  if (!current) return [first];
  const edit = [
    { field: '이 버전 고치기' },
    {
      field: '이름',
      control: uiMenuText({
        value: current.name, label: '지라의 배포 버전 이름',
        onChange: (next) => {
          uiMenuClose();
          if (!next || next === current.name) return;
          jiraConfirmOpen({
            key: issue.key, label: '이 버전의 이름', pickLabel: '배포 버전', before: current.name, after: next,
            warn: '이 버전을 쓰는 모든 티켓에 적용돼요',
            body: { key: issue.key, kind: 'versionEdit', versionId: current.id, name: next },
          });
        },
      }),
    },
    {
      field: '배포일',
      control: uiDateField({
        value: current.releaseDate || '', label: '지라의 배포일',
        onChange: (next) => {
          uiMenuClose();
          if ((next || '') === (current.releaseDate || '')) return;
          jiraConfirmOpen({
            key: issue.key, label: '이 버전의 배포일', pickLabel: '배포 버전',
            before: current.releaseDate ? uiKoDateShort(current.releaseDate) : '',
            after: next ? uiKoDateShort(next) : '',
            warn: '이 버전을 쓰는 모든 티켓에 적용돼요',
            body: { key: issue.key, kind: 'versionEdit', versionId: current.id, releaseDate: next },
          });
        },
      }),
    },
  ];
  return [first, edit];
}

// 기한: 날짜 칸 하나(지우기 포함).
async function jiraDueSections(issue) {
  return [[
    {
      field: '지라의 기한',
      control: uiDateField({
        value: issue.due || '', label: '지라의 기한', pickLabel: '기한',
        onChange: (next) => {
          uiMenuClose();
          if ((next || '') === (issue.due || '')) return;
          jiraConfirmOpen({
            key: issue.key, label: '지라의 기한', pickLabel: '기한',
            before: issue.due ? uiKoDateShort(issue.due) : '',
            after: next ? uiKoDateShort(next) : '',
            body: { key: issue.key, kind: 'due', due: next },
          });
        },
      }),
    },
  ]];
}

// 확인 줄 — `지라의 이 티켓을 바꿀까요?` + 티켓 요약(키는 조용한 글자) + 전→후 + `취소`/`바꾸기`.
function jiraConfirmRow(issue, plan) {
  const row = document.createElement('div');
  row.className = 'd-jconfirm';
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', '지라에 보내기 전 확인');
  row.setAttribute('tabindex', '-1');

  const ask = document.createElement('div');
  ask.className = 'ask';
  ask.textContent = '지라의 이 티켓을 바꿀까요?';
  const what = document.createElement('div');
  what.className = 'what';
  const summary = document.createElement('span');
  summary.className = 'sm';
  summary.textContent = issue.summary || issue.key;
  const keyText = document.createElement('span');
  keyText.className = 'ky';
  keyText.textContent = issue.key;
  what.append(summary, keyText);

  const diff = document.createElement('div');
  diff.className = 'diff';
  const label = document.createElement('span');
  label.className = 'lb';
  label.textContent = `${plan.label}:`;
  const before = document.createElement('span');
  before.className = 'bf';
  before.textContent = plan.before || '없음';
  const arrow = document.createElement('span');
  arrow.className = 'ar';
  arrow.textContent = '→';
  const after = document.createElement('span');
  after.className = 'af';
  after.textContent = plan.after || '없음';
  diff.append(label, before, arrow, after);
  row.append(ask, what, diff);

  if (plan.warn) {
    const warn = document.createElement('div');
    warn.className = 'warn';
    warn.textContent = plan.warn;
    row.appendChild(warn);
  }

  const acts = document.createElement('div');
  acts.className = 'acts';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'd-btn sm';
  cancel.textContent = '취소';
  cancel.addEventListener('click', () => jiraConfirmClose());
  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'd-btn sm acc';
  go.textContent = '바꾸기';
  go.addEventListener('click', async () => {
    if (jiraBusy) return;
    jiraBusy = true;
    jiraLockPicks(true);
    cancel.disabled = true;
    go.disabled = true;
    go.textContent = '보내는 중…';
    try {
      await jiraChangeSend(plan.body);
      jiraBusy = false;
      jiraConfirmClose(false);
      // 선택지도 함께 낡았다 — 다음에 고르개를 열면 지라에서 새로 읽는다.
      jiraOptions = { key: null, at: 0, transitions: [], versions: [] };
      showNotice('지라에서 바꿨어요', false, null, { label: '지라에서 열기', onClick: () => jiraOpen(issue.url) });
      // 낙관적 갱신 금지 — 지라가 준 값만 그린다.
      await jiraCardLoad(issue.key, { fresh: true });
    } catch (error) {
      jiraBusy = false;
      jiraConfirmClose(false);
      showNotice(error.message || '지라에 반영하지 못했어요.', true);
      jiraStripPaint();
    }
  });
  acts.append(cancel, go);
  row.appendChild(acts);
  return row;
}

// projectKey는 이 카드가 서 있는 프로젝트다 — `group:…`이면 손으로 건 연결이라 카드에 ⋯(해제)가 붙는다.
function jiraStripBody(key, projectKey = '') {
  if (!key) return null;
  if (jiraCard.key !== key || jiraCard.state === 'loading' || jiraCard.state === 'idle') return jiraSkeleton();
  if (jiraCard.state === 'off') {
    return jiraQuietLine('지라 연결이 필요해요', '설정 방법', () => showNotice(JIRA_SETUP_HINT), JIRA_SETUP_HINT);
  }
  if (jiraCard.state === 'error') {
    return jiraQuietLine(jiraCard.error || '지라에 연결하지 못했어요.', '다시 시도', () => jiraCardLoad(key, { fresh: true }));
  }
  return jiraStripCard(jiraCard.issue, projectKey);
}

// B 띠 카드: 첫 줄(지라 표시 · 요약 · 종류/담당 · 지라에서 열기 · 새로고침),
// 둘째 줄(지라 상태 · 배포 버전 · 기한), 셋째 줄(하위 티켓 진행률).
function jiraStripCard(issue, projectKey = '') {
  const card = document.createElement('div');
  card.className = 'd-jira';
  card.setAttribute('aria-label', '지라에서 읽어 온 지금 상태');

  const top = document.createElement('div');
  top.className = 'top';
  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = '지라';
  const name = document.createElement('span');
  name.className = 'nm';
  name.textContent = issue.summary || issue.key;
  name.title = issue.summary || issue.key;
  const sub = document.createElement('span');
  sub.className = 'sub';
  sub.textContent = [issue.type, `담당 ${issue.assignee || '없음'}`].filter(Boolean).join(' · ');
  const spacer = document.createElement('span');
  spacer.className = 'sp';
  const link = document.createElement('a');
  link.className = 'd-jopen';
  // 주소는 앱이 조립한다(siteUrl + /browse/KEY). 키는 여기 title로만 보인다(BKEY 결정).
  link.href = issue.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.title = `${issue.key} · 지라에서 열어요`;
  link.textContent = '지라에서 열기 ↗';
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.className = 'd-iconbtn sm d-jref';
  refresh.setAttribute('aria-label', '지라 상태 새로고침');
  refresh.title = '지라에서 다시 읽어요';
  if (jiraBusy) refresh.disabled = true;
  refresh.insertAdjacentHTML('beforeend', uiIcon('refresh'));
  refresh.addEventListener('click', () => jiraCardLoad(issue.key, { fresh: true }));
  top.append(tag, name, sub, spacer, link, refresh);
  // 손으로 건 연결을 푸는 자리는 여기 하나다. `jira:KEY` 프로젝트의 카드에는 ⋯가 없다 —
  // 그 카드는 프로젝트가 곧 티켓이라 풀 연결이 아니다. 에픽이면 옮기기(BMOVE)도 같은 메뉴에 선다.
  if (typeof projectKey === 'string' && projectKey.startsWith('group:')) {
    const menuItems = [{ label: '지라 연결 해제', onClick: () => jiraLinkRemove(projectKey, issue.key) }];
    if (issue.type === '에픽') {
      menuItems.push({ label: `${issue.key}으로 옮기기…`, onClick: () => { jiraStripMoveConfirm = { projectKey, key: issue.key, busy: false }; jiraStripPaint(); } });
    }
    const more = uiMoreButton('지라 연결 — 더 보기', () => [menuItems]);
    if (jiraBusy) more.disabled = true;
    top.appendChild(more);
  }

  const cells = document.createElement('div');
  cells.className = 'cells';
  const version = jiraVersionText(issue.versions);
  // 쓰는 동안(그리고 확인 줄이 떠 있는 동안)은 세 고르개가 모두 잠긴다 — 한 카드에서 두 개를 동시에 쓰지 않는다.
  const locked = jiraBusy;
  cells.append(
    jiraCell('지라 상태', issue.status?.name, jiraStatusTone(issue.status?.category), '지라에 적힌 지금 상태예요 — 눌러서 바꿔요',
      { disabled: locked, sections: () => jiraStatusSections(issue) }),
    jiraCell('배포 버전', version ? `${version.name} ${version.note}`.trim() : '', version ? version.tone : '',
      version ? version.hint : '지라의 배포 버전이 아직 없어요',
      { disabled: locked, sections: () => jiraVersionSections(issue) }),
    jiraCell('기한', issue.due ? uiKoDateShort(issue.due) : '', '',
      issue.due ? `지라에 적힌 기한은 ${uiKoDate(issue.due)}이에요` : '지라에 적힌 기한이 없어요',
      { disabled: locked, sections: () => jiraDueSections(issue) }),
  );
  card.append(top, cells);

  // 확인 줄은 값 칸 바로 아래에 선다 — 무엇을 바꾸는지와 가장 가까운 자리다.
  if (jiraConfirm && jiraConfirm.key === issue.key) card.appendChild(jiraConfirmRow(issue, jiraConfirm));
  // 옮기기(BMOVE) 확인 줄 — ⋯의 `IO-123으로 옮기기…`를 눌렀을 때만 선다.
  if (jiraStripMoveConfirm && jiraStripMoveConfirm.key === issue.key && jiraStripMoveConfirm.projectKey === projectKey) {
    card.appendChild(wfMoveConfirmNode(projectKey.slice('group:'.length), issue.key, {
      busy: jiraStripMoveConfirm.busy,
      onCancel: () => { jiraStripMoveConfirm = null; jiraStripPaint(); },
      onConfirm: () => jiraStripMoveRun(projectKey, issue.key),
    }));
  }

  const children = jiraChildrenLabel(issue.children);
  if (children) {
    // 펼침은 카드가 선 프로젝트마다 기억한다 — `jira:KEY`든 손으로 건 그룹이든 같은 열쇠 하나다.
    const seat = projectKey || `jira:${issue.key}`;
    const items = (issue.children && Array.isArray(issue.children.items) ? issue.children.items : []).filter(Boolean);
    const open = !!items.length && jiraChildOpened(seat);
    card.appendChild(jiraChildFoot(seat, children, items, open));
    if (open) card.appendChild(jiraChildList(issue, items));
  }
  return card;
}

// 접힌 줄: 진행률 + 미완료의 담당별 개수(누르면 그 사람 것만) + 줄 끝 꺾쇠.
function jiraChildFoot(seat, children, items, open) {
  const foot = document.createElement('div');
  foot.className = 'foot';
  const label = document.createElement('span');
  label.textContent = '하위 티켓';
  const bar = document.createElement('span');
  bar.className = 'bar';
  bar.setAttribute('role', 'img');
  bar.setAttribute('aria-label', `하위 티켓 ${children.text}`);
  const fill = document.createElement('i');
  fill.setAttribute('style', `width:${children.ratio}%`);
  bar.appendChild(fill);
  const count = document.createElement('span');
  count.textContent = children.text;
  foot.append(label, bar, count);
  if (!items.length) return foot;
  foot.appendChild(jiraChildWho(seat, items));
  const spacer = document.createElement('span');
  spacer.className = 'sp';
  const caret = document.createElement('button');
  caret.type = 'button';
  caret.className = 'd-iconbtn sm d-jexp';
  caret.setAttribute('aria-expanded', open ? 'true' : 'false');
  caret.setAttribute('aria-label', open ? '하위 티켓 접기' : '하위 티켓 펼치기');
  caret.title = open ? '하위 티켓 목록을 접어요' : '하위 티켓 목록을 펼쳐요';
  // 고정 마크업(꺾쇠 아이콘)만 붙는 자리다 — 지라가 준 글자는 전부 textContent로만 들어간다.
  caret.insertAdjacentHTML('beforeend', uiIcon('chevron'));
  caret.addEventListener('click', () => {
    jiraChildRemember(seat, !open);
    // 접으면 거르기도 함께 푼다 — 다시 폈을 때 왜 몇 줄뿐인지 모를 일이 없게.
    if (open) { jiraChildPick = null; jiraChildDoneOpen = false; }
    jiraStripPaint();
  });
  foot.append(spacer, caret);
  return foot;
}

// 담당별 요약. 이름은 누르는 글자다(별도 토글·드롭다운을 만들지 않는다) — 거르는 중이면 굵어지고 `전체`가 붙는다.
function jiraChildWho(seat, items) {
  const box = document.createElement('span');
  box.className = 'who';
  const summary = jiraChildSummary(items);
  if (summary.allDone) {
    const all = document.createElement('span');
    all.className = 'qt';
    all.textContent = '모두 완료';
    box.appendChild(all);
    return box;
  }
  summary.names.forEach((entry, at) => {
    if (at) {
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '·';
      box.appendChild(sep);
    }
    const on = jiraChildPick === entry.name;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'd-jwho';
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
    button.setAttribute('aria-label', `${entry.name} — 이 담당의 하위 티켓만 보기`);
    button.title = on ? '눌러서 전체를 다시 봐요' : `${entry.name}가 맡은 하위 티켓만 봐요`;
    button.textContent = `${entry.name} ${entry.count}`;
    button.addEventListener('click', () => {
      jiraChildPick = on ? null : entry.name;
      jiraChildDoneOpen = false;
      // 접혀 있을 때 이름을 누르면 펼쳐지며 그 사람 것만 보인다.
      if (jiraChildPick) jiraChildRemember(seat, true);
      jiraStripPaint();
    });
    box.appendChild(button);
  });
  if (summary.extra) {
    const more = document.createElement('span');
    more.className = 'qt';
    more.textContent = `외 ${summary.extra}명`;
    box.appendChild(more);
  }
  if (jiraChildPick) {
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'd-jwho clear';
    clear.textContent = '전체';
    clear.title = '담당자 거르기를 풀어요';
    clear.addEventListener('click', () => { jiraChildPick = null; jiraChildDoneOpen = false; jiraStripPaint(); });
    box.appendChild(clear);
  }
  return box;
}

// 펼친 목록. 읽기 전용이다 — 누를 수 있는 것은 요약(지라 새 탭)과 `완료 N개 더 보기`뿐이다.
function jiraChildList(issue, items) {
  const list = document.createElement('div');
  list.className = 'd-jkids';
  const picked = jiraChildPick ? items.filter(item => jiraChildWhoOf(item) === jiraChildPick) : items;
  const ordered = jiraChildOrder(picked);
  const done = ordered.filter(item => item.status && item.status.category === 'done');
  const folded = jiraChildDoneOpen ? 0 : Math.max(done.length - JIRA_CHILD_DONE_FOLD, 0);
  const shown = folded ? ordered.slice(0, ordered.length - folded) : ordered;
  if (!shown.length) {
    const none = document.createElement('div');
    none.className = 'none';
    none.textContent = '이 담당의 하위 티켓이 없어요';
    list.appendChild(none);
    return list;
  }
  // 배포 버전 칸은 그 칸을 쓰는 줄이 하나라도 있을 때만 자리를 잡는다(빈 칸을 남기지 않는다).
  if (shown.some(item => item.version)) list.className = 'd-jkids has-ver';
  shown.forEach(item => list.appendChild(jiraChildRow(item)));
  if (folded) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'd-link more';
    more.textContent = `완료 ${folded}개 더 보기`;
    more.addEventListener('click', () => { jiraChildDoneOpen = true; jiraStripPaint(); });
    list.appendChild(more);
  }
  // 지라에서 100개까지만 읽어 온다 — 다 찼으면 나머지는 지라에서 본다.
  if (items.length >= JIRA_CHILD_MAX) {
    const all = document.createElement('a');
    all.className = 'all';
    all.href = issue.url;
    all.target = '_blank';
    all.rel = 'noopener noreferrer';
    all.title = `${issue.key} · 지라에서 하위 티켓을 전부 봐요`;
    all.textContent = '지라에서 전체 보기 ↗';
    list.appendChild(all);
  }
  return list;
}

// 한 줄 = 지라 상태 · 요약(지라 새 탭) · 담당자 · 조용한 배포 버전.
// 상태는 범주로만 색이 붙는다(배지가 아니다) — 카드 위의 `지라 상태` 칸과 같은 규칙이다.
function jiraChildRow(item) {
  const row = document.createElement('div');
  const category = item.status && item.status.category;
  row.className = 'd-jkid' + (category === 'done' ? ' is-done' : '');
  const status = document.createElement('span');
  const tone = jiraStatusTone(category);
  status.className = 'st' + (tone ? ` ${tone}` : '');
  status.textContent = (item.status && item.status.name) || '';
  const link = document.createElement('a');
  link.className = 'sm';
  // 주소는 앱이 조립한 것(siteUrl + /browse/KEY)이고, 키는 title에만 보인다(BKEY).
  link.href = item.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.title = `${item.key} · 지라에서 열어요`;
  link.textContent = item.summary || '제목 없음';
  const who = document.createElement('span');
  who.className = 'wh' + (item.assignee ? '' : ' is-none');
  who.textContent = jiraChildWhoOf(item);
  row.append(status, link, who);
  if (item.version) {
    const version = document.createElement('span');
    version.className = 'ver';
    version.title = '지라의 배포 버전이에요';
    version.textContent = item.version;
    row.appendChild(version);
  }
  return row;
}

// 카드 자리만 다시 그린다 — 늦게 온 응답 때문에 프로젝트 화면 전체를 다시 만들지 않는다.
function jiraStripPaint() {
  const host = document.getElementById('jiraStrip');
  if (!host) return;
  const key = host.dataset.jiraKey || '';
  const body = jiraStripBody(key, host.dataset.project || '');
  host.replaceChildren(...(body ? [body] : []));
}

async function jiraCardLoad(key, { fresh = false, quiet = false } = {}) {
  const seq = jiraCard.seq + 1;
  jiraCard = quiet && jiraCard.key === key
    ? { ...jiraCard, seq }
    : { key, state: 'loading', issue: null, error: '', at: 0, seq };
  jiraStripPaint();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  let next;
  try {
    const response = await fetch(`/api/jira/issue?key=${encodeURIComponent(key)}${fresh ? '&fresh=1' : ''}`, { signal: controller.signal });
    const data = await response.json();
    next = data.ok === false
      ? { key, state: 'error', issue: null, error: data.error || '지라에 연결하지 못했어요.', at: Date.now(), seq }
      : data.connected === false
        ? { key, state: 'off', issue: null, error: '', at: Date.now(), seq }
        : { key, state: 'ok', issue: data.issue, error: '', at: Date.now(), seq };
  } catch {
    next = { key, state: 'error', issue: null, error: '지라에 연결하지 못했어요.', at: Date.now(), seq };
  } finally {
    clearTimeout(timer);
  }
  // 다른 프로젝트로 옮겼거나 더 나중 요청이 이미 나갔으면 이 응답은 버린다.
  if (jiraCard.seq !== seq) return;
  // 뒤에서 조용히 새로 읽다가 실패한 것은 알리지 않는다 — 보고 있던 값이 오류 줄로 바뀌면 안 된다.
  if (quiet && next.state === 'error' && jiraCard.state === 'ok') { jiraCard = { ...jiraCard, at: Date.now() }; return; }
  jiraCard = next;
  jiraStripPaint();
}

// 프로젝트를 열 때만 부른다. 같은 프로젝트를 다시 그리는 것(체크 등)으로는 다시 부르지 않고,
// 60초가 지났으면 뼈대 없이 조용히 새로 읽는다(값이 깜빡이지 않게).
function jiraCardEnsure(key) {
  // 다른 프로젝트로 옮기면 거르기는 푼다(펼침만 기억한다). 2단계의 조용한 재조회(`quiet`)나
  // 쓰기 뒤의 `fresh` 재조회에서는 여기를 지나지 않으므로 펼침·거르기가 그대로 남는다.
  if (jiraCard.key !== key) { jiraConfirmClose(false); jiraChildPick = null; jiraChildDoneOpen = false; jiraStripMoveConfirm = null; jiraCardLoad(key); return; }
  // 확인 줄이 떠 있거나 쓰는 중이면 뒤에서 값을 갈아 끼우지 않는다(무엇을 확인 중인지가 바뀌면 안 된다).
  if (jiraBusy || jiraConfirm || jiraStripMoveConfirm) return;
  if (jiraCard.state === 'ok' && Date.now() - jiraCard.at > JIRA_REFRESH_MS) jiraCardLoad(key, { quiet: true });
}

// 옮기기(BMOVE)가 나가는 단 하나의 길 — 띠 카드 ⋯의 확인 줄에서만 부른다. 데이터가 아직 보이는
// 동안에는(카드가 열려 있어도) 값을 갈아 끼우지 않게 jiraCardEnsure가 이 값이 있는 동안 막아 준다.
async function jiraStripMoveRun(projectKey, jiraKey) {
  if (!jiraStripMoveConfirm || jiraStripMoveConfirm.busy) return;
  jiraStripMoveConfirm = { ...jiraStripMoveConfirm, busy: true };
  jiraStripPaint();
  let result;
  try {
    result = await wfProjectMoveSend(projectKey.slice('group:'.length), jiraKey);
  } catch {
    if (!jiraStripMoveConfirm) return;
    jiraStripMoveConfirm = { ...jiraStripMoveConfirm, busy: false };
    jiraStripPaint();
    return;
  }
  jiraStripMoveConfirm = null;
  await wfProjectMoveFinish(result);
}

// ---------- 직접 만든(그룹) 프로젝트에 지라 티켓 연결 (BJLINK) ----------
// 프로젝트 이름과 항목들은 그대로 두고 **연결 표시만** 붙인다(항목을 `jira:KEY`로 옮겨 쓰지 않는다).
// 지키는 것:
// ① 미리 보기를 거치지 않으면 `연결` 요청이 나가지 않는다 — 보내는 함수는 상태가 `preview`일 때만 돈다.
// ② 저장은 앱의 기존 길(`request` → `POST /api/project/jira-link`) 하나뿐이고, 서버는 저장 전에
//    그 티켓을 지라에서 읽을 수 있는지 한 번 더 확인한다.
// ③ 지라·사람이 준 글자는 전부 textContent로만 넣는다.
// 프로젝트 하나 분량만 기억한다 — 다른 프로젝트로 옮기면 적던 것·미리 보던 것을 버린다.
// `done`은 `완료한 티켓도 보기`로 한 번 받아 둔 목록이다 — null이면 아직 부르지 않은 것이고,
// 한 번 받으면 이 입력칸이 닫힐 때까지 다시 부르지 않는다(입력칸을 닫으면 jiraLinkIdle이 비운다).
let jiraLink = { project: null, state: 'idle', query: '', error: '', issue: null, busy: false, onEsc: null, done: null, doneBusy: false, doneError: '' };
// 새 프로젝트 화면이 이 입력칸을 **그대로 빌려 쓴다**(같은 부품을 두 벌 만들지 않으려고).
// 값이 있으면 고른 티켓을 저장하지 않고 빌린 화면에 넘긴다 — `{ openLabel, label, onPick(issue) }`.
// 프로젝트 탭의 연결 줄에서는 늘 null이라 기존 동작이 하나도 달라지지 않는다.
let jiraLinkPick = null;
function jiraLinkBorrow(pick) { jiraLinkPick = pick; }

const jiraLinkHost = () => document.getElementById('jiraLinkRow');
// 설정 > 상태의 지라 줄에 덧붙는 조용한 한 마디. 앱이 목록을 직접 읽고 있을 때만 나온다 —
// 그렇지 않으면 빈 글자이고, 그 줄은 지금까지처럼 자동화 로그만 말한다(그때가 대비책을 쓰는 때다).
function jiraLiveNote(sync, at = Date.now()) {
  if (!sync || !sync.live || !sync.liveAt) return '';
  const read = new Date(sync.liveAt).getTime();
  if (Number.isNaN(read)) return '';
  const minutes = Math.max(0, Math.round((at - read) / 60000));
  const when = minutes < 1 ? '방금' : minutes < 60 ? `${minutes}분 전` : `${Math.round(minutes / 60)}시간 전`;
  return `목록은 앱이 직접 읽어요 · ${when}`;
}

// 지라 직접 읽기 설정이 있는지와 그 주소 — 목록과 함께 온다(`jiraSync`). 토큰·이메일은 오지 않는다.
const jiraLinkUsable = () => !!(latestData && latestData.jiraSync && latestData.jiraSync.connected);
const jiraLinkSite = () => (latestData && latestData.jiraSync && latestData.jiraSync.siteUrl) || '';
// moveConfirm·moveBusy는 옮기기(BMOVE) 확인 줄 — 미리 보기에서 `이 에픽으로 옮기기`를 눌렀을 때만 쓴다.
const jiraLinkIdle = project => ({ project, state: 'idle', query: '', error: '', issue: null, busy: false, onEsc: null, done: null, doneBusy: false, doneError: '', moveConfirm: false, moveBusy: false });

// 번호(`io-12345`처럼 소문자로 적어도 된다)나 지라 주소 하나에서 키를 뽑는다.
// 주소일 때만 호스트를 견준다 — 다른 지라의 주소는 받지 않는다(엉뚱한 티켓에 걸리지 않게).
const JIRA_LINK_KEY_RE = /[A-Za-z][A-Za-z0-9]*-\d+/;
const jiraLinkHostOf = value => (String(value || '').match(/^https?:\/\/([^/?#]+)/i) || [, ''])[1].toLowerCase();
function jiraKeyFromInput(text, siteUrl) {
  const value = String(text || '').trim();
  if (!value) return { error: '지라 번호나 주소를 적어 주세요.' };
  if (/^https?:\/\//i.test(value)) {
    const site = jiraLinkHostOf(siteUrl);
    if (site && jiraLinkHostOf(value) !== site) return { error: '설정한 지라의 주소가 아니에요.' };
    const found = value.replace(/^https?:\/\/[^/?#]*/i, '').match(JIRA_LINK_KEY_RE);
    if (!found) return { error: '주소에서 지라 번호를 찾지 못했어요.' };
    return { key: found[0].toUpperCase() };
  }
  const key = value.toUpperCase();
  return /^[A-Z][A-Z0-9]*-\d+$/.test(key) ? { key } : { error: '지라 번호를 확인해 주세요.' };
}

// 고르기 쉬우라고 곁들이는 선택지 — 내 담당 지라 목록(스냅샷)에서 최대 여덟 개. `그 밖의 이슈`는 뺀다.
function jiraLinkSuggestions(query) {
  const words = String(query || '').trim().toLocaleLowerCase();
  return (jiraIssuesCache || []).filter(issue => issue && issue.key && !issue.extra)
    .filter(issue => !words || `${issue.summary || ''} ${issue.key}`.toLocaleLowerCase().includes(words))
    .slice(0, 8);
}

// `완료한 티켓도 보기`로 받아 둔 목록에서 고르는 것 — 내 담당 목록과 **같은 입력으로** 거른다.
// 이미 위 목록에 있는 키는 두 번 세우지 않는다.
function jiraLinkDoneSuggestions(query) {
  const words = String(query || '').trim().toLocaleLowerCase();
  const above = new Set(jiraLinkSuggestions(query).map(issue => issue.key));
  return (jiraLink.done || []).filter(issue => issue && issue.key && !above.has(issue.key))
    .filter(issue => !words || `${issue.summary || ''} ${issue.key}`.toLocaleLowerCase().includes(words))
    .slice(0, 8);
}

// 고르는 줄 한 개의 글자(`요약 · 키`, BKEY 결정). 완료한 티켓은 내 담당 목록(jiraIssuesCache)에
// 없을 수 있어서 받은 값으로 바로 짓는다.
const jiraLinkPickText = issue => (issue && issue.summary ? `${issue.summary} · ${issue.key}` : (issue && issue.key) || '');

// 그 버튼을 눌렀을 때만 부른다(최근 90일). 조회라 아무것도 저장하지 않는다.
async function jiraLinkLoadDone(projectKey) {
  if (jiraLink.doneBusy || jiraLink.done) return;
  jiraLink = { ...jiraLink, doneBusy: true, doneError: '' };
  jiraLinkPaint();
  let data = null;
  try {
    const response = await fetch('/api/jira/done?days=90');
    data = await response.json();
  } catch { data = null; }
  if (jiraLink.project !== projectKey) return;
  if (!data || data.ok === false) jiraLink = { ...jiraLink, doneBusy: false, doneError: (data && data.error) || '지라에 연결하지 못했어요.' };
  else if (data.connected === false) jiraLink = { ...jiraLink, doneBusy: false, state: 'off' };
  else jiraLink = { ...jiraLink, doneBusy: false, doneError: '', done: Array.isArray(data.issues) ? data.issues : [] };
  jiraLinkPaint();
  // 눌렀던 버튼은 목록으로 바뀌어 사라진다 — 초점을 적던 입력칸으로 되돌린다.
  jiraLinkFocus();
}

// 같은 티켓이 다른 프로젝트에도 걸려 있으면 막지 않고 조용히 알리기만 한다.
function jiraLinkOtherProject(projectKey, key) {
  const links = jiraProjectLinks();
  return Object.keys(links).find(group => links[group] === key && `group:${group}` !== projectKey) || '';
}

function jiraLinkPaint() {
  const host = jiraLinkHost();
  if (!host) return;
  host.replaceChildren(jiraLinkNode(host.dataset.project || ''));
}
function jiraLinkEnsure(projectKey) {
  if (jiraLink.project === projectKey) return;
  if (jiraLink.onEsc) escDrop(jiraLink.onEsc);
  jiraLink = jiraLinkIdle(projectKey);
}
function jiraLinkReset(repaint = true) {
  if (jiraLink.onEsc) escDrop(jiraLink.onEsc);
  jiraLink = jiraLinkIdle(jiraLink.project);
  if (repaint) jiraLinkPaint();
}
function jiraLinkOpen(projectKey) {
  if (jiraLink.onEsc) escDrop(jiraLink.onEsc);
  jiraLink = { ...jiraLinkIdle(projectKey), state: 'input' };
  // Esc는 이 입력만 닫는다(탭·상세는 건드리지 않는다).
  jiraLink.onEsc = escPush(() => jiraLinkReset());
  jiraLinkPaint();
  jiraLinkFocus();
}
const jiraLinkFocus = () => jiraLinkHost()?.querySelector?.('.d-jlink')?.querySelector?.('.in')?.focus?.();

function jiraLinkNode(projectKey) {
  // 지라 설정이 없거나 토큰을 못 읽으면 걸 것이 없다 — 띠 카드가 쓰는 그 줄을 그대로 세운다.
  if (!jiraLinkUsable() || jiraLink.state === 'off') {
    return jiraQuietLine('지라 연결이 필요해요', '설정 방법', () => showNotice(JIRA_SETUP_HINT), JIRA_SETUP_HINT);
  }
  if (jiraLink.project !== projectKey || jiraLink.state === 'idle') {
    const line = document.createElement('div');
    line.className = 'd-jline';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'd-link d-jlinkgo';
    button.textContent = jiraLinkPick ? jiraLinkPick.openLabel : '지라 티켓 연결';
    button.title = jiraLinkPick ? jiraLinkPick.openLabel : '이 프로젝트에 지라 티켓 하나를 연결해요';
    button.addEventListener('click', () => jiraLinkOpen(projectKey));
    line.appendChild(button);
    return line;
  }
  const box = document.createElement('div');
  box.className = 'd-jlink';
  if (jiraLink.state === 'preview' && jiraLink.issue) jiraLinkPreview(box, projectKey, jiraLink.issue);
  else jiraLinkInput(box, projectKey);
  return box;
}

// 입력 줄: 번호·주소를 적거나(Enter·`찾기`) 아래 조용한 선택지에서 고른다.
function jiraLinkInput(box, projectKey) {
  const row = document.createElement('div');
  row.className = 'row';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'in';
  input.value = jiraLink.query;
  input.placeholder = '지라 번호나 주소 — 예: IO-12345';
  input.setAttribute('aria-label', '연결할 지라 번호나 주소');
  const find = document.createElement('button');
  find.type = 'button';
  find.className = 'd-btn sm';
  find.textContent = '찾기';
  find.addEventListener('click', () => jiraLinkFind(projectKey, input.value));
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'd-btn sm';
  cancel.textContent = '취소';
  cancel.addEventListener('click', () => jiraLinkReset());
  if (jiraLink.busy) { input.disabled = true; find.disabled = true; find.textContent = '찾는 중…'; }
  input.addEventListener('keydown', (event) => {
    // 한글을 조합하는 중의 Enter는 글자를 확정하는 Enter다 — 찾지 않는다.
    if (event.key !== 'Enter' || event.isComposing) return;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    return jiraLinkFind(projectKey, input.value);
  });
  row.append(input, find, cancel);
  box.appendChild(row);
  if (jiraLink.error) {
    const error = document.createElement('div');
    error.className = 'er';
    error.setAttribute('role', 'status');
    error.textContent = jiraLink.error;
    box.appendChild(error);
  }
  const opts = document.createElement('div');
  opts.className = 'opts';
  const fill = () => {
    const rows = [];
    const note = (text) => {
      const label = document.createElement('div');
      label.className = 'note';
      label.textContent = text;
      rows.push(label);
    };
    const option = (text, onClick, quiet) => {
      const pick = document.createElement('button');
      pick.type = 'button';
      pick.className = quiet ? 'pk qt' : 'pk';
      pick.textContent = text;
      pick.addEventListener('click', onClick);
      rows.push(pick);
      return pick;
    };
    const found = jiraLinkSuggestions(input.value);
    if (found.length) {
      note('내 담당 티켓');
      // 고르는 목록이라 `요약 · 키`다(BKEY 결정) — 앱의 이름 규칙 한 곳에서 짓는다.
      found.forEach(issue => option(uiProjectName({ jira: issue.key }, { picker: true }), () => jiraLinkFind(projectKey, issue.key)));
    }
    // 끝난 티켓을 프로젝트 기록으로 걸어 두는 경우가 있어서, 눌렀을 때만 최근 90일 완료분을
    // 한 번 더 읽어 같은 목록 **아래**에 조용한 글자로 덧붙인다.
    if (jiraLink.done) {
      const done = jiraLinkDoneSuggestions(input.value);
      if (done.length) {
        note('완료한 티켓');
        done.forEach(issue => option(jiraLinkPickText(issue), () => jiraLinkFind(projectKey, issue.key), true));
      } else note('완료한 티켓이 없어요');
    } else {
      const more = option(jiraLink.doneBusy ? '불러오는 중…' : '완료한 티켓도 보기', () => jiraLinkLoadDone(projectKey), true);
      more.disabled = jiraLink.doneBusy;
      if (jiraLink.doneError) note(jiraLink.doneError);
    }
    opts.replaceChildren(...rows);
  };
  // 한 글자마다 다시 그리는 것은 이 선택지 목록뿐이다 — 입력칸은 그대로 있어 초점이 튀지 않는다.
  input.addEventListener('input', () => { jiraLink.query = input.value; fill(); });
  fill();
  box.appendChild(opts);
}

// 미리 보기 줄: 무엇을 거는지 먼저 보여 주고, `연결`은 여기에만 있다.
function jiraLinkPreview(box, projectKey, issue) {
  const view = document.createElement('div');
  view.className = 'pv';
  const name = document.createElement('span');
  name.className = 'sm';
  name.textContent = issue.summary || issue.key;
  const rest = document.createElement('span');
  rest.textContent = [issue.status && issue.status.name, `담당 ${issue.assignee || '없음'}`].filter(Boolean).join(' · ');
  const key = document.createElement('span');
  key.className = 'ky';
  key.textContent = issue.key;
  view.append(name, rest, key);
  box.appendChild(view);
  const other = jiraLinkOtherProject(projectKey, issue.key);
  if (other) {
    const note = document.createElement('div');
    note.className = 'note';
    note.textContent = `다른 프로젝트 '${other}'에도 연결돼 있어요`;
    box.appendChild(note);
  }
  // 옮기기(BMOVE)는 빌려 쓰는 화면(새 프로젝트)에는 없다 — 거기서는 아직 만들지 않은 프로젝트라
  // 옮길 대상이 없다. 고른 티켓이 에픽일 때만 `이 에픽으로 옮기기`가 보인다.
  const isEpic = issue.type === '에픽';
  if (!jiraLinkPick && isEpic && jiraLink.moveConfirm) {
    box.appendChild(wfMoveConfirmNode(projectKey.slice('group:'.length), issue.key, {
      busy: jiraLink.moveBusy,
      onCancel: () => { jiraLink = { ...jiraLink, moveConfirm: false }; jiraLinkPaint(); },
      onConfirm: () => jiraLinkMoveRun(projectKey, issue.key),
    }));
    return;
  }
  const acts = document.createElement('div');
  acts.className = 'acts';
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'd-btn sm';
  back.textContent = '취소';
  back.addEventListener('click', () => jiraLinkReset());
  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'd-btn sm acc';
  // 빌려 쓰는 화면(새 프로젝트)에서는 저장하지 않고 고른 티켓만 넘긴다 — 지라에도 앱에도 쓰지 않는다.
  // 옮기기 버튼이 함께 있을 때는 `연결`을 `연결만`으로 불러 옮기기와 헷갈리지 않게 한다.
  go.textContent = jiraLinkPick ? jiraLinkPick.label : (!jiraLinkPick && isEpic ? '연결만' : '연결');
  go.addEventListener('click', () => (jiraLinkPick ? jiraLinkPick.onPick(issue) : jiraLinkConnect(projectKey, issue, go, back)));
  acts.append(back, go);
  if (!jiraLinkPick && isEpic) {
    const move = document.createElement('button');
    move.type = 'button';
    move.className = 'd-btn sm';
    move.textContent = '이 에픽으로 옮기기';
    move.addEventListener('click', () => { jiraLink = { ...jiraLink, moveConfirm: true }; jiraLinkPaint(); });
    acts.appendChild(move);
  }
  box.appendChild(acts);
}

// 옮기기(BMOVE)가 나가는 단 하나의 길 — 미리 보기의 확인 줄에서만 부른다.
async function jiraLinkMoveRun(projectKey, jiraKey) {
  if (jiraLink.moveBusy) return;
  jiraLink = { ...jiraLink, moveBusy: true };
  jiraLinkPaint();
  let result;
  try {
    result = await wfProjectMoveSend(projectKey.slice('group:'.length), jiraKey);
  } catch {
    if (jiraLink.project !== projectKey) return;
    jiraLink = { ...jiraLink, moveBusy: false };
    jiraLinkPaint();
    return;
  }
  jiraLinkReset(false);
  await wfProjectMoveFinish(result);
}

// 티켓을 읽어 미리 보기로 넘어간다. 여기서는 읽기만 한다(아무것도 저장하지 않는다).
async function jiraLinkFind(projectKey, text) {
  if (jiraLink.busy) return;
  const parsed = jiraKeyFromInput(text, jiraLinkSite());
  jiraLink = { ...jiraLink, project: projectKey, state: 'input', query: String(text || ''), error: parsed.error || '', issue: null };
  if (parsed.error) { jiraLinkPaint(); jiraLinkFocus(); return; }
  jiraLink = { ...jiraLink, busy: true };
  jiraLinkPaint();
  let data = null;
  try {
    const response = await fetch(`/api/jira/issue?key=${encodeURIComponent(parsed.key)}`);
    data = await response.json();
  } catch { data = null; }
  // 보는 프로젝트가 그 사이 바뀌었으면 이 응답은 버린다.
  if (jiraLink.project !== projectKey) return;
  if (!data || data.ok === false) jiraLink = { ...jiraLink, busy: false, state: 'input', error: (data && data.error) || '지라에 연결하지 못했어요.' };
  else if (data.connected === false) jiraLink = { ...jiraLink, busy: false, state: 'off' };
  else jiraLink = { ...jiraLink, busy: false, state: 'preview', error: '', issue: data.issue };
  jiraLinkPaint();
  if (jiraLink.state === 'input') jiraLinkFocus();
}

// 연결·해제가 서버로 나가는 단 하나의 길.
async function jiraLinkSend(projectKey, key) {
  await request('/api/project/jira-link', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: projectKey, jira: key }),
  });
  await load();
}
async function jiraLinkConnect(projectKey, issue, go, back) {
  // 미리 보기를 거치지 않으면 여기까지 올 수 없다(버튼이 그 줄에만 있다) — 한 번 더 막아 둔다.
  if (jiraLink.state !== 'preview' || !jiraLink.issue || jiraLink.busy) return;
  jiraLink = { ...jiraLink, busy: true };
  go.disabled = true; back.disabled = true; go.textContent = '연결하는 중…';
  try {
    await jiraLinkSend(projectKey, issue.key);
  } catch {
    // 실패 문구는 request()가 이미 알렸다 — 미리 보기는 그대로 두고 다시 누를 수 있게 한다.
    jiraLink = { ...jiraLink, busy: false };
    go.disabled = false; back.disabled = false; go.textContent = '연결';
    return;
  }
  jiraLinkReset(false);
  showNotice('지라 티켓을 연결했어요');
}
// 해제는 업무·기록에 영향이 없고 되돌리기는 다시 연결이라 확인 없이 바로 한다.
// 앱의 ⌘Z 대상은 아니다 — 되돌리는 길은 알림의 `되돌리기` 하나뿐이다.
async function jiraLinkRemove(projectKey, key) {
  try { await jiraLinkSend(projectKey, null); } catch { return; }
  showNotice('지라 연결을 해제했어요', false, null, {
    label: '되돌리기',
    onClick: async (button) => {
      if (button) button.disabled = true;
      try { await jiraLinkSend(projectKey, key); } catch { return; }
      showNotice('지라 티켓을 다시 연결했어요');
    },
  });
}

// ---------- 배포 임박 (리마인드 카드 · 왼쪽 프로젝트 목록) ----------
// 프로젝트에 걸린 지라 티켓의 **아직 배포되지 않은** 버전 가운데 배포일이 가장 이른 하나를 고른다.
// 이 값(`versions`)은 앱이 지라를 직접 읽을 때만 실려 온다 — 스냅샷 파일로 물러서 있거나 옛 서버면
// 칸 자체가 없고, 그때는 여기부터 null이 되어 아래 세 화면이 **조용히 아무것도 그리지 않는다**.
function deploySoonVersion(issue) {
  if (!issue || !Array.isArray(issue.versions)) return null;
  const open = issue.versions.filter(version => version && !version.released && version.releaseDate);
  if (!open.length) return null;
  return open.slice().sort((a, b) => String(a.releaseDate).localeCompare(String(b.releaseDate)))[0];
}

// 배포일 색은 지라 띠 카드의 `배포 버전` 칸과 같은 규칙이다(배지가 아니라 글자색):
// 3일 안이면 주의색, 지났는데 아직 배포되지 않았으면 급함 색.
function deployTone(left) {
  return left < 0 ? 'urgent' : left <= 3 ? 'warn' : '';
}

// 배포일 말투는 여기 한 곳에서만 만든다: `배포 3일 전` · `오늘 배포` · `내일 배포` · `배포일 2일 지남`.
function deployDayText(releaseDate) {
  const left = diffDays(releaseDate);
  if (Number.isNaN(left)) return null;
  if (left < 0) return { text: `배포일 ${-left}일 지남`, tone: deployTone(left), left };
  if (left === 0) return { text: '오늘 배포', tone: deployTone(left), left };
  if (left === 1) return { text: '내일 배포', tone: deployTone(left), left };
  return { text: `배포 ${left}일 전`, tone: deployTone(left), left };
}

// 이 프로젝트의 배포 상황 한 덩어리. 지라 키는 `jiraKeyOf` 하나에서만 얻는다 —
// 지라 프로젝트는 키 그 자체, 직접 만든(그룹) 프로젝트는 손으로 걸어 둔 연결이다.
function projectDeploy(key) {
  const jira = jiraKeyOf(key);
  if (!jira) return null;
  const version = deploySoonVersion(jiraIssuesByKey.get(jira));
  if (!version) return null;
  const day = deployDayText(version.releaseDate);
  if (!day) return null;
  return { name: version.name, date: version.releaseDate, left: day.left, tone: day.tone, text: day.text };
}

// 왼쪽 프로젝트 목록에 조용히 적는 배포일 — 14일 안일 때만 적는다(먼 날짜는 목록을 시끄럽게 한다).
function projectDeployNote(key) {
  const deploy = projectDeploy(key);
  if (!deploy || deploy.left > 14) return null;
  return {
    text: uiDateSlash(deploy.date),
    tone: deploy.tone,
    title: `${deploy.name} · ${uiKoDateShort(deploy.date)} 배포 예정`,
  };
}

// 리마인드 카드에 설 배포 임박 줄. 대상은 **열린 항목이 있는** 프로젝트 중, 가장 이른 미배포 버전의
// 배포일이 오늘 기준 3일 안(지났는데 미배포인 것 포함)인 것이다. 급한 순(지남 → 오늘 → …)으로 세운다.
function deployReminders(rows) {
  const picked = (rows || []).filter(row => row && row.open).map((row) => {
    const deploy = projectDeploy(row.key);
    return deploy && deploy.left <= 3 ? { ...deploy, key: row.key, open: row.open } : null;
  }).filter(Boolean);
  const labels = uiGroupLabels(picked.map(entry => entry.key));
  return picked
    .map(entry => ({ ...entry, label: labels.get(entry.key) }))
    .sort((a, b) => a.left - b.left || a.label.localeCompare(b.label));
}

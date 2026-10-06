// 프로젝트 탭 한 벌 — 왼쪽 목록(열린 항목 수·지난 프로젝트)과 오른쪽 프로젝트 하나의 상세.
// app.js에서 그대로 옮긴 코드다. app.js의 공용 부품(uiTaskRow·uiGroupHeading·uiMenu·request·
// showNotice·pushUndo·load·panelOpen·workflowData)과 jira-ui.js(지라 띠 카드·배포 임박)에 기댄다.
// index.html에서 jira-ui.js 뒤, app.js보다 먼저 읽힌다.

// ---------- 프로젝트 탭 ----------
// 왼쪽은 프로젝트 목록, 오른쪽은 고른 프로젝트 하나. 상세는 오늘 탭과 같이 누른 줄 옆 카드로 뜬다.

// 목록에 적는 `열린 항목`은 한 규칙이다: 열린 업무(오늘+나중) + 열린 확인 대기.
// 결정·아이디어·회의는 "해야 할 일"이 아니라서 세지 않는다.
const uiProjectOpenItem = item => ['task', 'bug', 'check'].includes(item.type) && item.status !== 'done';

// 많은 순 → 같은 수면 이름 순. 0건 프로젝트는 자연히 맨 아래로 내려가고 목록에서 흐리게 그린다.
function uiProjectRows(entries, items) {
  const open = new Map();
  items.forEach((item) => {
    if (!uiProjectOpenItem(item)) return;
    const key = wfKey(item);
    if (key) open.set(key, (open.get(key) || 0) + 1);
  });
  return entries
    .map(([key, label]) => ({ key, label, open: open.get(key) || 0 }))
    .sort((a, b) => b.open - a.open || a.label.localeCompare(b.label));
}

// ---------- 프로젝트 묶어 보기 (BBUNDLE) ----------
// 한 가지 일이 지라 티켓 둘 이상으로 나뉜 것을 한 덩어리로 본다. 서버는 `.workflow.json`의
// 표시 정보(`projectBundles: [{ id, lead, keys }]`)만 준다 — 항목의 jira 칸은 그대로다.
// 프로젝트 탭(덩어리 1)에 더해 오늘 탭·나중에 할 일·확인 대기·회의 탭 프로젝트별 보기·고르기 목록이
// projectGroupKey로 한 그룹이 된다(덩어리 2). 배포 리마인드는 티켓별 그대로이고, 주간요약은 묶음이 생긴 주부터 한 소제목이다(report-drafts.js dress).
// 이 조회 함수들은 여러 화면이 쓴다 — index.html에서 app.js보다 먼저 읽히는 이 파일에 둔다.
// 묶음 줄의 키는 대표 티켓의 키(`lead`)이고, 이름·색도 대표 티켓 것이다(uiGroupLabel·uiProjectDot).
function projectBundles() {
  const list = (typeof workflowData === 'object' && workflowData && workflowData.projectBundles) || [];
  return Array.isArray(list) ? list.filter(bundle => bundle && Array.isArray(bundle.keys) && bundle.keys.length > 1 && bundle.keys.includes(bundle.lead)) : [];
}
// 이 키가 든 묶음(없으면 null) — 대표든 나머지든 같다.
const projectBundleOf = key => projectBundles().find(bundle => bundle.keys.includes(key)) || null;
// 줄 하나가 품은 프로젝트 키들 — 묶음이면 묶음의 키 전부, 아니면 자기 하나.
const projectRowKeys = row => (row && row.bundle ? row.bundle.keys : [row.key]);
// 묶음 줄의 차례·보이는 이름 비교는 uiProjectRows와 같은 규칙이다(많은 순 → 이름 순).
const projectRowOrder = (a, b) => b.open - a.open || a.label.localeCompare(b.label);

// 목록 줄을 묶음대로 합친다 — 묶음에 든 키가 목록에 하나라도 있으면 대표 키로 한 줄이 서고, 열린 항목은 더한다.
// 목록에 하나도 없으면(두 티켓 다 사라짐) 묶음 줄도 서지 않는다(단일 프로젝트가 사라지는 것과 같다).
function projectBundleRows(rows) {
  const bundles = projectBundles();
  if (!bundles.length) return rows;
  const byKey = new Map(rows.map(row => [row.key, row]));
  const out = [];
  const done = new Set();
  rows.forEach((row) => {
    const bundle = bundles.find(entry => entry.keys.includes(row.key));
    if (!bundle) { out.push(row); return; }
    if (done.has(bundle.id)) return;
    done.add(bundle.id);
    const present = bundle.keys.filter(key => byKey.has(key));
    const lead = byKey.get(bundle.lead);
    out.push({
      key: bundle.lead,
      label: lead ? lead.label : uiGroupLabel(bundle.lead, { withKey: true }),
      open: present.reduce((sum, key) => sum + byKey.get(key).open, 0),
      bundle,
    });
  });
  return out.sort(projectRowOrder);
}

// 묶음을 풀거나 대표를 바꾸면 보던 키가 목록에서 사라질 수 있다 — 그 키가 든 묶음의 대표로 옮겨 본다.
const projectBundleLeadOf = key => (projectBundleOf(key) || { lead: key }).lead;
// 여러 화면이 한 그룹으로 모을 때 쓰는 열쇠 — 묶음에 든 지라 키면 대표 키, 아니면 그대로(`__misc__`·null 포함).
const projectGroupKey = key => (typeof key === 'string' && key.startsWith('jira:') ? projectBundleLeadOf(key) : key);

const PROJECT_KEY_STORE = 'projectKey';
let projectKey = null;
let projectDoneOpen = false;
// 프로젝트 카드의 읽는 그룹(확인 대기·결정·회의·아이디어) 중 펼친 것 — `프로젝트키::그룹`.
// 화면 메모리에만 둔다(localStorage 아님): 새로고침·재시작하면 모두 접힌 채로 시작한다.
const projectFolds = new Set();
// 왼쪽 목록의 차례를 탭에 있는 동안 고정해 둔다 — 체크 한 번마다 load()가 다시 그리며 순서가
// 뒤바뀌지 않게. 탭에 들어올 때·새로고침 때만(projectOrderResort) 다시 계산한다. 세션 동안만
// 기억하는 값이라 localStorage에 넣지 않는다(projectPastOpen도 같다).
let projectOrderKeys = null;
let projectOrderResort = true;
// `지난 프로젝트` 접힘 — null이면 손대기 전(보고 있는 프로젝트가 거기 있으면 펼쳐 보인다), true/false는 사람이 누른 값.
let projectPastOpen = null;
function projectKeyRestore() {
  try { projectKey = localStorage.getItem(PROJECT_KEY_STORE) || null; } catch { projectKey = null; }
}

// ---------- BPVIEW: 왼쪽 목록을 지라 상태로 묶기 · 배포별 보기 · 프로젝트 찾기 ----------
// 사람이 관리하는 보관·폴더·태그 대신, 앱이 이미 아는 값(지라 상태·배포 버전)으로 자동으로 묶는다.
// 서버 변경 없음 — 상태(category)·버전(versions)은 jiraIssuesCache에 이미 있다(DECISIONS 2026-09-23).
const PROJECT_LIST_VIEW_KEY = 'projectListView';
let projectListView = 'status';
try { projectListView = localStorage.getItem(PROJECT_LIST_VIEW_KEY) === 'deploy' ? 'deploy' : 'status'; } catch {}
function setProjectListView(value) {
  const next = value === 'deploy' ? 'deploy' : 'status';
  if (projectListView === next) return;
  projectListView = next;
  try { localStorage.setItem(PROJECT_LIST_VIEW_KEY, projectListView); } catch {}
  renderProjects();
}

// 찾기 칸의 값 — 저장하지 않는다(탭을 떠나면 setActiveTab이 비운다).
let projectFindQuery = '';
const PROJECT_FIND_MIN = 8; // 전체 프로젝트(지난 프로젝트 포함)가 이보다 적으면 찾기 칸 자체가 없다.
// `시작 전` 접힘 — null이면 아직 손대지 않은 것(보고 있는 프로젝트가 거기 있으면 펼쳐 보인다), true/false는 사람이 누른 값.
// 예전에는 보고 있는 프로젝트가 `시작 전`에 있으면 `숨기기`를 눌러도 다시 펼쳐져 버튼이 안 먹는 것처럼 보였다.
let projectTodoOpen = null;
const projectDeployClosed = new Set(); // 배포별 보기에서 접어 둔 버전 키 — 기본은 전부 펼침.

// 판정 함수 — quiet(지난 프로젝트)가 가장 먼저다. 그다음은 지라 상태(category)·열린 업무로
// 진행 중/시작 전을 가른다. 지라가 없는 그룹은(quiet가 아니라면) 항상 진행 중이다.
function projectStatusOf(row, quiet) {
  if (quiet) return 'past';
  // 묶음(BBUNDLE): 하나라도 진행 중(또는 열린 항목)이면 진행 중, 아는 티켓이 전부 시작 전일 때만 시작 전.
  // 내 담당 목록에서 빠진 티켓(상태를 모름)은 판정에서 뺀다 — 하나도 모르면 단일 프로젝트처럼 진행 중.
  if (row.bundle) {
    if (row.open > 0) return 'doing';
    const categories = row.bundle.keys.map(key => jiraIssuesByKey.get(jiraKeyOf(key))?.category).filter(Boolean);
    return categories.length && categories.every(category => category === 'todo') ? 'todo' : 'doing';
  }
  const jira = jiraKeyOf(row.key);
  if (!jira) return 'doing';
  const category = jiraIssuesByKey.get(jira)?.category;
  if (category === 'doing' || row.open > 0) return 'doing';
  if (category === 'todo') return 'todo';
  return 'doing';
}

// 활성 목록(이미 quiet은 빠졌다)을 진행 중/시작 전으로 가른다 — 차례는 그대로(정렬은 위에서 끝났다).
function projectStatusGroups(visibleRows) {
  const doing = [];
  const todo = [];
  visibleRows.forEach(row => (projectStatusOf(row, false) === 'todo' ? todo : doing).push(row));
  return { doing, todo };
}

// 이 프로젝트의 미배포 버전 중 배포일이 가장 이른 것(배포일 없는 버전은 뒤). 없으면 null(`배포 미정`).
function projectDeployVersion(key) {
  const jira = jiraKeyOf(key);
  const issue = jira ? jiraIssuesByKey.get(jira) : null;
  const list = issue && Array.isArray(issue.versions) ? issue.versions.filter(v => v && !v.released) : [];
  if (!list.length) return null;
  return list.slice().sort((a, b) => {
    const ad = a.releaseDate || ''; const bd = b.releaseDate || '';
    if (ad && bd) return ad.localeCompare(bd);
    return ad ? -1 : bd ? 1 : 0;
  })[0];
}

// 활성 목록을 배포 버전으로 묶는다 — 배포일 이른 순 → 배포일 없는 버전 → `배포 미정`(name: null) 마지막.
// 같은 버전 이름을 쓰는 프로젝트는 한 덩어리로 합친다.
// 묶음 줄은 묶인 티켓들의 버전 가운데 가장 이른 것(projectDeployVersion과 같은 정렬 규칙)으로 선다.
function projectRowDeployVersion(row) {
  const list = projectRowKeys(row).map(key => projectDeployVersion(key)).filter(Boolean);
  if (list.length < 2) return list[0] || null;
  return list.sort((a, b) => {
    const ad = a.releaseDate || ''; const bd = b.releaseDate || '';
    if (ad && bd) return ad.localeCompare(bd);
    return ad ? -1 : bd ? 1 : 0;
  })[0];
}

function projectDeployGroups(visibleRows) {
  const buckets = new Map();
  const none = [];
  visibleRows.forEach((row) => {
    const version = projectRowDeployVersion(row);
    if (!version) { none.push(row); return; }
    if (!buckets.has(version.name)) buckets.set(version.name, { name: version.name, releaseDate: version.releaseDate || null, rows: [] });
    buckets.get(version.name).rows.push(row);
  });
  const groups = [...buckets.values()].sort((a, b) => {
    if (a.releaseDate && b.releaseDate) return a.releaseDate.localeCompare(b.releaseDate);
    if (a.releaseDate) return -1;
    if (b.releaseDate) return 1;
    return a.name.localeCompare(b.name);
  });
  if (none.length) groups.push({ name: null, releaseDate: null, rows: none });
  return groups;
}

// 배포일 색 — 3일 안이면 주의, 지났으면 급함(jiraVersionText·deployDayText와 같은 문턱, 재사용).
function projectDeployTone(releaseDate) {
  if (!releaseDate) return '';
  const left = diffDays(releaseDate);
  if (Number.isNaN(left)) return '';
  return left < 0 ? 'urgent' : left <= 3 ? 'warn' : '';
}

// 이름(요약·그룹)·키로 거른다 — 팔레트의 wfSearchMatches와 같은 규칙(NFKC·대소문자 무시·모든 낱말 포함).
// 별칭이 있으면 uiGroupLabel이 별칭을 돌려주므로, 지라 원래 요약도 haystack에 함께 넣어 그 글자로도 찾힌다(BJALIAS).
function projectFindFilter(rows, query) {
  const needle = query.trim();
  if (!needle) return rows;
  // 묶음 줄은 묶인 티켓 전부의 이름·키로도 찾힌다.
  return rows.filter(row => wfSearchMatches(needle, projectRowKeys(row).flatMap((key) => {
    const jira = jiraKeyOf(key);
    const raw = jira ? (jiraIssuesByKey.get(jira)?.summary || '') : '';
    return [uiGroupLabel(key, { withKey: true }), raw];
  })));
}

// 오늘 목록의 그룹 제목·업무 상세의 `프로젝트 보기`가 부르는 길.
function openProjectTab(key, { keepNew = false } = {}) {
  // 새 프로젝트 화면(결과 포함)은 다른 프로젝트를 열면 닫힌다 — 새 프로젝트 화면 자신이 부를 때만 둔다.
  if (!keepNew) projectNewLeave();
  projectKey = key;
  try { localStorage.setItem(PROJECT_KEY_STORE, key); } catch {}
  // 이 패널은 오늘 탭 자리에 있다 — 프로젝트 탭으로 옮겨 가기 전에 닫는다(팔레트로 되돌아가지 않게).
  if (panelState) { panelState.back = null; panelClose(); }
  tabStale.projects = true;
  setActiveTab('projects');
  document.getElementById('projectList')?.querySelector('[aria-current="true"]')?.focus();
}

// 왼쪽 목록의 차례를 고정해 둘 때 쓰는 순수 함수 — 알고 있던 차례(orderKeys)를 그대로 따르고,
// 처음 보는 키는 지금 정렬 결과(rows)의 상대 순서 그대로 끝에 붙는다. orderKeys가 없으면 그대로 돌려준다.
function projectFixedOrder(rows, orderKeys) {
  if (!orderKeys) return rows;
  const known = new Map(rows.map(row => [row.key, row]));
  const ordered = orderKeys.filter(key => known.has(key)).map(key => known.get(key));
  const extra = rows.filter(row => !orderKeys.includes(row.key));
  return [...ordered, ...extra];
}

// ---------- 지난 프로젝트 ----------
// 끝난 프로젝트가 왼쪽 목록에 계속 쌓였다. 열린 항목이 없고 한참 조용한 것을 목록 끝의 접힌
// 구역으로 자동으로 내린다(매번 다시 계산, 저장하지 않는다). 업무가 하나라도 생기면 자동으로
// 다시 위 목록으로 올라온다 — 사람이 손으로 접거나 영구히 숨기는 길은 없다.
// **바뀌는 것은 왼쪽 목록 배치와 고르기 목록 소제목뿐이다** — 업무·기록·주간요약·검색·슬랙 복사는
// 하나도 달라지지 않는다.
const PROJECT_QUIET_DAYS = 14;

// 프로젝트의 마지막 활동 날짜 — **있는 값만** 본다(없는 날짜를 지어내지 않는다).
// 그 프로젝트 항목들의 완료·수정·등록 날짜와, 그 프로젝트에 걸린 회의 날짜 중 가장 최근이다.
// 묶음 줄의 마지막 활동은 묶인 티켓들 가운데 가장 최근이다 — 모두 조용해야 지난 프로젝트가 된다.
function projectRowLastDay(row, items, meetings) {
  return projectRowKeys(row).map(key => projectLastDay(key, items, meetings)).filter(Boolean).sort().pop() || null;
}

function projectLastDay(key, items, meetings) {
  let last = '';
  const seen = (value) => {
    const day = String(value || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day > last) last = day;
  };
  (items || []).forEach((item) => {
    if (wfKey(item) !== key) return;
    seen(item.completed); seen(item.updated); seen(item.created);
  });
  (meetings || []).forEach((event) => { if (wfMeetingKey(event) === key) seen(event.date); });
  return last || null;
}

// 조용함 = 열린 항목(미완료 업무 + 미완료 확인 대기)이 0이고, 마지막 활동이 14일 넘게 없음.
// 날짜를 하나도 모르면 조용한 것으로 본다(열린 항목이 0이므로).
function projectQuiet(row, lastDay, today) {
  if (!row || row.open) return false;
  if (!lastDay) return true;
  return Math.round((new Date(`${today}T00:00:00`) - new Date(`${lastDay}T00:00:00`)) / 86400000) > PROJECT_QUIET_DAYS;
}

// 왼쪽 목록을 둘로 가르는 순수 함수 — 위 목록과 끝의 `지난 프로젝트`.
// 지금 보고 있는 프로젝트(selectedKey)는 구역이 바뀌어도 보는 동안 위 목록에 남는다
// (0개가 되어도 갑자기 사라지지 않던 기존 규칙 그대로다).
function projectPastRows(rows, { quietKeys, selectedKey } = {}) {
  const quiet = quietKeys || new Set();
  const active = [];
  const past = [];
  rows.forEach((row) => {
    const down = quiet.has(row.key) && row.key !== selectedKey;
    (down ? past : active).push(row);
  });
  return { active, past };
}

// 머리(`프로젝트 N +`) — 위 목록과 `지난 프로젝트` 소제목이 같은 줄 부품을 쓰듯, 여기도 한 곳에서만 짓는다.
function projectListHead(count) {
  const head = document.createElement('div');
  head.className = 'd-rhd';
  const headName = document.createElement('span');
  headName.textContent = '프로젝트';
  const headCount = document.createElement('span');
  headCount.className = 'n num';
  headCount.textContent = count;
  // 개수 옆의 조용한 `+` — 새 프로젝트 화면을 오른쪽에 연다(project-new-ui.js).
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'd-pnewgo';
  add.textContent = '+';
  add.title = '새 프로젝트';
  add.setAttribute('aria-label', '새 프로젝트');
  add.addEventListener('click', () => projectNewStart());
  head.append(headName, headCount, add);
  return head;
}

// 보기 전환 `상태별 | 배포별` — 회의 탭 `날짜순 | 프로젝트별`과 같은 부품(wfSegment 대신 같은 모양을
// 직접 그린다 — 보기 전환이라 aria-pressed다, meetingsViewSegment와 같은 방식).
function projectViewSegment() {
  const seg = document.createElement('div');
  seg.className = 'd-seg d-pfseg';
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', '프로젝트 목록 보기');
  [['status', '상태별'], ['deploy', '배포별']].forEach(([value, text]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.setAttribute('aria-pressed', String(projectListView === value));
    button.addEventListener('click', () => setProjectListView(value));
    seg.appendChild(button);
  });
  return seg;
}

// 프로젝트 찾기 칸 — 8개 이상일 때만 선다. 입력할 때마다 목록 부분만 다시 그린다(rowsOnly) — 이
// 칸 자체는 다시 만들지 않는다(한글 조합 중에 칸이 통째로 바뀌면 조합이 끊긴다. project-new-ui.js의
// `이름` 칸과 같은 방식 — 손대는 칸 밖에서 결과만 다시 그린다). Esc는 비우기만, 초점은 칸에 남는다.
function projectFindInput() {
  const input = document.createElement('input');
  input.type = 'text';
  input.id = 'projectFind';
  input.className = 'd-din d-pfind';
  input.placeholder = '프로젝트 찾기';
  input.setAttribute('aria-label', '프로젝트 찾기');
  input.value = projectFindQuery;
  input.addEventListener('input', () => {
    projectFindQuery = input.value;
    renderProjects({ rowsOnly: true });
  });
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.isComposing || !projectFindQuery) return;
    event.preventDefault();
    projectFindQuery = '';
    input.value = '';
    renderProjects({ rowsOnly: true });
  });
  return input;
}

// 위 목록과 `시작 전`·`지난 프로젝트` 구역이 같은 줄 부품을 쓴다 — 지난 것만 흐리게 그린다.
function projectRowButton(row, past, labels) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'd-prow' + (row.open ? '' : ' is-zero') + (past ? ' is-past' : '');
  button.setAttribute('aria-current', String(row.key === projectKey));
  const displayLabel = labels.get(row.key);
  const name = document.createElement('span');
  name.className = 'nm';
  name.textContent = displayLabel;
  // 눈에 보이는 자리는 요약만, title 툴팁에는 지라 키를 남긴다(BKEY 결정).
  name.title = uiGroupLabel(row.key, { withKey: true });
  const count = document.createElement('span');
  count.className = 'n num';
  count.textContent = row.open;
  // 오른쪽 끝 묶음: (배포가 2주 안이면) 조용한 배포일 + 열린 항목 수.
  // 배포일은 고정 폭이라 이름 칸이 먼저 줄어든다 — 이름이 배포일에 밀려 잘리지 않는다.
  const right = document.createElement('span');
  right.className = 'rt';
  // 묶음 줄은 오른쪽 끝 묶음 맨 앞에 조용한 `티켓 N개` — 두 줄이 한 줄로 합쳐졌다는 것을 숨기지 않는다.
  if (row.bundle) {
    const tickets = document.createElement('span');
    tickets.className = 'bd';
    tickets.textContent = `티켓 ${row.bundle.keys.length}개`;
    tickets.title = row.bundle.keys.map(key => uiGroupLabel(key, { withKey: true })).join('\n');
    right.appendChild(tickets);
  }
  const deploy = projectRowDeployNote(row);
  if (deploy) {
    const day = document.createElement('span');
    day.className = `dp${uiTone(deploy.tone)}`;
    day.textContent = deploy.text;
    day.title = deploy.title;
    right.appendChild(day);
    // `9/30`만으로는 무슨 날인지 읽히지 않는다 — 이 줄에만 이름표를 붙여 풀어 준다.
    button.setAttribute('aria-label', `${displayLabel}, 열린 항목 ${row.open}, ${deploy.title}`);
  }
  right.appendChild(count);
  if (row.bundle) {
    const tail = deploy ? `, ${deploy.title}` : '';
    button.setAttribute('aria-label', `${displayLabel}, 티켓 ${row.bundle.keys.length}개 묶음, 열린 항목 ${row.open}${tail}`);
  }
  // 오늘 목록의 그룹 제목과 같은 색 점 — 같은 프로젝트는 어디서나 같은 색이다.
  button.append(uiProjectDot(row.key), name, right);
  button.addEventListener('click', () => {
    const hadNew = !!projectNew;
    if (!projectNewLeave()) { showNotice('지라에 만드는 중이에요. 끝나면 옮길 수 있어요'); return; }
    if (projectKey === row.key && !hadNew) return;
    projectKey = row.key;
    try { localStorage.setItem(PROJECT_KEY_STORE, row.key); } catch {}
    renderProjects();
  });
  return button;
}

// 목록 줄의 조용한 배포일 — 묶음이면 묶인 티켓 가운데 가장 가까운 배포(projectDeployNote의 14일 규칙 그대로).
function projectRowDeployNote(row) {
  if (!row.bundle) return projectDeployNote(row.key);
  const soonest = row.bundle.keys
    .map(key => ({ key, deploy: projectDeploy(key) }))
    .filter(entry => entry.deploy && entry.deploy.left <= 14)
    .sort((a, b) => a.deploy.left - b.deploy.left)[0];
  return soonest ? projectDeployNote(soonest.key) : null;
}

// 접히는 소제목 — `시작 전`·`지난 프로젝트`가 같은 부품을 쓴다(닫히면 `라벨 N`, 열리면 `라벨 숨기기`).
// 찾는 동안(locked)은 접힘을 무시하고 전부 펼쳐 두므로 `숨기기`가 거짓말이 된다 — 그때는 맞는 개수만
// 적은 소제목 글자로 서고 누를 수 없다.
function projectToggleButton(label, count, open, onToggle, { locked = false } = {}) {
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'd-plink';
  toggle.setAttribute('aria-expanded', String(open));
  toggle.textContent = open && !locked ? `${label} 숨기기` : `${label} ${count}`;
  if (locked) toggle.disabled = true;
  else toggle.addEventListener('click', onToggle);
  return toggle;
}

// 배포별 보기의 소제목 — 앱 공용 접이식 그룹 제목(uiGroupHeading)을 쓰고, 배포일이 있으면 그 부분만
// 색 글자로 바꿔 끼운다(배지가 아니라 글자 — jiraVersionText·띠 카드와 같은 규칙, projectDeployTone 재사용).
// uiGroupHeading과 같은 모양(같은 클래스·같은 접이식 동작)이지만, `이름 · 날짜 배포  개수` 순서로
// 이름과 개수 사이에 색 글자(날짜)를 끼워야 해서 직접 짓는다 — uiGroupHeading은 이름 하나만 받는다.
function projectDeployHeading(bucket, count, open, onToggle) {
  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'd-grp tog';
  head.setAttribute('aria-expanded', String(open));
  head.innerHTML = uiIcon('chevron');
  head.addEventListener('click', onToggle);
  const name = document.createElement('span');
  name.className = 'gl';
  name.textContent = bucket.name || '배포 미정';
  head.appendChild(name);
  if (bucket.releaseDate) {
    const tone = projectDeployTone(bucket.releaseDate);
    const date = document.createElement('span');
    date.className = 'd-pdepdate' + uiTone(tone);
    date.textContent = `· ${uiKoDateShort(bucket.releaseDate)} 배포`;
    head.appendChild(date);
    const title = `${bucket.name} · ${uiKoDate(bucket.releaseDate)} 배포 예정`;
    name.title = title;
    head.title = title;
  } else {
    name.title = name.textContent;
  }
  if (count) {
    const number = document.createElement('span');
    number.className = 'n num';
    number.textContent = count;
    head.appendChild(number);
  }
  return head;
}

function projectFindEmpty() {
  const empty = document.createElement('div');
  empty.className = 'd-empty';
  empty.textContent = '맞는 프로젝트가 없어요.';
  return empty;
}

// 상태별 보기의 본문 — `진행 중`은 소제목 없이 맨 위(늘 펼침), `시작 전`이 있을 때만 그 소제목이 선다.
// 찾는 동안은 접힘을 무시하고 전부 펼치고, 맞는 게 없는 덩어리는 소제목도 그리지 않는다.
function projectListPaintStatusTail(listEl, { doingRows, todoRows, pastRows, labels, query, filtering }) {
  const doingF = filtering ? projectFindFilter(doingRows, query) : doingRows;
  const todoF = filtering ? projectFindFilter(todoRows, query) : todoRows;
  const pastF = filtering ? projectFindFilter(pastRows, query) : pastRows;
  if (filtering && !doingF.length && !todoF.length && !pastF.length) { listEl.appendChild(projectFindEmpty()); return; }
  doingF.forEach(row => listEl.appendChild(projectRowButton(row, false, labels)));
  if (todoRows.length && (!filtering || todoF.length)) {
    // 지금 보는 프로젝트가 `시작 전`에 있으면 그 덩어리를 자동으로 펼친 채로 그린다.
    const open = filtering || (projectTodoOpen === null ? todoRows.some(row => row.key === projectKey) : projectTodoOpen);
    listEl.appendChild(projectToggleButton('시작 전', filtering ? todoF.length : todoRows.length, open, () => { projectTodoOpen = !open; renderProjects(); }, { locked: filtering }));
    if (open) (filtering ? todoF : todoRows).forEach(row => listEl.appendChild(projectRowButton(row, false, labels)));
  }
  if (pastRows.length && (!filtering || pastF.length)) {
    const open = filtering || (projectPastOpen === null ? pastRows.some(row => row.key === projectKey) : projectPastOpen);
    listEl.appendChild(projectToggleButton('지난 프로젝트', filtering ? pastF.length : pastRows.length, open, () => { projectPastOpen = !open; renderProjects(); }, { locked: filtering }));
    if (open) (filtering ? pastF : pastRows).forEach(row => listEl.appendChild(projectRowButton(row, true, labels)));
  }
}

// 배포별 보기의 본문 — 버전마다 소제목(기본 펼침, 접을 수 있다) + `지난 프로젝트`(두 보기에서 같다).
function projectListPaintDeployTail(listEl, { visibleRows, pastRows, labels, query, filtering }) {
  const groups = projectDeployGroups(visibleRows);
  const groupsF = filtering
    ? groups.map(bucket => ({ ...bucket, rows: projectFindFilter(bucket.rows, query) })).filter(bucket => bucket.rows.length)
    : groups;
  const pastF = filtering ? projectFindFilter(pastRows, query) : pastRows;
  if (filtering && !groupsF.length && !pastF.length) { listEl.appendChild(projectFindEmpty()); return; }
  groupsF.forEach((bucket) => {
    const key = bucket.name || '__none__';
    const open = filtering || !projectDeployClosed.has(key);
    listEl.appendChild(projectDeployHeading(bucket, bucket.rows.length, open, () => {
      if (projectDeployClosed.has(key)) projectDeployClosed.delete(key); else projectDeployClosed.add(key);
      renderProjects();
    }));
    if (open) bucket.rows.forEach(row => listEl.appendChild(projectRowButton(row, false, labels)));
  });
  if (pastRows.length && (!filtering || pastF.length)) {
    const open = filtering || (projectPastOpen === null ? pastRows.some(row => row.key === projectKey) : projectPastOpen);
    listEl.appendChild(projectToggleButton('지난 프로젝트', filtering ? pastF.length : pastRows.length, open, () => { projectPastOpen = !open; renderProjects(); }, { locked: filtering }));
    if (open) (filtering ? pastF : pastRows).forEach(row => listEl.appendChild(projectRowButton(row, true, labels)));
  }
}

// opts.rowsOnly — 찾기 칸에서 글자를 칠 때만 쓰는 가벼운 다시 그리기다. 머리·세그먼트·찾기 칸은
// 그대로 두고(칸 자체를 다시 만들면 한글 조합이 끊긴다) 그 뒤에 이어 붙은 소제목·줄만 지우고 다시 쌓는다.
function renderProjects(opts = {}) {
  const listEl = document.getElementById('projectList');
  const body = document.getElementById('projectBody');
  if (!listEl || !body) return;
  // 묶음(BBUNDLE)은 이 탭에서만 한 줄로 합친다 — uiProjectRows는 리마인드도 쓰므로 그대로 두고 여기서 합친다.
  let rows = projectBundleRows(uiProjectRows(wfProjects(), workflowData.items));
  // 탭에 들어올 때·새로고침 때만(projectOrderResort) 다시 정렬한다 — 그 밖의 다시 그리기
  // (체크 등으로 load()가 부르는 것)는 고정해 둔 차례를 그대로 쓴다.
  rows = projectOrderResort || !projectOrderKeys ? rows : projectFixedOrder(rows, projectOrderKeys);
  projectOrderResort = false;
  projectOrderKeys = rows.map(row => row.key);
  // 묶음의 나머지 티켓 키로 들어왔으면(오늘 탭 그룹 제목·풀기·대표 바꾸기 뒤) 그 묶음의 대표 줄을 연다.
  if (projectKey && !rows.some(row => row.key === projectKey)) projectKey = projectBundleLeadOf(projectKey);
  if (!rows.some(row => row.key === projectKey)) projectKey = rows.length ? rows[0].key : null;

  // 자동 분류(조용함)는 화면에서 계산하고 저장하지 않는다 — 매번 다시 판정한다.
  const today = todayStr();
  const quietKeys = new Set(rows
    .filter(row => projectQuiet(row, projectRowLastDay(row, workflowData.items, workflowData.meetings), today))
    .map(row => row.key));
  // 보고 있는 프로젝트도 조용하면 `지난 프로젝트` 안에 그대로 둔다(그 묶음을 펼쳐 보인다) — 예전에는 위로 끌어올려
  // 지라 상태에 따라 `시작 전`에 섞여 보여서, 누를 때마다 자리가 왔다 갔다 했다(사용자 보고).
  const { active: visibleRows, past: pastRows } = projectPastRows(rows, { quietKeys });
  const { doing: doingRows, todo: todoRows } = projectStatusGroups(visibleRows);
  // 화면에 보이는 이름은 요약만(같은 요약이 둘 이상이면 그때만 키로 구분) — row.label은 정렬용 원본 그대로 둔다.
  const labels = uiGroupLabels(rows.map(row => row.key));
  const showFind = rows.length >= PROJECT_FIND_MIN;
  const query = projectFindQuery;
  const filtering = showFind && !!query.trim();
  // 머리 수는 두 보기에서 같다 — 지난 프로젝트를 뺀 전체 수(진행 중 + 시작 전). 세그먼트만 바꿨는데
  // 숫자가 달라지면 "무엇의 개수인가"를 다시 읽어야 해서, 보기와 무관한 하나의 뜻으로 고정한다.
  const headCount = visibleRows.length;

  const rowsOnly = !!opts.rowsOnly && showFind && listEl.querySelector('.d-pfind');
  // 프로젝트가 하나도 없으면(찾기로 거른 0개가 아니라 정말 0개) 개수 `0`과 `상태별 | 배포별`을 숨긴다 —
  // 정렬할 것이 없다. 하나가 생기면 다음 그리기에서 그대로 다시 선다.
  const noProjects = !rows.length;
  if (!rowsOnly) {
    const oldSeg = listEl.querySelector('.d-pfseg');
    const segHadFocus = !!(oldSeg && typeof oldSeg.contains === 'function' && oldSeg.contains(document.activeElement));
    listEl.replaceChildren();
    const head = projectListHead(headCount);
    const headNumber = head.querySelector('.n');
    if (headNumber) headNumber.hidden = noProjects;
    listEl.appendChild(head);
    const seg = projectViewSegment();
    seg.hidden = noProjects;
    listEl.appendChild(seg);
    // 세그먼트에 초점이 있다가 숨으면 초점을 잃지 않게 머리의 `+`로 옮긴다.
    if (noProjects && segHadFocus) head.querySelector('.d-pnewgo')?.focus?.();
    if (showFind) listEl.appendChild(projectFindInput());
  } else {
    // 찾기 칸 뒤에 이어 붙은 소제목·줄만 지운다 — 칸 자체(anchor)는 children 배열 안 자리만 확인하고 건드리지 않는다.
    const anchor = listEl.querySelector('.d-pfind');
    const keepIndex = [...listEl.children].indexOf(anchor);
    while (listEl.children.length > keepIndex + 1) listEl.removeChild(listEl.children[listEl.children.length - 1]);
  }

  if (projectListView === 'deploy') projectListPaintDeployTail(listEl, { visibleRows, pastRows, labels, query, filtering });
  else projectListPaintStatusTail(listEl, { doingRows, todoRows, pastRows, labels, query, filtering });

  // 찾는 동안 오른쪽 면은 손대지 않는다(검색은 왼쪽 목록만의 일이다 — 지라를 다시 부르지 않는다).
  if (rowsOnly) return;
  // 새 프로젝트 화면이 열려 있으면 오른쪽 면은 그것 하나다(왼쪽 목록은 그대로 보인다).
  if (projectNew) projectNewRender(body);
  else if (noProjects) projectEmptyBoard(body);
  else renderProjectDetail(body, rows.find(row => row.key === projectKey) || null);
}

// 프로젝트가 하나도 없을 때 오른쪽 자리 — 한 문장 대신 흰 카드 한 판(프로젝트 구역과 같은 `.d-psurf`):
// 무엇이 여기 오는지 · 어떻게 생기는지 · 버튼 하나. 버튼은 머리의 `+`와 같은 함수(projectNewStart)다.
function projectEmptyBoard(body) {
  body.replaceChildren();
  const card = document.createElement('section');
  card.className = 'd-psurf d-pempty';
  card.setAttribute('aria-labelledby', 'projectEmptyTitle');
  const title = document.createElement('h2');
  title.id = 'projectEmptyTitle';
  title.textContent = '아직 프로젝트가 없어요';
  const text = document.createElement('p');
  // 메뉴 길(`⋯ › 프로젝트`)은 줄이 바뀌어도 쪼개지지 않게 사이를 붙는 빈칸(\u00a0)으로 잇는다.
  text.textContent = '업무·결정·회의를 프로젝트로 묶으면 여기서 한 번에 봐요. 업무의 ⋯\u00a0›\u00a0프로젝트를 정해도 저절로 생겨요.';
  const make = document.createElement('button');
  make.type = 'button';
  make.className = 'd-btn acc d-pemptygo';
  make.insertAdjacentHTML('beforeend', uiIcon('plus'));
  make.append('프로젝트 만들기');
  make.addEventListener('click', () => projectNewStart());
  card.append(title, text, make);
  body.appendChild(card);
}

// ---------- 직접 만든 프로젝트 이름 바꾸기 ----------
// 서버가 그 프로젝트에 속한 모든 기록(항목·회의·연결·주간요약)을 **한 트랜잭션**으로 함께
// 바꾼다 — 반쯤 바뀐 이름을 남기지 않는다. 지라 프로젝트의 이름은 지라 요약이라 여기에 없다.
// 앱의 ⌘Z 대상은 아니다(pushUndo를 쓰지 않는다) — 되돌리는 길은 알림의 `되돌리기`(반대 방향 이름
// 바꾸기)뿐이다.
const projectRenamePost = (key, name) => request('/api/project/rename', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: key, name }),
});

// 바꾼 뒤 그 프로젝트를 연 채로 다시 그린다 — 키가 `group:새 이름`으로 바뀌므로 기억해 둔 차례도 다시 잡는다.
async function projectRenameApply(name) {
  projectKey = `group:${name}`;
  try { localStorage.setItem(PROJECT_KEY_STORE, projectKey); } catch {}
  projectOrderResort = true;
  await load();
}

async function projectRenameSave(fromKey, to) {
  const from = fromKey.slice('group:'.length);
  try { await projectRenamePost(fromKey, to); } catch (error) {
    // 겹치는 이름은 거절이 맞다(같은 이름 = 같은 프로젝트) — 합치려는 것이면 그 길을 알려 준다.
    if (/같은 이름의 프로젝트가 이미 있어요/.test(String(error && error.message))) showNotice('같은 이름의 프로젝트가 이미 있어요 — 합치려면 ⋯ › 다른 프로젝트로 합치기를 써요', true);
    return false;
  }
  await projectRenameApply(to);
  showNotice(`이름을 바꿨어요 · ${from} → ${to}`, false, null, {
    label: '되돌리기',
    onClick: async (button) => {
      if (button) button.disabled = true;
      try { await projectRenamePost(`group:${to}`, from); } catch { return; }
      await projectRenameApply(from);
      showNotice(`이름을 되돌렸어요 · ${to} → ${from}`);
    },
  });
  return true;
}

// ---------- 직접 만든 프로젝트 합치기·지우기 ----------
// ⋯ › `다른 프로젝트로 합치기…`는 공용 프로젝트 고르개(projectPickEntries + uiPickList)를 ⋯ 자리에 이어서 열고, 고르면
// 확인 줄 없이 바로 합친다(고르는 동작이 이미 의도다 — 확인창을 되살리지 않는다). 대상이 직접 만든 프로젝트면
// `/api/project/merge`, 지라 에픽이면 기존 옮기기(`/api/project/move` — 에픽 검사가 그 라우트에 있다)다.
// ⋯ › `프로젝트 지우기`는 같은 merge에 `to: null` — 항목은 프로젝트 없음으로 돌아가고 휴지통으로 가지 않는다.
// 셋 다 ⌘Z 대상이고(pushUndo) 알림의 `되돌리기`도 같은 기록을 쓴다(replayUndo). 다시 하기(⇧⌘Z)는 같은 요청을 새로 보낸다.
const projectMergePost = async body => (await request('/api/project/merge', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})).json();

// 고르개 선택지 — 자기 자신·`직접 입력`·`프로젝트 빼기` 동작 줄은 뺀다. 지라를 안 쓰는 설치(또는 연결 전)면 지라 줄도 뺀다.
// 아래에 선택지가 하나도 안 남은 `지난 프로젝트` 소제목은 지운다.
function projectMergeChoices(row) {
  const jira = jiraUsed() && !!(latestData && latestData.jiraSync && latestData.jiraSync.connected !== false);
  const kept = projectPickEntries(null, false).filter((entry) => {
    if (entry.type === 'action') return false;
    if (entry.type !== 'option') return true;
    if (entry.value === row.key) return false;
    return jira || !String(entry.value).startsWith('jira:');
  });
  return kept.filter((entry, index) => entry.type !== 'heading' || (kept[index + 1] && kept[index + 1].type === 'option'));
}

function projectMergeOpen(more, row) {
  const groupName = row.key.slice('group:'.length);
  // 이름 끝 받침을 알 수 없어 조사가 필요 없는 말로 쓴다(묶기 확인 줄과 같은 이유).
  const head = { field: `합칠 곳 고르기 · 항목 ${wfProjectMoveCounts(groupName).items}` };
  const entries = projectMergeChoices(row);
  if (!entries.some(entry => entry.type === 'option')) {
    uiMenu(more, [[head, { label: '합칠 수 있는 프로젝트가 없어요', disabled: true, onClick: () => {} }]]);
    return;
  }
  const close = (focus) => {
    if (uiMenuOpen && uiMenuOpen.anchor === more) uiMenuClose();
    if (focus) more.focus?.();
  };
  const picker = uiPickList({
    entries,
    label: '합칠 곳 고르기',
    search: uiPickSearchable(entries),
    onClose: byKeyboard => close(byKeyboard),
    onPick: (value) => { close(false); projectMergeRun(row.key, value); },
  });
  picker.classList.add('d-pmerge');
  const menu = uiMenu(more, [[head, { field: '합칠 곳', control: picker }]]);
  if (!menu) return;
  picker.focusStart();
}

const projectMergeDoneText = result => (result.to === null
  ? `${result.from} 프로젝트를 지웠어요 · 항목 ${result.changed.items}는 프로젝트 없음으로`
  : `${result.to}${uiRoParticle(result.to)} 합쳤어요 · 항목 ${result.changed.items}`);
// 되돌린 뒤의 말 — 알림 `되돌리기`는 이 문장 그대로, ⌘Z는 replayUndo가 `되돌렸어요 · ` 뒤에 label(동사 없는 꼴)을 붙인다.
const projectMergeBackText = (from, skipped) => `${from} 프로젝트로 되돌렸어요` + (skipped ? ` · 그 사이 바뀐 ${skipped}개는 그대로 두었어요` : '');
const projectMergeBackLabel = (from, skipped) => `${from} 프로젝트로` + (skipped ? ` · 그 사이 바뀐 ${skipped}개는 그대로 두었어요` : '');

// 합치기·지우기·지라로 옮기기가 나가는 길. 실패는 request()가 이미 알렸다 — 서버가 거절한 이유(대상이 그 사이
// 사라짐 등)는 목록을 다시 받은 뒤 그 문구로 알린다. 아무것도 바뀌지 않았다.
async function projectMergeRun(fromKey, toKey) {
  const from = fromKey.slice('group:'.length);
  if (typeof toKey === 'string' && toKey.startsWith('jira:')) {
    let moved;
    try { moved = await wfProjectMoveSend(from, toKey.slice('jira:'.length)); } catch (error) { await projectMergeRefused(error); return; }
    await wfProjectMoveFinish(moved, { verb: '합쳤어요' });
    return;
  }
  const body = { project: fromKey, to: toKey };
  let result;
  try { result = await projectMergePost(body); } catch (error) { await projectMergeRefused(error); return; }
  await projectMergeFinish(result, body);
}
async function projectMergeRefused(error) {
  if (!error || error.name === 'TypeError' || error.name === 'AbortError' || /^요청이 실패했어요/.test(String(error.message))) return;
  await load();
  showNotice(String(error.message).replace(/\.$/, ''), true);
}

// 성공 뒤 — ⌘Z 기록을 먼저 올리고, 목록을 새로 받은 뒤 합친 곳을 연다(옮기기와 같은 차례). 지웠으면 지금 프로젝트가
// 사라졌을 때의 기존 동작(목록 첫 프로젝트)을 따른다. 되돌린 뒤에는 원래 프로젝트를 연 채로 다시 그린다.
async function projectMergeFinish(result, body) {
  const from = result.from;
  const entry = { label: projectMergeDoneText(result) };
  let mergeId = result.mergeId;
  entry.undo = async () => {
    let undone;
    try {
      undone = await (await postJson('/api/project/merge-undo', { mergeId })).json();
    } catch (error) {
      wfUndoGone(entry, error);
      throw error;
    }
    entry.label = projectMergeBackLabel(from, undone.skipped);
    entry.back = projectMergeBackText(from, undone.skipped);
    wfProjectKeep(undone.project);
  };
  entry.redo = async () => {
    const again = await projectMergePost(body);
    mergeId = again.mergeId;
    entry.label = projectMergeDoneText(again);
    wfProjectKeep(again.project);
  };
  pushUndo(entry);
  await load();
  if (result.project) openProjectTab(result.project);
  showNotice(projectMergeDoneText(result), false, null, wfUndoNoticeAction(entry, () => {
    openProjectTab(`group:${from}`);
    showNotice(entry.back);
  }));
}

// ---------- 지라 프로젝트 앱 안 별칭 (BJALIAS) ----------
// 지라 프로젝트의 이름(요약)은 그대로 두고 앱 안에서만 쓰는 별칭을 덧씌운다. 규칙은 하나 —
// 별칭이 있으면 앱 안 어디서나(왼쪽 목록·그룹 제목·프로젝트 고르기·주간요약·슬랙 복사) 그 이름이고,
// 지라 원래 이름은 프로젝트 탭 제목 아래 조용한 줄에 늘 보인다. 지라에는 아무것도 쓰지 않는다.
// alias:null이면 별칭을 지운다(제목 ⋯의 `지라 이름으로 되돌리기`도 이 함수를 그대로 쓴다).
const projectAliasPost = (jira, alias) => request('/api/project/alias', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jira, alias }),
});

// 지라 키는 이름이 바뀌지 않으므로 그룹 이름 바꾸기와 달리 projectKey·차례를 다시 잡지 않아도 된다
// (같은 프로젝트가 열린 채로 남는다). 앱의 ⌘Z 대상은 아니다 — 되돌리는 길은 알림의 `되돌리기`(서버가
// 돌려준 `previous`로 반대 방향 저장)뿐이다.
async function projectAliasSave(jiraKey, alias) {
  const from = uiGroupLabel(`jira:${jiraKey}`);
  // 지라 요약(별칭이 없을 때의 기본 이름)은 요청 전에 이미 안다 — 그룹 이름 바꾸기처럼 되돌리기·
  // 재로드 뒤의 표시 이름도 여기서 직접 짓는다(re-load가 캐시를 다시 채우는 시점에 기대지 않는다).
  const rawSummary = jiraIssuesByKey.get(jiraKey)?.summary || jiraKey;
  const to = alias || rawSummary;
  let result;
  try {
    const response = await projectAliasPost(jiraKey, alias);
    result = await response.json();
  } catch { return false; }
  await load();
  showNotice(`이름을 바꿨어요 · ${from} → ${to}`, false, null, {
    label: '되돌리기',
    onClick: async (button) => {
      if (button) button.disabled = true;
      const back = result.previous || rawSummary;
      try { await projectAliasPost(jiraKey, result.previous ?? null); } catch { return; }
      await load();
      showNotice(`이름을 되돌렸어요 · ${to} → ${back}`);
    },
  });
  return true;
}

// 제목 자리가 그대로 입력칸이 된다(현재 표시 이름·전체 선택). Enter/`저장`으로 보내고 Esc/`취소`로
// 되돌린다. 한글을 조합하는 중의 Enter는 글자를 확정하는 것이라 넘긴다(앱의 다른 입력칸과 같은 규칙).
// 직접 만든(그룹) 프로젝트는 이름을 그대로 바꾸고, 지라 프로젝트(`jira:KEY`)는 앱 안 별칭을 저장한다.
function projectRenameStart(title, key) {
  if (!title.isConnected) return;
  const jira = key.startsWith('jira:') ? key.slice('jira:'.length) : '';
  const current = uiGroupLabel(key);
  const box = document.createElement('div');
  box.className = 'd-pren';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'd-din';
  input.maxLength = 60;
  input.value = current;
  input.setAttribute('aria-label', jira ? '프로젝트 별칭' : '프로젝트 이름');
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'd-btn sm acc';
  save.textContent = '저장';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'd-btn sm';
  cancelBtn.textContent = '취소';
  box.append(input, save, cancelBtn);
  title.replaceWith(box);
  input.focus();
  input.select?.();

  let settled = false;
  const cancel = () => {
    if (settled) return;
    settled = true;
    escDrop(cancel);
    if (!box.isConnected) return;
    box.replaceWith(title);
    title.focus?.();
  };
  escPush(cancel);
  cancelBtn.addEventListener('click', cancel);

  const commit = async () => {
    if (settled) return;
    const value = input.value.trim();
    if (!value || value === current) { cancel(); return; }
    input.disabled = true; save.disabled = true; cancelBtn.disabled = true;
    const ok = jira ? await projectAliasSave(jira, value) : await projectRenameSave(key, value);
    if (!ok) {
      input.disabled = false; save.disabled = false; cancelBtn.disabled = false;
      input.focus();
      return;
    }
    settled = true;
    escDrop(cancel);
  };
  save.addEventListener('click', commit);
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing || input.disabled) return;
    event.preventDefault();
    return commit();
  });
}

// 프로젝트 카드 안의 그룹 하나 — 오늘 목록과 같은 그룹 제목(uiGroupHeading) 아래 줄들이 바로 붙는다.
// 그룹 제목이 옛 `언제 할지` 열·열 이름 줄을 대신한다(오늘/나중에가 줄마다가 아니라 제목에 한 번).
// hint가 있으면(결정만) 제목 끝에 조용한 안내를 붙인다. 빈 그룹은 부르는 쪽이 아예 만들지 않는다.
function projectGroup(label, count, opts = {}) {
  const section = document.createElement('section');
  section.className = 'd-pgrp';
  const head = uiGroupHeading(label, count, opts);
  if (opts.hint) {
    const hint = document.createElement('span');
    hint.className = 'd-pghint';
    hint.textContent = opts.hint;
    head.appendChild(hint);
  }
  section.appendChild(head);
  return section;
}

// 묶음 상세의 줄에서 어느 티켓의 업무인지 알리는 작은 번호(`IO-48511`). 제목과 한 칸(.d-titlewrap)에 선다 —
// 좁은 폭에서 줄 누름은 그대로 시트를 연다(글자라 uiRowTapOpens가 막지 않는다).
function projectFromTag(key) {
  const tag = document.createElement('span');
  tag.className = 'd-pfrom';
  tag.textContent = key;
  tag.title = `지라 ${key} 티켓의 항목이에요`;
  return tag;
}
function projectTitleWithFrom(row, title, fromKey) {
  if (!fromKey) { row.appendChild(title); return; }
  const wrap = document.createElement('span');
  wrap.className = 'd-titlewrap';
  wrap.append(title, projectFromTag(fromKey));
  row.appendChild(wrap);
}

// 프로젝트 면의 업무 한 줄: 체크 | 업무 | 기한. hover에 옮기기(`나중에`/`오늘로`)와 더보기.
// 오늘/나중에는 줄이 아니라 그룹 제목이 말한다(renderProjectDetail).
// fromKey(묶음 상세에서만)가 있으면 제목 뒤에 그 업무의 티켓 번호가 작게 붙는다.
function projectTaskRow(item, fromKey = '') {
  // 오늘 목록/나중에 할 일 중 어디에 있는지는 서버가 나눈 목록 그대로(panelMode) — 그룹 제목과 같은 기준이다.
  const mode = panelMode(item);
  const row = document.createElement('div');
  row.className = 'd-prow2' + (item.doing ? ' is-doing' : '') + (panelState && panelState.id === item.id ? ' is-sel' : '');
  row.dataset.taskId = item.id;

  row.appendChild(uiCheckCell(item, row, false));

  const title = document.createElement('button');
  title.type = 'button';
  title.className = 'ti';
  title.textContent = item.description;
  title.title = item.description;
  title.setAttribute('aria-label', `${item.description} 상세 보기`);
  title.addEventListener('click', () => panelOpen({ id: item.id }));
  projectTitleWithFrom(row, title, fromKey);
  // 좁은 폭에서는 줄 아무 데나 눌러도 상세 시트가 열린다(오늘 목록 줄과 같은 규칙 — app.js uiRowTapOpens).
  row.addEventListener('click', (event) => { if (uiRowTapOpens(event)) panelOpen({ id: item.id }); });

  // 우선순위 열은 없앴다 — 왼쪽 체크박스 안의 꺾쇠가 같은 말을 한다(한 줄에서 두 번 말하지 않는다).
  // 정렬은 그대로 `마감·중요도순`(compareTasks)이다.
  const due = uiDueText(item.due, 'full');
  const deadline = document.createElement('span');
  deadline.className = 'dd' + (due ? uiTone(due.tone) : '');
  if (due) { deadline.innerHTML = uiIcon('calendar') + escapeHtml(due.text); deadline.title = `기한은 ${uiKoDate(item.due)}이에요`; }
  row.appendChild(deadline);

  const acts = document.createElement('span');
  acts.className = 'ac';
  const move = document.createElement('button');
  move.type = 'button';
  move.className = 'd-btn sm';
  move.textContent = mode === 'later' ? '오늘로' : '나중에';
  move.setAttribute('aria-label', `${item.description} — ${move.textContent}`);
  move.addEventListener('click', async () => {
    move.disabled = true;
    await uiMoveRun(row, () => setTaskScheduled(item.id, mode === 'later' ? todayStr() : null),
      mode === 'later' ? '오늘 할 일로 옮겼어요' : uiMoveNotice('나중에 할 일로 옮겼어요 · 기한은 그대로예요', [item], null));
    move.disabled = false;
  });
  acts.append(move, uiMoreButton(`${item.description} — 더 보기`, () => taskMenuSections({ item, mode, card: row })));
  row.appendChild(acts);
  return row;
}

// 완료한 업무 한 줄: 체크(되돌리기) | 제목 | 결과 한 줄 | `9월 21일 완료`. fromKey는 projectTaskRow와 같다.
function projectDoneRow(item, fromKey = '') {
  const row = document.createElement('div');
  row.className = 'd-prow2 is-done' + (panelState && panelState.id === item.id ? ' is-sel' : '');
  row.dataset.taskId = item.id;

  row.appendChild(uiCheckCell(item, row, true));

  const title = document.createElement('button');
  title.type = 'button';
  title.className = 'ti';
  title.textContent = item.description;
  title.title = item.description;
  title.setAttribute('aria-label', `${item.description} 상세 보기`);
  title.addEventListener('click', () => panelOpen({ id: item.id }));
  projectTitleWithFrom(row, title, fromKey);

  const result = document.createElement('span');
  result.className = 'res';
  uiResultCell(result, item);
  row.appendChild(result);

  const when = document.createElement('span');
  when.className = 'dd';
  when.textContent = item.completed ? `${uiKoDateShort(item.completed)} 완료` : '';
  row.appendChild(when);

  // 진행할 업무 줄과 같은 ⋯ 규칙(손이 닿으면 나타난다) — 완료 취소는 체크로 이미 할 수 있다.
  const acts = document.createElement('span');
  acts.className = 'ac';
  const mode = item.scheduled ? 'today' : 'later';
  acts.appendChild(uiMoreButton(`${item.description} — 더 보기`, () => taskMenuSections({ item, mode, card: row })));
  row.appendChild(acts);
  return row;
}

// 확인 대기·결정·아이디어·회의처럼 값이 한두 개뿐인 구역은 같은 한 줄 모양을 쓴다.
// menuSections가 있으면(할 수 있는 일이 더보기뿐이라) 늘 보이는 ⋯을 단다 — 목록에서 쓰는 메뉴 그대로.
// makeCheck가 있으면(확인 대기·결정 줄만) 맨 앞에 그 종류의 체크박스를 단다 — 아이디어·회의 줄은 그대로 비운다.
// source가 있으면(아이디어 줄만) 제목 뒤에 조용한 `원문` 링크를 붙인다(다른 줄과 같은 uiSourceLink).
function projectSimpleRow(text, meta, onOpen, id, menuSections, makeCheck, source) {
  const row = document.createElement('div');
  row.className = 'd-rec' + (makeCheck ? ' has-ck' : '') + (menuSections ? ' has-ac' : '') + (id && panelState && panelState.id === id ? ' is-sel' : '');
  if (id) row.dataset.taskId = id;
  if (makeCheck) {
    // 확인 대기(.d-wcb, 20px)·결정(.d-check, 30px) 둘 다 이 칸 가운데 놓인다.
    const checkCell = document.createElement('span');
    checkCell.className = 'ckc';
    checkCell.appendChild(makeCheck(row));
    row.appendChild(checkCell);
  }
  const title = document.createElement('button');
  title.type = 'button';
  title.className = 'ti';
  title.textContent = text;
  title.title = text;
  title.setAttribute('aria-label', `${text} 상세 보기`);
  title.addEventListener('click', onOpen);
  if (source) {
    const wrap = document.createElement('span');
    wrap.className = 'd-titlewrap';
    wrap.append(title, source);
    row.appendChild(wrap);
  } else {
    row.appendChild(title);
  }
  const note = document.createElement('span');
  note.className = 'mt';
  // meta는 글자 하나이거나 조각 목록이다 — 조각이 {text, tone}이면 그 말만 색 글자(`1일 늦음`)로 선다.
  if (Array.isArray(meta) && meta.some(part => part && typeof part === 'object' && part.tone)) {
    meta.filter(Boolean).forEach((part, index) => {
      if (index) note.append(' · ');
      if (typeof part === 'string') { note.append(part); return; }
      const span = document.createElement('span');
      span.className = uiTone(part.tone).trim();
      span.textContent = part.text;
      note.append(span);
    });
  } else {
    note.textContent = Array.isArray(meta) ? meta.map(part => (part && typeof part === 'object' ? part.text : part)).filter(Boolean).join(' · ') : meta || '';
  }
  row.append(note);
  if (menuSections) {
    const acts = document.createElement('span');
    acts.className = 'ac';
    acts.appendChild(uiMoreButton(`${text} — 더 보기`, () => menuSections(row)));
    row.appendChild(acts);
  }
  return row;
}

// ---------- 빈 에픽에 그룹 프로젝트 옮기기 제안 (BMOVE ②) ----------
// 동기화로 막 긁어온(또는 앱에서 막 만든) 빈 에픽을 열었는데 같은 이름의 그룹 프로젝트가 있으면
// 한 번 묻는다. 앱이 짝을 추측해 자동으로 옮기지는 않는다 — 사람이 눌러야만 옮겨진다.
const PROJECT_MOVE_DISMISS_KEY = 'projectMoveDismissed';
function projectMoveDismissedRead() {
  try { return JSON.parse(localStorage.getItem(PROJECT_MOVE_DISMISS_KEY) || '{}'); } catch { return {}; }
}
function projectMoveDismiss(jiraKey, groupName) {
  const table = projectMoveDismissedRead();
  table[jiraKey] = groupName;
  try { localStorage.setItem(PROJECT_MOVE_DISMISS_KEY, JSON.stringify(table)); } catch {}
}
// 이 지라 키와 이름이 같은 그룹 프로젝트를 찾는다(wfGroupNameKey 규칙 — 별칭도 함께 본다). 없으면 null.
function projectMoveCandidateGroup(jiraKey) {
  const match = wfProjects().find(([key]) => key.startsWith('group:') && wfGroupMatchesJira(key.slice('group:'.length), jiraKey));
  return match ? match[0].slice('group:'.length) : null;
}
// 확인 줄이 떠 있는 동안만 값이 있다 — 프로젝트를 옮기면(또는 탭을 벗어나면) 지운다.
let projectMoveSuggestConfirm = null; // { jiraKey, groupName, busy }
function projectMoveSuggestNode(groupName, jiraKey) {
  if (projectMoveSuggestConfirm && projectMoveSuggestConfirm.jiraKey === jiraKey) {
    return wfMoveConfirmNode(groupName, jiraKey, {
      busy: projectMoveSuggestConfirm.busy,
      onCancel: () => { projectMoveSuggestConfirm = null; renderProjects(); },
      onConfirm: () => projectMoveSuggestRun(groupName, jiraKey),
    });
  }
  const line = document.createElement('div');
  line.className = 'd-jline';
  const words = document.createElement('span');
  words.textContent = `${groupName} 프로젝트의 항목 ${wfProjectMoveCounts(groupName).items}개를 여기로 옮길까요?`;
  const sep1 = document.createElement('span'); sep1.className = 'sep'; sep1.textContent = '·';
  const move = document.createElement('button');
  move.type = 'button'; move.className = 'd-link'; move.textContent = '옮기기';
  move.addEventListener('click', () => { projectMoveSuggestConfirm = { jiraKey, groupName, busy: false }; renderProjects(); });
  const sep2 = document.createElement('span'); sep2.className = 'sep'; sep2.textContent = '·';
  const no = document.createElement('button');
  no.type = 'button'; no.className = 'd-link'; no.textContent = '아니요';
  no.addEventListener('click', () => { projectMoveDismiss(jiraKey, groupName); renderProjects(); });
  line.append(words, sep1, move, sep2, no);
  return line;
}
async function projectMoveSuggestRun(groupName, jiraKey) {
  if (!projectMoveSuggestConfirm || projectMoveSuggestConfirm.busy) return;
  projectMoveSuggestConfirm = { ...projectMoveSuggestConfirm, busy: true };
  renderProjects();
  let result;
  try {
    result = await wfProjectMoveSend(groupName, jiraKey);
  } catch {
    if (!projectMoveSuggestConfirm) return;
    projectMoveSuggestConfirm = { ...projectMoveSuggestConfirm, busy: false };
    renderProjects();
    return;
  }
  projectMoveSuggestConfirm = null;
  await wfProjectMoveFinish(result);
}

// ---------- 묶기·풀기·대표 바꾸기 (BBUNDLE) ----------
// 지라 프로젝트 상세 ⋯의 `다른 티켓과 묶기…` → 묶을 지라 프로젝트 고르기(이미 다른 묶음에 있는 것은 이유와
// 함께 누를 수 없다) → 상세 안의 확인 줄 → 묶기. 풀기·대표 바꾸기는 묶음 상세 ⋯에서 바로 한다.
// 셋 다 표시 정보만 바꾸므로 ⌘Z 대상이다 — 되돌리기는 서버의 `bundle-restore`가 "지금이 바꾼 뒤 모양일
// 때만" 앞 모양으로 돌린다(그 사이 다른 곳에서 바뀌었으면 덮지 않고 거절한다).
let projectBundleAsk = null; // { project: 보고 있는 줄 키, add: 더할 'jira:KEY', busy }
let projectBundleAddTo = null; // { id: 묶음 id, key: 'jira:KEY' } — `+ 할 일 추가`가 붙을 티켓(기본은 대표)

const projectBundlePost = async (route, body) => (await request(`/api/project/${route}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})).json();

// 성공 뒤 공통 — ⌘Z 기록을 남기고, 보던 줄(focusKey)을 연 채로 다시 그리고, 알림에 `되돌리기`를 단다.
async function projectBundleFinish(result, message, focusKey) {
  const id = (result.after || result.before).id;
  const entry = {
    label: message,
    undo: () => postJson('/api/project/bundle-restore', { id, before: result.before, after: result.after }),
    redo: () => postJson('/api/project/bundle-restore', { id, before: result.after, after: result.before }),
  };
  pushUndo(entry);
  projectKey = focusKey;
  try { localStorage.setItem(PROJECT_KEY_STORE, focusKey); } catch {}
  projectOrderResort = true;
  await load();
  showNotice(message, false, null, {
    label: '되돌리기',
    onClick: async (button) => {
      if (undoStack[undoStack.length - 1] !== entry) { showNotice('최근 작업부터 순서대로 실행 취소해 주세요', true); return; }
      if (button) button.disabled = true;
      projectOrderResort = true;
      await replayUndo('undo');
    },
  });
}

// 고르기 목록 — 지라 프로젝트만(이미 이 묶음에 있는 것은 빼고). 다른 묶음에 든 것은 이유와 함께 누를 수 없다.
function projectBundleChoices(row) {
  const mine = projectRowKeys(row);
  const open = [];
  const blocked = [];
  wfProjects().forEach(([key]) => {
    if (!key.startsWith('jira:') || mine.includes(key)) return;
    const other = projectBundleOf(key);
    const label = uiGroupLabel(key, { picker: true });
    if (other) blocked.push({ label: `${label} — 이미 「${uiGroupLabel(other.lead)}」 묶음에 있어요`, disabled: true, onClick: () => {} });
    else open.push({ label, onClick: () => { projectBundleAsk = { project: row.key, add: key, busy: false }; renderProjects(); document.getElementById('projectBody')?.querySelector?.('.d-pbask')?.focus?.(); } });
  });
  const list = [...open, ...blocked];
  return [[{ field: '함께 볼 지라 프로젝트' }, ...(list.length ? list : [{ label: '묶을 수 있는 지라 프로젝트가 없어요', disabled: true, onClick: () => {} }])]];
}

// 묶기 전 확인 줄 — 무엇이 함께 보이는지와 지라는 그대로라는 것을 먼저 말한다(.d-jconfirm 부품 그대로).
function projectBundleAskNode(row) {
  const ask = projectBundleAsk;
  const addName = uiGroupLabel(ask.add);
  const leadName = uiGroupLabel(row.key);
  const openCount = workflowData.items.filter(item => wfKey(item) === ask.add && uiProjectOpenItem(item)).length;
  const meetingCount = workflowData.meetings.filter(event => wfMeetingKey(event) === ask.add).length;
  const box = document.createElement('div');
  box.className = 'd-jconfirm d-pbask';
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', '묶기 전 확인');
  box.setAttribute('tabindex', '-1');
  const head = document.createElement('div');
  head.className = 'ask';
  // 이름 끝이 영문·숫자·괄호인 일이 많아 받침으로 조사를 고를 수 없다 — 조사가 필요 없는 문장으로 쓴다.
  head.textContent = `「${addName}」도 이 프로젝트와 함께 볼까요?`;
  const what = [openCount ? `열린 항목 ${openCount}개` : '', meetingCount ? `회의 ${meetingCount}개` : ''].filter(Boolean).join('·');
  const facts = [
    `「${leadName}」에서 함께 보여요${what ? ` — ${what}` : ''}`,
    '지라 티켓은 그대로예요 — 상태·배포일도 티켓마다 따로',
    `이름은 대표 티켓 「${leadName}」 기준이에요(⋯에서 대표를 바꿀 수 있어요)`,
    '오늘 탭·확인 대기·회의에서도 한 그룹으로 보여요 · 주간요약은 이번 주 보고부터 한 소제목으로(지난 주는 그대로)',
  ].map((text) => { const line = document.createElement('div'); line.textContent = text; return line; });
  const acts = document.createElement('div');
  acts.className = 'acts';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'd-btn sm';
  cancel.textContent = '취소';
  cancel.disabled = ask.busy;
  cancel.addEventListener('click', () => { projectBundleAsk = null; renderProjects(); });
  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'd-btn sm acc';
  go.textContent = ask.busy ? '묶는 중…' : '묶기';
  go.disabled = ask.busy;
  go.addEventListener('click', () => projectBundleRun(row));
  acts.append(cancel, go);
  box.append(head, ...facts, acts);
  return box;
}

async function projectBundleRun(row) {
  if (!projectBundleAsk || projectBundleAsk.busy) return;
  const { add } = projectBundleAsk;
  projectBundleAsk = { ...projectBundleAsk, busy: true };
  renderProjects();
  let result;
  try {
    result = await projectBundlePost('bundle', { project: row.key, add: [add] });
  } catch {
    // 실패 문구는 request()가 알렸다 — 확인 줄은 그대로 두고 다시 누를 수 있게.
    if (projectBundleAsk) { projectBundleAsk = { ...projectBundleAsk, busy: false }; renderProjects(); }
    return;
  }
  projectBundleAsk = null;
  await projectBundleFinish(result, `「${uiGroupLabel(result.after.lead)}」에 함께 묶었어요 · ${uiGroupLabel(add)}`, result.after.lead);
}

async function projectBundleUndo(bundle) {
  let result;
  try { result = await projectBundlePost('unbundle', { id: bundle.id }); } catch { return; }
  await projectBundleFinish(result, `묶음을 풀었어요 · 업무는 원래 티켓에 그대로예요`, bundle.lead);
}

async function projectBundleLead(bundle, lead) {
  let result;
  try { result = await projectBundlePost('bundle-lead', { id: bundle.id, lead }); } catch { return; }
  await projectBundleFinish(result, `대표 티켓을 바꿨어요 · ${uiGroupLabel(lead)}`, lead);
}

// 묶음 상세의 `+ 할 일 추가`가 붙을 티켓 — 고른 것이 이 묶음에 아직 있으면 그것, 아니면 대표.
function projectBundleAddKey(bundle) {
  return projectBundleAddTo && projectBundleAddTo.id === bundle.id && bundle.keys.includes(projectBundleAddTo.key) ? projectBundleAddTo.key : bundle.lead;
}
// 추가 줄 끝의 `→ KEY` — 누르면 묶음 안 다른 티켓으로 바꾼다(입력칸의 적던 글은 그대로 남는다).
function projectBundleAddTarget(bundle, target, input) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'd-link d-paddto';
  button.textContent = `→ ${target.slice('jira:'.length)}`;
  button.title = `${uiGroupLabel(target, { withKey: true })}에 붙어요 — 눌러서 다른 티켓으로`;
  button.setAttribute('aria-label', `할 일이 붙을 티켓: ${uiGroupLabel(target, { withKey: true })} — 바꾸기`);
  button.setAttribute('aria-haspopup', 'true');
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    const draft = input ? input.value : '';
    uiMenu(button, [[{ field: '할 일을 붙일 티켓' }, ...bundle.keys.map(key => ({
      label: uiGroupLabel(key, { picker: true }) + (key === bundle.lead ? ' · 대표' : '') + (key === target ? ' · 지금' : ''),
      onClick: () => {
        projectBundleAddTo = { id: bundle.id, key };
        renderProjects();
        const next = document.querySelector?.('.d-padd .d-addinput');
        if (next) { next.value = draft; next.focus(); }
      },
    }))]]);
  });
  return button;
}

function renderProjectDetail(body, row) {
  body.replaceChildren();
  if (!row) {
    body.insertAdjacentHTML('beforeend', '<div class="d-empty">아직 프로젝트가 없어요. 위의 +로 만들거나 업무에 프로젝트를 지정하면 여기 모여요.</div>');
    return;
  }
  // 묶음(BBUNDLE)이면 묶인 티켓 전부의 항목·회의를 모은다 — 줄마다 어느 티켓 것인지 작은 번호가 붙는다.
  const bundle = row.bundle || null;
  const rowKeys = projectRowKeys(row);
  const items = workflowData.items.filter(item => rowKeys.includes(wfKey(item)));
  const fromOf = item => (bundle && item.jira ? item.jira : '');
  if (projectBundleAsk && projectBundleAsk.project !== row.key) projectBundleAsk = null;
  const title = document.createElement('h2');
  title.className = 'd-ptitle';
  // 큰 제목은 요약만(BKEY 결정) — 한 프로젝트만 보여 주는 자리라 같은 요약과 헷갈릴 일이 없다.
  // 지라 프로젝트에 별칭이 있으면 uiGroupLabel이 이미 그 이름을 돌려준다(BJALIAS).
  title.textContent = uiGroupLabel(row.key);
  const key = typeof row.key === 'string' ? row.key : '';
  const named = key.startsWith('group:');
  const jiraKey = jiraKeyOf(row.key);
  // 직접 만든(그룹) 프로젝트는 이름을 그대로 바꾸고, 지라 프로젝트는 앱 안 별칭만 덧씌운다
  // (지라 요약 자체는 고치지 않는다 — BJALIAS). 별칭이 없을 때만 툴팁으로 그 사실을 알린다.
  const jiraAlias = key.startsWith('jira:') ? projectAliasesCache[key.slice('jira:'.length)] : '';
  if (key.startsWith('jira:') && !jiraAlias) title.title = '이름은 지라 요약을 따라요';
  // 제목 줄의 ⋯ — 지라 띠 카드의 ⋯(연결 해제)와는 다른 메뉴다. 여기는 프로젝트 자체의 일이다.
  if (named || key.startsWith('jira:')) {
    const menuItems = [{ label: '이름 바꾸기', onClick: () => projectRenameStart(title, row.key) }];
    if (jiraAlias) menuItems.push({ label: '지라 이름으로 되돌리기', onClick: () => projectAliasSave(key.slice('jira:'.length), null) });
    // 합치기·지우기는 직접 만든 프로젝트만 — 고르개는 묶기와 같이 이 ⋯ 자리에 이어서 연다. 지우기는 확인창 없이 바로(⌘Z·알림 되돌리기).
    if (named) menuItems.push({ label: '다른 프로젝트로 합치기…', onClick: () => projectMergeOpen(more, row) });
    const removeItems = named ? [{ label: '프로젝트 지우기', danger: true, onClick: () => projectMergeRun(row.key, null) }] : [];
    // 묶기는 지라 프로젝트끼리만(BBUNDLE) — 고르기 목록은 이 ⋯ 자리에 이어서 연다.
    const bundleItems = [];
    if (key.startsWith('jira:')) bundleItems.push({ label: '다른 티켓과 묶기…', onClick: () => uiMenu(more, projectBundleChoices(row)) });
    if (bundle) {
      bundle.keys.filter(entry => entry !== bundle.lead).forEach((entry) => {
        bundleItems.push({ label: `「${uiGroupLabel(entry)}」 대표로`, onClick: () => projectBundleLead(bundle, entry) });
      });
      bundleItems.push({ label: '묶음 풀기', onClick: () => projectBundleUndo(bundle) });
    }
    const more = uiMoreButton('프로젝트 메뉴', () => [menuItems, bundleItems, removeItems]);
    title.appendChild(more);
  }
  const summary = document.createElement('div');
  // 별칭이 있으면 지라 원문이 길어질 수 있어 말줄임 + title로 전체를 남긴다(BJALIAS).
  summary.className = 'd-quiet' + (jiraAlias ? ' d-ptquiet' : '');
  // 그 아래 조용한 줄에 지라 키를 덧붙이고(`열린 항목 2 · ABC-1234`), 별칭이 있으면 지라 원래
  // 이름도 늘 보여 준다(어긋남을 숨기지 않는다 — 보관/조용함 교훈).
  const summaryParts = [`열린 항목 ${row.open}`];
  if (bundle) summaryParts.push(`티켓 ${bundle.keys.length}개 묶음`);
  else if (jiraKey) summaryParts.push(jiraKey);
  if (jiraAlias) {
    const rawSummary = jiraIssuesByKey.get(key.slice('jira:'.length))?.summary || '';
    if (rawSummary) summaryParts.push(`지라: ${rawSummary}`);
  }
  summary.textContent = summaryParts.join(' · ');
  if (jiraAlias) summary.title = summary.textContent;
  body.append(title, summary);
  if (projectBundleAsk) body.appendChild(projectBundleAskNode(row));

  // 지라에 연결된 프로젝트에만, 제목 줄 아래·첫 구역 위에 지라 띠 카드가 선다 — `jira:KEY`
  // 프로젝트든 손으로 티켓을 건 그룹 프로젝트든 같은 카드·같은 길이다(jiraKeyOf가 키를 준다).
  // 부르는 것은 이 자리 하나뿐이다 — 왼쪽 목록은 아무것도 미리 부르지 않는다.
  // 묶음이면 대표 티켓 카드(#jiraStrip) 뒤에 나머지 티켓 카드(#jiraStrip-KEY)가 차례로 선다 — 카드마다
  // 새로고침·지라 바꾸기(확인 줄)가 그 티켓에만 간다. 묶음이 아니면 옆 카드 기억을 비운다.
  const sideKeys = bundle && jiraUsed() ? bundle.keys.filter(entry => entry !== bundle.lead).map(entry => entry.slice('jira:'.length)) : [];
  jiraSideEnsure(sideKeys.length ? row.key : null, sideKeys);
  if (jiraKey && jiraUsed()) {
    const strip = document.createElement('div');
    strip.id = 'jiraStrip';
    strip.dataset.jiraKey = jiraKey;
    strip.dataset.project = row.key;
    if (bundle) strip.dataset.bundle = '1';
    body.appendChild(strip);
    sideKeys.forEach((side) => {
      const seat = document.createElement('div');
      seat.id = jiraSideHostId(side);
      seat.dataset.jiraKey = side;
      // 하위 티켓 펼침은 카드가 선 프로젝트마다 기억한다 — 옆 카드는 제 티켓 키를 자리로 쓴다.
      seat.dataset.project = `jira:${side}`;
      body.appendChild(seat);
    });
    jiraCardEnsure(jiraKey);
    jiraStripPaint();
  } else if (jiraUsed() && typeof row.key === 'string' && row.key.startsWith('group:')) {
    // 아직 걸지 않은 그룹 프로젝트에는 그 자리에 조용한 `지라 티켓 연결` 줄이 선다.
    // `프로젝트 없음`(`__misc__`)과 지라 프로젝트에는 없다.
    const host = document.createElement('div');
    host.id = 'jiraLinkRow';
    host.dataset.project = row.key;
    body.appendChild(host);
    jiraLinkEnsure(row.key);
    jiraLinkPaint();
  }

  // 동기화로 막 긁어온(또는 앱에서 막 만든) 빈 에픽 — 같은 이름의 그룹 프로젝트가 있으면 한 번 묻는다(BMOVE ②).
  // renderProjects()는 왼쪽 목록과 함께 "지금 보는 프로젝트"도 다시 그리는데, 그 프로젝트가 이 지라
  // 키가 아닐 수도 있다(예: 옮기기 확인 줄의 `옮기기`를 누른 뒤 목록이 다시 계산되며 차례가 바뀌는
  // 동안) — 그런 무관한 그리기에 휩쓸려 이 값을 지우지 않도록, 지울 때도 반드시 **같은 지라 키**를
  // 보고 있을 때만(후보가 사라졌을 때만) 지운다.
  const moveCandidate = key.startsWith('jira:') && !items.length && jiraUsed() ? projectMoveCandidateGroup(jiraKey) : null;
  if (moveCandidate && projectMoveDismissedRead()[jiraKey] !== moveCandidate) {
    body.appendChild(projectMoveSuggestNode(moveCandidate, jiraKey));
  } else if (key.startsWith('jira:') && projectMoveSuggestConfirm && projectMoveSuggestConfirm.jiraKey === jiraKey) {
    projectMoveSuggestConfirm = null;
  }

  const tasks = items.filter(item => ['task', 'bug'].includes(item.type));
  const open = tasks.filter(item => item.status !== 'done').sort(compareTasks);
  const done = tasks.filter(item => item.status === 'done').sort((a, b) => (b.completed || '').localeCompare(a.completed || ''));

  // 카드 한 장 — 맨 위는 이 프로젝트로 바로 추가하는 칸(업무가 0개여도 있다, 오늘 할 일로 들어간다), 그 아래 그룹이
  // 오늘 → 나중에 → 확인 대기 → 결정 → 회의 → 아이디어 → 끝낸 것 순으로 선다. 빈 그룹은 제목째 없다.
  const card = document.createElement('div');
  card.className = 'd-psurf d-pcard';
  {
    // 오늘 목록의 그룹 `+` 입력줄과 같은 부품. 오늘 목록의 같은 그룹 줄과 헷갈리지 않게 자리 표시를 따로 붙인다.
    // 묶음이면 대표 티켓(또는 `→ KEY`로 고른 티켓)에 붙는다.
    const addKey = bundle ? projectBundleAddKey(bundle) : key;
    const add = uiGroupAddRow(addKey, '/api/today-task/create', '이 프로젝트에 할 일을 추가했어요 · 오늘 할 일에도 보여요');
    add.dataset.addKey += '::project';
    add.hidden = false;
    add.className += ' d-padd';
    const input = add.querySelector('.d-addinput');
    if (input) { input.placeholder = '+ 이 프로젝트에 할 일 추가 — Enter'; input.setAttribute('aria-label', '이 프로젝트에 할 일 추가'); }
    if (bundle) add.appendChild(projectBundleAddTarget(bundle, addKey, input));
    card.appendChild(add);
  }

  // 진행할 업무는 오늘과 나중에 두 그룹이다 — 날짜를 여기서 다시 계산하지 않고 서버가 나눈 오늘 목록/나중에 할 일
  // (taskListsCache, panelMode)을 그대로 쓴다: 오늘 = 예정일이 오늘·지난 것 또는 기한이 오늘·지난 것, 나중에 = 예정일
  // 없음·내일·미래. 오늘 탭·서랍과 같은 말이고, 줄의 `나중에`/`오늘로` 버튼도 같은 판정이다.
  // 정렬은 그대로 마감·중요도순(compareTasks)이고, 이 두 그룹은 접지 않는다.
  const taskGroup = (label, list) => {
    if (!list.length) return;
    const group = projectGroup(label, list.length);
    list.forEach(item => group.appendChild(projectTaskRow(item, fromOf(item))));
    card.appendChild(group);
  };
  taskGroup('오늘', open.filter(item => panelMode(item) === 'today'));
  taskGroup('나중에', open.filter(item => panelMode(item) === 'later'));

  // menu가 있으면 줄마다 같은 목록이 쓰는 ⋯ 메뉴를 그대로 단다(회의용·프로젝트탭용으로 새로 만들지 않는다).
  // opts.check가 있으면(확인 대기·결정만) 목록이 쓰는 체크박스를 그대로 맨 앞에 단다.
  // opts.withSource가 있으면(아이디어만) 원문이 있는 줄에 조용한 `원문` 링크를 붙인다.
  // opts.lead가 있으면(확인 대기만) 그룹 맨 위에 그 줄을 먼저 세운다 — 방금 체크한 줄의 `다음은?`이다(접지 않는다).
  // opts.hint가 있으면(결정만) 그룹 제목 끝에 조용한 안내가 붙는다.
  // opts.fold(그룹 이름표)가 있는 읽는 그룹은 4개 이상이면 위 3줄만 보이고 그룹 맨 아래 `N개 더 ›`로 펼친다 —
  // 펼침은 projectFolds(`프로젝트키::그룹`)에 기억하고, 3개 이하로 줄면 접힘으로 돌아간다.
  const simple = (label, list, meta, onOpen, menu, opts = {}) => {
    const { check, withSource, lead, hint, fold } = opts;
    if (!list.length && !lead) return;
    const group = projectGroup(label, list.length, hint ? { hint } : {});
    const foldKey = fold ? `${row.key}::${fold}` : '';
    const folds = !!fold && list.length > UI_FOLD;
    if (fold && !folds) projectFolds.delete(foldKey);
    const expanded = folds && projectFolds.has(foldKey);
    const hiddenRows = [];
    if (lead) group.appendChild(lead);
    list.forEach((entry, index) => {
      const line = projectSimpleRow(entry.text, meta(entry.item), () => onOpen(entry.item), entry.id,
        menu ? (host) => menu(entry.item, host) : null,
        check ? (host) => check(entry.item, host) : null,
        withSource ? uiSourceLink(entry.item) : null);
      // 접힌 줄도 그려 두고 hidden만 건다 — 펼치기·접기는 다시 그리지 않아 초점이 그대로 남는다.
      if (folds && index >= UI_FOLD) { line.hidden = !expanded; hiddenRows.push(line); }
      group.appendChild(line);
    });
    if (folds) {
      group.id = `projectGroup-${fold}`;
      group.appendChild(uiFoldToggle(hiddenRows, {
        label,
        expanded,
        controls: group.id,
        className: 'd-pmore',
        onChange: (open) => { if (open) projectFolds.add(foldKey); else projectFolds.delete(foldKey); },
      }));
    }
    card.appendChild(group);
  };
  const asItems = list => list.map(item => ({ item, text: item.description, id: item.id }));
  const openPanel = item => panelOpen({ id: item.id });

  // 방금 체크한 확인 대기는 아래 필터에서 빠지므로 구역 맨 위에 한 번 더 그려 `다음은?`을 잇는다.
  const checkedNow = waitingNextItem();
  const waitingLead = checkedNow && rowKeys.includes(wfKey(checkedNow))
    ? waitingNextLead(checkedNow, (entry) => {
        const done = projectSimpleRow(entry.description, [entry.who, '확인 완료'].filter(Boolean).join(' · '),
          () => panelOpen({ id: entry.id }), entry.id, null, (host) => waitingCheckbox(entry, host, true));
        done.classList.add('is-done');
        return done;
      })
    : null;
  simple('확인 대기', asItems(items.filter(item => item.type === 'check' && item.status !== 'done')),
    // 누구에게 + 급한 날짜 말(`1일 늦음`·`오늘 답변 예정`)을 함께 — 담당이 적혀 있다고 늦은 것이 가려지면 안 된다.
    // 묶음이면 끝에 그 항목의 티켓 번호.
    item => [item.who, uiItemDueText(item), fromOf(item)], openPanel, waitingMenuSections, {
      // 이 그룹은 미완료만 보여 준다(위 필터) — 체크하면 확인 완료가 되어 목록에서 빠진다.
      check: (item, host) => waitingCheckbox(item, host, false), lead: waitingLead, fold: 'waiting',
    });
  // 결정은 반영한 줄만 날짜 글자로 말한다(알약으로 그리지 않는다 — 체크 안 됨이 곧 미반영). 이 그룹은 반영 완료도 함께 보여 준다 —
  // 체크하면 줄은 남고 오른쪽에 반영 날짜가 생긴다(구역의 기존 규칙 그대로).
  simple('결정', asItems(items.filter(item => item.type === 'decision')),
    item => [item.status === 'done' ? `${uiKoDateShort(item.completed)} 반영` : '', fromOf(item)].filter(Boolean).join(' · '), openPanel, decisionMenuSections,
    { check: (item, host) => decisionCheckbox(item, host, item.status === 'done'), hint: '· 체크하면 PRD 반영', fold: 'decision' });

  const meetings = workflowData.meetings.filter(event => rowKeys.includes(wfMeetingKey(event)) || items.some(item => item.meetingId === event.id));
  simple('회의', meetings.map(event => ({ item: event, text: event.title, id: null })),
    event => event.date ? uiKoDateShort(event.date) : '', event => panelOpen({ kind: 'meeting', id: event.id }),
    meetingMenuSections, { fold: 'meeting' });
  simple('아이디어', asItems(items.filter(item => item.type === 'idea')),
    item => [item.created ? `${uiKoDateShort(item.created)} 기록` : '', fromOf(item)].filter(Boolean).join(' · '), openPanel, ideaMenuSections,
    { withSource: true, fold: 'idea' });

  // 끝낸 것 — 기본 접힘(세션 동안 기억), 제목을 누르면 펼친다.
  if (done.length) {
    const group = projectGroup('끝낸 것', done.length, {
      open: projectDoneOpen,
      onToggle: () => { projectDoneOpen = !projectDoneOpen; renderProjects(); },
    });
    if (projectDoneOpen) done.forEach(item => group.appendChild(projectDoneRow(item, fromOf(item))));
    card.appendChild(group);
  }
  body.appendChild(card);
}

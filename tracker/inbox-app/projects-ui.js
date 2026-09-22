// 프로젝트 탭 한 벌 — 왼쪽 목록(열린 항목 수·지난 프로젝트·보관)과 오른쪽 프로젝트 하나의 상세.
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

const PROJECT_KEY_STORE = 'projectKey';
let projectKey = null;
let projectDoneOpen = false;
// 왼쪽 목록의 차례를 탭에 있는 동안 고정해 둔다 — 체크 한 번마다 load()가 다시 그리며 순서가
// 뒤바뀌지 않게. 탭에 들어올 때·새로고침 때만(projectOrderResort) 다시 계산한다. 세션 동안만
// 기억하는 값이라 localStorage에 넣지 않는다(projectPastOpen도 같다).
let projectOrderKeys = null;
let projectOrderResort = true;
let projectPastOpen = false;
function projectKeyRestore() {
  try { projectKey = localStorage.getItem(PROJECT_KEY_STORE) || null; } catch { projectKey = null; }
}

// 오늘 목록의 그룹 제목·업무 상세의 `프로젝트 보기`가 부르는 길.
function openProjectTab(key) {
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
// 끝난 프로젝트가 왼쪽 목록에 계속 쌓였다. 열린 항목이 없고 한참 조용한 것과 사람이 직접 보관한
// 것을 목록 끝의 접힌 구역으로 내린다. **바뀌는 것은 왼쪽 목록 배치와 고르기 목록 소제목뿐이다** —
// 업무·기록·주간요약·검색·슬랙 복사는 하나도 달라지지 않는다.
const PROJECT_QUIET_DAYS = 14;

// 사람이 직접 보관해 둔 프로젝트 표(`프로젝트 키 → 보관한 날`). 서버가 목록과 함께 보내 준다.
function projectArchiveMap() {
  return (typeof workflowData === 'object' && workflowData && workflowData.projectArchive) || {};
}
const projectArchived = key => Object.prototype.hasOwnProperty.call(projectArchiveMap(), key);

// 프로젝트의 마지막 활동 날짜 — **있는 값만** 본다(없는 날짜를 지어내지 않는다).
// 그 프로젝트 항목들의 완료·수정·등록 날짜와, 그 프로젝트에 걸린 회의 날짜 중 가장 최근이다.
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
// quietCount는 자동 분류로 내려왔지만 아직 **보관하지 않은** 수다(권유 줄이 쓴다).
function projectPastRows(rows, { quietKeys, archivedKeys, selectedKey } = {}) {
  const quiet = quietKeys || new Set();
  const archived = archivedKeys || new Set();
  const active = [];
  const past = [];
  rows.forEach((row) => {
    const down = (quiet.has(row.key) || archived.has(row.key)) && row.key !== selectedKey;
    (down ? past : active).push(row);
  });
  return { active, past, quietCount: past.filter(row => !archived.has(row.key)).length };
}

function renderProjects() {
  const listEl = document.getElementById('projectList');
  const body = document.getElementById('projectBody');
  if (!listEl || !body) return;
  let rows = uiProjectRows(wfProjects(), workflowData.items);
  // 탭에 들어올 때·새로고침 때만(projectOrderResort) 다시 정렬한다 — 그 밖의 다시 그리기
  // (체크 등으로 load()가 부르는 것)는 고정해 둔 차례를 그대로 쓴다.
  rows = projectOrderResort || !projectOrderKeys ? rows : projectFixedOrder(rows, projectOrderKeys);
  projectOrderResort = false;
  projectOrderKeys = rows.map(row => row.key);
  if (!rows.some(row => row.key === projectKey)) projectKey = rows.length ? rows[0].key : null;

  // 자동 분류(조용함)는 화면에서 계산하고 저장하지 않는다. 보관은 저장된 값이다.
  const today = todayStr();
  const archivedKeys = new Set(Object.keys(projectArchiveMap()));
  const quietKeys = new Set(rows
    .filter(row => projectQuiet(row, projectLastDay(row.key, workflowData.items, workflowData.meetings), today))
    .map(row => row.key));
  const { active: visibleRows, past: pastRows, quietCount } = projectPastRows(rows, { quietKeys, archivedKeys, selectedKey: projectKey });
  // 화면에 보이는 이름은 요약만(같은 요약이 둘 이상이면 그때만 키로 구분) — row.label은 정렬용 원본 그대로 둔다.
  const labels = uiGroupLabels(visibleRows.concat(projectPastOpen ? pastRows : []).map(row => row.key));

  listEl.replaceChildren();
  const head = document.createElement('div');
  head.className = 'd-rhd';
  const headName = document.createElement('span');
  headName.textContent = '프로젝트';
  const headCount = document.createElement('span');
  headCount.className = 'n num';
  // 머리의 개수는 위 목록의 수다(지난 프로젝트는 세지 않는다).
  headCount.textContent = visibleRows.length;
  head.append(headName, headCount);
  listEl.appendChild(head);

  // 위 목록과 `지난 프로젝트` 구역이 같은 줄 부품을 쓴다 — 지난 것만 흐리게 그린다.
  const addRow = (row, past) => {
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
    const deploy = projectDeployNote(row.key);
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
    // 오늘 목록의 그룹 제목과 같은 색 점 — 같은 프로젝트는 어디서나 같은 색이다.
    button.append(uiProjectDot(row.key), name, right);
    button.addEventListener('click', () => {
      if (projectKey === row.key) return;
      projectKey = row.key;
      try { localStorage.setItem(PROJECT_KEY_STORE, row.key); } catch {}
      renderProjects();
    });
    listEl.appendChild(button);
  };
  visibleRows.forEach(row => addRow(row, false));

  // 목록 끝의 접힌 구역 — 지난 프로젝트가 하나도 없으면 아예 달지 않는다.
  if (pastRows.length) {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'd-plink';
    toggle.setAttribute('aria-expanded', String(projectPastOpen));
    toggle.textContent = projectPastOpen ? '지난 프로젝트 숨기기' : `지난 프로젝트 ${pastRows.length}`;
    toggle.addEventListener('click', () => { projectPastOpen = !projectPastOpen; renderProjects(); });
    listEl.appendChild(toggle);
    // 구역 머리 아래 조용한 한 줄 — 자동으로 내려왔지만 아직 보관하지 않은 것이 있을 때만.
    if (quietCount) {
      const nudge = document.createElement('div');
      nudge.className = 'd-pnudge';
      const words = document.createElement('span');
      words.textContent = `조용한 프로젝트 ${quietCount}개 · 보관할까요?`;
      const all = document.createElement('button');
      all.type = 'button';
      all.className = 'd-link';
      all.textContent = '모두 보관';
      all.addEventListener('click', () => projectArchiveAll(pastRows.filter(row => !archivedKeys.has(row.key)).map(row => row.key)));
      nudge.append(words, all);
      listEl.appendChild(nudge);
    }
    if (projectPastOpen) pastRows.forEach(row => addRow(row, true));
  }

  renderProjectDetail(body, rows.find(row => row.key === projectKey) || null);
}

// 보관·해제가 서버로 나가는 단 하나의 길. 저장하는 것은 프로젝트 키 하나이고 업무·기록은
// 그대로다. 앱의 ⌘Z 대상은 아니다(pushUndo를 쓰지 않는다) — 되돌리는 길은 알림의 `되돌리기`뿐이다.
const projectArchivePost = (key, archived) => request('/api/project/archive', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: key, archived }),
});
async function projectArchiveSet(key, archived) {
  try { await projectArchivePost(key, archived); } catch { return; }
  await load();
  showNotice(archived ? '지난 프로젝트로 옮겼어요' : '지난 프로젝트에서 꺼냈어요', false, null, {
    label: '되돌리기',
    onClick: async (button) => {
      if (button) button.disabled = true;
      try { await projectArchivePost(key, !archived); } catch { return; }
      await load();
      showNotice(archived ? '보관을 해제했어요' : '지난 프로젝트로 다시 옮겼어요');
    },
  });
}
// 권유 줄의 `모두 보관` — 한 건씩 보내고, 막히면 거기서 멈춘 뒤 된 것만 알린다.
async function projectArchiveAll(keys) {
  const done = [];
  let stopped = false;
  for (const key of keys) {
    try { await projectArchivePost(key, true); done.push(key); } catch { stopped = true; break; }
  }
  if (!done.length) return;
  await load();
  showNotice(stopped ? `${done.length}개까지 보관하고 멈췄어요` : `${done.length}개를 보관했어요`, false, null, {
    label: '되돌리기',
    onClick: async (button) => {
      if (button) button.disabled = true;
      for (const key of [...done].reverse()) {
        try { await projectArchivePost(key, false); } catch { break; }
      }
      await load();
      showNotice('보관을 해제했어요');
    },
  });
}

// ---------- 직접 만든 프로젝트 이름 바꾸기 ----------
// 서버가 그 프로젝트에 속한 모든 기록(항목·회의·연결·보관·주간요약)을 **한 트랜잭션**으로 함께
// 바꾼다 — 반쯤 바뀐 이름을 남기지 않는다. 지라 프로젝트의 이름은 지라 요약이라 여기에 없다.
// 앱의 ⌘Z 대상은 아니다(pushUndo를 쓰지 않는다) — 되돌리는 길은 알림의 `되돌리기`(반대 방향 이름
// 바꾸기)뿐이다. 보관(projectArchiveSet)과 같은 규칙이다.
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
  try { await projectRenamePost(fromKey, to); } catch { return false; }
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

// 제목 자리가 그대로 입력칸이 된다(현재 이름·전체 선택). Enter/`저장`으로 보내고 Esc/`취소`로 되돌린다.
// 한글을 조합하는 중의 Enter는 글자를 확정하는 것이라 넘긴다(앱의 다른 입력칸과 같은 규칙).
function projectRenameStart(title, key) {
  if (!title.isConnected) return;
  const box = document.createElement('div');
  box.className = 'd-pren';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'd-din';
  input.maxLength = 60;
  input.value = key.slice('group:'.length);
  input.setAttribute('aria-label', '프로젝트 이름');
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
    if (!value || value === key.slice('group:'.length)) { cancel(); return; }
    input.disabled = true; save.disabled = true; cancelBtn.disabled = true;
    if (!await projectRenameSave(key, value)) {
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

// `언제 할지` 열의 한마디: 오늘 / 내일 / 9월 25일 / 나중에.
function projectPlaceWord(item) {
  if (!item.scheduled) return '나중에';
  const diff = diffDays(item.scheduled);
  if (diff === 0) return '오늘';
  if (diff === 1) return '내일';
  return uiKoDateShort(item.scheduled);
}

function projectSection(title, count) {
  const section = document.createElement('section');
  section.className = 'd-psec';
  section.appendChild(uiGroupHeading(title, count));
  return section;
}

// 프로젝트 면의 업무 한 줄: 체크 | 언제 할지 | 업무 | 우선순위 | 기한. hover에 옮기기와 더보기.
function projectTaskRow(item) {
  const mode = item.scheduled ? 'today' : 'later';
  const row = document.createElement('div');
  row.className = 'd-prow2' + (panelState && panelState.id === item.id ? ' is-sel' : '');
  row.dataset.taskId = item.id;

  row.appendChild(uiCheckCell(item, row, false));

  const place = document.createElement('span');
  place.className = 'pl';
  place.textContent = projectPlaceWord(item);
  row.appendChild(place);

  const title = document.createElement('button');
  title.type = 'button';
  title.className = 'ti';
  title.textContent = item.description;
  title.title = item.description;
  title.setAttribute('aria-label', `${item.description} 상세 보기`);
  title.addEventListener('click', () => panelOpen({ id: item.id }));
  row.appendChild(title);

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
    await fadeOutAndRun(row, () => setTaskScheduled(item.id, mode === 'later' ? todayStr() : null),
      mode === 'later' ? '오늘 할 일로 옮겼어요' : '나중에 할 일로 옮겼어요 · 기한은 그대로예요');
    move.disabled = false;
  });
  acts.append(move, uiMoreButton(`${item.description} — 더 보기`, () => taskMenuSections({ item, mode, card: row })));
  row.appendChild(acts);
  return row;
}

// 완료한 업무 한 줄: 체크(되돌리기) | 제목 | 결과 한 줄 | `9월 21일 완료`.
function projectDoneRow(item) {
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
  row.appendChild(title);

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
  note.textContent = meta || '';
  row.append(note);
  if (menuSections) {
    const acts = document.createElement('span');
    acts.className = 'ac';
    acts.appendChild(uiMoreButton(`${text} — 더 보기`, () => menuSections(row)));
    row.appendChild(acts);
  }
  return row;
}

function renderProjectDetail(body, row) {
  body.replaceChildren();
  if (!row) {
    body.insertAdjacentHTML('beforeend', '<div class="d-empty">아직 프로젝트가 없어요. 업무에 프로젝트를 지정하면 여기 모여요.</div>');
    return;
  }
  const items = workflowData.items.filter(item => wfKey(item) === row.key);
  const archived = projectArchived(row.key);
  const title = document.createElement('h2');
  title.className = 'd-ptitle';
  // 큰 제목은 요약만(BKEY 결정) — 한 프로젝트만 보여 주는 자리라 같은 요약과 헷갈릴 일이 없다.
  title.textContent = uiGroupLabel(row.key);
  // 이름을 바꿀 수 있는 것은 직접 만든(그룹) 프로젝트뿐이다 — 지라 프로젝트의 이름은 지라 요약이라
  // 메뉴 항목을 두지 않고 제목의 툴팁으로만 그 사실을 알린다.
  const key = typeof row.key === 'string' ? row.key : '';
  const named = key.startsWith('group:');
  if (key.startsWith('jira:')) title.title = '이름은 지라 요약을 따라요';
  // 제목 줄의 ⋯ — 지라 띠 카드의 ⋯(연결 해제)와는 다른 메뉴다. 여기는 프로젝트 자체의 일이다.
  title.appendChild(uiMoreButton('프로젝트 메뉴', () => [[
    ...(named ? [{ label: '이름 바꾸기', onClick: () => projectRenameStart(title, row.key) }] : []),
    { label: archived ? '보관 해제' : '보관', onClick: () => projectArchiveSet(row.key, !archived) },
  ]]));
  const summary = document.createElement('div');
  summary.className = 'd-quiet';
  // 그 아래 조용한 줄에만 지라 키를 덧붙인다(`열린 항목 2 · IO-48394`).
  // 보관해 둔 프로젝트에 열린 항목이 생기면 그 사실을 여기서 알린다 — 꺼낼지는 사람이 정한다.
  const jiraKey = jiraKeyOf(row.key);
  summary.textContent = (archived ? '보관한 프로젝트 · ' : '') + `열린 항목 ${row.open}` + (jiraKey ? ` · ${jiraKey}` : '');
  body.append(title, summary);

  // 지라에 연결된 프로젝트에만, 제목 줄 아래·첫 구역 위에 지라 띠 카드가 선다 — `jira:KEY`
  // 프로젝트든 손으로 티켓을 건 그룹 프로젝트든 같은 카드·같은 길이다(jiraKeyOf가 키를 준다).
  // 부르는 것은 이 자리 하나뿐이다 — 왼쪽 목록은 아무것도 미리 부르지 않는다.
  if (jiraKey && jiraUsed()) {
    const strip = document.createElement('div');
    strip.id = 'jiraStrip';
    strip.dataset.jiraKey = jiraKey;
    strip.dataset.project = row.key;
    body.appendChild(strip);
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

  const tasks = items.filter(item => ['task', 'bug'].includes(item.type));
  const open = tasks.filter(item => item.status !== 'done').sort(compareTasks);
  const done = tasks.filter(item => item.status === 'done').sort((a, b) => (b.completed || '').localeCompare(a.completed || ''));

  if (open.length) {
    const section = projectSection('진행할 업무', open.length);
    const surface = document.createElement('div');
    surface.className = 'd-psurf';
    // 조용한 열 이름 줄 — 무슨 값이 어느 칸에 있는지 한 번만 적는다.
    surface.insertAdjacentHTML('beforeend',
      '<div class="d-colhd"><span></span><span>언제 할지</span><span>업무</span><span class="r">기한</span></div>');
    open.forEach(item => surface.appendChild(projectTaskRow(item)));
    section.appendChild(surface);
    body.appendChild(section);
  }

  // menu가 있으면 줄마다 같은 목록이 쓰는 ⋯ 메뉴를 그대로 단다(회의용·프로젝트탭용으로 새로 만들지 않는다).
  // check가 있으면(확인 대기·결정만) 목록이 쓰는 체크박스를 그대로 맨 앞에 단다.
  // withSource가 있으면(아이디어만) 원문이 있는 줄에 조용한 `원문` 링크를 붙인다.
  // lead가 있으면(확인 대기만) 구역 맨 위에 그 줄을 먼저 세운다 — 방금 체크한 줄의 `다음은?`이다.
  const simple = (label, list, meta, onOpen, menu, check, withSource, lead) => {
    if (!list.length && !lead) return;
    const section = projectSection(label, list.length);
    const surface = document.createElement('div');
    surface.className = 'd-psurf plain';
    if (lead) surface.appendChild(lead);
    list.forEach(entry => surface.appendChild(projectSimpleRow(entry.text, meta(entry.item), () => onOpen(entry.item), entry.id,
      menu ? (row) => menu(entry.item, row) : null,
      check ? (row) => check(entry.item, row) : null,
      withSource ? uiSourceLink(entry.item) : null)));
    section.appendChild(surface);
    body.appendChild(section);
  };
  const asItems = list => list.map(item => ({ item, text: item.description, id: item.id }));
  const openPanel = item => panelOpen({ id: item.id });

  // 방금 체크한 확인 대기는 아래 필터에서 빠지므로 구역 맨 위에 한 번 더 그려 `다음은?`을 잇는다.
  const checkedNow = waitingNextItem();
  const waitingLead = checkedNow && wfKey(checkedNow) === row.key
    ? waitingNextLead(checkedNow, (entry) => {
        const done = projectSimpleRow(entry.description, [entry.who, '확인 완료'].filter(Boolean).join(' · '),
          () => panelOpen({ id: entry.id }), entry.id, null, (host) => waitingCheckbox(entry, host, true));
        done.classList.add('is-done');
        return done;
      })
    : null;
  simple('확인 대기', asItems(items.filter(item => item.type === 'check' && item.status !== 'done')),
    // 누구에게 + 급한 날짜 말(`1일 늦음`·`오늘 답변 예정`)을 함께 — 담당이 적혀 있다고 늦은 것이 가려지면 안 된다.
    item => [item.who, uiItemDueText(item)?.text].filter(Boolean).join(' · '), openPanel, waitingMenuSections,
    // 이 구역은 미완료만 보여 준다(위 필터) — 체크하면 확인 완료가 되어 목록에서 빠진다.
    (item, row) => waitingCheckbox(item, row, false), false, waitingLead);
  // 결정은 미반영·반영을 글자로만 가른다(알약으로 그리지 않는다). 이 구역은 반영 완료도 함께 보여 준다 —
  // 체크해도 줄은 남고 오른쪽 글자만 `미반영` → 반영 날짜로 바뀐다(구역의 기존 규칙 그대로).
  simple('결정', asItems(items.filter(item => item.type === 'decision')),
    item => item.status === 'done' ? `${uiKoDateShort(item.completed)} 반영` : '미반영', openPanel, decisionMenuSections,
    (item, row) => decisionCheckbox(item, row, item.status === 'done'));
  simple('아이디어', asItems(items.filter(item => item.type === 'idea')),
    item => item.created ? `${uiKoDateShort(item.created)} 기록` : '', openPanel, ideaMenuSections, null, true);

  const meetings = workflowData.meetings.filter(event => wfMeetingKey(event) === row.key || items.some(item => item.meetingId === event.id));
  simple('회의', meetings.map(event => ({ item: event, text: event.title, id: null })),
    event => event.date ? uiKoDateShort(event.date) : '', event => panelOpen({ kind: 'meeting', id: event.id }),
    meetingMenuSections);

  if (done.length) {
    const section = document.createElement('section');
    section.className = 'd-psec';
    section.appendChild(uiGroupHeading('완료한 업무', done.length, {
      open: projectDoneOpen,
      onToggle: () => { projectDoneOpen = !projectDoneOpen; renderProjects(); },
    }));
    if (projectDoneOpen) {
      const surface = document.createElement('div');
      surface.className = 'd-psurf';
      done.forEach(item => surface.appendChild(projectDoneRow(item)));
      section.appendChild(surface);
    }
    body.appendChild(section);
  }
}

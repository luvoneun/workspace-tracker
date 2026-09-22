// 오늘 정리 창 한 벌 — 오늘 할 일 머리줄 ⋯의 `오늘 정리`가 여는 <dialog>다.
// 저녁에 남은 오늘 업무를 한 화면에 놓고 줄마다 `그대로 | 내일 | 나중에 | 완료`를 찍은 뒤
// 한 번에 저장한다. 저장은 **이미 있는 일괄 저장 길** 하나뿐이다:
// `여러 개 선택` 막대가 쓰는 `/api/workflow/task-batch`(wfPost)로 갈래마다 한 번씩 보낸다.
// 서버는 그대로다 — 새 주소도 새 값도 만들지 않는다.
//
// 지키는 것:
// - 대상은 **오늘 할 일 목록이 쓰는 배열 그대로**(taskListsCache.todayTasks)의 미완료 업무다.
//   `새로 들어온 것`·확인 대기·결정·나중에 할 일은 대상이 아니다.
// - **기본은 전부 `그대로`**다 — 앱이 무엇을 미룰지 추측하지 않는다(DECISIONS).
// - 되돌리기는 갈래마다 받은 `undoToken`을 모아 **⌘Z 항목 하나**로 올린다(역순으로 되돌린다).
// - 사람이 쓴 글자는 textContent로만 넣는다(innerHTML을 쓰지 않는다, 아이콘만 uiIcon 방식).
// index.html에서 settings-ui.js 뒤, app.js보다 먼저 읽힌다.

// 줄마다 고르는 네 가지. 값을 고르는 세그먼트라 앱 공용 부품(wfSegment)을 그대로 쓴다.
const WRAP_CHOICES = [['keep', '그대로'], ['tomorrow', '내일'], ['later', '나중에'], ['done', '완료']];
// 보내는 차례 — 완료 → 내일 → 나중에. 한 업무는 한 갈래에만 들어가므로 두 번 가지 않는다.
const WRAP_SAVE_ORDER = ['done', 'tomorrow', 'later'];
// 화면에서 세는 차례(주 버튼 라벨·알림) — 미루는 것부터 읽는다.
const WRAP_COUNT_ORDER = ['tomorrow', 'later', 'done'];
const WRAP_WORD = { tomorrow: '내일', later: '나중에', done: '완료' };

// 갈래 하나가 보내는 `change` — 전부 `여러 개 선택` 막대가 보내는 값 그대로다
// (`내일` = 내일 날짜, `나중에` = scheduled 없음, `완료` = status done).
function wrapChange(choice) {
  if (choice === 'done') return { status: 'done' };
  if (choice === 'tomorrow') return { scheduled: tomorrowStr() };
  return { scheduled: null };
}

// 오늘 할 일 목록이 그리는 바로 그 배열. 판정도 그 함수와 같다(`status === 'done'`).
function wrapTodayTasks() {
  const lists = typeof taskListsCache === 'object' && taskListsCache ? taskListsCache : null;
  return lists && Array.isArray(lists.todayTasks) ? lists.todayTasks : [];
}
const wrapOpenTasks = items => (items || []).filter(item => item.status !== 'done');
const wrapDoneTasks = items => (items || []).filter(item => item.status === 'done');

const wrapSummaryText = (total, done) => `${total}개 중 ${done}개 끝냈어요 · 남은 ${total - done}개`;

function wrapCounts(rows) {
  const counts = { tomorrow: 0, later: 0, done: 0, total: 0 };
  (rows || []).forEach((row) => {
    if (counts[row.choice] === undefined) return; // `그대로`는 세지 않는다
    counts[row.choice] += 1;
    counts.total += 1;
  });
  return counts;
}

// `내일 2 · 나중에 1 · 완료 1` — 0인 갈래는 생략한다. 라벨과 알림이 같은 말을 쓴다.
const wrapCountWords = counts =>
  WRAP_COUNT_ORDER.filter(key => counts[key]).map(key => `${WRAP_WORD[key]} ${counts[key]}`).join(' · ');
const wrapGoLabel = counts => counts.total ? `정리 끝 — ${wrapCountWords(counts)}` : '바꿀 게 없어요';
const wrapNoticeText = counts => `오늘 정리했어요 · ${wrapCountWords(counts)}`;

// 갈래별 묶음 — 고른 줄이 있는 갈래만, 보내는 차례대로.
function wrapGroups(rows) {
  return WRAP_SAVE_ORDER
    .map(choice => ({ choice, change: wrapChange(choice), ids: (rows || []).filter(row => row.choice === choice).map(row => row.id) }))
    .filter(group => group.ids.length);
}

const wrapSavedCounts = (saved) => {
  const counts = { tomorrow: 0, later: 0, done: 0, total: 0 };
  saved.forEach((group) => { counts[group.choice] += group.ids.length; counts.total += group.ids.length; });
  return counts;
};

// 중간에 멈췄을 때의 한마디 — 어디까지 됐고 무엇이 안 됐는지 그대로 적는다.
function wrapFailText(saved, failed) {
  const done = saved.map(group => `${WRAP_WORD[group.choice]} ${group.ids.length}개`).join(' · ');
  const bad = `${WRAP_WORD[failed.choice]} ${failed.ids.length}개`;
  return done
    ? `${done}는 옮겼지만 ${bad}는 못 옮겼어요 · 다시 시도해 주세요`
    : `${bad}를 못 옮겼어요 · 다시 시도해 주세요`;
}

// ---------- 화면 ----------

let wrapState = null;
let wrapNodes = null;

const wrapToday = () => (typeof latestData === 'object' && latestData && latestData.today) || todayStr();

// 줄 오른쪽의 상태말 — 업무 줄(uiMetaCells)과 같은 말·같은 칸 이름을 쓴다. 있는 것만 선다.
function wrapMetaCell(className, icon, text, hint) {
  const cell = document.createElement('span');
  cell.className = className;
  if (hint) cell.title = hint;
  cell.insertAdjacentHTML('beforeend', uiIcon(icon)); // 아이콘은 코드에 적힌 고정 문자열이다
  cell.append(text); // 사람이 쓴 글자가 아니어도 글자는 글자로만 넣는다(innerHTML을 쓰지 않는다)
  return cell;
}

function wrapMetaCells(item) {
  const cells = [];
  const carry = uiCarryText(item.scheduled);
  if (carry) cells.push(wrapMetaCell('m-carry', 'clock', carry, '오늘 하려다 넘어온 업무예요'));
  if (item.doing) {
    const days = -diffDays(item.doing) + 1;
    cells.push(wrapMetaCell('m-doing', 'clock', days > 1 ? `${days}일째 진행 중` : '진행 중', '이미 손을 댄 업무예요'));
  }
  const due = uiDueText(item.due, 'row');
  if (due) cells.push(wrapMetaCell(`m-due${uiTone(due.tone)}`, 'calendar', due.text, item.due ? `기한은 ${uiKoDate(item.due)}이에요` : ''));
  return cells;
}

function wrapRow(row) {
  const el = document.createElement('div');
  el.className = 'd-wraprow';
  el.dataset.taskId = row.id;

  const wrap = document.createElement('span');
  wrap.className = 'tiwrap';
  const title = document.createElement('span');
  title.className = 'ti';
  title.textContent = row.item.description;
  title.title = row.item.description;
  wrap.appendChild(title);
  // 프로젝트는 다른 줄과 같은 표기(`· ● 이름`)다 — 지라는 요약만(BKEY).
  if (uiProjectName(row.item)) wrap.appendChild(uiInlineProject(row.item));
  el.appendChild(wrap);

  const meta = document.createElement('span');
  meta.className = 'd-meta';
  wrapMetaCells(row.item).forEach(cell => meta.appendChild(cell));
  el.appendChild(meta);

  el.appendChild(wfSegment(WRAP_CHOICES, row.choice, (value) => {
    row.choice = value;
    wrapFootSync();
  }, `${row.item.description} — 오늘 정리`));
  return el;
}

function wrapDoneRow(item) {
  const el = document.createElement('div');
  el.className = 'd-wrapdone';
  el.textContent = item.description;
  el.title = item.description;
  return el;
}

function wrapFootSync() {
  if (!wrapState || !wrapNodes || !wrapNodes.go) return;
  const counts = wrapCounts(wrapState.rows);
  wrapNodes.go.textContent = wrapGoLabel(counts);
  wrapNodes.go.disabled = wrapState.busy || !counts.total;
  if (wrapNodes.cancel) wrapNodes.cancel.disabled = wrapState.busy;
}

function wrapFoot() {
  const foot = document.createElement('div');
  foot.className = 'd-wrapfoot';
  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'd-btn pri';
  go.addEventListener('click', () => wrapSave());
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'd-btn';
  cancel.textContent = '취소';
  cancel.addEventListener('click', () => wrapClose());
  foot.append(go, cancel);
  wrapNodes.go = go;
  wrapNodes.cancel = cancel;
  wrapFootSync();
  return foot;
}

function wrapRender() {
  if (!wrapState || !wrapNodes || !wrapNodes.body) return;
  const body = wrapNodes.body;
  body.replaceChildren();

  const summary = document.createElement('div');
  summary.className = 'd-wrapsum';
  summary.textContent = wrapSummaryText(wrapState.rows.length + wrapState.done.length, wrapState.done.length);
  body.appendChild(summary);

  // 끝낸 것은 접힌 소제목이다(0개면 소제목 자체가 없다).
  if (wrapState.done.length) {
    body.appendChild(uiGroupHeading('끝낸 것', wrapState.done.length, {
      open: wrapState.doneOpen,
      onToggle: () => { wrapState.doneOpen = !wrapState.doneOpen; wrapRender(); },
    }));
    if (wrapState.doneOpen) wrapState.done.forEach(item => body.appendChild(wrapDoneRow(item)));
  }

  body.appendChild(uiGroupHeading('남은 것', wrapState.rows.length, {}));
  const list = document.createElement('div');
  list.className = 'd-wraplist';
  wrapState.rows.forEach(row => list.appendChild(wrapRow(row)));
  body.appendChild(list);

  body.appendChild(wrapFoot());
}

// ---------- 열고 닫기 ----------

function wrapOpen() {
  if (wrapState) return;
  const items = wrapTodayTasks();
  const open = wrapOpenTasks(items);
  // 정리할 것이 없으면 창을 띄우지 않는다 — 한마디로 끝낸다.
  if (!open.length) { showNotice('오늘 할 일을 모두 끝냈어요'); return; }
  const dialog = document.getElementById('wrapDialog');
  const body = document.getElementById('wrapBody');
  if (!dialog || !body) return;
  uiMenuClose();
  wrapState = {
    rows: open.map(item => ({ id: item.id, item, choice: 'keep' })),
    done: wrapDoneTasks(items),
    doneOpen: false,
    busy: false,
    esc: null,
    returnFocus: document.activeElement,
  };
  wrapNodes = { dialog, body, go: null, cancel: null };
  const date = document.getElementById('wrapDialogDate');
  if (date) date.textContent = uiKoDate(wrapToday());
  dialog.showModal?.();
  wrapState.esc = escPush(wrapClose);
  wrapRender();
}

function wrapClose() {
  if (!wrapState) return;
  // 저장이 도는 중의 Esc는 아무것도 닫지 못한다 — 스택에서 빠진 자기를 되돌려 놓는다.
  if (wrapState.busy) {
    if (wrapState.esc && !escStack.includes(wrapState.esc)) escPush(wrapState.esc);
    return;
  }
  const back = wrapState.returnFocus;
  const dialog = wrapNodes && wrapNodes.dialog;
  if (wrapState.esc) escDrop(wrapState.esc);
  if (wrapNodes && wrapNodes.body) wrapNodes.body.replaceChildren();
  wrapState = null;
  wrapNodes = null;
  dialog?.close?.();
  back?.focus?.();
}

// 저장한 갈래는 목록에서 빼고, 못 보낸 줄만 고른 값 그대로 남긴다(새로 받은 자료로 다시 세운다).
function wrapKeepRows(choices) {
  if (!wrapState) return;
  const items = wrapTodayTasks();
  wrapState.rows = wrapOpenTasks(items)
    .filter(item => choices.has(item.id))
    .map(item => ({ id: item.id, item, choice: choices.get(item.id) }));
  wrapState.done = wrapDoneTasks(items);
}

// ---------- 저장 (기존 일괄 저장 길만) ----------
async function wrapSave() {
  if (!wrapState || wrapState.busy) return;
  const groups = wrapGroups(wrapState.rows);
  if (!groups.length) return;
  wrapState.busy = true;
  wrapFootSync();
  const saved = [];
  let failed = null;
  try {
    for (const group of groups) {
      try {
        const result = await wfPost('task-batch', { ids: group.ids, change: group.change });
        saved.push({ choice: group.choice, ids: group.ids, token: result.undoToken });
      } catch {
        failed = group;
        break;
      }
    }
  } finally {
    if (wrapState) wrapState.busy = false;
  }

  // 성공한 갈래만 ⌘Z 항목 하나로 묶는다 — 되돌릴 때는 보낸 차례의 반대로 돌린다.
  let entry = null;
  if (saved.length) {
    const replay = order => async () => {
      for (const part of order()) {
        const back = await wfPost('task-batch', { undoToken: part.token });
        part.token = back.undoToken;
      }
    };
    entry = { label: '오늘 정리', undo: replay(() => [...saved].reverse()), redo: replay(() => saved) };
    pushUndo(entry);
  }

  if (failed) {
    const keep = new Map();
    const savedIds = new Set(saved.flatMap(group => group.ids));
    (wrapState ? wrapState.rows : []).forEach((row) => { if (!savedIds.has(row.id)) keep.set(row.id, row.choice); });
    await load();
    wrapKeepRows(keep);
    if (wrapState && !wrapState.rows.length) wrapClose(); else wrapRender();
    showNotice(wrapFailText(saved, failed), true);
    return;
  }

  await load();
  wrapClose();
  showNotice(wrapNoticeText(wrapSavedCounts(saved)), false, null, { label: '실행 취소', onClick: async () => {
    // 되돌리기는 최근 작업부터다 — 일괄 정리 막대와 같은 규칙이다.
    if (undoStack[undoStack.length - 1] !== entry) { showNotice('최근 작업부터 순서대로 실행 취소해 주세요', true); return; }
    await replayUndo('undo');
  } });
}

// ---------- 창에 붙는 것들 ----------
const wrapDialogEl = document.getElementById('wrapDialog');
if (wrapDialogEl) {
  // 브라우저가 스스로 닫으려 할 때(Esc)도 우리 길로 모은다 — 스택과 포커스 복귀가 어긋나지 않게.
  wrapDialogEl.addEventListener('cancel', (event) => { event.preventDefault(); wrapClose(); });
  // 입력칸이 없는 창이라 Enter는 언제나 주 버튼이다(세그먼트 위에서 눌러도 저장으로 간다).
  wrapDialogEl.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing || !wrapState) return;
    if (event.target && event.target.closest && event.target.closest('.d-wrapfoot, .d-iconbtn')) return;
    event.preventDefault();
    if (wrapNodes && wrapNodes.go && !wrapNodes.go.disabled) wrapNodes.go.click();
  });
}
document.getElementById('wrapCloseBtn')?.addEventListener('click', () => wrapClose());

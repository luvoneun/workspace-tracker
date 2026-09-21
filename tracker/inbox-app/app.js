// ---------- D 공용 부품 ----------
// 화면 여러 곳이 같이 쓰는 것들(아이콘·날짜 문구·더보기 메뉴·날짜 칸·Esc 순서).
// 전부 "불릴 때만" DOM을 만든다 — 정의부만 읽어 검증하는 client.test.js에는 진짜 DOM이 없다.

// 14px 인라인 SVG 한 벌. 선은 currentColor라 글자색을 그대로 물려받는다(이모지·글리프는 쓰지 않는다).
const UI_ICONS = {
  search: '<circle cx="7" cy="7" r="4.25"/><path d="M10.2 10.2 14 14"/>',
  more: '<circle cx="8" cy="3.2" r="1.05"/><circle cx="8" cy="8" r="1.05"/><circle cx="8" cy="12.8" r="1.05"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  plus: '<path d="M8 3.2v9.6M3.2 8h9.6"/>',
  check: '<path d="M3.5 8.4 6.6 11.5 12.5 4.9"/>',
  chevron: '<path d="M6 3.5 10.5 8 6 12.5"/>',
  link: '<path d="M6.9 9.1a2.6 2.6 0 0 0 3.7 0l2-2a2.6 2.6 0 0 0-3.7-3.7l-.6.6"/><path d="M9.1 6.9a2.6 2.6 0 0 0-3.7 0l-2 2a2.6 2.6 0 0 0 3.7 3.7l.6-.6"/>',
  refresh: '<path d="M14 8a6 6 0 1 1-2-4.47L14 5.2"/><path d="M14 2v3.4h-3.4"/>',
  gear: '<path d="M2 4.6h12M2 11.4h12"/><circle cx="6" cy="4.6" r="1.9"/><circle cx="10.4" cy="11.4" r="1.9"/>',
};
function uiIcon(name) {
  const shape = UI_ICONS[name];
  return shape ? `<svg class="d-i" viewBox="0 0 16 16" aria-hidden="true">${shape}</svg>` : '';
}

const UI_WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
// 2026-09-22 → "9월 22일 (화)". 날짜는 어디서나 이 꼴로만 쓰고 연도는 붙이지 않는다.
function uiKoDate(dateStr) {
  if (!dateStr) return '';
  const [, month, day] = String(dateStr).split('-');
  if (!month || !day) return String(dateStr);
  const weekday = UI_WEEKDAYS[new Date(dateStr + 'T00:00:00').getDay()];
  return `${Number(month)}월 ${Number(day)}일${weekday ? ` (${weekday})` : ''}`;
}

// 기한 말투는 어디서나 같다: `2일 지남`(urgent) `오늘까지`(warn) `내일까지` `9월 27일까지`.
// where가 'row'면 오늘 목록의 한 줄 — 먼 기한은 찍지 않는다(의미 없는 값은 자리를 비운다).
function uiDueText(due, where = 'full') {
  if (!due) return null;
  const diff = diffDays(due);
  if (Number.isNaN(diff)) return null;
  if (diff < 0) return { text: `${-diff}일 지남`, tone: 'urgent' };
  if (diff === 0) return { text: '오늘까지', tone: 'warn' };
  if (diff === 1) return { text: '내일까지', tone: '' };
  if (where === 'row') return null;
  return { text: `${uiKoDate(due)}까지`, tone: '' };
}

// 오늘 목록에 언제부터 밀려 있는지: `어제부터` / `3일 전부터`
function uiCarryText(scheduled) {
  if (!scheduled) return null;
  const diff = diffDays(scheduled);
  if (Number.isNaN(diff) || diff >= 0) return null;
  return diff === -1 ? '어제부터' : `${-diff}일 전부터`;
}

// Esc는 가장 위에 열린 것부터 하나씩 닫는다(설정 → 메뉴 → 검색 → 회의 → 상세 → 서랍).
// 여는 쪽이 escPush로 "닫는 방법"을 올려 두고, 닫을 때 escDrop으로 내린다.
const escStack = [];
function escPush(close) { escStack.push(close); return close; }
function escDrop(close) {
  const index = escStack.lastIndexOf(close);
  if (index >= 0) escStack.splice(index, 1);
}
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || event.isComposing || !escStack.length) return;
  event.preventDefault();
  // 스택에 열린 것이 있으면 아래쪽(옛) Esc 처리는 돌지 않는다.
  if (event.stopImmediatePropagation) event.stopImmediatePropagation();
  escStack.pop()();
});

// ⌘K(윈도는 Ctrl+K)로 검색 — 입력칸 안에서도 되고, 한글을 조합하는 중에는 넘어간다.
document.addEventListener('keydown', (event) => {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
  if (event.isComposing || String(event.key).toLowerCase() !== 'k') return;
  event.preventDefault();
  document.getElementById('searchEntryBtn')?.click();
});

// 한 벌뿐인 더보기 메뉴. 한 번에 하나만 열리고, 아래 자리가 없으면 위로 뒤집힌다.
// sections는 [[항목…], [항목…]] — 묶음 사이에 구분선이 들어간다.
// 항목은 { label, onClick, danger, disabled } 또는 값을 바꾸는 { field, control }.
let uiMenuOpen = null;
function uiMenuClose() {
  if (!uiMenuOpen) return;
  const { list, anchor, onEsc } = uiMenuOpen;
  uiMenuOpen = null;
  escDrop(onEsc);
  list.remove();
  anchor.setAttribute('aria-expanded', 'false');
}
function uiMenu(anchor, sections) {
  const sameButton = uiMenuOpen && uiMenuOpen.anchor === anchor;
  uiMenuClose();
  if (sameButton) return null;

  const list = document.createElement('div');
  list.className = 'd-menulist';
  list.setAttribute('role', 'menu');
  list.addEventListener('click', event => event.stopPropagation());
  list.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const focusable = [...list.querySelectorAll('button:not([disabled]), input, select')];
    if (!focusable.length) return;
    event.preventDefault();
    const step = event.key === 'ArrowDown' ? 1 : -1;
    const at = focusable.indexOf(document.activeElement);
    focusable[(at + step + focusable.length) % focusable.length].focus();
  });

  sections.filter(section => section && section.length).forEach((section, index) => {
    if (index) {
      const separator = document.createElement('div');
      separator.className = 'd-msep';
      list.appendChild(separator);
    }
    section.forEach((entry) => {
      if (!entry) return;
      if (entry.field !== undefined) {
        const row = document.createElement('div');
        row.className = 'd-mfield';
        const label = document.createElement('span');
        label.className = 'ml';
        label.textContent = entry.field;
        const slot = document.createElement('span');
        slot.className = 'mc';
        if (entry.control) slot.appendChild(entry.control);
        row.append(label, slot);
        list.appendChild(row);
        return;
      }
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'd-mitem' + (entry.danger ? ' dng' : '');
      item.setAttribute('role', 'menuitem');
      item.textContent = entry.label;
      if (entry.disabled) item.disabled = true;
      item.addEventListener('click', () => { uiMenuClose(); entry.onClick(); });
      list.appendChild(item);
    });
  });

  document.body.appendChild(list);
  const button = anchor.getBoundingClientRect();
  const size = list.getBoundingClientRect();
  const left = Math.max(8, Math.min(button.right - size.width, window.innerWidth - size.width - 8));
  const below = button.bottom + 4;
  const top = below + size.height > window.innerHeight - 8
    ? Math.max(8, button.top - 4 - size.height)
    : below;
  list.style.left = `${Math.round(left)}px`;
  list.style.top = `${Math.round(top)}px`;

  anchor.setAttribute('aria-haspopup', 'true');
  anchor.setAttribute('aria-expanded', 'true');
  const onEsc = () => { uiMenuClose(); anchor.focus(); };
  escPush(onEsc);
  uiMenuOpen = { list, anchor, onEsc };
  list.querySelector('button:not([disabled]), input, select')?.focus();
  return list;
}
document.addEventListener('click', (event) => {
  if (uiMenuOpen && !uiMenuOpen.anchor.contains(event.target)) uiMenuClose();
});

// 날짜 칸 한 벌. 비어 있으면 `+ 기한`, 누르면 그 자리에서 고르고 ✕로 지운다.
function uiDateField({ value, label = '기한', onChange, clearable = true }) {
  const wrap = document.createElement('span');
  wrap.className = 'd-datefield';
  let current = value || '';
  let editing = false;

  const draw = () => {
    wrap.replaceChildren();
    if (!current && !editing) {
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'd-btn sm';
      open.textContent = `+ ${label}`;
      open.addEventListener('click', () => { editing = true; draw(); });
      wrap.appendChild(open);
      return;
    }
    const input = document.createElement('input');
    input.type = 'date';
    input.className = 'd-dateinput';
    input.value = current;
    input.setAttribute('aria-label', label);
    input.addEventListener('change', () => {
      current = input.value;
      editing = false;
      onChange(current || null);
      draw();
    });
    wrap.appendChild(input);
    if (current && clearable) {
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'd-iconbtn sm';
      clear.setAttribute('aria-label', `${label} 지우기`);
      clear.innerHTML = uiIcon('close');
      clear.addEventListener('click', () => { current = ''; editing = false; onChange(null); draw(); });
      wrap.appendChild(clear);
    }
    if (editing) input.focus();
  };
  draw();
  return wrap;
}

// ---------- 화면 상태 ----------

let jiraIssuesCache = [];
// 결정 카드마다 지라 목록을 처음부터 훑지 않도록, 목록을 받을 때 키로 한 번만 색인해 둔다.
let jiraIssuesByKey = new Map();
let customGroupsCache = [];
let appVersion = null;

// 화면을 다시 그리면 쓰던 입력이 날아가므로, 자동 갱신은 입력 중이면 건너뛴다
function isTyping() {
  const el = document.activeElement;
  return !!(el && (el.matches('input, textarea, select') || el.isContentEditable));
}
let planningMode = false;
let todaySort = 'project';
let selectedTaskId = null;
let selectedTaskMode = 'today';
let noticeTimer;
let lastRemovedId = null;

function showNotice(message, error = false, retry = null, action = null) {
  const region = document.getElementById('liveRegion');
  clearTimeout(noticeTimer);
  region.hidden = false;
  region.classList.toggle('error', error);
  region.textContent = message;
  if (!error && !undoReplaying && Date.now() - lastUndoRecordedAt < 3000) {
    const hint = document.createElement('span');
    hint.className = 'd-tnote';
    hint.textContent = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform) ? '⌘Z로 되돌리기' : 'Ctrl+Z로 되돌리기';
    region.appendChild(hint);
  }
  if (lastRemovedId && !error) {
    const undo = document.createElement('button');
    undo.type = 'button';
    undo.className = 'd-btn sm';
    undo.textContent = '삭제 실행 취소';
    undo.addEventListener('click', async () => {
      const id = lastRemovedId;
      undo.disabled = true;
      try {
        await request('/api/track/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
        lastRemovedId = null;
        await load();
        announce('삭제한 항목을 복원했습니다.');
      } catch { undo.disabled = false; }
    });
    region.appendChild(undo);
  }
  if (retry) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'd-btn sm';
    button.textContent = '다시 시도';
    button.addEventListener('click', retry);
    region.appendChild(button);
  }
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'd-btn sm';
    button.textContent = action.label;
    button.addEventListener('click', () => action.onClick(button));
    region.appendChild(button);
  }
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'd-btn sm';
  dismiss.textContent = '닫기';
  dismiss.addEventListener('click', () => { region.hidden = true; });
  region.appendChild(dismiss);
  if (!error && !lastRemovedId) noticeTimer = setTimeout(() => { region.hidden = true; }, action ? 8000 : 4500);
}

// 저장이 멈춘 동안 계속 떠 있는 안내. 스낵바와 달리 스스로 사라지지 않는다.
const STORAGE_BANNER_TEXT = '데이터를 지키기 위해 저장을 멈췄습니다. 지금까지의 기록은 그대로 있습니다. README의 "복구 필요 상태"를 따라 정리한 뒤 서버를 다시 시작해 주세요.';
function renderStorageBanner(storage) {
  const banner = document.getElementById('storageBanner');
  // 예전 서버에는 이 정보가 없다. 모르는 상태에서는 화면을 바꾸지 않는다.
  if (!banner || !storage) return;
  banner.textContent = storage.recoveryNeeded ? STORAGE_BANNER_TEXT : '';
  if (storage.recoveryNeeded && storage.reason) {
    const hint = document.createElement('span');
    hint.className = 'd-bnote';
    hint.textContent = `원인: ${storage.reason}`;
    banner.appendChild(hint);
  }
  banner.hidden = !storage.recoveryNeeded;
}
async function refreshStorageStatus() {
  try {
    const response = await fetch('/api/storage-status');
    if (!response.ok) return; // 예전 서버에는 없는 주소다. 조용히 넘어간다.
    renderStorageBanner(await response.json());
  } catch { /* 연결 실패는 목록 쪽 안내로 충분하다 */ }
}

const pendingRequestKeys = new Map();
async function request(url, options) {
  const writing = options?.method === 'POST';
  const retryKey = writing && /\/(create|capture|review)$/.test(url) ? url + options.body : null;
  if(retryKey && typeof crypto !== 'undefined' && crypto.randomUUID) {
    if(!pendingRequestKeys.has(retryKey))pendingRequestKeys.set(retryKey,crypto.randomUUID());
    options={...options,headers:{...options.headers,'Idempotency-Key':pendingRequestKeys.get(retryKey)}};
  }
  // 회의 정리 창의 담기·되돌리기·직접 담기는 창 안의 결과 카드가 결과를 알려 주니, 창에 반쯤 가려지는 저장 알림은 띄우지 않는다(실패는 그대로 알린다).
  const quiet = writing && (options?.quiet || /^\/api\/workflow\/(review|review-undo|capture)$/.test(url));
  if (writing && !quiet) showNotice('저장 중…');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    // 실패 응답에 담긴 서버 메시지를 버리지 않는다 (저장이 멈춘 이유 등).
    // 본문은 한 번만 읽어서 해석하고, 호출한 쪽의 response.json()은 그 결과를 그대로 돌려준다
    // (예전에는 복제본까지 만들어 같은 본문을 두 번 해석했다). 해석에 실패했을 때 호출한 쪽이
    // 받는 오류도 예전과 같게 둔다.
    let data = null, parsed = false, text;
    try { text = await response.text(); data = JSON.parse(text); parsed = true; } catch { data = null; }
    response.json = parsed ? async () => data : async () => JSON.parse(text);
    if (!response.ok || data?.ok === false) {
      const failure = new Error(data?.error || (response.ok ? '저장하지 못했습니다.' : `요청 실패 (${response.status})`));
      failure.code = data?.code;
      throw failure;
    }
    if(retryKey)pendingRequestKeys.delete(retryKey);
    if (writing) recordUndoFor(url, JSON.parse(options.body || '{}'));
    if (url === '/api/track/remove' && !undoReplaying) lastRemovedId = JSON.parse(options.body).id;
    if (writing && !quiet) showNotice('저장했습니다.');
    return response;
  } catch (error) {
    error.reported = true;
    if (error.code === 'RECOVERY_NEEDED') {
      renderStorageBanner({ recoveryNeeded: true });
      showNotice(error.message, true);
    } else showNotice(writing ? '저장을 확인하지 못했습니다. 입력은 유지됩니다. 연결을 확인한 뒤 다시 시도해 주세요.' : '목록을 불러오지 못했습니다.', true, writing ? null : () => load());
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// Event handlers keep their inputs in place on failure; request() displays the error.
window.addEventListener('unhandledrejection', event => {
  if (event.reason?.reported) event.preventDefault();
});

const undoStack = [];
const redoStack = [];
let undoReplaying = false;
let lastUndoRecordedAt = 0;
let itemsById = new Map();

const postJson = (url, body) => request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function pushUndo(entry) {
  if (undoReplaying) return;
  undoStack.push(entry);
  if (undoStack.length > 30) undoStack.shift();
  redoStack.length = 0;
  lastUndoRecordedAt = Date.now();
}

// Reads itemsById before load() refreshes it, so the "before" state is still available.
function recordUndoFor(url, body) {
  if (url === '/api/track/restore' && body.id === lastRemovedId) lastRemovedId = null;
  if (undoReplaying) return;
  const item = itemsById.get(body.id);
  const label = item ? item.description : '';
  if (url === '/api/track/toggle') {
    const before=item?.status || (body.status==='done'?'to-do':'done');
    const after=body.status || (before==='done'?'to-do':'done');
    pushUndo({ label, undo: () => postJson(url, { id: body.id,status:before }), redo: () => postJson(url, { id: body.id,status:after }) });
  } else if (url === '/api/track/set-scheduled' && item) {
    const before = item.scheduled || null;
    pushUndo({ label, undo: () => postJson(url, { id: body.id, scheduled: before }), redo: () => postJson(url, { id: body.id, scheduled: body.scheduled }) });
  } else if (url === '/api/track/remove') {
    pushUndo({ label, removedId: body.id, undo: () => postJson('/api/track/restore', { id: body.id }), redo: () => postJson(url, { id: body.id }) });
  } else if (url === '/api/track/restore') {
    // Restored from the notice's own undo button — drop the matching entry so ⌘Z doesn't restore twice.
    const index = undoStack.findLastIndex(entry => entry.removedId === body.id);
    if (index >= 0) undoStack.splice(index, 1);
  }
}

async function replayUndo(direction) {
  if (undoReplaying) return;
  const [from, to] = direction === 'undo' ? [undoStack, redoStack] : [redoStack, undoStack];
  const entry = from.pop();
  if (!entry) {
    showNotice(direction === 'undo' ? '되돌릴 작업이 없습니다.' : '다시 실행할 작업이 없습니다.');
    return;
  }
  undoReplaying = true;
  try {
    await entry[direction]();
    to.push(entry);
    await load();
    showNotice(`${direction === 'undo' ? '되돌림' : '다시 실행'}${entry.label ? `: ${entry.label}` : ''}`);
  } catch {
    from.push(entry);
  } finally {
    undoReplaying = false;
  }
}

document.addEventListener('keydown', (event) => {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== 'z') return;
  if (event.target?.closest?.('input, textarea, select, [contenteditable="true"], [contenteditable=""]')) return;
  event.preventDefault();
  replayUndo(event.shiftKey ? 'redo' : 'undo');
});

async function load() {
  let res;
  try { res = await request('/api/items'); } catch { refreshStorageStatus(); return; }
  const data = await res.json();
  renderStorageBanner(data.storage);
  itemsById = new Map(['todayTasks', 'laterTasks', 'waiting', 'decisions', 'decisionArchive', 'ideas']
    .flatMap(key => data[key] || []).map(item => [item.id, item]));
  // 앱 화면이 바뀌었으면 데이터만 다시 받아선 소용없다 (새 UI가 아예 없는 상태).
  // 입력 중이 아닐 때만 스스로 새로고침한다.
  if (data.appVersion) {
    if (!appVersion) appVersion = data.appVersion;
    else if (appVersion !== data.appVersion && !isTyping()) {
      location.reload();
      return;
    }
  }

  jiraIssuesCache = data.jiraIssues || [];
  jiraIssuesByKey = new Map(jiraIssuesCache.map(issue => [issue.key, issue]));
  customGroupsCache = data.customGroups || [];
  workflowRender(data);
  renderDateBar(data);
  renderCalendar(data.calendar);
  renderSuggestions(data.suggestions);
  renderInbox(data.inboxTasks || []);
  renderLaterTasks(data.laterTasks || []);
  renderWaiting(data.waiting || []);
  renderTodayTasks(data.todayTasks || []);
  decisionArchiveCache = data.decisionArchive || [];
  document.getElementById('decisionCount').textContent = (data.decisions || []).length;
  latestData = data;
  tabStale.records = true; tabStale.weekly = true;
  renderActiveTabLists();
  const hasNewRecord = [...(data.ideas || []), ...(data.decisions || [])].some(i => i.isNew);
  document.getElementById('tabBtnRecords').classList.toggle('has-new', hasNewRecord);
  document.getElementById('createdTodayCount').textContent = data.createdToday || 0;

  const todayIds = new Set((data.todayTasks || []).map(t => t.id));
  const reminders = [...(data.todayTasks || []), ...(data.laterTasks || [])]
    .filter(t => !todayIds.has(t.id) && t.status !== 'done' && t.due && diffDays(t.due) <= 1 && (t.priority === 'high' || t.priority === 'critical'))
    .sort((a, b) => diffDays(a.due) - diffDays(b.due));
  renderReminders(reminders);
  syncTaskDetail([...data.todayTasks || [], ...data.laterTasks || []]);
  renderPlanningMode();
}

// 열려 있지도 않은 탭의 카드를 load()마다 다시 만들 필요는 없다 — 숫자·NEW 표시는 그대로
// 갱신하고, 목록은 그 탭이 열려 있거나 열릴 때 만든다(새 자료가 오면 다시 만든다).
let latestData = null;
let activeTabKey = 'today';
const tabStale = { records: true, weekly: true };
function renderActiveTabLists() {
  if (!latestData) return;
  if (activeTabKey === 'records' && tabStale.records) {
    tabStale.records = false;
    renderIdeas(latestData.ideas || []);
    renderDecisions(latestData.decisions || []);
    renderDecisionArchive();
  }
  if (activeTabKey === 'weekly' && tabStale.weekly) {
    tabStale.weekly = false;
    renderWeeklyReports(latestData.weeklyReports || []);
  }
}

function renderPlanningMode() {
  const grid = document.getElementById('gridToday');
  const button = document.getElementById('planningToggle');
  if (!grid || !button) return;
  grid.classList.toggle('planning-mode', planningMode);
  button.setAttribute('aria-pressed', String(planningMode));
  button.textContent = planningMode ? '완료' : '계획·정리';
  button.setAttribute('aria-label', planningMode ? '계획·정리 모드 닫기' : '계획·정리 모드 열기');
  const laterZone = document.getElementById('laterTaskZone');
  if (laterZone && planningMode) laterZone.open = true;
  if (!planningMode && taskSelectionMode) { taskSelectionMode = false; taskSelection.clear(); taskListsRender(); }
  taskSelectionRefresh();
}

function renderDateBar(data) {
  if (data.title) {
    document.getElementById('workspaceTitle').textContent = data.title;
    document.title = data.title;
  }
  const bar = document.getElementById('dateBar');
  bar.replaceChildren();
  const date = document.createElement('span');
  date.className = 'd-date';
  date.textContent = uiKoDate(data.today);
  bar.appendChild(date);

  // 자동 갱신이 실패해도 화면엔 낡은 자료가 그대로 보이므로, 낡았을 때만 알린다
  // used === false 는 "이 회사에선 안 쓰는 도구" — 경고할 일이 아니다
  const stale = [];
  const slack = data.slackSync || {};
  if (slack.used !== false && slack.stale) stale.push({ name: '슬랙 캡처', lastSync: slack.lastSync });
  const cal = data.calendar || {};
  if (cal.used !== false && (cal.stale || !cal.lastSync)) stale.push({ name: '캘린더', lastSync: cal.lastSync });
  const jira = data.jiraSync || {};
  if (jira.used !== false && jira.stale) stale.push({ name: '지라', lastSync: jira.lastSync });

  stale.forEach(source => {
    const warn = document.createElement('span');
    warn.className = 'd-warn';
    const dot = document.createElement('i');
    dot.className = 'd-dot';
    dot.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    const days = source.lastSync ? -diffDays(source.lastSync) : null;
    const age = days === null ? '동기화 안 됨' : days === 1 ? '어제 기준' : `${days}일 전 기준`;
    label.textContent = `${source.name} ${age}`;
    warn.append(dot, label);
    warn.title = source.lastSync
      ? `${source.name} 자동 갱신이 ${source.lastSync} 이후 멈춰 있습니다. 목록이 최신이 아닐 수 있어요.`
      : `${source.name}를 아직 한 번도 가져오지 못했습니다.`;
    bar.appendChild(warn);
  });
}

function renderCalendar(calendar) {
  const events = ((calendar && calendar.events) || []).map(event => {
    const saved = workflowData.meetings.find(meeting => meeting.date === todayStr() && meeting.start === event.start && meeting.title === event.title);
    return saved ? { ...event, project: saved.project, workflowId: saved.id, draftCount: saved.drafts?.length || 0 } : event;
  });
  document.getElementById('calendarSectionCount').textContent = events.length;
  const list = document.getElementById('calendarList');
  if (!events.length) {
    list.innerHTML = `<div class="empty">${calendar?.stale || !calendar?.lastSync ? '오늘 일정을 확인할 수 없습니다.' : '오늘 미팅 없음'}</div>`;
    return;
  }
  list.innerHTML = '';
  events.forEach(event => {
    const row = document.createElement('div');
    row.className = 'calendar-event';
    row.innerHTML = `
      <div class="cal-top">
        <span class="calendar-time">${event.start}–${event.end}</span>
        <span class="cal-top-right">
          ${event.draftCount ? `<span class="badge cal-drafts" title="AI가 분류한 초안을 검토해 주세요">초안 ${event.draftCount}</span>` : ''}
          ${event.relatedCount ? `<span class="badge cal-related">할 일 ${event.relatedCount}</span>` : ''}
        </span>
      </div>
      <div class="calendar-title">${escapeHtml(event.title)}</div>
      ${event.project ? `<div class="cal-project" title="${escapeAttr(event.project.label)}">${escapeHtml(event.project.label)}</div>` : ''}
    `;

    const setProject = async (projectKey) => {
      await request('/api/meeting/set-project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: event.title, project: projectKey }),
      });
    };
    const projectField = overflowField('프로젝트 연결', renderGroupControl({
      jira: event.project && event.project.type === 'jira' ? event.project.value : null,
      group: event.project && event.project.type === 'group' ? event.project.value : null,
      onSetJira: (key) => setProject(key ? `jira:${key}` : null),
      onSetGroup: (value) => setProject(value ? `group:${value}` : null),
    }));

    row.querySelector('.cal-top-right').appendChild(renderOverflowMenu([
      { label: '회의 정리', onClick: () => openMeetingPanel(event) },
      { separator: true },
      { custom: projectField },
    ]));

    const title = row.querySelector('.calendar-title');
    title.classList.add('calendar-title-open');
    title.tabIndex = 0;
    title.setAttribute('role', 'button');
    title.setAttribute('aria-label', `${event.title} — 회의 정리`);
    title.addEventListener('click', () => openMeetingPanel(event));
    title.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openMeetingPanel(event); }
    });

    list.appendChild(row);
  });
}


function suggestDismissedToday() {
  try { return localStorage.getItem('suggestDismissed') === todayStr(); } catch { return false; }
}

function renderSuggestions(suggestions) {
  const zone = document.getElementById('suggestZone');
  const data = { ...(suggestions || { mode: 'none', items: [] }) };
  if (data.mode === 'pull') data.items = data.items.filter(item => {
    const blocked = wfItem(wfItem(item.id)?.blockedBy);
    return !blocked || blocked.status === 'done';
  });
  if (!data.items.length || suggestDismissedToday()) {
    zone.hidden = true;
    return;
  }

  const defer = data.mode === 'defer';
  zone.hidden = false;
  zone.classList.toggle('defer', defer);
  document.getElementById('suggestTitle').textContent = defer
    ? `오늘 ${data.total}개는 많아 보여요. 이건 미룰까요?`
    : '오늘 이건 어때요?';

  const list = document.getElementById('suggestList');
  list.innerHTML = '';
  data.items.forEach(item => {
    const row = document.createElement('div');
    row.className = 'suggest-row';

    const main = document.createElement('div');
    main.className = 'suggest-main';
    main.innerHTML = `
      <span class="suggest-desc">${escapeHtml(item.description)}</span>
      <span class="badges">${item.reasons.map(r => `<span class="badge">${escapeHtml(r)}</span>`).join('')}</span>
    `;
    row.appendChild(main);

    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'convert-btn suggest-action';
    action.textContent = defer ? '내일로' : '오늘로';
    action.addEventListener('click', async () => {
      action.disabled = true;
      try {
        await setTaskScheduled(item.id, defer ? tomorrowStr() : todayStr());
        announce(defer ? '내일로 미뤘습니다.' : '오늘 할 일로 옮겼습니다.');
      } catch { action.disabled = false; }
    });
    row.appendChild(action);

    list.appendChild(row);
  });
}

function relativeDate(dateStr) {
  const diff = diffDays(dateStr);
  if (diff === 0) return '오늘';
  if (diff === -1) return '어제';
  if (diff < -1 && diff >= -6) return `${-diff}일 전`;
  return dateStr;
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function tomorrowStr() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function diffDays(dueStr) {
  const due = new Date(dueStr + 'T00:00:00');
  const today = new Date(todayStr() + 'T00:00:00');
  return Math.round((due - today) / 86400000);
}

function dueLabel(diff) {
  if (diff < 0) return { text: `D+${-diff} 지남`, cls: 'overdue' };
  if (diff === 0) return { text: '오늘 마감', cls: 'due-today' };
  if (diff === 1) return { text: '내일 마감', cls: 'due-tomorrow' };
  return { text: `마감 ${diff}일 전`, cls: '' };
}

function renderReminders(reminders) {
  const zone = document.getElementById('reminderZone');
  const list = document.getElementById('reminderList');

  document.getElementById('reminderSectionCount').textContent = reminders.length;
  zone.hidden = reminders.length === 0;
  const worstDiff = reminders.length ? Math.min(...reminders.map(r => diffDays(r.due))) : null;
  zone.classList.toggle('urgent', worstDiff !== null && worstDiff < 0);
  zone.classList.toggle('warn', worstDiff !== null && worstDiff >= 0);

  list.innerHTML = '';
  reminders.forEach(item => list.appendChild(renderReminderCard(item)));
}

function renderReminderCard(item) {
  const label = dueLabel(diffDays(item.due));
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `reminder-link ${label.cls}`;
  button.innerHTML = `<span>${escapeHtml(item.description)}</span><span class="reminder-link-meta">${label.text}</span>`;
  button.setAttribute('aria-label', `${item.description} 상세 보기, ${label.text}`);
  button.addEventListener('click', () => openTaskDetail(item, 'later'));
  return button;
}

// weekKey(월요일, 'YYYY-MM-DD')를 "9월 3주차" + "9/14 ~ 9/20" 두 줄로 보여줄 조각으로 쪼갠다.
// 몇째 주인지는 그 달 안에서 월요일이 몇 번째로 나오는지로 센다(흔히 쓰는 방식).
function formatWeekLabel(weekKey) {
  const monday = new Date(`${weekKey}T00:00:00`);
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);
  const weekOfMonth = Math.ceil(monday.getDate() / 7);
  const fmt = (d) => `${d.getMonth() + 1}/${d.getDate()}`;
  return {
    week: `${monday.getMonth() + 1}월 ${weekOfMonth}주차`,
    range: `${monday.getFullYear()}년 ${fmt(monday)} ~ ${fmt(sunday)}`,
  };
}

let selectedWeekKey = null;
let weeklyReportsCache = [];

function renderWeeklyReports(items) {
  weeklyReportsCache = items;
  document.getElementById('weeklyReportCount').textContent = items.length;
  const nav = document.getElementById('weeklyReportNav');
  const detail = document.getElementById('weeklyReportDetail');

  if (!items.length) {
    nav.innerHTML = '';
    detail.innerHTML = '<div class="empty">주간 요약 없음</div>';
    selectedWeekKey = null;
    return;
  }

  if (!selectedWeekKey || !items.some(i => i.weekKey === selectedWeekKey)) {
    selectedWeekKey = items[0].weekKey;
  }

  nav.innerHTML = '';
  items.forEach(item => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'wr-nav-btn' + (item.weekKey === selectedWeekKey ? ' active' : '');
    const navLabel = formatWeekLabel(item.weekKey);
    btn.innerHTML = `<span class="wr-nav-week">${escapeHtml(navLabel.week)}</span><span class="wr-nav-range">${escapeHtml(navLabel.range)}</span>`;
    btn.setAttribute('aria-label', `${navLabel.week}, ${navLabel.range}`);
    btn.addEventListener('click', () => {
      selectedWeekKey = item.weekKey;
      renderWeeklyReports(weeklyReportsCache);
    });
    nav.appendChild(btn);
  });

  if (detail.contains(document.activeElement) && detail.dataset.weekKey === selectedWeekKey) return;

  const current = items.find(i => i.weekKey === selectedWeekKey);
  renderWeeklyReportDetail(current);
}

function renderWeeklyReportDetail(item) {
  // 보고 초안은 서버가 항상 붙여준다 — 없거나 보고 화면 스크립트가 없으면 상세를 비워둔다.
  if (!item || !item.draft || typeof renderReportDraft !== 'function') { document.getElementById('weeklyReportDetail').innerHTML = ''; return; }
  renderReportDraft(item);
}

let decisionArchiveCache = [];
let decisionArchiveQuery = '';

function renderDecisionArchive() {
  const items = decisionArchiveCache.filter(item => {
    if (!decisionArchiveQuery) return true;
    const jiraSummary = item.jira ? (jiraIssuesByKey.get(item.jira) || {}).summary : '';
    return [item.description, item.group, item.jira, jiraSummary]
      .some(value => value && value.toLowerCase().includes(decisionArchiveQuery));
  });
  document.getElementById('decisionArchiveCount').textContent = items.length;
  const list = document.getElementById('decisionArchiveList');
  list.innerHTML = items.length ? '' : `<div class="empty">${decisionArchiveQuery ? '일치하는 결정 없음' : '반영 완료한 결정 없음'}</div>`;
  items.forEach(item => list.appendChild(renderDecisionCard(item)));
}

// 지라 연결이든 직접 지정한 그룹이든 같은 방식으로 라벨을 만든다 — 카드 위 뱃지랑 동일한 표기.
function decisionGroupLabel(item) {
  if (item.jira) {
    const issue = jiraIssuesByKey.get(item.jira);
    return issue ? `${item.jira} · ${issue.summary}` : item.jira;
  }
  return item.group || null;
}

function renderDecisions(items) {
  document.getElementById('decisionSectionCount').textContent = items.length;
  const list = document.getElementById('decisionList');
  list.innerHTML = '';
  if (!items.length) return;

  // "언젠가"랑 같은 방식 — 프로젝트/그룹별로 묶고, 없는 건 기타로
  const groups = new Map();
  items.forEach(item => {
    const key = decisionGroupLabel(item) || '__misc__';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  });
  const namedKeys = [...groups.keys()].filter(k => k !== '__misc__').sort();
  const orderedKeys = groups.has('__misc__') ? [...namedKeys, '__misc__'] : namedKeys;

  orderedKeys.forEach(key => {
    const groupEl = document.createElement('div');
    groupEl.className = 'today-group';

    const header = document.createElement('div');
    header.className = 'today-group-header' + (key === '__misc__' ? ' misc' : '');
    header.textContent = key === '__misc__' ? '기타' : key;
    groupEl.appendChild(header);

    groups.get(key).forEach(item => groupEl.appendChild(renderDecisionCard(item)));
    list.appendChild(groupEl);
  });
}

function renderDecisionCard(item) {
  const done = item.status === 'done';
  const card = document.createElement('div');
  card.className = 'card task-row' + (done ? ' done' : '');

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'checkbox';
  checkbox.checked = done;
  checkbox.setAttribute('aria-label', `${item.description} — PRD 반영함으로 표시`);
  checkbox.addEventListener('change', () =>
    fadeOutAndRun(card, () => toggleTask(item.id), done ? 'PRD 미반영으로 되돌림' : 'PRD 반영함으로 표시함')
  );

  const body = document.createElement('div');
  body.className = 'body';
  body.innerHTML = `
    <div class="top-row">
      <span class="desc sender">${escapeHtml(item.description)}</span>
      <span class="meta">${done && item.completed ? '반영: ' + relativeDate(item.completed) : item.created ? '추가: ' + relativeDate(item.created) : ''}</span>
    </div>
    <div class="badges"><span class="badge">${done ? 'PRD 반영함' : 'PRD 미반영'}</span></div>
    ${item.permalink ? `<a class="link channel" href="${escapeAttr(item.permalink)}" target="_blank" rel="noopener">슬랙 원문</a>` : ''}
  `;
  if (!done) makeEditableDesc(body.querySelector('.desc'), item);
  body.prepend(renderGroupControl({
    jira: item.jira,
    group: item.group,
    onSetJira: (key) => setTaskJira(item.id, key),
    onSetGroup: (g) => setTaskGroup(item.id, g),
  }));
  if (item.isNew && !done) { card.appendChild(renderNewDot(item)); observeNewItem(card, item); }

  if (!done) {
    card.appendChild(renderOverflowMenu([
      {
        label: '삭제',
        danger: true,
        onClick: () => {
          fadeOutAndRun(card, async () => {
            await request('/api/track/remove', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: item.id }),
            });
            load();
          }, '삭제함');
        },
      },
    ]));
  }

  card.appendChild(checkbox);
  card.appendChild(body);
  return card;
}

const STALE_WAITING_DAYS = 3;

function offerDecisionFromWaiting(item) {
  showNotice('확인 완료로 표시함', false, null, {
    label: '결정으로 남기기',
    onClick: async (button) => {
      button.disabled = true;
      try {
        const response = await postJson('/api/decision/create', { description: item.description, jira: item.jira, group: item.group, permalink: item.permalink });
        const { id } = await response.json();
        pushUndo({
          label: `${item.description} (결정으로 남기기)`,
          undo: () => postJson('/api/track/remove', { id }),
          redo: () => postJson('/api/track/restore', { id }),
        });
        await load();
        announce('정책/얼라인에 남겼습니다. 아이디어·결정 탭에서 내용을 다듬을 수 있어요.');
      } catch { button.disabled = false; }
    },
  });
}

function renderWaiting(items) {
  document.getElementById('waitingCount').textContent = items.length;
  document.getElementById('waitingSectionCount').textContent = items.length;
  const list = document.getElementById('waitingList');
  list.innerHTML = '';

  if (!items.length) {
    list.innerHTML = '<div class="empty">확인 대기중 없음</div>';
    return;
  }

  const sorted = [...items].sort((a, b) => {
    if (a.due && b.due) return a.due < b.due ? -1 : a.due > b.due ? 1 : 0;
    if (a.due) return -1;
    if (b.due) return 1;
    return (a.created || '') < (b.created || '') ? -1 : (a.created || '') > (b.created || '') ? 1 : 0;
  });
  sorted.forEach(item => list.appendChild(renderWaitingCard(item)));
}

function renderWaitingCard(item) {
  const done = item.status === 'done';
  const card = document.createElement('div');
  card.className = 'card waiting' + (done ? ' done' : '');

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'checkbox';
  checkbox.checked = done;
  checkbox.setAttribute('aria-label', `${item.description} — 확인 완료로 표시`);
  checkbox.addEventListener('change', () =>
    fadeOutAndRun(card, async () => {
      await toggleTask(item.id);
      if (!done) offerDecisionFromWaiting(item);
    }, done ? '대기중으로 되돌림' : null)
  );

  const body = document.createElement('div');
  body.className = 'body';
  const badges = [];
  if (item.due) {
    const diff = diffDays(item.due);
    if (diff < 0) badges.push(`<span class="badge overdue">${-diff}일 지남</span>`);
    else if (diff > 0) badges.push(`<span class="badge due">회신 기한 ${item.due}</span>`);
    else badges.push(`<span class="badge due-today">오늘 마감</span>`);
  } else if (item.created && diffDays(item.created) <= -STALE_WAITING_DAYS) {
    badges.push(`<span class="badge stale">${-diffDays(item.created)}일째 대기</span>`);
  }
  badges.push(`<span class="badge who-badge">${item.who ? escapeHtml(item.who) : '담당자 지정'}</span>`);
  body.innerHTML = `
    <div class="top-row">
      <span class="desc sender">${escapeHtml(item.description)}</span>
      <span class="meta">${item.created ? '추가: ' + relativeDate(item.created) : ''}</span>
    </div>
    <div class="badges">${badges.join('')}</div>
    ${item.permalink ? `<a class="link channel" href="${escapeAttr(item.permalink)}" target="_blank" rel="noopener">슬랙 원문</a>` : ''}
  `;
  if (!done) {
    makeEditableDesc(body.querySelector('.desc'), item);
    makeEditableWho(body.querySelector('.who-badge'), item);
  }
  if (item.isNew) { card.appendChild(renderNewDot(item)); observeNewItem(card, item); }
  body.prepend(renderGroupControl({
    jira: item.jira,
    group: item.group,
    onSetJira: (key) => setTaskJira(item.id, key),
    onSetGroup: (g) => setTaskGroup(item.id, g),
  }));

  if (!done) {
    const dateInput = document.createElement('input');
    dateInput.type = 'date';
    dateInput.className = 'overflow-date-input';
    dateInput.value = item.due || '';
    dateInput.setAttribute('aria-label', `${item.description} — 마감일 지정`);
    dateInput.addEventListener('click', (e) => e.stopPropagation());
    dateInput.addEventListener('change', () => {
      fadeOutAndRun(card, () => setTaskDue(item.id, dateInput.value || null), dateInput.value ? `마감일 ${dateInput.value}로 지정함` : '마감일 해제함');
    });

    // "다시 확인할 날짜"(뒤이어 확인할 예정일)를 카드 맨 아래 따로 두면 "마감일"과 뭐가
    // 다른 건지 헷갈린다 — 같은 ⋮ 메뉴 안에 나란히 두면 둘 다 "날짜 관련 설정"으로 읽힌다.
    const follow = wfItem(item.id)?.followUp;
    card.appendChild(renderOverflowMenu([
      { custom: overflowField('마감일', dateInput) },
      {
        label: follow ? `다시 확인할 날짜 · ${follow}` : '다시 확인할 날짜 지정',
        onClick: () => wfOpen({ kind: 'item', id: item.id }),
      },
      { separator: true },
      {
        label: '삭제',
        danger: true,
        onClick: () => {
          fadeOutAndRun(card, async () => {
    await request('/api/track/remove', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: item.id }),
            });
            load();
          }, '삭제함');
        },
      },
    ]));
  }

  card.appendChild(checkbox);
  card.appendChild(body);
  return card;
}

function renderLaterTasks(items) {
  document.getElementById('laterTaskSectionCount').textContent = items.length;
  const laterZone = document.getElementById('laterTaskZone');
  if (!laterZone.dataset.initialized) {
    laterZone.open = items.length > 0;
    laterZone.dataset.initialized = 'true';
  }
  const list = document.getElementById('laterTaskList');
  list.innerHTML = '';
  if (!items.length) {
    list.innerHTML = '<div class="empty">나중에 할 일 없음</div>';
    return;
  }

  const groups = new Map();
  items.forEach(item => {
    const key = item.jira ? `jira:${item.jira}` : item.group ? `group:${item.group}` : '__misc__';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  });
  const namedKeys = [...groups.keys()].filter(k => k !== '__misc__').sort();
  const orderedKeys = groups.has('__misc__') ? [...namedKeys, '__misc__'] : namedKeys;

  orderedKeys.forEach(key => {
    const groupEl = document.createElement('div');
    groupEl.className = 'today-group';

    const header = document.createElement('div');
    header.className = 'today-group-header' + (key === '__misc__' ? ' misc' : '');
    if (key === '__misc__') {
      header.textContent = '기타';
    } else if (key.startsWith('jira:')) {
      const jiraKey = key.slice(5);
      const issue = jiraIssuesCache.find(i => i.key === jiraKey);
      header.textContent = issue ? `${jiraKey} · ${issue.summary}` : jiraKey;
    } else {
      header.textContent = key.slice(6);
    }
    groupEl.appendChild(header);

    const sorted = [...groups.get(key)].sort((a, b) => {
      if (a.due && b.due) return a.due < b.due ? -1 : a.due > b.due ? 1 : 0;
      if (a.due) return -1;
      if (b.due) return 1;
      return 0;
    });
    sorted.forEach(item => groupEl.appendChild(renderTaskCard(item, { mode: 'later', grouped: key !== '__misc__' })));
    groupEl.appendChild(renderGroupAddInput(key, '/api/later-task/create', '나중에 할 일 추가함'));
    list.appendChild(groupEl);
  });
}

const TASK_PRIORITY_LABELS = { low: '우선순위 낮음', medium: '우선순위 보통', high: '우선순위 높음', critical: '긴급' };
const TASK_PRIORITY_ORDER = ['low', 'medium', 'high', 'critical'];

function compareTasks(a, b) {
  const rank = { critical: 0, high: 1, medium: 2, low: 3 };
  return (rank[a.priority] ?? 2) - (rank[b.priority] ?? 2) || (a.due || '9999').localeCompare(b.due || '9999');
}

function renderPriorityBadge(item, config) {
  const labels = (config && config.labels) || TASK_PRIORITY_LABELS;
  const order = (config && config.order) || TASK_PRIORITY_ORDER;
  const select = document.createElement('select');
  select.className = `badge priority-${item.priority} priority-select`;
  select.setAttribute('aria-label', `${item.description} — 우선순위 선택`);
  order.forEach((key) => {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = labels[key] || key;
    if (key === item.priority) opt.selected = true;
    select.appendChild(opt);
  });
  select.addEventListener('change', async () => {
    select.disabled = true;
    try {
      await setPriority(item.id, select.value);
      await load();
    } catch { select.value = item.priority; }
    finally { select.disabled = false; }
  });
  return select;
}

// 마감·예정·진행 상태를 배지 HTML 목록으로 만든다.
function taskBadges(item, mode, done, carried) {
  const badges = [];
  if (item.due) {
    const diff = diffDays(item.due);
    if (diff < 0) badges.push(`<span class="badge overdue">${-diff}일 지남</span>`);
    else if (diff > 0) badges.push(`<span class="badge due">마감 ${item.due}</span>`);
    else badges.push('<span class="badge due-today">오늘 마감</span>');
  }
  if (item.scheduled && mode === 'later') badges.push(`<span class="badge">실행 예정 ${escapeHtml(item.scheduled)}</span>`);
  if (carried) badges.push(`<span class="badge stale plan-only">${escapeHtml(relativeDate(item.scheduled))}부터</span>`);
  if (item.doing && !done) {
    const days = -diffDays(item.doing) + 1;
    badges.push(`<span class="badge doing">${days > 1 ? `${days}일째 진행 중` : '진행 중'}</span>`);
  }
  return badges;
}

// 그룹은 제목 위에 얹는 라벨로 — 무슨 일인지 읽기 전에 어느 건인지 먼저 잡히도록.
// 프로젝트별 보기처럼 위 헤더가 이미 알려주는 곳에서는 생략한다.
function taskEyebrow(item, grouped) {
  if (grouped) return '';
  const issue = item.jira ? jiraIssuesCache.find(i => i.key === item.jira) : null;
  const projectLabel = item.jira ? (issue ? `${item.jira} · ${issue.summary}` : item.jira) : item.group;
  return projectLabel ? `<div class="card-eyebrow" title="${escapeAttr(projectLabel)}">${escapeHtml(projectLabel)}</div>` : '';
}

function taskCompletionCheckbox(item, card, done) {
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'checkbox';
  checkbox.checked = done;
  checkbox.setAttribute('aria-label', `${item.description} — 완료로 표시`);
  checkbox.addEventListener('change', () =>
    fadeOutAndRun(card, async () => { await toggleTask(item.id); if (!done) workflowOutcome(item); }, done ? '미완료로 되돌림' : null)
  );
  return checkbox;
}

// 더보기 메뉴 구성: 동작 → 속성 → 삭제. 자주 쓰는 동작이 위, 값 바꾸는 것들은 라벨 달아 아래로.
function taskMenuActions({ item, mode, card, groupControl, priorityControl, showPriority }) {
  const makeDateInput = (scheduled = false) => {
    const dateInput = document.createElement('input');
    dateInput.type = 'date';
    dateInput.className = 'overflow-date-input';
    dateInput.value = (scheduled ? item.scheduled : item.due) || '';
    dateInput.setAttribute('aria-label', `${item.description} — ${scheduled ? '실행 예정일' : '마감일 지정'}`);
    dateInput.addEventListener('click', (e) => e.stopPropagation());
    dateInput.addEventListener('change', () => {
      fadeOutAndRun(card, () => scheduled ? setTaskScheduled(item.id, dateInput.value || null) : setTaskDue(item.id, dateInput.value || null), scheduled ? '실행 예정일을 변경했습니다.' : '마감일을 변경했습니다.');
    });
    return { custom: overflowField(scheduled ? '실행 예정일' : '마감일', dateInput) };
  };

  const actions = [];

  actions.push({
    label: item.doing ? '진행 중 해제' : '지금 하는 중',
    onClick: () => setTaskDoing(item.id, !item.doing),
  });
  if (mode === 'today') {
    actions.push({ label: '나중으로 미루기', onClick: () =>
      fadeOutAndRun(card, () => setTaskScheduled(item.id, null), '나중에 할 일로 옮김 · 마감일은 유지됩니다.') });
  } else {
    actions.push({ label: '진행완료로 표시', onClick: () =>
      fadeOutAndRun(card, () => toggleTask(item.id), '완료로 표시함') });
    actions.push({ label: '오늘로 가져오기', onClick: () =>
      fadeOutAndRun(card, () => setTaskScheduled(item.id, todayStr()), '오늘 할 일로 옮김') });
    actions.push({
      label: item.scheduled === tomorrowStr() ? '내일 예약됨 ✓' : '내일로 예약',
      onClick: () => fadeOutAndRun(card, () => setTaskScheduled(item.id, tomorrowStr()), '내일 할 일로 예약함'),
    });
  }

  actions.push({ separator: true });
  actions.push({ custom: overflowField('그룹', groupControl) });
  if (!showPriority) actions.push({ custom: overflowField('우선순위', priorityControl) });
  actions.push(makeDateInput(true));
  actions.push(makeDateInput());

  actions.push({ separator: true });
  actions.push({
    label: '삭제',
    danger: true,
    onClick: () => {
      fadeOutAndRun(card, async () => {
        await request('/api/track/remove', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: item.id }),
        });
        load();
      }, '삭제함');
    },
  });
  return actions;
}

// 계획·정리 모드에서만 보이는 "내일 / 나중으로" 같은 이동 버튼 줄.
function taskPlanActions({ item, mode, card, carried }) {
  const planMoves = mode === 'later'
    ? [{ label: '오늘로', scheduled: todayStr(), message: '오늘 할 일로 옮김' }]
    : [
        carried
          ? { label: '오늘 할게요', scheduled: todayStr(), message: '오늘 할 일로 확정함' }
          : { label: '내일', scheduled: tomorrowStr(), message: '내일로 미룸' },
        { label: '나중으로', scheduled: null, message: '나중에 할 일로 옮김' },
      ];
  const planActions = document.createElement('div');
  planActions.className = 'plan-actions plan-only';
  planMoves.forEach(({ label, scheduled, message }) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'convert-btn';
    button.textContent = label;
    button.setAttribute('aria-label', `${item.description} — ${label}`);
    button.addEventListener('click', async () => {
      button.disabled = true;
      await fadeOutAndRun(card, () => setTaskScheduled(item.id, scheduled), message);
      button.disabled = false;
    });
    planActions.appendChild(button);
  });
  return planActions;
}

function renderTaskCard(item, opts) {
  const mode = (opts && opts.mode) || 'today';
  // grouped: 위 헤더가 이미 프로젝트를 알려주고 있는지. 아니면 카드가 직접 보여준다.
  const grouped = !!(opts && opts.grouped);
  const done = item.status === 'done';
  const card = document.createElement('div');
  card.className = 'card task-row' + (done ? ' done' : '');
  card.dataset.taskId = item.id;

  let checkbox = null;
  if (taskSelectionMode && !done) {
    checkbox = taskSelectionCheckbox(item, card);
  } else if (mode === 'today') {
    checkbox = taskCompletionCheckbox(item, card, done);
  }

  const body = document.createElement('div');
  body.className = 'body';
  const carried = mode === 'today' && !done && item.scheduled && item.scheduled < todayStr();
  const badges = taskBadges(item, mode, done, carried);
  body.innerHTML = `
    ${taskEyebrow(item, grouped)}
    <div class="top-row">
      <span class="desc sender">${escapeHtml(item.description)}</span>
      <span class="meta">${item.created ? '추가: ' + relativeDate(item.created) : ''}</span>
    </div>
    <div class="badges">${badges.join('')}</div>
    ${item.permalink ? `<a class="link channel" href="${escapeAttr(item.permalink)}" target="_blank" rel="noopener">슬랙 원문</a>` : ''}
  `;
  const priorityControl = renderPriorityBadge(item);
  const showPriority = ['high', 'critical'].includes(item.priority);
  body.querySelector('.badges').insertAdjacentHTML('beforeend', workflowTaskBadges(item));
  if (showPriority) body.querySelector('.badges').appendChild(priorityControl);
  body.classList.add('task-openable');
  body.tabIndex = 0;
  body.setAttribute('role', 'button');
  body.setAttribute('aria-label', `${item.description} 상세 보기`);
  const open = () => {
    if (taskSelectionMode) { if (!done && !taskBatchBusy) checkbox.click(); return; }
    openTaskDetail(item, mode);
  };
  if (taskSelectionMode && !done) body.setAttribute('aria-label', `${item.description} 선택`);
  body.addEventListener('click', (e) => {
    if (e.target.closest('button,select,input,a,.overflow-menu,.group-add')) return;
    open();
  });
  body.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && !e.target.closest('input,select,button,a')) { e.preventDefault(); open(); }
  });
  // 할 일은 "새로 들어온 것"에서 분류를 거쳐야 여기 오므로, 이미 본 항목이다 (NEW 표시 불필요)
  const groupControl = renderGroupControl({
    jira: item.jira,
    group: item.group,
    onSetJira: (key) => setTaskJira(item.id, key),
    onSetGroup: (g) => setTaskGroup(item.id, g),
  });

  if (!done) {
    card.appendChild(renderOverflowMenu(taskMenuActions({ item, mode, card, groupControl, priorityControl, showPriority })));
    body.appendChild(taskPlanActions({ item, mode, card, carried }));
  }

  if (checkbox) card.appendChild(checkbox);
  card.appendChild(body);
  return card;
}

function closeTaskDetail() {
  selectedTaskId = null;
  meetingPanel = null;
  const zone = document.getElementById('todayTaskZone');
  const panel = document.getElementById('taskDetailPanel');
  if (zone) zone.classList.remove('task-detail-open');
  document.querySelectorAll('.task-row.is-selected').forEach(row => row.classList.remove('is-selected'));
  if (panel) { panel.hidden = true; panel.innerHTML = ''; }
}

// ---------- 회의 정리 ----------
// 회의가 끝나면 할 일 말고도 정해진 것·확인 대기가 같이 나온다.
// 종류만 바꿔가며 연달아 적을 수 있게, 할 일 상세와 같은 자리에 띄운다.

let meetingPanel = null;

const MEETING_CAPTURE_TYPES = [
  { key: 'task', label: '할 일', endpoint: '/api/today-task/create', done: '할 일로 담음' },
  { key: 'decision', label: '정해진 것', endpoint: '/api/decision/create', done: '정책/얼라인으로 담음' },
  { key: 'check', label: '확인 대기', endpoint: '/api/waiting/create', done: '확인 대기로 담음' },
];

function openMeetingPanel(event) {
  const recorded = workflowData.meetings.find(meeting => meeting.date === todayStr() && meeting.start === event.start && meeting.title === event.title);
  if (recorded) { wfOpen({ kind: 'meeting', id: recorded.id }); return; }
  selectedTaskId = null;
  document.querySelectorAll('.task-row.is-selected').forEach(row => row.classList.remove('is-selected'));
  meetingPanel = { event, project: event.project || null, type: 'task', added: [] };
  renderMeetingPanel();
}

function renderMeetingPanel() {
  if (!meetingPanel) return;
  const zone = document.getElementById('todayTaskZone');
  const panel = document.getElementById('taskDetailPanel');
  if (!zone || !panel) return;
  const { event, project, added } = meetingPanel;

  zone.classList.add('task-detail-open');
  panel.hidden = false;
  panel.innerHTML = `
    <button type="button" class="task-detail-close" aria-label="회의 정리 닫기">×</button>
    <h3>회의 정리</h3>
    <div class="meeting-panel-title">${escapeHtml(event.title)}</div>
    <div class="meeting-panel-time">${event.start}–${event.end}</div>
  `;
  panel.querySelector('.task-detail-close').addEventListener('click', closeTaskDetail);

  // 담을 프로젝트 — 기본값은 미팅에 연결된 것. 한 회의에서 두 프로젝트를 다룰 때만 바꾼다.
  const projectField = document.createElement('div');
  projectField.className = 'detail-field';
  const projectLabel = document.createElement('label');
  projectLabel.textContent = '담을 프로젝트';
  projectField.appendChild(projectLabel);
  projectField.appendChild(renderGroupControl({
    jira: project && project.type === 'jira' ? project.value : null,
    group: project && project.type === 'group' ? project.value : null,
    onSetJira: async (key) => {
      meetingPanel.project = key ? { type: 'jira', value: key } : null;
      renderMeetingPanel();
    },
    onSetGroup: async (value) => {
      meetingPanel.project = value ? { type: 'group', value } : null;
      renderMeetingPanel();
    },
  }));
  panel.appendChild(projectField);

  const row = document.createElement('div');
  row.className = 'meeting-capture-row';
  const typeSelect = document.createElement('select');
  typeSelect.className = 'meeting-type-select';
  typeSelect.setAttribute('aria-label', '담을 종류');
  typeSelect.innerHTML = MEETING_CAPTURE_TYPES
    .map(t => `<option value="${t.key}"${t.key === meetingPanel.type ? ' selected' : ''}>${t.label}</option>`)
    .join('');
  typeSelect.addEventListener('change', () => { meetingPanel.type = typeSelect.value; });

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'meeting-capture-input';
  input.placeholder = '적고 Enter';
  input.setAttribute('aria-label', '회의에서 나온 내용');
  input.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    const description = input.value.trim();
    if (!description) return;
    const type = MEETING_CAPTURE_TYPES.find(t => t.key === typeSelect.value);
    const body = { description };
    if (meetingPanel.project) body[meetingPanel.project.type] = meetingPanel.project.value;
    input.disabled = true;
    const result = await request(type.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(r => r.json()).catch(() => null);
    input.disabled = false;
    if (!result || !result.ok) { input.focus(); return; }
    meetingPanel.type = typeSelect.value;
    meetingPanel.added.unshift({ id: result.id, type, description, project: meetingPanel.project });
    announce(type.done);
    renderMeetingPanel();
    load();
  });

  row.append(typeSelect, input);
  panel.appendChild(row);

  if (added.length) {
    const list = document.createElement('div');
    list.className = 'meeting-added';
    const heading = document.createElement('div');
    heading.className = 'meeting-added-heading';
    heading.textContent = `방금 담은 것 ${added.length}`;
    list.appendChild(heading);

    added.forEach((entry) => {
      const el = document.createElement('div');
      el.className = 'meeting-added-row';
      el.innerHTML = `
        <span class="meeting-added-type">${escapeHtml(entry.type.label)}</span>
        <span class="meeting-added-desc">${escapeHtml(entry.description)}</span>
      `;
      const undo = document.createElement('button');
      undo.type = 'button';
      undo.className = 'meeting-added-undo';
      undo.textContent = '×';
      undo.setAttribute('aria-label', `${entry.description} 취소`);
      undo.addEventListener('click', async () => {
        undo.disabled = true;
        await request('/api/track/remove', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: entry.id }),
        });
        // 목록이 다시 그려져도 엉뚱한 줄이 지워지지 않도록 위치가 아니라 id로 찾아 뺀다
        meetingPanel.added = meetingPanel.added.filter(x => x.id !== entry.id);
        announce('취소했습니다.');
        renderMeetingPanel();
        load();
      });
      el.appendChild(undo);
      list.appendChild(el);
    });
    panel.appendChild(list);
  }

  panel.querySelector('.meeting-capture-input').focus();
}

function syncTaskDetail(items) {
  if (!selectedTaskId) return;
  const item = items.find(entry => entry.id === selectedTaskId);
  if (item) renderTaskDetail(item);
  else closeTaskDetail();
}

function renderTaskDetail(item) {
  const zone = document.getElementById('todayTaskZone');
  const panel = document.getElementById('taskDetailPanel');
  if (!zone || !panel) return;
  zone.classList.add('task-detail-open');
  panel.hidden = false;
  panel.innerHTML = '';
  const close = document.createElement('button');
  close.type = 'button'; close.className = 'task-detail-close'; close.textContent = '×'; close.setAttribute('aria-label', '상세 닫기');
  close.addEventListener('click', closeTaskDetail);
  panel.appendChild(close);
  const heading = document.createElement('h3'); heading.textContent = '업무 상세'; panel.appendChild(heading);
  taskCoreFields(item, panel);
  const saveWorkflowFields = workflowFields({ ...item, type: 'task' }, panel);
  if (item.permalink) { const link = document.createElement('a'); link.className = 'channel'; link.href = item.permalink; link.target = '_blank'; link.rel = 'noopener'; link.textContent = '슬랙 원문 열기'; panel.appendChild(link); }
  const actions = document.createElement('div'); actions.className = 'detail-actions';
  const action = (text, fn, danger = false) => { const button = document.createElement('button'); button.type = 'button'; button.className = 'detail-action' + (danger ? ' danger' : ''); button.textContent = text; button.addEventListener('click', fn); actions.appendChild(button); };
  action(item.status === 'done' ? '미완료로 되돌리기' : '완료로 표시', async () => { await saveWorkflowFields(); await toggleTask(item.id); closeTaskDetail(); if (item.status !== 'done') workflowOutcome(item); });
  action(selectedTaskMode === 'today' ? '나중으로 미루기' : '오늘로 가져오기', async () => { await setTaskScheduled(item.id, selectedTaskMode === 'today' ? null : todayStr()); closeTaskDetail(); });
  action('삭제', async () => { await request('/api/track/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: item.id }) }); closeTaskDetail(); await load(); }, true);
  panel.appendChild(actions);
}

function openTaskDetail(item, mode = 'today') {
  selectedTaskId = item.id;
  selectedTaskMode = mode;
  document.querySelectorAll('.task-row.is-selected').forEach(row => row.classList.remove('is-selected'));
  document.querySelectorAll(`.task-row[data-task-id="${CSS.escape(String(item.id))}"]`).forEach(row => row.classList.add('is-selected'));
  renderTaskDetail(item);
}

// 슬랙에서 갓 들어온 할 일. 오늘 할지 나중에 할지는 여기서 직접 고른다.
// 비어 있으면 섹션 자체를 숨겨서, 처리할 게 있을 때만 눈에 띄게 한다.
function renderInbox(items) {
  const zone = document.getElementById('inboxZone');
  const list = document.getElementById('inboxList');
  document.getElementById('inboxCount').textContent = items.length;
  zone.hidden = items.length === 0;
  list.innerHTML = '';
  if (!items.length) return;

  items.forEach(item => {
    const card = document.createElement('div');
    card.className = 'card inbox-card';

    const body = document.createElement('div');
    body.className = 'body';
    const badges = [];
    if (item.due) badges.push(`<span class="badge due">마감 ${escapeHtml(item.due)}</span>`);
    // 그룹은 아래 컨트롤이 보여주므로 여기서 또 적지 않는다
    body.innerHTML = `
      <div class="top-row">
        <span class="desc sender">${escapeHtml(item.description)}</span>
      </div>
      ${badges.length ? `<div class="badges">${badges.join('')}</div>` : ''}
      ${item.permalink ? `<a class="link channel" href="${escapeAttr(item.permalink)}" target="_blank" rel="noopener">슬랙 원문</a>` : ''}
    `;
    makeEditableDesc(body.querySelector('.desc'), item);
    // 분류하면서 어느 프로젝트 건인지도 같이 정할 수 있게 한다
    body.prepend(renderGroupControl({
      jira: item.jira,
      group: item.group,
      onSetJira: (key) => setTaskJira(item.id, key),
      onSetGroup: (g) => setTaskGroup(item.id, g),
    }));
    card.appendChild(body);

    // 아직 분류 전이라도 마감이 분명한 건은 미리 지정해둘 수 있어야 한다(예: 오늘/나중에 정하기 전에도).
    const dueInput = document.createElement('input');
    dueInput.type = 'date';
    dueInput.className = 'overflow-date-input';
    dueInput.value = item.due || '';
    dueInput.setAttribute('aria-label', `${item.description} — 마감일 지정`);
    dueInput.addEventListener('click', (e) => e.stopPropagation());
    dueInput.addEventListener('change', async () => {
      await setTaskDue(item.id, dueInput.value || null);
      announce(dueInput.value ? `마감일 ${dueInput.value}로 지정함` : '마감일 해제함');
    });
    card.appendChild(renderOverflowMenu([
      { custom: overflowField('마감일', dueInput) },
    ]));

    const actions = document.createElement('div');
    actions.className = 'inbox-actions';

    const choose = (label, onClick, cls = '') => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `inbox-btn ${cls}`.trim();
      b.textContent = label;
      b.addEventListener('click', onClick);
      actions.appendChild(b);
    };

    // 앞으로 할 것 — 분류
    choose('오늘', () => fadeOutAndRun(card, () => setTaskScheduled(item.id, todayStr()), '오늘 할 일로 옮김'));
    choose('나중에', () => fadeOutAndRun(card, () => setTaskScheduled(item.id, null), '나중에 할 일로 옮김'));
    // 이미 끝난 것 — 종결. 완료는 기록이 남고(주간요약에 들어감), 삭제는 남지 않는다
    choose('완료', () => fadeOutAndRun(card, () => toggleTask(item.id), '완료로 표시함'), 'quiet');
    choose('삭제', () => {
      fadeOutAndRun(card, async () => {
        await request('/api/track/remove', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: item.id }),
        });
        load();
      }, '삭제함');
    }, 'danger');

    card.appendChild(actions);
    list.appendChild(card);
  });
}

function renderTodayTasks(items) {
  document.getElementById('todayTaskCount').textContent = items.filter(item => item.status !== 'done').length;
  document.getElementById('todayDoneSummary').textContent = `완료 ${items.filter(item => item.status === 'done').length}`;
  const list = document.getElementById('todayTaskList');
  list.innerHTML = '';
  if (!items.length) { list.innerHTML = '<div class="empty">오늘 예정된 할 일이 없습니다.</div>'; return; }

  const doing = items.filter(i => i.status !== 'done' && i.doing);
  // 진행 중인 건 프로젝트/우선순위와 무관하게 항상 맨 위에 따로 모은다
  const active = items.filter(i => i.status !== 'done' && !i.doing);
  const doneItems = items.filter(i => i.status === 'done');

  if (doing.length) {
    const doingEl = document.createElement('div');
    doingEl.className = 'today-group today-doing-group';
    const header = document.createElement('div');
    header.className = 'today-group-header';
    header.textContent = `진행 중 ${doing.length}`;
    doingEl.appendChild(header);
    [...doing].sort(compareTasks).forEach(item => doingEl.appendChild(renderTaskCard(item, { grouped: false })));
    list.appendChild(doingEl);
  }

  if (todaySort === 'priority') {
    const priorityGroup = document.createElement('div');
    priorityGroup.className = 'today-group';
    const priorityHeader = document.createElement('div');
    priorityHeader.className = 'today-group-header';
    priorityHeader.textContent = '마감·중요도순';
    priorityGroup.appendChild(priorityHeader);
    [...active].sort(compareTasks).forEach(item => priorityGroup.appendChild(renderTaskCard(item, { grouped: false })));
    list.appendChild(priorityGroup);
  }

  const groups = new Map();
  if (todaySort === 'priority') {
    // Priority mode uses one flat list; project headers would defeat the scan order.
    groups.clear();
  }
  if (todaySort !== 'priority') active.forEach(item => {
    const key = item.jira ? `jira:${item.jira}` : item.group ? `group:${item.group}` : '__misc__';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  });
  const namedKeys = [...groups.keys()].filter(k => k !== '__misc__').sort();
  const orderedKeys = groups.has('__misc__') ? [...namedKeys, '__misc__'] : namedKeys;

  if (todaySort !== 'priority') orderedKeys.forEach(key => {
    const groupEl = document.createElement('div');
    groupEl.className = 'today-group';

    const header = document.createElement('div');
    header.className = 'today-group-header' + (key === '__misc__' ? ' misc' : '');
    if (key === '__misc__') {
      header.textContent = '기타';
    } else if (key.startsWith('jira:')) {
      const jiraKey = key.slice(5);
      const issue = jiraIssuesCache.find(i => i.key === jiraKey);
      header.textContent = issue ? `${jiraKey} · ${issue.summary}` : jiraKey;
    } else {
      header.textContent = key.slice(6);
    }
    groupEl.appendChild(header);

    if (key !== '__misc__') {
      const projectButton = wfButton(header.textContent, () => wfOpen({ kind: 'project', key }), 'wf-project-entry');
      header.replaceChildren(projectButton);
    }
    groups.get(key).sort(compareTasks).forEach(item => groupEl.appendChild(renderTaskCard(item, { grouped: key !== '__misc__' })));
    groupEl.appendChild(renderGroupAddInput(key, '/api/today-task/create', '오늘 할 일 추가함'));
    list.appendChild(groupEl);
  });

  if (doneItems.length) {
    const doneEl = document.createElement('div');
    doneEl.className = 'today-group today-done-group';
    const header = document.createElement('div');
    header.className = 'today-group-header misc';
    header.textContent = `완료 ${doneItems.length}`;
    doneEl.appendChild(header);
    doneItems.forEach(item => doneEl.appendChild(renderTaskCard(item)));
    list.appendChild(doneEl);
  }
}

function renderGroupAddInput(key, endpoint, announceText) {
  const wrapper = document.createElement('details');
  wrapper.className = 'group-add';
  wrapper.dataset.addKey = `${endpoint}::${key}`;
  const summary = document.createElement('summary');
  summary.textContent = '+ 이 그룹에 추가';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'wr-add-input';
  input.placeholder = '이 그룹에 추가…';
  input.setAttribute('aria-label', `${key === '__misc__' ? '기타' : key.slice(key.indexOf(':') + 1)} 그룹에 할 일 추가`);
  input.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter' || e.isComposing || input.disabled) return;
    const description = input.value.trim();
    if (!description) return;
    input.disabled = true;
    const payload = { description };
    if (key.startsWith('jira:')) payload.jira = key.slice(5);
    else if (key.startsWith('group:')) payload.group = key.slice(6);
    try {
      await request(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      input.value = '';
      announce(announceText);
      await load();
      // load()가 목록을 다시 그려서 이 input은 떨어져 나간다 — 같은 그룹의 새 input을 찾아 다시 연다.
      const reopened = document.querySelector(`.group-add[data-add-key="${CSS.escape(wrapper.dataset.addKey)}"] .wr-add-input`);
      if (reopened) { reopened.closest('details').open = true; reopened.focus(); }
    } catch { /* Keep the draft for retry. */ }
    finally { input.disabled = false; if (input.isConnected) input.focus(); }
  });
  wrapper.append(summary, input);
  wrapper.addEventListener('toggle', () => { if (wrapper.open) input.focus(); });
  return wrapper;
}

function renderIdeas(items) {
  document.getElementById('ideaCount').textContent = items.length;
  const list = document.getElementById('ideaList');
  list.innerHTML = '';
  if (!items.length) return;

  const groups = new Map();
  items.forEach(item => {
    const key = item.project || '__misc__';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  });
  const projectKeys = [...groups.keys()].filter(k => k !== '__misc__').sort();
  const orderedKeys = groups.has('__misc__') ? [...projectKeys, '__misc__'] : projectKeys;

  orderedKeys.forEach(key => {
    const groupEl = document.createElement('div');
    groupEl.className = 'today-group';

    const header = document.createElement('div');
    header.className = 'today-group-header' + (key === '__misc__' ? ' misc' : '');
    header.textContent = key === '__misc__' ? '기타' : key;
    groupEl.appendChild(header);

    groups.get(key).forEach(item => groupEl.appendChild(renderIdeaCard(item)));
    list.appendChild(groupEl);
  });
}

function renderIdeaCard(item) {
  const done = item.status === 'done';
  const card = document.createElement('div');
  card.className = 'card' + (done ? ' done' : '');

  const body = document.createElement('div');
  body.className = 'body';
  body.innerHTML = `<div class="top-row"><span class="desc sender">${escapeHtml(item.description)}</span></div>`;
  body.prepend(renderIdeaGroupControl(item));

  if (item.isNew) { card.appendChild(renderNewDot(item)); observeNewItem(card, item); }

  const badges = document.createElement('div');
  badges.className = 'badges';
  badges.appendChild(renderPriorityBadge(item, {
    labels: { low: '가능성 낮음', medium: '가능성 보통', high: '가능성 높음' },
    order: ['low', 'medium', 'high'],
  }));
  body.appendChild(badges);

  if (!done) {
    const promote = async (due) => {
      await request('/api/idea/promote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id, due }),
      });
      load();
    };

    const dateInput = document.createElement('input');
    dateInput.type = 'date';
    dateInput.className = 'overflow-date-input';
    dateInput.setAttribute('aria-label', `${item.description} — 일정 정해서 할 일로 옮기기`);
    dateInput.addEventListener('click', (e) => e.stopPropagation());
    dateInput.addEventListener('change', () => {
      if (!dateInput.value) return;
      fadeOutAndRun(card, () => promote(dateInput.value), '할 일로 옮김');
    });
    card.appendChild(renderOverflowMenu([
      { label: '오늘로 옮기기', onClick: () => fadeOutAndRun(card, () => promote(todayStr()), '오늘 할 일로 옮김') },
      { label: '진행완료로 표시', onClick: () => fadeOutAndRun(card, () => toggleTask(item.id), '완료로 표시함') },
      { separator: true },
      { custom: overflowField('날짜 정해서 옮기기', dateInput) },
      { separator: true },
      {
        label: '삭제',
        danger: true,
        onClick: () => {
          fadeOutAndRun(card, async () => {
            await request('/api/track/remove', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: item.id }),
            });
            load();
          }, '삭제함');
        },
      },
    ]));
  }

  card.appendChild(body);
  return card;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;');
}

function makeEditableDesc(el, item) {
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  el.setAttribute('aria-label', `${item.description} — 수정`);
  el.title = '클릭 또는 Enter로 수정';
  el.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); el.click(); }
  });
  el.classList.add('desc-editable');
  el.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'desc-edit-input';
    input.value = item.description;
    input.setAttribute('aria-label', `${item.description} — 내용 수정`);
    el.replaceWith(input);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    let committed = false;
    const commit = async () => {
      if (committed) return;
      committed = true;
      const val = input.value.trim();
      if (val && val !== item.description) {
        input.disabled = true;
        try {
          await request('/api/track/set-description', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: item.id, description: val }),
          });
          announce('내용 수정함');
          await load();
        } catch { committed = false; }
        finally { input.disabled = false; }
      } else {
        input.replaceWith(el);
      }
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') { committed = true; input.replaceWith(el); }
    });
  });
}

function makeEditableWho(el, item) {
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  el.setAttribute('aria-label', `${item.description} — 담당자 수정`);
  el.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); el.click(); }
  });
  el.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'who-edit-input';
    input.value = item.who || '';
    input.placeholder = '담당자 이름';
    input.setAttribute('aria-label', '담당자 이름');
    el.replaceWith(input);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    let committed = false;
    const commit = async () => {
      if (committed) return;
      committed = true;
      const val = input.value.trim();
      if (val !== (item.who || '')) {
        input.disabled = true;
        try {
          await request('/api/track/set-who', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: item.id, who: val || null }),
          });
          announce(val ? '담당자 수정함' : '담당자 해제함');
          await load();
        } catch { committed = false; }
        finally { input.disabled = false; }
      } else {
        input.replaceWith(el);
      }
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') { committed = true; input.replaceWith(el); }
    });
  });
}

// "NEW"는 이제 누르는 버튼이 아니라 그냥 표시다 — 화면에 잠깐이라도 실제로 보이면
// 조용히 알아서 사라진다(아래 observeNewItem). 액션을 안 해도, 그냥 훑어보기만 해도 없어진다.
function renderNewDot(item) {
  const dot = document.createElement('span');
  dot.className = 'new-dot';
  dot.innerHTML = `<span class="sr-only">${escapeHtml(item.description)} — 새로 들어옴</span>`;
  return dot;
}

// 카드가 화면에 실제로 보이는 동안(스쳐 지나가는 스크롤 말고) 일정 시간 머물면
// "확인함"으로 조용히 저장한다. 다시 그려질 때마다(load()) 카드가 새로 만들어지니
// 관찰자 하나를 계속 재사용하고, 타이머는 카드별로 관리한다.
let newItemObserver = null;
const newItemTimers = new Map();
function getNewItemObserver() {
  if (newItemObserver) return newItemObserver;
  newItemObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      const id = entry.target.dataset.newItemId;
      if (!id) return;
      if (entry.isIntersecting) {
        if (newItemTimers.has(id)) return;
        newItemTimers.set(id, setTimeout(async () => {
          newItemTimers.delete(id);
          newItemObserver.unobserve(entry.target);
          try {
            await request('/api/track/seen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
            const dot = entry.target.querySelector('.new-dot');
            if (dot) dot.remove();
          } catch {}
        }, 1500));
      } else if (newItemTimers.has(id)) {
        clearTimeout(newItemTimers.get(id));
        newItemTimers.delete(id);
      }
    });
  }, { threshold: 0.6 });
  return newItemObserver;
}

function observeNewItem(card, item) {
  card.dataset.newItemId = item.id;
  getNewItemObserver().observe(card);
}

// 더보기 메뉴 안에서 값을 바꾸는 항목은 무엇을 바꾸는지 라벨을 달아준다
function overflowField(labelText, control) {
  const wrap = document.createElement('div');
  wrap.className = 'overflow-field';
  const label = document.createElement('div');
  label.className = 'overflow-field-label';
  label.textContent = labelText;
  wrap.append(label, control);
  return wrap;
}

function renderOverflowMenu(actions) {
  const wrap = document.createElement('div');
  wrap.className = 'overflow-menu';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'overflow-btn';
  btn.textContent = '⋮';
  btn.setAttribute('aria-label', '더보기');
  btn.setAttribute('aria-expanded', 'false');

  const menu = document.createElement('div');
  menu.className = 'overflow-list';
  menu.hidden = true;
  menu.addEventListener('click', event => event.stopPropagation());
  wrap.addEventListener('keydown', event => {
    if (event.key === 'Escape') { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); btn.focus(); }
  });

  actions.forEach((a) => {
    if (a.separator) {
      // 첫 줄이거나 바로 앞이 구분선이면 넣지 않는다 (빈 구역이 생기지 않게)
      const prev = menu.lastElementChild;
      if (prev && !prev.classList.contains('overflow-sep')) {
        const sep = document.createElement('div');
        sep.className = 'overflow-sep';
        menu.appendChild(sep);
      }
      return;
    }
    if (a.custom) {
      menu.appendChild(a.custom);
      return;
    }
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'overflow-item' + (a.danger ? ' danger' : '');
    item.textContent = a.label;
    if (a.disabled) item.disabled = true;
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
      a.onClick();
    });
    menu.appendChild(item);
  });

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.overflow-list').forEach((m) => {
      if (m !== menu) { m.hidden = true; m.previousElementSibling.setAttribute('aria-expanded', 'false'); }
    });
    menu.hidden = !menu.hidden;
    btn.setAttribute('aria-expanded', String(!menu.hidden));
  });

  wrap.appendChild(btn);
  wrap.appendChild(menu);
  return wrap;
}

document.addEventListener('click', () => {
  document.querySelectorAll('.overflow-list:not([hidden])').forEach((m) => { m.hidden = true; m.previousElementSibling.setAttribute('aria-expanded', 'false'); });
});

async function fadeOutAndRun(card, action, message) {
  if (card.getAttribute('aria-busy') === 'true') return;
  card.setAttribute('aria-busy', 'true');
  try {
    await action();
    if (message) announce(message);
  } catch {
    card.querySelectorAll('input[type="checkbox"]').forEach(input => { input.checked = card.classList.contains('done'); });
  } finally { card.removeAttribute('aria-busy'); }
}

function announce(text) {
  showNotice(text);
}

async function toggleTask(id) {
  const source = itemsById.get(id) || wfItem(id);
  await request('/api/track/toggle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, status: source?.status === 'done' ? 'to-do' : 'done' }),
  });
  await load();
}

// 그룹 선택 목록의 <option> HTML. head는 처음부터 보이는 항목, rest는 지라·그룹·직접 입력.
function groupSelectOptions(current, forceClearable) {
  const head = [`<option value="">그룹 지정…</option>`];
  // 여러 개를 한 번에 옮길 땐 "현재 그룹"이라는 게 없어도(current === null) 해제를 고를 수 있어야 한다.
  if (current || forceClearable) head.push(`<option value="__clear__">— 그룹 해제 —</option>`);
  const rest = [];
  rest.push(...jiraIssuesCache.map(i => {
    const selected = current && current.type === 'jira' && current.value === i.key;
    return `<option value="jira:${escapeAttr(i.key)}"${selected ? ' selected' : ''}>${escapeHtml(i.key)} · ${escapeHtml(i.summary)}</option>`;
  }));
  rest.push(...customGroupsCache.map(g => {
    const selected = current && current.type === 'group' && current.value === g;
    return `<option value="group:${escapeAttr(g)}"${selected ? ' selected' : ''}>${escapeHtml(g)}</option>`;
  }));
  rest.push(`<option value="__custom__">직접 입력…</option>`);
  return { head, rest };
}

function renderGroupControl({ jira, group, onSetJira, onSetGroup, forceClearable = false, silent = false }) {
  const wrap = document.createElement('div');
  wrap.className = 'jira-control';

  function buildSelect(current, revertTo, defer = false) {
    const select = document.createElement('select');
    select.className = 'jira-select';
    select.setAttribute('aria-label', '그룹 지정');
    const { head, rest } = groupSelectOptions(current, forceClearable);
    select.innerHTML = defer ? head.join('') : head.concat(rest).join('');
    // 그룹이 있는 카드는 뱃지를 눌러야 목록을 만든다 — 그룹 없는 카드도 같게, 처음 건드릴 때
    // 지라·그룹 항목을 채운다. 접혀 있을 때 보이는 "그룹 지정…"과 차례·동작은 그대로다.
    if (defer) {
      let filled = false;
      const fill = () => {
        if (filled) return;
        filled = true;
        const parsed = document.createElement('select');
        parsed.innerHTML = rest.join('');
        const anchor = select.children[head.length] || null;
        while (parsed.firstChild) select.insertBefore(parsed.firstChild, anchor);
      };
      ['mousedown', 'focus', 'keydown'].forEach((name) => select.addEventListener(name, fill));
    }
    select.addEventListener('click', (e) => e.stopPropagation());
    let committed = false;
    select.addEventListener('change', () => {
      committed = true;
      if (select.value === '__clear__') {
        (async () => {
          await onSetJira(null);
          await onSetGroup(null);
          if (!silent) { announce('그룹 해제함'); load(); }
        })();
        return;
      }
      if (select.value === '__custom__') {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'group-input';
        input.placeholder = '그룹명 입력 후 Enter';
        let inputCommitted = false;
        input.addEventListener('click', (e) => e.stopPropagation());
        input.addEventListener('keydown', async (e2) => {
          if (e2.key === 'Escape') {
            inputCommitted = true;
            if (revertTo && wrap.contains(input)) wrap.replaceChild(revertTo, input);
            return;
          }
          if (e2.key !== 'Enter') return;
          const v = input.value.trim();
          if (!v) return;
          inputCommitted = true;
          await onSetGroup(v);
          if (!silent) { announce('그룹 지정함'); load(); }
        });
        input.addEventListener('blur', () => {
          if (inputCommitted) return;
          if (revertTo && wrap.contains(input)) wrap.replaceChild(revertTo, input);
        });
        wrap.replaceChild(input, select);
        input.focus();
        return;
      }
      if (!select.value) { committed = false; return; }
      if (select.value.startsWith('group:')) {
        const g = select.value.slice('group:'.length);
        (async () => {
          await onSetGroup(g);
          if (!silent) { announce('그룹 지정함'); load(); }
        })();
        return;
      }
      const key = select.value.replace(/^jira:/, '');
      (async () => {
        await onSetJira(key);
        if (!silent) { announce('지라 이슈 연결함'); load(); }
      })();
    });
    select.addEventListener('blur', () => {
      if (committed) return;
      if (revertTo && wrap.contains(select)) wrap.replaceChild(revertTo, select);
    });
    return select;
  }

  // 이미 지정된 지라·그룹은 배지로 보이고, 누르면 같은 자리에서 선택 목록으로 바뀐다.
  const appendBadge = (className, label, current) => {
    const badge = document.createElement('button');
    badge.type = 'button';
    badge.className = className;
    badge.textContent = label;
    badge.setAttribute('aria-label', `${label} — 클릭해서 변경/해제`);
    badge.addEventListener('click', (e) => {
      e.stopPropagation();
      const select = buildSelect(current, badge);
      wrap.replaceChild(select, badge);
      select.focus();
    });
    wrap.appendChild(badge);
    return wrap;
  };

  if (jira) {
    const issue = jiraIssuesCache.find(i => i.key === jira);
    return appendBadge('badge jira-badge', issue ? `${jira} · ${issue.summary}` : jira, { type: 'jira', value: jira });
  }

  if (group) return appendBadge('badge group-badge', group, { type: 'group', value: group });

  wrap.appendChild(buildSelect(null, undefined, true));
  return wrap;
}

async function setTaskGroup(id, group) {
  await request('/api/track/set-group', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, group }),
  });
}

async function setTaskDoing(id, doing) {
  await request('/api/track/set-doing', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, doing }),
  });
  load();
}

async function setTaskDue(id, due) {
  await request('/api/track/set-due', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, due }),
  });
  load();
}

async function setTaskScheduled(id, scheduled) {
  await request('/api/track/set-scheduled', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, scheduled }),
  });
  await load();
}

async function setPriority(id, priority) {
  await request('/api/track/set-priority', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, priority }),
  });
}

function renderIdeaGroupControl(item) {
  const wrap = document.createElement('div');
  wrap.className = 'jira-control';

  const showInput = () => {
    wrap.innerHTML = '';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'group-input';
    input.placeholder = '그룹명 입력 후 Enter (비우면 해제)';
    input.value = item.project || '';
    input.setAttribute('aria-label', '메모 그룹 지정');
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      const v = input.value.trim();
      await setIdeaProject(item.id, v || null);
      announce(v ? '그룹 지정함' : '그룹 해제함');
      load();
    });
    wrap.appendChild(input);
    input.focus();
  };

  if (item.project) {
    const badge = document.createElement('button');
    badge.type = 'button';
    badge.className = 'badge group-badge';
    badge.textContent = item.project;
    badge.setAttribute('aria-label', `${item.project} — 클릭해서 변경/해제`);
    badge.addEventListener('click', (e) => {
      e.stopPropagation();
      showInput();
    });
    wrap.appendChild(badge);
  } else {
    showInput();
  }
  return wrap;
}

async function setIdeaProject(id, project) {
  await request('/api/idea/set-project', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, project }),
  });
}

async function setTaskJira(id, jiraKey) {
  await request('/api/track/set-jira', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, jiraKey }),
  });
}

function setupQuickAdd(inputId, endpoint, announceText) {
  const input = document.getElementById(inputId);
  input.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter' || e.isComposing || input.disabled) return;
    const description = input.value.trim();
    if (!description) return;
    input.disabled = true;
    try {
      await request(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description }),
      });
      input.value = '';
      announce(announceText);
      await load();
    } catch { /* Keep the draft for retry. */ }
    finally { input.disabled = false; input.focus(); }
  });
}

// ---- client.test.js는 이 줄 위까지만 읽는다 (아래는 화면을 실제로 켜는 실행 코드) ----
setupQuickAdd('todayTaskInput', '/api/today-task/create', '오늘 할 일 추가함');
setupQuickAdd('laterTaskInput', '/api/later-task/create', '나중에 할 일 추가함');
setupQuickAdd('waitingInput', '/api/waiting/create', '확인 대기 추가함');
setupQuickAdd('ideaInput', '/api/idea/create', '메모 추가함');
setupQuickAdd('decisionInput', '/api/decision/create', '정책/얼라인 추가함');
// 한 글자마다 카드를 전부 다시 만들면 목록이 길수록 입력이 밀린다 — 입력이 멎은 뒤 한 번만
// 그린다. 조합 중에도 input은 그대로 오고 값을 늦게 읽을 뿐이라 한글 입력은 끊기지 않는다.
let decisionArchiveTimer = null;
document.getElementById('decisionArchiveSearch').addEventListener('input', (event) => {
  decisionArchiveQuery = event.target.value.trim().toLowerCase();
  clearTimeout(decisionArchiveTimer);
  decisionArchiveTimer = setTimeout(renderDecisionArchive, 150);
});

try { todaySort = localStorage.getItem('todaySort') || 'project'; } catch {}
const todayViewSelect = document.getElementById('todayViewSelect');
if (todayViewSelect) {
  todayViewSelect.value = todaySort;
  todayViewSelect.addEventListener('change', () => {
    todaySort = todayViewSelect.value;
    try { localStorage.setItem('todaySort', todaySort); } catch {}
    load();
  });
}
const TABS = {
  today: { grid: 'gridToday', btn: 'tabBtnToday' },
  records: { grid: 'gridRecords', btn: 'tabBtnRecords' },
  weekly: { grid: 'gridWeekly', btn: 'tabBtnWeekly' },
};

function setActiveTab(tab) {
  if (!TABS[tab]) tab = 'today';
  Object.entries(TABS).forEach(([key, cfg]) => {
    const active = key === tab;
    document.getElementById(cfg.grid).hidden = !active;
    document.getElementById(cfg.btn).classList.toggle('active', active);
    document.getElementById(cfg.btn).setAttribute('aria-selected', String(active));
    document.getElementById(cfg.btn).tabIndex = active ? 0 : -1;
    document.getElementById(cfg.btn).setAttribute('aria-controls', cfg.grid);
    document.getElementById(cfg.grid).setAttribute('role', 'tabpanel');
    document.getElementById(cfg.grid).setAttribute('aria-labelledby', cfg.btn);
  });
  activeTabKey = tab;
  document.getElementById('skipLink').hidden = tab !== 'today';
  renderActiveTabLists();
  try {
    localStorage.setItem('activeTab', tab);
  } catch {}
}

Object.keys(TABS).forEach((key) => {
  document.getElementById(TABS[key].btn).addEventListener('click', () => setActiveTab(key));
  document.getElementById(TABS[key].btn).addEventListener('keydown', event => {
    const keys = Object.keys(TABS);
    let index = keys.indexOf(key);
    if (event.key === 'ArrowRight') index = (index + 1) % keys.length;
    else if (event.key === 'ArrowLeft') index = (index + keys.length - 1) % keys.length;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = keys.length - 1;
    else return;
    event.preventDefault();
    setActiveTab(keys[index]);
    document.getElementById(TABS[keys[index]].btn).focus();
  });
});

document.getElementById('skipLink').addEventListener('click', event => {
  event.preventDefault();
  const zone = document.getElementById('todayTaskZone');
  zone.focus();
  zone.scrollIntoView({ block: 'start' });
});

document.getElementById('planningToggle').addEventListener('click', () => {
  planningMode = !planningMode;
  renderPlanningMode();
  announce(planningMode ? '계획·정리 모드를 열었습니다.' : '계획·정리 모드를 닫았습니다.');
});

document.getElementById('suggestDismiss').addEventListener('click', () => {
  try { localStorage.setItem('suggestDismissed', todayStr()); } catch {}
  document.getElementById('suggestZone').hidden = true;
  announce('오늘은 제안을 접어둡니다.');
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && selectedTaskId) closeTaskDetail();
});

let savedTab = 'today';
try {
  savedTab = localStorage.getItem('activeTab') || 'today';
} catch {}
setActiveTab(savedTab);

// ---------- 새로고침 ----------
// 자동화가 2시간마다 새 항목을 넣기 때문에, 창을 열어둔 채로는 그걸 못 본다.
// 입력 중에 화면이 다시 그려지면 쓰던 내용이 날아가므로 그때는 건너뛴다.

const refreshBtn = document.getElementById('refreshBtn');

refreshBtn.addEventListener('click', async () => {
  refreshBtn.classList.add('spinning');
  await load();
  announce('새로고침했습니다.');
  setTimeout(() => refreshBtn.classList.remove('spinning'), 400);
});

// ---------- 환경설정 (상태 / 사용법) ----------

function relativeTimeFrom(timeStr) {
  // "YYYY-MM-DD HH:MM:SS" (로컬 시각) 기준으로 몇 분/시간 전인지
  const then = new Date(timeStr.replace(' ', 'T'));
  if (Number.isNaN(then.getTime())) return timeStr;
  const diffMin = Math.round((Date.now() - then.getTime()) / 60000);
  if (diffMin < 1) return '방금';
  if (diffMin < 60) return `${diffMin}분 전`;
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return `${diffHour}시간 전`;
  return `${Math.round(diffHour / 24)}일 전`;
}

// 자주 보는 실패 패턴은 원문(영어) 대신 한국어로 바꿔서 보여준다.
// 모르는 패턴은 억지로 번역하지 않고 원문 그대로 둔다.
function translateFailureText(text) {
  const sessionLimit = text.match(/session limit.*?resets\s+([^)]+)/i);
  if (sessionLimit) return `Claude 사용량 한도에 걸림 · ${sessionLimit[1].trim()}에 풀림`;
  if (/session limit/i.test(text)) return 'Claude 사용량 한도에 걸림';
  return text;
}

// 성공 보고문은 Claude가 매번 자유롭게 쓴 긴 문장이라(마크다운 ** 기호까지 그대로) 스캔하기 어렵다.
// 첫 문장만 보여주고 나머지는 "로그 더 보기"에서 보게 한다.
function trimSummaryText(text) {
  if (!text) return text;
  const clean = text.replace(/\*\*/g, '').trim();
  const firstLine = clean.split('\n')[0];
  const sentenceEnd = firstLine.search(/[.!?](?!\d)/);
  let short = sentenceEnd >= 0 ? firstLine.slice(0, sentenceEnd + 1) : firstLine;
  if (short.length > 80) short = short.slice(0, 80) + '…';
  return short.length < clean.length ? `${short} …` : short;
}

let automationStatusCache = [];

async function fetchAutomationStatus() {
  try {
    const data = await request('/api/automation/status').then(r => r.json());
    automationStatusCache = data.automations || [];
  } catch {
    automationStatusCache = [];
  }
  // 안 열어봐도 톱니바퀴만 보고 "확인할 게 있다"를 알 수 있게 점을 켠다
  // 지금 실제로 실패 중인 게 있을 때만 — 예전에 있었다가 해결된 건 알림이 아니다
  const hasAlert = automationStatusCache.some(a => a.lastKind === 'fail');
  document.getElementById('settingsBtn')?.classList.toggle('has-alert', hasAlert);
  return automationStatusCache;
}

async function renderAutomationStatus() {
  const view = document.getElementById('settingsStatusView');
  view.innerHTML = '<div class="empty">불러오는 중…</div>';
  const automations = await fetchAutomationStatus();
  if (!automations.length) {
    view.innerHTML = '<div class="empty">상태를 불러오지 못했습니다.</div>';
    return;
  }
  view.innerHTML = '';
  // "최근 실패 기록이 있음"과 "지금 문제임"은 다르다 — 예전엔 둘을 구분 안 해서,
  // 벌써 고쳐져서 마지막 실행이 정상이었는데도 몇 시간 전 실패 이력 때문에 계속
  // 빨간 점이 떠 있었다("이게 지금도 그런 건지 예전 건지 모르겠다"는 혼란의 원인).
  // 가장 최근 실행 자체가 실패였을 때만 "지금 문제"로 본다.
  [...automations].sort((a, b) => (b.lastKind === 'fail' ? 1 : 0) - (a.lastKind === 'fail' ? 1 : 0)).forEach(a => {
    const failingNow = a.lastKind === 'fail';
    const card = document.createElement('div');
    card.className = 'automation-card' + (failingNow ? ' has-failure' : '');
    const head = document.createElement('div');
    head.className = 'automation-card-head';
    head.innerHTML = `
      <span class="automation-dot" aria-hidden="true"></span>
      <span class="automation-name">${escapeHtml(a.name)}</span>
      <span class="automation-time">${a.lastRunAt ? escapeHtml(relativeTimeFrom(a.lastRunAt)) : '기록 없음'}</span>
    `;
    card.appendChild(head);
    const summary = document.createElement('div');
    summary.className = 'automation-summary';
    const rawSummary = a.lastSummary || '아직 실행 기록이 없습니다.';
    summary.textContent = trimSummaryText(failingNow ? translateFailureText(rawSummary) : rawSummary);
    card.appendChild(summary);
    if (a.recentFailures.length) {
      if (failingNow) {
        const fails = document.createElement('div');
        fails.className = 'automation-failures';
        fails.innerHTML = a.recentFailures.map(f => `<div class="automation-failure-row">⚠ ${escapeHtml(f.time)} · ${escapeHtml(translateFailureText(f.text))}</div>`).join('');
        card.appendChild(fails);
      } else {
        // 지금은 정상 — 예전 실패는 경고가 아니라 참고용으로만, 접어서 조용히 둔다
        const past = document.createElement('details');
        past.className = 'automation-past-failures';
        const sum = document.createElement('summary');
        sum.textContent = `지난 문제 ${a.recentFailures.length}건 · 지금은 정상`;
        past.appendChild(sum);
        past.insertAdjacentHTML('beforeend', a.recentFailures.map(f => `<div class="automation-failure-row muted">${escapeHtml(f.time)} · ${escapeHtml(translateFailureText(f.text))}</div>`).join(''));
        card.appendChild(past);
      }
    }
    if (a.tail && a.tail.length) {
      const details = document.createElement('details');
      details.className = 'automation-log-toggle';
      const sum = document.createElement('summary');
      sum.textContent = '로그 더 보기';
      details.appendChild(sum);
      const pre = document.createElement('pre');
      pre.className = 'automation-log-tail';
      pre.textContent = a.tail.join('\n');
      details.appendChild(pre);
      card.appendChild(details);
    }
    view.appendChild(card);
  });
}

function renderSettingsGuide() {
  const view = document.getElementById('settingsGuideView');
  if (view.dataset.rendered) return;
  view.dataset.rendered = 'true';
  view.className = 'settings-guide';
  view.innerHTML = `
    <dl>
      <dt>새로 들어온 것(인박스)이 뭔가요?</dt>
      <dd>슬랙에서 자동으로 긁어온 항목이 우선 모이는 곳이에요. AI가 오늘 할지 나중에 할지 미리 정하지 않고, 직접 분류하시라고 남겨둔 것입니다. 분류하면 인박스에서 사라지고 해당 목록으로 옮겨가요.</dd>
      <dt>보고 문장을 수정하면 원본 업무도 바뀌나요?</dt>
      <dd>아니요. 보고 문장과 원본 기록은 별도로 보존됩니다. 새 관련 업무는 수정 제안으로 표시되며, 직접 적용하기 전에는 편집한 문장을 바꾸지 않습니다.</dd>
      <dt>자잘한 업무는 어떻게 빼나요?</dt>
      <dd>"이번 보고에서 제외"를 누르면 복사할 내용에서 빠집니다. 원본은 전체 업무 기록에 남고 언제든 보고에 복원할 수 있습니다.</dd>
      <dt>그룹은 어떻게 바꾸나요?</dt>
      <dd>카드의 ⋮ 메뉴 → 그룹에서 드롭다운으로 바로 고를 수 있어요. 여러 개를 한 번에 바꾸려면 "선택" 버튼으로 체크박스를 켜고 같은 드롭다운을 씁니다.</dd>
      <dt>상단의 "○일 전 기준" 같은 표시는 뭔가요?</dt>
      <dd>슬랙·캘린더·지라 자동 동기화가 최근에 못 돌았다는 뜻이에요. 이 환경설정 안의 "상태" 탭에서 무슨 일인지 더 자세히 볼 수 있습니다.</dd>
      <dt>확인 대기는 뭔가요?</dt>
      <dd>다른 사람의 답을 기다리는 항목이에요. 완료 표시하면 "해결됨"으로 남고, 할 일 쪽에서 "이 답변을 기다리는 중"으로 연결해두면 답이 오는 순간 알려줍니다.</dd>
    </dl>
  `;
  if(['localhost','127.0.0.1'].includes(location.hostname)) {
    const access=document.createElement('button');access.className='convert-btn';access.type='button';access.textContent='다른 기기 접속 암호 복사';
    access.addEventListener('click',async()=>{try{const result=await (await request('/api/access-token')).json();if(!result.token){showNotice('다른 기기 접속이 설정되지 않았습니다.');return;}await navigator.clipboard.writeText(result.token);showNotice('암호를 복사했습니다. 다른 기기에서 사용자 이름은 workspace를 입력해 주세요.');}catch{showNotice('암호를 복사하지 못했습니다.',true);}});view.appendChild(access);
  }
}

const settingsDialog = document.getElementById('settingsDialog');
document.getElementById('settingsBtn').addEventListener('click', () => {
  settingsDialog.showModal();
  renderAutomationStatus();
});
document.getElementById('settingsCloseBtn').addEventListener('click', () => settingsDialog.close());
settingsDialog.querySelectorAll('[data-settings-tab]').forEach(btn => {
  btn.addEventListener('click', () => {
    settingsDialog.querySelectorAll('[data-settings-tab]').forEach(b => b.classList.toggle('active', b === btn));
    const tab = btn.dataset.settingsTab;
    document.getElementById('settingsStatusView').hidden = tab !== 'status';
    document.getElementById('settingsGuideView').hidden = tab !== 'guide';
    if (tab === 'guide') renderSettingsGuide();
    if (tab === 'status') renderAutomationStatus();
  });
});

// 폰에서는 버튼이 작으니, 맨 위에서 아래로 끌어도 새로고침되게 한다.
const pullIndicator = document.getElementById('pullIndicator');
const PULL_THRESHOLD = 64;   // 이만큼 끌면 새로고침
const PULL_MAX = 88;         // 그 이상은 더 따라오지 않는다
let pullStartY = null;
let pullDist = 0;
let pulling = false;
let pullRefreshing = false;

function movePull(y, ready) {
  pullIndicator.style.transform = `translateY(${y}px)`;
  pullIndicator.style.opacity = y > 4 ? String(Math.min(1, y / PULL_THRESHOLD)) : '0';
  pullIndicator.classList.toggle('ready', !!ready);
}

function resetPull(animate) {
  pullIndicator.classList.toggle('snapping', !!animate);
  pullIndicator.classList.remove('ready', 'refreshing');
  pullIndicator.style.removeProperty('--pull-y');
  movePull(-40, false);
  pullDist = 0;
  pulling = false;
  pullStartY = null;
}

document.addEventListener('touchstart', (e) => {
  if (pullRefreshing || e.touches.length !== 1) return;
  if (window.scrollY > 0 || isTyping()) return;
  pullStartY = e.touches[0].clientY;
  pullDist = 0;
  pulling = false;
}, { passive: true });

document.addEventListener('touchmove', (e) => {
  if (pullStartY === null || pullRefreshing) return;
  const dy = e.touches[0].clientY - pullStartY;
  // 위로 올리거나 이미 스크롤된 상태면 평범한 스크롤로 놓아준다
  if (dy <= 0 || window.scrollY > 0) {
    if (pulling) resetPull(true);
    pullStartY = null;
    return;
  }
  pulling = true;
  pullIndicator.classList.remove('snapping');
  // 당길수록 무거워지게 — 손가락을 딼 때를 알아차리기 쉽다
  pullDist = Math.min(PULL_MAX, dy * 0.5);
  movePull(pullDist, pullDist >= PULL_THRESHOLD);
  e.preventDefault();
}, { passive: false });

async function endPull() {
  if (pullStartY === null) return;
  if (!pulling) { pullStartY = null; return; }
  if (pullDist < PULL_THRESHOLD) { resetPull(true); return; }

  pullRefreshing = true;
  pullIndicator.classList.add('snapping');
  const restY = 56;
  pullIndicator.style.setProperty('--pull-y', restY + 'px');
  movePull(restY, true);
  pullIndicator.classList.add('refreshing');
  try {
    await load();
    announce('새로고침했습니다.');
  } finally {
    pullRefreshing = false;
    resetPull(true);
  }
}

document.addEventListener('touchend', endPull, { passive: true });
document.addEventListener('touchcancel', () => { if (pulling) resetPull(true); else pullStartY = null; }, { passive: true });

// 다른 창 갔다가 돌아오면 최신 상태로
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !isTyping()) { load(); fetchAutomationStatus(); }
});

// 계속 띄워둔 채로도 뒤처지지 않게
setInterval(() => {
  if (!document.hidden && !isTyping()) { load(); fetchAutomationStatus(); }
}, 5 * 60 * 1000);

load();
refreshStorageStatus(); // 목록을 못 불러오는 상황에서도 저장이 멈춘 이유는 보이게
fetchAutomationStatus(); // 환경설정을 열어보지 않아도 톱니바퀴에 실패 여부가 바로 보이게

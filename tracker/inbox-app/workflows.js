let workflowData = { items: [], meetings: [] };
// 카드 하나 그릴 때마다 전체 항목을 훑던 자리들 — workflowData를 새로 받을 때 한 번만 색인해 둔다.
let wfItemsById = new Map();
let wfItemsByMeeting = new Map();
function wfIndexData() {
  wfItemsById = new Map(workflowData.items.map(item => [item.id, item]));
  wfItemsByMeeting = new Map();
  workflowData.items.forEach(item => {
    if (!item.meetingId) return;
    if (!wfItemsByMeeting.has(item.meetingId)) wfItemsByMeeting.set(item.meetingId, []);
    wfItemsByMeeting.get(item.meetingId).push(item);
  });
}
const wfMeetingItems = id => wfItemsByMeeting.get(id) || [];
// 한 글자마다 목록을 통째로 다시 그리지 않게, 입력이 멎은 뒤 한 번만 그린다. 조합 중에도 input은
// 그대로 오고 값을 늦게 읽을 뿐이라 한글 조합은 끊기지 않는다.
function wfDebounce(action, delay = 150) {
  let timer = null;
  return () => { clearTimeout(timer); timer = setTimeout(action, delay); };
}
let workflowDialog = null;
let workflowView = null;
const workflowHistory = [];
let taskSelectionMode = false;
let taskBatchBusy = false;
const taskSelection = new Set();
let taskListsCache = { todayTasks: [], laterTasks: [] };
// 검토 중에 고친 종류·문구 — 다른 항목을 빼느라 화면이 다시 그려져도 유지된다.
const wfDraftEdits = new Map();
const wfKey = item => item.jira ? `jira:${item.jira}` : item.group || item.project ? `group:${item.group || item.project}` : null;
const wfMeetingKey = event => event.project ? `${event.project.type}:${event.project.value}` : null;
const wfItem = id => wfItemsById.get(id);
const wfType = type => ({ task: '할 일', bug: '버그', check: '확인 대기', decision: '결정', idea: '아이디어' }[type] || type);
function wfNode(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function wfButton(text, action, className) {
  const button = wfNode('button', text, className);
  button.type = 'button';
  button.addEventListener('click', async () => {
    button.disabled = true;
    try { await action(); } catch (error) {
      const region = workflowDialog?.querySelector('.wf-error');
      if (region) region.textContent = (typeof error?.message === 'string' && error.message) || '저장하지 못했습니다. 입력 내용을 확인하고 다시 시도해 주세요.';
    } finally { button.disabled = false; }
  });
  return button;
}
// 고르는 값이 셋 안팎일 때 드롭다운 대신 한눈에 보이는 칸 버튼으로 고른다(종류, 실행 시점).
const WF_TYPES = [['task', '할 일'], ['check', '확인 대기'], ['decision', '결정']];
function wfSegment(options, value, onChange, label) {
  const group = wfNode('div', undefined, 'd-seg');
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', label);
  const buttons = options.map(([key, text]) => {
    const button = wfNode('button', text);
    button.type = 'button';
    button.setAttribute('role', 'radio');
    button.dataset.key = key;
    return button;
  });
  const choose = key => buttons.forEach(button => {
    const on = button.dataset.key === key;
    button.setAttribute('aria-checked', String(on));
    button.tabIndex = on ? 0 : -1;
  });
  buttons.forEach((button, index) => {
    button.addEventListener('click', () => { choose(button.dataset.key); onChange(button.dataset.key); });
    button.addEventListener('keydown', event => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
      if (!step) return;
      event.preventDefault();
      const next = buttons[(index + step + buttons.length) % buttons.length];
      next.focus(); next.click();
    });
  });
  choose(value);
  group.append(...buttons);
  return group;
}
const wfTypeSegment = (value, onChange, label = '종류') => wfSegment(WF_TYPES, value, onChange, label);
// 날짜 칸은 앱 공용 부품(uiDateField)을 쓴다 — 비어 있으면 `+ 마감일`, 누르면 그 자리에서 고른다.
// 날짜 이름: 할 일은 마감일, 확인 대기는 상대에게 회신 받아야 하는 기한. 결정에는 날짜가 없다.
const wfDateLabel = type => type === 'check' ? '회신 기한' : type === 'decision' ? null : '마감일';
// 서버에 보내는 초안 한 건: 종류·문구, 할 일이면 시점(오늘/나중), 결정이 아니면 날짜(비우면 null로 지운다).
// AI가 문구 끝에 붙여 온 "(방향 확인 필요)" 표식은 화면에 보이지도, 항목 문구로 저장되지도 않게 뗀다.
const wfCleanDraftText = text => text.replace(/\s*\(방향 확인 필요\)\s*$/, '');
const wfAcceptItem = (id, edit) => ({
  id, type: edit.type, description: edit.description.trim(),
  ...(edit.type === 'task' ? { when: edit.when || 'later' } : {}),
  ...(edit.type !== 'decision' ? { due: edit.due || null } : {}),
});
async function wfPost(route, body) {
  const response = await request(`/api/workflow/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return response.json();
}
function wfProjects() {
  const projects = new Map();
  workflowData.items.forEach(item => { const key = wfKey(item); if (key) projects.set(key, item.label || item.group || item.project || item.jira); });
  workflowData.meetings.forEach(event => { const key = wfMeetingKey(event); if (key && !projects.has(key)) projects.set(key, event.project.label || event.project.value); });
  jiraIssuesCache.forEach(issue => projects.set(`jira:${issue.key}`, `${issue.key} · ${issue.summary}`));
  customGroupsCache.forEach(group => { if (!projects.has(`group:${group}`)) projects.set(`group:${group}`, group); });
  return [...projects].sort((a, b) => a[1].localeCompare(b[1]));
}
function wfOpen(view, remember = true) {
  // 항목 상세는 큰 창이 아니라 오른쪽 패널 한 자리에서 연다 — 어디서 열든 같은 모양·같은 버튼이다.
  if (view.kind === 'item') { panelOpen(view); return; }
  // 회의 정리도 같은 오른쪽 패널에서 연다 — 초안 검토·담기·결과가 모두 그 안에 있다.
  if (view.kind === 'meeting') { panelOpen({ kind: 'meeting', id: view.id, back: view.back }); return; }
  // 검색과 회의 모아보기는 ⌘K 팔레트가 대신한다(회의는 팔레트의 `회의` 필터).
  if (view.kind === 'search') { palOpen({ query: view.query || '' }); return; }
  if (view.kind === 'meetings') { palOpen({ type: 'meeting', query: view.query || '' }); return; }
  if (!workflowDialog) {
    workflowHistory.length = 0;
    workflowDialog = wfNode('dialog', undefined, 'wf-dialog');
    workflowDialog.setAttribute('aria-label', '업무 모아보기');
    workflowDialog.addEventListener('close', () => { workflowDialog.remove(); workflowDialog = null; workflowView = null; workflowHistory.length = 0; });
    document.body.appendChild(workflowDialog);
    workflowDialog.showModal();
  } else if (remember && workflowView) workflowHistory.push({ ...workflowView, scroll: workflowDialog.scrollTop });
  workflowView = view;
  wfRender();
}
function wfRender() {
  if (!workflowDialog) return;
  const view = workflowView;
  workflowDialog.replaceChildren();
  const header = wfNode('div', undefined, 'wf-head');
  if (workflowHistory.length) header.appendChild(wfButton('뒤로', () => wfOpen(workflowHistory.pop(), false)));
  const title = view.kind === 'projects' ? '프로젝트 모아보기' : wfProjects().find(([key]) => key === view.key)?.[1] || view.key;
  header.append(wfNode('h2', title), wfButton('닫기', () => workflowDialog.close()));
  workflowDialog.appendChild(header);
  const error = wfNode('p', '', 'wf-error'); error.setAttribute('role', 'alert'); workflowDialog.appendChild(error);
  if (view.kind === 'projects') wfProjects().forEach(([key, label]) => {
    const count = workflowData.items.filter(item => wfKey(item) === key && item.status !== 'done').length;
    workflowDialog.appendChild(wfRow(label, `미완료 ${count}개`, () => wfOpen({ kind: 'project', key })));
  });
  if (view.kind === 'project') wfProject(view.key);
}
function wfRow(title, meta, action) {
  const row = wfNode('div', undefined, 'wf-row');
  const main = wfButton(title, action, 'wf-main'); main.appendChild(wfNode('span', meta, 'wf-meta'));
  row.appendChild(main); return row;
}
function wfSearchMatches(query, values) {
  const haystack = values.filter(Boolean).join(' ').normalize('NFKC').toLocaleLowerCase();
  return query.normalize('NFKC').toLocaleLowerCase().trim().split(/\s+/).every(word => haystack.includes(word));
}
function taskSelectionRefresh() {
  const container = document.getElementById('taskBatchTools');
  if (!container) return;
  container.hidden = false;
  document.getElementById('gridToday').classList.toggle('task-selecting', taskSelectionMode);
  container.replaceChildren();
  container.classList.toggle('active', taskSelectionMode);

  // 두 줄로 위계를 나눈다 — 위는 "선택 모드 자체"를 다루는 줄(끝내기·몇 개·전체선택),
  // 아래는 "선택한 걸 어떻게 바꿀지" 다루는 줄(날짜·그룹). 예전엔 7~8개 알약이 위계 없이
  // 한 줄로 늘어서 있어서 뭐가 뭔지 구분이 안 됐다. 선택 모드일 땐 테두리 있는 박스로
  // 감싸서 "지금 특별한 모드"라는 게 눈에 보이게 한다.
  const modeRow = wfNode('div', undefined, 'task-batch-mode-row');
  const toggle = wfButton(taskSelectionMode ? '선택 끝내기' : '여러 개 선택', () => {
    if (taskBatchBusy) return;
    taskSelectionMode = !taskSelectionMode; taskSelection.clear(); panelClose();
    taskListsRender();
  }, 'convert-btn');
  toggle.disabled = taskBatchBusy; toggle.setAttribute('aria-pressed', String(taskSelectionMode));
  modeRow.appendChild(toggle);
  container.appendChild(modeRow);
  if (!taskSelectionMode) return;

  modeRow.appendChild(wfNode('span', `${taskSelection.size}개 선택`, 'wf-section-note'));
  const candidates = [...taskListsCache.todayTasks, ...taskListsCache.laterTasks].filter(item => item.status !== 'done');
  const allSelected = candidates.length > 0 && candidates.every(item => taskSelection.has(item.id));
  // "전체 선택"은 고르는 걸 도와주는 보조 동작이라, 진짜 액션(오늘로/그룹 등)보다는
  // 옅은 링크 스타일로 — 알약 버튼 여러 개가 다 같은 무게로 안 보이게 한다.
  modeRow.appendChild(wfButton(allSelected ? '전체 선택 해제' : '전체 선택', () => {
    if (allSelected) taskSelection.clear(); else candidates.forEach(item => taskSelection.add(item.id));
    taskListsRender();
  }, 'wf-link'));

  if (taskSelection.size) {
    const actionRow = wfNode('div', undefined, 'task-batch-action-row');
    for (const [title, scheduled] of [['오늘로', todayStr()], ['내일로', tomorrowStr()], ['나중으로', null]]) actionRow.appendChild(wfButton(title, () => taskBatchApply({ scheduled }), 'convert-btn'));
    const date = document.createElement('input'); date.type = 'date'; date.setAttribute('aria-label', '선택 업무 실행 예정일'); date.className = 'overflow-date-input';
    const dateWrap = wfNode('details', undefined, 'task-batch-date'); dateWrap.appendChild(wfNode('summary', '날짜 지정'));
    dateWrap.append(date, wfButton('적용', async () => { if (date.value && date.checkValidity()) await taskBatchApply({ scheduled: date.value }); }, 'convert-btn')); actionRow.appendChild(dateWrap);
    const groups = renderGroupControl({
      jira: null, group: null, silent: true,
      onSetJira: key => taskBatchApply({ project: key ? `jira:${key}` : null }),
      onSetGroup: group => group === null ? Promise.resolve() : taskBatchApply({ project: `group:${group}` }),
    });
    const clear = wfNode('option', '— 그룹 해제 —'); clear.value = '__clear__'; groups.querySelector('select').appendChild(clear);
    actionRow.appendChild(groups);
    container.appendChild(actionRow);
  }
  container.querySelectorAll('button, input, select').forEach(control => { control.disabled = taskBatchBusy; });
}
function taskListsRender() {
  renderTodayTasks(taskListsCache.todayTasks); renderLaterTasks(taskListsCache.laterTasks); taskSelectionRefresh();
}
function taskSelectionCheckbox(item, card) {
  const input = document.createElement('input'); input.type = 'checkbox'; input.className = 'checkbox task-selection';
  input.checked = taskSelection.has(item.id); input.disabled = taskBatchBusy;
  input.setAttribute('aria-label', `${item.description} — 일괄 정리 선택`);
  card.classList.toggle('batch-selected', input.checked);
  input.addEventListener('change', () => {
    if (input.checked) taskSelection.add(item.id); else taskSelection.delete(item.id);
    card.classList.toggle('batch-selected', input.checked); taskSelectionRefresh();
  });
  return input;
}
async function taskBatchApply(change) {
  if (taskBatchBusy || !taskSelection.size) return;
  taskBatchBusy = true; taskSelectionRefresh();
  document.querySelectorAll('.task-selection').forEach(input => { input.disabled = true; });
  try {
    const result = await wfPost('task-batch', { ids: [...taskSelection], change });
    let token = result.undoToken;
    const restore = async () => { const result = await wfPost('task-batch', { undoToken: token }); token = result.undoToken; };
    const entry = { label: `${result.count}개 업무 일괄 정리`, undo: restore, redo: restore };
    pushUndo(entry);
    taskSelection.clear(); await load();
    showNotice(`${result.count}개 업무를 변경했습니다.`, false, null, { label: '실행 취소', onClick: async () => {
      if (undoStack[undoStack.length - 1] !== entry) { showNotice('이후 작업부터 순서대로 실행 취소해 주세요.', true); return; }
      await replayUndo('undo');
    } });
  } finally {
    taskBatchBusy = false; taskSelectionRefresh();
    document.querySelectorAll('.task-selection').forEach(input => { input.disabled = false; });
  }
}
// 항목 한 줄: 종류 칩 · 문구 · 상태. 카드마다 테두리를 두르지 않고, 묶음(wfItemList) 안에서 가는 선으로만 나눈다.
function wfItemRow(item) {
  const blocker = item.blockedBy && wfItem(item.blockedBy);
  const waiting = blocker?.status !== 'done' && blocker;
  const state = item.status === 'done' ? '완료' : waiting ? '답변 대기' : item.doing ? '진행중' : '미완료';
  const row = wfNode('div', undefined, `wf-row wf-irow${item.status === 'done' ? ' is-done' : ''}`);
  const main = wfButton('', () => wfOpen({ kind: 'item', id: item.id }), 'wf-main wf-item');
  main.appendChild(wfNode('span', wfType(item.type), `wf-tag wf-tag-${item.type}`));
  const body = wfNode('span', undefined, 'wf-item-body');
  body.appendChild(wfNode('span', item.description, 'wf-item-text'));
  if (item.outcome) body.appendChild(wfNode('span', item.outcome, 'wf-item-outcome'));
  main.appendChild(body);
  // 오른쪽: 기한(있으면)과 눈여겨볼 상태. 기본 상태(미완료)는 모든 줄에 반복되니 보이지 않게 한다.
  const meta = wfNode('span', undefined, 'wf-item-meta');
  if (item.due && item.status !== 'done') {
    const late = diffDays(item.due) < 0;
    meta.appendChild(wfNode('span', `${item.type === 'check' ? '회신 기한' : '마감'} ${item.due.slice(5).replace('-', '/')}`, `wf-item-due${late ? ' is-late' : ''}`));
  }
  if (state !== '미완료') meta.appendChild(wfNode('span', state, `wf-item-state${waiting && item.status !== 'done' ? ' is-wait' : ''}`));
  if (meta.children.length) main.appendChild(meta);
  row.appendChild(main);
  return row;
}
function wfItemList(items) {
  const list = wfNode('div', undefined, 'wf-ilist');
  items.forEach(item => list.appendChild(wfItemRow(item)));
  return list;
}
// 행 오른쪽의 상태 칩: 지금 손댈 것(검토할 초안)을 가장 눈에 띄게, 0인 숫자는 보이지 않게.
function wfMeetingChips(event) {
  const items = wfMeetingItems(event.id);
  const open = types => items.filter(item => types.includes(item.type) && item.status !== 'done').length;
  const chips = [];
  if (event.drafts?.length) chips.push(['review', `초안 ${event.drafts.length} 검토`]);
  if (open(['task', 'bug'])) chips.push(['count', `할 일 ${open(['task', 'bug'])}`]);
  if (open(['check'])) chips.push(['count', `확인 대기 ${open(['check'])}`]);
  const decisions = items.filter(item => item.type === 'decision').length;
  if (decisions) chips.push(['count', `결정 ${decisions}`]);
  if (!chips.length) chips.push(['none', items.length ? '모두 처리함' : '기록 없음']);
  return chips;
}
function wfMeetingRow(event) {
  const row = wfNode('div', undefined, `wf-row${event.drafts?.length ? ' wf-row-review' : ''}`);
  const main = wfButton('', () => wfOpen({ kind: 'meeting', id: event.id }), 'wf-main wf-mrow');
  main.appendChild(wfNode('span', event.start || '', 'wf-mtime'));
  const body = wfNode('span', undefined, 'wf-mbody');
  body.appendChild(wfNode('span', event.title, 'wf-mtitle'));
  if (event.project) body.appendChild(wfNode('span', event.project.label || event.project.value, 'wf-chip wf-chip-project'));
  main.appendChild(body);
  const chips = wfNode('span', undefined, 'wf-mchips');
  wfMeetingChips(event).forEach(([kind, text]) => chips.appendChild(wfNode('span', text, `wf-chip wf-chip-${kind}`)));
  main.appendChild(chips);
  row.appendChild(main);
  return row;
}
function wfProject(key) {
  const items = workflowData.items.filter(item => wfKey(item) === key);
  for (const [title, filter] of [['진행할 업무', item => ['task', 'bug'].includes(item.type) && item.status !== 'done'], ['확인 대기', item => item.type === 'check' && item.status !== 'done'], ['최근 결정', item => item.type === 'decision'], ['아이디어', item => item.type === 'idea'], ['완료한 업무', item => ['task', 'bug'].includes(item.type) && item.status === 'done']]) {
    const matches = items.filter(filter).sort((a, b) => (b.created || '').localeCompare(a.created || ''));
    if (!matches.length) continue;
    workflowDialog.appendChild(wfNode('h3', `${title} · ${matches.length}`));
    if (matches.length) workflowDialog.appendChild(wfItemList(matches));
  }
  workflowDialog.appendChild(wfNode('h3', '관련 회의'));
  const events = workflowData.meetings.filter(event => wfMeetingKey(event) === key || items.some(item => item.meetingId === event.id));
  events.forEach(event => workflowDialog.appendChild(wfMeetingRow(event)));
  if (!events.length) workflowDialog.appendChild(wfNode('p', '연결된 회의가 없습니다.', 'wf-section-note'));
}
// 날짜 내림차순, 같은 날은 시간 오름차순 — 하루 안에서는 회의 순서대로 처리한다.
const wfMeetingOrder = (a, b) => (b.date || '').localeCompare(a.date || '') || (a.start || '').localeCompare(b.start || '');
const wfNextReview = currentId => workflowData.meetings.filter(event => event.id !== currentId && event.drafts?.length).sort(wfMeetingOrder)[0];
// 결과 카드(panelMeetingResult)의 할 일 줄: created(서버가 만든 항목 번호)와 accepted(보낸 초안)는 같은 순서다. 오늘 할 일에 있는지(처음부터 오늘이었거나 방금 올렸거나)도 함께.
const wfResultTasks = result => result.accepted.map((item, index) => ({ item, itemId: result.created[index] })).filter(({ item }) => item.type === 'task')
  .map(({ item, itemId }) => ({ itemId, description: item.description, today: item.when === 'today' || (result.promoted || []).includes(itemId) }));
async function wfReview(body) {
  const result = await wfPost('review', body);
  if (!result.ok) throw new Error(result.error || '검토 결과를 저장하지 못했습니다.');
  return result;
}
function workflowOutcome(item) {
  showNotice('완료로 표시했습니다.', false, null, { label: '결과 한 줄 남기기', onClick: () => wfOpen({ kind: 'item', id: item.id, editOutcome: true }) });
}
function workflowTaskBadges(item) {
  const detail = wfItem(item.id);
  if (!detail || item.status === 'done') return '';
  const check = wfItem(detail.blockedBy);
  let text = '';
  if (check) text += `<span class="badge">${check.status === 'done' ? '답변 해결 · 진행 가능' : '답변 대기 중'}</span>`;
  return text;
}
function workflowRender(data) {
  workflowData = data.workflows || { items: [], meetings: [] };
  wfIndexData();
  taskListsCache = { todayTasks: data.todayTasks || [], laterTasks: data.laterTasks || [] };
  const available = new Set([...taskListsCache.todayTasks, ...taskListsCache.laterTasks].filter(item => item.status !== 'done').map(item => item.id));
  for (const id of taskSelection) if (!available.has(id)) taskSelection.delete(id);
  if (!document.getElementById('taskBatchTools')) {
    const controls = wfNode('div', undefined, 'task-batch-tools'); controls.id = 'taskBatchTools'; controls.hidden = true;
    document.getElementById('todayTaskInput').parentElement.before(controls);
  }
  if (!document.getElementById('wfMeetingEntry')) {
    const button = wfButton('전체 보기', () => wfOpen({ kind: 'meetings' }), 'wf-link'); button.id = 'wfMeetingEntry';
    document.getElementById('calendarSectionCount').parentElement.appendChild(button);
    const projects = wfButton('프로젝트 모아보기', () => wfOpen({ kind: 'projects' }), 'd-btn');
    document.getElementById('todayHeadExtra').appendChild(projects);
  }
  // 후속 알림은 확인 대기 입력란과 목록 사이에 끼우지 않는다 — 리마인드 아래, 확인 대기 위의
  // 작은 구역으로 둔다(구역 제목보다 조용한 이름표).
  const reminder = document.getElementById('railFollowUps');
  if (!reminder) return;
  const checks = workflowData.items.filter(item => item.type === 'check' && item.status !== 'done' && item.followUp && item.followUp <= data.today && item.contacted !== data.today);
  const ready = workflowData.items.filter(item => ['task', 'bug'].includes(item.type) && item.status !== 'done' && item.blockedBy && wfItem(item.blockedBy)?.status === 'done');
  reminder.replaceChildren();
  reminder.hidden = !checks.length && !ready.length;
  const group = (label, items, meta) => {
    reminder.appendChild(wfNode('div', `${label} ${items.length}`, 'lbl'));
    items.forEach(item => reminder.appendChild(uiRailRow({
      id: item.id,
      text: item.description,
      meta: meta ? meta(item) : [],
      onOpen: () => panelOpen({ id: item.id }),
    })));
  };
  // 누구에게 물었는지는 업무 기록 쪽에 있다(흐름 기록에는 없을 수 있다).
  if (checks.length) group('다시 확인할 항목', checks, (item) => {
    const who = itemsById.get(item.id)?.who || item.who;
    return [who ? { text: who, strong: true } : null];
  });
  if (ready.length) group('답변이 해결된 업무', ready);
}

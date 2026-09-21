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
  const group = wfNode('div', undefined, 'wf-seg');
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', label);
  const buttons = options.map(([key, text]) => {
    const button = wfNode('button', text, 'wf-seg-btn');
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
// 날짜 칸: 비어 있으면 "+ 마감일" 버튼만 보이고(빈 날짜 입력칸을 늘 보여 주지 않으려고), 누르면 날짜 입력이 된다.
function wfDateField(value, label, onChange) {
  const wrap = wfNode('span', undefined, 'wf-datefield');
  const empty = () => {
    const add = wfNode('button', `+ ${label}`, 'wf-date-add');
    add.type = 'button';
    add.addEventListener('click', () => { const input = filled(''); input.focus(); input.showPicker?.(); });
    wrap.replaceChildren(add);
  };
  const filled = current => {
    const input = document.createElement('input');
    input.type = 'date'; input.value = current; input.className = 'wf-date-input';
    input.setAttribute('aria-label', label);
    input.addEventListener('change', () => { onChange(input.value); if (!input.value) empty(); });
    const clear = wfNode('button', '지우기', 'wf-date-clear');
    clear.type = 'button';
    clear.setAttribute('aria-label', `${label} 지우기`);
    clear.addEventListener('click', () => { onChange(''); empty(); });
    wrap.replaceChildren(input, clear);
    return input;
  };
  if (value) filled(value); else empty();
  return wrap;
}
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
function wfField(parent, title, input) {
  input.setAttribute('aria-label', title);
  const label = wfNode('label', title);
  label.appendChild(input); parent.appendChild(label); return input;
}
function wfSelect(options, value) {
  const select = document.createElement('select');
  options.forEach(([key, label]) => { const option = wfNode('option', label); option.value = key; select.appendChild(option); });
  select.value = value || ''; return select;
}
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
  const title = view.kind === 'search' ? '통합 검색' : view.kind === 'meetings' ? '회의 모아보기' : view.kind === 'projects' ? '프로젝트 모아보기' : view.kind === 'project' ? wfProjects().find(([key]) => key === view.key)?.[1] || view.key : '회의 정리';
  header.append(wfNode('h2', title, view.kind === 'meeting' ? 'wf-eyebrow' : undefined), wfButton('닫기', () => workflowDialog.close()));
  workflowDialog.appendChild(header);
  const error = wfNode('p', '', 'wf-error'); error.setAttribute('role', 'alert'); workflowDialog.appendChild(error);
  if (view.kind === 'meetings') wfMeetingList();
  if (view.kind === 'search') wfSearch();
  if (view.kind === 'projects') wfProjects().forEach(([key, label]) => {
    const count = workflowData.items.filter(item => wfKey(item) === key && item.status !== 'done').length;
    workflowDialog.appendChild(wfRow(label, `미완료 ${count}개`, () => wfOpen({ kind: 'project', key })));
  });
  if (view.kind === 'project') wfProject(view.key);
  if (view.kind === 'meeting') wfMeeting(view.id);
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
function wfSearch() {
  // 흔한 단어 하나로도 수십 개가 그냥 다 나와버리면 찾는 의미가 없다 — 종류·완료 여부로
  // 좁힐 수 있게 한다. 회의 목록 화면(wfMeetingList)과 같은 필터 줄 모양을 쓴다.
  const filters = wfNode('div', undefined, 'wf-filters');
  const search = document.createElement('input'); search.type = 'search'; search.value = workflowView.query || '';
  search.placeholder = '업무, 결과, 결정, 회의 검색';
  wfField(filters, '전체 기록 검색', search);
  const typeOptions = [['', '전체 종류'], ['task', '할 일'], ['bug', '버그'], ['check', '확인 대기'], ['decision', '결정'], ['idea', '아이디어'], ['meeting', '회의']];
  const type = wfField(filters, '종류', wfSelect(typeOptions, workflowView.type || ''));
  const hideDone = document.createElement('input'); hideDone.type = 'checkbox'; hideDone.checked = !!workflowView.hideDone;
  const hideDoneLabel = wfField(filters, '완료 제외', hideDone).parentElement; hideDoneLabel.className = 'wf-check';
  workflowDialog.appendChild(filters);
  const count = wfNode('p', '', 'wf-section-note'); count.setAttribute('role', 'status');
  const results = wfNode('div'); workflowDialog.append(count, results);
  function render() {
    Object.assign(workflowView, { query: search.value, type: type.value, hideDone: hideDone.checked });
    results.replaceChildren();
    if (!search.value.trim()) { count.textContent = '찾을 내용을 입력하세요. 완료한 업무도 검색합니다.'; return; }
    const matches = type.value === 'meeting' ? [] : workflowData.items.filter(item =>
      (!type.value || item.type === type.value) &&
      (!hideDone.checked || item.status !== 'done') &&
      wfSearchMatches(search.value, [item.description, item.outcome, item.label, item.jira, item.group, item.project]));
    const meetings = (!type.value || type.value === 'meeting') ? workflowData.meetings.filter(event => wfSearchMatches(search.value, [event.title, event.series, event.date, event.project?.label, ...(event.drafts || []).map(draft => draft.description), ...wfMeetingItems(event.id).map(item => item.description)])) : [];
    count.textContent = matches.length + meetings.length ? `${matches.length + meetings.length}개 찾음` : '검색 결과가 없습니다.';
    matches.forEach(item => {
      const status = item.status === 'done' ? '완료' : item.doing ? '진행중' : '미완료';
      results.appendChild(wfRow(item.description, `${wfType(item.type)} · ${item.label || item.group || item.project || '그룹 없음'} · ${status}${item.outcome ? ` · ${item.outcome}` : ''}`, () => wfOpen({ kind: 'item', id: item.id })));
    });
    meetings.forEach(event => results.appendChild(wfMeetingRow(event)));
  }
  const later = wfDebounce(() => { if (search.isConnected) render(); });
  search.addEventListener('input', () => { workflowView.query = search.value; later(); });
  type.addEventListener('change', render); hideDone.addEventListener('change', render); render();
  search.focus();
  workflowDialog.scrollTop = workflowView.scroll || 0;
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
const wfDayLabel = date => { const label = relativeDate(date); return label === date ? date : `${label} · ${date.slice(5).replace('-', '/')}`; };
function wfMeetingList() {
  const filters = wfNode('div', undefined, 'wf-filters');
  const search = document.createElement('input'); search.type = 'search'; search.value = workflowView.query || '';
  wfField(filters, '제목·시리즈 검색', search);
  const project = wfField(filters, '프로젝트', wfSelect([['', '전체 프로젝트'], ...wfProjects()], workflowView.project));
  const reviewOnly = document.createElement('input'); reviewOnly.type = 'checkbox'; reviewOnly.checked = !!workflowView.reviewOnly;
  wfField(filters, '검토 대기', reviewOnly).parentElement.className = 'wf-check';
  const unresolved = document.createElement('input'); unresolved.type = 'checkbox'; unresolved.checked = !!workflowView.unresolved;
  wfField(filters, '미해결 항목 있음', unresolved).parentElement.className = 'wf-check';
  workflowDialog.appendChild(filters);
  const list = wfNode('div'); workflowDialog.appendChild(list);
  // 날짜가 여럿일 때만 날짜 줄을 넣는다.
  const withDates = (events, dates) => events.flatMap((event, index) => (dates > 1 && (!index || events[index - 1].date !== event.date))
    ? [wfNode('div', wfDayLabel(event.date), 'wf-dateline'), wfMeetingRow(event)] : [wfMeetingRow(event)]);
  function render() {
    Object.assign(workflowView, { query: search.value, project: project.value, reviewOnly: reviewOnly.checked, unresolved: unresolved.checked });
    const events = workflowData.meetings.filter(event => `${event.title} ${event.series}`.toLowerCase().includes(search.value.toLowerCase()) && (!project.value || wfMeetingKey(event) === project.value) && (!reviewOnly.checked || event.drafts?.length) && (!unresolved.checked || wfMeetingItems(event.id).some(item => item.status !== 'done'))).sort(wfMeetingOrder);
    const pending = workflowData.meetings.filter(event => event.drafts?.length);
    const summary = wfNode('p', pending.length ? `검토할 회의 ${pending.length} · 초안 ${pending.reduce((sum, event) => sum + event.drafts.length, 0)}개` : '검토할 초안이 없습니다.', pending.length ? 'wf-mlist-summary wf-mlist-summary-review' : 'wf-mlist-summary');
    const review = events.filter(event => event.drafts?.length), rest = events.filter(event => !event.drafts?.length);
    const dates = new Set(events.map(event => event.date)).size;
    const nodes = [summary];
    if (review.length) nodes.push(wfNode('h3', `검토 필요 ${review.length}`), ...withDates(review, dates));
    if (rest.length) nodes.push(...(review.length ? [wfNode('h3', '그 밖의 회의')] : []), ...withDates(rest, dates));
    list.replaceChildren(...nodes);
    if (!events.length) list.appendChild(wfNode('p', '조건에 맞는 회의가 없습니다.', 'wf-section-note'));
  }
  const later = wfDebounce(() => { if (search.isConnected) render(); });
  search.addEventListener('input', () => { workflowView.query = search.value; later(); });
  project.addEventListener('change', render); reviewOnly.addEventListener('change', render); unresolved.addEventListener('change', render); render();
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
function wfMeeting(id) {
  const event = workflowData.meetings.find(event => event.id === id);
  if (!event) { workflowDialog.appendChild(wfNode('p', '회의를 찾을 수 없습니다.')); return; }
  const when = wfNode('p', `${event.date} · ${event.start}${event.end ? `–${event.end}` : ''}`, 'wf-section-note wf-when');
  (event.tiroNotes || []).forEach(url => {
    const note = wfNode('a', '티로 노트 열기 ↗', 'wf-link'); note.href = url; note.target = '_blank'; note.rel = 'noopener';
    when.appendChild(note);
  });
  // 프로젝트는 여기서 바꾸지 않는다(캘린더 카드 ⋮ → 프로젝트 연결). 어디로 담기는지만 보여 준다.
  if (event.project) { const chip = wfNode('span', event.project.label || event.project.value, 'wf-chip wf-chip-project'); chip.title = '프로젝트는 오늘 미팅 카드의 ⋮ 메뉴에서 바꿉니다'; when.prepend(chip); }
  workflowDialog.append(wfNode('h3', event.title, 'wf-title'), when);
  wfResult(event);
  // 프로젝트 연결은 캘린더 카드의 ⋮ → "프로젝트 연결"에서 이미 한다(거기서 하면 두 저장소에
  // 다 반영되지만, 여기서 따로 저장하면 한쪽에만 반영돼서 서로 어긋났다) — 그래서 여기선 뺐다.
  // "반복 회의 시리즈"도 같은 이유로 뺐다: 프로젝트 연결이 이미 회의 제목 기준으로 자동 이어진다.
  if (event.drafts?.length) wfDrafts(event);
  const typeRank = item => { const rank = ['task', 'bug', 'check', 'decision'].indexOf(item.type); return rank < 0 ? 9 : rank; };
  const items = [...wfMeetingItems(id)].sort((a, b) => typeRank(a) - typeRank(b));
  const itemsHeading = wfNode('h3', '');
  itemsHeading.append('이 회의에서 나온 것');
  if (items.length) itemsHeading.appendChild(wfNode('span', String(items.length), 'wf-count wf-count-neutral'));
  workflowDialog.appendChild(itemsHeading);
  if (items.length) workflowDialog.appendChild(wfItemList(items));
  if (!items.length) workflowDialog.appendChild(wfNode('p', '아직 기록한 항목이 없습니다.', 'wf-section-note'));
  // 종류·내용·추가를 한 줄로 — 세로로 쌓인 라벨 3단짜리 폼 대신 인박스 빠른입력과 같은 모양.
  const form = wfNode('form', undefined, 'wf-capture-row');
  let captureType = 'task', captureDue = '';
  const captureDate = wfNode('span', undefined, 'wf-date-slot wf-capture-date');
  const syncCaptureDate = () => {
    captureDate.replaceChildren();
    const label = wfDateLabel(captureType);
    if (label) captureDate.appendChild(wfDateField(captureDue, label, value => { captureDue = value; }));
  };
  form.appendChild(wfTypeSegment('task', key => { captureType = key; syncCaptureDate(); }, '담을 종류'));
  const description = document.createElement('input'); description.required = true; description.maxLength = 1000;
  description.placeholder = '회의에서 나온 내용';
  description.setAttribute('aria-label', '회의에서 나온 내용');
  form.appendChild(description);
  syncCaptureDate();
  form.appendChild(captureDate);
  const submit = wfNode('button', '추가', 'wf-capture-add'); submit.type = 'submit'; form.appendChild(submit);
  form.addEventListener('submit', async e => {
    e.preventDefault(); if (!description.value.trim() || submit.disabled) return;
    submit.disabled = true;
    try { await wfPost('capture', { meetingId: id, type: captureType, description: description.value, ...(captureType !== 'decision' && captureDue ? { due: captureDue } : {}) }); await load(); wfRender(); }
    catch { workflowDialog.querySelector('.wf-error').textContent = '추가하지 못했습니다. 입력 내용은 유지됩니다.'; submit.disabled = false; }
  });
  // 직접 적어 담기는 보조 도구: 검토할 초안이 있으면 접어 두어 주 흐름(검토 → 담기)에 방해되지 않게 하고, 초안이 없을 때만 펼친다.
  const add = wfNode('details', undefined, 'wf-add');
  add.open = !event.drafts?.length;
  add.append(wfNode('summary', '직접 적어 담기'), form);
  workflowDialog.appendChild(add);
  const existing = workflowData.items.filter(item => !item.meetingId && (!wfMeetingKey(event) || wfKey(item) === wfMeetingKey(event)));
  if (existing.length) {
    const link = wfNode('details'); link.appendChild(wfNode('summary', '기존 항목 연결'));
    const select = wfField(link, '이 회의에서 나온 항목 선택', wfSelect([['', '항목 선택'], ...existing.map(item => [item.id, `${wfType(item.type)} · ${item.description}`])], ''));
    link.appendChild(wfButton('회의에 연결', async () => {
      if (!select.value) return;
      await wfPost('link', { id: select.value, meetingId: id }); await load(); wfRender();
    }));
    workflowDialog.appendChild(link);
  }
}
// 날짜 내림차순, 같은 날은 시간 오름차순 — 하루 안에서는 회의 순서대로 처리한다.
const wfMeetingOrder = (a, b) => (b.date || '').localeCompare(a.date || '') || (a.start || '').localeCompare(b.start || '');
const wfNextReview = currentId => workflowData.meetings.filter(event => event.id !== currentId && event.drafts?.length).sort(wfMeetingOrder)[0];
// 방금 초안을 담은 회의라면: 어디로 갔는지, 되돌리기, 다음 검토할 회의.
// 결과 카드의 할 일 줄: created(서버가 만든 항목 번호)와 accepted(보낸 초안)는 같은 순서다. 오늘 할 일에 있는지(처음부터 오늘이었거나 방금 올렸거나)도 함께.
const wfResultTasks = result => result.accepted.map((item, index) => ({ item, itemId: result.created[index] })).filter(({ item }) => item.type === 'task')
  .map(({ item, itemId }) => ({ itemId, description: item.description, today: item.when === 'today' || (result.promoted || []).includes(itemId) }));
// 나중에 담긴 할 일을 오늘 할 일로 올린다(창 안에서 결과를 보여 주니 저장 알림은 끈다).
async function wfPromote(result, ids) {
  for (const itemId of ids) {
    await request('/api/track/set-scheduled', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: itemId, scheduled: todayStr() }), quiet: true });
    (result.promoted ||= []).push(itemId);
  }
  await load(); wfRender();
}
// 방금 초안을 담은 회의라면: 결과 한 줄, 나중에 담긴 할 일을 오늘로 올리는 버튼, 되돌리기, 다음 검토할 회의. 가장 조용하게.
function wfResult(event) {
  const result = workflowView.result;
  if (!result || result.meetingId !== event.id) return;
  const box = wfNode('div', undefined, 'wf-result');
  box.setAttribute('role', 'status');
  const head = wfNode('div', undefined, 'wf-result-head');
  head.appendChild(wfNode('strong', `✓ ${result.created.length}개 담음`, 'wf-result-title'));
  head.appendChild(wfNode('span', WF_TYPES.map(([type, label]) => [label, result.accepted.filter(item => item.type === type).length]).filter(([, count]) => count).map(([label, count]) => `${label} ${count}`).join(' · '), 'wf-result-counts'));
  head.appendChild(wfButton('실행 취소', async () => {
    const undo = await wfPost('review-undo', { meetingId: event.id, created: result.created });
    if (!undo.ok) throw new Error(undo.error || '되돌리지 못했습니다.');
    result.accepted.forEach(item => wfDraftEdits.set(item.id, { type: item.type, description: item.description, when: item.when || 'later', due: item.due || '' }));
    delete workflowView.result;
    await load(); wfRender(); announce('담은 것을 되돌렸습니다.');
  }, 'wf-result-undo'));
  box.appendChild(head);

  // 할 일은 기본이 "나중"으로 담기니, 이 자리에서 바로 오늘로 올릴 수 있게 한다. 셋까지는 줄마다, 그 이상은 한 줄로 묶는다.
  const tasks = wfResultTasks(result);
  const later = tasks.filter(task => !task.today);
  if (tasks.length && tasks.length <= 3) {
    tasks.forEach(task => {
      const row = wfNode('div', undefined, 'wf-result-task');
      row.append(wfNode('span', '할 일', 'wf-tag wf-tag-task'), wfNode('span', task.description, 'wf-result-task-text'));
      row.appendChild(task.today ? wfNode('span', '오늘 할 일 ✓', 'wf-result-note') : wfButton('오늘로', () => wfPromote(result, [task.itemId]), 'wf-result-up'));
      box.appendChild(row);
    });
  } else if (tasks.length) {
    const row = wfNode('div', undefined, 'wf-result-task');
    row.append(wfNode('span', '할 일', 'wf-tag wf-tag-task'), wfNode('span', later.length ? `나중에 담긴 할 일 ${later.length}개` : `할 일 ${tasks.length}개`, 'wf-result-task-text'));
    row.appendChild(later.length ? wfButton('모두 오늘로', () => wfPromote(result, later.map(task => task.itemId)), 'wf-result-up') : wfNode('span', '오늘 할 일 ✓', 'wf-result-note'));
    box.appendChild(row);
  }

  const next = wfNextReview(event.id);
  const foot = wfNode('div', undefined, 'wf-result-next');
  if (next) foot.appendChild(wfButton(`다음: ${next.title} (초안 ${next.drafts.length}) →`, () => wfOpen({ kind: 'meeting', id: next.id }), 'wf-result-link'));
  else foot.appendChild(wfNode('span', '오늘 검토할 초안을 모두 처리했습니다.', 'wf-result-note'));
  box.appendChild(foot);
  workflowDialog.appendChild(box);
}
function wfDrafts(event) {
  const summary = wfNode('span', undefined, 'wf-draft-summary');
  const refreshSummary = () => {
    const counts = {};
    let today = 0;
    event.drafts.forEach(draft => {
      const edit = wfDraftEdits.get(draft.id);
      counts[edit.type] = (counts[edit.type] || 0) + 1;
      if (edit.type === 'task' && edit.when === 'today') today++;
    });
    summary.textContent = WF_TYPES.filter(([key]) => counts[key]).map(([key, label]) => `${label} ${counts[key]}${key === 'task' && today ? `(오늘 ${today})` : ''}`).join(' · ');
  };
  // 카드 하나 = 초안 한 건. 읽는 순서대로: 문구(주인공) → 고르는 것들(종류·시점·날짜).
  // 문구는 여러 줄로 늘어나는 입력칸에 전부 보인다. 한 줄 입력칸일 때는 긴 문구의 끝이 잘렸다.
  const cards = event.drafts.map(draft => {
    const edit = wfDraftEdits.get(draft.id) || { type: draft.type, description: wfCleanDraftText(draft.description), when: 'later', due: draft.due || '' };
    wfDraftEdits.set(draft.id, edit);
    const card = wfNode('div', undefined, 'wf-draft');
    card.dataset.type = edit.type;

    const dismiss = wfButton('✕', async () => {
      await wfReview({ meetingId: event.id, dismiss: [draft.id] });
      wfDraftEdits.delete(draft.id); await load(); wfRender();
    }, 'wf-draft-dismiss');
    dismiss.setAttribute('aria-label', `빼기: ${edit.description}`);
    dismiss.title = '이 초안 빼기';

    const description = document.createElement('textarea');
    description.className = 'wf-draft-text'; description.rows = 1; description.maxLength = 1000;
    description.value = edit.description;
    description.setAttribute('aria-label', '내용');
    const fit = () => { description.style.height = 'auto'; description.style.height = `${description.scrollHeight + description.offsetHeight - description.clientHeight}px`; };
    description.addEventListener('input', () => {
      // 문구는 한 줄이다: 붙여넣은 줄바꿈은 공백으로
      if (description.value.includes('\n')) description.value = description.value.replace(/\s*\n\s*/g, ' ');
      edit.description = description.value; fit();
    });
    description.addEventListener('keydown', event => { if (event.key === 'Enter') event.preventDefault(); });

    const controls = wfNode('div', undefined, 'wf-draft-controls');
    const whenSeg = wfSegment([['later', '나중에 할 일'], ['today', '오늘 할 일']], edit.when || 'later', key => { edit.when = key; refreshSummary(); }, '언제 할 일로 담을까');
    whenSeg.title = '나중: 나중에 할 일로 담김 · 오늘: 오늘 할 일로 담김';
    const dateSlot = wfNode('span', undefined, 'wf-date-slot');
    const syncWhen = () => { whenSeg.hidden = edit.type !== 'task'; };
    const syncDate = () => {
      dateSlot.replaceChildren();
      const label = wfDateLabel(edit.type);
      if (label) dateSlot.appendChild(wfDateField(edit.due || '', label, value => { edit.due = value; }));
    };
    controls.append(wfTypeSegment(edit.type, key => { edit.type = key; card.dataset.type = key; syncWhen(); syncDate(); refreshSummary(); }), whenSeg, dateSlot);
    syncWhen(); syncDate();

    card.append(dismiss, description, controls);
    requestAnimationFrame(fit);
    return card;
  });
  workflowDialog.append(...cards);
  refreshSummary();
  const actions = wfNode('div', undefined, 'wf-actions wf-draft-actions');
  actions.appendChild(summary);
  actions.appendChild(wfButton(`${event.drafts.length}개 담기`, async () => {
    const accept = event.drafts.map(draft => wfAcceptItem(draft.id, wfDraftEdits.get(draft.id)));
    if (accept.some(item => !item.description)) { workflowDialog.querySelector('.wf-error').textContent = '비어 있는 문구가 있습니다. 채우거나 ✕로 빼 주세요.'; return; }
    const result = await wfReview({ meetingId: event.id, accept });
    workflowView.result = { meetingId: event.id, created: result.created, accepted: accept };
    accept.forEach(item => wfDraftEdits.delete(item.id));
    await load(); wfRender(); // 결과 카드(role=status)가 담은 결과를 알려 주므로 따로 알림을 띄우지 않는다
  }, 'wf-primary'));
  workflowDialog.appendChild(actions);
}
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
  // 날짜·동기화 표시 줄에 검색 버튼이 끼어 있으면 성격이 다른 것들이 뒤섞여 보인다 —
  // 환경설정 톱니바퀴 옆, 헤더 우측의 아이콘 버튼 자리를 그대로 쓴다(같은 자리, 같은 모양).
  const searchEntryBtn = document.getElementById('searchEntryBtn');
  if (searchEntryBtn && !searchEntryBtn.dataset.wired) {
    searchEntryBtn.dataset.wired = 'true';
    searchEntryBtn.addEventListener('click', () => wfOpen({ kind: 'search', query: '' }));
  }
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
  let reminder = document.getElementById('wfFollowUps');
  if (!reminder) { reminder = wfNode('div'); reminder.id = 'wfFollowUps'; document.getElementById('waitingList').before(reminder); }
  const checks = workflowData.items.filter(item => item.type === 'check' && item.status !== 'done' && item.followUp && item.followUp <= data.today && item.contacted !== data.today);
  const ready = workflowData.items.filter(item => ['task', 'bug'].includes(item.type) && item.status !== 'done' && item.blockedBy && wfItem(item.blockedBy)?.status === 'done');
  reminder.replaceChildren();
  if (checks.length) { reminder.appendChild(wfNode('h3', '다시 확인할 항목')); reminder.appendChild(wfItemList(checks)); }
  if (ready.length) { reminder.appendChild(wfNode('h3', '답변이 해결된 업무')); reminder.appendChild(wfItemList(ready)); }
}

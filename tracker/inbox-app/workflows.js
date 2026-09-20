let workflowData = { items: [], meetings: [] };
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
const wfItem = id => workflowData.items.find(item => item.id === id);
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
      if (region) region.textContent = '저장하지 못했습니다. 입력 내용을 확인하고 다시 시도해 주세요.';
    } finally { button.disabled = false; }
  });
  return button;
}
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
  const title = view.kind === 'search' ? '통합 검색' : view.kind === 'meetings' ? '회의 모아보기' : view.kind === 'projects' ? '프로젝트 모아보기' : view.kind === 'project' ? wfProjects().find(([key]) => key === view.key)?.[1] || view.key : view.kind === 'meeting' ? '회의 정리' : '항목 상세';
  header.append(wfNode('h2', title), wfButton('닫기', () => workflowDialog.close()));
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
  if (view.kind === 'item') wfItemView(view.id);
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
    const meetings = (!type.value || type.value === 'meeting') ? workflowData.meetings.filter(event => wfSearchMatches(search.value, [event.title, event.series, event.date, event.project?.label, ...(event.drafts || []).map(draft => draft.description), ...workflowData.items.filter(item => item.meetingId === event.id).map(item => item.description)])) : [];
    count.textContent = matches.length + meetings.length ? `${matches.length + meetings.length}개 찾음` : '검색 결과가 없습니다.';
    matches.forEach(item => {
      const status = item.status === 'done' ? '완료' : item.doing ? '진행중' : '미완료';
      results.appendChild(wfRow(item.description, `${wfType(item.type)} · ${item.label || item.group || item.project || '그룹 없음'} · ${status}${item.outcome ? ` · ${item.outcome}` : ''}`, () => wfOpen({ kind: 'item', id: item.id })));
    });
    meetings.forEach(event => results.appendChild(wfMeetingRow(event)));
  }
  search.addEventListener('input', render); type.addEventListener('change', render); hideDone.addEventListener('change', render); render();
  search.focus();
  workflowDialog.scrollTop = workflowView.scroll || 0;
}

function taskSelectionRefresh() {
  const container = document.getElementById('taskBatchTools');
  if (!container) return;
  container.hidden = !planningMode;
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
    taskSelectionMode = !taskSelectionMode; taskSelection.clear(); closeTaskDetail();
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
function wfItemRow(item) {
  const blocker = item.blockedBy && wfItem(item.blockedBy);
  const state = item.status === 'done' ? '완료' : blocker?.status !== 'done' && blocker ? '답변 대기' : item.doing ? '진행중' : '미완료';
  return wfRow(item.description, `${wfType(item.type)} · ${state}${item.outcome ? ` · ${item.outcome}` : ''}`, () => wfOpen({ kind: 'item', id: item.id }));
}
function wfMeetingStats(event) {
  const items = workflowData.items.filter(item => item.meetingId === event.id);
  const tasks = items.filter(item => ['task', 'bug'].includes(item.type));
  const waiting = items.filter(item => item.type === 'check' && item.status !== 'done').length;
  const decisions = items.filter(item => item.type === 'decision').length;
  const review = event.drafts?.length ? ` · 검토 대기 ${event.drafts.length}개` : '';
  return `${event.date} ${event.start}${review} · 할 일 ${tasks.filter(item => item.status === 'done').length}/${tasks.length} 완료 · 확인 대기 ${waiting}개 · 결정 ${decisions}개`;
}
function wfMeetingRow(event) { return wfRow(event.title, wfMeetingStats(event), () => wfOpen({ kind: 'meeting', id: event.id })); }
function wfMeetingList() {
  const filters = wfNode('div', undefined, 'wf-filters');
  const search = document.createElement('input'); search.type = 'search'; search.value = workflowView.query || '';
  wfField(filters, '제목·시리즈 검색', search);
  const project = wfField(filters, '프로젝트', wfSelect([['', '전체 프로젝트'], ...wfProjects()], workflowView.project));
  const unresolved = document.createElement('input'); unresolved.type = 'checkbox'; unresolved.checked = !!workflowView.unresolved;
  const checkLabel = wfField(filters, '미해결 항목 있음', unresolved).parentElement; checkLabel.className = 'wf-check';
  workflowDialog.appendChild(filters);
  const list = wfNode('div'); workflowDialog.appendChild(list);
  function render() {
    Object.assign(workflowView, { query: search.value, project: project.value, unresolved: unresolved.checked });
    const events = workflowData.meetings.filter(event => `${event.title} ${event.series}`.toLowerCase().includes(search.value.toLowerCase()) && (!project.value || wfMeetingKey(event) === project.value) && (!unresolved.checked || workflowData.items.some(item => item.meetingId === event.id && item.status !== 'done')));
    list.replaceChildren(...events.map(wfMeetingRow));
    if (!events.length) list.appendChild(wfNode('p', '조건에 맞는 회의가 없습니다.', 'wf-section-note'));
  }
  search.addEventListener('input', render); project.addEventListener('change', render); unresolved.addEventListener('change', render); render();
}
function wfProject(key) {
  const items = workflowData.items.filter(item => wfKey(item) === key);
  for (const [title, filter] of [['진행할 업무', item => ['task', 'bug'].includes(item.type) && item.status !== 'done'], ['확인 대기', item => item.type === 'check' && item.status !== 'done'], ['최근 결정', item => item.type === 'decision'], ['아이디어', item => item.type === 'idea'], ['완료한 업무', item => ['task', 'bug'].includes(item.type) && item.status === 'done']]) {
    const matches = items.filter(filter).sort((a, b) => (b.created || '').localeCompare(a.created || ''));
    if (!matches.length) continue;
    workflowDialog.appendChild(wfNode('h3', `${title} · ${matches.length}`));
    matches.forEach(item => workflowDialog.appendChild(wfItemRow(item)));
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
  workflowDialog.append(wfNode('h3', event.title), when);
  // 프로젝트 연결은 캘린더 카드의 ⋮ → "프로젝트 연결"에서 이미 한다(거기서 하면 두 저장소에
  // 다 반영되지만, 여기서 따로 저장하면 한쪽에만 반영돼서 서로 어긋났다) — 그래서 여기선 뺐다.
  // "반복 회의 시리즈"도 같은 이유로 뺐다: 프로젝트 연결이 이미 회의 제목 기준으로 자동 이어진다.
  if (event.drafts?.length) wfDrafts(event);
  workflowDialog.appendChild(wfNode('h3', '이 회의에서 나온 것'));
  const items = workflowData.items.filter(item => item.meetingId === id);
  items.forEach(item => workflowDialog.appendChild(wfItemRow(item)));
  if (!items.length) workflowDialog.appendChild(wfNode('p', '아직 기록한 항목이 없습니다.', 'wf-section-note'));
  // 종류·내용·추가를 한 줄로 — 세로로 쌓인 라벨 3단짜리 폼 대신 인박스 빠른입력과 같은 모양.
  const form = wfNode('form', undefined, 'wf-capture-row');
  const type = wfSelect([['task', '할 일'], ['decision', '결정'], ['check', '확인 대기']], 'task');
  type.setAttribute('aria-label', '담을 종류');
  form.appendChild(type);
  const description = document.createElement('input'); description.required = true; description.maxLength = 1000;
  description.placeholder = '회의에서 나온 내용';
  description.setAttribute('aria-label', '회의에서 나온 내용');
  form.appendChild(description);
  const submit = wfNode('button', '추가', 'wf-capture-add'); submit.type = 'submit'; form.appendChild(submit);
  form.addEventListener('submit', async e => {
    e.preventDefault(); if (!description.value.trim() || submit.disabled) return;
    submit.disabled = true;
    try { await wfPost('capture', { meetingId: id, type: type.value, description: description.value }); await load(); wfRender(); }
    catch { workflowDialog.querySelector('.wf-error').textContent = '추가하지 못했습니다. 입력 내용은 유지됩니다.'; submit.disabled = false; }
  });
  workflowDialog.appendChild(form);
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
function wfDrafts(event) {
  workflowDialog.appendChild(wfNode('h3', `AI가 분류한 것 · 검토 전 ${event.drafts.length}`));
  workflowDialog.appendChild(wfNode('p', '종류와 문구를 고친 뒤 담으면 각 목록으로 들어갑니다. 할 일은 나중에 할 일로 담깁니다.', 'wf-section-note'));
  const rows = event.drafts.map(draft => {
    const edit = wfDraftEdits.get(draft.id) || { type: draft.type, description: draft.description };
    wfDraftEdits.set(draft.id, edit);
    const row = wfNode('div', undefined, 'wf-capture-row wf-draft-row');
    const type = wfSelect([['task', '할 일'], ['decision', '결정'], ['check', '확인 대기']], edit.type);
    type.setAttribute('aria-label', '종류');
    type.addEventListener('change', () => { edit.type = type.value; });
    const description = document.createElement('input'); description.value = edit.description; description.maxLength = 1000;
    description.setAttribute('aria-label', '내용');
    description.addEventListener('input', () => { edit.description = description.value; });
    const dismiss = wfButton('✕', async () => {
      await wfReview({ meetingId: event.id, dismiss: [draft.id] });
      wfDraftEdits.delete(draft.id); await load(); wfRender();
    }, 'wf-draft-dismiss');
    dismiss.setAttribute('aria-label', `빼기: ${edit.description}`);
    row.append(type, description);
    if (draft.due) row.appendChild(wfNode('span', `마감 ${draft.due.slice(5).replace('-', '/')}`, 'wf-meta wf-draft-due'));
    row.appendChild(dismiss);
    return row;
  });
  workflowDialog.append(...rows);
  const actions = wfNode('div', undefined, 'wf-actions wf-draft-actions');
  actions.appendChild(wfButton(`${event.drafts.length}개 담기`, async () => {
    const accept = event.drafts.map(draft => ({ id: draft.id, ...wfDraftEdits.get(draft.id), description: wfDraftEdits.get(draft.id).description.trim() }));
    if (accept.some(item => !item.description)) { workflowDialog.querySelector('.wf-error').textContent = '비어 있는 문구가 있습니다. 채우거나 ✕로 빼 주세요.'; return; }
    await wfReview({ meetingId: event.id, accept });
    accept.forEach(item => wfDraftEdits.delete(item.id));
    await load(); wfRender(); announce(`${accept.length}개를 담았습니다.`);
  }));
  workflowDialog.appendChild(actions);
}
async function wfReview(body) {
  const result = await wfPost('review', body);
  if (!result.ok) throw new Error(result.error || '검토 결과를 저장하지 못했습니다.');
  return result;
}
function workflowFields(item, parent) {
  item = wfItem(item.id) || item;
  const fields = wfNode('div', undefined, 'wf-fields');
  const patch = { id: item.id };
  let blockedBy, outcome, followUp;
  if (['task', 'bug'].includes(item.type || 'task')) {
    const related = item.blockedBy && wfItem(item.blockedBy);
    if (item.blockedBy) fields.appendChild(related
      ? wfButton(`${related.status === 'done' ? '답변 해결' : '답변 대기'} · ${related.description}`, () => wfOpen({ kind: 'item', id: related.id }), 'wf-link')
      : wfNode('p', '연결했던 확인 대기가 삭제되었습니다.', 'wf-section-note'));
    if (item.outcome) fields.appendChild(wfNode('p', item.outcome, 'wf-section-note'));
    const extra = wfNode('details', undefined, 'wf-optional');
    extra.appendChild(wfNode('summary', item.blockedBy || item.outcome ? '답변 대기·결과 편집' : '답변 대기·결과 추가'));
    extra.open = !!(workflowView?.kind === 'item' && workflowView.id === item.id && workflowView.editOutcome);
    fields.appendChild(extra);
    const checks = workflowData.items.filter(check => check.type === 'check' && (check.status !== 'done' || check.id === item.blockedBy));
    blockedBy = wfField(extra, '이 답변을 기다리는 중', wfSelect([['', '연결 없음'], ...checks.map(check => [check.id, `${check.status === 'done' ? '해결됨 · ' : ''}${check.description}`])], item.blockedBy));
    outcome = document.createElement('input'); outcome.value = item.outcome || ''; outcome.maxLength = 1000;
    wfField(extra, '결과 한 줄 (선택)', outcome);
  }
  if (item.type === 'check') {
    followUp = document.createElement('input'); followUp.type = 'date'; followUp.value = item.followUp || '';
    wfField(fields, '다시 확인할 날짜', followUp);
    const contact = wfNode('details', undefined, 'wf-optional'); contact.appendChild(wfNode('summary', '확인 요청 기록'));
    contact.appendChild(wfNode('p', item.contacted ? `마지막 확인 요청: ${item.contacted}` : '확인 요청 기록 없음', 'wf-section-note'));
    fields.appendChild(contact);
    contact.appendChild(wfButton('오늘 확인 요청함', async () => {
      await wfPost('item', { id: item.id, contacted: todayStr(), followUp: followUp.value || null });
      await load(); if (workflowDialog) wfRender(); else { fields.remove(); workflowFields(wfItem(item.id), parent); }
      announce('확인 요청을 기록했습니다.');
    }));
  }
  const initial = { blockedBy: blockedBy?.value, outcome: outcome?.value, followUp: followUp?.value };
  const save = async () => {
    const changes = { ...patch };
    if (blockedBy && blockedBy.value !== initial.blockedBy) changes.blockedBy = blockedBy.value || null;
    if (outcome && outcome.value !== initial.outcome) changes.outcome = outcome.value.trim();
    if (followUp && followUp.value !== initial.followUp) changes.followUp = followUp.value || null;
    if (Object.keys(changes).length > 1) await wfPost('item', changes);
  };
  const saveTarget = blockedBy ? fields.querySelector('.wf-optional') : fields;
  if (blockedBy || followUp) saveTarget.appendChild(wfButton('저장', async () => {
    await save(); await load(); if (workflowDialog) wfRender(); announce('저장했습니다.');
  }));
  if (wfKey(item)) fields.appendChild(wfButton('프로젝트 모아보기', () => wfOpen({ kind: 'project', key: wfKey(item) })));
  if (item.meetingId) fields.appendChild(wfButton('이 항목이 나온 회의', () => wfOpen({ kind: 'meeting', id: item.meetingId })));
  parent.appendChild(fields);
  return save;
}
function taskCoreFields(item, parent) {
  const title = document.createElement('input');title.className='task-detail-title-input';title.value=item.description;title.maxLength=1000;title.setAttribute('aria-label','업무 제목');
  title.addEventListener('change',async()=>{const value=title.value.trim();if(!value||value===item.description)return;await postJson('/api/track/set-description',{id:item.id,description:value});await load();});parent.appendChild(title);
  const field=(text,control)=>{const wrap=wfNode('label',text,'detail-field');wrap.appendChild(control);parent.appendChild(wrap);};
  const due=document.createElement('input');due.type='date';due.value=item.due || '';due.addEventListener('change',()=>setTaskDue(item.id,due.value || null));field('마감일',due);
  const scheduled=document.createElement('input');scheduled.type='date';scheduled.value=item.scheduled || '';scheduled.addEventListener('change',()=>setTaskScheduled(item.id,scheduled.value || null));field('실행 예정일',scheduled);
  const priority=renderPriorityBadge(item);priority.className+=' detail-priority';field('우선순위',priority);
  field('그룹',renderGroupControl({jira:item.jira,group:item.group,onSetJira:key=>setTaskJira(item.id,key),onSetGroup:value=>setTaskGroup(item.id,value)}));
}
function wfItemView(id) {
  const item = wfItem(id);
  if (!item) { workflowDialog.appendChild(wfNode('p', '삭제되었거나 찾을 수 없는 항목입니다.')); return; }
  workflowDialog.append(wfNode('h3', item.description), wfNode('p', `${wfType(item.type)} · ${item.status === 'done' ? '완료' : '미완료'}`, 'wf-section-note'));
  if(item.type==='task')taskCoreFields(item,workflowDialog);
  if (item.permalink) { const a = wfNode('a', '슬랙 원문', 'wf-link'); a.href = item.permalink; a.target = '_blank'; a.rel = 'noopener'; a.style.display = 'inline-block'; workflowDialog.appendChild(a); }
  const save = workflowFields(item, workflowDialog);
  const actions = wfNode('div', undefined, 'wf-actions');
  actions.appendChild(wfButton(item.status === 'done' ? '미완료로 되돌리기' : item.type === 'decision' ? 'PRD 반영 완료' : '완료로 표시', async () => {
    await save(); await toggleTask(item.id); wfRender();
  }));
  if (['task', 'bug'].includes(item.type) && item.status !== 'done') actions.appendChild(wfButton('오늘 할 일로', async () => { await setTaskScheduled(item.id, todayStr()); await load(); wfRender(); }));
  workflowDialog.appendChild(actions);
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
    const projects = wfButton('프로젝트 모아보기', () => wfOpen({ kind: 'projects' }), 'wf-link');
    document.getElementById('planningToggle').parentElement.appendChild(projects);
  }
  let reminder = document.getElementById('wfFollowUps');
  if (!reminder) { reminder = wfNode('div'); reminder.id = 'wfFollowUps'; document.getElementById('waitingList').before(reminder); }
  const checks = workflowData.items.filter(item => item.type === 'check' && item.status !== 'done' && item.followUp && item.followUp <= data.today && item.contacted !== data.today);
  const ready = workflowData.items.filter(item => ['task', 'bug'].includes(item.type) && item.status !== 'done' && item.blockedBy && wfItem(item.blockedBy)?.status === 'done');
  reminder.replaceChildren();
  if (checks.length) { reminder.appendChild(wfNode('h3', '다시 확인할 항목')); checks.forEach(item => reminder.appendChild(wfItemRow(item))); }
  if (ready.length) { reminder.appendChild(wfNode('h3', '답변이 해결된 업무')); ready.forEach(item => reminder.appendChild(wfItemRow(item))); }
}

let workflowData = { items: [], meetings: [] };
let workflowDialog = null;
let workflowView = null;
const workflowHistory = [];
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
  } else if (remember && workflowView) workflowHistory.push({ ...workflowView });
  workflowView = view;
  wfRender();
}
function wfRender() {
  if (!workflowDialog) return;
  const view = workflowView;
  workflowDialog.replaceChildren();
  const header = wfNode('div', undefined, 'wf-head');
  if (workflowHistory.length) header.appendChild(wfButton('뒤로', () => wfOpen(workflowHistory.pop(), false)));
  const title = view.kind === 'meetings' ? '회의 모아보기' : view.kind === 'projects' ? '프로젝트 모아보기' : view.kind === 'project' ? wfProjects().find(([key]) => key === view.key)?.[1] || view.key : view.kind === 'meeting' ? '회의 정리' : '항목 상세';
  header.append(wfNode('h2', title), wfButton('닫기', () => workflowDialog.close()));
  workflowDialog.appendChild(header);
  const error = wfNode('p', '', 'wf-error'); error.setAttribute('role', 'alert'); workflowDialog.appendChild(error);
  if (view.kind === 'meetings') wfMeetingList();
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
  return `${event.date} ${event.start} · 할 일 ${tasks.filter(item => item.status === 'done').length}/${tasks.length} 완료 · 확인 대기 ${waiting}개 · 결정 ${decisions}개`;
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
  workflowDialog.append(wfNode('h3', event.title), wfNode('p', `${event.date} · ${event.start}–${event.end}`, 'wf-section-note'));
  const settings = wfNode('details'); settings.appendChild(wfNode('summary', '프로젝트·반복 회의 설정'));
  const project = wfField(settings, '프로젝트', wfSelect([['', '그룹 없음'], ...wfProjects()], wfMeetingKey(event)));
  const series = document.createElement('input'); series.value = event.series || event.title; series.maxLength = 200;
  wfField(settings, '반복 회의 시리즈 이름', series);
  settings.append(wfNode('p', '같은 시리즈 이름의 회의를 함께 봅니다. 별개 회의라면 다른 이름으로 저장하세요.', 'wf-section-note'), wfButton('설정 저장', async () => {
    await wfPost('meeting', { id, project: project.value || null, series: series.value }); await load(); wfRender();
  }));
  workflowDialog.appendChild(settings);
  const previous = workflowData.meetings.filter(other => other.id !== id && other.series === event.series && `${other.date} ${other.start}` < `${event.date} ${event.start}`);
  const unresolved = workflowData.items.filter(item => item.status !== 'done' && previous.some(other => other.id === item.meetingId));
  if (unresolved.length) {
    workflowDialog.appendChild(wfNode('h3', `지난 회의의 미해결 항목 · ${unresolved.length}`));
    unresolved.forEach(item => workflowDialog.appendChild(wfItemRow(item)));
  }
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
  if (previous.length) {
    const history = wfNode('details'); history.appendChild(wfNode('summary', `같은 시리즈의 이전 회의 · ${previous.length}`));
    previous.forEach(other => history.appendChild(wfMeetingRow(other))); workflowDialog.appendChild(history);
  }
}
function workflowFields(item, parent) {
  item = wfItem(item.id) || item;
  const fields = wfNode('div', undefined, 'wf-fields');
  const patch = { id: item.id };
  let blockedBy, outcome, followUp;
  if (['task', 'bug'].includes(item.type || 'task')) {
    const checks = workflowData.items.filter(check => check.type === 'check' && (check.status !== 'done' || check.id === item.blockedBy));
    blockedBy = wfField(fields, '이 답변을 기다리는 중', wfSelect([['', '연결 없음'], ...checks.map(check => [check.id, `${check.status === 'done' ? '해결됨 · ' : ''}${check.description}`])], item.blockedBy));
    if (item.blockedBy && !wfItem(item.blockedBy)) fields.appendChild(wfNode('p', '연결했던 확인 대기가 삭제되었습니다.', 'wf-section-note'));
    outcome = document.createElement('input'); outcome.value = item.outcome || ''; outcome.maxLength = 1000;
    wfField(fields, '결과 한 줄 (선택)', outcome);
  }
  if (item.type === 'check') {
    followUp = document.createElement('input'); followUp.type = 'date'; followUp.value = item.followUp || '';
    wfField(fields, '다시 확인할 날짜', followUp);
    fields.appendChild(wfNode('p', item.contacted ? `마지막 확인 요청: ${item.contacted}` : '확인 요청 기록 없음', 'wf-section-note'));
    fields.appendChild(wfButton('오늘 확인 요청함', async () => {
      await wfPost('item', { id: item.id, contacted: todayStr(), followUp: followUp.value || null });
      await load(); if (workflowDialog) wfRender(); else { fields.remove(); workflowFields(wfItem(item.id), parent); }
      announce('확인 요청을 기록했습니다.');
    }));
  }
  const save = async () => {
    if (blockedBy) Object.assign(patch, { blockedBy: blockedBy.value || null, outcome: outcome.value.trim() });
    if (followUp) patch.followUp = followUp.value || null;
    if (blockedBy || followUp) await wfPost('item', patch);
  };
  if (blockedBy || followUp) fields.appendChild(wfButton('업무 연결 정보 저장', async () => {
    await save(); await load(); if (workflowDialog) wfRender(); announce('저장했습니다.');
  }));
  if (wfKey(item)) fields.appendChild(wfButton('프로젝트 모아보기', () => wfOpen({ kind: 'project', key: wfKey(item) })));
  if (item.meetingId) fields.appendChild(wfButton('이 항목이 나온 회의', () => wfOpen({ kind: 'meeting', id: item.meetingId })));
  parent.appendChild(fields);
  return save;
}
function wfItemView(id) {
  const item = wfItem(id);
  if (!item) { workflowDialog.appendChild(wfNode('p', '삭제되었거나 찾을 수 없는 항목입니다.')); return; }
  workflowDialog.append(wfNode('h3', item.description), wfNode('p', `${wfType(item.type)} · ${item.status === 'done' ? '완료' : '미완료'}`, 'wf-section-note'));
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
  showNotice('완료로 표시했습니다.', false, null, { label: '결과 한 줄 남기기', onClick: () => wfOpen({ kind: 'item', id: item.id }) });
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

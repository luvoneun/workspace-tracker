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
let taskListsCache = { todayTasks: [], laterTasks: [] };
// 검토 중에 고친 종류·문구 — 다른 항목을 빼느라 화면이 다시 그려져도 유지된다.
const wfDraftEdits = new Map();
const wfKey = item => item.jira ? `jira:${item.jira}` : item.group || item.project ? `group:${item.group || item.project}` : null;
// 회의에 붙은 그룹 이름은 파일에 저장된 그대로(`가입_개선`)라 업무 쪽 이름(`가입 개선`)과 글자가 다르다.
// 같은 프로젝트가 목록에 두 번 나오지 않게 여기서 한 가지 꼴로 맞춘다.
const wfGroupName = value => String(value).replace(/_/g, ' ');
const wfMeetingKey = event => event.project ? `${event.project.type}:${event.project.type === 'group' ? wfGroupName(event.project.value) : event.project.value}` : null;
// event.project(`{type, value, label}`)를 uiProjectName이 읽는 모양(item)으로 바꾼다 — 짧은/긴 표기와
// 색 점 키를 한 곳(uiProjectName·uiProjectColorKey)에서 잡게 하려는 것이다.
function wfMeetingProjectItem(event) {
  if (!event || !event.project) return null;
  return event.project.type === 'jira'
    ? { jira: event.project.value }
    : { group: wfGroupName(event.project.label || event.project.value || '') };
}
// 화면에 적는 이름도 같은 꼴로 맞춘다 — 같은 프로젝트가 자리마다 다른 글자·다른 색 점으로 보이지 않게.
// opts 없이 부르면(프로젝트 고르기 선택지처럼 긴 자리) `KEY · 요약`, { short: true }면 요약만(모르면 키).
const wfMeetingProjectName = (event, opts) =>
  (typeof uiProjectName === 'function' ? uiProjectName(wfMeetingProjectItem(event), opts) : '') || '';
// 색 점은 표기와 무관하게 원래 키로 고른다.
const wfMeetingColorKey = (event) =>
  (typeof uiProjectColorKey === 'function' ? uiProjectColorKey(wfMeetingProjectItem(event)) : '');
const wfItem = id => wfItemsById.get(id);
const wfType = type => ({ task: '할 일', bug: '버그', check: '확인 대기', decision: '결정', idea: '아이디어' }[type] || type);
function wfNode(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
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
// 날짜 칸은 앱 공용 부품(uiDateField)을 쓴다 — 비어 있으면 `+ 기한`, 누르면 그 자리에서 고른다.
// 날짜 이름: 할 일은 기한, 확인 대기는 상대에게 답변을 받기로 한 날. 결정에는 날짜가 없다.
const wfDateLabel = type => type === 'check' ? '답변 받을 날' : type === 'decision' ? null : '기한';
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
  workflowData.meetings.forEach(event => {
    const key = wfMeetingKey(event);
    if (!key || projects.has(key)) return;
    const label = event.project.label || event.project.value;
    projects.set(key, event.project.type === 'group' ? wfGroupName(label) : label);
  });
  // `그 밖의 이슈`(extra)는 이미 항목이 걸려 있는 것의 요약을 보여 주려고 들고 있는 것이라
  // 새 프로젝트 후보로 내놓지 않는다 — 항목이 걸려 있으면 위 줄에서 이미 들어왔다.
  jiraIssuesCache.forEach(issue => { if (!issue.extra) projects.set(`jira:${issue.key}`, `${issue.key} · ${issue.summary}`); });
  customGroupsCache.forEach(group => { if (!projects.has(`group:${group}`)) projects.set(`group:${group}`, group); });
  return [...projects].sort((a, b) => a[1].localeCompare(b[1]));
}
function wfSearchMatches(query, values) {
  const haystack = values.filter(Boolean).join(' ').normalize('NFKC').toLocaleLowerCase();
  return query.normalize('NFKC').toLocaleLowerCase().trim().split(/\s+/).every(word => haystack.includes(word));
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
// 날짜 내림차순, 같은 날은 시간 오름차순 — 하루 안에서는 회의 순서대로 처리한다.
const wfMeetingOrder = (a, b) => (b.date || '').localeCompare(a.date || '') || (a.start || '').localeCompare(b.start || '');
const wfNextReview = currentId => workflowData.meetings.filter(event => event.id !== currentId && event.drafts?.length).sort(wfMeetingOrder)[0];
// 결과 카드(panelMeetingResult)의 할 일 줄: created(서버가 만든 항목 번호)와 accepted(보낸 초안)는 같은 순서다. 오늘 할 일에 있는지(처음부터 오늘이었거나 방금 올렸거나)도 함께.
const wfResultTasks = result => result.accepted.map((item, index) => ({ item, itemId: result.created[index] })).filter(({ item }) => item.type === 'task')
  .map(({ item, itemId }) => ({ itemId, description: item.description, today: item.when === 'today' || (result.promoted || []).includes(itemId) }));
async function wfReview(body) {
  const result = await wfPost('review', body);
  if (!result.ok) throw new Error(result.error || '검토 결과를 저장하지 못했어요.');
  return result;
}
function workflowOutcome(item) {
  showNotice('완료했어요', false, null, { label: '결과 한 줄 남기기', onClick: () => panelOpen({ id: item.id }) });
}
function workflowRender(data) {
  workflowData = data.workflows || { items: [], meetings: [] };
  wfIndexData();
  taskListsCache = { todayTasks: data.todayTasks || [], laterTasks: data.laterTasks || [] };
  // 지워졌거나 완료된 업무는 일괄 선택에서 조용히 빠진다.
  const available = new Set([...taskListsCache.todayTasks, ...taskListsCache.laterTasks].filter(item => item.status !== 'done').map(item => item.id));
  for (const id of taskSelection) if (!available.has(id)) taskSelection.delete(id);
  // 레일의 `오늘 미팅` 머리에 붙는 회의 전체 보기 — 몰아서 정리하는 면인 `회의` 탭으로 간다.
  // 버튼은 한 번만 만들고 리스너도 그때 한 번만 단다(종일 띄워 두는 앱이라 쌓이면 안 된다).
  if (!document.getElementById('wfMeetingEntry')) {
    const button = wfNode('button', '전체 보기', 'wf-link'); button.type = 'button'; button.id = 'wfMeetingEntry';
    button.addEventListener('click', () => openMeetingsTab(null));
    document.getElementById('calendarSectionCount').parentElement.appendChild(button);
  }
  // 후속 알림은 따로 나열하지 않는다 — `다시 확인할 항목`은 확인 대기 목록 맨 위로 올라가고
  // (waitingOrder + renderWaitingRow), `답변이 해결된 업무`는 리마인드 카드의 줄이 된다(renderReminders).
}

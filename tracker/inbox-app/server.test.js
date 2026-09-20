const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TZ = 'Asia/Seoul';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-regression-'));
process.env.WORKSPACE_DATA_DIR = directory;
const { server } = require('./server');
const date = value => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
const today = date(new Date());
const shifted = days => { const value = new Date(); value.setDate(value.getDate() + days); return date(value); };
let base;
const tasksPath = path.join(directory, 'tasks.md');
const readTasks = () => fs.readFileSync(tasksPath, 'utf8');
async function post(route, body) {
  const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, ...await response.json() };
}
const items = async () => (await fetch(base + '/api/items')).json();

test('static server denies implementation and private state files', async () => {
  assert.equal((await fetch(base+'/server.js')).status,404);
  assert.equal((await fetch(base+'/.weekly_report_state.json')).status,404);
});
test('cross-origin mutations are rejected',async()=>{
  const response=await fetch(base+'/api/track/toggle',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://untrusted.example'},body:JSON.stringify({id:'legacy'})});
  assert.equal(response.status,403);
});
test('multiline creation fails without changing tasks',async()=>{
  const before=readTasks();assert.equal((await post('/api/today-task/create',{description:'first\nsecond'})).status,400);assert.equal(readTasks(),before);
});
test('explicit completion is safe to retry',async()=>{
  await post('/api/track/toggle',{id:'legacy',status:'done'});await post('/api/track/toggle',{id:'legacy',status:'done'});
  assert.equal((await items()).reportRefs.legacy.status,'done');
});
test('full item reads never create or rewrite weekly report files',async()=>{
  const file=path.join(directory,'weekly_reports.md');const before=fs.existsSync(file)?fs.readFileSync(file,'utf8'):null;await items();assert.equal(fs.existsSync(file)?fs.readFileSync(file,'utf8'):null,before);
});

test('repeated create with a request key creates only once',async()=>{
  const call=()=>fetch(base+'/api/today-task/create',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'fixture-request-0001'},body:JSON.stringify({description:'재시도 업무'})}).then(r=>r.json());
  const a=await call(),b=await call();assert.equal(a.id,b.id);assert.equal(readTasks().split('재시도 업무').length-1,1);
});
test('automation import validates, deduplicates source links, and uses inbox',async()=>{
  const payload={type:'task',description:'자동화 수집',permalink:'https://example.test/import-fixture'};
  const a=await post('/api/import',{kind:'item',payload});const b=await post('/api/import',{kind:'item',payload:{...payload,description:'다시 표현'}});
  assert.equal(a.ok,true);assert.equal(a.id,b.id);assert.equal(b.duplicate,true);assert.ok((await items()).inboxTasks.some(item=>item.id===a.id));
  const before=readTasks();assert.equal((await post('/api/import',{kind:'item',payload:{...payload,description:'줄\n바꿈'}})).status,400);assert.equal(readTasks(),before);
});
test('a successful Slack channel cannot conceal another channel failure',async()=>{
  await post('/api/import',{kind:'health',payload:{channel:'my-todo',success:false,error:'fixture failure'}});
  await post('/api/import',{kind:'health',payload:{channel:'my-align',success:true}});
  const state=JSON.parse(fs.readFileSync(path.join(directory,'.slack_capture_state.json'),'utf8'));assert.match(state.lastError,/my-todo/);
});

before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(directory, { recursive: true });
});
beforeEach(() => {
  fs.writeFileSync(path.join(directory, '.workflow.json'), JSON.stringify({ items: {}, meetings: {} }));
  fs.writeFileSync(tasksPath, `# Tasks\n- Legacy overdue #task[id:legacy status:to-do priority:high created:${shifted(-4)} due:${shifted(-2)} source:slack:https://example.test/message]\n- New unseen #task[id:unseen status:to-do priority:medium created:${today} scheduled:${today} source:slack:https://example.test/another]\n`);
});

test('workflow metadata validates links and dates and survives item completion', async () => {
  const check = await post('/api/waiting/create', { description: '담당자 확인' });
  assert.equal((await post('/api/workflow/item', { id: check.id, followUp: today, contacted: today })).ok, true);
  assert.equal((await post('/api/workflow/item', { id: 'legacy', blockedBy: check.id, outcome: '담당자 확정' })).ok, true);
  const before = fs.readFileSync(path.join(directory, '.workflow.json'), 'utf8');
  assert.equal((await post('/api/workflow/item', { id: check.id, followUp: '2026-02-30' })).status, 400);
  assert.equal((await post('/api/workflow/item', { id: 'legacy', blockedBy: 'unseen' })).status, 400);
  assert.equal(fs.readFileSync(path.join(directory, '.workflow.json'), 'utf8'), before);
  await post('/api/track/toggle', { id: check.id });
  const data = (await items()).workflows;
  assert.equal(data.items.find(item => item.id === 'legacy').blockedBy, check.id);
  assert.equal(data.items.find(item => item.id === check.id).status, 'done');
});

test('meeting capture persists across calendar rollover and resolves live completion state', async () => {
  fs.writeFileSync(path.join(directory, 'calendar_today.md'), `마지막 갱신: ${today}\n- 10:00-11:00 | 반복 회의\n- 14:00-15:00 | 반복 회의\n`);
  const events = (await items()).workflows.meetings;
  assert.equal(events.length, 2);
  assert.notEqual(events[0].id, events[1].id);
  const meeting = events[0];
  await post('/api/workflow/meeting', { id: meeting.id, project: 'group:기획', series: '기획 주간회의' });
  const created = await post('/api/workflow/capture', { meetingId: meeting.id, type: 'task', description: '후속 작업' });
  assert.equal(created.ok, true);
  fs.writeFileSync(path.join(directory, 'calendar_today.md'), `마지막 갱신: ${shifted(1)}\n- 10:00-11:00 | 새로운 회의\n`);
  await post('/api/track/toggle', { id: created.id });
  const data = (await items()).workflows;
  assert.equal(data.meetings.find(event => event.id === meeting.id).series, '기획 주간회의');
  assert.equal(data.items.find(item => item.id === created.id).meetingId, meeting.id);
  assert.equal(data.items.find(item => item.id === created.id).group, '기획');
  assert.equal(data.items.find(item => item.id === created.id).status, 'done');
  const original = readTasks();
  assert.equal((await post('/api/workflow/capture', { meetingId: 'missing', type: 'task', description: '생성 금지' })).status, 400);
  assert.equal(readTasks(), original);
});

test('completed outcome is used in new weekly summary entries without rewriting existing notes', async () => {
  fs.writeFileSync(path.join(directory, 'weekly_reports.md'), '# Weekly Reports\n');
  await post('/api/workflow/item', { id: 'legacy', outcome: '디자인 전달일 금요일로 확정' });
  await post('/api/track/toggle', { id: 'legacy' });
  await post('/api/weekly-report/refresh', {});
  assert.match((await items()).weeklyReports[0].body, /디자인 전달일 금요일로 확정 \^legacy/);
  await post('/api/workflow/item', { id: 'legacy', outcome: '수정한 결과' });
  await post('/api/weekly-report/refresh', {});
  assert.match((await items()).weeklyReports[0].body, /디자인 전달일 금요일로 확정 \^legacy/);
});

test('workflow GET remains read-only', async () => {
  const before = fs.readFileSync(path.join(directory, '.workflow.json'), 'utf8');
  await items();
  assert.equal(fs.readFileSync(path.join(directory, '.workflow.json'), 'utf8'), before);
});

test('existing items can be linked to a meeting without duplication or reassignment', async () => {
  fs.writeFileSync(path.join(directory, 'calendar_today.md'), `마지막 갱신: ${today}\n- 10:00-11:00 | 회의 A\n- 14:00-15:00 | 회의 B\n`);
  const events = (await items()).workflows.meetings;
  const original = readTasks();
  assert.equal((await post('/api/workflow/link', { id: 'legacy', meetingId: events[0].id })).ok, true);
  assert.equal((await post('/api/workflow/link', { id: 'legacy', meetingId: events[1].id })).status, 400);
  assert.equal(readTasks(), original);
  assert.equal((await items()).workflows.items.find(item => item.id === 'legacy').meetingId, events[0].id);
});

test('calendar archive preserves meetings without captured items and reads do not write', () => {
  let events = [{ title: '기록할 회의', start: '09:00', end: '10:00' }];
  const store = require('./workflow-store')({ directory, refs: () => ({}), calendar: () => ({ events }), today: () => today });
  store.archive();
  const before = fs.readFileSync(path.join(directory, '.workflow.json'), 'utf8');
  events = [];
  store.archive();
  assert.equal(store.snapshot().meetings.length, 1);
  assert.equal(fs.readFileSync(path.join(directory, '.workflow.json'), 'utf8'), before);
});

test('GET is read-only and does not clear unread flags or overwrite overdue deadlines', async () => {
  const original = readTasks();
  const first = await items();
  const second = await items();
  assert.equal(readTasks(), original);
  assert.equal(first.todayTasks.find(item => item.id === 'legacy').due, shifted(-2));
  assert.equal(second.todayTasks.find(item => item.id === 'legacy').isNew, true);
});

test('batch rescheduling preserves deadlines and undo restores legacy schedules', async () => {
  const changed = await post('/api/workflow/task-batch', { ids: ['legacy', 'unseen'], change: { scheduled: shifted(1) } });
  assert.equal(changed.ok, true);
  let data = await items();
  assert.equal(data.laterTasks.find(item => item.id === 'legacy').due, shifted(-2));
  assert.equal(data.laterTasks.find(item => item.id === 'unseen').scheduled, shifted(1));
  const restored = await post('/api/workflow/task-batch', { undoToken: changed.undoToken });
  assert.equal(restored.ok, true);
  data = await items();
  assert.equal(data.todayTasks.find(item => item.id === 'legacy').scheduled, shifted(-2));
  assert.doesNotMatch(readTasks().split('\n').find(line => line.includes('id:legacy')), /scheduled:/);
  assert.equal((await post('/api/workflow/task-batch', { undoToken: restored.undoToken })).ok, true);
  assert.equal((await items()).laterTasks.find(item => item.id === 'legacy').scheduled, shifted(1));
});

test('invalid batch targets and dates never partially modify tasks', async () => {
  const original = readTasks();
  assert.equal((await post('/api/workflow/task-batch', { ids: ['legacy', 'missing'], change: { project: 'group:수정 금지' } })).status, 400);
  assert.equal((await post('/api/workflow/task-batch', { ids: ['legacy', 'unseen'], change: { scheduled: '2026-02-30' } })).status, 400);
  assert.equal((await post('/api/workflow/task-batch', { ids: ['legacy', 'legacy'], change: { scheduled: today } })).status, 400);
  assert.equal(readTasks(), original);
});

test('batch group undo preserves later title edits but rejects conflicting group edits', async () => {
  await post('/api/track/set-jira', { id: 'legacy', jiraKey: 'IO-123' });
  const changed = await post('/api/workflow/task-batch', { ids: ['legacy', 'unseen'], change: { project: 'group:새 그룹' } });
  assert.equal(changed.ok, true);
  assert.equal((await items()).todayTasks.find(item => item.id === 'legacy').jira, null);
  await post('/api/track/set-description', { id: 'legacy', description: '나중에 수정한 제목' });
  assert.equal((await post('/api/workflow/task-batch', { undoToken: changed.undoToken })).ok, true);
  const task = (await items()).todayTasks.find(item => item.id === 'legacy');
  assert.equal(task.description, '나중에 수정한 제목');
  assert.equal(task.jira, 'IO-123');
  const changedAgain = await post('/api/workflow/task-batch', { ids: ['legacy', 'unseen'], change: { project: null } });
  await post('/api/track/set-group', { id: 'unseen', group: '다른 편집' });
  const beforeUndo = readTasks();
  assert.equal((await post('/api/workflow/task-batch', { undoToken: changedAgain.undoToken })).status, 400);
  assert.equal(readTasks(), beforeUndo);
});

test('acknowledgement affects only the requested item', async () => {
  assert.equal((await post('/api/track/seen', { id: 'legacy' })).ok, true);
  const data = await items();
  assert.equal(data.todayTasks.find(item => item.id === 'legacy').isNew, false);
  assert.equal(data.todayTasks.find(item => item.id === 'unseen').isNew, true);
});

test('rescheduling and removing a schedule preserve the deadline', async () => {
  await post('/api/track/set-scheduled', { id: 'legacy', scheduled: shifted(1) });
  let item = (await items()).laterTasks.find(item => item.id === 'legacy');
  assert.equal(item.scheduled, shifted(1));
  assert.equal(item.due, shifted(-2));
  await post('/api/track/set-scheduled', { id: 'legacy', scheduled: null });
  item = (await items()).laterTasks.find(item => item.id === 'legacy');
  assert.equal(item.scheduled, null);
  assert.equal(item.due, shifted(-2));
});

test('editing a legacy deadline does not change its execution day', async () => {
  await post('/api/track/set-due', { id: 'legacy', due: shifted(7) });
  const item = (await items()).todayTasks.find(item => item.id === 'legacy');
  assert.equal(item.scheduled, shifted(-2));
  assert.equal(item.due, shifted(7));
});

test('new today tasks have a schedule without an artificial deadline', async () => {
  const created = await post('/api/today-task/create', { description: 'New task' });
  assert.equal(created.status, 200);
  const item = (await items()).todayTasks.find(item => item.id === created.id);
  assert.equal(item.scheduled, today);
  assert.equal(item.due, undefined);
});

test('invalid schedules do not modify stored data', async () => {
  const original = readTasks();
  assert.equal((await post('/api/track/set-scheduled', { id: 'legacy', scheduled: '2026-02-30' })).status, 400);
  assert.equal(readTasks(), original);
});

test('completion uses the completion day rather than the deadline', async () => {
  await post('/api/track/toggle', { id: 'legacy' });
  assert.match(readTasks(), new RegExp(`completed:${today}`));
  assert.equal((await items()).todayTasks.find(item => item.id === 'legacy').status, 'done');
});

test('delete and undo restore the exact original line and position', async () => {
  const original = readTasks();
  await post('/api/track/remove', { id: 'legacy' });
  assert.doesNotMatch(readTasks(), /id:legacy/);
  assert.equal((await post('/api/track/restore', { id: 'legacy' })).ok, true);
  assert.equal(readTasks(), original);
});

test('stale calendar data is not presented as today’s meetings', async () => {
  fs.writeFileSync(path.join(directory, 'calendar_today.md'), `마지막 갱신: ${shifted(-1)}\n- 10:00-11:00 | Old meeting\n`);
  let calendar = (await items()).calendar;
  assert.equal(calendar.stale, true);
  assert.equal(calendar.events.length, 0);
  fs.writeFileSync(path.join(directory, 'calendar_today.md'), `마지막 갱신: ${today}\n- 10:00-11:00 | Today meeting\n`);
  calendar = (await items()).calendar;
  assert.equal(calendar.stale, false);
  assert.equal(calendar.events[0].end, '11:00');
});

test('weekly refresh never auto-fills next-week plans and preserves hand-picked plans', async () => {
  const nextMonday = new Date();
  nextMonday.setDate(nextMonday.getDate() + (nextMonday.getDay() === 0 ? 1 : 8 - nextMonday.getDay()));
  await post('/api/today-task/create', { description: 'Next week', scheduled: date(nextMonday) });
  await post('/api/later-task/create', { description: 'Unscheduled backlog' });
  const result = await post('/api/weekly-report/refresh', {});
  let report = (await items()).weeklyReports.find(item => item.weekKey === result.weekKey);
  assert.doesNotMatch(report.body, /Next week|Unscheduled backlog/);
  assert.equal(result.added.later, 0);
  assert.ok(report.generatedAt);
  const edited = report.body.replace('**다음 주 계획**', '**다음 주 계획**\n- Manually picked plan');
  await post('/api/weekly-report/save', { weekKey: report.weekKey, content: edited });
  await post('/api/weekly-report/refresh', {});
  report = (await items()).weeklyReports.find(item => item.weekKey === result.weekKey);
  assert.match(report.body, /Manually picked plan/);
  assert.doesNotMatch(report.body, /Next week/);
});

test('promoting a non-idea fails without deleting the task', async () => {
  const original = readTasks();
  assert.equal((await post('/api/idea/promote', { id: 'legacy' })).status, 404);
  assert.equal(readTasks(), original);
});

test('a decision kept from a waiting item carries its Slack link without showing as NEW', async () => {
  const created = await post('/api/decision/create', { description: 'Kept from waiting', jira: 'IO-1', permalink: 'https://example.test/thread' });
  const decision = (await items()).decisions.find(item => item.id === created.id);
  assert.equal(decision.permalink, 'https://example.test/thread');
  assert.equal(decision.jira, 'IO-1');
  assert.equal(decision.isNew, false);
  assert.equal((await post('/api/decision/create', { description: 'Bad link', permalink: 'https://example.test/a b' })).status, 400);
});

test('meeting drafts from tiro-sync are reviewed once: accepted items land in their lists, dismissed ones stay hidden', async () => {
  const draftsPath = path.join(directory, 'meeting_drafts.json');
  fs.writeFileSync(path.join(directory, 'calendar_today.md'), `마지막 갱신: ${today}\n- 15:00-16:00 | 운영툴 킥오프\n`);
  fs.writeFileSync(draftsPath, JSON.stringify({ notes: [{
    noteGuid: 'n1', webUrl: 'https://tiro.ooo/n/1', date: today, start: '15:00', end: '16:00', title: '운영툴 킥오프',
    items: [
      { type: 'task', description: '백엔드 담당자에게 스펙 요청하기', due: shifted(3) },
      { type: 'decision', description: '프롬프트 버전은 운영툴에서만 관리' },
      { type: 'check', description: '디자인 일정 회신 받기' },
      { type: 'nonsense', description: '무시됨' },
    ],
  }] }));
  try {
    const meeting = (await items()).workflows.meetings.find(event => event.title === '운영툴 킥오프');
    assert.deepEqual(meeting.tiroNotes, ['https://tiro.ooo/n/1']);
    assert.equal(meeting.drafts.length, 3);
    const [task, decision, check] = meeting.drafts;
    const original = readTasks();
    assert.equal((await post('/api/workflow/review', { meetingId: meeting.id, accept: [{ id: 'n1:9', type: 'task', description: '없는 초안' }] })).status, 400);
    assert.equal((await post('/api/workflow/review', { meetingId: meeting.id, accept: [{ ...task, description: '' }] })).status, 400);
    assert.equal(readTasks(), original);

    assert.equal((await post('/api/workflow/review', { meetingId: meeting.id, dismiss: [check.id] })).ok, true);
    const result = await post('/api/workflow/review', { meetingId: meeting.id, accept: [{ ...task, description: '스펙 요청하기' }, { ...decision, type: 'check' }] });
    assert.equal(result.created.length, 2);
    assert.match(readTasks(), new RegExp(`- 스펙 요청하기 #task\\[id:${result.created[0]} .*scheduled:none due:${shifted(3)}`));
    assert.match(fs.readFileSync(path.join(directory, 'checks.md'), 'utf8'), /프롬프트 버전은 운영툴에서만 관리 #check/);

    const data = (await items()).workflows;
    assert.equal(data.meetings.find(event => event.id === meeting.id).drafts.length, 0);
    assert.deepEqual(data.items.filter(item => item.meetingId === meeting.id).map(item => item.id).sort(), [...result.created].sort());
    assert.equal((await post('/api/workflow/review', { meetingId: meeting.id, accept: [task] })).status, 400);
  } finally {
    fs.rmSync(draftsPath);
  }
});

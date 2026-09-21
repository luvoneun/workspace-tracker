const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');

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
test('the screen stylesheet is served', async () => {
  const response = await fetch(base + '/ui.css');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/css/);
});
test('cross-origin mutations are rejected',async()=>{
  const response=await fetch(base+'/api/track/toggle',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://untrusted.example'},body:JSON.stringify({id:'legacy'})});
  assert.equal(response.status,403);
});
test('multiline creation fails without changing tasks',async()=>{
  const before=readTasks();assert.equal((await post('/api/today-task/create',{description:'first\nsecond'})).status,400);assert.equal(readTasks(),before);
});
test('a later task keeps its deadline and stays unscheduled',async()=>{
  const created=await post('/api/later-task/create',{description:'Backlog with a deadline',due:'2026-12-31'});
  assert.equal(created.ok,true);
  assert.match(readTasks(),new RegExp(`id:${created.id} [^\\n]*scheduled:none due:2026-12-31`));
  const later=(await items()).laterTasks.find(task=>task.id===created.id);
  assert.equal(later.due,'2026-12-31');assert.equal(later.scheduled,null);
});
test('explicit completion is safe to retry',async()=>{
  await post('/api/track/toggle',{id:'legacy',status:'done'});await post('/api/track/toggle',{id:'legacy',status:'done'});
  assert.equal((await items()).reportRefs.legacy.status,'done');
});
test('full item reads never create or rewrite weekly report files',async()=>{
  const file=path.join(directory,'weekly_reports.md');const before=fs.existsSync(file)?fs.readFileSync(file,'utf8'):null;await items();assert.equal(fs.existsSync(file)?fs.readFileSync(file,'utf8'):null,before);
});

test('여러 주에 걸친 기록도 주간 보고에 주마다 제 내용만 담긴다',async()=>{
  const older=shifted(-21),newer=shifted(-7);
  const week=value=>{const d=new Date(`${value}T12:00:00`);d.setDate(d.getDate()-((d.getDay()+6)%7));return date(d);};
  fs.writeFileSync(tasksPath,`# Tasks\n- 지난달 마감 업무 #task[id:wk-old status:done priority:medium created:${older} completed:${older}]\n- 지난주 마감 업무 #task[id:wk-new status:done priority:medium created:${newer} completed:${newer}]\n`);
  const reports=(await items()).weeklyReports;
  const weekText=key=>reports.find(report=>report.weekKey===key)?.draft.rows.map(row=>row.text).join('\n') || '';
  assert.ok(reports.length>=2);assert.ok(reports.every(report=>Array.isArray(report.draft?.rows)));
  assert.match(weekText(week(older)),/지난달 마감 업무/);assert.doesNotMatch(weekText(week(older)),/지난주 마감 업무/);
  assert.match(weekText(week(newer)),/지난주 마감 업무/);assert.doesNotMatch(weekText(week(newer)),/지난달 마감 업무/);
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

test('completed outcome is used in the report draft text', async () => {
  await post('/api/workflow/item', { id: 'legacy', outcome: '디자인 전달일 금요일로 확정' });
  await post('/api/track/toggle', { id: 'legacy' });
  const rows = (await items()).weeklyReports.flatMap(report => report.draft?.rows || []);
  assert.ok(rows.some(row => row.sourceIds.includes('legacy') && row.text.includes('디자인 전달일 금요일로 확정')));
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

test('일괄 완료는 오늘 날짜로 끝내고, 실행 취소는 완료 표시를 걷어낸다', async () => {
  const changed = await post('/api/workflow/task-batch', { ids: ['legacy', 'unseen'], change: { status: 'done' } });
  assert.equal(changed.ok, true);
  const line = id => readTasks().split('\n').find(text => text.includes(`id:${id}`));
  assert.match(line('legacy'), new RegExp(`status:done[^\\n]*completed:${today}|completed:${today}[^\\n]*status:done`));
  let data = await items();
  assert.equal(data.todayTasks.find(item => item.id === 'legacy').status, 'done');
  assert.equal(data.todayTasks.find(item => item.id === 'unseen').status, 'done');
  assert.equal(data.todayTasks.find(item => item.id === 'legacy').due, shifted(-2), '마감일은 그대로 남는다');
  const restored = await post('/api/workflow/task-batch', { undoToken: changed.undoToken });
  assert.equal(restored.ok, true);
  assert.doesNotMatch(line('legacy'), /completed:/);
  data = await items();
  assert.equal(data.reportRefs.legacy.status, 'to-do');
  assert.equal(data.reportRefs.unseen.status, 'to-do');
});

test('일괄 완료 뒤에 바뀐 업무가 있으면 실행 취소를 거절한다', async () => {
  const changed = await post('/api/workflow/task-batch', { ids: ['legacy', 'unseen'], change: { status: 'done' } });
  assert.equal(changed.ok, true);
  assert.equal((await post('/api/track/toggle', { id: 'unseen', status: 'to-do' })).ok, true);
  const before = readTasks();
  assert.equal((await post('/api/workflow/task-batch', { undoToken: changed.undoToken })).status, 400);
  assert.equal(readTasks(), before, '거절된 실행 취소는 한 줄도 바꾸지 않는다');
  assert.equal((await post('/api/workflow/task-batch', { ids: ['legacy'], change: { status: 'to-do' } })).status, 400, '일괄로 여는 상태 변경은 완료 하나뿐이다');
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

// 시작 시 복구는 모듈로 불러올 때 실행되지 않는다. 실제 `node server.js`를 띄워서 확인한다.
const freePort = () => new Promise(resolve => {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;
const journalEntry = (file, before, after) => JSON.stringify({ changes: [{ file, before: Buffer.from(before).toString('base64'), after: createHash('sha256').update(after).digest('hex'), intermediate: [] }] });
async function startServer(t, seed) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-recovery-'));
  seed(home);
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, WORKSPACE_DATA_DIR: home, WORKSPACE_PORT: String(port), WORKSPACE_NO_OPEN: '1', WORKSPACE_HOST: '', WORKSPACE_CONFIG: path.join(home, 'absent.config.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(home, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`서버가 종료되었습니다 (${child.exitCode}): ${log}`);
    try { if ((await fetch(base + '/api/storage-status')).ok) return { home, base, log: () => log }; } catch { /* 아직 안 떴다 */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`서버가 응답하지 않았습니다: ${log}`);
}

test('a refused startup recovery keeps the app up with saving locked', async (t) => {
  const external = '# Tasks\n- 바깥에서 고친 줄 #task[id:outside status:to-do created:2026-09-20]\n';
  const server = await startServer(t, home => {
    fs.writeFileSync(path.join(home, 'tasks.md'), external);
    fs.writeFileSync(path.join(home, '.mutation-journal.json'), journalEntry(path.join(home, 'tasks.md'), '# Tasks\n', '# Tasks\n- 중단된 저장\n'));
    fs.writeFileSync(path.join(home, '.mutation.lock'), String(deadPid()));
  });
  const status = await (await fetch(server.base + '/api/storage-status')).json();
  assert.equal(status.recoveryNeeded, true);
  assert.match(status.reason, /외부에서 변경된/);
  const response = await fetch(server.base + '/api/today-task/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description: '저장되면 안 되는 업무' }) });
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.code, 'RECOVERY_NEEDED');
  assert.match(body.error, /저장을 멈췄습니다/);
  assert.equal(fs.readFileSync(path.join(server.home, 'tasks.md'), 'utf8'), external);
  assert.ok(fs.existsSync(path.join(server.home, '.mutation-journal.json')));
  assert.ok(fs.existsSync(path.join(server.home, '.mutation.lock')));
  assert.equal(fs.existsSync(path.join(server.home, '.workflow.json')), false);
});

test('a restorable journal is recovered at startup and saving continues', async (t) => {
  const interrupted = '# Tasks\n- 중단된 저장 #task[id:half status:to-do created:2026-09-20]\n';
  const server = await startServer(t, home => {
    fs.writeFileSync(path.join(home, 'tasks.md'), interrupted);
    fs.writeFileSync(path.join(home, '.mutation-journal.json'), journalEntry(path.join(home, 'tasks.md'), '# Tasks\n', interrupted));
    fs.writeFileSync(path.join(home, '.mutation.lock'), String(deadPid()));
  });
  assert.deepEqual(await (await fetch(server.base + '/api/storage-status')).json(), { recoveryNeeded: false, reason: null, message: null });
  assert.equal(fs.readFileSync(path.join(server.home, 'tasks.md'), 'utf8'), '# Tasks\n');
  assert.equal(fs.existsSync(path.join(server.home, '.mutation-journal.json')), false);
  assert.equal(fs.existsSync(path.join(server.home, '.mutation.lock')), false);
  const created = await fetch(server.base + '/api/today-task/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description: '복구 후 저장' }) });
  assert.equal(created.status, 200);
  assert.match(fs.readFileSync(path.join(server.home, 'tasks.md'), 'utf8'), /복구 후 저장/);
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

test('meeting drafts: a task can be accepted for today, and an accepted batch can be undone', async () => {
  const draftsPath = path.join(directory, 'meeting_drafts.json');
  const trashPath = path.join(directory, '.trash.json');
  fs.writeFileSync(path.join(directory, 'calendar_today.md'), `마지막 갱신: ${today}\n- 11:00-11:50 | 온보딩 지표 리뷰\n`);
  fs.writeFileSync(draftsPath, JSON.stringify({ notes: [{
    noteGuid: 'u1', webUrl: 'https://tiro.ooo/n/u1', date: today, start: '11:00', end: '11:50', title: '온보딩 지표 리뷰',
    items: [
      { type: 'task', description: '퍼널 이탈 원인 가설 정리하기', due: shifted(2) },
      { type: 'task', description: '코호트 쿼리 요청하기' },
      { type: 'decision', description: '온보딩 실험은 2주 단위로 진행' },
    ],
  }] }));
  try {
    const meeting = (await items()).workflows.meetings.find(event => event.title === '온보딩 지표 리뷰');
    const [first, second, third] = meeting.drafts;
    // 잘못된 선택은 아무것도 만들지 않는다: 알 수 없는 값, 그리고 할 일이 아닌 항목의 "오늘"
    const before = readTasks();
    assert.equal((await post('/api/workflow/review', { meetingId: meeting.id, accept: [{ ...first, when: 'tomorrow' }] })).status, 400);
    assert.equal((await post('/api/workflow/review', { meetingId: meeting.id, accept: [{ ...third, when: 'today' }] })).status, 400);
    assert.equal(readTasks(), before);

    // 기본은 나중, "오늘"을 고른 할 일만 오늘 목록으로 (마감일은 초안에 있던 것만)
    const result = await post('/api/workflow/review', { meetingId: meeting.id, accept: [{ ...first, when: 'today' }, second, third] });
    assert.equal(result.created.length, 3);
    assert.match(readTasks(), new RegExp(`퍼널 이탈 원인 가설 정리하기 #task\\[id:${result.created[0]} .*scheduled:${today} due:${shifted(2)}`));
    assert.match(readTasks(), new RegExp(`코호트 쿼리 요청하기 #task\\[id:${result.created[1]} .*scheduled:none`));

    // 되돌리기: 다른 회의·모르는 항목은 거절하고, 맞으면 항목은 삭제 휴지통으로, 초안은 다시 검토 대기로
    assert.equal((await post('/api/workflow/review-undo', { meetingId: 'other', created: result.created })).status, 400);
    assert.equal((await post('/api/workflow/review-undo', { meetingId: meeting.id, created: ['nope'] })).status, 400);
    assert.equal((await post('/api/workflow/review-undo', { meetingId: meeting.id, created: [] })).status, 400);
    const undo = await post('/api/workflow/review-undo', { meetingId: meeting.id, created: result.created });
    assert.equal(undo.ok, true);
    assert.equal(undo.restored, 3);
    assert.doesNotMatch(readTasks(), /퍼널 이탈 원인 가설 정리하기|코호트 쿼리 요청하기/);
    assert.doesNotMatch(fs.readFileSync(path.join(directory, 'decisions.md'), 'utf8'), /온보딩 실험은 2주 단위로 진행/);
    const trashed = JSON.parse(fs.readFileSync(trashPath, 'utf8')).map(entry => entry.id);
    result.created.forEach(id => assert.ok(trashed.includes(id), '되돌린 항목은 삭제 휴지통에 원문이 남는다'));
    const data = (await items()).workflows;
    assert.equal(data.meetings.find(event => event.id === meeting.id).drafts.length, 3);
    assert.equal(data.items.filter(item => item.meetingId === meeting.id).length, 0);
    // 이미 되돌린 것은 다시 되돌릴 수 없고, 초안은 다시 담을 수 있다
    assert.equal((await post('/api/workflow/review-undo', { meetingId: meeting.id, created: result.created })).status, 400);
    assert.equal((await post('/api/workflow/review', { meetingId: meeting.id, accept: [second] })).ok, true);
  } finally {
    fs.rmSync(draftsPath, { force: true });
  }
});

test('meeting review and capture take a due date for tasks and a reply deadline for checks, never for decisions', async () => {
  const draftsPath = path.join(directory, 'meeting_drafts.json');
  const checksPath = path.join(directory, 'checks.md');
  fs.writeFileSync(path.join(directory, 'calendar_today.md'), `마지막 갱신: ${today}\n- 14:00-14:30 | 결제 실패 싱크\n`);
  fs.writeFileSync(draftsPath, JSON.stringify({ notes: [{
    noteGuid: 'due1', webUrl: 'https://tiro.ooo/n/due1', date: today, start: '14:00', end: '14:30', title: '결제 실패 싱크',
    items: [
      { type: 'task', description: '실패 사유 문구 초안 쓰기', due: shifted(2) },
      { type: 'task', description: '재시도 정책 화면 목록 뽑기' },
      { type: 'check', description: 'PG사에 실패 코드 명세 회신 받기' },
      { type: 'decision', description: '실패 안내는 결제 화면 상단 배너로' },
    ],
  }] }));
  try {
    const meeting = (await items()).workflows.meetings.find(event => event.title === '결제 실패 싱크');
    const [draftTask, plainTask, check, decision] = meeting.drafts;
    // 잘못된 값은 아무것도 만들지 않는다: 날짜 형식, 결정의 마감
    const before = { tasks: readTasks(), checks: fs.existsSync(checksPath) ? fs.readFileSync(checksPath, 'utf8') : '' };
    assert.equal((await post('/api/workflow/review', { meetingId: meeting.id, accept: [{ ...check, due: '2026/09/30' }] })).status, 400);
    assert.equal((await post('/api/workflow/review', { meetingId: meeting.id, accept: [{ ...decision, due: shifted(3) }] })).status, 400);
    assert.equal(readTasks(), before.tasks);
    assert.equal(fs.existsSync(checksPath) ? fs.readFileSync(checksPath, 'utf8') : '', before.checks);

    // 사람이 고친 날짜: 초안의 마감을 지우고(null), 마감이 없던 할 일에 지정하고, 확인 대기에는 회신 기한을 지정한다
    const result = await post('/api/workflow/review', { meetingId: meeting.id, accept: [{ ...draftTask, due: null }, { ...plainTask, due: shifted(5) }, { ...check, due: shifted(4) }, decision] });
    assert.equal(result.created.length, 4);
    assert.doesNotMatch(readTasks(), new RegExp(`실패 사유 문구 초안 쓰기 #task\\[id:${result.created[0]}[^\\]]* due:`));
    assert.match(readTasks(), new RegExp(`재시도 정책 화면 목록 뽑기 #task\\[id:${result.created[1]} .*due:${shifted(5)}`));
    assert.match(fs.readFileSync(checksPath, 'utf8'), new RegExp(`PG사에 실패 코드 명세 회신 받기 #check\\[id:${result.created[2]} [^\\]]*due:${shifted(4)}`));
    assert.doesNotMatch(fs.readFileSync(path.join(directory, 'decisions.md'), 'utf8').split('\n').find(line => line.includes('결제 화면 상단 배너')) || '', /due:/);
    assert.equal((await items()).workflows.items.find(item => item.id === result.created[2]).due, shifted(4), '화면에 실려 가는 항목에도 기한이 있다');

    // 직접 담기도 같다
    const captured = await post('/api/workflow/capture', { meetingId: meeting.id, type: 'check', description: '법무 회신 받기', due: shifted(6) });
    assert.equal(captured.ok, true);
    assert.match(fs.readFileSync(checksPath, 'utf8'), new RegExp(`법무 회신 받기 #check\\[id:${captured.id} [^\\]]*due:${shifted(6)}`));
    assert.equal((await post('/api/workflow/capture', { meetingId: meeting.id, type: 'decision', description: '결정에 마감', due: shifted(6) })).status, 400);
    assert.equal((await post('/api/workflow/capture', { meetingId: meeting.id, type: 'task', description: '잘못된 날짜', due: 'nope' })).status, 400);
    assert.doesNotMatch(readTasks(), /잘못된 날짜/);
  } finally {
    fs.rmSync(draftsPath, { force: true });
  }
});

// launchd가 부르는 자동화 스크립트. 앱과 따로 돌지만 여기가 멈추면 수집이 통째로 멎기 때문에,
// 실제 스크립트를 임시 폴더·가짜 claude로 돌려서 "멈춤 방지" 장치만 확인한다.
// (슬랙 API나 운영 서버는 건드리지 않는다 — 채널이 없는 설정이라 곧바로 실패하고 끝난다)
const automationScript = name => path.join(__dirname, 'automation', name);
const runScript = (script, args, env) => spawnSync('/bin/bash', [script, ...args], {
  env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60000,
});
const gone = pid => { try { process.kill(pid, 0); return false; } catch { return true; } };

test('run-task.sh는 매달린 실행을 시간 제한으로 끊고 자식 프로세스까지 정리한다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-run-task-'));
  const claude = path.join(home, 'fake-claude.sh');
  fs.writeFileSync(claude, '#!/bin/bash\nsleep 60 &\necho "child=$!"\necho "parent=$$"\nsleep 60\n');
  fs.chmodSync(claude, 0o755);
  const result = runScript(automationScript('run-task.sh'), ['hang', '프롬프트', 'Read'], {
    WORKSPACE_DIR: home, AUTOMATION_LOG_DIR: path.join(home, 'logs'), CLAUDE_BIN: claude,
    TASK_TIMEOUT_SECONDS: '2', TASK_KILL_GRACE_SECONDS: '1',
  });
  assert.equal(result.status, 124);
  const log = fs.readFileSync(path.join(home, 'logs', 'hang.log'), 'utf8');
  assert.match(log, /hang 시간 초과 \(2초\)/);
  // 상태 탭이 읽는 시작/종료 줄 형식은 그대로여야 한다
  assert.match(log, /^───── \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} hang 시작$/m);
  assert.match(log, /^───── \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} hang 종료 \(exit 124\)$/m);
  const pids = [...log.matchAll(/(?:child|parent)=(\d+)/g)].map(match => Number(match[1]));
  assert.equal(pids.length, 2);
  assert.deepEqual(pids.map(gone), [true, true]); // MCP 자식 흉내까지 남지 않는다
  fs.rmSync(home, { recursive: true, force: true });
});

test('run-task.sh는 정상 실행의 인자·종료 코드·로그 형식을 그대로 넘긴다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-run-task-'));
  const claude = path.join(home, 'fake-claude.sh');
  fs.writeFileSync(claude, `#!/bin/bash\nprintf '%s\\n' "$*" > "${path.join(home, 'args.txt')}"\necho "수집 결과 요약"\nexit \${FAKE_EXIT:-0}\n`);
  fs.chmodSync(claude, 0o755);
  const env = { WORKSPACE_DIR: home, AUTOMATION_LOG_DIR: path.join(home, 'logs'), CLAUDE_BIN: claude };
  assert.equal(runScript(automationScript('run-task.sh'), ['ok', '프롬프트', 'Read,Write'], env).status, 0);
  assert.equal(fs.readFileSync(path.join(home, 'args.txt'), 'utf8').trim(), '-p 프롬프트 --permission-mode acceptEdits --allowedTools Read,Write');
  assert.equal(runScript(automationScript('run-task.sh'), ['ok', '프롬프트', 'Read,Write'], { ...env, FAKE_EXIT: '7' }).status, 7);
  // 권한 모드·금지 도구는 선택 인자다(슬랙 캡처만 쓴다). 안 주면 위처럼 예전 그대로다.
  assert.equal(runScript(automationScript('run-task.sh'), ['ok', '프롬프트', 'Read', 'manual', 'Write,Edit'], env).status, 0);
  assert.equal(fs.readFileSync(path.join(home, 'args.txt'), 'utf8').trim(), '-p 프롬프트 --permission-mode manual --allowedTools Read --disallowedTools Write,Edit');
  const log = fs.readFileSync(path.join(home, 'logs', 'ok.log'), 'utf8');
  assert.doesNotMatch(log, /시간 초과/);
  assert.match(log, /^───── \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} ok 종료 \(exit 0\)$/m);
  assert.match(log, /^───── \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} ok 종료 \(exit 7\)$/m);
  assert.equal(log.split('수집 결과 요약').length - 1, 3);
  fs.rmSync(home, { recursive: true, force: true });
});

test('slack-capture.sh 잠금은 살아 있는 실행만 존중하고 죽은 잠금은 회수한다', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-slack-lock-'));
  const logs = path.join(home, 'logs');
  const lock = path.join(logs, '.slack-capture.lock');
  const config = path.join(home, 'workspace.config.json');
  fs.writeFileSync(config, '{}'); // 채널이 없으니 잠금만 잡고 곧바로 실패하고 끝난다
  const logText = () => fs.readFileSync(path.join(logs, 'slack-capture.log'), 'utf8');
  const capture = () => runScript(automationScript('slack-capture.sh'), [], {
    WORKSPACE_DIR: home, WORKSPACE_CONFIG: config, AUTOMATION_LOG_DIR: logs,
    SLACK_CAPTURE_IGNORE_HOURS: '1', WORKSPACE_PORT: '4322',
  });
  const holdLock = pid => { fs.mkdirSync(lock, { recursive: true }); fs.writeFileSync(path.join(lock, 'pid'), `${pid}\n`); };
  const longRunning = name => {
    const script = path.join(home, name);
    fs.writeFileSync(script, '#!/bin/bash\nsleep 60\n');
    fs.chmodSync(script, 0o755);
    const child = spawn('/bin/bash', [script], { stdio: 'ignore' });
    t.after(() => child.kill('SIGKILL'));
    return child.pid;
  };

  // 1) 진짜 캡처가 아직 돌고 있으면 건너뛰고, 남의 잠금은 풀지 않는다
  const holder = longRunning('slack-capture-holder.sh');
  holdLock(holder);
  assert.equal(capture().status, 0);
  assert.match(logText(), /이전 실행이 아직 진행 중/);
  assert.equal(fs.readFileSync(path.join(lock, 'pid'), 'utf8').trim(), String(holder));

  // 2) 잠금 폴더만 있고 pid를 아직 못 쓴 찰나도 "진행 중"으로 본다
  fs.rmSync(lock, { recursive: true, force: true });
  fs.mkdirSync(lock, { recursive: true });
  assert.equal(capture().status, 0);
  assert.equal(fs.existsSync(lock), true);

  // 3) 주인이 죽은 잠금은 회수한다(예전 30분 규칙 없이 즉시)
  fs.rmSync(lock, { recursive: true, force: true });
  holdLock(deadPid());
  fs.writeFileSync(path.join(logs, 'slack-capture.log'), '');
  assert.equal(capture().status, 1);
  assert.match(logText(), /채널 확인 실패/);
  assert.equal(fs.existsSync(lock), false); // 잡았다가 스스로 풀었다

  // 4) 번호만 같고 다른 프로그램이 쓰고 있는 PID도 회수한다
  holdLock(longRunning('other-program.sh'));
  fs.writeFileSync(path.join(logs, 'slack-capture.log'), '');
  assert.equal(capture().status, 1);
  assert.doesNotMatch(logText(), /이전 실행이 아직 진행 중/);
  assert.equal(fs.existsSync(lock), false);
  fs.rmSync(home, { recursive: true, force: true });
});

test('import-record.js는 JSON을 명령줄 인자로도, 표준 입력으로도 받는다', async () => {
  const script = path.join(__dirname, 'import-record.js');
  const env = { ...process.env, WORKSPACE_PORT: String(server.address().port), WORKSPACE_CONFIG: path.join(directory, 'absent.config.json') };
  // 이 서버는 같은 프로세스에서 돌기 때문에 spawnSync로 막으면 응답을 못 한다 — 비동기로 부른다.
  const record = (args, input) => new Promise(resolve => {
    const child = spawn(process.execPath, [script, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stdin.end(input || '');
    child.on('close', code => resolve({ code, out }));
  });
  // 캡처 실행은 파이프·히어독이 막혀 있어서 인자 방식만 쓴다
  const argv = await record(['item', JSON.stringify({ type: 'task', description: '인자로 넘긴 수집', permalink: 'https://example.test/argv' })]);
  assert.equal(argv.code, 0);
  assert.equal(JSON.parse(argv.out).ok, true);
  assert.ok((await items()).inboxTasks.some(item => item.description === '인자로 넘긴 수집'));
  // slack-capture.sh의 record_health는 여전히 표준 입력으로 보낸다
  const stdin = await record(['health'], JSON.stringify({ channel: 'my-todo', success: true }));
  assert.equal(stdin.code, 0);
  assert.equal(JSON.parse(stdin.out).ok, true);
  assert.equal((await record(['item', '깨진 JSON'])).code, 1);
});

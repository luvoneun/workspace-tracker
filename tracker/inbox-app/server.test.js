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

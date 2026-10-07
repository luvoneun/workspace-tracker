// 서버: 두 창이 같은 업무를 고칠 때 — 업무 저장은 수정 시각(updated)을 새로 적고, 화면이 본 시각(`expect.updated`)이
// 지금과 다르면 409로 거절하고 아무것도 쓰지 않는다. `expect`가 없으면(옛 화면) 예전처럼 저장한다. 공용 준비는 test-support.js.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const support = require('./test-support');
const { tasksPath, readTasks, post, items, shifted } = support;
before(async () => { await support.ready(); });

const CHANGED = '새 기록이나 다른 창의 변경이 있어요. 적은 내용은 그대로 있어요. 최신 내용을 확인한 뒤 다시 저장해 주세요.';
const rev = async id => (await items()).reportRefs[id].rev;
const trackerFiles = () => fs.readdirSync(support.directory).filter(name => name.endsWith('.md')).map(name => fs.readFileSync(`${support.directory}/${name}`, 'utf8')).join('\n');

test('두 창: 앞 창이 고친 뒤 옛 시각을 든 창의 저장은 409·같은 문구로 거절되고 파일은 그대로다', async () => {
  const made = await post('/api/today-task/create', { description: '두 창 업무' });
  const seen = await rev(made.id);
  const first = await post('/api/track/set-description', { id: made.id, description: '앞 창이 고친 제목', expect: { updated: seen } });
  assert.equal(first.ok, true);
  assert.equal(typeof first.updated, 'string');
  const before = trackerFiles();
  for (const [route, body] of [
    ['/api/track/set-description', { description: '뒤 창 제목' }],
    ['/api/track/set-priority', { priority: 'high' }],
    ['/api/track/set-due', { due: shifted(3) }],
    ['/api/track/set-scheduled', { scheduled: shifted(2) }],
    ['/api/track/toggle', { status: 'done' }],
    ['/api/track/remove', {}],
  ]) {
    const stale = await post(route, { id: made.id, ...body, expect: { updated: seen } });
    assert.equal(stale.status, 409, route);
    assert.equal(stale.code, 'CHANGED_ELSEWHERE', route);
    assert.equal(stale.error, CHANGED, route);
  }
  assert.equal(trackerFiles(), before);
  assert.match(readTasks(), /- 앞 창이 고친 제목 #task/);
});

test('정상 expect면 저장하고 새 수정 시각을 돌려주며, 그 값으로 이어서 고칠 수 있다', async () => {
  const made = await post('/api/today-task/create', { description: '이어서 고치기' });
  let seen = await rev(made.id);
  for (const [route, body] of [
    ['/api/track/set-priority', { priority: 'high' }],
    ['/api/track/set-description', { description: '이어서 고친 제목' }],
    ['/api/track/set-due', { due: shifted(4) }],
  ]) {
    const saved = await post(route, { id: made.id, ...body, expect: { updated: seen } });
    assert.equal(saved.ok, true, route);
    assert.notEqual(saved.updated, seen, route);
    assert.equal(saved.updated, await rev(made.id), route);
    seen = saved.updated;
  }
});

test('expect가 없으면(옛 화면) 예전처럼 저장하고, 꼴이 틀린 expect는 400이다', async () => {
  const made = await post('/api/today-task/create', { description: '옛 화면 업무' });
  await post('/api/track/set-priority', { id: made.id, priority: 'high' });
  assert.equal((await post('/api/track/set-description', { id: made.id, description: '옛 화면이 고친 제목' })).ok, true);
  assert.match(readTasks(), /- 옛 화면이 고친 제목 #task/);
  for (const updated of [5, {}, 'x'.repeat(41)]) {
    assert.equal((await post('/api/track/set-priority', { id: made.id, priority: 'low', expect: { updated } })).status, 400, JSON.stringify(updated));
  }
  // 없는 업무는 예전처럼 404(비교할 것이 없다).
  assert.equal((await post('/api/track/set-priority', { id: 'task_none', priority: 'low', expect: { updated: null } })).status, 404);
});

test('모든 업무 저장이 수정 시각을 새로 적는다 — seen(봤다 표시)만 빼고', async () => {
  const task = await post('/api/today-task/create', { description: '시각 업무' });
  const check = await post('/api/waiting/create', { description: '시각 확인 대기', who: '동료' });
  const idea = await post('/api/idea/create', { description: '시각 아이디어' });
  const steps = [
    [task.id, '/api/track/set-jira', { jiraKey: 'ABC-1' }],
    [task.id, '/api/track/set-group', { group: '그룹하나' }],
    [task.id, '/api/track/set-due', { due: shifted(5) }],
    [task.id, '/api/track/set-doing', { doing: true }],
    [task.id, '/api/track/set-priority', { priority: 'critical' }],
    [task.id, '/api/track/set-description', { description: '시각 업무 고침' }],
    [task.id, '/api/track/set-scheduled', { scheduled: shifted(1) }],
    [task.id, '/api/track/toggle', { status: 'done' }],
    [task.id, '/api/track/toggle', { status: 'to-do' }],
    [check.id, '/api/track/set-who', { who: '다른 동료' }],
    [idea.id, '/api/idea/set-project', { project: '아이디어 묶음' }],
  ];
  for (const [id, route, body] of steps) {
    const before = await rev(id);
    assert.equal((await post(route, { id, ...body })).ok, true, route);
    const after = await rev(id);
    assert.ok(after && after !== before, `${route}: ${before} → ${after}`);
  }
  // 일괄 변경(여러 업무 예정일)도 같다.
  const before = await rev(task.id);
  assert.equal((await post('/api/workflow/task-batch', { ids: [task.id], change: { scheduled: shifted(2) } })).ok, true);
  assert.notEqual(await rev(task.id), before);
  // seen은 새 표시를 봤다는 것이라 시각을 바꾸지 않는다(다른 창의 다음 저장을 막지 않게).
  const unseen = await rev(task.id);
  assert.equal((await post('/api/track/seen', { id: task.id })).ok, true);
  assert.equal(await rev(task.id), unseen);
});

test('끝낸 날 칸이 없는 옛 완료 줄은 고쳐도 시각을 적지 않는다 — 끝낸 날(updated로 읽음)이 바뀌지 않게', async () => {
  const old = '2026-01-05T10:00:00.000Z';
  fs.appendFileSync(tasksPath, `\n- 옛 완료 업무 #task[id:task_legacydone1 status:done priority:medium created:2026-01-01 updated:${old}]\n`);
  assert.equal((await post('/api/track/set-description', { id: 'task_legacydone1', description: '옛 완료 업무 고침', expect: { updated: old } })).ok, true);
  const line = readTasks().split('\n').find(one => one.includes('id:task_legacydone1'));
  assert.match(line, /^- 옛 완료 업무 고침 #task/);
  assert.match(line, new RegExp(`updated:${old}`));
  assert.doesNotMatch(line, /completed:/);
});

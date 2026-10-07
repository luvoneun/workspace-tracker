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
  assert.equal(typeof first.revisions[made.id], 'string');
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
    assert.notEqual(saved.revisions[made.id], seen, route);
    assert.equal(saved.revisions[made.id], await rev(made.id), route);
    seen = saved.revisions[made.id];
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

test('일괄 변경·종류 바꾸기는 응답의 revisions에 새 시각을 싣고, 그 값으로 바로 이어 고치면 통과한다', async () => {
  const a = await post('/api/today-task/create', { description: '일괄 A' });
  const b = await post('/api/today-task/create', { description: '일괄 B' });
  const batch = await post('/api/workflow/task-batch', { ids: [a.id, b.id], change: { scheduled: shifted(3) } });
  assert.equal(batch.ok, true);
  assert.deepEqual(Object.keys(batch.revisions).sort(), [a.id, b.id].sort());
  assert.equal(batch.revisions[a.id], await rev(a.id));
  assert.equal((await post('/api/track/set-priority', { id: a.id, priority: 'high', expect: { updated: batch.revisions[a.id] } })).ok, true);
  const retyped = await post('/api/workflow/retype', { id: b.id, type: 'check' });
  assert.equal(retyped.ok, true);
  assert.equal(retyped.revisions[b.id], await rev(b.id));
  assert.equal((await post('/api/track/set-who', { id: b.id, who: '동료', expect: { updated: retyped.revisions[b.id] } })).ok, true);
});

test('프로젝트 이름 바꾸기·합치기와 그 되돌리기도 업무 줄의 시각을 새로 적는다 — 옛 시각을 든 창의 그룹 바꾸기는 409', async () => {
  const made = await post('/api/today-task/create', { description: '프로젝트 업무' });
  assert.equal((await post('/api/track/set-group', { id: made.id, group: '옛이름프로젝트' })).ok, true);
  const seen = await rev(made.id);
  const renamed = await post('/api/project/rename', { project: 'group:옛이름프로젝트', name: '새이름프로젝트' });
  assert.equal(renamed.ok, true);
  assert.equal(renamed.revisions[made.id], await rev(made.id));
  const before = readTasks();
  const stale = await post('/api/track/set-group', { id: made.id, group: '옛이름프로젝트', expect: { updated: seen } });
  assert.equal(stale.status, 409, '다른 창이 바꾼 이름 위로 옛 프로젝트를 되살리지 않는다');
  assert.equal(readTasks(), before);
  const merged = await post('/api/project/merge', { project: 'group:새이름프로젝트', to: null });
  assert.equal(merged.ok, true);
  assert.equal(merged.revisions[made.id], await rev(made.id));
  const undone = await post('/api/project/merge-undo', { mergeId: merged.mergeId });
  assert.equal(undone.ok, true);
  assert.equal(undone.revisions[made.id], await rev(made.id));
});

test('아이디어 올리기·받음 표시를 같이 지우는 예정일 정하기도 옛 시각이면 409이고 파일은 그대로다', async () => {
  const idea = await post('/api/idea/create', { description: '올릴 아이디어' });
  const ideaSeen = await rev(idea.id);
  assert.equal((await post('/api/track/set-description', { id: idea.id, description: '다른 창이 고친 아이디어' })).ok, true);
  let before = trackerFiles();
  assert.equal((await post('/api/idea/promote', { id: idea.id, expect: { updated: ideaSeen } })).status, 409);
  assert.equal(trackerFiles(), before);
  const made = await post('/api/import', { kind: 'item', payload: { type: 'task', description: '받을 슬랙 업무', permalink: 'https://example.test/conflict-inbox' } });
  const seen = await rev(made.id);
  assert.equal((await post('/api/track/set-description', { id: made.id, description: '다른 창이 고친 슬랙 업무' })).ok, true);
  before = trackerFiles();
  assert.equal((await post('/api/track/set-scheduled', { id: made.id, scheduled: shifted(1), expect: { updated: seen } })).status, 409);
  assert.equal(trackerFiles(), before);
  assert.match(readTasks().split('\n').find(line => line.includes(made.id)), /inbox:true/);
});

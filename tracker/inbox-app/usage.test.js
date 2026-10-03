// 사용 횟수(WP-R) — 세기·보기·보내기(설치·3일째·8일째·정기)·끄기.
// **실제 구글에는 절대 보내지 않는다**: 전송은 전부 가짜 fetch(createCheckin의 request · setCheckinForTests의 fetch)이고,
// 상태 파일은 임시 폴더의 usage.json·checkin.json이다(실제 `local/`에 닿지 않는다 — setUsageForTests로 임시 폴더를 끼운다).
const { test, before, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const support = require('./test-support');
const serverModule = require('./server');
const { createCheckin, CHECKIN_AUTO_ENTRIES } = require('./checkin');
const { createUsage, USAGE_ENTRIES, USAGE_KEYS } = require('./usage');

let base;
before(async () => { base = await support.ready(); });
afterEach(() => { serverModule.setCheckinForTests({ fetch: null }); serverModule.setUsageForTests({}); });

const TODAY = '2026-10-10';
const addDays = (day, n) => { const at = new Date(`${day}T00:00:00Z`); at.setUTCDate(at.getUTCDate() + n); return at.toISOString().slice(0, 10); };
const ago = n => addDays(TODAY, -n);
const USAGE_ENTRY_SET = new Set(Object.values(USAGE_ENTRIES));
const seedState = (firstDay, openDays, rounds = {}) => ({
  id: 'anon-1', firstDay, openDays, rounds: { d3: { state: 'pending' }, d8: { state: 'pending' }, ...rounds },
});

// 임시 폴더 하나에 체크인 + 사용 횟수를 서버와 같은 모양으로 잇는다. 전송은 가짜.
function harness(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-usage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const h = {
    dir, today: options.today || TODAY, calls: [], enabled: options.enabled !== false,
    reply: async () => new Response('<html>응답이 기록되었습니다</html>', { status: 200 }),
  };
  h.usage = createUsage({ localDir: () => dir, today: () => h.today, canSend: () => h.checkin.canSend() });
  h.checkin = createCheckin({
    localDir: () => dir,
    today: () => h.today,
    enabled: () => h.enabled,
    version: () => '1.3.0',
    integrations: () => ({ slack: true }),
    request: async (url, init) => { h.calls.push({ url, init }); return h.reply(url, init); },
    usageFields: (label, today) => h.usage.formFields(label, today),
    onOpen: (state, today, tools) => h.usage.opened(state, today, tools),
    usageOn: () => h.usage.sendOn(),
    usageEntries: Object.values(USAGE_ENTRIES),
  });
  h.checkinFile = path.join(dir, 'checkin.json');
  h.usageFile = path.join(dir, 'usage.json');
  h.seed = value => fs.writeFileSync(h.checkinFile, JSON.stringify(value));
  h.seedUsage = value => fs.writeFileSync(h.usageFile, typeof value === 'string' ? value : JSON.stringify(value));
  h.readUsage = () => JSON.parse(fs.readFileSync(h.usageFile, 'utf8'));
  h.readCheckin = () => JSON.parse(fs.readFileSync(h.checkinFile, 'utf8'));
  h.open = async () => { const polled = h.checkin.poll(); await polled.retry; return polled.result; };
  h.body = (index = 0) => new URLSearchParams(h.calls[index].init.body);
  h.round = index => h.body(index).get(CHECKIN_AUTO_ENTRIES.round);
  return h;
}
const usageDays = days => ({ days, sent: { installSent: true, queue: [] } });

// ─────────────────────────────────────────────────────────────────────────────
// 세기

test('WP-R tick은 허용 목록 키만 받는다(그 밖은 400) — 서버가 세는 키(task_add 등)도 화면에서는 못 올린다', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-usage-http-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  serverModule.setUsageForTests({ localDir: dir });
  const tick = key => fetch(base + '/api/usage/tick', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
  for (const bad of ['task_add', 'jira_create', 'weekly_edit', 'weekly_plan_add', 'evil', '', null, 3, '__proto__']) assert.equal((await tick(bad)).status, 400, String(bad));
  for (const good of ['tab_today', 'tab_weekly', 'search', 'weekly_copy', 'weekly_copy_plan', 'search']) assert.equal((await tick(good)).status, 200, good);
  const data = await (await fetch(base + '/api/usage')).json();
  const count = key => data.rows.find(row => row.key === key).count;
  assert.equal(count('search'), 2);
  assert.equal(count('tab_today'), 1);
  assert.equal(count('task_add'), 0);
  assert.equal(data.days, 30);
  assert.equal(data.canSend, false, '테스트 서버는 보내지 않는 설치다');
});

test('WP-R 서버가 API 성공 때만 +1 — 추가·끝냄·지움·슬랙 가져오기·같은 요청 다시 보내기', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-usage-http-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  serverModule.setUsageForTests({ localDir: dir });
  const counts = async () => Object.fromEntries((await (await fetch(base + '/api/usage')).json()).rows.map(row => [row.key, row.count]));
  const post = (route, body, headers = {}) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

  const made = await (await post('/api/today-task/create', { description: '문서 정리' })).json();
  assert.equal(made.ok, true);
  assert.equal((await post('/api/today-task/create', { description: '   ' })).status, 400, '실패한 추가');
  await post('/api/later-task/create', { description: '나중 일' });
  const key = 'usage-replay-key-0001';
  await post('/api/waiting/create', { description: '회신 기다리기' }, { 'Idempotency-Key': key });
  await post('/api/waiting/create', { description: '회신 기다리기' }, { 'Idempotency-Key': key });   // 같은 요청 다시
  await post('/api/idea/create', { description: '생각' });
  await post('/api/decision/create', { description: '정함' });
  let c = await counts();
  assert.equal(c.task_add, 2, '직접 추가 2(실패한 것은 세지 않음)');
  assert.equal(c.check_add, 1, '같은 요청을 다시 보내도 한 번');
  assert.equal(c.idea_add, 1);
  assert.equal(c.decision_add, 1);

  await post('/api/track/toggle', { id: made.id, status: 'done' });
  await post('/api/track/toggle', { id: made.id, status: 'done' });   // 이미 끝남 — 다시 세지 않는다
  await post('/api/track/toggle', { id: 'unseen', status: 'done' });   // 슬랙 출처 할 일
  await post('/api/track/toggle', { id: 'nope', status: 'done' });     // 없는 항목 404
  c = await counts();
  assert.equal(c.task_done, 2);
  assert.equal(c.slack_done, 1);

  await post('/api/track/remove', { id: 'legacy' });   // 슬랙 출처 할 일
  await post('/api/track/remove', { id: 'legacy' });   // 이미 없음 404
  c = await counts();
  assert.equal(c.task_remove, 1);
  assert.equal(c.slack_remove, 1);

  const item = { kind: 'item', payload: { type: 'task', description: '슬랙에서 온 일', permalink: 'https://example.test/usage-1' } };
  await post('/api/import', item);
  await post('/api/import', item);   // 같은 링크 — 중복이라 새로 들어오지 않는다
  await post('/api/import', { kind: 'item', payload: { type: 'task', description: '링크 없음' } });   // 실패
  c = await counts();
  assert.equal(c.slack_in, 1);
  assert.equal(c.task_add, 2, '슬랙에서 들어온 할 일은 직접 추가로 세지 않는다');

  const batch = await (await post('/api/today-task/create', { description: '일괄 대상' })).json();
  const done = await (await post('/api/workflow/task-batch', { ids: [batch.id], change: { status: 'done' } })).json();
  assert.equal(done.ok, true);
  await post('/api/workflow/task-batch', { undoToken: done.undoToken });
  c = await counts();
  assert.equal(c.task_done, 3, '여러 개 완료도 세고, 되돌리기는 세지 않는다');

  // 파일에는 날짜별 숫자만 — 문구는 없다.
  const raw = fs.readFileSync(path.join(dir, 'usage.json'), 'utf8');
  for (const word of ['문서 정리', '슬랙에서 온 일', 'example.test', 'unseen']) assert.equal(raw.includes(word), false, word);
});

test('양식 ① 주간요약 세기 — 고치기(edit·rename·retitle)는 weekly_edit, 할 일 칸 적기(add)는 weekly_plan_add, 실패·다른 동작은 세지 않는다', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-usage-http-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  serverModule.setUsageForTests({ localDir: dir });
  const counts = async () => Object.fromEntries((await (await fetch(base + '/api/usage')).json()).rows.map(row => [row.key, row.count]));
  const report = async () => (await (await fetch(base + '/api/items')).json()).weeklyReports[0];
  const change = async (body) => { const week = await report(); return fetch(base + '/api/report/change', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ weekKey: week.weekKey, revision: week.draft.revision, ...body }) }); };
  assert.equal((await change({ action: 'retitle', text: '세기 시험 보고' })).status, 200);
  assert.equal((await change({ action: 'add', text: '금요일 휴가' })).status, 200);
  assert.equal((await change({ action: 'add', text: '' })).status, 400, '실패한 적기');
  assert.equal((await change({ action: 'ackNew' })).status, 200);
  const c = await counts();
  assert.equal(c.weekly_edit, 1);
  assert.equal(c.weekly_plan_add, 1);
  const line = (await report()).draft.rows.find(row => row.text === '금요일 휴가');
  await change({ action: 'edit', id: line.id, text: '금요일 반차' });
  assert.equal((await counts()).weekly_edit, 2);
  // 시험 서버의 보고를 처음 상태로 — 이름과 줄을 거둔다.
  await change({ action: 'retitle', text: '' });
  await change({ action: 'exclude', id: line.id });
});

test('WP-R 세기는 저장 트랜잭션 밖 — 세기 파일을 못 써도 저장은 된다', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-usage-http-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const blocked = path.join(dir, 'file-not-folder');
  fs.writeFileSync(blocked, 'x');   // 폴더 자리에 파일 — 세기 쓰기가 실패한다
  serverModule.setUsageForTests({ localDir: path.join(blocked, 'local') });
  const response = await fetch(base + '/api/today-task/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description: '세기 실패해도 저장' }) });
  assert.equal(response.status, 200);
  assert.match(support.readTasks(), /세기 실패해도 저장/);
});

test('WP-R 90일 지난 날은 지우고, 깨진 파일은 새로 — 끈 것(usage-off)은 파일이 깨져도 풀리지 않는다', (t) => {
  const h = harness(t);
  h.seedUsage(usageDays({ [ago(120)]: { search: 3 }, [ago(89)]: { search: 1 }, [ago(1)]: { tab_today: 2, bogus: 5, search: -1 } }));
  h.usage.write('search');
  const days = h.readUsage().days;
  assert.equal(days[ago(120)], undefined, '90일 지난 날');
  assert.deepEqual(days[ago(89)], { search: 1 });
  assert.deepEqual(days[ago(1)], { tab_today: 2 }, '모르는 키·음수는 버린다');
  assert.deepEqual(days[TODAY], { search: 1 });
  h.usage.setSend(false);
  h.seedUsage('{ 깨진');
  h.usage.write('search');
  assert.deepEqual(h.readUsage().days, { [TODAY]: { search: 1 } });
  assert.equal(h.usage.sendOn(), false);
  assert.deepEqual(h.usage.recent(TODAY).find(row => row.key === 'search'), { key: 'search', label: '검색', count: 1 });
});

// ─────────────────────────────────────────────────────────────────────────────
// 보내기

test('WP-R 설치 신호 — 처음 연 날 한 번(회차·익명 번호·버전만), 다시 열어도 다시 보내지 않는다', async (t) => {
  const h = harness(t);
  await h.open();
  assert.equal(h.calls.length, 1);
  const body = h.body();
  assert.equal(body.get(CHECKIN_AUTO_ENTRIES.round), '설치');
  assert.equal(body.get(CHECKIN_AUTO_ENTRIES.id), h.readCheckin().id);
  assert.equal(body.get(CHECKIN_AUTO_ENTRIES.version), '1.3.0');
  assert.deepEqual([...body.keys()].sort(), [CHECKIN_AUTO_ENTRIES.round, CHECKIN_AUTO_ENTRIES.id, CHECKIN_AUTO_ENTRIES.version].sort());
  await h.open();
  h.today = addDays(TODAY, 1);
  await h.open();
  assert.equal(h.calls.length, 1, '한 번만');
  assert.equal(h.readUsage().sent.installSent, true);
});

test('WP-R 기존 사용자 — 체크인 기록이 이미 있으면 업데이트 뒤 처음 연 날 한 번 설치 신호', async (t) => {
  const h = harness(t);
  h.seed(seedState(ago(20), [ago(20), ago(15), ago(12), ago(9)], { d3: { state: 'sent' }, d8: { state: 'sent' } }));
  await h.open();
  assert.deepEqual(h.calls.map((_, i) => h.round(i)), ['설치']);
  assert.equal(h.body().get(CHECKIN_AUTO_ENTRIES.id), 'anon-1', '체크인과 같은 익명 번호');
  await h.open();
  assert.equal(h.calls.length, 1);
});

test('WP-R 3일째·8일째 체크인 본문에 사용 횟수 9칸 — 구간은 지난번 보낸 날 다음 날부터 오늘까지', async (t) => {
  const h = harness(t);
  h.seed(seedState(ago(3), [ago(3)]));
  h.seedUsage(usageDays({
    [ago(3)]: { task_add: 2, task_done: 1, slack_in: 4, slack_done: 2, slack_remove: 1, check_add: 1, idea_add: 1, decision_add: 2, tab_today: 3, tab_weekly: 3, search: 3, weekly_copy: 1 },
  }));
  await h.open();
  await h.checkin.act({ round: 'd3', action: 'send', answers: { setup: '쉬웠어요' } });
  const body = h.body();
  assert.equal(body.get(CHECKIN_AUTO_ENTRIES.round), '3일째');
  assert.equal(body.get(USAGE_ENTRIES.taskAdd), '2');
  assert.equal(body.get(USAGE_ENTRIES.taskDone), '1');
  assert.equal(body.get(USAGE_ENTRIES.slackIn), '4');
  assert.equal(body.get(USAGE_ENTRIES.slackDone), '2');
  assert.equal(body.get(USAGE_ENTRIES.slackRemove), '1');
  assert.equal(body.get(USAGE_ENTRIES.checkAdd), '1');
  assert.equal(body.get(USAGE_ENTRIES.recordAdd), '3', '아이디어 + 결정');
  assert.equal(body.get(USAGE_ENTRIES.topTab), '오늘', '동률이면 앞의 탭');
  assert.equal(body.get(USAGE_ENTRIES.extras), '검색 3 · 주간요약 1 · 지라 0');
  assert.equal([...body.keys()].filter(key => USAGE_ENTRY_SET.has(key)).length, 9);
  assert.equal(h.readUsage().sent.lastDay, TODAY);

  // 8일째 — 3일째 뒤(다음 날부터)의 횟수만. 탭을 안 열었으면 빈칸.
  h.usage.write('task_add');   // 오늘(3일째에 이미 보낸 날) — 8일째 구간에 들지 않는다
  h.today = addDays(TODAY, 5);
  h.seedUsage({ ...h.readUsage(), days: { ...h.readUsage().days, [addDays(TODAY, 2)]: { task_add: 5, jira_create: 1 } } });
  h.seed(seedState(ago(3), [ago(3), TODAY, addDays(TODAY, 1), addDays(TODAY, 2)], { d3: { state: 'sent' } }));
  h.calls.length = 0;
  await h.open();
  await h.checkin.act({ round: 'd8', action: 'send', answers: { keep: '네' } });
  const d8 = h.body();
  assert.equal(d8.get(CHECKIN_AUTO_ENTRIES.round), '8일째');
  assert.equal(d8.get(USAGE_ENTRIES.taskAdd), '5');
  assert.equal(d8.get(USAGE_ENTRIES.topTab), '');
  assert.equal(d8.get(USAGE_ENTRIES.extras), '검색 0 · 주간요약 0 · 지라 1');
});

test('WP-R 정기 — 8일째가 끝난 뒤 3일마다 창 없이 횟수만, 3일이 안 됐으면 보내지 않는다', async (t) => {
  const h = harness(t);
  h.seed(seedState(ago(20), [ago(20), ago(15), ago(12), ago(9)], { d3: { state: 'sent' }, d8: { state: 'sent' } }));
  h.seedUsage({ days: { [ago(1)]: { task_done: 7 } }, sent: { installSent: true, lastDay: ago(3), lastRound: '8일째', queue: [] } });
  const shown = await h.open();
  assert.equal(shown.show, null, '창은 없다');
  assert.equal(h.calls.length, 1);
  assert.equal(h.round(0), '정기');
  assert.equal(h.body().get(USAGE_ENTRIES.taskDone), '7');
  assert.equal(h.body().get(CHECKIN_AUTO_ENTRIES.openDays), '5', '앱을 오픈한 날 수도 함께');
  assert.equal(h.readUsage().sent.lastDay, TODAY);
  h.today = addDays(TODAY, 2);
  await h.open();
  assert.equal(h.calls.length, 1, '2일 뒤 — 아직');
  h.today = addDays(TODAY, 3);
  await h.open();
  assert.equal(h.calls.length, 2, '3일 뒤 — 다시');
  assert.equal(h.round(1), '정기');
});

test('WP-R 정기 — 8일째를 이 버전 전에 끝낸 사람은 오늘부터 세고, 앱을 안 연 구간은 건너뛴다', async (t) => {
  const h = harness(t);
  h.seed(seedState(ago(30), [ago(30), ago(25)], { d3: { state: 'sent' }, d8: { state: 'sent' } }));
  h.seedUsage({ days: {}, sent: { installSent: true, queue: [] } });
  await h.open();
  assert.equal(h.calls.length, 0, '기준일만 잡는다');
  assert.equal(h.readUsage().sent.lastDay, TODAY);

  // 앱을 연 날이 없는 구간 — opened()를 직접 부른다(체크인 GET은 오늘을 연 날에 더하므로).
  const tools = { deliver: async () => { h.calls.push({ init: { body: '' } }); return 'sent'; }, autoFields: () => [], markClosed: () => {} };
  h.seedUsage({ days: { [addDays(TODAY, 1)]: { search: 1 } }, sent: { installSent: true, lastDay: TODAY, queue: [] } });
  await h.usage.opened({ openDays: [ago(30), TODAY], rounds: { d8: { state: 'sent' } } }, addDays(TODAY, 4), tools);
  assert.equal(h.calls.length, 0, '구간(다음 날~4일 뒤)에 연 날이 없으면 보내지 않는다');
  assert.equal(h.readUsage().sent.lastDay, addDays(TODAY, 4), '그 구간은 넘긴다');
});

test('WP-R 실패하면 대기 — 다음에 열 때 하루 한 번 다시, 7일이 지나면 버린다', async (t) => {
  const h = harness(t);
  h.reply = async () => { throw new TypeError('fetch failed'); };
  await h.open();
  assert.equal(h.readUsage().sent.queue.length, 1);
  await h.open();
  assert.equal(h.calls.length, 1, '같은 날은 다시 시도하지 않는다');
  h.today = addDays(TODAY, 1);
  h.reply = async () => new Response('ok', { status: 200 });
  await h.open();
  assert.equal(h.calls.length, 2);
  assert.equal(h.round(1), '설치', '대기해 둔 같은 신호');
  assert.deepEqual(h.readUsage().sent.queue, []);

  const late = harness(t);
  late.reply = async () => { throw new TypeError('fetch failed'); };
  await late.open();
  late.today = addDays(TODAY, 8);
  await late.open();
  assert.equal(late.calls.length, 1, '7일 넘은 대기는 다시 보내지 않고');
  assert.deepEqual(late.readUsage().sent.queue, [], '버린다');
});

test('WP-R 끄면 설치·정기를 보내지 않고 체크인 답의 사용 횟수 칸을 비운다 — 세기는 계속, 다시 켜도 끈 동안 횟수는 안 나간다', async (t) => {
  const h = harness(t);
  h.seed(seedState(ago(3), [ago(3)]));
  h.usage.setSend(false);
  h.seedUsage(usageDays({ [ago(2)]: { task_add: 9 } }));
  h.readUsage();
  const result = await h.open();
  assert.equal(result.usageOn, false, '창 안내 문구는 앞 문장만');
  await h.checkin.act({ round: 'd3', action: 'send', answers: {} });
  assert.equal(h.calls.length, 1, '설치 신호는 없고 체크인 답만');
  assert.equal(h.round(0), '3일째');
  assert.equal([...h.body().keys()].some(key => USAGE_ENTRY_SET.has(key)), false, '사용 횟수 칸 없음');
  h.usage.write('search');
  assert.equal(h.readUsage().days[TODAY].search, 1, '세기는 계속');

  // 정기도 멈춘다.
  const p = harness(t);
  p.seed(seedState(ago(20), [ago(20), ago(15), ago(12), ago(9)], { d3: { state: 'sent' }, d8: { state: 'sent' } }));
  p.seedUsage({ days: { [ago(1)]: { task_done: 3 } }, sent: { installSent: false, lastDay: ago(5), queue: [{ round: '정기', fields: [['entry.1', 'x']], queuedOn: ago(1), lastTry: ago(1) }] } });
  p.usage.setSend(false);
  await p.open();
  assert.equal(p.calls.length, 0);
  assert.deepEqual(p.readUsage().sent.queue, [], '못 보낸 신호도 버린다');
  // 다시 켜면 — 설치 신호는 가지만 정기는 켠 날부터 센다.
  p.usage.setSend(true);
  p.today = addDays(TODAY, 1);
  await p.open();
  assert.deepEqual(p.calls.map((_, i) => p.round(i)), ['설치']);
});

test('WP-R 끄기 전에 제출해 대기로 남은 체크인 답 — 끈 뒤 다시 보낼 때 사용 횟수 9칸을 빼고, 질문 답·자동 칸은 그대로', async (t) => {
  const h = harness(t);
  h.seed(seedState(ago(3), [ago(3), ago(1)]));
  h.seedUsage(usageDays({ [ago(2)]: { task_add: 4 } }));
  h.reply = async () => { throw new TypeError('fetch failed'); };
  assert.deepEqual(await h.checkin.act({ round: 'd3', action: 'send', answers: { setup: '쉬웠어요', helped: ['지라'] } }), { queued: true });
  assert.equal([...h.body(0).keys()].filter(key => USAGE_ENTRY_SET.has(key)).length, 9, '제출 때는 9칸이 있었다');
  h.usage.setSend(false);
  h.today = addDays(TODAY, 1);
  h.reply = async () => new Response('ok', { status: 200 });
  h.calls.length = 0;
  await h.open();
  assert.equal(h.calls.length, 1, '대기 답 재전송만(끈 사람은 설치 신호 없음)');
  const body = h.body(0);
  assert.equal([...body.keys()].some(key => USAGE_ENTRY_SET.has(key)), false, '사용 횟수 칸 없음');
  assert.equal(body.get('entry.2037894728'), '쉬웠어요');
  assert.deepEqual(body.getAll('entry.1269347696'), ['지라']);
  assert.equal(body.get(CHECKIN_AUTO_ENTRIES.round), '3일째');
  assert.equal(body.get(CHECKIN_AUTO_ENTRIES.id), 'anon-1');
  assert.equal(body.get(CHECKIN_AUTO_ENTRIES.version), '1.3.0');
  assert.equal(h.readCheckin().rounds.d3.state, 'sent');
});

test('WP-R 만든 사람 설치(main 갈래 등 꺼진 체크인)는 세기는 하되 아무것도 보내지 않는다', async (t) => {
  const h = harness(t, { enabled: false });
  h.usage.write('search');
  await h.open();
  assert.equal(h.calls.length, 0);
  assert.equal(h.checkin.canSend(), false);
  assert.equal(h.readUsage().days[TODAY].search, 1);
});

test('WP-R 폼이 닫혔으면 모두 멈춘다 — 사용 횟수 신호가 닫힘을 알아내도 체크인에 적는다', async (t) => {
  const h = harness(t);
  h.reply = async () => new Response('gone', { status: 410 });
  await h.open();
  assert.equal(h.calls.length, 1);
  assert.equal(h.readCheckin().closed, true);
  assert.equal(h.checkin.canSend(), false);
  h.reply = async () => new Response('ok', { status: 200 });
  h.today = addDays(TODAY, 30);
  await h.open();
  assert.equal(h.calls.length, 1, '닫힌 뒤로는 아무것도');
});

test('WP-R /api/usage 배선 — 끄기·다시 켜기, 보내는 본문에 문구·이름·토큰이 없다', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-usage-http-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'checkin.json'), JSON.stringify(seedState(ago(3), [ago(3)])));
  fs.writeFileSync(support.tasksPath, '# Tasks\n- 홍길동에게 결제 리뉴얼 비밀 문서 보내기 #task[id:secret status:to-do priority:high created:2026-10-01 scheduled:2026-10-01 source:slack:https://example.test/xoxp-token]\n');
  const calls = [];
  serverModule.setUsageForTests({ localDir: dir });
  serverModule.setCheckinForTests({
    localDir: dir, today: TODAY, enabled: true,
    fetch: async (url, init) => { calls.push({ url, init }); return new Response('ok', { status: 200 }); },
  });
  const post = (route, body) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  await post('/api/track/toggle', { id: 'secret', status: 'done' });
  await post('/api/usage/tick', { key: 'tab_records' });
  let info = await (await fetch(base + '/api/usage')).json();
  assert.equal(info.send, true, '기본 켜짐');
  assert.equal(info.canSend, true);
  assert.equal((await post('/api/usage/setting', { send: 'no' })).status, 400);
  assert.deepEqual(await (await post('/api/usage/setting', { send: false })).json(), { ok: true, send: false });
  assert.equal(fs.existsSync(path.join(dir, 'usage-off')), true);
  info = await (await fetch(base + '/api/usage')).json();
  assert.equal(info.send, false);
  assert.deepEqual(await (await post('/api/usage/setting', { send: true })).json(), { ok: true, send: true });

  const shown = await (await fetch(base + '/api/checkin')).json();
  assert.equal(shown.show, 'd3');
  assert.equal(shown.usageOn, true);
  await new Promise(resolve => setTimeout(resolve, 50));   // 설치 신호(응답과 따로 간다)
  assert.equal((await (await post('/api/checkin', { round: 'd3', action: 'send', answers: { setup: '쉬웠어요' } })).json()).sent, true);
  assert.deepEqual(calls.map(call => new URLSearchParams(call.init.body).get(CHECKIN_AUTO_ENTRIES.round)), ['설치', '3일째']);
  const d3 = new URLSearchParams(calls[1].init.body);
  assert.equal(d3.get(USAGE_ENTRIES.taskDone), '1');
  assert.equal(d3.get(USAGE_ENTRIES.slackDone), '1');
  assert.equal(d3.get(USAGE_ENTRIES.topTab), '아이디어·결정');
  for (const call of calls) {
    const body = decodeURIComponent(call.init.body);
    for (const word of ['홍길동', '결제 리뉴얼', '비밀', 'secret', 'token', 'xox', 'example.test']) assert.equal(body.includes(word), false, `${word}이(가) 본문에 없다`);
  }
});

test('WP-R 서버 파일 usage.js는 화면으로 나가지 않고, usage-ui.js·css는 index.html이 app.js보다 먼저 읽는다', () => {
  assert.equal(serverModule.CLIENT_BLOCKED.has('usage.js'), true);
  assert.equal(serverModule.isClientFile('usage.js'), false);
  assert.equal(serverModule.isClientFile('usage-ui.js'), true);
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  assert.ok(html.indexOf('/usage-ui.js') > 0 && html.indexOf('/usage-ui.js') < html.indexOf('/app.js'));
  assert.match(html, /href="\/usage-ui\.css"/);
});

test('WP-R 화면 파일 규칙 — innerHTML 없음, 알림 줄·끄기·다시 켜기·스위치·내 일 기록·체크인 안내 문구', () => {
  const read = name => fs.readFileSync(path.join(__dirname, name), 'utf8').split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n');
  const ui = read('usage-ui.js');
  assert.equal(/innerHTML|insertAdjacentHTML|outerHTML/.test(ui), false);
  for (const words of ['어떤 기능을 많이 쓰는지 익명으로 모아 앱을 고치는 데 써요 · ', '끄기', '모으지 않아요 · ', '다시 켜기', '익명 사용 횟수 보내기',
    '어떤 기능이 쓸모 있는지 보고 앱을 고치는 데 써요 — 기능별 횟수만, 이름·업무 내용은 보내지 않아요', '내 일 기록', '꺼도 내 일 기록은 이 맥에 계속 쌓여요', "'switch'"]) assert.ok(ui.includes(words), words);
  assert.match(read('checkin-ui.js'), /이름과 업무 내용은 보내지 않아요\. 앱을 고치는 데 쓰려고 기능별 사용 횟수는 함께 보내요/);
  // 부르는 자리 — 탭·검색·주간요약 복사·사용설명서 두 곳·설정 › 앱.
  assert.match(read('app.js'), /usageTabOpened\(tab, activeTabKey\)/);
  assert.match(read('app.js'), /usageTick\('search'\)/);
  assert.match(read('report-ui.js'), /usageTick\('weekly_copy'\)/);
  assert.equal((read('app.js').match(/usageGuideLine\(\)/g) || []).length, 1);
  assert.equal((read('settings-ui.js').match(/usageGuideLine\(\)/g) || []).length, 1);
  assert.match(read('settings-ui.js'), /usageSettingsRow\(\)/);
});

test('WP-W GET /api/usage — 기존 칸은 그대로, today와 보관 중인 날의 history(알려진 키만·90일 안)를 더한다', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-usage-history-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  serverModule.setUsageForTests({ localDir: dir });
  serverModule.setCheckinForTests({ localDir: dir, today: TODAY, enabled: false });
  t.after(() => serverModule.setCheckinForTests({}));
  fs.writeFileSync(path.join(dir, 'usage.json'), JSON.stringify(usageDays({
    [TODAY]: { task_done: 3, slack_in: 2, mystery: 9 },
    [ago(5)]: { task_add: 1, decision_add: -2 },
    [ago(95)]: { task_done: 7 },
    'not-a-day': { task_done: 1 },
  })));
  const info = await (await fetch(base + '/api/usage')).json();
  assert.equal(info.ok, true);
  assert.equal(info.today, TODAY);
  assert.deepEqual(info.history, { [TODAY]: { task_done: 3, slack_in: 2 }, [ago(5)]: { task_add: 1 } });
  assert.equal(info.days, 30);
  assert.equal(info.rows.length, 20);
  assert.equal(info.rows.find(row => row.key === 'task_done').count, 3);
  assert.equal(typeof info.send, 'boolean');
  assert.equal(typeof info.canSend, 'boolean');
});

test('WP-W GET /api/usage — 세지 않는 설치(폴더 없음)면 history는 빈 값', async () => {
  serverModule.setUsageForTests({});
  const info = await (await fetch(base + '/api/usage')).json();
  assert.equal(info.ok, true);
  assert.deepEqual(info.history, {});
  assert.match(info.today, /^\d{4}-\d{2}-\d{2}$/);
});

test('WP-W 화면이 아는 키 목록(USAGE_KNOWN_KEYS)은 서버의 USAGE_KEYS와 같다', () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, 'usage-ui.js'), 'utf8');
  const keys = vm.runInNewContext(`${source}\n;JSON.stringify(USAGE_KNOWN_KEYS)`, {});
  assert.deepEqual(JSON.parse(keys), USAGE_KEYS.map(([key]) => key));
});

test('WP-W 화면 파일 규칙 — `내 일 기록`·`끝낸`, `쳐`·`내 사용 기록` 없음, 새 innerHTML 없음, 새 색 없음', () => {
  const read = name => fs.readFileSync(path.join(__dirname, name), 'utf8').split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n');
  const ui = read('usage-ui.js');
  for (const words of ['내 일 기록', '끝낸 일', '알게 된 것', '기능별 전체 보기', '아직 기록이 없어요. 할 일을 끝내면 여기에 쌓여요.', "'aria-pressed'", '사용 기록을 읽지 못했어요.']) assert.ok(ui.includes(words), words);
  assert.equal(/쳐/.test(fs.readFileSync(path.join(__dirname, 'usage-ui.js'), 'utf8')), false);
  assert.equal(ui.includes('내 사용 기록'), false);
  assert.equal(/innerHTML|insertAdjacentHTML|outerHTML/.test(ui), false);
  const css = fs.readFileSync(path.join(__dirname, 'usage-ui.css'), 'utf8');
  assert.equal(/#[0-9a-f]{3,8}\b|rgba?\(|--warn/i.test(css), false, '새 색·주황 없음 — 기존 토큰만');
});

test('WP-X 화면 파일 규칙 — 주간요약 줄 끝·맨 아래·자세히 창·설정 안내 문구, report-ui.js는 두 자리만 넘김, 새 innerHTML·새 색·새 그림자·새 토큰 없음', () => {
  const read = name => fs.readFileSync(path.join(__dirname, name), 'utf8').split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n');
  const ui = read('usage-ui.js');
  for (const words of ['내 일 기록 자세히', '이 주는 기록이 없어요', '이번 주는 아직 끝낸 일이 없어요', '엔 끝낸 일이 없어요', '이번 주가 최고 기록이에요', '최고 기록: ',
    '내 일 기록은 주간요약 탭에서 볼 수 있어요 · ', "'d-modal d-uwdlg'", "'aria-haspopup', 'dialog'", '끝낸 일 ${record.done}개']) assert.ok(ui.includes(words), words);
  assert.equal(/innerHTML|insertAdjacentHTML|outerHTML/.test(ui), false);
  assert.equal(/쳐/.test(fs.readFileSync(path.join(__dirname, 'usage-ui.js'), 'utf8')), false);
  const report = read('report-ui.js');
  assert.match(report, /function reportWeekRowEnd\(item\) \{ return typeof usageWeekRowEnd === 'function' \? usageWeekRowEnd\(item\) : null; \}/);
  assert.match(report, /function reportWeeksFoot\(items\) \{ return typeof usageWeeksFoot === 'function' \? usageWeeksFoot\(items\) : null; \}/);
  const css = fs.readFileSync(path.join(__dirname, 'usage-ui.css'), 'utf8');
  const added = css.slice(css.indexOf('/* 주간요약 주차 목록(WP-X)'));
  assert.ok(added.length > 100);
  assert.equal(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|box-shadow|--warn|--[a-z-]+\s*:/i.test(added), false, '새 색·그림자·토큰 정의 없음');
  for (const token of ['--hair', '--check-line', '--accent', '--muted']) assert.ok(added.includes(`var(${token})`), token);
  // 자세히 창은 설정과 같은 판 — 새 틀(.d-modal 재정의) 없음.
  assert.equal(/\.d-modal\s*[{,]/.test(added), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// WP-Y — 내 일 기록 숫자를 보고 본문 `완료한 일` 기준(업무 목록)으로. GET /api/usage에 work만 더하고, 세기·보내기는 그대로.
const { workDaysFrom, normalizeWork, formPairs, sumRange } = require('./usage');
const reportFactory = require('./report-drafts');

test('WP-Y workDaysFrom — 완료일이 있는 할 일·버그만 끝낸 일(주 첫날·끝날 경계), 슬랙/직접 쪼갬, 확인 완료는 끝낸 일이 아님', () => {
  const items = [
    { id: 'mon', type: 'task', status: 'done', created: '2026-09-20', completed: '2026-09-21' },                 // 월요일
    { id: 'sun', type: 'bug', status: 'done', created: '2026-09-21', completed: '2026-09-27', permalink: 'https://s/1' },   // 일요일·슬랙
    { id: 'late', type: 'task', status: 'done', created: '2026-09-27', completed: '2026-09-22' },               // 만든 날이 완료보다 뒤지만 같은 주 — 보고도 셈
    { id: 'after', type: 'task', status: 'done', created: '2026-09-28', completed: '2026-09-22' },              // 만든 날이 그 주 뒤 — 보고에 안 섬
    { id: 'nocreated', type: 'task', status: 'done', completed: '2026-09-22' },                                 // 만든 날 없음 — 보고에 안 섬
    { id: 'nocompleted', type: 'task', status: 'done', created: '2026-09-22' },                                 // 완료일 없음
    { id: 'open', type: 'task', status: 'to-do', created: '2026-09-23', completed: '2026-09-23' },              // 끝나지 않음
    { id: 'chk', type: 'check', status: 'done', created: '2026-09-23', completed: '2026-09-24' },               // 확인 완료 — 남긴 기록만
    { id: 'dec', type: 'decision', status: 'to-do', created: '2026-09-23' },
    { id: 'idea', type: 'idea', status: 'to-do', created: '2026-09-23' },
    { id: 'bad', type: 'task', status: 'done', created: 'yesterday', completed: '2026-09-23' },
    null, 'x',
  ];
  const work = workDaysFrom(items);
  assert.deepEqual(work.done, { '2026-09-21': 1, '2026-09-27': 1, '2026-09-22': 1 });
  assert.deepEqual(work.doneSlack, { '2026-09-27': 1 });
  assert.deepEqual(work.inSlack, { '2026-09-21': 1 });
  assert.deepEqual(work.inDirect, { '2026-09-20': 1, '2026-09-27': 1, '2026-09-28': 1, '2026-09-22': 1, '2026-09-23': 1 });
  assert.deepEqual(work.records, { '2026-09-23': { check: 1, decision: 1, idea: 1 } });
  // 지운 업무는 업무 목록에 없으니 세지 않는다.
  assert.deepEqual(workDaysFrom(items.filter(item => !item || item.id !== 'mon')).done, { '2026-09-27': 1, '2026-09-22': 1 });
  assert.deepEqual(workDaysFrom(undefined), { done: {}, doneSlack: {}, inSlack: {}, inDirect: {}, records: {} });
});

test('WP-Y 본문 `완료한 일` 근거 업무 수 = work.done의 그 주 합(사람이 뺀 문장의 업무도 센다)', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-usage-report-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const week = '2026-09-21';
  const items = [
    { id: 'a', type: 'task', description: '가입 문구 검토하기', status: 'done', created: '2026-09-14', completed: '2026-09-21', group: '가입' },
    { id: 'b', type: 'task', description: '가입 버튼 고치기', status: 'done', created: '2026-09-22', completed: '2026-09-27', group: '가입' },
    { id: 'c', type: 'bug', description: '결제 오류 확인하기', status: 'done', created: '2026-09-22', completed: '2026-09-23', group: '결제', permalink: 'https://s/2' },
    { id: 'd', type: 'task', description: '다음 주로 넘김', status: 'done', created: '2026-09-22', completed: '2026-09-28', group: '결제' },
    { id: 'e', type: 'task', description: '지난주 끝남', status: 'done', created: '2026-09-10', completed: '2026-09-20', group: '결제' },
    { id: 'f', type: 'check', description: '법무 확인', status: 'done', created: '2026-09-22', completed: '2026-09-23' },
    { id: 'g', type: 'decision', description: '환불은 7일', status: 'to-do', created: '2026-09-22' },
    { id: 'h', type: 'task', description: '진행 중 일', status: 'to-do', created: '2026-09-22', doing: '2026-09-22' },
  ];
  const store = reportFactory({ directory, sources: () => items, legacy: () => [], currentWeek: () => week });
  const doneIds = () => new Set(store.view(week).rows.filter(row => row.heading === '완료한 일').flatMap(row => row.sourceIds));
  const weekDone = () => Object.entries(workDaysFrom(items).done).filter(([day]) => day >= week && day <= '2026-09-27').reduce((sum, [, n]) => sum + n, 0);
  assert.equal(doneIds().size, 3);
  assert.equal(weekDone(), doneIds().size, '본문 근거 수와 같다');
  // 사람이 한 문장을 보고에서 빼도 업무 수는 그대로(업무 수 기준).
  const first = store.view(week).rows.find(row => row.heading === '완료한 일');
  store.change({ weekKey: week, revision: store.view(week).revision, action: 'exclude', id: first.id });
  assert.equal(store.view(week).rows.find(row => row.id === first.id).excluded, true);
  assert.equal(doneIds().size, 3);
  assert.equal(weekDone(), 3);
});

test('WP-Y normalizeWork — 날짜 키·양의 정수만, 모양이 어긋나면 null', () => {
  assert.equal(normalizeWork(null), null);
  assert.equal(normalizeWork([]), null);
  assert.equal(normalizeWork({ done: {} }), null, '칸이 빠짐');
  assert.equal(normalizeWork({ done: [], doneSlack: {}, inSlack: {}, inDirect: {}, records: {} }), null);
  assert.deepEqual(normalizeWork({ done: { '2026-09-01': 2, x: 3, '2026-09-02': -1, '2026-09-03': 1.5 }, doneSlack: {}, inSlack: {}, inDirect: {}, records: { '2026-09-01': { idea: 1, jira: 4, check: 0 }, bad: { idea: 1 } } }),
    { done: { '2026-09-01': 2 }, doneSlack: {}, inSlack: {}, inDirect: {}, records: { '2026-09-01': { idea: 1 } } });
});

// 가짜 요청으로 createUsage의 GET /api/usage를 부른다(서버를 띄우지 않고 deps만 바꿔 끼운다).
function usageGet(usage) {
  return new Promise((resolve) => {
    const res = { status: 0, writeHead(status) { this.status = status; }, end(body) { resolve({ status: this.status, body: JSON.parse(body) }); } };
    usage.route({ method: 'GET' }, res, new URL('http://x/api/usage'), {});
  });
}

test('WP-Y 업무 읽기 실패(던짐·없음·깨진 값) — GET /api/usage는 200, work null, 나머지 칸은 그대로', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-usage-work-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'usage.json'), JSON.stringify(usageDays({ [TODAY]: { task_done: 2 }, [ago(3)]: { jira_create: 1 } })));
  const make = workDays => createUsage({ localDir: () => dir, today: () => TODAY, canSend: () => false, ...(workDays === undefined ? {} : { workDays }) });
  const plain = await usageGet(make(undefined));
  assert.equal(plain.status, 200);
  assert.equal(plain.body.work, null);
  for (const workDays of [() => { throw new Error('업무 파일을 못 읽음'); }, () => undefined, () => ({ done: 'x' }), () => [], 'not a function']) {
    const got = await usageGet(make(workDays));
    assert.equal(got.status, 200);
    assert.equal(got.body.work, null);
    assert.deepEqual(got.body, plain.body, '나머지 칸은 같다');
  }
  const good = await usageGet(make(() => ({ done: { [TODAY]: 5 }, doneSlack: {}, inSlack: {}, inDirect: {}, records: {} })));
  assert.equal(good.status, 200);
  assert.deepEqual(good.body.work.done, { [TODAY]: 5 });
  const { work, ...rest } = good.body;
  const { work: none, ...restPlain } = plain.body;
  assert.equal(none, null);
  assert.ok(work);
  assert.deepEqual(rest, restPlain, 'work 말고는 같다');
});

test('WP-Y 보내는 칸 불변 — 같은 usage.json이면 work가 있든 없든 formFields·formPairs·체크인 본문의 사용 횟수 칸이 같다', async (t) => {
  const seed = usageDays({ [TODAY]: { task_done: 3, slack_done: 1, task_add: 2, tab_weekly: 4, jira_create: 1 }, [ago(1)]: { slack_in: 5, idea_add: 1, search: 2 } });
  const fakeWork = () => ({ done: { [TODAY]: 40 }, doneSlack: { [TODAY]: 9 }, inSlack: { [TODAY]: 7 }, inDirect: {}, records: { [TODAY]: { idea: 3 } } });
  const run = async (workDays) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-usage-same-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, 'usage.json'), JSON.stringify(seed));
    const usage = createUsage({ localDir: () => dir, today: () => TODAY, canSend: () => true, ...(workDays ? { workDays } : {}) });
    await usageGet(usage);   // GET을 먼저 불러도 보내는 칸에는 영향이 없다
    return { pairs: formPairs(sumRange(usage.load(), null, TODAY)), fields: usage.formFields('3일째', TODAY) };
  };
  const without = await run(null);
  const withWork = await run(fakeWork);
  assert.deepEqual(withWork.pairs, without.pairs);
  assert.deepEqual(withWork.fields, without.fields);
  assert.equal(without.fields.find(([entry]) => entry === USAGE_ENTRIES.taskDone)[1], '3', '끝낸 할 일 칸은 여전히 사용 기록(task_done)');
  // 체크인 답(3일째)에 붙는 칸도 같다 — 하네스의 checkin은 h.usage를 그때그때 읽으므로 work가 있는 것으로 바꿔 끼운다.
  const bodies = [];
  for (const workDays of [null, fakeWork]) {
    const h = harness(t);
    if (workDays) h.usage = createUsage({ localDir: () => h.dir, today: () => h.today, canSend: () => h.checkin.canSend(), workDays });
    h.seed(seedState(ago(3), [ago(3)]));
    h.seedUsage(seed);
    await h.open();
    await usageGet(h.usage);
    await h.checkin.act({ round: 'd3', action: 'send', answers: { setup: '쉬웠어요' } });
    const body = h.body(h.calls.length - 1);
    assert.equal(body.get(CHECKIN_AUTO_ENTRIES.round), '3일째');
    bodies.push([...body.entries()].filter(([entry]) => USAGE_ENTRY_SET.has(entry)));
  }
  assert.equal(bodies[0].length, 9);
  assert.deepEqual(bodies[1], bodies[0]);
});

test('WP-Y 서버 배선 — GET /api/usage의 work는 업무 목록(보고 초안과 같은 읽기)에서, 지운 업무는 빠진다', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-usage-server-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  serverModule.setUsageForTests({ localDir: dir });
  fs.writeFileSync(support.tasksPath, ['# Tasks',
    '- 슬랙 일 #task[id:w1 status:done priority:high created:2026-09-21 completed:2026-09-22 source:slack:https://example.test/1]',
    '- 직접 버그 #bug[id:w2 status:done priority:medium created:2026-09-22 completed:2026-09-27]',
    '- 진행 중 #task[id:w3 status:to-do priority:medium created:2026-09-23]',
    '- 확인 #check[id:w4 status:done priority:medium created:2026-09-23 completed:2026-09-24]',
    '- 결정 #decision[id:w5 status:to-do priority:medium created:2026-09-24]',
    '- 아이디어 #idea[id:w6 status:to-do priority:medium created:2026-09-24]', ''].join('\n'));
  const info = await (await fetch(base + '/api/usage')).json();
  // 다른 테스트가 남긴 결정·확인·아이디어 파일(오늘 날짜)이 있을 수 있어 records는 이 테스트의 날짜만 본다.
  const { records, ...counts } = info.work;
  assert.deepEqual(counts, {
    done: { '2026-09-22': 1, '2026-09-27': 1 }, doneSlack: { '2026-09-22': 1 },
    inSlack: { '2026-09-21': 1 }, inDirect: { '2026-09-22': 1, '2026-09-23': 1 },
  });
  assert.deepEqual([records['2026-09-23'], records['2026-09-24']], [{ check: 1 }, { decision: 1, idea: 1 }]);
  // 지우면(휴지통) 세지 않는다.
  const removed = await fetch(base + '/api/track/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'w2' }) });
  assert.equal(removed.status, 200);
  const after = await (await fetch(base + '/api/usage')).json();
  assert.deepEqual(after.work.done, { '2026-09-22': 1 });
  assert.deepEqual(after.work.inDirect, { '2026-09-23': 1 });
});

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
const { createUsage, USAGE_ENTRIES } = require('./usage');

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
  for (const bad of ['task_add', 'jira_create', 'evil', '', null, 3, '__proto__']) assert.equal((await tick(bad)).status, 400, String(bad));
  for (const good of ['tab_today', 'tab_weekly', 'search', 'weekly_copy', 'search']) assert.equal((await tick(good)).status, 200, good);
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

test('WP-R 화면 파일 규칙 — innerHTML 없음, 알림 줄·끄기·다시 켜기·스위치·내 사용 기록·체크인 안내 문구', () => {
  const read = name => fs.readFileSync(path.join(__dirname, name), 'utf8').split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n');
  const ui = read('usage-ui.js');
  assert.equal(/innerHTML|insertAdjacentHTML|outerHTML/.test(ui), false);
  for (const words of ['어떤 기능을 많이 쓰는지 익명으로 모아 앱을 고치는 데 써요 · ', '끄기', '모으지 않아요 · ', '다시 켜기', '익명 사용 횟수 보내기',
    '어떤 기능이 쓸모 있는지 보고 앱을 고치는 데 써요 — 기능별 횟수만, 이름·업무 내용은 보내지 않아요', '내 사용 기록', "'switch'"]) assert.ok(ui.includes(words), words);
  assert.match(read('checkin-ui.js'), /이름과 업무 내용은 보내지 않아요\. 앱을 고치는 데 쓰려고 기능별 사용 횟수는 함께 보내요/);
  // 부르는 자리 — 탭·검색·주간요약 복사·사용설명서 두 곳·설정 › 앱.
  assert.match(read('app.js'), /usageTabOpened\(tab, activeTabKey\)/);
  assert.match(read('app.js'), /usageTick\('search'\)/);
  assert.match(read('report-ui.js'), /usageTick\('weekly_copy'\)/);
  assert.equal((read('app.js').match(/usageGuideLine\(\)/g) || []).length, 1);
  assert.equal((read('settings-ui.js').match(/usageGuideLine\(\)/g) || []).length, 1);
  assert.match(read('settings-ui.js'), /usageSettingsRow\(\)/);
});

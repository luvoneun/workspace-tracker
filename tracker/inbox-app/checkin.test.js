// 체크인(WP-N) — 설치 3일째·8일째 질문, 구글 폼 익명 제출.
// **실제 구글에는 절대 보내지 않는다**: 전송은 전부 가짜 fetch(createCheckin의 request · setCheckinForTests의 fetch)이고,
// 상태 파일은 임시 폴더의 checkin.json이다(실제 `local/`에 닿지 않는다).
const { test, before, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const support = require('./test-support');
const serverModule = require('./server');
const {
  createCheckin, CHECKIN_FORM_URL, CHECKIN_QUESTIONS, CHECKIN_AUTO_ENTRIES,
} = require('./checkin');

let base;
before(async () => { base = await support.ready(); });
afterEach(() => serverModule.setCheckinForTests({ fetch: null }));

const TODAY = '2026-10-10';
const addDays = (day, n) => { const at = new Date(`${day}T00:00:00Z`); at.setUTCDate(at.getUTCDate() + n); return at.toISOString().slice(0, 10); };
const ago = n => addDays(TODAY, -n);

// 임시 폴더 하나 + 가짜 전송. `h.reply`를 바꿔 성공·실패·닫힘을 흉내 낸다.
function harness(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-checkin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const h = {
    dir, today: options.today || TODAY, calls: [], enabled: options.enabled !== false, timeoutMs: null,
    reply: async () => new Response('<html>응답이 기록되었습니다</html>', { status: 200 }),
  };
  h.file = path.join(dir, 'checkin.json');
  h.checkin = createCheckin({
    localDir: () => dir,
    today: () => h.today,
    enabled: () => h.enabled,
    version: () => '1.2.0',
    integrations: () => ({ slack: true, jira: false, calendar: true, notes: false }),
    request: async (url, init) => { h.calls.push({ url, init }); return h.reply(url, init); },
    timeoutMs: () => h.timeoutMs,
  });
  h.seed = value => fs.writeFileSync(h.file, typeof value === 'string' ? value : JSON.stringify(value));
  h.read = () => JSON.parse(fs.readFileSync(h.file, 'utf8'));
  h.poll = () => h.checkin.poll().result;
  h.body = (index = 0) => new URLSearchParams(h.calls[index].init.body);
  return h;
}
const seedState = (firstDay, openDays, rounds = {}) => ({
  id: 'anon-1', firstDay, openDays, rounds: { d3: { state: 'pending' }, d8: { state: 'pending' }, ...rounds },
});

// ─────────────────────────────────────────────────────────────────────────────
// 언제 뜨나

test('WP-N 첫 실행에는 안 뜨고, 처음 연 날(firstDay)과 무작위 익명 번호만 기록한다', (t) => {
  const h = harness(t);
  assert.deepEqual(h.poll(), { show: null });
  const state = h.read();
  assert.equal(state.firstDay, TODAY);
  assert.deepEqual(state.openDays, [TODAY]);
  assert.match(state.id, /^[0-9a-f-]{36}$/, 'crypto.randomUUID');
  assert.equal(h.poll().show, null, '같은 날 다시 물어도 안 뜬다');
});

test('WP-N 3일째 — 3일이 지나고 연 날이 2일 이상이면 3일째 질문(폼과 같은 제목·선택지)', (t) => {
  const h = harness(t);
  h.seed(seedState(ago(3), [ago(3)]));
  const result = h.poll();
  assert.equal(result.show, 'd3');
  assert.equal(result.canSnooze, true);
  assert.equal(result.eyebrow, '쓴 지 3일 · 30초면 끝나요');
  assert.deepEqual(result.questions.map(q => q.key), ['setup', 'helped', 'comment']);
  assert.deepEqual(result.questions[1].options, ['오늘 할 일', '슬랙 모으기', '지라', '캘린더', '회의록', '주간요약', '아이디어', '결정', '확인 대기', '프로젝트']);
  assert.equal(result.questions[0].title, '설치와 설정이 어렵지 않았나요?');
  assert.equal(result.questions[2].placeholder, '한 줄이면 충분해요');
  assert.ok(result.questions.every(q => !('entry' in q)), '폼 칸 번호는 화면에 주지 않는다');
  assert.deepEqual(h.read().openDays, [ago(3), TODAY]);
});

test('WP-N 거의 안 연 사람 — 달력만 차고 연 날이 모자라면 기다리고, 8일이 넘어도 3일째부터 차례로', (t) => {
  const h = harness(t);
  h.seed(seedState(ago(5), []));
  assert.equal(h.poll().show, null, '연 날 1일(오늘)뿐 — 3일째는 연 날 2일 이상');
  h.seed(seedState(ago(10), [ago(10)]));
  assert.equal(h.poll().show, 'd3', '10일째라도 연 날 2일이면 8일째(4일)가 아니라 3일째');
  assert.equal(h.read().rounds.d3.state, 'pending');
});

test('WP-N 8일째 — 3일째를 끝냈으면 8일이 지나고 연 날 4일 이상일 때 8일째 질문', (t) => {
  const h = harness(t);
  h.seed(seedState(ago(8), [ago(8), ago(5), ago(2)], { d3: { state: 'sent', sentAt: 'x' } }));
  const result = h.poll();
  assert.equal(result.show, 'd8');
  assert.equal(result.eyebrow, '쓴 지 8일 · 마지막 질문이에요');
  assert.deepEqual(result.questions.map(q => q.key), ['missed', 'time', 'nps', 'keep', 'comment']);
  assert.equal(result.questions[0].title, '일을 놓치는 일이 줄었나요?');
  assert.deepEqual(result.questions[3].options, ['네', '아마도', '아니요']);
});

test('WP-N 3일째를 못 한 채 8일째가 되면 3일째는 건너뜀, 8일째만 묻는다(두 창을 연달아 띄우지 않는다)', (t) => {
  const h = harness(t);
  h.seed(seedState(ago(9), [ago(9), ago(6), ago(3)]));
  assert.equal(h.poll().show, 'd8');
  assert.equal(h.read().rounds.d3.state, 'skipped');
  assert.equal(h.poll().show, null, '같은 날 3일째가 이어 뜨지 않는다');
});

test('WP-N 하루에 창은 최대 한 번 — 같은 날 다시 물으면 없음, 다음 날 다시', (t) => {
  const h = harness(t);
  h.seed(seedState(ago(3), [ago(3)]));
  assert.equal(h.poll().show, 'd3');
  assert.equal(h.poll().show, null);
  h.today = addDays(TODAY, 1);
  assert.equal(h.poll().show, 'd3', '답하지 않았으면 다음 날 다시');
});

test('WP-N `나중에`는 회차마다 한 번 — 다음 날 다시 뜨고 그때는 canSnooze false, 두 번째 나중에는 거절', async (t) => {
  const h = harness(t);
  h.seed(seedState(ago(3), [ago(3)]));
  assert.equal(h.poll().canSnooze, true);
  assert.deepEqual(await h.checkin.act({ round: 'd3', action: 'snooze' }), { snoozed: true });
  assert.equal(h.poll().show, null, '같은 날은 다시 안 뜬다');
  h.today = addDays(TODAY, 1);
  const again = h.poll();
  assert.equal(again.show, 'd3');
  assert.equal(again.canSnooze, false);
  await assert.rejects(h.checkin.act({ round: 'd3', action: 'snooze' }), error => error.status === 409);
  assert.equal(h.calls.length, 0, '나중에는 아무것도 보내지 않는다');
});

test('WP-N 꺼진 설치(만든 사람의 main 갈래 등)는 띄우지도 보내지도 않고 파일도 쓰지 않는다', async (t) => {
  const h = harness(t, { enabled: false });
  assert.deepEqual(h.poll(), { show: null });
  assert.equal(fs.existsSync(h.file), false);
  await assert.rejects(h.checkin.act({ round: 'd3', action: 'send', answers: {} }), error => error.status === 403);
  assert.equal(h.calls.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 보내는 본문

test('WP-N 보낼 본문 — 폼 주소·entry 번호, 체크박스는 같은 entry 반복, 자동 칸, 의견은 한 줄', async (t) => {
  const h = harness(t);
  h.seed(seedState(ago(3), [ago(3)]));
  h.poll();
  const result = await h.checkin.act({ round: 'd3', action: 'send', answers: {
    setup: '쉬웠어요', helped: ['오늘 할 일', '지라', '오늘 할 일'], comment: '할 일 줄이\n길면\r\n잘려요  ',
  } });
  assert.deepEqual(result, { sent: true });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, CHECKIN_FORM_URL);
  assert.equal(h.calls[0].init.method, 'POST');
  assert.match(h.calls[0].init.headers['Content-Type'], /^application\/x-www-form-urlencoded/);
  const body = h.body();
  assert.equal(body.get('entry.2037894728'), '쉬웠어요');
  assert.deepEqual(body.getAll('entry.1269347696'), ['오늘 할 일', '지라'], '같은 entry 반복(중복은 한 번)');
  assert.equal(body.get('entry.432833444'), '할 일 줄이 길면 잘려요', '줄바꿈 제거');
  assert.equal(body.get(CHECKIN_AUTO_ENTRIES.round), '3일째');
  assert.equal(body.get(CHECKIN_AUTO_ENTRIES.id), 'anon-1');
  assert.equal(body.get(CHECKIN_AUTO_ENTRIES.openDays), '2');
  assert.equal(body.get(CHECKIN_AUTO_ENTRIES.integrations), '슬랙, 캘린더');
  assert.equal(body.get(CHECKIN_AUTO_ENTRIES.version), '1.2.0');
  assert.equal(h.read().rounds.d3.state, 'sent');
});

test('WP-N 빈 답이어도 보내고 자동 칸은 간다 · 8일째는 회차 `8일째`와 추천 점수', async (t) => {
  const h = harness(t);
  h.seed(seedState(ago(8), [ago(8), ago(5), ago(2)], { d3: { state: 'sent' } }));
  h.poll();
  await h.checkin.act({ round: 'd8', action: 'send', answers: { nps: '8', keep: '아마도' } });
  const body = h.body();
  assert.equal(body.get(CHECKIN_AUTO_ENTRIES.round), '8일째');
  assert.equal(body.get('entry.2037688011'), '8');
  assert.equal(body.get('entry.1481130540'), '아마도');
  const empty = harness(t);
  empty.seed(seedState(ago(3), [ago(3), ago(1)]));
  assert.deepEqual(await empty.checkin.act({ round: 'd3', action: 'send' }), { sent: true });
  assert.deepEqual([...empty.body().keys()].sort(), Object.values(CHECKIN_AUTO_ENTRIES).sort(), '빈 답은 자동 칸만');
});

test('WP-N 허용 목록 밖 값은 통째로 거절하고 아무것도 보내지 않는다', async (t) => {
  const h = harness(t);
  h.seed(seedState(ago(3), [ago(3), ago(1)]));
  const bad = [
    { helped: ['오늘 할 일', '아이디어·결정'] },  // 시안의 옛 글자 — 폼에 없다
    { setup: '쉬움' },
    { missed: '많이 줄었어요' },                  // 3일째에 없는 질문
    { name: '홍길동' },                           // 모르는 칸
    { comment: ['배열'] },
    { helped: '오늘 할 일' },                     // 여러 개 답은 배열
  ];
  for (const answers of bad) {
    await assert.rejects(h.checkin.act({ round: 'd3', action: 'send', answers }), error => error.status === 400, JSON.stringify(answers));
  }
  assert.equal(h.calls.length, 0);
  assert.equal(h.read().rounds.d3.state, 'pending');
  const long = await h.checkin.act({ round: 'd3', action: 'send', answers: { comment: 'ㄱ'.repeat(500) } });
  assert.deepEqual(long, { sent: true });
  assert.equal(h.body().get('entry.432833444').length, 300, '한 줄 300자까지');
});

test('WP-N 선택지 상수는 폼의 글자와 같다(폼 칸 메모 기준)', () => {
  const byKey = Object.fromEntries(CHECKIN_QUESTIONS.map(q => [q.key, q]));
  assert.deepEqual(byKey.setup.options, ['쉬웠어요', '괜찮았어요', '어려웠어요']);
  assert.deepEqual(byKey.missed.options, ['많이 줄었어요', '조금 줄었어요', '비슷해요', '모르겠어요']);
  assert.deepEqual(byKey.time.options, ['많이 줄었어요', '조금 줄었어요', '비슷해요', '늘었어요']);
  assert.deepEqual(byKey.nps.options, Array.from({ length: 11 }, (_, i) => String(i)));
  assert.deepEqual(CHECKIN_QUESTIONS.map(q => q.entry), ['entry.2037894728', 'entry.1269347696', 'entry.1378637955', 'entry.1234968716', 'entry.2037688011', 'entry.1481130540', 'entry.432833444']);
});

// ─────────────────────────────────────────────────────────────────────────────
// 실패·대기·재전송·한 번만

test('WP-N 전송 실패면 대기로 두고, 다음 날 앱을 열 때(GET) 조용히 다시 보낸다 — 하루 한 번', async (t) => {
  const h = harness(t);
  h.seed(seedState(ago(3), [ago(3)]));
  h.poll();
  h.reply = async () => { throw new TypeError('fetch failed'); };
  assert.deepEqual(await h.checkin.act({ round: 'd3', action: 'send', answers: { setup: '괜찮았어요' } }), { queued: true });
  const queued = h.read().rounds.d3;
  assert.equal(queued.state, 'queued');
  assert.equal(queued.queuedOn, TODAY);
  const polled = h.checkin.poll();
  await polled.retry;
  assert.equal(h.calls.length, 1, '같은 날은 다시 시도하지 않는다');
  assert.equal(polled.result.show, null, '대기 중인 회차는 다시 묻지 않는다');
  h.today = addDays(TODAY, 1);
  h.reply = async () => new Response('ok', { status: 200 });
  const next = h.checkin.poll();
  await next.retry;
  assert.equal(h.calls.length, 2);
  assert.equal(h.body(1).get('entry.2037894728'), '괜찮았어요', '대기해 둔 같은 답');
  assert.equal(h.read().rounds.d3.state, 'sent');
  assert.equal(h.read().rounds.d3.queued, undefined);
});

test('WP-N 구글 오류(5xx)·10초 초과도 대기, 대기 7일이 지나면 버린다', async (t) => {
  const h = harness(t);
  h.seed(seedState(ago(3), [ago(3), ago(1)]));
  h.reply = async () => new Response('err', { status: 503 });
  assert.deepEqual(await h.checkin.act({ round: 'd3', action: 'send' }), { queued: true });
  const slow = harness(t);
  slow.seed(seedState(ago(3), [ago(3), ago(1)]));
  slow.timeoutMs = 30;
  slow.reply = () => new Promise(() => {});   // 끝나지 않는 요청
  assert.deepEqual(await slow.checkin.act({ round: 'd3', action: 'send' }), { queued: true });
  h.today = addDays(TODAY, 8);
  await h.checkin.poll().retry;
  assert.equal(h.calls.length, 1, '7일 넘은 대기는 다시 보내지 않고');
  assert.equal(h.read().rounds.d3.state, 'dropped', '버린다');
});

test('WP-N 같은 회차는 한 번만 — 보낸 뒤 다시 보내도 전송 없음', async (t) => {
  const h = harness(t);
  h.seed(seedState(ago(3), [ago(3), ago(1)]));
  await h.checkin.act({ round: 'd3', action: 'send' });
  assert.deepEqual(await h.checkin.act({ round: 'd3', action: 'send' }), { already: true });
  assert.deepEqual(await h.checkin.act({ round: 'd3', action: 'snooze' }), { already: true });
  assert.equal(h.calls.length, 1);
});

test('WP-N 두 창에서 같은 회차를 동시에 보내도 서버는 한 번만 보낸다', async (t) => {
  const h = harness(t);
  h.seed(seedState(ago(3), [ago(3), ago(1)]));
  h.reply = () => new Promise(resolve => setTimeout(() => resolve(new Response('ok', { status: 200 })), 40));
  const [a, b] = await Promise.all([
    h.checkin.act({ round: 'd3', action: 'send', answers: { setup: '쉬웠어요' } }),
    h.checkin.act({ round: 'd3', action: 'send', answers: { setup: '어려웠어요' } }),
  ]);
  assert.deepEqual([a, b], [{ sent: true }, { already: true }]);
  assert.equal(h.calls.length, 1);
});

test('WP-N 폼이 닫혔으면(404·410·"응답을 더 이상 받지 않음") closed를 적고 다시는 띄우지 않는다 — 대기 답도 버림', async (t) => {
  const h = harness(t);
  h.seed(seedState(ago(9), [ago(9), ago(6), ago(3)], { d3: { state: 'queued', queued: { fields: [['entry.748332918', '3일째']] }, queuedOn: ago(1), lastTry: ago(1) } }));
  h.reply = async () => new Response('gone', { status: 410 });
  const polled = h.checkin.poll();
  await polled.retry;
  const state = h.read();
  assert.equal(state.closed, true);
  assert.equal(state.rounds.d3.state, 'dropped');
  h.today = addDays(TODAY, 1);
  assert.deepEqual(h.poll(), { show: null }, '닫힌 뒤로는 8일째도 묻지 않는다');
  assert.deepEqual(await h.checkin.act({ round: 'd8', action: 'send' }), { closed: true });
  assert.equal(h.calls.length, 1);

  const page = harness(t);
  page.seed(seedState(ago(3), [ago(3), ago(1)]));
  page.reply = async () => new Response('<div>양식이 더 이상 응답을 받지 않습니다.</div>', { status: 200 });
  assert.deepEqual(await page.checkin.act({ round: 'd3', action: 'send' }), { closed: true });
  assert.equal(page.read().closed, true);
});

test('WP-N 보냄 판정: "응답이 기록됨" 페이지는 다른 글자가 섞여도 보냄, formResponse가 아닌 곳의 200(사내 차단·로그인)은 실패로 대기', async (t) => {
  const ok = harness(t);
  ok.seed(seedState(ago(3), [ago(3), ago(1)]));
  ok.reply = async () => new Response('<div>Your response has been recorded.</div><script>"no longer accepting responses"</script>', { status: 200 });
  await ok.checkin.act({ round: 'd3', action: 'send' });
  assert.equal(ok.read().closed, undefined, '정상 페이지 글자로 영구 중지되지 않는다');
  assert.equal(ok.read().rounds.d3.state, 'sent');

  const proxy = harness(t);
  proxy.seed(seedState(ago(3), [ago(3), ago(1)]));
  proxy.reply = async () => {
    const response = new Response('<html>사내 보안 정책으로 차단된 사이트</html>', { status: 200 });
    Object.defineProperty(response, 'url', { value: 'https://proxy.example.test/blocked' });
    return response;
  };
  await proxy.checkin.act({ round: 'd3', action: 'send' });
  assert.equal(proxy.read().rounds.d3.state, 'queued', '차단 페이지는 보낸 것이 아니다 — 대기');
});

test('WP-N checkin.json이 깨졌으면 새로 만든다(새 익명 번호, firstDay=오늘) — 죽지 않는다', (t) => {
  const h = harness(t);
  h.seed('{ 깨진 json');
  assert.deepEqual(h.poll(), { show: null });
  const state = h.read();
  assert.equal(state.firstDay, TODAY);
  assert.notEqual(state.id, 'anon-1');
  h.seed({ id: 42, firstDay: 'yesterday' });
  assert.deepEqual(h.poll(), { show: null });
  assert.equal(typeof h.read().id, 'string');
});

test('WP-N 시계가 거꾸로 갔으면(firstDay가 미래) 오늘로 바로잡고 음수 날짜로 계산하지 않는다', (t) => {
  const h = harness(t);
  h.seed(seedState(addDays(TODAY, 20), [addDays(TODAY, 20)]));
  assert.equal(h.poll().show, null);
  assert.equal(h.read().firstDay, TODAY);
  h.today = addDays(TODAY, 3);
  assert.equal(h.poll().show, 'd3', '바로잡은 날로부터 3일');
});

// ─────────────────────────────────────────────────────────────────────────────
// 서버 배선(/api/checkin) — 공용 테스트 서버에 임시 local/·가짜 전송을 끼운다.

test('WP-N GET /api/checkin — 테스트·픽스처에서는 기본 꺼짐이라 show:null이고 파일을 쓰지 않는다', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-checkin-http-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  serverModule.setCheckinForTests({ localDir: dir, today: TODAY });
  t.after(() => serverModule.setCheckinForTests({ fetch: null }));
  const data = await (await fetch(base + '/api/checkin')).json();
  assert.deepEqual(data, { ok: true, show: null });
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('WP-N /api/checkin 배선 — 켜면 3일째를 주고, 보내면 가짜 전송에 업무 문구·이름·토큰이 실리지 않는다', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-checkin-http-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'checkin.json'), JSON.stringify(seedState(ago(3), [ago(3)])));
  fs.writeFileSync(support.tasksPath, '# Tasks\n- 홍길동에게 결제 리뉴얼 비밀 문서 보내기 #task[id:secret status:to-do priority:high created:2026-10-01 scheduled:2026-10-01]\n');
  const calls = [];
  serverModule.setCheckinForTests({
    localDir: dir, today: TODAY, enabled: true,
    fetch: async (url, init) => { calls.push({ url, init }); return new Response('ok', { status: 200 }); },
  });
  t.after(() => serverModule.setCheckinForTests({ fetch: null }));
  const shown = await (await fetch(base + '/api/checkin')).json();
  assert.equal(shown.show, 'd3');
  const post = body => fetch(base + '/api/checkin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const rejected = await post({ round: 'd3', action: 'send', answers: { helped: ['홍길동'] } });
  assert.equal(rejected.status, 400);
  assert.equal(calls.length, 0);
  const sent = await (await post({ round: 'd3', action: 'send', answers: { setup: '쉬웠어요', helped: ['프로젝트'] } })).json();
  assert.deepEqual(sent, { ok: true, sent: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, CHECKIN_FORM_URL);
  const body = decodeURIComponent(calls[0].init.body);
  for (const word of ['홍길동', '결제 리뉴얼', '비밀', 'secret', 'token', 'xox']) assert.equal(body.includes(word), false, `${word}이(가) 본문에 없다`);
  const allowed = new Set([...CHECKIN_QUESTIONS.map(q => q.entry), ...Object.values(CHECKIN_AUTO_ENTRIES)]);
  assert.ok([...new URLSearchParams(calls[0].init.body).keys()].every(key => allowed.has(key)), '정해 둔 칸만 간다');
  const again = await (await post({ round: 'd3', action: 'send' })).json();
  assert.deepEqual(again, { ok: true, already: true });
  assert.equal(calls.length, 1);
});

test('WP-N 서버 파일 checkin.js는 화면으로 나가지 않고, 화면 파일 checkin-ui.js·css는 index.html이 읽는다', () => {
  assert.equal(serverModule.CLIENT_BLOCKED.has('checkin.js'), true);
  assert.equal(serverModule.isClientFile('checkin.js'), false);
  assert.equal(serverModule.isClientFile('checkin-ui.js'), true);
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  assert.match(html, /<script src="\/checkin-ui\.js"><\/script>\s*<script src="\/app\.js">/);
  assert.match(html, /href="\/checkin-ui\.css"/);
});

test('WP-N 만든 사람의 설치(업데이트 갈래 main)는 WORKSPACE_CHECKIN=1이어도 띄우지도 보내지도 않는다', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-checkin-main-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const data = path.join(home, 'data');
  const local = path.join(home, 'local');
  fs.mkdirSync(data); fs.mkdirSync(local);
  const today = support.today;
  const state = JSON.stringify(seedState(addDays(today, -3), [addDays(today, -3)]));
  const start = async (channel) => {
    const config = path.join(home, `${channel}.config.json`);
    fs.writeFileSync(config, JSON.stringify({ server: { updateChannel: channel } }));
    fs.writeFileSync(path.join(local, 'checkin.json'), state);
    return support.startAppServer(t, { WORKSPACE_DATA_DIR: data, WORKSPACE_CONFIG: config, WORKSPACE_LOCAL_DIR: local, WORKSPACE_CHECKIN: '1', WORKSPACE_REPO_DIR: home });
  };
  const main = await start('main');
  assert.deepEqual(await (await fetch(main.base + '/api/checkin')).json(), { ok: true, show: null });
  const refused = await fetch(main.base + '/api/checkin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ round: 'd3', action: 'send' }) });
  assert.equal(refused.status, 403);
  assert.equal(fs.readFileSync(path.join(local, 'checkin.json'), 'utf8'), state, 'main 갈래는 파일도 건드리지 않는다');
  // 대조: 같은 상태에 stable 갈래면 뜬다(위 결과가 우연이 아니게). 보내기는 하지 않는다 — 가짜 전송이 없는 자식 서버다.
  const stable = await start('stable');
  assert.equal((await (await fetch(stable.base + '/api/checkin')).json()).show, 'd3');
});

// ─────────────────────────────────────────────────────────────────────────────
// 화면(checkin-ui.js) — 방해하지 않기·날짜가 바뀌면 다시 묻기. 작은 가짜 창에서 실제 함수를 돌린다.

function checkinClient() {
  const listeners = {};
  const fetches = [];
  const sandbox = {
    document: {
      activeElement: null, body: {}, hidden: false,
      querySelector: () => null,
      getElementById: () => ({ hidden: true }),
      addEventListener: (name, fn) => { listeners[name] = fn; },
    },
    window: { addEventListener: (name, fn) => { listeners[`window:${name}`] = fn; } },
    fetch: async (url) => { fetches.push(url); return new Response(JSON.stringify({ ok: true, show: null })); },
    Date,
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'checkin-ui.js'), 'utf8'), context);
  return { context, sandbox, listeners, fetches, run: code => vm.runInContext(code, context) };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('WP-N 화면: 입력칸에 초점이 있거나 다른 창이 열려 있으면 묻지 않고 미뤘다가, 다음 포커스에 묻는다', async () => {
  const app = checkinClient();
  app.sandbox.document.activeElement = { matches: selector => selector.includes('textarea') };
  app.run('checkinStart()');
  await settle();
  assert.equal(app.fetches.length, 0, '글 쓰는 중에는 묻지 않는다');
  app.sandbox.document.activeElement = null;
  app.sandbox.document.querySelector = selector => (selector.includes('dialog[open]') ? {} : null);
  app.listeners['window:focus']();
  await settle();
  assert.equal(app.fetches.length, 0, '다른 창이 열려 있어도 묻지 않는다');
  app.sandbox.document.querySelector = () => null;
  app.sandbox.document.getElementById = id => ({ hidden: id !== 'storageBanner' });
  app.listeners['window:focus']();
  await settle();
  assert.equal(app.fetches.length, 0, '복구 필요 배너가 떠 있으면 묻지 않는다');
  app.sandbox.document.getElementById = () => ({ hidden: true });
  app.listeners.visibilitychange();
  await settle();
  assert.deepEqual(app.fetches, ['/api/checkin'], '방해가 없어지면 다음 보임에 묻는다');
  app.listeners['window:focus']();
  await settle();
  assert.equal(app.fetches.length, 1, '같은 날에는 다시 묻지 않는다');
});

test('WP-N 화면: 며칠씩 켜 둔 앱도 로컬 날짜가 바뀐 뒤 보이거나 포커스를 받으면 다시 묻는다', async () => {
  const app = checkinClient();
  app.run('checkinStart()');
  await settle();
  assert.equal(app.fetches.length, 1);
  app.run("checkinAskedOn = '2000-01-01'");   // 어제 물었던 것으로
  app.listeners['window:focus']();
  await settle();
  assert.equal(app.fetches.length, 2);
});

test('WP-N 화면 파일 규칙: checkin-ui.js는 innerHTML을 쓰지 않고 선택지 글자를 따로 적지 않는다(서버 상수 하나)', () => {
  const source = fs.readFileSync(path.join(__dirname, 'checkin-ui.js'), 'utf8');
  const code = source.split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n');
  assert.equal(/innerHTML|insertAdjacentHTML/.test(code), false);
  for (const word of ['쉬웠어요', '슬랙 모으기', '조금 줄었어요', '아마도']) assert.equal(code.includes(word), false, word);
  assert.match(code, /워크스페이스, 써 보니 어때요\?/);
  assert.match(code, /답은 만든 사람에게만 가요\. 이름과 업무 내용은 보내지 않아요\./);
  assert.match(code, /고마워요 — 인터넷이 돌아오면 보낼게요/);
});

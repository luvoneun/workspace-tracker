// 쉬는 틈에 자동 업데이트(WP-U)의 판단 — auto-update.js만 가짜 재료로 돌린다(서버·원격·launchd·실제 local/에 닿지 않는다).
// 서버에 실제로 이어 붙인 배선(main 갈래·쉬는 중·요청 파일)은 server.update.test.js가 실제 서버를 띄워 본다.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAutoUpdate, automationBusy, AUTO_UPDATE_IDLE_MS } = require('./auto-update');

const MIN = 60 * 1000;

// 모든 조건이 맞는 한 벌 — 테스트마다 하나씩 바꿔 막히는지 본다.
function fixture(t, overrides = {}) {
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-auto-update-'));
  t.after(() => fs.rmSync(local, { recursive: true, force: true }));
  const clock = { now: Date.parse('2026-09-29T03:00:00Z'), today: '2026-09-29' };
  const state = {
    channel: 'stable', environment: true, enabled: true,
    offer: { available: true, label: 'v1.2.2' },
    view: { running: false, status: null, settled: false },
    recovery: false, agent: true, busy: false, move: false, modified: [],
    ...overrides,
  };
  const requests = [];
  const auto = createAutoUpdate({
    now: () => clock.now,
    today: () => clock.today,
    channel: () => state.channel,
    environment: () => state.environment,
    enabled: () => state.enabled,
    offer: () => state.offer,
    status: () => state.view,
    recoveryNeeded: () => state.recovery,
    agentInstalled: () => state.agent,
    automationBusy: () => state.busy,
    needsMove: async () => state.move,
    modified: async () => state.modified,
    localDir: () => local,
    idleMs: () => AUTO_UPDATE_IDLE_MS,
    // 시계를 크게 건너뛰는 테스트가 많아 깨어남 판단은 기본으로 끈다(깨어남 테스트만 켠다).
    wakeGapMs: () => (state.wakeGap === undefined ? Infinity : state.wakeGap),
    request: async () => {
      const requestedAt = new Date(clock.now).toISOString();
      requests.push(requestedAt);
      return { status: 200, body: { ok: true, action: 'update', requestedAt } };
    },
  });
  // 파일 전체(seen 포함)와, 요청한 기록만(요청한 적이 없으면 null)
  const raw = () => { try { return JSON.parse(fs.readFileSync(path.join(local, 'auto-update.json'), 'utf8')); } catch { return null; } };
  const record = () => { const all = raw(); return all && typeof all.version === 'string' ? all : null; };
  const idle = () => { clock.now += AUTO_UPDATE_IDLE_MS + 1000; };
  return { auto, state, clock, requests, record, raw, idle, local };
}

test('WP-U 모든 조건이 맞으면(쉬는 중·새 버전·stable) 요청 한 번 + local/auto-update.json에 { version, triedOn }', async (t) => {
  const fx = fixture(t);
  fx.idle();
  same(await fx.auto.tick(), { requested: true, version: 'v1.2.2' });
  assert.equal(fx.requests.length, 1);
  const record = fx.record();
  assert.equal(record.version, 'v1.2.2');
  assert.equal(record.triedOn, '2026-09-29');
  assert.equal(record.failed, undefined);
});

test('WP-U 갈래가 main이면 다른 조건이 모두 맞아도 **절대** 요청하지 않고, 알림·기록도 없다(만든 사람의 개발 저장소)', async (t) => {
  const fx = fixture(t, { channel: 'main', offer: { available: true, label: 'main' } });
  fx.idle();
  for (let i = 0; i < 5; i += 1) {
    same(await fx.auto.tick(), { requested: false, reason: 'main' });
    fx.clock.now += 24 * 60 * MIN;
  }
  // 태그처럼 보이는 제안이 섞여 와도(설정 파일만 main으로 바뀐 순간 등) 갈래가 main이면 막는다.
  fx.state.offer = { available: true, label: 'v9.9.9' };
  same(await fx.auto.tick(), { requested: false, reason: 'main' });
  assert.equal(await fx.auto.noticeReason(), null, 'main이면 오늘 탭 한 줄도 없다');
  assert.equal(fx.requests.length, 0);
  assert.equal(fx.record(), null, '기록 파일도 쓰지 않는다');

  // 요청 직전(폴더 확인이 도는 사이) 갈래가 main으로 바뀌어도 쓰지 않는다 — 마지막에 한 번 더 본다.
  const slow = fixture(t);
  slow.idle();
  const auto = createAutoUpdate({
    now: () => slow.clock.now, today: () => slow.clock.today,
    channel: () => slow.state.channel, environment: () => true, enabled: () => true,
    offer: () => ({ available: true, label: 'v1.2.2' }), status: () => ({ running: false }),
    recoveryNeeded: () => false, agentInstalled: () => true, automationBusy: () => false,
    needsMove: async () => { slow.state.channel = 'main'; return false; }, modified: async () => [],
    localDir: () => slow.local, idleMs: () => 0,
    request: async () => { slow.requests.push('x'); return { body: { ok: true } }; },
  });
  same(await auto.tick(), { requested: false, reason: 'main' });
  assert.equal(slow.requests.length, 0);
  assert.equal(slow.record(), null);
});

test('WP-U worktree가 여럿인 저장소(만든 사람의 개발 저장소)나 그걸 알 수 없으면 요청·알림 없음, 하나뿐이면 요청', async (t) => {
  for (const [answer, requested] of [[true, false], ['throw', false], [false, true]]) {
    const fx = fixture(t);
    fx.idle();
    const auto = createAutoUpdate({
      now: () => fx.clock.now, today: () => fx.clock.today, channel: () => 'stable', environment: () => true, enabled: () => false,
      offer: () => ({ available: true, label: 'v1.2.2' }), status: () => ({ running: false }), recoveryNeeded: () => false,
      agentInstalled: () => true, automationBusy: () => false, needsMove: async () => false, modified: async () => [],
      localDir: () => fx.local, idleMs: () => 0,
      devRepo: async () => { if (answer === 'throw') throw new Error('git 실패'); return answer; },
      request: async () => ({ body: { ok: true } }),
    });
    // 스위치가 꺼져 있어도 개발 저장소면 `꺼짐` 한 줄조차 없다
    assert.equal(await auto.noticeReason(), requested ? 'off' : null, String(answer));
  }
  const dev = fixture(t);
  dev.idle();
  const auto = createAutoUpdate({
    now: () => dev.clock.now, today: () => dev.clock.today, channel: () => 'stable', environment: () => true, enabled: () => true,
    offer: () => ({ available: true, label: 'v1.2.2' }), status: () => ({ running: false }), recoveryNeeded: () => false,
    agentInstalled: () => true, automationBusy: () => false, needsMove: async () => false, modified: async () => [],
    localDir: () => dev.local, idleMs: () => 0, devRepo: async () => true,
    request: async () => { dev.requests.push('x'); return { body: { ok: true } }; },
  });
  same(await auto.tick(), { requested: false, reason: 'dev-repo' });
  assert.equal(dev.requests.length, 0);
  assert.equal(dev.record(), null);
});

test('WP-U 개발용 서버·테스트·픽스처(환경 아님)와 이미 최신이면 아무것도 없다', async (t) => {
  const dev = fixture(t, { environment: false });
  dev.idle();
  same(await dev.auto.tick(), { requested: false, reason: 'environment' });
  assert.equal(await dev.auto.noticeReason(), null);
  const latest = fixture(t, { offer: { available: false, label: 'v1.2.1' } });
  latest.idle();
  same(await latest.auto.tick(), { requested: false, reason: 'none' });
  assert.equal(await latest.auto.noticeReason(), null);
  assert.equal(dev.requests.length + latest.requests.length, 0);
});

test('WP-U 쉬는 중이 아니면(9분 전 쓰기) 없음 — 10분이 지나야 한다', async (t) => {
  const fx = fixture(t);
  fx.idle();
  fx.auto.touch();
  fx.clock.now += 9 * MIN;
  same(await fx.auto.tick(), { requested: false, reason: 'active' });
  fx.clock.now += 1 * MIN + 1000;
  assert.equal((await fx.auto.tick()).requested, true);
});

test('WP-U 다른 자동화가 도는 중이면 이번엔 건너뛰고, 끝나면 다음 기회에 요청한다', async (t) => {
  const fx = fixture(t, { busy: true });
  fx.idle();
  same(await fx.auto.tick(), { requested: false, reason: 'busy' });
  assert.equal(await fx.auto.noticeReason(), null, '잠깐 기다리면 풀리는 이유는 알리지 않는다');
  fx.state.busy = false;
  assert.equal((await fx.auto.tick()).requested, true);
});

test('WP-U 같은 버전은 하루 한 번만 — 다음 날엔 다시(실패가 아니면), 실패로 끝났으면 그 버전은 다시 자동으로 하지 않는다', async (t) => {
  const fx = fixture(t);
  fx.idle();
  assert.equal((await fx.auto.tick()).requested, true);
  same(await fx.auto.tick(), { requested: false, reason: 'tried-today' });
  assert.equal(fx.requests.length, 1);
  // 다음 날 — 실행기가 집어 가지 않았던 경우 등(실패 기록 없음)은 한 번 더
  fx.clock.now += 24 * 60 * MIN;
  fx.clock.today = '2026-09-30';
  assert.equal((await fx.auto.tick()).requested, true);
  assert.equal(fx.requests.length, 2);
  // 그 시도가 실패로 끝났다(상태 파일 failed, 요청 뒤에 시작) → 자동 중지 + 알림, 기록에 failed
  const started = new Date(fx.clock.now + 1000).toISOString();
  fx.state.view = { running: false, settled: false, status: { action: 'update', state: 'failed', startedAt: started } };
  same(await fx.auto.tick(), { requested: false, reason: 'failed' });
  assert.equal(await fx.auto.noticeReason(), 'failed');
  // 사람이 되돌리기까지 끝냈어도(상태 done·rollback) 그 버전은 다시 자동으로 하지 않는다
  fx.state.view = { running: false, settled: false, status: { action: 'rollback', state: 'done', startedAt: started } };
  fx.clock.now += 24 * 60 * MIN;
  fx.clock.today = '2026-10-01';
  same(await fx.auto.tick(), { requested: false, reason: 'failed' });
  assert.equal(fx.record().failed, true);
  assert.equal(fx.requests.length, 2);
  // 더 새 버전이 나오면 다시 자동으로 받는다
  fx.state.offer = { available: true, label: 'v1.2.3' };
  fx.state.view = { running: false, settled: false, status: null };
  assert.equal((await fx.auto.tick()).requested, true);
});

test('WP-U 지난 업데이트가 실패로 멈춘 상태면(누가 눌렀든) 자동 중지 + 한 줄 알림 — 뒤에 다른 업데이트가 끝났으면(settled) 지난 일', async (t) => {
  const fx = fixture(t, { view: { running: false, settled: false, status: { action: 'update', state: 'failed', startedAt: '2026-09-28T00:00:00Z' } } });
  fx.idle();
  same(await fx.auto.tick(), { requested: false, reason: 'failed' });
  assert.equal(await fx.auto.noticeReason(), 'failed');
  fx.state.view = { ...fx.state.view, settled: true };
  assert.equal((await fx.auto.tick()).requested, true);
});

test('WP-U 자동 꺼짐: 요청 없음 + 한 줄 알림(off)', async (t) => {
  const fx = fixture(t, { enabled: false });
  fx.idle();
  same(await fx.auto.tick(), { requested: false, reason: 'off' });
  assert.equal(await fx.auto.noticeReason(), 'off');
  assert.equal(fx.requests.length, 0);
});

test('WP-U 옮기기 필요·고친 파일·에이전트 없음: 요청 없음 + 한 줄 알림(그 이유)', async (t) => {
  for (const [override, reason] of [[{ move: true }, 'relocate'], [{ modified: ['tracker/inbox-app/app.js'] }, 'modified'], [{ agent: false }, 'not-installed']]) {
    const fx = fixture(t, override);
    fx.idle();
    same(await fx.auto.tick(), { requested: false, reason });
    assert.equal(await fx.auto.noticeReason(), reason);
    assert.equal(fx.requests.length, 0);
    assert.equal(fx.record(), null, '막힐 때는 기록도 쓰지 않는다');
  }
  // 고친 파일을 알 수 없으면(git 실패) 쓰지 않고 알리지도 않는다
  const unknown = fixture(t, { modified: null });
  unknown.idle();
  same(await unknown.auto.tick(), { requested: false, reason: 'unknown' });
});

test('WP-U 업데이트가 도는 중·복구 필요 상태면 기다린다(알리지 않는다)', async (t) => {
  const running = fixture(t, { view: { running: true, status: null } });
  running.idle();
  same(await running.auto.tick(), { requested: false, reason: 'running' });
  const recovery = fixture(t, { recovery: true });
  recovery.idle();
  same(await recovery.auto.tick(), { requested: false, reason: 'recovery' });
  assert.equal(await recovery.auto.noticeReason(), null);
});

test('WP-U 요청이 막히면(requestUpdate가 ok:false) 기록을 남기지 않는다', async (t) => {
  const fx = fixture(t);
  fx.idle();
  const auto = createAutoUpdate({
    now: () => fx.clock.now, today: () => fx.clock.today, channel: () => 'stable', environment: () => true, enabled: () => true,
    offer: () => ({ available: true, label: 'v1.2.2' }), status: () => ({ running: false }), recoveryNeeded: () => false,
    agentInstalled: () => true, automationBusy: () => false, needsMove: async () => false, modified: async () => [],
    localDir: () => fx.local, idleMs: () => 0, request: async () => ({ status: 200, body: { ok: false, reason: 'running' } }),
  });
  same(await auto.tick(), { requested: false, reason: 'running' });
  assert.equal(fx.record(), null);
});

test('WP-U 다른 자동화 판단: 잠금 폴더(새것만)·등록 요청·run-task 로그의 마지막 줄이 시작(35분 안)이면 도는 중', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-auto-busy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const logDir = path.join(root, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const now = Date.now();
  const busy = () => automationBusy({ automationDir: root, logDir, now });
  assert.equal(busy(), false, '아무것도 없으면 조용하다');

  const lock = path.join(logDir, '.slack-capture.lock');
  fs.mkdirSync(lock);
  assert.equal(busy(), true, '슬랙 수집 잠금');
  const old = new Date(now - 2 * 60 * MIN);
  fs.utimesSync(lock, old, old);
  assert.equal(busy(), false, '주인이 죽어 남은 오래된 잠금은 막지 않는다');
  fs.rmdirSync(lock);

  fs.mkdirSync(path.join(root, 'requests'));
  fs.writeFileSync(path.join(root, 'requests', 'apply.request'), '{}\n');
  assert.equal(busy(), true, '등록 다시 하기를 기다리는 중');
  fs.rmSync(path.join(root, 'requests'), { recursive: true });

  const stamp = at => { const d = new Date(at); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
  const log = path.join(logDir, 'calendar-sync.log');
  fs.writeFileSync(log, `───── ${stamp(now - 60 * MIN)} calendar-sync 시작 (v1.2.1)\n───── ${stamp(now - 59 * MIN)} calendar-sync 종료 (exit 0)\n───── ${stamp(now - 2 * MIN)} calendar-sync 시작 (v1.2.1)\n진행 중인 줄\n`);
  assert.equal(busy(), true, '마지막 표시가 시작이고 2분 전');
  fs.appendFileSync(log, `───── ${stamp(now - 1 * MIN)} calendar-sync 종료 (exit 0)\n`);
  assert.equal(busy(), false, '끝났다');
  fs.appendFileSync(log, `───── ${stamp(now - 40 * MIN)} calendar-sync 시작\n`);
  assert.equal(busy(), false, '35분이 넘은 시작(끝 줄을 못 쓴 채 죽은 흔적)은 막지 않는다');
});

test('WP-U 하루 넘게 안 깔림: 처음 본 때(seen)부터 24시간이 지나면 3분 쉼에 요청하고, 자동이 켜져 있어도 한 줄(stale)', async (t) => {
  const fresh = fixture(t);
  await fresh.auto.tick();
  same(fresh.raw().seen, { version: 'v1.2.2', at: new Date(fresh.clock.now).toISOString() }, '처음 본 때를 적는다');
  fresh.auto.touch();
  fresh.clock.now += 4 * MIN;
  same(await fresh.auto.tick(), { requested: false, reason: 'active' }, '하루가 안 됐으면 10분 그대로');
  assert.equal(await fresh.auto.noticeReason(), null);

  const old = fixture(t);
  fs.writeFileSync(path.join(old.local, 'auto-update.json'), JSON.stringify({ seen: { version: 'v1.2.2', at: new Date(old.clock.now - 25 * 60 * MIN).toISOString() } }));
  assert.equal(await old.auto.noticeReason(), 'stale');
  old.auto.touch();
  old.clock.now += 2 * MIN;
  same(await old.auto.tick(), { requested: false, reason: 'active' }, '3분은 쉬어야 한다');
  old.clock.now += 1 * MIN + 1000;
  same(await old.auto.tick(), { requested: true, version: 'v1.2.2' });
  assert.equal(old.raw().seen.version, 'v1.2.2', '요청 기록을 적어도 처음 본 때는 그대로');
  // 다른 조건은 그대로 막는다 — 실패 멈춤이면 stale보다 failed가 먼저
  old.state.view = { running: false, settled: false, status: { action: 'update', state: 'failed', startedAt: new Date(old.clock.now + 1000).toISOString() } };
  assert.equal(await old.auto.noticeReason(), 'failed');

  // 더 새 버전이 나오면 그 버전의 처음 본 때부터 다시 센다
  const next = fixture(t, { offer: { available: true, label: 'v1.2.3' } });
  fs.writeFileSync(path.join(next.local, 'auto-update.json'), JSON.stringify({ seen: { version: 'v1.2.2', at: new Date(next.clock.now - 25 * 60 * MIN).toISOString() } }));
  assert.equal(await next.auto.noticeReason(), null);
  await next.auto.tick();
  assert.equal(next.raw().seen.version, 'v1.2.3');
});

test('WP-U 요청 파일이 10분 넘게 그대로면(launchd update가 안 돎) 자동이 켜져 있어도 한 줄(stuck)', async (t) => {
  const fx = fixture(t);
  fx.state.view = { running: false, status: null, pending: { action: 'update', requestedAt: new Date(fx.clock.now - 11 * MIN).toISOString() } };
  assert.equal(await fx.auto.noticeReason(), 'stuck');
  fx.state.view = { running: true, status: null, pending: { action: 'update', requestedAt: new Date(fx.clock.now - 5 * MIN).toISOString() } };
  assert.equal(await fx.auto.noticeReason(), null, '10분 안이면 아직 기다린다');
});

test('WP-U 이미 최신이면 하루 넘은 기록·남은 요청이 있어도 아무것도 없다', async (t) => {
  const fx = fixture(t, { offer: { available: false, label: 'v1.2.2' } });
  fs.writeFileSync(path.join(fx.local, 'auto-update.json'), JSON.stringify({ seen: { version: 'v1.2.2', at: new Date(fx.clock.now - 48 * 60 * MIN).toISOString() } }));
  fx.state.view = { running: false, status: null, pending: { action: 'update', requestedAt: new Date(fx.clock.now - 60 * MIN).toISOString() } };
  fx.idle();
  same(await fx.auto.tick(), { requested: false, reason: 'none' });
  assert.equal(await fx.auto.noticeReason(), null);
  assert.equal(fx.requests.length, 0);
});

test('WP-U 잠자기에서 깬 직후: 지난 판단과의 간격이 주기의 3배를 넘으면 쉬는 시간을 처음부터 센다', async (t) => {
  const fx = fixture(t, { wakeGap: 3 * MIN });
  fx.idle();
  await fx.auto.tick(); // 첫 판단(기준 시각) — 요청까지 간다
  assert.equal(fx.requests.length, 1);
  // 다음 버전: 맥이 잠들어 2시간 뒤에 깼다
  fx.state.offer = { available: true, label: 'v1.2.3' };
  fx.clock.now += 2 * 60 * MIN;
  same(await fx.auto.tick(), { requested: false, reason: 'active' }, '깬 직후에는 받지 않는다');
  // 그 뒤 1분마다 판단하며 10분이 지나면 받는다
  for (let i = 0; i < 9; i += 1) { fx.clock.now += MIN; assert.equal((await fx.auto.tick()).requested, false); }
  fx.clock.now += MIN + 1000;
  same(await fx.auto.tick(), { requested: true, version: 'v1.2.3' });
});

test('WP-U 사람이 되돌린 버전(마지막 상태가 그 버전에서 되돌리기 완료)은 자동으로 다시 깔지 않고, 한 줄은 실패 계열', async (t) => {
  const fx = fixture(t, { view: { running: false, settled: false, status: { action: 'rollback', state: 'done', from: '1.2.2', to: '1.2.1', startedAt: '2026-09-28T00:00:00Z' } } });
  fx.idle();
  same(await fx.auto.tick(), { requested: false, reason: 'rolledback' });
  assert.equal(await fx.auto.noticeReason(), 'failed');
  assert.equal(fx.requests.length, 0);
  // 더 새 버전이 나오면 그건 받는다
  fx.state.offer = { available: true, label: 'v1.2.3' };
  assert.equal((await fx.auto.tick()).requested, true);
});

function same(actual, expected, message) { assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message); }

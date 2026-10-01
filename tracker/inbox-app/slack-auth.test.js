// slack-auth.js 시험 — 임시 폴더만 쓰고(tokenDir), 슬랙 요청은 전부 가짜다. 실제 `~/.config`·실제 슬랙에는 닿지 않는다.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  getSlackToken, saveOAuthResult, readOAuthStatus, authPaths, slackClientId, retryDelayMs,
  REQUIRED_SCOPES, RETRY_DELAYS_MS,
} = require('./slack-auth');

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;
const OLD = 'xoxe.xoxp-1-OLD-ACCESS';
const OLD_REFRESH = 'xoxe-1-OLD-REFRESH';
const NEW = 'xoxe.xoxp-1-NEW-ACCESS';
const NEW_REFRESH = 'xoxe-1-NEW-REFRESH';
const SECRETS = [OLD, OLD_REFRESH, NEW, NEW_REFRESH];
const OAUTH = { slack: { auth: 'oauth', clientId: '111.222' } };

function room(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-auth-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, paths: authPaths({ config: OAUTH, tokenDir: dir }) };
}

function seed({ dir, paths }, more = {}) {
  const info = {
    version: 1, accessToken: OLD, refreshToken: OLD_REFRESH, expiresAt: NOW + 5 * MIN,
    teamId: 'T1', teamName: '팀', userId: 'U1', scopes: [...REQUIRED_SCOPES], clientId: '111.222',
    connectedAt: NOW - HOUR, refreshedAt: null, savedAt: NOW - HOUR, legacyKeptAt: null, ...more,
  };
  fs.writeFileSync(paths.oauthFile, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(paths.tokenFile, `${info.accessToken}\n`, { mode: 0o600 });
  return { config: OAUTH, tokenDir: dir, now: NOW, lockWaitMs: 5 };
}

const refreshed = (more = {}) => ({ ok: true, access_token: NEW, refresh_token: NEW_REFRESH, expires_in: 43200, token_type: 'user', ...more });
const reply = (body, status = 200) => ({ status, ok: status < 400, json: async () => body });
function fakeSlack(...answers) {
  const calls = [];
  const request = async (url, init) => {
    calls.push({ url, init });
    const next = answers.length > 1 ? answers.shift() : answers[0];
    return typeof next === 'function' ? next() : reply(next);
  };
  return { calls, request };
}
const noRequest = async () => { throw new Error('요청하면 안 된다'); };
const mode = file => fs.statSync(file).mode & 0o777;
const info = paths => JSON.parse(fs.readFileSync(paths.oauthFile, 'utf8'));
const listing = dir => fs.readdirSync(dir).sort().map(name => `${name}:${fs.statSync(path.join(dir, name)).mtimeMs}`);
const noSecrets = value => {
  const text = JSON.stringify(value);
  for (const secret of SECRETS) assert.ok(!text.includes(secret), '토큰 값이 섞여 있다');
};
function deadPid() {
  // 직접 띄운 프로세스가 끝난 뒤의 pid — 신호는 보내지 않는다.
  const child = spawnSync(process.execPath, ['-e', '']);
  return child.pid;
}
function plantLock(paths, pid) {
  fs.mkdirSync(paths.lockDir);
  fs.writeFileSync(path.join(paths.lockDir, 'pid'), `${pid}\nsomeone-else\n`);
}

test('옛 방식(slack.auth 없음·token)은 한 줄 파일을 읽기만 한다', async t => {
  const { dir, paths } = room(t);
  fs.writeFileSync(paths.tokenFile, 'xoxp-legacy-token\n', { mode: 0o600 });
  const before = listing(dir);
  for (const config of [{}, { slack: {} }, { slack: { auth: 'token' } }, { slack: { auth: '이상한 값' } }, undefined]) {
    const got = await getSlackToken({ config, tokenDir: dir, request: noRequest, force: true });
    assert.deepEqual(got, { auth: 'token', token: 'xoxp-legacy-token', refreshed: false, expiresAt: null, failure: null, retryAfterMs: null });
  }
  assert.deepEqual(listing(dir), before);
  assert.deepEqual(readOAuthStatus({ config: {}, tokenDir: dir }), { auth: 'token', connected: true });
});

test('옛 방식에서 토큰 파일이 없으면 빈 값이고 아무것도 만들지 않는다', async t => {
  const { dir } = room(t);
  const got = await getSlackToken({ config: {}, tokenDir: dir, request: noRequest });
  assert.equal(got.token, '');
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.deepEqual(readOAuthStatus({ config: {}, tokenDir: dir }), { auth: 'token', connected: false });
});

test('tokenDir를 끼우면 config의 경로를 보지 않고 그 폴더 안만 본다', t => {
  const { dir } = room(t);
  const config = { slack: { auth: 'oauth', oauthFile: '~/.config/elsewhere.json', tokenFile: '/etc/elsewhere' } };
  const paths = authPaths({ config, tokenDir: dir });
  for (const file of Object.values(paths)) assert.ok(file.startsWith(dir + path.sep));
  const free = authPaths({ config, tokenDir: '' });
  if (!process.env.WORKSPACE_TOKEN_DIR) {
    assert.equal(free.oauthFile, path.join(os.homedir(), '.config/elsewhere.json'));
    assert.equal(free.tokenFile, '/etc/elsewhere');
  }
});

test('Client ID는 slack.clientId가 기본값을 덮는다', () => {
  assert.equal(slackClientId({ slack: { clientId: ' 9.9 ' } }), '9.9');
  assert.equal(typeof slackClientId({}), 'string');
});

test('만료가 멀면 갱신하지 않고 아무것도 쓰지 않는다', async t => {
  const r = room(t);
  const base = seed(r, { expiresAt: NOW + 6 * HOUR });
  const before = listing(r.dir);
  const got = await getSlackToken({ ...base, request: noRequest });
  assert.deepEqual(got, { auth: 'oauth', token: OLD, refreshed: false, expiresAt: NOW + 6 * HOUR, failure: null, retryAfterMs: null });
  assert.deepEqual(listing(r.dir), before);
});

test('만료가 가까우면 갱신하고 두 파일에 새 값을 0600으로 쓴다', async t => {
  const r = room(t);
  const base = seed(r);
  const slack = fakeSlack(refreshed());
  const got = await getSlackToken({ ...base, request: slack.request });
  assert.equal(got.token, NEW);
  assert.equal(got.refreshed, true);
  assert.equal(got.failure, null);
  assert.equal(got.expiresAt, NOW + 43200 * 1000);

  assert.equal(slack.calls.length, 1);
  const sent = new URLSearchParams(slack.calls[0].init.body);
  assert.equal(slack.calls[0].url, 'https://slack.com/api/oauth.v2.access');
  assert.equal(slack.calls[0].init.method, 'POST');
  assert.deepEqual(Object.fromEntries(sent), { grant_type: 'refresh_token', refresh_token: OLD_REFRESH, client_id: '111.222' });
  assert.ok(!sent.has('client_secret'));

  const saved = info(r.paths);
  assert.equal(saved.accessToken, NEW);
  assert.equal(saved.refreshToken, NEW_REFRESH, '새 갱신 토큰을 저장한다');
  assert.equal(saved.expiresAt, NOW + 43200 * 1000);
  assert.equal(saved.teamId, 'T1');
  assert.equal(fs.readFileSync(r.paths.tokenFile, 'utf8'), `${NEW}\n`);
  assert.equal(mode(r.paths.oauthFile), 0o600);
  assert.equal(mode(r.paths.tokenFile), 0o600);
  assert.deepEqual(fs.readdirSync(r.dir).sort(), ['workspace-slack-oauth.json', 'workspace-slack-token']);
});

test('minValidMs 기준이 다르면 같은 파일에서도 갱신 여부가 갈린다(수집 10분·서버 60분)', async t => {
  const r = room(t);
  const base = seed(r, { expiresAt: NOW + 30 * MIN });
  assert.equal((await getSlackToken({ ...base, request: noRequest, minValidMs: 10 * MIN })).token, OLD);
  const slack = fakeSlack(refreshed());
  assert.equal((await getSlackToken({ ...base, request: slack.request, minValidMs: 60 * MIN })).token, NEW);
  assert.equal(slack.calls.length, 1);
});

test('갱신 응답이 authed_user 안에 와도 받는다', async t => {
  const r = room(t);
  const base = seed(r);
  const slack = fakeSlack({ ok: true, authed_user: { id: 'U1', access_token: NEW, refresh_token: NEW_REFRESH, expires_in: 43200, scope: 'channels:read,users:read' } });
  const got = await getSlackToken({ ...base, request: slack.request });
  assert.equal(got.token, NEW);
  assert.equal(info(r.paths).refreshToken, NEW_REFRESH);
  assert.deepEqual(info(r.paths).scopes, ['channels:read', 'users:read']);
});

test('두 호출이 동시에 와도 갱신 요청은 한 번이다', async t => {
  const r = room(t);
  const base = seed(r);
  const slack = fakeSlack(async () => {
    await new Promise(resolve => setTimeout(resolve, 60));
    return reply(refreshed());
  });
  const [a, b, c] = await Promise.all([1, 2, 3].map(() => getSlackToken({ ...base, request: slack.request })));
  assert.equal(slack.calls.length, 1);
  assert.deepEqual([a.token, b.token, c.token], [NEW, NEW, NEW]);
  assert.equal([a, b, c].filter(one => one.refreshed).length, 1);
  assert.ok(!fs.existsSync(r.paths.lockDir), '잠금을 풀었다');
});

test('죽은 pid가 남긴 잠금은 거두고 갱신한다', async t => {
  const r = room(t);
  const base = seed(r);
  plantLock(r.paths, deadPid());
  const slack = fakeSlack(refreshed());
  const got = await getSlackToken({ ...base, request: slack.request, lockTries: 3 });
  assert.equal(got.token, NEW);
  assert.equal(slack.calls.length, 1);
  assert.ok(!fs.existsSync(r.paths.lockDir));
  assert.deepEqual(fs.readdirSync(r.dir).sort(), ['workspace-slack-oauth.json', 'workspace-slack-token']);
});

test('pid를 읽을 수 없는 잠금 폴더도 거둔다', async t => {
  const r = room(t);
  const base = seed(r);
  fs.mkdirSync(r.paths.lockDir);
  fs.writeFileSync(path.join(r.paths.lockDir, 'pid'), '숫자 아님\n');
  const got = await getSlackToken({ ...base, request: fakeSlack(refreshed()).request, lockTries: 3 });
  assert.equal(got.token, NEW);
});

test('살아 있는 pid의 잠금은 기다리다 이전 토큰을 돌려주고 건드리지 않는다', async t => {
  const r = room(t);
  const base = seed(r);
  plantLock(r.paths, process.pid);
  const sleeps = [];
  const got = await getSlackToken({ ...base, request: noRequest, lockTries: 4, sleep: async ms => { sleeps.push(ms); } });
  assert.equal(got.token, OLD);
  assert.equal(got.refreshed, false);
  assert.deepEqual(got.failure, { kind: 'retry', reason: 'lock' });
  assert.equal(got.retryAfterMs, RETRY_DELAYS_MS[0]);
  assert.equal(sleeps.length, 3);
  assert.equal(fs.readFileSync(path.join(r.paths.lockDir, 'pid'), 'utf8'), `${process.pid}\nsomeone-else\n`, '남의 잠금은 그대로');
  assert.equal(info(r.paths).accessToken, OLD);
  assert.ok(!fs.existsSync(r.paths.stateFile), '잠금 대기는 고장으로 적지 않는다');
});

test('잠금을 기다리는 사이 다른 쪽이 갱신을 끝냈으면 그 토큰을 쓴다', async t => {
  const r = room(t);
  const base = seed(r);
  plantLock(r.paths, process.pid);
  const sleep = async () => { seed(r, { accessToken: NEW, refreshToken: NEW_REFRESH, expiresAt: NOW + 12 * HOUR }); };
  const got = await getSlackToken({ ...base, request: noRequest, lockTries: 2, sleep });
  assert.equal(got.token, NEW);
  assert.equal(got.failure, null);
});

test('네트워크 실패·5xx·429·깨진 응답은 retry이고 파일은 그대로다', async t => {
  const r = room(t);
  const base = seed(r);
  const oauthBefore = fs.readFileSync(r.paths.oauthFile, 'utf8');
  const cases = [
    [async () => { throw new Error(`connect failed ${OLD_REFRESH}`); }, 'network'],
    [async () => reply({ ok: false, error: 'internal_error' }, 503), 'http'],
    [async () => reply({ ok: false, error: 'ratelimited' }, 429), 'http'],
    [async () => ({ status: 200, json: async () => { throw new Error('not json'); } }), 'bad_response'],
    [async () => reply({ ok: true, refresh_token: NEW_REFRESH }), 'bad_response'],
    [async () => reply({ ok: false, error: 'some_new_error' }), 'slack_error'],
  ];
  for (const [request, reason] of cases) {
    const got = await getSlackToken({ ...base, request });
    assert.equal(got.token, OLD, reason);
    assert.equal(got.refreshed, false);
    assert.equal(got.failure.kind, 'retry');
    assert.equal(got.failure.reason, reason);
    assert.equal(fs.readFileSync(r.paths.oauthFile, 'utf8'), oauthBefore);
    assert.equal(fs.readFileSync(r.paths.tokenFile, 'utf8'), `${OLD}\n`);
    assert.ok(!fs.existsSync(r.paths.lockDir));
    noSecrets(got.failure);
  }
});

test('retry는 1 → 5 → 15분을 알려 주고, 성공하면 실패 기록이 지워진다', async t => {
  const r = room(t);
  const base = seed(r);
  const down = async () => { throw new Error('offline'); };
  const waits = [];
  for (let i = 0; i < 4; i += 1) waits.push((await getSlackToken({ ...base, request: down })).retryAfterMs);
  assert.deepEqual(waits, [1 * MIN, 5 * MIN, 15 * MIN, 15 * MIN]);
  assert.deepEqual([1, 2, 3, 9].map(retryDelayMs), [1 * MIN, 5 * MIN, 15 * MIN, 15 * MIN]);

  const status = readOAuthStatus(base);
  assert.equal(status.connected, true);
  assert.deepEqual(status.lastFailure, { kind: 'retry', reason: 'network', at: NOW });
  assert.equal(status.failCount, 4);
  assert.equal(status.nextRetryAt, NOW + 15 * MIN);

  const got = await getSlackToken({ ...base, request: fakeSlack(refreshed()).request });
  assert.equal(got.token, NEW);
  const after = readOAuthStatus(base);
  assert.equal(after.lastFailure, null);
  assert.equal(after.failCount, 0);
  assert.equal(after.refreshedAt, NOW);
});

test('invalid_refresh_token·token_revoked·invalid_grant은 reconnect이고 다시 묻지 않는다', async t => {
  for (const error of ['invalid_refresh_token', 'token_revoked', 'invalid_grant']) {
    const r = room(t);
    const base = seed(r);
    const slack = fakeSlack({ ok: false, error });
    const got = await getSlackToken({ ...base, request: slack.request });
    assert.deepEqual(got.failure, { kind: 'reconnect', reason: 'slack_error', code: error });
    assert.equal(got.retryAfterMs, null);
    assert.equal(got.token, OLD);
    assert.equal(info(r.paths).refreshToken, OLD_REFRESH);

    const again = await getSlackToken({ ...base, request: slack.request, force: true });
    assert.deepEqual(again.failure, { kind: 'reconnect', reason: 'slack_error', code: error });
    assert.equal(slack.calls.length, 1, '재시도 없음');

    const status = readOAuthStatus(base);
    assert.equal(status.connected, false);
    assert.deepEqual(status.lastFailure, { kind: 'reconnect', reason: 'slack_error', code: error, at: NOW });
    assert.equal(status.retryAfterMs, null);
  }
});

test('reconnect 뒤 새로 연결하면 다시 정상이다', async t => {
  const r = room(t);
  const base = seed(r);
  await getSlackToken({ ...base, request: fakeSlack({ ok: false, error: 'invalid_refresh_token' }).request });
  const saved = await saveOAuthResult({ ...base, response: exchange() });
  assert.equal(saved.ok, true);
  const status = readOAuthStatus(base);
  assert.equal(status.connected, true);
  assert.equal(status.lastFailure, null);
  assert.equal((await getSlackToken({ ...base, request: noRequest })).token, NEW);
});

test('갱신 정보 파일이 없거나 깨졌으면 reconnect이고 덮어쓰지 않는다', async t => {
  const r = room(t);
  fs.writeFileSync(r.paths.tokenFile, `${OLD}\n`, { mode: 0o600 });
  const base = { config: OAUTH, tokenDir: r.dir, now: NOW, request: noRequest };
  const none = await getSlackToken(base);
  assert.equal(none.token, OLD);
  assert.deepEqual(none.failure, { kind: 'reconnect', reason: 'no_oauth_file' });
  assert.equal(readOAuthStatus(base).connected, false);
  assert.equal(readOAuthStatus(base).lastFailure.reason, 'no_oauth_file');

  for (const broken of ['{"accessToken": "xo', JSON.stringify({ accessToken: OLD }), '[]']) {
    fs.writeFileSync(r.paths.oauthFile, broken);
    const bad = await getSlackToken({ ...base, force: true });
    assert.deepEqual(bad.failure, { kind: 'reconnect', reason: 'bad_oauth_file' });
    assert.equal(fs.readFileSync(r.paths.oauthFile, 'utf8'), broken);
    assert.equal(readOAuthStatus(base).lastFailure.reason, 'bad_oauth_file');
  }
});

test('Client ID가 없으면 요청하지 않고 retry다', async t => {
  const r = room(t);
  const base = seed(r, { clientId: '' });
  const got = await getSlackToken({ ...base, config: { slack: { auth: 'oauth' } }, request: noRequest });
  assert.deepEqual(got.failure, slackClientId({}) ? null : { kind: 'retry', reason: 'no_client_id' });
});

test('쓰다 실패해도 반쪽 파일이 남지 않고 원래 파일은 온전하다', async t => {
  const r = room(t);
  const base = seed(r);
  const oauthBefore = fs.readFileSync(r.paths.oauthFile, 'utf8');
  const broken = { ...fs, writeSync(fd, content) { fs.writeSync(fd, String(content).slice(0, 7)); throw new Error(`ENOSPC ${NEW}`); } };
  const slack = fakeSlack(refreshed());
  const got = await getSlackToken({ ...base, request: slack.request, fs: broken });
  assert.equal(fs.readFileSync(r.paths.oauthFile, 'utf8'), oauthBefore);
  assert.equal(fs.readFileSync(r.paths.tokenFile, 'utf8'), `${OLD}\n`);
  assert.deepEqual(fs.readdirSync(r.dir).filter(name => /\.tmp$|\.lock$|\.dead$/.test(name)), []);
  // 새 토큰은 받았으니 이번에는 그것으로 돌고, 저장 실패는 retry로 알린다.
  assert.equal(got.token, NEW);
  assert.deepEqual(got.failure, { kind: 'retry', reason: 'write' });
  noSecrets(got.failure);
  // 디스크가 막혔으니 실패 기록(상태 파일)도 못 쓴다 — 그래도 반쪽 상태 파일은 없다.
  assert.equal(readOAuthStatus(base).lastFailure, null);
});

test('사본 쓰기만 실패하면 갱신 정보는 저장되고, 다음 호출이 사본을 맞춘다', async t => {
  const r = room(t);
  const base = seed(r);
  fs.rmSync(r.paths.tokenFile);
  fs.mkdirSync(path.join(r.paths.tokenFile, 'block'), { recursive: true });
  const got = await getSlackToken({ ...base, request: fakeSlack(refreshed()).request });
  assert.equal(got.token, NEW);
  assert.equal(got.copyFailed, true);
  assert.equal(got.failure, null);
  assert.equal(info(r.paths).refreshToken, NEW_REFRESH);

  fs.rmSync(r.paths.tokenFile, { recursive: true });
  const next = await getSlackToken({ ...base, request: noRequest });
  assert.equal(next.token, NEW);
  assert.equal(fs.readFileSync(r.paths.tokenFile, 'utf8'), `${NEW}\n`);
  assert.equal(mode(r.paths.tokenFile), 0o600);
  assert.ok(!fs.existsSync(r.paths.lockDir));
});

test('force는 만료가 멀어도 한 번 갱신한다', async t => {
  const r = room(t);
  const base = seed(r, { expiresAt: NOW + 6 * HOUR });
  const slack = fakeSlack(refreshed());
  const got = await getSlackToken({ ...base, request: slack.request, force: true });
  assert.equal(got.token, NEW);
  assert.equal(got.refreshed, true);
  assert.equal(slack.calls.length, 1);
});

test('force가 동시에 둘 와도 요청은 한 번이다', async t => {
  const r = room(t);
  const base = seed(r, { expiresAt: NOW + 6 * HOUR });
  const slack = fakeSlack(async () => {
    await new Promise(resolve => setTimeout(resolve, 40));
    return reply(refreshed());
  });
  const both = await Promise.all([1, 2].map(() => getSlackToken({ ...base, request: slack.request, force: true })));
  assert.equal(slack.calls.length, 1);
  assert.deepEqual(both.map(one => one.token), [NEW, NEW]);
});

test('force에 거절당한 토큰(staleToken)을 주면, 파일이 이미 새 토큰일 때 갱신하지 않는다', async t => {
  const r = room(t);
  const base = seed(r, { accessToken: NEW, refreshToken: NEW_REFRESH, expiresAt: NOW + 6 * HOUR });
  const got = await getSlackToken({ ...base, request: noRequest, force: true, staleToken: OLD });
  assert.equal(got.token, NEW);
  assert.equal(got.refreshed, false);
  const slack = fakeSlack(refreshed({ access_token: 'xoxe.xoxp-1-THIRD', refresh_token: 'xoxe-1-THIRD-REFRESH' }));
  const forced = await getSlackToken({ ...base, request: slack.request, force: true, staleToken: NEW });
  assert.equal(forced.token, 'xoxe.xoxp-1-THIRD');
  assert.equal(slack.calls.length, 1);
});

test('오류·상태 값 어디에도 토큰 문자열이 없다', async t => {
  const r = room(t);
  const base = seed(r);
  const seen = [];
  // 슬랙이 오류 이름 자리에 토큰 모양을 돌려줘도 싣지 않는다.
  const got = await getSlackToken({ ...base, request: fakeSlack({ ok: false, error: OLD_REFRESH }).request });
  assert.deepEqual(got.failure, { kind: 'retry', reason: 'slack_error' });
  seen.push(got.failure, readOAuthStatus(base), fs.readFileSync(r.paths.stateFile, 'utf8'));
  await getSlackToken({ ...base, request: fakeSlack(refreshed()).request });
  seen.push(readOAuthStatus(base));
  seen.push(await saveOAuthResult({ ...base, response: exchange() }));
  seen.push(await saveOAuthResult({ ...base, response: exchange(), expectedTeamId: 'T-other' }));
  seen.push(await saveOAuthResult({ ...base, response: { ok: false, error: NEW } }));
  seen.push(readOAuthStatus(base));
  noSecrets(seen);
  const status = readOAuthStatus(base);
  for (const key of ['accessToken', 'refreshToken', 'token']) assert.ok(!(key in status));
});

// ---- 처음 연결 · 상태 ------------------------------------------------------------------------------

function exchange(more = {}) {
  return {
    ok: true, app_id: 'A1', team: { id: 'T1', name: '팀' },
    authed_user: { id: 'U1', scope: REQUIRED_SCOPES.join(','), access_token: NEW, refresh_token: NEW_REFRESH, token_type: 'user', expires_in: 43200 },
    ...more,
  };
}

test('saveOAuthResult는 두 파일을 0600으로 쓰고 옛 토큰을 .legacy로 남긴다', async t => {
  const r = room(t);
  fs.writeFileSync(r.paths.tokenFile, 'xoxp-legacy-token\n', { mode: 0o644 });
  const base = { config: { slack: { clientId: '111.222' } }, tokenDir: r.dir, now: NOW };
  const saved = await saveOAuthResult({ ...base, response: exchange(), expectedTeamId: 'T1' });
  assert.deepEqual(saved, {
    ok: true, teamId: 'T1', teamName: '팀', userId: 'U1', scopes: REQUIRED_SCOPES, missingScopes: [],
    expiresAt: NOW + 43200 * 1000, legacyKept: true,
  });
  const stored = info(r.paths);
  assert.equal(stored.accessToken, NEW);
  assert.equal(stored.refreshToken, NEW_REFRESH);
  assert.equal(stored.clientId, '111.222');
  assert.equal(stored.legacyKeptAt, NOW);
  assert.equal(fs.readFileSync(r.paths.tokenFile, 'utf8'), `${NEW}\n`);
  assert.equal(fs.readFileSync(r.paths.legacyFile, 'utf8'), 'xoxp-legacy-token\n');
  for (const file of [r.paths.oauthFile, r.paths.tokenFile, r.paths.legacyFile]) assert.equal(mode(file), 0o600);
  assert.ok(!fs.existsSync(r.paths.lockDir));

  const status = readOAuthStatus({ ...base, config: OAUTH, minValidMs: 60 * MIN });
  assert.deepEqual(status, {
    auth: 'oauth', connected: true, expiresAt: NOW + 12 * HOUR, expiresInMs: 12 * HOUR, nextRefreshAt: NOW + 11 * HOUR,
    scopes: REQUIRED_SCOPES, missingScopes: [], teamId: 'T1', teamName: '팀', userId: 'U1',
    connectedAt: NOW, refreshedAt: null, lastFailure: null, failCount: 0, retryAfterMs: null, nextRetryAt: null,
    legacyKept: true, legacyKeptAt: NOW,
  });
});

test('다시 연결할 때는 .legacy를 새로 만들지도 덮지도 않는다', async t => {
  const r = room(t);
  const base = seed(r);
  const again = await saveOAuthResult({ ...base, response: exchange() });
  assert.equal(again.legacyKept, false);
  assert.ok(!fs.existsSync(r.paths.legacyFile));

  const r2 = room(t);
  fs.writeFileSync(r2.paths.tokenFile, 'xoxp-second\n');
  fs.writeFileSync(r2.paths.legacyFile, 'xoxp-first\n');
  await saveOAuthResult({ config: OAUTH, tokenDir: r2.dir, now: NOW, response: exchange() });
  assert.equal(fs.readFileSync(r2.paths.legacyFile, 'utf8'), 'xoxp-first\n');
});

test('다른 워크스페이스로 허용했으면 저장하지 않는다', async t => {
  const r = room(t);
  const base = seed(r);
  const before = listing(r.dir);
  const saved = await saveOAuthResult({ ...base, response: exchange({ team: { id: 'T9', name: '남의 팀' } }), expectedTeamId: 'T1' });
  assert.deepEqual(saved, { ok: false, reason: 'team_mismatch' });
  assert.deepEqual(listing(r.dir), before);
});

test('받은 권한이 모자라도 저장하고 빠진 것을 알려 준다', async t => {
  const r = room(t);
  const response = exchange();
  response.authed_user.scope = 'channels:read,channels:history,users:read';
  const base = { config: OAUTH, tokenDir: r.dir, now: NOW };
  const saved = await saveOAuthResult({ ...base, response });
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.missingScopes, ['groups:read', 'groups:history', 'groups:write']);
  assert.deepEqual(readOAuthStatus(base).missingScopes, ['groups:read', 'groups:history', 'groups:write']);
});

test('모양이 틀린 교환 응답·잡힌 잠금·쓰기 실패는 저장하지 않고 이유만 돌려준다', async t => {
  const r = room(t);
  const base = { config: OAUTH, tokenDir: r.dir, now: NOW, lockTries: 2, lockWaitMs: 1 };
  assert.deepEqual(await saveOAuthResult({ ...base, response: { ok: false, error: 'invalid_code' } }), { ok: false, reason: 'bad_response', code: 'invalid_code' });
  assert.deepEqual(await saveOAuthResult({ ...base, response: null }), { ok: false, reason: 'bad_response' });
  const noRotation = exchange();
  delete noRotation.authed_user.refresh_token;
  assert.deepEqual(await saveOAuthResult({ ...base, response: noRotation }), { ok: false, reason: 'bad_response' });
  assert.deepEqual(fs.readdirSync(r.dir), []);

  const broken = { ...fs, writeSync() { throw new Error('ENOSPC'); } };
  assert.deepEqual(await saveOAuthResult({ ...base, response: exchange(), fs: broken }), { ok: false, reason: 'write' });
  assert.deepEqual(fs.readdirSync(r.dir), []);

  plantLock(r.paths, process.pid);
  assert.deepEqual(await saveOAuthResult({ ...base, response: exchange() }), { ok: false, reason: 'lock' });
  assert.deepEqual(fs.readdirSync(r.dir), [path.basename(r.paths.lockDir)]);
});

test('연결하는 중에 온 갱신은 연결이 끝난 뒤의 새 토큰을 쓴다(잠금을 같이 쓴다)', async t => {
  const r = room(t);
  const base = seed(r);
  const slack = fakeSlack(async () => {
    await new Promise(resolve => setTimeout(resolve, 40));
    return reply(refreshed({ access_token: 'xoxe.xoxp-1-REFRESHED', refresh_token: 'xoxe-1-REFRESHED-R' }));
  });
  const refreshing = getSlackToken({ ...base, request: slack.request });
  const saved = await saveOAuthResult({ ...base, response: exchange() });
  await refreshing;
  assert.equal(saved.ok, true);
  // 갱신이 먼저 잠갔고 연결이 그 뒤에 썼다 — 마지막에 쓴 연결 결과가 두 파일에 같이 남는다.
  assert.equal(info(r.paths).accessToken, NEW);
  assert.equal(fs.readFileSync(r.paths.tokenFile, 'utf8'), `${NEW}\n`);
});

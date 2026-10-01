'use strict';
// 슬랙 연결 버튼(OAuth + PKCE)의 서버 쪽 — state 보관함, 허용 주소, 콜백, 저장된 연결로 채널 단계 잇기.
// 실제 슬랙·실제 `~/.config`·실제 설정에는 닿지 않는다: 토큰 폴더·설정은 임시 폴더이고 슬랙은 가짜 fetch다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');

const oauth = require('./slack-oauth');
const slackAuth = require('./slack-auth');
const integrations = require('./integrations');

const NOW = 1_800_000_000_000;
const MIN = 60 * 1000;
const ACCESS = 'xoxe.xoxp-1-FAKE-ACCESS';
const REFRESH = 'xoxe-1-FAKE-REFRESH';
const base64url = buffer => buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const mode = file => fs.statSync(file).mode & 0o777;

function room(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-oauth-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ---------- state 보관함 ----------

test('start는 슬랙 허용 화면 주소를 만들고 state·code_verifier는 주소에 verifier 없이 메모리에만 둔다', () => {
  const flow = oauth.createSlackOAuth({ now: () => NOW });
  const started = flow.start({ clientId: '111.222', port: 4321 });
  const url = new URL(started.url);
  assert.equal(url.origin + url.pathname, 'https://slack.com/oauth/v2/authorize');
  assert.equal(url.searchParams.get('client_id'), '111.222');
  assert.equal(url.searchParams.get('user_scope'), slackAuth.REQUIRED_SCOPES.join(','));
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:4321/slack/callback');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(!url.searchParams.has('scope'), 'Bot 권한은 없다');
  assert.ok(!url.searchParams.has('client_secret'));
  assert.ok(!url.searchParams.has('code_verifier'));
  assert.equal(started.expiresAt, NOW + 10 * MIN);

  const entry = flow.take(url.searchParams.get('state'));
  assert.equal(base64url(createHash('sha256').update(entry.verifier).digest()), url.searchParams.get('code_challenge'), 'S256');
  assert.ok(entry.verifier.length >= 43 && entry.verifier.length <= 128);
  assert.ok(!started.url.includes(entry.verifier));
});

test('state는 한 번만 쓸 수 있고, 틀린 값·빈 값은 꺼내지지 않는다', () => {
  const flow = oauth.createSlackOAuth({ now: () => NOW });
  const state = new URL(flow.start({ clientId: 'c', port: 4321 }).url).searchParams.get('state');
  for (const wrong of ['', null, undefined, 'nope', state + 'x', 42]) assert.equal(flow.take(wrong), null);
  assert.equal(flow.status().waiting, true, '틀린 state는 기다림을 끝내지 못한다');
  assert.ok(flow.take(state));
  assert.equal(flow.take(state), null, '이미 쓴 state');
  assert.equal(flow.status().waiting, false);
});

test('state는 10분 뒤 사라지고, 기다리던 것이 다 만료되면 pending으로 적는다', () => {
  let at = NOW;
  const flow = oauth.createSlackOAuth({ now: () => at });
  const state = new URL(flow.start({ clientId: 'c', port: 4321 }).url).searchParams.get('state');
  at = NOW + 10 * MIN - 1;
  assert.deepEqual(flow.status(), { waiting: true, expiresAt: NOW + 10 * MIN, last: null });
  at = NOW + 10 * MIN;
  assert.deepEqual(flow.status(), { waiting: false, expiresAt: null, last: { ok: false, kind: 'pending', at } });
  assert.equal(flow.take(state), null, '만료된 state');
});

test('버튼을 여러 번 눌러도 state는 최대 3개 — 넘으면 가장 오래된 것을 버린다', () => {
  const flow = oauth.createSlackOAuth({ now: () => NOW });
  const states = [1, 2, 3, 4].map(() => new URL(flow.start({ clientId: 'c', port: 4321 }).url).searchParams.get('state'));
  assert.equal(new Set(states).size, 4);
  assert.equal(flow.take(states[0]), null, '가장 오래된 것은 버려졌다');
  assert.ok(flow.take(states[3]));
  assert.ok(flow.take(states[1]));
});

test('finish·cancel: 연결되면 남은 기다림도 끝나고, 취소는 결과까지 지운다. 새로 시작하면 지난 결과가 지워진다', () => {
  const flow = oauth.createSlackOAuth({ now: () => NOW });
  flow.start({ clientId: 'c', port: 4321 });
  flow.start({ clientId: 'c', port: 4321 });
  flow.finish(false, 'cancelled');
  assert.deepEqual(flow.status().last, { ok: false, kind: 'cancelled', at: NOW });
  assert.equal(flow.status().waiting, true, '실패는 다른 기다림을 끝내지 않는다');
  flow.finish(true);
  assert.deepEqual(flow.status(), { waiting: false, expiresAt: null, last: { ok: true, kind: 'connected', at: NOW } });
  flow.start({ clientId: 'c', port: 4321 });
  assert.equal(flow.status().last, null);
  flow.cancel();
  assert.deepEqual(flow.status(), { waiting: false, expiresAt: null, last: null });
});

test('버튼을 그릴 수 있는지: 다른 기기 → remote, 포트 밖 → port, Client ID 없음 → client', () => {
  assert.equal(oauth.readiness({ local: false, port: 4321, clientId: 'c' }), 'remote');
  for (const port of [4320, 4332, 80, 0, NaN, undefined, 4321.5]) assert.equal(oauth.readiness({ local: true, port, clientId: 'c' }), 'port');
  for (const port of [4321, 4322, 4331]) assert.equal(oauth.readiness({ local: true, port, clientId: 'c' }), 'ok');
  assert.equal(oauth.readiness({ local: true, port: 4321, clientId: '' }), 'client');

  const req = (remoteAddress, host) => ({ socket: { remoteAddress }, headers: { host } });
  assert.equal(oauth.isLocalRequest(req('127.0.0.1', 'localhost:4321')), true);
  assert.equal(oauth.isLocalRequest(req('::1', '127.0.0.1:4321')), true);
  assert.equal(oauth.isLocalRequest(req('100.64.0.7', 'localhost:4321')), false, '다른 기기에서 온 요청');
  assert.equal(oauth.isLocalRequest(req('127.0.0.1', '100.64.0.7:4321')), false, 'Tailscale 주소로 온 요청');
  assert.equal(oauth.isLocalRequest(req('127.0.0.1', undefined)), false);
});

test('실패 종류: 취소·막힘만 따로 말하고 모르는 오류와 이상한 값은 failed', () => {
  assert.equal(oauth.failureKind('access_denied'), 'cancelled');
  assert.equal(oauth.failureKind('invalid_team_for_non_distributed_app'), 'blocked');
  assert.equal(oauth.failureKind('team_access_not_granted'), 'blocked');
  for (const other of ['bad_redirect_uri', 'invalid_code', '', null, undefined, '<script>', 'xoxp-1-2-3', {}]) assert.equal(oauth.failureKind(other), 'failed');
});

test('완료·실패 페이지는 정해진 문구뿐이고 스크립트·외부 자원이 없다', () => {
  assert.match(oauth.page('connected'), /<b>✓ 연결됐어요<\/b>이 탭은 닫아도 돼요\./);
  for (const kind of [...Object.keys(oauth.PAGE_TEXT), '모르는 종류', '<script>alert(1)</script>']) {
    const html = oauth.page(kind);
    assert.ok(!/<script|javascript:|<link|<img|<iframe|src=|href=|url\(|@import|\son\w+=/i.test(html), kind);
    assert.ok(!html.includes('alert(1)'));
  }
  assert.equal(oauth.page('모르는 종류'), oauth.page('failed'));
  assert.match(oauth.PAGE_HEADERS['Content-Security-Policy'], /default-src 'none'/);
});

test('code 교환: Client Secret 없이 code_verifier로 묻고, 닿지 못하거나 깨진 응답은 던지지 않는다', async () => {
  const calls = [];
  const request = async (url, init) => { calls.push({ url, init }); return { json: async () => ({ ok: true, marker: 1 }) }; };
  const got = await oauth.exchangeCode({ code: 'CODE', verifier: 'VERIFIER', clientId: '111.222', port: 4325, request });
  assert.deepEqual(got, { ok: true, marker: 1 });
  assert.equal(calls[0].url, 'https://slack.com/api/oauth.v2.access');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0].init.body)), {
    client_id: '111.222', code: 'CODE', code_verifier: 'VERIFIER', redirect_uri: 'http://localhost:4325/slack/callback',
  });
  const base = { code: 'CODE', verifier: 'VERIFIER', clientId: 'c', port: 4321 };
  assert.deepEqual(await oauth.exchangeCode({ ...base, request: async () => { throw new Error('VERIFIER CODE'); } }), { ok: false, error: 'unreachable' });
  assert.deepEqual(await oauth.exchangeCode({ ...base, request: async () => ({ json: async () => { throw new Error('깨짐'); } }) }), { ok: false, error: 'unreachable' });
  assert.deepEqual(await oauth.exchangeCode({ ...base, request: async () => ({ json: async () => null }) }), { ok: false, error: 'unreachable' });
});

// ---------- 설정·저장 (integrations.js) ----------

const exchange = (more = {}) => ({
  ok: true, team: { id: 'T1', name: '팀' },
  authed_user: { id: 'U1', access_token: ACCESS, refresh_token: REFRESH, expires_in: 43200, scope: slackAuth.REQUIRED_SCOPES.join(',') },
  ...more,
});

async function connected(t, config = { slack: { clientId: '111.222' } }) {
  const dir = room(t);
  const tokenDir = path.join(dir, 'tokens');
  const configPath = path.join(dir, 'workspace.config.json');
  const saved = await slackAuth.saveOAuthResult({ response: exchange(), config, tokenDir, now: NOW });
  assert.equal(saved.ok, true);
  const current = integrations.saveSlackAuth({ configPath, current: config, tokenDir });
  return { dir, tokenDir, configPath, current, paths: slackAuth.authPaths({ config: current, tokenDir }) };
}

test('saveSlackAuth는 slack.auth만 oauth로 적고 다른 칸은 그대로 둔다', (t) => {
  const dir = room(t);
  const configPath = path.join(dir, 'workspace.config.json');
  const current = { title: '내 이름', integrations: { slack: false }, slack: { clientId: '1.2', tokenFile: '/somewhere/token', channels: { todo: { id: 'C1' } }, 모르는칸: 1 } };
  const next = integrations.saveSlackAuth({ configPath, current, tokenDir: path.join(dir, 'tokens') });
  assert.deepEqual(next, { ...current, slack: { ...current.slack, auth: 'oauth' } });
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), next);
  const fresh = integrations.saveSlackAuth({ configPath, current: {}, tokenDir: path.join(dir, 'tokens') });
  assert.deepEqual(fresh, { slack: { auth: 'oauth', tokenFile: path.join(dir, 'tokens', 'workspace-slack-token') } });
});

test('readIntegrations: 옛 방식은 auth token이고 oauth 칸이 없다. 새 방식은 자동 갱신 상태를 값 없이 싣는다', async (t) => {
  const old = integrations.readIntegrations({ slack: {} }, { tokenDir: room(t) }).slack;
  assert.equal(old.auth, 'token');
  assert.ok(!('oauth' in old));

  const c = await connected(t);
  const slack = integrations.readIntegrations(c.current, { tokenDir: c.tokenDir }).slack;
  assert.equal(slack.auth, 'oauth');
  assert.equal(slack.hasToken, true);
  assert.deepEqual(slack.oauth, {
    connected: true, expiresAt: NOW + 43200 * 1000, nextRefreshAt: NOW + 43200 * 1000 - 60 * MIN,
    missingScopes: [], lastFailure: null, teamName: '팀', legacyKept: false,
  });
  const text = JSON.stringify(slack);
  assert.ok(!text.includes(ACCESS) && !text.includes(REFRESH));

  // 갱신 정보가 사라졌으면 풀린 것으로 읽는다.
  fs.rmSync(c.paths.oauthFile);
  const gone = integrations.readIntegrations(c.current, { tokenDir: c.tokenDir }).slack.oauth;
  assert.equal(gone.connected, false);
  assert.deepEqual(gone.lastFailure, { kind: 'reconnect', reason: 'no_oauth_file' });
});

test('slackTokenForUse: 옛 방식은 한 줄 파일, 새 방식은 만료가 가까우면 갱신한 토큰, 풀렸으면 slack_reconnect', async (t) => {
  const dir = room(t);
  fs.writeFileSync(path.join(dir, 'workspace-slack-token'), 'xoxp-legacy\n');
  assert.equal(await integrations.slackTokenForUse({}, { tokenDir: dir }), 'xoxp-legacy');
  assert.equal(await integrations.slackTokenForUse({}, { tokenDir: room(t) }), '');

  const c = await connected(t);
  const never = async () => { throw new Error('요청하면 안 된다'); };
  assert.equal(await integrations.slackTokenForUse(c.current, { tokenDir: c.tokenDir, now: NOW, request: never }), ACCESS);
  const calls = [];
  const request = async (url, init) => {
    calls.push(String(init.body));
    return { status: 200, json: async () => ({ ok: true, access_token: 'xoxe.xoxp-1-RENEWED', refresh_token: 'xoxe-1-RENEWED-R', expires_in: 43200 }) };
  };
  assert.equal(await integrations.slackTokenForUse(c.current, { tokenDir: c.tokenDir, now: NOW + 43200 * 1000 - MIN, request }), 'xoxe.xoxp-1-RENEWED');
  assert.equal(calls.length, 1);

  const revoked = async () => ({ status: 200, json: async () => ({ ok: false, error: 'invalid_refresh_token' }) });
  await assert.rejects(
    integrations.slackTokenForUse(c.current, { tokenDir: c.tokenDir, now: NOW + 3 * 43200 * 1000, request: revoked }),
    error => error.code === 'slack_reconnect' && error.message === '슬랙 연결이 풀렸어요 — 다시 연결 한 번이면 돼요' && !error.message.includes('xox'),
  );
});

test('연동 저장: 새 방식이면 토큰 없는 본문도 저장된 연결로 채널을 확인한다', async (t) => {
  const c = await connected(t);
  const seen = [];
  const saved = await integrations.saveIntegrations({
    configPath: c.configPath, current: c.current, tokenDir: c.tokenDir, claude: true, now: () => NOW,
    body: { slack: { enabled: true, token: '', channels: { todo: 'C0TODO11' } } },
    slackToken: () => integrations.slackTokenForUse(c.current, { tokenDir: c.tokenDir, now: NOW }),
    slackCheck: async (token, id) => { seen.push([token, id]); return { name: 'my-todo', isPrivate: true }; },
  });
  assert.deepEqual(seen, [[ACCESS, 'C0TODO11']], '저장된 연결의 토큰으로 물었다');
  assert.equal(saved.config.slack.auth, 'oauth', '방식은 그대로');
  assert.equal(saved.config.integrations.slack, true);
  assert.equal(saved.config.slack.channels.todo.id, 'C0TODO11');
  assert.ok(!JSON.stringify(saved.result).includes(ACCESS));
  assert.ok(fs.existsSync(c.paths.oauthFile), '갱신 정보는 그대로');

  // 풀린 연결이면 저장하지 않고 다시 연결하라고 한다.
  const before = fs.readFileSync(c.configPath, 'utf8');
  fs.rmSync(c.paths.oauthFile);
  await assert.rejects(integrations.saveIntegrations({
    configPath: c.configPath, current: saved.config, tokenDir: c.tokenDir,
    body: { slack: { enabled: true, token: '', channels: { align: 'C0ALIGN1' } } },
    slackCheck: async () => { throw new Error('묻지 않는다'); },
  }), error => error.code === 'slack_reconnect');
  assert.equal(fs.readFileSync(c.configPath, 'utf8'), before);
});

test('연동 저장: 새 방식에서 토큰을 직접 붙여 넣으면 token 방식으로 되돌리고 갱신 정보를 지운다', async (t) => {
  const c = await connected(t);
  fs.writeFileSync(c.paths.stateFile, '{"failure":{"kind":"retry"}}\n');
  const saved = await integrations.saveIntegrations({
    configPath: c.configPath, current: c.current, tokenDir: c.tokenDir, claude: true,
    body: { slack: { enabled: true, token: 'xoxp-pasted', channels: { todo: 'C0TODO11' } } },
    slackToken: async () => { throw new Error('붙여 넣은 토큰이 있으면 저장된 연결을 묻지 않는다'); },
    slackCheck: async (token) => { assert.equal(token, 'xoxp-pasted'); return { name: 'my-todo', isPrivate: true }; },
  });
  assert.equal(saved.config.slack.auth, 'token');
  assert.equal(JSON.parse(fs.readFileSync(c.configPath, 'utf8')).slack.auth, 'token');
  assert.equal(fs.readFileSync(c.paths.tokenFile, 'utf8'), 'xoxp-pasted\n');
  assert.equal(mode(c.paths.tokenFile), 0o600);
  assert.ok(!fs.existsSync(c.paths.oauthFile), '갱신 정보 파일을 지웠다');
  assert.ok(!fs.existsSync(c.paths.stateFile));
  assert.ok(!fs.existsSync(c.paths.lockDir));
  assert.deepEqual(await slackAuth.getSlackToken({ config: saved.config, tokenDir: c.tokenDir }),
    { auth: 'token', token: 'xoxp-pasted', refreshed: false, expiresAt: null, failure: null, retryAfterMs: null });
});

test('연동 저장: 갱신이 잠금을 쥐고 있으면 붙여 넣은 토큰을 쓰지 않고 설정도 그대로다', async (t) => {
  const c = await connected(t);
  fs.mkdirSync(c.paths.lockDir);
  fs.writeFileSync(path.join(c.paths.lockDir, 'pid'), `${process.pid}\nsomeone-else\n`);
  const before = fs.readFileSync(c.configPath, 'utf8');
  await assert.rejects(integrations.saveIntegrations({
    configPath: c.configPath, current: c.current, tokenDir: c.tokenDir,
    body: { slack: { enabled: true, token: 'xoxp-pasted', channels: { todo: 'C0TODO11' } } },
    slackCheck: async () => ({ name: 'my-todo', isPrivate: true }),
    forgetOAuth: options => slackAuth.forgetOAuth({ ...options, lockTries: 2, lockWaitMs: 1 }),
  }), error => error.code === 'slack_busy');
  assert.equal(fs.readFileSync(c.configPath, 'utf8'), before);
  assert.equal(fs.readFileSync(c.paths.tokenFile, 'utf8'), `${ACCESS}\n`);
  assert.ok(fs.existsSync(c.paths.oauthFile));
});

test('옛 방식 저장은 예전 그대로다(방식 칸을 만들지 않고 갱신 정보를 건드리지 않는다)', async (t) => {
  const dir = room(t);
  const configPath = path.join(dir, 'workspace.config.json');
  const saved = await integrations.saveIntegrations({
    configPath, current: {}, tokenDir: dir, claude: true,
    body: { slack: { enabled: true, token: 'xoxp-pasted', channels: { todo: 'C0TODO11' } } },
    slackCheck: async () => ({ name: 'my-todo', isPrivate: true }),
    forgetOAuth: async () => { throw new Error('부르지 않는다'); },
    slackToken: async () => { throw new Error('부르지 않는다'); },
  });
  assert.ok(!('auth' in saved.config.slack));
  assert.equal(fs.readFileSync(path.join(dir, 'workspace-slack-token'), 'utf8'), 'xoxp-pasted\n');
});

// ---------- 경로 (실제로 띄운 서버 + 가짜 슬랙) ----------

// 슬랙에 등록된 돌아올 주소가 4321~4331뿐이라, 그 안에서 비어 있는 포트를 고른다(운영 4321·화면 확인용 4322는 피한다).
async function allowedPort() {
  for (let port = oauth.PORT_MAX; port >= 4323; port -= 1) {
    const free = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    if (free) return port;
  }
  return 0;
}
const freePort = () => new Promise((resolve) => {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

async function startFake(t, port, seedConfig) {
  const home = room(t);
  const data = path.join(home, 'tracker');
  fs.mkdirSync(data);
  const tokens = path.join(home, 'tokens');
  fs.mkdirSync(tokens);
  const config = path.join(home, 'workspace.config.json');
  const calls = path.join(home, 'slack-calls.log');
  fs.writeFileSync(config, JSON.stringify(seedConfig, null, 2));
  // 슬랙을 흉내 내는 껍데기 — 실제 slack.com에는 한 번도 닿지 않는다. 적는 것은 메서드와 "무엇으로 물었나"뿐(토큰·code는 적지 않는다).
  const wrapper = path.join(home, 'fake-slack-server.js');
  fs.writeFileSync(wrapper, `'use strict';
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const realFetch = globalThis.fetch;
const note = line => fs.appendFileSync(${JSON.stringify(calls)}, line + '\\n');
globalThis.fetch = async (input, init = {}) => {
  const url = String(input && input.url ? input.url : input);
  if (!url.startsWith('https://slack.com/')) return realFetch(input, init);
  const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const method = url.split('/api/')[1].split('?')[0];
  if (method === 'oauth.v2.access') {
    const form = new URLSearchParams(init.body);
    const challenge = createHash('sha256').update(form.get('code_verifier') || '').digest('base64').replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
    note(['exchange', form.get('code'), form.get('client_id'), form.get('redirect_uri'), challenge, form.has('client_secret') ? 'secret' : 'no-secret'].join(' '));
    const code = form.get('code');
    if (code === 'blocked') return json({ ok: false, error: 'invalid_team_for_non_distributed_app' });
    if (code === 'weird') return json({ ok: false, error: 'invalid_code' });
    return json({ ok: true, team: { id: code === 'otherteam' ? 'T2' : 'T1', name: '팀' },
      authed_user: { id: 'U1', access_token: ${JSON.stringify(ACCESS)}, refresh_token: ${JSON.stringify(REFRESH)}, expires_in: 43200, scope: ${JSON.stringify(slackAuth.REQUIRED_SCOPES.join(','))} } });
  }
  const auth = (init.headers || {}).Authorization || '';
  const who = auth === 'Bearer ' + ${JSON.stringify(ACCESS)} ? 'oauth' : auth === 'Bearer xoxp-pasted' ? 'pasted' : 'other';
  note(method + ' ' + who);
  if (method === 'auth.test') return json(who === 'other' ? { ok: false, error: 'invalid_auth' } : { ok: true, user: 'me', user_id: 'U1' });
  if (method === 'conversations.info') return json({ ok: true, channel: { id: new URL(url).searchParams.get('channel'), name: 'my-todo', is_private: true } });
  if (method === 'conversations.create') return json({ ok: true, channel: { id: 'C0NEW111', name: JSON.parse(init.body).name, is_private: true } });
  return json({ ok: false, error: 'unknown_method' });
};
const { server } = require(${JSON.stringify(path.join(__dirname, 'server.js'))});
server.listen(Number(process.env.WORKSPACE_PORT), '127.0.0.1', () => console.log('ready'));
`);
  const child = spawn(process.execPath, [wrapper], {
    env: {
      ...process.env, WORKSPACE_PORT: String(port), WORKSPACE_NO_OPEN: '1', WORKSPACE_HOST: '', WORKSPACE_NO_REMOTE_CHECK: '1',
      WORKSPACE_DATA_DIR: data, WORKSPACE_CONFIG: config, WORKSPACE_TOKEN_DIR: tokens,
      WORKSPACE_AUTOMATION_DIR: path.join(home, 'automation'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (chunk) => { log += chunk; });
  child.stderr.on('data', (chunk) => { log += chunk; });
  t.after(() => child.kill('SIGKILL'));
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10000;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`서버가 응답하지 않았습니다: ${log}`);
    if (child.exitCode !== null) throw new Error(`서버가 종료되었습니다 (${child.exitCode}): ${log}`);
    try { if ((await fetch(origin + '/api/storage-status')).ok) break; } catch { /* 아직 안 떴다 */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const post = (route, body = {}, headers = {}) => fetch(origin + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const get = async route => (await fetch(origin + route)).json();
  const slackLog = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) : []);
  const readConfig = () => JSON.parse(fs.readFileSync(config, 'utf8'));
  return { origin, port, tokens, config, post, get, slackLog, readConfig, serverLog: () => log };
}

test('슬랙 연결 경로: 시작 → 콜백 → 저장 → 채널 단계까지, 토큰 값은 어떤 응답·로그에도 없다', async (t) => {
  const port = await allowedPort();
  if (!port) { t.skip('4323~4331이 전부 쓰이는 중이라 건너뛴다'); return; }
  const app = await startFake(t, port, { title: '내가 지은 이름', integrations: { slack: false, calendar: false, jira: false, tiro: false } });
  const bodies = [];
  const keep = (text) => { bodies.push(text); return text; };
  const startOk = async () => {
    const text = keep(await (await app.post('/api/integrations/slack-oauth/start')).text());
    const body = JSON.parse(text);
    assert.equal(body.ok, true, text);
    return new URL(body.url);
  };
  const callback = async (query) => {
    const response = await fetch(`${app.origin}/slack/callback?${query}`, { redirect: 'manual' });
    return { status: response.status, html: keep(await response.text()), csp: response.headers.get('content-security-policy'), type: response.headers.get('content-type') };
  };
  const tokenFiles = () => fs.readdirSync(app.tokens).sort();

  // Client ID가 없으면 주소 대신 종류만 — 화면은 버튼 대신 안내 한 줄을 그린다.
  assert.deepEqual(await (await app.post('/api/integrations/slack-oauth/start')).json(), { ok: false, kind: 'client' });
  assert.equal((await app.get('/api/integrations')).slack.connect.ready, 'client');
  fs.writeFileSync(app.config, JSON.stringify({ ...app.readConfig(), slack: { clientId: '111.222' } }, null, 2));
  const first = await app.get('/api/integrations');
  assert.deepEqual(first.slack.connect, { ready: 'ok', waiting: false, expiresAt: null, last: null });
  assert.equal(first.slack.auth, 'token');

  // 기존 POST의 출처 검사 그대로 — 다른 사이트에서 온 요청은 거절.
  assert.equal((await app.post('/api/integrations/slack-oauth/start', {}, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await app.post('/api/integrations/slack-oauth/cancel', {}, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await app.get('/api/integrations/slack-oauth/status')).waiting, false);

  // 시작 — 주소 문자열만 검사한다(실제로 열지 않는다).
  const url = await startOk();
  assert.equal(url.origin + url.pathname, 'https://slack.com/oauth/v2/authorize');
  assert.equal(url.searchParams.get('client_id'), '111.222');
  assert.equal(url.searchParams.get('redirect_uri'), `http://localhost:${port}/slack/callback`);
  assert.equal(url.searchParams.get('user_scope'), slackAuth.REQUIRED_SCOPES.join(','));
  const waiting = await app.get('/api/integrations/slack-oauth/status');
  assert.equal(waiting.waiting, true);
  assert.equal(waiting.last, null);
  assert.equal((await app.get('/api/integrations')).slack.connect.waiting, true, '창을 새로 열어도 기다림이 이어진다');

  // 틀린 state — 거절하고 아무것도 바꾸지 않는다. 쿼리 글자는 페이지에 한 자도 없다.
  const forged = await callback('code=good&state=%3Cscript%3Ealert(1)%3C%2Fscript%3E&error=%3Cb%3Ehello-marker');
  assert.equal(forged.status, 400);
  assert.match(forged.type, /text\/html/);
  assert.match(forged.csp, /default-src 'none'/);
  assert.ok(!/script|alert|hello-marker/i.test(forged.html));
  assert.match(forged.html, /이 주소는 더 쓸 수 없어요/);
  assert.equal((await app.get('/api/integrations/slack-oauth/status')).waiting, true, '남이 만든 주소로 기다림을 끝낼 수 없다');
  assert.deepEqual(tokenFiles(), []);
  assert.deepEqual(app.slackLog(), [], '슬랙에 묻지도 않았다');

  // 허용 화면에서 취소
  const cancelled = await callback(`error=access_denied&state=${encodeURIComponent(url.searchParams.get('state'))}`);
  assert.equal(cancelled.status, 400);
  assert.match(cancelled.html, /취소했어요/);
  const afterCancel = await app.get('/api/integrations/slack-oauth/status');
  assert.equal(afterCancel.last.kind, 'cancelled');
  assert.equal(afterCancel.waiting, false);
  assert.match((await callback(`code=good&state=${encodeURIComponent(url.searchParams.get('state'))}`)).html, /이 주소는 더 쓸 수 없어요/, '이미 쓴 state');
  assert.deepEqual(tokenFiles(), []);

  // 회사 슬랙이 막음 · 모르는 오류
  for (const [code, kind, words] of [['blocked', 'blocked', /회사 슬랙이 이 앱을 막았어요/], ['weird', 'failed', /연결하지 못했어요/]]) {
    const again = await startOk();
    assert.match((await callback(`code=${code}&state=${encodeURIComponent(again.searchParams.get('state'))}`)).html, words);
    assert.equal((await app.get('/api/integrations/slack-oauth/status')).last.kind, kind);
  }
  assert.deepEqual(tokenFiles(), []);
  assert.equal(app.readConfig().slack.auth, undefined);

  // 앱에서 취소 — 그 뒤 슬랙에서 허용을 눌러도 연결되지 않는다.
  const dropped = await startOk();
  assert.deepEqual(await (await app.post('/api/integrations/slack-oauth/cancel')).json(), { ok: true });
  assert.deepEqual((({ waiting: w, last }) => ({ w, last }))(await app.get('/api/integrations/slack-oauth/status')), { w: false, last: null });
  assert.equal((await callback(`code=good&state=${encodeURIComponent(dropped.searchParams.get('state'))}`)).status, 400);
  assert.deepEqual(tokenFiles(), []);

  // 허용 — 토큰 저장 + 설정에 방식 적기 + 완료 페이지
  const good = await startOk();
  const done = await callback(`code=good&state=${encodeURIComponent(good.searchParams.get('state'))}`);
  assert.equal(done.status, 200);
  assert.match(done.html, /<b>✓ 연결됐어요<\/b>이 탭은 닫아도 돼요\./);
  assert.ok(!/<script/i.test(done.html));
  assert.deepEqual(tokenFiles(), ['workspace-slack-oauth.json', 'workspace-slack-token']);
  assert.equal(mode(path.join(app.tokens, 'workspace-slack-oauth.json')), 0o600);
  assert.equal(fs.readFileSync(path.join(app.tokens, 'workspace-slack-token'), 'utf8'), `${ACCESS}\n`);
  assert.equal(app.readConfig().slack.auth, 'oauth');
  assert.equal(app.readConfig().slack.clientId, '111.222');
  assert.equal(app.readConfig().title, '내가 지은 이름');
  const exchanges = app.slackLog().filter(line => line.startsWith('exchange good'));
  assert.equal(exchanges.length, 1);
  assert.equal(exchanges[0], `exchange good 111.222 http://localhost:${port}/slack/callback ${good.searchParams.get('code_challenge')} no-secret`, 'code_verifier가 주소의 code_challenge와 맞는다');
  const status = keep(JSON.stringify(await app.get('/api/integrations/slack-oauth/status')));
  assert.equal(JSON.parse(status).last.kind, 'connected');
  assert.equal(JSON.parse(status).auth, 'oauth');
  assert.equal(JSON.parse(status).oauth.connected, true);
  const state = keep(JSON.stringify(await app.get('/api/integrations')));
  assert.equal(JSON.parse(state).slack.auth, 'oauth');
  assert.equal(JSON.parse(state).slack.hasToken, true);
  assert.equal(JSON.parse(state).slack.oauth.teamName, '팀');

  // 채널 단계 — 화면은 토큰을 모른다. 서버가 저장된 연결로 같은 일을 한다.
  const check = keep(await (await app.post('/api/integrations/slack-token-check', {})).text());
  assert.deepEqual(JSON.parse(check), { ok: true, prefix: 'me' });
  const made = keep(await (await app.post('/api/integrations/slack-channel', { token: '', name: 'my-todo', key: 'todo' })).text());
  assert.deepEqual(JSON.parse(made), { ok: true, id: 'C0NEW111', name: 'my-todo' });
  const saved = keep(await (await app.post('/api/integrations/save', { slack: { enabled: true, token: '', channels: { todo: 'C0NEW111' } } })).text());
  assert.equal(JSON.parse(saved).ok, true, saved);
  assert.ok(app.slackLog().includes('auth.test oauth') && app.slackLog().includes('conversations.create oauth') && app.slackLog().includes('conversations.info oauth'));
  assert.ok(!app.slackLog().some(line => / other$/.test(line)), '빈 토큰으로 묻지 않았다');
  assert.equal(app.readConfig().slack.auth, 'oauth');
  assert.equal(app.readConfig().slack.channels.todo.id, 'C0NEW111');

  // 다시 연결하는데 다른 워크스페이스로 허용 — 저장하지 않는다.
  const beforeInfo = fs.readFileSync(path.join(app.tokens, 'workspace-slack-oauth.json'), 'utf8');
  const other = await startOk();
  assert.match((await callback(`code=otherteam&state=${encodeURIComponent(other.searchParams.get('state'))}`)).html, /다른 슬랙 워크스페이스예요/);
  assert.equal((await app.get('/api/integrations/slack-oauth/status')).last.kind, 'team');
  assert.equal(fs.readFileSync(path.join(app.tokens, 'workspace-slack-oauth.json'), 'utf8'), beforeInfo);

  // 고급: 토큰 직접 붙여 넣기 — 옛 방식으로 되돌리고 갱신 정보를 지운다.
  const pasted = keep(await (await app.post('/api/integrations/save', { slack: { enabled: true, token: 'xoxp-pasted', channels: { todo: 'C0NEW111' } } })).text());
  assert.equal(JSON.parse(pasted).ok, true, pasted);
  assert.equal(app.readConfig().slack.auth, 'token');
  assert.deepEqual(tokenFiles(), ['workspace-slack-token']);
  assert.equal(fs.readFileSync(path.join(app.tokens, 'workspace-slack-token'), 'utf8'), 'xoxp-pasted\n');
  assert.equal((await app.get('/api/integrations')).slack.auth, 'token');

  // 토큰·갱신 토큰·code_verifier는 어떤 응답·서버 로그에도 없다.
  const everything = bodies.join('\n') + app.serverLog();
  for (const secret of [ACCESS, REFRESH, 'xoxp-pasted']) assert.ok(!everything.includes(secret), '토큰 값이 섞여 있다');
});

test('슬랙 연결 경로: 서버 포트가 4321~4331 밖이면 주소 대신 안내 종류를 돌려준다', async (t) => {
  let port = await freePort();
  while (oauth.portAllowed(port)) port = await freePort();
  const app = await startFake(t, port, { integrations: { slack: false, calendar: false, jira: false, tiro: false }, slack: { clientId: '111.222' } });
  assert.deepEqual(await (await app.post('/api/integrations/slack-oauth/start')).json(), { ok: false, kind: 'port' });
  assert.equal((await app.get('/api/integrations')).slack.connect.ready, 'port');
  assert.equal((await app.get('/api/integrations/slack-oauth/status')).waiting, false);
  assert.equal((await fetch(`${app.origin}/slack/callback?code=x&state=y`)).status, 400, '콜백은 정적 파일 처리(404)보다 앞이다');
});

test('지난 결과는 10분 뒤 잊는다 — 며칠 전의 실패 이유가 다시 뜨지 않는다', () => {
  let at = NOW;
  const flow = oauth.createSlackOAuth({ now: () => at });
  // 콜백이 state를 꺼내 쓴 뒤 취소로 끝난 경우
  flow.take(new URL(flow.start({ clientId: 'c', port: 4321 }).url).searchParams.get('state'));
  flow.finish(false, 'cancelled');
  at = NOW + 10 * MIN - 1;
  assert.equal(flow.status().last.kind, 'cancelled');
  at = NOW + 10 * MIN;
  assert.deepEqual(flow.status(), { waiting: false, expiresAt: null, last: null });
  flow.finish(true);
  at += 3 * 24 * 60 * MIN;
  assert.equal(flow.status().last, null, '성공도 마찬가지');
});

test('undoOAuth: 옛 토큰이 있었으면 한 줄 파일을 되돌리고, 없었으면 지운다 — 갱신 정보는 남기지 않는다', async (t) => {
  for (const old of ['xoxp-legacy-before', '']) {
    const dir = room(t);
    const config = { slack: { clientId: '111.222' } };
    const paths = slackAuth.authPaths({ config, tokenDir: dir });
    if (old) fs.writeFileSync(paths.tokenFile, `${old}\n`, { mode: 0o600 });
    assert.equal((await slackAuth.saveOAuthResult({ response: exchange(), config, tokenDir: dir, now: NOW })).ok, true);
    assert.equal(fs.readFileSync(paths.tokenFile, 'utf8'), `${ACCESS}\n`);
    assert.equal(await slackAuth.undoOAuth({ config, tokenDir: dir }), true);
    assert.deepEqual(fs.readdirSync(dir), old ? ['workspace-slack-token'] : []);
    if (old) {
      assert.equal(fs.readFileSync(paths.tokenFile, 'utf8'), `${old}\n`);
      assert.equal(mode(paths.tokenFile), 0o600);
    }
  }
});

test('슬랙 연결 경로: 옛 방식에서 옮기다 설정 쓰기만 실패하면 옛 토큰으로 되돌리고 갱신 정보를 남기지 않는다', async (t) => {
  const port = await allowedPort();
  if (!port) { t.skip('4323~4331이 전부 쓰이는 중이라 건너뛴다'); return; }
  const seed = { integrations: { slack: true, calendar: false, jira: false, tiro: false }, slack: { clientId: '111.222', channels: { todo: { id: 'C0TODO11', name: '#my-todo' } } } };
  const app = await startFake(t, port, seed);
  const tokenFile = path.join(app.tokens, 'workspace-slack-token');
  fs.writeFileSync(tokenFile, 'xoxp-legacy-before\n', { mode: 0o600 });
  const started = await (await app.post('/api/integrations/slack-oauth/start')).json();
  const state = new URL(started.url).searchParams.get('state');
  // 설정 파일이 있는 폴더를 읽기 전용으로 — 설정 쓰기(임시 파일 + 이름 바꾸기)만 실패한다. 토큰 폴더는 그대로 쓸 수 있다.
  const home = path.dirname(app.config);
  const before = fs.readFileSync(app.config, 'utf8');
  // 가짜 슬랙이 부른 것을 적는 파일은 미리 만들어 둔다(읽기 전용 폴더에서는 새 파일을 못 만든다).
  fs.writeFileSync(path.join(home, 'slack-calls.log'), '');
  fs.chmodSync(home, 0o555);
  let response, html;
  try {
    response = await fetch(`${app.origin}/slack/callback?code=good&state=${encodeURIComponent(state)}`);
    html = await response.text();
  } finally { fs.chmodSync(home, 0o755); }
  assert.equal(response.status, 400);
  assert.match(html, /연결을 저장하지 못했어요/);
  assert.equal(fs.readFileSync(app.config, 'utf8'), before, '설정은 그대로(옛 방식)');
  assert.equal(fs.readFileSync(tokenFile, 'utf8'), 'xoxp-legacy-before\n', '한 줄 파일은 옛 토큰 그대로');
  assert.deepEqual(fs.readdirSync(app.tokens), ['workspace-slack-token'], '갱신 정보·.legacy·잠금이 남지 않는다');
  const status = await app.get('/api/integrations/slack-oauth/status');
  assert.equal(status.last.kind, 'write');
  assert.equal(status.auth, 'token');
  assert.ok(app.slackLog().some(line => line.startsWith('exchange good')), '교환까지는 갔다');
});

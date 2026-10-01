// 슬랙 토큰을 "지금 쓸 수 있는 것"으로 돌려주는 공용 모듈 — 앱 서버와 수집 스크립트(slack-collect.js)가 같이 쓴다.
//
// 두 방식:
//   - `slack.auth`가 없거나 `token`(옛 설치): 한 줄 토큰 파일을 읽어 돌려줄 뿐 아무것도 쓰지 않는다.
//   - `oauth`: 갱신 정보 파일(`~/.config/workspace-slack-oauth.json`, 0600)을 읽고, 만료가 가까울 때만
//     잠금 → 다시 읽기 → 갱신 요청 → 임시 파일 + 이름 바꾸기 → 한 줄 토큰 파일에 사본 → 잠금 풀기.
//     갱신 토큰은 쓸 때마다 바뀌어서, 두 프로세스가 같은 갱신 토큰으로 요청하면 한쪽이 연결을 잃는다 — 그래서 잠근다.
//
// 규칙:
//   1) 토큰·갱신 토큰 값은 돌려주는 실패·상태·오류 문구 어디에도 싣지 않는다(실패는 정해진 낱말과 슬랙 오류 이름뿐).
//   2) 잠금 주인은 잠금 안에 적힌 **그 pid 하나**가 살아 있는지(`process.kill(pid, 0)`)로만 본다 —
//      프로세스 목록을 훑지 않고, 0 말고는 어떤 신호도 보내지 않는다.
//   3) 비밀 파일은 `safe-storage`의 atomicWrite로 쓰지 않는다 — 그쪽은 이전 내용을 `.backups`에 남기는데,
//      옛 토큰이 한 벌 더 남으면 안 된다.
//   4) `tokenDir`(또는 `WORKSPACE_TOKEN_DIR`)를 끼우면 config에 적힌 경로가 어디든 그 폴더 안만 본다
//      (integrations.js tokenPaths와 같은 울타리 — 테스트·픽스처가 실제 `~/.config`에 닿지 않게).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// 슬랙 앱의 Client ID(비밀이 아니다 — PKCE라 Client Secret은 쓰지 않는다). 설정 `slack.clientId`가 덮는다.
const DEFAULT_CLIENT_ID = '';
const REQUIRED_SCOPES = ['channels:read', 'channels:history', 'groups:read', 'groups:history', 'users:read', 'groups:write'];
const TOKEN_URL = 'https://slack.com/api/oauth.v2.access';
const OAUTH_FILE = 'workspace-slack-oauth.json';
const TOKEN_FILE = 'workspace-slack-token';
const REQUEST_TIMEOUT_MS = 8000;
const DEFAULT_MIN_VALID_MS = 10 * 60 * 1000;
// 갱신이 잠시 안 될 때 다음 시도까지 — 1 → 5 → 15분(그 뒤로는 계속 15분). 기다리는 것은 부르는 쪽 몫이다.
const RETRY_DELAYS_MS = [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000];
// 다시 해도 소용없는 슬랙 오류 — 사람이 `다시 연결`을 눌러야 한다. 모르는 오류는 `retry`로 둔다(섣불리 끊겼다고 하지 않는다).
const RECONNECT_ERRORS = new Set([
  'invalid_refresh_token', 'token_revoked', 'invalid_grant', 'token_expired',
  'invalid_auth', 'account_inactive', 'user_removed_from_team', 'app_uninstalled',
]);
// 서버 타이머 — 15분마다 보고, 만료 60분 전이면 미리 갱신한다(수집은 실행 직전 10분 기준 — 서버가 꺼져 있을 때의 안전망).
const REFRESH_TICK_MS = 15 * 60 * 1000;
const REFRESH_AHEAD_MS = 60 * 60 * 1000;
// 옮길 때 남긴 옛 토큰(`.legacy`)을 두는 기간.
const LEGACY_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const LOCK_TRIES = 20;
const LOCK_WAIT_MS = 250;
// 잠금은 길어야 요청 제한 시간(8초) 남짓 쥔다. 이보다 훨씬 오래된 잠금 폴더는 pid가 살아 있다고 나와도 죽은 것으로 본다 —
// 죽은 주인의 pid를 다른 프로그램이 다시 받았거나 남의 것(EPERM)이면 "살아 있음"이 영영 풀리지 않기 때문이다. 폴더 시각만 본다.
const LOCK_STALE_MS = 2 * 60 * 1000;
const ABORT = Symbol('lock-abort');
const BUSY = Symbol('lock-busy');

const trimmed = value => (typeof value === 'string' ? value.trim() : '');
const expandHome = value => String(value || '').replace(/^~(?=\/|$)/, os.homedir());
const slackOf = config => (config && typeof config.slack === 'object' && config.slack) || {};
const authMode = config => (slackOf(config).auth === 'oauth' ? 'oauth' : 'token');
const slackClientId = config => trimmed(slackOf(config).clientId) || DEFAULT_CLIENT_ID;
const clockOf = now => (typeof now === 'function' ? now : typeof now === 'number' ? () => now : Date.now);
const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const retryDelayMs = count => RETRY_DELAYS_MS[Math.min(Math.max(count, 1), RETRY_DELAYS_MS.length) - 1];
// 슬랙 오류 이름은 소문자·숫자·밑줄뿐이다 — 그 모양이 아니면 버린다(토큰에는 `-`가 있어 여기를 통과하지 못한다).
const safeCode = value => (typeof value === 'string' && /^[a-z0-9_]{1,60}$/.test(value) ? value : '');
const splitScopes = value => (Array.isArray(value) ? value : String(value || '').split(','))
  .map(one => trimmed(String(one))).filter(Boolean);
const missingScopes = scopes => REQUIRED_SCOPES.filter(one => !scopes.includes(one));

function fail(kind, reason, code) {
  const failure = { kind, reason };
  if (code) failure.code = code;
  return failure;
}

function authPaths({ config, tokenDir } = {}) {
  const slack = slackOf(config);
  const custom = trimmed(tokenDir || process.env.WORKSPACE_TOKEN_DIR);
  const dir = custom || path.join(os.homedir(), '.config');
  const pick = (configured, name) => (!custom && trimmed(configured) ? expandHome(trimmed(configured)) : path.join(dir, name));
  const oauthFile = pick(slack.oauthFile, OAUTH_FILE);
  const tokenFile = pick(slack.tokenFile, TOKEN_FILE);
  return {
    oauthFile, tokenFile,
    // 옛 방식에서 config의 경로에 없을 때 볼 기본 자리(integrations.js findToken과 같은 순서).
    tokenFallback: path.join(dir, TOKEN_FILE),
    // 마지막 실패만 적는 파일(값 없음). 갱신 정보 파일은 실패했을 때 건드리지 않으려고 따로 둔다.
    stateFile: `${oauthFile}.state`,
    lockDir: `${oauthFile}.lock`,
    legacyFile: `${tokenFile}.legacy`,
  };
}

function readLine(file) {
  try { return String(fs.readFileSync(file, 'utf8') || '').trim(); } catch { return ''; }
}

function readJson(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) { return { missing: error.code === 'ENOENT', bad: error.code !== 'ENOENT' }; }
  try { return { value: JSON.parse(text) }; } catch { return { bad: true }; }
}

// 갱신 정보 파일 — 모양이 맞을 때만 `info`. 없으면 `missing`, 깨졌으면 `bad`(덮어쓰지 않는다).
function readInfo(file) {
  const read = readJson(file);
  if (!read.value) return read;
  const info = read.value;
  const ok = info && typeof info === 'object' && trimmed(info.accessToken) && trimmed(info.refreshToken)
    && Number.isFinite(info.expiresAt);
  return ok ? { info } : { bad: true };
}

function readState(file) {
  const value = readJson(file).value;
  return value && typeof value === 'object' ? value : {};
}

// 임시 파일에 다 쓰고(디스크까지) 이름 바꾸기로 교체한다 — 쓰다 죽어도 원래 파일은 온전하고 반쪽 파일이 남지 않는다.
function writeSecret(file, content, fsx = fs) {
  fsx.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let fd = null;
  try {
    fd = fsx.openSync(temp, 'wx', 0o600);
    fsx.writeSync(fd, content);
    fsx.fsyncSync(fd);
    fsx.closeSync(fd);
    fd = null;
    fsx.renameSync(temp, file);
  } finally {
    if (fd !== null) { try { fsx.closeSync(fd); } catch { /* 이미 닫힘 */ } }
    try { fsx.unlinkSync(temp); } catch { /* 이름을 바꿨으면 없다 */ }
  }
}

function writeState(paths, state, fsx) {
  try {
    if (state) writeSecret(paths.stateFile, `${JSON.stringify(state)}\n`, fsx);
    else fs.rmSync(paths.stateFile, { force: true });
  } catch { /* 상태 기록은 못 써도 갱신 결과에는 영향이 없다 */ }
}

// ---- 잠금 -------------------------------------------------------------------------------------------

function pidAlive(pid) {
  // 0 신호는 아무것도 보내지 않고 "있는가"만 묻는다. EPERM은 있지만 남의 것이라는 뜻이다.
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function readLock(lockDir) {
  let raw = null;
  try { raw = fs.readFileSync(path.join(lockDir, 'pid'), 'utf8'); } catch { raw = null; }
  const pid = Number.parseInt(String(raw || '').split('\n')[0], 10);
  return { raw, pid: Number.isInteger(pid) && pid > 0 ? pid : 0 };
}

// 잠금 = 폴더. pid를 먼저 적은 폴더를 만들어 놓고 이름 바꾸기로 자리에 놓는다 — 자리에 이미 (pid가 든) 폴더가 있으면
// 이름 바꾸기가 실패하므로 한쪽만 잡고, "pid 없는 잠금"이 생기는 틈이 없다.
function tryLock(lockDir, owner) {
  const temp = `${lockDir}.${process.pid}.${randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  fs.mkdirSync(temp, { mode: 0o700 });
  try {
    fs.writeFileSync(path.join(temp, 'pid'), `${process.pid}\n${owner}\n`, { mode: 0o600 });
    fs.renameSync(temp, lockDir);
    return true;
  } catch (error) {
    remove(temp);
    if (['ENOTEMPTY', 'EEXIST', 'ENOTDIR', 'EPERM', 'EACCES'].includes(error.code)) return false;
    throw error;
  }
}

// 남아 있는 잠금의 pid가 죽었으면 거둔다. 거둘 때도 옆으로 옮긴 뒤 "내가 본 그 잠금"이 맞는지 확인하고 지운다 —
// 둘이 동시에 거두다 한쪽이 새로 잡은 잠금을 지우지 않게.
// 돌려주는 값: true(거뒀다 — 바로 다시 잡아 본다) · false(주인이 살아 있다 — 기다린다) · ABORT(남의 잠금을 옮겼다가
// 되돌리지 못했다 — 그 폴더는 지우지 않고 그대로 두고 이번 회차는 잠금 실패로 끝낸다).
function reapDeadLock(lockDir, staleMs = LOCK_STALE_MS) {
  const seen = readLock(lockDir);
  let age = 0;
  try { age = Date.now() - fs.statSync(lockDir).mtimeMs; } catch { age = 0; }
  // pid를 읽을 수 없는 잠금(남이 막 만들었거나 반쯤 지워진 폴더)도 나이 기준을 같이 탄다 — 갓 생긴 것은 기다린다.
  if ((!seen.pid || pidAlive(seen.pid)) && age <= staleMs) return false;
  const tomb = `${lockDir}.${process.pid}.${randomUUID()}.dead`;
  try { fs.renameSync(lockDir, tomb); } catch { return true; }
  if (readLock(tomb).raw !== seen.raw) {
    try { fs.renameSync(tomb, lockDir); } catch { return ABORT; }
    return false;
  }
  remove(tomb);
  return true;
}

// 잠금 정리는 못 해도 던지지 않는다(남은 폴더는 다음 호출이 죽은 잠금으로 거둔다).
function remove(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 그대로 둔다 */ }
}

function unlock(lockDir, owner) {
  if (String(readLock(lockDir).raw || '').split('\n')[1] !== owner) return;
  remove(lockDir);
}

// 잠그고 `work`를 돌린다. 몇 번 기다려도 못 잡으면 BUSY — 부르는 쪽이 이전 토큰으로 넘어간다.
async function withLock(paths, { lockTries = LOCK_TRIES, lockWaitMs = LOCK_WAIT_MS, lockStaleMs = LOCK_STALE_MS, sleep = defaultSleep } = {}, work) {
  const owner = randomUUID();
  for (let attempt = 0; attempt < lockTries; attempt += 1) {
    let held = false;
    try { held = tryLock(paths.lockDir, owner); } catch { return BUSY; }
    if (held) {
      try { return await work(); } finally { unlock(paths.lockDir, owner); }
    }
    const reaped = reapDeadLock(paths.lockDir, lockStaleMs);
    if (reaped === ABORT) return BUSY;
    if (reaped) continue;
    if (attempt < lockTries - 1) await sleep(lockWaitMs);
  }
  return BUSY;
}

// ---- 갱신 요청 --------------------------------------------------------------------------------------

// 슬랙 응답에서 사용자 토큰 자리를 고른다 — 처음 교환은 `authed_user` 안에, 갱신 응답은 맨 위에 올 수 있어 둘 다 받는다.
function parseTokens(body) {
  const user = body && typeof body.authed_user === 'object' && body.authed_user ? body.authed_user : {};
  const source = trimmed(user.access_token) ? user : body;
  const expiresIn = Number(source.expires_in);
  return {
    accessToken: trimmed(source.access_token),
    refreshToken: trimmed(source.refresh_token),
    expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 0,
    scopes: splitScopes(source.scope),
    userId: trimmed(user.id),
  };
}

async function requestRefresh({ request, refreshToken, clientId }) {
  let response;
  try {
    response = await request(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    // 오류 글은 싣지 않는다(요청 본문 조각이 섞일 수 있다).
    return { failure: fail('retry', 'network') };
  }
  const status = Number(response && response.status) || 0;
  if (status >= 500 || status === 429) return { failure: fail('retry', 'http') };
  let body;
  try { body = await response.json(); } catch { return { failure: fail('retry', 'bad_response') }; }
  if (!body || body.ok !== true) {
    const code = safeCode(body && body.error);
    return { failure: fail(RECONNECT_ERRORS.has(code) ? 'reconnect' : 'retry', 'slack_error', code) };
  }
  const tokens = parseTokens(body);
  if (!tokens.accessToken || !tokens.expiresIn) return { failure: fail('retry', 'bad_response') };
  return { tokens };
}

// ---- 지금 쓸 토큰 -----------------------------------------------------------------------------------

function answer(auth, token, more = {}) {
  return { auth, token, refreshed: false, expiresAt: null, failure: null, retryAfterMs: null, ...more };
}

// 한 줄 토큰 파일의 사본이 갱신 정보와 어긋나 있으면(지난 사본 쓰기가 실패했을 때) 잠그고 다시 맞춘다.
async function healCopy(paths, options) {
  await withLock(paths, options, () => {
    const now = readInfo(paths.oauthFile).info;
    if (!now || readLine(paths.tokenFile) === now.accessToken) return;
    try { writeSecret(paths.tokenFile, `${now.accessToken}\n`, options.fs); } catch { /* 다음에 다시 */ }
  });
}

// 돌려주는 값: `{ auth, token, refreshed, expiresAt, failure, retryAfterMs }` — 던지지 않는다.
//   failure: null | { kind: 'retry' | 'reconnect', reason, code? } — `token`은 실패해도 가진 것(이전 토큰)을 준다.
//   retryAfterMs: `retry`일 때 다음 시도까지 기다릴 시간(1 → 5 → 15분).
// 옵션: config(읽은 설정 객체) · tokenDir · now(수 또는 함수) · request(fetch 모양) · minValidMs · force ·
//   staleToken(방금 슬랙이 거절한 토큰 — force일 때 파일의 토큰이 이미 다르면 갱신하지 않는다) · lockTries · lockWaitMs ·
//   lockStaleMs · sleep · fs(비밀 파일 쓰기에 쓸 fs — 시험에서 쓰기 실패를 만들 때만).
//   갱신은 됐는데 한 줄 토큰 파일 사본만 못 썼으면 `copyFailed: true`가 붙는다(실패가 아니다 — 다음 호출이 사본을 맞춘다).
async function getSlackToken(options = {}) {
  const { config, minValidMs = DEFAULT_MIN_VALID_MS, force = false, staleToken } = options;
  const request = options.request || ((...args) => fetch(...args));
  const clock = clockOf(options.now);
  const paths = authPaths(options);

  if (authMode(config) !== 'oauth') {
    return answer('token', readLine(paths.tokenFile) || readLine(paths.tokenFallback));
  }

  const before = readInfo(paths.oauthFile);
  if (!before.info) {
    return answer('oauth', readLine(paths.tokenFile), { failure: fail('reconnect', before.bad ? 'bad_oauth_file' : 'no_oauth_file') });
  }
  const forced = info => force && (staleToken === undefined || info.accessToken === staleToken);
  const expiring = info => info.expiresAt - clock() < minValidMs;
  const current = (info, more) => answer('oauth', info.accessToken, { expiresAt: info.expiresAt, ...more });

  if (!forced(before.info) && !expiring(before.info)) {
    if (readLine(paths.tokenFile) !== before.info.accessToken) await healCopy(paths, options);
    return current(before.info);
  }

  // `다시 연결`이 필요하다고 이미 판정된 갱신 토큰으로는 다시 묻지 않는다(새로 연결하면 상태가 지워진다).
  const stuck = (info, state) => (state.failure && state.failure.kind === 'reconnect' && state.savedAt === info.savedAt
    ? current(info, { failure: fail('reconnect', safeCode(state.failure.reason), safeCode(state.failure.code)) }) : null);
  const known = readState(paths.stateFile);
  if (stuck(before.info, known)) return stuck(before.info, known);

  const failed = (info, failure, more) => {
    // `info`는 파일에 있는 갱신 정보다(상태가 어느 갱신 정보의 것인지 `savedAt`으로 맞춘다). 횟수는 같은 갱신 정보일 때만 잇는다.
    const prior = readState(paths.stateFile);
    const count = failure.kind !== 'retry' ? 0 : (prior.savedAt === info.savedAt ? Number(prior.failCount) || 0 : 0) + 1;
    writeState(paths, { failure, at: clock(), failCount: count, savedAt: info.savedAt }, options.fs);
    return current(info, { failure, retryAfterMs: failure.kind === 'retry' ? retryDelayMs(count) : null, ...more });
  };

  const done = await withLock(paths, options, async () => {
    const after = readInfo(paths.oauthFile);
    if (!after.info) return answer('oauth', before.info.accessToken, { failure: fail('reconnect', after.bad ? 'bad_oauth_file' : 'no_oauth_file') });
    const info = after.info;
    // 기다리는 사이 다른 쪽이 갱신했으면 그 토큰을 쓴다 — 같은 갱신 토큰을 두 번 쓰지 않는다.
    const changed = info.accessToken !== before.info.accessToken;
    if (changed ? !expiring(info) : !forced(info) && !expiring(info)) return current(info);
    // 상태도 다시 읽는다 — 기다리는 사이 다른 호출이 `다시 연결`을 판정했거나 방금 실패를 적었으면 같은 요청을 또 보내지 않는다.
    const state = readState(paths.stateFile);
    if (stuck(info, state)) return stuck(info, state);
    if (state.failure && state.savedAt === info.savedAt && (state.at !== known.at || state.failCount !== known.failCount)) {
      return current(info, {
        failure: fail('retry', safeCode(state.failure.reason), safeCode(state.failure.code)),
        retryAfterMs: retryDelayMs(Number(state.failCount) || 1),
      });
    }

    const clientId = trimmed(info.clientId) || slackClientId(config);
    if (!clientId) return failed(info, fail('retry', 'no_client_id'));
    const outcome = await requestRefresh({ request, refreshToken: info.refreshToken, clientId });
    if (outcome.failure) return failed(info, outcome.failure);

    const at = clock();
    const next = {
      ...info,
      accessToken: outcome.tokens.accessToken,
      // 갱신 토큰은 쓸 때마다 바뀐다 — 응답의 새 값을 반드시 저장한다.
      refreshToken: outcome.tokens.refreshToken || info.refreshToken,
      expiresAt: at + outcome.tokens.expiresIn * 1000,
      scopes: outcome.tokens.scopes.length ? outcome.tokens.scopes : info.scopes,
      refreshedAt: at,
      savedAt: at,
    };
    const text = `${JSON.stringify(next, null, 2)}\n`;
    try {
      try { writeSecret(paths.oauthFile, text, options.fs); } catch { writeSecret(paths.oauthFile, text, options.fs); }
    } catch {
      // 새 토큰은 받았는데 저장을 못 했다 — 이번에는 새 토큰으로 돌지만, 옛 갱신 토큰은 이미 쓴 것이라 다음 갱신은 `다시 연결`이 된다.
      return failed(info, fail('retry', 'write'), { refreshed: true, token: next.accessToken, expiresAt: next.expiresAt });
    }
    let copyFailed = false;
    try { writeSecret(paths.tokenFile, `${next.accessToken}\n`, options.fs); } catch { copyFailed = true; }
    writeState(paths, null);
    return current(next, { refreshed: true, ...(copyFailed ? { copyFailed: true } : {}) });
  });

  if (done !== BUSY) return done;
  // 잠금을 못 잡았다 — 그 사이 다른 쪽이 갱신을 끝냈으면 그 토큰을, 아니면 이전 토큰을 준다(상태에는 적지 않는다: 고장이 아니다).
  const latest = readInfo(paths.oauthFile).info || before.info;
  if (latest.accessToken !== before.info.accessToken && !expiring(latest)) return current(latest);
  return current(latest, { failure: fail('retry', 'lock'), retryAfterMs: retryDelayMs(1) });
}

// ---- 처음 연결 · 상태 -------------------------------------------------------------------------------

// code를 토큰으로 바꾼 슬랙 응답(`oauth.v2.access`)을 받아 저장한다. 돌려주는 값에 토큰은 없다.
//   `{ ok: true, teamId, teamName, userId, scopes, missingScopes, expiresAt, legacyKept }`
//   `{ ok: false, reason: 'bad_response' | 'team_mismatch' | 'lock' | 'write', code? }` — 실패하면 아무것도 바꾸지 않는다.
// config의 `slack.auth`는 여기서 쓰지 않는다(config를 고치는 곳은 integrations.js 하나다).
async function saveOAuthResult(options = {}) {
  const { response, config, expectedTeamId, clientId } = options;
  const clock = clockOf(options.now);
  const paths = authPaths(options);
  if (!response || response.ok !== true) return { ok: false, reason: 'bad_response', ...(safeCode(response && response.error) ? { code: safeCode(response.error) } : {}) };
  const tokens = parseTokens(response);
  // 회전 토큰이 아니면(갱신 토큰·만료가 없으면) 이 방식으로 둘 수 없다.
  if (!tokens.accessToken || !tokens.refreshToken || !tokens.expiresIn) return { ok: false, reason: 'bad_response' };
  const team = response.team && typeof response.team === 'object' ? response.team : {};
  const teamId = trimmed(team.id);
  if (trimmed(expectedTeamId) && teamId !== trimmed(expectedTeamId)) return { ok: false, reason: 'team_mismatch' };

  const done = await withLock(paths, options, () => {
    const at = clock();
    const prior = readInfo(paths.oauthFile).info;
    // 옛 방식에서 처음 옮길 때만 옛 토큰을 `.legacy`로 남긴다(지우는 것은 앱이 7일 뒤에 — 여기서는 지우지 않는다).
    const old = readLine(paths.tokenFile);
    const keepLegacy = !prior && !!old && old !== tokens.accessToken && !fs.existsSync(paths.legacyFile);
    try {
      const info = {
        // 파일 모양의 판 번호 — 지금은 읽는 곳이 없다(모양을 바꿀 때 옛 파일을 가려내려고 적어 둔다).
        version: 1,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: at + tokens.expiresIn * 1000,
        teamId, teamName: trimmed(team.name), userId: tokens.userId,
        scopes: tokens.scopes,
        clientId: trimmed(clientId) || slackClientId(config),
        connectedAt: at, refreshedAt: null, savedAt: at,
        legacyKeptAt: keepLegacy ? at : (prior && prior.legacyKeptAt) || null,
      };
      writeSecret(paths.oauthFile, `${JSON.stringify(info, null, 2)}\n`, options.fs);
      // `.legacy`는 갱신 정보 저장이 성공한 뒤, 사본이 옛 토큰을 덮기 전에 만든다 — 저장이 실패하면 아무것도 남기지 않는다.
      if (keepLegacy) { try { writeSecret(paths.legacyFile, `${old}\n`, options.fs); } catch { /* 연결은 그대로 둔다 */ } }
      let copyFailed = false;
      try { writeSecret(paths.tokenFile, `${info.accessToken}\n`, options.fs); } catch { copyFailed = true; }
      writeState(paths, null);
      return {
        ok: true, teamId, teamName: info.teamName, userId: info.userId, scopes: info.scopes,
        missingScopes: missingScopes(info.scopes), expiresAt: info.expiresAt, legacyKept: fs.existsSync(paths.legacyFile),
        ...(copyFailed ? { copyFailed: true } : {}),
      };
    } catch {
      return { ok: false, reason: 'write' };
    }
  });
  return done === BUSY ? { ok: false, reason: 'lock' } : done;
}

// 새 방식을 그만둘 때(사람이 토큰을 직접 붙여 넣어 저장) — 갱신 정보와 실패 기록을 지운다. 둘이 같이 있으면 다음 갱신이
// 붙여 넣은 토큰을 덮는다. 갱신과 같은 잠금 안에서 지우고, `then`(붙여 넣은 토큰 쓰기)도 그 안에서 돌린다 —
// 진행 중이던 갱신이 뒤늦게 사본을 덮지 못하게. 잠금을 못 잡았거나 `then`이 던지면 false(아무것도 지우지 않았다).
// `.legacy`는 건드리지 않는다.
async function forgetOAuth(options = {}) {
  const paths = authPaths(options);
  const done = await withLock(paths, options, () => {
    try {
      if (typeof options.then === 'function') options.then();
      fs.rmSync(paths.oauthFile, { force: true });
      fs.rmSync(paths.stateFile, { force: true });
      return true;
    } catch {
      return false;
    }
  });
  return done === true;
}

// 방금 한 처음 연결을 되돌린다 — 토큰은 저장됐는데 설정에 방식(`slack.auth`)을 적지 못했을 때. 설정은 옛 방식인데 한 줄 파일에
// 12시간짜리 토큰만 남으면 갱신할 곳이 없어 수집이 멈춘다. 갱신과 같은 잠금 안에서: `.legacy`(옛 토큰)가 있으면 한 줄 파일로
// 되돌리고 `.legacy`를 지우고, 없으면(원래 토큰이 없던 설치) 한 줄 파일을 지운다. 그 뒤 갱신 정보·실패 기록을 지운다.
async function undoOAuth(options = {}) {
  const paths = authPaths(options);
  return forgetOAuth({
    ...options,
    then: () => {
      const old = readLine(paths.legacyFile);
      if (old) writeSecret(paths.tokenFile, `${old}\n`, options.fs);
      else fs.rmSync(paths.tokenFile, { force: true });
      fs.rmSync(paths.legacyFile, { force: true });
    },
  });
}

// 화면·점검하기가 읽는 상태 — 값 없이 시각·권한·실패 종류만. 파일을 쓰지 않는다.
// `minValidMs`는 부르는 쪽의 갱신 기준(서버 60분)이다 — `nextRefreshAt`이 그 기준으로 나온다.
function readOAuthStatus(options = {}) {
  const { config, minValidMs = DEFAULT_MIN_VALID_MS } = options;
  const clock = clockOf(options.now);
  const paths = authPaths(options);
  if (authMode(config) !== 'oauth') {
    return { auth: 'token', connected: !!(readLine(paths.tokenFile) || readLine(paths.tokenFallback)) };
  }
  const base = {
    auth: 'oauth', connected: false, expiresAt: null, expiresInMs: null, nextRefreshAt: null,
    scopes: [], missingScopes: [], teamId: '', teamName: '', userId: '', connectedAt: null, refreshedAt: null,
    lastFailure: null, failCount: 0, retryAfterMs: null, nextRetryAt: null,
    legacyKept: fs.existsSync(paths.legacyFile), legacyKeptAt: null,
  };
  const read = readInfo(paths.oauthFile);
  if (!read.info) return { ...base, lastFailure: { ...fail('reconnect', read.bad ? 'bad_oauth_file' : 'no_oauth_file'), at: null } };
  const info = read.info;
  const scopes = splitScopes(info.scopes);
  const state = readState(paths.stateFile);
  const stale = !state.failure || state.savedAt !== info.savedAt;
  const kind = !stale && state.failure.kind === 'reconnect' ? 'reconnect' : 'retry';
  const at = Number.isFinite(state.at) ? state.at : null;
  const failCount = stale ? 0 : Number(state.failCount) || 0;
  const retryAfterMs = !stale && kind === 'retry' ? retryDelayMs(failCount) : null;
  return {
    ...base,
    connected: stale || kind !== 'reconnect',
    expiresAt: info.expiresAt,
    expiresInMs: info.expiresAt - clock(),
    nextRefreshAt: info.expiresAt - minValidMs,
    scopes, missingScopes: missingScopes(scopes),
    teamId: trimmed(info.teamId), teamName: trimmed(info.teamName), userId: trimmed(info.userId),
    connectedAt: info.connectedAt || null, refreshedAt: info.refreshedAt || null,
    lastFailure: stale ? null : { ...fail(kind, safeCode(state.failure.reason), safeCode(state.failure.code)), at },
    failCount, retryAfterMs,
    nextRetryAt: retryAfterMs !== null && at !== null ? at + retryAfterMs : null,
    legacyKeptAt: info.legacyKeptAt || null,
  };
}

// ---- 옛 토큰 보관분(`.legacy`) 치우기 · 서버 타이머 -------------------------------------------------

// 옮길 때 남긴 옛 토큰 파일을 7일 뒤 지운다. 지웠으면 true. 갱신과 같은 잠금 안에서 다시 읽고 지운다.
//   - 새 방식: 연결이 살아 있고(다시 연결 필요가 아님), 마지막으로 연결한 때(처음 옮긴 때 또는 그 뒤 `다시 연결`)부터 7일이
//     지났을 때만. 풀려 있는 동안에는 지우지 않는다 — 다시 연결하면 그때부터 다시 7일을 센다.
//   - 옛 방식(토큰을 붙여 넣어 돌아감): 갱신 정보가 없으면 주인 없는 파일이다 — 만든 지 7일이 지났으면 지운다.
//     갱신 정보가 남아 있으면(설정만 바뀐 어중간한 상태) 건드리지 않는다.
async function cleanLegacy(options = {}) {
  const { config, keepMs = LEGACY_KEEP_MS } = options;
  const clock = clockOf(options.now);
  const paths = authPaths(options);
  if (!fs.existsSync(paths.legacyFile)) return false;
  const done = await withLock(paths, options, () => {
    let since = 0;
    if (authMode(config) === 'oauth') {
      const status = readOAuthStatus(options);
      if (!status.connected) return false;
      since = Math.max(Number(status.connectedAt) || 0, Number(status.legacyKeptAt) || 0);
    } else {
      if (!readInfo(paths.oauthFile).missing) return false;
      try { since = fs.statSync(paths.legacyFile).mtimeMs; } catch { return false; }
    }
    if (!since || clock() - since < keepMs) return false;
    try { fs.rmSync(paths.legacyFile, { force: true }); return true; } catch { return false; }
  });
  return done === true;
}

// 서버가 쓰는 타이머 — 프로세스를 띄우지 않고 이 프로세스 안에서만 돈다. 한 번 돌 때(tick):
//   새 방식이면 `getSlackToken({ minValidMs: 60분 })` — 만료가 멀면 파일만 읽고 끝난다.
//     · 잠시 안 됨(retry)이면 모듈이 준 `retryAfterMs`(1 → 5 → 15분) 뒤에 다시.
//     · 다시 연결 필요(reconnect)면 갱신 요청을 멈춘다 — 그 뒤의 tick은 파일만 읽고(모듈이 같은 갱신 토큰으로 다시 묻지 않는다),
//       사람이 `다시 연결`을 하면 다음 tick부터 저절로 이어진다.
//   그리고 방식과 상관없이 `.legacy` 치우기(cleanLegacy)를 한 번 본다.
// `readConfig`는 지금 설정을 새로 읽는 함수. 타이머·시계·요청은 시험에서 끼운다. 돌려주는 상태(`last()`)에 토큰은 없다.
function createSlackRefresher({
  readConfig, request, tokenDir, now = Date.now, intervalMs = REFRESH_TICK_MS, firstDelayMs = 1000,
  setTimer = setTimeout, clearTimer = clearTimeout, getToken = getSlackToken, clean = cleanLegacy,
} = {}) {
  let timer = null;
  let running = null;
  let on = false;
  let last = null;

  function plan(ms) {
    if (!on) return;
    timer = setTimer(() => { timer = null; tick(); }, ms);
    // 이 타이머 때문에 프로세스가 살아 있지 않게 한다.
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  async function once() {
    let wait = intervalMs;
    let state = { kind: 'token', refreshed: false, legacyRemoved: false, at: now() };
    try {
      const config = readConfig() || {};
      if (authMode(config) === 'oauth') {
        const got = await getToken({ config, tokenDir, request, now, minValidMs: REFRESH_AHEAD_MS });
        state = { ...state, kind: got.failure ? got.failure.kind : 'ok', refreshed: got.refreshed === true };
        if (got.failure && got.failure.kind === 'retry' && Number.isFinite(got.retryAfterMs)) wait = Math.min(intervalMs, got.retryAfterMs);
      }
      state.legacyRemoved = await clean({ config, tokenDir, now });
    } catch {
      state = { ...state, kind: 'error' };
    }
    last = { ...state, nextInMs: wait };
    return last;
  }

  // 겹쳐 돌지 않는다 — 도는 중에 또 부르면 같은 약속을 돌려준다.
  function tick() {
    if (running) return running;
    if (timer) { clearTimer(timer); timer = null; }
    running = once().then((state) => { running = null; plan(state.nextInMs); return state; });
    return running;
  }

  return {
    start() { if (on) return; on = true; plan(firstDelayMs); },
    stop() { on = false; if (timer) { clearTimer(timer); timer = null; } },
    tick,
    last: () => (last ? { ...last } : null),
    running: () => on,
  };
}

module.exports = {
  getSlackToken, saveOAuthResult, readOAuthStatus, forgetOAuth, undoOAuth, cleanLegacy, createSlackRefresher,
  authPaths, authMode, slackClientId, retryDelayMs,
  DEFAULT_CLIENT_ID, REQUIRED_SCOPES, RETRY_DELAYS_MS, REFRESH_TICK_MS, REFRESH_AHEAD_MS, LEGACY_KEEP_MS,
};

// 슬랙 `허용` 한 번으로 연결하는 길(OAuth + PKCE)의 서버 쪽 부품 — 경로는 routes-integrations.js가 건다.
//
//   start  → state(1회용)와 code_verifier를 **이 프로세스의 메모리에만** 만들고 슬랙 허용 화면 주소를 돌려준다.
//   take   → 콜백이 들고 온 state를 한 번만 꺼낸다(틀림·이미 씀·만료는 null).
//   exchange → code를 토큰 응답으로 바꾼다(Client Secret 없음 — code_verifier로 증명한다).
//   page   → 콜백이 보여 주는 작은 정적 페이지(스크립트·외부 자원 없음, 정해진 문구만 — 쿼리 값을 되비추지 않는다).
//
// 규칙: 토큰·code·code_verifier는 돌려주는 상태·페이지·오류 어디에도 싣지 않는다(실패는 정해진 낱말뿐).
// 토큰을 파일에 쓰는 일은 slack-auth.js(saveOAuthResult)가, 설정을 쓰는 일은 integrations.js가 한다.

const { createHash, randomBytes } = require('node:crypto');
const { REQUIRED_SCOPES } = require('./slack-auth');

const AUTHORIZE_URL = 'https://slack.com/oauth/v2/authorize';
const TOKEN_URL = 'https://slack.com/api/oauth.v2.access';
const STATE_TTL_MS = 10 * 60 * 1000;
const STATE_MAX = 3;
const REQUEST_TIMEOUT_MS = 8000;
// 슬랙 앱에 등록해 둔 돌아올 주소가 `http://localhost:4321`~`4331`뿐이다 — 그 밖의 포트는 슬랙이 거절한다.
const PORT_MIN = 4321;
const PORT_MAX = 4331;
const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
// 회사 슬랙이 이 앱을 막았을 때 슬랙이 주는 오류 이름(그 밖의 모르는 오류는 `failed`).
const BLOCKED_ERRORS = new Set(['invalid_team_for_non_distributed_app', 'team_access_not_granted', 'org_login_required', 'ekm_access_denied']);

const base64url = buffer => buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const safeCode = value => (typeof value === 'string' && /^[a-z0-9_]{1,60}$/.test(value) ? value : '');
const portAllowed = port => Number.isInteger(port) && port >= PORT_MIN && port <= PORT_MAX;
const redirectUri = port => `http://localhost:${port}/slack/callback`;

// 이 요청이 앱을 설치한 맥의 브라우저에서 왔는가 — 소켓 주소와 Host 둘 다 본다(Tailscale 주소로 온 요청은 아니다).
function isLocalRequest(req) {
  const hostname = String((req.headers || {}).host || '').replace(/:\d+$/, '');
  return LOOPBACK.includes((req.socket || {}).remoteAddress) && ['localhost', '127.0.0.1'].includes(hostname);
}

// 버튼을 그릴 수 있는가 — `ok` · `remote`(다른 기기) · `port`(등록된 포트 밖) · `client`(Client ID 없음).
function readiness({ local, port, clientId }) {
  if (!local) return 'remote';
  if (!portAllowed(port)) return 'port';
  if (!clientId) return 'client';
  return 'ok';
}

// 슬랙 오류 이름 → 화면이 문구를 고르는 종류.
function failureKind(code) {
  const name = safeCode(code);
  if (name === 'access_denied') return 'cancelled';
  if (BLOCKED_ERRORS.has(name)) return 'blocked';
  return 'failed';
}

function authorizeUrl({ clientId, port, state, challenge }) {
  const query = new URLSearchParams({
    client_id: clientId,
    user_scope: REQUIRED_SCOPES.join(','),
    redirect_uri: redirectUri(port),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `${AUTHORIZE_URL}?${query}`;
}

// 기다리는 연결 보관함. 값은 전부 메모리에만 있고, 서버가 다시 뜨면 사라진다(그때는 버튼을 다시 누르면 된다).
function createSlackOAuth({ now = Date.now, random = randomBytes } = {}) {
  const pending = new Map();   // state → { verifier, clientId, port, expectedTeamId, expiresAt }
  let last = null;             // 마지막 결과 `{ ok, kind, at }` — 값 없음

  // 만료된 것을 치운다. 기다리던 것이 전부 시간이 지나 사라졌으면 "아직 허용이 끝나지 않았어요"(pending)로 적는다.
  function prune() {
    // 지난 결과는 10분 뒤 잊는다 — 며칠 전의 `취소했어요`가 풀린 카드에 다시 뜨지 않게.
    if (last && now() - last.at >= STATE_TTL_MS) last = null;
    const before = pending.size;
    for (const [state, entry] of pending) if (entry.expiresAt <= now()) pending.delete(state);
    if (before && !pending.size && !last) last = { ok: false, kind: 'pending', at: now() };
  }

  function start({ clientId, port, expectedTeamId = '' }) {
    prune();
    // 넘치면 가장 오래된 것부터 버린다(Map은 넣은 차례를 지킨다).
    while (pending.size >= STATE_MAX) pending.delete(pending.keys().next().value);
    const state = base64url(random(24));
    const verifier = base64url(random(48));
    const challenge = base64url(createHash('sha256').update(verifier).digest());
    const expiresAt = now() + STATE_TTL_MS;
    pending.set(state, { verifier, clientId, port, expectedTeamId, expiresAt });
    last = null;
    return { url: authorizeUrl({ clientId, port, state, challenge }), expiresAt };
  }

  // 한 번만 꺼낸다 — 꺼낸 state는 다시 쓸 수 없다.
  function take(state) {
    prune();
    const key = typeof state === 'string' ? state : '';
    const entry = pending.get(key);
    if (!entry) return null;
    pending.delete(key);
    return entry;
  }

  // 결과를 적는다. 연결됐으면 남은 기다림(버튼을 여러 번 눌러 생긴 것)도 같이 끝낸다.
  function finish(ok, kind = '') {
    if (ok) pending.clear();
    last = { ok: !!ok, kind: ok ? 'connected' : (kind || 'failed'), at: now() };
    return last;
  }

  function cancel() {
    pending.clear();
    last = null;
  }

  function status() {
    prune();
    const expiresAt = pending.size ? Math.max(...[...pending.values()].map(entry => entry.expiresAt)) : null;
    return { waiting: pending.size > 0, expiresAt, last: last ? { ...last } : null };
  }

  return { start, take, finish, cancel, status };
}

// code → 슬랙 응답(JSON 객체). 던지지 않는다 — 닿지 못했거나 응답이 깨졌으면 `{ ok: false, error: 'unreachable' }`.
// 돌려준 값에는 토큰이 들어 있다 — 부르는 쪽은 saveOAuthResult에 넘기기만 하고 어디에도 싣지 않는다.
async function exchangeCode({ code, verifier, clientId, port, request = (...args) => fetch(...args) }) {
  try {
    const response = await request(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri(port) }).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = await response.json();
    return body && typeof body === 'object' ? body : { ok: false, error: 'unreachable' };
  } catch {
    return { ok: false, error: 'unreachable' };
  }
}

// 콜백 탭에 보여 주는 문구 — 종류로만 고른다(쿼리에서 온 글자는 한 자도 넣지 않는다).
const PAGE_TEXT = {
  connected: ['✓ 연결됐어요', '이 탭은 닫아도 돼요.'],
  cancelled: ['취소했어요', '앱으로 돌아가 다시 누르면 돼요. 이 탭은 닫아도 돼요.'],
  blocked: ['회사 슬랙이 이 앱을 막았어요', '관리자에게 물어봐 주세요. 이 탭은 닫아도 돼요.'],
  team: ['다른 슬랙 워크스페이스예요', '연결해 둔 워크스페이스로 다시 허용해 주세요. 이 탭은 닫아도 돼요.'],
  write: ['연결을 저장하지 못했어요', '앱으로 돌아가 다시 눌러 주세요. 이 탭은 닫아도 돼요.'],
  state: ['이 주소는 더 쓸 수 없어요', '앱으로 돌아가 슬랙 연결을 다시 눌러 주세요.'],
  remote: ['슬랙 연결은 앱을 설치한 맥에서 해 주세요.', ''],
  failed: ['연결하지 못했어요', '앱으로 돌아가 다시 눌러 주세요. 이 탭은 닫아도 돼요.'],
};

function page(kind) {
  const [title, note] = PAGE_TEXT[kind] || PAGE_TEXT.failed;
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>슬랙 연결</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f2f4f6;color:#191f28;font:16px/1.6 -apple-system,"Apple SD Gothic Neo","Malgun Gothic",sans-serif}
main{padding:34px 24px;text-align:center}b{display:block;font-size:20px;margin-bottom:6px}
@media (prefers-color-scheme:dark){body{background:#15181e;color:#eaedf1}}
</style></head><body><main><b>${title}</b>${note}</main></body></html>`;
}

// 페이지에 붙이는 머리 — 스크립트·외부 자원을 아예 못 쓰게 하고, 주소(코드가 든 쿼리)가 밖으로 새지 않게 한다.
const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

module.exports = {
  createSlackOAuth, exchangeCode, authorizeUrl, redirectUri, readiness, isLocalRequest, portAllowed, failureKind, page,
  PAGE_HEADERS, PAGE_TEXT, STATE_TTL_MS, STATE_MAX, PORT_MIN, PORT_MAX, AUTHORIZE_URL, TOKEN_URL,
};

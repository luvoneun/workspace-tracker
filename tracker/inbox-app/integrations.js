// 연동 설정(설정 > 연동)이 쓰는 서버 쪽 한 벌 — 값 확인, `workspace.config.json` 합치기,
// 토큰 파일 쓰기, 문제 보고에 실을 오류 줄 고르기.
//
// 여기만 `workspace.config.json`을 고친다(DECISIONS 2026-09-23 — 설정 › 꾸미기의 이름 저장도 이 파일의
// savePersonalize로 한다). 규칙 셋:
//   1) **아는 키만** 바꾸고 모르는 키는 그대로 둔다 — 사람이 손으로 적어 둔 값이 사라지지 않게.
//   2) **토큰은 config에 적지 않는다** — 파일(0600)로만 두고 config에는 경로만 적는다.
//   3) 토큰 값은 돌려주는 값·로그·오류 문구 어디에도 싣지 않는다(있음/없음만).
//
// 프로세스를 끝내는 길(`scheduleRestart`)도 여기 있다 — 부르는 쪽이 `exit`를 끼워 넣으므로
// 테스트에서는 실제 종료가 일어나지 않는다.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomicWrite } = require('./safe-storage');
const { parseCalendar, todayEvents } = require('./ical');

const SLACK_CHANNEL_KEYS = ['todo', 'align', 'someday', 'waiting'];
const SLACK_TIMEOUT_MS = 8000;
// 예시 설정(`workspace.config.example.json`)이 채널 칸에 넣어 둔 자리표시자. 사람이 채우지 않은
// 자리라 **채널이 없는 것과 같이 본다** — 남겨 두면 setup.sh가 `채널 ID를 아직 채우지 않았어요`로
// 멈추고, 연동 탭 요약도 있지도 않은 채널을 `외 N개`로 센다.
const PLACEHOLDER_CHANNEL_ID = '여기에_채널ID';
// 토큰을 받으러 갈 자리. 만드는 사람이 config의 `slack.appUrl`에 팀 슬랙 앱 주소
// (`https://api.slack.com/apps/A0XXXX`)를 적어 두면 그 주소로, 없으면 목록 화면으로 보낸다.
const SLACK_APPS_URL = 'https://api.slack.com/apps';
// 슬랙 채널 이름 규칙 — 소문자·숫자·`-`·`_`만 80자까지.
const SLACK_CHANNEL_NAME_RE = /^[a-z0-9_-]{1,80}$/;

const MESSAGE = {
  jiraSite: '지라 주소는 https://로 시작해야 해요',
  jiraEmail: '지라 계정 이메일을 적어 주세요',
  jiraToken: 'API 토큰을 붙여 넣어 주세요',
  jiraAuth: '지라에서 이 토큰으로 로그인하지 못했어요',
  slackToken: '슬랙 토큰을 붙여 넣어 주세요',
  slackChannel: '슬랙 채널 링크나 ID를 붙여 넣어 주세요',
  slackRead: '슬랙에서 이 채널을 읽지 못했어요 — 토큰과 채널을 확인해 주세요',
  slackPublic: '공개 채널이에요 — 나만 보는 채널을 권해요',
  slackName: '채널 이름은 소문자·숫자·-·_만 80자까지 쓸 수 있어요',
  slackAuth: '토큰이 맞지 않아요',
  slackScope: '이 슬랙 앱에는 채널 만들기 권한이 없어요 — 만든 사람에게 권한 추가를 요청해 주세요',
  slackTaken: '이미 있는 이름이에요 — 다른 이름을 적어 주세요',
  slackCreate: '슬랙에서 채널을 만들지 못했어요',
  // 받을 채널은 넷 중 하나 이상이면 된다(할 일도 선택) — 마지막 하나만 뺄 수 없다.
  slackLastOff: '마지막 채널은 뺄 수 없어요 — 슬랙 수집을 끄려면 ⋯ › 해제',
  slackGone: '을 찾을 수 없어요 — 슬랙에서 지웠거나 보관했어요. 체크한 채로 두면 새로 만들어요',
  slackOffline: '슬랙에 연결하지 못했어요 — 잠시 뒤 다시 눌러 주세요',
  slackBot: '이건 Bot 토큰이에요 — 바로 위의 User OAuth Token(xoxp-)을 복사해 주세요',
  slackReach: '슬랙에 닿지 못했어요 — 잠시 뒤 다시 해 주세요',
  icalUrl: '비밀 주소를 붙여 넣어 주세요',
  icalHttps: '주소는 https://로 시작해야 해요',
  icalRead: '이 주소를 읽지 못했어요 — 비밀 주소를 다시 복사해 주세요',
  icalNotCalendar: '캘린더 주소가 아니에요 — iCal 형식의 비공개 주소를 복사해 주세요',
  other: '보낸 값을 확인해 주세요.',
};

function bad(message, code) {
  const error = new Error(message);
  error.status = 400;
  // 화면이 갈래를 나눌 때만 쓰는 짧은 표지(슬랙이 준 오류 이름 중 아는 것만) — 값이나 토큰은 싣지 않는다.
  if (code) error.code = code;
  return error;
}

const trimmed = value => (typeof value === 'string' ? value.trim() : '');
const expandHome = value => String(value || '').replace(/^~(?=\/|$)/, os.homedir());
// 자리표시자는 "빈 칸"으로 읽는다.
const realChannelId = value => (trimmed(value) === PLACEHOLDER_CHANNEL_ID ? '' : trimmed(value));

// 토큰을 둘 자리. 테스트·픽스처는 `WORKSPACE_TOKEN_DIR`로 임시 폴더를 끼워 실제 `~/.config`를
// 건드리지 않는다. 기본 자리일 때만 config에 `~/…` 꼴로 적는다(사람이 읽기 좋게).
// 임시 폴더를 끼웠으면(`custom`) config에 적힌 경로가 어디를 가리키든 **그 폴더 안만** 본다 —
// 픽스처·테스트가 실제 `~/.config`의 토큰에 닿지 않게 하는 울타리다.
function tokenPaths(tokenDir) {
  const custom = trimmed(tokenDir || process.env.WORKSPACE_TOKEN_DIR);
  const dir = custom || path.join(os.homedir(), '.config');
  const shape = name => (custom ? path.join(dir, name) : `~/.config/${name}`);
  return {
    dir, custom: !!custom,
    jira: { file: path.join(dir, 'workspace-jira-token'), config: shape('workspace-jira-token') },
    slack: { file: path.join(dir, 'workspace-slack-token'), config: shape('workspace-slack-token') },
    // 캘린더 비밀 주소(iCal)도 토큰과 같은 급이다 — 파일(0600)로만 두고 config에는 경로만.
    calendar: { file: path.join(dir, 'workspace-calendar-ical'), config: shape('workspace-calendar-ical') },
  };
}

function readToken(file) {
  if (!trimmed(file)) return '';
  try { return String(fs.readFileSync(expandHome(file), 'utf8') || '').trim(); } catch { return ''; }
}

// 토큰을 찾을 자리를 차례대로: config에 적힌 경로(사람이 옮겨 둔 자리) → 기본 자리.
// 임시 폴더를 끼웠으면 그 폴더 안 파일 하나만 본다.
function tokenPlaces(paths, key, configured) {
  if (paths.custom) return [paths[key].file];
  return [...new Set([trimmed(configured), paths[key].file].filter(Boolean))];
}

// 이미 있는 토큰과 "config에 적어 둘 경로"를 함께 돌려준다. 없으면 null.
function findToken(paths, key, configured) {
  for (const place of tokenPlaces(paths, key, configured)) {
    const value = readToken(place);
    if (value) return { value, config: place === paths[key].file ? paths[key].config : place };
  }
  return null;
}

// 토큰 파일은 사람만 읽을 수 있게 둔다(0600). 이미 있던 파일의 권한도 다시 조인다.
function writeTokenFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${value}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

// 슬랙 채널 링크(`https://회사.slack.com/archives/C0123ABCD`)나 순수 ID에서 ID만 뽑는다.
// 스레드 주소(`/archives/C0123/p170…`)도 앞의 채널 ID만 본다.
function parseChannelId(value) {
  const text = trimmed(value);
  if (!text) return null;
  const fromUrl = /archives\/([A-Z][A-Z0-9]{5,})/.exec(text);
  if (fromUrl) return fromUrl[1];
  if (/^[A-Z][A-Z0-9]{5,}$/.test(text)) return text;
  return null;
}

// 슬랙에서 채널 하나를 읽어 본다. 이름과 비공개 여부만 쓰고 메시지는 읽지 않는다.
// 토큰은 헤더로만 나가고 어디에도 남기지 않는다.
async function slackCheckChannel(token, id, request = (...args) => fetch(...args)) {
  let body;
  try {
    const response = await request(`https://slack.com/api/conversations.info?channel=${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });
    body = await response.json();
  } catch {
    // 슬랙에 닿지 못한 것(네트워크·시간 초과)은 채널이 사라진 것과 다르다 — 표지를 따로 둔다.
    throw bad(MESSAGE.slackRead, 'slack_unreachable');
  }
  if (body && (body.error === 'channel_not_found' || body.error === 'is_archived')) throw bad(MESSAGE.slackRead, 'channel_not_found');
  if (!body || body.ok !== true || !body.channel) throw bad(MESSAGE.slackRead);
  // `created`(만든 때, 초)는 새 채널을 "그때부터" 읽게 하는 since에, `archived`는 뺐던 채널을 다시 켤 때 쓴다.
  const created = Number(body.channel.created);
  return {
    name: String(body.channel.name || ''), isPrivate: body.channel.is_private === true,
    created: Number.isFinite(created) && created > 0 ? Math.floor(created) : null,
    archived: body.channel.is_archived === true,
  };
}

// 슬랙에 한 번 물어보는 길 하나. 토큰은 **헤더로만** 나가고 돌려주는 값에는 남지 않는다.
async function slackCall(token, method, payload, request) {
  const options = {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
  };
  if (payload) {
    options.headers['Content-Type'] = 'application/json; charset=utf-8';
    options.body = JSON.stringify(payload);
  }
  const response = await request(`https://slack.com/api/${method}`, options);
  return response.json();
}

// 나만 있는 비공개 채널을 대신 만든다(슬랙 위저드 `② 채널`의 `고른 채널 N개 만들어 주기` — 채널마다 한 번씩).
// 만들기 전에 `auth.test`로 **토큰이 맞는지 먼저** 보고, 맞을 때만 만든다 — 틀린 토큰으로
// 채널부터 만들려 들지 않는다. 설정 파일도 토큰 파일도 여기서는 쓰지 않는다(id만 돌려준다).
async function slackCreateChannel(token, name, request = (...args) => fetch(...args)) {
  const secret = trimmed(token);
  const wanted = trimmed(name).toLowerCase();
  if (!secret) throw bad(MESSAGE.slackToken);
  if (!SLACK_CHANNEL_NAME_RE.test(wanted)) throw bad(MESSAGE.slackName);

  let auth;
  try { auth = await slackCall(secret, 'auth.test', null, request); } catch { throw bad(MESSAGE.slackCreate); }
  if (!auth || auth.ok !== true) throw bad(MESSAGE.slackAuth, 'invalid_auth');

  let body;
  try { body = await slackCall(secret, 'conversations.create', { name: wanted, is_private: true }, request); }
  catch { throw bad(MESSAGE.slackCreate); }
  if (!body || body.ok !== true) {
    const kind = String((body && body.error) || '');
    if (kind === 'missing_scope') throw bad(MESSAGE.slackScope, 'missing_scope');
    if (kind === 'name_taken') throw bad(MESSAGE.slackTaken, 'name_taken');
    if (kind === 'invalid_auth' || kind === 'not_authed') throw bad(MESSAGE.slackAuth, 'invalid_auth');
    throw bad(MESSAGE.slackCreate);
  }
  const channel = body.channel && typeof body.channel === 'object' ? body.channel : {};
  const id = String(channel.id || '');
  if (!id) throw bad(MESSAGE.slackCreate);
  return { id, name: String(channel.name || wanted) };
}

// 새로 만들 채널의 기본 이름 앞머리 — 슬랙 사용자 이름(`auth.test`의 `user`)을 채널 이름 규칙대로 다듬는다
// (소문자·영숫자·`-`·`_`, 띄어쓰기·점은 `-`). 가장 긴 뒷머리(`-someday`)를 붙여도 80자를 넘지 않게 자르고,
// 못 받았거나 다듬고 나니 비면 `my`다. 이미 연결된 채널의 이름은 바꾸지 않는다 — 새로 만들 때의 기본값일 뿐이다.
const SLACK_PREFIX_MAX = 80 - '-someday'.length;
function slackChannelPrefix(user) {
  const clean = String(user || '').trim().toLowerCase()
    .replace(/[\s.]+/g, '-').replace(/[^a-z0-9_-]/g, '')
    .replace(/-{2,}/g, '-').replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, SLACK_PREFIX_MAX).replace(/[-_]+$/, '');
  return clean || 'my';
}

// 슬랙 위저드 `① 토큰`의 `다음` — 토큰이 맞는지만 `auth.test`로 본다. 파일은 하나도 쓰지 않는다.
// Bot 토큰(`xoxb-`)은 화면이 먼저 막지만, 여기서도 슬랙에 보내지 않고 같은 문구로 돌려보낸다.
// 돌려주는 것은 새 채널 이름의 앞머리(`prefix`)뿐이다 — 토큰·팀 정보는 싣지 않는다.
async function slackTokenCheck(token, request = (...args) => fetch(...args)) {
  const secret = trimmed(token);
  if (!secret) throw bad(MESSAGE.slackToken);
  if (/^xoxb-/.test(secret)) throw bad(MESSAGE.slackBot, 'bot_token');
  let auth;
  try { auth = await slackCall(secret, 'auth.test', null, request); } catch { throw bad(MESSAGE.slackReach); }
  if (!auth || auth.ok !== true) throw bad(MESSAGE.slackAuth, 'invalid_auth');
  return { ok: true, prefix: slackChannelPrefix(auth.user) };
}

// ---------- 캘린더 비밀 주소(iCal) ----------
// 비밀 주소는 토큰과 같은 급이다: 돌려주는 값·로그·오류 문구 어디에도 싣지 않는다(오류 문구는 우리 글자만).
const ICAL_TIMEOUT_MS = 10000;
const ICAL_MAX_BYTES = 20 * 1024 * 1024;

// 붙여 넣은 주소를 다듬는다. 애플 캘린더가 주는 `webcal://`은 같은 주소의 https로 읽는다.
function normalizeIcalUrl(value) {
  const text = trimmed(value).replace(/^webcal:\/\//i, 'https://');
  if (!text) throw bad(MESSAGE.icalUrl);
  if (!/^https:\/\/[^\s]+$/i.test(text)) throw bad(MESSAGE.icalHttps);
  try { new URL(text); } catch { throw bad(MESSAGE.icalHttps); }
  return text;
}

// 비밀 주소에서 캘린더 글자를 한 번 받아 온다(10초 제한). 파일은 쓰지 않는다.
async function fetchIcal(url, request = (...args) => fetch(...args), timeoutMs = ICAL_TIMEOUT_MS) {
  const address = normalizeIcalUrl(url);
  let text;
  let status = 0;
  try {
    const response = await request(address, {
      headers: { Accept: 'text/calendar, text/plain;q=0.9, */*;q=0.1' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = response ? Number(response.status) || 0 : 0;
    if (!response || !response.ok) throw new Error('status');
    const length = Number(response.headers && typeof response.headers.get === 'function' ? response.headers.get('content-length') : 0);
    if (length > ICAL_MAX_BYTES) throw new Error('too big');
    text = await response.text();
  } catch {
    const error = bad(MESSAGE.icalRead);
    // 401·403·404는 주소 자체가 막혔다는 뜻이다(재설정·삭제) — `다시 연결`로 안내하려고 표시만 붙인다(주소는 싣지 않는다).
    if ([401, 403, 404].includes(status)) error.auth = true;
    throw error;
  }
  if (text.length > ICAL_MAX_BYTES) throw bad(MESSAGE.icalRead);
  if (!/BEGIN:VCALENDAR/i.test(text)) throw bad(MESSAGE.icalNotCalendar);
  return text;
}

// `연결` 전에 한 번 읽어 **오늘 일정 수**만 센다(`오늘 일정 3개가 보여요`). 일정 내용은 돌려주지 않는다.
async function icalCheck(url, { request, now = Date.now(), timeZone } = {}) {
  const text = await fetchIcal(url, request);
  const calendar = parseCalendar(text);
  if (!calendar.ok) throw bad(MESSAGE.icalNotCalendar);
  return { ok: true, count: todayEvents(calendar, { now, timeZone }).length };
}

// 저장된 비밀 주소(없으면 빈 글자). 서버 안에서만 쓴다 — 응답에는 절대 싣지 않는다.
function savedIcalUrl(config, tokenDir) {
  const found = findToken(tokenPaths(tokenDir), 'calendar', clone(clone(config).calendar).icalFile);
  return found ? found.value : '';
}

// 슬랙 메시지 시각(ts) 모양 `초.마이크로초` — 채널을 "이때부터" 읽게 하는 since에 쓴다.
function slackTsNow(now = Date.now) {
  const ms = Number(now()) || 0;
  return `${Math.floor(ms / 1000)}.${String((ms % 1000) * 1000).padStart(6, '0')}`;
}

// ---------- config 합치기 ----------
// 아는 칸만 갈아 끼우고 나머지는 들어온 그대로 돌려준다.
function clone(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

// 이미 저장된 슬랙 토큰(없으면 빈 글자). `채널 고르기`처럼 토큰을 다시 받지 않는 길에서만
// 서버 안에서 쓴다 — 돌려주는 값·응답에는 절대 싣지 않는다.
function savedSlackToken(config, tokenDir) {
  const found = findToken(tokenPaths(tokenDir), 'slack', clone(clone(config).slack).tokenFile);
  return found ? found.value : '';
}

function withJira(config, { enabled, siteUrl, email, tokenFile, displayName }) {
  const next = { ...config };
  next.integrations = { ...clone(config.integrations), jira: enabled };
  if (siteUrl !== undefined || email !== undefined || tokenFile !== undefined || displayName !== undefined) {
    const jira = clone(config.jira);
    if (siteUrl !== undefined) jira.siteUrl = siteUrl;
    if (email !== undefined) jira.email = email;
    if (tokenFile !== undefined) jira.tokenFile = tokenFile;
    // 연결할 때 지라가 알려 준 표시 이름 — 연동 탭의 `○○님 · …` 한 줄에만 쓴다(토큰·이메일이 아니다).
    if (displayName !== undefined) jira.displayName = displayName;
    next.jira = jira;
  }
  return next;
}

function withSlack(config, { enabled, workspaceUrl, tokenFile, channels }) {
  const next = { ...config };
  next.integrations = { ...clone(config.integrations), slack: enabled };
  if (workspaceUrl !== undefined || tokenFile !== undefined || channels) {
    const slack = clone(config.slack);
    if (workspaceUrl !== undefined) slack.workspaceUrl = workspaceUrl;
    if (tokenFile !== undefined) slack.tokenFile = tokenFile;
    if (channels) {
      const merged = clone(slack.channels);
      // `off: false`는 "뺀 표시를 지운다"는 뜻이다 — 칸 자체를 없앤다(다른 칸은 그대로).
      Object.entries(channels).forEach(([key, value]) => {
        const next = { ...clone(merged[key]), ...value };
        if (next.off !== true) delete next.off;
        merged[key] = next;
      });
      // 사람이 채우지 않은 칸(빈 id·예시 자리표시자)은 아예 지운다 — 이미 연결된 진짜 채널만 남는다.
      Object.keys(merged).forEach((key) => { if (!realChannelId(clone(merged[key]).id)) delete merged[key]; });
      slack.channels = merged;
    }
    next.slack = slack;
  }
  return next;
}

// 캘린더는 켜고 끄는 값(`integrations.calendar`)과 "어느 갈래로 읽는지"(`calendar.source`: `ical` | `claude`,
// 비밀 주소 갈래면 `calendar.icalFile` 경로)를 함께 적는다. 끌 때는 갈래·경로를 그대로 둔다(주소 파일은 사람 것).
function withCalendar(config, enabled, { source, icalFile } = {}) {
  const next = { ...config, integrations: { ...clone(config.integrations), calendar: enabled } };
  if (source !== undefined || icalFile !== undefined) {
    const calendar = clone(config.calendar);
    if (source !== undefined) calendar.source = source;
    if (icalFile !== undefined) calendar.icalFile = icalFile;
    next.calendar = calendar;
  }
  return next;
}

// 회의록은 켜고 끄는 값(`integrations.tiro`)과 "무엇으로 쓰는지"(`meetingNotes`) 둘을 함께 적는다.
function withMeetingNotes(config, mode, name) {
  const next = { ...config, integrations: { ...clone(config.integrations), tiro: mode === 'tiro' } };
  next.meetingNotes = mode === 'other' ? { other: name } : mode;
  return next;
}

// `slack.appUrl`은 **연동 저장이 건드리지 않는 칸**이다(만드는 사람이 손으로 적는다).
// https로 시작하지 않으면 슬랙 앱 목록 화면으로 보낸다 — 화면의 링크가 이상한 곳으로 가지 않게.
const slackAppUrl = value => (/^https:\/\/[^\s]+$/.test(trimmed(value)) ? trimmed(value) : SLACK_APPS_URL);

// 화면이 읽는 지금 상태. 토큰은 있음/없음만 싣는다.
function readIntegrations(config, { tokenDir, claude } = {}) {
  const uses = clone(config.integrations);
  const jira = clone(config.jira);
  const slack = clone(config.slack);
  const paths = tokenPaths(tokenDir);
  const notes = config.meetingNotes;
  // 켜짐/꺼짐은 서버(`USES`)와 같은 뜻으로 읽는다 — **칸이 없으면 켜진 것**이다(옛 설정 파일은 tiro 칸이
  // 없어도 미팅 노트 가져오기가 돌고 있었다). `=== true`로 읽으면 화면이 "꺼짐"으로 잘못 보여 주고, 그
  // 상태에서 다른 갈래를 누르면 실제로 꺼 버린다(2026-09-23 사용자 설정에서 실제로 일어남).
  const on = key => uses[key] !== false;
  const mode = notes && typeof notes === 'object' && typeof notes.other === 'string'
    ? 'other'
    : (notes === 'tiro' || notes === 'manual' ? notes : (on('tiro') ? 'tiro' : 'manual'));
  const channels = clone(slack.channels);
  // 뺀 채널(`off: true`)은 **없는 것으로** 읽는다 — 연결 수·상태 줄·수집 목록 어디에도 서지 않는다.
  // 채널 고르기에서 다시 체크하면 새로 만들지 않고 같은 채널을 다시 켜야 하므로 이름만 따로 알려 준다(id는 서버 안에만).
  const off = {};
  SLACK_CHANNEL_KEYS.forEach((key) => {
    const entry = clone(channels[key]);
    if (entry.off === true && realChannelId(entry.id)) off[key] = { name: trimmed(entry.name) };
  });
  return {
    jira: {
      enabled: on('jira'),
      siteUrl: trimmed(jira.siteUrl),
      email: trimmed(jira.email),
      displayName: trimmed(jira.displayName),
      hasToken: !!findToken(paths, 'jira', jira.tokenFile),
    },
    slack: {
      enabled: on('slack'),
      workspaceUrl: trimmed(slack.workspaceUrl),
      // 토큰을 받으러 갈 주소(토큰이 아니다). 사람이 적어 둔 값이 https가 아니면 목록 화면으로 보낸다.
      appUrl: slackAppUrl(slack.appUrl),
      hasToken: !!findToken(paths, 'slack', slack.tokenFile),
      channels: Object.fromEntries(SLACK_CHANNEL_KEYS.map((key) => {
        const entry = clone(channels[key]);
        // 예시 자리표시자가 남아 있거나 뺀 채널이면 "연결 안 된 칸"으로 본다(이름도 같이 비운다).
        const id = entry.off === true ? '' : realChannelId(entry.id);
        return [key, { id, name: id ? trimmed(entry.name) : '' }];
      })),
      off,
    },
    calendar: {
      enabled: on('calendar'),
      // 어느 갈래로 읽는지 — 비밀 주소면 `ical`, 아니면 예전처럼 Claude Code(`claude`).
      source: trimmed(clone(config.calendar).source) === 'ical' ? 'ical' : 'claude',
      // 주소가 저장돼 있는지만(주소 자체는 싣지 않는다).
      hasIcal: !!findToken(paths, 'calendar', clone(config.calendar).icalFile),
    },
    meetingNotes: { mode, name: mode === 'other' ? trimmed(notes.other) : '' },
    claude: claude === true,
  };
}

// ---------- 저장 ----------
// 한 번에 하나(또는 여럿)를 켜고 끈다. 켜는 쪽은 먼저 **읽어 보고** 성공했을 때만 저장한다.
// 저장은 config 한 번 + 토큰 파일뿐이고, 실패하면 아무것도 쓰지 않는다.
async function saveIntegrations({
  configPath, current = {}, body = {}, tokenDir,
  jiraCheck, slackCheck, calendarCheck, write = atomicWrite, writeToken = writeTokenFile, now = Date.now,
} = {}) {
  if (!body || typeof body !== 'object') throw bad(MESSAGE.other);
  const paths = tokenPaths(tokenDir);
  let config = { ...current };
  const result = { ok: true };
  const pending = [];   // 확인이 끝난 뒤에 쓸 토큰 파일들
  let touched = false;

  if (body.jira && typeof body.jira === 'object') {
    touched = true;
    if (body.jira.enabled === false) {
      config = withJira(config, { enabled: false });
    } else {
      const siteUrl = trimmed(body.jira.siteUrl).replace(/\/+$/, '');
      const email = trimmed(body.jira.email);
      const token = trimmed(body.jira.token);
      if (!/^https:\/\/[^\s/?#]+$/.test(siteUrl)) throw bad(MESSAGE.jiraSite);
      if (!email) throw bad(MESSAGE.jiraEmail);
      // 토큰 칸을 비워 두고 저장하면 이미 있는 토큰을 그대로 쓴다 — config에 적힌 경로(사람이 옮겨
      // 둔 자리)를 먼저 보고, 없으면 기본 자리를 본다(readIntegrations의 hasToken과 같은 규칙).
      const saved = token ? null : findToken(paths, 'jira', clone(config.jira).tokenFile);
      if (!token && !saved) throw bad(MESSAGE.jiraToken);
      const secret = token || saved.value;
      const account = await (jiraCheck || (() => { throw bad(MESSAGE.jiraAuth); }))({ siteUrl, email, token: secret });
      if (!account || !account.ok) throw bad(MESSAGE.jiraAuth);
      if (token) pending.push([paths.jira.file, token]);
      // 새 토큰은 기본 자리에 쓰고 config도 그쪽으로 적는다. 비워 두고 저장했으면 지금 토큰이
      // 있는 자리를 그대로 적는다(사람이 옮겨 둔 경로를 기본 경로로 덮어쓰지 않는다).
      const displayName = String(account.displayName || '').trim().slice(0, 80);
      config = withJira(config, { enabled: true, siteUrl, email, tokenFile: token ? paths.jira.config : saved.config, displayName });
      result.jira = { displayName };
    }
  }

  if (body.slack && typeof body.slack === 'object') {
    touched = true;
    if (body.slack.enabled === false) {
      config = withSlack(config, { enabled: false });
    } else {
      const savedChannels = clone(clone(config.slack).channels);
      const asked = body.slack.channels && typeof body.slack.channels === 'object' ? body.slack.channels : {};
      const wanted = SLACK_CHANNEL_KEYS.filter(key => trimmed(asked[key]));
      // 채널 고르기의 빼기·다시 켜기. 빼기는 config에서 지우지 않고 `off: true`만 적는다(id·이름은 그대로) —
      // 슬랙 채널은 건드리지 않는다(보관·삭제·나가기를 부르지 않는다). 어느 채널이든 뺄 수 있지만 마지막 하나는 남는다.
      const keysOf = value => (Array.isArray(value) ? [...new Set(value.map(trimmed))] : []);
      const offKeys = keysOf(body.slack.off);
      const onKeys = keysOf(body.slack.on).filter(key => !offKeys.includes(key));
      if ([...offKeys, ...onKeys].some(key => !SLACK_CHANNEL_KEYS.includes(key))) throw bad(MESSAGE.other);
      // 빼기만 하는 저장은 슬랙에 묻지 않는다 — 토큰도 필요 없다.
      const needsSlack = wanted.length > 0 || onKeys.length > 0 || !offKeys.length;
      const token = trimmed(body.slack.token);
      const saved = token || !needsSlack ? null : findToken(paths, 'slack', clone(config.slack).tokenFile);
      if (needsSlack && !token && !saved) throw bad(MESSAGE.slackToken);
      const secret = token || (saved ? saved.value : '');
      // 저장 뒤 **켜진 채널이 하나 이상**이어야 한다(어느 채널이든 — 할 일도 선택이다). 새로 붙이는 것 · 다시 켜는 것 ·
      // 이미 켜져 있고 빼지 않는 것을 센다. 예시 자리표시자와 뺀 채널은 켜진 것으로 세지 않는다.
      const savedOn = (key) => { const entry = clone(savedChannels[key]); return !!realChannelId(entry.id) && entry.off !== true; };
      const willOn = SLACK_CHANNEL_KEYS.filter(key => wanted.includes(key) || onKeys.includes(key) || (!offKeys.includes(key) && savedOn(key)));
      if (!willOn.length) throw bad(offKeys.length ? MESSAGE.slackLastOff : MESSAGE.slackChannel);
      const channels = {};
      const at = slackTsNow(now);
      result.slack = { channels: {} };
      for (const key of wanted) {
        const id = parseChannelId(asked[key]);
        if (!id) throw bad(MESSAGE.slackChannel);
        const info = await (slackCheck || (() => { throw bad(MESSAGE.slackRead); }))(secret, id);
        // 새로 만든(다시 만든) 채널은 만든 때부터 읽는다 — 슬랙이 만든 때를 모르면 지금부터.
        const since = info.created ? `${info.created}.000000` : at;
        channels[key] = { id, name: info.name ? `#${info.name}` : '', since, off: false };
        result.slack.channels[key] = { name: channels[key].name, isPrivate: info.isPrivate === true };
      }
      // 다시 체크한 뺀 채널 — 새로 만들지 않고 저장된 id가 아직 있는지 슬랙에 한 번 묻는다(읽기만).
      // 살아 있으면 뺀 표시를 지우고 **지금부터** 읽는다(뺀 동안 온 메시지는 가져오지 않는다).
      for (const key of onKeys) {
        if (wanted.includes(key)) continue;
        const entry = clone(savedChannels[key]);
        const id = realChannelId(entry.id);
        if (!id) throw bad(MESSAGE.slackChannel);
        if (entry.off !== true) continue;
        let info = null;
        try {
          info = await (slackCheck || (() => { throw bad(MESSAGE.slackRead); }))(secret, id);
        } catch (error) {
          // 슬랙에 닿지 못했으면 사라졌다고 하지 않는다 — 잠시 뒤 다시 누르게 한다(설정은 그대로).
          if (error && error.code === 'slack_unreachable') {
            const offline = bad(MESSAGE.slackOffline, 'slack_unreachable');
            offline.key = key;
            throw offline;
          }
          info = null;
        }
        if (!info || info.archived) {
          const name = trimmed(entry.name);
          const error = bad(`${name ? `${name} 채널` : '채널'}${MESSAGE.slackGone}`, 'channel_gone');
          error.key = key;
          throw error;
        }
        channels[key] = { name: info.name ? `#${info.name}` : trimmed(entry.name), since: at, off: false };
        result.slack.channels[key] = { name: channels[key].name, isPrivate: info.isPrivate === true, reconnected: true };
      }
      offKeys.forEach((key) => {
        if (wanted.includes(key) || !realChannelId(clone(savedChannels[key]).id)) return;
        channels[key] = { off: true };
      });
      if (token) pending.push([paths.slack.file, token]);
      const workspaceUrl = trimmed(body.slack.workspaceUrl);
      config = withSlack(config, {
        enabled: true, channels,
        ...(token ? { tokenFile: paths.slack.config } : (saved ? { tokenFile: saved.config } : {})),
        ...(workspaceUrl ? { workspaceUrl } : {}),
      });
    }
  }

  if (body.calendar && typeof body.calendar === 'object') {
    touched = true;
    if (body.calendar.enabled !== true) {
      config = withCalendar(config, false);
    } else if (body.calendar.source === 'ical') {
      // 비밀 주소 갈래 — 한 번 읽어 오늘 일정 수를 센 뒤에만 저장한다. 칸을 비우면 저장된 주소로 다시 확인한다.
      const url = trimmed(body.calendar.url);
      const saved = url ? null : findToken(paths, 'calendar', clone(config.calendar).icalFile);
      if (!url && !saved) throw bad(MESSAGE.icalUrl);
      const address = url ? normalizeIcalUrl(url) : saved.value;
      const checked = await (calendarCheck || (() => { throw bad(MESSAGE.icalRead); }))(address);
      if (!checked || !checked.ok) throw bad(MESSAGE.icalRead);
      if (url) pending.push([paths.calendar.file, address]);
      config = withCalendar(config, true, { source: 'ical', icalFile: url ? paths.calendar.config : saved.config });
      result.calendar = { source: 'ical', count: Number(checked.count) || 0 };
    } else {
      // `Claude Code로` 갈래 — 예전 동작 그대로 켜고, 갈래만 `claude`로 적는다(비밀 주소 파일·경로는 그대로 둔다).
      config = withCalendar(config, true, { source: 'claude' });
      result.calendar = { source: 'claude' };
    }
  }

  if (body.meetingNotes && typeof body.meetingNotes === 'object') {
    touched = true;
    const mode = body.meetingNotes.mode;
    if (!['tiro', 'manual', 'other'].includes(mode)) throw bad(MESSAGE.other);
    const name = trimmed(body.meetingNotes.name).slice(0, 60);
    if (mode === 'other' && !name) throw bad('어떤 앱인지 이름을 적어 주세요');
    config = withMeetingNotes(config, mode, name);
  }

  if (!touched) throw bad(MESSAGE.other);
  // 여기까지 왔으면 전부 확인됐다 — 이제야 파일을 쓴다.
  pending.forEach(([file, value]) => writeToken(file, value));
  write(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return { config, result };
}

// ---------- 켠 연동 자동 등록 ----------
// launchd 등록(setup.sh)에 영향을 주는 값만 모은 한 줄 — 연동 켬/끔 · 캘린더 갈래 · 슬랙 채널(id와 뺀 표시).
// 저장 앞뒤로 견주어 달라졌을 때만 서버가 `requests/apply.request`를 쓴다(제목·이름 같은 값은 등록과 무관하다).
function registrationKey(config) {
  const uses = clone(clone(config).integrations);
  const channels = clone(clone(clone(config).slack).channels);
  return JSON.stringify({
    uses: ['slack', 'calendar', 'jira', 'tiro'].map(key => uses[key] !== false),
    calendar: trimmed(clone(clone(config).calendar).source) === 'ical' ? 'ical' : '',
    slack: SLACK_CHANNEL_KEYS.map((key) => {
      const entry = clone(channels[key]);
      return [trimmed(entry.id), entry.off === true];
    }),
  });
}

// ---------- 설정 › 꾸미기(이 맥에만) ----------
// 여기서도 **아는 키만** 바꾼다: `title`(화면 헤더·탭 제목)과 `server.dockName`(Dock 앱 이름).
// 저장 방식은 연동 저장과 같다(파일을 새로 읽어 그 위에 얹고, 원자적 교체).
async function savePersonalize({ configPath, current = {}, body = {}, write = atomicWrite, appsDir = '' } = {}) {
  const personalize = require('./personalize');
  if (!body || typeof body !== 'object') throw bad(MESSAGE.other);
  const next = { ...current };
  const changed = { title: false, dockName: false };
  let touched = false;
  if (body.title !== undefined) {
    const title = personalize.checkTitle(body.title);
    changed.title = title !== trimmed(current.title);
    next.title = title;
    touched = true;
  }
  if (body.dockName !== undefined) {
    const dockName = personalize.checkDockName(body.dockName);
    const before = trimmed(clone(current.server).dockName) || personalize.DOCK_NAME_DEFAULT;
    changed.dockName = dockName !== before;
    // 바꾸는 이름이 이미 있는 남의 앱과 같으면 저장하지 않는다(Dock 앱을 만들 수 없고, 그 앱을 지우지도 않는다).
    if (changed.dockName && personalize.dockNameTaken(appsDir, dockName)) throw bad(personalize.PERSONALIZE_MESSAGE.dockTaken);
    next.server = { ...clone(current.server), dockName };
    touched = true;
  }
  if (!touched) throw bad(personalize.PERSONALIZE_MESSAGE.nothing);
  write(configPath, `${JSON.stringify(next, null, 2)}\n`);
  return { config: next, changed };
}

// ---------- 채널 이름 따라가기 ----------
// 사람이 슬랙에서 채널 이름을 바꿔도 수집은 id로 읽으므로 그대로 이어진다 — 화면의 `#이름`만 낡는다.
// 연동 탭을 열 때(`GET /api/integrations`) 저장된 채널 id마다 `conversations.info`로 지금 이름을 읽어
// 달라졌으면 config의 그 채널 `name` **한 칸만** 고친다(아는 키만 — 나머지는 그대로).
// 답은 5분 동안 메모리에 들고 있고(실패도), 실패하면 조용히 옛 이름을 쓴다.
// 채널이 사라졌으면(`channel_not_found` / 보관됨) `missing`으로 알린다 — config는 건드리지 않는다.
const SLACK_FOLLOW_MS = 5 * 60 * 1000;
const SLACK_FOLLOW_TIMEOUT_MS = 4000;

function withSlackNames(config, names) {
  const slack = clone(config.slack);
  const channels = clone(slack.channels);
  Object.entries(names).forEach(([key, name]) => { channels[key] = { ...clone(channels[key]), name }; });
  return { ...config, slack: { ...slack, channels } };
}

function createSlackNameFollower({ now = Date.now, ttlMs = SLACK_FOLLOW_MS, request = (...args) => fetch(...args) } = {}) {
  const cache = new Map();   // 채널 id → { at, info }  (info: { name } | { missing: true } | null)

  async function look(token, id) {
    const hit = cache.get(id);
    if (hit && now() - hit.at < ttlMs) return hit.info;
    let info = null;
    try {
      const response = await request(`https://slack.com/api/conversations.info?channel=${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(SLACK_FOLLOW_TIMEOUT_MS),
      });
      const body = await response.json();
      if (body && body.ok === true && body.channel) {
        info = body.channel.is_archived === true ? { missing: true } : { name: String(body.channel.name || '') };
      } else if (body && (body.error === 'channel_not_found' || body.error === 'is_archived')) {
        info = { missing: true };
      }
    } catch { info = null; }
    cache.set(id, { at: now(), info });
    return info;
  }

  // `read`는 지금 config를 새로 읽는 함수다 — 슬랙을 기다리는 사이 다른 저장이 끼어들 수 있어서
  // 고치기 직전에 한 번 더 읽고 그 위에 이름만 얹는다.
  async function follow({ read, configPath, tokenDir, write = atomicWrite } = {}) {
    const config = clone(read());
    if (clone(config.integrations).slack === false) return { renamed: {}, missing: {} };
    const token = savedSlackToken(config, tokenDir);
    if (!token) return { renamed: {}, missing: {} };
    const channels = clone(clone(config.slack).channels);
    const keys = SLACK_CHANNEL_KEYS.filter(key => realChannelId(clone(channels[key]).id));
    const answers = await Promise.all(keys.map(key => look(token, realChannelId(clone(channels[key]).id))));
    const renamed = {};
    const missing = {};
    keys.forEach((key, index) => {
      const info = answers[index];
      if (!info) return;
      if (info.missing) { missing[key] = true; return; }
      const name = info.name ? `#${info.name}` : '';
      if (name && name !== trimmed(clone(channels[key]).name)) renamed[key] = name;
    });
    if (Object.keys(renamed).length && configPath) {
      try {
        const fresh = clone(read());
        const latest = clone(clone(fresh.slack).channels);
        // 그 사이 채널이 바뀌었으면(다른 id) 그 칸은 건드리지 않는다.
        const still = Object.fromEntries(Object.entries(renamed)
          .filter(([key]) => realChannelId(clone(latest[key]).id) === realChannelId(clone(channels[key]).id)));
        if (Object.keys(still).length) write(configPath, `${JSON.stringify(withSlackNames(fresh, still), null, 2)}\n`);
      } catch { /* 이름을 못 고쳐도 조용히 옛 이름을 쓴다 */ }
    }
    return { renamed, missing };
  }

  // 슬랙에 묻지 않고 **이미 들고 있는 답만** 본다 — 톱니바퀴의 빨간 점(켜진 채널이 모두 사라졌는지)처럼
  // 자주 부르는 자리에서 쓴다. 한 번도 묻지 않았으면 모른다(false).
  function knownMissing(config, key) {
    const entry = clone(clone(clone(config).slack).channels)[key];
    const id = realChannelId(clone(entry).id);
    if (!id || clone(entry).off === true) return false;
    const hit = cache.get(id);
    return !!(hit && hit.info && hit.info.missing);
  }

  // 켜진 채널이 **모두** 사라졌는가(하나 이상 켜져 있고, 그 전부를 이미 사라졌다고 들었다) — 슬랙 수집이 멈춘 것과
  // 같은 급(빨강)이다. 일부만 사라졌으면 멈춘 것이 아니다(카드의 주황 줄). 슬랙에 묻지 않는다.
  function allKnownMissing(config) {
    const channels = clone(clone(clone(config).slack).channels);
    const on = SLACK_CHANNEL_KEYS.filter((key) => { const entry = clone(channels[key]); return !!realChannelId(entry.id) && entry.off !== true; });
    return on.length > 0 && on.every(key => knownMissing(config, key));
  }

  return { follow, look, knownMissing, allKnownMissing, clear: () => cache.clear() };
}

// ---------- 다시 켜기 ----------
// launchd가 KeepAlive로 띄운 자리(`WORKSPACE_MANAGED`)에서만 스스로 끝낸다 — launchd가 다시 띄운다.
// 개발용·픽스처 서버는 끝내지 않고 "다시 켜 주세요"라고만 알린다.
// `exit`를 밖에서 끼워 넣으므로 테스트에서 실제 종료가 일어나지 않는다.
function scheduleRestart({ managed, exit, delay = 500, timer = setTimeout } = {}) {
  if (!managed) return false;
  const handle = timer(() => { try { exit(0); } catch { /* 끝내지 못해도 응답은 이미 나갔다 */ } }, delay);
  if (handle && typeof handle.unref === 'function') handle.unref();
  return true;
}

// ---------- 문제 보고에 실을 오류 줄 ----------
// 서버 로그(`server.err`)에서 **오류 줄만** 고른다. 업무 문장이 섞여 나가지 않게
// 줄마다 200자에서 자르고, 사람·티켓을 알아볼 수 있는 조각(이메일·지라 키·주소의 물음표 뒤)은 가린다.
const ERROR_LINE_RE = /(에러|Error|✗|실패)/;
const STACK_LINE_RE = /^\s+at\s/;

function maskLine(line) {
  return String(line)
    .replace(/[^\s:]+@[^\s:]+/g, '…')             // 이메일
    .replace(/\?[^\s]*/g, '?…')                    // 주소의 물음표 뒤(조회 조건)
    .replace(/\b[A-Z][A-Z0-9]+-\d+\b/g, '…');      // 지라 키
}

function errorLines(text, { max = 20, width = 200 } = {}) {
  return String(text || '').split('\n')
    .map(line => line.replace(/\s+$/, ''))
    .filter(line => line.trim() && (ERROR_LINE_RE.test(line) || STACK_LINE_RE.test(line)))
    .slice(-max)
    .map(line => maskLine(line.slice(0, width)));
}

// `claude` 실행 파일이 이 맥에 있는지 — PATH만 훑어보고 아무것도 실행하지 않는다.
function claudeInstalled(pathValue = process.env.PATH) {
  return String(pathValue || '').split(path.delimiter).filter(Boolean)
    .some((dir) => { try { return fs.statSync(path.join(dir, 'claude')).isFile(); } catch { return false; } });
}

module.exports = {
  SLACK_CHANNEL_KEYS, SLACK_APPS_URL, INTEGRATION_MESSAGE: MESSAGE,
  tokenPaths, parseChannelId, slackCheckChannel, slackCreateChannel, readIntegrations, saveIntegrations,
  scheduleRestart, errorLines, maskLine, claudeInstalled, writeTokenFile,
  slackTokenCheck, savedSlackToken, createSlackNameFollower, SLACK_FOLLOW_MS, slackChannelPrefix, slackTsNow,
  normalizeIcalUrl, fetchIcal, icalCheck, savedIcalUrl, ICAL_TIMEOUT_MS, savePersonalize, registrationKey,
};

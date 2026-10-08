// 연동 설정(설정 > 연동)이 쓰는 서버 쪽 한 벌 — 값 확인, `workspace.config.json` 합치기,
// 토큰 파일 쓰기, 문제 보고에 실을 오류 줄 고르기.
//
// 여기만 `workspace.config.json`을 고친다(DECISIONS 2026-09-23 — 설정 › 꾸미기의 이름 저장도 이 파일의
// savePersonalize로 한다). 규칙 셋:
//   1) **아는 키만** 바꾸고 모르는 키는 그대로 둔다 — 사람이 손으로 적어 둔 값이 사라지지 않게.
//   2) **토큰은 config에 적지 않는다** — 파일(0600)로만 두고 config에는 경로만 적는다.
//   3) 토큰 값은 돌려주는 값·로그·오류 문구 어디에도 싣지 않는다(있음/없음만).
//   4) 파일 쓰기는 전부 `writeConfig` 한 곳으로 — 쓰기 직전에 다시 읽고 이 요청이 바꾼 칸만 얹는다(그 함수 위 주석).
//
// 프로세스를 끝내는 길(`scheduleRestart`)도 여기 있다 — 부르는 쪽이 `exit`를 끼워 넣으므로
// 테스트에서는 실제 종료가 일어나지 않는다.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomicWrite } = require('./safe-storage');
const { parseCalendar, todayEvents } = require('./ical');
const slackAuth = require('./slack-auth');

const SLACK_CHANNEL_KEYS = ['todo', 'align', 'someday', 'waiting'];
// 칸 이름(화면의 SETTINGS_SLACK_CHANNELS와 같은 말) — `이미 ○○ 칸에 연결된 채널이에요`에만 쓴다.
const SLACK_CHANNEL_LABELS = { todo: '할 일', waiting: '기다리는 것', align: '정해진 것', someday: '언젠가' };
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
  // 지라 주소·실패 문구 — 어디를 고칠지 갈래마다 한 말. 주소·이메일·토큰은 싣지 않는다.
  // 지라는 이메일이 틀려도 토큰이 틀려도 똑같이 401을 줘서 둘은 가를 수 없다(그래서 auth는 둘 다 보라고 한다).
  jiraSite: '지라 주소는 https://로 시작해야 해요',
  jiraSiteBad: '지라 주소를 확인해 주세요 — 예: https://회사.atlassian.net',
  jiraEmail: '지라 계정 이메일을 적어 주세요',
  jiraEmailShape: '이메일 모양이 아니에요 — 지라에 로그인하는 회사 이메일을 적어 주세요',
  jiraToken: 'API 토큰을 붙여 넣어 주세요',
  jiraAuth: '이메일이나 토큰이 맞지 않아요 — 이메일을 확인하고, 맞으면 ← 이전으로 돌아가 새 토큰을 붙여 넣어 주세요',
  jiraReach: '지라에 연결하지 못했어요 — 주소와 인터넷 연결을 확인하고 다시 눌러 주세요',
  // Claude 로그인 토큰(`claude setup-token`이 보여 주는 한 줄) — 값은 문구에 싣지 않는다.
  claudeTokenEmpty: 'claude setup-token이 보여 준 토큰을 붙여 넣어 주세요',
  claudeTokenSpace: '토큰 사이에 띄어쓰기나 줄바꿈이 있어요 — 터미널에서 한 줄로 다시 복사해 주세요',
  claudeTokenShape: '토큰 모양이 아니에요 — claude setup-token이 보여 준 sk-ant-로 시작하는 한 줄을 붙여 넣어 주세요',
  claudeTokenLong: '토큰이 너무 길어요 — claude setup-token이 보여 준 한 줄만 붙여 넣어 주세요',
  slackToken: '슬랙 토큰을 붙여 넣어 주세요',
  slackChannel: '슬랙 채널 링크나 ID를 붙여 넣어 주세요',
  slackRead: '슬랙에서 이 채널을 읽지 못했어요 — 토큰과 채널을 확인해 주세요',
  slackPublic: '공개 채널이에요 — 나만 보는 채널을 권해요',
  slackName: '채널 이름은 소문자·숫자·-·_만 80자까지 쓸 수 있어요',
  slackAuth: '토큰이 맞지 않아요',
  slackScope: '이 슬랙 앱에는 채널 만들기 권한이 없어요 — 만든 사람에게 권한 추가를 요청해 주세요',
  slackTaken: '다른 사람이 쓰는 이름이에요 — 다른 이름을 적어 주세요',
  slackArchived: '보관된 채널이에요 — 슬랙에서 보관을 풀거나 다른 이름을 적어 주세요',
  slackListIncomplete: '슬랙에서 채널을 다 찾지 못했어요 — 잠시 뒤 다시 눌러 주세요',
  // 같은 채널을 두 칸에 둘 수 없다(한 메시지가 두 곳에 들어간다) — 앞은 칸 이름(`할 일` 등).
  slackInUse: ' 칸에 연결된 채널이에요 — 다른 이름을 적어 주세요',
  slackCreate: '슬랙에서 채널을 만들지 못했어요',
  // 받을 채널은 넷 중 하나 이상이면 된다(할 일도 선택) — 마지막 하나만 뺄 수 없다.
  slackLastOff: '마지막 채널은 뺄 수 없어요 — 슬랙 수집을 끄려면 ⋯ › 해제',
  slackGone: '을 찾을 수 없어요 — 슬랙에서 지웠거나 보관했어요. 체크한 채로 두면 새로 만들어요',
  slackOffline: '슬랙에 연결하지 못했어요 — 잠시 뒤 다시 눌러 주세요',
  slackBot: '이건 Bot 토큰이에요 — 바로 위의 User OAuth Token(xoxp-)을 복사해 주세요',
  slackAppLevel: '이건 앱 수준 토큰(xapp-)이에요 — OAuth & Permissions 화면의 User OAuth Token(xoxp-)을 복사해 주세요',
  slackNotUser: 'User OAuth Token은 xoxp-로 시작해요 — OAuth & Permissions 화면에서 복사해 주세요',
  slackReach: '슬랙에 닿지 못했어요 — 잠시 뒤 다시 해 주세요',
  // 새 방식(슬랙 연결 버튼)에서 저장된 연결을 쓸 수 없을 때 — 화면의 풀림 카드와 같은 말.
  slackReconnect: '슬랙 연결이 풀렸어요 — 다시 연결 한 번이면 돼요',
  slackBusy: '슬랙 연결을 정리하는 중이에요 — 잠시 뒤 다시 눌러 주세요',
  slackTidyClaude: 'Claude로 다듬으려면 이 맥에 Claude Code가 있어야 해요',
  icalUrl: '비밀 주소를 붙여 넣어 주세요',
  icalHttps: '주소는 https://로 시작해야 해요',
  icalRead: '이 주소를 읽지 못했어요 — 비밀 주소를 다시 복사해 주세요',
  icalPublic: '공개 주소를 붙였어요 — 같은 화면 조금 아래 「iCal 형식의 비공개 주소」를 복사해 주세요(공개 주소는 캘린더를 공개해야만 열려요)',
  icalNotCalendar: '캘린더 주소가 아니에요 — iCal 형식의 비공개 주소를 복사해 주세요',
  macPick: '읽을 캘린더를 하나 이상 골라 주세요',
  other: '보낸 값을 확인해 주세요.',
};

function bad(message, code) {
  const error = new Error(message);
  error.status = 400;
  // 화면이 갈래를 나눌 때만 쓰는 짧은 표지(슬랙이 준 오류 이름 중 아는 것만) — 값이나 토큰은 싣지 않는다.
  if (code) error.code = code;
  return error;
}

// 본문을 읽다 난 오류(깨진 JSON·너무 큼·끊김)를 고정 문구로 바꾼다 — JSON 파서 메시지는 짧은 본문이면
// 본문 조각(토큰 일부일 수 있다)을 그대로 싣기 때문이다. 상태 코드는 그대로(413은 413, 나머지는 400).
function bodyReadError(error) {
  const tooBig = !!error && error.status === 413;
  const fixed = new Error(tooBig ? '요청이 너무 커요.' : '요청을 읽지 못했어요 — 다시 눌러 주세요');
  fixed.status = tooBig ? 413 : 400;
  return fixed;
}

const trimmed = value => (typeof value === 'string' ? value.trim() : '');
const expandHome = value => String(value || '').replace(/^~(?=\/|$)/, os.homedir());
// 자리표시자는 "빈 칸"으로 읽는다.
const realChannelId = value => (trimmed(value) === PLACEHOLDER_CHANNEL_ID ? '' : trimmed(value));

// 지라 주소를 origin(`https://호스트`)만 남게 정리한다 — 브라우저 주소창을 통째로 붙여도(경로·쿼리·끝 빗금) 되게.
// `회사.atlassian.net`처럼 스킴 없이 오면 https://를 붙인다. https가 아닌 스킴(http:// 등)은 `scheme`,
// 주소로 읽을 수 없으면 `bad`로 돌려준다(부르는 쪽이 문구를 고른다). 화면(settings-ui.js settingsJiraSite)도 같은 규칙이다.
function normalizeJiraSite(value) {
  let text = trimmed(value);
  if (!text) return { error: 'bad' };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text.replace(/^\/+/, '')}`;
  let url;
  try { url = new URL(text); } catch { return { error: 'bad' }; }
  if (url.protocol !== 'https:') return { error: 'scheme' };
  // 호스트는 붙인 글자 그대로 쓴다(`URL`은 한글 호스트를 xn--로 바꿔 사람이 알아보기 어렵다) — 로그인 정보(`…@`)만 뗀다.
  const host = /^https:\/\/([^/?#\\]*)/i.exec(text)[1].replace(/^.*@/, '').toLowerCase();
  if (!host || /\s/.test(host)) return { error: 'bad' };
  return { site: `https://${host}` };
}

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
    // Claude 로그인 토큰(`claude setup-token`) — 자동화 실행기(run-task.sh)가 `~/.config/workspace-claude-token`을
    // 공백을 뺀 한 줄로 읽어 CLAUDE_CODE_OAUTH_TOKEN으로 넘긴다. config에는 적지 않는다(경로도 고정).
    claude: { file: path.join(dir, 'workspace-claude-token') },
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

// Claude 로그인 토큰 저장(설정 › 연동의 `Claude Code 로그인이 풀렸어요` 칸) — `POST /api/integrations/claude-token`.
// 파일 하나(0600)만 쓴다: config는 읽지도 쓰지도 않고, 서버 재시작·등록 요청·프로세스 실행도 없다.
// 이미 파일이 있으면 덮어쓰고 권한을 다시 조인다(writeTokenFile). 돌려주는 값은 `{ ok, saved }`뿐이고
// 값을 읽어 주는 길은 만들지 않는다. 모양 검사는 느슨하게 — `sk-ant-`로 시작하는 공백 없는 한 줄(보이는 ASCII)만 본다
// (setup-token 출력의 정확한 형식은 문서에 없어 추측으로 조이지 않는다). 거절 문구에는 값을 싣지 않는다.
const CLAUDE_TOKEN_MAX = 1024;
function saveClaudeToken({ body = {}, tokenDir, writeToken = writeTokenFile } = {}) {
  const value = body && typeof body === 'object' && typeof body.token === 'string' ? body.token.trim() : '';
  if (!value) throw bad(MESSAGE.claudeTokenEmpty, 'claude_empty');
  if (value.length > CLAUDE_TOKEN_MAX) throw bad(MESSAGE.claudeTokenLong, 'claude_long');
  if (/\s/.test(value)) throw bad(MESSAGE.claudeTokenSpace, 'claude_space');
  if (!/^sk-ant-[\x21-\x7e]+$/.test(value)) throw bad(MESSAGE.claudeTokenShape, 'claude_shape');
  writeToken(tokenPaths(tokenDir).claude.file, value);
  return { ok: true, saved: true };
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
// 이름이 이미 있으면 내 채널인지 찾아 그 채널을 돌려준다(`existing: true` — slackUseExisting).
// `options`: 이 채널을 둘 칸(`key`)과 저장된 채널들(`channels`, 뺀 칸 포함) — 다른 칸에 이미 연결된 채널을 막는 데만 쓴다.
// 슬랙에 닿지 못했으면(네트워크·시간 초과) 표지 `slack_unreachable`로 이름 문제와 가른다.
async function slackCreateChannel(token, name, request = (...args) => fetch(...args), options = {}) {
  const secret = trimmed(token);
  const wanted = trimmed(name).toLowerCase();
  if (!secret) throw bad(MESSAGE.slackToken);
  if (!SLACK_CHANNEL_NAME_RE.test(wanted)) throw bad(MESSAGE.slackName);

  let auth;
  try { auth = await slackCall(secret, 'auth.test', null, request); } catch { throw bad(MESSAGE.slackOffline, 'slack_unreachable'); }
  if (!auth || auth.ok !== true) throw bad(MESSAGE.slackAuth, 'invalid_auth');

  let body;
  try { body = await slackCall(secret, 'conversations.create', { name: wanted, is_private: true }, request); }
  catch { throw bad(MESSAGE.slackOffline, 'slack_unreachable'); }
  if (!body || body.ok !== true) {
    const kind = String((body && body.error) || '');
    if (kind === 'missing_scope') throw bad(MESSAGE.slackScope, 'missing_scope');
    if (kind === 'name_taken') return slackUseExisting(secret, wanted, request, { ...options, me: String(auth.user_id || '') });
    if (kind === 'invalid_auth' || kind === 'not_authed') throw bad(MESSAGE.slackAuth, 'invalid_auth');
    throw bad(MESSAGE.slackCreate);
  }
  const channel = body.channel && typeof body.channel === 'object' ? body.channel : {};
  const id = String(channel.id || '');
  if (!id) throw bad(MESSAGE.slackCreate);
  return { id, name: String(channel.name || wanted) };
}

// 이름이 이미 있을 때(`name_taken`) — 예전 시도로 만들어 둔 **내 채널**이면 새로 만들지 않고 그 채널을 쓴다.
// `users.conversations`로 읽기만 한다(보관·삭제·나가기·보관 풀기는 부르지 않는다 — DECISIONS 2026-09-24).
// 목록에 없음(남의 채널)·공개 채널·다른 사람이 만든 채널은 모두 `name_taken`이다.
// 목록을 끝까지 못 읽었으면(쪽·시간 상한, 슬랙 오류) 이름 중복이라고 하지 않는다 — 다시 누르게 한다.
const SLACK_LIST_PAGES = 10;
async function slackUseExisting(secret, wanted, request, { key = '', channels = {}, me = '' } = {}) {
  const found = await slackFindChannel(secret, wanted, request);
  if (found && found.is_archived === true) throw bad(MESSAGE.slackArchived, 'archived');
  // 내가 들어가 있는 채널만 목록에 온다(users.conversations). 그래도 공개 채널이거나 다른 사람이 만든 채널이면
  // "나만 있는 채널"이 아니므로 쓰지 않는다 — 팀이 같이 쓰는 #todo 같은 채널의 메시지가 할 일로 쏟아지지 않게.
  // 만든 사람이 확인되지 않으면(응답에 creator가 없음) 내 채널이라고 보지 않는다.
  if (!found || !found.creator || !me || found.creator !== me) throw bad(MESSAGE.slackTaken, 'name_taken');
  // 공개 채널은 내가 만들었고 나 혼자 있을 때만 쓴다(인원은 conversations.info로 읽기만) — 비공개 내 채널은 그대로.
  if (found.is_private !== true) {
    let info;
    try {
      const query = new URLSearchParams({ channel: String(found.id || ''), include_num_members: 'true' });
      const response = await request(`https://slack.com/api/conversations.info?${query}`, {
        headers: { Authorization: `Bearer ${secret}`, Accept: 'application/json' }, signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
      });
      info = await response.json();
    } catch { throw bad(MESSAGE.slackListIncomplete, 'slack_unreachable'); }
    const members = info && info.ok === true && info.channel ? Number(info.channel.num_members) : NaN;
    if (!Number.isFinite(members)) throw bad(MESSAGE.slackListIncomplete, 'slack_unreachable');
    if (members !== 1) throw bad(MESSAGE.slackTaken, 'name_taken');
  }
  const id = String(found.id || '');
  if (!id) throw bad(MESSAGE.slackListIncomplete, 'slack_unreachable');
  // 다른 칸(뺀 칸 포함)에 이미 연결된 채널이면 막는다 — 같은 칸이면 그대로 쓴다.
  // 칸 값이 네 칸 중 하나가 아니면(예전 화면이 key 없이 부름) 겹침 확인을 건너뛴다 — 저장할 때 한 번 더 막는다.
  const other = SLACK_CHANNEL_KEYS.includes(key) ? SLACK_CHANNEL_KEYS.find(one => one !== key && realChannelId(clone(clone(channels)[one]).id) === id) : null;
  if (other) throw bad(`이미 ${SLACK_CHANNEL_LABELS[other]}${MESSAGE.slackInUse}`, 'channel_in_use');
  return { id, name: String(found.name || wanted), existing: true };
}

// 내가 들어가 있는 채널 중 같은 이름 하나를 찾는다(대소문자·앞 `#` 무시). 보관된 채널도 본다(`exclude_archived=false`).
// 최대 10쪽·전체 8초 — 넘기면 "다 찾지 못했어요". 토큰은 헤더로만 나간다.
async function slackFindChannel(secret, wanted, request) {
  const same = value => String(value || '').replace(/^#/, '').toLowerCase() === wanted.replace(/^#/, '').toLowerCase();
  const signal = AbortSignal.timeout(SLACK_TIMEOUT_MS);
  let cursor = '';
  for (let page = 0; page < SLACK_LIST_PAGES; page += 1) {
    // 내가 들어가 있는 채널만(users.conversations) — 워크스페이스 전체 목록보다 훨씬 적어 상한·조회 제한에 덜 걸린다.
    const query = new URLSearchParams({ types: 'public_channel,private_channel', exclude_archived: 'false', limit: '200' });
    if (cursor) query.set('cursor', cursor);
    let body;
    try {
      const response = await request(`https://slack.com/api/users.conversations?${query}`, {
        headers: { Authorization: `Bearer ${secret}`, Accept: 'application/json' }, signal,
      });
      body = await response.json();
    } catch { throw bad(MESSAGE.slackListIncomplete, 'slack_unreachable'); }
    if (!body || body.ok !== true) {
      const kind = String((body && body.error) || '');
      if (kind === 'missing_scope') throw bad(MESSAGE.slackScope, 'missing_scope');
      if (kind === 'invalid_auth' || kind === 'not_authed') throw bad(MESSAGE.slackAuth, 'invalid_auth');
      throw bad(MESSAGE.slackListIncomplete, 'slack_unreachable');
    }
    const hit = (Array.isArray(body.channels) ? body.channels : []).find(one => one && same(one.name));
    if (hit) return hit;
    cursor = String((body.response_metadata && body.response_metadata.next_cursor) || '');
    if (!cursor) return null;
  }
  throw bad(MESSAGE.slackListIncomplete, 'slack_unreachable');
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
  // 앱 수준 토큰(xapp-, Basic Information 화면)·그 밖의 토큰은 채널을 읽지 못한다(not_allowed_token_type).
  if (/^xapp-/.test(secret)) throw bad(MESSAGE.slackAppLevel, 'app_token');
  // 토큰 교체(rotation)를 켠 앱의 사용자 토큰은 `xoxe.xoxp-`로 시작한다 — 이것도 사용자 토큰이다.
  if (!/^(xoxe\.)?xoxp-/.test(secret)) throw bad(MESSAGE.slackNotUser, 'not_user_token');
  let auth;
  try { auth = await slackCall(secret, 'auth.test', null, request); } catch { throw bad(MESSAGE.slackReach); }
  if (!auth || auth.ok !== true) throw bad(MESSAGE.slackAuth, 'invalid_auth');
  return { ok: true, prefix: slackChannelPrefix(auth.user), ...(slackRotatingToken(secret) ? { warning: 'rotating_token' } : {}) };
}
// 붙여 넣은 토큰이 12시간짜리(토큰 교체를 켠 슬랙 앱의 `xoxe.xoxp-`)인가 — 옛 방식으로 저장하면 갱신할 수단이 없어 12시간 뒤 끊긴다.
// 막지는 않는다(버튼을 못 쓰는 사람의 임시 길) — 화면과 저장 응답이 경고 종류(`rotating_token`)만 알린다.
const slackRotatingToken = token => /^xoxe\.xoxp-/.test(trimmed(token));

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

// 슬랙 연결 방식 — `oauth`(슬랙 연결 버튼, 자동 갱신) · `token`(토큰 붙여 넣기, 칸이 없는 옛 설치 포함).
const slackAuthMode = config => (clone(clone(config).slack).auth === 'oauth' ? 'oauth' : 'token');
// 서버(15분 타이머)가 미리 갱신하는 기준 — 화면의 `다음 갱신`이 이 기준으로 나온다.
const SLACK_REFRESH_AHEAD_MS = slackAuth.REFRESH_AHEAD_MS;

// 저장된 연결로 **지금 쓸 수 있는** 슬랙 토큰 — 화면이 토큰을 보내지 않는 길(채널 만들기·고르기·연결 저장)에서 서버 안에서만 쓴다.
// 옛 방식은 한 줄 파일을 읽을 뿐이고(없으면 빈 글자), 새 방식은 만료가 가까우면 갱신한 뒤의 토큰을 준다.
// 새 방식인데 다시 연결해야 하면 `slack_reconnect`로 던진다. 돌려주는 값은 응답·로그에 싣지 않는다.
async function slackTokenForUse(config, { tokenDir, request, now } = {}) {
  if (slackAuthMode(config) !== 'oauth') return savedSlackToken(config, tokenDir);
  const got = await slackAuth.getSlackToken({ config, tokenDir, request, now });
  if (!got.token || (got.failure && got.failure.kind === 'reconnect')) throw bad(MESSAGE.slackReconnect, 'slack_reconnect');
  return got.token;
}

// ---------- 설정 파일 쓰기(한 곳) ----------
// `workspace.config.json`을 쓰는 길은 전부 여기를 지난다(연동 저장·꾸미기·슬랙 연결 방식·채널 이름 따라가기).
// 저장은 시작할 때 본 설정(`base`)으로 새 설정(`next`)을 만들고, 그 사이 확인(지라·슬랙·캘린더, 몇 초)을 기다린다 —
// 그동안 다른 창·다른 요청이 설정을 바꿀 수 있다. 그래서 통째로 쓰지 않는다:
//   1) 쓰기 **직전에** 디스크의 최신 설정을 다시 읽는다(파일이 없거나 깨졌으면 `base`를 최신으로 본다).
//   2) 이 요청이 바꾼 칸만 얹는다. 칸은 최상위 키, 값이 둘 다 객체면 그 아래 두 번째 키(`server.autoUpdate`·
//      `slack.channels`·`jira.siteUrl`·`integrations.slack` 같은 단위)다. 바꾼 칸 = `base`와 `next`의 값이 다른 칸,
//      `next`에서 사라진 칸은 지운다. 이 요청이 안 바꾼 칸은 최신 값 그대로다.
//   3) 같은 칸을 그 사이 남도 바꿨으면(최신 ≠ base): 사람이 방금 누른 저장(`wins: 'mine'`)은 이 요청 값이 이긴다
//      (마지막 누름이 이김), 자동 갱신(`wins: 'theirs'` — 이름 따라가기)은 남의 값을 지키고 그 칸을 건너뛴다.
//   4) 다시 읽기 → 얹기 → 쓰기는 기다림 없이 한 번에(동기) 한다 — 같은 서버 안에서는 두 쓰기가 끼어들 수 없어
//      따로 대기열이 없어도 한 줄로 선다. 쓰기는 원자적 교체(atomicWrite)다.
// 돌려주는 값은 실제로 쓴 설정이다.
const isPlain = value => !!value && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function changedFields(base, next) {
  const fields = [];
  new Set([...Object.keys(base), ...Object.keys(next)]).forEach((key) => {
    const before = base[key];
    const after = next[key];
    if (same(before, after)) return;
    // 처음 생기는 객체(base에 없던 `slack` 등)도 안쪽 칸 단위로 본다 — 그 사이 남이 만든 같은 객체의 다른 칸을 지우지 않게.
    if (isPlain(after) && (isPlain(before) || before === undefined)) {
      const was = isPlain(before) ? before : {};
      new Set([...Object.keys(was), ...Object.keys(after)]).forEach((inner) => {
        if (!same(was[inner], after[inner])) fields.push([key, inner]);
      });
    } else fields.push([key]);
  });
  return fields;
}

const fieldOf = (config, [key, inner]) => (inner === undefined ? config[key] : (isPlain(config[key]) ? config[key][inner] : undefined));

function mergeConfig({ base = {}, next = {}, latest = {}, wins = 'mine' } = {}) {
  const merged = clone(JSON.parse(JSON.stringify(latest)));
  changedFields(clone(base), clone(next)).forEach((field) => {
    if (wins === 'theirs' && !same(fieldOf(latest, field), fieldOf(base, field))) return;
    const [key, inner] = field;
    const value = fieldOf(next, field);
    if (inner === undefined) {
      if (value === undefined) delete merged[key]; else merged[key] = value;
      return;
    }
    // 최신에서 그 키가 객체가 아니게 바뀌었으면 다음 쪽 객체에서 시작한다(`theirs`면 위에서 이미 건너뛴다).
    const holder = isPlain(merged[key]) ? { ...merged[key] } : {};
    if (value === undefined) delete holder[inner]; else holder[inner] = value;
    merged[key] = holder;
  });
  return merged;
}

function readConfigFile(configPath, fallback) {
  try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { return fallback; }
}

function writeConfig({ configPath, base = {}, next = {}, wins = 'mine', write = atomicWrite, read = file => readConfigFile(file, base) } = {}) {
  const latest = read(configPath);
  const merged = mergeConfig({ base, next, latest: isPlain(latest) ? latest : base, wins });
  write(configPath, `${JSON.stringify(merged, null, 2)}\n`);
  return merged;
}

// 슬랙 `허용`이 끝난 뒤(slack-auth.js saveOAuthResult가 토큰을 저장한 뒤) 설정에 방식만 적는다 — `slack.auth: 'oauth'`.
// 토큰 파일 경로 칸이 비어 있으면 기본 자리를 적는다(사람이 옮겨 둔 경로는 그대로). 켬/끔·채널은 건드리지 않는다.
function saveSlackAuth({ configPath, current = {}, tokenDir, write = atomicWrite } = {}) {
  const slack = { ...clone(current.slack), auth: 'oauth' };
  if (!trimmed(slack.tokenFile)) slack.tokenFile = tokenPaths(tokenDir).slack.config;
  return writeConfig({ configPath, base: current, next: { ...current, slack }, write });
}

// 화면이 읽는 자동 갱신 상태 — 값 없이 시각·권한·실패 종류만(slack-auth.js readOAuthStatus에서 필요한 칸만 고른다).
function slackOAuthView(config, tokenDir) {
  const status = slackAuth.readOAuthStatus({ config, tokenDir, minValidMs: SLACK_REFRESH_AHEAD_MS });
  const failure = status.lastFailure;
  return {
    connected: status.connected === true,
    // 갱신이 만료 뒤에도 이어지지 않는다 — 카드가 `멈췄어요`로 올린다(서버의 integrationAlerts와 같은 값).
    stalled: status.stalled === true,
    // 왜 이어 가지 못하나 — `rejected`(슬랙이 거절: 다시 연결) · `unreachable`(슬랙에 닿지 못함: 연결이 돌아오면 알아서 이어진다).
    stalledBy: status.stalledBy || '',
    expiresAt: status.expiresAt, nextRefreshAt: status.nextRefreshAt,
    missingScopes: status.missingScopes || [],
    lastFailure: failure ? { kind: failure.kind, reason: failure.reason, ...(failure.code ? { code: failure.code } : {}) } : null,
    teamName: status.teamName || '',
    legacyKept: status.legacyKept === true,
  };
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

// 슬랙 정리 방식(`slack.tidy`: `claude` | `raw`) 한 칸만 바꾼다 — 다른 칸은 그대로.
const SLACK_TIDY = ['claude', 'raw'];
function withSlackTidy(config, tidy) {
  return { ...config, slack: { ...clone(config.slack), tidy } };
}

// 캘린더는 켜고 끄는 값(`integrations.calendar`)과 "어느 갈래로 읽는지"(`calendar.source`: `mac` | `ical` | `claude`,
// 비밀 주소 갈래면 `calendar.icalFile` 경로, 맥 캘린더 갈래면 고른 캘린더 `calendar.macCalendars`)를 함께 적는다.
// 끌 때는 갈래·경로·고른 캘린더를 그대로 둔다(주소 파일은 사람 것).
function withCalendar(config, enabled, { source, icalFile, macCalendars } = {}) {
  const next = { ...config, integrations: { ...clone(config.integrations), calendar: enabled } };
  if (source !== undefined || icalFile !== undefined || macCalendars !== undefined) {
    const calendar = clone(config.calendar);
    if (source !== undefined) calendar.source = source;
    if (icalFile !== undefined) calendar.icalFile = icalFile;
    if (macCalendars !== undefined) calendar.macCalendars = macCalendars;
    next.calendar = calendar;
  }
  return next;
}

// 맥 캘린더 갈래에서 고른 캘린더 — `[{ id, name }]`(id로 따라가고, 이름은 보여 주기·id가 바뀌었을 때만). 50개까지.
const MAC_CALENDARS_MAX = 50;
function macCalendarsOf(value) {
  const seen = new Set();
  return (Array.isArray(value) ? value : []).map(one => ({
    id: trimmed(clone(one).id).slice(0, 300),
    name: trimmed(clone(one).name).replace(/\s+/g, ' ').slice(0, 200),
  })).filter((one) => {
    if (!one.id || /[\u0000-\u001f]/.test(one.id) || seen.has(one.id)) return false;
    seen.add(one.id);
    return true;
  }).slice(0, MAC_CALENDARS_MAX);
}
// 설정의 갈래 이름 — 아는 둘(`ical`·`mac`)만, 나머지는 예전처럼 Claude Code(`claude`).
function calendarSourceOf(config) {
  const source = trimmed(clone(clone(config).calendar).source);
  return source === 'ical' || source === 'mac' ? source : 'claude';
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
  // 새 방식(자동 갱신)의 상태 — 값 없이. 옛 방식이면 null.
  const slackOAuth = slackAuthMode(config) === 'oauth' ? slackOAuthView(config, tokenDir) : null;
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
      // 새 방식은 갱신 정보 파일이 연결의 주인이다 — 한 줄 사본만 없어도(쓰기 실패·지워짐) 연결된 것으로 본다
      // (수집·서버는 갱신 정보에서 토큰을 받고 다음 호출이 사본을 다시 맞춘다). 풀렸는지는 `oauth.connected`가 말한다.
      hasToken: !!findToken(paths, 'slack', slack.tokenFile) || !!(slackOAuth && slackOAuth.expiresAt !== null),
      // 정리 방식 — `raw`(원문 그대로)만 따로 읽고, 칸이 없거나 다른 값이면 `claude`(예전 그대로).
      tidy: slack.tidy === 'raw' ? 'raw' : 'claude',
      // 연결 방식과, 새 방식이면 자동 갱신 상태(값 없이). 옛 방식(칸 없음 포함)은 `token`이고 `oauth` 칸이 없다.
      auth: slackAuthMode(config),
      ...(slackOAuth ? { oauth: slackOAuth } : {}),
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
      // 어느 갈래로 읽는지 — 맥 캘린더면 `mac`, 비밀 주소면 `ical`, 아니면 예전처럼 Claude Code(`claude`).
      source: calendarSourceOf(config),
      // 맥 캘린더 갈래에서 고른 캘린더(id·이름 — 이 맥 안의 이름이다).
      macCalendars: macCalendarsOf(clone(config.calendar).macCalendars),
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
  configPath, current = {}, body = {}, tokenDir, claude,
  jiraCheck, slackCheck, calendarCheck, write = atomicWrite, writeToken = writeTokenFile, now = Date.now,
  slackToken = config => slackTokenForUse(config, { tokenDir }), forgetOAuth = slackAuth.forgetOAuth,
} = {}) {
  if (!body || typeof body !== 'object') throw bad(MESSAGE.other);
  const paths = tokenPaths(tokenDir);
  let config = { ...current };
  const result = { ok: true };
  const pending = [];   // 확인이 끝난 뒤에 쓸 토큰 파일들
  let pastedOverOAuth = '';   // 새 방식에서 토큰을 직접 붙여 넣었을 때의 그 토큰(갱신 정보를 지우면서 쓴다)
  let touched = false;

  if (body.jira && typeof body.jira === 'object') {
    touched = true;
    if (body.jira.enabled === false) {
      config = withJira(config, { enabled: false });
    } else {
      // 주소는 정리한 뒤에 본다(주소창째 붙여도 origin만) — 정리한 주소가 config에 적힌다.
      const site = normalizeJiraSite(body.jira.siteUrl);
      if (site.error) throw bad(site.error === 'scheme' ? MESSAGE.jiraSite : MESSAGE.jiraSiteBad, 'jira_site');
      const siteUrl = site.site;
      const email = trimmed(body.jira.email);
      const token = trimmed(body.jira.token);
      if (!email) throw bad(MESSAGE.jiraEmail, 'jira_email');
      if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw bad(MESSAGE.jiraEmailShape, 'jira_email');
      // 토큰 칸을 비워 두고 저장하면 이미 있는 토큰을 그대로 쓴다 — config에 적힌 경로(사람이 옮겨
      // 둔 자리)를 먼저 보고, 없으면 기본 자리를 본다(readIntegrations의 hasToken과 같은 규칙).
      const saved = token ? null : findToken(paths, 'jira', clone(config.jira).tokenFile);
      if (!token && !saved) throw bad(MESSAGE.jiraToken);
      const secret = token || saved.value;
      const account = await (jiraCheck || (() => { throw bad(MESSAGE.jiraAuth, 'jira_auth'); }))({ siteUrl, email, token: secret });
      // 실패는 checkJiraAccount가 준 갈래(`kind`)로 가른다 — auth(401·403)는 이메일·토큰, 그 밖(연결 안 됨·404 등)은 주소·인터넷.
      if (!account || !account.ok) {
        if (account && account.kind && account.kind !== 'auth') throw bad(MESSAGE.jiraReach, 'jira_unreachable');
        throw bad(MESSAGE.jiraAuth, 'jira_auth');
      }
      if (token) pending.push([paths.jira.file, token]);
      // 새 토큰은 기본 자리에 쓰고 config도 그쪽으로 적는다. 비워 두고 저장했으면 지금 토큰이
      // 있는 자리를 그대로 적는다(사람이 옮겨 둔 경로를 기본 경로로 덮어쓰지 않는다).
      const displayName = String(account.displayName || '').trim().slice(0, 80);
      config = withJira(config, { enabled: true, siteUrl, email, tokenFile: token ? paths.jira.config : saved.config, displayName });
      result.jira = { displayName };
    }
  }

  // 슬랙 정리 방식만 바꾸는 저장(`{ slack: { tidy } }`) — 슬랙에 묻지 않고 그 칸 하나만 쓴다. 이미 들어온 항목은 그대로다.
  // `claude`는 이 맥에 Claude Code가 있을 때만 받는다(`claude: false`를 받았을 때만 막는다).
  const slackKeys = body.slack && typeof body.slack === 'object' ? Object.keys(body.slack) : [];
  const tidyOnly = slackKeys.length === 1 && slackKeys[0] === 'tidy';
  if (body.slack && body.slack.tidy !== undefined) {
    if (!SLACK_TIDY.includes(body.slack.tidy)) throw bad(MESSAGE.other);
    if (body.slack.tidy === 'claude' && claude === false) throw bad(MESSAGE.slackTidyClaude);
  }
  if (tidyOnly) {
    touched = true;
    config = withSlackTidy(config, body.slack.tidy);
    result.slack = { tidy: body.slack.tidy };
  } else if (body.slack && typeof body.slack === 'object') {
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
      // 새로 만들지 않고 이미 있던 내 채널을 쓰는 칸(채널 만들기가 `existing: true`로 돌려준 것) — 그때부터 읽는다.
      const existingKeys = keysOf(body.slack.existing);
      if ([...offKeys, ...onKeys, ...existingKeys].some(key => !SLACK_CHANNEL_KEYS.includes(key))) throw bad(MESSAGE.other);
      // 빼기만 하는 저장은 슬랙에 묻지 않는다 — 토큰도 필요 없다.
      const needsSlack = wanted.length > 0 || onKeys.length > 0 || !offKeys.length;
      const token = trimmed(body.slack.token);
      // 새 방식(슬랙 연결 버튼)이면 화면이 토큰을 모른다 — 저장된 연결에서 지금 쓸 토큰을 받는다(필요하면 갱신).
      const oauth = slackAuthMode(config) === 'oauth';
      const saved = token || !needsSlack || oauth ? null : findToken(paths, 'slack', clone(config.slack).tokenFile);
      const renewed = !token && needsSlack && oauth ? await slackToken(config) : '';
      if (needsSlack && !token && !saved && !renewed) throw bad(oauth ? MESSAGE.slackReconnect : MESSAGE.slackToken, oauth ? 'slack_reconnect' : undefined);
      const secret = token || renewed || (saved ? saved.value : '');
      // 저장 뒤 **켜진 채널이 하나 이상**이어야 한다(어느 채널이든 — 할 일도 선택이다). 새로 붙이는 것 · 다시 켜는 것 ·
      // 이미 켜져 있고 빼지 않는 것을 센다. 예시 자리표시자와 뺀 채널은 켜진 것으로 세지 않는다.
      const savedOn = (key) => { const entry = clone(savedChannels[key]); return !!realChannelId(entry.id) && entry.off !== true; };
      const willOn = SLACK_CHANNEL_KEYS.filter(key => wanted.includes(key) || onKeys.includes(key) || (!offKeys.includes(key) && savedOn(key)));
      if (!willOn.length) throw bad(offKeys.length ? MESSAGE.slackLastOff : MESSAGE.slackChannel);
      const channels = {};
      const at = slackTsNow(now);
      result.slack = { channels: {} };
      const wantedIds = Object.fromEntries(wanted.map(key => [key, parseChannelId(asked[key])]));
      for (const key of wanted) {
        const id = wantedIds[key];
        if (!id) throw bad(MESSAGE.slackChannel);
        // 같은 채널을 두 칸에 두지 않는다 — 이번에 같이 붙이는 칸, 또는 그대로 남는 다른 칸(뺀 칸 포함)과 겹치면 막는다.
        const other = SLACK_CHANNEL_KEYS.find(one => one !== key
          && (wanted.includes(one) ? wantedIds[one] === id : realChannelId(clone(savedChannels[one]).id) === id));
        if (other) {
          const error = bad(`이미 ${SLACK_CHANNEL_LABELS[other]}${MESSAGE.slackInUse}`, 'channel_in_use');
          error.key = key;
          throw error;
        }
      }
      for (const key of wanted) {
        const id = wantedIds[key];
        const info = await (slackCheck || (() => { throw bad(MESSAGE.slackRead); }))(secret, id);
        // 새로 만든(다시 만든) 채널은 만든 때부터 읽는다 — 슬랙이 만든 때를 모르면 지금부터.
        // 이미 있던 채널을 쓰는 칸은 **지금부터** 읽는다(예전에 쌓인 메시지를 한꺼번에 가져오지 않게).
        // 화면의 표시만 믿지 않는다 — 만든 지 한 시간이 넘은 채널이면 표시가 없어도 지금부터 읽는다.
        const fresh = info.created && Number(at) - Number(info.created) <= 3600;
        const since = !existingKeys.includes(key) && fresh ? `${info.created}.000000` : at;
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
      // 새 방식 사용자가 `고급: 토큰 직접 붙여 넣기`로 저장하면 옛 방식으로 되돌린다 — 갱신 정보가 남아 있으면
      // 다음 갱신이 붙여 넣은 토큰을 덮기 때문에, 토큰 쓰기와 갱신 정보 지우기를 갱신과 같은 잠금 안에서 한다(아래).
      if (token && oauth) pastedOverOAuth = token;
      else if (token) pending.push([paths.slack.file, token]);
      const workspaceUrl = trimmed(body.slack.workspaceUrl);
      // 처음 연결(저장된 채널이 하나도 없고 정리 방식 칸도 없음)이면 이 맥에 Claude Code가 있는지로 정한다 —
      // 없으면 `raw`(원문 그대로), 있으면 `claude`. 이미 연결했던 사람은 칸이 없어도 그대로 `claude`다(동작 변화 없음).
      const firstTime = !SLACK_CHANNEL_KEYS.some(key => realChannelId(clone(savedChannels[key]).id)) && clone(config.slack).tidy === undefined;
      const tidy = body.slack.tidy !== undefined ? body.slack.tidy : (firstTime ? (claude === false ? 'raw' : 'claude') : undefined);
      config = withSlack(config, {
        enabled: true, channels,
        ...(token ? { tokenFile: paths.slack.config } : (saved ? { tokenFile: saved.config } : {})),
        ...(workspaceUrl ? { workspaceUrl } : {}),
      });
      if (pastedOverOAuth) config = { ...config, slack: { ...clone(config.slack), auth: 'token' } };
      if (token && slackRotatingToken(token)) result.slack.warning = 'rotating_token';
      if (tidy !== undefined) {
        config = withSlackTidy(config, tidy);
        result.slack.tidy = tidy;
      }
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
      // 구글의 `공개 주소`(…/public/basic.ics)는 캘린더를 공개하지 않으면 열리지 않는다 — 읽어 보기 전에 알려 준다.
      if (url && /\/public\/basic\.ics(\?|$)/.test(url)) throw bad(MESSAGE.icalPublic);
      const address = url ? normalizeIcalUrl(url) : saved.value;
      const checked = await (calendarCheck || (() => { throw bad(MESSAGE.icalRead); }))(address);
      if (!checked || !checked.ok) throw bad(MESSAGE.icalRead);
      if (url) pending.push([paths.calendar.file, address]);
      config = withCalendar(config, true, { source: 'ical', icalFile: url ? paths.calendar.config : saved.config });
      result.calendar = { source: 'ical', count: Number(checked.count) || 0 };
    } else if (body.calendar.source === 'mac') {
      // 맥 캘린더 갈래 — 서버는 맥 캘린더를 읽지 않는다(프로세스를 띄우지 않는다). 화면이 `허용하고 확인`으로 이미 읽어 본
      // 목록에서 고른 캘린더만 적고, 읽기는 launchd `mac-calendar`가 등록되자마자 한 번, 그 뒤 30분마다 한다.
      const macCalendars = macCalendarsOf(body.calendar.macCalendars);
      if (!macCalendars.length) throw bad(MESSAGE.macPick);
      config = withCalendar(config, true, { source: 'mac', macCalendars });
      result.calendar = { source: 'mac', calendars: macCalendars.length };
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
  if (pastedOverOAuth) {
    const forgot = await forgetOAuth({ config: current, tokenDir, then: () => writeToken(paths.slack.file, pastedOverOAuth) });
    if (!forgot) throw bad(MESSAGE.slackBusy, 'slack_busy');
  }
  config = writeConfig({ configPath, base: current, next: config, write });
  // 정리 방식만 바꾼 저장은 서버를 다시 켤 필요가 없다(수집 스크립트가 회차마다 설정을 읽는다).
  const quiet = tidyOnly && !body.jira && !body.calendar && !body.meetingNotes;
  return { config, result, quiet };
}

// ---------- 켠 연동 자동 등록 ----------
// launchd 등록(setup.sh)에 영향을 주는 값만 모은 한 줄 — 연동 켬/끔 · 캘린더 갈래 · 슬랙 채널(id와 뺀 표시).
// 저장 앞뒤로 견주어 달라졌을 때만 서버가 `requests/apply.request`를 쓴다(제목·이름 같은 값은 등록과 무관하다).
function registrationKey(config) {
  const uses = clone(clone(config).integrations);
  const channels = clone(clone(clone(config).slack).channels);
  return JSON.stringify({
    uses: ['slack', 'calendar', 'jira', 'tiro'].map(key => uses[key] !== false),
    calendar: calendarSourceOf(config) === 'claude' ? '' : calendarSourceOf(config),
    slack: SLACK_CHANNEL_KEYS.map((key) => {
      const entry = clone(channels[key]);
      return [trimmed(entry.id), entry.off === true];
    }),
  });
}

// ---------- 설정 › 꾸미기(이 맥에만) ----------
// 여기서도 **아는 키만** 바꾼다: `title`(화면 헤더·탭 제목)·`server.dockName`(앱 이름 — 크롬 앱 manifest, 키 이름은 옛 설정 호환)·
// `titleHidden`(헤더의 제목만 숨기는 스위치 — 값·앱 이름은 그대로 둔다) · `server.autoUpdate`(설정 › 앱의 자동 업데이트 스위치, WP-U).
// 저장 방식은 연동 저장과 같다(writeConfig — 쓰기 직전에 파일을 새로 읽어 바꾼 칸만 얹고, 원자적 교체).
async function savePersonalize({ configPath, current = {}, body = {}, write = atomicWrite } = {}) {
  const personalize = require('./personalize');
  if (!body || typeof body !== 'object') throw bad(MESSAGE.other);
  const next = { ...current };
  const changed = { title: false, dockName: false, titleHidden: false, autoUpdate: false };
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
    next.server = { ...clone(current.server), dockName };
    touched = true;
  }
  if (body.titleHidden !== undefined) {
    if (typeof body.titleHidden !== 'boolean') throw bad(MESSAGE.other);
    changed.titleHidden = body.titleHidden !== (current.titleHidden === true);
    next.titleHidden = body.titleHidden;
    touched = true;
  }
  // 설정 › 앱의 `자동으로 업데이트`(WP-U) — 끄면 `server.autoUpdate: false`, 켜면 그 칸을 지운다(기본 켜짐).
  if (body.autoUpdate !== undefined) {
    if (typeof body.autoUpdate !== 'boolean') throw bad(MESSAGE.other);
    const server = { ...clone(next.server) };
    changed.autoUpdate = body.autoUpdate !== (server.autoUpdate !== false);
    if (body.autoUpdate) delete server.autoUpdate; else server.autoUpdate = false;
    next.server = server;
    touched = true;
  }
  if (!touched) throw bad(personalize.PERSONALIZE_MESSAGE.nothing);
  return { config: writeConfig({ configPath, base: current, next, write }), changed };
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

// `token`은 지금 쓸 토큰을 주는 함수다 — 새 방식(자동 갱신)이면 만료가 가까울 때 갱신한 뒤의 토큰을 받는다
// (한 줄 사본만 읽으면 서버가 꺼져 있던 사이 만료된 토큰으로 묻게 된다). 못 받으면 빈 글자로 보고 조용히 지나간다.
function createSlackNameFollower({
  now = Date.now, ttlMs = SLACK_FOLLOW_MS, request = (...args) => fetch(...args),
  token: tokenFor = (config, tokenDir) => slackTokenForUse(config, { tokenDir }),
} = {}) {
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
  // 고치기 직전에 한 번 더 읽고 그 위에 이름만 얹는다(writeConfig `wins: 'theirs'` — 그 사이 사람이
  // 채널 칸을 바꿨으면 이름 고치기는 건너뛴다. 다음에 탭을 열 때 다시 따라간다).
  async function follow({ read, configPath, tokenDir, write = atomicWrite } = {}) {
    const config = clone(read());
    if (clone(config.integrations).slack === false) return { renamed: {}, missing: {} };
    let token = '';
    try { token = await tokenFor(config, tokenDir); } catch { token = ''; }
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
        writeConfig({ configPath, base: config, next: withSlackNames(config, renamed), wins: 'theirs', write, read: () => clone(read()) });
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

// `claude` 실행 파일이 이 맥에 있는지 — 아무것도 실행하지 않고 파일이 있는지만 본다.
// 앱 서버는 launchd로 떠서 PATH가 거의 비어 있다(/usr/bin:/bin…). 그래서 PATH만 보면 기본 설치 자리
// (~/.local/bin)의 claude를 못 찾아 "설치 안 됨"으로 잘못 알렸다 — 자동화(run-task.sh)가 claude를 찾는
// 자리들도 같이 본다.
function claudeCandidateDirs(pathValue = process.env.PATH, home = os.homedir()) {
  const dirs = String(pathValue || '').split(path.delimiter).filter(Boolean);
  dirs.push(path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'), path.join(home, '.npm-global', 'bin'),
    '/opt/homebrew/bin', '/usr/local/bin');
  try {
    const nvm = path.join(home, '.nvm', 'versions', 'node');
    fs.readdirSync(nvm).forEach(version => dirs.push(path.join(nvm, version, 'bin')));
  } catch { /* nvm 없음 */ }
  return [...new Set(dirs)];
}
function claudeInstalled(pathValue = process.env.PATH, home = os.homedir()) {
  return claudeCandidateDirs(pathValue, home)
    .some((dir) => { try { return fs.statSync(path.join(dir, 'claude')).isFile(); } catch { return false; } });
}

// 앱 자동화(run-task.sh)가 어느 Claude 계정으로 도는지 — 점검하기의 `앱 자동화가 쓰는 Claude 계정` 줄.
// run-task.sh와 같은 순서다: ① 앱에 붙여 넣은 토큰 파일(공백을 빼고 한 글자라도 있으면) ② 이 맥 Claude Code의 기본 로그인
// (run-task.sh는 CLAUDE_CONFIG_DIR을 주지 않으므로 기본 설정 파일 `~/.claude.json`의 `oauthAccount`).
// 프로세스를 띄우지 않고 바깥에 묻지 않는다 — 파일 두 개만 읽는다. 토큰 값은 있는지만 보고, 이메일은 이 안에서 가린 꼴
// (`a***@e***.com`)로만 내보낸다. 토큰만으로는 어느 계정인지 알 수 없어 그쪽은 출처만 준다.
const CLAUDE_GLOBAL_CONFIG_MAX = 50 * 1024 * 1024;
function maskEmail(value) {
  const match = /^([^\s@]+)@([^\s@]+)$/.exec(trimmed(value));
  if (!match) return '';
  const labels = match[2].split('.');
  const tld = labels.length > 1 ? labels.pop() : '';
  if (!labels[0]) return '';
  return `${[...match[1]][0]}***@${[...labels[0]][0]}***${tld ? `.${tld}` : ''}`;
}
function claudeAccountSource({ tokenFile, globalConfigFile } = {}) {
  if (readToken(tokenFile)) return { source: 'token' };
  let account = null;
  try {
    const file = expandHome(globalConfigFile);
    if (fs.statSync(file).size <= CLAUDE_GLOBAL_CONFIG_MAX) {
      const oauth = JSON.parse(fs.readFileSync(file, 'utf8')).oauthAccount;
      if (oauth && typeof oauth === 'object') account = oauth;
    }
  } catch { /* 파일 없음·읽을 수 없음 — 로그인 기록 없음으로 본다 */ }
  if (!account) return { source: 'none' };
  const masked = maskEmail(account.emailAddress);
  return masked ? { source: 'default', account: masked } : { source: 'default' };
}

module.exports = {
  SLACK_CHANNEL_KEYS, SLACK_APPS_URL, INTEGRATION_MESSAGE: MESSAGE,
  tokenPaths, parseChannelId, slackCheckChannel, slackCreateChannel, readIntegrations, saveIntegrations,
  scheduleRestart, errorLines, maskLine, claudeInstalled, claudeCandidateDirs, claudeAccountSource, maskEmail, writeTokenFile,
  slackTokenCheck, savedSlackToken, slackTokenForUse, saveSlackAuth, slackAuthMode, writeConfig, mergeConfig, createSlackNameFollower, SLACK_FOLLOW_MS, slackChannelPrefix, slackTsNow,
  normalizeIcalUrl, fetchIcal, icalCheck, savedIcalUrl, ICAL_TIMEOUT_MS, savePersonalize, registrationKey,
  normalizeJiraSite, saveClaudeToken, CLAUDE_TOKEN_MAX, bodyReadError,
};

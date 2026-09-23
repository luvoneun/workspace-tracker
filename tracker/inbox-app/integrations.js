// 연동 설정(설정 > 연동)이 쓰는 서버 쪽 한 벌 — 값 확인, `workspace.config.json` 합치기,
// 토큰 파일 쓰기, 문제 보고에 실을 오류 줄 고르기.
//
// 여기만 `workspace.config.json`을 고친다(DECISIONS 2026-09-23). 규칙 셋:
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

const SLACK_CHANNEL_KEYS = ['todo', 'align', 'someday', 'waiting'];
const SLACK_TIMEOUT_MS = 8000;

const MESSAGE = {
  jiraSite: '지라 주소는 https://로 시작해야 해요',
  jiraEmail: '지라 계정 이메일을 적어 주세요',
  jiraToken: 'API 토큰을 붙여 넣어 주세요',
  jiraAuth: '지라에서 이 토큰으로 로그인하지 못했어요',
  slackToken: '슬랙 토큰을 붙여 넣어 주세요',
  slackChannel: '슬랙 채널 링크나 ID를 붙여 넣어 주세요',
  slackRead: '슬랙에서 이 채널을 읽지 못했어요 — 토큰과 채널을 확인해 주세요',
  slackPublic: '공개 채널이에요 — 나만 보는 채널을 권해요',
  other: '보낸 값을 확인해 주세요.',
};

function bad(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

const trimmed = value => (typeof value === 'string' ? value.trim() : '');
const expandHome = value => String(value || '').replace(/^~(?=\/|$)/, os.homedir());

// 토큰을 둘 자리. 테스트·픽스처는 `WORKSPACE_TOKEN_DIR`로 임시 폴더를 끼워 실제 `~/.config`를
// 건드리지 않는다. 기본 자리일 때만 config에 `~/…` 꼴로 적는다(사람이 읽기 좋게).
function tokenPaths(tokenDir) {
  const custom = trimmed(tokenDir || process.env.WORKSPACE_TOKEN_DIR);
  const dir = custom || path.join(os.homedir(), '.config');
  const shape = name => (custom ? path.join(dir, name) : `~/.config/${name}`);
  return {
    dir,
    jira: { file: path.join(dir, 'workspace-jira-token'), config: shape('workspace-jira-token') },
    slack: { file: path.join(dir, 'workspace-slack-token'), config: shape('workspace-slack-token') },
  };
}

function hasToken(file) {
  try { return String(fs.readFileSync(expandHome(file), 'utf8') || '').trim().length > 0; } catch { return false; }
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
    throw bad(MESSAGE.slackRead);
  }
  if (!body || body.ok !== true || !body.channel) throw bad(MESSAGE.slackRead);
  return { name: String(body.channel.name || ''), isPrivate: body.channel.is_private === true };
}

// ---------- config 합치기 ----------
// 아는 칸만 갈아 끼우고 나머지는 들어온 그대로 돌려준다.
function clone(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function withJira(config, { enabled, siteUrl, email, tokenFile }) {
  const next = { ...config };
  next.integrations = { ...clone(config.integrations), jira: enabled };
  if (siteUrl !== undefined || email !== undefined || tokenFile !== undefined) {
    const jira = clone(config.jira);
    if (siteUrl !== undefined) jira.siteUrl = siteUrl;
    if (email !== undefined) jira.email = email;
    if (tokenFile !== undefined) jira.tokenFile = tokenFile;
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
      Object.entries(channels).forEach(([key, value]) => { merged[key] = { ...clone(merged[key]), ...value }; });
      slack.channels = merged;
    }
    next.slack = slack;
  }
  return next;
}

function withCalendar(config, enabled) {
  return { ...config, integrations: { ...clone(config.integrations), calendar: enabled } };
}

// 회의록은 켜고 끄는 값(`integrations.tiro`)과 "무엇으로 쓰는지"(`meetingNotes`) 둘을 함께 적는다.
function withMeetingNotes(config, mode, name) {
  const next = { ...config, integrations: { ...clone(config.integrations), tiro: mode === 'tiro' } };
  next.meetingNotes = mode === 'other' ? { other: name } : mode;
  return next;
}

// 화면이 읽는 지금 상태. 토큰은 있음/없음만 싣는다.
function readIntegrations(config, { tokenDir, claude } = {}) {
  const uses = clone(config.integrations);
  const jira = clone(config.jira);
  const slack = clone(config.slack);
  const paths = tokenPaths(tokenDir);
  const notes = config.meetingNotes;
  const mode = notes && typeof notes === 'object' && typeof notes.other === 'string'
    ? 'other'
    : (notes === 'tiro' || notes === 'manual' ? notes : (uses.tiro === true ? 'tiro' : 'manual'));
  const channels = clone(slack.channels);
  return {
    jira: {
      enabled: uses.jira === true,
      siteUrl: trimmed(jira.siteUrl),
      email: trimmed(jira.email),
      hasToken: hasToken(jira.tokenFile || paths.jira.config),
    },
    slack: {
      enabled: uses.slack === true,
      workspaceUrl: trimmed(slack.workspaceUrl),
      hasToken: hasToken(slack.tokenFile || paths.slack.config),
      channels: Object.fromEntries(SLACK_CHANNEL_KEYS.map((key) => {
        const entry = clone(channels[key]);
        return [key, { id: trimmed(entry.id), name: trimmed(entry.name) }];
      })),
    },
    calendar: { enabled: uses.calendar === true },
    meetingNotes: { mode, name: mode === 'other' ? trimmed(notes.other) : '' },
    claude: claude === true,
  };
}

// ---------- 저장 ----------
// 한 번에 하나(또는 여럿)를 켜고 끈다. 켜는 쪽은 먼저 **읽어 보고** 성공했을 때만 저장한다.
// 저장은 config 한 번 + 토큰 파일뿐이고, 실패하면 아무것도 쓰지 않는다.
async function saveIntegrations({
  configPath, current = {}, body = {}, tokenDir,
  jiraCheck, slackCheck, write = atomicWrite, writeToken = writeTokenFile,
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
      if (!token && !hasToken(paths.jira.file)) throw bad(MESSAGE.jiraToken);
      const secret = token || String(fs.readFileSync(paths.jira.file, 'utf8')).trim();
      const account = await (jiraCheck || (() => { throw bad(MESSAGE.jiraAuth); }))({ siteUrl, email, token: secret });
      if (!account || !account.ok) throw bad(MESSAGE.jiraAuth);
      if (token) pending.push([paths.jira.file, token]);
      config = withJira(config, { enabled: true, siteUrl, email, tokenFile: paths.jira.config });
      result.jira = { displayName: String(account.displayName || '') };
    }
  }

  if (body.slack && typeof body.slack === 'object') {
    touched = true;
    if (body.slack.enabled === false) {
      config = withSlack(config, { enabled: false });
    } else {
      const token = trimmed(body.slack.token);
      if (!token && !hasToken(paths.slack.file)) throw bad(MESSAGE.slackToken);
      const secret = token || String(fs.readFileSync(paths.slack.file, 'utf8')).trim();
      const asked = body.slack.channels && typeof body.slack.channels === 'object' ? body.slack.channels : {};
      const wanted = SLACK_CHANNEL_KEYS.filter(key => trimmed(asked[key]));
      // `todo` 채널은 슬랙 수집의 기본 자리라 하나는 있어야 한다(이미 저장돼 있으면 그대로 쓴다).
      const savedTodo = trimmed(clone(clone(clone(config.slack).channels).todo).id);
      if (!wanted.includes('todo') && !savedTodo) throw bad(MESSAGE.slackChannel);
      const channels = {};
      result.slack = { channels: {} };
      for (const key of wanted) {
        const id = parseChannelId(asked[key]);
        if (!id) throw bad(MESSAGE.slackChannel);
        const info = await (slackCheck || (() => { throw bad(MESSAGE.slackRead); }))(secret, id);
        channels[key] = { id, name: info.name ? `#${info.name}` : '' };
        result.slack.channels[key] = { name: channels[key].name, isPrivate: info.isPrivate === true };
      }
      if (token) pending.push([paths.slack.file, token]);
      const workspaceUrl = trimmed(body.slack.workspaceUrl);
      config = withSlack(config, {
        enabled: true, tokenFile: paths.slack.config, channels,
        ...(workspaceUrl ? { workspaceUrl } : {}),
      });
    }
  }

  if (body.calendar && typeof body.calendar === 'object') {
    touched = true;
    config = withCalendar(config, body.calendar.enabled === true);
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
  SLACK_CHANNEL_KEYS, INTEGRATION_MESSAGE: MESSAGE,
  tokenPaths, parseChannelId, slackCheckChannel, readIntegrations, saveIntegrations,
  scheduleRestart, errorLines, maskLine, claudeInstalled, writeTokenFile,
};

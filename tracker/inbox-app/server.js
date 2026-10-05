const http = require('http');
const nativeFs = require('fs');
const { atomicWrite } = require('./safe-storage');
let readScope = null;
const fs = { ...nativeFs, readFileSync: (file,encoding) => {
  if(!readScope || typeof file!=='string')return nativeFs.readFileSync(file,encoding);
  const key=`${file}:${encoding || 'buffer'}`;
  if(!readScope.files.has(key))readScope.files.set(key,nativeFs.readFileSync(file,encoding));return readScope.files.get(key);
}, writeFileSync: atomicWrite, appendFileSync: (file, data) => atomicWrite(file, (nativeFs.existsSync(file) ? nativeFs.readFileSync(file, 'utf8') : '') + data) };
const path = require('path');
const os = require('os');
const { exec, execFile } = require('child_process');
const { DATA_FORMAT_VERSION, readDataVersion, TOO_NEW_MESSAGE } = require('./migrate');
// 설정 > 연동이 쓰는 한 벌(값 확인·config 합치기·토큰 파일·문제 보고의 오류 줄).
const integrations = require('./integrations');
const slackAuth = require('./slack-auth');
const { TRANSIENT_MARK: SLACK_TRANSIENT_MARK, MANUAL_MARK: SLACK_MANUAL_MARK } = require('./slack-history');
// 설정 › 꾸미기(앱 아이콘·앱 이름·제목 — 이 맥에만).
const personalize = require('./personalize');
// 쉬운 말 소식(WP-J) — 소식.md 파서 + 원격(태그) 소식.md 읽기.
const { parseNews, fetchRemoteNewsText, NEWS_MAX_VERSIONS } = require('./news');
// 캘린더 `맥 캘린더` 갈래 — 서버는 `허용하고 확인`·지금 가져오기의 요청 표시 파일과 결과 읽기(route)만 쓴다(읽기는 launchd).
const calendarMac = require('./calendar-mac');
const { randomBytes, createHash, timingSafeEqual } = require('node:crypto');

// 사람/회사마다 달라지는 값은 전부 workspace.config.json 한 곳에 모아둔다.
// 다른 맥이나 다른 회사에서 쓸 때 이 파일만 갈아끼우면 된다.
const CONFIG_PATH = process.env.WORKSPACE_CONFIG || path.join(__dirname, '../../workspace.config.json');
const TRACKER_DIR = process.env.WORKSPACE_DATA_DIR || path.join(__dirname, '..');
// 코드 저장소의 뿌리(VERSION·git 기록이 있는 곳). 앱은 이 저장소를 그대로 clone해서 쓴다.
const REPO_DIR = process.env.WORKSPACE_REPO_DIR || path.join(__dirname, '..', '..');
// 이 컴퓨터에만 두는 폴더(`local/` — 업데이트해도 남는다). 테스트·픽스처는 WORKSPACE_LOCAL_DIR(또는 WORKSPACE_REPO_DIR)로 임시 폴더를 끼운다.
const LOCAL_DIR = process.env.WORKSPACE_LOCAL_DIR || path.join(REPO_DIR, 'local');
// 사용자의 앱 폴더(`~/Applications`). 서버는 이 폴더를 읽지도 쓰지도 않는다 — 픽스처 안전망(아래 workspacePaths)이 실제 자리를 가리키지 않는지만 본다.
function applicationsDir() {
  return process.env.WORKSPACE_APPLICATIONS_DIR || path.join(os.homedir(), 'Applications');
}
// 업무 데이터 백업 폴더(`~/workspace-data-backup` — update.sh·backup-data.sh와 같은 값). 서버는 **읽기만** 한다
// (설정 › 앱의 `데이터 백업` 줄). 테스트·픽스처는 WORKSPACE_BACKUP_DIR로 임시 폴더를 끼운다.
function backupDir() {
  return process.env.WORKSPACE_BACKUP_DIR || path.join(os.homedir(), 'workspace-data-backup');
}

// ---------- 화면 확인용 픽스처의 안전망 ----------
// `WORKSPACE_FIXTURE=1`(browser-fixture.js가 켠다)이면 서버가 쓰는 자리가 하나라도 실제 설치 위치
// (`~/.config`·`~/.local/share/workspace-automation`·`~/Library/LaunchAgents`·`~/Applications`·이 저장소의
// `workspace.config.json`·`local/`·`tracker/`)이거나 그 위(홈 폴더 등)를 가리키면 시작하지 않는다.
// 아래 판단은 경로 글자만 본다 — 설정 파일도 그 자리가 안전할 때만 읽어 토큰 경로 칸을 확인한다.
function workspacePaths() {
  return {
    config: CONFIG_PATH, data: TRACKER_DIR, repo: REPO_DIR, local: LOCAL_DIR,
    tokens: integrations.tokenPaths().dir, automation: automationDir(), launchAgents: launchAgentsDir(), applications: applicationsDir(),
    backup: backupDir(),
  };
}
// 없는 경로도 견줄 수 있게, 있는 데까지 실제 경로(심볼릭 링크를 푼 것)로 바꾸고 나머지를 붙인다.
function realishPath(value) {
  let at = path.resolve(String(value || ''));
  const rest = [];
  for (;;) {
    try { return path.join(nativeFs.realpathSync(at), ...rest); } catch { /* 위로 */ }
    const up = path.dirname(at);
    if (up === at) return path.join(at, ...rest);
    rest.unshift(path.basename(at));
    at = up;
  }
}
const insidePath = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
function fixtureSafetyProblems(paths = workspacePaths(), home = os.homedir()) {
  // 홈·저장소 뿌리만 실제 경로로 풀고(심볼릭 링크 대비) 그 아래 자리는 글자로 붙인다 — 실제 설치 위치 자체는 열어 보지 않는다.
  const homeReal = realishPath(home);
  const repoRoot = realishPath(path.join(__dirname, '..', '..'));
  const real = [
    ['~/.config', path.join(homeReal, '.config')],
    ['~/.local/share/workspace-automation', path.join(homeReal, '.local', 'share', 'workspace-automation')],
    ['~/Library/LaunchAgents', path.join(homeReal, 'Library', 'LaunchAgents')],
    ['~/Applications', path.join(homeReal, 'Applications')],
    ['~/workspace-data-backup', path.join(homeReal, 'workspace-data-backup')],
    ['저장소의 workspace.config.json', path.join(repoRoot, 'workspace.config.json')],
    ['저장소의 local/', path.join(repoRoot, 'local')],
    ['저장소의 tracker/', path.join(repoRoot, 'tracker')],
  ];
  const problems = [];
  for (const [name, value] of Object.entries(paths)) {
    if (!value) { problems.push(`${name}: 경로가 비어 있어요`); continue; }
    const at = realishPath(value);
    const hit = real.find(([, where]) => insidePath(at, where) || insidePath(where, at));
    if (hit) problems.push(`${name}: ${at} — 실제 ${hit[0]} 자리예요`);
  }
  // 설정 파일이 안전한 자리일 때만 열어, 토큰·비밀 주소 파일 칸이 실제 ~/.config를 가리키지 않는지 본다.
  if (paths.config && !problems.some(line => line.startsWith('config:'))) {
    let config = {};
    try { config = JSON.parse(nativeFs.readFileSync(paths.config, 'utf8')); } catch { config = {}; }
    const files = { 'slack.tokenFile': config.slack?.tokenFile, 'jira.tokenFile': config.jira?.tokenFile, 'calendar.icalFile': config.calendar?.icalFile };
    for (const [key, file] of Object.entries(files)) {
      if (typeof file !== 'string' || !file.trim()) continue;
      const at = realishPath(file.trim().replace(/^~(?=\/|$)/, home));
      if (insidePath(at, real[0][1])) problems.push(`config ${key}: ${at} — 실제 ~/.config 자리예요`);
    }
  }
  return problems;
}
if (process.env.WORKSPACE_FIXTURE === '1') {
  const problems = fixtureSafetyProblems();
  if (problems.length) {
    console.error('화면 확인용 픽스처가 실제 설치 위치를 가리켜서 시작하지 않아요:');
    problems.forEach(line => console.error(`  - ${line}`));
    process.exit(1);
  }
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

const CONFIG = loadConfig();
// 안 쓰는 도구는 꺼둔다. 꺼진 도구는 "동기화 안 됨" 경고를 띄우지 않는다.
const USES = { slack: true, calendar: true, jira: true, tiro: true, ...(CONFIG.integrations || {}) };
// 캘린더를 비밀 주소(iCal)로 앱이 직접 읽는지(설정 > 연동 > 캘린더). 켜고 끄는 값처럼 서버가 뜰 때 읽는다.
const CALENDAR_ICAL = USES.calendar !== false && !!CONFIG.calendar && CONFIG.calendar.source === 'ical';
// 맥 캘린더 앱에서 읽는 갈래인지 — launchd `mac-calendar`가 calendar_today.md를 쓰고, 기록은 `mac-calendar.log`다(calendar-mac.js).
const CALENDAR_MAC = USES.calendar !== false && !!CONFIG.calendar && CONFIG.calendar.source === 'mac';
// 화면 헤더·탭 제목. 설정 › 꾸미기에서 바꾸면 이 값도 곧바로 바꾼다(서버를 다시 켜지 않아도 된다).
let APP_TITLE = CONFIG.title || '내 워크스페이스';
// 헤더의 제목만 숨기는 스위치(설정 › 꾸미기 `화면에 보이기`). 제목 값 자체(APP_TITLE)는 그대로 두고
// 화면·탭 이름(document.title)에는 계속 쓴다 — 감추는 건 `#workspaceTitle` 하나뿐이다. 값이 없으면(옛 설치) 보이기.
let TITLE_HIDDEN = CONFIG.titleHidden === true;

const PORT = Number(process.env.WORKSPACE_PORT || CONFIG.server?.port || 4321);
// localhost는 항상 열고, extraHost가 있으면 그 주소로도 추가로 연다 (폰·다른 기기용).
const EXTRA_HOST = process.env.WORKSPACE_HOST || CONFIG.server?.extraHost || '';
const PUBLIC_DIR = __dirname;
const ACCESS_TOKEN_PATH = path.join(TRACKER_DIR, '.access-token');
function remoteAuthorized(req) {
  const address=req.socket.remoteAddress;
  if(['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address))return true;
  if(!nativeFs.existsSync(ACCESS_TOKEN_PATH))return false;
  const expected=nativeFs.readFileSync(ACCESS_TOKEN_PATH,'utf8').trim();
  if(expected.length<32)return false;
  const header=req.headers.authorization || '';
  const supplied=header.startsWith('Basic ')?Buffer.from(header.slice(6),'base64').toString().split(':').slice(1).join(':'):header.startsWith('Bearer ')?header.slice(7):'';
  const a=Buffer.from(expected),b=Buffer.from(supplied);return a.length===b.length && timingSafeEqual(a,b);
}
function idempotent(req, payload, action) {
  const key=req.headers['idempotency-key'];
  if(!key)return mutations.run(action);
  if(!/^[a-zA-Z0-9-]{16,100}$/.test(key))throw new Error('요청 식별자를 확인해 주세요.');
  return mutations.run(()=>{
    const file=path.join(TRACKER_DIR,'.request-ledger.json');
    const entries=nativeFs.existsSync(file)?JSON.parse(nativeFs.readFileSync(file,'utf8')):{};
    const digest=createHash('sha256').update(req.url+JSON.stringify(payload)).digest('hex');
    if(entries[key]) {if(entries[key].digest!==digest)throw new Error('다른 내용으로 같은 요청을 다시 쓸 수 없어요.');return entries[key].result;}
    const result=action();entries[key]={digest,result};
    const retained=Object.fromEntries(Object.entries(entries).slice(-1000));atomicWrite(file,JSON.stringify(retained));return result;
  });
}

const TRACK_RE = /^- (.+?) #(task|bug|idea|decision|check)\[(.+)\]\s*$/;

const ULID_ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function encodeTime(now, len) {
  let str = '';
  for (let i = len - 1; i >= 0; i--) {
    const mod = now % 32;
    str = ULID_ENCODING[mod] + str;
    now = (now - mod) / 32;
  }
  return str;
}
function ulid() {
  let random = '';
  for (let i = 0; i < 16; i++) random += ULID_ENCODING[Math.floor(Math.random() * 32)];
  return encodeTime(Date.now(), 10) + random;
}

function todayLocal() {
  const d = new Date();
  const offset = d.getTimezoneOffset() * 60000;
  return new Date(d - offset).toISOString().slice(0, 10);
}

// ---------- 오늘 캘린더 일정 (tracker/calendar_today.md) ----------

const CALENDAR_ITEM_RE = /^- (\d{2}:\d{2})-(\d{2}:\d{2}) \| (.+?)(?: \| (\S+))?$/;

function getCalendarToday() {
  if (!USES.calendar) return { events: [], lastSync: null, used: false };
  // 비밀 주소로 앱이 직접 읽은 게 있으면 그게 기준이다 — 스냅샷 파일은 보지 않는다(지라와 같은 우선순위).
  const live = CALENDAR_ICAL ? calendarLive.current() : null;
  if (live) return { events: live.events, lastSync: todayLocal(), stale: false, live: true, liveAt: new Date(live.at).toISOString() };
  const calPath = path.join(TRACKER_DIR, 'calendar_today.md');
  // 한 번도 읽지 않은 것(`neverRead`)은 늦은 것이 아니라 첫 읽기를 기다리는 것이다 — 톱니바퀴·연동 탭이 같이 본다.
  if (!fs.existsSync(calPath)) {
    const neverRead = !CALENDAR_ICAL || !calendarLive.history().length;
    return { events: [], lastSync: null, stale: true, ...(neverRead ? { neverRead: true } : {}) };
  }
  const lines = fs.readFileSync(calPath, 'utf-8').split('\n');
  const events = [];
  let lastSync = null;
  lines.forEach((line) => {
    if (line.startsWith('마지막 갱신:')) {
      const value = line.replace('마지막 갱신:', '').trim();
      lastSync = value && value !== '-' ? value : null;
      return;
    }
    const externalId = line.match(/ \| id:(\S+)$/)?.[1];
    const m = line.replace(/ \| id:\S+$/, '').match(CALENDAR_ITEM_RE);
    if (!m) return;
    events.push({ start: m[1], end: m[2], title: m[3], link: m[4] || null, ...(externalId ? {externalId} : {}) });
  });
  const date = lastSync && lastSync.slice(0, 10);
  return { events: date === todayLocal() ? events : [], lastSync, stale: date !== todayLocal() };
}

// ---------- 트랙 아이템 (tracker/*.md, source:slack: 태그) ----------

function parseFields(fieldStr) {
  const fields = {};
  fieldStr.split(/\s+/).forEach((tok) => {
    const idx = tok.indexOf(':');
    if (idx === -1) return;
    fields[tok.slice(0, idx)] = tok.slice(idx + 1);
  });
  return fields;
}

function listTrackerFiles() {
  return fs
    .readdirSync(TRACKER_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => path.join(TRACKER_DIR, f));
}

// 슬랙에서 캡처됐지만 아직 화면에 한 번도 안 뜬 항목인지 — "NEW" 표시용
function isNewSlack(fields) {
  return !!(fields.source && fields.source.startsWith('slack:') && fields.seen !== 'true');
}

// Legacy items use due as their planned day until explicitly rescheduled.
// "none" distinguishes an unscheduled task from an unmigrated legacy task.
function plannedDay(fields) {
  return fields.scheduled === 'none' ? null : fields.scheduled || fields.due || null;
}

// 미완료 할 일이 오늘 목록에 서는가: 실행 예정일이 오늘·지났거나, **기한이 오늘·지났다**.
// 기한으로 들어온 것은 보여 주기만 한다(scheduled를 써 넣지 않는다) — 기한을 지우거나 미루면 원래 자리로 돌아간다.
// 아직 받지 않은 슬랙 항목(inbox)은 부르는 쪽이 먼저 거른다(새로 들어온 것에 그대로 남는다).
function isOpenTaskForToday(fields, today) {
  const scheduled = plannedDay(fields);
  return !!(scheduled && scheduled <= today) || !!(fields.due && fields.due <= today);
}

// "나중에 할 일" — 오늘 목록에 서지 않는 미완료 할 일(실행 예정일이 없거나 미래이고, 기한도 없거나 미래)
function getLaterTasks() {
  const today = todayLocal();
  const items = [];
  listTrackerFiles().forEach((filePath) => {
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    lines.forEach((line) => {
      const m = line.match(TRACK_RE);
      if (!m || m[2] !== 'task') return;
      const fields = parseFields(m[3]);
      if (fields.status === 'done' || fields.inbox === 'true') return;
      const scheduled = plannedDay(fields);
      if (isOpenTaskForToday(fields, today)) return;
      items.push({
        file: path.basename(filePath),
        description: m[1],
        type: m[2],
        id: fields.id,
        status: fields.status || 'to-do',
        priority: fields.priority || 'medium',
        created: fields.created,
        due: fields.due || null,
        scheduled,
        doing: fields.doing || null,
        permalink: fields.source && fields.source.startsWith('slack:') ? fields.source.slice('slack:'.length) : null,
        jira: fields.jira || null,
        group: fields.group ? fields.group.replace(/_/g, ' ') : null,
        isNew: isNewSlack(fields),
      });
    });
  });
  return items;
}

// "오늘 할 일" — 실행 예정일이나 기한이 오늘·지난 미완료 할 일(밀린 것은 저절로 따라온다) + 오늘 끝낸 할 일
function getTodayTasks() {
  const today = todayLocal();
  const items = [];
  listTrackerFiles().forEach((filePath) => {
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    lines.forEach((line) => {
      const m = line.match(TRACK_RE);
      if (!m || m[2] !== 'task') return;
      const fields = parseFields(m[3]);
      if (fields.inbox === 'true' && fields.status !== 'done') return;
      const scheduled = plannedDay(fields);
      const completedDate = fields.completed || (fields.updated ? localDateOf(fields.updated) : fields.due);
      if (fields.status === 'done' ? completedDate !== today : !isOpenTaskForToday(fields, today)) return;
      items.push({
        file: path.basename(filePath),
        description: m[1],
        type: m[2],
        id: fields.id,
        status: fields.status || 'to-do',
        priority: fields.priority || 'medium',
        created: fields.created,
        due: fields.due,
        scheduled,
        doing: fields.doing || null,
        permalink: fields.source && fields.source.startsWith('slack:') ? fields.source.slice('slack:'.length) : null,
        jira: fields.jira || null,
        group: fields.group ? fields.group.replace(/_/g, ' ') : null,
        isNew: isNewSlack(fields),
      });
    });
  });
  return items;
}

function setTrackField(id, fieldName, rawValue, matchType) {
  validateFields({ [fieldName]: rawValue });
  const value = rawValue ? rawValue.trim().replace(/\s+/g, '_') : null;
  const re = new RegExp(`${fieldName}:\\S+`);
  let changed = false;
  listTrackerFiles().forEach((filePath) => {
    if (changed) return;
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    let fileChanged = false;
    const newLines = lines.map((line) => {
      const m = line.match(TRACK_RE);
      if (!m) return line;
      if (matchType && m[2] !== matchType) return line;
      const fields = parseFields(m[3]);
      if (fields.id !== id) return line;
      let newFieldStr = m[3];
      if (value && (fieldName === 'jira' || fieldName === 'group')) {
        const other = fieldName === 'jira' ? 'group' : 'jira';
        newFieldStr = newFieldStr.split(/\s+/).filter(token => !token.startsWith(`${other}:`)).join(' ');
      }
      if (!value) {
        newFieldStr = newFieldStr
          .split(/\s+/)
          .filter((tok) => !tok.startsWith(`${fieldName}:`))
          .join(' ');
      } else if (re.test(newFieldStr)) {
        newFieldStr = newFieldStr.replace(re, () => `${fieldName}:${value}`);
      } else {
        newFieldStr = `${newFieldStr} ${fieldName}:${value}`;
      }
      fileChanged = true;
      return `- ${m[1]} #${m[2]}[${newFieldStr}]`;
    });
    if (fileChanged) {
      fs.writeFileSync(filePath, newLines.join('\n'));
      changed = true;
    }
  });
  return changed;
}

function setTrackJira(id, jiraKey) {
  return setTrackField(id, 'jira', jiraKey, null);
}

function setTrackGroup(id, group) {
  return setTrackField(id, 'group', group, null);
}

function setIdeaProject(id, project) {
  return setTrackField(id, 'project', project, 'idea');
}

function setTrackDue(id, due) {
  validateDate(due);
  // Preserve the existing planned day when changing a legacy task's deadline.
  for (const filePath of listTrackerFiles()) {
    const match = fs.readFileSync(filePath, 'utf-8').split('\n').map(line => line.match(TRACK_RE))
      .find(m => m && m[2] === 'task' && parseFields(m[3]).id === id);
    if (match) {
      const fields = parseFields(match[3]);
      if (!fields.scheduled) setTrackField(id, 'scheduled', plannedDay(fields) || 'none', 'task');
      break;
    }
  }
  return setTrackField(id, 'due', due, null);
}

function validateDescription(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 1000 || /[\r\n]/.test(value)) throw new Error('내용은 1,000자 이내 한 줄로 입력해 주세요.');
}

function validateFields(fields) {
  for (const [key, value] of Object.entries(fields)) {
    if (value == null || value === '') continue;
    if (typeof value !== 'string' || value.length > 250 || /[\r\n\[\]]/.test(value)) throw new Error(`${key}: 올바른 값을 입력해 주세요.`);
    if (key === 'priority' && !['low','medium','high','critical'].includes(value)) throw new Error('우선순위를 확인해 주세요.');
    if (key === 'jira' && !/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(value)) throw new Error('지라 번호를 확인해 주세요.');
  }
}

function validateDate(value) {
  if (value == null || value === '') return;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
    throw new Error('유효한 날짜를 선택해 주세요.');
  }
}

function localDateOf(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : fmtDate(date);
}

function setTrackPriority(id, priority) {
  return setTrackField(id, 'priority', priority, null);
}

function setTrackWho(id, who) {
  return setTrackField(id, 'who', who, 'check');
}

// "지금 하는 중" 표시. 시작한 날을 같이 남겨서 "N일째 진행 중"을 보여줄 수 있게 한다.
function setTrackDoing(id, on) {
  return setTrackField(id, 'doing', on ? todayLocal() : null, 'task');
}

function setTrackDescription(id, description) {
  validateDescription(description);
  if (!description || !description.trim()) return false;
  let changed = false;
  listTrackerFiles().forEach((filePath) => {
    if (changed) return;
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    let fileChanged = false;
    const newLines = lines.map((line) => {
      const m = line.match(TRACK_RE);
      if (!m) return line;
      const fields = parseFields(m[3]);
      if (fields.id !== id) return line;
      fileChanged = true;
      return `- ${description.trim()} #${m[2]}[${m[3]}]`;
    });
    if (fileChanged) {
      fs.writeFileSync(filePath, newLines.join('\n'));
      changed = true;
    }
  });
  return changed;
}

// ---------- 지라 이슈 캐시 (tracker/jira_issues.md) ----------

const JIRA_ITEM_RE = /^- (\S+) \| (.+?) \| (.+?) \| (.+)$/;
// 지라 동기화가 "업무에 연결돼 있는데 기본 조회(내 담당·미완료)에서 빠진 이슈"를 적는 구역.
// 줄 형식은 기본 구역과 같아서 이 제목을 모르는 옛 서버가 읽어도 그냥 이슈 한 줄로 읽힌다.
const JIRA_EXTRA_HEADING = '## 업무에 연결된 그 밖의 이슈';

// 지라 캐시가 언제 갱신됐는지. 자동 갱신이 실패해도 화면엔 낡은 목록이 그대로 뜨기 때문에,
// 언제 기준인지 드러내서 낡은 걸 모른 채 고르는 일이 없게 한다.
// `connected`·`siteUrl`은 지라 직접 읽기 설정이 있는지와 그 주소다 — 화면이 `지라 티켓 연결` 줄을
// 세울지 정하고, 붙여 넣은 주소가 그 지라의 것인지 견주는 데 쓴다(토큰·이메일은 싣지 않는다).
function getJiraSync() {
  if (!USES.jira) return { used: false };
  const settings = { connected: jira.connected, siteUrl: JIRA_SITE_URL };
  // 앱이 직접 읽은 목록이 있으면 그게 기준이다 — 스냅샷 파일의 날짜로 낡음을 따지지 않는다
  // (그 파일은 대비책일 뿐이고, 화면의 `어제 기준` 경고는 대비책을 쓰는 동안에만 뜬다).
  const live = jiraLive.current();
  if (live) return { ...settings, live: true, liveAt: new Date(live.at).toISOString(), lastSync: todayLocal(), stale: false };
  const jiraPath = path.join(TRACKER_DIR, 'jira_issues.md');
  if (!fs.existsSync(jiraPath)) {
    // 연결은 됐는데 아직 한 번도 읽지 않았으면 첫 읽기를 기다리는 것이다(늦은 것이 아니다).
    const neverRead = !!jira.connected && !jiraLive.history().length;
    return { ...settings, lastSync: null, stale: true, ...(neverRead ? { neverRead: true } : {}) };
  }
  const line = fs
    .readFileSync(jiraPath, 'utf-8')
    .split('\n')
    .find((l) => l.startsWith('마지막 갱신:'));
  const value = line ? line.replace('마지막 갱신:', '').trim() : '';
  const lastSync = value && value !== '-' ? value.slice(0, 10) : null;
  return { ...settings, lastSync, stale: !lastSync || lastSync < todayLocal() };
}

// 슬랙 캡처는 가져올 게 없으면 아무 흔적도 남기지 않아서, 토큰이 만료돼 조용히 멈춰도
// 화면은 멀쩡해 보인다. 캡처 스킬이 매 실행마다 남기는 checkedAt으로 마지막 확인 시각을 본다.
// `connected`(토큰·켜진 채널까지 있는가 — 연동 탭 카드와 같은 기준)·`scheduled`(수집이 launchd에 등록됐는가 —
// 켠 연동 자동 등록(apply)이 있으면 곧 등록되므로 등록된 것으로 본다. 그 등록이 마지막에 실패했으면 아니다)·
// `neverRead`(한 번도 돈 흔적이 없음)는 톱니바퀴의 점과 연동 탭이 같은 판단을 하도록 함께 싣는다.
function getSlackSync() {
  if (!USES.slack) return { used: false };
  const statePath = path.join(process.env.WORKSPACE_DATA_DIR || __dirname, '.slack_capture_state.json');
  const scheduled = launchAgentInstalled('slack-capture') || (launchAgentInstalled('apply') && !applyLastFailure());
  // 쉬는 시간(9~19시 밖)이면 늦음·첫 읽기 전을 말하지 않는다(화면 syncLag) — 돌 차례가 아니다.
  const extra = { connected: slackConnectedNow(), scheduled, resting: slackCaptureResting() };
  if (!fs.existsSync(statePath)) return { lastSync: null, stale: true, neverRead: true, ...extra };
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    const lastSync = state.lastSuccessAt ? localDateOf(state.lastSuccessAt) : null;
    const neverRead = !state.lastSuccessAt && !state.lastError && !state.lastAttemptAt && !state.checkedAt;
    // 잠깐의 오류만으로 실패한 회차(수집 상태 글 끝에 표시)는 오류로 치지 않는다 — 이어지면 수집 카드의 실패(연속 3회차)가 말한다.
    const error = state.lastError && !String(state.lastError).endsWith(SLACK_TRANSIENT_MARK) ? state.lastError : null;
    return {
      lastSync, lastSuccessAt: typeof state.lastSuccessAt === 'string' ? state.lastSuccessAt : null,
      lastAttempt: state.lastAttemptAt || state.checkedAt || null, error,
      stale: !!error || !lastSync || lastSync < todayLocal(),
      ...(neverRead ? { neverRead: true } : {}), ...extra,
    };
  } catch {
    return { lastSync: null, stale: true, ...extra };
  }
}

// 슬랙 수집이 연결됐는가 — 연동 탭의 `settingsIntgConnected`(슬랙 카드)와 같은 기준: 켜짐 · 토큰 파일 · 켜진 채널 하나 이상(어느 채널이든).
// (`settingsIntgCounts`의 개수는 여기에 회의록 직접 옮기기를 더 센다 — 이 함수와는 상관없다.)
function slackConnectedNow() {
  try {
    const slack = integrations.readIntegrations(currentConfigFile(), { claude: false }).slack;
    return !!(slack.enabled && slack.hasToken && Object.values(slack.channels || {}).some(one => one && one.id));
  } catch { return false; }
}

// 자동화 폴더 — 앱 설치 스크립트가 항상 이 경로에 고정해서 쓴다.
// 테스트·화면 확인용 픽스처는 WORKSPACE_AUTOMATION_DIR로 임시 폴더를 끼워 실제 홈 폴더를 건드리지 않는다.
function automationDir() {
  return process.env.WORKSPACE_AUTOMATION_DIR || path.join(os.homedir(), '.local/share/workspace-automation');
}
function automationLogDir() {
  return path.join(automationDir(), 'logs');
}

function tailLines(filePath, maxLines) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf-8').split('\n').slice(-maxLines);
}

// 설정 › 연동 카드(상태 줄·최근 기록)가 쓴다. run-task.sh가 남기는 "───── 시각 이름 시작/종료(exit N)"
// 블록과, slack-capture.sh가 미리보기만 하고 건너뛸 때 남기는 한 줄짜리 기록을 함께 읽어서
// "마지막으로 뭘 했는지" 사람이 읽을 수 있는 요약과 "최근에 실패한 적 있는지"를 뽑아낸다.
// 줄 앞에 줄바꿈 없이 붙은 찌꺼기(`{"ok":true}` 같은 JSON 조각 — 예전 slack-capture.sh가 health 응답을 로그에
// 그대로 남겼다)를 떼어 낸다. 떼고 나서 시각(또는 실행 블록 선)으로 시작할 때만 떼어 낸 줄을 쓴다 — 이미 쌓인 옛 로그도
// "마지막 실행"을 제대로 읽게.
const LOG_JUNK_RE = /^(?:\{[^{}\n]*\}\s*)+(?=─|\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} )/;
const cleanLogLine = line => String(line).replace(LOG_JUNK_RE, '');

// 실행 블록의 시작 줄 — 끝의 `(v1.1.2)`는 그 회차를 돌린 앱 버전(VERSION 파일)이다. 옛 로그에는 없다.
const AUTOMATION_START_RE = /^─+ (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \S+ 시작(?: \(v([0-9A-Za-z.+-]{1,20})\))?$/;
// run-task.sh가 calendar-sync를 실패로 바꿀 때(0으로 끝났는데 캘린더 파일이 그대로) 남기는 줄. Claude의 답 뒤에 붙어
// 요약(200자)에서 잘리지 않게, 실패 블록에 이 줄이 있으면 이 줄을 요약으로 쓴다.
const CALENDAR_STALE_RE = /^⚠️ 캘린더 파일이 갱신되지 않았어요/;
function parseAutomationLog(lines) {
  const startRe = AUTOMATION_START_RE;
  const endRe = /^─+ (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \S+ 종료 \(exit (-?\d+)\)$/;
  const plainRe = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (.+)$/;
  const events = [];
  let block = null;
  lines.map(cleanLogLine).forEach((line) => {
    const s = startRe.exec(line);
    if (s) { block = { body: [], version: s[2] || null, start: s[1] }; return; }
    const e = endRe.exec(line);
    if (e) {
      const exitCode = Number(e[2]);
      const stale = exitCode !== 0 && block ? block.body.find(body => CALENDAR_STALE_RE.test(body)) : null;
      const text = stale || (block ? block.body.join(' ').replace(/\s+/g, ' ').trim() : '');
      const event = { time: e[1], kind: exitCode === 0 ? 'run' : 'fail', text: text || (exitCode === 0 ? '완료' : `실패 (exit ${exitCode})`) };
      if (block && block.version) event.version = block.version;
      if (block) event.start = block.start;
      events.push(event);
      block = null;
      return;
    }
    if (block) { block.body.push(line); return; }
    const p = plainRe.exec(line);
    if (p) events.push({ time: p[1], kind: p[2].includes('채널 확인 실패') ? 'fail' : 'skip', text: p[2], plain: true });
  });
  return events;
}

// 슬랙 수집의 실패 표시 — 블록의 **끝**에 붙은 것만 본다(메시지 내용에 같은 글이 섞여도 잘못 읽지 않게). 잠깐 오류 회차는
// 맺음 줄 `채널 N개 확인 실패 (잠깐 오류) — 다음 회차에 다시`로 끝날 때만이다 — 채널 줄 끝의 `(잠깐 오류)`는 다른 실패와 섞일 수 있어 세지 않는다.
const reEscape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SLACK_TRANSIENT_END_RE = new RegExp(`채널 \\d+개 확인 실패 ${reEscape(SLACK_TRANSIENT_MARK)} — 다음 회차에 다시(?: ${reEscape(SLACK_MANUAL_MARK)})?$`);
const SLACK_MANUAL_END_RE = new RegExp(`${reEscape(SLACK_MANUAL_MARK)}$`);
function getAutomationStatus() {
  const logDir = automationLogDir();
  const specs = [
    { key: 'slack', name: '슬랙 캡처', log: 'slack-capture.log', used: USES.slack },
    // 비밀 주소 갈래는 앱이 직접 읽으므로 이 자동화(calendar-sync)가 없다 — 목록에서 뺀다.
    { key: 'calendar', name: '캘린더 동기화', log: CALENDAR_MAC ? 'mac-calendar.log' : 'calendar-sync.log', used: USES.calendar && !CALENDAR_ICAL },
    // 지라 캐시 자동화(jira-sync)는 없앴다 — 앱이 지라를 직접 읽는다(DECISIONS 2026-09-24). 상태는
    // 이 자동화 목록이 아니라 화면(jira-ui.js의 jiraLiveStatusRow)이 자동화 목록 끝에 조용한 줄로 따로 그린다.
    // 일정표 없이 앱의 버튼을 눌렀을 때만 도는 자동화다(DECISIONS 2026-09-24). 상태·로그는 나머지와 같은 자리에서 본다.
    { key: 'tiro', name: '미팅 노트 가져오기', log: 'tiro-sync.log', used: USES.tiro },
  ];
  return specs.filter((s) => s.used).map((spec) => {
    const lines = tailLines(path.join(logDir, spec.log), 500);
    const events = parseAutomationLog(lines);
    const last = events[events.length - 1] || null;
    const recentFailures = events.filter((e) => e.kind === 'fail').slice(-5).reverse();
    // 가장 최근부터 이어진 실패의 시각(ms, 최근 것이 앞) — "계속 실패"(failStuck)의 재료.
    // **회차 단위로** 센다 — 슬랙 수집은 채널마다 `채널 확인 실패` 한 줄을 블록 앞에 따로 남기므로, 뒤따르는 실패 블록이
    // 시작된 뒤에 적힌 한 줄은 그 회차에 속한 것으로 보고 한 번만 센다(채널 둘이 한 회차에 실패해도 1번).
    // 그 회차들이 모두 잠깐의 오류였나(`failTransient`)와 가장 최근 실패 회차가 `지금 가져오기`였나(`failManual`)도 같이 —
    // 슬랙 수집이 실패 줄·블록 끝에 붙이는 표시(slack-history.js)로만 읽는다. 옛 로그(표시 없음)는 둘 다 false라 예전과 같다.
    const failTimes = [];
    let failTransient = false;
    let failManual = false;
    let runStart = null;
    for (let i = events.length - 1; i >= 0 && events[i].kind === 'fail'; i -= 1) {
      const event = events[i];
      if (event.plain && runStart && event.time >= runStart) continue;
      runStart = event.plain ? null : (event.start || null);
      const text = String(event.text || '');
      if (!failTimes.length) { failTransient = SLACK_TRANSIENT_END_RE.test(text); failManual = SLACK_MANUAL_END_RE.test(text); }
      else if (!SLACK_TRANSIENT_END_RE.test(text)) failTransient = false;
      failTimes.push(meetingNotesTime(event.time));
    }
    return {
      key: spec.key,
      name: spec.name,
      lastRunAt: last ? last.time : null,
      lastKind: last ? last.kind : null,
      lastSummary: last ? last.text : null,
      recentFailures,
      failTimes,
      failTransient,
      failManual,
      // 연동 카드 ⋯ › 최근 기록 — 최근 10번(새것 먼저). 한 줄은 200자까지만.
      events: events.slice(-10).reverse().map(e => ({ time: e.time, kind: e.kind, text: String(e.text || '').slice(0, 200), ...(e.version ? { version: e.version } : {}) })),
      tail: lines.map(cleanLogLine).filter((l) => l.trim()).slice(-60),
    };
  });
}

// ---------- 미팅 노트 가져오기 (티로) ----------
// 서버는 아무것도 실행하지 않는다. 요청 표시 파일 하나를 쓰고, 실행은 launchd 에이전트가
// 기존 run-task.sh로 한다(DECISIONS 2026-09-24). 진행 상태는 그 실행이 남긴 로그로만 읽는다.
const MEETING_NOTES_LOG = 'tiro-sync.log';
const MEETING_NOTES_START_GRACE_MS = 60 * 1000;   // 이 안에 시작 줄이 없으면 자동 실행이 등록되지 않은 것으로 본다
const MEETING_NOTES_RUN_LIMIT_MS = 35 * 60 * 1000; // run-task.sh의 30분 제한보다 넉넉하게
const MEETING_NOTES_NOT_REGISTERED = '자동 실행이 등록되지 않은 것 같아요. setup.sh를 다시 실행해 주세요.';

function meetingNotesRequestFile() {
  return path.join(automationDir(), 'requests', 'tiro-sync.request');
}

// 로그의 실행 블록을 시각과 함께 늘어놓는다. parseAutomationLog은 "끝난 블록"만 돌려주므로
// (형식은 그대로 둔다) 여기서 "시작 시각"과 "아직 끝나지 않은 블록"만 최소로 보탠다.
function meetingNotesRuns(lines) {
  const startRe = AUTOMATION_START_RE;
  const endRe = /^─+ (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \S+ 종료 \(exit (-?\d+)\)$/;
  const runs = [];
  let open = null;
  lines.map(cleanLogLine).forEach((line) => {
    const started = startRe.exec(line);
    if (started) { open = { startedAt: started[1], finishedAt: null, exitCode: null }; runs.push(open); return; }
    const ended = endRe.exec(line);
    if (!ended) return;
    if (!open) { open = { startedAt: null, finishedAt: null, exitCode: null }; runs.push(open); }
    open.finishedAt = ended[1];
    open.exitCode = Number(ended[2]);
    open = null;
  });
  return runs;
}

// 로그 시각(`YYYY-MM-DD HH:MM:SS`, 로컬)을 밀리초로. 로그는 초 단위라 요청 시각과 견줄 때 2초를 봐준다.
const meetingNotesTime = text => (text ? new Date(text.replace(' ', 'T')).getTime() : NaN);

function meetingNotesStatus() {
  if (!USES.tiro) return { used: false, state: 'off' };
  let request = null;
  try {
    const parsed = JSON.parse(nativeFs.readFileSync(meetingNotesRequestFile(), 'utf8'));
    if (parsed && typeof parsed === 'object' && typeof parsed.requestedAt === 'string') request = parsed;
  } catch { request = null; }
  const lines = tailLines(path.join(automationLogDir(), MEETING_NOTES_LOG), 500);
  const events = parseAutomationLog(lines);
  const blocks = events.filter(event => event.kind === 'run' || event.kind === 'fail');
  const summaryAt = time => (blocks.find(event => event.time === time) || {}).text || '';
  const last = blocks[blocks.length - 1] || null;
  const base = {
    used: true,
    state: 'idle',
    requestedAt: request ? request.requestedAt : null,
    scope: request && request.scope === 'meeting' ? 'meeting' : request ? 'today' : null,
    meeting: request && request.meeting ? request.meeting : null,
    startedAt: null,
    finishedAt: null,
    summary: null,
    // 버튼 옆 조용한 한 줄(`오늘 14:20에 가져왔어요`)이 쓰는 마지막 실행 기록.
    lastRunAt: last ? last.time : null,
    lastKind: last ? last.kind : null,
  };
  if (!request) return base;
  const requestedAt = Date.parse(request.requestedAt);
  if (!Number.isFinite(requestedAt)) return base;
  const run = meetingNotesRuns(lines).filter(item => meetingNotesTime(item.startedAt) >= requestedAt - 2000).pop() || null;
  const now = Date.now();
  if (!run) {
    return now - requestedAt > MEETING_NOTES_START_GRACE_MS
      ? { ...base, state: 'failed', summary: MEETING_NOTES_NOT_REGISTERED }
      : { ...base, state: 'requested' };
  }
  const startedAt = run.startedAt;
  if (!run.finishedAt) {
    return now - meetingNotesTime(startedAt) > MEETING_NOTES_RUN_LIMIT_MS
      ? { ...base, state: 'failed', startedAt, summary: '35분이 넘도록 끝나지 않았어요. 설정 › 연동 › 회의록 ⋯ › 최근 기록에서 확인해 주세요.' }
      : { ...base, state: 'running', startedAt };
  }
  const summary = summaryAt(run.finishedAt);
  return {
    ...base,
    state: run.exitCode === 0 ? 'done' : 'failed',
    startedAt,
    finishedAt: run.finishedAt,
    summary: summary || (run.exitCode === 0 ? '완료' : `실패 (exit ${run.exitCode})`),
  };
}

// 요청 표시 파일 쓰기. 회의 값은 "앱이 아는 회의"에서 그대로 옮겨 적는다 — 임의의 글자가
// 자동화 프롬프트로 흘러가지 않게, 사람이 보낸 글자는 검증과 대조에만 쓴다.
function writeMeetingNotesRequest(body) {
  if (!USES.tiro) { const error = new Error('미팅 노트 가져오기를 쓰지 않도록 설정돼 있어요.'); error.status = 404; throw error; }
  const current = meetingNotesStatus();
  if (current.state === 'requested' || current.state === 'running') {
    const error = new Error('지금 가져오는 중이에요.');
    error.status = 409;
    throw error;
  }
  const scope = body && body.scope;
  if (scope !== 'today' && scope !== 'meeting') throw new Error('무엇을 가져올지 확인해 주세요.');
  const payload = { requestedAt: new Date().toISOString(), scope };
  if (scope === 'meeting') {
    const wanted = body.meeting;
    if (!wanted || typeof wanted !== 'object') throw new Error('회의를 확인해 주세요.');
    const { date, start, title } = wanted;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !/^\d{2}:\d{2}$/.test(start || '')) throw new Error('회의 날짜와 시각을 확인해 주세요.');
    if (typeof title !== 'string' || !title.trim() || title.length > 200 || /[\r\n]/.test(title)) throw new Error('회의 제목을 확인해 주세요.');
    const today = todayLocal();
    if (date > today) throw new Error('아직 열리지 않은 회의예요.');
    if (date === today && start > new Date().toTimeString().slice(0, 5)) throw new Error('아직 시작하지 않은 회의예요.');
    const known = workflows.snapshot().meetings.find(event => event.date === date && event.start === start && event.title === title);
    if (!known) throw new Error('앱이 아는 회의가 아니에요.');
    payload.meeting = { date: known.date, start: known.start, end: /^\d{2}:\d{2}$/.test(known.end || '') ? known.end : '', title: known.title };
  }
  const file = meetingNotesRequestFile();
  nativeFs.mkdirSync(path.dirname(file), { recursive: true });
  nativeFs.writeFileSync(file, `${JSON.stringify(payload)}\n`);
  return { ok: true, ...meetingNotesStatus() };
}

// ---------- 지금 가져오기 (설정 > 연동 카드의 버튼) ----------
// 지라·캘린더(비밀 주소)는 서버가 메모리 보관함을 곧바로 다시 읽고 결과를 기다린다(제한 시간 안에서).
// 슬랙·캘린더(Claude)·티로는 **프로세스를 띄우지 않는다** — 요청 표시 파일 하나만 쓰고 launchd 에이전트가
// 기존 실행기로 돈다(미팅 노트 가져오기와 같은 원칙). 같은 연동은 1분에 한 번이다(서버 메모리에서 센다).
const FETCH_THROTTLE_MS = 60 * 1000;
const FETCH_WAIT_MS = { jira: 15000, calendar: 10000 };
const FETCH_KEYS = ['jira', 'calendar', 'slack', 'tiro'];
// 요청 파일을 지켜보는 launchd 이름(`com.workspace.app.<이름>`)과 요청 파일. 티로는 이미 있는 길을 그대로 쓴다.
const FETCH_AGENT = { slack: 'slack-capture-now', calendar: 'calendar-sync-now', tiro: 'tiro-sync' };
const FETCH_REQUEST_FILE = { slack: 'slack-capture.request', calendar: 'calendar-sync.request' };
const FETCH_MESSAGE = {
  key: '무엇을 가져올지 확인해 주세요.',
  off: '연결돼 있지 않아요.',
  throttled: '방금 가져왔어요 — 1분 뒤에 다시 할 수 있어요',
  notInstalled: '업데이트.command를 한 번 실행하면 쓸 수 있어요',
  jiraAuth: '지라 토큰이 만료됐거나 권한이 없어요 — 다시 연결해 주세요',
  jiraFailed: '지라를 읽지 못했어요 — 잠시 뒤 다시 시도해 주세요',
  jiraSlow: '지라가 15초 안에 답하지 않았어요 — 잠시 뒤 다시 시도해 주세요',
  calendarAuth: '비밀 주소를 읽을 수 없어요 — 주소가 바뀌었으면 다시 연결해 주세요',
  calendarFailed: '캘린더를 읽지 못했어요 — 잠시 뒤 다시 시도해 주세요',
  calendarSlow: '캘린더가 10초 안에 답하지 않았어요 — 잠시 뒤 다시 시도해 주세요',
};
// 슬랙이 준 오류 이름 중 "토큰을 다시 받아야 하는 것"(수집 로그의 `채널 확인 실패 — ERR:<이름>`).
// `token_expired`·`invalid_refresh_token`은 자동 갱신(새 방식)이 더는 안 될 때, `slack_reconnect`는 수집이 "다시 연결 필요"를
// 알고 슬랙에 묻지 않고 남기는 낱말이다(slack-collect.js).
const SLACK_AUTH_RE = /\b(invalid_auth|token_revoked|account_inactive|token_expired|invalid_refresh_token|slack_reconnect)\b/;
// 이 맥의 Claude Code 로그인이 풀렸을 때 claude가 남기는 말(자동화 로그). 토큰 문제가 아니라서 버튼은 `다시 시도` 그대로고,
// 카드의 이유 한 줄만 `터미널에서 claude → /login` 안내로 바뀐다(원문은 ⋯ › 최근 기록에 그대로).
// 실패한 실행의 로그 전체를 보므로, 작업 중 부른 커넥터(MCP)·API의 흔한 인증 오류(authentication_error 등)에 걸리지 않게
// claude 명령이 자기 로그인에 대해 내는 말만 잡는다.
const CLAUDE_AUTH_RE = /Failed to authenticate\. API Error: 401|OAuth session expired and could not be refreshed|Invalid API key · Please run \/login/i;
const fetchLastAt = new Map();

function launchAgentsDir() {
  return process.env.WORKSPACE_LAUNCH_AGENTS_DIR || path.join(os.homedir(), 'Library', 'LaunchAgents');
}
// 그 자동화가 launchd에 등록돼 있는지 — plist 파일이 **있는지만** 본다(읽지도 고치지도 않는다).
function launchAgentInstalled(name) {
  return nativeFs.existsSync(path.join(launchAgentsDir(), `com.workspace.app.${name}.plist`));
}

// ---------- 켠 연동 자동 등록 ----------
// 연동 저장이 등록에 영향을 주는 값(켬/끔·캘린더 갈래·슬랙 채널)을 바꿨으면 요청 표시 파일
// `requests/apply.request`(`{"action":"apply","requestedAt":"…"}` 한 줄)만 쓴다 — 서버는 프로세스를 띄우지 않는다.
// launchd `com.workspace.app.apply`가 그걸 보고 설치 위치 복사본 `apply-runner.sh`로 `setup.sh`를 다시 돌린다.
// 그 에이전트가 없는 옛 설치면 쓰지 않는다(카드가 `업데이트.command를 한 번 실행하면 수집이 시작돼요`를 말한다).
const applyRequestPath = () => path.join(automationDir(), 'requests', 'apply.request');
function requestApply() {
  if (!launchAgentInstalled('apply')) return 'not-installed';
  const file = applyRequestPath();
  nativeFs.mkdirSync(path.dirname(file), { recursive: true });
  nativeFs.writeFileSync(file, `${JSON.stringify({ action: 'apply', requestedAt: new Date().toISOString() })}\n`);
  return 'requested';
}

// apply-runner.sh가 `logs/apply.log`에 남긴 결과 줄 중 **마지막 것이 실패**면 그 줄(시각·고정 문구), 아니면 null.
// 이 한 줄은 launchd 등록에 기대는 카드(슬랙·캘린더 Claude·회의록)의 최근 기록 맨 위에 선다.
const APPLY_LINE_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (자동화 등록 (?:완료|실패.*))$/;
function applyLastFailure() {
  const last = tailLines(path.join(automationLogDir(), 'apply.log'), 50)
    .map(line => APPLY_LINE_RE.exec(line)).filter(Boolean).pop();
  if (!last || !last[2].startsWith('자동화 등록 실패')) return null;
  return { time: last[1], kind: 'fail', text: last[2].slice(0, 200) };
}
// 카드의 최근 기록(새것 먼저, 10개)에 등록 실패 한 줄을 시각 차례로 끼운다.
function withApplyFailure(events) {
  const failure = applyLastFailure();
  if (!failure) return events;
  return [...events, failure].sort((a, b) => String(b.time).localeCompare(String(a.time))).slice(0, 10);
}

function fetchUsed(key) {
  if (key === 'jira') return !!(USES.jira && jira.connected);
  if (key === 'calendar') return !!USES.calendar;
  if (key === 'slack') return !!USES.slack;
  return !!USES.tiro;
}

// 제한 시간 안에 끝나지 않으면 'timeout'. 도는 읽기는 끊지 않는다(보관함이 알아서 끝낸다).
function fetchWithin(promise, ms) {
  let timer = null;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

// 1분 제한·등록 안 됨·읽기 실패는 "요청은 잘 받았고 결과가 이렇다"라서 200에 `ok:false`로 답한다
// (브라우저가 4xx·5xx를 콘솔 오류로 남기지 않게). 잘못된 키·연결 안 된 연동만 400·404다.
const fetchAnswer = (status, body) => ({ status, body });
const fetchFail = (status, reason, message) => fetchAnswer(status, { ok: false, reason, message });

async function fetchNow(key) {
  if (!FETCH_KEYS.includes(key)) return fetchFail(400, 'failed', FETCH_MESSAGE.key);
  if (!fetchUsed(key)) return fetchFail(404, 'failed', FETCH_MESSAGE.off);
  const last = fetchLastAt.get(key);
  if (last && Date.now() - last < FETCH_THROTTLE_MS) return fetchFail(200, 'throttled', FETCH_MESSAGE.throttled);
  const direct = key === 'jira' || (key === 'calendar' && CALENDAR_ICAL);
  // 맥 캘린더 갈래는 `허용하고 확인`과 같은 요청 파일·launchd(`mac-calendar-now`)로 한 번 읽는다.
  const agent = key === 'calendar' && CALENDAR_MAC ? calendarMac.NOW_AGENT : FETCH_AGENT[key];
  if (!direct && !launchAgentInstalled(agent)) return fetchFail(200, 'not-installed', FETCH_MESSAGE.notInstalled);
  fetchLastAt.set(key, Date.now());

  if (key === 'jira') {
    const result = await fetchWithin(jiraLive.refresh(), FETCH_WAIT_MS.jira);
    const live = jiraLive.current();
    if (result === true && live) return fetchAnswer(200, { ok: true, mode: 'done', count: live.issues.length, readAt: new Date(live.at).toISOString() });
    if (result === 'timeout') return fetchFail(200, 'failed', FETCH_MESSAGE.jiraSlow);
    const failure = jiraLive.failure();
    return failure && failure.auth ? fetchFail(200, 'auth', FETCH_MESSAGE.jiraAuth) : fetchFail(200, 'failed', FETCH_MESSAGE.jiraFailed);
  }
  if (key === 'calendar' && CALENDAR_ICAL) {
    const result = await fetchWithin(calendarLive.refresh(), FETCH_WAIT_MS.calendar);
    const live = calendarLive.current();
    if (result === true && live) return fetchAnswer(200, { ok: true, mode: 'done', count: live.events.length, readAt: new Date(live.at).toISOString() });
    if (result === 'timeout') return fetchFail(200, 'failed', FETCH_MESSAGE.calendarSlow);
    const failure = calendarLive.failure();
    return failure && failure.auth ? fetchFail(200, 'auth', FETCH_MESSAGE.calendarAuth) : fetchFail(200, 'failed', FETCH_MESSAGE.calendarFailed);
  }
  if (key === 'tiro') {
    // 이미 있는 `미팅 노트 가져오기`(오늘 모드) 길 그대로 — 도는 중이면 그 말을 돌려준다.
    try { writeMeetingNotesRequest({ scope: 'today' }); } catch (error) {
      fetchLastAt.delete(key);
      return fetchFail(error.status === 409 ? 200 : (error.status || 400), error.status === 409 ? 'throttled' : 'failed', error.message);
    }
    return fetchAnswer(200, { ok: true, mode: 'requested' });
  }
  const file = path.join(automationDir(), 'requests', key === 'calendar' && CALENDAR_MAC ? calendarMac.REQUEST_FILE : FETCH_REQUEST_FILE[key]);
  nativeFs.mkdirSync(path.dirname(file), { recursive: true });
  nativeFs.writeFileSync(file, `${JSON.stringify({ requestedAt: new Date().toISOString() })}\n`);
  return fetchAnswer(200, { ok: true, mode: 'requested' });
}

// 연동 카드 상태 줄에 쓰는 "지금 실패 중인가"(값은 메모리·로그에서만 읽는다).
// 자동화는 **가장 최근 실행이 실패**일 때만 실패 중이다(해결된 과거 실패는 알리지 않는다).
const logTimeIso = text => { const at = meetingNotesTime(text); return Number.isFinite(at) ? new Date(at).toISOString() : null; };
// 계속 실패인가 — 가장 최근부터 이어진 실패가 3번 이상이거나, 그 첫 실패가 1시간 넘게 전이면. `stuck`(= 계속 실패 또는
// 토큰 문제)이 연동 탭의 `멈췄어요`·톱니바퀴 빨간 점·점검의 멈춤(integrationAlerts)이 함께 쓰는 한 기준이고, 한 번 실패는
// 연동 탭의 주황 `늦어요`일 뿐 빨간 점이 아니다. 화면은 이 값(`fetch.stuck`)을 읽기만 한다.
const FAIL_STUCK = { times: 3, ms: 60 * 60 * 1000 };
function failStuck(times = [], now = Date.now()) {
  const at = times.filter(Number.isFinite);
  return times.length >= FAIL_STUCK.times || (at.length > 0 && now - Math.min(...at) >= FAIL_STUCK.ms);
}
// `history`는 앱이 직접 읽은 기록(최근 것이 앞, { at, ok, auth }) — 맨 앞부터 이어진 실패를 센다.
function fetchStateLive(failure, history = []) {
  const failing = !!failure;
  const auth = !!(failure && failure.auth);
  const times = [];
  for (const entry of Array.isArray(history) ? history : []) {
    if (!entry || entry.ok) break;
    times.push(Number(entry.at));
  }
  if (failing && !times.length) times.push(Number(failure.at));
  return { failing, auth, stuck: failing && (auth || failStuck(times)), failedAt: failure ? new Date(failure.at).toISOString() : null };
}
function fetchStateAutomation(automation, authRe = null) {
  const failed = !!automation && automation.lastKind === 'fail';
  const auth = failed && !!authRe && authRe.test(automation.lastSummary || '');
  // 한 번 늦은 건 실패가 아니다 — 이어진 실패 회차가 모두 잠깐의 오류(시간 초과·네트워크·5xx·429)이고 사람이 누른 회차가
  // 아니면, 연속 FAIL_STUCK.times(3)회차가 될 때까지 실패로 올리지 않는다(이때는 시간이 흘러도 — 밤새 안 돌아도 — 세지 않는다).
  // 토큰 문제는 바로 올린다(DECISIONS 2026-10-06).
  const waiting = failed && !auth && automation.failTransient === true && automation.failManual !== true
    && (automation.failTimes || []).length < FAIL_STUCK.times;
  const failing = failed && !waiting;
  return {
    failing,
    auth,
    // 맥 캘린더의 허용 막힘·계정 없음·고른 캘린더 없음(사람이 고쳐야 풀림)은 토큰 문제처럼 한 번에 멈춤이다(WP-V).
    stuck: failing && (auth || calendarMac.NEEDS_PERSON_RE.test(automation.lastSummary || '') || failStuck(automation.failTimes || [])),
    // 가장 최근 실패가 Claude 로그인 풀림이면 true(연동 토큰 문제가 먼저면 그쪽을 말한다).
    claudeAuth: failing && !auth && CLAUDE_AUTH_RE.test(automation.lastSummary || ''),
    failedAt: failing ? logTimeIso(automation.lastRunAt) : null,
    lastRunAt: automation && automation.lastRunAt ? logTimeIso(automation.lastRunAt) : null,
    // 멈춘 카드의 이유 한 줄(화면이 사람 말로 바꾼다). 로그 한 줄이라 200자까지만.
    summary: failing ? String(automation.lastSummary || '').slice(0, 200) : null,
  };
}

// 슬랙 수집이 도는 시간대 — slack-capture.sh의 CAPTURE_FROM·CAPTURE_UNTIL과 같은 값이다(automation.test.js가 둘을 맞춰 본다).
// 이 밖(밤)에는 5분 주기 실행이 없으니 마지막 실패 기록이 아침까지 그대로 남는다 — 그래서 밤에는 경고 대신 `대기 중`이다.
const SLACK_CAPTURE_HOURS = { from: 9, until: 19 };
// 시계는 시험·픽스처만 바꿔 끼운다 — 모듈로 부르면 setSlackClockForTests, 띄운 서버는 `WORKSPACE_SLACK_TEST_HOUR`(오늘의 그 시).
const slackClockDefault = () => {
  const at = new Date();
  const hour = process.env.WORKSPACE_SLACK_TEST_HOUR;
  if (/^\d{1,2}$/.test(hour || '') && Number(hour) < 24) at.setHours(Number(hour));
  return at;
};
let slackClock = slackClockDefault;
function setSlackClockForTests(fn) { slackClock = typeof fn === 'function' ? fn : slackClockDefault; }
function slackCaptureResting(now = slackClock()) {
  const hour = now.getHours();
  return hour < SLACK_CAPTURE_HOURS.from || hour >= SLACK_CAPTURE_HOURS.until;
}
// 슬랙 수집 카드·빨간 점·점검이 함께 쓰는 판단(fetchStateAutomation + 쉬는 시간). 쉬는 시간이면 `resting`(화면은 `대기 중`)이고
// 지난 실패는 숨긴다 — 다만 토큰 문제와 `지금 가져오기`(사람이 방금 누른 것)의 실패는 그대로 보인다. 밤에는 돌지 않으니
// "1시간 넘게 실패"로 멈춤이 되지 않고, 이어진 실패 횟수·토큰 문제로만 멈춘다.
function fetchStateSlack(automation, { now = slackClock() } = {}) {
  const state = fetchStateAutomation(automation, SLACK_AUTH_RE);
  if (!slackCaptureResting(now)) return { ...state, resting: false };
  const rest = { ...state, resting: true, restUntil: SLACK_CAPTURE_HOURS.from };
  if (state.failing && (state.auth || (automation && automation.failManual === true))) {
    return { ...rest, stuck: state.auth || (automation.failTimes || []).length >= FAIL_STUCK.times };
  }
  return { ...rest, failing: false, auth: false, stuck: false, claudeAuth: false, failedAt: null, summary: null };
}

// 연동마다 "지금 멈췄나" — 연동 탭의 `멈췄어요`·톱니바퀴의 빨간 점·점검이 같은 판단(`stuck` — 계속 실패 또는 토큰 문제)을 쓴다.
// 한 번 실패는 멈춘 것이 아니다(연동 탭의 주황 `늦어요`). 비밀 주소를 한 번도 못 읽었으면 주소 문제로 보고 멈춘 것이다.
// 슬랙은 수집이 계속 실패하거나 **켜진 채널이 모두 사라졌으면** 멈춘 것이다(일부만 사라졌으면 카드의 주황 줄일 뿐이다.
// 사라졌는지는 이름 따라가기가 이미 들고 있는 답만 본다 — 여기서 슬랙에 묻지 않는다). 값은 로그·메모리에서만 읽고 파일은 쓰지 않는다.
// 새 방식(자동 갱신)의 연결이 풀렸는가 — 사람이 `다시 연결`을 눌러야 하는 상태(갱신 토큰이 죽었거나 갱신 정보가 없음)면
// 수집 기록과 상관없이 멈춘 것이다(연동 탭 슬랙 카드의 `broken`과 같은 기준: 연결된 카드 + `oauth.connected === false`).
// 잠시 안 되는 갱신(retry)은 멈춤이 아니다 — 이전 토큰으로 수집이 이어지고, 늦어지면 주황 `늦어요`가 말한다. 다만 토큰이
// 만료된 뒤에도 그 실패가 이어지면(`stalled` — 기준은 slack-auth.js STALL) 수집이 조용히 멈춘 것이라 같이 올린다. 파일만 읽는다.
function slackOAuthBroken(config = currentConfigFile()) {
  if (integrations.slackAuthMode(config) !== 'oauth') return false;
  const status = slackAuth.readOAuthStatus({ config });
  const lost = status.connected === false || !!(status.lastFailure && status.lastFailure.kind === 'reconnect') || status.stalled === true;
  return lost && slackConnectedNow();
}
function integrationAlerts(config = currentConfigFile(), automations = getAutomationStatus()) {
  const stuckAutomation = (key, authRe = null) => fetchStateAutomation(automations.find(one => one.key === key) || null, authRe).stuck;
  const slackStuck = () => fetchStateSlack(automations.find(one => one.key === 'slack') || null).stuck;
  const icalStuck = () => fetchStateLive(calendarLive.failure(), calendarLive.history()).stuck
    || (!calendarLive.current() && calendarLive.failed());
  const alerts = [];
  if (USES.slack && (slackStuck() || slackOAuthBroken(config) || slackFollower.allKnownMissing(config))) alerts.push('slack');
  if (USES.jira && jira.connected && fetchStateLive(jiraLive.failure(), jiraLive.history()).stuck) alerts.push('jira');
  if (USES.calendar && (CALENDAR_ICAL ? icalStuck() : stuckAutomation('calendar'))) alerts.push('calendar');
  if (USES.tiro && stuckAutomation('tiro')) alerts.push('notes');
  return alerts;
}

// 로그와 같은 모양의 로컬 시각(`YYYY-MM-DD HH:MM:SS`) — 앱이 직접 읽는 것(지라·캘린더 비밀 주소)의 최근 기록도
// 자동화 기록과 같은 줄 모양으로 싣는다.
function localStamp(ms) {
  const d = new Date(ms);
  const two = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}
const LIVE_LOG_WORDS = {
  jira: { ok: n => `읽음 · 내 티켓 ${n}개`, auth: '읽지 못했어요 — 토큰이 만료됐거나 권한이 없어요', fail: '읽지 못했어요 — 지라가 응답하지 않았어요' },
  calendar: { ok: n => `읽음 · 오늘 ${n}개`, auth: '읽지 못했어요 — 비밀 주소를 읽을 수 없어요', fail: '읽지 못했어요 — 캘린더가 응답하지 않았어요' },
};
function liveLog(kind, history) {
  const words = LIVE_LOG_WORDS[kind];
  return (history || []).map(entry => ({
    time: localStamp(entry.at),
    kind: entry.ok ? 'run' : 'fail',
    text: entry.ok ? words.ok(Number(entry.count) || 0) : (entry.auth ? words.auth : words.fail),
  }));
}

// 업무에 걸려 있는 지라 키를 모은다 — 기본 조회(내 담당·미완료)에서 빠진 것만 한 번 더 물어
// 요약이 사라지지 않게 하려고 쓴다. 항목의 `jira`, 회의에 연결한 지라 프로젝트, 손으로 건 `projectLinks`.
function linkedJiraKeys() {
  const keys = new Set();
  const add = (value) => { if (typeof value === 'string' && /^[A-Z][A-Z0-9]*-\d+$/.test(value)) keys.add(value); };
  try {
    const snapshot = workflows.snapshot();
    snapshot.items.forEach(item => add(item.jira));
    Object.values(snapshot.projectLinks || {}).forEach(add);
    // 묶음(BBUNDLE)에 든 티켓도 — 대표 티켓이 끝나 내 담당 목록에서 빠져도 묶음 이름(요약)이 남게.
    (snapshot.projectBundles || []).forEach(bundle => bundle.keys.forEach(key => add(key.slice('jira:'.length))));
  } catch { /* 목록은 곁들이는 값이다 — 못 모으면 기본 조회만 한다 */ }
  try {
    Object.values(readMeetingLinks()).forEach((value) => {
      if (typeof value === 'string' && value.startsWith('jira:')) add(value.slice(5));
    });
  } catch { /* 위와 같다 */ }
  return [...keys];
}

// 프로젝트 고르기 목록·프로젝트 이름(요약)의 원천. 앱이 직접 읽어 둔 목록이 있으면 그것을 쓰고,
// 없을 때만(설정 없음·토큰 만료·지라 장애) 동기화 스킬이 써 둔 스냅샷 파일로 물러선다.
function getJiraIssueCache() {
  const live = jiraLive.current();
  if (live) return live.issues;
  const jiraPath = path.join(TRACKER_DIR, 'jira_issues.md');
  if (!fs.existsSync(jiraPath)) return [];
  const lines = fs.readFileSync(jiraPath, 'utf-8').split('\n');
  const issues = [];
  // `extra`는 "요약을 보여 주기 위해서만 들고 있는 이슈"라는 표시다 — 화면은 이걸 새 프로젝트
  // 후보로 내놓지 않는다. 구역이 없는 옛 파일은 전부 extra:false로 예전과 똑같이 읽힌다.
  let extra = false;
  lines.forEach((line) => {
    if (line.startsWith('## ')) extra = line.trim() === JIRA_EXTRA_HEADING;
    const m = line.match(JIRA_ITEM_RE);
    if (!m) return;
    issues.push({ key: m[1], type: m[2], status: m[3], summary: m[4], extra });
  });
  return issues;
}

// 지라 프로젝트의 앱 안 별칭(BJALIAS) — `.workflow.json`을 매번 새로 읽는다(스냅샷 캐시가 아니다,
// workflows.snapshot()은 refs()를 통해 이 요약 계산을 부르므로 여기서 다시 부르면 되돈다).
function getProjectAliases() {
  return workflows.projectAliases();
}
// 지라 요약으로 이름표를 짓는 모든 자리가 부르는 단 하나의 헬퍼 — 별칭이 있으면 별칭, 없으면 요약.
// 둘 다 없으면 빈 글자를 돌려주고, 부르는 쪽이 키로 물러선다(BJALIAS).
function projectDisplayName(key, summary) {
  return getProjectAliases()[key] || summary || '';
}

// 프로젝트를 고르는 목록(그룹 지정·분류 판·주간요약 고르개)이 쓰는 직접 만든 프로젝트 이름들.
// 프로젝트 탭 왼쪽 목록과 한 출처(workflows.groupList — 모든 종류·끝낸 업무·회의에 건 이름)를 쓴다.
// 업무를 다 끝냈거나 결정·회의에만 건 프로젝트가 고르는 목록에서만 사라지지 않게 하려는 것이다 —
// 조용해진 프로젝트는 화면이 `지난 프로젝트` 소제목 아래로 내린다(지우지 않는다).
function getCustomGroups() {
  return [...new Set(workflows.groupList())].sort();
}

// ---------- 미팅 ↔ 프로젝트 연결 (사람이 직접 지정) ----------
// 제목을 키로 저장해서, 정기 미팅은 한 번만 연결하면 다음 주에도 유지된다.

const MEETING_LINKS_PATH = path.join(process.env.WORKSPACE_DATA_DIR || __dirname, '.meeting_links.json');

function readMeetingLinks() {
  if (!fs.existsSync(MEETING_LINKS_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(MEETING_LINKS_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

// meetingId(있으면): 사람이 연결을 고른 그 회의 — 지난 회의에서 연결해도 그 회의의 프로젝트가 함께 바뀐다.
function setMeetingLink(title, project, meetingId) {
  const key = String(title || '').trim();
  if (!key) return false;
  if(project && !resolveProject(project))throw new Error('프로젝트를 확인해 주세요.');
  const links = readMeetingLinks();
  if (project) links[key] = project;
  else delete links[key];
  fs.writeFileSync(MEETING_LINKS_PATH, JSON.stringify(links, null, 2));
  workflows.syncProject(key, resolveProject(project), meetingId);
  return true;
}

// ---------- 회의 프로젝트를 연결·변경·해제한 뒤 이미 담은 항목도 옮기기·빼기 ----------
// 회의 상세의 확인 줄(`옮기기`·`빼기`)과 오늘 미팅 줄 ⋯ 뒤의 알림 버튼만 부른다. 화면이 고른 번호(ids)와 **어디서
// 옮기는지(from — 이전 프로젝트, 처음 연결이면 null)**를 함께 받는다. 서버는 지금 위치를 다시 본다: 옮길 수 있는 것은
// 지금 프로젝트가 없거나(연결·변경일 때) from에 있는 것뿐이고, 그 사이 다른 창·기기에서 다른 프로젝트로 옮겼거나
// 끝낸 항목은 덮지 않고 건너뛴다(skipped로 센다 — 전부 실패가 아니다). 끝낸 항목은 주간요약 같은 지난 기록이 바뀌지
// 않게 옮기지 않는다. 이 회의의 항목이 아닌 번호는 여전히 전부 거절한다. 할 일·버그·확인 대기·결정은 jira/group 칸(set-jira/set-group과 같은 setTrackField), 아이디어는
// 제 프로젝트 칸(`project:` — /api/idea/set-project와 같은 규칙, 지라면 `jira:`)을 바꾼다. project가 null이면 뺀다.
// 한 트랜잭션(idempotent → mutations.run)이라 하나라도 틀리면 전부 그대로다. 되돌리기는 돌려준 moved(원래 프로젝트)로.
const MEETING_MOVE_TYPES = ['task', 'bug', 'check', 'decision', 'idea'];
const MEETING_MOVE_MAX = 500;
const MEETING_MOVE_KEY_RE = /^(jira|group):\S/;
// 아이디어는 프로젝트 이름이 `project:` 칸에 있다 — 화면의 wfKey와 같은 꼴로 읽는다.
const meetingItemKey = ref => (ref.jira ? `jira:${ref.jira}` : (ref.group || ref.project) ? `group:${String(ref.group || ref.project).replace(/_/g, ' ').trim()}` : null);
const meetingMoveKey = target => (!target ? null : target.type === 'group' ? `group:${target.value.replace(/_/g, ' ').trim()}` : `jira:${target.value}`);
function meetingMoveTarget(project) {
  if (project === null || project === undefined) return null;
  if (typeof project !== 'string' || !MEETING_MOVE_KEY_RE.test(project) || project.length > 250 || /[\r\n\[\]]/.test(project)) throw new Error('프로젝트를 확인해 주세요.');
  const target = resolveProject(project);
  if (!target) throw new Error('프로젝트를 확인해 주세요.');
  return target;
}
function meetingMoveCheckIds(ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > MEETING_MOVE_MAX || ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) {
    throw new Error('옮길 항목을 확인해 주세요.');
  }
}
// 항목 하나의 프로젝트를 target({type,value}) 또는 없음(null)으로 맞춘다.
function meetingSetItemProject(id, type, target) {
  if (type === 'idea') {
    setTrackField(id, 'group', null, 'idea');
    setTrackField(id, 'project', target && target.type === 'group' ? target.value : null, 'idea');
    return setTrackField(id, 'jira', target && target.type === 'jira' ? target.value : null, 'idea');
  }
  if (!target) { setTrackField(id, 'jira', null, null); return setTrackField(id, 'group', null, null); }
  return setTrackField(id, target.type, target.value, null);
}
// from(이전 프로젝트 열쇠)을 서버의 열쇠 꼴로 — 그룹은 밑줄·공백을 같은 이름으로 본다. 보내지 않으면 null(처음 연결).
function meetingMoveFromKey(from) {
  if (from === null || from === undefined) return null;
  if (typeof from !== 'string' || !MEETING_MOVE_KEY_RE.test(from) || from.length > 250 || /[\r\n\[\]]/.test(from)) throw new Error('이전 프로젝트를 확인해 주세요.');
  return from.startsWith('group:') ? `group:${from.slice('group:'.length).replace(/_/g, ' ').trim()}` : from;
}
function moveMeetingItems({ meetingId, project = null, from = null, ids } = {}) {
  if (typeof meetingId !== 'string' || !meetingId) throw new Error('회의를 찾을 수 없어요.');
  const target = meetingMoveTarget(project);
  const was = meetingMoveFromKey(from);
  meetingMoveCheckIds(ids);
  const linked = workflows.meetingItemIds(meetingId);
  const refs = getReportRefs();
  const key = meetingMoveKey(target);
  const moved = [];
  let skipped = 0;
  ids.forEach((id) => {
    const ref = refs[id];
    if (!ref || !linked.has(id) || !MEETING_MOVE_TYPES.includes(ref.type)) throw new Error('이 회의에서 나온 항목이 아니에요. 새로고침한 뒤 다시 시도해 주세요.');
    const now = meetingItemKey(ref);
    if (now === key) return; // 이미 그 자리다 — 세지도 않는다
    // 끝낸 항목, 그리고 지금 자리가 옮겨도 되는 자리(연결·변경이면 없음 또는 from, 빼기면 from)가 아니면 건너뛴다.
    const movable = now === null ? key !== null : (was !== null && now === was);
    if (ref.status === 'done' || !movable) { skipped += 1; return; }
    if (!meetingSetItemProject(id, ref.type, target)) throw new Error('항목을 찾을 수 없어요.');
    moved.push({ id, from: now });
  });
  return { ok: true, meetingId, project: key, count: moved.length, moved, skipped };
}
// 되돌리기: 기록(moved)의 번호가 지금도 이 회의의 항목이고 아직 옮긴 그 자리(project, 뺐으면 없음)에 있을 때만
// 원래대로 돌린다. 그 사이 다른 기기·사람이 바꿨으면 건드리지 않고 건너뛴다(skipped) — BMOVE 되돌리기와 같은 규칙.
function undoMoveMeetingItems({ meetingId, project = null, moved } = {}) {
  if (typeof meetingId !== 'string' || !meetingId) throw new Error('회의를 찾을 수 없어요.');
  const target = meetingMoveTarget(project);
  if (!Array.isArray(moved)) throw new Error('되돌릴 항목이 없어요.');
  meetingMoveCheckIds(moved.map(entry => entry && entry.id));
  moved.forEach((entry) => {
    const from = entry.from;
    if (from !== null && (typeof from !== 'string' || !MEETING_MOVE_KEY_RE.test(from) || from.length > 250 || /[\r\n\[\]]/.test(from))) throw new Error('되돌릴 프로젝트를 확인해 주세요.');
  });
  const linked = workflows.meetingItemIds(meetingId);
  const refs = getReportRefs();
  const key = meetingMoveKey(target);
  let restored = 0, skipped = 0;
  moved.forEach(({ id, from }) => {
    const ref = refs[id];
    // 끝낸 항목은 되돌리기에서도 건드리지 않는다 — 옮긴 뒤 끝냈으면 그 프로젝트가 이미 지난 기록이다.
    if (!ref || !linked.has(id) || ref.status === 'done' || meetingItemKey(ref) !== key) { skipped += 1; return; }
    const at = from ? from.indexOf(':') : -1;
    meetingSetItemProject(id, ref.type, from ? { type: from.slice(0, at), value: from.slice(at + 1) } : null);
    restored += 1;
  });
  return { ok: true, restored, skipped };
}

function resolveProject(projectKey) {
  if (!projectKey) return null;
  const [type, ...rest] = projectKey.split(':');
  const value = rest.join(':');
  if (type === 'jira') {
    const issue = getJiraIssueCache().find((i) => i.key === value);
    // 별칭이 있으면 회의 프로젝트 라벨에도 그 이름이 붙는다(BJALIAS).
    const name = projectDisplayName(value, issue ? issue.summary : '');
    return { type, value, label: name ? `${value} · ${name}` : value };
  }
  if (type === 'group') return { type, value, label: value };
  return null;
}

function getCalendarWithLinks() {
  const calendar = getCalendarToday();
  const links = readMeetingLinks();
  const openTasks = [...getTodayTasks(), ...getLaterTasks()].filter((t) => t.status !== 'done');
  const events = calendar.events.map((event) => {
    const project = resolveProject(links[String(event.title).trim()]);
    return {
      ...event,
      project,
      relatedCount: project
        ? openTasks.filter((t) => projectKeyOf(t) === `${project.type}:${project.value}`).length
        : 0,
    };
  });
  return { ...calendar, events };
}

// ---------- 오늘 할 일 제안 ----------

function projectKeyOf(item) {
  if (item.jira) return `jira:${item.jira}`;
  if (item.group) return `group:${item.group}`;
  return null;
}

function toggleTrackStatus(id, desired) {
  if (desired !== undefined && !['done','to-do'].includes(desired)) throw new Error('상태를 확인해 주세요.');
  let changed = false;
  listTrackerFiles().forEach((filePath) => {
    if (changed) return;
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    let fileChanged = false;
    const newLines = lines.map((line) => {
      const m = line.match(TRACK_RE);
      if (!m) return line;
      const fields = parseFields(m[3]);
      if (fields.id !== id) return line;
      const newStatus = desired || (fields.status === 'done' ? 'to-do' : 'done');
      if (newStatus === fields.status) { changed = true; return line; }
      const nowIso = new Date().toISOString();
      let newFieldStr = m[3].replace(/status:\S+/, `status:${newStatus}`);
      newFieldStr = newFieldStr.replace(/\s+completed:\S+/g, '');
      // 완료하면 "진행 중"은 자동으로 풀린다 — 따로 해제할 일이 없게.
      if (newStatus === 'done') newFieldStr = newFieldStr.replace(/\s+doing:\S+/g, '') + ` completed:${todayLocal()}`;
      newFieldStr = /updated:\S+/.test(newFieldStr)
        ? newFieldStr.replace(/updated:\S+/, `updated:${nowIso}`)
        : `${newFieldStr} updated:${nowIso}`;
      fileChanged = true;
      return `- ${m[1]} #${m[2]}[${newFieldStr}]`;
    });
    if (fileChanged) {
      fs.writeFileSync(filePath, newLines.join('\n'));
      changed = true;
    }
  });
  return changed;
}

function appendTask({ description, priority, due }) {
  const tasksPath = path.join(TRACKER_DIR, 'tasks.md');
  if (!fs.existsSync(tasksPath)) {
    fs.writeFileSync(tasksPath, '# Tasks\n\n');
  }
  const id = `task_${ulid()}`;
  const created = todayLocal();
  return { tasksPath, id, created };
}

function createManualTask({ description, priority, due = null, scheduled = todayLocal(), jira, group }) {
  validateDescription(description); validateFields({ priority, jira, group });
  if (!description || !description.trim()) return { ok: false, error: 'empty description' };
  validateDate(due);
  validateDate(scheduled);
  const { tasksPath, id, created } = appendTask({});
  let fieldStr = `id:${id} status:to-do priority:${priority || 'medium'} created:${created}`;
  fieldStr += ` scheduled:${scheduled || 'none'}`;
  if (due) fieldStr += ` due:${due}`;
  if (jira) fieldStr += ` jira:${jira.trim()}`;
  else if (group) fieldStr += ` group:${group.trim().replace(/\s+/g, '_')}`;
  fs.appendFileSync(tasksPath, `- ${description.trim()} #task[${fieldStr}]\n`);
  return { ok: true, id };
}

function createLaterTask({ description, priority, due, jira, group }) {
  return createManualTask({ description, priority, due, scheduled: null, jira, group });
}

function createWaitingItem({ description, priority, who, jira, group, due = null }) {
  validateDescription(description); validateFields({ priority, who, jira, group });
  validateDate(due);
  if (!description || !description.trim()) return { ok: false, error: 'empty description' };
  const checksPath = path.join(TRACKER_DIR, 'checks.md');
  if (!fs.existsSync(checksPath)) fs.writeFileSync(checksPath, '# Checks\n\n');
  const id = `chk_${ulid()}`;
  const created = todayLocal();
  let fieldStr = `id:${id} status:to-do priority:${priority || 'medium'} created:${created}`;
  if (who) fieldStr += ` who:${who.trim().replace(/\s+/g, '_')}`;
  if (due) fieldStr += ` due:${due}`; // 상대에게 회신 받아야 하는 기한
  if (jira) fieldStr += ` jira:${jira.trim()}`;
  else if (group) fieldStr += ` group:${group.trim().replace(/\s+/g, '_')}`;
  fs.appendFileSync(checksPath, `- ${description.trim()} #check[${fieldStr}]\n`);
  return { ok: true, id };
}

function createDecision({ description, priority, jira, group, permalink }) {
  validateDescription(description); validateFields({ priority, jira, group });
  if (!description || !description.trim()) return { ok: false, error: 'empty description' };
  if (permalink && !/^https:\/\/\S+$/.test(permalink)) return { ok: false, error: 'invalid permalink' };
  const decisionsPath = path.join(TRACKER_DIR, 'decisions.md');
  if (!fs.existsSync(decisionsPath)) fs.writeFileSync(decisionsPath, '# Decisions\n\n');
  const id = `dec_${ulid()}`;
  const created = todayLocal();
  let fieldStr = `id:${id} status:to-do priority:${priority || 'medium'} created:${created}`;
  // seen:true — carried over from a waiting item the user already handled, so it shouldn't show as NEW.
  if (permalink) fieldStr += ` source:slack:${permalink} seen:true`;
  if (jira) fieldStr += ` jira:${jira.trim()}`;
  else if (group) fieldStr += ` group:${group.trim().replace(/\s+/g, '_')}`;
  fs.appendFileSync(decisionsPath, `- ${description.trim()} #decision[${fieldStr}]\n`);
  return { ok: true, id };
}

function createIdea({ description, priority, project }) {
  validateDescription(description); validateFields({ priority, project });
  if (!description || !description.trim()) return { ok: false, error: 'empty description' };
  const ideasPath = path.join(TRACKER_DIR, 'ideas.md');
  if (!fs.existsSync(ideasPath)) fs.writeFileSync(ideasPath, '# Ideas\n\n');
  const id = `ida_${ulid()}`;
  const created = todayLocal();
  let fieldStr = `id:${id} status:to-do priority:${priority || 'medium'} created:${created}`;
  if (project) fieldStr += ` project:${project.trim().replace(/\s+/g, '_')}`;
  fs.appendFileSync(ideasPath, `- ${description.trim()} #idea[${fieldStr}]\n`);
  return { ok: true, id };
}

function removeTrackItem(id, archive = true) {
  let removed = null;
  listTrackerFiles().forEach((filePath) => {
    if (removed) return;
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    const idx = lines.findIndex((line) => {
      const m = line.match(TRACK_RE);
      if (!m) return false;
      const fields = parseFields(m[3]);
      return fields.id === id;
    });
    if (idx === -1) return;
    const m = lines[idx].match(TRACK_RE);
    removed = { description: m[1], type: m[2], fields: parseFields(m[3]) };
    if (archive) {
      const trashPath = path.join(TRACKER_DIR, '.trash.json');
      const trash = fs.existsSync(trashPath) ? JSON.parse(fs.readFileSync(trashPath, 'utf-8')) : [];
      trash.push({ id, file: path.basename(filePath), line: lines[idx], index: idx, deletedAt: new Date().toISOString() });
      fs.writeFileSync(trashPath, JSON.stringify(trash, null, 2));
    }
    lines.splice(idx, 1);
    fs.writeFileSync(filePath, lines.join('\n'));
  });
  return removed;
}

// ---------- 종류 바꾸기 (같은 id로 파일만 옮긴다) ----------
// 새 항목을 만들고 옛 항목을 지우는 방식이 아니다 — 회의 연결·검토 기록이 id로 이어져 있어서
// 번호가 바뀌면 그 줄들이 끊긴다. 그래서 줄을 통째로 새 파일로 옮기고 종류 표시만 바꾼다.
// 부르는 곳은 workflow-store.retype 하나이고, 저장 길은 기존 그대로다(idempotent → mutations.run).
const RETYPE_FILE = { task: 'tasks.md', check: 'checks.md', decision: 'decisions.md' };
const RETYPE_HEAD = { task: '# Tasks', check: '# Checks', decision: '# Decisions' };
// 종류별로 파일에 남길 칸과 그 차례. 여기 없는 칸은 옮기면서 버린다.
// - 결정에는 날짜가 없다(DECISIONS: 마감일은 할 일·확인 대기만) → due·scheduled·doing·inbox·who 제거
// - 확인 대기에는 실행 예정일·진행 중이 없다 → scheduled·doing·inbox 제거
// - 할 일에는 `누구에게`가 없다 → who 제거
// priority는 세 종류가 모두 파일에 적는 칸이라(create* 함수들) 그대로 가져간다.
const RETYPE_KEEP = {
  task: ['id', 'status', 'priority', 'created', 'scheduled', 'due', 'doing', 'inbox', 'jira', 'group', 'source', 'seen', 'completed', 'updated'],
  check: ['id', 'status', 'priority', 'created', 'due', 'who', 'jira', 'group', 'source', 'seen', 'completed', 'updated'],
  decision: ['id', 'status', 'priority', 'created', 'jira', 'group', 'source', 'seen', 'completed', 'updated'],
};
function retypeTrackItem(id, type) {
  if (!RETYPE_FILE[type]) throw new Error('바꿀 종류를 확인해 주세요.');
  let found = null;
  for (const filePath of listTrackerFiles()) {
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    const index = lines.findIndex((line) => {
      const m = line.match(TRACK_RE);
      return !!m && parseFields(m[3]).id === id;
    });
    if (index === -1) continue;
    found = { filePath, lines, index, match: lines[index].match(TRACK_RE) };
    break;
  }
  if (!found) throw new Error('항목을 찾을 수 없어요.');
  const from = found.match[2];
  const fields = parseFields(found.match[3]);
  if (!['task', 'bug', 'check', 'decision'].includes(from)) throw new Error('이 종류는 바꿀 수 없어요.');
  if (from === type) throw new Error('이미 같은 종류예요.');
  if (fields.status === 'done') throw new Error('완료한 항목은 종류를 바꿀 수 없어요.');
  const values = {};
  RETYPE_KEEP[type].forEach((name) => { if (fields[name] !== undefined && fields[name] !== '') values[name] = fields[name]; });
  // 할 일로 오면 "나중에 할 일"로 들어간다 — 종류를 바꿨다고 오늘 목록이 채워지지 않게(DECISIONS).
  if (type === 'task' && !values.scheduled) values.scheduled = 'none';
  if (!values.status) values.status = 'to-do';
  if (!values.priority) values.priority = 'medium';
  values.updated = new Date().toISOString();
  const fieldStr = RETYPE_KEEP[type].filter(name => values[name] !== undefined).map(name => `${name}:${values[name]}`).join(' ');
  const line = `- ${found.match[1]} #${type}[${fieldStr}]`;
  const targetPath = path.join(TRACKER_DIR, RETYPE_FILE[type]);
  // 옛 항목이 이미 그 파일에 있으면(옛 기록은 한 파일에 섞여 있기도 하다) 그 자리에서 종류만 바꾼다.
  if (path.resolve(targetPath) === path.resolve(found.filePath)) {
    found.lines[found.index] = line;
    fs.writeFileSync(found.filePath, found.lines.join('\n'));
    return { ok: true, id, type, from };
  }
  found.lines.splice(found.index, 1);
  fs.writeFileSync(found.filePath, found.lines.join('\n'));
  if (!fs.existsSync(targetPath)) fs.writeFileSync(targetPath, `${RETYPE_HEAD[type]}\n\n`);
  fs.appendFileSync(targetPath, `${line}\n`);
  return { ok: true, id, type, from };
}

function restoreTrackItem(id) {
  const trashPath = path.join(TRACKER_DIR, '.trash.json');
  const trash = fs.existsSync(trashPath) ? JSON.parse(fs.readFileSync(trashPath, 'utf-8')) : [];
  const index = trash.findLastIndex(item => item.id === id);
  if (index < 0) return false;
  const item = trash[index];
  if (path.basename(item.file) !== item.file || !item.file.endsWith('.md')) return false;
  const exists = listTrackerFiles().some(file => fs.readFileSync(file, 'utf-8').split('\n').some(line => {
    const match = line.match(TRACK_RE);
    return match && parseFields(match[3]).id === id;
  }));
  if (!exists) {
    const filePath = path.join(TRACKER_DIR, item.file);
    const lines = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8').split('\n') : [];
    lines.splice(Math.min(item.index, lines.length), 0, item.line);
    fs.writeFileSync(filePath, lines.join('\n'));
  }
  trash.splice(index, 1);
  fs.writeFileSync(trashPath, JSON.stringify(trash, null, 2));
  return true;
}

// ---------- 삭제한 항목 (tracker/.trash.json) ----------
// 삭제는 확인창 없이 바로 실행되고 원문 줄이 여기 남는다(removeTrackItem). 설정 > `삭제한 항목`이
// 이 목록을 읽어 되살리기(기존 restoreTrackItem)와 완전히 지우기(purgeTrashItem)를 건다.
// 자동 영구 삭제는 하지 않는다(DECISIONS) — 목록에서 사람이 고른 것만 지운다.
const trashPathOf = () => path.join(TRACKER_DIR, '.trash.json');
function readTrash() {
  const file = trashPathOf();
  if (!fs.existsSync(file)) return [];
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return Array.isArray(value) ? value : [];
  } catch {
    // 형식이 깨졌으면 "없음"으로 읽고 파일은 그대로 둔다(조회가 파일을 고치지 않는다).
    return [];
  }
}
const TRASH_TYPE_WORD = { task: '할 일', bug: '할 일', check: '확인 대기', decision: '결정', idea: '아이디어' };
// 원문 줄에서 화면이 쓰는 것만 뽑는다 — 종류·문구·프로젝트뿐이고 전체 줄(흐름 기록 칸)은 싣지 않는다.
// 지라 프로젝트의 이름은 요약만 적는다(모르면 키 — BKEY 결정).
function listTrash() {
  return readTrash()
    .map((entry) => {
      const match = typeof entry?.line === 'string' ? entry.line.match(TRACK_RE) : null;
      const fields = match ? parseFields(match[3]) : {};
      const group = fields.group || fields.project;
      const issue = fields.jira ? getJiraIssueCache().find(item => item.key === fields.jira) : null;
      return {
        id: typeof entry?.id === 'string' ? entry.id : null,
        type: match ? match[2] : null,
        typeLabel: match ? (TRASH_TYPE_WORD[match[2]] || '항목') : '항목',
        description: match ? match[1] : '',
        file: typeof entry?.file === 'string' ? entry.file : '',
        deletedAt: typeof entry?.deletedAt === 'string' ? entry.deletedAt : null,
        // 별칭이 있으면 삭제한 항목 목록에도 그 이름이 붙는다(BJALIAS).
        project: fields.jira ? (projectDisplayName(fields.jira, issue ? issue.summary : '') || fields.jira) : group ? group.replace(/_/g, ' ') : null,
        projectKey: fields.jira ? `jira:${fields.jira}` : group ? `group:${group.replace(/_/g, ' ')}` : null,
      };
    })
    .filter(entry => entry.id)
    .sort((a, b) => String(b.deletedAt || '').localeCompare(String(a.deletedAt || '')));
}
// 완전히 지우기 — `.trash.json`에서 그 항목만 뺀다. 업무 파일은 건드리지 않는다(이미 지워진 줄이다).
function purgeTrashItem(id) {
  if (typeof id !== 'string' || !id.trim()) throw new Error('지울 항목을 확인해 주세요.');
  const file = trashPathOf();
  const trash = readTrash();
  const kept = trash.filter(entry => entry?.id !== id);
  if (kept.length === trash.length) throw new Error('이미 지운 항목이에요.');
  fs.writeFileSync(file, JSON.stringify(kept, null, 2));
  return { ok: true, id, removed: trash.length - kept.length };
}

// ---------- 직접 만든(그룹) 프로젝트 이름 바꾸기 ----------
// 프로젝트 이름은 기록 여러 곳에 글자로 박혀 있다. 한 트랜잭션(idempotent → mutations.run) 안에서
// 다섯 자리를 모두 바꾸고, 하나라도 실패하면 mutation-store의 저널이 전부 되돌린다 — 반쯤 바뀐
// 이름을 남기지 않는다. 지라 프로젝트의 이름은 지라 요약이라 여기서 받지 않는다.
//   ① tracker/*.md 의 `group:`·`project:` 칸(아이디어는 `project:`다) — 파일 표기는 공백→밑줄
//   ② .workflow.json 의 회의 프로젝트(`project.type === 'group'`)
//   ③ .workflow.json 의 `projectLinks` 키 · ④ `projectArchive` 키
//   ⑤ .meeting_links.json 의 `group:` 값 · ⑥ 주간요약 저장본(.report-drafts.json)의 그룹 이름
// 응답의 `meetings`는 ②와 ⑤를 함께 센다(둘 다 회의의 프로젝트다).
const PROJECT_NAME_MAX = 60;
const groupNameKey = value => String(value || '').replace(/_/g, ' ').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
// 겹침 검사 하나로 그룹 이름 바꾸기(renameProject)와 지라 별칭(setProjectAliasAction)이 함께 쓴다 —
// 그룹 이름·다른 별칭·지라 요약 가운데 아무거나와 겹치면 안 된다(BJALIAS). exclude*는 "지금 이 이름
// 자신"이라 빼고 본다(그룹은 자기 이름, 지라는 자기 요약·자기 별칭을 뺀다).
function projectNamesTaken({ excludeGroup = null, excludeJira = null } = {}) {
  const aliases = getProjectAliases();
  return new Set([
    ...getCustomGroups().filter(entry => entry !== excludeGroup),
    ...getJiraIssueCache().filter(issue => issue.key !== excludeJira).map(issue => issue.summary),
    ...Object.entries(aliases).filter(([key]) => key !== excludeJira).map(([, alias]) => alias),
  ].map(groupNameKey));
}
function renameProject({ project, name }) {
  if (typeof project !== 'string' || !project.startsWith('group:')) throw new Error('직접 만든 프로젝트의 이름만 바꿀 수 있어요. 지라 프로젝트의 이름은 지라 요약을 따라요.');
  const from = project.slice('group:'.length).replace(/_/g, ' ').trim();
  if (!from) throw new Error('프로젝트를 확인해 주세요.');
  if (typeof name !== 'string') throw new Error('새 이름을 입력해 주세요.');
  // 파일 표기에서 밑줄은 공백이다(`결제_리뉴얼` == `결제 리뉴얼`) — 화면이 읽는 꼴 하나로 맞춰서
  // 받는다. 그러지 않으면 "글자는 달라졌는데 앱에서는 같은 이름"인 상태가 생긴다.
  const to = name.replace(/_/g, ' ').trim();
  if (!to || to.length > PROJECT_NAME_MAX || /[\r\n\[\]]/.test(to)) throw new Error(`새 이름은 ${PROJECT_NAME_MAX}자 이내 한 줄로, 대괄호 없이 적어 주세요.`);
  const groups = workflows.groupList();
  if (!groups.includes(from)) throw new Error('프로젝트를 찾을 수 없어요.');
  if (to === from) throw new Error('이미 같은 이름이에요.');
  // 겹침은 공백·대소문자를 고르게 맞춘 뒤 본다. 지금 이름 자신은 빼고 본다(띄어쓰기만 고치는 경우).
  const taken = projectNamesTaken({ excludeGroup: from });
  if (taken.has(groupNameKey(to))) throw new Error('같은 이름의 프로젝트가 이미 있어요.');

  // ① 업무 파일의 줄 — 지라가 걸린 항목은 그룹 이름을 쓰지 않으므로 건너뛴다.
  const token = to.replace(/\s+/g, '_');
  let items = 0;
  listTrackerFiles().forEach((filePath) => {
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    let touched = false;
    const next = lines.map((line) => {
      const match = line.match(TRACK_RE);
      if (!match || parseFields(match[3]).jira) return line;
      const fieldStr = match[3].split(/\s+/).map((part) => {
        const at = part.indexOf(':');
        if (at === -1) return part;
        const key = part.slice(0, at);
        if (key !== 'group' && key !== 'project') return part;
        return part.slice(at + 1).replace(/_/g, ' ') === from ? `${key}:${token}` : part;
      }).join(' ');
      if (fieldStr === match[3]) return line;
      touched = true;
      items += 1;
      return `- ${match[1]} #${match[2]}[${fieldStr}]`;
    });
    if (touched) fs.writeFileSync(filePath, next.join('\n'));
  });

  // ②③④ 회의 프로젝트·수동 지라 연결·보관 표
  const moved = workflows.renameGroup(from, to);

  // ⑤ 회의 제목 → 프로젝트 표(정기 회의의 연결)
  const links = readMeetingLinks();
  let meetingLinks = 0;
  for (const [title, value] of Object.entries(links)) {
    if (typeof value !== 'string' || !value.startsWith('group:')) continue;
    if (value.slice('group:'.length).replace(/_/g, ' ').trim() !== from) continue;
    links[title] = `group:${to}`;
    meetingLinks += 1;
  }
  if (meetingLinks) fs.writeFileSync(MEETING_LINKS_PATH, JSON.stringify(links, null, 2));

  // ⑥ 주간요약 저장본 — 저장 형식은 그대로 두고 그룹 이름 값만 바꾼다.
  const report = reportDrafts.renameGroup(from, to);

  return {
    ok: true, project: `group:${to}`, from, to,
    changed: { items, meetings: moved.meetings + meetingLinks, links: moved.links, archive: moved.archive, report },
  };
}

// ---------- 지라 프로젝트 앱 안 별칭 (BJALIAS) ----------
// 지라 요약은 고쳐 쓰지 않고(GET /api/jira/list 응답 불변) 앱 안에서만 쓰는 이름을 덧씌운다.
// 형식 검증은 workflows.checkProjectAlias가 하고, 여기서는 지라 요약 목록이 필요한 두 가지만 본다:
// ① 요약과 똑같은 별칭은 뜻이 없어 지운 것으로 처리(null 저장) ② 그룹 이름·다른 별칭·(자기 자신을
// 뺀) 지라 요약과 겹치면 거절. 마지막으로 주간요약 저장본의 표시 이름을 같은 트랜잭션 안에서 갱신한다
// (report-drafts.relabelProject — renameGroup과 정확히 대칭).
function setProjectAliasAction({ jira, alias }) {
  const { jira: key, alias: parsed } = workflows.checkProjectAlias({ jira, alias });
  const issue = getJiraIssueCache().find((i) => i.key === key);
  let cleaned = parsed;
  if (cleaned && issue && groupNameKey(cleaned) === groupNameKey(issue.summary)) cleaned = null;
  if (cleaned) {
    const taken = projectNamesTaken({ excludeJira: key });
    if (taken.has(groupNameKey(cleaned))) throw new Error('같은 이름의 프로젝트가 이미 있어요.');
  }
  const before = projectLabelOf({ jira: key });
  const result = workflows.setProjectAlias({ jira: key, alias: cleaned });
  const after = projectLabelOf({ jira: key });
  if (before !== after) reportDrafts.relabelProject(`jira:${key}:`, before, after);
  return result;
}

// ---------- 직접 만든(그룹) 프로젝트 → 지라 에픽으로 옮기기 (BMOVE) ----------
// 지라 없이 그룹으로 시작했다가 나중에 에픽이 생기면 항목·회의·주간요약 소속을 통째로 그 에픽 쪽으로
// 옮긴다. renameProject와 같은 자리를 건드리되, 그룹 칸을 지우고 지라 칸을 새로 넣는다는 점이 다르다
// (renameProject는 그룹 칸의 값만 바꾼다). 옮긴 그룹은 항목이 없어져 목록에서 저절로 빠진다.
// 대상이 실제로 에픽인지(지라 계층 1)는 부르는 쪽(HTTP 라우트)이 지라를 읽어 먼저 확인한다 — 이
// 함수는 순수하게 파일만 옮긴다(지라에는 아무것도 묻지도 쓰지도 않는다).
const PROJECT_MOVE_KEY_RE = /^[A-Z][A-Z0-9]*-\d+$/;
function moveProject({ project, to, label }) {
  if (typeof project !== 'string' || !project.startsWith('group:')) throw new Error('직접 만든 프로젝트만 옮길 수 있어요.');
  const from = project.slice('group:'.length).replace(/_/g, ' ').trim();
  if (!from) throw new Error('프로젝트를 확인해 주세요.');
  const groups = workflows.groupList();
  if (!groups.includes(from)) throw new Error('프로젝트를 찾을 수 없어요.');
  if (typeof to !== 'string' || !PROJECT_MOVE_KEY_RE.test(to)) throw new Error('지라 번호를 확인해 주세요.');

  // ① 업무 파일의 줄 — 지라가 걸린 줄은 이미 지라라 건너뛴다. 아이디어는 `project:` 칸을 쓴다.
  const items = [];
  listTrackerFiles().forEach((filePath) => {
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    let touched = false;
    const next = lines.map((line) => {
      const match = line.match(TRACK_RE);
      if (!match) return line;
      const fields = parseFields(match[3]);
      if (fields.jira) return line;
      const key = match[2] === 'idea' ? 'project' : 'group';
      if (!fields[key] || fields[key].replace(/_/g, ' ') !== from) return line;
      const fieldStr = match[3].split(/\s+/)
        .filter((part) => { const at = part.indexOf(':'); return at === -1 || part.slice(0, at) !== key; })
        .concat(`jira:${to}`).join(' ');
      touched = true;
      if (fields.id) items.push(fields.id);
      return `- ${match[1]} #${match[2]}[${fieldStr}]`;
    });
    if (touched) fs.writeFileSync(filePath, next.join('\n'));
  });

  // ②④ 회의 프로젝트 · 수동 지라 연결(옮긴 뒤에는 뜻이 없으므로 지운다)
  const moved = workflows.moveGroup(from, to);

  // ⑤ 회의 제목 → 프로젝트 표
  const links = readMeetingLinks();
  const meetingLinks = [];
  for (const [title, value] of Object.entries(links)) {
    if (typeof value !== 'string' || !value.startsWith('group:')) continue;
    if (value.slice('group:'.length).replace(/_/g, ' ').trim() !== from) continue;
    links[title] = `jira:${to}`;
    meetingLinks.push(title);
  }
  if (meetingLinks.length) fs.writeFileSync(MEETING_LINKS_PATH, JSON.stringify(links, null, 2));

  // ⑥ 주간요약 저장본 — group:from: 행만 jira:to: 꼴로, 표시 이름은 부르는 쪽이 지은 label로.
  const reportRows = reportDrafts.moveGroup(from, to, label);

  // 이동 기록 — 되돌리기를 정확하게 하기 위한 서버 저장값일 뿐이라 화면에는 내려보내지 않는다.
  const moveId = `mv_${ulid()}`;
  const meetingCount = moved.ids.length + meetingLinks.length;
  workflows.recordProjectMove({
    id: moveId, from, to, at: new Date().toISOString(),
    items, meetings: moved.ids, links: moved.link !== null ? { [from]: moved.link } : null,
    // reportNames: 옮긴 소제목 이름 열쇠(`[주, 옛 열쇠, 새 열쇠]`) — 되돌리기가 자기가 옮긴 이름만 되돌리게.
    meetingLinks, reportRows, reportNames: reportRows.names || [], reportLabel: label,
    counts: { items: items.length, meetings: meetingCount, report: reportRows.length },
  });

  return {
    ok: true, project: `jira:${to}`, from, to, moveId,
    changed: { items: items.length, meetings: meetingCount, links: moved.link !== null ? 1 : 0, report: reportRows.length },
  };
}

// 옮기기의 반대 방향. **이동 기록에 남은 id들만** 되돌린다 — 그 사이 지워졌거나 다른 프로젝트로
// 다시 옮겨진 것은 건드리지 않고 건너뛴다(skipped로 센다). 한 번 되돌리면 기록은 지워져 다시는
// 되돌릴 수 없다(이름 바꾸기와 같은 태도).
function undoMoveProject({ moveId }) {
  if (typeof moveId !== 'string' || !moveId.trim()) throw new Error('되돌릴 기록을 확인해 주세요.');
  const entry = workflows.takeProjectMove(moveId);
  if (!entry) throw new Error('되돌릴 기록이 없어요.');
  const { from, to, items: itemIds, meetings: meetingIds, links, meetingLinks: meetingLinkTitles, reportRows, reportNames, reportLabel } = entry;

  // ① 업무 파일 — 기록된 id가 지금도 그 지라 키를 달고 있을 때만 되돌린다.
  const idSet = new Set(itemIds);
  let itemsRestored = 0, itemsSkipped = 0;
  listTrackerFiles().forEach((filePath) => {
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    let touched = false;
    const next = lines.map((line) => {
      const match = line.match(TRACK_RE);
      if (!match) return line;
      const fields = parseFields(match[3]);
      if (!fields.id || !idSet.has(fields.id)) return line;
      idSet.delete(fields.id);
      if (fields.jira !== to) { itemsSkipped += 1; return line; }
      const key = match[2] === 'idea' ? 'project' : 'group';
      const fieldStr = match[3].split(/\s+/)
        .filter((part) => { const at = part.indexOf(':'); return at === -1 || part.slice(0, at) !== 'jira'; })
        .concat(`${key}:${from.replace(/\s+/g, '_')}`).join(' ');
      touched = true;
      itemsRestored += 1;
      return `- ${match[1]} #${match[2]}[${fieldStr}]`;
    });
    if (touched) fs.writeFileSync(filePath, next.join('\n'));
  });
  itemsSkipped += idSet.size; // 기록에는 있었지만 지금은 그 id 자체가 없다(그 사이 지워짐).

  // ②④ 회의 프로젝트 · 수동 지라 연결
  const movedBack = workflows.undoMoveGroup({ from, to, meetingIds, link: links ? links[from] : null });

  // ⑤ 회의 제목 → 프로젝트 표
  const linkState = readMeetingLinks();
  let meetingLinksRestored = 0, meetingLinksSkipped = 0;
  meetingLinkTitles.forEach((title) => {
    if (linkState[title] === `jira:${to}`) { linkState[title] = `group:${from}`; meetingLinksRestored += 1; }
    else meetingLinksSkipped += 1;
  });
  if (meetingLinksRestored) fs.writeFileSync(MEETING_LINKS_PATH, JSON.stringify(linkState, null, 2));

  // ⑥ 주간요약 저장본
  const reportUndo = reportDrafts.moveGroupUndo(reportRows, from, to, reportLabel, reportNames);

  return {
    ok: true, project: `group:${from}`,
    restored: {
      items: itemsRestored,
      meetings: movedBack.restored + meetingLinksRestored,
      report: reportUndo.restored,
    },
    skipped: itemsSkipped + movedBack.skipped + meetingLinksSkipped + reportUndo.skipped,
  };
}

function promoteIdeaToToday(id, due) {
  validateDate(due);
  const isIdea = listTrackerFiles().some(file => fs.readFileSync(file, 'utf-8').split('\n').some(line => {
    const m = line.match(TRACK_RE);
    return m && m[2] === 'idea' && parseFields(m[3]).id === id;
  }));
  if (!isIdea) return { ok: false, error: 'idea not found' };
  const removed = removeTrackItem(id, false);
  if (!removed || removed.type !== 'idea') return { ok: false, error: 'idea not found' };
  return createManualTask({ description: removed.description, priority: removed.fields.priority, scheduled: due || todayLocal() });
}

// ---------- 주간 요약 (tracker/weekly_reports.md) ----------
// 읽기 전용: 예전에 쓰던 이 파일은 더 이상 앱이 고치지 않는다. 지금 편집은 보고 기록
// (report-drafts.js / tracker/.report-drafts.json)에 저장하고, 여기서는 옛 내용을 읽어 보여주기만 한다.

function mondayOf(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d;
}

function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function currentWeekKey() {
  return fmtDate(mondayOf(new Date()));
}

function weeklyReportsPath() {
  return path.join(TRACKER_DIR, 'weekly_reports.md');
}

function weeklyReportStatePath() {
  return path.join(process.env.WORKSPACE_DATA_DIR || __dirname, '.weekly_report_state.json');
}

function parseWeeklyReports() {
  const p = weeklyReportsPath();
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, 'utf-8');
  const parts = raw.split(/\n## /).slice(1);
  return parts.map((part) => {
    const newlineIdx = part.indexOf('\n');
    const weekKey = part.slice(0, newlineIdx).trim();
    const body = part.slice(newlineIdx + 1).replace(/\n+$/, '');
    return { weekKey, body };
  });
}

// 자동 row의 group·evidence[].label이 이 값을 그대로 쓴다(report-drafts.js의 getReportRefs 연결) —
// 별칭이 있으면 그 이름이 주간요약 소제목·근거에도 붙는다(BJALIAS).
function projectLabelOf(item) {
  if (item.jira) {
    const issue = getJiraIssueCache().find((i) => i.key === item.jira);
    const name = projectDisplayName(item.jira, issue ? issue.summary : '');
    return name ? `${item.jira} · ${name}` : item.jira;
  }
  return item.group || null;
}

// 요약에서 참조하는 원본들의 현재 상태 — 그룹 실시간 표시와 "이미 해결됨" 표시에 쓰인다
function getReportRefs() {
  if(readScope?.refs)return readScope.refs;
  const refs = {};
  listTrackerFiles().forEach((filePath) => {
    fs.readFileSync(filePath, 'utf-8').split('\n').forEach((line) => {
      const m = line.match(TRACK_RE);
      if (!m) return;
      const fields = parseFields(m[3]);
      if (!fields.id) return;
      refs[fields.id] = {
        id: fields.id,
        type: m[2],
        description: m[1],
        status: fields.status || 'to-do',
        created: fields.created || null,
        completed: fields.completed || null,
        scheduled: plannedDay(fields),
        due: fields.due || null,
        doing: fields.doing || null,
        who: fields.who ? fields.who.replace(/_/g, ' ') : null,
        priority: fields.priority || 'medium',
        permalink: fields.source?.startsWith('slack:') ? fields.source.slice(6) : null,
        jira: fields.jira || null,
        group: fields.group ? fields.group.replace(/_/g, ' ') : null,
        label: projectLabelOf({ jira: fields.jira, group: fields.group ? fields.group.replace(/_/g, ' ') : null }),
        project: fields.project ? fields.project.replace(/_/g, ' ') : null,
      };
    });
  });
  if(readScope)readScope.refs=refs;
  return refs;
}

// ---------- HTTP 서버 ----------

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

// ---------- 앱 정보 (GET /api/about) ----------
// 지금 버전·데이터 형식·받는 갈래와, 이 설치가 저장소에서 벗어났는지(고친 파일)를 알려 준다.
// 파일은 쓰지 않고, git이 없거나 실패하면 조용히 `null`이다. 예외 하나: 자동 업데이트(WP-U)로 요청한 버전이 실패·되돌려진 것을
// 처음 보면 `local/auto-update.json`에 `failed: true`를 한 번 쓸 수 있다(업무 데이터가 아닌 이 맥의 기록 한 파일).
const VERSION_PATH = path.join(REPO_DIR, 'VERSION');
const NEWS_PATH = path.join(REPO_DIR, '소식.md');
const REMOTE_CHECK_INTERVAL_MS = 60 * 60 * 1000;   // 1시간에 한 번(WP-U — 배포가 잦아 하루 안에 받게)
let latestRelease = null;        // { tag, checkedAt } — 메모리에만 둔다
let remoteCheckTimer = null;
let remoteChecking = false;

function appVersion() {
  try { return nativeFs.readFileSync(VERSION_PATH, 'utf8').trim() || null; } catch { return null; }
}

// 저장소 뿌리의 소식.md(WP-J) — 최근 10개 버전만. 파일이 없거나 못 읽으면 조용히 빈 목록이다.
// 지금 버전보다 새 버전의 소식은 빼고 준다(배포 직전이거나 main 갈래라 소식.md가 앞서 있어도 `지난 소식`에는 받은 것만).
function localNews() {
  const version = appVersion();
  try {
    return parseNews(nativeFs.readFileSync(NEWS_PATH, 'utf8'))
      .filter(entry => !version || compareVersions(entry.version, version) <= 0)
      .slice(0, NEWS_MAX_VERSIONS);
  } catch { return []; }
}

function git(args, timeout = 3000) {
  return new Promise((resolve) => {
    try {
      execFile('git', args, { cwd: REPO_DIR, timeout, maxBuffer: 1024 * 1024 }, (error, stdout) => resolve(error ? null : String(stdout)));
    } catch { resolve(null); }
  });
}

// 추적 파일의 수정·삭제만 센다 — 미추적·gitignore는 빠지므로 업무 데이터는 여기 잡히지 않는다.
// 파일 이름만 쓰고 내용은 읽지 않는다.
async function gitModified() {
  // `core.quotepath=false` — 한글 파일 이름이 8진수 escape(`\354\227…`)로 오지 않게(문제 보고에 그대로 실린다).
  // `--no-optional-locks` — 1분 판단이 부르는 조회가 index.lock을 잡아 사람의 git 작업과 부딪치지 않게.
  const out = await git(['--no-optional-locks', '-c', 'core.quotepath=false', 'status', '--porcelain']);
  if (out === null) return null;
  return out.split('\n').filter(Boolean).filter((line) => {
    const state = line.slice(0, 2);
    if (state.includes('?') || state.includes('!')) return false;
    return state.includes('M') || state.includes('D');
  }).map((line) => line.slice(3).split(' -> ').pop().replace(/^"|"$/g, '')).sort();
}

function compareVersions(a, b) {
  const left = a.replace(/^v/, '').split('.').map(Number);
  const right = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((left[i] || 0) !== (right[i] || 0)) return (left[i] || 0) - (right[i] || 0);
  return 0;
}

// 새 버전이 나왔는지 원격에 묻는다(설정과 무관하게 돈다 — 연동을 다 끈 사람도 업데이트는 받는다).
// stable 갈래는 원격 태그 중 가장 높은 것, main 갈래는 원격 main의 커밋이 지금 HEAD와 다르고 이 저장소에
// 아직 없는 커밋인지를 본다. 쓰는 git은 읽기 전용(`ls-remote`·`rev-parse`)뿐이고, 실패해도 조용히 지나가며 파일은 쓰지 않는다.
const REMOTE_STALE_MS = 30 * 60 * 1000;   // 설정을 열 때 이보다 묵었으면 한 번 더 묻는다
let remoteCheckedAt = 0;                  // 마지막으로 원격에 물어본 때(성공·실패 무관)
let remoteCheckRun = null;                // 지금 도는 확인(같은 때 두 번 묻지 않는다)
let latestMain = null;                    // { sha, newer, checkedAt } — main 갈래일 때만

// 지금 갈래 — 뜰 때 읽은 설정과 지금 설정 파일 둘 중 하나라도 main이면 main(WP-U). 앱 정보(`channel`)·새 버전 판단·
// 자동 업데이트·체크인이 모두 이 함수 하나를 쓴다(뜰 때만 읽던 값과 화면이 말하는 갈래가 어긋나지 않게).
function updateChannel() {
  const onDisk = ((currentConfigFile().server) || {}).updateChannel;
  return CONFIG.server?.updateChannel === 'main' || onDisk === 'main' ? 'main' : 'stable';
}

async function checkLatestMain() {
  const out = await git(['ls-remote', 'origin', 'refs/heads/main'], 10000);
  const match = out && /^([0-9a-f]{40,64})\s+refs\/heads\/main$/m.exec(out);
  if (!match) return latestMain;
  const sha = match[1];
  const head = String((await git(['rev-parse', 'HEAD'])) || '').trim();
  // 이 저장소가 이미 그 커밋을 갖고 있으면(내가 앞서 있거나 방금 받음) 새 버전이 아니다.
  const have = await git(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]);
  return { sha, newer: !!head && sha !== head && !have, checkedAt: new Date().toISOString() };
}

// 원격 소식(WP-J) — 새 버전이 있을 때만, 그 태그(main 갈래는 main) 소식.md를 읽어 둔다.
// 실제 fetch는 테스트가 `setRemoteFetchForTests`로 갈아끼운다(기본은 전역 fetch, 네트워크 하나뿐).
let remoteFetch = (...args) => fetch(...args);
function setRemoteFetchForTests(fn) { remoteFetch = typeof fn === 'function' ? fn : ((...args) => fetch(...args)); }
// 테스트 전용 — 진짜 `git ls-remote`(네트워크) 없이 "새 버전이 있다"를 가정하려고 쓴다.
function setLatestReleaseForTests(value) { latestRelease = value; }
let remoteNews = null; // { channel, ref, version, lines } — 지금 제안 중인 버전과 정확히 맞을 때만 쓴다

async function refreshRemoteNews(channel) {
  const version = appVersion();
  const offer = updateOffer(version, channel);
  if (!offer.available) { remoteNews = null; return; }
  const repo = githubRepoFrom(await git(['remote', '-v']));
  const ref = channel === 'main' ? 'main' : offer.label;
  if (!repo || !ref) { remoteNews = null; return; }
  const text = await fetchRemoteNewsText({ owner: repo.owner, repo: repo.repo, ref, request: remoteFetch });
  if (!text) { remoteNews = null; return; }
  const entries = parseNews(text);
  const entry = channel === 'main' ? entries[0] : entries.find((item) => `v${item.version}` === ref);
  remoteNews = entry ? { channel, ref, version: entry.version, lines: entry.lines } : null;
}

function checkLatestRelease() {
  if (remoteCheckRun) return remoteCheckRun;
  remoteChecking = true;
  remoteCheckedAt = Date.now();
  remoteCheckRun = (async () => {
    const out = await git(['ls-remote', '--tags', 'origin'], 10000);
    const tags = out ? [...out.matchAll(/refs\/tags\/(v\d+\.\d+\.\d+)(?:\^\{\})?$/gm)].map((match) => match[1]) : [];
    if (tags.length) latestRelease = { tag: tags.sort(compareVersions)[tags.length - 1], checkedAt: new Date().toISOString() };
    const channel = updateChannel();
    if (channel === 'main') latestMain = await checkLatestMain();
    await refreshRemoteNews(channel);
  })().catch(() => {}).finally(() => {
    remoteChecking = false;
    remoteCheckRun = null;
  });
  return remoteCheckRun;
}

function startRemoteCheck() {
  if (remoteCheckTimer || process.env.WORKSPACE_NO_REMOTE_CHECK) return;
  remoteCheckTimer = setInterval(checkLatestRelease, REMOTE_CHECK_INTERVAL_MS);
  if (remoteCheckTimer.unref) remoteCheckTimer.unref();
  checkLatestRelease();
}

// 설정을 열 때(= /api/about) 확인이 30분 넘게 묵었으면 한 번 더 묻고, 도는 확인은 5초까지만 기다린다.
async function freshRemoteCheck() {
  if (process.env.WORKSPACE_NO_REMOTE_CHECK) return;
  startRemoteCheck();
  if (Date.now() - remoteCheckedAt > REMOTE_STALE_MS) checkLatestRelease();
  if (!remoteCheckRun) return;
  let timer = null;
  await Promise.race([remoteCheckRun, new Promise((resolve) => { timer = setTimeout(resolve, 5000); })]);
  clearTimeout(timer);
}

// origin이 github.com일 때만 소유자/저장소 이름을 뽑는다(원격 주소에 섞인 다른 글자는 담지 않는다).
// `무엇이 바뀌었나요 ↗`와 원격 소식(WP-J) 읽기가 함께 쓴다.
function githubRepoFrom(remotes) {
  const match = typeof remotes === 'string' && /^origin\s+(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?\s+\(fetch\)$/m.exec(remotes);
  return match ? { owner: match[1], repo: match[2] } : null;
}
function changesUrlFrom(remotes, channel) {
  const repo = githubRepoFrom(remotes);
  if (!repo) return null;
  return `https://github.com/${repo.owner}/${repo.repo}/${channel === 'main' ? 'commits/main' : 'releases'}`;
}
async function changesUrl(channel) {
  return changesUrlFrom(await git(['remote', '-v']), channel);
}

// 설정 › 앱의 `업데이트 받기`가 쓰는 한 덩어리 — 새 버전이 있는지와 무엇으로 부를지.
// `news`는 원격에서 읽은 그 버전의 쉬운 말 줄(WP-J) — 갈래·태그가 지금 제안과 정확히 같을 때만 싣고, 그 밖엔 null이다.
function updateOffer(version, channel) {
  if (channel === 'main') {
    const available = !!(latestMain && latestMain.newer);
    const news = available && remoteNews && remoteNews.channel === 'main' ? remoteNews.lines : null;
    return { available, label: 'main', checkedAt: latestMain ? latestMain.checkedAt : null, news };
  }
  const tag = latestRelease && latestRelease.tag;
  const available = !!(tag && version && compareVersions(tag, version) > 0);
  const news = available && remoteNews && remoteNews.channel === 'stable' && remoteNews.ref === tag ? remoteNews.lines : null;
  return { available, label: tag || null, checkedAt: latestRelease ? latestRelease.checkedAt : null, news };
}

const updateCommandPath = () => personalize.tildePath(path.join(REPO_DIR, '업데이트.command'), os.homedir());

// `cached`면(페이지를 열 때·1시간마다 톱니바퀴의 파란 점) 원격에 새로 묻지 않고 가진 값만 준다 —
// 1시간 주기 확인이 아직 안 걸려 있으면 그 주기만 건다(설정을 열 때와 같은 한 번).
// `check`면(설정 › 앱의 `새 버전 확인` 버튼) 1분 안에 물어본 적이 없을 때 원격에 곧바로 묻고 10초까지 기다린다
// (화면 요청의 15초 제한 안에 끝나게) —
// 배포 직후 1시간·30분 주기를 기다리지 않게.
const REMOTE_MANUAL_MIN_MS = 60 * 1000;
async function manualRemoteCheck() {
  if (process.env.WORKSPACE_NO_REMOTE_CHECK) return;
  startRemoteCheck();
  if (Date.now() - remoteCheckedAt > REMOTE_MANUAL_MIN_MS) checkLatestRelease();
  if (!remoteCheckRun) return;
  let timer = null;
  await Promise.race([remoteCheckRun, new Promise((resolve) => { timer = setTimeout(resolve, 10000); })]);
  clearTimeout(timer);
}
async function aboutApp({ cached = false, check = false } = {}) {
  if (check) await manualRemoteCheck();
  else if (cached) startRemoteCheck();
  else await freshRemoteCheck();
  const channel = updateChannel();
  const [modified, ref, changes] = await Promise.all([gitModified(), git(['rev-parse', '--short', 'HEAD']), changesUrl(channel)]);
  const version = appVersion();
  const offer = updateOffer(version, channel);
  // 쉬는 틈에 자동 업데이트(WP-U) — 스위치·오늘 탭 한 줄의 재료. 자격 없는 자리(main·개발용)면 notice는 늘 null이다.
  const auto = await autoUpdateView(offer, modified);
  return {
    version,
    dataFormat: DATA_FORMAT_VERSION,
    channel,
    // launchd가 KeepAlive로 띄운 자리에는 setup.sh가 이 표시를 넣어 둔다(개발용 서버·픽스처에는 없다).
    install: process.env.WORKSPACE_MANAGED ? 'managed' : 'manual',
    gitRef: ref ? ref.trim() : null,
    modified,
    latest: latestRelease,
    // `새 버전 확인`을 눌렀을 때 최근 90초 안에 원격 태그를 실제로 받았는지 — 못 받았으면 화면이 "최신이에요" 대신 "확인하지 못했어요"라고 한다.
    ...(check ? { checkReached: !!(latestRelease && Date.now() - Date.parse(latestRelease.checkedAt) < 90 * 1000) } : {}),
    update: { ...offer, changesUrl: changes, auto },
    // 설정 › 앱의 `지난 소식 전체`(WP-J) — 저장소 소식.md의 최근 10개 버전. 파일이 없으면 빈 목록이다.
    news: localNews(),
    // 설정 › 앱 › 앱 위치 — 사람이 Finder의 `폴더로 이동`에 붙여 넣을 업데이트 파일 경로(홈은 `~`로 줄인다).
    // 서버는 Finder를 열거나 프로세스를 띄우지 않고 글자만 준다.
    updateFile: updateCommandPath(),
  };
}

// ---------- 설정 › 앱: 데이터 백업 상태 (GET /api/backup) ----------
// backup-data.sh(launchd `data-backup`, 매일 19:30)가 남기는 로그 두 갈래를 읽는다:
//   `YYYY-MM-DD HH:MM:SS 로컬 성공 · 7일치` / `… 로컬 실패 — 이유`
//   `… GitHub 성공` / `… GitHub 실패 — 이유` / `… GitHub 건너뜀 — 이유`
// 며칠치인지는 `daily/` 안에서 이름이 정확히 `YYYY-MM-DD`인 폴더만 센다. 읽기만 하고 아무것도 실행하지 않는다.
const BACKUP_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const BACKUP_STATE = { 성공: 'ok', 실패: 'fail', 건너뜀: 'skip' };
function backupStatus() {
  const daily = path.join(backupDir(), 'daily');
  let days = [];
  try {
    days = nativeFs.readdirSync(daily, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && BACKUP_DAY_RE.test(entry.name)).map(entry => entry.name);
  } catch { days = []; }
  let local = null;
  let github = null;
  const reason = value => (value ? String(value).slice(0, 200) : null);
  tailLines(path.join(automationLogDir(), 'data-backup.log'), 400).map(cleanLogLine).forEach((line) => {
    const row = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (.+)$/.exec(line.trim());
    if (!row) return;
    const [, time, text] = row;
    let hit = /^로컬 (성공|실패)(?: · \d+일치| — (.+))?$/.exec(text);
    if (hit) { local = { state: BACKUP_STATE[hit[1]], at: time, reason: reason(hit[2]) }; return; }
    hit = /^GitHub (성공|실패|건너뜀)(?: — (.+))?$/.exec(text);
    if (hit) { github = { state: BACKUP_STATE[hit[1]], at: time, reason: reason(hit[2]) }; return; }
    // GitHub 백업만 하던 예전 로그의 줄도 읽는다.
    if (/^(백업 커밋 완료|변경 없음|원격 업로드 완료)$/.test(text)) { github = { state: 'ok', at: time, reason: null }; return; }
    hit = /^백업 실패 — (.+)$/.exec(text);
    if (hit) github = { state: 'fail', at: time, reason: reason(hit[1]) };
  });
  // GitHub 백업이 켜진 사람 — 백업용 Git 저장 공간이 있고 원격(비공개 저장소)이 연결돼 있을 때(설정 파일 글자만 본다).
  let gitConfig = '';
  try { gitConfig = nativeFs.readFileSync(path.join(automationDir(), 'data-backup.git', 'config'), 'utf8'); } catch { gitConfig = ''; }
  const localView = local
    || (days.length ? { state: 'ok', at: null, reason: null } : { state: 'never', at: null, reason: null });
  return {
    ok: true,
    path: personalize.tildePath(daily, os.homedir()),
    local: { ...localView, days: days.length },
    github: { on: /\[remote "origin"\]/.test(gitConfig), ...(github || { state: 'never', at: null, reason: null }) },
  };
}

// ---------- 앱 안에서 업데이트 받기 (POST /api/update · GET /api/update/status) ----------
// 서버는 업데이트를 **직접 돌리지 않는다**(프로세스를 띄우지 않는다 — 지금 가져오기와 같은 원칙). 요청 표시 파일
// `requests/update.request`(action·requestedAt) 하나만 쓰고, 그걸 지켜보던 launchd(`com.workspace.app.update`)가
// 설치 위치 복사본의 `update-runner.sh`를 돌린다. 진행 상황은 update.sh가 `update-status.json`에 단계마다 쓰고,
// 서버는 그 파일을 읽어 주기만 한다. 실패해도 자동으로 되돌리지 않는다(사람이 `이전 버전으로 되돌리기`를 누른다).
const UPDATE_ACTIONS = ['update', 'rollback'];
const UPDATE_RUNNING_MS = 10 * 60 * 1000;
const UPDATE_STEP_STATES = ['done', 'doing', 'todo', 'failed'];
const UPDATE_MESSAGE = {
  action: '무엇을 할지 확인해 주세요.',
  relocate: '폴더를 옮겨야 하는 업데이트예요 — 업데이트.command를 더블클릭해 주세요',
  notInstalled: '처음 한 번은 업데이트.command로 받아 주세요',
  running: '이미 업데이트하는 중이에요',
  nothingToUndo: '되돌릴 것이 없어요 — 앱과 데이터는 그대로예요',
};
// `이전 버전으로 되돌리기`는 업데이트가 ③ 새 버전 받기 이후에서 멈췄을 때만 의미가 있다(①② 실패는 코드가 그대로다).
// 실행기가 죽어 running에 머문 채 10분이 지난 것도 멈춘 것으로 본다.
const UPDATE_ROLLBACK_FROM_STEP = 3;
function rollbackAllowed(status) {
  if (!status || status.action !== 'update' || status.step < UPDATE_ROLLBACK_FROM_STEP) return false;
  if (updateSettled(status)) return false;
  return status.state === 'failed' || (status.state === 'running' && !updateRecent(status.updatedAt));
}
// 멈춘 업데이트 뒤에 다른 업데이트가 끝까지 돌았는가. update.sh는 ③에서 되돌릴 자리(.workspace-last-good)를
// 늘 새로 적고, 터미널(업데이트.command)로 받은 업데이트는 상태 파일을 쓰지 않는다 — 그 파일이 멈춘 기록보다
// 새것이면 옛 실패는 지난 일이다(화면에 다시 띄우지 않고, 그 기록으로 되돌리지도 않는다). 파일은 읽기만 한다.
const updateLastGoodPath = () => path.join(REPO_DIR, '.workspace-last-good');
function updateSettled(status) {
  if (!status || status.state === 'done') return false;
  const at = Date.parse(status.updatedAt || status.finishedAt || '');
  if (!Number.isFinite(at)) return false;
  try { return nativeFs.statSync(updateLastGoodPath()).mtimeMs > at + 1000; } catch { return false; }
}
const updateRequestPath = () => path.join(automationDir(), 'requests', 'update.request');
const updateStatusPath = () => path.join(automationDir(), 'update-status.json');

function readJsonFile(file) {
  try { return JSON.parse(nativeFs.readFileSync(file, 'utf8')); } catch { return null; }
}
const shortText = (value, max = 200) => (typeof value === 'string' && value ? value.slice(0, max) : null);

// 상태 파일은 정해 둔 칸만 옮겨 싣는다(다른 글자가 섞여 있어도 응답으로 나가지 않는다).
function readUpdateStatus() {
  const raw = readJsonFile(updateStatusPath());
  if (!raw || typeof raw !== 'object') return null;
  let mtime = null;
  try { mtime = nativeFs.statSync(updateStatusPath()).mtime.toISOString(); } catch { mtime = null; }
  const steps = Array.isArray(raw.steps) ? raw.steps.slice(0, 8)
    .filter(step => step && typeof step.name === 'string')
    .map(step => ({ name: step.name.slice(0, 40), state: UPDATE_STEP_STATES.includes(step.state) ? step.state : 'todo' })) : [];
  return {
    action: raw.action === 'rollback' ? 'rollback' : 'update',
    from: shortText(raw.from, 40),
    to: shortText(raw.to, 40),
    step: Number.isInteger(raw.step) ? raw.step : 0,
    steps,
    state: ['running', 'done', 'failed'].includes(raw.state) ? raw.state : 'failed',
    message: shortText(raw.message),
    startedAt: shortText(raw.startedAt, 40),
    updatedAt: shortText(raw.updatedAt, 40) || mtime,
    finishedAt: shortText(raw.finishedAt, 40),
  };
}

// 요청했는데 아직 실행기가 집어 가지 않은 것(실행기는 읽자마자 요청 파일을 지운다).
function readUpdateRequest() {
  const raw = readJsonFile(updateRequestPath());
  if (!raw || !UPDATE_ACTIONS.includes(raw.action)) return null;
  return { action: raw.action, requestedAt: shortText(raw.requestedAt, 40) };
}

const updateRecent = (iso) => { const at = Date.parse(iso || ''); return Number.isFinite(at) && Date.now() - at < UPDATE_RUNNING_MS; };
function updateInProgress(status, pending) {
  if (status && status.state === 'running' && updateRecent(status.updatedAt)) return true;
  return !!(pending && updateRecent(pending.requestedAt));
}

function updateStatusView() {
  const status = readUpdateStatus();
  const pending = readUpdateRequest();
  // `rollback`은 서버가 지금 되돌리기를 받는지, `settled`는 멈춘 기록 뒤에 다른 업데이트가 끝났는지 —
  // 설정 › 앱을 새로 열었을 때 지난 실패 줄(+ 되돌리기·다시 시도)을 다시 보일지 화면이 이 둘로 정한다.
  return {
    ok: true, status, pending, running: updateInProgress(status, pending), updateFile: updateCommandPath(),
    rollback: rollbackAllowed(status), settled: updateSettled(status),
  };
}

// 회사(playio) 폴더 안인가 — install-location.sh와 같은 규칙(실제 경로 칸에 playio, 또는 바깥 저장소 remote에 playio).
// 바깥 저장소는 읽기 전용 git(`rev-parse --show-toplevel`·`remote -v`)으로만 본다.
async function installNeedsMove() {
  let real;
  try { real = nativeFs.realpathSync(REPO_DIR); } catch { return false; }
  if (/playio/i.test(real)) return true;
  const top = String((await git(['-C', path.dirname(real), 'rev-parse', '--show-toplevel'])) || '').trim();
  if (!top) return false;
  return /playio/i.test(String((await git(['-C', top, 'remote', '-v'])) || ''));
}

// 막는 경우는 파일을 쓰지 않고 이유를 200 `ok:false`로 돌려준다(브라우저 콘솔 오류를 남기지 않게).
// 모르는 action만 400이다.
async function requestUpdate(action) {
  if (!UPDATE_ACTIONS.includes(action)) return fetchFail(400, 'action', UPDATE_MESSAGE.action);
  const view = updateStatusView();
  if (view.running) return fetchAnswer(200, { ...view, ok: false, reason: 'running', message: UPDATE_MESSAGE.running });
  if (await installNeedsMove()) return fetchAnswer(200, { ok: false, reason: 'relocate', message: UPDATE_MESSAGE.relocate, updateFile: view.updateFile });
  if (!launchAgentInstalled('update')) return fetchAnswer(200, { ok: false, reason: 'not-installed', message: UPDATE_MESSAGE.notInstalled, updateFile: view.updateFile });
  if (action === 'rollback' && !rollbackAllowed(view.status)) return fetchAnswer(200, { ok: false, reason: 'nothing-to-undo', message: UPDATE_MESSAGE.nothingToUndo });
  const requestedAt = new Date().toISOString();
  const file = updateRequestPath();
  nativeFs.mkdirSync(path.dirname(file), { recursive: true });
  nativeFs.writeFileSync(file, `${JSON.stringify({ action, requestedAt })}\n`);
  return fetchAnswer(200, { ok: true, action, requestedAt });
}

// ---------- 쉬는 틈에 자동 업데이트 (WP-U, auto-update.js) ----------
// 판단은 auto-update.js, 요청은 위 requestUpdate('update')와 같은 길(요청 표시 파일 하나)이다 — 프로세스를 띄우지 않는다.
// **main 갈래면 절대 요청하지 않는다**(뜰 때 읽은 설정과 지금 설정 파일 둘 중 하나라도 main이면 main으로 본다).
// launchd로 띄운 설치본(WORKSPACE_MANAGED)에서만 켜지고, 개발용 서버·테스트·픽스처는 꺼짐이다.
// 쉬는 중 = 마지막 쓰기 요청(POST, 슬랙 수집의 `/api/import` 제외)으로부터 10분 — 화면의 5분 목록 새로 받기(GET)는 세지 않는다.
const autoUpdateModule = require('./auto-update');
const autoUpdateTest = { environment: null, localDir: null, idleMs: null, today: null };
// 테스트·픽스처 전용 — 환경 판단·임시 local/·쉬는 시간·오늘 날짜를 끼운다(값을 안 주면 원래대로). main 갈래 판단은 끼울 수 없다.
function setAutoUpdateForTests(options = {}) {
  autoUpdateTest.environment = typeof options.environment === 'boolean' ? options.environment : null;
  autoUpdateTest.localDir = options.localDir || null;
  autoUpdateTest.idleMs = Number.isFinite(options.idleMs) ? options.idleMs : null;
  autoUpdateTest.today = options.today || null;
}
const autoUpdateChannel = () => updateChannel();
function autoUpdateEnvironment() {
  if (autoUpdateTest.environment !== null) return autoUpdateTest.environment;
  return !!process.env.WORKSPACE_MANAGED && !process.env.WORKSPACE_NO_REMOTE_CHECK && !process.env.WORKSPACE_FIXTURE;
}
// 설정 › 앱의 `자동으로 업데이트` 스위치 — 기본 켜짐, `server.autoUpdate: false`일 때만 꺼짐.
const autoUpdateOn = () => ((currentConfigFile().server) || {}).autoUpdate !== false;
// 쉬는 시간은 테스트에서만 줄인다(`WORKSPACE_AUTO_UPDATE_IDLE_MS` — 실제 서버를 띄우는 테스트용).
function autoUpdateIdleMs() {
  if (autoUpdateTest.idleMs !== null) return autoUpdateTest.idleMs;
  const fromEnv = Number(process.env.WORKSPACE_AUTO_UPDATE_IDLE_MS);
  return process.env.WORKSPACE_AUTO_UPDATE_IDLE_MS && Number.isFinite(fromEnv) && fromEnv >= 0 ? fromEnv : autoUpdateModule.AUTO_UPDATE_IDLE_MS;
}
const autoUpdate = autoUpdateModule.createAutoUpdate({
  channel: autoUpdateChannel,
  environment: autoUpdateEnvironment,
  enabled: autoUpdateOn,
  offer: () => updateOffer(appVersion(), autoUpdateChannel()),
  status: () => updateStatusView(),
  recoveryNeeded: () => !!mutations.status().recoveryNeeded,
  agentInstalled: () => launchAgentInstalled('update'),
  automationBusy: () => autoUpdateModule.automationBusy({ automationDir: automationDir(), logDir: automationLogDir() }),
  needsMove: () => installNeedsMove(),
  modified: () => gitModified(),
  localDir: () => autoUpdateTest.localDir || LOCAL_DIR,
  idleMs: autoUpdateIdleMs,
  today: () => autoUpdateTest.today || todayLocal(),
  request: () => requestUpdate('update'),
  devRepo: () => repoHasManyWorktrees(),
});
// git worktree가 둘 이상이면 만든 사람의 개발 저장소로 보고 자동 업데이트에서 뺀다(읽기 전용 git, 실패하면 뺀다).
// 결과는 10분 메모리에 들고 있는다(1분 판단마다 git을 부르지 않게).
const WORKTREE_CACHE_MS = 10 * 60 * 1000;
let worktreeCache = null;
async function repoHasManyWorktrees() {
  if (worktreeCache && Date.now() - worktreeCache.at < WORKTREE_CACHE_MS) return worktreeCache.value;
  const out = await git(['worktree', 'list', '--porcelain']);
  const value = out === null ? true : out.split('\n').filter(line => line.startsWith('worktree ')).length > 1;
  worktreeCache = { at: Date.now(), value };
  return value;
}
// 뜰 때 한 번 건다(require.main 자리) — 자격이 없는 자리(개발용·main·테스트)면 타이머도 원격 확인도 걸지 않는다.
function startAutoUpdate() {
  if (autoUpdateChannel() === 'main' || !autoUpdateEnvironment()) return;
  startRemoteCheck();
  const tickMs = Number(process.env.WORKSPACE_AUTO_UPDATE_TICK_MS);
  autoUpdate.start(process.env.WORKSPACE_AUTO_UPDATE_TICK_MS && Number.isFinite(tickMs) && tickMs >= 200 ? tickMs : undefined);
}
// GET /api/about에 싣는 한 덩어리 — 스위치를 보일지(`eligible`), 켜져 있는지(`on`), 오늘 탭 한 줄의 이유(`notice`).
async function autoUpdateView(offer, modified) {
  const eligible = autoUpdateChannel() !== 'main' && autoUpdateEnvironment() && !(await autoUpdate.devRepo());
  let notice = null;
  if (eligible && offer && offer.available) {
    try { notice = await autoUpdate.noticeReason({ modified }); } catch { notice = null; }
  }
  return { eligible, on: autoUpdateOn(), notice };
}

// 지금 앱 이름(`server.dockName`, 없거나 규칙에 안 맞으면 `워크스페이스` — manifest와 같은 기본값). 설정을 새로 읽는다.
function currentDockName() {
  try { return personalize.checkDockName(((currentConfigFile().server) || {}).dockName); } catch { return personalize.DOCK_NAME_DEFAULT; }
}

// ---------- 설정 > 연동 ----------
// `workspace.config.json`을 앱이 쓰는 **단 하나의 자리**다(DECISIONS 2026-09-23). 저장할 때마다
// 파일을 새로 읽어 합치므로, 그 사이 사람이 손으로 적어 둔 값도 그대로 남는다.
// 토큰은 config에 적지 않는다 — 파일(0600)로만 두고 경로만 적는다.
function currentConfigFile() {
  try { return JSON.parse(nativeFs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}
// 슬랙 채널 이름 따라가기(연동 탭을 열 때). 테스트는 `WORKSPACE_NO_REMOTE_CHECK`로 바깥에 묻지 않게 하므로
// 그때는 끄고, 가짜 슬랙을 끼운 테스트·픽스처만 `WORKSPACE_SLACK_FOLLOW=1`로 다시 켠다.
// 슬랙 토큰 갱신 요청이 나가는 길 — 테스트·픽스처(`WORKSPACE_NO_REMOTE_CHECK`)에서는 바깥에 닿지 않고,
// `setSlackRefreshFetchForTests`로 가짜만 끼운다(점검하기의 selfcheckRequest와 같은 규칙).
let slackRefreshFetch = null;
function setSlackRefreshFetchForTests(fn) { slackRefreshFetch = typeof fn === 'function' ? fn : null; }
function slackRefreshRequest(...args) {
  if (slackRefreshFetch) return slackRefreshFetch(...args);
  if (process.env.WORKSPACE_NO_REMOTE_CHECK) return Promise.reject(new Error('바깥 확인을 끈 자리예요'));
  return fetch(...args);
}
// 저장된 연결로 지금 쓸 수 있는 슬랙 토큰(새 방식이면 만료가 가까울 때 갱신한 뒤의 것) — 서버 안에서만 쓰고 싣지 않는다.
// 다시 연결해야 하면 빈 글자.
const slackTokenNow = (config, tokenDir) => integrations.slackTokenForUse(config, { tokenDir, request: slackRefreshRequest }).catch(() => '');
// 자동 갱신 타이머(새 방식) — 15분마다 보고 만료 60분 전이면 미리 갱신한다. `.legacy` 7일 뒤 지우기도 여기서 본다.
// 프로세스를 띄우지 않고, 타이머는 unref라 서버를 붙잡지 않는다. 운영에서만 켠다(아래 `require.main`).
const slackRefresher = slackAuth.createSlackRefresher({ readConfig: currentConfigFile, request: slackRefreshRequest });
const slackFollower = integrations.createSlackNameFollower({ token: slackTokenNow });
const slackFollowOn = () => !process.env.WORKSPACE_NO_REMOTE_CHECK || process.env.WORKSPACE_SLACK_FOLLOW === '1';
// 슬랙 수집이 마지막으로 성공한 때(ISO) — 상태 파일을 읽기만 한다. 없으면 null.
function slackSyncSuccessAt() {
  const statePath = path.join(process.env.WORKSPACE_DATA_DIR || __dirname, '.slack_capture_state.json');
  try {
    const at = JSON.parse(nativeFs.readFileSync(statePath, 'utf8')).lastSuccessAt;
    return typeof at === 'string' && at ? at : null;
  } catch { return null; }
}
// `claude` 실행 파일이 이 맥에 있는지(PATH만 훑는다).
let claudeFound = null;
function claudeReady() {
  // 찾았을 때만 들고 있는다 — 안내대로 설치한 뒤 다시 점검하면 서버를 다시 켜지 않아도 보이게.
  if (!claudeFound) claudeFound = integrations.claudeInstalled();
  return claudeFound;
}
// ---------- 설정 › 앱 › 점검하기 (GET /api/selfcheck, WP-K) ----------
// 판단은 selfcheck.js가 하고, 여기서는 **이미 있는 함수**(연동 탭·톱니바퀴 점이 쓰는 integrationAlerts·fetchState*·
// getSlackSync/getJiraSync/getCalendarToday·launchAgentInstalled·claudeReady·backupStatus)를 그대로 넘긴다.
// 바깥 확인(슬랙 auth.test·conversations.info, 지라 myself, 캘린더 비밀 주소 한 번 읽기)은 읽기뿐이고, 프로세스는 띄우지 않는다.
// 테스트·픽스처(`WORKSPACE_NO_REMOTE_CHECK`)에서는 바깥에 닿지 않는다 — `setSelfcheckFetchForTests`로 가짜만 끼운다.
let selfcheckFetch = null;
function setSelfcheckFetchForTests(fn) { selfcheckFetch = typeof fn === 'function' ? fn : null; selfcheck.clear(); }
function selfcheckRequest(...args) {
  if (selfcheckFetch) return selfcheckFetch(...args);
  if (process.env.WORKSPACE_NO_REMOTE_CHECK) return Promise.reject(new Error('바깥 확인을 끈 자리예요'));
  return fetch(...args);
}
const selfcheck = require('./selfcheck').createSelfcheck({
  home: os.homedir(),
  nodeVersion: process.version,
  managed: !!process.env.WORKSPACE_MANAGED,
  messages: integrations.INTEGRATION_MESSAGE,
  slackAuthRe: SLACK_AUTH_RE,
  updateFile: updateCommandPath,
  version: appVersion,
  updateOffer: () => updateOffer(appVersion(), updateChannel()),
  installPlace: () => require('./selfcheck').installPlace({ repoDir: REPO_DIR, home: os.homedir(), envFile: path.join(automationDir(), 'workspace.env') }),
  agentInstalled: launchAgentInstalled,
  applyFailing: () => !!applyLastFailure(),
  config: currentConfigFile,
  readIntegrations: config => integrations.readIntegrations(config, { claude: false }),
  automations: getAutomationStatus,
  alerts: (config, automations) => integrationAlerts(config, automations),
  fetchStateAutomation, fetchStateLive, fetchStateSlack,
  calendarFailure: () => calendarLive.failure(),
  calendarHistory: () => calendarLive.history(),
  jiraFailure: () => jiraLive.failure(),
  jiraHistory: () => jiraLive.history(),
  claudeInstalled: claudeReady,
  slackSuccessAt: slackSyncSuccessAt,
  slackToken: config => slackTokenNow(config),
  // 새 방식의 갱신 상태(값 없이 시각·권한·실패 종류) — 옛 방식이면 `{ auth: 'token' }`뿐이다.
  slackOAuth: config => slackAuth.readOAuthStatus({ config, minValidMs: slackAuth.REFRESH_AHEAD_MS }),
  slackTokenCheck: token => integrations.slackTokenCheck(token, selfcheckRequest),
  slackCheckChannel: (token, id) => integrations.slackCheckChannel(token, id, selfcheckRequest),
  // 비밀 주소 읽기가 네트워크에서 막혔는지 가르려고 요청 길만 한 겹 감싼다(주소는 어디에도 남기지 않는다).
  icalCheck: async (config) => {
    let net = false;
    const request = (...args) => Promise.resolve().then(() => selfcheckRequest(...args)).catch((error) => { net = true; throw error; });
    try { return await integrations.icalCheck(integrations.savedIcalUrl(config), { request }); } catch (error) {
      if (net && error && typeof error === 'object') error.net = true;
      throw error;
    }
  },
  // 지라는 연동 저장과 같은 확인(myself) 한 번 — 토큰은 설정의 토큰 파일에서 읽어 헤더로만 보낸다.
  jiraCheck: async (config) => {
    const jiraClient = require('./jira-client');
    const settings = jiraClient.jiraSettings(config);
    if (!settings) return { ok: false, kind: 'auth' };
    let token = '';
    try { token = String(nativeFs.readFileSync(settings.tokenFile, 'utf8') || '').trim(); } catch { token = ''; }
    return jiraClient.checkJiraAccount({ siteUrl: settings.siteUrl, email: settings.email, token, request: selfcheckRequest });
  },
  backup: backupStatus,
  // 늦음(주황)의 재료 — /api/integrations의 `sync`와 같은 값.
  sync: () => {
    const calendar = { ...getCalendarToday() };
    delete calendar.events;
    return { slackSync: getSlackSync(), jiraSync: getJiraSync(), calendar };
  },
});

// ---------- 체크인 (GET·POST /api/checkin, WP-N) ----------
// 설치 3일째·8일째에 앱 안의 작은 창으로 묻고 답을 구글 폼으로 익명 제출한다(판단·전송은 checkin.js, 상태는 `local/checkin.json`).
// 만든 사람의 설치(업데이트 갈래 `main`)에서는 띄우지도 보내지도 않는다. launchd로 띄운 설치본(WORKSPACE_MANAGED)에서만 켜지고,
// 개발용 서버·테스트·픽스처는 기본 꺼짐이다(`WORKSPACE_CHECKIN=1`로 켤 수 있다 — 그래도 main 갈래면 꺼짐).
// 테스트·픽스처(`WORKSPACE_NO_REMOTE_CHECK`·`WORKSPACE_FIXTURE`)에서는 실제 구글에 닿지 않는다 — `setCheckinFetchForTests`로 가짜만 끼운다.
let checkinFetch = null;
const checkinTest = { localDir: null, today: null, enabled: null, timeoutMs: null };
function setCheckinFetchForTests(fn) { checkinFetch = typeof fn === 'function' ? fn : null; }
// 테스트 전용 — 임시 `local/`·오늘 날짜·켜짐 여부·시간 제한을 끼운다(값을 안 주면 원래대로).
function setCheckinForTests(options = {}) {
  checkinTest.localDir = options.localDir || null;
  checkinTest.today = options.today || null;
  checkinTest.enabled = typeof options.enabled === 'boolean' ? options.enabled : null;
  checkinTest.timeoutMs = options.timeoutMs || null;
  if ('fetch' in options) setCheckinFetchForTests(options.fetch);
}
function checkinRequest(...args) {
  if (checkinFetch) return checkinFetch(...args);
  if (process.env.WORKSPACE_NO_REMOTE_CHECK || process.env.WORKSPACE_FIXTURE) return Promise.reject(new Error('바깥 전송을 끈 자리예요'));
  return fetch(...args);
}
function checkinEnabled() {
  if (checkinTest.enabled !== null) return checkinTest.enabled && updateChannel() !== 'main';
  if (updateChannel() === 'main') return false;
  if (process.env.WORKSPACE_CHECKIN === '1') return true;
  if (process.env.WORKSPACE_CHECKIN === '0') return false;
  return !!process.env.WORKSPACE_MANAGED && !process.env.WORKSPACE_NO_REMOTE_CHECK && !process.env.WORKSPACE_FIXTURE;
}
// ---------- 사용 횟수 (WP-R, usage.js) ----------
// 기능별 사용 횟수를 `local/usage.json`에 날짜별 숫자만 센다(세기·보기는 모든 설치). 보내기는 위 체크인과 같은 조건·같은 길이다.
// 테스트(WORKSPACE_NO_REMOTE_CHECK)에서 `WORKSPACE_LOCAL_DIR`를 따로 주지 않았으면 세지 않는다 — 실제 `local/`에 쓰지 않게.
// 테스트는 `setUsageForTests({ localDir })`로 임시 폴더를 끼운다.
const usageTest = { localDir: null };
function setUsageForTests(options = {}) { usageTest.localDir = options.localDir || null; }
function usageDir() {
  if (usageTest.localDir) return usageTest.localDir;
  if (process.env.WORKSPACE_NO_REMOTE_CHECK && !process.env.WORKSPACE_LOCAL_DIR) return null;
  return LOCAL_DIR;
}
const usage = require('./usage').createUsage({
  localDir: usageDir,
  today: () => checkinTest.today || todayLocal(),
  canSend: () => checkin.canSend(),
  // 내 일 기록의 업무 기준 숫자(WP-Y) — 보고 초안과 같은 업무 목록(workflows.snapshot().items)을 읽기만 한다.
  workDays: () => require('./usage').workDaysFrom(workflows.snapshot().items),
});
const checkin = require('./checkin').createCheckin({
  usageFields: (label, today) => usage.formFields(label, today),
  onOpen: (state, today, tools) => usage.opened(state, today, tools),
  usageOn: () => usage.sendOn(),
  usageEntries: Object.values(require('./usage').USAGE_ENTRIES),
  localDir: () => checkinTest.localDir || LOCAL_DIR,
  today: () => checkinTest.today || todayLocal(),
  enabled: checkinEnabled,
  version: appVersion,
  // 켠 연동 — 연동 탭·점검하기와 같은 기준(selfcheck.connectedFlags). 이름만 쓰고 토큰·주소는 싣지 않는다.
  integrations: () => require('./selfcheck').connectedFlags(integrations.readIntegrations(currentConfigFile(), { claude: false })),
  request: checkinRequest,
  timeoutMs: () => checkinTest.timeoutMs,
});

// 앱을 끝내는 길은 이 하나뿐이다 — 테스트는 여기를 갈아 끼워 실제 종료가 절대 일어나지 않게 한다.
let exitApp = code => process.exit(code);
function setExitForTests(fn) { exitApp = typeof fn === 'function' ? fn : (code => process.exit(code)); }

// 문제 보고에 붙는 최근 오류 줄. 서버 로그(`server.err`)를 **읽기만** 하고 토큰 파일은 열지 않는다.
function aboutDiagnostics() {
  // 어느 맥·어느 Node에서 났는지는 고칠 때 가장 먼저 묻는 값이라 함께 싣는다(개인 정보가 아니다).
  const base = { ok: true, os: `${os.type()} ${os.release()}`, node: process.version };
  const file = path.join(automationLogDir(), 'server.err');
  try {
    return { ...base, found: true, lines: integrations.errorLines(nativeFs.readFileSync(file, 'utf8')) };
  } catch {
    return { ...base, found: false, lines: [] };
  }
}

// ---------- 브라우저로 나가는 화면 파일 ----------
// 화면 코드가 여러 파일로 나뉘어 있어서 이름을 하나하나 적지 않는다 — `PUBLIC_DIR`의 `*.js`/`*.css`
// 가운데 아래 차단 규칙에 걸리지 않는 것만 나간다(파일을 더해도 서버를 고칠 필요가 없다).
// 서버 파일·테스트·픽스처·저장소 코드는 **절대 나가면 안 되므로** 여기서 못 박는다(server.core.test.js가 이 목록을 그대로 가져와
// 확인하고, 화면이 읽지 않는 `*.js`가 목록·패턴에서 빠지면 실패한다 — 새 서버 파일은 여기에 적는다).
// 인증 예외(publicAsset)와는 다른 이야기다 — 여기 있는 파일도 원격에서는 인증을 거친다.
const CLIENT_BLOCKED = new Set([
  'server.js', 'safe-storage.js', 'jira-client.js', 'jira-live.js', 'attention-live.js', 'report-drafts.js',
  'task-batch.js', 'slack-history.js', 'slack-collect.js', 'import-record.js', 'browser-fixture.js', 'migrate.js',
  'integrations.js', 'ical.js', 'calendar-live.js', 'personalize.js', 'news.js', 'test-support.js',
  'routes-jira.js', 'routes-integrations.js', 'routes-app.js', 'routes-personalize.js', 'routes-items.js',
  'routes-track.js', 'selfcheck.js', 'checkin.js', 'usage.js', 'auto-update.js', 'calendar-mac.js',
  'slack-auth.js', 'slack-oauth.js', 'tryout-server.js',
]);
function isClientFile(name) {
  if (!/^[A-Za-z0-9][\w.-]*\.(js|css)$/.test(name)) return false;   // 이름 한 칸짜리(하위 경로 없음)만
  if (/\.test\.js$/.test(name)) return false;                        // *.test.js
  if (/-store\.js$/.test(name)) return false;                        // *-store.js
  if (/-fixture\.js$/.test(name)) return false;                      // *-fixture.js
  return !CLIENT_BLOCKED.has(name);
}
// 브라우저가 스스로 새로고침할지 판단하는 값(appVersion)도 같은 목록을 쓴다 — 허용한 화면 파일이
// 하나라도 바뀌면 값이 달라진다. 목록이 어긋날 일이 없게 한 곳에서만 만든다.
function clientFiles() {
  return fs.readdirSync(PUBLIC_DIR).filter(isClientFile).sort();
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    req.on('data', chunk => { bytes += chunk.length; if (bytes > limit) { const error = new Error('요청이 너무 커요.'); error.status = 413; reject(error); return; } body += chunk; });
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('요청이 중간에 끊겼어요.')));
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

const handleRequest = (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // 복구가 필요하면 파일에 닿기 전에 모든 쓰기를 돌려보낸다. 조회는 그대로 된다.
  const storage = mutations.status();
  if (req.method === 'POST' && storage.recoveryNeeded) {
    res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, code: 'RECOVERY_NEEDED', error: storage.message }));
    return;
  }

  // 떼어 낸 경로 묶음(routes-*.js)에 차례로 묻는다 — 위 가드를 거친 뒤다. 경로가 전부 완전일치라
  // 묻는 차례는 결과를 바꾸지 않는다. 어느 묶음도 맡지 않은 경로는 아래(보고서·가져오기·워크플로 등)로 내려간다.
  // 이 요청에서 읽은 저장 상태(`storage`)는 요청마다 달라서 공용 ctx 위에 한 겹 얹어 넘긴다(getter·setter는 그대로 공용 ctx의 것).
  const ctx = Object.create(routeCtx, { storage: { value: storage } });
  if (ROUTE_MODULES.some(route => route(req, res, url, ctx))) return;

  if (url.pathname === '/api/storage-status' && req.method === 'GET') {
    // 업무 파일을 읽지 않는다. 목록이 안 열리는 상황에서도 이유를 볼 수 있어야 한다.
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(storage));
    return;
  }

  if(url.pathname==='/api/import' && req.method==='POST') {
    readBody(req).then(body=>{
      const result=idempotent(req,body,()=>{
        const {kind,payload}=body;
        if(!payload || typeof payload!=='object')throw new Error('입력을 확인해 주세요.');
        if(kind==='item') {
          const {type,description,permalink}=payload;
          if(!['task','check','decision','idea'].includes(type) || typeof permalink!=='string' || !/^https:\/\/[^\s"<>]+$/.test(permalink))throw new Error('종류와 원본 링크를 확인해 주세요.');
          validateDescription(description);validateFields({priority:payload.priority,jira:payload.jira,group:payload.group,who:payload.who,project:payload.project});validateDate(payload.due);
          const existing=Object.values(getReportRefs()).find(item=>item.type===type && item.permalink===permalink);
          if(existing)return {ok:true,id:existing.id,duplicate:true};
          const create={task:createLaterTask,check:createWaitingItem,decision:createDecision,idea:createIdea}[type];
          const result=create({...payload,permalink:undefined});
          setTrackField(result.id,'source',`slack:${permalink}`,null);usage.add('slack_in');
          if(type==='task'){setTrackField(result.id,'inbox','true','task');if(payload.due)setTrackDue(result.id,payload.due);}
          return result;
        }
        if(kind==='cursor' || kind==='health') {
          const file=path.join(process.env.WORKSPACE_DATA_DIR || __dirname,'.slack_capture_state.json');
          const state=nativeFs.existsSync(file)?JSON.parse(nativeFs.readFileSync(file,'utf8')):{};
          if(kind==='cursor') {
            if(!['my-todo','my-align','my-waiting','my-someday'].includes(payload.channel) || !/^\d+\.\d+$/.test(payload.ts))throw new Error('커서를 확인해 주세요.');
            if(!state[payload.channel] || Number(payload.ts)>Number(state[payload.channel]))state[payload.channel]=payload.ts;
          } else {
            if(typeof payload.success!=='boolean')throw new Error('성공 여부를 확인해 주세요.');
            state.checkedAt=state.lastAttemptAt=new Date().toISOString();state.lastError=payload.success?null:String(payload.error || '동기화 실패').slice(0,500);
            if(payload.channel) {
              if(!['my-todo','my-align','my-waiting','my-someday'].includes(payload.channel))throw new Error('채널을 확인해 주세요.');
              state.channelHealth ||= {};
              state.channelHealth[payload.channel]={success:payload.success,attemptedAt:state.checkedAt,error:state.lastError};
            }
            const failed=Object.entries(state.channelHealth || {}).filter(([,value])=>!value.success);
            if(failed.length)state.lastError=failed.map(([key])=>key).join(', ')+' 수집 실패';
            if(payload.success && !state.lastError)state.lastSuccessAt=state.checkedAt;
          }
          atomicWrite(file,JSON.stringify(state,null,2));return {ok:true};
        }
        throw new Error('지원하지 않는 가져오기예요.');
      });res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(result));
    }).catch(error=>{res.writeHead(error.status || 400,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify({ok:false,error:error.message,code:error.code}));});return;
  }

  if(url.pathname==='/api/access-token' && req.method==='GET') {
    if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)){res.writeHead(403);res.end('Local only');return;}
    res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify({ok:true,token:nativeFs.existsSync(ACCESS_TOKEN_PATH)?nativeFs.readFileSync(ACCESS_TOKEN_PATH,'utf8').trim():null}));return;
  }

  if (url.pathname === '/api/report/change' && req.method === 'POST') {
    // 사용 횟수(숫자만): 문장·제목·소제목 고치기 → weekly_edit, 할 일 칸에 적기 → weekly_plan_add, 정리 막대(빼기·넣기·팔로업·옮기기)
    // → weekly_bulk(저장이 성공했을 때만).
    const reportUsage = { edit: 'weekly_edit', rename: 'weekly_edit', retitle: 'weekly_edit', add: 'weekly_plan_add', setOut: 'weekly_bulk', follow: 'weekly_bulk', move: 'weekly_bulk' };
    readBody(req).then(body => { const result = idempotent(req, body, () => { const done = reportDrafts.change(body); if (reportUsage[body && body.action]) usage.add(reportUsage[body.action]); return done; }); res.writeHead(200, {'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(result)); })
      .catch(error => { res.writeHead(error.status || 400, {'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:false,error:error.message,code:error.code})); });
    return;
  }

  const workflowActions = {
    '/api/workflow/task-batch': batchTasks,
    '/api/workflow/item': workflows.patchItem,
    '/api/workflow/meeting': workflows.saveMeeting,
    '/api/workflow/capture': workflows.capture,
    '/api/workflow/review': workflows.review,
    '/api/workflow/review-undo': workflows.undoReview,
    // 뺀 초안 되살리기(알림의 `되돌리기`·⌘Z) — 뺀 직후 모양(검토 기록 'dismissed')일 때만, 검토 기록 한 칸만 지운다.
    '/api/workflow/review-restore': workflows.restoreDismissed,
    '/api/workflow/link': workflows.link,
    // 리마인드의 `답변 왔어요`를 한 번 열어 봤다는 표시(업무의 흐름 기록 칸 하나)와 그 되돌리기(알림·⌘Z).
    '/api/workflow/answer-seen': workflows.markAnswerSeen,
    '/api/workflow/answer-seen-undo': workflows.unmarkAnswerSeen,
    // 회의에 연결한 프로젝트로 이 회의에서 이미 담은 항목도 옮기기 · 그 되돌리기(한 트랜잭션).
    '/api/meeting/move-items': moveMeetingItems,
    '/api/meeting/move-items-undo': undoMoveMeetingItems,
    // 담은 항목의 종류 바꾸기. 같은 id로 파일만 옮기므로 회의 연결·검토 기록이 그대로 남는다.
    '/api/workflow/retype': workflows.retype,
    // 직접 만든 프로젝트의 이름 바꾸기 — 그 프로젝트에 속한 모든 기록을 한 트랜잭션으로 함께 바꾼다.
    '/api/project/rename': renameProject,
    // 지라 프로젝트의 앱 안 별칭(BJALIAS) — 지라 요약은 그대로 두고, 주간요약 저장본의 표시 이름만
    // 같은 트랜잭션으로 함께 갱신한다. 지라에는 아무것도 쓰지 않는다.
    '/api/project/alias': setProjectAliasAction,
    // 옮기기(BMOVE)의 되돌리기 — 이동 기록에 남은 id들만 반대로 돌린다. 지라를 다시 읽지 않는다
    // (에픽 검사는 옮길 때 한 번으로 충분하다).
    '/api/project/move-undo': undoMoveProject,
    // 프로젝트 묶어 보기(BBUNDLE) — `.workflow.json`의 표시 정보(projectBundles)만 바꾼다. 항목의 jira 칸과
    // 지라에는 아무것도 쓰지 않는다. 되돌리기(⌘Z·알림)는 bundle-restore가 "지금이 after일 때만" before로.
    '/api/project/bundle': workflows.bundleProjects,
    '/api/project/unbundle': workflows.unbundleProjects,
    '/api/project/bundle-lead': workflows.setBundleLead,
    '/api/project/bundle-restore': workflows.restoreBundle,
    // 삭제한 항목 완전히 지우기 — `.trash.json`에서 그 줄만 뺀다(업무 파일은 이미 그 줄이 없다).
    '/api/track/trash-purge': ({ id }) => purgeTrashItem(id),
    // 새 프로젝트 화면의 직군 세트. 지라에는 아무것도 묻지 않고 `.workflow.json` 한 칸만 바꾼다.
    '/api/workflow/jira-roles': workflows.saveJiraRoles,
    // 반응 필요 줄 치우기·되돌리기. 지라에는 아무것도 보내지 않고 `.workflow.json`의 표 한 칸만 바꾼다.
    // 지금 목록에 있는 id는 정리에서 지키려고 캐시의 id 묶음을 함께 넘긴다(지우면 그 줄이 다시 올라온다).
    '/api/attention/dismiss': body => workflows.dismissAttention(body, attentionKeep()),
    '/api/attention/undismiss': workflows.undismissAttention,
  };
  if (req.method === 'POST' && workflowActions[url.pathname]) {
    readBody(req).then(body => {
      const result = idempotent(req, body, () => workflowActions[url.pathname](body));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    }).catch(error => {
      res.writeHead(error.status || 400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: error.message, code: error.code }));
    });
    return;
  }

  if (url.pathname === '/api/meeting/set-project' && req.method === 'POST') {
    readBody(req)
      .then(({ title, project, meetingId }) => {
        const ok = setMeetingLink(title, project || null, typeof meetingId === 'string' ? meetingId : null);
        res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok }));
      })
      .catch((e) => {
        res.writeHead(e.status || 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message || String(e), code: e.code }));
      });
    return;
  }

  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  // 앱에 내장한 글꼴(Pretendard)도 화면 파일과 같은 길로 나간다. 인증 예외(publicAsset)에는 넣지 않는다.
  // 화면 코드(`*.js`/`*.css`)는 isClientFile이 정한다 — 서버 파일·테스트·픽스처는 거기서 막힌다.
  // manifest는 파일이 아니라 꾸미기를 따라 만든다(routes-personalize.js).
  if (filePath !== '/index.html'
    && !(filePath.startsWith('/') && !filePath.slice(1).includes('/') && isClientFile(filePath.slice(1)))
    && !/^\/icons\/[\w-]+\.(png|svg)$/.test(filePath) && !/^\/fonts\/[\w-]+\.woff2$/.test(filePath)) {
    res.writeHead(404); res.end('Not found'); return;
  }
  filePath = path.join(PUBLIC_DIR, filePath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
};

const workflows = require('./workflow-store')({
  directory: TRACKER_DIR, refs: getReportRefs, calendar: getCalendarWithLinks,
  today: todayLocal, validateDate,
  create: { task: createManualTask, check: createWaitingItem, decision: createDecision },
  remove: removeTrackItem,
  // 종류 바꾸기: 같은 id로 업무 파일의 줄만 옮긴다(위 retypeTrackItem).
  move: retypeTrackItem,
});
const batchTasks = usage.countBatch(require('./task-batch')({ files: listTrackerFiles, pattern: TRACK_RE, parse: parseFields, validateDate, today: todayLocal }), () => getReportRefs());
// 주간요약 소제목: 묶음(projectBundles)은 그 묶음이 생긴 주부터 대표 이름 하나로 서고, 사람이 바꾼 소제목 옆의
// 원래 프로젝트 이름은 지금 이름(별칭·지라 요약)으로 적는다 — 두 값 다 읽기만 한다.
const reportDrafts = require('./report-drafts')({
  directory: TRACKER_DIR, sources: () => workflows.snapshot().items, legacy: parseWeeklyReports, currentWeek: currentWeekKey,
  bundles: () => workflows.snapshot().projectBundles,
  projectLabel: key => (key.startsWith('jira:') ? projectLabelOf({ jira: key.slice('jira:'.length) }) : key.startsWith('group:') ? key.slice('group:'.length) : null),
  // 보고 칸의 `+ 한 줄 추가`가 만드는 업무와 그 되돌리기. 부르는 곳(`/api/report/change`)이 이미 저장 트랜잭션(idempotent →
  // mutations.run) 안이라 업무 파일과 보고 저장본이 함께 쓰이거나 함께 되돌아간다. 흔적은 기존 출처 칸(`source:weekly`) —
  // 슬랙 출처(`slack:`)로 읽는 곳들은 앞머리로 가르므로 영향이 없다.
  tasks: {
    create: ({ description, done, completed, jira, group }) => {
      const result = createManualTask({ description, jira, group, scheduled: completed || todayLocal() });
      if (!result || !result.ok) throw new Error('업무를 만들지 못했어요. 적은 내용은 그대로 있어요.');
      setTrackField(result.id, 'source', 'weekly', 'task');
      if (done) {
        toggleTrackStatus(result.id, 'done');
        if (completed && completed !== todayLocal()) setTrackField(result.id, 'completed', completed, 'task');
      } else setTrackDoing(result.id, true);
      usage.add('task_add');
      return result.id;
    },
    // keep: 지운 항목(.trash.json)에 남긴다(report-drafts는 늘 true로 부른다).
    remove: (id, keep) => removeTrackItem(id, !!keep),
    // 정리 막대 `프로젝트 옮기기` — 업무 줄의 jira·group 칸만 바꾼다(회의 항목 옮기기 meetingSetItemProject와 같은 쓰기 길).
    // 열쇠가 null이면 프로젝트를 비운다(`기타`). 같은 트랜잭션 안이라 보고 저장이 실패하면 함께 되돌아간다.
    setProject: (id, key) => {
      if (key === null) { setTrackField(id, 'jira', null, null); if (!setTrackField(id, 'group', null, null)) throw new Error('업무를 찾을 수 없어요.'); return; }
      const target = resolveProject(key);
      if (!target || !setTrackField(id, target.type, target.value, null)) throw new Error('업무를 찾을 수 없어요.');
    },
    // `새 프로젝트…`에 적은 이름이 이미 있는 프로젝트(직접 만든 이름·지라 요약·별칭)면 그 열쇠 — 이름 겹침 검사(projectNamesTaken)와
    // 같은 비교(groupNameKey)다. 없으면 null(새 그룹 이름으로 쓴다).
    findProject: (name) => {
      const wanted = groupNameKey(name);
      const group = getCustomGroups().find(entry => groupNameKey(entry) === wanted);
      if (group) return `group:${String(group).replace(/_/g, ' ').trim()}`;
      const alias = Object.entries(getProjectAliases()).find(([, value]) => groupNameKey(value) === wanted);
      if (alias) return `jira:${alias[0]}`;
      const issue = getJiraIssueCache().find(entry => groupNameKey(entry.summary) === wanted || groupNameKey(`${entry.key} · ${entry.summary}`) === wanted);
      return issue ? `jira:${issue.key}` : null;
    },
  },
});
const mutations = require('./mutation-store')(TRACKER_DIR, [MEETING_LINKS_PATH, weeklyReportStatePath()]);
// 지라 직접 읽기. 설정이 없으면 `connected:false`만 돌려주고 아무 데도 접속하지 않는다.
// 토큰 파일은 서버의 읽기 묶음(readScope)을 쓰지 않는다 — 요청마다 새로 읽고 들고 있지 않으려고.
const jira = require('./jira-client').createJiraApi({ config: CONFIG });
// 화면이 붙여 넣은 지라 주소의 호스트를 견줄 때만 쓰는 값이다(주소는 이미 카드의 `지라에서 열기`에
// 그대로 나가 있다). 이메일·토큰은 어디에도 싣지 않는다.
const JIRA_SITE_URL = (require('./jira-client').jiraSettings(CONFIG) || {}).siteUrl || '';
// `완료한 티켓도 보기`가 묻는 기간(기본 90일, 상한 1년) — 값 검증은 이 둘로만 한다.
const { JIRA_DONE_DAYS, JIRA_DONE_MAX_DAYS } = require('./jira-client');
// 내 담당 티켓 목록도 앱이 직접 읽는다 — 값은 메모리에만 있고 파일은 쓰지 않는다.
// 설정이 없으면(`connected`가 거짓) 타이머도 첫 읽기도 돌지 않는다.
const jiraLive = require('./jira-live').createJiraLive({
  list: keys => jira.list(keys),
  keys: linkedJiraKeys,
  connected: () => USES.jira && jira.connected,
});
// 반응 필요(1차: 지라 댓글)도 앱이 직접 읽는다 — 값은 메모리에만 있고 파일은 쓰지 않는다.
// 설정이 없으면(`connected`가 거짓) 타이머도 첫 읽기도 돌지 않는다(내 담당 목록과 같은 규칙).
const attentionLive = require('./attention-live').createAttentionLive({
  load: () => jira.attention(),
  connected: () => USES.jira && jira.connected,
});
// 캘린더 비밀 주소(iCal)도 앱이 직접 읽는다 — 30분마다(+ 조회가 5분 넘게 묵은 값을 보면 뒤에서), 값은
// 메모리에만 있고 파일은 쓰지 않는다. 주소는 요청마다 파일에서 읽고 들고 있지 않는다(토큰과 같은 급).
// 새로 읽으면 회의 기록을 한 번 맞춘다(calendar_today.md가 바뀌었을 때와 같은 일 — 아래 main에서 끼운다).
let calendarAfterRead = null;
const calendarLive = require('./calendar-live').createCalendarLive({
  load: () => integrations.fetchIcal(integrations.savedIcalUrl(CONFIG)),
  connected: () => CALENDAR_ICAL,
  onUpdate: () => { if (typeof calendarAfterRead === 'function') calendarAfterRead(); },
});
// 치운 목록을 정리할 때 "지금 화면에 있는 줄"을 지키려고 쓰는 id 묶음이다.
const attentionKeep = () => new Set(((attentionLive.current() || {}).items || []).map(item => item.id));
const transactional = fn => (...args) => mutations.run(() => fn(...args));
setTrackField = transactional(setTrackField);
setTrackDue = transactional(setTrackDue);
setTrackDescription = transactional(setTrackDescription);
toggleTrackStatus = transactional(toggleTrackStatus);
createManualTask = transactional(createManualTask);
createWaitingItem = transactional(createWaitingItem);
createDecision = transactional(createDecision);
createIdea = transactional(createIdea);
removeTrackItem = transactional(removeTrackItem);
restoreTrackItem = transactional(restoreTrackItem);
promoteIdeaToToday = transactional(promoteIdeaToToday);
setMeetingLink = transactional(setMeetingLink);
// 떼어 낸 경로 묶음과, 그 묶음들이 받는 값·함수(ctx). 묶음 파일은 server.js를 require하지 않고 여기서 받은 것만 쓴다.
// 바뀔 수 있는 값(`APP_TITLE`·`exitApp`)은 요청 때의 값을 읽도록 getter로 둔다. 요청마다 달라지는 `storage`는
// handleRequest가 한 겹 얹어 넘긴다. 파일 읽기 묶음(`readScope`)은 ctx에 값으로 넣지 않는다 — 넘기는 `fs`가 부를 때마다
// 지금 요청의 묶음을 확인한다(값을 복사해 넘기면 지난 요청의 묶음이나 null이 남는다).
// 이 ctx는 위의 `transactional(...)` 감싸기 **뒤에** 만든다 — 감싼 뒤의 함수(저장 잠금 포함)가 들어가게.
const ROUTE_MODULES = [
  require('./routes-items'),
  require('./routes-track'),
  require('./routes-jira'),
  require('./routes-integrations'),
  require('./routes-app'),
  require('./routes-personalize'),
  checkin.route,
  usage.route,
  calendarMac.route,
];
const routeCtx = {
  get APP_TITLE() { return APP_TITLE; },
  set APP_TITLE(value) { APP_TITLE = value; },
  get TITLE_HIDDEN() { return TITLE_HIDDEN; },
  set TITLE_HIDDEN(value) { TITLE_HIDDEN = value; },
  get exitApp() { return exitApp; },
  USES, CALENDAR_ICAL, CONFIG_PATH, LOCAL_DIR, PUBLIC_DIR,
  readBody, idempotent, integrations, personalize, workflows,
  // 지라
  jira, jiraLive, attentionLive, JIRA_DONE_DAYS, JIRA_DONE_MAX_DAYS, PROJECT_MOVE_KEY_RE, projectDisplayName, moveProject,
  // 앱 정보·업데이트
  aboutApp, aboutDiagnostics, requestUpdate, updateStatusView, UPDATE_MESSAGE, selfcheck,
  // 연동·자동화·백업·미팅 노트
  calendarLive, slackFollower, slackFollowOn, slackRefreshRequest, currentConfigFile, claudeReady, getSlackSync, slackSyncSuccessAt,
  getAutomationStatus, fetchStateLive, fetchStateAutomation, fetchStateSlack, SLACK_AUTH_RE, todayLocal, getReportRefs, withApplyFailure,
  liveLog, integrationAlerts, getCalendarToday, getJiraSync, requestApply, fetchNow, FETCH_MESSAGE, backupStatus,
  meetingNotesStatus, writeMeetingNotesRequest,
  // 꾸미기
  currentDockName,
  // 목록 읽기(routes-items.js) — `fs`는 읽기 묶음(readScope)을 거치는 이 파일의 fs다.
  fs, TRACK_RE, parseFields, listTrackerFiles, isNewSlack, localDateOf, readMeetingLinks, projectKeyOf, reportDrafts,
  parseWeeklyReports, weeklyReportStatePath, getLaterTasks, getTodayTasks, getJiraIssueCache, getCustomGroups, getCalendarWithLinks,
  clientFiles,
  // 항목 추가·수정·삭제·되돌리기(routes-track.js) — 감싸기(transactional) 뒤의 함수들이다.
  mutations, validateDate, listTrash, restoreTrackItem, setTrackField, createManualTask, createLaterTask, createWaitingItem,
  createDecision, createIdea, promoteIdeaToToday, setTrackJira, setTrackGroup, setIdeaProject, setTrackDue, setTrackDoing,
  setTrackWho, setTrackPriority, setTrackDescription, removeTrackItem, toggleTrackStatus,
};
// 맥 캘린더 `허용하고 확인`(calendar-mac.js의 route) — 요청 표시 파일 자리와 launchd 등록 여부만 받는다.
Object.assign(routeCtx, { automationDir, launchAgentInstalled });
// 사용 횟수(WP-R) — 화면 경로가 부르는 저장 함수에만 세기를 씌운다(가져오기·워크플로가 부르는 같은 함수는 세지 않는다).
Object.assign(routeCtx, {
  createManualTask: usage.countCreate(createManualTask, 'task_add'), createLaterTask: usage.countCreate(createLaterTask, 'task_add'),
  createWaitingItem: usage.countCreate(createWaitingItem, 'check_add'), createDecision: usage.countCreate(createDecision, 'decision_add'),
  createIdea: usage.countCreate(createIdea, 'idea_add'), toggleTrackStatus: usage.countToggle(toggleTrackStatus, id => getReportRefs()[id]),
  removeTrackItem: usage.countRemove(removeTrackItem), jira: usage.countJira(jira),
});
// 홈 화면 추가 때 브라우저가 로그인 정보 없이 가져가는 앱 아이콘·manifest만 인증 없이 연다(DECISIONS 2026-09-20).
function publicAssetRequest(req) {
  return req.method==='GET' && /^\/(icons\/[\w-]+\.png|manifest\.webmanifest)(\?.*)?$/.test(req.url||'');
}
function safeHandle(req, res) {
  try {
    if(req.method==='GET')readScope={files:new Map()};
    const host = req.headers.host || '';
    const publicAsset=publicAssetRequest(req);
    if(!publicAsset && !remoteAuthorized(req)) {res.writeHead(401,{'WWW-Authenticate':'Basic realm="Workspace"'});res.end('Authentication required');return;}
    const hostname = host.split(':')[0];
    if (!['localhost','127.0.0.1',EXTRA_HOST].filter(Boolean).includes(hostname)) { res.writeHead(403); res.end('Forbidden host'); return; }
    if (req.method === 'POST' && (req.headers['content-type']?.split(';')[0] !== 'application/json' || (req.headers.origin && req.headers.origin !== `http://${host}`) || req.headers['sec-fetch-site'] === 'cross-site')) { res.writeHead(403); res.end('Forbidden request'); return; }
    // 쉬는 틈에 자동 업데이트(WP-U) — 사람이 한 쓰기(POST)만 센다. 슬랙 수집이 넣는 `/api/import`는 사람의 동작이 아니다.
    if (req.method === 'POST' && !/^\/api\/import(?:[?#]|$)/.test(req.url || '')) autoUpdate.touch();
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Cache-Control','no-store');
    usage.observe(res,()=>handleRequest(req,res));
  } catch(error) {
    console.error('요청 처리 실패:', error.message);
    if (!res.headersSent) res.writeHead(500, {'Content-Type':'application/json; charset=utf-8'});
    res.end(JSON.stringify({ok:false,error:'기록을 읽지 못했어요. 파일은 덮어쓰지 않았어요. 백업을 확인해 주세요.'}));
  } finally { readScope=null; }
}
const server = http.createServer(safeHandle);

if (require.main === module) {
  // 데이터가 이 앱보다 새 형식이면 아예 시작하지 않는다 — 옛 앱이 새 데이터를 망치지 않게.
  const dataVersion = readDataVersion(TRACKER_DIR);
  if (dataVersion > DATA_FORMAT_VERSION) {
    console.error(`${TOO_NEW_MESSAGE} (데이터 형식 ${dataVersion}, 이 앱 ${DATA_FORMAT_VERSION})`);
    process.exit(3);
  }
  // 복구를 끝내지 못해도 서버는 뜬다. 쓰기는 잠기고, 화면이 이유를 보여 줄 수 있게.
  try { mutations.recover(); } catch (error) { console.error('저장 복구가 필요합니다. 저장을 멈춥니다:', error.message); }
  if(EXTRA_HOST && !nativeFs.existsSync(ACCESS_TOKEN_PATH))atomicWrite(ACCESS_TOKEN_PATH,randomBytes(32).toString('hex'));
  const archiveMeetings = () => { try { mutations.run(() => workflows.archive()); } catch (error) { console.error('회의 기록 저장 실패:', error.message); } };
  archiveMeetings();
  // 지라 목록은 뜰 때 한 번, 그 뒤 10분마다 읽는다(설정이 있을 때만, 타이머는 unref).
  jiraLive.start();
  // 반응 필요(지라 댓글)도 같은 리듬이다.
  attentionLive.start();
  // 캘린더 비밀 주소 — 뜰 때 한 번, 그 뒤 30분마다(비밀 주소 갈래일 때만). 읽으면 회의 기록을 맞춘다.
  calendarAfterRead = archiveMeetings;
  calendarLive.start();
  // 슬랙 자동 갱신(새 방식) — 뜨고 1초 뒤 한 번, 그 뒤 15분마다. 옛 방식이면 파일만 보고 지나간다. 서버가 내려가면 거둔다.
  // 바깥 확인을 끈 자리(테스트·픽스처)와 `WORKSPACE_NO_SLACK_REFRESH=1`에서는 켜지 않는다 — 진짜 서버를 띄우는 시험이
  // 토큰 폴더를 건드리지 않게(타이머는 갱신 잠금을 잡고 `.legacy`를 지울 수 있다).
  if (!process.env.WORKSPACE_NO_REMOTE_CHECK && !process.env.WORKSPACE_NO_SLACK_REFRESH) slackRefresher.start();
  server.on('close', () => slackRefresher.stop());
  fs.watchFile(path.join(TRACKER_DIR, 'calendar_today.md'), { interval: 1000, persistent: false }, archiveMeetings);
  // 쉬는 틈에 자동 업데이트(WP-U) — launchd 설치본이고 main 갈래가 아닐 때만 1분 판단·1시간 원격 확인을 건다.
  startAutoUpdate();
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`슬랙 인박스 앱: http://localhost:${PORT}`);
    if (!process.env.WORKSPACE_NO_OPEN) exec(`open http://localhost:${PORT}`);
  });

  // 다른 기기용 주소를 따로 연다. 0.0.0.0이 아니라 특정 주소(예: Tailscale)만 열어서,
  // 같은 와이파이를 쓰는 다른 사람에게는 노출되지 않게 한다.
  if (EXTRA_HOST && EXTRA_HOST !== '127.0.0.1') {
    http
      .createServer(safeHandle)
      .listen(PORT, EXTRA_HOST, () => {
        console.log(`다른 기기용: http://${EXTRA_HOST}:${PORT}`);
      })
      .on('error', (err) => console.error(`다른 기기용 주소를 열지 못함: ${err.message}`));
  }
}

// `jiraLive`·`attentionLive`·`calendarLive`는 화면 확인용 픽스처가 "뜰 때 한 번 읽기"를 직접 켜 보려고 함께 내보낸다
// (테스트·픽스처 밖에서는 쓰지 않는다 — 운영에서는 위의 `start()`가 켠다).
// `CLIENT_BLOCKED`·`isClientFile`은 테스트가 차단 목록을 따로 적지 않고 이것을 그대로 확인하려고 내보낸다.
module.exports = {
  server, jiraLive, attentionLive, calendarLive, setExitForTests, changesUrlFrom, workspacePaths, fixtureSafetyProblems, CLIENT_BLOCKED, isClientFile, CLAUDE_AUTH_RE,
  // WP-J 원격 소식 — 네트워크 없이 배선을 확인하려는 테스트 전용(진짜 fetch는 기본값 그대로 쓴다).
  setRemoteFetchForTests, setLatestReleaseForTests, refreshRemoteNews, updateOffer,
  // WP-K 점검하기 — 바깥 확인을 가짜로 끼우는 테스트·픽스처 전용 길(끼우면 30초 캐시도 비운다).
  setSelfcheckFetchForTests, selfcheck,
  // WP-L 인증 없이 여는 경로(아이콘·manifest) — 목록이 늘지 않았는지 테스트가 본다.
  publicAssetRequest,
  // WP-N 체크인 — 가짜 전송·임시 local/·오늘 날짜를 끼우는 테스트·픽스처 전용 길.
  setCheckinFetchForTests, setCheckinForTests, checkin, setUsageForTests, usage,
  // WP-U 쉬는 틈에 자동 업데이트 — 판단 한 번(tick)·임시 local/·환경 끼우기(테스트·픽스처 전용, main 갈래 판단은 못 끼운다).
  autoUpdate, setAutoUpdateForTests,
  // 계속 실패(멈췄어요·빨간 점) 판단 — 같은 수치를 테스트가 고정한다.
  failStuck, fetchStateLive, fetchStateAutomation, fetchStateSlack, slackCaptureResting, setSlackClockForTests, SLACK_CAPTURE_HOURS,
  // 슬랙 자동 갱신 — 가짜 요청을 끼우고 타이머 한 번(tick)을 직접 돌려 보는 테스트 전용 길.
  slackRefresher, setSlackRefreshFetchForTests, integrationAlerts, SLACK_AUTH_RE,
};

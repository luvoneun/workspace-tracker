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
const { randomBytes, createHash, timingSafeEqual } = require('node:crypto');

// 사람/회사마다 달라지는 값은 전부 workspace.config.json 한 곳에 모아둔다.
// 다른 맥이나 다른 회사에서 쓸 때 이 파일만 갈아끼우면 된다.
const CONFIG_PATH = process.env.WORKSPACE_CONFIG || path.join(__dirname, '../../workspace.config.json');

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

const PORT = Number(process.env.WORKSPACE_PORT || CONFIG.server?.port || 4321);
// localhost는 항상 열고, extraHost가 있으면 그 주소로도 추가로 연다 (폰·다른 기기용).
const EXTRA_HOST = process.env.WORKSPACE_HOST || CONFIG.server?.extraHost || '';
const TRACKER_DIR = process.env.WORKSPACE_DATA_DIR || path.join(__dirname, '..');
const PUBLIC_DIR = __dirname;
// 코드 저장소의 뿌리(VERSION·git 기록이 있는 곳). 앱은 이 저장소를 그대로 clone해서 쓴다.
const REPO_DIR = process.env.WORKSPACE_REPO_DIR || path.join(__dirname, '..', '..');
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
  const calPath = path.join(TRACKER_DIR, 'calendar_today.md');
  if (!fs.existsSync(calPath)) return { events: [], lastSync: null, stale: true };
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

// "새로 들어온 것" — 슬랙에서 캡처됐지만 오늘 할지 나중에 할지 아직 안 정한 것.
// 오늘/나중에 목록에 섞여 묻히는 걸 막으려고 따로 모아둔다. 사람이 분류하면 inbox가 지워진다.
function getInboxTasks() {
  const items = [];
  listTrackerFiles().forEach((filePath) => {
    fs.readFileSync(filePath, 'utf-8').split('\n').forEach((line) => {
      const m = line.match(TRACK_RE);
      if (!m || m[2] !== 'task') return;
      const fields = parseFields(m[3]);
      if (fields.status === 'done' || fields.inbox !== 'true') return;
      items.push({
        description: m[1],
        id: fields.id,
        status: fields.status || 'to-do',
        priority: fields.priority || 'medium',
        created: fields.created,
        due: fields.due || null,
        permalink: fields.source && fields.source.startsWith('slack:') ? fields.source.slice('slack:'.length) : null,
        jira: fields.jira || null,
        group: fields.group ? fields.group.replace(/_/g, ' ') : null,
      });
    });
  });
  return items;
}

// "나중에 할 일" — committed tasks with no due date, or a due date in the future (not today/overdue)
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
      if (scheduled && scheduled <= today) return;
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

// "정책/얼라인" — 결정/합의된 내용 (#decision 타입). 슬랙 캡처분과 직접 쓴 것 모두 포함.
// PRD 반영 여부는 status(to-do/done)로 관리
function getDecisions() {
  const items = [];
  listTrackerFiles().forEach((filePath) => {
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    lines.forEach((line) => {
      const m = line.match(TRACK_RE);
      if (!m || m[2] !== 'decision') return;
      const fields = parseFields(m[3]);
      items.push({
        file: path.basename(filePath),
        description: m[1],
        id: fields.id,
        status: fields.status || 'to-do',
        priority: fields.priority || 'medium',
        created: fields.created,
        completed: fields.status === 'done' ? fields.completed || (fields.updated ? localDateOf(fields.updated) : null) : null,
        permalink: fields.source && fields.source.startsWith('slack:') ? fields.source.slice('slack:'.length) : null,
        isNew: isNewSlack(fields),
        jira: fields.jira || null,
        group: fields.group ? fields.group.replace(/_/g, ' ') : null,
      });
    });
  });
  return items;
}

// "확인 대기중" — waiting on someone else to check/confirm something (#check 타입, source:slack:)
function getWaitingItems() {
  const items = [];
  listTrackerFiles().forEach((filePath) => {
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    lines.forEach((line) => {
      const m = line.match(TRACK_RE);
      if (!m || m[2] !== 'check') return;
      const fields = parseFields(m[3]);
      if (fields.status === 'done') return;
      items.push({
        file: path.basename(filePath),
        description: m[1],
        id: fields.id,
        status: fields.status || 'to-do',
        priority: fields.priority || 'medium',
        created: fields.created,
        due: fields.due || null,
        who: fields.who ? fields.who.replace(/_/g, ' ') : null,
        permalink: fields.source && fields.source.startsWith('slack:') ? fields.source.slice('slack:'.length) : null,
        isNew: isNewSlack(fields),
        jira: fields.jira || null,
        group: fields.group ? fields.group.replace(/_/g, ' ') : null,
      });
    });
  });
  return items;
}

// "오늘 할 일" — merges manual + slack-sourced tasks due today or overdue (unfinished tasks roll forward automatically)
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
      if (fields.status === 'done' ? completedDate !== today : !scheduled || scheduled > today) return;
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

function getIdeas() {
  const items = [];
  listTrackerFiles().forEach((filePath) => {
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    lines.forEach((line) => {
      const m = line.match(TRACK_RE);
      if (!m || m[2] !== 'idea') return;
      const fields = parseFields(m[3]);
      if (fields.status === 'done') return;
      items.push({
        file: path.basename(filePath),
        description: m[1],
        id: fields.id,
        status: fields.status || 'to-do',
        priority: fields.priority || 'medium',
        created: fields.created,
        project: fields.project ? fields.project.replace(/_/g, ' ') : null,
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
  if (!fs.existsSync(jiraPath)) return { ...settings, lastSync: null, stale: true };
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
function getSlackSync() {
  if (!USES.slack) return { used: false };
  const statePath = path.join(process.env.WORKSPACE_DATA_DIR || __dirname, '.slack_capture_state.json');
  if (!fs.existsSync(statePath)) return { lastSync: null, stale: true };
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    const lastSync = state.lastSuccessAt ? localDateOf(state.lastSuccessAt) : null;
    return { lastSync, lastAttempt: state.lastAttemptAt || state.checkedAt || null, error: state.lastError || null, stale: !!state.lastError || !lastSync || lastSync < todayLocal() };
  } catch {
    return { lastSync: null, stale: true };
  }
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

// 설정 > 상태 탭에서 쓴다. run-task.sh가 남기는 "───── 시각 이름 시작/종료(exit N)"
// 블록과, slack-capture.sh가 미리보기만 하고 건너뛸 때 남기는 한 줄짜리 기록을 함께 읽어서
// "마지막으로 뭘 했는지" 사람이 읽을 수 있는 요약과 "최근에 실패한 적 있는지"를 뽑아낸다.
function parseAutomationLog(lines) {
  const startRe = /^─+ (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \S+ 시작$/;
  const endRe = /^─+ (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \S+ 종료 \(exit (-?\d+)\)$/;
  const plainRe = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (.+)$/;
  const events = [];
  let block = null;
  lines.forEach((line) => {
    const s = startRe.exec(line);
    if (s) { block = { body: [] }; return; }
    const e = endRe.exec(line);
    if (e) {
      const exitCode = Number(e[2]);
      const text = block ? block.body.join(' ').replace(/\s+/g, ' ').trim() : '';
      events.push({ time: e[1], kind: exitCode === 0 ? 'run' : 'fail', text: text || (exitCode === 0 ? '완료' : `실패 (exit ${exitCode})`) });
      block = null;
      return;
    }
    if (block) { block.body.push(line); return; }
    const p = plainRe.exec(line);
    if (p) events.push({ time: p[1], kind: p[2].includes('채널 확인 실패') ? 'fail' : 'skip', text: p[2] });
  });
  return events;
}

function getAutomationStatus() {
  const logDir = automationLogDir();
  const specs = [
    { key: 'slack', name: '슬랙 캡처', log: 'slack-capture.log', used: USES.slack },
    { key: 'calendar', name: '캘린더 동기화', log: 'calendar-sync.log', used: USES.calendar },
    { key: 'jira', name: '지라 동기화', log: 'jira-sync.log', used: USES.jira },
    // 일정표 없이 앱의 버튼을 눌렀을 때만 도는 자동화다(DECISIONS 2026-09-24). 상태·로그는 나머지와 같은 자리에서 본다.
    { key: 'tiro', name: '미팅 노트 가져오기', log: 'tiro-sync.log', used: USES.tiro },
  ];
  return specs.filter((s) => s.used).map((spec) => {
    const lines = tailLines(path.join(logDir, spec.log), 500);
    const events = parseAutomationLog(lines);
    const last = events[events.length - 1] || null;
    const recentFailures = events.filter((e) => e.kind === 'fail').slice(-5).reverse();
    return {
      key: spec.key,
      name: spec.name,
      lastRunAt: last ? last.time : null,
      lastKind: last ? last.kind : null,
      lastSummary: last ? last.text : null,
      recentFailures,
      tail: lines.filter((l) => l.trim()).slice(-60),
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
  const startRe = /^─+ (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \S+ 시작$/;
  const endRe = /^─+ (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \S+ 종료 \(exit (-?\d+)\)$/;
  const runs = [];
  let open = null;
  lines.forEach((line) => {
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
      ? { ...base, state: 'failed', startedAt, summary: '35분이 넘도록 끝나지 않았어요. 설정 > 상태에서 로그를 확인해 주세요.' }
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

// 업무에 걸려 있는 지라 키를 모은다 — 기본 조회(내 담당·미완료)에서 빠진 것만 한 번 더 물어
// 요약이 사라지지 않게 하려고 쓴다. 항목의 `jira`, 회의에 연결한 지라 프로젝트, 손으로 건 `projectLinks`.
function linkedJiraKeys() {
  const keys = new Set();
  const add = (value) => { if (typeof value === 'string' && /^[A-Z][A-Z0-9]*-\d+$/.test(value)) keys.add(value); };
  try {
    const snapshot = workflows.snapshot();
    snapshot.items.forEach(item => add(item.jira));
    Object.values(snapshot.projectLinks || {}).forEach(add);
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

// 지금까지 직접 입력해서 쓴 커스텀 그룹명 목록 (지라 티켓 아닌 것) — 그룹 지정 드롭다운에서 재사용하기 위함
function getCustomGroups() {
  const names = new Set();
  listTrackerFiles().forEach((filePath) => {
    fs.readFileSync(filePath, 'utf-8').split('\n').forEach((line) => {
      const m = line.match(TRACK_RE);
      if (!m || m[2] !== 'task') return;
      const fields = parseFields(m[3]);
      if (fields.status === 'done') return;
      if (fields.group) names.add(fields.group.replace(/_/g, ' '));
    });
  });
  return [...names].sort();
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

function setMeetingLink(title, project) {
  const key = String(title || '').trim();
  if (!key) return false;
  if(project && !resolveProject(project))throw new Error('프로젝트를 확인해 주세요.');
  const links = readMeetingLinks();
  if (project) links[key] = project;
  else delete links[key];
  fs.writeFileSync(MEETING_LINKS_PATH, JSON.stringify(links, null, 2));
  workflows.syncProject(key, resolveProject(project));
  return true;
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

// 오늘 미팅에 연결된 프로젝트들 — 제안이 "오늘 미팅 있는 일"을 건드리지 않도록 쓰인다
function meetingProjectKeys() {
  const links = readMeetingLinks();
  const keys = new Set();
  getCalendarToday().events.forEach((event) => {
    const key = links[String(event.title).trim()];
    if (key) keys.add(key);
  });
  return keys;
}

// ---------- 오늘 할 일 제안 ----------

function projectKeyOf(item) {
  if (item.jira) return `jira:${item.jira}`;
  if (item.group) return `group:${item.group}`;
  return null;
}

function daysBetween(fromDate, toDate) {
  return Math.round((new Date(`${toDate}T00:00:00`) - new Date(`${fromDate}T00:00:00`)) / 86400000);
}

// 오늘 목록 상태에 따라 방향이 갈린다.
// 여유 있으면 "이거 가져올까요?", 과부하면 "이건 미룰까요?", 적당하면 아무 말도 안 한다.
function getTodaySuggestions() {
  const openToday = getTodayTasks().filter((t) => t.status !== 'done');
  if (openToday.length >= 8) return { mode: 'defer', total: openToday.length, items: suggestDeferrals(openToday) };
  if (openToday.length < 5) return { mode: 'pull', total: openToday.length, items: suggestPulls() };
  return { mode: 'none', total: openToday.length, items: [] };
}

// 오늘 하기 좋은 후보 — 나중에 할 일 중에서
function suggestPulls() {
  const today = todayLocal();
  const meetingKeys = meetingProjectKeys();
  return getLaterTasks()
    .map((task) => {
      const reasons = [];
      let score = 0;
      const key = projectKeyOf(task);
      if (key && meetingKeys.has(key)) {
        score += 10;
        reasons.push('오늘 미팅 관련');
      }
      if (task.due) {
        const left = daysBetween(today, task.due);
        if (left <= 1) {
          score += 9;
          reasons.push(left < 0 ? '마감 지남' : '마감 임박');
        } else if (left <= 3) {
          score += 6;
          reasons.push(`마감 ${left}일 전`);
        } else if (left <= 7) {
          score += 3;
          reasons.push('이번 주 마감');
        }
      }
      if (task.priority === 'critical') {
        score += 6;
        reasons.push('긴급');
      } else if (task.priority === 'high') {
        score += 4;
        reasons.push('중요');
      }
      const waited = task.created ? daysBetween(task.created, today) : 0;
      if (waited >= 7) {
        score += 3;
        reasons.push(`${waited}일째 대기`);
      } else if (waited >= 3) {
        score += 1;
        reasons.push(`${waited}일째 대기`);
      }
      return { ...task, score, reasons };
    })
    .filter((task) => task.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

// 오늘 미뤄도 괜찮아 보이는 후보 — 오늘 미팅과 무관하고, 마감도 급하지 않고, 우선순위도 높지 않은 것
function suggestDeferrals(openToday) {
  const today = todayLocal();
  const meetingKeys = meetingProjectKeys();
  return openToday
    .map((task) => {
      const key = projectKeyOf(task);
      if (key && meetingKeys.has(key)) return null;
      if (task.priority === 'high' || task.priority === 'critical') return null;

      const reasons = [];
      let score = 0;
      if (task.due) {
        const left = daysBetween(today, task.due);
        if (left <= 3) return null;
        score += 2;
        reasons.push(`마감 ${left}일 남음`);
      } else {
        score += 3;
        reasons.push('마감 없음');
      }
      if (task.priority === 'low') {
        score += 4;
        reasons.push('우선순위 낮음');
      }
      if (!key) {
        score += 1;
        reasons.push('프로젝트 미지정');
      }
      return { ...task, score, reasons };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
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
    ...workflows.groupList().filter(entry => entry !== excludeGroup),
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
    meetingLinks, reportRows, reportLabel: label,
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
  const { from, to, items: itemIds, meetings: meetingIds, links, meetingLinks: meetingLinkTitles, reportRows, reportLabel } = entry;

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
  const reportUndo = reportDrafts.moveGroupUndo(reportRows, from, to, reportLabel);

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

function weekLabel(weekKey) {
  const monday = new Date(weekKey + 'T00:00:00');
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);
  const rangeStr = `${monday.getMonth() + 1}/${monday.getDate()}~${sunday.getMonth() + 1}/${sunday.getDate()}`;
  return `${monday.getFullYear()}년 ${rangeStr}`;
}

function weeklyReportsPath() {
  return path.join(TRACKER_DIR, 'weekly_reports.md');
}

function weeklyReportStatePath() {
  return path.join(process.env.WORKSPACE_DATA_DIR || __dirname, '.weekly_report_state.json');
}

function readWeeklyReportState() {
  const p = weeklyReportStatePath();
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return {};
  }
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

function getWeeklyReports() {
  const state = readWeeklyReportState();
  const old = parseWeeklyReports();
  const sources = workflows.snapshot().items;
  // 보고 기록 파일은 한 번만 읽어서 주마다 돌려 쓴다 — view()가 주 수만큼 다시 읽지 않게.
  const drafts = reportDrafts.read();
  return reportDrafts.weeks(sources, drafts).map(weekKey => ({ weekKey, label: weekLabel(weekKey), body: old.find(r=>r.weekKey===weekKey)?.body || '', generatedAt: state[weekKey]?.generatedAt || null, draft: reportDrafts.view(weekKey, drafts, sources) }));
}

// 오늘 새로 생긴 항목 수 / 오늘 완료한 항목 수 — 상단 통계용
function getTodayActivityCounts() {
  const today = todayLocal();
  let createdToday = 0;
  listTrackerFiles().forEach((filePath) => {
    fs.readFileSync(filePath, 'utf-8').split('\n').forEach((line) => {
      const m = line.match(TRACK_RE);
      if (!m) return;
      const fields = parseFields(m[3]);
      if (fields.created === today) createdToday += 1;
    });
  });
  return { createdToday };
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
// 파일은 하나도 쓰지 않고, git이 없거나 실패하면 조용히 `null`이다.
const VERSION_PATH = path.join(REPO_DIR, 'VERSION');
const REMOTE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;   // 6시간에 한 번
let latestRelease = null;        // { tag, checkedAt } — 메모리에만 둔다
let remoteCheckTimer = null;
let remoteChecking = false;

function appVersion() {
  try { return nativeFs.readFileSync(VERSION_PATH, 'utf8').trim() || null; } catch { return null; }
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
  const out = await git(['-c', 'core.quotepath=false', 'status', '--porcelain']);
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

// 새 버전이 나왔는지 원격의 태그만 읽어 본다(설정과 무관하게 돈다 — 연동을 다 끈 사람도 업데이트는 받는다).
// 실패해도 조용히 지나가고, 파일은 쓰지 않는다.
async function checkLatestRelease() {
  if (remoteChecking) return;
  remoteChecking = true;
  try {
    const out = await git(['ls-remote', '--tags', 'origin'], 10000);
    if (!out) return;
    const tags = [...out.matchAll(/refs\/tags\/(v\d+\.\d+\.\d+)(?:\^\{\})?$/gm)].map((match) => match[1]);
    if (!tags.length) return;
    const tag = tags.sort(compareVersions)[tags.length - 1];
    latestRelease = { tag, checkedAt: new Date().toISOString() };
  } finally {
    remoteChecking = false;
  }
}

function startRemoteCheck() {
  if (remoteCheckTimer || process.env.WORKSPACE_NO_REMOTE_CHECK) return;
  remoteCheckTimer = setInterval(checkLatestRelease, REMOTE_CHECK_INTERVAL_MS);
  if (remoteCheckTimer.unref) remoteCheckTimer.unref();
  checkLatestRelease();
}

async function aboutApp() {
  startRemoteCheck();
  const [modified, ref] = await Promise.all([gitModified(), git(['rev-parse', '--short', 'HEAD'])]);
  return {
    version: appVersion(),
    dataFormat: DATA_FORMAT_VERSION,
    channel: CONFIG.server?.updateChannel || 'stable',
    // launchd가 KeepAlive로 띄운 자리에는 setup.sh가 이 표시를 넣어 둔다(개발용 서버·픽스처에는 없다).
    install: process.env.WORKSPACE_MANAGED ? 'managed' : 'manual',
    gitRef: ref ? ref.trim() : null,
    modified,
    latest: latestRelease,
  };
}

// ---------- 설정 > 연동 ----------
// `workspace.config.json`을 앱이 쓰는 **단 하나의 자리**다(DECISIONS 2026-09-23). 저장할 때마다
// 파일을 새로 읽어 합치므로, 그 사이 사람이 손으로 적어 둔 값도 그대로 남는다.
// 토큰은 config에 적지 않는다 — 파일(0600)로만 두고 경로만 적는다.
function currentConfigFile() {
  try { return JSON.parse(nativeFs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}
// `claude` 실행 파일이 이 맥에 있는지 — 프로세스마다 한 번만 보고(PATH만 훑는다) 들고 있는다.
let claudeFound = null;
function claudeReady() {
  if (claudeFound === null) claudeFound = integrations.claudeInstalled();
  return claudeFound;
}
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
// 서버 파일·테스트·픽스처·저장소 코드는 **절대 나가면 안 되므로** 여기서 못 박는다(server.test.js가 고정).
// 인증 예외(publicAsset)와는 다른 이야기다 — 여기 있는 파일도 원격에서는 인증을 거친다.
const CLIENT_BLOCKED = new Set([
  'server.js', 'safe-storage.js', 'jira-client.js', 'jira-live.js', 'attention-live.js', 'report-drafts.js',
  'task-batch.js', 'slack-history.js', 'import-record.js', 'browser-fixture.js', 'migrate.js',
  'integrations.js',
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    req.on('data', chunk => { bytes += chunk.length; if (bytes > 1024 * 1024) { const error = new Error('요청이 너무 커요.'); error.status = 413; reject(error); return; } body += chunk; });
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
          setTrackField(result.id,'source',`slack:${permalink}`,null);
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
    readBody(req).then(body => { const result = idempotent(req, body, () => reportDrafts.change(body)); res.writeHead(200, {'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(result)); })
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
    '/api/workflow/link': workflows.link,
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

  // 지라 직접 읽기 — 프로젝트 탭의 띠 카드가 열릴 때만 부른다. 파일은 쓰지 않고(조회),
  // 키별 60초 메모리 캐시를 둔다(`fresh=1`이면 건너뛴다). 인증 예외에는 넣지 않는다.
  if (url.pathname === '/api/jira/issue' && req.method === 'GET') {
    if (!USES.jira) { res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '지라를 쓰지 않도록 설정돼 있어요.', kind: 'other' })); return; }
    jira.read(url.searchParams.get('key'), { fresh: url.searchParams.get('fresh') === '1' })
      .then((payload) => {
        // 지라 쪽 실패는 200 + `ok:false`로 답한다 — 우리 서버가 제대로 답한 것이고,
        // 화면은 그 문구를 카드 자리에 조용히 적는다(브라우저 콘솔에 붉은 줄을 남기지 않는다).
        // 형식이 틀린 키만 400이다(보낸 쪽 잘못).
        res.writeHead(payload.kind === 'key' ? 400 : 200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(payload));
      })
      .catch(() => {
        // 여기 오는 것은 우리 쪽 잘못이다 — 지라가 준 글자는 이미 위에서 우리 문구로 바뀌어 있다.
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: '지라에 연결하지 못했어요.', kind: 'other' }));
      });
    return;
  }

  // 내 담당 목록을 **지금** 다시 읽어 메모리만 바꾼다(파일은 쓰지 않는다). 헤더의 새로고침이
  // 목록을 다시 받기 전에 조용히 부른다 — 돌려주는 것은 결과 한 줄뿐이고 티켓은 싣지 않는다.
  if (url.pathname === '/api/jira/list' && req.method === 'GET') {
    if (!USES.jira) { res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '지라를 쓰지 않도록 설정돼 있어요.', kind: 'other' })); return; }
    const done = () => {
      const live = jiraLive.current();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        ok: true,
        connected: !!jira.connected,
        count: live ? live.issues.length : 0,
        liveAt: live ? new Date(live.at).toISOString() : null,
      }));
    };
    const asked = url.searchParams.get('fresh') === '1' || !jiraLive.current();
    (asked && jira.connected ? jiraLive.refresh() : Promise.resolve()).then(done, done);
    return;
  }

  // 반응 필요(1차: 지라 댓글) — 내 마지막 댓글 뒤에 다른 사람 댓글이 있는 이슈 목록이다.
  // 조회라 어떤 파일도 쓰지 않고, 값은 서버 메모리(attention-live)에만 있다. 인증 예외도 아니다.
  // 지라를 쓰지 않거나 설정이 없으면 `connected:false`로만 답한다(화면은 구역 자체를 그리지 않는다).
  if (url.pathname === '/api/attention' && req.method === 'GET') {
    if (!USES.jira || !jira.connected) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, connected: false, items: [] }));
      return;
    }
    const done = () => {
      const view = attentionLive.view();
      const hidden = workflows.attentionDismissed();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        ok: true,
        connected: true,
        items: view.items.filter(item => !hidden[item.id]),
        updatedAt: view.updatedAt,
        stale: view.stale,
        ...(view.error ? { error: view.error } : {}),
      }));
    };
    // 아직 값이 없거나 `fresh=1`이면 지금 읽는다(그 밖에는 10분마다 도는 값을 그대로 쓴다).
    // 지라가 죽어 있는 동안 화면을 열 때마다 다시 묻지 않게, 스스로 읽는 쪽은 1분을 바닥으로 둔다.
    const asked = url.searchParams.get('fresh') === '1' || attentionLive.needsRead();
    (asked ? attentionLive.refresh() : Promise.resolve()).then(done, done);
    return;
  }

  // 연결 입력칸에서 `완료한 티켓도 보기`를 눌렀을 때만 부른다 — 최근 며칠 안에 완료된 내 담당 티켓이다.
  // 조회라 파일은 하나도 쓰지 않고, 서버 메모리에 60초만 들고 있는다. 인증 예외에는 넣지 않는다.
  if (url.pathname === '/api/jira/done' && req.method === 'GET') {
    if (!USES.jira) { res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '지라를 쓰지 않도록 설정돼 있어요.', kind: 'other' })); return; }
    const asked = url.searchParams.get('days');
    const days = asked === null || asked === '' ? JIRA_DONE_DAYS : Number(asked);
    if (!Number.isInteger(days) || days < 1 || days > JIRA_DONE_MAX_DAYS) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: '보낸 값을 확인해 주세요.', kind: 'value' }));
      return;
    }
    jira.listDone(days)
      .then((payload) => {
        // 지라 쪽 실패는 200 + `ok:false`다(화면이 그 문구를 그 자리에 조용히 적는다).
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(payload));
      })
      .catch(() => {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: '지라에 연결하지 못했어요.', kind: 'other' }));
      });
    return;
  }

  // 고르개가 열릴 때 지라가 허용하는 전환·버전 목록을 읽는다. 파일도 캐시도 없다(조회).
  if (url.pathname === '/api/jira/options' && req.method === 'GET') {
    if (!USES.jira) { res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '지라를 쓰지 않도록 설정돼 있어요.', kind: 'other' })); return; }
    jira.options(url.searchParams.get('key'))
      .then((payload) => {
        res.writeHead(payload.kind === 'key' ? 400 : 200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(payload));
      })
      .catch(() => {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: '지라에 연결하지 못했어요.', kind: 'other' }));
      });
    return;
  }

  // 지라에 쓰는 단 하나의 주소. 화면이 확인 절차를 거친 뒤에만 부르고, 서버는 보낸 값을 다시
  // 검증한 뒤 id를 쓰기 직전에 지라에서 다시 조회해 대조한다. 앱 파일은 하나도 건드리지 않으므로
  // `idempotent()`·mutation-store를 타지 않는다(그것들은 앱 데이터용이다) — 다만 복구 필요 상태의
  // POST 차단은 맨 위 전역 분기를 그대로 탄다(앱 저장소가 아픈 동안 바깥에 쓰지 않는 쪽이 안전하다).
  // 요청 본문은 어디에도 기록하지 않는다.
  if (url.pathname === '/api/jira/change' && req.method === 'POST') {
    if (!USES.jira) { res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '지라를 쓰지 않도록 설정돼 있어요.', kind: 'other' })); return; }
    readBody(req)
      .then(body => jira.change(body))
      .then((payload) => {
        // 보낸 쪽 잘못(키·값 형식)만 400이다. 지라 쪽 실패는 200 + `ok:false`로 문구를 실어 보낸다.
        res.writeHead(payload.kind === 'key' || payload.kind === 'value' ? 400 : 200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(payload));
      })
      .catch(() => {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: '보낸 값을 확인해 주세요.', kind: 'value' }));
      });
    return;
  }

  // 새 프로젝트 화면이 하위 티켓 종류를 고를 때 부른다 — 그 지라 프로젝트에서 만들 수 있는 이슈
  // 종류다. 조회라 파일은 하나도 쓰지 않고, 서버 메모리에 프로젝트마다 60초만 담아 둔다.
  if (url.pathname === '/api/jira/create-meta' && req.method === 'GET') {
    if (!USES.jira) { res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '지라를 쓰지 않도록 설정돼 있어요.', kind: 'other' })); return; }
    jira.createMeta(url.searchParams.get('project'))
      .then((payload) => {
        // 형식이 틀린 프로젝트 키만 400이다(보낸 쪽 잘못). 지라 쪽 실패는 200 + `ok:false`다.
        res.writeHead(payload.kind === 'key' ? 400 : 200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(payload));
      })
      .catch(() => {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: '지라에 연결하지 못했어요.', kind: 'other' }));
      });
    return;
  }

  // 지라에 **여러 이슈를 만드는** 단 하나의 주소(에픽 하나 + 직군별 하위). 화면이 만들 목록 전체를
  // 보여 주고 확인을 받은 뒤에만 부른다. 서버는 보낸 값을 다시 검증하고, 만들 수 있는 이슈 종류를
  // 쓰기 직전에 지라에서 다시 읽어 대조하며, 같은 계획을 60초 안에 두 번 받으면 거절한다.
  // 앱 파일은 하나도 건드리지 않으므로 `idempotent()`·mutation-store를 타지 않는다(그것들은 앱
  // 데이터용이다) — 다만 복구 필요 상태의 POST 차단은 맨 위 전역 분기를 그대로 탄다.
  // 요청 본문은 어디에도 기록하지 않는다.
  if (url.pathname === '/api/jira/create' && req.method === 'POST') {
    if (!USES.jira) { res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '지라를 쓰지 않도록 설정돼 있어요.', kind: 'other' })); return; }
    readBody(req)
      .then(body => jira.create(body))
      .then((payload) => {
        // 보낸 쪽 잘못(키·값 형식·개수)만 400이다. 지라 쪽 실패는 200 + `ok:false`로 문구를 실어 보낸다.
        res.writeHead(['key', 'value', 'tooMany'].includes(payload.kind) ? 400 : 200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(payload));
      })
      .catch(() => {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: '보낸 값을 확인해 주세요.', kind: 'value' }));
      });
    return;
  }

  // 직접 만든(그룹) 프로젝트에 지라 티켓 **하나**를 손으로 건다(`jira:KEY` 프로젝트에는 걸지 않는다 —
  // 이미 지라다). 순서가 안전장치다: ① 보낸 값과 그 그룹이 앱에 실제로 있는지 먼저 보고
  // ② 지라에서 그 티켓을 **읽을 수 있을 때만** ③ 앱의 기존 저장 길(idempotent → mutations.run)로 저장한다.
  // `jira: null`이면 해제다 — 지라에는 아무것도 묻지 않는다. 업무·기록은 하나도 바뀌지 않는다.
  if (url.pathname === '/api/project/jira-link' && req.method === 'POST') {
    if (!USES.jira) { res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '지라를 쓰지 않도록 설정돼 있어요.' })); return; }
    readBody(req).then(async (body) => {
      const { key } = workflows.checkProjectLink(body || {});
      if (key) {
        const seen = await jira.read(key);
        if (seen.ok === false) { const error = new Error(seen.error); error.status = 400; throw error; }
        if (seen.connected === false) { const error = new Error('지라 연결이 필요해요.'); error.status = 400; throw error; }
      }
      return idempotent(req, body, () => workflows.linkProject(body));
    }).then((result) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    }).catch((error) => {
      res.writeHead(error.status || 400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: error.message, code: error.code }));
    });
    return;
  }

  // 직접 만든(그룹) 프로젝트를 지라 에픽으로 통째로 옮긴다(BMOVE) — jira-link와 같은 순서다:
  // ① 형식 확인 ② 지라에서 **다시 읽어** 실제로 에픽(계층 1)인지 확인 ③ 그때만 앱의 저장 길로 옮긴다.
  // 되돌리기는 `/api/project/move-undo`(workflowActions)가 지라를 다시 묻지 않고 기록만으로 한다.
  if (url.pathname === '/api/project/move' && req.method === 'POST') {
    if (!USES.jira) { res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '지라를 쓰지 않도록 설정돼 있어요.' })); return; }
    readBody(req).then(async (body) => {
      const { project, to } = body || {};
      if (typeof project !== 'string' || !project.startsWith('group:')) { const error = new Error('직접 만든 프로젝트만 옮길 수 있어요.'); error.status = 400; throw error; }
      if (typeof to !== 'string' || !PROJECT_MOVE_KEY_RE.test(to)) { const error = new Error('지라 번호를 확인해 주세요.'); error.status = 400; throw error; }
      const check = await jira.checkEpic(to);
      if (check.ok === false) { const error = new Error('지라에서 이 티켓을 읽지 못했어요.'); error.status = 400; throw error; }
      if (check.connected === false) { const error = new Error('지라 연결이 필요해요.'); error.status = 400; throw error; }
      if (!check.epic) { const error = new Error('에픽에만 옮길 수 있어요.'); error.status = 400; throw error; }
      // 별칭이 있으면 그 이름, 없으면 방금 지라에서 읽은 요약(BJALIAS와 같은 규칙) — 아직 앱의
      // 지라 캐시(jira_issues.md)에 없는 새 에픽이어도 이 요약으로 표시 이름을 지을 수 있다.
      const name = projectDisplayName(to, check.summary || '');
      const label = name ? `${to} · ${name}` : to;
      return idempotent(req, body, () => moveProject({ project, to, label }));
    }).then((result) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    }).catch((error) => {
      res.writeHead(error.status || 400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: error.message, code: error.code }));
    });
    return;
  }

  // 앱 정보 — 조회라 파일을 쓰지 않는다.
  if (url.pathname === '/api/about' && req.method === 'GET') {
    aboutApp().then((about) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(about));
    }).catch(() => {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: '앱 정보를 읽지 못했어요.' }));
    });
    return;
  }

  // 문제 보고에 붙일 최근 오류 줄 — 조회라 파일을 쓰지 않는다.
  if (url.pathname === '/api/about/diagnostics' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(aboutDiagnostics()));
    return;
  }

  // 지금 연동 상태 — 토큰 값은 싣지 않고 있음/없음만 알려 준다.
  if (url.pathname === '/api/integrations' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      ok: true,
      ...integrations.readIntegrations(currentConfigFile(), { claude: claudeReady() }),
      install: process.env.WORKSPACE_MANAGED ? 'managed' : 'manual',
    }));
    return;
  }

  // 연동 저장 — 켜는 쪽은 먼저 지라·슬랙에 읽어 보고 성공했을 때만 쓴다.
  // `USES`·지라 설정은 서버가 뜰 때 읽으므로, launchd가 띄운 자리면 응답 뒤 스스로 끝낸다(다시 떠 준다).
  if (url.pathname === '/api/integrations/save' && req.method === 'POST') {
    readBody(req)
      .then(body => integrations.saveIntegrations({
        configPath: CONFIG_PATH,
        current: currentConfigFile(),
        body,
        jiraCheck: settings => require('./jira-client').checkJiraAccount(settings),
        slackCheck: (token, id) => integrations.slackCheckChannel(token, id),
      }))
      .then(({ result }) => {
        const managed = !!process.env.WORKSPACE_MANAGED;
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ...result, restart: managed }));
        integrations.scheduleRestart({ managed, exit: exitApp });
      })
      .catch((error) => {
        res.writeHead(error.status || 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: error.message }));
      });
    return;
  }

  if (url.pathname === '/api/automation/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ automations: getAutomationStatus() }));
    return;
  }

  // 미팅 노트 가져오기 — 조회는 파일을 쓰지 않고(로그·요청 표시 파일을 읽기만),
  // 요청은 표시 파일 하나만 쓴다. 프로세스는 띄우지 않는다.
  if (url.pathname === '/api/meeting-notes/status' && req.method === 'GET') {
    if (!USES.tiro) { res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '미팅 노트 가져오기를 쓰지 않도록 설정돼 있어요.' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(meetingNotesStatus()));
    return;
  }

  if (url.pathname === '/api/meeting-notes/request' && req.method === 'POST') {
    readBody(req).then(body => {
      const result = writeMeetingNotesRequest(body);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    }).catch(error => {
      res.writeHead(error.status || 400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: error.message, code: error.code }));
    });
    return;
  }

  if (url.pathname === '/api/items' && req.method === 'GET') {
    // 지라 목록이 묵었으면 갱신만 걸어 둔다 — 이 응답은 기다리지 않는다(지라 때문에 목록이 늦지 않게).
    if (USES.jira) jiraLive.nudge();
    // Automatic drafts are a read-only projection. Edited reports are saved explicitly.
    const allDecisions = getDecisions();
    const payload = {
      inboxTasks: getInboxTasks(),
      laterTasks: getLaterTasks(),
      waiting: getWaitingItems(),
      todayTasks: getTodayTasks(),
      ideas: getIdeas(),
      decisions: allDecisions.filter((d) => d.status !== 'done'),
      decisionArchive: allDecisions
        .filter((d) => d.status === 'done')
        .sort((a, b) => (b.completed || '').localeCompare(a.completed || '')),
      weeklyReports: getWeeklyReports(),
      jiraIssues: getJiraIssueCache(),
      jiraSync: getJiraSync(),
      slackSync: getSlackSync(),
      title: CONFIG.title || '내 워크스페이스',
      // 앱 화면 파일이 바뀌면 이 값이 달라진다. 브라우저가 이걸 보고 스스로 새로고침한다.
      appVersion: (() => {
        try {
          return ['index.html', ...clientFiles()].map(file => fs.statSync(path.join(PUBLIC_DIR, file)).mtimeMs).join(':');
        } catch {
          return '0';
        }
      })(),
      customGroups: getCustomGroups(),
      calendar: getCalendarWithLinks(),
      suggestions: getTodaySuggestions(),
      reportRefs: getReportRefs(),
      workflows: workflows.snapshot(),
      // 미팅 노트 가져오기의 지금 상태 — 페이지를 새로 열어도 진행 중인 가져오기가 이어지게 첫 조회에 함께 싣는다.
      meetingNotes: meetingNotesStatus(),
      storage,
      today: todayLocal(),
      ...getTodayActivityCounts(),
    };
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
    return;
  }

  // 설정 > `삭제한 항목`이 창을 열 때마다 읽는 목록. 조회라 어떤 파일도 쓰지 않고,
  // 인증 예외(publicAsset)에도 넣지 않는다. 되살리기는 기존 `/api/track/restore`가 맡는다.
  if (url.pathname === '/api/track/trash' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, items: listTrash() }));
    return;
  }

  if (req.method === 'POST' && ['/api/track/set-scheduled', '/api/track/seen', '/api/track/restore'].includes(url.pathname)) {
    readBody(req).then(({ id, scheduled }) => {
      if (url.pathname.endsWith('set-scheduled')) validateDate(scheduled);
      let ok;
      if (url.pathname.endsWith('/restore')) ok = restoreTrackItem(id);
      else if (url.pathname.endsWith('/seen')) ok = setTrackField(id, 'seen', 'true', null);
      else {
        ok = mutations.run(() => {
          const changed = setTrackField(id, 'scheduled', scheduled || 'none', 'task');
          if(changed)setTrackField(id, 'inbox', null, 'task');
          return changed;
        });
      }
      res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok }));
    }).catch(error => {
      res.writeHead(error.status || 400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: error.message || String(error), code: error.code }));
    });
    return;
  }

  if (url.pathname === '/api/meeting/set-project' && req.method === 'POST') {
    readBody(req)
      .then(({ title, project }) => {
        const ok = setMeetingLink(title, project || null);
        res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok }));
      })
      .catch((e) => {
        res.writeHead(e.status || 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message || String(e), code: e.code }));
      });
    return;
  }

  if (url.pathname === '/api/today-task/create' && req.method === 'POST') {
    readBody(req)
      .then((payload) => {
        const result = idempotent(req, payload, () => createManualTask(payload));
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
      })
      .catch((e) => {
        res.writeHead(e.status || 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message || String(e), code: e.code }));
      });
    return;
  }

  if (url.pathname === '/api/later-task/create' && req.method === 'POST') {
    readBody(req)
      .then((payload) => {
        const result = idempotent(req, payload, () => createLaterTask(payload));
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
      })
      .catch((e) => {
        res.writeHead(e.status || 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message || String(e), code: e.code }));
      });
    return;
  }

  if (url.pathname === '/api/waiting/create' && req.method === 'POST') {
    readBody(req)
      .then((payload) => {
        const result = idempotent(req, payload, () => createWaitingItem(payload));
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
      })
      .catch((e) => {
        res.writeHead(e.status || 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message || String(e), code: e.code }));
      });
    return;
  }

  if (url.pathname === '/api/decision/create' && req.method === 'POST') {
    readBody(req)
      .then((payload) => {
        const result = idempotent(req, payload, () => createDecision(payload));
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
      })
      .catch((e) => {
        res.writeHead(e.status || 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message || String(e), code: e.code }));
      });
    return;
  }

  if (url.pathname === '/api/idea/create' && req.method === 'POST') {
    readBody(req)
      .then((payload) => {
        const result = idempotent(req, payload, () => createIdea(payload));
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
      })
      .catch((e) => {
        res.writeHead(e.status || 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message || String(e), code: e.code }));
      });
    return;
  }

  if (url.pathname === '/api/idea/promote' && req.method === 'POST') {
    readBody(req)
      .then(({ id, due }) => {
        const result = promoteIdeaToToday(id, due);
        res.writeHead(result.ok ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
      })
      .catch((e) => {
        res.writeHead(e.status || 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message || String(e), code: e.code }));
      });
    return;
  }

  if (url.pathname === '/api/track/set-jira' && req.method === 'POST') {
    readBody(req)
      .then(({ id, jiraKey }) => {
        const ok = setTrackJira(id, jiraKey || null);
        res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok }));
      })
      .catch((e) => {
        res.writeHead(e.status || 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message || String(e), code: e.code }));
      });
    return;
  }

  if (url.pathname === '/api/track/set-group' && req.method === 'POST') {
    readBody(req)
      .then(({ id, group }) => {
        const ok = setTrackGroup(id, group || null);
        res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok }));
      })
      .catch((e) => {
        res.writeHead(e.status || 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message || String(e), code: e.code }));
      });
    return;
  }

  if (url.pathname === '/api/idea/set-project' && req.method === 'POST') {
    readBody(req)
      .then(({ id, project }) => {
        const ok = setIdeaProject(id, project || null);
        res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok }));
      })
      .catch((e) => {
        res.writeHead(e.status || 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message || String(e), code: e.code }));
      });
    return;
  }

  if (url.pathname === '/api/track/set-due' && req.method === 'POST') {
    readBody(req)
      .then(({ id, due }) => {
        const ok = setTrackDue(id, due || null);
        res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok }));
      })
      .catch((e) => {
        res.writeHead(e.status || 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message || String(e), code: e.code }));
      });
    return;
  }

  if (url.pathname === '/api/track/set-doing' && req.method === 'POST') {
    readBody(req)
      .then(({ id, doing }) => {
        const ok = setTrackDoing(id, !!doing);
        res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok }));
      })
      .catch((e) => {
        res.writeHead(e.status || 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message || String(e), code: e.code }));
      });
    return;
  }

  if (url.pathname === '/api/track/set-who' && req.method === 'POST') {
    readBody(req)
      .then(({ id, who }) => {
        const ok = setTrackWho(id, who || null);
        res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok }));
      })
      .catch((e) => {
        res.writeHead(e.status || 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message || String(e), code: e.code }));
      });
    return;
  }

  if (url.pathname === '/api/track/set-priority' && req.method === 'POST') {
    readBody(req)
      .then(({ id, priority }) => {
        const ok = setTrackPriority(id, priority || 'medium');
        res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok }));
      })
      .catch((e) => {
        res.writeHead(e.status || 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message || String(e), code: e.code }));
      });
    return;
  }

  if (url.pathname === '/api/track/set-description' && req.method === 'POST') {
    readBody(req)
      .then(({ id, description }) => {
        const ok = setTrackDescription(id, description);
        res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok }));
      })
      .catch((e) => {
        res.writeHead(e.status || 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message || String(e), code: e.code }));
      });
    return;
  }

  if (url.pathname === '/api/track/remove' && req.method === 'POST') {
    readBody(req)
      .then(({ id }) => {
        const removed = removeTrackItem(id);
        res.writeHead(removed ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: !!removed }));
      })
      .catch((e) => {
        res.writeHead(e.status || 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message || String(e), code: e.code }));
      });
    return;
  }

  if (url.pathname === '/api/track/toggle' && req.method === 'POST') {
    readBody(req)
      .then(({ id, status }) => {
        const ok = toggleTrackStatus(id, status);
        res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok }));
      })
      .catch((e) => {
        res.writeHead(e.status || 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message || String(e), code: e.code }));
      });
    return;
  }

  // 이 컴퓨터에만 두는 꾸밈(`local/local.css`). 저장소에 없는 파일이라 **없어도 빈 200**으로 준다 —
  // 화면은 늘 같은 한 줄을 읽고, 브라우저 콘솔에 404가 남지 않는다. 허용하는 경로는 이것 하나뿐이다.
  if (url.pathname === '/local/local.css' && req.method === 'GET') {
    let css = '';
    try { css = nativeFs.readFileSync(path.join(REPO_DIR, 'local', 'local.css'), 'utf8'); } catch { css = ''; }
    res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
    res.end(css);
    return;
  }

  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  // 앱에 내장한 글꼴(Pretendard)도 화면 파일과 같은 길로 나간다. 인증 예외(publicAsset)에는 넣지 않는다.
  // 화면 코드(`*.js`/`*.css`)는 isClientFile이 정한다 — 서버 파일·테스트·픽스처는 거기서 막힌다.
  if (!['/index.html','/manifest.webmanifest'].includes(filePath)
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
const batchTasks = require('./task-batch')({ files: listTrackerFiles, pattern: TRACK_RE, parse: parseFields, validateDate, today: todayLocal });
const reportDrafts = require('./report-drafts')({ directory: TRACKER_DIR, sources: () => workflows.snapshot().items, legacy: parseWeeklyReports, currentWeek: currentWeekKey });
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
function safeHandle(req, res) {
  try {
    if(req.method==='GET')readScope={files:new Map()};
    const host = req.headers.host || '';
    // 홈 화면 추가 때 브라우저가 로그인 정보 없이 가져가는 앱 아이콘·manifest만 인증 없이 연다.
    const publicAsset=req.method==='GET' && /^\/(icons\/[\w-]+\.png|manifest\.webmanifest)(\?.*)?$/.test(req.url||'');
    if(!publicAsset && !remoteAuthorized(req)) {res.writeHead(401,{'WWW-Authenticate':'Basic realm="Workspace"'});res.end('Authentication required');return;}
    const hostname = host.split(':')[0];
    if (!['localhost','127.0.0.1',EXTRA_HOST].filter(Boolean).includes(hostname)) { res.writeHead(403); res.end('Forbidden host'); return; }
    if (req.method === 'POST' && (req.headers['content-type']?.split(';')[0] !== 'application/json' || (req.headers.origin && req.headers.origin !== `http://${host}`) || req.headers['sec-fetch-site'] === 'cross-site')) { res.writeHead(403); res.end('Forbidden request'); return; }
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Cache-Control','no-store');
    handleRequest(req,res);
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
  fs.watchFile(path.join(TRACKER_DIR, 'calendar_today.md'), { interval: 1000, persistent: false }, archiveMeetings);
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

// `jiraLive`·`attentionLive`는 화면 확인용 픽스처가 "뜰 때 한 번 읽기"를 직접 켜 보려고 함께 내보낸다
// (테스트·픽스처 밖에서는 쓰지 않는다 — 운영에서는 위의 `start()`가 켠다).
module.exports = { server, jiraLive, attentionLive, setExitForTests };

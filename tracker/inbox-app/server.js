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
const { exec } = require('child_process');
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
    return { type, value, label: issue ? `${value} · ${issue.summary}` : value };
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

function projectLabelOf(item) {
  if (item.jira) {
    const issue = getJiraIssueCache().find((i) => i.key === item.jira);
    return issue ? `${item.jira} · ${issue.summary}` : item.jira;
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
          return ['index.html', 'app.js', 'ui.css', 'workflows.js', 'report-ui.js', 'report-ui.css'].map(file => fs.statSync(path.join(PUBLIC_DIR, file)).mtimeMs).join(':');
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

  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  // 앱에 내장한 글꼴(Pretendard)도 화면 파일과 같은 길로 나간다. 인증 예외(publicAsset)에는 넣지 않는다.
  if (!['/index.html','/app.js','/ui.css','/workflows.js','/report-ui.js','/report-ui.css','/manifest.webmanifest'].includes(filePath)
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
// 내 담당 티켓 목록도 앱이 직접 읽는다 — 값은 메모리에만 있고 파일은 쓰지 않는다.
// 설정이 없으면(`connected`가 거짓) 타이머도 첫 읽기도 돌지 않는다.
const jiraLive = require('./jira-live').createJiraLive({
  list: keys => jira.list(keys),
  keys: linkedJiraKeys,
  connected: () => USES.jira && jira.connected,
});
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
  // 복구를 끝내지 못해도 서버는 뜬다. 쓰기는 잠기고, 화면이 이유를 보여 줄 수 있게.
  try { mutations.recover(); } catch (error) { console.error('저장 복구가 필요합니다. 저장을 멈춥니다:', error.message); }
  if(EXTRA_HOST && !nativeFs.existsSync(ACCESS_TOKEN_PATH))atomicWrite(ACCESS_TOKEN_PATH,randomBytes(32).toString('hex'));
  const archiveMeetings = () => { try { mutations.run(() => workflows.archive()); } catch (error) { console.error('회의 기록 저장 실패:', error.message); } };
  archiveMeetings();
  // 지라 목록은 뜰 때 한 번, 그 뒤 10분마다 읽는다(설정이 있을 때만, 타이머는 unref).
  jiraLive.start();
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

// `jiraLive`는 화면 확인용 픽스처가 "뜰 때 한 번 읽기"를 직접 켜 보려고 함께 내보낸다
// (테스트·픽스처 밖에서는 쓰지 않는다 — 운영에서는 위의 `jiraLive.start()`가 켠다).
module.exports = { server, jiraLive };

// 사용 횟수(WP-R) — 이 맥에서 기능별로 몇 번 썼는지 날짜별 숫자만 센다. 문구·이름·업무 내용은 세지도 싣지도 않는다.
// 상태는 이 맥에만 두는 `local/usage.json` 하나다(업무 데이터가 아니다 — 백업·저장 트랜잭션 대상이 아니다).
//   { days: { 'YYYY-MM-DD': { 키: 횟수 } }, sent: { lastRound, lastDay, installSent, queue: [{ round, fields, queuedOn, lastTry }] } }
// 끄기는 따로 둔 표시 파일 `local/usage-off` 하나다 — 있으면 보내지 않는다(usage.json이 깨져 새로 만들어도 끈 것이 풀리지 않게).
// 세기는 끄든 켜든 계속한다(본인이 설정 › 앱 › `내 일 기록`에서 본다).
//
// 세는 자리는 서버가 우선이다 — 해당 API가 성공했을 때 +1(화면을 몇 개 열어도 한 번). 세기는 저장 트랜잭션 밖이다:
// 요청 안에서 센 것은 모아 두었다가 응답이 2xx로 끝난 뒤에 적는다(되돌린 저장은 세지 않는다). 세기가 실패해도 저장은 그대로다.
// 화면에서만 아는 것(탭 열기·검색·주간요약 복사)은 `POST /api/usage/tick { key }`로 받는다(허용 목록 키만).
//
// 보내기(설치·정기 신호, 3일째·8일째 체크인에 붙는 칸)는 checkin.js의 전송(`deliver` — 목적지 상수·가짜 fetch)과
// 같은 대기 규칙(다음에 열 때 하루 한 번, 7일 지나면 버림)을 쓴다. 폼이 닫혔으면(checkin의 closed) 모두 멈춘다.
// 만든 사람 설치(main 갈래)·개발 서버·테스트·픽스처는 체크인과 같이 보내지 않는다(그 판단은 체크인이 한다 — 체크인이
// 꺼져 있으면 여기의 보내기는 불리지 않는다). 프로세스는 띄우지 않는다.
const path = require('node:path');
const nativeFs = require('node:fs');
const { AsyncLocalStorage } = require('node:async_hooks');
const { atomicWrite } = require('./safe-storage');
const { CHECKIN_AUTO_ENTRIES } = require('./checkin');

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const KEEP_DAYS = 90;
const QUEUE_KEEP_DAYS = 7;
const PERIOD_DAYS = 3;
const VIEW_DAYS = 30;

// 세는 키와 `기능별 전체 보기`(내 일 기록 맨 아래)에 보이는 이름 — 이 목록 밖의 키는 세지 않는다.
const USAGE_KEYS = [
  ['tab_today', '오늘 탭 열기'], ['tab_projects', '프로젝트 탭 열기'], ['tab_meetings', '회의 탭 열기'],
  ['tab_records', '아이디어·결정 탭 열기'], ['tab_weekly', '주간요약 탭 열기'],
  ['task_add', '할 일 직접 추가'], ['task_done', '할 일 끝냄'], ['task_remove', '할 일 지움'],
  ['slack_in', '슬랙에서 들어옴'], ['slack_done', '슬랙 항목 끝냄'], ['slack_remove', '슬랙 항목 지움'],
  ['check_add', '확인 대기 추가'], ['idea_add', '아이디어 추가'], ['decision_add', '결정 추가'],
  ['search', '검색'], ['weekly_copy', '주간요약 복사'], ['jira_create', '지라 이슈 만들기'],
];
const USAGE_KEY_SET = new Set(USAGE_KEYS.map(([key]) => key));
// 화면이 알려 주는 키(`POST /api/usage/tick`) — 나머지는 서버가 API 성공 때 센다.
const TICK_KEYS = new Set(['tab_today', 'tab_projects', 'tab_meetings', 'tab_records', 'tab_weekly', 'search', 'weekly_copy']);
const TAB_NAMES = [['tab_today', '오늘'], ['tab_projects', '프로젝트'], ['tab_meetings', '회의'], ['tab_records', '아이디어·결정'], ['tab_weekly', '주간요약']];

// 폼의 사용 횟수 칸(13~21). 값은 숫자·탭 이름·부가 기능 한 줄뿐이다.
const USAGE_ENTRIES = {
  taskAdd: 'entry.2084830350',
  taskDone: 'entry.17557492',
  slackIn: 'entry.89048857',
  slackDone: 'entry.88850341',
  slackRemove: 'entry.1133996070',
  checkAdd: 'entry.1443298956',
  recordAdd: 'entry.158587108',
  topTab: 'entry.1467627926',
  extras: 'entry.1647372273',
};

const addDays = (day, n) => { const at = new Date(`${day}T00:00:00Z`); at.setUTCDate(at.getUTCDate() + n); return at.toISOString().slice(0, 10); };
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
const D8_FINISHED = new Set(['sent', 'queued', 'dropped', 'skipped']);

function freshState() {
  return { days: {}, sent: { lastRound: null, lastDay: null, installSent: false, queue: [] } };
}

// 읽은 값을 믿을 수 있는 모양으로 바꾼다. 못 읽거나 깨졌으면 새로(서버가 죽지 않게).
function normalizeUsage(raw) {
  const state = freshState();
  if (!raw || typeof raw !== 'object') return state;
  const days = raw.days && typeof raw.days === 'object' ? raw.days : {};
  for (const [day, counts] of Object.entries(days)) {
    if (!DAY_RE.test(day) || !counts || typeof counts !== 'object') continue;
    const kept = {};
    for (const [key, value] of Object.entries(counts)) {
      if (USAGE_KEY_SET.has(key) && Number.isInteger(value) && value > 0) kept[key] = value;
    }
    if (Object.keys(kept).length) state.days[day] = kept;
  }
  const sent = raw.sent && typeof raw.sent === 'object' ? raw.sent : {};
  if (typeof sent.lastRound === 'string') state.sent.lastRound = sent.lastRound.slice(0, 10);
  if (typeof sent.lastDay === 'string' && DAY_RE.test(sent.lastDay)) state.sent.lastDay = sent.lastDay;
  state.sent.installSent = sent.installSent === true;
  // 대기 중인 신호는 [entry, 글자] 쌍만 믿는다. 모양이 어긋나면 버린다.
  state.sent.queue = (Array.isArray(sent.queue) ? sent.queue : []).filter(item => item && typeof item === 'object'
    && typeof item.round === 'string' && DAY_RE.test(String(item.queuedOn || ''))
    && Array.isArray(item.fields) && item.fields.every(pair => Array.isArray(pair) && pair.length === 2 && pair.every(part => typeof part === 'string')))
    .slice(-10);
  return state;
}

// from~to(둘 다 포함) 사이의 합계. from이 없으면 처음부터.
function sumRange(state, from, to) {
  const total = {};
  for (const [day, counts] of Object.entries(state.days)) {
    if ((from && day < from) || day > to) continue;
    for (const [key, value] of Object.entries(counts)) total[key] = (total[key] || 0) + value;
  }
  return total;
}

// 폼 칸 13~21 — 합계만. 가장 많이 연 탭은 동률이면 앞의 것, 한 번도 없으면 빈칸.
function formPairs(total) {
  const n = key => total[key] || 0;
  let top = '';
  let best = 0;
  for (const [key, name] of TAB_NAMES) if (n(key) > best) { best = n(key); top = name; }
  return [
    [USAGE_ENTRIES.taskAdd, String(n('task_add'))],
    [USAGE_ENTRIES.taskDone, String(n('task_done'))],
    [USAGE_ENTRIES.slackIn, String(n('slack_in'))],
    [USAGE_ENTRIES.slackDone, String(n('slack_done'))],
    [USAGE_ENTRIES.slackRemove, String(n('slack_remove'))],
    [USAGE_ENTRIES.checkAdd, String(n('check_add'))],
    [USAGE_ENTRIES.recordAdd, String(n('idea_add') + n('decision_add'))],
    [USAGE_ENTRIES.topTab, top],
    [USAGE_ENTRIES.extras, `검색 ${n('search')} · 주간요약 ${n('weekly_copy')} · 지라 ${n('jira_create')}`],
  ];
}

// ---------- 내 일 기록의 업무 기준 숫자(WP-Y) ----------
// 주간요약 본문 `완료한 일`(report-drafts.js의 heading·eligible)과 같은 조건으로 업무 목록에서 날짜별 숫자만 센다(읽기만).
//   done[완료일]      — 할 일·버그, status done, completed 있음, created가 그 완료 주(월~일)의 일요일 이하(eligible과 같음)
//   doneSlack[완료일] — 그중 슬랙 출처(permalink)
//   inSlack/inDirect[만든 날] — 할 일·버그(슬랙 출처 / 나머지)
//   records[만든 날]  — { decision, idea, check } 결정·아이디어·확인 대기(확인 완료는 끝낸 일이 아니다)
// 지운 업무는 업무 목록에 없으니 세지 않고, 보고에서 사람이 뺀 문장의 업무는 그대로 센다(업무 수 기준).
// 날짜는 자르지 않는다(전체) — 주차 목록은 모든 주를 보여 주므로 상한이 있으면 오래된 주가 다시 빈 칸이 된다. 크기는 날짜 수에 비례.
const WORK_RECORD_TYPES = ['decision', 'idea', 'check'];
function weekSunday(day) {
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + (7 - at.getUTCDay()) % 7);
  return at.toISOString().slice(0, 10);
}
function workDaysFrom(items) {
  const work = { done: {}, doneSlack: {}, inSlack: {}, inDirect: {}, records: {} };
  const bump = (bag, day) => { bag[day] = (bag[day] || 0) + 1; };
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') continue;
    const created = DAY_RE.test(String(item.created || '')) ? item.created : null;
    if (item.type === 'task' || item.type === 'bug') {
      if (created) bump(item.permalink ? work.inSlack : work.inDirect, created);
      const completed = String(item.completed || '');
      if (item.status === 'done' && DAY_RE.test(completed) && created && created <= weekSunday(completed)) {
        bump(work.done, completed);
        if (item.permalink) bump(work.doneSlack, completed);
      }
    } else if (WORK_RECORD_TYPES.includes(item.type) && created) {
      const day = work.records[created] || (work.records[created] = {});
      day[item.type] = (day[item.type] || 0) + 1;
    }
  }
  return work;
}
// deps.workDays()가 준 값을 믿을 수 있는 모양으로 — 날짜 키·양의 정수만. 모양이 어긋나면 null(화면은 사용 기록으로 떨어진다).
function normalizeWork(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const counts = (bag) => {
    if (!bag || typeof bag !== 'object' || Array.isArray(bag)) return null;
    const kept = {};
    for (const [day, n] of Object.entries(bag)) if (DAY_RE.test(day) && Number.isInteger(n) && n > 0) kept[day] = n;
    return kept;
  };
  const work = {};
  for (const key of ['done', 'doneSlack', 'inSlack', 'inDirect']) { work[key] = counts(raw[key]); if (!work[key]) return null; }
  if (!raw.records || typeof raw.records !== 'object' || Array.isArray(raw.records)) return null;
  work.records = {};
  for (const [day, parts] of Object.entries(raw.records)) {
    if (!DAY_RE.test(day) || !parts || typeof parts !== 'object') continue;
    const kept = {};
    for (const type of WORK_RECORD_TYPES) if (Number.isInteger(parts[type]) && parts[type] > 0) kept[type] = parts[type];
    if (Object.keys(kept).length) work.records[day] = kept;
  }
  return work;
}

// deps: localDir() → 폴더(없으면 null — 세지 않는다. 테스트가 실제 local/에 쓰지 않게) · today()
//       · canSend() → 이 설치가 보낼 수 있나(체크인이 켜져 있고 폼이 닫히지 않음)
//       · workDays()(선택) → 업무 목록 기준 날짜별 숫자(workDaysFrom 모양). 없거나 던지거나 모양이 어긋나면 `work: null`.
function createUsage(deps) {
  const requestScope = new AsyncLocalStorage();
  let sending = false;   // 설치·정기 신호를 지금 보내는 중 — 두 창이 동시에 열어도 한 번만.
  const dir = () => { try { return deps.localDir(); } catch { return null; } };
  const file = () => path.join(dir(), 'usage.json');
  const offFile = () => path.join(dir(), 'usage-off');

  function load() {
    let raw = null;
    try { raw = JSON.parse(nativeFs.readFileSync(file(), 'utf8')); } catch { raw = null; }
    return normalizeUsage(raw);
  }
  function save(state, today) {
    const oldest = addDays(today, -KEEP_DAYS);
    for (const day of Object.keys(state.days)) if (day < oldest) delete state.days[day];
    nativeFs.mkdirSync(dir(), { recursive: true });
    atomicWrite(file(), `${JSON.stringify(state, null, 2)}\n`);
  }

  // 지금 +n. 실패해도 조용히(세기가 앱을 막지 않는다).
  function write(key, n = 1) {
    if (!USAGE_KEY_SET.has(key) || !(n > 0) || !dir()) return false;
    try {
      const today = deps.today();
      const state = load();
      const day = state.days[today] || (state.days[today] = {});
      day[key] = (day[key] || 0) + n;
      save(state, today);
      return true;
    } catch (error) {
      console.error('사용 횟수를 적지 못함:', error.message);
      return false;
    }
  }

  // 요청 안이면 모아 두었다가 응답이 2xx로 끝난 뒤에 적는다. 요청 밖이면 바로.
  function add(key, n = 1) {
    const bucket = requestScope.getStore();
    if (bucket) bucket.push([key, n]);
    else write(key, n);
  }

  // server.js의 safeHandle이 요청 하나를 이 안에서 돌린다.
  function observe(res, run) {
    const bucket = [];
    res.on('finish', () => {
      if (!bucket.length || res.statusCode < 200 || res.statusCode >= 300) return;
      for (const [key, n] of bucket) write(key, n);
    });
    return requestScope.run(bucket, run);
  }

  // ---------- 서버의 저장 함수에 씌우는 세기 ----------
  // 만들기 — 결과가 ok일 때만.
  const countCreate = (fn, key) => (...args) => {
    const result = fn(...args);
    if (result && result.ok) add(key);
    return result;
  };
  // 끝내기 — 바꾸기 전에 그 항목을 찾아 두고, 끝냄(done)으로 **새로** 바뀐 때만. 할 일이면 task_done, 슬랙 출처면 slack_done.
  const doneKeys = item => [item.type === 'task' ? 'task_done' : null, item.permalink ? 'slack_done' : null].filter(Boolean);
  const countToggle = (fn, lookup) => (id, desired, ...rest) => {
    let before = null;
    try { before = lookup(id); } catch { before = null; }
    const ok = fn(id, desired, ...rest);
    if (ok && before && before.status !== 'done' && (desired || 'done') === 'done') doneKeys(before).forEach(key => add(key));
    return ok;
  };
  // 지우기 — 지운 줄(종류·칸)로. 할 일이면 task_remove, 슬랙 출처면 slack_remove.
  const countRemove = fn => (...args) => {
    const removed = fn(...args);
    if (removed && removed.fields) {
      if (removed.type === 'task') add('task_remove');
      if (String(removed.fields.source || '').startsWith('slack:')) add('slack_remove');
    }
    return removed;
  };
  // 여러 개 완료(일괄) — 되돌리기(undoToken)는 세지 않는다.
  // lookupAll() → { id: 항목 } — 업무 목록을 요청마다 한 번만 읽는다.
  const countBatch = (fn, lookupAll) => (body, ...rest) => {
    const done = body && !body.undoToken && body.change && body.change.status === 'done' && Array.isArray(body.ids);
    let before = [];
    if (done) { try { const all = lookupAll(); before = body.ids.map(id => all[id]).filter(Boolean); } catch { before = []; } }
    const result = fn(body, ...rest);
    if (done && result && result.ok) {
      const total = {};
      for (const item of before) for (const key of doneKeys(item)) total[key] = (total[key] || 0) + 1;
      for (const [key, n] of Object.entries(total)) add(key, n);
    }
    return result;
  };
  // 지라 만들기 — 지라가 받아 준(ok) 때만. 원래 객체는 그대로 두고 create만 바꾼 겉을 돌려준다.
  const countJira = api => Object.assign(Object.create(api), {
    create: async (...args) => {
      const payload = await api.create(...args);
      if (payload && payload.ok) add('jira_create');
      return payload;
    },
  });

  // ---------- 끄기 ----------
  const sendOn = () => { const at = dir(); if (!at) return false; try { return !nativeFs.existsSync(offFile()); } catch { return false; } };
  function setSend(on) {
    if (!dir()) throw Object.assign(new Error('이 설치에서는 바꿀 수 없어요.'), { status: 409 });
    nativeFs.mkdirSync(dir(), { recursive: true });
    if (on) { nativeFs.rmSync(offFile(), { force: true }); return; }
    nativeFs.writeFileSync(offFile(), '익명 사용 횟수를 보내지 않아요(설정 › 앱).\n');
    // 끄면 아직 못 보낸 설치·정기 신호도 버린다.
    const state = load();
    if (state.sent.queue.length) { state.sent.queue = []; save(state, deps.today()); }
  }

  // 3일째·8일째 체크인에 붙는 칸(checkin.js의 act가 부른다). 구간 = 지난번 보낸 날 다음 날 ~ 오늘.
  // 끈 사람은 칸을 비우고(빈 목록), 구간만 오늘로 넘긴다 — 다시 켜도 끈 동안의 횟수가 나가지 않게.
  function formFields(round, today) {
    if (!dir()) return [];
    try {
      const state = load();
      const from = state.sent.lastDay ? addDays(state.sent.lastDay, 1) : null;
      const pairs = sendOn() ? formPairs(sumRange(state, from, today)) : [];
      state.sent.lastDay = today;
      if (pairs.length) state.sent.lastRound = round;
      save(state, today);
      return pairs;
    } catch (error) {
      console.error('사용 횟수 칸을 만들지 못함:', error.message);
      return [];
    }
  }

  // 앱을 열 때(체크인 GET) — 설치 신호 한 번, 대기 신호 다시 보내기, 정기 신호(8일째가 끝난 뒤 3일마다).
  // tools: { deliver(pairs) → 'sent'|'closed'|'failed', autoFields(label) → 자동 칸, markClosed() }
  // checkin: { openDays, rounds } — 체크인 상태를 읽기만 한다.
  async function opened(checkin, today, tools) {
    if (!dir() || sending) return;
    sending = true;
    try {
      const state = load();
      const jobs = [];
      if (!sendOn()) {
        // 끈 동안에는 아무것도 보내지 않고 구간만 오늘로 넘긴다.
        if (state.sent.lastDay !== today || state.sent.queue.length) {
          state.sent.lastDay = today;
          state.sent.queue = [];
          save(state, today);
        }
        return;
      }
      // 대기 — 7일 지나면 버리고, 아니면 하루 한 번 다시.
      state.sent.queue = state.sent.queue.filter(item => daysBetween(item.queuedOn, today) <= QUEUE_KEEP_DAYS);
      for (const item of state.sent.queue) {
        if (item.lastTry === today) continue;
        item.lastTry = today;
        jobs.push(item);
      }
      // 설치 — 이 설치에서 처음 연 날 한 번(기존 사용자는 업데이트 뒤 처음 연 날 한 번). 회차·익명 번호·버전만.
      if (!state.sent.installSent) {
        state.sent.installSent = true;
        const keep = new Set([CHECKIN_AUTO_ENTRIES.round, CHECKIN_AUTO_ENTRIES.id, CHECKIN_AUTO_ENTRIES.version]);
        const fields = tools.autoFields('설치').filter(([entry]) => keep.has(entry));
        jobs.push({ round: '설치', fields, queuedOn: today, lastTry: today, fresh: true });
      }
      // 정기 — 8일째 체크인이 끝난 뒤, 지난번 보낸 날부터 3일이 지났고 그 구간에 앱을 연 날이 있을 때.
      const d8 = checkin && checkin.rounds && checkin.rounds.d8;
      if (d8 && D8_FINISHED.has(d8.state)) {
        if (!state.sent.lastDay) {
          state.sent.lastDay = today;   // 8일째를 이 버전 전에 끝낸 사람 — 오늘부터 센다.
        } else if (daysBetween(state.sent.lastDay, today) >= PERIOD_DAYS) {
          const from = addDays(state.sent.lastDay, 1);
          const openDays = Array.isArray(checkin.openDays) ? checkin.openDays : [];
          if (openDays.some(day => day >= from && day <= today)) {
            const fields = [...tools.autoFields('정기'), ...formPairs(sumRange(state, from, today))];
            jobs.push({ round: '정기', fields, queuedOn: today, lastTry: today, fresh: true });
            state.sent.lastRound = '정기';
          }
          state.sent.lastDay = today;
        }
      }
      save(state, today);
      if (!jobs.length) return;
      // 하나씩 보낸다. 폼이 닫혔으면 체크인에 알리고 모두 멈춘다.
      const results = [];
      for (const job of jobs) {
        const outcome = await tools.deliver(job.fields);
        results.push([job, outcome]);
        if (outcome === 'closed') break;
      }
      const after = load();
      const closed = results.some(([, outcome]) => outcome === 'closed');
      if (closed) {
        after.sent.queue = [];
        tools.markClosed();
      } else {
        for (const [job, outcome] of results) {
          const same = item => item.round === job.round && item.queuedOn === job.queuedOn;
          if (outcome === 'sent') after.sent.queue = after.sent.queue.filter(item => !same(item));
          else if (job.fresh) after.sent.queue.push({ round: job.round, fields: job.fields, queuedOn: job.queuedOn, lastTry: today });
          else after.sent.queue = after.sent.queue.map(item => (same(item) ? { ...item, lastTry: today } : item));
        }
      }
      save(after, today);
    } catch (error) {
      console.error('사용 횟수를 보내지 못함:', error.message);
    } finally {
      sending = false;
    }
  }

  // `기능별 전체 보기` — 최근 30일 합계(오늘 포함).
  function recent(today) {
    const total = dir() ? sumRange(load(), addDays(today, -(VIEW_DAYS - 1)), today) : {};
    return USAGE_KEYS.map(([key, label]) => ({ key, label, count: total[key] || 0 }));
  }

  function json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }

  // server.js의 ROUTE_MODULES에 들어가는 경로(`/api/usage`·`/api/usage/tick`·`/api/usage/setting`).
  // 쓰기(POST)는 handleRequest 맨 위의 복구 필요 차단을 그대로 탄다.
  function route(req, res, url, ctx) {
    if (!url.pathname.startsWith('/api/usage')) return false;
    if (url.pathname === '/api/usage' && req.method === 'GET') {
      let canSend = false;
      try { canSend = !!deps.canSend(); } catch { canSend = false; }
      // today·history는 `내 일 기록`(화면이 계산)용 — 보관 중인 날 전부(최대 90일, 알려진 키만 · normalizeUsage 결과 그대로).
      const today = deps.today();
      let history = {};
      if (dir()) {
        try {
          const oldest = addDays(today, -KEEP_DAYS);
          history = Object.fromEntries(Object.entries(load().days).filter(([day]) => day >= oldest));
        } catch { history = {}; }
      }
      // work는 `내 일 기록`의 끝낸 일·들어온 일·남긴 기록 기준(보고 본문과 같은 업무 기록). 읽지 못해도 응답은 200 그대로.
      let work = null;
      try { work = typeof deps.workDays === 'function' ? normalizeWork(deps.workDays()) : null; } catch { work = null; }
      json(res, 200, { ok: true, send: sendOn(), canSend, days: VIEW_DAYS, rows: recent(today), today, history, work });
      return true;
    }
    if (url.pathname === '/api/usage/tick' && req.method === 'POST') {
      ctx.readBody(req, 1024)
        .then((body) => {
          const key = body && body.key;
          if (typeof key !== 'string' || !TICK_KEYS.has(key)) { json(res, 400, { ok: false, error: '셀 수 없는 항목이에요.' }); return; }
          add(key);
          json(res, 200, { ok: true });
        })
        .catch(() => json(res, 400, { ok: false, error: '요청을 확인해 주세요.' }));
      return true;
    }
    if (url.pathname === '/api/usage/setting' && req.method === 'POST') {
      ctx.readBody(req, 1024)
        .then((body) => {
          if (!body || typeof body.send !== 'boolean') { json(res, 400, { ok: false, error: '켜기·끄기를 확인해 주세요.' }); return; }
          setSend(body.send);
          json(res, 200, { ok: true, send: sendOn() });
        })
        .catch(error => json(res, error.status || 400, { ok: false, error: error.status ? error.message : '요청을 확인해 주세요.' }));
      return true;
    }
    json(res, 405, { ok: false, error: '지원하지 않는 요청이에요.' });
    return true;
  }

  return {
    add, write, observe, countCreate, countToggle, countRemove, countBatch, countJira,
    sendOn, setSend, formFields, opened, recent, route, load,
  };
}

module.exports = { createUsage, normalizeUsage, formPairs, sumRange, workDaysFrom, normalizeWork, USAGE_KEYS, TICK_KEYS, USAGE_ENTRIES };

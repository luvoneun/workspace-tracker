// 체크인(WP-N) — 설치 3일째·8일째에 앱 안의 작은 창으로 묻고, 답을 구글 폼으로 익명 제출한다.
// 상태는 이 맥에만 두는 `local/checkin.json` 하나다(업무 데이터가 아니다 — 백업·저장 트랜잭션 대상이 아니다).
//   { id(무작위 익명 번호), firstDay, openDays: [YYYY-MM-DD…](최근 30개), shownOn, closed?,
//     rounds: { d3: { state, snoozedOn?, sentAt?, queued?, queuedOn?, lastTry? }, d8: {…} } }
//   state: pending(아직) · snoozed(`나중에` 한 번 씀) · sent(보냄) · skipped(3일째를 못 한 채 8일째가 옴)
//          · queued(보내지 못해 대기 — 다음에 앱을 열 때 하루 한 번 다시) · dropped(대기 7일이 지나 버림)
// 보내는 곳(폼 주소·entry 번호)은 이 파일의 상수다 — 설정으로 바꿀 수 없다(사용자 입력으로 목적지를 못 바꾼다).
// 보내는 값은 선택지 상수에 있는 글자·한 줄 의견·자동 칸(회차·익명 번호·연 날 수·켠 연동·버전)뿐이다.
// 이름·업무 내용·토큰은 읽지도 싣지도 않는다. 프로세스는 띄우지 않는다.
const path = require('node:path');
const nativeFs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { atomicWrite } = require('./safe-storage');

const CHECKIN_FORM_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSdR8CXAWAFHj34BflE195w-fwL1cYiWX2ArCcEN_hLo9Os-tA/formResponse';
const CHECKIN_TIMEOUT_MS = 10000;
const OPEN_DAYS_MAX = 30;
const QUEUE_KEEP_DAYS = 7;
const COMMENT_MAX = 300;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// 회차 — 달력 날짜(설치 뒤 며칠)와 앱을 연 날 수가 **둘 다** 차야 묻는다(거의 안 연 사람에게 이르게 묻지 않게).
const CHECKIN_ROUNDS = {
  d3: { days: 3, opens: 2, label: '3일째', eyebrow: '쓴 지 3일 · 30초면 끝나요' },
  d8: { days: 8, opens: 4, label: '8일째', eyebrow: '쓴 지 8일 · 마지막 질문이에요' },
};

// 질문 — **화면에 보이는 글자 = 폼으로 보내는 글자**다. 구글 폼의 선택지와 한 글자라도 다르면 구글이 다른 값으로 받으므로
// 화면(checkin-ui.js)도 이 목록을 `GET /api/checkin`으로 받아 그대로 그린다(따로 적지 않는다). 제목도 폼과 같다.
const CHECKIN_QUESTIONS = [
  { key: 'setup', round: 'd3', kind: 'single', entry: 'entry.2037894728', title: '설치와 설정이 어렵지 않았나요?',
    options: ['쉬웠어요', '괜찮았어요', '어려웠어요'] },
  { key: 'helped', round: 'd3', kind: 'multi', entry: 'entry.1269347696', title: '가장 도움이 된 것', hint: '여러 개 골라도 돼요',
    options: ['오늘 할 일', '슬랙 모으기', '지라', '캘린더', '회의록', '주간요약', '아이디어', '결정', '확인 대기', '프로젝트'] },
  { key: 'missed', round: 'd8', kind: 'single', entry: 'entry.1378637955', title: '일을 놓치는 일이 줄었나요?',
    options: ['많이 줄었어요', '조금 줄었어요', '비슷해요', '모르겠어요'] },
  { key: 'time', round: 'd8', kind: 'single', entry: 'entry.1234968716', title: '하루에 일 정리하는 시간이 줄었나요?',
    options: ['많이 줄었어요', '조금 줄었어요', '비슷해요', '늘었어요'] },
  { key: 'nps', round: 'd8', kind: 'scale', entry: 'entry.2037688011', title: '아직 안 쓰는 다른 동료에게 추천하고 싶은 정도',
    options: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'], ends: ['전혀 아니에요', '꼭 추천해요'] },
  { key: 'keep', round: 'd8', kind: 'single', entry: 'entry.1481130540', title: '앞으로도 계속 쓸 건가요?',
    options: ['네', '아마도', '아니요'] },
  { key: 'comment', round: 'both', kind: 'text', entry: 'entry.432833444', title: '불편한 점이나 바라는 것', hint: '선택',
    placeholder: '한 줄이면 충분해요', max: COMMENT_MAX },
];
// 앱이 채우는 칸 — 사람은 고르지 않는다.
const CHECKIN_AUTO_ENTRIES = {
  round: 'entry.748332918',
  id: 'entry.248676657',
  openDays: 'entry.2116715760',
  integrations: 'entry.1292009508',
  version: 'entry.1937966223',
};
const INTEGRATION_NAMES = [['slack', '슬랙'], ['jira', '지라'], ['calendar', '캘린더'], ['notes', '회의록']];
// 폼이 닫혔을 때 구글이 돌려주는 페이지(주소 `…/closedform` 또는 "응답을 더 이상 받지 않음" 문구).
const RECORDED_RE = /응답이 기록되었습니다|Your response has been recorded/i;
const CLOSED_RE = /closedform|no longer accepting responses|더 이상 응답을 받지 않|응답을 더 이상 받지 않/i;

const questionsFor = round => CHECKIN_QUESTIONS.filter(q => q.round === round || q.round === 'both');
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
const OPEN_STATES = new Set(['pending', 'snoozed']);
const KNOWN_STATES = new Set(['pending', 'snoozed', 'sent', 'skipped', 'queued', 'dropped']);

function badRequest(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

// 답을 허용 목록으로 거른다 — 그 회차의 질문, 그 질문의 선택지 글자만. 의견 칸은 줄바꿈을 지운 한 줄 300자.
// 빈 답은 괜찮다(필수 없음). 어긋난 값이 하나라도 있으면 통째로 거절한다(조용히 바꿔 보내지 않는다).
function cleanAnswers(round, answers) {
  if (answers === undefined || answers === null) return [];
  if (typeof answers !== 'object' || Array.isArray(answers)) throw badRequest('답의 형식을 확인해 주세요.');
  const allowed = new Map(questionsFor(round).map(q => [q.key, q]));
  const pairs = [];
  for (const [key, value] of Object.entries(answers)) {
    const question = allowed.get(key);
    if (!question) throw badRequest('받을 수 없는 질문이에요.');
    if (value === undefined || value === null || value === '') continue;
    if (question.kind === 'text') {
      if (typeof value !== 'string') throw badRequest('의견은 글자로 보내 주세요.');
      // 줄바꿈·제어 문자를 한 칸으로 바꾸고 한 줄 300자까지만.
      const line = value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, COMMENT_MAX);
      if (line) pairs.push([question.entry, line]);
      continue;
    }
    const list = question.kind === 'multi' ? value : [value];
    if (!Array.isArray(list)) throw badRequest('여러 개 고르는 답의 형식을 확인해 주세요.');
    const seen = new Set();
    for (const one of list) {
      const text = typeof one === 'number' && Number.isInteger(one) ? String(one) : one;
      if (typeof text !== 'string' || !question.options.includes(text)) throw badRequest('고를 수 없는 답이 있어요.');
      if (seen.has(text)) continue;
      seen.add(text);
      pairs.push([question.entry, text]);
    }
  }
  return pairs;
}

// 폼 본문 — 체크박스처럼 여러 값이면 같은 entry가 되풀이된다.
function formBody(pairs) {
  const params = new URLSearchParams();
  for (const [key, value] of pairs) params.append(key, value);
  return params.toString();
}

function freshState(today) {
  return { id: randomUUID(), firstDay: today, openDays: [today], rounds: { d3: { state: 'pending' }, d8: { state: 'pending' } } };
}

// 읽은 값을 믿을 수 있는 모양으로 바꾼다. 못 읽거나 깨졌으면 새로 만든다(새 익명 번호, firstDay=오늘) — 서버가 죽지 않게.
function normalizeState(raw, today) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id || !DAY_RE.test(String(raw.firstDay || ''))) {
    return { state: freshState(today), created: true, changed: true };
  }
  let changed = false;
  const state = { id: raw.id.slice(0, 64), firstDay: raw.firstDay, openDays: [], rounds: {} };
  // 시계가 거꾸로 갔으면(firstDay가 오늘보다 뒤) 오늘로 바로잡는다 — 날짜 계산이 음수가 되지 않게.
  if (state.firstDay > today) { state.firstDay = today; changed = true; }
  const days = Array.isArray(raw.openDays) ? raw.openDays.filter(day => typeof day === 'string' && DAY_RE.test(day)) : [];
  state.openDays = [...new Set(days)].sort().slice(-OPEN_DAYS_MAX);
  if (typeof raw.shownOn === 'string' && DAY_RE.test(raw.shownOn)) state.shownOn = raw.shownOn;
  if (raw.closed === true) state.closed = true;
  for (const key of Object.keys(CHECKIN_ROUNDS)) {
    const round = raw.rounds && typeof raw.rounds === 'object' ? raw.rounds[key] : null;
    const kept = round && typeof round === 'object' && KNOWN_STATES.has(round.state) ? { ...round } : { state: 'pending' };
    // 대기 중인 답은 [entry, 글자] 쌍만 믿는다. 모양이 어긋나면 버린다.
    if (kept.state === 'queued') {
      const fields = kept.queued && Array.isArray(kept.queued.fields) ? kept.queued.fields : null;
      const ok = fields && fields.every(pair => Array.isArray(pair) && pair.length === 2 && pair.every(part => typeof part === 'string'));
      if (!ok || !DAY_RE.test(String(kept.queuedOn || ''))) { kept.state = 'dropped'; delete kept.queued; changed = true; }
    }
    state.rounds[key] = kept;
  }
  return { state, created: false, changed };
}

// deps: localDir() · today() · enabled() · version() · integrations() → { slack, jira, calendar, notes }
//       · request(url, options) → Response(가짜 fetch를 끼울 수 있다) · timeoutMs(테스트용)
//       · usageFields(label, today) → 사용 횟수 칸(WP-R, 없으면 없음) · onOpen(state, today, tools) → 앱을 연 날의 사용 횟수 신호(WP-R)
//       · usageOn() → 사용 횟수를 함께 보내는지(창 안내 문구·대기 답 재전송) · usageEntries → 사용 횟수 칸 번호 목록
function createCheckin(deps) {
  const inflight = new Set();   // 지금 보내는 중인 회차 — 두 창이 같은 회차를 동시에 보내도 한 번만.
  const timeoutMs = () => (deps.timeoutMs && deps.timeoutMs()) || CHECKIN_TIMEOUT_MS;
  const file = () => path.join(deps.localDir(), 'checkin.json');

  function load(today) {
    let raw = null;
    try { raw = JSON.parse(nativeFs.readFileSync(file(), 'utf8')); } catch { raw = null; }
    return normalizeState(raw, today);
  }
  function save(state) {
    nativeFs.mkdirSync(deps.localDir(), { recursive: true });
    atomicWrite(file(), `${JSON.stringify(state, null, 2)}\n`);
  }

  function eligible(state, key, today) {
    const rule = CHECKIN_ROUNDS[key];
    const days = Math.max(0, daysBetween(state.firstDay, today));
    return days >= rule.days && state.openDays.length >= rule.opens;
  }

  // 오늘 물을 회차. 3일째를 못 한 채 8일째 조건이 차면 3일째는 `건너뜀`으로 두고 8일째만 묻는다(창을 연달아 띄우지 않는다).
  // 연 날이 모자라 8일째 조건이 안 차면 달력이 8일을 넘어도 3일째부터 차례로 묻는다.
  function choose(state, today) {
    const { d3, d8 } = state.rounds;
    let changed = false;
    if (OPEN_STATES.has(d3.state) && OPEN_STATES.has(d8.state) && eligible(state, 'd8', today)) {
      state.rounds.d3 = { state: 'skipped' };
      changed = true;
    }
    const askable = key => {
      const round = state.rounds[key];
      if (!OPEN_STATES.has(round.state) || !eligible(state, key, today)) return false;
      return !(round.state === 'snoozed' && round.snoozedOn >= today);   // `나중에`는 다음 날(날짜가 바뀐 뒤)
    };
    if (OPEN_STATES.has(state.rounds.d3.state)) return { pick: askable('d3') ? 'd3' : null, changed };
    return { pick: askable('d8') ? 'd8' : null, changed };
  }

  // 구글 폼으로 보낸다. 결과: 'sent' · 'closed'(폼이 닫힘·지워짐 — 다시 묻지 않는다) · 'failed'(오프라인·오류·시간 초과 — 대기).
  async function deliver(pairs) {
    let timer = null;
    const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('시간 초과')), timeoutMs()); });
    try {
      const run = (async () => {
        const controller = new AbortController();
        const stop = setTimeout(() => controller.abort(), timeoutMs());
        try {
          const response = await deps.request(CHECKIN_FORM_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
            body: formBody(pairs),
            signal: controller.signal,
          });
          if (response.status === 404 || response.status === 410) return 'closed';
          const finalUrl = String(response.url || '');
          if (/\/closedform/.test(finalUrl)) return 'closed';
          let text = '';
          try { text = await response.text(); } catch { text = ''; }
          // "응답이 기록됨" 문구가 있으면 무엇이 섞여 있든 보낸 것 — 정상 페이지의 글자로 영구 중지되지 않게.
          if (response.ok && RECORDED_RE.test(text)) return 'sent';
          if (CLOSED_RE.test(text)) return 'closed';
          // 그 밖의 성공은 구글 formResponse 자리의 정상 응답만 — 사내 차단·로그인 페이지(200)는 보낸 것으로 치지 않는다.
          if (response.ok && (!finalUrl || /^https:\/\/docs\.google\.com\/forms\/.*\/formResponse/.test(finalUrl))) return 'sent';
          return 'failed';
        } finally { clearTimeout(stop); }
      })();
      return await Promise.race([run, late]);
    } catch {
      return 'failed';
    } finally {
      clearTimeout(timer);
    }
  }

  // 보낸 결과를 파일에 적는다(보내는 동안 다른 요청이 파일을 고쳤을 수 있으니 다시 읽고 그 회차만 바꾼다).
  function settle(key, outcome, pairs, today) {
    const { state } = load(today);
    if (outcome === 'closed') {
      state.closed = true;
      for (const name of Object.keys(state.rounds)) {
        if (state.rounds[name].state === 'queued') state.rounds[name] = { state: 'dropped' };
      }
      if (OPEN_STATES.has(state.rounds[key].state) || state.rounds[key].state === 'queued') state.rounds[key] = { state: 'dropped' };
    } else if (outcome === 'sent') {
      state.rounds[key] = { state: 'sent', sentAt: new Date().toISOString() };
    } else {
      const before = state.rounds[key];
      state.rounds[key] = before.state === 'queued'
        ? { ...before, lastTry: today }
        : { state: 'queued', queued: { fields: pairs }, queuedOn: today, lastTry: today };
    }
    save(state);
    return outcome;
  }

  async function send(key, pairs, today) {
    inflight.add(key);
    try {
      const outcome = await deliver(pairs);
      return settle(key, outcome, pairs, today);
    } finally {
      inflight.delete(key);
    }
  }

  function autoPairs(state, key) {
    return autoFields(state, CHECKIN_ROUNDS[key].label);
  }
  // 회차 글자를 받는 자동 칸 — 사용 횟수의 `설치`·`정기` 신호(usage.js)도 같은 칸을 쓴다.
  function autoFields(state, label) {
    let on = {};
    try { on = deps.integrations() || {}; } catch { on = {}; }
    const names = INTEGRATION_NAMES.filter(([flag]) => on[flag]).map(([, name]) => name);
    let version = '';
    try { version = String(deps.version() || ''); } catch { version = ''; }
    return [
      [CHECKIN_AUTO_ENTRIES.round, label],
      [CHECKIN_AUTO_ENTRIES.id, state.id],
      [CHECKIN_AUTO_ENTRIES.openDays, String(state.openDays.length)],
      [CHECKIN_AUTO_ENTRIES.integrations, names.join(', ')],
      [CHECKIN_AUTO_ENTRIES.version, version],
    ];
  }

  // GET — 오늘을 연 날에 더하고, 대기 중인 답을 조용히 한 번 다시 보내고, 오늘 띄울 회차를 알려 준다.
  // 돌려주는 promise(`retry`)는 테스트가 재전송이 끝나기를 기다리려고 쓴다(화면 응답은 기다리지 않는다).
  function poll() {
    if (!deps.enabled()) return { result: { show: null }, retry: Promise.resolve() };
    const today = deps.today();
    const { state, created, changed: fixed } = load(today);
    if (created) { save(state); return { result: { show: null }, retry: usageOpened(state, today) }; }
    let changed = fixed;
    if (state.closed) {
      if (changed) save(state);
      return { result: { show: null }, retry: Promise.resolve() };
    }
    if (!state.openDays.includes(today)) {
      state.openDays = [...state.openDays, today].sort().slice(-OPEN_DAYS_MAX);
      changed = true;
    }
    const retries = [];
    for (const key of Object.keys(CHECKIN_ROUNDS)) {
      const round = state.rounds[key];
      if (round.state !== 'queued') continue;
      if (daysBetween(round.queuedOn, today) > QUEUE_KEEP_DAYS) {
        state.rounds[key] = { state: 'dropped' };
        changed = true;
      } else if (round.lastTry !== today && !inflight.has(key)) {
        round.lastTry = today;
        changed = true;
        retries.push([key, withoutUsage(round.queued.fields)]);
      }
    }
    const { pick, changed: skipped } = choose(state, today);
    changed = changed || skipped;
    let result = { show: null };
    if (pick && state.shownOn !== today) {
      state.shownOn = today;
      changed = true;
      result = {
        show: pick,
        canSnooze: state.rounds[pick].state !== 'snoozed',
        eyebrow: CHECKIN_ROUNDS[pick].eyebrow,
        usageOn: !!(deps.usageOn && deps.usageOn()),
        questions: questionsFor(pick).map(({ entry, round, ...question }) => question),
      };
    }
    if (changed) save(state);
    const retry = Promise.all([...retries.map(([key, fields]) => send(key, fields, today).catch(() => 'failed')), usageOpened(state, today)]);
    return { result, retry };
  }

  // POST — `나중에`(회차마다 한 번) 또는 `보내기`.
  async function act(body) {
    if (!deps.enabled()) throw badRequest('이 설치에서는 체크인을 쓰지 않아요.', 403);
    const { round: key, action, answers } = body || {};
    if (!Object.prototype.hasOwnProperty.call(CHECKIN_ROUNDS, key)) throw badRequest('회차를 확인해 주세요.');
    if (action !== 'snooze' && action !== 'send') throw badRequest('동작을 확인해 주세요.');
    const today = deps.today();
    const { state, created } = load(today);
    if (created) { save(state); throw badRequest('지금 물어볼 차례가 아니에요.', 409); }
    if (state.closed) return { closed: true };
    const round = state.rounds[key];
    // 이미 보냈거나(대기 포함) 지금 보내는 중이면 다시 보내지 않는다 — 같은 회차는 한 번만.
    if (round.state === 'sent' || round.state === 'queued' || inflight.has(key)) return { already: true };
    if (!OPEN_STATES.has(round.state) || !eligible(state, key, today)) throw badRequest('지금 물어볼 차례가 아니에요.', 409);
    if (action === 'snooze') {
      if (round.state === 'snoozed') throw badRequest('‘나중에’는 한 번만 할 수 있어요.', 409);
      state.rounds[key] = { state: 'snoozed', snoozedOn: today };
      save(state);
      return { snoozed: true };
    }
    const answered = cleanAnswers(key, answers);
    const pairs = [...autoPairs(state, key), ...usagePairs(key, today), ...answered];
    const outcome = await send(key, pairs, today);
    return outcome === 'sent' ? { sent: true } : outcome === 'closed' ? { closed: true } : { queued: true };
  }

  // 사용 횟수(WP-R) — 칸과 신호는 usage.js가 만들고, 보내는 길(deliver)·폼 닫힘은 여기 것을 그대로 쓴다.
  function usagePairs(key, today) {
    if (!deps.usageFields) return [];
    try { return deps.usageFields(CHECKIN_ROUNDS[key].label, today) || []; } catch { return []; }
  }
  function usageOpened(state, today) {
    if (!deps.onOpen) return Promise.resolve();
    const tools = { deliver, autoFields: label => autoFields(state, label), markClosed: () => markClosed(today) };
    return Promise.resolve().then(() => deps.onOpen({ openDays: [...state.openDays], rounds: { ...state.rounds } }, today, tools)).catch(() => {});
  }
  // 끄기 전에 제출해 대기로 남은 답 — 다시 보낼 때 지금 꺼져 있으면 사용 횟수 칸을 뺀다(질문 답·자동 칸은 그대로).
  function withoutUsage(fields) {
    if (!deps.usageEntries || (deps.usageOn && deps.usageOn())) return fields;
    const drop = new Set(deps.usageEntries);
    return fields.filter(([entry]) => !drop.has(entry));
  }
  // 폼이 닫혔다(사용 횟수 신호가 알아냄) — settle의 `closed`와 같게 적는다.
  function markClosed(today) {
    const { state } = load(today);
    state.closed = true;
    for (const name of Object.keys(state.rounds)) {
      if (state.rounds[name].state === 'queued') state.rounds[name] = { state: 'dropped' };
    }
    save(state);
  }
  // 이 설치가 지금 보낼 수 있나(켜져 있고 폼이 닫히지 않음) — 사용설명서·설정의 알림 줄을 보일지 정한다. 파일을 쓰지 않는다.
  function canSend() {
    if (!deps.enabled()) return false;
    let raw = null;
    try { raw = JSON.parse(nativeFs.readFileSync(file(), 'utf8')); } catch { raw = null; }
    return !(raw && raw.closed === true);
  }

  function json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }

  // server.js의 ROUTE_MODULES에 들어가는 경로 하나(`/api/checkin`). 복구 필요 중에는 띄우지 않는다(쓰기는 handleRequest가 이미 막는다).
  function route(req, res, url, ctx) {
    if (url.pathname !== '/api/checkin') return false;
    if (req.method === 'GET') {
      if (ctx.storage && ctx.storage.recoveryNeeded) { json(res, 200, { ok: true, show: null }); return true; }
      try {
        const { result } = poll();
        json(res, 200, { ok: true, ...result });
      } catch (error) {
        console.error('체크인 상태를 읽지 못함:', error.message);
        json(res, 200, { ok: true, show: null });
      }
      return true;
    }
    if (req.method === 'POST') {
      ctx.readBody(req, 16 * 1024)
        .then(body => act(body))
        .then(result => json(res, 200, { ok: true, ...result }))
        .catch(error => json(res, error.status || 500, { ok: false, error: error.status ? error.message : '체크인을 처리하지 못했어요.' }));
      return true;
    }
    json(res, 405, { ok: false, error: '지원하지 않는 요청이에요.' });
    return true;
  }

  return { poll, act, route, inflight, canSend };
}

module.exports = {
  createCheckin, cleanAnswers, formBody, normalizeState, questionsFor,
  CHECKIN_FORM_URL, CHECKIN_QUESTIONS, CHECKIN_AUTO_ENTRIES, CHECKIN_ROUNDS, CHECKIN_TIMEOUT_MS,
};

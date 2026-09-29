// 사용 횟수(WP-R) 화면 — 세기·보내기는 서버(usage.js)가 한다. 여기서는
//  ① 화면에서만 아는 것(탭 열기·검색·주간요약 복사)을 `POST /api/usage/tick`으로 알리고
//  ② 사용설명서 카드 맨 아래 알림 한 줄(`… 보내요 · 끄기` ↔ `모으지 않아요 · 다시 켜기`)과
//  ③ 설정 › 앱의 `익명 사용 횟수 보내기` 스위치와 `내 일 기록은 주간요약 탭에서 볼 수 있어요 · 보기` 한 줄,
//  ④ 주간요약 탭 주차 목록의 줄 끝 칸(그 주 끝낸 일 막대·숫자)과 목록 맨 아래 한 덩어리(report-ui.js의 reportWeekRowEnd·reportWeeksFoot이 넘긴다),
//  ⑤ `내 일 기록` 자세히 창(설정과 같은 .d-modal — 이번 주·이번 달·90일 일 통계 + 맨 아래 `기능별 전체 보기` 표)을 그린다.
// 알림 줄은 이 설치가 실제로 보낼 수 있을 때(`canSend` — 만든 사람·개발용·폼 닫힘이 아님)만 보인다.
// 새 innerHTML은 쓰지 않는다(요소를 만들어 붙인다). 알리기가 실패해도 조용히 넘어간다.

let usageInfo = null;          // GET /api/usage 결과 { send, canSend, days, rows, today, history }
let usageLoading = null;
const usageGuideNodes = new Set();   // 사용설명서 알림 줄(오늘 탭 카드·도움말) — 켜고 끌 때 함께 다시 그린다
let usageTabSeen = false;

function usageTick(key) {
  try {
    fetch('/api/usage/tick', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) }).catch(() => {});
  } catch { /* 조용히 */ }
}

// app.js의 setActiveTab이 부른다 — 다른 탭으로 옮겼을 때, 그리고 앱을 연 뒤 첫 탭 한 번.
function usageTabOpened(tab, previous) {
  if (usageTabSeen && tab === previous) return;
  usageTabSeen = true;
  usageTick(`tab_${tab}`);
}

async function usageLoad() {
  if (usageLoading) return usageLoading;
  usageLoading = (async () => {
    try {
      const response = await fetch('/api/usage');
      const data = response.ok ? await response.json() : null;
      if (data && data.ok) usageInfo = data;
    } catch { /* 읽지 못하면 알림 줄을 숨긴 채로 둔다 */ }
    usageLoading = null;
    usageGuidePaintAll();
    return usageInfo;
  })();
  return usageLoading;
}

async function usageSetSend(on) {
  const response = await fetch('/api/usage/setting', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ send: on }),
  });
  let data = null;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok || !data || !data.ok) throw new Error((data && data.error) || '바꾸지 못했어요.');
  if (usageInfo) usageInfo.send = !!data.send;
  usageGuidePaintAll();
  return !!data.send;
}

// ---------- 사용설명서 알림 한 줄 ----------
function usageGuideLine() {
  const line = document.createElement('p');
  line.className = 'd-usagenote';
  line.hidden = true;
  usageGuideNodes.add(line);
  usageGuidePaint(line);
  if (!usageInfo) usageLoad();
  return [line];
}

function usageGuidePaint(line) {
  if (!line.isConnected && line.dataset.painted) { usageGuideNodes.delete(line); return; }
  line.dataset.painted = '1';
  const info = usageInfo;
  line.hidden = !(info && info.canSend);
  if (line.hidden) { line.replaceChildren(); return; }
  const on = !!info.send;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'd-ablink';
  button.textContent = on ? '끄기' : '다시 켜기';
  button.setAttribute('aria-label', on ? '익명 사용 횟수 보내기 끄기' : '익명 사용 횟수 보내기 다시 켜기');
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await usageSetSend(!on);
      // 다시 그린 줄의 같은 버튼으로 초점을 옮긴다(키보드로 누른 사람이 자리를 잃지 않게).
      const next = line.querySelector('button');
      if (next) next.focus();
      if (typeof showNotice === 'function') showNotice(on ? '익명 사용 횟수를 보내지 않아요' : '익명 사용 횟수를 다시 보내요');
    } catch (error) {
      button.disabled = false;
      if (typeof showNotice === 'function') showNotice(error.message, true);
    }
  });
  line.replaceChildren(document.createTextNode(on ? '어떤 기능을 많이 쓰는지 익명으로 모아 앱을 고치는 데 써요 · ' : '모으지 않아요 · '), button);
}

function usageGuidePaintAll() {
  for (const line of [...usageGuideNodes]) usageGuidePaint(line);
  usageSettingsPaint();
}

// ---------- 내 일 기록 — 계산(순수 함수, client.test.js가 직접 시험한다) ----------
// 전부 서버가 준 `history`({ 'YYYY-MM-DD': { 키: 횟수 } })와 `today`로만 계산한다 — 브라우저 시계로 날짜를 만들지 않는다.
// 주는 월요일 시작. 새로 세는 것은 없다.
const USAGE_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
// 서버(usage.js)의 USAGE_KEYS와 같은 17개 — 이 밖의 키는 무시한다(usage.test.js가 두 목록이 같은지 본다).
const USAGE_KNOWN_KEYS = ['tab_today', 'tab_projects', 'tab_meetings', 'tab_records', 'tab_weekly', 'task_add', 'task_done', 'task_remove',
  'slack_in', 'slack_done', 'slack_remove', 'check_add', 'idea_add', 'decision_add', 'search', 'weekly_copy', 'jira_create'];
const USAGE_IN_KEYS = ['slack_in', 'task_add'];
// 끝낸 일은 할 일 끝냄만 — 슬랙 출처 할 일은 서버가 task_done·slack_done을 둘 다 올리므로 할 일로 한 번만 센다.
const USAGE_DONE_KEYS = ['task_done'];
const USAGE_RECORD_PARTS = [['decision_add', '결정'], ['idea_add', '아이디어'], ['jira_create', '지라'], ['check_add', '확인 대기']];
const USAGE_DOW = ['월', '화', '수', '목', '금', '토', '일'];
const USAGE_RANGES = [['week', '이번 주'], ['month', '이번 달'], ['90', '90일']];
const USAGE_VIEW_DAYS = 90;

const usageAddDays = (day, n) => { const at = new Date(`${day}T00:00:00Z`); at.setUTCDate(at.getUTCDate() + n); return at.toISOString().slice(0, 10); };
const usageSpan = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
const usageDowOf = day => (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;   // 0=월 … 6=일
const usageMonday = day => usageAddDays(day, -usageDowOf(day));
const usageMonthStart = day => `${day.slice(0, 8)}01`;
const usageMonthDay = day => `${Number(day.slice(5, 7))}월 ${Number(day.slice(8, 10))}일`;
const usageShort = day => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
// 소수 한 자리, `.0`은 뗀다.
const usageOneDecimal = n => { const text = (Math.round(n * 10) / 10).toFixed(1); return text.endsWith('.0') ? text.slice(0, -2) : text; };
const usageSumKeys = (counts, keys) => keys.reduce((total, key) => total + (counts[key] || 0), 0);

// 믿을 수 있는 날만 — 오늘부터 90일 안(미래·그보다 옛날 제외), 알려진 키의 양의 정수만.
function usageCleanHistory(history, today) {
  const clean = {};
  if (!history || typeof history !== 'object' || !USAGE_DAY_RE.test(String(today || ''))) return clean;
  const oldest = usageAddDays(today, -(USAGE_VIEW_DAYS - 1));
  for (const [day, counts] of Object.entries(history)) {
    if (!USAGE_DAY_RE.test(day) || day > today || day < oldest || !counts || typeof counts !== 'object') continue;
    const kept = {};
    for (const key of USAGE_KNOWN_KEYS) if (Number.isInteger(counts[key]) && counts[key] > 0) kept[key] = counts[key];
    if (Object.keys(kept).length) clean[day] = kept;
  }
  return clean;
}

// from~to(둘 다 포함) 합계 — 들어온·끝낸·남긴 기록, 키별 숫자, 기록이 있는 날 수.
function usageTotals(clean, from, to) {
  const total = { in: 0, done: 0, record: 0, days: 0, keys: {} };
  for (const [day, counts] of Object.entries(clean)) {
    if (day < from || day > to) continue;
    total.days += 1;
    total.in += usageSumKeys(counts, USAGE_IN_KEYS);
    total.done += usageSumKeys(counts, USAGE_DONE_KEYS);
    total.record += usageSumKeys(counts, USAGE_RECORD_PARTS.map(([key]) => key));
    for (const [key, value] of Object.entries(counts)) total.keys[key] = (total.keys[key] || 0) + value;
  }
  return total;
}

// 기간과 같은 길이의 비교 기간 — 이번 주 월~오늘 ↔ 지난주 월~같은 요일, 이번 달 1일~오늘 ↔ 지난달 1일~같은 날(말일 넘으면 말일).
function usagePeriod(today, range) {
  if (range === 'week') {
    const from = usageMonday(today);
    return { from, to: today, label: `${usageMonthDay(from)}(월) – 오늘`, prev: { from: usageAddDays(from, -7), to: usageAddDays(today, -7), name: '지난주' } };
  }
  if (range === 'month') {
    const from = usageMonthStart(today);
    const prevLast = usageAddDays(from, -1);
    const prevFrom = usageMonthStart(prevLast);
    const sameDay = `${prevFrom.slice(0, 8)}${today.slice(8, 10)}`;
    return { from, to: today, label: `${usageMonthDay(from)} – 오늘`, prev: { from: prevFrom, to: sameDay < prevLast ? sameDay : prevLast, name: '지난달' } };
  }
  return { from: usageAddDays(today, -(USAGE_VIEW_DAYS - 1)), to: today, label: `최근 ${USAGE_VIEW_DAYS}일`, prev: null };
}

// 막대 칸 — 이번 주는 월~일 7칸(오늘 뒤는 빈 칸), 이번 달·90일은 월요일로 끊은 주(첫 주는 덜 찰 수 있다).
function usageBuckets(clean, today, range, from) {
  const buckets = [];
  if (range === 'week') {
    for (let i = 0; i < 7; i += 1) {
      const day = usageAddDays(from, i);
      const future = day > today;
      const total = usageTotals(clean, day, day);
      buckets.push({ label: USAGE_DOW[i], name: `${USAGE_DOW[i]}요일`, from: day, to: day, in: future ? 0 : total.in, done: future ? 0 : total.done, future, today: day === today, partial: false });
    }
    return buckets;
  }
  let start = from;
  while (start <= today) {
    const weekEnd = usageAddDays(usageMonday(start), 6);
    const end = weekEnd < today ? weekEnd : today;
    const total = usageTotals(clean, start, end);
    buckets.push({ label: usageShort(start), name: `${usageMonthDay(start)} 주`, from: start, to: end, in: total.in, done: total.done, future: false, today: end === today, partial: start !== usageMonday(start) });
    start = usageAddDays(weekEnd, 1);
  }
  return buckets;
}

// 막대 아래 한 줄 해설 — 가장 몰린 칸 + 그 뒤 따라잡았는지. 안 맞으면 가장 많이 끝낸 칸. 90일의 덜 찬 첫 주는 후보가 아니다.
function usageBarNote(buckets, range) {
  const candidates = buckets.map((bucket, index) => ({ bucket, index }))
    .filter(({ bucket, index }) => !bucket.future && !(range === '90' && index === 0 && bucket.partial));
  if (!candidates.length) return null;
  const unit = range === 'week' ? '날은' : '주는';
  const peakIn = candidates.reduce((best, item) => (item.bucket.in > best.bucket.in ? item : best));
  if (peakIn.bucket.in > 0) {
    const after = buckets.slice(peakIn.index + 1).filter(bucket => !bucket.future);
    const afterIn = after.reduce((sum, bucket) => sum + bucket.in, 0);
    const afterDone = after.reduce((sum, bucket) => sum + bucket.done, 0);
    if (after.length && afterDone > afterIn) {
      const where = range === 'week' && after.length <= 3 ? `${after.map(bucket => bucket.label).join('·')}에` : '그 뒤로';
      return `${peakIn.bucket.name}에 ${peakIn.bucket.in}개가 몰렸고, ${where} 들어온 것보다 더 끝내서 따라잡았어요`;
    }
  }
  const peakDone = candidates.reduce((best, item) => (item.bucket.done > best.bucket.done ? item : best));
  if (peakDone.bucket.done > 0) return `가장 많이 끝낸 ${unit} ${peakDone.bucket.name}(${peakDone.bucket.done}개)예요`;
  if (peakIn.bucket.in > 0) return `가장 많이 들어온 ${unit} ${peakIn.bucket.name}(${peakIn.bucket.in}개)예요`;
  return null;
}

// 요일별 합계(기록이 있는 날만 센다 — 평균은 기록이 있는 날 기준).
function usageWeekdayStats(clean, from, to) {
  const stats = USAGE_DOW.map(() => ({ in: 0, done: 0, n: 0 }));
  for (const [day, counts] of Object.entries(clean)) {
    if (day < from || day > to) continue;
    const slot = stats[usageDowOf(day)];
    slot.n += 1;
    slot.in += usageSumKeys(counts, USAGE_IN_KEYS);
    slot.done += usageSumKeys(counts, USAGE_DONE_KEYS);
  }
  return stats;
}

// `알게 된 것` — 조건이 맞는 것만, 우선순위 a 요일 몰림 → b 최고 기록 → c 바빠도 유지 → d 잘 끝내는 요일, 최대 3개.
// 문구는 [글자, { b: 굵은 글자 }, 글자] 조각으로 돌려준다(그리기가 <b> 요소로 만든다).
// 요일 통계(a·d)의 창은 첫 기록 날 ~ 어제(오늘은 아직 덜 끝나서 뺀다) — 4주(28일) 이상·기록 있는 날 12일 이상일 때만.
function usageInsights(clean, today, range, period, current, before, recordedDays, past) {
  const found = [];
  const days = Object.keys(clean).sort();
  const firstDay = days[0];
  if (!firstDay) return found;
  const windowTo = usageAddDays(today, -1);
  const windowDays = firstDay <= windowTo ? usageSpan(firstDay, windowTo) : 0;
  const windowRecorded = days.filter(day => day <= windowTo).length;
  const stats = recordedDays >= 7 && windowDays >= 28 && windowRecorded >= 12 ? usageWeekdayStats(clean, firstDay, windowTo) : null;
  const avg = (slot, key) => slot[key] / slot.n;

  // a. 요일 몰림 — 평일 중 평균 들어온 일이 가장 많은 요일이 나머지 평일 평균의 1.5배 이상.
  if (stats) {
    const weekdays = [0, 1, 2, 3, 4].filter(i => stats[i].n >= 2);
    if (weekdays.length >= 2) {
      const top = weekdays.reduce((best, i) => (avg(stats[i], 'in') > avg(stats[best], 'in') ? i : best));
      const others = weekdays.filter(i => i !== top);
      const otherAvg = others.reduce((sum, i) => sum + stats[i].in, 0) / others.reduce((sum, i) => sum + stats[i].n, 0);
      const topAvg = avg(stats[top], 'in');
      if (otherAvg > 0 && topAvg >= otherAvg * 1.5) {
        found.push({ kind: 'crowd', parts: ['일은 ', { b: `${USAGE_DOW[top]}요일에 몰려요` }, ` — 최근 ${Math.floor(windowDays / 7)}주 ${USAGE_DOW[top]}요일 평균 ${usageOneDecimal(topAvg)}개, 다른 날의 ${usageOneDecimal(topAvg / otherAvg)}배예요.`] });
      }
    }
  }

  // b. 최고 기록 — 90일 안(첫 기록 날 이후)의 온전한 같은 단위 중 최고(동점은 아님), 비교 대상 2개 이상.
  //    첫 기록 날이 걸친 덜 찬 주·달은 비교 대상이 아니다. 90일 보기는 하루 최고 기록.
  const floor = [usageAddDays(today, -(USAGE_VIEW_DAYS - 1)), firstDay].sort()[1];
  if (range === 'week' || range === 'month') {
    const others = [];
    if (range === 'week') {
      for (let start = usageAddDays(period.from, -7); start >= floor; start = usageAddDays(start, -7)) others.push(usageTotals(clean, start, usageAddDays(start, 6)).done);
      // 지난 주를 기준으로 열었으면 그 뒤의 온전한 주(이번 주 앞까지)도 비교 대상이다.
      if (past) for (let start = usageAddDays(period.from, 7); start < usageMonday(today); start = usageAddDays(start, 7)) others.push(usageTotals(clean, start, usageAddDays(start, 6)).done);
    } else {
      for (let start = usageMonthStart(usageAddDays(period.from, -1)); start >= floor; start = usageMonthStart(usageAddDays(start, -1))) {
        others.push(usageTotals(clean, start, usageAddDays(usageMonthStart(usageAddDays(start, 31)), -1)).done);
      }
    }
    if (others.length >= 2 && current.done > 0 && current.done > Math.max(...others)) {
      found.push(range === 'week'
        ? { kind: 'best', parts: [`${past ? past.name : '이번 주'}가 `, { b: `최근 ${others.length + 1}주 중 가장 많이 끝낸 주` }, '예요.'] }
        : { kind: 'best', parts: ['이번 달이 ', { b: `최근 ${others.length + 1}달 중 가장 많이 끝낸 달` }, '이에요.'] });
    }
  } else {
    const done = days.map(day => [day, usageSumKeys(clean[day], USAGE_DONE_KEYS)]);
    if (done.length >= 2) {
      const [bestDay, best] = done.reduce((top, item) => (item[1] > top[1] ? item : top));
      if (best > 0) found.push({ kind: 'best', parts: ['하루 최고 기록은 ', { b: `${usageMonthDay(bestDay)}의 ${best}개` }, '예요.'] });
    }
  }

  // c. 바빠도 유지 — 비교 기간보다 들어온 일이 20% 이상 늘었는데 끝낸 비율(끝낸÷들어온)이 5%p 넘게 떨어지지 않음(양쪽 들어온 일 5개 이상).
  if (before && current.in >= 5 && before.in >= 5 && (current.in - before.in) / before.in >= 0.2) {
    const ratio = current.done / current.in;
    if (ratio >= before.done / before.in - 0.05) {
      found.push({ kind: 'steady', parts: [`들어온 일이 ${Math.round((current.in - before.in) / before.in * 100)}% 늘었는데 `, { b: `끝낸 비율은 ${Math.min(100, Math.round(ratio * 100))}%로 유지` }, '했어요. 바빠도 밀리지 않았어요.'] });
    }
  }

  // d. 잘 끝내는 요일 — 요일별 평균 끝낸 일이 가장 많은 요일.
  if (stats) {
    const seen = [0, 1, 2, 3, 4, 5, 6].filter(i => stats[i].n >= 2);
    if (seen.length >= 2) {
      const top = seen.reduce((best, i) => (avg(stats[i], 'done') > avg(stats[best], 'done') ? i : best));
      if (avg(stats[top], 'done') > 0) found.push({ kind: 'finish', parts: ['', { b: `${USAGE_DOW[top]}요일에 가장 많이 끝내요` }, ` — 평균 ${usageOneDecimal(avg(stats[top], 'done'))}개.`] });
    }
  }
  return found.slice(0, 3);
}

// 지난 주를 기준으로 열기(⑂ 4) — options.week가 이번 주보다 앞선 월요일이면 { week, name }, 아니면 null.
// 이름은 부르는 쪽(app.js의 reportWeekName — 목요일 기준 주차)이 options.name으로 주고, 없으면 `지난 주`/`9월 21일 주`.
function usagePastWeek(today, options) {
  const week = options && typeof options === 'object' ? String(options.week || '') : '';
  if (!USAGE_DAY_RE.test(week) || !USAGE_DAY_RE.test(String(today || '')) || usageDowOf(week) !== 0 || week >= usageMonday(today)) return null;
  const given = typeof options.name === 'string' ? options.name.trim() : '';
  return { week, name: given || (week === usageAddDays(usageMonday(today), -7) ? '지난 주' : `${usageMonthDay(week)} 주`) };
}

// 화면에 필요한 숫자·문장 재료를 한 번에. range: 'week' | 'month' | '90'(그 밖은 'week').
// options(선택): { week: 'YYYY-MM-DD'(기준 주 월요일), name: '지난 주' } — range가 'week'이고 week가 이번 주보다 앞이면
//   그 주 월~일 전체를 보고(비교는 그 앞 주 전체, 막대 7칸 모두 과거, 큰 한 줄은 `지난 주에 일 N개를 끝냈어요`),
//   결과에 week·weekName이 더 붙는다. 'month'·'90'은 늘 오늘 기준. 없으면 예전과 같다.
// → { range, today, from, to, periodLabel, empty,
//     headline: 조각[], in: { total, slack, direct }, done: { total, slack(그중 슬랙) }, record: { total, parts: [{ label, count }] },
//     recordedDays, average: '1.5'|null, compare: null|{ from, to, in, done, change, tone: 'more'|'same'|'less', text },
//     bars: [{ label, name, from, to, in, done, future, today, partial }], barNote: 글자|null, insights: [{ kind, parts }] }
// 빈 상태(90일 안에 기록이 하나도 없음)면 range·today·from·to·periodLabel·empty만.
function usageWorkStats(history, today, range, options) {
  const view = USAGE_RANGES.some(([key]) => key === range) ? range : 'week';
  if (!USAGE_DAY_RE.test(String(today || ''))) return { range: view, empty: true, periodLabel: '' };
  const clean = usageCleanHistory(history, today);
  const recordedDays = Object.keys(clean).length;
  const past = view === 'week' ? usagePastWeek(today, options) : null;
  const period = past
    ? { from: past.week, to: usageAddDays(past.week, 6), label: `${usageMonthDay(past.week)}(월) – ${usageMonthDay(usageAddDays(past.week, 6))}(일)`,
      prev: { from: usageAddDays(past.week, -7), to: usageAddDays(past.week, -1), name: '그 전 주' } }
    : usagePeriod(today, view);
  const result = { range: view, today, from: period.from, to: period.to, periodLabel: period.label, empty: recordedDays === 0 };
  if (past) { result.week = past.week; result.weekName = past.name; }
  if (result.empty) return result;
  const current = usageTotals(clean, period.from, period.to);
  const n = key => current.keys[key] || 0;
  const title = view === 'week' ? '이번 주' : view === 'month' ? '이번 달' : `최근 ${USAGE_VIEW_DAYS}일`;
  if (past) {
    result.headline = current.done > 0 ? [`${past.name}에 일 `, { b: `${current.done}개` }, '를 끝냈어요'] : [`${past.name}엔 끝낸 일이 없어요`];
  } else {
    result.headline = current.done > 0
      ? [`${view === '90' ? `${title} 동안` : title} 일 `, { b: `${current.done}개` }, '를 끝냈어요']
      : [`${title}${view === '90' ? '은' : '는'} 아직 끝낸 일이 없어요`];
  }
  result.in = { total: current.in, slack: n('slack_in'), direct: n('task_add') };
  result.done = { total: current.done, slack: Math.min(n('slack_done'), n('task_done')) };   // slack = 그중 슬랙에서 온 것
  result.record = { total: current.record, parts: USAGE_RECORD_PARTS.filter(([key]) => n(key) > 0).map(([key, label]) => ({ label, count: n(key) })) };
  result.recordedDays = current.days;
  result.average = current.days > 0 && current.done > 0 ? usageOneDecimal(current.done / current.days) : null;
  // 같은 길이 비교 — 기록 7일 미만·비교 기간 들어온 일 0·비교 기간 중간부터 기록이면 생략. ±10% 안이면 비슷. 90일은 비교 없음.
  let before = null;
  result.compare = null;
  // 첫 기록 날이 비교 기간 시작보다 뒤면(비교 기간 기록이 덜 참) 비교와 인사이트 c도 생략한다.
  const firstDay = Object.keys(clean).sort()[0];
  if (period.prev && recordedDays >= 7 && firstDay <= period.prev.from) {
    const prev = usageTotals(clean, period.prev.from, period.prev.to);
    if (prev.in > 0) {
      before = prev;
      const change = Math.round((current.in - prev.in) / prev.in * 100);
      const tone = Math.abs(change) <= 10 ? 'same' : change > 0 ? 'more' : 'less';
      const name = period.prev.name;
      const text = tone === 'same' ? `${name}${view === 'week' ? '와' : '과'} 비슷했어요` : tone === 'more' ? `${name}보다 ${change}% 더 바빴어요` : `${name}보다 조금 여유로웠어요`;
      result.compare = { from: period.prev.from, to: period.prev.to, in: prev.in, done: prev.done, change, tone, text };
    }
  }
  result.bars = usageBuckets(clean, today, view, period.from);
  result.barNote = usageBarNote(result.bars, view);
  result.insights = usageInsights(clean, today, view, period, current, before, recordedDays, past);
  return result;
}

// ---------- 주간요약 주차 목록 — 계산(순수 함수, client.test.js가 직접 시험한다) ----------
// history를 한 번만 훑어 주(월요일)별로 끝낸 일·기록 있는 날 수를 모아 둔다(같은 history·today면 다시 훑지 않는다).
let usageWeekMemo = null;
function usageWeekIndex(history, today) {
  if (usageWeekMemo && usageWeekMemo.history === history && usageWeekMemo.today === today) return usageWeekMemo;
  const clean = usageCleanHistory(history, today);
  const days = Object.keys(clean).sort();
  const weeks = new Map();
  for (const day of days) {
    const monday = usageMonday(day);
    const week = weeks.get(monday) || { done: 0, days: 0 };
    week.done += usageSumKeys(clean[day], USAGE_DONE_KEYS);
    week.days += 1;
    weeks.set(monday, week);
  }
  usageWeekMemo = { history, today, first: days[0] || null, weeks };
  return usageWeekMemo;
}

// 그 주(월요일)의 끝낸 일 — 기록이 닿지 않는 주(90일·첫 기록 날보다 앞, 오늘보다 뒤)는 null(0으로 보이지 않게).
// 첫 기록 날이 그 주 중간이면 그대로 센다(full: false — 최고 기록 비교에서만 뺀다).
function usageWeekRecord(index, weekKey) {
  if (!index || !index.first || !USAGE_DAY_RE.test(String(weekKey || '')) || !USAGE_DAY_RE.test(String(index.today || ''))) return null;
  const monday = usageMonday(weekKey);
  if (usageAddDays(monday, 6) < index.first || monday > index.today) return null;
  const week = index.weeks.get(monday);
  return { done: week ? week.done : 0, days: week ? week.days : 0, full: monday >= index.first };
}

// 주차 목록 요약 — weekKeys: 목록에 보이는 주(월요일)들, selected: 고른 주, nameOf(weekKey): `이번 주`/`지난 주`/`10월 1주차`,
// labelOf(weekKey): `9월 3주차`(최고 기록 줄). → 90일 안에 기록이 없으면 { empty: true }, 아니면
// { empty: false, weeks: { weekKey: { done, days, full } | null }, max, selected: 기록|null, line: 조각[], best: 조각[]|null }.
function usageWeeksSummary(history, today, weekKeys, selected, nameOf, labelOf) {
  const index = usageWeekIndex(history, today);
  if (!index.first) return { empty: true };
  const name = typeof nameOf === 'function' ? nameOf : (key => `${usageMonthDay(key)} 주`);
  const label = typeof labelOf === 'function' ? labelOf : name;
  const keys = Array.isArray(weekKeys) ? weekKeys : [];
  const weeks = {};
  for (const key of keys) weeks[key] = usageWeekRecord(index, key);
  const max = Math.max(0, ...keys.map(key => (weeks[key] ? weeks[key].done : 0)));
  const pick = Object.prototype.hasOwnProperty.call(weeks, selected) ? weeks[selected] : usageWeekRecord(index, selected);
  let line;
  if (!pick) line = ['이 주는 기록이 없어요'];
  else {
    const word = name(selected);
    const now = word === '이번 주';
    if (pick.done > 0) {
      line = [now ? '이번 주 일 ' : `${word}에 일 `, { b: `${pick.done}개` }, '를 끝냈어요'];
      if (pick.days > 0) line.push(` · ${usageKeepTogether([['하루 평균', `${usageOneDecimal(pick.done / pick.days)}개`]])}`);   // `하루 평균 3.7개`는 한 덩어리로 줄바꿈
    } else line = [now ? '이번 주는 아직 끝낸 일이 없어요' : `${word}엔 끝낸 일이 없어요`];
  }
  // 최고 기록 — 목록 안 기록 있는 온전한 주가 3개 이상이고 최고가 하나일 때만.
  let best = null;
  const full = keys.filter(key => weeks[key] && weeks[key].full);
  if (full.length >= 3) {
    const top = Math.max(...full.map(key => weeks[key].done));
    const tops = full.filter(key => weeks[key].done === top);
    if (top > 0 && tops.length === 1) best = name(tops[0]) === '이번 주' ? ['이번 주가 최고 기록이에요'] : ['최고 기록: ', `${label(tops[0])} `, { b: `${top}개` }];
  }
  return { empty: false, weeks, max, selected: pick, line, best };
}

// ---------- 주간요약 주차 목록 — 그리기(report-ui.js의 reportWeekRowEnd·reportWeeksFoot이 넘긴다) ----------
let usageWeekAsked = false;
let usageWeeksMemo = null;

// 아직 사용 기록을 못 불렀으면 한 번만 부르고, 오면 주간요약 탭이 보이는 중일 때만 목록을 다시 그린다.
function usageWeekEnsure() {
  if (usageInfo || usageWeekAsked) return;
  usageWeekAsked = true;
  usageLoad().then(() => { if (usageInfo) usageWeekRefresh(); });
}

function usageWeekRefresh() {
  if (typeof renderWeeklyReports !== 'function' || typeof weeklyReportsCache === 'undefined') return;
  if (typeof activeTabKey === 'undefined' || activeTabKey !== 'weekly') {
    // 다른 탭에 있으면 다음에 주간요약을 열 때 다시 그리게 표시만 해 둔다.
    if (typeof tabStale === 'object' && tabStale) tabStale.weekly = true;
    return;
  }
  // 주차 목록 안의 버튼에 초점이 있었으면 다시 그린 뒤 같은 차례의 버튼으로 돌려놓는다.
  const nav = document.getElementById('weeklyReportNav');
  const kids = nav && nav.children ? [...nav.children] : [];
  const at = kids.findIndex(kid => kid === document.activeElement || (kid && typeof kid.contains === 'function' && kid.contains(document.activeElement)));
  renderWeeklyReports(weeklyReportsCache);
  if (at >= 0 && nav.children[at] && typeof nav.children[at].focus === 'function') nav.children[at].focus();
}

// 지금 목록(weeklyReportsCache)·고른 주(selectedWeekKey)·기록(usageInfo) 기준 요약 — 한 번 그릴 때 줄마다 다시 계산하지 않는다.
function usageWeeksNow(items) {
  if (!usageInfo) { usageWeekEnsure(); return null; }
  const list = Array.isArray(items) ? items : (typeof weeklyReportsCache !== 'undefined' && Array.isArray(weeklyReportsCache) ? weeklyReportsCache : []);
  const selected = typeof selectedWeekKey !== 'undefined' ? selectedWeekKey : null;
  const keys = list.map(item => item && item.weekKey).filter(Boolean);
  const sign = `${keys.join(',')}|${selected}`;
  if (usageWeeksMemo && usageWeeksMemo.info === usageInfo && usageWeeksMemo.sign === sign) return usageWeeksMemo.summary;
  const nameOf = typeof reportWeekName === 'function' ? reportWeekName : null;
  const labelOf = typeof formatWeekLabel === 'function' ? (key => formatWeekLabel(key).week) : null;
  const summary = usageWeeksSummary(usageInfo.history, usageInfo.today, keys, selected, nameOf, labelOf);
  usageWeeksMemo = { info: usageInfo, sign, summary };
  return summary;
}

// 주차 한 줄의 오른쪽 끝 — 48px 막대(aria-hidden) + 숫자. 채움 = 그 주 끝낸 일 ÷ 목록 안 최대. 기록이 없는 주는 null.
// 버튼의 aria-label 끝에 붙일 말은 dataset.label(`끝낸 일 N개`) — app.js가 덧붙인다.
function usageWeekRowEnd(item) {
  const summary = usageWeeksNow();
  if (!summary || summary.empty || !item) return null;
  const record = summary.weeks[item.weekKey];
  if (!record) return null;
  const end = usageEl('span', 'd-uwend');
  const track = usageEl('span', 'd-uwtrack');
  track.setAttribute('aria-hidden', 'true');
  const fill = usageEl('span', 'd-uwfill');
  fill.style.width = summary.max > 0 && record.done > 0 ? `${Math.max(4, Math.round(record.done / summary.max * 100))}%` : '0';
  track.appendChild(fill);
  end.append(track, usageEl('span', 'd-uwnum', String(record.done)));
  end.dataset.label = `끝낸 일 ${record.done}개`;
  return end;
}

// 주차 목록 맨 아래 — 고른 주 한 문장 + (조건이 맞으면) 최고 기록 줄 + `내 일 기록 자세히`. 90일 안에 기록이 없으면 null.
function usageWeeksFoot(items) {
  const summary = usageWeeksNow(items);
  if (!summary || summary.empty) return null;
  const foot = usageEl('div', 'd-uwfoot');
  foot.appendChild(usageParts(usageEl('p', 'd-uwfline'), summary.line));
  if (summary.best) foot.appendChild(usageParts(usageEl('p', 'd-uwfline'), summary.best));
  const link = usageEl('button', 'd-link d-uwmore', '내 일 기록 자세히');
  link.type = 'button';
  link.setAttribute('aria-haspopup', 'dialog');
  const selected = typeof selectedWeekKey !== 'undefined' ? selectedWeekKey : null;
  link.addEventListener('click', () => usageWorkOpen(link, summary.selected ? selected : null));
  foot.appendChild(link);
  return foot;
}

// ---------- 내 일 기록 자세히 창 — 설정과 같은 .d-modal 판(새 틀 없음) ----------
// 열면 초점은 창 자체(테 없음), Esc·바깥 누름·✕로 닫히고, 닫으면 누른 링크로 초점이 돌아간다.
let usageWorkDlg = null;   // { dialog, body, opener, week, name, esc }

function usageCloseIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'd-i');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  shape.setAttribute('d', 'M4 4l8 8M12 4l-8 8');
  svg.appendChild(shape);
  return svg;
}

function usageWorkDialog() {
  if (usageWorkDlg) return usageWorkDlg;
  const dialog = usageEl('dialog', 'd-modal d-uwdlg');
  dialog.setAttribute('aria-labelledby', 'usageWorkTitle');
  dialog.tabIndex = -1;
  const head = usageEl('div', 'd-mhd');
  const title = usageEl('h2', '', '내 일 기록');
  title.id = 'usageWorkTitle';
  const close = usageEl('button', 'd-iconbtn');
  close.type = 'button';
  close.setAttribute('aria-label', '닫기');
  close.appendChild(usageCloseIcon());
  head.append(title, usageEl('span', 'sp'), close);
  const body = usageEl('div', 'd-mbody');
  dialog.append(head, body);
  const dlg = { dialog, body, opener: null, week: null, name: null, esc: null };
  close.addEventListener('click', () => usageWorkClose());
  // 브라우저가 스스로 닫으려 할 때(Esc)도 같은 길로 — 초점 복귀가 어긋나지 않게.
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); usageWorkClose(); });
  // 바깥(배경) 누름 — 창 판 밖을 누르면 대상이 dialog 자신이고 좌표가 판 밖이다.
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const box = typeof dialog.getBoundingClientRect === 'function' ? dialog.getBoundingClientRect() : null;
    if (box && event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom) return;
    usageWorkClose();
  });
  if (document.body) document.body.appendChild(dialog);
  usageWorkDlg = dlg;
  return dlg;
}

function usageWorkPaint() {
  const dlg = usageWorkDlg;
  if (!dlg) return;
  if (!usageInfo) {
    dlg.body.replaceChildren(usageEl('div', usageLoading ? 'd-empty' : 'd-ismall', usageLoading ? '불러오는 중이에요…' : '사용 기록을 읽지 못했어요.'));
    return;
  }
  dlg.body.replaceChildren(usageWorkBody(usageInfo, dlg.body, { week: dlg.week, name: dlg.name }));
}

// opener: 닫으면 초점이 돌아갈 버튼. week: 주차 목록에서 고른 주(월요일) — 이번 주보다 앞이면 그 주 기준으로 연다.
function usageWorkOpen(opener, week) {
  const dlg = usageWorkDialog();
  dlg.opener = opener || null;
  dlg.week = week || null;
  dlg.name = week && typeof reportWeekName === 'function' ? reportWeekName(week) : null;
  if (!usageInfo) usageLoad().then(() => { if (usageWorkDlg && usageWorkDlg.dialog.open) usageWorkPaint(); });
  usageWorkPaint();
  if (!dlg.dialog.open) {
    if (typeof uiMenuClose === 'function') uiMenuClose();
    if (typeof dlg.dialog.showModal === 'function') dlg.dialog.showModal();
    else dlg.dialog.open = true;
    if (typeof escPush === 'function') dlg.esc = escPush(usageWorkClose);
  }
  dlg.body.scrollTop = 0;
  if (typeof dlg.dialog.focus === 'function') dlg.dialog.focus({ preventScroll: true });
}

function usageWorkClose() {
  const dlg = usageWorkDlg;
  if (!dlg) return;
  if (dlg.esc && typeof escDrop === 'function') escDrop(dlg.esc);
  dlg.esc = null;
  if (!dlg.dialog.open) return;
  if (typeof dlg.dialog.close === 'function') dlg.dialog.close();
  else dlg.dialog.open = false;
  let back = dlg.opener;
  dlg.opener = null;
  // 열려 있는 동안 주차 목록이 다시 그려졌으면(새 데이터) 같은 자리의 새 링크로, 그것도 없으면 주간요약 탭 버튼으로.
  if (!back || back.isConnected === false) {
    back = (typeof document.querySelector === 'function' && document.querySelector('#weeklyReportNav .d-uwmore')) || document.getElementById('tabBtnWeekly');
  }
  if (back && typeof back.focus === 'function') back.focus();
}

// 설정 › 앱의 `보기` — 설정을 닫고 주간요약 탭으로 옮긴 뒤 자세히 창을 연다(닫으면 초점은 목록 맨 아래 링크로).
function usageWorkFromSettings() {
  if (typeof settingsClose === 'function') settingsClose();
  if (typeof setActiveTab === 'function') setActiveTab('weekly');
  const selected = typeof selectedWeekKey !== 'undefined' ? selectedWeekKey : null;
  const summary = usageWeeksNow();
  const link = typeof document.querySelector === 'function' ? document.querySelector('#weeklyReportNav .d-uwmore') : null;
  usageWorkOpen(link || document.getElementById('tabBtnWeekly'), summary && summary.selected ? selected : null);
}

// ---------- 설정 › 앱: 스위치와 `주간요약 탭에서 볼 수 있어요` 한 줄 ----------
let usageSettingsNode = null;

function usageSettingsRow() {
  const cell = document.createElement('div');
  cell.className = 'd-usageset';
  const row = typeof personalizeRow === 'function'
    ? personalizeRow('사용 통계', '앱 개선용', cell)
    : cell;
  row.dataset.row = 'usage';
  usageSettingsNode = cell;
  cell.appendChild(Object.assign(document.createElement('div'), { className: 'd-empty', textContent: '불러오는 중이에요…' }));
  usageLoad().then(() => usageSettingsPaint());
  return row;
}

function usageChevron() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'd-i');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  shape.setAttribute('d', 'M6 3.5 10.5 8 6 12.5');
  svg.appendChild(shape);
  return svg;
}

function usageSettingsPaint() {
  const cell = usageSettingsNode;
  if (!cell || !cell.isConnected) return;
  const info = usageInfo;
  if (!info) {
    cell.replaceChildren(Object.assign(document.createElement('div'), { className: 'd-ismall', textContent: '사용 기록을 읽지 못했어요.' }));
    return;
  }
  // 스위치 — 기존 연동 탭의 체크 줄(.d-ich)을 그대로 쓰고 role=switch로 켬/끔을 읽어 준다.
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.setAttribute('role', 'switch');
  box.checked = !!info.send;
  box.setAttribute('aria-label', '익명 사용 횟수 보내기');
  const text = document.createElement('span');
  text.className = 't';
  const strong = document.createElement('b');
  strong.textContent = '익명 사용 횟수 보내기';
  const sub = document.createElement('span');
  sub.className = 'd-ismall sub';
  sub.textContent = info.canSend
    ? '어떤 기능이 쓸모 있는지 보고 앱을 고치는 데 써요 — 기능별 횟수만, 이름·업무 내용은 보내지 않아요 · 꺼도 내 일 기록은 이 맥에 계속 쌓여요'
    : '어떤 기능이 쓸모 있는지 보고 앱을 고치는 데 써요 — 기능별 횟수만, 이름·업무 내용은 보내지 않아요 · 이 설치에서는 지금 보내지 않아요';
  text.append(strong, sub);
  const label = document.createElement('label');
  label.className = 'd-ich d-usageswitch' + (box.checked ? ' is-on' : '');
  label.append(box, text);
  box.addEventListener('change', async () => {
    const want = box.checked;
    box.disabled = true;
    try {
      await usageSetSend(want);
    } catch (error) {
      box.checked = !want;
      if (typeof showNotice === 'function') showNotice(error.message, true);
    }
    box.disabled = false;
    label.classList.toggle('is-on', box.checked);
  });

  // 내 일 기록은 주간요약 탭에 있다 — 여기에는 가는 길 한 줄만.
  const go = usageEl('button', 'd-ablink', '보기');
  go.type = 'button';
  go.setAttribute('aria-label', '내 일 기록 보기 — 주간요약 탭으로 가요');
  go.addEventListener('click', () => usageWorkFromSettings());
  const where = usageEl('p', 'd-ismall d-uwgo');
  where.append(document.createTextNode('내 일 기록은 주간요약 탭에서 볼 수 있어요 · '), go);
  cell.replaceChildren(label, where);
}

// ---------- 내 일 기록 — 그리기(계산은 usageWorkStats가 한다) ----------
const USAGE_RANGE_STORE = 'usageWorkRange';
let usageWorkRange = null;

function usageRangeNow() {
  if (!usageWorkRange) {
    let saved = null;
    try { saved = localStorage.getItem(USAGE_RANGE_STORE); } catch { saved = null; }
    usageWorkRange = USAGE_RANGES.some(([key]) => key === saved) ? saved : 'week';
  }
  return usageWorkRange;
}

// [글자, { b: 굵은 글자 }] 조각 → 글자 노드와 <b> 요소.
function usageParts(node, parts) {
  for (const part of parts) {
    if (part && typeof part === 'object') {
      const bold = document.createElement('b');
      bold.textContent = part.b;
      node.appendChild(bold);
    } else if (part) node.appendChild(document.createTextNode(part));
  }
  return node;
}

// 인라인 선 아이콘(장식 — 읽지 않는다).
const USAGE_INSIGHT_ICONS = {
  crowd: 'M3 13V9M6.5 13V3M10 13V7M13.5 13V10',
  best: 'M8 2.5 9.7 6l3.8.5-2.8 2.6.7 3.8L8 11.1l-3.4 1.8.7-3.8L2.5 6.5 6.3 6 8 2.5Z',
  steady: 'M2.5 11 6 7.5l2.5 2.5 5-5M10 5h3.5v3.5',
  finish: 'M3 8.5 6.5 12 13 4.5',
};
function usageInsightIcon(kind) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'd-i');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  shape.setAttribute('d', USAGE_INSIGHT_ICONS[kind] || USAGE_INSIGHT_ICONS.finish);
  svg.appendChild(shape);
  return svg;
}

function usageEl(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// 타일 작은 글자 — 항목(`확인 대기 8`) 안에서는 줄이 바뀌지 않게 붙는 빈칸으로 잇고, 항목 사이 ` · `에서만 바뀐다.
function usageKeepTogether(pairs) {
  return pairs.map(([label, count]) => `${label} ${count}`.replace(/ /g, '\u00a0')).join(' · ');
}

function usageTile(name, total, sub, strong) {
  const tile = usageEl('div', strong ? 'd-uwtile is-done' : 'd-uwtile');
  tile.append(usageEl('span', 'd-uwk', name), usageEl('b', 'd-uwv', `${total}개`), usageEl('span', 'd-uws', sub || ''));
  return tile;
}

// options: { week, name } — 주차 목록에서 고른 지난 주(usageWorkStats의 options 그대로). 첫 칸 글자가 그 주 이름이 된다.
function usageWorkBody(info, cell, options) {
  const range = usageRangeNow();
  const stats = usageWorkStats(info.history, info.today, range, options);
  const past = usagePastWeek(info.today, options);
  const body = usageEl('div', 'd-uw');

  // 머리 — 기간 전환(기존 세그먼트 부품, 보기 전환이라 aria-pressed) + 기간 글자.
  const head = usageEl('div', 'd-uwhead');
  const seg = usageEl('div', 'd-seg');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', '기간');
  for (const [key, word] of USAGE_RANGES) {
    const button = usageEl('button', '', key === 'week' && past ? past.name : word);
    button.type = 'button';
    button.dataset.range = key;
    button.setAttribute('aria-pressed', String(key === stats.range));
    button.addEventListener('click', () => {
      if (usageWorkRange === key) return;
      usageWorkRange = key;
      try { localStorage.setItem(USAGE_RANGE_STORE, key); } catch { /* 기억 못 해도 괜찮다 */ }
      usageWorkPaint();
      // 다시 그린 같은 버튼으로 초점을 옮긴다(키보드로 누른 사람이 자리를 잃지 않게).
      const host = usageWorkDlg && usageWorkDlg.body;
      const again = host && typeof host.querySelectorAll === 'function'
        ? [...host.querySelectorAll('.d-uwhead button')].find(item => item.dataset.range === key) : null;
      if (again) again.focus();
    });
    seg.appendChild(button);
  }
  head.append(seg, usageEl('p', 'd-uwperiod', stats.periodLabel));
  // 90일 안에 기록이 하나도 없으면 기간을 바꿔도 같은 한 줄이라 세그먼트·기간 글자를 숨긴다(빈 화면엔 할 수 있는 것만).
  if (!stats.empty) body.appendChild(head);

  if (stats.empty) {
    body.appendChild(usageEl('p', 'd-ismall d-uwempty', '아직 기록이 없어요. 할 일을 끝내면 여기에 쌓여요.'));
  } else {
    body.appendChild(usageParts(usageEl('p', 'd-uwbig'), stats.headline));
    const sub = usageEl('p', 'd-uwsub');
    const bits = [];
    if (stats.average) {
      const average = usageEl('span', '', `하루 평균 ${stats.average}개`);
      average.title = '기록이 있는 날 기준';
      average.setAttribute('aria-label', `하루 평균 ${stats.average}개, 기록이 있는 날 기준`);
      bits.push(average);
    }
    bits.push(usageEl('span', '', `들어온 일 ${stats.in.total}개`));
    if (stats.compare) bits.push(usageEl('span', 'd-uwcmp', stats.compare.text));
    bits.forEach((bit, index) => { if (index) sub.appendChild(document.createTextNode(' · ')); sub.appendChild(bit); });
    body.appendChild(sub);

    // 타일 3개 — 끝낸 일만 강조.
    const tiles = usageEl('div', 'd-uwtiles');
    tiles.append(
      usageTile('들어온 일', stats.in.total, usageKeepTogether([['슬랙', stats.in.slack], ['직접', stats.in.direct]])),
      usageTile('끝낸 일', stats.done.total, stats.done.slack > 0 ? usageKeepTogether([['그중 슬랙', stats.done.slack]]) : '', true),
      usageTile('남긴 기록', stats.record.total, usageKeepTogether(stats.record.parts.map(part => [part.label, part.count]))),
    );
    body.appendChild(tiles);

    // 막대 — 들어옴·끝냄 한 쌍씩. 그림은 aria-hidden, 같은 숫자는 숨긴 목록이 읽어 준다.
    const chart = usageEl('div', 'd-uwchart');
    const legend = usageEl('div', 'd-uwlegend');
    legend.setAttribute('aria-hidden', 'true');
    legend.append(usageEl('span', 'd-uwkey in', '들어옴'), usageEl('span', 'd-uwkey done', '끝냄'));
    const bars = usageEl('div', `d-uwbars is-${stats.range === '90' ? 'd90' : stats.range}`);
    bars.setAttribute('aria-hidden', 'true');
    const list = usageEl('ul', 'sr-only');
    const peak = Math.max(1, ...stats.bars.map(bucket => Math.max(bucket.in, bucket.done)));
    const every = stats.bars.length > 7 ? 3 : 1;
    stats.bars.forEach((bucket, index) => {
      const col = usageEl('div', 'd-uwcol' + (bucket.future ? ' is-future' : '') + (bucket.today ? ' is-today' : ''));
      const pair = usageEl('div', 'd-uwpair');
      for (const kind of ['in', 'done']) {
        const bar = usageEl('span', `d-uwbar ${kind}`);
        const value = bucket[kind];
        bar.style.height = bucket.future ? '' : value > 0 ? `max(2px, ${Math.round(value / peak * 100)}%)` : '0';
        pair.appendChild(bar);
      }
      const showLabel = (stats.bars.length - 1 - index) % every === 0;
      col.append(pair, usageEl('span', 'd-uwlab', showLabel ? bucket.label : ''));
      bars.appendChild(col);
      if (!bucket.future) list.appendChild(usageEl('li', '', `${bucket.name}${bucket.today && stats.range === 'week' ? '(오늘)' : ''}: 들어옴 ${bucket.in}개, 끝냄 ${bucket.done}개`));
    });
    chart.append(legend, bars, list);
    if (stats.barNote) chart.appendChild(usageEl('p', 'd-uwnote', stats.barNote));
    body.appendChild(chart);

    // 알게 된 것 — 조건이 맞는 것만, 하나도 없으면 칸째 숨김.
    if (stats.insights.length) {
      const insights = usageEl('div', 'd-uwins');
      insights.appendChild(usageEl('p', 'd-uwinshd', '알게 된 것'));
      const items = usageEl('ul', '');
      for (const insight of stats.insights) {
        const item = usageEl('li', '');
        item.append(usageInsightIcon(insight.kind), usageParts(usageEl('span', ''), insight.parts));
        items.appendChild(item);
      }
      insights.appendChild(items);
      body.appendChild(insights);
    }
  }

  // 기능별 전체 보기 — 최근 30일 합계 표(기본 접힘).
  const rows = Array.isArray(info.rows) ? info.rows : [];
  const all = document.createElement('details');
  all.className = 'd-dsec d-dadd d-usagehist';
  const allSummary = document.createElement('summary');
  allSummary.className = 'lbl';
  allSummary.append(usageChevron(), document.createTextNode(`기능별 전체 보기 (${rows.length}개)`));
  const table = document.createElement('table');
  table.className = 'd-usagetable';
  const caption = document.createElement('caption');
  caption.textContent = `최근 ${info.days || 30}일 합계 · 이 맥에만 있어요`;
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  ['기능', '횟수'].forEach((word) => {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = word;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  const tbody = document.createElement('tbody');
  rows.forEach((item) => {
    const tr = document.createElement('tr');
    const name = document.createElement('th');
    name.scope = 'row';
    name.textContent = item.label;
    const count = document.createElement('td');
    count.textContent = String(item.count);
    tr.append(name, count);
    tbody.appendChild(tr);
  });
  table.append(caption, thead, tbody);
  all.append(allSummary, table);
  if (cell.querySelector('.d-usagehist')?.open) all.open = true;
  body.appendChild(all);
  return body;
}

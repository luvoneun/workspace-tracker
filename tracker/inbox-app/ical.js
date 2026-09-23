// 캘린더 비밀 주소(iCal)를 앱 서버가 직접 읽는 한 벌 — 글자 풀기(파싱)와 "오늘 일정" 뽑기.
// Claude 없이 돈다(설정 > 연동 > 캘린더의 `비밀 주소 붙이기`). 바깥 패키지 없이 흔한 것만 다룬다:
//   - 한 번짜리 일정, 종일 일정(VALUE=DATE — 오늘 목록에는 넣지 않는다, 아래 todayEvents 참고)
//   - 시간대: TZID(IANA 이름, 예 Asia/Seoul) · UTC(끝의 Z) · 떠 있는 시각(X-WR-TIMEZONE, 없으면 이 맥)
//   - 반복(RRULE): DAILY · WEEKLY(BYDAY) · MONTHLY(BYDAY 몇째 요일 / BYMONTHDAY) · YEARLY,
//     INTERVAL · UNTIL · COUNT · EXDATE, 한 번만 바꾼 회차(RECURRENCE-ID)
//   - 취소(STATUS:CANCELLED)는 뺀다
// 결과는 `calendar_today.md`를 읽었을 때와 **같은 모양**({ start, end, title, link, externalId })이다.
// 주소·본문은 어디에도 남기지 않는다(로그·오류 문구에도) — 비밀 주소는 토큰과 같은 급이다.

const DAY_MS = 86400000;
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
// 반복을 펼칠 때 넘지 않는 날 수(약 60년) — 끝이 없는 매일 반복도 여기서 멈춘다.
const MAX_SPAN_DAYS = 22000;

// ---------- 글자 풀기 ----------
// 긴 줄은 다음 줄 맨 앞의 빈칸 하나로 이어진다(RFC 5545 3.1).
function unfold(text) {
  return String(text || '').replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '');
}

// `NAME;PARAM=V;PARAM2="a:b":값` → { name, params, value }
function parseLine(line) {
  let quoted = false;
  let at = -1;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === ':' && !quoted) { at = i; break; }
  }
  if (at < 0) return null;
  const head = line.slice(0, at).split(';');
  const params = {};
  head.slice(1).forEach((pair) => {
    const eq = pair.indexOf('=');
    if (eq < 0) return;
    params[pair.slice(0, eq).toUpperCase()] = pair.slice(eq + 1).replace(/^"|"$/g, '');
  });
  return { name: head[0].toUpperCase(), params, value: line.slice(at + 1) };
}

// 글자 값의 이스케이프(\n \, \; \\)를 푼다. 제목에는 줄바꿈을 두지 않는다(빈칸으로).
function unescapeText(value) {
  return String(value || '').replace(/\\([nN,;\\])/g, (_, c) => (c === 'n' || c === 'N' ? ' ' : c));
}

// 캘린더 글자 전체 → { ok, zone, events:[{ props }] }. VCALENDAR가 아니면 ok:false.
function parseCalendar(text) {
  const lines = unfold(text).split('\n');
  if (!lines.some(line => /^BEGIN:VCALENDAR\s*$/i.test(line))) return { ok: false, zone: null, events: [] };
  const events = [];
  let zone = null;
  let current = null;
  let depth = 0;   // VEVENT 안의 VALARM 같은 하위 묶음은 건너뛴다
  lines.forEach((raw) => {
    const line = raw.replace(/\s+$/, '');
    if (!line) return;
    const prop = parseLine(line);
    if (!prop) return;
    if (prop.name === 'BEGIN') {
      if (String(prop.value).toUpperCase() === 'VEVENT' && !current) { current = {}; depth = 0; return; }
      if (current) depth += 1;
      return;
    }
    if (prop.name === 'END') {
      if (current && depth > 0) { depth -= 1; return; }
      if (current && String(prop.value).toUpperCase() === 'VEVENT') { events.push(current); current = null; }
      return;
    }
    if (current) {
      if (depth > 0) return;
      (current[prop.name] = current[prop.name] || []).push(prop);
      return;
    }
    if (prop.name === 'X-WR-TIMEZONE') zone = prop.value.trim() || null;
  });
  return { ok: true, zone, events };
}

// ---------- 시간대 ----------
const formatters = new Map();
function zoneFormatter(zone) {
  if (!formatters.has(zone)) {
    formatters.set(zone, new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return formatters.get(zone);
}

// 이 이름을 시간대로 쓸 수 있는지(IANA 이름만). 못 쓰면 null.
function usableZone(zone) {
  const name = String(zone || '').replace(/^"|"$/g, '').trim();
  if (!name) return null;
  try { zoneFormatter(name); return name; } catch { return null; }
}

// 어떤 순간이 그 시간대에서 몇 년 몇 월 며칠 몇 시인지. zone이 없으면 이 맥의 시간대.
function wallOf(ms, zone) {
  if (!zone) {
    const d = new Date(ms);
    return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), mi: d.getMinutes(), s: d.getSeconds() };
  }
  const parts = {};
  zoneFormatter(zone).formatToParts(new Date(ms)).forEach(({ type, value }) => { parts[type] = Number(value); });
  return { y: parts.year, m: parts.month, d: parts.day, h: parts.hour % 24, mi: parts.minute, s: parts.second };
}

// 그 시간대의 벽시계 시각 → 순간(ms). 서머타임 경계는 두 번 맞춰 본다.
function instantOf(wall, zone) {
  const { y, m, d, h = 0, mi = 0, s = 0 } = wall;
  if (!zone) return new Date(y, m - 1, d, h, mi, s).getTime();
  const guess = Date.UTC(y, m - 1, d, h, mi, s);
  const offset = (t) => {
    const w = wallOf(t, zone);
    return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - t;
  };
  const first = offset(guess);
  let at = guess - first;
  const second = offset(at);
  if (second !== first) at = guess - second;
  return at;
}

// ---------- 날짜 값 ----------
const dayNumber = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
const civilOf = (day) => { const t = new Date(day * DAY_MS); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }; };
const weekdayOf = day => ((day % 7) + 11) % 7;   // 1970-01-01은 목요일(4)
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

// `20260924` / `20260924T100000` / `20260924T010000Z` → { allDay, day, wall, zone, instant }
function parseDate(prop, fallbackZone) {
  if (!prop) return null;
  const value = String(prop.value || '').trim();
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (dateOnly || (prop.params && prop.params.VALUE === 'DATE')) {
    const m = dateOnly || /^(\d{4})(\d{2})(\d{2})/.exec(value);
    if (!m) return null;
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return { allDay: true, day: dayNumber(y, mo, d), wall: { y, m: mo, d, h: 0, mi: 0, s: 0 }, zone: null };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
  if (!m) return null;
  const wall = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]), h: Number(m[4]), mi: Number(m[5]), s: Number(m[6]) };
  if (m[7] === 'Z') return { allDay: false, wall, zone: 'UTC', instant: Date.UTC(wall.y, wall.m - 1, wall.d, wall.h, wall.mi, wall.s) };
  const zone = usableZone(prop.params && prop.params.TZID) || fallbackZone || null;
  return { allDay: false, wall, zone, instant: instantOf(wall, zone) };
}

// `PT1H30M` · `P1D` · `-PT5M` → ms
function parseDuration(value) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(value || '').trim());
  if (!m) return null;
  const ms = (((Number(m[2] || 0) * 7 + Number(m[3] || 0)) * 24 + Number(m[4] || 0)) * 60 + Number(m[5] || 0)) * 60000 + Number(m[6] || 0) * 1000;
  return m[1] === '-' ? -ms : ms;
}

// `FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=…` → 규칙. 모르는 FREQ(HOURLY 등)는 null — 그러면 첫 회차만 본다.
function parseRule(value, fallbackZone) {
  const rule = {};
  String(value || '').split(';').forEach((pair) => {
    const eq = pair.indexOf('=');
    if (eq > 0) rule[pair.slice(0, eq).toUpperCase()] = pair.slice(eq + 1);
  });
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(rule.FREQ)) return null;
  const list = key => (rule[key] ? rule[key].split(',').map(one => one.trim()).filter(Boolean) : []);
  const byday = list('BYDAY').map((one) => {
    const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(one.toUpperCase());
    return m ? { ord: m[1] ? Number(m[1]) : 0, wd: WEEKDAYS.indexOf(m[2]) } : null;
  }).filter(Boolean);
  let until = null;
  if (rule.UNTIL) until = parseDate({ value: rule.UNTIL, params: {} }, fallbackZone);
  return {
    freq: rule.FREQ,
    interval: Math.max(1, Number(rule.INTERVAL) || 1),
    count: rule.COUNT ? Math.max(0, Number(rule.COUNT) || 0) : null,
    until,
    byday,
    bymonthday: list('BYMONTHDAY').map(Number).filter(n => Number.isInteger(n) && n !== 0),
    bymonth: list('BYMONTH').map(Number).filter(n => n >= 1 && n <= 12),
    wkst: Math.max(0, WEEKDAYS.indexOf(String(rule.WKST || 'MO').toUpperCase())),
  };
}

// 이 날(day)이 반복 규칙에 맞는지. 첫 회차(DTSTART의 날)는 부르는 쪽이 따로 센다.
function ruleMatches(rule, startDay, day) {
  const civ = civilOf(day);
  const first = civilOf(startDay);
  const wd = weekdayOf(day);
  if (rule.bymonth.length && !rule.bymonth.includes(civ.m)) return false;
  const monthDayOk = () => {
    const dim = daysInMonth(civ.y, civ.m);
    return rule.bymonthday.some(n => (n > 0 ? n === civ.d : dim + n + 1 === civ.d));
  };
  const nthOk = ({ ord, wd: want }) => {
    if (want !== wd) return false;
    if (!ord) return true;
    if (ord > 0) return Math.ceil(civ.d / 7) === ord;
    return Math.ceil((daysInMonth(civ.y, civ.m) - civ.d + 1) / 7) === -ord;
  };
  if (rule.freq === 'DAILY') {
    if ((day - startDay) % rule.interval !== 0) return false;
    if (rule.byday.length && !rule.byday.some(one => one.wd === wd)) return false;
    if (rule.bymonthday.length && !monthDayOk()) return false;
    return true;
  }
  if (rule.freq === 'WEEKLY') {
    const weekStart = one => one - ((weekdayOf(one) - rule.wkst + 7) % 7);
    if (((weekStart(day) - weekStart(startDay)) / 7) % rule.interval !== 0) return false;
    const days = rule.byday.length ? rule.byday.map(one => one.wd) : [weekdayOf(startDay)];
    return days.includes(wd);
  }
  if (rule.freq === 'MONTHLY') {
    if ((((civ.y - first.y) * 12 + (civ.m - first.m)) % rule.interval) !== 0) return false;
    if (rule.byday.length) return rule.byday.some(nthOk);
    if (rule.bymonthday.length) return monthDayOk();
    return civ.d === first.d;
  }
  // YEARLY
  if ((civ.y - first.y) % rule.interval !== 0) return false;
  if (!rule.bymonth.length && civ.m !== first.m) return false;
  if (rule.byday.length) return rule.byday.some(nthOk);
  if (rule.bymonthday.length) return monthDayOk();
  return civ.d === first.d;
}

// ---------- 오늘 일정 ----------
const first = (event, name) => (event[name] && event[name][0]) || null;
const allOf = (event, name) => event[name] || [];

// 반복 회차 하나를 가리키는 표지 — 한 번만 바꾼 회차(RECURRENCE-ID)와 짝을 맞출 때 쓴다.
const occurrenceKey = (uid, date) => `${uid}|${date.allDay ? `d${date.day}` : `t${date.instant}`}`;

// 구글 캘린더가 쓰는 일정 id 꼴(UID의 `@google.com` 앞, 반복 회차는 `_20260924T010000Z`)로 맞춘다 —
// Claude로 읽던 일정과 같은 회의로 이어지게. 빈칸은 뺀다(calendar_today.md의 `id:` 칸과 같은 규칙).
function externalIdOf(uid, instant, recurring) {
  const base = String(uid || '').replace(/@google\.com$/i, '').replace(/\s+/g, '');
  if (!base) return '';
  if (!recurring) return base;
  const t = new Date(instant).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `${base}_${t}`;
}

// 캘린더 전체에서 어느 하루(timeZone 기준 `now`가 속한 날)에 **시작하는** 회차를 모두 모은다.
// 종일 일정도 `allDay: true`로 함께 돌려준다 — 오늘 목록에 넣을지는 todayEvents가 정한다.
function occurrencesOn(calendar, { now = Date.now(), timeZone } = {}) {
  if (!calendar || !calendar.ok) return [];
  const outZone = usableZone(timeZone);
  const today = wallOf(now, outZone);
  const dayStart = instantOf({ y: today.y, m: today.m, d: today.d }, outZone);
  const next = civilOf(dayNumber(today.y, today.m, today.d) + 1);
  const dayEnd = instantOf({ y: next.y, m: next.m, d: next.d }, outZone);
  const todayDay = dayNumber(today.y, today.m, today.d);
  const calZone = usableZone(calendar.zone);
  const found = [];

  // 한 번만 바꾼 회차는 원래 회차 자리를 차지한다(원래 것은 건너뛴다).
  const overridden = new Set();
  calendar.events.forEach((event) => {
    const rid = first(event, 'RECURRENCE-ID');
    const uid = first(event, 'UID');
    if (!rid || !uid) return;
    const date = parseDate(rid, calZone);
    if (date) overridden.add(occurrenceKey(uid.value, date));
  });

  const push = (event, start, durationMs, recurring) => {
    const title = unescapeText((first(event, 'SUMMARY') || {}).value).replace(/\s+/g, ' ').trim().slice(0, 200) || '(제목 없음)';
    const conference = String((first(event, 'X-GOOGLE-CONFERENCE') || {}).value || '').trim();
    const url = String((first(event, 'URL') || {}).value || '').trim();
    const link = /^https:\/\/\S+$/.test(conference) ? conference : (/^https:\/\/\S+$/.test(url) ? url : null);
    const uid = (first(event, 'UID') || {}).value;
    if (start.allDay) {
      found.push({ allDay: true, title, link, externalId: externalIdOf(uid, 0, false) });
      return;
    }
    const endAt = start.instant + Math.max(0, durationMs);
    found.push({
      allDay: false, startAt: start.instant, endAt, title, link,
      externalId: externalIdOf(uid, start.instant, recurring),
    });
  };

  calendar.events.forEach((event) => {
    if (String((first(event, 'STATUS') || {}).value || '').trim().toUpperCase() === 'CANCELLED') return;
    const start = parseDate(first(event, 'DTSTART'), calZone);
    if (!start) return;
    const endDate = parseDate(first(event, 'DTEND'), calZone);
    const duration = parseDuration((first(event, 'DURATION') || {}).value);
    let durationMs = 0;
    if (start.allDay) durationMs = endDate && endDate.allDay ? (endDate.day - start.day) * DAY_MS : DAY_MS;
    else if (endDate && !endDate.allDay) durationMs = endDate.instant - start.instant;
    else if (duration !== null) durationMs = duration;

    const inToday = one => (one.allDay ? one.day === todayDay : one.instant >= dayStart && one.instant < dayEnd);
    const ruleProp = first(event, 'RRULE');
    const rule = ruleProp && !first(event, 'RECURRENCE-ID') ? parseRule(ruleProp.value, start.zone || calZone) : null;
    if (!rule) {
      if (inToday(start)) push(event, start, durationMs, false);
      return;
    }

    const uid = (first(event, 'UID') || {}).value || '';
    const exdates = new Set();
    allOf(event, 'EXDATE').forEach((prop) => {
      String(prop.value || '').split(',').forEach((one) => {
        const date = parseDate({ value: one.trim(), params: prop.params }, start.zone || calZone);
        if (date) exdates.add(date.allDay ? `d${date.day}` : `t${date.instant}`);
      });
    });
    const startDay = start.allDay ? start.day : dayNumber(start.wall.y, start.wall.m, start.wall.d);
    // 이 일정의 시간대에서 "오늘 끝"이 며칠인지 — 거기까지만 펼친다.
    const endWall = start.allDay ? civilOf(todayDay) : wallOf(dayEnd, start.zone === 'UTC' ? 'UTC' : start.zone);
    const lastDay = Math.min(dayNumber(endWall.y, endWall.m, endWall.d) + 1, startDay + MAX_SPAN_DAYS);
    let count = 0;
    for (let day = startDay; day <= lastDay; day += 1) {
      if (day !== startDay && !ruleMatches(rule, startDay, day)) continue;
      const civ = civilOf(day);
      const one = start.allDay
        ? { allDay: true, day }
        : { allDay: false, instant: start.zone === 'UTC'
          ? Date.UTC(civ.y, civ.m - 1, civ.d, start.wall.h, start.wall.mi, start.wall.s)
          : instantOf({ ...civ, h: start.wall.h, mi: start.wall.mi, s: start.wall.s }, start.zone) };
      if (rule.until) {
        if (rule.until.allDay ? day > rule.until.day : (!one.allDay && one.instant > rule.until.instant)) break;
      }
      count += 1;
      if (rule.count !== null && count > rule.count) break;
      if (exdates.has(one.allDay ? `d${one.day}` : `t${one.instant}`)) continue;
      if (overridden.has(occurrenceKey(uid, one))) continue;
      if (inToday(one)) push(event, one, durationMs, true);
    }
  });
  return found;
}

const hhmm = (ms, zone) => { const w = wallOf(ms, zone); return `${String(w.h).padStart(2, '0')}:${String(w.mi).padStart(2, '0')}`; };

// 오늘 탭 `오늘 미팅`에 줄 목록 — `calendar_today.md`와 같은 모양. **종일 일정은 넣지 않는다**:
// 그 파일도 `HH:MM-HH:MM` 줄만 읽고(캘린더 동기화 지침도 종일 일정은 빼거나 형식을 맞춘다), 회의 기록·
// 회의 정리는 시작 시각이 있는 일정만 다룬다. 끝이 내일로 넘어가면 `23:59`로 적는다.
function todayEvents(calendar, { now = Date.now(), timeZone } = {}) {
  const outZone = usableZone(timeZone);
  return occurrencesOn(calendar, { now, timeZone: outZone })
    .filter(one => !one.allDay)
    .sort((a, b) => a.startAt - b.startAt || a.title.localeCompare(b.title))
    .map((one) => {
      const start = hhmm(one.startAt, outZone);
      const sameDay = (() => { const a = wallOf(one.startAt, outZone); const b = wallOf(one.endAt, outZone); return a.y === b.y && a.m === b.m && a.d === b.d; })();
      const end = one.endAt <= one.startAt ? start : (sameDay ? hhmm(one.endAt, outZone) : '23:59');
      return { start, end, title: one.title, link: one.link, ...(one.externalId ? { externalId: one.externalId } : {}) };
    });
}

module.exports = {
  parseCalendar, todayEvents, occurrencesOn, parseRule, parseDate, parseDuration, instantOf, wallOf, unfold,
};

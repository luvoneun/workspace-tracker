// 맥 기본 캘린더 앱(Calendar.app)에서 캘린더 목록·오늘 일정을 읽는 JXA(JavaScript for Automation) 스크립트.
// 직접 부르지 않는다 — `tracker/inbox-app/calendar-mac.js`(node)가 `osascript -l JavaScript <이 파일> <요청 JSON>`으로
// 부르고, 여기서 돌려준 JSON 한 줄을 받아 오늘 일정을 뽑고 스냅샷을 쓴다(launchd → mac-calendar.sh → node → 이 파일).
// 앱 서버는 이 스크립트를 부르지 않는다(서버는 프로세스를 띄우지 않는다). node의 require로 읽지 않는다.
//
// 요청(첫 인자, JSON):
//   { "mode": "list" }  → 캘린더 목록만
//   { "mode": "read", "ids": ["…"], "start": ms, "end": ms, "me": { "<캘린더 id>": "a@b.com" } }
//     → 고른 캘린더의 오늘 시작하는 일정 + 오늘 전에 시작한 반복 일정(반복 규칙 그대로 — 펼치기는 node가 한다)
// 답(JSON 한 줄):
//   { ok: true, calendars: [{ id, name, writable }], events: [{ calendarId, uid, title, start, end, allDay, status,
//     recurrence, excluded: [ms], declined }], failed: [id], declinedChecked }
//   또는 { ok: false, error: 'denied' | 'failed', code }
// 장소·참석자 목록·메모는 싣지 않는다. 참석 상태는 "내가 거절했나"에만 쓰고 답에는 true/false만 남긴다.
// 캘린더 앱이 꺼져 있었으면(이 스크립트가 켠 것이면) 끝에 다시 끈다 — 사람이 켜 둔 앱은 그대로 둔다.

function run(argv) {
  var input = {};
  try { input = JSON.parse(argv[0] || '{}') || {}; } catch (error) { input = {}; }
  var app;
  var wasRunning = true;
  try {
    app = Application('Calendar');
    wasRunning = app.running();
  } catch (error) {
    return JSON.stringify(failure(error));
  }
  var answer;
  try {
    answer = input.mode === 'read' ? readEvents(app, input) : { ok: true, calendars: listCalendars(app).map(shown), events: [], failed: [] };
  } catch (error) {
    answer = failure(error);
  }
  if (!wasRunning) { try { app.quit(); } catch (error) { /* 못 꺼도 읽은 결과는 그대로 */ } }
  return JSON.stringify(answer);
}

function shown(entry) { return { id: entry.id, name: entry.name, writable: entry.writable }; }

// 캘린더 목록 — 한 번에 묻는다(캘린더마다 묻지 않는다). 목록을 읽다 막히면(허용 안 됨) 바깥에서 막힘으로 답한다.
function listCalendars(app) {
  var calendars = app.calendars;
  var ids = calendars.calendarIdentifier();
  var names = calendars.name();
  var writable = [];
  try { writable = calendars.writable(); } catch (error) { writable = []; }
  var list = [];
  for (var i = 0; i < ids.length; i += 1) {
    list.push({ id: String(ids[i]), name: String(names[i] || ''), writable: writable[i] !== false, index: i });
  }
  return list;
}

function readEvents(app, input) {
  var list = listCalendars(app);
  var wanted = Array.isArray(input.ids) ? input.ids.map(String) : [];
  var me = input.me && typeof input.me === 'object' ? input.me : {};
  var start = new Date(Number(input.start));
  var end = new Date(Number(input.end));
  var events = [];
  var failed = [];
  var declinedChecked = true;
  for (var c = 0; c < list.length; c += 1) {
    var entry = list[c];
    if (wanted.indexOf(entry.id) === -1) continue;
    try {
      var cal = app.calendars[entry.index];
      var mine = String(me[entry.id] || '').toLowerCase();
      // ① 오늘 시작하는 일정(한 번짜리 + 오늘 처음 시작하는 반복 일정)
      var today = grab(cal.events.whose({ _and: [{ startDate: { _greaterThanEquals: start } }, { startDate: { _lessThan: end } }] }), mine);
      // ② 오늘 전에 시작한 반복 일정 — 반복 규칙이 있는 것만 묻고, 안 되면 오늘 전 일정 전체에서 규칙 있는 것만 고른다.
      var repeated;
      try {
        repeated = grab(cal.events.whose({ _and: [{ startDate: { _lessThan: start } }, { recurrence: { _contains: 'FREQ' } }] }), mine);
      } catch (error) {
        if (isDenied(error)) throw error;
        repeated = grab(cal.events.whose({ startDate: { _lessThan: start } }), mine);
        repeated.rows = repeated.rows.filter(function (row) { return !!row.recurrence; });
      }
      if (!today.declinedChecked || !repeated.declinedChecked) declinedChecked = false;
      today.rows.concat(repeated.rows).forEach(function (row) { row.calendarId = entry.id; events.push(row); });
    } catch (error) {
      if (isDenied(error)) throw error;
      failed.push(entry.id);
    }
  }
  return { ok: true, calendars: list.map(shown), events: events, failed: failed, declinedChecked: declinedChecked };
}

// 한 묶음(whose 결과)의 속성을 속성마다 한 번씩만 묻는다(일정마다 묻는 것보다 훨씬 빠르다).
function grab(found, mine) {
  var titles = found.summary();
  var count = titles.length;
  var starts = found.startDate();
  var ends = found.endDate();
  var allDay = found.alldayEvent();
  var status = safe(function () { return found.status(); }, []);
  var uids = safe(function () { return found.uid(); }, []);
  var rules = safe(function () { return found.recurrence(); }, []);
  var excluded = safe(function () { return found.excludedDates(); }, []);
  var declined = [];
  var declinedChecked = true;
  if (mine && count) {
    var flags = declinedFlags(found, count, mine);
    if (flags) declined = flags; else declinedChecked = false;
  }
  var rows = [];
  for (var k = 0; k < count; k += 1) {
    rows.push({
      uid: uids[k] ? String(uids[k]) : '',
      title: titles[k] ? String(titles[k]) : '',
      start: starts[k] ? starts[k].getTime() : null,
      end: ends[k] ? ends[k].getTime() : null,
      allDay: !!allDay[k],
      status: status[k] ? String(status[k]) : '',
      recurrence: rules[k] ? String(rules[k]) : '',
      excluded: Array.isArray(excluded[k]) ? excluded[k].map(function (d) { return d && d.getTime ? d.getTime() : null; }).filter(function (v) { return v !== null; }) : [],
      declined: declined[k] === true,
    });
  }
  return { rows: rows, declinedChecked: declinedChecked };
}

// 일정마다 "나(mine)"의 참석 상태가 거절인지 — 참석자의 메일·상태를 한 번에 묻는다. 못 읽으면 null(모름).
function declinedFlags(found, count, mine) {
  try {
    var emails = found.attendees.email();
    var states = found.attendees.participationStatus();
    if (!Array.isArray(emails) || emails.length !== count) return null;
    var flags = [];
    for (var i = 0; i < count; i += 1) {
      var who = Array.isArray(emails[i]) ? emails[i] : [];
      var answer = Array.isArray(states[i]) ? states[i] : [];
      var hit = false;
      for (var j = 0; j < who.length; j += 1) {
        if (String(who[j] || '').toLowerCase() === mine && String(answer[j]) === 'declined') hit = true;
      }
      flags.push(hit);
    }
    return flags;
  } catch (error) {
    return null;
  }
}

function safe(fn, fallback) {
  try { return fn(); } catch (error) { if (isDenied(error)) throw error; return fallback; }
}

function errorNumber(error) {
  var number = error && typeof error.errorNumber === 'number' ? error.errorNumber : null;
  if (number === null) {
    var hit = /\((-?\d+)\)/.exec(String((error && error.message) || error));
    number = hit ? Number(hit[1]) : null;
  }
  return number;
}

// -1743: 이 맥이 자동화(Apple 이벤트) 허용을 막음. -1744: 허용을 묻는 창을 띄울 수 없음(뒤에서 돌 때).
function isDenied(error) {
  var number = errorNumber(error);
  return number === -1743 || number === -1744 || /not authori[sz]ed|not allowed/i.test(String((error && error.message) || error));
}

function failure(error) {
  return { ok: false, error: isDenied(error) ? 'denied' : 'failed', code: errorNumber(error) };
}

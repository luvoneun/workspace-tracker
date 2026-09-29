// 맥에 추가해 둔 캘린더 계정(회사 구글 계정 등)의 캘린더 목록·오늘 일정을 읽는 JXA(JavaScript for Automation) 스크립트.
// 캘린더 앱(Calendar.app)의 스크립팅이 아니라 **JXA의 ObjC 다리로 EventKit**을 쓴다 — 앱을 켜지 않고 읽고,
// 반복 일정도 EventKit이 오늘 회차로 펼쳐 준다(Calendar.app 스크립팅은 macOS에 따라 캘린더 id·uid 읽기가 -1728로
// 실패하고, 반복 원본 조회는 캘린더 여럿에 10분이 넘게 걸렸다).
// 직접 부르지 않는다 — `tracker/inbox-app/calendar-mac.js`(node)가 `osascript -l JavaScript <이 파일> <요청 JSON>`으로
// 부르고, 여기서 돌려준 JSON 한 줄을 받아 오늘 미팅을 고르고 스냅샷을 쓴다(launchd → mac-calendar.sh → node → 이 파일).
// 앱 서버는 이 스크립트를 부르지 않는다(서버는 프로세스를 띄우지 않는다). node의 require로 읽지 않는다.
//
// 요청(첫 인자, JSON):
//   { "mode": "list" }  → 캘린더 목록만
//   { "mode": "read", "ids": ["…"], "start": ms, "end": ms } → 고른 캘린더의 [start, end)와 겹치는 일정(반복은 회차로)
// 답(JSON 한 줄):
//   { ok: true, calendars: [{ id, name, writable, account }], events: [{ calendarId, id, externalId, title, start, end,
//     allDay, status, recurring, declined }], failed: [id] }
//   또는 { ok: false, error: 'denied' | 'failed', code }
// 장소·참석자 목록·메모는 싣지 않는다. 참석자는 "내가(isCurrentUser) 거절했나"에만 쓰고 답에는 true/false만 남긴다.
// 허용을 아직 묻지 않았으면 한 번 묻고 30초까지 기다린다. 거부·제한이면 denied.

ObjC.import('EventKit');
ObjC.import('Foundation');

// EKAuthorizationStatus: 0 아직 안 물음 · 1 제한 · 2 거부 · 3 허용(macOS 14+는 전체 접근) · 4 쓰기만(읽을 수 없다)
var AUTHORIZED = 3;
// EKParticipantStatus 3 = 거절(취소 일정 EKEventStatus 3은 node가 뺀다)
var PARTICIPANT_DECLINED = 3;

function run(argv) {
  var input = {};
  try { input = JSON.parse(argv[0] || '{}') || {}; } catch (error) { input = {}; }
  try {
    var store = $.EKEventStore.alloc.init;
    if (!authorize(store)) return JSON.stringify({ ok: false, error: 'denied', code: authStatus() });
    var calendars = listCalendars(store);
    if (input.mode !== 'read') return JSON.stringify({ ok: true, calendars: calendars.map(shown), events: [], failed: [] });
    return JSON.stringify(readEvents(store, calendars, input));
  } catch (error) {
    return JSON.stringify({ ok: false, error: 'failed', code: null });
  }
}

// ObjC 값은 `!==`로 견주면 늘 참이다 — 숫자로 바꿔 본다.
function authStatus() { return Number($.EKEventStore.authorizationStatusForEntityType($.EKEntityTypeEvent)); }

function authorize(store) {
  var status = authStatus();
  if (status === 0) {
    var done = false;
    var callback = function () { done = true; };
    if (store.respondsToSelector('requestFullAccessToEventsWithCompletion:')) store.requestFullAccessToEventsWithCompletion(callback);
    else store.requestAccessToEntityTypeCompletion($.EKEntityTypeEvent, callback);
    var until = $.NSDate.dateWithTimeIntervalSinceNow(30);
    while (!done && Number($.NSDate.date.compare(until)) < 0) $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.2));
    status = authStatus();
  }
  return status === AUTHORIZED;
}

function text(value) { try { var v = ObjC.unwrap(value); return v == null ? '' : String(v); } catch (error) { return ''; } }
function ms(date) { try { return date && !date.isNil() ? Math.round(Number(date.timeIntervalSince1970) * 1000) : null; } catch (error) { return null; } }
function shown(entry) { return { id: entry.id, name: entry.name, writable: entry.writable, account: entry.account }; }

function listCalendars(store) {
  var found = store.calendarsForEntityType($.EKEntityTypeEvent);
  var list = [];
  for (var i = 0; i < Number(found.count); i += 1) {
    var cal = found.objectAtIndex(i);
    var account = '';
    try { account = text(cal.source.title); } catch (error) { account = ''; }
    list.push({ id: text(cal.calendarIdentifier), name: text(cal.title), writable: !!ObjC.unwrap(cal.allowsContentModifications), account: account, ref: cal });
  }
  return list.filter(function (entry) { return !!entry.id; });
}

function readEvents(store, calendars, input) {
  var wanted = Array.isArray(input.ids) ? input.ids.map(String) : [];
  var start = $.NSDate.dateWithTimeIntervalSince1970(Number(input.start) / 1000);
  var end = $.NSDate.dateWithTimeIntervalSince1970(Number(input.end) / 1000);
  var events = [];
  var failed = [];
  // 캘린더마다 따로 묻는다 — 하나가 실패해도 나머지는 읽는다.
  calendars.forEach(function (entry) {
    if (wanted.indexOf(entry.id) === -1) return;
    try {
      var predicate = store.predicateForEventsWithStartDateEndDateCalendars(start, end, $([entry.ref]));
      var found = store.eventsMatchingPredicate(predicate);
      for (var k = 0; k < Number(found.count); k += 1) {
        var ev = found.objectAtIndex(k);
        events.push({
          calendarId: entry.id,
          id: text(ev.eventIdentifier),
          externalId: text(ev.calendarItemExternalIdentifier),
          title: text(ev.title),
          start: ms(ev.startDate),
          end: ms(ev.endDate),
          allDay: !!ObjC.unwrap(ev.isAllDay),
          status: Number(ev.status),
          recurring: !!ObjC.unwrap(ev.hasRecurrenceRules),
          declined: declined(ev),
        });
      }
    } catch (error) {
      failed.push(entry.id);
    }
  });
  return { ok: true, calendars: calendars.map(shown), events: events, failed: failed };
}

// 참석자 중 나(isCurrentUser)의 상태가 거절인지. 참석자가 없으면(내 일정) 거절이 아니다.
function declined(ev) {
  try {
    var people = ev.attendees;
    if (!people || people.isNil()) return false;
    for (var i = 0; i < Number(people.count); i += 1) {
      var one = people.objectAtIndex(i);
      if (ObjC.unwrap(one.isCurrentUser) && Number(one.participantStatus) === PARTICIPANT_DECLINED) return true;
    }
  } catch (error) { /* 못 읽으면 그대로 둔다 */ }
  return false;
}

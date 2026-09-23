// 캘린더 비밀 주소(iCal)를 앱 서버가 직접 읽어 **메모리에만** 들고 있는 작은 보관함(jira-live.js와 같은 방식).
// 파일은 하나도 쓰지 않는다 — `tracker/calendar_today.md`는 Claude로 읽는 갈래(calendar-sync)가 쓰는
// 스냅샷이고, 여기서 읽은 값이 있으면 서버는 그 파일을 보지 않는다(지라와 같은 우선순위).
//
// 지키는 것(테스트로 고정):
// - 설정이 없으면(`connected()`가 거짓) 타이머도 첫 읽기도 돌지 않는다.
// - 타이머는 `unref` — 이 보관함 때문에 프로세스가 끝나지 않는 일은 없다.
// - 동시에 두 번 돌지 않는다(도는 중이면 같은 약속을 나눠 쓴다).
// - 실패하면 이전 값을 그대로 둔다(`keepMs`까지). 그보다 묵으면 버린다.
// - 들고 있는 것은 풀어 둔 캘린더이고 "오늘 일정"은 물을 때마다 뽑는다 — 자정이 지나도 다시 읽지 않고
//   새 날의 일정이 나온다(같은 날 안에서는 한 번 뽑은 값을 다시 쓴다).
const { parseCalendar, todayEvents } = require('./ical');

const REFRESH_MS = 30 * 60 * 1000;  // 뒤에서 도는 갱신 주기
const SOFT_MS = 5 * 60 * 1000;      // 이보다 묵은 것을 보면 조회가 뒤에서 갱신을 건다(기다리지 않는다)
const KEEP_MS = 3 * 60 * 60 * 1000; // 갱신이 계속 실패해도 이만큼은 이전 값을 쓴다

function createCalendarLive({
  load, connected = () => true, now = Date.now, timeZone,
  refreshMs = REFRESH_MS, softMs = SOFT_MS, keepMs = KEEP_MS, onUpdate = null,
} = {}) {
  let held = null;   // { at, calendar } — 마지막으로 읽어 온 캘린더
  let memo = null;   // { at, day, events } — 같은 날 안에서 다시 쓰는 오늘 일정
  let busy = null;
  let timer = null;
  let failedAt = null;
  let failedAuth = false; // 마지막 실패가 "주소를 읽을 권한 없음"(401/403/404 — 주소가 바뀌었거나 지워졌다)인지

  const dayKey = () => {
    const t = new Date(now());
    return timeZone
      ? new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t)
      : `${t.getFullYear()}-${t.getMonth() + 1}-${t.getDate()}`;
  };

  // 지금 쓸 수 있는 값({ at, events }). 너무 묵은 것은 여기서 버린다(그때부터는 파일 스냅샷이 쓰인다).
  function current() {
    if (held && now() - held.at >= keepMs) { held = null; memo = null; }
    if (!held) return null;
    const day = dayKey();
    if (!memo || memo.at !== held.at || memo.day !== day) {
      memo = { at: held.at, day, events: todayEvents(held.calendar, { now: now(), timeZone }) };
    }
    return { at: held.at, events: memo.events };
  }

  function refresh() {
    if (busy) return busy;
    busy = (async () => {
      try {
        const text = await load();
        const calendar = parseCalendar(text);
        if (!calendar.ok) { failedAt = now(); failedAuth = false; return false; }
        held = { at: now(), calendar };
        memo = null;
        failedAt = null;
        failedAuth = false;
        if (typeof onUpdate === 'function') { try { onUpdate(); } catch { /* 곁들이는 일이다 */ } }
        return true;
      } catch (error) {
        // 실패는 조용히 흘린다 — 이전 값(또는 파일 스냅샷)이 그대로 쓰인다. 주소는 어디에도 남기지 않는다.
        failedAt = now();
        failedAuth = !!(error && error.auth);
        return false;
      } finally {
        busy = null;
      }
    })();
    return busy;
  }

  // 묵었으면 갱신을 걸기만 한다. **기다리지 않는다** — 목록 응답을 캘린더 때문에 늦추지 않는다.
  function nudge() {
    if (!connected()) return;
    if (!held || now() - held.at >= softMs) refresh();
  }

  function start() {
    if (timer || !connected()) return false;
    refresh();
    timer = setInterval(() => { if (connected()) refresh(); }, refreshMs);
    if (typeof timer.unref === 'function') timer.unref();
    return true;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    current, refresh, nudge, start, stop,
    started: () => !!timer,
    // 마지막 읽기가 실패했는지(연동 탭의 상태 줄이 쓴다). 성공하면 지워진다.
    failed: () => failedAt !== null,
    // 마지막 실패의 때와 갈래({ at, auth }), 없으면 null.
    failure: () => (failedAt === null ? null : { at: failedAt, auth: failedAuth }),
    holdsProcess: () => !!timer && typeof timer.hasRef === 'function' && timer.hasRef(),
  };
}

module.exports = {
  createCalendarLive, CALENDAR_LIVE_REFRESH_MS: REFRESH_MS, CALENDAR_LIVE_SOFT_MS: SOFT_MS, CALENDAR_LIVE_KEEP_MS: KEEP_MS,
};

// 내 담당 지라 티켓 목록을 앱 서버가 직접 읽어 **메모리에만** 들고 있는 작은 보관함.
// 파일은 하나도 쓰지 않는다 — `tracker/jira_issues.md`는 동기화 스킬이 덮어쓰는 스냅샷이고
// 앱은 그 파일을 읽기만 한다(그 파일은 이제 대비책이다: 토큰 만료·지라 장애·설정 없음).
//
// 지키는 것(테스트로 고정):
// - 설정이 없으면(`connected()`가 거짓) 타이머도 첫 읽기도 돌지 않는다.
// - 타이머는 `unref` — 이 보관함 때문에 프로세스가 끝나지 않는 일은 없다.
// - 동시에 두 번 돌지 않는다(도는 중이면 같은 약속을 나눠 쓴다).
// - 실패하면 이전 값을 그대로 둔다(`keepMs`까지). 그보다 묵으면 버린다.
const REFRESH_MS = 10 * 60 * 1000; // 뒤에서 도는 갱신 주기
const SOFT_MS = 5 * 60 * 1000;     // 이보다 묵은 것을 보면 조회가 뒤에서 갱신을 건다(기다리지 않는다)
const KEEP_MS = 30 * 60 * 1000;    // 갱신이 계속 실패해도 이만큼은 이전 값을 쓴다

function createJiraLive({
  list, keys = () => [], connected = () => true, now = Date.now,
  refreshMs = REFRESH_MS, softMs = SOFT_MS, keepMs = KEEP_MS,
} = {}) {
  let held = null;  // { at, issues } — 마지막으로 읽어 온 목록
  let busy = null;  // 도는 중인 갱신 하나
  let timer = null;
  // 마지막 읽기가 실패했으면 그때와 갈래({ at, auth }) — 연동 탭의 상태 줄·`지금 가져오기`가 쓴다.
  // `auth`는 지라가 401/403으로 답했다는 뜻(토큰 만료·권한 없음). 성공하면 지운다.
  let failure = null;

  // 지금 쓸 수 있는 값. 너무 묵은 것은 여기서 버린다(그때부터는 파일 스냅샷이 쓰인다).
  function current() {
    if (held && now() - held.at >= keepMs) held = null;
    return held;
  }

  function refresh() {
    if (busy) return busy;
    busy = (async () => {
      try {
        let linked = [];
        try { linked = keys() || []; } catch { linked = []; }
        const answer = await list(linked);
        if (answer && answer.ok && answer.connected && Array.isArray(answer.issues)) {
          held = { at: now(), issues: answer.issues };
          failure = null;
          return true;
        }
        // 실패는 조용히 흘린다 — 이전 값(또는 파일 스냅샷)이 그대로 쓰인다.
        if (answer && answer.ok === false) failure = { at: now(), auth: answer.kind === 'auth' };
        return false;
      } catch {
        failure = { at: now(), auth: false };
        return false;
      } finally {
        busy = null;
      }
    })();
    return busy;
  }

  // 묵었으면 갱신을 걸기만 한다. **기다리지 않는다** — 목록 응답을 지라 때문에 늦추지 않는다.
  function nudge() {
    if (!connected()) return;
    const value = current();
    if (!value || now() - value.at >= softMs) refresh();
  }

  function start() {
    if (timer || !connected()) return false;
    refresh();
    timer = setInterval(refresh, refreshMs);
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
    failure: () => failure,
    // 테스트가 "이 타이머가 프로세스를 붙잡고 있지 않다"를 확인하는 자리다.
    holdsProcess: () => !!timer && typeof timer.hasRef === 'function' && timer.hasRef(),
  };
}

module.exports = { createJiraLive, JIRA_LIVE_REFRESH_MS: REFRESH_MS, JIRA_LIVE_SOFT_MS: SOFT_MS, JIRA_LIVE_KEEP_MS: KEEP_MS };

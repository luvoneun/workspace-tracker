// `반응 필요` 목록(1차: 지라 댓글)을 앱 서버가 **메모리에만** 들고 있는 작은 보관함.
// 파일은 하나도 쓰지 않고, 댓글 글자는 여기서 잠깐 머물다 다음 갱신 때 버려진다.
//
// 리듬은 `jira-live.js`와 같다(뜰 때 한 번 · 10분마다 · 동시에 한 번 · 타이머 unref · 실패하면
// 이전 값을 30분까지). 그 파일을 일반화하지 않고 하나 더 둔 이유는 이 목록이 화면에 **상태 둘을 더**
// 말해야 하기 때문이다: `stale`(마지막 갱신이 실패해서 이전 값을 쓰는 중) · `error`(그보다 묵어
// 이전 값도 버린 뒤). 기존 목록(jira-live)은 실패를 조용히 흘리고 파일 스냅샷으로 물러서는 쪽이라
// 규칙이 다르다 — 주기 값만 그 파일에서 가져와 한 곳에서 관리한다.
const { JIRA_LIVE_REFRESH_MS, JIRA_LIVE_KEEP_MS } = require('./jira-live');

// 화면에 그대로 나가는 문구다(해요체). 지라가 준 원문·주소·토큰·계정 id는 절대 섞지 않는다.
const ATTENTION_ERROR = '지라 댓글을 읽지 못했어요.';

// 값이 없을 때 조회가 스스로 한 번 읽어 보는 간격. 지라가 죽어 있는 동안 화면을 열 때마다
// 다시 묻지 않으려는 바닥이다(뒤에서 도는 10분 갱신은 그대로다).
const RETRY_MS = 60 * 1000;

function createAttentionLive({
  load, connected = () => true, now = Date.now,
  refreshMs = JIRA_LIVE_REFRESH_MS, keepMs = JIRA_LIVE_KEEP_MS, retryMs = RETRY_MS,
} = {}) {
  let held = null;    // { at, items } — 마지막으로 성공한 읽기
  let failed = false; // 마지막 갱신이 실패했나
  let tried = null;   // 마지막으로 읽어 본 때(성공·실패 모두)
  let busy = null;
  let timer = null;

  // 지금 쓸 수 있는 값. 너무 묵은 것은 여기서 버린다(그때부터는 빈 목록 + 오류 문구다).
  function current() {
    if (held && now() - held.at >= keepMs) held = null;
    return held;
  }

  // 화면으로 나가는 모양. 항목 말고는 아무것도 싣지 않는다.
  function view() {
    const value = current();
    if (value) return { items: value.items, updatedAt: new Date(value.at).toISOString(), stale: failed };
    return { items: [], updatedAt: null, stale: false, ...(failed ? { error: ATTENTION_ERROR } : {}) };
  }

  // 조회가 스스로 읽어야 하나 — 값이 없고, 마지막으로 읽어 본 지 1분은 지났을 때만.
  function needsRead() {
    return !current() && (tried === null || now() - tried >= retryMs);
  }

  function refresh() {
    if (busy) return busy;
    tried = now();
    busy = (async () => {
      try {
        const answer = await load();
        // 설정이 없다는 답은 실패가 아니다(그때는 화면에 구역 자체가 없다).
        if (answer && answer.ok && answer.connected === false) return false;
        if (answer && answer.ok && Array.isArray(answer.items)) {
          held = { at: now(), items: answer.items };
          failed = false;
          return true;
        }
        failed = true;
        return false;
      } catch {
        failed = true;
        return false;
      } finally {
        busy = null;
      }
    })();
    return busy;
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
    current, view, refresh, needsRead, start, stop,
    started: () => !!timer,
    // 테스트가 "이 타이머가 프로세스를 붙잡고 있지 않다"를 확인하는 자리다.
    holdsProcess: () => !!timer && typeof timer.hasRef === 'function' && timer.hasRef(),
  };
}

module.exports = { createAttentionLive, ATTENTION_ERROR };

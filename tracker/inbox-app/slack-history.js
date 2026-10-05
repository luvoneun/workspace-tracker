// 슬랙 채널 기록을 끝 페이지까지 읽는다(slack-collect.js가 쓴다). 한 페이지라도 실패하면 통째로 실패 — 커서는 유지된다.
async function history({ token, channel, oldest, limit = 100, request = fetch }) {
  const messages = [], seen = new Set(); let cursor = '';
  do {
    const url = new URL('https://slack.com/api/conversations.history');
    url.searchParams.set('channel', channel);url.searchParams.set('limit', String(limit));
    if(oldest)url.searchParams.set('oldest',oldest);if(cursor)url.searchParams.set('cursor',cursor);
    const response=await request(url,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw new Error(`Slack HTTP ${response.status}; 커서는 유지됩니다.`);
    const result=await response.json();if(!result.ok)throw new Error(`Slack: ${result.error || 'unknown'}`);
    if(!Array.isArray(result.messages))throw new Error('Slack 응답을 확인해 주세요.');
    messages.push(...result.messages);
    const next=result.response_metadata?.next_cursor || '';
    if(result.has_more && !next)throw new Error('다음 페이지 커서가 없습니다. 커서는 유지됩니다.');
    if(next && seen.has(next))throw new Error('페이지 커서가 반복됩니다.');
    seen.add(next);cursor=next;
  } while(cursor);
  return {ok:true,messages,has_more:false,response_metadata:{next_cursor:''}};
}
// 잠깐의 오류인가 — 시간 초과·네트워크 끊김·슬랙 5xx·429·요청 한도 등 기다리면 풀리는 것만. slack-collect.js는 이런 실패를
// 같은 회차에 한 번 더 읽고, 그래도 안 되면 로그 줄 끝에 TRANSIENT_MARK를 붙인다. 서버는 그 표시가 붙은 실패를
// 연속 3회차가 될 때까지 실패로 올리지 않는다(DECISIONS 2026-10-06). 토큰·권한 문제(`Slack: invalid_auth` 등)는
// 여기 들지 않는다 — 사람이 고쳐야 하는 것이라 지금처럼 바로 알린다.
const TRANSIENT_MARK='(잠깐 오류)';
const TRANSIENT_NAME_RE=/^(?:TimeoutError|AbortError)$/;
const TRANSIENT_TEXT_RE=/aborted due to timeout|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|socket hang up|^Slack HTTP (?:5\d\d|429)\b|^Slack: (?:ratelimited|internal_error|fatal_error|service_unavailable|request_timeout)\b/;
function isTransientError(error){
  if(!error)return false;
  if(TRANSIENT_NAME_RE.test(String(error.name || '')))return true;
  const cause=error.cause || {};
  return TRANSIENT_TEXT_RE.test(String(error.message || '')) || TRANSIENT_TEXT_RE.test(String(cause.code || cause.message || ''));
}
// 앱의 `지금 가져오기`로 부른 회차(slack-capture.sh가 SLACK_CAPTURE_MANUAL=1을 넘긴다)의 실패 줄 끝 표시. 사람이 방금 누른
// 것이라 서버는 이 표시가 붙은 실패를 쉬는 시간(밤)에도·잠깐 오류여도 바로 보인다.
const MANUAL_MARK='(지금 가져오기)';
module.exports={history,isTransientError,TRANSIENT_MARK,MANUAL_MARK};

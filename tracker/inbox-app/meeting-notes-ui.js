// 미팅 노트 가져오기(티로) 한 벌 — 버튼·진행 상태 되묻기·끝났을 때의 알림·아직 안 가져온 회의 판정.
// app.js에서 그대로 옮긴 코드다. app.js의 공용 부품(request·showNotice·announce·load·todayStr·
// uiKoDate·workflowData·latestData)에 기대고, 회의 화면(meetings-ui.js)이 이 버튼들을 부른다.
// index.html에서 app.js보다 먼저 읽힌다.

/* ---------- 미팅 노트 가져오기 (티로) ----------
   자동으로는 가져오지 않는다 — 티로에서 사람이 먼저 검수한 뒤 버튼을 눌렀을 때만이다(DECISIONS 2026-09-24).
   앱 서버는 요청 표시 파일 하나만 남기고 실제 수집은 맥 스케줄러가 한다. 그래서 화면이 하는 일은 셋뿐이다:
   누른 그 버튼만 `가져오는 중…`으로 바꾸고, 5초마다 상태를 되묻고, 끝나면 목록을 다시 그리며 한 번 알린다. */
const MEETING_NOTES_POLL_MS = 5000;
const MEETING_NOTES_WATCH_MS = 40 * 60 * 1000;
let meetingNotesState = { used: true, state: 'idle' };
let meetingNotesTimer = null;
let meetingNotesWatchUntil = 0;
// 지금 화면에 그려져 있는 가져오기 버튼들. 상태가 바뀌면 글자·활성만 바꾼다(회의 화면을 통째로
// 다시 그리면 고치던 초안 문구가 날아간다).
const meetingNotesButtons = new Set();

const meetingNotesBusy = () => ['requested', 'running'].includes(meetingNotesState.state);
const meetingNotesEventKey = event => (event ? `${event.date || ''} ${event.start || ''} ${event.title || ''}` : '');
// 지금 도는 요청이 어느 버튼의 것인가 — `today`(오늘 것 모두) 또는 회의 하나.
function meetingNotesRunningKey() {
  if (!meetingNotesBusy()) return null;
  return meetingNotesState.scope === 'meeting' ? meetingNotesEventKey(meetingNotesState.meeting) : 'today';
}
// 이 회의의 미팅 노트를 이미 가져왔는지. 노트를 한 번 가져오면 초안을 다 검토해 0개가 되어도
// 서버가 그 회의에 노트 목록(tiroNotes)을 실어 준다 — 그래서 초안 수가 아니라 이 목록의 유무로 본다.
const meetingNotesHasNote = event => Array.isArray(event && event.tiroNotes);
// 회의마다 붙는 버튼은 아직 노트가 없고 이미 시작한 회의에만 — 지난 회의도 되고, 시작 전 회의에는 없다.
function meetingNotesCanFetch(event) {
  if (meetingNotesState.used === false) return false;
  if (!event || !event.date || !event.start || meetingNotesHasNote(event)) return false;
  const today = todayStr();
  if (event.date > today) return false;
  return !(event.date === today && event.start > nowHHMM());
}
// `오늘 것 모두 가져오기`의 대상 수 — 오늘 이미 시작했고 아직 노트가 없는 회의만 센다(지난 날짜는 빼고,
// 그 회의 하나의 버튼과 같은 시각 규칙을 그대로 쓴다). 머리·레일 메뉴가 같이 쓴다.
function meetingNotesPendingToday() {
  const meetings = (typeof workflowData === 'object' && workflowData ? workflowData.meetings : null) || [];
  const today = todayStr();
  return meetings.filter(event => event && event.date === today && meetingNotesCanFetch(event)).length;
}
// 오늘 이미 시작한 회의가 하나라도 있는지 — 없으면 "아직 가져올 게 없다", 있으면(전부 가져왔어도) "다 가져왔다".
function meetingNotesStartedToday() {
  const meetings = (typeof workflowData === 'object' && workflowData ? workflowData.meetings : null) || [];
  const today = todayStr();
  const now = nowHHMM();
  return meetings.some(event => event && event.date === today && event.start && event.start <= now);
}

// "끝난 회의"를 가릴 때 쓰는 종료 시각 — end가 없으면 start + 1시간으로 본다(BNOTES가 허용한 유일한 추측).
function meetingNotesEffectiveEnd(event) {
  if (event && event.end) return event.end;
  if (!event || !/^\d{2}:\d{2}$/.test(event.start || '')) return null;
  const [h, m] = event.start.split(':').map(Number);
  // 자정을 넘어가면 감지 않는다 — 23:xx에 시작한 회의를 다음 날 00:xx로 접어 "벌써 끝났다"로 잘못 보면 안 된다.
  const mins = Math.min(23 * 60 + 59, h * 60 + m + 60);
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}
// 리마인드 카드가 알릴 대상 — 오늘 날짜이고 이미 끝났고(위 규칙) 아직 노트가 없는 회의만.
// 지난 날짜 회의는 대상이 아니다(어제 것까지 매일 알리면 시끄럽다). 이른 시각 순으로 준다.
function meetingNotesMissingToday() {
  if (meetingNotesState.used === false) return [];
  const meetings = (typeof workflowData === 'object' && workflowData ? workflowData.meetings : null) || [];
  const today = todayStr();
  const now = nowHHMM();
  return meetings
    .filter(event => event && event.date === today && !meetingNotesHasNote(event))
    .filter(event => { const end = meetingNotesEffectiveEnd(event); return !!end && end <= now; })
    .sort((a, b) => (a.start || '').localeCompare(b.start || ''));
}

function meetingNotesApplyButton(entry) {
  const mine = meetingNotesRunningKey() === entry.key;
  entry.el.disabled = meetingNotesBusy();
  entry.el.setAttribute('aria-busy', String(mine));
  if (mine) { entry.el.textContent = '가져오는 중…'; return; }
  // 개수가 있으면 라벨 뒤에 조용한 숫자 표현을 붙인다(`d-headnum`의 `오늘 신규 N`과 같은 방식).
  if (!entry.count) { entry.el.textContent = entry.label; return; }
  const label = document.createElement('span');
  label.textContent = `${entry.label} `;
  const num = document.createElement('span');
  num.className = 'num';
  num.textContent = entry.count;
  entry.el.replaceChildren(label, num);
}
function meetingNotesSyncButtons() {
  [...meetingNotesButtons].forEach((entry) => {
    if (entry.el.isConnected === false) { meetingNotesButtons.delete(entry); return; }
    meetingNotesApplyButton(entry);
  });
}
// target: 'today' 또는 회의 하나. 두 버튼이 같은 길을 쓴다. count는 라벨 뒤에 붙는 조용한 개수(0이면 안 붙는다).
function meetingNotesButton(label, target, className = 'd-btn sm', count = 0) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  const entry = {
    el: button, label, count,
    scope: target === 'today' ? 'today' : 'meeting',
    meeting: target === 'today' ? null : target,
    key: target === 'today' ? 'today' : meetingNotesEventKey(target),
  };
  button.addEventListener('click', () => meetingNotesStart(entry.scope, entry.meeting));
  meetingNotesButtons.add(entry);
  meetingNotesApplyButton(entry);
  return button;
}

// 요청을 보내기 직전의 "노트가 있는 회의 수 · 초안 수 합"을 기억해 둔다 — 끝난 뒤(load() 다음) 다시 세어
// 늘었는지로 `scope: today`의 알림 문구를 고른다. 페이지를 새로 열어 진행 중인 요청에 이어붙은 경우처럼
// 기억이 없으면(null) 기존 문구(status.summary)로 돌아간다.
let meetingNotesBeforeToday = null;
const meetingNotesTotals = () => {
  const meetings = (typeof workflowData === 'object' && workflowData ? workflowData.meetings : null) || [];
  return {
    meetings: meetings.filter(meetingNotesHasNote).length,
    drafts: meetings.reduce((sum, event) => sum + ((event.drafts && event.drafts.length) || 0), 0),
  };
};

// scope: 'today'(오늘 것 모두) 또는 'meeting'(그 회의 하나). 버튼과 메뉴 항목이 같은 길을 쓴다.
async function meetingNotesStart(scope, event) {
  if (meetingNotesBusy()) return;
  const meeting = scope === 'meeting' && event
    ? { date: event.date, start: event.start, end: event.end || '', title: event.title }
    : null;
  const body = meeting ? { scope: 'meeting', meeting } : { scope: 'today' };
  meetingNotesBeforeToday = body.scope === 'today' ? meetingNotesTotals() : null;
  // 먼저 이 버튼을 진행 중으로 바꾼다 — 두 번 눌러 요청이 겹치지 않게(서버도 409로 막는다).
  meetingNotesState = { ...meetingNotesState, state: 'requested', scope: body.scope, meeting };
  meetingNotesSyncButtons();
  try {
    const response = await request('/api/meeting-notes/request', {
      method: 'POST', quiet: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    meetingNotesApply(await response.json());
  } catch (error) {
    meetingNotesState = { ...meetingNotesState, state: 'idle', scope: null, meeting: null };
    meetingNotesSyncButtons();
    showNotice(error && error.message ? error.message : '미팅 노트를 가져오지 못했어요', true);
    return;
  }
  meetingNotesWatchUntil = Date.now() + MEETING_NOTES_WATCH_MS;
  meetingNotesSchedule();
}

// 상태를 화면에 반영한다. 진행 중이던 것이 방금 끝났으면 true를 돌려주고, 알림은 부르는 쪽이 load() 뒤에 띄운다.
function meetingNotesApply(status) {
  if (!status || typeof status !== 'object' || typeof status.state !== 'string') return false;
  const before = meetingNotesState.state;
  meetingNotesState = status;
  meetingNotesSyncButtons();
  if (meetingNotesBusy()) {
    if (!meetingNotesWatchUntil) meetingNotesWatchUntil = Date.now() + MEETING_NOTES_WATCH_MS;
    meetingNotesSchedule();
  } else {
    meetingNotesWatchUntil = 0;
    clearTimeout(meetingNotesTimer);
    meetingNotesTimer = null;
  }
  return ['done', 'failed'].includes(status.state) && ['requested', 'running'].includes(before);
}

function meetingNotesSchedule() {
  clearTimeout(meetingNotesTimer);
  meetingNotesTimer = null;
  if (!meetingNotesBusy() || Date.now() > meetingNotesWatchUntil) return;
  // 숨은 탭에서는 묻지 않고 쉰다. 돌아오면 visibilitychange가 다시 깨운다.
  if (typeof document !== 'undefined' && document.hidden) return;
  meetingNotesTimer = setTimeout(meetingNotesPoll, MEETING_NOTES_POLL_MS);
}

async function meetingNotesPoll() {
  meetingNotesTimer = null;
  let status = null;
  try {
    const response = await fetch('/api/meeting-notes/status');
    if (response.ok) status = await response.json();
  } catch { /* 잠깐 끊긴 것은 다음 물음에서 다시 본다 */ }
  if (!status) { meetingNotesSchedule(); return; }
  if (!meetingNotesApply(status)) return;
  await load();
  meetingNotesAnnounce(status);
}

// 로그에 남은 보고문은 길다 — 알림 뒤에 조용히 붙일 만큼만 자른다.
const meetingNotesSummary = (text) => {
  if (typeof text !== 'string') return '';
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > 80 ? `${clean.slice(0, 80)}…` : clean;
};
const meetingNotesFind = meeting => ((typeof workflowData === 'object' && workflowData ? workflowData.meetings : null) || [])
  .find(event => meetingNotesEventKey(event) === meetingNotesEventKey(meeting)) || null;

function meetingNotesAnnounce(status) {
  if (status.state === 'failed') {
    meetingNotesBeforeToday = null;
    showNotice('미팅 노트를 가져오지 못했어요', true, null,
      { label: '자세히', onClick: () => { if (typeof settingsOpen === 'function') settingsOpen('integrations', 'log:notes'); } });
    return;
  }
  if (status.scope === 'meeting') {
    const event = meetingNotesFind(status.meeting);
    // 끝났는데도 이 회의에 노트가 없으면 그 시간에 녹음된 것이 없었던 것이다(오류가 아니다).
    if (!meetingNotesHasNote(event)) { showNotice('이 회의 시간에 녹음된 노트를 찾지 못했어요'); return; }
    const count = (event.drafts || []).length;
    showNotice(count ? `미팅 노트를 가져왔어요 · 초안 ${count}개` : '미팅 노트를 가져왔어요');
    return;
  }
  // scope: today. 보낼 때 기억해 둔 수와 비교해 실제로 늘었는지로 말한다 — AI가 돈 뒤 "새로 분류할 회의
  // 없음"으로 끝나도 예전처럼 `가져왔어요`라고 하지 않는다. 기억이 없으면(페이지를 새로 열어 이어진 진행 중
  // 요청 등) 기존처럼 로그 요약을 쓴다.
  const before = meetingNotesBeforeToday;
  meetingNotesBeforeToday = null;
  if (before) {
    const after = meetingNotesTotals();
    const gainedMeetings = Math.max(0, after.meetings - before.meetings);
    const gainedDrafts = Math.max(0, after.drafts - before.drafts);
    if (gainedMeetings > 0) {
      showNotice(gainedDrafts > 0
        ? `미팅 노트를 가져왔어요 · 회의 ${gainedMeetings}개, 초안 ${gainedDrafts}개`
        : `미팅 노트를 가져왔어요 · 회의 ${gainedMeetings}개`);
    } else {
      showNotice('새로 가져올 미팅 노트가 없었어요');
    }
    return;
  }
  const summary = meetingNotesSummary(status.summary);
  showNotice(summary ? `미팅 노트를 가져왔어요 · ${summary}` : '미팅 노트를 가져왔어요');
}

// 버튼 옆 조용한 한 줄. 오늘 가져온 기록이 있을 때만 — 어제 것은 알려 줄 필요가 없다.
function meetingNotesLastText() {
  const at = meetingNotesState.lastRunAt || '';
  if (!at.startsWith(todayStr()) || meetingNotesState.lastKind !== 'run') return '';
  return `오늘 ${at.slice(11, 16)}에 가져왔어요`;
}

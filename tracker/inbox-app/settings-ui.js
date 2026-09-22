// 설정 창 한 벌 — 상태 탭(자동화 줄·로그 묶음·슬랙 처리 대장)과 사용법 탭(문답), 창 열고 닫기.
// app.js에서 그대로 옮긴 코드다. app.js의 공용 부품(request·showNotice·uiIcon·escPush·escDrop·
// uiMenuClose·syncStale·latestData)과 jira-ui.js(jiraLiveNote)에 기댄다.
// 맨 아래 몇 줄은 화면 요소를 바로 잡아 쓰므로 index.html의 <body> 끝(app.js 바로 앞)에서 읽힌다.

// 설정 > 상태의 슬랙 줄 아래 처리 대장 한 줄(BNOTES). 슬랙 수집 지침이 실행마다 로그 맨 앞에 남기는
// `이번에 본 메시지 N개 = 등록 a · 링크 중복 b · 비슷한 일이라 건너뜀 c · 시스템 d`(또는 합이 안 맞을
// 때의 `합이 안 맞습니다 …`) 문장을 tail(최근 60줄)에서 가장 최근 것 하나만 찾는다. 그 실행(같은
// 시작~종료 블록) 안의 `🔁 이미 있는 '…'랑 중복돼서 안 가져왔어요`(건너뛴 것, 최대 3개)와 `⚠️`로
// 시작하는 줄(원문 못 읽음·파일만 있는 메시지, 최대 2개)도 함께 뽑는다. 문장이 없으면(옛 로그·처리
// 대장이 없던 실행) null을 돌려주고, 그 자리는 아무것도 그리지 않는다.
const SLACK_LEDGER_RE = /^이번에 본 메시지 (\d+)개 = 등록 (\d+) · 링크 중복 (\d+) · 비슷한 일이라 건너뜀 (\d+) · 시스템 (\d+)$/;
const SLACK_MISMATCH_RE = /^합이 안 맞습니다.*$/;
const SLACK_SKIP_RE = /^🔁\s*이미 있는\s*'(.+)'\s*랑 중복돼서 안 가져왔어요/;
const SLACK_WARN_RE = /^⚠️/;
const SLACK_BLOCK_START_RE = /^─+ \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \S+ 시작$/;
const SLACK_BLOCK_END_RE = /^─+ \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \S+ 종료 \(exit -?\d+\)$/;

function slackLedgerFromTail(tail) {
  const lines = (Array.isArray(tail) ? tail : []).map(line => String(line).trim()).filter(Boolean);
  let at = -1;
  lines.forEach((line, index) => { if (SLACK_LEDGER_RE.test(line) || SLACK_MISMATCH_RE.test(line)) at = index; });
  if (at === -1) return null;
  const summary = lines[at];
  // 실행 블록 경계 — run-task.sh가 남기는 시작/종료 줄 사이만 "그 실행"으로 본다.
  let start = 0;
  for (let i = at - 1; i >= 0; i -= 1) { if (SLACK_BLOCK_START_RE.test(lines[i])) { start = i + 1; break; } }
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i += 1) {
    if (SLACK_BLOCK_START_RE.test(lines[i]) || SLACK_BLOCK_END_RE.test(lines[i])) { end = i; break; }
  }
  const block = lines.slice(start, end);
  const match = SLACK_LEDGER_RE.exec(summary);
  return {
    mismatch: SLACK_MISMATCH_RE.test(summary) ? summary : '',
    counts: match ? { seen: match[1], registered: match[2], duplicate: match[3], skipped: match[4], system: match[5] } : null,
    skipped: block.map(line => SLACK_SKIP_RE.exec(line)).filter(Boolean).map(m => m[1]).slice(0, 3),
    warnings: block.filter(line => SLACK_WARN_RE.test(line)).slice(0, 2),
  };
}

// 위 결과를 설정 > 상태의 슬랙 줄 아래 조용한 줄(들)로 만든다 — 합이 안 맞으면 그 문장을 주의색으로
// 그대로, 아니면 넷의 셈을 한 줄로(0인 항목은 흐리게). 건너뛴 것·원문 못 읽은 줄은 그 아래 따로 한 줄씩.
function slackLedgerNotes(tail) {
  const ledger = slackLedgerFromTail(tail);
  if (!ledger) return [];
  const nodes = [];
  const summary = document.createElement('div');
  summary.className = 'd-autonote' + (ledger.mismatch ? ' k-warn' : '');
  if (ledger.mismatch) {
    summary.textContent = ledger.mismatch;
  } else if (ledger.counts) {
    summary.appendChild(document.createTextNode(`최근 수집 · 본 메시지 ${ledger.counts.seen}개 → `));
    [['등록', ledger.counts.registered], ['중복', ledger.counts.duplicate], ['건너뜀', ledger.counts.skipped], ['시스템', ledger.counts.system]]
      .forEach(([label, value], index) => {
        if (index) summary.appendChild(document.createTextNode(' · '));
        const part = document.createElement('span');
        if (Number(value) === 0) part.className = 'is-zero';
        part.textContent = `${label} ${value}`;
        summary.appendChild(part);
      });
  } else {
    return [];
  }
  nodes.push(summary);
  if (ledger.skipped.length) {
    const skip = document.createElement('div');
    skip.className = 'd-autonote';
    skip.textContent = `건너뛴 것: ${ledger.skipped.join(', ')}`;
    nodes.push(skip);
  }
  ledger.warnings.forEach((line) => {
    const warn = document.createElement('div');
    warn.className = 'd-autonote';
    warn.textContent = line;
    nodes.push(warn);
  });
  return nodes;
}

// ---------- 설정 (상태 / 사용법) ----------

function relativeTimeFrom(timeStr) {
  // "YYYY-MM-DD HH:MM:SS" (로컬 시각) 기준으로 몇 분/시간 전인지
  const then = new Date(timeStr.replace(' ', 'T'));
  if (Number.isNaN(then.getTime())) return timeStr;
  const diffMin = Math.round((Date.now() - then.getTime()) / 60000);
  if (diffMin < 1) return '방금';
  if (diffMin < 60) return `${diffMin}분 전`;
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return `${diffHour}시간 전`;
  return `${Math.round(diffHour / 24)}일 전`;
}

// 자주 보는 실패 패턴은 원문(영어) 대신 한국어로 바꿔서 보여준다.
// 모르는 패턴은 억지로 번역하지 않고 원문 그대로 둔다.
function translateFailureText(text) {
  const sessionLimit = text.match(/session limit.*?resets\s+([^)]+)/i);
  if (sessionLimit) return `Claude 사용량 한도에 걸림 · ${sessionLimit[1].trim()}에 풀림`;
  if (/session limit/i.test(text)) return 'Claude 사용량 한도에 걸림';
  return text;
}

// 성공 보고문은 Claude가 매번 자유롭게 쓴 긴 문장이라(마크다운 ** 기호까지 그대로) 스캔하기 어렵다.
// 첫 문장만 보여주고 나머지는 "로그 더 보기"에서 보게 한다.
function trimSummaryText(text) {
  if (!text) return text;
  const clean = text.replace(/\*\*/g, '').trim();
  const firstLine = clean.split('\n')[0];
  const sentenceEnd = firstLine.search(/[.!?](?!\d)/);
  let short = sentenceEnd >= 0 ? firstLine.slice(0, sentenceEnd + 1) : firstLine;
  if (short.length > 80) short = short.slice(0, 80) + '…';
  return short.length < clean.length ? `${short} …` : short;
}

let automationStatusCache = [];

async function fetchAutomationStatus() {
  try {
    const data = await request('/api/automation/status').then(r => r.json());
    automationStatusCache = data.automations || [];
  } catch {
    automationStatusCache = [];
  }
  // 안 열어봐도 톱니바퀴만 보고 "확인할 게 있다"를 알 수 있게 점을 켠다
  // 지금 실제로 실패 중인 게 있을 때만 — 예전에 있었다가 해결된 건 알림이 아니다
  const hasAlert = automationStatusCache.some(a => a.lastKind === 'fail');
  document.getElementById('settingsBtn')?.classList.toggle('has-alert', hasAlert);
  return automationStatusCache;
}

// 상태 탭은 자동화마다 한 줄이다: 이름 | 마지막 실행 | (있으면) 다음 실행.
// 헤더의 동기화 지연 경고에서 들어오면 그 줄을 잠깐 밝힌다(settingsFocusKey).
let settingsFocusKey = null;

const AUTOMATION_STATE_WORD = { run: '성공', fail: '실패', skip: '건너뜀' };

async function renderAutomationStatus() {
  const view = document.getElementById('settingsStatusView');
  view.replaceChildren();
  view.insertAdjacentHTML('beforeend', '<div class="d-empty">불러오는 중이에요…</div>');
  const automations = await fetchAutomationStatus();
  view.replaceChildren();
  if (!automations.length) {
    view.insertAdjacentHTML('beforeend', '<div class="d-empty">상태를 불러오지 못했어요.</div>');
    return;
  }
  // "최근 실패 기록이 있음"과 "지금 문제임"은 다르다 — 예전엔 둘을 구분 안 해서,
  // 벌써 고쳐져서 마지막 실행이 정상이었는데도 몇 시간 전 실패 이력 때문에 계속
  // 빨간 점이 떠 있었다("이게 지금도 그런 건지 예전 건지 모르겠다"는 혼란의 원인).
  // 가장 최근 실행 자체가 실패였을 때만 "지금 문제"로 본다.
  [...automations]
    .sort((a, b) => (b.lastKind === 'fail' ? 1 : 0) - (a.lastKind === 'fail' ? 1 : 0))
    .forEach(a => view.appendChild(automationRow(a)));

  const focused = settingsFocusKey
    ? view.querySelector(`[data-automation="${CSS.escape(String(settingsFocusKey))}"]`)
    : null;
  settingsFocusKey = null;
  if (focused) { focused.classList.add('is-focus'); focused.scrollIntoView({ block: 'nearest' }); }
}

// 접히는 기록 묶음 하나(지금 실패 중이면 `최근 기록`, 해결된 과거 실패는 `지난 문제 N건`).
function automationLogBlock(label, lines, muted) {
  const box = document.createElement('details');
  const head = document.createElement('summary');
  head.innerHTML = uiIcon('chevron');
  head.appendChild(document.createTextNode(label));
  box.appendChild(head);
  const body = document.createElement('div');
  body.className = 'd-logs';
  lines.forEach((text) => {
    const line = document.createElement('div');
    line.className = 'd-logline' + (muted ? ' is-muted' : '');
    line.textContent = text;
    body.appendChild(line);
  });
  box.appendChild(body);
  return box;
}

function automationRow(a) {
  const failingNow = a.lastKind === 'fail';
  const row = document.createElement('div');
  row.className = 'd-auto';
  row.dataset.automation = a.key;

  const top = document.createElement('div');
  top.className = 'd-autotop';
  const name = document.createElement('span');
  name.className = 'nm';
  name.textContent = a.name;
  const state = document.createElement('span');
  state.className = 'st' + (failingNow ? ' k-neg' : '');
  state.textContent = a.lastRunAt
    ? `${relativeTimeFrom(a.lastRunAt)} ${AUTOMATION_STATE_WORD[a.lastKind] || '실행'}`
    : '기록 없음';
  // 잘 돌고 있을 때의 보고문은 줄을 차지하지 않고 마우스를 올리면 보이게 둔다.
  if (!failingNow && a.lastSummary) state.title = trimSummaryText(a.lastSummary);
  if (failingNow) state.insertAdjacentHTML('afterbegin', '<i class="d-dot" aria-hidden="true"></i>');
  top.append(name, state);
  if (a.nextRunAt) {
    const next = document.createElement('span');
    next.className = 'nx';
    next.textContent = `다음 실행 ${a.nextRunAt}`;
    top.appendChild(next);
  }
  row.appendChild(top);

  // 지라 목록은 앱이 직접 읽는다 — 그때는 이 자동화가 대비책이라는 뜻이라 한 마디만 조용히 덧붙인다.
  const note = a.key === 'jira' ? jiraLiveNote(latestData && latestData.jiraSync) : '';
  if (note) {
    const line = document.createElement('div');
    line.className = 'd-autonote';
    line.textContent = note;
    row.appendChild(line);
  }
  // 슬랙 줄 아래 최근 수집의 처리 대장(BNOTES) — 로그를 열지 않고도 뭐가 왜 안 들어왔는지 본다.
  if (a.key === 'slack') slackLedgerNotes(a.tail).forEach(line => row.appendChild(line));

  if (failingNow) {
    const error = document.createElement('div');
    error.className = 'd-autoerr';
    error.textContent = trimSummaryText(translateFailureText(a.lastSummary || '실패했어요.'));
    row.appendChild(error);
    const lines = a.recentFailures.map(f => `${f.time} · ${translateFailureText(f.text)}`)
      .concat(a.tail && a.tail.length ? a.tail.slice(-20) : []);
    if (lines.length) row.appendChild(automationLogBlock('최근 기록', lines, false));
  } else if (a.recentFailures.length) {
    // 지금은 정상 — 예전 실패는 경고가 아니라 참고용으로만, 접어서 조용히 둔다
    row.appendChild(automationLogBlock(`지난 문제 ${a.recentFailures.length}건 · 지금은 정상`,
      a.recentFailures.map(f => `${f.time} · ${translateFailureText(f.text)}`), true));
  }
  return row;
}

// 사용법은 문답을 읽기 좋게 늘어놓은 문서다. 이번 개편으로 달라진 동작에 맞춰 적는다.
const SETTINGS_FAQ = [
  ['오늘 하기 버거운 업무는 어떻게 미루나요',
    '업무 줄에 마우스를 올리면 <b>내일</b>·<b>나중에</b>가 나와요. 나중에로 보낸 업무는 머리줄의 <b>나중에 할 일</b> 서랍에 모이고, 거기서 <b>오늘로</b> 다시 가져와요. 따로 "계획 모드"로 들어갈 필요가 없어요.'],
  ['새로 들어온 것(인박스)이 뭔가요',
    '슬랙·회의에서 자동으로 모인 항목이 먼저 쌓이는 곳이에요. AI는 오늘 할지 나중에 할지 정하지 않아요. 프로젝트만 지정하고 <b>오늘</b> 또는 <b>나중에</b>로 보내면 정리가 끝나고 여기서 사라져요.'],
  ['프로젝트는 어떻게 지정하고 어디서 모아 보나요',
    '줄의 <b>⋯</b> 더보기 → <b>프로젝트</b>에서 지라 이슈나 그룹을 고르면 돼요. 모아 보려면 위쪽 <b>프로젝트</b> 탭으로 가요. 목록의 그룹 제목을 눌러도 그 프로젝트로 넘어가요.'],
  ['직접 만든 프로젝트에 지라 티켓을 걸 수 있나요',
    '네. 지라와 연결되지 않은 프로젝트를 열면 <b>지라 티켓 연결</b> 버튼이 있어요. 티켓 번호나 지라 주소를 붙여넣고 찾기를 누르면 미리보기가 뜨고, 거기서 <b>연결</b>을 눌러야 저장돼요. 아래 <b>완료한 티켓도 보기</b>를 누르면 최근 90일 안에 끝낸 내 담당 티켓도 함께 볼 수 있어요. 연결해도 프로젝트 이름과 항목은 바뀌지 않고 연결 표시만 붙어요 — 풀고 싶으면 ⋯의 <b>지라 연결 해제</b>를 써요.'],
  ['지라 프로젝트는 화면에서 어떻게 보나요',
    '지라와 연결된 프로젝트를 열면 제목 아래 <b>지라 띠 카드</b>가 서요. 요약·담당자와 함께 <b>지라 상태</b>·<b>배포 버전</b>·<b>기한</b> 세 칸을 보여 주고, 눌러서 바로 바꿀 수 있어요 — 지라에 실제로 반영되는 값이라 바꾸기 전에 확인 줄이 한 번 더 물어봐요(⌘Z로는 못 되돌려요). 지라 상태 글자색은 할 일=회색, 진행 중=파랑, 완료=초록이에요. 아래 하위 티켓 줄을 펼치면 담당자별로 몇 개 남았는지 보이고, 이름을 누르면 그 사람 것만 걸러 봐요 — 하위 티켓은 보기만 하고 여기서 고치지는 않아요.'],
  ['안 쓰는 프로젝트가 쌓이면 어떻게 하나요',
    '열린 업무가 없고 14일 넘게 조용한 프로젝트는 왼쪽 목록 끝 <b>지난 프로젝트</b> 구역으로 저절로 내려가요. 직접 정리하고 싶으면 프로젝트 제목 옆 ⋯에서 <b>보관</b>을 눌러요(되돌리기로 다시 꺼낼 수 있어요). 정리할 게 쌓이면 조용한 권유 줄에 <b>모두 보관</b> 버튼이 함께 떠요. 보관해도 업무·기록·주간요약·검색은 그대로예요.'],
  ['여러 개를 한 번에 정리하려면',
    '오늘 할 일 머리줄의 <b>⋯</b> → <b>여러 개 선택</b>을 누르면 줄마다 선택 칸이 하나 더 생겨요(완료 체크는 그대로 써요). 목록 아래 막대에서 <b>오늘로</b>·<b>내일</b>·<b>나중에</b>·<b>날짜</b>·<b>프로젝트</b>·<b>완료로 표시</b>·<b>삭제</b>를 한 번에 적용해요.'],
  ['찾고 싶은 기록이 있으면',
    '<b>⌘K</b>(윈도는 Ctrl+K)로 검색을 열어요. 할 일·확인 대기·결정·아이디어·회의를 한 자리에서 찾고, 위 칩으로 종류를 좁힐 수 있어요. 검색에서 연 항목을 닫으면 찾던 자리로 그대로 돌아와요.'],
  ['회의 내용은 어디서 정리하나요',
    '왼쪽 <b>오늘 미팅</b>의 회의를 누르면 오른쪽에 회의 정리 패널이 열려요. 초안을 고쳐 담고, 담은 뒤 뜨는 결과 카드의 <b>실행 취소</b>로 되돌릴 수 있어요.'],
  ['미팅 노트는 언제 가져오나요',
    '자동으로 가져오지 않고 <b>버튼을 눌러야</b> 가져와요. 회의 정리 화면에서 그 회의만 가져오거나, 회의 목록 머리의 <b>오늘 것 모두 가져오기</b>로 오늘 회의를 한 번에 가져올 수 있어요. 이미 가져온 회의는 조용한 글자로 <b>미팅 노트 가져옴</b>이라고 표시돼요. 끝난 회의인데 아직 안 가져왔으면 왼쪽 레일 리마인드 카드에 한 줄로 알려 주고, 눌러서 바로 그 회의로 가요.'],
  ['회의에서 담은 항목을 잘못 골랐으면',
    '이미 담은 할 일·확인 대기·결정도 나중에 종류를 바꿀 수 있어요. 그 줄의 ⋯ → <b>종류 바꾸기</b>에서 고르면 새로 만들지 않고 같은 항목을 옮기는 것이라 회의 연결과 기록이 그대로 남아요. 완료한 항목은 바꿀 수 없고, 잘못 바꿨으면 알림의 되돌리기나 ⌘Z로 돌려요.'],
  ['실수로 지웠는데 알림이 이미 사라졌으면',
    '이 창의 <b>삭제한 항목</b>에서 되살려요. 지운 항목은 원문 그대로 남아 있고, 언제 지웠는지도 함께 보여요. 줄의 <b>되살리기</b>를 누르면 원래 자리로 돌아가요. 정말 지우고 싶으면 ⋯ → <b>완전히 지우기</b>인데, 이건 되돌릴 수 없어서 한 번 더 물어봐요. 저절로 사라지는 건 없어요.'],
  ['프로젝트 이름을 바꾸고 싶으면',
    '프로젝트 탭에서 그 프로젝트를 열고 제목 옆 ⋯ → <b>이름 바꾸기</b>를 눌러요. 제목 자리가 입력칸이 되고 Enter로 저장해요. 그 프로젝트의 업무·확인 대기·결정·아이디어·회의·주간요약이 한 번에 같이 바뀌고, 하나라도 실패하면 아무것도 바뀌지 않아요. 알림의 <b>되돌리기</b>로 옛 이름으로 돌아가요. 지라 프로젝트는 이름이 지라 요약이라 여기서 못 바꿔요.'],
  ['잘못 눌렀을 때는',
    '완료·삭제·보고 제외는 아래 알림의 <b>되돌리기</b>로 바로 취소할 수 있어요. <b>⌘Z</b>도 같은 일을 하고(우선순위·기한 변경, 종류 바꾸기도 대상이에요), <b>⌘⇧Z</b>로 다시 실행해요.'],
  ['결과 한 줄은 왜 적나요',
    '완료한 업무에 적은 한 줄이 주간요약 문장으로 그대로 올라가요. 금요일에 다시 쓰지 않아도 돼요.'],
  ['보고 문장을 수정하면 원본 업무도 바뀌나요',
    '아니요. 보고 문장과 원본 기록은 따로 남아요. 원본이 바뀌면 수정 제안으로만 알려 주고, 직접 적용하기 전에는 고쳐 둔 문장을 바꾸지 않아요.'],
  ['자잘한 업무는 어떻게 빼나요',
    '주간요약에서 문장의 <b>제외</b>를 누르면 복사할 내용에서 빠져요. 원본은 업무 기록에 남고 언제든 보고로 되돌릴 수 있어요.'],
  ['주간요약 슬랙 글에 지라 상태를 같이 보내려면',
    '슬랙 미리보기 위 <b>지라 정보</b> 칩을 켜면 프로젝트 줄 끝에 지라 상태와 배포 버전이 괄호로 붙어요(기본은 꺼져 있어요). 지라 번호는 붙지 않고, 앱이 지라를 직접 읽고 있을 때만 붙어요.'],
  ['확인 대기는 뭔가요',
    '다른 사람의 답을 기다리는 항목이에요. 언제까지 답을 받아야 하는지는 <b>답변 받을 날</b>에 적어요. 할 일 쪽에서 "이 답변을 기다리는 중"으로 연결해 두면 답이 오는 순간 알려 줘요.'],
  ['확인 대기를 체크하면 무슨 일이 일어나나요',
    '체크한 줄이 그 자리에서 <b>다음은?</b> 줄로 바뀌어서 다음에 뭘 할지 물어봐요 — <b>후속 할 일</b>·<b>결정으로 남기기</b>·<b>답변 한 줄 남기기</b>·<b>닫기</b> 중에서 골라요. 체크 자체는 바로 저장되고(⌘Z로 되돌릴 수 있어요), 이 줄은 제안일 뿐이라 그냥 넘어가도 돼요.'],
  ['결정에 자세한 설명을 남기고 싶으면',
    '결정 상세 카드에 <b>내용</b> 칸이 있어요(최대 4,000자). 정책을 한 줄로 다 못 적을 때 여기에 풀어 적어요. 고치면 바로 저장되고, 이 화면에서만 보이고 주간요약이나 슬랙 글에는 나가지 않아요.'],
  ['배포일이 다가오면 알려주나요',
    "열린 업무가 있는 프로젝트의 지라 버전이 3일 안에 배포되거나 배포일이 지났으면, 왼쪽 레일 <b>리마인드</b> 카드 맨 위에 프로젝트 이름과 '배포 3일 전'처럼 남은 날짜가 떠요. 눌러서 바로 그 프로젝트로 가고, 배포되거나 업무가 다 끝나면 저절로 사라져요."],
  ['머리줄의 "○일 전 기준" 같은 표시는 뭔가요',
    '슬랙·캘린더·지라 자동 동기화가 최근에 못 돌았다는 뜻이에요. 그 글자를 누르면 이 창의 <b>상태</b>에서 그 자동화 줄이 바로 보여요. 톱니바퀴에도 같은 뜻의 점이 떠요 — <b>주황 점</b>은 자동 동기화가 낡았다는 뜻, <b>빨간 점</b>은 지금 실패하고 있다는 뜻이에요(둘 다 해당하면 빨간 점이 우선이에요).'],
  ['슬랙에서 수집한 게 잘 들어왔는지 보려면',
    '설정 > 상태의 <b>슬랙 캡처</b> 줄 아래에 가장 최근 수집 결과가 요약돼요 — 본 메시지 수와 등록·중복·건너뜀 개수를 보여 주고, 건너뛴 게 있으면 어떤 문구였는지도 몇 개 함께 적어 줘요. 로그를 따로 열지 않아도 무엇이 왜 안 들어왔는지 바로 알 수 있어요.'],
  ['지라 번호가 안 보이는데 어디서 보나요',
    '화면 대부분은 지라 번호 대신 요약(제목)만 보여줘요. 번호가 필요하면 항목 상세의 <b>프로젝트</b> 값, 프로젝트 탭 오른쪽의 <b>열린 항목 N</b> 줄, 또는 마우스를 올렸을 때 뜨는 설명에서 볼 수 있어요. 검색(⌘K)은 번호로 찾아도 돼요.'],
];

function renderSettingsGuide() {
  const view = document.getElementById('settingsGuideView');
  if (view.dataset.rendered) return;
  view.dataset.rendered = 'true';
  const doc = document.createElement('div');
  doc.className = 'd-faq';
  SETTINGS_FAQ.forEach(([question, answer]) => {
    const q = document.createElement('div');
    q.className = 'q';
    q.textContent = question;
    const a = document.createElement('div');
    a.className = 'a';
    // 문답은 코드에 적힌 고정 문장이다(사용자 입력이 섞이지 않는다).
    a.innerHTML = answer;
    doc.append(q, a);
  });
  view.appendChild(doc);

  // 접속 암호는 이 맥에서 열었을 때만 꺼낼 수 있다(다른 기기에서는 버튼 자체를 두지 않는다).
  if (['localhost', '127.0.0.1'].includes(location.hostname)) {
    const section = document.createElement('div');
    section.className = 'd-dsec';
    const label = document.createElement('span');
    label.className = 'lbl';
    label.textContent = '다른 기기에서 열기';
    const access = document.createElement('button');
    access.type = 'button';
    access.className = 'd-btn';
    access.textContent = '접속 암호 복사';
    access.addEventListener('click', async () => {
      try {
        const result = await (await request('/api/access-token')).json();
        if (!result.token) { showNotice('다른 기기 접속이 아직 설정되지 않았어요'); return; }
        await navigator.clipboard.writeText(result.token);
        showNotice('암호를 복사했어요 · 다른 기기에서 사용자 이름은 workspace를 넣어 주세요');
      } catch { showNotice('암호를 복사하지 못했어요', true); }
    });
    const hint = document.createElement('div');
    hint.className = 'd-hint';
    hint.textContent = '같은 와이파이·Tailscale에서 이 주소를 열고, 사용자 이름은 workspace를 넣으면 돼요.';
    section.append(label, access, hint);
    view.appendChild(section);
  }
}

// ---------- 설정 > 삭제한 항목 ----------
// 삭제는 확인창 없이 바로 실행되고 되돌릴 길은 알림의 `삭제 실행 취소`·⌘Z뿐이라, 시간이 지나
// 알아차리면 닫혀 있었다. 여기서 원문이 남아 있는 목록을 보고 되살리거나 완전히 지운다.
// 자동 영구 삭제는 없다(DECISIONS) — 이 목록에서 사람이 고른 것만 지운다.
// 설정 창을 열 때마다 새로 읽고(GET), 탭 이름의 개수도 그 값이다.
let settingsTrash = null;

function settingsTrashLabel() {
  const tab = document.getElementById('settingsTrashTab');
  if (!tab) return;
  const count = settingsTrash ? settingsTrash.length : 0;
  tab.textContent = count ? `삭제한 항목 ${count}` : '삭제한 항목';
}

async function settingsTrashLoad() {
  try {
    const data = await (await request('/api/track/trash')).json();
    settingsTrash = Array.isArray(data.items) ? data.items : [];
  } catch {
    settingsTrash = [];
  }
  settingsTrashLabel();
  return settingsTrash;
}

// `9월 21일 22:10에 삭제` — 언제 지운 것인지가 되살릴지 판단하는 값이라 시각까지 적는다.
function settingsTrashWhen(value) {
  const when = value ? new Date(value) : null;
  if (!when || Number.isNaN(when.getTime())) return '언제 삭제했는지 몰라요';
  const time = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
  return `${when.getMonth() + 1}월 ${when.getDate()}일 ${time}에 삭제`;
}

// 목록에서 한 줄을 빼고 다시 그린다 — 되살리기·완전히 지우기가 같은 길을 쓴다.
function settingsTrashDrop(id) {
  settingsTrash = (settingsTrash || []).filter(entry => entry.id !== id);
  settingsTrashLabel();
  renderSettingsTrash();
}

// `완전히 지우기`는 되돌릴 수 없으니 확인 줄을 한 번 세운다(창을 띄우지 않고 그 자리에서).
function settingsTrashConfirm(entry, acts) {
  const ask = document.createElement('span');
  ask.className = 'ta is-ask';
  const words = document.createElement('span');
  words.className = 'tq';
  words.textContent = '되살릴 수 없어요';
  const yes = document.createElement('button');
  yes.type = 'button';
  yes.className = 'd-btn sm dng';
  yes.textContent = '지우기';
  const no = document.createElement('button');
  no.type = 'button';
  no.className = 'd-btn sm';
  no.textContent = '취소';
  no.addEventListener('click', () => { ask.replaceWith(acts); });
  yes.addEventListener('click', async () => {
    yes.disabled = true;
    try {
      await request('/api/track/trash-purge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: entry.id }) });
    } catch { yes.disabled = false; return; }
    settingsTrashDrop(entry.id);
    showNotice(`완전히 지웠어요 · ${entry.description}`);
  });
  ask.append(words, yes, no);
  acts.replaceWith(ask);
  yes.focus();
}

function settingsTrashRow(entry) {
  const row = document.createElement('div');
  row.className = 'd-trow';

  const main = document.createElement('div');
  main.className = 'tm';
  const line = document.createElement('div');
  line.className = 'tl';
  const kind = document.createElement('span');
  kind.className = 'kd';
  kind.textContent = entry.typeLabel || '항목';
  const text = document.createElement('span');
  text.className = 'tx';
  text.textContent = entry.description || '(문구가 남아 있지 않아요)';
  text.title = entry.description || '';
  line.append(kind, text);
  // 프로젝트는 다른 줄과 같은 표기(`· ● 이름`)다 — 지라 프로젝트는 요약만 적힌다(서버가 정한다).
  if (entry.project) {
    const tag = document.createElement('span');
    tag.className = 'd-inproj';
    tag.append('· ', uiProjectDot(entry.projectKey || entry.project), entry.project);
    line.appendChild(tag);
  }
  const when = document.createElement('div');
  when.className = 'tw';
  when.textContent = settingsTrashWhen(entry.deletedAt);
  main.append(line, when);
  row.appendChild(main);

  const acts = document.createElement('span');
  acts.className = 'ta';
  const restore = document.createElement('button');
  restore.type = 'button';
  restore.className = 'd-btn sm';
  restore.textContent = '되살리기';
  restore.setAttribute('aria-label', `${entry.description} — 되살리기`);
  restore.addEventListener('click', async () => {
    restore.disabled = true;
    try {
      await request('/api/track/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: entry.id }) });
    } catch { restore.disabled = false; return; }
    settingsTrashDrop(entry.id);
    await load();
    showNotice(`되살렸어요 · ${entry.description}`);
  });
  acts.append(restore, uiMoreButton(`${entry.description} — 더 보기`,
    () => [[{ label: '완전히 지우기', danger: true, onClick: () => settingsTrashConfirm(entry, acts) }]]));
  row.appendChild(acts);
  return row;
}

function renderSettingsTrash() {
  const view = document.getElementById('settingsTrashView');
  if (!view) return;
  view.replaceChildren();
  if (settingsTrash === null) {
    view.insertAdjacentHTML('beforeend', '<div class="d-empty">불러오는 중이에요…</div>');
    return;
  }
  if (!settingsTrash.length) {
    view.insertAdjacentHTML('beforeend', '<div class="d-empty">삭제한 항목이 없어요.</div>');
    return;
  }
  settingsTrash.forEach(entry => view.appendChild(settingsTrashRow(entry)));
}

// ---------- 설정 열고 닫기 ----------
// 드문 작업이라 모달(<dialog>)이 맞다. Esc는 앱의 스택 하나로 처리하고(떠 있는 것 중 맨 위만
// 닫힌다), 닫으면 열었던 버튼으로 포커스가 돌아간다.
const settingsDialog = document.getElementById('settingsDialog');
let settingsReturnFocus = null;
let settingsEsc = null;

function settingsSetTab(tab) {
  settingsDialog.querySelectorAll('[data-settings-tab]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.settingsTab === tab));
  });
  document.getElementById('settingsStatusView').hidden = tab !== 'status';
  document.getElementById('settingsGuideView').hidden = tab !== 'guide';
  document.getElementById('settingsTrashView').hidden = tab !== 'trash';
  if (tab === 'guide') renderSettingsGuide();
  if (tab === 'status') renderAutomationStatus();
  if (tab === 'trash') renderSettingsTrash();
}

// 헤더의 톱니바퀴와 동기화 지연 경고가 함께 쓰는 한 길.
function settingsOpen(tab = 'status', focusKey = null) {
  settingsFocusKey = focusKey;
  if (settingsDialog.open) { settingsSetTab(tab); return; }
  settingsReturnFocus = document.activeElement;
  uiMenuClose();
  settingsDialog.showModal();
  settingsEsc = escPush(settingsClose);
  // 삭제한 항목은 열 때마다 새로 읽는다 — 탭 이름의 개수(`삭제한 항목 3`)도 이 값이다.
  settingsTrash = null;
  settingsTrashLabel();
  settingsSetTab(tab);
  settingsTrashLoad().then(() => {
    if (settingsDialog.open && document.getElementById('settingsTrashView')?.hidden === false) renderSettingsTrash();
  });
}

function settingsClose() {
  if (settingsEsc) { escDrop(settingsEsc); settingsEsc = null; }
  if (!settingsDialog.open) return;
  settingsDialog.close();
  const back = settingsReturnFocus;
  settingsReturnFocus = null;
  back?.focus?.();
}

// 브라우저가 스스로 닫으려 할 때(Esc)도 우리 길로 모은다 — 스택과 포커스 복귀가 어긋나지 않게.
settingsDialog.addEventListener('cancel', (event) => { event.preventDefault(); settingsClose(); });
document.getElementById('settingsBtn').addEventListener('click', () => settingsOpen('status', syncStale.length ? syncStale[0].key : null));
document.getElementById('settingsCloseBtn').addEventListener('click', settingsClose);
settingsDialog.querySelectorAll('[data-settings-tab]').forEach((button) => {
  button.addEventListener('click', () => settingsSetTab(button.dataset.settingsTab));
});

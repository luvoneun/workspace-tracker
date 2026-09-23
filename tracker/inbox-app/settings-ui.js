// 설정 창 한 벌 — 상태 탭(자동화 줄·로그 묶음·슬랙 처리 대장·앱 정보·문제 보고), 연동 탭(지라·슬랙·
// 캘린더·회의록을 하나씩 켜기), 도움말 탭(개념 사전 + 문답), 삭제한 항목 탭, 창 열고 닫기.
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
  // 연동을 하나도 켜지 않은 설치에는 자동화 줄이 아예 없다 — 그때는 "고장"이 아니라 "아직 안 켰다"이다.
  if (!automations.length) {
    view.insertAdjacentHTML('beforeend', '<div class="d-empty">켜 둔 자동화가 없어요 — 설정의 연동에서 켜요.</div>');
  } else {
    // "최근 실패 기록이 있음"과 "지금 문제임"은 다르다 — 예전엔 둘을 구분 안 해서,
    // 벌써 고쳐져서 마지막 실행이 정상이었는데도 몇 시간 전 실패 이력 때문에 계속
    // 빨간 점이 떠 있었다("이게 지금도 그런 건지 예전 건지 모르겠다"는 혼란의 원인).
    // 가장 최근 실행 자체가 실패였을 때만 "지금 문제"로 본다.
    [...automations]
      .sort((a, b) => (b.lastKind === 'fail' ? 1 : 0) - (a.lastKind === 'fail' ? 1 : 0))
      .forEach(a => view.appendChild(automationRow(a)));

    // 반응 필요(지라 댓글)는 자동화가 아니라 앱이 직접 읽는 것이라 목록 끝에 한 줄로 붙인다
    // (연결이 없으면 줄 자체가 없다 — 화면의 구역도 그때는 없다).
    const attention = typeof attentionStatusRow === 'function' ? attentionStatusRow() : null;
    if (attention) view.appendChild(attention);
  }

  // 맨 아래 조용한 앱 정보 줄 + 문제 보고. 값은 따로 읽어 오므로 자리를 먼저 세우고 나중에 채운다.
  view.appendChild(settingsAboutSection());
  settingsAboutLoad().then(() => { if (settingsDialog.open) settingsAboutFill(); });

  const focused = settingsFocusKey
    ? view.querySelector(`[data-automation="${CSS.escape(String(settingsFocusKey))}"]`)
    : null;
  settingsFocusKey = null;
  if (focused) { focused.classList.add('is-focus'); focused.scrollIntoView({ block: 'nearest' }); }
}

// ---------- 설정 > 상태 맨 아래: 앱 정보 · 새 버전 · 문제 보고 ----------
// 어떤 버전을 쓰고 있는지, 저장소에서 벗어났는지, 새 버전이 나왔는지를 조용한 한 줄로만 말한다.
// 앱이 스스로 업데이트를 돌리지는 않는다(DECISIONS 2026-09-23) — `업데이트.command`를 안내한다.
let settingsAbout = null;
let settingsIntegrations = null;

// `v` 접두는 무시하고 세 자리만 견준다. 둘 중 하나라도 모르면 "새 버전 없음"으로 본다.
function settingsVersionNewer(current, latest) {
  const parse = value => String(value || '').trim().replace(/^v/, '').split('.').map(part => Number(part) || 0);
  if (!String(current || '').trim() || !String(latest || '').trim()) return false;
  const now = parse(current);
  const next = parse(latest);
  for (let i = 0; i < 3; i += 1) if ((next[i] || 0) !== (now[i] || 0)) return (next[i] || 0) > (now[i] || 0);
  return false;
}

function settingsHasUpdate() {
  return !!(settingsAbout && settingsAbout.latest && settingsVersionNewer(settingsAbout.version, settingsAbout.latest.tag));
}

async function settingsAboutLoad() {
  try { settingsAbout = await (await request('/api/about')).json(); } catch { settingsAbout = null; }
  // 톱니바퀴의 점은 실패(빨강) > 낡음(주황) > 새 버전(파랑) 차례다 — 규칙은 ui.css가 정한다.
  document.getElementById('settingsBtn')?.classList.toggle('has-update', settingsHasUpdate());
  return settingsAbout;
}

// 문제 보고에 넣을 글. **업무 문장은 한 줄도 들어가지 않는다** — 버전·연동 상태·자동화 요약과
// 서버가 가려서 준 오류 줄뿐이다. 순수 함수라 그대로 테스트한다.
const SETTINGS_ON_WORD = on => (on ? '켜짐' : '꺼짐');
const SETTINGS_NOTES_WORD = { tiro: '티로', manual: '직접', other: '다른 앱' };

function settingsReportText({ about, integrations, automations, diagnostics, lead } = {}) {
  const info = about || {};
  const diag = diagnostics || {};
  const where = [info.channel === 'main' ? 'main' : null, info.gitRef || null].filter(Boolean).join(', ');
  const head = [
    `워크스페이스 ${info.version ? `v${info.version}` : '버전 모름'}${where ? ` (${where})` : ''}`,
    info.install === 'managed' ? '설치본' : '개발용',
    diag.os || '운영체제 모름',
    diag.node ? `Node ${String(diag.node).replace(/^v/, '')}` : 'Node 모름',
  ].join(' · ');
  const modified = Array.isArray(info.modified)
    ? (info.modified.length ? info.modified.join(', ') : '없음')
    : '모름';
  const uses = integrations
    ? [`지라 ${SETTINGS_ON_WORD(integrations.jira.enabled)}`, `슬랙 ${SETTINGS_ON_WORD(integrations.slack.enabled)}`,
      `캘린더 ${SETTINGS_ON_WORD(integrations.calendar.enabled)}`,
      `회의록 ${SETTINGS_NOTES_WORD[integrations.meetingNotes.mode] || '직접'}`].join(' · ')
    : '읽지 못했어요';
  const autos = (automations || []).length
    ? (automations || []).map(a => `${a.name} ${a.lastRunAt ? `${relativeTimeFrom(a.lastRunAt)} ${AUTOMATION_STATE_WORD[a.lastKind] || '실행'}` : '—'}`).join(', ')
    : '켠 자동화 없음';
  const lines = Array.isArray(diag.lines) ? diag.lines : [];
  return [
    ...(lead ? [lead] : []),
    head,
    `수정된 파일: ${modified}`,
    `연동: ${uses}`,
    `자동화 상태: ${autos}`,
    `최근 오류(${lines.length}줄):`,
    ...(lines.length ? lines : ['로그 없음']),
  ].join('\n');
}

// 문제 보고·연동 요청이 같이 쓰는 길: 값을 모아 클립보드에 넣는다.
async function settingsReportCopy(button, { lead = '', done = '복사했어요 — 슬랙으로 붙여 넣어 주세요' } = {}) {
  button.disabled = true;
  try {
    if (!settingsAbout) await settingsAboutLoad();
    if (!settingsIntegrations) await settingsIntegrationsLoad();
    let diagnostics = {};
    try { diagnostics = await (await request('/api/about/diagnostics')).json(); } catch { diagnostics = {}; }
    await navigator.clipboard.writeText(settingsReportText({
      about: settingsAbout, integrations: settingsIntegrations,
      automations: automationStatusCache, diagnostics, lead,
    }));
    showNotice(done);
  } catch {
    showNotice('복사하지 못했어요', true);
  }
  button.disabled = false;
}

const SETTINGS_UPDATE_HOW = ['이 앱 폴더의 업데이트.command를 더블클릭하세요', '처음이면 우클릭 → 열기'];

// 자리만 먼저 세운다(값은 settingsAboutFill이 채운다). 조용한 글자 한 줄 + 문제 보고 버튼.
function settingsAboutSection() {
  const section = document.createElement('div');
  section.className = 'd-dsec d-about';
  section.id = 'settingsAboutSec';

  const line = document.createElement('div');
  line.className = 'd-abline';
  line.id = 'settingsAboutLine';
  line.textContent = '앱 정보를 읽는 중이에요…';

  const files = document.createElement('div');
  files.className = 'd-abfiles';
  files.id = 'settingsAboutFiles';
  files.hidden = true;

  const update = document.createElement('div');
  update.className = 'd-abnew';
  update.id = 'settingsAboutNew';
  update.hidden = true;

  const how = document.createElement('div');
  how.className = 'd-abhow';
  how.id = 'settingsAboutHow';
  how.hidden = true;
  SETTINGS_UPDATE_HOW.forEach((text) => {
    const row = document.createElement('div');
    row.textContent = text;
    how.appendChild(row);
  });

  const report = document.createElement('button');
  report.type = 'button';
  report.className = 'd-btn sm';
  report.id = 'settingsReportBtn';
  report.textContent = '문제 보고';
  report.addEventListener('click', () => settingsReportCopy(report));

  const hint = document.createElement('div');
  hint.className = 'd-hint';
  hint.textContent = '버전·연동 상태·최근 오류만 복사해요(업무 내용은 들어가지 않아요).';

  section.append(line, files, update, how, report, hint);
  return section;
}

function settingsAboutFill() {
  const line = document.getElementById('settingsAboutLine');
  if (!line) return;
  const info = settingsAbout;
  line.replaceChildren();
  if (!info) { line.textContent = '앱 정보를 읽지 못했어요.'; return; }
  const parts = [`워크스페이스 ${info.version ? `v${info.version}` : '버전 모름'}`, info.install === 'managed' ? '설치본' : '개발용'];
  // 갈래는 main일 때만 적는다(stable은 기본이라 말할 것이 없다).
  if (info.channel === 'main') parts.push('main');
  line.appendChild(document.createTextNode(parts.join(' · ')));

  const changed = Array.isArray(info.modified) ? info.modified : [];
  const files = document.getElementById('settingsAboutFiles');
  if (changed.length) {
    line.appendChild(document.createTextNode(' · '));
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'd-ablink';
    toggle.textContent = `수정된 파일 ${changed.length}개`;
    toggle.setAttribute('aria-expanded', 'false');
    toggle.addEventListener('click', () => {
      const open = files.hidden;
      files.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
    });
    line.appendChild(toggle);
    files.replaceChildren();
    changed.forEach((name) => {
      const row = document.createElement('div');
      row.textContent = name;
      files.appendChild(row);
    });
  }

  const update = document.getElementById('settingsAboutNew');
  const how = document.getElementById('settingsAboutHow');
  if (!update || !how) return;
  update.replaceChildren();
  update.hidden = !settingsHasUpdate();
  how.hidden = true;
  if (!settingsHasUpdate()) return;
  update.appendChild(document.createTextNode(`새 버전 ${info.latest.tag}이 있어요 · `));
  const link = document.createElement('button');
  link.type = 'button';
  link.className = 'd-ablink';
  link.textContent = '업데이트 방법';
  link.setAttribute('aria-expanded', 'false');
  link.addEventListener('click', () => {
    how.hidden = !how.hidden;
    link.setAttribute('aria-expanded', String(!how.hidden));
  });
  update.appendChild(link);
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

// ---------- 설정 > 연동 ----------
// 연결은 한 번에 하나씩, 그 줄에서 그 자리에 펼쳐서 한다. 토큰 칸은 늘 `password`이고
// 저장한 뒤에는 화면 어디에도 다시 나오지 않는다(서버도 있음/없음만 알려 준다).
// 저장은 `POST /api/integrations/save` 하나뿐이고, 그 라우트만 workspace.config.json을 쓴다.
const JIRA_TOKEN_URL = 'https://id.atlassian.com/manage-profile/security/api-tokens';
// 새로 설치하면 `workspace.config.example.json`의 예시값이 그대로 들어 있다. 그 글자를 입력칸에
// 미리 채우면 사람이 자기 주소를 적은 줄 알고 `연결`을 눌러 실패한다 — 빈 칸으로 보고 예시는
// placeholder로만 보여 준다.
const SETTINGS_EXAMPLE_VALUES = ['https://내회사.atlassian.net', '나@내회사.com'];
const settingsRealValue = value => (SETTINGS_EXAMPLE_VALUES.includes(String(value || '').trim()) ? '' : value);
const SETTINGS_SLACK_MORE = [['align', '맞춰야 할 것'], ['someday', '언젠가 할 것'], ['waiting', '기다리는 것']];
const SETTINGS_NOTES_MODES = [['tiro', '티로'], ['manual', '직접 옮겨서'], ['other', '다른 것']];

async function settingsIntegrationsLoad() {
  try { settingsIntegrations = await (await request('/api/integrations')).json(); }
  catch { settingsIntegrations = null; }
  return settingsIntegrations;
}

// 이름 있는 입력 한 칸. 토큰은 `type: 'password'`로만 만든다.
function settingsField(label, options = {}) {
  const wrap = document.createElement('label');
  wrap.className = 'd-ifield';
  const name = document.createElement('span');
  name.className = 'lb';
  name.textContent = label;
  const input = document.createElement('input');
  input.type = options.type || 'text';
  input.className = 'd-din';
  if (options.placeholder) input.placeholder = options.placeholder;
  if (options.value) input.value = options.value;
  wrap.append(name, input);
  if (options.hint) {
    const hint = document.createElement('span');
    hint.className = 'd-hint';
    hint.textContent = options.hint;
    wrap.appendChild(hint);
  }
  return { wrap, input };
}

// 줄 하나의 뼈대: 이름 · 상태 | 버튼 / 그 아래 펼쳐지는 자리 + 조용한 한 마디.
function settingsIntegrationShell(kind, name, stateText) {
  const row = document.createElement('div');
  row.className = 'd-intg';
  row.dataset.integration = kind;
  const top = document.createElement('div');
  top.className = 'd-intgtop';
  const title = document.createElement('span');
  title.className = 'nm';
  title.textContent = name;
  const state = document.createElement('span');
  state.className = 'st';
  state.textContent = stateText;
  top.append(title, state);
  const body = document.createElement('div');
  body.className = 'd-intgbody';
  body.hidden = true;
  row.append(top, body);
  return { row, top, state, body };
}

function settingsErrorLine() {
  const error = document.createElement('p');
  error.className = 'd-derr';
  error.setAttribute('role', 'alert');
  return error;
}

// 저장 결과를 화면에 옮긴다. 켜고 끄는 값은 서버가 뜰 때 읽으므로 설치본에서는 서버가 스스로
// 다시 켜지고(응답의 `restart`), 개발용에서는 다시 켜 달라고만 말한다.
async function settingsIntegrationApplied(result, done) {
  const view = document.getElementById('settingsIntegrationsView');
  if (!result || result.restart !== true) {
    showNotice(`${done} · 서버를 다시 켜면 적용돼요`);
    await renderSettingsIntegrations();
    return;
  }
  if (view) {
    view.replaceChildren();
    view.insertAdjacentHTML('beforeend', '<div class="d-empty">적용하는 중… 앱을 다시 켜요</div>');
  }
  if (!await settingsWaitForServer()) {
    showNotice('앱이 다시 켜지지 않았어요 — 잠시 뒤 새로고침해 주세요', true);
    return;
  }
  showNotice(done);
  if (typeof load === 'function') await load();
  await renderSettingsIntegrations();
}

// 다시 뜰 때까지 1초마다 최대 20초. 도는 동안의 실패는 알리지 않으므로 request가 아니라 fetch다.
async function settingsWaitForServer(tries = 20) {
  for (let i = 0; i < tries; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    try { if ((await fetch('/api/about', { headers: { Accept: 'application/json' } })).ok) return true; } catch { /* 아직 안 떴다 */ }
  }
  return false;
}

// 저장 한 길. 실패하면 그 자리에 이유를 적는다. request()가 아니라 fetch를 쓴다 — 여기서 흔한 실패는
// 주소 오타·틀린 토큰 같은 "입력 검증"이라, request()가 모든 실패에 띄우는 `저장됐는지 확인하지 못했어요`
// 알림이 틀린 말이 된다(연결은 아예 시도되지 않았다). 이 저장은 업무 데이터 저장 길(mutation-store·되돌리기·
// 멱등 키)을 타지 않으므로 request()의 그 처리들도 필요 없다. 네트워크가 끊긴 경우만 알림으로 알린다.
async function settingsIntegrationSave(body, { error = null, button = null, done = '저장했어요' } = {}) {
  if (error) error.textContent = '';
  if (button) button.disabled = true;
  let result = null;
  try {
    const response = await fetch('/api/integrations/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    let data = null;
    try { data = await response.json(); } catch { data = null; }
    if (!response.ok || !data || data.ok === false) {
      if (error) error.textContent = (data && typeof data.error === 'string' && data.error) || '저장하지 못했어요.';
      if (button) button.disabled = false;
      return null;
    }
    result = data;
  } catch {
    if (error) error.textContent = '서버에 닿지 못했어요 — 앱이 켜져 있는지 확인해 주세요.';
    showNotice('저장됐는지 확인하지 못했어요. 입력한 내용은 그대로 있어요', true);
    if (button) button.disabled = false;
    return null;
  }
  await settingsIntegrationApplied(result, done);
  return result;
}

// 지라 — ① 주소 ② 이메일 ③ API 토큰. `연결`을 누르면 서버가 지라에 한 번 읽어 보고,
// 성공하면 표시 이름만 돌려준다(이메일·토큰은 어디에도 다시 나오지 않는다).
function settingsJiraRow(data) {
  const jira = data.jira || {};
  const connected = !!(jira.enabled && jira.hasToken && jira.siteUrl);
  const host = String(jira.siteUrl || '').replace(/^https?:\/\//, '');
  const { row, top, body } = settingsIntegrationShell('jira', '지라', connected ? `연결됨 · ${host}` : '연결 안 됨');

  const act = document.createElement('button');
  act.type = 'button';
  act.className = 'd-btn sm';
  act.textContent = connected ? '해제' : '연결하기';
  top.appendChild(act);

  if (connected) {
    act.addEventListener('click', () => settingsIntegrationSave({ jira: { enabled: false } },
      { button: act, done: '연결을 해제했어요 — 토큰 파일은 그대로 있어요' }));
    return row;
  }

  const site = settingsField('지라 주소', { placeholder: 'https://회사.atlassian.net', value: settingsRealValue(jira.siteUrl) });
  const email = settingsField('이메일', { placeholder: '나@회사.com', value: settingsRealValue(jira.email) });
  const token = settingsField('API 토큰', { type: 'password', placeholder: '붙여 넣기' });
  const link = document.createElement('a');
  link.className = 'd-ablink';
  link.href = JIRA_TOKEN_URL;
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.textContent = 'Atlassian 토큰 만들기 ↗';
  const error = settingsErrorLine();
  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'd-btn pri sm';
  go.textContent = '연결';
  go.addEventListener('click', async () => {
    const result = await settingsIntegrationSave({
      jira: { enabled: true, siteUrl: site.input.value, email: email.input.value, token: token.input.value },
    }, { error, button: go, done: '지라에 연결했어요' });
    if (result && result.jira) showNotice(`${result.jira.displayName || '내'}님으로 연결됐어요`);
  });
  body.append(site.wrap, email.wrap, token.wrap, link, error, go);
  act.addEventListener('click', () => { body.hidden = !body.hidden; if (!body.hidden) site.input.focus(); });
  return row;
}

// 슬랙 수집 — ① 비공개 채널 만들기 ② 토큰 ③ 채널 링크. 채널 넷 중 `todo` 하나만 이 흐름으로 받고,
// 나머지 셋은 `더 연결(선택)` 아래 같은 칸이다.
function settingsSlackRow(data) {
  const slack = data.slack || {};
  const todo = (slack.channels && slack.channels.todo) || {};
  const connected = !!(slack.enabled && slack.hasToken && todo.id);
  // 요약 줄에는 기본 채널 하나만 적되, 선택 채널이 더 걸려 있으면 `외 N개`로 있다는 것만 알린다.
  const moreChannels = ['align', 'someday', 'waiting'].filter(key => slack.channels && slack.channels[key] && slack.channels[key].id).length;
  const summary = `${todo.name || '채널'}${moreChannels ? ` 외 ${moreChannels}개` : ''}`;
  const { row, top, body } = settingsIntegrationShell('slack', '슬랙 수집', connected ? `연결됨 · ${summary}` : '연결 안 됨');

  const act = document.createElement('button');
  act.type = 'button';
  act.className = 'd-btn sm';
  act.textContent = connected ? '해제' : '연결하기';
  top.appendChild(act);

  // 갈래 나누기·스레드 읽기는 Claude Code가 하는 일이라 줄 아래에 사실만 적는다.
  const note = document.createElement('div');
  note.className = 'd-intgnote';
  note.textContent = `메시지 분류·스레드 읽기는 Claude Code가 필요해요 · ${data.claude ? '설치돼 있어요' : '설치 안 됨 — 설치하면 켜져요'}`;
  row.appendChild(note);

  if (connected) {
    act.addEventListener('click', () => settingsIntegrationSave({ slack: { enabled: false } },
      { button: act, done: '연결을 해제했어요 — 토큰 파일은 그대로 있어요' }));
    return row;
  }

  const step = document.createElement('div');
  step.className = 'd-hint';
  step.textContent = '나만 있는 비공개 채널을 슬랙에서 만들어요(이름은 아무거나).';
  const token = settingsField('토큰', { type: 'password', placeholder: '붙여 넣기', hint: '팀 슬랙 앱에서 받은 본인 토큰 — 채팅·메일로 보내지 마세요' });
  const channel = settingsField('채널 링크 붙여 넣기', { placeholder: 'https://회사.slack.com/archives/C0123…' });
  const more = document.createElement('details');
  more.className = 'd-dsec d-dadd';
  const moreHead = document.createElement('summary');
  moreHead.className = 'lbl';
  moreHead.textContent = '더 연결(선택)';
  more.appendChild(moreHead);
  const extra = SETTINGS_SLACK_MORE.map(([key, label]) => {
    const field = settingsField(label, { placeholder: '채널 링크나 ID' });
    more.appendChild(field.wrap);
    return [key, field.input];
  });
  const error = settingsErrorLine();
  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'd-btn pri sm';
  go.textContent = '연결';
  go.addEventListener('click', async () => {
    const channels = { todo: channel.input.value };
    extra.forEach(([key, input]) => { if (input.value) channels[key] = input.value; });
    const result = await settingsIntegrationSave({ slack: { enabled: true, token: token.input.value, channels } },
      { error, button: go, done: '슬랙 채널에 연결했어요' });
    const info = result && result.slack && result.slack.channels && result.slack.channels.todo;
    if (info) {
      showNotice(info.isPrivate
        ? `${info.name} · 비공개 · 잘 읽혀요`
        : `${info.name} · 공개 채널이에요 — 나만 보는 채널을 권해요`, !info.isPrivate);
    }
  });
  body.append(step, token.wrap, channel.wrap, more, error, go);
  act.addEventListener('click', () => { body.hidden = !body.hidden; if (!body.hidden) token.input.focus(); });
  return row;
}

// 캘린더 — 앱이 직접 연결하지 않는다. Claude Code에서 구글 캘린더를 붙인 뒤 여기서 켜기만 한다.
function settingsCalendarRow(data) {
  const on = !!(data.calendar && data.calendar.enabled);
  const { row, top, body } = settingsIntegrationShell('calendar', '캘린더', on ? '연결됨' : '연결 안 됨');
  const act = document.createElement('button');
  act.type = 'button';
  act.className = 'd-btn sm';
  act.textContent = on ? '끄기' : '연결하기';
  if (!on && !data.claude) act.disabled = true;
  top.appendChild(act);

  const hint = document.createElement('div');
  hint.className = 'd-hint';
  hint.textContent = 'Claude Code에서 구글 캘린더를 연결(/mcp)한 뒤 여기서 켜요.';
  const error = settingsErrorLine();
  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'd-btn pri sm';
  go.textContent = '켜기';
  go.addEventListener('click', () => settingsIntegrationSave({ calendar: { enabled: true } },
    { error, button: go, done: '캘린더를 켰어요' }));
  body.append(hint, error, go);

  if (!data.claude) {
    const note = document.createElement('div');
    note.className = 'd-intgnote';
    note.textContent = 'Claude Code가 필요해요';
    row.appendChild(note);
  }
  if (on) act.addEventListener('click', () => settingsIntegrationSave({ calendar: { enabled: false } }, { button: act, done: '캘린더를 껐어요' }));
  else act.addEventListener('click', () => { body.hidden = !body.hidden; });
  return row;
}

// 회의록 — 티로로 가져올지, 직접 옮겨 쓸지, 다른 앱을 쓰는지 셋 중 하나를 고른다.
function settingsNotesRow(data) {
  const notes = data.meetingNotes || { mode: 'manual', name: '' };
  const label = notes.mode === 'tiro' ? '티로 연결됨' : (notes.mode === 'other' ? `${notes.name} 쓰는 중` : '직접 옮겨서 사용 중');
  const { row, body } = settingsIntegrationShell('notes', '회의록', label);
  body.hidden = false;

  const error = settingsErrorLine();
  const seg = document.createElement('span');
  seg.className = 'd-seg';
  seg.setAttribute('role', 'radiogroup');
  seg.setAttribute('aria-label', '회의록 쓰는 방법');
  const other = document.createElement('div');
  other.className = 'd-intgother';
  other.hidden = notes.mode !== 'other';

  SETTINGS_NOTES_MODES.forEach(([mode, text]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(mode === notes.mode));
    button.textContent = text;
    // 티로로 가져오는 일은 Claude Code가 한다 — 없으면 고를 수 없다.
    if (mode === 'tiro' && !data.claude) { button.disabled = true; button.title = 'Claude Code가 필요해요'; }
    button.addEventListener('click', () => {
      if (mode === 'other') { other.hidden = false; return; }
      settingsIntegrationSave({ meetingNotes: { mode } }, { error, button, done: mode === 'tiro' ? '티로로 가져올게요' : '직접 옮겨서 쓸게요' });
    });
    seg.appendChild(button);
  });

  const name = settingsField('어떤 앱인가요', { placeholder: '앱 이름', value: notes.name });
  const ask = document.createElement('button');
  ask.type = 'button';
  ask.className = 'd-btn sm';
  ask.textContent = '요청하기';
  ask.addEventListener('click', async () => {
    const wanted = String(name.input.value || '').trim();
    if (!wanted) { error.textContent = '어떤 앱인지 이름을 적어 주세요'; return; }
    await settingsIntegrationSave({ meetingNotes: { mode: 'other', name: wanted } }, { error, button: ask, done: '적어 뒀어요' });
    await settingsReportCopy(ask, { lead: `연동 요청: ${wanted}`, done: '요청 내용을 복사했어요 — 슬랙으로 붙여 넣어 주세요' });
  });
  other.append(name.wrap, ask);

  const hint = document.createElement('div');
  hint.className = 'd-hint';
  hint.textContent = '티로는 회의록을 자동으로 가져오고, 직접 옮겨서 쓰면 회의 정리 화면에 붙여 넣어요.';
  body.append(seg, other, hint, error);
  return row;
}

async function renderSettingsIntegrations() {
  const view = document.getElementById('settingsIntegrationsView');
  if (!view) return;
  view.replaceChildren();
  view.insertAdjacentHTML('beforeend', '<div class="d-empty">불러오는 중이에요…</div>');
  const data = await settingsIntegrationsLoad();
  view.replaceChildren();
  if (!data) {
    view.insertAdjacentHTML('beforeend', '<div class="d-empty">연동 상태를 불러오지 못했어요.</div>');
    return;
  }
  [settingsJiraRow, settingsSlackRow, settingsCalendarRow, settingsNotesRow].forEach(make => view.appendChild(make(data)));
  // 켠 자동화는 launchd에 따로 등록돼야 실제로 돈다 — 그 한 번은 업데이트.command가 해 준다.
  const foot = document.createElement('div');
  foot.className = 'd-hint d-intgfoot';
  foot.textContent = '켠 자동화를 등록하려면 앱 폴더의 업데이트.command를 한 번 실행해요.';
  view.appendChild(foot);
}

// ---------- 설정 > 도움말 ----------
// 맨 위 개념 한 줄 사전(9개) — 앱이 쓰는 말이 무슨 뜻인지 한 문장씩.
const SETTINGS_GLOSSARY = [
  ['할 일', '오늘 하기로 한 일. 맨 위 입력칸에 적으면 바로 오늘 목록에 서요.'],
  ['나중에 할 일', '언젠가 할 일. 머리줄의 서랍에 모이고, 거기서 오늘로 다시 가져와요.'],
  ['확인 대기', '남에게 물어 두고 답을 기다리는 것. 답이 오면 체크하고 다음 행동을 골라요.'],
  ['결정', '정해진 정책·방향. PRD에 반영했으면 체크해서 내려요.'],
  ['아이디어', '아직 할 일은 아닌 생각. 꺼내 쓸 때 할 일로 올려요.'],
  ['프로젝트', '항목을 묶는 단위. 지라 티켓이거나 직접 만든 이름이에요.'],
  ['회의 정리', '회의에서 나온 것을 할 일·확인 대기·결정으로 담는 자리.'],
  ['주간요약', '이번 주에 완료한 업무로 저절로 만들어지는 보고 문장.'],
  ['지난 프로젝트', '열린 항목이 없고 14일 넘게 조용한 프로젝트. 업무가 생기면 저절로 돌아와요.'],
];

// 문답은 **쓰는 순서**로 묶는다: 시작하기 → 매일 → 프로젝트·지라 → 주간요약 → 연동·자동화 → 문제가 생기면.
// 항목마다 `필요한 것`을 앞에 달아, 무엇이 무엇을 요구하는지 한눈에 보이게 한다(연동 탭과 같은 말).
// 답은 3~4문장을 넘기지 않는다 — 길면 아무도 안 읽는다.
const SETTINGS_FAQ = [
  ['시작하기', [
    ['무엇부터 하면 되나요', '없음',
      '맨 위 <b>오늘 할 일</b> 칸에 한 줄 적고 Enter를 누르면 끝이에요. 프로젝트·회의·주간요약은 필요해질 때 쓰면 돼요.'],
    ['연동은 꼭 켜야 하나요', '없음',
      '아니요. 지라·슬랙·캘린더·회의록은 전부 선택이에요. <b>설정 &gt; 연동</b>에서 하나씩 켜고, 켠 것만 자동으로 모아 와요. 하나도 켜지 않아도 직접 적는 기능은 전부 돼요.'],
  ]],
  ['매일', [
    ['오늘 하기 버거운 업무는 어떻게 미루나요', '없음',
      '업무 줄에 마우스를 올리면 <b>내일</b>·<b>나중에</b>가 나와요. 나중에로 보낸 업무는 머리줄의 <b>나중에 할 일</b> 서랍에 모이고, 거기서 <b>오늘로</b> 다시 가져와요.'],
    ['확인 대기를 체크하면 무슨 일이 일어나나요', '없음',
      '체크한 줄이 그 자리에서 <b>다음은?</b>으로 바뀌어 다음 행동을 물어봐요 — <b>후속 할 일</b>·<b>결정으로 남기기</b>·<b>답변 한 줄 남기기</b> 중에서 골라요. 체크 자체는 바로 저장되고, 제안은 무시해도 돼요.'],
    ['하루를 마감하거나 여러 개를 한 번에 정리하려면', '없음',
      '오늘 할 일 머리줄의 <b>⋯</b> → <b>오늘 정리</b>를 누르면 남은 업무에 <b>그대로·내일·나중에·완료</b>를 찍고 한 번에 저장해요(처음엔 전부 그대로예요). 같은 메뉴의 <b>여러 개 선택</b>은 고른 줄에 프로젝트·기한·삭제까지 한꺼번에 적용해요.'],
    ['회의는 어떻게 정리하나요', '캘린더 연결(없어도 직접 만들 수 있어요)',
      '왼쪽 <b>오늘 미팅</b>의 회의를 누르면 회의 정리 화면이 열려요. 초안을 고쳐 담고, 담은 뒤 결과 카드의 <b>실행 취소</b>로 되돌려요. 미팅 노트는 자동으로 오지 않고 <b>버튼을 눌렀을 때만</b> 가져와요.'],
    ['찾고 싶은 기록이 있으면', '없음',
      '<b>⌘K</b>(윈도는 Ctrl+K)로 검색을 열어요. 할 일·확인 대기·결정·아이디어·회의를 한 자리에서 찾고, 지라 번호로도 찾혀요.'],
    ['잘못 눌렀을 때는', '없음',
      '완료·삭제·보고 제외는 아래 알림의 <b>되돌리기</b>로 바로 취소해요. <b>⌘Z</b>도 같은 일을 하고 <b>⌘⇧Z</b>로 다시 실행해요. 지라에 실제로 쓰는 동작만 ⌘Z 대상이 아니에요.'],
  ]],
  ['프로젝트·지라', [
    ['프로젝트는 어떻게 지정하고 모아 보나요', '없음',
      '줄의 <b>⋯</b> → <b>프로젝트</b>에서 지라 이슈나 직접 만든 이름을 골라요. 모아 보려면 위쪽 <b>프로젝트</b> 탭으로 가요.'],
    ['프로젝트가 많아지면 어떻게 찾나요', '없음',
      '왼쪽 목록 위 <b>상태별 | 배포별</b>로 보기를 바꿔요. 8개가 넘으면 <b>프로젝트 찾기</b> 칸이 생기고, 조용해진 프로젝트는 <b>지난 프로젝트</b>로 저절로 내려가요. 사람이 폴더·태그를 붙이는 방식은 두지 않았어요.'],
    ['직접 만든 프로젝트에 지라를 붙이려면', '지라 연결',
      '프로젝트를 열면 <b>지라 티켓 연결</b>이 있어요. 번호나 주소를 붙여넣고 미리보기에서 <b>연결</b>을 누르면 표시만 붙어요. 고른 티켓이 <b>에픽</b>이면 <b>이 에픽으로 옮기기</b>가 하나 더 있고, 그건 항목·회의·주간요약 소속까지 통째로 옮겨요(옮긴 직후 알림의 되돌리기로만 되돌려요).'],
    ['지라와 연결된 프로젝트는 무엇이 보이나요', '지라 연결',
      '제목 아래 <b>지라 띠 카드</b>에 요약·담당자와 <b>상태·배포 버전·기한</b>이 서요. 눌러서 바로 바꿀 수 있는데 <b>지라에 실제로 반영</b>되니 확인 줄이 한 번 더 물어봐요(⌘Z로는 못 되돌려요). 하위 티켓은 보기만 해요.'],
    ['새 프로젝트를 만들면서 지라 티켓까지 만들 수 있나요', '지라 연결',
      '프로젝트 목록 머리의 <b>+</b>에서 이름과 직군을 고르면 <b>에픽 하나와 직군별 하위 티켓</b>을 만들어 줘요. 만들 목록을 다 보여 주고 한 번 더 물어본 다음에만 보내요 — 지라에 만든 건 되돌릴 수 없어요.'],
    ['프로젝트 이름을 바꾸고 싶으면', '없음',
      '제목 옆 <b>⋯</b> → <b>이름 바꾸기</b>예요. 직접 만든 프로젝트는 항목·회의·주간요약이 한 번에 같이 바뀌고, 지라 프로젝트는 <b>앱 안에서만 쓰는 별칭</b>이 붙어요(지라 원래 이름은 제목 아래에 늘 보여요).'],
  ]],
  ['주간요약', [
    ['주간요약은 어떻게 만들어지나요', '없음',
      '이번 주에 완료한 업무에서 저절로 만들어져요. 완료할 때 적은 <b>결과 한 줄</b>이 그대로 보고 문장이 되니 금요일에 다시 쓸 일이 없어요.'],
    ['문장을 고치거나 빼거나 합치려면', '없음',
      '문장 줄의 <b>수정</b>·<b>제외</b>를 쓰고, 여러 줄을 한 줄로 보내고 싶으면 ⋯ → <b>이 아래로 문장 모으기</b>로 넣어요. 손으로 고친 문장은 원본이 바뀌어도 덮어쓰지 않고 수정 제안으로만 알려 줘요.'],
    ['슬랙으로 보내려면', '없음',
      '머리줄의 <b>슬랙용으로 복사</b> 하나예요. 위의 칩으로 보낼 구역을 고르고, <b>지라 정보</b> 칩을 켜면 프로젝트 줄 끝에 지라 상태·배포 버전이 붙어요(기본은 꺼짐).'],
  ]],
  ['연동·자동화', [
    ['오늘 탭 맨 위의 `반응 필요`는 뭔가요', '지라 연결',
      '제가 답해야 하는 지라 댓글이 모이는 자리예요. <b>지라에 직접 물어봐서 가져와요(설정 &gt; 연동의 지라 연결만 있으면 됩니다). 슬랙 앱이나 다른 설정은 필요 없어요.</b> 제가 담당·보고·지켜보는 티켓 중 제 마지막 댓글 뒤에 남이 댓글을 달았으면 뜨고(최근 14일), 지라에 답글을 달면 다음 갱신에서 저절로 사라져요.'],
    ['`반응 필요`에 안 보이는 것도 있나요', '지라 연결',
      '제가 담당·보고·지켜보지 않는 티켓과 14일보다 오래된 댓글은 아직 못 봐요. <b>피그마 댓글은 여기로 자동으로 오지 않아요</b> — 피그마의 슬랙 알림을 나만 보는 채널(#my-todo)에 공유하면 슬랙 수집을 거쳐 <b>할 일</b>로 들어와요. 잘 읽고 있는지는 <b>상태</b> 탭 맨 아래 <b>반응 필요 · 지라 댓글</b> 줄에서 봐요.'],
    ['슬랙에서 수집한 게 잘 들어왔는지 보려면', '슬랙 연결 + Claude Code',
      '<b>상태</b> 탭의 <b>슬랙 캡처</b> 줄 아래에 최근 수집 결과가 요약돼요 — 본 메시지 수와 등록·중복·건너뜀 개수, 건너뛴 문구까지 보여요. 메시지를 갈래로 나누고 스레드를 읽는 일은 Claude Code가 해요.'],
    ['머리줄의 `○일 전 기준`이나 톱니 점은 뭔가요', '없음',
      '자동 동기화가 최근에 못 돌았다는 뜻이에요. <b>주황 점</b>은 낡음, <b>빨간 점</b>은 지금 실패 중, <b>파란 점</b>은 새 버전이 나왔다는 뜻이에요. 눌러서 <b>상태</b> 탭에서 그 줄을 바로 봐요.'],
  ]],
  ['문제가 생기면', [
    ['실수로 지웠는데 알림이 이미 사라졌으면', '없음',
      '<b>삭제한 항목</b> 탭에서 되살려요. 지운 항목은 원문 그대로 남고 저절로 사라지는 건 없어요. <b>완전히 지우기</b>만 되돌릴 수 없어서 한 번 더 물어봐요.'],
    ['앱이 이상하게 동작하면', '없음',
      '<b>상태</b> 탭 맨 아래 <b>문제 보고</b>를 누르면 버전·연동 상태·최근 오류 줄이 클립보드에 복사돼요. 업무 내용은 들어가지 않으니 그대로 슬랙에 붙여 넣어 주세요.'],
    ['새 버전은 어떻게 받나요', '없음',
      '새 버전이 나오면 <b>상태</b> 탭 맨 아래에 알려 줘요. 앱 폴더의 <b>업데이트.command</b>를 더블클릭하면 백업 → 받기 → 다시 시작까지 알아서 해요(앱이 스스로 업데이트하지는 않아요).'],
  ]],
];


function renderSettingsGuide() {
  const view = document.getElementById('settingsGuideView');
  if (view.dataset.rendered) return;
  view.dataset.rendered = 'true';
  const doc = document.createElement('div');
  doc.className = 'd-faq';

  const intro = document.createElement('div');
  intro.className = 'd-faqintro';
  intro.textContent = '처음 한 주는 할 일만 써도 충분해요 — 나머지는 필요할 때 켜요.';
  doc.appendChild(intro);

  // 개념 한 줄 사전 — 앱이 쓰는 말부터 한 문장씩 푼다.
  const words = document.createElement('div');
  words.className = 'd-words';
  SETTINGS_GLOSSARY.forEach(([term, meaning]) => {
    const row = document.createElement('div');
    row.className = 'd-word';
    const name = document.createElement('span');
    name.className = 'w';
    name.textContent = term;
    row.append(name, document.createTextNode(` — ${meaning}`));
    words.appendChild(row);
  });
  doc.appendChild(words);

  SETTINGS_FAQ.forEach(([group, entries]) => {
    const head = document.createElement('div');
    head.className = 'grp';
    head.textContent = group;
    doc.appendChild(head);
    entries.forEach(([question, need, answer]) => {
      const q = document.createElement('div');
      q.className = 'q';
      q.textContent = question;
      const tag = document.createElement('div');
      tag.className = 'need';
      tag.textContent = `필요한 것: ${need}`;
      const a = document.createElement('div');
      a.className = 'a';
      // 문답은 코드에 적힌 고정 문장이다(사용자 입력이 섞이지 않는다).
      a.innerHTML = answer;
      doc.append(q, tag, a);
    });
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
  document.getElementById('settingsIntegrationsView').hidden = tab !== 'integrations';
  document.getElementById('settingsGuideView').hidden = tab !== 'guide';
  document.getElementById('settingsTrashView').hidden = tab !== 'trash';
  if (tab === 'guide') renderSettingsGuide();
  if (tab === 'status') renderAutomationStatus();
  if (tab === 'integrations') renderSettingsIntegrations();
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

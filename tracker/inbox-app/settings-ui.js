// 설정 창 한 벌 — 상태 탭(자동화 줄·로그 묶음·슬랙 처리 대장·앱 정보·문제 보고), 연동 탭(지라·슬랙·
// 캘린더·회의록을 하나씩 켜기), 도움말 탭(개념 사전 + 문답), 삭제한 항목 탭, 창 열고 닫기.
// app.js에서 그대로 옮긴 코드다. app.js의 공용 부품(request·showNotice·uiIcon·escPush·escDrop·
// uiMenuClose·syncStale·latestData)과 jira-ui.js(jiraLiveNote·jiraLiveStatusRow)에 기댄다.
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
  // 지라 캐시 자동화(jira-sync)는 없앴다 — 지금은 자동화 목록이 아니라 이 조용한 줄 하나로만
  // 지라 직접 읽기 상태를 말한다(꺼져 있으면 줄 자체가 없다). 자동화가 하나도 없어도 이 줄만으로
  // "아직 안 켰다" 화면을 건너뛸 수 있어 자동화 개수와 별도로 먼저 계산해 둔다.
  const jiraLive = typeof jiraLiveStatusRow === 'function'
    ? jiraLiveStatusRow(latestData && latestData.jiraSync) : null;
  // 연동을 하나도 켜지 않은 설치에는 줄이 아예 없다 — 그때는 "고장"이 아니라 "아직 안 켰다"이다.
  if (!automations.length && !jiraLive) {
    view.insertAdjacentHTML('beforeend', '<div class="d-empty">켜 둔 자동화가 없어요 — 설정의 연동에서 켜요.</div>');
  } else {
    // "최근 실패 기록이 있음"과 "지금 문제임"은 다르다 — 예전엔 둘을 구분 안 해서,
    // 벌써 고쳐져서 마지막 실행이 정상이었는데도 몇 시간 전 실패 이력 때문에 계속
    // 빨간 점이 떠 있었다("이게 지금도 그런 건지 예전 건지 모르겠다"는 혼란의 원인).
    // 가장 최근 실행 자체가 실패였을 때만 "지금 문제"로 본다.
    [...automations]
      .sort((a, b) => (b.lastKind === 'fail' ? 1 : 0) - (a.lastKind === 'fail' ? 1 : 0))
      .forEach(a => view.appendChild(automationRow(a)));

    if (jiraLive) view.appendChild(jiraLive);

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
// 새 버전이 있으면 그 자리에서 `업데이트 받기`를 누를 수 있다(요청 파일 + launchd — 아래 "앱 안에서 업데이트 받기").
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

// 자리만 먼저 세운다(값은 settingsAboutFill이 채운다). 조용한 글자 한 줄 + (새 버전이면) 업데이트 받기 + 문제 보고 버튼.
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
  update.className = 'd-abwrap';
  update.id = 'settingsAboutUpdate';
  update.hidden = true;

  const report = document.createElement('button');
  report.type = 'button';
  report.className = 'd-btn sm';
  report.id = 'settingsReportBtn';
  report.textContent = '문제 보고';
  report.addEventListener('click', () => settingsReportCopy(report));

  const hint = document.createElement('div');
  hint.className = 'd-hint';
  hint.textContent = '버전·연동 상태·최근 오류만 복사해요(업무 내용은 들어가지 않아요).';

  section.append(line, files, update, report, hint);
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

  // 도는 업데이트가 있으면(창을 다시 열었거나 상태 탭이 다시 그려졌을 때) 그 진행을 그대로 이어 보여 준다.
  if (settingsUpdateRun) { settingsUpdatePaint(settingsUpdateRun.view); return; }
  const offer = settingsUpdateOffer(info);
  settingsUpdatePaint(offer ? { kind: 'offer', offer } : { kind: 'none' });
  settingsUpdateResume();
}

// ---------- 설정 › 상태: 앱 안에서 업데이트 받기(시안 J) ----------
// 서버는 업데이트를 직접 돌리지 않는다 — `POST /api/update`가 요청 표시 파일 하나를 쓰면 launchd가 실행기를 돌리고,
// 화면은 `GET /api/update/status`를 2초마다 읽어 진행 목록을 그린다. 5단계(앱 다시 시작) 동안 서버가 잠깐 없으면
// `다시 켜는 중…`으로 두고 계속 묻다가(최대 3분) 다시 응답하면 상태 파일로 마무리한다. 실패해도 스스로 되돌리지
// 않는다 — `이전 버전으로 되돌리기`(확인 줄 한 번)를 사람이 누른다(DECISIONS 2026-09-24).
const SETTINGS_UPDATE_STEPS = {
  update: ['고친 파일 확인', '데이터 백업', '새 버전 받기', '데이터 형식 변환', '앱 다시 시작', '잘 떴는지 확인'],
  rollback: ['코드 되돌리기', '데이터 되돌리기', '앱 다시 시작', '잘 떴는지 확인'],
};
const SETTINGS_UPDATE_POLL_MS = 2000;
const SETTINGS_UPDATE_GIVE_UP_MS = 3 * 60 * 1000;
const SETTINGS_UPDATE_WORDS = {
  quiet: '데이터는 먼저 백업하고 받아요. 1분쯤 걸려요.',
  restarting: '다시 켜는 중…',
  gone: '앱이 응답하지 않아요 — 업데이트.command를 더블클릭해 주세요',
  confirm: '이전 버전과 업데이트 직전 백업으로 돌아가요',
  unreachable: '서버에 닿지 못했어요 — 앱이 켜져 있는지 확인해 주세요.',
};
const SETTINGS_STEP_MARK = { done: ['done', '✓'], doing: ['now', '⟳'], todo: ['wait', '·'], failed: ['fail', '✕'] };
// { action, from, to, askedAt, downSince, timer, view } — 한 번에 하나만.
let settingsUpdateRun = null;

// 새 버전이 있으면 { available, label, changesUrl }. 서버가 판단한 `update`를 먼저 보고, 옛 서버면 태그로 견준다.
function settingsUpdateOffer(info) {
  if (!info) return null;
  if (info.update && typeof info.update === 'object') return info.update.available ? info.update : null;
  return info.latest && settingsVersionNewer(info.version, info.latest.tag)
    ? { available: true, label: info.latest.tag, changesUrl: null } : null;
}

function settingsHasUpdate() {
  return !!settingsUpdateOffer(settingsAbout);
}

const settingsBareVersion = value => String(value || '').trim().replace(/^v/, '');

// 진행 목록 한 벌 — 상태 파일의 단계가 있으면 그대로, 아직 없으면(요청만 한 참) 첫 단계를 도는 중으로.
function settingsUpdateSteps(action, status) {
  if (status && Array.isArray(status.steps) && status.steps.length) return status.steps;
  return (SETTINGS_UPDATE_STEPS[action] || SETTINGS_UPDATE_STEPS.update).map((name, index) => ({ name, state: index === 0 ? 'doing' : 'todo' }));
}

function settingsUpdateList(steps) {
  const list = document.createElement('ul');
  list.className = 'd-abprog';
  steps.forEach((step) => {
    const [cls, mark] = SETTINGS_STEP_MARK[step.state] || SETTINGS_STEP_MARK.todo;
    const row = document.createElement('li');
    row.className = cls;
    const icon = document.createElement('span');
    icon.className = 'ic';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = mark;
    row.append(icon, document.createTextNode(step.name));
    list.appendChild(row);
  });
  return list;
}

// 경로 한 줄 + 복사(설정 › 꾸미기의 `업데이트 파일`과 같은 값 — GET /api/about의 updateFile).
function settingsUpdateFileLine(file) {
  const path = file || (settingsAbout && settingsAbout.updateFile) || '';
  return path ? settingsCodeLine(path) : null;
}

// 상자 하나를 그린다. view.kind: none · offer · progress · done · failed · gone · blocked.
function settingsUpdateNodes(view) {
  const kind = view && view.kind;
  if (kind === 'offer') {
    const box = settingsEl('d-abupd');
    const text = document.createElement('span');
    text.className = 'tx';
    const label = view.offer.label;
    text.textContent = label && label !== 'main' ? `새 버전 ${label}이 있어요` : '새 버전이 있어요 (main)';
    box.append(text, settingsButton('업데이트 받기', 'd-btn sm pri', () => settingsUpdateAsk('update')));
    if (typeof view.offer.changesUrl === 'string' && /^https:\/\/github\.com\//.test(view.offer.changesUrl)) {
      box.appendChild(settingsOutLink('무엇이 바뀌었나요 ↗', view.offer.changesUrl, 'd-ablink'));
    }
    return [box, settingsEl('d-ismall d-abquiet', SETTINGS_UPDATE_WORDS.quiet)];
  }
  if (kind === 'progress') {
    const run = view.run;
    const head = run.action === 'rollback'
      ? '이전 버전으로 되돌리는 중이에요'
      : `v${settingsBareVersion(run.from) || '?'} → ${run.to ? `v${settingsBareVersion(run.to)}` : '새 버전'}`;
    const nodes = [settingsEl('d-abline d-abhead', head), settingsUpdateList(view.steps)];
    if (view.down) nodes.push(settingsEl('d-quiet d-abquiet', SETTINGS_UPDATE_WORDS.restarting));
    return nodes;
  }
  if (kind === 'done') {
    const box = settingsEl('d-abupd');
    const text = document.createElement('span');
    text.className = 'tx';
    const to = settingsBareVersion(view.to);
    text.textContent = view.action === 'rollback'
      ? `${to ? `v${to}으로` : '이전 버전으로'} 되돌렸어요`
      : `${to ? `v${to}으로` : '새 버전으로'} 바꿨어요`;
    // 화면 파일이 바뀌었으니 눌러서 다시 불러온다.
    box.append(text, settingsButton('새로고침', 'd-btn sm pri', () => { if (typeof location !== 'undefined') location.reload(); }));
    return [box];
  }
  if (kind === 'failed') {
    const box = settingsEl('d-abfail');
    const text = document.createElement('span');
    text.className = 'tx';
    const reason = view.message || '이유를 알 수 없어요';
    if (view.action === 'rollback') {
      text.textContent = `되돌리지 못했어요 — ${reason}`;
      box.appendChild(text);
      const nodes = [box, settingsEl('d-ismall d-abquiet', '업데이트.command를 더블클릭해 주세요')];
      const file = settingsUpdateFileLine(view.updateFile);
      if (file) nodes.push(file);
      return nodes;
    }
    text.textContent = `업데이트하지 못했어요 — ${reason}`;
    box.appendChild(text);
    if (!view.confirming) {
      box.appendChild(settingsButton('이전 버전으로 되돌리기', 'd-btn sm dng', () => settingsUpdatePaint({ ...view, confirming: true })));
      return [box];
    }
    const confirm = settingsEl('d-iconfirm');
    const words = document.createElement('span');
    words.className = 'tx';
    words.textContent = SETTINGS_UPDATE_WORDS.confirm;
    confirm.append(words,
      settingsButton('취소', 'd-btn sm', () => settingsUpdatePaint({ ...view, confirming: false })),
      settingsButton('되돌리기', 'd-btn sm dng', () => settingsUpdateAsk('rollback')));
    return [box, confirm];
  }
  if (kind === 'gone' || kind === 'blocked') {
    const box = settingsEl(kind === 'gone' ? 'd-abfail' : 'd-abupd is-plain');
    const text = document.createElement('span');
    text.className = 'tx';
    text.textContent = kind === 'gone' ? SETTINGS_UPDATE_WORDS.gone : (view.message || SETTINGS_UPDATE_WORDS.unreachable);
    box.appendChild(text);
    const file = view.showFile === false ? null : settingsUpdateFileLine(view.updateFile);
    return file ? [box, file] : [box];
  }
  return [];
}

function settingsUpdatePaint(view) {
  if (settingsUpdateRun) settingsUpdateRun.view = view;
  const box = document.getElementById('settingsAboutUpdate');
  if (!box) return;
  const nodes = settingsUpdateNodes(view);
  box.replaceChildren(...nodes);
  box.hidden = !nodes.length;
  // 확인 줄이 서면 초점은 `되돌리기`로(키보드로 바로 이어 가게).
  if (view && view.confirming) {
    const confirm = nodes[1];
    const yes = confirm && confirm.children && confirm.children[confirm.children.length - 1];
    if (yes && typeof yes.focus === 'function') yes.focus();
  }
}

function settingsUpdateStop() {
  if (settingsUpdateRun && settingsUpdateRun.timer) clearTimeout(settingsUpdateRun.timer);
  settingsUpdateRun = null;
}

// `업데이트 받기`·`되돌리기` — 서버에 요청 파일 하나를 부탁한다. 막히면 그 이유를, 이미 돌고 있으면 그 진행을 보여 준다.
async function settingsUpdateAsk(action) {
  const box = document.getElementById('settingsAboutUpdate');
  // 두 번 눌리지 않게 상자 안 버튼을 잠근다(HTMLCollection이라 펼쳐서 돈다).
  [...((box && box.children) || [])].forEach((node) => {
    [...(node.children || [])].forEach((kid) => { if (kid && kid.tagName === 'BUTTON') kid.disabled = true; });
  });
  let data = null;
  try {
    const response = await fetch('/api/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ action }),
    });
    try { data = await response.json(); } catch { data = null; }
  } catch { data = null; }
  if (!data || typeof data !== 'object') { settingsUpdatePaint({ kind: 'blocked', message: SETTINGS_UPDATE_WORDS.unreachable, showFile: false }); return; }
  if (data.ok) { settingsUpdateFollow(action, null, Date.now()); return; }
  if (data.reason === 'running') {
    settingsUpdateFollow((data.status && data.status.action) || (data.pending && data.pending.action) || action, data.status, 0);
    return;
  }
  settingsUpdatePaint({ kind: 'blocked', message: data.message, updateFile: data.updateFile, showFile: !!data.updateFile });
}

// 진행을 따라가기 시작한다. askedAt(방금 요청했으면 그 시각)보다 앞선 옛 상태 파일은 이번 것이 아니라 무시한다.
function settingsUpdateFollow(action, status, askedAt) {
  settingsUpdateStop();
  const offer = settingsUpdateOffer(settingsAbout);
  settingsUpdateRun = {
    action,
    from: (status && status.from) || (settingsAbout && settingsAbout.version) || '',
    to: (status && status.to) || (action === 'update' && offer && offer.label !== 'main' ? offer.label : ''),
    askedAt,
    downSince: null,
    timer: null,
    view: null,
  };
  settingsUpdatePaint({ kind: 'progress', run: settingsUpdateRun, steps: settingsUpdateSteps(action, status), down: false });
  settingsUpdateRun.timer = setTimeout(settingsUpdatePoll, SETTINGS_UPDATE_POLL_MS);
}

// 이번 실행의 상태인가 — 방금 요청했으면 그 뒤에 시작한 것만(같은 맥의 시계라 5초 여유만 둔다).
function settingsUpdateFresh(run, status) {
  if (!status) return false;
  if (!run.askedAt) return true;
  const started = Date.parse(status.startedAt || '');
  return Number.isFinite(started) && started >= run.askedAt - 5000;
}

async function settingsUpdatePoll() {
  const run = settingsUpdateRun;
  if (!run) return;
  run.timer = null;
  let data = null;
  try {
    const response = await fetch('/api/update/status', { headers: { Accept: 'application/json' } });
    if (response.ok) data = await response.json();
  } catch { data = null; }
  if (settingsUpdateRun !== run) return;
  const steps = (run.view && run.view.steps) || settingsUpdateSteps(run.action, null);
  if (!data || typeof data !== 'object') {
    // 앱이 다시 켜지는 중 — 조용히 기다리다 3분이 넘으면 업데이트.command로 안내한다.
    run.downSince = run.downSince || Date.now();
    if (Date.now() - run.downSince > SETTINGS_UPDATE_GIVE_UP_MS) {
      settingsUpdateStop();
      settingsUpdatePaint({ kind: 'gone' });
      return;
    }
    settingsUpdatePaint({ kind: 'progress', run, steps, down: true });
    run.timer = setTimeout(settingsUpdatePoll, SETTINGS_UPDATE_POLL_MS);
    return;
  }
  run.downSince = null;
  const status = settingsUpdateFresh(run, data.status) ? data.status : null;
  if (!status && run.askedAt && Date.now() - run.askedAt > SETTINGS_UPDATE_GIVE_UP_MS) {
    // 요청은 받았는데 3분이 지나도 실행기가 시작하지 않았다 — 업데이트.command로 안내한다.
    settingsUpdateStop();
    settingsUpdatePaint({ kind: 'gone', updateFile: data.updateFile });
    return;
  }
  if (status && status.from) run.from = status.from;
  if (status && status.to) run.to = status.to;
  if (status && status.state === 'done') {
    settingsUpdateStop();
    settingsUpdatePaint({ kind: 'done', action: status.action || run.action, to: status.to || run.to });
    return;
  }
  if (status && status.state === 'failed') {
    settingsUpdateStop();
    settingsUpdatePaint({ kind: 'failed', action: status.action || run.action, message: status.message, updateFile: data.updateFile });
    return;
  }
  settingsUpdatePaint({ kind: 'progress', run, steps: settingsUpdateSteps(run.action, status), down: false });
  run.timer = setTimeout(settingsUpdatePoll, SETTINGS_UPDATE_POLL_MS);
}

// 상태 탭을 열 때 한 번 — 다른 창에서 시작했거나 창을 닫았다 연 경우에도 도는 업데이트를 이어 보여 준다.
async function settingsUpdateResume() {
  let data = null;
  try {
    const response = await fetch('/api/update/status', { headers: { Accept: 'application/json' } });
    if (response.ok) data = await response.json();
  } catch { data = null; }
  if (!data || !data.running || settingsUpdateRun) return;
  settingsUpdateFollow((data.status && data.status.action) || (data.pending && data.pending.action) || 'update', data.status, 0);
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
// 카드 넷(슬랙 수집 → 지라 → 캘린더 → 회의록)을 접어 두고, `연결하기`를 누른 카드만 그 자리에서
// **한 번에 한 단계씩** 펼친다(카드 안 위저드 — 끝낸 단계는 단계 줄에서 `① 토큰 ✓`로 접힌다).
// 토큰 칸은 늘 `password`이고 저장한 뒤에는 화면 어디에도 다시 나오지 않는다(서버도 있음/없음만).
// 설정 파일을 쓰는 저장은 `POST /api/integrations/save` 하나뿐이다(토큰 확인·채널 만들기는 파일을 쓰지 않는다).
const JIRA_TOKEN_URL = 'https://id.atlassian.com/manage-profile/security/api-tokens';
// 새로 설치하면 `workspace.config.example.json`의 예시값이 그대로 들어 있다. 그 글자를 입력칸에
// 미리 채우면 사람이 자기 주소를 적은 줄 알고 `연결`을 눌러 실패한다 — 빈 칸으로 보고 예시는
// placeholder로만 보여 준다(지라 주소도 예시값이면 "팀 설정이 없다"로 본다).
const SETTINGS_EXAMPLE_VALUES = ['https://내회사.atlassian.net', '나@내회사.com'];
const settingsRealValue = value => (SETTINGS_EXAMPLE_VALUES.includes(String(value || '').trim()) ? '' : value);
// 팀 슬랙 앱 주소를 모르면 슬랙 앱 목록 화면으로 보낸다(서버가 주는 값과 같은 기본값).
const SETTINGS_SLACK_APPS_URL = 'https://api.slack.com/apps';
const settingsSlackAppUrl = value => (/^https:\/\/\S+$/.test(String(value || '').trim()) ? String(value).trim() : SETTINGS_SLACK_APPS_URL);
// 슬랙 채널 이름 규칙대로 화면에서 정리한다 — 소문자·숫자·`-`·`_`만 80자, 띄어쓰기는 `-`로.
const settingsSlackChannelName = value => String(value || '').trim().toLowerCase()
  .replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '').slice(0, 80);
// 슬랙 채널 넷 — 키 · 이름 · 들어가는 곳(굵은 글자 조각) · 만들어 줄 때의 기본 이름. 화면 차례도 이대로다.
const SETTINGS_SLACK_CHANNELS = [
  ['todo', '할 일', ['오늘 탭 ', ['b', '새로 들어온 것'], '으로 와요'], 'my-todo'],
  ['waiting', '기다리는 것', ['누가 답해 줘야 하는 것 → 오늘 탭 ', ['b', '확인 대기']], 'my-waiting'],
  ['align', '정해진 것', ['정책·결정 → ', ['b', '아이디어·결정'], ' 탭의 ', ['b', '결정']], 'my-align'],
  ['someday', '언젠가', ['나중에 참고할 거리 → ', ['b', '아이디어·결정'], ' 탭의 ', ['b', '아이디어']], 'my-someday'],
];
const SETTINGS_SLACK_BOT = '이건 Bot 토큰이에요 — 바로 위의 User OAuth Token(xoxp-)을 복사해 주세요';
const SETTINGS_SLACK_ASK = '워크스페이스 슬랙 앱에 저를 Collaborator로 추가해 주세요';
const SETTINGS_SLACK_TAKEN = '이미 있는 이름이에요 — 다른 이름을 적어 주세요';
// 목록 맨 아래 `각자 붙이는 법` — 슬랙·구글 캘린더·티로가 아닌 도구를 붙이는 안내(docs/연동.md의 "다른 앱을 쓰면").
const SETTINGS_OWN_TOOL_URL = 'https://github.com/luvoneun/workspace-tracker/blob/main/docs/%EC%97%B0%EB%8F%99.md#%EB%8B%A4%EB%A5%B8-%EC%95%B1%EC%9D%84-%EC%93%B0%EB%A9%B4';
const SETTINGS_CLAUDE_CONNECTORS = 'claude.ai/settings/connectors';
const SETTINGS_TIRO_ADD = 'claude mcp add --transport http tiro-mcp https://mcp.tiro.ooo/mcp';

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

function settingsErrorLine() {
  const error = document.createElement('p');
  error.className = 'd-derr';
  error.setAttribute('role', 'alert');
  return error;
}

// 굵은 글자·코드가 섞인 **코드에 적힌 고정 문장**을 innerHTML 없이 세운다.
// 조각은 문자열이거나 `[태그, 글]`(`b`·`code`·`i`) 또는 `['br']`이다.
function settingsRich(node, parts) {
  parts.forEach((part) => {
    if (typeof part === 'string') { node.appendChild(document.createTextNode(part)); return; }
    const [tag, text] = part;
    const piece = document.createElement(tag);
    if (text !== undefined) piece.textContent = text;
    node.appendChild(piece);
  });
  return node;
}

function settingsEl(className, text) {
  const node = document.createElement('div');
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function settingsButton(text, className, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = text;
  if (onClick) button.addEventListener('click', onClick);
  return button;
}

// 새 탭으로 여는 링크 — 모양은 버튼(`.d-btn`)이나 조용한 밑줄 글자(`.d-ablink`)다.
function settingsOutLink(text, href, className) {
  const link = document.createElement('a');
  link.className = className;
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = text;
  return link;
}

// Enter로 다음 단계 — 한글 조합 중의 Enter는 무시한다(빠른 추가 칸과 같은 규칙).
function settingsOnEnter(input, run) {
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing) return;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    run();
  });
}

async function settingsCopy(text, done = '복사했어요') {
  try {
    await navigator.clipboard.writeText(text);
    showNotice(done);
  } catch {
    showNotice('복사하지 못했어요', true);
  }
}

// 붙여 넣을 명령·주소 한 줄 + `복사`.
function settingsCodeLine(text) {
  const line = settingsEl('d-icode');
  const code = document.createElement('code');
  code.textContent = text;
  line.append(code, settingsButton('복사', 'd-btn xs', () => settingsCopy(text)));
  return line;
}

// 번호 매긴 단계 목록(캘린더·티로). 줄마다 `[글 조각들, (있으면) 붙일 노드]`.
function settingsNumbered(rows) {
  const list = document.createElement('ol');
  list.className = 'd-inum';
  rows.forEach(([parts, extra], index) => {
    const row = document.createElement('li');
    const num = document.createElement('span');
    num.className = 'n';
    num.textContent = String(index + 1);
    const body = document.createElement('span');
    body.className = 'c';
    // 글 조각은 한 줄로 이어지게 따로 묶는다(칸 자체는 세로로 쌓인다).
    const words = document.createElement('span');
    words.className = 'tx';
    body.appendChild(settingsRich(words, parts));
    if (extra) body.appendChild(extra);
    row.append(num, body);
    list.appendChild(row);
  });
  return list;
}

// ISO 시각 → `방금` / `N분 전` / `N시간 전` / `N일 전`. 못 읽으면 빈 글자.
function settingsAgo(value, at = Date.now()) {
  const then = new Date(value || '').getTime();
  if (!value || Number.isNaN(then)) return '';
  const minutes = Math.max(0, Math.round((at - then) / 60000));
  if (minutes < 1) return '방금';
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}시간 전` : `${Math.round(hours / 24)}일 전`;
}

// 저장 결과를 화면에 옮긴다. 켜고 끄는 값은 서버가 뜰 때 읽으므로 설치본에서는 서버가 스스로
// 다시 켜지고(응답의 `restart`), 개발용에서는 다시 켜 달라고만 말한다.
async function settingsIntegrationApplied(result, done) {
  const view = document.getElementById('settingsIntegrationsView');
  // `done`은 글자이거나, 저장 결과를 받아 글자를 돌려주는 함수다(캘린더: 오늘 일정 수).
  if (typeof done === 'function') done = done(result);
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
// `saved`는 저장이 성공한 뒤, 탭을 다시 그리기 **전에** 불린다(지라 ③ 확인처럼 다시 그린 카드에 남길 것).
async function settingsIntegrationSave(body, { error = null, button = null, done = '저장했어요', saved = null } = {}) {
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
  if (typeof saved === 'function') saved(result);
  await settingsIntegrationApplied(result, done);
  return result;
}

// 파일을 쓰지 않는 "묻기만 하는" 길(토큰 확인·채널 만들기). 토큰은 요청 본문으로만 나가고(이 맥 안),
// 응답·오류 문구에는 실리지 않는다. 실패는 `{ ok: false, error, code }`로 돌려준다.
async function settingsIntegrationAsk(url, body, fallback) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    let data = null;
    try { data = await response.json(); } catch { data = null; }
    if (!response.ok || !data || data.ok !== true) {
      return { ok: false, error: (data && typeof data.error === 'string' && data.error) || fallback, code: (data && data.code) || '' };
    }
    return data;
  } catch {
    return { ok: false, error: '서버에 닿지 못했어요 — 앱이 켜져 있는지 확인해 주세요.', code: '' };
  }
}

// 채널 하나를 만들어 달라고 서버에 부탁한다. 토큰을 비워 보내면(`채널 고치기`) 서버가 저장된 토큰을 쓴다.
async function settingsSlackCreateChannel(token, name) {
  return settingsIntegrationAsk('/api/integrations/slack-channel', { token, name }, '슬랙에서 채널을 만들지 못했어요');
}

async function settingsSlackTokenCheck(token) {
  return settingsIntegrationAsk('/api/integrations/slack-token-check', { token }, '토큰을 확인하지 못했어요');
}

// 단계 줄 `① 토큰 ─ ② 채널 ─ ③ 확인`. 끝낸 단계는 `✓`로 접히고 지금 단계만 파랗다.
function settingsSteps(names, at) {
  const wrap = settingsEl('d-isteps');
  wrap.setAttribute('aria-label', `${names.length}단계 중 ${at + 1}단계`);
  names.forEach((name, index) => {
    if (index) {
      const line = document.createElement('span');
      line.className = 'ln';
      line.setAttribute('aria-hidden', 'true');
      wrap.appendChild(line);
    }
    const step = document.createElement('span');
    step.className = index < at ? 'dn' : (index === at ? 'on' : '');
    step.textContent = `${'①②③'[index]} ${name}${index < at ? ' ✓' : ''}`;
    if (index === at) step.setAttribute('aria-current', 'step');
    wrap.appendChild(step);
  });
  return wrap;
}

// 단계 아래 줄: 왼쪽 `← 이전`, 오른쪽 주 버튼.
function settingsStepFoot(back, main) {
  const foot = settingsEl('d-ifoot');
  if (back) foot.appendChild(back);
  if (main) { main.className = `${main.className} sp`; foot.appendChild(main); }
  return foot;
}

// ---------- 카드 한 장 ----------
// `이름 · 칩 · (연결됨이면 상태 줄 · ⋯) | 연결하기` / 한 줄 효용 / 준비물 줄 / (해제 확인 줄) / 펼치는 자리.
// 펼치면 다른 카드는 접힌다 — 한 번에 하나만 연다.
let settingsIntgCards = new Map();
// 저장 뒤 다시 그린 카드에 이어서 보일 것(지라 ③ 확인). 한 번 쓰면 비운다.
let settingsIntgAfter = null;

function settingsIntgCloseOthers(kind) {
  settingsIntgCards.forEach((card, key) => { if (key !== kind) card.close(); });
}

// ---------- 지금 가져오기 ----------
// 연결된 카드의 상태 줄 오른쪽 작은 보조 버튼. 지라·캘린더(비밀 주소)는 서버가 곧바로 다시 읽어 결과를 주고
// (`방금 읽음 · N개`), 슬랙·캘린더(Claude)·티로는 요청만 남긴다(`요청했어요 · 1~2분 뒤 반영돼요`).
// 같은 연동은 1분에 한 번 — 서버가 세고, 화면도 그동안 버튼을 흐리게 둔다. 지금 실패 중이면 상태 줄이
// 빨간 한 줄(`읽지 못했어요 · 10분 전`)이 되고 버튼은 `다시 시도`, 토큰 문제면 `다시 연결`(그 카드의 위저드).
const SETTINGS_FETCH_WAIT_MS = 60 * 1000;
const SETTINGS_FETCH_THROTTLED = '방금 가져왔어요 — 1분 뒤에 다시 할 수 있어요';
const SETTINGS_FETCH_REQUESTED = '요청했어요 · 1~2분 뒤 반영돼요';
const SETTINGS_FETCH_NOTE_MS = { done: 60 * 1000, requested: 3 * 60 * 1000 };
const SETTINGS_FETCH_POLL_MS = 20 * 1000;
const SETTINGS_FETCH_POLL_TIMES = 9;   // 20초 × 9 = 최대 3분
const settingsFetchLast = new Map();   // 연동 키 → 마지막으로 누른 때(ms). 다시 그려도 남는다.
const settingsFetchNotes = new Map();  // 연동 키 → { text, at, mode } — 상태 줄에 잠깐 대신 보일 말
let settingsFetchPoll = null;

// 지금 상태 줄에 대신 보일 말. 요청형은 자동화가 요청 뒤에 한 번 돌았으면(lastRunAt) 거둔다.
function settingsFetchNote(key, state = {}) {
  const note = settingsFetchNotes.get(key);
  if (!note) return null;
  const ran = new Date(state.lastRunAt || '').getTime();
  if (Date.now() - note.at > SETTINGS_FETCH_NOTE_MS[note.mode] || (note.mode === 'requested' && ran >= note.at - 2000)) {
    settingsFetchNotes.delete(key);
    return null;
  }
  return note.text;
}

// 요청한 뒤 연동 탭이 열려 있으면 20초마다(최대 3분) 조용히 다시 읽는다. 펼친 카드가 있으면 그 차례는 건너뛴다.
function settingsFetchPollStart() {
  if (settingsFetchPoll) clearTimeout(settingsFetchPoll.timer);
  settingsFetchPoll = { left: SETTINGS_FETCH_POLL_TIMES, timer: null };
  const tick = () => {
    const poll = settingsFetchPoll;
    if (!poll) return;
    poll.left -= 1;
    const view = document.getElementById('settingsIntegrationsView');
    const open = typeof settingsDialog !== 'undefined' && settingsDialog && settingsDialog.open && view && !view.hidden;
    const busy = [...settingsIntgCards.values()].some(card => !card.body.hidden);
    if (open && !busy) renderSettingsIntegrations({ quiet: true });
    if (!open || poll.left <= 0) { settingsFetchPoll = null; return; }
    poll.timer = setTimeout(tick, SETTINGS_FETCH_POLL_MS);
  };
  settingsFetchPoll.timer = setTimeout(tick, SETTINGS_FETCH_POLL_MS);
}

// request()가 아니라 fetch다 — 여기서 흔한 실패(1분 제한·등록 안 됨·토큰 문제)는 저장 실패가 아니라
// 그 카드에서 말할 것이라, request()의 `저장됐는지 확인하지 못했어요` 알림이 틀린 말이 된다.
async function settingsFetchAsk(key) {
  try {
    const response = await fetch('/api/integrations/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ key }),
    });
    let data = null;
    try { data = await response.json(); } catch { data = null; }
    if (data && typeof data === 'object') return data;
    return { ok: false, reason: 'failed', message: '가져오지 못했어요 — 잠시 뒤 다시 시도해 주세요' };
  } catch {
    return { ok: false, reason: 'failed', message: '서버에 닿지 못했어요 — 앱이 켜져 있는지 확인해 주세요.' };
  }
}

// 버튼 하나. `spec`은 { key, state: { failing, auth, failedAt, lastRunAt }, unit, reconnect }이고
// `paint(글자, 실패 중)`은 그 카드의 상태 줄을 고친다.
function settingsFetchButton(spec, paint) {
  const { key, state = {} } = spec;
  const button = settingsButton('지금 가져오기', 'd-btn sm d-ifetch');
  let mode = state.failing ? (state.auth && spec.reconnect ? 'auth' : 'retry') : 'fetch';
  const label = () => { button.textContent = mode === 'auth' ? '다시 연결' : (mode === 'retry' ? '다시 시도' : '지금 가져오기'); };
  const dim = () => {
    const left = SETTINGS_FETCH_WAIT_MS - (Date.now() - (settingsFetchLast.get(key) || 0));
    if (left <= 0) { button.removeAttribute('aria-disabled'); return; }
    button.setAttribute('aria-disabled', 'true');
    setTimeout(() => { if (button.getAttribute('aria-disabled') === 'true') dim(); }, left);
  };
  label();
  if (mode !== 'auth') dim();
  button.addEventListener('click', async () => {
    if (mode === 'auth') { spec.reconnect(); return; }
    if (button.disabled) return;
    if (Date.now() - (settingsFetchLast.get(key) || 0) < SETTINGS_FETCH_WAIT_MS) { showNotice(SETTINGS_FETCH_THROTTLED); return; }
    button.disabled = true;
    const result = await settingsFetchAsk(key);
    button.disabled = false;
    if (result.ok && (result.mode === 'done' || result.mode === 'requested')) {
      settingsFetchLast.set(key, Date.now());
      const text = result.mode === 'done'
        ? `방금 읽음 · ${spec.unit ? `${spec.unit} ` : ''}${Number(result.count) || 0}개`
        : SETTINGS_FETCH_REQUESTED;
      settingsFetchNotes.set(key, { text, at: Date.now(), mode: result.mode });
      mode = 'fetch';
      label();
      paint(text, false);
      dim();
      if (result.mode === 'requested') settingsFetchPollStart();
      // 캘린더를 곧바로 다시 읽었으면 오늘 미팅 카드도 한 번 새로 그린다.
      else if (key === 'calendar' && typeof load === 'function') load();
      return;
    }
    const message = String(result.message || '가져오지 못했어요 — 잠시 뒤 다시 시도해 주세요');
    if (result.reason === 'throttled') {
      if (!settingsFetchLast.get(key)) settingsFetchLast.set(key, Date.now());
      dim();
      showNotice(message);
      return;
    }
    if (result.reason === 'not-installed') { showNotice(message, true); return; }
    // 지금 실패 — 빨간 한 줄 + 다시 시도(토큰 문제면 다시 연결)
    settingsFetchLast.set(key, Date.now());
    mode = result.reason === 'auth' && spec.reconnect ? 'auth' : 'retry';
    label();
    if (mode === 'auth') button.removeAttribute('aria-disabled'); else dim();
    paint('읽지 못했어요 · 방금', true);
    showNotice(message, true);
  });
  return button;
}

function settingsIntgCard({ kind, name, chip, use, need, status = null, openText = '연결하기', openClass = 'd-btn acc', menu = null, extra = [], fetch: fetchSpec = null, onOpen }) {
  const row = settingsEl('d-intg');
  row.dataset.integration = kind;
  const top = settingsEl('d-intgtop');
  const title = document.createElement('span');
  title.className = 'nm';
  title.textContent = name;
  const tag = document.createElement('span');
  tag.className = 'd-itag';
  tag.textContent = chip;
  top.append(title, tag);
  let paint = null;
  if (status !== null) {
    const state = document.createElement('span');
    state.className = 'st';
    const dot = document.createElement('span');
    dot.className = 'ok';
    dot.setAttribute('aria-hidden', 'true');
    dot.textContent = '●';
    const words = document.createTextNode(` ${status}`);
    state.append(dot, words);
    top.appendChild(state);
    // 상태 줄의 글자와 색만 바꾼다(`지금 가져오기`의 결과 · 지금 실패 중).
    paint = (text, failing) => {
      words.textContent = ` ${text}`;
      state.className = failing ? 'st k-neg' : 'st';
      dot.className = failing ? 'bad' : 'ok';
    };
    if (fetchSpec) {
      const note = settingsFetchNote(fetchSpec.key, fetchSpec.state);
      if (note) paint(note, false);
      else if (fetchSpec.state && fetchSpec.state.failing) {
        const ago = settingsAgo(fetchSpec.state.failedAt);
        paint(`읽지 못했어요${ago ? ` · ${ago}` : ''}`, true);
      }
    }
  }
  const toggle = settingsButton(openText, openClass);
  top.appendChild(toggle);
  // 지금 가져오기 — 연결된 카드에만, 상태 줄 오른쪽 · ⋯ 왼쪽.
  if (fetchSpec && paint) top.appendChild(settingsFetchButton(fetchSpec, paint));
  if (menu) top.appendChild(uiMoreButton(`${name} 더 보기`, menu));

  const useLine = settingsEl('d-intguse', use);
  const needLine = settingsEl('d-intgneed');
  if (Array.isArray(need)) settingsRich(needLine, need); else needLine.textContent = need || '';
  const confirmSlot = settingsEl('d-iconfirmslot');
  const body = settingsEl('d-intgbody');
  body.hidden = true;
  row.append(top, useLine, needLine, ...extra, confirmSlot, body);

  // 연결된 카드는 평소 ⋯만 둔다(펼칠 때만 `접기`). ⋯가 없는 카드(회의록)는 여는 버튼을 늘 둔다.
  const connected = status !== null && !!menu;
  const setOpen = (open) => {
    body.hidden = !open;
    // 연결된 카드는 평소 ⋯만 두고, 펼쳤을 때만 `접기`가 선다.
    toggle.hidden = connected && !open;
    toggle.className = open ? 'd-btn sm' : openClass;
    toggle.textContent = open ? '접기' : openText;
    toggle.setAttribute('aria-expanded', String(open));
  };
  const card = {
    row, top, body, needLine, confirmSlot,
    open(mode, arg) {
      settingsIntgCloseOthers(kind);
      confirmSlot.replaceChildren();
      body.replaceChildren();
      setOpen(true);
      onOpen(card, mode, arg);
    },
    close() { setOpen(false); body.replaceChildren(); confirmSlot.replaceChildren(); },
  };
  toggle.addEventListener('click', () => { if (body.hidden) card.open(); else card.close(); });
  setOpen(false);
  settingsIntgCards.set(kind, card);
  return card;
}

// 해제는 ⋯ 안의 `해제…` → 카드 안 확인 줄 한 번. 큰 해제 버튼은 두지 않는다.
function settingsIntgConfirmOff(card, body, words = '해제하면 자동 수집이 멈춰요. 토큰 파일은 남아요.') {
  settingsIntgCloseOthers(null);
  const line = settingsEl('d-iconfirm');
  const text = document.createElement('span');
  text.className = 'tx';
  text.textContent = words;
  const no = settingsButton('취소', 'd-btn sm', () => card.confirmSlot.replaceChildren());
  const yes = settingsButton('해제', 'd-btn sm dng');
  const error = settingsErrorLine();
  yes.addEventListener('click', () => settingsIntegrationSave(body, {
    error, button: yes,
    done: words.includes('토큰') ? '연결을 해제했어요 — 토큰 파일은 그대로 있어요'
      : (words.includes('주소 파일') ? '연결을 해제했어요 — 주소 파일은 그대로 있어요' : '연결을 해제했어요'),
  }));
  line.append(text, no, yes, error);
  card.confirmSlot.replaceChildren(line);
  yes.focus();
  return line;
}

// ---------- 슬랙 수집 ----------
// `슬랙에서 이렇게 보내요` 네 줄 — ③ 확인과 연결된 카드의 ⋯ › 보내는 법이 같은 상자를 쓴다.
function settingsSlackSendHow(todoName = '#my-todo') {
  const box = settingsEl('d-isend');
  const head = document.createElement('p');
  head.className = 'hd';
  head.textContent = '슬랙에서 이렇게 보내요';
  const list = document.createElement('ol');
  [
    [['b', '남의 메시지'], '는 메시지에 마우스를 올려 ', ['b', '⋯ → 전달'], '(또는 ', ['b', '공유'], ') → 받는 곳에 ', ['b', todoName], '처럼 쓸 채널을 골라 보내요.'],
    ['전달할 때 ', ['b', '메모 한 줄'], '을 같이 적으면(예: ', ['i', '"금요일까지 답하기"'], ') 할 일 문구에 참고해요.'],
    [['b', '내 생각'], '은 그 채널에 그냥 적어도 돼요 — 한 메시지가 한 항목이에요.'],
    ['어디로 보낼지: 해야 할 일 → ', ['b', '할 일'], ' · 누가 답해 줘야 하는 것 → ', ['b', '기다리는 것'], ' · 정해진 정책 → ', ['b', '정해진 것'], ' · 참고거리 → ', ['b', '언젠가']],
  ].forEach((parts) => { list.appendChild(settingsRich(document.createElement('li'), parts)); });
  const foot = document.createElement('p');
  foot.className = 'd-ismall';
  settingsRich(foot, ['스레드 댓글을 전달하면 스레드 전체를 읽어 맥락을 잡아요. 5분 안에 오늘 탭 ', ['b', '새로 들어온 것'], '에 떠요.']);
  box.append(head, list, foot);
  return box;
}

const settingsSlackLabel = key => (SETTINGS_SLACK_CHANNELS.find(([one]) => one === key) || [key, key])[1];

// 위저드 한 벌. mode: `new`(처음 연결) · `fix`(채널 고치기 — ② 단계만, 추가만) · `token`(다시 연결 — 토큰부터).
function settingsSlackWizard(card, data, mode = 'new') {
  const slack = data.slack || {};
  const saved = slack.channels || {};
  // 이미 연결돼 있고 슬랙에서 읽히는 채널 — ②에서 체크된 채 `#이름 연결됨`으로만 보이고 바꿀 수 없다.
  const linked = key => mode !== 'new' && !!(saved[key] && saved[key].id && !saved[key].missing);
  const state = {
    step: mode === 'fix' ? 1 : 0,
    token: '',
    picks: Object.fromEntries(SETTINGS_SLACK_CHANNELS.map(([key, , , name]) => [key, {
      on: linked(key) || (mode === 'new' && (key === 'todo' || key === 'waiting')),
      name,
    }])),
    made: {},
    rowErrors: {},
    error: '',
  };
  const firstStep = mode === 'fix' ? 1 : 0;
  const wanted = () => SETTINGS_SLACK_CHANNELS.map(([key]) => key)
    .filter(key => state.picks[key].on && !linked(key) && !state.made[key]);

  function draw() {
    card.body.replaceChildren();
    card.body.appendChild(settingsSteps(['토큰', '채널', '확인'], state.step));
    if (state.step === 0) drawToken();
    else if (state.step === 1) drawChannels();
    else drawConfirm();
  }

  // ① 토큰 — 어디 가서 무엇을 복사하는지 세 줄 + 링크, 가려진 칸, `다음`(auth.test로 토큰만 확인).
  function drawToken() {
    const how = document.createElement('p');
    how.className = 'd-ihow';
    settingsRich(how, [
      '팀 슬랙 앱 페이지가 열려요(영어 화면이에요).', ['br'],
      '왼쪽 ', ['b', 'OAuth & Permissions'], ' → ', ['b', 'Install to Workspace'], '(이미 했으면 Reinstall) → 허용', ['br'],
      '토큰이 두 개 보여요 — ', ['b', 'xoxp-로 시작하는 User OAuth Token'], ' 옆 ', ['b', 'Copy'], '. ',
      ['code', 'xoxb-'], '로 시작하는 Bot 토큰이 아니에요.',
    ]);
    const open = settingsOutLink('토큰 받는 곳 열기 ↗', settingsSlackAppUrl(slack.appUrl), 'd-btn acc');
    const ask = settingsEl('d-irow d-ismall');
    ask.append(document.createTextNode('페이지가 안 열리거나 권한이 없다고 하면 → '),
      settingsButton('만든 사람에게 요청 문구 복사', 'd-btn xs',
        () => settingsCopy(SETTINGS_SLACK_ASK, '요청 문구를 복사했어요 — 만든 사람에게 보내 주세요')));
    const token = settingsField('토큰 붙여 넣기', { type: 'password', placeholder: 'xoxp-…', hint: '본인 토큰이에요 — 채팅·메일로 보내지 마세요' });
    token.input.setAttribute('aria-label', '슬랙 토큰');
    token.input.value = state.token;
    const error = settingsErrorLine();
    const next = settingsButton('다음 →', 'd-btn pri');
    // Bot 토큰은 서버에 보내지 않고 그 자리에서 알린다.
    const isBot = () => /^xoxb-/.test(String(token.input.value || '').trim());
    token.input.addEventListener('input', () => {
      if (isBot()) error.textContent = SETTINGS_SLACK_BOT;
      else if (error.textContent === SETTINGS_SLACK_BOT) error.textContent = '';
    });
    const go = async () => {
      const value = String(token.input.value || '').trim();
      if (!value) { error.textContent = '슬랙 토큰을 붙여 넣어 주세요'; token.input.focus(); return; }
      if (isBot()) { error.textContent = SETTINGS_SLACK_BOT; token.input.focus(); return; }
      error.textContent = '';
      next.disabled = true;
      const checked = await settingsSlackTokenCheck(value);
      next.disabled = false;
      if (!checked || checked.ok !== true) { error.textContent = checked.error; token.input.focus(); return; }
      state.token = value;
      state.step = 1;
      draw();
    };
    next.addEventListener('click', go);
    settingsOnEnter(token.input, go);
    card.body.append(how, open, ask, token.wrap, error, settingsStepFoot(null, next));
    token.input.focus();
  }

  // ② 채널 — 쓸 곳을 먼저 고르고, 고른 수만큼 비공개 채널을 차례로 만든다(하나라도 실패하면 만든 것은
  // 그대로 두고 실패한 줄에 이유를 적는다 — 다시 누르면 남은 것만 만든다).
  function drawChannels() {
    const how = document.createElement('p');
    how.className = 'd-ihow';
    settingsRich(how, mode === 'fix'
      ? ['더 받을 곳을 골라요. 이미 연결된 채널은 그대로 두고 ', ['b', '새로 고른 것만'], ' 만들어 드려요.']
      : ['슬랙에 공유한 메시지를 ', ['b', '어디로 받을지'], ' 골라요. 고른 만큼 나만 있는 비공개 채널을 만들어 드려요. 이름은 바꿔도 돼요 — 나중에 슬랙에서 바꿔도 그대로 이어져요.']);
    const list = settingsEl('d-ichlist');
    const error = settingsErrorLine();
    const make = settingsButton('', 'd-btn pri');
    const inputs = {};
    const label = () => {
      const count = wanted().length;
      // 다시 연결(토큰만 바꾸기)은 새 채널 없이도 ③으로 넘어갈 수 있다.
      const canSkip = Object.keys(state.made).length > 0 || mode === 'token';
      make.textContent = count ? `고른 채널 ${count}개 만들어 주기` : (canSkip ? '다음 →' : '고른 채널 0개 만들어 주기');
      make.disabled = !count && !canSkip;
    };
    SETTINGS_SLACK_CHANNELS.forEach(([key, name, where]) => {
      const pick = state.picks[key];
      const locked = linked(key) || !!state.made[key] || key === 'todo';
      const row = document.createElement('label');
      row.className = 'd-ich' + (pick.on ? ' is-on' : '');
      row.dataset.channel = key;
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = pick.on;
      box.disabled = locked;
      box.setAttribute('aria-label', `${name} 받기`);
      const text = document.createElement('span');
      text.className = 't';
      const strong = document.createElement('b');
      strong.textContent = name;
      text.appendChild(strong);
      if (key === 'todo') {
        const need = document.createElement('span');
        need.className = 'need';
        need.textContent = '필수';
        text.append(document.createTextNode(' '), need);
      }
      const sub = document.createElement('span');
      sub.className = 'd-ismall sub';
      settingsRich(sub, where);
      text.appendChild(sub);
      row.append(box, text);
      if (linked(key)) {
        const on = document.createElement('span');
        on.className = 'nm is-done';
        on.textContent = `${saved[key].name || '채널'} 연결됨`;
        row.appendChild(on);
      } else if (state.made[key]) {
        const on = document.createElement('span');
        on.className = 'nm is-done';
        on.textContent = `✓ #${state.made[key].name} 만들었어요`;
        row.appendChild(on);
      } else {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'd-din nm';
        input.value = pick.name;
        input.disabled = !pick.on;
        input.setAttribute('aria-label', `${name} 채널 이름`);
        input.addEventListener('input', () => {
          const clean = settingsSlackChannelName(input.value);
          if (clean !== input.value) input.value = clean;
          pick.name = input.value;
          if (state.rowErrors[key]) { state.rowErrors[key] = ''; rowError.textContent = ''; }
        });
        settingsOnEnter(input, () => make.click());
        inputs[key] = input;
        row.appendChild(input);
        box.addEventListener('change', () => {
          pick.on = !!box.checked;
          input.disabled = !pick.on;
          row.className = 'd-ich' + (pick.on ? ' is-on' : '');
          label();
          if (pick.on) input.focus();
        });
      }
      const rowError = settingsErrorLine();
      rowError.classList.add('d-icherr');
      rowError.textContent = state.rowErrors[key] || '';
      row.appendChild(rowError);
      list.appendChild(row);
    });
    make.addEventListener('click', async () => {
      const keys = wanted();
      if (!keys.length) { if (Object.keys(state.made).length || mode === 'token') { state.step = 2; draw(); } return; }
      state.error = '';
      // 이름부터 한 번에 본다 — 빈 이름이 있으면 아무것도 만들지 않는다.
      const blank = keys.filter(key => !settingsSlackChannelName(state.picks[key].name));
      if (blank.length) {
        blank.forEach((key) => { state.rowErrors[key] = '채널 이름을 적어 주세요'; });
        draw();
        return;
      }
      make.disabled = true;
      let stop = '';
      for (const key of keys) {
        const nameWanted = settingsSlackChannelName(state.picks[key].name);
        const result = await settingsSlackCreateChannel(state.token, nameWanted);
        if (result && result.ok === true) {
          state.made[key] = { id: result.id, name: result.name || nameWanted };
          state.rowErrors[key] = '';
          continue;
        }
        const code = (result && result.code) || '';
        if (code === 'name_taken') { state.rowErrors[key] = SETTINGS_SLACK_TAKEN; continue; }
        // 권한·토큰 문제는 남은 줄도 똑같이 실패하므로 여기서 멈추고 ② 맨 아래 한 줄로 적는다.
        if (code === 'missing_scope' || code === 'invalid_auth') { stop = result.error; break; }
        state.rowErrors[key] = (result && result.error) || '슬랙에서 채널을 만들지 못했어요';
      }
      const made = Object.keys(state.made).length;
      if (!stop && !wanted().length && made) {
        showNotice(`채널 ${made}개를 만들었어요`);
        state.step = 2;
        draw();
        return;
      }
      state.error = stop;
      draw();
    });
    label();
    const wrap = settingsEl('d-ichwrap');
    wrap.append(how, list, make);
    if (mode === 'new') {
      const later = document.createElement('p');
      later.className = 'd-ismall';
      settingsRich(later, ['나중에 더 고르고 싶으면 설정 › 연동 › 슬랙 ⋯ › ', ['b', '채널 고치기'], '.']);
      wrap.appendChild(later);
    }
    error.textContent = state.error || '';
    wrap.appendChild(error);
    const back = mode === 'fix' ? null : settingsButton('← 이전', 'd-btn sm', () => { state.step = 0; draw(); });
    card.body.append(wrap, settingsStepFoot(back, null));
    // 커서는 이름을 고칠 첫 줄로(없으면 주 버튼으로).
    const firstTaken = Object.keys(inputs).find(key => state.rowErrors[key]);
    const firstOpen = firstTaken || Object.keys(inputs).find(key => state.picks[key].on);
    if (firstOpen) inputs[firstOpen].focus(); else make.focus();
  }

  // ③ 확인 — 채널마다 한 줄, `슬랙에서 이렇게 보내요`, `연결`(기존 저장 길: 토큰 파일 0600 · config · 채널 id).
  function drawConfirm() {
    const rows = SETTINGS_SLACK_CHANNELS.map(([key, name]) => {
      if (state.made[key]) return [`✓ #${state.made[key].name} · ${name} · 잘 읽혀요`];
      if (linked(key)) return [`✓ ${saved[key].name || '채널'} · ${name} · 연결돼 있어요`];
      return null;
    }).filter(Boolean);
    rows.forEach(([text]) => card.body.appendChild(settingsEl('d-iok', text)));
    const how = document.createElement('p');
    how.className = 'd-ihow';
    how.textContent = '연결하면 5분마다 이 채널들을 읽어 앱에 넣어요.';
    const todoName = state.made.todo ? `#${state.made.todo.name}` : ((saved.todo && saved.todo.name) || '#my-todo');
    const error = settingsErrorLine();
    const go = settingsButton('연결', 'd-btn pri');
    go.addEventListener('click', () => {
      const channels = Object.fromEntries(Object.entries(state.made).map(([key, made]) => [key, made.id]));
      return settingsIntegrationSave({ slack: { enabled: true, token: state.token, channels } },
        { error, button: go, done: '슬랙 수집을 연결했어요' });
    });
    const back = settingsButton('← 이전', 'd-btn sm', () => { state.step = 1; draw(); });
    card.body.append(how, settingsSlackSendHow(todoName), error, settingsStepFoot(back, go));
    go.focus();
  }

  state.step = firstStep;
  draw();
  return state;
}

function settingsSlackCard(data) {
  const slack = data.slack || {};
  const channels = slack.channels || {};
  const todo = channels.todo || {};
  const connected = !!(slack.enabled && slack.hasToken && todo.id);
  const linkedKeys = SETTINGS_SLACK_CHANNELS.map(([key]) => key).filter(key => channels[key] && channels[key].id);
  const more = linkedKeys.filter(key => key !== 'todo').length;
  const ago = settingsAgo(slack.readAt);
  const status = connected ? `${todo.name || '채널'}${more ? ` 외 ${more}개` : ''}${ago ? ` · ${ago} 읽음` : ''}` : null;
  let card = null;
  // 슬랙에서 사라진(지웠거나 보관한) 채널은 그 줄을 따로 알린다 — 누르면 채널 고치기로 간다.
  const extra = linkedKeys.filter(key => channels[key].missing).map((key) => {
    const line = settingsEl('d-intgneed k-warn');
    line.dataset.missing = key;
    line.append(document.createTextNode(`${channels[key].name || '채널'} 채널을 읽지 못했어요 · `),
      settingsButton('채널 고치기', 'd-ablink', () => card.open('fix')));
    return line;
  });
  // 메시지를 할 일로 옮기는 일은 지금 Claude Code가 한다 — 이 맥에 없으면 사실만 한 줄 알린다.
  if (!data.claude) extra.push(settingsEl('d-intgnote', '메시지를 할 일로 옮기는 일은 지금 Claude Code가 해요 · 이 맥에는 설치 안 됨'));
  const menu = connected ? () => [[
    { label: '보내는 법', onClick: () => { card.open('how'); } },
    { label: '채널 고치기', onClick: () => card.open('fix') },
    { label: '다시 연결(토큰 바꾸기)', onClick: () => card.open('token') },
  ], [
    { label: '해제…', danger: true, onClick: () => settingsIntgConfirmOff(card, { slack: { enabled: false } }) },
  ]] : null;
  card = settingsIntgCard({
    kind: 'slack', name: '슬랙 수집', chip: 'Claude Code 필요',
    use: '나만 보는 채널에 공유한 메시지가 할 일로 들어와요',
    need: connected
      ? linkedKeys.map(key => `${channels[key].name || '채널'} ${settingsSlackLabel(key)}`).join(' · ')
      : '5분 · 팀 슬랙 앱 토큰 하나',
    status, menu, extra,
    fetch: connected ? { key: 'slack', state: slack.fetch || {}, reconnect: () => card.open('token') } : null,
    onOpen: (self, mode) => {
      if (mode === 'how') { self.body.appendChild(settingsSlackSendHow(todo.name || '#my-todo')); return; }
      settingsSlackWizard(self, data, connected ? (mode || 'fix') : 'new');
    },
  });
  return card;
}

// ---------- 지라 ----------
// ① 토큰 ─ ② 계정 ─ ③ 확인. 지라 주소는 팀 값(config의 `jira.siteUrl`)이 있으면 묻지 않는다.
function settingsJiraWizard(card, data) {
  const jira = data.jira || {};
  const team = String(settingsRealValue(jira.siteUrl) || '').trim();
  const teamHost = team.replace(/^https?:\/\//, '');
  const state = { step: 0, token: '', email: String(settingsRealValue(jira.email) || ''), site: team, siteOpen: !team };

  function draw() {
    card.body.replaceChildren();
    card.body.appendChild(settingsSteps(['토큰', '계정', '확인'], state.step));
    if (state.step === 0) drawToken(); else drawAccount();
  }

  function drawToken() {
    const make = settingsOutLink('토큰 만들기 ↗', JIRA_TOKEN_URL, 'd-btn acc');
    const how = document.createElement('p');
    how.className = 'd-ihow';
    settingsRich(how, ['Atlassian 계정 보안 페이지 → ', ['b', 'API 토큰 만들기'], ' → 이름은 아무거나 → ', ['b', '복사']]);
    const token = settingsField('토큰 붙여 넣기', { type: 'password', placeholder: '붙여 넣기', hint: '본인 토큰이에요 — 채팅·메일로 보내지 마세요' });
    token.input.setAttribute('aria-label', '지라 토큰');
    token.input.value = state.token;
    const error = settingsErrorLine();
    const next = settingsButton('다음 →', 'd-btn pri');
    const go = () => {
      const value = String(token.input.value || '').trim();
      if (!value) { error.textContent = 'API 토큰을 붙여 넣어 주세요'; token.input.focus(); return; }
      state.token = value;
      state.step = 1;
      draw();
    };
    next.addEventListener('click', go);
    settingsOnEnter(token.input, go);
    card.body.append(make, how, token.wrap, error, settingsStepFoot(null, next));
    token.input.focus();
  }

  function drawAccount() {
    const email = settingsField('지라에 로그인하는 이메일', { placeholder: '나@회사.com', value: state.email });
    email.input.addEventListener('input', () => { state.email = email.input.value; });
    const site = settingsField('지라 주소', { placeholder: 'https://회사.atlassian.net', value: state.site });
    site.input.addEventListener('input', () => { state.site = site.input.value; });
    site.wrap.hidden = !state.siteOpen;
    const parts = [email.wrap];
    if (team) {
      const note = settingsEl('d-ismall');
      note.dataset.team = 'site';
      note.hidden = state.siteOpen;
      note.append(document.createTextNode(`지라 주소는 팀 설정(${teamHost})을 써요 · `),
        settingsButton('바꾸기', 'd-ablink', () => {
          state.siteOpen = true;
          note.hidden = true;
          site.wrap.hidden = false;
          site.input.focus();
        }));
      parts.push(note);
    }
    parts.push(site.wrap);
    const error = settingsErrorLine();
    const go = settingsButton('연결', 'd-btn pri');
    const connect = () => settingsIntegrationSave({
      jira: { enabled: true, siteUrl: state.siteOpen ? site.input.value : team, email: email.input.value, token: state.token },
    }, {
      error, button: go, done: '지라에 연결했어요',
      saved: (result) => { settingsIntgAfter = { kind: 'jira', displayName: (result.jira && result.jira.displayName) || '' }; },
    });
    go.addEventListener('click', connect);
    settingsOnEnter(email.input, connect);
    settingsOnEnter(site.input, connect);
    const back = settingsButton('← 이전', 'd-btn sm', () => { state.step = 0; draw(); });
    card.body.append(...parts, error, settingsStepFoot(back, go));
    (state.siteOpen && !team ? (state.email ? site.input : email.input) : email.input).focus();
  }

  draw();
  return state;
}

// ③ 확인 — 저장이 끝나고 다시 그린 카드에서 이어 보인다.
function settingsJiraDone(card, data, displayName) {
  const jira = data.jira || {};
  card.body.appendChild(settingsSteps(['토큰', '계정', '확인'], 2));
  card.body.appendChild(settingsEl('d-iok', `✓ ${displayName || jira.displayName || '내'}님으로 연결됐어요`));
  const how = document.createElement('p');
  how.className = 'd-ihow';
  how.textContent = typeof jira.issueCount === 'number'
    ? `내 티켓 ${jira.issueCount}개를 프로젝트 탭에 띄웠어요. 10분마다 다시 읽어요.`
    : '내 티켓을 프로젝트 탭에 띄워요. 10분마다 다시 읽어요.';
  const close = settingsButton('닫기', 'd-btn acc', () => card.close());
  card.body.append(how, settingsStepFoot(null, close));
  close.focus();
}

function settingsJiraCard(data) {
  const jira = data.jira || {};
  const connected = !!(jira.enabled && jira.hasToken && jira.siteUrl);
  const host = String(jira.siteUrl || '').replace(/^https?:\/\//, '');
  const ago = settingsAgo(jira.readAt);
  const status = connected
    ? [jira.displayName ? `${jira.displayName}님` : '', host, ago ? `${ago} 읽음` : ''].filter(Boolean).join(' · ')
    : null;
  const counts = [
    typeof jira.issueCount === 'number' ? `지금 내 티켓 ${jira.issueCount}개` : '',
    typeof jira.attentionCount === 'number' ? `반응 필요 댓글 ${jira.attentionCount}개` : '',
  ].filter(Boolean).join(' · ');
  let card = null;
  card = settingsIntgCard({
    kind: 'jira', name: '지라', chip: '누구나',
    use: '내 티켓이 프로젝트로 뜨고 상태·기한을 여기서 바꿔요',
    need: connected ? (counts || '앱이 지라를 직접 읽어요') : '3분 · Atlassian API 토큰 하나',
    status,
    fetch: connected ? { key: 'jira', state: jira.fetch || {}, reconnect: () => card.open('token') } : null,
    menu: connected ? () => [[
      { label: '다시 연결(토큰 바꾸기)', onClick: () => card.open('token') },
    ], [
      { label: '해제…', danger: true, onClick: () => settingsIntgConfirmOff(card, { jira: { enabled: false } }) },
    ]] : null,
    onOpen: (self, mode, arg) => {
      if (mode === 'done') { settingsJiraDone(self, data, arg); return; }
      settingsJiraWizard(self, data);
    },
  });
  return card;
}

// ---------- 캘린더 ----------
// 갈래 둘 — `비밀 주소 붙이기`(누구나, Claude 없이 앱이 직접 읽는다)가 먼저, `Claude Code로`가 다음.
// 비밀 주소는 토큰과 같은 급이라 칸은 가려져 있고(password), 저장한 뒤에는 화면·응답 어디에도 다시 나오지 않는다.
const SETTINGS_ICAL_OFF = '해제하면 오늘 일정 가져오기가 멈춰요. 주소 파일은 남아요.';

function settingsIcalChoice(card, data, mode) {
  const box = settingsEl('d-ichoice');
  box.dataset.choice = 'ical';
  const head = settingsEl('hd');
  const tag = document.createElement('span');
  tag.className = 'd-itag';
  tag.textContent = '누구나';
  head.append(document.createTextNode('비밀 주소 붙이기'), tag);
  const steps = settingsNumbered([
    [['구글 캘린더 → ', ['b', '설정'], ' → ', ['b', '내 캘린더의 설정'], '(내 이름)']],
    [[['b', '캘린더 통합'], ' → ', ['b', 'iCal 형식의 비공개 주소']]],
    [[['b', '복사'], ' → 아래 칸에 붙여 넣기']],
  ]);
  const field = settingsField('비밀 주소', {
    type: 'password',
    placeholder: 'https://calendar.google.com/calendar/ical/…/basic.ics',
    hint: '비밀 주소는 비밀번호처럼 다뤄요 — 채팅·메일로 보내지 마세요',
  });
  field.input.setAttribute('aria-label', '캘린더 비밀 주소');
  field.input.autocomplete = 'off';
  const error = settingsErrorLine();
  const go = settingsButton('연결', 'd-btn pri');
  const connect = () => {
    const url = String(field.input.value || '').trim();
    // 다시 연결은 칸을 비워 두면 저장된 주소로 한 번 더 읽는다(주소를 바꿀 때만 붙여 넣는다).
    if (!url && !(mode === 'again' && data.calendar && data.calendar.hasIcal)) {
      error.textContent = '비밀 주소를 붙여 넣어 주세요';
      field.input.focus();
      return;
    }
    return settingsIntegrationSave({ calendar: { enabled: true, source: 'ical', url } }, {
      error, button: go,
      done: result => settingsIcalDone(result),
    });
  };
  go.addEventListener('click', connect);
  settingsOnEnter(field.input, connect);
  const note = settingsEl('d-ismall', mode === 'again' && data.calendar && data.calendar.hasIcal
    ? '칸을 비워 두고 연결하면 지금 주소로 다시 읽어요.'
    : '앱이 30분마다 이 주소를 직접 읽어요 — Claude는 필요 없어요.');
  const foot = settingsEl('d-irow');
  foot.appendChild(go);
  box.append(head, steps, field.wrap, error, foot, note);
  return { box, input: field.input };
}

// 연결 뒤 알림 — 서버가 한 번 읽어 센 오늘 일정 수를 그대로 말한다.
function settingsIcalDone(result) {
  const count = result && result.calendar && typeof result.calendar.count === 'number' ? result.calendar.count : null;
  return count === null ? '캘린더를 연결했어요' : `캘린더를 연결했어요 · 오늘 일정 ${count}개가 보여요`;
}

function settingsCalendarOpen(card, data, mode) {
  const ask = document.createElement('p');
  ask.className = 'd-ihow';
  ask.textContent = mode === 'again' ? '비밀 주소를 바꿔 붙여요' : '어떤 길로 붙일까요?';
  const pair = settingsEl('d-ichoices');
  const ical = settingsIcalChoice(card, data, mode);

  if (mode === 'again') {
    card.body.append(ask, ical.box);
    ical.input.focus();
    return;
  }

  const claude = settingsEl('d-ichoice');
  claude.dataset.choice = 'claude';
  const claudeHead = settingsEl('hd');
  const claudeTag = document.createElement('span');
  claudeTag.className = 'd-itag';
  claudeTag.textContent = 'Claude Code 필요';
  claudeHead.append(document.createTextNode('Claude Code로'), claudeTag);
  const error = settingsErrorLine();
  const on = settingsButton('켜기', 'd-btn acc', () => settingsIntegrationSave({ calendar: { enabled: true } },
    { error, button: on, done: '캘린더를 켰어요' }));
  if (!data.claude) on.disabled = true;
  const steps = settingsNumbered([
    [['claude.ai 설정 → 커넥터 → Google Calendar 연결'], settingsCodeLine(SETTINGS_CLAUDE_CONNECTORS)],
    [['Claude Code에서 ', ['b', '/mcp'], ' → 로그인'], settingsCodeLine('/mcp')],
    [['여기서 켜기 '], on],
  ]);
  const need = settingsEl('d-ismall', data.claude
    ? 'Claude Code(유료 구독)가 있어야 해요'
    : 'Claude Code(유료 구독)가 있어야 해요 · 이 맥에는 설치 안 됨 — 설치하면 켤 수 있어요');
  claude.append(claudeHead, steps, need, error);

  pair.append(ical.box, claude);
  card.body.append(ask, pair);
  ical.input.focus();
}

// 연결된 카드의 한 줄. 비밀 주소면 `비밀 주소로 읽는 중 · 오늘 3개 · 10분 전`, 못 읽고 있으면 그 말.
function settingsCalendarStatus(calendar) {
  if (calendar.source !== 'ical') {
    const ran = settingsAgo(calendar.fetch && calendar.fetch.lastRunAt);
    return `Claude Code로 읽는 중${ran ? ` · ${ran}` : ''}`;
  }
  const ago = settingsAgo(calendar.readAt);
  if (!calendar.readAt && calendar.failed) return '비밀 주소를 읽지 못했어요';
  return ['비밀 주소로 읽는 중',
    typeof calendar.eventCount === 'number' ? `오늘 ${calendar.eventCount}개` : '',
    ago].filter(Boolean).join(' · ');
}

function settingsCalendarCard(data) {
  const calendar = data.calendar || {};
  const on = !!calendar.enabled;
  const ical = on && calendar.source === 'ical';
  let card = null;
  card = settingsIntgCard({
    kind: 'calendar', name: '캘린더', chip: '누구나 · Claude',
    use: '오늘 회의가 뜨고 회의 정리가 열려요',
    need: on
      ? (ical ? '앱이 비밀 주소를 직접 읽어요 · 30분마다' : 'Claude Code로 오늘 일정을 읽어요')
      : '3분 · 비밀 주소 또는 Claude Code',
    status: on ? settingsCalendarStatus(calendar) : null,
    // 비밀 주소면 앱이 곧바로 다시 읽고(`오늘 N개`), Claude 갈래면 요청만 남긴다. 주소 문제면 `다시 연결`.
    fetch: on ? {
      key: 'calendar', state: calendar.fetch || {}, unit: ical ? '오늘' : '',
      reconnect: ical ? () => card.open('again') : null,
    } : null,
    menu: on ? () => [
      ...(ical ? [[{ label: '다시 연결(주소 바꾸기)', onClick: () => card.open('again') }]] : []),
      [{
        label: '해제…', danger: true,
        onClick: () => settingsIntgConfirmOff(card, { calendar: { enabled: false } }, ical ? SETTINGS_ICAL_OFF : '해제하면 오늘 일정 가져오기가 멈춰요.'),
      }],
    ] : null,
    onOpen: (self, mode) => settingsCalendarOpen(self, data, mode),
  });
  if (ical && !calendar.readAt && calendar.failed) {
    const dot = card.top.querySelector('.ok');
    if (dot) dot.className = 'bad';
  }
  return card;
}

// ---------- 회의록 ----------
// 세그먼트 `직접 옮기기 | 티로`. 티로 쪽은 세 줄(터미널 명령 복사 → /mcp 로그인 → 여기서 고르기).
// 예전 설정의 `다른 것`(meetingNotes: { other })은 그대로 읽어 `○○ 쓰는 중`으로만 보인다 — 요청은 목록 맨 아래로 옮겼다.
function settingsNotesOpen(card, data) {
  const notes = data.meetingNotes || { mode: 'manual', name: '' };
  let chosen = notes.mode === 'tiro' ? 'tiro' : 'manual';
  const error = settingsErrorLine();
  const head = settingsEl('d-irow');
  const seg = document.createElement('span');
  seg.className = 'd-seg';
  seg.setAttribute('role', 'radiogroup');
  seg.setAttribute('aria-label', '회의록 쓰는 방법');
  const need = document.createElement('span');
  need.className = 'd-itag';
  need.textContent = 'Claude Code(유료 구독)가 있어야 해요';
  const tiro = settingsEl('d-itiro');
  const buttons = [];
  const paint = () => {
    buttons.forEach(([mode, button]) => button.setAttribute('aria-checked', String(mode === chosen)));
    tiro.hidden = chosen !== 'tiro';
    need.hidden = chosen !== 'tiro';
  };
  [['manual', '직접 옮기기(기본)'], ['tiro', '티로']].forEach(([mode, text]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'radio');
    button.textContent = text;
    button.addEventListener('click', () => {
      chosen = mode;
      paint();
      // 직접 옮기기는 고르는 순간 저장한다(설치할 것이 없다). 티로는 세 줄을 보고 마지막 버튼으로 저장한다.
      if (mode === 'manual' && notes.mode !== 'manual') {
        settingsIntegrationSave({ meetingNotes: { mode: 'manual' } }, { error, button, done: '직접 옮겨서 쓸게요' });
      }
    });
    buttons.push([mode, button]);
    seg.appendChild(button);
  });
  head.append(seg, need);

  const take = settingsButton(notes.mode === 'tiro' ? '지금 티로로 받고 있어요' : '티로로 받기', 'd-btn pri');
  if (notes.mode === 'tiro' || !data.claude) take.disabled = true;
  take.addEventListener('click', () => settingsIntegrationSave({ meetingNotes: { mode: 'tiro' } },
    { error, button: take, done: '티로로 가져올게요' }));
  tiro.appendChild(settingsNumbered([
    [['터미널에 붙여 넣기'], settingsCodeLine(SETTINGS_TIRO_ADD)],
    [['Claude Code에서 ', ['b', '/mcp → tiro-mcp → Authenticate']]],
    [['여기서 티로 선택 '], take],
  ]));
  if (!data.claude) tiro.appendChild(settingsEl('d-ismall', '이 맥에는 Claude Code가 설치돼 있지 않아요 — 설치하면 고를 수 있어요'));
  const quiet = settingsEl('d-ismall', '직접 옮기기는 회의 정리 화면에 붙여 넣어요 — 아무것도 설치하지 않아요.');
  card.body.append(head, tiro, quiet, error);
  paint();
}

function settingsNotesCard(data) {
  const notes = data.meetingNotes || { mode: 'manual', name: '' };
  const need = notes.mode === 'tiro' ? '티로로 받는 중'
    : (notes.mode === 'other' ? `${notes.name} 쓰는 중 · 요청해 두었어요` : '직접 옮기기 중');
  // 티로로 받는 중이면 연결된 카드다 — 마지막으로 가져온 때 한 줄 + `지금 가져오기`(미팅 노트 가져오기의 오늘 모드와 같은 길).
  const tiro = notes.mode === 'tiro';
  const state = notes.fetch || {};
  const ran = settingsAgo(state.lastRunAt);
  return settingsIntgCard({
    kind: 'notes', name: '회의록', chip: '누구나 · Claude',
    use: '티로 회의록이 초안으로 들어와요 — 직접 옮기기도 돼요',
    need,
    status: tiro ? (ran ? `${ran} 가져옴` : '아직 가져온 적 없어요') : null,
    fetch: tiro ? { key: 'tiro', state } : null,
    openText: '바꾸기', openClass: 'd-btn sm',
    onOpen: self => settingsNotesOpen(self, data),
  });
}

// ---------- 목록 ----------
// 맨 위 한 줄(선택이라는 말 + `연결됨 N · 남은 것 M`) → 카드 넷 → 맨 아래 조용한 줄
// (`다른 도구를 쓰고 있어요 → 요청하기 · 각자 붙이는 법 ↗`)과 자동화 등록 안내.
function settingsIntgCounts(data) {
  const slack = data.slack || {};
  const jira = data.jira || {};
  const flags = [
    !!(slack.enabled && slack.hasToken && slack.channels && slack.channels.todo && slack.channels.todo.id),
    !!(jira.enabled && jira.hasToken && jira.siteUrl),
    !!(data.calendar && data.calendar.enabled),
    !!(data.meetingNotes && data.meetingNotes.mode === 'tiro'),
  ];
  const on = flags.filter(Boolean).length;
  return { on, left: flags.length - on };
}

function settingsIntgFoot() {
  const foot = settingsEl('d-intgfoot');
  const line = settingsEl('d-irow');
  const ask = settingsEl('d-intgask');
  ask.hidden = true;
  const tool = settingsField('어떤 도구인가요', { placeholder: '예: 노션 캘린더' });
  const error = settingsErrorLine();
  const copy = settingsButton('요청 문구 복사', 'd-btn sm');
  const send = async () => {
    const wanted = String(tool.input.value || '').trim().slice(0, 60);
    if (!wanted) { error.textContent = '어떤 도구인지 이름을 적어 주세요'; tool.input.focus(); return; }
    error.textContent = '';
    await settingsReportCopy(copy, { lead: `연동 요청: ${wanted}`, done: '요청 내용을 복사했어요 — 슬랙으로 붙여 넣어 주세요' });
  };
  copy.addEventListener('click', send);
  settingsOnEnter(tool.input, send);
  ask.append(tool.wrap, copy, error);
  const open = settingsButton('요청하기', 'd-ablink', () => {
    ask.hidden = !ask.hidden;
    open.setAttribute('aria-expanded', String(!ask.hidden));
    if (!ask.hidden) tool.input.focus();
  });
  open.setAttribute('aria-expanded', 'false');
  line.append(document.createTextNode('다른 도구를 쓰고 있어요 → '), open, document.createTextNode(' · '),
    settingsOutLink('각자 붙이는 법 ↗', SETTINGS_OWN_TOOL_URL, 'd-ablink'));
  // 켠 자동화는 launchd에 따로 등록돼야 실제로 돈다 — 그 한 번은 업데이트.command가 해 준다.
  const setup = settingsEl('d-intgsetup', '켠 자동화를 등록하려면 앱 폴더의 업데이트.command를 한 번 실행해요.');
  foot.append(line, ask, setup);
  return foot;
}

// `quiet`는 `지금 가져오기` 뒤 조용히 다시 읽을 때 — 불러오는 중 글자를 띄우지 않고, 못 읽으면 지금 화면을 둔다.
async function renderSettingsIntegrations({ quiet = false } = {}) {
  const view = document.getElementById('settingsIntegrationsView');
  if (!view) return;
  if (!quiet) {
    view.replaceChildren();
    view.insertAdjacentHTML('beforeend', '<div class="d-empty">불러오는 중이에요…</div>');
  }
  const data = await settingsIntegrationsLoad();
  if (quiet && !data) return;
  view.replaceChildren();
  if (!data) {
    view.insertAdjacentHTML('beforeend', '<div class="d-empty">연동 상태를 불러오지 못했어요.</div>');
    return;
  }
  settingsIntgCards = new Map();
  const counts = settingsIntgCounts(data);
  const head = settingsEl('d-intghead');
  const lead = document.createElement('span');
  lead.textContent = '연동은 선택이에요. 필요할 때 하나씩 켜요.';
  const tally = document.createElement('span');
  tally.className = 'd-quiet sp';
  tally.textContent = `연결됨 ${counts.on} · 남은 것 ${counts.left}`;
  head.append(lead, tally);
  view.appendChild(head);
  [settingsSlackCard, settingsJiraCard, settingsCalendarCard, settingsNotesCard]
    .forEach(make => view.appendChild(make(data).row));
  view.appendChild(settingsIntgFoot());
  // 지라 연결 직후라면 ③ 확인을 그 카드에 이어서 보인다(저장 뒤 다시 그린 화면).
  const after = settingsIntgAfter;
  settingsIntgAfter = null;
  if (after && after.kind === 'jira' && settingsIntgCards.get('jira')) {
    settingsIntgCards.get('jira').open('done', after.displayName);
  }
}

// ---------- 설정 > 꾸미기 (이 맥에만) ----------
// 세 줄(Dock 아이콘 · Dock 이름 · 워크스페이스 제목) + 저장, 맨 아래 `앱 위치`. 프리셋은 두지 않는다.
// 아이콘은 고르는 순간 화면에서 정사각형 가운데로 잘라(캔버스) 미리 보여 주고, `저장`을 눌러야 서버로 간다.
// Dock 앱은 서버가 아니라 launchd 에이전트(app-refresh)가 다시 만든다 — Dock을 다시 시작하지 않으므로
// 저장 뒤 한 줄로 `Dock은 앱을 닫고 다시 열면 보여요`를 알린다.
const PERSONALIZE_ICON_MAX = 5 * 1024 * 1024;
const PERSONALIZE_ICON_MIN = 128;
const PERSONALIZE_ICON_OUT = 1024;
let personalizeSavedNote = null;   // 저장 뒤 다시 그린 화면에 한 번 보일 `✓ 바뀌었어요` 줄({ dock })

// 가운데 정사각형 — 긴 쪽의 양 끝을 똑같이 잘라 낸다.
function personalizeCropBox(width, height) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  const size = Math.max(0, Math.min(w, h));
  return { sx: Math.floor((w - size) / 2), sy: Math.floor((h - size) / 2), size };
}

// 서버와 같은 규칙(personalize.js). 틀리면 그 문구, 맞으면 빈 글자.
function personalizeNameError(dockName, title) {
  const name = String(dockName || '').trim();
  const head = String(title || '').trim();
  if (!name || [...name].length > 30 || /[/:\r\n\t]/.test(name) || name.startsWith('.')) {
    return 'Dock 이름은 1~30자로 적어 주세요 — / : 와 줄바꿈은 쓸 수 없어요';
  }
  if (!head || [...head].length > 40 || /[\r\n]/.test(head)) return '워크스페이스 제목은 1~40자로 적어 주세요';
  return '';
}

function personalizeFileError(file) {
  if (!file) return '그림을 고르지 않았어요';
  if (!['image/png', 'image/jpeg'].includes(file.type)) return 'PNG나 JPG 그림만 쓸 수 있어요';
  if (file.size > PERSONALIZE_ICON_MAX) return '그림은 5MB까지 쓸 수 있어요';
  return '';
}

// 고른 그림을 가운데 정사각형으로 잘라 PNG(최대 1024px)로 만든다. 미리보기도 이 캔버스다.
function personalizeCrop(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      const width = image.naturalWidth;
      const height = image.naturalHeight;
      if (Math.min(width, height) < PERSONALIZE_ICON_MIN) { reject(new Error('가로세로 128px 이상인 그림을 골라 주세요')); return; }
      const box = personalizeCropBox(width, height);
      const out = Math.min(box.size, PERSONALIZE_ICON_OUT);
      const canvas = document.createElement('canvas');
      canvas.width = out;
      canvas.height = out;
      canvas.getContext('2d').drawImage(image, box.sx, box.sy, box.size, box.size, 0, 0, out, out);
      resolve({ canvas, data: canvas.toDataURL('image/png').split(',')[1] || '' });
    };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('그림을 열지 못했어요')); };
    image.src = url;
  });
}

// 이름 있는 한 줄 — 왼쪽 이름(+작은 설명), 오른쪽 값.
function personalizeRow(name, small, ...value) {
  const row = settingsEl('d-pset');
  const key = settingsEl('k');
  key.appendChild(document.createTextNode(name));
  if (small) {
    const note = document.createElement('small');
    note.textContent = small;
    key.appendChild(note);
  }
  const cell = settingsEl('v');
  cell.append(...value);
  row.append(key, cell);
  return row;
}

// 헤더 제목·탭 제목·탭 아이콘을 곧바로 바꾼다(서버를 다시 켜지 않는다).
function personalizeApply({ title, icon } = {}) {
  if (title) {
    const head = document.getElementById('workspaceTitle');
    if (head) head.textContent = title;
    document.title = title;
  }
  if (icon) {
    const favicon = document.getElementById('appFavicon');
    if (favicon) favicon.href = `/app-icon.png?v=${Date.now()}`;
  }
}

// `앱 위치` — Dock 앱과 업데이트 파일의 경로(홈은 `~`). Finder의 `폴더로 이동`에 붙여 넣으라고만 알린다.
// 서버는 Finder를 열지 않는다 — 경로 글자만 준다(GET /api/about의 appBundle·updateFile).
function personalizePlace(about) {
  const lines = [['Dock 앱', about && about.appBundle], ['업데이트 파일', about && about.updateFile]]
    .filter(([, value]) => typeof value === 'string' && value)
    .map(([label, value]) => {
      const line = settingsEl('d-pplaceline');
      const name = document.createElement('span');
      name.className = 'lb';
      name.textContent = label;
      const code = settingsEl('d-icode');
      const text = document.createElement('code');
      text.textContent = value;
      code.append(text, settingsButton('복사', 'd-btn xs', () => settingsCopy(value, '경로를 복사했어요')));
      line.append(name, code);
      return line;
    });
  const body = lines.length
    ? [...lines, settingsEl('d-ismall', 'Finder에서 ⇧⌘G(폴더로 이동)에 붙여 넣으면 바로 가요')]
    : [settingsEl('d-ismall', '앱 위치를 읽지 못했어요.')];
  const place = personalizeRow('앱 위치', '파일을 찾을 때', ...body);
  place.className = 'd-pset d-pplace';
  place.dataset.focus = 'app-place';
  return place;
}

async function renderSettingsPersonalize() {
  const view = document.getElementById('settingsPersonalizeView');
  if (!view) return;
  view.replaceChildren(settingsEl('d-empty', '불러오는 중이에요…'));
  let state = null;
  let about = null;
  try { state = await (await request('/api/personalize')).json(); } catch { state = null; }
  try { about = await (await fetch('/api/about', { headers: { Accept: 'application/json' } })).json(); } catch { about = null; }
  view.replaceChildren();
  if (!state || state.ok !== true) {
    view.appendChild(settingsEl('d-empty', '꾸미기 값을 불러오지 못했어요.'));
    return;
  }
  let picked = null;   // 잘라 둔 PNG(base64) — 저장을 눌러야 서버로 간다

  // 1) Dock 아이콘
  const preview = settingsEl('d-piconslot');
  const current = document.createElement('img');
  current.className = 'd-piconimg';
  current.src = `/app-icon.png?v=${Date.now()}`;
  current.alt = state.customIcon ? '지금 아이콘(내 그림)' : '지금 아이콘(토끼)';
  preview.appendChild(current);
  const file = document.createElement('input');
  file.type = 'file';
  file.accept = 'image/png,image/jpeg';
  file.hidden = true;
  file.setAttribute('aria-label', 'Dock 아이콘 그림 고르기');
  const choose = settingsButton('내 그림 고르기', 'd-btn acc', () => file.click());
  const error = settingsErrorLine();
  const reset = settingsButton('기본으로 되돌리기', 'd-ablink', async () => {
    error.textContent = '';
    reset.disabled = true;
    const answer = await settingsIntegrationAsk('/api/personalize/icon', { reset: true }, '되돌리지 못했어요');
    if (!answer.ok) { error.textContent = answer.error; reset.disabled = false; return; }
    personalizeApply({ icon: true });
    personalizeSavedNote = { dock: true };
    await renderSettingsPersonalize();
  });
  reset.hidden = !state.customIcon;
  const iconLine = settingsEl('d-piconpv');
  iconLine.append(preview, choose, reset, file);
  const iconNote = settingsEl('d-ismall', 'PNG·JPG — 정사각형으로 잘라요');
  file.addEventListener('change', async () => {
    error.textContent = '';
    const one = file.files && file.files[0];
    const wrong = personalizeFileError(one);
    if (wrong) { error.textContent = wrong; file.value = ''; return; }
    try {
      const cropped = await personalizeCrop(one);
      picked = cropped.data;
      cropped.canvas.className = 'd-piconimg';
      cropped.canvas.setAttribute('role', 'img');
      cropped.canvas.setAttribute('aria-label', '고른 그림(가운데를 정사각형으로 잘랐어요)');
      preview.replaceChildren(cropped.canvas);
      iconNote.textContent = '가운데를 정사각형으로 잘랐어요 — 저장하면 Dock 아이콘이 돼요';
    } catch (problem) {
      error.textContent = (problem && problem.message) || '그림을 열지 못했어요';
    }
    file.value = '';
  });

  // 2) Dock 이름 · 3) 워크스페이스 제목
  const dock = document.createElement('input');
  dock.className = 'd-din';
  dock.value = state.dockName || 'Workspace';
  dock.maxLength = 30;
  dock.setAttribute('aria-label', 'Dock 이름');
  const title = document.createElement('input');
  title.className = 'd-din';
  title.value = state.title || '';
  title.maxLength = 40;
  title.setAttribute('aria-label', '워크스페이스 제목');

  const save = settingsButton('저장', 'd-btn pri');
  const run = async () => {
    error.textContent = '';
    const wrong = personalizeNameError(dock.value, title.value);
    if (wrong) { error.textContent = wrong; return; }
    const names = {};
    if (dock.value.trim() !== state.dockName) names.dockName = dock.value.trim();
    if (title.value.trim() !== state.title) names.title = title.value.trim();
    if (!picked && !Object.keys(names).length) { error.textContent = '바꾼 것이 없어요'; return; }
    save.disabled = true;
    let dockTouched = false;
    if (picked) {
      const answer = await settingsIntegrationAsk('/api/personalize/icon', { image: picked }, '그림을 저장하지 못했어요');
      if (!answer.ok) { error.textContent = answer.error; save.disabled = false; return; }
      personalizeApply({ icon: true });
      picked = null;
      dockTouched = true;
    }
    if (Object.keys(names).length) {
      const answer = await settingsIntegrationAsk('/api/personalize', names, '저장하지 못했어요');
      if (!answer.ok) { error.textContent = answer.error; save.disabled = false; return; }
      personalizeApply({ title: answer.title });
      dockTouched = dockTouched || answer.refresh === true;
    }
    personalizeSavedNote = { dock: dockTouched };
    await renderSettingsPersonalize();
  };
  save.addEventListener('click', run);
  settingsOnEnter(dock, run);
  settingsOnEnter(title, run);

  const foot = settingsEl('d-pfoot');
  foot.append(settingsEl('d-ismall', '이 맥에만 적용돼요 — 다른 사람 앱에는 영향이 없어요(업데이트해도 남아요)'), save);
  view.append(
    personalizeRow('Dock 아이콘', '', iconLine, iconNote),
    personalizeRow('Dock 이름', 'Dock·앱 전환에 보여요', dock),
    personalizeRow('워크스페이스 제목', '화면 왼쪽 위에 보여요', title),
    error, foot,
  );
  if (personalizeSavedNote) {
    const done = settingsEl('d-psaved');
    done.setAttribute('role', 'status');
    done.appendChild(document.createTextNode('✓ 바뀌었어요'));
    if (personalizeSavedNote.dock) {
      const more = document.createElement('span');
      more.textContent = ' · Dock은 앱을 닫고 다시 열면 보여요';
      done.appendChild(more);
    }
    view.appendChild(done);
    personalizeSavedNote = null;
  }
  const place = personalizePlace(about);
  view.appendChild(place);
  if (settingsFocusKey === 'app-place') {
    settingsFocusKey = null;
    place.classList.add('is-focus');
    if (typeof place.scrollIntoView === 'function') place.scrollIntoView({ block: 'center' });
  }
}

// ---------- 설정 > 도움말 맨 위의 사용설명서 ----------
// 오늘 탭의 사용설명서 카드를 닫았을 때만 선다 — 같은 네 줄(app.js의 guideRows)을 그대로 쓴다.
function renderSettingsManual() {
  const view = document.getElementById('settingsManualView');
  if (!view) return;
  view.replaceChildren();
  const closed = typeof guideCardClosed === 'function' && guideCardClosed();
  view.hidden = !closed;
  if (!closed || typeof guideRows !== 'function') return;
  const box = settingsEl('d-manual');
  box.setAttribute('role', 'region');
  box.setAttribute('aria-label', '사용설명서');
  box.append(settingsEl('hd', '사용설명서'), ...guideRows());
  view.appendChild(box);
}

// 도움말의 문답 하나로 데려간다(사용설명서의 `슬랙에서 보내는 법`). 잠깐 밝혀 어디인지 보이게 한다.
function settingsGuideShow(question) {
  const view = document.getElementById('settingsGuideView');
  if (!view || typeof view.querySelectorAll !== 'function') return null;
  const hit = [...view.querySelectorAll('[data-faq]')].find(node => node.dataset.faq === question) || null;
  if (!hit) return null;
  hit.classList.add('is-hit');
  hit.tabIndex = -1;
  if (typeof hit.scrollIntoView === 'function') hit.scrollIntoView({ block: 'start' });
  if (typeof hit.focus === 'function') hit.focus({ preventScroll: true });
  setTimeout(() => hit.classList.remove('is-hit'), 2400);
  return hit;
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
    ['Dock 아이콘·이름을 바꾸려면', '없음',
      '<b>설정 &gt; 꾸미기</b>에서 내 그림을 고르고(가운데를 정사각형으로 잘라요) Dock 이름·워크스페이스 제목을 적은 뒤 <b>저장</b>해요. 이 맥에만 적용되고 업데이트해도 남아요. Dock은 앱을 닫고 다시 열면 바뀌어 보여요.'],
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
    ['Claude 없이 캘린더를 붙이려면', '구글 캘린더',
      '<b>설정 &gt; 연동 &gt; 캘린더</b>의 <b>비밀 주소 붙이기</b>예요. 구글 캘린더 설정 → 내 캘린더의 설정 → 캘린더 통합 → <b>iCal 형식의 비공개 주소</b>를 복사해 붙이면 앱이 30분마다 직접 읽어요. 이 주소는 비밀번호처럼 다뤄요.'],
    ['슬랙에서 이렇게 보내요', '슬랙 연결',
      '<b>남의 메시지</b>는 ⋯ → <b>전달</b>(또는 공유)로 #my-todo 같은 내 채널에 보내요. 메모 한 줄을 같이 적으면 할 일 문구에 참고해요. <b>내 생각</b>은 그 채널에 그냥 적어도 돼요(한 메시지가 한 항목). 해야 할 일 → 할 일 · 답을 기다리는 것 → 기다리는 것 · 정해진 정책 → 정해진 것 · 참고거리 → 언젠가.'],
    ['슬랙에서 수집한 게 잘 들어왔는지 보려면', '슬랙 연결 + Claude Code',
      '<b>상태</b> 탭의 <b>슬랙 캡처</b> 줄 아래에 최근 수집 결과가 요약돼요 — 본 메시지 수와 등록·중복·건너뜀 개수, 건너뛴 문구까지 보여요. 메시지를 갈래로 나누고 스레드를 읽는 일은 Claude Code가 해요.'],
    ['지금 바로 새로 가져오고 싶어요', '그 연동 연결',
      '<b>설정 &gt; 연동</b>에서 연결된 카드의 <b>지금 가져오기</b>를 눌러요. 지라·캘린더(비밀 주소)는 곧바로 다시 읽고, 슬랙·캘린더(Claude)·티로는 요청을 남겨 1~2분 뒤 반영돼요. 같은 연동은 1분에 한 번이에요. 지금 못 읽고 있으면 버튼이 <b>다시 시도</b>로, 토큰·주소 문제면 <b>다시 연결</b>로 바뀌어요.'],
    ['머리줄의 `○일 전 기준`이나 톱니 점은 뭔가요', '없음',
      '자동 동기화가 최근에 못 돌았다는 뜻이에요. <b>주황 점</b>은 낡음, <b>빨간 점</b>은 지금 실패 중, <b>파란 점</b>은 새 버전이 나왔다는 뜻이에요. 눌러서 <b>상태</b> 탭에서 그 줄을 바로 봐요.'],
  ]],
  ['문제가 생기면', [
    ['실수로 지웠는데 알림이 이미 사라졌으면', '없음',
      '<b>삭제한 항목</b> 탭에서 되살려요. 지운 항목은 원문 그대로 남고 저절로 사라지는 건 없어요. <b>완전히 지우기</b>만 되돌릴 수 없어서 한 번 더 물어봐요.'],
    ['앱이 이상하게 동작하면', '없음',
      '<b>상태</b> 탭 맨 아래 <b>문제 보고</b>를 누르면 버전·연동 상태·최근 오류 줄이 클립보드에 복사돼요. 업무 내용은 들어가지 않으니 그대로 슬랙에 붙여 넣어 주세요.'],
    ['앱에서 업데이트하기', '없음',
      '새 버전이 나오면 <b>상태</b> 탭 맨 아래에 <b>업데이트 받기</b>가 떠요. 누르면 데이터 백업 → 받기 → 다시 시작 → 확인까지 1분쯤 걸리고, 진행을 그 자리에서 보여 줘요. 끝나면 <b>새로고침</b>을 눌러 주세요. 실패하면 저절로 되돌리지 않고 <b>이전 버전으로 되돌리기</b>를 보여 줘요. 폴더를 옮겨야 하거나 처음 한 번은 앱 폴더의 <b>업데이트.command</b>를 더블클릭해요.'],
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
      // 사용설명서의 `슬랙에서 보내는 법`이 이 표지로 문답을 찾아간다(settingsGuideShow).
      q.dataset.faq = question;
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
  document.getElementById('settingsPersonalizeView').hidden = tab !== 'personalize';
  document.getElementById('settingsManualView').hidden = tab !== 'guide';
  document.getElementById('settingsGuideView').hidden = tab !== 'guide';
  document.getElementById('settingsTrashView').hidden = tab !== 'trash';
  if (tab === 'guide') { renderSettingsManual(); renderSettingsGuide(); }
  if (tab === 'personalize') renderSettingsPersonalize();
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

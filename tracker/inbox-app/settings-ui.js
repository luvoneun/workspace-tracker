// 설정 창 한 벌 — 연동 탭(연결 상태를 보는 유일한 곳: 맨 위 요약 · 카드 넷 · 카드마다 ⋯ › 최근 기록 · 슬랙 채널 고르기),
// 앱 탭(버전·업데이트 · 데이터 백업 · 앱 위치 · 문제 보고), 꾸미기 탭, 도움말 탭(개념 사전 + 문답), 삭제한 항목 탭, 창 열고 닫기.
// app.js의 공용 부품(request·showNotice·uiIcon·escPush·escDrop·uiMenuClose·latestData)에 기댄다.
// 맨 아래 몇 줄은 화면 요소를 바로 잡아 쓰므로 index.html의 <body> 끝(app.js 바로 앞)에서 읽힌다.

// 설정 › 연동 › 슬랙 ⋯ › 최근 기록 맨 위의 처리 대장 한 줄(BNOTES). 슬랙 수집 지침이 실행마다 로그 맨 앞에 남기는
// `이번에 본 메시지 N개 = 등록 a · 링크 중복 b · 비슷한 일이라 건너뜀 c · 시스템 d`(또는 합이 안 맞을
// 때의 `합이 안 맞습니다 …`) 문장을 tail(최근 60줄)에서 가장 최근 것 하나만 찾는다. 그 실행(같은
// 시작~종료 블록) 안의 `🔁 이미 있는 '…'랑 중복돼서 안 가져왔어요`(건너뛴 것, 최대 3개)와 `⚠️`로
// 시작하는 줄(원문 못 읽음·파일만 있는 메시지, 최대 2개)도 함께 뽑는다. 문장이 없으면(옛 로그·처리
// 대장이 없던 실행) null을 돌려주고, 그 자리는 아무것도 그리지 않는다.
const SLACK_LEDGER_RE = /^이번에 본 메시지 (\d+)개 = 등록 (\d+) · 링크 중복 (\d+) · 비슷한 일이라 건너뜀 (\d+) · 시스템 (\d+)$/;
const SLACK_MISMATCH_RE = /^합이 안 맞습니다.*$/;
const SLACK_SKIP_RE = /^🔁\s*이미 있는\s*'(.+)'\s*랑 중복돼서 안 가져왔어요/;
const SLACK_WARN_RE = /^⚠️/;
const SLACK_BLOCK_START_RE = /^(?:\{[^{}]*\}\s*)*─+ \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \S+ 시작$/;
const SLACK_BLOCK_END_RE = /^(?:\{[^{}]*\}\s*)*─+ \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \S+ 종료 \(exit -?\d+\)$/;

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

// 위 결과를 슬랙 카드의 최근 기록 위 조용한 줄(들)로 만든다 — 합이 안 맞으면 그 문장을 주의색으로
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

// ---------- 설정 공용: 시각 · 실패 문구 ----------

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
// 지금 멈춘 연동(`slack`·`jira`·`calendar`·`notes`) — 서버가 연동 탭 요약과 같은 판단으로 준다(톱니바퀴의 빨간 점).
let settingsAlertKeys = [];

async function fetchAutomationStatus() {
  let alerts = null;
  try {
    const data = await request('/api/automation/status').then(r => r.json());
    automationStatusCache = data.automations || [];
    alerts = Array.isArray(data.alerts) ? data.alerts : null;
  } catch {
    automationStatusCache = [];
  }
  // 옛 서버(alerts 없음)면 예전처럼 자동화의 가장 최근 실행이 실패인 것만 본다.
  settingsAlertKeys = alerts || automationStatusCache.filter(a => a.lastKind === 'fail').map(a => (a.key === 'tiro' ? 'notes' : a.key));
  // 안 열어봐도 톱니바퀴만 보고 "확인할 게 있다"를 알 수 있게 점을 켠다
  // 지금 실제로 실패 중인 게 있을 때만 — 예전에 있었다가 해결된 건 알림이 아니다
  document.getElementById('settingsBtn')?.classList.toggle('has-alert', settingsAlertKeys.length > 0);
  return automationStatusCache;
}

// 설정을 연 뒤 한 번만 쓰는 표지 — `alerts`(빨간 점을 눌렀다: 멈춘 카드를 잠깐 붉게) · `log:<카드>`(그 카드의
// 최근 기록을 편다) · `app-place`(앱 탭의 앱 위치를 밝힌다).
let settingsFocusKey = null;

const AUTOMATION_STATE_WORD = { run: '성공', fail: '실패', skip: '건너뜀' };

// ---------- 설정 › 앱: 버전 · 새 버전 · 문제 보고 ----------
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

// ---------- 설정 › 앱 탭(시안 D) ----------
// 앱 자체의 일만 네 줄 — `버전`(새 버전·진행·다시 시도·되돌리기·막는 경우는 아래 "앱 안에서 업데이트 받기") ·
// `데이터 백업` · `앱 위치`(파일을 찾을 때) · `문제 보고`. 줄 모양은 꾸미기 탭과 같은 `.d-pset`(이름 | 값)이다.
const SETTINGS_CHANNEL_WORD = { stable: '배포된 버전만 받기', main: '만드는 중인 것까지 받기(main)' };

// id로 다시 찾는 자리(settingsAboutFill·settingsUpdatePaint가 쓴다) — 이미 그려 둔 것이 있으면 비워서 다시 쓴다.
function settingsSlot(id, className) {
  const node = document.getElementById(id) || document.createElement('div');
  node.id = id;
  node.className = className;
  node.replaceChildren();
  node.hidden = false;
  return node;
}

// 버전 줄의 자리만 먼저 세운다(값은 settingsAboutFill이 채운다).
function settingsVersionRow() {
  const line = settingsSlot('settingsAboutLine', 'd-abline');
  line.textContent = '앱 정보를 읽는 중이에요…';
  const files = settingsSlot('settingsAboutFiles', 'd-abfiles');
  files.hidden = true;
  const update = settingsSlot('settingsAboutUpdate', 'd-abwrap');
  update.hidden = true;
  const row = personalizeRow('버전', '워크스페이스', line, files, update);
  row.dataset.row = 'version';
  return row;
}

function settingsReportRow() {
  const report = settingsButton('진단 내용 복사', 'd-btn', null);
  report.id = 'settingsReportBtn';
  report.addEventListener('click', () => settingsReportCopy(report));
  const row = personalizeRow('문제 보고', '', report,
    settingsEl('d-ismall', '버전·연동 상태·최근 오류만 복사해요(업무 내용은 들어가지 않아요).'));
  row.dataset.row = 'report';
  return row;
}

// ---------- 설정 › 앱 › 데이터 백업 ----------
// 매일 19:30 이 맥 안(`~/workspace-data-backup/daily`)에 7일치 + GitHub 백업을 켠 사람은 비공개 저장소에도 한 겹 더.
// 서버(GET /api/backup)는 백업 로그와 날짜 폴더 목록만 읽어 준다 — 아무것도 실행하지 않는다.
let settingsBackup = null;

async function settingsBackupLoad() {
  try {
    const response = await fetch('/api/backup', { headers: { Accept: 'application/json' } });
    settingsBackup = response.ok ? await response.json() : null;
  } catch { settingsBackup = null; }
  return settingsBackup;
}

// 로그 시각(`YYYY-MM-DD HH:MM:SS`, 이 맥의 시각) → `오늘 19:30` · `어제 19:30` · `9월 20일 19:30`.
function settingsBackupWhen(stamp, now = new Date()) {
  const hit = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(String(stamp || ''));
  if (!hit) return '';
  const day = new Date(Number(hit[1]), Number(hit[2]) - 1, Number(hit[3]));
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((today - day) / 86400000);
  const time = `${hit[4]}:${hit[5]}`;
  if (diff === 0) return `오늘 ${time}`;
  if (diff === 1) return `어제 ${time}`;
  return `${Number(hit[2])}월 ${Number(hit[3])}일 ${time}`;
}

// 한 줄 — 앞에 색 점(● 초록 = 잘 됨, 빨강 = 멈춤)을 붙인다.
function settingsBackupLine(text, state) {
  const line = settingsEl('d-bkline' + (state === 'bad' ? ' k-neg' : ''));
  if (state) {
    const dot = document.createElement('span');
    dot.className = state === 'bad' ? 'bad' : 'ok';
    dot.setAttribute('aria-hidden', 'true');
    dot.textContent = '●';
    line.append(dot, document.createTextNode(` ${text}`));
  } else {
    line.textContent = text;
  }
  return line;
}

function settingsBackupNodes(data, now = new Date()) {
  if (!data || data.ok === false || !data.local) return [settingsEl('d-ismall', '백업 상태를 읽지 못했어요.')];
  const nodes = [];
  const local = data.local;
  const when = settingsBackupWhen(local.at, now);
  if (local.state === 'fail') {
    nodes.push(settingsBackupLine(['이 맥 백업이 멈췄어요', when].filter(Boolean).join(' · '), 'bad'));
    nodes.push(settingsEl('d-ismall k-neg', local.reason || '이유를 알 수 없어요'));
  } else if (local.state === 'never') {
    // 매일 19:30에 돈다 — 오늘 그 시각이 지났으면 내일이 처음이다.
    const late = now.getHours() * 60 + now.getMinutes() >= 19 * 60 + 30;
    nodes.push(settingsBackupLine(`${late ? '내일' : '오늘'} 19:30에 처음 백업해요`, null));
  } else {
    nodes.push(settingsBackupLine(['이 맥에 매일 백업', when, `${Number(local.days) || 0}일치`].filter(Boolean).join(' · '), 'ok'));
  }
  if (data.github && data.github.on) {
    const github = data.github;
    const at = settingsBackupWhen(github.at, now);
    if (github.state === 'fail') {
      nodes.push(settingsBackupLine(['GitHub에 올리지 못했어요', at].filter(Boolean).join(' · '), 'bad'));
      nodes.push(settingsEl('d-ismall k-neg', github.reason || '이유를 알 수 없어요'));
    } else {
      nodes.push(settingsEl('d-ismall', ['GitHub 비공개 저장소에도 올려요', github.state === 'ok' ? at : ''].filter(Boolean).join(' · ')));
    }
  }
  if (typeof data.path === 'string' && data.path) {
    const code = settingsEl('d-icode');
    const text = document.createElement('code');
    text.textContent = data.path;
    code.append(text, settingsButton('복사', 'd-btn xs', () => settingsCopy(data.path, '경로를 복사했어요')));
    nodes.push(code, settingsEl('d-ismall', 'Finder에서 ⇧⌘G(폴더로 이동)에 붙여 넣으면 바로 가요'));
  }
  return nodes;
}

function settingsBackupRow(data) {
  const row = personalizeRow('데이터 백업', '매일 19:30', ...settingsBackupNodes(data));
  row.dataset.row = 'backup';
  return row;
}

async function renderSettingsApp() {
  const view = document.getElementById('settingsAppView');
  if (!view) return;
  view.replaceChildren(settingsEl('d-empty', '불러오는 중이에요…'));
  const [about, backup] = await Promise.all([settingsAboutLoad(), settingsBackupLoad()]);
  const place = personalizePlace(about);
  view.replaceChildren(settingsVersionRow(), settingsBackupRow(backup), place, settingsReportRow());
  settingsAboutFill();
  if (settingsFocusKey === 'app-place') {
    settingsFocusKey = null;
    place.className = `${place.className} is-focus`;
    if (typeof place.scrollIntoView === 'function') place.scrollIntoView({ block: 'center' });
  }
}

function settingsAboutFill() {
  const line = document.getElementById('settingsAboutLine');
  if (!line) return;
  const info = settingsAbout;
  line.replaceChildren();
  if (!info) { line.textContent = '앱 정보를 읽지 못했어요.'; return; }
  const parts = [info.version ? `v${info.version}` : '버전 모름', SETTINGS_CHANNEL_WORD[info.channel === 'main' ? 'main' : 'stable']];
  // 개발용(저장소에서 직접 띄운 것)일 때만 적는다 — 설치본은 기본이라 말할 것이 없다.
  if (info.install !== 'managed') parts.push('개발용');
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

  // 도는 업데이트가 있으면(창을 다시 열었거나 앱 탭이 다시 그려졌을 때) 그 진행을 그대로 이어 보여 준다.
  if (settingsUpdateRun) { settingsUpdatePaint(settingsUpdateRun.view); return; }
  const offer = settingsUpdateOffer(info);
  settingsUpdatePaint(offer ? { kind: 'offer', offer } : { kind: 'none' });
  settingsUpdateResume();
}

// ---------- 설정 › 앱: 앱 안에서 업데이트 받기(시안 J) ----------
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
  untouched: '업데이트하지 못했어요 — 앱과 데이터는 그대로예요',
};
const SETTINGS_UPDATE_ROLLBACK_FROM_STEP = 3;
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
    // ①② 단계(고친 파일 확인·데이터 백업)에서 멈췄으면 코드는 그대로다 — 되돌릴 것이 없으니 `다시 시도`만 둔다.
    // `이전 버전으로 되돌리기`는 ③ 새 버전 받기 이후에서 멈췄을 때만(서버도 같은 기준으로만 받는다).
    if (!(Number(view.step) >= SETTINGS_UPDATE_ROLLBACK_FROM_STEP)) {
      text.textContent = SETTINGS_UPDATE_WORDS.untouched;
      box.append(text, settingsButton('다시 시도', 'd-btn sm pri', () => settingsUpdateAsk('update')));
      return view.message ? [box, settingsEl('d-ismall d-abquiet', view.message)] : [box];
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
    settingsUpdatePaint({ kind: 'failed', action: status.action || run.action, step: status.step, message: status.message, updateFile: data.updateFile });
    return;
  }
  settingsUpdatePaint({ kind: 'progress', run, steps: settingsUpdateSteps(run.action, status), down: false });
  run.timer = setTimeout(settingsUpdatePoll, SETTINGS_UPDATE_POLL_MS);
}

// 앱 탭을 열 때 한 번 — 다른 창에서 시작했거나 창을 닫았다 연 경우에도 도는 업데이트를 이어 보여 준다.
async function settingsUpdateResume() {
  let data = null;
  try {
    const response = await fetch('/api/update/status', { headers: { Accept: 'application/json' } });
    if (response.ok) data = await response.json();
  } catch { data = null; }
  if (!data || !data.running || settingsUpdateRun) return;
  settingsUpdateFollow((data.status && data.status.action) || (data.pending && data.pending.action) || 'update', data.status, 0);
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

// 채널 하나를 만들어 달라고 서버에 부탁한다. 토큰을 비워 보내면(`채널 고르기`) 서버가 저장된 토큰을 쓴다.
async function settingsSlackCreateChannel(token, name) {
  return settingsIntegrationAsk('/api/integrations/slack-channel', { token, name }, '슬랙에서 채널을 만들지 못했어요');
}

// 토큰이 맞는지 본다 — 맞으면 새 채널 이름의 앞머리(`prefix`, 슬랙 사용자 이름을 채널 이름 규칙대로 다듬은 것)도 온다.
// 토큰을 비워 보내면(채널 고르기) 서버가 저장된 토큰으로 앞머리만 알려 준다.
async function settingsSlackTokenCheck(token) {
  return settingsIntegrationAsk('/api/integrations/slack-token-check', { token }, '토큰을 확인하지 못했어요');
}

// 새 채널 이름의 기본값 — `<앞머리>-todo`처럼. 앞머리를 모르면 `my`다(이미 연결된 채널의 이름은 바꾸지 않는다).
const settingsSlackPrefix = value => settingsSlackChannelName(value).replace(/^[-_]+|[-_]+$/g, '').slice(0, 72) || 'my';
const settingsSlackDefaultName = (key, prefix = 'my') => `${settingsSlackPrefix(prefix)}-${key}`;

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

// `alert`는 지금 멈춘 카드의 { status(상태 줄을 이 말로 빨갛게 — 없으면 `읽지 못했어요 · N분 전`), why(그 아래 이유 한 줄의 글 조각) }.
// ---------- 멈춤 이유 · 최근 기록 ----------
// 로그 한 줄(영어·기계 말)을 사람 말 한 마디로. 모르는 것은 억지로 번역하지 않고 줄여서 그대로 둔다.
function settingsFailWords(text) {
  const raw = String(text || '');
  if (/invalid_auth|token_revoked|account_inactive/.test(raw)) return '토큰이 만료됐거나 권한이 없어요';
  if (/channel_not_found|is_archived/.test(raw)) return '채널을 찾을 수 없어요';
  if (/슬랙 토큰을 읽을 수 없음/.test(raw)) return '토큰 파일을 읽지 못했어요';
  if (/설정된 채널을 읽을 수 없음/.test(raw)) return '설정에서 채널을 읽지 못했어요';
  if (/fetch 실패|ERR:/.test(raw)) return '슬랙이 응답하지 않았어요';
  if (/35분이 넘도록|timed? ?out/i.test(raw)) return '너무 오래 걸려 멈췄어요';
  const plain = trimSummaryText(translateFailureText(raw));
  return plain || '이유를 알 수 없어요';
}

// 멈춘 카드의 이유 한 줄. 토큰 문제면 버튼이 이미 `다시 연결`이라 그 말을, 아니면 최근 기록으로 안내한다.
function settingsFailWhy(kind, state = {}) {
  if (state.auth) {
    return [kind === 'calendar'
      ? '비밀 주소를 읽을 수 없어요 — 다시 연결을 누르면 주소를 다시 붙여요'
      : '토큰이 만료됐거나 권한이 없어요 — 다시 연결을 누르면 이 카드에서 토큰 단계부터 다시 열려요'];
  }
  const words = { jira: '지라가 응답하지 않았어요', calendar: '캘린더를 읽지 못했어요' };
  const reason = state.summary ? settingsFailWords(state.summary) : (words[kind] || '읽지 못했어요');
  return [`${reason} — 다시 시도해도 안 되면 ⋯ › 최근 기록`];
}

// 로그 시각(`YYYY-MM-DD HH:MM:SS`) → 오늘이면 `10:05`, 아니면 `9/23 10:05`.
function settingsLogTime(stamp, now = new Date()) {
  const hit = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(String(stamp || ''));
  if (!hit) return '';
  const same = Number(hit[1]) === now.getFullYear() && Number(hit[2]) === now.getMonth() + 1 && Number(hit[3]) === now.getDate();
  return same ? `${hit[4]}:${hit[5]}` : `${Number(hit[2])}/${Number(hit[3])} ${hit[4]}:${hit[5]}`;
}

// 기록 한 줄의 결과 말. 앱이 직접 읽는 것(지라·비밀 주소)은 서버가 이미 사람 말로 준다.
function settingsLogText(kind, entry) {
  const text = String(entry.text || '');
  if (entry.kind === 'fail') return /^읽지 못했어요/.test(text) ? text : `읽지 못했어요 — ${settingsFailWords(text)}`;
  if (/^읽음/.test(text)) return text;
  if (entry.kind === 'skip') {
    if (/새 메시지 없음/.test(text)) return '읽음 · 새 것 없음';
    return trimSummaryText(text) || '건너뜀';
  }
  const done = kind === 'notes' ? '가져옴' : '읽음';
  // 슬랙 실행 블록 맨 앞의 처리 대장 문장은 목록 위에 따로 서므로 한 줄 결과에서는 뺀다.
  const summary = trimSummaryText(text.replace(/이번에 본 메시지 \d+개 = 등록 \d+ · 링크 중복 \d+ · 비슷한 일이라 건너뜀 \d+ · 시스템 \d+\s*/, '')
    .replace(/합이 안 맞습니다[^\n]*?\)\s*/, '').trim());
  return summary && summary !== '완료' ? `${done} · ${summary}` : done;
}

// `오류 전문 복사`에 넣을 글 — 최근 기록 줄 + (자동화면) 로그 끝 60줄. 토큰은 로그에 없다(수집이 싣지 않는다).
function settingsLogFull(kind, name, entries) {
  const key = { slack: 'slack', calendar: 'calendar', notes: 'tiro' }[kind];
  const automation = key ? (automationStatusCache || []).find(a => a.key === key) : null;
  const lines = entries.map(entry => `${entry.time} · ${AUTOMATION_STATE_WORD[entry.kind] || '실행'} · ${entry.text}`);
  const tail = automation && Array.isArray(automation.tail) ? automation.tail : [];
  return [`${name} 최근 기록`, ...lines, ...(tail.length ? ['', '로그 끝 부분:', ...tail] : [])].join('\n');
}

// ⋯ › 최근 기록 — 카드 아래 접이식 목록(시각 · 결과 한 줄, 최근 10개, 실패는 빨강) + `오류 전문 복사`.
// 슬랙은 맨 위에 최근 수집의 처리 대장(본 메시지·등록·중복·건너뜀)을 먼저 보인다.
function settingsIntgLog(card, kind, name, entries = [], lead = []) {
  const list = document.createElement('ul');
  list.className = 'd-ilog';
  list.setAttribute('aria-label', `${name} 최근 기록`);
  entries.slice(0, 10).forEach((entry) => {
    const row = document.createElement('li');
    const time = document.createElement('span');
    time.className = 't';
    time.textContent = settingsLogTime(entry.time);
    const text = document.createElement('span');
    if (entry.kind === 'fail') text.className = 'bad';
    text.textContent = settingsLogText(kind, entry);
    row.append(time, text);
    list.appendChild(row);
  });
  if (!entries.length) {
    const row = document.createElement('li');
    row.textContent = '아직 기록이 없어요';
    list.appendChild(row);
  }
  const more = document.createElement('li');
  more.className = 'more';
  more.appendChild(settingsButton('오류 전문 복사', 'd-ablink',
    () => settingsCopy(settingsLogFull(kind, name, entries.slice(0, 10)), '오류 전문을 복사했어요')));
  list.appendChild(more);
  card.body.append(...lead, list);
}

// 메뉴의 `최근 기록` 한 칸(기록이 하나도 없으면 칸 자체를 숨긴다).
const settingsLogItem = (card, log) => (Array.isArray(log) && log.length ? [{ label: '최근 기록', onClick: () => card.open('log') }] : []);

function settingsIntgCard({ kind, name, chip, use, need, needClass = '', status = null, openText = '연결하기', openClass = 'd-btn acc', menu = null, extra = [], fetch: fetchSpec = null, alert = null, onOpen }) {
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
    if (alert && alert.status) paint(alert.status, true);
  }
  const toggle = settingsButton(openText, openClass);
  top.appendChild(toggle);
  // 지금 가져오기 — 연결된 카드에만, 상태 줄 오른쪽 · ⋯ 왼쪽.
  if (fetchSpec && paint) top.appendChild(settingsFetchButton(fetchSpec, paint));
  if (menu) top.appendChild(uiMoreButton(`${name} 더 보기`, menu));

  // 멈춘 카드는 상태 줄 아래 이유 한 줄(빨강)이 먼저 선다(시안 B).
  const why = [];
  if (alert && alert.why) {
    row.dataset.failing = 'true';
    const line = settingsEl('d-intgwhy');
    line.setAttribute('role', 'status');
    alert.why.forEach(part => line.appendChild(typeof part === 'string' ? document.createTextNode(part) : part));
    why.push(line);
  }
  const useLine = settingsEl('d-intguse', use);
  const needLine = settingsEl(`d-intgneed${needClass ? ` ${needClass}` : ''}`);
  if (Array.isArray(need)) settingsRich(needLine, need); else needLine.textContent = need || '';
  const confirmSlot = settingsEl('d-iconfirmslot');
  const body = settingsEl('d-intgbody');
  body.hidden = true;
  row.append(top, ...why, useLine, needLine, ...extra, confirmSlot, body);

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

// 위저드 한 벌. mode: `new`(처음 연결) · `token`(다시 연결 — 토큰부터). 채널 더하기·빼기는 따로(settingsSlackPick).
function settingsSlackWizard(card, data, mode = 'new') {
  const slack = data.slack || {};
  const saved = slack.channels || {};
  // 이미 연결돼 있고 슬랙에서 읽히는 채널 — ②에서 체크된 채 `#이름 연결됨`으로만 보이고 바꿀 수 없다.
  const linked = key => mode !== 'new' && !!(saved[key] && saved[key].id && !saved[key].missing);
  const state = {
    step: 0,
    token: '',
    prefix: 'my',
    picks: Object.fromEntries(SETTINGS_SLACK_CHANNELS.map(([key]) => [key, {
      on: linked(key) || (mode === 'new' && (key === 'todo' || key === 'waiting')),
      name: settingsSlackDefaultName(key),
      touched: false,
    }])),
    made: {},
    rowErrors: {},
    error: '',
  };
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
      // 새 채널의 기본 이름은 `<슬랙 사용자 이름>-todo`처럼 — 사람이 이미 고친 이름은 그대로 둔다.
      state.prefix = settingsSlackPrefix(checked.prefix);
      Object.entries(state.picks).forEach(([key, pick]) => { if (!pick.touched) pick.name = settingsSlackDefaultName(key, state.prefix); });
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
    settingsRich(how, ['슬랙에 공유한 메시지를 ', ['b', '어디로 받을지'], ' 골라요. 고른 만큼 나만 있는 비공개 채널을 만들어 드려요. 이름은 바꿔도 돼요 — 나중에 슬랙에서 바꿔도 그대로 이어져요.']);
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
          pick.touched = true;
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
      const { made, stop } = await settingsSlackMakeChannels(state.token, keys, state);
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
      settingsRich(later, ['나중에 더하거나 빼고 싶으면 설정 › 연동 › 슬랙 ⋯ › ', ['b', '채널 고르기'], '.']);
      wrap.appendChild(later);
    }
    error.textContent = state.error || '';
    wrap.appendChild(error);
    const back = settingsButton('← 이전', 'd-btn sm', () => { state.step = 0; draw(); });
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

  draw();
  return state;
}

// 고른 줄마다 채널을 차례로 만든다(위저드 ②와 채널 고르기가 같이 쓴다). 만든 것은 `state.made`에 남고,
// 이름이 겹치면 그 줄에, 권한·토큰 문제는 남은 줄도 똑같이 실패하므로 멈추고 한 줄(`stop`)로 돌려준다.
async function settingsSlackMakeChannels(token, keys, state) {
  let stop = '';
  for (const key of keys) {
    const nameWanted = settingsSlackChannelName(state.picks[key].name);
    const result = await settingsSlackCreateChannel(token, nameWanted);
    if (result && result.ok === true) {
      state.made[key] = { id: result.id, name: result.name || nameWanted };
      state.rowErrors[key] = '';
      continue;
    }
    const code = (result && result.code) || '';
    if (code === 'name_taken') { state.rowErrors[key] = SETTINGS_SLACK_TAKEN; continue; }
    if (code === 'missing_scope' || code === 'invalid_auth') { stop = result.error; break; }
    state.rowErrors[key] = (result && result.error) || '슬랙에서 채널을 만들지 못했어요';
  }
  return { made: Object.keys(state.made).length, stop };
}

// ---------- 슬랙 ⋯ › 채널 고르기(시안 E·F) ----------
// 한 화면에서 **더하기·빼기**. 연결된 채널은 체크된 줄에 이름을 고정 글자(`#이름` + `연결됨`)로만 보이고
// (이름은 슬랙에서 바꾼다 — 앱이 따라간다), 새로 고른 줄에만 이름 칸이 선다. `할 일`은 뺄 수 없다.
// - 빼기: 설정에서 지우지 않고 `off`로 표시만 한다(슬랙 채널·이미 들어온 항목은 그대로). 누르기 전에 확인 줄이 선다.
// - 뺐던 채널을 다시 체크: 새로 만들지 않고 같은 채널을 다시 켠다 — 그때부터 읽는다(뺀 동안 온 메시지는 가져오지 않는다).
// - 사라진 채널(슬랙에서 지웠거나 보관): 체크한 채로 두면 다시 만들고, 풀면 뺀다(할 일은 다시 만들기만).
const SETTINGS_SLACK_BACK = '다시 연결했어요 — 뺀 동안 온 메시지는 가져오지 않아요';

// 줄마다 지금 할 일 — `keep`(그대로) · `add`(새로·다시 만들기) · `back`(뺐던 채널 다시 켜기) · `off`(빼기) · `none`.
function settingsSlackPickAction(pick) {
  if (pick.linked) return pick.on ? 'keep' : 'off';
  if (pick.gone) return pick.on ? 'add' : 'off';
  if (pick.back) return pick.on ? 'back' : 'none';
  return pick.on ? 'add' : 'none';
}

// 주 버튼 문구 — `1개 만들기` · `1개 빼기` · `1개 만들고 1개 빼기`(다시 켜기는 `1개 다시 연결하기`).
function settingsSlackPickLabel(plan) {
  const parts = [[plan.add.length, '만들'], [plan.back.length, '다시 연결하'], [plan.off.length, '빼']].filter(([count]) => count);
  if (!parts.length) return '';
  return parts.map(([count, stem], index) => `${count}개 ${stem}${index === parts.length - 1 ? '기' : '고'}`).join(' ');
}

function settingsSlackPick(card, data) {
  const slack = data.slack || {};
  const saved = slack.channels || {};
  const offs = slack.off || {};
  const state = { prefix: 'my', picks: {}, made: {}, rowErrors: {}, error: '', focus: null };
  SETTINGS_SLACK_CHANNELS.forEach(([key]) => {
    const one = saved[key] || {};
    const off = offs[key] || null;
    state.picks[key] = {
      on: !!one.id,
      linked: !!one.id && !one.missing,
      gone: !!one.id && !!one.missing,
      back: !one.id && !!off && !off.missing,
      label: one.name || (off && off.name) || '',
      name: settingsSlackDefaultName(key),
      touched: false,
    };
  });
  const plan = () => {
    const out = { add: [], back: [], off: [] };
    SETTINGS_SLACK_CHANNELS.forEach(([key]) => {
      const act = settingsSlackPickAction(state.picks[key]);
      if (act === 'add' || act === 'back' || act === 'off') out[act].push(key);
    });
    return out;
  };

  function draw() {
    card.body.replaceChildren();
    const how = document.createElement('p');
    how.className = 'd-ihow';
    settingsRich(how, ['받을 곳을 ', ['b', '더하거나 빼요'], '. 새로 고른 곳은 비공개 채널을 만들어 드려요.']);
    const list = settingsEl('d-ichlist');
    const boxes = {};
    const inputs = {};
    SETTINGS_SLACK_CHANNELS.forEach(([key, name, where]) => {
      const pick = state.picks[key];
      const act = settingsSlackPickAction(pick);
      const made = state.made[key];
      const row = document.createElement('label');
      row.className = 'd-ich' + (act === 'off' ? ' is-off' : (pick.on ? ' is-on' : '')) + (pick.gone && pick.on ? ' is-gone' : '');
      row.dataset.channel = key;
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = pick.on;
      box.disabled = key === 'todo';
      box.setAttribute('aria-label', `${name} 받기`);
      boxes[key] = box;
      const text = document.createElement('span');
      text.className = 't';
      const strong = document.createElement('b');
      strong.textContent = name;
      text.appendChild(strong);
      if (key === 'todo') {
        const need = document.createElement('span');
        need.className = 'need';
        need.textContent = '필수 — 뺄 수 없어요';
        text.append(document.createTextNode(' '), need);
      }
      const sub = document.createElement('span');
      sub.className = 'd-ismall sub';
      if (act === 'off') { sub.className = 'd-ismall sub k-neg'; sub.textContent = '빼요'; }
      else if (act === 'add' && pick.gone) sub.textContent = `${pick.label || '채널'}을 찾을 수 없어요 — 체크한 채로 두면 다시 만들어요`;
      else if (act === 'add') sub.textContent = '새로 만들어요';
      else if (act === 'back') sub.textContent = '다시 연결해요 — 뺀 동안 온 메시지는 가져오지 않아요';
      else settingsRich(sub, where);
      text.appendChild(sub);
      row.append(box, text);
      if (made) {
        const done = document.createElement('span');
        done.className = 'nm is-done';
        done.textContent = `✓ #${made.name} 만들었어요`;
        row.appendChild(done);
      } else if (pick.linked || pick.back) {
        // 연결된(또는 뺐던) 채널의 이름은 여기서 바꾸지 않는다 — 고정 글자로만.
        const lock = document.createElement('span');
        lock.className = 'lock';
        lock.appendChild(document.createTextNode(pick.label || '채널'));
        const small = document.createElement('small');
        small.textContent = pick.linked ? '연결됨' : '뺀 채널';
        lock.appendChild(small);
        row.appendChild(lock);
      } else {
        const field = document.createElement('span');
        field.className = 'nmwrap';
        const small = document.createElement('small');
        small.textContent = '새 채널 이름';
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'd-din nm';
        input.value = pick.name;
        input.disabled = !pick.on;
        input.setAttribute('aria-label', `${name} 새 채널 이름`);
        input.addEventListener('input', () => {
          const clean = settingsSlackChannelName(input.value);
          if (clean !== input.value) input.value = clean;
          pick.name = input.value;
          pick.touched = true;
          if (state.rowErrors[key]) { state.rowErrors[key] = ''; rowError.textContent = ''; }
        });
        settingsOnEnter(input, () => go.click());
        inputs[key] = input;
        field.append(small, input);
        row.appendChild(field);
      }
      box.addEventListener('change', () => {
        pick.on = !!box.checked;
        state.focus = key;
        draw();
      });
      const rowError = settingsErrorLine();
      rowError.classList.add('d-icherr');
      rowError.textContent = state.rowErrors[key] || '';
      row.appendChild(rowError);
      list.appendChild(row);
    });

    const note = settingsEl('d-inote');
    const mark = document.createElement('span');
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = 'ⓘ';
    note.append(mark, settingsRich(document.createElement('span'), [
      '연결된 채널의 ', ['b', '이름은 여기서 바꿀 수 없어요.'], ' 슬랙에서 채널 이름을 바꾸면 앱이 알아서 새 이름을 따라가요.',
    ]));

    const now = plan();
    const nodes = [how, list, note];
    // 누르기 전에 확인 줄 — 빼는 채널이 있으면(슬랙 채널·들어온 항목은 그대로라는 말과 함께).
    if (now.off.length) {
      const confirm = settingsEl('d-iconfirm');
      const words = document.createElement('span');
      words.className = 'tx';
      const names = now.off.map(key => state.picks[key].label || settingsSlackLabel(key)).join(', ');
      words.textContent = `${names}을 빼면 앱이 이 채널을 더 이상 읽지 않아요. 슬랙 채널과 이미 들어온 항목은 그대로예요.`;
      confirm.appendChild(words);
      nodes.push(confirm);
    }
    if (now.back.length) {
      const names = now.back.map(key => state.picks[key].label || settingsSlackLabel(key)).join(', ');
      nodes.push(settingsEl('d-ismall', `${names}을 다시 연결해요 — 뺀 동안 온 메시지는 가져오지 않아요`));
    }
    const error = settingsErrorLine();
    error.textContent = state.error || '';
    nodes.push(error);
    const words = settingsSlackPickLabel(now);
    const go = settingsButton(words || '바꾼 것이 없어요', 'd-btn pri');
    go.disabled = !words;
    go.addEventListener('click', () => run(go, error));
    const cancel = settingsButton('취소', 'd-btn sm', () => card.close());
    nodes.push(settingsStepFoot(cancel, go));
    card.body.append(...nodes);
    // 초점 — 방금 누른 체크 칸(다시 그려도 제자리), 이름을 고칠 줄, 그 밖엔 주 버튼.
    const taken = Object.keys(inputs).find(key => state.rowErrors[key]);
    if (taken) inputs[taken].focus();
    else if (state.focus && boxes[state.focus]) boxes[state.focus].focus();
    else go.focus();
    state.focus = null;
  }

  async function run(go, error) {
    const now = plan();
    if (!settingsSlackPickLabel(now)) return;
    state.error = '';
    const toMake = now.add.filter(key => !state.made[key]);
    const blank = toMake.filter(key => !settingsSlackChannelName(state.picks[key].name));
    if (blank.length) {
      blank.forEach((key) => { state.rowErrors[key] = '채널 이름을 적어 주세요'; });
      draw();
      return;
    }
    go.disabled = true;
    if (toMake.length) {
      // 토큰 칸이 없다 — 서버가 저장된 토큰을 쓴다(응답에는 싣지 않는다).
      const { stop } = await settingsSlackMakeChannels('', toMake, state);
      if (stop || toMake.some(key => !state.made[key])) { state.error = stop; draw(); return; }
    }
    const channels = Object.fromEntries(now.add.filter(key => state.made[key]).map(key => [key, state.made[key].id]));
    const done = [
      now.add.length ? `채널 ${now.add.length}개를 만들었어요` : '',
      now.back.length ? SETTINGS_SLACK_BACK : '',
      now.off.length ? `채널 ${now.off.length}개를 뺐어요` : '',
    ].filter(Boolean).join(' · ');
    await settingsIntegrationSave({ slack: { enabled: true, token: '', channels, off: now.off, on: now.back } },
      { error, button: go, done });
  }

  // 새 채널 이름의 앞머리(슬랙 사용자 이름)를 저장된 토큰으로 한 번 묻는다 — 못 받으면 `my`로 둔다.
  card.body.replaceChildren(settingsEl('d-ismall', '채널을 불러오는 중이에요…'));
  return settingsSlackTokenCheck('').then((checked) => {
    if (checked && checked.ok === true) state.prefix = settingsSlackPrefix(checked.prefix);
    Object.entries(state.picks).forEach(([key, pick]) => { if (!pick.touched) pick.name = settingsSlackDefaultName(key, state.prefix); });
    if (card.body.hidden) return state;
    draw();
    return state;
  });
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
  const fetchState = slack.fetch || {};
  let card = null;
  const pickLink = () => settingsButton('채널 고르기', 'd-ablink', () => card.open('pick'));
  // 할 일 채널이 사라졌으면 수집이 멈춘 것과 같은 급이다 — 빨간 상태 줄 + 이유 한 줄(시안 F).
  const todoGone = connected && !!todo.missing;
  let alert = null;
  if (todoGone) alert = { status: `${todo.name || '할 일 채널'}을 찾을 수 없어요`, why: ['슬랙에서 지웠거나 보관했어요 · ', pickLink()] };
  else if (connected && fetchState.failing) alert = { why: settingsFailWhy('slack', fetchState) };
  // 그 밖의 사라진 채널은 둘째 줄 아래 주의색 한 줄 — 누르면 채널 고르기로 간다.
  const extra = linkedKeys.filter(key => key !== 'todo' && channels[key].missing).map((key) => {
    const line = settingsEl('d-intgneed k-warn');
    line.dataset.missing = key;
    line.append(document.createTextNode(`${channels[key].name || '채널'}을 찾을 수 없어요 — 슬랙에서 지웠거나 보관했어요 · `), pickLink());
    return line;
  });
  // 메시지를 할 일로 옮기는 일은 지금 Claude Code가 한다 — 이 맥에 없으면 사실만 한 줄 알린다.
  if (!data.claude) extra.push(settingsEl('d-intgnote', '메시지를 할 일로 옮기는 일은 지금 Claude Code가 해요 · 이 맥에는 설치 안 됨'));
  const menu = connected ? () => [[
    ...settingsLogItem(card, slack.log),
    { label: '보내는 법', onClick: () => { card.open('how'); } },
    { label: '채널 고르기', onClick: () => card.open('pick') },
    { label: '다시 연결(토큰 바꾸기)', onClick: () => card.open('token') },
  ], [
    { label: '해제…', danger: true, onClick: () => settingsIntgConfirmOff(card, { slack: { enabled: false } }) },
  ]] : null;
  card = settingsIntgCard({
    kind: 'slack', name: '슬랙 수집', chip: 'Claude Code 필요',
    use: '나만 보는 채널에 공유한 메시지가 할 일로 들어와요',
    // 주기는 실제 등록 값(launchd 5분 간격, 매일 9–19시 — slack-capture.sh가 시간대를 본다).
    need: connected
      ? `매일 9–19시, 5분마다${typeof slack.todayCount === 'number' ? ` · 오늘 새 항목 ${slack.todayCount}개` : ''}`
      : '5분 · 팀 슬랙 앱 토큰 하나',
    status, menu, extra, alert,
    fetch: connected ? { key: 'slack', state: fetchState, reconnect: () => card.open('token') } : null,
    onOpen: (self, mode) => {
      if (mode === 'how') { self.body.appendChild(settingsSlackSendHow(todo.name || '#my-todo')); return; }
      if (mode === 'log') {
        const automation = (automationStatusCache || []).find(a => a.key === 'slack');
        settingsIntgLog(self, 'slack', '슬랙 수집', slack.log || [], slackLedgerNotes(automation ? automation.tail : []));
        return;
      }
      if (!connected || mode === 'token') { settingsSlackWizard(self, data, connected ? 'token' : 'new'); return; }
      settingsSlackPick(self, data);
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
  // 둘째 줄: `내 티켓 12개 · 반응 필요 댓글 2개 · 1분 전 확인` — 반응 필요(지라 댓글)를 마지막으로 확인한 때까지
  // 여기서 말한다(예전 상태 탭의 `반응 필요 · 지라 댓글` 줄). 다시 읽지 못하고 있으면 주의색으로 그 말을 붙인다.
  const checked = settingsAgo(jira.attentionAt);
  const attentionBad = !!(jira.attentionError || jira.attentionStale);
  const counts = [
    typeof jira.issueCount === 'number' ? `내 티켓 ${jira.issueCount}개` : '',
    typeof jira.attentionCount === 'number' ? `반응 필요 댓글 ${jira.attentionCount}개` : '',
    checked ? `${checked} 확인` : '',
    jira.attentionError && !checked ? '반응 필요 댓글을 읽지 못했어요' : (jira.attentionStale ? '다시 읽지 못했어요' : ''),
  ].filter(Boolean).join(' · ');
  const fetchState = jira.fetch || {};
  let card = null;
  card = settingsIntgCard({
    kind: 'jira', name: '지라', chip: '누구나',
    use: '내 티켓이 프로젝트로 뜨고 상태·기한을 여기서 바꿔요',
    need: connected ? (counts || '앱이 지라를 직접 읽어요') : '3분 · Atlassian API 토큰 하나',
    needClass: connected && attentionBad ? 'k-warn' : '',
    status,
    alert: connected && fetchState.failing ? { why: settingsFailWhy('jira', fetchState) } : null,
    fetch: connected ? { key: 'jira', state: fetchState, reconnect: () => card.open('token') } : null,
    menu: connected ? () => [[
      ...settingsLogItem(card, jira.log),
      { label: '다시 연결(토큰 바꾸기)', onClick: () => card.open('token') },
    ], [
      { label: '해제…', danger: true, onClick: () => settingsIntgConfirmOff(card, { jira: { enabled: false } }) },
    ]] : null,
    onOpen: (self, mode, arg) => {
      if (mode === 'done') { settingsJiraDone(self, data, arg); return; }
      if (mode === 'log') { settingsIntgLog(self, 'jira', '지라', jira.log || []); return; }
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
  const fetchState = calendar.fetch || {};
  const failing = on && (!!fetchState.failing || (ical && !calendar.readAt && !!calendar.failed));
  let card = null;
  card = settingsIntgCard({
    kind: 'calendar', name: '캘린더', chip: '누구나 · Claude',
    use: '오늘 회의가 뜨고 회의 정리가 열려요',
    // 주기는 실제 등록 값 — 비밀 주소는 앱이 30분마다, Claude 갈래는 launchd `calendar-sync`(매일 9·11·13·15·17·19시).
    need: on
      ? (ical ? '30분마다' : '매일 9–19시, 2시간마다')
      : '3분 · 비밀 주소 또는 Claude Code',
    status: on ? settingsCalendarStatus(calendar) : null,
    alert: failing ? { why: settingsFailWhy('calendar', fetchState) } : null,
    // 비밀 주소면 앱이 곧바로 다시 읽고(`오늘 N개`), Claude 갈래면 요청만 남긴다. 주소 문제면 `다시 연결`.
    fetch: on ? {
      key: 'calendar', state: calendar.fetch || {}, unit: ical ? '오늘' : '',
      reconnect: ical ? () => card.open('again') : null,
    } : null,
    menu: on ? () => [
      ...((settingsLogItem(card, calendar.log).length || ical)
        ? [[...settingsLogItem(card, calendar.log), ...(ical ? [{ label: '다시 연결(주소 바꾸기)', onClick: () => card.open('again') }] : [])]]
        : []),
      [{
        label: '해제…', danger: true,
        onClick: () => settingsIntgConfirmOff(card, { calendar: { enabled: false } }, ical ? SETTINGS_ICAL_OFF : '해제하면 오늘 일정 가져오기가 멈춰요.'),
      }],
    ] : null,
    onOpen: (self, mode) => {
      if (mode === 'log') { settingsIntgLog(self, 'calendar', '캘린더', calendar.log || []); return; }
      settingsCalendarOpen(self, data, mode);
    },
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
  let card = null;
  card = settingsIntgCard({
    kind: 'notes', name: '회의록', chip: '누구나 · Claude',
    use: '티로 회의록이 초안으로 들어와요 — 직접 옮기기도 돼요',
    need: tiro ? '회의가 끝나면 회의 탭에서 가져오기' : need,
    status: tiro ? (ran ? `${ran} 가져옴` : '아직 가져온 적 없어요') : null,
    alert: tiro && state.failing ? { why: settingsFailWhy('notes', state) } : null,
    fetch: tiro ? { key: 'tiro', state } : null,
    openText: '바꾸기', openClass: 'd-btn sm',
    // 티로로 받는 중이면 다른 연결된 카드처럼 ⋯(최근 기록 · 바꾸기)만 둔다.
    menu: tiro ? () => [[
      ...settingsLogItem(card, notes.log),
      { label: '바꾸기', onClick: () => card.open() },
    ]] : null,
    onOpen: (self, mode) => {
      if (mode === 'log') { settingsIntgLog(self, 'notes', '회의록', notes.log || []); return; }
      settingsNotesOpen(self, data);
    },
  });
  return card;
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

// 지금 멈춘 카드(연결된 것만) — 요약 줄의 `N개가 멈췄어요`와 빨간 점을 눌렀을 때 잠깐 붉힐 카드.
// 슬랙은 수집이 실패 중이거나 할 일 채널이 사라졌을 때, 캘린더(비밀 주소)는 한 번도 못 읽었을 때도 멈춘 것이다.
function settingsIntgFailing(data) {
  const slack = data.slack || {};
  const jira = data.jira || {};
  const calendar = data.calendar || {};
  const notes = data.meetingNotes || {};
  const todo = (slack.channels && slack.channels.todo) || {};
  const failing = (state) => !!(state && state.failing);
  const out = [];
  if (slack.enabled && slack.hasToken && todo.id && (failing(slack.fetch) || todo.missing)) out.push('slack');
  if (jira.enabled && jira.hasToken && jira.siteUrl && failing(jira.fetch)) out.push('jira');
  if (calendar.enabled && (failing(calendar.fetch) || (calendar.source === 'ical' && !calendar.readAt && calendar.failed))) out.push('calendar');
  if (notes.mode === 'tiro' && failing(notes.fetch)) out.push('notes');
  return out;
}

// 빨간 점을 누르고 들어왔으면 멈춘 카드를 약 2초 붉게 밝힌다(동작 줄이기면 ui.css가 전환 없이 바탕만 바꾼다).
const SETTINGS_FLASH_MS = 2000;
function settingsIntgFlash(kinds) {
  const cards = kinds.map(kind => settingsIntgCards.get(kind)).filter(Boolean);
  if (!cards.length) return [];
  cards.forEach((card) => { card.row.className = `${card.row.className} is-flash`; });
  if (typeof cards[0].row.scrollIntoView === 'function') cards[0].row.scrollIntoView({ block: 'nearest' });
  setTimeout(() => cards.forEach((card) => {
    card.row.className = String(card.row.className).split(' ').filter(one => one !== 'is-flash').join(' ');
  }), SETTINGS_FLASH_MS);
  return cards.map(card => card.row);
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
  const failing = settingsIntgFailing(data);
  // 맨 위 한 줄 요약(시안 A·B) — 연결 상태를 보는 곳은 이 탭 하나다.
  const head = settingsEl('d-intghead');
  const lead = document.createElement('span');
  lead.className = 'lead';
  const dot = (cls) => {
    const mark = document.createElement('span');
    mark.className = cls;
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = '●';
    return mark;
  };
  if (failing.length) {
    lead.className = 'lead k-neg';
    lead.append(dot('bad'), document.createTextNode(` ${failing.length}개가 멈췄어요`));
  } else if (counts.on) {
    lead.append(dot('ok'), document.createTextNode(` 연결 ${counts.on}개 모두 잘 읽고 있어요`));
  } else {
    lead.textContent = '연동은 선택이에요. 필요할 때 하나씩 켜요.';
  }
  const tally = document.createElement('span');
  tally.className = 'd-quiet sp';
  tally.textContent = `연결됨 ${counts.on} · 남은 것 ${counts.left}`;
  head.append(lead, tally);
  view.appendChild(head);
  [settingsSlackCard, settingsJiraCard, settingsCalendarCard, settingsNotesCard]
    .forEach(make => view.appendChild(make(data).row));
  view.appendChild(settingsIntgFoot());
  // 설정을 연 표지 — 빨간 점을 눌렀으면 멈춘 카드를 잠깐 붉게, `log:<카드>`면 그 카드의 최근 기록을 편다.
  const focus = settingsFocusKey;
  if (focus === 'alerts' || (typeof focus === 'string' && focus.startsWith('log:'))) settingsFocusKey = null;
  if (focus === 'alerts') settingsIntgFlash(failing);
  if (typeof focus === 'string' && focus.startsWith('log:') && settingsIntgCards.get(focus.slice(4))) settingsIntgCards.get(focus.slice(4)).open('log');
  // 지라 연결 직후라면 ③ 확인을 그 카드에 이어서 보인다(저장 뒤 다시 그린 화면).
  const after = settingsIntgAfter;
  settingsIntgAfter = null;
  if (after && after.kind === 'jira' && settingsIntgCards.get('jira')) {
    settingsIntgCards.get('jira').open('done', after.displayName);
  }
}

// ---------- 설정 > 꾸미기 (이 맥에만) ----------
// 세 줄(Dock 아이콘 · Dock 이름 · 워크스페이스 제목) + 저장. 프리셋은 두지 않는다(`앱 위치`는 앱 탭으로 옮겼다).
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

// 설정 › 앱의 `앱 위치` — Dock 앱과 업데이트 파일의 경로(홈은 `~`). Finder의 `폴더로 이동`에 붙여 넣으라고만 알린다.
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
  try { state = await (await request('/api/personalize')).json(); } catch { state = null; }
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
      '제가 담당·보고·지켜보지 않는 티켓과 14일보다 오래된 댓글은 아직 못 봐요. <b>피그마 댓글은 여기로 자동으로 오지 않아요</b> — 피그마의 슬랙 알림을 나만 보는 채널(#my-todo)에 공유하면 슬랙 수집을 거쳐 <b>할 일</b>로 들어와요. 잘 읽고 있는지는 <b>설정 &gt; 연동</b>의 지라 카드 둘째 줄(<b>반응 필요 댓글 N개 · N분 전 확인</b>)에서 봐요.'],
    ['Claude 없이 캘린더를 붙이려면', '구글 캘린더',
      '<b>설정 &gt; 연동 &gt; 캘린더</b>의 <b>비밀 주소 붙이기</b>예요. 구글 캘린더 설정 → 내 캘린더의 설정 → 캘린더 통합 → <b>iCal 형식의 비공개 주소</b>를 복사해 붙이면 앱이 30분마다 직접 읽어요. 이 주소는 비밀번호처럼 다뤄요.'],
    ['슬랙에서 이렇게 보내요', '슬랙 연결',
      '<b>남의 메시지</b>는 ⋯ → <b>전달</b>(또는 공유)로 #my-todo 같은 내 채널에 보내요. 메모 한 줄을 같이 적으면 할 일 문구에 참고해요. <b>내 생각</b>은 그 채널에 그냥 적어도 돼요(한 메시지가 한 항목). 해야 할 일 → 할 일 · 답을 기다리는 것 → 기다리는 것 · 정해진 정책 → 정해진 것 · 참고거리 → 언젠가.'],
    ['슬랙에서 수집한 게 잘 들어왔는지 보려면', '슬랙 연결 + Claude Code',
      '<b>설정 &gt; 연동</b>의 슬랙 카드 <b>⋯ › 최근 기록</b>을 열면 맨 위에 최근 수집 결과가 요약돼요 — 본 메시지 수와 등록·중복·건너뜀 개수, 건너뛴 문구까지 보여요. 그 아래는 최근 10번의 시각과 결과예요. 메시지를 갈래로 나누고 스레드를 읽는 일은 Claude Code가 해요.'],
    ['슬랙 채널에 다른 사람을 초대해도 되나요', '슬랙 연결',
      '이 채널들은 나만 있는 채널로 써요 — 다른 사람을 초대하면 그 사람이 쓴 메시지도 할 일로 들어와요.'],
    ['받을 채널을 더하거나 빼려면', '슬랙 연결',
      '슬랙 카드 <b>⋯ › 채널 고르기</b>예요. 새로 고른 곳은 비공개 채널을 만들어 주고, 체크를 풀면 앱이 그 채널을 더 이상 읽지 않아요(슬랙 채널과 이미 들어온 항목은 그대로예요). 뺐던 채널을 다시 체크하면 <b>그때부터</b> 읽어요 — 뺀 동안 온 메시지는 가져오지 않아요. <b>할 일</b>은 뺄 수 없고, 채널 이름은 슬랙에서 바꾸면 앱이 따라가요.'],
    ['지금 바로 새로 가져오고 싶어요', '그 연동 연결',
      '<b>설정 &gt; 연동</b>에서 연결된 카드의 <b>지금 가져오기</b>를 눌러요. 지라·캘린더(비밀 주소)는 곧바로 다시 읽고, 슬랙·캘린더(Claude)·티로는 요청을 남겨 1~2분 뒤 반영돼요. 같은 연동은 1분에 한 번이에요. 지금 못 읽고 있으면 버튼이 <b>다시 시도</b>로, 토큰·주소 문제면 <b>다시 연결</b>로 바뀌어요.'],
    ['머리줄의 `○일 전 기준`이나 톱니 점은 뭔가요', '없음',
      '자동 동기화가 최근에 못 돌았다는 뜻이에요. <b>주황 점</b>은 낡음, <b>빨간 점</b>은 지금 멈춘 연동이 있음, <b>파란 점</b>은 새 버전이 나왔다는 뜻이에요. 빨간 점을 누르면 <b>연동</b> 탭에서 멈춘 카드가 잠깐 붉게 보이고, 파란 점이면 <b>앱</b> 탭이 열려요.'],
  ]],
  ['문제가 생기면', [
    ['실수로 지웠는데 알림이 이미 사라졌으면', '없음',
      '<b>삭제한 항목</b> 탭에서 되살려요. 지운 항목은 원문 그대로 남고 저절로 사라지는 건 없어요. <b>완전히 지우기</b>만 되돌릴 수 없어서 한 번 더 물어봐요.'],
    ['앱이 이상하게 동작하면', '없음',
      '<b>설정 &gt; 앱</b>의 <b>문제 보고 › 진단 내용 복사</b>를 누르면 버전·연동 상태·최근 오류 줄이 클립보드에 복사돼요. 업무 내용은 들어가지 않으니 그대로 슬랙에 붙여 넣어 주세요.'],
    ['업무 데이터는 어디에 백업되나요', '없음',
      '매일 19:30 이 맥의 <b>~/workspace-data-backup/daily</b>에 그날 데이터를 복사해 <b>7일치</b>를 남겨요(누구나 똑같아요). 업데이트 직전과 저장할 때마다의 직전 한 벌도 따로 있어요. 잘 됐는지는 <b>설정 &gt; 앱</b>의 <b>데이터 백업</b> 줄에서 보고, GitHub 비공개 저장소에도 올리고 싶으면 앱 README의 "업무 데이터 백업"대로 한 번 설정해요.'],
    ['앱에서 업데이트하기', '없음',
      '새 버전이 나오면 <b>설정 &gt; 앱</b>의 <b>버전</b> 줄에 <b>업데이트 받기</b>가 떠요. 누르면 데이터 백업 → 받기 → 다시 시작 → 확인까지 1분쯤 걸리고, 진행을 그 자리에서 보여 줘요. 끝나면 <b>새로고침</b>을 눌러 주세요. 받기 전에 멈추면 <b>다시 시도</b>, 받은 뒤 실패하면 <b>이전 버전으로 되돌리기</b>를 보여 줘요. 폴더를 옮겨야 하거나 처음 한 번은 앱 폴더의 <b>업데이트.command</b>를 더블클릭해요.'],
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

// 탭 차례 — 연동 · 앱 · 꾸미기 · 도움말 · 삭제한 항목. 설정을 열면 연동이 먼저다(예전 `상태` 탭은 없앴다 —
// 연결 상태는 연동 카드, 앱 자체의 일은 앱 탭). 모르는 이름(옛 `status` 등)은 연동으로 연다.
const SETTINGS_TABS = ['integrations', 'app', 'personalize', 'guide', 'trash'];

function settingsSetTab(tab) {
  const want = SETTINGS_TABS.includes(tab) ? tab : 'integrations';
  settingsDialog.querySelectorAll('[data-settings-tab]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.settingsTab === want));
  });
  document.getElementById('settingsIntegrationsView').hidden = want !== 'integrations';
  document.getElementById('settingsAppView').hidden = want !== 'app';
  document.getElementById('settingsPersonalizeView').hidden = want !== 'personalize';
  document.getElementById('settingsManualView').hidden = want !== 'guide';
  document.getElementById('settingsGuideView').hidden = want !== 'guide';
  document.getElementById('settingsTrashView').hidden = want !== 'trash';
  if (want === 'guide') { renderSettingsManual(); renderSettingsGuide(); }
  if (want === 'personalize') renderSettingsPersonalize();
  if (want === 'app') renderSettingsApp();
  if (want === 'integrations') renderSettingsIntegrations();
  if (want === 'trash') renderSettingsTrash();
  return want;
}

// 헤더의 톱니바퀴·사용설명서·알림의 `자세히`가 함께 쓰는 한 길. 표지(focusKey)는 settingsFocusKey 참고.
function settingsOpen(tab = 'integrations', focusKey = null) {
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
  // 새 버전이 나왔는지(톱니바퀴의 파란 점)는 어느 탭으로 열든 한 번 새로 묻는다 — 예전엔 상태 탭이 이 일을 했다.
  if (tab !== 'app') settingsAboutLoad();
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
// 톱니바퀴: 빨간 점(지금 멈춘 연동)이면 연동 탭 + 멈춘 카드를 잠깐 붉게, 파란 점(새 버전)만 있으면 앱 탭, 그 밖엔 연동 탭.
function settingsGearTab() {
  if (settingsAlertKeys.length) return ['integrations', 'alerts'];
  const gear = document.getElementById('settingsBtn');
  const stale = !!(gear && gear.classList && gear.classList.contains('has-stale'));
  if (!stale && settingsHasUpdate()) return ['app', null];
  return ['integrations', null];
}
document.getElementById('settingsBtn').addEventListener('click', () => settingsOpen(...settingsGearTab()));
document.getElementById('settingsCloseBtn').addEventListener('click', settingsClose);
settingsDialog.querySelectorAll('[data-settings-tab]').forEach((button) => {
  button.addEventListener('click', () => settingsSetTab(button.dataset.settingsTab));
});

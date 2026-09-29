// 설정 › 앱 `점검` 줄(WP-K 시안 A~C)과 도움말 맨 위 `문제가 생겼어요` 묶음(시안 D).
// settings-ui.js의 부품(settingsEl·settingsButton·settingsRich·settingsCopy·personalizeRow·settingsReportCopy·
// settingsAbout·settingsUpdateRun)과 app.js의 syncLag·showNotice·uiIcon에 기댄다. innerHTML은 uiIcon 아이콘에만 쓴다.
//
// - 결과는 `GET /api/selfcheck` 한 번(서버가 30초 들고 있다). 늦음(주황)은 톱니바퀴의 주황 점·연동 탭과 **같은 함수**
//   syncLag에 응답의 `sync`를 넣어 정한다 — 정상(ok)인 연동 줄만 `확인해 보면 좋아요`로 바꾸고, 첫 읽기 전이면 `아직 알 수 없어요`.
// - 요약은 고칠 것(bad, 다른 줄과 같은 원인은 한 번) 수와 확인해 볼 것(warn) 수를 따로 센다. 연결 안 한 연동은 맨 아래 한 줄.
// - 점검 중·앱 안 업데이트 중에는 버튼을 잠그고, 다시 점검은 30초에 한 번이다.
// - 결과 복사에는 항목 이름·상태·문구·버전·시각만 — 채널 이름·지라 이름 대신 서버가 준 `copy`(개수·고정 문구)를 쓰고,
//   경로는 `~`로, 이메일 모양은 가린다. 클립보드가 막히면 글자를 고른 채 보여 준다.

const SELFCHECK_WAIT_MS = 30 * 1000;
const SELFCHECK_MARK = { ok: '✓', bad: '✗', warn: '!', unknown: '?', offline: '–' };
const SELFCHECK_STATE_WORD = { ok: '정상', bad: '고쳐야 해요', warn: '확인해 보면 좋아요', unknown: '아직 알 수 없어요', offline: '확인 못 함' };
const SELFCHECK_WORDS = {
  lead: '설치·연동·자동화를 한 번에 확인하고, 고치는 법을 알려 줘요.',
  running: '점검하는 중…',
  failed: '점검하지 못했어요 — 앱이 켜져 있는지 확인하고 잠시 뒤 다시 눌러 주세요',
  offline: '인터넷 연결을 확인해 주세요',
  offlineSub: '슬랙·지라·캘린더에 닿지 못했어요 — 연결되면 다시 점검해 주세요',
  again: '그래도 안 되면 결과를 복사해 만든 사람에게 보내 주세요',
  wait: '30초에 한 번 다시 점검할 수 있어요',
  updating: '업데이트하는 동안에는 점검할 수 없어요',
  finder: 'Finder: ⇧⌘G → 경로 붙여 넣기 → 더블클릭',
  copyDone: '결과를 복사했어요 — 슬랙으로 만든 사람에게 보내 주세요',
  copyBlocked: '복사가 막혀 있어요 — 아래 글이 골라져 있으니 ⌘C로 복사해 주세요',
};
// 늦은 연동 줄의 고치는 법(연동 탭 카드와 같은 길로 안내한다).
const SELFCHECK_LAG_FIX = {
  slack: '설정 › 연동 › 슬랙의 지금 가져오기를 눌러 보고, 그래도 늦으면 ⋯ › 최근 기록을 봐요',
  calendar: '설정 › 연동 › 캘린더의 지금 가져오기를 눌러 보고, 그래도 늦으면 ⋯ › 최근 기록을 봐요',
  jira: '설정 › 연동 › 지라의 지금 가져오기를 눌러 주세요',
};

// { busy, result, items, doneAt, badBefore, repeat, error, fallback }
let selfcheckState = { busy: false, result: null, items: [], doneAt: 0, badBefore: null, repeat: false, error: '', fallback: '' };
let selfcheckTimer = null;
// 지금 그려 둔 `점검하기` 버튼(앱 탭을 다시 그리면 바뀐다) — 잠금을 칠할 때 쓴다.
let selfcheckMainButton = null;

// 늦음·첫 읽기 전을 syncLag(톱니바퀴의 주황 점과 같은 함수)로 더한다. 멈춘(bad) 줄은 그대로 둔다(빨강이 이긴다).
function selfcheckApplyLag(result, options) {
  const items = Array.isArray(result && result.items) ? result.items.map(item => ({ ...item })) : [];
  if (!result || !result.sync || typeof syncLag !== 'function') return items;
  const lag = options ? syncLag(result.sync, options) : syncLag(result.sync);
  items.forEach((item) => {
    if (!item.lag || item.state !== 'ok') return;
    const late = lag.late.find(one => one.key === item.lag);
    if (late) {
      item.state = 'warn';
      item.detail = late.text;
      item.fix = { text: SELFCHECK_LAG_FIX[item.lag] || SELFCHECK_LAG_FIX.slack };
      delete item.copy;
    } else if (lag.waiting.includes(item.lag)) {
      item.state = 'unknown';
      item.detail = '아직 알 수 없어요 — 첫 읽기를 기다려요';
      delete item.copy;
    }
  });
  return items;
}

// 고칠 것(bad — 다른 줄과 같은 원인은 한 번만)·확인해 볼 것(warn)·아직 모름·닿지 못함.
function selfcheckCounts(items) {
  const list = Array.isArray(items) ? items : [];
  return {
    bad: list.filter(item => item.state === 'bad' && !item.sameAs).length,
    warn: list.filter(item => item.state === 'warn').length,
    unknown: list.filter(item => item.state === 'unknown').length,
    offline: list.filter(item => item.state === 'offline').length,
    all: list.length,
  };
}
const selfcheckBadKeys = items => (items || []).filter(item => item.state === 'bad' && !item.sameAs).map(item => item.key);

// 복사 글에서 사람·계정을 알아볼 수 있는 조각을 한 번 더 가린다(경로의 홈 → `~`, 이메일 모양).
function selfcheckScrub(text) {
  return String(text || '')
    .replace(/\/Users\/[^/\s]+/g, '~')
    .replace(/[^\s@:]+@[^\s@:]+\.[A-Za-z]{2,}/g, '…');
}

function selfcheckStamp(iso) {
  const at = new Date(iso || '');
  if (Number.isNaN(at.getTime())) return '';
  const two = n => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}`;
}

// 닿지 못한 줄(offline)이 있으면 "모두 정상"이라 하지 않는다 — 인터넷 말고는 정상이라고만.
function selfcheckSummaryText(counts) {
  if (counts.bad) return `● ${counts.bad}개를 고치면 돼요`;
  if (counts.warn) return `확인해 보면 좋아요 ${counts.warn}개`;
  if (counts.offline) return '✓ 인터넷 말고는 모두 정상이에요';
  return '✓ 모두 정상이에요';
}

// 결과 복사 — 항목 이름·상태·문구·버전·시각만(고치는 법·명령·경로 칸은 싣지 않는다).
function selfcheckCopyText(result, items) {
  const counts = selfcheckCounts(items);
  const head = `워크스페이스 점검 · ${result && result.version ? `v${result.version}` : '버전 모름'} · ${selfcheckStamp(result && result.at) || '시각 모름'}`;
  const summary = [selfcheckSummaryText(counts).replace(/^[●✓] /, ''), counts.bad && counts.warn ? `확인해 보면 좋아요 ${counts.warn}개` : '']
    .filter(Boolean).join(' · ');
  const lines = [head, `${result && result.offline ? `${SELFCHECK_WORDS.offline} · ` : ''}${summary}`];
  (items || []).forEach((item) => {
    const detail = item.copy || item.detail || '';
    lines.push(`${SELFCHECK_MARK[item.state] || '?'} ${item.label} (${SELFCHECK_STATE_WORD[item.state] || '알 수 없음'})${detail ? ` — ${detail}` : ''}`);
  });
  const skipped = Array.isArray(result && result.skipped) ? result.skipped : [];
  if (skipped.length) lines.push(`연결 안 한 것: ${skipped.join(' · ')}`);
  return selfcheckScrub(lines.join('\n'));
}

// 지금 점검을 누를 수 있는가(누를 수 없으면 그 이유).
function selfcheckBlocked(at = Date.now()) {
  if (selfcheckState.busy) return SELFCHECK_WORDS.running;
  if (typeof settingsUpdateRun !== 'undefined' && settingsUpdateRun) return SELFCHECK_WORDS.updating;
  if (selfcheckState.doneAt && at - selfcheckState.doneAt < SELFCHECK_WAIT_MS) return SELFCHECK_WORDS.wait;
  return '';
}

// 명령 한 줄 + `명령 복사`(설정의 d-icode 줄과 같은 모양).
function selfcheckCommandLine(command) {
  const line = settingsEl('d-icode');
  const code = document.createElement('code');
  code.textContent = command;
  line.append(code, settingsButton('명령 복사', 'd-btn xs', () => settingsCopy(command, '명령을 복사했어요 — 터미널에 붙여 넣어 주세요')));
  return line;
}

function selfcheckFixNode(fix) {
  const box = settingsEl('fix');
  const lead = document.createElement('b');
  lead.textContent = '고치는 법';
  const text = document.createElement('span');
  text.textContent = ` ${fix.text}`;
  box.append(lead, text);
  if (fix.command) box.appendChild(selfcheckCommandLine(fix.command));
  if (fix.finder) box.appendChild(settingsEl('d-ismall', `${SELFCHECK_WORDS.finder} (${fix.finder})`));
  return box;
}

function selfcheckItemNode(item) {
  const row = document.createElement('li');
  row.className = item.state;
  row.dataset.key = item.key;
  const icon = document.createElement('span');
  icon.className = 'ic';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = SELFCHECK_MARK[item.state] || '?';
  const word = document.createElement('span');
  word.className = 'sr-only';
  word.textContent = `${SELFCHECK_STATE_WORD[item.state] || ''}: `;
  const text = document.createElement('span');
  text.className = 't';
  text.appendChild(document.createTextNode(item.label));
  if (item.detail) {
    const small = document.createElement('small');
    small.textContent = item.detail;
    text.appendChild(small);
  }
  row.append(icon, word, text);
  // 고치는 법은 문제 줄(고칠 것·확인해 볼 것)에만.
  if (item.fix && (item.state === 'bad' || item.state === 'warn')) row.appendChild(selfcheckFixNode(item.fix));
  return row;
}

function selfcheckList(items) {
  const list = document.createElement('ul');
  list.className = 'd-sclist';
  items.forEach(item => list.appendChild(selfcheckItemNode(item)));
  return list;
}

// 결과 자리에 그릴 것들.
function selfcheckNodes(state = selfcheckState) {
  if (state.error) return [settingsEl('d-ismall k-neg', state.error)];
  if (!state.result) return [];
  const result = state.result;
  const items = state.items;
  const counts = selfcheckCounts(items);
  const nodes = [];
  if (result.offline) {
    const off = settingsEl('d-scoff');
    off.setAttribute('role', 'alert');
    off.append(settingsEl('tx', SELFCHECK_WORDS.offline), settingsEl('d-ismall', SELFCHECK_WORDS.offlineSub));
    nodes.push(off);
  }
  const tone = counts.bad ? 'd-scsum' : counts.warn ? 'd-scsum is-warn' : 'd-scsum is-good';
  const sum = settingsEl(tone);
  const words = document.createElement('span');
  words.className = 'tx';
  words.textContent = selfcheckSummaryText(counts);
  const when = document.createElement('span');
  when.className = 'at';
  when.textContent = `방금 점검${result.version ? ` · v${result.version}` : ''}`;
  sum.append(words, when);
  nodes.push(sum);
  if (counts.bad && counts.warn) nodes.push(settingsEl('d-ismall d-scmore', `확인해 보면 좋아요 ${counts.warn}개`));
  if (state.repeat) nodes.push(settingsEl('d-ismall d-scagain', SELFCHECK_WORDS.again));
  if (counts.bad || counts.warn) {
    nodes.push(selfcheckList(items));
  } else {
    // 모두 정상이면 목록은 접어 둔다(자세히 보기).
    const more = document.createElement('details');
    more.className = 'd-dsec d-dadd d-scall';
    const summary = document.createElement('summary');
    summary.className = 'lbl';
    summary.innerHTML = uiIcon('chevron');
    summary.appendChild(document.createTextNode(`${counts.all}개 항목을 확인했어요 · 자세히 보기`));
    more.append(summary, selfcheckList(items));
    nodes.push(more);
  }
  const skipped = Array.isArray(result.skipped) ? result.skipped : [];
  if (skipped.length) nodes.push(settingsEl('d-ismall d-scskip', `연결 안 한 것: ${skipped.join(' · ')} — 필요하면 설정 › 연동에서 켜요`));
  const foot = settingsEl('d-irow d-scfoot');
  const again = settingsButton('다시 점검', 'd-btn sm', () => selfcheckStart());
  again.dataset.selfcheck = 'again';
  foot.append(again, settingsButton('결과 복사 → 만든 사람에게 보내기', 'd-btn sm', () => selfcheckCopy()));
  nodes.push(foot);
  if (state.fallback) {
    const area = document.createElement('textarea');
    area.className = 'd-din d-scfallback';
    area.readOnly = true;
    area.rows = Math.min(14, state.fallback.split('\n').length + 1);
    area.value = state.fallback;
    area.setAttribute('aria-label', '점검 결과 글');
    nodes.push(settingsEl('d-ismall', SELFCHECK_WORDS.copyBlocked), area);
  }
  return nodes;
}

// 버튼 둘(점검하기·다시 점검)의 잠금만 다시 칠한다 — 업데이트가 시작·끝날 때도 부른다.
function selfcheckPaintButtons(at = Date.now()) {
  const why = selfcheckBlocked(at);
  const main = selfcheckMainButton;
  if (main) {
    main.disabled = !!why;
    main.textContent = selfcheckState.busy ? SELFCHECK_WORDS.running : '점검하기';
    if (why) main.title = why; else main.removeAttribute('title');
  }
  const slot = document.getElementById('selfcheckResult');
  const again = slot && typeof slot.querySelector === 'function' ? slot.querySelector('.d-scfoot') : null;
  const button = again && again.children ? again.children[0] : null;
  if (button) {
    button.disabled = !!why;
    if (why) button.title = why; else button.removeAttribute('title');
  }
}

function selfcheckPaint() {
  const slot = document.getElementById('selfcheckResult');
  if (slot) {
    const nodes = selfcheckNodes();
    slot.replaceChildren(...nodes);
    slot.hidden = !nodes.length;
    const area = nodes.find(node => node && String(node.className || '').includes('d-scfallback'));
    if (area) { if (typeof area.focus === 'function') area.focus(); if (typeof area.select === 'function') area.select(); }
  }
  selfcheckPaintButtons();
}

// `점검하기`·`다시 점검` — 잠겨 있으면 아무것도 하지 않는다.
async function selfcheckStart() {
  if (selfcheckBlocked()) { selfcheckPaintButtons(); return false; }
  selfcheckState = { ...selfcheckState, busy: true, error: '', fallback: '' };
  selfcheckPaintButtons();
  let data = null;
  try {
    const response = await fetch('/api/selfcheck', { headers: { Accept: 'application/json' } });
    data = response.ok ? await response.json() : null;
  } catch { data = null; }
  if (!data || data.ok === false || !Array.isArray(data.items)) {
    selfcheckState = { ...selfcheckState, busy: false, error: SELFCHECK_WORDS.failed };
    selfcheckPaint();
    return false;
  }
  const items = selfcheckApplyLag(data);
  const before = selfcheckState.badBefore;
  const now = selfcheckBadKeys(items);
  // 다시 점검해도 같은 문제가 남았으면(예외 7) 요약 아래에 보내기 안내.
  const repeat = !!(before && before.length && now.some(key => before.includes(key)));
  selfcheckState = { busy: false, result: data, items, doneAt: Date.now(), badBefore: now, repeat, error: '', fallback: '', cached: !!data.cached };
  selfcheckPaint();
  if (selfcheckTimer) clearTimeout(selfcheckTimer);
  selfcheckTimer = setTimeout(() => { selfcheckTimer = null; selfcheckPaintButtons(); }, SELFCHECK_WAIT_MS + 50);
  return true;
}

async function selfcheckCopy() {
  if (!selfcheckState.result) return false;
  const text = selfcheckCopyText(selfcheckState.result, selfcheckState.items);
  try {
    await navigator.clipboard.writeText(text);
    showNotice(SELFCHECK_WORDS.copyDone);
    if (selfcheckState.fallback) { selfcheckState = { ...selfcheckState, fallback: '' }; selfcheckPaint(); }
    return true;
  } catch {
    // 클립보드가 막히면 글자를 고른 채 보여 준다(추가 B).
    selfcheckState = { ...selfcheckState, fallback: text };
    selfcheckPaint();
    return false;
  }
}

// 설정 › 앱의 `점검` 줄(시안 A) — `점검하기` + 예전 문제 보고(`문제 보고 복사`), 아래에 결과 자리.
function selfcheckRow() {
  const check = settingsButton('점검하기', 'd-btn', () => selfcheckStart());
  check.id = 'selfcheckBtn';
  selfcheckMainButton = check;
  const report = settingsButton('문제 보고 복사', 'd-btn', null);
  report.id = 'settingsReportBtn';
  report.addEventListener('click', () => settingsReportCopy(report));
  const buttons = settingsEl('d-irow');
  buttons.append(check, report);
  const slot = settingsSlot('selfcheckResult', 'd-scwrap');
  slot.setAttribute('role', 'status');
  slot.setAttribute('aria-live', 'polite');
  const nodes = selfcheckNodes();
  slot.append(...nodes);
  slot.hidden = !nodes.length;
  const row = personalizeRow('점검', '문제가 있을 때', buttons, settingsEl('d-ismall', SELFCHECK_WORDS.lead), slot);
  row.dataset.row = 'check';
  // 다시 그려도(탭을 오가도) 잠금을 이어 간다.
  setTimeout(() => selfcheckPaintButtons(), 0);
  return row;
}

// ---------- 도움말 맨 위 `문제가 생겼어요`(시안 D) ----------
// 증상으로 찾는 접이식 여섯. 업데이트 파일은 이름만 쓰지 않는다 — 무엇인지 + 실제 경로의 한 줄 명령 + Finder 길(추가 A).
// 경로는 GET /api/about의 updateFile(설정 › 앱 › 앱 위치와 같은 값)이고, 읽기 전에는 그 줄을 숨겨 둔다.
const SELFCHECK_UPDATE_WORDS = ['업데이트 파일', '(앱을 새로 받고 다시 켜 주는 파일)'];
const SELFCHECK_TROUBLE = [
  ['슬랙 메시지가 할 일로 안 들어와요', [
    [['설정 › 연동 › 슬랙 ⋯ › ', ['b', '최근 기록'], ' 맨 위를 봐요']],
    [['“로그인이 풀렸어요” → 설정 › 앱 › ', ['b', '점검하기'], '가 고치는 법을 보여 줘요']],
    [['“토큰” 문제 → 슬랙 ⋯ › ', ['b', '다시 연결'], ' — OAuth & Permissions 화면의 ', ['b', 'User OAuth Token(xoxp-)'], '을 붙여요']],
    [['“새 메시지 없음”인데 안 들어왔으면 → 전달한 채널이 ', ['b', '내 할 일 채널'], '이 맞는지 확인해요']],
  ]],
  ['앱이 안 열려요 / 흰 화면이에요', [
    [['앱 창을 닫았다가 다시 열고 10초 기다려요']],
    [['그래도 안 되면 ', ['b', SELFCHECK_UPDATE_WORDS[0]], SELFCHECK_UPDATE_WORDS[1], '을 실행해요 — 앱을 다시 켜 줘요'], 'update'],
  ]],
  ['새 버전이 안 떠요', [
    [['설정 › 앱 › ', ['b', '새 버전 확인'], '을 눌러요']],
    [['그 버튼이 없으면(1.1.3 이하) ', ['b', SELFCHECK_UPDATE_WORDS[0]], SELFCHECK_UPDATE_WORDS[1], '을 실행해요'], 'update'],
  ]],
  ['Dock을 누르면 창이 여러 개 떠요', [
    [['설정 › 꾸미기 › ', ['b', '앱으로 설치'], '로 크롬 앱을 설치하면 해결돼요 — 창이 하나로 모이고 Dock·⌘Tab에 아이콘이 따로 떠요']],
  ]],
  ['설치 파일이 “열지 않음”으로 막혀요', [
    [['터미널에 ', ['b', 'bash '], '(띄어쓰기까지) 적고 → 설치.command를 끌어다 놓고 → Enter']],
  ]],
  ['캘린더 일정이 안 보여요', [
    [['비밀 주소 칸이 없으면 회사가 막아 둔 거예요 → ', ['b', 'Claude Code로'], ' 연결해요']],
    [['“읽지 못했어요” → 캘린더 ⋯ › ', ['b', '다시 연결'], '에서 주소를 다시 붙여요']],
  ]],
];

function selfcheckUpdateLines(file) {
  const wrap = settingsEl('d-trupd');
  wrap.hidden = !file;
  if (file) {
    const command = `bash ${selfcheckShellPath(file)}`;
    wrap.append(selfcheckCommandLine(command), settingsEl('d-ismall', `${SELFCHECK_WORDS.finder} (${file})`));
  }
  return wrap;
}
// 서버의 shellPath(selfcheck.js)와 같은 규칙 — 띄어쓰기 같은 글자가 있으면 `~/` 뒤를 작은따옴표로.
function selfcheckShellPath(shown) {
  const text = String(shown || '');
  if (/^[~\w./가-힣-]+$/.test(text)) return text;
  const rest = text.startsWith('~/') ? text.slice(2) : text;
  const quoted = `'${rest.replace(/'/g, `'\\''`)}'`;
  return text.startsWith('~/') ? `~/${quoted}` : quoted;
}

function selfcheckTroubleNode() {
  const box = settingsEl('d-trouble');
  box.setAttribute('role', 'region');
  box.setAttribute('aria-label', '문제가 생겼어요');
  const lead = settingsEl('d-ismall d-trlead');
  // 앱 탭으로 가서 `점검하기`에 초점을 둔다(renderSettingsApp이 표지 `selfcheck`를 보고 옮긴다).
  const go = settingsButton('점검하기', 'd-ablink', () => {
    settingsFocusKey = 'selfcheck';
    settingsSetTab('app');
  });
  lead.append(document.createTextNode('먼저 설정 › 앱 › '), go, document.createTextNode(' — 무엇이 안 되는지와 고치는 법을 한 번에 보여 줘요'));
  box.append(settingsEl('hd', '문제가 생겼어요'), lead);
  const file = settingsAbout && settingsAbout.updateFile ? settingsAbout.updateFile : '';
  SELFCHECK_TROUBLE.forEach(([question, steps], index) => {
    const one = document.createElement('details');
    one.className = 'd-dadd d-trq';
    if (index === 0) one.open = true;
    const summary = document.createElement('summary');
    summary.innerHTML = uiIcon('chevron');
    summary.appendChild(document.createTextNode(question));
    const list = document.createElement('ol');
    steps.forEach(([parts, extra]) => {
      const row = document.createElement('li');
      settingsRich(row, parts);
      if (extra === 'update') row.appendChild(selfcheckUpdateLines(file));
      list.appendChild(row);
    });
    one.append(summary, list);
    box.appendChild(one);
  });
  // 경로를 아직 모르면 앱 정보를 조용히 읽어(원격에 묻지 않는다) 그 줄을 채운다.
  if (!file && typeof settingsAboutLoad === 'function') {
    settingsAboutLoad({ cached: true }).then((info) => {
      const path = info && info.updateFile;
      if (!path) return;
      [...(box.children || [])].forEach((one) => {
        [...((one.children && one.children[1] && one.children[1].children) || [])].forEach((row) => {
          const slot = [...(row.children || [])].find(kid => String(kid.className || '').split(' ').includes('d-trupd'));
          if (slot) slot.replaceWith(selfcheckUpdateLines(path));
        });
      });
    }).catch(() => {});
  }
  return box;
}

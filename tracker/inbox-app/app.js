// ---------- D 공용 부품 ----------
// 화면 여러 곳이 같이 쓰는 것들(아이콘·날짜 문구·더보기 메뉴·날짜 칸·Esc 순서).
// 전부 "불릴 때만" DOM을 만든다 — 정의부만 읽어 검증하는 client.test.js에는 진짜 DOM이 없다.

// 14px 인라인 SVG 한 벌. 선은 currentColor라 글자색을 그대로 물려받는다(이모지·글리프는 쓰지 않는다).
const UI_ICONS = {
  search: '<circle cx="7" cy="7" r="4.25"/><path d="M10.2 10.2 14 14"/>',
  more: '<circle cx="8" cy="3.2" r="1.05"/><circle cx="8" cy="8" r="1.05"/><circle cx="8" cy="12.8" r="1.05"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  plus: '<path d="M8 3.2v9.6M3.2 8h9.6"/>',
  check: '<path d="M3.5 8.4 6.6 11.5 12.5 4.9"/>',
  chevron: '<path d="M6 3.5 10.5 8 6 12.5"/>',
  link: '<path d="M6.9 9.1a2.6 2.6 0 0 0 3.7 0l2-2a2.6 2.6 0 0 0-3.7-3.7l-.6.6"/><path d="M9.1 6.9a2.6 2.6 0 0 0-3.7 0l-2 2a2.6 2.6 0 0 0 3.7 3.7l.6-.6"/>',
  refresh: '<path d="M14 8a6 6 0 1 1-2-4.47L14 5.2"/><path d="M14 2v3.4h-3.4"/>',
  gear: '<circle cx="8" cy="8" r="2.4"/><path d="M8 1.7v1.7M8 12.6v1.7M14.3 8h-1.7M3.4 8H1.7M12.45 3.55l-1.2 1.2M4.75 11.25l-1.2 1.2M12.45 12.45l-1.2-1.2M4.75 4.75l-1.2-1.2"/>',
  // 상태말 앞에 붙는 종류 표시 — 기한(달력) · 밀림(시계) · 답변(말풍선).
  calendar: '<rect x="2.4" y="3.4" width="11.2" height="10.2" rx="2.2"/><path d="M2.4 6.6h11.2M5.6 2.2v2.4M10.4 2.2v2.4"/>',
  clock: '<circle cx="8" cy="8" r="5.8"/><path d="M8 4.8V8l2.2 1.5"/>',
  chat: '<path d="M13.6 8.6a4.8 4.8 0 0 1-4.8 4.8H5.2L2.4 15v-2.9A4.8 4.8 0 0 1 2.4 8V7.4a4.8 4.8 0 0 1 4.8-4.8h1.6a4.8 4.8 0 0 1 4.8 4.8z"/>',
  // 우선순위 — 업무 체크박스 안에 겹치는 위 꺾쇠(지라의 우선순위 아이콘과 같은 말): 중요 한 겹 · 긴급 두 겹.
  priHigh: '<path d="M3.5 10.5 8 6l4.5 4.5"/>',
  priTop: '<path d="M3.5 8.5 8 4l4.5 4.5M3.5 13 8 8.5l4.5 4.5"/>',
};
// 체크박스 위에 겹치는 흰 체크. 체크박스를 만드는 자리마다 같은 마크업을 쓴다(고정 문자열).
const UI_TICK_SVG = '<svg class="d-tick" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 7.4 5.7 10.1 11 4.2"/></svg>';
function uiIcon(name) {
  const shape = UI_ICONS[name];
  return shape ? `<svg class="d-i" viewBox="0 0 16 16" aria-hidden="true">${shape}</svg>` : '';
}

const UI_WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
// 2026-09-22 → "9월 22일 (화)". 날짜는 어디서나 이 꼴로만 쓰고 연도는 붙이지 않는다.
function uiKoDate(dateStr) {
  if (!dateStr) return '';
  const [, month, day] = String(dateStr).split('-');
  if (!month || !day) return String(dateStr);
  const weekday = UI_WEEKDAYS[new Date(dateStr + 'T00:00:00').getDay()];
  return `${Number(month)}월 ${Number(day)}일${weekday ? ` (${weekday})` : ''}`;
}

// 레일의 보조 줄처럼 자리가 좁은 곳에서는 요일을 뺀다: `9월 24일`
function uiKoDateShort(dateStr) {
  if (!dateStr) return '';
  const [, month, day] = String(dateStr).split('-');
  if (!month || !day) return String(dateStr);
  return `${Number(month)}월 ${Number(day)}일`;
}

// 기한 말투는 어디서나 같다: `기한 2일 지남`(urgent) `오늘까지`(warn) `내일까지` `9월 27일까지`.
// where가 'row'면 오늘 목록의 한 줄 — 먼 기한은 찍지 않는다(의미 없는 값은 자리를 비운다).
function uiDueText(due, where = 'full') {
  if (!due) return null;
  const diff = diffDays(due);
  if (Number.isNaN(diff)) return null;
  if (diff < 0) return { text: `기한 ${-diff}일 지남`, tone: 'urgent' };
  if (diff === 0) return { text: '오늘까지', tone: 'warn' };
  if (diff === 1) return { text: '내일까지', tone: '' };
  if (where === 'row') return null;
  return { text: `${uiKoDateShort(due)}까지`, tone: '' };
}

// 확인 대기의 `답변 받을 날`은 "상대에게 답을 받기로 한 날"이다 — 내가 회신할 날처럼 읽히지 않게 말을 따로 둔다.
// 지났거나 오늘일 때만 줄에 배지로 선다(먼 날짜는 줄을 시끄럽게 하지 않는다 — 기한과 같은 규칙).
// 배지는 짧게 두고 무슨 날인지는 title 툴팁이 풀어 준다.
// 배지 문구는 여기 한 곳에서만 만든다 — 말이 바뀌면 이 두 줄만 고치면 화면 어디서나 같이 바뀐다.
const UI_REPLY_WORDS = { late: days => `${days}일 늦음`, today: () => '오늘 답변 예정' };
function uiReplyText(due) {
  const state = uiDueText(due, 'row');
  if (!state || !state.tone) return null;
  const diff = diffDays(due);
  return { text: diff < 0 ? UI_REPLY_WORDS.late(-diff) : UI_REPLY_WORDS.today(), tone: state.tone };
}

// 줄에 적는 날짜 한마디 — 확인 대기는 급한 때(지났거나 오늘)만 `답변 받을 날`의 말을 쓰고,
// 먼 날짜와 다른 종류는 기존 기한 말투 그대로다(정보를 잃지 않게).
const uiItemDueText = (item, where = 'full') =>
  (item && item.type === 'check' ? uiReplyText(item.due) : null) || uiDueText(item && item.due, where);

// 상세에서는 날짜와 의미를 함께 적는다: `9월 22일 (화) · 오늘까지`.
function uiDueDetail(due) {
  if (!due) return null;
  const full = uiKoDate(due);
  const diff = diffDays(due);
  if (Number.isNaN(diff)) return { text: full, tone: '' };
  if (diff < 0) return { text: `${full} · 기한 ${-diff}일 지남`, tone: 'urgent' };
  if (diff === 0) return { text: `${full} · 오늘까지`, tone: 'warn' };
  if (diff === 1) return { text: `${full} · 내일까지`, tone: '' };
  return { text: `${full}까지`, tone: '' };
}

// 오늘 목록에 언제부터 밀려 있는지: `어제에서 밀림` / `5일째 밀림`
function uiCarryText(scheduled) {
  if (!scheduled) return null;
  const diff = diffDays(scheduled);
  if (Number.isNaN(diff) || diff >= 0) return null;
  return diff === -1 ? '어제에서 밀림' : `${-diff}일째 밀림`;
}

// Esc는 가장 위에 열린 것부터 하나씩 닫는다(설정 → 메뉴 → 검색 → 회의 → 상세 → 서랍).
// 여는 쪽이 escPush로 "닫는 방법"을 올려 두고, 닫을 때 escDrop으로 내린다.
const escStack = [];
function escPush(close) { escStack.push(close); return close; }
function escDrop(close) {
  const index = escStack.lastIndexOf(close);
  if (index >= 0) escStack.splice(index, 1);
}
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || event.isComposing || !escStack.length) return;
  event.preventDefault();
  // 스택에 열린 것이 있으면 아래쪽(옛) Esc 처리는 돌지 않는다.
  if (event.stopImmediatePropagation) event.stopImmediatePropagation();
  escStack.pop()();
});

// ⌘K(윈도는 Ctrl+K)로 검색 팔레트 — 입력칸 안에서도 되고, 한글을 조합하는 중에는 넘어간다.
// 헤더의 `검색 ⌘K` 버튼과 같은 길을 쓴다(닫으면 그 버튼으로 포커스가 돌아간다).
document.addEventListener('keydown', (event) => {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
  if (event.isComposing || String(event.key).toLowerCase() !== 'k') return;
  event.preventDefault();
  document.getElementById('searchEntryBtn')?.click();
});

// 한 벌뿐인 더보기 메뉴. 한 번에 하나만 열리고, 아래 자리가 없으면 위로 뒤집힌다.
// sections는 [[항목…], [항목…]] — 묶음 사이에 구분선이 들어간다.
// 항목은 { label, onClick, danger, disabled } 또는 값을 바꾸는 { field, control }.
let uiMenuOpen = null;
function uiMenuClose() {
  if (!uiMenuOpen) return;
  const { list, anchor, onEsc } = uiMenuOpen;
  uiMenuOpen = null;
  escDrop(onEsc);
  list.remove();
  anchor.setAttribute('aria-expanded', 'false');
}
function uiMenu(anchor, sections) {
  const sameButton = uiMenuOpen && uiMenuOpen.anchor === anchor;
  uiMenuClose();
  if (sameButton) return null;

  const list = document.createElement('div');
  list.className = 'd-menulist';
  list.setAttribute('role', 'menu');
  list.addEventListener('click', event => event.stopPropagation());
  list.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const focusable = [...list.querySelectorAll('button:not([disabled]), input, select')];
    if (!focusable.length) return;
    event.preventDefault();
    const step = event.key === 'ArrowDown' ? 1 : -1;
    const at = focusable.indexOf(document.activeElement);
    focusable[(at + step + focusable.length) % focusable.length].focus();
  });

  sections.filter(section => section && section.length).forEach((section, index) => {
    if (index) {
      const separator = document.createElement('div');
      separator.className = 'd-msep';
      list.appendChild(separator);
    }
    section.forEach((entry) => {
      if (!entry) return;
      if (entry.field !== undefined) {
        const row = document.createElement('div');
        row.className = 'd-mfield';
        const label = document.createElement('span');
        label.className = 'ml';
        label.textContent = entry.field;
        const slot = document.createElement('span');
        slot.className = 'mc';
        if (entry.control) slot.appendChild(entry.control);
        row.append(label, slot);
        list.appendChild(row);
        return;
      }
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'd-mitem' + (entry.danger ? ' dng' : '');
      item.setAttribute('role', 'menuitem');
      item.textContent = entry.label;
      if (entry.disabled) item.disabled = true;
      item.addEventListener('click', () => { uiMenuClose(); entry.onClick(); });
      list.appendChild(item);
    });
  });

  document.body.appendChild(list);
  const button = anchor.getBoundingClientRect();
  const size = list.getBoundingClientRect();
  // 값 고르개(상세 카드의 `보통 ⌄`)는 값의 왼쪽에 맞춰 카드 안에서 열리고, ⋯ 메뉴는 버튼 오른쪽에 맞춘다.
  const pick = anchor.classList.contains('d-dpick');
  const card = pick && anchor.closest('.d-popd') ? anchor.closest('.d-popd').getBoundingClientRect() : null;
  const edge = card ? card.right - 12 : window.innerWidth - 8;
  const start = pick ? button.left : button.right - size.width;
  const left = Math.max(8, Math.min(start, edge - size.width));
  const below = button.bottom + 4;
  const top = below + size.height > window.innerHeight - 8
    ? Math.max(8, button.top - 4 - size.height)
    : below;
  list.style.left = `${Math.round(left)}px`;
  list.style.top = `${Math.round(top)}px`;

  anchor.setAttribute('aria-haspopup', 'true');
  anchor.setAttribute('aria-expanded', 'true');
  const onEsc = () => { uiMenuClose(); anchor.focus(); };
  escPush(onEsc);
  uiMenuOpen = { list, anchor, onEsc };
  list.querySelector('button:not([disabled]), input, select')?.focus();
  return list;
}
document.addEventListener('click', (event) => {
  if (uiMenuOpen && !uiMenuOpen.anchor.contains(event.target)) uiMenuClose();
});

// 날짜 칸 한 벌. 비어 있으면 `+ 기한`, 누르면 그 자리에서 고르고 ✕로 지운다.
function uiDateField({ value, label = '기한', onChange, clearable = true }) {
  const wrap = document.createElement('span');
  wrap.className = 'd-datefield';
  let current = value || '';
  let editing = false;

  const draw = () => {
    wrap.replaceChildren();
    if (!current && !editing) {
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'd-btn sm';
      open.textContent = `+ ${label}`;
      open.addEventListener('click', () => { editing = true; draw(); });
      wrap.appendChild(open);
      return;
    }
    const input = document.createElement('input');
    input.type = 'date';
    input.className = 'd-dateinput';
    input.value = current;
    input.setAttribute('aria-label', label);
    input.addEventListener('change', () => {
      current = input.value;
      editing = false;
      onChange(current || null);
      draw();
    });
    wrap.appendChild(input);
    if (current && clearable) {
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'd-iconbtn sm';
      clear.setAttribute('aria-label', `${label} 지우기`);
      clear.innerHTML = uiIcon('close');
      clear.addEventListener('click', () => { current = ''; editing = false; onChange(null); draw(); });
      wrap.appendChild(clear);
    }
    if (editing) input.focus();
  };
  draw();
  return wrap;
}

// 의미 색은 배경이 아니라 글자에 쓴다. 토큰 이름으로 옮겨 준다.
function uiTone(tone) {
  return tone === 'urgent' ? ' k-neg' : tone === 'warn' ? ' k-warn' : tone === 'success' ? ' k-pos' : '';
}

// 프로젝트 이름을 만드는 단 하나의 규칙. 지라면 이슈를 찾아 이름을 짓고(모르면 키만),
// 그 밖은 그룹/프로젝트 이름 그대로다.
// 기본(옵션 없음)은 **요약만**이다(모르면 키) — 목록·그룹 제목·프로젝트 탭·주간요약·팔레트 등 바깥
// 화면은 전부 이 기본을 쓴다. 키가 꼭 필요한 두 자리만 opts로 청한다:
// opts.withKey — 상세 카드의 값·title 툴팁처럼 `키 · 요약`을 그대로 보여줘야 하는 자리(BKEY 결정).
// opts.picker — 프로젝트를 고르는 목록의 `요약 · 키`(고르는 순간은 어느 티켓인지 확인하는 자리라 키를
// 남기되, 눈이 먼저 가는 앞자리는 요약이다).
function uiProjectName(item, opts = {}) {
  if (!item) return '';
  if (item.jira) {
    const issue = jiraIssuesByKey.get(item.jira);
    const summary = issue ? issue.summary : '';
    if (!summary) return item.jira;
    if (opts.withKey) return `${item.jira} · ${summary}`;
    if (opts.picker) return `${summary} · ${item.jira}`;
    return summary;
  }
  return item.group || item.project || '';
}

// 색 점을 고르는 원래 키 — 표기(짧은 요약이든 긴 `KEY · 요약`이든)와 무관하게 늘 같다.
// 같은 프로젝트가 자리마다 다른 색으로 보이면 안 된다.
function uiProjectColorKey(item) {
  return (item && (item.jira || item.group || item.project)) || '';
}

// 행의 프로젝트 이름. 그룹 제목이 이미 그 프로젝트를 말해 주면 비운다.
function uiProjectLabel(item, grouped) {
  if (grouped) return '';
  return uiProjectName(item);
}

// 줄 오른쪽의 글자 셀: 상태(밀림 · N일째 진행 중 · 답변) → 기한(맨 오른쪽, 달력). **날짜 성격의 말만** 선다.
// 있는 것만 오른쪽으로 이어 붙이고(기한이 맨 오른쪽), 보통·낮음·먼 기한처럼 의미 없는 값은 아예 적지 않는다.
// 기한·밀림·진행·답변에는 14px 아이콘과 풀어 쓴 title 툴팁이 함께 붙는다. 급한 말(기한 N일 지남·오늘까지)만
// 배지로 서고 나머지는 회색 글자다(모양은 ui.css가 정한다).
// **우선순위는 `opts.noPriority`인 줄에서는 여기 나오지 않는다** — 업무 체크박스가 안의 위 꺾쇠로 말한다
// (같은 말을 한 줄에서 두 번 하지 않는다). 체크박스가 없는 자리(미루기 제안 줄)에서는 예전처럼 글자로 쓴다.
const UI_PRIORITY_META = {
  critical: { text: '긴급', tone: 'urgent', hint: '가장 먼저 해야 하는 업무예요', level: 'top', mark: 'priTop' },
  high: { text: '중요', tone: 'warn', hint: '중요한 업무예요', level: 'high', mark: 'priHigh' },
};
// 화면 어디서나 같은 말로 고르게 한다(상세·메뉴의 선택지도 이 순서·이 말을 쓴다).
const UI_PRIORITY_CHOICES = [['critical', '긴급'], ['high', '중요'], ['medium', '보통'], ['low', '낮음']];
function uiMetaCells(item, opts = {}) {
  const where = opts.where || 'row';
  const done = item.status === 'done';
  const cells = [];
  const cell = (cls, icon, text, hint) =>
    `<span class="${cls}"${hint ? ` title="${escapeAttr(hint)}"` : ''}>${uiIcon(icon)}${escapeHtml(text)}</span>`;
  // 우선순위는 아이콘 없이 글자·색만으로 알린다(긴급은 빨간 배지 글자, 중요는 주황 글자).
  const cellPlain = (cls, text, hint) =>
    `<span class="${cls}"${hint ? ` title="${escapeAttr(hint)}"` : ''}>${escapeHtml(text)}</span>`;
  // 좁은 화면(≤520px)의 두 줄 행에서는 프로젝트가 정보 줄 맨 앞에 온다 — 넓은 화면에서는 제목 뒤·프로젝트 열이 보여 준다.
  if (opts.project) cells.push(`<span class="m-proj">${escapeHtml(opts.project)}</span>`);
  // 체크박스가 우선순위를 말하는 줄에서는 글자로 또 적지 않는다.
  const priority = done || opts.noPriority ? null : UI_PRIORITY_META[item.priority];
  const priorityCell = priority ? cellPlain(`m-pri${uiTone(priority.tone)}`, priority.text, priority.hint) : '';
  const status = [];
  if (opts.waiting) status.push(uiWaitCell(opts.waiting === 'answered'));
  const carry = where === 'row' && !done ? uiCarryText(item.scheduled) : null;
  if (carry) status.push(cell('m-carry', 'clock', carry, '오늘 하려다 넘어온 업무예요'));
  if (item.doing && !done && !opts.inDoingGroup) {
    const days = -diffDays(item.doing) + 1;
    status.push(cell('m-doing', 'clock', days > 1 ? `${days}일째 진행 중` : '진행 중', '이미 손을 댄 업무예요'));
  }
  const due = done ? null : uiDueText(item.due, where);
  const dueCell = due ? cell(`m-due${uiTone(due.tone)}`, 'calendar', due.text, item.due ? `기한은 ${uiKoDate(item.due)}이에요` : '') : '';
  return [...cells, priorityCell, ...status, dueCell].filter(Boolean).join('');
}

// 업무 체크박스 한 칸(체크 + 흰 체크 + 우선순위 꺾쇠). 체크박스가 있는 줄은 모두 이 부품을 쓴다.
// 꺾쇠는 체크박스 위에 겹치고 `pointer-events: none`이라 누르는 자리는 그대로 28px이다.
// 완료한 줄에는 붙지 않는다(체크된 파란 네모가 이미 다 말한다).
const uiPriorityMark = (item, done) => (!done && item ? UI_PRIORITY_META[item.priority] || null : null);
function uiCheckCell(item, row, done) {
  const cell = document.createElement('span');
  cell.className = 'd-check';
  cell.appendChild(taskCompletionCheckbox(item, row, done));
  const mark = uiPriorityMark(item, done);
  // 고정 문자열만 넣는다 — 사용자 글자는 체크박스의 aria-label·title(textContent 계열)로만 간다.
  cell.insertAdjacentHTML('beforeend', UI_TICK_SVG
    + (mark ? `<svg class="d-pri" viewBox="0 0 16 16" aria-hidden="true">${UI_ICONS[mark.mark]}</svg>` : ''));
  return cell;
}

// 답변을 기다리는 업무에 붙는 말 한 마디(말풍선 아이콘 + 글자).
function uiWaitCell(resolved) {
  return `<span class="m-wait${resolved ? ' k-pos' : ''}" title="${resolved ? '기다리던 답변이 왔어요' : '다른 사람의 답변을 기다리는 중이에요'}">`
    + `${uiIcon('chat')}${resolved ? '답변 왔어요' : '답변 기다리는 중'}</span>`;
}

// 원문이 있으면 제목 바로 뒤에 조용한 `원문` 링크를 늘 보여 준다(새 탭, 줄 열기로 번지지 않게).
function uiSourceLink(item, label = '원문') {
  if (!item || !item.permalink) return null;
  const link = document.createElement('a');
  link.className = 'd-src';
  link.href = item.permalink;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = label;
  link.title = '슬랙 원문을 새 탭에서 열어요';
  link.setAttribute('aria-label', `${item.description} — 슬랙 원문 열기`);
  link.addEventListener('click', event => event.stopPropagation());
  return link;
}

// 이름 → 늘 같은 색 하나(0~5). 같은 프로젝트가 그룹 열쇠(`group:가입_개선`)로도, 이름(`가입 개선`)으로도
// 들어오므로 먼저 같은 꼴로 맞춘다. 겹침은 피하지 않는다 — 프로젝트가 하나 늘었다고 다른 색이 밀리면 안 된다.
function uiProjectKey(name) {
  return String(name || '').replace(/^(group|jira):/, '').toLowerCase().replace(/[\s_-]/g, '');
}
function uiProjectHue(name) {
  const key = uiProjectKey(name);
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return hash % 6;
}
function uiProjectDot(name) {
  const dot = document.createElement('i');
  dot.className = 'd-pjdot';
  dot.dataset.pj = String(uiProjectHue(name));
  dot.setAttribute('aria-hidden', 'true');
  return dot;
}

// 그룹 제목이 프로젝트를 말해 주지 않는 자리에서 제목 뒤에 붙는 `· ● 이름`(색 점 + 회색 글자).
// 줄 안의 짧은 표기라 지라는 요약만 보여 준다(모르면 키) — 전체 `KEY · 요약`은 title 툴팁에 남긴다.
// 색 점은 표기와 무관하게 원래 키로 고른다(uiProjectColorKey). opts.lead === false면(줄 맨 앞에
// 오는 확인 대기 급한 순처럼) 앞머리의 `· `를 붙이지 않는다.
function uiInlineProject(item, opts = {}) {
  const short = uiProjectName(item);
  const tag = document.createElement('span');
  tag.className = 'd-inproj';
  tag.title = uiProjectName(item, { withKey: true });
  const lead = opts.lead === false ? [] : ['· '];
  tag.append(...lead, uiProjectDot(uiProjectColorKey(item)), short);
  return tag;
}

// sticky 그룹 제목. 접히는 그룹은 줄 전체가 버튼이고, 마우스를 올리면 `+`로 그 자리에 추가한다.
// 프로젝트 그룹이면 제목 앞에 그 프로젝트의 색 점이 붙는다.
function uiGroupHeading(label, count, opts = {}) {
  const collapsible = typeof opts.onToggle === 'function';
  const head = document.createElement(collapsible ? 'button' : 'div');
  head.className = 'd-grp' + (opts.tone === 'doing' ? ' is-doing' : '') + (collapsible ? ' tog' : '');
  if (collapsible) {
    head.type = 'button';
    head.setAttribute('aria-expanded', String(!!opts.open));
    head.innerHTML = uiIcon('chevron');
    head.addEventListener('click', opts.onToggle);
  }
  if (opts.projectName) head.appendChild(uiProjectDot(opts.projectName));
  const name = document.createElement(opts.onOpenProject ? 'button' : 'span');
  name.className = 'gl' + (opts.onOpenProject ? ' lk' : '');
  name.textContent = label;
  name.title = label;
  if (opts.onOpenProject) {
    name.type = 'button';
    name.setAttribute('aria-label', `${label} 프로젝트 보기`);
    name.addEventListener('click', opts.onOpenProject);
  }
  head.appendChild(name);
  if (count) {
    const number = document.createElement('span');
    number.className = 'n num';
    number.textContent = count;
    head.appendChild(number);
  }
  if (opts.onAdd) {
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'd-iconbtn sm d-grpadd';
    add.setAttribute('aria-label', `${label}에 할 일 추가`);
    add.innerHTML = uiIcon('plus');
    add.addEventListener('click', (event) => { event.stopPropagation(); opts.onAdd(); });
    head.appendChild(add);
  }
  return head;
}

// 그룹 제목의 `+`로 여는 그 자리 입력줄. 저장 뒤 목록을 다시 그려도 같은 줄로 포커스가 돌아온다.
function uiGroupAddRow(key, endpoint, announceText) {
  const row = document.createElement('div');
  row.className = 'd-addrow';
  row.dataset.addKey = `${endpoint}::${key}`;
  row.hidden = true;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'd-addinput';
  input.placeholder = '이 그룹에 추가 — Enter';
  input.setAttribute('aria-label', `${key === '__misc__' ? '프로젝트 없음' : key.slice(key.indexOf(':') + 1)} 그룹에 할 일 추가`);
  input.addEventListener('keydown', async (event) => {
    if (event.key === 'Escape' && !event.isComposing) { row.hidden = true; return; }
    if (event.key !== 'Enter' || event.isComposing || input.disabled) return;
    const description = input.value.trim();
    if (!description) return;
    input.disabled = true;
    const payload = { description };
    if (key.startsWith('jira:')) payload.jira = key.slice(5);
    else if (key.startsWith('group:')) payload.group = key.slice(6);
    try {
      await request(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      input.value = '';
      announce(announceText);
      await load();
      // load()가 목록을 다시 그려서 이 입력칸은 떨어져 나간다 — 같은 그룹의 새 줄을 찾아 다시 연다.
      const reopened = document.querySelector(`.d-addrow[data-add-key="${CSS.escape(row.dataset.addKey)}"] .d-addinput`);
      if (reopened) { reopened.closest('.d-addrow').hidden = false; reopened.focus(); }
    } catch { /* Keep the draft for retry. */ }
    finally { input.disabled = false; if (input.isConnected) input.focus(); }
  });
  row.appendChild(input);
  return row;
}

// 모든 줄·상세의 ⋯ 버튼. 누를 때마다 메뉴 내용을 새로 만든다(함수로 받는다) — 늘 지금 값이 보이게.
function uiMoreButton(label, sections, className = 'd-iconbtn sm') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `${className} d-more`;
  button.setAttribute('aria-label', label);
  button.setAttribute('aria-haspopup', 'true');
  button.setAttribute('aria-expanded', 'false');
  button.innerHTML = uiIcon('more');
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    uiMenu(button, typeof sections === 'function' ? sections() : sections);
  });
  return button;
}

// 메뉴 안에서 값을 고르는 칩 줄. 지금 값만 파랗게 표시한다(드롭다운보다 한눈에 보인다).
function uiMenuChips(options, current, onPick) {
  const wrap = document.createElement('span');
  wrap.className = 'd-chips';
  options.forEach(([value, text]) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'd-chip' + (value === current ? ' is-on' : '');
    chip.setAttribute('role', 'menuitem');
    chip.textContent = text;
    chip.addEventListener('click', () => onPick(value, wrap));
    wrap.appendChild(chip);
  });
  return wrap;
}

// 메뉴 안의 한 줄 글자 칸(누구에게). Enter·포커스 이동 때 저장하고, 실패해도 적은 글자는 남긴다.
function uiMenuText({ value, label, placeholder, onChange }) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'd-mtext';
  input.value = value || '';
  if (placeholder) input.placeholder = placeholder;
  input.setAttribute('aria-label', label);
  let saved = (value || '').trim();
  let sending = null;
  const commit = async () => {
    const next = input.value.trim();
    if (next === saved || sending === next) return;
    sending = next;
    input.disabled = true;
    try { await onChange(next || null); saved = next; }
    catch { /* 입력은 그대로 남긴다 */ }
    finally { sending = null; input.disabled = false; }
  };
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    commit();
  });
  return input;
}

// 완료 행의 결과 한 줄. 없으면 글자 링크, 누르면 그 자리에서 적는다(Enter 저장 / Esc 취소).
function uiResultCell(meta, item) {
  const detail = typeof wfItem === 'function' ? wfItem(item.id) : null;
  const outcome = item.outcome || detail?.outcome || '';
  meta.replaceChildren();
  if (outcome) {
    const text = document.createElement('span');
    text.className = 'out';
    text.textContent = outcome;
    text.title = outcome;
    meta.appendChild(text);
    return;
  }
  const link = document.createElement('button');
  link.type = 'button';
  link.className = 'd-link';
  link.textContent = '결과 한 줄 적기';
  link.setAttribute('aria-label', `${item.description} — 결과 한 줄 적기`);
  link.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'd-resin';
    input.placeholder = '결과 한 줄 — Enter로 저장';
    input.setAttribute('aria-label', `${item.description} — 결과 한 줄`);
    meta.replaceChildren(input);
    input.focus();
    input.addEventListener('keydown', async (event) => {
      if (event.isComposing || input.disabled) return;
      if (event.key === 'Escape') { uiResultCell(meta, item); return; }
      if (event.key !== 'Enter') return;
      const value = input.value.trim();
      if (!value) { uiResultCell(meta, item); return; }
      input.disabled = true;
      try {
        // 상세의 `결과 한 줄`과 같은 저장 경로를 쓴다.
        await postJson('/api/workflow/item', { id: item.id, outcome: value });
        await load();
      } catch { input.disabled = false; }
    });
  });
  meta.appendChild(link);
}

// D 행: 36px 한 줄, 체크 | 제목 | 프로젝트 | 상태 열.
// 동작은 hover·focus·선택됐을 때 상태 열 위에 겹쳐 뜬다(제목 폭을 뺏지 않는다).
function uiTaskRow(item, opts = {}) {
  const mode = opts.mode || 'today';
  const done = item.status === 'done';
  const carried = mode === 'today' && !done && !!uiCarryText(item.scheduled);
  const project = uiProjectLabel(item, opts.grouped);
  const row = document.createElement('div');
  row.className = 'd-row'
    + (done ? ' is-done done' : '')
    + (item.doing && !done ? ' is-doing' : '')
    + (panelState && panelState.id === item.id ? ' is-sel' : '');
  row.dataset.taskId = item.id;
  row.setAttribute('role', 'group');

  // 여러 개 선택 중에는 완료 체크 왼쪽에 선택 칸이 한 칸 더 생긴다(네모 하나, 모양이 다르다).
  // 완료 체크는 선택 모드에서도 그대로 눌러 한 건만 끝낼 수 있다.
  let selectBox = null;
  if (taskSelectionMode) {
    const cell = document.createElement('span');
    cell.className = 'd-sel';
    // 완료한 줄은 고를 수 없다 — 칸은 자리만 지킨다.
    if (!done) { selectBox = taskSelectionCheckbox(item, row); cell.appendChild(selectBox); }
    row.appendChild(cell);
  }
  row.appendChild(uiCheckCell(item, row, done));

  const title = document.createElement('span');
  title.className = 'd-title';
  title.title = item.description;
  title.textContent = item.description;
  title.tabIndex = 0;
  title.setAttribute('role', 'button');
  title.setAttribute('aria-label', taskSelectionMode && !done ? `${item.description} 선택` : `${item.description} 상세 보기`);
  const open = () => {
    if (taskSelectionMode) { if (selectBox && !taskBatchBusy) selectBox.click(); return; }
    panelOpen({ id: item.id });
  };
  title.addEventListener('click', open);
  title.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
  });
  // NEW는 누르는 버튼이 아니라 표시다 — 화면에 잠깐 머물면 조용히 사라진다(observeNewItem).
  if (item.isNew && !done) { title.prepend(renderNewDot(item)); observeNewItem(row, item); }

  // 그룹 제목이 프로젝트를 말해 주지 않는 자리(진행 중·마감순·서랍)에서는 제목 바로 뒤에 `· ● 프로젝트`.
  // 원문이 있으면 그 뒤에 조용한 `원문` 링크가 늘 따라온다.
  const inlineProject = project;
  const source = uiSourceLink(item);
  if (inlineProject || source) {
    const wrap = document.createElement('span');
    wrap.className = 'd-titlewrap';
    wrap.appendChild(title);
    if (inlineProject) wrap.appendChild(uiInlineProject(item));
    if (source) wrap.appendChild(source);
    row.appendChild(wrap);
  } else {
    row.appendChild(title);
  }

  const projectCell = document.createElement('span');
  projectCell.className = 'd-proj';
  // 프로젝트는 이제 제목 뒤에 적는다 — 줄 가운데의 열은 좁은 화면 규칙만 쓰도록 비워 둔다.
  row.appendChild(projectCell);

  const meta = document.createElement('span');
  meta.className = 'd-meta';
  if (done) {
    uiResultCell(meta, item);
  } else {
    // 답변을 기다리는 업무는 그 사실도 글자로 적는다(밀림·진행과 같은 상태에 이어 선다).
    const blocker = typeof wfItem === 'function' ? wfItem(wfItem(item.id)?.blockedBy) : null;
    // 우선순위는 왼쪽 체크박스가 말한다 — 이 줄의 오른쪽에는 날짜 성격의 말만 오른쪽 끝에 붙는다.
    meta.innerHTML = uiMetaCells(item, {
      where: mode === 'later' ? 'full' : 'row', inDoingGroup: opts.inDoingGroup, project, noPriority: true,
      waiting: blocker ? (blocker.status === 'done' ? 'answered' : 'waiting') : null,
    });
  }
  row.appendChild(meta);

  const acts = document.createElement('span');
  acts.className = 'd-acts';
  if (!done && !taskSelectionMode) {
    const move = (label, scheduled, message) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'd-btn sm';
      button.textContent = label;
      button.setAttribute('aria-label', `${item.description} — ${label}`);
      button.addEventListener('click', async () => {
        button.disabled = true;
        await fadeOutAndRun(row, () => setTaskScheduled(item.id, scheduled), message);
        button.disabled = false;
      });
      acts.appendChild(button);
    };
    if (mode === 'later') {
      move('오늘로', todayStr(), '오늘 할 일로 옮겼어요');
    } else {
      if (carried) move('오늘 할게요', todayStr(), '오늘 할 일로 옮겼어요');
      move('내일', tomorrowStr(), '내일로 미뤘어요');
      move('나중에', null, '나중에 할 일로 옮겼어요 · 기한은 그대로예요');
    }
    // 슬랙 원문은 제목 뒤 `원문` 링크가 늘 보여 주므로 동작 묶음에는 두지 않는다.
    acts.appendChild(uiMoreButton(`${item.description} — 더 보기`, () => taskMenuSections({ item, mode, card: row })));
  }
  row.appendChild(acts);
  return row;
}

// 그룹 열쇠(`jira:…` / `group:…` / `__misc__`)를 사람이 읽는 제목으로. 기본은 요약만(모르면 키) —
// uiProjectName과 같은 규칙이다. opts.withKey면 상세·툴팁 자리처럼 `키 · 요약`(그룹은 차이 없다).
function uiGroupLabel(key, opts = {}) {
  if (key === '__misc__') return '프로젝트 없음';
  if (key.startsWith('jira:')) return uiProjectName({ jira: key.slice(5) }, opts);
  return key.slice(6);
}

// 그룹 열쇠 여러 개를 한 번에 제목으로 바꾼다 — 같은 요약을 가진 지라 이슈가 이 목록에 둘 이상이면
// 그때만 뒤에 키를 붙여 구분한다(`요약 · KEY`). 이 판단은 여기 한 곳에서만 한다.
function uiGroupLabels(keys) {
  const counts = new Map();
  keys.forEach((key) => {
    const label = uiGroupLabel(key);
    counts.set(label, (counts.get(label) || 0) + 1);
  });
  const map = new Map();
  keys.forEach((key) => {
    const label = uiGroupLabel(key);
    const dupe = key.startsWith('jira:') && counts.get(label) > 1;
    map.set(key, dupe ? uiGroupLabel(key, { withKey: true }) : label);
  });
  return map;
}

// 프로젝트별로 묶고, 프로젝트 없는 것은 맨 뒤에 둔다.
// 아이디어는 프로젝트를 `project`에 담는다 — 흐름 기록의 `wfKey`와 같은 규칙으로 맞춘다.
function uiGroupTasks(items) {
  const groups = new Map();
  items.forEach((item) => {
    const named = item.group || item.project;
    const key = item.jira ? `jira:${item.jira}` : named ? `group:${named}` : '__misc__';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  });
  const named = [...groups.keys()].filter(key => key !== '__misc__').sort();
  return (groups.has('__misc__') ? [...named, '__misc__'] : named).map(key => [key, groups.get(key)]);
}

// 레일 한 줄(확인 대기·리마인드·후속 알림). 제목은 한 줄 말줄임(title에 전체), 오른쪽은 조용한 글자.
// opts: { text, onOpen, wrap(2줄 허용), check(체크박스), badge(NEW 점), meta[{text,tone,strong}], sub, more, selected }
function uiRailRow(opts) {
  const row = document.createElement('div');
  row.className = 'd-wrow'
    + (opts.check ? ' has-ck' : '')
    + (opts.wrap ? ' is-wrap' : '')
    + (opts.two ? ' is-two' : '')
    + (opts.selected ? ' is-sel' : '');
  // 상세 카드가 열리고 닫힐 때 이 표식으로 찾아 `지금 보는 줄`을 표시한다.
  if (opts.id !== undefined && opts.id !== null) row.dataset.railId = opts.id;
  if (opts.check) {
    const cell = document.createElement('span');
    cell.className = 'ck';
    cell.appendChild(opts.check);
    row.appendChild(cell);
  }
  const title = document.createElement(opts.onOpen ? 'button' : 'span');
  title.className = 'ti';
  title.title = opts.text;
  title.textContent = opts.text;
  if (opts.onOpen) {
    title.type = 'button';
    title.setAttribute('aria-label', `${opts.text} 상세 보기`);
    title.addEventListener('click', opts.onOpen);
  }
  if (opts.badge) title.prepend(opts.badge);
  // 원문이 있으면 제목 바로 뒤에 조용한 `원문` 링크(줄 열기로 번지지 않는다)
  if (opts.source) {
    const wrap = document.createElement('span');
    wrap.className = 'tiwrap';
    wrap.append(title, opts.source);
    row.appendChild(wrap);
  } else {
    row.appendChild(title);
  }

  const meta = document.createElement('span');
  meta.className = 'mt';
  (opts.meta || []).filter(part => part && part.text).forEach((part, index) => {
    if (index) meta.appendChild(document.createTextNode(' · '));
    const cell = document.createElement(part.strong ? 'b' : 'span');
    cell.className = uiTone(part.tone).trim();
    cell.textContent = part.text;
    meta.appendChild(cell);
  });
  row.appendChild(meta);

  if (opts.sub) {
    const sub = document.createElement('span');
    sub.className = 'sub';
    if (typeof opts.sub === 'string') sub.textContent = opts.sub;
    else sub.appendChild(opts.sub);
    row.appendChild(sub);
  }
  if (opts.more) {
    const slot = document.createElement('span');
    slot.className = 'ac';
    slot.appendChild(opts.more);
    row.appendChild(slot);
  }
  return row;
}

// ---------- 여러 개 선택 (일괄 정리) ----------
// 머리줄의 조용한 `여러 개 선택`을 누르면 줄마다 선택 칸이 한 칸 더 생기고(완료 체크는 그대로),
// 화면 아래에 고정 막대가 뜬다. 오늘 목록과 나중에 할 일 서랍이 함께 대상이다.
// 저장은 전부 기존 API로 간다: 날짜·프로젝트·완료는 `/api/workflow/task-batch`,
// 삭제만 한 건씩 `/api/track/remove`를 보내고 알림 하나로 되돌린다(DECISIONS: 원문 보존 그대로).

let taskSelectionMode = false;
let taskBatchBusy = false;
const taskSelection = new Set();

// 전체 선택/해제 계산. 완료한 줄은 고를 수 없으므로 후보에서 빠진다.
function taskSelectAllState(items, selected) {
  const chosen = new Set(selected);
  const candidates = items.filter(item => item.status !== 'done').map(item => item.id);
  return {
    candidates,
    count: candidates.filter(id => chosen.has(id)).length,
    all: candidates.length > 0 && candidates.every(id => chosen.has(id)),
  };
}

const taskSelectPool = () => [...taskListsCache.todayTasks, ...taskListsCache.laterTasks];

// 줄 왼쪽의 선택 칸(네모). 완료 체크와 달리 줄을 사라지게 하지 않는다.
function taskSelectionCheckbox(item, row) {
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = 'd-selcb';
  input.checked = taskSelection.has(item.id);
  input.disabled = taskBatchBusy;
  input.setAttribute('aria-label', `${item.description} — 일괄 정리 선택`);
  row.classList.toggle('batch-selected', input.checked);
  input.addEventListener('change', () => {
    if (input.checked) taskSelection.add(item.id); else taskSelection.delete(item.id);
    row.classList.toggle('batch-selected', input.checked);
    taskSelectionRefresh();
  });
  return input;
}

function taskListsRender() {
  renderTodayTasks(taskListsCache.todayTasks);
  renderLaterTasks(taskListsCache.laterTasks);
  taskSelectionRefresh();
}

function taskSelectStart() {
  if (taskSelectionMode) return;
  taskSelectionMode = true;
  taskSelection.clear();
  escPush(taskSelectEnd);
  taskListsRender();
}

function taskSelectEnd() {
  // 저장이 도는 중의 Esc는 아무것도 닫지 못한다 — 스택에서 빠진 자기를 되돌려 놓아야 다음 Esc가 듣는다.
  if (taskSelectionMode && taskBatchBusy) { if (!escStack.includes(taskSelectEnd)) escPush(taskSelectEnd); return; }
  if (!taskSelectionMode) return;
  taskSelectionMode = false;
  taskSelection.clear();
  escDrop(taskSelectEnd);
  uiMenuClose();
  taskListsRender();
  (document.getElementById('taskSelectToggle') || document.querySelector('#todayHeadMore .d-more'))?.focus();
}

function taskSelectBarButton(label, onClick, className = 'd-btn') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

function taskSelectionRefresh() {
  const toggle = document.getElementById('taskSelectToggle');
  if (toggle) {
    toggle.textContent = taskSelectionMode ? '선택 끝내기' : '여러 개 선택';
    toggle.setAttribute('aria-pressed', String(taskSelectionMode));
    toggle.disabled = taskBatchBusy;
  }
  document.body.classList.toggle('batch-open', taskSelectionMode);
  const bar = document.getElementById('taskSelectBar');
  if (!bar) return;
  bar.hidden = !taskSelectionMode;
  bar.replaceChildren();
  if (!taskSelectionMode) return;

  const state = taskSelectAllState(taskSelectPool(), [...taskSelection]);
  const inner = document.createElement('div');
  inner.className = 'bar';

  const count = document.createElement('span');
  count.className = 'ct num';
  count.textContent = `${state.count}개 선택`;
  inner.appendChild(count);
  inner.appendChild(taskSelectBarButton(state.all ? '전체 선택 해제' : '전체 선택', () => {
    if (state.all) taskSelection.clear();
    else state.candidates.forEach(id => taskSelection.add(id));
    taskListsRender();
  }, 'd-link'));

  const actions = [];
  const apply = (label, change, className) => {
    const button = taskSelectBarButton(label, () => taskBatchApply(change), className);
    actions.push(button);
    inner.appendChild(button);
  };
  apply('오늘로', { scheduled: todayStr() });
  apply('내일', { scheduled: tomorrowStr() });
  apply('나중에', { scheduled: null });

  // `날짜…`는 누른 자리에서 날짜 칸으로 바뀐다(더보기의 `날짜…`와 같은 방식).
  const pick = taskSelectBarButton('날짜…', () => {
    const input = document.createElement('input');
    input.type = 'date';
    input.className = 'd-dateinput';
    input.setAttribute('aria-label', '선택한 업무를 옮길 날짜');
    input.addEventListener('change', () => { if (input.value && input.checkValidity()) taskBatchApply({ scheduled: input.value }); });
    pick.replaceWith(input);
    input.focus();
    input.showPicker?.();
  });
  actions.push(pick);
  inner.appendChild(pick);

  const project = taskSelectBarButton('프로젝트…', (event) => {
    event.stopPropagation();
    uiMenu(project, [[{
      field: '프로젝트',
      control: renderGroupControl({
        jira: null, group: null, silent: true, forceClearable: true,
        onSetJira: key => taskBatchApply({ project: key ? `jira:${key}` : null }),
        // `— 그룹 해제 —`는 지라 해제 한 번으로 끝난다 — 같은 선택에 두 번 보내지 않는다.
        onSetGroup: group => group === null ? Promise.resolve() : taskBatchApply({ project: `group:${group}` }),
      }),
    }]]);
  });
  project.setAttribute('aria-haspopup', 'true');
  project.setAttribute('aria-expanded', 'false');
  actions.push(project);
  inner.appendChild(project);

  // 완료로 표시는 이 막대에서 가장 많이 누르는 동작이라 2차(연파랑)로 한 단계 올린다.
  apply('완료로 표시', { status: 'done' }, 'd-btn acc');
  const remove = taskSelectBarButton('삭제', () => taskBatchRemove(), 'd-btn dng');
  actions.push(remove);
  inner.appendChild(remove);

  const spacer = document.createElement('span');
  spacer.className = 'sp';
  inner.appendChild(spacer);
  const end = taskSelectBarButton('선택 끝내기', taskSelectEnd);
  end.disabled = taskBatchBusy;
  inner.appendChild(end);

  // 아무것도 고르지 않았으면 바꾸는 버튼은 눌리지 않는다(끝내기·전체 선택은 그대로).
  actions.forEach((button) => { button.disabled = taskBatchBusy || !state.count; });
  bar.appendChild(inner);
}

// 날짜·프로젝트·완료 — 기존 일괄 저장 API 한 곳으로 간다. 되돌리기는 서버가 준 undoToken으로.
async function taskBatchApply(change) {
  if (taskBatchBusy || !taskSelection.size) return;
  taskBatchBusy = true;
  taskSelectionRefresh();
  document.querySelectorAll('.d-selcb').forEach(input => { input.disabled = true; });
  try {
    const result = await wfPost('task-batch', { ids: [...taskSelection], change });
    let token = result.undoToken;
    const restore = async () => { const back = await wfPost('task-batch', { undoToken: token }); token = back.undoToken; };
    const entry = { label: `${result.count}개 업무 일괄 정리`, undo: restore, redo: restore };
    pushUndo(entry);
    taskSelection.clear();
    await load();
    showNotice(`${result.count}개를 바꿨어요`, false, null, { label: '실행 취소', onClick: async () => {
      if (undoStack[undoStack.length - 1] !== entry) { showNotice('최근 작업부터 순서대로 실행 취소해 주세요', true); return; }
      await replayUndo('undo');
    } });
  } finally {
    taskBatchBusy = false;
    taskSelectionRefresh();
    document.querySelectorAll('.d-selcb').forEach(input => { input.disabled = false; });
  }
}

// 일괄 삭제는 서버를 새로 만들지 않는다 — 고른 순서대로 한 건씩 휴지통으로 보내고(원문 보존),
// 알림 하나의 `되돌리기`로 역순 복원한다. 중간에 실패하면 멈추고 어디까지 지웠는지 알린다.
async function taskBatchRemove() {
  if (taskBatchBusy || !taskSelection.size) return;
  const ids = [...taskSelection];
  taskBatchBusy = true;
  taskSelectionRefresh();
  const removed = [];
  let stopped = false;
  // 한 건씩 보내는 동안 ⌘Z 기록은 남기지 않는다 — 아래에서 묶음 하나로 올린다.
  const replaying = undoReplaying;
  undoReplaying = true;
  try {
    for (const id of ids) {
      try { await postJson('/api/track/remove', { id }); removed.push(id); }
      catch { stopped = true; break; }
    }
  } finally {
    undoReplaying = replaying;
    taskBatchBusy = false;
  }
  if (!removed.length) { taskSelectionRefresh(); return; }
  const entry = {
    label: `${removed.length}개 업무 삭제`,
    undo: async () => { for (const id of [...removed].reverse()) await postJson('/api/track/restore', { id }); },
    redo: async () => { for (const id of removed) await postJson('/api/track/remove', { id }); },
  };
  pushUndo(entry);
  taskSelection.clear();
  await load();
  showNotice(
    stopped ? `${removed.length}개까지 삭제하고 멈췄어요 · 나머지는 그대로 있어요` : `${removed.length}개를 삭제했어요`,
    false, null,
    { label: '되돌리기', onClick: async () => {
      if (undoStack[undoStack.length - 1] !== entry) { showNotice('최근 작업부터 순서대로 실행 취소해 주세요', true); return; }
      await replayUndo('undo');
    } },
  );
  taskSelectionRefresh();
}

// ---------- 프로젝트 탭 ----------
// 왼쪽은 프로젝트 목록, 오른쪽은 고른 프로젝트 하나. 상세는 오늘 탭과 같이 누른 줄 옆 카드로 뜬다.

// 목록에 적는 `열린 항목`은 한 규칙이다: 열린 업무(오늘+나중) + 열린 확인 대기.
// 결정·아이디어·회의는 "해야 할 일"이 아니라서 세지 않는다.
const uiProjectOpenItem = item => ['task', 'bug', 'check'].includes(item.type) && item.status !== 'done';

// 많은 순 → 같은 수면 이름 순. 0건 프로젝트는 자연히 맨 아래로 내려가고 목록에서 흐리게 그린다.
function uiProjectRows(entries, items) {
  const open = new Map();
  items.forEach((item) => {
    if (!uiProjectOpenItem(item)) return;
    const key = wfKey(item);
    if (key) open.set(key, (open.get(key) || 0) + 1);
  });
  return entries
    .map(([key, label]) => ({ key, label, open: open.get(key) || 0 }))
    .sort((a, b) => b.open - a.open || a.label.localeCompare(b.label));
}

const PROJECT_KEY_STORE = 'projectKey';
let projectKey = null;
let projectDoneOpen = false;
// 왼쪽 목록의 차례를 탭에 있는 동안 고정해 둔다 — 체크 한 번마다 load()가 다시 그리며 순서가
// 뒤바뀌지 않게. 탭에 들어올 때·새로고침 때만(projectOrderResort) 다시 계산한다. 세션 동안만
// 기억하는 값이라 localStorage에 넣지 않는다(projectShowEmpty도 같다).
let projectOrderKeys = null;
let projectOrderResort = true;
let projectShowEmpty = false;
function projectKeyRestore() {
  try { projectKey = localStorage.getItem(PROJECT_KEY_STORE) || null; } catch { projectKey = null; }
}

// 오늘 목록의 그룹 제목·업무 상세의 `프로젝트 보기`가 부르는 길.
function openProjectTab(key) {
  projectKey = key;
  try { localStorage.setItem(PROJECT_KEY_STORE, key); } catch {}
  // 이 패널은 오늘 탭 자리에 있다 — 프로젝트 탭으로 옮겨 가기 전에 닫는다(팔레트로 되돌아가지 않게).
  if (panelState) { panelState.back = null; panelClose(); }
  tabStale.projects = true;
  setActiveTab('projects');
  document.getElementById('projectList')?.querySelector('[aria-current="true"]')?.focus();
}

// 왼쪽 목록의 차례를 고정해 둘 때 쓰는 순수 함수 — 알고 있던 차례(orderKeys)를 그대로 따르고,
// 처음 보는 키는 지금 정렬 결과(rows)의 상대 순서 그대로 끝에 붙는다. orderKeys가 없으면 그대로 돌려준다.
function projectFixedOrder(rows, orderKeys) {
  if (!orderKeys) return rows;
  const known = new Map(rows.map(row => [row.key, row]));
  const ordered = orderKeys.filter(key => known.has(key)).map(key => known.get(key));
  const extra = rows.filter(row => !orderKeys.includes(row.key));
  return [...ordered, ...extra];
}

// 열린 항목이 없는 프로젝트를 숨기는 순수 함수 — 지금 보고 있는 프로젝트(selectedKey)만 예외로
// 남긴다(보는 동안 0개가 되어도 갑자기 사라지지 않는다). showEmpty면 전부 보여 준다.
function projectVisibleRows(rows, { showEmpty, selectedKey } = {}) {
  const zero = rows.filter(row => !row.open);
  const visible = showEmpty ? rows : rows.filter(row => row.open || row.key === selectedKey);
  const hiddenCount = showEmpty ? 0 : zero.filter(row => row.key !== selectedKey).length;
  return { visible, zero, hiddenCount };
}

// 연결된 지라 이슈가 지라에서는 이미 끝났을 때 조용히 알린다 — 판정은 동기화가 `그 밖의 이슈`
// 구역에 적는 상태 글자 하나(`완료`)로 한다(기본 구역은 미완료만 담으므로 여기에 걸리지 않는다).
// 표시는 프로젝트 탭에만 붙인다.
function uiJiraDone(key) {
  const issue = typeof key === 'string' && key.startsWith('jira:') ? jiraIssuesByKey.get(key.slice('jira:'.length)) : null;
  return !!issue && issue.status === '완료';
}
function uiJiraDoneTag(short) {
  const tag = document.createElement('span');
  tag.className = 'd-jdone';
  tag.textContent = short ? '지라 완료' : '지라에서 완료됨';
  if (short) tag.title = '지라에서 완료됨';
  return tag;
}

function renderProjects() {
  const listEl = document.getElementById('projectList');
  const body = document.getElementById('projectBody');
  if (!listEl || !body) return;
  let rows = uiProjectRows(wfProjects(), workflowData.items);
  // 탭에 들어올 때·새로고침 때만(projectOrderResort) 다시 정렬한다 — 그 밖의 다시 그리기
  // (체크 등으로 load()가 부르는 것)는 고정해 둔 차례를 그대로 쓴다.
  rows = projectOrderResort || !projectOrderKeys ? rows : projectFixedOrder(rows, projectOrderKeys);
  projectOrderResort = false;
  projectOrderKeys = rows.map(row => row.key);
  if (!rows.some(row => row.key === projectKey)) projectKey = rows.length ? rows[0].key : null;

  const { visible: visibleRows, zero: zeroRows, hiddenCount } = projectVisibleRows(rows, { showEmpty: projectShowEmpty, selectedKey: projectKey });
  // 화면에 보이는 이름은 요약만(같은 요약이 둘 이상이면 그때만 키로 구분) — row.label은 정렬용 원본 그대로 둔다.
  const labels = uiGroupLabels(visibleRows.map(row => row.key));

  listEl.replaceChildren();
  const head = document.createElement('div');
  head.className = 'd-rhd';
  const headName = document.createElement('span');
  headName.textContent = '프로젝트';
  const headCount = document.createElement('span');
  headCount.className = 'n num';
  headCount.textContent = visibleRows.length;
  head.append(headName, headCount);
  listEl.appendChild(head);

  visibleRows.forEach((row) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'd-prow' + (row.open ? '' : ' is-zero');
    button.setAttribute('aria-current', String(row.key === projectKey));
    const displayLabel = labels.get(row.key);
    const name = document.createElement('span');
    name.className = 'nm';
    name.textContent = displayLabel;
    // 눈에 보이는 자리는 요약만, title 툴팁에는 지라 키를 남긴다(BKEY 결정).
    name.title = uiGroupLabel(row.key, { withKey: true });
    // 완료 글자가 붙는 줄만 두 칸으로 나눈다 — 긴 이름의 말줄임에 글자가 잘려 사라지지 않게.
    if (uiJiraDone(row.key)) {
      const label = document.createElement('span');
      label.className = 't';
      label.textContent = displayLabel;
      name.className = 'nm has-tag';
      name.replaceChildren(label, uiJiraDoneTag(true));
    }
    const count = document.createElement('span');
    count.className = 'n num';
    count.textContent = row.open;
    // 오늘 목록의 그룹 제목과 같은 색 점 — 같은 프로젝트는 어디서나 같은 색이다.
    button.append(uiProjectDot(row.key), name, count);
    button.addEventListener('click', () => {
      if (projectKey === row.key) return;
      projectKey = row.key;
      try { localStorage.setItem(PROJECT_KEY_STORE, row.key); } catch {}
      renderProjects();
    });
    listEl.appendChild(button);
  });

  // 목록 끝의 조용한 글자 버튼 — 항목 없는 프로젝트가 하나도 없으면 아예 달지 않는다.
  if (zeroRows.length) {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'd-plink';
    toggle.setAttribute('aria-expanded', String(projectShowEmpty));
    toggle.textContent = projectShowEmpty ? '항목 없는 프로젝트 숨기기' : `항목 없는 프로젝트 ${hiddenCount}개 보기`;
    toggle.addEventListener('click', () => { projectShowEmpty = !projectShowEmpty; renderProjects(); });
    listEl.appendChild(toggle);
  }

  renderProjectDetail(body, rows.find(row => row.key === projectKey) || null);
}

// `언제 할지` 열의 한마디: 오늘 / 내일 / 9월 25일 / 나중에.
function projectPlaceWord(item) {
  if (!item.scheduled) return '나중에';
  const diff = diffDays(item.scheduled);
  if (diff === 0) return '오늘';
  if (diff === 1) return '내일';
  return uiKoDateShort(item.scheduled);
}

function projectSection(title, count) {
  const section = document.createElement('section');
  section.className = 'd-psec';
  section.appendChild(uiGroupHeading(title, count));
  return section;
}

// 프로젝트 면의 업무 한 줄: 체크 | 언제 할지 | 업무 | 우선순위 | 기한. hover에 옮기기와 더보기.
function projectTaskRow(item) {
  const mode = item.scheduled ? 'today' : 'later';
  const row = document.createElement('div');
  row.className = 'd-prow2' + (panelState && panelState.id === item.id ? ' is-sel' : '');
  row.dataset.taskId = item.id;

  row.appendChild(uiCheckCell(item, row, false));

  const place = document.createElement('span');
  place.className = 'pl';
  place.textContent = projectPlaceWord(item);
  row.appendChild(place);

  const title = document.createElement('button');
  title.type = 'button';
  title.className = 'ti';
  title.textContent = item.description;
  title.title = item.description;
  title.setAttribute('aria-label', `${item.description} 상세 보기`);
  title.addEventListener('click', () => panelOpen({ id: item.id }));
  row.appendChild(title);

  // 우선순위 열은 없앴다 — 왼쪽 체크박스 안의 꺾쇠가 같은 말을 한다(한 줄에서 두 번 말하지 않는다).
  // 정렬은 그대로 `마감·중요도순`(compareTasks)이다.
  const due = uiDueText(item.due, 'full');
  const deadline = document.createElement('span');
  deadline.className = 'dd' + (due ? uiTone(due.tone) : '');
  if (due) { deadline.innerHTML = uiIcon('calendar') + escapeHtml(due.text); deadline.title = `기한은 ${uiKoDate(item.due)}이에요`; }
  row.appendChild(deadline);

  const acts = document.createElement('span');
  acts.className = 'ac';
  const move = document.createElement('button');
  move.type = 'button';
  move.className = 'd-btn sm';
  move.textContent = mode === 'later' ? '오늘로' : '나중에';
  move.setAttribute('aria-label', `${item.description} — ${move.textContent}`);
  move.addEventListener('click', async () => {
    move.disabled = true;
    await fadeOutAndRun(row, () => setTaskScheduled(item.id, mode === 'later' ? todayStr() : null),
      mode === 'later' ? '오늘 할 일로 옮겼어요' : '나중에 할 일로 옮겼어요 · 기한은 그대로예요');
    move.disabled = false;
  });
  acts.append(move, uiMoreButton(`${item.description} — 더 보기`, () => taskMenuSections({ item, mode, card: row })));
  row.appendChild(acts);
  return row;
}

// 완료한 업무 한 줄: 체크(되돌리기) | 제목 | 결과 한 줄 | `9월 21일 완료`.
function projectDoneRow(item) {
  const row = document.createElement('div');
  row.className = 'd-prow2 is-done' + (panelState && panelState.id === item.id ? ' is-sel' : '');
  row.dataset.taskId = item.id;

  row.appendChild(uiCheckCell(item, row, true));

  const title = document.createElement('button');
  title.type = 'button';
  title.className = 'ti';
  title.textContent = item.description;
  title.title = item.description;
  title.setAttribute('aria-label', `${item.description} 상세 보기`);
  title.addEventListener('click', () => panelOpen({ id: item.id }));
  row.appendChild(title);

  const result = document.createElement('span');
  result.className = 'res';
  uiResultCell(result, item);
  row.appendChild(result);

  const when = document.createElement('span');
  when.className = 'dd';
  when.textContent = item.completed ? `${uiKoDateShort(item.completed)} 완료` : '';
  row.appendChild(when);

  // 진행할 업무 줄과 같은 ⋯ 규칙(손이 닿으면 나타난다) — 완료 취소는 체크로 이미 할 수 있다.
  const acts = document.createElement('span');
  acts.className = 'ac';
  const mode = item.scheduled ? 'today' : 'later';
  acts.appendChild(uiMoreButton(`${item.description} — 더 보기`, () => taskMenuSections({ item, mode, card: row })));
  row.appendChild(acts);
  return row;
}

// 확인 대기·결정·아이디어·회의처럼 값이 한두 개뿐인 구역은 같은 한 줄 모양을 쓴다.
// menuSections가 있으면(할 수 있는 일이 더보기뿐이라) 늘 보이는 ⋯을 단다 — 목록에서 쓰는 메뉴 그대로.
// makeCheck가 있으면(확인 대기·결정 줄만) 맨 앞에 그 종류의 체크박스를 단다 — 아이디어·회의 줄은 그대로 비운다.
// source가 있으면(아이디어 줄만) 제목 뒤에 조용한 `원문` 링크를 붙인다(다른 줄과 같은 uiSourceLink).
function projectSimpleRow(text, meta, onOpen, id, menuSections, makeCheck, source) {
  const row = document.createElement('div');
  row.className = 'd-rec' + (makeCheck ? ' has-ck' : '') + (menuSections ? ' has-ac' : '') + (id && panelState && panelState.id === id ? ' is-sel' : '');
  if (id) row.dataset.taskId = id;
  if (makeCheck) {
    // 확인 대기(.d-wcb, 20px)·결정(.d-check, 30px) 둘 다 이 칸 가운데 놓인다.
    const checkCell = document.createElement('span');
    checkCell.className = 'ckc';
    checkCell.appendChild(makeCheck(row));
    row.appendChild(checkCell);
  }
  const title = document.createElement('button');
  title.type = 'button';
  title.className = 'ti';
  title.textContent = text;
  title.title = text;
  title.setAttribute('aria-label', `${text} 상세 보기`);
  title.addEventListener('click', onOpen);
  if (source) {
    const wrap = document.createElement('span');
    wrap.className = 'd-titlewrap';
    wrap.append(title, source);
    row.appendChild(wrap);
  } else {
    row.appendChild(title);
  }
  const note = document.createElement('span');
  note.className = 'mt';
  note.textContent = meta || '';
  row.append(note);
  if (menuSections) {
    const acts = document.createElement('span');
    acts.className = 'ac';
    acts.appendChild(uiMoreButton(`${text} — 더 보기`, () => menuSections(row)));
    row.appendChild(acts);
  }
  return row;
}

function renderProjectDetail(body, row) {
  body.replaceChildren();
  if (!row) {
    body.insertAdjacentHTML('beforeend', '<div class="d-empty">아직 프로젝트가 없어요. 업무에 프로젝트를 지정하면 여기 모여요.</div>');
    return;
  }
  const items = workflowData.items.filter(item => wfKey(item) === row.key);
  const title = document.createElement('h2');
  title.className = 'd-ptitle';
  // 큰 제목은 요약만(BKEY 결정) — 한 프로젝트만 보여 주는 자리라 같은 요약과 헷갈릴 일이 없다.
  title.textContent = uiGroupLabel(row.key);
  if (uiJiraDone(row.key)) title.appendChild(uiJiraDoneTag());
  const summary = document.createElement('div');
  summary.className = 'd-quiet';
  // 그 아래 조용한 줄에만 지라 키를 덧붙인다(`열린 항목 2 · IO-48394`).
  const jiraKey = row.key.startsWith('jira:') ? row.key.slice('jira:'.length) : '';
  summary.textContent = `열린 항목 ${row.open}` + (jiraKey ? ` · ${jiraKey}` : '');
  body.append(title, summary);

  const tasks = items.filter(item => ['task', 'bug'].includes(item.type));
  const open = tasks.filter(item => item.status !== 'done').sort(compareTasks);
  const done = tasks.filter(item => item.status === 'done').sort((a, b) => (b.completed || '').localeCompare(a.completed || ''));

  if (open.length) {
    const section = projectSection('진행할 업무', open.length);
    const surface = document.createElement('div');
    surface.className = 'd-psurf';
    // 조용한 열 이름 줄 — 무슨 값이 어느 칸에 있는지 한 번만 적는다.
    surface.insertAdjacentHTML('beforeend',
      '<div class="d-colhd"><span></span><span>언제 할지</span><span>업무</span><span class="r">기한</span></div>');
    open.forEach(item => surface.appendChild(projectTaskRow(item)));
    section.appendChild(surface);
    body.appendChild(section);
  }

  // menu가 있으면 줄마다 같은 목록이 쓰는 ⋯ 메뉴를 그대로 단다(회의용·프로젝트탭용으로 새로 만들지 않는다).
  // check가 있으면(확인 대기·결정만) 목록이 쓰는 체크박스를 그대로 맨 앞에 단다.
  // withSource가 있으면(아이디어만) 원문이 있는 줄에 조용한 `원문` 링크를 붙인다.
  // lead가 있으면(확인 대기만) 구역 맨 위에 그 줄을 먼저 세운다 — 방금 체크한 줄의 `다음은?`이다.
  const simple = (label, list, meta, onOpen, menu, check, withSource, lead) => {
    if (!list.length && !lead) return;
    const section = projectSection(label, list.length);
    const surface = document.createElement('div');
    surface.className = 'd-psurf plain';
    if (lead) surface.appendChild(lead);
    list.forEach(entry => surface.appendChild(projectSimpleRow(entry.text, meta(entry.item), () => onOpen(entry.item), entry.id,
      menu ? (row) => menu(entry.item, row) : null,
      check ? (row) => check(entry.item, row) : null,
      withSource ? uiSourceLink(entry.item) : null)));
    section.appendChild(surface);
    body.appendChild(section);
  };
  const asItems = list => list.map(item => ({ item, text: item.description, id: item.id }));
  const openPanel = item => panelOpen({ id: item.id });

  // 방금 체크한 확인 대기는 아래 필터에서 빠지므로 구역 맨 위에 한 번 더 그려 `다음은?`을 잇는다.
  const checkedNow = waitingNextItem();
  const waitingLead = checkedNow && wfKey(checkedNow) === row.key
    ? waitingNextLead(checkedNow, (entry) => {
        const done = projectSimpleRow(entry.description, [entry.who, '확인 완료'].filter(Boolean).join(' · '),
          () => panelOpen({ id: entry.id }), entry.id, null, (host) => waitingCheckbox(entry, host, true));
        done.classList.add('is-done');
        return done;
      })
    : null;
  simple('확인 대기', asItems(items.filter(item => item.type === 'check' && item.status !== 'done')),
    // 누구에게 + 급한 날짜 말(`1일 늦음`·`오늘 답변 예정`)을 함께 — 담당이 적혀 있다고 늦은 것이 가려지면 안 된다.
    item => [item.who, uiItemDueText(item)?.text].filter(Boolean).join(' · '), openPanel, waitingMenuSections,
    // 이 구역은 미완료만 보여 준다(위 필터) — 체크하면 확인 완료가 되어 목록에서 빠진다.
    (item, row) => waitingCheckbox(item, row, false), false, waitingLead);
  // 결정은 미반영·반영을 글자로만 가른다(알약으로 그리지 않는다). 이 구역은 반영 완료도 함께 보여 준다 —
  // 체크해도 줄은 남고 오른쪽 글자만 `미반영` → 반영 날짜로 바뀐다(구역의 기존 규칙 그대로).
  simple('결정', asItems(items.filter(item => item.type === 'decision')),
    item => item.status === 'done' ? `${uiKoDateShort(item.completed)} 반영` : '미반영', openPanel, decisionMenuSections,
    (item, row) => decisionCheckbox(item, row, item.status === 'done'));
  simple('아이디어', asItems(items.filter(item => item.type === 'idea')),
    item => item.created ? `${uiKoDateShort(item.created)} 기록` : '', openPanel, ideaMenuSections, null, true);

  const meetings = workflowData.meetings.filter(event => wfMeetingKey(event) === row.key || items.some(item => item.meetingId === event.id));
  simple('회의', meetings.map(event => ({ item: event, text: event.title, id: null })),
    event => event.date ? uiKoDateShort(event.date) : '', event => panelOpen({ kind: 'meeting', id: event.id }),
    meetingMenuSections);

  if (done.length) {
    const section = document.createElement('section');
    section.className = 'd-psec';
    section.appendChild(uiGroupHeading('완료한 업무', done.length, {
      open: projectDoneOpen,
      onToggle: () => { projectDoneOpen = !projectDoneOpen; renderProjects(); },
    }));
    if (projectDoneOpen) {
      const surface = document.createElement('div');
      surface.className = 'd-psurf';
      done.forEach(item => surface.appendChild(projectDoneRow(item)));
      section.appendChild(surface);
    }
    body.appendChild(section);
  }
}

// ---------- 화면 상태 ----------

let jiraIssuesCache = [];
// 결정 카드마다 지라 목록을 처음부터 훑지 않도록, 목록을 받을 때 키로 한 번만 색인해 둔다.
let jiraIssuesByKey = new Map();
let customGroupsCache = [];
let appVersion = null;

// 화면을 다시 그리면 쓰던 입력이 날아가므로, 자동 갱신은 입력 중이면 건너뛴다
function isTyping() {
  const el = document.activeElement;
  return !!(el && (el.matches('input, textarea, select') || el.isContentEditable));
}
let todaySort = 'project';
// 완료 그룹과 미루기 제안은 접힌 채로 시작한다 — 첫 화면에 오늘 할 일이 가장 많이 보이게.
let todayDoneOpen = false;
let suggestOpen = false;
let noticeTimer;
let lastRemovedId = null;

function showNotice(message, error = false, retry = null, action = null) {
  const region = document.getElementById('liveRegion');
  clearTimeout(noticeTimer);
  region.hidden = false;
  region.classList.toggle('error', error);
  region.textContent = message;
  if (!error && !undoReplaying && Date.now() - lastUndoRecordedAt < 3000) {
    const hint = document.createElement('span');
    hint.className = 'd-tnote';
    hint.textContent = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform) ? '⌘Z로 되돌리기' : 'Ctrl+Z로 되돌리기';
    region.appendChild(hint);
  }
  if (lastRemovedId && !error) {
    const undo = document.createElement('button');
    undo.type = 'button';
    undo.className = 'd-btn sm';
    undo.textContent = '삭제 실행 취소';
    undo.addEventListener('click', async () => {
      const id = lastRemovedId;
      undo.disabled = true;
      try {
        await request('/api/track/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
        lastRemovedId = null;
        await load();
        announce('삭제한 항목을 되살렸어요');
      } catch { undo.disabled = false; }
    });
    region.appendChild(undo);
  }
  if (retry) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'd-btn sm';
    button.textContent = '다시 시도';
    button.addEventListener('click', retry);
    region.appendChild(button);
  }
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'd-btn sm';
    button.textContent = action.label;
    button.addEventListener('click', () => action.onClick(button));
    region.appendChild(button);
  }
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'd-btn sm';
  dismiss.textContent = '닫기';
  dismiss.addEventListener('click', () => { region.hidden = true; });
  region.appendChild(dismiss);
  if (!error && !lastRemovedId) noticeTimer = setTimeout(() => { region.hidden = true; }, action ? 8000 : 4500);
}

// 저장이 멈춘 동안 계속 떠 있는 안내. 스낵바와 달리 스스로 사라지지 않는다.
const STORAGE_BANNER_TEXT = '복구가 필요해서 저장을 멈췄어요. 지금까지의 기록은 그대로 있어요. README의 "복구 필요 상태"를 따라 정리한 뒤 서버를 다시 시작해 주세요.';
function renderStorageBanner(storage) {
  const banner = document.getElementById('storageBanner');
  // 예전 서버에는 이 정보가 없다. 모르는 상태에서는 화면을 바꾸지 않는다.
  if (!banner || !storage) return;
  banner.textContent = storage.recoveryNeeded ? STORAGE_BANNER_TEXT : '';
  if (storage.recoveryNeeded && storage.reason) {
    const hint = document.createElement('span');
    hint.className = 'd-bnote';
    hint.textContent = `원인: ${storage.reason}`;
    banner.appendChild(hint);
  }
  banner.hidden = !storage.recoveryNeeded;
}
async function refreshStorageStatus() {
  try {
    const response = await fetch('/api/storage-status');
    if (!response.ok) return; // 예전 서버에는 없는 주소다. 조용히 넘어간다.
    renderStorageBanner(await response.json());
  } catch { /* 연결 실패는 목록 쪽 안내로 충분하다 */ }
}

const pendingRequestKeys = new Map();
async function request(url, options) {
  const writing = options?.method === 'POST';
  const retryKey = writing && /\/(create|capture|review)$/.test(url) ? url + options.body : null;
  if(retryKey && typeof crypto !== 'undefined' && crypto.randomUUID) {
    if(!pendingRequestKeys.has(retryKey))pendingRequestKeys.set(retryKey,crypto.randomUUID());
    options={...options,headers:{...options.headers,'Idempotency-Key':pendingRequestKeys.get(retryKey)}};
  }
  // 회의 정리 창의 담기·되돌리기·직접 담기는 창 안의 결과 카드가 결과를 알려 주니, 창에 반쯤 가려지는 저장 알림은 띄우지 않는다(실패는 그대로 알린다).
  const quiet = writing && (options?.quiet || /^\/api\/workflow\/(review|review-undo|capture)$/.test(url));
  if (writing && !quiet) showNotice('저장 중…');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    // 실패 응답에 담긴 서버 메시지를 버리지 않는다 (저장이 멈춘 이유 등).
    // 본문은 한 번만 읽어서 해석하고, 호출한 쪽의 response.json()은 그 결과를 그대로 돌려준다
    // (예전에는 복제본까지 만들어 같은 본문을 두 번 해석했다). 해석에 실패했을 때 호출한 쪽이
    // 받는 오류도 예전과 같게 둔다.
    let data = null, parsed = false, text;
    try { text = await response.text(); data = JSON.parse(text); parsed = true; } catch { data = null; }
    response.json = parsed ? async () => data : async () => JSON.parse(text);
    if (!response.ok || data?.ok === false) {
      const failure = new Error(data?.error || (response.ok ? '저장하지 못했어요' : `요청이 실패했어요 (${response.status})`));
      failure.code = data?.code;
      throw failure;
    }
    if(retryKey)pendingRequestKeys.delete(retryKey);
    if (writing) recordUndoFor(url, JSON.parse(options.body || '{}'));
    if (url === '/api/track/remove' && !undoReplaying) lastRemovedId = JSON.parse(options.body).id;
    if (writing && !quiet) showNotice('저장했어요');
    return response;
  } catch (error) {
    error.reported = true;
    if (error.code === 'RECOVERY_NEEDED') {
      renderStorageBanner({ recoveryNeeded: true });
      showNotice(error.message, true);
    } else showNotice(writing ? '저장됐는지 확인하지 못했어요. 입력한 내용은 그대로 있어요' : '목록을 불러오지 못했어요', true, writing ? null : () => load());
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// Event handlers keep their inputs in place on failure; request() displays the error.
window.addEventListener('unhandledrejection', event => {
  if (event.reason?.reported) event.preventDefault();
});

const undoStack = [];
const redoStack = [];
let undoReplaying = false;
let lastUndoRecordedAt = 0;
let itemsById = new Map();

const postJson = (url, body) => request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function pushUndo(entry) {
  if (undoReplaying) return;
  undoStack.push(entry);
  if (undoStack.length > 30) undoStack.shift();
  redoStack.length = 0;
  lastUndoRecordedAt = Date.now();
}

// Reads itemsById before load() refreshes it, so the "before" state is still available.
function recordUndoFor(url, body) {
  if (url === '/api/track/restore' && body.id === lastRemovedId) lastRemovedId = null;
  if (undoReplaying) return;
  const item = itemsById.get(body.id);
  const label = item ? item.description : '';
  if (url === '/api/track/toggle') {
    const before=item?.status || (body.status==='done'?'to-do':'done');
    const after=body.status || (before==='done'?'to-do':'done');
    pushUndo({ label, undo: () => postJson(url, { id: body.id,status:before }), redo: () => postJson(url, { id: body.id,status:after }) });
  } else if (url === '/api/track/set-scheduled' && item) {
    const before = item.scheduled || null;
    pushUndo({ label, undo: () => postJson(url, { id: body.id, scheduled: before }), redo: () => postJson(url, { id: body.id, scheduled: body.scheduled }) });
  } else if (url === '/api/track/remove') {
    pushUndo({ label, removedId: body.id, undo: () => postJson('/api/track/restore', { id: body.id }), redo: () => postJson(url, { id: body.id }) });
  } else if (url === '/api/track/restore') {
    // Restored from the notice's own undo button — drop the matching entry so ⌘Z doesn't restore twice.
    const index = undoStack.findLastIndex(entry => entry.removedId === body.id);
    if (index >= 0) undoStack.splice(index, 1);
  }
}

async function replayUndo(direction) {
  if (undoReplaying) return;
  const [from, to] = direction === 'undo' ? [undoStack, redoStack] : [redoStack, undoStack];
  const entry = from.pop();
  if (!entry) {
    showNotice(direction === 'undo' ? '되돌릴 작업이 없어요' : '다시 실행할 작업이 없어요');
    return;
  }
  undoReplaying = true;
  try {
    await entry[direction]();
    to.push(entry);
    await load();
    showNotice(`${direction === 'undo' ? '되돌렸어요' : '다시 실행했어요'}${entry.label ? ` · ${entry.label}` : ''}`);
  } catch {
    from.push(entry);
  } finally {
    undoReplaying = false;
  }
}

document.addEventListener('keydown', (event) => {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== 'z') return;
  if (event.target?.closest?.('input, textarea, select, [contenteditable="true"], [contenteditable=""]')) return;
  event.preventDefault();
  replayUndo(event.shiftKey ? 'redo' : 'undo');
});

async function load() {
  let res;
  try { res = await request('/api/items'); } catch { refreshStorageStatus(); return; }
  const data = await res.json();
  renderStorageBanner(data.storage);
  itemsById = new Map(['todayTasks', 'laterTasks', 'waiting', 'decisions', 'decisionArchive', 'ideas']
    .flatMap(key => data[key] || []).map(item => [item.id, item]));
  // 앱 화면이 바뀌었으면 데이터만 다시 받아선 소용없다 (새 UI가 아예 없는 상태).
  // 입력 중이 아닐 때만 스스로 새로고침한다.
  if (data.appVersion) {
    if (!appVersion) appVersion = data.appVersion;
    else if (appVersion !== data.appVersion && !isTyping()) {
      location.reload();
      return;
    }
  }

  // 미팅 노트 가져오기의 상태는 목록과 함께 온다 — 페이지를 새로 열어도 진행 중이면 같은 표시로 이어진다.
  meetingNotesApply(data.meetingNotes);
  jiraIssuesCache = data.jiraIssues || [];
  jiraIssuesByKey = new Map(jiraIssuesCache.map(issue => [issue.key, issue]));
  customGroupsCache = data.customGroups || [];
  workflowRender(data);
  renderDateBar(data);
  renderCalendar(data.calendar);
  renderSuggestions(data.suggestions);
  renderInbox(data.inboxTasks || []);
  renderLaterTasks(data.laterTasks || []);
  renderWaiting(data.waiting || []);
  renderTodayTasks(data.todayTasks || []);
  decisionArchiveCache = data.decisionArchive || [];
  // 아직 PRD에 반영하지 않은 결정 수. 탭 이름 옆 작은 숫자와 결정 구역 제목이 같은 값을 쓴다.
  const pendingDecisions = (data.decisions || []).length;
  document.getElementById('decisionCount').textContent = pendingDecisions;
  latestData = data;
  tabStale.projects = true; tabStale.meetings = true; tabStale.records = true; tabStale.weekly = true;
  renderActiveTabLists();
  const tabNum = document.getElementById('tabRecordsNum');
  if (tabNum) {
    tabNum.textContent = pendingDecisions ? String(pendingDecisions) : '';
    tabNum.title = decisionPendingTitle(pendingDecisions);
  }
  // 회의 탭 이름 옆 숫자 — 검토를 기다리는 초안이 있는 회의 수(아이디어·결정과 같은 부품·같은 때).
  const reviewMeetings = meetingsReviewCount(workflowData.meetings);
  const tabMeetings = document.getElementById('tabMeetingsNum');
  if (tabMeetings) {
    tabMeetings.textContent = reviewMeetings ? String(reviewMeetings) : '';
    tabMeetings.title = reviewMeetings ? `검토할 초안이 있는 회의 ${reviewMeetings}개` : '';
  }
  renderInboxHeadCount(data.createdToday || 0);

  const todayIds = new Set((data.todayTasks || []).map(t => t.id));
  const reminders = [...(data.todayTasks || []), ...(data.laterTasks || [])]
    .filter(t => !todayIds.has(t.id) && t.status !== 'done' && t.due && diffDays(t.due) <= 1 && (t.priority === 'high' || t.priority === 'critical'))
    .sort((a, b) => diffDays(a.due) - diffDays(b.due));
  // 기다리던 답변이 온 업무도 리마인드 카드에 함께 올린다(옛 `답변이 해결된 업무` 묶음 자리).
  const answered = (workflowData?.items || [])
    .filter(item => ['task', 'bug'].includes(item.type) && item.status !== 'done' && item.blockedBy && wfItem(item.blockedBy)?.status === 'done')
    .map(item => itemsById.get(item.id) || item);
  renderReminders(reminders, answered);
  syncTaskDetail();
  palSync();
  taskSelectionRefresh();
}

// 열려 있지도 않은 탭의 카드를 load()마다 다시 만들 필요는 없다 — 숫자·NEW 표시는 그대로
// 갱신하고, 목록은 그 탭이 열려 있거나 열릴 때 만든다(새 자료가 오면 다시 만든다).
let latestData = null;
let activeTabKey = 'today';
const tabStale = { projects: true, meetings: true, records: true, weekly: true };
function renderActiveTabLists() {
  if (!latestData) return;
  if (activeTabKey === 'projects' && tabStale.projects) {
    tabStale.projects = false;
    renderProjects();
  }
  // 회의 탭은 글을 쓰는 면이다 — 초안 문구·직접 담기 칸에 손이 가 있으면 다시 그리지 않는다
  // (적던 글과 초점이 날아가지 않게. 줄 옆 카드의 syncTaskDetail과 같은 장치다).
  if (activeTabKey === 'meetings' && tabStale.meetings) {
    const zone = document.getElementById('meetingBody');
    if (!(zone && isTyping() && zone.contains(document.activeElement))) {
      tabStale.meetings = false;
      renderMeetings();
    }
  }
  if (activeTabKey === 'records' && tabStale.records) {
    tabStale.records = false;
    renderIdeas(latestData.ideas || []);
    renderDecisions(latestData.decisions || []);
    renderDecisionArchive();
  }
  if (activeTabKey === 'weekly' && tabStale.weekly) {
    tabStale.weekly = false;
    renderWeeklyReports(latestData.weeklyReports || []);
  }
}

function renderDateBar(data) {
  if (data.title) {
    document.getElementById('workspaceTitle').textContent = data.title;
    document.title = data.title;
  }
  const bar = document.getElementById('dateBar');
  bar.replaceChildren();
  const date = document.createElement('span');
  date.className = 'd-date';
  date.textContent = uiKoDate(data.today);
  bar.appendChild(date);

  // 자동 갱신이 실패해도 화면엔 낡은 자료가 그대로 보이므로, 낡았을 때만 알린다
  // used === false 는 "이 회사에선 안 쓰는 도구" — 경고할 일이 아니다
  const stale = [];
  const slack = data.slackSync || {};
  if (slack.used !== false && slack.stale) stale.push({ key: 'slack', name: '슬랙 캡처', lastSync: slack.lastSync });
  const cal = data.calendar || {};
  if (cal.used !== false && (cal.stale || !cal.lastSync)) stale.push({ key: 'calendar', name: '캘린더', lastSync: cal.lastSync });
  const jira = data.jiraSync || {};
  if (jira.used !== false && jira.stale) stale.push({ key: 'jira', name: '지라', lastSync: jira.lastSync });

  stale.forEach(source => {
    // 누르면 설정의 `상태`가 열리고 그 자동화 줄이 밝혀진다 — "무슨 일인지"까지 한 번에.
    const warn = document.createElement('button');
    warn.type = 'button';
    warn.className = 'd-warn';
    const dot = document.createElement('i');
    dot.className = 'd-dot';
    dot.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    const days = source.lastSync ? -diffDays(source.lastSync) : null;
    const age = days === null ? '동기화 안 됨' : days === 1 ? '어제 기준' : `${days}일 전 기준`;
    label.textContent = `${source.name} ${age}`;
    warn.append(dot, label);
    warn.title = source.lastSync
      ? `${source.name} 자동 갱신이 ${source.lastSync} 이후 멈춰 있어요. 목록이 최신이 아닐 수 있어요. 누르면 자세한 상태를 볼 수 있어요.`
      : `${source.name}를 아직 한 번도 가져오지 못했어요. 누르면 자세한 상태를 볼 수 있어요.`;
    warn.setAttribute('aria-label', `${source.name} ${age} — 자동화 상태 보기`);
    warn.addEventListener('click', () => settingsOpen('status', source.key));
    bar.appendChild(warn);
  });
}

// 지금 진행 중인 회의만 시각을 진하게 적는다(HH:MM 비교).
function nowHHMM() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

// 레일의 오늘 미팅. 한 줄 = 시각 | 제목(프로젝트는 같은 줄 뒤 조용한 글자) | 조용한 개수 + hover 더보기.
function renderCalendar(calendar) {
  const events = ((calendar && calendar.events) || []).map(event => {
    const saved = workflowData.meetings.find(meeting => meeting.date === todayStr() && meeting.start === event.start && meeting.title === event.title);
    return saved ? { ...event, project: saved.project, workflowId: saved.id, draftCount: saved.drafts?.length || 0 } : event;
  });
  document.getElementById('calendarSectionCount').textContent = events.length;
  const list = document.getElementById('calendarList');
  list.replaceChildren();
  if (!events.length) {
    const empty = document.createElement('div');
    empty.className = 'd-rempty';
    empty.textContent = calendar?.stale || !calendar?.lastSync ? '오늘 일정을 가져오지 못했어요.' : '오늘은 미팅이 없어요.';
    list.appendChild(empty);
    return;
  }
  const now = nowHHMM();
  events.forEach(event => {
    // 진행 중인 회의는 배지 없이 색으로 알린다(파란 글자 + 연파랑 줄). 끝난 회의는 흐리게.
    const running = event.start <= now && now < (event.end || '99:99');
    const past = !running && (event.end || event.start) <= now;
    const row = document.createElement('div');
    row.className = 'd-mrow' + (running ? ' is-now' : past ? ' is-past' : '');
    // 회의 정리 패널이 열리면 이 표식으로 찾아 `지금 보는 회의`를 표시한다.
    row.dataset.meetingId = event.workflowId || `${event.start || ''} ${event.title || ''}`;
    // 1분마다 도는 시계가 이 값으로 `지금 하는 회의`를 다시 칠한다.
    row.dataset.start = event.start || '';
    row.dataset.end = event.end || '99:99';

    const time = document.createElement('span');
    time.className = 't num';
    time.textContent = event.start;
    row.appendChild(time);

    // 제목과 프로젝트는 한 줄에 둔다 — 제목 아래 또 한 줄을 깔면 레일이 금세 길어진다.
    const title = document.createElement('button');
    title.type = 'button';
    title.className = 'ti';
    title.textContent = event.title;
    // 프로젝트 이름은 어디서나 같은 꼴로 적는다(파일에 저장된 `가입_개선`을 `가입 개선`으로).
    // 줄 안의 짧은 표기라 지라는 요약만(모르면 키) — 전체 `KEY · 요약`은 title 툴팁에 남긴다.
    const projectName = wfMeetingProjectName(event);
    const projectFull = wfMeetingProjectName(event, { withKey: true });
    title.title = projectName ? `${event.title} · ${projectFull}` : event.title;
    title.setAttribute('aria-label', `${event.title} — 회의 정리`);
    if (projectName) {
      const project = document.createElement('span');
      project.className = 'pj';
      project.textContent = projectName;
      title.appendChild(project);
    }
    title.addEventListener('click', () => openMeetingPanel(event));
    row.appendChild(title);

    // 0은 찍지 않는다 — 검토할 초안이 있을 때만 배지 하나.
    const count = document.createElement('span');
    count.className = 'ct num';
    count.textContent = event.draftCount ? `초안 ${event.draftCount}` : '';
    if (event.draftCount) count.title = `AI가 뽑은 초안 ${event.draftCount}개를 아직 검토하지 않았어요`;
    row.appendChild(count);

    const acts = document.createElement('span');
    acts.className = 'ac';
    acts.appendChild(uiMoreButton(`${event.title} — 더 보기`, () => meetingMenuSections(event, { fetchAll: true })));
    row.appendChild(acts);

    list.appendChild(row);
  });
  calendarClockStart();
}

// 회의 줄의 ⋯가 여는 메뉴 — 레일의 오늘 미팅 줄과 회의 정리 카드 머리가 함께 쓴다(메뉴를 새로 만들지 않는다).
// 프로젝트를 바꾼 뒤에는 load()가 레일 줄과 열려 있는 카드 머리를 함께 다시 그린다.
// 이미 열려 있는 자리에서는 그 자리로 가는 항목을 뺀다: 회의 카드는 `회의 정리 열기`를(open: false),
// 회의 탭은 거기에 더해 `회의 탭에서 열기`를(toTab: false) 빼고 연다.
// `fetchAll`은 오늘 탭 레일의 오늘 미팅 줄에서만 켠다 — `오늘 것 모두 가져오기`를 레일에서도 누를 수 있게
// (회의 탭 머리의 버튼과 같은 함수를 쓴다).
function meetingMenuSections(event, { open = true, toTab = true, fetchAll = false } = {}) {
  // 레일의 캘린더 줄에는 번호가 `workflowId`로 온다 — 흐름 기록에 있는 회의만 탭에서 고를 수 있다.
  const tabId = event.id || event.workflowId || null;
  const setProject = async (projectKey) => {
    await request('/api/meeting/set-project', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: event.title, project: projectKey }),
    });
    await load();
  };
  const actions = [];
  if (open) actions.push({ label: '회의 정리 열기', onClick: () => openMeetingPanel(event) });
  if (toTab && tabId) actions.push({ label: '회의 탭에서 열기', onClick: () => openMeetingsTab(tabId) });
  if (fetchAll && meetingNotesState.used !== false) {
    actions.push({
      label: '오늘 것 모두 가져오기',
      disabled: meetingNotesBusy(),
      onClick: () => meetingNotesStart('today'),
    });
  }
  return [
    ...(actions.length ? [actions] : []),
    [{
      field: '프로젝트 연결',
      control: renderGroupControl({
        jira: event.project && event.project.type === 'jira' ? event.project.value : null,
        group: event.project && event.project.type === 'group' ? event.project.value : null,
        onSetJira: (key) => setProject(key ? `jira:${key}` : null),
        onSetGroup: (value) => setProject(value ? `group:${value}` : null),
      }),
    }],
  ];
}

// 진행 중인 회의 표시는 시간이 지나면 저절로 바뀌어야 한다. 1분마다 줄의 색만 다시 칠한다
// (목록을 새로 만들지 않으므로 입력 중에도 방해가 없다).
let calendarClockTimer = null;
function calendarClockTick() {
  const now = nowHHMM();
  document.querySelectorAll('#calendarList .d-mrow').forEach((row) => {
    const start = row.dataset.start || '';
    const end = row.dataset.end || '99:99';
    const running = start <= now && now < end;
    row.classList.toggle('is-now', running);
    row.classList.toggle('is-past', !running && end <= now);
  });
}
function calendarClockStart() {
  if (calendarClockTimer) return;
  calendarClockTimer = setInterval(calendarClockTick, 60000);
}


function suggestDismissedToday() {
  try { return localStorage.getItem('suggestDismissed') === todayStr(); } catch { return false; }
}

// 미루기 제안은 머리줄의 진행 문장 뒤에 글자 링크로 붙는다(`… 5개 끝냈어요 · 2개 미룰까요?`).
// 누르면 머리줄 아래로 업무 줄이 펼쳐진다. 제안이 없으면 앞 문장만 남는다.
// 근거는 알약으로 그리지 않는다(마감 없음·우선순위 낮음 같은 말은 새로 알려 주는 게 없다).
function renderSuggestions(suggestions) {
  const slot = document.getElementById('suggestSlot');
  if (slot) slot.replaceChildren();
  const zone = document.getElementById('suggestZone');
  const data = { ...(suggestions || { mode: 'none', items: [] }) };
  if (data.mode === 'pull') data.items = data.items.filter(item => {
    const blocked = wfItem(wfItem(item.id)?.blockedBy);
    return !blocked || blocked.status === 'done';
  });
  // 이미 손댄 업무(진행 중)나 끝낸 업무는 미루자고 하지 않는다.
  data.items = (data.items || []).filter((entry) => {
    const task = itemsById.get(entry.id);
    return !task || (task.status !== 'done' && !task.doing);
  });
  zone.replaceChildren();
  if (!data.items.length || suggestDismissedToday()) {
    zone.hidden = true;
    return;
  }
  const defer = data.mode === 'defer';
  zone.hidden = false;

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'd-sug';
  toggle.setAttribute('aria-expanded', String(suggestOpen));
  toggle.setAttribute('aria-controls', 'suggestZone');
  toggle.innerHTML = uiIcon('chevron');
  const label = document.createElement('span');
  label.textContent = defer ? `${data.items.length}개 미룰까요?` : '오늘 이건 어때요?';
  toggle.appendChild(label);
  toggle.addEventListener('click', () => { suggestOpen = !suggestOpen; renderSuggestions(suggestions); });
  // 링크는 머리줄의 진행 문장 뒤에, 펼친 줄은 머리줄 아래에 둔다.
  if (slot) { slot.append('· ', toggle); } else { zone.appendChild(toggle); }
  if (!suggestOpen) { zone.hidden = true; return; }

  const box = document.createElement('div');
  box.className = 'd-sugbox';
  data.items.forEach((entry) => {
    const task = itemsById.get(entry.id) || { id: entry.id, description: entry.description };
    const row = document.createElement('div');
    row.className = 'd-row is-sug';
    row.innerHTML = '<span class="d-check"></span>'
      + `<span class="d-title" title="${escapeAttr(task.description)}">${escapeHtml(task.description)}</span>`
      + '<span class="d-proj"></span>'
      + `<span class="d-meta">${uiMetaCells(task)}</span>`;
    const acts = document.createElement('span');
    acts.className = 'd-acts';
    const move = (text, scheduled, message) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'd-btn sm';
      button.textContent = text;
      button.setAttribute('aria-label', `${task.description} — ${text}`);
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          await setTaskScheduled(entry.id, scheduled);
          announce(message);
        } catch { button.disabled = false; }
      });
      acts.appendChild(button);
    };
    if (defer) { move('내일', tomorrowStr(), '내일로 미뤘어요'); move('나중에', null, '나중에 할 일로 옮겼어요'); }
    else move('오늘로', todayStr(), '오늘 할 일로 옮겼어요');
    row.appendChild(acts);
    box.appendChild(row);
  });

  const foot = document.createElement('div');
  foot.className = 'd-sugfoot';
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'd-link';
  dismiss.textContent = '오늘은 괜찮아요';
  dismiss.addEventListener('click', () => {
    try { localStorage.setItem('suggestDismissed', todayStr()); } catch {}
    zone.hidden = true;
    zone.replaceChildren();
    announce('오늘은 제안을 접어 둘게요');
  });
  foot.appendChild(dismiss);
  box.appendChild(foot);
  zone.appendChild(box);
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function tomorrowStr() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function diffDays(dueStr) {
  const due = new Date(dueStr + 'T00:00:00');
  const today = new Date(todayStr() + 'T00:00:00');
  return Math.round((due - today) / 86400000);
}

// 레일의 리마인드 — 기한이 코앞인 높은 우선순위 업무와, 기다리던 답변이 온 업무가 함께 온다
// (고르는 곳은 load()). 제목은 2줄까지 허용하고, 오른쪽에 기한·`답변 왔어요`를 적는다.
function renderReminders(reminders, answered = []) {
  const zone = document.getElementById('reminderZone');
  const list = document.getElementById('reminderList');

  document.getElementById('reminderSectionCount').textContent = reminders.length + answered.length;
  zone.hidden = reminders.length + answered.length === 0;

  list.replaceChildren();
  const row = (item, meta) => uiRailRow({
    id: item.id,
    text: item.description,
    wrap: true,
    selected: !!panelState && panelState.id === item.id,
    source: uiSourceLink(item),
    meta,
    onOpen: () => panelOpen({ id: item.id }),
  });
  // 기다리던 답변이 온 업무가 먼저다 — 지금 바로 이어서 할 수 있는 일이다.
  answered.forEach(item => list.appendChild(row(item, [{ text: '답변 왔어요', tone: 'success' }])));
  reminders.forEach(item => list.appendChild(row(item, [uiDueText(item.due)])));
}

// weekKey(월요일, 'YYYY-MM-DD')를 "9월 3주차" + "9/14 ~ 9/20" 두 줄로 보여줄 조각으로 쪼갠다.
// 몇째 주인지는 그 달 안에서 월요일이 몇 번째로 나오는지로 센다(흔히 쓰는 방식).
function formatWeekLabel(weekKey) {
  const monday = new Date(`${weekKey}T00:00:00`);
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);
  const weekOfMonth = Math.ceil(monday.getDate() / 7);
  const fmt = (d) => `${d.getMonth() + 1}/${d.getDate()}`;
  return {
    week: `${monday.getMonth() + 1}월 ${weekOfMonth}주차`,
    range: `${monday.getFullYear()}년 ${fmt(monday)} ~ ${fmt(sunday)}`,
  };
}

// 주차 이름은 가까운 주만 말로 부른다: `이번 주` / `지난 주` / 그 밖에는 `9월 4주차`.
function reportWeekName(weekKey) {
  const monday = new Date(`${todayStr()}T12:00:00`);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const weeks = Math.round((new Date(`${weekKey}T12:00:00`) - monday) / (7 * 86400000));
  if (weeks === 0) return '이번 주';
  if (weeks === -1) return '지난 주';
  return formatWeekLabel(weekKey).week;
}

let selectedWeekKey = null;
let weeklyReportsCache = [];

// 주간요약 탭의 왼쪽 주차 목록. 문서와 슬랙 미리보기는 report-ui.js가 그린다.
function renderWeeklyReports(items) {
  weeklyReportsCache = items;
  document.getElementById('weeklyReportCount').textContent = items.length;
  const nav = document.getElementById('weeklyReportNav');
  const detail = document.getElementById('weeklyReportDetail');

  if (!items.length) {
    nav.replaceChildren();
    selectedWeekKey = null;
    renderWeeklyReportDetail(null);
    return;
  }

  if (!selectedWeekKey || !items.some(i => i.weekKey === selectedWeekKey)) {
    selectedWeekKey = items[0].weekKey;
  }

  nav.replaceChildren();
  items.forEach(item => {
    const label = formatWeekLabel(item.weekKey);
    const name = reportWeekName(item.weekKey);
    // 좁은 줄이라 연도는 떼고 `9/21 ~ 9/27`만 남긴다(문서 머리줄에는 연도까지 있다).
    const range = label.range.replace(/^\d{4}년\s*/, '');
    const fresh = typeof reportNewCount === 'function' ? reportNewCount(item) : 0;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rp-wk';
    if (item.weekKey === selectedWeekKey) btn.setAttribute('aria-current', 'true');
    const title = document.createElement('span');
    title.className = 'nm';
    title.textContent = name;
    const sub = document.createElement('span');
    sub.className = 'rg num';
    sub.textContent = range;
    btn.append(title, sub);
    if (fresh) {
      const mark = document.createElement('span');
      mark.className = 'nw num';
      mark.textContent = `새 기록 ${fresh}`;
      btn.appendChild(mark);
    }
    btn.setAttribute('aria-label', `${name}, ${label.range}${fresh ? `, 새 기록 ${fresh}개` : ''}`);
    btn.addEventListener('click', () => {
      selectedWeekKey = item.weekKey;
      renderWeeklyReports(weeklyReportsCache);
    });
    nav.appendChild(btn);
  });

  // 문장을 고치거나 다음 주 계획을 적는 중이면 다시 그리지 않는다(입력이 날아가지 않게).
  if (detail.contains(document.activeElement) && detail.dataset.weekKey === selectedWeekKey) return;

  renderWeeklyReportDetail(items.find(i => i.weekKey === selectedWeekKey));
}

function renderWeeklyReportDetail(item) {
  // 보고 초안은 서버가 항상 붙여준다 — 없거나 보고 화면 스크립트가 없으면 문서와 미리보기를 비운다.
  if (!item || !item.draft || typeof renderReportDraft !== 'function') {
    const detail = document.getElementById('weeklyReportDetail');
    detail.replaceChildren();
    const empty = document.createElement('div');
    empty.className = 'd-empty';
    empty.textContent = '아직 주간요약이 없어요.';
    detail.appendChild(empty);
    document.getElementById('weeklyReportPreview')?.replaceChildren();
    return;
  }
  renderReportDraft(item);
}

// ---------- 아이디어·결정 탭 ----------
// 두 열(아이디어 | 결정)을 프로젝트로 묶어 한 줄씩 적는다. 두 종류 다 날짜 칸이 없다
// (DECISIONS: 마감일은 할 일에만). 결정만 `PRD 반영함` 체크가 있고, 아이디어는 더보기만 있다.

let decisionCache = [];
let decisionArchiveCache = [];
let decisionQuery = '';
let decisionArchiveOpen = false;

// 탭 이름 옆 숫자와 결정 구역 제목 칩이 같은 문구를 쓴다 — 한 곳에서만 고치면 된다.
function decisionPendingTitle(n) {
  return n ? `PRD에 아직 반영하지 않은 결정이 ${n}개 있어요` : '';
}

// 아이디어의 `가능성`은 높음만 글자로 적는다 — 보통·낮음·없음은 목록에 찍지 않는다.
function ideaChanceText(item) {
  return item && item.priority === 'high' ? '가능성 높음' : '';
}

// 반영 완료 검색: 문구·프로젝트·지라 키·지라 요약 가운데 하나라도 걸리면 남긴다.
function recordArchiveMatch(item, query, jiraSummary) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return true;
  return [item.description, item.group, item.project, item.jira, jiraSummary]
    .some(value => value && String(value).toLowerCase().includes(needle));
}

function decisionJiraSummary(item) {
  return item.jira ? (jiraIssuesByKey.get(item.jira) || {}).summary || '' : '';
}

// 결정·아이디어 열 하나를 그린다: 프로젝트 그룹 제목(오늘 목록과 같은 부품 — 색 점 + 이름 + 회색 숫자,
// 누르면 프로젝트 탭) + 그 아래 줄들. 그룹 제목이 이미 프로젝트를 말해 주므로 줄에는 되풀이하지 않는다.
// `프로젝트 없음` 묶음만 색 점 없이 맨 아래에 선다(uiGroupTasks가 순서를 맡는다).
function renderRecordColumn(list, items, row, emptyText) {
  list.replaceChildren();
  if (!items.length) {
    list.insertAdjacentHTML('beforeend', `<div class="d-empty">${emptyText}</div>`);
    return;
  }
  const groups = uiGroupTasks(items);
  const labels = uiGroupLabels(groups.map(([key]) => key));
  groups.forEach(([key, group]) => {
    list.appendChild(uiGroupHeading(labels.get(key), group.length,
      key === '__misc__' ? {} : { projectName: key, onOpenProject: () => openProjectTab(key) }));
    group.forEach(item => list.appendChild(row(item)));
  });
}

// 반영 완료 줄에는 위에 프로젝트 그룹 제목이 없다 — 그 줄만 제목 뒤에 프로젝트를 적는다(지라면 요약, 모르면 키).
function recordProjectName(item) {
  return uiProjectName(item);
}

// 결정·아이디어 줄의 제목 자리: 제목 | (반영 완료면) `· ● 프로젝트` | (showSource면) 조용한 `원문` 링크.
// 결정 줄은 원문을 아래 정보 줄로 옮겨 한 곳에만 적는다 — showSource를 꺼서 부른다.
function recordTitleCell(row, title, item, projectName, showSource = true) {
  const source = showSource ? uiSourceLink(item) : null;
  if (!projectName && !source) { row.appendChild(title); return; }
  const wrap = document.createElement('span');
  wrap.className = 'd-titlewrap';
  wrap.appendChild(title);
  if (projectName) wrap.appendChild(uiInlineProject(item));
  if (source) wrap.appendChild(source);
  row.appendChild(wrap);
}

// 결정 아래 정보 줄에 넣을 부분들 — 날짜(created)·나온 회의(meetingId → 회의 제목)·원문 가운데
// 실제로 있는 값만, 이 순서로. DOM 없이도 조립 규칙을 확인할 수 있게 데이터만 뽑아 둔다.
function recordInfoParts(item) {
  const parts = [];
  if (item.created) parts.push({ kind: 'date', text: `${uiKoDateShort(item.created)} 결정` });
  const meetingId = (typeof wfItemsById !== 'undefined' ? wfItemsById.get(item.id) : null)?.meetingId;
  const meeting = meetingId && typeof workflowData !== 'undefined'
    ? workflowData.meetings.find(event => event.id === meetingId) : null;
  if (meeting) parts.push({ kind: 'meeting', text: `${meeting.title}에서`, meetingId: meeting.id });
  if (item.permalink) parts.push({ kind: 'source', text: '원문' });
  return parts;
}

// 위 부분들을 실제 줄로 그린다 — 회의는 눌러서 회의 탭으로, 원문은 uiSourceLink 그대로.
function recordInfoLine(item) {
  const parts = recordInfoParts(item);
  if (!parts.length) return null;
  const line = document.createElement('div');
  line.className = 'd-recinfo';
  parts.forEach((part, index) => {
    if (index) line.append(' · ');
    if (part.kind === 'meeting') {
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'd-recinfo-lk';
      link.textContent = part.text;
      link.addEventListener('click', event => { event.stopPropagation(); openMeetingsTab(part.meetingId); });
      line.appendChild(link);
    } else if (part.kind === 'source') {
      line.appendChild(uiSourceLink(item, '원문'));
    } else {
      line.append(part.text);
    }
  });
  return line;
}

// 결정 찾기: 같은 기준(recordArchiveMatch)으로 미반영 결정과 반영 완료를 함께 거른다.
function decisionMatches(item) {
  return recordArchiveMatch(item, decisionQuery, decisionJiraSummary(item));
}

// ---- 좁은 창(≤900) 세그먼트: 아이디어 | 결정 가운데 한쪽만 보인다 ----
const RECORD_VIEW_KEY = 'recordView';
let recordView = 'decision';
// 저장된 값이 없거나 이상하면 기본값(결정)으로 — 순수 함수라 저장소 없이도 확인할 수 있다.
function recordViewFrom(stored) {
  return stored === 'idea' ? 'idea' : 'decision';
}
function recordViewRestore() {
  try { recordView = recordViewFrom(localStorage.getItem(RECORD_VIEW_KEY)); } catch { recordView = 'decision'; }
}
// CSS 미디어 쿼리(≤900)가 실제 숨김을 맡는다 — 여기서는 상태 클래스·버튼 표시만 맞춘다(리사이즈 리스너 없음).
function recordApplyView() {
  document.getElementById('gridRecords')?.classList.toggle('is-view-idea', recordView === 'idea');
  document.querySelectorAll('#recordViewSeg [data-record-view]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.recordView === recordView));
  });
}
function recordSetView(view) {
  recordView = recordViewFrom(view);
  try { localStorage.setItem(RECORD_VIEW_KEY, recordView); } catch {}
  recordApplyView();
}

function renderDecisions(items) {
  decisionCache = items;
  const countEl = document.getElementById('decisionSectionCount');
  countEl.textContent = items.length;
  countEl.title = decisionPendingTitle(items.length);
  const segBtn = document.getElementById('recordViewDecisionBtn');
  if (segBtn) segBtn.textContent = `결정 ${items.length}`;
  renderRecordColumn(document.getElementById('decisionList'), items.filter(decisionMatches),
    item => recordDecisionRow(item, false),
    decisionQuery ? '찾는 결정이 없어요.' : '정해진 내용이 아직 없어요. 맨 위 줄에서 바로 적을 수 있어요.');
}

function renderIdeas(items) {
  document.getElementById('ideaCount').textContent = items.length;
  const segBtn = document.getElementById('recordViewIdeaBtn');
  if (segBtn) segBtn.textContent = `아이디어 ${items.length}`;
  renderRecordColumn(document.getElementById('ideaList'), items,
    recordIdeaRow, '아이디어가 아직 없어요. 맨 위 줄에서 바로 적어 둘 수 있어요.');
}

// 결정 열 아래 접힌 구역. 결정 찾기로 찾는 중에는 자동으로 펼쳐져 결과를 보여 주고,
// 지우면 접힘 상태(decisionArchiveOpen)로 돌아간다.
function renderDecisionArchive() {
  const toggle = document.getElementById('decisionArchiveToggle');
  const body = document.getElementById('decisionArchiveBody');
  const list = document.getElementById('decisionArchiveList');
  if (!toggle || !body || !list) return;
  const items = decisionArchiveCache.filter(decisionMatches);
  const open = decisionArchiveOpen || !!decisionQuery;
  document.getElementById('decisionArchiveCount').textContent = items.length;
  toggle.setAttribute('aria-expanded', String(open));
  body.hidden = !open;
  list.replaceChildren();
  if (!open) return;
  if (!items.length) {
    list.insertAdjacentHTML('beforeend', `<div class="d-empty">${decisionQuery ? '찾는 결정이 없어요.' : '아직 반영 완료한 결정이 없어요.'}</div>`);
    return;
  }
  items.forEach(item => list.appendChild(recordDecisionRow(item, true)));
}

// 결정의 `PRD 반영함` 체크 한 칸(`.d-check` + `.d-cb`, 업무 완료 체크와 같은 가족·같은 흰 체크).
// 결정 줄이 있는 곳은 모두 이 부품을 쓴다(아이디어·결정 탭, 회의 카드/탭의 결정 줄, 프로젝트 탭 결정 줄).
function decisionCheckbox(item, row, archived) {
  const check = document.createElement('span');
  check.className = 'd-check';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.className = 'd-cb';
  box.checked = archived;
  box.title = 'PRD 반영함으로 표시';
  box.setAttribute('aria-label', `${item.description} — PRD 반영함으로 표시`);
  box.addEventListener('change', () =>
    fadeOutAndRun(row, () => toggleTask(item.id), archived ? 'PRD 미반영으로 되돌렸어요' : 'PRD 반영으로 표시했어요')
  );
  check.appendChild(box);
  check.insertAdjacentHTML('beforeend', UI_TICK_SVG);
  return check;
}

// 결정 한 줄: PRD 반영 체크 | 문구(눌러서 그 자리 수정) + (반영 완료면) 프로젝트 | 반영 날짜 | 늘 보이는 더보기,
// 그 아래 조용한 정보 줄(날짜·나온 회의·원문).
function recordDecisionRow(item, archived) {
  const row = document.createElement('div');
  row.className = 'd-rec is-dec' + (archived ? ' is-done' : '');
  // 검색 팔레트가 이 줄을 찾아 옮겨 갈 수 있게 표식을 남긴다.
  row.dataset.itemId = item.id;

  row.appendChild(decisionCheckbox(item, row, archived));

  const title = document.createElement('span');
  title.className = 'ti';
  title.textContent = item.description;
  if (!archived) makeEditableDesc(title, item);
  // 말줄임으로 잘린 문구도 마우스를 올리면 전부 읽을 수 있게(수정 안내는 aria-label이 한다).
  title.title = item.description;
  if (item.isNew && !archived) { title.prepend(renderNewDot(item)); observeNewItem(row, item); }
  // 원문은 제목 옆이 아니라 아래 정보 줄로 옮긴다(한 곳에만) — showSource: false.
  recordTitleCell(row, title, item, archived ? recordProjectName(item) : '', false);

  const meta = document.createElement('span');
  meta.className = 'mt';
  meta.textContent = archived && item.completed ? `${uiKoDateShort(item.completed)} 반영` : '';
  row.appendChild(meta);

  // 결정 아래 조용한 정보 한 줄: 날짜 · 나온 회의 · 원문(있는 것만). 반영 완료 줄에도 같이 붙는다.
  const info = recordInfoLine(item);
  if (info) row.appendChild(info);

  // 이 줄에서 할 수 있는 일이 더보기뿐이라 ⋯은 늘 보인다(반영 완료 줄도 같다).
  const acts = document.createElement('span');
  acts.className = 'ac';
  acts.appendChild(uiMoreButton(`${item.description} — 더 보기`, () => decisionMenuSections(item, row)));
  row.appendChild(acts);
  return row;
}

// 결정 줄의 더보기(결정·아이디어 탭과 회의 카드가 함께 쓴다).
// 결정에는 날짜가 없으므로(DECISIONS) 프로젝트와 삭제뿐이다.
function decisionMenuSections(item, card) {
  return [
    [{ field: '프로젝트', control: taskProjectControl(item) }],
    [{ label: '삭제', danger: true, onClick: () => removeTracked(item, card) }],
  ];
}

// 아이디어 줄의 더보기(아이디어·결정 탭과 프로젝트 탭이 함께 쓴다).
function ideaMenuSections(item, row) {
  const promote = async (due) => {
    await postJson('/api/idea/promote', { id: item.id, due });
    await load();
  };
  return [
    [
      { label: '오늘로 옮기기', onClick: () => fadeOutAndRun(row, () => promote(todayStr()), '오늘 할 일로 옮겼어요') },
      {
        field: '날짜 정해서 옮기기',
        control: uiDateField({
          value: '',
          label: '옮길 날짜',
          clearable: false,
          onChange: (value) => { if (value) fadeOutAndRun(row, () => promote(value), '할 일로 옮겼어요'); },
        }),
      },
      { label: '완료로 표시', onClick: () => fadeOutAndRun(row, () => toggleTask(item.id), '완료했어요') },
      { field: '가능성', control: ideaChanceControl(item) },
      { field: '프로젝트', control: ideaProjectControl(item) },
    ],
    [{ label: '삭제', danger: true, onClick: () => removeTracked(item, row) }],
  ];
}

// 아이디어 한 줄: 체크박스 없이 문구 + 원문 | `가능성 높음` | 늘 보이는 더보기.
function recordIdeaRow(item) {
  const row = document.createElement('div');
  row.className = 'd-rec is-idea';
  row.dataset.itemId = item.id;

  const title = document.createElement('span');
  title.className = 'ti';
  title.textContent = item.description;
  title.title = item.description;
  if (item.isNew) { title.prepend(renderNewDot(item)); observeNewItem(row, item); }
  recordTitleCell(row, title, item, '');

  const meta = document.createElement('span');
  meta.className = 'mt';
  meta.textContent = ideaChanceText(item);
  row.appendChild(meta);

  const acts = document.createElement('span');
  acts.className = 'ac';
  acts.appendChild(uiMoreButton(`${item.description} — 더 보기`, () => ideaMenuSections(item, row)));
  row.appendChild(acts);
  return row;
}

// 가능성은 우선순위와 같은 값을 쓰되(`/api/track/set-priority`) 이름만 다르게 부른다.
const IDEA_CHANCE_CHIPS = [['high', '높음'], ['medium', '보통'], ['low', '낮음']];
function ideaChanceControl(item) {
  return uiMenuChips(IDEA_CHANCE_CHIPS, item.priority || 'medium', async (value) => {
    uiMenuClose();
    await setPriority(item.id, value);
    announce('가능성을 바꿨어요');
    await load();
  });
}

// 아이디어의 프로젝트는 지라 연결 없이 이름 한 칸이다(`/api/idea/set-project`).
function ideaProjectControl(item) {
  return uiMenuText({
    value: item.project,
    label: '프로젝트',
    placeholder: '프로젝트 이름',
    onChange: async (project) => {
      await setIdeaProject(item.id, project);
      announce(project ? '프로젝트를 지정했어요' : '프로젝트를 지웠어요');
      await load();
    },
  });
}

const STALE_WAITING_DAYS = 3;

// 확인이 끝난 내용은 그대로 두면 사라진다 — 같은 문구로 정책/얼라인 한 줄을 만든다.
// 알림의 후속 동작(확인 완료 직후)과 더보기·상세의 `결정으로 남기기`가 같은 길을 쓴다.
async function createDecisionFromWaiting(item, button) {
  if (button) button.disabled = true;
  try {
    const response = await postJson('/api/decision/create', { description: item.description, jira: item.jira, group: item.group, permalink: item.permalink });
    const { id } = await response.json();
    pushUndo({
      label: `${item.description} (결정으로 남기기)`,
      undo: () => postJson('/api/track/remove', { id }),
      redo: () => postJson('/api/track/restore', { id }),
    });
    await load();
    announce('결정으로 남겼어요 · 아이디어·결정 탭에서 다듬을 수 있어요');
    return true;
  } catch { if (button) button.disabled = false; return false; }
}

// ---------- 확인 대기를 체크한 뒤의 `다음은?` 줄 ----------
// 답을 받은 직후가 "그래서 이제 뭘 하지"를 정하기 가장 좋은 때인데, 몇 초 만에 사라지는 알림으로는
// 그 순간이 지나가 버렸다. 그래서 체크한 그 자리에 제안 줄을 남긴다.
// 체크 자체는 지금처럼 바로 저장되고(toggleTask · ⌘Z 그대로) 이 줄은 제안일 뿐이라 무시해도 된다.
// 상태는 메모리에만 둔다(저장하지 않는다) — 목록이 다시 그려져도(load) 줄은 남고,
// `닫기` · 액션 하나를 끝냄 · 다른 확인 대기를 체크함 · 탭을 떠남 · 새로고침 · 체크를 되돌림으로 사라진다.
let waitingNextId = null;
const WAITING_ANSWER_PLACEHOLDER = '받은 답을 한 줄로 — 주간요약의 확인 완료에 그대로 올라가요';

function waitingNextOpen(item) { waitingNextId = item.id; }

// 지금 `다음은?`을 물어야 하는 확인 대기. 체크를 되돌렸으면(⌘Z·다시 체크 해제) 스스로 내려간다.
// id를 주면 그 항목일 때만 돌려준다(회의 줄처럼 자기 줄 아래에만 붙이는 자리).
function waitingNextItem(id) {
  if (!waitingNextId || (id !== undefined && id !== waitingNextId)) return null;
  const item = typeof wfItem === 'function' ? wfItem(waitingNextId) : null;
  if (!item || item.type !== 'check' || item.status !== 'done') { waitingNextId = null; return null; }
  return item;
}

// 줄을 걷는다 — 목록을 통째로 다시 그리지 않고 그려져 있는 줄만 그 자리에서 없앤다.
function waitingNextClose() {
  waitingNextId = null;
  [...(document.querySelectorAll?.('.d-wnext') || [])].forEach(node => (node.closest?.('.d-wnextwrap') || node).remove?.());
}

// 이 확인 대기를 `기다리는 답변`(blockedBy)으로 연결해 둔 미완료 업무 — 답이 왔으니 이제 움직일 수 있다.
function waitingNextBlocked(item) {
  const all = (typeof workflowData === 'object' && workflowData ? workflowData.items : null) || [];
  return all.filter(task => ['task', 'bug'].includes(task.type) && task.status !== 'done' && task.blockedBy === item.id);
}

// 액션을 고르면 버튼 줄이 그 자리에서 입력 줄로 바뀐다. Enter는 첫 버튼과 같고(한글 조합 중에는 넘긴다),
// Esc는 입력만 닫는다(escPush/escDrop — 카드·목록은 그대로 둔다).
function waitingNextEdit(bar, { value, placeholder, label, buttons, onSubmit }) {
  const form = document.createElement('div');
  form.className = 'nx is-ed';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'd-din';
  input.maxLength = 1000;
  input.value = value || '';
  input.placeholder = placeholder || '';
  input.setAttribute('aria-label', label);
  form.appendChild(input);

  let settled = false;
  const cancel = () => {
    if (settled) return;
    settled = true;
    escDrop(cancel);
    if (!form.isConnected) return; // 목록이 이미 다시 그려졌으면 되돌릴 자리가 없다
    form.replaceWith(bar);
  };
  escPush(cancel);

  const submit = async (mode, button) => {
    if (settled || input.disabled) return;
    const text = input.value.replace(/[\r\n]+/g, ' ').trim();
    if (!text) { cancel(); return; }
    input.disabled = true;
    if (button) button.disabled = true;
    try {
      await onSubmit(text, mode);
      settled = true;
      escDrop(cancel);
      waitingNextClose();
    } catch {
      input.disabled = false;
      if (button) button.disabled = false;
      input.focus();
    }
  };
  buttons.forEach(([mode, text]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'd-btn sm';
    button.textContent = text;
    button.setAttribute('aria-label', `${label} — ${text}`);
    button.addEventListener('click', () => submit(mode, button));
    form.appendChild(button);
  });
  input.addEventListener('keydown', async (event) => {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    await submit(buttons[0][0]);
  });
  bar.replaceWith(form);
  input.focus();
  input.select?.();
  return { form, input, cancel };
}

// 후속 할 일은 기존 업무 만들기 길을 그대로 쓴다 — 프로젝트는 확인 대기와 같게(지라면 같은 지라 이슈),
// 기한·우선순위는 넣지 않는다(마감일을 추측해 만들지 않는다).
// 되돌리기는 만든 업무를 지우는 기존 길(결정으로 남기기와 같다).
async function waitingNextCreateTask(item, description, mode) {
  const endpoint = mode === 'later' ? '/api/later-task/create' : '/api/today-task/create';
  const response = await postJson(endpoint, {
    description,
    ...(item.jira ? { jira: item.jira } : item.group ? { group: item.group } : {}),
  });
  const { id } = await response.json();
  pushUndo({
    label: `${description} (후속 할 일)`,
    undo: () => postJson('/api/track/remove', { id }),
    redo: () => postJson('/api/track/restore', { id }),
  });
  await load();
  announce(mode === 'later' ? '나중에 할 일에 추가했어요' : '오늘 할 일에 추가했어요');
}

// 답을 기다리던 업무 줄 — 최대 세 개, 더 있으면 `외 N개`. 이미 오늘 할 일이면 `오늘로`는 없다.
function waitingNextBlockedList(blocked) {
  const box = document.createElement('div');
  box.className = 'bl';
  const lead = document.createElement('span');
  lead.className = 'lb';
  lead.textContent = '이 답을 기다리던 업무';
  box.appendChild(lead);
  const today = todayStr();
  blocked.slice(0, 3).forEach((task) => {
    const line = document.createElement('div');
    line.className = 'bln';
    const title = document.createElement('span');
    title.className = 'ti';
    title.title = task.description;
    title.textContent = task.description;
    line.appendChild(title);
    // 버튼은 한 덩어리로 붙여 둔다 — 레일처럼 좁은 자리에서 `오늘로`와 `열기`가 따로 줄바꿈되지 않게.
    const acts = document.createElement('span');
    acts.className = 'ac';
    line.appendChild(acts);
    if (task.scheduled !== today) {
      const move = document.createElement('button');
      move.type = 'button';
      move.className = 'd-btn sm';
      move.textContent = '오늘로';
      move.setAttribute('aria-label', `${task.description} — 오늘로`);
      move.addEventListener('click', async () => {
        move.disabled = true;
        try { await setTaskScheduled(task.id, todayStr()); announce('오늘 할 일로 옮겼어요'); }
        catch { move.disabled = false; }
      });
      acts.appendChild(move);
    }
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'd-btn sm';
    open.textContent = '열기';
    open.setAttribute('aria-label', `${task.description} 상세 보기`);
    open.addEventListener('click', () => panelOpen({ id: task.id }));
    acts.appendChild(open);
    box.appendChild(line);
  });
  if (blocked.length > 3) {
    const more = document.createElement('div');
    more.className = 'bln is-more';
    more.textContent = `외 ${blocked.length - 3}개`;
    box.appendChild(more);
  }
  return box;
}

// `다음은?` 줄 한 벌. 세 자리(레일 확인 대기 카드 · 프로젝트 탭 확인 대기 구역 ·
// 회의 카드/탭의 `이 회의에서 나온 것`)가 이 부품 하나를 쓴다.
function waitingNextRow(item) {
  const wrap = document.createElement('div');
  wrap.className = 'd-wnext';
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', `${item.description} — 다음은?`);

  const bar = document.createElement('div');
  bar.className = 'nx';
  const label = document.createElement('span');
  label.className = 'lb';
  label.textContent = '다음은?';
  bar.appendChild(label);

  const act = (text, onClick) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'd-btn sm';
    button.textContent = text;
    button.setAttribute('aria-label', `${item.description} — ${text}`);
    button.addEventListener('click', () => onClick(button));
    bar.appendChild(button);
  };
  act('후속 할 일', () => waitingNextEdit(bar, {
    value: item.description,
    placeholder: '후속 할 일 — Enter로 오늘 할 일',
    label: `${item.description} — 후속 할 일`,
    buttons: [['today', '오늘'], ['later', '나중에']],
    onSubmit: (text, mode) => waitingNextCreateTask(item, text, mode),
  }));
  act('결정으로 남기기', async (button) => {
    if (await createDecisionFromWaiting(item, button)) waitingNextClose();
  });
  act('답변 한 줄 남기기', () => waitingNextEdit(bar, {
    value: (typeof wfItem === 'function' ? wfItem(item.id)?.outcome : '') || '',
    placeholder: WAITING_ANSWER_PLACEHOLDER,
    label: `${item.description} — 답변 한 줄`,
    buttons: [['save', '저장']],
    // 업무의 `결과 한 줄`과 같은 저장 길(outcome) — 주간요약의 `확인 완료` 문장이 이 한 줄이 된다.
    onSubmit: async (text) => { await postJson('/api/workflow/item', { id: item.id, outcome: text }); await load(); },
  }));

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'd-btn sm is-cl';
  dismiss.textContent = '닫기';
  dismiss.setAttribute('aria-label', `${item.description} — 다음은? 닫기`);
  dismiss.addEventListener('click', () => waitingNextClose());
  bar.appendChild(dismiss);
  wrap.appendChild(bar);

  const blocked = waitingNextBlocked(item);
  if (blocked.length) wrap.appendChild(waitingNextBlockedList(blocked));
  return wrap;
}

// 미완료만 보여 주는 목록(레일 확인 대기·프로젝트 탭)에서는 체크한 줄이 빠진다 —
// 방금 체크한 줄을 목록 맨 위에 한 번 더 그리고 그 아래에 `다음은?`을 붙인다.
function waitingNextLead(item, makeRow) {
  const wrap = document.createElement('div');
  wrap.className = 'd-wnextwrap';
  wrap.appendChild(makeRow(item));
  wrap.appendChild(waitingNextRow(item));
  return wrap;
}

// 확인 요청을 오늘 다시 보냈다는 기록. 다시 확인할 날짜는 건드리지 않는다.
async function markContactedToday(item) {
  const detail = typeof wfItem === 'function' ? wfItem(item.id) : null;
  await postJson('/api/workflow/item', { id: item.id, contacted: todayStr(), followUp: detail?.followUp || null });
  await load();
  announce('오늘 확인을 요청한 것으로 적었어요');
}

async function setTaskWho(id, who) {
  await postJson('/api/track/set-who', { id, who: who || null });
  announce(who ? '누구에게를 적었어요' : '누구에게를 지웠어요');
  await load();
}

// 줄·상세 어디서 지우든 같은 길: 휴지통으로 보내고(원문 보존) 알림의 `삭제 실행 취소`로 되돌린다.
function removeTracked(item, card, message = '삭제했어요') {
  return fadeOutAndRun(card, async () => {
    await postJson('/api/track/remove', { id: item.id });
    await load();
  }, message);
}

// 확인 대기 줄·상세의 더보기. 용어는 화면 어디서나 같다(답변 받을 날 = 상대에게 답을 받기로 한 날).
function waitingMenuSections(item, card) {
  const detail = typeof wfItem === 'function' ? wfItem(item.id) : null;
  return [
    [
      { label: '결정으로 남기기', onClick: () => createDecisionFromWaiting(item) },
      { label: '오늘 확인 요청함', onClick: () => markContactedToday(item) },
    ],
    [
      {
        field: '다시 확인할 날짜',
        control: uiDateField({
          value: detail?.followUp,
          label: '다시 확인할 날짜',
          onChange: async (value) => {
            await postJson('/api/workflow/item', { id: item.id, followUp: value });
            announce(value ? `${uiKoDate(value)}에 다시 확인할게요` : '다시 확인할 날짜를 지웠어요');
            await load();
          },
        }),
      },
      {
        field: '답변 받을 날',
        control: uiDateField({
          value: item.due,
          label: '답변 받을 날',
          onChange: async (value) => {
            await setTaskDue(item.id, value);
            announce(value ? `답변 받을 날을 ${uiKoDate(value)}로 정했어요` : '답변 받을 날을 지웠어요');
          },
        }),
      },
      {
        field: '누구에게',
        control: uiMenuText({ value: item.who, label: '누구에게', placeholder: '이름', onChange: (who) => setTaskWho(item.id, who) }),
      },
      {
        field: '프로젝트',
        control: renderGroupControl({
          jira: item.jira,
          group: item.group,
          onSetJira: (key) => setTaskJira(item.id, key),
          onSetGroup: (group) => setTaskGroup(item.id, group),
        }),
      },
    ],
    [{ label: '삭제', danger: true, onClick: () => removeTracked(item, card) }],
  ];
}

// 오늘 다시 확인해야 하는 건(다시 확인할 날짜가 지났거나 오늘이고, 오늘 아직 요청하지 않은 건)인가.
// 흐름 기록(.workflow.json)에 있는 값이라 바깥에서 받아 쓴다.
function waitingRecheck(detail, today) {
  return !!(detail && detail.followUp && detail.followUp <= today && detail.contacted !== today);
}

// 확인 대기 정렬: `오늘 다시 확인`이 맨 위 → 답변 받을 날이 있는 것(빠른 날짜 순) → 먼저 등록한 순.
// 화면을 만지지 않는 순수 함수라 테스트가 직접 부른다(오늘 날짜와 흐름 기록 조회를 넘겨받는다).
function waitingOrder(items, today, detailOf) {
  const day = today || todayStr();
  const lookUp = detailOf || (id => (typeof wfItem === 'function' ? wfItem(id) : null));
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const rank = item => (waitingRecheck(lookUp(item.id), day) ? 0 : item.due ? 1 : 2);
  return [...items].sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 1) return cmp(a.due, b.due);
    return cmp(a.created || '', b.created || '');
  });
}

// 며칠째 기다리는지. STALE_WAITING_DAYS(3)일째부터 주의색으로 눈에 띄게 한다.
function waitingAgeText(created, today) {
  if (!created) return null;
  const days = Math.round((new Date(`${today}T00:00:00`) - new Date(`${created}T00:00:00`)) / 86400000);
  if (!Number.isFinite(days) || days <= 0) return { text: '오늘', tone: '' };
  return { text: `${days}일째`, tone: days >= STALE_WAITING_DAYS ? 'warn' : '' };
}

// 확인 대기 카드의 `프로젝트별` 묶음. 먼저 급한 순(waitingOrder)으로 통째로 정렬한 뒤 프로젝트로
// 묶는다 — 그 순서에서 처음 나오는 프로젝트가 위로 오므로 "가장 급한 줄이 있는 묶음이 위"가 되고,
// 묶음 안의 차례도 그 순서 그대로 남는다. 프로젝트 없는 것은 `프로젝트 없음`으로 맨 아래.
// 화면을 만지지 않는 순수 함수라 테스트가 직접 부른다.
function waitingGroups(items, today, detailOf) {
  const sorted = waitingOrder(items, today, detailOf);
  const groups = new Map();
  sorted.forEach((item) => {
    const named = item.group || item.project;
    const key = item.jira ? `jira:${item.jira}` : named ? `group:${named}` : '__misc__';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  });
  const keys = [...groups.keys()];
  const ordered = keys.includes('__misc__') ? [...keys.filter(key => key !== '__misc__'), '__misc__'] : keys;
  return ordered.map(key => [key, groups.get(key)]);
}

// 카드 머리 ⋯의 보기 전환 — `프로젝트별`(기본) / `급한 순`. 고른 값은 브라우저에 기억한다.
const WAITING_VIEW_KEY = 'waitingView';
let waitingView = 'project';
try { waitingView = localStorage.getItem(WAITING_VIEW_KEY) === 'urgent' ? 'urgent' : 'project'; } catch {}
let waitingItemsCache = [];
function setWaitingView(value) {
  if (waitingView === value) return;
  waitingView = value;
  try { localStorage.setItem(WAITING_VIEW_KEY, waitingView); } catch {}
  renderWaiting(waitingItemsCache);
}

function renderWaiting(items) {
  waitingItemsCache = items;
  document.getElementById('waitingCount').textContent = items.length;
  document.getElementById('waitingSectionCount').textContent = items.length;
  const list = document.getElementById('waitingList');
  list.replaceChildren();

  // 방금 체크한 줄은 이 목록(미완료만)에서 빠진다 — 맨 위에 한 번 더 그려 `다음은?`을 잇는다.
  const checkedNow = waitingNextItem();
  if (checkedNow) list.appendChild(waitingNextLead(checkedNow, entry => renderWaitingRow(entry, { showProject: true })));

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'd-rempty';
    empty.textContent = '기다리는 답변이 없어요.';
    list.appendChild(empty);
    return;
  }
  if (waitingView === 'urgent') {
    waitingOrder(items).forEach(item => list.appendChild(renderWaitingRow(item, { showProject: true })));
    return;
  }
  const groups = waitingGroups(items);
  const labels = uiGroupLabels(groups.map(([key]) => key));
  groups.forEach(([key, group]) => {
    list.appendChild(uiGroupHeading(labels.get(key), group.length, {
      projectName: key === '__misc__' ? null : key,
      onOpenProject: key === '__misc__' ? null : () => openProjectTab(key),
    }));
    group.forEach(item => list.appendChild(renderWaitingRow(item)));
  });
}

// 확인 대기 체크(`.d-wcb`, 체크는 CSS로 그린다) — 확인 대기 줄이 있는 곳은 모두 이 부품을 쓴다
// (레일 확인 대기, 회의 카드/탭의 확인 대기 줄, 프로젝트 탭 확인 대기 줄).
function waitingCheckboxInput(item, done) {
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'd-wcb';
  checkbox.checked = done;
  checkbox.setAttribute('aria-label', `${item.description} — 확인 완료로 표시`);
  return checkbox;
}
// 저장 동작을 단다. 레일 줄은 체크박스가 줄보다 먼저 있어야 해서(uiRailRow가 체크박스를 받아 줄을 만든다)
// 줄이 다 만들어진 뒤에 따로 부른다 — 회의 카드·프로젝트 탭 줄처럼 줄이 먼저 있는 자리는 waitingCheckbox 하나로 끝낸다.
function wireWaitingCheckbox(checkbox, item, row, done) {
  checkbox.addEventListener('change', () =>
    fadeOutAndRun(row, async () => {
      // 확인이 끝난 내용은 그대로 두면 사라진다 — 체크한 그 자리에서 `다음은?`을 묻는다.
      // 그 줄은 다시 그려진 목록에 함께 서야 하므로 목록을 다시 그리는 toggleTask보다 먼저 올려 둔다.
      if (done) waitingNextClose(); else waitingNextOpen(item);
      try { await toggleTask(item.id); }
      catch (error) { waitingNextClose(); throw error; }
    }, done ? '대기중으로 되돌렸어요' : '확인 완료로 표시했어요')
  );
}
function waitingCheckbox(item, row, done) {
  const checkbox = waitingCheckboxInput(item, done);
  wireWaitingCheckbox(checkbox, item, row, done);
  return checkbox;
}

// 레일의 확인 대기 한 줄 — 두 줄 구성.
//   첫 줄: 제목(최대 2줄) + `원문`
//   둘째 줄: (급한 순 보기면 맨 앞에 조용한 프로젝트 표기) + `결제팀 · 2일째`(3일째부터 주의색)
//            + 답변 받을 날 배지(지났거나 오늘일 때만) + `오늘 다시 확인` / `9월 24일 다시 확인` / `오늘 요청함`
// 값 수정은 더보기·상세가 맡는다.
function renderWaitingRow(item, opts = {}) {
  const done = item.status === 'done';
  const today = todayStr();
  const detail = typeof wfItem === 'function' ? wfItem(item.id) : null;
  const recheck = waitingRecheck(detail, today);

  const checkbox = waitingCheckboxInput(item, done);

  // 조각으로 모아 두 줄째에 그대로 펼쳐 넣는다(한 겹 더 감싸면 사이 여백이 죽는다).
  const sub = document.createDocumentFragment();
  // 프로젝트별 묶음일 때는 소제목이 이미 프로젝트를 말해 준다 — 급한 순일 때만 줄 맨 앞에 붙인다.
  if (opts.showProject && (item.jira || item.group || item.project)) {
    sub.appendChild(uiInlineProject(item, { lead: false }));
  }
  // `결제팀 · 2일째` — 한 덩어리로 붙여 읽는다(3일째부터 주의색 글자, 배지는 아니다).
  const age = waitingAgeText(item.created, today);
  if (item.who || age) {
    const line = document.createElement('span');
    line.className = 'who';
    if (item.who) line.append(item.who);
    if (age) {
      const days = document.createElement('span');
      days.className = uiTone(age.tone).trim();
      days.title = '이만큼 답을 기다리고 있어요';
      days.textContent = age.text;
      if (item.who) line.append(' · ');
      line.append(days);
    }
    sub.appendChild(line);
  }
  // 답변 받을 날은 지났거나 오늘일 때만 배지로 세운다 — 먼 날짜는 줄을 시끄럽게 하지 않는다.
  // 답을 받은 줄(체크한 뒤 `다음은?`과 함께 다시 그리는 줄)에는 늦음·다시 확인을 세우지 않는다.
  const reply = done ? null : uiReplyText(item.due);
  if (reply) {
    const badge = document.createElement('span');
    badge.className = `bd${uiTone(reply.tone)}`;
    badge.title = `${uiKoDate(item.due)}까지 답변을 받기로 했어요`;
    badge.textContent = reply.text;
    sub.appendChild(badge);
  }
  const next = done ? '' : recheck ? '오늘 다시 확인'
    : detail?.followUp ? `${uiKoDateShort(detail.followUp)} 다시 확인`
    : detail?.contacted === today ? '오늘 요청함' : '';
  if (next) {
    const cell = document.createElement('span');
    cell.className = 'nx';
    cell.textContent = next;
    sub.appendChild(cell);
  }

  const row = uiRailRow({
    id: item.id,
    text: item.description,
    check: checkbox,
    two: true,
    selected: !!panelState && panelState.id === item.id,
    badge: item.isNew && !done ? renderNewDot(item) : null,
    source: uiSourceLink(item),
    sub: sub.childNodes.length ? sub : '',
    more: done ? null : uiMoreButton(`${item.description} — 더 보기`, () => waitingMenuSections(item, row)),
    onOpen: () => panelOpen({ id: item.id }),
  });
  if (done) row.classList.add('is-done');
  if (item.isNew && !done) observeNewItem(row, item);

  wireWaitingCheckbox(checkbox, item, row, done);
  return row;
}

function renderLaterTasks(items) {
  document.getElementById('laterTaskSectionCount').textContent = items.length;
  document.getElementById('laterDrawerCount').textContent = items.length;
  const list = document.getElementById('laterTaskList');
  list.replaceChildren();
  list.classList.toggle('d-list', items.length > 0);
  if (!items.length) {
    list.innerHTML = '<div class="d-empty">나중에 할 일이 없어요.</div>';
    return;
  }

  const groups = uiGroupTasks(items);
  const labels = uiGroupLabels(groups.map(([key]) => key));
  groups.forEach(([key, groupItems]) => {
    const addRow = uiGroupAddRow(key, '/api/later-task/create', '나중에 할 일에 추가했어요');
    const heading = uiGroupHeading(labels.get(key), groupItems.length, {
      projectName: key === '__misc__' ? null : key,
      onAdd: () => { addRow.hidden = false; addRow.querySelector('input').focus(); },
      onOpenProject: key === '__misc__' ? null : () => openProjectTab(key),
    });
    list.append(heading, addRow);
    [...groupItems]
      .sort((a, b) => {
        if (a.due && b.due) return a.due < b.due ? -1 : a.due > b.due ? 1 : 0;
        if (a.due) return -1;
        if (b.due) return 1;
        return 0;
      })
      .forEach(item => list.appendChild(uiTaskRow(item, { mode: 'later', grouped: key !== '__misc__' })));
  });
}

// ---------- 나중에 할 일 서랍 ----------
// 헤더 아래 오른쪽에 붙어서 열린다. 넓은 화면에서는 본문을 덮지 않고 밀어내므로(ui.css)
// 오늘 목록이 좁아질 뿐 그대로 쓸 수 있다. 열어 둔 상태는 브라우저에 기억한다.
const LATER_DRAWER_KEY = 'laterDrawerOpen';
let laterDrawerOpen = false;

function drawerSync() {
  const drawer = document.getElementById('laterTaskDrawer');
  const toggle = document.getElementById('laterTaskToggle');
  document.body.classList.toggle('later-open', laterDrawerOpen);
  if (drawer) drawer.setAttribute('aria-hidden', String(!laterDrawerOpen));
  if (toggle) toggle.setAttribute('aria-expanded', String(laterDrawerOpen));
  // 서랍이 열리고 닫히면 상세 카드가 붙어 있던 줄이 움직인다 — 자리를 다시 잡아 준다.
  if (panelState) panelRender();
}

function drawerOpen() {
  if (laterDrawerOpen) return;
  laterDrawerOpen = true;
  try { localStorage.setItem(LATER_DRAWER_KEY, '1'); } catch {}
  drawerSync();
  escDrop(drawerClose);
  escPush(drawerClose);
  document.getElementById('laterTaskInput')?.focus();
}

function drawerClose() {
  if (!laterDrawerOpen) return;
  laterDrawerOpen = false;
  try { localStorage.setItem(LATER_DRAWER_KEY, '0'); } catch {}
  drawerSync();
  escDrop(drawerClose);
  document.getElementById('laterTaskToggle')?.focus();
}

// 새로고침해도 열려 있던 서랍은 그대로 열어 둔다(포커스는 옮기지 않는다).
function drawerRestore() {
  let saved = '0';
  try { saved = localStorage.getItem(LATER_DRAWER_KEY) || '0'; } catch {}
  if (saved !== '1') { drawerSync(); return; }
  laterDrawerOpen = true;
  drawerSync();
  escPush(drawerClose);
}

function compareTasks(a, b) {
  const rank = { critical: 0, high: 1, medium: 2, low: 3 };
  return (rank[a.priority] ?? 2) - (rank[b.priority] ?? 2) || (a.due || '9999').localeCompare(b.due || '9999');
}

function taskCompletionCheckbox(item, card, done) {
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  // 우선순위는 색만으로 말하지 않는다 — 클래스는 꺾쇠·테두리 색을 정하고, 툴팁과 이름표가 말을 붙인다.
  const mark = uiPriorityMark(item, done);
  checkbox.className = 'd-cb' + (mark ? ` is-pri-${mark.level}` : '');
  checkbox.checked = done;
  if (mark) checkbox.title = mark.hint;
  checkbox.setAttribute('aria-label', `${item.description} — ${mark ? `${mark.text} · ` : ''}완료로 표시`);
  checkbox.addEventListener('change', () => {
    // 끝내는 순간을 눈으로 보여 준다: 체크가 그려지고 → 제목에 줄이 그어지고 → 옅어진다.
    // 저장·되돌리기 쪽은 그대로다(클래스 하나만 붙인다. 움직임 줄이기에서는 ui.css가 끈다).
    if (!done) card.classList.add('is-completing');
    fadeOutAndRun(card, async () => { await toggleTask(item.id); if (!done) workflowOutcome(item); }, done ? '미완료로 되돌렸어요' : null);
  });
  return checkbox;
}

// "언제 할지" 칩. 날짜를 직접 고르려면 `날짜…`가 그 자리에서 날짜 칸으로 바뀐다.
function taskWhenControl(item, mode, card) {
  const wrap = document.createElement('span');
  wrap.className = 'd-chips';
  const move = async (scheduled, message) => {
    uiMenuClose();
    await fadeOutAndRun(card || wrap, () => setTaskScheduled(item.id, scheduled), message);
  };
  const options = [['오늘', todayStr(), '오늘 할 일로 옮겼어요'], ['내일', tomorrowStr(), '내일로 미뤘어요']];
  // 이미 나중에 있는 업무에 `나중에`를 또 보여 주지 않는다.
  if (mode !== 'later') options.push(['나중에', null, '나중에 할 일로 옮겼어요 · 기한은 그대로예요']);
  options.forEach(([text, scheduled, message]) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'd-chip' + ((scheduled && item.scheduled === scheduled) || (!scheduled && mode === 'later') ? ' is-on' : '');
    chip.setAttribute('role', 'menuitem');
    chip.textContent = text;
    chip.addEventListener('click', () => move(scheduled, message));
    wrap.appendChild(chip);
  });
  const pick = document.createElement('button');
  pick.type = 'button';
  pick.className = 'd-chip';
  pick.setAttribute('role', 'menuitem');
  pick.textContent = '날짜…';
  pick.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'date';
    input.className = 'd-dateinput';
    input.value = item.scheduled || '';
    input.setAttribute('aria-label', '언제 할지 날짜');
    input.addEventListener('change', () => { if (input.value) move(input.value, `${uiKoDate(input.value)}로 옮겼어요`); });
    wrap.replaceChildren(input);
    input.focus();
    input.showPicker?.();
  });
  wrap.appendChild(pick);
  return wrap;
}

// 저장하는 값(critical/high/medium/low)은 그대로 두고 화면에 보이는 말만 바꾼다.
const TASK_PRIORITY_CHIPS = UI_PRIORITY_CHOICES;
function taskPriorityControl(item) {
  return uiMenuChips(TASK_PRIORITY_CHIPS, item.priority || 'medium', async (value) => {
    uiMenuClose();
    await setPriority(item.id, value);
    announce('우선순위를 바꿨어요');
    await load();
  });
}

function taskProjectControl(item) {
  return renderGroupControl({
    jira: item.jira,
    group: item.group,
    onSetJira: (key) => setTaskJira(item.id, key),
    onSetGroup: (group) => setTaskGroup(item.id, group),
  });
}

// 업무 줄·상세의 더보기: 동작 → 값 바꾸기 → 삭제. 오늘 줄과 나중 줄은 한 항목만 다르다.
function taskMenuSections({ item, mode, card }) {
  const actions = [{
    label: item.doing ? '진행 중 해제' : '진행 중으로 표시',
    onClick: () => setTaskDoing(item.id, !item.doing),
  }];
  if (mode === 'later') actions.push({
    label: '완료로 표시',
    onClick: () => fadeOutAndRun(card, () => toggleTask(item.id), '완료했어요'),
  });
  return [
    actions,
    [
      { field: '언제 할지', control: taskWhenControl(item, mode, card) },
      {
        field: '기한',
        control: uiDateField({
          value: item.due,
          label: '기한',
          onChange: async (value) => {
            await setTaskDue(item.id, value);
            announce(value ? `기한을 ${uiKoDate(value)}로 정했어요` : '기한을 지웠어요');
          },
        }),
      },
      { field: '우선순위', control: taskPriorityControl(item) },
      { field: '프로젝트', control: taskProjectControl(item) },
    ],
    [{ label: '삭제', danger: true, onClick: () => removeTracked(item, card) }],
  ];
}

// ---------- 회의 정리 열기 ----------
// 회의 정리는 업무 상세와 같은 줄 옆 카드에서 연다(panelMeeting). 여기서는 레일의 미팅 줄이
// 가리키는 회의를 흐름 기록에서 찾아 넘기기만 한다. 아직 기록되지 않은 캘린더 회의는
// 회의 자체를 그대로 넘겨 "직접 담기"만 있는 패널을 띄운다.
function openMeetingPanel(event) {
  const recorded = workflowData.meetings.find(meeting => meeting.date === todayStr() && meeting.start === event.start && meeting.title === event.title);
  if (recorded) { panelOpen({ kind: 'meeting', id: recorded.id }); return; }
  panelOpen({ kind: 'meeting', event });
}

// ---------- 상세 (업무 · 확인 대기 · 회의 정리 한 벌) ----------
// 어디서 열든(오늘 목록·나중 목록·리마인드·검색·프로젝트·회의) 누른 줄 옆에 떠 있는 카드로 연다.
// 내용을 만드는 곳은 여기(panelTask·panelCheck·panelMeeting)이고, 어디에 붙일지는 아래 `줄 옆 카드`가 정한다.
// 저장 버튼은 없다 — 값이 바뀔 때 저장하고, 맨 아래에 "고치면 바로 저장돼요"라고 적는다.

let panelState = null;

// 아주 좁은 화면(≤520)의 아래 시트가 쓰는 자리. 오늘·프로젝트·회의 탭에 하나씩 있고, 연 탭의 자리를 끝까지 쓴다.
const PANEL_SIDE_ID = { projects: 'projectDetailPanel', meetings: 'meetingDetailPanel', today: 'taskDetailPanel' };
function panelSide() { return document.getElementById(PANEL_SIDE_ID[panelState?.host] || PANEL_SIDE_ID.today); }

// 업무 기록(tasks.md 등)과 흐름 기록(.workflow.json)은 다른 파일이다 — 둘 다 찾아 함께 넘긴다.
function panelResolve(id) {
  const detail = typeof wfItem === 'function' ? wfItem(id) : null;
  const item = itemsById.get(id) || detail;
  if (!item) return null;
  const type = detail?.type || 'task';
  return { item, detail, type, kind: type === 'check' ? 'check' : 'task' };
}

// 이 업무가 오늘 목록에 있는지 나중 목록에 있는지 — 패널의 이동 버튼이 달라진다.
function panelMode(item) {
  const lists = typeof taskListsCache === 'object' && taskListsCache ? taskListsCache : null;
  if (lists?.laterTasks?.some(entry => entry.id === item.id)) return 'later';
  if (lists?.todayTasks?.some(entry => entry.id === item.id)) return 'today';
  return item.scheduled ? 'today' : 'later';
}

// view: { id } 업무·확인 대기 상세 · { kind: 'meeting', id } 기록된 회의 · { kind: 'meeting', event } 아직 기록되지 않은 회의
function panelOpen(view) {
  if (!view) return;
  const kind = view.kind === 'meeting' ? 'meeting' : 'item';
  if (kind === 'item' && (view.id === undefined || view.id === null)) return;
  if (kind === 'meeting' && !view.id && !view.event) return;
  // 열려 있는 줄을 다시 누르면 닫힌다(카드일 때만 — 아래 시트는 예전 그대로 바뀌어 열린다).
  if (!detailSheet() && panelState && panelState.kind === kind && (kind === 'meeting'
    ? (view.id ? panelState.id === view.id : panelMeetingKey(panelState.event) === panelMeetingKey(view.event))
    : panelState.id === view.id)) { panelClose(); return; }
  // 카드는 떠 있으므로 보던 탭 그대로 연다. 시트가 쓰는 자리는 오늘·프로젝트·회의 탭에만 있다.
  if (detailSheet() && typeof setActiveTab === 'function' && !PANEL_SIDE_ID[activeTabKey]) setActiveTab('today');
  const host = PANEL_SIDE_ID[activeTabKey] ? activeTabKey : 'today';
  if (!document.getElementById(PANEL_SIDE_ID[host])) return;
  const opener = document.activeElement;
  panelState = {
    host,
    kind,
    id: view.id || null,
    // 아직 흐름 기록에 없는 캘린더 회의는 연 그대로 들고 있는다(찾을 곳이 없다).
    event: view.event || null,
    // 회의에서 초안을 담은 직후의 결과 카드. 회의 → 항목 → 회의로 돌아와도 그대로 남는다.
    result: view.result || null,
    // 팔레트에서 열었으면 닫을 때 그 검색어·필터·스크롤 그대로 팔레트로 돌아간다.
    // 회의에서 연 항목이면 { kind: 'meeting', … }이 들어와 맨 위에 `← 회의로`가 붙는다.
    back: view.back || null,
    returnFocus: opener && opener !== document.body && opener.focus ? opener : null,
    // 누른 줄이 어느 목록에 있었는지 — 같은 항목이 여러 목록에 보일 때 그 자리에 카드를 붙인다.
    anchorHost: detailRowHostId(detailRowMatches(detailLastRow, view, kind) ? detailLastRow : null),
  };
  // Esc는 가장 위에 열린 것부터 닫는다 — 다시 열면 맨 위로 올린다.
  escDrop(panelClose);
  escPush(panelClose);
  panelRender(true);
}

function panelClose() {
  const side = panelSide();
  const back = panelState?.returnFocus;
  let reopen = panelState?.back;
  panelState = null;
  escDrop(panelClose);
  detailUnmount(); // 떠 있는 카드와 거기 붙은 스크롤·크기 감시를 함께 거둔다
  document.querySelectorAll('.is-sel[data-task-id], .d-wrow.is-sel, .d-mrow.is-sel').forEach(row => row.classList.remove('is-sel'));
  if (side) { side.hidden = true; side.replaceChildren(); }
  // 팔레트에서 열었던 항목이면 찾던 자리로 돌려 놓는다(포커스도 검색 입력으로).
  // 팔레트 → 회의 → 항목처럼 거쳐 왔어도 처음 찾던 자리로 돌아간다.
  while (reopen && reopen.kind === 'meeting') reopen = reopen.back;
  if (reopen && reopen.kind === 'palette') { palOpen(reopen.state); return; }
  if (back && back.isConnected) back.focus();
}

// 지금 보고 있는 줄을 찾는 표식 — 업무·확인 대기는 항목 번호, 회의는 레일의 미팅 줄.
function panelAnchorSelector() {
  if (!panelState) return '[data-task-id="__none__"]';
  if (panelState.kind === 'meeting') return `.d-mrow[data-meeting-id="${CSS.escape(String(panelMeetingKey(panelMeetingEvent()) || ''))}"]`;
  return `[data-task-id="${CSS.escape(String(panelState.id))}"]`;
}

// 내용을 만들어 지금 자리(줄 옆 카드 · 좁은 화면의 아래 시트)에 붙인다.
// 누른 줄은 선택 강조로 표시한다. 붙을 줄이 사라졌으면(완료·이동) 카드도 함께 닫힌다.
function panelRender(focusFirst = false) {
  if (!panelState) return;
  const meeting = panelState.kind === 'meeting' ? panelMeetingEvent() : null;
  const found = panelState.kind === 'meeting' ? null : panelResolve(panelState.id);
  if (!meeting && !found) { panelClose(); return; }
  const box = document.createElement('div');
  box.className = 'd-detail';
  if (meeting) panelMeeting(meeting, box);
  else if (found.kind === 'check') panelCheck(found, box);
  else panelTask(found, box);
  if (detailSheet()) { if (!panelSheetMount(box, focusFirst)) return; }
  else if (!detailPopMount(box, focusFirst)) { panelClose(); return; }
  const marked = panelState.kind === 'meeting'
    ? panelAnchorSelector()
    : `[data-task-id="${CSS.escape(String(panelState.id))}"], .d-wrow[data-rail-id="${CSS.escape(String(panelState.id))}"]`;
  document.querySelectorAll('.is-sel[data-task-id], .d-wrow.is-sel, .d-mrow.is-sel').forEach(row => row.classList.remove('is-sel'));
  document.querySelectorAll(marked).forEach(row => row.classList.add('is-sel'));
}

// 아주 좁은 화면에서는 예전처럼 아래에서 올라오는 시트로 연다(손가락이 닿는 자리).
function panelSheetMount(box, focusFirst) {
  const side = panelSide();
  if (!side) return false;
  detailUnmount();
  side.hidden = false;
  side.replaceChildren(box);
  if (focusFirst) panelFocusFirst(box);
  return true;
}

// 열면 고칠 곳으로 바로 간다 — 업무·확인 대기는 제목, 회의는 검토할 초안이 없을 때만 직접 담기 입력.
function panelFocusFirst(box) {
  const first = panelState?.kind === 'meeting' ? (box.querySelector('.d-dcap input') || box) : box.querySelector('.d-dtitle');
  first?.focus?.();
}

// 지금 떠 있는 상세 안에서 찾는다(카드 또는 좁은 화면의 시트).
function panelDetailBox() {
  return (detailPopHost && detailPopHost.querySelector('.d-detail')) || panelSide()?.querySelector('.d-detail') || null;
}

// load()가 끝날 때마다 불린다. 패널 안에서 타이핑하는 중이면 다시 그리지 않는다
// (적던 글·고치던 초안 문구가 날아가지 않게. 고친 초안은 wfDraftEdits에도 남는다).
function syncTaskDetail() {
  if (!panelState) return;
  if (panelState.kind !== 'meeting' && !panelResolve(panelState.id)) { panelClose(); return; }
  const box = panelDetailBox();
  if (box && isTyping() && box.contains(document.activeElement)) return;
  panelRender();
}

// 회의에서 연 항목이면 맨 위에 `← 회의로`. 회의 패널로 돌아갈 때 결과 카드와 그 위의 자리(팔레트)를 그대로 들고 간다.
function panelBackLink(box) {
  const back = panelState?.back;
  if (!back || back.kind !== 'meeting') return;
  const link = document.createElement('button');
  link.type = 'button';
  link.className = 'd-back';
  link.textContent = '← 회의로';
  link.addEventListener('click', () => panelOpen({ kind: 'meeting', id: back.id, event: back.event, result: back.result, back: back.back }));
  box.appendChild(link);
}

// 원문이 있으면 제목 바로 아래에 `슬랙 원문 열기` 한 줄(줄의 `원문` 링크와 같은 곳으로 간다).
function panelSourceLine(item, box) {
  const link = uiSourceLink(item, '슬랙 원문 열기');
  if (!link) return;
  link.classList.add('d-dsrc');
  box.appendChild(link);
}

// 제목 줄: 제목(누르면 그 자리 수정) + 더보기 + 닫기.
function panelHead(item, sections) {
  const top = document.createElement('div');
  top.className = 'd-dtop';
  const title = document.createElement('div');
  title.className = 'd-dtitle';
  title.textContent = item.description;
  title.tabIndex = 0;
  title.setAttribute('role', 'button');
  title.setAttribute('aria-label', `${item.description} — 눌러서 제목 수정`);
  const edit = () => panelTitleEdit(title, item);
  title.addEventListener('click', edit);
  title.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); edit(); }
  });
  top.appendChild(title);
  if (sections) top.appendChild(uiMoreButton(`${item.description} — 더 보기`, sections, 'd-iconbtn'));
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'd-iconbtn';
  close.setAttribute('aria-label', '상세 닫기');
  close.innerHTML = uiIcon('close');
  close.addEventListener('click', panelClose);
  top.appendChild(close);
  return top;
}

// 제목을 그 자리에서 고친다. Enter 저장 / Esc 취소 / 한글 조합 중 Enter는 넘긴다.
// 저장에 실패하면 적은 글자를 지우지 않고 그대로 두어 다시 시도하게 한다.
function panelTitleEdit(titleEl, item) {
  const area = document.createElement('textarea');
  area.className = 'd-dtitle';
  area.rows = 2;
  area.value = item.description;
  area.maxLength = 1000;
  area.setAttribute('aria-label', '제목');
  titleEl.replaceWith(area);
  area.focus();
  area.setSelectionRange?.(area.value.length, area.value.length);
  let settled = false;
  const cancel = () => {
    if (settled) return;
    settled = true;
    area.replaceWith(titleEl);
    titleEl.focus();
  };
  const commit = async () => {
    if (settled) return;
    const value = area.value.replace(/[\r\n]+/g, ' ').trim();
    if (!value || value === item.description) { cancel(); return; }
    settled = true;
    area.disabled = true;
    try {
      await postJson('/api/track/set-description', { id: item.id, description: value });
      await load();
    } catch {
      settled = false;
      area.disabled = false;
      area.focus();
    }
  };
  area.addEventListener('blur', commit);
  area.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); cancel(); return; }
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); area.blur(); }
  });
}

function panelField(dl, label, value) {
  const term = document.createElement('dt');
  term.textContent = label;
  const cell = document.createElement('dd');
  if (typeof value === 'string') cell.textContent = value;
  else if (value) cell.appendChild(value);
  dl.append(term, cell);
  return cell;
}

// 날짜 한 칸: 값이 있으면 `오늘까지` 같은 말투를 같이 적고, 비어 있으면 `없음` + `+ 기한`.
// `까지`는 기한에만 쓴다 — 다시 확인할 날짜처럼 기한이 아닌 날짜는 날짜만 적는다.
function panelDateCell(label, value, onChange, deadline = true) {
  const wrap = document.createElement('span');
  wrap.className = 'd-dvalue';
  const detail = deadline ? uiDueDetail(value) : value ? { text: uiKoDate(value), tone: '' } : null;
  if (detail) {
    // 날짜 입력칸은 브라우저 말투로 날짜를 적는다 — 한국어 날짜와 의미는 옆에 글자로 따로 적는다.
    const note = document.createElement('span');
    note.className = uiTone(detail.tone).trim() || 'k-mute';
    note.textContent = detail.text;
    wrap.appendChild(note);
  }
  if (!value) {
    const none = document.createElement('span');
    none.className = 'k-mute';
    none.textContent = '없음';
    wrap.appendChild(none);
  }
  wrap.appendChild(uiDateField({ value, label, onChange }));
  return wrap;
}

// 상세의 값은 읽기만 하는 글자가 아니다 — 눌러서 그 자리에서 고친다.
// 값 + 꺾쇠를 누르면 줄의 ⋯와 같은 고르개(uiMenu)가 붙는다. 저장 길도 줄과 똑같다.
function panelPickCell(label, content, sections) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'd-dpick';
  button.setAttribute('aria-haspopup', 'true');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-label', `${label} — 눌러서 바꾸기`);
  const value = document.createElement('span');
  value.className = 'v';
  if (typeof content === 'string') value.textContent = content;
  else if (content) value.appendChild(content);
  const caret = document.createElement('span');
  caret.className = 'cv';
  caret.innerHTML = uiIcon('chevron');
  button.append(value, caret);
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    uiMenu(button, typeof sections === 'function' ? sections() : sections);
  });
  return button;
}

function panelSection(title) {
  const section = document.createElement('div');
  section.className = 'd-dsec';
  section.dataset.sec = title; // 카드가 구역별로 손보는 자리를 찾는 이름표(결과 한 줄 · 확인 요청 기록)
  const label = document.createElement('span');
  label.className = 'lbl';
  label.textContent = title;
  section.appendChild(label);
  return section;
}

function panelAutosaveNote(box) {
  const note = document.createElement('div');
  note.className = 'd-autosave';
  note.textContent = '고치면 바로 저장돼요';
  box.appendChild(note);
}

function panelQuietButton(text, onClick, className = 'd-btn') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = text;
  button.addEventListener('click', async () => {
    button.disabled = true;
    try { await onClick(); } finally { if (button.isConnected) button.disabled = false; }
  });
  return button;
}

// 저장 버튼이 없는 대신, 처음 값과 달라진 칸만 모아 보낸다.
// 손대지 않은 칸까지 함께 보내면 그 사이 다른 곳에서 바뀐 값을 조용히 덮어쓴다.
function panelFieldChanges(id, initial, current) {
  const changes = { id };
  if ('blockedBy' in current && current.blockedBy !== initial.blockedBy) changes.blockedBy = current.blockedBy || null;
  if ('outcome' in current && current.outcome !== initial.outcome) changes.outcome = (current.outcome || '').trim();
  if ('followUp' in current && current.followUp !== initial.followUp) changes.followUp = current.followUp || null;
  return changes;
}

async function panelFieldSave(id, initial, current) {
  const changes = panelFieldChanges(id, initial, current);
  if (Object.keys(changes).length < 2) return false;
  await postJson('/api/workflow/item', changes);
  Object.assign(initial, current);
  return true;
}

function panelTask({ item, detail, type }, box) {
  const done = item.status === 'done';
  const mode = panelMode(item);
  const isTask = ['task', 'bug'].includes(type);

  panelBackLink(box);
  box.appendChild(panelHead(item, () => {
    const actions = [];
    if (isTask) actions.push({ label: item.doing ? '진행 중 해제' : '진행 중으로 표시', onClick: () => setTaskDoing(item.id, !item.doing) });
    // 원문 열기는 제목 아래 링크가 늘 보여 주므로 메뉴에는 복사만 남긴다.
    if (item.permalink) actions.push({ label: '원본 링크 복사', onClick: () => panelCopyLink(item.permalink) });
    // 동작 줄은 한 줄로 둔다 — 자주 쓰지 않는 이동은 메뉴로 내린다.
    const goProject = typeof wfKey === 'function' ? wfKey(item) : null;
    if (goProject) actions.push({ label: '프로젝트 보기', onClick: () => openProjectTab(goProject) });
    return [actions, [{
      label: '삭제',
      danger: true,
      onClick: async () => {
        panelClose();
        await postJson('/api/track/remove', { id: item.id });
        await load();
        announce('삭제했어요');
      },
    }]];
  }));
  panelSourceLine(item, box);

  const fields = document.createElement('dl');
  fields.className = 'd-fields';
  // 값은 눌러서 바로 고친다 — 줄의 ⋯ 메뉴와 같은 고르개·같은 저장 길이다(완료한 업무는 옮길 일이 없다).
  // 결정·아이디어에는 `언제 할지`·`우선순위`가 없다 — 없는 값을 보여 주지 않는다(값이 보이면 바꿀 수 있어야 한다).
  if (isTask) panelField(fields, '언제 할지', !done
    ? panelPickCell('언제 할지', panelWhenText(item, mode), () => [[{ field: '언제 할지', control: taskWhenControl(item, mode, null) }]])
    : panelWhenText(item, mode));
  if (isTask) panelField(fields, '기한', panelDateCell('기한', item.due, async (value) => {
    await setTaskDue(item.id, value);
    announce(value ? `기한을 ${uiKoDate(value)}로 정했어요` : '기한을 지웠어요');
  }));
  if (isTask) panelField(fields, '우선순위', panelPickCell('우선순위', panelPriorityCell(item),
    () => [[{ field: '우선순위', control: taskPriorityControl(item) }]]));
  panelField(fields, '프로젝트', taskProjectControl(item));
  box.appendChild(fields);

  const foot = document.createElement('div');
  foot.className = 'd-dfoot';
  const finishLabel = type === 'decision' ? 'PRD 반영 완료' : '완료로 표시';
  if (done) foot.appendChild(panelQuietButton('완료 취소', async () => { await toggleTask(item.id); }));
  else foot.appendChild(panelQuietButton(finishLabel, async () => {
    await toggleTask(item.id);
    panelClose();
    if (isTask) workflowOutcome(item);
  }, 'd-btn pri'));
  if (!done && isTask) {
    if (mode === 'later') foot.appendChild(panelQuietButton('오늘로', async () => {
      await setTaskScheduled(item.id, todayStr());
      announce('오늘 할 일로 옮겼어요');
    }));
    else {
      foot.appendChild(panelQuietButton('내일', async () => {
        await setTaskScheduled(item.id, tomorrowStr());
        announce('내일로 미뤘어요');
      }));
      foot.appendChild(panelQuietButton('나중에', async () => {
        await setTaskScheduled(item.id, null);
        announce('나중에 할 일로 옮겼어요 · 기한은 그대로예요');
      }));
    }
  }
  box.appendChild(foot);

  if (isTask) panelTaskNotes(item, detail, box);
  if (detail?.meetingId) {
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'd-link';
    link.textContent = '이 항목이 나온 회의';
    // 같은 패널에서 그 회의를 연다. 팔레트에서 왔다면 닫을 때 돌아갈 자리는 그대로 들고 간다.
    link.addEventListener('click', () => panelOpen({ kind: 'meeting', id: detail.meetingId, back: panelState?.back }));
    box.appendChild(link);
  }
  panelAutosaveNote(box);
}

// 언제 할지: `오늘` / `내일 · 9월 22일 (화)` / `어제부터 · 9월 20일 (일)` / `나중에` / `완료 · 9월 20일 (일)`
// 밀린 업무를 `오늘`이라고 적으면 목록의 `어제부터`와 말이 어긋난다 — 같은 uiCarryText를 쓴다.
function panelWhenText(item, mode) {
  if (item.status === 'done') return item.completed ? `완료 · ${uiKoDate(item.completed)}` : '완료';
  if (mode === 'later' && !item.scheduled) return '나중에';
  const scheduled = item.scheduled || todayStr();
  const carry = uiCarryText(scheduled);
  if (carry) return `${carry} · ${uiKoDate(scheduled)}`;
  const diff = diffDays(scheduled);
  if (Number.isNaN(diff)) return uiKoDate(scheduled);
  if (diff === 0) return '오늘';
  if (diff === 1) return `내일 · ${uiKoDate(scheduled)}`;
  return uiKoDate(scheduled);
}

// 값을 확인하는 자리이므로 `보통`·`낮음`도 적는다(다만 조용하게). 목록에는 여전히 찍지 않는다.
function panelPriorityCell(item) {
  const cell = document.createElement('span');
  const meta = UI_PRIORITY_META[item.priority];
  if (meta) {
    cell.className = uiTone(meta.tone).trim();
    cell.title = meta.hint;
    cell.textContent = meta.text;
  } else {
    cell.className = 'k-mute';
    cell.textContent = item.priority === 'low' ? '낮음' : '보통';
  }
  return cell;
}

function panelCopyLink(permalink) {
  const done = () => announce('원본 링크를 복사했어요');
  try {
    const copy = navigator.clipboard?.writeText(permalink);
    if (copy && copy.then) copy.then(done, () => announce('복사하지 못했어요. 링크를 길게 눌러 복사해 주세요'));
    else done();
  } catch { announce('복사하지 못했어요. 링크를 길게 눌러 복사해 주세요'); }
}

// `기다리는 답변`과 `결과 한 줄`은 기본으로 펼쳐 둔다(접어 두면 아무도 적지 않았다).
function panelTaskNotes(item, detail, box) {
  const current = { blockedBy: detail?.blockedBy || '', outcome: detail?.outcome || '' };
  const initial = { ...current };
  const save = async () => {
    try {
      if (await panelFieldSave(item.id, initial, current)) await load();
    } catch { /* 저장 실패는 request()가 알린다 — 적은 내용은 그대로 둔다 */ }
  };

  const waiting = panelSection('기다리는 답변');
  const checks = (typeof workflowData === 'object' && workflowData ? workflowData.items : [])
    .filter(check => check.type === 'check' && (check.status !== 'done' || check.id === current.blockedBy));
  const select = document.createElement('select');
  select.className = 'd-msel wide';
  select.setAttribute('aria-label', '기다리는 답변');
  [['', '연결 없음'], ...checks.map(check => [check.id, `${check.status === 'done' ? '해결됨 · ' : ''}${check.description}`])]
    .forEach(([value, text]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      if (value === current.blockedBy) option.selected = true;
      select.appendChild(option);
    });
  select.addEventListener('change', () => { current.blockedBy = select.value; save(); });
  waiting.appendChild(select);
  if (current.blockedBy && !checks.some(check => check.id === current.blockedBy)) {
    const gone = document.createElement('div');
    gone.className = 'd-hint';
    gone.textContent = '연결했던 확인 대기가 삭제됐어요.';
    waiting.appendChild(gone);
  }
  box.appendChild(waiting);

  box.appendChild(panelOutcomeSection('결과 한 줄', '끝나고 한 줄로 남기면 주간요약에 그대로 올라가요', current, save));
}

// 업무의 `결과 한 줄`과 확인 대기의 `답변 한 줄`은 같은 부품·같은 저장 길(outcome)을 쓴다.
function panelOutcomeSection(label, placeholder, current, save) {
  const section = panelSection(label);
  const area = document.createElement('textarea');
  area.className = 'd-din';
  area.rows = 2;
  area.maxLength = 1000;
  area.value = current.outcome;
  area.placeholder = placeholder;
  area.setAttribute('aria-label', label);
  area.addEventListener('change', () => { current.outcome = area.value.replace(/[\r\n]+/g, ' ').trim(); save(); });
  section.appendChild(area);
  return section;
}

function panelCheck({ item, detail }, box) {
  const done = item.status === 'done';
  panelBackLink(box);
  box.appendChild(panelHead(item, () => waitingMenuSections(item, box)));
  panelSourceLine(item, box);

  const fields = document.createElement('dl');
  fields.className = 'd-fields';
  panelField(fields, '누구에게', uiMenuText({
    value: item.who,
    label: '누구에게',
    placeholder: '이름',
    onChange: (who) => setTaskWho(item.id, who),
  }));
  // 확인 대기의 기한은 "상대에게 답을 받기로 한 날"이다 — 화면 이름을 그렇게 적는다.
  panelField(fields, '답변 받을 날', panelDateCell('답변 받을 날', item.due, async (value) => {
    await setTaskDue(item.id, value);
    announce(value ? `답변 받을 날을 ${uiKoDate(value)}로 정했어요` : '답변 받을 날을 지웠어요');
  }));
  panelField(fields, '다시 확인할 날짜', panelDateCell('다시 확인할 날짜', detail?.followUp, async (value) => {
    await postJson('/api/workflow/item', { id: item.id, followUp: value });
    announce(value ? `${uiKoDate(value)}에 다시 확인할게요` : '다시 확인할 날짜를 지웠어요');
    await load();
  }, false));
  panelField(fields, '프로젝트', taskProjectControl(item));
  box.appendChild(fields);

  const foot = document.createElement('div');
  foot.className = 'd-dfoot';
  if (done) foot.appendChild(panelQuietButton('대기중으로 되돌리기', async () => { waitingNextClose(); await toggleTask(item.id); }));
  else foot.appendChild(panelQuietButton('확인됨으로 표시', async () => {
    // 목록으로 돌아가면 그 줄에서 `다음은?`이 이어진다 — 알림은 저장됐다는 사실만 알린다.
    waitingNextOpen(item);
    await toggleTask(item.id);
    panelClose();
    announce('확인 완료로 표시했어요');
  }, 'd-btn pri'));
  // 확인이 끝난 내용을 남길지는 늘 고를 수 있어야 한다(알림이 사라진 뒤에도).
  foot.appendChild(panelQuietButton('결정으로 남기기', () => createDecisionFromWaiting(item)));
  box.appendChild(foot);

  // 답을 받은 뒤에만 적을 것이 생긴다 — 업무의 `결과 한 줄`과 같은 부품·같은 저장 길(outcome)이다.
  if (done) {
    const current = { outcome: detail?.outcome || '' };
    const initial = { ...current };
    const save = async () => {
      try { if (await panelFieldSave(item.id, initial, current)) await load(); }
      catch { /* 저장 실패는 request()가 알린다 — 적은 내용은 그대로 둔다 */ }
    };
    box.appendChild(panelOutcomeSection('답변 한 줄', WAITING_ANSWER_PLACEHOLDER, current, save));
  }

  const log = panelSection('확인 요청 기록');
  const line = document.createElement('div');
  line.className = detail?.contacted ? 'd-logline' : 'd-hint';
  line.textContent = detail?.contacted ? `${uiKoDate(detail.contacted)} 요청함` : '아직 요청한 기록이 없어요.';
  log.appendChild(line);
  log.appendChild(panelQuietButton('오늘 확인 요청함', () => markContactedToday(item), 'd-btn sm'));
  box.appendChild(log);

  panelAutosaveNote(box);
}

// ---------- 회의 정리 패널 ----------
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

function meetingNotesApplyButton(entry) {
  const mine = meetingNotesRunningKey() === entry.key;
  entry.el.textContent = mine ? '가져오는 중…' : entry.label;
  entry.el.disabled = meetingNotesBusy();
  entry.el.setAttribute('aria-busy', String(mine));
}
function meetingNotesSyncButtons() {
  [...meetingNotesButtons].forEach((entry) => {
    if (entry.el.isConnected === false) { meetingNotesButtons.delete(entry); return; }
    meetingNotesApplyButton(entry);
  });
}
// target: 'today' 또는 회의 하나. 두 버튼이 같은 길을 쓴다.
function meetingNotesButton(label, target, className = 'd-btn sm') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  const entry = {
    el: button, label,
    scope: target === 'today' ? 'today' : 'meeting',
    meeting: target === 'today' ? null : target,
    key: target === 'today' ? 'today' : meetingNotesEventKey(target),
  };
  button.addEventListener('click', () => meetingNotesStart(entry.scope, entry.meeting));
  meetingNotesButtons.add(entry);
  meetingNotesApplyButton(entry);
  return button;
}

// scope: 'today'(오늘 것 모두) 또는 'meeting'(그 회의 하나). 버튼과 메뉴 항목이 같은 길을 쓴다.
async function meetingNotesStart(scope, event) {
  if (meetingNotesBusy()) return;
  const meeting = scope === 'meeting' && event
    ? { date: event.date, start: event.start, end: event.end || '', title: event.title }
    : null;
  const body = meeting ? { scope: 'meeting', meeting } : { scope: 'today' };
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
    showNotice('미팅 노트를 가져오지 못했어요', true, null,
      { label: '자세히', onClick: () => { if (typeof settingsOpen === 'function') settingsOpen('status', 'tiro'); } });
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
  const summary = meetingNotesSummary(status.summary);
  showNotice(summary ? `미팅 노트를 가져왔어요 · ${summary}` : '미팅 노트를 가져왔어요');
}

// 버튼 옆 조용한 한 줄. 오늘 가져온 기록이 있을 때만 — 어제 것은 알려 줄 필요가 없다.
function meetingNotesLastText() {
  const at = meetingNotesState.lastRunAt || '';
  if (!at.startsWith(todayStr()) || meetingNotesState.lastKind !== 'run') return '';
  return `오늘 ${at.slice(11, 16)}에 가져왔어요`;
}

// 업무 상세와 같은 자리에서 회의를 정리한다: 결과 카드 → AI 초안 검토 → 이 회의에서 나온 것 →
// 이전 회차의 미해결 항목 → 직접 적어 담기 → 기존 항목 연결. 내용이 없는 구역은 아예 두지 않는다.
// 프로젝트·반복 회의 입력은 두지 않는다(DECISIONS 화면) — 프로젝트는 오늘 미팅 줄의 더보기에서 바꾼다.

// 아직 흐름 기록에 없는 회의(캘린더에만 있는 회의)에서 직접 담을 때 쓰는 길.
const MEETING_CAPTURE_ENDPOINT = { task: '/api/today-task/create', check: '/api/waiting/create', decision: '/api/decision/create' };

// 패널이 보고 있는 회의. 기록된 회의는 늘 최신 자료에서 다시 찾는다(초안·항목이 바뀌므로).
function panelMeetingEvent() {
  if (!panelState || panelState.kind !== 'meeting') return null;
  const meetings = (typeof workflowData === 'object' && workflowData ? workflowData.meetings : null) || [];
  if (panelState.id) return meetings.find(event => event.id === panelState.id) || null;
  return panelState.event || null;
}

// 레일의 미팅 줄을 찾는 표식. 기록 전 회의는 번호가 없으니 시각·제목으로 찾는다.
const panelMeetingKey = event => event ? (event.id || `${event.start || ''} ${event.title || ''}`) : '';

// 조용한 한 줄: `오늘 16:00–17:00 · 운영툴`
function panelMeetingWhen(event) {
  const day = !event.date || event.date === todayStr() ? '오늘' : uiKoDate(event.date);
  const time = `${event.start || ''}${event.end ? `–${event.end}` : ''}`;
  return [[day, time].filter(Boolean).join(' '), wfMeetingProjectName(event)].filter(Boolean).join(' · ');
}

/* 회의 정리 내용은 한 벌이고 자리만 둘이다:
   (가) 누른 줄 옆에 떠 있는 카드 — 레일·프로젝트 탭의 회의 줄에서 연다.
   (나) `회의` 탭의 오른쪽 자리 — 왼쪽 목록에서 고른 회의를 페이지 안에 넓게 그린다.
   아래 함수들은 이 `host`로 "결과 카드를 어디에 두는가 · 무엇을 다시 그리는가 · 오류를 어느 카드에 적는가 ·
   닫기가 있는가 · 항목·다음 회의를 어떻게 여는가"만 다르게 하고, 내용은 같은 함수가 만든다.
   고쳐 둔 초안 문구(wfDraftEdits)는 회의 키로 기억하는 한 저장소를 두 자리가 그대로 나눠 쓴다. */
const MEETING_HOST_CARD = {
  kind: 'card',
  closable: true,
  getResult: () => (panelState && panelState.kind === 'meeting' ? panelState.result : null) || null,
  setResult: (value) => { if (panelState) panelState.result = value; },
  redraw: () => panelRender(),
  box: () => panelDetailBox(),
  // 회의에서 연 항목은 같은 카드에서 열고 맨 위에 `← 회의로`가 붙는다.
  openItem: (item, event) => panelOpen({
    id: item.id,
    back: { kind: 'meeting', id: event.id, event: event.id ? null : event, result: panelState?.result, back: panelState?.back },
  }),
  openMeeting: (id) => panelOpen({ kind: 'meeting', id, back: panelState?.back }),
};
const MEETING_HOST_TAB = {
  kind: 'tab',
  closable: false,
  getResult: () => meetingsTabState.result || null,
  setResult: (value) => { meetingsTabState.result = value; },
  redraw: () => renderMeetings(),
  box: () => document.getElementById('meetingBody')?.querySelector('.d-detail') || null,
  // 회의 정리 화면이 뒤에 그대로 남아 있으므로 `← 회의로`를 붙이지 않는다 — 누른 줄 옆에 상세 카드만 뜬다.
  openItem: (item) => panelOpen({ id: item.id }),
  openMeeting: (id) => { meetingsTabSelect(id); renderMeetings(); },
};

// 상세 안에서 저장이 실패한 자리를 그 자리에 적는다(알림은 request가 따로 띄운다).
function panelSetError(text, host) {
  const region = (host || MEETING_HOST_CARD).box()?.querySelector('.d-derr');
  if (region) region.textContent = text || '';
}

// 누르면 도는 버튼 — 도는 동안 꺼지고, 실패하면 패널 안에 이유를 적는다.
function panelRunButton(text, action, className = 'd-btn', host) {
  return panelQuietButton(text, async () => {
    panelSetError('', host);
    try { await action(); } catch (error) {
      panelSetError((typeof error?.message === 'string' && error.message) || '저장하지 못했어요. 내용을 확인한 뒤 다시 시도해 주세요.', host);
    }
  }, className);
}

function panelMeeting(event, box, host = MEETING_HOST_CARD) {
  // 흐름 기록에 있는 회의여야 초안·항목·연결을 다룰 수 있다.
  const linked = !!event.id;
  box.tabIndex = -1;

  const top = document.createElement('div');
  top.className = 'd-dtop';
  const head = document.createElement('div');
  head.className = 'd-dhead2';
  const title = document.createElement('div');
  title.className = 'd-dtitle plain';
  title.textContent = event.title;
  const when = document.createElement('div');
  when.className = 'd-dsub';
  when.textContent = panelMeetingWhen(event);
  (event.tiroNotes || []).forEach((url, index) => {
    const note = document.createElement('a');
    note.className = 'd-link';
    note.href = url;
    note.target = '_blank';
    note.rel = 'noopener';
    note.textContent = (event.tiroNotes.length > 1) ? `미팅 노트 ${index + 1}` : '미팅 노트';
    when.append(' · ', note);
  });
  head.append(title, when);
  // 업무 상세 카드 머리(panelHead)와 같은 자리·같은 모양 — ✕ 왼쪽에 더보기.
  // 메뉴는 레일의 회의 줄 ⋯가 여는 메뉴 그대로다(회의용으로 새로 만들지 않는다).
  // 이미 열려 있는 자리라 `회의 정리 열기`는 빼고, 회의 탭에서는 `회의 탭에서 열기`도 뺀다.
  const more = uiMoreButton(`${event.title} — 더 보기`,
    () => meetingMenuSections(event, { open: false, toTab: host.kind !== 'tab' }), 'd-iconbtn');
  top.append(head, more);
  // 회의 탭의 자리에는 닫기가 없다 — 닫을 것이 아니라 그 탭의 본문이다.
  if (host.closable) {
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'd-iconbtn';
    close.setAttribute('aria-label', '회의 정리 닫기');
    close.innerHTML = uiIcon('close');
    close.addEventListener('click', panelClose);
    top.appendChild(close);
  }
  box.appendChild(top);

  const error = document.createElement('p');
  error.className = 'd-derr';
  error.setAttribute('role', 'alert');
  box.appendChild(error);

  // 이 회의의 미팅 노트를 아직 안 가져왔으면 머리 아래 조용한 버튼 하나(지난 회의에서도 된다).
  if (meetingNotesCanFetch(event)) {
    const get = document.createElement('div');
    get.className = 'd-dget';
    get.appendChild(meetingNotesButton('이 회의의 미팅 노트 가져오기', event));
    box.appendChild(get);
  }

  if (!linked) {
    const note = document.createElement('div');
    note.className = 'd-hint';
    note.textContent = '아직 기록되지 않은 회의예요. 여기서 적은 것은 회의에 연결되지 않고 바로 담겨요.';
    box.appendChild(note);
  }
  if (linked) {
    panelMeetingResult(event, box, host);
    if (event.drafts && event.drafts.length) panelMeetingDrafts(event, box, host);
    panelMeetingItems(event, box, host);
    panelMeetingPast(event, box, host);
  }
  panelMeetingCapture(event, box, linked, host);
  if (linked) panelMeetingLink(event, box, host);
}

// 방금 초안을 담은 결과: 어디로 갔는지, 나중에 담긴 할 일을 오늘로, 되돌리기, 다음 검토할 회의.
function panelMeetingResult(event, box, host = MEETING_HOST_CARD) {
  const result = host.getResult();
  if (!result || result.meetingId !== event.id) return;
  const card = document.createElement('div');
  card.className = 'd-dres';
  card.setAttribute('role', 'status');

  const head = document.createElement('div');
  head.className = 'hd';
  const done = document.createElement('strong');
  done.className = 'k-pos';
  done.textContent = `✓ ${result.created.length}개 담음`;
  const counts = document.createElement('span');
  counts.className = 'ct';
  counts.textContent = WF_TYPES
    .map(([type, label]) => [label, result.accepted.filter(item => item.type === type).length])
    .filter(([, count]) => count).map(([label, count]) => `${label} ${count}`).join(' · ');
  head.append(done, counts);
  head.appendChild(panelRunButton('실행 취소', async () => {
    const undo = await wfPost('review-undo', { meetingId: event.id, created: result.created });
    if (!undo.ok) throw new Error(undo.error || '되돌리지 못했어요.');
    // 되돌린 초안은 검토 대기로 돌아온다 — 사람이 고쳐 둔 문구·종류·날짜는 그대로 살려 둔다.
    result.accepted.forEach(item => wfDraftEdits.set(item.id, { type: item.type, description: item.description, when: item.when || 'later', due: item.due || '' }));
    host.setResult(null);
    await load();
    host.redraw();
    announce('담은 것을 되돌렸어요');
  }, 'd-btn sm', host));
  card.appendChild(head);

  // 할 일은 기본이 "나중"으로 담기니 이 자리에서 바로 오늘로 올릴 수 있게 한다. 셋까지는 줄마다, 그 이상은 한 줄로 묶는다.
  const tasks = wfResultTasks(result);
  const later = tasks.filter(task => !task.today);
  const taskRow = (text, action) => {
    const row = document.createElement('div');
    row.className = 'tk';
    const label = document.createElement('span');
    label.className = 'ti';
    label.textContent = text;
    row.append(label, action);
    card.appendChild(row);
  };
  const doneNote = () => {
    const note = document.createElement('span');
    note.className = 'k-mute';
    note.textContent = '오늘 할 일 ✓';
    return note;
  };
  if (tasks.length && tasks.length <= 3) {
    tasks.forEach(task => taskRow(task.description, task.today
      ? doneNote()
      : panelRunButton('오늘로', () => panelPromoteTasks(result, [task.itemId], host), 'd-btn sm', host)));
  } else if (tasks.length) {
    taskRow(later.length ? `나중에 담긴 할 일 ${later.length}개` : `할 일 ${tasks.length}개`, later.length
      ? panelRunButton('모두 오늘로', () => panelPromoteTasks(result, later.map(task => task.itemId), host), 'd-btn sm', host)
      : doneNote());
  }

  const next = wfNextReview(event.id);
  const foot = document.createElement('div');
  foot.className = 'nx';
  if (next) foot.appendChild(panelRunButton(`다음: ${next.title} (초안 ${next.drafts.length}) →`,
    () => host.openMeeting(next.id), 'd-link', host));
  else {
    const all = document.createElement('span');
    all.className = 'k-mute';
    all.textContent = '오늘 검토할 초안을 모두 처리했어요.';
    foot.appendChild(all);
  }
  card.appendChild(foot);
  box.appendChild(card);
}

// 나중에 담긴 할 일을 오늘 할 일로 올린다(패널이 결과를 보여 주니 저장 알림은 끈다).
async function panelPromoteTasks(result, ids, host = MEETING_HOST_CARD) {
  for (const itemId of ids) {
    await request('/api/track/set-scheduled', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: itemId, scheduled: todayStr() }), quiet: true });
    (result.promoted ||= []).push(itemId);
  }
  await load();
  host.redraw();
}

// AI가 분류한 초안. 읽는 순서대로 문구(주인공) → 고르는 것들(종류·시점·날짜),
// 담기 바는 패널 아래에 붙어 있다. 고친 문구·종류는 wfDraftEdits에 남아 다시 그려도 유지된다.
function panelMeetingDrafts(event, box, host = MEETING_HOST_CARD) {
  const section = panelSection(`AI가 분류한 초안 ${event.drafts.length}`);
  section.classList.add('d-drafts');

  const summary = document.createElement('span');
  summary.className = 'sm';
  const refreshSummary = () => {
    const counts = {};
    let today = 0;
    event.drafts.forEach(draft => {
      const edit = wfDraftEdits.get(draft.id);
      counts[edit.type] = (counts[edit.type] || 0) + 1;
      if (edit.type === 'task' && edit.when === 'today') today++;
    });
    summary.textContent = WF_TYPES.filter(([key]) => counts[key])
      .map(([key, label]) => `${label} ${counts[key]}${key === 'task' && today ? `(오늘 ${today})` : ''}`).join(' · ');
  };

  event.drafts.forEach((draft) => {
    const edit = wfDraftEdits.get(draft.id) || { type: draft.type, description: wfCleanDraftText(draft.description), when: 'later', due: draft.due || '' };
    wfDraftEdits.set(draft.id, edit);
    const card = document.createElement('div');
    card.className = 'd-draft';
    card.dataset.type = edit.type;

    // 문구는 여러 줄로 늘어나는 입력칸에 전부 보인다(한 줄 입력칸일 때는 긴 문구의 끝이 잘렸다).
    const text = document.createElement('textarea');
    text.className = 'd-dtxt';
    text.rows = 1;
    text.maxLength = 1000;
    text.value = edit.description;
    text.setAttribute('aria-label', '초안 문구');
    const fit = () => { text.style.height = 'auto'; text.style.height = `${text.scrollHeight + text.offsetHeight - text.clientHeight}px`; };
    text.addEventListener('input', () => {
      // 문구는 한 줄이다: 붙여넣은 줄바꿈은 공백으로
      if (text.value.includes('\n')) text.value = text.value.replace(/\s*\n\s*/g, ' ');
      edit.description = text.value;
      fit();
    });
    text.addEventListener('keydown', (keyEvent) => {
      if (keyEvent.key === 'Enter' && !keyEvent.isComposing) keyEvent.preventDefault(); // 조합 중의 Enter는 글자를 확정하는 것이다
    });

    const dismiss = panelRunButton('', async () => {
      await wfReview({ meetingId: event.id, dismiss: [draft.id] });
      wfDraftEdits.delete(draft.id);
      await load();
      host.redraw();
    }, 'd-iconbtn sm x', host);
    dismiss.innerHTML = uiIcon('close');
    dismiss.setAttribute('aria-label', `빼기: ${edit.description}`);
    dismiss.title = '이 초안 빼기';

    const controls = document.createElement('div');
    controls.className = 'ct';
    const whenSeg = wfSegment([['later', '나중에 할 일'], ['today', '오늘 할 일']], edit.when || 'later', (key) => { edit.when = key; refreshSummary(); }, '언제 할 일로 담을까');
    whenSeg.title = '나중에: 나중에 할 일로 담겨요 · 오늘: 오늘 할 일로 담겨요';
    const dateSlot = document.createElement('span');
    const syncWhen = () => { whenSeg.hidden = edit.type !== 'task'; };
    const syncDate = () => {
      dateSlot.replaceChildren();
      const label = wfDateLabel(edit.type); // 할 일 → 기한 · 확인 대기 → 답변 받을 날 · 결정 → 날짜 없음
      if (label) dateSlot.appendChild(uiDateField({ value: edit.due || '', label, onChange: (value) => { edit.due = value || ''; } }));
    };
    controls.append(wfTypeSegment(edit.type, (key) => {
      edit.type = key;
      card.dataset.type = key;
      syncWhen();
      syncDate();
      refreshSummary();
    }), whenSeg, dateSlot);
    syncWhen();
    syncDate();

    card.append(text, controls, dismiss);
    section.appendChild(card);
    requestAnimationFrame(fit);
  });
  box.appendChild(section);

  const bar = document.createElement('div');
  bar.className = 'd-dbar';
  bar.appendChild(summary);
  bar.appendChild(panelRunButton(`${event.drafts.length}개 담기`, async () => {
    const accept = event.drafts.map(draft => wfAcceptItem(draft.id, wfDraftEdits.get(draft.id)));
    if (accept.some(item => !item.description)) { panelSetError('비어 있는 문구가 있어요. 채우거나 ✕로 빼 주세요', host); return; }
    const result = await wfReview({ meetingId: event.id, accept });
    host.setResult({ meetingId: event.id, created: result.created, accepted: accept });
    accept.forEach(item => wfDraftEdits.delete(item.id));
    await load();
    host.redraw(); // 결과 카드(role=status)가 담은 결과를 알려 주므로 따로 알림을 띄우지 않는다
  }, 'd-btn pri', host));
  box.appendChild(bar);
  refreshSummary();
}

// 항목 한 줄: 종류 | 문구 | 기한·상태. 기본 상태(미완료)는 모든 줄에 반복되니 적지 않는다.
function panelMeetingItemState(item) {
  if (item.status === 'done') return { text: '완료', tone: '' };
  const blocker = typeof wfItem === 'function' && item.blockedBy ? wfItem(item.blockedBy) : null;
  if (blocker && blocker.status !== 'done') return { text: '답변 대기', tone: 'warn' };
  const due = uiItemDueText(item);
  if (due) return due;
  if (item.doing) return { text: '진행 중', tone: '' };
  return null;
}

// 회의 줄의 문구를 그 자리에서 고친다 — 상세 제목(panelTitleEdit)과 같은 규칙이다:
// Enter 저장 · 한글 조합 중 Enter는 글자를 확정하는 것이라 넘긴다 · Esc는 입력만 되돌리고
// (회의 카드는 열린 채로) · 빈 값은 저장하지 않으며 · 저장이 실패하면 적은 글자를 그대로 둔다.
// checkbox(있으면)는 고치는 동안 누르지 못하게 잠근다 — 입력을 먼저 확정해야 한다(단순한 쪽).
function panelMeetingRowEdit(row, titleEl, item, checkbox) {
  // 이미 고치는 중이면(제목을 눌러 열어 둔 채 ⋯로 또 눌렀을 때) 그 칸으로 보낸다.
  if (!titleEl.isConnected) { row.querySelector('.d-din')?.focus(); return; }
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'd-din';
  input.maxLength = 1000;
  input.value = item.description;
  input.setAttribute('aria-label', `${item.description} — 문구 고치기`);
  titleEl.replaceWith(input);
  input.focus();
  input.select?.();
  if (checkbox) checkbox.disabled = true;

  let settled = false;
  // Esc는 가장 위에 열린 것부터 닫는다 — 여기서는 회의 카드가 아니라 이 입력칸만 되돌린다.
  const cancel = () => {
    if (settled) return;
    settled = true;
    escDrop(cancel);
    if (checkbox) checkbox.disabled = false;
    if (!input.isConnected) return; // 카드가 이미 다시 그려졌으면 되돌릴 자리가 없다
    input.replaceWith(titleEl);
    titleEl.focus?.();
  };
  escPush(cancel);
  const commit = async () => {
    if (settled) return;
    const value = input.value.trim();
    if (!value || value === item.description) { cancel(); return; }
    settled = true;
    escDrop(cancel);
    input.disabled = true; // 포커스가 빠져 load()가 회의 카드를 다시 그릴 수 있게 된다
    try {
      await postJson('/api/track/set-description', { id: item.id, description: value });
      await load(); // 개수(`이 회의에서 나온 것 N`)와 레일의 회의 줄까지 함께 맞춰진다 — 새 줄의 체크박스는 잠겨 있지 않다
    } catch {
      settled = false;
      escPush(cancel);
      input.disabled = false;
      if (checkbox) checkbox.disabled = false;
      input.focus();
    }
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (keyEvent) => {
    if (keyEvent.key !== 'Enter' || keyEvent.isComposing) return;
    keyEvent.preventDefault();
    input.blur();
  });
}

// 회의 줄의 ⋯ — 앱의 다른 목록이 쓰는 메뉴를 그대로 쓰고, 맨 위에 `문구 고치기`만 얹는다.
// 종류 바꾸기는 종류마다 저장 파일이 달라 서버에 옮기기가 필요해서 아직 없다(DECISIONS).
function panelMeetingRowMenu(item, row, onEdit) {
  const base = item.type === 'check' ? waitingMenuSections(item, row)
    : item.type === 'decision' ? decisionMenuSections(item, row)
    : taskMenuSections({ item, mode: panelMode(item), card: row });
  return [[{ label: '문구 고치기', onClick: onEdit }], ...base];
}

// 회의 줄 맨 앞의 체크 칸: 할 일·버그는 완료 체크, 확인 대기는 확인 완료, 결정은 `PRD 반영함` —
// 목록이 쓰는 체크박스 그대로다. 아이디어는 체크가 없다(자리만 비워 다른 줄과 제목 시작을 맞춘다).
// 업무·결정은 `.d-check` 안에 진짜 <input>이 한 겹 더 들어 있어(uiCheckCell·decisionCheckbox) 칸(cell)과
// 진짜 체크박스(input)를 따로 돌려준다 — 문구 고치기가 잠글 것은 언제나 input이다.
function panelMeetingCheck(item, row, done) {
  const cell = document.createElement('span');
  cell.className = 'ck';
  let input = null;
  if (item.type === 'task' || item.type === 'bug') {
    const check = uiCheckCell(item, row, done);
    cell.appendChild(check);
    input = check.children[0];
  } else if (item.type === 'check') {
    input = waitingCheckbox(item, row, done);
    cell.appendChild(input);
  } else if (item.type === 'decision') {
    const check = decisionCheckbox(item, row, done);
    cell.appendChild(check);
    input = check.children[0];
  }
  // 체크하면 이 상자가 초점을 받는다 — `isTyping()`은 어떤 <input>이든 초점이 있으면 "입력 중"으로 보고
  // 회의 카드·탭의 새로고침(syncTaskDetail·renderMeetings)을 건너뛴다(문구 고치기 입력칸을 지키려는 장치다).
  // 체크박스는 지킬 글자가 없으니 여기서 바로 초점을 내려 두 자리 모두 완료 모양으로 다시 그려지게 한다.
  // (저장 리스너는 `change`에 붙어 있으니 `click`에 붙여 한 element에 같은 이벤트 리스너가 겹치지 않게 한다.)
  if (input) input.addEventListener('click', () => input.blur());
  return { cell, input };
}

function panelMeetingRow(item, event, stateText, host = MEETING_HOST_CARD) {
  const row = document.createElement('div');
  const done = item.status === 'done';
  row.className = 'd-mrow2' + (done ? ' is-done' : '')
    + (panelState && panelState.kind !== 'meeting' && panelState.id === item.id ? ' is-sel' : '');
  // 회의 탭에서 제목을 누르면 이 줄 옆에 상세 카드가 뜬다 — 다른 목록과 같은 앵커 규칙을 쓴다.
  row.dataset.taskId = item.id;
  const { cell: checkCell, input: checkbox } = panelMeetingCheck(item, row, done);
  row.appendChild(checkCell);
  const tag = document.createElement('span');
  tag.className = 'tg';
  tag.textContent = wfType(item.type);
  // 업무·확인 대기는 같은 패널에서 상세를 연다. 결정은 상세가 없으니 제목이 곧 `문구 고치기`다.
  const openable = ['task', 'bug', 'check'].includes(item.type);
  const title = document.createElement('button');
  title.type = 'button';
  title.className = 'ti';
  title.title = item.description;
  title.textContent = item.description;
  const edit = () => panelMeetingRowEdit(row, title, item, checkbox);
  title.setAttribute('aria-label', openable ? `${item.description} 상세 보기` : `${item.description} — 문구 고치기`);
  title.addEventListener('click', openable ? () => host.openItem(item, event) : edit);
  const state = document.createElement('span');
  state.className = 'st';
  if (stateText) state.textContent = stateText;
  else {
    const meta = panelMeetingItemState(item);
    if (meta) { state.className = `st${uiTone(meta.tone)}`; state.textContent = meta.text; }
  }
  // 이 줄에서 할 수 있는 일이 더보기뿐이라 ⋯은 늘 보인다(평소 흐리게, 손이 닿으면 진하게).
  const acts = document.createElement('span');
  acts.className = 'ac';
  acts.appendChild(uiMoreButton(`${item.description} — 더 보기`, () => panelMeetingRowMenu(item, row, edit)));
  row.append(tag, title, state, acts);
  return row;
}

function panelMeetingItems(event, box, host = MEETING_HOST_CARD) {
  const typeRank = (item) => { const rank = ['task', 'bug', 'check', 'decision'].indexOf(item.type); return rank < 0 ? 9 : rank; };
  const items = [...wfMeetingItems(event.id)].sort((a, b) => typeRank(a) - typeRank(b));
  if (!items.length) return;
  const section = panelSection(`이 회의에서 나온 것 ${items.length}`);
  items.forEach((item) => {
    section.appendChild(panelMeetingRow(item, event, null, host));
    // 체크한 확인 대기는 이 구역에 is-done으로 남는다 — 그 줄 바로 아래에 `다음은?`을 덧붙인다.
    const next = item.type === 'check' ? waitingNextItem(item.id) : null;
    if (next) section.appendChild(waitingNextRow(next));
  });
  box.appendChild(section);
}

// 같은 이름으로 반복되는 회의라면, 지난 회차에서 아직 안 끝난 것을 여기서 같이 본다.
function panelMeetingPast(event, box, host = MEETING_HOST_CARD) {
  if (!event.series) return;
  const meetings = (typeof workflowData === 'object' && workflowData ? workflowData.meetings : null) || [];
  const past = meetings
    .filter(other => other.id !== event.id && other.series === event.series && (other.date || '') < (event.date || ''))
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const rows = [];
  past.forEach(other => wfMeetingItems(other.id).filter(item => item.status !== 'done').forEach(item => rows.push({ item, at: other.date })));
  if (!rows.length) return;
  const section = panelSection(`이전 회차의 미해결 항목 ${rows.length}`);
  rows.forEach(({ item, at }) => section.appendChild(panelMeetingRow(item, event, `${uiKoDateShort(at)} 회차`, host)));
  box.appendChild(section);
}

// 직접 적어 담기 — 검토할 초안이 있으면 접어 두고(주 흐름은 검토 → 담기), 없을 때만 펼친다.
function panelMeetingCapture(event, box, linked, host = MEETING_HOST_CARD) {
  const section = document.createElement('details');
  section.className = 'd-dsec d-dadd';
  section.open = !(event.drafts && event.drafts.length);
  const label = document.createElement('summary');
  label.className = 'lbl';
  label.innerHTML = uiIcon('chevron');
  label.append('직접 적어 담기');
  section.appendChild(label);

  const form = document.createElement('div');
  form.className = 'd-dcap';
  let type = 'task';
  let due = '';
  const dateSlot = document.createElement('span');
  const syncDate = () => {
    dateSlot.replaceChildren();
    const name = wfDateLabel(type);
    if (name) dateSlot.appendChild(uiDateField({ value: due, label: name, onChange: (value) => { due = value || ''; } }));
  };
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'd-din';
  input.maxLength = 1000;
  input.placeholder = '회의에서 나온 내용';
  input.setAttribute('aria-label', '회의에서 나온 내용');
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'd-btn pri';
  add.textContent = '추가';

  const submit = async () => {
    const description = input.value.trim();
    if (!description || add.disabled) return;
    add.disabled = true;
    panelSetError('', host);
    try {
      if (linked) await wfPost('capture', { meetingId: event.id, type, description, ...(type !== 'decision' && due ? { due } : {}) });
      else {
        // 기록되지 않은 회의: 회의에 연결하지 않고 목록에 바로 담는다(프로젝트는 회의에 연결된 것을 쓴다).
        const project = event.project;
        const body = {
          description,
          ...(type !== 'decision' && due ? { due } : {}),
          ...(project && project.type && project.value ? { [project.type]: project.value } : {}),
        };
        const response = await request(MEETING_CAPTURE_ENDPOINT[type], { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const result = await response.json();
        if (!result.ok) throw new Error(result.error || '담지 못했어요.');
      }
      await load();
      host.redraw();
    } catch {
      panelSetError('추가하지 못했어요. 적은 내용은 그대로 있어요.', host);
      add.disabled = false;
      input.focus();
    }
  };
  input.addEventListener('keydown', (keyEvent) => {
    if (keyEvent.key !== 'Enter' || keyEvent.isComposing) return; // 한글을 조합하는 중의 Enter는 글자를 확정하는 것이다
    keyEvent.preventDefault();
    submit();
  });
  add.addEventListener('click', submit);

  form.append(wfTypeSegment('task', (key) => { type = key; syncDate(); }, '담을 종류'), input, dateSlot, add);
  syncDate();
  section.appendChild(form);
  box.appendChild(section);
}

// 이미 적어 둔 항목을 이 회의에서 나온 것으로 연결한다(같은 프로젝트의 항목만 후보로).
function panelMeetingLink(event, box, host = MEETING_HOST_CARD) {
  const key = typeof wfMeetingKey === 'function' ? wfMeetingKey(event) : null;
  const items = (typeof workflowData === 'object' && workflowData ? workflowData.items : null) || [];
  const candidates = items.filter(item => !item.meetingId && (!key || wfKey(item) === key));
  if (!candidates.length) return;
  const section = document.createElement('details');
  section.className = 'd-dsec d-dadd';
  const label = document.createElement('summary');
  label.className = 'lbl';
  label.innerHTML = uiIcon('chevron');
  label.append('기존 항목 연결');
  section.appendChild(label);

  const row = document.createElement('div');
  row.className = 'd-dcap';
  const select = document.createElement('select');
  select.className = 'd-msel wide';
  select.setAttribute('aria-label', '이 회의에서 나온 항목 선택');
  [['', '항목 선택'], ...candidates.map(item => [item.id, `${wfType(item.type)} · ${item.description}`])].forEach(([value, text]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    select.appendChild(option);
  });
  row.append(select, panelRunButton('회의에 연결', async () => {
    if (!select.value) return;
    await wfPost('link', { id: select.value, meetingId: event.id });
    await load();
    host.redraw();
  }, 'd-btn', host));
  section.appendChild(row);
  box.appendChild(section);
}

/* ---------- 회의 탭 ----------
   프로젝트 탭과 같은 뼈대다: 왼쪽은 회의 목록 카드, 오른쪽은 고른 회의 하나.
   오른쪽 내용은 줄 옆 회의 카드와 같은 함수(panelMeeting)가 그린다 — 내용을 두 벌 만들지 않는다.
   고른 회의·필터는 카드(panelState)와 다른 상태다(카드가 열려 있다는 뜻이 아니다). 세션 동안만 기억한다.
   기본 목록은 캘린더 회의가 매일 쌓여도 끝없이 길어지지 않게 기간으로 자른다(windowDays·showNoRecord도 세션 동안만). */
const MEETINGS_TAB_WINDOW_DAYS = 14;
let meetingsTabState = {
  key: null, unresolved: false, reviewOnly: false, project: '',
  windowDays: MEETINGS_TAB_WINDOW_DAYS, showNoRecord: false, result: null,
};

// 날짜 문자열끼리 며칠 차이인지(순수 함수, 자정 기준) — dateStr이 today보다 며칠 앞섰는지.
function daysBeforeToday(dateStr, today) {
  return Math.round((new Date(`${today}T00:00:00`) - new Date(`${dateStr}T00:00:00`)) / 86400000);
}

// 미완료: 이 회의에서 나온 항목 중 할 일·확인 대기(버그 포함)이면서 안 끝난 것만 센다 — 결정은 세지 않는다
// (프로젝트 탭이 `열린 항목`을 셀 때 쓰는 uiProjectOpenItem과 같은 기준).
function meetingUnresolvedCount(event, itemsOf) {
  const items = typeof itemsOf === 'function' ? itemsOf(event.id) : [];
  return items.filter(uiProjectOpenItem).length;
}

// 기록이 있는지: 검토할 초안이 있거나, 이 회의에서 나온 항목이 하나라도 있으면(끝난 것·결정도 포함).
function meetingHasRecord(event, itemsOf) {
  if (event.drafts && event.drafts.length) return true;
  const items = typeof itemsOf === 'function' ? itemsOf(event.id) : [];
  return items.length > 0;
}

// 손댈 일이 남았는지: 검토할 초안이 있거나 미완료 항목(할 일·확인 대기)이 있으면 — 절대 숨기지 않을 회의.
function meetingHasOpenWork(event, itemsOf) {
  if (event.drafts && event.drafts.length) return true;
  return meetingUnresolvedCount(event, itemsOf) > 0;
}

// 기본 목록 범위 판단(순수 함수, 회의 한 건): 오늘·미래는 전부, 보이는 기간 안은 기록이 있어야(토글을 켜면 없어도),
// 기간 밖은 손댈 일이 남아야 보인다.
function meetingInBaseScope(event, { today, windowDays, showNoRecord, itemsOf }) {
  const date = event.date || '';
  if (date >= today) return true;
  if (daysBeforeToday(date, today) <= windowDays) return !!showNoRecord || meetingHasRecord(event, itemsOf);
  return meetingHasOpenWork(event, itemsOf);
}

// 기본 목록(순수 함수): 오늘 회의 전부 + 보이는 기간 안의 기록 있는 회의(+ 토글 켜면 기록 없는 것도) +
// 기간보다 오래됐어도 손댈 일이 남은 회의(다시는 숨기지 않는다). 오늘 날짜를 인자로 받아 테스트가 직접 판단을 부른다.
function meetingsBaseScope(meetings, { today, windowDays, showNoRecord, itemsOf }) {
  return (meetings || []).filter(event => meetingInBaseScope(event, { today, windowDays, showNoRecord, itemsOf }));
}

// `이전 회의 더 보기`를 보일지(순수 함수): 지금 기간보다 오래된 회의가 하나라도 남아 있으면 더 넓힐 것이 있다.
// 눌렀을 때 실제로 새 줄이 나올 때만 `이전 회의 더 보기`를 보인다 — 기간 밖이라도 손댈 일이 남은 회의는
// 이미 보이고 있고, 기록 없는 회의는 `빈 회의 포함`을 켰을 때만 나온다.
function meetingsHasMoreBeyond(meetings, today, windowDays, { showNoRecord = false, itemsOf } = {}) {
  return (meetings || []).some(event => (event.date || '') < today && daysBeforeToday(event.date, today) > windowDays
    && !meetingHasOpenWork(event, itemsOf) && (showNoRecord || meetingHasRecord(event, itemsOf)));
}

// 목록 거르기(순수 함수). 필터(초안 있음·미완료만·프로젝트)를 하나라도 켜면 찾는 행동이므로 기간·기록 제한 없이
// 전체 회의에서 거른다. 아무 필터도 없으면 기본 목록 범위만 본다. 차례는 날짜 내림차순(같은 날은 시각 순)
// — 훑어보는 면이라 "언제"가 먼저다.
function meetingsTabList(meetings, state, itemsOf) {
  const project = state.project || '';
  const today = state.today || todayStr();
  const filtering = !!(state.unresolved || state.reviewOnly || project);
  const pool = filtering ? (meetings || []) : meetingsBaseScope(meetings, {
    today, windowDays: state.windowDays || MEETINGS_TAB_WINDOW_DAYS, showNoRecord: !!state.showNoRecord, itemsOf,
  });
  return palMeetings(pool, { type: 'meeting', unresolved: !!state.unresolved, reviewOnly: !!state.reviewOnly, today }, itemsOf)
    .filter(event => !project || wfMeetingKey(event) === project)
    .sort(wfMeetingOrder);
}

// 처음 들어오면 무엇을 고를까(순수 함수): 이미 고른 회의가 목록에 남아 있으면 그대로 →
// 검토 대기가 있으면 그중 가장 최근 → 오늘 남은 회의 중 가장 이른 것 → 가장 최근 회의.
function meetingsTabPick(list, current, today, now) {
  if (current && list.some(event => event.id === current)) return current;
  if (!list.length) return null;
  const review = list.find(event => event.drafts && event.drafts.length);
  if (review) return review.id;
  const upcoming = list.filter(event => event.date === today && (event.start || '') >= (now || ''))
    .sort((a, b) => (a.start || '').localeCompare(b.start || ''));
  return (upcoming[0] || list[0]).id;
}

// 탭 이름 옆 숫자 — 검토를 기다리는 초안이 있는 회의 수(0이면 숫자를 찍지 않는다).
const meetingsReviewCount = meetings => (meetings || []).filter(event => event.drafts && event.drafts.length).length;

// 고른 회의를 바꾼다. 담은 결과 카드는 그 회의의 것이라 함께 내린다(줄 옆 카드가 회의를 옮길 때와 같다).
function meetingsTabSelect(id) {
  if (meetingsTabState.key === id) return;
  meetingsTabState.key = id;
  meetingsTabState.result = null;
}

// 목록 밖의 회의를 열 때: 가리고 있는 조건을 풀어서라도 보이게 한다 — 오른쪽 내용은 반드시 열려야 한다.
// (단순한 쪽을 고른다: 새 줄을 끼워 넣지 않고 막고 있는 필터를 끄거나 보이는 기간을 그 회의가 들어올 만큼 넓힌다.)
function meetingsTabRevealIfNeeded(id) {
  const event = ((workflowData && workflowData.meetings) || []).find(item => item.id === id);
  if (!event) return;
  const itemsOf = typeof wfMeetingItems === 'function' ? wfMeetingItems : null;
  if (meetingsTabState.reviewOnly && !(event.drafts && event.drafts.length)) meetingsTabState.reviewOnly = false;
  if (meetingsTabState.unresolved && meetingUnresolvedCount(event, itemsOf) === 0) meetingsTabState.unresolved = false;
  if (meetingsTabState.project && wfMeetingKey(event) !== meetingsTabState.project) meetingsTabState.project = '';
  const today = todayStr();
  const windowDays = meetingsTabState.windowDays || MEETINGS_TAB_WINDOW_DAYS;
  if (meetingInBaseScope(event, { today, windowDays, showNoRecord: meetingsTabState.showNoRecord, itemsOf })) return;
  const gap = daysBeforeToday(event.date || today, today);
  meetingsTabState.windowDays = Math.max(windowDays, Math.ceil(gap / MEETINGS_TAB_WINDOW_DAYS) * MEETINGS_TAB_WINDOW_DAYS);
  if (!meetingHasRecord(event, itemsOf)) meetingsTabState.showNoRecord = true;
}

// 레일의 `전체 보기` · 회의 카드 ⋯의 `회의 탭에서 열기` · 팔레트의 회의 결과가 함께 쓰는 길.
function openMeetingsTab(id) {
  if (id) { meetingsTabRevealIfNeeded(id); meetingsTabSelect(id); }
  // 줄 옆 카드는 지금 탭의 줄에 붙어 있다 — 탭을 옮기기 전에 닫는다(팔레트로 되돌아가지 않게).
  if (panelState) { panelState.back = null; panelClose(); }
  tabStale.meetings = true;
  setActiveTab('meetings');
}

function renderMeetings() {
  const listEl = document.getElementById('meetingList');
  const body = document.getElementById('meetingBody');
  if (!listEl || !body) return;
  const meetings = (workflowData && workflowData.meetings) || [];
  const itemsOf = typeof wfMeetingItems === 'function' ? wfMeetingItems : null;
  const today = todayStr();
  const filtering = !!(meetingsTabState.unresolved || meetingsTabState.reviewOnly || meetingsTabState.project);
  const rows = meetingsTabList(meetings, meetingsTabState, itemsOf);
  meetingsTabState.key = meetingsTabPick(rows, meetingsTabState.key, today, nowHHMM());

  listEl.replaceChildren();
  const head = document.createElement('div');
  head.className = 'd-rhd';
  const headName = document.createElement('span');
  headName.textContent = '회의';
  const headCount = document.createElement('span');
  headCount.className = 'n num';
  headCount.textContent = rows.length;
  head.append(headName, headCount);
  // 머리 오른쪽 끝의 조용한 버튼 — 오늘 회의의 미팅 노트를 한꺼번에.
  const notesLast = [];
  if (meetingNotesState.used !== false) {
    const spacer = document.createElement('span');
    spacer.className = 'sp';
    head.append(spacer, meetingNotesButton('오늘 것 모두 가져오기', 'today'));
    // 그 버튼 아래에 오늘 가져온 기록 한 줄(목록 칸이 좁아 머리줄에 같이 두면 글자가 잘린다).
    const last = meetingNotesLastText();
    if (last) {
      const note = document.createElement('div');
      note.className = 'd-mtlast';
      note.textContent = last;
      notesLast.push(note);
    }
  }
  listEl.append(head, ...notesLast, meetingsTabFilters(meetings));

  // 날짜별 조용한 소제목 — 묶음을 알려 주기만 한다(개수·칩 없음).
  let lastDate = null;
  rows.forEach((event) => {
    if (event.date !== lastDate) {
      lastDate = event.date;
      const day = document.createElement('div');
      day.className = 'd-mtday';
      day.textContent = event.date === today ? '오늘' : uiKoDate(event.date);
      listEl.appendChild(day);
    }
    listEl.appendChild(meetingsTabRow(event));
  });
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'd-rempty';
    empty.textContent = meetings.length ? '고른 조건에 맞는 회의가 없어요.' : '아직 기록된 회의가 없어요.';
    listEl.appendChild(empty);
  }

  // 필터가 걸려 있으면 전체에서 찾은 것이니 기간 더 보기는 의미가 없다.
  if (!filtering && meetingsHasMoreBeyond(meetings, today, meetingsTabState.windowDays || MEETINGS_TAB_WINDOW_DAYS,
    { showNoRecord: !!meetingsTabState.showNoRecord, itemsOf })) {
    const more = document.createElement('div');
    more.className = 'd-mmore';
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'd-link';
    link.textContent = '이전 회의 더 보기';
    link.addEventListener('click', () => {
      meetingsTabState.windowDays = (meetingsTabState.windowDays || MEETINGS_TAB_WINDOW_DAYS) + MEETINGS_TAB_WINDOW_DAYS;
      renderMeetings();
    });
    more.appendChild(link);
    listEl.appendChild(more);
  }

  renderMeetingDetail(body, rows.find(event => event.id === meetingsTabState.key) || null);
}

// 목록 위의 조용한 토글 칩 + 프로젝트 고르기 — 팔레트에 있던 회의 전용 필터가 이 자리로 왔다.
function meetingsTabFilters(meetings) {
  const bar = document.createElement('div');
  bar.className = 'd-mfil';
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', '회의 거르기');
  const chip = (text, on, onPick, hint) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'd-chip' + (on ? ' is-on' : '');
    button.textContent = text;
    if (hint) button.title = hint;
    button.setAttribute('aria-pressed', String(!!on));
    button.addEventListener('click', () => { onPick(); renderMeetings(); });
    bar.appendChild(button);
  };
  chip('초안 있음', meetingsTabState.reviewOnly, () => { meetingsTabState.reviewOnly = !meetingsTabState.reviewOnly; });
  chip('미완료만', meetingsTabState.unresolved, () => { meetingsTabState.unresolved = !meetingsTabState.unresolved; });
  // 조용한 토글 — 기본은 꺼짐, 켜면 보이는 기간 안의 기록 없는 지난 회의도 함께 나온다.
  // 칩 이름은 짧게 두고 무슨 뜻인지는 툴팁이 풀어 준다(줄에 들어가야 하는 이름이다).
  chip('빈 회의 포함', meetingsTabState.showNoRecord, () => { meetingsTabState.showNoRecord = !meetingsTabState.showNoRecord; },
    '초안도 담은 항목도 없는 지난 회의까지 보여 줘요');

  // 프로젝트는 값이 여럿이라 칩 대신 고르는 칸이다(회의에 연결된 프로젝트만 후보로).
  const keys = new Map();
  meetings.forEach((event) => {
    const key = wfMeetingKey(event);
    // 프로젝트를 고르는 칸이라 `요약 · 키`(BKEY 결정) — 정렬도 이 표기(요약 기준) 그대로 쓴다.
    if (key && !keys.has(key)) keys.set(key, wfMeetingProjectName(event, { picker: true }));
  });
  if (!keys.size) return bar;
  const select = document.createElement('select');
  select.className = 'd-msel';
  select.setAttribute('aria-label', '프로젝트로 거르기');
  [['', '프로젝트 전체'], ...[...keys].sort((a, b) => String(a[1]).localeCompare(String(b[1])))].forEach(([value, text]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    if (value === meetingsTabState.project) option.selected = true;
    select.appendChild(option);
  });
  select.addEventListener('change', () => { meetingsTabState.project = select.value; renderMeetings(); });
  bar.appendChild(select);
  return bar;
}

// 목록 한 줄: 시각 | 제목 + `● 프로젝트` | 상태(`초안 N` 배지 · `미완료 N` 조용한 글자).
function meetingsTabRow(event) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'd-mtrow';
  button.setAttribute('aria-current', String(event.id === meetingsTabState.key));

  const time = document.createElement('span');
  time.className = 't num';
  time.textContent = event.start || '';

  const wrap = document.createElement('span');
  wrap.className = 'tw';
  const title = document.createElement('span');
  title.className = 'ti';
  title.textContent = event.title;
  wrap.appendChild(title);
  // 줄 안의 짧은 표기라 지라는 요약만(모르면 키) — 색 점은 원래 키로 고른다(표기와 무관하게 같은 색).
  const projectName = wfMeetingProjectName(event);
  const projectFull = wfMeetingProjectName(event, { withKey: true });
  if (projectName) {
    const tag = document.createElement('span');
    tag.className = 'pj';
    tag.title = projectFull;
    const name = document.createElement('span');
    name.className = 'nm';
    name.textContent = projectName;
    tag.append(uiProjectDot(wfMeetingColorKey(event)), name);
    wrap.appendChild(tag);
  }
  button.title = [event.title, projectFull].filter(Boolean).join(' · ');

  // 0은 찍지 않는다 — 지금 손댈 것(검토할 초안)만 배지로 세우고 나머지는 조용한 글자다.
  // 미완료는 할 일·확인 대기만 센다 — 결정은 끝내는 대상이 아니라 세지 않는다.
  const drafts = (event.drafts && event.drafts.length) || 0;
  const open = meetingUnresolvedCount(event, typeof wfMeetingItems === 'function' ? wfMeetingItems : null);
  const badge = document.createElement('span');
  badge.className = 'ct num';
  if (drafts) { badge.textContent = `초안 ${drafts}`; badge.title = `AI가 뽑은 초안 ${drafts}개를 아직 검토하지 않았어요`; }
  const state = document.createElement('span');
  state.className = 'st num';
  if (!drafts && open) {
    state.textContent = `미완료 ${open}`;
    state.title = `이 회의에서 나온 할 일·확인 대기 중 ${open}개가 아직 안 끝났어요`;
  }

  button.append(time, wrap, drafts ? badge : state);
  button.addEventListener('click', () => {
    if (meetingsTabState.key === event.id) return;
    meetingsTabSelect(event.id);
    renderMeetings();
  });
  return button;
}

// 오른쪽 자리 — 줄 옆 카드와 같은 내용을 페이지 안의 흰 카드로 그린다(닫기 없음, 담기 바는 아래에 붙는다).
function renderMeetingDetail(body, event) {
  body.replaceChildren();
  if (!event) {
    body.insertAdjacentHTML('beforeend', '<div class="d-empty">왼쪽에서 회의를 고르면 여기서 정리할 수 있어요.</div>');
    return;
  }
  const card = document.createElement('div');
  card.className = 'd-detail is-tab';
  panelMeeting(event, card, MEETING_HOST_TAB);
  // 담기 바는 카드 맨 아래에 붙는다(줄 옆 카드에서 detailPopShape가 하는 것과 같은 자리).
  const bar = card.querySelector(':scope > .d-dbar');
  if (bar) card.appendChild(bar);
  body.appendChild(card);
}

/* ---------- 줄 옆 카드 ----------
   상세는 누른 줄 옆에 떠 있는 카드로 연다(자리를 옮겨 다니지 않고 눈이 줄에서 떨어지지 않게).
   - 가로: 본문 줄은 줄 오른쪽 끝 안쪽, 레일 줄은 줄 오른쪽 옆, 서랍 줄은 서랍 왼쪽 옆.
   - 세로: 줄 윗변에 맞추되 화면에 들어갈 만큼만 위로 끌어올린다(헤더 아래 12px · 아래 12px).
   - 길어지면 카드가 화면을 넘지 않는다: 머리(제목)와 발(동작 줄·담기 바)은 붙박이, 가운데만 스크롤.
   - 목록을 스크롤하면 줄을 따라가고, 줄이 화면 밖으로 완전히 나가면 닫힌다.
   - 붙을 줄이 없이 열면(팔레트 등) 화면 가운데 위에 선다.
   회의 정리는 검토하는 면이 넓어야 해서 같은 카드의 넓은 쪽(460px)을 쓰고, 빈 자리를 눌러도 닫히지 않는다. */
const DETAIL_HDR = 60;        // --hdr
const DETAIL_GAP = 12;        // 헤더 아래 · 화면 아래 · 줄에서 떨어지는 거리
const DETAIL_W = 360;         // 업무 · 확인 대기
const DETAIL_W_WIDE = 460;    // 회의 정리
const DETAIL_SHEET_MAX = 520; // 여기보다 좁으면 아래에서 올라오는 시트

let detailPopHost = null;
let detailPopTick = 0;
let detailPopSize = null;   // 내용이 자라면 자리를 다시 잡는 관찰자
let detailPopFloat = false; // 붙을 줄 없이 연 카드 — 계속 화면 가운데 위에 선다
let detailLastRow = null;   // 마지막으로 누른 줄 — 같은 항목이 여러 목록에 보일 때 그 자리를 쓴다

function detailSheet() { return window.innerWidth <= DETAIL_SHEET_MAX; }

function detailReduce() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

// 줄이 어느 목록에 들어 있는지(다시 그려도 남는 id로 적어 둔다).
function detailRowHostId(row) {
  const holder = row && row.closest ? row.closest('[id]') : null;
  return holder ? holder.id : null;
}

// 방금 누른 줄이 지금 여는 항목의 줄인지.
function detailRowMatches(row, view, kind) {
  if (!row || !row.dataset) return false;
  if (kind === 'meeting') return row.dataset.meetingId !== undefined;
  const id = String(view.id);
  return row.dataset.taskId === id || row.dataset.railId === id;
}

document.addEventListener('click', (event) => {
  const row = event.target.closest ? event.target.closest('[data-task-id], [data-rail-id], [data-meeting-id]') : null;
  if (row) detailLastRow = row;
}, true);

// 지금 열어 둔 항목의 줄. 숨은 탭·닫힌 서랍 안의 줄은 세지 않는다.
function detailAnchorRow() {
  if (!panelState) return null;
  let selector = null;
  if (panelState.kind === 'meeting') {
    const key = panelMeetingKey(panelMeetingEvent());
    if (key) selector = `[data-meeting-id="${CSS.escape(String(key))}"]`;
  } else if (panelState.id !== null && panelState.id !== undefined) {
    const id = CSS.escape(String(panelState.id));
    selector = `[data-task-id="${id}"], [data-rail-id="${id}"]`;
  }
  if (!selector) return null;
  const rows = [...document.querySelectorAll(selector)]
    .filter(row => row.offsetParent !== null && !row.closest('[hidden]'))
    .filter(row => laterDrawerOpen || !row.closest('#laterTaskDrawer'));
  if (!rows.length) return null;
  const host = panelState.anchorHost ? document.getElementById(panelState.anchorHost) : null;
  return (host && rows.find(row => host.contains(row))) || rows[0];
}

// 어느 쪽에 붙일지 — 서랍 줄은 서랍 왼쪽 옆, 레일 줄은 줄 오른쪽 옆, 나머지는 줄 오른쪽 끝 안쪽.
function detailPopSide(row) {
  if (!row || !row.closest) return 'body';
  if (row.closest('#laterTaskDrawer')) return 'drawer';
  if (row.closest('.d-rail')) return 'rail';
  return 'body';
}

function detailPopWidth() {
  const wide = panelState && panelState.kind === 'meeting';
  const room = Math.max(280, window.innerWidth - 48);
  return Math.min(wide ? DETAIL_W_WIDE : DETAIL_W, room);
}

// 카드 자리(순수 함수). row·view는 화면 좌표, card는 { width, height },
// side는 'body' · 'rail' · 'drawer' · 'center'(붙을 줄이 없을 때).
function detailPopPosition(row, card, view, side = 'body') {
  const width = card.width || DETAIL_W;
  const roof = DETAIL_HDR + DETAIL_GAP;
  const maxHeight = Math.max(160, view.height - DETAIL_HDR - DETAIL_GAP * 2);
  if (side === 'center' || !row) {
    return { left: Math.round(Math.max(8, (view.width - width) / 2)), top: roof, maxHeight };
  }
  const height = Math.min(card.height || 0, maxHeight);
  let left = side === 'rail' ? row.right + DETAIL_GAP
    : side === 'drawer' ? row.left - width - DETAIL_GAP
    : row.right - width - DETAIL_GAP;
  left = Math.min(Math.max(8, left), Math.max(8, view.width - width - 8));
  const top = Math.max(roof, Math.min(row.top, view.height - DETAIL_GAP - height));
  return { left: Math.round(left), top: Math.round(top), maxHeight };
}

// 만들어 둔 상세를 카드에 넣고 줄 옆에 세운다. 붙어 있던 줄이 사라졌으면 false(부르는 쪽이 닫는다).
function detailPopMount(box, focusFirst) {
  const row = detailAnchorRow();
  if (!detailPopHost) detailPopFloat = !row;
  if (!row && !detailPopFloat) return false;
  let host = detailPopHost;
  if (!host) {
    host = document.createElement('div');
    host.className = 'd-popd';
    host.setAttribute('role', 'region');
    host.setAttribute('aria-label', '선택한 항목 상세');
    document.body.appendChild(host);
    detailPopHost = host;
    document.addEventListener('mousedown', detailPopOutside, true);
    window.addEventListener('scroll', detailPopFollow, true);
    window.addEventListener('resize', detailPopFollow);
    if (!detailReduce() && host.animate) {
      host.animate([{ opacity: 0, transform: 'translateY(-4px) scale(0.985)' }, { opacity: 1, transform: 'none' }],
        { duration: 140, easing: 'cubic-bezier(0.22, 0.8, 0.3, 1)' });
    }
  }
  detailPopShape(box);
  host.replaceChildren(box);
  if (detailPopSize) detailPopSize.disconnect();
  if (window.ResizeObserver) {
    // 내용이 자라거나(결과 한 줄·기록 펼치기) 줄어들면 자리를 다시 잡는다.
    detailPopSize = new ResizeObserver(() => detailPopReplace());
    detailPopSize.observe(box);
  }
  detailPopPlace(detailPopFloat ? null : row);
  if (focusFirst) panelFocusFirst(box);
  return true;
}

// 머리(제목)와 발(동작 줄·담기 바)은 카드에 붙박이로 두고 가운데만 스크롤한다.
function detailPopShape(box) {
  box.classList.add('is-pop');
  if (panelState && panelState.kind === 'meeting') box.classList.add('is-wide');
  const back = box.querySelector(':scope > .d-back');
  const head = box.querySelector(':scope > .d-dtop');
  const foot = box.querySelector(':scope > .d-dfoot') || box.querySelector(':scope > .d-dbar');
  const body = document.createElement('div');
  body.className = 'd-popbody';
  body.append(...[...box.children].filter(el => el !== back && el !== head && el !== foot));
  box.replaceChildren(...[back, head, body, foot].filter(Boolean));
  // 가운데가 스크롤되고 있을 때만 머리·발 경계에 옅은 선을 둔다.
  const edges = () => {
    box.classList.toggle('at-top', body.scrollTop <= 1);
    box.classList.toggle('at-end', body.scrollTop + body.clientHeight >= body.scrollHeight - 1);
  };
  body.addEventListener('scroll', edges, { passive: true });
  detailAutoGrow(box, 5, () => detailPopReplace());
  detailLogClamp(box, () => detailPopReplace());
  requestAnimationFrame(edges);
}

// 결과 한 줄(확인 대기는 `답변 한 줄`)은 한 줄로 시작해 쓰는 만큼만 자라고, 다섯 줄을 넘으면 칸 안에서 스크롤한다.
function detailAutoGrow(box, maxLines, onGrow) {
  const area = box.querySelector('.d-dsec[data-sec="결과 한 줄"] .d-din, .d-dsec[data-sec="답변 한 줄"] .d-din');
  if (!area) return;
  area.rows = 1;
  const cap = 21 * maxLines + 20;
  let last = 0;
  const grow = () => {
    area.style.height = 'auto';
    const next = Math.min(area.scrollHeight, cap);
    area.style.height = `${next}px`;
    area.style.overflowY = area.scrollHeight > cap ? 'auto' : 'hidden';
    if (onGrow && next !== last) onGrow();
    last = next;
  };
  area.addEventListener('input', grow);
  grow();
}

// 확인 요청 기록은 최신 3개만 펴 두고 나머지는 조용한 링크 뒤에 둔다(카드가 길어지지 않게).
function detailLogClamp(box, onOpen) {
  const section = box.querySelector('.d-dsec[data-sec="확인 요청 기록"]');
  if (!section || section.querySelector('.d-logmore')) return;
  const lines = [...section.querySelectorAll('.d-logline')];
  if (lines.length <= 3) return;
  const hidden = lines.slice(3);
  hidden.forEach(line => { line.hidden = true; });
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'd-link d-logmore';
  more.textContent = `이전 기록 ${hidden.length}개 더 보기`;
  more.addEventListener('click', () => {
    hidden.forEach(line => { line.hidden = false; });
    more.remove();
    if (onOpen) onOpen();
  });
  hidden[hidden.length - 1].after(more);
}

function detailPopReplace() {
  if (!detailPopHost) return;
  if (detailPopFloat) { detailPopPlace(null); return; }
  const row = detailAnchorRow();
  if (row) detailPopPlace(row);
}

function detailPopPlace(row) {
  const host = detailPopHost;
  if (!host) return;
  const width = detailPopWidth();
  host.style.width = `${width}px`;
  const view = { width: window.innerWidth, height: window.innerHeight };
  const card = host.firstElementChild;
  if (card) card.style.maxHeight = `${Math.max(160, view.height - DETAIL_HDR - DETAIL_GAP * 2)}px`;
  const spot = detailPopPosition(row ? row.getBoundingClientRect() : null,
    { width, height: host.offsetHeight }, view, row ? detailPopSide(row) : 'center');
  host.style.left = `${spot.left}px`;
  host.style.top = `${spot.top}px`;
}

// 스크롤하면 줄을 따라간다(갑자기 사라지지 않게). 줄이 화면 밖으로 나가면 그때 닫는다.
function detailPopFollow() {
  if (detailPopTick) return;
  detailPopTick = requestAnimationFrame(() => {
    detailPopTick = 0;
    if (!detailPopHost || !panelState) return;
    if (detailSheet()) { panelRender(); return; } // 창이 아주 좁아졌으면 아래 시트로 바꿔 연다
    if (detailPopFloat) { detailPopPlace(null); return; }
    // 스크롤해서 닫히는 것은 사람이 닫은 것이 아니다 — 팔레트로 되돌아가지 않는다(찾던 자리가 갑자기 튀어나오지 않게).
    const drop = () => { panelState.back = null; panelClose(); };
    const row = detailAnchorRow();
    if (!row) { drop(); return; }
    const rect = row.getBoundingClientRect();
    if (rect.bottom < DETAIL_HDR || rect.top > window.innerHeight - 8) { drop(); return; }
    detailPopPlace(row);
  });
}

function detailPopOutside(event) {
  if (!detailPopHost || detailPopHost.contains(event.target)) return;
  // 회의 정리는 한참 붙들고 일하는 면이다 — 빈 자리를 눌렀다고 닫지 않는다(자리를 잃지 않게).
  if (panelState && panelState.kind === 'meeting') return;
  if (!event.target.closest) return;
  // 카드에서 연 메뉴·날짜 고르개·팔레트·설정 창은 카드의 일부다.
  if (event.target.closest('.d-menulist, .d-pal, dialog')) return;
  // 다른 줄을 누른 것이면 그 줄이 카드를 옮겨 간다(같은 줄이면 그 줄이 닫는다).
  if (event.target.closest('[data-task-id], [data-rail-id], [data-meeting-id]')) return;
  panelClose();
}

// 카드와 거기 붙은 감시를 모두 거둔다(종일 띄워 두는 앱이라 남기면 그대로 쌓인다).
function detailUnmount() {
  if (detailPopSize) { detailPopSize.disconnect(); detailPopSize = null; }
  if (detailPopTick) { cancelAnimationFrame(detailPopTick); detailPopTick = 0; }
  if (detailPopHost) { detailPopHost.remove(); detailPopHost = null; }
  detailPopFloat = false;
  document.removeEventListener('mousedown', detailPopOutside, true);
  window.removeEventListener('scroll', detailPopFollow, true);
  window.removeEventListener('resize', detailPopFollow);
}

// ---------- ⌘K 검색 팔레트 (검색 · 오늘 신규) ----------
// 큰 창 대신 위에서 내려오는 한 겹. 여기는 **찾는 창**이다 — 훑어보며 몰아서 정리하는 일은 `회의` 탭이 맡는다
// (DECISIONS 2026-09-22). 찾는 범위는 예전 통합 검색과 같다: 완료한 업무와 결과 한 줄,
// 결정·확인 대기·아이디어, 회의와 회의 초안 문구까지(외부 미팅 노트 전문은 찾지 않는다 — README와 같다).

const PAL_TYPES = [['', '전체'], ['task', '할 일'], ['check', '확인 대기'], ['decision', '결정'], ['idea', '아이디어'], ['meeting', '회의']];
const PAL_TAG = { task: '할 일', bug: '할 일', check: '확인 대기', decision: '결정', idea: '아이디어' };

let palState = null;
let palNodes = null;
let palEntries = [];

// 회의 전용 토글(`미완료만`·`초안 있음`)은 회의 탭으로 옮겼다 — 팔레트는 낱말로 찾기만 한다.
function palDefaults(state) {
  return { query: '', type: '', hideDone: false, newOnly: false, active: 0, scroll: 0, ...(state || {}) };
}

// 항목 거르기(순수 함수): 종류 · 완료 제외 · 오늘 신규 · 검색어. 회의는 palMeetings가 따로 본다.
// 검색어도 필터도 없으면 아무것도 돌려주지 않는다 — 팔레트는 그때 안내 문구만 보여 준다.
function palFilter(items, state) {
  if (state.type === 'meeting') return [];
  const query = (state.query || '').trim();
  if (!query && !state.newOnly) return [];
  const today = state.today || todayStr();
  return (items || []).filter((item) => {
    // `할 일`은 버그까지 함께 본다(목록에서도 한 종류로 다룬다).
    if (state.type === 'task' ? !['task', 'bug'].includes(item.type) : state.type && item.type !== state.type) return false;
    if (state.hideDone && item.status === 'done') return false;
    if (state.newOnly && item.created !== today) return false;
    if (!query) return true;
    return wfSearchMatches(query, [item.description, item.outcome, item.label, item.jira, item.group, item.project]);
  });
}

// 회의 거르기(순수 함수): 초안 있음 · 미완료만 · 오늘 신규 · 검색어(초안 문구와 이 회의에서 나온 항목까지).
// 검토할 초안이 있는 회의가 언제나 먼저 온다 — 지금 손댈 것이 위로.
// 팔레트는 검색어·종류만 넘기고, `초안 있음`·`미완료만`은 회의 탭(meetingsTabList)이 넘긴다.
// 미완료는 할 일·확인 대기만 센다 — 결정은 세지 않는다(meetingUnresolvedCount와 같은 기준).
function palMeetings(meetings, state, itemsOf) {
  if (state.type && state.type !== 'meeting') return [];
  const query = (state.query || '').trim();
  if (!query && state.type !== 'meeting') return [];
  const today = state.today || todayStr();
  const related = typeof itemsOf === 'function' ? itemsOf : () => [];
  return (meetings || []).filter((event) => {
    if (state.reviewOnly && !(event.drafts && event.drafts.length)) return false;
    if (state.unresolved && meetingUnresolvedCount(event, related) === 0) return false;
    if (state.newOnly && event.date !== today) return false;
    if (!query) return true;
    return wfSearchMatches(query, [event.title, event.series, event.date, event.project?.label,
      ...(event.drafts || []).map(draft => draft.description), ...related(event.id).map(item => item.description)]);
  }).sort((a, b) => ((b.drafts && b.drafts.length) ? 1 : 0) - ((a.drafts && a.drafts.length) ? 1 : 0) || wfMeetingOrder(a, b));
}

// 일치한 글자만 형광으로. 사람이 쓴 글자는 먼저 escape하고, 그 결과에만 <mark>를 끼운다.
function palHighlight(text, query) {
  const source = String(text || '');
  const words = String(query || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return escapeHtml(source);
  const lower = source.toLocaleLowerCase();
  const found = [];
  words.forEach((word) => {
    const needle = word.toLocaleLowerCase();
    let at = needle ? lower.indexOf(needle) : -1;
    while (at >= 0) { found.push([at, at + needle.length]); at = lower.indexOf(needle, at + needle.length); }
  });
  if (!found.length) return escapeHtml(source);
  found.sort((a, b) => a[0] - b[0]);
  const ranges = [];
  found.forEach((range) => {
    const last = ranges[ranges.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else ranges.push([range[0], range[1]]);
  });
  let html = '';
  let at = 0;
  ranges.forEach(([start, end]) => {
    html += escapeHtml(source.slice(at, start)) + `<mark class="d-mark">${escapeHtml(source.slice(start, end))}</mark>`;
    at = end;
  });
  return html + escapeHtml(source.slice(at));
}

function palList() {
  const data = typeof workflowData === 'object' && workflowData ? workflowData : { items: [], meetings: [] };
  const itemsOf = typeof wfMeetingItems === 'function' ? wfMeetingItems : null;
  return [
    ...palFilter(data.items, palState).map(item => ({ kind: 'item', item })),
    ...palMeetings(data.meetings, palState, itemsOf).map(event => ({ kind: 'meeting', event })),
  ];
}

// 결과 한 줄: 종류 | (회의는 날짜·시각) | 제목 | 프로젝트 | 상태·기한. 의미 없는 값은 자리를 비운다.
function palResultRow(entry, index, query) {
  const row = document.createElement('div');
  row.className = 'd-pres' + (entry.kind === 'meeting' ? ' is-mtg' : '') + (index === palState.active ? ' is-sel' : '');
  row.id = `palopt-${index}`;
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', String(index === palState.active));
  const cell = (className, html, title) => {
    const span = document.createElement('span');
    span.className = className;
    if (html) span.innerHTML = html;
    if (title) span.title = title;
    row.appendChild(span);
    return span;
  };
  // 제목 + 그 뒤에 붙는 `· ● 프로젝트`(10번 규칙). 프로젝트가 없으면 제목만 남는다.
  // 줄 안의 짧은 표기라 지라는 요약만(모르면 키) — 전체 `KEY · 요약`은 title 툴팁에, 색 점은 원래 키로.
  const titleCell = (html, text, projectItem) => {
    const wrap = cell('tiwrap');
    const title = document.createElement('span');
    title.className = 'ti';
    title.innerHTML = html;
    title.title = text;
    wrap.appendChild(title);
    const short = projectItem ? uiProjectName(projectItem) : '';
    if (!short) return;
    const tag = document.createElement('span');
    tag.className = 'pj';
    tag.title = uiProjectName(projectItem, { withKey: true });
    const name = document.createElement('span');
    name.className = 'nm';
    name.textContent = short;
    tag.append('· ', uiProjectDot(uiProjectColorKey(projectItem)), name);
    wrap.appendChild(tag);
  };
  if (entry.kind === 'meeting') {
    const event = entry.event;
    // 미완료는 할 일·확인 대기만 센다 — 회의 탭·줄 배지와 같은 기준(meetingUnresolvedCount).
    const open = meetingUnresolvedCount(event, typeof wfMeetingItems === 'function' ? wfMeetingItems : null);
    const state = [];
    if (event.drafts && event.drafts.length) state.push(`초안 ${event.drafts.length} 검토`);
    if (open) state.push(`미완료 ${open}`);
    const when = `${uiKoDateShort(event.date)}${event.start ? ` · ${event.start}` : ''}`;
    cell('tag', '회의');
    cell('when num', escapeHtml(when));
    titleCell(palHighlight(event.title, query), event.title, typeof wfMeetingProjectItem === 'function' ? wfMeetingProjectItem(event) : null);
    cell('st', escapeHtml(state.join(' · ')));
    row.setAttribute('aria-label', `회의 ${when} ${event.title}`);
  } else {
    const item = entry.item;
    const due = item.status === 'done' ? null : uiItemDueText(item);
    const status = item.status === 'done' ? { text: '완료', tone: '' } : due || (item.doing ? { text: '진행 중', tone: '' } : null);
    cell('tag', escapeHtml(PAL_TAG[item.type] || item.type || ''));
    titleCell(palHighlight(item.description, query), item.description, item);
    cell(`st${status ? uiTone(status.tone) : ''}`, status ? escapeHtml(status.text) : '');
    row.setAttribute('aria-label', `${PAL_TAG[item.type] || ''} ${item.description}`);
  }
  row.addEventListener('click', () => palPick(index));
  return row;
}

// 필터 칩 줄. 여기서만 알약 모양을 쓴다(지금 고른 것을 한눈에 보여 주는 자리라서).
function palFilterChips() {
  const bar = palNodes.chips;
  bar.replaceChildren();
  const chip = (text, on, onPick, host = bar) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'd-chip' + (on ? ' is-on' : '');
    button.textContent = text;
    button.setAttribute('aria-pressed', String(!!on));
    button.addEventListener('click', () => { onPick(); palRender(); palNodes.input.focus(); });
    host.appendChild(button);
  };
  // 종류는 회색 트랙 위에 나란히 선다 — 고른 하나만 연파랑.
  const track = document.createElement('span');
  track.className = 'd-palseg';
  bar.appendChild(track);
  PAL_TYPES.forEach(([value, text]) => chip(text, palState.type === value, () => {
    palState.type = value;
    palState.active = 0;
  }, track));
  chip('완료 제외', palState.hideDone, () => { palState.hideDone = !palState.hideDone; palState.active = 0; });
  if (palState.newOnly) {
    const pill = document.createElement('span');
    pill.className = 'd-chip is-on d-palnew';
    pill.append('오늘 신규');
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'd-iconbtn sm';
    clear.setAttribute('aria-label', '오늘 신규 필터 지우기');
    clear.innerHTML = uiIcon('close');
    clear.addEventListener('click', () => { palState.newOnly = false; palState.active = 0; palRender(); palNodes.input.focus(); });
    pill.appendChild(clear);
    bar.appendChild(pill);
  }
}

function palRenderResults() {
  if (!palState || !palNodes) return;
  const query = (palState.query || '').trim();
  palEntries = palList();
  if (palState.active >= palEntries.length) palState.active = Math.max(0, palEntries.length - 1);
  const box = palNodes.results;
  box.replaceChildren();
  if (!palEntries.length) {
    const empty = document.createElement('div');
    empty.className = 'd-empty';
    empty.textContent = query || palState.newOnly || palState.type === 'meeting'
      ? '찾는 항목이 없어요.'
      : '찾을 내용을 적어 보세요. 완료한 업무와 회의 초안 문구까지 함께 찾아요.';
    box.appendChild(empty);
    palNodes.input.removeAttribute('aria-activedescendant');
    return;
  }
  palEntries.forEach((entry, index) => box.appendChild(palResultRow(entry, index, query)));
  palNodes.input.setAttribute('aria-activedescendant', `palopt-${palState.active}`);
}

function palRender() {
  if (!palState || !palNodes) return;
  palFilterChips();
  palFoot();
  palRenderResults();
}

// 바닥 안내 줄. `회의` 칩을 골랐을 때만 훑어보는 자리로 가는 조용한 링크를 오른쪽에 붙인다.
function palFoot() {
  const foot = palNodes.foot;
  foot.replaceChildren();
  foot.append('↑↓ 이동 · Enter 열기 · Esc 닫기');
  if (palState.type !== 'meeting') return;
  const link = document.createElement('button');
  link.type = 'button';
  link.className = 'd-link';
  link.textContent = '회의 탭에서 모두 보기';
  link.addEventListener('click', () => { palClose(true); openMeetingsTab(null); });
  foot.appendChild(link);
}

// load()가 끝날 때마다 불린다. 입력칸은 손대지 않고 결과 줄만 새로 그린다(적던 검색어가 날아가지 않게).
function palSync() {
  if (palState && palNodes) palRenderResults();
}

function palMove(step) {
  if (!palEntries.length) return;
  palState.active = (palState.active + step + palEntries.length) % palEntries.length;
  palRenderResults();
  palNodes.results.querySelector('.d-pres.is-sel')?.scrollIntoView({ block: 'nearest' });
}

// 지금 보고 있던 검색어·필터·스크롤·활성 줄. 열었던 항목을 닫으면 이 상태로 팔레트가 다시 열린다.
function palSnapshot() {
  return { ...palState, scroll: palNodes ? palNodes.results.scrollTop : 0 };
}

function palPick(index) {
  const entry = palEntries[index];
  if (!entry) return;
  const back = { kind: 'palette', state: palSnapshot() };
  // 상세·회의 정리 카드는 누른 줄에 붙어 있다 — 다른 탭으로 옮겨 가면 함께 닫거나 옮긴다.
  if (entry.kind === 'meeting') {
    const id = entry.event.id;
    palClose(true);
    // 회의는 제 자리(회의 탭)에서 연다 — 몰아서 정리하는 면이라 팔레트로 되돌아가는 규칙은 쓰지 않는다.
    openMeetingsTab(id);
    return;
  }
  const item = entry.item;
  palClose(true);
  if (item.type === 'decision' || item.type === 'idea') { palRevealRecord(item); return; }
  setActiveTab('today');
  panelOpen({ id: item.id, back });
}

// 결정·아이디어는 상세 카드가 없다 — 아이디어·결정 탭의 그 줄로 옮겨 가 잠깐 밝힌다.
function palRevealRecord(item) {
  setActiveTab('records');
  // 좁은 창에서는 세그먼트로 한쪽만 보인다 — 밝힐 항목이 있는 쪽을 연다.
  recordSetView(item.type === 'idea' ? 'idea' : 'decision');
  // 반영 완료는 접혀 있다 — 그 안의 결정을 고르면 먼저 펼친다.
  if (item.status === 'done' && !decisionArchiveOpen) {
    decisionArchiveOpen = true;
    renderDecisionArchive();
  }
  const row = document.querySelector(`#gridRecords [data-item-id="${CSS.escape(String(item.id))}"]`);
  if (!row) { announce(`${item.description} — 아이디어·결정 목록에서 찾아 주세요.`); return; }
  row.scrollIntoView({ block: 'center' });
  row.classList.add('is-flash');
  setTimeout(() => row.classList.remove('is-flash'), 1600);
}

function palOpen(state) {
  const opener = document.activeElement;
  // 더보기 메뉴가 열려 있으면 먼저 닫는다(떠 있는 층은 한 번에 하나).
  uiMenuClose();
  const reopening = !!palState;
  if (palState) palClose(true);

  palState = palDefaults(state);
  if (!palState.returnFocus) {
    palState.returnFocus = !reopening && opener && opener !== document.body && opener.focus
      ? opener
      : document.getElementById('searchEntryBtn');
  }

  const root = document.createElement('div');
  root.className = 'd-pal';
  const box = document.createElement('div');
  box.className = 'd-palbox';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-label', '검색');

  const bar = document.createElement('div');
  bar.className = 'd-palin';
  bar.insertAdjacentHTML('beforeend', uiIcon('search'));
  const input = document.createElement('input');
  input.type = 'text';
  input.id = 'palInput';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.value = palState.query || '';
  input.placeholder = '할 일, 확인 대기, 결정, 아이디어, 회의 검색';
  input.setAttribute('aria-label', '검색어');
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-controls', 'palResults');
  input.setAttribute('aria-autocomplete', 'list');
  bar.appendChild(input);

  const chips = document.createElement('div');
  chips.className = 'd-palfil';
  chips.setAttribute('role', 'group');
  chips.setAttribute('aria-label', '검색 범위');

  const results = document.createElement('div');
  results.className = 'd-palres';
  results.id = 'palResults';
  results.setAttribute('role', 'listbox');
  results.setAttribute('aria-label', '검색 결과');

  const foot = document.createElement('div');
  foot.className = 'd-palfoot'; // 안내 글자와 `회의 탭에서 모두 보기` 링크는 palFoot이 채운다

  box.append(bar, chips, results, foot);
  root.appendChild(box);
  document.body.appendChild(root);
  palNodes = { root, box, input, chips, results, foot };

  root.addEventListener('mousedown', (event) => { if (!event.target.closest('.d-palbox')) palClose(); });
  // 한 글자마다 목록을 통째로 다시 그리지 않게, 입력이 멎은 뒤 한 번만 그린다(한글 조합은 끊기지 않는다).
  const later = wfDebounce(() => palRenderResults());
  input.addEventListener('input', () => {
    if (!palState) return;
    palState.query = input.value;
    palState.active = 0;
    later();
  });
  input.addEventListener('keydown', (event) => {
    if (event.isComposing) return; // 한글을 조합하는 중의 Enter는 글자를 확정하는 것이다
    if (event.key === 'ArrowDown') { event.preventDefault(); palMove(1); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); palMove(-1); return; }
    if (event.key === 'Enter') { event.preventDefault(); palPick(palState.active); }
  });
  // 팔레트가 열려 있는 동안 Tab은 그 안에서만 돈다.
  box.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const focusable = [...box.querySelectorAll('input, button:not([disabled])')];
    if (!focusable.length) return;
    const at = focusable.indexOf(document.activeElement);
    const next = event.shiftKey ? at - 1 : at + 1;
    if (at >= 0 && next >= 0 && next < focusable.length) return;
    event.preventDefault();
    focusable[event.shiftKey ? focusable.length - 1 : 0].focus();
  });

  escPush(palClose);
  palRender();
  results.scrollTop = palState.scroll || 0;
  input.focus();
  input.setSelectionRange?.(input.value.length, input.value.length);
}

function palClose(silent) {
  if (!palState) return;
  const back = palState.returnFocus;
  const root = palNodes?.root;
  palState = null;
  palNodes = null;
  palEntries = [];
  escDrop(palClose);
  if (root) root.remove();
  if (!silent && back && back.isConnected) back.focus();
}

// `새로 들어온 것` 제목 오른쪽 끝의 조용한 글자 버튼 — 오늘 들어온 것만 팔레트로 모아 본다.
// 0이면 아예 보이지 않는다.
function renderInboxHeadCount(count) {
  const button = document.getElementById('createdTodayBtn');
  const cell = document.getElementById('createdTodayCount');
  if (cell) cell.textContent = count;
  if (button) button.hidden = !count;
}

// 슬랙에서 갓 들어온 할 일. 오늘 할지 나중에 할지는 여기서 직접 고른다.
// 비어 있으면 섹션 자체를 숨겨서, 처리할 게 있을 때만 눈에 띄게 한다.
function renderInbox(items) {
  const zone = document.getElementById('inboxZone');
  const list = document.getElementById('inboxList');
  document.getElementById('inboxCount').textContent = items.length;
  zone.hidden = items.length === 0;
  list.replaceChildren();
  if (!items.length) return;

  items.forEach(item => {
    const row = document.createElement('div');
    row.className = 'd-ibrow';

    const main = document.createElement('span');
    main.className = 'd-ibmain';
    const title = document.createElement('span');
    title.className = 'ti';
    title.textContent = item.description;
    makeEditableDesc(title, item);
    // 말줄임으로 잘린 문구도 마우스를 올리면 전부 읽을 수 있게(수정 안내는 aria-label이 한다).
    title.title = item.description;
    if (item.isNew) { title.prepend(renderNewDot(item)); observeNewItem(row, item); }
    main.appendChild(title);
    // 프로젝트가 있으면 제목 뒤에 조용한 표기(다른 줄과 같은 uiInlineProject) — 없으면 지어내지 않는다.
    if (item.jira || item.group || item.project) main.appendChild(uiInlineProject(item));
    // 원문은 그 뒤에 늘 보인다(다른 줄과 같은 조용한 `원문` 링크).
    const source = uiSourceLink(item);
    if (source) main.appendChild(source);
    row.appendChild(main);

    const actions = document.createElement('span');
    actions.className = 'd-ibacts';
    const choose = (label, onClick, cls = '') => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `d-btn sm ${cls}`.trim();
      button.textContent = label;
      button.setAttribute('aria-label', `${item.description} — ${label}`);
      button.addEventListener('click', onClick);
      actions.appendChild(button);
    };

    // 줄에는 자주 쓰는 세 갈래만 늘 보인다 — 오늘 / 나중에 / 완료.
    choose('오늘', () => fadeOutAndRun(row, () => setTaskScheduled(item.id, todayStr()), '오늘 할 일로 옮겼어요'));
    choose('나중에', () => fadeOutAndRun(row, () => setTaskScheduled(item.id, null), '나중에 할 일로 옮겼어요'));
    // 완료는 기록이 남고(주간요약에 들어감), 삭제는 남지 않는다 — 삭제는 ⋯ 안으로 들어갔다.
    choose('완료', () => fadeOutAndRun(row, () => toggleTask(item.id), '완료했어요'));

    // 값을 정하는 것과 삭제는 ⋯ 안에 있다. 아직 분류 전이라도 기한·우선순위가 분명한 건은 미리 정해 둘 수 있다.
    actions.appendChild(uiMoreButton(`${item.description} — 더 보기`, () => [
      [
        { field: '프로젝트', control: taskProjectControl(item) },
        {
          field: '기한',
          control: uiDateField({
            value: item.due,
            label: '기한',
            onChange: async (value) => {
              await setTaskDue(item.id, value);
              announce(value ? `기한을 ${uiKoDate(value)}로 정했어요` : '기한을 지웠어요');
            },
          }),
        },
        { field: '우선순위', control: taskPriorityControl(item) },
      ],
      [{
        label: '삭제',
        danger: true,
        onClick: () => fadeOutAndRun(row, async () => {
          await request('/api/track/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: item.id }),
          });
          load();
        }, '삭제했어요'),
      }],
    ]));

    row.appendChild(actions);
    list.appendChild(row);
  });
}

// 오늘 할 일 카드 윗변을 따라 흐르는 3px 선. 카드 모서리에 맞춰 잘리도록 카드를 덮는
// 투명한 판 안에 둔다(판이 둥글게 잘라 준다). 할 일이 없으면 선도 없다.
function renderTodayProgress(done, total) {
  const card = document.getElementById('todayListSurface');
  if (!card) return;
  let bar = card.querySelector(':scope > .d-topprog');
  if (!total) { if (bar) bar.remove(); return; }
  if (!bar) {
    bar = document.createElement('span');
    bar.className = 'd-topprog';
    bar.setAttribute('aria-hidden', 'true');
    bar.appendChild(document.createElement('i'));
    card.prepend(bar);
  }
  bar.firstChild.style.setProperty('--p', `${Math.round((done / total) * 100)}%`);
}

function renderTodayTasks(items) {
  const doneItems = items.filter(item => item.status === 'done');
  document.getElementById('todayTaskCount').textContent = items.length - doneItems.length;
  // 한 마디로 오늘의 진행을 알려 준다. 아직 아무것도 없으면 아무 말도 하지 않는다.
  document.getElementById('todayDoneSummary').textContent = items.length ? `${items.length}개 중 ${doneItems.length}개 끝냈어요` : '';
  renderTodayProgress(doneItems.length, items.length);
  const list = document.getElementById('todayTaskList');
  list.replaceChildren();

  // 진행 중인 건 프로젝트·우선순위와 무관하게 항상 맨 위에 따로 모은다
  const doing = items.filter(item => item.status !== 'done' && item.doing);
  const active = items.filter(item => item.status !== 'done' && !item.doing);

  if (doing.length) {
    list.appendChild(uiGroupHeading('진행 중', doing.length, { tone: 'doing' }));
    [...doing].sort(compareTasks).forEach(item => list.appendChild(uiTaskRow(item, { mode: 'today', inDoingGroup: true })));
  }

  if (todaySort === 'priority') {
    // 마감·중요도순은 한 줄기로 본다 — 프로젝트 제목이 있으면 훑는 순서가 깨진다.
    if (active.length) {
      list.appendChild(uiGroupHeading('마감·중요도순', active.length, {}));
      [...active].sort(compareTasks).forEach(item => list.appendChild(uiTaskRow(item, { mode: 'today' })));
    }
  } else {
    const groups = uiGroupTasks(active);
    const labels = uiGroupLabels(groups.map(([key]) => key));
    groups.forEach(([key, groupItems]) => {
      const addRow = uiGroupAddRow(key, '/api/today-task/create', '오늘 할 일에 추가했어요');
      const heading = uiGroupHeading(labels.get(key), groupItems.length, {
        projectName: key === '__misc__' ? null : key,
        onAdd: () => { addRow.hidden = false; addRow.querySelector('input').focus(); },
        onOpenProject: key === '__misc__' ? null : () => openProjectTab(key),
      });
      list.append(heading, addRow);
      [...groupItems].sort(compareTasks).forEach(item => list.appendChild(uiTaskRow(item, { mode: 'today', grouped: key !== '__misc__' })));
    });
  }

  if (!active.length && !doing.length) {
    list.insertAdjacentHTML('beforeend', doneItems.length
      ? '<div class="d-empty">오늘 할 일을 모두 끝냈어요.</div>'
      : '<div class="d-empty">오늘 할 일이 비었어요. 맨 위 줄에서 바로 추가할 수 있어요.</div>');
  }

  if (doneItems.length) {
    list.appendChild(uiGroupHeading('완료', doneItems.length, {
      open: todayDoneOpen,
      onToggle: () => { todayDoneOpen = !todayDoneOpen; renderTodayTasks(items); },
    }));
    if (todayDoneOpen) doneItems.forEach(item => list.appendChild(uiTaskRow(item, { mode: 'today' })));
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;');
}

function makeEditableDesc(el, item) {
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  el.setAttribute('aria-label', `${item.description} — 수정`);
  el.title = '클릭 또는 Enter로 수정';
  el.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); el.click(); }
  });
  el.classList.add('desc-editable');
  el.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'desc-edit-input';
    input.value = item.description;
    input.setAttribute('aria-label', `${item.description} — 내용 수정`);
    el.replaceWith(input);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    let committed = false;
    const commit = async () => {
      if (committed) return;
      committed = true;
      const val = input.value.trim();
      if (val && val !== item.description) {
        input.disabled = true;
        try {
          await request('/api/track/set-description', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: item.id, description: val }),
          });
          announce('내용을 고쳤어요');
          await load();
        } catch { committed = false; }
        finally { input.disabled = false; }
      } else {
        input.replaceWith(el);
      }
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') { committed = true; input.replaceWith(el); }
    });
  });
}

// "NEW"는 이제 누르는 버튼이 아니라 그냥 표시다 — 화면에 잠깐이라도 실제로 보이면
// 조용히 알아서 사라진다(아래 observeNewItem). 액션을 안 해도, 그냥 훑어보기만 해도 없어진다.
function renderNewDot(item) {
  const dot = document.createElement('span');
  dot.className = 'new-dot';
  dot.innerHTML = `<span class="sr-only">${escapeHtml(item.description)} — 새로 들어옴</span>`;
  return dot;
}

// 카드가 화면에 실제로 보이는 동안(스쳐 지나가는 스크롤 말고) 일정 시간 머물면
// "확인함"으로 조용히 저장한다. 다시 그려질 때마다(load()) 카드가 새로 만들어지니
// 관찰자 하나를 계속 재사용하고, 타이머는 카드별로 관리한다.
let newItemObserver = null;
const newItemTimers = new Map();
function getNewItemObserver() {
  if (newItemObserver) return newItemObserver;
  newItemObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      const id = entry.target.dataset.newItemId;
      if (!id) return;
      if (entry.isIntersecting) {
        if (newItemTimers.has(id)) return;
        newItemTimers.set(id, setTimeout(async () => {
          newItemTimers.delete(id);
          newItemObserver.unobserve(entry.target);
          try {
            // NEW는 조용히 사라져야 한다 — 저장 알림을 띄우지 않는다(quiet).
            await request('/api/track/seen', { method: 'POST', quiet: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
            const dot = entry.target.querySelector('.new-dot');
            if (dot) dot.remove();
          } catch {}
        }, 1500));
      } else if (newItemTimers.has(id)) {
        clearTimeout(newItemTimers.get(id));
        newItemTimers.delete(id);
      }
    });
  }, { threshold: 0.6 });
  return newItemObserver;
}

function observeNewItem(card, item) {
  card.dataset.newItemId = item.id;
  getNewItemObserver().observe(card);
}

async function fadeOutAndRun(card, action, message) {
  if (card.getAttribute('aria-busy') === 'true') return;
  card.setAttribute('aria-busy', 'true');
  try {
    await action();
    if (message) announce(message);
  } catch {
    card.querySelectorAll('input[type="checkbox"]').forEach(input => { input.checked = card.classList.contains('done'); });
  } finally { card.removeAttribute('aria-busy'); }
}

function announce(text) {
  showNotice(text);
}

async function toggleTask(id) {
  const source = itemsById.get(id) || wfItem(id);
  await request('/api/track/toggle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, status: source?.status === 'done' ? 'to-do' : 'done' }),
  });
  await load();
}

// 그룹 선택 목록의 <option> HTML. head는 처음부터 보이는 항목, rest는 지라·그룹·직접 입력.
function groupSelectOptions(current, forceClearable) {
  const head = [`<option value="">그룹 지정…</option>`];
  // 여러 개를 한 번에 옮길 땐 "현재 그룹"이라는 게 없어도(current === null) 해제를 고를 수 있어야 한다.
  if (current || forceClearable) head.push(`<option value="__clear__">— 그룹 해제 —</option>`);
  const rest = [];
  // `그 밖의 이슈`(extra = 지라에서 완료됐거나 담당이 바뀐 것)는 새로 고를 수 있는 선택지로 내놓지
  // 않는다 — 요약을 보여 주려고 들고 있을 뿐이다. 다만 지금 걸려 있는 값이면 골라진 채로 보여야 한다.
  // 고르는 자리라 `요약 · 키`(BKEY 결정) — 눈이 먼저 가는 앞자리는 요약이고, 정렬도 요약 기준이다.
  rest.push(...jiraIssuesCache
    .filter(i => !i.extra || (current && current.type === 'jira' && current.value === i.key))
    .slice()
    .sort((a, b) => String(a.summary || a.key).localeCompare(String(b.summary || b.key)))
    .map(i => {
      const selected = current && current.type === 'jira' && current.value === i.key;
      const text = i.summary ? `${i.summary} · ${i.key}` : i.key;
      return `<option value="jira:${escapeAttr(i.key)}"${selected ? ' selected' : ''}>${escapeHtml(text)}</option>`;
    }));
  rest.push(...customGroupsCache.map(g => {
    const selected = current && current.type === 'group' && current.value === g;
    return `<option value="group:${escapeAttr(g)}"${selected ? ' selected' : ''}>${escapeHtml(g)}</option>`;
  }));
  rest.push(`<option value="__custom__">직접 입력…</option>`);
  return { head, rest };
}

function renderGroupControl({ jira, group, onSetJira, onSetGroup, forceClearable = false, silent = false }) {
  const wrap = document.createElement('div');
  wrap.className = 'jira-control';

  function buildSelect(current, revertTo, defer = false) {
    const select = document.createElement('select');
    select.className = 'jira-select';
    select.setAttribute('aria-label', '그룹 지정');
    const { head, rest } = groupSelectOptions(current, forceClearable);
    select.innerHTML = defer ? head.join('') : head.concat(rest).join('');
    // 그룹이 있는 카드는 뱃지를 눌러야 목록을 만든다 — 그룹 없는 카드도 같게, 처음 건드릴 때
    // 지라·그룹 항목을 채운다. 접혀 있을 때 보이는 "그룹 지정…"과 차례·동작은 그대로다.
    if (defer) {
      let filled = false;
      const fill = () => {
        if (filled) return;
        filled = true;
        const parsed = document.createElement('select');
        parsed.innerHTML = rest.join('');
        const anchor = select.children[head.length] || null;
        while (parsed.firstChild) select.insertBefore(parsed.firstChild, anchor);
      };
      ['mousedown', 'focus', 'keydown'].forEach((name) => select.addEventListener(name, fill));
    }
    select.addEventListener('click', (e) => e.stopPropagation());
    let committed = false;
    select.addEventListener('change', () => {
      committed = true;
      if (select.value === '__clear__') {
        (async () => {
          await onSetJira(null);
          await onSetGroup(null);
          if (!silent) { announce('그룹을 지웠어요'); load(); }
        })();
        return;
      }
      if (select.value === '__custom__') {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'group-input';
        input.placeholder = '그룹명 입력 후 Enter';
        let inputCommitted = false;
        input.addEventListener('click', (e) => e.stopPropagation());
        input.addEventListener('keydown', async (e2) => {
          if (e2.key === 'Escape') {
            inputCommitted = true;
            if (revertTo && wrap.contains(input)) wrap.replaceChild(revertTo, input);
            return;
          }
          if (e2.key !== 'Enter') return;
          const v = input.value.trim();
          if (!v) return;
          inputCommitted = true;
          await onSetGroup(v);
          if (!silent) { announce('그룹을 지정했어요'); load(); }
        });
        input.addEventListener('blur', () => {
          if (inputCommitted) return;
          if (revertTo && wrap.contains(input)) wrap.replaceChild(revertTo, input);
        });
        wrap.replaceChild(input, select);
        input.focus();
        return;
      }
      if (!select.value) { committed = false; return; }
      if (select.value.startsWith('group:')) {
        const g = select.value.slice('group:'.length);
        (async () => {
          await onSetGroup(g);
          if (!silent) { announce('그룹을 지정했어요'); load(); }
        })();
        return;
      }
      const key = select.value.replace(/^jira:/, '');
      (async () => {
        await onSetJira(key);
        if (!silent) { announce('지라 이슈를 연결했어요'); load(); }
      })();
    });
    select.addEventListener('blur', () => {
      if (committed) return;
      if (revertTo && wrap.contains(select)) wrap.replaceChild(revertTo, select);
    });
    return select;
  }

  // 이미 지정된 지라·그룹은 배지로 보이고, 누르면 같은 자리에서 선택 목록으로 바뀐다.
  // keyText가 있으면(지라뿐) 요약 뒤에 조용한 회색 글자로 키를 덧붙인다(BKEY 결정 — 상세 카드의 값 표시).
  const appendBadge = (className, label, current, keyText) => {
    const badge = document.createElement('button');
    badge.type = 'button';
    badge.className = className;
    badge.textContent = label;
    if (keyText) {
      const key = document.createElement('span');
      key.className = 'k-mute';
      key.textContent = ` ${keyText}`;
      badge.appendChild(key);
    }
    badge.setAttribute('aria-label', `${label}${keyText ? ` ${keyText}` : ''} — 클릭해서 변경/해제`);
    badge.addEventListener('click', (e) => {
      e.stopPropagation();
      const select = buildSelect(current, badge);
      wrap.replaceChild(select, badge);
      select.focus();
    });
    wrap.appendChild(badge);
    return wrap;
  };

  if (jira) {
    const issue = jiraIssuesCache.find(i => i.key === jira);
    const summary = issue ? issue.summary : '';
    return appendBadge('badge jira-badge', summary || jira, { type: 'jira', value: jira }, summary ? jira : null);
  }

  if (group) return appendBadge('badge group-badge', group, { type: 'group', value: group });

  wrap.appendChild(buildSelect(null, undefined, true));
  return wrap;
}

async function setTaskGroup(id, group) {
  await request('/api/track/set-group', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, group }),
  });
}

async function setTaskDoing(id, doing) {
  await request('/api/track/set-doing', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, doing }),
  });
  load();
}

async function setTaskDue(id, due) {
  await request('/api/track/set-due', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, due }),
  });
  load();
}

async function setTaskScheduled(id, scheduled) {
  await request('/api/track/set-scheduled', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, scheduled }),
  });
  await load();
}

async function setPriority(id, priority) {
  await request('/api/track/set-priority', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, priority }),
  });
}

async function setIdeaProject(id, project) {
  await request('/api/idea/set-project', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, project }),
  });
}

async function setTaskJira(id, jiraKey) {
  await request('/api/track/set-jira', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, jiraKey }),
  });
}

function setupQuickAdd(inputId, endpoint, announceText) {
  const input = document.getElementById(inputId);
  input.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter' || e.isComposing || input.disabled) return;
    const description = input.value.trim();
    if (!description) return;
    input.disabled = true;
    try {
      await request(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description }),
      });
      input.value = '';
      announce(announceText);
      await load();
    } catch { /* Keep the draft for retry. */ }
    finally { input.disabled = false; input.focus(); }
  });
}

// ---- client.test.js는 이 줄 위까지만 읽는다 (아래는 화면을 실제로 켜는 실행 코드) ----
setupQuickAdd('todayTaskInput', '/api/today-task/create', '오늘 할 일에 추가했어요');
setupQuickAdd('laterTaskInput', '/api/later-task/create', '나중에 할 일에 추가했어요');
setupQuickAdd('waitingInput', '/api/waiting/create', '확인 대기에 추가했어요');
setupQuickAdd('ideaInput', '/api/idea/create', '아이디어에 추가했어요');
setupQuickAdd('decisionInput', '/api/decision/create', '결정에 추가했어요');
// 한 글자마다 목록을 전부 다시 만들면 길수록 입력이 밀린다 — 입력이 멎은 뒤 한 번만 다시 그린다.
// 조합 중에도 input은 그대로 오고 값을 늦게 읽을 뿐이라 한글 입력은 끊기지 않는다.
// 입력칸 자체는 다시 만들지 않는다(renderDecisions/renderDecisionArchive는 목록 자리만 다시 그린다).
let decisionSearchTimer = null;
document.getElementById('decisionSearch').addEventListener('input', (event) => {
  decisionQuery = event.target.value.trim().toLowerCase();
  clearTimeout(decisionSearchTimer);
  decisionSearchTimer = setTimeout(() => { renderDecisions(decisionCache); renderDecisionArchive(); }, 150);
});
// 반영 완료는 접힌 채로 시작한다. 결정 찾기 중에는(renderDecisionArchive가) 자동으로 펼친다.
document.getElementById('decisionArchiveToggle').addEventListener('click', () => {
  decisionArchiveOpen = !decisionArchiveOpen;
  renderDecisionArchive();
});
// 좁은 창의 세그먼트 — 정적으로 한 번만 만든 버튼이라 리스너도 한 번만 단다.
document.querySelectorAll('#recordViewSeg [data-record-view]').forEach((button) => {
  button.addEventListener('click', () => recordSetView(button.dataset.recordView));
});
recordViewRestore();
recordApplyView();

try { todaySort = localStorage.getItem('todaySort') || 'project'; } catch {}
// 보기 전환은 머리줄 ⋯ 메뉴 안의 두 칸 칩이다. 고른 값은 브라우저에 그대로 기억한다(저장 키·동작 그대로).
const todayViewSeg = document.getElementById('todayViewSeg');
function renderTodayViewSeg() {
  todayViewSeg?.querySelectorAll('button').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.view === todaySort));
  });
}
function setTodaySort(value) {
  if (todaySort === value) return;
  todaySort = value;
  try { localStorage.setItem('todaySort', todaySort); } catch {}
  renderTodayViewSeg();
  load();
}
todayViewSeg?.querySelectorAll('button').forEach((button) => {
  button.addEventListener('click', () => setTodaySort(button.dataset.view));
});
renderTodayViewSeg();

// 오늘 할 일 머리줄의 ⋯ — 보기 전환과 여러 개 선택이 이 안에 있다(눌러 보는 건 하나뿐).
const todayHeadMoreSlot = document.getElementById('todayHeadMore');
if (todayHeadMoreSlot) {
  todayHeadMoreSlot.appendChild(uiMoreButton('오늘 할 일 보기와 도구', () => [
    [{
      field: '보기',
      control: uiMenuChips([['project', '프로젝트별'], ['priority', '마감·중요도순']], todaySort, (value) => {
        uiMenuClose();
        setTodaySort(value);
      }),
    }],
    [{
      label: taskSelectionMode ? '선택 끝내기' : '여러 개 선택',
      disabled: taskBatchBusy,
      onClick: () => { if (taskSelectionMode) taskSelectEnd(); else taskSelectStart(); },
    }],
  ], 'd-iconbtn sm d-headmore'));
}

// 확인 대기 카드 머리의 ⋯ — 보기 전환(프로젝트별/급한 순)만 있다(눌러 보는 건 하나뿐).
const waitingHeadMoreSlot = document.getElementById('waitingHeadMore');
if (waitingHeadMoreSlot) {
  waitingHeadMoreSlot.appendChild(uiMoreButton('확인 대기 보기', () => [
    [{
      field: '보기',
      control: uiMenuChips([['project', '프로젝트별'], ['urgent', '급한 순']], waitingView, (value) => {
        uiMenuClose();
        setWaitingView(value);
      }),
    }],
  ], 'd-iconbtn sm d-headmore'));
}

// 검색 팔레트를 여는 두 자리: 헤더의 `검색 ⌘K` 버튼, `새로 들어온 것` 제목 옆 `오늘 신규 N`.
document.getElementById('searchEntryBtn')?.addEventListener('click', () => palOpen({}));
document.getElementById('createdTodayBtn')?.addEventListener('click', () => palOpen({ newOnly: true }));

// 여러 개 선택 — 같은 자리에서 시작하고 끝낸다(Esc도 끝내기).
document.getElementById('taskSelectToggle')?.addEventListener('click', () => {
  if (taskBatchBusy) return;
  if (taskSelectionMode) taskSelectEnd(); else taskSelectStart();
});

// 나중에 할 일 서랍 — 머리줄 버튼으로 여닫고, 열어 둔 상태는 새로고침해도 그대로다.
document.getElementById('laterTaskToggle')?.addEventListener('click', () => {
  if (laterDrawerOpen) drawerClose(); else drawerOpen();
});
document.getElementById('laterTaskClose')?.addEventListener('click', drawerClose);
drawerRestore();
const TABS = {
  today: { grid: 'gridToday', btn: 'tabBtnToday' },
  projects: { grid: 'gridProjects', btn: 'tabBtnProjects' },
  meetings: { grid: 'gridMeetings', btn: 'tabBtnMeetings' },
  records: { grid: 'gridRecords', btn: 'tabBtnRecords' },
  weekly: { grid: 'gridWeekly', btn: 'tabBtnWeekly' },
};
projectKeyRestore();

function setActiveTab(tab) {
  if (!TABS[tab]) tab = 'today';
  // 확인 대기의 `다음은?` 줄은 그 자리의 제안이다 — 탭을 떠나면 함께 내린다.
  if (tab !== activeTabKey) waitingNextClose();
  // 프로젝트 탭에 새로 들어올 때만 왼쪽 목록 차례를 다시 정렬한다(체크 등으로 이미 그 탭에 있는 동안
  // 다시 그리는 것은 고정된 차례를 그대로 쓴다 — projectOrderResort).
  if (tab === 'projects' && activeTabKey !== 'projects') projectOrderResort = true;
  Object.entries(TABS).forEach(([key, cfg]) => {
    const active = key === tab;
    document.getElementById(cfg.grid).hidden = !active;
    document.getElementById(cfg.btn).classList.toggle('active', active);
    document.getElementById(cfg.btn).setAttribute('aria-selected', String(active));
    document.getElementById(cfg.btn).tabIndex = active ? 0 : -1;
    document.getElementById(cfg.btn).setAttribute('aria-controls', cfg.grid);
    document.getElementById(cfg.grid).setAttribute('role', 'tabpanel');
    document.getElementById(cfg.grid).setAttribute('aria-labelledby', cfg.btn);
  });
  activeTabKey = tab;
  // 주간요약을 떠나면 문장 모으기 막대도 함께 내린다(떠 있는 막대가 다른 탭에 남지 않게).
  if (tab !== 'weekly' && typeof reportNestEnd === 'function') reportNestEnd();
  document.getElementById('skipLink').hidden = tab !== 'today';
  renderActiveTabLists();
  try {
    localStorage.setItem('activeTab', tab);
  } catch {}
}

Object.keys(TABS).forEach((key) => {
  document.getElementById(TABS[key].btn).addEventListener('click', () => setActiveTab(key));
  document.getElementById(TABS[key].btn).addEventListener('keydown', event => {
    const keys = Object.keys(TABS);
    let index = keys.indexOf(key);
    if (event.key === 'ArrowRight') index = (index + 1) % keys.length;
    else if (event.key === 'ArrowLeft') index = (index + keys.length - 1) % keys.length;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = keys.length - 1;
    else return;
    event.preventDefault();
    setActiveTab(keys[index]);
    document.getElementById(TABS[keys[index]].btn).focus();
  });
});

document.getElementById('skipLink').addEventListener('click', event => {
  event.preventDefault();
  const zone = document.getElementById('todayTaskZone');
  zone.focus();
  zone.scrollIntoView({ block: 'start' });
});

let savedTab = 'today';
try {
  savedTab = localStorage.getItem('activeTab') || 'today';
} catch {}
setActiveTab(savedTab);

// ---------- 새로고침 ----------
// 자동화가 2시간마다 새 항목을 넣기 때문에, 창을 열어둔 채로는 그걸 못 본다.
// 입력 중에 화면이 다시 그려지면 쓰던 내용이 날아가므로 그때는 건너뛴다.

const refreshBtn = document.getElementById('refreshBtn');

refreshBtn.addEventListener('click', async () => {
  refreshBtn.classList.add('spinning');
  // 새로고침은 프로젝트 탭에 들어올 때와 같이 왼쪽 목록 차례를 다시 정렬해도 되는 때다.
  projectOrderResort = true;
  waitingNextClose(); // 화면을 새로 받는 때다 — 확인 대기의 `다음은?` 제안도 함께 내린다
  // 성공은 도는 아이콘이 말해 준다 — 알림을 또 띄우지 않는다(실패는 request가 알린다).
  refreshBtn.setAttribute('aria-busy', 'true');
  await load();
  refreshBtn.removeAttribute('aria-busy');
  setTimeout(() => refreshBtn.classList.remove('spinning'), 400);
});

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
  ['여러 개를 한 번에 정리하려면',
    '오늘 할 일 머리줄의 <b>⋯</b> → <b>여러 개 선택</b>을 누르면 줄마다 선택 칸이 하나 더 생겨요(완료 체크는 그대로 써요). 목록 아래 막대에서 <b>오늘로</b>·<b>내일</b>·<b>나중에</b>·<b>날짜</b>·<b>프로젝트</b>·<b>완료로 표시</b>·<b>삭제</b>를 한 번에 적용해요.'],
  ['찾고 싶은 기록이 있으면',
    '<b>⌘K</b>(윈도는 Ctrl+K)로 검색을 열어요. 할 일·확인 대기·결정·아이디어·회의를 한 자리에서 찾고, 위 칩으로 종류를 좁힐 수 있어요. 검색에서 연 항목을 닫으면 찾던 자리로 그대로 돌아와요.'],
  ['회의 내용은 어디서 정리하나요',
    '왼쪽 <b>오늘 미팅</b>의 회의를 누르면 오른쪽에 회의 정리 패널이 열려요. 초안을 고쳐 담고, 담은 뒤 뜨는 결과 카드의 <b>실행 취소</b>로 되돌릴 수 있어요.'],
  ['잘못 눌렀을 때는',
    '완료·삭제·보고 제외는 아래 알림의 <b>되돌리기</b>로 바로 취소할 수 있어요. <b>⌘Z</b>도 같은 일을 하고, <b>⌘⇧Z</b>로 다시 실행해요.'],
  ['결과 한 줄은 왜 적나요',
    '완료한 업무에 적은 한 줄이 주간요약 문장으로 그대로 올라가요. 금요일에 다시 쓰지 않아도 돼요.'],
  ['보고 문장을 수정하면 원본 업무도 바뀌나요',
    '아니요. 보고 문장과 원본 기록은 따로 남아요. 원본이 바뀌면 수정 제안으로만 알려 주고, 직접 적용하기 전에는 고쳐 둔 문장을 바꾸지 않아요.'],
  ['자잘한 업무는 어떻게 빼나요',
    '주간요약에서 문장의 <b>제외</b>를 누르면 복사할 내용에서 빠져요. 원본은 업무 기록에 남고 언제든 보고로 되돌릴 수 있어요.'],
  ['확인 대기는 뭔가요',
    '다른 사람의 답을 기다리는 항목이에요. 언제까지 답을 받아야 하는지는 <b>답변 받을 날</b>에 적어요. 할 일 쪽에서 "이 답변을 기다리는 중"으로 연결해 두면 답이 오는 순간 알려 줘요.'],
  ['머리줄의 "○일 전 기준" 같은 표시는 뭔가요',
    '슬랙·캘린더·지라 자동 동기화가 최근에 못 돌았다는 뜻이에요. 그 글자를 누르면 이 창의 <b>상태</b>에서 그 자동화 줄이 바로 보여요.'],
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
  if (tab === 'guide') renderSettingsGuide();
  if (tab === 'status') renderAutomationStatus();
}

// 헤더의 톱니바퀴와 동기화 지연 경고가 함께 쓰는 한 길.
function settingsOpen(tab = 'status', focusKey = null) {
  settingsFocusKey = focusKey;
  if (settingsDialog.open) { settingsSetTab(tab); return; }
  settingsReturnFocus = document.activeElement;
  uiMenuClose();
  settingsDialog.showModal();
  settingsEsc = escPush(settingsClose);
  settingsSetTab(tab);
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
document.getElementById('settingsBtn').addEventListener('click', () => settingsOpen('status'));
document.getElementById('settingsCloseBtn').addEventListener('click', settingsClose);
settingsDialog.querySelectorAll('[data-settings-tab]').forEach((button) => {
  button.addEventListener('click', () => settingsSetTab(button.dataset.settingsTab));
});

// 폰에서는 버튼이 작으니, 맨 위에서 아래로 끌어도 새로고침되게 한다.
const pullIndicator = document.getElementById('pullIndicator');
const PULL_THRESHOLD = 64;   // 이만큼 끌면 새로고침
const PULL_MAX = 88;         // 그 이상은 더 따라오지 않는다
let pullStartY = null;
let pullDist = 0;
let pulling = false;
let pullRefreshing = false;

function movePull(y, ready) {
  pullIndicator.style.transform = `translateY(${y}px)`;
  pullIndicator.style.opacity = y > 4 ? String(Math.min(1, y / PULL_THRESHOLD)) : '0';
  pullIndicator.classList.toggle('ready', !!ready);
}

function resetPull(animate) {
  pullIndicator.classList.toggle('snapping', !!animate);
  pullIndicator.classList.remove('ready', 'refreshing');
  pullIndicator.style.removeProperty('--pull-y');
  movePull(-40, false);
  pullDist = 0;
  pulling = false;
  pullStartY = null;
}

document.addEventListener('touchstart', (e) => {
  if (pullRefreshing || e.touches.length !== 1) return;
  if (window.scrollY > 0 || isTyping()) return;
  pullStartY = e.touches[0].clientY;
  pullDist = 0;
  pulling = false;
}, { passive: true });

document.addEventListener('touchmove', (e) => {
  if (pullStartY === null || pullRefreshing) return;
  const dy = e.touches[0].clientY - pullStartY;
  // 위로 올리거나 이미 스크롤된 상태면 평범한 스크롤로 놓아준다
  if (dy <= 0 || window.scrollY > 0) {
    if (pulling) resetPull(true);
    pullStartY = null;
    return;
  }
  pulling = true;
  pullIndicator.classList.remove('snapping');
  // 당길수록 무거워지게 — 손가락을 딼 때를 알아차리기 쉽다
  pullDist = Math.min(PULL_MAX, dy * 0.5);
  movePull(pullDist, pullDist >= PULL_THRESHOLD);
  e.preventDefault();
}, { passive: false });

async function endPull() {
  if (pullStartY === null) return;
  if (!pulling) { pullStartY = null; return; }
  if (pullDist < PULL_THRESHOLD) { resetPull(true); return; }

  pullRefreshing = true;
  pullIndicator.classList.add('snapping');
  const restY = 56;
  pullIndicator.style.setProperty('--pull-y', restY + 'px');
  movePull(restY, true);
  pullIndicator.classList.add('refreshing');
  try {
    await load();
  } finally {
    pullRefreshing = false;
    resetPull(true);
  }
}

document.addEventListener('touchend', endPull, { passive: true });
document.addEventListener('touchcancel', () => { if (pulling) resetPull(true); else pullStartY = null; }, { passive: true });

// 다른 창 갔다가 돌아오면 최신 상태로
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  // 숨은 동안 쉬던 미팅 노트 상태 묻기를 다시 깨운다(글을 쓰는 중이어도 이건 이어져야 한다).
  meetingNotesSchedule();
  if (!isTyping()) { load(); fetchAutomationStatus(); }
});

// 계속 띄워둔 채로도 뒤처지지 않게
setInterval(() => {
  if (!document.hidden && !isTyping()) { load(); fetchAutomationStatus(); }
}, 5 * 60 * 1000);

load();
refreshStorageStatus(); // 목록을 못 불러오는 상황에서도 저장이 멈춘 이유는 보이게
fetchAutomationStatus(); // 설정을 열어보지 않아도 톱니바퀴에 실패 여부가 바로 보이게

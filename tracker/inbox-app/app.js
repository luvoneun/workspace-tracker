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
  gear: '<path d="M6.65 3.29L6.98 1.58L9.02 1.58L9.35 3.29L10.38 3.71L11.82 2.74L13.26 4.18L12.29 5.62L12.71 6.65L14.42 6.98L14.42 9.02L12.71 9.35L12.29 10.38L13.26 11.82L11.82 13.26L10.38 12.29L9.35 12.71L9.02 14.42L6.98 14.42L6.65 12.71L5.62 12.29L4.18 13.26L2.74 11.82L3.71 10.38L3.29 9.35L1.58 9.02L1.58 6.98L3.29 6.65L3.71 5.62L2.74 4.18L4.18 2.74L5.62 3.71Z"/><circle cx="8" cy="8" r="2.1"/>',
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

// 자리가 아주 좁은 곳(왼쪽 프로젝트 목록의 배포일)에서만 쓰는 가장 짧은 날짜: `9/30`.
function uiDateSlash(dateStr) {
  if (!dateStr) return '';
  const [, month, day] = String(dateStr).split('-');
  if (!month || !day) return String(dateStr);
  return `${Number(month)}/${Number(day)}`;
}

const UI_DUE_COUNTDOWN_DAYS = 7; // 이 날 안으로 남은 기한은 오늘 목록 줄에 `D-N`으로 선다

// 기한 말투는 어디서나 같다: `기한 2일 지남`(urgent) `오늘까지`(warn) `내일까지` `9월 27일까지`.
// where가 'row'면 오늘 목록의 한 줄 — 2~7일 남으면 조용한 `D-N`, 그보다 먼 기한은 찍지 않는다(의미 없는 값은 자리를 비운다).
function uiDueText(due, where = 'full') {
  if (!due) return null;
  const diff = diffDays(due);
  if (Number.isNaN(diff)) return null;
  if (diff < 0) return { text: `기한 ${-diff}일 지남`, tone: 'urgent' };
  if (diff === 0) return { text: '오늘까지', tone: 'warn' };
  if (diff === 1) return { text: '내일까지', tone: '' };
  if (where === 'row') {
    // 2~7일 남았으면 오늘 목록 줄에 조용한 `D-3`만 — 아이콘·`까지` 없이. 뜻(`10월 5일까지`)은 title·낭독기 이름이 말한다.
    if (diff <= UI_DUE_COUNTDOWN_DAYS) return { text: `D-${diff}`, tone: '', quiet: true, hint: `${uiKoDateShort(due)}까지` };
    return null;
  }
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

// 기한이 오늘이거나 지난 미완료 업무는 실행 예정일을 옮겨도 오늘 목록에 남는다(서버가 기한으로 보여 준다, WP-T).
// 미루는 알림이 그 사실을 말한다 — 옮긴 곳이 오늘·지난 날짜면 남는 것이 당연하므로 덧붙이지 않는다.
function uiDueStaysNote(items, scheduled) {
  if (scheduled && !(diffDays(scheduled) > 0)) return '';
  const days = (items || []).filter(item => item && item.status !== 'done' && item.due)
    .map(item => diffDays(item.due)).filter(diff => !Number.isNaN(diff) && diff <= 0);
  if (!days.length) return '';
  const why = days.every(diff => diff < 0) ? '기한이 지나' : days.every(diff => diff === 0) ? '기한이 오늘이라' : '기한이 오늘이거나 지나';
  const who = (items || []).length > 1 ? `${days.length}개는 ` : '';
  return `${who}${why} 오늘 목록에는 남아요 — 기한을 바꾸면 빠져요`;
}
// 미루기 알림 한 줄: 남는 업무가 있으면 `· 기한은 그대로예요` 대신 남는 까닭을 붙인다.
function uiMoveNotice(message, items, scheduled) {
  const note = uiDueStaysNote(items, scheduled);
  return note ? `${message.replace(/ · 기한은 그대로예요$/, '')} · ${note}` : message;
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
      item.className = 'd-mitem' + (entry.danger ? ' dng' : '') + (entry.tone ? ` ${entry.tone}` : '');
      item.setAttribute('role', 'menuitem');
      item.textContent = entry.label;
      if (entry.disabled) item.disabled = true;
      item.addEventListener('click', () => { uiMenuClose(); entry.onClick(); });
      list.appendChild(item);
    });
  });

  // 모달(`<dialog>`) 안에서 연 메뉴는 그 모달 안에 붙인다 — 맨 위 층(top layer) 밖에 있으면
  // 보이기만 하고 눌리지 않는다(설정 창의 ⋯). 자리는 `position: fixed`라 어디에 붙어도 같다.
  (anchor.closest('dialog[open]') || document.body).appendChild(list);
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
// shown: 고른 날짜를 브라우저 기본 표기(10/02/2026) 대신 앱의 날짜 글자(`10월 2일 (금)`)로 보인다 —
// 누르면 그 자리에서 날짜 입력칸으로 바뀌고(되는 브라우저면 달력까지 연다), 고르면 다시 글자로 돌아온다.
// describe(value) → { text, tone }: 얼굴 글자(말투 포함, `9월 29일 (화) · 기한 1일 지남`). 없으면 uiKoDate.
// face: 'pick'이면 상세 카드의 값 모양(.d-dpick — 값 + 달력 아이콘)이다. 빈 칸도 `+ 기한` 대신 회색 `없음` 한 조각,
//   ✕는 값 바로 옆의 작은 버튼. 입력칸은 Enter·Tab·바깥 누름·달력에서 고르기로 확정하고, Esc는 입력칸만 닫는다.
//   기본(face 없음)은 회의 정리 초안의 모양(.d-dateinput.is-shown) 그대로다.
// 어느 모양이든 입력칸을 비운 change(편집 중 지움·일부만 남김)는 저장하지 않는다 — 지우기는 ✕만 한다.
function uiDateField({ value, label = '기한', onChange, clearable = true, shown = false, describe = null, face: faceKind = '' }) {
  const pick = faceKind === 'pick';
  const wrap = document.createElement('span');
  wrap.className = pick ? 'd-datefield d-dvalue' : 'd-datefield';
  let current = value || '';
  let editing = false;
  // 입력칸 밖을 누르면 확정하는 감시(pick만). 다시 그릴 때마다 걷는다.
  let stopOutside = null;
  const quitOutside = () => { if (stopOutside) { stopOutside(); stopOutside = null; } };
  const focusFace = () => { wrap.querySelector('.d-dpick')?.focus?.(); };
  // 확정: 빈 값은 무시하고(입력칸이 그대로 남는다), 같은 날짜면 저장하지 않고 글자로만 돌아간다.
  const commit = (next, refocus) => {
    if (!next) return;
    editing = false;
    const changed = next !== current;
    current = next;
    if (changed) onChange(current);
    draw();
    if (refocus) focusFace();
  };
  const revert = (refocus) => {
    editing = false;
    draw();
    if (refocus) focusFace();
  };

  // 입력칸을 떠날 때(pick): 고친 날짜가 있으면 확정, 비었거나 그대로면 원래 글자로.
  const leave = () => {
    if (!editing) return;
    const input = wrap.querySelector('.d-dateinput');
    const next = input ? input.value : '';
    if (next && next !== current) commit(next, false);
    else revert(false);
  };
  if (pick) {
    // 초점이 이 칸(입력칸·✕) 밖의 다른 곳으로 갔을 때만 떠난 것으로 본다 — 입력칸에서 ✕로 Tab한 뒤 더 나가도 잡힌다.
    // 달력이 열리며 잠깐 비는 초점(relatedTarget 없음)은 기다린다(바깥 누름은 아래 mousedown 감시가 맡는다).
    wrap.addEventListener('focusout', (event) => {
      const to = event && event.relatedTarget;
      if (!to || (typeof wrap.contains === 'function' && wrap.contains(to))) return;
      leave();
    });
  }

  const faceText = () => {
    const described = typeof describe === 'function' ? describe(current) : null;
    return described && described.text ? described : { text: uiKoDate(current), tone: '' };
  };
  const openInput = () => {
    editing = true;
    draw();
    const input = wrap.querySelector(pick ? '.d-dateinput' : 'input');
    try { input?.showPicker?.(); } catch { /* 달력을 못 열면 입력칸에 초점만 둔다 */ }
  };

  const draw = () => {
    quitOutside();
    wrap.replaceChildren();
    if (!current && !editing && !pick) {
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'd-btn sm';
      open.textContent = `+ ${label}`;
      open.addEventListener('click', () => { editing = true; draw(); });
      wrap.appendChild(open);
      return;
    }
    if (pick && !editing) {
      // 값 글자가 곧 누르는 자리 — 급함 색은 글자에만, 오른쪽에 달력 아이콘.
      const { text, tone } = current ? faceText() : { text: '없음', tone: '' };
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'd-dpick';
      button.setAttribute('aria-label', current ? `${label} ${text} — 바꾸기` : `${label} 없음 — 정하기`);
      const shownText = document.createElement('span');
      shownText.className = 'v' + (current ? uiTone(tone) : ' k-mute');
      shownText.textContent = text;
      shownText.title = text;
      const icon = document.createElement('span');
      icon.className = 'cv cal';
      icon.innerHTML = uiIcon('calendar');
      button.append(shownText, icon);
      button.addEventListener('click', openInput);
      wrap.appendChild(button);
    } else if (shown && current && !editing) {
      const { text, tone } = faceText();
      const face = document.createElement('button');
      face.type = 'button';
      face.className = 'd-dateinput is-shown' + uiTone(tone);
      face.textContent = text;
      face.setAttribute('aria-label', `${label} ${text} — 바꾸기`);
      face.addEventListener('click', openInput);
      wrap.appendChild(face);
    }
    const input = (pick || shown) && !editing && (pick || current) ? null : document.createElement('input');
    if (input) {
      input.type = 'date';
      input.className = 'd-dateinput';
      input.value = current;
      input.setAttribute('aria-label', label);
      if (pick) {
        // 숫자를 치는 동안에도 브라우저가 change를 보낸다(크롬) — 그때는 확정하지 않고 Enter·Tab·바깥 누름을 기다린다.
        // 달력에서 고른 change는 키 입력과 떨어져 오므로 곧바로 확정한다.
        let keyAt = 0;
        input.addEventListener('keydown', (event) => {
          if (event.isComposing) return; // 한글 조합 중의 Esc·Enter는 넘긴다
          if (event.key === 'Escape') {
            // 입력칸만 닫는다 — 문서의 Esc 스택(카드 닫기)까지 가지 않게 여기서 멈춘다.
            event.preventDefault();
            event.stopPropagation();
            revert(true);
            return;
          }
          if (event.key === 'Enter') {
            event.preventDefault();
            // 빈 칸의 Enter는 무시한다(저장하지 않고 칸도 그대로). 같은 날짜면 commit이 글자로만 돌려놓는다.
            commit(input.value, true);
            return;
          }
          if (event.key !== 'Tab') keyAt = Date.now();
        });
        input.addEventListener('change', () => {
          if (!input.value) return;
          if (Date.now() - keyAt < 250) return;
          commit(input.value, true);
        });
        if (editing && typeof document.addEventListener === 'function') {
          const outside = (event) => {
            if (!wrap.isConnected) { quitOutside(); return; }
            if (typeof wrap.contains === 'function' && wrap.contains(event.target)) return;
            leave();
          };
          document.addEventListener('mousedown', outside, true);
          stopOutside = () => document.removeEventListener?.('mousedown', outside, true);
        }
      } else {
        input.addEventListener('change', () => {
          if (!input.value) return; // 비운 칸은 저장하지 않는다 — 지우기는 ✕
          current = input.value;
          editing = false;
          onChange(current);
          draw();
        });
        // 비운 채 떠나면 원래 날짜를 다시 보인다(다시 그리지 않는다 — 열린 달력을 닫지 않게).
        input.addEventListener('blur', () => { if (!input.value && current) input.value = current; });
      }
      wrap.appendChild(input);
    }
    if (current && clearable) {
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = pick ? 'd-iconbtn xs' : 'd-iconbtn sm';
      clear.setAttribute('aria-label', `${label} 지우기`);
      clear.innerHTML = uiIcon('close');
      clear.addEventListener('click', () => { current = ''; editing = false; onChange(null); draw(); if (pick) focusFace(); });
      wrap.appendChild(clear);
    }
    if (editing && input) input.focus();
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
    // 별칭이 있으면 지라 요약 대신 그 이름을 쓴다(BJALIAS) — 내 담당 목록 밖이라 요약을 모르는
    // 티켓도 별칭만 있으면 이름이 있는 것으로 본다(모른다고 키만 보이지 않는다).
    const summary = projectAliasesCache[item.jira] || (issue ? issue.summary : '');
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
// (같은 말을 한 줄에서 두 번 하지 않는다). 여러 개 선택 중(체크박스가 없는 줄)에는 예전처럼 글자로 쓴다.
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
  // 진행 중인 업무에는 밀림을 붙이지 않는다 — 이미 손을 댄 일이라 `N일째 밀림`은 틀린 말이다(진행 중을 풀면 돌아온다).
  const doing = !!item.doing && !done;
  const carry = where === 'row' && !done && !doing ? uiCarryText(item.scheduled) : null;
  if (carry) status.push(cell('m-carry', 'clock', carry, '오늘 하려다 넘어온 업무예요'));
  if (doing) {
    // 체크박스가 있는 줄(noPriority)은 반쯤 찬 체크박스가 `진행 중`을 말한다 — 오른쪽에 며칠째인지 적지 않는다(사용자 요청: 날짜 표시가 거슬림).
    // 여러 개 선택 중(체크박스가 없는 줄)은 `진행 중` 글자만.
    if (!opts.noPriority && !opts.inDoingGroup) status.push(cell('m-doing', 'clock', '진행 중', `${uiKoDate(item.doing)}부터 진행 중이에요`));
  }
  // 나중에 할 일 서랍의 줄: 미래 날짜로 정한 업무는 그 날짜를 보인다(날짜 미정은 지어내지 않는다).
  const scheduledLater = opts.later && !done && item.scheduled && diffDays(item.scheduled) > 0
    ? cell('m-sched', 'calendar', `${uiKoDateShort(item.scheduled)} 예정`, `${uiKoDate(item.scheduled)}에 하기로 했어요`) : '';
  const due = done ? null : uiDueText(item.due, where);
  const dueCell = due && due.quiet
    ? `<span class="m-due is-d" role="img" title="${escapeAttr(due.hint)}" aria-label="${escapeAttr(due.hint)}">${escapeHtml(due.text)}</span>`
    : due ? cell(`m-due${uiTone(due.tone)}`, 'calendar', due.text, item.due ? `기한은 ${uiKoDate(item.due)}이에요` : '') : '';
  return [...cells, priorityCell, ...status, scheduledLater, dueCell].filter(Boolean).join('');
}

// 업무 체크박스 한 칸(체크 + 흰 체크 + 우선순위 꺾쇠 + 진행 중 반쯤 채움). 체크박스가 있는 줄은 모두 이 부품을 쓴다.
// 꺾쇠는 체크박스 위에 겹치고 `pointer-events: none`이라 누르는 자리는 그대로 28px이다.
// 완료한 줄에는 붙지 않는다(체크된 파란 네모가 이미 다 말한다). 진행 중은 체크박스 자신의 클래스(`is-doing`)다.
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

// 글자 칸의 Enter 저장은 칸을 잠그지 않는다 — 잠긴(disabled) 칸에 친 글자는 브라우저가 버려서,
// "적고 Enter, 곧바로 다음 줄"을 치면 앞 글자(한글은 첫 음절)가 사라지고 빠른 두 번째 Enter는 조용히 묻혔다.
// 그래서 Enter 순간의 글을 들고 칸을 바로 비우고, 같은 칸(열쇠)의 저장은 이 대기열로 하나씩 순서대로 보낸다.
// 앞 건이 실패해도 다음 건은 그대로 보낸다. 같은 글을 두 번 보내도 각각 저장한다(일부러 같은 글을 넣을 수 있다).
const uiSendQueues = new Map();
function uiQueueSend(key, job) {
  const run = (uiSendQueues.get(key) || Promise.resolve()).then(job);
  const tail = run.catch(() => {});
  run.queueTail = tail;
  uiSendQueues.set(key, tail);
  tail.then(() => { if (uiSendQueues.get(key) === tail) uiSendQueues.delete(key); });
  return run;
}

// 저장하지 못한 글 되돌리기 — 칸이 비어 있으면 그 글을 칸에 되돌린다(적은 글을 잃지 않게).
// 칸에 이미 다른 글을 치고 있거나 칸이 사라졌으면(다른 탭으로 옮김) 덮어쓰지 않고 어떤 글이 안 됐는지 알린다.
// `run`은 실패한 그 저장(uiQueueSend가 돌려준 것) — 뒤에 기다리던 저장이 있는지 가리는 데 쓴다.
function uiSendRestore(input, text, queueKey, run) {
  const restored = !!(input && input.isConnected !== false && !String(input.value || '').trim());
  if (restored) {
    input.value = text;
    const row = input.closest?.('.d-addrow');
    if (row) row.hidden = false;
    // 다른 칸으로 옮겨 가 있으면 초점을 뺏지 않는다.
    const active = document.activeElement;
    if (!active || active === input || active === document.body) input.focus();
  }
  uiUnsavedNotice(text, queueKey, run, restored);
  return restored;
}
// 어떤 글이 저장 안 됐는지 알린다. 뒤에 기다리던 저장의 `저장 중…`·`저장했어요`가 이 알림을 덮지 않게
// 같은 칸의 대기열이 다 끝난 뒤에 띄운다. 글을 칸에 되돌렸고 뒤에 기다리는 저장도 없으면
// request()가 이미 띄운 알림("입력한 내용은 그대로 있어요" 또는 복구 필요 안내)을 그대로 둔다.
function uiUnsavedNotice(text, queueKey, run = null, restored = false) {
  const tail = queueKey ? uiSendQueues.get(queueKey) : null;
  const later = !!tail && (!run || tail !== run.queueTail);
  if (restored && !later) return;
  const shown = String(text).replace(/\s+/g, ' ').trim();
  const show = () => showNotice(`“${shown.length > 40 ? `${shown.slice(0, 40)}…` : shown}” 저장됐는지 확인하지 못했어요. ${restored
    ? '적은 글은 칸에 그대로 있어요' : '칸에 다른 글이 있어 되돌리지 않았어요 — 다시 적어 주세요'}`, true);
  if (tail) tail.then(show); else show();
}

// 그룹 `+` 줄·프로젝트 상세 추가 줄은 load()가 목록을 다시 그릴 때 새 칸으로 바뀐다 — 다시 그리기 직전에
// 초점이 있던 줄의 이름표(data-add-key)·글·커서를 잡아 두었다가 새 칸에 되돌린다(적던 글·초점이 날아가지 않게).
// 초점이 다른 데 있으면 아무것도 하지 않는다(초점을 뺏지 않는다).
function uiAddRowSnapshot() {
  const el = document.activeElement;
  const row = el?.closest?.('.d-addrow');
  if (!row || !row.dataset?.addKey || !String(el.className || '').includes('d-addinput')) return null;
  return { el, key: row.dataset.addKey, start: el.selectionStart, end: el.selectionEnd, direction: el.selectionDirection };
}
function uiAddRowRestore(snap) {
  if (!snap || snap.el.isConnected) return;
  const row = [...(document.querySelectorAll?.('.d-addrow') || [])].find(node => node.dataset?.addKey === snap.key);
  const input = row?.querySelector('.d-addinput');
  if (!input) return;
  row.hidden = false;
  input.value = snap.el.value;
  input.focus();
  try { if (snap.start != null) input.setSelectionRange(snap.start, snap.end, snap.direction || 'none'); } catch { /* 커서를 못 옮겨도 글·초점은 남는다 */ }
}

// 입력 중이면 그 구역의 다시 그리기를 미룬다 — 구역 안의 글자 칸에 초점이 있으면 목록을 새로 만들지 않는다.
// 칸을 새로 만들면 한글 조합이 끊겨("한글 입력" → "한ㄱ") 글·초점·커서를 되돌려도(uiAddRowRestore) 소용이 없다.
// 미룬 그리기는 손을 뗀 뒤 마지막 것 하나만 돌린다 — 초점이 그 구역을 떠났을 때(누르던 버튼이 사라져 클릭이
// 씹히지 않게 손가락을 뗀 뒤), 또는 되돌릴 수 있는 입력줄의 조합이 끝났을 때. 그 사이 목록·개수는 잠깐 옛 상태다.
// 저장 중인(잠긴) 고치기 칸이 남아 있으면 그 저장이 부르는 load()에 맡긴다(실패하면 고치던 글이 남아야 한다).
// 글·초점·커서를 되돌릴 수 있는 그룹 `+` 줄·프로젝트 상세 추가 줄은 조합 중일 때만 미룬다(저장한 줄이 바로 보이게).
// 회의 탭이 쓰던 "입력 중이면 미룸"을 여러 구역에 넓힌 것이다(구역마다 따로 두지 않는다).
let uiComposingEl = null;
let uiPointerDown = false;
const uiHeldRenders = new Map();
// 글자를 치는 칸만 "입력 중"으로 본다 — 체크박스·라디오·버튼·select 등은 눌러도 목록이 바로 바뀌어야 한다
// (전역 isTyping()은 input 전체를 입력 중으로 봐서, 체크한 뒤 목록·개수가 초점이 떠날 때까지 낡아 있었다).
const UI_NOT_TEXT_INPUTS = ['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image'];
function uiIsTextEntry(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = String(el.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA') return true;
  if (tag !== 'INPUT') return false;
  return !UI_NOT_TEXT_INPUTS.includes(String(el.type || 'text').toLowerCase());
}
function uiRenderHeld(zone) {
  // 일정 정하기 판이 열려 있는 동안은 그 구역을 다시 그리지 않는다(누른 줄·버튼이 사라지면 판이 허공에 뜬다).
  if (zone && uiSchedOpen && uiSchedOpen.zone === zone) return true;
  const el = document.activeElement;
  if (!zone || !el || !zone.contains?.(el) || !uiIsTextEntry(el)) return false;
  if (uiComposingEl && uiComposingEl === el) return true;
  return !uiAddRowSnapshot();
}
// 그리거나(true) 미룬다(false). `name`이 같은 미룬 그리기는 마지막 것만 남는다.
function uiRenderOrHold(name, zone, render) {
  if (!uiRenderHeld(zone)) { uiHeldRenders.delete(name); render(); return true; }
  uiHeldRenders.set(name, { zone, render });
  uiHoldArm(document.activeElement);
  return false;
}
function uiHoldArm(el) {
  if (!el || el.uiHoldArmed) return;
  el.uiHoldArmed = true;
  const check = () => {
    el.removeEventListener('focusout', check);
    el.removeEventListener('compositionend', check);
    el.uiHoldArmed = false;
    // 초점이 옮겨 간 뒤·조합이 끝난 뒤의 상태로 판단한다(이벤트 도중의 activeElement는 아직 옛 칸이다).
    setTimeout(uiHeldFlush, 0);
  };
  el.addEventListener('focusout', check);
  el.addEventListener('compositionend', check);
}
function uiHeldFlush() {
  const active = document.activeElement;
  for (const [name, held] of [...uiHeldRenders]) {
    const { zone } = held;
    if (uiRenderHeld(zone)) { uiHoldArm(active); continue; }
    // 초점이 같은 구역의 다른 것(버튼 등)으로 옮겨 갔으면 그것을 지우지 않게 구역을 떠날 때까지 기다린다.
    if (active && active !== document.body && zone.contains?.(active) && !uiAddRowSnapshot()) { uiHoldArm(active); continue; }
    if ([...(zone.querySelectorAll?.('input:disabled, textarea:disabled') || [])].some(uiIsTextEntry)) continue;
    if (uiPointerDown) {
      document.addEventListener('pointerup', () => setTimeout(uiHeldFlush, 0), { once: true, capture: true });
      return;
    }
    uiHeldRenders.delete(name);
    const typingRow = uiAddRowSnapshot();
    held.render();
    uiAddRowRestore(typingRow);
  }
}

// 그룹 제목의 `+`로 여는 그 자리 입력줄. 저장 뒤 목록을 다시 그려도 같은 줄로 포커스가 돌아온다(uiAddRowRestore).
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
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !event.isComposing) { row.hidden = true; return; }
    if (event.key !== 'Enter' || event.isComposing) return;
    const description = input.value.trim();
    if (!description) return;
    // 칸은 잠그지 않고 바로 비운다 — 저장 중에 친 다음 글자는 그대로 남는다(uiQueueSend).
    input.value = '';
    const payload = { description };
    if (key.startsWith('jira:')) payload.jira = key.slice(5);
    else if (key.startsWith('group:')) payload.group = key.slice(6);
    const addKey = row.dataset.addKey;
    // 저장 사이에 목록이 다시 그려졌으면 같은 이름표의 새 칸이 이 줄이다.
    const current = () => (input.isConnected ? input
      : [...(document.querySelectorAll?.('.d-addrow') || [])].find(node => node.dataset?.addKey === addKey)?.querySelector('.d-addinput') || null);
    const run = uiQueueSend(addKey, async () => {
      await request(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      announce(announceText);
      // load()가 목록을 다시 그려 이 칸이 떨어져 나가도, 초점이 이 줄에 있었으면 같은 그룹의 새 줄로
      // 적던 글·초점·커서가 옮겨 간다(load 안의 uiAddRowRestore). 다른 데로 옮겨 갔으면 초점을 뺏지 않는다.
      await load();
    });
    return run.catch(() => { uiSendRestore(current(), description, addKey, run); });
  });
  // 다른 곳을 누르면 닫는다 — 적던 글이 있으면 잃지 않게 그대로 둔다. 늘 보이는 프로젝트 상세 줄(d-padd)은 닫지 않는다.
  input.addEventListener('blur', () => {
    if (input.value.trim() || String(row.className).includes('d-padd')) return;
    row.hidden = true;
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
// disableCurrent: 지금 값을 다시 고를 일이 없는 칸(종류 바꾸기)에서는 그 칩을 눌리지 않게 둔다.
function uiMenuChips(options, current, onPick, disableCurrent = false) {
  const wrap = document.createElement('span');
  wrap.className = 'd-chips';
  options.forEach(([value, text]) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'd-chip' + (value === current ? ' is-on' : '');
    // 지금 값(파란 칩)을 낭독기도 알게 — 메뉴 안에서 하나를 고르는 칸이라 menuitemradio + aria-checked.
    chip.setAttribute('role', 'menuitemradio');
    chip.setAttribute('aria-checked', String(value === current));
    chip.textContent = text;
    if (disableCurrent && value === current) chip.disabled = true;
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

  // 여러 개 선택 중에는 완료 체크 자리(첫 칸, 30px)에 선택 칸 하나만 선다 — 누를 네모가 하나뿐이라
  // 고르려다 완료하는 일이 없다. 한 건을 끝내려면 막대의 `완료로 표시`(또는 모드를 끝내고 체크).
  // 체크박스가 말하던 우선순위·진행 중은 그동안 오른쪽 상태 글자로 옮겨 간다(아래 meta).
  let selectBox = null;
  if (taskSelectionMode) {
    const cell = document.createElement('span');
    cell.className = 'd-sel';
    // 완료한 줄은 고를 수 없고 완료 취소도 모드를 끝낸 뒤에 한다 — 칸은 자리만 지킨다.
    if (!done) { selectBox = taskSelectionCheckbox(item, row); cell.appendChild(selectBox); }
    row.appendChild(cell);
  } else {
    row.appendChild(uiCheckCell(item, row, done));
  }

  const title = document.createElement('span');
  title.className = 'd-title';
  title.title = item.description;
  title.textContent = item.description;
  // 선택 중에는 키보드가 줄마다 선택 칸 한 곳에서만 멈춘다(Space로 고른다). 끝내면 다시 그려 0으로 돌아온다.
  title.tabIndex = taskSelectionMode ? -1 : 0;
  // 선택 중에는 선택 칸의 이름표(`제목 — 선택`)가 같은 말을 한다 — 제목은 낭독기에서 한 번 더 읽히지 않게 숨긴다
  // (누르면 고르는 것은 그대로, 키보드는 선택 칸에서만 멈춘다).
  if (taskSelectionMode && !done) {
    title.setAttribute('aria-hidden', 'true');
  } else {
    title.setAttribute('role', 'button');
    title.setAttribute('aria-label', `${item.description} 상세 보기`);
  }
  const open = () => {
    if (taskSelectionMode) { if (selectBox && !taskBatchBusy) selectBox.click(); return; }
    panelOpen({ id: item.id });
  };
  title.addEventListener('click', open);
  title.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
  });
  // 여러 개 선택 중에는 폭과 상관없이 줄 아무 데나 누르면 선택이다(제목은 자기 클릭이 이미 선택 —
  // 한 누름이 두 번 바뀌지 않게 뺀다). 그 밖의 좁은 폭(시트로 여는 폭)에서는 줄 누름 = 제목 누름(시트 열기).
  // 줄에 tabindex는 주지 않는다 — 키보드는 제목(선택 중이면 선택 칸)에서.
  row.addEventListener('click', (event) => {
    if (taskSelectionMode) {
      const target = event && event.target;
      if (!selectBox || taskBatchBusy || !target || typeof target.closest !== 'function') return;
      if (target.closest('input, a, button, textarea, select, label, .d-title')) return;
      selectBox.click();
      return;
    }
    if (uiRowTapOpens(event, '.d-title')) open();
  });
  // NEW는 누르는 버튼이 아니라 표시다 — 화면에 잠깐 머물면 조용히 사라진다(observeNewItem).
  if (item.isNew && !done) { title.prepend(renderNewDot(item)); observeNewItem(row, item); }

  // 그룹 제목이 프로젝트를 말해 주지 않는 자리(진행 중·마감순·서랍)에서는 제목 바로 뒤에 `· ● 프로젝트`.
  // 원문이 있으면 그 뒤에 조용한 `원문` 링크가 늘 따라온다.
  // 묶음(BBUNDLE) 그룹 아래 줄이면 제목 바로 뒤에 어느 티켓 것인지 작은 번호(opts.fromKey, 프로젝트 탭과 같은 .d-pfrom).
  const inlineProject = project;
  const source = uiSourceLink(item);
  const fromTag = opts.fromKey && typeof projectFromTag === 'function' ? projectFromTag(opts.fromKey) : null;
  if (inlineProject || source || fromTag) {
    const wrap = document.createElement('span');
    wrap.className = 'd-titlewrap';
    wrap.appendChild(title);
    if (fromTag) wrap.appendChild(fromTag);
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
    // 여러 개 선택 중에는 체크박스가 없으므로 체크박스가 없는 줄처럼 우선순위·진행 중을 글자로 적는다.
    meta.innerHTML = uiMetaCells(item, {
      where: mode === 'later' ? 'full' : 'row', later: mode === 'later', inDoingGroup: opts.inDoingGroup, project, noPriority: !taskSelectionMode,
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
        await uiMoveRun(row, () => setTaskScheduled(item.id, scheduled), uiMoveNotice(message, [item], scheduled));
        button.disabled = false;
      });
      acts.appendChild(button);
    };
    if (mode === 'later') {
      move('오늘로', todayStr(), '오늘 할 일로 옮겼어요');
    } else {
      // 진행 중인 업무는 이미 손대고 있는 일이라 `오늘 할게요`를 띄우지 않는다.
      if (carried && !item.doing) move('오늘 할게요', todayStr(), '오늘 할 일로 옮겼어요');
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
// 묶음(BBUNDLE)에 든 지라 티켓은 대표 키 하나로 모인다(projectGroupKey) — 이름·색·`+`도 대표 티켓 것이다.
// waiting-ui.js:waitingGroups가 같은 규칙의 복제본이다 — 함께 고친다.
function uiGroupTasks(items) {
  const groups = new Map();
  items.forEach((item) => {
    const named = item.group || item.project;
    const raw = item.jira ? `jira:${item.jira}` : named ? `group:${named}` : '__misc__';
    const key = typeof projectGroupKey === 'function' ? projectGroupKey(raw) : raw;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  });
  const named = [...groups.keys()].filter(key => key !== '__misc__').sort();
  return (groups.has('__misc__') ? [...named, '__misc__'] : named).map(key => [key, groups.get(key)]);
}

// 묶음 그룹 아래 줄에만 붙이는 작은 티켓 번호(프로젝트 탭 묶음 상세의 .d-pfrom과 같은 모양) — 묶음이 아니면 ''.
function uiGroupFromKey(groupKey, item) {
  if (!item || !item.jira || typeof projectBundleOf !== 'function' || !projectBundleOf(groupKey)) return '';
  return item.jira;
}

// 레일 한 줄(확인 대기·리마인드·후속 알림). 제목은 한 줄 말줄임(title에 전체), 오른쪽은 조용한 글자.
// opts: { text, onOpen, wrap(2줄 허용), check(체크박스), badge(NEW 점), project(제목 뒤 `· ● 이름`), source, meta[{text,tone,strong}], sub, more, selected }
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
  // 원문이 있으면 제목 바로 뒤에 조용한 `원문` 링크(줄 열기로 번지지 않는다).
  // opts.project(`· ● 이름`, 리마인드)도 같은 묶음에서 제목 바로 뒤에 선다 — 원문보다 앞.
  if (opts.source || opts.project) {
    const wrap = document.createElement('span');
    wrap.className = 'tiwrap';
    wrap.append(...[title, opts.project, opts.source].filter(Boolean));
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
// 머리줄 ⋯의 `여러 개 선택`을 누르면 줄마다 완료 체크 자리에 선택 칸이 서고(완료 체크는 모드 동안 숨는다),
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
// 이름표에 체크박스가 말하던 우선순위·진행 중을 함께 읽힌다(`… — 중요 · 진행 중 · 선택`).
function taskSelectionCheckbox(item, row) {
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = 'd-selcb';
  input.checked = taskSelection.has(item.id);
  input.disabled = taskBatchBusy;
  const done = item.status === 'done';
  const priority = uiPriorityMark(item, done);
  const states = [priority ? priority.text : '', item.doing && !done ? '진행 중' : '', '선택'].filter(Boolean);
  input.setAttribute('aria-label', `${item.description} — ${states.join(' · ')}`);
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
  if (!taskSelectionMode) { bar.replaceChildren(); return; }

  const state = taskSelectAllState(taskSelectPool(), [...taskSelection]);
  // 개수 칸은 낭독기가 바뀔 때마다 읽는 자리(aria-live)라 모드 동안 같은 요소를 그대로 둔다 —
  // 새로 만들어 끼우면 바뀐 것이 아니라 새로 생긴 것이 되어 읽히지 않는다. 나머지 버튼만 다시 그린다.
  let inner = bar.querySelector('.bar');
  let count = inner && inner.children[0];
  if (!inner || !count || count.getAttribute('aria-live') !== 'polite') {
    bar.replaceChildren();
    inner = document.createElement('div');
    inner.className = 'bar';
    count = document.createElement('span');
    count.setAttribute('aria-live', 'polite');
    count.setAttribute('aria-atomic', 'true');
    inner.appendChild(count);
    bar.appendChild(inner);
  }
  [...inner.children].forEach((kid) => { if (kid !== count) inner.removeChild(kid); });

  // 막 켰을 때(0개)는 개수 대신 무엇을 하면 되는지 조용히 말한다.
  count.className = state.count ? 'ct num' : 'hint';
  count.textContent = state.count ? `${state.count}개 선택` : '줄을 눌러 골라요';
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
  }, 'd-btn is-group');
  // 옮기기 · 프로젝트 · 완료 · 삭제 묶음 사이만 조금 더 띄운다(is-group) — 삭제가 완료 바로 옆에 붙어 잘못 눌리지 않게.
  project.setAttribute('aria-haspopup', 'true');
  project.setAttribute('aria-expanded', 'false');
  actions.push(project);
  inner.appendChild(project);

  // 완료로 표시는 이 막대에서 가장 많이 누르는 동작이라 2차(연파랑)로 한 단계 올린다.
  apply('완료로 표시', { status: 'done' }, 'd-btn acc is-group');
  const remove = taskSelectBarButton('삭제', () => taskBatchRemove(), 'd-btn dng is-group');
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
}

// 날짜·프로젝트·완료 — 기존 일괄 저장 API 한 곳으로 간다. 되돌리기는 서버가 준 undoToken으로.
async function taskBatchApply(change) {
  if (taskBatchBusy || !taskSelection.size) return;
  taskBatchBusy = true;
  taskSelectionRefresh();
  document.querySelectorAll('.d-selcb').forEach(input => { input.disabled = true; });
  try {
    // 날짜를 옮길 때는 고른 업무를 미리 들고 있다가, 기한 때문에 오늘 목록에 남는 것이 있으면 알림이 말한다.
    const moved = Object.hasOwn(change, 'scheduled')
      ? [...(latestData?.todayTasks || []), ...(latestData?.laterTasks || [])].filter(task => taskSelection.has(task.id))
      : [];
    const result = await wfPost('task-batch', { ids: [...taskSelection], change });
    let token = result.undoToken;
    const restore = async () => { const back = await wfPost('task-batch', { undoToken: token }); token = back.undoToken; };
    const entry = { label: `${result.count}개 업무 일괄 정리`, undo: restore, redo: restore };
    pushUndo(entry);
    taskSelection.clear();
    await load();
    const stays = moved.length ? uiDueStaysNote(moved, change.scheduled) : '';
    showNotice(`${result.count}개를 바꿨어요${stays ? ` · ${stays}` : ''}`, false, null, { label: '실행 취소', onClick: async () => {
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

// ---------- 화면 상태 ----------

let jiraIssuesCache = [];
// 결정 카드마다 지라 목록을 처음부터 훑지 않도록, 목록을 받을 때 키로 한 번만 색인해 둔다.
let jiraIssuesByKey = new Map();
let customGroupsCache = [];
// 지라 키 → 앱 안 별칭(BJALIAS). projectLinks가 오는 자리(workflowData)와 같은 곳에서 받는다.
let projectAliasesCache = {};
let appVersion = null;

// 화면을 다시 그리면 쓰던 입력이 날아가므로, 자동 갱신은 입력 중이면 건너뛴다
function isTyping() {
  const el = document.activeElement;
  return !!(el && (el.matches('input, textarea, select') || el.isContentEditable));
}
let todaySort = 'project';
// 완료 그룹은 접힌 채로 시작한다 — 첫 화면에 오늘 할 일이 가장 많이 보이게.
let todayDoneOpen = false;
// 긴 목록은 위 3줄만 보이고 나머지는 `N개 더 ›`로 펼친다(프로젝트 카드의 읽는 그룹 — 새로 들어온 것은 놓치지 않게 접지 않는다).
// 펼침은 화면 메모리에만 — 새로고침하면 접힌 채로 시작하고, 3줄 이하로 줄면 접힘으로 돌아간다.
const UI_FOLD = 3;
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
  try { res = await request('/api/items'); } catch { refreshStorageStatus(); updateBusyCheck(); return; }
  const data = await res.json();
  updatingSeenAt = data.updating ? Date.now() : 0;
  updateBusySince = 0;
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

  // 여기부터 목록을 다시 그린다 — 그룹 `+` 줄·프로젝트 상세 추가 줄에 적던 글·초점·커서를 잡아 두었다가 끝에 되돌린다.
  const typingRow = uiAddRowSnapshot();
  // 미팅 노트 가져오기의 상태는 목록과 함께 온다 — 페이지를 새로 열어도 진행 중이면 같은 표시로 이어진다.
  meetingNotesApply(data.meetingNotes);
  jiraIssuesCache = data.jiraIssues || [];
  jiraIssuesByKey = new Map(jiraIssuesCache.map(issue => [issue.key, issue]));
  customGroupsCache = data.customGroups || [];
  workflowRender(data);
  projectAliasesCache = (workflowData && workflowData.projectAliases) || {};
  renderDateBar(data);
  renderCalendar(data.calendar);
  // 목록 안의 글자 칸(새로 들어온 것 제목 고치기·그룹 `+` 줄)에서 치는 중이면 그 목록은 손을 뗀 뒤 그린다.
  uiRenderOrHold('inbox', document.getElementById('inboxZone'), () => renderInbox(data.inboxTasks || []));
  renderUpdateNotice();
  renderNewsCard();
  renderGuideCard();
  uiRenderOrHold('later', document.getElementById('laterTaskList'), () => renderLaterTasks(data.laterTasks || []));
  renderWaiting(data.waiting || []);
  uiRenderOrHold('today', document.getElementById('todayTaskList'), () => renderTodayTasks(data.todayTasks || []));
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

  remindersRender(data);
  // 반응 필요(오늘 탭 맨 위)는 서버 메모리에서 따로 읽는다 — 목록 응답을 그것 때문에 늦추지 않는다.
  if (typeof attentionLoad === 'function') attentionLoad();
  syncTaskDetail();
  palSync();
  taskSelectionRefresh();
  uiAddRowRestore(typingRow);
}

// 내 담당 지라 목록(프로젝트 고르기 선택지·프로젝트 이름의 원천)도 서버가 지라에서 직접 읽는 값이다.
// 새로고침은 그 목록을 먼저 조용히 갱신하고 나서 화면을 다시 받는다. 곁들이는 일이라
// 실패해도(또는 이 주소가 없는 옛 서버여도) 알리지 않고 새로고침을 그대로 이어 간다.
async function refreshJiraListQuietly() {
  try {
    await fetch('/api/jira/list?fresh=1', { headers: { Accept: 'application/json' } });
  } catch { /* 새로고침은 그대로 진행한다 */ }
}

async function refreshListsFromServer() {
  await refreshJiraListQuietly();
  // 반응 필요도 같은 방식으로 지라에 새로 묻는다 — 다음 읽기 한 번만 `fresh=1`이 붙고,
  // 실패해도(또는 이 주소가 없는 옛 서버여도) 알리지 않는다.
  if (typeof attentionMarkFresh === 'function') attentionMarkFresh();
  await load();
}

// 열려 있지도 않은 탭의 카드를 load()마다 다시 만들 필요는 없다 — 숫자·NEW 표시는 그대로
// 갱신하고, 목록은 그 탭이 열려 있거나 열릴 때 만든다(새 자료가 오면 다시 만든다).
let latestData = null;
let activeTabKey = 'today';
const tabStale = { projects: true, meetings: true, records: true, weekly: true };
function renderActiveTabLists() {
  if (!latestData) return;
  // 프로젝트 탭의 빠른 추가·새 프로젝트 이름 같은 칸에서 치는 중이면 손을 뗀 뒤 그린다(uiRenderOrHold).
  if (activeTabKey === 'projects' && tabStale.projects) {
    // 미뤘다가 그릴 때 다른 탭으로 옮겨 가 있으면 그리지 않는다 — 탭을 다시 열 때 그린다(tabStale 그대로).
    uiRenderOrHold('projects', document.getElementById('projectBody'), () => { if (activeTabKey !== 'projects') return; tabStale.projects = false; renderProjects(); });
  }
  // 회의 탭은 글을 쓰는 면이다 — 초안 문구·직접 담기 칸에 손이 가 있으면 다시 그리지 않는다
  // (적던 글과 초점이 날아가지 않게. 줄 옆 카드의 syncTaskDetail과 같은 장치다). 손을 떼면 그때 그린다.
  if (activeTabKey === 'meetings' && tabStale.meetings) {
    uiRenderOrHold('meetings', document.getElementById('meetingBody'), () => { if (activeTabKey !== 'meetings') return; tabStale.meetings = false; renderMeetings(); });
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

// 그날의 첫 자동 갱신(캘린더 9:13 · 지라 9:17 · 슬랙 9시대)이 끝났을 시각.
const SYNC_FIRST_RUN_BY = '09:30';

// 연동마다 "늦었나 · 첫 읽기를 기다리나" — 톱니바퀴의 주황 점(renderDateBar)과 설정 › 연동의 요약·카드가 함께 쓰는
// **한 기준**이다. 재료는 서버가 /api/items와 /api/integrations(`sync`)에 똑같이 싣는 `slackSync`·`calendar`·`jiraSync`.
// - 쓰지 않는(`used: false`) 것·연결 안 된(`connected: false`) 것은 보지 않는다(연동 탭에 그 카드가 연결돼 있지 않다).
// - 한 번도 읽지 않은 것(`neverRead`)은 늦은 게 아니라 첫 읽기를 기다리는 것이다. 단 슬랙 수집이 launchd에 등록돼
//   있지 않으면(`scheduled: false`) 기다려도 읽지 않으므로 늦은 쪽(`setup`)에 넣는다.
// - 자동 갱신은 아침 9시대에 그날 처음 돈다. 그 전(자정~아침)의 `어제 기준`은 고장이 아니라 아직 돌 차례가 아닌
//   것이라 늦음으로 세지 않는다 — 오류가 있었거나 이틀 넘게 멈춘 것은 그대로 센다.
const SYNC_NAMES = { slack: '슬랙 수집', calendar: '캘린더', jira: '지라' };
function syncLag(data, { clock = nowHHMM(), now = Date.now() } = {}) {
  const out = { late: [], waiting: [] };
  if (!data) return out;
  const beforeFirstRun = clock < SYNC_FIRST_RUN_BY;
  [['slack', data.slackSync], ['calendar', data.calendar], ['jira', data.jiraSync]].forEach(([key, value]) => {
    // 값이 아예 없으면(그 연동을 싣지 않은 응답) 판단하지 않는다.
    if (!value || typeof value !== 'object') return;
    const source = value;
    if (source.used === false || source.connected === false) return;
    const name = SYNC_NAMES[key];
    if (source.neverRead && !source.error) {
      if (key === 'slack' && source.scheduled === false) {
        out.late.push({ key, name, setup: true, age: '시작 전', text: '아직 읽기 전이에요' });
      } else {
        out.waiting.push(key);
      }
      return;
    }
    const stale = key === 'calendar' ? !!(source.stale || !source.lastSync) : !!source.stale;
    if (!stale) return;
    const days = source.lastSync ? -diffDays(source.lastSync) : null;
    if (beforeFirstRun && !source.error && days === 1) return;
    out.late.push({
      key, name,
      age: days === null ? '동기화 안 됨' : days === 1 ? '어제 기준' : `${days}일 전 기준`,
      text: syncLagText(source.lastSuccessAt, days, now),
    });
  });
  return out;
}

// 늦은 카드의 주황 상태 줄 — 마지막으로 읽은 시각을 알면 `N시간째`, 날짜만 알면 `어제부터`·`N일째`.
function syncLagText(lastAt, days, now = Date.now()) {
  const at = Date.parse(lastAt || '');
  if (Number.isFinite(at) && at <= now) {
    const hours = Math.max(1, Math.floor((now - at) / 3600000));
    return hours < 48 ? `${hours}시간째 새로 읽지 못했어요` : `${Math.floor(hours / 24)}일째 새로 읽지 못했어요`;
  }
  if (days === null || days === undefined) return '아직 한 번도 읽지 못했어요';
  return days <= 1 ? '어제부터 새로 읽지 못했어요' : `${days}일째 새로 읽지 못했어요`;
}

// 지금 늦은 연동들(톱니바퀴의 주황 점과 툴팁). 누르면 설정 › 연동이 열리고 그 카드가 잠깐 밝아진다.
// 짧은 말(syncStaleSummary)은 aria-label에, 긴 문장은 paintGearBadge가 title에 쓴다.
let syncStale = [];
let syncStaleSummary = '';
function paintSyncGear(late) {
  syncStale = late.map(source => ({ key: source.key, text: `${source.name} ${source.age}` }));
  const ages = late.map(source => source.age);
  syncStaleSummary = !late.length ? ''
    : late.length === 1 ? syncStale[0].text
    : `자동 갱신 ${late.length}개 ${ages.every(age => age === ages[0]) ? ages[0] : '확인 필요'}`;
  const gear = document.getElementById('settingsBtn');
  if (!gear) return;
  gear.classList.toggle('has-stale', syncStale.length > 0);
  paintGearBadge();
}

// 톱니바퀴 점의 말 — 우선순위는 빨강(지금 멈춘 연동) > 주황(낡음) > 파랑(새 버전) > 없음(그냥 `설정`).
// has-alert·has-stale·has-update 클래스가 바뀌는 모든 자리에서 이 함수를 불러 title·aria-label을 한 곳에서 정한다.
function paintGearBadge() {
  const gear = document.getElementById('settingsBtn');
  if (!gear) return;
  const alertCount = typeof settingsAlertKeys !== 'undefined' ? settingsAlertKeys.length : 0;
  const hasUpdate = typeof settingsHasUpdate === 'function' && settingsHasUpdate();
  let summary = '';
  let title = '설정';
  if (alertCount > 0) {
    summary = `연동 ${alertCount}개가 멈췄어요`;
    title = `설정 — ${summary}. 누르면 연동 탭에서 봐요.`;
  } else if (syncStale.length > 0) {
    summary = syncStaleSummary;
    title = `설정 — ${summary}. 목록이 최신이 아닐 수 있어요. 누르면 연동 탭에서 봐요.`;
  } else if (hasUpdate) {
    summary = '새 버전이 있어요';
    title = `설정 — ${summary}`;
  }
  gear.title = title;
  gear.setAttribute('aria-label', summary ? `설정 — ${summary}` : '설정');
}

function renderDateBar(data) {
  const head = document.getElementById('workspaceTitle');
  if (data.title) {
    head.textContent = data.title;
    document.title = data.title;
  }
  // 헤더의 제목만 숨긴다(설정 › 꾸미기 `화면에 보이기`) — document.title은 위에서 그대로 쓴다.
  head.hidden = data.titleHidden === true;
  const bar = document.getElementById('dateBar');
  bar.replaceChildren();
  const date = document.createElement('span');
  date.className = 'd-date';
  date.textContent = uiKoDate(data.today);
  bar.appendChild(date);

  // 자동 갱신이 실패해도 화면엔 낡은 자료가 그대로 보이므로, 늦었을 때만 알린다.
  // 경고는 머리줄에 글자로 끼어들지 않는다 — 날짜 옆에 칸이 생기면 탭이 밀렸다(한 칸으로 줄여도 마찬가지).
  // 설정 톱니바퀴의 주황 점으로만 알리고, 무엇이 늦었는지는 톱니바퀴의 툴팁과 설정 › 연동의 카드가 말한다.
  // 실패(빨간 점, fetchAutomationStatus)가 함께 있으면 빨간 점이 이긴다(ui.css).
  paintSyncGear(syncLag(data).late);
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
  const calendarCount = document.getElementById('calendarSectionCount');
  calendarCount.textContent = events.length;
  calendarCount.hidden = !events.length; // 0은 적지 않는다 — 생기면 그 자리에 나타난다
  const meetingEntry = document.getElementById('wfMeetingEntry'); // 미팅이 없으면 `전체 보기`도 없다
  if (meetingEntry) meetingEntry.hidden = !events.length;
  const list = document.getElementById('calendarList');
  list.replaceChildren();
  if (!events.length) {
    const empty = document.createElement('div');
    empty.className = 'd-rempty';
    // 캘린더를 아예 끈 사람에게 "가져오지 못했어요"는 고장난 것처럼 읽힌다 — 켜는 자리를 알려 준다.
    if (calendar?.used === false) {
      // 문장 대신 켜는 자리로 가는 글자 버튼 하나 — 설정 > 연동의 캘린더로 간다.
      const connect = document.createElement('button');
      connect.type = 'button';
      connect.className = 'wf-link';
      connect.textContent = '캘린더 연결';
      connect.title = '캘린더를 켜면 오늘 일정이 보여요';
      connect.addEventListener('click', () => { if (typeof settingsOpen === 'function') settingsOpen('integrations'); });
      empty.appendChild(connect);
    } else {
      empty.textContent = calendar?.stale || !calendar?.lastSync ? '오늘 일정을 가져오지 못했어요.' : '오늘은 미팅이 없어요.';
    }
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
// `onLinked(새 열쇠, 이전 열쇠)`는 회의 정리 카드·회의 탭 머리의 ⋯에서만 넘긴다 — 프로젝트를 연결·변경·해제한 뒤
// 그 자리에 `이미 담은 N개도 옮길까요?`(해제면 `뺄까요?`)를 세운다(meetings-ui.js). 넘기지 않은 자리(오늘 탭 레일)는
// 알림의 버튼으로 묻는다(meetingMoveOffer). 보내는 meetingId는 연결을 고른 그 회의다 — 지난 회의에서 연결해도
// 그 회의의 프로젝트가 함께 바뀐다.
function meetingMenuSections(event, { open = true, toTab = true, fetchAll = false, onLinked = null } = {}) {
  // 레일의 캘린더 줄에는 번호가 `workflowId`로 온다 — 흐름 기록에 있는 회의만 탭에서 고를 수 있다.
  const tabId = event.id || event.workflowId || null;
  const setProject = async (projectKey) => {
    const previous = typeof wfMeetingKey === 'function' ? wfMeetingKey(event) : null;
    await request('/api/meeting/set-project', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: event.title, project: projectKey, ...(event.id ? { meetingId: event.id } : {}) }),
    });
    await load();
    const norm = key => (typeof meetingMoveNormKey === 'function' ? meetingMoveNormKey(key) : (key || null));
    if (norm(projectKey) === norm(previous)) return;
    if (typeof onLinked === 'function') onLinked(projectKey || null, previous || null);
    else if (typeof meetingMoveOffer === 'function') meetingMoveOffer(event.id || event.workflowId || null, previous || null, projectKey || null);
  };
  const actions = [];
  if (open) actions.push({ label: '회의 정리 열기', onClick: () => openMeetingPanel(event) });
  if (toTab && tabId) actions.push({ label: '회의 탭에서 열기', onClick: () => openMeetingsTab(tabId) });
  if (fetchAll && meetingNotesState.used !== false) {
    const pending = meetingNotesPendingToday();
    actions.push(pending > 0
      ? { label: `오늘 것 모두 가져오기 ${pending}`, disabled: meetingNotesBusy(), onClick: () => meetingNotesStart('today') }
      : { label: '오늘 미팅 노트는 다 가져왔어요', disabled: true, onClick: () => {} });
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

// 배포 임박 한 줄 — 확인 대기와 같은 두 줄 부품이다.
//   첫 줄: 프로젝트 이름(눌러서 프로젝트 탭)
//   둘째 줄: `v2.70.0 배포 3일 전`(주의색·급함 색 글자, 배지가 아니다) + `열린 업무 2`
// 닫기·미루기는 없다 — 배포되거나 열린 항목이 없어지면 스스로 사라진다.
// 지라 키는 어디에도 싣지 않는다(BKEY 결정).
function deployReminderRow(entry) {
  const sub = document.createDocumentFragment();
  const when = document.createElement('span');
  when.className = uiTone(entry.tone).trim();
  when.textContent = `${entry.name} ${entry.text}`;
  sub.appendChild(when);
  const open = document.createElement('span');
  open.className = 'nx';
  open.textContent = `열린 업무 ${entry.open}`;
  sub.appendChild(open);

  const row = uiRailRow({
    text: entry.label,
    two: true,
    sub,
    onOpen: () => openProjectTab(entry.key),
  });
  const title = row.querySelector('.ti');
  if (title) {
    const line = `${entry.name} ${entry.text} · ${entry.label} · 열린 업무 ${entry.open}`;
    title.title = line;
    title.setAttribute('aria-label', `${line} — 프로젝트 열기`);
  }
  return row;
}

// 레일의 리마인드 — 배포가 코앞인 프로젝트, 기다리던 답변이 온 업무, 기한이 코앞인 높은 우선순위
// 업무가 함께 온다(고르는 곳은 load()). 차례는 급한 순이다: 배포 임박(되돌릴 수 없는 바깥 일정이라
// 가장 앞) → 답변 왔어요 → 기한. 제목은 2줄까지 허용한다. 안 가져온 미팅 노트는 여기 오르지 않는다 —
// 노트를 안 쓰는 회의도 많아 매번 알리면 소음이었다. 회의 탭이 그 회의에서 알린다.
const DEPLOY_REMINDER_MAX = 4;

// `답변 왔어요`를 이미 열어 본 업무인지 — 서버가 적어 둔 answerSeen.answer가 지금의 답(기다리던 확인 대기 번호 +
// 그 완료일)과 같을 때만 본 것으로 친다. 다른 확인 대기에 다시 걸렸다가 답이 오면 값이 달라져 다시 뜬다.
function answerSeenFor(item) {
  const entry = item && typeof wfItem === 'function' ? wfItem(item.id) : null;
  const blockerId = (entry && entry.blockedBy) || (item && item.blockedBy);
  const blocker = blockerId && typeof wfItem === 'function' ? wfItem(blockerId) : null;
  if (!entry || !blocker || blocker.status !== 'done' || !entry.answerSeen) return false;
  return entry.answerSeen.answer === `${blockerId}:${blocker.completed || ''}`;
}

// 리마인드 카드에 올릴 것을 지금 가진 값으로 골라 그린다 — load()와, 답변을 확인한 상세를 닫을 때 함께 쓴다.
function remindersRender(data = latestData) {
  if (!data) return;
  const todayIds = new Set((data.todayTasks || []).map(t => t.id));
  const reminders = [...(data.todayTasks || []), ...(data.laterTasks || [])]
    .filter(t => !todayIds.has(t.id) && t.status !== 'done' && t.due && diffDays(t.due) <= 1 && (t.priority === 'high' || t.priority === 'critical'))
    .sort((a, b) => diffDays(a.due) - diffDays(b.due));
  // 기다리던 답변이 온 업무도 리마인드 카드에 함께 올린다(옛 `답변이 해결된 업무` 묶음 자리).
  // 한 번 열어 본 것(answerSeenFor)은 뺀다 — 다만 지금 그 업무의 상세가 열려 있으면 닫을 때까지 둔다
  // (상세 카드가 붙어 있는 줄이 사라지면 카드도 함께 닫힌다).
  const answered = (workflowData?.items || [])
    .filter(item => ['task', 'bug'].includes(item.type) && item.status !== 'done' && item.blockedBy && wfItem(item.blockedBy)?.status === 'done')
    .filter(item => !answerSeenFor(item) || (panelState && panelState.kind !== 'meeting' && panelState.id === item.id))
    .map(item => itemsById.get(item.id) || item);
  // 배포가 코앞인 프로젝트도 같은 카드에 올린다 — 프로젝트를 열어야만 배포일이 보여 놓치기 쉬웠다.
  // 프로젝트 목록은 프로젝트 탭과 같은 함수로 만든다(열린 항목 수도 그 값 그대로다).
  renderReminders(reminders, answered, deployReminders(uiProjectRows(wfProjects(), workflowData.items)));
}

// 업무 상세를 열면 `답변 왔어요`를 확인한 것으로 서버에 적는다(어디서 열든 — 리마인드 줄이든 오늘 목록이든).
// **서버가 적은 뒤에만** 화면 값을 바꾸고 줄을 뺀다: 상세가 아직 열려 있으면 닫을 때(panelClose), 이미 닫혔으면
// 그 자리에서 빼며 `답변 확인했어요 · 되돌리기`를 띄운다. 보내기가 실패하면 줄은 그대로이고 **아무것도 알리지 않는다**
// — 상세를 열기만 했는데 저장 실패 알림이 뜨면 안 된다(그래서 request()가 아닌 조용한 fetch를 쓴다).
let answerSeenClosePending = null;
async function answerSeenMark(id) {
  const entry = typeof wfItem === 'function' ? wfItem(id) : null;
  if (!entry || !['task', 'bug'].includes(entry.type) || entry.status === 'done' || !entry.blockedBy) return;
  const blocker = wfItem(entry.blockedBy);
  if (!blocker || blocker.status !== 'done' || answerSeenFor(entry)) return;
  let saved = null;
  try {
    const response = await fetch('/api/workflow/answer-seen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
    const data = await response.json();
    if (response.ok && data && data.ok) saved = data.answerSeen;
  } catch { saved = null; }
  if (!saved) return;
  entry.answerSeen = saved;
  if (panelState && panelState.kind !== 'meeting' && panelState.id === id) { answerSeenClosePending = id; return; }
  remindersRender();
  answerSeenNotice(id);
}

// 리마인드에서 빠지는 순간 알린다 — `답변 확인했어요 · 되돌리기`. 되돌리면 서버의 확인 표시를 지우고 줄이 다시 선다.
// ⌘Z도 같은 기록 하나를 쓴다(기존 pushUndo·replayUndo를 부르기만 한다).
function answerSeenNotice(id) {
  const item = itemsById.get(id) || (typeof wfItem === 'function' ? wfItem(id) : null);
  const entry = {
    label: item && item.description ? `${item.description} (답변 확인)` : '답변 확인',
    undo: () => postJson('/api/workflow/answer-seen-undo', { id }),
    redo: () => postJson('/api/workflow/answer-seen', { id }),
  };
  pushUndo(entry);
  showNotice('답변 확인했어요', false, null, {
    label: '되돌리기',
    onClick: async () => {
      if (undoStack[undoStack.length - 1] !== entry) { showNotice('최근 작업부터 순서대로 실행 취소해 주세요', true); return; }
      await replayUndo('undo');
    },
  });
}

function renderReminders(reminders, answered = [], deploys = []) {
  const zone = document.getElementById('reminderZone');
  const list = document.getElementById('reminderList');

  const total = reminders.length + answered.length + deploys.length;
  document.getElementById('reminderSectionCount').textContent = total;
  zone.hidden = total === 0;

  list.replaceChildren();
  // 제목 뒤에 오늘 목록과 같은 `· ● 프로젝트`(별칭 반영, 없으면 아무것도 붙이지 않는다).
  const row = (item, meta) => uiRailRow({
    id: item.id,
    text: item.description,
    wrap: true,
    selected: !!panelState && panelState.id === item.id,
    project: uiProjectColorKey(item) ? uiInlineProject(item) : null,
    source: uiSourceLink(item),
    meta,
    onOpen: () => panelOpen({ id: item.id }),
  });
  // 배포일은 미룰 수 없는 바깥 일정이라 카드 맨 위에 선다. 넷까지만 적고 나머지는 숫자로만 알린다.
  deploys.slice(0, DEPLOY_REMINDER_MAX).forEach(entry => list.appendChild(deployReminderRow(entry)));
  if (deploys.length > DEPLOY_REMINDER_MAX) {
    const more = document.createElement('div');
    more.className = 'd-rempty';
    more.textContent = `외 ${deploys.length - DEPLOY_REMINDER_MAX}개`;
    list.appendChild(more);
  }
  // 기다리던 답변이 온 업무가 그다음이다 — 지금 바로 이어서 할 수 있는 일이다.
  answered.forEach(item => list.appendChild(row(item, [{ text: '답변 왔어요', tone: 'success' }])));
  reminders.forEach(item => list.appendChild(row(item, [uiDueText(item.due)])));
}

// weekKey(월요일, 'YYYY-MM-DD')를 "9월 3주차" + "9/14 ~ 9/20" 두 줄로 보여줄 조각으로 쪼갠다.
// 몇째 주인지는 **목요일 기준**(사용자 결정 2026-09-30): 월~일 주를 그 주 목요일이 속한 달(연도도)의 N주차로 부르고,
// N은 그 달에서 목요일이 몇 번째인지다 — 9/28~10/4는 `10월 1주차`, 12/29~1/4는 이듬해 `1월 1주차`.
function formatWeekLabel(weekKey) {
  const monday = new Date(`${weekKey}T00:00:00`);
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);
  const thursday = new Date(monday);
  thursday.setDate(thursday.getDate() + 3);
  const weekOfMonth = Math.ceil(thursday.getDate() / 7);
  const fmt = (d) => `${d.getMonth() + 1}/${d.getDate()}`;
  return {
    week: `${thursday.getMonth() + 1}월 ${weekOfMonth}주차`,
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
  // 주차 목록 칸 맨 위(머리 바로 아래, 첫 주 앞)에 끼울 자리 — '내 일 기록' 판(하루 평균·최고 기록 + `내 일 기록 자세히`).
  // report-ui.js의 reportWeeksFoot → usage-ui.js. 목록이 길어도 머리와 함께 위에 머문다(usage-ui.css).
  const foot = typeof reportWeeksFoot === 'function' ? reportWeeksFoot(items) : null;
  if (foot) nav.appendChild(foot);
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
    // 줄 오른쪽 끝에 끼울 자리('내 일 기록'의 끝낸 일 막대·숫자 — report-ui.js의 reportWeekRowEnd → usage-ui.js, 기록 없는 주는 null).
    const end = typeof reportWeekRowEnd === 'function' ? reportWeekRowEnd(item) : null;
    if (end) btn.appendChild(end);
    btn.setAttribute('aria-label', `${name}, ${label.range}${fresh ? `, 새 기록 ${fresh}개` : ''}${end && end.dataset && end.dataset.label ? `, ${end.dataset.label}` : ''}`);
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
    empty.textContent = '이번 주에 완료한 업무가 생기면 여기 문장이 만들어져요';
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
// 빈 문장은 고정 문구뿐이다(사용자 값을 넣지 않는다). 입력 칸 바로 아래의 짧은 빈 문장은 `is-short`.
function renderRecordColumn(list, items, row, emptyText, emptyTone = '') {
  list.replaceChildren();
  if (!items.length) {
    list.insertAdjacentHTML('beforeend', `<div class="d-empty${emptyTone ? ` ${emptyTone}` : ''}">${emptyText}</div>`);
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
function recordTitleCell(row, title, item, projectName, showSource = true, extra = null) {
  const source = showSource ? uiSourceLink(item) : null;
  if (!projectName && !source && !extra) { row.appendChild(title); return; }
  const wrap = document.createElement('span');
  wrap.className = 'd-titlewrap';
  wrap.appendChild(title);
  if (projectName) wrap.appendChild(uiInlineProject(item));
  if (extra) wrap.appendChild(extra);
  if (source) wrap.appendChild(source);
  row.appendChild(wrap);
}

// 결정에 적어 둔 `내용`이 있을 때만 제목 뒤에 서는 조용한 표시. 누르면 그 결정의 상세 카드가 열린다.
// 내용 자체는 카드에서 읽고 고친다 — 목록 줄은 훑어보는 자리라 본문을 펼치지 않는다.
function recordNoteMark(item) {
  const note = (typeof wfItem === 'function' ? wfItem(item.id)?.note : '') || '';
  if (!note.trim()) return null;
  const mark = document.createElement('button');
  mark.type = 'button';
  mark.className = 'd-recnote';
  mark.textContent = '내용';
  mark.title = '적어 둔 내용을 카드에서 읽어요';
  mark.setAttribute('aria-label', `${item.description} — 내용 보기`);
  mark.addEventListener('click', (event) => { event.stopPropagation(); panelOpen({ id: item.id }); });
  return mark;
}

// 결정 아래 정보 줄에 넣을 부분들 — 날짜(created)·나온 회의(meetingId → 회의 제목)·원문 가운데
// 실제로 있는 값만, 이 순서로. DOM 없이도 조립 규칙을 확인할 수 있게 데이터만 뽑아 둔다.
function recordInfoParts(item, dateWord = '결정') {
  const parts = [];
  if (item.created) parts.push({ kind: 'date', text: `${uiKoDateShort(item.created)} ${dateWord}` });
  const meetingId = (typeof wfItemsById !== 'undefined' ? wfItemsById.get(item.id) : null)?.meetingId;
  const meeting = meetingId && typeof workflowData !== 'undefined'
    ? workflowData.meetings.find(event => event.id === meetingId) : null;
  if (meeting) parts.push({ kind: 'meeting', text: `${meeting.title}에서`, meetingId: meeting.id });
  if (item.permalink) parts.push({ kind: 'source', text: '원문' });
  return parts;
}

// 위 부분들을 실제 줄로 그린다 — 회의는 눌러서 회의 탭으로, 원문은 uiSourceLink 그대로.
function recordInfoLine(item, dateWord) {
  const parts = recordInfoParts(item, dateWord);
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
  countEl.hidden = !items.length;
  countEl.title = decisionPendingTitle(items.length);
  const segBtn = document.getElementById('recordViewDecisionBtn');
  if (segBtn) segBtn.textContent = `결정 ${items.length}`;
  decisionToolsSync();
  renderRecordColumn(document.getElementById('decisionList'), items.filter(decisionMatches),
    item => recordDecisionRow(item, false),
    decisionQuery ? '찾는 결정이 없어요.' : '정해진 내용이 아직 없어요. 적어 두면 PRD 반영까지 여기서 챙겨요.',
    decisionQuery ? '' : 'is-short');
}

// 결정이 하나도 없으면(미반영 0 · 반영 완료 0) 찾을 것도 펼칠 것도 없다 — `결정 찾기` 칸과 `반영 완료` 접힘을 숨긴다.
// 반영 완료가 하나라도 있으면 그대로 둔다. 숨길 때 찾기 칸에 남은 글자는 비운다(다음 결정이 생겼을 때 안 보이는 거름망이 되지 않게),
// 초점이 찾기 칸에 있었으면 바로 아래 `결정 추가` 칸으로 옮긴다.
function decisionToolsSync() {
  const none = !decisionCache.length && !decisionArchiveCache.length;
  const search = document.getElementById('decisionSearch');
  const zone = document.getElementById('decisionArchiveZone');
  if (search) {
    if (none && document.activeElement === search) document.getElementById('decisionInput')?.focus();
    if (none && (search.value || decisionQuery)) { search.value = ''; decisionQuery = ''; }
    search.hidden = none;
  }
  if (zone) zone.hidden = none;
}

function renderIdeas(items) {
  const countEl = document.getElementById('ideaCount');
  countEl.textContent = items.length;
  countEl.hidden = !items.length;
  const segBtn = document.getElementById('recordViewIdeaBtn');
  if (segBtn) segBtn.textContent = `아이디어 ${items.length}`;
  renderRecordColumn(document.getElementById('ideaList'), items,
    recordIdeaRow, '아이디어가 아직 없어요. 떠오를 때 적어 두는 자리예요.', 'is-short');
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
  decisionToolsSync();
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
  recordTitleCell(row, title, item, archived ? recordProjectName(item) : '', false, recordNoteMark(item));

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

// ---------- 두 줄 말줄임 제목: 실제로 잘렸을 때만 펼치기 ----------
// 아이디어 줄·회의에서 나온 줄의 제목은 평소 두 줄까지 보인다. **정말 잘렸을 때만**(내용이 두 줄을 넘을 때)
// 제목이 펼치기 버튼이 되고(`.is-clamp` · aria-expanded · 손가락 커서), 누르면 그 자리에서 전문(`.is-open`),
// 다시 누르면 접힌다. 잘리지 않은 제목은 펼칠 것이 없으니 원래 동작(회의 줄은 상세 열기·문구 고치기,
// 아이디어는 누를 수 없는 글자)을 한다. 그릴 때(다음 화면 갱신)와 창 크기가 바뀔 때 다시 잰다.
// 잘렸는지 재는 함수 — 가짜 DOM 테스트는 이것을 바꿔 끼운다.
let uiTitleClamped = el => !!el && el.scrollHeight > el.clientHeight + 1;
function uiClampMark(row, title, onMode) {
  const open = String(row.className).includes(' is-open');
  // 펼친 뒤에는 잘림이 없어도 접을 수 있어야 한다 — 펼침 모드를 유지한다.
  const clamp = open || !!uiTitleClamped(title);
  const had = String(row.className).includes(' is-clamp');
  if (clamp && !had) row.className = `${row.className} is-clamp`;
  if (!clamp && had) row.className = String(row.className).replace(' is-clamp', '');
  if (clamp) title.setAttribute('aria-expanded', String(open));
  else title.removeAttribute('aria-expanded');
  if (typeof onMode === 'function') onMode(clamp);
  return clamp;
}
// 제목 하나에 잘림 판단을 건다. onMode(clamp)는 모드가 정해질 때마다 불린다(이름표·역할을 맞추는 자리).
// 창 크기가 바뀌면 화면에 있는 제목(`.js-clamp`)을 다시 잰다(아래 실행 코드의 resize 리스너).
function uiClampWatch(row, title, onMode) {
  const sync = () => uiClampMark(row, title, onMode);
  title.clampSync = sync;
  title.classList.add('js-clamp');
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(sync);
  else sync();
  return sync;
}
// 펼침 ↔ 접힘. 잘리지 않은 제목이면 false(부르는 쪽이 원래 동작을 한다).
function uiClampToggle(row, title) {
  if (!String(row.className).includes(' is-clamp')) return false;
  const open = !String(row.className).includes(' is-open');
  row.className = open ? `${row.className} is-open` : String(row.className).replace(' is-open', '');
  title.setAttribute('aria-expanded', String(open));
  return true;
}
function uiClampResync() {
  document.querySelectorAll('.js-clamp').forEach((title) => { if (typeof title.clampSync === 'function') title.clampSync(); });
}

// 아이디어 한 줄: 체크박스 없이 문구 + 원문 | `가능성 높음` | 늘 보이는 더보기.
function recordIdeaRow(item) {
  const row = document.createElement('div');
  row.className = 'd-rec is-idea';
  row.dataset.itemId = item.id;

  // 평소 두 줄, **잘렸을 때만** 누르면 그 자리에서 전문(다시 누르면 접힘) — 잘리지 않은 아이디어는 누를 수 없는
  // 평범한 글자다(uiClampWatch). 원문은 제목 옆이 아니라 아래 정보 줄에 — 제목과 같이 잘려 사라지던 것.
  const title = document.createElement('span');
  title.className = 'ti';
  title.textContent = item.description;
  title.title = item.description;
  uiClampWatch(row, title, (clamp) => {
    if (clamp) { title.setAttribute('role', 'button'); title.tabIndex = 0; }
    else { title.removeAttribute('role'); title.removeAttribute('tabindex'); title.tabIndex = -1; }
  });
  title.addEventListener('click', () => uiClampToggle(row, title));
  title.addEventListener('keydown', (event) => {
    if ((event.key === 'Enter' || event.key === ' ') && !event.isComposing && uiClampToggle(row, title)) event.preventDefault();
  });
  if (item.isNew) { title.prepend(renderNewDot(item)); observeNewItem(row, item); }
  recordTitleCell(row, title, item, '', false);

  const meta = document.createElement('span');
  meta.className = 'mt';
  meta.textContent = ideaChanceText(item);
  row.appendChild(meta);

  const info = recordInfoLine(item, '적음');
  if (info) row.appendChild(info);

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
    await setPriority(item.id, value, '가능성 변경');
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

function renderLaterTasks(items) {
  document.getElementById('laterTaskSectionCount').textContent = items.length;
  document.getElementById('laterDrawerCount').textContent = items.length;
  laterToggleSync(items.length);
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
      .forEach(item => list.appendChild(uiTaskRow(item, { mode: 'later', grouped: key !== '__misc__', fromKey: uiGroupFromKey(key, item) })));
  });
}

// 머리줄의 `나중에 할 일 N` 버튼은 1개 이상일 때만 선다(0이면 열어도 볼 게 없다). 서랍이 열린 채 0이 되면
// 서랍은 그대로 두고(서랍의 닫기 버튼이 있다) 버튼만 숨긴다 — 초점이 버튼에 있었으면 서랍 닫기(닫혀 있으면 할 일 입력칸)로 옮긴다.
function laterToggleSync(count) {
  const toggle = document.getElementById('laterTaskToggle');
  if (!toggle) return;
  const hadFocus = !count && document.activeElement === toggle;
  toggle.hidden = !count;
  if (hadFocus) document.getElementById(laterDrawerOpen ? 'laterTaskClose' : 'todayTaskInput')?.focus();
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
  // 버튼이 숨어 있으면(나중에 할 일 0) 오늘 할 일 입력칸으로 — 사라진 자리에 초점을 두지 않는다.
  const toggle = document.getElementById('laterTaskToggle');
  document.getElementById(toggle && !toggle.hidden ? 'laterTaskToggle' : 'todayTaskInput')?.focus();
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
  // 진행 중(미완료 + doing)은 체크박스 안 왼쪽 절반이 파랗게 찬다 — 모양으로 말하고 title·aria-label이 말을 붙인다.
  const doing = !done && !!(item && item.doing);
  checkbox.className = 'd-cb' + (mark ? ` is-pri-${mark.level}` : '') + (doing ? ' is-doing' : '');
  checkbox.checked = done;
  const hint = [mark && mark.hint, doing && '진행 중인 업무예요'].filter(Boolean).join(' · ');
  if (hint) checkbox.title = hint;
  checkbox.setAttribute('aria-label', `${item.description} — ${mark ? `${mark.text} · ` : ''}${doing ? '진행 중 · ' : ''}완료로 표시`);
  checkbox.addEventListener('change', () => {
    // 끝내는 순간을 눈으로 보여 준다: 체크가 그려지고 → 제목에 줄이 그어지고 → 옅어진다.
    // 저장·되돌리기 쪽은 그대로다(클래스 하나만 붙인다. 움직임 줄이기에서는 ui.css가 끈다).
    if (!done) card.classList.add('is-completing');
    const mark = uiUndoMark();
    fadeOutAndRun(card, async () => { await toggleTask(item.id); if (!done) workflowOutcome(item, uiUndoOwn(mark)); }, done ? '미완료로 되돌렸어요' : null);
  });
  return checkbox;
}

// "언제 할지" 칩. 날짜를 직접 고르려면 `날짜…`가 그 자리에서 날짜 칸으로 바뀐다.
function taskWhenControl(item, mode, card) {
  const wrap = document.createElement('span');
  wrap.className = 'd-chips';
  const move = async (scheduled, message) => {
    uiMenuClose();
    await uiMoveRun(card || wrap, () => setTaskScheduled(item.id, scheduled), uiMoveNotice(message, [item], scheduled));
  };
  const options = [['오늘', todayStr(), '오늘 할 일로 옮겼어요'], ['내일', tomorrowStr(), '내일로 미뤘어요']];
  // 이미 나중에 있는 업무에 `나중에`를 또 보여 주지 않는다.
  if (mode !== 'later') options.push(['나중에', null, '나중에 할 일로 옮겼어요 · 기한은 그대로예요']);
  options.forEach(([text, scheduled, message]) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    const on = (scheduled && item.scheduled === scheduled) || (!scheduled && mode === 'later');
    chip.className = 'd-chip' + (on ? ' is-on' : '');
    chip.setAttribute('role', 'menuitemradio');
    chip.setAttribute('aria-checked', String(!!on));
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

// opts.plain: 상세 카드의 필드 격자에서만 켠다(`● 이름 ⌄` 글자 고르개). ⋯ 메뉴는 알약 그대로.
function taskProjectControl(item, opts = {}) {
  return renderGroupControl({
    jira: item.jira,
    group: item.group,
    onSetJira: (key) => setTaskJira(item.id, key),
    onSetGroup: (group) => setTaskGroup(item.id, group),
    plain: !!opts.plain,
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
    onClick: () => uiMoveRun(card, () => toggleTask(item.id), '완료했어요'),
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
// 저장 버튼은 없다 — 값이 바뀔 때 저장한다(안내 문장은 없다).

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
    // 좁은 폭 시트를 닫으면 초점이 돌아갈 줄(연 줄이 옮겨져 사라졌으면 다음 줄, 없으면 목록 머리).
    sheetReturn: detailSheet() && kind === 'item'
      ? panelSheetSpot(detailRowMatches(detailLastRow, view, kind) ? detailLastRow : opener?.closest?.('[data-task-id]')) : null,
    // 누른 줄이 어느 목록에 있었는지 — 같은 항목이 여러 목록에 보일 때 그 자리에 카드를 붙인다.
    anchorHost: detailRowHostId(detailRowMatches(detailLastRow, view, kind) ? detailLastRow : null),
  };
  // Esc는 가장 위에 열린 것부터 닫는다 — 다시 열면 맨 위로 올린다.
  escDrop(panelClose);
  escPush(panelClose);
  panelRender(true);
  if (kind === 'item') answerSeenMark(view.id);
}

function panelClose() {
  const side = panelSide();
  const back = panelState?.returnFocus;
  const sheetReturn = panelState?.sheetReturn;
  let reopen = panelState?.back;
  panelState = null;
  panelFocusField = null;
  escDrop(panelClose);
  detailUnmount(); // 떠 있는 카드와 거기 붙은 스크롤·크기 감시를 함께 거둔다
  document.querySelectorAll('.is-sel[data-task-id], .d-wrow.is-sel, .d-mrow.is-sel').forEach(row => row.classList.remove('is-sel'));
  if (side) { side.hidden = true; side.replaceChildren(); }
  panelScrim(false);
  // 방금 `답변 왔어요`를 확인한 업무의 상세를 닫으면 리마인드 카드를 다시 그려 그 줄을 뺀다
  // (열려 있는 동안은 카드가 붙어 있는 줄이라 남겨 두었다).
  if (answerSeenClosePending) {
    const seenId = answerSeenClosePending;
    answerSeenClosePending = null;
    remindersRender();
    answerSeenNotice(seenId);
  }
  // 팔레트에서 열었던 항목이면 찾던 자리로 돌려 놓는다(포커스도 검색 입력으로).
  // 팔레트 → 회의 → 항목처럼 거쳐 왔어도 처음 찾던 자리로 돌아간다.
  while (reopen && reopen.kind === 'meeting') reopen = reopen.back;
  if (reopen && reopen.kind === 'palette') { palOpen(reopen.state); return; }
  // 좁은 폭 시트를 줄에서 열었으면 그 줄 제목으로 — 줄의 빈 자리를 누르면 초점이 목록 칸(todayTaskZone)에 가 있어 back으로는 모자란다.
  if (sheetReturn && panelSheetFocus(sheetReturn)) return;
  if (back && back.isConnected) back.focus();
}

// 시트를 연 줄을 다시 찾을 표식 — 항목 번호, 바로 다음 업무 줄의 번호, 들어 있던 목록.
function panelSheetSpot(row) {
  if (!row || !row.dataset || row.dataset.taskId === undefined) return null;
  let next = row.nextElementSibling;
  while (next && (!next.dataset || next.dataset.taskId === undefined)) next = next.nextElementSibling;
  return { id: row.dataset.taskId, nextId: next ? next.dataset.taskId : null, host: detailRowHostId(row) };
}

// 시트가 닫히면 초점은 연 줄 제목으로 — 줄이 옮겨져 사라졌으면 다음 줄 제목, 그것도 없으면 목록 머리(제목 글자).
function panelSheetFocus(spot) {
  const host = spot.host ? document.getElementById(spot.host) : null;
  if (!host) return false;
  const rowOf = id => (id === null || id === undefined ? null : host.querySelector(`[data-task-id="${CSS.escape(String(id))}"]`));
  const row = rowOf(spot.id) || rowOf(spot.nextId);
  const title = row && row.querySelector('.d-title, .ti');
  if (title) { title.focus(); return true; }
  const head = host.closest ? host.closest('.d-drawer, .d-pwrap, main')?.querySelector('h2') : null;
  if (!head) return false;
  if (!head.hasAttribute('tabindex')) head.setAttribute('tabindex', '-1');
  head.focus();
  return true;
}

// 좁은 폭 시트 뒤의 가림막(설정 창과 같은 --scrim) — 시트 뒤 목록이 눌리지 않게 막고, 누르면 시트를 닫는다.
// 회의 정리만은 빈 자리를 눌러도 닫히지 않는 규칙 그대로다(✕·Esc로 닫는다).
let panelScrimEl = null;
function panelScrim(show) {
  if (!panelScrimEl) {
    if (!show || !document.body) return;
    panelScrimEl = document.createElement('div');
    panelScrimEl.className = 'd-scrim';
    panelScrimEl.setAttribute('aria-hidden', 'true');
    panelScrimEl.addEventListener('click', () => { if (panelState && panelState.kind !== 'meeting') panelClose(); });
    document.body.appendChild(panelScrimEl);
  }
  panelScrimEl.hidden = !show;
}

// 시트를 연 채 창이 넓어지면(휴대폰 가로 돌리기 등) 시트 자리는 숨는다 — 같은 내용을 줄 옆 카드로 옮겨 그린다
// (붙을 줄이 없으면 panelRender가 닫는다). 가림막도 함께 걷는다.
function panelSheetResize() {
  if (!panelState || !panelScrimEl || panelScrimEl.hidden || detailSheet()) return;
  const side = panelSide();
  if (side) { side.hidden = true; side.replaceChildren(); }
  panelScrim(false);
  panelRender();
}
window.addEventListener('resize', panelSheetResize);

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
  // 갈아 끼우기 전에 초점이 옛 카드 안에 있었는지 본다 — 있었으면 카드와 함께 사라지므로 새 카드에서 되돌린다.
  const before = panelDetailBox();
  const focusFrom = before && document.activeElement && before.contains(document.activeElement) ? document.activeElement : null;
  if (detailSheet()) { if (!panelSheetMount(box, focusFirst)) return; }
  else if (!detailPopMount(box, focusFirst)) { panelClose(); return; }
  if (!meeting) panelFocusTrack(box);
  if (!meeting && !focusFirst) panelFocusRestore(box, focusFrom);
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
  panelScrim(true);
  if (focusFirst) panelFocusFirst(box);
  return true;
}

// 열면 고칠 곳으로 바로 간다 — 업무·확인 대기는 제목, 회의는 검토할 초안이 없을 때만 발의 입력줄(회의에서 나온 것 적기).
function panelFocusFirst(box) {
  const first = panelState?.kind === 'meeting' ? ((!box.querySelector('.d-drafts') && box.querySelector('.d-qin input')) || box) : box.querySelector('.d-dtitle');
  first?.focus?.();
}

// 저장하면 load()가 카드를 새로 그려 초점이 문서 전체(<body>)로 빠진다 — 방금 고친 필드의 누르는 자리로 돌려준다.
// 필드는 dd의 이름표(data-field — panelField가 붙인다)로 찾고, 없어졌으면 카드 제목으로 간다.
// 우선순위·언제 할지·프로젝트·기다리는 답변·날짜 칸이 모두 이 한 길을 쓴다(고르개가 카드 밖 메뉴여도 필드는 기억한다).
// 사람이 이미 다른 곳(다른 줄·입력칸)에 초점을 두었으면 건드리지 않는다. 프로그램 초점이라 마우스로 고른 뒤에는
// :focus-visible 테가 뜨지 않고(브라우저 규칙), 키보드로 고른 뒤에는 뜬다.
let panelFocusField = null; // { id, field } — 마지막으로 만진 필드
function panelFocusTrack(box) {
  const remember = (event) => {
    if (!panelState || panelState.kind === 'meeting') return;
    const target = event && event.target;
    const cell = target && typeof target.closest === 'function' ? target.closest('dd[data-field]') : null;
    panelFocusField = cell ? { id: panelState.id, field: cell.dataset.field } : null;
  };
  box.addEventListener('focusin', remember);
  box.addEventListener('pointerdown', remember);
}
const PANEL_FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]';
function panelFocusRestore(box, focusFrom) {
  if (!panelState) return;
  const active = document.activeElement;
  const lost = !!focusFrom || !active || active === document.body;
  const field = panelFocusField && panelFocusField.id === panelState.id ? panelFocusField.field : null;
  // 초점이 카드에 있지 않았고 필드를 만진 적도 없으면(자동 새로고침 등) 가만히 둔다.
  if (!lost || (!focusFrom && !field)) return;
  const cell = field ? [...box.querySelectorAll('dd[data-field]')].find(one => one.dataset.field === field) : null;
  // 필드 밖(구역의 버튼·입력칸)에 있던 초점은 같은 이름의 조작으로 — 없으면 카드 제목.
  const name = el => `${el.tagName}|${el.getAttribute('aria-label') || ''}|${String(el.textContent || '').trim()}`;
  const same = !cell && focusFrom ? [...box.querySelectorAll(PANEL_FOCUSABLE)].find(el => name(el) === name(focusFrom)) : null;
  const spot = (cell && cell.querySelector(PANEL_FOCUSABLE)) || same || box.querySelector('.d-dtitle');
  spot?.focus?.({ preventScroll: true });
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
  cell.dataset.field = label; // 저장 뒤 다시 그려도 초점을 이 칸으로 돌려주는 이름표(panelFocusRestore)
  if (typeof value === 'string') cell.textContent = value;
  else if (value) cell.appendChild(value);
  dl.append(term, cell);
  return cell;
}

// 날짜 한 칸: 값 글자(`9월 29일 (화) · 기한 1일 지남`)가 곧 누르는 자리다. 비어 있으면 회색 `없음` 한 조각.
// `까지`는 기한에만 쓴다 — 다시 확인할 날짜처럼 기한이 아닌 날짜는 날짜만 적는다.
function panelDateCell(label, value, onChange, deadline = true) {
  return uiDateField({ value, label, onChange, shown: true, face: 'pick', describe: deadline ? uiDueDetail : v => ({ text: uiKoDate(v), tone: '' }) });
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
  // note: 결정의 `내용`. 줄바꿈을 그대로 둔다(한 줄인 outcome과 다르다).
  if ('note' in current && current.note !== initial.note) changes.note = current.note || '';
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
  panelField(fields, '프로젝트', taskProjectControl(item, { plain: true }));
  if (isTask) panelField(fields, '기다리는 답변', panelWaitingCell(item, detail));
  box.appendChild(fields);

  const foot = document.createElement('div');
  foot.className = 'd-dfoot';
  const finishLabel = type === 'decision' ? 'PRD 반영 완료' : '완료로 표시';
  if (done) foot.appendChild(panelQuietButton('완료 취소', async () => { await toggleTask(item.id); }));
  else foot.appendChild(panelQuietButton(finishLabel, async () => {
    const mark = uiUndoMark();
    await toggleTask(item.id);
    panelClose();
    if (isTask) workflowOutcome(item, uiUndoOwn(mark));
  }, 'd-btn pri'));
  if (!done && isTask) {
    // 좁은 폭 시트에서는 옮기면 시트도 닫는다(완료로 표시처럼). 넓은 폭의 줄 옆 카드는 그대로 — 줄이 사라지면 카드가 따라 닫힌다.
    const move = (label, scheduled, message) => foot.appendChild(panelQuietButton(label, async () => {
      const mark = uiUndoMark();
      await setTaskScheduled(item.id, scheduled);
      if (detailSheet() && panelState) panelClose();
      uiUndoNotice(message, null, uiUndoOwn(mark));
    }));
    if (mode === 'later') move('오늘로', todayStr(), '오늘 할 일로 옮겼어요');
    else {
      // 줄에 `오늘 할게요`가 뜨던 업무(밀렸고 진행 중이 아님)는 좁은 폭에서 줄 대신 시트 발에 그 버튼이 선다.
      if (detailSheet() && mode === 'today' && uiCarryText(item.scheduled) && !item.doing) move('오늘 할게요', todayStr(), '오늘 할 일로 옮겼어요');
      move('내일', tomorrowStr(), uiMoveNotice('내일로 미뤘어요', [item], tomorrowStr()));
      move('나중에', null, uiMoveNotice('나중에 할 일로 옮겼어요 · 기한은 그대로예요', [item], null));
    }
  }
  box.appendChild(foot);

  if (isTask) panelTaskNotes(item, detail, box);
  if (type === 'decision') panelDecisionNote(item, detail, box);
  if (detail?.meetingId) {
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'd-link';
    link.textContent = '이 항목이 나온 회의';
    // 같은 패널에서 그 회의를 연다. 팔레트에서 왔다면 닫을 때 돌아갈 자리는 그대로 들고 간다.
    link.addEventListener('click', () => panelOpen({ kind: 'meeting', id: detail.meetingId, back: panelState?.back }));
    box.appendChild(link);
  }
}

// 언제 할지: `오늘` / `내일 · 9월 22일 (화)` / `어제부터 · 9월 20일 (일)` / `나중에` / `완료 · 9월 20일 (일)`
// 밀린 업무를 `오늘`이라고 적으면 목록의 `어제부터`와 말이 어긋난다 — 같은 uiCarryText를 쓴다.
// 진행 중인 업무는 밀렸어도 `진행 중`이다 — 목록 줄(wrap-ui)과 같은 규칙, 이미 손댄 일에 `밀림`은 틀린 말이다.
function panelWhenText(item, mode) {
  if (item.status === 'done') return item.completed ? `완료 · ${uiKoDate(item.completed)}` : '완료';
  if (mode === 'later' && !item.scheduled) return '나중에';
  const scheduled = item.scheduled || todayStr();
  const carry = uiCarryText(scheduled);
  if (carry && item.doing) return '진행 중';
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

// `결과 한 줄`은 기본으로 펼쳐 둔다(접어 두면 아무도 적지 않았다).
function panelTaskNotes(item, detail, box) {
  const current = { outcome: detail?.outcome || '' };
  const initial = { ...current };
  const save = async () => {
    try {
      if (await panelFieldSave(item.id, initial, current)) await load();
    } catch { /* 저장 실패는 request()가 알린다 — 적은 내용은 그대로 둔다 */ }
  };
  box.appendChild(panelOutcomeSection('결과 한 줄', '끝나고 한 줄로 남기면 주간요약에 그대로 올라가요', current, save));
}

// 기다리는 답변(필드 격자의 한 줄): 값 `설명 · 누구에게`(없으면 회색 `연결 없음`) + 꺾쇠.
// 누르면 그 자리에서 프로젝트 고르기와 같은 목록(uiPickList)이 펼쳐진다 — 열린 확인 대기 + 맨 끝 `연결 끊기`.
// 저장 길은 예전 선택 상자와 같다(blockedBy → /api/workflow/item, 알림 없음).
function panelWaitingCell(item, detail) {
  const current = { blockedBy: detail?.blockedBy || '' };
  const initial = { ...current };
  const save = async () => {
    try {
      if (await panelFieldSave(item.id, initial, current)) await load();
    } catch { /* 저장 실패는 request()가 알린다 */ }
  };
  const checks = (typeof workflowData === 'object' && workflowData ? workflowData.items : [])
    .filter(check => check.type === 'check' && (check.status !== 'done' || check.id === current.blockedBy));
  const name = check => `${check.status === 'done' ? '해결됨 · ' : ''}${check.description}`;

  const wrap = document.createElement('div');
  wrap.className = 'd-wait';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'd-dpick';
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  const value = document.createElement('span');
  const caret = document.createElement('span');
  caret.className = 'cv';
  caret.innerHTML = uiIcon('chevron');
  button.append(value, caret);
  const paint = () => {
    const linked = checks.find(check => check.id === current.blockedBy);
    // 연결은 남았는데 대상이 없으면(삭제됨) `연결 없음`이 아니라 사라졌다고 적는다 — 목록에서 `연결 끊기`로 정리한다.
    const text = linked ? `${name(linked)}${linked.who ? ` · ${linked.who}` : ''}`
      : current.blockedBy ? '삭제된 확인 대기' : '연결 없음';
    value.className = linked ? 'v' : 'v k-mute';
    value.textContent = text;
    value.title = text;
    button.setAttribute('aria-label', `기다리는 답변 ${text} — 눌러서 바꾸기`);
  };
  paint();
  wrap.appendChild(button);
  if (current.blockedBy && !checks.some(check => check.id === current.blockedBy)) {
    const gone = document.createElement('div');
    gone.className = 'd-hint';
    gone.textContent = '연결했던 확인 대기가 삭제됐어요.';
    wrap.appendChild(gone);
  }

  // 펼치는 방식은 프로젝트 고르기(renderGroupControl의 openPicker)와 같다 — 값 자리를 목록으로 바꿔 끼운다.
  const openPicker = () => {
    const entries = checks.map(check => ({
      type: 'option', value: check.id, text: name(check), key: check.who || '',
      selected: check.id === current.blockedBy, find: [check.description, check.who],
    }));
    if (current.blockedBy) entries.push({ type: 'action', value: PICK_CLEAR, text: '연결 끊기' });
    const restore = (focus) => {
      wrap.classList.remove('is-picking');
      button.setAttribute('aria-expanded', 'false');
      if (wrap.contains(picker)) wrap.replaceChild(button, picker);
      if (focus) button.focus();
    };
    const picker = uiPickList({
      entries,
      label: '기다리는 답변 고르기',
      search: uiPickSearchable(entries),
      placeholder: '확인 대기 찾기',
      emptyText: '찾는 확인 대기가 없어요',
      onClose: byKeyboard => restore(byKeyboard),
      onPick: (picked) => {
        restore(true);
        current.blockedBy = picked === PICK_CLEAR ? '' : picked;
        paint();
        save();
      },
    });
    if (!checks.length) {
      // 고를 확인 대기가 하나도 없으면 빈 목록 대신 한 줄로 말한다(찾기 칸의 `없어요` 자리를 빌린다).
      const none = picker.querySelector('.d-gpnone');
      if (none) { none.textContent = '열린 확인 대기가 없어요'; none.hidden = false; }
    }
    wrap.replaceChild(picker, button);
    wrap.classList.add('is-picking');
    button.setAttribute('aria-expanded', 'true');
    picker.focusStart();
    // 고를 줄이 없어도 Esc·바깥 누름으로 닫히게 목록 자체에 초점을 둔다.
    if (!entries.length) { picker.tabIndex = -1; picker.focus(); }
  };
  button.addEventListener('click', (event) => { event.stopPropagation(); openPicker(); });
  return wrap;
}

// 결정의 `내용` — 정책 결정은 제목 한 줄로 끝나지 않는다. 여러 줄로 적고, 저장은 앱 파일
// (.workflow.json의 note)에만 한다 — tracker/decisions.md의 한 줄 형식은 그대로 둔다.
// 저장 타이밍·자동 높이는 업무의 `결과 한 줄`과 같다(change 때 저장, detailAutoGrow).
// 주간요약·슬랙에는 나가지 않는다(결정 문장은 지금처럼 제목만).
const DECISION_NOTE_MAX = 4000;
function panelDecisionNote(item, detail, box) {
  const current = { note: detail?.note || '' };
  const initial = { ...current };
  const save = async () => {
    try { if (await panelFieldSave(item.id, initial, current)) await load(); }
    catch { /* 저장 실패는 request()가 알린다 — 적은 내용은 그대로 둔다 */ }
  };
  const section = panelSection('내용');
  const area = document.createElement('textarea');
  area.className = 'd-din';
  area.rows = 2;
  area.maxLength = DECISION_NOTE_MAX;
  area.value = current.note;
  area.placeholder = '결정의 배경·조건·예외를 적어 두면 나중에 그대로 읽어요';
  area.setAttribute('aria-label', '내용');
  area.addEventListener('change', () => { current.note = area.value; save(); });
  section.appendChild(area);
  box.appendChild(section);
  return section;
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
    await setTaskDue(item.id, value, '답변 받을 날 변경');
    announce(value ? `답변 받을 날을 ${uiKoDate(value)}로 정했어요` : '답변 받을 날을 지웠어요');
  }));
  panelField(fields, '다시 확인할 날짜', panelDateCell('다시 확인할 날짜', detail?.followUp, async (value) => {
    await postJson('/api/workflow/item', { id: item.id, followUp: value });
    announce(value ? `${uiKoDate(value)}에 다시 확인할게요` : '다시 확인할 날짜를 지웠어요');
    await load();
  }, false));
  panelField(fields, '프로젝트', taskProjectControl(item, { plain: true }));
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
    // 좁은 레일에서는 한 줄 제안만 남으므로, 전체 선택지는 여기 넓게 그린다(`자세히`가 여는 자리).
    // `답변 한 줄`은 바로 위 칸이 맡아 이 줄에서는 빠진다 — 같은 것을 두 번 묻지 않는다.
    const next = panelSection('다음은?');
    next.appendChild(waitingNextRow(item, { panel: true }));
    box.appendChild(next);
  }

  const log = panelSection('확인 요청 기록');
  const line = document.createElement('div');
  line.className = detail?.contacted ? 'd-logline' : 'd-hint';
  line.textContent = detail?.contacted ? `${uiKoDate(detail.contacted)} 요청함` : '아직 요청한 기록이 없어요.';
  log.appendChild(line);
  log.appendChild(panelQuietButton('오늘 확인 요청함', () => markContactedToday(item), 'd-btn sm'));
  box.appendChild(log);

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

// 결과 한 줄(확인 대기는 `답변 한 줄`, 결정은 `내용`)은 한 줄로 시작해 쓰는 만큼만 자라고,
// 다섯 줄을 넘으면 칸 안에서 스크롤한다.
function detailAutoGrow(box, maxLines, onGrow) {
  const area = box.querySelector('.d-dsec[data-sec="결과 한 줄"] .d-din, .d-dsec[data-sec="답변 한 줄"] .d-din, .d-dsec[data-sec="내용"] .d-din');
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

// ---------- ⌘K 검색 팔레트 (검색 · 오늘 들어온 것) ----------
// 큰 창 대신 위에서 내려오는 한 겹. 여기는 **찾는 창**이다 — 훑어보며 몰아서 정리하는 일은 `회의` 탭이 맡는다
// (DECISIONS 2026-09-22). 찾는 범위는 예전 통합 검색과 같다: 완료한 업무와 결과 한 줄,
// 결정·확인 대기·아이디어, 회의와 회의 초안 문구까지(외부 미팅 노트 전문은 찾지 않는다 — README와 같다).

const PAL_TYPES = [['', '전체'], ['task', '할 일'], ['check', '확인 대기'], ['decision', '결정'], ['idea', '아이디어'], ['meeting', '회의']];
const PAL_TAG = { task: '할 일', bug: '할 일', check: '확인 대기', decision: '결정', idea: '아이디어' };
// 검색 결과에서 바로 처리하는 종류(BPAL): 완료 체크는 할 일·버그·확인 대기, `오늘로`는 할 일·버그만
// (확인 대기는 `scheduled`가 아니라 답변 받을 날 개념이라 오늘로 옮기는 동작이 없다).
const PAL_CHECKABLE = ['task', 'bug', 'check'];
const PAL_TODAYABLE = ['task', 'bug'];

let palState = null;
let palNodes = null;
let palEntries = [];

// 회의 전용 토글(`미완료만`·`초안 있음`)은 회의 탭으로 옮겼다 — 팔레트는 낱말로 찾기만 한다.
function palDefaults(state) {
  return { query: '', type: '', hideDone: false, newOnly: false, active: 0, scroll: 0, ...(state || {}) };
}

// 항목 거르기(순수 함수): 종류 · 완료 제외 · 오늘 들어온 것 · 검색어. 회의는 palMeetings가 따로 본다.
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

// 회의 거르기(순수 함수): 초안 있음 · 미완료만 · 오늘 들어온 것 · 검색어(초안 문구와 이 회의에서 나온 항목까지).
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
  // 완료한 줄은 제목 글자만 조용해진다(취소선 없음 — ui.css `.d-pres.is-done .ti`).
  const done = entry.kind !== 'meeting' && entry.item.status === 'done';
  row.className = 'd-pres' + (entry.kind === 'meeting' ? ' is-mtg' : '') + (done ? ' is-done' : '') + (index === palState.active ? ' is-sel' : '');
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
    // 맨 앞 28px 칸: 완료 체크가 있는 종류(할 일·버그·확인 대기)만 채우고, 나머지(결정·아이디어)는
    // 같은 크기의 빈 `.d-check`로 자리만 지켜 tag·title이 밀리지 않게 한다(BPAL).
    if (PAL_CHECKABLE.includes(item.type)) {
      const box = uiCheckCell(item, row, item.status === 'done');
      // 클릭이 줄 열기(row.click → palPick)로 번지지 않게 여기서 끝낸다.
      box.addEventListener('click', event => event.stopPropagation());
      row.appendChild(box);
    } else {
      const spacer = document.createElement('span');
      spacer.className = 'd-check';
      row.appendChild(spacer);
    }
    const due = item.status === 'done' ? null : uiItemDueText(item);
    const status = item.status === 'done' ? { text: '완료', tone: '' } : due || (item.doing ? { text: '진행 중', tone: '' } : null);
    cell('tag', escapeHtml(PAL_TAG[item.type] || item.type || ''));
    titleCell(palHighlight(item.description, query), item.description, item);
    // 상태 칸은 배지(.stx)와 `오늘로` 버튼을 함께 담는다 — 사용자 글자는 textContent로만 넣는다.
    const stCell = document.createElement('span');
    stCell.className = 'st';
    row.appendChild(stCell);
    if (status) {
      const badge = document.createElement('span');
      badge.className = `stx${uiTone(status.tone)}`;
      badge.textContent = status.text;
      stCell.appendChild(badge);
    }
    // `오늘로` — 완료가 아니고 오늘이 아닌 할 일·버그에만(BPAL 대상 정정).
    if (item.status !== 'done' && PAL_TODAYABLE.includes(item.type) && item.scheduled !== todayStr()) {
      const todayBtn = document.createElement('button');
      todayBtn.type = 'button';
      todayBtn.className = 'd-headnum';
      todayBtn.textContent = '오늘로';
      todayBtn.setAttribute('aria-label', `${item.description} — 오늘 할 일로 옮기기`);
      todayBtn.addEventListener('click', async (event) => {
        event.stopPropagation();
        await fadeOutAndRun(row, () => setTaskScheduled(item.id, todayStr()), '오늘 할 일로 옮겼어요');
      });
      stCell.appendChild(todayBtn);
    }
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
  // 오늘 들어온 것만 모아 보기 — 머리에 늘 떠 있던 `오늘 들어온 것 N` 글자 버튼 대신 팔레트 안 토글이다.
  chip('오늘 들어온 것', palState.newOnly, () => { palState.newOnly = !palState.newOnly; palState.active = 0; });
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
  if (!reopening && typeof usageTick === 'function') usageTick('search');   // 사용 횟수(WP-R)
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

// ---------- 쉬운 말 소식 (WP-J) ----------
// `소식.md`의 줄은 굵게(`**…**`)만 허용하고 그 밖의 마크다운·HTML은 글자 그대로다. 여기서 그 줄 하나를
// innerHTML 없이 조각(굵은 글자만 <b> 요소)으로 바꾼다 — 설정 › 앱(새 버전 상자·지난 소식 전체)과
// 오늘 탭 소식 카드가 같은 두 함수를 쓴다.
function newsBoldParts(line) {
  const text = String(line == null ? '' : line);
  const parts = [];
  let rest = text;
  const re = /\*\*(.+?)\*\*/;
  for (;;) {
    const match = re.exec(rest);
    if (!match) { if (rest) parts.push({ bold: false, text: rest }); break; }
    if (match.index > 0) parts.push({ bold: false, text: rest.slice(0, match.index) });
    if (match[1]) parts.push({ bold: true, text: match[1] });
    rest = rest.slice(match.index + match[0].length);
  }
  return parts;
}
function newsLineNode(line, tag = 'li') {
  const node = document.createElement(tag);
  newsBoldParts(line).forEach((part) => {
    if (part.bold) {
      const strong = document.createElement('b');
      strong.textContent = part.text;
      node.appendChild(strong);
    } else {
      node.appendChild(document.createTextNode(part.text));
    }
  });
  return node;
}
function newsListNode(lines, className = 'd-newslist') {
  const list = document.createElement('ul');
  list.className = className;
  (lines || []).forEach((line) => list.appendChild(newsLineNode(line)));
  return list;
}

// ---------- 쉬운 말 소식 카드 (WP-J, 오늘 탭) ----------
// 받은 뒤 앱을 처음 열 때 한 번만 — 버전이 바뀌었고 그 버전의 소식이 있을 때만 선다. 처음 쓰는 사람은
// (localStorage `newsSeen` 값이 아예 없음) 보지 않고 지금 버전으로 적어 둔다. 닫으면 그 버전을 기억하고
// (막혀 있으면 이 창이 열려 있는 동안만) 다시 뜨지 않는다. 사용설명서 카드와 같은 자리 규칙 — 둘 다 있으면
// 이 카드가 위(index.html의 `newsCardZone`이 `startCardZone`보다 앞선다).
const NEWS_SEEN_KEY = 'newsSeen';
let newsSeenHere = null;
function newsSeenVersion() {
  if (newsSeenHere !== null) return newsSeenHere;
  try { return localStorage.getItem(NEWS_SEEN_KEY); } catch { return null; }
}
function newsMarkSeen(version) {
  newsSeenHere = version;
  try { localStorage.setItem(NEWS_SEEN_KEY, version); } catch { /* 막혀 있으면 이 창이 열려 있는 동안만 기억한다 */ }
}
function renderNewsCard() {
  const zone = document.getElementById('newsCardZone');
  if (!zone) return;
  const info = typeof settingsAbout === 'object' ? settingsAbout : null;
  const version = info && info.version;
  const entry = version && Array.isArray(info.news) ? info.news.find(item => item.version === version) : null;
  const seen = newsSeenVersion();
  if (seen === null && version) newsMarkSeen(version); // 처음 쓰는 사람 — 지금 버전으로 적어 두기만 한다
  if (!version || !entry || seen === null || seen === version) {
    zone.hidden = true;
    zone.replaceChildren();
    return;
  }
  zone.hidden = false;
  if (zone.children.length) return; // 이미 떠 있으면 다시 만들지 않는다(닫기를 누르려던 초점이 사라지지 않게)
  const card = document.createElement('div');
  card.className = 'd-start d-newscard';
  card.setAttribute('role', 'region');
  // `v1.3.0으로`·`v1.2.1로` — 끝 숫자를 읽는 소리로 고른다. ㄹ 받침(1·7·8)과 받침 없음(2·4·5·9)은 `로`, 0·3·6은 `으로`.
  const moved = `v${version}${/[036]$/.test(String(version)) ? '으로' : '로'} 바뀌었어요`;
  card.setAttribute('aria-label', moved);
  const head = document.createElement('div');
  head.className = 'hd';
  const title = document.createElement('span');
  title.textContent = moved;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'd-btn sm sp';
  close.textContent = '닫기';
  close.setAttribute('aria-label', '새 소식 닫기');
  close.addEventListener('click', () => { newsMarkSeen(version); renderNewsCard(); document.getElementById('todayTaskZone')?.focus?.(); });
  head.append(title, close);
  card.append(head, newsListNode(entry.lines));
  zone.appendChild(card);
}

// ---------- 새 버전 한 줄 (WP-U, 오늘 탭 맨 위) ----------
// 새 버전은 보통 서버가 쉬는 틈에 알아서 받는다. 자동이 안 되는 때(스위치 꺼짐·지난 자동 업데이트 실패·폴더 옮기기 필요·
// 고친 파일·update 에이전트 없음·요청이 10분 넘게 처리되지 않음·처음 본 뒤 하루 넘게 안 깔림 — 서버가 `update.auto.notice`로
// 알린다)에만 소식 카드 자리 규칙대로 맨 위에 한 줄을 세운다.
// 닫으면 그 버전 동안 이 브라우저에 기억한다(localStorage `updateNoticeClosed` — 막혀 있으면 이 창이 열려 있는 동안만).
const UPDATE_NOTICE_KEY = 'updateNoticeClosed';
let updateNoticeClosedHere = null;
function updateNoticeClosed() {
  if (updateNoticeClosedHere !== null) return updateNoticeClosedHere;
  try { return localStorage.getItem(UPDATE_NOTICE_KEY); } catch { return null; }
}
function updateNoticeClose(key) {
  updateNoticeClosedHere = key;
  try { localStorage.setItem(UPDATE_NOTICE_KEY, key); } catch { /* 막혀 있으면 이 창이 열려 있는 동안만 기억한다 */ }
}
// `v1.2.2가`·`v1.2.1이` — 끝 숫자를 읽는 소리로 조사를 고른다(2·4·5·9는 받침이 없다).
const updateNoticeLabel = label => `${label}${/[2459]$/.test(label) ? '가' : '이'}`;
function renderUpdateNotice() {
  const zone = document.getElementById('updateNoticeZone');
  if (!zone) return;
  const info = typeof settingsAbout === 'object' ? settingsAbout : null;
  const update = info && info.update;
  const reason = update && update.available && update.auto ? update.auto.notice : null;
  const label = update && typeof update.label === 'string' && update.label !== 'main' ? update.label : '';
  const kind = ['failed', 'stuck', 'stale'].includes(reason) ? reason : 'offer';
  const key = `${label}:${kind}`;
  if (!reason || !label || updateNoticeClosed() === key) {
    zone.hidden = true;
    zone.replaceChildren();
    return;
  }
  zone.hidden = false;
  if (zone.dataset.key === key && zone.children.length) return; // 이미 떠 있으면 다시 만들지 않는다(누르려던 초점이 사라지지 않게)
  zone.dataset.key = key;
  // 실패·요청이 처리되지 않음은 빨간 판 + 설정 › 앱 열기, 그 밖(꺼짐·옮기기·고친 파일·에이전트 없음·하루 넘게)은 새 버전 판 + 업데이트 받기.
  const failed = kind === 'failed' || kind === 'stuck';
  const line = document.createElement('div');
  line.className = `${failed ? 'd-abfail' : 'd-abupd'} d-updnote`;
  line.setAttribute('role', 'region');
  line.setAttribute('aria-label', '새 버전 알림');
  const text = document.createElement('span');
  text.className = 'tx';
  text.textContent = {
    failed: '자동 업데이트가 멈췄어요 — 설정 › 앱에서 확인해 주세요',
    stuck: '업데이트 요청이 처리되지 않았어요 — 설정 › 앱에서 확인해 주세요',
    stale: `새 버전 ${updateNoticeLabel(label)} 하루 넘게 설치되지 않았어요`,
  }[kind] || `새 버전 ${updateNoticeLabel(label)} 있어요`;
  const go = document.createElement('button');
  go.type = 'button';
  go.className = failed ? 'd-btn sm' : 'd-btn sm pri';
  go.textContent = failed ? '설정 › 앱 열기' : '업데이트 받기';
  go.addEventListener('click', () => { if (typeof settingsOpen === 'function') settingsOpen('app'); });
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'd-btn sm';
  close.textContent = '닫기';
  close.setAttribute('aria-label', '새 버전 알림 닫기');
  close.addEventListener('click', () => { updateNoticeClose(key); renderUpdateNotice(); document.getElementById('todayTaskZone')?.focus?.(); });
  line.append(text, go, close);
  zone.replaceChildren(line);
}

// ---------- 받는 동안 (WP-U) ----------
// 업데이트 끝에 서버가 1분쯤 다시 켜진다. 그 사이 목록을 못 받으면 `목록을 불러오지 못했어요` 대신 바꾸는 중이라고 말하고,
// 15초마다 다시 받는다(최대 3분). 서버가 돌아오면 load()의 appVersion 비교가 입력 중이 아닐 때 새로고침한다 → 소식 카드.
// 업데이트 중인지는 `/api/update/status`로 묻고, 서버가 아예 없으면 마지막 목록이 알려 준 `updating`(10분 안)을 믿는다.
const UPDATE_BUSY_TEXT = '새 버전으로 바꾸는 중이에요 — 1분쯤 걸려요';
let updatingSeenAt = 0;
let updateBusySince = 0;
let updateBusyTimer = null;
async function updateBusyCheck() {
  let running = null;
  try {
    const response = await fetch('/api/update/status', { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(3000) });
    if (response.ok) running = !!(await response.json()).running;
  } catch { running = null; }
  const busy = running === true || (running === null && updatingSeenAt && Date.now() - updatingSeenAt < 10 * 60 * 1000);
  if (!busy) { updateBusySince = 0; return; }
  updateBusySince = updateBusySince || Date.now();
  showNotice(UPDATE_BUSY_TEXT);
  if (updateBusyTimer || Date.now() - updateBusySince > 3 * 60 * 1000) return;
  updateBusyTimer = setTimeout(() => { updateBusyTimer = null; load(); }, 15 * 1000);
}

// ---------- 입력 중 신호 (WP-U) ----------
// 쉬는 틈 판단은 서버가 쓰기 요청(POST)으로만 센다. 긴 글을 쓰는 중이거나 창(체크인·설정 등 dialog)이 열려 있으면 저장 전이라
// 서버가 모르므로, 1분에 한 번 본문 없는 `POST /api/activity`를 보내 쉬는 시간을 다시 세게 한다. 실패는 조용히 넘긴다.
function activityBusy() {
  if (isTyping()) return true;
  return !!(typeof document.querySelector === 'function' && document.querySelector('dialog[open]'));
}
function activityPing() {
  if (!activityBusy()) return false;
  try {
    fetch('/api/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' } }).catch(() => {});
  } catch { /* 조용히 */ }
  return true;
}

// ---------- 사용설명서 카드 (오늘 탭) ----------
// 닫기 전까지는 **늘** `새로 들어온 것` 자리에 선다(기록이 있든 없든). 닫으면 config가 아니라 이 브라우저에
// 기억하고(localStorage `guideCardClosed` — 막혀 있으면 이 창이 열려 있는 동안만), 같은 네 줄은
// 설정 › 도움말 맨 위의 `사용설명서`로 남는다(settings-ui.js의 renderSettingsManual).
const GUIDE_CARD_KEY = 'guideCardClosed';
let guideCardClosedHere = false;

function guideCardClosed() {
  if (guideCardClosedHere) return true;
  try { return localStorage.getItem(GUIDE_CARD_KEY) === '1'; } catch { return false; }
}

function guideCardClose() {
  guideCardClosedHere = true;
  try { localStorage.setItem(GUIDE_CARD_KEY, '1'); } catch { /* 막혀 있으면 이 창이 열려 있는 동안만 기억한다 */ }
  renderGuideCard();
  document.getElementById('todayTaskZone')?.focus?.();
}

// 줄마다 데려가는 곳. 설정 창 안(도움말의 사용설명서)에서 누른 줄도 같은 곳으로 간다.
function guideGoTodayInput() {
  if (typeof settingsClose === 'function') settingsClose();
  if (typeof setActiveTab === 'function' && activeTabKey !== 'today') setActiveTab('today');
  document.getElementById('todayTaskInput')?.focus();
}
function guideGoIntegrations() { if (typeof settingsOpen === 'function') settingsOpen('integrations'); }
function guideGoSlackHow() {
  if (typeof settingsOpen === 'function') settingsOpen('guide');
  if (typeof settingsGuideShow === 'function') settingsGuideShow('슬랙에서 이렇게 보내요');
}

// 굵은 글자가 섞인 **코드에 적힌 고정 문장**을 innerHTML 없이 세운다(조각: 문자열 또는 ['b', 글]).
function guideRich(node, parts) {
  parts.forEach((part) => {
    if (typeof part === 'string') { node.appendChild(document.createTextNode(part)); return; }
    const piece = document.createElement(part[0]);
    piece.textContent = part[1];
    node.appendChild(piece);
  });
  return node;
}

// ---------- 앱으로 설치 (크롬 PWA — WP-L) ----------
// 기본 창은 크롬의 `앱으로 설치`다(DECISIONS 2026-09-28) — 창의 주인이 워크스페이스가 되어 Dock·⌘Tab에 아이콘이
// 따로 뜨고 창이 하나로 모인다.
// - 설치된 창(standalone)에서는 권하지 않는다.
// - 크롬이 `beforeinstallprompt`를 주면 잡아 두고 `설치하기` 버튼을 보인다(누르면 크롬의 설치 창).
// - 이벤트가 없으면(이미 설치했거나 크롬이 아님) 크롬 메뉴 길을 글로 알린다.
// - `appinstalled`가 오면 권유를 치우고 한 번 알린다.
// 권유 줄은 두 군데(사용설명서의 첫 줄 · 설정 › 꾸미기)라, 만든 줄을 기억해 두고 상태가 바뀌면 그 자리에서 다시 채운다.
const APP_INSTALL_DONE_WORDS = '설치했어요 · 새 창의 아이콘을 Dock에 유지해 주세요';
let appInstallEvent = null;       // 잡아 둔 beforeinstallprompt(한 번 쓰면 비운다)
let appInstallDone = false;       // 이 창에서 설치를 마쳤다(accepted 또는 appinstalled)
let appInstallNoticed = false;    // appinstalled 알림은 한 번만
let appInstallSlots = [];         // [{ node, paint }] — 다시 채울 줄
let appIconSrc = '/app-icon.png'; // 작은 Dock 그림 주소 — 꾸미기에서 아이콘을 저장하면 `?v=`가 붙는다(settings-ui.js)

function appInstallStandalone() {
  try {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      && window.matchMedia('(display-mode: standalone)').matches) return true;
  } catch { /* 모르면 일반 탭으로 본다 */ }
  return typeof navigator !== 'undefined' && navigator.standalone === true;
}

// 'standalone'(설치된 창) · 'done'(방금 설치) · 'prompt'(버튼) · 'manual'(글 안내)
function appInstallState() {
  if (appInstallStandalone()) return 'standalone';
  if (appInstallDone) return 'done';
  return appInstallEvent ? 'prompt' : 'manual';
}

function appInstallOnPrompt(event) {
  if (appInstallStandalone()) return;
  if (event && typeof event.preventDefault === 'function') event.preventDefault();
  appInstallEvent = event || null;
  appInstallRefresh();
}

function appInstallOnInstalled() {
  appInstallEvent = null;
  appInstallDone = true;
  appInstallRefresh();
  if (appInstallNoticed) return;
  appInstallNoticed = true;
  if (typeof showNotice === 'function') showNotice(`앱으로 ${APP_INSTALL_DONE_WORDS}`);
}

async function appInstallRun() {
  const event = appInstallEvent;
  if (!event || typeof event.prompt !== 'function') { appInstallEvent = null; appInstallRefresh(); return; }
  appInstallEvent = null; // 크롬의 설치 창은 이벤트 하나에 한 번만 뜬다
  try {
    await event.prompt();
    const choice = event.userChoice ? await event.userChoice : null;
    if (choice && choice.outcome === 'accepted') appInstallDone = true;
  } catch { /* 창이 뜨지 않았으면 글 안내로 돌아간다 */ }
  appInstallRefresh();
}

function appInstallRefresh() {
  appInstallSlots = appInstallSlots.filter(slot => slot.node && slot.node.isConnected !== false);
  appInstallSlots.forEach(slot => slot.paint());
}

function appInstallRemember(node, paint) {
  appInstallSlots = appInstallSlots.filter(slot => slot.node && slot.node.isConnected !== false);
  appInstallSlots.push({ node, paint });
  paint();
  return node;
}

// 권유의 몸통(설치된 창에서는 빈 배열) — 사용설명서와 꾸미기가 같은 말을 쓴다.
function appInstallWords(state) {
  if (state === 'done') return [document.createTextNode(APP_INSTALL_DONE_WORDS)];
  if (state === 'prompt') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'd-btn sm acc d-installbtn';
    button.textContent = '설치하기';
    button.addEventListener('click', appInstallRun);
    return [button, document.createTextNode(' Dock·⌘Tab에 워크스페이스 아이콘이 따로 떠요')];
  }
  if (state === 'manual') {
    const how = guideRich(document.createElement('span'),
      ['크롬 ', ['b', '⋮'], ' → ', ['b', '전송, 저장, 공유'], ' → ', ['b', '페이지를 앱으로 설치']]);
    const installed = guideRich(document.createElement('span'),
      ['이미 설치했으면 주소창 오른쪽 ', ['b', '앱 열기']]);
    installed.className = 'd-installsub';
    return [how, installed];
  }
  return [];
}

// 네 줄 — 오늘 탭 카드와 도움말의 사용설명서가 같은 줄을 쓴다. 누르면 데려가는 줄은 버튼이고,
// 첫 줄은 할 일이 이 앱 밖(크롬·Dock)에 있어 줄 자체는 버튼이 아니다(작은 Dock 그림 + 안의 버튼·링크).
// 일반 탭이면 `앱으로 설치`(버튼 또는 크롬 메뉴 길), 설치된 창이면 `Dock에 두기`(아이콘을 Dock에 유지).
// compact(오늘 탭 카드): 한 칸 한 줄 — 설치 줄은 Dock 그림 대신 앱 아이콘 하나를 이름 앞에 두고 설명을 줄이며
// (`이미 설치했으면…`·`전송, 저장, 공유`·Dock 그림은 도움말에만), 버튼 줄은 끝에 오른쪽 꺾쇠를 단다.
function guideRows({ compact = false } = {}) {
  const row = (tag, title, parts, run) => {
    const node = document.createElement(tag);
    node.className = 'd-guide';
    if (tag === 'button') { node.type = 'button'; node.addEventListener('click', run); }
    const name = document.createElement('span');
    name.className = 't';
    name.textContent = title;
    const words = guideRich(document.createElement('span'), parts);
    words.className = 'd';
    node.append(name, words);
    if (compact && tag === 'button') {
      const go = document.createElement('span');
      go.className = 'go';
      go.insertAdjacentHTML('beforeend', uiIcon('chevron'));
      node.appendChild(go);
    }
    return { node, name, words };
  };
  const appIcon = () => {
    const me = document.createElement('img');
    me.className = 'me';
    me.src = appIconSrc;
    me.alt = '';
    return me;
  };
  const dock = row('div', '앱으로 설치', []);
  if (compact) {
    dock.node.className = 'd-guide is-install';
    dock.node.replaceChildren(appIcon(), dock.name, dock.words);
  }
  const paintCompact = (state) => {
    if (state === 'standalone') {
      dock.name.textContent = 'Dock에 두기';
      dock.words.replaceChildren(
        guideRich(document.createElement('span'), ['Dock의 이 앱 아이콘 우클릭 → ', ['b', '옵션'], ' → ', ['b', 'Dock에 유지']]));
      return;
    }
    dock.name.textContent = '앱으로 설치';
    if (state === 'manual') {
      dock.words.replaceChildren(guideRich(document.createElement('span'), ['크롬 ⋮ → ', ['b', '페이지를 앱으로 설치']]));
      return;
    }
    // 설치 창을 줄 수 있으면 `설치하기` 버튼 하나, 방금 설치했으면 그 한 줄 — 꾸미기와 같은 부품이다.
    dock.words.replaceChildren(...appInstallWords(state).slice(0, 1));
  };
  const paint = () => {
    const state = appInstallState();
    if (compact) { paintCompact(state); return; }
    const picture = document.createElement('span');
    picture.className = 'd-guidedock';
    picture.setAttribute('aria-hidden', 'true');
    picture.append(document.createElement('i'), document.createElement('i'), appIcon(), document.createElement('i'));
    if (state === 'standalone') {
      dock.name.textContent = 'Dock에 두기';
      dock.words.replaceChildren(
        guideRich(document.createElement('span'), ['Dock의 이 앱 아이콘 우클릭 → ', ['b', '옵션'], ' → ', ['b', 'Dock에 유지']]),
        picture);
      return;
    }
    dock.name.textContent = '앱으로 설치';
    dock.words.replaceChildren(...appInstallWords(state), picture);
  };
  appInstallRemember(dock.node, paint);
  return [
    dock.node,
    row('button', '할 일 적기', ['맨 위 칸에 적고 ', ['b', 'Enter']], guideGoTodayInput).node,
    row('button', '연동은 나중에', ['설정 ⚙ → ', ['b', '연동'], '에서 하나씩'], guideGoIntegrations).node,
    row('button', '슬랙에서 보내는 법', [['b', '전달'], '로 채널에 보내요'], guideGoSlackHow).node,
  ];
}

function renderGuideCard() {
  const zone = document.getElementById('startCardZone');
  if (!zone) return;
  zone.hidden = guideCardClosed();
  if (zone.hidden) { zone.replaceChildren(); return; }
  // 새로고침마다 다시 만들지 않는다 — 누르려던 줄의 초점이 사라지지 않게.
  if (zone.children.length) return;
  const card = document.createElement('div');
  card.className = 'd-start d-guidecard';
  card.setAttribute('role', 'region');
  card.setAttribute('aria-label', '사용설명서');
  const head = document.createElement('div');
  head.className = 'hd';
  const title = document.createElement('span');
  title.textContent = '사용설명서';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'd-btn sm sp';
  close.textContent = '닫기';
  close.setAttribute('aria-label', '사용설명서 닫기 — 도움말에 남아요');
  close.addEventListener('click', guideCardClose);
  head.append(title, close);
  // 오늘 탭은 네 칸 판(넓게 2×2, ≤520은 한 줄씩) — 도움말(renderSettingsManual)은 지금 모양 그대로 한 줄씩.
  const grid = document.createElement('div');
  grid.className = 'd-guidegrid';
  grid.append(...guideRows({ compact: true }));
  card.append(head, grid, ...(typeof usageGuideLine === 'function' ? usageGuideLine() : []));
  zone.appendChild(card);
}

// ---------- 일정 정하기 판 (새로 들어온 것 줄) ----------
// `일정 정하기 ⌄` 하나가 오늘·내일·이번 주·다음 주·날짜·나중에와 프로젝트를 한 판에 모은다. 저장은 새 길 없이
// 지금 있는 실행 날짜(setTaskScheduled)·프로젝트(setTaskJira·setTaskGroup)를 그대로 쓴다.
// 판은 더보기 메뉴(.d-menulist)와 같은 모양의 떠 있는 층이고, 열려 있는 동안은 그 구역 다시 그리기를 미룬다(uiRenderHeld).
let uiSchedOpen = null; // { pop, anchor, zone, id, onEsc, reposition }
const uiSchedRise = new Map(); // 오늘로 정한 업무 id → 새 줄 솟음(renderTodayTasks가 한 번 쓰고 지운다)

function uiDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
// 오른쪽에 적는 실제 날짜: `10/6 (화)`
function uiSchedDateText(dateStr) {
  return `${uiDateSlash(dateStr)} (${UI_WEEKDAYS[new Date(`${dateStr}T00:00:00`).getDay()]})`;
}
// 날짜 항목들. `이번 주`는 이번 주 금요일 — 목·금·토·일에는 오늘·내일과 겹치거나 지난 날이라 숨긴다.
// `다음 주`는 다음 주 월요일 — 일요일에는 내일과 같은 날이라 숨긴다.
function uiSchedChoices(now = new Date()) {
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekday = base.getDay();
  const at = (days) => { const next = new Date(base); next.setDate(next.getDate() + days); return uiDateKey(next); };
  const list = [
    { key: 'today', label: '오늘', date: at(0), message: '오늘 할 일로 옮겼어요' },
    { key: 'tomorrow', label: '내일', date: at(1), message: '내일로 미뤘어요' },
  ];
  if (weekday >= 1 && weekday <= 3) list.push({ key: 'week', label: '이번 주', date: at(5 - weekday) });
  if (weekday !== 0) list.push({ key: 'next', label: '다음 주', date: at(8 - weekday) });
  return list;
}

// 직접 친 날짜가 덜 쳐졌거나(해를 `2`까지만 쳐도 브라우저는 0002-10-06을 보낸다) 지난 날이면 저장하지 않는다.
function uiSchedDateOk(value, validity) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  if (validity && validity.valid === false) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return false;
  return value >= todayStr();
}
const uiSchedBusy = new Set(); // 저장 중인 업무 id — 같은 업무를 두 번 옮기지 않는다

// 줄이 접혀 다음 줄이 마우스 밑으로 올라온 직후에는 포인터가 실제로 움직일 때까지 버튼의 진한 hover 채움을 막는다.
// (브라우저가 레이아웃이 바뀐 뒤 보내는 가짜 mousemove는 움직임 값이 0이라 걸러진다.)
function uiHoverSettle() {
  const root = document.body;
  if (!root || !root.classList || root.classList.contains('is-hover-settling')) return;
  root.classList.add('is-hover-settling');
  const release = (event) => {
    if (event && !event.movementX && !event.movementY) return;
    root.classList.remove('is-hover-settling');
    document.removeEventListener('mousemove', release, true);
  };
  document.addEventListener('mousemove', release, true);
}

function uiSchedMotion() {
  try { return !window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return true; }
}

function uiSchedPlace(pop, anchor) {
  const box = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : null;
  if (!box) return;
  const width = pop.offsetWidth || 304;
  const height = pop.offsetHeight || 0;
  const viewW = window.innerWidth || 1024;
  const viewH = window.innerHeight || 768;
  const left = Math.max(12, Math.min(box.left, viewW - 12 - width));
  const below = box.bottom + 6;
  // 아래 자리가 모자라면 위로 뒤집는다(기존 ⋯ 메뉴와 같이). 시작점은 누른 버튼 쪽이다.
  const flip = below + height > viewH - 8 && box.top - 6 - height >= 8;
  const top = flip ? box.top - 6 - height : Math.max(8, Math.min(below, viewH - 8 - height));
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;
  pop.style.setProperty('--ox', `${Math.round(box.left + box.width / 2 - left)}px`);
  pop.style.setProperty('--oy', flip ? '100%' : '0');
}

function uiSchedClose({ restoreFocus = false, keepHeld = false } = {}) {
  if (!uiSchedOpen) return;
  const { pop, anchor, id, onEsc, reposition } = uiSchedOpen;
  uiSchedOpen = null;
  escDrop(onEsc);
  window.removeEventListener('resize', reposition);
  document.removeEventListener('scroll', reposition, true);
  anchor.setAttribute('aria-expanded', 'false');
  if (uiSchedMotion()) {
    pop.classList.add('is-out');
    setTimeout(() => pop.remove(), 140);
  } else pop.remove();
  // 고르는 중에 미룬 다시 그리기는 닫으면서 풀어 준다. 고른 경우(keepHeld)에는 저장이 끝나 그리는 쪽이 한 번에 처리한다.
  if (keepHeld) return;
  uiHeldFlush();
  if (restoreFocus) document.querySelector?.(`[data-sched-id="${id}"]`)?.focus?.();
}

function uiSchedButton(item, row) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'd-btn sm d-schedbtn';
  button.dataset.schedId = item.id;
  button.setAttribute('aria-haspopup', 'true');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-label', `${item.description} — 일정 정하기`);
  button.append('일정 정하기');
  const caret = document.createElement('span');
  caret.className = 'cv';
  caret.innerHTML = uiIcon('chevron');
  button.appendChild(caret);
  button.addEventListener('click', (event) => { event.stopPropagation?.(); uiSchedToggle(item, row, button); });
  return button;
}

function uiSchedToggle(item, row, anchor) {
  if (uiSchedOpen && uiSchedOpen.anchor === anchor) { uiSchedClose({ restoreFocus: true }); return; }
  uiSchedClose();
  uiMenuClose();

  const zone = document.getElementById('inboxZone');
  const pop = document.createElement('div');
  pop.className = 'd-schedpop';
  pop.setAttribute('role', 'menu');
  pop.setAttribute('aria-label', '일정 정하기');
  pop.addEventListener('click', event => event.stopPropagation());

  const label = document.createElement('div');
  label.className = 'lab';
  label.setAttribute('role', 'presentation');
  label.textContent = '실행 날짜';
  pop.appendChild(label);

  const mark = (button) => {
    button.addEventListener('focus', () => { pop.querySelectorAll('.d-mitem.on').forEach(on => on.classList.remove('on')); button.classList.add('on'); });
  };
  let order = 0;
  const entry = (keyLabel, text, detail, onPick) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'd-mitem';
    button.setAttribute('role', 'menuitem');
    button.dataset.key = String(keyLabel);
    button.style.setProperty('--i', String(order++));
    const name = document.createElement('span');
    name.textContent = text;
    button.appendChild(name);
    if (detail) {
      const dt = document.createElement('span');
      dt.className = 'dt';
      dt.textContent = detail;
      button.appendChild(dt);
    }
    const kbd = document.createElement('kbd');
    kbd.textContent = String(keyLabel);
    button.appendChild(kbd);
    button.addEventListener('click', onPick);
    mark(button);
    pop.appendChild(button);
    return button;
  };

  // 고른 날짜(또는 나중에)를 저장한다 — 판은 닫고 줄은 접힌다. 오늘·나중에는 예전 두 버튼과 같은 동작·같은 알림이다.
  const choose = async (scheduled, message) => {
    if (uiSchedBusy.has(item.id)) return; // 닫히는 140ms·저장 중의 두 번째 선택은 무시한다
    uiSchedBusy.add(item.id);
    uiHoverSettle();
    uiSchedClose({ keepHeld: true });
    row.classList.add('is-leaving');
    if (scheduled === todayStr()) uiSchedRise.set(item.id, Date.now());
    let saved = false;
    const save = async () => { await setTaskScheduled(item.id, scheduled); saved = true; uiInboxSchedUndo(item, scheduled); };
    try {
      await uiMoveRun(row, save, uiMoveNotice(message, [item], scheduled));
    } finally {
      uiSchedBusy.delete(item.id);
    }
    // 저장이 안 됐을 때만(알림은 request가 이미 했다) 줄을 되돌리고 미룬 다시 그리기를 푼다.
    // 저장된 줄은 접힌 채로 둔다 — 다른 줄의 판이 열려 다시 그리기가 미뤄져도 옮긴 업무가 다시 보이지 않는다.
    if (!saved) { row.classList.remove('is-leaving'); uiSchedRise.delete(item.id); uiHeldFlush(); }
  };

  const choices = uiSchedChoices();
  const picks = [];
  choices.forEach((choice, index) => {
    picks.push({ key: String(index + 1), run: () => choose(choice.date, choice.message || `${uiKoDate(choice.date)}로 옮겼어요`) });
    entry(index + 1, choice.label, uiSchedDateText(choice.date), picks[picks.length - 1].run).dataset.sched = choice.key;
  });

  let dateRow = null;
  const pickDate = () => {
    if (dateRow) { dateRow.remove(); dateRow = null; place(); return; }
    dateRow = document.createElement('div');
    dateRow.className = 'd-schedwhen';
    dateRow.setAttribute('role', 'group');
    dateRow.setAttribute('aria-label', '실행 날짜 직접 입력');
    const input = document.createElement('input');
    input.type = 'date';
    input.className = 'd-dateinput';
    input.min = todayStr();
    input.value = '';
    input.setAttribute('aria-label', '실행 날짜');
    // 날짜 칸에 초점이 가면 `오늘` 항목의 파란 강조는 뺀다 — 지금 고르는 것은 날짜 칸이다.
    input.addEventListener('focus', () => pop.querySelectorAll('.d-mitem.on').forEach(on => on.classList.remove('on')));
    // 달력에서 고른 날짜는 바로 확정하고, 손으로 치는 중(숫자·지우기 키)의 change는 덜 쳐진 값일 수 있어
    // Enter나 판 안의 다른 곳으로 초점이 옮겨 갈 때만 확정한다.
    let typed = false;
    const commitDate = () => { if (uiSchedDateOk(input.value, input.validity)) choose(input.value, `${uiKoDate(input.value)}로 옮겼어요`); };
    input.addEventListener('change', () => { if (!typed) commitDate(); });
    input.addEventListener('keydown', (event) => {
      if (event.isComposing) return;
      if (event.key === 'Enter') {
        if (!uiSchedDateOk(input.value, input.validity)) return;
        event.preventDefault();
        commitDate();
        return;
      }
      if (/^[0-9]$/.test(event.key) || event.key === 'Backspace' || event.key === 'Delete') typed = true;
    });
    input.addEventListener('blur', (event) => {
      const to = event && event.relatedTarget;
      if (typed && to && pop.contains && pop.contains(to)) commitDate();
    });
    dateRow.appendChild(input);
    dateButton.after(dateRow);
    place();
    input.focus();
    try { input.showPicker?.(); } catch { /* 달력을 못 열면 입력칸에 초점만 둔다 */ }
  };
  const dateNumber = choices.length + 1;
  const dateButton = entry(dateNumber, '날짜 고르기…', '', pickDate);
  dateButton.dataset.sched = 'pick';
  picks.push({ key: String(dateNumber), run: pickDate });

  const separator = () => { const line = document.createElement('div'); line.className = 'd-msep'; line.setAttribute('role', 'separator'); pop.appendChild(line); };
  separator();
  const later = entry(0, '나중에', '날짜 미정', () => choose(null, '나중에 할 일로 옮겼어요'));
  later.dataset.sched = 'later';
  picks.push({ key: '0', run: () => choose(null, '나중에 할 일로 옮겼어요') });
  separator();

  // 프로젝트: 누르면 판 안에서 목록이 펼쳐진다(날짜를 정하기 전에 정해도, 프로젝트만 정하고 닫아도 된다).
  const state = { jira: item.jira || null, group: item.group || null };
  const projectKey = () => (state.jira ? `jira:${state.jira}` : state.group ? `group:${state.group}` : '');
  const projectBox = document.createElement('div');
  projectBox.className = 'd-schedproj';
  projectBox.setAttribute('role', 'group');
  projectBox.setAttribute('aria-label', '프로젝트');
  const projectButton = document.createElement('button');
  projectButton.type = 'button';
  projectButton.className = 'd-mitem';
  projectButton.setAttribute('role', 'menuitem');
  projectButton.setAttribute('aria-haspopup', 'listbox');
  projectButton.setAttribute('aria-expanded', 'false');
  projectButton.style.setProperty('--i', String(order++));
  mark(projectButton);
  const paintProject = () => {
    const key = projectKey();
    projectButton.replaceChildren();
    const name = document.createElement('span');
    name.textContent = '프로젝트';
    const value = document.createElement('span');
    value.className = 'dt' + (key ? ' has' : '');
    if (key) value.append(uiProjectDot(key), uiGroupLabel(key));
    else value.textContent = '정하기';
    const caret = document.createElement('span');
    caret.className = 'cv';
    caret.innerHTML = uiIcon('chevron');
    projectButton.append(name, value, caret);
    projectButton.setAttribute('aria-label', key ? `프로젝트 ${uiGroupLabel(key)} — 바꾸기` : '프로젝트 정하기');
  };
  paintProject();
  let projectList = null;
  const closeProjects = (focus) => {
    if (projectList) { projectList.remove(); projectList = null; }
    projectButton.setAttribute('aria-expanded', 'false');
    if (focus) projectButton.focus();
    place();
  };
  const saveProject = async (value) => {
    try {
      if (value === PICK_CLEAR) { await setTaskJira(item.id, null); await setTaskGroup(item.id, null); state.jira = null; state.group = null; }
      else if (value.startsWith('group:')) { await setTaskGroup(item.id, value.slice(6)); state.group = value.slice(6); state.jira = null; }
      else { await setTaskJira(item.id, value.replace(/^jira:/, '')); state.jira = value.replace(/^jira:/, ''); state.group = null; }
    } catch { return; } // 저장이 안 되면 request가 이미 알렸다 — 판은 그대로 두고 지금 값을 보여 준다
    paintProject();
    announce(projectKey() ? '프로젝트를 정했어요' : '프로젝트를 뺐어요');
    load(); // 이 구역은 판이 닫힐 때까지 미뤄진다
  };
  projectButton.addEventListener('click', () => {
    if (projectList) { closeProjects(true); return; }
    const current = state.jira ? { type: 'jira', value: state.jira } : state.group ? { type: 'group', value: state.group } : null;
    const entries = projectPickEntries(current, false).filter(one => one.value !== PICK_CUSTOM);
    projectButton.setAttribute('aria-expanded', 'true');
    if (!entries.some(one => one.type === 'option')) {
      projectList = document.createElement('div');
      projectList.className = 'd-schedhint';
      projectList.textContent = '아직 정해 둔 프로젝트가 없어요';
    } else {
      projectList = uiPickList({
        entries,
        label: '프로젝트 고르기',
        search: uiPickSearchable(entries),
        onClose: byKeyboard => closeProjects(byKeyboard),
        onPick: async (value) => { closeProjects(true); await saveProject(value); },
      });
    }
    projectBox.appendChild(projectList);
    place();
    projectList.focusStart?.();
  });
  projectBox.appendChild(projectButton);
  pop.appendChild(projectBox);

  const onEsc = () => uiSchedClose({ restoreFocus: true });
  const place = () => uiSchedPlace(pop, anchor);
  const reposition = (event) => { if (!event || !event.target || !pop.contains || !pop.contains(event.target)) place(); };
  pop.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.key === 'Tab') {
      // 판 안에서는 Tab이 평소대로 움직인다(날짜 칸의 월·일·연, 프로젝트 찾기 칸). 판 밖으로 나가는 Tab에서만 닫는다.
      const stops = [...pop.querySelectorAll('button, input')].filter(one => !one.disabled && one.tabIndex !== -1);
      const edge = event.shiftKey ? stops[0] : stops[stops.length - 1];
      if (!stops.length || document.activeElement === edge) uiSchedClose({ restoreFocus: true });
      return;
    }
    const typing = event.target && String(event.target.tagName || '').toUpperCase() === 'INPUT';
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !typing) {
      const buttons = [...pop.querySelectorAll('[role="menuitem"]')];
      if (!buttons.length) return;
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const at = buttons.indexOf(document.activeElement);
      buttons[(at + step + buttons.length) % buttons.length].focus();
      return;
    }
    if (typing || (event.target && event.target.closest && event.target.closest('.d-gpick')) || event.metaKey || event.ctrlKey || event.altKey || !/^[0-9]$/.test(event.key)) return;
    const found = picks.find(one => one.key === event.key);
    if (found) { event.preventDefault(); found.run(); }
  });

  document.body.appendChild(pop);
  anchor.setAttribute('aria-expanded', 'true');
  uiSchedOpen = { pop, anchor, zone, id: item.id, onEsc, reposition };
  escPush(onEsc);
  window.addEventListener('resize', reposition);
  document.addEventListener('scroll', reposition, true);
  place();
  const first = pop.querySelector('[data-sched="today"]');
  first?.classList.add('on');
  first?.focus();
}
document.addEventListener('click', (event) => {
  if (uiSchedOpen && !uiSchedOpen.anchor.contains(event.target) && !uiSchedOpen.pop.contains(event.target)) uiSchedClose();
});

// 슬랙에서 갓 들어온 할 일. 언제 할지·프로젝트는 줄의 `일정 정하기`에서 고른다.
// 비어 있으면 섹션 자체를 숨겨서, 처리할 게 있을 때만 눈에 띄게 한다.
function renderInbox(items) {
  const zone = document.getElementById('inboxZone');
  const list = document.getElementById('inboxList');
  document.getElementById('inboxCount').textContent = items.length;
  zone.hidden = items.length === 0;
  list.replaceChildren();
  if (!items.length) return;

  // 개수와 상관없이 전부 보인다 — 접으면 놓치게 된다.
  items.forEach((item) => {
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
    // 줄에는 두 갈래만 늘 보인다 — 일정 정하기(오늘·내일·이번 주·다음 주·날짜·나중에·프로젝트가 한 판) / 완료.
    actions.appendChild(uiSchedButton(item, row));
    // 완료는 기록이 남고(주간요약에 들어감), 삭제는 남지 않는다 — 삭제는 ⋯ 안으로 들어갔다.
    const done = document.createElement('button');
    done.type = 'button';
    done.className = 'd-btn sm';
    done.textContent = '완료';
    done.setAttribute('aria-label', `${item.description} — 완료`);
    done.addEventListener('click', () => fadeOutAndRun(row, () => toggleTask(item.id), '완료했어요'));
    actions.appendChild(done);

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

// 접는 목록 맨 아래 `N개 더 ›` / `접기 ⌃` — 누르면 접힌 줄(rows)의 hidden만 켜고 끈다(다시 그리지 않아
// 초점이 그대로 남는다, 제목 옆 숫자는 늘 전체 개수). label은 읽어 주는 이름(`<label> N개 더 보기`/`<label> 접기`),
// expanded는 지금 펼침, controls는 줄을 담은 요소의 id, onChange(펼침)는 누를 때 펼침을 기억하는 자리다.
function uiFoldToggle(rows, { label, expanded = false, controls = '', onChange = null, className = '' } = {}) {
  let open = !!expanded;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `d-link ${className}`.trim();
  if (controls) button.setAttribute('aria-controls', controls);
  const paint = () => {
    button.textContent = open ? '접기 ⌃' : `${rows.length}개 더 ›`;
    button.setAttribute('aria-label', open ? `${label} 접기` : `${label} ${rows.length}개 더 보기`);
    button.setAttribute('aria-expanded', String(open));
  };
  paint();
  button.addEventListener('click', () => {
    open = !open;
    rows.forEach(row => { row.hidden = !open; });
    if (onChange) onChange(open);
    paint();
  });
  return button;
}

// 머리줄의 끝낸 개수 칩 `✓ 5/19` — 끝낸 개수를 보이는 유일한 곳. 오늘 할 일이 0개면 칩이 없고,
// 전부 끝내면 초록이 된다. 화면 읽기에는 `19개 중 5개 끝냈어요`를 그대로 읽어 준다.
function renderTodayChip(done, total) {
  const chip = document.getElementById('todayTaskCount');
  chip.hidden = !total;
  if (!total) return;
  const label = `${total}개 중 ${done}개 끝냈어요`;
  chip.setAttribute('aria-label', label);
  chip.title = label;
  chip.classList.toggle('is-full', done === total);
  const num = document.getElementById('todayDoneNum');
  if (num.textContent !== String(done)) {
    const had = num.textContent !== '';
    num.textContent = done;
    if (had) { num.classList.remove('tick'); void num.offsetWidth; num.classList.add('tick'); }
  }
  document.getElementById('todayTotalNum').textContent = `/${total}`;
}

function renderTodayTasks(items) {
  const doneItems = items.filter(item => item.status === 'done');
  renderTodayChip(doneItems.length, items.length);
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
      [...groupItems].sort(compareTasks).forEach(item => list.appendChild(uiTaskRow(item, { mode: 'today', grouped: key !== '__misc__', fromKey: uiGroupFromKey(key, item) })));
    });
  }

  if (!active.length && !doing.length) {
    list.insertAdjacentHTML('beforeend', doneItems.length
      ? '<div class="d-empty">오늘 할 일을 모두 끝냈어요.</div>'
      : '<div class="d-empty is-short">오늘 할 일이 비었어요.</div>');
  }

  if (doneItems.length) {
    list.appendChild(uiGroupHeading('완료', doneItems.length, {
      open: todayDoneOpen,
      onToggle: () => { todayDoneOpen = !todayDoneOpen; renderTodayTasks(items); },
    }));
    if (todayDoneOpen) doneItems.forEach(item => list.appendChild(uiTaskRow(item, { mode: 'today' })));
  }
  uiSchedRiseApply(list);
}

// 일정 정하기에서 `오늘`로 정한 업무의 새 줄은 솟아오르며 연파랑이 잠깐 비친다(한 번만).
function uiSchedRiseApply(list) {
  if (!uiSchedRise.size || !list.querySelectorAll) return;
  list.querySelectorAll('[data-task-id]').forEach((row) => {
    const at = uiSchedRise.get(row.dataset.taskId);
    if (at === undefined) return;
    uiSchedRise.delete(row.dataset.taskId);
    if (Date.now() - at < 8000) row.classList.add('is-rise');
  });
  [...uiSchedRise].forEach(([id, at]) => { if (Date.now() - at >= 8000) uiSchedRise.delete(id); });
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

// 누르는 화면(키보드가 없는 휴대폰)인지 — 폭이 아니라 입력 방식으로 가린다.
function uiTouchScreen() {
  try { return window.matchMedia('(hover: none) and (pointer: coarse)').matches; } catch { return false; }
}

// 완료·옮기기 알림. 누르는 화면에서는 `⌘Z로 되돌리기` 글자(ui.css가 숨긴다) 대신 `되돌리기` 버튼을 단다 — ⌘Z와 같은 replayUndo.
// showNotice는 안전장치라 정의를 고치지 않는다: 버튼은 action 인자로 넘기고, 동작이 이미 하나 있으면
// (완료 뒤 `결과 한 줄 남기기`) 그 알림의 `닫기` 앞에 하나를 더 세운다.
// 버튼은 이 작업이 남긴 기록(entry — uiUndoOwn)만 되돌린다. 그 사이 다른 작업이 겹쳐 기록을 알 수 없으면 버튼을 달지 않고,
// 누를 때 그 기록이 맨 위가 아니면 다른 것을 되돌리지 않고 순서를 알린다(일괄 작업의 되돌리기와 같은 말).
function uiUndoNotice(message, action = null, entry = null) {
  const undoable = entry && uiTouchScreen() && !undoReplaying && Date.now() - lastUndoRecordedAt < 3000;
  if (!undoable) { showNotice(message, false, null, action); return; }
  const undo = { label: '되돌리기', onClick: (button) => {
    if (undoStack[undoStack.length - 1] !== entry) { showNotice('최근 작업부터 순서대로 실행 취소해 주세요', true); return; }
    button.disabled = true;
    replayUndo('undo');
  } };
  if (!action) { showNotice(message, false, null, undo); return; }
  showNotice(message, false, null, action);
  const region = document.getElementById('liveRegion');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'd-btn sm';
  button.textContent = undo.label;
  button.addEventListener('click', () => undo.onClick(button));
  region.insertBefore(button, region.lastChild);
}

// 작업 전 되돌리기 기록 맨 위(uiUndoMark)와 비교해, 그 뒤로 새 기록이 딱 하나면 그것이 이 작업의 것이다.
// 둘 이상이면(다른 줄의 저장이 겹침) 어느 것인지 알 수 없어 null — 알림에 버튼을 달지 않는다(⌘Z는 그대로).
function uiUndoMark() { return undoStack[undoStack.length - 1] || null; }
function uiUndoOwn(mark) {
  const start = mark ? undoStack.lastIndexOf(mark) + 1 : 0;
  if (mark && start === 0) return null;
  return undoStack.length - start === 1 ? undoStack[start] : null;
}

// fadeOutAndRun(안전장치, 정의 그대로)을 쓰되 끝난 알림만 uiUndoNotice로 — 성공했을 때만 알린다(실패는 request가 이미 알렸다).
async function uiMoveRun(card, action, message) {
  let finished = false;
  const mark = uiUndoMark();
  await fadeOutAndRun(card, async () => { await action(); finished = true; }, null);
  if (finished && message) uiUndoNotice(message, null, uiUndoOwn(mark));
}

// 좁은 폭에서 업무 줄 아무 데나 누르면 그 업무 시트를 연다. 체크 칸(빈 여백 포함)·선택 칸·원문·버튼·입력칸에서 온 누름과
// 제 누름이 따로 있는 자리(own — 제목)는 제 할 일만 한다. 넓은 폭은 지금 그대로(아무 일도 없다).
function uiRowTapOpens(event, own = '') {
  if (!detailSheet()) return false;
  const target = event && event.target;
  if (!target || typeof target.closest !== 'function') return false;
  return !target.closest(`input, textarea, select, a, button, label, .d-check, .d-sel${own ? `, ${own}` : ''}`);
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

// ---------- 프로젝트 고르기 한 벌 (BBUNDLE 덩어리 2) ----------
// 프로젝트를 고르는 자리(업무 ⋯·상세·받은 것·확인 대기·결정·여러 개 선택·회의 연결)는 모두 renderGroupControl
// 하나를 쓰고, 목록은 옛 <select> 대신 uiPickList다 — 목록 위 검색 칸(프로젝트가 PROJECT_FIND_MIN개 이상일 때만,
// 프로젝트 탭 찾기 칸과 같은 기준)과 묶음(묶음 한 줄 + 그 아래 들여쓴 티켓)을 그릴 수 있어서다.
// 선택지는 projectPickEntries(순수 함수)가 만든다:
//   { type: 'option', value, text, key, dot, level: 0|1, strong, selected, find: [찾을 글자…], label }
//   { type: 'heading', text } — `지난 프로젝트` 소제목
//   { type: 'action', value: '__clear__' | '__custom__', text } — 찾는 중에도 늘 선다
const PICK_CLEAR = '__clear__';
const PICK_CUSTOM = '__custom__';

function projectPickEntries(current, forceClearable) {
  const out = [];
  // 지난 프로젝트도 고를 수 있다 — 목록 끝의 `지난 프로젝트` 소제목 아래로 내려갈 뿐이다.
  // 왼쪽 목록과 같은 자동 판정(projectQuiet)을 쓴다 — 저장된 값이 아니라 매번 다시 계산한다.
  const rest = [];
  const past = [];
  const quietToday = todayStr();
  const wfItems = (typeof workflowData === 'object' && workflowData && workflowData.items) || [];
  const wfMeetings = (typeof workflowData === 'object' && workflowData && workflowData.meetings) || [];
  const put = (keys, lines) => {
    const open = wfItems.filter(item => uiProjectOpenItem(item) && keys.includes(wfKey(item))).length;
    const last = keys.map(key => projectLastDay(key, wfItems, wfMeetings)).sort().pop() || '';
    (projectQuiet({ open }, last, quietToday) ? past : rest).push(...lines);
  };
  const isCurrentJira = key => !!current && current.type === 'jira' && current.value === key;
  // 지라 한 줄 — 고르는 자리라 `요약 · 키`(BKEY 결정): 눈이 먼저 가는 앞자리는 요약, 키는 오른쪽 조용한 글자.
  const jiraLine = (issue, extra = {}) => ({
    type: 'option',
    value: `jira:${issue.key}`,
    text: issue.summary || issue.key,
    key: issue.summary ? issue.key : '',
    dot: `jira:${issue.key}`,
    level: 0,
    selected: isCurrentJira(issue.key),
    // 별칭(BJALIAS)으로도, 지라 원래 요약·키로도 찾힌다.
    find: [issue.summary, issue.key, uiGroupLabel(`jira:${issue.key}`)],
    ...extra,
  });
  // `그 밖의 이슈`(extra = 지라에서 완료됐거나 담당이 바뀐 것)는 새로 고를 수 있는 선택지로 내놓지
  // 않는다 — 요약을 보여 주려고 들고 있을 뿐이다. 다만 지금 걸려 있는 값이면 골라진 채로 보여야 한다.
  const usable = jiraIssuesCache.filter(issue => !issue.extra || isCurrentJira(issue.key));
  const byKey = new Map(usable.map(issue => [issue.key, issue]));
  const bundles = typeof projectBundles === 'function' ? projectBundles() : [];
  const seen = new Set();
  usable
    .slice()
    .sort((a, b) => String(a.summary || a.key).localeCompare(String(b.summary || b.key)))
    .forEach((issue) => {
      const bundle = bundles.find(entry => entry.keys.includes(`jira:${issue.key}`));
      if (!bundle) { put([`jira:${issue.key}`], [jiraLine(issue)]); return; }
      if (seen.has(bundle.id)) return;
      seen.add(bundle.id);
      // 묶음은 한 줄(대표 티켓으로 저장) + 그 아래 들여쓴 나머지 티켓(그 티켓으로 저장 — 직접 골라도 된다).
      const leadKey = bundle.lead.slice('jira:'.length);
      const lead = byKey.get(leadKey) || jiraIssuesByKey.get(leadKey) || { key: leadKey, summary: '' };
      const kids = bundle.keys.filter(key => key !== bundle.lead).map(key => byKey.get(key.slice('jira:'.length))).filter(Boolean);
      const name = uiGroupLabel(bundle.lead);
      const head = jiraLine(lead, {
        text: name,
        key: leadKey,
        strong: true,
        find: bundle.keys.flatMap((key) => {
          const one = byKey.get(key.slice('jira:'.length)) || jiraIssuesByKey.get(key.slice('jira:'.length));
          return [key.slice('jira:'.length), one && one.summary, uiGroupLabel(key)];
        }),
        label: `${name} 묶음 · 티켓 ${bundle.keys.length}개 — 대표 ${leadKey}로 지정`,
        own: [lead.summary, leadKey, name],
      });
      put(bundle.keys, [head, ...kids.map(kid => jiraLine(kid, { level: 1, dot: bundle.lead }))]);
    });
  customGroupsCache.forEach((group) => {
    const selected = !!current && current.type === 'group' && current.value === group;
    put([`group:${group}`], [{ type: 'option', value: `group:${group}`, text: group, key: '', dot: `group:${group}`, level: 0, selected, find: [group] }]);
  });
  out.push(...rest);
  if (past.length) out.push({ type: 'heading', text: '지난 프로젝트' }, ...past);
  out.push({ type: 'action', value: PICK_CUSTOM, text: '직접 입력…' });
  // 해제는 맨 끝 — 찾기 칸에서 ↓의 첫 도착이 '해제'면 Enter 한 번에 프로젝트가 풀린다(디자인 검수).
  // 여러 개를 한 번에 옮길 땐 "현재 그룹"이라는 게 없어도(current === null) 해제를 고를 수 있어야 한다.
  if (current || forceClearable) out.push({ type: 'action', value: PICK_CLEAR, text: '프로젝트 빼기' });
  return out;
}

// 찾기 칸은 선택지가 많을 때만 선다 — 프로젝트 탭 찾기 칸(PROJECT_FIND_MIN)과 같은 기준.
function uiPickSearchable(entries) {
  const min = typeof PROJECT_FIND_MIN === 'number' ? PROJECT_FIND_MIN : 8;
  return entries.filter(entry => entry.type === 'option').length >= min;
}

// 찾는 말로 거른다(팔레트·프로젝트 찾기와 같은 wfSearchMatches 규칙 — NFKC·대소문자 무시·모든 낱말 포함).
// 묶음 줄은 제 이름이 맞으면 들여쓴 티켓까지 전부, 티켓 하나만 맞으면 묶음 줄 + 맞은 티켓만 선다.
// 해제·직접 입력은 늘 서고, 아래에 선택지가 하나도 안 남은 소제목은 뺀다.
function uiPickFilter(entries, query) {
  const needle = String(query || '').trim();
  if (!needle) return entries;
  const matches = typeof wfSearchMatches === 'function'
    ? wfSearchMatches
    : (word, values) => values.filter(Boolean).join(' ').toLocaleLowerCase().includes(word.toLocaleLowerCase());
  const hit = (entry, own = false) => matches(needle, (own && entry.own) || entry.find || [entry.text]);
  const kept = [];
  let headHit = false;
  entries.forEach((entry, index) => {
    if (entry.type !== 'option') { kept.push(entry); return; }
    if (entry.level === 1) { if (headHit || hit(entry)) kept.push(entry); return; }
    headHit = hit(entry, true);
    let kidHit = false;
    for (let at = index + 1; at < entries.length && entries[at].type === 'option' && entries[at].level === 1; at += 1) {
      if (hit(entries[at])) { kidHit = true; break; }
    }
    // 묶음 줄은 목록에 없는 티켓(지라에서 끝난 것 등)의 이름·키로도 찾힌다(entry.find는 묶음 전체).
    if (headHit || kidHit || (entry.own && hit(entry))) kept.push(entry);
  });
  return kept.filter((entry, index) => entry.type !== 'heading' || (kept[index + 1] && kept[index + 1].type === 'option'));
}

// 목록 한 벌: (찾기 칸) + role=listbox 안의 선택지 버튼들. 키보드는 ⋯ 메뉴(.d-menulist)와 같다 — ↑↓가 찾기 칸과
// 선택지 사이를 돌고(찾기 칸에서 ↓면 첫 선택지), Enter는 그 선택지, Esc는 목록을 닫는다(메뉴 안이면 메뉴는 남는다).
// 찾기 칸에서 Enter면 맨 위 선택지를 고른다. onPick(value, query), onClose(byKeyboard).
let uiPickSeq = 0;
function uiPickList({ entries, label, onPick, onClose, search = false, placeholder = '이름이나 지라 번호로 찾기', emptyText = '찾는 프로젝트가 없어요' }) {
  uiPickSeq += 1;
  const root = document.createElement('div');
  root.className = 'd-gpick';
  const list = document.createElement('div');
  list.className = 'd-gplist';
  list.id = `gplist-${uiPickSeq}`;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', label);
  const none = document.createElement('div');
  none.className = 'd-gpnone';
  none.setAttribute('role', 'status');
  let query = '';
  let input = null;
  let closed = false;
  let shown = [];    // 지금 보이는 선택지(거른 뒤)
  let buttons = [];  // 그 버튼들 — 키보드 이동·Enter가 쓴다
  const close = (byKeyboard) => { if (closed) return; closed = true; onClose(byKeyboard); };
  const pick = (value) => { if (closed) return; closed = true; onPick(value, query); };

  const draw = () => {
    list.replaceChildren();
    shown = uiPickFilter(entries, query);
    buttons = [];
    const found = shown.some(entry => entry.type === 'option');
    none.textContent = query.trim() && !found ? emptyText : '';
    none.hidden = !none.textContent;
    shown.forEach((entry) => {
      if (entry.type === 'heading') {
        const head = document.createElement('div');
        head.className = 'd-gphead';
        head.setAttribute('role', 'presentation');
        head.textContent = entry.text;
        list.appendChild(head);
        return;
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'd-mitem d-gpopt'
        + (entry.level === 1 ? ' is-sub' : '') + (entry.strong ? ' is-bundle' : '') + (entry.type === 'action' ? ' is-act' : '');
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', entry.selected ? 'true' : 'false');
      button.tabIndex = -1;
      button.dataset.value = entry.value;
      if (entry.dot) button.appendChild(uiProjectDot(entry.dot));
      const name = document.createElement('span');
      name.className = 'nm';
      name.textContent = entry.text;
      name.title = entry.text;
      button.appendChild(name);
      if (entry.key) {
        const key = document.createElement('span');
        key.className = 'ky';
        key.textContent = entry.key;
        button.appendChild(key);
      }
      if (entry.label) button.setAttribute('aria-label', entry.label);
      // 누르는 동안 찾기 칸의 초점을 뺏지 않는다 — 초점이 빠지면 목록이 닫히는 판정과 부딪힌다.
      button.addEventListener('mousedown', event => event.preventDefault());
      button.addEventListener('click', (event) => { event.stopPropagation(); pick(entry.value); });
      list.appendChild(button);
      buttons.push(button);
    });
    // 찾기 칸이 없으면(선택지가 적을 때) 지금 값(없으면 첫 줄)이 Tab으로 들어오는 자리다.
    if (!input) {
      const home = buttons.find(button => button.getAttribute('aria-selected') === 'true') || buttons[0];
      if (home) home.tabIndex = 0;
    }
  };

  if (search) {
    input = document.createElement('input');
    input.type = 'search';
    input.className = 'd-din d-pfind d-gpfind';
    input.placeholder = placeholder;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', `${label} — 찾기`);
    input.setAttribute('aria-controls', list.id);
    input.addEventListener('input', () => { query = input.value; draw(); });
    root.appendChild(input);
  }
  root.append(none, list);
  draw();

  root.addEventListener('click', event => event.stopPropagation());
  root.addEventListener('keydown', (event) => {
    if (event.isComposing) return; // 한글을 조합하는 중의 Enter·Esc는 글자를 확정하는 것이다
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const focusable = [...(input ? [input] : []), ...buttons];
      if (!focusable.length) return;
      event.preventDefault();
      event.stopPropagation();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const at = focusable.indexOf(document.activeElement);
      const next = focusable[at < 0 ? (step > 0 ? 0 : focusable.length - 1) : (at + step + focusable.length) % focusable.length];
      next.focus();
      next.scrollIntoView?.({ block: 'nearest' });
      return;
    }
    if (event.key === 'Enter' && input && event.target === input) {
      event.preventDefault();
      if (!query.trim()) return;
      const first = shown.find(entry => entry.type === 'option');
      if (first) { pick(first.value); return; }
      if (shown.some(entry => entry.value === PICK_CUSTOM)) pick(PICK_CUSTOM);
    }
  });
  // 목록 밖으로 초점이 나가면 닫는다(다시 그리는 동안 잠깐 비는 초점은 한 박자 기다려 본다).
  root.addEventListener('focusout', (event) => {
    if (event.relatedTarget && root.contains(event.relatedTarget)) return;
    setTimeout(() => {
      if (closed || !root.isConnected) return;
      if (!root.contains(document.activeElement)) close(false);
    }, 0);
  });
  root.focusStart = () => {
    const current = buttons.find(button => button.getAttribute('aria-selected') === 'true');
    const target = input || current || buttons[0];
    if (!target) return;
    target.focus();
    (current || target).scrollIntoView?.({ block: 'nearest' });
  };
  return root;
}

// 메뉴(.d-menulist, 떠 있는 층) 안에서 목록을 펼쳐 메뉴가 화면 아래로 넘치면 넘친 만큼 위로 올린다.
function uiPickFit(node) {
  const menu = node && typeof node.closest === 'function' ? node.closest('.d-menulist') : null;
  if (!menu || typeof menu.getBoundingClientRect !== 'function') return;
  const box = menu.getBoundingClientRect();
  const over = box.bottom - (window.innerHeight - 8);
  if (over > 0) menu.style.top = `${Math.max(8, Math.round(box.top - over))}px`;
}

function renderGroupControl({ jira, group, onSetJira, onSetGroup, forceClearable = false, silent = false, plain = false }) {
  const wrap = document.createElement('div');
  wrap.className = 'jira-control';
  const saved = (text) => { if (!silent) { announce(text); load(); } };

  // 직접 입력 — 찾던 글자를 미리 채운 칸. Enter면 그 이름의 그룹, Esc·바깥 누름이면 원래 자리로.
  const customInput = (revertTo, draft) => {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'group-input';
    input.placeholder = '그룹명 입력 후 Enter';
    input.setAttribute('aria-label', '새 그룹 이름');
    input.value = draft || '';
    let inputCommitted = false;
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('keydown', async (e2) => {
      if (e2.isComposing) return;
      if (e2.key === 'Escape') {
        e2.preventDefault();
        e2.stopPropagation();
        inputCommitted = true;
        if (revertTo && wrap.contains(input)) { wrap.replaceChild(revertTo, input); revertTo.focus(); }
        return;
      }
      if (e2.key !== 'Enter') return;
      const v = input.value.trim();
      if (!v) return;
      inputCommitted = true;
      await onSetGroup(v);
      saved('그룹을 지정했어요');
    });
    input.addEventListener('blur', () => {
      if (inputCommitted) return;
      if (revertTo && wrap.contains(input)) wrap.replaceChild(revertTo, input);
    });
    return input;
  };

  // 고른 값 하나를 저장한다 — 해제·직접 입력·그룹·지라 네 갈래(옛 <select>의 change와 같은 길).
  const commit = (value) => {
    if (value === PICK_CLEAR) {
      (async () => {
        await onSetJira(null);
        await onSetGroup(null);
        saved('그룹을 지웠어요');
      })();
      return;
    }
    if (value.startsWith('group:')) {
      const g = value.slice('group:'.length);
      (async () => { await onSetGroup(g); saved('그룹을 지정했어요'); })();
      return;
    }
    const key = value.replace(/^jira:/, '');
    (async () => { await onSetJira(key); saved('지라 이슈를 연결했어요'); })();
  };

  // 배지(또는 `그룹 지정…`)를 누르면 같은 자리에서 목록이 펼쳐진다. 고르면 저장하고, 메뉴 안이었으면 메뉴도 닫는다.
  const openPicker = (current, revertTo) => {
    const entries = projectPickEntries(current, forceClearable);
    const restore = (focus) => {
      wrap.classList.remove('is-picking');
      if (wrap.contains(picker)) wrap.replaceChild(revertTo, picker);
      if (focus) revertTo.focus();
    };
    const picker = uiPickList({
      entries,
      label: '프로젝트 고르기',
      search: uiPickSearchable(entries),
      onClose: byKeyboard => restore(byKeyboard),
      onPick: (value, query) => {
        if (value === PICK_CUSTOM) {
          wrap.classList.remove('is-picking');
          const input = customInput(revertTo, query.trim());
          wrap.replaceChild(input, picker);
          input.focus();
          return;
        }
        restore(false);
        if (wrap.closest && wrap.closest('.d-menulist') && typeof uiMenuOpen === 'object' && uiMenuOpen) {
          const anchor = uiMenuOpen.anchor;
          uiMenuClose();
          anchor?.focus?.();
        }
        commit(value);
      },
    });
    wrap.replaceChild(picker, revertTo);
    wrap.classList.add('is-picking');
    uiPickFit(picker);
    picker.focusStart();
  };

  // 이미 지정된 지라·그룹은 배지로 보이고, 누르면 같은 자리에서 고르는 목록으로 바뀐다.
  // keyText가 있으면(지라뿐) 요약 뒤에 조용한 회색 글자로 키를 덧붙인다(BKEY 결정 — 상세 카드의 값 표시).
  // plain이면(상세 카드의 필드 격자) 회색 알약 대신 다른 값과 같은 `● 이름 ⌄` 글자 고르개로 그린다.
  const appendBadge = (className, label, current, keyText) => {
    const badge = document.createElement('button');
    badge.type = 'button';
    badge.className = plain ? `${className} is-plain` : className;
    const text = plain ? document.createElement('span') : badge;
    if (plain) text.className = 'v';
    text.textContent = label;
    if (keyText) {
      const key = document.createElement('span');
      key.className = 'k-mute';
      key.textContent = ` ${keyText}`;
      text.appendChild(key);
    }
    if (plain) {
      const caret = document.createElement('span');
      caret.className = 'cv';
      caret.innerHTML = uiIcon('chevron');
      badge.append(uiProjectDot(current.value), text, caret);
    }
    badge.setAttribute('aria-label', `${label}${keyText ? ` ${keyText}` : ''} — 클릭해서 변경/해제`);
    badge.setAttribute('aria-haspopup', 'listbox');
    badge.addEventListener('click', (e) => {
      e.stopPropagation();
      openPicker(current, badge);
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

  // 아직 프로젝트가 없으면 `그룹 지정…` 한 칸 — 누르면(또는 Enter·Space·↓) 같은 자리에서 목록이 펼쳐진다.
  const start = document.createElement('button');
  start.type = 'button';
  start.className = 'jira-select jira-pick';
  start.textContent = '그룹 지정…';
  start.setAttribute('aria-label', '그룹 지정');
  start.setAttribute('aria-haspopup', 'listbox');
  start.addEventListener('click', (e) => { e.stopPropagation(); openPicker(null, start); });
  start.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown') return;
    e.preventDefault();
    e.stopPropagation();
    openPicker(null, start);
  });
  wrap.appendChild(start);
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

// 기한(확인 대기에서는 `답변 받을 날`)도 ⌘Z 대상이다. 되돌릴 값은 보내기 전에 읽어 둔다 —
// load()가 돌면 itemsById가 새 값으로 바뀐다. 기록은 호출부에서 pushUndo를 부르기만 한다.
async function setTaskDue(id, due, undoLabel = '기한 변경') {
  const before = itemsById.get(id)?.due || null;
  await request('/api/track/set-due', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, due }),
  });
  const after = due || null;
  if (before !== after) pushUndo({
    label: `${itemsById.get(id)?.description || ''} (${undoLabel})`,
    undo: () => postJson('/api/track/set-due', { id, due: before }),
    redo: () => postJson('/api/track/set-due', { id, due: after }),
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

// `새로 들어온 것`은 itemsById에 없어 request(recordUndoFor)가 되돌리기 기록을 남기지 못한다 — 일정 정하기 판이 저장된 뒤 이걸로 남긴다.
// 되돌릴 때는 예정일을 전 값으로 돌리면서 받지 않은 표시도 되살리고(inbox: true), 다시 하기는 처음 보낸 그대로다(서버가 표시를 다시 지운다).
function uiInboxSchedUndo(item, scheduled) {
  if (itemsById.has(item.id)) return; // 목록에 있는 업무면 request가 이미 남겼다
  const before = item.scheduled || null;
  pushUndo({
    label: item.description,
    undo: () => postJson('/api/track/set-scheduled', { id: item.id, scheduled: before, inbox: true }),
    redo: () => postJson('/api/track/set-scheduled', { id: item.id, scheduled }),
  });
}

// 우선순위(아이디어 화면에서는 `가능성` — 같은 값·같은 저장 길)도 ⌘Z 대상이다.
// 이름은 그 화면에서 부르는 말로 남긴다.
async function setPriority(id, priority, undoLabel = '우선순위 변경') {
  const before = itemsById.get(id)?.priority || 'medium';
  await request('/api/track/set-priority', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, priority }),
  });
  const after = priority || 'medium';
  if (before !== after) pushUndo({
    label: `${itemsById.get(id)?.description || ''} (${undoLabel})`,
    undo: () => postJson('/api/track/set-priority', { id, priority: before }),
    redo: () => postJson('/api/track/set-priority', { id, priority: after }),
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
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    const description = input.value.trim();
    if (!description) return;
    // 칸은 잠그지 않고 바로 비운다 — 저장 중에 친 다음 글자는 그대로 남고, 연속 Enter는 순서대로 저장된다.
    input.value = '';
    const run = uiQueueSend(inputId, async () => {
      await request(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description }),
      });
      announce(announceText);
      await load();
    });
    return run.catch(() => { uiSendRestore(input, description, inputId, run); });
  });
}

// 마지막으로 본 탭 복원 규칙. 페이지를 열자마자 사람이 탭을 누르면 그 선택이 먼저다 —
// 복원이 뒤늦게 덮어써서 "탭 이름만 바뀌고 내용은 이전 탭" 상태가 되던 것을 막는다.
// 앱이 다 켜지기 전에 누른 탭은 브라우저가 그 버튼에 초점을 남기므로, 그것도 사람이 고른 것으로 본다.
function tabToRestore(savedTab, picked, focusedTab) {
  if (picked) return null;
  return focusedTab || savedTab || 'today';
}

// ---- client.test.js는 이 줄 위까지만 읽는다 (아래는 화면을 실제로 켜는 실행 코드) ----
// 크롬 `앱으로 설치` — 설치 창을 띄울 수 있다는 신호와 설치를 마친 신호(위 appInstall*).
window.addEventListener('beforeinstallprompt', appInstallOnPrompt);
// 창 크기가 바뀌면 두 줄 말줄임 제목(아이디어·회의 줄)이 잘렸는지 다시 잰다 — 멎은 뒤 한 번만.
let uiClampResizeTimer = null;
window.addEventListener('resize', () => { clearTimeout(uiClampResizeTimer); uiClampResizeTimer = setTimeout(uiClampResync, 150); });
// 접힌 details 안에서 그려진 제목도 펼쳐진 뒤 다시 잰다(toggle은 거품이 없어 잡기 단계로 듣는다).
document.addEventListener('toggle', () => requestAnimationFrame(uiClampResync), true);
window.addEventListener('appinstalled', appInstallOnInstalled);
// 한글 조합 중인 칸·눌린 손가락을 기억한다 — 입력 중 다시 그리기 미루기(uiRenderOrHold)가 본다.
document.addEventListener('compositionstart', (event) => { uiComposingEl = event.target; }, true);
document.addEventListener('compositionend', (event) => { if (uiComposingEl === event.target) uiComposingEl = null; }, true);
document.addEventListener('pointerdown', () => { uiPointerDown = true; }, true);
document.addEventListener('pointerup', () => { uiPointerDown = false; }, true);
document.addEventListener('pointercancel', () => { uiPointerDown = false; }, true);
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
      // 하루 마감 — 남은 오늘 업무에 `내일/나중에/완료`를 찍어 한 번에 저장한다(wrap-ui.js).
      label: '오늘 정리',
      disabled: taskBatchBusy,
      onClick: () => wrapOpen(),
    }, {
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

// 검색 팔레트를 여는 자리: 헤더의 `검색 ⌘K` 버튼(오늘 들어온 것 모아 보기는 팔레트 안 토글 칩).
document.getElementById('searchEntryBtn')?.addEventListener('click', () => palOpen({}));

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
  // 좁은 폭 시트는 탭에 붙어 있지 않다 — 탭을 옮기면 닫아 가림막이 새 탭을 막지 않게 한다.
  if (tab !== activeTabKey && panelScrimEl && !panelScrimEl.hidden) panelClose();
  // 프로젝트 탭에 새로 들어올 때만 왼쪽 목록 차례를 다시 정렬한다(체크 등으로 이미 그 탭에 있는 동안
  // 다시 그리는 것은 고정된 차례를 그대로 쓴다 — projectOrderResort).
  if (tab === 'projects' && activeTabKey !== 'projects') projectOrderResort = true;
  // 프로젝트 찾기 칸의 값은 저장하지 않는다 — 탭을 떠나면 비운다(BPVIEW). 탭은 숨겨질 뿐 다시 그려지지
  // 않으므로(tabStale.projects가 그대로다) 값을 지우는 것만으로는 부족하다 — 목록도 다시 그려 둔다.
  if (tab !== 'projects' && activeTabKey === 'projects' && projectFindQuery) {
    projectFindQuery = '';
    renderProjects();
  }
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
  if (typeof usageTabOpened === 'function') usageTabOpened(tab, activeTabKey);   // 사용 횟수(WP-R, usage-ui.js)
  activeTabKey = tab;
  // 주간요약을 떠나면 문장 모으기 막대도 함께 내린다(떠 있는 막대가 다른 탭에 남지 않게).
  if (tab !== 'weekly' && typeof reportNestEnd === 'function') reportNestEnd();
  // 여러 개 선택은 오늘 탭(목록·서랍)의 것이다 — 다른 탭으로 가면 끝낸다(보이지 않는 업무를 막대로 바꾸지 않게).
  if (tab !== 'today' && taskSelectionMode) taskSelectEnd();
  document.getElementById('skipLink').hidden = tab !== 'today';
  renderActiveTabLists();
  // 숨은 탭에서 그려진 두 줄 말줄임 제목은 잴 수 없었다(크기 0) — 보이게 된 뒤 다시 잰다.
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(uiClampResync);
  try {
    localStorage.setItem('activeTab', tab);
  } catch {}
}

// 사람이 탭을 한 번이라도 골랐는지 — 마지막 탭 복원이 그 선택을 덮지 않게 하는 표다.
let tabUserPicked = false;
Object.keys(TABS).forEach((key) => {
  document.getElementById(TABS[key].btn).addEventListener('click', () => { tabUserPicked = true; setActiveTab(key); });
  document.getElementById(TABS[key].btn).addEventListener('keydown', event => {
    const keys = Object.keys(TABS);
    let index = keys.indexOf(key);
    if (event.key === 'ArrowRight') index = (index + 1) % keys.length;
    else if (event.key === 'ArrowLeft') index = (index + keys.length - 1) % keys.length;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = keys.length - 1;
    else return;
    event.preventDefault();
    tabUserPicked = true;
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
// 앱이 켜지기 전에 누른 탭 버튼에는 초점이 남아 있다 — 그 선택을 복원이 덮지 않게 함께 본다.
const focusedTabKey = Object.keys(TABS).find(key => document.getElementById(TABS[key].btn) === document.activeElement) || null;
const restoreTab = tabToRestore(savedTab, tabUserPicked, focusedTabKey);
if (restoreTab) setActiveTab(restoreTab);

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
  await refreshListsFromServer();
  refreshBtn.removeAttribute('aria-busy');
  setTimeout(() => refreshBtn.classList.remove('spinning'), 400);
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

// 첫 목록을 그린 뒤 체크인(설치 3일째·8일째 질문)을 한 번 묻는다(checkin-ui.js — 방해될 때는 미룬다).
load().finally(() => { if (typeof checkinStart === 'function') checkinStart(); });
refreshStorageStatus(); // 목록을 못 불러오는 상황에서도 저장이 멈춘 이유는 보이게
fetchAutomationStatus(); // 설정을 열어보지 않아도 톱니바퀴에 실패 여부가 바로 보이게
// 새 버전(톱니바퀴의 파란 점)도 설정을 열지 않고 보이게 — 페이지를 열 때 한 번, 그 뒤 1시간마다 서버가 이미 가진
// 값만 읽는다(`?cached=1` — 원격에 새로 묻는 것은 서버의 1시간 주기 그대로). 읽을 때마다 오늘 탭 한 줄(WP-U)도 다시 그린다.
settingsAboutLoad({ cached: true }).then((about) => {
  // 서버가 막 떠서 첫 확인이 아직 돌고 있었으면 1분 뒤 한 번만 더 읽는다.
  const update = about && about.update;
  if (update && !update.available && !update.checkedAt) setTimeout(() => settingsAboutLoad({ cached: true }).then(renderUpdateNotice), 60 * 1000);
  renderNewsCard(); // load()는 이 값이 오기 전에 먼저 돌 수 있어 여기서도 한 번 더 그린다(WP-J).
  renderUpdateNotice();
});
setInterval(() => settingsAboutLoad({ cached: true }).then(renderUpdateNotice), 60 * 60 * 1000);
setInterval(activityPing, 60 * 1000); // 입력 중·창이 열려 있으면 서버에 알려 자동 업데이트가 기다리게(WP-U)

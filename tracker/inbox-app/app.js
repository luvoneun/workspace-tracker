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
  gear: '<path d="M2 4.6h12M2 11.4h12"/><circle cx="6" cy="4.6" r="1.9"/><circle cx="10.4" cy="11.4" r="1.9"/>',
};
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

// 기한 말투는 어디서나 같다: `2일 지남`(urgent) `오늘까지`(warn) `내일까지` `9월 27일까지`.
// where가 'row'면 오늘 목록의 한 줄 — 먼 기한은 찍지 않는다(의미 없는 값은 자리를 비운다).
function uiDueText(due, where = 'full') {
  if (!due) return null;
  const diff = diffDays(due);
  if (Number.isNaN(diff)) return null;
  if (diff < 0) return { text: `${-diff}일 지남`, tone: 'urgent' };
  if (diff === 0) return { text: '오늘까지', tone: 'warn' };
  if (diff === 1) return { text: '내일까지', tone: '' };
  if (where === 'row') return null;
  return { text: `${uiKoDate(due)}까지`, tone: '' };
}

// 상세에서는 날짜와 의미를 함께 적는다: `9월 22일 (화) · 오늘까지`.
function uiDueDetail(due) {
  if (!due) return null;
  const full = uiKoDate(due);
  const diff = diffDays(due);
  if (Number.isNaN(diff)) return { text: full, tone: '' };
  if (diff < 0) return { text: `${full} · ${-diff}일 지남`, tone: 'urgent' };
  if (diff === 0) return { text: `${full} · 오늘까지`, tone: 'warn' };
  if (diff === 1) return { text: `${full} · 내일까지`, tone: '' };
  return { text: `${full}까지`, tone: '' };
}

// 오늘 목록에 언제부터 밀려 있는지: `어제부터` / `3일 전부터`
function uiCarryText(scheduled) {
  if (!scheduled) return null;
  const diff = diffDays(scheduled);
  if (Number.isNaN(diff) || diff >= 0) return null;
  return diff === -1 ? '어제부터' : `${-diff}일 전부터`;
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
  const left = Math.max(8, Math.min(button.right - size.width, window.innerWidth - size.width - 8));
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
  return tone === 'urgent' ? ' k-neg' : tone === 'warn' ? ' k-warn' : '';
}

// 행의 프로젝트 이름. 그룹 제목이 이미 그 프로젝트를 말해 주면 비운다.
// 지라는 키만 적는다 — 요약은 그룹 제목과 상세가 보여 준다.
function uiProjectLabel(item, grouped) {
  if (grouped) return '';
  return item.jira || item.group || '';
}

// 상태 열의 글자 셀: 밀린 표시 → 진행 중 → 우선순위(5px 점 + 글자) → 기한(맨 오른쪽).
// 보통·낮음·먼 기한처럼 의미 없는 값은 자리를 비운다(알약으로 그리지 않는다).
const UI_PRIORITY_META = { critical: { text: '긴급', tone: 'urgent' }, high: { text: '높음', tone: 'warn' } };
function uiMetaCells(item, opts = {}) {
  const where = opts.where || 'row';
  const done = item.status === 'done';
  const cells = [];
  // 좁은 화면(≤520px)의 두 줄 행에서는 프로젝트가 정보 줄 맨 앞에 온다 — 넓은 화면에서는 프로젝트 열이 보여 주므로 숨긴다.
  if (opts.project) cells.push(`<span class="m-proj">${escapeHtml(opts.project)}</span>`);
  const carry = where === 'row' && !done ? uiCarryText(item.scheduled) : null;
  if (carry) cells.push(`<span class="m-carry">${carry}</span>`);
  if (item.doing && !done && !opts.inDoingGroup) {
    const days = -diffDays(item.doing) + 1;
    cells.push(`<span class="m-doing">${days > 1 ? `${days}일째 진행 중` : '진행 중'}</span>`);
  }
  const priority = done ? null : UI_PRIORITY_META[item.priority];
  if (priority) cells.push(`<span class="m-pri${uiTone(priority.tone)}"><i class="d-dot"></i>${priority.text}</span>`);
  const due = done ? null : uiDueText(item.due, where);
  if (due) cells.push(`<span class="m-due${uiTone(due.tone)}">${due.text}</span>`);
  return cells.join('');
}

// 28px sticky 그룹 제목. 접히는 그룹은 줄 전체가 버튼이고, 마우스를 올리면 `+`로 그 자리에 추가한다.
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
  const name = document.createElement(opts.onOpenProject ? 'button' : 'span');
  name.className = 'gl' + (opts.onOpenProject ? ' lk' : '');
  name.textContent = label;
  name.title = label;
  if (opts.onOpenProject) {
    name.type = 'button';
    name.setAttribute('aria-label', `${label} 프로젝트 모아보기`);
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
  const check = document.createElement('span');
  check.className = 'd-check';
  check.appendChild(taskCompletionCheckbox(item, row, done));
  check.insertAdjacentHTML('beforeend', '<svg class="d-tick" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 7.4 5.7 10.1 11 4.2"/></svg>');
  row.appendChild(check);

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
  row.appendChild(title);

  const projectCell = document.createElement('span');
  projectCell.className = 'd-proj';
  projectCell.textContent = project;
  if (project) projectCell.title = project;
  row.appendChild(projectCell);

  const meta = document.createElement('span');
  meta.className = 'd-meta';
  if (done) {
    uiResultCell(meta, item);
  } else {
    meta.innerHTML = uiMetaCells(item, { where: mode === 'later' ? 'full' : 'row', inDoingGroup: opts.inDoingGroup, project });
    // 답변을 기다리는 업무는 그 사실도 글자로 적는다.
    const blocker = typeof wfItem === 'function' ? wfItem(wfItem(item.id)?.blockedBy) : null;
    if (blocker) meta.insertAdjacentHTML('afterbegin', `<span class="m-wait${blocker.status === 'done' ? ' k-pos' : ''}">${blocker.status === 'done' ? '답변 해결' : '답변 대기'}</span>`);
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
      move('오늘로', todayStr(), '오늘 할 일로 옮김');
    } else {
      if (carried) move('오늘 할게요', todayStr(), '오늘 할 일로 확정함');
      move('내일', tomorrowStr(), '내일로 미룸');
      move('나중에', null, '나중에 할 일로 옮김 · 기한은 그대로입니다.');
    }
    if (item.permalink) {
      const link = document.createElement('a');
      link.className = 'd-iconbtn sm';
      link.href = item.permalink;
      link.target = '_blank';
      link.rel = 'noopener';
      link.title = '슬랙 원문';
      link.setAttribute('aria-label', `${item.description} — 슬랙 원문 열기`);
      link.innerHTML = uiIcon('link');
      acts.appendChild(link);
    }
    acts.appendChild(uiMoreButton(`${item.description} — 더 보기`, () => taskMenuSections({ item, mode, card: row })));
  }
  row.appendChild(acts);
  return row;
}

// 그룹 열쇠(`jira:…` / `group:…` / `__misc__`)를 사람이 읽는 제목으로.
function uiGroupLabel(key) {
  if (key === '__misc__') return '프로젝트 없음';
  if (key.startsWith('jira:')) {
    const jiraKey = key.slice(5);
    const issue = jiraIssuesByKey.get(jiraKey);
    return issue ? `${jiraKey} · ${issue.summary}` : jiraKey;
  }
  return key.slice(6);
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
    + (opts.selected ? ' is-sel' : '');
  // 상세 패널이 열리고 닫힐 때 이 표식으로 찾아 `지금 보는 줄`을 표시한다.
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
  row.appendChild(title);

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
    sub.textContent = opts.sub;
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
  if (!taskSelectionMode || taskBatchBusy) return;
  taskSelectionMode = false;
  taskSelection.clear();
  escDrop(taskSelectEnd);
  uiMenuClose();
  taskListsRender();
  document.getElementById('taskSelectToggle')?.focus();
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

  apply('완료로 표시', { status: 'done' });
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
    showNotice(`${result.count}개 업무를 변경했습니다.`, false, null, { label: '실행 취소', onClick: async () => {
      if (undoStack[undoStack.length - 1] !== entry) { showNotice('이후 작업부터 순서대로 실행 취소해 주세요.', true); return; }
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
    stopped ? `${removed.length}개까지 삭제하고 멈췄습니다. 나머지는 그대로 있습니다.` : `${removed.length}개를 삭제했습니다.`,
    false, null,
    { label: '되돌리기', onClick: async () => {
      if (undoStack[undoStack.length - 1] !== entry) { showNotice('이후 작업부터 순서대로 실행 취소해 주세요.', true); return; }
      await replayUndo('undo');
    } },
  );
  taskSelectionRefresh();
}

// ---------- 프로젝트 탭 ----------
// 왼쪽은 프로젝트 목록, 오른쪽은 고른 프로젝트 하나. 상세 패널은 오늘 탭과 같은 오른쪽 자리에 뜬다.

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

function renderProjects() {
  const listEl = document.getElementById('projectList');
  const body = document.getElementById('projectBody');
  if (!listEl || !body) return;
  const rows = uiProjectRows(wfProjects(), workflowData.items);
  if (!rows.some(row => row.key === projectKey)) projectKey = rows.length ? rows[0].key : null;

  listEl.replaceChildren();
  const head = document.createElement('div');
  head.className = 'd-rhd';
  const headName = document.createElement('span');
  headName.textContent = '프로젝트';
  const headCount = document.createElement('span');
  headCount.className = 'n num';
  headCount.textContent = rows.length;
  head.append(headName, headCount);
  listEl.appendChild(head);

  rows.forEach((row) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'd-prow' + (row.open ? '' : ' is-zero');
    button.setAttribute('aria-current', String(row.key === projectKey));
    const name = document.createElement('span');
    name.className = 'nm';
    name.textContent = row.label;
    name.title = row.label;
    const count = document.createElement('span');
    count.className = 'n num';
    count.textContent = row.open;
    button.append(name, count);
    button.addEventListener('click', () => {
      if (projectKey === row.key) return;
      projectKey = row.key;
      try { localStorage.setItem(PROJECT_KEY_STORE, row.key); } catch {}
      renderProjects();
    });
    listEl.appendChild(button);
  });

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

  const check = document.createElement('span');
  check.className = 'd-check';
  check.appendChild(taskCompletionCheckbox(item, row, false));
  check.insertAdjacentHTML('beforeend', '<svg class="d-tick" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 7.4 5.7 10.1 11 4.2"/></svg>');
  row.appendChild(check);

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

  const priority = document.createElement('span');
  const meta = UI_PRIORITY_META[item.priority];
  priority.className = 'pr' + (meta ? uiTone(meta.tone) : '');
  if (meta) priority.innerHTML = `<i class="d-dot"></i>${meta.text}`;
  row.appendChild(priority);

  const due = uiDueText(item.due, 'full');
  const deadline = document.createElement('span');
  deadline.className = 'dd' + (due ? uiTone(due.tone) : '');
  deadline.textContent = due ? due.text : '';
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
      mode === 'later' ? '오늘 할 일로 옮김' : '나중에 할 일로 옮김 · 기한은 그대로입니다.');
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

  const check = document.createElement('span');
  check.className = 'd-check';
  check.appendChild(taskCompletionCheckbox(item, row, true));
  check.insertAdjacentHTML('beforeend', '<svg class="d-tick" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 7.4 5.7 10.1 11 4.2"/></svg>');
  row.appendChild(check);

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
  return row;
}

// 확인 대기·결정·아이디어·회의처럼 값이 한두 개뿐인 구역은 같은 한 줄 모양을 쓴다.
function projectSimpleRow(text, meta, onOpen, id) {
  const row = document.createElement('div');
  row.className = 'd-rec' + (id && panelState && panelState.id === id ? ' is-sel' : '');
  if (id) row.dataset.taskId = id;
  const title = document.createElement('button');
  title.type = 'button';
  title.className = 'ti';
  title.textContent = text;
  title.title = text;
  title.setAttribute('aria-label', `${text} 상세 보기`);
  title.addEventListener('click', onOpen);
  const note = document.createElement('span');
  note.className = 'mt';
  note.textContent = meta || '';
  row.append(title, note);
  return row;
}

function renderProjectDetail(body, row) {
  body.replaceChildren();
  if (!row) {
    body.insertAdjacentHTML('beforeend', '<div class="d-empty">아직 프로젝트가 없습니다. 업무에 프로젝트를 지정하면 여기에 모입니다.</div>');
    return;
  }
  const items = workflowData.items.filter(item => wfKey(item) === row.key);
  const title = document.createElement('h2');
  title.className = 'd-ptitle';
  title.textContent = row.label;
  const summary = document.createElement('div');
  summary.className = 'd-quiet';
  summary.textContent = `열린 항목 ${row.open}`;
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
      '<div class="d-colhd"><span></span><span>언제 할지</span><span>업무</span><span class="r">우선순위</span><span class="r">기한</span></div>');
    open.forEach(item => surface.appendChild(projectTaskRow(item)));
    section.appendChild(surface);
    body.appendChild(section);
  }

  const simple = (label, list, meta, onOpen) => {
    if (!list.length) return;
    const section = projectSection(label, list.length);
    const surface = document.createElement('div');
    surface.className = 'd-psurf plain';
    list.forEach(entry => surface.appendChild(projectSimpleRow(entry.text, meta(entry.item), () => onOpen(entry.item), entry.id)));
    section.appendChild(surface);
    body.appendChild(section);
  };
  const asItems = list => list.map(item => ({ item, text: item.description, id: item.id }));
  const openPanel = item => panelOpen({ id: item.id });

  simple('확인 대기', asItems(items.filter(item => item.type === 'check' && item.status !== 'done')),
    item => item.who || (uiDueText(item.due, 'full')?.text ?? ''), openPanel);
  // 결정은 미반영·반영을 글자로만 가른다(알약으로 그리지 않는다).
  simple('결정', asItems(items.filter(item => item.type === 'decision')),
    item => item.status === 'done' ? `${uiKoDateShort(item.completed)} 반영` : '미반영', openPanel);
  simple('아이디어', asItems(items.filter(item => item.type === 'idea')),
    item => item.created ? `${uiKoDateShort(item.created)} 기록` : '', openPanel);

  const meetings = workflowData.meetings.filter(event => wfMeetingKey(event) === row.key || items.some(item => item.meetingId === event.id));
  simple('회의', meetings.map(event => ({ item: event, text: event.title, id: null })),
    event => event.date ? uiKoDateShort(event.date) : '', event => panelOpen({ kind: 'meeting', id: event.id }));

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
        announce('삭제한 항목을 복원했습니다.');
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
const STORAGE_BANNER_TEXT = '데이터를 지키기 위해 저장을 멈췄습니다. 지금까지의 기록은 그대로 있습니다. README의 "복구 필요 상태"를 따라 정리한 뒤 서버를 다시 시작해 주세요.';
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
      const failure = new Error(data?.error || (response.ok ? '저장하지 못했습니다.' : `요청 실패 (${response.status})`));
      failure.code = data?.code;
      throw failure;
    }
    if(retryKey)pendingRequestKeys.delete(retryKey);
    if (writing) recordUndoFor(url, JSON.parse(options.body || '{}'));
    if (url === '/api/track/remove' && !undoReplaying) lastRemovedId = JSON.parse(options.body).id;
    if (writing && !quiet) showNotice('저장했습니다.');
    return response;
  } catch (error) {
    error.reported = true;
    if (error.code === 'RECOVERY_NEEDED') {
      renderStorageBanner({ recoveryNeeded: true });
      showNotice(error.message, true);
    } else showNotice(writing ? '저장을 확인하지 못했습니다. 입력은 유지됩니다. 연결을 확인한 뒤 다시 시도해 주세요.' : '목록을 불러오지 못했습니다.', true, writing ? null : () => load());
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
    showNotice(direction === 'undo' ? '되돌릴 작업이 없습니다.' : '다시 실행할 작업이 없습니다.');
    return;
  }
  undoReplaying = true;
  try {
    await entry[direction]();
    to.push(entry);
    await load();
    showNotice(`${direction === 'undo' ? '되돌림' : '다시 실행'}${entry.label ? `: ${entry.label}` : ''}`);
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
  document.getElementById('decisionCount').textContent = (data.decisions || []).length;
  latestData = data;
  tabStale.projects = true; tabStale.records = true; tabStale.weekly = true;
  renderActiveTabLists();
  const hasNewRecord = [...(data.ideas || []), ...(data.decisions || [])].some(i => i.isNew);
  document.getElementById('tabBtnRecords').classList.toggle('has-new', hasNewRecord);
  document.getElementById('createdTodayCount').textContent = data.createdToday || 0;

  const todayIds = new Set((data.todayTasks || []).map(t => t.id));
  const reminders = [...(data.todayTasks || []), ...(data.laterTasks || [])]
    .filter(t => !todayIds.has(t.id) && t.status !== 'done' && t.due && diffDays(t.due) <= 1 && (t.priority === 'high' || t.priority === 'critical'))
    .sort((a, b) => diffDays(a.due) - diffDays(b.due));
  renderReminders(reminders);
  syncTaskDetail();
  palSync();
  taskSelectionRefresh();
}

// 열려 있지도 않은 탭의 카드를 load()마다 다시 만들 필요는 없다 — 숫자·NEW 표시는 그대로
// 갱신하고, 목록은 그 탭이 열려 있거나 열릴 때 만든다(새 자료가 오면 다시 만든다).
let latestData = null;
let activeTabKey = 'today';
const tabStale = { projects: true, records: true, weekly: true };
function renderActiveTabLists() {
  if (!latestData) return;
  if (activeTabKey === 'projects' && tabStale.projects) {
    tabStale.projects = false;
    renderProjects();
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
    // 누르면 환경설정의 `상태`가 열리고 그 자동화 줄이 밝혀진다 — "무슨 일인지"까지 한 번에.
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
      ? `${source.name} 자동 갱신이 ${source.lastSync} 이후 멈춰 있습니다. 목록이 최신이 아닐 수 있어요. 누르면 자세한 상태를 봅니다.`
      : `${source.name}를 아직 한 번도 가져오지 못했습니다. 누르면 자세한 상태를 봅니다.`;
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
    empty.textContent = calendar?.stale || !calendar?.lastSync ? '오늘 일정을 확인할 수 없습니다.' : '오늘 미팅 없음';
    list.appendChild(empty);
    return;
  }
  const now = nowHHMM();
  events.forEach(event => {
    const row = document.createElement('div');
    row.className = 'd-mrow' + (event.start <= now && now < (event.end || '99:99') ? ' is-now' : '');
    // 회의 정리 패널이 열리면 이 표식으로 찾아 `지금 보는 회의`를 표시한다.
    row.dataset.meetingId = event.workflowId || `${event.start || ''} ${event.title || ''}`;

    const time = document.createElement('span');
    time.className = 't num';
    time.textContent = event.start;
    row.appendChild(time);

    // 제목과 프로젝트는 한 줄에 둔다 — 제목 아래 또 한 줄을 깔면 레일이 금세 길어진다.
    const title = document.createElement('button');
    title.type = 'button';
    title.className = 'ti';
    title.textContent = event.title;
    title.title = event.project ? `${event.title} · ${event.project.label}` : event.title;
    title.setAttribute('aria-label', `${event.title} — 회의 정리`);
    if (event.project) {
      const project = document.createElement('span');
      project.className = 'pj';
      project.textContent = event.project.label;
      title.appendChild(project);
    }
    title.addEventListener('click', () => openMeetingPanel(event));
    row.appendChild(title);

    // 0은 찍지 않는다 — 검토할 초안이 있을 때와 관련 미완료가 있을 때만.
    const counts = [];
    if (event.draftCount) counts.push(`초안 ${event.draftCount}`);
    if (event.relatedCount) counts.push(`할 일 ${event.relatedCount}`);
    const count = document.createElement('span');
    count.className = 'ct num';
    count.textContent = counts.join(' · ');
    if (event.draftCount) count.title = 'AI가 분류한 초안을 검토해 주세요';
    row.appendChild(count);

    const setProject = async (projectKey) => {
      await request('/api/meeting/set-project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: event.title, project: projectKey }),
      });
    };
    const acts = document.createElement('span');
    acts.className = 'ac';
    acts.appendChild(uiMoreButton(`${event.title} — 더 보기`, () => [
      [{ label: '회의 정리 열기', onClick: () => openMeetingPanel(event) }],
      [{
        field: '프로젝트 연결',
        control: renderGroupControl({
          jira: event.project && event.project.type === 'jira' ? event.project.value : null,
          group: event.project && event.project.type === 'group' ? event.project.value : null,
          onSetJira: (key) => setProject(key ? `jira:${key}` : null),
          onSetGroup: (value) => setProject(value ? `group:${value}` : null),
        }),
      }],
    ]));
    row.appendChild(acts);

    list.appendChild(row);
  });
}


function suggestDismissedToday() {
  try { return localStorage.getItem('suggestDismissed') === todayStr(); } catch { return false; }
}

// 미루기 제안은 접힌 한 줄로 두고, 펼쳤을 때만 업무 줄을 들여 보여 준다.
// 근거는 알약으로 그리지 않는다(마감 없음·우선순위 낮음 같은 말은 새로 알려 주는 게 없다).
function renderSuggestions(suggestions) {
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
  toggle.innerHTML = uiIcon('chevron');
  const label = document.createElement('span');
  label.textContent = defer
    ? `오늘 ${data.total}개 — ${data.items.length}개 미룰까요?`
    : '오늘 이건 어때요?';
  toggle.appendChild(label);
  toggle.addEventListener('click', () => { suggestOpen = !suggestOpen; renderSuggestions(suggestions); });
  zone.appendChild(toggle);
  if (!suggestOpen) return;

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
    if (defer) { move('내일', tomorrowStr(), '내일로 미룸'); move('나중에', null, '나중에 할 일로 옮김'); }
    else move('오늘로', todayStr(), '오늘 할 일로 옮김');
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
    announce('오늘은 제안을 접어둡니다.');
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

// 레일의 리마인드 — 기한이 코앞인 높은 우선순위 업무만 온다(고르는 곳은 load()).
// 제목은 2줄까지 허용하고, 오른쪽에 `오늘까지`/`내일까지`를 의미색 글자로 적는다.
function renderReminders(reminders) {
  const zone = document.getElementById('reminderZone');
  const list = document.getElementById('reminderList');

  document.getElementById('reminderSectionCount').textContent = reminders.length;
  zone.hidden = reminders.length === 0;

  list.replaceChildren();
  reminders.forEach(item => list.appendChild(uiRailRow({
    id: item.id,
    text: item.description,
    wrap: true,
    selected: !!panelState && panelState.id === item.id,
    meta: [uiDueText(item.due)],
    onOpen: () => panelOpen({ id: item.id }),
  })));
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

let selectedWeekKey = null;
let weeklyReportsCache = [];

function renderWeeklyReports(items) {
  weeklyReportsCache = items;
  document.getElementById('weeklyReportCount').textContent = items.length;
  const nav = document.getElementById('weeklyReportNav');
  const detail = document.getElementById('weeklyReportDetail');

  if (!items.length) {
    nav.innerHTML = '';
    detail.innerHTML = '<div class="empty">주간 요약 없음</div>';
    selectedWeekKey = null;
    return;
  }

  if (!selectedWeekKey || !items.some(i => i.weekKey === selectedWeekKey)) {
    selectedWeekKey = items[0].weekKey;
  }

  nav.innerHTML = '';
  items.forEach(item => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'wr-nav-btn' + (item.weekKey === selectedWeekKey ? ' active' : '');
    const navLabel = formatWeekLabel(item.weekKey);
    btn.innerHTML = `<span class="wr-nav-week">${escapeHtml(navLabel.week)}</span><span class="wr-nav-range">${escapeHtml(navLabel.range)}</span>`;
    btn.setAttribute('aria-label', `${navLabel.week}, ${navLabel.range}`);
    btn.addEventListener('click', () => {
      selectedWeekKey = item.weekKey;
      renderWeeklyReports(weeklyReportsCache);
    });
    nav.appendChild(btn);
  });

  if (detail.contains(document.activeElement) && detail.dataset.weekKey === selectedWeekKey) return;

  const current = items.find(i => i.weekKey === selectedWeekKey);
  renderWeeklyReportDetail(current);
}

function renderWeeklyReportDetail(item) {
  // 보고 초안은 서버가 항상 붙여준다 — 없거나 보고 화면 스크립트가 없으면 상세를 비워둔다.
  if (!item || !item.draft || typeof renderReportDraft !== 'function') { document.getElementById('weeklyReportDetail').innerHTML = ''; return; }
  renderReportDraft(item);
}

// ---------- 아이디어·결정 탭 ----------
// 두 열(아이디어 | 결정)을 프로젝트로 묶어 한 줄씩 적는다. 두 종류 다 날짜 칸이 없다
// (DECISIONS: 마감일은 할 일에만). 결정만 `PRD 반영함` 체크가 있고, 아이디어는 더보기만 있다.

let decisionArchiveCache = [];
let decisionArchiveQuery = '';
let decisionArchiveOpen = false;

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

// 결정·아이디어 열 하나를 그린다: 프로젝트 그룹 제목(누르면 프로젝트 탭) + 그 아래 줄들.
// 그룹 제목이 이미 프로젝트를 말해 주므로 줄에는 프로젝트 이름을 되풀이하지 않는다.
function renderRecordColumn(list, items, row, emptyText) {
  list.replaceChildren();
  if (!items.length) {
    list.insertAdjacentHTML('beforeend', `<div class="d-empty">${emptyText}</div>`);
    return;
  }
  uiGroupTasks(items).forEach(([key, group]) => {
    list.appendChild(uiGroupHeading(uiGroupLabel(key), group.length,
      key === '__misc__' ? {} : { onOpenProject: () => openProjectTab(key) }));
    group.forEach(item => list.appendChild(row(item)));
  });
}

function renderDecisions(items) {
  document.getElementById('decisionSectionCount').textContent = items.length;
  renderRecordColumn(document.getElementById('decisionList'), items,
    item => recordDecisionRow(item, false), '정해진 내용이 아직 없습니다. 위 첫 줄에서 바로 추가하세요.');
}

function renderIdeas(items) {
  document.getElementById('ideaCount').textContent = items.length;
  renderRecordColumn(document.getElementById('ideaList'), items,
    recordIdeaRow, '아이디어가 아직 없습니다. 위 첫 줄에서 바로 적어 두세요.');
}

// 결정 열 아래 접힌 구역. 펼치면 위에 작은 검색 입력이 함께 보인다.
function renderDecisionArchive() {
  const toggle = document.getElementById('decisionArchiveToggle');
  const body = document.getElementById('decisionArchiveBody');
  const list = document.getElementById('decisionArchiveList');
  if (!toggle || !body || !list) return;
  const items = decisionArchiveCache.filter(item => recordArchiveMatch(item, decisionArchiveQuery, decisionJiraSummary(item)));
  document.getElementById('decisionArchiveCount').textContent = items.length;
  toggle.setAttribute('aria-expanded', String(decisionArchiveOpen));
  body.hidden = !decisionArchiveOpen;
  list.replaceChildren();
  if (!decisionArchiveOpen) return;
  if (!items.length) {
    list.insertAdjacentHTML('beforeend', `<div class="d-empty">${decisionArchiveQuery ? '일치하는 결정 없음' : '반영 완료한 결정 없음'}</div>`);
    return;
  }
  items.forEach(item => list.appendChild(recordDecisionRow(item, true)));
}

// 결정 한 줄: PRD 반영 체크 | 문구(눌러서 그 자리 수정) | 반영 날짜 | hover 더보기.
function recordDecisionRow(item, archived) {
  const row = document.createElement('div');
  row.className = 'd-rec is-dec' + (archived ? ' is-done' : '');
  // 검색 팔레트가 이 줄을 찾아 옮겨 갈 수 있게 표식을 남긴다.
  row.dataset.itemId = item.id;

  const check = document.createElement('span');
  check.className = 'd-check';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.className = 'd-cb';
  box.checked = archived;
  box.title = 'PRD 반영함으로 표시';
  box.setAttribute('aria-label', `${item.description} — PRD 반영함으로 표시`);
  box.addEventListener('change', () =>
    fadeOutAndRun(row, () => toggleTask(item.id), archived ? 'PRD 미반영으로 되돌림' : 'PRD 반영함으로 표시함')
  );
  check.appendChild(box);
  check.insertAdjacentHTML('beforeend', '<svg class="d-tick" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 7.4 5.7 10.1 11 4.2"/></svg>');
  row.appendChild(check);

  const title = document.createElement('span');
  title.className = 'ti';
  title.textContent = item.description;
  if (!archived) makeEditableDesc(title, item);
  // 말줄임으로 잘린 문구도 마우스를 올리면 전부 읽을 수 있게(수정 안내는 aria-label이 한다).
  title.title = item.description;
  if (item.isNew && !archived) { title.prepend(renderNewDot(item)); observeNewItem(row, item); }
  row.appendChild(title);

  const meta = document.createElement('span');
  meta.className = 'mt';
  meta.textContent = archived && item.completed ? `${uiKoDateShort(item.completed)} 반영` : '';
  row.appendChild(meta);

  if (!archived) {
    const acts = document.createElement('span');
    acts.className = 'ac';
    acts.appendChild(uiMoreButton(`${item.description} — 더 보기`, () => [
      [{ field: '프로젝트', control: taskProjectControl(item) }],
      [{ label: '삭제', danger: true, onClick: () => removeTracked(item, row) }],
    ]));
    row.appendChild(acts);
  }
  return row;
}

// 아이디어 한 줄: 체크박스 없이 문구 | `가능성 높음` | hover 더보기.
function recordIdeaRow(item) {
  const row = document.createElement('div');
  row.className = 'd-rec is-idea';
  row.dataset.itemId = item.id;

  const title = document.createElement('span');
  title.className = 'ti';
  title.textContent = item.description;
  title.title = item.description;
  if (item.isNew) { title.prepend(renderNewDot(item)); observeNewItem(row, item); }
  row.appendChild(title);

  const meta = document.createElement('span');
  meta.className = 'mt';
  meta.textContent = ideaChanceText(item);
  row.appendChild(meta);

  const promote = async (due) => {
    await postJson('/api/idea/promote', { id: item.id, due });
    await load();
  };
  const acts = document.createElement('span');
  acts.className = 'ac';
  acts.appendChild(uiMoreButton(`${item.description} — 더 보기`, () => [
    [
      { label: '오늘로 옮기기', onClick: () => fadeOutAndRun(row, () => promote(todayStr()), '오늘 할 일로 옮김') },
      {
        field: '날짜 정해서 옮기기',
        control: uiDateField({
          value: '',
          label: '옮길 날짜',
          clearable: false,
          onChange: (value) => { if (value) fadeOutAndRun(row, () => promote(value), '할 일로 옮김'); },
        }),
      },
      { label: '완료로 표시', onClick: () => fadeOutAndRun(row, () => toggleTask(item.id), '완료로 표시함') },
      { field: '가능성', control: ideaChanceControl(item) },
      { field: '프로젝트', control: ideaProjectControl(item) },
    ],
    [{ label: '삭제', danger: true, onClick: () => removeTracked(item, row) }],
  ]));
  row.appendChild(acts);
  return row;
}

// 가능성은 우선순위와 같은 값을 쓰되(`/api/track/set-priority`) 이름만 다르게 부른다.
const IDEA_CHANCE_CHIPS = [['high', '높음'], ['medium', '보통'], ['low', '낮음']];
function ideaChanceControl(item) {
  return uiMenuChips(IDEA_CHANCE_CHIPS, item.priority || 'medium', async (value) => {
    uiMenuClose();
    await setPriority(item.id, value);
    announce('가능성을 바꿨습니다.');
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
      announce(project ? '프로젝트 지정함' : '프로젝트 해제함');
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
    announce('정책/얼라인에 남겼습니다. 아이디어·결정 탭에서 내용을 다듬을 수 있어요.');
  } catch { if (button) button.disabled = false; }
}

function offerDecisionFromWaiting(item) {
  showNotice('확인 완료로 표시함', false, null, {
    label: '결정으로 남기기',
    onClick: (button) => createDecisionFromWaiting(item, button),
  });
}

// 확인 요청을 오늘 다시 보냈다는 기록. 다시 확인할 날짜는 건드리지 않는다.
async function markContactedToday(item) {
  const detail = typeof wfItem === 'function' ? wfItem(item.id) : null;
  await postJson('/api/workflow/item', { id: item.id, contacted: todayStr(), followUp: detail?.followUp || null });
  await load();
  announce('확인 요청을 기록했습니다.');
}

async function setTaskWho(id, who) {
  await postJson('/api/track/set-who', { id, who: who || null });
  announce(who ? '누구에게 수정함' : '누구에게 해제함');
  await load();
}

// 줄·상세 어디서 지우든 같은 길: 휴지통으로 보내고(원문 보존) 알림의 `삭제 실행 취소`로 되돌린다.
function removeTracked(item, card, message = '삭제함') {
  return fadeOutAndRun(card, async () => {
    await postJson('/api/track/remove', { id: item.id });
    await load();
  }, message);
}

// 확인 대기 줄·상세의 더보기. 용어는 화면 어디서나 같다(회신 기한 = 상대에게 받아야 하는 기한).
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
            announce(value ? `${uiKoDate(value)}에 다시 확인` : '다시 확인할 날짜 해제함');
            await load();
          },
        }),
      },
      {
        field: '회신 기한',
        control: uiDateField({
          value: item.due,
          label: '회신 기한',
          onChange: async (value) => {
            await setTaskDue(item.id, value);
            announce(value ? `회신 기한 ${uiKoDate(value)}로 지정함` : '회신 기한 해제함');
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

// 확인 대기 정렬: 회신 기한이 있는 것이 먼저(빠른 기한 순), 그 다음 먼저 등록한 순.
// 화면을 만지지 않는 순수 함수라 테스트가 직접 부른다.
function waitingOrder(items) {
  return [...items].sort((a, b) => {
    if (a.due && b.due) return a.due < b.due ? -1 : a.due > b.due ? 1 : 0;
    if (a.due) return -1;
    if (b.due) return 1;
    return (a.created || '') < (b.created || '') ? -1 : (a.created || '') > (b.created || '') ? 1 : 0;
  });
}

// 며칠째 기다리는지. STALE_WAITING_DAYS(3)일째부터 주의색으로 눈에 띄게 한다.
function waitingAgeText(created, today) {
  if (!created) return null;
  const days = Math.round((new Date(`${today}T00:00:00`) - new Date(`${created}T00:00:00`)) / 86400000);
  if (!Number.isFinite(days) || days <= 0) return { text: '오늘', tone: '' };
  return { text: `${days}일째`, tone: days >= STALE_WAITING_DAYS ? 'warn' : '' };
}

function renderWaiting(items) {
  document.getElementById('waitingCount').textContent = items.length;
  document.getElementById('waitingSectionCount').textContent = items.length;
  const list = document.getElementById('waitingList');
  list.replaceChildren();

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'd-rempty';
    empty.textContent = '확인 대기중 없음';
    list.appendChild(empty);
    return;
  }
  waitingOrder(items).forEach(item => list.appendChild(renderWaitingRow(item)));
}

// 레일의 확인 대기 한 줄: 체크(확인됨) | 제목 | `누구에게 · N일째`. 값 수정은 더보기·상세가 맡는다.
function renderWaitingRow(item) {
  const done = item.status === 'done';
  const detail = typeof wfItem === 'function' ? wfItem(item.id) : null;

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'd-wcb';
  checkbox.checked = done;
  checkbox.setAttribute('aria-label', `${item.description} — 확인 완료로 표시`);

  // 회신 기한이 있으면 기한 말투가 먼저다(`2일 지남`·`오늘까지`). 없으면 며칠째 기다리는지.
  const status = uiDueText(item.due, 'row') || waitingAgeText(item.created, todayStr());
  const sub = detail?.followUp
    ? `${uiKoDateShort(detail.followUp)} 다시 확인`
    : detail?.contacted === todayStr() ? '오늘 요청함' : '';

  const row = uiRailRow({
    id: item.id,
    text: item.description,
    check: checkbox,
    selected: !!panelState && panelState.id === item.id,
    badge: item.isNew && !done ? renderNewDot(item) : null,
    meta: [item.who ? { text: item.who, strong: true } : null, status],
    sub,
    more: done ? null : uiMoreButton(`${item.description} — 더 보기`, () => waitingMenuSections(item, row)),
    onOpen: () => panelOpen({ id: item.id }),
  });
  if (done) row.classList.add('is-done');
  if (item.isNew && !done) observeNewItem(row, item);

  checkbox.addEventListener('change', () =>
    fadeOutAndRun(row, async () => {
      await toggleTask(item.id);
      // 확인이 끝난 내용은 그대로 두면 사라진다 — 알림에서 바로 결정으로 남길 수 있게 한다.
      if (!done) offerDecisionFromWaiting(item);
    }, done ? '대기중으로 되돌림' : null)
  );
  return row;
}

function renderLaterTasks(items) {
  document.getElementById('laterTaskSectionCount').textContent = items.length;
  document.getElementById('laterDrawerCount').textContent = items.length;
  const list = document.getElementById('laterTaskList');
  list.replaceChildren();
  list.classList.toggle('d-list', items.length > 0);
  if (!items.length) {
    list.innerHTML = '<div class="d-empty">나중에 할 일이 없습니다.</div>';
    return;
  }

  uiGroupTasks(items).forEach(([key, groupItems]) => {
    const addRow = uiGroupAddRow(key, '/api/later-task/create', '나중에 할 일 추가함');
    const heading = uiGroupHeading(uiGroupLabel(key), groupItems.length, {
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
  // 서랍이 열리고 닫히면 상세 패널이 열 안과 밖을 오간다 — 자리를 다시 잡아 준다.
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
  checkbox.className = 'd-cb';
  checkbox.checked = done;
  checkbox.setAttribute('aria-label', `${item.description} — 완료로 표시`);
  checkbox.addEventListener('change', () =>
    fadeOutAndRun(card, async () => { await toggleTask(item.id); if (!done) workflowOutcome(item); }, done ? '미완료로 되돌림' : null)
  );
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
  const options = [['오늘', todayStr(), '오늘 할 일로 옮김'], ['내일', tomorrowStr(), '내일로 미룸']];
  // 이미 나중에 있는 업무에 `나중에`를 또 보여 주지 않는다.
  if (mode !== 'later') options.push(['나중에', null, '나중에 할 일로 옮김 · 기한은 그대로입니다.']);
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
    input.addEventListener('change', () => { if (input.value) move(input.value, `${uiKoDate(input.value)}로 옮김`); });
    wrap.replaceChildren(input);
    input.focus();
    input.showPicker?.();
  });
  wrap.appendChild(pick);
  return wrap;
}

const TASK_PRIORITY_CHIPS = [['critical', '긴급'], ['high', '높음'], ['medium', '보통'], ['low', '낮음']];
function taskPriorityControl(item) {
  return uiMenuChips(TASK_PRIORITY_CHIPS, item.priority || 'medium', async (value) => {
    uiMenuClose();
    await setPriority(item.id, value);
    announce('우선순위를 바꿨습니다.');
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
    onClick: () => fadeOutAndRun(card, () => toggleTask(item.id), '완료로 표시함'),
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
            announce(value ? `기한 ${uiKoDate(value)}로 지정함` : '기한 해제함');
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
// 회의 정리는 업무 상세와 같은 오른쪽 패널에서 연다(panelMeeting). 여기서는 레일의 미팅 줄이
// 가리키는 회의를 흐름 기록에서 찾아 넘기기만 한다. 아직 기록되지 않은 캘린더 회의는
// 회의 자체를 그대로 넘겨 "직접 담기"만 있는 패널을 띄운다.
function openMeetingPanel(event) {
  const recorded = workflowData.meetings.find(meeting => meeting.date === todayStr() && meeting.start === event.start && meeting.title === event.title);
  if (recorded) { panelOpen({ kind: 'meeting', id: recorded.id }); return; }
  panelOpen({ kind: 'meeting', event });
}

// ---------- 오른쪽 상세 패널 (업무 · 확인 대기 한 벌) ----------
// 어디서 열든(오늘 목록·나중 목록·리마인드·검색·프로젝트·회의) 같은 자리에 같은 모양으로 연다.
// 저장 버튼은 없다 — 값이 바뀔 때 저장하고, 맨 아래에 "자동으로 저장됩니다"라고 적는다.

let panelState = null;

// 패널은 오늘 탭과 프로젝트 탭에 같은 자리로 하나씩 있다. 연 탭의 자리를 끝까지 쓴다
// (탭을 옮겨도 열어 둔 상세는 그 탭에 그대로 남아 있다).
function panelSide() { return document.getElementById(panelState?.host === 'projects' ? 'projectDetailPanel' : 'taskDetailPanel'); }
function panelZone() { return document.getElementById(panelState?.host === 'projects' ? 'projectZone' : 'todayTaskZone'); }

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
  // 패널 자리가 있는 탭은 오늘·프로젝트 둘이다 — 다른 탭에서 열면 오늘로 옮긴다.
  if (typeof setActiveTab === 'function' && activeTabKey !== 'today' && activeTabKey !== 'projects') setActiveTab('today');
  const host = activeTabKey === 'projects' ? 'projects' : 'today';
  if (!document.getElementById(host === 'projects' ? 'projectDetailPanel' : 'taskDetailPanel')) return;
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
  };
  // Esc는 가장 위에 열린 것부터 닫는다 — 다시 열면 맨 위로 올린다.
  escDrop(panelClose);
  escPush(panelClose);
  panelRender(true);
}

function panelClose() {
  const side = panelSide();
  const zone = panelZone();
  const back = panelState?.returnFocus;
  let reopen = panelState?.back;
  panelState = null;
  escDrop(panelClose);
  if (zone) zone.classList.remove('task-detail-open', 'meeting-open');
  document.querySelectorAll('.is-sel[data-task-id], .d-mrow.is-sel').forEach(row => row.classList.remove('is-sel'));
  if (side) { side.hidden = true; side.replaceChildren(); side.style.minHeight = ''; }
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

// 누른 줄 높이에 맞춰 연다. 좁은 화면에서는 오른쪽 고정 패널·아래 시트라 자리를 계산하지 않는다.
function panelPlace(box) {
  const side = panelSide();
  if (!side || !box || !panelState) return;
  box.style.top = '';
  side.style.minHeight = '';
  // 좁은 화면이거나 서랍이 열려 있으면 패널이 열 밖에 떠 있으므로(ui.css) 자리를 계산하지 않는다.
  if (window.innerWidth <= 1120 || laterDrawerOpen) return;
  const row = document.querySelector(`${panelAnchorSelector()}`);
  let top = 10;
  if (row) {
    const offset = row.getBoundingClientRect().top - side.getBoundingClientRect().top - 6;
    if (Number.isFinite(offset)) top = Math.max(10, offset);
  }
  box.style.top = `${Math.round(top)}px`;
  // 패널은 자리에서 떠 있으므로(absolute) 열 높이가 모자라면 아랫 내용과 겹친다 — 열을 늘려 둔다.
  side.style.minHeight = `${Math.round(top + box.offsetHeight + 10)}px`;
}

function panelRender(focusFirst = false) {
  const side = panelSide();
  const zone = panelZone();
  if (!side || !zone || !panelState) return;
  const meeting = panelState.kind === 'meeting' ? panelMeetingEvent() : null;
  const found = panelState.kind === 'meeting' ? null : panelResolve(panelState.id);
  if (!meeting && !found) { panelClose(); return; }
  zone.classList.add('task-detail-open');
  zone.classList.toggle('meeting-open', !!meeting);
  side.hidden = false;
  const box = document.createElement('div');
  box.className = 'd-detail';
  if (meeting) panelMeeting(meeting, box);
  else if (found.kind === 'check') panelCheck(found, box);
  else panelTask(found, box);
  side.replaceChildren(box);
  const marked = panelState.kind === 'meeting'
    ? panelAnchorSelector()
    : `[data-task-id="${CSS.escape(String(panelState.id))}"], .d-wrow[data-rail-id="${CSS.escape(String(panelState.id))}"]`;
  document.querySelectorAll('.is-sel[data-task-id], .d-wrow.is-sel, .d-mrow.is-sel').forEach(row => row.classList.remove('is-sel'));
  document.querySelectorAll(marked).forEach(row => row.classList.add('is-sel'));
  panelPlace(box);
  if (focusFirst) {
    // 회의 정리는 고칠 제목이 없다 — 검토할 초안이 없을 때만 직접 담기 입력으로 보낸다.
    const first = meeting ? (box.querySelector('.d-dcap input') || box) : box.querySelector('.d-dtitle');
    first?.focus?.();
    box.scrollIntoView?.({ block: 'nearest' });
  }
}

// load()가 끝날 때마다 불린다. 패널 안에서 타이핑하는 중이면 다시 그리지 않는다
// (적던 글·고치던 초안 문구가 날아가지 않게. 고친 초안은 wfDraftEdits에도 남는다).
function syncTaskDetail() {
  if (!panelState) return;
  if (panelState.kind !== 'meeting' && !panelResolve(panelState.id)) { panelClose(); return; }
  const side = panelSide();
  if (side && isTyping() && side.contains(document.activeElement)) return;
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

function panelSection(title) {
  const section = document.createElement('div');
  section.className = 'd-dsec';
  const label = document.createElement('span');
  label.className = 'lbl';
  label.textContent = title;
  section.appendChild(label);
  return section;
}

function panelAutosaveNote(box) {
  const note = document.createElement('div');
  note.className = 'd-autosave';
  note.textContent = '자동으로 저장됩니다';
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
    if (item.permalink) {
      actions.push({ label: '슬랙 원문', onClick: () => window.open(item.permalink, '_blank', 'noopener') });
      actions.push({ label: '원본 링크 복사', onClick: () => panelCopyLink(item.permalink) });
    }
    return [actions, [{
      label: '삭제',
      danger: true,
      onClick: async () => {
        panelClose();
        await postJson('/api/track/remove', { id: item.id });
        await load();
        announce('삭제함');
      },
    }]];
  }));

  const fields = document.createElement('dl');
  fields.className = 'd-fields';
  panelField(fields, '언제 할지', panelWhenText(item, mode));
  if (isTask) panelField(fields, '기한', panelDateCell('기한', item.due, async (value) => {
    await setTaskDue(item.id, value);
    announce(value ? `기한 ${uiKoDate(value)}로 지정함` : '기한 해제함');
  }));
  panelField(fields, '우선순위', panelPriorityCell(item));
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
      announce('오늘 할 일로 옮김');
    }));
    else {
      foot.appendChild(panelQuietButton('내일', async () => {
        await setTaskScheduled(item.id, tomorrowStr());
        announce('내일로 미룸');
      }));
      foot.appendChild(panelQuietButton('나중에', async () => {
        await setTaskScheduled(item.id, null);
        announce('나중에 할 일로 옮김 · 기한은 그대로입니다.');
      }));
    }
  }
  const itemProject = typeof wfKey === 'function' ? wfKey(item) : null;
  if (itemProject) foot.appendChild(panelQuietButton('프로젝트 보기', () => openProjectTab(itemProject)));
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
    cell.innerHTML = `<i class="d-dot"></i>${meta.text}`;
  } else {
    cell.className = 'k-mute';
    cell.textContent = item.priority === 'low' ? '낮음' : '보통';
  }
  return cell;
}

function panelCopyLink(permalink) {
  const done = () => announce('원본 링크를 복사했습니다.');
  try {
    const copy = navigator.clipboard?.writeText(permalink);
    if (copy && copy.then) copy.then(done, () => announce('복사하지 못했습니다. 링크를 길게 눌러 복사해 주세요.'));
    else done();
  } catch { announce('복사하지 못했습니다. 링크를 길게 눌러 복사해 주세요.'); }
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
    gone.textContent = '연결했던 확인 대기가 삭제되었습니다.';
    waiting.appendChild(gone);
  }
  box.appendChild(waiting);

  const result = panelSection('결과 한 줄');
  const area = document.createElement('textarea');
  area.className = 'd-din';
  area.rows = 2;
  area.maxLength = 1000;
  area.value = current.outcome;
  area.placeholder = '끝나고 한 줄로 남기면 주간요약에 그대로 올라갑니다';
  area.setAttribute('aria-label', '결과 한 줄');
  area.addEventListener('change', () => { current.outcome = area.value.replace(/[\r\n]+/g, ' ').trim(); save(); });
  result.appendChild(area);
  box.appendChild(result);
}

function panelCheck({ item, detail }, box) {
  const done = item.status === 'done';
  panelBackLink(box);
  box.appendChild(panelHead(item, () => waitingMenuSections(item, box)));

  const fields = document.createElement('dl');
  fields.className = 'd-fields';
  panelField(fields, '누구에게', uiMenuText({
    value: item.who,
    label: '누구에게',
    placeholder: '이름',
    onChange: (who) => setTaskWho(item.id, who),
  }));
  // 확인 대기의 기한은 "상대에게 회신을 받아야 하는 날"이다 — 화면 이름을 그렇게 적는다.
  panelField(fields, '회신 기한', panelDateCell('회신 기한', item.due, async (value) => {
    await setTaskDue(item.id, value);
    announce(value ? `회신 기한 ${uiKoDate(value)}로 지정함` : '회신 기한 해제함');
  }));
  panelField(fields, '다시 확인할 날짜', panelDateCell('다시 확인할 날짜', detail?.followUp, async (value) => {
    await postJson('/api/workflow/item', { id: item.id, followUp: value });
    announce(value ? `${uiKoDate(value)}에 다시 확인` : '다시 확인할 날짜 해제함');
    await load();
  }, false));
  panelField(fields, '프로젝트', taskProjectControl(item));
  box.appendChild(fields);

  const foot = document.createElement('div');
  foot.className = 'd-dfoot';
  if (done) foot.appendChild(panelQuietButton('대기중으로 되돌리기', () => toggleTask(item.id)));
  else foot.appendChild(panelQuietButton('확인됨으로 표시', async () => {
    await toggleTask(item.id);
    panelClose();
    offerDecisionFromWaiting(item);
  }, 'd-btn pri'));
  // 확인이 끝난 내용을 남길지는 늘 고를 수 있어야 한다(알림이 사라진 뒤에도).
  foot.appendChild(panelQuietButton('결정으로 남기기', () => createDecisionFromWaiting(item)));
  box.appendChild(foot);

  const log = panelSection('확인 요청 기록');
  const line = document.createElement('div');
  line.className = detail?.contacted ? 'd-logline' : 'd-hint';
  line.textContent = detail?.contacted ? `${uiKoDate(detail.contacted)} 요청함` : '아직 없습니다.';
  log.appendChild(line);
  log.appendChild(panelQuietButton('오늘 확인 요청함', () => markContactedToday(item), 'd-btn sm'));
  box.appendChild(log);

  panelAutosaveNote(box);
}

// ---------- 회의 정리 패널 ----------
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
  const project = event.project ? event.project.label || event.project.value : '';
  return [[day, time].filter(Boolean).join(' '), project].filter(Boolean).join(' · ');
}

// 패널 안에서 저장이 실패한 자리를 그 자리에 적는다(알림은 request가 따로 띄운다).
function panelSetError(text) {
  const region = panelSide()?.querySelector('.d-derr');
  if (region) region.textContent = text || '';
}

// 누르면 도는 버튼 — 도는 동안 꺼지고, 실패하면 패널 안에 이유를 적는다.
function panelRunButton(text, action, className = 'd-btn') {
  return panelQuietButton(text, async () => {
    panelSetError('');
    try { await action(); } catch (error) {
      panelSetError((typeof error?.message === 'string' && error.message) || '저장하지 못했습니다. 입력 내용을 확인하고 다시 시도해 주세요.');
    }
  }, className);
}

function panelMeeting(event, box) {
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
    note.textContent = (event.tiroNotes.length > 1) ? `티로 노트 ${index + 1}` : '티로 노트';
    when.append(' · ', note);
  });
  head.append(title, when);
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'd-iconbtn';
  close.setAttribute('aria-label', '회의 정리 닫기');
  close.innerHTML = uiIcon('close');
  close.addEventListener('click', panelClose);
  top.append(head, close);
  box.appendChild(top);

  const error = document.createElement('p');
  error.className = 'd-derr';
  error.setAttribute('role', 'alert');
  box.appendChild(error);

  if (!linked) {
    const note = document.createElement('div');
    note.className = 'd-hint';
    note.textContent = '아직 기록되지 않은 회의입니다. 여기서 적은 것은 회의에 연결되지 않고 바로 담깁니다.';
    box.appendChild(note);
  }
  if (linked) {
    panelMeetingResult(event, box);
    if (event.drafts && event.drafts.length) panelMeetingDrafts(event, box);
    panelMeetingItems(event, box);
    panelMeetingPast(event, box);
  }
  panelMeetingCapture(event, box, linked);
  if (linked) panelMeetingLink(event, box);
}

// 방금 초안을 담은 결과: 어디로 갔는지, 나중에 담긴 할 일을 오늘로, 되돌리기, 다음 검토할 회의.
function panelMeetingResult(event, box) {
  const result = panelState.result;
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
    if (!undo.ok) throw new Error(undo.error || '되돌리지 못했습니다.');
    // 되돌린 초안은 검토 대기로 돌아온다 — 사람이 고쳐 둔 문구·종류·날짜는 그대로 살려 둔다.
    result.accepted.forEach(item => wfDraftEdits.set(item.id, { type: item.type, description: item.description, when: item.when || 'later', due: item.due || '' }));
    panelState.result = null;
    await load();
    panelRender();
    announce('담은 것을 되돌렸습니다.');
  }, 'd-btn sm'));
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
      : panelRunButton('오늘로', () => panelPromoteTasks(result, [task.itemId]), 'd-btn sm')));
  } else if (tasks.length) {
    taskRow(later.length ? `나중에 담긴 할 일 ${later.length}개` : `할 일 ${tasks.length}개`, later.length
      ? panelRunButton('모두 오늘로', () => panelPromoteTasks(result, later.map(task => task.itemId)), 'd-btn sm')
      : doneNote());
  }

  const next = wfNextReview(event.id);
  const foot = document.createElement('div');
  foot.className = 'nx';
  if (next) foot.appendChild(panelRunButton(`다음: ${next.title} (초안 ${next.drafts.length}) →`,
    () => panelOpen({ kind: 'meeting', id: next.id, back: panelState?.back }), 'd-link'));
  else {
    const all = document.createElement('span');
    all.className = 'k-mute';
    all.textContent = '오늘 검토할 초안을 모두 처리했습니다.';
    foot.appendChild(all);
  }
  card.appendChild(foot);
  box.appendChild(card);
}

// 나중에 담긴 할 일을 오늘 할 일로 올린다(패널이 결과를 보여 주니 저장 알림은 끈다).
async function panelPromoteTasks(result, ids) {
  for (const itemId of ids) {
    await request('/api/track/set-scheduled', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: itemId, scheduled: todayStr() }), quiet: true });
    (result.promoted ||= []).push(itemId);
  }
  await load();
  panelRender();
}

// AI가 분류한 초안. 읽는 순서대로 문구(주인공) → 고르는 것들(종류·시점·날짜),
// 담기 바는 패널 아래에 붙어 있다. 고친 문구·종류는 wfDraftEdits에 남아 다시 그려도 유지된다.
function panelMeetingDrafts(event, box) {
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
      panelRender();
    }, 'd-iconbtn sm x');
    dismiss.innerHTML = uiIcon('close');
    dismiss.setAttribute('aria-label', `빼기: ${edit.description}`);
    dismiss.title = '이 초안 빼기';

    const controls = document.createElement('div');
    controls.className = 'ct';
    const whenSeg = wfSegment([['later', '나중에 할 일'], ['today', '오늘 할 일']], edit.when || 'later', (key) => { edit.when = key; refreshSummary(); }, '언제 할 일로 담을까');
    whenSeg.title = '나중: 나중에 할 일로 담김 · 오늘: 오늘 할 일로 담김';
    const dateSlot = document.createElement('span');
    const syncWhen = () => { whenSeg.hidden = edit.type !== 'task'; };
    const syncDate = () => {
      dateSlot.replaceChildren();
      const label = wfDateLabel(edit.type); // 할 일 → 마감일 · 확인 대기 → 회신 기한 · 결정 → 날짜 없음
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
    if (accept.some(item => !item.description)) { panelSetError('비어 있는 문구가 있습니다. 채우거나 ✕로 빼 주세요.'); return; }
    const result = await wfReview({ meetingId: event.id, accept });
    panelState.result = { meetingId: event.id, created: result.created, accepted: accept };
    accept.forEach(item => wfDraftEdits.delete(item.id));
    await load();
    panelRender(); // 결과 카드(role=status)가 담은 결과를 알려 주므로 따로 알림을 띄우지 않는다
  }, 'd-btn pri'));
  box.appendChild(bar);
  refreshSummary();
}

// 항목 한 줄: 종류 | 문구 | 기한·상태. 기본 상태(미완료)는 모든 줄에 반복되니 적지 않는다.
function panelMeetingItemState(item) {
  if (item.status === 'done') return { text: '완료', tone: '' };
  const blocker = typeof wfItem === 'function' && item.blockedBy ? wfItem(item.blockedBy) : null;
  if (blocker && blocker.status !== 'done') return { text: '답변 대기', tone: 'warn' };
  const due = uiDueText(item.due, 'full');
  if (due) return due;
  if (item.doing) return { text: '진행 중', tone: '' };
  return null;
}

function panelMeetingRow(item, event, stateText) {
  const row = document.createElement('div');
  row.className = 'd-mrow2' + (item.status === 'done' ? ' is-done' : '');
  const tag = document.createElement('span');
  tag.className = 'tg';
  tag.textContent = wfType(item.type);
  // 업무·확인 대기는 같은 패널에서 상세를 연다(결정·아이디어는 상세가 없다).
  const openable = ['task', 'bug', 'check'].includes(item.type);
  const title = document.createElement(openable ? 'button' : 'span');
  title.className = 'ti';
  title.title = item.description;
  title.textContent = item.description;
  if (openable) {
    title.type = 'button';
    title.setAttribute('aria-label', `${item.description} 상세 보기`);
    title.addEventListener('click', () => panelOpen({
      id: item.id,
      back: { kind: 'meeting', id: event.id, event: event.id ? null : event, result: panelState?.result, back: panelState?.back },
    }));
  }
  const state = document.createElement('span');
  state.className = 'st';
  if (stateText) state.textContent = stateText;
  else {
    const meta = panelMeetingItemState(item);
    if (meta) { state.className = `st${uiTone(meta.tone)}`; state.textContent = meta.text; }
  }
  row.append(tag, title, state);
  return row;
}

function panelMeetingItems(event, box) {
  const typeRank = (item) => { const rank = ['task', 'bug', 'check', 'decision'].indexOf(item.type); return rank < 0 ? 9 : rank; };
  const items = [...wfMeetingItems(event.id)].sort((a, b) => typeRank(a) - typeRank(b));
  if (!items.length) return;
  const section = panelSection(`이 회의에서 나온 것 ${items.length}`);
  items.forEach(item => section.appendChild(panelMeetingRow(item, event)));
  box.appendChild(section);
}

// 같은 이름으로 반복되는 회의라면, 지난 회차에서 아직 안 끝난 것을 여기서 같이 본다.
function panelMeetingPast(event, box) {
  if (!event.series) return;
  const meetings = (typeof workflowData === 'object' && workflowData ? workflowData.meetings : null) || [];
  const past = meetings
    .filter(other => other.id !== event.id && other.series === event.series && (other.date || '') < (event.date || ''))
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const rows = [];
  past.forEach(other => wfMeetingItems(other.id).filter(item => item.status !== 'done').forEach(item => rows.push({ item, at: other.date })));
  if (!rows.length) return;
  const section = panelSection(`이전 회차의 미해결 항목 ${rows.length}`);
  rows.forEach(({ item, at }) => section.appendChild(panelMeetingRow(item, event, `${uiKoDateShort(at)} 회차`)));
  box.appendChild(section);
}

// 직접 적어 담기 — 검토할 초안이 있으면 접어 두고(주 흐름은 검토 → 담기), 없을 때만 펼친다.
function panelMeetingCapture(event, box, linked) {
  const section = document.createElement('details');
  section.className = 'd-dsec d-dadd';
  section.open = !(event.drafts && event.drafts.length);
  const label = document.createElement('summary');
  label.className = 'lbl';
  label.textContent = '직접 적어 담기';
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
    panelSetError('');
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
        if (!result.ok) throw new Error(result.error || '담지 못했습니다.');
      }
      await load();
      panelRender();
    } catch {
      panelSetError('추가하지 못했습니다. 입력 내용은 유지됩니다.');
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
function panelMeetingLink(event, box) {
  const key = typeof wfMeetingKey === 'function' ? wfMeetingKey(event) : null;
  const items = (typeof workflowData === 'object' && workflowData ? workflowData.items : null) || [];
  const candidates = items.filter(item => !item.meetingId && (!key || wfKey(item) === key));
  if (!candidates.length) return;
  const section = document.createElement('details');
  section.className = 'd-dsec d-dadd';
  const label = document.createElement('summary');
  label.className = 'lbl';
  label.textContent = '기존 항목 연결';
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
    panelRender();
  }));
  section.appendChild(row);
  box.appendChild(section);
}

// ---------- ⌘K 검색 팔레트 (검색 · 회의 모아보기 · 오늘 신규) ----------
// 큰 창 대신 위에서 내려오는 한 겹. 찾는 범위는 예전 통합 검색과 같다:
// 완료한 업무와 결과 한 줄, 결정·확인 대기·아이디어, 회의와 회의 초안 문구까지
// (외부 티로 노트 전문은 찾지 않는다 — README와 같다).

const PAL_TYPES = [['', '전체'], ['task', '할 일'], ['check', '확인 대기'], ['decision', '결정'], ['idea', '아이디어'], ['meeting', '회의']];
const PAL_TAG = { task: '할 일', bug: '할 일', check: '확인 대기', decision: '결정', idea: '아이디어' };

let palState = null;
let palNodes = null;
let palEntries = [];

function palDefaults(state) {
  return { query: '', type: '', hideDone: false, unresolved: false, reviewOnly: false, newOnly: false, active: 0, scroll: 0, ...(state || {}) };
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

// 회의 거르기(순수 함수): 검토 대기 · 미해결만 · 오늘 신규 · 검색어(초안 문구와 이 회의에서 나온 항목까지).
// 검토할 초안이 있는 회의가 언제나 먼저 온다 — 지금 손댈 것이 위로.
function palMeetings(meetings, state, itemsOf) {
  if (state.type && state.type !== 'meeting') return [];
  const query = (state.query || '').trim();
  if (!query && state.type !== 'meeting') return [];
  const today = state.today || todayStr();
  const related = typeof itemsOf === 'function' ? itemsOf : () => [];
  return (meetings || []).filter((event) => {
    if (state.reviewOnly && !(event.drafts && event.drafts.length)) return false;
    if (state.unresolved && !related(event.id).some(item => item.status !== 'done')) return false;
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
  };
  if (entry.kind === 'meeting') {
    const event = entry.event;
    const related = typeof wfMeetingItems === 'function' ? wfMeetingItems(event.id) : [];
    const open = related.filter(item => item.status !== 'done').length;
    const state = [];
    if (event.drafts && event.drafts.length) state.push(`초안 ${event.drafts.length} 검토`);
    if (open) state.push(`미완료 ${open}`);
    const when = `${uiKoDateShort(event.date)}${event.start ? ` · ${event.start}` : ''}`;
    cell('tag', '회의');
    cell('when num', escapeHtml(when));
    cell('ti', palHighlight(event.title, query), event.title);
    cell('pj', escapeHtml(event.project?.label || event.project?.value || ''));
    cell('st', escapeHtml(state.join(' · ')));
    row.setAttribute('aria-label', `회의 ${when} ${event.title}`);
  } else {
    const item = entry.item;
    const project = item.label || item.group || item.project || '';
    const due = item.status === 'done' ? null : uiDueText(item.due, 'full');
    const status = item.status === 'done' ? { text: '완료', tone: '' } : due || (item.doing ? { text: '진행 중', tone: '' } : null);
    cell('tag', escapeHtml(PAL_TAG[item.type] || item.type || ''));
    cell('ti', palHighlight(item.description, query), item.description);
    cell('pj', escapeHtml(project), project || undefined);
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
  const chip = (text, on, onPick) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'd-chip' + (on ? ' is-on' : '');
    button.textContent = text;
    button.setAttribute('aria-pressed', String(!!on));
    button.addEventListener('click', () => { onPick(); palRender(); palNodes.input.focus(); });
    bar.appendChild(button);
  };
  PAL_TYPES.forEach(([value, text]) => chip(text, palState.type === value, () => {
    palState.type = value;
    palState.active = 0;
    if (value !== 'meeting') { palState.unresolved = false; palState.reviewOnly = false; }
  }));
  const separator = document.createElement('span');
  separator.className = 'sep';
  separator.setAttribute('aria-hidden', 'true');
  bar.appendChild(separator);
  chip('완료 제외', palState.hideDone, () => { palState.hideDone = !palState.hideDone; palState.active = 0; });
  if (palState.type === 'meeting') {
    chip('미해결만', palState.unresolved, () => { palState.unresolved = !palState.unresolved; palState.active = 0; });
    chip('검토 대기', palState.reviewOnly, () => { palState.reviewOnly = !palState.reviewOnly; palState.active = 0; });
  }
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
      ? '찾는 항목이 없습니다.'
      : '찾을 내용을 입력하세요. 완료한 업무와 회의 초안 문구까지 함께 찾습니다.';
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
  palRenderResults();
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
  // 상세 패널·회의 정리 패널은 오늘 탭의 세 번째 열이다 — 다른 탭에 있었다면 함께 옮긴다.
  if (entry.kind === 'meeting') {
    const id = entry.event.id;
    palClose(true);
    setActiveTab('today');
    // 회의 정리도 같은 패널에서 연다 — 닫으면 찾던 자리(검색어·필터·스크롤)로 돌아온다.
    panelOpen({ kind: 'meeting', id, back });
    return;
  }
  const item = entry.item;
  palClose(true);
  if (item.type === 'decision' || item.type === 'idea') { palRevealRecord(item); return; }
  setActiveTab('today');
  panelOpen({ id: item.id, back });
}

// 결정·아이디어는 상세 패널이 없다 — 아이디어·결정 탭의 그 줄로 옮겨 가 잠깐 밝힌다.
function palRevealRecord(item) {
  setActiveTab('records');
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
  foot.className = 'd-palfoot';
  foot.textContent = '↑↓ 이동 · Enter 열기 · Esc 닫기';

  box.append(bar, chips, results, foot);
  root.appendChild(box);
  document.body.appendChild(root);
  palNodes = { root, box, input, chips, results };

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
    if (item.permalink) {
      const link = document.createElement('a');
      link.className = 'd-link';
      link.href = item.permalink;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = '슬랙 원문';
      main.appendChild(link);
    }
    row.appendChild(main);

    // 분류하면서 어느 프로젝트 건인지도 같이 정할 수 있게 한다
    row.appendChild(renderGroupControl({
      jira: item.jira,
      group: item.group,
      onSetJira: (key) => setTaskJira(item.id, key),
      onSetGroup: (g) => setTaskGroup(item.id, g),
    }));

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

    // 앞으로 할 것 — 분류
    choose('오늘', () => fadeOutAndRun(row, () => setTaskScheduled(item.id, todayStr()), '오늘 할 일로 옮김'));
    choose('나중에', () => fadeOutAndRun(row, () => setTaskScheduled(item.id, null), '나중에 할 일로 옮김'));
    // 이미 끝난 것 — 종결. 완료는 기록이 남고(주간요약에 들어감), 삭제는 남지 않는다
    choose('완료로 표시', () => fadeOutAndRun(row, () => toggleTask(item.id), '완료로 표시함'));
    choose('삭제', () => {
      fadeOutAndRun(row, async () => {
        await request('/api/track/remove', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: item.id }),
        });
        load();
      }, '삭제함');
    }, 'dng');

    // 아직 분류 전이라도 기한·우선순위가 분명한 건은 미리 정해둘 수 있어야 한다.
    // 프로젝트는 좁은 화면(≤520px)에서 줄의 선택 상자가 숨으므로 여기에도 둔다.
    actions.appendChild(uiMoreButton(`${item.description} — 더 보기`, () => [[
      {
        field: '기한',
        control: uiDateField({
          value: item.due,
          label: '기한',
          onChange: async (value) => {
            await setTaskDue(item.id, value);
            announce(value ? `기한 ${uiKoDate(value)}로 지정함` : '기한 해제함');
          },
        }),
      },
      { field: '우선순위', control: taskPriorityControl(item) },
      { field: '프로젝트', control: taskProjectControl(item) },
    ]]));

    row.appendChild(actions);
    list.appendChild(row);
  });
}

function renderTodayTasks(items) {
  const doneItems = items.filter(item => item.status === 'done');
  document.getElementById('todayTaskCount').textContent = items.length - doneItems.length;
  document.getElementById('todayDoneSummary').textContent = `완료 ${doneItems.length}`;
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
    uiGroupTasks(active).forEach(([key, groupItems]) => {
      const addRow = uiGroupAddRow(key, '/api/today-task/create', '오늘 할 일 추가함');
      const heading = uiGroupHeading(uiGroupLabel(key), groupItems.length, {
        onAdd: () => { addRow.hidden = false; addRow.querySelector('input').focus(); },
        onOpenProject: key === '__misc__' ? null : () => openProjectTab(key),
      });
      list.append(heading, addRow);
      [...groupItems].sort(compareTasks).forEach(item => list.appendChild(uiTaskRow(item, { mode: 'today', grouped: key !== '__misc__' })));
    });
  }

  if (!active.length && !doing.length) {
    list.insertAdjacentHTML('beforeend', '<div class="d-empty">오늘 할 일이 비었습니다. 위 첫 줄에서 바로 추가하세요.</div>');
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
          announce('내용 수정함');
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
            await request('/api/track/seen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
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
  rest.push(...jiraIssuesCache.map(i => {
    const selected = current && current.type === 'jira' && current.value === i.key;
    return `<option value="jira:${escapeAttr(i.key)}"${selected ? ' selected' : ''}>${escapeHtml(i.key)} · ${escapeHtml(i.summary)}</option>`;
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
          if (!silent) { announce('그룹 해제함'); load(); }
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
          if (!silent) { announce('그룹 지정함'); load(); }
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
          if (!silent) { announce('그룹 지정함'); load(); }
        })();
        return;
      }
      const key = select.value.replace(/^jira:/, '');
      (async () => {
        await onSetJira(key);
        if (!silent) { announce('지라 이슈 연결함'); load(); }
      })();
    });
    select.addEventListener('blur', () => {
      if (committed) return;
      if (revertTo && wrap.contains(select)) wrap.replaceChild(revertTo, select);
    });
    return select;
  }

  // 이미 지정된 지라·그룹은 배지로 보이고, 누르면 같은 자리에서 선택 목록으로 바뀐다.
  const appendBadge = (className, label, current) => {
    const badge = document.createElement('button');
    badge.type = 'button';
    badge.className = className;
    badge.textContent = label;
    badge.setAttribute('aria-label', `${label} — 클릭해서 변경/해제`);
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
    return appendBadge('badge jira-badge', issue ? `${jira} · ${issue.summary}` : jira, { type: 'jira', value: jira });
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
setupQuickAdd('todayTaskInput', '/api/today-task/create', '오늘 할 일 추가함');
setupQuickAdd('laterTaskInput', '/api/later-task/create', '나중에 할 일 추가함');
setupQuickAdd('waitingInput', '/api/waiting/create', '확인 대기 추가함');
setupQuickAdd('ideaInput', '/api/idea/create', '아이디어 추가함');
setupQuickAdd('decisionInput', '/api/decision/create', '결정 추가함');
// 한 글자마다 줄을 전부 다시 만들면 목록이 길수록 입력이 밀린다 — 입력이 멎은 뒤 한 번만
// 그린다. 조합 중에도 input은 그대로 오고 값을 늦게 읽을 뿐이라 한글 입력은 끊기지 않는다.
let decisionArchiveTimer = null;
document.getElementById('decisionArchiveSearch').addEventListener('input', (event) => {
  decisionArchiveQuery = event.target.value.trim().toLowerCase();
  clearTimeout(decisionArchiveTimer);
  decisionArchiveTimer = setTimeout(renderDecisionArchive, 150);
});
// 반영 완료는 접힌 채로 시작한다 — 펼치면 그때 검색 입력과 줄이 함께 보인다.
document.getElementById('decisionArchiveToggle').addEventListener('click', () => {
  decisionArchiveOpen = !decisionArchiveOpen;
  renderDecisionArchive();
  if (decisionArchiveOpen) document.getElementById('decisionArchiveSearch').focus();
});

try { todaySort = localStorage.getItem('todaySort') || 'project'; } catch {}
// 보기 전환은 조용한 두 칸 세그먼트. 고른 값은 브라우저에 그대로 기억한다.
const todayViewSeg = document.getElementById('todayViewSeg');
function renderTodayViewSeg() {
  todayViewSeg?.querySelectorAll('button').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.view === todaySort));
  });
}
todayViewSeg?.querySelectorAll('button').forEach((button) => {
  button.addEventListener('click', () => {
    if (todaySort === button.dataset.view) return;
    todaySort = button.dataset.view;
    try { localStorage.setItem('todaySort', todaySort); } catch {}
    renderTodayViewSeg();
    load();
  });
});
renderTodayViewSeg();

// 검색 팔레트를 여는 두 자리: 헤더의 `검색 ⌘K` 버튼, 레일 한 줄 요약의 `오늘 신규 N`.
document.getElementById('searchEntryBtn')?.addEventListener('click', () => palOpen({}));
document.getElementById('createdTodayBtn')?.addEventListener('click', () => palOpen({ newOnly: true }));

// 여러 개 선택 — 같은 버튼으로 시작하고 끝낸다(Esc도 끝내기).
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
  records: { grid: 'gridRecords', btn: 'tabBtnRecords' },
  weekly: { grid: 'gridWeekly', btn: 'tabBtnWeekly' },
};
projectKeyRestore();

function setActiveTab(tab) {
  if (!TABS[tab]) tab = 'today';
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
  await load();
  announce('새로고침했습니다.');
  setTimeout(() => refreshBtn.classList.remove('spinning'), 400);
});

// ---------- 환경설정 (상태 / 사용법) ----------

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
  view.insertAdjacentHTML('beforeend', '<div class="d-empty">불러오는 중…</div>');
  const automations = await fetchAutomationStatus();
  view.replaceChildren();
  if (!automations.length) {
    view.insertAdjacentHTML('beforeend', '<div class="d-empty">상태를 불러오지 못했습니다.</div>');
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
    error.textContent = trimSummaryText(translateFailureText(a.lastSummary || '실패했습니다.'));
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
    '업무 줄에 마우스를 올리면 <b>내일</b>·<b>나중에</b>가 나옵니다. 나중에로 보낸 업무는 머리줄의 <b>나중에 할 일</b> 서랍에 모이고, 거기서 <b>오늘로</b> 다시 가져옵니다. 따로 "계획 모드"로 들어갈 필요가 없습니다.'],
  ['새로 들어온 것(인박스)이 뭔가요',
    '슬랙·회의에서 자동으로 모인 항목이 먼저 쌓이는 곳입니다. AI가 오늘 할지 나중에 할지 정하지 않습니다. 프로젝트만 지정하고 <b>오늘</b> 또는 <b>나중에</b>로 보내면 정리가 끝나고 인박스에서 사라집니다.'],
  ['프로젝트는 어떻게 지정하고 어디서 모아 보나요',
    '줄의 <b>⋯</b> 더보기 → <b>프로젝트</b>에서 지라 이슈나 그룹을 고릅니다. 모아 보려면 위쪽 <b>프로젝트</b> 탭으로 갑니다. 목록의 그룹 제목을 눌러도 그 프로젝트로 넘어갑니다.'],
  ['여러 개를 한 번에 정리하려면',
    '오늘 할 일 머리줄의 <b>여러 개 선택</b>을 누르면 줄마다 선택 칸이 하나 더 생깁니다(완료 체크는 그대로 씁니다). 목록 아래 막대에서 <b>오늘로</b>·<b>내일</b>·<b>나중에</b>·<b>날짜</b>·<b>프로젝트</b>·<b>완료로 표시</b>·<b>삭제</b>를 한 번에 적용합니다.'],
  ['찾고 싶은 기록이 있으면',
    '<b>⌘K</b>(윈도는 Ctrl+K)로 검색을 엽니다. 할 일·확인 대기·결정·아이디어·회의를 한 자리에서 찾고, 위 칩으로 종류를 좁힙니다. 검색에서 연 항목을 닫으면 찾던 자리로 그대로 돌아옵니다.'],
  ['회의 내용은 어디서 정리하나요',
    '왼쪽 <b>오늘 미팅</b>의 회의를 누르면 오른쪽에 회의 정리 패널이 열립니다. 초안을 고쳐 담고, 담은 뒤 뜨는 결과 카드의 <b>실행 취소</b>로 되돌릴 수 있습니다.'],
  ['잘못 눌렀을 때는',
    '완료·삭제·보고 제외는 아래 알림의 <b>되돌리기</b>로 바로 취소됩니다. <b>⌘Z</b>도 같은 일을 하고, <b>⌘⇧Z</b>로 다시 실행합니다.'],
  ['결과 한 줄은 왜 적나요',
    '완료한 업무에 적은 한 줄이 주간요약 문장으로 그대로 올라갑니다. 금요일에 다시 쓰지 않아도 됩니다.'],
  ['보고 문장을 수정하면 원본 업무도 바뀌나요',
    '아니요. 보고 문장과 원본 기록은 따로 보존됩니다. 원본이 바뀌면 수정 제안으로만 알려 주고, 직접 적용하기 전에는 편집한 문장을 바꾸지 않습니다.'],
  ['자잘한 업무는 어떻게 빼나요',
    '주간요약에서 <b>이번 보고에서 제외</b>를 누르면 복사할 내용에서 빠집니다. 원본은 업무 기록에 남고 언제든 보고에 되돌릴 수 있습니다.'],
  ['확인 대기는 뭔가요',
    '다른 사람의 답을 기다리는 항목입니다. 언제까지 답을 받아야 하는지는 <b>회신 기한</b>으로 적습니다. 할 일 쪽에서 "이 답변을 기다리는 중"으로 연결해 두면 답이 오는 순간 알려 줍니다.'],
  ['머리줄의 "○일 전 기준" 같은 표시는 뭔가요',
    '슬랙·캘린더·지라 자동 동기화가 최근에 못 돌았다는 뜻입니다. 그 글자를 누르면 이 창의 <b>상태</b>에서 해당 자동화 줄이 바로 보입니다.'],
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
        if (!result.token) { showNotice('다른 기기 접속이 설정되지 않았습니다.'); return; }
        await navigator.clipboard.writeText(result.token);
        showNotice('암호를 복사했습니다. 다른 기기에서 사용자 이름은 workspace를 입력해 주세요.');
      } catch { showNotice('암호를 복사하지 못했습니다.', true); }
    });
    const hint = document.createElement('div');
    hint.className = 'd-hint';
    hint.textContent = '같은 와이파이·Tailscale에서 이 주소를 열고, 사용자 이름은 workspace를 입력합니다.';
    section.append(label, access, hint);
    view.appendChild(section);
  }
}

// ---------- 환경설정 열고 닫기 ----------
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
    announce('새로고침했습니다.');
  } finally {
    pullRefreshing = false;
    resetPull(true);
  }
}

document.addEventListener('touchend', endPull, { passive: true });
document.addEventListener('touchcancel', () => { if (pulling) resetPull(true); else pullStartY = null; }, { passive: true });

// 다른 창 갔다가 돌아오면 최신 상태로
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !isTyping()) { load(); fetchAutomationStatus(); }
});

// 계속 띄워둔 채로도 뒤처지지 않게
setInterval(() => {
  if (!document.hidden && !isTyping()) { load(); fetchAutomationStatus(); }
}, 5 * 60 * 1000);

load();
refreshStorageStatus(); // 목록을 못 불러오는 상황에서도 저장이 멈춘 이유는 보이게
fetchAutomationStatus(); // 환경설정을 열어보지 않아도 톱니바퀴에 실패 여부가 바로 보이게

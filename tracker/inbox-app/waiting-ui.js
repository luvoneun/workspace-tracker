// 확인 대기 카드 한 벌 — 체크한 뒤의 `다음은?` 줄, 더보기 차림표, 급한 순·프로젝트별 두 보기,
// 줄 그리기.
// app.js에서 그대로 옮긴 코드다. app.js의 공용 부품(uiDateField·uiMenu·uiRailRow·request·
// showNotice·pushUndo·toggleTask·removeTracked·markContactedToday·load·workflowData)에 기댄다.
// index.html에서 app.js보다 먼저 읽힌다.

// ---------- 확인 대기를 체크한 뒤의 `다음은?` 줄 ----------
// 답을 받은 직후가 "그래서 이제 뭘 하지"를 정하기 가장 좋은 때인데, 몇 초 만에 사라지는 알림으로는
// 그 순간이 지나가 버렸다. 그래서 체크한 그 자리에 제안 줄을 남긴다.
// 체크 자체는 지금처럼 바로 저장되고(toggleTask · ⌘Z 그대로) 이 줄은 제안일 뿐이라 무시해도 된다.
// 상태는 메모리에만 둔다(저장하지 않는다) — 목록이 다시 그려져도(load) 줄은 남고,
// `닫기` · 액션 하나를 끝냄 · 다른 확인 대기를 체크함 · 탭을 떠남 · 새로고침 · 체크를 되돌림으로 사라진다.
let waitingNextId = null;
// 방금 그린 `다음은?` 줄의 `후속 할 일` 입력칸을 여는 함수 — 레일의 한 줄 제안이 상세 카드를 열면서 쓴다.
let waitingNextOpener = null;
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
// 상세 카드 안의 `다음은?`(`.is-panel`)은 제안이 아니라 그 카드의 붙박이 구역이라 걷지 않는다.
function waitingNextClose() {
  waitingNextId = null;
  [...(document.querySelectorAll?.('.d-wnext:not(.is-panel)') || [])].forEach(node => (node.closest?.('.d-wnextwrap') || node).remove?.());
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

// `다음은?` 줄 한 벌. 넓은 자리 셋(프로젝트 탭 확인 대기 구역 · 회의 카드/탭의 `이 회의에서 나온 것` ·
// 확인 대기 상세 카드)이 이 부품 하나를 쓴다. 좁은 레일은 한 줄짜리(waitingNextOne)를 쓴다.
// panel: 상세 카드 안의 붙박이 구역으로 그린다 — 바로 위에 `답변 한 줄` 칸이 있으므로 그 버튼은 빼고,
// 제안이 아니라 카드의 한 부분이라 `닫기`도 없다(`.is-panel`이라 waitingNextClose도 걷지 않는다).
function waitingNextRow(item, { panel = false } = {}) {
  const wrap = document.createElement('div');
  wrap.className = panel ? 'd-wnext is-panel' : 'd-wnext';
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', `${item.description} — 다음은?`);

  const bar = document.createElement('div');
  bar.className = 'nx';
  // 상세 카드에서는 구역 제목이 이미 `다음은?`이다 — 같은 말을 두 번 쓰지 않는다.
  if (!panel) {
    const label = document.createElement('span');
    label.className = 'lb';
    label.textContent = '다음은?';
    bar.appendChild(label);
  }

  const act = (text, onClick) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'd-btn sm';
    button.textContent = text;
    button.setAttribute('aria-label', `${item.description} — ${text}`);
    button.addEventListener('click', () => onClick(button));
    bar.appendChild(button);
  };
  const followUp = () => waitingNextEdit(bar, {
    value: item.description,
    placeholder: '후속 할 일 — Enter로 오늘 할 일',
    label: `${item.description} — 후속 할 일`,
    buttons: [['today', '오늘'], ['later', '나중에']],
    onSubmit: (text, mode) => waitingNextCreateTask(item, text, mode),
  });
  act('후속 할 일', followUp);
  act('결정으로 남기기', async (button) => {
    if (await createDecisionFromWaiting(item, button)) waitingNextClose();
  });
  if (!panel) act('답변 한 줄 남기기', () => waitingNextEdit(bar, {
    value: (typeof wfItem === 'function' ? wfItem(item.id)?.outcome : '') || '',
    placeholder: WAITING_ANSWER_PLACEHOLDER,
    label: `${item.description} — 답변 한 줄`,
    buttons: [['save', '저장']],
    // 업무의 `결과 한 줄`과 같은 저장 길(outcome) — 주간요약의 `확인 완료` 문장이 이 한 줄이 된다.
    onSubmit: async (text) => { await postJson('/api/workflow/item', { id: item.id, outcome: text }); await load(); },
  }));

  if (!panel) {
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'd-btn sm is-cl';
    dismiss.textContent = '닫기';
    dismiss.setAttribute('aria-label', `${item.description} — 다음은? 닫기`);
    dismiss.addEventListener('click', () => waitingNextClose());
    bar.appendChild(dismiss);
  }
  wrap.appendChild(bar);

  const blocked = waitingNextBlocked(item);
  if (blocked.length) wrap.appendChild(waitingNextBlockedList(blocked));
  // 레일의 한 줄 제안이 상세 카드를 열면서 이 입력칸까지 바로 열 수 있게 여는 길을 남겨 둔다.
  wrap.openFollowUp = followUp;
  waitingNextOpener = followUp;
  return wrap;
}

// 상세 카드를 열면서 그 안의 `후속 할 일` 입력칸까지 바로 여는 길(레일 한 줄 제안 ②).
// panelOpen이 카드를 그 자리에서 다 그려 붙이므로, 그때 그려진 줄이 남겨 둔 여는 함수를 바로 부른다.
function waitingNextOpenFollowUp(item) {
  waitingNextOpener = null;
  panelOpen({ id: item.id });
  const open = waitingNextOpener;
  waitingNextOpener = null;
  open?.();
}

// 좁은 레일(296px)의 확인 대기 카드에서는 체크한 줄 아래에 **한 줄만** 남긴다 — 레일은 훑어보는
// 자리라 선택지를 다 펼치면 카드가 화면을 다 먹었다(BNEXTRAIL 결정). 전체 `다음은?`은 `자세히`가
// 여는 상세 카드에 있다. 제안은 하나뿐이고 누르면 바로 실행된다.
function waitingNextOne(item) {
  const wrap = document.createElement('div');
  wrap.className = 'd-wnext is-one';
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', `${item.description} — 다음은?`);

  const bar = document.createElement('div');
  bar.className = 'nx';
  const lead = document.createElement('span');
  lead.className = 'lb';
  lead.textContent = '답을 받았어요 ·';
  bar.appendChild(lead);

  // 기다리던 업무가 있으면 그것부터 — 답이 왔으니 오늘로 당기는 것이 다음 한 걸음이다.
  // 이미 다 오늘 할 일이면 옮길 것이 없으니 `보기`로 상세 카드를 연다.
  const blocked = waitingNextBlocked(item);
  const today = todayStr();
  const move = blocked.filter(task => task.scheduled !== today);
  const name = !blocked.length ? '후속 할 일 만들기'
    : move.length ? `기다리던 업무 ${move.length}개를 오늘로`
    : `기다리던 업무 ${blocked.length}개 보기`;
  const suggest = document.createElement('button');
  suggest.type = 'button';
  suggest.className = 'd-link sg';
  suggest.textContent = `${name} →`;
  suggest.title = name;
  suggest.setAttribute('aria-label', `${item.description} — ${name}`);
  suggest.addEventListener('click', async () => {
    if (!blocked.length) { waitingNextOpenFollowUp(item); return; }
    if (!move.length) { panelOpen({ id: item.id }); return; }
    suggest.disabled = true;
    // 기존 길(set-scheduled)을 업무마다 한 번씩 — ⌘Z도 기존 규칙대로 각각 기록된다.
    try {
      for (const task of move) await setTaskScheduled(task.id, today);
      announce(`오늘 할 일로 옮겼어요 · ${move.length}개`);
    } catch { suggest.disabled = false; }
  });
  bar.appendChild(suggest);

  const detail = document.createElement('button');
  detail.type = 'button';
  detail.className = 'd-btn sm de';
  detail.textContent = '자세히';
  detail.setAttribute('aria-label', `${item.description} — 다음은? 자세히`);
  detail.addEventListener('click', () => panelOpen({ id: item.id }));
  bar.appendChild(detail);

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'd-btn sm is-cl';
  dismiss.textContent = '✕';
  dismiss.setAttribute('aria-label', `${item.description} — 다음은? 닫기`);
  dismiss.addEventListener('click', () => waitingNextClose());
  bar.appendChild(dismiss);

  wrap.appendChild(bar);
  return wrap;
}

// 미완료만 보여 주는 목록(레일 확인 대기·프로젝트 탭)에서는 체크한 줄이 빠진다 —
// 방금 체크한 줄을 목록 맨 위에 한 번 더 그리고 그 아래에 `다음은?`을 붙인다.
// 레일(one)만 한 줄짜리를 쓰고, 넓은 프로젝트 탭은 버튼 줄 그대로다.
function waitingNextLead(item, makeRow, { one = false } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'd-wnextwrap';
  wrap.appendChild(makeRow(item));
  wrap.appendChild(one ? waitingNextOne(item) : waitingNextRow(item));
  return wrap;
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
            await setTaskDue(item.id, value, '답변 받을 날 변경');
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
  // 레일(296px)은 훑어보는 자리라 그 아래는 한 줄짜리 제안이다(one).
  const checkedNow = waitingNextItem();
  if (checkedNow) list.appendChild(waitingNextLead(checkedNow, entry => renderWaitingRow(entry, { showProject: true }), { one: true }));

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

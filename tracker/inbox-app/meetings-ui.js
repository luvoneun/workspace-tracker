// 회의 화면 한 벌 — 줄 옆 카드·회의 탭이 함께 쓰는 회의 정리 패널(초안 검토·담기·종류 바꾸기·연결)과
// 회의 탭(날짜순 · 프로젝트별 두 보기, 필터, 오른쪽 상세).
// app.js에서 그대로 옮긴 코드다. app.js의 공용 부품(panelOpen·panelRender·panelSection·uiMenu·
// request·showNotice·load·workflowData)과 workflows.js(wf*)·meeting-notes-ui.js에 기댄다.
// index.html에서 meeting-notes-ui.js 뒤, app.js보다 먼저 읽힌다.

// ---------- 회의 정리 패널 ----------

// 업무 상세와 같은 자리에서 회의를 정리한다: 결과 카드 → AI 초안 검토 → 이전 회차의 미해결 항목 →
// 기존 항목 연결 → 이 회의에서 나온 것 → (발) 회의에서 나온 것 적기. 내용이 없는 구역은 아예 두지 않는다.
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
function panelMeetingWhenTime(event) {
  const day = !event.date || event.date === todayStr() ? '오늘' : uiKoDate(event.date);
  const time = `${event.start || ''}${event.end ? `–${event.end}` : ''}`;
  return [day, time].filter(Boolean).join(' ');
}
function panelMeetingWhen(event) {
  return [panelMeetingWhenTime(event), wfMeetingProjectName(event)].filter(Boolean).join(' · ');
}

// 회의 탭에서는 이 줄의 프로젝트 이름이 왼쪽 목록을 그 프로젝트로 데려가는 버튼이다(글자 모양은 그대로).
// 줄 옆 카드에는 갈 왼쪽 목록이 없으니 예전처럼 글자로만 적는다.
function panelMeetingWhenLine(event, host) {
  const when = document.createElement('div');
  when.className = 'd-dsub';
  const name = wfMeetingProjectName(event);
  const key = wfMeetingKey(event);
  if (host.kind !== 'tab' || !name || !key) {
    when.textContent = panelMeetingWhen(event);
    return when;
  }
  const link = document.createElement('button');
  link.type = 'button';
  link.className = 'pjlink';
  link.textContent = name;
  link.title = wfMeetingProjectName(event, { withKey: true });
  link.setAttribute('aria-label', `${name} 회의만 모아 보기`);
  link.addEventListener('click', () => meetingsShowProject(key));
  when.append(`${panelMeetingWhenTime(event)} · `, link);
  return when;
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
  // 이 카드를 연 동안 입력줄로 담은 줄(`방금 담은 것`). 결과 카드처럼 회의 → 항목 → 회의로 돌아와도 남고, 닫았다 열면 비운다.
  getFresh: () => (panelState && panelState.kind === 'meeting' ? (panelState.fresh || (panelState.fresh = [])) : null),
  redraw: () => panelRender(),
  box: () => panelDetailBox(),
  // 회의에서 연 항목은 같은 카드에서 열고 맨 위에 `← 회의로`가 붙는다.
  openItem: (item, event) => panelOpen({
    id: item.id,
    back: { kind: 'meeting', id: event.id, event: event.id ? null : event, result: panelState?.result, fresh: panelState?.fresh, back: panelState?.back },
  }),
  openMeeting: (id) => panelOpen({ kind: 'meeting', id, back: panelState?.back }),
};
const MEETING_HOST_TAB = {
  kind: 'tab',
  closable: false,
  getResult: () => meetingsTabState.result || null,
  setResult: (value) => { meetingsTabState.result = value; },
  // 회의 탭에서는 다른 회의를 골랐다 돌아오면 비운다(meetingsTabSelect).
  getFresh: () => meetingsTabState.fresh || (meetingsTabState.fresh = []),
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
  head.append(title, panelMeetingWhenLine(event, host));
  // 업무 상세 카드 머리(panelHead)와 같은 자리·같은 모양 — ✕ 왼쪽에 더보기.
  // 메뉴는 레일의 회의 줄 ⋯가 여는 메뉴 그대로다(회의용으로 새로 만들지 않는다).
  // 이미 열려 있는 자리라 `회의 정리 열기`는 빼고, 회의 탭에서는 `회의 탭에서 열기`도 뺀다.
  // 여기서 프로젝트를 연결(또는 바꿈)하면 그 자리에 `이미 담은 N개도 옮길까요?`가 선다(기록된 회의만).
  const more = uiMoreButton(`${event.title} — 더 보기`,
    () => meetingMenuSections(event, {
      open: false, toTab: host.kind !== 'tab',
      onLinked: linked ? (projectKey, previous) => meetingMoveAskOpen(event.id, previous, projectKey, host) : null,
    }), 'd-iconbtn');
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
  if (linked) {
    const ask = meetingMoveAskNode(event, host);
    if (ask) box.appendChild(ask);
  }

  // 머리 아래의 조용한 한 줄: 아직 안 가져왔으면 버튼(지난 회의에서도 된다), 이미 가져왔으면
  // `미팅 노트 가져옴` + (링크가 있으면) `티로에서 열기` — 초안을 다 검토해 0개가 되어도 남는다.
  if (meetingNotesCanFetch(event)) {
    const get = document.createElement('div');
    get.className = 'd-dget';
    get.appendChild(meetingNotesButton('이 회의의 미팅 노트 가져오기', event));
    box.appendChild(get);
  } else if (meetingNotesHasNote(event)) {
    const get = document.createElement('div');
    get.className = 'd-dget';
    const state = document.createElement('span');
    state.className = 'd-mtlast';
    state.textContent = '미팅 노트 가져옴';
    get.appendChild(state);
    event.tiroNotes.forEach((url, index) => {
      const note = document.createElement('a');
      note.className = 'd-link';
      note.href = url;
      note.target = '_blank';
      note.rel = 'noopener noreferrer';
      note.textContent = event.tiroNotes.length > 1 ? `티로에서 열기 ${index + 1}` : '티로에서 열기';
      get.appendChild(note);
    });
    box.appendChild(get);
  }

  if (!linked) {
    const note = document.createElement('div');
    note.className = 'd-hint';
    note.textContent = '아직 기록되지 않은 회의예요. 여기서 적은 것은 회의에 연결되지 않고 바로 담겨요.';
    box.appendChild(note);
  }
  // 차례: 결과 → AI 초안 → 이전 회차 → 기존 항목 연결 → 이 회의에서 나온 것 → (발) 입력줄.
  // 방금 적은 줄이 늘 입력줄 바로 위에 서도록 `이 회의에서 나온 것`이 본문의 맨 끝이다.
  if (linked) {
    panelMeetingResult(event, box, host);
    if (event.drafts && event.drafts.length) panelMeetingDrafts(event, box, host);
    panelMeetingPast(event, box, host);
    panelMeetingLink(event, box, host);
  }
  panelMeetingItems(event, box, host);
  panelMeetingCapture(event, box, linked, host);
  // 카드를 통째로 다시 그렸으면 열려 있던 종류 목록의 글자도 사라졌다 — 새 카드가 붙은 뒤에 정리한다.
  if (meetingTypeOpen) setTimeout(() => meetingTypeOrphan(host), 0);
}

// 방금 초안을 담은 결과: 어디로 갔는지, 나중에 담긴 할 일을 오늘로, 되돌리기, 다음 검토할 회의.
function panelMeetingResult(event, box, host = MEETING_HOST_CARD) {
  const result = host.getResult();
  if (!result || result.meetingId !== event.id) return;
  const card = document.createElement('div');
  card.className = 'd-dres';
  card.setAttribute('role', 'status');
  card.dataset.moveId = `res:${event.id}`; // 줄 부품의 열쇠 — 회의 탭에서 결과 카드가 나타나고 사라질 때 아래 줄이 미끄러진다(펼침 부품)

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
    await meetingLoadRedraw(host);
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
  await meetingLoadRedraw(host);
}

// 초안을 펼치거나 접을 때 밀리는 줄·구역 머리 — 줄 부품의 바로 잇기(app.js uiRowsShift)로 미끄러진다.
const MEETING_SHIFT_ROWS = '.d-mrow2, .d-dsec > .lbl, .d-dsec > summary, .d-dres, .d-hint';

// AI가 분류한 초안 — 한 줄씩: `AI` | 문구 | (오늘 · 날짜) 종류 | 빼기. 문구를 누르면 그 자리에서 문구 칸 + 나중에/오늘 + 기한이
// 펼쳐진다(한 번에 하나). 고친 문구·종류·날짜는 wfDraftEdits에 남아 다시 그려도 유지된다. `N개 담기`는 구역 제목 옆에 있다.
// 초안 빼기는 조용한 글자 버튼 `빼기`다(✕는 날짜 칸의 `날짜 지우기` 하나만 남는다) — 손이 닿을 때만 보인다(누르는 화면에서는 늘).
let meetingDraftBarSeq = 0;
let meetingDraftOpenId = null; // 펼쳐 둔 초안 — 카드를 다시 그려도 그대로 펼쳐 둔다
function panelMeetingDrafts(event, box, host = MEETING_HOST_CARD) {
  const { section, label } = meetingSection('AI 초안', event.drafts.length);
  section.classList.add('d-drafts');
  // 오류 자리 — 구역 제목 바로 아래(빈 초안·저장 실패). 카드 머리까지 올라가 보지 않아도 되게.
  const message = document.createElement('div');
  message.className = 'er';
  message.id = `meetingDraftBarError${++meetingDraftBarSeq}`;
  message.setAttribute('role', 'alert');
  const list = document.createElement('div');
  list.className = 'd-mlist';
  const showBarError = (text) => { message.textContent = text || ''; };

  event.drafts.forEach((draft) => {
    if (!wfDraftEdits.has(draft.id)) wfDraftEdits.set(draft.id, { type: draft.type, description: wfCleanDraftText(draft.description), when: 'later', due: draft.due || '' });
  });
  if (!event.drafts.some(draft => draft.id === meetingDraftOpenId)) meetingDraftOpenId = null;
  const flagged = new Set(); // 비운 채 담으려 한 초안
  const rows = new Map(); // 초안 번호 → 지금 줄

  const redraw = (draft, opening = false) => {
    const old = rows.get(draft.id);
    const row = build(draft, opening);
    rows.set(draft.id, row);
    if (old) old.replaceWith(row);
    return row;
  };
  // 한 줄을 펼치거나(id) 접는다(null). 다른 줄은 건드리지 않는다 — 누르던 줄이 사라져 클릭이 씹히지 않게.
  const toggle = (id) => {
    const previous = meetingDraftOpenId;
    if (previous === id) return;
    // 접히는 초안의 문구 칸·버튼은 옛 자리에서 120ms 흐려진다(펼침 부품의 접힘). 아래 줄의 바로 잇기와 같은 조건 —
    // 늘 내 동작(누름·Enter·Esc·바깥 누름)이 부르고, 접는 것이 바로 그 글자 칸이라 글자 입력 중 판정은 보지 않는다.
    const closing = previous && rows.get(previous) ? rows.get(previous).querySelector('.ed') : null;
    const leave = closing && !detailReduce() && !document.hidden ? uiFoldLeave(closing, rows.get(previous).parentElement) : () => {}; // 줄은 갈아 끼워지니 그림자는 목록에 붙인다
    uiRowsShift(host.box(), MEETING_SHIFT_ROWS, () => {
      meetingDraftOpenId = id;
      [previous, id].filter(Boolean).forEach((one) => {
        const draft = event.drafts.find(other => other.id === one);
        if (draft) redraw(draft, one === id);
      });
    }, id ? { duration: UI_GLIDE.move, bounce: true } : { duration: UI_UNFOLD.close });
    leave();
    const text = id && rows.get(id) ? rows.get(id).draftText : null;
    if (text) {
      text.focus();
      if (text.setSelectionRange) text.setSelectionRange(text.value.length, text.value.length);
    }
  };

  function build(draft, opening) {
    const index = event.drafts.indexOf(draft);
    const edit = wfDraftEdits.get(draft.id);
    const open = meetingDraftOpenId === draft.id;
    const blank = !edit.description.trim();
    const row = document.createElement('div');
    row.className = 'd-mrow2 d-draft' + (open ? ' is-edit' : '') + (open && opening ? ' is-opening' : '')
      + (blank ? ' is-blank' : '') + (flagged.has(draft.id) ? ' is-bad' : '');
    row.dataset.moveId = `dr:${draft.id}`; // 줄 이동 도우미의 열쇠 — 빼거나 담으면 아래 줄이 올라온다(uiRowsMove)
    row.dataset.type = edit.type;

    const mark = document.createElement('span');
    mark.className = 'ck ai';
    mark.textContent = 'AI';
    mark.title = 'AI가 뽑은 초안 — 담기 전이에요';
    const right = document.createElement('span');
    right.className = 'r';
    const dismiss = panelQuietButton('빼기', () => meetingDraftDismiss(event, draft, edit, index, host), 'd-dpull');
    const labelDismiss = () => dismiss.setAttribute('aria-label', meetingDraftDismissLabel(edit.description));
    labelDismiss();
    dismiss.title = '이 초안 빼기';

    let middle;
    if (open) {
      middle = document.createElement('div');
      middle.className = 'ed';
      const text = document.createElement('textarea');
      text.className = 'd-dtxt';
      text.rows = 1;
      text.maxLength = 1000;
      text.value = edit.description;
      text.setAttribute('aria-label', '초안 문구');
      if (flagged.has(draft.id)) { text.setAttribute('aria-invalid', 'true'); text.setAttribute('aria-describedby', message.id); }
      row.draftText = text;
      const fit = () => { text.style.height = 'auto'; text.style.height = `${text.scrollHeight + text.offsetHeight - text.clientHeight}px`; };
      const was = edit.description;
      text.addEventListener('input', () => {
        // 문구는 한 줄이다: 붙여넣은 줄바꿈은 공백으로
        if (text.value.includes('\n')) text.value = text.value.replace(/\s*\n\s*/g, ' ');
        edit.description = text.value;
        labelDismiss();
        // 빈 칸 표시는 채우는 즉시 걷고, 빈 초안이 하나도 안 남으면 오류도 걷는다.
        if (flagged.has(draft.id) && text.value.trim()) {
          flagged.delete(draft.id);
          text.removeAttribute('aria-invalid');
          text.removeAttribute('aria-describedby');
          showBarError(flagged.size ? meetingDraftEmptyText(flagged.size) : '');
        }
        fit();
      });
      text.addEventListener('keydown', (keyEvent) => {
        if (keyEvent.key !== 'Enter' || keyEvent.isComposing) return; // 조합 중의 Enter는 글자를 확정하는 것이다
        keyEvent.preventDefault();
        toggle(null);
        meetingCaptureFocus(host);
      });
      // Esc는 이 줄만 접고 문구를 펼치기 전으로 되돌린다(회의 카드는 닫히지 않는다).
      row.addEventListener('keydown', (keyEvent) => {
        if (keyEvent.key !== 'Escape' || keyEvent.isComposing) return;
        keyEvent.preventDefault();
        if (keyEvent.stopPropagation) keyEvent.stopPropagation();
        edit.description = was;
        toggle(null);
        const title = rows.get(draft.id) ? rows.get(draft.id).draftTitle : null;
        if (title) title.focus();
      });
      const controls = document.createElement('div');
      controls.className = 'ct';
      if (edit.type === 'task') {
        const whenSeg = wfSegment([['later', '나중에 할 일'], ['today', '오늘 할 일']], edit.when || 'later', (key) => { edit.when = key; }, '언제 할 일로 담을까');
        whenSeg.title = '나중에: 나중에 할 일로 담겨요 · 오늘: 오늘 할 일로 담겨요';
        controls.appendChild(whenSeg);
      }
      const dateName = wfDateLabel(edit.type); // 할 일 → 기한 · 확인 대기 → 답변 받을 날 · 결정 → 날짜 없음
      // 고른 날짜는 앱의 날짜 글자(`10월 2일 (금)`)로 보인다 — 누르면 그 자리에서 날짜 입력칸으로 바뀐다.
      if (dateName) controls.appendChild(uiDateField({ value: edit.due || '', label: dateName, onChange: (value) => { edit.due = value || ''; }, shown: true }));
      middle.append(text, controls);
      requestAnimationFrame(fit);
    } else {
      middle = document.createElement('button');
      middle.type = 'button';
      middle.className = 'ti';
      middle.textContent = blank ? '빈 초안' : edit.description;
      middle.title = '눌러서 고치기';
      middle.setAttribute('aria-expanded', 'false');
      middle.setAttribute('aria-label', `${blank ? '빈 초안' : edit.description} — 눌러서 고치기`);
      middle.addEventListener('click', () => toggle(draft.id));
      row.draftTitle = middle;
      // 접힌 줄에는 고른 값만 조용히: 오늘 할 일로 고른 것, 날짜.
      const note = (value) => { const tag = document.createElement('span'); tag.className = 'st'; tag.textContent = value; right.appendChild(tag); };
      if (edit.type === 'task' && edit.when === 'today') note('오늘');
      if (edit.type !== 'decision' && edit.due) note(uiDateSlash(edit.due));
    }
    right.appendChild(meetingTypeButton(edit.type, (key) => {
      edit.type = key;
      redraw(draft);
      meetingCaptureFocus(host);
    }));
    const acts = document.createElement('span');
    acts.className = 'ac';
    acts.appendChild(dismiss);
    row.append(mark, middle, right, acts);
    return row;
  }

  // 펼친 줄 밖을 누르면 접는다(종류 목록은 카드 밖에 떠 있어 여기 걸리지 않는다).
  box.addEventListener('mousedown', (mouseEvent) => {
    if (!meetingDraftOpenId) return;
    const target = mouseEvent.target;
    if (target && target.closest && target.closest('.d-draft.is-edit')) return;
    toggle(null);
  });

  // 제목 옆 2차 버튼 — 초안은 틀릴 수 있어 사람이 담기를 눌러야 담긴다.
  label.appendChild(panelQuietButton(`${event.drafts.length}개 담기`, async () => {
    showBarError('');
    flagged.clear();
    const accept = event.drafts.map(draft => wfAcceptItem(draft.id, wfDraftEdits.get(draft.id)));
    const empty = accept.filter(item => !item.description);
    if (empty.length) {
      // 빈 초안은 표시하고, 첫 빈 초안을 펼쳐 초점을 보낸다.
      empty.forEach(item => flagged.add(item.id));
      showBarError(meetingDraftEmptyText(empty.length));
      meetingDraftOpenId = empty[0].id;
      event.drafts.forEach(draft => redraw(draft));
      const first = rows.get(empty[0].id).draftText;
      if (first) first.focus();
      return;
    }
    event.drafts.forEach(draft => redraw(draft));
    let result;
    try { result = await wfReview({ meetingId: event.id, accept }); } catch (error) {
      showBarError((typeof error?.message === 'string' && error.message) || '저장하지 못했어요. 내용을 확인한 뒤 다시 시도해 주세요.');
      return;
    }
    host.setResult({ meetingId: event.id, created: result.created, accepted: accept });
    accept.forEach(item => wfDraftEdits.delete(item.id));
    meetingDraftOpenId = null;
    await meetingLoadRedraw(host); // 결과 카드(role=status)가 담은 결과를 알려 주므로 따로 알림을 띄우지 않는다
  }, 'd-btn sm acc'));

  event.drafts.forEach(draft => list.appendChild(redraw(draft)));
  section.append(message, list);
  box.appendChild(section);
}

const meetingDraftEmptyText = count => `빈 초안이 ${count}개 있어요. 채우거나 빼 주세요`;
// `빼기` 버튼의 이름 — 어느 초안인지 앞부분만(길면 줄여서). 비어 있으면 빈 초안이라고.
const meetingDraftShort = description => {
  const text = String(description || '').trim();
  return text.length > 30 ? `${text.slice(0, 30)}…` : text;
};
const meetingDraftDismissLabel = description => (meetingDraftShort(description) ? `초안 빼기: ${meetingDraftShort(description)}` : '빈 초안 빼기');

// 초안 빼기 — 서버는 검토 기록에 'dismissed'만 남긴다(meeting_drafts.json은 그대로).
// 되돌리기는 알림의 `되돌리기`와 ⌘Z가 같은 기록을 쓴다: review-restore가 "뺀 직후 모양일 때만" 되살리고,
// 되살아난 초안에는 빼기 전에 고쳐 둔 문구·종류·날짜가 그대로 돌아온다. 판을 닫았다 열어도 ⌘Z는 그대로 된다
// (기록은 회의 번호·초안 번호만 들고 있고 화면 조각을 붙잡지 않는다).
async function meetingDraftDismiss(event, draft, edit, index, host = MEETING_HOST_CARD) {
  let kept = { ...edit }; // 되살릴 때 쓸 초안 내용 — 빼는 순간(처음·다시 실행)마다 그때 내용으로 다시 잡는다
  const send = async () => {
    const now = wfDraftEdits.get(draft.id);
    await wfReview({ meetingId: event.id, dismiss: [draft.id] });
    if (now) kept = { ...now };
    wfDraftEdits.delete(draft.id);
  };
  try { await send(); } catch { return; } // request()가 이미 알렸다 — 초안은 그 자리에 그대로 있다
  const entry = {
    label: `${meetingDraftShort(kept.description) || '빈 초안'} (초안 빼기)`,
    undo: async () => {
      await request('/api/workflow/review-restore', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, quiet: true,
        body: JSON.stringify({ meetingId: event.id, drafts: [draft.id] }),
      });
      wfDraftEdits.set(draft.id, { ...kept });
    },
    redo: send,
  };
  pushUndo(entry);
  await meetingLoadRedraw(host);
  // 빠진 자리 다음 초안(없으면 앞 초안)의 `빼기`로 초점을 옮긴다 — 누른 버튼이 사라져 초점을 잃지 않게.
  // 문구 칸이 아니라 버튼인 까닭: 입력칸에 초점이 있으면 되살린 뒤 판을 다시 그리지 않는다(쓰던 글 보호 장치).
  const left = host.box()?.querySelectorAll('.d-draft .d-dpull') || [];
  const next = left[Math.min(index, left.length - 1)];
  if (next) next.focus();
  showNotice('초안 하나를 뺐어요', false, null, {
    label: '되돌리기',
    onClick: async (button) => {
      if (undoStack[undoStack.length - 1] !== entry) { showNotice('최근 작업부터 순서대로 실행 취소해 주세요', true); return; }
      if (button) button.disabled = true;
      await replayUndo('undo');
      // 다른 되돌리기가 도는 중이라 아무것도 안 했거나 실패했으면 이 기록이 그대로 맨 위다 — 다시 누를 수 있게 푼다.
      if (button && undoStack[undoStack.length - 1] === entry) button.disabled = false;
    },
  });
}

// 항목 한 줄: 종류 | 문구 | 기한·상태. 기본 상태(미완료)는 모든 줄에 반복되니 적지 않는다.
// 끝낸 줄은 체크 + 제목 취소선이 이미 말하니 글자를 더하지 않고, 남은 기한·진행 중도 뜻이 없어 적지 않는다.
function panelMeetingItemState(item) {
  if (item.status === 'done') return null;
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

// 담은 항목의 종류 바꾸기 — 서버가 같은 id로 파일만 옮긴다(회의 연결·검토 기록이 그대로 남는다).
// 되돌리기는 반대 방향으로 한 번 더 바꾸는 것이고, 알림의 `되돌리기`와 ⌘Z가 같은 길을 쓴다.
// 고르는 자리는 줄의 종류 글자가 여는 목록(meetingRowType) 하나다.
const RETYPE_DISABLED_HINT = '완료한 항목은 종류를 바꿀 수 없어요';
// `로`/`으로` — 받침이 없거나 ㄹ이면 `로`(할 일로 · 확인 대기로), 그 밖에는 `으로`(결정으로).
function uiRoParticle(word) {
  const last = String(word || '').trim().slice(-1);
  const code = last.charCodeAt(0);
  if (!(code >= 0xac00 && code <= 0xd7a3)) return '로';
  const tail = (code - 0xac00) % 28;
  return tail === 0 || tail === 8 ? '로' : '으로';
}
const retypeDoneText = type => `${wfType(type)}${uiRoParticle(wfType(type))}`;
async function retypeSend(id, type, host = null) {
  const result = await wfPost('retype', { id, type });
  if (!result.ok) throw new Error(result.error || '종류를 바꾸지 못했어요.');
  // 종류 구역에 선 줄은 새 구역으로 옮겨 가며 떠오른다(`방금 담은 것`의 줄은 글자만 바뀌고 제자리).
  meetingMovedIds.add(id);
  try {
    await load();
    // 입력줄에 초점이 있으면 카드 전체는 다시 그려지지 않는다 — 열려 있는 회의의 목록만 따로 맞춘다.
    [...new Set([MEETING_HOST_CARD, MEETING_HOST_TAB, host])].forEach(one => meetingItemsRepaint(one));
  } finally {
    meetingMovedIds.delete(id);
  }
}
async function retypeMeetingItem(item, type, host = null) {
  const from = item.type;
  await retypeSend(item.id, type, host);
  const entry = {
    label: `${item.description} (종류 바꾸기)`,
    undo: () => postJson('/api/workflow/retype', { id: item.id, type: from }),
    redo: () => postJson('/api/workflow/retype', { id: item.id, type }),
  };
  pushUndo(entry);
  showNotice(`${retypeDoneText(type)} 바꿨어요`, false, null, {
    label: '되돌리기',
    onClick: async (button) => {
      if (button) button.disabled = true;
      try { await retypeSend(item.id, from, host); } catch { if (button) button.disabled = false; return; }
      // ⌘Z가 같은 되돌리기를 한 번 더 하지 않게 그 기록을 뺀다(삭제 되돌리기와 같은 규칙).
      const at = undoStack.lastIndexOf(entry);
      if (at >= 0) undoStack.splice(at, 1);
      showNotice(`${retypeDoneText(from)} 되돌렸어요`);
    },
  });
}

// 회의 줄의 ⋯ — 앱의 다른 목록이 쓰는 메뉴를 그대로 쓰고, 맨 위에 `문구 고치기`를 얹는다(종류는 줄의 종류 글자에서 바꾼다).
// onOpen(업무·확인 대기)이 있으면 그 위에 `상세 열기` — 제목은 누르면 펼치는 자리라 상세는 여기서 연다.
function panelMeetingRowMenu(item, row, onEdit, onOpen = null) {
  const base = item.type === 'check' ? waitingMenuSections(item, row)
    : item.type === 'decision' ? decisionMenuSections(item, row)
    : taskMenuSections({ item, mode: panelMode(item), card: row });
  const head = [
    ...(typeof onOpen === 'function' ? [{ label: '상세 열기', onClick: onOpen }] : []),
    { label: '문구 고치기', onClick: onEdit },
  ];
  return [head, ...base];
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

// 줄에 붙일 프로젝트 표기 — 이 회의 자체의 프로젝트와 다른 항목만 적는다(같으면 머리가 이미 말했다).
// 부서 간 회의처럼 한 회의에서 여러 프로젝트 일이 나올 때 어느 프로젝트 것인지 알려 주는 자리다.
function panelMeetingRowProject(item, event) {
  if (typeof wfKey !== 'function' || typeof wfMeetingKey !== 'function') return null;
  const key = wfKey(item);
  if (!key || key === wfMeetingKey(event)) return null;
  return uiInlineProject(item);
}

// 한 줄: 체크 | 문구 | (상태) 종류 | ⋯ — 종류는 줄마다 오른쪽에 조용한 글자로 선다(종류 구역 안에서도 — 종류를 바꾸는 유일한 길이다).
function panelMeetingRow(item, event, stateText, host = MEETING_HOST_CARD) {
  const row = document.createElement('div');
  const done = item.status === 'done';
  const project = panelMeetingRowProject(item, event);
  row.className = 'd-mrow2' + (project ? ' has-pj' : '')
    + (done ? ' is-done' : '')
    + (panelState && panelState.kind !== 'meeting' && panelState.id === item.id ? ' is-sel' : '');
  // 회의 탭에서 제목을 누르면 이 줄 옆에 상세 카드가 뜬다 — 다른 목록과 같은 앵커 규칙을 쓴다.
  row.dataset.taskId = item.id;
  const { cell: checkCell, input: checkbox } = panelMeetingCheck(item, row, done);
  row.appendChild(checkCell);
  // 제목은 평소 두 줄까지(말줄임). **실제로 잘렸을 때만** 누르면(Enter·Space도 — 진짜 버튼이다) 그 자리에서 전문,
  // 다시 누르면 접힌다(아이디어 줄과 같은 uiClampWatch). 잘리지 않은 제목은 예전처럼 업무·확인 대기는 상세 열기,
  // 상세가 없는 결정은 `문구 고치기`다. ⋯ 맨 위의 `상세 열기`는 잘린 줄에서도 상세를 여는 길이다.
  const openable = ['task', 'bug', 'check'].includes(item.type);
  const title = document.createElement('button');
  title.type = 'button';
  title.className = 'ti';
  title.title = item.description;
  title.textContent = item.description;
  const edit = () => panelMeetingRowEdit(row, title, item, checkbox);
  uiClampWatch(row, title, (clamp) => {
    if (clamp) title.removeAttribute('aria-label');
    else title.setAttribute('aria-label', openable ? `${item.description} 상세 보기` : `${item.description} — 문구 고치기`);
  });
  title.addEventListener('click', () => {
    if (uiClampToggle(row, title)) return;
    if (openable) host.openItem(item, event); else edit();
  });
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
  acts.appendChild(uiMoreButton(`${item.description} — 더 보기`,
    () => panelMeetingRowMenu(item, row, edit, openable ? () => host.openItem(item, event) : null)));
  // 프로젝트 표기가 있을 때만 제목과 한 칸에 묶는다(`제목 · ● 이름`) — 없으면 줄 모양은 예전 그대로다.
  if (project) {
    const wrap = document.createElement('span');
    wrap.className = 'tw';
    wrap.append(title, project);
    row.appendChild(wrap);
  } else {
    row.appendChild(title);
  }
  // 오른쪽 칸: (있으면) 상태 글자 + 종류.
  const right = document.createElement('span');
  right.className = 'r';
  if (state.textContent) right.appendChild(state);
  right.appendChild(meetingRowType(item, host));
  row.append(right, acts);
  return row;
}

// ---------- 종류 목록 ----------
// 줄의 조용한 글자 `할 일 ⌄`이 여는 작은 목록(할 일 · 확인 대기 · 결정). 분류 판과 같은 모양(.d-schedpop·.d-mitem)이고
// 여닫기는 공용 "뜨는 것"(app.js uiFloatOpen·uiFloatPlace·uiFloatClose — 누른 글자에서 자라 나오고, 아래가 모자라면 위로 뒤집는다). ↑↓·Enter·Esc, 글쇠 `?` `!`(입력 앞머리와 같은 글자)·1~3.
const MEETING_TYPE_KEYS = { check: '?', decision: '!' };
let meetingTypeOpen = null; // { pop, anchor, onEsc, away, shut }

function meetingTypeClose(restoreFocus = false, pressed = null) {
  if (!meetingTypeOpen) return;
  const { pop, anchor, onEsc, away, shut } = meetingTypeOpen;
  meetingTypeOpen = null;
  escDrop(onEsc);
  document.removeEventListener('mousedown', away, true);
  document.removeEventListener('scroll', shut, true);
  window.removeEventListener('resize', shut);
  anchor.setAttribute('aria-expanded', 'false');
  uiFloatClose(pop, UI_FLOAT.out, pressed);
  if (restoreFocus && anchor.isConnected) anchor.focus();
}

function meetingTypeToggle(anchor, current, onPick) {
  if (meetingTypeOpen && meetingTypeOpen.anchor === anchor) { meetingTypeClose(true); return; }
  meetingTypeClose();
  uiSchedClose();
  uiMenuClose();

  const pop = document.createElement('div');
  pop.className = 'd-schedpop d-typepop';
  pop.setAttribute('role', 'listbox');
  pop.setAttribute('aria-label', '종류');
  pop.addEventListener('click', event => event.stopPropagation());
  const pick = (key) => { meetingTypeClose(false, items.find(button => button.dataset.key === key) || null); onPick(key); };
  const items = WF_TYPES.map(([key, text], index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'd-mitem' + (key === current ? ' on' : '');
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(key === current));
    button.dataset.key = key;
    button.style.setProperty('--i', String(index));
    const name = document.createElement('span');
    name.textContent = text;
    button.appendChild(name);
    if (MEETING_TYPE_KEYS[key]) {
      const kbd = document.createElement('kbd');
      kbd.textContent = MEETING_TYPE_KEYS[key];
      button.appendChild(kbd);
    }
    button.addEventListener('click', () => pick(key));
    button.addEventListener('focus', () => { items.forEach(other => other.classList.remove('on')); button.classList.add('on'); });
    pop.appendChild(button);
    return button;
  });
  pop.addEventListener('keydown', (event) => {
    const at = items.indexOf(document.activeElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      items[(at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
    } else if (event.key === 'Tab') meetingTypeClose();
    else {
      const hit = WF_TYPES.find(([key], index) => MEETING_TYPE_KEYS[key] === event.key || String(index + 1) === event.key);
      if (hit) { event.preventDefault(); pick(hit[0]); }
    }
  });

  uiFloatOpen(pop);
  // 오른쪽 끝을 누른 글자에 맞춘다(종류 글자는 줄의 오른쪽에 있다).
  uiFloatPlace(pop, anchor, { align: 'end', nudge: 6, width: 176 });
  anchor.setAttribute('aria-expanded', 'true');
  const onEsc = () => meetingTypeClose(true);
  escPush(onEsc);
  const away = (event) => { if (!pop.contains(event.target) && !anchor.contains(event.target)) meetingTypeClose(); };
  // 닫힘을 재생하는 복사본(방금 닫힌 메뉴 등)에 스크롤 자리를 옮기며 나가는 scroll은 사용자의 스크롤이 아니다.
  const shut = (event) => { if (!uiFloatGhostEvent(event)) meetingTypeClose(); };
  document.addEventListener('mousedown', away, true);
  document.addEventListener('scroll', shut, true);
  window.addEventListener('resize', shut);
  meetingTypeOpen = { pop, anchor, onEsc, away, shut };
  (items.find(button => button.dataset.key === current) || items[0]).focus();
}

// 목록을 연 글자가 다시 그리기로 사라졌으면(자동 갱신·저장 뒤 목록 맞춤) 허공에 남은 목록을 닫고 초점을 입력줄로 돌린다.
function meetingTypeOrphan(host) {
  if (!meetingTypeOpen || meetingTypeOpen.anchor.isConnected) return;
  meetingTypeClose();
  meetingCaptureFocus(host);
}

// 종류 글자 버튼. onPick이 없으면(담는 중인 줄) 같은 모양의 눌리지 않는 글자다.
function meetingTypeButton(type, onPick, { hint = '' } = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'd-tpk';
  const name = document.createElement('span');
  name.className = 'tl';
  name.textContent = wfType(type);
  const caret = document.createElement('span');
  caret.className = 'cv';
  caret.innerHTML = uiIcon('chevron');
  button.append(name, caret);
  if (!onPick) {
    button.disabled = true;
    button.setAttribute('aria-label', `종류: ${wfType(type)}`);
    if (hint) { button.title = hint; button.setAttribute('aria-description', hint); }
    return button;
  }
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-label', `종류: ${wfType(type)} — 바꾸기`);
  button.addEventListener('click', (event) => { if (event && event.stopPropagation) event.stopPropagation(); meetingTypeToggle(button, type, onPick); });
  return button;
}

// 담은 줄의 종류 — 고르면 기존 `종류 바꾸기`(retype) 길로 바꾸고 초점은 입력줄로 돌아간다(이어서 적게).
// 완료한 항목은 옮기지 않는다 — 끝난 줄이라 종류를 바꿀 일이 없다(서버도 거절한다).
function meetingRowType(item, host) {
  if (item.status === 'done') return meetingTypeButton(item.type, null, { hint: RETYPE_DISABLED_HINT });
  return meetingTypeButton(item.type, async (type) => {
    meetingCaptureFocus(host);
    if (type === item.type) return;
    try { await retypeMeetingItem(item, type, host); } catch { return; /* request()가 이미 알린다 */ }
    meetingCaptureFocus(host);
  });
}

// 구역 머리: 제목 + 조용한 숫자(`이 회의에서 나온 것 3`). 숫자는 따로 든 칸이라 줄이 늘어도 그 칸만 바꾼다.
function meetingSection(title, count) {
  const section = panelSection(title);
  const label = section.children[0];
  section.className = 'd-dsec d-msec';
  label.className = 'lbl d-mhead';
  label.dataset.moveId = `grp:sec:${title}`; // 줄 이동 도우미의 열쇠 — 구역 제목도 줄과 함께 미끄러진다(구역 자체에는 달지 않는다: 줄과 겹쳐 두 번 움직인다)
  const number = document.createElement('span');
  number.className = 'n num';
  number.textContent = String(count);
  label.appendChild(number);
  return { section, label, number };
}

// ---------- 회의에서 나온 것 적기 ----------
// 카드 발의 입력줄에 적고 Enter를 누르면 그 줄이 바로 목록 끝(입력줄 바로 위)에 선다 — 저장은 뒤에서 차례로 보낸다
// (uiQueueSend). 아직 서버 목록에 없는 줄(담는 중·못 담음·담았지만 아직 다시 읽기 전)은 여기서 회의별로 들고 있어
// 카드를 다시 그려도 그대로 남는다. 서버 목록에 들어온 줄은 내려놓는다(기록되지 않은 회의는 목록이 없어 그대로 둔다).
const meetingCaptureLocal = new Map(); // 회의 키 → [{ seq, type, text, state: 'pending' | 'fail' | 'saved', id, fresh, recent }]
let meetingCaptureSeq = 0;
const MEETING_PASTE_MAX = 30;
const MEETING_TEXT_MAX = 1000;
// 화면 메모리의 열쇠 — 기록된 회의는 번호, 기록되지 않은 회의는 날짜·시각·제목(매일 같은 시각·제목으로 열리는 회의가
// 어제 적은 줄을 물려받지 않게 날짜를 넣는다).
const meetingCaptureKey = event => event.id || `${event.date || todayStr()} ${event.start || ''} ${event.title || ''}`;
const MEETING_TYPE_HEADS = { '?': 'check', '!': 'decision' };

// 맨 앞 한 글자로 종류를 정한다: `?` 확인 대기 · `!` 결정(담을 때 떼어 낸다). 앞에 빈칸을 두면 글자 그대로 담는다.
function meetingCaptureParse(raw) {
  const value = String(raw || '');
  const text = value.trim();
  const type = /^\s/.test(value) ? null : MEETING_TYPE_HEADS[text[0]];
  return type ? { type, text: text.slice(1).trim() } : { type: 'task', text };
}
// 붙여 넣은 줄 앞의 목록 표시(`-` `•` `*` `1.` `1)`)를 뗀다. 번호는 한두 자리이고 바로 뒤에 숫자가 오지 않을 때만 —
// `10. 2 배포 일정`·`2026. 10. 5. 릴리스`처럼 날짜로 시작하는 글은 깎지 않는다.
const meetingCaptureClean = line => String(line).replace(/^\s*(?:[-•*·]\s+|\d{1,2}[.)]\s+(?!\d))/, '').trim();
function meetingCaptureLines(text) {
  return String(text || '').split(/\r?\n/).map(meetingCaptureClean).filter(Boolean)
    .map(meetingCaptureParse).filter(entry => entry.text);
}

// 지금 떠 있는 회의 카드(또는 탭)의 목록만 다시 그린다 — 입력줄은 건드리지 않아 한글 조합·초점이 그대로다.
function meetingItemsRepaint(host) {
  const box = host && host.box ? host.box() : null;
  if (box && typeof box.meetingRepaintPast === 'function') box.meetingRepaintPast();
  if (box && typeof box.meetingRepaint === 'function') box.meetingRepaint();
}
function meetingCaptureFocus(host) {
  const box = host && host.box ? host.box() : null;
  if (box && box.meetingInput) box.meetingInput.focus();
}

async function meetingCaptureSave(event, linked, entry) {
  if (linked) {
    const result = await wfPost('capture', { meetingId: event.id, type: entry.type, description: entry.text });
    if (!result.ok) throw new Error(result.error || '담지 못했어요.');
    return result.id;
  }
  // 기록되지 않은 회의: 회의에 연결하지 않고 목록에 바로 담는다(프로젝트는 회의에 연결된 것을 쓴다).
  // 묶음(BBUNDLE)에 든 티켓이면 대표 티켓으로 담는다(서버 addToMeeting의 기본값과 같은 규칙).
  const project = meetingCaptureProject(event.project);
  const body = { description: entry.text, ...(project && project.type && project.value ? { [project.type]: project.value } : {}) };
  const response = await request(MEETING_CAPTURE_ENDPOINT[entry.type], {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), quiet: true,
  });
  const result = await response.json();
  if (!result.ok) throw new Error(result.error || '담지 못했어요.');
  return result.id;
}

const meetingCaptureQueue = event => `meeting-capture:${meetingCaptureKey(event)}`;
// 한 줄을 보낸다. 같은 회의의 저장은 한 줄로 서서 적은 순서대로 나가고, 앞 줄이 실패해도 다음 줄은 그대로 보낸다.
// 목록은 대기열의 마지막 줄이 끝났을 때 한 번만 다시 읽는다(여러 줄을 붙여 넣어도 다시 읽기는 한 번).
function meetingCaptureSend(event, linked, entry, host) {
  const queueKey = meetingCaptureQueue(event);
  entry.state = 'pending';
  const run = uiQueueSend(queueKey, async () => {
    try {
      entry.id = await meetingCaptureSave(event, linked, entry);
      entry.state = 'saved';
      if (entry.recent && !entry.recent.some(one => one.id === entry.id)) entry.recent.push({ id: entry.id, seq: entry.seq });
      meetingCaptureUndo(event, entry);
    } catch {
      entry.state = 'fail'; // 알림은 request()가 이미 했다 — 적은 글은 그 줄에 그대로 있다
    }
    if (uiSendQueues.get(queueKey) === run.queueTail) await load();
    meetingItemsRepaint(host);
  });
  return run;
}

// 직접 적어 담은 줄도 되돌린다 — 초안 담기의 `실행 취소`와 같은 길이다: 만든 항목을 삭제 휴지통으로 옮기고(원문 보존),
// 다시 실행은 휴지통에서 되살린다. ⌘Z와 누르는 화면의 알림 `되돌리기`가 같은 기록을 쓴다.
function meetingCaptureUndo(event, entry) {
  if (!entry.id) return;
  const key = meetingCaptureKey(event);
  const record = {
    label: `${entry.text} (회의에서 적기)`,
    captureKey: key, // 입력줄의 ⌘Z가 "이 회의에서 방금 적어 담은 줄"인지 가리는 표시
    undo: async () => {
      await postJson('/api/track/remove', { id: entry.id });
      const left = (meetingCaptureLocal.get(key) || []).filter(other => other !== entry);
      if (left.length) meetingCaptureLocal.set(key, left); else meetingCaptureLocal.delete(key);
    },
    redo: async () => {
      await postJson('/api/track/restore', { id: entry.id });
      // 기록되지 않은 회의는 서버 목록이 없어 이 자리의 줄로 다시 세운다.
      if (!event.id) { entry.seen = false; meetingCaptureLocal.set(key, [...(meetingCaptureLocal.get(key) || []), entry]); }
    },
  };
  pushUndo(record);
  // 누르는 화면에는 ⌘Z가 없다 — 알림의 `되돌리기` 버튼으로 같은 기록을 되돌린다(키보드가 있는 화면에서는 조용히 담는다).
  if (uiTouchScreen()) uiUndoNotice('담았어요', null, record);
}

function meetingCaptureAdd(event, linked, entries, host) {
  const key = meetingCaptureKey(event);
  const fresh = entries.filter(entry => entry.text)
    .map(entry => ({ seq: ++meetingCaptureSeq, type: entry.type, text: entry.text, state: 'pending', id: null, fresh: true,
      // 담긴 뒤에도 이 자리를 연 동안은 `방금 담은 것`에 남도록 그 자리의 목록을 들고 간다(저장 중에 카드를 다시 열었으면 옛 목록에 남는다).
      recent: linked && host && host.getFresh ? host.getFresh() : null }));
  if (!fresh.length) return [];
  meetingCaptureLocal.set(key, [...(meetingCaptureLocal.get(key) || []), ...fresh]);
  meetingItemsRepaint(host);
  return fresh.map(entry => meetingCaptureSend(event, linked, entry, host));
}

function meetingCaptureDrop(event, entry, host) {
  const key = meetingCaptureKey(event);
  const left = (meetingCaptureLocal.get(key) || []).filter(other => other !== entry);
  if (left.length) meetingCaptureLocal.set(key, left); else meetingCaptureLocal.delete(key);
  meetingItemsRepaint(host);
}

// 아직 서버 목록에 없는 줄 — 담는 중에는 체크만 잠긴 같은 모양, 못 담았으면 그 줄에만 조용한 표시와 `다시 시도`.
function meetingLocalRow(entry, event, linked, host) {
  const failed = entry.state === 'fail';
  const row = document.createElement('div');
  row.className = 'd-mrow2 is-local' + (entry.fresh ? ' is-new' : '') + (failed ? ' is-fail' : '');
  row.dataset.moveId = `cap:${entry.seq}`; // 줄 이동 도우미의 열쇠(담는 중인 줄 — 서버 목록에 들어오면 data-task-id 줄로 바뀐다)
  entry.fresh = false; // 떠오르는 움직임은 처음 한 번만
  const cell = document.createElement('span');
  cell.className = 'ck';
  const check = document.createElement('input');
  check.type = 'checkbox';
  check.disabled = true;
  check.setAttribute('aria-label', `${entry.text} — ${failed ? '아직 담지 못했어요' : '담는 중'}`);
  if (entry.type === 'check') { check.className = 'd-wcb'; cell.appendChild(check); }
  else {
    const wrap = document.createElement('span');
    wrap.className = 'd-check';
    check.className = 'd-cb';
    wrap.appendChild(check);
    cell.appendChild(wrap);
  }
  const title = document.createElement('span');
  title.className = 'ti';
  title.textContent = entry.text;
  const right = document.createElement('span');
  right.className = 'r';
  const acts = document.createElement('span');
  acts.className = 'ac';
  if (failed) {
    const note = document.createElement('span');
    note.className = 'fail';
    note.setAttribute('role', 'alert');
    note.textContent = '못 담았어요';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'd-link';
    retry.textContent = '다시 시도';
    retry.setAttribute('aria-label', `다시 시도: ${entry.text}`);
    retry.addEventListener('click', () => {
      const run = meetingCaptureSend(event, linked, entry, host);
      meetingItemsRepaint(host);
      meetingCaptureFocus(host);
      return run;
    });
    right.append(note, retry);
    acts.appendChild(uiMoreButton(`${entry.text} — 더 보기`,
      () => [[{ label: '지우기', onClick: () => { meetingCaptureDrop(event, entry, host); meetingCaptureFocus(host); } }]]));
  } else {
    right.appendChild(meetingTypeButton(entry.type, null));
  }
  row.append(cell, title, right, acts);
  return row;
}

// `이 회의에서 나온 것`은 종류 구역(할 일 → 확인 대기 → 결정 → 아이디어 — 앱의 종류 목록 차례, 버그는 할 일)으로 나뉘고,
// 구역 안은 시간순이다: 담은 날짜순, 같은 날은 만든 순서. 항목 번호(`task_01M3…`)의 뒷부분이
// 만든 시각 순으로 커지는 값이라 그것으로 가린다(종류를 바꿔도 번호는 그대로다). 그런 번호가 아닌 옛 항목은 원래 순서를 지킨다.
const meetingItemStamp = (item) => {
  const tail = String(item.id || '').split('_').pop();
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(tail) ? tail : '';
};
function meetingItemsInOrder(items) {
  return [...(items || [])].map((item, index) => ({ item, index, stamp: meetingItemStamp(item) }))
    .sort((x, y) => String(x.item.created || '').localeCompare(String(y.item.created || ''))
      || (x.stamp && y.stamp ? (x.stamp < y.stamp ? -1 : x.stamp > y.stamp ? 1 : 0) : 0) || x.index - y.index)
    .map(entry => entry.item);
}
const meetingItemGroups = () => [...WF_TYPES, ['idea', '아이디어']];
const meetingItemGroup = type => (['check', 'decision', 'idea'].includes(type) ? type : 'task');

// 종류 구역의 소제목 — 줄 사이를 알려 주기만 하는 조용한 글자(누를 수 없다, 그룹 제목 부품이 아니다) + 조용한 숫자.
// 화면 읽기에서는 제목이라 제목 건너뛰기로 구역 사이를 옮긴다(Tab 정류장은 늘지 않는다).
function meetingSubhead(label, count) {
  const head = document.createElement('div');
  head.className = 'd-mgrp';
  head.dataset.moveId = `grp:${label}`; // 줄 이동 도우미의 열쇠 — 종류 소제목도 줄과 함께 미끄러진다
  head.setAttribute('role', 'heading');
  head.setAttribute('aria-level', '3');
  const name = document.createElement('span');
  name.textContent = label;
  const number = document.createElement('span');
  number.className = 'n num';
  number.textContent = String(count);
  head.append(name, number);
  return head;
}

// 종류를 바꿔 다른 구역으로 옮겨 가는 줄 — 그 줄만 새 줄처럼 떠오른다(.is-new 140ms, 움직임 줄이기면 120ms 흐려짐).
// 종류를 바꾸는 동안(retypeSend)만 들고 있다.
const meetingMovedIds = new Set();

function panelMeetingItems(event, box, host = MEETING_HOST_CARD) {
  const linked = !!event.id;
  const key = meetingCaptureKey(event);
  const { section, number } = meetingSection(linked ? '이 회의에서 나온 것' : '방금 담은 것', 0);
  const list = document.createElement('div');
  list.className = 'd-mlist';
  section.appendChild(list);
  // 초안도 담은 것도 없는 빈 회의에만 안내 한 줄.
  const result = host.getResult();
  const blank = linked && !(event.drafts && event.drafts.length) && !(result && result.meetingId === event.id);
  const hint = document.createElement('div');
  hint.className = 'd-hint';
  hint.textContent = '적고 Enter를 누르면 바로 담겨요.';

  const paint = () => {
    // 줄의 문구를 그 자리에서 고치는 중이면 그 입력칸을 지우지 않는다(끝나면 그 저장이 다시 그린다).
    const active = document.activeElement;
    if (active && list.contains && list.contains(active) && uiIsTextEntry(active)) return;
    const real = linked ? meetingItemsInOrder(wfMeetingItems(event.id)) : [];
    const shown = new Set(real.map(item => item.id));
    // 서버 목록에 들어온 줄은 내려놓는다. 한 번 보였다가 사라진 줄(되돌리기·삭제)도 내려놓는다.
    const local = (meetingCaptureLocal.get(key) || []).filter((entry) => {
      if (entry.state !== 'saved') return true;
      if (shown.has(entry.id)) return false;
      const found = typeof wfItem === 'function' && !!wfItem(entry.id);
      if (found) entry.seen = true;
      return found || !entry.seen;
    });
    if (local.length) meetingCaptureLocal.set(key, local); else meetingCaptureLocal.delete(key);
    // 이 자리를 연 동안 입력줄로 담은 줄은 종류 구역으로 튀어 들어가지 않고 맨 끝 `방금 담은 것`에 적은 순서대로 선다
    // (입력줄 바로 위 — 방금 적은 줄을 놓치지 않게). 다시 열면 제 종류 구역으로 간다.
    const recentSeq = new Map(((linked && host.getFresh ? host.getFresh() : null) || []).map(one => [one.id, one.seq]));
    const rows = [];
    const itemRow = (item) => {
      const row = panelMeetingRow(item, event, null, host);
      if (meetingMovedIds.has(item.id) && !recentSeq.has(item.id)) row.className += ' is-new';
      rows.push(row);
      // 체크한 확인 대기는 이 구역에 is-done으로 남는다 — 그 줄 바로 아래에 `다음은?`을 덧붙인다.
      const next = item.type === 'check' ? waitingNextItem(item.id) : null;
      if (next) rows.push(waitingNextRow(next));
    };
    const settled = real.filter(item => !recentSeq.has(item.id));
    meetingItemGroups().forEach(([type, label]) => {
      const items = settled.filter(item => meetingItemGroup(item.type) === type);
      if (!items.length) return; // 빈 구역은 소제목째 없다
      rows.push(meetingSubhead(label, items.length));
      items.forEach(itemRow);
    });
    const recent = [
      ...real.filter(item => recentSeq.has(item.id)).map(item => ({ seq: recentSeq.get(item.id), item })),
      ...local.map(entry => ({ seq: entry.seq, entry })),
    ].sort((x, y) => x.seq - y.seq);
    // 기록되지 않은 회의는 구역 제목이 이미 `방금 담은 것`이다.
    if (linked && recent.length) rows.push(meetingSubhead('방금 담은 것', recent.length));
    recent.forEach(({ item, entry }) => {
      if (item) { itemRow(item); return; }
      const saved = entry.state === 'saved' && typeof wfItem === 'function' ? wfItem(entry.id) : null;
      if (saved) { itemRow(saved); return; }
      rows.push(meetingLocalRow(entry, event, linked, host));
    });
    list.replaceChildren(...rows);
    const added = rows.find(row => String(row.className).includes('is-new'));
    const count = real.length + local.length;
    number.textContent = String(count);
    section.hidden = !count;
    hint.hidden = !blank || !!count;
    // 방금 적은 줄(또는 다른 구역으로 옮겨 간 줄)이 보이게.
    if (added && added.scrollIntoView) added.scrollIntoView({ block: 'nearest' });
    meetingTypeOrphan(host);
  };
  box.meetingRepaint = paint;
  box.append(section, hint);
  paint();
}

// 같은 이름으로 반복되는 회의라면, 지난 회차에서 아직 안 끝난 것을 여기서 같이 본다(줄마다 회차 표기).
// 종류를 바꾸면(입력줄에 초점이 있어 카드가 다시 그려지지 않아도) 이 구역도 함께 맞춘다(meetingItemsRepaint).
function panelMeetingPast(event, box, host = MEETING_HOST_CARD) {
  if (!event.series) return;
  const collect = () => {
    const meetings = (typeof workflowData === 'object' && workflowData ? workflowData.meetings : null) || [];
    const past = meetings
      .filter(other => other.id !== event.id && other.series === event.series && (other.date || '') < (event.date || ''))
      .sort((x, y) => (y.date || '').localeCompare(x.date || ''));
    const rows = [];
    past.forEach(other => wfMeetingItems(other.id).filter(item => item.status !== 'done').forEach(item => rows.push({ item, at: other.date })));
    return rows;
  };
  if (!collect().length) return;
  const { section, number } = meetingSection('이전 회차의 미해결 항목', 0);
  const list = document.createElement('div');
  list.className = 'd-mlist';
  section.appendChild(list);
  const paint = () => {
    const active = document.activeElement;
    if (active && list.contains && list.contains(active) && uiIsTextEntry(active)) return;
    const rows = collect();
    list.replaceChildren(...rows.map(({ item, at }) => panelMeetingRow(item, event, `${uiKoDateShort(at)} 회차`, host)));
    number.textContent = String(rows.length);
    section.hidden = !rows.length;
  };
  box.meetingRepaintPast = paint;
  box.appendChild(section);
  paint();
}

// 카드 발에 붙박인 입력줄 — 평소 맨 줄, 초점에서만 흰 면 + 파란 테. 칸은 저장 중에도 잠그지 않는다.
function panelMeetingCapture(event, box, linked, host = MEETING_HOST_CARD) {
  const foot = document.createElement('div');
  foot.className = 'd-dbar d-qfoot';
  const line = document.createElement('label');
  line.className = 'd-qin';
  const plus = document.createElement('span');
  plus.className = 'pl';
  plus.innerHTML = uiIcon('plus');
  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = MEETING_TEXT_MAX;
  input.placeholder = '회의에서 나온 것 적기';
  input.autocomplete = 'off';
  input.setAttribute('aria-label', '회의에서 나온 것 적기');
  input.setAttribute('enterkeyhint', 'done');
  // 앞머리(`?` `!`)를 치는 동안 어떤 종류로 담길지 오른쪽에 조용히 알려 준다.
  const kind = document.createElement('span');
  kind.className = 'as';
  kind.setAttribute('aria-live', 'polite');
  const showKind = () => {
    const { type } = meetingCaptureParse(input.value);
    kind.textContent = type === 'task' ? '' : wfType(type);
  };
  // 마지막으로 칸을 비운 뒤 이 칸에서 글을 친 적이 있는지 — 있으면 ⌘Z는 브라우저의 글자 되돌리기 몫이다.
  let typed = false;
  input.addEventListener('input', () => { typed = true; showKind(); });
  input.addEventListener('keydown', (keyEvent) => {
    // 칸이 비어 있을 때의 ⌘Z는 **이 회의에서 방금 적어 담은 줄**만 되돌린다(⇧⌘Z는 그 줄을 다시 담는다) — 초점이 입력줄을
    // 떠나지 않아도 되게. 그 밖에는 가로채지 않는다: 글을 적는 중이거나, 이 칸에서 치다 지운 글이 있거나(브라우저의 글자
    // 되돌리기가 살릴 수 있다), 되돌리기 맨 위 기록이 다른 일(초안 빼기·다른 화면의 작업)일 때.
    if ((keyEvent.metaKey || keyEvent.ctrlKey) && !keyEvent.altKey && String(keyEvent.key).toLowerCase() === 'z' && !input.value && !typed) {
      const key = meetingCaptureKey(event);
      const redo = !!keyEvent.shiftKey;
      const mine = () => { const stack = redo ? redoStack : undoStack; const top = stack[stack.length - 1]; return !!top && top.captureKey === key; };
      // 아직 저장 중인 줄이 있으면 끝나기를 기다렸다가 그 줄을 되돌린다(그 줄의 기록은 저장이 끝나야 생긴다).
      const waiting = !redo && (meetingCaptureLocal.get(key) || []).some(entry => entry.state === 'pending');
      if (!waiting && !mine()) return;
      if (keyEvent.preventDefault) keyEvent.preventDefault();
      return Promise.resolve(waiting ? uiSendQueues.get(meetingCaptureQueue(event)) : null)
        .then(() => (mine() ? replayUndo(redo ? 'redo' : 'undo').then(() => meetingItemsRepaint(host)) : null));
    }
    if (keyEvent.key !== 'Enter' || keyEvent.isComposing) return; // 한글을 조합하는 중의 Enter는 글자를 확정하는 것이다
    if (keyEvent.preventDefault) keyEvent.preventDefault();
    const raw = input.value;
    if (!raw.trim()) return;
    input.value = ''; // 칸을 먼저 비운다 — 잠그지 않으니 곧바로 다음 줄을 칠 수 있다
    typed = false;
    kind.textContent = '';
    return Promise.all(meetingCaptureAdd(event, linked, [meetingCaptureParse(raw)], host));
  });
  // 여러 줄을 붙여 넣으면 줄마다 한 건(한 줄짜리는 평소처럼 칸에 붙는다).
  input.addEventListener('paste', (pasteEvent) => {
    const data = pasteEvent.clipboardData || (typeof window === 'object' ? window.clipboardData : null);
    const text = data ? data.getData('text') : '';
    if (!/\n/.test(String(text).trim())) return;
    pasteEvent.preventDefault();
    const entries = meetingCaptureLines(text);
    if (entries.length > MEETING_PASTE_MAX) {
      showNotice(`한 번에 ${MEETING_PASTE_MAX}줄까지 담을 수 있어요(지금 ${entries.length}줄). 나눠서 붙여 넣어 주세요`, true);
      return;
    }
    const long = entries.filter(entry => entry.text.length > MEETING_TEXT_MAX).length;
    if (long) {
      showNotice(`한 줄은 ${MEETING_TEXT_MAX}자까지 담을 수 있어요(넘는 줄 ${long}개). 줄을 나눠서 붙여 넣어 주세요`, true);
      return;
    }
    return Promise.all(meetingCaptureAdd(event, linked, entries, host));
  });
  line.append(plus, input, kind);
  foot.appendChild(line);
  box.meetingInput = input;
  box.appendChild(foot);
}

// ---------- 회의 프로젝트를 연결·변경·해제한 뒤: 이미 담은 것도 옮길까요·뺄까요? ----------
// 회의 상세(카드·회의 탭)의 ⋯에서 프로젝트를 바꾸면 머리 아래에 조용한 확인 줄(`.d-jline` — 빈 에픽 옮기기 제안과
// 같은 부품)이 선다. 오늘 탭 레일의 미팅 줄 ⋯에서 바꾸면 줄을 세울 자리가 없어 알림의 버튼으로 묻는다.
// 대상(순수 함수 meetingMoveCandidates):
//   - 연결·변경(A → B): 이 회의 항목 중 **프로젝트가 없거나 이전 프로젝트(A)에 있던 것**만. 사람이 따로 다른
//     프로젝트(C)로 옮겨 둔 것은 덮지 않고 `M개는 다른 프로젝트라 그대로 둬요`로만 알린다.
//   - 해제(A → 없음): A에 있는 항목만 뺀다.
//   - 끝낸 항목은 옮기지 않는다(주간요약 같은 지난 기록이 바뀌지 않게) — `끝낸 K개는 그대로`.
//   - 아이디어도 대상이다(서버가 아이디어의 프로젝트 칸으로 바꾼다). 반복 회의의 지난 회차 항목은 대상이 아니다.
// 옮길 것이 0개면 묻지 않는다. `그대로`·무시는 아무것도 보내지 않는다. 확인 줄이 떠 있는 채로 또 바꾸면 처음의
// 이전 프로젝트(아직 아무것도 옮기지 않았으므로)를 기준으로 새 목적지에 맞춰 줄을 다시 그린다.
const MEETING_MOVE_KINDS = ['task', 'bug', 'check', 'decision', 'idea'];
let meetingMoveAsk = null; // { meetingId, from, to, busy }
const meetingMoveNormKey = key => (!key ? null : String(key).startsWith('group:') ? `group:${wfGroupName(String(key).slice('group:'.length)).trim()}` : String(key));
function meetingMoveCandidates(items, from, to) {
  const was = meetingMoveNormKey(from), want = meetingMoveNormKey(to);
  const kinds = (items || []).filter(item => MEETING_MOVE_KINDS.includes(item.type));
  const keyOf = item => meetingMoveNormKey(wfKey(item));
  // 목적지 묶음(BBUNDLE)에 이미 든 티켓의 항목은 "이미 그 프로젝트"로 본다 — 옮기지도, `다른 프로젝트`로 세지도 않는다.
  // 옮기는 대상은 예전 그대로 없음·이전 키 정확 일치뿐이다(서버 move-items가 from을 정확히 다시 확인한다).
  const inWant = key => !!want && !!key && (key === want || (typeof projectGroupKey === 'function' && projectGroupKey(key) === projectGroupKey(want)));
  const eligible = kinds.filter((item) => {
    const key = keyOf(item);
    if (key === want || inWant(key)) return false;
    return want ? (!key || (!!was && key === was)) : (!!was && key === was);
  });
  const open = eligible.filter(item => item.status !== 'done');
  // 다른 프로젝트(C)에 있어 그대로 두는 것 — 끝내지 않은 것만 센다(끝낸 것은 어차피 그대로다). 해제에는 말하지 않는다.
  const other = want ? kinds.filter((item) => { const key = keyOf(item); return item.status !== 'done' && key && !inWant(key) && key !== was; }).length : 0;
  return { ids: open.map(item => item.id), done: eligible.length - open.length, other };
}
// 프로젝트 열쇠 → 화면 이름(지라는 요약·별칭).
function meetingMoveName(key) {
  if (!key) return '';
  const at = key.indexOf(':');
  const type = key.slice(0, at), value = key.slice(at + 1);
  return uiProjectName(type === 'jira' ? { jira: value } : { group: value }) || value;
}
function meetingMoveWords({ ids, done, other }, from, to) {
  const extra = [
    other ? `${other}개는 다른 프로젝트라 그대로 둬요` : '',
    done ? `끝낸 ${done}개는 그대로` : '',
  ].filter(Boolean);
  const tail = extra.length ? ` (${extra.join(' · ')})` : '';
  if (!to) return `이 회의 항목 ${ids.length}개도 「${meetingMoveName(from)}」에서 뺄까요?${tail}`;
  const name = meetingMoveName(to);
  return `이 회의에서 이미 담은 ${ids.length}개도 「${name}」${uiRoParticle(name)} 옮길까요?${tail}`;
}
function meetingMoveAskOpen(meetingId, from, to, host = MEETING_HOST_CARD) {
  const base = meetingMoveAsk && meetingMoveAsk.meetingId === meetingId && !meetingMoveAsk.busy ? meetingMoveAsk.from : from;
  meetingMoveAsk = { meetingId, from: meetingMoveNormKey(base), to: meetingMoveNormKey(to), busy: false };
  host.redraw();
}
function meetingMoveAskNode(event, host = MEETING_HOST_CARD) {
  const ask = meetingMoveAsk;
  if (!ask || ask.meetingId !== event.id) return null;
  // 그 사이 프로젝트가 또 바뀌었으면(다른 기기) 묻던 것이 뜻을 잃는다.
  if (meetingMoveNormKey(wfMeetingKey(event)) !== ask.to) { meetingMoveAsk = null; return null; }
  const picked = meetingMoveCandidates(wfMeetingItems(event.id), ask.from, ask.to);
  if (!picked.ids.length) { if (!ask.busy) meetingMoveAsk = null; return null; }
  const line = document.createElement('div');
  line.className = 'd-jline d-mmove';
  line.setAttribute('role', 'status');
  line.dataset.moveId = `mv:${event.id}`; // 줄 부품의 열쇠 — 확인 줄이 나타나고 사라질 때(펼침 부품)
  const words = document.createElement('span');
  words.textContent = meetingMoveWords(picked, ask.from, ask.to);
  const sep1 = document.createElement('span'); sep1.className = 'sep'; sep1.textContent = '·';
  const verb = ask.to ? '옮기기' : '빼기';
  const move = document.createElement('button');
  move.type = 'button'; move.className = 'd-link';
  move.textContent = ask.busy ? `${ask.to ? '옮기는' : '빼는'} 중…` : verb;
  move.disabled = !!ask.busy;
  move.addEventListener('click', () => meetingMoveRun(event.id, picked.ids, ask, host));
  const sep2 = document.createElement('span'); sep2.className = 'sep'; sep2.textContent = '·';
  const keep = document.createElement('button');
  keep.type = 'button'; keep.className = 'd-link';
  keep.textContent = '그대로';
  keep.disabled = !!ask.busy;
  keep.addEventListener('click', () => { meetingMoveAsk = null; host.redraw(); });
  line.append(words, sep1, move, sep2, keep);
  return line;
}
async function meetingMoveSend(route, body) {
  const response = await postJson(route, body);
  return response.json();
}
// 서버로 보내고 ⌘Z·알림 되돌리기를 건다 — 확인 줄과 레일 알림이 함께 쓴다.
// 서버는 from(어디서 옮기는지)으로 지금 자리를 다시 보고, 그 사이 바뀐 항목·끝낸 항목은 건너뛴다(skipped).
// ⇧⌘Z 다시 실행도 같은 from을 보내 같은 규칙을 탄다.
async function meetingMoveCommit(meetingId, ids, from, to) {
  const result = await meetingMoveSend('/api/meeting/move-items', { meetingId, project: to, from: from || null, ids });
  await load();
  const moved = result.moved || [];
  const skipped = result.skipped || 0;
  const skippedText = skipped ? ` · ${skipped}개는 그사이 바뀌어 그대로 뒀어요` : '';
  if (!moved.length) {
    if (skipped) showNotice(`옮길 항목이 없어요${skippedText}`);
    return result;
  }
  const entry = {
    label: `회의 항목 ${moved.length}개 ${to ? '옮기기' : '빼기'}`,
    undo: () => meetingMoveSend('/api/meeting/move-items-undo', { meetingId, project: to, moved }),
    redo: () => meetingMoveSend('/api/meeting/move-items', { meetingId, project: to, from: from || null, ids: moved.map(item => item.id) }),
  };
  pushUndo(entry);
  const text = (to ? `${moved.length}개를 「${meetingMoveName(to)}」${uiRoParticle(meetingMoveName(to))} 옮겼어요`
    : `${moved.length}개를 「${meetingMoveName(from)}」에서 뺐어요`) + skippedText;
  showNotice(text, false, null, {
    label: '되돌리기',
    onClick: async () => {
      if (undoStack[undoStack.length - 1] !== entry) { showNotice('최근 작업부터 순서대로 실행 취소해 주세요', true); return; }
      await replayUndo('undo');
    },
  });
  return result;
}
async function meetingMoveRun(meetingId, ids, ask, host = MEETING_HOST_CARD) {
  if (!meetingMoveAsk || meetingMoveAsk.busy) return;
  meetingMoveAsk = { ...meetingMoveAsk, busy: true };
  host.redraw();
  try {
    await meetingMoveCommit(meetingId, ids, ask.from, ask.to);
  } catch {
    // request()가 이미 알렸다 — 줄은 그대로 두고 다시 누를 수 있게 한다.
    if (meetingMoveAsk) meetingMoveAsk = { ...meetingMoveAsk, busy: false };
    host.redraw();
    return;
  }
  meetingMoveAsk = null;
  host.redraw();
}
// 오늘 탭 레일의 미팅 줄 ⋯에서 바꿨을 때 — 확인 줄 자리가 없으니 알림의 버튼으로 묻는다(무시하면 아무것도 안 한다).
function meetingMoveOffer(meetingId, from, to) {
  if (!meetingId) return;
  const picked = meetingMoveCandidates(wfMeetingItems(meetingId), from, to);
  if (!picked.ids.length) return;
  const label = `이미 담은 ${picked.ids.length}개도 ${to ? '옮기기' : '빼기'}`;
  showNotice(to ? `「${meetingMoveName(to)}」${uiRoParticle(meetingMoveName(to))} 연결했어요` : `「${meetingMoveName(from)}」 연결을 뺐어요`, false, null, {
    label,
    onClick: async (button) => {
      if (button) button.disabled = true;
      try { await meetingMoveCommit(meetingId, picked.ids, meetingMoveNormKey(from), meetingMoveNormKey(to)); }
      catch { if (button) button.disabled = false; }
    },
  });
}

// 담기 기본 프로젝트 — `{ type: 'jira', value }`가 묶음에 들어 있으면 대표 티켓으로 바꾼다. 그 밖은 그대로.
function meetingCaptureProject(project) {
  if (!project || project.type !== 'jira' || typeof projectGroupKey !== 'function') return project;
  const lead = projectGroupKey(`jira:${project.value}`);
  return lead === `jira:${project.value}` ? project : { ...project, value: lead.slice('jira:'.length) };
}

// 이미 적어 둔 항목을 이 회의에서 나온 것으로 연결한다(같은 프로젝트의 항목만 후보로).
function panelMeetingLink(event, box, host = MEETING_HOST_CARD) {
  const key = typeof wfMeetingKey === 'function' ? wfMeetingKey(event) : null;
  const items = (typeof workflowData === 'object' && workflowData ? workflowData.items : null) || [];
  // 묶음(BBUNDLE)이면 묶인 티켓 전부가 같은 프로젝트다.
  const same = typeof projectGroupKey === 'function' ? (a, b) => projectGroupKey(a) === projectGroupKey(b) : (a, b) => a === b;
  const candidates = items.filter(item => !item.meetingId && (!key || same(wfKey(item), key)));
  const section = document.createElement('details');
  section.className = 'd-dsec d-msec d-dadd';
  const label = document.createElement('summary');
  label.className = 'lbl';
  label.innerHTML = uiIcon('chevron');
  label.append('기존 항목 연결');
  section.appendChild(label);
  if (!candidates.length) {
    const none = document.createElement('p');
    none.className = 'd-gpnone';
    none.textContent = '연결할 항목이 없어요';
    section.appendChild(none);
    box.appendChild(section);
    return;
  }

  // 고르는 곳은 앱의 프로젝트 고르기와 같은 목록(uiPickList)이다 — 누르면 그 자리에서 펼쳐지고(8개 이상이면 찾기 칸),
  // 고른 항목 이름이 버튼에 남는다. 실제 연결은 `회의에 연결`을 눌러야 한다.
  const entries = candidates.map(item => ({
    type: 'option', value: item.id, text: item.description, key: wfType(item.type), level: 0,
    selected: false, find: [item.description, wfType(item.type)],
  }));
  let chosen = '';
  const row = document.createElement('div');
  row.className = 'd-dcap';
  const slot = document.createElement('div');
  slot.className = 'd-dpickslot';
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'd-msel d-mpickbtn';
  trigger.setAttribute('aria-haspopup', 'listbox');
  const paint = () => {
    const item = candidates.find(entry => entry.id === chosen);
    trigger.textContent = item ? item.description : '항목 선택';
    trigger.title = trigger.textContent;
    trigger.setAttribute('aria-label', `이 회의에서 나온 항목 선택: ${trigger.textContent}`);
  };
  paint();
  let open = false;
  const restore = (focus) => {
    if (open) { open = false; slot.replaceChildren(trigger); }
    if (focus) trigger.focus();
  };
  trigger.addEventListener('click', () => {
    entries.forEach((entry) => { entry.selected = entry.value === chosen; });
    const picker = uiPickList({
      entries,
      label: '이 회의에서 나온 항목',
      search: uiPickSearchable(entries),
      placeholder: '문구로 찾기',
      emptyText: '찾는 항목이 없어요',
      onPick: (value) => { chosen = value; paint(); restore(true); },
      onClose: byKeyboard => restore(byKeyboard),
    });
    open = true;
    slot.replaceChildren(picker);
    picker.focusStart();
  });
  slot.appendChild(trigger);
  row.append(slot, panelRunButton('회의에 연결', async () => {
    if (!chosen) return;
    await wfPost('link', { id: chosen, meetingId: event.id });
    await meetingLoadRedraw(host);
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
  key: null, unresolved: false, reviewOnly: false,
  windowDays: MEETINGS_TAB_WINDOW_DAYS, showNoRecord: false, result: null, fresh: null,
};

// 목록을 훑는 두 보기 — `날짜순`(기본)과 `프로젝트별`. 프로젝트로 거르던 드롭다운은 없앴고,
// "한 프로젝트만 보기"는 프로젝트별 보기에서 다른 소제목을 접는 것으로 대신한다(BMGROUP 결정).
// 고른 보기만 브라우저에 기억하고(확인 대기 카드의 보기 전환과 같은 규칙), 접어 둔 프로젝트는
// 세션 동안만 기억한다 — 다시 열었을 때 회의가 숨어 있으면 안 된다.
const MEETINGS_VIEW_KEY = 'meetingsView';
let meetingsTabView = 'date';
try { meetingsTabView = localStorage.getItem(MEETINGS_VIEW_KEY) === 'project' ? 'project' : 'date'; } catch {}
const meetingsTabClosed = new Set();
// 부제목의 프로젝트 이름을 눌러 보기를 바꾼 뒤 그 소제목으로 한 번만 스크롤하려고 잠깐 들고 있는 자리.
let meetingsScrollTo = null;
function setMeetingsView(value) {
  const next = value === 'project' ? 'project' : 'date';
  if (meetingsTabView === next) return;
  meetingsTabView = next;
  try { localStorage.setItem(MEETINGS_VIEW_KEY, meetingsTabView); } catch {}
  renderMeetings();
}

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

// `더 보기`를 누르면 새로 나올 회의들(순수 함수): 지금 기간보다 오래됐고, 눌렀을 때 실제로 줄이 늘어나는 것만.
// 기간 밖이라도 손댈 일이 남은 회의는 이미 보이고 있고, 기록 없는 회의는 `빈 회의 포함`을 켰을 때만 나온다.
function meetingsBeyondWindow(meetings, today, windowDays, { showNoRecord = false, itemsOf } = {}) {
  return (meetings || []).filter(event => (event.date || '') < today && daysBeforeToday(event.date, today) > windowDays
    && !meetingHasOpenWork(event, itemsOf) && (showNoRecord || meetingHasRecord(event, itemsOf)));
}

// `이전 회의 더 보기`를 보일지(순수 함수): 더 넓힐 것이 하나라도 남아 있으면 보인다.
function meetingsHasMoreBeyond(meetings, today, windowDays, opts = {}) {
  return meetingsBeyondWindow(meetings, today, windowDays, opts).length > 0;
}

// 목록 거르기(순수 함수). 필터(초안 있음·미완료만)를 하나라도 켜면 찾는 행동이므로 기간·기록 제한 없이
// 전체 회의에서 거른다. 아무 필터도 없으면 기본 목록 범위만 본다. 차례는 날짜 내림차순(같은 날은 시각 순)
// — 훑어보는 면이라 "언제"가 먼저다. 프로젝트는 여기서 거르지 않는다(프로젝트별 보기가 대신한다).
function meetingsTabList(meetings, state, itemsOf) {
  const today = state.today || todayStr();
  const filtering = !!(state.unresolved || state.reviewOnly);
  const pool = filtering ? (meetings || []) : meetingsBaseScope(meetings, {
    today, windowDays: state.windowDays || MEETINGS_TAB_WINDOW_DAYS, showNoRecord: !!state.showNoRecord, itemsOf,
  });
  return palMeetings(pool, { type: 'meeting', unresolved: !!state.unresolved, reviewOnly: !!state.reviewOnly, today }, itemsOf)
    .sort(wfMeetingOrder);
}

// 회의 탭 프로젝트별 보기의 소제목 열쇠 — 묶음(BBUNDLE)에 든 지라 티켓이면 대표 키 하나로 모인다(projectGroupKey).
function meetingGroupKey(event) {
  const key = wfMeetingKey(event);
  return (key && typeof projectGroupKey === 'function' ? projectGroupKey(key) : key) || '__misc__';
}

// 프로젝트별 보기의 묶음(순수 함수). 목록은 이미 날짜 내림차순이라 묶음 안의 차례는 그대로 두고,
// 묶음끼리의 차례만 정한다: **미완료 항목이 남은 프로젝트가 먼저**, 그 안에서는 가장 최근 회의 날짜순.
// `프로젝트 없음`은 언제나 맨 끝이다.
function meetingsTabGroups(rows, itemsOf) {
  const groups = new Map();
  (rows || []).forEach((event) => {
    const key = meetingGroupKey(event);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  });
  return [...groups].map(([key, list]) => ({
    key,
    list,
    open: list.reduce((sum, event) => sum + meetingUnresolvedCount(event, itemsOf), 0),
    latest: list.reduce((at, event) => ((event.date || '') > at ? (event.date || '') : at), ''),
  })).sort((a, b) => (a.key === '__misc__' ? 1 : 0) - (b.key === '__misc__' ? 1 : 0)
    || (a.open ? 0 : 1) - (b.open ? 0 : 1)
    || b.latest.localeCompare(a.latest));
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
// `방금 담은 것`도 내린다 — 돌아오면 그 줄들은 제 종류 구역에 선다.
function meetingsTabSelect(id) {
  if (meetingsTabState.key === id) return;
  meetingsTabState.key = id;
  meetingsTabState.result = null;
  meetingsTabState.fresh = null;
}

// 목록 밖의 회의를 열 때: 가리고 있는 조건을 풀어서라도 보이게 한다 — 오른쪽 내용은 반드시 열려야 한다.
// (단순한 쪽을 고른다: 새 줄을 끼워 넣지 않고 막고 있는 필터를 끄거나 보이는 기간을 그 회의가 들어올 만큼 넓힌다.)
function meetingsTabRevealIfNeeded(id) {
  const event = ((workflowData && workflowData.meetings) || []).find(item => item.id === id);
  if (!event) return;
  const itemsOf = typeof wfMeetingItems === 'function' ? wfMeetingItems : null;
  if (meetingsTabState.reviewOnly && !(event.drafts && event.drafts.length)) meetingsTabState.reviewOnly = false;
  if (meetingsTabState.unresolved && meetingUnresolvedCount(event, itemsOf) === 0) meetingsTabState.unresolved = false;
  // 프로젝트별 보기에서 그 프로젝트를 접어 뒀으면 펼친다 — 고른 회의 줄은 반드시 보여야 한다.
  meetingsTabClosed.delete(meetingGroupKey(event));
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

// 저장 뒤 다시 그리기 — 회의 탭은 load()가 이미 그렸으면(입력 중이라 미루지 않았으면) 다시 그리지 않는다.
// 같은 틱에 두 번 그리면 첫 그리기의 줄 움직임(새 줄 떠오름·완료 긋기 기다림)이 둘째 그리기에 지워진다(보고의 draw: false와 같은 까닭).
let meetingsDrawSeq = 0; // renderMeetingsNow마다 하나씩 는다
async function meetingLoadRedraw(host) {
  const seen = meetingsDrawSeq;
  await load();
  if (host.kind === 'tab' && meetingsDrawSeq !== seen) return;
  host.redraw();
}

// 왼쪽 목록과 오른쪽 회의 정리를 줄 부품(uiRowsMove)으로 감싸 그린다 — 오른쪽은 카드를 통째로 새로 만들므로
// 늘 있는 자리(meetingBody)를 목록으로 잰다. 두 자리는 옆으로 놓여 서로 밀지 않아 무리로 묶지 않는다.
// 다른 회의를 고르면 오른쪽은 다른 내용이다(화면 전환) — 옛 줄이 흐려지고 새 줄이 떠오르지 않게 오른쪽은 재지 않고 그린다.
function renderMeetings() {
  const listEl = document.getElementById('meetingList');
  const body = document.getElementById('meetingBody');
  if (!listEl || !body) return;
  const was = body.dataset.meetingFor;
  const draw = () => renderMeetingsNow(listEl, body);
  // 그리는 안에서 고른 회의가 바뀌면(거르기 칩·담기·보던 회의가 사라짐) 그린 뒤에 알게 된다 — 그때는 오른쪽 잰 것을 버린다.
  const drawBody = () => { draw(); if (body.dataset.meetingFor !== was) uiGlideForget(body); };
  uiRowsMove(listEl, was === String(meetingsTabState.key) ? () => uiRowsMove(body, drawBody) : draw);
}
function renderMeetingsNow(listEl, body) {
  meetingsDrawSeq += 1;
  const meetings = (workflowData && workflowData.meetings) || [];
  const itemsOf = typeof wfMeetingItems === 'function' ? wfMeetingItems : null;
  const today = todayStr();
  const filtering = !!(meetingsTabState.unresolved || meetingsTabState.reviewOnly);
  const rows = meetingsTabList(meetings, meetingsTabState, itemsOf);
  const picked = meetingsTabPick(rows, meetingsTabState.key, today, nowHHMM());
  if (picked !== meetingsTabState.key) meetingsTabState.fresh = null; // 다른 회의로 넘어가면 `방금 담은 것`도 내린다
  meetingsTabState.key = picked;

  listEl.replaceChildren();
  const head = document.createElement('div');
  head.className = 'd-rhd';
  const headName = document.createElement('span');
  headName.textContent = '회의';
  const headCount = document.createElement('span');
  headCount.className = 'n num';
  headCount.textContent = rows.length;
  head.append(headName, headCount);
  // 머리 오른쪽 끝 — 오늘 가져올 미팅 노트가 있으면 버튼(+개수), 없으면 조용한 상태 글자 + `다시 확인`.
  const notesLast = [];
  if (meetingNotesState.used !== false) {
    const pending = meetingNotesPendingToday();
    if (pending > 0) {
      const spacer = document.createElement('span');
      spacer.className = 'sp';
      head.append(spacer, meetingNotesButton('오늘 것 모두 가져오기', 'today', 'd-btn sm', pending));
    } else {
      const idle = document.createElement('div');
      idle.className = 'd-mtlast';
      const label = document.createElement('span');
      label.textContent = meetingNotesStartedToday() ? '오늘 미팅 노트는 다 가져왔어요' : '아직 가져올 미팅 노트가 없어요';
      idle.append(label, meetingNotesButton('다시 확인', 'today', 'd-link'));
      notesLast.push(idle);
    }
    // 그 아래에 오늘 가져온 기록 한 줄(목록 칸이 좁아 머리줄에 같이 두면 글자가 잘린다).
    const last = meetingNotesLastText();
    if (last) {
      const note = document.createElement('div');
      note.className = 'd-mtlast';
      note.textContent = last;
      notesLast.push(note);
    }
  }
  listEl.append(head, ...notesLast, meetingsTabFilters());

  // 필터가 걸려 있으면 전체에서 찾은 것이니 기간 더 보기는 의미가 없다.
  const beyond = filtering ? [] : meetingsBeyondWindow(meetings, today,
    meetingsTabState.windowDays || MEETINGS_TAB_WINDOW_DAYS,
    { showNoRecord: !!meetingsTabState.showNoRecord, itemsOf });

  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'd-rempty';
    empty.textContent = meetings.length ? '고른 조건에 맞는 회의가 없어요.' : '아직 회의가 없어요 · 캘린더를 연결하거나(설정 > 연동) 회의 정리에서 직접 만들 수 있어요';
    listEl.appendChild(empty);
  } else if (meetingsTabView === 'project') {
    meetingsTabProjectRows(listEl, rows, beyond, itemsOf);
  } else {
    meetingsTabDateRows(listEl, rows, today);
  }

  // 날짜순은 목록 끝에 한 줄, 프로젝트별은 프로젝트마다 한 줄이라 그 안에서 이미 붙였다
  // (어느 프로젝트에도 걸리지 않은 것이 남았을 때만 끝에 한 줄 더).
  if (beyond.length && (meetingsTabView !== 'project' || meetingsTabBeyondRest(rows, beyond))) {
    listEl.appendChild(meetingsMoreRow('이전 회의 더 보기'));
  }

  renderMeetingDetail(body, rows.find(event => event.id === meetingsTabState.key) || null);
  body.dataset.meetingFor = String(meetingsTabState.key); // 오른쪽에 그린 회의 — 다음 그리기가 같은 회의인지 본다(renderMeetings)
}

// 날짜순 — 날짜별 조용한 소제목(묶음을 알려 주기만 한다, 개수·칩 없음) 아래로 줄이 선다.
function meetingsTabDateRows(listEl, rows, today) {
  let lastDate = null;
  rows.forEach((event) => {
    if (event.date !== lastDate) {
      lastDate = event.date;
      const day = document.createElement('div');
      day.className = 'd-mtday';
      day.dataset.moveId = `grp:day:${event.date}`; // 줄 이동 도우미의 열쇠 — 날짜 소제목도 줄과 함께 미끄러진다
      day.textContent = event.date === today ? '오늘' : uiKoDate(event.date);
      listEl.appendChild(day);
    }
    listEl.appendChild(meetingsTabRow(event));
  });
}

// 프로젝트별 — 프로젝트 소제목(색 점 + 이름 + 회의 수) 아래로 그 프로젝트의 회의가 날짜 내림차순으로 선다.
// 소제목을 누르면 접히고(세션 동안만 기억), 날짜 소제목이 없으니 줄에 날짜를 함께 적는다.
function meetingsTabProjectRows(listEl, rows, beyond, itemsOf) {
  const groups = meetingsTabGroups(rows, itemsOf);
  const labels = uiGroupLabels(groups.map(group => group.key));
  groups.forEach(({ key, list }) => {
    const open = !meetingsTabClosed.has(key);
    const heading = uiGroupHeading(labels.get(key), list.length, {
      projectName: key === '__misc__' ? null : key,
      open,
      onToggle: () => {
        if (meetingsTabClosed.has(key)) meetingsTabClosed.delete(key);
        else meetingsTabClosed.add(key);
        renderMeetings();
      },
    });
    heading.dataset.mproject = key;
    const status = meetingsProjectStatus(key);
    if (status) heading.appendChild(status);
    listEl.appendChild(heading);
    if (meetingsScrollTo === key) { meetingsScrollTo = null; heading.scrollIntoView?.({ block: 'nearest' }); }
    if (!open) return;
    list.forEach(event => listEl.appendChild(meetingsTabRow(event, { withDate: true })));
    const more = beyond.filter(event => meetingGroupKey(event) === key).length;
    if (more) listEl.appendChild(meetingsMoreRow(`더 보기 ${more}`, 'd-mmore is-in'));
  });
}

// 프로젝트별 보기에서 어느 소제목 아래에도 붙지 않는 `더 보기`가 남았는지(지금 목록에 줄이 하나도 없는 프로젝트).
function meetingsTabBeyondRest(rows, beyond) {
  const listed = new Set((rows || []).map(event => meetingGroupKey(event)));
  return beyond.some(event => !listed.has(meetingGroupKey(event)));
}

// 보이는 기간을 14일씩 넓히는 조용한 글자 줄 — 목록 끝과 프로젝트 소제목 아래가 같은 부품을 쓴다.
function meetingsMoreRow(text, className = 'd-mmore') {
  const more = document.createElement('div');
  more.className = className;
  const link = document.createElement('button');
  link.type = 'button';
  link.className = 'd-link';
  link.textContent = text;
  link.addEventListener('click', () => {
    meetingsTabState.windowDays = (meetingsTabState.windowDays || MEETINGS_TAB_WINDOW_DAYS) + MEETINGS_TAB_WINDOW_DAYS;
    renderMeetings();
  });
  uiFoldKey(link, 'mtg:more'); // 더 그린 회의 줄은 줄 부품이 펼침 값(위 4px, --t-unfold)으로 띄운다
  more.appendChild(link);
  return more;
}

// 프로젝트 소제목 옆의 조용한 글자 — 지라 프로젝트(또는 손으로 연결한 그룹)의 지금 상태 이름을
// 범주 색으로 적는다(BJCOLOR 규칙). 앱이 그 티켓을 들고 있지 않으면 아무것도 붙이지 않는다.
// jiraIssuesByKey는 **목록 모양**이다 — 상태는 글자(`status: '진행 중'`), 범주는 맨 위 칸(`category`).
// 범주가 없으면(대비책 파일에서 온 목록) 색을 정할 수 없어 붙이지 않는다.
function meetingsProjectStatus(key) {
  if (key === '__misc__') return null;
  const issue = jiraIssuesByKey.get(jiraKeyOf(key));
  const name = issue && typeof issue.status === 'string' ? issue.status : '';
  if (!name || !issue.category) return null;
  const tone = jiraStatusTone(issue.category);
  const note = document.createElement('span');
  note.className = 'js' + (tone ? ` ${tone}` : '');
  note.title = '지라에 적힌 지금 상태예요';
  note.textContent = name;
  return note;
}

// 회의 정리 화면 부제목의 프로젝트 이름을 누르면 오는 길 — 왼쪽 목록을 `프로젝트별`로 바꾸고
// 그 프로젝트만 펼친 뒤(다른 프로젝트는 접는다) 그 소제목으로 스크롤한다. 드롭다운으로 하던
// "한 프로젝트만 보기"를 대신하는 자리다.
function meetingsShowProject(raw) {
  // 부제목 링크는 회의에 걸린 원래 키를 준다 — 묶음이면 소제목 열쇠(대표 키)로 옮겨 찾는다.
  const key = typeof projectGroupKey === 'function' ? projectGroupKey(raw) : raw;
  const meetings = (workflowData && workflowData.meetings) || [];
  meetingsTabClosed.clear();
  meetings.forEach((event) => {
    const other = meetingGroupKey(event);
    if (other !== key) meetingsTabClosed.add(other);
  });
  meetingsTabView = 'project';
  try { localStorage.setItem(MEETINGS_VIEW_KEY, meetingsTabView); } catch {}
  meetingsScrollTo = key;
  renderMeetings();
}

// 목록 위의 보기 전환 세그먼트 + 조용한 토글 칩 — 팔레트에 있던 회의 전용 필터가 이 자리로 왔다.
function meetingsTabFilters() {
  const bar = document.createElement('div');
  bar.className = 'd-mfil';
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', '회의 거르기');
  const chip = (text, on, onPick, hint) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'd-chip' + (on ? ' is-on' : '');
    button.textContent = text;
    // 이름은 줄에 들어가야 해서 짧게 두고, 무슨 뜻인지는 툴팁(title)과 읽어 주는 설명(aria-description)이 푼다.
    if (hint) { button.title = hint; button.setAttribute('aria-description', hint); }
    button.setAttribute('aria-pressed', String(!!on));
    button.addEventListener('click', () => { onPick(); renderMeetings(); });
    bar.appendChild(button);
  };
  chip('초안 있음', meetingsTabState.reviewOnly, () => { meetingsTabState.reviewOnly = !meetingsTabState.reviewOnly; });
  chip('미완료만', meetingsTabState.unresolved, () => { meetingsTabState.unresolved = !meetingsTabState.unresolved; });
  // 조용한 토글 — 기본은 꺼짐, 켜면 보이는 기간 안의 기록 없는 지난 회의도 함께 나온다.
  // 칩 이름은 짧게 두고 무슨 뜻인지는 툴팁이 풀어 준다(줄에 들어가야 하는 이름이다).
  chip('빈 회의 포함', meetingsTabState.showNoRecord, () => { meetingsTabState.showNoRecord = !meetingsTabState.showNoRecord; },
    '아무것도 담지 않은 회의도 함께 보여요');
  bar.appendChild(meetingsViewSegment());
  return bar;
}

// 보기 전환 `날짜순 | 프로젝트별` — 아이디어·결정 머리와 같은 세그먼트 부품이다(보기 전환이라 aria-pressed).
function meetingsViewSegment() {
  const seg = document.createElement('div');
  seg.className = 'd-seg d-mseg';
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', '회의 목록 보기');
  [['date', '날짜순'], ['project', '프로젝트별']].forEach(([value, text]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.setAttribute('aria-pressed', String(meetingsTabView === value));
    button.addEventListener('click', () => setMeetingsView(value));
    seg.appendChild(button);
  });
  return seg;
}

// 목록 한 줄: 시각 | 제목 + `● 프로젝트` | 상태(`초안 N` 배지 · `미완료 N` 조용한 글자).
// 프로젝트별 보기에는 날짜 소제목이 없으므로 맨 앞에 날짜를 함께 적는다(`9/22 10:00`).
function meetingsTabRow(event, opts = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'd-mtrow' + (opts.withDate ? ' has-date' : '');
  button.dataset.moveId = `mtg:${event.id || meetingCaptureKey(event)}`; // 줄 이동 도우미의 열쇠(uiRowsMove)
  button.setAttribute('aria-current', String(event.id === meetingsTabState.key));

  const time = document.createElement('span');
  time.className = 't num';
  time.textContent = [opts.withDate ? uiDateSlash(event.date) : '', event.start || ''].filter(Boolean).join(' ');

  const wrap = document.createElement('span');
  wrap.className = 'tw';
  const title = document.createElement('span');
  title.className = 'ti';
  title.textContent = event.title;
  wrap.appendChild(title);
  // 줄 안의 짧은 표기라 지라는 요약만(모르면 키) — 색 점은 원래 키로 고른다(표기와 무관하게 같은 색).
  // 프로젝트별 보기에서는 소제목이 이미 프로젝트를 말해 주므로 줄에서는 뺀다(두 번 말하지 않는다).
  const projectName = opts.withDate ? '' : wfMeetingProjectName(event);
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

// 회의 화면 한 벌 — 줄 옆 카드·회의 탭이 함께 쓰는 회의 정리 패널(초안 검토·담기·종류 바꾸기·연결)과
// 회의 탭(날짜순 · 프로젝트별 두 보기, 필터, 오른쪽 상세).
// app.js에서 그대로 옮긴 코드다. app.js의 공용 부품(panelOpen·panelRender·panelSection·uiMenu·
// request·showNotice·load·workflowData)과 workflows.js(wf*)·meeting-notes-ui.js에 기댄다.
// index.html에서 meeting-notes-ui.js 뒤, app.js보다 먼저 읽힌다.

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
  head.append(title, panelMeetingWhenLine(event, host));
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

// 담은 항목의 종류 바꾸기 — 서버가 같은 id로 파일만 옮긴다(회의 연결·검토 기록이 그대로 남는다).
// 되돌리기는 반대 방향으로 한 번 더 바꾸는 것이고, 알림의 `되돌리기`와 ⌘Z가 같은 길을 쓴다.
const RETYPE_CHIPS = [['task', '할 일'], ['check', '확인 대기'], ['decision', '결정']];
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
async function retypeSend(id, type) {
  const result = await wfPost('retype', { id, type });
  if (!result.ok) throw new Error(result.error || '종류를 바꾸지 못했어요.');
  await load();
}
async function retypeMeetingItem(item, type) {
  const from = item.type;
  await retypeSend(item.id, type);
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
      try { await retypeSend(item.id, from); } catch { if (button) button.disabled = false; return; }
      // ⌘Z가 같은 되돌리기를 한 번 더 하지 않게 그 기록을 뺀다(삭제 되돌리기와 같은 규칙).
      const at = undoStack.lastIndexOf(entry);
      if (at >= 0) undoStack.splice(at, 1);
      showNotice(`${retypeDoneText(from)} 되돌렸어요`);
    },
  });
}

// 회의 줄의 ⋯ — 앱의 다른 목록이 쓰는 메뉴를 그대로 쓰고, 맨 위에 `문구 고치기`와 `종류 바꾸기`를 얹는다.
function panelMeetingRowMenu(item, row, onEdit) {
  const base = item.type === 'check' ? waitingMenuSections(item, row)
    : item.type === 'decision' ? decisionMenuSections(item, row)
    : taskMenuSections({ item, mode: panelMode(item), card: row });
  // 완료한 항목은 옮기지 않는다 — 끝난 줄이라 종류를 바꿀 일이 없다(서버도 거절한다).
  const done = item.status === 'done';
  const chips = uiMenuChips(RETYPE_CHIPS, item.type, async (value) => {
    uiMenuClose();
    try { await retypeMeetingItem(item, value); } catch { /* request()가 이미 알린다 */ }
  }, true);
  if (done) {
    Array.from(chips.children).forEach((chip) => { chip.disabled = true; });
    chips.title = RETYPE_DISABLED_HINT;
    chips.setAttribute('aria-description', RETYPE_DISABLED_HINT);
  }
  return [[{ label: '문구 고치기', onClick: onEdit }, { field: '종류 바꾸기', control: chips }], ...base];
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

// opts.type === false — 종류 소제목이 이미 종류를 말해 주는 자리(줄에서 `할 일`/`확인 대기` 글자를 뺀다).
// opts.project === false — 프로젝트 소제목으로 이미 나눈 자리(줄에서 `· ● 이름`을 뺀다).
function panelMeetingRow(item, event, stateText, host = MEETING_HOST_CARD, opts = {}) {
  const row = document.createElement('div');
  const done = item.status === 'done';
  const project = opts.project === false ? null : panelMeetingRowProject(item, event);
  row.className = 'd-mrow2' + (opts.type === false ? ' no-tg' : '') + (project ? ' has-pj' : '')
    + (done ? ' is-done' : '')
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
  if (opts.type !== false) row.appendChild(tag);
  // 프로젝트 표기가 있을 때만 제목과 한 칸에 묶는다(`제목 · ● 이름`) — 없으면 줄 모양은 예전 그대로다.
  if (project) {
    const wrap = document.createElement('span');
    wrap.className = 'tw';
    wrap.append(title, project);
    row.appendChild(wrap);
  } else {
    row.appendChild(title);
  }
  row.append(state, acts);
  return row;
}

// `이 회의에서 나온 것`을 종류로 나눈다(순수 함수): 할 일(버그 포함) · 확인 대기 · 결정, 그 밖은 끝에.
// 종류가 하나뿐이면 구역 제목이 이미 개수를 말하므로 소제목을 세우지 않는다(부르는 쪽이 길이로 판단한다).
const MEETING_TYPE_GROUPS = [['할 일', ['task', 'bug']], ['확인 대기', ['check']], ['결정', ['decision']]];
const MEETING_TYPE_KNOWN = ['task', 'bug', 'check', 'decision'];
function panelMeetingTypeGroups(items) {
  const all = [...(items || [])];
  const groups = [];
  MEETING_TYPE_GROUPS.forEach(([label, types]) => {
    const picked = all.filter(item => types.includes(item.type));
    if (picked.length) groups.push({ label, items: picked });
  });
  // 아이디어처럼 표에 없는 종류는 제 이름으로 맨 끝에 선다.
  const others = new Map();
  all.filter(item => !MEETING_TYPE_KNOWN.includes(item.type)).forEach((item) => {
    const label = wfType(item.type);
    if (!others.has(label)) others.set(label, []);
    others.get(label).push(item);
  });
  others.forEach((list, label) => groups.push({ label, items: list }));
  return groups;
}

// 종류·프로젝트 소제목 — 조용한 회색 한 줄이다(그룹 제목 부품이 아니다, 줄 사이를 알려 주기만 한다).
// opts.projectName이 있으면 프로젝트 소제목(`· ● 알림센터`)이 된다.
function panelMeetingSubhead(label, count, opts = {}) {
  const head = document.createElement('div');
  head.className = 'd-mgrp' + (opts.projectName === undefined ? '' : ' is-pj');
  if (opts.projectName) head.append('· ', uiProjectDot(opts.projectName));
  const name = document.createElement('span');
  name.textContent = label;
  head.appendChild(name);
  if (count) {
    const number = document.createElement('span');
    number.className = 'n num';
    number.textContent = count;
    head.appendChild(number);
  }
  return head;
}

// 한 종류 묶음을 구역에 붙인다. 종류가 둘 이상이어서 소제목이 선 자리에서는 줄의 종류 글자를 빼고,
// 그 종류 안에 프로젝트가 **둘 이상**일 때만 프로젝트 소제목으로 한 번 더 나눈다(하나뿐이면 나누지 않는다).
function panelMeetingTypeRows(section, group, { headed, split, row }) {
  if (headed) section.appendChild(panelMeetingSubhead(group.label, group.items.length));
  const groups = split ? uiGroupTasks(group.items) : [];
  if (groups.length > 1) {
    groups.forEach(([key, items]) => {
      section.appendChild(panelMeetingSubhead(uiGroupLabel(key), 0, { projectName: key === '__misc__' ? null : key }));
      items.forEach(item => row(item, { type: !headed, project: false }));
    });
    return;
  }
  group.items.forEach(item => row(item, { type: !headed, project: true }));
}

function panelMeetingItems(event, box, host = MEETING_HOST_CARD) {
  const items = wfMeetingItems(event.id);
  if (!items.length) return;
  const section = panelSection(`이 회의에서 나온 것 ${items.length}`);
  const groups = panelMeetingTypeGroups(items);
  const headed = groups.length > 1;
  const row = (item, opts) => {
    section.appendChild(panelMeetingRow(item, event, null, host, { type: opts.type, project: opts.project }));
    // 체크한 확인 대기는 이 구역에 is-done으로 남는다 — 그 줄 바로 아래에 `다음은?`을 덧붙인다.
    const next = item.type === 'check' ? waitingNextItem(item.id) : null;
    if (next) section.appendChild(waitingNextRow(next));
  };
  groups.forEach(group => panelMeetingTypeRows(section, group, { headed, split: true, row }));
  box.appendChild(section);
}

// 같은 이름으로 반복되는 회의라면, 지난 회차에서 아직 안 끝난 것을 여기서 같이 본다.
// 종류 소제목은 같은 규칙이고, 프로젝트로 한 번 더 나누지는 않는다 — 줄마다 이미 회차 표기가 있다.
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
  const at = new Map(rows.map(({ item, at: date }) => [item.id, date]));
  const groups = panelMeetingTypeGroups(rows.map(({ item }) => item));
  const headed = groups.length > 1;
  const row = (item, opts) => section.appendChild(
    panelMeetingRow(item, event, `${uiKoDateShort(at.get(item.id))} 회차`, host, { type: opts.type, project: opts.project }));
  groups.forEach(group => panelMeetingTypeRows(section, group, { headed, split: false, row }));
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
  key: null, unresolved: false, reviewOnly: false,
  windowDays: MEETINGS_TAB_WINDOW_DAYS, showNoRecord: false, result: null,
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

// 프로젝트별 보기의 묶음(순수 함수). 목록은 이미 날짜 내림차순이라 묶음 안의 차례는 그대로 두고,
// 묶음끼리의 차례만 정한다: **미완료 항목이 남은 프로젝트가 먼저**, 그 안에서는 가장 최근 회의 날짜순.
// `프로젝트 없음`은 언제나 맨 끝이다.
function meetingsTabGroups(rows, itemsOf) {
  const groups = new Map();
  (rows || []).forEach((event) => {
    const key = wfMeetingKey(event) || '__misc__';
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
  // 프로젝트별 보기에서 그 프로젝트를 접어 뒀으면 펼친다 — 고른 회의 줄은 반드시 보여야 한다.
  meetingsTabClosed.delete(wfMeetingKey(event) || '__misc__');
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
  const filtering = !!(meetingsTabState.unresolved || meetingsTabState.reviewOnly);
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
    empty.textContent = meetings.length ? '고른 조건에 맞는 회의가 없어요.' : '아직 기록된 회의가 없어요.';
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
}

// 날짜순 — 날짜별 조용한 소제목(묶음을 알려 주기만 한다, 개수·칩 없음) 아래로 줄이 선다.
function meetingsTabDateRows(listEl, rows, today) {
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
    const more = beyond.filter(event => (wfMeetingKey(event) || '__misc__') === key).length;
    if (more) listEl.appendChild(meetingsMoreRow(`더 보기 ${more}`, 'd-mmore is-in'));
  });
}

// 프로젝트별 보기에서 어느 소제목 아래에도 붙지 않는 `더 보기`가 남았는지(지금 목록에 줄이 하나도 없는 프로젝트).
function meetingsTabBeyondRest(rows, beyond) {
  const listed = new Set((rows || []).map(event => wfMeetingKey(event) || '__misc__'));
  return beyond.some(event => !listed.has(wfMeetingKey(event) || '__misc__'));
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
  more.appendChild(link);
  return more;
}

// 프로젝트 소제목 옆의 조용한 글자 — 지라 프로젝트(또는 손으로 연결한 그룹)의 지금 상태 이름을
// 범주 색으로 적는다(BJCOLOR 규칙). 앱이 그 티켓을 들고 있지 않으면 아무것도 붙이지 않는다.
function meetingsProjectStatus(key) {
  if (key === '__misc__') return null;
  const issue = jiraIssuesByKey.get(jiraKeyOf(key));
  const name = issue && issue.status ? issue.status.name : '';
  if (!name) return null;
  const tone = jiraStatusTone(issue.status.category);
  const note = document.createElement('span');
  note.className = 'js' + (tone ? ` ${tone}` : '');
  note.title = '지라에 적힌 지금 상태예요';
  note.textContent = name;
  return note;
}

// 회의 정리 화면 부제목의 프로젝트 이름을 누르면 오는 길 — 왼쪽 목록을 `프로젝트별`로 바꾸고
// 그 프로젝트만 펼친 뒤(다른 프로젝트는 접는다) 그 소제목으로 스크롤한다. 드롭다운으로 하던
// "한 프로젝트만 보기"를 대신하는 자리다.
function meetingsShowProject(key) {
  const meetings = (workflowData && workflowData.meetings) || [];
  meetingsTabClosed.clear();
  meetings.forEach((event) => {
    const other = wfMeetingKey(event) || '__misc__';
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

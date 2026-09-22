// 오늘 탭 본문 맨 위의 `반응 필요` 구역 (1차: 지라 댓글).
// "내가 답해야 하는 것"을 한 자리에 모으고, **내가 답하면 스스로 사라진다**(댓글 id가 줄의 id라서
// 내가 댓글을 달면 다음 갱신에서 그 줄이 없어진다). 0개이거나 연결이 없으면 구역 자체를 그리지 않는다 —
// 매일 뜨는 `없어요`는 소음이다(작동 여부는 설정 > 상태에서 본다).
//
// 값은 서버 메모리에서만 오고(`GET /api/attention`) 화면도 들고 있지 않는다. 저장하는 것은
// `했어요`로 치운 줄의 id 하나뿐이다(`POST /api/attention/dismiss`).
// app.js의 공용 부품(request·showNotice·announce·fadeOutAndRun·uiProjectDot·postJson)과
// settings-ui.js의 `relativeTimeFrom`,
// waiting-ui.js의 `후속 할 일` 입력칸(waitingNextEdit·waitingNextCreateTask)에 기댄다.

const ATTENTION_SHOWN = 8;   // 이만큼만 보이고 나머지는 `외 N개 보기`

let attentionState = { connected: false, items: [], updatedAt: null, stale: false, error: '' };
// `외 N개 보기`를 눌렀나. 저장하지 않는 화면 상태다(페이지를 새로 열면 다시 접힌다).
let attentionAll = false;
// 헤더 새로고침이 다음 읽기를 지라에 바로 묻게 하는 표시(한 번만 쓰인다).
let attentionWantFresh = false;

function attentionMarkFresh() { attentionWantFresh = true; }

const attentionLabel = item => item.summary || item.key || '';
// 출처 이름표 — 지금은 지라뿐이지만 나중에 다른 출처가 늘어도 줄에서 바로 구분되게 값으로 정한다.
const ATTENTION_SOURCE_NAME = { jira: '지라', figma: '피그마' };
const attentionSourceName = item => ATTENTION_SOURCE_NAME[item.source] || '';

// 줄 오른쪽의 `Yosef 외 1명 · 2시간 전`. 시각은 설정 > 상태와 같은 부품(relativeTimeFrom)을 쓴다.
function attentionWhoText(item) {
  const who = `${item.who || ''}${item.others ? ` 외 ${item.others}명` : ''}`.trim();
  const when = item.at ? relativeTimeFrom(item.at) : '';
  return [who, when].filter(Boolean).join(' · ');
}

// 머리줄의 조용한 한 마디 — **평소에는 아무것도 적지 않는다**(`새로 들어온 것 4`처럼 제목+개수만
// 있어야 다른 구역과 리듬이 맞는다. 작동 여부는 이미 설정 > 상태에서 본다). 값이 묵어서 이전 값을
// 쓰는 동안에만(`stale`) `… 기준`이라고 밝힌다(주의색 글자) — 이건 알아 둬야 하는 정보라 남긴다.
function attentionNoteText(state = attentionState) {
  if (!state.updatedAt || !state.stale) return '';
  return `${relativeTimeFrom(state.updatedAt)} 기준`;
}

const attentionDrop = (id) => { attentionState = { ...attentionState, items: attentionState.items.filter(item => item.id !== id) }; };

// 치우기·되돌리기는 앱의 기존 저장 길(request → POST)이다. 알림은 이 파일이 직접 띄우므로
// 저장 알림은 끄고(quiet) 보낸다.
const attentionSend = (path, id) => request(path, {
  method: 'POST', quiet: true,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ id }),
});

async function attentionLoad() {
  const fresh = attentionWantFresh;
  attentionWantFresh = false;
  try {
    const response = await fetch(`/api/attention${fresh ? '?fresh=1' : ''}`, { headers: { Accept: 'application/json' } });
    const data = await response.json();
    attentionState = {
      connected: !!data.connected,
      items: Array.isArray(data.items) ? data.items : [],
      updatedAt: data.updatedAt || null,
      stale: !!data.stale,
      error: typeof data.error === 'string' ? data.error : '',
    };
  } catch {
    // 이 주소가 없는 옛 서버이거나 연결이 끊긴 것이다 — 구역을 그리지 않고 조용히 넘어간다.
    attentionState = { connected: false, items: [], updatedAt: null, stale: false, error: '' };
  }
  attentionRender();
}

// `했어요` — 줄이 사라지고 알림의 `되돌리기`로 되돌린다. ⌘Z 대상은 아니다(바깥 상태와 얽힌 표시라).
async function attentionDismiss(item, card) {
  await fadeOutAndRun(card, async () => {
    await attentionSend('/api/attention/dismiss', item.id);
    attentionDrop(item.id);
    attentionRender();
  });
  // 실패하면 줄이 그대로 남는다(이유는 request가 이미 알렸다).
  if (attentionState.items.some(entry => entry.id === item.id)) return;
  showNotice(`반응 필요에서 치웠어요 · ${attentionLabel(item)}`, false, null, {
    label: '되돌리기',
    onClick: async (button) => {
      button.disabled = true;
      try {
        await attentionSend('/api/attention/undismiss', item.id);
        await attentionLoad();
        announce('반응 필요로 되돌렸어요');
      } catch { button.disabled = false; }
    },
  });
}

// `할 일로` — 확인 대기의 `후속 할 일`과 **같은 입력칸·같은 등록 길**이다(⌘Z로 그 업무를 지우는
// 규칙까지 그대로). 업무를 만든 것이 곧 반응한 것이라 그 줄은 이어서 치운다.
async function attentionCreateTask(item, description, mode) {
  await waitingNextCreateTask({ id: item.id, description: attentionLabel(item), jira: item.key }, description, mode);
  try {
    await attentionSend('/api/attention/dismiss', item.id);
    attentionDrop(item.id);
  } catch {
    // 업무는 이미 만들어졌다 — 여기서 실패하면 줄만 그대로 남긴다(다시 만들게 하지 않는다).
  }
  attentionRender();
}

function attentionActs(item, card, edit) {
  const acts = document.createElement('div');
  acts.className = 'd-atacts';

  const open = document.createElement('a');
  open.className = 'd-src';
  open.href = item.url || '';
  open.target = '_blank';
  open.rel = 'noopener noreferrer';
  open.textContent = '열기';
  open.title = `${item.key} · 지라에서 열어요`;
  open.setAttribute('aria-label', `${attentionLabel(item)} — 지라에서 열기`);
  acts.appendChild(open);

  const act = (text, onClick) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'd-btn sm';
    button.textContent = text;
    button.setAttribute('aria-label', `${attentionLabel(item)} — ${text}`);
    button.addEventListener('click', () => onClick(button));
    acts.appendChild(button);
    return button;
  };

  act('했어요', () => attentionDismiss(item, card));
  act('할 일로', () => {
    const bar = document.createElement('div');
    bar.className = 'nx';
    edit.replaceChildren(bar);
    waitingNextEdit(bar, {
      value: `댓글 답하기 — ${attentionLabel(item)}`,
      placeholder: '할 일 — Enter로 오늘 할 일',
      label: `${attentionLabel(item)} — 할 일로`,
      buttons: [['today', '오늘'], ['later', '나중에']],
      onSubmit: (value, mode) => attentionCreateTask(item, value, mode),
    });
  });
  return acts;
}

// 줄 하나(두 줄): 프로젝트 색 점 + 요약 + `누가 · 언제` + (부름 배지) / 미리보기 + `댓글 N개`.
// 지라 키는 툴팁과 `열기` 링크에만 있다(BKEY 결정). 지라 상태(배포 대기 등)는 이 줄에서 말하지
// 않는다 — 반응 필요는 "누가 나를 불렀나"만 보는 자리라 상태까지 적으면 정보가 두 겹이었다(시안 확인).
function attentionRow(item) {
  const card = document.createElement('article');
  card.className = 'd-atrow';
  card.setAttribute('aria-label', `반응 필요 — ${attentionLabel(item)}`);

  const top = document.createElement('div');
  top.className = 'tl';
  const sourceName = attentionSourceName(item);
  if (sourceName) {
    const source = document.createElement('span');
    source.className = 'sc';
    source.textContent = sourceName;
    top.appendChild(source);
  }
  top.appendChild(uiProjectDot(`jira:${item.key}`));
  const title = document.createElement('span');
  title.className = 'ti';
  title.title = `${item.key} · ${attentionLabel(item)}`;
  title.textContent = attentionLabel(item);
  top.appendChild(title);
  card.appendChild(top);

  // `누가 · 언제`와 부름 표시는 따로 선다 — 넓은 자리에서는 첫 줄 오른쪽 끝, 좁은 폭에서는
  // 둘째 줄 맨 앞으로 내려온다(자리는 ui.css의 칸 이름이 정한다).
  const meta = document.createElement('div');
  meta.className = 'mt';
  const who = document.createElement('span');
  who.className = 'wh';
  who.textContent = attentionWhoText(item);
  meta.appendChild(who);
  if (item.mention) {
    // 급한 말이 아니라 종류를 말하는 표시다 — 바탕을 채우지 않고 주의색 글자로만 적는다.
    const badge = document.createElement('span');
    badge.className = 'mn k-warn';
    badge.textContent = '@멘션';
    meta.appendChild(badge);
  }
  card.appendChild(meta);

  const sub = document.createElement('div');
  sub.className = 'sb';
  const preview = document.createElement('span');
  preview.className = 'pv';
  preview.textContent = item.preview || '';
  sub.appendChild(preview);
  if (item.count > 1) {
    const count = document.createElement('span');
    count.className = 'ct';
    count.textContent = `· 댓글 ${item.count}개`;
    sub.appendChild(count);
  }
  card.appendChild(sub);

  const edit = document.createElement('div');
  edit.className = 'ed';
  card.append(attentionActs(item, card, edit), edit);
  return card;
}

function attentionRender() {
  const zone = document.getElementById('attentionZone');
  const list = document.getElementById('attentionList');
  if (!zone || !list) return;
  // `할 일로` 입력칸에 손이 가 있으면 다시 그리지 않는다(적던 글과 초점이 날아가지 않게).
  if (typeof isTyping === 'function' && isTyping() && zone.contains && zone.contains(document.activeElement)) return;
  const items = attentionState.connected ? attentionState.items : [];
  zone.hidden = !items.length;
  if (!items.length) { list.replaceChildren(); return; }

  document.getElementById('attentionCount').textContent = String(items.length);
  const note = document.getElementById('attentionNote');
  const noteText = attentionNoteText();
  note.textContent = noteText;
  note.hidden = !noteText;
  note.className = attentionState.stale ? 'd-quiet k-warn' : 'd-quiet';

  const shown = attentionAll ? items : items.slice(0, ATTENTION_SHOWN);
  const nodes = shown.map(attentionRow);
  if (shown.length < items.length) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'd-btn sm d-atmore';
    more.textContent = `외 ${items.length - shown.length}개 보기`;
    more.addEventListener('click', () => { attentionAll = true; attentionRender(); });
    nodes.push(more);
  }
  list.replaceChildren(...nodes);
}

// 설정 > 상태의 마지막 줄. 자동화가 아니라 앱이 직접 읽는 것이라 목록 끝에 조용히 붙는다.
function attentionStatusRow() {
  if (!attentionState.connected) return null;
  const row = document.createElement('div');
  row.className = 'd-auto';
  row.dataset.automation = 'attention';
  const top = document.createElement('div');
  top.className = 'd-autotop';
  const name = document.createElement('span');
  name.className = 'nm';
  name.textContent = '반응 필요 · 지라 댓글';
  const state = document.createElement('span');
  const when = attentionState.updatedAt ? `${relativeTimeFrom(attentionState.updatedAt)} 확인` : '아직 읽지 못했어요';
  state.className = 'st' + (attentionState.error ? ' k-neg' : attentionState.stale ? ' k-warn' : '');
  state.textContent = attentionState.error ? attentionState.error : attentionState.stale ? `${when} · 다시 읽지 못했어요` : when;
  top.append(name, state);
  row.appendChild(top);
  return row;
}

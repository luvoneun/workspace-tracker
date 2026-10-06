// 체크인 창(WP-N) — 설치 3일째·8일째에 앱을 열면 뜨는 작은 모달. 판단·전송은 서버(checkin.js)가 하고,
// 여기서는 `GET /api/checkin`이 준 질문(제목·선택지 글자 = 폼으로 가는 글자)을 그대로 그린다.
// - 앱이 첫 목록을 그린 뒤, 그리고 창이 다시 보일 때·포커스를 받을 때 로컬 날짜가 바뀌었으면 다시 묻는다.
// - 방해하지 않는다: 입력칸에 초점이 있거나, 다른 창·설정·메뉴·상세가 열려 있거나, 업데이트가 도는 중이거나,
//   복구 필요 배너가 떠 있으면 묻지 않고 다음 포커스/보임으로 미룬다.
// - `나중에`가 있을 때만 Esc·바깥 클릭이 `나중에`와 같다. 없으면 보내기 전에는 닫히지 않는다(보낸 뒤엔 닫기).
// - 새 innerHTML은 쓰지 않는다(요소를 만들어 붙인다).

let checkinAskedOn = null;    // 마지막으로 서버에 물은 로컬 날짜
let checkinDeferred = false;  // 방해될 때라 미뤘다 — 다음 포커스/보임에 날짜와 상관없이 다시
let checkinHeld = null;       // 받아 놓고 아직 못 띄운 회차(받은 사이에 다른 창이 열렸다)
let checkinAsking = false;
let checkinCurrent = null;    // { dialog, round, canSnooze, done, returnFocus }

function checkinLocalDay(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

// 지금 창을 띄우면 방해가 되나.
function checkinBusy() {
  const active = document.activeElement;
  if (active && active !== document.body && (active.isContentEditable || (active.matches && active.matches('input, textarea, select')))) return true;
  if (document.querySelector('dialog[open], .d-pal, .d-popd, .d-menulist')) return true;
  if (typeof escStack !== 'undefined' && escStack.length) return true;
  if (typeof settingsUpdateRun !== 'undefined' && settingsUpdateRun) return true;
  const banner = document.getElementById('storageBanner');
  if (banner && !banner.hidden) return true;
  return false;
}

async function checkinMaybe() {
  if (checkinCurrent || checkinAsking) return;
  if (checkinHeld) {
    if (checkinBusy()) return;
    const held = checkinHeld;
    checkinHeld = null;
    checkinShow(held);
    return;
  }
  const today = checkinLocalDay();
  if (!checkinDeferred && checkinAskedOn === today) return;
  if (checkinBusy()) { checkinDeferred = true; return; }
  checkinDeferred = false;
  checkinAskedOn = today;
  checkinAsking = true;
  try {
    const response = await fetch('/api/checkin');
    if (!response.ok) return;
    const data = await response.json();
    if (!data || !data.show || !Array.isArray(data.questions)) return;
    if (checkinBusy()) { checkinHeld = data; return; }
    checkinShow(data);
  } catch { /* 조용히 — 다음 날 다시 묻는다 */ } finally {
    checkinAsking = false;
  }
}

// app.js가 첫 목록을 그린 뒤 부른다.
let checkinStarted = false;
function checkinStart() {
  if (checkinStarted) return;
  checkinStarted = true;
  checkinMaybe();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkinMaybe(); });
  window.addEventListener('focus', () => checkinMaybe());
}

// ---------- 창 그리기 ----------
function checkinEl(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function checkinLabel(question, id, asLabelFor) {
  const label = checkinEl(asLabelFor ? 'label' : 'div', 'd-cklb', question.title);
  label.id = id;
  if (asLabelFor) label.htmlFor = asLabelFor;
  if (question.hint) {
    label.append(' ');
    label.appendChild(checkinEl('small', null, question.hint));
  }
  return label;
}

function checkinChoice(question, value, type, name, ariaLabel) {
  const label = checkinEl('label', 'd-ckopt');
  const input = document.createElement('input');
  input.type = type;
  input.name = name;
  input.value = value;
  if (ariaLabel) input.setAttribute('aria-label', ariaLabel);
  label.append(input, checkinEl('span', null, value));
  return label;
}

function checkinQuestion(question, index) {
  const id = `ckq${index}`;
  const name = `ck-${question.key}`;
  const box = checkinEl('div', 'd-ckq');
  box.dataset.key = question.key;
  box.dataset.kind = question.kind;
  if (question.kind === 'text') {
    const fieldId = `${id}f`;
    box.appendChild(checkinLabel(question, id, fieldId));
    const area = checkinEl('textarea', 'd-din d-cktext');
    area.id = fieldId;
    area.name = name;
    area.rows = 2;
    area.maxLength = question.max || 300;
    area.placeholder = question.placeholder || '';
    box.appendChild(area);
    return box;
  }
  box.setAttribute('role', question.kind === 'multi' ? 'group' : 'radiogroup');
  box.setAttribute('aria-labelledby', id);
  box.appendChild(checkinLabel(question, id));
  const type = question.kind === 'multi' ? 'checkbox' : 'radio';
  const opts = checkinEl('div', question.kind === 'scale' ? 'd-ckopts d-cknps' : 'd-ckopts');
  question.options.forEach(value => opts.appendChild(checkinChoice(question, value, type, name, question.kind === 'scale' ? `${value}점` : null)));
  box.appendChild(opts);
  if (question.kind === 'scale' && Array.isArray(question.ends)) {
    const ends = checkinEl('div', 'd-ckends');
    ends.setAttribute('aria-hidden', 'true');
    ends.append(checkinEl('span', null, `${question.options[0]} ${question.ends[0]}`),
      checkinEl('span', null, `${question.options[question.options.length - 1]} ${question.ends[1]}`));
    box.appendChild(ends);
  }
  return box;
}

// 고른 답 — 서버가 허용 목록으로 다시 거른다. 아무것도 안 골라도 된다.
function checkinAnswers(form) {
  const answers = {};
  form.querySelectorAll('.d-ckq').forEach((box) => {
    const key = box.dataset.key;
    if (box.dataset.kind === 'text') {
      const value = box.querySelector('textarea').value.trim();
      if (value) answers[key] = value;
    } else if (box.dataset.kind === 'multi') {
      const picked = [...box.querySelectorAll('input:checked')].map(input => input.value);
      if (picked.length) answers[key] = picked;
    } else {
      const picked = box.querySelector('input:checked');
      if (picked) answers[key] = picked.value;
    }
  });
  return answers;
}

function checkinShow(data) {
  const returnFocus = document.activeElement;
  const dialog = checkinEl('dialog', 'd-modal d-stay d-ckdlg');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'ckTitle');
  dialog.setAttribute('aria-describedby', 'ckLead');
  const form = checkinEl('form', 'd-ckform');
  form.noValidate = true;

  const head = checkinEl('div', 'd-ckhead');
  const title = checkinEl('h2', null, '워크스페이스, 써 보니 어때요?');
  title.id = 'ckTitle';
  title.tabIndex = -1;
  // 사용 횟수를 함께 보내는지는 서버가 알려 준다(WP-R — 설정에서 끈 사람에게는 앞 문장만).
  const lead = checkinEl('p', 'd-cklead', data.usageOn
    ? '이름과 업무 내용은 보내지 않아요. 앱을 고치는 데 쓰려고 기능별 사용 횟수는 함께 보내요.'
    : '답은 만든 사람에게만 가요. 이름과 업무 내용은 보내지 않아요.');
  lead.id = 'ckLead';
  head.append(checkinEl('div', 'd-ckeye', data.eyebrow || ''), title, lead);
  form.appendChild(head);
  data.questions.forEach((question, index) => form.appendChild(checkinQuestion(question, index)));

  const error = checkinEl('p', 'd-ckerr');
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const foot = checkinEl('div', 'd-ckfoot');
  const note = checkinEl('span', 'd-cknote', data.canSnooze
    ? '‘나중에’는 한 번만 — 내일 다시 물어봐요'
    : '어제 미뤄 둔 질문이에요 — 이번엔 꼭 부탁해요');
  const buttons = checkinEl('div', 'd-ckbtns');
  const later = checkinEl('button', 'd-btn', '나중에');
  later.type = 'button';
  later.hidden = !data.canSnooze;
  // 우리 서버에 닿지 못했을 때만 나타난다 — 앱이 꺼졌는데 창에 갇히지 않게(다음 날 다시 묻는다).
  const quit = checkinEl('button', 'd-btn', '닫기');
  quit.type = 'button';
  quit.hidden = true;
  const send = checkinEl('button', 'd-btn pri', '보내기');
  send.type = 'submit';
  buttons.append(later, quit, send);
  foot.append(note, buttons);
  form.append(error, foot);
  dialog.appendChild(form);

  const current = { dialog, form, round: data.show, canSnooze: !!data.canSnooze, done: false, returnFocus };
  checkinCurrent = current;

  later.addEventListener('click', () => checkinSnooze(current));
  quit.addEventListener('click', () => checkinClose(current));
  form.addEventListener('submit', (event) => { event.preventDefault(); checkinSend(current, { send, later, quit, error }); });
  // 브라우저가 스스로 닫으려 할 때(Esc) — `나중에`가 있을 때만 `나중에`, 보낸 뒤면 닫기, 그 밖엔 무시.
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); checkinEscape(current); });
  dialog.addEventListener('keydown', (event) => checkinKeydown(current, event));
  // 브라우저가 cancel을 막지 못하고 창을 닫아 버린 경우(Esc 연타 등) — 보낸 뒤면 정리, `나중에`가 있으면 나중에,
  // 없으면 다시 띄운다(우리 길로 닫을 때는 checkinClose가 먼저 checkinCurrent를 비우므로 여기를 타지 않는다).
  dialog.addEventListener('close', () => {
    if (checkinCurrent !== current) return;
    if (current.done) { checkinClose(current); return; }
    if (current.canSnooze && !current.busy) { checkinSnooze(current); return; }
    try { dialog.showModal(); } catch { checkinClose(current); }
  });
  // 바깥(배경) 클릭 — 창 판 밖을 누르면 대상이 dialog 자신이다.
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const box = form.getBoundingClientRect();
    const inside = event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
    if (!inside) checkinEscape(current);
  });

  document.body.appendChild(dialog);
  dialog.showModal();
  title.focus();
}

function checkinEscape(current) {
  if (current.done) { checkinClose(current); return; }
  if (current.canSnooze && !current.busy) checkinSnooze(current);
}

// 초점 가두기 — Tab이 창 밖(브라우저 주소창 등)으로 나가지 않게 처음·끝을 잇는다.
function checkinTabbables(dialog) {
  const seen = new Set();
  return [...dialog.querySelectorAll('button, input, textarea')].filter((node) => {
    if (node.disabled || node.hidden || node.closest('[hidden]')) return false;
    if (node.type === 'radio') {
      if (seen.has(node.name)) return false;
      const group = [...dialog.querySelectorAll(`input[type="radio"][name="${node.name}"]`)];
      const checked = group.find(one => one.checked);
      if (checked && checked !== node) return false;
      seen.add(node.name);
    }
    return true;
  });
}
function checkinKeydown(current, event) {
  if (event.key === 'Escape') {
    if (event.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    checkinEscape(current);
    return;
  }
  if (event.key !== 'Tab') return;
  const list = checkinTabbables(current.dialog);
  if (!list.length) return;
  const first = list[0];
  const last = list[list.length - 1];
  const active = document.activeElement;
  const sameGroup = (node, other) => node && other && node.type === 'radio' && other.type === 'radio' && node.name === other.name;
  if (event.shiftKey && (active === first || sameGroup(active, first) || !current.dialog.contains(active) || active === current.dialog.querySelector('#ckTitle'))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || sameGroup(active, last) || !current.dialog.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}

async function checkinPost(body) {
  const response = await fetch('/api/checkin', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  let data = null;
  try { data = await response.json(); } catch { data = null; }
  return { status: response.status, data };
}

async function checkinSnooze(current) {
  if (current.busy) return;
  current.busy = true;
  try { await checkinPost({ round: current.round, action: 'snooze' }); } catch { /* 닫고 다음에 */ }
  checkinClose(current);
}

async function checkinSend(current, parts) {
  if (current.busy || current.done) return;
  current.busy = true;
  parts.send.disabled = true;
  parts.later.disabled = true;
  parts.send.textContent = '보내는 중…';
  parts.error.hidden = true;
  let result = null;
  try { result = await checkinPost({ round: current.round, action: 'send', answers: checkinAnswers(current.form) }); } catch { result = null; }
  current.busy = false;
  if (!result) {
    // 앱 서버에 닿지 못했다 — 답은 그대로 두고 다시 누르거나 닫을 수 있게.
    parts.send.disabled = false;
    parts.later.disabled = false;
    parts.send.textContent = '보내기';
    parts.error.textContent = '앱에 닿지 못했어요 — 잠시 뒤 다시 눌러 주세요.';
    parts.error.hidden = false;
    parts.quit.hidden = false;
    return;
  }
  const data = result.data || {};
  if (data.ok && data.queued) { checkinDone(current, '고마워요 — 인터넷이 돌아오면 보낼게요', '답은 이 맥에 잠시 두었다가 다음에 앱을 열 때 보내요.'); return; }
  if (data.ok) { checkinDone(current, '고마워요!', '보낸 답은 더 나은 워크스페이스를 만드는 데 써요.'); return; }
  // 서버가 받지 않았다(지금 물을 차례가 아님 등) — 붙잡지 않고 닫는다.
  checkinClose(current);
}

function checkinDone(current, heading, sub) {
  current.done = true;
  const box = checkinEl('div', 'd-ckdone');
  const mark = checkinEl('span', 'ok', '✓');
  mark.setAttribute('aria-hidden', 'true');
  const title = checkinEl('h2', null, heading);
  title.id = 'ckTitle';
  const close = checkinEl('button', 'd-btn pri', '닫기');
  close.type = 'button';
  close.addEventListener('click', () => checkinClose(current));
  const lead = checkinEl('p', null, sub);
  lead.id = 'ckLead';
  box.append(mark, title, lead, close);
  current.form.replaceChildren(box);
  close.focus();
}

function checkinClose(current) {
  if (checkinCurrent !== current) return;
  checkinCurrent = null;
  if (current.dialog.open) current.dialog.close();
  // 닫힘(.d-stay, 140ms)이 재생된 뒤에 떼어 낸다 — 초점 복귀는 기다리지 않는다
  setTimeout(() => current.dialog.remove(), typeof UI_FLOAT === 'object' ? UI_FLOAT.out : 140);
  const back = current.returnFocus;
  if (back && back !== document.body && back.isConnected && back.focus) back.focus();
}

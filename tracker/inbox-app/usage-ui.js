// 사용 횟수(WP-R) 화면 — 세기·보내기는 서버(usage.js)가 한다. 여기서는
//  ① 화면에서만 아는 것(탭 열기·검색·주간요약 복사)을 `POST /api/usage/tick`으로 알리고
//  ② 사용설명서 카드 맨 아래 알림 한 줄(`… 보내요 · 끄기` ↔ `보내지 않아요 · 다시 켜기`)과
//  ③ 설정 › 앱의 `익명 사용 횟수 보내기` 스위치·`내 사용 기록`(최근 30일 합계 표)을 그린다.
// 알림 줄은 이 설치가 실제로 보낼 수 있을 때(`canSend` — 만든 사람·개발용·폼 닫힘이 아님)만 보인다.
// 새 innerHTML은 쓰지 않는다(요소를 만들어 붙인다). 알리기가 실패해도 조용히 넘어간다.

let usageInfo = null;          // GET /api/usage 결과 { send, canSend, days, rows }
let usageLoading = null;
const usageGuideNodes = new Set();   // 사용설명서 알림 줄(오늘 탭 카드·도움말) — 켜고 끌 때 함께 다시 그린다
let usageTabSeen = false;

function usageTick(key) {
  try {
    fetch('/api/usage/tick', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) }).catch(() => {});
  } catch { /* 조용히 */ }
}

// app.js의 setActiveTab이 부른다 — 다른 탭으로 옮겼을 때, 그리고 앱을 연 뒤 첫 탭 한 번.
function usageTabOpened(tab, previous) {
  if (usageTabSeen && tab === previous) return;
  usageTabSeen = true;
  usageTick(`tab_${tab}`);
}

async function usageLoad() {
  if (usageLoading) return usageLoading;
  usageLoading = (async () => {
    try {
      const response = await fetch('/api/usage');
      const data = response.ok ? await response.json() : null;
      if (data && data.ok) usageInfo = data;
    } catch { /* 읽지 못하면 알림 줄을 숨긴 채로 둔다 */ }
    usageLoading = null;
    usageGuidePaintAll();
    return usageInfo;
  })();
  return usageLoading;
}

async function usageSetSend(on) {
  const response = await fetch('/api/usage/setting', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ send: on }),
  });
  let data = null;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok || !data || !data.ok) throw new Error((data && data.error) || '바꾸지 못했어요.');
  if (usageInfo) usageInfo.send = !!data.send;
  usageGuidePaintAll();
  return !!data.send;
}

// ---------- 사용설명서 알림 한 줄 ----------
function usageGuideLine() {
  const line = document.createElement('p');
  line.className = 'd-usagenote';
  line.hidden = true;
  usageGuideNodes.add(line);
  usageGuidePaint(line);
  if (!usageInfo) usageLoad();
  return [line];
}

function usageGuidePaint(line) {
  if (!line.isConnected && line.dataset.painted) { usageGuideNodes.delete(line); return; }
  line.dataset.painted = '1';
  const info = usageInfo;
  line.hidden = !(info && info.canSend);
  if (line.hidden) { line.replaceChildren(); return; }
  const on = !!info.send;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'd-ablink';
  button.textContent = on ? '끄기' : '다시 켜기';
  button.setAttribute('aria-label', on ? '익명 사용 횟수 보내기 끄기' : '익명 사용 횟수 보내기 다시 켜기');
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await usageSetSend(!on);
      // 다시 그린 줄의 같은 버튼으로 초점을 옮긴다(키보드로 누른 사람이 자리를 잃지 않게).
      const next = line.querySelector('button');
      if (next) next.focus();
      if (typeof showNotice === 'function') showNotice(on ? '익명 사용 횟수를 보내지 않아요' : '익명 사용 횟수를 다시 보내요');
    } catch (error) {
      button.disabled = false;
      if (typeof showNotice === 'function') showNotice(error.message, true);
    }
  });
  line.replaceChildren(document.createTextNode(on ? '앱 개선을 위해 익명 사용 횟수를 보내요 · ' : '보내지 않아요 · '), button);
}

function usageGuidePaintAll() {
  for (const line of [...usageGuideNodes]) usageGuidePaint(line);
  usageSettingsPaint();
}

// ---------- 설정 › 앱: 스위치와 내 사용 기록 ----------
let usageSettingsNode = null;

function usageSettingsRow() {
  const cell = document.createElement('div');
  cell.className = 'd-usageset';
  const row = typeof personalizeRow === 'function'
    ? personalizeRow('사용 통계', '앱 개선용', cell)
    : cell;
  row.dataset.row = 'usage';
  usageSettingsNode = cell;
  cell.appendChild(Object.assign(document.createElement('div'), { className: 'd-empty', textContent: '불러오는 중이에요…' }));
  usageLoad().then(() => usageSettingsPaint());
  return row;
}

function usageChevron() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'd-i');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  shape.setAttribute('d', 'M6 3.5 10.5 8 6 12.5');
  svg.appendChild(shape);
  return svg;
}

function usageSettingsPaint() {
  const cell = usageSettingsNode;
  if (!cell || !cell.isConnected) return;
  const info = usageInfo;
  if (!info) {
    cell.replaceChildren(Object.assign(document.createElement('div'), { className: 'd-ismall', textContent: '사용 기록을 읽지 못했어요.' }));
    return;
  }
  // 스위치 — 기존 연동 탭의 체크 줄(.d-ich)을 그대로 쓰고 role=switch로 켬/끔을 읽어 준다.
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.setAttribute('role', 'switch');
  box.checked = !!info.send;
  box.setAttribute('aria-label', '익명 사용 횟수 보내기');
  const text = document.createElement('span');
  text.className = 't';
  const strong = document.createElement('b');
  strong.textContent = '익명 사용 횟수 보내기';
  const sub = document.createElement('span');
  sub.className = 'd-ismall sub';
  sub.textContent = info.canSend
    ? '기능별 사용 횟수만 보내요 — 이름·업무 내용은 보내지 않아요'
    : '기능별 사용 횟수만 보내요 — 이름·업무 내용은 보내지 않아요 · 이 설치에서는 지금 보내지 않아요';
  text.append(strong, sub);
  const label = document.createElement('label');
  label.className = 'd-ich d-usageswitch' + (box.checked ? ' is-on' : '');
  label.append(box, text);
  box.addEventListener('change', async () => {
    const want = box.checked;
    box.disabled = true;
    try {
      await usageSetSend(want);
    } catch (error) {
      box.checked = !want;
      if (typeof showNotice === 'function') showNotice(error.message, true);
    }
    box.disabled = false;
    label.classList.toggle('is-on', box.checked);
  });

  // 내 사용 기록 — 기본 접힘. 최근 30일 합계.
  const history = document.createElement('details');
  history.className = 'd-dsec d-dadd d-usagehist';
  const summary = document.createElement('summary');
  summary.className = 'lbl';
  summary.append(usageChevron(), document.createTextNode('내 사용 기록'));
  const table = document.createElement('table');
  table.className = 'd-usagetable';
  const caption = document.createElement('caption');
  caption.textContent = `최근 ${info.days || 30}일 합계 · 이 맥에만 있어요`;
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  ['기능', '횟수'].forEach((word) => {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = word;
    headRow.appendChild(th);
  });
  head.appendChild(headRow);
  const body = document.createElement('tbody');
  (Array.isArray(info.rows) ? info.rows : []).forEach((item) => {
    const tr = document.createElement('tr');
    const name = document.createElement('th');
    name.scope = 'row';
    name.textContent = item.label;
    const count = document.createElement('td');
    count.textContent = String(item.count);
    tr.append(name, count);
    body.appendChild(tr);
  });
  table.append(caption, head, body);
  history.append(summary, table);
  const wasOpen = cell.querySelector('.d-usagehist')?.open;
  if (wasOpen) history.open = true;
  cell.replaceChildren(label, history);
}

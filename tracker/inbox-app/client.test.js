const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise error paths against the actual client functions, without touching live data.
// app.js는 "정의부"와 "화면을 실제로 켜는 실행 코드"로 나뉘고, 그 경계에 표식 주석이 있다.
// 구조가 바뀌어도 표식만 지키면 이 테스트는 그대로 돈다.
const DEFINITIONS_MARKER = '// ---- client.test.js는 이 줄 위까지만';
const script = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
if (!script.includes(DEFINITIONS_MARKER)) throw new Error('app.js에서 테스트가 자르는 표식을 찾지 못했습니다: ' + DEFINITIONS_MARKER);
const definitions = script.slice(0, script.indexOf(DEFINITIONS_MARKER));
function element() {
  const attributes = new Map();
  return {
    value: '', disabled: false, hidden: false, textContent: '', children: [], listeners: {}, dataset: {},
    parent: null, connected: true, blurs: 0,
    get isConnected() { return this.connected; },
    get childNodes() { return this.children; },
    classList: { toggle() {}, contains() { return false; }, add() {}, remove() {} },
    addEventListener(name, handler) { this.listeners[name] = handler; },
    appendChild(child) { if (child && typeof child === 'object') child.parent = this; this.children.push(child); return child; },
    append(...kids) { kids.forEach(kid => this.appendChild(kid)); },
    replaceChildren(...kids) { this.children = []; kids.forEach(kid => this.appendChild(kid)); },
    // 찾기 칸처럼 한 자리만 지우고 나머지는 그대로 두는 다시 그리기(BPVIEW)가 쓴다.
    removeChild(child) {
      const at = this.children.indexOf(child);
      if (at >= 0) { this.children.splice(at, 1); child.parent = null; child.connected = false; }
      return child;
    },
    // 그 자리에서 고치는 입력칸(제목 ↔ 입력칸)이 오가는 길 — 부모의 같은 자리를 바꿔 끼운다.
    replaceWith(node) {
      const parent = this.parent;
      const at = parent ? parent.children.indexOf(this) : -1;
      if (at >= 0) { parent.children[at] = node; node.parent = parent; node.connected = true; }
      this.parent = null;
      this.connected = false;
    },
    // 고정 마크업(체크 아이콘·우선순위 꺾쇠)을 붙이는 자리 — 붙인 글자를 그대로 모아 둔다.
    insertAdjacentHTML(position, html) { this.html = (this.html || '') + html; },
    setAttribute(name, value) { attributes.set(name, value); },
    getAttribute(name) { return attributes.get(name); },
    removeAttribute(name) { attributes.delete(name); },
    querySelectorAll() { return []; },
    querySelector(selector) {
      const want = String(selector).replace(/^\./, '');
      return this.children.find(kid => String(kid?.className || '').split(' ').includes(want)) || null;
    },
    focus() { this.focused = true; },
    blur() { this.blurs += 1; this.focused = false; return this.listeners.blur?.(); },
    select() { this.selected = true; },
  };
}
function client(response) {
  const nodes = new Map();
  let calls = 0;
  const sandbox = {
    document: {
      getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); },
      // 조각(fragment)도 아이를 모아 한 번에 붙이는 그릇이라 같은 가짜 노드로 충분하다.
      createElement: element, createDocumentFragment: element, addEventListener() {},
    },
    window: { addEventListener() {} },
    fetch: async () => { calls++; return typeof response === 'function' ? response() : response.clone(); },
    AbortController, structuredClone,
    setTimeout(fn, delay) { const timer = setTimeout(fn, delay); timer.unref(); return timer; },
    clearTimeout,
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(definitions, context);
  vm.runInContext('load = async () => {};', context);
  return { context, nodes, calls: () => calls, run: code => vm.runInContext(code, context) };
}

test('quick-add preserves the draft and re-enables input after an HTTP error', async () => {
  const app = client(new Response('{"ok":false}', { status: 500 }));
  app.run("setupQuickAdd('draft', '/api/today-task/create', '추가함')");
  const input = app.nodes.get('draft');
  input.value = '저장 실패 후에도 남아야 하는 내용';
  await input.listeners.keydown({ key: 'Enter' });
  assert.equal(input.value, '저장 실패 후에도 남아야 하는 내용');
  assert.equal(input.disabled, false);
  assert.equal(input.focused, true);
  assert.match(app.nodes.get('liveRegion').textContent, /저장됐는지 확인하지 못했어요/);
});

test('quick-add preserves the draft after a connection failure', async () => {
  const app = client(() => { throw new TypeError('Network unavailable'); });
  app.run("setupQuickAdd('draft', '/api/today-task/create', '추가함')");
  const input = app.nodes.get('draft');
  input.value = '초안';
  await input.listeners.keydown({ key: 'Enter' });
  assert.equal(input.value, '초안');
  assert.equal(input.disabled, false);
});

test('quick-add ignores IME composition and clears input only after a successful save', async () => {
  const app = client(new Response('{"ok":true}'));
  app.run("setupQuickAdd('draft', '/api/today-task/create', '추가함')");
  const input = app.nodes.get('draft');
  input.value = '한글 입력';
  await input.listeners.keydown({ key: 'Enter', isComposing: true });
  assert.equal(app.calls(), 0);
  await input.listeners.keydown({ key: 'Enter', isComposing: false });
  assert.equal(app.calls(), 1);
  assert.equal(input.value, '');
  assert.equal(input.disabled, false);
});

test('failed card action stays visible and restores its original checkbox state', async () => {
  const app = client(new Response('{"ok":true}'));
  const checkbox = { checked: true };
  const card = element();
  card.querySelectorAll = () => [checkbox];
  app.context.card = card;
  await app.run("fadeOutAndRun(card, async () => { throw new Error('failed'); }, '완료함')");
  assert.equal(checkbox.checked, false);
  assert.equal(card.getAttribute('aria-busy'), undefined);
  assert.equal(app.nodes.has('liveRegion'), false);
});

test('an older server without the storage endpoint shows no banner', async () => {
  const app = client(new Response('Not found', { status: 404 }));
  app.run("document.getElementById('storageBanner').hidden = true");
  await app.run('refreshStorageStatus()');
  assert.equal(app.nodes.get('storageBanner').hidden, true);
  assert.equal(app.nodes.get('storageBanner').textContent, '');
});

test('a save refused for recovery shows the server message and keeps the banner up', async () => {
  const app = client(new Response(JSON.stringify({ ok: false, code: 'RECOVERY_NEEDED', error: '복구가 필요해서 저장을 멈췄어요.' }), { status: 503 }));
  await assert.rejects(app.run("request('/api/track/toggle', { method: 'POST', body: '{}' })"));
  assert.equal(app.nodes.get('storageBanner').hidden, false);
  assert.match(app.nodes.get('storageBanner').textContent, /복구 필요 상태/);
  assert.match(app.nodes.get('liveRegion').textContent, /저장을 멈췄어요/);
});

// escapeHtml은 브라우저 DOM(textContent → innerHTML)에 기대는데 이 테스트의 가짜 DOM에는 그 동작이 없다.
// 같은 결과를 내는 함수를 넣어, 화면 문자열을 만드는 나머지 로직을 검증한다.
// 화면 코드는 여러 파일로 나뉘어 있고, 브라우저에서는 index.html의 <script> 차례대로
// 같은 전역 공간에서 돈다. 테스트도 같은 가짜 창에 같은 차례로 이어 붙인다.
const CLIENT_PARTS = ['jira-ui.js', 'meeting-notes-ui.js', 'project-new-ui.js', 'projects-ui.js', 'meetings-ui.js', 'waiting-ui.js', 'settings-ui.js', 'wrap-ui.js', 'attention-ui.js'];
function pureClient() {
  const app = client(new Response('{}'));
  CLIENT_PARTS.forEach(file => app.run(fs.readFileSync(path.join(__dirname, file), 'utf8')));
  app.run("escapeHtml = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')");
  return app;
}

// 주간요약 문서의 순수 함수(그룹화·복사 글자)는 report-ui.js에 있다 — 같은 가짜 창에 함께 올린다.
function reportClient() {
  const app = pureClient();
  app.run(fs.readFileSync(path.join(__dirname, 'report-ui.js'), 'utf8'));
  return app;
}

test('the status column shows overdue, due today, carried-over and in-progress, and stays empty when there is nothing to say', () => {
  const app = pureClient();
  const cells = (item, opts = '{}') => app.run(`uiMetaCells(${item}, ${opts})`);
  assert.match(cells("{ due: '2000-01-01' }"), /m-due k-neg"[^>]*>.*기한 \d+일 지남/s);
  assert.match(cells('{ due: todayStr() }'), /m-due k-warn"[^>]*>.*오늘까지/s);
  assert.match(cells('{ due: tomorrowStr() }'), /m-due"[^>]*>.*내일까지/s);
  assert.equal(cells("{ due: '2999-12-31' }"), '', 'a far deadline is not printed on a today row');
  assert.match(cells("{ due: '2999-12-31' }", "{ where: 'full' }"), /12월 31일까지/, 'but it is printed where there is room');
  assert.match(cells("{ scheduled: '2000-01-01' }"), /m-carry"[^>]*>.*\d+일째 밀림/s);
  assert.equal(cells("{ scheduled: '2999-01-01' }"), '', 'a task planned for later is not called carried over');
  assert.match(cells('{ doing: todayStr() }'), /m-doing"[^>]*>.*진행 중/s);
  assert.equal(cells('{ doing: todayStr(), status: "done" }'), '', 'a done task is not shown as in progress');
  assert.equal(cells("{ doing: todayStr() }", '{ inDoingGroup: true }'), '', 'the group heading already says it');
  assert.equal(cells("{ priority: 'medium' }"), '', 'a middling priority is not printed');
  assert.match(cells("{ priority: 'critical' }"), /m-pri k-neg"[^>]*>.*긴급/s);
  assert.match(cells("{ priority: 'high' }"), /m-pri k-warn"[^>]*>.*중요/s, '높음은 화면에서 `중요`로 읽힌다');
  // 기한·밀림·진행에는 작은 아이콘과 풀어 쓴 툴팁이 함께 붙는다.
  assert.match(cells("{ scheduled: '2000-01-01' }"), /title="오늘 하려다 넘어온 업무예요"/);
  assert.match(cells("{ due: '2000-01-01' }"), /<svg class="d-i"/, '상태말 앞에는 종류 아이콘이 붙는다');
  // 우선순위는 아이콘 없이 글자와 색뿐이다(깃발 아이콘을 뺐다).
  assert.doesNotMatch(cells("{ priority: 'critical' }"), /<svg/, '우선순위 표시에는 아이콘이 없다');
  assert.doesNotMatch(cells("{ priority: 'high' }"), /<svg/);
  const escaped = cells('{}', "{ project: '가입 <개선>' }");
  assert.match(escaped, /m-proj">가입 &lt;개선&gt;/, 'user text is escaped');
  assert.doesNotMatch(escaped, /<개선>/);
});

// 업무 줄의 오른쪽에는 **날짜 성격의 말만** 선다 — 우선순위는 왼쪽 체크박스 안의 꺾쇠가 말한다
// (BC의 세 칸 고정은 걷어 냈다 — 빈자리에 글자가 흩어져 보였다. DECISIONS 2026-09-23).
test('업무 줄의 줄 태그는 우선순위 없이 상태 → 기한 차례로, 있는 것만 오른쪽에 붙는다', () => {
  const app = pureClient();
  const cells = (item, opts = '{}') => app.run(`uiMetaCells(${item}, ${opts})`);
  const row = (item, extra = '') => app.run(`uiMetaCells(${item}, { noPriority: true${extra} })`);
  assert.equal(row('{}'), '', '말할 것이 없으면 아무 칸도 만들지 않는다(빈 자리를 남기지 않는다)');
  assert.doesNotMatch(row("{ priority: 'critical' }"), /긴급|m-pri/, '긴급도 줄 오른쪽에는 적지 않는다');
  assert.doesNotMatch(row("{ priority: 'high' }"), /중요|m-pri/);
  assert.equal(row("{ priority: 'high' }"), '', '우선순위뿐이면 줄 오른쪽은 비어 있다');
  const full = row("{ priority: 'critical', scheduled: '2000-01-01', due: '2000-01-01' }", ", waiting: 'waiting'");
  assert.doesNotMatch(full, /m-pri|class="m-c /, 'BC의 세 칸 자리 표시는 남아 있지 않다');
  assert.match(full, /m-wait.*답변 기다리는 중.*m-carry.*일째 밀림.*m-due.*기한 \d+일 지남/s,
    '상태(답변 · 밀림) → 기한 차례이고 기한이 맨 오른쪽이다');
  assert.match(row("{ doing: todayStr() }", ", waiting: 'answered'"), /답변 왔어요.*진행 중/s, '상태가 겹치면 이어 쓴다');
  assert.equal(row("{ due: todayStr() }"), '<span class="m-due k-warn" title="기한은 ' + app.run('uiKoDate(todayStr())')
    + '이에요"><svg class="d-i" viewBox="0 0 16 16" aria-hidden="true">' + app.run('UI_ICONS.calendar') + '</svg>오늘까지</span>',
    '기한만 있으면 기한 한 칸뿐이다');
  // 체크박스가 없는 자리(미루기 제안 줄)에서는 우선순위를 예전처럼 글자로 쓴다.
  assert.match(cells("{ priority: 'high', due: todayStr() }"), /m-pri k-warn.*중요.*오늘까지/s);
  assert.match(cells("{ priority: 'high', scheduled: '2000-01-01', due: todayStr() }"), /중요.*밀림.*오늘까지/s);
});

// 우선순위는 체크박스 안의 위 꺾쇠다 — 중요 한 겹 · 긴급 두 겹. 색만으로 말하지 않는다.
test('업무 체크박스는 우선순위를 꺾쇠·색·말로 함께 알린다', () => {
  const app = pureClient();
  const cell = (item, done = 'false') => JSON.parse(app.run(`(() => {
    const row = document.createElement('div');
    const cell = uiCheckCell(${item}, row, ${done});
    const box = cell.children[0];
    return JSON.stringify({
      cell: cell.className, cls: box.className, label: box.getAttribute('aria-label'), title: box.title || null, html: cell.html,
    });
  })()`));
  const base = { id: 't', description: '가입 문구 검토하기' };
  const critical = cell(JSON.stringify({ ...base, priority: 'critical' }));
  assert.equal(critical.cell, 'd-check');
  assert.equal(critical.cls, 'd-cb is-pri-top');
  assert.equal(critical.title, '가장 먼저 해야 하는 업무예요');
  assert.equal(critical.label, '가입 문구 검토하기 — 긴급 · 완료로 표시');
  assert.match(critical.html, /class="d-pri"/);
  assert.ok(critical.html.includes(app.run('UI_ICONS.priTop')), '긴급은 위 꺾쇠 두 겹이다');

  const high = cell(JSON.stringify({ ...base, priority: 'high' }));
  assert.equal(high.cls, 'd-cb is-pri-high');
  assert.equal(high.title, '중요한 업무예요');
  assert.equal(high.label, '가입 문구 검토하기 — 중요 · 완료로 표시');
  assert.ok(high.html.includes(app.run('UI_ICONS.priHigh')), '중요는 위 꺾쇠 한 겹이다');
  assert.ok(!high.html.includes(app.run('UI_ICONS.priTop')));

  for (const priority of ['medium', 'low', undefined]) {
    const plain = cell(JSON.stringify({ ...base, priority }));
    assert.equal(plain.cls, 'd-cb', `${priority}는 평소 체크박스 그대로다`);
    assert.equal(plain.title, null);
    assert.equal(plain.label, '가입 문구 검토하기 — 완료로 표시');
    assert.doesNotMatch(plain.html, /d-pri/);
  }
  // 완료한 줄에는 꺾쇠가 없다(체크된 파란 네모가 이미 다 말한다).
  const done = cell(JSON.stringify({ ...base, priority: 'critical' }), 'true');
  assert.equal(done.cls, 'd-cb');
  assert.doesNotMatch(done.html, /d-pri/);
  assert.equal(done.label, '가입 문구 검토하기 — 완료로 표시');
  // 사용자 글자는 마크업으로 들어가지 않는다(고정 문자열만 innerHTML로 붙는다).
  const nasty = cell(JSON.stringify({ id: 'x', description: '<img src=x>', priority: 'high' }));
  assert.doesNotMatch(nasty.html, /<img/);
  assert.equal(nasty.label, '<img src=x> — 중요 · 완료로 표시');
});

test('상세 카드의 우선순위 값도 아이콘 없이 글자·색만 쓴다', () => {
  const app = pureClient();
  const cell = (item) => app.run(`(() => {
    const c = panelPriorityCell(${item});
    return { text: c.textContent, html: c.innerHTML, cls: c.className };
  })()`);
  const critical = cell("{ priority: 'critical' }");
  assert.equal(critical.text, '긴급');
  assert.equal(critical.html, undefined, '고정 아이콘 말고는 innerHTML을 쓰지 않는다(사용자 데이터는 textContent로)');
  assert.match(critical.cls, /k-neg/);
  const medium = cell("{ priority: 'medium' }");
  assert.equal(medium.text, '보통', '값을 확인하는 자리라 보통·낮음도 조용히 적는다');
});

test('waiting items put today\'s re-checks on top, then reply deadlines, then when they were added', () => {
  const app = pureClient();
  // 흐름 기록(다시 확인할 날짜·오늘 요청함)은 바깥에서 받아 쓴다 — 순수 함수로 두기 위해서다.
  const order = JSON.parse(app.run(`
    const details = { r: { followUp: '2026-09-20' }, s: { followUp: '2026-09-19', contacted: '2026-09-21' } };
    JSON.stringify(waitingOrder([
      { id: 'c', created: '2026-09-10' },
      { id: 'b', due: '2026-09-25' },
      { id: 'r', created: '2026-09-05' },
      { id: 'a', due: '2026-09-22' },
      { id: 's', created: '2026-09-02' },
      { id: 'd', created: '2026-09-01' }
    ], '2026-09-21', id => details[id] || null).map(i => i.id))`));
  assert.deepEqual(order, ['r', 'a', 'b', 'd', 's', 'c'],
    '오늘 다시 확인할 것이 맨 위 → 기한이 있는 것(빠른 기한 순) → 먼저 등록한 순');
  assert.equal(app.run("String(waitingRecheck({ followUp: '2026-09-19', contacted: '2026-09-21' }, '2026-09-21'))"), 'false',
    '오늘 이미 요청했으면 다시 확인할 것으로 올리지 않는다');
  assert.equal(app.run("String(waitingRecheck({ followUp: '2026-09-25' }, '2026-09-21'))"), 'false', '아직 오지 않은 날짜는 조용하다');
});

test('waitingGroups buckets by project, orders groups by their most urgent row, and keeps the within-group order', () => {
  const app = pureClient();
  const groups = JSON.parse(app.run(`
    const details = { r: { followUp: '2026-09-20' } };
    JSON.stringify(waitingGroups([
      { id: 'misc1', created: '2026-09-10' },
      { id: 'b', due: '2026-09-25', group: '결제팀' },
      { id: 'r', created: '2026-09-05', jira: 'AB-1' },
      { id: 'a', due: '2026-09-22', jira: 'AB-1' },
    ], '2026-09-21', id => details[id] || null).map(([key, group]) => [key, group.map(i => i.id)]))`));
  assert.deepEqual(groups, [
    ['jira:AB-1', ['r', 'a']],
    ['group:결제팀', ['b']],
    ['__misc__', ['misc1']],
  ], '가장 급한 줄(오늘 다시 확인인 r)이 있는 jira:AB-1 묶음이 위로, 프로젝트 없는 것은 맨 아래');
});

test('waitingGroups puts everything in "프로젝트 없음" when nothing has a project', () => {
  const app = pureClient();
  const groups = JSON.parse(app.run(`JSON.stringify(waitingGroups([
    { id: 'x', created: '2026-09-10' },
    { id: 'y', created: '2026-09-11' },
  ], '2026-09-21', () => null).map(([key, group]) => [key, group.map(i => i.id)]))`));
  assert.deepEqual(groups, [['__misc__', ['x', 'y']]]);
});

test('projectFixedOrder keeps a remembered order and appends newly seen keys at the end', () => {
  const app = pureClient();
  const rows = "[{ key: 'a', open: 1 }, { key: 'b', open: 3 }, { key: 'c', open: 0 }]";
  assert.deepEqual(
    JSON.parse(app.run(`JSON.stringify(projectFixedOrder(${rows}, null).map(r => r.key))`)),
    ['a', 'b', 'c'], 'no remembered order (null) leaves the freshly sorted rows untouched');
  assert.deepEqual(
    JSON.parse(app.run(`JSON.stringify(projectFixedOrder(${rows}, ['c', 'a', 'b']).map(r => r.key))`)),
    ['c', 'a', 'b'], 'a remembered order wins over the fresh sort');
  assert.deepEqual(
    JSON.parse(app.run(`JSON.stringify(projectFixedOrder(${rows}, ['a']).map(r => r.key))`)),
    ['a', 'b', 'c'], 'projects not in the remembered order are appended, in their fresh-sort relative order');
});

// BNOARCHIVE: `항목 없는 프로젝트 N개 보기` 토글을 `지난 프로젝트` 구역이 대신한다 —
// 열린 항목이 0이어도 아직 14일이 안 된 프로젝트는 위 목록에 남는다(예전 규칙과 달라진 점).
// 규칙은 조용함(quietKeys) 하나뿐이다 — 사람이 손으로 내리는 길은 없다.
test('projectPastRows: 조용한 것만 지난 프로젝트로 내리고, 지금 보는 것은 남긴다', () => {
  const app = pureClient();
  const rows = "[{ key: 'a', open: 2 }, { key: 'b', open: 0 }, { key: 'c', open: 0 }, { key: 'd', open: 1 }]";
  const split = (options) => JSON.parse(app.run(`JSON.stringify((() => {
    const r = projectPastRows(${rows}, ${options});
    return { active: r.active.map(x => x.key), past: r.past.map(x => x.key) };
  })())`));
  assert.deepEqual(split("{ quietKeys: new Set(['b', 'c']), selectedKey: null }"),
    { active: ['a', 'd'], past: ['b', 'c'] });
  assert.deepEqual(split("{ quietKeys: new Set(['b', 'c']), selectedKey: 'b' }"),
    { active: ['a', 'b', 'd'], past: ['c'] }, '지금 보는 b는 조용해도 위 목록에 남는다');
  assert.deepEqual(split('{}'), { active: ['a', 'b', 'c', 'd'], past: [] });
});

test('조용함은 열린 항목 0 + 마지막 활동 14일 초과이고, 날짜를 하나도 모르면 조용한 것으로 본다', () => {
  const app = pureClient();
  const quiet = (row, last) => app.run(`String(projectQuiet(${row}, ${last === null ? 'null' : `'${last}'`}, '2026-09-22'))`);
  assert.equal(quiet("{ key: 'a', open: 0 }", '2026-09-07'), 'true', '15일 전이면 조용하다');
  assert.equal(quiet("{ key: 'a', open: 0 }", '2026-09-08'), 'false', '딱 14일은 아직 조용하지 않다');
  assert.equal(quiet("{ key: 'a', open: 0 }", '2026-09-22'), 'false');
  assert.equal(quiet("{ key: 'a', open: 0 }", null), 'true', '날짜를 하나도 모르면 조용한 것으로 본다');
  assert.equal(quiet("{ key: 'a', open: 1 }", null), 'false', '열린 항목이 있으면 조용하지 않다');
  assert.equal(quiet('null', null), 'false');
});

test('마지막 활동 날짜는 있는 값만 본다 — 항목의 완료·수정·등록과 회의 날짜 중 가장 최근', () => {
  const app = workflowsClient();
  const items = `[
    { id: 'i1', group: '운영툴', created: '2026-08-01', completed: '2026-08-20' },
    { id: 'i2', group: '운영툴', created: '2026-08-10', updated: '2026-09-02T11:00:00+09:00' },
    { id: 'i3', group: '다른 것', created: '2026-09-20' },
  ]`;
  const meetings = `[
    { id: 'm1', date: '2026-09-05', project: { type: 'group', value: '운영툴' } },
    { id: 'm2', date: '2026-09-21', project: { type: 'group', value: '다른 것' } },
  ]`;
  assert.equal(app.run(`projectLastDay('group:운영툴', ${items}, ${meetings})`), '2026-09-05',
    '회의 날짜도 함께 보고, updated의 시각 부분은 날짜만 읽는다');
  assert.equal(app.run(`String(projectLastDay('group:빈 것', ${items}, ${meetings}))`), 'null', '아는 날짜가 없으면 null이다');
});

test('waiting age turns to the warning colour from the third day of waiting', () => {
  const app = pureClient();
  const age = (created) => JSON.parse(app.run(`JSON.stringify(waitingAgeText('${created}', '2026-09-21'))`));
  assert.deepEqual(age('2026-09-21'), { text: '오늘', tone: '' });
  assert.deepEqual(age('2026-09-20'), { text: '1일째', tone: '' });
  assert.deepEqual(age('2026-09-19'), { text: '2일째', tone: '' }, '이틀째까지는 조용하게');
  assert.deepEqual(age('2026-09-18'), { text: '3일째', tone: 'warn' }, '사흘째부터 눈에 띄게');
  assert.deepEqual(age('2026-09-11'), { text: '10일째', tone: 'warn' });
  assert.equal(app.run("String(waitingAgeText(null, '2026-09-21'))"), 'null', '등록일이 없으면 아무 말도 하지 않는다');
});

// BKEY(2026-09-24): 바깥 화면은 기본(옵션 없음)으로 요약만 보여 준다(모르면 키) — 상세·툴팁 자리만
// { withKey: true }로 `키 · 요약`을 청하고, 고르는 목록만 { picker: true }로 `요약 · 키`를 청한다.
test('uiProjectName: 기본은 요약만(모르면 키), withKey는 상세·툴팁의 "키 · 요약", picker는 고르기의 "요약 · 키"', () => {
  const app = pureClient();
  app.run("jiraIssuesByKey = new Map([['AB-1', { key: 'AB-1', summary: '가입 개선' }]])");
  assert.equal(app.run("uiProjectName({ jira: 'AB-1' })"), '가입 개선', '기본은 요약만');
  assert.equal(app.run("uiProjectName({ jira: 'AB-1' }, { withKey: true })"), 'AB-1 · 가입 개선', 'withKey는 키 · 요약');
  assert.equal(app.run("uiProjectName({ jira: 'AB-1' }, { picker: true })"), '가입 개선 · AB-1', 'picker는 요약 · 키');
  assert.equal(app.run("uiProjectName({ jira: 'ZZ-9' })"), 'ZZ-9', '요약을 모르면 기본도 키 그대로');
  assert.equal(app.run("uiProjectName({ jira: 'ZZ-9' }, { withKey: true })"), 'ZZ-9', 'withKey도 요약을 모르면 키 그대로');
  assert.equal(app.run("uiProjectName({ jira: 'ZZ-9' }, { picker: true })"), 'ZZ-9', 'picker도 요약을 모르면 키 그대로');
  assert.equal(app.run("uiProjectName({ group: '운영툴' })"), '운영툴', '그룹은 요약 개념이 없어 항상 이름 그대로');
  assert.equal(app.run("uiProjectName({ project: '운영툴' })"), '운영툴', "아이디어의 project 필드도 같은 규칙으로 읽는다");
  assert.equal(app.run('uiProjectName(null)'), '');
  assert.equal(app.run('uiProjectName({})'), '');
});

test('the color dot key stays the same regardless of the short/long text (uiProjectColorKey)', () => {
  const app = pureClient();
  app.run("jiraIssuesByKey = new Map([['AB-1', { key: 'AB-1', summary: '가입 개선' }]])");
  assert.equal(app.run("uiProjectColorKey({ jira: 'AB-1' })"), 'AB-1');
  assert.equal(app.run("uiProjectHue(uiProjectColorKey({ jira: 'AB-1' }))"), app.run("uiProjectHue('jira:AB-1')"),
    'the same project keeps the same hue whether it arrives as a bare key or a prefixed group key');
  assert.equal(app.run("uiProjectColorKey({ group: '운영툴' })"), '운영툴');
  assert.equal(app.run("uiProjectColorKey({ project: '운영툴' })"), '운영툴');
});

test('the project column stays empty when the group heading already says it, and jira shows only the summary', () => {
  const app = pureClient();
  app.run("jiraIssuesByKey = new Map([['AB-1', { key: 'AB-1', summary: '가입 개선' }]])");
  assert.equal(app.run("uiProjectLabel({ jira: 'AB-1' }, true)"), '');
  assert.equal(app.run('uiProjectLabel({}, false)'), '');
  assert.equal(app.run("uiProjectLabel({ jira: 'AB-1', group: '운영툴' }, false)"), '가입 개선', 'jira wins and shows the summary, not the key');
  assert.equal(app.run("uiProjectLabel({ jira: 'ZZ-9' }, false)"), 'ZZ-9', 'an unknown jira issue falls back to its key');
  assert.equal(app.run("uiProjectLabel({ group: '운영툴' }, false)"), '운영툴');
});

test('group headings read as "이름 개수"(BKEY: 지라도 요약만, withKey면 키 · 요약)', () => {
  const app = pureClient();
  app.run("jiraIssuesByKey = new Map([['AB-1', { key: 'AB-1', summary: '가입 개선' }]])");
  assert.equal(app.run("uiGroupLabel('jira:AB-1')"), '가입 개선', '기본은 요약만');
  assert.equal(app.run("uiGroupLabel('jira:AB-1', { withKey: true })"), 'AB-1 · 가입 개선', 'withKey는 키 · 요약');
  assert.equal(app.run("uiGroupLabel('jira:ZZ-9')"), 'ZZ-9', 'falls back to the key when the issue is not cached');
  assert.equal(app.run("uiGroupLabel('group:운영툴')"), '운영툴');
  assert.equal(app.run("uiGroupLabel('__misc__')"), '프로젝트 없음');
  const order = JSON.parse(app.run("JSON.stringify(uiGroupTasks([{ id: 1 }, { id: 2, group: '나' }, { id: 3, jira: 'AB-1' }]).map(g => g[0]))"));
  assert.deepEqual(order, ['group:나', 'jira:AB-1', '__misc__'], 'tasks without a project go last');
});

// BKEY: 같은 요약을 가진 지라 이슈가 한 목록에 둘 이상이면 그때만 키로 구분한다.
test('uiGroupLabels: 같은 요약의 지라가 한 목록에 둘이면 그때만 키로 구분하고, 아니면 요약만', () => {
  const app = pureClient();
  app.run(`jiraIssuesByKey = new Map([
    ['AB-1', { key: 'AB-1', summary: '가입 개선' }],
    ['CD-2', { key: 'CD-2', summary: '가입 개선' }],
    ['EF-3', { key: 'EF-3', summary: '정산' }],
  ])`);
  const dupes = JSON.parse(app.run(
    "JSON.stringify([...uiGroupLabels(['jira:AB-1', 'jira:CD-2', 'jira:EF-3', 'group:운영툴'])])"));
  assert.deepEqual(dupes, [
    ['jira:AB-1', 'AB-1 · 가입 개선'],
    ['jira:CD-2', 'CD-2 · 가입 개선'],
    ['jira:EF-3', '정산'],
    ['group:운영툴', '운영툴'],
  ], '겹치는 요약만 키로 구분하고 나머지는 요약만');
  const alone = JSON.parse(app.run("JSON.stringify([...uiGroupLabels(['jira:AB-1', 'jira:EF-3'])])"));
  assert.deepEqual(alone, [['jira:AB-1', '가입 개선'], ['jira:EF-3', '정산']], '겹치지 않으면 요약만');
});

// BKEY: 프로젝트를 고르는 목록은 `요약 · 키`이고, 정렬은 요약 기준이다.
test('group select options offer clearing only when there is something to clear, and jira options read "요약 · 키" sorted by summary', () => {
  const app = pureClient();
  app.run("jiraIssuesCache = [{ key: 'AB-1', summary: '나중 요약' }, { key: 'ZZ-9', summary: '가입' }]; customGroupsCache = ['운영툴', '<b>x</b>']");
  const options = code => JSON.parse(app.run(`JSON.stringify(groupSelectOptions(${code}))`));
  const empty = options('null, false');
  assert.equal(empty.head.length, 1);
  assert.doesNotMatch(empty.head.join(''), /__clear__/);
  assert.equal(options('null, true').head.length, 2, 'bulk move can clear even without a current group');
  const current = options("{ type: 'group', value: '운영툴' }, false");
  assert.equal(current.head.length, 2);
  assert.match(current.rest.join(''), /value="group:운영툴" selected/);
  assert.doesNotMatch(current.rest.join(''), /value="jira:AB-1" selected/);
  assert.match(current.rest.join(''), /&lt;b&gt;x&lt;\/b&gt;/, 'group names are escaped');
  assert.match(current.rest.at(-1), /__custom__/);
  // 지라 옵션은 `요약 · 키`고, 요약 기준으로 정렬된다(값은 그대로 jira:KEY).
  const jiraOptions = current.rest.filter(html => html.includes('value="jira:'));
  assert.deepEqual(jiraOptions, [
    `<option value="jira:ZZ-9">가입 · ZZ-9</option>`,
    `<option value="jira:AB-1">나중 요약 · AB-1</option>`,
  ], '요약이 앞, 키가 뒤 — 정렬은 요약(가입 → 나중 요약) 기준');
});

// BKEY: 항목 상세 카드의 프로젝트 값 — 요약 뒤에 조용한 회색 글자로 키(값 고르개가 닫혀 있을 때의 표시).
test('renderGroupControl: 지라 값은 요약 뒤에 조용한 키가 붙고, 그룹·모르는 키는 그대로다', () => {
  const app = pureClient();
  app.run("jiraIssuesCache = [{ key: 'IO-48394', summary: '게시글 작성하기_게임 임베드' }]; customGroupsCache = []");
  const badge = app.run(
    "renderGroupControl({ jira: 'IO-48394', group: null, onSetJira: () => {}, onSetGroup: () => {} }).children[0]");
  assert.equal(badge.className, 'badge jira-badge');
  assert.equal(badge.textContent, '게시글 작성하기_게임 임베드', '보이는 자리는 요약만');
  assert.equal(badge.children.length, 1);
  assert.equal(badge.children[0].className, 'k-mute');
  assert.equal(badge.children[0].textContent, ' IO-48394', '요약 뒤에 조용한 회색 글자로 키');
  assert.equal(badge.getAttribute('aria-label'), '게시글 작성하기_게임 임베드 IO-48394 — 클릭해서 변경/해제');

  // 요약을 모르는 키는 그대로만(조용한 키 span이 없다 — 이미 키뿐이라 덧붙일 것이 없다).
  const unknown = app.run(
    "renderGroupControl({ jira: 'ZZ-9', group: null, onSetJira: () => {}, onSetGroup: () => {} }).children[0]");
  assert.equal(unknown.textContent, 'ZZ-9');
  assert.equal(unknown.children.length, 0);

  // 그룹은 그대로다(지라 키 같은 것이 없다).
  const group = app.run(
    "renderGroupControl({ jira: null, group: '운영툴', onSetJira: () => {}, onSetGroup: () => {} }).children[0]");
  assert.equal(group.className, 'badge group-badge');
  assert.equal(group.textContent, '운영툴');
  assert.equal(group.children.length, 0);
});

test('dates read as "9월 22일 (화)", without the year', () => {
  const app = pureClient();
  const ko = value => app.run(`uiKoDate(${JSON.stringify(value)})`);
  assert.equal(ko('2026-09-22'), '9월 22일 (화)');
  assert.equal(ko('2026-01-05'), '1월 5일 (월)');
  assert.equal(ko(''), '');
  assert.equal(ko('없음'), '없음', 'a value that is not a date is left alone');
});

test('deadline wording is the same everywhere, and a far deadline is left off a today row', () => {
  const app = pureClient();
  const due = (code, where) => JSON.parse(app.run(`JSON.stringify(uiDueText(${code}, ${JSON.stringify(where)}))`));
  assert.match(due("'2000-01-01'", 'full').text, /^기한 \d+일 지남$/);
  assert.equal(due("'2000-01-01'", 'full').tone, 'urgent');
  assert.deepEqual(due('todayStr()', 'full'), { text: '오늘까지', tone: 'warn' });
  assert.deepEqual(due('tomorrowStr()', 'full'), { text: '내일까지', tone: '' });
  assert.match(due("'2999-12-31'", 'full').text, /^12월 31일까지$/, '먼 기한은 요일 없이 날짜만');
  assert.equal(due("'2999-12-31'", 'full').tone, '');
  assert.equal(due("'2999-12-31'", 'row'), null, 'a far deadline is not printed on a today row');
  assert.equal(due('null', 'full'), null, 'no deadline prints nothing');
});

test('a task carried over says since when, and says nothing on the day it was planned for', () => {
  const app = pureClient();
  const carry = code => app.run(`uiCarryText(${code})`);
  assert.equal(carry('todayStr()'), null);
  assert.equal(carry('tomorrowStr()'), null);
  assert.equal(carry('null'), null);
  assert.match(carry("'2000-01-01'"), /^\d+일째 밀림$/);
});

test('the detail panel sends only the fields the person actually changed', () => {
  const app = pureClient();
  const changes = (initial, current) => JSON.parse(app.run(`JSON.stringify(panelFieldChanges('t1', ${initial}, ${current}))`));
  const base = "{ blockedBy: 'c1', outcome: '', followUp: '' }";
  assert.deepEqual(changes(base, base), { id: 't1' }, 'nothing changed means nothing but the id');
  assert.deepEqual(
    changes(base, "{ blockedBy: 'c1', outcome: '  지표 확인 끝  ', followUp: '' }"),
    { id: 't1', outcome: '지표 확인 끝' },
    'the untouched blockedBy is left out so it cannot overwrite a newer value',
  );
  assert.deepEqual(changes(base, "{ blockedBy: '', outcome: '', followUp: '' }"), { id: 't1', blockedBy: null }, 'an emptied link is sent as null');
  assert.deepEqual(
    changes("{ followUp: '2026-09-22' }", "{ followUp: '' }"),
    { id: 't1', followUp: null },
    'a cleared follow-up date is sent as null, and fields that are not on screen are never sent',
  );
});

test('the detail panel saves without a save button: one request for a change, none when nothing changed', async () => {
  const app = pureClient();
  app.run('var sent = []; var pass = fetch; fetch = (url, options) => { sent.push({ url, body: JSON.parse(options.body) }); return pass(url, options); };');
  const sent = () => JSON.parse(app.run('JSON.stringify(sent)'));

  app.run("var initial = { blockedBy: '', outcome: '' }; var current = { blockedBy: '', outcome: '' }");
  assert.equal(await app.run('panelFieldSave("t1", initial, current)'), false);
  assert.deepEqual(sent(), [], 'leaving a field alone does not save');

  app.run("current.outcome = '릴리스 노트 공유함'");
  assert.equal(await app.run('panelFieldSave("t1", initial, current)'), true);
  assert.deepEqual(sent(), [{ url: '/api/workflow/item', body: { id: 't1', outcome: '릴리스 노트 공유함' } }]);

  // 저장된 값이 새 기준이 되므로, 같은 칸을 다시 떠나도 또 보내지 않는다.
  assert.equal(await app.run('panelFieldSave("t1", initial, current)'), false);
  assert.equal(sent().length, 1);
});

// 회의 모아보기·회의 정리의 판단 로직(workflows.js)은 app.js와 같은 전역 공간에서 돈다.
function workflowsClient() {
  const app = pureClient();
  app.run(fs.readFileSync(path.join(__dirname, 'workflows.js'), 'utf8'));
  return app;
}

test('wfMeetingProjectName: 기본은 요약만(모르면 키), withKey는 "키 · 요약", picker는 "요약 · 키"; 색 점은 셋 다 무관하다', () => {
  const app = workflowsClient();
  app.run("jiraIssuesByKey = new Map([['AB-1', { key: 'AB-1', summary: '가입 개선' }]])");
  const jiraEvent = "{ project: { type: 'jira', value: 'AB-1', label: 'AB-1' } }";
  assert.equal(app.run(`wfMeetingProjectName(${jiraEvent})`), '가입 개선');
  assert.equal(app.run(`wfMeetingProjectName(${jiraEvent}, { withKey: true })`), 'AB-1 · 가입 개선');
  assert.equal(app.run(`wfMeetingProjectName(${jiraEvent}, { picker: true })`), '가입 개선 · AB-1');
  assert.equal(app.run(`wfMeetingColorKey(${jiraEvent})`), 'AB-1');
  const unknownJira = "{ project: { type: 'jira', value: 'ZZ-9', label: 'ZZ-9' } }";
  assert.equal(app.run(`wfMeetingProjectName(${unknownJira})`), 'ZZ-9');
  const groupEvent = "{ project: { type: 'group', value: '가입_개선', label: '가입_개선' } }";
  assert.equal(app.run(`wfMeetingProjectName(${groupEvent})`), '가입 개선', '파일 표기(밑줄)를 사람이 읽는 꼴로 맞춘다');
  assert.equal(app.run(`wfMeetingProjectName(${groupEvent}, { withKey: true })`), '가입 개선');
  assert.equal(app.run('wfMeetingProjectName(null)'), '');
  assert.equal(app.run('wfMeetingProjectName({})'), '');
});

test('projectSimpleRow: source가 있으면 제목 뒤에 조용한 `원문` 링크를 붙인다(아이디어 줄)', () => {
  const app = pureClient();
  const noSource = app.run("projectSimpleRow('문구', '메타', () => {}, 'id1', null)");
  assert.equal(noSource.children.length, 2, '원문이 없으면 예전과 같다');
  const link = app.run("(() => { const a = document.createElement('a'); a.className = 'd-src'; a.textContent = '원문'; return a; })()");
  app.context.__link = link;
  const withSource = app.run("projectSimpleRow('문구', '메타', () => {}, 'id1', null, null, __link)");
  assert.equal(withSource.children.length, 2, '제목+원문이 한 칸으로 묶이고 메타가 둘째 칸이다');
  const wrap = withSource.children[0];
  assert.equal(wrap.className, 'd-titlewrap');
  assert.equal(wrap.children[0].className, 'ti');
  assert.equal(wrap.children[1], link, '원문 링크가 제목 뒤에 그대로 붙는다');
});

test('renderInbox: 프로젝트가 있는 줄에만 조용한 프로젝트 표기가 원문 앞에 붙는다', () => {
  const app = client(new Response('{"ok":true}'));
  app.run("escapeHtml = s => String(s || '')");
  app.run("workflowData = { items: [], meetings: [] }; jiraIssuesByKey = new Map()");
  app.run(`renderInbox([
    { id: 'i1', description: '업무1', group: '결제팀', permalink: 'https://slack.example/1' },
    { id: 'i2', description: '업무2' },
  ])`);
  const list = app.nodes.get('inboxList');
  const findClass = (node, cls) => (node.children || []).find(kid => kid && kid.className === cls);
  const main1 = list.children[0].children[0];
  const tag1 = findClass(main1, 'd-inproj');
  assert.ok(tag1, '프로젝트가 있으면 표기가 붙는다');
  assert.ok(findClass(main1, 'd-src'), '원문 링크도 그대로 붙는다');
  assert.ok(main1.children.indexOf(tag1) < main1.children.indexOf(findClass(main1, 'd-src')), '프로젝트 표기가 원문보다 앞에 선다');
  const main2 = list.children[1].children[0];
  assert.equal(findClass(main2, 'd-inproj'), undefined, '프로젝트가 없으면 지어내지 않는다');
});

test('the palette narrows by kind, by "완료 제외" and by "오늘 신규", and says nothing without a query or a filter', () => {
  const app = workflowsClient();
  app.run(`var pool = [
    { id: 'a', type: 'task', status: 'to-do', created: '2026-09-21', description: '권한 정책 정리' },
    { id: 'b', type: 'bug', status: 'done', created: '2026-09-20', description: '권한 오류 수정' },
    { id: 'c', type: 'check', status: 'to-do', created: '2026-09-21', description: '권한 범위 회신 받기' },
    { id: 'd', type: 'decision', status: 'to-do', created: '2026-09-01', description: '권한은 팀장 승인으로' },
    { id: 'e', type: 'idea', status: 'to-do', created: '2026-09-21', description: '다른 이야기' },
  ]`);
  const ids = state => JSON.parse(app.run(`JSON.stringify(palFilter(pool, { today: '2026-09-21', ...${state} }).map(i => i.id))`));
  assert.deepEqual(ids("{}"), [], '검색어도 필터도 없으면 아무것도 내놓지 않는다');
  assert.deepEqual(ids("{ query: '권한' }"), ['a', 'b', 'c', 'd']);
  assert.deepEqual(ids("{ query: '권한 정리' }"), ['a'], '띄어쓴 낱말은 모두 들어 있어야 한다');
  assert.deepEqual(ids("{ query: '권한', type: 'task' }"), ['a', 'b'], '`할 일`은 버그까지 함께 본다');
  assert.deepEqual(ids("{ query: '권한', type: 'check' }"), ['c']);
  assert.deepEqual(ids("{ query: '권한', hideDone: true }"), ['a', 'c', 'd']);
  assert.deepEqual(ids("{ newOnly: true }"), ['a', 'c', 'e'], '검색어가 없어도 오늘 들어온 것은 전부 보여 준다');
  assert.deepEqual(ids("{ newOnly: true, query: '권한' }"), ['a', 'c']);
  assert.deepEqual(ids("{ query: '권한', type: 'meeting' }"), [], '회의 필터에서는 항목을 섞지 않는다');
});

test('the palette meeting filter keeps drafts to review on top and can narrow to unresolved meetings (decisions never count)', () => {
  const app = workflowsClient();
  app.run(`var events = [
    { id: 'm1', date: '2026-09-20', start: '10:00', title: '주간 운영 회의', drafts: [{ description: '권한 정책 초안' }] },
    { id: 'm2', date: '2026-09-21', start: '09:00', title: '가입 개선 킥오프' },
    { id: 'm3', date: '2026-09-21', start: '14:00', title: '지표 점검' },
  ];
  var related = {
    m2: [{ id: 'x', type: 'task', status: 'to-do', description: '권한 범위 확인' }],
    m3: [{ id: 'y', type: 'task', status: 'done', description: '끝난 일' }, { id: 'z', type: 'decision', status: 'to-do', description: '아직 반영 안 한 결정' }],
  };
  var itemsOf = id => related[id] || [];`);
  const ids = state => JSON.parse(app.run(`JSON.stringify(palMeetings(events, { today: '2026-09-21', ...${state} }, itemsOf).map(e => e.id))`));
  assert.deepEqual(ids("{ type: 'meeting' }"), ['m1', 'm2', 'm3'], '검색어가 없으면 전체, 검토할 초안이 있는 회의가 먼저');
  assert.deepEqual(ids("{ type: 'meeting', unresolved: true }"), ['m2'], '미완료 항목이 남은 회의만 — m3은 안 끝난 결정만 있어 빠진다(결정은 세지 않는다)');
  assert.deepEqual(ids("{ type: 'meeting', reviewOnly: true }"), ['m1']);
  assert.deepEqual(ids("{ type: 'meeting', newOnly: true }"), ['m2', 'm3'], '오늘 열린 회의만, 하루 안에서는 회의 순서대로');
  assert.deepEqual(ids("{ query: '권한' }"), ['m1', 'm2'], '초안 문구와 이 회의에서 나온 항목까지 찾는다');
  assert.deepEqual(ids("{}"), [], '검색어도 회의 필터도 없으면 회의를 끼워 넣지 않는다');
  assert.deepEqual(ids("{ query: '권한', type: 'task' }"), [], '다른 종류를 고르면 회의는 빠진다');
});

// BPAL: 검색 결과 줄에서 바로 완료 체크·`오늘로`를 처리한다(할 일·버그·확인 대기만, 결정·아이디어·회의는 대상 아님).
function palRowClient(response) {
  const app = workflowsClient();
  const sent = [];
  app.context.fetch = async (url, init) => {
    sent.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
    if (typeof response === 'function') return response();
    return response.clone();
  };
  app.run('workflowData = { items: [], meetings: [] }; wfIndexData(); itemsById = new Map();');
  return { app, sent };
}
function palRow(app, item, index = 0, query = '') {
  app.run(`palState = palDefaults({ active: ${index} });`);
  return app.run(`palResultRow({ kind: 'item', item: ${JSON.stringify(item)} }, ${index}, ${JSON.stringify(query)})`);
}

test('BPAL: 체크박스는 대상 종류(할 일·버그·확인 대기)에만 있고, 결정·아이디어는 같은 자리를 비워 둔다', () => {
  const { app } = palRowClient(new Response('{"ok":true}'));
  const cb = (type) => palRow(app, { id: 'x1', type, description: '문구', status: 'to-do' }).children[0];
  ['task', 'bug', 'check'].forEach(type => {
    const cell = cb(type);
    assert.equal(cell.className, 'd-check');
    assert.equal(cell.children.length, 1, `${type}에는 체크박스가 있다`);
  });
  ['decision', 'idea'].forEach(type => {
    const cell = cb(type);
    assert.equal(cell.className, 'd-check', '같은 크기의 칸이 자리를 지킨다');
    assert.equal(cell.children.length, 0, `${type}은 체크박스가 없다`);
  });
  // 회의는 그 칸이 아예 없다 — 첫 칸이 바로 `tag`다.
  app.run(`palState = palDefaults({ active: 0 });`);
  const meetingRow = app.run(`palResultRow({ kind: 'meeting', event: { id: 'm1', title: '회의', date: '2026-09-22', start: '10:00', drafts: [] } }, 0, '')`);
  assert.equal(meetingRow.children[0].className, 'tag', '회의 줄은 예전 그대로다');
});

test('BPAL: 체크박스를 누르면 목록과 같은 toggle 하나로 저장하고, 팔레트는 열린 채로 남는다', async () => {
  const { app, sent } = palRowClient(new Response('{"ok":true}'));
  app.run(`workflowData.items = [{ id: 't1', type: 'task', description: '업무 문구', status: 'to-do' }]; wfIndexData();`);
  const row = palRow(app, { id: 't1', type: 'task', description: '업무 문구', status: 'to-do' });
  const box = firstCheckbox(row.children[0]);
  await box.listeners.change();
  assert.deepEqual(sent.map(call => call.url), ['/api/track/toggle'], '저장 길은 목록과 같은 toggle 하나다');
  assert.deepEqual(sent[0].body, { id: 't1', status: 'done' });
  assert.notEqual(app.run('palState'), null, '처리한 뒤에도 팔레트는 닫히지 않는다');
});

test('BPAL: 체크박스·`오늘로` 클릭은 stopPropagation으로 줄 열기(팔레트 닫고 상세 열기)를 막는다', () => {
  const { app } = palRowClient(new Response('{"ok":true}'));
  const row = palRow(app, { id: 't1', type: 'task', description: '업무 문구', status: 'to-do' });
  let stopped = 0;
  const stub = { stopPropagation: () => { stopped += 1; } };
  row.children[0].listeners.click(stub);
  assert.equal(stopped, 1, '체크박스 칸의 클릭이 멈춘다');
  const todayBtn = nodeFind(row, 'd-headnum');
  todayBtn.listeners.click(stub);
  assert.equal(stopped, 2, '`오늘로` 클릭도 멈춘다');
});

test('BPAL: `오늘로`는 완료가 아니고 오늘이 아닌 할 일·버그에만 있다(확인 대기는 대상 아님)', () => {
  const { app } = palRowClient(new Response('{"ok":true}'));
  const today = app.run('todayStr()');
  const row = (item) => palRow(app, item);
  assert.ok(nodeFind(row({ id: 'a', type: 'task', description: '업무', status: 'to-do', scheduled: '2026-09-01' }), 'd-headnum'),
    '할 일이고 오늘이 아니면 보인다');
  assert.ok(nodeFind(row({ id: 'b', type: 'bug', description: '버그', status: 'to-do' }), 'd-headnum'), '버그도 대상이다');
  assert.equal(nodeFind(row({ id: 'c', type: 'task', description: '업무', status: 'to-do', scheduled: today }), 'd-headnum'), null,
    '이미 오늘이면 보이지 않는다');
  assert.equal(nodeFind(row({ id: 'd', type: 'task', description: '업무', status: 'done', scheduled: '2026-09-01' }), 'd-headnum'), null,
    '완료한 줄에는 없다');
  assert.equal(nodeFind(row({ id: 'e', type: 'check', description: '확인', status: 'to-do', scheduled: '2026-09-01' }), 'd-headnum'), null,
    '확인 대기는 `scheduled`가 아니라 답변 받을 날 개념이라 대상이 아니다');
});

test('BPAL: `오늘로`를 누르면 목록의 `오늘` 칩과 같은 set-scheduled 하나로 저장한다', async () => {
  const { app, sent } = palRowClient(new Response('{"ok":true}'));
  const row = palRow(app, { id: 't1', type: 'task', description: '업무 문구', status: 'to-do', scheduled: '2026-09-01' });
  const todayBtn = nodeFind(row, 'd-headnum');
  await todayBtn.listeners.click({ stopPropagation() {} });
  assert.deepEqual(sent.map(call => call.url), ['/api/track/set-scheduled']);
  assert.deepEqual(sent[0].body, { id: 't1', scheduled: app.run('todayStr()') });
  assert.match(app.nodes.get('liveRegion').textContent, /오늘 할 일로 옮겼어요/);
  assert.notEqual(app.run('palState'), null, '처리한 뒤에도 팔레트는 열려 있다');
});

// 회의 탭 — 팔레트에서 떼어 온 훑어보는 면. 거르는 판단과 처음 고를 회의를 정하는 판단은 순수 함수다.
// 기본 목록은 캘린더 회의가 매일 쌓여도 끝없이 길어지지 않게 기간으로 자른다(BML §1). today는 인자로 받는다.
// 오늘 2026-09-21 기준: recent-*는 14일 안(1일·11일 전), old-*는 14일보다 오래됨(16일·16일·35일 전).
const MEETINGS_TAB_FIXTURE = `var events = [
    { id: 'today1', date: '2026-09-21', start: '09:00', title: '가입 개선 킥오프', project: { type: 'group', value: '가입 개선', label: '가입 개선' } },
    { id: 'today2', date: '2026-09-21', start: '14:00', title: '지표 점검' },
    { id: 'future', date: '2026-09-25', start: '10:00', title: '다음 주 회고' },
    { id: 'recent-record', date: '2026-09-20', start: '10:00', title: '주간 운영 회의', project: { type: 'group', value: '운영툴', label: '운영툴' }, drafts: [{ description: '권한 정책 초안' }] },
    { id: 'recent-norecord', date: '2026-09-10', start: '16:00', title: '운영툴 회고', project: { type: 'group', value: '운영툴', label: '운영툴' } },
    { id: 'old-open', date: '2026-09-05', start: '11:00', title: '오래된 미완료 회의' },
    { id: 'old-done', date: '2026-09-05', start: '09:00', title: '오래된 완료 회의' },
    { id: 'old-norecord', date: '2026-08-17', start: '09:00', title: '아주 오래된 기록 없는 회의' },
  ];
  var related = {
    'today1': [{ id: 'a', type: 'task', status: 'to-do', description: '권한 범위 확인' }],
    'old-open': [{ id: 'b', type: 'task', status: 'to-do', description: '안 끝난 일' }],
    'old-done': [{ id: 'c', type: 'check', status: 'done', description: '끝난 일' }],
  };
  var itemsOf = id => related[id] || [];`;

test('회의 탭 기본 목록: 오늘(과 미래) 전부 + 14일 안의 기록 있는 회의 + 오래됐어도 손댈 일 남은 회의, 기록 없는 지난 회의는 숨긴다', () => {
  const app = workflowsClient();
  app.run(MEETINGS_TAB_FIXTURE);
  const ids = state => JSON.parse(app.run(
    `JSON.stringify(meetingsTabList(events, { today: '2026-09-21', ...${state} }, itemsOf).map(e => e.id))`));
  assert.deepEqual(ids('{}'), ['future', 'today1', 'today2', 'recent-record', 'old-open'],
    '미래·오늘 전부 + 14일 안의 기록 있는 회의 + 14일 밖이어도 미완료가 남은 회의. ' +
    'recent-norecord(기록 없음)·old-done(끝났고 14일 밖)·old-norecord(기록 없고 14일 밖)는 빠진다');
  assert.deepEqual(ids("{ windowDays: 28 }"), ['future', 'today1', 'today2', 'recent-record', 'old-done', 'old-open'],
    '기간을 넓히면 그 안에 들어온 기록 있는 회의(old-done)가 나온다 — old-norecord는 아직 기간 밖');
  assert.deepEqual(ids("{ showNoRecord: true }"), ['future', 'today1', 'today2', 'recent-record', 'recent-norecord', 'old-open'],
    '`빈 회의 포함`을 켜면 보이는 기간 안의 기록 없는 지난 회의(recent-norecord)도 나온다 — 기간 밖의 old-norecord는 그대로 빠진다');
  assert.deepEqual(ids("{ windowDays: 42, showNoRecord: true }"),
    ['future', 'today1', 'today2', 'recent-record', 'recent-norecord', 'old-done', 'old-open', 'old-norecord'],
    '기간을 충분히 넓히고 토글도 켜면 전부 나온다');
});

// BMGROUP: 프로젝트 드롭다운은 없앴다 — 목록을 거르는 것은 칩 둘뿐이고, 프로젝트는 `프로젝트별` 보기가 맡는다.
test('회의 탭 필터(초안 있음·미완료만)를 켜면 기간·기록 유무와 상관없이 전체 회의에서 거른다', () => {
  const app = workflowsClient();
  app.run(MEETINGS_TAB_FIXTURE);
  const ids = state => JSON.parse(app.run(
    `JSON.stringify(meetingsTabList(events, { today: '2026-09-21', ...${state} }, itemsOf).map(e => e.id))`));
  assert.deepEqual(ids("{ reviewOnly: true }"), ['recent-record'], '초안 있음만');
  assert.deepEqual(ids("{ unresolved: true }"), ['today1', 'old-open'],
    '미완료 항목이 남은 회의만 — 기간 밖인 old-open도 찾아낸다(찾는 행동이라 기간 제한이 없다)');
  assert.deepEqual(ids("{ reviewOnly: true, unresolved: true }"), [], '조건은 함께 걸린다');
  // 프로젝트는 이제 거르지 않는다 — 목록은 그대로고 화면이 소제목으로 묶을 뿐이다.
  assert.deepEqual(ids("{ project: 'group:운영툴' }"), ids('{}'), '옛 프로젝트 필터 값은 아무 일도 하지 않는다');
});

test('`이전 회의 더 보기`를 보일지(순수 함수): 지금 기간보다 오래된 회의가 남아 있으면 더 넓힐 것이 있다', () => {
  const app = workflowsClient();
  app.run(MEETINGS_TAB_FIXTURE);
  const hasMore = (windowDays, showNoRecord = false) => app.run(`meetingsHasMoreBeyond(events, '2026-09-21', ${windowDays}, { showNoRecord: ${showNoRecord}, itemsOf })`);
  assert.equal(hasMore(14), true, 'old-done(16일 전, 기록 있음)이 기간을 넓히면 새로 나온다');
  assert.equal(hasMore(16), false, '남은 것이 이미 보이는 회의(old-open)와 기록 없는 회의뿐이면 눌러도 늘어나지 않으니 감춘다');
  assert.equal(hasMore(16, true), true, '`빈 회의 포함`을 켰으면 old-norecord(35일 전)가 남아 있다');
  assert.equal(hasMore(35, true), false, '더 오래된 회의가 없으면 버튼을 감춘다');
});

test('회의 탭이 처음 고르는 회의: 검토할 초안이 있으면 그중 가장 최근 → 오늘 남은 회의 → 가장 최근, 고른 것이 있으면 그대로', () => {
  const app = workflowsClient();
  app.run(`var list = [
    { id: 'm1', date: '2026-09-20', start: '10:00', drafts: [{}] },
    { id: 'm2', date: '2026-09-21', start: '09:00' },
    { id: 'm3', date: '2026-09-21', start: '14:00' },
    { id: 'm4', date: '2026-09-19', start: '16:00' },
  ];`);
  const pick = (list, current, now) => app.run(`String(meetingsTabPick(${list}, ${JSON.stringify(current)}, '2026-09-21', '${now}'))`);
  assert.equal(pick('list', null, '08:00'), 'm1', '검토할 초안이 있는 회의가 먼저다(그중 가장 최근)');
  assert.equal(pick('list', 'm3', '08:00'), 'm3', '이미 고른 회의가 목록에 있으면 그대로 둔다');
  assert.equal(pick("list.filter(e => e.id !== 'm1')", 'm1', '08:00'), 'm2', '거른 목록에 없으면 다시 고른다');
  assert.equal(pick("list.filter(e => e.id !== 'm1')", null, '08:00'), 'm2', '검토할 초안이 없으면 오늘 남은 회의 중 가장 이른 것');
  assert.equal(pick("list.filter(e => e.id !== 'm1')", null, '23:00'), 'm2', '오늘 남은 회의가 없으면 가장 최근 회의(목록 맨 앞, 날짜 내림차순)');
  assert.equal(pick('[]', null, '08:00'), 'null', '회의가 없으면 고를 것도 없다');
});

test('목록 밖의 회의를 열면 막고 있는 필터를 끄거나 기간을 넓혀서라도 오른쪽 내용을 반드시 연다', () => {
  const app = workflowsClient();
  app.run(`
    var today = todayStr();
    function daysAgo(n) {
      const d = new Date(today + 'T00:00:00'); d.setDate(d.getDate() - n);
      return \`\${d.getFullYear()}-\${String(d.getMonth() + 1).padStart(2, '0')}-\${String(d.getDate()).padStart(2, '0')}\`;
    }
    workflowData = { items: [], meetings: [{ id: 'far', date: daysAgo(40), start: '09:00', title: '아주 오래된 회의' }] };
    wfIndexData();
    meetingsTabState = { key: null, unresolved: false, reviewOnly: true, project: '', windowDays: 14, showNoRecord: false, result: null };
  `);
  assert.deepEqual(
    JSON.parse(app.run("JSON.stringify(meetingsTabList(workflowData.meetings, meetingsTabState, wfMeetingItems).map(e => e.id))")),
    [], '초안이 없는 회의라 `초안 있음` 필터에 걸려 처음에는 안 보인다');
  app.run("meetingsTabRevealIfNeeded('far')");
  assert.equal(app.run('String(meetingsTabState.reviewOnly)'), 'false', '가리고 있던 `초안 있음` 필터를 끈다');
  assert.equal(app.run('meetingsTabState.windowDays >= 40'), true, '그 회의가 들어올 만큼 보이는 기간을 넓힌다');
  assert.equal(app.run('String(meetingsTabState.showNoRecord)'), 'true', '기록도 없는 회의라 그 토글도 함께 켠다');
  assert.deepEqual(
    JSON.parse(app.run("JSON.stringify(meetingsTabList(workflowData.meetings, meetingsTabState, wfMeetingItems).map(e => e.id))")),
    ['far'], '이제 기본 목록에 나타난다');
});

test('회의 탭 줄: `초안 N` 배지·`미완료 N` 글자는 title로 뜻을 풀고, 미완료는 할 일·확인 대기만 센다', () => {
  const app = workflowsClient();
  app.run(`
    workflowData = { items: [
      { id: 'a', type: 'task', status: 'to-do', meetingId: 'm1' },
      { id: 'b', type: 'decision', status: 'to-do', meetingId: 'm1' },
    ], meetings: [] };
    wfIndexData();
    meetingsTabState = { key: null, unresolved: false, reviewOnly: false, project: '', windowDays: 14, showNoRecord: false, result: null };
  `);
  const cells = event => JSON.parse(app.run(`(() => {
    const row = meetingsTabRow(${event});
    const badge = row.children[2];
    return JSON.stringify({ text: badge.textContent, title: badge.title });
  })()`));
  const withoutDrafts = cells("{ id: 'm1', title: '주간 회의' }");
  assert.equal(withoutDrafts.text, '미완료 1', '결정 1건은 안 끝났어도 세지 않는다 — 할 일 1건만');
  assert.equal(withoutDrafts.title, '이 회의에서 나온 할 일·확인 대기 중 1개가 아직 안 끝났어요');
  const withDrafts = cells("{ id: 'm1', title: '주간 회의', drafts: [{}, {}] }");
  assert.equal(withDrafts.text, '초안 2');
  assert.equal(withDrafts.title, 'AI가 뽑은 초안 2개를 아직 검토하지 않았어요');
});

test('회의 탭 이름 옆 숫자는 검토를 기다리는 초안이 있는 회의 수다', () => {
  const app = workflowsClient();
  const count = code => Number(app.run(`meetingsReviewCount(${code})`));
  assert.equal(count(`[{ drafts: [{}] }, { drafts: [{}, {}] }, { drafts: [] }, {}]`), 2, '초안 수가 아니라 회의 수다');
  assert.equal(count('[]'), 0);
  assert.equal(count('null'), 0);
});

test('회의 탭의 결과 카드는 줄 옆 카드와 다른 자리에 담기고, 회의를 바꾸면 내려간다', () => {
  const app = workflowsClient();
  app.run("panelState = { kind: 'meeting', id: 'm1', result: { meetingId: 'm1' } }; meetingsTabState.key = 'm2'; meetingsTabState.result = { meetingId: 'm2' };");
  assert.equal(app.run('MEETING_HOST_CARD.getResult().meetingId'), 'm1');
  assert.equal(app.run('MEETING_HOST_TAB.getResult().meetingId'), 'm2');
  app.run('MEETING_HOST_TAB.setResult(null)');
  assert.equal(app.run('String(MEETING_HOST_TAB.getResult())'), 'null');
  assert.equal(app.run('MEETING_HOST_CARD.getResult().meetingId'), 'm1', '두 자리는 서로의 결과 카드를 건드리지 않는다');
  // 다른 회의를 고르면 방금 담은 결과는 그 회의의 것이라 함께 내려간다(줄 옆 카드가 회의를 옮길 때와 같다).
  app.run("meetingsTabState.result = { meetingId: 'm2' }; meetingsTabSelect('m2');");
  assert.equal(app.run('MEETING_HOST_TAB.getResult().meetingId'), 'm2', '같은 회의를 다시 고르는 것은 아무 일도 아니다');
  app.run("meetingsTabSelect('m3')");
  assert.equal(app.run('String(MEETING_HOST_TAB.getResult())'), 'null');
  assert.equal(app.run('meetingsTabState.key'), 'm3');
});

// 팔레트는 찾는 창이다 — 회의 전용 토글은 회의 탭으로 갔고, 대신 그 탭으로 가는 조용한 링크가 바닥에 붙는다.
function paletteChips(app, state) {
  app.run(`palState = palDefaults(${state});
    palNodes = { chips: document.createElement('div'), input: document.createElement('input'),
      results: document.createElement('div'), foot: document.createElement('div') };
    palFilterChips();`);
  return JSON.parse(app.run(`(() => {
    const out = [];
    const walk = node => (node.children || []).forEach(kid => { if (kid.textContent) out.push(kid.textContent); walk(kid); });
    walk(palNodes.chips);
    return JSON.stringify(out);
  })()`));
}

test('팔레트 필터 줄에는 회의 전용 토글이 없다 — `미완료만`·`초안 있음`은 회의 탭으로 옮겼다', () => {
  const app = workflowsClient();
  const all = paletteChips(app, "{ type: 'meeting' }");
  assert.deepEqual(all, ['전체', '할 일', '확인 대기', '결정', '아이디어', '회의', '완료 제외'],
    '종류 칩과 `완료 제외`만 남는다');
  assert.ok(!all.includes('미완료만') && !all.includes('초안 있음'));
  assert.deepEqual(paletteChips(app, '{}'), all, '다른 종류를 골라도 칩 줄이 흔들리지 않는다');
});

test('회의 탭 필터 줄의 칩 이름: `초안 있음`·`미완료만`·`빈 회의 포함` + 보기 전환 세그먼트(드롭다운은 없다)', () => {
  const app = workflowsClient();
  app.run("meetingsTabState = { key: null, unresolved: false, reviewOnly: false, windowDays: 14, showNoRecord: false, result: null };");
  const bar = app.run('meetingsTabFilters()');
  const labels = bar.children.filter(kid => kid.textContent)
    .map(kid => [kid.textContent, kid.title || null, kid.getAttribute('aria-description') || null]);
  assert.deepEqual(labels, [['초안 있음', null, null], ['미완료만', null, null],
    ['빈 회의 포함', '아무것도 담지 않은 회의도 함께 보여요', '아무것도 담지 않은 회의도 함께 보여요']],
    '짧은 칩 이름의 뜻은 툴팁과 읽어 주는 설명이 함께 풀어 준다');
  // BMGROUP: 프로젝트 드롭다운(.d-msel)은 없앴고 그 자리에 두 칸 세그먼트가 선다.
  assert.equal(nodeFind(bar, 'd-msel'), null, '프로젝트 고르는 드롭다운은 더 이상 없다');
  const seg = nodeFind(bar, 'd-seg');
  assert.ok(seg, '`.d-seg` 부품을 그대로 쓴다');
  assert.equal(seg.getAttribute('aria-label'), '회의 목록 보기');
  assert.deepEqual(seg.children.map(kid => [kid.textContent, kid.getAttribute('aria-pressed')]),
    [['날짜순', 'true'], ['프로젝트별', 'false']], '보기 전환이라 aria-pressed를 쓴다(기본은 날짜순)');
});

// ---------- BMGROUP: 회의 목록의 두 보기(날짜순 · 프로젝트별) ----------
// 오늘을 기준으로 잡은 회의 넷: 운영툴(반복, 오늘 + 지난 회차) · 결제 리뉴얼 · 프로젝트 없음.
function meetingsViewClient() {
  const app = workflowsClient();
  app.run(`
    load = async () => {};
    meetingNotesApply({ used: false, state: 'idle' });
    var today = todayStr();
    function dayAgo(n) {
      const d = new Date(today + 'T00:00:00'); d.setDate(d.getDate() - n);
      return \`\${d.getFullYear()}-\${String(d.getMonth() + 1).padStart(2, '0')}-\${String(d.getDate()).padStart(2, '0')}\`;
    }
    var ops = { type: 'group', value: '운영툴', label: '운영툴' };
    var pay = { type: 'group', value: '결제 리뉴얼', label: '결제 리뉴얼' };
    workflowData = {
      items: [
        { id: 't1', type: 'task', status: 'to-do', description: '권한 범위 확인', meetingId: 'ops1', group: '운영툴' },
        { id: 't2', type: 'task', status: 'to-do', description: '발송 정책 검토', meetingId: 'ops1', group: '알림센터' },
        { id: 'c1', type: 'check', status: 'to-do', description: '법무 회신 받기', meetingId: 'ops1', group: '운영툴' },
        { id: 'd1', type: 'decision', status: 'to-do', description: '재시도는 3회', meetingId: 'ops1', group: '운영툴' },
        { id: 't0', type: 'task', status: 'to-do', description: '지난 회차에 남은 일', meetingId: 'ops0', group: '운영툴' },
        { id: 'd2', type: 'decision', status: 'to-do', description: '정산 주기는 월 1회', meetingId: 'pay1', group: '결제 리뉴얼' },
        { id: 't3', type: 'task', status: 'to-do', description: '자유 논의에서 나온 일', meetingId: 'free1' },
      ],
      meetings: [
        { id: 'ops1', date: today, start: '10:00', title: '운영툴 주간 싱크', series: '운영툴 주간 싱크', project: ops },
        { id: 'ops0', date: dayAgo(7), start: '10:00', title: '운영툴 주간 싱크', series: '운영툴 주간 싱크', project: ops },
        { id: 'pay1', date: dayAgo(1), start: '14:00', title: '결제 리뉴얼 PRD 리뷰', series: '결제 리뉴얼 PRD 리뷰', project: pay },
        { id: 'free1', date: dayAgo(2), start: '09:00', title: '자유 논의' },
      ],
    };
    wfIndexData();
    meetingsTabState = { key: 'ops1', unresolved: false, reviewOnly: false, windowDays: 14, showNoRecord: false, result: null };
    meetingsTabClosed.clear();
  `);
  return app;
}
const meetingsHeadings = list => nodeFindAll(list, 'd-grp')
  .map(head => [nodeFind(head, 'gl').textContent, head.getAttribute('aria-expanded')]);
const meetingsRowIds = app => nodeFindAll(app.nodes.get('meetingList'), 'd-mtrow')
  .map(row => nodeFind(row, 'ti').textContent);

test('회의 목록의 프로젝트별 보기: 미완료가 남은 프로젝트가 먼저, `프로젝트 없음`은 맨 끝', () => {
  const app = meetingsViewClient();
  // 순수 함수부터 — 화면과 같은 차례를 이 함수 하나가 정한다.
  const groups = JSON.parse(app.run(`JSON.stringify(
    meetingsTabGroups(meetingsTabList(workflowData.meetings, meetingsTabState, wfMeetingItems), wfMeetingItems)
      .map(g => [g.key, g.open, g.list.map(e => e.id)]))`));
  assert.deepEqual(groups, [
    ['group:운영툴', 4, ['ops1', 'ops0']],
    ['group:결제 리뉴얼', 0, ['pay1']],
    ['__misc__', 1, ['free1']],
  ], '미완료가 있는 운영툴이 먼저(그 안은 날짜 내림차순), 미완료가 없는 결제 리뉴얼이 뒤, 프로젝트 없음은 미완료가 있어도 맨 끝');

  app.run("meetingsTabView = 'project'; renderMeetings();");
  const list = app.nodes.get('meetingList');
  assert.deepEqual(meetingsHeadings(list),
    [['운영툴', 'true'], ['결제 리뉴얼', 'true'], ['프로젝트 없음', 'true']],
    '소제목은 접히는 그룹 제목 부품이라 aria-expanded를 들고 있다');
  assert.deepEqual(meetingsRowIds(app), ['운영툴 주간 싱크', '운영툴 주간 싱크', '결제 리뉴얼 PRD 리뷰', '자유 논의']);
  // 날짜 소제목이 없으니 줄이 날짜를 함께 적는다.
  const first = nodeFindAll(list, 'd-mtrow')[0];
  assert.match(first.children[0].textContent, /^\d+\/\d+ 10:00$/, '`9/22 10:00`처럼 날짜 + 시각이다');
  assert.equal(nodeFind(first, 'pj'), null, '소제목이 이미 프로젝트를 말해 주므로 줄에서는 뺀다');
  assert.equal(nodeFind(list, 'd-mtday'), null, '프로젝트별 보기에는 날짜 소제목이 없다');
});

test('회의 목록의 두 보기는 같은 줄을 보여 준다 — 칩 셋은 두 보기에서 똑같이 걸린다', () => {
  const app = meetingsViewClient();
  app.run("meetingsTabView = 'date'; renderMeetings();");
  const byDate = meetingsRowIds(app);
  assert.ok(nodeFind(app.nodes.get('meetingList'), 'd-mtday'), '날짜순에는 날짜 소제목이 있다');
  app.run("meetingsTabView = 'project'; renderMeetings();");
  assert.deepEqual([...meetingsRowIds(app)].sort(), [...byDate].sort(), '거르는 결과는 보기와 무관하다');

  // `미완료만` 칩은 두 보기에서 같은 줄을 남긴다(결제 리뉴얼은 결정뿐이라 빠진다).
  app.run("meetingsTabState.unresolved = true; meetingsTabView = 'date'; renderMeetings();");
  const urgentByDate = meetingsRowIds(app);
  app.run("meetingsTabView = 'project'; renderMeetings();");
  assert.deepEqual([...meetingsRowIds(app)].sort(), [...urgentByDate].sort());
  assert.ok(!urgentByDate.includes('결제 리뉴얼 PRD 리뷰'), '미완료가 없는 회의는 두 보기 모두에서 빠진다');
  assert.deepEqual(meetingsHeadings(app.nodes.get('meetingList')).map(([name]) => name), ['운영툴', '프로젝트 없음']);
});

test('프로젝트 소제목을 누르면 그 프로젝트만 접힌다 — 세션 동안만 기억하고 고른 회의는 다시 펼친다', () => {
  const app = meetingsViewClient();
  app.run("meetingsTabView = 'project'; renderMeetings();");
  const head = nodeFindAll(app.nodes.get('meetingList'), 'd-grp')[0];
  head.listeners.click();
  assert.equal(app.run("meetingsTabClosed.has('group:운영툴')"), true);
  assert.deepEqual(meetingsHeadings(app.nodes.get('meetingList')),
    [['운영툴', 'false'], ['결제 리뉴얼', 'true'], ['프로젝트 없음', 'true']]);
  assert.deepEqual(meetingsRowIds(app), ['결제 리뉴얼 PRD 리뷰', '자유 논의'], '접은 프로젝트의 줄은 빠진다');
  // 목록 밖의 회의를 열면 그 프로젝트는 다시 펼쳐진다 — 오른쪽 내용은 반드시 보여야 한다.
  app.run("meetingsTabRevealIfNeeded('ops1'); renderMeetings();");
  assert.equal(app.run("meetingsTabClosed.has('group:운영툴')"), false);
});

test('보기 전환은 브라우저에 기억한다(기본은 날짜순) — 접어 둔 프로젝트는 기억하지 않는다', () => {
  const app = meetingsViewClient();
  app.run("var saved = {}; localStorage = { getItem: k => (k in saved ? saved[k] : null), setItem: (k, v) => { saved[k] = String(v); } };");
  app.run("setMeetingsView('project')");
  assert.equal(app.run('meetingsTabView'), 'project');
  assert.equal(app.run("saved['meetingsView']"), 'project');
  app.run("setMeetingsView('date')");
  assert.equal(app.run("saved['meetingsView']"), 'date');
  // 값이 깨졌거나 저장소를 못 읽어도 기본은 날짜순이다.
  app.run("setMeetingsView('엉뚱한 값')");
  assert.equal(app.run('meetingsTabView'), 'date');
});

test('회의 정리 부제목의 프로젝트 이름을 누르면 왼쪽이 프로젝트별로 바뀌고 그 프로젝트만 펼쳐진다', () => {
  const app = meetingsViewClient();
  app.run("meetingsTabView = 'date'; renderMeetings();");
  // 줄 옆 카드에는 갈 왼쪽 목록이 없으니 예전처럼 글자로만 적는다.
  const card = app.run("panelMeetingWhenLine(workflowData.meetings[0], MEETING_HOST_CARD)");
  assert.equal(nodeFind(card, 'pjlink'), null);
  assert.match(card.textContent, /운영툴$/);

  const sub = app.run("panelMeetingWhenLine(workflowData.meetings[0], MEETING_HOST_TAB)");
  const link = nodeFind(sub, 'pjlink');
  assert.equal(link.textContent, '운영툴');
  assert.equal(link.getAttribute('aria-label'), '운영툴 회의만 모아 보기');
  link.listeners.click();
  assert.equal(app.run('meetingsTabView'), 'project');
  assert.deepEqual(meetingsHeadings(app.nodes.get('meetingList')),
    [['운영툴', 'true'], ['결제 리뉴얼', 'false'], ['프로젝트 없음', 'false']], '고른 프로젝트만 펼쳐진 채로 선다');
  assert.deepEqual(meetingsRowIds(app), ['운영툴 주간 싱크', '운영툴 주간 싱크']);
});

test('`더 보기`는 날짜순에서는 목록 끝 한 줄, 프로젝트별에서는 프로젝트마다 `더 보기 N`이다', () => {
  const app = meetingsViewClient();
  // 보이는 기간(14일) 밖의 기록 있는 운영툴 회의 둘을 더 둔다.
  app.run(`
    workflowData.meetings.push(
      { id: 'ops-old1', date: dayAgo(20), start: '10:00', title: '운영툴 옛 싱크', series: '운영툴 주간 싱크', project: ops },
      { id: 'ops-old2', date: dayAgo(30), start: '10:00', title: '운영툴 더 옛 싱크', series: '운영툴 주간 싱크', project: ops });
    workflowData.items.push(
      { id: 'o1', type: 'task', status: 'done', description: '끝난 일', meetingId: 'ops-old1', group: '운영툴' },
      { id: 'o2', type: 'task', status: 'done', description: '끝난 일2', meetingId: 'ops-old2', group: '운영툴' });
    wfIndexData();
  `);
  app.run("meetingsTabView = 'date'; renderMeetings();");
  let more = nodeFindAll(app.nodes.get('meetingList'), 'd-mmore');
  assert.deepEqual(more.map(node => nodeText(node)), ['이전 회의 더 보기'], '날짜순은 목록 끝에 한 줄이다');

  app.run("meetingsTabView = 'project'; renderMeetings();");
  more = nodeFindAll(app.nodes.get('meetingList'), 'd-mmore');
  assert.deepEqual(more.map(node => [node.className, nodeText(node)]),
    [['d-mmore is-in', '더 보기 2']], '프로젝트별은 그 프로젝트의 소제목 아래에 개수와 함께 붙는다');
  more[0].children[0].listeners.click();
  assert.equal(app.run('meetingsTabState.windowDays'), 28, '누르면 보이는 기간이 14일씩 늘어난다');
});

test('프로젝트 소제목 옆의 지라 상태는 앱이 그 티켓을 들고 있을 때만, 범주 색으로 붙는다', () => {
  const app = meetingsViewClient();
  const note = key => app.run(`meetingsProjectStatus(${JSON.stringify(key)})`);
  assert.equal(note('group:운영툴'), null, '지라와 이어지지 않은 그룹에는 아무것도 붙이지 않는다');
  assert.equal(note('__misc__'), null);
  app.run("jiraIssuesByKey = new Map([['AL-1', { key: 'AL-1', summary: '알림센터', status: { name: '진행 중', category: 'doing' } }]]);");
  assert.equal(note('jira:AL-9'), null, '모르는 티켓이면 생략한다');
  const doing = note('jira:AL-1');
  assert.equal(doing.textContent, '진행 중');
  assert.equal(doing.className, 'js k-acc', '진행 중은 파란 글자(BJCOLOR)');
  // 손으로 걸어 둔 그룹도 같은 길을 쓴다(jiraKeyOf).
  app.run("workflowData.projectLinks = { '운영툴': 'AL-1' };");
  assert.equal(note('group:운영툴').textContent, '진행 중');
  // 대비책 파일에서 온 목록은 상태가 글자뿐이라(범주가 없다) 아무것도 붙이지 않는다.
  app.run("jiraIssuesByKey = new Map([['AL-1', { key: 'AL-1', summary: '알림센터', status: '진행 중' }]]);");
  assert.equal(note('jira:AL-1'), null);
});

// ---------- BMGROUP: `이 회의에서 나온 것`의 종류 소제목 ----------
// 구역의 모양을 한 줄씩 읽는다: 소제목이면 그 글자, 줄이면 class + 제목.
function meetingSectionShape(section) {
  return section.children.slice(1).map((node) => {
    const cls = String(node.className || '');
    if (cls.includes('d-mgrp')) return `소제목 ${cls.includes('is-pj') ? '(프로젝트)' : ''}${nodeText(node)}`.replace('  ', ' ');
    if (cls.includes('d-mrow2')) return `${cls} | ${nodeFind(node, 'ti').textContent}`;
    return cls;
  });
}
const meetingSection = (app, code) => app.run(`(() => { const box = document.createElement('div'); ${code}; return box.children[0]; })()`);

test('`이 회의에서 나온 것`은 종류 소제목으로 나뉘고, 한 종류 안에 프로젝트가 둘 이상일 때만 한 번 더 나뉜다', () => {
  const app = meetingsViewClient();
  const section = meetingSection(app, "panelMeetingItems(workflowData.meetings[0], box)");
  assert.equal(section.children[0].textContent, '이 회의에서 나온 것 4', '구역 제목은 그대로다');
  assert.deepEqual(meetingSectionShape(section), [
    '소제목 할 일 2',
    '소제목 (프로젝트)알림센터',
    'd-mrow2 no-tg | 발송 정책 검토',
    '소제목 (프로젝트)운영툴',
    'd-mrow2 no-tg | 권한 범위 확인',
    '소제목 확인 대기 1',
    'd-mrow2 no-tg | 법무 회신 받기',
    '소제목 결정 1',
    'd-mrow2 no-tg | 재시도는 3회',
  ], '할 일에는 프로젝트가 둘이라 한 번 더 나뉘고, 확인 대기·결정은 하나뿐이라 나누지 않는다');
  // 소제목이 종류를 말해 주므로 줄에서는 종류 글자를 뺀다(두 번 말하지 않는다 — `no-tg`).
  const rows = nodeFindAll(section, 'd-mrow2');
  assert.ok(rows.every(row => nodeFind(row, 'tg') === null));
  // 프로젝트 소제목은 `· ● 이름`이고, 회의 자체의 프로젝트도 이름 그대로 적는다.
  const projectHeads = nodeFindAll(section, 'd-mgrp').filter(head => String(head.className).includes('is-pj'));
  assert.deepEqual(projectHeads.map(head => head.children[0]), ['· ', '· ']);
  assert.deepEqual(projectHeads.map(head => nodeFind(head, 'd-pjdot').dataset.pj !== undefined), [true, true]);
  // 프로젝트로 나눈 줄에는 `· ● 이름`을 되풀이하지 않는다.
  assert.ok(rows.every(row => nodeFind(row, 'd-inproj') === null));
});

test('종류가 하나뿐이면 소제목을 세우지 않는다 — 구역 제목이 이미 개수를 말한다', () => {
  const app = meetingsViewClient();
  const section = meetingSection(app, "panelMeetingItems(workflowData.meetings[2], box)");
  assert.equal(section.children[0].textContent, '이 회의에서 나온 것 1');
  assert.deepEqual(meetingSectionShape(section), ['d-mrow2 | 정산 주기는 월 1회'], '줄의 종류 글자도 그대로 남는다');
  assert.equal(nodeFind(section, 'tg').textContent, '결정');
});

test('회의에 없는 프로젝트의 항목은 줄 제목 뒤 `· ● 이름`으로 남는다 — 프로젝트로 나누지 않은 자리에서만', () => {
  const app = meetingsViewClient();
  // 결정 하나를 다른 프로젝트로 옮긴다 — 종류가 셋이라 소제목은 서지만 결정 안의 프로젝트는 하나뿐이다.
  app.run("wfItem('d1').group = '알림센터'; wfIndexData();");
  const section = meetingSection(app, "panelMeetingItems(workflowData.meetings[0], box)");
  const decision = nodeFindAll(section, 'd-mrow2').find(row => nodeFind(row, 'ti').textContent === '재시도는 3회');
  assert.equal(decision.className, 'd-mrow2 no-tg has-pj');
  const tag = nodeFind(decision, 'd-inproj');
  assert.deepEqual([tag.children[0], tag.children[2]], ['· ', '알림센터'], '기존 `· ● 이름` 부품 그대로다');
});

test('`이전 회차의 미해결 항목`도 같은 종류 소제목을 쓰지만 프로젝트로 나누지는 않는다', () => {
  const app = meetingsViewClient();
  app.run(`workflowData.items.push(
    { id: 'c0', type: 'check', status: 'to-do', description: '지난 회차의 확인', meetingId: 'ops0', group: '알림센터' });
    wfIndexData();`);
  const section = meetingSection(app, "panelMeetingPast(workflowData.meetings[0], box)");
  assert.equal(section.children[0].textContent, '이전 회차의 미해결 항목 2');
  assert.deepEqual(meetingSectionShape(section), [
    '소제목 할 일 1',
    'd-mrow2 no-tg | 지난 회차에 남은 일',
    '소제목 확인 대기 1',
    'd-mrow2 no-tg has-pj | 지난 회차의 확인',
  ], '회차 표기가 이미 있으니 프로젝트 소제목은 세우지 않는다');
  // 줄 오른쪽에는 그대로 회차가 적힌다.
  assert.match(nodeFindAll(section, 'd-mrow2')[0].children[2].textContent, /회차$/);
});

test('팔레트 바닥은 `회의` 칩일 때만 회의 탭으로 가는 링크를 붙인다', () => {
  const app = workflowsClient();
  const foot = (state) => {
    app.run(`palState = palDefaults(${state});
      palNodes = { chips: document.createElement('div'), input: document.createElement('input'),
        results: document.createElement('div'), foot: document.createElement('div') };
      palFoot();`);
    return JSON.parse(app.run("JSON.stringify(palNodes.foot.children.map(kid => typeof kid === 'string' ? kid : kid.textContent))"));
  };
  assert.deepEqual(foot('{}'), ['↑↓ 이동 · Enter 열기 · Esc 닫기']);
  assert.deepEqual(foot("{ type: 'meeting' }"), ['↑↓ 이동 · Enter 열기 · Esc 닫기', '회의 탭에서 모두 보기']);
  assert.deepEqual(foot("{ newOnly: true }"), ['↑↓ 이동 · Enter 열기 · Esc 닫기'], '오늘 신규는 그대로 팔레트에 있다');
});

test('확인 대기의 날짜 배지는 짧다 — 지났거나 오늘일 때만 세우고, 뜻은 툴팁이 푼다', () => {
  const app = pureClient();
  const reply = code => JSON.parse(app.run(`JSON.stringify(uiReplyText(${code}))`));
  assert.equal(reply("'2000-01-01'").text.replace(/\d+/, 'N'), 'N일 늦음');
  assert.equal(reply("'2000-01-01'").tone, 'urgent');
  assert.deepEqual(reply('todayStr()'), { text: '오늘 답변 예정', tone: 'warn' });
  assert.equal(reply('tomorrowStr()'), null, '내일 받기로 한 날은 줄에 찍지 않는다');
  assert.equal(reply("'2999-12-31'"), null);
  assert.equal(reply('null'), null);
  // 배지 문구는 한 곳(UI_REPLY_WORDS)에서만 만든다 — 말이 또 바뀌어도 고칠 자리가 하나다.
  assert.equal(app.run("UI_REPLY_WORDS.late(3)"), '3일 늦음');
  assert.equal(app.run("UI_REPLY_WORDS.today()"), '오늘 답변 예정');

  // 확인 대기가 보이는 다른 자리(프로젝트 탭·팔레트 결과·회의에서 나온 줄)도 같은 말을 쓴다.
  const cell = (item, where = "'full'") => JSON.parse(app.run(`JSON.stringify(uiItemDueText(${item}, ${where}))`));
  assert.deepEqual(cell("{ type: 'check', due: todayStr() }"), { text: '오늘 답변 예정', tone: 'warn' });
  assert.deepEqual(cell("{ type: 'task', due: todayStr() }"), { text: '오늘까지', tone: 'warn' }, '할 일은 기한 말투 그대로');
  assert.match(cell("{ type: 'check', due: '2999-12-31' }").text, /12월 31일까지/, '먼 날짜는 날짜를 그대로 적어 정보를 잃지 않는다');
  assert.equal(cell('{ type: "check" }'), null);
});

test('the palette highlights the matched letters and escapes the person’s own text first', () => {
  const app = pureClient();
  const mark = (text, query) => app.run(`palHighlight(${JSON.stringify(text)}, ${JSON.stringify(query)})`);
  assert.equal(mark('가입 개선', '개선'), '가입 <mark class="d-mark">개선</mark>');
  assert.equal(mark('가입 개선', ''), '가입 개선', '검색어가 없으면 형광 표시도 없다');
  assert.equal(mark('AB-1 Login', 'login'), 'AB-1 <mark class="d-mark">Login</mark>', '대소문자는 가리지 않는다');
  const escaped = mark('<b>권한</b> 정리', '권한');
  assert.match(escaped, /&lt;b&gt;<mark class="d-mark">권한<\/mark>&lt;\/b&gt;/, '사람이 쓴 글자는 escape한 뒤에만 표시를 끼운다');
  assert.doesNotMatch(escaped, /<b>/);
  assert.equal(mark('권한', '<b>'), '권한', '검색어도 그대로 끼워 넣지 않는다');
});

test('meeting list chips put the drafts to review first and hide zero counts', () => {
  const app = workflowsClient();
  app.run(`workflowData = { meetings: [], items: [
    { id: 'a', type: 'task', status: 'to-do', meetingId: 'm1' }, { id: 'b', type: 'task', status: 'done', meetingId: 'm1' },
    { id: 'c', type: 'check', status: 'to-do', meetingId: 'm1' }, { id: 'd', type: 'decision', status: 'done', meetingId: 'm1' },
    { id: 'e', type: 'task', status: 'done', meetingId: 'm3' },
  ] }; wfIndexData();`);
  const chips = event => JSON.parse(app.run(`JSON.stringify(wfMeetingChips(${event}))`));
  assert.deepEqual(chips("{ id: 'm1', drafts: [{}, {}] }"), [['review', '초안 2 검토'], ['count', '할 일 1'], ['count', '확인 대기 1'], ['count', '결정 1']]);
  assert.deepEqual(chips("{ id: 'm1' }").map(chip => chip[0]), ['count', 'count', 'count'], 'no review chip without drafts');
  assert.deepEqual(chips("{ id: 'm2' }"), [['none', '기록 없음']]);
  assert.deepEqual(chips("{ id: 'm3' }"), [['none', '모두 처리함']], 'everything from this meeting is already done');
});

test('next review goes to the earliest meeting with drafts on the newest day, never the current one', () => {
  const app = workflowsClient();
  app.run(`workflowData = { items: [], meetings: [
    { id: 'late', date: '2026-09-21', start: '15:00', drafts: [{}] }, { id: 'early', date: '2026-09-21', start: '11:00', drafts: [{}, {}] },
    { id: 'old', date: '2026-09-20', start: '09:00', drafts: [{}] }, { id: 'none', date: '2026-09-21', start: '09:00', drafts: [] },
  ] }`);
  const next = current => app.run(`wfNextReview(${JSON.stringify(current)})?.id`);
  assert.equal(next('x'), 'early');
  assert.equal(next('early'), 'late');
  assert.equal(next('late'), 'early');
  app.run("workflowData.meetings = workflowData.meetings.filter(event => event.id === 'old')");
  assert.equal(next('old'), undefined, 'nothing left to review');
});

test('accepted draft payload: when only for tasks, a date for tasks and checks (null clears it), nothing extra for decisions', () => {
  const app = workflowsClient();
  const payload = (type, extra = '') => JSON.parse(app.run(`JSON.stringify(wfAcceptItem('n1:0', { type: '${type}', description: '  문구  ', ${extra} }))`));
  assert.deepEqual(payload('task', "when: 'today', due: '2026-09-30'"), { id: 'n1:0', type: 'task', description: '문구', when: 'today', due: '2026-09-30' });
  assert.deepEqual(payload('task'), { id: 'n1:0', type: 'task', description: '문구', when: 'later', due: null }, 'an emptied date is sent as null so the draft date is cleared');
  assert.deepEqual(payload('check', "when: 'today', due: '2026-10-02'"), { id: 'n1:0', type: 'check', description: '문구', due: '2026-10-02' }, 'checks never carry when');
  assert.deepEqual(payload('decision', "when: 'today', due: '2026-10-02'"), { id: 'n1:0', type: 'decision', description: '문구' }, 'decisions carry neither');
  assert.deepEqual(['task', 'check', 'decision'].map(type => app.run(`wfDateLabel('${type}')`)), ['기한', '답변 받을 날', null],
    '날짜 이름은 화면 어디서나 같다 — 할 일은 `기한`, 확인 대기만 `답변 받을 날`');
});

test('saves from the meeting review window stay quiet on success (its result card reports them) but failures are still announced', async () => {
  const notice = app => app.nodes.get('liveRegion')?.textContent ?? '';
  const ok = () => new Response('{"ok":true}', { status: 200 });
  const normal = client(ok());
  await normal.run("request('/api/today-task/create', { method: 'POST', body: '{}' })");
  assert.match(notice(normal), /저장했어요/);
  for (const route of ['review', 'review-undo', 'capture']) {
    const quiet = client(ok());
    await quiet.run(`request('/api/workflow/${route}', { method: 'POST', body: '{}' })`);
    assert.doesNotMatch(notice(quiet), /저장/, `${route} is quiet on success`);
  }
  const failing = client(new Response('{"ok":false,"error":"이미 처리했거나 찾을 수 없는 항목이에요."}', { status: 400 }));
  await assert.rejects(failing.run("request('/api/workflow/review', { method: 'POST', body: '{}' })"));
  assert.match(notice(failing), /저장됐는지 확인하지 못했어요|이미 처리/);
  const item = client(ok());
  await item.run("request('/api/workflow/item', { method: 'POST', body: '{}' })");
  assert.match(notice(item), /저장했어요/, 'other workflow saves (item details) keep their notice');
});

test('the trailing "(방향 확인 필요)" marker from the AI is removed from draft text, and only when it trails', () => {
  const app = workflowsClient();
  const clean = text => app.run(`wfCleanDraftText(${JSON.stringify(text)})`);
  assert.equal(clean('와이어프레임 전달하기 (방향 확인 필요)'), '와이어프레임 전달하기');
  assert.equal(clean('와이어프레임 전달하기'), '와이어프레임 전달하기');
  assert.equal(clean('(방향 확인 필요) 라는 표시를 설명하기'), '(방향 확인 필요) 라는 표시를 설명하기', 'a phrase in the middle is the person’s own words');
});

test('result card task rows: aligned with the created ids, and a promoted task counts as today', () => {
  const app = workflowsClient();
  app.run(`var sample = { created: ['t1', 'c1', 't2', 't3'], accepted: [
    { id: 'n:0', type: 'task', description: '가설 정리', when: 'later' }, { id: 'n:1', type: 'check', description: '회신 받기' },
    { id: 'n:2', type: 'task', description: '쿼리 요청', when: 'today' }, { id: 'n:3', type: 'task', description: '문구 초안', when: 'later' } ] }`);
  const rows = () => JSON.parse(app.run('JSON.stringify(wfResultTasks(sample))'));
  assert.deepEqual(rows(), [
    { itemId: 't1', description: '가설 정리', today: false },
    { itemId: 't2', description: '쿼리 요청', today: true },
    { itemId: 't3', description: '문구 초안', today: false },
  ]);
  app.run("sample.promoted = ['t3']");
  assert.deepEqual(rows().map(row => row.today), [false, true, true]);
});

// 회의 카드의 `이 회의에서 나온 것` 줄 — 앱의 다른 목록과 같은 ⋯ 메뉴를 쓰고, 그 자리에서 문구를 고친다.
function meetingRowClient(response) {
  const app = workflowsClient();
  const sent = [];
  app.context.fetch = async (url, init) => {
    sent.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
    if (typeof response === 'function') return response();
    return response.clone();
  };
  app.run('workflowData = { items: [], meetings: [] }; wfIndexData(); itemsById = new Map();');
  return { app, sent };
}

// 고치기를 연 회의 줄 한 벌: 원래 제목 버튼과 그 자리에 들어온 입력칸을 함께 돌려준다.
function meetingRowEditing(app) {
  return app.run(`(() => {
    const row = document.createElement('div');
    const title = document.createElement('button');
    title.className = 'ti';
    title.textContent = '원래 문구';
    row.append(title);
    panelMeetingRowEdit(row, title, { id: 'i1', description: '원래 문구' });
    return { row, title, input: row.children[0] };
  })()`);
}

// 회의 줄의 ⋯가 여는 메뉴 — 레일의 오늘 미팅 줄과 회의 정리 카드 머리가 함께 쓴다(회의용으로 새로 만들지 않는다).
test('meetingMenuSections lists 회의 정리 열기 then 프로젝트 연결, for both the rail row and the meeting card head', () => {
  const { app } = meetingRowClient(new Response('{"ok":true}'));
  const labels = (event, opts = '') => JSON.parse(app.run(`JSON.stringify(
    meetingMenuSections(${JSON.stringify(event)}${opts ? `, ${opts}` : ''}).map(section => section.map(entry => entry.label || entry.field)))`));
  assert.deepEqual(labels({ title: '주간 운영 회의', start: '10:00' }), [['회의 정리 열기'], ['프로젝트 연결']],
    '아직 기록되지 않은 회의는 탭에서 고를 수 없어 `회의 탭에서 열기`가 없다');
  assert.deepEqual(labels({ title: '가입 개선 킥오프', start: '09:00', project: { type: 'group', value: '가입 개선', label: '가입 개선' } }),
    [['회의 정리 열기'], ['프로젝트 연결']], '프로젝트가 이미 연결돼 있어도 메뉴 항목은 같다');
  // 기록된 회의에는 탭으로 가는 길이 하나 더 붙는다. 레일 줄은 번호를 `workflowId`로 들고 온다.
  assert.deepEqual(labels({ id: 'm1', title: '알림센터 인프라 협의', start: '16:00' }),
    [['회의 정리 열기', '회의 탭에서 열기'], ['프로젝트 연결']]);
  assert.deepEqual(labels({ workflowId: 'm1', title: '알림센터 인프라 협의', start: '16:00' }),
    [['회의 정리 열기', '회의 탭에서 열기'], ['프로젝트 연결']]);
  // 이미 그 자리에 있으면 그 자리로 가는 항목은 뺀다 — 회의 카드 머리, 회의 탭의 머리.
  assert.deepEqual(labels({ id: 'm1', title: '알림센터 인프라 협의' }, '{ open: false }'),
    [['회의 탭에서 열기'], ['프로젝트 연결']]);
  assert.deepEqual(labels({ id: 'm1', title: '알림센터 인프라 협의' }, '{ open: false, toTab: false }'),
    [['프로젝트 연결']]);
});

test('a meeting row reuses the list menus and only puts 문구 고치기 on top', () => {
  const { app } = meetingRowClient(new Response('{"ok":true}'));
  const menu = (type) => JSON.parse(app.run(`JSON.stringify(
    panelMeetingRowMenu({ id: 'i1', type: '${type}', description: '문구', status: 'to-do' }, document.createElement('div'), () => {})
      .map(section => section.map(entry => entry.label || entry.field)))`));
  for (const type of ['task', 'bug', 'check', 'decision']) {
    assert.equal(menu(type)[0][0], '문구 고치기', `${type} 줄의 메뉴 맨 위는 문구 고치기다`);
    assert.equal(menu(type)[0][1], '종류 바꾸기', `${type} 줄에서 종류를 바꾼다`);
    assert.ok(menu(type).flat().includes('삭제'), `${type} 줄도 여기서 지울 수 있다`);
  }
  // 맨 위 한 줄만 얹고 나머지는 목록에서 쓰는 메뉴 그대로다 — 회의 카드용 메뉴를 새로 만들지 않는다.
  const listMenu = (code) => JSON.parse(app.run(`JSON.stringify(${code}.map(section => section.map(entry => entry.label || entry.field)))`));
  assert.deepEqual(menu('task').slice(1),
    listMenu("taskMenuSections({ item: { id: 'i1', type: 'task', description: '문구', status: 'to-do' }, mode: panelMode({ id: 'i1' }), card: document.createElement('div') })"),
    '할 일은 업무 줄의 메뉴를 그대로 쓴다');
  assert.deepEqual(menu('check').slice(1),
    listMenu("waitingMenuSections({ id: 'i1', type: 'check', description: '문구', status: 'to-do' }, document.createElement('div'))"),
    '확인 대기는 확인 대기 줄의 메뉴를 그대로 쓴다(답변 받을 날 포함)');
  assert.ok(menu('check').flat().includes('답변 받을 날'));
  assert.deepEqual(menu('decision'), [['문구 고치기', '종류 바꾸기'], ['프로젝트'], ['삭제']], '결정에는 날짜가 없다');
  assert.ok(menu('task').flat().includes('기한'), '할 일의 날짜 이름은 `기한`이다');
});

test('a meeting row title is fixed in place: Enter saves, IME Enter waits, Esc cancels only the input', async () => {
  const { app, sent } = meetingRowClient(new Response('{"ok":true}'));
  const { row, title, input } = meetingRowEditing(app);
  assert.equal(input.value, '원래 문구');
  assert.equal(input.getAttribute('maxLength') ?? input.maxLength, 1000);
  assert.equal(input.focused, true);
  assert.equal(input.selected, true, '기존 문구는 전체 선택된 채로 들어온다');
  assert.equal(title.isConnected, false);

  // 한글을 조합하는 중의 Enter는 글자를 확정하는 것이다 — 저장으로 읽지 않는다.
  input.listeners.keydown({ key: 'Enter', isComposing: true, preventDefault() {} });
  assert.equal(input.blurs, 0);
  assert.equal(sent.length, 0);

  input.value = '고친 문구';
  input.listeners.keydown({ key: 'Enter', preventDefault() {} });
  assert.equal(input.blurs, 1, 'Enter는 저장으로 이어진다');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent.map(call => call.url), ['/api/track/set-description']);
  assert.deepEqual(sent[0].body, { id: 'i1', description: '고친 문구' });

  // Esc는 회의 카드가 아니라 이 입력칸만 되돌린다.
  const { row: row2, title: title2, input: input2 } = meetingRowEditing(app);
  assert.equal(app.run('escStack.length'), 1, '입력칸이 살아 있는 동안만 Esc를 가로챈다');
  app.run('escStack[escStack.length - 1]()');
  assert.equal(app.run('escStack.length'), 0, '되돌린 뒤에는 카드의 Esc가 다시 맨 위로 온다');
  assert.equal(row2.children[0], title2, '제목이 그대로 돌아온다');
  assert.equal(input2.isConnected, false);
  assert.equal(sent.length, 1, '취소는 아무것도 저장하지 않는다');
  assert.equal(row.children[0].isConnected, true);
});

test('an empty or unchanged meeting row title saves nothing, and a failed save keeps what was typed', async () => {
  const ok = meetingRowClient(new Response('{"ok":true}'));
  const blank = meetingRowEditing(ok.app);
  blank.input.value = '   ';
  await blank.input.listeners.blur();
  assert.equal(ok.sent.length, 0, '빈 값은 저장하지 않는다');
  assert.equal(blank.row.children[0], blank.title, '되돌아간다');

  const same = meetingRowEditing(ok.app);
  await same.input.listeners.blur();
  assert.equal(ok.sent.length, 0, '고치지 않았으면 저장하지 않는다');

  const failing = meetingRowClient(new Response('{"ok":false}', { status: 500 }));
  const { input } = meetingRowEditing(failing.app);
  input.value = '저장 실패 후에도 남아야 하는 문구';
  await input.listeners.blur();
  assert.equal(input.value, '저장 실패 후에도 남아야 하는 문구');
  assert.equal(input.disabled, false);
  assert.equal(input.focused, true);
  assert.equal(input.isConnected, true, '실패했으니 입력칸이 그대로 있다');
  assert.equal(failing.app.run('escStack.length'), 1, 'Esc로 취소할 길도 그대로 남는다');
});

// 회의 카드/탭 줄 맨 앞의 체크 칸 — 종류마다 목록이 쓰는 체크박스를 그대로 줄여 쓴다.
// task/bug/decision은 `.d-check` 안에 진짜 <input>이 한 겹 더 있다(children[0].children[0]).
function firstCheckbox(node) {
  let cur = node;
  const seen = new Set();
  while (cur && cur.type !== 'checkbox') {
    if (seen.has(cur)) return null;
    seen.add(cur);
    cur = cur.children && cur.children[0];
  }
  return cur || null;
}

test('회의 줄의 체크 칸: 종류마다 목록과 같은 체크박스가 붙고, 아이디어는 자리만 비운다', () => {
  const { app } = meetingRowClient(new Response('{"ok":true}'));
  const row = (item) => app.run(`panelMeetingRow(${JSON.stringify(item)}, { id: 'm1' }, null)`);

  const task = row({ id: 't1', type: 'task', description: '업무 문구', status: 'to-do', priority: 'medium' });
  const taskBox = firstCheckbox(task.children[0]);
  assert.equal(task.children[0].className, 'ck');
  assert.equal(taskBox.className, 'd-cb');
  assert.equal(taskBox.getAttribute('aria-label'), '업무 문구 — 완료로 표시', '업무 줄과 같은 이름표(우선순위 없음)다');
  assert.equal(taskBox.checked, false);

  const bug = row({ id: 'b1', type: 'bug', description: '버그 문구', status: 'done', priority: 'high' });
  const bugBox = firstCheckbox(bug.children[0]);
  assert.equal(bugBox.getAttribute('aria-label'), '버그 문구 — 완료로 표시', '완료한 줄에는 우선순위 꺾쇠가 없다');
  assert.equal(bugBox.checked, true);

  const check = row({ id: 'c1', type: 'check', description: '확인 문구', status: 'to-do' });
  const checkBox = firstCheckbox(check.children[0]);
  assert.equal(checkBox.className, 'd-wcb', '레일 확인 대기와 같은 체크(.d-wcb)다');
  assert.equal(checkBox.getAttribute('aria-label'), '확인 문구 — 확인 완료로 표시');

  const decision = row({ id: 'd1', type: 'decision', description: '결정 문구', status: 'done' });
  const decisionBox = firstCheckbox(decision.children[0]);
  assert.equal(decisionBox.className, 'd-cb');
  assert.equal(decisionBox.title, 'PRD 반영함으로 표시');
  assert.equal(decisionBox.getAttribute('aria-label'), '결정 문구 — PRD 반영함으로 표시');
  assert.equal(decisionBox.checked, true, '반영 완료한 결정은 체크된 채로 남는다');

  const idea = row({ id: 'i1', type: 'idea', description: '아이디어 문구', status: 'to-do' });
  assert.equal(idea.children[0].className, 'ck');
  assert.equal(idea.children[0].children.length, 0, '아이디어는 체크가 없다 — 자리만 비워 다른 줄과 제목 시작을 맞춘다');
});

test('회의 줄의 체크는 목록과 같은 toggle 길을 탄다(저장은 /api/track/toggle 하나)', async () => {
  const { app, sent } = meetingRowClient(new Response('{"ok":true}'));
  app.run(`workflowData = { items: [
    { id: 't1', type: 'task', description: '업무 문구', status: 'to-do' },
    { id: 'd1', type: 'decision', description: '결정 문구', status: 'to-do' },
  ], meetings: [] }; wfIndexData(); itemsById = new Map();`);

  const taskRow = app.run(`panelMeetingRow({ id: 't1', type: 'task', description: '업무 문구', status: 'to-do' }, { id: 'm1' }, null)`);
  await firstCheckbox(taskRow.children[0]).listeners.change();
  assert.deepEqual(sent.map(call => call.url), ['/api/track/toggle']);
  assert.deepEqual(sent[0].body, { id: 't1', status: 'done' }, '목록의 업무 완료 체크와 같은 요청이다');

  sent.length = 0;
  const decisionRow = app.run(`panelMeetingRow({ id: 'd1', type: 'decision', description: '결정 문구', status: 'to-do' }, { id: 'm1' }, null)`);
  await firstCheckbox(decisionRow.children[0]).listeners.change();
  assert.deepEqual(sent.map(call => call.url), ['/api/track/toggle']);
  assert.deepEqual(sent[0].body, { id: 'd1', status: 'done' }, '목록의 PRD 반영함 체크와 같은 요청이다');
});

test('회의 줄에서 문구를 고치는 동안은 체크박스를 잠그고, 되돌리면 다시 연다', () => {
  const { app } = meetingRowClient(new Response('{"ok":true}'));
  const row = app.run(`panelMeetingRow({ id: 'd1', type: 'decision', description: '결정 문구', status: 'to-do' }, { id: 'm1' }, null)`);
  const box = firstCheckbox(row.children[0]);
  const title = row.children[2];
  assert.equal(box.disabled, false);
  title.listeners.click(); // 결정은 상세가 없어 제목을 누르는 것이 곧 문구 고치기다
  assert.equal(box.disabled, true, '고치는 동안은 체크할 수 없다');
  app.run('escStack[escStack.length - 1]()'); // Esc는 입력만 되돌린다
  assert.equal(box.disabled, false, '되돌리면 다시 누를 수 있다');
});

// 체크하면 초점이 이 상자로 온다 — isTyping()이 그걸 "입력 중"으로 오인해 회의 카드·탭의 새로고침을
// 건너뛰면 줄이 is-done으로 바뀌지 않고 멈춘다. click에서 바로 초점을 내려 두어야 한다(change와는 다른
// 이벤트라 저장 리스너와 겹치지 않는다).
test('회의 줄의 체크박스는 누르면 바로 초점을 내려 회의 카드·탭 새로고침을 막지 않는다', () => {
  const { app } = meetingRowClient(new Response('{"ok":true}'));
  const row = app.run(`panelMeetingRow({ id: 'c1', type: 'check', description: '확인 문구', status: 'to-do' }, { id: 'm1' }, null)`);
  const box = firstCheckbox(row.children[0]);
  assert.equal(box.blurs, 0);
  box.listeners.click();
  assert.equal(box.blurs, 1, 'click에서 바로 blur한다');
});

// 프로젝트 탭의 확인 대기·결정 줄 — 목록이 쓰는 체크박스를 그대로 맨 앞에 단다. 아이디어·회의는 그대로 없다.
test('프로젝트 탭의 확인 대기·결정 줄에는 체크박스가 붙고, 아이디어·회의 줄은 그대로다', () => {
  const app = workflowsClient();
  app.run(`workflowData = { items: [
    { id: 'w1', type: 'check', description: '확인 문구', status: 'to-do', group: '가입 개선' },
    { id: 'd1', type: 'decision', description: '결정 문구', status: 'to-do', group: '가입 개선' },
    { id: 'd2', type: 'decision', description: '반영한 결정', status: 'done', completed: '2026-09-20', group: '가입 개선' },
    { id: 'i1', type: 'idea', description: '아이디어 문구', status: 'to-do', group: '가입 개선' },
  ], meetings: [] }; wfIndexData(); itemsById = new Map();`);
  const body = app.run(`(() => {
    const body = document.createElement('div');
    renderProjectDetail(body, { key: 'group:가입 개선', label: '가입 개선', open: 2 });
    return body;
  })()`);
  const section = (label) => body.children.find(c => c.className === 'd-psec'
    && c.children[0].children.some(k => k.textContent === label));
  const rowsOf = (label) => section(label).children[1].children;

  const waitingRow = rowsOf('확인 대기')[0];
  assert.equal(waitingRow.className, 'd-rec has-ck has-ac');
  const waitingBox = firstCheckbox(waitingRow.children[0]);
  assert.equal(waitingBox.className, 'd-wcb');
  assert.equal(waitingBox.getAttribute('aria-label'), '확인 문구 — 확인 완료로 표시');

  const decisionRows = rowsOf('결정');
  assert.equal(decisionRows[0].className, 'd-rec has-ck has-ac');
  const decisionBox = firstCheckbox(decisionRows[0].children[0]);
  assert.equal(decisionBox.className, 'd-cb');
  assert.equal(decisionBox.checked, false);
  const archivedBox = firstCheckbox(decisionRows[1].children[0]);
  assert.equal(archivedBox.checked, true, '이 구역은 반영 완료도 함께 보여 준다 — 체크된 채로 남는다');

  const ideaRow = rowsOf('아이디어')[0];
  assert.equal(ideaRow.className, 'd-rec has-ac', '아이디어 줄은 체크박스를 두지 않는다');

  const meetingSection = body.children.find(c => c.className === 'd-psec' && c.children[0]
    && c.children[0].children.some(k => k.textContent === '회의'));
  assert.equal(meetingSection, undefined, '회의가 없는 프로젝트라 회의 구역 자체가 없다');
});

test('projectSimpleRow: 체크박스를 넘기지 않으면 예전과 똑같다(has-ck 없음)', () => {
  const app = pureClient();
  const row = app.run(`projectSimpleRow('문구', '메타', () => {}, 'id1', null)`);
  assert.equal(row.className, 'd-rec');
  assert.equal(row.children.length, 2, '체크 칸 없이 제목·메타 둘뿐이다');
});

test('the quiet option keeps a successful save from announcing itself, while failures still do', async () => {
  const notice = app => app.nodes.get('liveRegion')?.textContent ?? '';
  const loud = client(new Response('{"ok":true}'));
  await loud.run("request('/api/track/set-scheduled', { method: 'POST', body: '{}' })");
  assert.match(notice(loud), /저장했어요/);
  const quiet = client(new Response('{"ok":true}'));
  await quiet.run("request('/api/track/set-scheduled', { method: 'POST', body: '{}', quiet: true })");
  assert.equal(notice(quiet), '');
  const failing = client(new Response('{"ok":false,"error":"x"}', { status: 400 }));
  await assert.rejects(failing.run("request('/api/track/set-scheduled', { method: 'POST', body: '{}', quiet: true })"));
  assert.notEqual(notice(failing), '');
});

test('프로젝트 목록: 열린 항목은 업무와 확인 대기만 세고, 많은 순 다음은 이름 순이다', () => {
  const app = workflowsClient();
  app.run(`workflowData = { meetings: [], items: [
    { id: 'a1', type: 'task', status: 'to-do', group: '가입 개선' },
    { id: 'a2', type: 'task', status: 'to-do', group: '가입 개선' },
    { id: 'a3', type: 'check', status: 'to-do', group: '가입 개선' },
    { id: 'a4', type: 'task', status: 'done', group: '가입 개선' },
    { id: 'a5', type: 'decision', status: 'to-do', group: '가입 개선' },
    { id: 'a6', type: 'idea', status: 'to-do', group: '가입 개선' },
    { id: 'b1', type: 'bug', status: 'to-do', jira: 'PAY-77' },
    { id: 'c1', type: 'decision', status: 'to-do', group: '정산' },
    { id: 'd1', type: 'check', status: 'done', group: '리서치' },
  ] }; wfIndexData();`);
  const rows = entries => JSON.parse(app.run(`JSON.stringify(uiProjectRows(${entries}, workflowData.items))`));
  const listed = rows(`[['group:가입 개선', '가입 개선'], ['jira:PAY-77', 'PAY-77 · 결제'], ['group:정산', '정산'], ['group:리서치', '리서치']]`);
  assert.deepEqual(listed.map(row => [row.label, row.open]), [
    ['가입 개선', 3],
    ['PAY-77 · 결제', 1],
    ['리서치', 0],
    ['정산', 0],
  ], '결정·아이디어·완료한 항목은 열린 항목에 들어가지 않고, 0건은 이름 순으로 맨 아래에 남는다');
  assert.deepEqual(rows('[]'), [], '프로젝트가 하나도 없으면 빈 목록');
});

// 아이디어·결정 탭의 결정 줄 — `PRD 반영함` 체크는 decisionCheckbox로 뽑아냈지만 마크업·동작은 그대로다.
test('아이디어·결정 탭의 결정 줄 체크는 뽑아내기 전과 같은 마크업·같은 toggle 호출이다', async () => {
  const item = { id: 'd1', description: '결정 문구' };
  const app = pureClient();
  app.context.fetch = async (url, init) => { app.sent.push({ url, body: init && init.body ? JSON.parse(init.body) : null }); return new Response('{"ok":true}'); };
  app.sent = [];
  app.run(`itemsById = new Map([['d1', ${JSON.stringify(item)}]]);`);

  const pending = app.run(`recordDecisionRow(${JSON.stringify(item)}, false)`);
  const box = pending.children[0].children[0];
  assert.equal(pending.children[0].className, 'd-check');
  assert.equal(box.className, 'd-cb');
  assert.equal(box.checked, false);
  assert.equal(box.title, 'PRD 반영함으로 표시');
  assert.equal(box.getAttribute('aria-label'), '결정 문구 — PRD 반영함으로 표시');

  const archived = app.run(`recordDecisionRow(${JSON.stringify(item)}, true)`);
  assert.equal(archived.children[0].children[0].checked, true);

  await box.listeners.change();
  assert.deepEqual(app.sent.map(call => call.url), ['/api/track/toggle']);
  assert.deepEqual(app.sent[0].body, { id: 'd1', status: 'done' });
});

test('일괄 선택: 완료한 줄은 후보에서 빠지고 전체 선택 여부는 후보 기준으로 센다', () => {
  const app = pureClient();
  const state = (items, selected) => JSON.parse(app.run(`JSON.stringify(taskSelectAllState(${items}, ${selected}))`));
  const items = `[{ id: 't1', status: 'to-do' }, { id: 't2', status: 'to-do' }, { id: 'done1', status: 'done' }]`;
  assert.deepEqual(state(items, `[]`), { candidates: ['t1', 't2'], count: 0, all: false });
  assert.deepEqual(state(items, `['t1']`), { candidates: ['t1', 't2'], count: 1, all: false });
  assert.deepEqual(state(items, `['t1', 't2']`), { candidates: ['t1', 't2'], count: 2, all: true });
  assert.deepEqual(state(items, `['t1', 't2', 'done1']`).count, 2, '완료한 줄은 골라도 세지 않는다');
  assert.equal(state(`[{ id: 'done1', status: 'done' }]`, `[]`).all, false, '고를 게 없으면 전체 선택 상태가 아니다');
});

test('아이디어의 `가능성`은 높음만 글자로 적는다', () => {
  const app = pureClient();
  const chance = code => app.run(`ideaChanceText(${code})`);
  assert.equal(chance("{ priority: 'high' }"), '가능성 높음');
  assert.equal(chance("{ priority: 'medium' }"), '', '보통은 목록에 찍지 않는다');
  assert.equal(chance("{ priority: 'low' }"), '', '낮음도 찍지 않는다');
  assert.equal(chance('{}'), '', '값이 없으면 자리를 비운다');
  assert.equal(chance('null'), '');
});

// 프로젝트 탭의 확인 대기·결정·아이디어 줄 — 할 수 있는 일이 더보기뿐이라 ⋯이 늘 보이고,
// 여는 메뉴는 다른 목록이 쓰는 메뉴 그대로다(프로젝트 탭용으로 새로 만들지 않는다).
test('프로젝트 탭의 확인 대기·결정·아이디어 줄은 목록에서 쓰는 메뉴를 그대로 연다', () => {
  const app = workflowsClient();
  app.run(`workflowData = { meetings: [], items: [] }; wfIndexData(); itemsById = new Map();
    var captured = null; uiMenu = (anchor, sections) => { captured = sections; };`);

  const openMenu = (type, item, menuFn) => {
    app.run(`
      var item = ${JSON.stringify(item)};
      var row = projectSimpleRow(item.description, '메타', () => {}, item.id, (row) => ${menuFn}(item, row));
      captured = null;
      row.children[row.children.length - 1].children[0].listeners.click({ stopPropagation() {} });
    `);
    return JSON.parse(app.run('JSON.stringify((captured || []).map(section => section.map(entry => entry.label || entry.field)))'));
  };
  const direct = (code) => JSON.parse(app.run(`JSON.stringify(${code}.map(section => section.map(entry => entry.label || entry.field)))`));

  const waitingItem = { id: 'w1', type: 'check', description: '문구', status: 'to-do' };
  const decisionItem = { id: 'd1', type: 'decision', description: '문구', status: 'to-do' };
  const ideaItem = { id: 'i1', type: 'idea', description: '문구', status: 'to-do' };

  assert.deepEqual(openMenu('check', waitingItem, 'waitingMenuSections'),
    direct(`waitingMenuSections(${JSON.stringify(waitingItem)}, document.createElement('div'))`),
    '확인 대기 줄은 확인 대기 줄의 메뉴를 그대로 쓴다');
  assert.deepEqual(openMenu('decision', decisionItem, 'decisionMenuSections'),
    direct(`decisionMenuSections(${JSON.stringify(decisionItem)}, document.createElement('div'))`),
    '결정 줄은 결정 줄의 메뉴를 그대로 쓴다');
  assert.deepEqual(openMenu('idea', ideaItem, 'ideaMenuSections'),
    direct(`ideaMenuSections(${JSON.stringify(ideaItem)}, document.createElement('div'))`),
    '아이디어 줄은 아이디어·결정 탭의 아이디어 메뉴를 그대로 쓴다');
  assert.deepEqual(openMenu('decision', decisionItem, 'decisionMenuSections'), [['프로젝트'], ['삭제']], '결정에는 날짜가 없다');
});

// 주간요약 문서: 상태 → 프로젝트 → 문장으로 묶이고, 제외한 문장과 다음 주 계획은 문서 끝에 따로 간다.
const REPORT_ROWS = `[
  { id: 'a1', heading: '완료한 일', group: '결제_리뉴얼', text: '정산 배치 설계를 끝냈습니다', sourceIds: ['s1'], excluded: false },
  { id: 'a2', heading: '완료한 일', group: '결제_리뉴얼', text: '실패 알림 문구를 고쳤습니다', sourceIds: ['s2'], excluded: false },
  { id: 'a3', heading: '완료한 일', group: '가입_개선', text: '퍼널 데이터를 정리했습니다', sourceIds: ['s3'], excluded: false },
  { id: 'a4', heading: '완료한 일', group: '알림센터', text: '숨긴 문장입니다', sourceIds: ['s4'], excluded: true },
  { id: 'b1', heading: '진행중', group: '운영툴', text: '권한 매트릭스를 다시 그리는 중', sourceIds: ['s5'], excluded: false },
  { id: 'p1', heading: '다음 주 계획', group: '직접 작성', text: '정산 배치 QA 붙기', sourceIds: [], excluded: false }
]`;

test('주간요약 문서는 상태 → 프로젝트 → 문장으로 묶고, 제외·다음 주 계획은 본문에서 빠진다', () => {
  const app = reportClient();
  const sections = JSON.parse(app.run(`JSON.stringify(reportDocSections(${REPORT_ROWS}).map(s => [s.heading, s.groups.map(g => [g.group, g.rows.map(r => r.id)])]))`));
  assert.deepEqual(sections, [
    ['완료한 일', [['결제_리뉴얼', ['a1', 'a2']], ['가입_개선', ['a3']]]],
    ['진행중', [['운영툴', ['b1']]]],
  ], '서버가 준 상태 순서를 그대로 두고, 같은 프로젝트의 문장은 소제목 하나 아래로 모은다');
  assert.deepEqual(JSON.parse(app.run(`JSON.stringify(reportPlanRows(${REPORT_ROWS}).map(r => r.id))`)), ['p1']);
  assert.deepEqual(JSON.parse(app.run(`JSON.stringify(reportExcludedRows(${REPORT_ROWS}).map(r => r.id))`)), ['a4']);
  assert.deepEqual(JSON.parse(app.run(`JSON.stringify(reportDocSections([]))`)), [], '기록이 없으면 구역도 없다');
  // 서버가 주는 값(`그룹 없음`)은 그대로 두고, 화면에 적는 말만 앱 용어로 옮긴다.
  assert.equal(app.run("reportProjectText('그룹 없음')"), '프로젝트 없음');
  assert.equal(app.run("reportProjectText('')"), '프로젝트 없음');
  assert.equal(app.run("reportProjectText('결제_리뉴얼')"), '결제_리뉴얼', '프로젝트 이름은 서버가 준 그대로 적는다');
  // BKEY: 저장된 이름이 `키 · 요약`이어도 화면에는 요약만(슬랙 복사와 같은 규칙).
  assert.equal(app.run("reportProjectText('PAY-77 · 정산 배치')"), '정산 배치', '지라 키는 화면에서도 뗀다');
  assert.equal(app.run("reportProjectText('PAY-77')"), 'PAY-77', '요약을 모르는 이슈는 키 그대로');
});

// BKEY: 문서 소제목·전체 업무 기록·다음 주 계획처럼 그룹 제목이 서는 자리에서만 쓰는 dedup 도구.
test('reportGroupTitles: 같은 요약의 지라 이름이 한 목록에 둘이면 원래 이름을 남기고, 저장 값은 건드리지 않는다', () => {
  const app = reportClient();
  const titles = code => JSON.parse(app.run(`JSON.stringify([...reportGroupTitles(${code})])`));
  assert.deepEqual(
    titles(`['PAY-77 · 정산 배치', 'PAY-78 · 정산 배치', '가입 개선']`),
    [
      ['PAY-77 · 정산 배치', 'PAY-77 · 정산 배치'],
      ['PAY-78 · 정산 배치', 'PAY-78 · 정산 배치'],
      ['가입 개선', '가입 개선'],
    ], '겹치는 요약만 원래 이름(키 · 요약)으로 남고, 그룹 이름은 원래대로');
  assert.deepEqual(
    titles(`['PAY-77 · 정산 배치', '가입 개선']`),
    [['PAY-77 · 정산 배치', '정산 배치'], ['가입 개선', '가입 개선']], '겹치지 않으면 요약만');
});

// BKEY: 고르는 목록은 `요약 · 키`(저장되는 값은 그대로).
test('reportPickerLabel: 고르는 목록의 글자만 "요약 · 키"로 바꾸고 그 밖은 그대로', () => {
  const app = reportClient();
  assert.equal(app.run("reportPickerLabel('PAY-77 · 정산 배치')"), '정산 배치 · PAY-77');
  assert.equal(app.run("reportPickerLabel('가입 개선')"), '가입 개선', '지라 꼴이 아니면 그대로');
  assert.equal(app.run("reportPickerLabel('PAY-77')"), 'PAY-77', '요약 없이 키만 있으면 그대로');
});

// 전체 업무 기록: 보고 문서와 같은 프로젝트 차례로 묶고, 프로젝트가 없는 기록만 맨 아래로 내린다.
const REPORT_RECORD_ROWS = `[
  { id: 'r1', excluded: false, evidence: [{ id: 's1', description: '가입 퍼널 데이터를 정리했습니다', label: '가입 개선', status: 'done' }] },
  { id: 'r2', excluded: true, evidence: [{ id: 's2', description: '주간 회의 자료 준비하기', label: '그룹 없음', status: 'done' }] },
  { id: 'r3', excluded: false,
    evidence: [{ id: 's3', description: '정산 배치 설계하기', label: '결제 리뉴얼', status: 'to-do' }],
    suggestion: { evidence: [{ id: 's4', description: '실패 알림 문구 고치기', label: '가입 개선', status: 'to-do' }] } },
  { id: 'r4', excluded: false, evidence: [{ id: 's5', description: '큐 지연 원인 회신 받기', label: '', status: 'to-do' }] }
]`;

test('전체 업무 기록은 프로젝트로 묶이고, 프로젝트 없는 기록은 `프로젝트 없음`으로 맨 아래에 선다', () => {
  const app = reportClient();
  const groups = JSON.parse(app.run(
    `JSON.stringify(reportRecordGroups(${REPORT_RECORD_ROWS}).map(g => [g.name, g.entries.map(e => e.source.id), g.entries.map(e => e.row.id)]))`));
  assert.deepEqual(groups, [
    ['가입 개선', ['s1', 's4'], ['r1', 'r3']],
    ['결제 리뉴얼', ['s3'], ['r3']],
    ['프로젝트 없음', ['s2', 's5'], ['r2', 'r4']],
  ], '보고 문서에 나온 차례를 그대로 쓰고, 서버의 `그룹 없음`과 빈 값은 한 묶음으로 맨 아래에 둔다');
  assert.deepEqual(JSON.parse(app.run('JSON.stringify(reportRecordGroups([]))')), [], '연결된 기록이 없으면 묶음도 없다');
});

// 전체 업무 기록 줄의 ⋯: 맨 위는 제외/복원, 그 아래는 업무 종류의 기존 메뉴 그대로다(새로 만들지 않는다).
function reportRecordMenuLabels(app, item, source, row) {
  return JSON.parse(app.run(`JSON.stringify(
    reportRecordMenuSections(${JSON.stringify(item)}, ${JSON.stringify(source)}, ${JSON.stringify(row)}, document.createElement('div'))
      .map(section => section.map(entry => entry.label || entry.field)))`));
}

test('전체 업무 기록 줄의 더보기는 제외/복원 다음에 그 업무 종류의 줄 메뉴를 그대로 쓴다', () => {
  const app = reportClient();
  // reportRecordMenuSections는 panelResolve(→wfItem)로 값을 다시 찾으므로 workflows.js도 함께 올린다.
  app.run(fs.readFileSync(path.join(__dirname, 'workflows.js'), 'utf8'));
  app.run(`workflowData = { meetings: [], items: [
    { id: 't1', type: 'task', status: 'to-do', description: '정산 배치 설계', priority: 'high', due: '2026-09-30' },
    { id: 'd1', type: 'decision', status: 'to-do', description: '정책 문구' },
  ] }; wfIndexData();
  itemsById = new Map([['t1', workflowData.items[0]], ['d1', workflowData.items[1]]]);
  taskListsCache = { todayTasks: [], laterTasks: [] };`);
  const item = { weekKey: '2026-W38', draft: { revision: 1 } };

  const taskSource = { id: 't1', description: '정산 배치 설계', type: 'task', status: 'to-do' };
  const open = reportRecordMenuLabels(app, item, taskSource, { id: 'r1', excluded: false });
  assert.equal(open[0][0], '보고에서 제외', '아직 제외하지 않은 줄의 맨 위는 `보고에서 제외`다');
  const excluded = reportRecordMenuLabels(app, item, taskSource, { id: 'r1', excluded: true });
  assert.equal(excluded[0][0], '보고에 복원', '이미 제외한 줄의 맨 위는 `보고에 복원`이다');

  const directTask = JSON.parse(app.run(`JSON.stringify(
    taskMenuSections({ item: itemsById.get('t1'), mode: panelMode(itemsById.get('t1')), card: document.createElement('div') })
      .map(section => section.map(entry => entry.label || entry.field)))`));
  assert.deepEqual(open.slice(1), directTask, '할 일은 업무 줄의 메뉴를 그대로 쓴다');

  const decisionSource = { id: 'd1', description: '정책 문구', type: 'decision', status: 'to-do' };
  const decisionMenu = reportRecordMenuLabels(app, item, decisionSource, { id: 'r2', excluded: false });
  assert.deepEqual(decisionMenu, [['보고에서 제외'], ['프로젝트'], ['삭제']], '결정에는 날짜가 없다');

  // 앱의 전체 목록에서 찾지 못하는 항목(이미 사라진 기록 등)은 제외/복원만 남긴다.
  const missing = reportRecordMenuLabels(app, item, { id: 'gone', description: '없는 항목', type: 'task', status: 'to-do' }, { id: 'r3', excluded: false });
  assert.deepEqual(missing, [['보고에서 제외']]);
});

// 문장 줄의 ⋯: `이 아래로 문장 모으기`는 최상위·제외되지 않은 문장에만, `따로 빼기`는 들어간 문장에만,
// `묶음 풀기`는 서버가 묶기 전 문장을 들고 있다고 알려 준 옛 합치기 행(`canSplit`)에만 붙는다.
const REPORT_ITEM = `{ weekKey: '2026-09-14', draft: { revision: 1 } }`;
test('주간요약 문장의 더보기는 모으기·따로 빼기·묶음 풀기를 상황에 맞게만 보여 준다', () => {
  const app = reportClient();
  const labels = row => JSON.parse(app.run(`JSON.stringify(
    reportSentenceMenuSections(${REPORT_ITEM}, ${JSON.stringify(row)}).map(section => section.map(entry => entry.label)))`));
  assert.deepEqual(labels({ id: 'r1', group: '가입 개선', sourceIds: ['s1'] }), [['근거 업무 보기', '이 아래로 문장 모으기']]);
  assert.deepEqual(labels({ id: 'r2', group: '가입 개선', sourceIds: [] }), [['이 아래로 문장 모으기']], '근거가 없으면 근거 항목도 없다');
  assert.deepEqual(labels({ id: 'r5', group: '가입 개선', sourceIds: [], parent: 'r1' }), [['따로 빼기']],
    '이미 다른 문장 아래에 있는 문장은 더 모을 수 없고 빼기만 한다(한 단계까지만)');
  assert.deepEqual(labels({ id: 'r6', group: '가입 개선', sourceIds: [], excluded: true }), [],
    '제외한 문장 아래로는 모으지 않는다 — 보여 줄 것이 없으면 빈 묶음도 만들지 않는다');
  assert.deepEqual(labels({ id: 'r3', group: '여러 프로젝트', sourceIds: ['s1', 's2'], canSplit: true, partCount: 2 }),
    [['근거 업무 보기', '이 아래로 문장 모으기', '묶음 풀기']]);
  // 옛 저장 데이터로 만든 묶음 문장에는 `parts`가 없어 `canSplit`도 오지 않는다 — 풀기만 보이지 않는다.
  assert.deepEqual(labels({ id: 'r4', group: '여러 프로젝트', sourceIds: ['s1', 's2'] }), [['근거 업무 보기', '이 아래로 문장 모으기']]);
});

// `프로젝트 바꾸기`는 다음 주 계획 문장에만 붙는다(다른 구역의 프로젝트는 원본 업무가 정한다).
test('계획 문장의 ⋯에만 프로젝트 바꾸기 고르개가 붙는다', () => {
  const app = reportClient();
  const fields = row => JSON.parse(app.run(`JSON.stringify(
    reportSentenceMenuSections(${REPORT_ITEM}, ${JSON.stringify(row)})
      .map(section => section.map(entry => entry.field || entry.label)))`));
  assert.deepEqual(fields({ id: 'p1', heading: '다음 주 계획', group: '결제 리뉴얼', sourceIds: [] }),
    [['이 아래로 문장 모으기'], ['프로젝트 바꾸기']]);
  assert.deepEqual(fields({ id: 'a1', heading: '완료한 일', group: '결제 리뉴얼', sourceIds: [] }),
    [['이 아래로 문장 모으기']], '자동 문장에는 프로젝트 바꾸기가 없다');
  // 고르개는 서버의 `regroup` 하나만 부른다(빈 값이면 프로젝트 없음).
  const sent = JSON.parse(app.run(`(() => {
    const calls = [];
    reportChange = async (item, action) => { calls.push(action); };
    uiMenuClose = () => {};
    const pick = reportPlanRegroupPicker(${REPORT_ITEM}, { id: 'p1', heading: '다음 주 계획', group: '결제 리뉴얼' });
    pick.value = '가입 개선'; pick.listeners.change();
    pick.value = ''; pick.listeners.change();
    return JSON.stringify(calls);
  })()`));
  assert.deepEqual(sent, [
    { action: 'regroup', id: 'p1', group: '가입 개선' },
    { action: 'regroup', id: 'p1' },
  ]);
});

// BKEY: 프로젝트를 고르는 <select>는 옵션 글자만 `요약 · 키`(요약 기준 정렬)이고, 저장되는 값(option.value)은
// 그대로 원래 이름(`키 · 요약`)이라 예전에 저장된 문장과 같은 프로젝트로 묶인다.
test('다음 주 계획 프로젝트 고르개(select)는 옵션 글자만 "요약 · 키"이고 값은 그대로다', () => {
  const app = reportClient();
  app.run("customGroupsCache = ['운영툴']; jiraIssuesCache = [{ key: 'PAY-77', summary: '정산 배치' }]");
  const optionsOf = code => JSON.parse(app.run(
    `JSON.stringify(${code}.children.map(option => [option.value, option.textContent]))`));
  assert.deepEqual(optionsOf('reportPlanProjectPicker()'), [
    ['', '프로젝트 없음'],
    ['운영툴', '운영툴'],
    ['PAY-77 · 정산 배치', '정산 배치 · PAY-77'],
  ], '값은 원래 이름 그대로, 글자만 요약 · 키로 바뀌고 요약 기준으로 정렬된다(운영툴 → 정산 배치)');
  assert.deepEqual(optionsOf(
    `reportPlanRegroupPicker(${REPORT_ITEM}, { id: 'p1', heading: '다음 주 계획', group: 'PAY-77 · 정산 배치' })`), [
    ['', '프로젝트 없음'],
    ['운영툴', '운영툴'],
    ['PAY-77 · 정산 배치', '정산 배치 · PAY-77'],
  ]);
});

// ---------- 다음 주 후보 (BW) ----------
// 후보는 화면이 이미 들고 있는 업무 목록에서 만든다(새 API 없음). 담았는지는 계획 행의 `planOf`로만
// 판정하고 글자를 비교하지 않는다 — 문장을 고쳐도 `담음`이 풀리지 않게.
const REPORT_CANDIDATE_SETUP = `
  taskListsCache = {
    todayTasks: [
      { id: 't1', description: '가입 문구 검토하기', status: 'to-do', group: '가입 개선', due: '2999-09-27' },
      { id: 't2', description: '정산 배치 설계하기', status: 'to-do', group: '결제 리뉴얼' },
      { id: 't3', description: '이미 끝낸 일', status: 'done', group: '가입 개선' },
      { id: 't4', description: '프로젝트 없는 일', status: 'to-do' },
    ],
    laterTasks: [{ id: 'l1', description: '나중에 볼 일', status: 'to-do', group: '알림센터' }],
  };
  jiraIssuesCache = []; jiraIssuesByKey = new Map();
  const walk = node => (node.children || []).flatMap(kid =>
    kid && kid.children ? [[String(kid.className || ''), String(kid.textContent || '')], ...walk(kid)] : []);
`;
function reportCandidateClient(rows = []) {
  const app = reportClient();
  const drawn = JSON.parse(app.run(`(() => {
    ${REPORT_CANDIDATE_SETUP}
    const item = { weekKey: 'W', draft: { rows: ${JSON.stringify(rows)} } };
    const host = document.createElement('div');
    reportPlanCandidateSection(item, host);
    return JSON.stringify(walk(host));
  })()`));
  return { app, drawn };
}
test('다음 주 후보는 오늘 할 일의 미완료 업무만 프로젝트별로 세운다', () => {
  const { drawn } = reportCandidateClient();
  assert.deepEqual(drawn.filter(([cls]) => cls === 'pjn').map(([, text]) => text),
    ['가입 개선', '결제 리뉴얼', '프로젝트 없음'], '프로젝트별로 묶고 프로젝트 없는 것은 맨 뒤다');
  assert.deepEqual(drawn.filter(([cls]) => cls === 'n num').map(([, text]) => text), ['1', '1', '1'],
    '프로젝트 제목에는 그 묶음의 후보 수가 붙는다(오늘 목록의 그룹 제목과 같은 말투)');
  assert.deepEqual(drawn.filter(([cls]) => cls === 'ti').map(([, text]) => text),
    ['가입 문구 검토하기', '정산 배치 설계하기', '프로젝트 없는 일'], '완료한 업무와 나중에 할 일은 후보가 아니다');
  assert.deepEqual(drawn.filter(([cls]) => cls === 'mt').map(([, text]) => text), ['9월 27일까지', '', ''],
    '기한이 있으면 조용히 적는다');
  assert.deepEqual(drawn.filter(([cls]) => cls.startsWith('d-btn')).map(([, text]) => text),
    ['나중에 할 일에서 고르기', '+ 담기', '+ 담기', '+ 담기'], '구역 머리에 나중에 할 일 고르기가 하나 있다');
  assert.equal(drawn.filter(([cls]) => cls === 'rp-cand is-in').length, 0);
});
test('이미 담은 후보는 `담음`으로 잠기고, 판정은 글자가 아니라 planOf로 한다', () => {
  const { drawn } = reportCandidateClient([
    // 글은 전혀 다르게 고쳐 뒀고, 제목이 같은 다른 문장은 연결이 없다.
    { id: 'p1', heading: '다음 주 계획', group: '가입 개선', text: '문구 확정까지 끝내기', planOf: 't1', sourceIds: [] },
    { id: 'p2', heading: '다음 주 계획', group: '결제 리뉴얼', text: '정산 배치 설계하기', sourceIds: [] },
  ]);
  const rows = drawn.filter(([cls]) => cls === 'rp-cand' || cls === 'rp-cand is-in');
  assert.deepEqual(rows.map(([cls]) => cls), ['rp-cand is-in', 'rp-cand', 'rp-cand'],
    '연결된 후보만 잠기고, 글자만 같은 문장은 잠그지 않는다');
  assert.deepEqual(drawn.filter(([cls]) => cls === 'in').map(([, text]) => text), ['담음']);
  assert.equal(drawn.filter(([, text]) => text === '+ 담기').length, 2, '담은 후보에는 담기 버튼이 없다');
});
test('`+ 담기`는 업무를 바꾸지 않고 add + planOf 하나만 보낸다', () => {
  const app = reportClient();
  const sent = JSON.parse(app.run(`(() => {
    ${REPORT_CANDIDATE_SETUP}
    const calls = [];
    reportChange = async (item, action, notice) => { calls.push([action, notice]); };
    const item = { weekKey: 'W', draft: { rows: [] } };
    const host = document.createElement('div');
    reportPlanCandidateSection(item, host);
    const buttons = walk(host);
    const find = text => {
      const stack = [host];
      while (stack.length) {
        const node = stack.shift();
        if (String(node.className || '').startsWith('d-btn') && node.textContent === text) return node;
        (node.children || []).forEach(kid => { if (kid && kid.children) stack.push(kid); });
      }
      return null;
    };
    find('+ 담기').listeners.click();
    return JSON.stringify(calls);
  })()`));
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0][0], { action: 'add', text: '가입 문구 검토하기', group: '가입 개선', planOf: 't1' });
  assert.equal(sent[0][1], '다음 주 계획에 넣었어요');
});
test('후보는 슬랙 복사에 절대 나가지 않는다', () => {
  const app = reportClient();
  const text = app.run(`(() => {
    ${REPORT_CANDIDATE_SETUP}
    const report = { rows: [
      { id: 'p1', heading: '다음 주 계획', group: '결제 리뉴얼', text: '정산 배치 QA 붙기', planOf: 't2', sourceIds: [], excluded: false },
    ] };
    return reportSlackText(reportSlackModel(report, { sections: ['완료', '진행 중', '예정'] }));
  })()`);
  assert.match(text, /정산 배치 QA 붙기/);
  for (const description of ['가입 문구 검토하기', '정산 배치 설계하기', '프로젝트 없는 일', '나중에 볼 일']) {
    assert.doesNotMatch(text, new RegExp(description), `후보 문구(${description})는 복사 글자에 없다`);
  }
  assert.doesNotMatch(text, /t1|t2|planOf/, '연결 값도 나가지 않는다');
});
test('여러 줄 붙여넣기는 줄마다 한 문장이고, 접두는 기존 프로젝트 이름과 정확히 같을 때만 쓴다', () => {
  const app = reportClient();
  const lines = JSON.parse(app.run(`JSON.stringify(reportPlanLines(
    '첫 줄\\n\\n  둘째 줄  \\r\\n셋째 줄'))`));
  assert.deepEqual(lines, ['첫 줄', '둘째 줄', '셋째 줄'], '빈 줄은 무시하고 앞뒤 공백은 뗀다');
  assert.equal(JSON.parse(app.run(`JSON.stringify(reportPlanLines(Array.from({ length: 30 }, (_, i) => 'L' + i).join('\\n')))`)).length,
    20, '한 번에 20줄까지만 담는다');
  const split = (line, fallback = '기본') => JSON.parse(app.run(
    `JSON.stringify(reportPlanSplitPrefix(${JSON.stringify(line)}, ['결제 리뉴얼', '가입 개선'], ${JSON.stringify(fallback)}))`));
  assert.deepEqual(split('결제 리뉴얼: 정산 배치 QA 붙기'), { text: '정산 배치 QA 붙기', group: '결제 리뉴얼' });
  assert.deepEqual(split('결제: 정산 배치 QA 붙기'), { text: '결제: 정산 배치 QA 붙기', group: '기본' },
    '이름이 정확히 같지 않으면 접두로 보지 않는다');
  assert.deepEqual(split('오늘 할 일: 정리'), { text: '오늘 할 일: 정리', group: '기본' });
  assert.deepEqual(split('결제 리뉴얼:'), { text: '결제 리뉴얼:', group: '기본' }, '접두만 있고 글이 없으면 그대로 둔다');
  assert.deepEqual(split(': 앞이 비었어요'), { text: ': 앞이 비었어요', group: '기본' });
});

test('지난 주차에는 후보도 `나중에 할 일에도 추가` 토글도 없고 기존 입력줄만 남는다', () => {
  const app = reportClient();
  const shape = weekKey => JSON.parse(app.run(`(() => {
    ${REPORT_CANDIDATE_SETUP}
    customGroupsCache = ['가입 개선'];
    const item = { weekKey: ${JSON.stringify(weekKey)}, draft: { rows: [
      { id: 'p1', heading: '다음 주 계획', group: '가입 개선', text: '문구 확정까지 끝내기', sourceIds: [], excluded: false },
    ] } };
    const host = document.createElement('div');
    reportPlanSection(item, host, new Set());
    return JSON.stringify(walk(host).map(([cls, text]) => [cls, text]));
  })()`));
  const week = app.run(`(() => {
    const monday = new Date(todayStr() + 'T12:00:00');
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    return monday.getFullYear() + '-' + String(monday.getMonth() + 1).padStart(2, '0') + '-' + String(monday.getDate()).padStart(2, '0');
  })()`);
  const now = shape(week);
  assert.ok(now.some(([cls]) => cls === 'rp-candhd'), '이번 주에는 후보 구역이 있다');
  assert.ok(now.some(([cls]) => cls.includes('rp-also')), '이번 주에는 토글이 있다');
  assert.ok(now.some(([cls]) => cls === 'rp-pjadd'), '이번 주에는 프로젝트 소제목마다 `+ 추가`가 있다');
  const past = shape('2020-01-06');
  assert.equal(past.filter(([cls]) => cls === 'rp-candhd').length, 0);
  assert.equal(past.filter(([cls]) => cls.includes('rp-also')).length, 0);
  assert.equal(past.filter(([cls]) => cls === 'rp-pjadd').length, 0);
  assert.equal(past.filter(([cls]) => cls === 'rp-add').length, 1, '기존 입력줄 하나는 그대로 남는다');
});

// 업무는 만들어졌는데 문장 추가가 실패하면, 다시 시도는 문장만 추가한다(업무를 두 번 만들지 않는다).
test('직접 쓰기: 업무 만들기 → 문장 추가 순서이고, 문장만 실패하면 다시 시도가 업무를 또 만들지 않는다', async () => {
  const app = reportClient();
  await app.run(`(async () => {
    calls = [];
    load = async () => { calls.push(['load']); };
    renderReportDraft = () => {};
    request = async (url, options) => {
      calls.push(['create', url, JSON.parse(options.body)]);
      return { json: async () => ({ ok: true, id: 'new-1' }) };
    };
    failNext = true;
    reportChange = async (item, action, notice) => {
      calls.push(['change', action, notice]);
      if (failNext) { failNext = false; throw new Error('저장하지 못했어요'); }
    };
    item = { weekKey: 'W', draft: { rows: [] } };
    await reportPlanAddLines(item, ['정산 배치 QA 붙기'], { key: 'new', group: '결제 리뉴얼', alsoTask: true, focusId: 'reportPlanInput' });
    await reportPlanAddLines(item, ['정산 배치 QA 붙기'], { key: 'new', group: '결제 리뉴얼', alsoTask: true, focusId: 'reportPlanInput' });
  })()`);
  const calls = JSON.parse(app.run('JSON.stringify(calls)'));
  const creates = calls.filter(call => call[0] === 'create');
  assert.equal(creates.length, 1, '업무는 한 번만 만든다');
  assert.deepEqual(creates[0][1], '/api/later-task/create');
  assert.deepEqual(creates[0][2], { description: '정산 배치 QA 붙기', group: '결제 리뉴얼' },
    '기한·우선순위는 넣지 않는다(마감일을 추측하지 않는다)');
  const changes = calls.filter(call => call[0] === 'change');
  assert.equal(changes.length, 2, '다시 시도는 문장 추가만 한다');
  assert.deepEqual(changes[1][1], { action: 'add', text: '정산 배치 QA 붙기', group: '결제 리뉴얼', planOf: 'new-1' });
  assert.equal(changes[1][2], '다음 주 계획에 넣었어요 · 나중에 할 일에도 추가했어요');
  // 실패한 뒤에는 남은 줄이 입력칸에 되돌아와 있다.
  assert.equal(app.run("String(reportEdits.get('W:new'))"), 'undefined', '성공한 뒤에는 적던 글이 비워진다');
});

test('토글이 꺼져 있으면 업무를 만들지 않고 문장만 담는다', async () => {
  const app = reportClient();
  await app.run(`(async () => {
    calls = [];
    load = async () => { calls.push(['load']); };
    renderReportDraft = () => {};
    request = async (url) => { calls.push(['create', url]); return { json: async () => ({ ok: true, id: 'x' }) }; };
    reportChange = async (item, action, notice) => { calls.push(['change', action, notice]); };
    await reportPlanAddLines({ weekKey: 'W', draft: { rows: [] } }, ['직접 쓴 계획'],
      { key: 'new', group: '', alsoTask: false, focusId: 'reportPlanInput' });
  })()`);
  const calls = JSON.parse(app.run('JSON.stringify(calls)'));
  assert.equal(calls.filter(call => call[0] === 'create').length, 0);
  assert.equal(calls.filter(call => call[0] === 'load').length, 0, '업무를 만들지 않았으면 목록을 다시 받지도 않는다');
  assert.deepEqual(calls.filter(call => call[0] === 'change')[0][1], { action: 'add', text: '직접 쓴 계획' });
  assert.equal(calls.filter(call => call[0] === 'change')[0][2], '다음 주 계획에 넣었어요');
});

test('여러 줄 담기가 중간에 실패하면 거기서 멈추고 남은 줄이 입력칸에 돌아온다', async () => {
  const app = reportClient();
  await app.run(`(async () => {
    calls = [];
    load = async () => {};
    renderReportDraft = () => {};
    reportChange = async (item, action) => {
      calls.push(action.text);
      if (action.text === '둘째 줄') throw new Error('저장하지 못했어요');
    };
    await reportPlanAddLines({ weekKey: 'W', draft: { rows: [] } }, ['첫 줄', '둘째 줄', '셋째 줄'],
      { key: 'new', group: '가입 개선', alsoTask: false, focusId: 'reportPlanInput' });
  })()`);
  assert.deepEqual(JSON.parse(app.run('JSON.stringify(calls)')), ['첫 줄', '둘째 줄']);
  assert.equal(app.run("reportEdits.get('W:new')"), '둘째 줄\n셋째 줄', '실패한 줄부터 남은 줄이 그대로 돌아온다');
});

// 아래로 넣기·따로 빼기는 저장 경로 하나(`/api/report/change`)로 가고, 보내는 값은 id와 parentId뿐이다.
test('모으기 메뉴와 `따로 빼기`는 nest·unnest를 그대로 부른다', () => {
  const app = reportClient();
  app.run(`
    calls = [];
    reportChange = async (item, action) => { calls.push(action); };
    renderReportDraft = () => {};
    item = { weekKey: '2026-09-14', draft: { revision: 1, rows: [
      { id: 'a', heading: '완료한 일', group: '가입 개선', text: '퍼널 정리', sourceIds: [], excluded: false },
      { id: 'b', heading: '완료한 일', group: '결제 리뉴얼', text: '정산 배치', sourceIds: [], excluded: false, parent: 'a' },
    ] } };
    pick = (row, label) => reportSentenceMenuSections(item, row).flat().find(entry => entry.label === label).onClick();
  `);
  app.run("pick(item.draft.rows[0], '이 아래로 문장 모으기')");
  assert.equal(app.run('reportNestParentId'), 'a', '모으기 모드의 기준 문장이 된다');
  assert.deepEqual(JSON.parse(app.run('JSON.stringify(calls)')), [], '모드에 들어가는 것만으로는 저장하지 않는다');
  app.run("pick(item.draft.rows[1], '따로 빼기')");
  assert.deepEqual(JSON.parse(app.run('JSON.stringify(calls)')), [{ action: 'unnest', id: 'b' }]);
  // 모으기 모드에서 문장을 누르면 그 자리에서 nest 한 번. 모드는 그대로 남는다(여러 개를 연달아 넣는다).
  app.run(`
    host = document.createElement('div');
    reportSentenceRow(item, item.draft.rows[1], { host });
    picked = host.children[0];
  `);
  assert.equal(app.run('picked.getAttribute("role")'), undefined, '이미 들어간 문장은 과녁이 아니다');
  app.run(`
    item.draft.rows[1].parent = undefined;
    host = document.createElement('div');
    reportSentenceRow(item, item.draft.rows[1], { host });
    host.children[0].listeners.click();
  `);
  assert.deepEqual(JSON.parse(app.run('JSON.stringify(calls[1])')), { action: 'nest', id: 'b', parentId: 'a' });
  assert.equal(app.run('reportNestParentId'), 'a', '넣은 뒤에도 모으기 모드가 이어진다');
});

test('자리를 옮긴 변경(넣기·빼기·묶기·풀기)의 알림은 무엇이 바뀌었는지 적고 되돌리기 버튼을 함께 준다', () => {
  const notice = (action, token = "'tok'") => {
    const app = reportClient();
    app.run(`reportUndo.set('2026-09-14', ${token})`);
    app.run(`reportSavedNotice(${REPORT_ITEM}, ${action})`);
    const region = app.nodes.get('liveRegion');
    return [region.textContent, region.children.map(kid => kid.textContent)];
  };
  assert.deepEqual(notice(`{ action: 'nest', id: 'r2', parentId: 'r1' }`), ['문장을 아래로 넣었어요', ['되돌리기', '닫기']]);
  assert.deepEqual(notice(`{ action: 'unnest', id: 'r2' }`), ['따로 뺐어요', ['되돌리기', '닫기']]);
  assert.deepEqual(notice(`{ action: 'merge', ids: ['a', 'b', 'c'] }`), ['문장 3개를 묶었어요', ['되돌리기', '닫기']]);
  assert.deepEqual(notice(`{ action: 'split', id: 'r3' }`), ['묶음을 풀었어요', ['되돌리기', '닫기']]);
  assert.deepEqual(notice(`{ action: 'undo', token: 'tok' }`), ['되돌렸어요', ['닫기']]);
  // 나머지 변경의 알림은 예전 그대로다.
  assert.deepEqual(notice(`{ action: 'edit', id: 'r1', text: '고친 문장' }`), ['보고 내용을 저장했어요', ['닫기']]);
  assert.deepEqual(notice(`{ action: 'exclude', id: 'r1' }`), ['보고 내용을 저장했어요', ['닫기']]);
  // 되돌릴 토큰을 못 받았으면 버튼 없이 알림만 뜬다.
  assert.deepEqual(notice(`{ action: 'merge', ids: ['a', 'b'] }`, 'undefined'), ['문장 2개를 묶었어요', ['닫기']]);
});

test('주간요약의 ⌘Z는 그 탭에서 되돌릴 것이 있을 때만 가로채고, 아니면 기존 되돌리기로 흘려보낸다', () => {
  const app = reportClient();
  app.run(`
    activeTabKey = 'weekly';
    reportRenderedItem = ${REPORT_ITEM};
    reportUndo.set('2026-09-14', 'tok');
    reportChange = async () => { globalThis.undone = (globalThis.undone || 0) + 1; };
    makeEvent = (extra = {}) => ({ metaKey: true, key: 'z', target: { closest: () => null }, prevented: 0, stopped: 0,
      preventDefault() { this.prevented += 1; }, stopImmediatePropagation() { this.stopped += 1; }, ...extra });
    taken = extra => !!reportUndoHotkeyItem(makeEvent(extra));
  `);
  assert.equal(app.run('taken()'), true);
  assert.equal(app.run("taken({ ctrlKey: true, metaKey: false })"), true, 'Ctrl+Z도 같다');
  assert.equal(app.run('taken({ shiftKey: true })'), false, '⌘⇧Z(다시 실행)는 다루지 않는다');
  assert.equal(app.run('taken({ altKey: true })'), false);
  assert.equal(app.run('taken({ metaKey: false })'), false);
  assert.equal(app.run("taken({ key: 'y' })"), false);
  assert.equal(app.run('taken({ target: { closest: () => ({}) } })'), false, '입력칸 안에서는 글자 되돌리기로 남는다');
  app.run("activeTabKey = 'today'");
  assert.equal(app.run('taken()'), false, '다른 탭의 ⌘Z는 오늘 목록의 되돌리기 그대로다');
  app.run("activeTabKey = 'weekly'; reportUndo.clear()");
  assert.equal(app.run('taken()'), false, '그 주차의 되돌리기 토큰이 없으면 가로채지 않는다');

  // 가로챌 때만 기본 동작과 app.js의 ⌘Z를 막는다.
  app.run("reportUndo.set('2026-09-14', 'tok'); hit = makeEvent(); took = reportUndoHotkey(hit);");
  assert.equal(app.run('took'), true);
  assert.deepEqual([app.run('hit.prevented'), app.run('hit.stopped'), app.run('undone')], [1, 1, 1]);
  app.run("miss = makeEvent({ target: { closest: () => ({}) } }); missTook = reportUndoHotkey(miss);");
  assert.equal(app.run('missTook'), false);
  assert.deepEqual([app.run('miss.prevented'), app.run('miss.stopped'), app.run('undone')], [0, 0, 1]);
});

// 슬랙 복사: 구역(상태) → 프로젝트 → 글머리 항목. 이 글자가 바뀌면 사용자의 슬랙 글 모양이 바뀐다.
const REPORT_SLACK_ROWS = `[
  { id: 'a1', heading: '완료한 일', group: '가입 개선', text: '가입 실패율 급증 원인 파악', sourceIds: [], excluded: false },
  { id: 'a2', heading: '완료한 일', group: '가입 개선', text: '퍼널 데이터 정리해 대시보드 반영\\n이슈: 집계 지연', sourceIds: [], excluded: false },
  { id: 'a3', heading: '완료한 일', group: '결제 리뉴얼', text: '결제 실패 알림 슬랙 채널 공지', sourceIds: [], excluded: false },
  { id: 'a4', heading: '완료한 일', group: '그룹 없음', text: '주간 회의 자료 준비', sourceIds: [], excluded: false },
  { id: 'a5', heading: '완료한 일', group: '알림센터', text: '숨긴 문장입니다', sourceIds: [], excluded: true },
  { id: 'c1', heading: '확인 완료', group: '가입 개선', text: '약관 문구 법무 회신 받음', sourceIds: [], excluded: false },
  { id: 'b1', heading: '진행중', group: '알림센터', text: '발송 실패 로그 확인', sourceIds: [], excluded: false },
  { id: 'd1', heading: '새로 정해진 것', group: '운영툴', text: '접근 로그는 90일 보존', sourceIds: [], excluded: false },
  { id: 'w1', heading: '확인 대기', group: '운영툴', text: '큐 지연 원인 회신 대기', sourceIds: [], excluded: false },
  { id: 'p1', heading: '다음 주 계획', group: '알림센터', text: '웹/앱 검수 처리 기획 진행 및 논의', sourceIds: [], excluded: false },
  { id: 'p2', heading: '다음 주 계획', group: '직접 작성', text: '과금 기획은 차차주 진행 예정', sourceIds: [], excluded: false }
]`;
const REPORT_SLACK_REPORT = `{ weekKey: '2026-09-21', rows: ${REPORT_SLACK_ROWS} }`;

test('슬랙 복사 글자는 구역 → 프로젝트 → 글머리 형식으로 고정된다', () => {
  const app = reportClient();
  const text = app.run(`reportSlackText(reportSlackModel(${REPORT_SLACK_REPORT}))`);
  assert.equal(text, [
    '9월 3주차 (9/21~9/27)',
    '',
    '[완료]',
    '',
    '가입 개선',
    '• 가입 실패율 급증 원인 파악',
    '• 퍼널 데이터 정리해 대시보드 반영',
    '    ◦ 이슈: 집계 지연',
    '• 약관 문구 법무 회신 받음',
    '',
    '결제 리뉴얼',
    '• 결제 실패 알림 슬랙 채널 공지',
    '',
    '기타',
    '• 주간 회의 자료 준비',
    '',
    '[진행중]',
    '',
    '알림센터',
    '• 발송 실패 로그 확인',
    '',
    '[예정]',
    '',
    '알림센터',
    '• 웹/앱 검수 처리 기획 진행 및 논의',
    '',
    '* 과금 기획은 차차주 진행 예정',
  ].join('\n'), '제목 → 구역 → 프로젝트 → 글머리, 구역 이름 뒤와 프로젝트 묶음 사이에 빈 줄 하나, 부연은 공백 4칸 + ◦, 프로젝트 없는 것은 기타로 구역 끝');
  assert.doesNotMatch(text, /숨긴 문장/, '제외한 문장은 복사에서 빠진다');
  assert.doesNotMatch(text, /이번 주|확인 완료/, '슬랙 글에는 상대 표현을 쓰지 않고, 확인 완료는 완료 안으로 들어간다');
  assert.doesNotMatch(text, /\n\n\n/, '빈 줄이 잇따라 두 개가 되지는 않는다(구역 끝 묶음 뒤에는 넣지 않는다)');
  assert.equal(text.endsWith('\n'), false, '글 끝에도 빈 줄을 남기지 않는다');
  assert.equal(app.run(`reportSlackText(reportSlackModel({ weekKey: '2026-09-21', rows: [] }))`), '',
    '담긴 문장이 없으면 제목만 남기지 않고 아무것도 복사하지 않는다');
});

test('넣을 구역을 고르면 미리보기·일반 글자·서식 있는 복사가 함께 바뀐다', () => {
  const app = reportClient();
  const model = sections => `reportSlackModel(${REPORT_SLACK_REPORT}, { sections: ${JSON.stringify(sections)} })`;
  const names = list => JSON.parse(app.run(`JSON.stringify(${model(list)}.sections.map(s => s.name))`));
  assert.deepEqual(names(['완료', '진행 중', '예정']), ['완료', '진행 중', '예정'], '기본값은 완료 · 진행 중 · 예정이다');
  assert.deepEqual(names(['결정', '확인 대기', '완료']), ['완료', '결정', '확인 대기'], '고른 차례와 상관없이 구역 차례는 하나로 정해져 있다');
  assert.deepEqual(names([]), [], '아무 구역도 고르지 않으면 복사할 것이 없다');
  assert.equal(app.run(`reportSlackText(${model(['결정'])})`), ['9월 3주차 (9/21~9/27)', '', '[결정]', '', '운영툴', '• 접근 로그는 90일 보존'].join('\n'));
  assert.deepEqual(names(['완료', '진행 중', '결정', '확인 대기', '예정']).length, 5, '내용이 있는 구역만 세어도 다섯 구역이 모두 찬 자료다');
  assert.deepEqual(JSON.parse(app.run(`JSON.stringify(reportSlackModel({ weekKey: '2026-09-21', rows: ${REPORT_SLACK_ROWS} }, { sections: ['확인 대기'] }).sections)`)),
    [{ name: '확인 대기', projects: [{ name: '운영툴', items: [{ text: '큐 지연 원인 회신 대기', notes: [] }] }], memos: [] }]);
});

test('미리보기 줄·일반 글자·서식 있는 복사는 한 구조에서 나온다', () => {
  const app = reportClient();
  const model = `reportSlackModel(${REPORT_SLACK_REPORT})`;
  const lines = JSON.parse(app.run(`JSON.stringify(reportSlackLines(${model}))`));
  assert.equal(lines.map(line => line.text).join('\n'), app.run(`reportSlackText(${model})`),
    '미리보기에 그려지는 글자를 이어 붙이면 복사 글자와 정확히 같다(대체 경로에서 직접 선택해도 같은 글자다)');
  assert.deepEqual(lines.slice(0, 5).map(line => line.kind), ['title', 'gap', 'section', 'gap', 'project'],
    '구역 이름 뒤에도 빈 줄이 하나 선다');
  assert.ok(lines.some(line => line.kind === 'note' && line.text === '    ◦ 이슈: 집계 지연'));
  assert.ok(lines.some(line => line.kind === 'memo' && line.text === '* 과금 기획은 차차주 진행 예정'));

  const html = app.run(`reportSlackHtml(${model})`);
  assert.match(html, /^<p><b>9월 3주차 \(9\/21~9\/27\)<\/b><\/p><p><br><\/p><p><b>\[완료\]<\/b><\/p><p><br><\/p><p><b>가입 개선<\/b><\/p><ul><li>가입 실패율 급증 원인 파악<\/li>/,
    '서식 있는 복사도 같은 자리에 빈 단락을 넣어 일반 글자와 간격이 같다');
  assert.match(html, /<li>퍼널 데이터 정리해 대시보드 반영<ul><li>이슈: 집계 지연<\/li><\/ul><\/li>/, '부연은 한 단계 들여 쓴 목록이 된다');
  assert.match(html, /<\/ul><p><br><\/p><p><b>결제 리뉴얼<\/b><\/p>/, '프로젝트 묶음 사이에도 빈 단락 하나');
  assert.match(html, /<p><br><\/p><p>\* 과금 기획은 차차주 진행 예정<\/p>/, '프로젝트 없는 계획 문장은 빈 단락 뒤 메모 줄로 남는다');
  assert.equal((html.match(/<p><br><\/p>/g) || []).length, lines.filter(line => line.kind === 'gap').length,
    '빈 줄 수가 일반 글자와 정확히 같다(같은 구조 함수에서 나온다)');
  assert.doesNotMatch(html, /<p><br><\/p><p><br><\/p>/, '빈 단락이 잇따르지 않는다');
  assert.equal(app.run(`reportSlackHtml({ sections: [] })`), '');

  // 사용자 문구는 그대로 HTML에 들어가면 안 된다.
  const risky = `{ weekKey: '2026-09-21', rows: [{ id: 'x', heading: '완료한 일', group: '가입 <개선>', text: '<b>굵게</b> & 기호', sourceIds: [], excluded: false }] }`;
  const escaped = app.run(`reportSlackHtml(reportSlackModel(${risky}))`);
  assert.match(escaped, /<p><b>가입 &lt;개선&gt;<\/b><\/p>/);
  assert.match(escaped, /<li>&lt;b&gt;굵게&lt;\/b&gt; &amp; 기호<\/li>/);
  assert.equal(app.run(`reportSlackText(reportSlackModel(${risky}))`).includes('<b>굵게</b> & 기호'), true, '일반 글자에는 사용자가 쓴 그대로 들어간다');
});

// 다른 문장 아래로 넣은 문장: 문서에서는 부모의 프로젝트 아래 들여 쓴 줄, 슬랙에서는 부모 항목의 `◦` 부연.
const REPORT_NEST_ROWS = `[
  { id: 'a1', heading: '완료한 일', group: '가입 개선', text: '가입 실패율 급증 원인 파악', sourceIds: [], excluded: false },
  { id: 'a2', heading: '완료한 일', group: '결제 리뉴얼', text: '결제 로그 확인\\n로그 보존 기간도 정리', sourceIds: [], excluded: false, parent: 'a1' },
  { id: 'a3', heading: '완료한 일', group: '가입 개선', text: '빠진 문장', sourceIds: [], excluded: true, parent: 'a1' },
  { id: 'a4', heading: '완료한 일', group: '그룹 없음', text: '주간 회의 자료 준비', sourceIds: [], excluded: false },
  { id: 'a5', heading: '완료한 일', group: '여러 프로젝트', text: '옛 합치기 문장', sourceIds: [], excluded: false }
]`;

test('아래로 넣은 문장은 부모의 프로젝트 아래에 서고, 슬랙에서는 부모 항목의 `◦` 부연이 된다', () => {
  const app = reportClient();
  const report = `{ weekKey: '2026-09-21', rows: ${REPORT_NEST_ROWS} }`;
  // 문서: 부모의 프로젝트 소제목 아래, 부모 바로 뒤. `여러 프로젝트`는 구역 끝(`프로젝트 없음` 앞).
  assert.deepEqual(JSON.parse(app.run(`JSON.stringify(reportDocSections(${REPORT_NEST_ROWS})
    .map(s => [s.heading, s.groups.map(g => [g.group, g.rows.map(r => r.id)])]))`)), [
    ['완료한 일', [['가입 개선', ['a1', 'a2']], ['여러 프로젝트', ['a5']], ['그룹 없음', ['a4']]]],
  ], '자식은 자기 프로젝트(결제 리뉴얼)가 아니라 부모의 프로젝트 아래에 서고, 제외한 자식은 빠진다');
  // 슬랙: 부모 항목 아래 `◦` 줄. 자식이 여러 줄이면 줄마다 한 `◦`.
  assert.equal(app.run(`reportSlackText(reportSlackModel(${report}, { sections: ['완료'] }))`), [
    '9월 3주차 (9/21~9/27)',
    '',
    '[완료]',
    '',
    '가입 개선',
    '• 가입 실패율 급증 원인 파악',
    '    ◦ 결제 로그 확인',
    '    ◦ 로그 보존 기간도 정리',
    '',
    '여러 프로젝트',
    '• 옛 합치기 문장',
    '',
    '기타',
    '• 주간 회의 자료 준비',
  ].join('\n'), '자식 문장은 부모 아래 부연으로만 나가고, 다른 프로젝트 이름은 슬랙 글에 적지 않는다');
  // 부모를 제외하면 서버가 자식의 `parent`를 지워 주므로 자식은 최상위 항목으로 나간다.
  const orphaned = `{ weekKey: '2026-09-21', rows: [
    { id: 'a1', heading: '완료한 일', group: '가입 개선', text: '부모 문장', sourceIds: [], excluded: true },
    { id: 'a2', heading: '완료한 일', group: '결제 리뉴얼', text: '혼자 남은 문장', sourceIds: [], excluded: false }
  ] }`;
  assert.equal(app.run(`reportSlackText(reportSlackModel(${orphaned}, { sections: ['완료'] }))`), [
    '9월 3주차 (9/21~9/27)', '', '[완료]', '', '결제 리뉴얼', '• 혼자 남은 문장',
  ].join('\n'));
  assert.deepEqual(JSON.parse(app.run(`JSON.stringify(reportChildRows([]).size)`)), 0);
});

test('다음 주 계획은 프로젝트로 묶이고, 프로젝트 없는 문장은 구역 끝에 선다', () => {
  const app = reportClient();
  const rows = `[
    { id: 'p1', heading: '다음 주 계획', group: '직접 작성', text: '먼저 적은 메모', sourceIds: [], excluded: false },
    { id: 'p2', heading: '다음 주 계획', group: '알림센터', text: '검수 처리 기획', sourceIds: [], excluded: false },
    { id: 'p3', heading: '다음 주 계획', group: '알림센터', text: '발송 정책 정리', sourceIds: [], excluded: false },
    { id: 'p4', heading: '다음 주 계획', group: '', text: '프로젝트 없이 적은 문장', sourceIds: [], excluded: false }
  ]`;
  assert.deepEqual(JSON.parse(app.run(`JSON.stringify(reportPlanGroups(${rows}).map(g => [g.name, g.rows.map(r => r.id)]))`)),
    [['알림센터', ['p2', 'p3']], [null, ['p1', 'p4']]], '문서에서도 프로젝트 소제목 아래로 묶고, 프로젝트 없는 문장은 끝으로 내린다');
  assert.deepEqual(JSON.parse(app.run(`JSON.stringify(reportPlanGroups([]))`)), [], '계획 문장이 없으면 묶음도 없다');
  assert.equal(app.run(`reportSlackText(reportSlackModel({ weekKey: '2026-09-21', rows: ${rows} }, { sections: ['예정'] }))`), [
    '9월 3주차 (9/21~9/27)',
    '',
    '[예정]',
    '',
    '알림센터',
    '• 검수 처리 기획',
    '• 발송 정책 정리',
    '',
    '* 먼저 적은 메모',
    '* 프로젝트 없이 적은 문장',
  ].join('\n'), '슬랙에서도 프로젝트 없는 계획 문장만 구역 끝 메모 줄이 되고, 메모 줄들은 빈 줄 하나 뒤에 한 묶음으로 선다');
});

// `결정 찾기`와 반영 완료 검색이 함께 쓰는 매칭 규칙 — 문구·프로젝트·지라 키·지라 요약을 본다.
test('결정 찾기(recordArchiveMatch)는 문구·프로젝트·지라 키·지라 요약을 함께 본다', () => {
  const app = pureClient();
  const match = (item, query, summary = "''") => app.run(`recordArchiveMatch(${item}, ${JSON.stringify(query)}, ${summary})`);
  const item = "{ description: '접근로그 90일 보존', group: '운영툴', jira: 'PAY-77' }";
  assert.equal(match(item, ''), true, '검색어가 없으면 전부 남는다');
  assert.equal(match(item, '   '), true, '공백만 적은 것도 검색어가 아니다');
  assert.equal(match(item, '보존'), true);
  assert.equal(match(item, '운영툴'), true, '프로젝트 이름으로도 찾는다');
  assert.equal(match(item, 'pay-77'), true, '지라 키는 대소문자를 가리지 않는다');
  assert.equal(match(item, '결제', "'결제 기간 정리'"), true, '지라 요약으로도 찾는다');
  assert.equal(match(item, '없는말'), false);
  assert.equal(match("{ description: '메모', project: '리서치' }", '리서치'), true, '아이디어의 프로젝트 칸도 본다');
});

// `결정 찾기`는 미반영 결정 목록과 반영 완료 목록을 같은 기준(recordArchiveMatch)으로 함께 거른다 —
// 검색 입력 하나로 두 목록에 각각 적용하는 방식이라, 같은 매처가 두 모양의 항목에 똑같이 동작하는지 본다.
test('결정 찾기는 미반영 결정과 반영 완료를 같은 기준으로 함께 거른다', () => {
  const app = pureClient();
  const filter = (list, query) => list.filter(item => app.run(`recordArchiveMatch(${JSON.stringify(item)}, ${JSON.stringify(query)}, '')`));
  const pending = [
    { id: 'p1', description: '접근 로그 90일 보존', group: '운영툴' },
    { id: 'p2', description: '결제 실패 알림 정책', group: '결제' },
  ];
  const archived = [
    { id: 'a1', description: '접근 로그 30일 보존(구)', group: '운영툴', completed: '2026-09-10' },
    { id: 'a2', description: '가입 절차 정리', group: '가입', completed: '2026-09-12' },
  ];
  assert.deepEqual(filter(pending, '보존').map(i => i.id), ['p1'], '미반영 결정에서 찾는다');
  assert.deepEqual(filter(archived, '보존').map(i => i.id), ['a1'], '반영 완료에서도 같은 기준으로 찾는다');
  assert.deepEqual(filter(pending, '없는말'), []);
  assert.deepEqual(filter(archived, '없는말'), []);
  assert.deepEqual(filter(pending, ''), pending, '검색어가 없으면 미반영 결정도 전부 남는다');
  assert.deepEqual(filter(archived, ''), archived, '검색어가 없으면 반영 완료도 전부 남는다');
});

// 결정 아래 정보 줄: 날짜(created)·나온 회의(meetingId → 회의 제목)·원문 가운데 있는 것만, 이 순서로.
test('결정 정보 줄은 날짜·나온 회의·원문 가운데 있는 값만 순서대로 조립한다', () => {
  const app = workflowsClient();
  app.run(`workflowData = { meetings: [
    { id: 'm1', date: '2026-09-18', start: '10:00', title: '결제 리뉴얼 PRD 리뷰' },
  ], items: [
    { id: 'd1', meetingId: 'm1' },
  ] }; wfIndexData();`);
  const parts = item => JSON.parse(app.run(`JSON.stringify(recordInfoParts(${JSON.stringify(item)}))`));

  assert.deepEqual(parts({ id: 'd1', created: '2026-09-18' }),
    [{ kind: 'date', text: '9월 18일 결정' }, { kind: 'meeting', text: '결제 리뉴얼 PRD 리뷰에서', meetingId: 'm1' }],
    '날짜와 나온 회의가 있으면 이 순서로 나온다(원문은 없으니 빠진다)');
  assert.deepEqual(parts({ id: 'd2', created: '2026-09-18', permalink: 'https://slack.example/x' }),
    [{ kind: 'date', text: '9월 18일 결정' }, { kind: 'source', text: '원문' }],
    '회의에 연결되지 않은 결정은 회의 부분이 빠진다');
  assert.deepEqual(parts({ id: 'd3' }), [], '아무 값도 없으면 정보 줄도 없다');
  assert.deepEqual(parts({ id: 'd4', permalink: 'https://slack.example/y' }), [{ kind: 'source', text: '원문' }],
    '원문만 있으면 원문만 남는다');
});

// 좁은 창(≤900) 세그먼트가 기억하는 값 — idea·decision이 아니면 기본값(결정)으로 돌아간다.
test('아이디어·결정 탭의 좁은 창 세그먼트는 idea·decision만 기억하고, 그 밖의 값은 기본(결정)으로 돌아간다', () => {
  const app = pureClient();
  const from = value => app.run(`recordViewFrom(${JSON.stringify(value)})`);
  assert.equal(from('idea'), 'idea');
  assert.equal(from('decision'), 'decision');
  assert.equal(from(null), 'decision', '저장된 값이 없으면 기본은 결정');
  assert.equal(from(undefined), 'decision');
  assert.equal(from('other'), 'decision', '알 수 없는 값도 기본(결정)으로');
  assert.equal(from(''), 'decision');
});

// 줄 옆 카드의 자리 계산. 화면 좌표만 보는 순수 함수라 여기서 그대로 확인한다
// (헤더 60px 아래 12px, 화면 아래 12px을 지키며 누른 줄 옆에 선다).
test('줄 옆 카드는 줄 오른쪽 끝 안쪽에 서고, 화면 밖으로 나가면 필요한 만큼만 끌어올린다', () => {
  const app = pureClient();
  const place = (row, card, view, side) =>
    JSON.parse(app.run(`JSON.stringify(detailPopPosition(${JSON.stringify(row)}, ${JSON.stringify(card)}, ${JSON.stringify(view)}, ${JSON.stringify(side)}))`));
  const view = { width: 1440, height: 900 };
  const card = { width: 360, height: 420 };

  const top = place({ top: 200, left: 300, right: 1100 }, card, view, 'body');
  assert.deepEqual([top.left, top.top], [728, 200], '본문 줄은 줄 오른쪽 끝에서 12px 안쪽, 세로는 줄 윗변에 맞춘다');

  const bottom = place({ top: 840, left: 300, right: 1100 }, card, view, 'body');
  assert.equal(bottom.top, 900 - 12 - 420, '아래쪽 줄에서는 카드가 다 보일 만큼만 위로 올라간다');

  const tall = place({ top: 500, left: 300, right: 1100 }, { width: 360, height: 5000 }, view, 'body');
  assert.equal(tall.top, 72, '카드가 화면보다 길면 헤더 아래 12px에 붙고, 나머지는 카드 안에서 스크롤한다');
  assert.equal(tall.maxHeight, 900 - 60 - 24, '카드 높이는 헤더와 위아래 여백을 뺀 만큼까지다');

  const rail = place({ top: 300, left: 8, right: 240 }, card, view, 'rail');
  assert.equal(rail.left, 252, '레일 줄은 줄 오른쪽 옆으로 나온다');

  const drawer = place({ top: 300, left: 1040, right: 1432 }, card, view, 'drawer');
  assert.equal(drawer.left, 668, '서랍 줄은 서랍 왼쪽 옆으로 나온다');

  const narrow = place({ top: 300, left: 8, right: 300 }, card, { width: 600, height: 900 }, 'rail');
  assert.equal(narrow.left, 600 - 360 - 8, '좁은 화면에서도 카드는 화면 안에 갇힌다');

  const orphan = place(null, card, view, 'center');
  assert.deepEqual([orphan.left, orphan.top], [540, 72], '붙을 줄이 없으면 화면 가운데 위(팔레트 자리)에 선다');
});

// 슬랙 복사: 모르는 소제목의 문장도 조용히 빠지지 않는다 — 그 이름 그대로의 구역이 된다.
test('모르는 소제목은 그 이름 그대로의 구역이 되고, 차례는 아는 구역들 뒤 · `예정` 앞이다', () => {
  const app = reportClient();
  const rows = `[
    { id: 'a1', heading: '완료한 일', group: '가입 개선', text: '퍼널 정리', sourceIds: [], excluded: false },
    { id: 'x1', heading: '리스크', group: '운영툴', text: '큐 지연이 계속되고 있어요', sourceIds: [], excluded: false },
    { id: 'x2', heading: '리스크', group: '그룹 없음', text: '인력 공백', sourceIds: [], excluded: false },
    { id: 'p1', heading: '다음 주 계획', group: '알림센터', text: '검수 기획', sourceIds: [], excluded: false }
  ]`;
  const report = `{ weekKey: '2026-09-21', rows: ${rows} }`;
  assert.equal(app.run(`reportSlackSectionOf('리스크')`), '리스크', '모르는 소제목은 이름 그대로 쓴다');
  assert.equal(app.run(`reportSlackSectionOf('완료한 일')`), '완료', '아는 소제목은 그대로 슬랙 구역 이름으로 옮긴다');
  assert.equal(app.run(`reportSlackSectionOf('  ')`), null, '이름이 없으면 구역도 없다');
  assert.deepEqual(JSON.parse(app.run(`JSON.stringify(reportSlackSectionNames(${report}))`)),
    ['완료', '진행 중', '결정', '확인 대기', '리스크', '예정'], '모르는 구역은 아는 구역들 뒤, `예정` 앞에 선다');
  assert.equal(app.run(`reportSlackText(reportSlackModel(${report}, { sections: reportSlackSectionNames(${report}) }))`), [
    '9월 3주차 (9/21~9/27)',
    '',
    '[완료]',
    '',
    '가입 개선',
    '• 퍼널 정리',
    '',
    '[리스크]',
    '',
    '운영툴',
    '• 큐 지연이 계속되고 있어요',
    '',
    '기타',
    '• 인력 공백',
    '',
    '[예정]',
    '',
    '알림센터',
    '• 검수 기획',
  ].join('\n'), '모르는 소제목의 문장도 같은 모양으로 들어간다');
});

// 다음 주 계획의 프로젝트 선택 — 앱의 다른 프로젝트 선택과 같은 목록(그룹 + 지라 `KEY · 요약`).
test('다음 주 계획 프로젝트 목록은 그룹과 지라를 함께 담고, 60자를 넘는 지라는 키만 쓴다', () => {
  const app = reportClient();
  app.run("customGroupsCache = ['운영툴', '가입 개선']");
  app.run(`jiraIssuesCache = [{ key: 'PAY-77', summary: '정산 배치' }, { key: 'OPS-1', summary: '${'가'.repeat(70)}' }]`);
  assert.deepEqual(JSON.parse(app.run('JSON.stringify(reportPlanProjectNames())')),
    ['운영툴', '가입 개선', 'PAY-77 · 정산 배치', 'OPS-1'],
    '저장되는 값은 화면에 보이는 이름 그대로이고, 60자를 넘는 지라는 키만 남는다');
  assert.equal(app.run(`reportPlanJiraName('PAY-77', '${'나'.repeat(60)}')`), 'PAY-77');
});

test('슬랙으로 나가는 프로젝트 줄에는 지라 키를 싣지 않는다(요약을 모르면 키 그대로)', () => {
  const app = reportClient();
  assert.equal(app.run(`reportSlackProjectLabel('PAY-77 · 결제 정산 주기 정책 변경')`), '결제 정산 주기 정책 변경');
  assert.equal(app.run(`reportSlackProjectLabel('IO-48394')`), 'IO-48394', '요약을 모르는 이슈는 키밖에 이름이 없다');
  assert.equal(app.run(`reportSlackProjectLabel('가입 개선')`), '가입 개선', '그룹 이름은 그대로');
  assert.equal(app.run(`reportSlackProjectLabel('A · B')`), 'A · B', '지라 키 꼴이 아니면 가운뎃점이 있어도 건드리지 않는다');
  const report = JSON.stringify({ weekKey: '2026-09-21', rows: [
    { id: 'r1', heading: '완료한 일', group: 'PAY-77 · 결제 정산 주기 정책 변경', text: '정산 주기 확정', sourceIds: [], evidence: [], excluded: false },
  ] });
  const text = app.run(`reportSlackText(reportSlackModel(${report}, { sections: ['완료'] }))`);
  assert.equal(text.includes('PAY-77'), false, '일반 글자에 키가 없다');
  assert.equal(text.includes('결제 정산 주기 정책 변경'), true);
  const html = app.run(`reportSlackHtml(reportSlackModel(${report}, { sections: ['완료'] }))`);
  assert.equal(html.includes('PAY-77'), false, '서식 있는 복사에도 키가 없다');
  assert.equal(app.run(`reportProjectColorKey('PAY-77 · 결제 정산 주기 정책 변경')`), 'PAY-77', '색 점은 원래 키로 정한다');
});

// ---------- BDEPLOY: 주간요약 슬랙 글의 지라 정보(토글, 기본 끔) ----------
// 값은 이미 받아 둔 목록에서만 읽는다 — 주간요약을 열었다고 지라를 새로 부르지 않는다.
const REPORT_JIRA_SETUP = `
  jiraIssuesByKey = new Map([
    ['PAY-77', { key: 'PAY-77', summary: '결제 정산 주기 정책 변경', status: 'QA 대기', versions: [
      { name: 'v2.70.0', releaseDate: '2026-09-30', released: false },
      { name: 'v2.60.0', releaseDate: '2026-08-01', released: true },
    ] }],
    ['OPS-3', { key: 'OPS-3', summary: '운영툴', status: '개발 중', versions: [] }],
    ['ALT-4', { key: 'ALT-4', summary: '알림센터', status: '', versions: [{ name: 'v3.0.0', releaseDate: null, released: false }] }],
    ['OLD-9', { key: 'OLD-9', summary: '옛 서버', status: '진행 중' }],
  ]);
  workflowData = { items: [], meetings: [], projectLinks: { '운영툴': 'OPS-3' } };`;
const REPORT_JIRA_REPORT = JSON.stringify({ weekKey: '2026-09-21', rows: [
  { id: 'r1', heading: '완료한 일', group: 'PAY-77 · 결제 정산 주기 정책 변경', text: '정산 주기 확정', sourceIds: [], excluded: false },
  { id: 'r2', heading: '완료한 일', group: '운영툴', text: '권한 매트릭스 정리', sourceIds: [], excluded: false },
  { id: 'r3', heading: '진행중', group: 'PAY-77 · 결제 정산 주기 정책 변경', text: '배치 설계', sourceIds: [], excluded: false },
  { id: 'r4', heading: '진행중', group: '가입 개선', text: '퍼널 점검', sourceIds: [], excluded: false },
] });

test('`지라 정보`를 켜면 슬랙 글의 프로젝트 줄에만 지라 상태·배포 버전이 붙는다 — 처음 나오는 곳 한 번만', () => {
  const app = reportClient();
  app.run(REPORT_JIRA_SETUP);
  const text = on => app.run(`reportSlackText(reportSlackModel(${REPORT_JIRA_REPORT}, { sections: ['완료', '진행 중'], jira: ${on} }))`);
  assert.equal(text(false).split('\n').includes('결제 정산 주기 정책 변경'), true, '기본(꺼짐)은 예전 글자 그대로다');
  assert.equal(text(false).includes('QA 대기'), false);
  const lines = text(true).split('\n');
  assert.equal(lines.includes('결제 정산 주기 정책 변경 (v2.70.0 · 9/30 배포 · QA 대기)'), true);
  assert.equal(lines.includes('운영툴 (개발 중)'), true, '버전이 없으면 상태만 붙는다(손으로 건 그룹 프로젝트도 같은 길)');
  assert.equal(lines.includes('가입 개선'), true, '지라에 연결되지 않은 프로젝트는 그대로다');
  assert.equal(lines.filter(line => line.startsWith('결제 정산 주기 정책 변경')).length, 2, '프로젝트 줄은 두 구역에 그대로 선다');
  assert.equal(lines.filter(line => line === '결제 정산 주기 정책 변경').length, 1, '괄호는 처음 나오는 곳에만 붙는다');
  assert.equal(text(true).includes('PAY-77'), false, '지라 키는 나가지 않는다');
});

test('세 형식(일반 글자·서식 있는 복사·미리보기)은 지라 정보를 켜도 같은 글자를 쓴다', () => {
  const app = reportClient();
  app.run(REPORT_JIRA_SETUP);
  const model = `reportSlackModel(${REPORT_JIRA_REPORT}, { sections: ['완료'], jira: true })`;
  const lines = JSON.parse(app.run(`JSON.stringify(reportSlackLines(${model}))`));
  assert.equal(lines.map(line => line.text).join('\n'), app.run(`reportSlackText(${model})`));
  const html = app.run(`reportSlackHtml(${model})`);
  assert.equal(html.includes('<b>결제 정산 주기 정책 변경 (v2.70.0 · 9/30 배포 · QA 대기)</b>'), true);
  assert.equal(html.includes('PAY-77'), false);
});

test('배포 버전 칸이 없거나(옛 서버·스냅샷) 모르는 프로젝트면 지라 정보는 조용히 빠진다', () => {
  const app = reportClient();
  app.run(REPORT_JIRA_SETUP);
  const note = name => app.run(`reportJiraNote(${JSON.stringify(name)})`);
  assert.equal(note('OLD-9 · 옛 서버'), '', 'live 칸이 없는 이슈에는 아무것도 붙이지 않는다');
  assert.equal(note('ZZ-1 · 모르는 이슈'), '', '받아 둔 목록에 없으면 조용히 빠진다');
  assert.equal(note('가입 개선'), '', '지라에 걸리지 않은 그룹 프로젝트도 그대로');
  assert.equal(note('알림센터'), '', '연결이 없는 이름은 projectLinks에서도 안 나온다');
  assert.equal(note('ALT-4 · 알림센터'), '', '배포일도 상태도 없으면 괄호 자체가 없다');
  app.run('workflowData = { items: [], meetings: [] };');
  assert.equal(note('운영툴'), '', 'projectLinks가 통째로 없어도 오류 없이 빈 글자다');
});

test('`지라 정보` 칩은 기본 꺼짐이고, 고른 값은 localStorage에 기억된다(막혀 있으면 꺼진 채로)', () => {
  const app = reportClient();
  app.run(REPORT_JIRA_SETUP);
  // 미리보기는 구역 사이 빈 줄을 진짜 줄바꿈 글자로 둔다 — 가짜 창에도 그 자리를 만들어 준다.
  app.context.document.createTextNode = text => ({ textContent: String(text) });
  const saved = new Map();
  app.context.localStorage = {
    getItem: key => (saved.has(key) ? saved.get(key) : null),
    setItem: (key, value) => saved.set(key, String(value)),
  };
  assert.equal(app.run('reportJiraInfo'), false, '기본은 꺼짐이다');
  app.run(`reportPreview(${REPORT_JIRA_REPORT})`);
  const chips = app.nodes.get('weeklyReportPreview').children[1];
  const toggle = chips.children[chips.children.length - 1];
  assert.equal(toggle.textContent, '지라 정보');
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  assert.equal(chips.children[0].className, 'rp-secg', '구역 칩은 따로 묶여 있고 토글은 그 밖에 선다');
  toggle.listeners.click();
  assert.equal(app.run('reportJiraInfo'), true);
  assert.equal(saved.get('workspace-report-jira-info'), 'on');
  assert.equal(app.run('reportJiraInfoLoad()'), true, '다음에 열면 켜진 채로 시작한다');
  toggle.listeners.click();
  assert.equal(saved.get('workspace-report-jira-info'), 'off');

  // 사생활 보호 창처럼 localStorage가 던지는 자리 — 기억만 못 할 뿐 화면은 그대로다.
  app.context.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(app.run('reportJiraInfoLoad()'), false);
  assert.doesNotThrow(() => app.run('reportJiraInfoSave()'));
});

// 지라 동기화가 `그 밖의 이슈`로 적은 이슈(extra) — 요약은 그대로 쓰되 새 프로젝트 후보로는 내놓지 않는다.
test('그 밖의 이슈는 프로젝트 고르기 선택지에서 빠지고, 지금 걸려 있는 값이면 그대로 보인다', () => {
  const app = pureClient();
  app.run(`jiraIssuesCache = [
    { key: 'AB-1', summary: '가입', extra: false },
    { key: 'ZZ-9', summary: '끝난 이슈', status: '완료', extra: true },
  ]; customGroupsCache = [];`);
  const options = code => JSON.parse(app.run(`JSON.stringify(groupSelectOptions(${code}))`));
  const fresh = options('null, false').rest.join('');
  assert.match(fresh, /value="jira:AB-1"/);
  assert.doesNotMatch(fresh, /value="jira:ZZ-9"/, '완료된 이슈는 새로 고를 선택지로 내놓지 않는다');
  const current = options("{ type: 'jira', value: 'ZZ-9' }, false").rest.join('');
  assert.match(current, /value="jira:ZZ-9" selected/, '이미 걸려 있는 값은 골라진 채로 보여야 한다');
});

test('wfProjects: 그 밖의 이슈는 항목이 걸려 있을 때만 프로젝트 목록에 선다', () => {
  const app = workflowsClient();
  app.run(`workflowData = { meetings: [], items: [
    { id: 'a1', type: 'task', status: 'to-do', jira: 'ZZ-9', label: 'ZZ-9 · 끝난 이슈' },
  ] }; wfIndexData();
  jiraIssuesCache = [
    { key: 'AB-1', summary: '가입', extra: false },
    { key: 'ZZ-9', summary: '끝난 이슈', status: '완료', extra: true },
    { key: 'ZZ-8', summary: '아무도 안 쓰는 완료 이슈', status: '완료', extra: true },
  ]; customGroupsCache = [];`);
  const keys = JSON.parse(app.run('JSON.stringify(wfProjects().map(entry => entry[0]))'));
  assert.deepEqual(keys.sort(), ['jira:AB-1', 'jira:ZZ-9'], '항목이 걸린 ZZ-9는 남고, 아무도 안 쓰는 ZZ-8은 목록에 서지 않는다');
});

// 지라에서 끝났는지는 띠 카드의 `지라 상태`가 말한다 — 제목 옆·목록의 글자는 두지 않는다(2026-09-25 결정).
test('프로젝트 탭의 제목·목록에는 지라 완료 글자를 붙이지 않는다', () => {
  const app = workflowsClient();
  app.run(`jiraIssuesByKey = new Map([
    ['ZZ-9', { key: 'ZZ-9', summary: '끝난 이슈', status: '완료', extra: true }],
    ['AB-1', { key: 'AB-1', summary: '가입', status: '진행 중', extra: false }],
  ]);`);
  app.run("workflowData = { items: [], meetings: [] }; wfIndexData(); itemsById = new Map();");
  const titleOf = key => app.run(`(() => {
    const body = document.createElement('div');
    renderProjectDetail(body, { key: '${key}', label: '${key}', open: 0 });
    return body.children[0];
  })()`);
  // 제목 줄에 있는 것은 프로젝트의 ⋯(보관/보관 해제)뿐이다 — 상태를 말하는 글자는 붙지 않는다.
  const extras = node => node.children.filter(kid => !String(kid.className || '').includes('d-more'));
  const done = titleOf('jira:ZZ-9');
  assert.equal(done.className, 'd-ptitle');
  assert.deepEqual(extras(done), [], '지라에서 끝난 이슈에도 제목 옆 글자가 없다');
  assert.equal(done.textContent, '끝난 이슈');
  assert.deepEqual(extras(titleOf('jira:AB-1')), []);
});

// BKEY(2026-09-24): 프로젝트 탭 오른쪽 — 큰 제목은 요약만, 그 아래 조용한 줄에만 지라 키가 붙는다.
test('renderProjectDetail: 큰 제목은 요약만, 그 아래 줄에만 `열린 항목 N · 키`로 키가 붙는다', () => {
  const app = workflowsClient();
  app.run(`jiraIssuesByKey = new Map([['IO-1', { key: 'IO-1', summary: '게시글 작성하기' }]]);
    workflowData = { items: [], meetings: [] }; wfIndexData(); itemsById = new Map();`);
  const jira = JSON.parse(app.run(`JSON.stringify((() => {
    const body = document.createElement('div');
    renderProjectDetail(body, { key: 'jira:IO-1', label: 'IO-1 · 게시글 작성하기', open: 2 });
    return [body.children[0].textContent, body.children[1].textContent];
  })())`));
  assert.deepEqual(jira, ['게시글 작성하기', '열린 항목 2 · IO-1']);
  const group = JSON.parse(app.run(`JSON.stringify((() => {
    const body = document.createElement('div');
    renderProjectDetail(body, { key: 'group:운영툴', label: '운영툴', open: 3 });
    return [body.children[0].textContent, body.children[1].textContent];
  })())`));
  assert.deepEqual(group, ['운영툴', '열린 항목 3'], '그룹에는 키가 없으니 그대로');
});

// BKEY: 프로젝트 탭 왼쪽 목록은 요약만 보이고, title 툴팁에는 키가 남는다(색 점은 원래 키로).
test('renderProjects: 왼쪽 목록은 요약만, title 툴팁엔 키가 남는다', () => {
  const app = workflowsClient();
  app.run(`jiraIssuesByKey = new Map([['IO-1', { key: 'IO-1', summary: '게시글 작성하기' }]]);
    jiraIssuesCache = [...jiraIssuesByKey.values()]; customGroupsCache = [];
    workflowData = { meetings: [], items: [
      { id: 't1', type: 'task', status: 'to-do', jira: 'IO-1', label: 'IO-1 · 게시글 작성하기' },
    ] }; wfIndexData(); itemsById = new Map();
    projectKey = null; projectOrderKeys = null; projectOrderResort = true; projectPastOpen = false;
    renderProjects();`);
  const list = app.nodes.get('projectList');
  const row = list.children.find(child => String(child.className || '').startsWith('d-prow'));
  const name = row.children.find(kid => String(kid.className || '').startsWith('nm'));
  assert.equal(name.textContent, '게시글 작성하기', '왼쪽 목록은 요약만');
  assert.equal(name.title, 'IO-1 · 게시글 작성하기', 'title 툴팁에는 키가 남는다');
});

// ---------- BDEPLOY: 배포 임박 알림 ----------
// 배포일은 프로젝트를 열어야만 보여서 놓치기 쉬웠다. 값(`versions`)은 앱이 지라를 직접 읽을 때만
// 실려 오므로, 그 칸이 없을 때 셋(리마인드·왼쪽 목록·슬랙 글)이 모두 조용히 빠지는 것까지 고정한다.
function dayShift(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const version = (name, days, released = false) =>
  `{ name: '${name}', releaseDate: ${days === null ? 'null' : `'${dayShift(days)}'`}, released: ${released} }`;
// 프로젝트 넷: 지라 프로젝트 둘(지남·모레), 손으로 건 그룹 프로젝트 하나(오늘), 먼 배포 하나(+10일).
const DEPLOY_ISSUES = `jiraIssuesByKey = new Map([
  ['OPS-1', { key: 'OPS-1', summary: '운영툴 대시보드', status: '진행 중', versions: [${version('v2.71.0', 6)}, ${version('v2.69.0', -2)}, ${version('v2.68.0', -9, true)}] }],
  ['IO-1', { key: 'IO-1', summary: '게임 임베드', status: 'QA 대기', versions: [${version('v2.70.0', 2)}] }],
  ['PAY-7', { key: 'PAY-7', summary: '결제 정산', status: '개발 중', versions: [${version('v2.72.0', 0)}] }],
  ['ALT-9', { key: 'ALT-9', summary: '알림센터', status: '대기', versions: [${version('v2.80.0', 10)}] }],
  ['DONE-1', { key: 'DONE-1', summary: '가입 퍼널', status: '완료', versions: [${version('v2.60.0', -1, true)}] }],
]);`;
function deployClient() {
  const app = workflowsClient();
  app.run(`${DEPLOY_ISSUES}
    jiraIssuesCache = [...jiraIssuesByKey.values()]; customGroupsCache = [];
    workflowData = { meetings: [], items: [
      { id: 't1', type: 'task', status: 'to-do', jira: 'OPS-1' },
      { id: 't2', type: 'task', status: 'to-do', jira: 'IO-1' },
      { id: 't3', type: 'check', status: 'to-do', jira: 'IO-1' },
      { id: 't4', type: 'task', status: 'to-do', group: '결제 리뉴얼' },
      { id: 't5', type: 'task', status: 'to-do', jira: 'ALT-9' },
      { id: 't6', type: 'task', status: 'done', jira: 'DONE-1' },
    ], projectLinks: { '결제 리뉴얼': 'PAY-7' } };
    wfIndexData(); itemsById = new Map();`);
  return app;
}
const deployRows = app => JSON.parse(app.run(
  'JSON.stringify(deployReminders(uiProjectRows(wfProjects(), workflowData.items)))'));

test('배포일 말투와 색은 한 곳에서만 만든다 — 지남은 급함, 3일 안은 주의, 그보다 멀면 색이 없다', () => {
  const app = pureClient();
  const day = n => JSON.parse(app.run(`JSON.stringify(deployDayText('${dayShift(n)}'))`));
  assert.deepEqual(day(-2), { text: '배포일 2일 지남', tone: 'urgent', left: -2 });
  assert.deepEqual(day(0), { text: '오늘 배포', tone: 'warn', left: 0 });
  assert.deepEqual(day(1), { text: '내일 배포', tone: 'warn', left: 1 });
  assert.deepEqual(day(3), { text: '배포 3일 전', tone: 'warn', left: 3 });
  assert.deepEqual(day(4), { text: '배포 4일 전', tone: '', left: 4 });
  assert.equal(app.run("String(deployDayText('말도 안 되는 날'))"), 'null');
});

test('가장 이른 미배포 버전만 고르고, 배포 버전 칸이 없으면(스냅샷 대비책) 아무것도 고르지 않는다', () => {
  const app = pureClient();
  const pick = issue => JSON.parse(app.run(`JSON.stringify(deploySoonVersion(${issue}))`));
  assert.equal(pick(`{ versions: [${version('v2.71.0', 6)}, ${version('v2.69.0', -2)}] }`).name, 'v2.69.0');
  assert.equal(pick(`{ versions: [${version('v2.68.0', -9, true)}, ${version('v2.70.0', 2)}] }`).name, 'v2.70.0',
    '이미 배포된 버전은 고르지 않는다');
  assert.equal(pick(`{ versions: [${version('v2.68.0', -9, true)}] }`), null);
  assert.equal(pick(`{ versions: [${version('v2.72.0', null)}] }`), null, '배포일을 모르는 버전은 판단할 수 없다');
  assert.equal(pick('{ versions: [] }'), null);
  assert.equal(pick("{ key: 'IO-1', summary: '게임 임베드' }"), null, 'live 칸이 없는 옛 응답에서는 조용히 빠진다');
  assert.equal(pick('null'), null);
});

test('배포 임박 줄은 열린 항목이 있는 프로젝트만, 3일 안만, 급한 순으로 — 손으로 건 그룹 프로젝트도 함께', () => {
  const app = deployClient();
  const rows = deployRows(app);
  assert.deepEqual(rows.map(row => [row.label, row.name, row.text, row.open]), [
    ['운영툴 대시보드', 'v2.69.0', '배포일 2일 지남', 1],
    ['결제 리뉴얼', 'v2.72.0', '오늘 배포', 1],
    ['게임 임베드', 'v2.70.0', '배포 2일 전', 2],
  ], '지남 → 오늘 → 모레 차례이고, `열린 업무`는 미완료 업무 + 미완료 확인 대기다');
  assert.equal(rows.some(row => row.label.includes('알림센터')), false, '배포가 먼 프로젝트는 서지 않는다');
  assert.equal(rows.some(row => row.label.includes('가입 퍼널')), false, '열린 항목이 없으면 서지 않는다');
  assert.equal(rows.some(row => /[A-Z]+-\d+/.test(`${row.label} ${row.name} ${row.text}`)), false,
    '화면에 나가는 세 값(이름·버전·날짜 말)에는 지라 키가 없다(BKEY) — 프로젝트를 여는 열쇠만 데이터로 들고 있다');

  // live 칸이 통째로 없는 옛 서버·스냅샷 대비책에서는 줄이 하나도 서지 않는다(오류도 없다).
  app.run('jiraIssuesByKey = new Map([...jiraIssuesByKey].map(([key, issue]) => [key, { key, summary: issue.summary, status: issue.status }]));');
  assert.deepEqual(deployRows(app), []);
});

test('리마인드 카드는 배포 임박 줄을 맨 위에 넷까지 세우고 나머지는 `외 N개`로, 개수 칩에는 전부 센다', () => {
  const app = deployClient();
  const many = Array.from({ length: 6 }, (_, at) => ({
    key: `jira:K${at}`, label: `프로젝트 ${at}`, name: `v9.${at}.0`, text: `배포 ${at}일 전`, tone: 'warn', left: at, open: at + 1,
  }));
  app.context.many = many;
  app.run('opened = null; openProjectTab = key => { opened = key; };');
  app.run('renderReminders([], [], many)');
  const list = app.nodes.get('reminderList');
  assert.equal(app.nodes.get('reminderSectionCount').textContent, 6, '칩은 안 보이는 줄까지 센다');
  assert.equal(app.nodes.get('reminderZone').hidden, false);
  assert.equal(list.children.length, 5, '줄 넷 + `외 N개` 한 줄');
  assert.equal(list.children[4].textContent, '외 2개');
  const first = list.children[0];
  const title = first.children.find(kid => String(kid.className || '') === 'ti');
  assert.equal(title.textContent, '프로젝트 0', '첫 줄은 프로젝트 이름이다');
  assert.equal(title.title, 'v9.0.0 배포 0일 전 · 프로젝트 0 · 열린 업무 1');
  // 둘째 줄은 조각(fragment)으로 담아 넘긴다 — 가짜 DOM에서는 그 조각이 한 겹 더 남는다.
  const sub = first.children.find(kid => String(kid.className || '') === 'sub').children[0];
  assert.deepEqual(sub.children.map(kid => kid.textContent), ['v9.0.0 배포 0일 전', '열린 업무 1']);
  assert.equal(sub.children[0].className, 'k-warn', '색은 글자색이다 — 배지(bd)가 아니다');
  title.listeners.click();
  assert.equal(app.run('opened'), 'jira:K0', '누르면 그 프로젝트가 열린다');

  app.run('renderReminders([], [], [])');
  assert.equal(app.nodes.get('reminderZone').hidden, true, '셋 다 없으면 카드가 통째로 빈다');
});

test('왼쪽 프로젝트 목록은 배포가 2주 안일 때만 조용한 날짜를 적고, title이 무슨 날인지 풀어 준다', () => {
  const app = deployClient();
  const note = key => JSON.parse(app.run(`JSON.stringify(projectDeployNote('${key}'))`));
  assert.deepEqual(note('jira:IO-1'),
    { text: dayShift(2).replace(/^\d{4}-0?(\d+)-0?(\d+)$/, '$1/$2'), tone: 'warn', title: `v2.70.0 · ${app.run(`uiKoDateShort('${dayShift(2)}')`)} 배포 예정` });
  assert.equal(note('jira:ALT-9').tone, '', '2주 안이지만 3일보다 멀면 색이 없다');
  assert.equal(note('jira:OPS-1').tone, 'urgent');
  assert.equal(note('group:결제 리뉴얼').text, dayShift(0).replace(/^\d{4}-0?(\d+)-0?(\d+)$/, '$1/$2'), '손으로 건 그룹 프로젝트도 같은 길이다');
  assert.equal(note('group:없는 프로젝트'), null);
  assert.equal(note('jira:DONE-1'), null, '이미 배포된 버전만 있으면 적지 않는다');

  app.run(`jiraIssuesByKey.set('FAR-1', { key: 'FAR-1', summary: '먼 것', versions: [${version('v3.0.0', 20)}] });`);
  assert.equal(note('jira:FAR-1'), null, '2주보다 먼 배포일은 목록을 시끄럽게 하지 않는다');

  const cells = () => app.nodes.get('projectList').children
    .filter(child => String(child.className || '').startsWith('d-prow'))
    .map(row => (row.children.find(kid => String(kid.className || '') === 'rt') || { children: [] })
      .children.find(kid => String(kid.className || '').startsWith('dp')))
    .filter(Boolean);
  app.run('projectKey = null; projectOrderKeys = null; projectOrderResort = true; projectPastOpen = false; renderProjects();');
  const days = cells();
  assert.deepEqual(days.map(day => day.className).sort(), ['dp', 'dp k-neg', 'dp k-warn', 'dp k-warn'],
    '열린 항목이 있는 네 프로젝트에만 배포일이 붙는다(이미 배포된 가입 퍼널은 빠진다)');
  assert.equal(days.every(day => /^\d+\/\d+$/.test(day.textContent)), true, '글자는 `9/30` 꼴이다');

  // live 칸이 없으면 이 글자 자체가 없다.
  app.run(`jiraIssuesByKey = new Map([...jiraIssuesByKey].map(([key, issue]) => [key, { key, summary: issue.summary }]));
    projectOrderResort = true; renderProjects();`);
  assert.equal(cells().length, 0);
});

// ---------- 확인 대기를 체크한 뒤의 `다음은?` 줄 ----------
// 답을 받은 직후가 다음 행동을 정하기 가장 좋은 때인데, 몇 초 만에 사라지는 알림으로는 그 순간이
// 지나가 버렸다. 체크는 지금처럼 바로 저장되고, 제안 줄은 그 자리에 남는다.
function waitingNextClient(response = new Response('{"ok":true,"id":"nt1"}')) {
  const app = workflowsClient();
  const sent = [];
  app.context.fetch = async (url, init) => {
    sent.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
    return typeof response === 'function' ? response() : response.clone();
  };
  app.run(`workflowData = { items: [
    { id: 'ck1', type: 'check', description: '법무 검토 회신 받기', status: 'to-do', created: todayStr(), group: '가입 개선', who: '법무팀' },
    { id: 'ck2', type: 'check', description: '벤더 확인 회신 받기', status: 'to-do', created: todayStr(), jira: 'PAY-77' },
  ], meetings: [] }; wfIndexData(); itemsById = new Map(workflowData.items.map(item => [item.id, item]));`);
  const check = id => app.run(`(() => { const item = wfItem('${id}'); item.status = 'done'; wfIndexData(); waitingNextOpen(item); return item; })()`);
  return { app, sent, check };
}

test('확인 대기를 체크하면 저장은 그대로이고, 알림은 사실만 알린다(`결정으로 남기기` 버튼은 줄이 대신한다)', async () => {
  const { app, sent } = waitingNextClient(new Response('{"ok":true}'));
  const row = app.run("renderWaitingRow(wfItem('ck1'))");
  await firstCheckbox(row.children[0]).listeners.change();
  assert.deepEqual(sent.map(call => call.url), ['/api/track/toggle'], '저장 길은 목록과 같은 toggle 하나다');
  assert.deepEqual(sent[0].body, { id: 'ck1', status: 'done' });
  const region = app.nodes.get('liveRegion');
  assert.equal(region.textContent, '확인 완료로 표시했어요');
  assert.equal(region.children.some(node => node.textContent === '결정으로 남기기'), false, '알림에는 더 이상 후속 버튼이 없다');
  assert.equal(app.run('waitingNextId'), 'ck1', '다음 행동은 체크한 그 자리에서 묻는다');
});

test('`다음은?` 줄은 목록을 다시 그려도 남고, 체크를 되돌리면 사라진다', () => {
  const { app, check } = waitingNextClient();
  check('ck1');
  const draw = () => app.run("renderWaiting(workflowData.items.filter(item => item.status !== 'done'))");
  draw();
  const list = app.nodes.get('waitingList');
  assert.equal(list.children[0].className, 'd-wnextwrap', '체크한 줄은 목록 맨 위에 한 번 더 서고');
  assert.equal(list.children[0].children[1].className, 'd-wnext is-one', '그 아래에 한 줄짜리 `다음은?`이 붙는다');
  draw();
  assert.equal(list.children[0].className, 'd-wnextwrap', 'load()로 다시 그려도 그대로 남는다');
  // ⌘Z나 체크 해제로 미완료가 되면 스스로 내려간다(저장하지 않는 메모리 상태라 판정은 지금 값으로 한다)
  app.run("wfItem('ck1').status = 'to-do'; wfIndexData();");
  assert.equal(app.run('waitingNextItem()'), null);
  draw();
  assert.notEqual(list.children[0].className, 'd-wnextwrap');
});

test('다른 확인 대기를 체크하면 `다음은?` 줄이 그쪽으로 옮겨 간다', () => {
  const { app, check } = waitingNextClient();
  check('ck1');
  check('ck2');
  assert.equal(app.run('waitingNextId'), 'ck2');
  assert.equal(app.run("waitingNextItem('ck1')"), null, '먼저 체크한 줄에는 더 이상 붙지 않는다');
  assert.equal(app.run("waitingNextItem('ck2').id"), 'ck2');
});

test('후속 할 일은 확인 대기와 같은 프로젝트로, 기한 없이 만들어진다(Enter는 오늘, 조합 중 Enter는 넘긴다)', async () => {
  const { app, sent, check } = waitingNextClient();
  const item = check('ck1');
  const next = app.run("waitingNextRow(wfItem('ck1'))");
  const bar = next.children[0];
  assert.deepEqual(bar.children.map(node => node.textContent), ['다음은?', '후속 할 일', '결정으로 남기기', '답변 한 줄 남기기', '닫기']);
  bar.children[1].listeners.click();
  const form = next.children[0];
  const input = form.children[0];
  assert.equal(input.value, item.description, '확인 대기 문구가 미리 들어가고');
  assert.equal(input.selected, true, '전체 선택된 채로 열린다');
  assert.deepEqual(form.children.slice(1).map(node => node.textContent), ['오늘', '나중에']);

  await input.listeners.keydown({ key: 'Enter', isComposing: true, preventDefault() {} });
  assert.deepEqual(sent, [], '한글을 조합하는 중의 Enter는 글자를 확정하는 것이라 넘긴다');
  await input.listeners.keydown({ key: 'Enter', preventDefault() {} });
  assert.deepEqual(sent.map(call => call.url), ['/api/today-task/create']);
  assert.deepEqual(sent[0].body, { description: '법무 검토 회신 받기', group: '가입 개선' }, '기한·우선순위는 넣지 않는다');
  assert.equal(app.run('waitingNextId'), null, '만든 뒤에는 줄이 닫힌다');
  assert.equal(app.run('undoStack.length'), 1, '되돌리기는 만든 업무를 지우는 기존 길이다');
});

test('`나중에`는 나중에 할 일로, 지라 확인 대기는 같은 지라 이슈로 만든다', async () => {
  const { app, sent, check } = waitingNextClient();
  check('ck2');
  const next = app.run("waitingNextRow(wfItem('ck2'))");
  next.children[0].children[1].listeners.click();
  const form = next.children[0];
  await form.children[2].listeners.click(); // 나중에
  assert.deepEqual(sent.map(call => call.url), ['/api/later-task/create']);
  assert.deepEqual(sent[0].body, { description: '벤더 확인 회신 받기', jira: 'PAY-77' });
});

test('답변 한 줄은 업무의 결과 한 줄과 같은 저장 길(outcome)을 쓴다', async () => {
  const { app, sent, check } = waitingNextClient();
  check('ck1');
  const next = app.run("waitingNextRow(wfItem('ck1'))");
  next.children[0].children[3].listeners.click();
  const form = next.children[0];
  const input = form.children[0];
  assert.equal(input.getAttribute('aria-label'), '법무 검토 회신 받기 — 답변 한 줄');
  input.value = ' 법무 검토 통과 ';
  await input.listeners.keydown({ key: 'Enter', preventDefault() {} });
  assert.deepEqual(sent.map(call => call.url), ['/api/workflow/item']);
  assert.deepEqual(sent[0].body, { id: 'ck1', outcome: '법무 검토 통과' });
  assert.equal(app.run('waitingNextId'), null);
});

test('이 답을 기다리던 업무는 있을 때만, 최대 세 줄까지 선다', () => {
  const { app, check } = waitingNextClient();
  check('ck1');
  assert.equal(app.run("waitingNextRow(wfItem('ck1')).children.length"), 1, '연결된 업무가 없으면 그 줄은 그리지 않는다');
  app.run(`workflowData.items.push(
    { id: 't1', type: 'task', description: '업무1', status: 'to-do', blockedBy: 'ck1', scheduled: todayStr() },
    { id: 't2', type: 'task', description: '업무2', status: 'to-do', blockedBy: 'ck1' },
    { id: 't3', type: 'task', description: '업무3', status: 'to-do', blockedBy: 'ck1' },
    { id: 't4', type: 'task', description: '업무4', status: 'to-do', blockedBy: 'ck1' },
    { id: 't5', type: 'task', description: '끝난 업무', status: 'done', blockedBy: 'ck1' }
  ); wfIndexData();`);
  const blocked = app.run("waitingNextRow(wfItem('ck1')).children[1]");
  assert.equal(blocked.className, 'bl');
  assert.equal(blocked.children[0].textContent, '이 답을 기다리던 업무');
  // 줄은 제목 + 버튼 묶음(.ac) 둘이고, 버튼은 좁은 자리에서 따로 줄바꿈되지 않게 한 덩어리로 붙어 있다.
  const line = at => [blocked.children[at].children[0].textContent, ...blocked.children[at].children[1].children.map(node => node.textContent)];
  assert.deepEqual(line(1), ['업무1', '열기'], '이미 오늘 할 일이면 `오늘로`는 없다');
  assert.deepEqual(line(2), ['업무2', '오늘로', '열기']);
  assert.equal(blocked.children.length, 5, '제목 + 세 줄 + 나머지 안내');
  assert.equal(blocked.children[4].textContent, '외 1개');
});

test('`다음은?` 줄은 프로젝트 탭 확인 대기 구역 맨 위와 회의의 나온 줄 아래에 같은 부품으로 선다', () => {
  const { app, check } = waitingNextClient();
  app.run("workflowData.items.push({ id: 'ck3', type: 'check', description: '남은 확인', status: 'to-do', created: todayStr(), group: '가입 개선' }); wfIndexData();");
  check('ck1');

  const body = app.run(`(() => {
    const body = document.createElement('div');
    renderProjectDetail(body, { key: 'group:가입 개선', label: '가입 개선', open: 1 });
    return body;
  })()`);
  const section = body.children.find(node => node.className === 'd-psec'
    && node.children[0].children.some(kid => kid.textContent === '확인 대기'));
  const surface = section.children[1];
  assert.equal(surface.children[0].className, 'd-wnextwrap', '체크한 줄은 구역 맨 위에 다시 서고');
  assert.equal(surface.children[0].children[1].className, 'd-wnext');
  assert.equal(surface.children[1].children[1].textContent, '남은 확인', '남은 줄은 그대로다');

  // 회의는 체크한 줄이 is-done으로 남으므로 그 줄 바로 아래에 붙는다
  app.run("workflowData.items.forEach(item => { if (item.id === 'ck1') item.meetingId = 'm1'; }); wfIndexData();");
  const box = app.run(`(() => { const box = document.createElement('div'); panelMeetingItems({ id: 'm1' }, box); return box; })()`);
  const rows = box.children[0].children;
  // 회의에 프로젝트가 없고 항목에는 있으므로 줄이 `· ● 가입 개선`을 달고 있다(has-pj) — 종류는 하나뿐이라 소제목은 없다.
  assert.equal(rows[1].className, 'd-mrow2 has-pj is-done');
  assert.equal(rows[2].className, 'd-wnext');
});

test('`닫기`는 줄만 내린다 — 체크는 이미 저장됐으므로 아무것도 보내지 않는다', () => {
  const { app, sent, check } = waitingNextClient();
  check('ck1');
  const next = app.run("waitingNextRow(wfItem('ck1'))");
  next.children[0].children[4].listeners.click();
  assert.equal(app.run('waitingNextId'), null);
  assert.deepEqual(sent, []);
});

// ---------- 미팅 노트 가져오기 ----------
// 화면이 하는 일은 셋뿐이다: 누른 그 버튼만 `가져오는 중…`으로 바꾸고, 상태를 되묻고,
// 끝나면 목록을 다시 그리며 한 번 알린다(서버는 요청 표시 파일만 쓴다 — DECISIONS 2026-09-24).
function meetingNotesClient(queue) {
  const app = workflowsClient();
  const sent = [];
  app.context.fetch = async (url, init) => {
    sent.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
    const next = queue.shift();
    return new Response(JSON.stringify(next || {}), { status: next && next.httpStatus ? next.httpStatus : 200 });
  };
  app.run('workflowData = { items: [], meetings: [] }; wfIndexData();');
  app.run("var loaded = 0; load = async () => { loaded += 1; };");
  return { app, sent };
}
const meetingNotesDay = days => {
  const value = new Date();
  value.setDate(value.getDate() + days);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
};

test('미팅 노트 버튼은 아직 노트가 없고 이미 시작한 회의에만 선다', () => {
  const { app } = meetingNotesClient([]);
  app.run("meetingNotesApply({ used: true, state: 'idle' })");
  const can = event => app.run(`meetingNotesCanFetch(${JSON.stringify(event)})`);
  const past = { date: meetingNotesDay(-3), start: '10:00', end: '11:00', title: '지난 주간 싱크' };
  assert.equal(can(past), true, '지난 회의에서도 가져올 수 있다');
  assert.equal(can({ ...past, tiroNotes: ['https://tiro.ooo/n/1'] }), false, '이미 가져온 회의에는 그리지 않는다');
  assert.equal(can({ ...past, tiroNotes: [] }), false, '노트는 있고 링크만 없는 회의도 마찬가지다');
  assert.equal(can({ ...past, date: meetingNotesDay(1) }), false, '미래 회의에는 그리지 않는다');
  // 23:59에 돌리면 그 회의도 이미 시작한 것이라 그때만 건너뛴다
  if (new Date().getHours() < 23) assert.equal(can({ date: meetingNotesDay(0), start: '23:59', title: '아직 안 열린 회의' }), false, '아직 시작하지 않았으면 그리지 않는다');
  assert.equal(can({ date: meetingNotesDay(0), start: '00:00', title: '이미 시작한 회의' }), true);
  // 쓰지 않도록 꺼 두면 아무 데도 그리지 않는다
  app.run("meetingNotesApply({ used: false, state: 'off' })");
  assert.equal(can(past), false);
});

test('누른 버튼만 `가져오는 중…`이 되고 다른 가져오기 버튼은 눌리지 않는다', async () => {
  const meeting = { date: meetingNotesDay(-2), start: '14:00', end: '15:00', title: '결제 리뉴얼 PRD 리뷰' };
  const { app, sent } = meetingNotesClient([{ ok: true, used: true, state: 'requested', scope: 'meeting', meeting }]);
  app.run("meetingNotesApply({ used: true, state: 'idle' })");
  const all = app.run("meetingNotesButton('오늘 것 모두 가져오기', 'today')");
  const one = app.run(`meetingNotesButton('이 회의의 미팅 노트 가져오기', ${JSON.stringify(meeting)})`);
  assert.equal(one.textContent, '이 회의의 미팅 노트 가져오기');
  assert.equal(one.disabled, false);

  await one.listeners.click();
  assert.deepEqual(sent, [{ url: '/api/meeting-notes/request', body: { scope: 'meeting', meeting } }]);
  assert.equal(one.textContent, '가져오는 중…', '누른 버튼만 진행 표시가 된다');
  assert.equal(one.disabled, true);
  assert.equal(all.textContent, '오늘 것 모두 가져오기');
  assert.equal(all.disabled, true, '동시에 하나만 — 다른 버튼은 눌리지 않는다');

  // 진행 중에는 다시 눌러도 요청이 한 번 더 나가지 않는다
  await all.listeners.click();
  assert.equal(sent.length, 1);
});

test('가져오기가 끝나면 목록을 다시 그리고 한 번만 알린다', async () => {
  const { app } = meetingNotesClient([{ used: true, state: 'done', scope: 'today', summary: '노트 2개, 초안 5개를 남겼습니다' }]);
  app.run("meetingNotesApply({ used: true, state: 'running', scope: 'today' })");
  const button = app.run("meetingNotesButton('오늘 것 모두 가져오기', 'today')");
  assert.equal(button.textContent, '가져오는 중…', '페이지를 새로 열어도 진행 중이면 같은 표시로 이어진다');
  await app.run('meetingNotesPoll()');
  assert.equal(app.run('loaded'), 1, '끝나면 load()로 다시 그린다');
  assert.match(app.nodes.get('liveRegion').textContent, /^미팅 노트를 가져왔어요 · 노트 2개, 초안 5개를 남겼습니다/);
  assert.equal(button.textContent, '오늘 것 모두 가져오기');
  assert.equal(button.disabled, false);
  // 같은 상태를 다시 읽어도 알림은 한 번뿐이다
  app.nodes.get('liveRegion').textContent = '';
  app.run("meetingNotesApply({ used: true, state: 'done', scope: 'today', summary: '노트 2개' })");
  assert.equal(app.nodes.get('liveRegion').textContent, '');
});

test('회의 하나를 가져오면 그 회의의 초안 수로 알리고, 없으면 못 찾았다고 알린다', async () => {
  const meeting = { date: meetingNotesDay(-1), start: '16:00', end: '17:00', title: '알림센터 인프라 협의' };
  const done = { used: true, state: 'done', scope: 'meeting', meeting };
  const { app } = meetingNotesClient([done, done]);
  app.run("meetingNotesApply({ used: true, state: 'running', scope: 'meeting', meeting: " + JSON.stringify(meeting) + ' })');
  await app.run('meetingNotesPoll()');
  assert.match(app.nodes.get('liveRegion').textContent, /이 회의 시간에 녹음된 노트를 찾지 못했어요/);

  app.run(`workflowData = { items: [], meetings: [{ id: 'm9', ...${JSON.stringify(meeting)}, tiroNotes: ['https://tiro.ooo/n/9'], drafts: [{ id: 'd1' }, { id: 'd2' }] }] }; wfIndexData();`);
  app.run("meetingNotesApply({ used: true, state: 'running', scope: 'meeting', meeting: " + JSON.stringify(meeting) + ' })');
  await app.run('meetingNotesPoll()');
  assert.match(app.nodes.get('liveRegion').textContent, /^미팅 노트를 가져왔어요 · 초안 2개/);
});

test('실패하면 오류 알림에 `자세히`가 붙는다', async () => {
  const { app } = meetingNotesClient([{ used: true, state: 'failed', scope: 'today', summary: '자동 실행이 등록되지 않은 것 같아요.' }]);
  app.run("meetingNotesApply({ used: true, state: 'requested', scope: 'today' })");
  await app.run('meetingNotesPoll()');
  const region = app.nodes.get('liveRegion');
  assert.match(region.textContent, /미팅 노트를 가져오지 못했어요/);
  assert.equal(region.children.some(node => node && node.textContent === '자세히'), true);
});

test('버튼 옆 조용한 기록은 오늘 성공한 실행이 있을 때만 적는다', () => {
  const { app } = meetingNotesClient([]);
  app.run(`meetingNotesApply({ used: true, state: 'done', lastRunAt: '${meetingNotesDay(0)} 14:20:05', lastKind: 'run' })`);
  assert.equal(app.run('meetingNotesLastText()'), '오늘 14:20에 가져왔어요');
  app.run(`meetingNotesApply({ used: true, state: 'failed', lastRunAt: '${meetingNotesDay(0)} 14:20:05', lastKind: 'fail' })`);
  assert.equal(app.run('meetingNotesLastText()'), '');
  app.run(`meetingNotesApply({ used: true, state: 'done', lastRunAt: '${meetingNotesDay(-1)} 14:20:05', lastKind: 'run' })`);
  assert.equal(app.run('meetingNotesLastText()'), '', '어제 것은 적지 않는다');
});

// ---------- BTIRO2: 미팅 노트를 이미 다 가져온 상태의 대응 ----------
// 가짜 DOM에는 innerHTML이 없다 — nodeText·nodeFind(밑에서 정의)로 붙인 글자·자식을 훑는다.
test('meetingNotesPendingToday: 오늘 이미 시작했고 아직 노트가 없는 회의만 센다(시작 전·지난 날짜·이미 가져온 회의는 뺀다)', () => {
  const { app } = meetingNotesClient([]);
  app.run("meetingNotesApply({ used: true, state: 'idle' })");
  const today = meetingNotesDay(0);
  app.run(`workflowData.meetings = [
    { date: '${today}', start: '00:00', title: '이미 시작한 회의' },
    { date: '${today}', start: '00:00', title: '이미 가져온 회의', tiroNotes: ['https://tiro.ooo/n/1'] },
    { date: '${meetingNotesDay(-1)}', start: '00:00', title: '지난 날짜 회의' },
  ]; wfIndexData();`);
  assert.equal(app.run('meetingNotesPendingToday()'), 1);
  if (new Date().getHours() < 23) {
    app.run(`workflowData.meetings.push({ date: '${today}', start: '23:59', title: '아직 안 열린 회의' }); wfIndexData();`);
    assert.equal(app.run('meetingNotesPendingToday()'), 1, '아직 시작하지 않은 오늘 회의는 더하지 않는다');
  }
});

// ---------- BNOTES A: 안 가져온 미팅 노트 알림 ----------
test('meetingNotesMissingToday: 끝난 오늘 회의 중 아직 노트가 없는 회의만 센다(end 없으면 start+1시간, 시작 전·진행 중·지난 날짜·이미 가져온 회의는 뺀다), tiro를 안 쓰면 없다', () => {
  // 자정 근처 35분은 아래 고정 시각(00:00대)이 아직 "끝난" 것이 아닐 수 있어 건너뛴다.
  if (new Date().getHours() === 0 && new Date().getMinutes() < 35) return;
  const { app } = meetingNotesClient([]);
  app.run("meetingNotesApply({ used: true, state: 'idle' })");
  const today = meetingNotesDay(0);
  const yesterday = meetingNotesDay(-1);
  app.run(`workflowData.meetings = [
    { id: 'm1', date: '${today}', start: '00:00', end: '00:30', title: '끝난 회의(정한 end)' },
    { id: 'm2', date: '${today}', start: '00:00', title: '끝난 회의(end 없음 → start+1시간)' },
    { id: 'm3', date: '${today}', start: '00:00', end: '00:30', title: '이미 가져온 회의', tiroNotes: ['https://tiro.ooo/n/1'] },
    { id: 'm4', date: '${yesterday}', start: '00:00', end: '00:30', title: '지난 날짜 회의' },
  ]; wfIndexData();`);
  let missing = () => JSON.parse(app.run('JSON.stringify(meetingNotesMissingToday().map(e => e.id))'));
  assert.deepEqual(missing(), ['m1', 'm2'], '정한 end든 start+1시간 추정이든 이미 끝났고 노트가 없으면 대상, 노트 있거나 지난 날짜는 아니다');

  if (new Date().getHours() < 23) {
    app.run(`workflowData.meetings.push(
      { id: 'm5', date: '${today}', start: '23:59', title: '아직 안 열린 회의' },
      { id: 'm6', date: '${today}', start: '00:00', end: '23:59', title: '진행 중인 회의(아직 안 끝남)' },
    ); wfIndexData();`);
    assert.deepEqual(missing(), ['m1', 'm2'], '시작 전·아직 안 끝난 회의는 더하지 않는다');
  }

  app.run("meetingNotesApply({ used: false, state: 'off' })");
  assert.deepEqual(missing(), [], 'tiro를 쓰지 않으면 대상이 없다');
});

test('안 가져온 미팅 노트는 리마인드 카드에 오르지 않는다 — 회의 탭에서만 알린다', () => {
  const { app } = meetingNotesClient([]);
  app.run("meetingNotesApply({ used: true, state: 'idle' })");
  assert.equal(app.run('typeof meetingNotesReminderRow'), 'undefined', '리마인드용 줄 함수가 없다');
  app.run('renderReminders([], [], [])');
  assert.equal(app.nodes.get('reminderZone').hidden, true, '다른 리마인드가 없으면 카드가 빈다');
  assert.equal(app.nodes.get('reminderSectionCount').textContent, 0);
});

test('회의 탭 머리의 세 상태: 가져올 게 있으면 버튼+개수, 다 가져왔으면 상태 글자+`다시 확인`, 오늘 시작한 회의가 없으면 다른 글자', async () => {
  const { app, sent } = meetingNotesClient([{ used: true, state: 'requested', scope: 'today' }]);
  app.run("meetingNotesApply({ used: true, state: 'idle' })");
  const list = () => app.nodes.get('meetingList');
  const clean = text => text.replace(/\s+/g, ' ').trim();

  // 오늘 시작한 회의가 하나도 없다
  app.run('workflowData = { items: [], meetings: [] }; wfIndexData(); renderMeetings();');
  assert.equal(nodeFind(list().children[0], 'd-btn'), null);
  let idle = nodeFind(list(), 'd-mtlast');
  assert.equal(clean(nodeText(idle)), '아직 가져올 미팅 노트가 없어요 다시 확인');

  // 오늘 시작한 회의가 있고 아직 노트가 없다 — 버튼 + 개수(조용한 숫자 표현)
  const today = meetingNotesDay(0);
  app.run(`workflowData.meetings = [{ date: '${today}', start: '00:00', title: 'A' }]; wfIndexData(); renderMeetings();`);
  const button = nodeFind(list().children[0], 'd-btn');
  assert.equal(clean(nodeText(button)), '오늘 것 모두 가져오기 1');
  assert.equal(button.disabled, false);

  // 이미 다 가져왔다 — 버튼 대신 상태 글자 + `다시 확인`
  app.run(`workflowData.meetings = [{ date: '${today}', start: '00:00', title: 'A', tiroNotes: ['https://tiro.ooo/n/1'] }]; wfIndexData(); renderMeetings();`);
  assert.equal(nodeFind(list().children[0], 'd-btn'), null, '가져올 게 없으면 버튼은 서지 않는다');
  idle = nodeFind(list(), 'd-mtlast');
  assert.equal(clean(nodeText(idle)), '오늘 미팅 노트는 다 가져왔어요 다시 확인');

  // `다시 확인`은 같은 `meetingNotesStart('today')` 길을 쓴다
  const retry = nodeFind(idle, 'd-link');
  await retry.listeners.click();
  assert.deepEqual(sent, [{ url: '/api/meeting-notes/request', body: { scope: 'today' } }]);
});

test('오늘 미팅 줄 ⋯ 메뉴: 가져올 게 있으면 `오늘 것 모두 가져오기 N`, 없으면 비활성 문구', () => {
  const { app } = meetingNotesClient([]);
  app.run("meetingNotesApply({ used: true, state: 'idle' })");
  const today = meetingNotesDay(0);
  const sections = () => JSON.parse(app.run(`JSON.stringify(
    meetingMenuSections({ title: 'A' }, { fetchAll: true }).map(section => section.map(entry => ({ label: entry.label, disabled: !!entry.disabled }))))`));

  app.run(`workflowData.meetings = [{ date: '${today}', start: '00:00', title: 'A' }]; wfIndexData();`);
  let entry = sections()[0].find(a => a.label.startsWith('오늘 것'));
  assert.deepEqual(entry, { label: '오늘 것 모두 가져오기 1', disabled: false });

  app.run(`workflowData.meetings = [{ date: '${today}', start: '00:00', title: 'A', tiroNotes: ['https://tiro.ooo/n/1'] }]; wfIndexData();`);
  entry = sections()[0].find(a => a.label.includes('다 가져왔어요'));
  assert.deepEqual(entry, { label: '오늘 미팅 노트는 다 가져왔어요', disabled: true });
});

test('가져오기가 끝난 뒤: 보내기 전 기억과 비교해 늘었으면 회의·초안 수로 알린다', async () => {
  const { app } = meetingNotesClient([
    { used: true, state: 'requested', scope: 'today' },
    { used: true, state: 'done', scope: 'today', summary: '로그 요약(기억이 있으면 쓰이지 않는다)' },
  ]);
  app.run("meetingNotesApply({ used: true, state: 'idle' })");
  await app.run("meetingNotesStart('today')");
  const today = meetingNotesDay(0);
  app.run(`load = async () => { loaded += 1; workflowData.meetings = [{ id: 'm1', date: '${today}', start: '09:00', title: 'X', tiroNotes: ['https://tiro.ooo/n/1'], drafts: [{ id: 'd1' }, { id: 'd2' }] }]; wfIndexData(); };`);
  await app.run('meetingNotesPoll()');
  assert.equal(app.nodes.get('liveRegion').textContent, '미팅 노트를 가져왔어요 · 회의 1개, 초안 2개');
});

test('가져오기가 끝났는데 늘어난 게 없으면 오류가 아니라 `새로 가져올 미팅 노트가 없었어요`로 알린다', async () => {
  const { app } = meetingNotesClient([
    { used: true, state: 'requested', scope: 'today' },
    { used: true, state: 'done', scope: 'today', summary: '노트 0개' },
  ]);
  app.run("meetingNotesApply({ used: true, state: 'idle' })");
  await app.run("meetingNotesStart('today')");
  // workflowData는 그대로다(늘어난 회의·초안이 없다) — load()는 기본 목(무동작)을 그대로 쓴다.
  await app.run('meetingNotesPoll()');
  assert.equal(app.nodes.get('liveRegion').textContent, '새로 가져올 미팅 노트가 없었어요');
});
// 기억이 없을 때(페이지를 새로 열어 진행 중인 요청에 이어붙은 경우)는 위 `가져오기가 끝나면 목록을 다시
// 그리고 한 번만 알린다` 테스트가 이미 확인한다 — meetingNotesStart를 부르지 않아 기억이 없으므로
// status.summary로 만든 기존 문구(`미팅 노트를 가져왔어요 · 노트 2개, 초안 5개를 남겼습니다`)로 돌아간다.

test('panelMeeting: 이미 가져온 회의에는 `미팅 노트 가져옴`이 뜨고, 링크가 있으면 `티로에서 열기`가 붙는다(초안이 0개여도 남는다)', () => {
  const { app } = meetingNotesClient([]);
  app.run("meetingNotesApply({ used: true, state: 'idle' })");
  const past = {
    id: 'm1', date: meetingNotesDay(-1), start: '10:00', end: '10:30', title: '지난 회의',
    tiroNotes: ['https://tiro.ooo/n/1', 'https://tiro.ooo/n/2'], drafts: [],
  };
  app.context.__past = past;
  app.run('workflowData.meetings = [__past]; wfIndexData();');
  const box = app.run(`(() => { const box = document.createElement('div'); panelMeeting(__past, box); return box; })()`);
  const get = nodeFind(box, 'd-dget');
  assert.ok(get, '가져오기 버튼이 서던 자리에 표시가 선다');
  assert.match(nodeText(get), /미팅 노트 가져옴/);
  const links = get.children.filter(node => node.className === 'd-link');
  assert.equal(links.length, 2, '노트가 여럿이면 링크도 그만큼');
  assert.equal(links[0].textContent, '티로에서 열기 1');
  assert.equal(links[1].textContent, '티로에서 열기 2');
  assert.equal(links[0].target, '_blank');
  assert.equal(links[0].rel, 'noopener noreferrer');

  // 노트는 있어도(가져오긴 했어도) 서버가 준 값에 링크가 없으면(tiroNotes: []) 링크 없이 상태 글자만.
  const noLink = { ...past, tiroNotes: [] };
  app.context.__noLink = noLink;
  const box2 = app.run(`(() => { const box = document.createElement('div'); panelMeeting(__noLink, box); return box; })()`);
  const get2 = nodeFind(box2, 'd-dget');
  assert.match(nodeText(get2), /미팅 노트 가져옴/);
  assert.equal(get2.children.filter(node => node.className === 'd-link').length, 0);

  // 시작 전 회의(캘린더에는 있지만 노트도 없고 아직 시작도 안 함)에는 이 자리 자체가 없다.
  const future = { id: 'm2', date: meetingNotesDay(2), start: '10:00', title: '미래 회의' };
  app.context.__future = future;
  const box3 = app.run(`(() => { const box = document.createElement('div'); panelMeeting(__future, box); return box; })()`);
  assert.equal(nodeFind(box3, 'd-dget'), null);
});
// 낡음 경고는 머리줄에 글자로 끼어들지 않는다(탭이 밀렸다) — 설정 톱니바퀴의 주황 점과 툴팁으로만 알린다.
test('renderDateBar: 낡음 경고는 톱니바퀴의 점·툴팁으로만 알리고, 아침 첫 자동 갱신 전의 `어제 기준`은 알리지 않는다', () => {
  const app = pureClient();
  const gear = (clock, data) => JSON.parse(app.run(`(() => {
    nowHHMM = () => '${clock}';
    document.getElementById('dateBar').replaceChildren();
    renderDateBar(${JSON.stringify(data)});
    const button = document.getElementById('settingsBtn');
    return JSON.stringify({ chips: document.getElementById('dateBar').children.length, label: button.getAttribute('aria-label'), keys: syncStale.map(entry => entry.key) });
  })()`));
  const today = app.run('todayStr()');
  const ago = days => app.run(`(() => { const d = new Date(); d.setDate(d.getDate() - ${days}); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })()`);
  const allYesterday = { today, slackSync: { stale: true, lastSync: ago(1) }, calendar: { stale: true, lastSync: ago(1) }, jiraSync: { stale: true, lastSync: ago(1) } };
  assert.deepEqual(gear('00:31', allYesterday), { chips: 1, label: '설정', keys: [] }, '자정~아침에는 아직 돌 차례가 아니다 — 날짜 칸 하나뿐');
  assert.deepEqual(gear('10:00', allYesterday), { chips: 1, label: '설정 — 자동 갱신 3개 어제 기준', keys: ['slack', 'calendar', 'jira'] }, '셋이 낡아도 머리줄에는 칸이 늘지 않는다');
  assert.equal(gear('10:00', { today, calendar: { stale: true, lastSync: ago(1) }, slackSync: { stale: false, lastSync: today }, jiraSync: { stale: false, lastSync: today } }).label, '설정 — 캘린더 어제 기준');
  assert.equal(gear('08:00', { today, calendar: { stale: false, lastSync: today }, slackSync: { stale: false, lastSync: today }, jiraSync: { stale: true, lastSync: ago(3) } }).label, '설정 — 지라 3일 전 기준', '이틀 넘게 멈춘 것은 아침에도 알린다');
  assert.equal(gear('08:00', { today, calendar: { stale: false, lastSync: today }, jiraSync: { stale: false, lastSync: today }, slackSync: { stale: true, lastSync: ago(1), error: '실패' } }).label, '설정 — 슬랙 캡처 어제 기준', '오류가 있었으면 아침에도 알린다');
  assert.equal(gear('10:00', { today, calendar: { stale: true, lastSync: null }, slackSync: { stale: false, lastSync: today }, jiraSync: { stale: true, lastSync: ago(2) } }).label, '설정 — 자동 갱신 2개 확인 필요');
  assert.equal(gear('10:00', { today, calendar: { stale: false, lastSync: today }, slackSync: { stale: false, lastSync: today }, jiraSync: { stale: false, lastSync: today } }).label, '설정', '다 최신이면 점도 말도 없다(점은 낡은 것이 있을 때만 켜진다)');
});

// ---------- 지라 띠 카드 (BJR 1단계 — 보기만) ----------
// 실제 지라는 부르지 않는다. 화면이 받는 모양(`/api/jira/issue`의 응답)만 가짜로 만들어 쓴다.
const jiraDay = days => {
  const value = new Date();
  value.setDate(value.getDate() + days);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
};
// 가짜 화면에는 innerHTML이 없다 — 붙인 글자를 모아 두는 `html`과 textContent를 함께 훑는다.
function nodeText(node) {
  if (!node || typeof node !== 'object') return '';
  const own = node.children && node.children.length ? '' : String(node.textContent || '');
  return [own, ...(node.children || []).map(nodeText)].filter(Boolean).join(' ');
}
function nodeHtml(node) {
  if (!node || typeof node !== 'object') return '';
  return [node.html || '', ...(node.children || []).map(nodeHtml)].join('');
}
function nodeFind(node, className) {
  if (!node || typeof node !== 'object') return null;
  if (String(node.className || '').split(' ').includes(className)) return node;
  for (const kid of node.children || []) {
    const hit = nodeFind(kid, className);
    if (hit) return hit;
  }
  return null;
}
function nodeFindAll(node, className, found = []) {
  if (!node || typeof node !== 'object') return found;
  if (String(node.className || '').split(' ').includes(className)) found.push(node);
  (node.children || []).forEach(kid => nodeFindAll(kid, className, found));
  return found;
}
const jiraIssue = (extra = {}) => ({
  key: 'IO-48394',
  url: 'https://example-jira.test/browse/IO-48394',
  summary: '게시글 작성하기_게임 임베드',
  type: '에픽',
  status: { name: '진행 중', category: 'doing' },
  assignee: '루본',
  due: '2026-10-02',
  versions: [{ id: '1', name: 'v2.70.0', releaseDate: jiraDay(10), released: false }],
  children: { total: 12, done: 7 },
  ...extra,
});
function jiraClient(handler) {
  const app = pureClient();
  const calls = [];
  app.context.fetch = async (url) => {
    calls.push(String(url));
    return handler(String(url));
  };
  app.run("jiraCard = { key: null, state: 'idle', issue: null, error: '', at: 0, seq: 0 };");
  return { app, calls };
}

test('배포 버전의 말은 배포일이 3일 안이면 주의색, 지났는데 미배포면 급함 색이다', () => {
  const app = pureClient();
  const text = versions => app.run(`jiraVersionText(${JSON.stringify(versions)})`);
  assert.equal(text([]), null, '버전이 없으면 칸이 `없음`이 된다');
  const far = text([{ name: 'v2.70.0', releaseDate: jiraDay(10), released: false }]);
  assert.match(far.note, /배포 예정$/);
  assert.equal(far.tone, '', '먼 배포일에는 색이 없다');
  assert.equal(text([{ name: 'v2.70.0', releaseDate: jiraDay(3), released: false }]).tone, 'k-warn');
  assert.match(text([{ name: 'v2.70.0', releaseDate: jiraDay(3), released: false }]).note, /3일 남음$/);
  assert.equal(text([{ name: 'v2.70.0', releaseDate: jiraDay(0), released: false }]).tone, 'k-warn');
  assert.match(text([{ name: 'v2.70.0', releaseDate: jiraDay(0), released: false }]).note, /오늘 배포 예정/);
  const late = text([{ name: 'v2.70.0', releaseDate: jiraDay(-2), released: false }]);
  assert.equal(late.tone, 'k-neg');
  assert.match(late.note, /2일 지남$/, '색만으로 말하지 않는다 — 글자도 달라진다');
  const shipped = text([{ name: 'v2.70.0', releaseDate: jiraDay(-2), released: true }]);
  assert.equal(shipped.tone, '', '이미 배포된 버전은 급하지 않다');
  assert.match(shipped.note, /배포함$/);
  assert.equal(text([{ name: 'v2.70.0', releaseDate: null, released: false }]).note, '', '날짜가 없으면 이름만 적는다');
  assert.equal(text([{ name: 'v2.70.0', releaseDate: null }, { name: 'v2.71.0' }]).name, 'v2.70.0 외 1개');
  // 상태 색은 범주로만 붙는다(배지가 아니다). 진행은 파란 글자다(BJCOLOR).
  assert.equal(app.run("jiraStatusTone('done')"), 'k-pos');
  assert.equal(app.run("jiraStatusTone('todo')"), 'k-dim');
  assert.equal(app.run("jiraStatusTone('doing')"), 'k-acc');
  assert.equal(app.run("jiraStatusTone(undefined)"), 'k-acc', '모르는 범주도 진행과 같은 색으로 흐른다');
  // 하위 티켓이 하나도 없으면 진행률 줄을 아예 그리지 않는다(`0`은 찍지 않는다).
  assert.equal(app.run('jiraChildrenLabel(null)'), null);
  assert.equal(app.run('jiraChildrenLabel({ total: 0, done: 0 })'), null);
  assert.equal(app.run('jiraChildrenLabel({ total: 12, done: 7 }).text'), '12개 중 7개 완료');
  assert.equal(app.run('jiraChildrenLabel({ total: 12, done: 7 }).ratio'), 58);
});

test('띠 카드는 값이 다 있으면 지라 상태·배포 버전·기한을 적고, 없으면 `없음`을 적는다', () => {
  const app = pureClient();
  const card = app.run(`jiraStripCard(${JSON.stringify(jiraIssue())})`);
  const text = nodeText(card);
  assert.match(text, /지라/);
  assert.match(text, /게시글 작성하기_게임 임베드/);
  assert.match(text, /에픽 · 담당 루본/);
  assert.match(text, /지라 상태 진행 중/);
  assert.match(text, /배포 버전 v2\.70\.0/);
  assert.match(text, /기한 10월 2일/);
  assert.match(text, /하위 티켓 .*12개 중 7개 완료/);
  assert.equal(nodeFind(card, 'v').className, 'v k-acc', '진행 범주는 파란 글자다(BJCOLOR)');
  // 지라에서 온 글자는 전부 textContent로만 들어간다(새 innerHTML을 쓰지 않는다).
  assert.doesNotMatch(nodeHtml(card), /게시글 작성하기|진행 중|v2\.70\.0/);
  // 키는 `지라에서 열기` 링크의 title에만 보인다(BKEY 결정) — 카드 글자에는 없다.
  assert.doesNotMatch(text, /IO-48394/);
  const link = nodeFind(card, 'd-jopen');
  assert.equal(link.getAttribute('href'), undefined);
  assert.equal(link.href, 'https://example-jira.test/browse/IO-48394');
  assert.equal(link.target, '_blank');
  assert.equal(link.rel, 'noopener noreferrer');
  assert.match(link.title, /^IO-48394 · /);

  const bare = app.run(`jiraStripCard(${JSON.stringify(jiraIssue({ assignee: null, due: null, versions: [], children: null, status: { name: '완료', category: 'done' } }))})`);
  const bareText = nodeText(bare);
  assert.match(bareText, /담당 없음/);
  assert.match(bareText, /배포 버전 없음/);
  assert.match(bareText, /기한 없음/);
  assert.doesNotMatch(bareText, /하위 티켓/, '하위가 없으면 진행률 줄이 없다');
  assert.equal(nodeFind(bare, 'v').className, 'v k-pos', '완료 범주는 성공색 글자다');
});

test('띠 카드는 부르는 동안 뼈대를, 연결 안 됨·오류일 때는 조용한 한 줄을 세운다', async () => {
  const { app } = jiraClient(() => new Response(JSON.stringify({ ok: true, connected: true, issue: jiraIssue() })));
  app.run("document.getElementById('jiraStrip').dataset.jiraKey = 'IO-48394'");
  const loading = app.run("jiraCard = { ...jiraCard, key: 'IO-48394', state: 'loading' }; jiraStripBody('IO-48394')");
  assert.equal(loading.className, 'd-jira is-loading');
  assert.equal(loading.getAttribute('aria-hidden'), 'true');
  assert.equal(nodeText(loading), '', '뼈대에는 글자가 없다');

  const off = app.run("jiraCard = { ...jiraCard, state: 'off' }; jiraStripBody('IO-48394')");
  assert.equal(nodeText(off), '지라 연결이 필요해요 · 설정 방법');
  const help = nodeFind(off, 'd-link');
  assert.match(help.title, /README의 "지라 연결 설정" 절/);
  assert.equal(help.href, undefined, '새 창으로 나가는 링크가 아니다');
  help.listeners.click();
  assert.match(app.nodes.get('liveRegion').textContent, /README의 "지라 연결 설정" 절/);

  const failed = app.run("jiraCard = { ...jiraCard, state: 'error', error: '지라 토큰을 확인해 주세요.' }; jiraStripBody('IO-48394')");
  assert.equal(nodeText(failed), '지라 토큰을 확인해 주세요. · 다시 시도');
  await nodeFind(failed, 'd-link').listeners.click();
  assert.equal(app.run('jiraCard.state'), 'ok', '`다시 시도`가 다시 읽어 온다');
  assert.equal(app.run('jiraCard.issue.summary'), '게시글 작성하기_게임 임베드');
});

test('다른 프로젝트로 빨리 옮기면 늦게 온 지라 응답은 버린다', async () => {
  const gates = {};
  const { app, calls } = jiraClient(url => new Promise((resolve) => {
    const key = url.includes('AB-1') ? 'first' : 'second';
    gates[key] = () => resolve(new Response(JSON.stringify({ ok: true, connected: true, issue: jiraIssue({ key, summary: `${key} 요약` }) })));
  }));
  app.run("document.getElementById('jiraStrip').dataset.jiraKey = 'AB-1'");
  const first = app.run("jiraCardLoad('AB-1')");
  app.run("document.getElementById('jiraStrip').dataset.jiraKey = 'AB-2'");
  const second = app.run("jiraCardLoad('AB-2')");
  gates.second();
  await second;
  assert.equal(app.run('jiraCard.key'), 'AB-2');
  gates.first();
  await first;
  assert.equal(app.run('jiraCard.key'), 'AB-2', '늦게 온 첫 응답이 새 화면을 덮지 않는다');
  assert.equal(app.run('jiraCard.issue.summary'), 'second 요약');
  assert.deepEqual(calls.map(url => url.replace(/^.*key=/, '')), ['AB-1', 'AB-2']);

  // 같은 프로젝트를 다시 그리는 것만으로는 다시 부르지 않는다(60초 안).
  app.run("jiraCardEnsure('AB-2')");
  assert.equal(calls.length, 2);
  // 새로고침은 `fresh=1`로 부른다.
  gates.second = null;
  const again = app.run("jiraCardLoad('AB-2', { fresh: true })");
  gates.second();
  await again;
  assert.match(calls[2], /key=AB-2&fresh=1$/);
});

// ---------- 지라 하위 티켓 목록 (BJR 3단계 — 읽기 전용) ----------
// 지키는 것: ① 하위 티켓은 띠 카드 **안**에만 산다. ② 앱에서 바꾸는 길은 없다(누르면 지라가 열린다).
// ③ 펼침은 프로젝트별로 기억하고, 2단계의 쓰기 뒤 `fresh` 재조회로 다시 그려져도 그대로다.
const jiraStatusName = { doing: '진행 중', todo: '할 일', done: '완료' };
const jiraKid = (key, summary, category, assignee, version = null) => ({
  key,
  url: `https://example-jira.test/browse/${key}`,
  summary,
  type: '하위 작업',
  status: { name: jiraStatusName[category], category },
  assignee,
  version,
});
// 미완료는 루본 2 · 엘리 1 · 담당 없음 1, 완료는 1개다.
const jiraKids = () => [
  jiraKid('IO-48391', '임베드 카드 붙이기', 'done', '루본'),
  jiraKid('IO-48392', '게임 목록 불러오기', 'doing', '루본', 'v2.70.0'),
  jiraKid('IO-48393', '미리보기 문구 정리하기', 'todo', '엘리'),
  jiraKid('IO-48395', '검수 항목 정리하기', 'doing', null),
  jiraKid('IO-48396', '오류 문구 다듬기', 'todo', '루본'),
];
const jiraWithKids = (items = jiraKids(), extra = {}) => jiraIssue({
  children: { total: items.length, done: items.filter(item => item.status.category === 'done').length, items },
  ...extra,
});
// 카드를 실제 화면 자리(`#jiraStrip`)에 세운다 — 꺾쇠·이름을 누르면 그 자리가 다시 그려진다.
function jiraKidFixture(issue, projectKey = 'jira:IO-48394', storage = null) {
  const app = pureClient();
  if (storage) app.context.localStorage = storage;
  app.run(`jiraCard = { key: 'IO-48394', state: 'ok', issue: ${JSON.stringify(issue)}, error: '', at: Date.now(), seq: 1 };`);
  const host = app.nodes.get('jiraStrip') || app.run("document.getElementById('jiraStrip')");
  host.dataset.jiraKey = 'IO-48394';
  host.dataset.project = projectKey;
  app.run('jiraStripPaint()');
  return { app, host, card: () => host.children[0] };
}

test('담당별 요약은 미완료만 세고 많은 순·가나다순으로, 넷을 넘으면 `외 N명`으로 줄인다', () => {
  const app = pureClient();
  const summary = items => JSON.parse(app.run(`JSON.stringify(jiraChildSummary(${JSON.stringify(items)}))`));
  const basic = summary(jiraKids());
  assert.deepEqual(basic.names, [{ name: '루본', count: 2 }, { name: '엘리', count: 1 }, { name: '담당 없음', count: 1 }],
    '완료한 루본 것은 세지 않는다. 개수가 같으면 가나다이고 `담당 없음`은 이름이 아니라 맨 뒤다');
  assert.equal(basic.extra, 0);
  assert.equal(basic.allDone, false);

  // 다섯 명이면 넷만 이름으로 적고 나머지는 `외 N명`이다.
  const many = summary(['가나', '나다', '다라', '마바', '사아', '아자'].map((name, at) => jiraKid(`AB-${at + 1}`, '일', 'doing', name)));
  assert.deepEqual(many.names.map(entry => entry.name), ['가나', '나다', '다라', '마바']);
  assert.equal(many.extra, 2);

  const done = summary(jiraKids().map(item => ({ ...item, status: { name: '완료', category: 'done' } })));
  assert.deepEqual(done, { names: [], extra: 0, allDone: true }, '다 끝났으면 이름 자리에 `모두 완료`만 선다');
  assert.equal(summary([]).allDone, true);

  // 순서: 진행 → 할 일 → 완료, 같은 범주 안에서는 지라가 준 차례 그대로다.
  const order = JSON.parse(app.run(`JSON.stringify(jiraChildOrder(${JSON.stringify(jiraKids())}).map(item => item.key))`));
  assert.deepEqual(order, ['IO-48392', 'IO-48395', 'IO-48393', 'IO-48396', 'IO-48391']);
});

test('접힌 줄은 진행률 뒤에 담당별 개수를 적고, 하위가 없으면 줄 자체가 없다', () => {
  const { card } = jiraKidFixture(jiraWithKids());
  const foot = nodeFind(card(), 'foot');
  assert.match(nodeText(foot), /하위 티켓 .*5개 중 1개 완료 .*루본 2 · 엘리 1 · 담당 없음 1/);
  const caret = nodeFind(foot, 'd-jexp');
  assert.equal(caret.getAttribute('aria-expanded'), 'false');
  assert.equal(caret.getAttribute('aria-label'), '하위 티켓 펼치기');
  assert.equal(nodeFind(card(), 'd-jkids'), null, '접혀 있으면 목록이 아예 없다');

  // 다 끝났으면 이름 대신 `모두 완료`다.
  const allDone = jiraKids().map(item => ({ ...item, status: { name: '완료', category: 'done' } }));
  assert.match(nodeText(nodeFind(jiraKidFixture(jiraWithKids(allDone)).card(), 'foot')), /5개 중 5개 완료 모두 완료/);

  // 하위가 하나도 없으면 진행률 줄도 꺾쇠도 없다(`0`은 찍지 않는다).
  const bare = jiraKidFixture(jiraIssue({ children: null }));
  assert.equal(nodeFind(bare.card(), 'foot'), null);
  assert.equal(nodeFind(bare.card(), 'd-jexp'), null);
});

test('펼치면 티켓마다 지라 상태·요약·담당자·배포 버전이 서고, 완료는 맨 아래 흐리게 선다', () => {
  const { app, card } = jiraKidFixture(jiraWithKids());
  nodeFind(card(), 'd-jexp').listeners.click();
  const list = nodeFind(card(), 'd-jkids');
  assert.ok(list, '꺾쇠를 누르면 목록이 선다');
  assert.equal(nodeFind(card(), 'd-jexp').getAttribute('aria-expanded'), 'true');
  const rows = nodeFindAll(list, 'd-jkid');
  assert.deepEqual(rows.map(row => nodeFind(row, 'sm').textContent),
    ['게임 목록 불러오기', '검수 항목 정리하기', '미리보기 문구 정리하기', '오류 문구 다듬기', '임베드 카드 붙이기'],
    '미완료가 먼저(진행 → 할 일)고 완료가 맨 아래다');
  assert.equal(rows[4].className, 'd-jkid is-done');
  assert.equal(rows[0].className, 'd-jkid');
  // 한 줄 = 상태 · 요약 · 담당자 · 배포 버전. 상태는 범주로만 색이다(배지가 아니다).
  assert.equal(nodeText(rows[0]), '진행 중 게임 목록 불러오기 루본 v2.70.0');
  assert.equal(nodeFind(rows[0], 'st').className, 'st k-acc', '진행은 파란 글자다');
  assert.equal(nodeFind(rows[2], 'st').className, 'st k-dim', '할 일은 회색이다');
  assert.equal(nodeFind(rows[4], 'st').className, 'st k-pos', '완료는 성공색 글자다');
  const none = nodeFind(rows[1], 'wh');
  assert.equal(none.textContent, '담당 없음');
  assert.equal(none.className, 'wh is-none');
  assert.equal(nodeFind(rows[1], 'ver'), null, '배포 버전이 없으면 칸 자체가 없다');
  // 링크는 앱이 조립한 주소로 새 탭에 열리고, 키는 title에만 보인다(BKEY).
  const link = nodeFind(rows[0], 'sm');
  assert.equal(link.href, 'https://example-jira.test/browse/IO-48392');
  assert.equal(link.target, '_blank');
  assert.equal(link.rel, 'noopener noreferrer');
  assert.equal(link.title, 'IO-48392 · 지라에서 열어요');
  assert.doesNotMatch(nodeText(list), /IO-483/, '목록 글자 어디에도 키는 없다');
  // 지라가 준 글자는 전부 textContent다 — 목록에 새 innerHTML을 쓰지 않는다(꺾쇠 아이콘만 고정 마크업).
  assert.equal(nodeHtml(list), '');
  // 읽기 전용이다: 목록에는 값 고르개도 ⋯도 없다.
  assert.equal(nodeFind(list, 'd-dpick'), null);
  assert.equal(nodeFind(list, 'd-more'), null);
  assert.doesNotMatch(nodeText(list), /할 일로 가져오기/);

  // 다시 누르면 접힌다.
  nodeFind(card(), 'd-jexp').listeners.click();
  assert.equal(nodeFind(card(), 'd-jkids'), null);
  assert.equal(app.run('jiraChildPick'), null);
});

test('완료가 다섯을 넘으면 나머지는 `완료 N개 더 보기` 뒤로 접는다', () => {
  const items = [
    jiraKid('AB-1', '남은 것', 'doing', '루본'),
    ...Array.from({ length: 8 }, (unused, at) => jiraKid(`AB-${at + 2}`, `끝난 것 ${at + 1}`, 'done', '루본')),
  ];
  const { card } = jiraKidFixture(jiraWithKids(items));
  nodeFind(card(), 'd-jexp').listeners.click();
  assert.equal(nodeFindAll(card(), 'd-jkid').length, 6, '미완료 1 + 완료 5만 선다');
  const more = nodeFind(card(), 'more');
  assert.equal(more.textContent, '완료 3개 더 보기');
  more.listeners.click();
  assert.equal(nodeFindAll(card(), 'd-jkid').length, 9);
  assert.equal(nodeFind(card(), 'more'), null);

  // 다섯 이하면 접지 않는다.
  const few = jiraKidFixture(jiraWithKids());
  nodeFind(few.card(), 'd-jexp').listeners.click();
  assert.equal(nodeFind(few.card(), 'more'), null);
});

test('접힌 줄의 이름을 누르면 펼쳐지며 그 담당 것만 보이고, `전체`로 푼다', () => {
  const { app, card } = jiraKidFixture(jiraWithKids());
  const whoButton = name => nodeFindAll(card(), 'd-jwho').find(button => button.textContent.startsWith(name));
  assert.equal(nodeFind(card(), 'd-jkids'), null);
  whoButton('루본').listeners.click();
  assert.equal(app.run('jiraChildPick'), '루본');
  assert.equal(nodeFind(card(), 'd-jexp').getAttribute('aria-expanded'), 'true', '이름을 누르면 함께 펼쳐진다');
  assert.deepEqual(nodeFindAll(card(), 'd-jkid').map(row => nodeFind(row, 'sm').textContent),
    ['게임 목록 불러오기', '오류 문구 다듬기', '임베드 카드 붙이기'], '그 사람의 완료한 것도 함께 보인다');
  assert.equal(whoButton('루본').getAttribute('aria-pressed'), 'true');
  assert.equal(whoButton('엘리').getAttribute('aria-pressed'), 'false');
  // 거르는 중에만 `전체`가 붙는다.
  const clear = nodeFindAll(card(), 'd-jwho').find(button => button.textContent === '전체');
  assert.ok(clear);
  clear.listeners.click();
  assert.equal(app.run('jiraChildPick'), null);
  assert.equal(nodeFindAll(card(), 'd-jkid').length, 5);
  assert.equal(nodeFindAll(card(), 'd-jwho').find(button => button.textContent === '전체'), undefined);

  // 같은 이름을 다시 누르면 해제된다(펼침은 그대로).
  whoButton('엘리').listeners.click();
  assert.equal(nodeFindAll(card(), 'd-jkid').length, 1);
  whoButton('엘리').listeners.click();
  assert.equal(app.run('jiraChildPick'), null);
  assert.equal(nodeFindAll(card(), 'd-jkid').length, 5);

  // 거르는 중에 그 사람의 티켓이 사라지면 조용한 한 줄만 남는다(빈 칸을 남기지 않는다).
  whoButton('엘리').listeners.click();
  app.run(`jiraCard = { ...jiraCard, issue: ${JSON.stringify(jiraWithKids(jiraKids().filter(item => item.assignee !== '엘리')))} }; jiraStripPaint()`);
  assert.equal(nodeText(nodeFind(card(), 'd-jkids')), '이 담당의 하위 티켓이 없어요');
});

test('펼침은 프로젝트별로 기억하고, 쓰기 뒤 `fresh` 재조회로 다시 그려도 그대로다', () => {
  const store = new Map();
  const storage = { getItem: key => (store.has(key) ? store.get(key) : null), setItem: (key, value) => store.set(key, String(value)) };
  const first = jiraKidFixture(jiraWithKids(), 'jira:IO-48394', storage);
  nodeFind(first.card(), 'd-jexp').listeners.click();
  assert.deepEqual(JSON.parse(store.get('jiraChildrenOpen')), ['jira:IO-48394']);

  // 2단계의 쓰기가 끝나고 `fresh=1`로 다시 읽어 그려도 펼침·거르기는 그대로다.
  first.app.run("jiraChildPick = '루본'");
  first.app.run(`jiraCard = { ...jiraCard, issue: ${JSON.stringify(jiraWithKids())}, at: Date.now() }; jiraStripPaint()`);
  assert.equal(nodeFind(first.card(), 'd-jexp').getAttribute('aria-expanded'), 'true');
  assert.equal(nodeFindAll(first.card(), 'd-jkid').length, 3, '거르기도 살아 있다');
  // 같은 프로젝트를 다시 그리는 것(jiraCardEnsure)으로는 거르기가 풀리지 않는다.
  first.app.run("jiraCardEnsure('IO-48394')");
  assert.equal(first.app.run('jiraChildPick'), '루본');
  // 다른 프로젝트로 옮기면 거르기만 풀린다(펼침은 프로젝트마다 기억한 대로다).
  first.app.run("jiraCardEnsure('AB-9')");
  assert.equal(first.app.run('jiraChildPick'), null);

  // 다음에 같은 프로젝트를 열면 기억한 대로 펼쳐져 있다.
  const again = jiraKidFixture(jiraWithKids(), 'jira:IO-48394', storage);
  assert.equal(nodeFind(again.card(), 'd-jexp').getAttribute('aria-expanded'), 'true');
  assert.equal(nodeFindAll(again.card(), 'd-jkid').length, 5);
  // 다른 프로젝트는 기억이 따로다.
  const other = jiraKidFixture(jiraWithKids(), 'group:알림센터', storage);
  assert.equal(nodeFind(other.card(), 'd-jexp').getAttribute('aria-expanded'), 'false');
  // 손으로 건 그룹 프로젝트에서도 카드 모양은 같다.
  nodeFind(other.card(), 'd-jexp').listeners.click();
  assert.equal(nodeFindAll(other.card(), 'd-jkid').length, 5);
  assert.deepEqual(JSON.parse(store.get('jiraChildrenOpen')), ['jira:IO-48394', 'group:알림센터']);
});

test('기억해 둘 곳이 막혀 있어도 펼치기는 그대로 동작한다', () => {
  // 사생활 보호 창처럼 localStorage가 던지는 자리 — 기억만 못 할 뿐 화면은 그대로다.
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  const { card } = jiraKidFixture(jiraWithKids(), 'jira:IO-48394', blocked);
  nodeFind(card(), 'd-jexp').listeners.click();
  assert.equal(nodeFindAll(card(), 'd-jkid').length, 5);
});

test('하위가 100개면 목록 끝에 `지라에서 전체 보기`가 붙는다', () => {
  const items = Array.from({ length: 100 }, (unused, at) => jiraKid(`AB-${at + 1}`, `하위 ${at + 1}`, 'doing', '루본'));
  const { card } = jiraKidFixture(jiraWithKids(items));
  nodeFind(card(), 'd-jexp').listeners.click();
  const all = nodeFind(card(), 'all');
  assert.equal(all.textContent, '지라에서 전체 보기 ↗');
  assert.equal(all.href, 'https://example-jira.test/browse/IO-48394');
  assert.equal(all.rel, 'noopener noreferrer');
  assert.equal(all.target, '_blank');
  assert.match(all.title, /^IO-48394 · /);
  // 100개가 안 되면 붙지 않는다.
  const few = jiraKidFixture(jiraWithKids());
  nodeFind(few.card(), 'd-jexp').listeners.click();
  assert.equal(nodeFind(few.card(), 'all'), null);
});

// 로드 직후 아주 빨리 누른 탭이 마지막 탭 복원에 덮이던 경쟁(크롬 검수에서 발견).
test('마지막 탭 복원은 사람이 이미 탭을 골랐으면 하지 않는다', () => {
  const app = pureClient();
  assert.equal(app.run("tabToRestore('weekly', false, null)"), 'weekly');
  assert.equal(app.run("tabToRestore(null, false, null)"), 'today', '기억해 둔 탭이 없으면 오늘 탭이다');
  assert.equal(app.run("tabToRestore('weekly', true, null)"), null, '이미 누른 탭이 있으면 복원하지 않는다');
  assert.equal(app.run("tabToRestore('weekly', false, 'projects')"), 'projects', '앱이 켜지기 전에 누른 탭(초점이 남은 탭)을 따른다');
  assert.equal(app.run("tabToRestore('weekly', true, 'projects')"), null);
});

// ---------- 지라 바꾸기 (BJR 2단계) ----------
// 여기서 지키는 것은 하나다: **확인 줄의 `바꾸기`를 누르기 전에는 어떤 POST도 나가지 않는다.**
// 가짜 fetch가 method까지 기록하므로 "나갔는가"를 글자가 아니라 기록으로 판정한다.
const jiraOptionsPayload = {
  ok: true,
  connected: true,
  transitions: [
    { id: '11', name: '진행 중', category: 'doing', requiresInput: false },
    { id: '21', name: '완료', category: 'done', requiresInput: false },
    { id: '41', name: '보류', category: 'todo', requiresInput: true },
  ],
  // 지금 티켓에 걸린 버전(id `1`)과 아직 배포되지 않은 다른 버전 하나.
  versions: [
    { id: '1', name: 'v2.70.0', releaseDate: '2026-09-30' },
    { id: '10102', name: 'v2.71.0', releaseDate: null },
  ],
};
// vm 안에서 만든 값은 바깥 realm의 값과 reference-equal이 아니다 — 견줄 때는 평범한 값으로 옮긴다.
const plain = value => JSON.parse(JSON.stringify(value));
function jiraChangeClient({ change = () => ({ ok: true }), issue = jiraIssue() } = {}) {
  const app = pureClient();
  const calls = [];
  app.context.fetch = async (url, options) => {
    const method = (options && options.method) || 'GET';
    calls.push({ url: String(url), method, body: options && options.body ? JSON.parse(options.body) : null });
    if (String(url).includes('/api/jira/options')) return new Response(JSON.stringify(jiraOptionsPayload));
    if (String(url).includes('/api/jira/change')) {
      const answer = await change();
      return answer instanceof Response ? answer : new Response(JSON.stringify(answer));
    }
    return new Response(JSON.stringify({ ok: true, connected: true, issue }));
  };
  app.run(`jiraCard = { key: '${issue.key}', state: 'ok', issue: ${JSON.stringify(issue)}, error: '', at: Date.now(), seq: 1 };`);
  app.run("jiraOptions = { key: null, at: 0, transitions: [], versions: [] }; jiraBusy = false; jiraConfirm = null;");
  app.run(`document.getElementById('jiraStrip').dataset.jiraKey = '${issue.key}'`);
  // 가짜 창에는 document.body도 화면 좌표도 없다 — 메뉴는 열지 않고 "무엇을 열려 했는지"만 붙잡는다.
  app.run("lastMenu = null; uiMenu = (anchor, sections) => { lastMenu = sections; return null; };");
  const posts = () => calls.filter(call => call.method === 'POST');
  const card = () => app.nodes.get('jiraStrip').children[0];
  return { app, calls, posts, card, confirm: () => nodeFind(card(), 'd-jconfirm') };
}
const jiraMenuItems = sections => sections.flat().filter(entry => entry && entry.label);

test('지라 값을 골라도 확인 줄을 거치기 전에는 아무것도 보내지 않는다', async () => {
  const fixture = jiraChangeClient();
  const sections = await fixture.app.run('jiraStatusSections(jiraCard.issue)');
  // 선택지는 지라가 허용한 전환뿐이고, 읽는 데 GET 하나만 나갔다.
  assert.deepEqual(plain(jiraMenuItems(sections).map(entry => entry.label)), ['진행 중', '완료', '보류']);
  // 선택지 글씨도 카드 값과 같은 범주 색이다(BJCOLOR) — 진행 파랑 · 완료 초록 · 할 일 회색.
  assert.deepEqual(plain(jiraMenuItems(sections).map(entry => entry.tone)), ['k-acc', 'k-pos', 'k-dim']);
  assert.equal(fixture.calls.length, 1);
  assert.match(fixture.calls[0].url, /\/api\/jira\/options\?key=IO-48394$/);
  assert.equal(fixture.calls[0].method, 'GET');

  jiraMenuItems(sections)[1].onClick();
  assert.equal(fixture.posts().length, 0, '값을 고른 것만으로는 지라에 쓰지 않는다');
  const row = fixture.confirm();
  assert.ok(row, '카드 안에 확인 줄이 선다');
  const text = nodeText(row);
  assert.match(text, /지라의 이 티켓을 바꿀까요\?/);
  assert.match(text, /게시글 작성하기_게임 임베드/, '확인 창에는 티켓 요약을 쓴다');
  assert.match(text, /IO-48394/, '키는 조용한 글자로만 붙는다');
  assert.match(text, /지라 상태: 진행 중 → 완료/, '전 → 후를 보여 준다');
  assert.match(text, /취소 바꾸기/);
  assert.equal(nodeFind(row, 'ky').textContent, 'IO-48394');

  // 확인 줄이 떠 있는 채로 다른 고르개를 열면 확인 줄이 먼저 닫힌다(보내지 않는다).
  fixture.app.context.duePick = nodeFind(fixture.card(), 'cells').children[2].children[1];
  await fixture.app.run('jiraPickOpen(duePick, () => jiraDueSections(jiraCard.issue))');
  assert.equal(fixture.app.run('jiraConfirm'), null);
  assert.equal(fixture.confirm(), null);
  assert.equal(fixture.posts().length, 0);

  // `취소`는 아무것도 보내지 않고 줄만 닫는다.
  jiraMenuItems(sections)[1].onClick();
  nodeFind(fixture.confirm(), 'acts').children[0].listeners.click();
  assert.equal(fixture.app.run('jiraConfirm'), null);
  assert.equal(fixture.posts().length, 0);
  assert.equal(fixture.confirm(), null);
});

test('확인 줄의 `바꾸기`만 지라에 쓰고, 성공하면 fresh=1로 다시 읽는다 (⌘Z 대상이 아니다)', async () => {
  const fixture = jiraChangeClient();
  const sections = await fixture.app.run('jiraStatusSections(jiraCard.issue)');
  jiraMenuItems(sections)[1].onClick();
  await nodeFind(fixture.confirm(), 'acts').children[1].listeners.click();

  const posts = fixture.posts();
  assert.equal(posts.length, 1, '쓰기는 정확히 한 번이다');
  assert.match(posts[0].url, /\/api\/jira\/change$/);
  assert.deepEqual(plain(posts[0].body), { key: 'IO-48394', kind: 'status', transitionId: '21' });
  // 낙관적 갱신 금지 — 성공한 뒤 지라에서 새로 읽어 그 값만 그린다.
  assert.match(fixture.calls[fixture.calls.length - 1].url, /\/api\/jira\/issue\?key=IO-48394&fresh=1$/);
  // 앱의 ⌘Z 대상이 아니다.
  assert.equal(fixture.app.run('undoStack.length'), 0);
  assert.equal(fixture.app.run('redoStack.length'), 0);
  assert.equal(fixture.app.run('lastUndoRecordedAt'), 0);
  // 성공 알림에는 `지라에서 열기`가 붙는다.
  const region = fixture.app.nodes.get('liveRegion');
  assert.match(region.textContent, /지라에서 바꿨어요/);
  assert.ok(region.children.some(kid => kid.textContent === '지라에서 열기'));
  assert.equal(fixture.app.run('jiraConfirm'), null);
  assert.equal(fixture.app.run('jiraBusy'), false);
  // 선택지도 함께 버린다 — 다음에 고르개를 열면 지라에서 새로 읽는다.
  assert.equal(fixture.app.run('jiraOptions.key'), null);
});

test('지라가 거절하면 아무것도 바꾸지 않고 해요체 문구만 알린다', async () => {
  const fixture = jiraChangeClient({ change: () => ({ ok: false, error: '지라에서 이 티켓을 바꿀 권한이 없어요.', kind: 'forbidden' }) });
  const sections = await fixture.app.run('jiraDueSections(jiraCard.issue)');
  const dateField = sections[0][0].control;
  dateField.children[1].listeners.click(); // ✕ 로 기한 지우기
  const row = fixture.confirm();
  assert.match(nodeText(row), /지라의 기한: 10월 2일 → 없음/);
  await nodeFind(row, 'acts').children[1].listeners.click();
  assert.equal(fixture.posts().length, 1);
  assert.deepEqual(plain(fixture.posts()[0].body), { key: 'IO-48394', kind: 'due', due: null });
  const region = fixture.app.nodes.get('liveRegion');
  assert.equal(region.textContent, '지라에서 이 티켓을 바꿀 권한이 없어요.');
  assert.equal(fixture.app.run('jiraConfirm'), null);
  assert.equal(fixture.app.run('jiraBusy'), false);
  // 실패했으니 다시 읽지 않는다 — 화면의 값은 그대로다.
  assert.equal(fixture.calls.filter(call => call.url.includes('fresh=1')).length, 0);
  assert.equal(fixture.app.run('jiraCard.issue.due'), '2026-10-02');
});

test('지라에 쓰는 동안에는 세 고르개가 모두 잠긴다', async () => {
  let release;
  const fixture = jiraChangeClient({ change: () => new Promise((resolve) => { release = () => resolve({ ok: true }); }) });
  const sections = await fixture.app.run('jiraStatusSections(jiraCard.issue)');
  jiraMenuItems(sections)[1].onClick();
  const sending = nodeFind(fixture.confirm(), 'acts').children[1].listeners.click();
  assert.equal(fixture.app.run('jiraBusy'), true);
  const locked = fixture.app.run('jiraStripCard(jiraCard.issue)');
  const picks = nodeFind(locked, 'cells').children.map(cell => nodeFind(cell, 'd-dpick'));
  assert.equal(picks.length, 3);
  assert.deepEqual(plain(picks.map(pick => pick.disabled)), [true, true, true]);
  assert.equal(nodeFind(locked, 'd-jref').disabled, true, '새로고침도 함께 잠긴다');
  // 쓰는 중에는 고르개를 눌러도 메뉴가 열리지 않는다(같은 카드에서 두 개를 동시에 쓰지 않는다).
  await fixture.app.run('jiraPickOpen({ disabled: false, isConnected: true }, () => { throw new Error("열리면 안 된다"); })');
  release();
  await sending;
  assert.equal(fixture.app.run('jiraBusy'), false);
  assert.equal(fixture.posts().length, 1);
});

test('Esc는 확인 줄을 아무것도 보내지 않고 닫는다', async () => {
  const fixture = jiraChangeClient();
  const before = fixture.app.run('escStack.length');
  const sections = await fixture.app.run('jiraStatusSections(jiraCard.issue)');
  jiraMenuItems(sections)[0].onClick();
  assert.equal(fixture.app.run('escStack.length'), before + 1);
  fixture.app.run('escStack[escStack.length - 1]()');
  assert.equal(fixture.app.run('jiraConfirm'), null);
  assert.equal(fixture.app.run('escStack.length'), before);
  assert.equal(fixture.posts().length, 0);
  assert.equal(fixture.confirm(), null);
});

test('추가 입력이 필요한 전환은 쓰지 않고 지라에서 직접 하게 안내한다', async () => {
  const fixture = jiraChangeClient();
  const sections = await fixture.app.run('jiraStatusSections(jiraCard.issue)');
  jiraMenuItems(sections)[2].onClick();
  assert.equal(fixture.app.run('jiraConfirm'), null, '확인 줄조차 열지 않는다');
  assert.equal(fixture.posts().length, 0);
  const region = fixture.app.nodes.get('liveRegion');
  assert.equal(region.textContent, '이 전환은 지라에서 직접 해 주세요');
  assert.ok(region.children.some(kid => kid.textContent === '지라에서 열기'));
});

// 비활성 항목(고를 수 있는 전환이 없을 때의 안내 문구)에는 범주 색을 붙이지 않는다 —
// 색 규칙과 겹치면 비활성 표현이 이긴다는 규칙을 데이터 쪽에서 지킨다(BJCOLOR).
test('고를 수 있는 지라 상태가 없으면 안내 문구만 비활성으로 서고, 범주 색이 붙지 않는다', async () => {
  const fixture = jiraChangeClient();
  fixture.app.context.fetch = async (url) => (String(url).includes('/api/jira/options')
    ? new Response(JSON.stringify({ ok: true, connected: true, transitions: [], versions: [] }))
    : new Response(JSON.stringify({ ok: true, connected: true, issue: jiraIssue() })));
  const sections = await fixture.app.run('jiraStatusSections(jiraCard.issue)');
  const items = sections.flat();
  assert.equal(items.length, 1);
  assert.equal(items[0].label, '지라에서 바꿀 수 있는 상태가 없어요');
  assert.equal(items[0].disabled, true);
  assert.equal(items[0].tone, undefined);
});

test('배포 버전 메뉴는 옮기기와 버전 고치기 둘이고, 여러 버전이 걸린 티켓은 안내만 한다', async () => {
  const fixture = jiraChangeClient();
  const [move, edit] = await fixture.app.run('jiraVersionSections(jiraCard.issue)');
  assert.equal(move[0].field, '이 티켓을 다른 버전으로');
  // 지금 걸린 버전(v2.70.0)은 빠지고, 남은 미배포 버전과 `버전 없음`만 선다.
  assert.deepEqual(plain(move.filter(entry => entry.label).map(entry => entry.label)), ['v2.71.0', '버전 없음']);
  move.filter(entry => entry.label)[0].onClick();
  assert.equal(fixture.posts().length, 0);
  assert.match(nodeText(fixture.confirm()), /지라의 배포 버전: v2\.70\.0 → v2\.71\.0/);
  fixture.app.run('jiraConfirmClose()');

  // 버전 자체를 고치면 그 버전을 쓰는 모든 티켓에 적용된다 — 확인 문구가 그렇게 말한다.
  assert.equal(edit[0].field, '이 버전 고치기');
  const name = edit[1].control;
  name.value = 'v2.70.1';
  await name.listeners.change();
  const row = fixture.confirm();
  assert.match(nodeText(row), /이 버전의 이름: v2\.70\.0 → v2\.70\.1/);
  assert.match(nodeText(row), /이 버전을 쓰는 모든 티켓에 적용돼요/);
  assert.deepEqual(plain(fixture.app.run('jiraConfirm.body')),
    { key: 'IO-48394', kind: 'versionEdit', versionId: '1', name: 'v2.70.1' });
  assert.equal(fixture.posts().length, 0);

  // 버전이 여러 개면 옮기기 선택지 자체를 내놓지 않는다.
  const many = jiraChangeClient({
    issue: jiraIssue({ versions: [{ id: '1', name: 'v2.70.0', releaseDate: null, released: false }, { id: '2', name: 'v2.71.0', releaseDate: null, released: false }] }),
  });
  const sections = await many.app.run('jiraVersionSections(jiraCard.issue)');
  assert.equal(sections.length, 1, '여러 버전이면 `이 버전 고치기`도 없다');
  const labels = sections[0].filter(entry => entry.label);
  assert.deepEqual(plain(labels.map(entry => entry.label)), ['버전이 여러 개라 지라에서 직접 바꿔 주세요', '지라에서 열기']);
  assert.equal(labels[0].disabled, true);
});

test('배포일을 고치는 길도 확인 줄을 거치고, 지우기까지 된다', async () => {
  const fixture = jiraChangeClient();
  const [, edit] = await fixture.app.run('jiraVersionSections(jiraCard.issue)');
  const dateField = edit[2].control;
  dateField.children[0].value = '2026-10-07';
  dateField.children[0].listeners.change();
  assert.equal(fixture.posts().length, 0);
  assert.deepEqual(plain(fixture.app.run('jiraConfirm.body')),
    { key: 'IO-48394', kind: 'versionEdit', versionId: '1', releaseDate: '2026-10-07' });
  assert.match(nodeText(fixture.confirm()), /이 버전을 쓰는 모든 티켓에 적용돼요/);
});

// ---------- 직접 만든(그룹) 프로젝트에 지라 티켓 연결 (BJLINK) ----------
// 실제 지라는 부르지 않는다. 화면이 받는 모양(`/api/jira/issue`의 응답, `/api/items`의 `workflows`)만 가짜로 만든다.
function jiraLinkClient({ issue = jiraIssue(), links = {}, connected = true, answer = null } = {}) {
  const app = workflowsClient();
  const calls = [];
  app.context.fetch = async (url, options) => {
    const method = (options && options.method) || 'GET';
    calls.push({ url: String(url), method, body: options && options.body ? JSON.parse(options.body) : null });
    if (String(url).includes('/api/project/jira-link')) return new Response(JSON.stringify(answer || { ok: true }));
    // 가짜 지라는 물어본 키를 그대로 돌려준다(어느 티켓을 미리 보는지가 드러나게).
    const asked = (String(url).match(/key=([^&]+)/) || [, ''])[1];
    return new Response(JSON.stringify(connected ? { ok: true, connected: true, issue: { ...issue, key: decodeURIComponent(asked) || issue.key } } : { ok: true, connected: false }));
  };
  app.run(`latestData = { jiraSync: { used: true, connected: ${connected}, siteUrl: 'https://example-jira.test' } };`);
  app.run(`workflowData = { items: [], meetings: [], projectLinks: ${JSON.stringify(links)} }; wfIndexData(); itemsById = new Map();`);
  app.run(`jiraIssuesCache = [
    { key: 'IO-12345', summary: '게시글 작성하기_게임 임베드' },
    { key: 'PAY-77', summary: '정산 배치' },
    { key: 'ZZ-9', summary: '이미 끝난 것', extra: true },
  ]; jiraIssuesByKey = new Map(jiraIssuesCache.map(one => [one.key, one]));`);
  app.run("jiraLink = { project: null, state: 'idle', query: '', error: '', issue: null, busy: false, onEsc: null };");
  app.run("jiraCard = { key: null, state: 'idle', issue: null, error: '', at: 0, seq: 0 };");
  app.run("lastMenu = null; uiMenu = (anchor, sections) => { lastMenu = sections; return null; };");
  const posts = () => calls.filter(call => call.method === 'POST');
  const row = () => app.nodes.get('jiraLinkRow');
  const open = (projectKey) => { app.run(`document.getElementById('jiraLinkRow').dataset.project = '${projectKey}'`); app.run(`jiraLinkOpen('${projectKey}')`); };
  return { app, calls, posts, row, open, node: () => row().children[0] };
}
// 오른쪽 면에 선 자리 하나를 dataset으로 찾는다(가짜 창에는 id로 찾는 길이 없다).
const detailHost = (body, want) => (body.children || []).find(kid => kid && kid.dataset && kid.dataset[want] !== undefined) || null;

test('BJLINK: 지라 키는 한 함수에서 나오고, 연결 줄은 아직 걸지 않은 그룹 프로젝트에만 선다', () => {
  const { app } = jiraLinkClient({ links: { 운영툴: 'IO-12345' } });
  assert.equal(app.run("jiraKeyOf('jira:AB-1')"), 'AB-1');
  assert.equal(app.run("jiraKeyOf('group:운영툴')"), 'IO-12345', '손으로 건 그룹도 같은 함수에서 키가 나온다');
  assert.equal(app.run("jiraKeyOf('group:가입 개선')"), '', '걸지 않은 그룹에는 키가 없다');
  assert.equal(app.run("jiraKeyOf('__misc__')"), '');
  const detail = (key, open = 2) => app.run(`(() => {
    const body = document.createElement('div');
    renderProjectDetail(body, { key: ${JSON.stringify(key)}, label: ${JSON.stringify(key)}, open: ${open} });
    return body;
  })()`);

  const plainGroup = detail('group:가입 개선');
  assert.equal(detailHost(plainGroup, 'jiraKey'), null, '걸지 않은 그룹에는 띠 카드 자리가 없다');
  assert.equal(detailHost(plainGroup, 'project').dataset.project, 'group:가입 개선');
  assert.equal(plainGroup.children[1].textContent, '열린 항목 2', '키가 없으니 조용한 줄도 그대로다');

  const linkedGroup = detail('group:운영툴', 3);
  assert.equal(detailHost(linkedGroup, 'jiraKey').dataset.jiraKey, 'IO-12345', '걸린 그룹에는 같은 띠 카드가 선다');
  assert.equal(detailHost(linkedGroup, 'jiraKey').dataset.project, 'group:운영툴');
  assert.equal(linkedGroup.children[0].textContent, '운영툴', '큰 제목은 프로젝트 이름 그대로다');
  assert.equal(linkedGroup.children[1].textContent, '열린 항목 3 · IO-12345', '키는 그 아래 조용한 줄에만 붙는다(BKEY)');

  const jiraProject = detail('jira:AB-1');
  assert.equal(detailHost(jiraProject, 'jiraKey').dataset.jiraKey, 'AB-1');
  assert.equal(detailHost(jiraProject, 'jiraKey').dataset.project, 'jira:AB-1');

  assert.equal(detailHost(detail('__misc__'), 'project'), null, '`프로젝트 없음`에는 연결 줄이 없다');
  app.run("latestData = { jiraSync: { used: false } };");
  const off = detail('group:가입 개선');
  assert.equal(detailHost(off, 'project'), null, '지라를 쓰지 않도록 설정했으면 아무것도 없다');
});

test('BJLINK: 지라 설정이 없으면 연결 줄 대신 `지라 연결이 필요해요`가 선다', () => {
  const { app } = jiraLinkClient({ connected: false });
  const node = app.run("jiraLinkNode('group:가입 개선')");
  assert.equal(nodeText(node), '지라 연결이 필요해요 · 설정 방법');
  const ready = jiraLinkClient().app.run("jiraLinkNode('group:가입 개선')");
  assert.equal(nodeText(ready), '지라 티켓 연결');
  assert.equal(nodeFind(ready, 'd-jlinkgo').className, 'd-link d-jlinkgo', '조용한 글자 버튼 한 개뿐이다');
});

test('BJLINK: 번호도 주소도 받고, 다른 지라의 주소는 받지 않는다', () => {
  const { app } = jiraLinkClient();
  const parse = value => JSON.parse(app.run(`JSON.stringify(jiraKeyFromInput(${JSON.stringify(value)}, 'https://example-jira.test'))`));
  assert.deepEqual(parse('IO-12345'), { key: 'IO-12345' });
  assert.deepEqual(parse('  io-12345 '), { key: 'IO-12345' }, '소문자로 적어도 받는다');
  assert.deepEqual(parse('https://example-jira.test/browse/IO-12345'), { key: 'IO-12345' });
  assert.deepEqual(parse('https://example-jira.test/issues/io-12345'), { key: 'IO-12345' });
  assert.deepEqual(parse('https://EXAMPLE-JIRA.test/browse/IO-12345?atlOrigin=x'), { key: 'IO-12345' });
  assert.deepEqual(parse('https://example-jira.test/jira/software/projects/IO/boards/3?selectedIssue=IO-12345'), { key: 'IO-12345' });
  assert.deepEqual(parse('https://other-jira.test/browse/IO-12345'), { error: '설정한 지라의 주소가 아니에요.' });
  assert.deepEqual(parse('https://example-jira.test/browse/'), { error: '주소에서 지라 번호를 찾지 못했어요.' });
  assert.deepEqual(parse('그냥 글자'), { error: '지라 번호를 확인해 주세요.' });
  assert.deepEqual(parse('   '), { error: '지라 번호나 주소를 적어 주세요.' });
});

test('BJLINK: 미리 보기를 거치기 전에는 `연결` 요청이 나가지 않는다', async () => {
  const fixture = jiraLinkClient();
  fixture.open('group:가입 개선');
  const input = nodeFind(fixture.node(), 'in');
  assert.equal(input.placeholder, '지라 번호나 주소 — 예: IO-12345');
  // 한글을 조합하는 중의 Enter는 찾지 않는다.
  input.value = 'IO-12345';
  await input.listeners.keydown({ key: 'Enter', isComposing: true });
  assert.equal(fixture.calls.length, 0);
  // 미리 보기 없이 연결을 시키려 해도 아무것도 나가지 않는다.
  await fixture.app.run("jiraLinkConnect('group:가입 개선', { key: 'IO-12345' }, { }, { })");
  assert.equal(fixture.posts().length, 0);

  await input.listeners.keydown({ key: 'Enter', isComposing: false });
  assert.equal(fixture.calls.length, 1);
  assert.match(fixture.calls[0].url, /\/api\/jira\/issue\?key=IO-12345$/);
  assert.equal(fixture.calls[0].method, 'GET', '찾기는 읽기만 한다');
  assert.equal(fixture.app.run('jiraLink.state'), 'preview');
  const preview = fixture.node();
  assert.match(nodeText(preview), /게시글 작성하기_게임 임베드/);
  assert.match(nodeText(preview), /진행 중 · 담당 루본/);
  assert.equal(nodeFind(preview, 'ky').textContent, 'IO-12345', '키는 조용한 글자로만 선다');
  assert.equal(fixture.posts().length, 0, '미리 보기까지는 저장이 없다');
  // 지라가 준 글자는 전부 textContent로만 들어간다(새 innerHTML을 쓰지 않는다).
  assert.doesNotMatch(nodeHtml(preview), /게시글 작성하기|진행 중/);

  const connect = (preview.children.find(kid => kid.className === 'acts').children || []).find(kid => kid.textContent === '연결');
  await connect.listeners.click();
  assert.deepEqual(fixture.posts().map(call => [call.url, call.body]), [
    ['/api/project/jira-link', { project: 'group:가입 개선', jira: 'IO-12345' }],
  ]);
  assert.equal(fixture.app.run('jiraLink.state'), 'idle');
  assert.match(fixture.app.nodes.get('liveRegion').textContent, /지라 티켓을 연결했어요/);
});

test('BJLINK: 못 찾으면 그 자리에 조용한 오류가 뜨고 적은 글자는 남는다', async () => {
  const fixture = jiraLinkClient();
  fixture.app.context.fetch = async () => new Response(JSON.stringify({ ok: false, error: '지라에서 이 티켓을 찾지 못했어요.', kind: 'notfound' }));
  fixture.open('group:가입 개선');
  await fixture.app.run("jiraLinkFind('group:가입 개선', 'IO-99999')");
  assert.equal(fixture.app.run('jiraLink.state'), 'input');
  assert.equal(nodeFind(fixture.node(), 'er').textContent, '지라에서 이 티켓을 찾지 못했어요.');
  assert.equal(nodeFind(fixture.node(), 'in').value, 'IO-99999', '적은 글자는 그대로 남는다');
  // 다른 지라 주소는 서버에 묻지도 않는다.
  await fixture.app.run("jiraLinkFind('group:가입 개선', 'https://other-jira.test/browse/IO-1')");
  assert.equal(nodeFind(fixture.node(), 'er').textContent, '설정한 지라의 주소가 아니에요.');
});

test('BJLINK: 내 담당 티켓 선택지는 `요약 · 키`로 최대 여덟 개, `그 밖의 이슈`는 빼고 입력으로 걸러진다', () => {
  const { app } = jiraLinkClient();
  assert.deepEqual(JSON.parse(app.run("JSON.stringify(jiraLinkSuggestions('').map(one => one.key))")), ['IO-12345', 'PAY-77']);
  assert.deepEqual(JSON.parse(app.run("JSON.stringify(jiraLinkSuggestions('정산').map(one => one.key))")), ['PAY-77']);
  assert.deepEqual(JSON.parse(app.run("JSON.stringify(jiraLinkSuggestions('io-12').map(one => one.key))")), ['IO-12345']);
  app.run("document.getElementById('jiraLinkRow').dataset.project = 'group:가입 개선'; jiraLinkOpen('group:가입 개선')");
  const picks = nodeFind(app.nodes.get('jiraLinkRow').children[0], 'opts');
  // 목록 끝에는 아직 누르지 않은 `완료한 티켓도 보기`가 조용한 글자로 붙어 있다(BARCHIVE).
  assert.deepEqual(picks.children.map(kid => kid.textContent),
    ['내 담당 티켓', '게시글 작성하기_게임 임베드 · IO-12345', '정산 배치 · PAY-77', '완료한 티켓도 보기']);
});

test('BJLINK: 이미 다른 프로젝트에 걸린 티켓도 막지 않고 조용히 알리기만 한다', async () => {
  const fixture = jiraLinkClient({ links: { 운영툴: 'IO-48394' } });
  fixture.open('group:가입 개선');
  await fixture.app.run("jiraLinkFind('group:가입 개선', 'IO-48394')");
  assert.match(nodeText(fixture.node()), /다른 프로젝트 '운영툴'에도 연결돼 있어요/);
  const acts = fixture.node().children.find(kid => kid.className === 'acts');
  assert.deepEqual(acts.children.map(kid => kid.textContent), ['취소', '연결'], '막지 않는다 — `연결`이 그대로 있다');
});

test('BJLINK: 띠 카드의 ⋯은 손으로 건 그룹 프로젝트에만 있고, 해제는 알림의 `되돌리기`로 되돌린다', async () => {
  const fixture = jiraLinkClient({ links: { 운영툴: 'IO-48394' } });
  const bare = fixture.app.run(`jiraStripCard(${JSON.stringify(jiraIssue())})`);
  assert.equal(nodeFind(bare, 'd-more'), null, '예전처럼 부르면 ⋯이 없다');
  const jiraProject = fixture.app.run(`jiraStripCard(${JSON.stringify(jiraIssue())}, 'jira:IO-48394')`);
  assert.equal(nodeFind(jiraProject, 'd-more'), null, '`jira:KEY` 프로젝트에는 풀 연결이 없다');

  const card = fixture.app.run(`jiraStripCard(${JSON.stringify(jiraIssue())}, 'group:운영툴')`);
  const more = nodeFind(card, 'd-more');
  assert.equal(more.getAttribute('aria-label'), '지라 연결 — 더 보기');
  more.listeners.click({ stopPropagation() {} });
  const menu = JSON.parse(fixture.app.run("JSON.stringify(lastMenu.flat().map(one => one.label))"));
  assert.deepEqual(menu, ['지라 연결 해제']);

  await fixture.app.run("lastMenu[0][0].onClick()");
  assert.deepEqual(fixture.posts().map(call => call.body), [{ project: 'group:운영툴', jira: null }]);
  const notice = fixture.app.nodes.get('liveRegion');
  assert.match(notice.textContent, /지라 연결을 해제했어요/);
  const undo = notice.children.find(kid => kid.textContent === '되돌리기');
  await undo.listeners.click();
  assert.deepEqual(fixture.posts().map(call => call.body), [
    { project: 'group:운영툴', jira: null },
    { project: 'group:운영툴', jira: 'IO-48394' },
  ], '되돌리기는 같은 키로 다시 건다');
  assert.match(fixture.app.nodes.get('liveRegion').textContent, /지라 티켓을 다시 연결했어요/);
});

test('BJLINK: 연결해도 다른 화면의 프로젝트 이름·키 표기는 그대로다', () => {
  const before = jiraLinkClient();
  const after = jiraLinkClient({ links: { 운영툴: 'IO-48394' } });
  const names = app => JSON.parse(app.run(`JSON.stringify([
    uiGroupLabel('group:운영툴'),
    uiGroupLabel('group:운영툴', { withKey: true }),
    uiProjectName({ group: '운영툴' }),
    uiProjectName({ group: '운영툴' }, { picker: true }),
    uiProjectColorKey({ group: '운영툴' }),
  ])`));
  assert.deepEqual(names(after.app), names(before.app));
  assert.deepEqual(names(after.app), ['운영툴', '운영툴', '운영툴', '운영툴', '운영툴'], '어느 자리에도 키가 새로 나오지 않는다');
});

// ---------- BJLIVE: 새로고침이 목록 갱신을 먼저 부른다 ----------
// 화면이 하는 일은 둘뿐이다: `/api/jira/list?fresh=1`을 조용히 한 번 부르고, 그 다음 화면을 다시 받는다.
// 그 부름이 실패하든 404(이 주소가 없는 옛 서버)든 새로고침은 그대로 이어져야 한다.
function refreshClient(jiraAnswer) {
  const app = client(new Response('{}'));
  const order = [];
  app.context.order = order;
  app.run(`fetch = async (url) => { order.push(String(url)); ${jiraAnswer} };`);
  app.run("load = async () => { order.push('load'); };");
  return { app, order };
}

test('BJLIVE: 새로고침은 지라 목록 갱신을 먼저 부르고 그 다음 화면을 다시 받는다', async () => {
  const ok = refreshClient("return new Response('{\"ok\":true}')");
  await ok.app.run('refreshListsFromServer()');
  assert.deepEqual(ok.order, ['/api/jira/list?fresh=1', 'load']);
});

test('BJLIVE: 목록 갱신이 실패하거나 옛 서버라 없어도 새로고침은 그대로 진행한다', async () => {
  const broken = refreshClient("throw new TypeError('Network unavailable')");
  await broken.app.run('refreshListsFromServer()');
  assert.deepEqual(broken.order, ['/api/jira/list?fresh=1', 'load'], '실패해도 화면은 다시 받는다');
  assert.equal(broken.app.nodes.has('liveRegion'), false, '곁들이는 일이라 알림도 띄우지 않는다');

  const old = refreshClient("return new Response('Not found', { status: 404 })");
  await old.app.run('refreshListsFromServer()');
  assert.deepEqual(old.order, ['/api/jira/list?fresh=1', 'load']);
  assert.equal(old.app.nodes.has('liveRegion'), false);
});

test('BJLIVE: 설정 > 상태의 지라 한 마디는 앱이 직접 읽고 있을 때만 나온다', () => {
  const app = pureClient();
  const note = (sync, at) => app.run(`jiraLiveNote(${JSON.stringify(sync)}, ${at})`);
  const read = Date.UTC(2026, 8, 25, 1, 0, 0);
  assert.equal(note({ live: true, liveAt: new Date(read).toISOString() }, read + 3 * 60000), '목록은 앱이 직접 읽어요 · 3분 전');
  assert.equal(note({ live: true, liveAt: new Date(read).toISOString() }, read + 1000), '목록은 앱이 직접 읽어요 · 방금');
  assert.equal(note({ live: true, liveAt: new Date(read).toISOString() }, read + 125 * 60000), '목록은 앱이 직접 읽어요 · 2시간 전');
  // 대비책(스냅샷 파일)을 쓰는 동안에는 한 마디가 없다 — 그 줄은 지금까지처럼 자동화 기록만 말한다.
  assert.equal(note({ connected: true, lastSync: '2026-09-24', stale: true }, read), '');
  assert.equal(note({ live: true, liveAt: '어제쯤' }, read), '');
  assert.equal(note(null, read), '');
});

// ---------- BNOTES B: 설정 > 상태의 슬랙 처리 대장 ----------
test('slackLedgerFromTail: 처리 대장 문장을 가장 최근 것 하나만 찾고, 그 실행의 건너뛴 것·⚠️ 줄만(각 상한까지) 모은다', () => {
  const app = pureClient();
  const ledger = tail => JSON.parse(app.run(`JSON.stringify(slackLedgerFromTail(${JSON.stringify(tail)}))`));

  assert.equal(ledger([]), null, '줄이 없으면 아무것도 없다');
  assert.equal(ledger(['그냥 로그 한 줄', '이번에 본 메시지 처리 대장이 아닌 줄']), null, '문장이 없으면(옛 로그) 아무것도 없다');

  const tail = [
    '───── 2026-09-20 09:00:00 slack-capture 시작',
    '이번에 본 메시지 3개 = 등록 3 · 링크 중복 0 · 비슷한 일이라 건너뜀 0 · 시스템 0',
    "🔁 이미 있는 '어제 것'랑 중복돼서 안 가져왔어요",
    '───── 2026-09-20 09:00:05 slack-capture 종료 (exit 0)',
    '───── 2026-09-21 09:00:00 slack-capture 시작',
    '이번에 본 메시지 12개 = 등록 3 · 링크 중복 7 · 비슷한 일이라 건너뜀 0 · 시스템 2',
    "🔁 이미 있는 '결제 오류 확인 요청'랑 중복돼서 안 가져왔어요",
    "🔁 이미 있는 '알림센터 로그 정리'랑 중복돼서 안 가져왔어요",
    "🔁 이미 있는 '가입 문구 검토'랑 중복돼서 안 가져왔어요",
    "🔁 이미 있는 '네 번째는 상한 밖'랑 중복돼서 안 가져왔어요",
    '⚠️ 글 없이 파일만 있는 메시지',
    '⚠️ 원본 스레드를 못 읽어서 공유 당시 텍스트만 사용함',
    '⚠️ 세 번째는 상한 밖',
    '───── 2026-09-21 09:00:40 slack-capture 종료 (exit 0)',
  ];
  const result = ledger(tail);
  assert.deepEqual(result.counts, { seen: '12', registered: '3', duplicate: '7', skipped: '0', system: '2' }, '가장 최근 문장만 쓴다');
  assert.equal(result.mismatch, '');
  assert.deepEqual(result.skipped, ['결제 오류 확인 요청', '알림센터 로그 정리', '가입 문구 검토'], '건너뛴 것은 최대 3개고, 이전 실행 것(어제 것)은 섞이지 않는다');
  assert.deepEqual(result.warnings, ['⚠️ 글 없이 파일만 있는 메시지', '⚠️ 원본 스레드를 못 읽어서 공유 당시 텍스트만 사용함'], '⚠️ 줄은 최대 2개');

  const mismatchTail = [
    '───── 2026-09-21 09:00:00 slack-capture 시작',
    '합이 안 맞습니다 (5개를 봤는데 3+1+0+0개만 설명됨)',
    '───── 2026-09-21 09:00:12 slack-capture 종료 (exit 0)',
  ];
  const mismatchResult = ledger(mismatchTail);
  assert.equal(mismatchResult.mismatch, '합이 안 맞습니다 (5개를 봤는데 3+1+0+0개만 설명됨)');
  assert.equal(mismatchResult.counts, null);
});

test('slackLedgerNotes: 처리 대장을 설정 > 상태의 슬랙 줄 아래 조용한 줄로 그리고 0인 항목은 흐리게, 합이 안 맞으면 주의색, 문장이 없으면 아무것도 안 그린다', () => {
  const app = pureClient();
  app.context.document.createTextNode = text => ({ textContent: String(text) });
  // 가짜 DOM에는 textContent 자동 합산이 없다 — 자식의 textContent를 이어 붙여 본다(nodeText와 같은 생각).
  const notes = tail => JSON.parse(app.run(`(() => {
    const flat = node => (node.children && node.children.length
      ? node.children.map(kid => kid.textContent || '').join('')
      : String(node.textContent || ''));
    return JSON.stringify(slackLedgerNotes(${JSON.stringify(tail)}).map(node => ({
      className: node.className,
      text: flat(node),
      zero: (node.children || []).filter(kid => kid.className === 'is-zero').map(kid => kid.textContent),
    })));
  })()`));

  assert.deepEqual(notes([]), [], '문장이 없으면 아무것도 안 그린다');

  const tail = [
    '이번에 본 메시지 12개 = 등록 3 · 링크 중복 0 · 비슷한 일이라 건너뜀 0 · 시스템 2',
    "🔁 이미 있는 '결제 오류 확인 요청'랑 중복돼서 안 가져왔어요",
    '⚠️ 글 없이 파일만 있는 메시지',
  ];
  const rows = notes(tail);
  assert.equal(rows[0].className, 'd-autonote');
  assert.equal(rows[0].text, '최근 수집 · 본 메시지 12개 → 등록 3 · 중복 0 · 건너뜀 0 · 시스템 2');
  assert.deepEqual(rows[0].zero, ['중복 0', '건너뜀 0'], '0인 항목만 흐리게(is-zero)');
  assert.equal(rows[1].className, 'd-autonote');
  assert.equal(rows[1].text, "건너뛴 것: 결제 오류 확인 요청");
  assert.equal(rows[2].text, '⚠️ 글 없이 파일만 있는 메시지');

  const mismatchRows = notes(['합이 안 맞습니다 (5개를 봤는데 3+1+0+0개만 설명됨)']);
  assert.equal(mismatchRows.length, 1);
  assert.equal(mismatchRows[0].className, 'd-autonote k-warn', '합이 안 맞으면 주의색 글자다');
  assert.equal(mismatchRows[0].text, '합이 안 맞습니다 (5개를 봤는데 3+1+0+0개만 설명됨)');
});

// ---------- BARCHIVE 1: 연결 입력칸의 `완료한 티켓도 보기` ----------
// 최근 90일 안에 끝난 내 담당 티켓을 **그 버튼을 눌렀을 때만** 한 번 더 읽어 같은 목록 아래에
// 조용한 글자로 덧붙인다. 지라는 전부 가짜 fetch다.
function doneLinkClient({ issues = null, fail = false, connected = true } = {}) {
  const app = workflowsClient();
  const calls = [];
  app.context.fetch = async (url, options) => {
    calls.push(String(url));
    if (String(url).includes('/api/jira/done')) {
      if (fail) return new Response(JSON.stringify({ ok: false, error: '지라에 연결하지 못했어요.', kind: 'other' }));
      if (!connected) return new Response(JSON.stringify({ ok: true, connected: false }));
      return new Response(JSON.stringify({ ok: true, connected: true, issues: issues || [
        { key: 'IO-99', summary: '끝난 임베드 정리', status: '완료', category: 'done', extra: false },
        { key: 'PAY-12', summary: '끝난 정산 점검', status: '완료', category: 'done', extra: false },
        { key: 'IO-12345', summary: '게시글 작성하기_게임 임베드', status: '완료', category: 'done', extra: false },
      ] }));
    }
    const asked = (String(url).match(/key=([^&]+)/) || [, ''])[1];
    return new Response(JSON.stringify({ ok: true, connected: true, issue: { key: decodeURIComponent(asked), summary: '미리 보기', status: { name: '완료' }, assignee: null } }));
  };
  app.run("latestData = { jiraSync: { used: true, connected: true, siteUrl: 'https://example-jira.test' } };");
  app.run("workflowData = { items: [], meetings: [], projectLinks: {} }; wfIndexData(); itemsById = new Map();");
  app.run(`jiraIssuesCache = [
    { key: 'IO-12345', summary: '게시글 작성하기_게임 임베드' },
    { key: 'PAY-77', summary: '정산 배치' },
  ]; jiraIssuesByKey = new Map(jiraIssuesCache.map(one => [one.key, one]));`);
  app.run("jiraLink = jiraLinkIdle(null);");
  app.run("document.getElementById('jiraLinkRow').dataset.project = 'group:가입 개선'; jiraLinkOpen('group:가입 개선')");
  const opts = () => nodeFind(app.nodes.get('jiraLinkRow').children[0], 'opts');
  const lines = () => opts().children.map(kid => ({ text: kid.textContent, className: String(kid.className || '') }));
  const more = () => opts().children.find(kid => kid.textContent === '완료한 티켓도 보기' || kid.textContent === '불러오는 중…');
  const doneCalls = () => calls.filter(url => url.includes('/api/jira/done'));
  return { app, calls, doneCalls, opts, lines, more };
}

test('BARCHIVE: `완료한 티켓도 보기`는 눌렀을 때만 최근 90일을 한 번 부르고, 받은 줄은 회색으로 아래에 붙는다', async () => {
  const fixture = doneLinkClient();
  assert.deepEqual(fixture.lines().map(line => line.text),
    ['내 담당 티켓', '게시글 작성하기_게임 임베드 · IO-12345', '정산 배치 · PAY-77', '완료한 티켓도 보기']);
  assert.equal(fixture.doneCalls().length, 0, '열기만 해서는 지라를 부르지 않는다');
  assert.equal(fixture.more().className, 'pk qt', '조용한 글자다');

  await fixture.app.run("jiraLinkLoadDone('group:가입 개선')");
  assert.deepEqual(fixture.doneCalls(), ['/api/jira/done?days=90'], '기간은 90일이고 한 번만 부른다');
  assert.deepEqual(fixture.lines(), [
    { text: '내 담당 티켓', className: 'note' },
    { text: '게시글 작성하기_게임 임베드 · IO-12345', className: 'pk' },
    { text: '정산 배치 · PAY-77', className: 'pk' },
    { text: '완료한 티켓', className: 'note' },
    { text: '끝난 임베드 정리 · IO-99', className: 'pk qt' },
    { text: '끝난 정산 점검 · PAY-12', className: 'pk qt' },
  ], '완료한 것은 아래에 회색 `요약 · 키`로 붙고, 위 목록에 이미 있는 키는 두 번 세우지 않는다');

  // 한 번 받으면 그 입력칸이 열려 있는 동안 다시 부르지 않는다.
  await fixture.app.run("jiraLinkLoadDone('group:가입 개선')");
  assert.equal(fixture.doneCalls().length, 1);
  // 입력칸을 닫으면 받아 둔 목록도 버린다(다음에 열면 다시 버튼부터다).
  fixture.app.run('jiraLinkReset()');
  assert.equal(fixture.app.run('String(jiraLink.done)'), 'null');
});

test('BARCHIVE: 완료한 티켓도 같은 입력으로 걸러지고, 골라도 미리 보기 → 연결 흐름은 그대로다', async () => {
  const fixture = doneLinkClient();
  await fixture.app.run("jiraLinkLoadDone('group:가입 개선')");
  const input = nodeFind(fixture.app.nodes.get('jiraLinkRow').children[0], 'in');
  input.value = '정산';
  input.listeners.input();
  assert.deepEqual(fixture.lines().map(line => line.text),
    ['내 담당 티켓', '정산 배치 · PAY-77', '완료한 티켓', '끝난 정산 점검 · PAY-12'], '한 입력이 두 목록을 함께 거른다');
  input.value = '없는 말';
  input.listeners.input();
  assert.deepEqual(fixture.lines().map(line => line.text), ['완료한 티켓이 없어요']);

  input.value = '정산';
  input.listeners.input();
  const pick = fixture.opts().children.find(kid => kid.textContent === '끝난 정산 점검 · PAY-12');
  await pick.listeners.click();
  assert.equal(fixture.app.run('jiraLink.state'), 'preview', '고르면 지금처럼 미리 보기로 간다');
  assert.equal(fixture.app.run('jiraLink.issue.key'), 'PAY-12');
  assert.equal(fixture.calls.filter(url => url.includes('/api/project/jira-link')).length, 0, '미리 보기 전에는 아무것도 저장하지 않는다');
});

test('BARCHIVE: 완료 목록을 못 읽으면 기존 문구·갈래를 그대로 쓴다', async () => {
  const broken = doneLinkClient({ fail: true });
  await broken.app.run("jiraLinkLoadDone('group:가입 개선')");
  assert.equal(broken.app.run('jiraLink.doneError'), '지라에 연결하지 못했어요.');
  assert.deepEqual(broken.lines().map(line => line.text).slice(-2), ['완료한 티켓도 보기', '지라에 연결하지 못했어요.'],
    '다시 누를 수 있고 이유가 그 아래 조용히 선다');

  const off = doneLinkClient({ connected: false });
  await off.app.run("jiraLinkLoadDone('group:가입 개선')");
  assert.equal(off.app.run('jiraLink.state'), 'off', '설정이 없으면 기존 `지라 연결이 필요해요` 갈래로 간다');
});

// ---------- BNOARCHIVE: 지난 프로젝트(자동 판정 하나뿐) ----------
// 열린 항목이 없고 14일 넘게 조용한 프로젝트만 왼쪽 목록 끝으로 내려간다 — 매번 다시 계산하고
// 저장하지 않는다. 사람이 손으로 내리거나 영구히 숨기는 길은 없다(옛 `보관`은 없앴다).
// 바뀌는 것은 배치와 고르기 목록 소제목뿐이다 — 업무·기록·주간요약·검색은 그대로다.
// 이 fixture는 BRENAME·BJCREATE·BJASSIGN도 함께 빌려 쓴다(같은 프로젝트 목록·상세 화면이라서).
function projectListClient({ posts = new Response('{"ok":true}') } = {}) {
  const app = workflowsClient();
  const sent = [];
  app.context.fetch = async (url, options) => {
    sent.push({ url: String(url), body: options && options.body ? JSON.parse(options.body) : null });
    return typeof posts === 'function' ? posts(String(url)) : posts.clone();
  };
  app.run("latestData = { jiraSync: { used: false } }; jiraIssuesCache = []; jiraIssuesByKey = new Map(); customGroupsCache = [];");
  // 오늘로부터 며칠 전 — 날짜를 박아 두면 하루만 지나도 판정이 뒤집힌다.
  app.run("dayAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };");
  // 넷: 열린 항목이 있는 것 / 0개인데 어제까지 손댄 것 / 0개이고 한 달 조용한 것 / 날짜를 하나도 모르는 것.
  app.run(`workflowData = { meetings: [], projectLinks: {}, items: [
    { id: 'a1', type: 'task', status: 'to-do', group: '살아 있는 것', created: dayAgo(3) },
    { id: 'b1', type: 'task', status: 'done', group: '최근에 끝난 것', created: dayAgo(5), completed: dayAgo(1) },
    { id: 'c1', type: 'task', status: 'done', group: '오래 조용한 것', created: dayAgo(60), completed: dayAgo(30) },
    { id: 'd1', type: 'idea', status: 'to-do', project: '날짜 없는 것' },
  ] }; wfIndexData(); itemsById = new Map();
    projectKey = null; projectOrderKeys = null; projectOrderResort = true; projectPastOpen = false;`);
  const render = () => app.run('renderProjects();');
  const list = () => app.nodes.get('projectList');
  const rowsOf = () => list().children.filter(kid => String(kid.className || '').startsWith('d-prow'))
    .map(kid => ({ name: nodeFind(kid, 'nm').textContent, past: String(kid.className).includes('is-past') }));
  const toggle = () => list().children.find(kid => String(kid.className || '') === 'd-plink');
  return { app, sent, render, list, rowsOf, toggle };
}

test('BNOARCHIVE: 지난 프로젝트 구역이 `항목 없는 프로젝트 N개 보기`를 대신하고, 머리 개수는 위 목록만 센다 — 권유 줄은 없다', () => {
  const fixture = projectListClient();
  fixture.render();
  assert.deepEqual(fixture.rowsOf().map(row => row.name), ['살아 있는 것', '최근에 끝난 것'],
    '열린 항목이 0이어도 아직 14일이 안 된 것은 위 목록에 남는다');
  assert.equal(fixture.app.nodes.get('projectList').children[0].children[1].textContent, 2, '머리의 개수는 위 목록의 수다');
  assert.equal(fixture.toggle().textContent, '지난 프로젝트 2');
  assert.equal(fixture.toggle().getAttribute('aria-expanded'), 'false');
  assert.equal(fixture.list().children.some(kid => /항목 없는 프로젝트/.test(String(kid.textContent || ''))), false,
    '옛 토글 글자는 어디에도 없다');
  // 옛 `모두 보관` 권유 줄은 더 이상 뜨지 않는다 — 조용함이 곧 지난 프로젝트라 물어볼 게 없다.
  assert.equal(fixture.list().children.some(kid => String(kid.className || '') === 'd-pnudge'), false);

  fixture.toggle().listeners.click();
  assert.deepEqual(fixture.rowsOf(), [
    { name: '살아 있는 것', past: false },
    { name: '최근에 끝난 것', past: false },
    { name: '날짜 없는 것', past: true },
    { name: '오래 조용한 것', past: true },
  ], '펼치면 흐린 줄로 이어 붙는다');
  assert.equal(fixture.toggle().textContent, '지난 프로젝트 숨기기');
});

test('BNOARCHIVE: 조용한 프로젝트에 업무가 생기면 자동으로 다시 위 목록으로 올라온다', () => {
  const fixture = projectListClient();
  fixture.render();
  assert.ok(fixture.rowsOf().every(row => row.name !== '오래 조용한 것'), '조용한 것은 접힌 구역에 있다(사람이 아무것도 하지 않았다)');

  // 열린 업무가 하나 생기면 다음 그리기에서 바로 위 목록으로 올라온다 — 저장된 값이 없어 되돌릴 일도 없다.
  fixture.app.run(`workflowData.items.push({ id: 'c2', type: 'task', status: 'to-do', group: '오래 조용한 것', created: dayAgo(0) });
    wfIndexData(); projectOrderResort = true;`);
  fixture.render();
  assert.ok(fixture.rowsOf().some(row => row.name === '오래 조용한 것' && !row.past), '업무가 생기면 자동으로 다시 올라온다');
});

test('BNOARCHIVE: 제목 ⋯ 메뉴에 보관 항목이 없다 — 그룹 프로젝트는 이름 바꾸기만, 지라 프로젝트는 ⋯ 버튼 자체가 없고 요약 줄에 `보관한 프로젝트` 문구도 없다', () => {
  const app = workflowsClient();
  app.run("latestData = { jiraSync: { used: false } }; jiraIssuesCache = []; jiraIssuesByKey = new Map(); customGroupsCache = [];");
  app.run("workflowData = { meetings: [], items: [] }; wfIndexData();");
  app.run("lastMenu = null; uiMenu = (anchor, sections) => { lastMenu = sections; return null; };");
  const detail = key => app.run(`(() => {
    const body = document.createElement('div');
    renderProjectDetail(body, { key: ${JSON.stringify(key)}, label: ${JSON.stringify(key)}, open: 2 });
    return body;
  })()`);

  const groupBody = detail('group:살아 있는 것');
  assert.equal(groupBody.children[1].textContent, '열린 항목 2', '요약 줄에 `보관한 프로젝트` 문구가 없다');
  nodeFind(groupBody.children[0], 'd-more').listeners.click({ stopPropagation() {} });
  assert.equal(app.run('lastMenu')[0].map(entry => entry.label).join(','), '이름 바꾸기', '그룹 프로젝트는 이름 바꾸기만 남는다');

  app.run('lastMenu = null;');
  const jiraBody = detail('jira:IO-1');
  assert.equal(nodeFind(jiraBody.children[0], 'd-more'), null, '지라 프로젝트는 할 수 있는 일이 없어 ⋯ 버튼 자체가 없다');
});

test('BNOARCHIVE: 지난 프로젝트도 고르기 목록에 그대로 있고, `지난 프로젝트` 소제목 아래로만 간다', () => {
  const app = workflowsClient();
  app.run("dayAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };");
  app.run(`jiraIssuesCache = [{ key: 'IO-1', summary: '가' }, { key: 'IO-2', summary: '나' }];
    jiraIssuesByKey = new Map(jiraIssuesCache.map(one => [one.key, one]));
    customGroupsCache = ['운영툴', '끝난 팀'];
    workflowData = { meetings: [], items: [
      { id: 'g1', type: 'task', status: 'to-do', group: '운영툴', created: dayAgo(3) },
      { id: 'j1', type: 'task', status: 'done', jira: 'IO-1', created: dayAgo(3), completed: dayAgo(1) },
      { id: 'j2', type: 'task', status: 'done', jira: 'IO-2', created: dayAgo(60), completed: dayAgo(30) },
      { id: 'g2', type: 'task', status: 'done', group: '끝난 팀', created: dayAgo(60), completed: dayAgo(30) },
    ] };
    wfIndexData();`);
  const rest = JSON.parse(app.run("JSON.stringify(groupSelectOptions(null, false).rest)"));
  assert.deepEqual(rest, [
    '<option value="jira:IO-1">가 · IO-1</option>',
    '<option value="group:운영툴">운영툴</option>',
    '<optgroup label="지난 프로젝트">',
    '<option value="jira:IO-2">나 · IO-2</option>',
    '<option value="group:끝난 팀">끝난 팀</option>',
    '</optgroup>',
    '<option value="__custom__">직접 입력…</option>',
  ], '조용한 것도 그대로 고를 수 있고, 목록 끝의 소제목 아래로 갈 뿐이다');

  // 조용한 것들에 열린 업무가 생기면 — 저장된 값이 없으니 — 자동으로 위 목록에 합류하고 소제목도 사라진다.
  app.run(`workflowData.items.push(
    { id: 'j3', type: 'task', status: 'to-do', jira: 'IO-2', created: dayAgo(0) },
    { id: 'g3', type: 'task', status: 'to-do', group: '끝난 팀', created: dayAgo(0) },
  ); wfIndexData();`);
  assert.equal(app.run("groupSelectOptions(null, false).rest.join('')").includes('optgroup'), false,
    '조용한 것이 없으면 소제목도 없다(옛 파일과 같은 모습)');
});

// ---------- BPVIEW: 왼쪽 목록을 지라 상태로 묶기 · 배포별 보기 · 프로젝트 찾기 ----------
// 사람이 관리하는 보관·폴더·태그 대신, 앱이 이미 아는 값(지라 상태·배포 버전)으로 자동으로 묶는다.
// 서버 변경 없음 — 판정 함수(projectStatusOf)·묶기(projectStatusGroups·projectDeployGroups)·
// 거르기(projectFindFilter)는 순수 함수라 DOM 없이도 검증한다.
test('BPVIEW: projectStatusOf — quiet가 가장 먼저, 그다음 지라 상태·열린 업무로 진행 중/시작 전을 가른다(6갈래)', () => {
  const app = workflowsClient();
  app.run(`jiraIssuesByKey = new Map([
    ['D1', { key: 'D1', category: 'doing' }],
    ['T1', { key: 'T1', category: 'todo' }],
  ]);
  workflowData = { items: [], meetings: [], projectLinks: { '연결된 그룹': 'T1' } };`);
  const status = (row, quiet) => app.run(`projectStatusOf(${JSON.stringify(row)}, ${quiet})`);
  assert.equal(status({ key: 'jira:D1', open: 3 }, true), 'past', '① quiet가 가장 먼저다');
  assert.equal(status({ key: 'jira:D1', open: 0 }, false), 'doing', '② 지라 상태가 doing이면 진행 중');
  assert.equal(status({ key: 'jira:T1', open: 2 }, false), 'doing', '③ todo여도 열린 업무가 있으면 진행 중');
  assert.equal(status({ key: 'jira:T1', open: 0 }, false), 'todo', '④ todo + 열린 업무 0이면 시작 전');
  assert.equal(status({ key: 'group:살아 있는 것', open: 0 }, false), 'doing', '⑤ 그룹인데 지라가 없으면 늘 진행 중');
  assert.equal(status({ key: 'group:연결된 그룹', open: 0 }, false), 'todo', '⑥ 그룹에 연결된 지라가 todo + 열린 업무 0이면 시작 전');
});

test('BPVIEW: projectStatusGroups는 차례를 지키며 진행 중/시작 전으로만 가른다(quiet은 이미 빠졌다)', () => {
  const app = workflowsClient();
  app.run(`jiraIssuesByKey = new Map([
    ['A', { key: 'A', category: 'doing' }],
    ['B', { key: 'B', category: 'todo' }],
    ['C', { key: 'C', category: 'todo' }],
  ]); workflowData = { items: [], meetings: [], projectLinks: {} };`);
  const rows = [
    { key: 'jira:A', label: 'A', open: 2 },
    { key: 'jira:B', label: 'B', open: 0 },
    { key: 'jira:C', label: 'C', open: 0 },
  ];
  const groups = JSON.parse(app.run(`JSON.stringify(projectStatusGroups(${JSON.stringify(rows)}))`));
  assert.deepEqual(groups.doing.map(r => r.key), ['jira:A']);
  assert.deepEqual(groups.todo.map(r => r.key), ['jira:B', 'jira:C']);
});

test('BPVIEW: projectDeployGroups는 배포일 이른 순 → 날짜 없는 버전 → `배포 미정` 순으로 묶고, 같은 버전 이름은 합친다', () => {
  const app = workflowsClient();
  app.run(`dayShift = n => { const d = new Date(); d.setDate(d.getDate() + n); return \`\${d.getFullYear()}-\${String(d.getMonth() + 1).padStart(2, '0')}-\${String(d.getDate()).padStart(2, '0')}\`; };
    jiraIssuesByKey = new Map([
      ['A', { key: 'A', versions: [{ name: 'v2.70.0', releaseDate: dayShift(6), released: false }] }],
      ['B', { key: 'B', versions: [{ name: 'v2.70.0', releaseDate: dayShift(6), released: false }] }],
      ['C', { key: 'C', versions: [{ name: 'v2.71.0', releaseDate: dayShift(20), released: false }] }],
      ['D', { key: 'D', versions: [{ name: 'v2.72.0', releaseDate: null, released: false }] }],
      ['E', { key: 'E', versions: [{ name: 'v2.60.0', releaseDate: dayShift(-9), released: true }] }],
    ]); workflowData = { items: [], meetings: [], projectLinks: {} };`);
  const rows = ['A', 'B', 'C', 'D', 'E'].map(k => ({ key: `jira:${k}`, label: k, open: 0 }))
    .concat([{ key: 'group:그룹', label: '그룹', open: 0 }]);
  const groups = JSON.parse(app.run(`JSON.stringify(projectDeployGroups(${JSON.stringify(rows)}))`));
  assert.deepEqual(groups.map(g => [g.name, g.rows.map(r => r.key)]), [
    ['v2.70.0', ['jira:A', 'jira:B']],
    ['v2.71.0', ['jira:C']],
    ['v2.72.0', ['jira:D']],
    [null, ['jira:E', 'group:그룹']],
  ], '이미 배포된 버전(E)만 있는 것과 지라 없는 그룹은 함께 `배포 미정`으로 묶인다');
});

test('BPVIEW: projectFindFilter는 이름·요약·키로 거르고(NFKC·대소문자 무시·모든 낱말 포함), 빈 칸이면 그대로 돌려준다', () => {
  const app = workflowsClient();
  app.run(`jiraIssuesByKey = new Map([['IO-1', { key: 'IO-1', summary: '결제 리뉴얼' }]]);
    workflowData = { items: [], meetings: [], projectLinks: {} };`);
  const rows = [{ key: 'jira:IO-1', label: 'IO-1', open: 1 }, { key: 'group:가입 개선', label: '가입 개선', open: 2 }];
  const names = query => JSON.parse(app.run(`JSON.stringify(projectFindFilter(${JSON.stringify(rows)}, ${JSON.stringify(query)}).map(r => r.key))`));
  assert.deepEqual(names(''), ['jira:IO-1', 'group:가입 개선'], '빈 칸이면 그대로');
  assert.deepEqual(names('결제'), ['jira:IO-1'], '요약으로 찾는다');
  assert.deepEqual(names('io-1'), ['jira:IO-1'], '키로도 맞는다(대소문자 무시)');
  assert.deepEqual(names('가입 개선'), ['group:가입 개선'], '띄어쓴 낱말을 모두 포함해야 맞는다');
  assert.deepEqual(names('개선 가입'), ['group:가입 개선'], '낱말 순서는 상관없다');
});

// 화면(DOM) 검증 — 8개(프로젝트 찾기 문턱)를 채운 fixture. 진행 중 넷(D1·D2·D5·그룹) · 시작 전
// 둘(D3·D4, 둘 다 D1과 같은 버전을 써서 배포별 보기의 합치기도 함께 본다) · 지난 프로젝트 둘.
function bpviewClient() {
  const app = workflowsClient();
  app.run(`latestData = { jiraSync: { used: false } }; customGroupsCache = [];
    dayAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return \`\${d.getFullYear()}-\${String(d.getMonth() + 1).padStart(2, '0')}-\${String(d.getDate()).padStart(2, '0')}\`; };
    dayShift = n => { const d = new Date(); d.setDate(d.getDate() + n); return \`\${d.getFullYear()}-\${String(d.getMonth() + 1).padStart(2, '0')}-\${String(d.getDate()).padStart(2, '0')}\`; };
    jiraIssuesByKey = new Map([
      ['IO-1', { key: 'IO-1', summary: '결제 리뉴얼', category: 'doing', versions: [{ name: 'v2.70.0', releaseDate: dayShift(6), released: false }] }],
      ['IO-2', { key: 'IO-2', summary: '가입 개선', category: 'doing', versions: [] }],
      ['IO-3', { key: 'IO-3', summary: '정산 자동화', category: 'todo', versions: [{ name: 'v2.70.0', releaseDate: dayShift(6), released: false }] }],
      ['IO-4', { key: 'IO-4', summary: '리포트 개편', category: 'todo', versions: [{ name: 'v2.71.0', releaseDate: dayShift(20), released: false }] }],
      ['IO-5', { key: 'IO-5', summary: '실험 대시보드', category: 'todo', versions: [{ name: 'v2.72.0', releaseDate: null, released: false }] }],
      ['IO-6', { key: 'IO-6', summary: '끝난 캠페인', category: 'doing', versions: [] }],
    ]);
    jiraIssuesCache = [...jiraIssuesByKey.values()];
    workflowData = { meetings: [], projectLinks: {}, items: [
      { id: 't1', type: 'task', status: 'to-do', jira: 'IO-1', created: dayAgo(1) },
      { id: 't2', type: 'task', status: 'to-do', jira: 'IO-2', created: dayAgo(1) },
      { id: 't3', type: 'task', status: 'done', jira: 'IO-3', created: dayAgo(3), completed: dayAgo(2) },
      { id: 't4', type: 'task', status: 'done', jira: 'IO-4', created: dayAgo(3), completed: dayAgo(1) },
      { id: 't5', type: 'task', status: 'to-do', jira: 'IO-5', created: dayAgo(1) },
      { id: 't6', type: 'task', status: 'done', jira: 'IO-6', created: dayAgo(60), completed: dayAgo(30) },
      { id: 't7', type: 'task', status: 'to-do', group: '운영툴 정비', created: dayAgo(1) },
      { id: 't8', type: 'task', status: 'done', group: '오래된 실험', created: dayAgo(90), completed: dayAgo(40) },
    ] }; wfIndexData(); itemsById = new Map();
    projectKey = null; projectOrderKeys = null; projectOrderResort = true; projectPastOpen = false;
    projectListView = 'status'; projectTodoOpen = false; projectFindQuery = ''; projectDeployClosed.clear();`);
  const render = () => app.run('renderProjects();');
  const list = () => app.nodes.get('projectList');
  const rowsOf = () => list().children.filter(kid => String(kid.className || '').startsWith('d-prow'))
    .map(kid => ({ name: nodeFind(kid, 'nm').textContent, past: String(kid.className).includes('is-past') }));
  const toggles = () => list().children.filter(kid => String(kid.className || '') === 'd-plink');
  const headings = () => list().children.filter(kid => String(kid.className || '').startsWith('d-grp'));
  const findInput = () => list().children.find(kid => kid.id === 'projectFind');
  return { app, render, list, rowsOf, toggles, headings, findInput };
}

test('BPVIEW: 8개 미만이면 찾기 칸 자체가 없다', () => {
  const fixture = projectListClient(); // 4개짜리 fixture(BNOARCHIVE)를 빌린다.
  fixture.render();
  assert.equal(fixture.list().children.some(kid => kid.id === 'projectFind'), false);
});

test('BPVIEW: 상태별 보기 — 진행 중은 소제목 없이 맨 위, 시작 전은 접힌 소제목, 머리 수는 지난 프로젝트만 뺀 전체', () => {
  const fixture = bpviewClient();
  fixture.render();
  assert.ok(fixture.findInput(), '전체 8개라 찾기 칸이 있다');
  assert.equal(fixture.list().children[0].children[1].textContent, 6, '머리의 N은 진행 중 + 시작 전이다(지난 프로젝트 둘만 뺀다 — 배포별 보기와 같은 수)');
  assert.deepEqual(fixture.rowsOf().map(r => r.name), ['결제 리뉴얼', '가입 개선', '실험 대시보드', '운영툴 정비'],
    '진행 중 넷이 소제목 없이 먼저 온다 — 정산 자동화·리포트 개편(시작 전)은 접혀서 안 보인다');
  const todoToggle = fixture.toggles().find(t => t.textContent.startsWith('시작 전'));
  assert.equal(todoToggle.textContent, '시작 전 2');
  assert.equal(todoToggle.getAttribute('aria-expanded'), 'false', '시작 전은 기본으로 접혀 있다');
  todoToggle.listeners.click();
  assert.deepEqual(fixture.rowsOf().map(r => r.name).slice(4), ['정산 자동화', '리포트 개편'], '펼치면 시작 전 프로젝트가 이어 붙는다');
});

test('BPVIEW: 지금 보는 프로젝트가 `시작 전`에 있으면 그 덩어리가 자동으로 펼쳐진다', () => {
  const fixture = bpviewClient();
  fixture.app.run("projectKey = 'jira:IO-4';");
  fixture.render();
  const todoToggle = fixture.toggles().find(t => t.textContent.startsWith('시작 전'));
  assert.equal(todoToggle.getAttribute('aria-expanded'), 'true');
  assert.ok(fixture.rowsOf().some(row => row.name === '리포트 개편'));
});

test('BPVIEW: 배포별 보기 — 버전으로 묶어 배포일 이른 순 → 날짜 없는 버전 → 배포 미정 순, 머리 수는 지난 프로젝트만 뺀다', () => {
  const fixture = bpviewClient();
  fixture.app.run("setProjectListView('deploy');");
  fixture.render();
  assert.equal(fixture.app.run('projectListView'), 'deploy');
  assert.equal(fixture.list().children[0].children[1].textContent, 6, '진행 중 + 시작 전(지난 프로젝트 둘만 뺀다) — 상태별 보기와 같은 수');
  const names = fixture.headings().map(h => nodeFind(h, 'gl').textContent);
  assert.deepEqual(names, ['v2.70.0', 'v2.71.0', 'v2.72.0', '배포 미정']);
  const counts = fixture.headings().map(h => nodeFind(h, 'n').textContent);
  assert.deepEqual(counts, [2, 1, 1, 2], '같은 버전(v2.70.0)을 쓰는 결제 리뉴얼·정산 자동화가 합쳐진다');
  const dated = nodeFind(fixture.headings()[0], 'd-pdepdate');
  assert.match(dated.textContent, /^· .+ 배포$/);
  assert.equal(nodeFind(fixture.headings()[2], 'd-pdepdate'), null, '배포일이 없는 버전은 날짜 글자 자체가 없다');
  assert.equal(nodeFind(fixture.headings()[3], 'd-pdepdate'), null, '`배포 미정`도 마찬가지다');
  // 모든 소제목이 펼쳐진 채로 시작한다 — v2.70.0 소제목 바로 뒤에 그 버전의 두 프로젝트가 있다.
  const v270 = fixture.headings()[0];
  const after = fixture.list().children.slice(fixture.list().children.indexOf(v270) + 1, fixture.list().children.indexOf(v270) + 3);
  assert.deepEqual(after.map(kid => nodeFind(kid, 'nm')?.textContent), ['결제 리뉴얼', '정산 자동화']);
});

test('BPVIEW: 배포별 보기의 소제목도 접고 펼 수 있다(세션 동안 기억)', () => {
  const fixture = bpviewClient();
  fixture.app.run("setProjectListView('deploy');");
  fixture.render();
  const v270 = fixture.headings()[0];
  assert.equal(v270.getAttribute('aria-expanded'), 'true', '기본은 펼침이다');
  v270.listeners.click();
  assert.equal(fixture.headings()[0].getAttribute('aria-expanded'), 'false');
  assert.equal(fixture.rowsOf().some(row => row.name === '결제 리뉴얼'), false, '접으면 그 아래 줄이 사라진다');
});

test('BPVIEW: 찾기 — 이름·키로 거르고, 접힘을 무시하고 전부 펼치며, 맞는 게 없는 덩어리는 소제목도 없다', () => {
  const fixture = bpviewClient();
  fixture.render();
  const input = fixture.findInput();
  input.value = '리포트';
  input.listeners.input();
  assert.deepEqual(fixture.rowsOf().map(row => row.name), ['리포트 개편'], '진행 중에는 없고 시작 전에서만 맞았다');
  const todoToggle = fixture.toggles().find(t => t.textContent.startsWith('시작 전'));
  assert.equal(todoToggle.getAttribute('aria-expanded'), 'true', '찾는 동안은 접힘을 무시하고 펼친다');
  assert.equal(fixture.toggles().some(t => t.textContent.startsWith('지난 프로젝트')), false, '지난 프로젝트에는 맞는 게 없어 소제목도 없다');
});

test('BPVIEW: 찾기 — 하나도 없으면 안내 한 줄, Esc는 비우고 칸에 초점을 남긴다', () => {
  const fixture = bpviewClient();
  fixture.render();
  const input = fixture.findInput();
  input.value = '존재하지않는프로젝트이름';
  input.listeners.input();
  assert.equal(fixture.rowsOf().length, 0);
  assert.equal(fixture.toggles().length, 0);
  const empty = fixture.list().children.find(kid => String(kid.className || '') === 'd-empty');
  assert.equal(empty.textContent, '맞는 프로젝트가 없어요.');

  input.listeners.keydown({ key: 'Escape', isComposing: false, preventDefault() {} });
  assert.equal(input.value, '', 'Esc는 칸을 비운다');
  assert.equal(fixture.app.run('projectFindQuery'), '');
  assert.ok(fixture.rowsOf().length > 0, '비우면 다시 전체가 보인다');
});

test('BPVIEW: 찾기 칸에 입력해도 목록 부분만 다시 그린다 — 칸·머리·세그먼트는 같은 노드 그대로다', () => {
  const fixture = bpviewClient();
  fixture.render();
  const before = { input: fixture.findInput(), head: fixture.list().children[0], seg: fixture.list().children[1] };
  before.input.value = '결제';
  before.input.listeners.input();
  assert.equal(fixture.findInput(), before.input, '찾기 칸 자체는 다시 만들지 않는다(한글 조합이 끊기지 않게)');
  assert.equal(fixture.list().children[0], before.head, '머리도 그대로다');
  assert.equal(fixture.list().children[1], before.seg, '세그먼트도 그대로다');
  assert.deepEqual(fixture.rowsOf().map(row => row.name), ['결제 리뉴얼'], '그 뒤의 목록만 새로 그렸다');
});

// setActiveTab(탭을 떠나면 projectFindQuery를 비우는 곳)은 app.js의 "실행 코드" 구역(DEFINITIONS_MARKER
// 아래)이라 이 test 파일이 읽는 정의부에는 없다 — Playwright로 4324에서 직접 확인한다.

// ---------- BSMALL ①: 우선순위·기한 변경 ⌘Z ----------
// 안전장치(recordUndoFor)는 손대지 않는다 — 값을 바꾸는 호출부에서 pushUndo를 부르기만 한다.
function undoValueClient() {
  const app = workflowsClient();
  const sent = [];
  app.context.fetch = async (url, init) => {
    sent.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
    return new Response('{"ok":true}');
  };
  app.run(`itemsById = new Map([
    ['t1', { id: 't1', type: 'task', description: '우선순위를 바꿀 업무', priority: 'medium', due: null }],
    ['t2', { id: 't2', type: 'task', description: '기한을 바꿀 업무', priority: 'medium', due: '2026-09-30' }],
  ]);`);
  return { app, sent };
}

test('BSMALL: 우선순위 변경은 ⌘Z로 이전 값으로 돌아가고 ⌘⇧Z로 다시 적용된다', async () => {
  const { app, sent } = undoValueClient();
  await app.run("setPriority('t1', 'critical')");
  assert.deepEqual(sent.map(call => [call.url, call.body]), [['/api/track/set-priority', { id: 't1', priority: 'critical' }]]);
  assert.equal(app.run('undoStack.length'), 1);
  assert.match(app.run('undoStack[0].label'), /우선순위 변경/);

  await app.run("replayUndo('undo')");
  assert.deepEqual(sent[1], { url: '/api/track/set-priority', body: { id: 't1', priority: 'medium' } }, '⌘Z는 이전 값으로 보낸다');
  assert.equal(app.run('undoStack.length'), 0);
  await app.run("replayUndo('redo')");
  assert.deepEqual(sent[2], { url: '/api/track/set-priority', body: { id: 't1', priority: 'critical' } }, '⌘⇧Z는 다시 바꾼 값으로');
  assert.equal(app.run('undoStack.length'), 1);
});

test('BSMALL: 기한 변경도 같은 길이고, 값이 그대로면 기록을 남기지 않는다', async () => {
  const { app, sent } = undoValueClient();
  await app.run("setTaskDue('t2', '2026-10-15')");
  assert.deepEqual(sent[0], { url: '/api/track/set-due', body: { id: 't2', due: '2026-10-15' } });
  assert.equal(app.run('undoStack.length'), 1);
  await app.run("replayUndo('undo')");
  assert.deepEqual(sent[1], { url: '/api/track/set-due', body: { id: 't2', due: '2026-09-30' } });

  // 같은 값으로 다시 보내면 되돌릴 것이 없다
  app.run('undoStack.length = 0; redoStack.length = 0;');
  await app.run("setPriority('t1', 'medium')");
  assert.equal(app.run('undoStack.length'), 0);
});

test('BSMALL: 아이디어의 `가능성`도 같은 저장 길이라 ⌘Z 대상이고, 이름만 그 화면의 말로 남는다', async () => {
  const { app, sent } = undoValueClient();
  app.run(`workflowData = { items: [{ id: 'i1', type: 'idea', description: '온보딩 진행률 바', priority: 'medium', status: 'to-do' }], meetings: [] };
    wfIndexData(); itemsById.set('i1', workflowData.items[0]);`);
  const chips = app.run("ideaChanceControl(wfItem('i1'))");
  await chips.children[0].listeners.click();
  assert.deepEqual(sent[0], { url: '/api/track/set-priority', body: { id: 'i1', priority: 'high' } });
  assert.match(app.run('undoStack[0].label'), /가능성 변경/);
});

// ---------- BSMALL ②: 회의에서 담은 항목의 종류 바꾸기 ----------
test('BSMALL: 종류 바꾸기 칩은 지금 종류만 비활성이고, 고르면 같은 id로 retype을 보낸다', async () => {
  const { app, sent } = meetingRowClient(new Response('{"ok":true,"id":"i1","type":"decision","from":"check"}'));
  app.run(`workflowData = { items: [{ id: 'i1', type: 'check', description: '담은 확인 대기', status: 'to-do' }], meetings: [] };
    wfIndexData(); itemsById = new Map(workflowData.items.map(item => [item.id, item]));`);
  const menu = app.run("panelMeetingRowMenu(wfItem('i1'), document.createElement('div'), () => {})");
  const chips = menu[0][1].control;
  assert.equal(menu[0][1].field, '종류 바꾸기');
  assert.deepEqual(chips.children.map(chip => [chip.textContent, chip.disabled]),
    [['할 일', false], ['확인 대기', true], ['결정', false]], '지금 종류는 누를 수 없다');

  await chips.children[2].listeners.click();
  assert.deepEqual(sent.map(call => [call.url, call.body]), [['/api/workflow/retype', { id: 'i1', type: 'decision' }]]);
  const region = app.nodes.get('liveRegion');
  assert.equal(region.textContent, '결정으로 바꿨어요', '받침에 맞는 조사로 적는다(할 일로 · 확인 대기로 · 결정으로)');
  assert.equal(app.run('undoStack.length'), 1, '⌘Z로도 되돌린다');
  assert.match(app.run('undoStack[0].label'), /종류 바꾸기/);

  // 알림의 `되돌리기`는 반대 방향 retype 하나이고, 그 뒤에는 ⌘Z가 같은 일을 또 하지 않는다
  const undo = region.children.find(node => node.textContent === '되돌리기');
  await undo.listeners.click();
  assert.deepEqual(sent[1], { url: '/api/workflow/retype', body: { id: 'i1', type: 'check' } });
  assert.equal(app.run('undoStack.length'), 0);
});

test('BSMALL: 완료한 항목은 종류 바꾸기 칩이 모두 비활성이고 이유를 알려 준다', () => {
  const { app } = meetingRowClient(new Response('{"ok":true}'));
  const menu = app.run("panelMeetingRowMenu({ id: 'i1', type: 'task', description: '끝난 업무', status: 'done' }, document.createElement('div'), () => {})");
  const chips = menu[0][1].control;
  assert.deepEqual(chips.children.map(chip => chip.disabled), [true, true, true]);
  assert.equal(chips.title, '완료한 항목은 종류를 바꿀 수 없어요');
  assert.equal(chips.getAttribute('aria-description'), '완료한 항목은 종류를 바꿀 수 없어요');
});

// ---------- BSMALL ③: 결정의 `내용` ----------
test('BSMALL: 결정 카드의 `내용`은 note로 저장되고 줄바꿈을 지킨다(4,000자)', async () => {
  const { app, sent } = meetingRowClient(new Response('{"ok":true}'));
  const box = app.run(`(() => {
    const box = document.createElement('div');
    panelDecisionNote({ id: 'd1', description: '정산 주기는 매주 화요일' }, { note: '이미 적어 둔 내용' }, box);
    return box;
  })()`);
  const section = box.children[0];
  assert.equal(section.dataset.sec, '내용');
  assert.equal(section.children[0].textContent, '내용');
  const area = section.children[1];
  assert.equal(area.value, '이미 적어 둔 내용');
  assert.equal(area.maxLength, 4000);
  area.value = '배경: 정산이 월요일에 몰렸다.\n예외: 공휴일이면 다음 영업일.';
  await area.listeners.change();
  assert.deepEqual(sent.map(call => [call.url, call.body]),
    [['/api/workflow/item', { id: 'd1', note: '배경: 정산이 월요일에 몰렸다.\n예외: 공휴일이면 다음 영업일.' }]],
    '줄바꿈을 한 칸으로 바꾸지 않는다(결과 한 줄과 다른 점)');
});

test('BSMALL: 결정 줄의 `내용` 표시는 적어 둔 내용이 있을 때만 선다', () => {
  const { app } = meetingRowClient(new Response('{"ok":true}'));
  app.run(`workflowData = { items: [
    { id: 'd1', type: 'decision', description: '내용이 있는 결정', status: 'to-do' },
    { id: 'd2', type: 'decision', description: '내용이 없는 결정', status: 'to-do', note: '   ' },
  ], meetings: [] }; wfIndexData();`);
  assert.equal(app.run("recordNoteMark({ id: 'd1', description: '내용이 있는 결정' })"), null, '아직 아무것도 없으면 표시도 없다');
  assert.equal(app.run("recordNoteMark({ id: 'd2', description: '내용이 없는 결정' })"), null, '빈칸만 적힌 것도 없는 것으로 본다');
  app.run("wfItem('d1').note = '배경과 예외';");
  const mark = app.run("recordNoteMark({ id: 'd1', description: '내용이 있는 결정' })");
  assert.equal(mark.textContent, '내용');
  assert.equal(mark.className, 'd-recnote');
  assert.equal(mark.getAttribute('aria-label'), '내용이 있는 결정 — 내용 보기');
});

// ---------- BNEXTRAIL: 좁은 레일의 `다음은?`은 한 줄 제안 + 상세 카드 ----------
// 레일은 훑어보는 자리다 — 체크했다고 선택지를 다 펼치면 카드가 화면을 다 먹는다.
const panelSectionsOf = box => box.children.map(node => (node.dataset && node.dataset.sec) || '').filter(Boolean);
const panelSectionOf = (box, name) => box.children.find(node => node.dataset && node.dataset.sec === name);
const panelCheckBox = (app, id) => app.run(`(() => {
  const box = document.createElement('div');
  panelCheck({ item: wfItem('${id}'), detail: { outcome: '' } }, box);
  return box;
})()`);

test('BNEXTRAIL: 레일에서 체크하면 한 줄만 늘어나고, 넓은 자리는 버튼 줄 그대로다', () => {
  const { app, check } = waitingNextClient();
  check('ck1');
  app.run("renderWaiting(workflowData.items.filter(item => item.status !== 'done'))");
  const lead = app.nodes.get('waitingList').children[0];
  assert.equal(lead.children.length, 2, '체크한 줄 한 번 더 + 제안 한 줄이 전부다');
  const one = lead.children[1];
  assert.equal(one.className, 'd-wnext is-one');
  assert.equal(one.children.length, 1, '`이 답을 기다리던 업무` 목록까지 펼치지 않는다');
  assert.deepEqual(one.children[0].children.map(node => node.textContent),
    ['답을 받았어요 ·', '후속 할 일 만들기 →', '자세히', '✕']);
  assert.equal(one.children[0].children[3].getAttribute('aria-label'), '법무 검토 회신 받기 — 다음은? 닫기');
  assert.equal(one.children[0].children[1].getAttribute('aria-label'), '법무 검토 회신 받기 — 후속 할 일 만들기');

  // 넓은 자리(프로젝트 탭 확인 대기 구역·회의의 나온 줄)는 예전 버튼 줄 그대로다
  assert.deepEqual(app.run("waitingNextRow(wfItem('ck1'))").children[0].children.map(node => node.textContent),
    ['다음은?', '후속 할 일', '결정으로 남기기', '답변 한 줄 남기기', '닫기']);
});

test('BNEXTRAIL: 기다리던 업무가 있으면 한 줄 제안이 그 업무들을 오늘로 옮긴다', async () => {
  const { app, sent, check } = waitingNextClient();
  app.run(`workflowData.items.push(
    { id: 't1', type: 'task', description: '업무1', status: 'to-do', blockedBy: 'ck1', scheduled: todayStr() },
    { id: 't2', type: 'task', description: '업무2', status: 'to-do', blockedBy: 'ck1' },
    { id: 't3', type: 'task', description: '업무3', status: 'to-do', blockedBy: 'ck1', scheduled: '2026-01-01' },
    { id: 't4', type: 'task', description: '끝난 업무', status: 'done', blockedBy: 'ck1' }
  ); wfIndexData();`);
  check('ck1');
  const suggest = app.run("waitingNextOne(wfItem('ck1'))").children[0].children[1];
  assert.equal(suggest.textContent, '기다리던 업무 2개를 오늘로 →', '이미 오늘인 업무·끝난 업무는 세지 않는다');
  await suggest.listeners.click();
  assert.deepEqual(sent.map(call => call.url), ['/api/track/set-scheduled', '/api/track/set-scheduled'],
    '기존 길을 업무마다 한 번씩 — ⌘Z도 기존 규칙대로 각각 기록된다');
  assert.deepEqual(sent.map(call => call.body), [
    { id: 't2', scheduled: app.run('todayStr()') },
    { id: 't3', scheduled: app.run('todayStr()') },
  ]);
  assert.equal(app.nodes.get('liveRegion').textContent, '오늘 할 일로 옮겼어요 · 2개');
});

test('BNEXTRAIL: 기다리던 업무가 전부 오늘이면 옮기지 않고 상세 카드를 연다', () => {
  const { app, sent, check } = waitingNextClient();
  app.run(`workflowData.items.push(
    { id: 't1', type: 'task', description: '업무1', status: 'to-do', blockedBy: 'ck1', scheduled: todayStr() }
  ); wfIndexData(); var opened = []; panelOpen = view => opened.push(view);`);
  check('ck1');
  const suggest = app.run("waitingNextOne(wfItem('ck1'))").children[0].children[1];
  assert.equal(suggest.textContent, '기다리던 업무 1개 보기 →');
  suggest.listeners.click();
  assert.deepEqual(sent, [], '옮길 것이 없으면 아무것도 보내지 않는다');
  assert.equal(app.run('opened.length'), 1);
  assert.equal(app.run("opened[0].id"), 'ck1');
});

test('BNEXTRAIL: 기다리던 업무가 없으면 상세 카드를 열고 `후속 할 일` 입력칸까지 바로 연다', () => {
  const { app, check } = waitingNextClient();
  check('ck1');
  app.run(`var openedBox = null; panelOpen = view => {
    openedBox = document.createElement('div');
    panelCheck({ item: wfItem(view.id), detail: { outcome: '' } }, openedBox);
  };`);
  const suggest = app.run("waitingNextOne(wfItem('ck1'))").children[0].children[1];
  assert.equal(suggest.textContent, '후속 할 일 만들기 →');
  suggest.listeners.click();
  const box = app.run('openedBox');
  assert.ok(box, '상세 카드가 열린다');
  const form = panelSectionOf(box, '다음은?').children[1].children[0];
  assert.equal(form.className, 'nx is-ed', '버튼 줄이 이미 입력 줄로 바뀌어 있다');
  assert.equal(form.children[0].value, '법무 검토 회신 받기', '문구가 미리 채워지고');
  assert.equal(form.children[0].selected, true, '전체 선택된 채로 열린다');
  assert.deepEqual(form.children.slice(1).map(node => node.textContent), ['오늘', '나중에']);
});

test('BNEXTRAIL: `자세히`는 상세 카드를 열고 ✕는 줄만 내린다 — 상세 카드에는 전체 `다음은?`이 선다', () => {
  const { app, sent, check } = waitingNextClient();
  check('ck1');
  app.run("var opened = []; panelOpen = view => opened.push(view);");
  const bar = app.run("waitingNextOne(wfItem('ck1'))").children[0];
  bar.children[2].listeners.click();
  assert.equal(app.run('opened.length'), 1);
  assert.equal(app.run("opened[0].id"), 'ck1');
  assert.equal(bar.children[2].getAttribute('aria-label'), '법무 검토 회신 받기 — 다음은? 자세히');
  bar.children[3].listeners.click();
  assert.equal(app.run('waitingNextId'), null, '✕는 지금의 `닫기`와 같다');
  assert.deepEqual(sent, [], '체크는 이미 저장됐으므로 아무것도 보내지 않는다');

  // 상세 카드: 완료 상태 구역에 `답변 한 줄` 칸과 나란히 전체 `다음은?`이 선다
  app.run(`workflowData.items.push(
    { id: 't2', type: 'task', description: '업무2', status: 'to-do', blockedBy: 'ck1' }
  ); wfIndexData();`);
  const box = panelCheckBox(app, 'ck1');
  assert.deepEqual(panelSectionsOf(box), ['답변 한 줄', '다음은?', '확인 요청 기록'],
    '`답변 한 줄` 칸 바로 뒤에 붙어 같은 것을 두 번 묻지 않는다');
  const row = panelSectionOf(box, '다음은?').children[1];
  assert.equal(row.className, 'd-wnext is-panel', '레일의 한 줄 제안과 달리 걷히지 않는 붙박이 구역이다');
  assert.deepEqual(row.children[0].children.map(node => node.textContent),
    ['후속 할 일', '결정으로 남기기'], '구역 제목이 이미 `다음은?`이라 앞머리 글자와 `답변 한 줄 남기기`·`닫기`는 빠진다');
  assert.equal(row.children[1].className, 'bl', '`이 답을 기다리던 업무` 목록도 여기 넓게 선다');
  assert.equal(row.children[1].children[1].children[0].textContent, '업무2');

  // 아직 답을 받지 않은 확인 대기에는 이 구역이 없다
  app.run("wfItem('ck1').status = 'to-do'; wfIndexData();");
  assert.deepEqual(panelSectionsOf(panelCheckBox(app, 'ck1')), ['확인 요청 기록']);
});

// ---------- BTRASH: 설정 > 삭제한 항목 ----------
// 삭제는 확인창 없이 바로 실행되고 되돌릴 길은 알림·⌘Z뿐이라 시간이 지나면 닫혔다.
// 여기서 원문이 남아 있는 목록을 보고 되살리거나(기존 restore) 완전히 지운다.
const TRASH_ITEMS = [
  { id: 'tr02', type: 'check', typeLabel: '확인 대기', description: '법무 검토 회신', file: 'checks.md',
    deletedAt: '2026-09-22T01:05:00.000Z', project: '게임 임베드', projectKey: 'jira:IO-12345' },
  { id: 'tr01', type: 'task', typeLabel: '할 일', description: '정산 배치 설계 검토하기', file: 'tasks.md',
    deletedAt: '2026-09-21T13:10:00.000Z', project: '결제 리뉴얼', projectKey: 'group:결제 리뉴얼' },
  { id: 'tr03', type: 'idea', typeLabel: '아이디어', description: '알림 묶어 보내기', file: 'ideas.md',
    deletedAt: '2026-09-20T09:00:00.000Z', project: null, projectKey: null },
];
function trashClient(items = TRASH_ITEMS) {
  const app = pureClient();
  const sent = [];
  app.context.fetch = async (url, options) => {
    sent.push({ url: String(url), body: options && options.body ? JSON.parse(options.body) : null });
    if (String(url) === '/api/track/trash') return new Response(JSON.stringify({ ok: true, items }));
    return new Response('{"ok":true}');
  };
  app.run('loads = 0; load = async () => { loads += 1; };');
  app.run('lastMenu = null; uiMenu = (anchor, sections) => { lastMenu = sections; return null; };');
  const view = () => app.nodes.get('settingsTrashView');
  const rows = () => view().children.filter(kid => String(kid.className || '') === 'd-trow');
  return { app, sent, view, rows };
}

test('BTRASH: 탭 이름의 개수는 목록을 읽은 값이고, 0이면 숫자를 붙이지 않는다', async () => {
  const app = trashClient().app;
  await app.run('settingsTrashLoad()');
  assert.equal(app.nodes.get('settingsTrashTab').textContent, '삭제한 항목 3');

  const empty = trashClient([]).app;
  await empty.run('settingsTrashLoad()');
  assert.equal(empty.nodes.get('settingsTrashTab').textContent, '삭제한 항목');
});

test('BTRASH: 목록은 종류·문구·프로젝트와 삭제 시각을 한 줄로 적고, 비어 있으면 한 줄만 남는다', async () => {
  const fixture = trashClient();
  await fixture.app.run("settingsTrashLoad().then(() => settingsSetTab('trash'))");
  assert.equal(fixture.app.nodes.get('settingsTrashView').hidden, false);
  assert.equal(fixture.app.nodes.get('settingsStatusView').hidden, true);
  const rows = fixture.rows();
  assert.equal(rows.length, 3);
  assert.equal(nodeFind(rows[1], 'kd').textContent, '할 일');
  assert.equal(nodeFind(rows[1], 'tx').textContent, '정산 배치 설계 검토하기');
  assert.equal(nodeFind(rows[1], 'tw').textContent, '9월 21일 22:10에 삭제');
  // 프로젝트는 다른 줄과 같은 표기(`· ● 이름`)다 — 지라는 서버가 요약만 실어 준다.
  assert.equal(nodeFind(rows[0], 'd-inproj').children.filter(kid => typeof kid === 'string').join(''), '· 게임 임베드');
  assert.equal(nodeFind(rows[2], 'd-inproj'), null, '프로젝트가 없으면 아무것도 지어내지 않는다');
  assert.equal(nodeFind(rows[0], 'ta').children[0].textContent, '되살리기');

  const empty = trashClient([]);
  await empty.app.run("settingsTrashLoad().then(() => settingsSetTab('trash'))");
  assert.equal(empty.rows().length, 0);
  assert.match(String(empty.view().html || ''), /삭제한 항목이 없어요\./);
});

test('BTRASH: 되살리기는 기존 복구 길로 보내고 목록에서 빼고 화면을 다시 읽는다', async () => {
  const fixture = trashClient();
  await fixture.app.run("settingsTrashLoad().then(() => settingsSetTab('trash'))");
  const restore = nodeFind(fixture.rows()[1], 'ta').children[0];
  await restore.listeners.click();
  assert.deepEqual(fixture.sent.slice(-1), [{ url: '/api/track/restore', body: { id: 'tr01' } }]);
  assert.equal(fixture.app.run('loads'), 1, '되살린 항목이 목록에 돌아오게 화면을 다시 읽는다');
  assert.match(fixture.app.nodes.get('liveRegion').textContent, /되살렸어요 · 정산 배치 설계 검토하기/);
  assert.equal(fixture.rows().map(row => nodeFind(row, 'tx').textContent).join(','), '법무 검토 회신,알림 묶어 보내기');
  assert.equal(fixture.app.nodes.get('settingsTrashTab').textContent, '삭제한 항목 2');
});

test('BTRASH: 완전히 지우기는 확인 줄을 한 번 거치고, 취소하면 아무것도 보내지 않는다', async () => {
  const fixture = trashClient();
  await fixture.app.run("settingsTrashLoad().then(() => settingsSetTab('trash'))");
  const row = fixture.rows()[1];
  nodeFind(row, 'd-more').listeners.click({ stopPropagation() {} });
  const menu = fixture.app.run('lastMenu');
  assert.equal(menu[0].map(entry => `${entry.label}:${!!entry.danger}`).join(','), '완전히 지우기:true');

  menu[0][0].onClick();
  const ask = nodeFind(row, 'is-ask');
  assert.equal(nodeFind(ask, 'tq').textContent, '되살릴 수 없어요');
  assert.equal(ask.children.filter(kid => kid.textContent === '지우기' || kid.textContent === '취소').map(kid => kid.textContent).join(','), '지우기,취소');
  const sentBefore = fixture.sent.length;
  ask.children.find(kid => kid.textContent === '취소').listeners.click();
  assert.equal(fixture.sent.length, sentBefore, '취소는 아무것도 보내지 않는다');
  assert.equal(nodeFind(row, 'ta').children[0].textContent, '되살리기', '확인 줄 자리에 동작 묶음이 그대로 돌아온다');

  // 다시 열어 `지우기`를 누르면 그때만 나간다.
  nodeFind(row, 'd-more').listeners.click({ stopPropagation() {} });
  fixture.app.run('lastMenu')[0][0].onClick();
  await nodeFind(row, 'is-ask').children.find(kid => kid.textContent === '지우기').listeners.click();
  assert.deepEqual(fixture.sent.slice(-1), [{ url: '/api/track/trash-purge', body: { id: 'tr01' } }]);
  assert.match(fixture.app.nodes.get('liveRegion').textContent, /완전히 지웠어요 · 정산 배치 설계 검토하기/);
  assert.equal(fixture.rows().map(row => nodeFind(row, 'tx').textContent).join(','), '법무 검토 회신,알림 묶어 보내기');
  assert.equal(fixture.app.run('loads'), 0, '이미 목록에 없는 줄이라 화면을 다시 읽지 않는다');
});

// ---------- BRENAME: 직접 만든 프로젝트 이름 바꾸기 ----------
function renameClient() {
  const fixture = projectListClient();
  fixture.app.run('loads = 0; load = async () => { loads += 1; };');
  fixture.app.run("lastMenu = null; uiMenu = (anchor, sections) => { lastMenu = sections; return null; };");
  const detail = (key) => fixture.app.run(`(() => {
    const body = document.createElement('div');
    renderProjectDetail(body, { key: ${JSON.stringify(key)}, label: ${JSON.stringify(key)}, open: 1 });
    return body;
  })()`);
  return { ...fixture, detail };
}

test('BRENAME: 이름 바꾸기는 직접 만든 프로젝트에만 있고, 지라 프로젝트는 제목이 이유를 말한다 — ⋯ 버튼 자체가 없다', () => {
  const fixture = renameClient();
  const group = fixture.detail('group:살아 있는 것');
  nodeFind(group.children[0], 'd-more').listeners.click({ stopPropagation() {} });
  assert.equal(fixture.app.run('lastMenu')[0].map(entry => entry.label).join(','), '이름 바꾸기');
  assert.equal(group.children[0].title, undefined, '직접 만든 프로젝트의 제목에는 설명이 붙지 않는다');

  const jira = fixture.detail('jira:IO-12345');
  assert.equal(nodeFind(jira.children[0], 'd-more'), null, '지라 프로젝트는 할 수 있는 일이 없어 ⋯ 버튼 자체가 없다');
  assert.equal(jira.children[0].title, '이름은 지라 요약을 따라요');
});

test('BRENAME: 제목 자리가 입력칸이 되고 Enter로 보낸다 — 한글 조합 중 Enter는 넘기고 취소는 제목으로 돌아간다', async () => {
  const fixture = renameClient();
  const body = fixture.detail('group:살아 있는 것');
  const title = body.children[0];
  nodeFind(title, 'd-more').listeners.click({ stopPropagation() {} });
  fixture.app.run('lastMenu')[0][0].onClick();

  const box = body.children[0];
  assert.equal(box.className, 'd-pren');
  const input = nodeFind(box, 'd-din');
  assert.equal(input.value, '살아 있는 것');
  assert.equal(input.selected, true, '현재 이름이 전체 선택된 채로 열린다');
  assert.equal(box.children.filter(kid => kid !== input).map(kid => kid.textContent).join(','), '저장,취소');

  input.value = '살아 있는 프로젝트';
  await input.listeners.keydown({ key: 'Enter', isComposing: true, preventDefault() {} });
  assert.equal(fixture.sent.length, 0, '한글을 조합하는 중의 Enter는 글자를 확정하는 것이다');

  await input.listeners.keydown({ key: 'Enter', isComposing: false, preventDefault() {} });
  assert.deepEqual(fixture.sent, [{ url: '/api/project/rename', body: { project: 'group:살아 있는 것', name: '살아 있는 프로젝트' } }]);
  assert.equal(fixture.app.run('projectKey'), 'group:살아 있는 프로젝트', '바꾼 이름의 프로젝트가 열린 채로 남는다');
  assert.equal(fixture.app.run('projectOrderResort'), true, '키가 바뀌었으니 왼쪽 목록 차례를 다시 잡는다');
  assert.equal(fixture.app.run('loads'), 1);

  // 취소는 입력만 닫고 제목을 그대로 되돌린다.
  const second = fixture.detail('group:살아 있는 것');
  nodeFind(second.children[0], 'd-more').listeners.click({ stopPropagation() {} });
  fixture.app.run('lastMenu')[0][0].onClick();
  const cancel = second.children[0].children.find(kid => kid.textContent === '취소');
  cancel.listeners.click();
  assert.equal(second.children[0].className, 'd-ptitle');
  assert.equal(fixture.sent.length, 1, '취소는 아무것도 보내지 않는다');
});

test('BRENAME: 알림의 `되돌리기`는 반대 방향으로 한 번 더 바꾸는 것이고 ⌘Z 대상은 아니다', async () => {
  const fixture = renameClient();
  const body = fixture.detail('group:살아 있는 것');
  nodeFind(body.children[0], 'd-more').listeners.click({ stopPropagation() {} });
  fixture.app.run('lastMenu')[0][0].onClick();
  const box = body.children[0];
  nodeFind(box, 'd-din').value = '살아 있는 프로젝트';
  await box.children.find(kid => kid.textContent === '저장').listeners.click();

  const region = fixture.app.nodes.get('liveRegion');
  assert.match(region.textContent, /이름을 바꿨어요 · 살아 있는 것 → 살아 있는 프로젝트/);
  const undo = region.children.find(kid => kid.textContent === '되돌리기');
  await undo.listeners.click(undo);
  assert.deepEqual(fixture.sent.slice(-1), [{ url: '/api/project/rename', body: { project: 'group:살아 있는 프로젝트', name: '살아 있는 것' } }]);
  assert.match(region.textContent, /이름을 되돌렸어요 · 살아 있는 프로젝트 → 살아 있는 것/);
  assert.equal(fixture.app.run('projectKey'), 'group:살아 있는 것');
  assert.equal(fixture.app.run('undoStack.length'), 0, '앱의 ⌘Z 대상은 아니다 — 되돌리는 길은 알림뿐이다');
});

// ---------- 새 프로젝트 화면 (BJCREATE) ----------
// 실제 지라에는 닿지 않는다 — 가짜 fetch가 create-meta·create 응답을 대신 준다.
const BJC_META = { ok: true, connected: true, project: 'IO', epic: { id: '10000', name: '에픽' }, types: [{ id: '10001', name: '작업' }], defaultTypeId: '10001' };
const BJC_MADE = {
  ok: true, connected: true,
  epic: { key: 'IO-48400', url: 'https://example-jira.test/browse/IO-48400', summary: '게시글 작성하기_게임 임베드', created: true },
  children: [
    { summary: '[Web] 게시글 작성하기_게임 임베드', key: 'IO-48401', url: 'https://example-jira.test/browse/IO-48401' },
    { summary: '[QA] 게시글 작성하기_게임 임베드', error: '지라에서 이 프로젝트에 이슈를 만들 권한이 없어요.', kind: 'makeForbidden' },
  ],
  made: 2, failed: 1,
};
function projectNewClient({ meta = BJC_META, made = BJC_MADE, roles = null } = {}) {
  const fixture = projectListClient({ posts: (url) => {
    if (url.includes('/api/jira/create-meta')) return new Response(JSON.stringify(meta));
    if (url.includes('/api/jira/create')) return new Response(JSON.stringify(typeof made === 'function' ? made() : made));
    return new Response('{"ok":true}');
  } });
  fixture.app.run('loads = 0; load = async () => { loads += 1; };');
  fixture.app.run('openedProject = null; openProjectTab = key => { openedProject = key; };');
  fixture.app.run("lastMenu = null; uiMenu = (anchor, sections) => { lastMenu = sections; return null; };");
  fixture.app.run(`workflowData.jiraRoles = ${JSON.stringify(roles)};`);
  const start = () => {
    fixture.app.run('projectNewStart()');
    // 지라 종류는 화면이 열리자마자 읽으므로 테스트에서는 그 결과를 바로 끼운다.
    fixture.app.run(`projectNew.types = ${JSON.stringify(meta.types)}; projectNew.typeId = ${JSON.stringify(meta.defaultTypeId)}; projectNew.typeProject = 'IO'; projectNewPaint();`);
  };
  const body = () => fixture.app.nodes.get('projectBody');
  const set = (code) => fixture.app.run(`${code}; projectNewPaint();`);
  return { ...fixture, start, body, set };
}
const bjcText = node => (node ? String(node.textContent || '') : '');
// 가짜 노드의 textContent는 자기 것뿐이라, 묶음을 읽을 때는 자식까지 훑어 모은다.
function bjcWords(node) {
  if (!node || typeof node !== 'object') return '';
  return [String(node.textContent || ''), ...(node.children || []).map(bjcWords)].filter(Boolean).join(' ');
}
const bjcButton = (node, label) => nodeFindAll(node, 'd-btn').find(kid => bjcText(kid) === label);

test('BJCREATE: 왼쪽 목록 머리의 `+`가 새 프로젝트 화면을 열고, 미리 보기 제목은 `접두어 + 이름`이다', () => {
  const fixture = projectNewClient();
  fixture.render();
  const add = fixture.list().children[0].children.find(kid => String(kid.className || '') === 'd-pnewgo');
  assert.ok(add, '머리줄에 조용한 `+`가 있다');
  assert.equal(add.getAttribute('aria-label'), '새 프로젝트');
  add.listeners.click();
  assert.equal(bjcText(fixture.body().children[0]), '새 프로젝트');

  fixture.set("projectNew.name = '게시글 작성하기_게임 임베드'; projectNew.project = 'IO'; projectNew.roles = ['Web', 'QA']; projectNew.types = [{ id: '10001', name: '작업' }]; projectNew.typeId = '10001'");
  const preview = nodeFind(fixture.body(), 'd-pnewpv');
  assert.equal(bjcWords(nodeFind(preview, 'ep')).includes('새로 만듦'), true, '새 에픽이면 `새로 만듦`이라고 적는다');
  const titles = nodeFindAll(preview, 'ti').map(input => input.value);
  assert.deepEqual(titles, ['[Web] 게시글 작성하기_게임 임베드', '[QA] 게시글 작성하기_게임 임베드']);
  assert.deepEqual(nodeFindAll(preview, 'br').map(kid => kid.textContent), ['├', '└']);
  assert.deepEqual(nodeFindAll(preview, 'wh').map(kid => kid.textContent).slice(1), ['담당 없음', '담당 없음'], '담당은 비운다');
  assert.equal(bjcText(nodeFind(fixture.body(), 'pri')), '지라에 3개 만들기', '에픽 하나를 함께 센다');

  // 미리 보기 줄에서 제목을 그 자리에서 고치면 그 글자가 그대로 나간다.
  const first = nodeFindAll(preview, 'ti')[0];
  first.value = '[Web] 손으로 고친 제목';
  first.listeners.input();
  assert.equal(fixture.app.run("projectNewRows(projectNew)[0].summary"), '[Web] 손으로 고친 제목');
});

test('BJCREATE: 직군을 하나도 안 고르면 에픽만, 직접 입력은 그 자리에서만 더해지고, 겹치는 직군은 알려 준다', () => {
  const fixture = projectNewClient();
  fixture.start();
  fixture.set("projectNew.name = '임베드'; projectNew.project = 'IO'");
  assert.equal(fixture.app.run('projectNewCount(projectNew)'), 1, '미선택이면 에픽 하나뿐이다');
  assert.match(bjcWords(nodeFind(fixture.body(), 'd-pnewpv')), /직군을 고르지 않으면 에픽만 만들어요/);

  // 직접 입력 — 접두어를 적고 Enter면 체크된 항목으로 더해진다(설정에는 저장하지 않는다).
  const own = nodeFind(fixture.body(), 'd-pnewown');
  const input = nodeFind(own, 'in');
  input.value = '[Data]';
  input.listeners.keydown({ key: 'Enter', isComposing: true, preventDefault() {} });
  assert.equal(fixture.app.run('projectNew.extra.length'), 0, '한글 조합 중 Enter는 넘긴다');
  input.listeners.keydown({ key: 'Enter', isComposing: false, preventDefault() {} });
  assert.equal(fixture.app.run('projectNewCount(projectNew)'), 2);
  assert.equal(fixture.app.run("projectNewRows(projectNew)[0].summary"), '[Data] 임베드');
  assert.deepEqual(fixture.sent.filter(entry => entry.url.includes('jira-roles')), [], '직접 입력은 설정에 저장하지 않는다');

  // 이미 그 접두어의 하위가 있는 에픽에 붙일 때는 체크가 꺼진 채로 `이미 있어요 KEY`라고만 알린다.
  fixture.set(`projectNew.mode = 'attach'; projectNew.roles = ['Web']; projectNew.epic = { key: 'IO-48394', summary: '임베드', children: { items: [{ key: 'IO-48401', summary: '[Web] 임베드' }] } }`);
  assert.equal(fixture.app.run("projectNewExisting(projectNew, { label: 'Web', prefix: '[Web]' })"), 'IO-48401');
  fixture.app.run("projectNewPickEpic({ key: 'IO-48394', summary: '임베드', children: { items: [{ key: 'IO-48401', summary: '[Web] 임베드' }] } })");
  assert.equal(fixture.app.run('projectNew.roles.length'), 0, '겹치는 직군의 체크는 꺼진다');
  assert.match(bjcWords(nodeFind(fixture.body(), 'd-pnewroles')), /이미 있어요 IO-48401/);
  assert.match(bjcWords(nodeFind(fixture.body(), 'd-pnewpv')), /IO-48394에 붙임/);
});

test('BJCREATE: 확인 줄을 거치지 않으면 만들기 요청이 나가지 않고, 만든 뒤에도 ⌘Z 대상이 아니다', async () => {
  const fixture = projectNewClient({ made: { ...BJC_MADE, children: [BJC_MADE.children[0]], made: 2, failed: 0 } });
  fixture.start();
  fixture.set("projectNew.name = '게시글 작성하기_게임 임베드'; projectNew.project = 'IO'; projectNew.roles = ['Web']");
  const go = nodeFind(fixture.body(), 'pri');
  assert.equal(go.disabled, false);
  go.listeners.click();
  assert.deepEqual(fixture.sent.filter(entry => entry.url === '/api/jira/create'), [], '주 버튼만으로는 아무것도 보내지 않는다');

  const confirm = nodeFind(fixture.body(), 'd-jconfirm');
  assert.match(bjcWords(confirm), /지라에 이슈 2개를 만들까요\? 되돌릴 수 없어요\./);
  bjcButton(confirm, '취소').listeners.click();
  assert.equal(nodeFind(fixture.body(), 'd-jconfirm'), null, '취소는 확인 줄만 닫는다');
  assert.deepEqual(fixture.sent.filter(entry => entry.url === '/api/jira/create'), []);

  nodeFind(fixture.body(), 'pri').listeners.click();
  await bjcButton(nodeFind(fixture.body(), 'd-jconfirm'), '만들기').listeners.click();
  assert.deepEqual(fixture.sent.filter(entry => entry.url === '/api/jira/create'), [{ url: '/api/jira/create', body: { plan: {
    projectKey: 'IO',
    epic: { summary: '게시글 작성하기_게임 임베드' },
    children: [{ summary: '[Web] 게시글 작성하기_게임 임베드', issueTypeId: '10001' }],
  } } }]);
  assert.match(fixture.app.nodes.get('liveRegion').textContent, /지라에 2개를 만들었어요/);
  assert.equal(fixture.app.run('undoStack.length'), 0, '지라에 만드는 것은 앱의 ⌘Z 대상이 아니다');
  assert.match(bjcWords(nodeFind(fixture.body(), 'd-pnewres')), /지라에 2개를 만들었어요/);
});

test('BJCREATE: 부분 실패는 만든 것과 실패한 줄·이유를 보여 주고, 다시 시도는 실패한 것만 보낸다', async () => {
  const fixture = projectNewClient();
  fixture.start();
  fixture.set("projectNew.name = '게시글 작성하기_게임 임베드'; projectNew.project = 'IO'; projectNew.roles = ['Web', 'QA']");
  nodeFind(fixture.body(), 'pri').listeners.click();
  await bjcButton(nodeFind(fixture.body(), 'd-jconfirm'), '만들기').listeners.click();

  const result = nodeFind(fixture.body(), 'd-pnewres');
  assert.equal(bjcText(nodeFind(result, 'hd')), '만들어진 것 2 · 실패 1');
  assert.match(bjcWords(result), /지라에서 이 프로젝트에 이슈를 만들 권한이 없어요/);
  assert.ok(bjcButton(result, '지라에서 열기'));

  // 실패한 줄만, 이미 만든 에픽에 붙여 다시 보낸다(에픽을 두 번 만들지 않는다).
  fixture.app.run(`projectNew.result.children = projectNew.result.children.map(child => child.error ? { ...child } : child);`);
  const again = bjcButton(fixture.body(), '실패한 것 다시 시도');
  fixture.app.run(`lastMade = { ok: true, connected: true, epic: { key: 'IO-48400', url: 'x', summary: 's', created: false },
    children: [{ summary: '[QA] 게시글 작성하기_게임 임베드', key: 'IO-48402', url: 'y' }], made: 1, failed: 0 };`);
  fixture.app.context.fetch = async (url, options) => {
    fixture.sent.push({ url: String(url), body: options && options.body ? JSON.parse(options.body) : null });
    return new Response(JSON.stringify(fixture.app.run('lastMade')));
  };
  await again.listeners.click();
  assert.deepEqual(fixture.sent.slice(-1)[0].body, { plan: {
    projectKey: 'IO',
    epic: { key: 'IO-48400' },
    children: [{ summary: '[QA] 게시글 작성하기_게임 임베드', issueTypeId: '10001' }],
  } });
  assert.equal(bjcText(nodeFind(fixture.body(), 'hd')), '지라에 3개를 만들었어요');
  assert.match(fixture.app.nodes.get('liveRegion').textContent, /남은 것도 다 만들었어요/);
});

test('BJCREATE: `지라 없이`는 첫 할 일이 있어야 하고, 기존 업무 만들기로만 프로젝트를 만든다', async () => {
  const fixture = projectNewClient();
  fixture.start();
  fixture.set("projectNew.mode = 'none'; projectNew.name = '결제 리뉴얼'");
  assert.equal(nodeFind(fixture.body(), 'pri').disabled, true);
  assert.match(bjcWords(nodeFind(fixture.body(), 'd-pnewacts')), /첫 할 일이 있어야 프로젝트가 생겨요/);
  assert.equal(bjcText(nodeFind(fixture.body(), 'pri')), '프로젝트 만들기');

  fixture.set("projectNew.first = '기획 초안 정리하기'");
  await nodeFind(fixture.body(), 'pri').listeners.click();
  assert.deepEqual(fixture.sent.slice(-1), [{ url: '/api/later-task/create', body: { description: '기획 초안 정리하기', group: '결제 리뉴얼' } }]);
  assert.deepEqual(fixture.sent.filter(entry => entry.url === '/api/jira/create'), [], '지라에는 아무것도 보내지 않는다');
  assert.equal(fixture.app.run('openedProject'), 'group:결제 리뉴얼');
  assert.equal(fixture.app.run('projectNew'), null, '만들고 나면 화면을 닫는다');
});

test('BJCREATE: 직군 목록은 설정 세트를 따르고, 줄 편집은 앱의 저장 길로만 나간다', async () => {
  const fixture = projectNewClient({ roles: [{ label: 'Web', prefix: '[Web]' }, { label: 'Data', prefix: '[Data]' }] });
  fixture.start();
  assert.equal(fixture.app.run("projectNewRoles().map(role => role.label).join(',')"), 'Web,Data', '저장된 세트가 있으면 그것을 쓴다');
  fixture.app.run('workflowData.jiraRoles = null');
  assert.equal(fixture.app.run("projectNewRoles().map(role => role.label).join(',')"), 'Web,iOS,Android,Backend,Design,QA', '없으면 기본 세트다');

  fixture.app.run('workflowData.jiraRoles = [{ label: "Web", prefix: "[Web]" }]');
  fixture.set('projectNew.roleEdit = null');
  bjcButton(fixture.body(), '직군 목록 고치기') || nodeFindAll(fixture.body(), 'd-link').find(kid => bjcText(kid) === '직군 목록 고치기').listeners.click();
  const edit = nodeFind(fixture.body(), 'd-pnewedit');
  assert.ok(edit, '그 자리에서 줄 편집이 열린다');
  bjcButton(edit, '직군 추가').listeners.click();
  const lines = nodeFindAll(fixture.body(), 'ln');
  nodeFindAll(lines[1], 'in')[0].listeners.input();
  fixture.app.run('projectNew.roleEdit[1] = { label: "Data", prefix: "[Data]" }');
  await bjcButton(nodeFind(fixture.body(), 'd-pnewedit'), '저장').listeners.click();
  assert.deepEqual(fixture.sent.slice(-1), [{ url: '/api/workflow/jira-roles', body: { roles: [{ label: 'Web', prefix: '[Web]' }, { label: 'Data', prefix: '[Data]' }] } }]);
  assert.match(fixture.app.nodes.get('liveRegion').textContent, /직군 목록을 저장했어요/);
});

// ---------- BJASSIGN: 새로 만든 에픽만 나에게 자동 배정, 프로젝트 목록에 즉시 반영 ----------
test('BJASSIGN: 새 에픽을 만들면 헤더 새로고침과 같은 조용한 길로 지라 목록을 새로 읽고 화면을 다시 받는다(그 순서로)', async () => {
  const fixture = projectNewClient();
  fixture.start();
  fixture.set("projectNew.name = '게시글 작성하기_게임 임베드'; projectNew.project = 'IO'; projectNew.roles = ['Web']");
  const order = [];
  const baseFetch = fixture.app.context.fetch;
  fixture.app.context.fetch = async (url, options) => { order.push(String(url)); return baseFetch(url, options); };
  fixture.app.context.load = async () => { order.push('load'); };
  nodeFind(fixture.body(), 'pri').listeners.click();
  await bjcButton(nodeFind(fixture.body(), 'd-jconfirm'), '만들기').listeners.click();
  assert.deepEqual(order, ['/api/jira/create', '/api/jira/list?fresh=1', 'load'], '에픽을 새로 만들면 만들기 뒤에 조용한 새로고침 → 다시 읽기 순서다');
});

test('BJASSIGN: 이미 있는 에픽에 붙일 때는 지라 목록을 새로 읽지 않는다 — 그 에픽은 재배정하지 않는다', async () => {
  const attachMade = { ok: true, connected: true, epic: { key: 'IO-48394', url: 'https://example-jira.test/browse/IO-48394', summary: '임베드', created: false }, children: [{ summary: '[Web] 임베드', key: 'IO-48401', url: 'x' }], made: 1, failed: 0 };
  const fixture = projectNewClient({ made: attachMade });
  fixture.start();
  fixture.set(`projectNew.mode = 'attach'; projectNew.roles = ['Web']; projectNew.epic = { key: 'IO-48394', summary: '임베드', children: { items: [] } }`);
  const calls = [];
  const baseFetch = fixture.app.context.fetch;
  fixture.app.context.fetch = async (url, options) => { calls.push(String(url)); return baseFetch(url, options); };
  fixture.app.context.load = async () => { calls.push('load'); };
  nodeFind(fixture.body(), 'pri').listeners.click();
  await bjcButton(nodeFind(fixture.body(), 'd-jconfirm'), '만들기').listeners.click();
  assert.deepEqual(calls, ['/api/jira/create'], '있는 에픽에 붙일 때는 새로고침·다시 읽기를 하지 않는다');
});

test('BJASSIGN: 결과 카드는 에픽 배정 실패를 조용한 회색 글자로만 알리고, 하위 줄에는 담당자 문구가 없다', async () => {
  const assignFailedMade = {
    ok: true, connected: true,
    epic: { key: 'IO-48400', url: 'https://example-jira.test/browse/IO-48400', summary: '게시글 작성하기_게임 임베드', created: true, assignError: '지라에서 이 프로젝트에 이슈를 만들 권한이 없어요.' },
    children: [{ summary: '[Web] 게시글 작성하기_게임 임베드', key: 'IO-48401', url: 'x' }],
    made: 2, failed: 0,
  };
  const fixture = projectNewClient({ made: assignFailedMade });
  fixture.start();
  fixture.set("projectNew.name = '게시글 작성하기_게임 임베드'; projectNew.project = 'IO'; projectNew.roles = ['Web']");
  fixture.app.run('load = async () => {};'); // 이 테스트는 새로고침 순서를 보지 않는다
  nodeFind(fixture.body(), 'pri').listeners.click();
  await bjcButton(nodeFind(fixture.body(), 'd-jconfirm'), '만들기').listeners.click();
  const result = nodeFind(fixture.body(), 'd-pnewres');
  const epicRow = nodeFindAll(result, 'kid')[0];
  assert.match(bjcWords(epicRow), /담당자 지정은 안 됐어요 — 지라에서 직접 정해 주세요/);
  const note = nodeFind(epicRow, 'note');
  assert.ok(note, '조용한 회색 글자(.note)로 붙는다 — 급한 색(.er)이 아니다');
  // 하위 줄(두 번째 kid)에는 담당자 관련 문구가 없다 — 하위는 배정을 아예 시도하지 않는다.
  const childRow = nodeFindAll(result, 'kid')[1];
  assert.doesNotMatch(bjcWords(childRow), /담당자/);
});

test('BJASSIGN: 결과 화면의 첫 할 일은 선택이라고 적는다(새 에픽이 이미 배정돼 목록에 뜬 뒤라서)', async () => {
  const fixture = projectNewClient();
  fixture.start();
  fixture.set("projectNew.name = '게시글 작성하기_게임 임베드'; projectNew.project = 'IO'; projectNew.roles = ['Web']");
  nodeFind(fixture.body(), 'pri').listeners.click();
  await bjcButton(nodeFind(fixture.body(), 'd-jconfirm'), '만들기').listeners.click();
  const result = nodeFind(fixture.body(), 'd-pnewres');
  assert.match(bjcWords(nodeFind(result, 'first')), /첫 할 일을 바로 만들 수도 있어요\(선택\)/);
  assert.doesNotMatch(bjcWords(result), /적으면 앱에도 이 프로젝트가 생겨요/, '더는 사실이 아닌 문구는 없앤다');
});

test('BJASSIGN: 에픽 모드에서 첫 할 일을 비워도 확인 줄까지 그대로 진행된다', () => {
  const fixture = projectNewClient();
  fixture.start();
  fixture.set("projectNew.name = '게시글 작성하기_게임 임베드'; projectNew.project = 'IO'; projectNew.roles = ['Web']");
  assert.equal(fixture.app.run('projectNew.first'), '', '첫 할 일 칸을 건드리지 않았다');
  const go = nodeFind(fixture.body(), 'pri');
  assert.equal(go.disabled, false, '첫 할 일이 비어 있어도 눌린다');
  go.listeners.click();
  assert.ok(nodeFind(fixture.body(), 'd-jconfirm'), '확인 줄까지 그대로 간다');
});

// ---------- BWRAP: 오늘 정리 ----------
// 남은 오늘 업무에 `그대로 | 내일 | 나중에 | 완료`를 찍고 **기존 일괄 저장 길**로만 보낸다
// (`/api/workflow/task-batch` — 여러 개 선택 막대와 같은 API·같은 change).
const wrapTask = (id, description, extra = {}) => ({ id, description, type: 'task', status: 'to-do', ...extra });
const WRAP_BUILD = ({ today }) => [
  wrapTask('w1', '알림센터 발송 실패 로그 확인하기', { doing: today, group: '알림센터' }),
  wrapTask('w2', '결제 정산 배치 설계 검토하기', { due: today, group: '결제 리뉴얼' }),
  wrapTask('w3', '가입 약관 문구 확인하기', { due: '2000-01-01', group: '가입 개선' }),
  wrapTask('w4', '운영툴 권한 신청 처리하기', {}),
  wrapTask('d1', '가입 퍼널 대시보드 반영하기', { status: 'done', group: '가입 개선' }),
  wrapTask('d2', '주간 회의 자료 준비하기', { status: 'done' }),
];
function wrapClient(build = WRAP_BUILD) {
  const app = workflowsClient();
  const sent = [];
  const state = { failAt: 0 };
  let token = 0;
  app.context.fetch = async (url, options) => {
    const body = options && options.body ? JSON.parse(options.body) : null;
    sent.push({ url: String(url), body });
    if (state.failAt && sent.length === state.failAt) return new Response('{"ok":false,"error":"저장하지 못했어요"}', { status: 500 });
    token += 1;
    return new Response(JSON.stringify({ ok: true, count: (body && body.ids || []).length, undoToken: `u${token}` }));
  };
  app.run('loads = 0; load = async () => { loads += 1; };');
  const today = app.run('todayStr()');
  const tomorrow = app.run('tomorrowStr()');
  app.context.__tasks = build({ today, tomorrow });
  // 나중에 할 일은 오늘 목록이 아니다 — 대상에 섞이면 안 된다.
  app.context.__later = [{ id: 'later1', description: '나중에 할 일', type: 'task', status: 'to-do' }];
  app.run('taskListsCache = { todayTasks: __tasks, laterTasks: __later }');
  const body = () => app.nodes.get('wrapBody');
  const rows = () => nodeFindAll(body(), 'd-wraprow');
  const pick = (index, label) => {
    const seg = nodeFind(rows()[index], 'd-seg');
    seg.children.find(button => button.textContent === label).listeners.click();
  };
  const foot = () => nodeFind(body(), 'd-wrapfoot');
  const go = () => foot().children[0];
  const cancel = () => foot().children[1];
  return { app, sent, state, today, tomorrow, body, rows, pick, foot, go, cancel };
}

test('BWRAP: 대상은 오늘 목록의 미완료 업무뿐이고, 기본은 전부 `그대로`라 주 버튼이 눌리지 않는다', () => {
  const fixture = wrapClient();
  fixture.app.run('wrapOpen()');
  assert.equal(fixture.app.run('wrapState.rows.map(row => row.id).join(",")'), 'w1,w2,w3,w4',
    '완료한 줄도, 나중에 할 일도 대상이 아니다');
  assert.equal(fixture.app.run('wrapState.rows.every(row => row.choice === "keep")'), true, '앱이 미룰 것을 추측하지 않는다');
  assert.equal(nodeFind(fixture.body(), 'd-wrapsum').textContent, '6개 중 2개 끝냈어요 · 남은 4개');
  assert.equal(fixture.go().textContent, '바꿀 게 없어요');
  assert.equal(fixture.go().disabled, true);

  // 줄은 제목 + `· ● 프로젝트` + 업무 줄과 같은 상태말이다(있는 것만).
  const rows = fixture.rows();
  assert.equal(nodeFind(rows[0], 'ti').textContent, '알림센터 발송 실패 로그 확인하기');
  assert.equal(nodeFind(rows[0], 'd-inproj').children.filter(kid => typeof kid === 'string').join(''), '· 알림센터');
  assert.equal(nodeFind(rows[0], 'm-doing').children.filter(kid => typeof kid === 'string').join(''), '진행 중');
  assert.equal(nodeFind(rows[1], 'm-due').className, 'm-due k-warn', '오늘까지는 주의색 배지다');
  assert.equal(nodeFind(rows[2], 'm-due').className, 'm-due k-neg', '지난 기한은 급함색 배지다');
  assert.equal(nodeFind(rows[3], 'd-meta').children.length, 0, '말할 것이 없으면 아무 칸도 만들지 않는다');
  assert.equal(nodeFind(rows[0], 'd-seg').children.map(button => button.textContent).join(','), '그대로,내일,나중에,완료');
});

test('BWRAP: 남은 오늘 업무가 없으면 창을 열지 않고 한마디만 한다', () => {
  const fixture = wrapClient(() => [wrapTask('d1', '다 끝낸 업무', { status: 'done' })]);
  fixture.app.run('wrapOpen()');
  assert.equal(fixture.app.run('wrapState'), null, '창을 열지 않는다');
  assert.match(fixture.app.nodes.get('liveRegion').textContent, /오늘 할 일을 모두 끝냈어요/);
  assert.equal(fixture.sent.length, 0);
});

test('BWRAP: 주 버튼 라벨은 고른 개수를 따라 바뀌고, 취소는 아무것도 저장하지 않는다', () => {
  const fixture = wrapClient();
  fixture.app.run('wrapOpen()');
  fixture.pick(0, '완료');
  assert.equal(fixture.go().textContent, '정리 끝 — 완료 1', '0인 갈래는 생략한다');
  fixture.pick(1, '내일');
  fixture.pick(2, '내일');
  fixture.pick(3, '나중에');
  assert.equal(fixture.go().textContent, '정리 끝 — 내일 2 · 나중에 1 · 완료 1');
  assert.equal(fixture.go().disabled, false);
  // 다시 `그대로`로 돌리면 그만큼 줄어든다
  fixture.pick(3, '그대로');
  assert.equal(fixture.go().textContent, '정리 끝 — 내일 2 · 완료 1');

  fixture.cancel().listeners.click();
  assert.equal(fixture.app.run('wrapState'), null);
  assert.equal(fixture.sent.length, 0, '고른 것은 버린다 — 아무것도 보내지 않는다');
  assert.equal(fixture.app.run('undoStack.length'), 0);
});

test('BWRAP: `정리 끝`은 갈래마다 한 번씩(완료 → 내일 → 나중에) 기존 일괄 저장 길로 보낸다', async () => {
  const fixture = wrapClient();
  fixture.app.run('wrapOpen()');
  fixture.pick(0, '완료');
  fixture.pick(1, '내일');
  fixture.pick(2, '내일');
  fixture.pick(3, '나중에');
  await fixture.go().listeners.click();

  assert.deepEqual(fixture.sent, [
    { url: '/api/workflow/task-batch', body: { ids: ['w1'], change: { status: 'done' } } },
    { url: '/api/workflow/task-batch', body: { ids: ['w2', 'w3'], change: { scheduled: fixture.tomorrow } } },
    { url: '/api/workflow/task-batch', body: { ids: ['w4'], change: { scheduled: null } } },
  ], '`그대로`인 줄은 어디에도 실리지 않고, 갈래마다 한 번씩만 간다');
  assert.equal(fixture.app.run('loads'), 1);
  assert.equal(fixture.app.run('wrapState'), null, '저장 뒤 창이 닫힌다');
  assert.match(fixture.app.nodes.get('liveRegion').textContent, /오늘 정리했어요 · 내일 2 · 나중에 1 · 완료 1/);
});

test('BWRAP: ⌘Z 항목은 하나이고, 되돌리기는 보낸 차례의 반대로 undoToken을 돌린다', async () => {
  const fixture = wrapClient();
  fixture.app.run('wrapOpen()');
  fixture.pick(0, '완료');
  fixture.pick(1, '내일');
  fixture.pick(3, '나중에');
  await fixture.go().listeners.click();
  assert.equal(fixture.app.run('undoStack.length'), 1, '세 번 보냈어도 되돌릴 항목은 하나다');
  assert.equal(fixture.app.run('undoStack[0].label'), '오늘 정리');

  const before = fixture.sent.length;
  await fixture.app.run("replayUndo('undo')");
  assert.deepEqual(fixture.sent.slice(before).map(entry => entry.body), [
    { undoToken: 'u3' }, { undoToken: 'u2' }, { undoToken: 'u1' },
  ], '나중에 → 내일 → 완료 차례로 되돌린다');
  assert.equal(fixture.app.run('undoStack.length'), 0);
  assert.equal(fixture.app.run('redoStack.length'), 1);
});

test('BWRAP: 중간에 멈추면 성공한 갈래만 ⌘Z에 담고, 창은 닫지 않고 실패한 줄만 남긴다', async () => {
  const fixture = wrapClient();
  fixture.state.failAt = 2; // 완료는 되고 내일에서 멈춘다 — 나중에는 시작하지 않는다
  fixture.app.run('wrapOpen()');
  fixture.pick(0, '완료');
  fixture.pick(1, '내일');
  fixture.pick(2, '내일');
  fixture.pick(3, '나중에');
  await fixture.go().listeners.click();

  assert.equal(fixture.sent.length, 2, '실패한 갈래에서 멈춘다');
  assert.match(fixture.app.nodes.get('liveRegion').textContent, /완료 1개는 옮겼지만 내일 2개는 못 옮겼어요 · 다시 시도해 주세요/);
  assert.equal(fixture.app.run('undoStack.length'), 1, '성공한 갈래만 담는다');
  assert.notEqual(fixture.app.run('wrapState'), null, '창은 닫지 않는다');
  assert.equal(fixture.app.run('wrapState.rows.map(row => row.id + ":" + row.choice).join(",")'),
    'w2:tomorrow,w3:tomorrow,w4:later', '보낸 줄만 빠지고 고른 값은 그대로다');
  assert.equal(fixture.go().textContent, '정리 끝 — 내일 2 · 나중에 1');
  assert.equal(fixture.go().disabled, false, '다시 누를 수 있다');
});

test('BWRAP: `끝낸 것`은 접힌 소제목이고, 0개면 소제목 자체가 없다', () => {
  const fixture = wrapClient();
  fixture.app.run('wrapOpen()');
  const headings = () => nodeFindAll(fixture.body(), 'd-grp').map(head => nodeFind(head, 'gl').textContent);
  assert.deepEqual(headings(), ['끝낸 것', '남은 것']);
  assert.equal(nodeFindAll(fixture.body(), 'd-wrapdone').length, 0, '처음에는 접혀 있다');

  nodeFindAll(fixture.body(), 'd-grp')[0].listeners.click();
  assert.deepEqual(nodeFindAll(fixture.body(), 'd-wrapdone').map(row => row.textContent),
    ['가입 퍼널 대시보드 반영하기', '주간 회의 자료 준비하기']);

  const none = wrapClient(({ today }) => [wrapTask('w1', '남은 업무', { doing: today })]);
  none.app.run('wrapOpen()');
  assert.deepEqual(nodeFindAll(none.body(), 'd-grp').map(head => nodeFind(head, 'gl').textContent), ['남은 것']);
  assert.equal(nodeFind(none.body(), 'd-wrapsum').textContent, '1개 중 0개 끝냈어요 · 남은 1개');
});

// ---------- BATTENTION: 오늘 탭 맨 위의 `반응 필요` (1차 지라 댓글) ----------
// 값은 `GET /api/attention`에서만 오고, 저장하는 것은 치운 줄의 id 하나뿐이다.
// 여기 나오는 이름·댓글·티켓 번호는 전부 지어낸 것이다(실제 지라에는 닿지 않는다).
const attentionAgo = minutes => new Date(Date.now() - minutes * 60000).toISOString();
const attentionItem = (over = {}) => ({
  id: 'jira:IO-48394:10001', source: 'jira', key: 'IO-48394', url: 'https://fake-jira.test/browse/IO-48394',
  summary: '게시글 작성하기_게임 임베드', status: '배포 대기', statusTone: 'doing',
  who: '테스터A', others: 0, count: 1, preview: '해외 서버에서는 안 뜨나요?',
  at: attentionAgo(120), mention: false, ...over,
});
function attentionClient(answer = {}) {
  const app = workflowsClient();
  const sent = [];
  const state = { answer: { ok: true, connected: true, items: [attentionItem()], updatedAt: attentionAgo(3), stale: false, ...answer }, fail: null };
  app.context.fetch = async (url, options) => {
    const body = options && options.body ? JSON.parse(options.body) : null;
    sent.push({ url: String(url), body });
    if (state.fail && String(url) === state.fail) return new Response('{"ok":false,"error":"저장하지 못했어요"}', { status: 500 });
    if (String(url).startsWith('/api/attention?') || String(url) === '/api/attention') return new Response(JSON.stringify(state.answer));
    return new Response(JSON.stringify({ ok: true, id: 'made-task-1' }));
  };
  app.run('loads = 0; load = async () => { loads += 1; };');
  const zone = () => app.nodes.get('attentionZone');
  const rows = () => nodeFindAll(app.nodes.get('attentionList'), 'd-atrow');
  const button = (row, label) => nodeFindAll(row, 'd-btn').find(node => node.textContent === label);
  return { app, sent, state, zone, rows, button, notice: () => app.nodes.get('liveRegion').textContent };
}

test('BATTENTION: 0개이거나 연결이 없으면 구역 자체가 없다 — 빈 말도 없다', async () => {
  const empty = attentionClient({ items: [] });
  await empty.app.run('attentionLoad()');
  assert.equal(empty.zone().hidden, true);
  assert.equal(empty.rows().length, 0);

  const off = attentionClient({ connected: false, items: [attentionItem()] });
  await off.app.run('attentionLoad()');
  assert.equal(off.zone().hidden, true, '연결이 없으면 값이 와도 그리지 않는다');

  // 이 주소를 모르는 옛 서버(404)도 조용히 지나간다.
  const old = attentionClient();
  old.app.context.fetch = async () => new Response('Not found', { status: 404 });
  await old.app.run('attentionLoad()');
  assert.equal(old.zone().hidden, true);
});

test('BATTENTION: 머리줄은 개수만 적고 평소에는 문구가 없다(다른 구역 제목과 같은 리듬) — 값이 묵었을 때만 `N시간 전 기준`을 밝힌다', async () => {
  const fixture = attentionClient();
  await fixture.app.run('attentionLoad()');
  assert.equal(fixture.zone().hidden, false);
  assert.equal(fixture.app.nodes.get('attentionCount').textContent, '1');
  assert.equal(fixture.app.nodes.get('attentionNote').hidden, true, '평소에는 `지라 댓글 · N분 전`처럼 적지 않는다 — 작동 여부는 설정 > 상태에서 본다');

  const stale = attentionClient({ stale: true, updatedAt: attentionAgo(180) });
  await stale.app.run('attentionLoad()');
  assert.equal(stale.app.nodes.get('attentionNote').hidden, false);
  assert.equal(stale.app.nodes.get('attentionNote').textContent, '3시간 전 기준');
  assert.equal(stale.app.nodes.get('attentionNote').className, 'd-quiet k-warn', '주의색 글자다');
});

test('BATTENTION: 줄 앞에 출처 이름표(지라)가 붙는다', async () => {
  const fixture = attentionClient();
  await fixture.app.run('attentionLoad()');
  assert.equal(nodeFind(fixture.rows()[0], 'sc').textContent, '지라');
});

test('BATTENTION: 줄은 요약·`누가 · 언제`·미리보기이고 키는 툴팁과 `열기`에만 있다 — 지라 상태는 적지 않는다', async () => {
  const fixture = attentionClient({ items: [attentionItem({ who: '테스터A', others: 1, count: 2, mention: true, statusTone: 'done', status: '완료' })] });
  await fixture.app.run('attentionLoad()');
  const [row] = fixture.rows();
  const title = nodeFind(row, 'ti');
  assert.equal(title.textContent, '게시글 작성하기_게임 임베드', '줄에는 요약만 적는다');
  assert.equal(title.title, 'IO-48394 · 게시글 작성하기_게임 임베드', '키는 툴팁에만');
  assert.equal(nodeFind(row, 'st'), null, '지라 상태는 반응 필요 줄에서 말하지 않는다(정보가 두 겹이라 뺐다)');
  assert.equal(nodeFind(row, 'wh').textContent, '테스터A 외 1명 · 2시간 전');
  assert.equal(nodeFind(row, 'mn').textContent, '@멘션');
  assert.equal(nodeFind(row, 'mn').className, 'mn k-warn');
  assert.equal(nodeFind(row, 'pv').textContent, '해외 서버에서는 안 뜨나요?');
  assert.equal(nodeFind(row, 'ct').textContent, '· 댓글 2개');
  const open = nodeFind(row, 'd-src');
  assert.deepEqual([open.textContent, open.href, open.target], ['열기', 'https://fake-jira.test/browse/IO-48394', '_blank']);
  assert.equal(nodeFind(row, 'd-pjdot').dataset.pj, fixture.app.run("String(uiProjectHue('jira:IO-48394'))"));

  // 댓글이 하나뿐이면 `댓글 N개`를 찍지 않고, 부름이 없으면 배지도 없다.
  const one = attentionClient();
  await one.app.run('attentionLoad()');
  assert.equal(nodeFind(one.rows()[0], 'ct'), null);
  assert.equal(nodeFind(one.rows()[0], 'mn'), null);
});

test('BATTENTION: `했어요`는 그 줄만 치우고 알림의 `되돌리기`로 되돌린다 — ⌘Z 대상이 아니다', async () => {
  const fixture = attentionClient({ items: [attentionItem(), attentionItem({ id: 'jira:IO-48395:20002', key: 'IO-48395', summary: '정산 배치' })] });
  await fixture.app.run('attentionLoad()');
  await fixture.button(fixture.rows()[0], '했어요').listeners.click();
  assert.deepEqual(fixture.sent[fixture.sent.length - 1], { url: '/api/attention/dismiss', body: { id: 'jira:IO-48394:10001' } });
  assert.deepEqual(fixture.rows().map(row => nodeFind(row, 'ti').textContent), ['정산 배치'], '그 줄만 사라진다');
  assert.match(fixture.notice(), /반응 필요에서 치웠어요 · 게시글 작성하기_게임 임베드/);
  assert.equal(fixture.app.run('undoStack.length'), 0, '바깥 상태와 얽힌 표시라 ⌘Z 대상이 아니다');

  // 알림의 `되돌리기`는 반대 방향으로 한 번 더 보내고 목록을 다시 읽는다.
  const undo = fixture.app.nodes.get('liveRegion').children.find(node => node.textContent === '되돌리기');
  await undo.listeners.click();
  assert.equal(fixture.sent[fixture.sent.length - 2].url, '/api/attention/undismiss');
  assert.deepEqual(fixture.sent[fixture.sent.length - 2].body, { id: 'jira:IO-48394:10001' });
  assert.equal(fixture.sent[fixture.sent.length - 1].url, '/api/attention', '되돌린 뒤 목록을 다시 읽는다');
  assert.equal(fixture.rows().length, 2);
});

test('BATTENTION: 치우기가 실패하면 줄이 그대로 남고 알림도 치웠다고 하지 않는다', async () => {
  const fixture = attentionClient();
  fixture.state.fail = '/api/attention/dismiss';
  await fixture.app.run('attentionLoad()');
  await fixture.button(fixture.rows()[0], '했어요').listeners.click();
  assert.equal(fixture.rows().length, 1);
  assert.doesNotMatch(fixture.notice(), /치웠어요/);
});

test('BATTENTION: `할 일로`는 `후속 할 일`과 같은 입력칸이고, 만들면 그 줄을 치운다', async () => {
  const fixture = attentionClient();
  await fixture.app.run('attentionLoad()');
  fixture.button(fixture.rows()[0], '할 일로').listeners.click();
  const form = nodeFind(fixture.rows()[0], 'is-ed');
  const input = nodeFind(form, 'd-din');
  assert.equal(input.value, '댓글 답하기 — 게시글 작성하기_게임 임베드', '미리 채운다');
  assert.equal(input.selected, true, '전체 선택된 채로 연다');
  assert.deepEqual(form.children.filter(node => node.className === 'd-btn sm').map(node => node.textContent), ['오늘', '나중에']);

  // 한글을 조합하는 중의 Enter는 글자를 확정하는 것이라 넘긴다.
  const before = fixture.sent.length;
  await input.listeners.keydown({ key: 'Enter', isComposing: true, preventDefault() {} });
  assert.equal(fixture.sent.length, before);

  await input.listeners.keydown({ key: 'Enter', isComposing: false, preventDefault() {} });
  const made = fixture.sent[before];
  assert.equal(made.url, '/api/today-task/create', 'Enter는 오늘 할 일이다');
  assert.deepEqual(made.body, { description: '댓글 답하기 — 게시글 작성하기_게임 임베드', jira: 'IO-48394' });
  assert.equal(fixture.sent[before + 1].url, '/api/attention/dismiss', '업무를 만든 것이 곧 반응한 것이다');
  assert.equal(fixture.app.run('undoStack.length'), 1, '만든 업무는 ⌘Z로 지운다(기존 등록 규칙)');
  assert.equal(fixture.rows().length, 0);
  assert.match(fixture.notice(), /오늘 할 일에 추가했어요/);
});

test('BATTENTION: `나중에`로 담을 수도 있고, Esc는 입력칸만 닫는다', async () => {
  const fixture = attentionClient();
  await fixture.app.run('attentionLoad()');
  fixture.button(fixture.rows()[0], '할 일로').listeners.click();
  let form = nodeFind(fixture.rows()[0], 'is-ed');
  // Esc는 입력만 닫는다 — 줄은 그대로 남는다.
  fixture.app.run('escStack[escStack.length - 1]()');
  assert.equal(nodeFind(fixture.rows()[0], 'is-ed'), null);
  assert.equal(fixture.rows().length, 1);

  fixture.button(fixture.rows()[0], '할 일로').listeners.click();
  form = nodeFind(fixture.rows()[0], 'is-ed');
  await form.children.find(node => node.textContent === '나중에').listeners.click();
  assert.equal(fixture.sent[fixture.sent.length - 2].url, '/api/later-task/create');
  assert.equal(fixture.sent[fixture.sent.length - 1].url, '/api/attention/dismiss');
});

test('BATTENTION: 여덟 줄까지 보이고 나머지는 `외 N개 보기`로 편다', async () => {
  const many = Array.from({ length: 11 }, (unused, index) => attentionItem({ id: `jira:IO-4839${index}:1000${index}`, key: `IO-4839${index}`, summary: `댓글 ${index}` }));
  const fixture = attentionClient({ items: many });
  await fixture.app.run('attentionLoad()');
  assert.equal(fixture.rows().length, 8);
  assert.equal(fixture.app.nodes.get('attentionCount').textContent, '11', '개수 칩은 안 보이는 줄까지 센다');
  const more = nodeFind(fixture.app.nodes.get('attentionList'), 'd-atmore');
  assert.equal(more.textContent, '외 3개 보기');
  more.listeners.click();
  assert.equal(fixture.rows().length, 11);
  assert.equal(nodeFind(fixture.app.nodes.get('attentionList'), 'd-atmore'), null, '다시 접는 길은 없다');
});

test('BATTENTION: 헤더 새로고침은 다음 읽기 한 번만 `fresh=1`로 묻는다', async () => {
  const fixture = attentionClient();
  await fixture.app.run('attentionLoad()');
  assert.equal(fixture.sent[0].url, '/api/attention');
  // 새로고침 버튼이 지나는 길 — 지라 목록과 같은 방식으로 표시만 남긴다.
  await fixture.app.run('refreshListsFromServer()');
  assert.equal(fixture.app.run('attentionWantFresh'), true);
  await fixture.app.run('attentionLoad()');
  assert.equal(fixture.sent[fixture.sent.length - 1].url, '/api/attention?fresh=1');
  await fixture.app.run('attentionLoad()');
  assert.equal(fixture.sent[fixture.sent.length - 1].url, '/api/attention', '한 번만 쓰인다');
});

test('BATTENTION: 설정 > 상태에는 `반응 필요 · 지라 댓글` 한 줄이 선다', async () => {
  const fixture = attentionClient();
  await fixture.app.run('attentionLoad()');
  const row = fixture.app.run('attentionStatusRow()');
  assert.equal(nodeFind(row, 'nm').textContent, '반응 필요 · 지라 댓글');
  assert.equal(nodeFind(row, 'st').textContent, '3분 전 확인');
  assert.equal(row.dataset.automation, 'attention');

  const broken = attentionClient({ items: [], updatedAt: null, stale: false, error: '지라 댓글을 읽지 못했어요.' });
  await broken.app.run('attentionLoad()');
  const failed = broken.app.run('attentionStatusRow()');
  assert.equal(nodeFind(failed, 'st').textContent, '지라 댓글을 읽지 못했어요.');
  assert.equal(nodeFind(failed, 'st').className, 'st k-neg');
  assert.equal(broken.zone().hidden, true, '실패해도 구역은 서지 않는다 — 상태는 설정에서 본다');

  const off = attentionClient({ connected: false, items: [] });
  await off.app.run('attentionLoad()');
  assert.equal(off.app.run('attentionStatusRow()'), null, '연결이 없으면 줄 자체가 없다');
});

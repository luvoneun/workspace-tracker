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
      // 새 꺾쇠 아이콘(settingsChevron)은 innerHTML 없이 SVG 요소로 만든다 — 가짜 창에서는 같은 가짜 노드다.
      createElementNS: (ns, tag) => element(),
    },
    // 기본은 다른 기기에서 연 주소 — `다른 기기` 줄(이 맥에서만)이 필요한 테스트는 localhost로 바꿔 끼운다.
    location: { hostname: 'example.test' },
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

// 입력 씹힘: 저장 응답을 손으로 풀어 주는 가짜 서버. 보낸 순서·본문을 그대로 모은다.
function heldFetch(app) {
  const held = [];
  app.context.fetch = (url, options) => new Promise(resolve => held.push({
    url, body: options && options.body ? JSON.parse(options.body) : null,
    ok: () => resolve(new Response('{"ok":true}')),
    fail: () => resolve(new Response('{"ok":false}', { status: 500 })),
  }));
  return held;
}
const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise(resolve => setImmediate(resolve)); };

test('입력 씹힘 ①: Enter 뒤 칸은 잠그지 않고 바로 비운다 — 응답이 느려도 그 사이 친 글자는 남고, 응답 뒤에 늦게 비우지 않는다', async () => {
  const app = client(new Response('{"ok":true}'));
  const held = heldFetch(app);
  app.run("setupQuickAdd('draft', '/api/today-task/create', '추가함')");
  const input = app.nodes.get('draft');
  input.value = 'first task A';
  const sending = input.listeners.keydown({ key: 'Enter', isComposing: false });
  assert.equal(input.disabled, false, '저장 중에도 칸은 잠기지 않는다(잠기면 브라우저가 글자를 버린다)');
  assert.equal(input.value, '', 'Enter 순간 칸을 비운다');
  input.value = 'second typed fast';
  await settle();
  assert.equal(held.length, 1);
  assert.deepEqual(held[0].body, { description: 'first task A' });
  held[0].ok();
  await sending;
  assert.equal(input.value, 'second typed fast', '저장 응답 뒤에 칸을 비우지 않는다 — 그 사이 친 글자가 그대로다');
  assert.equal(input.disabled, false);
});

test('입력 씹힘 ①: 연속 Enter 두 건은 앞 건이 끝난 뒤 순서대로 보내고, 같은 글을 두 번 쳐도 각각 저장한다', async () => {
  const app = client(new Response('{"ok":true}'));
  const held = heldFetch(app);
  app.run("setupQuickAdd('draft', '/api/today-task/create', '추가함')");
  const input = app.nodes.get('draft');
  const enter = text => { input.value = text; return input.listeners.keydown({ key: 'Enter', isComposing: false }); };
  const first = enter('third A');
  const second = enter('fourth B');
  const third = enter('fourth B');
  await settle();
  assert.equal(held.length, 1, '앞 건이 끝나기 전에는 다음 건을 보내지 않는다(순서가 뒤집히지 않게)');
  held[0].ok(); await settle();
  assert.equal(held.length, 2);
  held[1].ok(); await settle();
  held[2].ok();
  await Promise.all([first, second, third]);
  assert.deepEqual(held.map(call => call.body.description), ['third A', 'fourth B', 'fourth B'], '빠짐없이·순서대로, 같은 글도 각각');
  assert.equal(input.value, '');
  // 빈 글 Enter는 아무 일도 하지 않는다.
  await enter('   ');
  await settle();
  assert.equal(held.length, 3);
});

test('입력 씹힘 ①: 첫 건만 실패하면 둘째는 그대로 저장되고, 칸이 비었으면 실패한 글을 되돌리고 차 있으면 덮어쓰지 않고 알린다', async () => {
  const app = client(new Response('{"ok":true}'));
  const held = heldFetch(app);
  app.run("setupQuickAdd('draft', '/api/today-task/create', '추가함')");
  const input = app.nodes.get('draft');
  const enter = text => { input.value = text; return input.listeners.keydown({ key: 'Enter', isComposing: false }); };
  // 칸이 비어 있을 때 실패 → 글이 칸에 돌아온다.
  const lone = enter('실패할 글');
  await settle();
  held[0].fail();
  await lone;
  assert.equal(input.value, '실패할 글', '실패해도 적은 글은 남는다');
  assert.equal(input.focused, true);
  // 두 건 중 첫 건만 실패, 그 사이 칸에 새 글을 치는 중 → 덮어쓰지 않고 어떤 글이 안 됐는지 알린다.
  const one = enter('첫 건');
  const two = enter('둘째 건');
  input.value = '셋째를 치는 중';
  await settle();
  held[1].fail(); await settle();
  assert.equal(input.value, '셋째를 치는 중', '치던 글을 덮어쓰지 않는다');
  assert.equal(held.length, 3, '앞 건이 실패해도 다음 건은 보낸다');
  assert.deepEqual(held[2].body, { description: '둘째 건' });
  held[2].ok();
  await Promise.all([one, two]);
  await settle();
  assert.equal(input.value, '셋째를 치는 중');
  assert.match(app.nodes.get('liveRegion').textContent, /“첫 건” 저장됐는지 확인하지 못했어요\. 칸에 다른 글이 있어 되돌리지 않았어요/,
    '뒤 건의 `저장했어요`가 덮지 않게 대기열이 끝난 뒤 알린다');
});

test('입력 씹힘 ①: 한글 조합 중 Enter는 넘기고(칸도 그대로), 조합이 끝난 뒤 Enter에서 한 번만 보낸다', async () => {
  const app = client(new Response('{"ok":true}'));
  const held = heldFetch(app);
  app.run("setupQuickAdd('draft', '/api/today-task/create', '추가함')");
  const input = app.nodes.get('draft');
  input.value = '조합 시험 글';
  await input.listeners.keydown({ key: 'Enter', isComposing: true });
  assert.equal(input.value, '조합 시험 글', '조합 중 Enter는 글자를 확정할 뿐이다');
  assert.equal(held.length, 0);
  const sending = input.listeners.keydown({ key: 'Enter', isComposing: false });
  await settle();
  assert.equal(held.length, 1);
  held[0].ok();
  await sending;
  assert.equal(held.length, 1, '한 번만 보낸다');
});

test('입력 씹힘 ①: 그룹 `+` 줄도 잠그지 않고 순서대로 보내며, 칸이 사라진 뒤 온 실패는 알림만 한다', async () => {
  const app = pureClient();
  const held = heldFetch(app);
  app.run("var __row = uiGroupAddRow('group:게임', '/api/today-task/create', 'x'); __row.hidden = false; var __input = __row.children[0];");
  const input = app.run('__input');
  const enter = text => { input.value = text; return input.listeners.keydown({ key: 'Enter', isComposing: false }); };
  const one = enter('그룹 첫 건');
  assert.equal(input.disabled, false);
  assert.equal(input.value, '');
  const two = enter('그룹 둘째 건');
  input.value = '그룹 셋째';
  await settle();
  assert.equal(held.length, 1);
  assert.deepEqual(held[0].body, { description: '그룹 첫 건', group: '게임' });
  held[0].ok(); await settle();
  assert.deepEqual(held[1].body, { description: '그룹 둘째 건', group: '게임' });
  // 다른 탭으로 옮겨 칸이 사라졌다 — 되돌릴 자리가 없으니 알림만.
  input.connected = false;
  held[1].fail();
  await Promise.all([one, two]);
  await settle();
  assert.match(app.nodes.get('liveRegion').textContent, /“그룹 둘째 건” 저장됐는지 확인하지 못했어요/);
  assert.equal(input.value, '그룹 셋째');
});

test('입력 씹힘 ①: 주간요약 문장 줄도 잠그지 않는다 — 담는 동안 새로 친 글은 성공 뒤에도 남는다', async () => {
  const app = reportClient();
  await app.run(`(async () => {
    sent = [];
    release = [];
    load = async () => {};
    renderReportDraft = () => {};
    reportChange = (item, action) => new Promise(resolve => { sent.push(action.text); release.push(resolve); });
    item = { weekKey: 'W', draft: { rows: [] } };
    el = reportPlanInput(item, { key: 'new', id: 'reportPlanInput', placeholder: '', label: '', groupOf: () => '', alsoTaskOf: () => false });
    el.value = '첫 문장';
    el.listeners.input();
    p1 = el.listeners.keydown({ key: 'Enter', isComposing: false, shiftKey: false, preventDefault() {} });
    afterEnter = { disabled: el.disabled, value: el.value, draft: reportEdits.get('W:new') };
    el.value = '둘째 문장';
    el.listeners.input();
    p2 = el.listeners.keydown({ key: 'Enter', isComposing: false, shiftKey: false, preventDefault() {} });
    el.value = '셋째를 치는 중';
    el.listeners.input();
  })()`);
  await settle();
  assert.deepEqual(JSON.parse(app.run('JSON.stringify(afterEnter)')), { disabled: false, value: '' }, 'Enter 순간 칸을 비우고 잠그지 않는다');
  assert.deepEqual(JSON.parse(app.run('JSON.stringify(sent)')), ['첫 문장'], '앞 문장이 끝나기 전에는 다음을 보내지 않는다');
  app.run('release[0]()'); await settle();
  app.run('release[1]()'); await settle();
  await app.run('Promise.all([p1, p2])');
  assert.deepEqual(JSON.parse(app.run('JSON.stringify(sent)')), ['첫 문장', '둘째 문장']);
  assert.equal(app.run("reportEdits.get('W:new')"), '셋째를 치는 중', '성공 뒤에 늦게 비우지 않는다');
});

test('입력 씹힘 ①: 확인 대기 `다음은?` 입력줄은 보내는 동안 칸을 잠그지 않고, 두 번 눌러도 한 번만 보낸다', async () => {
  const app = pureClient();
  await app.run(`(async () => {
    calls = 0; release = null;
    bar = document.createElement('div'); host = document.createElement('div'); host.appendChild(bar);
    form = waitingNextEdit(bar, { value: '후속', label: '후속 할 일', buttons: [['today', '오늘']],
      onSubmit: () => { calls += 1; return new Promise(resolve => { release = resolve; }); } });
    p1 = form.input.listeners.keydown({ key: 'Enter', isComposing: false, preventDefault() {} });
    p2 = form.input.listeners.keydown({ key: 'Enter', isComposing: false, preventDefault() {} });
    during = form.input.disabled;
  })()`);
  assert.equal(app.run('during'), false, '보내는 중에도 칸은 잠그지 않는다');
  assert.equal(app.run('calls'), 1, '두 번 눌러도 한 번만 보낸다');
  app.run('release()');
  await app.run('Promise.all([p1, p2])');
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
const CLIENT_PARTS = ['jira-ui.js', 'meeting-notes-ui.js', 'project-new-ui.js', 'projects-ui.js', 'meetings-ui.js', 'waiting-ui.js', 'settings-ui.js', 'selfcheck-ui.js', 'wrap-ui.js', 'attention-ui.js'];
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
  const both = row("{ doing: '2000-01-01', scheduled: '2000-01-01' }", ", waiting: 'answered'");
  assert.match(both, /답변 왔어요/, '진행 중이어도 답변 상태는 선다');
  assert.doesNotMatch(both, /m-doing|일째/, '진행 중 줄에는 며칠째·밀림이 없다');
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

// WP-T 시안 A: 진행 중인 업무는 체크박스 안 왼쪽 절반이 찬다. 밀림 대신 조용한 `N일째`(첫날은 비움).
test('진행 중인 업무는 체크박스가 반쯤 차고 이름표에 진행 중을 품는다', () => {
  const app = pureClient();
  const cell = (item, done = 'false') => JSON.parse(app.run(`(() => {
    const cell = uiCheckCell(${item}, document.createElement('div'), ${done});
    const box = cell.children[0];
    return JSON.stringify({ cls: box.className, label: box.getAttribute('aria-label'), title: box.title || null, html: cell.html });
  })()`));
  const base = { id: 't', description: '운영툴 권한 정리', doing: '2000-01-01' };
  const doing = cell(JSON.stringify(base));
  assert.equal(doing.cls, 'd-cb is-doing');
  assert.equal(doing.label, '운영툴 권한 정리 — 진행 중 · 완료로 표시');
  assert.equal(doing.title, '진행 중인 업무예요');
  const both = cell(JSON.stringify({ ...base, priority: 'critical' }));
  assert.equal(both.cls, 'd-cb is-pri-top is-doing', '우선순위와 함께면 꺾쇠도 그대로 선다');
  assert.match(both.html, /class="d-pri"/);
  assert.equal(both.label, '운영툴 권한 정리 — 긴급 · 진행 중 · 완료로 표시');
  assert.equal(both.title, '가장 먼저 해야 하는 업무예요 · 진행 중인 업무예요');
  const done = cell(JSON.stringify(base), 'true');
  assert.equal(done.cls, 'd-cb', '완료한 업무는 평소의 체크다');
  assert.equal(done.label, '운영툴 권한 정리 — 완료로 표시');
  const plain = cell(JSON.stringify({ id: 't', description: '운영툴 권한 정리' }));
  assert.equal(plain.cls, 'd-cb', '진행 중을 풀면 평소 체크박스로 돌아온다');
});

test('진행 중인 업무 줄에는 밀림도 며칠째도 없다(체크박스가 말함) — 풀면 밀림이 돌아온다', () => {
  const app = pureClient();
  const row = (item, extra = '') => app.run(`uiMetaCells(${item}, { noPriority: true${extra} })`);
  const doing = row("{ scheduled: '2000-01-01', doing: '2000-01-02' }");
  assert.doesNotMatch(doing, /m-carry|밀림/, '진행 중이면 밀림을 붙이지 않는다');
  assert.equal(doing, '', '체크박스 줄은 며칠째도 `진행 중` 글자도 없다(사용자 요청)');
  assert.equal(row("{ scheduled: '2000-01-01', doing: '2000-01-02' }", ', inDoingGroup: true'), '', '진행 중 묶음 안에서도 같다');
  assert.match(row("{ scheduled: '2000-01-01' }"), /m-carry.*\d+일째 밀림/s, '진행 중을 풀면 밀림이 돌아온다');
  // 기한 지남 + 진행 중: 기한 배지는 그대로, 밀림은 없다.
  const late = row("{ scheduled: '2000-01-01', doing: '2000-01-02', due: '2000-01-03' }", ', inDoingGroup: true');
  assert.match(late, /m-due k-neg.*기한 \d+일 지남/s);
  assert.doesNotMatch(late, /m-doing|일째/);
  assert.doesNotMatch(late, /밀림/);
  // 기한 때문에 들어온 업무(예정일 없음·미래)는 밀림이 아니다.
  assert.doesNotMatch(row("{ due: '2000-01-03' }"), /밀림/);
  assert.doesNotMatch(row("{ scheduled: '2999-01-01', due: todayStr() }"), /밀림/);
  // 체크박스가 없는 자리(미루기 제안 줄)는 `진행 중` 글자만(며칠째 없음).
  const plainRow = app.run("uiMetaCells({ doing: '2000-01-02' })");
  assert.match(plainRow, /m-doing.*진행 중/s);
  assert.doesNotMatch(plainRow, /일째/);
});

// WP-T: 기한 때문에 오늘 목록에 선 업무는 예정일만 미뤄도 목록에 남는다 — 미루기 알림이 사실대로 말한다.
test('기한이 오늘·지난 업무를 미루면 알림이 오늘 목록에 남는다고 말한다', () => {
  const app = pureClient();
  const note = (items, scheduled) => app.run(`uiMoveNotice(${JSON.stringify(items[0])}, ${JSON.stringify(items.slice(1))}, ${scheduled})`);
  assert.equal(note(['내일로 미뤘어요', { due: '2000-01-01' }], 'tomorrowStr()'),
    '내일로 미뤘어요 · 기한이 지나 오늘 목록에는 남아요 — 기한을 바꾸면 빠져요');
  assert.equal(note(['나중에 할 일로 옮겼어요 · 기한은 그대로예요', { due: app.run('todayStr()') }], 'null'),
    '나중에 할 일로 옮겼어요 · 기한이 오늘이라 오늘 목록에는 남아요 — 기한을 바꾸면 빠져요');
  assert.equal(note(['내일로 미뤘어요', { due: '2999-01-01' }], 'tomorrowStr()'), '내일로 미뤘어요', '기한이 미래면 그대로');
  assert.equal(note(['내일로 미뤘어요', {}], 'tomorrowStr()'), '내일로 미뤘어요', '기한이 없으면 그대로');
  assert.equal(note(['오늘 할 일로 옮겼어요', { due: '2000-01-01' }], 'todayStr()'), '오늘 할 일로 옮겼어요', '오늘로 옮기면 덧붙이지 않는다');
  // 여러 개 선택·오늘 정리: 남는 것만 센다.
  assert.equal(app.run(`uiDueStaysNote([{ due: '2000-01-01' }, { due: todayStr() }, { due: '2999-01-01' }], null)`),
    '2개는 기한이 오늘이거나 지나 오늘 목록에는 남아요 — 기한을 바꾸면 빠져요');
  // 하루 마무리 줄도 진행 중이면 밀림을 붙이지 않는다(풀면 돌아온다).
  const wrapKinds = item => app.run(`wrapMetaCells(${item}).map(cell => cell.className).join(' ')`);
  assert.equal(wrapKinds("{ scheduled: '2000-01-01', doing: '2000-01-02' }"), 'm-doing', '진행 중이면 밀림 칸이 없다');
  assert.equal(wrapKinds("{ scheduled: '2000-01-01' }"), 'm-carry', '진행 중을 풀면 밀림이 돌아온다');
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

// ---------- BJALIAS: 지라 프로젝트 앱 안 별칭 ----------
// 규칙은 하나 — 별칭이 있으면 앱 안 어디서나(uiProjectName·uiGroupLabel·uiGroupLabels·wfProjects) 그
// 이름이다. 캐시에 요약이 없어도(내 담당 목록 밖) 별칭만 있으면 이름이 있는 것으로 본다.
test('BJALIAS: uiProjectName·uiGroupLabel은 별칭이 있으면 그 이름을 쓰고, 없으면 요약이다', () => {
  const app = pureClient();
  app.run("jiraIssuesByKey = new Map([['AB-1', { key: 'AB-1', summary: '[Q4] 결제 리뉴얼 v2 (iOS/AOS)' }]])");
  app.run("projectAliasesCache = { 'AB-1': '결제 리뉴얼' }");
  assert.equal(app.run("uiProjectName({ jira: 'AB-1' })"), '결제 리뉴얼');
  assert.equal(app.run("uiProjectName({ jira: 'AB-1' }, { withKey: true })"), 'AB-1 · 결제 리뉴얼');
  assert.equal(app.run("uiProjectName({ jira: 'AB-1' }, { picker: true })"), '결제 리뉴얼 · AB-1');
  assert.equal(app.run("uiGroupLabel('jira:AB-1')"), '결제 리뉴얼');
  assert.equal(app.run("uiGroupLabel('jira:AB-1', { withKey: true })"), 'AB-1 · 결제 리뉴얼');
  // 캐시에 없는(내 담당 목록 밖) 티켓도 별칭만 있으면 이름이 있는 것으로 본다 — 키만 보이지 않는다.
  app.run("projectAliasesCache = { 'ZZ-9': '모르는 프로젝트' }");
  assert.equal(app.run("uiProjectName({ jira: 'ZZ-9' })"), '모르는 프로젝트');
  assert.equal(app.run("uiProjectName({ jira: 'ZZ-9' }, { withKey: true })"), 'ZZ-9 · 모르는 프로젝트');
  // 별칭이 없으면 예전처럼 요약(모르면 키) 그대로다.
  app.run("projectAliasesCache = {}");
  assert.equal(app.run("uiProjectName({ jira: 'AB-1' })"), '[Q4] 결제 리뉴얼 v2 (iOS/AOS)');
});
test('BJALIAS: uiGroupLabels — 별칭 두 개가 같은 글자면 그때만 키로 구분한다', () => {
  const app = pureClient();
  app.run(`jiraIssuesByKey = new Map([
    ['AB-1', { key: 'AB-1', summary: '결제 정산 API' }],
    ['CD-2', { key: 'CD-2', summary: '알림 발송 정리' }],
  ]); projectAliasesCache = { 'AB-1': '정산', 'CD-2': '정산' };`);
  const dupes = JSON.parse(app.run("JSON.stringify([...uiGroupLabels(['jira:AB-1', 'jira:CD-2'])])"));
  assert.deepEqual(dupes, [['jira:AB-1', 'AB-1 · 정산'], ['jira:CD-2', 'CD-2 · 정산']], '별칭이 같은 글자로 겹치면 키로 구분한다');
  app.run("projectAliasesCache = { 'AB-1': '정산' };"); // CD-2는 별칭 없이 요약 그대로 → 겹치지 않는다
  const alone = JSON.parse(app.run("JSON.stringify([...uiGroupLabels(['jira:AB-1', 'jira:CD-2'])])"));
  assert.deepEqual(alone, [['jira:AB-1', '정산'], ['jira:CD-2', '알림 발송 정리']]);
});
test('BJALIAS: wfProjects의 지라 라벨도 같은 헬퍼(uiProjectName)를 쓴다', () => {
  const app = workflowsClient();
  app.run("workflowData = { items: [], meetings: [] }; jiraIssuesCache = [{ key: 'AB-1', summary: '[Q4] 결제 리뉴얼 v2 (iOS/AOS)' }]; customGroupsCache = [];");
  app.run("jiraIssuesByKey = new Map(jiraIssuesCache.map(i => [i.key, i]))");
  app.run("projectAliasesCache = {}");
  assert.deepEqual(JSON.parse(app.run("JSON.stringify(wfProjects().find(([key]) => key === 'jira:AB-1'))")), ['jira:AB-1', 'AB-1 · [Q4] 결제 리뉴얼 v2 (iOS/AOS)']);
  app.run("projectAliasesCache = { 'AB-1': '결제 리뉴얼' }");
  assert.deepEqual(JSON.parse(app.run("JSON.stringify(wfProjects().find(([key]) => key === 'jira:AB-1'))")), ['jira:AB-1', 'AB-1 · 결제 리뉴얼'], '별칭이 있으면 그 이름이 붙는다');
});

// BKEY: 프로젝트를 고르는 목록은 `요약 · 키`이고, 정렬은 요약 기준이다(BBUNDLE 덩어리 2부터 <select> 대신 uiPickList).
test('프로젝트 고르기 선택지: 해제는 지울 것이 있을 때만, 지라는 요약 + 조용한 키이고 요약 기준 정렬이다', () => {
  const app = pureClient();
  app.run("jiraIssuesCache = [{ key: 'AB-1', summary: '나중 요약' }, { key: 'ZZ-9', summary: '가입' }]; customGroupsCache = ['운영툴', '<b>x</b>']");
  const entries = code => JSON.parse(app.run(`JSON.stringify(projectPickEntries(${code}))`));
  const clear = list => list.filter(entry => entry.value === '__clear__').length;
  assert.equal(clear(entries('null, false')), 0);
  assert.equal(clear(entries('null, true')), 1, 'bulk move can clear even without a current group');
  const current = entries("{ type: 'group', value: '운영툴' }, false");
  assert.equal(clear(current), 1);
  assert.equal(current.find(entry => entry.value === 'group:운영툴').selected, true);
  assert.equal(current.find(entry => entry.value === 'jira:AB-1').selected, false);
  assert.equal(current.find(entry => entry.value === 'group:<b>x</b>').text, '<b>x</b>', '글자는 textContent로만 들어간다');
  assert.deepEqual(current.slice(-2).map(entry => entry.value), ['__custom__', '__clear__'], '해제는 맨 끝 — 찾기 칸 ↓의 첫 도착이 해제가 되지 않게');
  // 지라 선택지는 요약이 앞(text), 키는 오른쪽 조용한 글자(key)이고, 요약 기준으로 정렬된다(값은 그대로 jira:KEY).
  assert.deepEqual(current.filter(entry => String(entry.value || '').startsWith('jira:')).map(entry => [entry.value, entry.text, entry.key]), [
    ['jira:ZZ-9', '가입', 'ZZ-9'],
    ['jira:AB-1', '나중 요약', 'AB-1'],
  ], '요약이 앞, 키가 뒤 — 정렬은 요약(가입 → 나중 요약) 기준');
});

// BKEY: 항목 상세 카드의 프로젝트 값 — 요약 뒤에 조용한 회색 글자로 키(값 고르개가 닫혀 있을 때의 표시).
test('renderGroupControl: 지라 값은 요약 뒤에 조용한 키가 붙고, 그룹·모르는 키는 그대로다', () => {
  const app = pureClient();
  app.run("jiraIssuesCache = [{ key: 'ABC-1234', summary: '예시 게시글 작성하기_샘플 기능' }]; customGroupsCache = []");
  const badge = app.run(
    "renderGroupControl({ jira: 'ABC-1234', group: null, onSetJira: () => {}, onSetGroup: () => {} }).children[0]");
  assert.equal(badge.className, 'badge jira-badge');
  assert.equal(badge.textContent, '예시 게시글 작성하기_샘플 기능', '보이는 자리는 요약만');
  assert.equal(badge.children.length, 1);
  assert.equal(badge.children[0].className, 'k-mute');
  assert.equal(badge.children[0].textContent, ' ABC-1234', '요약 뒤에 조용한 회색 글자로 키');
  assert.equal(badge.getAttribute('aria-label'), '예시 게시글 작성하기_샘플 기능 ABC-1234 — 클릭해서 변경/해제');

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

// 1.3.2: 상세 카드의 필드 격자만 plain — 회색 알약 대신 `● 이름 ⌄` 글자 고르개(⋯ 메뉴는 알약 그대로).
test('renderGroupControl plain: 색 점 + 이름 + 꺾쇠, 클래스 is-plain(기본 클래스는 유지)', () => {
  const app = pureClient();
  app.run("jiraIssuesCache = [{ key: 'ABC-1234', summary: '예시 게시글 작성하기_샘플 기능' }]; customGroupsCache = []");
  const group = app.run(
    "renderGroupControl({ jira: null, group: '가입 개선', onSetJira: () => {}, onSetGroup: () => {}, plain: true }).children[0]");
  assert.equal(group.className, 'badge group-badge is-plain');
  assert.deepEqual(group.children.map(node => node.className), ['d-pjdot', 'v', 'cv']);
  assert.equal(group.children[0].dataset.pj, app.run("String(uiProjectHue('가입 개선'))"), '색 점은 다른 자리와 같은 이름 색');
  assert.equal(group.children[1].textContent, '가입 개선');
  assert.match(group.children[2].innerHTML, /<svg/);
  assert.equal(group.getAttribute('aria-label'), '가입 개선 — 클릭해서 변경/해제');

  const jira = app.run(
    "renderGroupControl({ jira: 'ABC-1234', group: null, onSetJira: () => {}, onSetGroup: () => {}, plain: true }).children[0]");
  assert.equal(jira.className, 'badge jira-badge is-plain');
  assert.equal(jira.children[0].dataset.pj, app.run("String(uiProjectHue('ABC-1234'))"));
  assert.equal(jira.children[1].children[0].className, 'k-mute', '요약 뒤 조용한 키는 그대로');

  // plain을 켜지 않으면(⋯ 메뉴) 예전 알약 그대로 — 점·꺾쇠가 없다.
  const pill = app.run(
    "renderGroupControl({ jira: null, group: '가입 개선', onSetJira: () => {}, onSetGroup: () => {} }).children[0]");
  assert.equal(pill.className, 'badge group-badge');
  assert.equal(pill.children.length, 0);
  // 프로젝트가 아직 없으면 plain이어도 `그룹 지정…` 칸 그대로.
  const start = app.run(
    "renderGroupControl({ jira: null, group: null, onSetJira: () => {}, onSetGroup: () => {}, plain: true }).children[0]");
  assert.equal(start.className, 'jira-select jira-pick');
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

// 1.3.2: 상세의 `언제 할지`도 목록 줄과 같은 규칙 — 진행 중이면 밀렸어도 `밀림` 대신 `진행 중`.
test('panelWhenText: 진행 중 + 지난 예정일은 `진행 중`', () => {
  const app = pureClient();
  assert.equal(app.run("panelWhenText({ status: 'open', doing: '2000-01-02', scheduled: '2000-01-01' }, 'today')"), '진행 중');
});

test('panelWhenText: 진행 중이 아니면 지난 예정일은 `N일째 밀림 · 날짜` 그대로', () => {
  const app = pureClient();
  assert.match(app.run("panelWhenText({ status: 'open', scheduled: '2000-01-01' }, 'today')"), /^\d+일째 밀림 · 1월 1일 \(토\)$/);
});

// 1.3.2: 오늘 할 일 머리줄의 끌어오기 제안은 `오늘 할 만한 일 N개`(미루기 `N개 미룰까요?`는 그대로, 0개면 없음).
test('제안 머리줄 문구: 끌어오기는 `오늘 할 만한 일 N개`, 미루기는 `N개 미룰까요?`, 0개면 링크 없음', () => {
  const app = workflowsClient();
  app.run('workflowData = { items: [], meetings: [] }; wfIndexData();');
  const label = (mode, ids) => app.run(`(() => {
    suggestOpen = false; itemsById = new Map();
    const slot = document.getElementById('suggestSlot'); slot.children = [];
    renderSuggestions({ mode: '${mode}', items: ${JSON.stringify(ids)}.map(id => ({ id, description: id })) });
    const toggle = slot.children.find(node => node.className === 'd-sug');
    return toggle ? toggle.children.map(node => node.textContent).join('') : null;
  })()`);
  assert.equal(label('pull', ['a', 'b']), '오늘 할 만한 일 2개');
  assert.equal(label('defer', ['a', 'b', 'c']), '3개 미룰까요?');
  assert.equal(label('pull', []), null);
});

test('panelWhenText: 진행 중 + 오늘(또는 예정일 없음)은 `오늘` 그대로', () => {
  const app = pureClient();
  assert.equal(app.run("panelWhenText({ status: 'open', doing: todayStr(), scheduled: todayStr() }, 'today')"), '오늘');
  assert.equal(app.run("panelWhenText({ status: 'open', doing: todayStr() }, 'today')"), '오늘');
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

function inboxFoldClient() {
  const app = client(new Response('{"ok":true}'));
  app.run("escapeHtml = s => String(s || '')");
  app.run("workflowData = { items: [], meetings: [] }; jiraIssuesByKey = new Map()");
  app.run("var inboxOf = n => Array.from({ length: n }, (_, i) => ({ id: 'i' + i, description: '업무' + i }))");
  const list = () => app.nodes.get('inboxList');
  const rows = () => list().children.filter(kid => kid.className === 'd-ibrow');
  const more = () => list().children.find(kid => String(kid.className).includes('d-ibmore'));
  return { app, list, rows, more };
}

test('새로 들어온 것 4개: 위 3줄만 보이고 4번째는 hidden, 카드 맨 아래 `1개 더 ›`', () => {
  const { app, list, rows, more } = inboxFoldClient();
  app.run('renderInbox(inboxOf(4))');
  assert.deepEqual(rows().map(r => r.hidden), [false, false, false, true]);
  const link = more();
  assert.ok(link, '링크가 선다');
  assert.equal(list().children.at(-1), link, '링크는 카드 맨 아래');
  assert.equal(link.type, 'button');
  assert.match(link.textContent, /^1개 더 ›$/);
  assert.equal(link.getAttribute('aria-label'), '새로 들어온 것 1개 더 보기');
  assert.equal(link.getAttribute('aria-expanded'), 'false');
  assert.equal(link.getAttribute('aria-controls'), 'inboxList');
  assert.equal(app.nodes.get('inboxCount').textContent, 4, '제목 옆 숫자는 전체 개수');
  // .d-ibrow는 grid라 hidden이 grid에 지지 않게 규칙을 따로 둔다.
  const css = fs.readFileSync(path.join(__dirname, 'ui.css'), 'utf8');
  assert.match(css, /^\.d-ibrow\[hidden\] \{ display: none; \}$/m);
});

test('어두운 화면의 따뜻한 판은 짙은 회색이고, 시스템 다크·직접 고른 다크 두 곳이 같은 값이다(밝은 화면 그대로)', () => {
  const css = fs.readFileSync(path.join(__dirname, 'ui.css'), 'utf8');
  const warm = css.split('\n').filter(line => /^\s*--warm:/.test(line)).map(line => line.trim());
  assert.equal(warm.length, 3, '밝은 화면 한 곳 + 어두운 화면 두 곳');
  assert.equal(warm[0], '--warm: #fffaf2;  --warm-line: transparent;  --warm-hover: #fff4e4;');
  assert.equal(warm[1], '--warm: #22252b;  --warm-line: #2c3038;  --warm-hover: #282c33;');
  assert.equal(warm[2], warm[1], 'prefers-color-scheme와 [data-theme=dark]가 같은 값');
});

test('새로 들어온 것 3개 이하: 접힌 줄도 링크도 없다', () => {
  const { app, rows, more } = inboxFoldClient();
  for (const n of [1, 3]) {
    app.run(`renderInbox(inboxOf(${n}))`);
    assert.equal(rows().length, n);
    assert.ok(rows().every(r => !r.hidden), `${n}개면 모두 보인다`);
    assert.equal(more(), undefined, `${n}개면 링크가 없다`);
  }
});

test('새로 들어온 것 `N개 더 ›`를 누르면 다시 그리지 않고 hidden만 풀리고 `접기 ⌃`가 된다', () => {
  const { app, rows, more } = inboxFoldClient();
  app.run('renderInbox(inboxOf(6))');
  const link = more();
  assert.equal(link.textContent, '3개 더 ›');
  const before = rows();
  link.listeners.click();
  assert.deepEqual(rows(), before, '줄을 새로 만들지 않는다(초점 유지)');
  assert.ok(rows().every(r => !r.hidden));
  assert.equal(more(), link, '링크도 같은 버튼');
  assert.equal(link.textContent, '접기 ⌃');
  assert.equal(link.getAttribute('aria-label'), '새로 들어온 것 접기');
  assert.equal(link.getAttribute('aria-expanded'), 'true');
  link.listeners.click();
  assert.deepEqual(rows().map(r => r.hidden), [false, false, false, true, true, true]);
  assert.equal(link.textContent, '3개 더 ›');
  assert.equal(link.getAttribute('aria-expanded'), 'false');
});

test('새로 들어온 것 펼침은 다시 그려도 남고, 3개 이하로 줄면 접힘으로 돌아간다', () => {
  const { app, rows, more } = inboxFoldClient();
  app.run('renderInbox(inboxOf(5))');
  more().listeners.click();
  app.run('renderInbox(inboxOf(7))');
  assert.ok(rows().every(r => !r.hidden), '펼친 채 다시 그려진다(새 항목이 와도)');
  assert.equal(more().textContent, '접기 ⌃');
  app.run('renderInbox(inboxOf(3))');
  assert.equal(more(), undefined);
  app.run('renderInbox(inboxOf(4))');
  assert.deepEqual(rows().map(r => r.hidden), [false, false, false, true], '다시 늘어도 접힌 채');
  assert.equal(more().textContent, '1개 더 ›');
  more().listeners.click();
  app.run('renderInbox([])');
  app.run('renderInbox(inboxOf(4))');
  assert.equal(rows()[3].hidden, true, '0개가 되어도 접힘으로 돌아간다');
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

test('BPAL: 완료한 줄은 제목 글자만 조용해진다(취소선 없음, 다른 화면의 완료 줄과 같은 --muted)', () => {
  const { app } = palRowClient(new Response('{"ok":true}'));
  const done = palRow(app, { id: 'd1', type: 'task', description: '끝낸 일', status: 'done' }, 1);
  const open = palRow(app, { id: 'o1', type: 'task', description: '남은 일', status: 'to-do' }, 1);
  assert.match(done.className, /\bis-done\b/);
  assert.doesNotMatch(open.className, /\bis-done\b/);
  const css = fs.readFileSync(path.join(__dirname, 'ui.css'), 'utf8');
  const rule = css.match(/\.d-pres\.is-done \.ti \{([^}]*)\}/);
  assert.ok(rule, '완료 줄 제목 규칙이 있다');
  assert.match(rule[1], /color: var\(--muted\)/, '새 색 없이 --muted를 재사용한다');
  assert.doesNotMatch(rule[1], /line-through/, '취소선은 쓰지 않는다');
  assert.ok(css.indexOf('.d-pres.is-done .ti') < css.indexOf('.d-pres.is-sel .ti'), '고른 줄의 강조가 이긴다(뒤에 선다)');
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
  // 목록 모양(jiraIssuesCache와 같은 꼴) — 상태는 글자, 범주는 맨 위 칸이다.
  app.run("jiraIssuesByKey = new Map([['AL-1', { key: 'AL-1', summary: '알림센터', status: '진행 중', category: 'doing' }]]);");
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
  assert.equal(box.disabled, false);
  // 제목은 누르면 펼치는 자리다(WP-W) — 문구 고치기는 ⋯의 `문구 고치기`로 연다.
  app.run('uiMenu = (anchor, sections) => { window.__menu = sections; };');
  const more = row.children[row.children.length - 1].children[0];
  more.listeners.click({ stopPropagation() {} });
  const editItem = app.run('window.__menu')[0].find(entry => entry.label === '문구 고치기');
  editItem.onClick();
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
  // 카드 한 장(.d-pcard) 안의 그룹(.d-pgrp) — 제목 다음부터가 줄이다.
  const card = body.children.find(c => String(c.className).includes('d-pcard'));
  const section = (label) => card.children.find(c => c.className === 'd-pgrp'
    && c.children[0].children.some(k => k.textContent === label));
  const rowsOf = (label) => section(label).children.slice(1);

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

  assert.equal(section('회의'), undefined, '회의가 없는 프로젝트라 회의 그룹 자체가 없다');
});

// 개편 A4-②: 프로젝트 상세는 카드 한 장 — 맨 위 빠른 추가, 그 아래 그룹 제목이 열을 대신한다.
function projectCardClient(items, meetings = []) {
  const app = workflowsClient();
  app.run(`workflowData = { items: ${JSON.stringify(items)}, meetings: ${JSON.stringify(meetings)} }; wfIndexData(); itemsById = new Map();`);
  const body = () => app.run(`(() => {
    const body = document.createElement('div');
    renderProjectDetail(body, { key: 'group:가입 개선', label: '가입 개선', open: 1 });
    return body;
  })()`);
  const cardOf = node => node.children.filter(c => String(c.className).split(' ').includes('d-pcard'));
  const groups = node => cardOf(node)[0].children.filter(c => c.className === 'd-pgrp');
  const label = group => nodeFind(group.children[0], 'gl').textContent;
  return { app, body, cardOf, groups, label };
}
const A4_ALL = [
  { id: 't1', type: 'task', description: '오늘 할 일', status: 'to-do', scheduled: '2026-09-30', group: '가입 개선' },
  { id: 't2', type: 'task', description: '나중 할 일', status: 'to-do', group: '가입 개선' },
  { id: 't3', type: 'task', description: '끝낸 일', status: 'done', completed: '2026-09-29', group: '가입 개선' },
  { id: 'w1', type: 'check', description: '확인 문구', status: 'to-do', group: '가입 개선' },
  { id: 'd1', type: 'decision', description: '결정 문구', status: 'to-do', group: '가입 개선' },
  { id: 'i1', type: 'idea', description: '아이디어 문구', status: 'to-do', group: '가입 개선' },
];
const A4_MEETING = [{ id: 'm1', title: '가입 회의', date: '2026-09-29', group: '가입 개선' }];

test('프로젝트 상세 카드 하나: 흰 카드 1장, 맨 위 빠른 추가, 그룹은 오늘→나중에→확인 대기→결정→회의→아이디어→끝낸 것', () => {
  // 회의는 이 프로젝트 항목이 나온 회의로도 잡힌다(meetingId).
  const { body, cardOf, groups, label } = projectCardClient(A4_ALL.map(item => item.id === 'd1' ? { ...item, meetingId: 'm1' } : item), A4_MEETING);
  const node = body();
  assert.equal(cardOf(node).length, 1, '카드는 한 장');
  assert.equal(nodeFindAll(node, 'd-psurf').length, 1, '구역마다 따로 선 흰 카드가 없다');
  const card = cardOf(node)[0];
  assert.ok(String(card.children[0].className).includes('d-padd'), '빠른 추가 칸이 카드 맨 위');
  assert.deepEqual(groups(node).map(label), ['오늘', '나중에', '확인 대기', '결정', '회의', '아이디어', '끝낸 것']);
  assert.equal(nodeFind(groups(node)[0], 'n').textContent, 1, '그룹 제목 옆 숫자');
  // 줄 앞 `언제 할지` 칸과 열 이름 줄은 없다 — 그룹 제목이 말한다.
  assert.equal(nodeFind(node, 'd-colhd'), null);
  assert.equal(nodeFind(node, 'pl'), null);
  assert.equal(nodeFind(groups(node)[0], 'd-prow2').children.length, 4, '체크 · 제목 · 기한 · 동작');
  // 결정 제목 끝에는 조용한 안내.
  const decision = groups(node)[3];
  assert.equal(nodeFind(decision.children[0], 'd-pghint').textContent, '· 체크하면 PRD 반영');
  assert.equal(nodeFind(groups(node)[2].children[0], 'd-pghint'), null, '다른 그룹에는 안내가 없다');
  // 끝낸 것은 접힌 채 제목만(누르면 펼친다).
  const doneGroup = groups(node)[6];
  assert.equal(doneGroup.children.length, 1);
  assert.equal(doneGroup.children[0].getAttribute('aria-expanded'), 'false');
});

test('프로젝트 상세 카드: 오늘/나중에 옮기기 버튼은 그룹 기준 그대로(오늘 → `나중에`, 나중에 → `오늘로`)', () => {
  const { body, groups } = projectCardClient(A4_ALL);
  const node = body();
  const moveOf = group => nodeFind(nodeFind(group, 'ac'), 'd-btn').textContent;
  assert.equal(moveOf(groups(node)[0]), '나중에');
  assert.equal(moveOf(groups(node)[1]), '오늘로');
});

test('프로젝트 상세 카드: 빈 그룹은 그리지 않고, 업무 0개면 빠른 추가 칸만, 그룹 하나면 그 제목 하나', () => {
  const empty = projectCardClient([]);
  const node = empty.body();
  assert.equal(empty.cardOf(node).length, 1, '업무가 0개여도 카드는 선다');
  assert.equal(empty.groups(node).length, 0, '그룹이 없다');
  assert.ok(String(empty.cardOf(node)[0].children[0].className).includes('d-padd'));
  assert.equal(empty.cardOf(node)[0].children.length, 1, '빠른 추가 칸뿐');

  const one = projectCardClient([{ id: 't2', type: 'task', description: '나중 할 일', status: 'to-do', group: '가입 개선' }]);
  const oneNode = one.body();
  assert.deepEqual(one.groups(oneNode).map(one.label), ['나중에']);
});

test('프로젝트 상세 카드: 오늘/나중에는 서버가 나눈 오늘 목록·나중에 할 일 그대로(날짜를 다시 계산하지 않는다)', () => {
  const day = n => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const items = [
    { id: 'tomorrow', type: 'task', description: '내일 예정', status: 'to-do', scheduled: day(1), group: '가입 개선' },
    { id: 'yesterday', type: 'task', description: '어제 예정', status: 'to-do', scheduled: day(-1), group: '가입 개선' },
    { id: 'none', type: 'task', description: '예정일 없음', status: 'to-do', group: '가입 개선' },
    { id: 'overdue', type: 'task', description: '기한 지남', status: 'to-do', due: day(-2), group: '가입 개선' },
  ];
  const { app, body, groups, label } = projectCardClient(items);
  // 서버(getTodayTasks·getLaterTasks — isOpenTaskForToday)가 나눈 그대로를 화면이 들고 있다.
  const pick = ids => items.filter(item => ids.includes(item.id));
  app.run(`taskListsCache = { todayTasks: ${JSON.stringify(pick(['yesterday', 'overdue']))}, laterTasks: ${JSON.stringify(pick(['tomorrow', 'none']))} };`);
  const node = body();
  const titles = g => nodeFindAll(g, 'd-prow2').map(row => nodeFind(row, 'ti').textContent).sort();
  const [today, later] = groups(node);
  assert.deepEqual([label(today), label(later)], ['오늘', '나중에']);
  assert.deepEqual(titles(today), ['기한 지남', '어제 예정'], '어제 예정·기한 지남 → 오늘');
  assert.deepEqual(titles(later), ['내일 예정', '예정일 없음'], '내일 예정·예정일 없음 → 나중에');
  // 줄의 옮기기 버튼도 같은 판정 — 나중에 그룹의 내일 예정 줄은 `오늘로`.
  const tomorrowRow = nodeFindAll(later, 'd-prow2').find(row => nodeFind(row, 'ti').textContent === '내일 예정');
  assert.equal(nodeFind(nodeFind(tomorrowRow, 'ac'), 'd-btn').textContent, '오늘로');
});

test('프로젝트 상세 카드 CSS: 체크 칸이 없는 줄(회의·아이디어)은 체크 칸 폭만큼 비워 제목 시작을 맞춘다(넓은 폭·390px)', () => {
  const css = fs.readFileSync(path.join(__dirname, 'ui.css'), 'utf8');
  // 넓은 폭: 업무 줄 = --pad + 체크 30px + 칸 사이 10px, 읽는 줄도 같은 칸 사이, 체크 없는 줄은 그 40px을 여백으로.
  assert.match(css, /^\.d-pcard \.d-rec \{ padding-left: var\(--pad\); column-gap: 10px; \}$/m);
  assert.match(css, /^\.d-pcard \.d-rec:not\(\.has-ck\) \{ padding-left: calc\(var\(--pad\) \+ 40px\); \}$/m);
  // 390px: 업무 줄 = 12px + 30px + 8px.
  const narrow = [...css.matchAll(/@media \(max-width: 520px\) \{([\s\S]*?)\n\}/g)].map(m => m[1]).join('\n');
  assert.match(narrow, /\.d-pcard \.d-rec \{ column-gap: 8px; \}/);
  assert.match(narrow, /\.d-pcard \.d-rec:not\(\.has-ck\) \{ padding-left: calc\(12px \+ 38px\); \}/);
});

test('프로젝트 상세 카드 CSS: 업무 줄 격자는 체크 | 업무 | 기한 셋, 열 이름 줄·`언제 할지` 칸 규칙은 없다', () => {
  const css = fs.readFileSync(path.join(__dirname, 'ui.css'), 'utf8');
  assert.match(css, /^\.d-prow2 \{\n  display: grid; grid-template-columns: 30px minmax\(0, 1fr\) 116px;/m);
  assert.doesNotMatch(css, /\.d-colhd|\.d-prow2 \.pl\b|\.d-psec/);
  // 카드 안 그룹 제목은 스티키가 아니다(.d-list 안에서만 스티키).
  assert.doesNotMatch(css, /\.d-pcard[^{]*\.d-grp[^{]*\{[^}]*sticky/);
});

// 개편 A4-③: 읽는 그룹(확인 대기·결정·회의·아이디어)은 4개 이상이면 위 3줄 + `N개 더 ›`. 업무·끝낸 것은 접지 않는다.
function projectFoldClient(counts) {
  const items = [];
  const add = (type, n, extra = {}) => { for (let i = 0; i < n; i += 1) items.push({ id: `${type}${i}`, type, description: `${type} ${i}`, status: 'to-do', group: '가입 개선', ...extra }); };
  add('check', counts.check || 0);
  add('decision', counts.decision || 0);
  add('idea', counts.idea || 0);
  add('task', counts.task || 0, { scheduled: '2026-09-30' });
  const app = workflowsClient();
  app.run(`workflowData = { items: ${JSON.stringify(items)}, meetings: [] }; wfIndexData(); itemsById = new Map();
    projectKey = 'group:가입 개선'; projectFolds.clear();`);
  // 실제 화면처럼 renderProjects가 오른쪽(projectBody)을 다시 그린다.
  const render = () => { app.run('renderProjects()'); return app.nodes.get('projectBody'); };
  const group = (label) => {
    const card = nodeFind(app.nodes.get('projectBody'), 'd-pcard');
    return card.children.find(c => c.className === 'd-pgrp' && nodeFind(c.children[0], 'gl').textContent === label);
  };
  const rowsOf = g => g.children.filter(c => /^d-(rec|prow2)\b/.test(String(c.className)));
  const moreOf = g => g.children.find(c => String(c.className).includes('d-pmore'));
  return { app, render, group, rowsOf, moreOf };
}

test('읽는 그룹 4개 이상: 위 3줄만 보이고 그룹 맨 아래 `N개 더 ›`, 제목 옆 숫자는 전체 개수', () => {
  const { render, group, rowsOf, moreOf } = projectFoldClient({ check: 4, decision: 5, idea: 6, task: 5 });
  render();
  for (const [label, n] of [['확인 대기', 4], ['결정', 5], ['아이디어', 6]]) {
    const g = group(label);
    assert.deepEqual(rowsOf(g).map(r => !!r.hidden), Array.from({ length: n }, (_, i) => i >= 3), `${label}: 4번째부터 hidden`);
    const link = moreOf(g);
    assert.equal(g.children.at(-1), link, `${label}: 링크는 그룹 맨 아래`);
    assert.equal(link.type, 'button');
    assert.equal(link.textContent, `${n - 3}개 더 ›`);
    assert.equal(link.getAttribute('aria-label'), `${label} ${n - 3}개 더 보기`);
    assert.equal(link.getAttribute('aria-expanded'), 'false');
    assert.ok(g.id, 'id가 있다');
    assert.equal(link.getAttribute('aria-controls'), g.id, '그룹 id를 가리킨다');
    assert.equal(nodeFind(g.children[0], 'n').textContent, n, '제목 옆 숫자는 전체 개수');
  }
  // 업무(오늘)는 5개여도 접지 않는다.
  const today = group('오늘');
  assert.equal(rowsOf(today).length, 5);
  assert.ok(rowsOf(today).every(r => !r.hidden));
  assert.equal(moreOf(today), undefined);
  const css = fs.readFileSync(path.join(__dirname, 'ui.css'), 'utf8');
  assert.match(css, /^\.d-rec\[hidden\], \.d-prow2\[hidden\] \{ display: none; \}$/m);
  assert.match(css, /^\.d-ibmore, \.d-pmore \{/m, '새로 들어온 것 링크와 같은 부품');
});

test('읽는 그룹 3개 이하: 접힌 줄도 링크도 없다', () => {
  const { render, group, rowsOf, moreOf } = projectFoldClient({ check: 3, decision: 1 });
  render();
  for (const label of ['확인 대기', '결정']) {
    assert.ok(rowsOf(group(label)).every(r => !r.hidden));
    assert.equal(moreOf(group(label)), undefined);
  }
});

test('읽는 그룹 `N개 더 ›`: 다시 그리지 않고 hidden만 풀리고 `접기 ⌃`, 다시 누르면 접힌다', () => {
  const { render, group, rowsOf, moreOf } = projectFoldClient({ idea: 5 });
  render();
  const g = group('아이디어');
  const before = rowsOf(g);
  const link = moreOf(g);
  link.listeners.click();
  assert.deepEqual(rowsOf(g), before, '줄을 새로 만들지 않는다(초점 유지)');
  assert.ok(rowsOf(g).every(r => !r.hidden));
  assert.equal(link.textContent, '접기 ⌃');
  assert.equal(link.getAttribute('aria-label'), '아이디어 접기');
  assert.equal(link.getAttribute('aria-expanded'), 'true');
  link.listeners.click();
  assert.deepEqual(rowsOf(g).map(r => !!r.hidden), [false, false, false, true, true]);
  assert.equal(link.textContent, '2개 더 ›');
});

test('읽는 그룹 펼침은 renderProjects로 다시 그려도 남고, 그룹마다 따로이며, 3개 이하로 줄면 접힘으로 돌아간다', () => {
  const { app, render, group, rowsOf, moreOf } = projectFoldClient({ check: 4, decision: 4 });
  render();
  moreOf(group('확인 대기')).listeners.click();
  assert.equal(app.run("projectFolds.has('group:가입 개선::waiting')"), true, '프로젝트키::그룹으로 기억한다');
  render();
  assert.ok(rowsOf(group('확인 대기')).every(r => !r.hidden), '다시 그려도 펼친 채');
  assert.equal(moreOf(group('확인 대기')).textContent, '접기 ⌃');
  assert.deepEqual(rowsOf(group('결정')).map(r => !!r.hidden), [false, false, false, true], '다른 그룹은 그대로 접힘');
  // 새 항목이 들어와도 자동으로 펼치지 않는다 — 숫자만 바뀐다.
  app.run("workflowData.items.push({ id: 'd9', type: 'decision', description: '새 결정', status: 'to-do', group: '가입 개선' }); wfIndexData();");
  render();
  assert.equal(moreOf(group('결정')).textContent, '2개 더 ›');
  assert.equal(nodeFind(group('결정').children[0], 'n').textContent, 5);
  // 3개로 줄면 기억을 지운다 — 다시 4개가 되면 접힌 채로 시작한다.
  app.run("workflowData.items = workflowData.items.filter(item => item.id !== 'check3'); wfIndexData();");
  render();
  assert.equal(moreOf(group('확인 대기')), undefined);
  assert.equal(app.run("projectFolds.has('group:가입 개선::waiting')"), false);
  app.run("workflowData.items.push({ id: 'c9', type: 'check', description: '새 확인', status: 'to-do', group: '가입 개선' }); wfIndexData();");
  render();
  assert.equal(moreOf(group('확인 대기')).getAttribute('aria-expanded'), 'false', '다시 4개가 되면 접힌 채');
});

test('uiFoldToggle: 새로 들어온 것 링크와 같은 공용 부품이고, 펼침은 부르는 쪽이 onChange로 기억한다', () => {
  const app = pureClient();
  const got = JSON.parse(app.run(`(() => {
    const rows = [{ hidden: true }, { hidden: true }];
    const seen = [];
    const button = uiFoldToggle(rows, { label: '회의', expanded: false, controls: 'x1', className: 'd-pmore', onChange: open => seen.push(open) });
    const first = [button.className, button.textContent, button.getAttribute('aria-label'), button.getAttribute('aria-controls')];
    button.listeners.click();
    return JSON.stringify({ first, after: [button.textContent, rows.map(r => r.hidden)], seen });
  })()`));
  assert.deepEqual(got, { first: ['d-link d-pmore', '2개 더 ›', '회의 2개 더 보기', 'x1'], after: ['접기 ⌃', [false, false]], seen: [true] });
  assert.equal(app.run('UI_FOLD'), 3);
  assert.equal(app.run('INBOX_FOLD'), app.run('UI_FOLD'), '옛 이름도 같은 값');
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
  // v3: 첫 묶음 `보고에서 빼기`(+ 넣을 곳이 있으면 `다른 문장 아래로 넣기` · 고친 줄이면 `원래 문장으로`), 둘째 묶음 자리 옮기기, 끝에 근거.
  assert.deepEqual(labels({ id: 'r1', group: '가입 개선', sourceIds: ['s1'] }), [['보고에서 빼기'], ['이 아래로 문장 모으기', '한 줄로 모으기…'], ['근거 업무 보기']]);
  assert.deepEqual(labels({ id: 'r2', group: '가입 개선', sourceIds: [] }), [['보고에서 빼기'], ['이 아래로 문장 모으기', '한 줄로 모으기…']], '근거가 없으면 근거 항목도 없다');
  assert.deepEqual(labels({ id: 'r5', group: '가입 개선', sourceIds: [], parent: 'r1' }), [['보고에서 빼기'], ['따로 빼기']],
    '이미 다른 문장 아래에 있는 문장은 더 모을 수 없고 빼기만 한다(한 단계까지만)');
  assert.deepEqual(labels({ id: 'r6', group: '가입 개선', sourceIds: [], excluded: true }), [['보고에 되살리기']],
    '제외한 문장 아래로는 모으지 않는다 — 되살리기만');
  assert.deepEqual(labels({ id: 'r3', group: '여러 프로젝트', sourceIds: ['s1', 's2'], canSplit: true, partCount: 2 }),
    [['보고에서 빼기'], ['이 아래로 문장 모으기', '한 줄로 모으기…', '묶음 풀기'], ['근거 업무 보기']]);
  // 옛 저장 데이터로 만든 묶음 문장에는 `parts`가 없어 `canSplit`도 오지 않는다 — 풀기만 보이지 않는다.
  assert.deepEqual(labels({ id: 'r4', group: '여러 프로젝트', sourceIds: ['s1', 's2'] }), [['보고에서 빼기'], ['이 아래로 문장 모으기', '한 줄로 모으기…'], ['근거 업무 보기']]);
  // 손으로 고친 줄은 `원래 문장으로`, 그 밖의 문장이 있어 받을 곳이 있으면 `다른 문장 아래로 넣기`.
  const withRows = JSON.parse(app.run(`JSON.stringify(reportSentenceMenuSections({ weekKey: 'W', draft: { rows: [
    { id: 'x', heading: '완료한 일', sourceIds: ['s1'], locked: true, excluded: false, evidence: [{ id: 's1', description: '정산 배치 점검' }, { id: 's2', description: '로그' }] },
    { id: 'y', heading: '완료한 일', sourceIds: [], excluded: false } ] } },
    { id: 'x', heading: '완료한 일', sourceIds: ['s1'], locked: true, excluded: false, evidence: [{ id: 's1', description: '정산 배치 점검' }, { id: 's2', description: '로그' }] })
    .map(section => section.map(entry => entry.label)))`));
  assert.deepEqual(withRows[0], ['보고에서 빼기', '다른 문장 아래로 넣기', '원래 문장으로']);
  assert.deepEqual(withRows[2], ['근거: 정산 배치 점검 외 1개']);
});

// `프로젝트 바꾸기`는 다음 주 계획 문장에만 붙는다(다른 구역의 프로젝트는 원본 업무가 정한다).
test('계획 문장의 ⋯에만 프로젝트 바꾸기 고르개가 붙는다', () => {
  const app = reportClient();
  const fields = row => JSON.parse(app.run(`JSON.stringify(
    reportSentenceMenuSections(${REPORT_ITEM}, ${JSON.stringify(row)})
      .map(section => section.map(entry => entry.field || entry.label)))`));
  assert.deepEqual(fields({ id: 'p1', heading: '다음 주 계획', group: '결제 리뉴얼', sourceIds: [] }),
    [['보고에서 빼기'], ['이 아래로 문장 모으기', '한 줄로 모으기…'], ['프로젝트 바꾸기']]);
  assert.deepEqual(fields({ id: 'a1', heading: '완료한 일', group: '결제 리뉴얼', sourceIds: [] }),
    [['보고에서 빼기'], ['이 아래로 문장 모으기', '한 줄로 모으기…']], '자동 문장에는 프로젝트 바꾸기가 없다');
  // 고르개는 서버의 `regroup` 하나만 부른다(빈 값이면 프로젝트 없음).
  const sent = JSON.parse(app.run(`(() => {
    const calls = [];
    reportChange = async (item, action) => { calls.push(action); };
    uiMenuClose = () => {};
    const wrap = reportPlanRegroupPicker(${REPORT_ITEM}, { id: 'p1', heading: '다음 주 계획', group: '결제 리뉴얼' });
    const choose = (text) => {
      wrap.children[0].listeners.click({ stopPropagation() {} });
      const options = wrap.children[0].children[wrap.children[0].children.length - 1].children;
      options.find(kid => kid.dataset && kid.dataset.value === text).listeners.click({ stopPropagation() {} });
    };
    customGroupsCache = ['가입 개선', '결제 리뉴얼'];
    choose('가입 개선');
    choose('');
    return JSON.stringify(calls);
  })()`));
  assert.deepEqual(sent, [
    { action: 'regroup', id: 'p1', group: '가입 개선' },
    { action: 'regroup', id: 'p1' },
  ]);
});

// BKEY: 프로젝트를 고르는 <select>는 옵션 글자만 `요약 · 키`(요약 기준 정렬)이고, 저장되는 값(option.value)은
// 그대로 원래 이름(`키 · 요약`)이라 예전에 저장된 문장과 같은 프로젝트로 묶인다.
test('다음 주 계획 프로젝트 고르개는 보이는 글자만 "요약 · 키"이고 값은 그대로다', () => {
  const app = reportClient();
  app.run("customGroupsCache = ['운영툴']; jiraIssuesCache = [{ key: 'PAY-77', summary: '정산 배치' }]");
  const optionsOf = code => JSON.parse(app.run(
    `JSON.stringify(${code}.children.map(option => [option.value, option.textContent]))`));
  // 입력줄 앞의 고르개는 찾기 칸이 있는 목록(uiPickList)이다 — 선택지는 reportPlanPickEntries(요약 + 조용한 키).
  assert.deepEqual(JSON.parse(app.run("JSON.stringify(reportPlanPickEntries('').map(e => [e.value, e.key ? `${e.text} · ${e.key}` : e.text]))")), [
    ['', '프로젝트 없음'],
    ['운영툴', '운영툴'],
    ['PAY-77 · 정산 배치', '정산 배치 · PAY-77'],
  ], '값은 원래 이름 그대로, 글자만 요약 · 키로 바뀌고 요약 기준으로 정렬된다(운영툴 → 정산 배치)');
  // 문장 ⋯의 고르개도 같은 목록이다 — 버튼을 누르면 그 자리에서 uiPickList가 펼쳐지고 <select>는 없다.
  const wrap = app.run(`reportPlanRegroupPicker(${REPORT_ITEM}, { id: 'p1', heading: '다음 주 계획', group: 'PAY-77 · 정산 배치' })`);
  const button = wrap.children[0];
  assert.equal(nodeFind(button, 'v').textContent, '정산 배치 · PAY-77', '지금 프로젝트는 요약 · 키 글자로');
  assert.ok(nodeFind(button, 'cv'), '누를 수 있어 보이게 꺾쇠가 붙는다(v1.3.0 비교)');
  assert.equal(button.title, '정산 배치 · PAY-77');
  assert.equal(nodeFind(wrap, 'd-msel') === button, true);
  assert.equal(wrap.children.some(kid => kid.tagName === 'SELECT'), false);
  button.listeners.click({ stopPropagation() {} });
  const list = wrap.children[0].children.find(kid => kid.getAttribute && kid.getAttribute('role') === 'listbox');
  assert.deepEqual(list.children.map(kid => [kid.dataset.value, nodeFind(kid, 'nm').textContent]), [
    ['', '프로젝트 없음'],
    ['운영툴', '운영툴'],
    ['PAY-77 · 정산 배치', '정산 배치'],
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
  // 제외는 (다듬기 A부터) 무엇을 했는지 적고 되돌리기를 준다 — 아래 다듬기 A 테스트가 자세히 본다.
  assert.deepEqual(notice(`{ action: 'exclude', id: 'r1' }`), ['보고에 되살렸어요', ['되돌리기', '닫기']]);
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
    '9월 4주차 (9/21~9/27)',
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
  assert.equal(app.run(`reportSlackText(${model(['결정'])})`), ['9월 4주차 (9/21~9/27)', '', '[결정]', '', '운영툴', '• 접근 로그는 90일 보존'].join('\n'));
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
  assert.match(html, /^<p><b>9월 4주차 \(9\/21~9\/27\)<\/b><\/p><p><br><\/p><p><b>\[완료\]<\/b><\/p><p><br><\/p><p><b>가입 개선<\/b><\/p><ul><li>가입 실패율 급증 원인 파악<\/li>/,
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
    '9월 4주차 (9/21~9/27)',
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
    '9월 4주차 (9/21~9/27)', '', '[완료]', '', '결제 리뉴얼', '• 혼자 남은 문장',
  ].join('\n'));
  assert.deepEqual(JSON.parse(app.run(`JSON.stringify(reportChildRows([]).size)`)), 0);
});

// ---------- BFOLD: 여러 문장을 한 줄로 모으기 + 접힘/펼침 ----------
const REPORT_FOLD_PICK_ROWS = `[
  { id: 'a', heading: '완료한 일', group: '가입 개선', text: '문장 A', sourceIds: [], excluded: false },
  { id: 'b', heading: '완료한 일', group: '결제 리뉴얼', text: '문장 B', sourceIds: [], excluded: false },
  { id: 'c', heading: '진행중', group: '가입 개선', text: '문장 C', sourceIds: [], excluded: false },
  { id: 'e', heading: '완료한 일', group: '알림센터', text: '이미 아래에 있는 문장', sourceIds: [], excluded: false, parent: 'a' }
]`;
test('한 줄로 모으기 고르기 모드: 시작 문장은 이미 골라진 상태고, 같은 소제목만 고르고 뺄 수 있으며 최소 2개부터 확인이 눌리고 Esc로 취소한다', () => {
  const app = reportClient();
  app.run(`
    renderReportDraft = () => {};
    document.body = document.createElement('div');
    item = { weekKey: '2026-09-14', draft: { revision: 1, rows: ${REPORT_FOLD_PICK_ROWS} } };
    reportFoldStart(item, item.draft.rows[0]);
  `);
  assert.deepEqual(JSON.parse(app.run('JSON.stringify([...reportFoldIds])')), ['a'], '시작한 문장은 이미 골라진 상태다');
  assert.equal(app.run('reportFoldHeading'), '완료한 일');
  assert.equal(app.run('escStack.includes(reportFoldEnd)'), true, 'Esc 스택에 올라간다');
  // 가짜 DOM의 classList.add는 아무 일도 하지 않으므로(className 문자열을 바꾸지 않는다) 고르기
  // 대상 여부는 실제 코드가 함께 붙이는 role·aria-label로 확인한다(기존 nest 테스트와 같은 방식).
  const rowState = idx => JSON.parse(app.run(`(() => {
    const host = document.createElement('div');
    reportSentenceRow(item, item.draft.rows[${idx}], { host });
    const line = host.children[0];
    return JSON.stringify({ role: line.getAttribute('role') || null, label: line.getAttribute('aria-label') || null });
  })()`));
  assert.deepEqual(rowState(0), { role: 'button', label: '문장 A — 고르기 해제' }, '고른 문장(시작 문장)은 눌러서 뺄 수 있다');
  assert.deepEqual(rowState(1), { role: 'button', label: '문장 B — 한 줄로 모으기에 담기' }, '같은 소제목의 최상위 문장은 고를 수 있다');
  assert.deepEqual(rowState(2), { role: null, label: null }, '다른 소제목의 문장은 눌리지 않는다');
  assert.deepEqual(rowState(3), { role: null, label: null }, '이미 다른 문장 아래에 있는 문장은 고를 수 없다');
  // 후보 문장을 누르면 고르기에 더해진다.
  app.run(`
    host = document.createElement('div');
    reportSentenceRow(item, item.draft.rows[1], { host });
    host.children[0].listeners.click();
  `);
  assert.deepEqual(JSON.parse(app.run('JSON.stringify([...reportFoldIds].sort())')), ['a', 'b']);
  // 막대: 2개를 고르면 확인 버튼이 눌린다.
  app.run('reportPickBar(item)');
  let bar = app.nodes.get('reportNestBarEl').children[0];
  assert.equal(bar.children.find(kid => kid.textContent === '한 줄로 모을 문장을 골라요 · 2개') !== undefined, true);
  let confirm = bar.children.find(kid => kid.textContent === '한 줄로 모으기');
  assert.equal(confirm.disabled, false);
  // 다시 눌러 빼면 1개 — 확인 버튼이 비활성이다.
  app.run(`
    host = document.createElement('div');
    reportSentenceRow(item, item.draft.rows[1], { host });
    host.children[0].listeners.click();
  `);
  app.run('reportPickBar(item)');
  bar = app.nodes.get('reportNestBarEl').children[0];
  confirm = bar.children.find(kid => kid.textContent === '한 줄로 모으기');
  assert.equal(confirm.disabled, true, '2개 미만이면 비활성이다');
  // Esc(스택 맨 위 실행) = 취소.
  app.run('escStack[escStack.length - 1]()');
  assert.equal(app.run('reportFoldIds'), null);
  assert.equal(app.run('escStack.includes(reportFoldEnd)'), false);
});
test('한 줄로 모으기와 이 아래로 문장 모으기(nest)는 함께 열리지 않는다', () => {
  const app = reportClient();
  app.run(`
    renderReportDraft = () => {};
    item = { weekKey: '2026-09-14', draft: { revision: 1, rows: ${REPORT_FOLD_PICK_ROWS} } };
    reportFoldStart(item, item.draft.rows[0]);
  `);
  assert.notEqual(app.run('reportFoldIds'), null);
  app.run("reportNestStart(item, item.draft.rows[1])");
  assert.equal(app.run('reportFoldIds'), null, 'nest를 시작하면 fold 고르기는 닫힌다');
  assert.equal(app.run('reportNestParentId'), 'b');
  app.run('reportFoldStart(item, item.draft.rows[0])');
  assert.equal(app.run('reportNestParentId'), null, 'fold를 시작하면 nest 모드는 닫힌다');
});
test('확인을 누르면 fold를 보내고, 초기 문장은 프로젝트가 하나면 이름을 붙이고 여럿이면 개수만 담는다', async () => {
  const app = reportClient();
  app.run(`
    renderReportDraft = () => {};
    calls = [];
    reportChange = async (item, action) => { calls.push(action); };
    item = { weekKey: '2026-09-14', draft: { revision: 1, rows: [
      { id: 'a', heading: '완료한 일', group: '가입 개선', text: '문장 A', sourceIds: [], excluded: false },
      { id: 'b', heading: '완료한 일', group: '가입 개선', text: '문장 B', sourceIds: [], excluded: false },
      { id: 'c', heading: '완료한 일', group: '결제 리뉴얼', text: '문장 C', sourceIds: [], excluded: false },
    ] } };
    reportFoldStart(item, item.draft.rows[0]);
    reportFoldIds.add('b');
  `);
  await app.run("reportFoldConfirm(item)");
  assert.deepEqual(JSON.parse(app.run('JSON.stringify(calls[0])')),
    { action: 'fold', ids: ['a', 'b'], text: '가입 개선 소소한 작업 2건' }, '프로젝트가 하나면 이름을 앞에 붙인다');
  app.run(`
    calls = [];
    reportFoldStart(item, item.draft.rows[0]);
    reportFoldIds.add('c');
  `);
  await app.run("reportFoldConfirm(item)");
  assert.deepEqual(JSON.parse(app.run('JSON.stringify(calls[0])')),
    { action: 'fold', ids: ['a', 'c'], text: '소소한 작업 2건' }, '프로젝트가 다르면 개수만 담는다');
  // 고르기 모드는 확인을 누르는 즉시 닫힌다.
  assert.equal(app.run('reportFoldIds'), null);
});
test('한 줄로 모으기 성공 뒤에는 새 부모가 그 자리에서 바로 수정 모드로 열리고 글 전체가 담긴다', async () => {
  const app = reportClient();
  app.run(`
    renderReportDraft = () => {};
    item = { weekKey: '2026-09-14', draft: { revision: 1, rows: [
      { id: 'a', heading: '완료한 일', group: '가입 개선', text: '문장 A', sourceIds: [], excluded: false },
      { id: 'b', heading: '완료한 일', group: '가입 개선', text: '문장 B', sourceIds: [], excluded: false },
    ] } };
    // 실제 서버 대신, fold가 성공한 뒤의 모양으로 draft를 직접 바꿔치기한다(reportChange를 흉내).
    reportChange = async (target, action) => {
      target.draft = { revision: 2, rows: [
        { id: 'p1', heading: '완료한 일', group: '가입 개선', text: action.text, sourceIds: [], evidence: [], excluded: false, folded: true, manual: true, locked: true },
        { ...target.draft.rows[0], parent: 'p1' },
        { ...target.draft.rows[1], parent: 'p1' },
      ] };
    };
    reportFoldStart(item, item.draft.rows[0]);
    reportFoldIds.add('b');
  `);
  await app.run("reportFoldConfirm(item)");
  assert.equal(app.run("reportEdits.get('2026-09-14:p1')"), '가입 개선 소소한 작업 2건',
    '새 부모의 수정 칸이 원래 글 전체를 담은 채 열린다(전체 선택은 브라우저 select()에 맡긴다)');
});
test('접힌 부모는 문장 뒤에 조용한 `· N건 ▸`이 붙고, 눌러 펼쳐 보는 것은 화면 상태일 뿐 저장하지 않는다', () => {
  const app = reportClient();
  const rows = `[
    { id: 'p1', heading: '완료한 일', group: '여러 프로젝트', text: '소소한 작업 2건', sourceIds: [], excluded: false, folded: true, manual: true, locked: true },
    { id: 'a1', heading: '완료한 일', group: '가입 개선', text: '가입 배너 문구 확인', sourceIds: [], excluded: false, parent: 'p1' },
    { id: 'a2', heading: '완료한 일', group: '결제 리뉴얼', text: '정산 배치 재처리 로그 확인', sourceIds: [], excluded: false, parent: 'p1' }
  ]`;
  app.run(`
    calls = [];
    reportChange = async () => { calls.push('change'); };
    renderReportDraft = target => { rendered = target; };
    item = { weekKey: '2026-09-14', draft: { revision: 1, rows: ${rows} } };
  `);
  const draw = () => app.run(`(() => {
    const host = document.createElement('div');
    reportSentenceRow(item, item.draft.rows[0], { host });
    return host.children[0];
  })()`);
  let line = draw();
  const toggle = line.children.find(kid => kid.className && kid.className.split(' ').includes('tx'))
    .children.find(kid => kid.className === 'rp-foldtoggle');
  // 글자 기호(▸/▾) 대신 앱의 꺾쇠 아이콘 + 개수 — 펼침은 aria-expanded(=CSS 회전)로 말한다(디자인 검수).
  assert.equal(toggle.innerHTML, app.run("uiIcon('chevron')"));
  assert.equal(toggle.children.map(kid => kid.textContent).join(''), '· 2건', '접혀 있을 때는 꺾쇠와 개수');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(toggle.getAttribute('aria-label'), '아래 문장 2개 보기');
  toggle.listeners.click({ stopPropagation() {} });
  assert.equal(app.run('reportFoldOpen.has("p1")'), true, '펼쳐 본 것은 화면 상태로 남는다');
  assert.deepEqual(JSON.parse(app.run('JSON.stringify(calls)')), [], '저장(fold 계열 액션)은 하지 않는다');
  line = draw();
  const toggle2 = line.children.find(kid => kid.className && kid.className.split(' ').includes('tx'))
    .children.find(kid => kid.className === 'rp-foldtoggle');
  assert.equal(toggle2.getAttribute('aria-expanded'), 'true', '다시 그리면 펼친 상태(꺾쇠가 아래로)로 보인다');
});
test('setFolded 메뉴 항목은 아래에 문장이 있는 부모에만 붙고, 접힘·펼침을 그대로 부른다', () => {
  const app = reportClient();
  app.run(`
    calls = [];
    reportChange = async (target, action) => { calls.push(action); };
  `);
  const withChild = `{ id: 'p1', heading: '완료한 일', group: '여러 프로젝트', text: '소소한 작업 2건', sourceIds: [], excluded: false, folded: true, manual: true }`;
  const item = `{ weekKey: '2026-09-14', draft: { revision: 1, rows: [
    ${withChild},
    { id: 'a1', heading: '완료한 일', group: '가입 개선', text: '가입 배너 문구 확인', sourceIds: [], excluded: false, parent: 'p1' }
  ] } }`;
  const labels = row => JSON.parse(app.run(`JSON.stringify(
    reportSentenceMenuSections(${item}, ${row}).map(section => section.map(entry => entry.label)))`));
  // 기존 항목(이 아래로 문장 모으기·한 줄로 모으기…)의 붙는 조건은 그대로다(최상위·제외 안 됨) —
  // 아래에 문장이 있는 부모에도 함께 붙는다(잘못 누르면 서버가 막고 알린다).
  assert.deepEqual(labels(withChild), [['보고에서 빼기'], ['이 아래로 문장 모으기', '펼쳐서 보이기', '풀기'], ['근거: 아래 문장들의 업무']],
    '접힌 부모에는 펼쳐서 보이기 · 풀기가 더해진다');
  app.run(`
    pick = (target, row, label) => reportSentenceMenuSections(target, row).flat().find(entry => entry.label === label).onClick();
    pick(${item}, ${withChild}, '펼쳐서 보이기');
  `);
  assert.deepEqual(JSON.parse(app.run('JSON.stringify(calls[0])')), { action: 'setFolded', id: 'p1', folded: false });
  const unfolded = withChild.replace('folded: true', 'folded: false');
  assert.deepEqual(labels(unfolded), [['보고에서 빼기'], ['이 아래로 문장 모으기', '접어서 한 줄로 보이기', '풀기'], ['근거: 아래 문장들의 업무']], '부모 줄에는 `한 줄로 모으기…`가 붙지 않는다(아래 문장을 가진 문장은 새 요약 아래로 못 들어간다) — `이 아래로 문장 모으기`는 더 넣는 길이라 남는다');
});
test('풀기(unfold) 메뉴는 서버의 unfold를 그대로 부른다', () => {
  const app = reportClient();
  app.run(`
    calls = [];
    reportChange = async (target, action) => { calls.push(action); };
    item = { weekKey: '2026-09-14', draft: { revision: 1, rows: [
      { id: 'p1', heading: '완료한 일', group: '여러 프로젝트', text: '소소한 작업 2건', sourceIds: [], excluded: false, folded: true, manual: true },
      { id: 'a1', heading: '완료한 일', group: '가입 개선', text: '가입 배너 문구 확인', sourceIds: [], excluded: false, parent: 'p1' },
    ] } };
    pick = (row, label) => reportSentenceMenuSections(item, row).flat().find(entry => entry.label === label).onClick();
    pick(item.draft.rows[0], '풀기');
  `);
  assert.deepEqual(JSON.parse(app.run('JSON.stringify(calls[0])')), { action: 'unfold', id: 'p1' });
});
const REPORT_FOLD_ROWS = `[
  { id: 'p1', heading: '완료한 일', group: '여러 프로젝트', text: '소소한 작업 2건', sourceIds: [], evidence: [], excluded: false, folded: true, manual: true },
  { id: 'a1', heading: '완료한 일', group: '가입 개선', text: '가입 배너 문구 확인', sourceIds: [], excluded: false, parent: 'p1' },
  { id: 'a2', heading: '완료한 일', group: '결제 리뉴얼', text: '정산 배치 재처리 로그 확인', sourceIds: [], excluded: false, parent: 'p1' }
]`;
test('세 형식(일반 글자·서식 있는 복사·미리보기)은 접힌 부모는 한 줄만, 펼친 부모는 부모+아래 문장을 담는다', () => {
  const app = reportClient();
  const folded = `{ weekKey: '2026-09-21', rows: ${REPORT_FOLD_ROWS} }`;
  const textFolded = app.run(`reportSlackText(reportSlackModel(${folded}, { sections: ['완료'] }))`);
  assert.equal(textFolded, [
    '9월 4주차 (9/21~9/27)', '', '[완료]', '', '여러 프로젝트', '• 소소한 작업 2건',
  ].join('\n'), '접힌 부모는 부모 한 줄만 나가고 아래 문장·◦ 부연이 없다');
  assert.doesNotMatch(textFolded, /가입 배너|정산 배치/);
  const unfolded = `{ weekKey: '2026-09-21', rows: ${REPORT_FOLD_ROWS.replace('folded: true', 'folded: false')} }`;
  const textUnfolded = app.run(`reportSlackText(reportSlackModel(${unfolded}, { sections: ['완료'] }))`);
  assert.equal(textUnfolded, [
    '9월 4주차 (9/21~9/27)', '', '[완료]', '', '여러 프로젝트', '• 소소한 작업 2건',
    '    ◦ 가입 배너 문구 확인', '    ◦ 정산 배치 재처리 로그 확인',
  ].join('\n'), '펼친 부모는 부모 + 들여쓴 아래 문장이 그대로 나간다');
  // 미리보기(reportSlackLines)를 이어 붙이면 일반 글자와 정확히 같다 — 한 구조에서 나온다.
  const lines = JSON.parse(app.run(`JSON.stringify(reportSlackLines(reportSlackModel(${folded}, { sections: ['완료'] })))`));
  assert.equal(lines.map(l => l.text).join('\n'), textFolded);
  const html = app.run(`reportSlackHtml(reportSlackModel(${folded}, { sections: ['완료'] }))`);
  assert.doesNotMatch(html, /가입 배너|정산 배치/, '서식 있는 복사도 접힌 부모의 아래 문장을 싣지 않는다');
});
test('접힌 부모만 있는 프로젝트 블록에는 지라 정보가 붙지 않는다(근거 없음) — 같은 이름이 다른 곳에서 근거와 함께 나오면 거기에는 붙는다', () => {
  const app = reportClient();
  app.run(`
    jiraIssuesByKey = new Map([['PAY-77', { status: '진행 중', versions: [] }]]);
    deploySoonVersion = () => null;
  `);
  const rows = `[
    { id: 'p1', heading: '완료한 일', group: 'PAY-77 · 결제 정산', text: '소소한 작업 2건', sourceIds: [], evidence: [], excluded: false, folded: true, manual: true },
    { id: 'a1', heading: '완료한 일', group: 'PAY-77 · 결제 정산', text: '자식 문장', sourceIds: [], excluded: false, parent: 'p1' },
    { id: 'b1', heading: '진행중', group: 'PAY-77 · 결제 정산', text: '근거 있는 문장', sourceIds: ['s1'], excluded: false }
  ]`;
  const report = `{ weekKey: '2026-09-21', rows: ${rows} }`;
  const sections = JSON.parse(app.run(`JSON.stringify(reportSlackModel(${report}, { sections: ['완료', '진행 중'], jira: true }).sections)`));
  assert.equal(sections[0].projects[0].note, undefined, '접힌 부모만 있는 완료 블록에는 지라 정보가 붙지 않는다');
  assert.equal(sections[1].projects[0].note, ' (진행 중)', '근거가 있는 같은 프로젝트에는 붙는다');
});
test('한 줄로 모으기의 저장 알림은 개수를 적고 되돌리기 버튼을 함께 준다', () => {
  const notice = (action, token = "'tok'") => {
    const app = reportClient();
    app.run(`reportUndo.set('2026-09-14', ${token})`);
    app.run(`reportSavedNotice(${REPORT_ITEM}, ${action})`);
    const region = app.nodes.get('liveRegion');
    return [region.textContent, region.children.map(kid => kid.textContent)];
  };
  assert.deepEqual(notice(`{ action: 'fold', ids: ['a', 'b', 'c'] }`), ['한 줄로 모았어요 · 3건', ['되돌리기', '닫기']]);
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
    '9월 4주차 (9/21~9/27)',
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
    '9월 4주차 (9/21~9/27)',
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
  assert.equal(app.run(`reportSlackProjectLabel('ABC-1234')`), 'ABC-1234', '요약을 모르는 이슈는 키밖에 이름이 없다');
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

test('`지라 정보` 체크는 기본 꺼짐이고, 고른 값은 localStorage에 기억된다(막혀 있으면 꺼진 채로)', () => {
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
  // 개편 A: 칩 대신 `넣을 구역 ▾` 글자 고르개 + 작은 체크 `지라 정보`(기존 체크 부품 .d-wcb) — 저장 키는 그대로.
  const chips = app.nodes.get('weeklyReportPreview').children.find(kid => kid.className === 'rp-secs');
  assert.equal(chips.children[0].className, 'rp-gp', '구역은 글자 고르개 하나');
  const label = chips.children[chips.children.length - 1];
  assert.equal(label.className, 'rp-jchk');
  assert.equal(label.children[1].textContent, '지라 정보');
  const toggle = label.children[0];
  assert.deepEqual([toggle.type, toggle.className, toggle.checked], ['checkbox', 'd-wcb', false]);
  toggle.checked = true;
  toggle.listeners.change();
  assert.equal(app.run('reportJiraInfo'), true);
  assert.equal(saved.get('workspace-report-jira-info'), 'on');
  assert.equal(app.run('reportJiraInfoLoad()'), true, '다음에 열면 켜진 채로 시작한다');
  toggle.checked = false;
  toggle.listeners.change();
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
  const values = code => JSON.parse(app.run(`JSON.stringify(projectPickEntries(${code}).filter(e => e.type === 'option').map(e => [e.value, !!e.selected]))`));
  const fresh = values('null, false');
  assert.ok(fresh.some(([value]) => value === 'jira:AB-1'));
  assert.ok(!fresh.some(([value]) => value === 'jira:ZZ-9'), '완료된 이슈는 새로 고를 선택지로 내놓지 않는다');
  assert.deepEqual(values("{ type: 'jira', value: 'ZZ-9' }, false").find(([value]) => value === 'jira:ZZ-9'), ['jira:ZZ-9', true],
    '이미 걸려 있는 값은 골라진 채로 보여야 한다');
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
    projectKey = null; projectOrderKeys = null; projectOrderResort = true; projectPastOpen = null;
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
  ['IO-1', { key: 'IO-1', summary: '샘플 기능', status: 'QA 대기', versions: [${version('v2.70.0', 2)}] }],
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
  assert.equal(pick("{ key: 'IO-1', summary: '샘플 기능' }"), null, 'live 칸이 없는 옛 응답에서는 조용히 빠진다');
  assert.equal(pick('null'), null);
});

test('배포 임박 줄은 열린 항목이 있는 프로젝트만, 3일 안만, 급한 순으로 — 손으로 건 그룹 프로젝트도 함께', () => {
  const app = deployClient();
  const rows = deployRows(app);
  assert.deepEqual(rows.map(row => [row.label, row.name, row.text, row.open]), [
    ['운영툴 대시보드', 'v2.69.0', '배포일 2일 지남', 1],
    ['결제 리뉴얼', 'v2.72.0', '오늘 배포', 1],
    ['샘플 기능', 'v2.70.0', '배포 2일 전', 2],
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
  app.run('projectKey = null; projectOrderKeys = null; projectOrderResort = true; projectPastOpen = null; renderProjects();');
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

// 1.3.2: 레일 확인 대기의 원문은 따로 한 줄이 아니라 둘째 줄(`누구 · N일째`) 끝의 `슬랙 ↗`.
test('확인 대기 레일 줄: 원문이 있으면 둘째 줄 끝에 `슬랙 ↗`, 제목 묶음에는 없다', () => {
  const { app } = waitingNextClient();
  app.run("wfItem('ck1').permalink = 'https://example.slack.test/archives/C1/p1'");
  const row = app.run("renderWaitingRow(wfItem('ck1'))");
  assert.equal(nodeFind(row, 'tiwrap'), null, '제목 뒤 묶음(원문 자리)이 없다');
  const sub = nodeFind(row, 'sub');
  // 가짜 DOM은 조각(fragment)을 펼치지 않으므로 한 겹 벗겨 본다.
  const kids = sub.children.flatMap(node => node.className ? [node] : node.children);
  const last = kids[kids.length - 1];
  assert.equal(last.className, 'd-src');
  assert.equal(last.textContent, '슬랙 ↗');
  assert.equal(last.href, 'https://example.slack.test/archives/C1/p1');
  const css = fs.readFileSync(path.join(__dirname, 'ui.css'), 'utf8');
  assert.match(css, /^\.d-wrow\.is-two \.sub \.d-src::before \{ content: " · ";[^}]*color: var\(--dim\);/m, '앞에 흐린 ` · `');
  assert.ok(kids.findIndex(node => node.className === 'who') > -1
    && kids.findIndex(node => node.className === 'who') < kids.length - 1, '누구 · N일째 뒤에 선다');
});

test('확인 대기 레일 줄: 원문이 없으면 링크를 그리지 않는다(둘째 줄이 비면 둘째 줄도 없다)', () => {
  const { app } = waitingNextClient();
  assert.equal(nodeFind(app.run("renderWaitingRow(wfItem('ck1'))"), 'd-src'), null);
  // 누구·며칠째가 없고 원문만 있으면 둘째 줄에 링크만 선다.
  app.run("Object.assign(wfItem('ck2'), { created: '', permalink: 'https://example.slack.test/p2' })");
  const sub = nodeFind(app.run("renderWaitingRow(wfItem('ck2'))"), 'sub');
  assert.deepEqual(sub.children.flatMap(node => node.className ? [node] : node.children).map(node => node.className), ['d-src']);
});

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
  assert.equal(app.run('undoStack[0].label'), '법무 검토 회신 받기 (후속 할 일)', '⌘Z 이름표는 후속 할 일');
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
  const card = body.children.find(node => String(node.className).includes('d-pcard'));
  const section = card.children.find(node => node.className === 'd-pgrp'
    && node.children[0].children.some(kid => kid.textContent === '확인 대기'));
  // 그룹의 첫 자식은 제목이고 줄은 그 뒤에 바로 붙는다.
  assert.equal(section.children[1].className, 'd-wnextwrap', '체크한 줄은 그룹 맨 위(제목 바로 아래)에 다시 서고');
  assert.equal(section.children[1].children[1].className, 'd-wnext');
  assert.equal(section.children[2].children[1].textContent, '남은 확인', '남은 줄은 그대로다');

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
  // 0시대에는 아래 고정 시각(00:00 시작, end 없으면 01:00까지로 추정)이 아직 "끝난" 것이 아닐 수 있어 건너뛴다.
  if (new Date().getHours() === 0) return;
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
  assert.equal(gear('08:00', { today, calendar: { stale: false, lastSync: today }, jiraSync: { stale: false, lastSync: today }, slackSync: { stale: true, lastSync: ago(1), error: '실패' } }).label, '설정 — 슬랙 수집 어제 기준', '오류가 있었으면 아침에도 알린다(이름은 연동 탭 카드 이름)');
  assert.equal(gear('10:00', { today, calendar: { stale: true, lastSync: null }, slackSync: { stale: false, lastSync: today }, jiraSync: { stale: true, lastSync: ago(2) } }).label, '설정 — 자동 갱신 2개 확인 필요');
  assert.equal(gear('10:00', { today, calendar: { stale: false, lastSync: today }, slackSync: { stale: false, lastSync: today }, jiraSync: { stale: false, lastSync: today } }).label, '설정', '다 최신이면 점도 말도 없다(점은 낡은 것이 있을 때만 켜진다)');
});

// WP-M: renderDateBar가 헤더의 제목(`#workspaceTitle`)만 숨긴다 — 값·document.title은 그대로 쓴다.
test('WP-M renderDateBar: titleHidden이면 헤더 제목만 감추고 값·document.title은 그대로 쓰며, 없으면(옛 설치) 보인다', () => {
  const app = pureClient();
  const today = app.run('todayStr()');
  app.context.document.title = '';
  app.run(`renderDateBar(${JSON.stringify({ today, title: '내 워크스페이스' })})`);
  assert.equal(app.nodes.get('workspaceTitle').hidden, false, '값이 없으면(옛 설치) 보이기');
  assert.equal(app.context.document.title, '내 워크스페이스');

  app.run(`renderDateBar(${JSON.stringify({ today, title: '내 워크스페이스', titleHidden: true })})`);
  assert.equal(app.nodes.get('workspaceTitle').hidden, true);
  assert.equal(app.nodes.get('workspaceTitle').textContent, '내 워크스페이스', '제목 값은 그대로 남는다');
  assert.equal(app.context.document.title, '내 워크스페이스', '창·탭 이름에는 계속 쓰인다');

  app.run(`renderDateBar(${JSON.stringify({ today, title: '내 워크스페이스', titleHidden: false })})`);
  assert.equal(app.nodes.get('workspaceTitle').hidden, false, '다시 켜면 원래대로 보인다');
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
  key: 'ABC-1234',
  url: 'https://example-jira.test/browse/ABC-1234',
  summary: '예시 게시글 작성하기_샘플 기능',
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
  assert.match(text, /예시 게시글 작성하기_샘플 기능/);
  assert.match(text, /에픽 · 담당 루본/);
  assert.match(text, /지라 상태 진행 중/);
  assert.match(text, /배포 버전 v2\.70\.0/);
  assert.match(text, /기한 10월 2일/);
  assert.match(text, /하위 티켓 .*12개 중 7개 완료/);
  assert.equal(nodeFind(card, 'v').className, 'v k-acc', '진행 범주는 파란 글자다(BJCOLOR)');
  // 지라에서 온 글자는 전부 textContent로만 들어간다(새 innerHTML을 쓰지 않는다).
  assert.doesNotMatch(nodeHtml(card), /게시글 작성하기|진행 중|v2\.70\.0/);
  // 키는 `지라에서 열기` 링크의 title에만 보인다(BKEY 결정) — 카드 글자에는 없다.
  assert.doesNotMatch(text, /ABC-1234/);
  const link = nodeFind(card, 'd-jopen');
  assert.equal(link.getAttribute('href'), undefined);
  assert.equal(link.href, 'https://example-jira.test/browse/ABC-1234');
  assert.equal(link.target, '_blank');
  assert.equal(link.rel, 'noopener noreferrer');
  assert.match(link.title, /^ABC-1234 · /);

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
  app.run("document.getElementById('jiraStrip').dataset.jiraKey = 'ABC-1234'");
  const loading = app.run("jiraCard = { ...jiraCard, key: 'ABC-1234', state: 'loading' }; jiraStripBody('ABC-1234')");
  assert.equal(loading.className, 'd-jira is-loading');
  assert.equal(loading.getAttribute('aria-hidden'), 'true');
  assert.equal(nodeText(loading), '', '뼈대에는 글자가 없다');

  const off = app.run("jiraCard = { ...jiraCard, state: 'off' }; jiraStripBody('ABC-1234')");
  assert.equal(nodeText(off), '지라 연결이 필요해요 · 설정 방법');
  const help = nodeFind(off, 'd-link');
  assert.match(help.title, /README의 "지라 연결 설정" 절/);
  assert.equal(help.href, undefined, '새 창으로 나가는 링크가 아니다');
  help.listeners.click();
  assert.match(app.nodes.get('liveRegion').textContent, /README의 "지라 연결 설정" 절/);

  const failed = app.run("jiraCard = { ...jiraCard, state: 'error', error: '지라 토큰을 확인해 주세요.' }; jiraStripBody('ABC-1234')");
  assert.equal(nodeText(failed), '지라 토큰을 확인해 주세요. · 다시 시도');
  await nodeFind(failed, 'd-link').listeners.click();
  assert.equal(app.run('jiraCard.state'), 'ok', '`다시 시도`가 다시 읽어 온다');
  assert.equal(app.run('jiraCard.issue.summary'), '예시 게시글 작성하기_샘플 기능');
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
// 미완료는 루본 2 · 하늘 1 · 담당 없음 1, 완료는 1개다.
const jiraKids = () => [
  jiraKid('IO-48391', '임베드 카드 붙이기', 'done', '루본'),
  jiraKid('IO-48392', '게임 목록 불러오기', 'doing', '루본', 'v2.70.0'),
  jiraKid('IO-48393', '미리보기 문구 정리하기', 'todo', '하늘'),
  jiraKid('IO-48395', '검수 항목 정리하기', 'doing', null),
  jiraKid('IO-48396', '오류 문구 다듬기', 'todo', '루본'),
];
const jiraWithKids = (items = jiraKids(), extra = {}) => jiraIssue({
  children: { total: items.length, done: items.filter(item => item.status.category === 'done').length, items },
  ...extra,
});
// 카드를 실제 화면 자리(`#jiraStrip`)에 세운다 — 꺾쇠·이름을 누르면 그 자리가 다시 그려진다.
function jiraKidFixture(issue, projectKey = 'jira:ABC-1234', storage = null) {
  const app = pureClient();
  if (storage) app.context.localStorage = storage;
  app.run(`jiraCard = { key: 'ABC-1234', state: 'ok', issue: ${JSON.stringify(issue)}, error: '', at: Date.now(), seq: 1 };`);
  const host = app.nodes.get('jiraStrip') || app.run("document.getElementById('jiraStrip')");
  host.dataset.jiraKey = 'ABC-1234';
  host.dataset.project = projectKey;
  app.run('jiraStripPaint()');
  return { app, host, card: () => host.children[0] };
}

test('담당별 요약은 미완료만 세고 많은 순·가나다순으로, 넷을 넘으면 `외 N명`으로 줄인다', () => {
  const app = pureClient();
  const summary = items => JSON.parse(app.run(`JSON.stringify(jiraChildSummary(${JSON.stringify(items)}))`));
  const basic = summary(jiraKids());
  assert.deepEqual(basic.names, [{ name: '루본', count: 2 }, { name: '하늘', count: 1 }, { name: '담당 없음', count: 1 }],
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
  assert.match(nodeText(foot), /하위 티켓 .*5개 중 1개 완료 .*루본 2 · 하늘 1 · 담당 없음 1/);
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

test('지라 띠 B(두 줄): 하위 티켓 칸은 값 칸 줄(.cells)의 마지막 칸이고, 하위가 없으면 값 한 줄뿐이다', () => {
  const app = pureClient();
  const card = app.run(`jiraStripCard(${JSON.stringify(jiraIssue())})`);
  assert.deepEqual(card.children.map(kid => kid.className), ['top', 'cells'], '카드는 두 줄 — 셋째 줄(.foot)이 따로 서지 않는다');
  const cells = card.children[1];
  assert.deepEqual(cells.children.map(kid => kid.className), ['cell', 'cell', 'cell', 'foot'], '값 셋 뒤 같은 줄에 하위 티켓');
  assert.match(nodeText(cells.children[3]), /하위 티켓 .*12개 중 7개 완료/);

  const bare = app.run(`jiraStripCard(${JSON.stringify(jiraIssue({ children: null }))})`);
  assert.deepEqual(bare.children[1].children.map(kid => kid.className), ['cell', 'cell', 'cell'], '하위 티켓이 없으면 값 한 줄');
  assert.equal(nodeFind(bare, 'foot'), null);

  // 펼친 하위 목록은 값 줄 안이 아니라 카드 맨 끝에 선다(확인 줄 아래).
  const { card: open } = jiraKidFixture(jiraWithKids());
  nodeFind(open(), 'd-jexp').listeners.click();
  assert.equal(open().children.at(-1).className.split(' ')[0], 'd-jkids');
  assert.equal(nodeFind(nodeFind(open(), 'cells'), 'd-jkids'), null, '목록은 값 줄 안에 들어가지 않는다');

  // 좁아지면 하위 티켓 칸만 다음 줄로 내려간다 — 칸은 남은 폭을 채우되 420px보다 좁아지지 않는다.
  const css = fs.readFileSync(path.join(__dirname, 'ui.css'), 'utf8');
  assert.match(css, /^\.d-jira \.cells \{ display: flex; flex-wrap: wrap;/m);
  assert.match(css, /^\.d-jira \.cells > \.foot \{ flex: 1 1 420px;/m);
  assert.doesNotMatch(css.match(/^\.d-jira \.foot \{[^}]*\}/m)[0], /border-top/, '셋째 줄 구분선은 없다');
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
  assert.equal(app.run("jiraChildPicks.get('ABC-1234') ?? null"), null);
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
  assert.equal(app.run("jiraChildPicks.get('ABC-1234') ?? null"), '루본');
  assert.equal(nodeFind(card(), 'd-jexp').getAttribute('aria-expanded'), 'true', '이름을 누르면 함께 펼쳐진다');
  assert.deepEqual(nodeFindAll(card(), 'd-jkid').map(row => nodeFind(row, 'sm').textContent),
    ['게임 목록 불러오기', '오류 문구 다듬기', '임베드 카드 붙이기'], '그 사람의 완료한 것도 함께 보인다');
  assert.equal(whoButton('루본').getAttribute('aria-pressed'), 'true');
  assert.equal(whoButton('하늘').getAttribute('aria-pressed'), 'false');
  // 거르는 중에만 `전체`가 붙는다.
  const clear = nodeFindAll(card(), 'd-jwho').find(button => button.textContent === '전체');
  assert.ok(clear);
  clear.listeners.click();
  assert.equal(app.run("jiraChildPicks.get('ABC-1234') ?? null"), null);
  assert.equal(nodeFindAll(card(), 'd-jkid').length, 5);
  assert.equal(nodeFindAll(card(), 'd-jwho').find(button => button.textContent === '전체'), undefined);

  // 같은 이름을 다시 누르면 해제된다(펼침은 그대로).
  whoButton('하늘').listeners.click();
  assert.equal(nodeFindAll(card(), 'd-jkid').length, 1);
  whoButton('하늘').listeners.click();
  assert.equal(app.run("jiraChildPicks.get('ABC-1234') ?? null"), null);
  assert.equal(nodeFindAll(card(), 'd-jkid').length, 5);

  // 거르는 중에 그 사람의 티켓이 사라지면 조용한 한 줄만 남는다(빈 칸을 남기지 않는다).
  whoButton('하늘').listeners.click();
  app.run(`jiraCard = { ...jiraCard, issue: ${JSON.stringify(jiraWithKids(jiraKids().filter(item => item.assignee !== '하늘')))} }; jiraStripPaint()`);
  assert.equal(nodeText(nodeFind(card(), 'd-jkids')), '이 담당의 하위 티켓이 없어요');
});

test('펼침은 프로젝트별로 기억하고, 쓰기 뒤 `fresh` 재조회로 다시 그려도 그대로다', () => {
  const store = new Map();
  const storage = { getItem: key => (store.has(key) ? store.get(key) : null), setItem: (key, value) => store.set(key, String(value)) };
  const first = jiraKidFixture(jiraWithKids(), 'jira:ABC-1234', storage);
  nodeFind(first.card(), 'd-jexp').listeners.click();
  assert.deepEqual(JSON.parse(store.get('jiraChildrenOpen')), ['jira:ABC-1234']);

  // 2단계의 쓰기가 끝나고 `fresh=1`로 다시 읽어 그려도 펼침·거르기는 그대로다.
  first.app.run("jiraChildPicks.set('ABC-1234', '루본')");
  first.app.run(`jiraCard = { ...jiraCard, issue: ${JSON.stringify(jiraWithKids())}, at: Date.now() }; jiraStripPaint()`);
  assert.equal(nodeFind(first.card(), 'd-jexp').getAttribute('aria-expanded'), 'true');
  assert.equal(nodeFindAll(first.card(), 'd-jkid').length, 3, '거르기도 살아 있다');
  // 같은 프로젝트를 다시 그리는 것(jiraCardEnsure)으로는 거르기가 풀리지 않는다.
  first.app.run("jiraCardEnsure('ABC-1234')");
  assert.equal(first.app.run("jiraChildPicks.get('ABC-1234') ?? null"), '루본');
  // 다른 프로젝트로 옮기면 거르기만 풀린다(펼침은 프로젝트마다 기억한 대로다).
  first.app.run("jiraCardEnsure('AB-9')");
  assert.equal(first.app.run("jiraChildPicks.get('ABC-1234') ?? null"), null);

  // 다음에 같은 프로젝트를 열면 기억한 대로 펼쳐져 있다.
  const again = jiraKidFixture(jiraWithKids(), 'jira:ABC-1234', storage);
  assert.equal(nodeFind(again.card(), 'd-jexp').getAttribute('aria-expanded'), 'true');
  assert.equal(nodeFindAll(again.card(), 'd-jkid').length, 5);
  // 다른 프로젝트는 기억이 따로다.
  const other = jiraKidFixture(jiraWithKids(), 'group:알림센터', storage);
  assert.equal(nodeFind(other.card(), 'd-jexp').getAttribute('aria-expanded'), 'false');
  // 손으로 건 그룹 프로젝트에서도 카드 모양은 같다.
  nodeFind(other.card(), 'd-jexp').listeners.click();
  assert.equal(nodeFindAll(other.card(), 'd-jkid').length, 5);
  assert.deepEqual(JSON.parse(store.get('jiraChildrenOpen')), ['jira:ABC-1234', 'group:알림센터']);
});

test('기억해 둘 곳이 막혀 있어도 펼치기는 그대로 동작한다', () => {
  // 사생활 보호 창처럼 localStorage가 던지는 자리 — 기억만 못 할 뿐 화면은 그대로다.
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  const { card } = jiraKidFixture(jiraWithKids(), 'jira:ABC-1234', blocked);
  nodeFind(card(), 'd-jexp').listeners.click();
  assert.equal(nodeFindAll(card(), 'd-jkid').length, 5);
});

test('하위가 100개면 목록 끝에 `지라에서 전체 보기`가 붙는다', () => {
  const items = Array.from({ length: 100 }, (unused, at) => jiraKid(`AB-${at + 1}`, `하위 ${at + 1}`, 'doing', '루본'));
  const { card } = jiraKidFixture(jiraWithKids(items));
  nodeFind(card(), 'd-jexp').listeners.click();
  const all = nodeFind(card(), 'all');
  assert.equal(all.textContent, '지라에서 전체 보기 ↗');
  assert.equal(all.href, 'https://example-jira.test/browse/ABC-1234');
  assert.equal(all.rel, 'noopener noreferrer');
  assert.equal(all.target, '_blank');
  assert.match(all.title, /^ABC-1234 · /);
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
  assert.match(fixture.calls[0].url, /\/api\/jira\/options\?key=ABC-1234$/);
  assert.equal(fixture.calls[0].method, 'GET');

  jiraMenuItems(sections)[1].onClick();
  assert.equal(fixture.posts().length, 0, '값을 고른 것만으로는 지라에 쓰지 않는다');
  const row = fixture.confirm();
  assert.ok(row, '카드 안에 확인 줄이 선다');
  const text = nodeText(row);
  assert.match(text, /지라의 이 티켓을 바꿀까요\?/);
  assert.match(text, /예시 게시글 작성하기_샘플 기능/, '확인 창에는 티켓 요약을 쓴다');
  assert.match(text, /ABC-1234/, '키는 조용한 글자로만 붙는다');
  assert.match(text, /지라 상태: 진행 중 → 완료/, '전 → 후를 보여 준다');
  assert.match(text, /취소 바꾸기/);
  assert.equal(nodeFind(row, 'ky').textContent, 'ABC-1234');

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
  assert.deepEqual(plain(posts[0].body), { key: 'ABC-1234', kind: 'status', transitionId: '21' });
  // 낙관적 갱신 금지 — 성공한 뒤 지라에서 새로 읽어 그 값만 그린다.
  assert.match(fixture.calls[fixture.calls.length - 1].url, /\/api\/jira\/issue\?key=ABC-1234&fresh=1$/);
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
  assert.deepEqual(plain(fixture.posts()[0].body), { key: 'ABC-1234', kind: 'due', due: null });
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
  // 값 칸 줄 끝의 하위 티켓 칸(.foot)은 고르개가 아니다 — 값 칸(.cell) 셋만 센다.
  const picks = nodeFindAll(nodeFind(locked, 'cells'), 'cell').map(cell => nodeFind(cell, 'd-dpick'));
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
    { key: 'ABC-1234', kind: 'versionEdit', versionId: '1', name: 'v2.70.1' });
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
    { key: 'ABC-1234', kind: 'versionEdit', versionId: '1', releaseDate: '2026-10-07' });
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
    { key: 'IO-12345', summary: '예시 게시글 작성하기_샘플 기능' },
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
  assert.match(nodeText(preview), /예시 게시글 작성하기_샘플 기능/);
  assert.match(nodeText(preview), /진행 중 · 담당 루본/);
  assert.equal(nodeFind(preview, 'ky').textContent, 'IO-12345', '키는 조용한 글자로만 선다');
  assert.equal(fixture.posts().length, 0, '미리 보기까지는 저장이 없다');
  // 지라가 준 글자는 전부 textContent로만 들어간다(새 innerHTML을 쓰지 않는다).
  assert.doesNotMatch(nodeHtml(preview), /게시글 작성하기|진행 중/);

  // 고른 티켓이 에픽이라(BMOVE) 옮기기 버튼도 함께 있고, `연결`은 `연결만`으로 불린다.
  const connect = (preview.children.find(kid => kid.className === 'acts').children || []).find(kid => kid.textContent === '연결만');
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
    ['내 담당 티켓', '예시 게시글 작성하기_샘플 기능 · IO-12345', '정산 배치 · PAY-77', '완료한 티켓도 보기']);
});

test('BJLINK: 이미 다른 프로젝트에 걸린 티켓도 막지 않고 조용히 알리기만 한다', async () => {
  const fixture = jiraLinkClient({ links: { 운영툴: 'ABC-1234' } });
  fixture.open('group:가입 개선');
  await fixture.app.run("jiraLinkFind('group:가입 개선', 'ABC-1234')");
  assert.match(nodeText(fixture.node()), /다른 프로젝트 '운영툴'에도 연결돼 있어요/);
  const acts = fixture.node().children.find(kid => kid.className === 'acts');
  // 고른 티켓이 에픽이라(BMOVE) 옮기기 버튼도 함께 있다 — 막지 않는다는 뜻은 `연결만`이 그대로 있다는 것.
  assert.deepEqual(acts.children.map(kid => kid.textContent), ['취소', '연결만', '이 에픽으로 옮기기'], '막지 않는다 — `연결만`이 그대로 있다');
});

test('BJLINK: 띠 카드의 ⋯은 손으로 건 그룹 프로젝트에만 있고, 해제는 알림의 `되돌리기`로 되돌린다', async () => {
  const fixture = jiraLinkClient({ links: { 운영툴: 'ABC-1234' } });
  const bare = fixture.app.run(`jiraStripCard(${JSON.stringify(jiraIssue())})`);
  assert.equal(nodeFind(bare, 'd-more'), null, '예전처럼 부르면 ⋯이 없다');
  const jiraProject = fixture.app.run(`jiraStripCard(${JSON.stringify(jiraIssue())}, 'jira:ABC-1234')`);
  assert.equal(nodeFind(jiraProject, 'd-more'), null, '`jira:KEY` 프로젝트에는 풀 연결이 없다');

  const card = fixture.app.run(`jiraStripCard(${JSON.stringify(jiraIssue())}, 'group:운영툴')`);
  const more = nodeFind(card, 'd-more');
  assert.equal(more.getAttribute('aria-label'), '지라 연결 — 더 보기');
  more.listeners.click({ stopPropagation() {} });
  const menu = JSON.parse(fixture.app.run("JSON.stringify(lastMenu.flat().map(one => one.label))"));
  // 고른 티켓이 에픽이라(BMOVE) 옮기기 항목도 같은 메뉴에 선다.
  assert.deepEqual(menu, ['지라 연결 해제', 'ABC-1234으로 옮기기…']);

  await fixture.app.run("lastMenu[0][0].onClick()");
  assert.deepEqual(fixture.posts().map(call => call.body), [{ project: 'group:운영툴', jira: null }]);
  const notice = fixture.app.nodes.get('liveRegion');
  assert.match(notice.textContent, /지라 연결을 해제했어요/);
  const undo = notice.children.find(kid => kid.textContent === '되돌리기');
  await undo.listeners.click();
  assert.deepEqual(fixture.posts().map(call => call.body), [
    { project: 'group:운영툴', jira: null },
    { project: 'group:운영툴', jira: 'ABC-1234' },
  ], '되돌리기는 같은 키로 다시 건다');
  assert.match(fixture.app.nodes.get('liveRegion').textContent, /지라 티켓을 다시 연결했어요/);
});

test('BJLINK: 연결해도 다른 화면의 프로젝트 이름·키 표기는 그대로다', () => {
  const before = jiraLinkClient();
  const after = jiraLinkClient({ links: { 운영툴: 'ABC-1234' } });
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

// ---------- BMOVE: 직접 만든 프로젝트 → 지라 에픽으로 옮기기 ----------
// 실제 지라는 부르지 않는다. `/api/jira/issue`·`/api/project/move`·`/api/project/move-undo`는 전부 가짜 fetch다.
function bmoveClient({ issue = jiraIssue(), moveAnswer = null, undoAnswer = null } = {}) {
  const fixture = jiraLinkClient({ issue });
  const calls = fixture.calls;
  const baseFetch = fixture.app.context.fetch;
  fixture.app.context.fetch = async (url, options) => {
    const method = (options && options.method) || 'GET';
    if (String(url).includes('/api/project/move-undo')) {
      calls.push({ url: String(url), method, body: options && options.body ? JSON.parse(options.body) : null });
      return new Response(JSON.stringify(undoAnswer || {
        ok: true, project: 'group:결제 리뉴얼', restored: { items: 2, meetings: 1, report: 1 }, skipped: 0,
      }));
    }
    if (String(url).includes('/api/project/move')) {
      calls.push({ url: String(url), method, body: options && options.body ? JSON.parse(options.body) : null });
      return new Response(JSON.stringify(moveAnswer || {
        ok: true, project: 'jira:IO-48501', from: '결제 리뉴얼', to: 'IO-48501', moveId: 'mv_1',
        changed: { items: 2, meetings: 1, links: 0, report: 1 },
      }));
    }
    return baseFetch(url, options);
  };
  // 항목 2 · 회의 1 · 주간요약 문장 1 — 확인 줄 숫자가 이 값과 같은지를 본다.
  fixture.app.run(`workflowData = { items: [
    { id: 'a1', type: 'task', status: 'to-do', group: '결제 리뉴얼' },
    { id: 'a2', type: 'check', status: 'to-do', group: '결제 리뉴얼' },
    { id: 'a3', type: 'task', status: 'to-do', group: '운영툴' },
  ], meetings: [
    { id: 'm1', title: '결제 주간 싱크', project: { type: 'group', value: '결제 리뉴얼', label: '결제 리뉴얼' } },
  ], projectLinks: {} }; wfIndexData(); itemsById = new Map();`);
  fixture.app.run(`latestData = { jiraSync: { used: true, connected: true, siteUrl: 'https://example-jira.test' }, weeklyReports: [
    { weekKey: '2026-09-14', draft: { rows: [
      { id: 'r1', bucket: 'group:결제 리뉴얼:완료한 일:정산 배치', group: '결제 리뉴얼' },
      { id: 'r2', bucket: 'group:운영툴:진행중:운영', group: '운영툴' },
    ] } },
  ] };`);
  fixture.app.run('opened = null; openProjectTab = key => { opened = key; };');
  fixture.app.run('loads = 0; load = async () => { loads += 1; };');
  return { ...fixture, opened: () => fixture.app.run('opened'), loads: () => fixture.app.run('loads') };
}

test('BMOVE ③: 고른 티켓이 에픽일 때만 `이 에픽으로 옮기기`가 보이고, 확인 줄 숫자는 화면이 가진 값이다', async () => {
  const fixture = bmoveClient();
  fixture.open('group:결제 리뉴얼');
  await fixture.app.run("jiraLinkFind('group:결제 리뉴얼', 'IO-48501')");
  const acts = fixture.node().children.find(kid => kid.className === 'acts');
  assert.deepEqual(acts.children.map(kid => kid.textContent), ['취소', '연결만', '이 에픽으로 옮기기']);
  const move = acts.children.find(kid => kid.textContent === '이 에픽으로 옮기기');
  move.listeners.click();
  const confirm = fixture.node().children.find(kid => kid.className === 'd-jconfirm');
  assert.equal(confirm.children[0].textContent,
    '결제 리뉴얼의 항목 2 · 회의 1 · 주간요약 문장 1를 IO-48501로 옮길까요? 옮기면 결제 리뉴얼 프로젝트는 목록에서 사라져요(기록은 전부 에픽에 남아요).');
});

test('BMOVE ③: 에픽이 아니면 옮기기 버튼이 없다 — `연결`만 그대로다', async () => {
  const fixture = bmoveClient({ issue: jiraIssue({ type: '스토리' }) });
  fixture.open('group:결제 리뉴얼');
  await fixture.app.run("jiraLinkFind('group:결제 리뉴얼', 'IO-9002')");
  const acts = fixture.node().children.find(kid => kid.className === 'acts');
  assert.deepEqual(acts.children.map(kid => kid.textContent), ['취소', '연결']);
});

test('BMOVE ③: 옮기면 데이터를 먼저 받고 에픽 프로젝트를 열며, 알림의 되돌리기는 move-undo로 반대 방향을 연다', async () => {
  const fixture = bmoveClient();
  fixture.open('group:결제 리뉴얼');
  await fixture.app.run("jiraLinkFind('group:결제 리뉴얼', 'IO-48501')");
  fixture.app.run("jiraLink = { ...jiraLink, moveConfirm: true }; jiraLinkPaint();");
  const confirm = fixture.node().children.find(kid => kid.className === 'd-jconfirm');
  const go = confirm.children.find(kid => kid.className === 'acts').children.find(kid => kid.textContent === '옮기기');
  await go.listeners.click();
  assert.deepEqual(fixture.posts().map(call => [call.url, call.body]), [
    ['/api/project/move', { project: 'group:결제 리뉴얼', to: 'IO-48501' }],
  ]);
  assert.equal(fixture.loads(), 1, '데이터를 먼저 새로 받는다');
  assert.equal(fixture.opened(), 'jira:IO-48501');
  const notice = fixture.app.nodes.get('liveRegion');
  assert.match(notice.textContent, /IO-48501로 옮겼어요 · 항목 2/);
  const undo = notice.children.find(kid => kid.textContent === '되돌리기');
  await undo.listeners.click();
  assert.deepEqual(fixture.posts().slice(-1).map(call => [call.url, call.body]), [['/api/project/move-undo', { moveId: 'mv_1' }]]);
  assert.equal(fixture.opened(), 'group:결제 리뉴얼');
  assert.match(fixture.app.nodes.get('liveRegion').textContent, /결제 리뉴얼 프로젝트로 되돌렸어요/);
});

test('BMOVE ③: 이미 연결된 그룹은 띠 카드 ⋯에 `IO-…으로 옮기기…`가 더 붙고, 확인 줄에서 그대로 보낸다', async () => {
  const fixture = bmoveClient();
  const issue = jiraIssue({ key: 'IO-48501' });
  const card = fixture.app.run(`jiraStripCard(${JSON.stringify(issue)}, 'group:결제 리뉴얼')`);
  const more = nodeFind(card, 'd-more');
  more.listeners.click({ stopPropagation() {} });
  const menu = JSON.parse(fixture.app.run("JSON.stringify(lastMenu.flat().map(one => one.label))"));
  assert.deepEqual(menu, ['지라 연결 해제', 'IO-48501으로 옮기기…']);
  fixture.app.run('lastMenu[0][1].onClick()');
  const again = fixture.app.run(`jiraStripCard(${JSON.stringify(issue)}, 'group:결제 리뉴얼')`);
  const confirm = nodeFind(again, 'd-jconfirm');
  assert.match(confirm.children[0].textContent, /결제 리뉴얼의 항목 2 · 회의 1 · 주간요약 문장 1를 IO-48501로 옮길까요/);
  const go = confirm.children.find(kid => kid.className === 'acts').children.find(kid => kid.textContent === '옮기기');
  await go.listeners.click();
  assert.deepEqual(fixture.posts().map(call => [call.url, call.body]), [
    ['/api/project/move', { project: 'group:결제 리뉴얼', to: 'IO-48501' }],
  ]);
});

test('BMOVE ②: 빈 에픽을 열면 같은 이름의 그룹 프로젝트를 옮기자고 묻고, 아니요는 기억해 다시 묻지 않는다', async () => {
  const fixture = bmoveClient();
  fixture.app.run("var saved = {}; localStorage = { getItem: k => (k in saved ? saved[k] : null), setItem: (k, v) => { saved[k] = String(v); } };");
  // 빈 에픽이라 items를 IO-48501에 건 것은 하나도 없다 — 지금 카드는 조용한 오류 자리로 둬 소음을 없앤다.
  fixture.app.run("jiraCard = { key: 'IO-48501', state: 'error', issue: null, error: '', at: 0, seq: 0 };");
  // 이름이 같은지(wfGroupNameKey)는 지라 요약으로 견준다 — 그 요약을 '결제 리뉴얼'로 맞춰 둔다.
  fixture.app.run(`jiraIssuesCache = [{ key: 'IO-48501', summary: '결제 리뉴얼', extra: false }];
    jiraIssuesByKey = new Map(jiraIssuesCache.map(one => [one.key, one]));`);
  const body = () => fixture.app.run(`(() => {
    const box = document.createElement('div');
    renderProjectDetail(box, { key: 'jira:IO-48501', label: 'jira:IO-48501', open: 0 });
    return box;
  })()`);
  const suggestLine = box => nodeFindAll(box, 'd-jline').find(kid => /여기로 옮길까요/.test(nodeText(kid)));

  const first = body();
  const line = suggestLine(first);
  assert.ok(line, '이름이 같은 그룹(결제 리뉴얼, 항목 2)이 있으면 제안 줄이 선다');
  assert.equal(nodeText(line), '결제 리뉴얼 프로젝트의 항목 2개를 여기로 옮길까요? · 옮기기 · 아니요');

  const move = line.children.find(kid => kid.textContent === '옮기기');
  move.listeners.click();
  const confirm = nodeFind(body(), 'd-jconfirm');
  assert.match(confirm.children[0].textContent, /결제 리뉴얼의 항목 2 · 회의 1 · 주간요약 문장 1를 IO-48501로 옮길까요/);
  const go = confirm.children.find(kid => kid.className === 'acts').children.find(kid => kid.textContent === '옮기기');
  await go.listeners.click();
  assert.deepEqual(fixture.posts().map(call => [call.url, call.body]), [
    ['/api/project/move', { project: 'group:결제 리뉴얼', to: 'IO-48501' }],
  ]);

  // 되돌아와 다시 봤을 때는(옮기지 않고 이번엔 `아니요`를 눌렀다고 가정) 기억한 짝은 다시 묻지 않는다.
  fixture.app.run("projectMoveSuggestConfirm = null;");
  const again = body();
  const no = suggestLine(again).children.find(kid => kid.textContent === '아니요');
  no.listeners.click();
  assert.deepEqual(JSON.parse(fixture.app.run("localStorage.getItem('projectMoveDismissed')")), { 'IO-48501': '결제 리뉴얼' });
  assert.equal(suggestLine(body()), undefined, '아니요 뒤에는 다시 묻지 않는다');
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

// BJLIVE의 `설정 > 상태` 지라 줄(jiraLiveNote·jiraLiveStatusRow)은 상태 탭과 함께 없앴다 — 같은 사실(연결됨·
// 앱이 직접 읽는 때·연결 안 됨)은 이제 연동 탭 지라 카드의 상태 줄이 말한다(아래 WP-E 지라 카드 테스트).

// ---------- BNOTES B: 슬랙 처리 대장(설정 › 연동 › 슬랙 ⋯ › 최근 기록 맨 위) ----------
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

test('slackLedgerNotes: 처리 대장을 슬랙 최근 기록 위 조용한 줄로 그리고 0인 항목은 흐리게, 합이 안 맞으면 주의색, 문장이 없으면 아무것도 안 그린다', () => {
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
        { key: 'IO-12345', summary: '예시 게시글 작성하기_샘플 기능', status: '완료', category: 'done', extra: false },
      ] }));
    }
    const asked = (String(url).match(/key=([^&]+)/) || [, ''])[1];
    return new Response(JSON.stringify({ ok: true, connected: true, issue: { key: decodeURIComponent(asked), summary: '미리 보기', status: { name: '완료' }, assignee: null } }));
  };
  app.run("latestData = { jiraSync: { used: true, connected: true, siteUrl: 'https://example-jira.test' } };");
  app.run("workflowData = { items: [], meetings: [], projectLinks: {} }; wfIndexData(); itemsById = new Map();");
  app.run(`jiraIssuesCache = [
    { key: 'IO-12345', summary: '예시 게시글 작성하기_샘플 기능' },
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
    ['내 담당 티켓', '예시 게시글 작성하기_샘플 기능 · IO-12345', '정산 배치 · PAY-77', '완료한 티켓도 보기']);
  assert.equal(fixture.doneCalls().length, 0, '열기만 해서는 지라를 부르지 않는다');
  assert.equal(fixture.more().className, 'pk qt', '조용한 글자다');

  await fixture.app.run("jiraLinkLoadDone('group:가입 개선')");
  assert.deepEqual(fixture.doneCalls(), ['/api/jira/done?days=90'], '기간은 90일이고 한 번만 부른다');
  assert.deepEqual(fixture.lines(), [
    { text: '내 담당 티켓', className: 'note' },
    { text: '예시 게시글 작성하기_샘플 기능 · IO-12345', className: 'pk' },
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
    projectKey = null; projectOrderKeys = null; projectOrderResort = true; projectPastOpen = null;`);
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

test('BNOARCHIVE: 제목 ⋯ 메뉴에 보관 항목이 없다 — 그룹 프로젝트는 이름 바꾸기만, 지라 프로젝트는 이름 바꾸기(별칭)만이고 요약 줄에 `보관한 프로젝트` 문구도 없다', () => {
  const app = workflowsClient();
  app.run("latestData = { jiraSync: { used: false } }; jiraIssuesCache = []; jiraIssuesByKey = new Map(); customGroupsCache = []; projectAliasesCache = {};");
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

  // 지라 프로젝트는 보관 관련 항목은 없지만, 별칭을 위한 `이름 바꾸기`는 있다(BJALIAS — 보관을
  // 없애며 사라졌던 ⋯이 이 용도로 돌아왔다).
  app.run('lastMenu = null;');
  const jiraBody = detail('jira:IO-1');
  nodeFind(jiraBody.children[0], 'd-more').listeners.click({ stopPropagation() {} });
  assert.equal(app.run('lastMenu')[0].map(entry => entry.label).join(','), '이름 바꾸기', '별칭이 없으면 이름 바꾸기 하나뿐이다');
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
  const rest = JSON.parse(app.run("JSON.stringify(projectPickEntries(null, false).map(e => e.type === 'heading' ? `# ${e.text}` : e.value))"));
  assert.deepEqual(rest, [
    'jira:IO-1',
    'group:운영툴',
    '# 지난 프로젝트',
    'jira:IO-2',
    'group:끝난 팀',
    '__custom__',
  ], '조용한 것도 그대로 고를 수 있고, 목록 끝의 소제목 아래로 갈 뿐이다');

  // 조용한 것들에 열린 업무가 생기면 — 저장된 값이 없으니 — 자동으로 위 목록에 합류하고 소제목도 사라진다.
  app.run(`workflowData.items.push(
    { id: 'j3', type: 'task', status: 'to-do', jira: 'IO-2', created: dayAgo(0) },
    { id: 'g3', type: 'task', status: 'to-do', group: '끝난 팀', created: dayAgo(0) },
  ); wfIndexData();`);
  assert.equal(app.run("projectPickEntries(null, false).some(e => e.type === 'heading')"), false,
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
    projectKey = null; projectOrderKeys = null; projectOrderResort = true; projectPastOpen = null;
    projectListView = 'status'; projectTodoOpen = null; projectFindQuery = ''; projectDeployClosed.clear();`);
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
  // 그 상태에서 `숨기기`를 누르면 정말 접힌다(예전에는 보고 있는 프로젝트 때문에 다시 펼쳐져 버튼이 안 먹었다).
  todoToggle.listeners.click();
  const again = fixture.toggles().find(t => t.textContent.startsWith('시작 전'));
  assert.equal(again.getAttribute('aria-expanded'), 'false', '누른 대로 접힌다');
  assert.ok(!fixture.rowsOf().some(row => row.name === '리포트 개편'));
  again.listeners.click();
  assert.equal(fixture.toggles().find(t => t.textContent.startsWith('시작 전')).getAttribute('aria-expanded'), 'true', '다시 누르면 펼쳐진다');
});

test('BPVIEW: 지난 프로젝트를 누르면 위로 끌어올리지 않고 `지난 프로젝트` 안에 두고 그 묶음을 펼친다', () => {
  const fixture = bpviewClient();
  fixture.app.run("projectKey = 'jira:IO-6';");
  fixture.render();
  const pastToggle = fixture.toggles().find(t => t.textContent.startsWith('지난 프로젝트'));
  assert.equal(pastToggle.getAttribute('aria-expanded'), 'true', '보고 있는 게 거기 있으면 펼친다');
  const row = fixture.rowsOf().find(r => r.name === '끝난 캠페인');
  assert.ok(row && row.past, '흐린 지난 프로젝트 줄로 그 자리에 있다');
  const todoToggle = fixture.toggles().find(t => t.textContent.startsWith('시작 전'));
  assert.equal(todoToggle.getAttribute('aria-expanded'), 'false', '`시작 전`으로 올라가 펼치지 않는다');
  pastToggle.listeners.click();
  assert.equal(fixture.toggles().find(t => t.textContent.startsWith('지난 프로젝트')).getAttribute('aria-expanded'), 'false', '누르면 접힌다');
});

test('프로젝트 상세: 진행할 업무 맨 아래에 이 프로젝트로 바로 추가하는 칸이 있다(업무가 0개여도)', () => {
  const fixture = bpviewClient();
  fixture.app.run("projectKey = 'jira:IO-6';");
  fixture.render();
  const walk = (node, out) => { if (!node) return out; if (String(node.className || '').includes('d-padd')) out.push(node); (node.children || []).forEach(kid => walk(kid, out)); return out; };
  const rows = walk(fixture.app.nodes.get('projectBody'), []);
  assert.equal(rows.length, 1);
  assert.equal(!!rows[0].hidden, false, '늘 보인다');
  const input = rows[0].children.find(kid => String(kid.className).includes('d-addinput'));
  assert.equal(input.placeholder, '+ 이 프로젝트에 할 일 추가 — Enter');
  assert.equal(rows[0].dataset.addKey, '/api/today-task/create::jira:IO-6::project', '오늘 목록의 같은 그룹 입력줄과 구분된다');
});

test('그룹 + 입력줄: 다른 곳을 누르면(포커스가 빠지면) 닫히고, 적던 글이 있거나 늘 보이는 프로젝트 줄이면 그대로 둔다', () => {
  const app = pureClient();
  app.run("var __row = uiGroupAddRow('group:게임', '/api/today-task/create', 'x'); __row.hidden = false; var __input = __row.children[0];");
  app.run("__input.value = '적는 중'; __input.listeners.blur();");
  assert.equal(app.run('__row.hidden'), false, '적던 글은 잃지 않는다');
  app.run("__input.value = ''; __input.listeners.blur();");
  assert.equal(app.run('__row.hidden'), true, '빈 칸이면 닫힌다');
  app.run("var __keep = uiGroupAddRow('group:게임', '/api/today-task/create', 'x'); __keep.hidden = false; __keep.className += ' d-padd'; __keep.children[0].listeners.blur();");
  assert.equal(app.run('__keep.hidden'), false, '프로젝트 상세의 늘 보이는 줄은 닫지 않는다');
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
    deletedAt: '2026-09-22T01:05:00.000Z', project: '샘플 기능', projectKey: 'jira:IO-12345' },
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
  assert.equal(fixture.app.nodes.get('settingsIntegrationsView').hidden, true);
  assert.equal(fixture.app.nodes.get('settingsAppView').hidden, true);
  const rows = fixture.rows();
  assert.equal(rows.length, 3);
  assert.equal(nodeFind(rows[1], 'kd').textContent, '할 일');
  assert.equal(nodeFind(rows[1], 'tx').textContent, '정산 배치 설계 검토하기');
  assert.equal(nodeFind(rows[1], 'tw').textContent, '9월 21일 22:10에 삭제');
  // 프로젝트는 다른 줄과 같은 표기(`· ● 이름`)다 — 지라는 서버가 요약만 실어 준다.
  assert.equal(nodeFind(rows[0], 'd-inproj').children.filter(kid => typeof kid === 'string').join(''), '· 샘플 기능');
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

test('BRENAME: 그룹 프로젝트는 이름 바꾸기, 지라 프로젝트는 별칭이 없으면 제목이 이유를 말하고 ⋯은 이름 바꾸기 하나다(BJALIAS)', () => {
  const fixture = renameClient();
  const group = fixture.detail('group:살아 있는 것');
  nodeFind(group.children[0], 'd-more').listeners.click({ stopPropagation() {} });
  assert.equal(fixture.app.run('lastMenu')[0].map(entry => entry.label).join(','), '이름 바꾸기');
  assert.equal(group.children[0].title, undefined, '직접 만든 프로젝트의 제목에는 설명이 붙지 않는다');

  const jira = fixture.detail('jira:IO-12345');
  assert.equal(jira.children[0].title, '이름은 지라 요약을 따라요', '별칭이 없을 때만 붙는 툴팁이다');
  fixture.app.run('lastMenu = null;');
  nodeFind(jira.children[0], 'd-more').listeners.click({ stopPropagation() {} });
  assert.equal(fixture.app.run('lastMenu')[0].map(entry => entry.label).join(','), '이름 바꾸기', '보관을 없애며 사라졌던 ⋯이 별칭을 위해 돌아왔다 — 되돌리기 항목은 별칭이 있을 때만');
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

// ---------- BJALIAS: 지라 프로젝트 앱 안 별칭(화면) ----------
// 가짜 fetch만 쓴다 — 지라에는 아무것도 나가지 않는다(POST는 /api/project/alias 하나뿐이다).
function aliasClient() {
  const store = { 'IO-48501': null }; // 서버가 들고 있는 값 흉내 — `previous` 계산에 쓴다.
  const fixture = projectListClient({ posts: (url) => {
    if (!url.includes('/api/project/alias')) return new Response('{"ok":true}');
    const body = fixture.sent[fixture.sent.length - 1].body;
    const previous = store[body.jira] || null;
    store[body.jira] = body.alias || null;
    return new Response(JSON.stringify({ ok: true, jira: body.jira, alias: body.alias || null, previous }));
  } });
  fixture.app.run('loads = 0; load = async () => { loads += 1; };');
  fixture.app.run("lastMenu = null; uiMenu = (anchor, sections) => { lastMenu = sections; return null; };");
  fixture.app.run("jiraIssuesByKey = new Map([['IO-48501', { key: 'IO-48501', summary: '[Q4] 결제 리뉴얼 v2 (iOS/AOS)' }]]); jiraIssuesCache = [...jiraIssuesByKey.values()];");
  const detail = (key, alias) => fixture.app.run(`(() => {
    projectAliasesCache = ${alias ? JSON.stringify({ 'IO-48501': alias }) : '{}'};
    const body = document.createElement('div');
    renderProjectDetail(body, { key: ${JSON.stringify(key)}, label: ${JSON.stringify(key)}, open: 1 });
    return body;
  })()`);
  return { ...fixture, detail, store };
}

test('BJALIAS: 지라 프로젝트 ⋯ 메뉴 — 별칭이 없으면 이름 바꾸기만, 있으면 지라 이름으로 되돌리기가 더 붙는다', () => {
  const fixture = aliasClient();
  const bare = fixture.detail('jira:IO-48501', null);
  nodeFind(bare.children[0], 'd-more').listeners.click({ stopPropagation() {} });
  assert.equal(fixture.app.run('lastMenu')[0].map(entry => entry.label).join(','), '이름 바꾸기');

  fixture.app.run('lastMenu = null;');
  const aliased = fixture.detail('jira:IO-48501', '결제 리뉴얼');
  nodeFind(aliased.children[0], 'd-more').listeners.click({ stopPropagation() {} });
  assert.equal(fixture.app.run('lastMenu')[0].map(entry => entry.label).join(','), '이름 바꾸기,지라 이름으로 되돌리기');
});

test('BJALIAS: 조용한 줄 — 별칭이 없으면 예전과 같고, 있으면 `지라: 원문`이 늘 붙는다', () => {
  const fixture = aliasClient();
  const bare = fixture.detail('jira:IO-48501', null);
  assert.equal(bare.children[1].textContent, '열린 항목 1 · IO-48501');
  const aliased = fixture.detail('jira:IO-48501', '결제 리뉴얼');
  assert.equal(aliased.children[1].textContent, '열린 항목 1 · IO-48501 · 지라: [Q4] 결제 리뉴얼 v2 (iOS/AOS)');
  assert.equal(aliased.children[1].title, aliased.children[1].textContent, '길어질 수 있어 title에도 전체를 남긴다');
});

test('BJALIAS: 제목 자리 인라인 저장 → POST /api/project/alias · 알림 · 되돌리기, 키는 그대로라 projectKey를 다시 잡지 않는다', async () => {
  const fixture = aliasClient();
  const body = fixture.detail('jira:IO-48501', null);
  fixture.app.run("projectKey = 'jira:IO-48501';");
  const title = body.children[0];
  nodeFind(title, 'd-more').listeners.click({ stopPropagation() {} });
  fixture.app.run('lastMenu')[0][0].onClick();

  const box = body.children[0];
  assert.equal(box.className, 'd-pren');
  const input = nodeFind(box, 'd-din');
  assert.equal(input.value, '[Q4] 결제 리뉴얼 v2 (iOS/AOS)', '별칭이 없을 때는 현재 표시 이름 — 지라 요약이 전체 선택된 채로 열린다');

  input.value = '결제 리뉴얼';
  await input.listeners.keydown({ key: 'Enter', isComposing: false, preventDefault() {} });
  assert.deepEqual(fixture.sent, [{ url: '/api/project/alias', body: { jira: 'IO-48501', alias: '결제 리뉴얼' } }]);
  assert.equal(fixture.app.run('projectKey'), 'jira:IO-48501', '지라 키는 바뀌지 않으므로 그대로 열린 채로 남는다');
  assert.equal(fixture.app.run('loads'), 1);

  const region = fixture.app.nodes.get('liveRegion');
  assert.match(region.textContent, /이름을 바꿨어요 · \[Q4\] 결제 리뉴얼 v2 \(iOS\/AOS\) → 결제 리뉴얼/);
  const undo = region.children.find(kid => kid.textContent === '되돌리기');
  await undo.listeners.click(undo);
  assert.deepEqual(fixture.sent.slice(-1), [{ url: '/api/project/alias', body: { jira: 'IO-48501', alias: null } }]);
  assert.match(region.textContent, /이름을 되돌렸어요 · 결제 리뉴얼 → \[Q4\] 결제 리뉴얼 v2 \(iOS\/AOS\)/);
  assert.equal(fixture.app.run('undoStack.length'), 0, '앱의 ⌘Z 대상은 아니다');
});

test('BJALIAS: 그룹 프로젝트의 제목 ⋯ 메뉴는 그대로다(별칭은 지라 프로젝트만의 일)', () => {
  const fixture = renameClient();
  const group = fixture.detail('group:살아 있는 것');
  nodeFind(group.children[0], 'd-more').listeners.click({ stopPropagation() {} });
  assert.equal(fixture.app.run('lastMenu')[0].map(entry => entry.label).join(','), '이름 바꾸기', '그룹 프로젝트에는 별칭 항목이 없다');
});

test('BJALIAS: 프로젝트 찾기(projectFindFilter)는 별칭·지라 원래 요약 둘 다로 찾힌다', () => {
  const app = workflowsClient(); // projectFindFilter가 쓰는 wfSearchMatches는 workflows.js에 있다
  app.run("jiraIssuesByKey = new Map([['IO-48501', { key: 'IO-48501', summary: '[Q4] 결제 리뉴얼 v2 (iOS/AOS)' }]])");
  app.run("projectAliasesCache = { 'IO-48501': '결제 리뉴얼' }");
  const rows = [{ key: 'jira:IO-48501', label: 'jira:IO-48501' }];
  const byAlias = JSON.parse(app.run(`JSON.stringify(projectFindFilter(${JSON.stringify(rows)}, '결제 리뉴얼').map(r => r.key))`));
  assert.deepEqual(byAlias, ['jira:IO-48501'], '별칭으로 찾힌다(우선 표시되는 이름)');
  const byRaw = JSON.parse(app.run(`JSON.stringify(projectFindFilter(${JSON.stringify(rows)}, 'iOS/AOS').map(r => r.key))`));
  assert.deepEqual(byRaw, ['jira:IO-48501'], '별칭에 가려진 지라 원래 요약으로도 찾힌다');
  const none = JSON.parse(app.run(`JSON.stringify(projectFindFilter(${JSON.stringify(rows)}, '알림센터').map(r => r.key))`));
  assert.deepEqual(none, []);
});

// ---------- 새 프로젝트 화면 (BJCREATE) ----------
// 실제 지라에는 닿지 않는다 — 가짜 fetch가 create-meta·create 응답을 대신 준다.
const BJC_META = { ok: true, connected: true, project: 'IO', epic: { id: '10000', name: '에픽' }, types: [{ id: '10001', name: '작업' }], defaultTypeId: '10001' };
const BJC_MADE = {
  ok: true, connected: true,
  epic: { key: 'IO-48400', url: 'https://example-jira.test/browse/IO-48400', summary: '예시 게시글 작성하기_샘플 기능', created: true },
  children: [
    { summary: '[Web] 예시 게시글 작성하기_샘플 기능', key: 'IO-48401', url: 'https://example-jira.test/browse/IO-48401' },
    { summary: '[QA] 예시 게시글 작성하기_샘플 기능', error: '지라에서 이 프로젝트에 이슈를 만들 권한이 없어요.', kind: 'makeForbidden' },
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

  fixture.set("projectNew.name = '예시 게시글 작성하기_샘플 기능'; projectNew.project = 'IO'; projectNew.roles = ['Web', 'QA']; projectNew.types = [{ id: '10001', name: '작업' }]; projectNew.typeId = '10001'");
  const preview = nodeFind(fixture.body(), 'd-pnewpv');
  assert.equal(bjcWords(nodeFind(preview, 'ep')).includes('새로 만듦'), true, '새 에픽이면 `새로 만듦`이라고 적는다');
  const titles = nodeFindAll(preview, 'ti').map(input => input.value);
  assert.deepEqual(titles, ['[Web] 예시 게시글 작성하기_샘플 기능', '[QA] 예시 게시글 작성하기_샘플 기능']);
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
  fixture.set(`projectNew.mode = 'attach'; projectNew.roles = ['Web']; projectNew.epic = { key: 'ABC-1234', summary: '임베드', children: { items: [{ key: 'IO-48401', summary: '[Web] 임베드' }] } }`);
  assert.equal(fixture.app.run("projectNewExisting(projectNew, { label: 'Web', prefix: '[Web]' })"), 'IO-48401');
  fixture.app.run("projectNewPickEpic({ key: 'ABC-1234', summary: '임베드', children: { items: [{ key: 'IO-48401', summary: '[Web] 임베드' }] } })");
  assert.equal(fixture.app.run('projectNew.roles.length'), 0, '겹치는 직군의 체크는 꺼진다');
  assert.match(bjcWords(nodeFind(fixture.body(), 'd-pnewroles')), /이미 있어요 IO-48401/);
  assert.match(bjcWords(nodeFind(fixture.body(), 'd-pnewpv')), /ABC-1234에 붙임/);
});

test('BJCREATE: 확인 줄을 거치지 않으면 만들기 요청이 나가지 않고, 만든 뒤에도 ⌘Z 대상이 아니다', async () => {
  const fixture = projectNewClient({ made: { ...BJC_MADE, children: [BJC_MADE.children[0]], made: 2, failed: 0 } });
  fixture.start();
  fixture.set("projectNew.name = '예시 게시글 작성하기_샘플 기능'; projectNew.project = 'IO'; projectNew.roles = ['Web']");
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
    epic: { summary: '예시 게시글 작성하기_샘플 기능' },
    children: [{ summary: '[Web] 예시 게시글 작성하기_샘플 기능', issueTypeId: '10001' }],
  } } }]);
  assert.match(fixture.app.nodes.get('liveRegion').textContent, /지라에 2개를 만들었어요/);
  assert.equal(fixture.app.run('undoStack.length'), 0, '지라에 만드는 것은 앱의 ⌘Z 대상이 아니다');
  assert.match(bjcWords(nodeFind(fixture.body(), 'd-pnewres')), /지라에 2개를 만들었어요/);
});

test('BJCREATE: 부분 실패는 만든 것과 실패한 줄·이유를 보여 주고, 다시 시도는 실패한 것만 보낸다', async () => {
  const fixture = projectNewClient();
  fixture.start();
  fixture.set("projectNew.name = '예시 게시글 작성하기_샘플 기능'; projectNew.project = 'IO'; projectNew.roles = ['Web', 'QA']");
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
    children: [{ summary: '[QA] 예시 게시글 작성하기_샘플 기능', key: 'IO-48402', url: 'y' }], made: 1, failed: 0 };`);
  fixture.app.context.fetch = async (url, options) => {
    fixture.sent.push({ url: String(url), body: options && options.body ? JSON.parse(options.body) : null });
    return new Response(JSON.stringify(fixture.app.run('lastMade')));
  };
  await again.listeners.click();
  assert.deepEqual(fixture.sent.slice(-1)[0].body, { plan: {
    projectKey: 'IO',
    epic: { key: 'IO-48400' },
    children: [{ summary: '[QA] 예시 게시글 작성하기_샘플 기능', issueTypeId: '10001' }],
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
  fixture.set("projectNew.name = '예시 게시글 작성하기_샘플 기능'; projectNew.project = 'IO'; projectNew.roles = ['Web']");
  const order = [];
  const baseFetch = fixture.app.context.fetch;
  fixture.app.context.fetch = async (url, options) => { order.push(String(url)); return baseFetch(url, options); };
  fixture.app.context.load = async () => { order.push('load'); };
  nodeFind(fixture.body(), 'pri').listeners.click();
  await bjcButton(nodeFind(fixture.body(), 'd-jconfirm'), '만들기').listeners.click();
  assert.deepEqual(order, ['/api/jira/create', '/api/jira/list?fresh=1', 'load'], '에픽을 새로 만들면 만들기 뒤에 조용한 새로고침 → 다시 읽기 순서다');
});

test('BJASSIGN: 이미 있는 에픽에 붙일 때는 지라 목록을 새로 읽지 않는다 — 그 에픽은 재배정하지 않는다', async () => {
  const attachMade = { ok: true, connected: true, epic: { key: 'ABC-1234', url: 'https://example-jira.test/browse/ABC-1234', summary: '임베드', created: false }, children: [{ summary: '[Web] 임베드', key: 'IO-48401', url: 'x' }], made: 1, failed: 0 };
  const fixture = projectNewClient({ made: attachMade });
  fixture.start();
  fixture.set(`projectNew.mode = 'attach'; projectNew.roles = ['Web']; projectNew.epic = { key: 'ABC-1234', summary: '임베드', children: { items: [] } }`);
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
    epic: { key: 'IO-48400', url: 'https://example-jira.test/browse/IO-48400', summary: '예시 게시글 작성하기_샘플 기능', created: true, assignError: '지라에서 이 프로젝트에 이슈를 만들 권한이 없어요.' },
    children: [{ summary: '[Web] 예시 게시글 작성하기_샘플 기능', key: 'IO-48401', url: 'x' }],
    made: 2, failed: 0,
  };
  const fixture = projectNewClient({ made: assignFailedMade });
  fixture.start();
  fixture.set("projectNew.name = '예시 게시글 작성하기_샘플 기능'; projectNew.project = 'IO'; projectNew.roles = ['Web']");
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
  fixture.set("projectNew.name = '예시 게시글 작성하기_샘플 기능'; projectNew.project = 'IO'; projectNew.roles = ['Web']");
  nodeFind(fixture.body(), 'pri').listeners.click();
  await bjcButton(nodeFind(fixture.body(), 'd-jconfirm'), '만들기').listeners.click();
  const result = nodeFind(fixture.body(), 'd-pnewres');
  assert.match(bjcWords(nodeFind(result, 'first')), /첫 할 일을 바로 만들 수도 있어요\(선택\)/);
  assert.doesNotMatch(bjcWords(result), /적으면 앱에도 이 프로젝트가 생겨요/, '더는 사실이 아닌 문구는 없앤다');
});

test('BJASSIGN: 에픽 모드에서 첫 할 일을 비워도 확인 줄까지 그대로 진행된다', () => {
  const fixture = projectNewClient();
  fixture.start();
  fixture.set("projectNew.name = '예시 게시글 작성하기_샘플 기능'; projectNew.project = 'IO'; projectNew.roles = ['Web']");
  assert.equal(fixture.app.run('projectNew.first'), '', '첫 할 일 칸을 건드리지 않았다');
  const go = nodeFind(fixture.body(), 'pri');
  assert.equal(go.disabled, false, '첫 할 일이 비어 있어도 눌린다');
  go.listeners.click();
  assert.ok(nodeFind(fixture.body(), 'd-jconfirm'), '확인 줄까지 그대로 간다');
});

// ---------- BMOVE ① — 새 프로젝트 화면의 감지 줄 · 만든 뒤 옮기기 ----------
// projectListClient의 기본 데이터에 이미 그룹 `살아 있는 것`(항목 1개)이 있다 — 이름을 그대로 쓰면
// 그 그룹과 짝이 맞는다.
function bmoveNewFetch(fixture, { moveAnswer = null, undoAnswer = null, created = { key: 'IO-48400', url: 'https://example-jira.test/browse/IO-48400', summary: '살아 있는 것', created: true } } = {}) {
  fixture.app.context.fetch = async (url, options) => {
    const body = options && options.body ? JSON.parse(options.body) : null;
    fixture.sent.push({ url: String(url), body });
    if (String(url).includes('/api/jira/create-meta')) return new Response(JSON.stringify(BJC_META));
    if (String(url).includes('/api/project/move-undo')) {
      return new Response(JSON.stringify(undoAnswer || { ok: true, project: 'group:살아 있는 것', restored: { items: 1, meetings: 0, report: 0 }, skipped: 0 }));
    }
    if (String(url).includes('/api/project/move')) {
      return new Response(JSON.stringify(moveAnswer || { ok: true, project: `jira:${created.key}`, from: '살아 있는 것', to: created.key, moveId: 'mv_9', changed: { items: 1, meetings: 0, links: 0, report: 0 } }));
    }
    if (String(url).includes('/api/jira/create')) return new Response(JSON.stringify({ ok: true, connected: true, epic: created, children: [], made: 1, failed: 0 }));
    return new Response('{"ok":true}');
  };
}

test('BMOVE ①: 이름이 같은 그룹 프로젝트가 있으면 이름 칸 아래 감지 줄이 서고, 체크는 기본 켜짐이다', () => {
  const fixture = projectNewClient();
  fixture.start();
  fixture.set("projectNew.name = '아무 이름'; projectNew.project = 'IO'");
  assert.equal(nodeFind(fixture.body(), 'd-pnewmovebox').children.length, 0, '이름이 다르면 감지 줄이 없다');

  fixture.set("projectNew.name = '살아 있는 것'");
  const box = nodeFind(fixture.body(), 'd-pnewmovebox');
  assert.equal(box.children.length, 1);
  assert.match(bjcWords(box), /살아 있는 것 프로젝트가 이미 있어요\(항목 1\)/);
  assert.match(bjcWords(box), /만든 뒤 이 에픽으로 옮기기/);
  const check = nodeFindAll(box, 'd-wcb')[0];
  assert.equal(check.checked, true, '체크는 기본 켜짐이다');
  assert.equal(fixture.app.run('projectNew.moveAfter'), true);

  // 체크를 끄면 그 값이 그대로 저장된다(재렌더 없이도 유지).
  check.checked = false;
  check.listeners.change();
  assert.equal(fixture.app.run('projectNew.moveAfter'), false);
});

test('BMOVE ①: 체크를 켠 채 만들면 만든 에픽으로 곧바로 옮기고, 결과 화면에 옮긴 결과 한 줄과 되돌리기가 선다', async () => {
  const fixture = projectNewClient();
  bmoveNewFetch(fixture);
  fixture.start();
  fixture.set("projectNew.name = '살아 있는 것'; projectNew.project = 'IO'; projectNew.roles = []");
  assert.equal(fixture.app.run('projectNew.moveCandidate'), '살아 있는 것');
  nodeFind(fixture.body(), 'pri').listeners.click();
  await bjcButton(nodeFind(fixture.body(), 'd-jconfirm'), '만들기').listeners.click();

  assert.deepEqual(fixture.sent.filter(entry => entry.url === '/api/project/move'),
    [{ url: '/api/project/move', body: { project: 'group:살아 있는 것', to: 'IO-48400' } }]);
  assert.equal(fixture.app.run('openedProject'), 'jira:IO-48400', '옮긴 뒤에는 그 에픽 프로젝트를 연다');

  const result = nodeFind(fixture.body(), 'd-pnewres');
  assert.match(bjcWords(result), /항목 1개를 옮겼어요/);
  const undo = bjcButton(result, '되돌리기') || nodeFindAll(result, 'd-link').find(kid => bjcText(kid) === '되돌리기');
  await undo.listeners.click();
  assert.deepEqual(fixture.sent.slice(-1), [{ url: '/api/project/move-undo', body: { moveId: 'mv_9' } }]);
  assert.match(fixture.app.nodes.get('liveRegion').textContent, /살아 있는 것 프로젝트로 되돌렸어요/);
  assert.equal(nodeFind(fixture.body(), 'd-pnewres') ? bjcWords(nodeFind(fixture.body(), 'd-pnewres')).includes('항목 1개를 옮겼어요') : false, false,
    '되돌린 뒤에는 옮긴 결과 줄이 사라진다');
});

test('BMOVE ①: 체크를 끄면 만들어도 옮기지 않는다', async () => {
  const fixture = projectNewClient();
  bmoveNewFetch(fixture);
  fixture.start();
  fixture.set("projectNew.name = '살아 있는 것'; projectNew.project = 'IO'; projectNew.roles = []; projectNew.moveAfter = false");
  nodeFind(fixture.body(), 'pri').listeners.click();
  await bjcButton(nodeFind(fixture.body(), 'd-jconfirm'), '만들기').listeners.click();
  assert.deepEqual(fixture.sent.filter(entry => entry.url === '/api/project/move'), []);
  assert.equal(fixture.app.run('projectNew.moveResult'), null);
});

test('BMOVE ①: 옮기기가 실패하면 결과 화면에 조용한 회색 줄만 남는다', async () => {
  const fixture = projectNewClient();
  bmoveNewFetch(fixture, { moveAnswer: { ok: false, error: '프로젝트를 찾을 수 없어요.' } });
  fixture.start();
  fixture.set("projectNew.name = '살아 있는 것'; projectNew.project = 'IO'; projectNew.roles = []");
  nodeFind(fixture.body(), 'pri').listeners.click();
  await bjcButton(nodeFind(fixture.body(), 'd-jconfirm'), '만들기').listeners.click();
  const result = nodeFind(fixture.body(), 'd-pnewres');
  assert.match(bjcWords(result), /옮기지는 못했어요 — 프로젝트에서 직접 옮길 수 있어요/);
});

test('BMOVE ①: `있는 에픽에 붙이기`도 같은 감지 줄로, 대상은 고른 에픽이다', async () => {
  const fixture = projectNewClient();
  bmoveNewFetch(fixture, { created: { key: 'ABC-1234', url: 'x', summary: '살아 있는 것', created: false } });
  fixture.start();
  fixture.set(`projectNew.mode = 'attach'; projectNew.roles = ['Web']; projectNew.epic = { key: 'ABC-1234', summary: '살아 있는 것', children: { items: [] } }`);
  assert.equal(fixture.app.run('projectNew.moveCandidate'), '살아 있는 것');
  nodeFind(fixture.body(), 'pri').listeners.click();
  await bjcButton(nodeFind(fixture.body(), 'd-jconfirm'), '만들기').listeners.click();
  assert.deepEqual(fixture.sent.filter(entry => entry.url === '/api/project/move'),
    [{ url: '/api/project/move', body: { project: 'group:살아 있는 것', to: 'ABC-1234' } }]);
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
  id: 'jira:ABC-1234:10001', source: 'jira', key: 'ABC-1234', url: 'https://fake-jira.test/browse/ABC-1234',
  summary: '예시 게시글 작성하기_샘플 기능', status: '배포 대기', statusTone: 'doing',
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
  assert.equal(title.textContent, '예시 게시글 작성하기_샘플 기능', '줄에는 요약만 적는다');
  assert.equal(title.title, 'ABC-1234 · 예시 게시글 작성하기_샘플 기능', '키는 툴팁에만');
  assert.equal(nodeFind(row, 'st'), null, '지라 상태는 반응 필요 줄에서 말하지 않는다(정보가 두 겹이라 뺐다)');
  assert.equal(nodeFind(row, 'wh').textContent, '테스터A 외 1명 · 2시간 전');
  assert.equal(nodeFind(row, 'mn').textContent, '@멘션');
  assert.equal(nodeFind(row, 'mn').className, 'mn k-warn');
  assert.equal(nodeFind(row, 'pv').textContent, '해외 서버에서는 안 뜨나요?');
  assert.equal(nodeFind(row, 'ct').textContent, '· 댓글 2개');
  const open = nodeFind(row, 'd-src');
  assert.deepEqual([open.textContent, open.href, open.target], ['열기', 'https://fake-jira.test/browse/ABC-1234', '_blank']);
  assert.equal(nodeFind(row, 'd-pjdot').dataset.pj, fixture.app.run("String(uiProjectHue('jira:ABC-1234'))"));

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
  assert.deepEqual(fixture.sent[fixture.sent.length - 1], { url: '/api/attention/dismiss', body: { id: 'jira:ABC-1234:10001' } });
  assert.deepEqual(fixture.rows().map(row => nodeFind(row, 'ti').textContent), ['정산 배치'], '그 줄만 사라진다');
  assert.match(fixture.notice(), /반응 필요에서 치웠어요 · 예시 게시글 작성하기_샘플 기능/);
  assert.equal(fixture.app.run('undoStack.length'), 0, '바깥 상태와 얽힌 표시라 ⌘Z 대상이 아니다');

  // 알림의 `되돌리기`는 반대 방향으로 한 번 더 보내고 목록을 다시 읽는다.
  const undo = fixture.app.nodes.get('liveRegion').children.find(node => node.textContent === '되돌리기');
  await undo.listeners.click();
  assert.equal(fixture.sent[fixture.sent.length - 2].url, '/api/attention/undismiss');
  assert.deepEqual(fixture.sent[fixture.sent.length - 2].body, { id: 'jira:ABC-1234:10001' });
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
  assert.equal(input.value, '댓글 답하기 — 예시 게시글 작성하기_샘플 기능', '미리 채운다');
  assert.equal(input.selected, true, '전체 선택된 채로 연다');
  assert.deepEqual(form.children.filter(node => node.className === 'd-btn sm').map(node => node.textContent), ['오늘', '나중에']);

  // 한글을 조합하는 중의 Enter는 글자를 확정하는 것이라 넘긴다.
  const before = fixture.sent.length;
  await input.listeners.keydown({ key: 'Enter', isComposing: true, preventDefault() {} });
  assert.equal(fixture.sent.length, before);

  await input.listeners.keydown({ key: 'Enter', isComposing: false, preventDefault() {} });
  const made = fixture.sent[before];
  assert.equal(made.url, '/api/today-task/create', 'Enter는 오늘 할 일이다');
  assert.deepEqual(made.body, { description: '댓글 답하기 — 예시 게시글 작성하기_샘플 기능', jira: 'ABC-1234' });
  assert.equal(fixture.sent[before + 1].url, '/api/attention/dismiss', '업무를 만든 것이 곧 반응한 것이다');
  assert.equal(fixture.app.run('undoStack.length'), 1, '만든 업무는 ⌘Z로 지운다(기존 등록 규칙)');
  assert.equal(fixture.app.run('undoStack[0].label'), '댓글 답하기 — 예시 게시글 작성하기_샘플 기능 (반응 필요)',
    '⌘Z 이름표는 만든 곳(반응 필요)을 말한다 — 후속 할 일이 아니다');
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

// BATTENTION의 `설정 > 상태 › 반응 필요 · 지라 댓글` 줄(attentionStatusRow)은 상태 탭과 함께 없앴다 — 같은 값
// (마지막 확인 시각·읽지 못함·연결 없음)은 연동 탭 지라 카드 둘째 줄이 말한다(아래 WP-E 지라 카드 테스트).
test('BATTENTION: 읽지 못해도 오늘 탭에 구역은 서지 않는다 — 작동 여부는 설정 › 연동의 지라 카드에서 본다', async () => {
  const broken = attentionClient({ items: [], updatedAt: null, stale: false, error: '지라 댓글을 읽지 못했어요.' });
  await broken.app.run('attentionLoad()');
  assert.equal(broken.zone().hidden, true, '실패해도 구역은 서지 않는다');
  assert.equal(broken.app.run("typeof attentionStatusRow"), 'undefined', '상태 탭 줄은 없앴다');
});

// ─────────────────────────────────────────────────────────────────────────────
// 설정 > 정보 줄 · 문제 보고 · 연동 탭 · 시작 카드 · 도움말 (WP-B)

// 설정 화면은 서버에서 읽어 오는 값이 있으므로 응답을 끼워 넣을 수 있는 가짜 창을 따로 만든다.
function settingsClient(payload = {}) {
  const app = client(() => new Response(JSON.stringify(payload)));
  CLIENT_PARTS.forEach(file => app.run(fs.readFileSync(path.join(__dirname, file), 'utf8')));
  app.run("escapeHtml = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')");
  app.context.document.createTextNode = text => ({ textContent: String(text) });
  return app;
}

// 가짜 DOM에는 textContent 자동 합산이 없다 — 자식 글자를 이어 붙여 본다(slackLedgerNotes 테스트와 같은 생각).
const NODE_SHAPE = `(() => {
  const text = node => (node.children && node.children.length
    ? node.children.map(kid => text(kid)).join('')
    : String(node.textContent || ''));
  window.shapeOf = node => ({
    cls: String(node.className || ''), type: String(node.type || ''),
    kind: String(node.dataset && node.dataset.integration || ''),
    hidden: !!node.hidden, disabled: !!node.disabled, text: text(node),
    kids: (node.children || []).map(kid => window.shapeOf(kid)),
  });
})()`;

test('설정 정보 줄: 새 버전 판정은 v 접두를 무시하고 세 자리만 견준다', () => {
  const app = pureClient();
  const newer = (now, next) => app.run(`settingsVersionNewer(${JSON.stringify(now)}, ${JSON.stringify(next)})`);
  assert.equal(newer('1.2.0', 'v1.3.0'), true);
  assert.equal(newer('1.2.0', 'v1.2.1'), true);
  assert.equal(newer('1.2.0', '2.0.0'), true);
  assert.equal(newer('1.2.0', 'v1.2.0'), false, '같은 버전은 새 버전이 아니다');
  assert.equal(newer('1.10.0', 'v1.9.9'), false, '숫자로 견준다(글자 순서가 아니다)');
  assert.equal(newer('', 'v1.3.0'), false, '모르면 알리지 않는다');
  assert.equal(newer('1.2.0', ''), false);
});

test('문제 보고 글에는 업무 문장이 한 줄도 없고 버전·연동·오류 줄만 들어간다', () => {
  const app = pureClient();
  const text = app.run(`settingsReportText(${JSON.stringify({
    about: { version: '1.2.0', channel: 'main', gitRef: '3f2a1c', install: 'managed', modified: [] },
    integrations: {
      jira: { enabled: true }, slack: { enabled: false }, calendar: { enabled: false },
      meetingNotes: { mode: 'manual' },
    },
    automations: [{ name: '슬랙 캡처', lastRunAt: null, lastKind: null }],
    diagnostics: { os: 'Darwin 25.5.0', node: 'v22.1.0', lines: ['Error: 무언가 실패했어요'] },
  })})`);
  const lines = text.split('\n');
  assert.equal(lines[0], '워크스페이스 v1.2.0 (main, 3f2a1c) · 설치본 · Darwin 25.5.0 · Node 22.1.0');
  assert.equal(lines[1], '수정된 파일: 없음');
  assert.equal(lines[2], '연동: 지라 켜짐 · 슬랙 꺼짐 · 캘린더 꺼짐 · 회의록 직접');
  assert.equal(lines[3], '자동화 상태: 슬랙 캡처 —');
  assert.equal(lines[4], '최근 오류(1줄):');
  assert.equal(lines[5], 'Error: 무언가 실패했어요');

  // 로그가 없으면 `로그 없음` 한 줄, 개발용 설치는 그대로 그렇게 적는다
  const plain = app.run(`settingsReportText(${JSON.stringify({
    about: { version: '1.2.0', channel: 'stable', install: 'manual', modified: ['ui.css'] },
    integrations: null, automations: [], diagnostics: {},
  })})`);
  assert.match(plain, /^워크스페이스 v1\.2\.0 · 개발용 · 운영체제 모름 · Node 모름$/m);
  assert.match(plain, /수정된 파일: ui\.css/);
  assert.match(plain, /자동화 상태: 켠 자동화 없음/);
  assert.match(plain, /로그 없음/);
  assert.ok(!/stable/.test(plain), '기본 갈래(stable)는 적지 않는다');
});

// ─────────────────────────────────────────────────────────────────────────────
// WP-D1 — 설정 > 연동 탭 재설계(사용자 확정 시안 A~H): 카드 넷 · 칩 · 상태 줄 · 카드 안 위저드 · 해제 확인 줄

// 연동 상태·토큰 확인·채널 만들기·저장이 서로 다른 응답을 줘야 해서, 부른 순서대로 답을 꽂아 두는 가짜 창이다.
// 지금 상태 읽기(`/api/integrations`)는 늘 같은 값이고, 꽂아 둔 답은 그 밖의 부름에 차례로 쓴다.
function intgClient(state = {}, replies = []) {
  const empty = { id: '', name: '' };
  const payload = {
    ok: true,
    jira: { enabled: false, siteUrl: '', email: '', displayName: '', hasToken: false, readAt: null, issueCount: null, attentionCount: null, ...(state.jira || {}) },
    slack: {
      enabled: false, workspaceUrl: '', appUrl: '', hasToken: false, readAt: null,
      channels: { todo: empty, align: empty, someday: empty, waiting: empty },
      ...(state.slack || {}),
    },
    calendar: { enabled: false, ...(state.calendar || {}) },
    meetingNotes: state.meetingNotes || { mode: 'manual', name: '' },
    claude: state.claude !== undefined ? state.claude : true,
    install: 'manual',
  };
  const app = settingsClient(payload);
  const sent = [];
  const copied = [];
  app.context.navigator = { clipboard: { writeText: async (text) => { copied.push(text); } }, platform: 'MacIntel' };
  // 맥 캘린더 결과 읽기(GET)는 줄 선 답을 쓰지 않는다 — 테스트가 `mac.view`를 바꿔 끼운다(WP-V).
  const mac = { view: state.macView || { ok: true, installed: true, requestedAt: null, chosen: [], state: null } };
  app.context.fetch = async (url, options = {}) => {
    sent.push({ url: String(url), body: options.body ? JSON.parse(options.body) : null });
    const next = String(url) === '/api/integrations' ? { body: payload }
      : String(url) === '/api/integrations/calendar/mac' ? { body: typeof mac.view === 'function' ? mac.view() : mac.view }
        : (replies.shift() || { body: { ok: true } });
    return new Response(JSON.stringify(next.body), { status: next.status || 200, headers: { 'Content-Type': 'application/json' } });
  };
  app.run(NODE_SHAPE);
  app.run(`window.findByClass = (node, cls) => {
    const hits = [];
    const walk = (one) => { if (one && String(one.className || '').split(' ').includes(cls)) hits.push(one); ((one && one.children) || []).forEach(walk); };
    walk(node);
    return hits;
  };
  window.lastMenu = null;
  uiMenu = (anchor, sections) => { window.lastMenu = sections; return null; };`);
  const view = () => app.nodes.get('settingsIntegrationsView');
  const card = kind => view().children.find(one => one.dataset && one.dataset.integration === kind);
  const find = (kind, cls) => app.run(`window.findByClass(document.getElementById('settingsIntegrationsView').children.find(one => one.dataset && one.dataset.integration === ${JSON.stringify(kind)}), ${JSON.stringify(cls)})`);
  const shape = node => JSON.parse(app.run(`JSON.stringify(window.shapeOf(${node}))`));
  const text = kind => shape(`document.getElementById('settingsIntegrationsView').children.find(one => one.dataset && one.dataset.integration === ${JSON.stringify(kind)})`).text;
  const button = (kind, label) => find(kind, 'd-btn').concat(find(kind, 'd-ablink')).find(one => one.textContent === label);
  // 오른쪽 묶음(상태 점 + 말 · 버튼 · ⋯) — 카드의 둘째 자식이다.
  const top = kind => card(kind).children[1];
  const toggle = kind => top(kind).children.find(one => String(one.className).includes('d-btn') && !String(one.className).includes('d-more'));
  const menu = (kind) => {
    const more = top(kind).children.find(one => String(one.className).includes('d-more'));
    more.listeners.click({ stopPropagation() {} });
    return app.run('window.lastMenu');
  };
  const live = () => app.nodes.get('liveRegion').textContent;
  return { app, payload, sent, copied, view, card, find, shape, text, button, top, toggle, menu, live, mac };
}
// 가짜 창(vm)의 배열은 다른 realm이라 deepEqual이 참조까지 본다 — 값만 견준다.
const same = (actual, expected, message) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message);
// 반 분을 덜 뺀다 — 화면은 분을 반올림(settingsAgo)하므로, 여기서 만든 시각부터 그릴 때까지
// 0~60초가 걸려도(부하 큰 전체 실행) `N분 전`이 그대로 N이다.
const ago = minutes => new Date(Date.now() - (minutes * 60000 - 30000)).toISOString();

test('WP-D1 A. 목록: 카드 차례는 슬랙 수집 → 지라 → 캘린더 → 회의록, 맨 위 한 줄과 개수, 칩은 회색 글자 칩 하나', async () => {
  const fx = intgClient();
  await fx.app.run('renderSettingsIntegrations()');
  const kids = fx.view().children;
  assert.equal(kids[0].className, 'd-intghead');
  assert.equal(fx.shape("document.getElementById('settingsIntegrationsView').children[0]").text, '연동은 선택이에요. 필요할 때 하나씩 켜요.연결됨 0 · 남은 것 3', '회의록 직접 옮기기는 연결에도 남은 것에도 세지 않는다 — 켠 연동이 없으면 선택이라는 말과 `연결됨 0`');
  same(kids.slice(1, 5).map(one => one.dataset.integration), ['slack', 'jira', 'calendar', 'notes']);

  const chips = ['slack', 'calendar', 'notes'].map(kind => fx.find(kind, 'd-itag')[0]);
  // 칩은 Claude 없이도 쓸 수 있다는 말 하나 — 슬랙(원문 그대로)·캘린더(맥 캘린더·비밀 주소)·회의록(직접 옮기기). 지라는 칩 없음.
  same(chips.map(chip => chip.textContent), ['Claude 없이도 돼요', 'Claude 없이도 돼요', 'Claude 없이도 돼요']);
  assert.ok(chips.every(chip => chip.className === 'd-itag'), '칩 색은 하나로 통일한다(주황 칩 없음)');
  assert.equal(fx.find('jira', 'd-itag').length, 0, '지라 카드는 칩이 없다');
  assert.ok(!/누구나/.test(fx.view().textContent), '카드에 `누구나` 칩은 없다');

  assert.match(fx.text('slack'), /^슬랙 수집Claude 없이도 돼요연결하기나만 보는 채널에 공유한 메시지가 할 일로 들어와요5분 · 팀 슬랙 앱 토큰 하나/);
  assert.match(fx.text('jira'), /^지라연결하기내 티켓이 프로젝트로 뜨고 상태·기한을 여기서 바꿔요3분 · Atlassian API 토큰 하나/);
  assert.match(fx.text('calendar'), /^캘린더Claude 없이도 돼요연결하기오늘 회의가 뜨고 회의 정리가 열려요3분 · 맥 캘린더·Claude Code·비밀 주소/);
  assert.match(fx.text('notes'), /^회의록Claude 없이도 돼요직접 옮기기바꾸기티로 회의록이 초안으로 들어와요 — 직접 옮기기도 돼요회의 정리 화면에 붙여 넣어요/);
  same(['slack', 'jira', 'calendar', 'notes'].map(kind => statOf(fx, kind)), [['d-istat k-off', ''], ['d-istat k-off', ''], ['d-istat k-off', ''], ['d-istat k-ok', '직접 옮기기']], '연결 안 됨은 빈 원(말 없음), 직접 옮기기는 초록');
  same(['slack', 'jira', 'calendar'].map(kind => fx.toggle(kind).className), ['d-btn acc', 'd-btn acc', 'd-btn acc']);
  // 접힌 카드에는 입력칸이 아예 없다 — 누른 카드만 그 자리에서 펼친다
  assert.ok(['slack', 'jira', 'calendar', 'notes'].every(kind => fx.find(kind, 'd-intgbody')[0].hidden && !fx.find(kind, 'd-din').length));

  // 맨 아래 조용한 줄: 요청하기 · 각자 붙이는 법(새 탭) — 켠 자동화는 저장하면 앱이 등록하므로 업데이트.command 안내는 없다
  const foot = kids[kids.length - 1];
  assert.equal(foot.className, 'd-intgfoot');
  const footText = fx.shape("document.getElementById('settingsIntegrationsView').children.at(-1)").text;
  assert.match(footText, /^다른 도구를 쓰고 있어요 → 요청하기 · 각자 붙이는 법 ↗/);
  assert.doesNotMatch(footText, /업데이트\.command|켠 자동화를 등록하려면/);
  assert.equal(fx.find('slack', 'd-intgsetup').length + fx.app.run("window.findByClass(document.getElementById('settingsIntegrationsView'), 'd-intgsetup').length"), 0);
  const own = fx.app.run("window.findByClass(document.getElementById('settingsIntegrationsView').children.at(-1), 'd-ablink')[1]");
  assert.equal(own.target, '_blank');
  assert.equal(own.rel, 'noopener noreferrer');
  assert.match(own.href, /docs\/%EC%97%B0%EB%8F%99\.md#/, 'docs/연동.md의 "다른 앱을 쓰면" 절');
});

test('WP-D1 A·H. 연결된 카드는 무엇이 되고 있는지 한 줄 + ⋯(보내는 법·채널 고르기·다시 연결·해제…), 큰 해제 버튼은 없다', async () => {
  const fx = intgClient({
    jira: { enabled: true, siteUrl: 'https://회사.atlassian.net', email: '나@회사.com', displayName: '하늘', hasToken: true, readAt: ago(3), issueCount: 12, attentionCount: 2 },
    slack: {
      enabled: true, hasToken: true, readAt: ago(5),
      channels: { todo: { id: 'C1', name: '#my-todo' }, waiting: { id: 'C2', name: '#my-waiting' }, align: { id: '', name: '' }, someday: { id: '', name: '' } },
    },
  });
  await fx.app.run('renderSettingsIntegrations()');
  assert.equal(fx.shape("document.getElementById('settingsIntegrationsView').children[0]").text, '2개 연결됨연결됨 2 · 남은 것 1', '회의록 직접 옮기기는 연결에도 남은 것에도 세지 않는다');
  same(['slack', 'jira'].map(kind => statOf(fx, kind)), [['d-istat k-ok', '연결됨'], ['d-istat k-ok', '연결됨']]);

  const jiraState = fx.find('jira', 'd-istat')[0];
  assert.equal(fx.shape(`window.findByClass(document.getElementById('settingsIntegrationsView').children[2], 'now')[0]`).text, '하늘님 · 회사.atlassian.net · 3분 전 읽음');
  assert.ok(jiraState);
  assert.match(fx.text('jira'), /내 티켓 12개 · 반응 필요 댓글 2개/);
  assert.equal(fx.shape(`window.findByClass(document.getElementById('settingsIntegrationsView').children[1], 'now')[0]`).text, '#my-todo 외 1개 · 5분 전 읽음');
  assert.match(fx.text('slack'), /매일 9–19시, 5분마다/, '둘째 줄은 도는 주기(오늘 수치가 없으면 앞부분만)');
  assert.equal(fx.toggle('slack').hidden, true, '연결된 카드는 평소 ⋯만 둔다');
  assert.ok(!/해제/.test(fx.text('jira')), '큰 해제 버튼은 두지 않는다');

  const slackMenu = fx.menu('slack');
  same(slackMenu.map(section => section.map(entry => entry.label)), [['새로 받기', '보내는 법', '채널 고르기', '슬랙 정리 방식', '다시 연결(토큰 바꾸기)'], ['해제…']], '기록이 없으면 최근 기록 칸은 숨긴다');
  assert.equal(slackMenu[1][0].danger, true);
  const jiraMenu = fx.menu('jira');
  same(jiraMenu.map(section => section.map(entry => entry.label)), [['새로 받기', '다시 연결(토큰 바꾸기)'], ['해제…']]);

  // 보내는 법 — ③ 확인과 같은 네 줄 상자를 카드 안에 편다
  slackMenu[0][1].onClick();
  const send = fx.find('slack', 'd-isend')[0];
  assert.ok(send, '보내는 법 상자가 펼쳐진다');
  assert.equal(send.children[0].textContent, '슬랙에서 이렇게 보내요');
  assert.equal(send.children[1].children.length, 4);
  assert.equal(fx.toggle('slack').hidden, false, '펼치면 `접기`가 선다');
  assert.equal(fx.toggle('slack').textContent, '접기');

  // H. 해제… → 카드 안 확인 줄 → 취소하면 사라지고, 해제하면 그 연동만 끈다
  jiraMenu[1][0].onClick();
  assert.equal(fx.find('slack', 'd-isend').length, 0, '다른 카드의 펼침은 접힌다');
  const confirm = () => fx.find('jira', 'd-iconfirm')[0];
  assert.equal(confirm().children[0].textContent, '해제하면 자동 수집이 멈춰요. 토큰 파일은 남아요.');
  same(confirm().children.slice(1, 3).map(one => [one.textContent, one.className]), [['취소', 'd-btn sm'], ['해제', 'd-btn sm dng']]);
  confirm().children[1].listeners.click();
  assert.equal(confirm(), undefined, '취소하면 확인 줄이 사라진다');
  fx.menu('jira')[1][0].onClick();
  await confirm().children[2].listeners.click();
  const off = fx.sent.find(one => one.url === '/api/integrations/save');
  same(off.body, { jira: { enabled: false } });
  assert.match(fx.live(), /연결을 해제했어요 — 토큰 파일은 그대로 있어요/);
});

test('WP-D1 B. 슬랙 ① 토큰: 세 줄 안내 + 토큰 받는 곳 + 요청 문구 복사, xoxb는 서버에 보내지 않고 그 자리에서 알린다', async () => {
  const fx = intgClient({ slack: { appUrl: 'https://api.slack.com/apps/A0XXXX' } }, [
    { status: 400, body: { ok: false, error: '토큰이 맞지 않아요', code: 'invalid_auth' } },
    { body: { ok: true } },
  ]);
  await fx.app.run('renderSettingsIntegrations()');
  fx.toggle('slack').listeners.click();
  assert.equal(fx.toggle('slack').textContent, '접기');

  const steps = fx.find('slack', 'd-isteps')[0];
  same(steps.children.filter(one => one.className !== 'ln').map(one => [one.textContent, one.className]),
    [['① 토큰', 'on'], ['② 채널', ''], ['③ 확인', '']]);
  const how = fx.shape("window.findByClass(document.getElementById('settingsIntegrationsView').children[1], 'd-ihow')[0]").text;
  assert.equal(how, '팀 슬랙 앱의 OAuth & Permissions 화면이 열려요(영어 화면이에요 — 다른 화면이면 왼쪽 메뉴에서 골라요).Install to (회사 슬랙 이름) 버튼(이미 했으면 Reinstall to …) → 허용(Allow)토큰이 두 개 보여요 — xoxp-로 시작하는 User OAuth Token 옆 Copy. xoxb-로 시작하는 Bot 토큰이 아니에요.');
  const open = fx.button('slack', '토큰 받는 곳 열기 ↗');
  assert.equal(open.href, 'https://api.slack.com/apps/A0XXXX/oauth', '토큰이 있는 OAuth & Permissions 화면으로 바로');
  assert.equal(fx.app.run("settingsSlackAppUrl('https://api.slack.com/apps/A0XXXX/oauth')"), 'https://api.slack.com/apps/A0XXXX/oauth', '이미 하위 화면이면 그대로');
  assert.equal(open.target, '_blank');
  assert.equal(open.rel, 'noopener noreferrer');

  await fx.button('slack', '만든 사람에게 요청 문구 복사').listeners.click();
  same(fx.copied, ['워크스페이스 슬랙 앱에 저를 Collaborator로 추가해 주세요']);

  const token = fx.find('slack', 'd-din')[0];
  assert.equal(token.type, 'password', '토큰 칸은 늘 password다');
  const error = () => fx.find('slack', 'd-derr')[0].textContent;
  const before = fx.sent.length;
  token.value = 'xoxb-123-bot';
  token.listeners.input();
  assert.equal(error(), '이건 Bot 토큰이에요 — 바로 위의 User OAuth Token(xoxp-)을 복사해 주세요', '붙이는 순간 알린다');
  await fx.button('slack', '다음 →').listeners.click();
  assert.equal(fx.sent.length, before, 'Bot 토큰은 서버에 보내지 않는다');

  // 틀린 토큰 → 그 자리에 이유, 맞는 토큰 → ② 채널로
  token.value = 'xoxp-wrong';
  token.listeners.input();
  assert.equal(error(), '', '고치면 경고가 사라진다');
  await fx.button('slack', '다음 →').listeners.click();
  same(fx.sent.at(-1), { url: '/api/integrations/slack-token-check', body: { token: 'xoxp-wrong' } });
  assert.equal(error(), '토큰이 맞지 않아요');
  assert.equal(fx.find('slack', 'd-ich').length, 0, '틀리면 다음 단계로 가지 않는다');

  // 한글 조합 중의 Enter는 무시하고, 조합이 끝난 Enter는 `다음`과 같다
  token.value = 'xoxp-good';
  await token.listeners.keydown({ key: 'Enter', isComposing: true, preventDefault() {} });
  assert.equal(fx.sent.at(-1).body.token, 'xoxp-wrong', '조합 중 Enter는 보내지 않는다');
  await token.listeners.keydown({ key: 'Enter', isComposing: false, preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fx.sent.at(-1).body.token, 'xoxp-good');
  const after = fx.find('slack', 'd-isteps')[0].children.filter(one => one.className !== 'ln');
  same(after.map(one => [one.textContent, one.className]), [['① 토큰 ✓', 'dn'], ['② 채널', 'on'], ['③ 확인', '']], '끝낸 단계는 한 줄로 접힌다');
  assert.ok(!JSON.stringify(fx.shape("document.getElementById('settingsIntegrationsView')")).includes('xoxp-good'), '넘어간 뒤에는 토큰이 화면 어디에도 없다');
});

// ① 토큰을 통과해 ② 채널에 선 가짜 창을 만든다.
async function intgSlackAtChannels(state, replies) {
  const fx = intgClient(state, [{ body: { ok: true } }, ...replies]);
  await fx.app.run('renderSettingsIntegrations()');
  fx.toggle('slack').listeners.click();
  fx.find('slack', 'd-din')[0].value = 'xoxp-good';
  await fx.button('slack', '다음 →').listeners.click();
  return fx;
}
const intgRow = (fx, key) => fx.find('slack', 'd-ich').find(one => one.dataset.channel === key);

test('WP-D1 C. 슬랙 ② 채널: 쓸 곳 네 줄(할 일은 기본 체크·해제 가능), 고른 줄만 이름 칸이 켜지고 버튼이 고른 수를 말한다', async () => {
  const fx = await intgSlackAtChannels({}, []);
  const rows = fx.find('slack', 'd-ich');
  same(rows.map(one => one.dataset.channel), ['todo', 'waiting', 'align', 'someday']);
  same(rows.map(one => fx.shape(`window.findByClass(document.getElementById('settingsIntegrationsView').children[1], 'd-ich').find(one => one.dataset.channel === ${JSON.stringify(one.dataset.channel)}).children[1]`).text), [
    '할 일오늘 탭 새로 들어온 것으로 와요',
    '기다리는 것누가 답해 줘야 하는 것 → 오늘 탭 확인 대기',
    '정해진 것정책·결정 → 아이디어·결정 탭의 결정',
    '언젠가나중에 참고할 거리 → 아이디어·결정 탭의 아이디어',
  ]);
  const box = key => intgRow(fx, key).children[0];
  const name = key => intgRow(fx, key).children[2];
  same(['todo', 'waiting', 'align', 'someday'].map(key => [box(key).checked, box(key).disabled, name(key).value, name(key).disabled]), [
    [true, false, 'my-todo', false],
    [true, false, 'my-waiting', false],
    [false, false, 'my-align', true],
    [false, false, 'my-someday', true],
  ], '할 일은 기본 체크(풀 수 있다), 기본 이름은 my-*, 고르지 않은 줄의 이름 칸은 꺼져 있다');
  assert.ok(!fx.find('slack', 'need').length, '`필수` 표시는 없다');
  const make = () => fx.find('slack', 'pri')[0];
  assert.equal(make().textContent, '고른 채널 2개 만들어 주기');
  box('align').checked = true;
  box('align').listeners.change();
  assert.equal(make().textContent, '고른 채널 3개 만들어 주기');
  assert.equal(name('align').disabled, false);
  box('waiting').checked = false;
  box('waiting').listeners.change();
  assert.equal(make().textContent, '고른 채널 2개 만들어 주기');
  // 할 일도 풀 수 있다 — 하나도 안 고르면 버튼이 흐려지고 이유 한 줄
  const none = () => fx.find('slack', 'd-ichnone')[0].textContent;
  assert.equal(none(), '');
  box('todo').checked = false;
  box('todo').listeners.change();
  assert.equal(make().textContent, '고른 채널 1개 만들어 주기');
  assert.equal(name('todo').disabled, true);
  box('align').checked = false;
  box('align').listeners.change();
  same([make().textContent, make().disabled, none()], ['고른 채널 0개 만들어 주기', true, '받을 곳을 하나 이상 골라 주세요']);
  box('todo').checked = true;
  box('todo').listeners.change();
  box('align').checked = true;
  box('align').listeners.change();
  same([make().textContent, make().disabled, none()], ['고른 채널 2개 만들어 주기', false, '']);

  // 이름은 치는 동안에는 그대로 두고(띄어쓰기·한글 조합을 막지 않는다) 칸을 떠날 때 슬랙 규칙대로 정리한다
  name('todo').value = 'My TODO ';
  name('todo').listeners.input();
  assert.equal(name('todo').value, 'My TODO ', '치는 동안에는 끝의 띄어쓰기도 자르지 않는다');
  name('todo').value = 'My TODO!';
  name('todo').listeners.input();
  name('todo').listeners.blur();
  assert.equal(name('todo').value, 'my-todo');
  const clean = value => fx.app.run(`settingsSlackChannelName(${JSON.stringify(value)})`);
  assert.equal(clean(' 내 할일 todo! '), '--todo', '쓸 수 없는 글자만 떨어뜨린다');
  assert.equal(clean('할일'), '');
  assert.equal(clean('a'.repeat(120)).length, 80);
  assert.equal(fx.app.run("settingsSlackAppUrl('javascript:alert(1)')"), 'https://api.slack.com/apps');

  // 안내 두 줄
  const text = fx.text('slack');
  assert.match(text, /이름은 바꿔도 돼요 — 나중에 슬랙에서 바꿔도 그대로 이어져요\./);
  assert.match(text, /나중에 더하거나 빼고 싶으면 설정 › 연동 › 슬랙 ⋯ › 채널 고르기\./);
  assert.ok(!/링크/.test(text), '링크 붙여 넣기 갈래는 없다');

  // 빈 이름은 만들지 않고 그 줄에 알린다
  name('align').value = '';
  name('align').listeners.input();
  const sentBefore = fx.sent.length;
  await make().listeners.click();
  assert.equal(fx.sent.length, sentBefore, '이름이 비면 하나도 만들지 않는다');
  assert.equal(intgRow(fx, 'align').children.at(-1).textContent, '채널 이름을 적어 주세요');
});

test('WP-D1 C·D. 여러 채널은 차례로 만들고, 하나가 실패해도 만든 것은 그대로 — 다시 누르면 남은 것만, 다 되면 ③ 확인', async () => {
  const fx = await intgSlackAtChannels({}, [
    { body: { ok: true, id: 'C0TODO11', name: 'my-todo' } },
    { status: 400, body: { ok: false, code: 'name_taken', error: '다른 사람이 쓰는 이름이에요 — 다른 이름을 적어 주세요' } },
    { body: { ok: true, id: 'C0WAIT22', name: 'my-wait2' } },
    { body: { ok: true, restart: false, slack: { channels: {} } } },
  ]);
  await fx.find('slack', 'pri')[0].listeners.click();
  const creates = () => fx.sent.filter(one => one.url === '/api/integrations/slack-channel').map(one => one.body);
  same(creates(), [{ token: 'xoxp-good', name: 'my-todo', key: 'todo' }, { token: 'xoxp-good', name: 'my-waiting', key: 'waiting' }]);
  assert.equal(intgRow(fx, 'todo').children[2].textContent, '✓ #my-todo 만들었어요');
  assert.equal(intgRow(fx, 'waiting').children.at(-1).textContent, '다른 사람이 쓰는 이름이에요 — 다른 이름을 적어 주세요', '그 줄 이름 칸 아래에 알린다');
  assert.equal(fx.find('slack', 'pri')[0].textContent, '고른 채널 1개 만들어 주기');
  assert.equal(intgRow(fx, 'waiting').children[2].focused, true, '커서는 고칠 줄로 간다');

  intgRow(fx, 'waiting').children[2].value = 'my-wait2';
  intgRow(fx, 'waiting').children[2].listeners.input();
  await fx.find('slack', 'pri')[0].listeners.click();
  same(creates().at(-1), { token: 'xoxp-good', name: 'my-wait2', key: 'waiting' });
  assert.equal(creates().length, 3, '이미 만든 할 일은 다시 만들지 않는다');

  // ③ 확인
  const steps = fx.find('slack', 'd-isteps')[0].children.filter(one => one.className !== 'ln').map(one => one.textContent);
  same(steps, ['① 토큰 ✓', '② 채널 ✓', '③ 확인']);
  same(fx.find('slack', 'd-iok').map(one => one.textContent), ['✓ #my-todo · 할 일 · 잘 읽혀요', '✓ #my-wait2 · 기다리는 것 · 잘 읽혀요']);
  const send = fx.find('slack', 'd-isend')[0];
  assert.equal(send.children[0].textContent, '슬랙에서 이렇게 보내요');
  const lines = fx.shape("window.findByClass(document.getElementById('settingsIntegrationsView').children[1], 'd-isend')[0].children[1]").kids.map(one => one.text);
  same(lines, [
    '남의 메시지는 메시지에 마우스를 올려 ⋯ → 전달(또는 공유) → 받는 곳에 #my-todo처럼 쓸 채널을 골라 보내요.',
    '전달할 때 메모 한 줄을 같이 적으면(예: "금요일까지 답하기") 할 일 문구에 참고해요.',
    '내 생각은 그 채널에 그냥 적어도 돼요 — 한 메시지가 한 항목이에요.',
    '어디로 보낼지: 해야 할 일 → 할 일 · 누가 답해 줘야 하는 것 → 기다리는 것 · 정해진 정책 → 정해진 것 · 참고거리 → 언젠가',
  ]);
  await fx.button('slack', '연결').listeners.click();
  const saved = fx.sent.find(one => one.url === '/api/integrations/save');
  same(saved.body, { slack: { enabled: true, token: 'xoxp-good', channels: { todo: 'C0TODO11', waiting: 'C0WAIT22' } } });
  assert.match(fx.live(), /슬랙 수집을 연결했어요/);
});

test('WP-D1 C. 채널 만들기 권한이 없으면 남은 줄은 부르지 않고 ② 맨 아래에 전체 안내를 적는다', async () => {
  const fx = await intgSlackAtChannels({}, [
    { status: 400, body: { ok: false, code: 'missing_scope', error: '이 슬랙 앱에는 채널 만들기 권한이 없어요 — 만든 사람에게 권한 추가를 요청해 주세요' } },
  ]);
  await fx.find('slack', 'pri')[0].listeners.click();
  assert.equal(fx.sent.filter(one => one.url === '/api/integrations/slack-channel').length, 1, '권한이 없으면 남은 줄은 부르지 않는다');
  const errors = fx.find('slack', 'd-derr').filter(one => !String(one.className).includes('d-icherr'));
  assert.equal(errors.at(-1).textContent, '이 슬랙 앱에는 채널 만들기 권한이 없어요 — 만든 사람에게 권한 추가를 요청해 주세요');
  assert.equal(fx.find('slack', 'd-ich').length, 4, '② 단계에 그대로 머문다');
});

// WP-D1 H(채널 고치기 — 더하기만)는 WP-E의 `채널 고르기`(더하기·빼기 한 화면)로 바뀌었다 — 아래 WP-E 테스트.

test('WP-D1 E. 지라: 팀 주소가 있으면 묻지 않고(바꾸기로만 연다), 없으면 ② 계정에 주소 칸이 선다 — 연결하면 ③ ○○님으로 연결됐어요', async () => {
  const fx = intgClient({ jira: { siteUrl: 'https://회사.atlassian.net', email: '' } }, [
    { body: { ok: true, restart: false, jira: { displayName: '하늘' } } },
  ]);
  await fx.app.run('renderSettingsIntegrations()');
  fx.toggle('jira').listeners.click();
  const make = fx.button('jira', '토큰 만들기 ↗');
  assert.equal(make.href, 'https://id.atlassian.com/manage-profile/security/api-tokens');
  assert.equal(make.target, '_blank');
  assert.match(fx.text('jira'), /Atlassian 계정 보안 페이지 → API 토큰 만들기 → 이름은 아무거나 → 복사/);
  const token = fx.find('jira', 'd-din')[0];
  assert.equal(token.type, 'password');
  await fx.button('jira', '다음 →').listeners.click();
  assert.equal(fx.find('jira', 'd-derr')[0].textContent, 'API 토큰을 붙여 넣어 주세요');
  token.value = 'jira-secret';
  await token.listeners.keydown({ key: 'Enter', isComposing: false, preventDefault() {} });

  const fields = fx.find('jira', 'd-ifield');
  same(fields.map(one => [one.children[0].textContent, one.hidden]), [['지라에 로그인하는 이메일', false], ['지라 주소', true]], '팀 주소가 있으면 주소 칸은 닫혀 있다');
  assert.match(fx.text('jira'), /지라 주소는 팀 설정\(회사\.atlassian\.net\)을 써요 · 바꾸기/);
  fields[0].children[1].value = '나@회사.com';
  await fx.button('jira', '연결').listeners.click();
  const saved = fx.sent.find(one => one.url === '/api/integrations/save');
  same(saved.body, { jira: { enabled: true, siteUrl: 'https://회사.atlassian.net', email: '나@회사.com', token: 'jira-secret' } });
  // 다시 그린 카드에 ③ 확인이 이어서 선다
  assert.equal(fx.find('jira', 'd-iok')[0].textContent, '✓ 하늘님으로 연결됐어요');
  same(fx.find('jira', 'd-isteps')[0].children.filter(one => one.className !== 'ln').map(one => one.textContent), ['① 토큰 ✓', '② 계정 ✓', '③ 확인']);

  // `바꾸기`를 누르면 주소 칸이 열린다
  const again = intgClient({ jira: { siteUrl: 'https://회사.atlassian.net' } });
  await again.app.run('renderSettingsIntegrations()');
  again.toggle('jira').listeners.click();
  again.find('jira', 'd-din')[0].value = 't';
  await again.button('jira', '다음 →').listeners.click();
  again.button('jira', '바꾸기').listeners.click();
  assert.equal(again.find('jira', 'd-ifield')[1].hidden, false);
  assert.equal(again.find('jira', 'd-din')[1].value, 'https://회사.atlassian.net');

  // 팀 값이 없거나 예시값이면 주소 칸이 같은 단계에 처음부터 선다(예시 글자는 채우지 않는다)
  const plain = intgClient({ jira: { siteUrl: 'https://내회사.atlassian.net', email: '나@내회사.com' } });
  await plain.app.run('renderSettingsIntegrations()');
  plain.toggle('jira').listeners.click();
  plain.find('jira', 'd-din')[0].value = 't';
  await plain.button('jira', '다음 →').listeners.click();
  same(plain.find('jira', 'd-ifield').map(one => one.hidden), [false, false]);
  assert.ok(!/팀 설정/.test(plain.text('jira')));
  assert.ok(!JSON.stringify(plain.shape("document.getElementById('settingsIntegrationsView')")).includes('내회사'), '예시값은 입력칸에 들어가지 않는다');
});

test('연동 1층-B ①: 지라 주소를 주소창째 붙이면 칸에 `https://호스트`만 남기고 `주소를 … 으로 정리했어요`, 실패는 갈래 문구 그대로 + 고칠 칸만 붉게', async () => {
  const unreachable = '지라에 연결하지 못했어요 — 주소와 인터넷 연결을 확인하고 다시 눌러 주세요';
  const shape = '이메일 모양이 아니에요 — 지라에 로그인하는 회사 이메일을 적어 주세요';
  const auth = '이메일이나 토큰이 맞지 않아요 — 이메일을 확인하고, 맞으면 ← 이전으로 돌아가 새 토큰을 붙여 넣어 주세요';
  const fx = intgClient({ jira: { siteUrl: '', email: '' } }, [
    { status: 400, body: { ok: false, code: 'jira_unreachable', error: unreachable } },
    { status: 400, body: { ok: false, code: 'jira_email', error: shape } },
    { status: 400, body: { ok: false, code: 'jira_auth', error: auth } },
  ]);
  await fx.app.run('renderSettingsIntegrations()');
  fx.toggle('jira').listeners.click();
  fx.find('jira', 'd-din')[0].value = 'fake-jira-token';
  await fx.button('jira', '다음 →').listeners.click();
  const [email, site] = fx.find('jira', 'd-din');
  email.value = 'me@example.test';
  site.value = 'https://mycompany.atlassian.net/jira/software/projects/AB/boards/1?selectedIssue=AB-1';
  site.listeners.input({ inputType: 'insertText' });
  assert.equal(site.value.length > 40, true, '치는 중에는 건드리지 않는다');
  assert.equal(site.listeners.change, undefined, '칸을 벗어날 때 정리하지 않는다(안내 줄이 생기며 연결 버튼이 밀려 클릭이 빗나갔다)');
  site.listeners.input({ inputType: 'insertFromPaste' });
  assert.equal(site.value, 'https://mycompany.atlassian.net', '붙여 넣은 순간 칸에 정리한 주소를 보인다');
  const tidied = fx.find('jira', 'k-ok')[0];
  assert.equal(tidied.hidden, false);
  assert.equal(tidied.textContent, '주소를 https://mycompany.atlassian.net 으로 정리했어요');
  // 다시 고쳐 치면 안내는 내려간다 — 스킴 없이 적어도 연결할 때 붙여 보낸다
  site.value = 'mycompany.atlassian.net/browse/AB-1';
  site.listeners.input();
  assert.equal(tidied.hidden, true);

  await fx.button('jira', '연결').listeners.click();
  const sent = fx.sent.filter(one => one.url === '/api/integrations/save');
  assert.equal(sent[0].body.jira.siteUrl, 'https://mycompany.atlassian.net', '보내는 주소도 정리한 것');
  assert.equal(tidied.hidden, false);
  const error = () => fx.find('jira', 'd-derr')[0].textContent;
  assert.equal(error(), unreachable);
  assert.equal(site.getAttribute('aria-invalid'), 'true', '연결 안 됨은 주소 칸');
  assert.notEqual(email.getAttribute('aria-invalid'), 'true');

  site.listeners.input();
  await fx.button('jira', '연결').listeners.click();
  assert.equal(error(), shape);
  assert.equal(email.getAttribute('aria-invalid'), 'true', '이메일 모양은 이메일 칸');
  assert.notEqual(site.getAttribute('aria-invalid'), 'true');

  email.listeners.input();
  await fx.button('jira', '연결').listeners.click();
  assert.equal(error(), auth, '이메일·토큰은 가를 수 없어 둘 다 보라고 한다');
  assert.notEqual(email.getAttribute('aria-invalid'), 'true');
  assert.notEqual(site.getAttribute('aria-invalid'), 'true');

  // 같은 정리 규칙(서버 normalizeJiraSite와 같은 답)
  const tidy = value => fx.app.run(`settingsJiraSite(${JSON.stringify(value)})`);
  assert.equal(tidy('https://jira.example.test:8443/secure/Dashboard.jspa'), 'https://jira.example.test:8443');
  assert.equal(tidy('HTTPS://A.Atlassian.NET/'), 'https://a.atlassian.net');
  assert.equal(tidy('https://회사.atlassian.net/'), 'https://회사.atlassian.net');
  assert.equal(tidy('http://a.atlassian.net'), null, 'http는 정리하지 않고 서버 문구에 맡긴다');
  assert.equal(tidy('my company'), null);
  const { normalizeJiraSite } = require('./integrations');
  for (const value of ['https://mycompany.atlassian.net/jira?x=1#y', 'mycompany.atlassian.net', '//a.atlassian.net', 'https://u:p@a.atlassian.net/x', 'https://회사.atlassian.net/']) {
    assert.equal(tidy(value), normalizeJiraSite(value).site, value);
  }
});

// WP-D2에서 바뀜: `비밀 주소 붙이기`는 이제 자리만이 아니라 실제 갈래다(곧 돼요·is-off·aria-disabled 단언을 새 동작으로 바꿈).
// `Claude Code로` 갈래의 세 줄·복사·켜기(본문 `{ calendar: { enabled: true } }`)는 그대로다.
test('WP-D1·D2·V F. 캘린더: `맥 캘린더`(추천)가 맨 위 → `Claude Code로` 세 줄 + 복사 + 켜기 → 접힌 `다른 방법: 비밀 주소 붙이기`', async () => {
  const fx = intgClient({}, [{ body: { ok: true, restart: false } }]);
  await fx.app.run('renderSettingsIntegrations()');
  fx.toggle('calendar').listeners.click();
  const choices = fx.find('calendar', 'd-ichoice');
  same(choices.map(one => one.dataset.choice), ['mac', 'claude', 'ical'], '맥 캘린더가 맨 위, 비밀 주소는 마지막');
  same(choices.map(one => one.className), ['d-ichoice', 'd-ichoice', 'd-ichoice'], '셋 다 누를 수 있다');
  assert.equal(choices[0].getAttribute('aria-disabled'), undefined);
  same(fx.find('calendar', 'd-ichoices').map(one => one.className), ['d-ichoices is-stack'], '세로로 쌓는다');
  const more = fx.find('calendar', 'd-imore');
  assert.equal(more.length, 1, '비밀 주소는 접이식 안');
  assert.equal(more[0].children[0].textContent, '다른 방법: 비밀 주소 붙이기');
  assert.equal(more[0].children[1].dataset.choice, 'ical');
  const secret = fx.find('calendar', 'd-din');
  assert.equal(secret.length, 1, '칸은 비밀 주소 하나');
  assert.equal(secret[0].type, 'password', '비밀 주소는 토큰처럼 가린다');
  const text = fx.text('calendar');
  assert.ok(!/곧 돼요/.test(text));
  assert.match(text, /맥 캘린더가 가장 쉬워요/);
  assert.match(text, /맥 캘린더추천1맥 시스템 설정 → 인터넷 계정 → Google에서 회사 계정을 추가하고 캘린더를 켜요2허용하고 확인 — 맥이 캘린더 접근을 물으면 허용을 눌러요허용하고 확인3읽을 캘린더 고르기/);
  assert.match(text, /Claude·비밀 주소 없이 맥 캘린더 앱에서 매일 8–20시 30분마다 읽어요/);
  assert.match(text, /비밀 주소 붙이기누구나1컴퓨터에서 calendar\.google\.com 열기\(폰 앱은 안 돼요\)2오른쪽 위 톱니바퀴 → 설정3왼쪽 내 캘린더의 설정에서 내 이름4아래로 내려 캘린더 통합 → iCal 형식의 비공개 주소 옆 복사\(위의 공개 주소 말고\)5아래 칸에 붙여 넣고 연결/);
  assert.match(text, /이 칸이 안 보이면 회사에서 막아 둔 거예요 → 위의 맥 캘린더나 Claude Code로/);
  assert.ok(text.indexOf('맥 캘린더추천') < text.indexOf('Claude Code로') && text.indexOf('Claude Code로') < text.indexOf('다른 방법: 비밀 주소 붙이기'), '차례: 맥 → Claude → 다른 방법');
  assert.match(text, /1claude\.ai → 설정 → 커넥터에서 Google Calendar → 연결 → 구글 로그인 → 허용 \(이 맥의 Claude Code와 같은 계정이어야 해요\)claude\.ai\/settings\/connectors복사/);
  assert.match(text, /2여기서 켜기 — 매일 9~19시 2시간마다 읽어요\. 바로 보려면 연결 뒤 ⋯ › 새로 받기 켜기/);
  assert.match(text, /3안 되면: 터미널에서 claude를 켠 뒤 \/mcp → 목록에 claude\.ai Google Calendar가 연결됨인지 확인해요\/mcp복사/);
  assert.match(text, /Claude Code\(유료 구독\)가 있어야 해요/);
  await fx.find('calendar', 'd-icode')[1].children[1].listeners.click();
  same(fx.copied, ['/mcp']);
  await fx.button('calendar', '켜기').listeners.click();
  same(fx.sent.find(one => one.url === '/api/integrations/save').body, { calendar: { enabled: true } });

  const noClaude = intgClient({ claude: false });
  await noClaude.app.run('renderSettingsIntegrations()');
  noClaude.toggle('calendar').listeners.click();
  assert.equal(noClaude.button('calendar', '켜기').disabled, true, 'Claude Code가 없으면 켤 수 없다');
  assert.match(noClaude.text('calendar'), /이 맥에는 설치 안 됨 — 설치하면 켤 수 있어요/);
  assert.equal(noClaude.button('calendar', '연결').disabled, false, '비밀 주소 갈래는 Claude 없이도 된다');
});

test('WP-D2 F. 비밀 주소 연결: 빈 칸은 보내지 않고, 붙이면 `{ source: ical, url }` 한 번 — 서버가 센 오늘 일정 수를 알린다', async () => {
  const fx = intgClient({}, [
    { status: 400, body: { ok: false, error: '캘린더 주소가 아니에요 — iCal 형식의 비공개 주소를 복사해 주세요' } },
    { body: { ok: true, restart: false, calendar: { source: 'ical', count: 3 } } },
  ]);
  await fx.app.run('renderSettingsIntegrations()');
  fx.toggle('calendar').listeners.click();
  // 오류 줄은 갈래마다 따로다 — 비밀 주소 갈래(접이식 안)의 것.
  const error = () => fx.find('calendar', 'd-imore')[0].children[1].children.find(one => one.className === 'd-derr').textContent;
  await fx.button('calendar', '연결').listeners.click();
  assert.equal(error(), '비밀 주소를 붙여 넣어 주세요');
  assert.equal(fx.sent.filter(one => one.url === '/api/integrations/save').length, 0, '빈 칸은 서버에 보내지 않는다');

  const input = fx.find('calendar', 'd-din')[0];
  input.value = 'https://calendar.google.com/calendar/ical/me/private-abc/basic.ics';
  await fx.button('calendar', '연결').listeners.click();
  assert.equal(error(), '캘린더 주소가 아니에요 — iCal 형식의 비공개 주소를 복사해 주세요', '서버 문구를 그 자리에 적는다');
  await fx.button('calendar', '연결').listeners.click();
  const saves = fx.sent.filter(one => one.url === '/api/integrations/save');
  same(saves[1].body, { calendar: { enabled: true, source: 'ical', url: 'https://calendar.google.com/calendar/ical/me/private-abc/basic.ics' } });
  assert.match(fx.live(), /캘린더를 연결했어요 · 오늘 일정 3개가 보여요 · 서버를 다시 켜면 적용돼요/);
});

test('WP-D2 F. 연결된 캘린더: `비밀 주소로 읽는 중 · 오늘 3개 · 10분 전` + ⋯ 다시 연결(주소 바꾸기)·해제…(주소 파일은 남아요)', async () => {
  const fx = intgClient({ calendar: { enabled: true, source: 'ical', hasIcal: true, live: true, readAt: ago(10), eventCount: 3, failed: false } },
    [{ body: { ok: true, restart: false, calendar: { source: 'ical', count: 2 } } }, { body: { ok: true, restart: false } }]);
  await fx.app.run('renderSettingsIntegrations()');
  assert.equal(fx.shape(`window.findByClass(document.getElementById('settingsIntegrationsView').children[3], 'now')[0]`).text, '비밀 주소로 읽는 중 · 오늘 3개 · 10분 전');
  assert.match(fx.text('calendar'), /열려요비밀 주소로 읽는 중 · 오늘 3개 · 10분 전30분마다$/, '지금 상황 · 도는 주기(앱이 30분마다 직접 읽는다)가 한 줄');
  assert.match(fx.shape("document.getElementById('settingsIntegrationsView').children[0]").text, /연결됨 1 · 남은 것 2$/, '직접 옮기기는 세지 않는다');
  const menu = fx.menu('calendar');
  same(menu.map(section => section.map(entry => entry.label)), [['새로 받기', '다시 연결(주소 바꾸기)'], ['해제…']]);

  // 다시 연결 — 비밀 주소 갈래 하나만, 칸을 비우면 지금 주소로 다시 읽는다
  menu[0][1].onClick();
  same(fx.find('calendar', 'd-ichoice').map(one => one.dataset.choice), ['ical']);
  assert.match(fx.text('calendar'), /비밀 주소를 바꿔 붙여요/);
  assert.match(fx.text('calendar'), /칸을 비워 두고 연결하면 지금 주소로 다시 읽어요\./);
  await fx.button('calendar', '연결').listeners.click();
  same(fx.sent.find(one => one.url === '/api/integrations/save').body, { calendar: { enabled: true, source: 'ical', url: '' } });

  // 해제 — 카드 안 확인 줄, 주소 파일은 남는다
  fx.menu('calendar')[1][0].onClick();
  const confirm = fx.find('calendar', 'd-iconfirm')[0];
  assert.equal(confirm.children[0].textContent, '해제하면 오늘 일정 가져오기가 멈춰요. 주소 파일은 남아요.');
  await confirm.children[2].listeners.click();
  same(fx.sent.filter(one => one.url === '/api/integrations/save')[1].body, { calendar: { enabled: false } });
  assert.match(fx.live(), /연결을 해제했어요 — 주소 파일은 그대로 있어요/);

  // Claude Code 갈래는 예전 한 줄 그대로, 못 읽고 있으면 그 말
  const claude = intgClient({ calendar: { enabled: true, source: 'claude' } });
  await claude.app.run('renderSettingsIntegrations()');
  assert.equal(claude.shape(`window.findByClass(document.getElementById('settingsIntegrationsView').children[3], 'now')[0]`).text, 'Claude Code로 읽는 중');
  same(claude.menu('calendar').map(section => section.map(entry => entry.label)), [['새로 받기'], ['해제…']]);
  const broken = intgClient({ calendar: { enabled: true, source: 'ical', hasIcal: true, readAt: null, eventCount: null, failed: true } });
  await broken.app.run('renderSettingsIntegrations()');
  assert.equal(broken.shape(`window.findByClass(document.getElementById('settingsIntegrationsView').children[3], 'now')[0]`).text, '비밀 주소를 읽지 못했어요');
  same(statOf(broken, 'calendar'), ['d-istat k-stop', '멈췄어요'], '한 번도 못 읽은 비밀 주소는 주소 문제 — 멈췄어요');
  assert.equal(broken.find('calendar', 'd-ifetch')[0].textContent, '다시 연결');
});

test('WP-D1 G. 회의록: 세그먼트 `직접 옮기기 | 티로`, 티로는 세 줄(명령 복사)을 보고 마지막 버튼으로만 저장한다', async () => {
  const fx = intgClient({}, [{ body: { ok: true, restart: false } }]);
  await fx.app.run('renderSettingsIntegrations()');
  assert.equal(fx.toggle('notes').textContent, '바꾸기');
  fx.toggle('notes').listeners.click();
  const seg = fx.find('notes', 'd-seg')[0];
  same(seg.children.map(one => [one.textContent, one.getAttribute('role'), one.getAttribute('aria-checked')]),
    [['직접 옮기기(기본)', 'radio', 'true'], ['티로', 'radio', 'false']]);
  assert.equal(seg.getAttribute('role'), 'radiogroup');
  const tiro = fx.find('notes', 'd-itiro')[0];
  assert.equal(tiro.hidden, true);
  seg.children[1].listeners.click();
  assert.equal(tiro.hidden, false);
  assert.equal(seg.children[1].getAttribute('aria-checked'), 'true');
  assert.equal(fx.sent.filter(one => one.url === '/api/integrations/save').length, 0, '티로를 고르기만 해서는 저장하지 않는다');
  const text = fx.text('notes');
  assert.match(text, /Claude Code\(유료 구독\)가 있어야 해요/);
  assert.match(text, /1터미널에 붙여 넣기claude mcp add --transport http tiro-mcp https:\/\/mcp\.tiro\.ooo\/mcp복사/);
  assert.match(text, /2Claude Code에서 \/mcp → tiro-mcp → Authenticate/);
  assert.match(text, /3여기서 티로 선택 티로로 받기/);
  assert.match(text, /직접 옮기기는 회의 정리 화면에 붙여 넣어요 — 아무것도 설치하지 않아요\./);
  assert.ok(!/다른 것/.test(text), '`다른 것`은 목록 맨 아래 요청하기로 옮겼다');
  await fx.find('notes', 'd-icode')[0].children[1].listeners.click();
  same(fx.copied, ['claude mcp add --transport http tiro-mcp https://mcp.tiro.ooo/mcp']);
  await fx.button('notes', '티로로 받기').listeners.click();
  same(fx.sent.find(one => one.url === '/api/integrations/save').body, { meetingNotes: { mode: 'tiro' } });

  const noClaude = intgClient({ claude: false });
  await noClaude.app.run('renderSettingsIntegrations()');
  noClaude.toggle('notes').listeners.click();
  assert.equal(noClaude.button('notes', '티로로 받기').disabled, true);

  // 옛 설정의 `다른 것`은 그대로 읽어 보여 준다
  const other = intgClient({ meetingNotes: { mode: 'other', name: '노션' } });
  await other.app.run('renderSettingsIntegrations()');
  assert.match(other.text('notes'), /노션 쓰는 중 · 요청해 두었어요/);
});

test('WP-D1 A. 맨 아래 `요청하기`는 도구 이름 한 칸 + 요청 문구 복사(문제 보고 글 앞에 `연동 요청: 이름`)', async () => {
  const fx = intgClient();
  await fx.app.run('renderSettingsIntegrations()');
  const foot = () => fx.view().children.at(-1);
  const ask = fx.app.run("window.findByClass(document.getElementById('settingsIntegrationsView').children.at(-1), 'd-intgask')[0]");
  assert.equal(ask.hidden, true);
  fx.app.run("window.findByClass(document.getElementById('settingsIntegrationsView').children.at(-1), 'd-ablink')[0]").listeners.click();
  assert.equal(ask.hidden, false);
  const copy = fx.app.run("window.findByClass(document.getElementById('settingsIntegrationsView').children.at(-1), 'd-btn')[0]");
  await copy.listeners.click();
  assert.equal(fx.app.run("window.findByClass(document.getElementById('settingsIntegrationsView').children.at(-1), 'd-derr')[0]").textContent, '어떤 도구인지 이름을 적어 주세요');
  fx.app.run("window.findByClass(document.getElementById('settingsIntegrationsView').children.at(-1), 'd-din')[0]").value = '노션 캘린더';
  await copy.listeners.click();
  assert.equal(fx.copied.length, 1);
  assert.match(fx.copied[0], /^연동 요청: 노션 캘린더\n워크스페이스 /);
  assert.ok(foot());
});

test('WP-D1: 도움말 문답에 `슬랙에서 이렇게 보내요`가 있다', () => {
  const app = pureClient();
  const faq = JSON.parse(app.run('JSON.stringify(SETTINGS_FAQ)'));
  const entry = faq.flatMap(([, rows]) => rows).find(([question]) => question === '슬랙에서 이렇게 보내요');
  assert.ok(entry);
  assert.equal(entry[1], '슬랙 연결');
  assert.match(entry[2], /<b>남의 메시지<\/b>는 ⋯ → <b>전달<\/b>/);
  assert.match(entry[2], /해야 할 일 → 할 일 · 답을 기다리는 것 → 기다리는 것 · 정해진 정책 → 정해진 것 · 참고거리 → 언젠가/);
});

// WP-D2에서 바뀜: 예전 `시작하기` 카드(기록이 0일 때만)는 없앴다 — 같은 자리에 `사용설명서` 카드가 선다(시안 I).
function guideClient({ blocked = false } = {}) {
  const app = pureClient();
  const store = new Map();
  app.context.localStorage = blocked
    ? { getItem() { throw new Error('막힘'); }, setItem() { throw new Error('막힘'); } }
    : { getItem: key => (store.has(key) ? store.get(key) : null), setItem: (key, value) => store.set(key, String(value)) };
  app.context.document.createTextNode = text => ({ textContent: String(text) });
  app.run(NODE_SHAPE);
  app.run(`window.went = [];
    settingsOpen = (tab, key) => window.went.push([tab, key || null]);
    settingsGuideShow = question => window.went.push(['show', question]);
    settingsClose = () => window.went.push(['close']);`);
  const shape = node => JSON.parse(app.run(`JSON.stringify(window.shapeOf(${node}))`));
  return { app, store, shape, went: () => JSON.parse(app.run('JSON.stringify(window.went)')) };
}

// 첫사용: 오늘 탭 카드는 네 칸 판(`.d-guidegrid` 한 겹 안에 네 줄) — 줄의 이름은 `.t` 칸이다(설치 줄은 앞에 아이콘이 선다).
const guideName = row => row.children.find(kid => kid && kid.className === 't').textContent;

test('WP-D2 I. 사용설명서 카드: 닫기 전까지는 기록이 있어도 늘 서고, 네 줄이 각자 데려가는 곳이 있다', () => {
  const fx = guideClient();
  fx.app.run('renderGuideCard()');
  const zone = fx.app.nodes.get('startCardZone');
  assert.equal(zone.hidden, false);
  const card = zone.children[0];
  assert.equal(card.className, 'd-start d-guidecard');
  assert.equal(fx.shape("document.getElementById('startCardZone').children[0].children[0]").text, '사용설명서닫기');
  assert.equal(card.children[1].className, 'd-guidegrid', '네 줄은 네 칸 판 한 겹 안에 선다(넓게 2×2, ≤520 한 줄씩은 CSS)');
  const rows = card.children[1].children;
  // WP-L: 첫 줄은 `앱으로 설치`(가짜 창은 크롬이 설치 창을 주지 않은 일반 탭 — 글 안내)
  same(rows.map(guideName), ['앱으로 설치', '할 일 적기', '연동은 나중에', '슬랙에서 보내는 법']);
  same(rows.map(row => String(row.type || '')), ['', 'button', 'button', 'button'], '첫 줄만 버튼이 아니다(할 일이 앱 밖에 있다)');
  const text = index => fx.shape(`document.getElementById('startCardZone').children[0].children[1].children[${index}]`).text;
  assert.equal(text(0), '앱으로 설치크롬 ⋮ → 페이지를 앱으로 설치', '한 줄 — `전송, 저장, 공유`·`이미 설치했으면`은 도움말에만');
  assert.equal(text(1), '할 일 적기맨 위 칸에 적고 Enter');
  assert.equal(text(2), '연동은 나중에설정 ⚙ → 연동에서 하나씩');
  assert.equal(text(3), '슬랙에서 보내는 법전달로 채널에 보내요');
  assert.equal(rows[0].className, 'd-guide is-install');
  const icon = rows[0].children[0];
  assert.equal(icon.className, 'me', '설치 줄은 이름 앞에 앱 아이콘 하나');
  assert.equal(icon.src, '/app-icon.png', '지금 아이콘을 그대로 보여 준다');
  assert.equal(icon.alt, '', '아이콘은 꾸밈이다');
  assert.ok(!rows[0].children[2].children.some(kid => kid.className === 'd-guidedock'), 'Dock 그림은 도움말에만');
  // 버튼 줄 셋만 끝에 오른쪽 꺾쇠 — 글리프가 아니라 공용 아이콘(uiIcon chevron) SVG다
  rows.slice(1).forEach((row) => {
    const go = row.children.at(-1);
    assert.equal(go.className, 'go');
    assert.equal(go.html, fx.app.run("uiIcon('chevron')"));
    assert.match(go.html, /aria-hidden="true"/);
  });
  assert.ok(!rows[0].children.some(kid => kid.className === 'go'), '설치 줄(버튼 아님)에는 꺾쇠가 없다');

  // 줄마다 데려가는 곳
  rows[1].listeners.click();
  assert.equal(fx.app.nodes.get('todayTaskInput').focused, true, '할 일 입력칸으로 초점');
  rows[2].listeners.click();
  rows[3].listeners.click();
  same(fx.went(), [['close'], ['integrations', null], ['guide', null], ['show', '슬랙에서 이렇게 보내요']]);

  // 새로고침마다 다시 만들지 않는다(누르려던 줄의 초점이 사라지지 않게) — 기록이 있어도 그대로 선다
  fx.app.run('renderGuideCard()');
  assert.equal(fx.app.nodes.get('startCardZone').children[0], card);
  assert.equal(fx.app.run("typeof startCardEmpty"), 'undefined', '예전 시작 카드(기록 0일 때만)는 없앴다');
});

test('WP-D2 I. 사용설명서 닫기: 이 브라우저에 기억하고(config 아님), 도움말 맨 위에 같은 네 줄로 남는다 — 저장이 막혀도 이 창에서는 닫힌다', () => {
  const fx = guideClient();
  fx.app.run('renderSettingsManual()');
  assert.equal(fx.app.nodes.get('settingsManualView').hidden, true, '닫기 전에는 도움말에 두 번 두지 않는다');
  fx.app.run('renderGuideCard()');
  const close = fx.app.nodes.get('startCardZone').children[0].children[0].children[1];
  assert.equal(close.getAttribute('aria-label'), '사용설명서 닫기 — 도움말에 남아요');
  close.listeners.click();
  assert.equal(fx.store.get('guideCardClosed'), '1');
  assert.equal(fx.app.nodes.get('startCardZone').hidden, true);
  assert.equal(fx.app.nodes.get('startCardZone').children.length, 0);
  fx.app.run('renderGuideCard()');
  assert.equal(fx.app.nodes.get('startCardZone').hidden, true, '다시 그려도 닫힌 채다');

  fx.app.run('renderSettingsManual()');
  const view = fx.app.nodes.get('settingsManualView');
  assert.equal(view.hidden, false);
  const box = view.children[0];
  assert.equal(box.className, 'd-manual');
  assert.equal(box.children[0].textContent, '사용설명서');
  same(box.children.slice(1).map(row => row.children[0].textContent), ['앱으로 설치', '할 일 적기', '연동은 나중에', '슬랙에서 보내는 법']);

  // 저장이 막힌 브라우저 — 이 창이 열려 있는 동안만 닫힌다
  const blocked = guideClient({ blocked: true });
  blocked.app.run('renderGuideCard()');
  assert.equal(blocked.app.nodes.get('startCardZone').hidden, false);
  blocked.app.nodes.get('startCardZone').children[0].children[0].children[1].listeners.click();
  assert.equal(blocked.app.nodes.get('startCardZone').hidden, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// WP-L — 크롬 `앱으로 설치`(PWA)를 기본 길로: 사용설명서 첫 줄 · 설정 › 꾸미기 맨 위
function installClient({ standalone = null, iosStandalone = false } = {}) {
  const fx = guideClient();
  if (standalone !== null) fx.app.run(`window.matchMedia = q => ({ matches: q === '(display-mode: standalone)' && ${standalone} })`);
  if (iosStandalone) fx.app.context.navigator = { standalone: true, platform: 'iPhone' };
  fx.app.run(`window.notices = []; showNotice = (message) => window.notices.push(message);
    window.fakePrompt = (outcome) => {
      const event = { prevented: 0, prompted: 0 };
      event.preventDefault = () => { event.prevented += 1; };
      event.prompt = async () => { event.prompted += 1; };
      event.userChoice = Promise.resolve({ outcome });
      return event;
    };`);
  const card = () => fx.app.nodes.get('startCardZone').children[0];
  const first = () => card().children[1].children[0];
  const text = () => fx.shape("document.getElementById('startCardZone').children[0].children[1].children[0]").text;
  const installButton = () => first().children[2].children.find(kid => String(kid.className || '').includes('d-installbtn'));
  return { ...fx, card, first, text, installButton, notices: () => JSON.parse(fx.app.run('JSON.stringify(window.notices)')) };
}

test('WP-L 앱으로 설치: 크롬이 설치 창을 주지 않으면(이미 설치했거나 크롬이 아님) 사용설명서 첫 줄이 크롬 메뉴 길을 글로 알린다', () => {
  const fx = installClient({ standalone: false });
  fx.app.run('renderGuideCard()');
  assert.equal(guideName(fx.first()), '앱으로 설치');
  assert.equal(String(fx.first().type || ''), '', '줄 자체는 버튼이 아니다(할 일이 크롬에 있다)');
  assert.equal(fx.text(), '앱으로 설치크롬 ⋮ → 페이지를 앱으로 설치', '오늘 탭 카드는 한 줄');
  assert.equal(fx.installButton(), undefined, '설치 창을 줄 수 없으면 버튼도 없다');
  same(fx.went(), []);
});

test('WP-L 앱으로 설치: beforeinstallprompt를 잡아 두고 `설치하기` → prompt(), accepted면 `설치했어요 · 새 창의 아이콘을 Dock에 유지해 주세요`', async () => {
  const fx = installClient();
  fx.app.run('renderGuideCard()');
  assert.equal(fx.installButton(), undefined);
  fx.app.run("window.ev = window.fakePrompt('accepted'); appInstallOnPrompt(window.ev)");
  assert.equal(fx.app.run('window.ev.prevented'), 1, '크롬이 스스로 띄우지 않게 잡아 둔다');
  // 이미 떠 있는 카드를 다시 만들지 않고 그 줄만 다시 채운다
  assert.equal(fx.installButton().textContent, '설치하기');
  assert.equal(fx.text(), '앱으로 설치설치하기', '오늘 탭 카드는 버튼 하나(설명 문장은 도움말·꾸미기에)');
  await fx.installButton().listeners.click();
  assert.equal(fx.app.run('window.ev.prompted'), 1, '누르면 크롬의 설치 창');
  assert.equal(fx.text(), '앱으로 설치설치했어요 · 새 창의 아이콘을 Dock에 유지해 주세요');
  assert.equal(fx.installButton(), undefined);

  // appinstalled는 한 번만 알린다(accepted 뒤에도 크롬이 보낸다)
  fx.app.run('appInstallOnInstalled(); appInstallOnInstalled()');
  same(fx.notices(), ['앱으로 설치했어요 · 새 창의 아이콘을 Dock에 유지해 주세요']);
});

test('WP-L 앱으로 설치: 설치 창을 닫으면(dismissed) 이벤트는 한 번뿐이라 글 안내로 돌아가고, appinstalled만 와도 권유를 치운다', async () => {
  const fx = installClient();
  fx.app.run('renderGuideCard()');
  fx.app.run("appInstallOnPrompt(window.fakePrompt('dismissed'))");
  await fx.installButton().listeners.click();
  assert.equal(fx.installButton(), undefined);
  assert.equal(fx.text(), '앱으로 설치크롬 ⋮ → 페이지를 앱으로 설치');

  const other = installClient();
  other.app.run('renderGuideCard()');
  other.app.run("appInstallOnPrompt(window.fakePrompt('accepted'))");
  other.app.run('appInstallOnInstalled()');
  assert.equal(other.installButton(), undefined, '권유를 치운다');
  assert.equal(other.text(), '앱으로 설치설치했어요 · 새 창의 아이콘을 Dock에 유지해 주세요');
  same(other.notices(), ['앱으로 설치했어요 · 새 창의 아이콘을 Dock에 유지해 주세요']);
});

test('WP-L 앱으로 설치: 설치된 창(standalone · 아이폰 navigator.standalone)에서는 권하지 않고 `Dock에 두기`만 남는다', () => {
  for (const options of [{ standalone: true }, { iosStandalone: true }]) {
    const fx = installClient(options);
    fx.app.run("appInstallOnPrompt(window.fakePrompt('accepted'))");
    fx.app.run('renderGuideCard()');
    assert.equal(fx.app.run('appInstallState()'), 'standalone');
    assert.equal(guideName(fx.first()), 'Dock에 두기');
    assert.equal(fx.text(), 'Dock에 두기Dock의 이 앱 아이콘 우클릭 → 옵션 → Dock에 유지');
    assert.equal(fx.installButton(), undefined);
    fx.app.run('renderSettingsManual()');
  }
});

// WP-J B. 쉬운 말 소식 카드(오늘 탭) — 받은 뒤 앱을 처음 열 때 한 번만.

test('WP-J B. 처음 쓰는 사람(newsSeen 없음)은 카드를 보지 않고, 지금 버전으로 적어만 둔다', () => {
  const fx = guideClient();
  fx.app.run(`settingsAbout = { version: '1.2.0', news: [{ version: '1.2.0', date: '2026-09-28', lines: ['첫 줄'] }] };`);
  fx.app.run('renderNewsCard()');
  const zone = fx.app.nodes.get('newsCardZone');
  assert.equal(zone.hidden, true);
  assert.equal(zone.children.length, 0);
  assert.equal(fx.store.get('newsSeen'), '1.2.0', '다음 버전부터 알아보도록 지금 버전을 적어 둔다');
});

test('WP-J B. 이미 본 버전이면 다시 뜨지 않고, 버전이 올라가면 한 번 뜬다(닫기 → 기억)', () => {
  const fx = guideClient();
  fx.store.set('newsSeen', '1.2.0');
  fx.app.run(`settingsAbout = { version: '1.2.0', news: [{ version: '1.2.0', date: '2026-09-28', lines: ['첫 줄'] }] };`);
  fx.app.run('renderNewsCard()');
  assert.equal(fx.app.nodes.get('newsCardZone').hidden, true, '같은 버전은 다시 뜨지 않는다');

  fx.store.set('newsSeen', '1.1.0');
  fx.app.run(`settingsAbout = { version: '1.2.0', news: [
    { version: '1.2.0', date: '2026-09-28', lines: ['Dock 아이콘을 눌러도 창이 하나만 떠요', '**굵게**도 돼요'] },
    { version: '1.1.0', date: '2026-09-24', lines: ['지난 줄'] },
  ] };`);
  fx.app.run('renderNewsCard()');
  const zone = fx.app.nodes.get('newsCardZone');
  assert.equal(zone.hidden, false);
  const card = zone.children[0];
  assert.equal(card.className, 'd-start d-newscard');
  assert.equal(fx.shape("document.getElementById('newsCardZone').children[0].children[0]").text, 'v1.2.0으로 바뀌었어요닫기');
  assert.equal(fx.shape("document.getElementById('newsCardZone').children[0].children[1]").text, 'Dock 아이콘을 눌러도 창이 하나만 떠요굵게도 돼요');
  const list = card.children[1];
  assert.equal(list.className, 'd-newslist');
  assert.equal(list.children[1].children[0].textContent, '굵게', '굵게는 <b> 요소다');

  // 새로고침마다 다시 만들지 않는다(닫으려던 초점이 사라지지 않게)
  fx.app.run('renderNewsCard()');
  assert.equal(fx.app.nodes.get('newsCardZone').children[0], card);

  const close = card.children[0].children[1];
  assert.equal(close.getAttribute('aria-label'), '새 소식 닫기');
  close.listeners.click();
  assert.equal(fx.store.get('newsSeen'), '1.2.0');
  assert.equal(fx.app.nodes.get('newsCardZone').hidden, true);
  assert.equal(fx.app.nodes.get('newsCardZone').children.length, 0);
  fx.app.run('renderNewsCard()');
  assert.equal(fx.app.nodes.get('newsCardZone').hidden, true, '다시 그려도 닫힌 채다');
});

test('WP-J B. 지금 버전의 소식이 소식.md에 없으면 카드가 없다(버전이 올라갔어도)', () => {
  const fx = guideClient();
  fx.store.set('newsSeen', '1.1.0');
  fx.app.run(`settingsAbout = { version: '1.2.0', news: [{ version: '1.1.0', date: '2026-09-24', lines: ['지난 줄'] }] };`);
  fx.app.run('renderNewsCard()');
  assert.equal(fx.app.nodes.get('newsCardZone').hidden, true);
  assert.equal(fx.store.get('newsSeen'), '1.1.0', '보여줄 소식이 없으니 본 것으로 적지도 않는다');
});

test('WP-J B. 저장이 막힌 브라우저에서는 닫은 뒤에도 이 창이 열려 있는 동안만 기억한다', () => {
  const fx = guideClient({ blocked: true });
  fx.app.run(`newsMarkSeen('1.1.0'); settingsAbout = { version: '1.2.0', news: [{ version: '1.2.0', date: '2026-09-28', lines: ['새 줄'] }] };`);
  fx.app.run('renderNewsCard()');
  assert.equal(fx.app.nodes.get('newsCardZone').hidden, false);
  fx.app.nodes.get('newsCardZone').children[0].children[0].children[1].listeners.click();
  assert.equal(fx.app.nodes.get('newsCardZone').hidden, true, '저장은 막혀도 이 창에서는 닫힌 채다');
});

test('WP-J A·B. 소식 카드는 사용설명서 카드보다 화면 위쪽에 선다(index.html 자리 순서)', () => {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  assert.ok(html.indexOf('id="newsCardZone"') < html.indexOf('id="startCardZone"'), '둘 다 있으면 소식이 위');
});

test('WP-D2 I. 도움말: 문답마다 찾아갈 표지가 있고, `슬랙에서 보내는 법`은 그 문답을 밝힌다', () => {
  const app = pureClient();
  app.context.document.createTextNode = text => ({ textContent: String(text) });
  app.context.location = { hostname: 'example.test' };
  app.run('renderSettingsGuide()');
  const doc = app.nodes.get('settingsGuideView').children[0];
  // 문답은 묶음 접이식(<details>) 안 `.inner`에 있다.
  const groups = doc.children.filter(kid => String(kid.className).split(' ').includes('d-faqgrp'));
  const questions = groups.flatMap(group => group.children[1].children).filter(kid => kid.className === 'q');
  const q = questions.find(kid => kid.dataset.faq === '슬랙에서 이렇게 보내요');
  assert.ok(q, '문답 제목에 data-faq 표지');
  const home = groups.find(group => group.children[1].children.includes(q));
  assert.equal(home.children[0].children[1].textContent, '연동·자동화');
  assert.ok(!home.open, '연동·자동화 묶음은 처음엔 접혀 있다');
  const added = [];
  q.classList = { add: name => added.push(name), remove() {} };
  q.closest = selector => (selector === 'details' ? home : null);
  app.nodes.get('settingsGuideView').querySelectorAll = () => questions;
  assert.equal(app.run("settingsGuideShow('슬랙에서 이렇게 보내요')"), q);
  same(added, ['is-hit']);
  assert.equal(q.focused, true);
  assert.equal(home.open, true, '찾아온 문답의 묶음을 펼친다');
  // 사람이 다시 접어 두었어도 또 찾아오면 연다.
  home.open = false;
  app.run("settingsGuideShow('슬랙에서 이렇게 보내요')");
  assert.equal(home.open, true);
  const before = groups.map(group => !!group.open);
  assert.equal(app.run("settingsGuideShow('없는 문답')"), null);
  same(groups.map(group => !!group.open), before, '못 찾으면 묶음은 건드리지 않는다');

  const faq = JSON.parse(app.run('JSON.stringify(SETTINGS_FAQ)')).flatMap(([, rows]) => rows);
  assert.ok(faq.some(([question]) => question === '앱 아이콘·이름을 바꾸려면'));
  assert.match(faq.find(([question]) => question === 'Claude 없이 캘린더를 붙이려면')[2], /iCal 형식의 비공개 주소/);
});

// ─────────────────────────────────────────────────────────────────────────────
// WP-D2 L — 설정 › 꾸미기(이 맥에만): 세 줄 + 저장 + 앱 위치

function personalizeClient(state = {}, replies = []) {
  const payload = { ok: true, title: '○○의 워크스페이스', dockName: '워크스페이스', customIcon: false, ...state };
  const about = { version: '1.0.0', updateFile: '~/workspace/업데이트.command' };
  const app = settingsClient(payload);
  const sent = [];
  const copied = [];
  app.context.navigator = { clipboard: { writeText: async (text) => { copied.push(text); } }, platform: 'MacIntel' };
  app.context.fetch = async (url, options = {}) => {
    const address = String(url);
    sent.push({ url: address, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
    let next = { body: { ok: true } };
    if (address === '/api/personalize' && !options.method) next = { body: payload };
    else if (address === '/api/about') next = { body: about };
    else next = replies.shift() || next;
    return new Response(JSON.stringify(next.body), { status: next.status || 200, headers: { 'Content-Type': 'application/json' } });
  };
  app.run(NODE_SHAPE);
  app.run(`window.findByClass = (node, cls) => {
    const hits = [];
    const walk = (one) => { if (one && String(one.className || '').split(' ').includes(cls)) hits.push(one); ((one && one.children) || []).forEach(walk); };
    walk(node);
    return hits;
  };`);
  const view = () => app.nodes.get('settingsPersonalizeView');
  const text = node => JSON.parse(app.run(`JSON.stringify(window.shapeOf(${node}))`)).text;
  const find = cls => app.run(`window.findByClass(document.getElementById('settingsPersonalizeView'), ${JSON.stringify(cls)})`);
  const inputs = () => find('d-din');
  const button = label => find('d-btn').concat(find('d-ablink')).find(one => one.textContent === label);
  const posts = () => sent.filter(one => one.method === 'POST');
  return { app, sent, copied, view, text, find, inputs, button, posts };
}

test('WP-D2 L. 꾸미기: 앱 아이콘 · 앱 이름 · 워크스페이스 제목 + 안내 줄 + 저장(앱 위치는 앱 탭으로 옮겼다)', async () => {
  const fx = personalizeClient();
  await fx.app.run('renderSettingsPersonalize()');
  const kids = fx.view().children;
  same(kids.map(one => one.className), ['d-pset', 'd-pset', 'd-pset', 'd-pset', 'd-derr', 'd-pfoot'], '꾸미기 탭에는 앱 위치 줄이 없다');
  assert.ok(!fx.sent.some(one => one.url === '/api/about'), '앱 위치를 읽으러 가지도 않는다');
  // WP-L: 맨 위는 `앱으로 설치`(사용설명서를 닫은 사람도 찾게)
  assert.equal(kids[0].dataset.row, 'app-install');
  assert.equal(fx.text("document.getElementById('settingsPersonalizeView').children[0]"), '앱으로 설치크롬 앱으로 창을 따로 띄워요크롬 ⋮ → 전송, 저장, 공유 → 페이지를 앱으로 설치이미 설치했으면 주소창 오른쪽 앱 열기');
  assert.equal(fx.text("document.getElementById('settingsPersonalizeView').children[1].children[0]"), '앱 아이콘');
  assert.equal(fx.text("document.getElementById('settingsPersonalizeView').children[2].children[0]"), '앱 이름크롬 앱의 이름 — Dock·⌘Tab에 보여요', 'Dock 이름이 아니라 앱 이름 하나(WP-O)');
  assert.equal(fx.inputs()[0].getAttribute('aria-label'), '앱 이름');
  assert.equal(fx.text("document.getElementById('settingsPersonalizeView').children[3].children[0]"), '워크스페이스 제목화면 왼쪽 위에 보여요');
  assert.equal(fx.text("document.getElementById('settingsPersonalizeView').children[5]"), '이 맥에만 적용돼요 — 다른 사람 앱에는 영향이 없어요(업데이트해도 남아요)저장');
  const preview = fx.find('d-piconimg')[0];
  assert.match(preview.src, /^\/app-icon\.png\?v=\d+$/, '지금 아이콘은 서버가 고른 /app-icon.png');
  assert.equal(fx.button('기본으로 되돌리기').hidden, true, '내 그림이 없으면 되돌릴 것도 없다');
  const file = fx.find('d-piconpv')[0].children.find(kid => kid.type === 'file');
  assert.equal(file.accept, 'image/png,image/jpeg');
  same(fx.inputs().map(one => one.value), ['워크스페이스', '○○의 워크스페이스']);

  // 아무것도 안 바꾸고 저장하면 보내지 않는다
  await fx.button('저장').listeners.click();
  assert.equal(fx.find('d-derr')[0].textContent, '바꾼 것이 없어요');
  assert.equal(fx.posts().length, 0);
});

test('WP-D2 L. 꾸미기 저장: 바뀐 칸만 보내고, 제목은 헤더·탭 제목에 곧바로, 앱 이름이 바뀌면 크롬 앱 안내 한 줄', async () => {
  const fx = personalizeClient({}, [
    { body: { ok: true, title: '새 제목', dockName: '워크스페이스' } },
    { body: { ok: true, title: '새 제목', dockName: '내 일터' } },
  ]);
  fx.app.context.document.title = '';
  await fx.app.run('renderSettingsPersonalize()');
  // 규칙에 안 맞으면 보내지 않는다
  fx.inputs()[0].value = 'a/b';
  await fx.button('저장').listeners.click();
  assert.equal(fx.find('d-derr')[0].textContent, '앱 이름은 1~30자로 적어 주세요 — / : 와 줄바꿈은 쓸 수 없어요');
  fx.inputs()[0].value = '워크스페이스';
  fx.inputs()[1].value = ' ';
  await fx.button('저장').listeners.click();
  assert.equal(fx.find('d-derr')[0].textContent, '워크스페이스 제목은 1~40자로 적어 주세요');
  assert.equal(fx.posts().length, 0);

  fx.inputs()[1].value = '새 제목';
  await fx.button('저장').listeners.click();
  same(fx.posts()[0], { url: '/api/personalize', method: 'POST', body: { title: '새 제목' } });
  assert.equal(fx.app.nodes.get('workspaceTitle').textContent, '새 제목', '서버를 다시 켜지 않고 헤더에 반영');
  assert.equal(fx.app.context.document.title, '새 제목');
  const saved = () => fx.find('d-psaved')[0];
  assert.equal(fx.text("window.findByClass(document.getElementById('settingsPersonalizeView'), 'd-psaved')[0]"), '✓ 바뀌었어요', '제목만 바꾸면 앱 안내는 없다');
  assert.equal(fx.find('d-pinstallnote').length, 0, '제목만 바꾸면 설치한 앱 안내도 없다');
  assert.equal(saved().getAttribute('role'), 'status');

  fx.inputs()[0].value = '내 일터';
  await fx.button('저장').listeners.click();
  same(fx.posts()[1].body, { dockName: '내 일터' });
  assert.equal(fx.text("window.findByClass(document.getElementById('settingsPersonalizeView'), 'd-psaved')[0]"), '✓ 바뀌었어요', '`닫고 다시 열면` 말은 없다');
  // WP-L: 크롬은 manifest를 곧바로 다시 읽지 않는다 — 사실대로 한 줄.
  same(fx.find('d-pinstallnote').map(one => one.textContent), [
    '크롬 앱에는: 크롬을 다시 켜고(주소창에 about://restart) 앱을 열면 오른쪽 위 「앱 업데이트 있음」 → 업데이트 → 앱을 ⌘Q로 끄고 다시 열기',
  ]);
});

// ─────────────────────────────────────────────────────────────────────────────
// WP-M — 꾸미기: 워크스페이스 제목 `화면에 보이기` 스위치(헤더 `#workspaceTitle`만 숨긴다)

test('WP-M 꾸미기: `화면에 보이기` 스위치는 기존 연동 탭 체크박스 부품(.d-ich)을 재사용하고, 기본은 켜짐(보이기)이며, 제목 칸을 안 건드려도 스위치만으로 저장되고 저장 즉시 헤더가 숨는다', async () => {
  const fx = personalizeClient({}, [
    { body: { ok: true, title: '○○의 워크스페이스', dockName: '워크스페이스', titleHidden: true } },
  ]);
  await fx.app.run('renderSettingsPersonalize()');
  const row = () => fx.find('d-ich')[0];
  assert.equal(row().children[0].type, 'checkbox');
  assert.equal(row().children[0].checked, true, '설정에 값이 없으면(옛 설치 포함) 기본은 보이기');
  assert.equal(row().children[0].getAttribute('aria-label'), '워크스페이스 제목 화면에 보이기');
  assert.equal(fx.text("window.findByClass(document.getElementById('settingsPersonalizeView'), 'd-ich')[0]"),
    '화면에 보이기끄면 왼쪽 위 제목만 숨겨요(누르면 바로 보여요 · 저장해야 남아요) — 창 이름에는 그대로 쓰여요');
  assert.equal(fx.app.run("document.getElementById('workspaceTitle').hidden"), false);

  // 스위치만 끄고 제목 칸은 그대로 두어도 `바꾼 것이 없어요`가 아니라 정상 저장된다
  row().children[0].checked = false;
  row().children[0].listeners.change();
  assert.equal(fx.app.nodes.get('workspaceTitle').hidden, true, '누르면 저장 전에도 뒤의 헤더에 바로 미리 보인다');
  fx.app.run('settingsClose()');
  assert.equal(fx.app.nodes.get('workspaceTitle').hidden, false, '저장하지 않고 닫으면 저장된 대로 되돌린다');
  fx.app.nodes.get('workspaceTitle').hidden = true; // 다시 눌러 미리 본 상태에서 저장
  await fx.button('저장').listeners.click();
  same(fx.posts()[0], { url: '/api/personalize', method: 'POST', body: { titleHidden: true } }, '바뀐 칸(스위치)만 보낸다');
  assert.equal(fx.find('d-derr')[0].textContent, '');
  assert.equal(fx.app.nodes.get('workspaceTitle').hidden, true, '새로고침 없이 곧바로 헤더 제목이 숨는다');
  assert.equal(fx.app.context.document.title, '○○의 워크스페이스', '창·탭 이름에는 계속 쓰인다');
});

test('WP-M 꾸미기: 저장된 값이 숨김이면 스위치도 꺼져 있고, 다시 켜서 저장하면 헤더가 즉시 되돌아온다', async () => {
  const fx = personalizeClient({ titleHidden: true }, [
    { body: { ok: true, title: '○○의 워크스페이스', dockName: '워크스페이스', titleHidden: false } },
  ]);
  fx.app.run("document.getElementById('workspaceTitle').hidden = true"); // 새로고침 뒤(GET /api/items 반영) 이미 숨어 있는 상황을 흉내
  await fx.app.run('renderSettingsPersonalize()');
  assert.equal(fx.find('d-ich')[0].children[0].checked, false, '저장된 값이 숨김이면 스위치도 꺼져 있다');

  fx.find('d-ich')[0].children[0].checked = true;
  fx.find('d-ich')[0].children[0].listeners.change();
  await fx.button('저장').listeners.click();
  same(fx.posts()[0], { url: '/api/personalize', method: 'POST', body: { titleHidden: false } });
  assert.equal(fx.app.nodes.get('workspaceTitle').hidden, false, '켜면 원래 제목으로 돌아간다');
});

test('WP-D2 L. 꾸미기 아이콘: 형식·크기는 화면에서 먼저 거르고, 자른 그림은 저장을 눌러야 보내며, 되돌리기는 reset 한 번', async () => {
  const fx = personalizeClient({ customIcon: true }, [
    { body: { ok: true, customIcon: true } },
    { body: { ok: true, customIcon: false } },
  ]);
  fx.app.context.document.getElementById('appFavicon').href = '/app-icon.png';
  await fx.app.run('renderSettingsPersonalize()');
  same(fx.app.run('personalizeCropBox(1200, 800)'), { sx: 200, sy: 0, size: 800 });
  same(fx.app.run('personalizeCropBox(800, 1200)'), { sx: 0, sy: 200, size: 800 });
  // 저장하는 그림은 둥근 모서리(한 변의 22%)까지 깎은 모양이다 — 네 모서리 픽셀은 투명, 가운데·변의 가운데는 그대로
  const alpha = JSON.parse(fx.app.run(`(() => {
    const size = 100, pixels = new Array(size * size * 4).fill(255);
    personalizeRoundCorners(pixels, size);
    const at = (x, y) => pixels[(y * size + x) * 4 + 3];
    return JSON.stringify([at(0, 0), at(99, 0), at(0, 99), at(99, 99), at(5, 5), at(50, 50), at(50, 0), at(0, 50), at(22, 0), at(10, 1)]);
  })()`));
  same(alpha.slice(0, 5), [0, 0, 0, 0, 0], '네 모서리(와 모서리 가까이)는 투명');
  same(alpha.slice(5, 9), [255, 255, 255, 255], '가운데와 변의 가운데는 그대로');
  assert.equal(alpha[9], 0, '모서리 둥근 곡선 바깥(10,1)은 깎인다(22px 반지름)');
  assert.match(fx.app.run('personalizeCrop.toString()'), /personalizeRoundCorners\(pixels\.data, out\)/, '자르기 캔버스가 저장 전에 모서리를 깎는다');
  assert.equal(fx.app.run("personalizeFileError({ type: 'image/gif', size: 10 })"), 'PNG나 JPG 그림만 쓸 수 있어요');
  assert.equal(fx.app.run("personalizeFileError({ type: 'image/png', size: 5 * 1024 * 1024 + 1 })"), '그림은 5MB까지 쓸 수 있어요');
  assert.equal(fx.app.run("personalizeFileError({ type: 'image/jpeg', size: 1000 })"), '');

  const file = () => fx.find('d-piconpv')[0].children.find(kid => kid.type === 'file');
  file().files = [{ type: 'image/png', size: 6 * 1024 * 1024 }];
  await file().listeners.change();
  assert.equal(fx.find('d-derr')[0].textContent, '그림은 5MB까지 쓸 수 있어요');

  // 가운데 자르기는 캔버스가 한다(가짜 창에는 캔버스가 없어 자른 결과만 끼운다)
  fx.app.run("personalizeCrop = async () => ({ canvas: document.createElement('canvas'), data: 'iVBORw0KGgo=' })");
  file().files = [{ type: 'image/png', size: 1000 }];
  await file().listeners.change();
  assert.equal(fx.find('d-piconslot')[0].children[0].getAttribute('aria-label'), '고른 그림(가운데를 정사각형으로 잘랐어요)', '미리보기가 자른 그림으로 바뀐다');
  assert.equal(fx.posts().length, 0, '고르기만 해서는 보내지 않는다');
  await fx.button('저장').listeners.click();
  same(fx.posts()[0], { url: '/api/personalize/icon', method: 'POST', body: { image: 'iVBORw0KGgo=' } });
  assert.match(fx.app.nodes.get('appFavicon').href, /^\/app-icon\.png\?v=\d+$/, '탭 아이콘도 새로 읽는다');
  assert.equal(fx.text("window.findByClass(document.getElementById('settingsPersonalizeView'), 'd-psaved')[0]"), '✓ 바뀌었어요');
  assert.equal(fx.find('d-pinstallnote').length, 1, '아이콘을 바꿔도 크롬 앱 안내 한 줄');

  assert.equal(fx.button('기본으로 되돌리기').hidden, false);
  await fx.button('기본으로 되돌리기').listeners.click();
  same(fx.posts()[1], { url: '/api/personalize/icon', method: 'POST', body: { reset: true } });
});

test('WP-L 꾸미기의 `앱으로 설치` 줄: 설치 창을 줄 수 있게 되면 그 자리에서 버튼으로, 설치된 창에서는 숨는다', async () => {
  const fx = personalizeClient();
  fx.app.context.document.createTextNode = text => ({ textContent: String(text) });
  fx.app.run("window.notices = []; showNotice = (message) => window.notices.push(message)");
  await fx.app.run('renderSettingsPersonalize()');
  const row = () => fx.view().children[0];
  assert.equal(row().hidden, false);
  assert.equal(fx.find('d-installbtn').length, 0);
  let prompted = 0;
  fx.app.context.fakeEvent = { preventDefault() {}, prompt: async () => { prompted += 1; }, userChoice: Promise.resolve({ outcome: 'accepted' }) };
  fx.app.run('appInstallOnPrompt(fakeEvent)');
  const button = fx.find('d-installbtn')[0];
  assert.equal(button.textContent, '설치하기', '다시 그리지 않아도 같은 줄이 버튼으로');
  await button.listeners.click();
  assert.equal(prompted, 1);
  assert.equal(fx.text("document.getElementById('settingsPersonalizeView').children[0].children[1]"), '설치했어요 · 새 창의 아이콘을 Dock에 유지해 주세요');

  const installed = personalizeClient();
  installed.app.run("window.matchMedia = () => ({ matches: true })");
  await installed.app.run('renderSettingsPersonalize()');
  assert.equal(installed.view().children[0].dataset.row, 'app-install');
  assert.equal(installed.view().children[0].hidden, true, '설치된 창에서는 권하지 않는다');
});

test('WP-L 문구: 도움말 `창이 여러 개 떠요`는 앱으로 설치 한 가지 길만(WP-O), 꾸미기 문답은 설치한 앱 반영 시점을 말한다', () => {
  const app = pureClient();
  const trouble = JSON.parse(app.run('JSON.stringify(SELFCHECK_TROUBLE)'));
  const steps = trouble.find(([question]) => question === '창이 여러 개 떠요')[1];
  const flat = step => step[0].map(part => (typeof part === 'string' ? part : part[1])).join('');
  same(steps.map(flat), [
    '설정 › 꾸미기 › 앱으로 설치로 크롬 앱을 설치하면 해결돼요 — 창이 하나로 모이고 Dock·⌘Tab에 아이콘이 따로 떠요',
  ]);
  const faq = JSON.parse(app.run('JSON.stringify(SETTINGS_FAQ)')).flatMap(([, rows]) => rows);
  const answer = faq.find(([question]) => question === '앱 아이콘·이름을 바꾸려면')[2];
  assert.match(answer, /크롬 앱은 크롬을 다시 켠 뒤.*앱 업데이트 있음.*⌘Q/);
  assert.doesNotMatch(answer, /Dock 앱/, '예전 Dock 앱 말은 없다');
});

test('도움말: 개념 사전 9개 + 쓰는 순서의 여섯 묶음 + 항목마다 `필요한 것` 표지', () => {
  const app = pureClient();
  app.context.document.createTextNode = text => ({ textContent: String(text) });
  // `다른 기기에서 열기`는 이 맥에서 열었을 때만 붙는 조각이라 주소도 끼워 넣는다.
  app.context.location = { hostname: 'localhost' };
  const glossary = JSON.parse(app.run('JSON.stringify(SETTINGS_GLOSSARY)'));
  assert.equal(glossary.length, 9);
  assert.deepEqual(glossary.map(row => row[0]),
    ['할 일', '나중에 할 일', '확인 대기', '결정', '아이디어', '프로젝트', '회의 정리', '주간요약', '지난 프로젝트']);
  assert.ok(glossary.every(([, meaning]) => meaning.length <= 60), '사전은 한 문장이다');
  assert.match(glossary[2][1], /답이 오면 체크하고 다음 행동을 골라요/);

  const faq = JSON.parse(app.run('JSON.stringify(SETTINGS_FAQ)'));
  assert.deepEqual(faq.map(([group]) => group),
    ['시작하기', '매일', '프로젝트·지라', '주간요약', '연동·자동화', '문제가 생기면']);
  const entries = faq.flatMap(([, rows]) => rows);
  assert.ok(entries.every(([, need]) => typeof need === 'string' && need.length), '항목마다 `필요한 것`이 있다');
  assert.ok(entries.every(([, , answer]) => answer.length <= 260), '답은 3~4문장을 넘기지 않는다');

  // 사용자 지적 반영: 반응 필요는 지라 연결만 있으면 되고, 피그마 댓글은 가져오지 않는다
  const attention = entries.find(([question]) => question.includes('반응 필요'));
  assert.equal(attention[1], '지라 연결');
  assert.match(attention[2], /지라에 직접 물어봐서 가져와요\(설정 &gt; 연동의 지라 연결만 있으면 됩니다\)\. 슬랙 앱이나 다른 설정은 필요 없어요\./);
  const figma = entries.find(([, , answer]) => answer.includes('피그마'));
  assert.match(figma[2], /피그마 댓글은 여기로 자동으로 오지 않아요/, '피그마는 지라처럼 직접 읽지 않는다');
  assert.match(figma[2], /슬랙 알림을 .*공유하면 슬랙 수집을 거쳐/, '피그마는 슬랙 알림을 채널에 공유하는 길로 들어온다(사용자 확인)');
  assert.ok(!entries.some(([, , answer]) => /피그마 댓글은 다음 단계/.test(answer)), '옛 문구는 남아 있지 않다');

  // 슬랙이 필요한 것과 아무것도 필요 없는 것이 섞여 있어야 표지가 뜻을 갖는다
  const needs = new Set(entries.map(([, need]) => need));
  assert.ok(needs.has('없음') && needs.has('지라 연결') && needs.has('슬랙 연결'));

  // 차례: `문제가 생겼어요`(WP-K 시안 D) → `자주 묻는 것` 머리 + "처음 한 주는 할 일만" → 묶음 여섯(접이식) → `말 뜻`(접이식)
  app.run('renderSettingsGuide()');
  const view = app.nodes.get('settingsGuideView');
  same(view.children.map(kid => kid.className), ['d-faq'], '`다른 기기에서 열기`는 이 맥에서 열어도 도움말에 없다(앱 탭으로 옮겼다)');
  const doc = view.children[0];
  same(doc.children.map(kid => kid.className), ['d-trouble', 'd-faqhd', 'd-faqintro',
    ...faq.map(() => 'd-dsec d-dadd d-faqgrp'), 'd-dsec d-dadd d-wordsfold']);
  assert.equal(doc.children[1].textContent, '자주 묻는 것');
  assert.match(doc.children[2].textContent, /처음 한 주는 할 일만 써도 충분해요/);
  const groups = doc.children.slice(3, 3 + faq.length);
  // 요약은 꺾쇠(마크업 글자 없이 만든 SVG) + 이름 + 개수, 첫 묶음 `시작하기`만 펼친다
  same(groups.map(group => [group.children[0].children[1].textContent, group.children[0].children[2].textContent]),
    faq.map(([name, rows]) => [name, String(rows.length)]));
  same(groups.map(group => !!group.open), faq.map((_, index) => index === 0));
  assert.equal(groups[0].children[0].className, 'lbl');
  assert.equal(groups[0].children[0].children[0].getAttribute('aria-hidden'), 'true');
  // `필요한 것`은 필요한 게 있을 때만 줄이 선다(데이터의 '없음'은 그대로)
  const inner = groups.flatMap(group => group.children[1].children);
  const needLines = inner.filter(kid => kid.className === 'need');
  same(needLines.map(kid => kid.textContent), entries.filter(([, need]) => need !== '없음').map(([, need]) => `필요한 것: ${need}`));
  assert.ok(!needLines.some(kid => /없음$/.test(kid.textContent)), '`필요한 것: 없음` 줄은 없다');
  assert.equal(inner.filter(kid => kid.className === 'q').length, entries.length, '문답은 하나도 빠지지 않는다');
  const words = doc.children[3 + faq.length];
  assert.ok(!words.open, '말 뜻은 접혀 있다');
  same(words.children[0].children.slice(1).map(kid => kid.textContent), ['말 뜻', '· 할 일 · 나중에 할 일 · 확인 대기 외 6개']);
  assert.equal(words.children[1].className, 'd-words');
  assert.equal(words.children[1].children.length, 9);
});

// 최종 QA: 캘린더를 아예 끈 사람에게 `오늘 일정을 가져오지 못했어요`는 고장난 것처럼 읽힌다.
test('오늘 미팅 카드: 캘린더를 껐으면 "켜면 보여요", 켰는데 못 가져왔으면 예전 문구다', () => {
  const app = pureClient();
  const empty = (calendar) => {
    app.run(`workflowData = { items: [], meetings: [] }; renderCalendar(${JSON.stringify(calendar)})`);
    return app.nodes.get('calendarList').children[0].textContent;
  };
  assert.equal(empty({ used: false, events: [], lastSync: null }), '캘린더를 켜면 오늘 일정이 보여요(설정 > 연동).');
  assert.equal(empty({ events: [], lastSync: null }), '오늘 일정을 가져오지 못했어요.', '켜져 있는데 기록이 없으면 못 가져온 것이다');
  assert.equal(empty({ events: [], lastSync: '2026-09-23T09:00:00.000Z', stale: true }), '오늘 일정을 가져오지 못했어요.');
  assert.equal(empty({ events: [], lastSync: '2026-09-23T09:00:00.000Z' }), '오늘은 미팅이 없어요.');
});

// 최종 QA: 새로 설치하면 예시 설정의 값이 그대로 들어 있다 — 그 글자를 입력칸에 채우면
// 자기 주소를 적은 줄 알고 `연결`을 눌러 실패한다.
test('연동 탭 지라 폼은 예시값을 미리 채우지 않는다(예시는 placeholder로만)', async () => {
  const app = settingsClient({
    ok: true,
    jira: { enabled: false, siteUrl: 'https://내회사.atlassian.net', email: '나@내회사.com', hasToken: false },
    slack: { enabled: false, workspaceUrl: '', hasToken: false, channels: { todo: { id: '', name: '' }, align: { id: '', name: '' }, someday: { id: '', name: '' }, waiting: { id: '', name: '' } } },
    calendar: { enabled: false },
    meetingNotes: { mode: 'manual', name: '' },
    claude: true,
    install: 'manual',
  });
  app.run(NODE_SHAPE);
  await app.run('renderSettingsIntegrations()');
  const dump = app.run("JSON.stringify(window.shapeOf(document.getElementById('settingsIntegrationsView')))");
  assert.ok(!dump.includes('내회사'), '예시 주소·이메일은 입력칸에 들어가지 않는다');

  // 사람이 실제로 적어 둔 값은 그대로 다시 보여 준다
  assert.equal(app.run("settingsRealValue('https://회사.atlassian.net')"), 'https://회사.atlassian.net');
  assert.equal(app.run("settingsRealValue('https://내회사.atlassian.net')"), '');
  assert.equal(app.run("settingsRealValue(' 나@내회사.com ')"), '');
  assert.equal(app.run('settingsRealValue(undefined)'), undefined);
});

test('빈 화면 문구는 "무엇이 없다"가 아니라 "여기서 뭘 하면 되는지"를 말한다', () => {
  const app = pureClient();
  const html = app.run("(() => { const box = document.createElement('div'); renderProjectDetail(box, null); return box.html || ''; })()");
  assert.match(html, /위의 \+로 만들거나 업무에 프로젝트를 지정하면 여기 모여요/);
});

// ─────────────────────────────────────────────────────────────────────────────
// WP-D2.5 — 연결된 카드의 새로 받기(⋯ 첫 칸) · 1분 제한 · 막히면 상태 점 + 다시 시도/다시 연결 (2026-09-29 상태 점)

const WPD25_CONNECTED = {
  jira: { enabled: true, siteUrl: 'https://회사.atlassian.net', email: '나@회사.com', displayName: '하늘', hasToken: true, readAt: ago(3), issueCount: 12 },
  slack: {
    enabled: true, hasToken: true, readAt: ago(5),
    channels: { todo: { id: 'C1', name: '#my-todo' }, waiting: { id: '', name: '' }, align: { id: '', name: '' }, someday: { id: '', name: '' } },
  },
  calendar: { enabled: true, source: 'ical', hasIcal: true, live: true, readAt: ago(10), eventCount: 3, failed: false },
  meetingNotes: { mode: 'tiro', name: '' },
};
const wpd25 = (overrides = {}, replies = []) => intgClient({ ...WPD25_CONNECTED, ...overrides }, replies);
// 카드의 지금 상황 줄(`.now`) 글자와, 상태 점 + 말(`.d-istat`)의 tone · 말.
const stText = (fx, index) => fx.shape(`window.findByClass(document.getElementById('settingsIntegrationsView').children[${index}], 'now')[0]`).text;
const statOf = (fx, kind) => [fx.find(kind, 'd-istat')[0].className, fx.shape(`window.findByClass(document.getElementById('settingsIntegrationsView').children.find(one => one.dataset && one.dataset.integration === ${JSON.stringify(kind)}), 'd-istat')[0]`).text];
const fetchButton = (fx, kind) => fx.find(kind, 'd-ifetch')[0];
const fetchCalls = fx => fx.sent.filter(one => one.url === '/api/integrations/fetch');

const menuItem = (fx, kind, label) => fx.menu(kind).flat().find(entry => entry.label === label);

test('새로 받기: 잘 될 때는 버튼 없이 점 + `연결됨`, ⋯ 첫 칸이 `새로 받기`(연결된 카드에만) — 자리는 늘 점 오른쪽 · ⋯ 왼쪽', async () => {
  const none = intgClient();
  await none.app.run('renderSettingsIntegrations()');
  assert.ok(['slack', 'jira', 'calendar', 'notes'].every(kind => !fetchButton(none, kind)), '연결 안 된 카드에는 없다');

  const fx = wpd25();
  await fx.app.run('renderSettingsIntegrations()');
  for (const kind of ['slack', 'jira', 'calendar', 'notes']) {
    same(statOf(fx, kind), ['d-istat k-ok', '연결됨'], `${kind}: 초록 연결됨`);
    const button = fetchButton(fx, kind);
    assert.equal(button.hidden, true, `${kind}: 잘 될 때는 버튼이 없다`);
    const kids = fx.top(kind).children;
    const at = kids.indexOf(button);
    assert.ok(at > kids.findIndex(one => String(one.className).split(' ').includes('d-istat')), '점 오른쪽');
    assert.ok(at < kids.findIndex(one => String(one.className).includes('d-more')), '⋯ 왼쪽');
    assert.equal(fx.menu(kind)[0][0].label, '새로 받기', `${kind}: ⋯ 첫 칸`);
  }
  assert.doesNotMatch(fx.shape("document.getElementById('settingsIntegrationsView')").text, /지금 가져오기/, '`지금 가져오기`는 더 없다');
  assert.equal(fx.toggle('slack').hidden, true, '연결된 카드의 여는 버튼은 여전히 숨어 있다');
  // 회의록(티로)도 연결된 카드라 ⋯(새로 받기 · 최근 기록 · 바꾸기)만 두고, 지금 상황 줄은 마지막으로 가져온 때다
  assert.equal(fx.toggle('notes').hidden, true);
  same(fx.menu('notes').map(section => section.map(entry => entry.label)), [['새로 받기', '바꾸기']], '기록이 없으면 최근 기록 칸은 숨긴다');
  fx.menu('notes')[0][1].onClick();
  assert.ok(fx.find('notes', 'd-seg').length, '바꾸기는 예전 세그먼트를 편다');
  assert.equal(fx.toggle('notes').textContent, '접기');
  assert.match(fx.text('notes'), /회의가 끝나면 회의 탭에서 가져오기/);
  assert.equal(stText(fx, 4), '아직 가져온 적 없어요');
  const ran = wpd25({ meetingNotes: { mode: 'tiro', name: '', fetch: { failing: false, lastRunAt: ago(20) } } });
  await ran.app.run('renderSettingsIntegrations()');
  assert.equal(stText(ran, 4), '20분 전 가져옴');
  // Claude 갈래 캘린더는 자동화 마지막 실행 시각을 붙인다
  const claude = wpd25({ calendar: { enabled: true, source: 'claude', fetch: { failing: false, lastRunAt: ago(7) } } });
  await claude.app.run('renderSettingsIntegrations()');
  assert.equal(stText(claude, 3), 'Claude Code로 읽는 중 · 7분 전');
});

test('새로 받기(즉시형): 지라는 `방금 읽음 · N개`, 캘린더는 `방금 읽음 · 오늘 N개` + 오늘 미팅 다시 그리기, 1분 안에 다시 누르면 부르지 않고 알린다', async () => {
  const fx = wpd25({}, [
    { body: { ok: true, mode: 'done', count: 7, readAt: new Date().toISOString() } },
    { body: { ok: true, mode: 'done', count: 2, readAt: new Date().toISOString() } },
  ]);
  await fx.app.run('renderSettingsIntegrations()');
  fx.app.run('window.loaded = 0; load = async () => { window.loaded += 1; };');
  await menuItem(fx, 'jira', '새로 받기').onClick();
  same(fetchCalls(fx).map(one => one.body), [{ key: 'jira' }]);
  assert.equal(stText(fx, 2), '방금 읽음 · 7개');
  same(statOf(fx, 'jira'), ['d-istat k-ok', '연결됨']);
  assert.equal(fetchButton(fx, 'jira').hidden, true, '잘 읽었으면 버튼은 여전히 없다');
  // 1분 안에 다시 누르면 서버에 묻지 않고 그 말을 한다
  await menuItem(fx, 'jira', '새로 받기').onClick();
  assert.equal(fetchCalls(fx).length, 1);
  assert.match(fx.live(), /방금 가져왔어요 — 1분 뒤에 다시 할 수 있어요/);

  await menuItem(fx, 'calendar', '새로 받기').onClick();
  assert.equal(stText(fx, 3), '방금 읽음 · 오늘 2개');
  assert.equal(fx.app.run('window.loaded'), 1, '오늘 미팅 카드도 한 번 새로 그린다');
  // 다시 그려도 방금 결과는 남고, 1분 제한도 남는다
  await fx.app.run('renderSettingsIntegrations()');
  assert.equal(stText(fx, 2), '방금 읽음 · 7개');
  await menuItem(fx, 'jira', '새로 받기').onClick();
  assert.equal(fetchCalls(fx).length, 2, '다시 그린 뒤에도 1분 안이면 묻지 않는다');
});

test('새로 받기(요청형): 슬랙·티로는 `요청했어요 · 1~2분 뒤 반영돼요`, 서버의 1분 제한·등록 안 됨은 그 말을 알린다', async () => {
  const fx = wpd25({}, [
    { body: { ok: true, mode: 'requested' } },
    { body: { ok: false, reason: 'not-installed', message: '업데이트.command를 한 번 실행하면 쓸 수 있어요' } },
    { body: { ok: false, reason: 'throttled', message: '방금 가져왔어요 — 1분 뒤에 다시 할 수 있어요' } },
  ]);
  await fx.app.run('renderSettingsIntegrations()');
  await menuItem(fx, 'slack', '새로 받기').onClick();
  assert.equal(stText(fx, 1), '요청했어요 · 1~2분 뒤 반영돼요');
  same(statOf(fx, 'slack'), ['d-istat k-ok', '연결됨'], '요청만 남겼으면 점은 그대로');
  same(fetchCalls(fx).map(one => one.body), [{ key: 'slack' }]);

  await menuItem(fx, 'notes', '새로 받기').onClick();
  same(fetchCalls(fx).at(-1).body, { key: 'tiro' });
  assert.match(fx.live(), /업데이트\.command를 한 번 실행하면 쓸 수 있어요/);
  assert.equal(stText(fx, 4), '아직 가져온 적 없어요', '등록이 없으면 지금 상황 줄은 그대로다');

  await menuItem(fx, 'jira', '새로 받기').onClick();
  assert.match(fx.live(), /방금 가져왔어요 — 1분 뒤에 다시 할 수 있어요/);

  // 다시 그려도 요청 표시는 남고, 자동화가 요청 뒤에 돌았으면(lastRunAt) 평소 줄로 돌아간다
  await fx.app.run('renderSettingsIntegrations()');
  assert.equal(stText(fx, 1), '요청했어요 · 1~2분 뒤 반영돼요');
  fx.payload.slack.fetch = { failing: false, auth: false, failedAt: null, lastRunAt: new Date(Date.now() + 5000).toISOString() };
  fx.payload.slack.readAt = new Date().toISOString();
  await fx.app.run('renderSettingsIntegrations()');
  assert.equal(stText(fx, 1), '#my-todo · 방금 읽음');
});

test('한 번 실패는 주황 `늦어요` + `다시 시도`(새로 받기와 같은 길), 토큰 문제는 빨강 `멈췄어요` + `다시 연결`이 그 카드의 위저드를 연다', async () => {
  const fx = wpd25({
    jira: { ...WPD25_CONNECTED.jira, fetch: { failing: true, auth: false, failedAt: ago(10) } },
    slack: { ...WPD25_CONNECTED.slack, fetch: { failing: true, auth: true, failedAt: ago(4) } },
    calendar: { ...WPD25_CONNECTED.calendar, fetch: { failing: true, auth: true, failedAt: ago(30) } },
  }, [{ body: { ok: false, reason: 'failed', message: '지라를 읽지 못했어요 — 잠시 뒤 다시 시도해 주세요' } }]);
  await fx.app.run('renderSettingsIntegrations()');
  assert.equal(stText(fx, 2), '읽지 못했어요 · 10분 전');
  same(statOf(fx, 'jira'), ['d-istat k-late', '늦어요']);
  assert.equal(fx.find('jira', 'd-intgwhy')[0].className, 'd-intgwhy k-warn', '이유 한 줄은 주황 판');
  assert.equal(fetchButton(fx, 'jira').hidden, false);
  assert.equal(fetchButton(fx, 'jira').textContent, '다시 시도');
  assert.equal(fetchButton(fx, 'jira').className, 'd-btn sm d-ifetch');
  await fetchButton(fx, 'jira').listeners.click();
  same(fetchCalls(fx).map(one => one.body), [{ key: 'jira' }], '다시 시도는 같은 길로 다시 읽는다');
  assert.match(fx.live(), /지라를 읽지 못했어요/);
  assert.equal(stText(fx, 2), '읽지 못했어요 · 방금');
  same(statOf(fx, 'jira'), ['d-istat k-late', '늦어요']);

  // 슬랙 토큰 문제 → 멈췄어요 + `다시 연결`은 서버에 묻지 않고 토큰부터 여는 위저드를 편다
  assert.equal(stText(fx, 1), '읽지 못했어요 · 4분 전');
  same(statOf(fx, 'slack'), ['d-istat k-stop', '멈췄어요']);
  assert.equal(fx.find('slack', 'd-intgwhy')[0].className, 'd-intgwhy');
  assert.equal(fetchButton(fx, 'slack').textContent, '다시 연결');
  assert.equal(fetchButton(fx, 'slack').className, 'd-btn sm pri d-ifetch');
  await fetchButton(fx, 'slack').listeners.click();
  assert.equal(fetchCalls(fx).length, 1);
  assert.equal(fx.find('slack', 'd-intgbody')[0].hidden, false);
  assert.equal(fx.find('slack', 'd-din')[0].type, 'password', '토큰 칸부터');
  // 비밀 주소 문제 → 캘린더의 `다시 연결(주소 바꾸기)`
  assert.equal(fetchButton(fx, 'calendar').textContent, '다시 연결');
  await fetchButton(fx, 'calendar').listeners.click();
  same(fx.find('calendar', 'd-ichoice').map(one => one.dataset.choice), ['ical']);
  assert.match(fx.text('calendar'), /비밀 주소를 바꿔 붙여요/);
});

test('계속 실패(서버의 fetch.stuck)는 멈췄어요 — 다시 연결할 위저드가 있으면 `다시 연결` + 이유 줄도 그 말, 없거나 Claude 로그인 풀림이면 `다시 시도`', async () => {
  const stuck = { failing: true, auth: false, stuck: true, failedAt: ago(70), summary: 'my-todo 채널 확인 실패 — fetch 실패 (exit 28)' };
  const fx = wpd25({
    slack: { ...WPD25_CONNECTED.slack, fetch: stuck },
    jira: { ...WPD25_CONNECTED.jira, fetch: { failing: true, auth: false, stuck: true, failedAt: ago(70) } },
    // 한 번 실패(stuck 아님) — 늦어요, 화면은 스스로 세지 않는다(오래됐어도 서버 값이 기준)
    calendar: { enabled: true, source: 'claude', fetch: { failing: true, auth: false, stuck: false, failedAt: ago(300) } },
    // 티로는 다시 연결할 위저드가 없다 — 계속 실패여도 다시 시도
    meetingNotes: { mode: 'tiro', name: '', fetch: { failing: true, auth: false, stuck: true, failedAt: ago(90) } },
  });
  await fx.app.run('renderSettingsIntegrations()');
  same(['slack', 'jira', 'calendar', 'notes'].map(kind => [statOf(fx, kind)[1], fetchButton(fx, kind).textContent]),
    [['멈췄어요', '다시 연결'], ['멈췄어요', '다시 연결'], ['늦어요', '다시 시도'], ['멈췄어요', '다시 시도']]);
  const why = kind => fx.find(kind, 'd-intgwhy')[0].children.map(one => one.textContent).join('');
  assert.equal(why('slack'), '슬랙이 응답하지 않았어요 — 계속 안 돼요. 다시 연결을 눌러 주세요(원래 오류는 ⋯ › 최근 기록)', '버튼이 다시 연결이면 이유 줄도 그 말');
  assert.match(why('jira'), /다시 연결을 눌러 주세요/);
  assert.match(why('calendar'), /다시 시도해도 안 되면 ⋯ › 최근 기록$/, '늦어요는 다시 시도');
  assert.match(why('notes'), /다시 시도해도 안 되면 ⋯ › 최근 기록$/, '다시 연결할 곳이 없으면 다시 시도');
  // 요약은 멈춘 것이 먼저
  assert.equal(fx.shape("document.getElementById('settingsIntegrationsView').children[0]").text, '3개가 멈췄어요연결됨 4 · 남은 것 0');

  // Claude Code 로그인 풀림이면 토큰을 다시 넣어도 소용없다 — 계속 실패여도 다시 시도
  const login = wpd25({ slack: { ...WPD25_CONNECTED.slack, fetch: { failing: true, auth: false, claudeAuth: true, stuck: true, failedAt: ago(90) } } });
  await login.app.run('renderSettingsIntegrations()');
  same(statOf(login, 'slack'), ['d-istat k-stop', '멈췄어요']);
  assert.equal(fetchButton(login, 'slack').textContent, '다시 시도');

  // 빨간 점을 누르고 들어오면 멈춘 카드만 붉힌다(한 번 실패한 캘린더는 아니다)
  fx.app.run("settingsFocusKey = 'alerts'");
  await fx.app.run('renderSettingsIntegrations()');
  same(['slack', 'jira', 'calendar', 'notes'].map(kind => /\bis-flash\b/.test(fx.card(kind).className)), [true, true, false, true]);
});

test('누른 결과가 토큰 문제면 그 자리에서 멈췄어요 + `다시 연결`로 바뀐다(Claude 갈래 캘린더는 다시 시도만)', async () => {
  const fx = wpd25({ calendar: { enabled: true, source: 'claude', fetch: { failing: true, auth: false, failedAt: ago(2) } } }, [
    { body: { ok: false, reason: 'auth', message: '지라 토큰이 만료됐거나 권한이 없어요 — 다시 연결해 주세요' } },
  ]);
  await fx.app.run('renderSettingsIntegrations()');
  assert.equal(fetchButton(fx, 'calendar').textContent, '다시 시도', 'Claude 갈래는 다시 연결할 위저드가 없다');
  await menuItem(fx, 'jira', '새로 받기').onClick();
  same(statOf(fx, 'jira'), ['d-istat k-stop', '멈췄어요']);
  assert.equal(stText(fx, 2), '읽지 못했어요 · 방금');
  assert.equal(fetchButton(fx, 'jira').hidden, false);
  assert.equal(fetchButton(fx, 'jira').textContent, '다시 연결');
  assert.match(fx.live(), /다시 연결해 주세요/);
  await fetchButton(fx, 'jira').listeners.click();
  assert.equal(fetchCalls(fx).length, 1, '다시 연결은 서버에 묻지 않는다');
  assert.equal(fx.find('jira', 'd-intgbody')[0].hidden, false, '지라 위저드가 열린다');
});

test('상태 점 다섯 가지: 카드 넷 모두 같은 부품(점은 읽히지 않고 말이 읽힌다), 첫 읽기 전은 `연결됨 · 곧 읽어요`, 직접 옮기기는 초록 `직접 옮기기`에 버튼 `바꾸기`', async () => {
  const fx = wpd25();
  fx.payload.sync = {
    slackSync: { used: true, connected: true, stale: false, neverRead: true, scheduled: true },
    jiraSync: { used: true, connected: true, stale: false, lastSync: new Date().toISOString().slice(0, 10) },
    calendar: { used: true, connected: true, stale: false, lastSync: new Date().toISOString().slice(0, 10) },
  };
  await fx.app.run('renderSettingsIntegrations()');
  same(statOf(fx, 'slack'), ['d-istat k-soon', '연결됨 · 곧 읽어요']);
  assert.equal(fetchButton(fx, 'slack').hidden, true, '첫 읽기 전에도 버튼은 없다');
  const dot = fx.find('slack', 'd-istat')[0].children[0];
  assert.equal(dot.className, 'dot');
  assert.equal(dot.getAttribute('aria-hidden'), 'true', '점은 장식');
  assert.equal(fx.shape("document.getElementById('settingsIntegrationsView').children[0]").text, '4개 연결됨 · 슬랙은 곧 읽어요연결됨 4 · 남은 것 0');
  // 같은 부품 — 카드 넷의 오른쪽 묶음 맨 앞이 상태 점이다
  assert.ok(['slack', 'jira', 'calendar', 'notes'].every(kind => String(fx.top(kind).children[0].className).startsWith('d-istat')));

  const manual = intgClient();
  await manual.app.run('renderSettingsIntegrations()');
  same(statOf(manual, 'notes'), ['d-istat k-ok', '직접 옮기기']);
  assert.equal(manual.toggle('notes').hidden, false);
  assert.equal(manual.toggle('notes').textContent, '바꾸기');
  assert.ok(!fetchButton(manual, 'notes'), '직접 옮기기에는 다시 시도·다시 연결이 없다');
  assert.equal(manual.find('notes', 'd-more').length, 0);
  // 연결 안 됨 — 빈 원, 말 없음, 옆에 연결하기
  same(statOf(manual, 'jira'), ['d-istat k-off', '']);
  assert.equal(manual.toggle('jira').textContent, '연결하기');

  // 화면 규칙: 같은 10px 점, 움직임 줄이기면 숨 쉬지 않고, 좁으면 오른쪽 묶음이 한 줄로 내려와 말은 말줄임
  const css = fs.readFileSync(path.join(__dirname, 'ui.css'), 'utf8');
  assert.match(css, /\.d-istat \.dot \{ width: 10px; height: 10px; border-radius: 50%; flex: none; \}/);
  assert.match(css, /@media \(prefers-reduced-motion: no-preference\) \{\n  \.d-istat\.k-soon \.dot \{ animation: d-ibreathe/);
  assert.match(css, /\.d-istat \.w \{ min-width: 0; overflow: hidden; text-overflow: ellipsis; \}/);
  assert.match(css, /\.d-istat \{[^}]*white-space: nowrap;/);
  assert.match(css, /\.d-intg > \.d-intgside \{ grid-column: 1; grid-row: auto; justify-self: stretch;/);
  // 어두운 모드에도 점 색이 따로 있다(밝은 초록·주황·빨강 — 어두운 면 위에서 3:1 이상)
  assert.equal((css.match(/--success-dot: #4fd08e; --warn-dot: #ffa940; --urgent-dot: #ff6b6f; --idle-ring: #5b6472;/g) || []).length, 2);
});

test('카드 넷 × 다섯 상태: 점 종류 · 말 · 버튼이 규칙대로(연결 안 됨 → 연결하기 · 곧 읽어요/연결됨 → 버튼 없음 · 늦어요 → 다시 시도 · 멈췄어요 → 다시 연결/다시 시도)', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const fresh = { used: true, connected: true, stale: false, lastSync: today };
  const syncOf = key => ({
    slackSync: key === 'slack' ? { used: true, connected: true, stale: true, lastSync: null, neverRead: true, scheduled: true } : fresh,
    jiraSync: key === 'jira' ? { used: true, connected: true, stale: false, neverRead: true } : fresh,
    calendar: key === 'calendar' ? { used: true, connected: true, stale: false, lastSync: today, neverRead: true } : fresh,
  });
  const failOnce = { failing: true, auth: false, failedAt: ago(4) };
  const failAuth = { failing: true, auth: true, failedAt: ago(4) };
  const failLong = { failing: true, auth: false, stuck: true, failedAt: ago(90) };
  const connectedWith = (kind, fetch) => ({
    slack: kind === 'slack' ? { ...WPD25_CONNECTED.slack, fetch } : WPD25_CONNECTED.slack,
    jira: kind === 'jira' ? { ...WPD25_CONNECTED.jira, fetch } : WPD25_CONNECTED.jira,
    calendar: kind === 'calendar' ? { ...WPD25_CONNECTED.calendar, fetch } : WPD25_CONNECTED.calendar,
    meetingNotes: kind === 'notes' ? { ...WPD25_CONNECTED.meetingNotes, fetch } : WPD25_CONNECTED.meetingNotes,
  });
  const look = async (state, kind, sync = null) => {
    const fx = intgClient(state);
    if (sync) fx.payload.sync = sync;
    await fx.app.run('renderSettingsIntegrations()');
    const button = fetchButton(fx, kind);
    const shown = button && !button.hidden ? button.textContent : (fx.toggle(kind).hidden ? '' : fx.toggle(kind).textContent);
    return [...statOf(fx, kind), shown, fx.find(kind, 'd-more').length ? '⋯' : ''];
  };
  const off = { meetingNotes: { mode: 'other', name: '노션' } };
  for (const kind of ['slack', 'jira', 'calendar', 'notes']) {
    same(await look(off, kind), ['d-istat k-off', '', kind === 'notes' ? '바꾸기' : '연결하기', ''], `${kind} 연결 안 됨`);
    same(await look(WPD25_CONNECTED, kind), ['d-istat k-ok', '연결됨', '', '⋯'], `${kind} 연결됨`);
    if (kind !== 'notes') same(await look(WPD25_CONNECTED, kind, syncOf(kind)), ['d-istat k-soon', '연결됨 · 곧 읽어요', '', '⋯'], `${kind} 첫 읽기 전`);
    same(await look(connectedWith(kind, failOnce), kind), ['d-istat k-late', '늦어요', '다시 시도', '⋯'], `${kind} 한 번 실패`);
    // 다시 연결할 위저드가 없는 회의록(티로)은 계속 실패여도 다시 시도
    same(await look(connectedWith(kind, failLong), kind), ['d-istat k-stop', '멈췄어요', kind === 'notes' ? '다시 시도' : '다시 연결', '⋯'], `${kind} 계속 실패`);
    if (kind !== 'notes') same(await look(connectedWith(kind, failAuth), kind), ['d-istat k-stop', '멈췄어요', '다시 연결', '⋯'], `${kind} 토큰 문제`);
  }
  // 회의록 직접 옮기기 — 초록 `직접 옮기기`, 다시 시도·다시 연결·⋯ 없이 `바꾸기`만
  same(await look({}, 'notes'), ['d-istat k-ok', '직접 옮기기', '바꾸기', '']);
});

test('WP-D2.5 도움말: `지금 바로 새로 가져오고 싶어요` 문답이 있다', () => {
  const app = pureClient();
  const faq = JSON.parse(app.run('JSON.stringify(SETTINGS_FAQ)'));
  const found = faq.flatMap(([, rows]) => rows).find(([question]) => question === '지금 바로 새로 가져오고 싶어요');
  assert.ok(found);
  assert.match(found[2], /⋯ › 새로 받기/);
  assert.doesNotMatch(found[2], /지금 가져오기/);
  assert.match(found[2], /1분에 한 번/);
  assert.match(found[2], /다시 연결/);
  const login = faq.flatMap(([, rows]) => rows).find(([question]) => question === 'Claude Code 로그인이 풀렸다고 나와요');
  assert.ok(login, 'Claude 로그인 풀림 문답도 있다');
  assert.match(login[2], /claude setup-token/, '터미널에는 이 명령 하나');
  assert.match(login[2], /카드의 칸에 붙여 <b>저장<\/b>/, '토큰은 앱 칸에 붙인다');
  assert.doesNotMatch(login[2], /read -s|printf|~\/\.config|docs\/연동\.md/, '터미널 긴 명령·파일 경로 안내는 없다');
});

// ─────────────────────────────────────────────────────────────────────────────
// WP-D3 — 설정 › 상태의 `업데이트 받기`(시안 J): 새 버전 줄 · 진행 목록 · 다시 켜는 중 · 성공/실패 · 되돌리기 확인 줄

// 상태 읽기(`/api/update/status`)는 `status()`가 그때그때 주는 값(없으면 서버가 꺼진 것처럼 실패),
// `POST /api/update`는 꽂아 둔 답을 차례로 쓴다. 타이머는 모아 두기만 한다 — 묻기는 테스트가 직접 부른다.
function updateClient(about, { status = () => ({ ok: true, status: null, pending: null, running: false, updateFile: '~/workspace/업데이트.command' }), replies = [] } = {}) {
  const app = settingsClient({});
  const sent = [];
  const copied = [];
  const state = { status };
  app.context.navigator = { clipboard: { writeText: async (text) => { copied.push(text); } }, platform: 'MacIntel' };
  app.context.setTimeout = () => 0;
  app.context.clearTimeout = () => {};
  app.context.fetch = async (url, options = {}) => {
    sent.push({ url: String(url), body: options.body ? JSON.parse(options.body) : null });
    if (String(url) === '/api/update/status') {
      const body = state.status();
      if (!body) throw new Error('서버가 꺼져 있다');
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    const next = replies.shift() || { body: { ok: true } };
    return new Response(JSON.stringify(next.body), { status: next.status || 200, headers: { 'Content-Type': 'application/json' } });
  };
  app.run(NODE_SHAPE);
  app.run(`window.findByClass = (node, cls) => {
    const hits = [];
    const walk = (one) => { if (one && String(one.className || '').split(' ').includes(cls)) hits.push(one); ((one && one.children) || []).forEach(walk); };
    walk(node);
    return hits;
  };`);
  app.run(`settingsAbout = ${JSON.stringify(about)}; settingsUpdateStop();`);
  const box = () => app.nodes.get('settingsAboutUpdate');
  const text = () => JSON.parse(app.run("JSON.stringify(window.shapeOf(document.getElementById('settingsAboutUpdate')))")).text;
  const find = cls => app.run(`window.findByClass(document.getElementById('settingsAboutUpdate'), ${JSON.stringify(cls)})`);
  const button = label => find('d-btn').concat(find('d-ablink')).find(one => one.textContent === label);
  const steps = () => JSON.parse(app.run(`JSON.stringify(window.findByClass(document.getElementById('settingsAboutUpdate'), 'd-abprog')[0].children.map(li => [li.className, li.children[0].textContent, li.children[1].textContent]))`));
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const poll = async () => { await app.run('settingsUpdatePoll()'); await flush(); };
  return { app, sent, copied, state, box, text, find, button, steps, flush, poll };
}
const D3_ABOUT = {
  version: '1.0.0', install: 'managed', channel: 'stable', modified: [], latest: { tag: 'v1.1.0' },
  update: { available: true, label: 'v1.1.0', changesUrl: 'https://github.com/someone/workspace/releases' },
  updateFile: '~/workspace/업데이트.command',
};
const D3_NAMES = ['고친 파일 확인', '데이터 백업', '새 버전 받기', '데이터 형식 변환', '앱 다시 시작', '잘 떴는지 확인'];
const d3Status = (state, step, extra = {}) => ({
  ok: true, running: state === 'running', pending: null, updateFile: '~/workspace/업데이트.command',
  status: {
    action: 'update', from: '1.0.0', to: '1.1.0', step, state, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    steps: D3_NAMES.map((name, index) => ({ name, state: index + 1 < step ? 'done' : (index + 1 === step ? (state === 'failed' ? 'failed' : (state === 'done' ? 'done' : 'doing')) : 'todo') })),
    ...extra,
  },
});

test('WP-D3/WP-J 새 버전 줄: `새 버전 v1.1.0이 있어요` + (있으면) 원격 소식 줄 + 업데이트 받기 + 지난 소식 전체 + 조용한 줄, 없으면 비운다', async () => {
  const fx = updateClient(D3_ABOUT);
  fx.app.run('settingsAboutFill()');
  await fx.flush();
  assert.equal(fx.app.nodes.get('settingsAboutLine').children.map(one => one.textContent).join(''), 'v1.0.0 · 배포된 버전만 받기', '설치본은 기본이라 말하지 않는다');
  // 개발용(저장소에서 직접 띄운 것)·main 갈래는 그 말을 붙인다
  const dev = updateClient({ ...D3_ABOUT, install: 'manual', channel: 'main', update: { available: false } });
  dev.app.run('settingsAboutFill()');
  assert.equal(dev.app.nodes.get('settingsAboutLine').children.map(one => one.textContent).join(''), 'v1.0.0 · 만드는 중인 것까지 받기(main) · 개발용');
  assert.equal(fx.box().hidden, false);
  // `무엇이 바뀌었나요 ↗`(원격 링크)는 `지난 소식 전체`(내부 접이식을 여는 버튼)로 대체됐다(WP-J).
  assert.equal(fx.text(), '새 버전 v1.1.0이 있어요업데이트 받기지난 소식 전체데이터는 먼저 백업하고 받아요. 1분쯤 걸려요.');
  assert.equal(fx.button('업데이트 받기').className, 'd-btn sm pri', '주 버튼');
  assert.equal(fx.button('무엇이 바뀌었나요 ↗'), undefined, 'github 바깥 링크는 더 이상 두지 않는다');
  const openHistory = fx.button('지난 소식 전체');
  assert.equal(openHistory.className, 'd-ablink');
  assert.ok(fx.sent.some(one => one.url === '/api/update/status'), '열 때 도는 업데이트가 있는지 한 번 묻는다');
  // 누르면 버전 줄 아래 접이식(`settingsAboutHistory`)을 편다.
  fx.app.nodes.set('settingsAboutHistory', { open: false });
  openHistory.listeners.click();
  assert.equal(fx.app.nodes.get('settingsAboutHistory').open, true);

  // 원격의 그 태그에서 읽은 소식 줄(WP-J)이 있으면 상자 안에 굵게 포함 목록으로 선다.
  const withNews = updateClient({ ...D3_ABOUT, update: { ...D3_ABOUT.update, news: ['새 소식 한 줄', '**굵은** 소식 줄'] } });
  withNews.app.run('settingsAboutFill()');
  assert.equal(withNews.text(), '새 버전 v1.1.0이 있어요새 소식 한 줄굵은 소식 줄업데이트 받기지난 소식 전체데이터는 먼저 백업하고 받아요. 1분쯤 걸려요.');
  const list = withNews.find('d-newslist')[0];
  assert.equal(list.children[1].children[0].textContent, '굵은', '굵게는 <b> 요소다');

  // main 갈래 · 못 읽었으면(news 없음) 줄이 없을 뿐 상자는 그대로다
  const main = updateClient({ ...D3_ABOUT, channel: 'main', update: { available: true, label: 'main', changesUrl: null } });
  main.app.run('settingsAboutFill()');
  assert.match(main.text(), /^새 버전이 있어요 \(main\)업데이트 받기지난 소식 전체데이터는/);

  // 새 버전이 없으면 `새 버전 확인` 버튼 하나만(배포 직후 주기를 기다리지 않게 지금 물어본다)
  const none = updateClient({ ...D3_ABOUT, update: { available: false, label: 'v1.0.0', changesUrl: null } });
  none.app.run('settingsAboutFill()');
  assert.equal(none.box().hidden, false);
  assert.equal(none.text(), '새 버전 확인');
  assert.equal(none.app.run('settingsHasUpdate()'), false);

  // 옛 서버(update 칸 없음)는 태그로 견준다
  const old = updateClient({ version: '1.0.0', install: 'managed', latest: { tag: 'v1.2.0' } });
  assert.equal(old.app.run('settingsHasUpdate()'), true);
  old.app.run('settingsAboutFill()');
  assert.match(old.text(), /^새 버전 v1\.2\.0이 있어요업데이트 받기지난 소식 전체데이터는/);
});

test('WP-D3 진행 목록: 누르면 요청하고 ✓/⟳/· 목록을 그리며, 앱이 다시 켜지는 동안은 `다시 켜는 중…`, 끝나면 `v1.1.0으로 바꿨어요` + 새로고침', async () => {
  const fx = updateClient(D3_ABOUT);
  fx.app.run('settingsAboutFill()');
  await fx.flush();
  fx.button('업데이트 받기').listeners.click();
  await fx.flush();
  const post = fx.sent.find(one => one.url === '/api/update');
  assert.deepEqual(post.body, { action: 'update' });
  assert.match(fx.text(), /^v1\.0\.0 → v1\.1\.0/);
  same(fx.steps(), D3_NAMES.map((name, index) => (index === 0 ? ['now', '⟳', name] : ['wait', '·', name])), '요청만 한 참에는 첫 단계를 도는 중');

  fx.state.status = () => d3Status('running', 5);
  await fx.poll();
  same(fx.steps().map(([cls, mark]) => `${cls}${mark}`), ['done✓', 'done✓', 'done✓', 'done✓', 'now⟳', 'wait·']);
  assert.doesNotMatch(fx.text(), /다시 켜는 중/);

  // 5단계 — 서버가 잠깐 없다
  fx.state.status = () => null;
  await fx.poll();
  assert.match(fx.text(), /⟳앱 다시 시작·잘 떴는지 확인다시 켜는 중…$/, '목록은 그대로, 그 아래 한 줄');
  same(fx.steps().map(([cls]) => cls), ['done', 'done', 'done', 'done', 'now', 'wait']);

  // 다시 응답 → 상태 파일로 마무리
  fx.state.status = () => d3Status('done', 6);
  await fx.poll();
  assert.equal(fx.text(), 'v1.1.0으로 바꿨어요새로고침');
  assert.equal(fx.button('새로고침').className, 'd-btn sm pri');
  assert.equal(fx.app.run('settingsUpdateRun'), null, '끝나면 더 묻지 않는다');
});

test('WP-D3 방금 요청했는데 읽힌 옛 상태 파일(지난 실행의 done)은 이번 것으로 보지 않는다', async () => {
  const fx = updateClient(D3_ABOUT);
  fx.app.run('settingsAboutFill()');
  fx.button('업데이트 받기').listeners.click();
  await fx.flush();
  fx.state.status = () => d3Status('done', 6, { startedAt: new Date(Date.now() - 3600000).toISOString() });
  await fx.poll();
  assert.match(fx.text(), /^v1\.0\.0 → v1\.1\.0/, '아직 진행 목록');
  assert.notEqual(fx.app.run('settingsUpdateRun'), null);
});

test('WP-D3 실패: 빨간 한 줄 + `이전 버전으로 되돌리기` → 확인 줄 한 번 → 되돌리기 요청과 네 단계 진행', async () => {
  const fx = updateClient(D3_ABOUT);
  fx.app.run('settingsAboutFill()');
  fx.button('업데이트 받기').listeners.click();
  await fx.flush();
  fx.state.status = () => d3Status('failed', 6, { message: '앱이 응답하지 않아요' });
  await fx.poll();
  assert.equal(fx.text(), '업데이트하지 못했어요 — 앱이 응답하지 않아요이전 버전으로 되돌리기');
  assert.equal(fx.find('d-abfail').length, 1);
  assert.equal(fx.button('이전 버전으로 되돌리기').className, 'd-btn sm dng');
  assert.equal(fx.sent.filter(one => one.url === '/api/update').length, 1, '스스로 되돌리지 않는다');

  fx.button('이전 버전으로 되돌리기').listeners.click();
  assert.equal(fx.text(), '업데이트하지 못했어요 — 앱이 응답하지 않아요이전 버전과 업데이트 직전 백업으로 돌아가요취소되돌리기');
  assert.equal(fx.button('되돌리기').focused, true, '확인 줄이 서면 초점은 되돌리기로');
  fx.button('취소').listeners.click();
  assert.equal(fx.text(), '업데이트하지 못했어요 — 앱이 응답하지 않아요이전 버전으로 되돌리기', '취소하면 그대로');

  fx.button('이전 버전으로 되돌리기').listeners.click();
  fx.button('되돌리기').listeners.click();
  await fx.flush();
  assert.deepEqual(fx.sent.filter(one => one.url === '/api/update').map(one => one.body), [{ action: 'update' }, { action: 'rollback' }]);
  assert.match(fx.text(), /^이전 버전으로 되돌리는 중이에요/);
  same(fx.steps().map(([, , name]) => name), ['코드 되돌리기', '데이터 되돌리기', '앱 다시 시작', '잘 떴는지 확인']);

  // 되돌리기도 실패하면 업데이트.command로(경로 복사)
  fx.state.status = () => ({ ok: true, running: false, updateFile: '~/workspace/업데이트.command',
    status: { action: 'rollback', state: 'failed', message: '되돌릴 자리를 찾지 못했어요', startedAt: new Date().toISOString(), steps: [] } });
  await fx.poll();
  assert.equal(fx.text(), '되돌리지 못했어요 — 되돌릴 자리를 찾지 못했어요업데이트.command를 더블클릭해 주세요~/workspace/업데이트.command복사');
  assert.equal(fx.button('이전 버전으로 되돌리기'), undefined);

  // 되돌리기가 끝나면 그 버전으로
  const back = updateClient(D3_ABOUT);
  back.app.run("settingsUpdateFollow('rollback', null, 0)");
  back.state.status = () => ({ ok: true, running: false, status: { action: 'rollback', from: '1.1.0', to: '1.0.0', state: 'done', startedAt: new Date().toISOString(), steps: [] } });
  await back.poll();
  assert.equal(back.text(), 'v1.0.0으로 되돌렸어요새로고침');
});

test('QA 되돌리기 기준점: ①② 단계(또는 실행기가 시작 전)에서 멈추면 되돌리기 대신 `앱과 데이터는 그대로예요` + 다시 시도(같은 update 요청)', async () => {
  for (const [step, message] of [[1, '고친 내용을 보관하지 못해 멈췄어요'], [2, '백업 폴더를 만들지 못했어요'], [0, '업데이트를 끝내지 못했어요 — 업데이트.command를 더블클릭해 주세요']]) {
    const fx = updateClient(D3_ABOUT);
    fx.app.run('settingsAboutFill()');
    fx.button('업데이트 받기').listeners.click();
    await fx.flush();
    fx.state.status = () => d3Status('failed', step, { message });
    await fx.poll();
    assert.equal(fx.text(), `업데이트하지 못했어요 — 앱과 데이터는 그대로예요다시 시도${message}`, `${step}단계`);
    assert.equal(fx.find('d-abfail').length, 1);
    assert.equal(fx.button('이전 버전으로 되돌리기'), undefined, '되돌릴 것이 없으니 보이지 않는다');
    assert.equal(fx.button('다시 시도').className, 'd-btn sm pri');
    fx.button('다시 시도').listeners.click();
    await fx.flush();
    assert.deepEqual(fx.sent.filter(one => one.url === '/api/update').map(one => one.body), [{ action: 'update' }, { action: 'update' }]);
    assert.match(fx.text(), /^v1\.0\.0 → v1\.1\.0/, '다시 진행 목록');
  }
  // ③ 이후면 지금처럼 되돌리기
  const late = updateClient(D3_ABOUT);
  late.app.run("settingsUpdateFollow('update', null, 0)");
  late.state.status = () => d3Status('failed', 3, { message: '새 버전을 받아오지 못했어요 — 인터넷 연결을 확인해 주세요.' });
  await late.poll();
  assert.equal(late.text(), '업데이트하지 못했어요 — 새 버전을 받아오지 못했어요 — 인터넷 연결을 확인해 주세요.이전 버전으로 되돌리기');

  // 서버가 되돌릴 것이 없다고 하면 그 한 줄(경로 줄 없이)
  const none = updateClient(D3_ABOUT, { replies: [{ body: { ok: false, reason: 'nothing-to-undo', message: '되돌릴 것이 없어요 — 앱과 데이터는 그대로예요' } }] });
  none.app.run("settingsUpdateAsk('rollback')");
  await none.flush();
  assert.equal(none.text(), '되돌릴 것이 없어요 — 앱과 데이터는 그대로예요');
});

test('WP-D3 3분 넘게 응답이 없으면 `앱이 응답하지 않아요 — 업데이트.command를 더블클릭해 주세요` + 경로 복사', async () => {
  const fx = updateClient(D3_ABOUT);
  fx.app.run("settingsUpdateFollow('update', null, Date.now())");
  fx.state.status = () => null;
  await fx.poll();
  assert.match(fx.text(), /다시 켜는 중…$/);
  fx.app.run('settingsUpdateRun.downSince = Date.now() - 181000');
  await fx.poll();
  assert.equal(fx.text(), '앱이 응답하지 않아요 — 업데이트.command를 더블클릭해 주세요~/workspace/업데이트.command복사');
  fx.button('복사').listeners.click();
  await fx.flush();
  same(fx.copied, ['~/workspace/업데이트.command']);
  assert.equal(fx.app.run('settingsUpdateRun'), null);

  // 요청은 받았는데 3분이 지나도 실행기가 시작하지 않은 경우도 같은 안내
  const stuck = updateClient(D3_ABOUT);
  stuck.app.run(`settingsUpdateFollow('update', null, Date.now() - 181000)`);
  await stuck.poll();
  assert.match(stuck.text(), /^앱이 응답하지 않아요 — 업데이트\.command를 더블클릭해 주세요/);
});

test('WP-D3 막는 문구 셋: 폴더 이동 필요 · 처음 한 번 · 이미 진행 중(그 진행 목록)', async () => {
  const relocate = updateClient(D3_ABOUT, { replies: [{ body: { ok: false, reason: 'relocate', message: '폴더를 옮겨야 하는 업데이트예요 — 업데이트.command를 더블클릭해 주세요', updateFile: '~/playio/workspace/업데이트.command' } }] });
  relocate.app.run('settingsAboutFill()');
  relocate.button('업데이트 받기').listeners.click();
  await relocate.flush();
  assert.equal(relocate.text(), '폴더를 옮겨야 하는 업데이트예요 — 업데이트.command를 더블클릭해 주세요~/playio/workspace/업데이트.command복사');
  assert.equal(relocate.app.run('settingsUpdateRun'), null, '진행을 따라가지 않는다');

  const first = updateClient(D3_ABOUT, { replies: [{ body: { ok: false, reason: 'not-installed', message: '처음 한 번은 업데이트.command로 받아 주세요', updateFile: '~/workspace/업데이트.command' } }] });
  first.app.run('settingsAboutFill()');
  first.button('업데이트 받기').listeners.click();
  await first.flush();
  assert.equal(first.text(), '처음 한 번은 업데이트.command로 받아 주세요~/workspace/업데이트.command복사');

  const busy = updateClient(D3_ABOUT, { replies: [{ body: { ...d3Status('running', 3), ok: false, reason: 'running', message: '이미 업데이트하는 중이에요' } }] });
  busy.app.run('settingsAboutFill()');
  busy.button('업데이트 받기').listeners.click();
  await busy.flush();
  assert.match(busy.text(), /^v1\.0\.0 → v1\.1\.0/);
  same(busy.steps().map(([cls]) => cls), ['done', 'done', 'now', 'wait', 'wait', 'wait'], '도는 진행을 그대로 보여 준다');

  // 상태 탭을 다시 열었을 때 도는 업데이트가 있으면 이어 보여 준다
  const reopen = updateClient(D3_ABOUT, { status: () => d3Status('running', 4) });
  reopen.app.run('settingsAboutFill()');
  await reopen.flush();
  await reopen.flush();
  same(reopen.steps().map(([cls]) => cls), ['done', 'done', 'done', 'now', 'wait', 'wait']);
});

// ─────────────────────────────────────────────────────────────────────────────
// WP-E — 설정 합치기(연동이 유일한 상태 자리 · 앱 탭) · 슬랙 채널 고르기(더하기·빼기) · 매일 백업 줄

test('WP-E 탭: 연동 · 앱 · 꾸미기 · 도움말 · 삭제한 항목 차례, 처음 열면 연동이고 옛 `상태` 탭은 없다', async () => {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const tabs = [...html.matchAll(/data-settings-tab="(\w+)" aria-pressed="(true|false)"[^>]*>([^<]+)</g)].map(m => [m[1], m[2], m[3]]);
  same(tabs, [['integrations', 'true', '연동'], ['app', 'false', '앱'], ['personalize', 'false', '꾸미기'], ['guide', 'false', '도움말'], ['trash', 'false', '삭제한 항목']]);
  assert.ok(!html.includes('settingsStatusView'), '상태 보기 자리는 없앴다');
  assert.match(html, /<div id="settingsIntegrationsView"><\/div>\s*<div id="settingsAppView" hidden><\/div>/, '처음 보이는 것은 연동');

  const fx = intgClient();
  fx.app.run(`settingsDialog.showModal = () => { settingsDialog.open = true; };
    renderSettingsIntegrations = async () => {}; renderSettingsApp = async () => {}; settingsAboutLoad = async () => null;`);
  fx.app.run('settingsOpen()');
  assert.equal(fx.app.nodes.get('settingsIntegrationsView').hidden, false, '인자 없이 열면 연동');
  assert.equal(fx.app.nodes.get('settingsAppView').hidden, true);
  assert.equal(fx.app.run("settingsSetTab('status')"), 'integrations', '옛 딥링크(`status`)는 연동으로 연다');
  assert.equal(fx.app.run("settingsSetTab('app')"), 'app');
  assert.equal(fx.app.nodes.get('settingsAppView').hidden, false);
  assert.equal(fx.app.run('typeof renderAutomationStatus'), 'undefined', '상태 탭 그리기는 없앴다');
});

test('WP-E A·B. 맨 위 요약(카드와 같은 점·말): 정상이면 `N개 연결됨`, 한 번 실패는 `N개가 늦어요`, 토큰 문제·계속 실패는 `N개가 멈췄어요` + 그 카드에 이유 한 줄', async () => {
  const ok = wpd25();
  await ok.app.run('renderSettingsIntegrations()');
  const head = fx => fx.view().children[0];
  assert.equal(ok.shape("document.getElementById('settingsIntegrationsView').children[0]").text, '4개 연결됨연결됨 4 · 남은 것 0');
  assert.equal(head(ok).children[0].className, 'd-istat k-ok');
  assert.equal(head(ok).children[0].children[0].className, 'dot', '카드와 같은 점');

  const bad = wpd25({
    slack: { ...WPD25_CONNECTED.slack, fetch: { failing: true, auth: false, failedAt: ago(12), summary: 'my-todo 채널 확인 실패 — fetch 실패 (exit 28)' } },
  });
  await bad.app.run('renderSettingsIntegrations()');
  assert.equal(bad.shape("document.getElementById('settingsIntegrationsView').children[0]").text, '1개가 늦어요연결됨 4 · 남은 것 0', '한 번 실패는 늦어요');
  assert.equal(head(bad).children[0].className, 'd-istat k-late');
  assert.equal(stText(bad, 1), '읽지 못했어요 · 12분 전');
  const why = bad.find('slack', 'd-intgwhy')[0];
  assert.equal(why.textContent || why.children.map(one => one.textContent).join(''), '슬랙이 응답하지 않았어요 — 다시 시도해도 안 되면 ⋯ › 최근 기록');
  assert.equal(bad.card('slack').dataset.failing, 'true');
  assert.equal(fetchButton(bad, 'slack').textContent, '다시 시도');
  assert.equal(bad.find('jira', 'd-intgwhy').length, 0, '멈추지 않은 카드에는 이유 줄이 없다');

  // 토큰 문제면 버튼은 `다시 연결`이고 이유 줄도 그 말
  const auth = wpd25({ jira: { ...WPD25_CONNECTED.jira, fetch: { failing: true, auth: true, failedAt: ago(3) } } });
  await auth.app.run('renderSettingsIntegrations()');
  assert.equal(fetchButton(auth, 'jira').textContent, '다시 연결');
  assert.equal(auth.shape("document.getElementById('settingsIntegrationsView').children[0]").text, '1개가 멈췄어요연결됨 4 · 남은 것 0');
  assert.equal(head(auth).children[0].className, 'd-istat k-stop');
  assert.match(auth.find('jira', 'd-intgwhy')[0].children.map(one => one.textContent).join(''), /^토큰이 만료됐거나 권한이 없어요 — 다시 연결을 누르면 이 카드에서 토큰 단계부터 다시 열려요$/);

  // 셈은 순수 함수로도 — 연결된 카드만, 켜진 채널이 모두 사라졌으면 멈춘 것(일부면 아니다)
  const failing = state => JSON.parse(ok.app.run(`JSON.stringify(settingsIntgFailing(${JSON.stringify(state)}))`));
  same(failing({ ...WPD25_CONNECTED, slack: { ...WPD25_CONNECTED.slack, channels: { todo: { id: 'C1', name: '#my-todo', missing: true } } } }), ['slack']);
  same(failing({ ...WPD25_CONNECTED, slack: { ...WPD25_CONNECTED.slack, fetch: {}, channels: { todo: { id: 'C1', missing: true }, align: { id: 'C3' } } } }), [], '일부만 사라지면 멈춘 것이 아니다');
  same(failing({ ...WPD25_CONNECTED, slack: { ...WPD25_CONNECTED.slack, fetch: {}, channels: { align: { id: 'C3', missing: true }, someday: { id: 'C4', missing: true } } } }), ['slack'], '할 일 없이도 켜진 채널이 모두 사라지면 멈춘 것');
  same(failing({ slack: { enabled: true, hasToken: false, fetch: { failing: true }, channels: { todo: { id: 'C1' } } } }), [], '연결 안 된 카드는 세지 않는다');
  same(failing({ ...WPD25_CONNECTED, calendar: { enabled: true, source: 'ical', readAt: null, failed: true } }), ['calendar'], '비밀 주소를 한 번도 못 읽었으면 멈춘 것');
});

test('Claude 로그인 풀림: 첫 멈춘 카드(슬랙)에 `아래 두 줄이면 다시 돼요` + 두 줄 칸, 캘린더(Claude)·회의록은 그 카드를 가리키고, 버튼은 `다시 시도` 그대로', async () => {
  const expired = 'Failed to authenticate. API Error: 401 OAuth session expired and could not be refreshed';
  const fetch = { failing: true, auth: false, claudeAuth: true, failedAt: ago(7), summary: expired };
  const fx = wpd25({
    slack: { ...WPD25_CONNECTED.slack, fetch },
    calendar: { enabled: true, source: 'claude', live: false, readAt: null, fetch },
    meetingNotes: { mode: 'tiro', name: '', fetch },
  });
  await fx.app.run('renderSettingsIntegrations()');
  const why = kind => fx.find(kind, 'd-intgwhy')[0].children.map(one => one.textContent).join('');
  assert.equal(why('slack'), 'Claude Code 로그인이 풀렸어요 — 아래 두 줄이면 다시 돼요');
  for (const kind of ['calendar', 'notes']) {
    assert.equal(why(kind), 'Claude Code 로그인이 풀렸어요 — 슬랙 수집 카드의 두 줄대로 하면 여기도 함께 다시 돼요', kind);
    assert.equal(fx.find(kind, 'd-iclaude').length, 0, `${kind}: 칸은 한 곳에만`);
  }
  for (const kind of ['slack', 'calendar', 'notes']) assert.equal(fetchButton(fx, kind).textContent, '다시 시도', `${kind}: 토큰 문제가 아니라 다시 연결로 바꾸지 않는다`);
  assert.equal(fx.find('slack', 'd-iclaude').length, 1);
  // 가리키는 글의 카드 이름은 누르는 밑줄 글자 — 그 카드를 밝히고 토큰 칸에 초점을 둔다
  const pointer = fx.find('calendar', 'd-intgwhy')[0].children.find(one => String(one.className) === 'd-ablink');
  assert.equal(pointer.textContent, '슬랙 수집 카드의 두 줄');
  assert.equal(pointer.type, 'button');
  const tokenInput = fx.find('slack', 'd-din').find(one => one.getAttribute('aria-label') === 'Claude 로그인 토큰');
  let focused = 0;
  tokenInput.focus = () => { focused += 1; };
  pointer.listeners.click();
  assert.equal(focused, 1, '토큰 칸에 초점');
  assert.match(fx.card('slack').className, /\bis-flash\b/, '칸이 있는 카드를 잠깐 밝힌다');
  // 슬랙이 멀쩡하면 다음 멈춘 카드(캘린더)가 칸을 갖는다
  const cal = wpd25({ calendar: { enabled: true, source: 'claude', live: false, readAt: null, fetch }, meetingNotes: { mode: 'tiro', name: '', fetch } });
  await cal.app.run('renderSettingsIntegrations()');
  assert.equal(cal.find('calendar', 'd-iclaude').length, 1);
  assert.match(cal.find('notes', 'd-intgwhy')[0].children.map(one => one.textContent).join(''), /캘린더 카드의 두 줄대로/);
  // 이 맥에 Claude Code가 없으면(claudeInstalled 규칙) 칸이 서지 않고 도움말로 안내한다
  const none = wpd25({ claude: false, meetingNotes: { mode: 'tiro', name: '', fetch } });
  await none.app.run('renderSettingsIntegrations()');
  assert.equal(none.find('notes', 'd-iclaude').length, 0);
  assert.equal(none.find('notes', 'd-intgwhy')[0].children.map(one => one.textContent).join(''), '자동 수집이 쓰는 Claude Code 로그인이 풀렸어요 — 도움말 “Claude Code 로그인이 풀렸다고 나와요”대로 다시 로그인해 주세요');
  // 서버가 claudeAuth를 주지 않으면(가장 최근 실패가 다른 이유) 예전처럼 최근 기록으로 안내한다
  const other = wpd25({ slack: { ...WPD25_CONNECTED.slack, fetch: { ...fetch, claudeAuth: false, summary: 'my-todo 채널 확인 실패 — fetch 실패 (exit 28)' } } });
  await other.app.run('renderSettingsIntegrations()');
  assert.equal(other.find('slack', 'd-intgwhy')[0].children.map(one => one.textContent).join(''), '슬랙이 응답하지 않았어요 — 다시 시도해도 안 되면 ⋯ › 최근 기록');
  assert.equal(other.find('slack', 'd-iclaude').length, 0);
});

test('연동 1층-B ②: Claude 로그인 칸 — ① `claude setup-token` 복사 ② 가린 칸에 붙여 저장 → 전용 주소로만 보내고 `새 토큰을 저장했어요 — 다시 시도를 눌러 확인해 주세요`(분홍 이유 줄은 감춤), 틀리면 서버 문구 그대로(값 없음)', async () => {
  const fake = 'sk-ant-oat01-FAKE-TEST-ONLY';
  const fetch = { failing: true, auth: false, claudeAuth: true, failedAt: ago(7) };
  const shape = '토큰 사이에 띄어쓰기나 줄바꿈이 있어요 — 터미널에서 한 줄로 다시 복사해 주세요';
  const fx = wpd25({ slack: { ...WPD25_CONNECTED.slack, fetch } }, [
    { status: 400, body: { ok: false, code: 'claude_space', error: shape } },
    { body: { ok: true, saved: true } },
  ]);
  await fx.app.run('renderSettingsIntegrations()');
  const box = () => fx.find('slack', 'd-iclaude')[0];
  assert.ok(box());
  const statBefore = statOf(fx, 'slack');
  const labels = fx.find('slack', 'lb').filter(one => /^[①②]/.test(one.textContent)).map(one => one.textContent);
  same(labels, ['① 터미널에서 이 명령을 실행해요', '② 그 토큰을 여기 붙여 넣어요']);
  const code = fx.find('slack', 'd-icode')[0];
  assert.equal(code.children[0].textContent, 'claude setup-token', '터미널에는 이 명령 하나만');
  await code.children[1].listeners.click();
  same(fx.copied, ['claude setup-token']);
  const input = fx.find('slack', 'd-din').find(one => one.getAttribute('aria-label') === 'Claude 로그인 토큰');
  assert.equal(input.type, 'password', '토큰 칸은 가린다');
  assert.equal(input.getAttribute('autocomplete'), 'off');
  const text = fx.text('slack');
  assert.match(text, /브라우저에서 허용하면 터미널에 긴 토큰\(sk-ant-oat…\)이 나와요/);
  assert.match(text, /이 맥의 파일에만 저장하고 화면·로그에는 다시 나오지 않아요/);
  assert.doesNotMatch(text, /read -s|printf|chmod|workspace-claude-token/, '긴 터미널 명령은 없다');

  // 빈 칸 — 서버에 보내지 않는다
  await fx.button('slack', '저장').listeners.click();
  const errors = () => fx.find('slack', 'd-derr').map(one => one.textContent).filter(Boolean);
  same(errors(), ['claude setup-token이 보여 준 토큰을 붙여 넣어 주세요']);
  assert.equal(fx.sent.filter(one => one.url === '/api/integrations/claude-token').length, 0);

  // 모양 틀림 — 서버 문구 그대로, 칸이 붉다
  input.value = 'sk-ant-oat01 FAKE';
  await fx.button('slack', '저장').listeners.click();
  same(errors(), [shape]);
  assert.equal(input.getAttribute('aria-invalid'), 'true');

  // 저장 — 전용 주소 하나로만(연동 저장은 부르지 않는다), 저장 뒤 칸을 비우고 안내 한 줄
  input.value = `  ${fake}  `;
  await fx.button('slack', '저장').listeners.click();
  const sent = fx.sent.filter(one => one.url === '/api/integrations/claude-token');
  assert.equal(sent.length, 2);
  same(sent[1].body, { token: fake });
  assert.equal(fx.sent.filter(one => one.url === '/api/integrations/save').length, 0, '설정 저장·재시작 길을 부르지 않는다');
  assert.equal(input.value, '', '보낸 뒤 칸을 비운다');
  assert.equal(fx.find('slack', 'd-iok')[0].textContent, '새 토큰을 저장했어요 — 다시 시도를 눌러 확인해 주세요');
  assert.equal(fx.find('slack', 'd-iok')[0].getAttribute('role'), 'status');
  assert.equal(fx.find('slack', 'd-din').filter(one => one.type === 'password').length, 0, '저장 뒤에는 칸이 없다');
  const whyLine = () => fx.find('slack', 'd-intgwhy')[0];
  assert.equal(whyLine().hidden, true, '저장하면 분홍 이유 줄은 감춘다(초록 성공 줄과 부딪히지 않게)');
  same(statOf(fx, 'slack'), statBefore, '상태 점은 수집이 돌 때까지 그대로');
  assert.equal(String(JSON.stringify(fx.shape("document.getElementById('settingsIntegrationsView')"))).includes('FAKE-TEST-ONLY'), false, '화면 어디에도 값이 없다');
  assert.equal(fx.sent.filter(one => one.url === '/api/integrations/fetch').length, 0, '저장 뒤 자동으로 다시 돌리지 않는다');
  // 다시 그려도(수집이 아직 안 돌아 멈춤 그대로) 저장 줄이 남고, `토큰 다시 붙이기`로 칸을 다시 연다
  await fx.app.run('renderSettingsIntegrations()');
  assert.equal(fx.find('slack', 'd-iok')[0].textContent, '새 토큰을 저장했어요 — 다시 시도를 눌러 확인해 주세요');
  assert.equal(whyLine().hidden, true, '다시 그려도 감춘 채');
  fx.button('slack', '토큰 다시 붙이기').listeners.click();
  assert.equal(fx.find('slack', 'd-iclaude')[0].children.length > 2, true);
  assert.equal(whyLine().hidden, false, '칸을 다시 열면 이유 줄도 다시');
  // 좁은 폭(≤520)에서도 칸은 상태 줄·이유 줄 아래(같은 order 2) — 빠지면 칸이 카드 맨 위로 올라갔다
  const css = fs.readFileSync(path.join(__dirname, 'ui.css'), 'utf8');
  assert.match(css, /\.d-intg > \.d-intgbody, \.d-intg > \.d-iclaude \{ order: 2; \}/);
  assert.ok(fx.button('slack', '저장'));
});

test('WP-E B. 빨간 점을 누르면 연동 탭으로 열고 멈춘 카드만 약 2초 붉게(is-flash), 파란 점만 있으면 앱 탭', async () => {
  const fx = wpd25({ calendar: { ...WPD25_CONNECTED.calendar, fetch: { failing: true, stuck: true, failedAt: ago(5) } } });
  fx.app.run(`settingsAlertKeys = ['calendar'];`);
  same(fx.app.run('settingsGearTab()'), ['integrations', 'alerts']);
  fx.app.run(`settingsFocusKey = 'alerts'`);
  await fx.app.run('renderSettingsIntegrations()');
  assert.match(fx.card('calendar').className, /\bis-flash\b/, '멈춘 카드만');
  assert.ok(!/is-flash/.test(fx.card('slack').className));
  assert.equal(fx.app.run('settingsFocusKey'), null, '표지는 한 번만 쓴다');
  await new Promise(resolve => setTimeout(resolve, 2100));
  assert.ok(!/is-flash/.test(fx.card('calendar').className), '약 2초 뒤 거둔다');
  const css = fs.readFileSync(path.join(__dirname, 'ui.css'), 'utf8');
  assert.match(css, /\.d-intg\.is-flash \{[^}]*background: var\(--urgent-bg\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.d-intg \{ transition: none; \} \}/, '동작 줄이기면 전환 없이 바탕만');

  // 빨간 점이 없고 새 버전(파란 점)만 있으면 앱 탭, 아무 점도 없으면 연동
  fx.app.run(`settingsAlertKeys = []; settingsAbout = { version: '1.0.0', update: { available: true, label: 'v1.1.0' } };`);
  same(fx.app.run('settingsGearTab()'), ['app', null]);
  fx.app.run(`settingsAbout = null;`);
  same(fx.app.run('settingsGearTab()'), ['integrations', null]);

  // 서버의 alerts가 빨간 점의 근거다(옛 서버면 자동화의 가장 최근 실패만)
  fx.app.context.request = async () => new Response(JSON.stringify({ automations: [{ key: 'tiro', lastKind: 'fail' }], alerts: ['jira'] }));
  await fx.app.run('fetchAutomationStatus()');
  same(fx.app.run('settingsAlertKeys'), ['jira']);
  fx.app.context.request = async () => new Response(JSON.stringify({ automations: [{ key: 'tiro', lastKind: 'fail' }, { key: 'slack', lastKind: 'run' }] }));
  await fx.app.run('fetchAutomationStatus()');
  same(fx.app.run('settingsAlertKeys'), ['notes']);
});

test('WP-E C. ⋯ › 최근 기록: 시각 · 결과 한 줄(최근 10개, 실패는 빨강) + 오류 전문 복사, 기록이 없으면 메뉴 칸을 숨긴다', async () => {
  const today = new Date();
  const two = n => String(n).padStart(2, '0');
  const stamp = (h, m) => `${today.getFullYear()}-${two(today.getMonth() + 1)}-${two(today.getDate())} ${two(h)}:${two(m)}:00`;
  const slackLog = [
    { time: stamp(10, 5), kind: 'fail', text: 'my-todo 채널 확인 실패 — fetch 실패 (exit 28)' },
    { time: stamp(9, 55), kind: 'run', text: '이번에 본 메시지 3개 = 등록 2 · 링크 중복 1 · 비슷한 일이라 건너뜀 0 · 시스템 0 새 항목 2개를 등록했습니다. 자세한 내용은 …' },
    { time: stamp(9, 50), kind: 'skip', text: '새 메시지 없음 — Claude 호출 생략' },
    ...Array.from({ length: 9 }, (unused, i) => ({ time: '2026-09-20 09:00:00', kind: 'skip', text: `새 메시지 없음 — Claude 호출 생략 ${i}` })),
  ];
  const fx = wpd25({
    slack: { ...WPD25_CONNECTED.slack, log: slackLog },
    jira: { ...WPD25_CONNECTED.jira, log: [{ time: stamp(8, 0), kind: 'run', text: '읽음 · 내 티켓 12개' }, { time: stamp(7, 50), kind: 'fail', text: '읽지 못했어요 — 토큰이 만료됐거나 권한이 없어요' }] },
    calendar: { ...WPD25_CONNECTED.calendar, log: [] },
  });
  fx.app.run(`automationStatusCache = [{ key: 'slack', tail: ['───── 2026-09-24 10:05:00 slack-capture 시작', '이번에 본 메시지 3개 = 등록 1 · 링크 중복 2 · 비슷한 일이라 건너뜀 0 · 시스템 0', '───── 2026-09-24 10:05:30 slack-capture 종료 (exit 0)'] }];`);
  await fx.app.run('renderSettingsIntegrations()');
  const slackMenu = fx.menu('slack');
  same(slackMenu.map(section => section.map(entry => entry.label)), [['새로 받기', '최근 기록', '보내는 법', '채널 고르기', '슬랙 정리 방식', '다시 연결(토큰 바꾸기)'], ['해제…']]);
  same(fx.menu('calendar').map(section => section.map(entry => entry.label)), [['새로 받기', '다시 연결(주소 바꾸기)'], ['해제…']], '기록이 없으면 칸을 숨긴다');
  slackMenu[0][1].onClick();
  const list = fx.find('slack', 'd-ilog')[0];
  assert.ok(list, '카드 아래 접이식 목록이 펼쳐진다');
  assert.equal(fx.toggle('slack').textContent, '접기');
  const rows = list.children.filter(one => one.className !== 'more');
  assert.equal(rows.length, 10, '최근 10개');
  same(rows.slice(0, 3).map(one => [one.children[0].textContent, one.children[1].textContent, one.children[1].className || '']), [
    ['10:05', '읽지 못했어요 — 슬랙이 응답하지 않았어요', 'bad'],
    ['09:55', '읽음 · 새 항목 2개를 등록했습니다. …', ''], // 처리 대장 문장은 목록 위에 따로 서서 한 줄 결과에서는 뺀다
    ['09:50', '읽음 · 새 것 없음', ''],
  ]);
  assert.equal(rows[3].children[0].textContent, '9/20 09:00', '오늘이 아니면 날짜를 붙인다');
  // 처리 대장이 맨 위에
  assert.match(fx.text('slack'), /최근 수집 · 본 메시지 3개 → 등록 1 · 중복 2 · 건너뜀 0 · 시스템 0/);
  // 오류 전문 복사 — 기록 줄 + 로그 끝 부분
  await fx.button('slack', '오류 전문 복사').listeners.click();
  assert.match(fx.copied.at(-1), /^슬랙 수집 최근 기록\n.*10:05:00 · 실패 · my-todo 채널 확인 실패/);
  assert.match(fx.copied.at(-1), /로그 끝 부분:\n───── 2026-09-24 10:05:00 slack-capture 시작/);
  assert.match(fx.live(), /오류 전문을 복사했어요/);

  // 지라(앱이 직접 읽는 것)는 메모리에 있는 만큼을 같은 모양으로
  fx.menu('jira')[0][1].onClick();
  const jiraRows = fx.find('jira', 'd-ilog')[0].children.filter(one => one.className !== 'more');
  same(jiraRows.map(one => [one.children[0].textContent, one.children[1].textContent, one.children[1].className || '']), [
    ['08:00', '읽음 · 내 티켓 12개', ''], ['07:50', '읽지 못했어요 — 토큰이 만료됐거나 권한이 없어요', 'bad'],
  ]);
  assert.equal(fx.find('slack', 'd-ilog').length, 0, '다른 카드의 펼침은 접힌다');

  // 알림의 `자세히`(미팅 노트 가져오기 실패)는 회의록 카드의 최근 기록을 편다
  const notes = wpd25({ meetingNotes: { mode: 'tiro', name: '', log: [{ time: stamp(9, 0), kind: 'fail', text: 'Claude usage: session limit reached (resets 3pm)' }] } });
  notes.app.run(`settingsFocusKey = 'log:notes'`);
  await notes.app.run('renderSettingsIntegrations()');
  const noteRow = notes.find('notes', 'd-ilog')[0].children[0];
  assert.equal(noteRow.children[1].textContent, '읽지 못했어요 — Claude 사용량 한도에 걸림 · 3pm에 풀림');
  const meetingUi = fs.readFileSync(path.join(__dirname, 'meeting-notes-ui.js'), 'utf8');
  assert.match(meetingUi, /settingsOpen\('integrations', 'log:notes'\)/);
});

test('WP-I ⋯ › 최근 기록: 그 회차의 앱 버전(v1.1.2)을 시각 다음에 보이고(옛 기록은 없이), 버전이 붙은 시작 줄도 한 실행으로 읽는다', async () => {
  const fx = wpd25({
    slack: { ...WPD25_CONNECTED.slack, log: [
      { time: '2026-09-20 10:05:00', kind: 'run', version: '1.1.2', text: 'my-todo · 새 2개 · 저장 2 · 건너뜀 0' },
      { time: '2026-09-20 09:55:00', kind: 'run', text: '옛 회차' },
    ] },
  });
  fx.app.run(`automationStatusCache = [{ key: 'slack', tail: ['───── 2026-09-20 10:05:00 slack-capture 시작 (v1.1.2)', '이번에 본 메시지 2개 = 등록 2 · 링크 중복 0 · 비슷한 일이라 건너뜀 0 · 시스템 0', "🔁 이미 있는 '예전 일'랑 중복돼서 안 가져왔어요", '───── 2026-09-20 10:05:30 slack-capture 종료 (exit 0)'] }];`);
  await fx.app.run('renderSettingsIntegrations()');
  fx.menu('slack')[0][1].onClick();
  const rows = fx.find('slack', 'd-ilog')[0].children.filter(one => one.className !== 'more');
  same(rows.map(one => one.children.map(kid => kid.textContent)), [
    ['9/20 10:05', 'v1.1.2', '읽음 · my-todo · 새 2개 · 저장 2 · 건너뜀 0'],
    ['9/20 09:55', '읽음 · 옛 회차'],
  ]);
  assert.match(fx.text('slack'), /최근 수집 · 본 메시지 2개 → 등록 2/);
  assert.match(fx.text('slack'), /건너뛴 것: 예전 일/, '버전이 붙은 시작 줄도 실행 블록의 경계로 읽는다');
  await fx.button('slack', '오류 전문 복사').listeners.click();
  assert.match(fx.copied.at(-1), /2026-09-20 10:05:00 · v1\.1\.2 · 성공 · my-todo/);
});

test('WP-E A. 둘째 줄은 주기·오늘 수치 — 슬랙 `매일 9–19시, 5분마다 · 오늘 새 항목 N개`, 지라 `내 티켓 · 반응 필요 댓글 · N분 전 확인`, 캘린더 주기, 회의록 안내', async () => {
  const fx = wpd25({
    slack: { ...WPD25_CONNECTED.slack, todayCount: 6 },
    jira: { ...WPD25_CONNECTED.jira, attentionCount: 2, attentionAt: ago(1) },
  });
  await fx.app.run('renderSettingsIntegrations()');
  const need = kind => fx.find(kind, 'd-intgneed')[0];
  assert.equal(need('slack').textContent, '매일 9–19시, 5분마다 · 오늘 새 항목 6개');
  assert.equal(need('jira').textContent, '내 티켓 12개 · 반응 필요 댓글 2개 · 1분 전 확인');
  assert.equal(need('jira').className, 'd-intgneed');
  assert.equal(need('calendar').textContent, '30분마다');
  assert.equal(need('notes').textContent, '회의가 끝나면 회의 탭에서 가져오기');
  const claude = wpd25({ calendar: { enabled: true, source: 'claude', fetch: {} } });
  await claude.app.run('renderSettingsIntegrations()');
  assert.equal(claude.find('calendar', 'd-intgneed')[0].textContent, '매일 9–19시, 2시간마다', '실제 등록 값(calendar-sync 9·11·13·15·17·19시)');

  // 반응 필요 댓글을 읽지 못하면 그 말을 주의색으로(예전 상태 탭 줄의 빨간 글자)
  const broken = wpd25({ jira: { ...WPD25_CONNECTED.jira, attentionCount: null, attentionAt: null, attentionError: true } });
  await broken.app.run('renderSettingsIntegrations()');
  assert.equal(broken.find('jira', 'd-intgneed')[0].textContent, '내 티켓 12개 · 반응 필요 댓글을 읽지 못했어요');
  assert.equal(broken.find('jira', 'd-intgneed')[0].className, 'd-intgneed k-warn');
  const stale = wpd25({ jira: { ...WPD25_CONNECTED.jira, attentionCount: 1, attentionAt: ago(180), attentionStale: true } });
  await stale.app.run('renderSettingsIntegrations()');
  assert.equal(stale.find('jira', 'd-intgneed')[0].textContent, '내 티켓 12개 · 반응 필요 댓글 1개 · 3시간 전 확인 · 다시 읽지 못했어요');
  // 지라를 켜지 않았으면 준비물 줄 그대로(연결 안 됨)
  const off = intgClient();
  await off.app.run('renderSettingsIntegrations()');
  assert.equal(off.find('jira', 'd-intgneed')[0].textContent, '3분 · Atlassian API 토큰 하나');
  assert.equal(off.toggle('jira').textContent, '연결하기');
});

// 채널 고르기용 가짜 창 — 슬랙이 연결돼 있고, 앞머리 묻기(token-check)에 먼저 답한다.
async function intgPick(slack = {}, replies = [], prefix = 'hana') {
  const fx = intgClient({
    slack: {
      enabled: true, hasToken: true, readAt: ago(5),
      channels: { todo: { id: 'C1', name: '#my-todo' }, waiting: { id: 'C2', name: '#my-waiting' }, align: { id: '', name: '' }, someday: { id: '', name: '' } },
      ...slack,
    },
  }, [{ body: { ok: true, prefix } }, ...replies]);
  await fx.app.run('renderSettingsIntegrations()');
  const menu = fx.menu('slack');
  await menu[0].find(entry => entry.label === '채널 고르기').onClick();
  await new Promise(resolve => setImmediate(resolve));
  return fx;
}
const pickRow = (fx, key) => fx.find('slack', 'd-ich').find(one => one.dataset.channel === key);
const pickText = (fx, key) => fx.shape(`window.findByClass(document.getElementById('settingsIntegrationsView').children[1], 'd-ich').find(one => one.dataset.channel === ${JSON.stringify(key)})`).text;
const pickGo = fx => fx.find('slack', 'pri')[0];
const pickToggle = async (fx, key, on) => {
  const box = pickRow(fx, key).children[0];
  box.checked = on;
  await box.listeners.change();
};

test('WP-E E. 채널 고르기: 연결된 채널은 고정 이름(`#이름` + 연결됨), 새 줄은 `새 채널 이름` 칸(기본 `<슬랙 이름>-키`), 할 일도 다른 줄과 같다', async () => {
  const fx = await intgPick();
  same(fx.sent.filter(one => one.url === '/api/integrations/slack-token-check').map(one => one.body), [{ token: '' }], '앞머리는 저장된 토큰으로 묻는다(토큰 칸 없음)');
  assert.match(fx.text('slack'), /받을 곳을 더하거나 빼요\. 새로 고른 곳은 비공개 채널을 만들어 드려요\./);
  assert.equal(fx.find('slack', 'd-isteps').length, 0, '위저드 단계 줄은 없다');
  same(['todo', 'waiting', 'align', 'someday'].map(key => pickRow(fx, key).className), ['d-ich is-on', 'd-ich is-on', 'd-ich', 'd-ich']);
  assert.equal(pickText(fx, 'todo'), '할 일오늘 탭 새로 들어온 것으로 와요#my-todo연결됨');
  same([pickRow(fx, 'todo').children[0].checked, pickRow(fx, 'todo').children[0].disabled], [true, false]);
  assert.equal(pickRow(fx, 'waiting').children[2].className, 'lock', '연결된 채널 이름은 고정 글자');
  assert.equal(pickText(fx, 'align'), '정해진 것정책·결정 → 아이디어·결정 탭의 결정새 채널 이름');
  const alignName = pickRow(fx, 'align').children[2].children[1];
  same([alignName.value, alignName.disabled], ['hana-align', true], '기본 이름은 슬랙 사용자 이름 + 키, 고르기 전엔 꺼져 있다');
  assert.match(fx.text('slack'), /ⓘ연결된 채널의 이름은 여기서 바꿀 수 없어요\. 슬랙에서 채널 이름을 바꾸면 앱이 알아서 새 이름을 따라가요\./);
  same([pickGo(fx).textContent, pickGo(fx).disabled], ['바꾼 것이 없어요', true]);
  assert.equal(fx.button('slack', '취소').className, 'd-btn sm');

  // 앞머리를 못 받으면 my-
  const plain = await intgPick({}, [], null);
  assert.equal(pickRow(plain, 'someday').children[2].children[1].value, 'my-someday');
  // 앞머리 다듬기(서버가 못 한 것까지 화면이 한 번 더) — 소문자·영숫자·-·_, 길이 제한
  assert.equal(fx.app.run("settingsSlackDefaultName('todo', 'Hana.Kim')"), 'hanakim-todo');
  assert.equal(fx.app.run("settingsSlackDefaultName('someday', '')"), 'my-someday');
  assert.ok(fx.app.run(`settingsSlackDefaultName('someday', ${JSON.stringify('a'.repeat(200))})`).length <= 80);
});

test('WP-E E. 채널 고르기 빼기·더하기: 체크를 풀면 그 줄이 붉게 + `빼요`, 버튼 문구가 바뀌고 누르기 전에 확인 줄 — 저장은 off 표시만(슬랙 쓰기 없음)', async () => {
  const fx = await intgPick({}, [
    { body: { ok: true, id: 'C0ALIGN1', name: 'hana-align' } },
    { body: { ok: true, restart: false } },
  ]);
  await pickToggle(fx, 'waiting', false);
  assert.equal(pickRow(fx, 'waiting').className, 'd-ich is-off');
  assert.match(pickText(fx, 'waiting'), /^기다리는 것빼요#my-waiting연결됨$/);
  assert.equal(pickGo(fx).textContent, '1개 빼기');
  assert.equal(pickRow(fx, 'waiting').children[0].focused, true, '다시 그려도 누른 칸에 초점이 남는다');
  const confirm = fx.find('slack', 'd-iconfirm')[0];
  assert.equal(confirm.children[0].textContent, '#my-waiting 채널을 빼면 앱이 더 이상 읽지 않아요. 슬랙 채널과 이미 들어온 항목은 그대로예요.');

  await pickToggle(fx, 'align', true);
  assert.equal(pickGo(fx).textContent, '1개 만들고 1개 빼기');
  assert.match(pickText(fx, 'align'), /새로 만들어요/);
  assert.equal(pickRow(fx, 'align').children[2].children[1].disabled, false);
  await pickToggle(fx, 'waiting', true);
  assert.equal(pickGo(fx).textContent, '1개 만들기', '다시 체크하면 빼기가 사라진다');
  assert.equal(fx.find('slack', 'd-iconfirm').length, 0);
  await pickToggle(fx, 'waiting', false);

  await pickGo(fx).listeners.click();
  same(fx.sent.filter(one => one.url === '/api/integrations/slack-channel').map(one => one.body), [{ token: '', name: 'hana-align', key: 'align' }], '새 줄만 만든다(저장된 토큰)');
  const saved = fx.sent.find(one => one.url === '/api/integrations/save');
  same(saved.body, { slack: { enabled: true, token: '', channels: { align: 'C0ALIGN1' }, off: ['waiting'], on: [] } });
  assert.match(fx.live(), /채널 1개를 만들었어요 · 채널 1개를 뺐어요/);

  // 빼기만 하면 채널을 만들러 가지 않는다
  const only = await intgPick({}, [{ body: { ok: true, restart: false } }]);
  // 할 일도 뺄 수 있다(다른 줄과 같은 확인 줄) — 단 마지막 하나는 뺄 수 없다
  assert.equal(pickRow(only, 'todo').children[0].disabled, false);
  await pickToggle(only, 'todo', false);
  assert.equal(pickRow(only, 'todo').className, 'd-ich is-off');
  assert.equal(pickGo(only).textContent, '1개 빼기');
  assert.equal(only.find('slack', 'd-iconfirm')[0].children[0].textContent, '#my-todo 채널을 빼면 앱이 더 이상 읽지 않아요. 슬랙 채널과 이미 들어온 항목은 그대로예요.');
  await pickToggle(only, 'waiting', false);
  assert.equal(pickRow(only, 'waiting').children[0].checked, true, '마지막 채널은 체크가 풀리지 않는다');
  assert.equal(pickRow(only, 'waiting').className, 'd-ich is-on');
  assert.match(only.text('slack'), /마지막 채널은 뺄 수 없어요 — 슬랙 수집을 끄려면 ⋯ › 해제/);
  assert.equal(pickGo(only).textContent, '1개 빼기');
  await pickToggle(only, 'todo', true);
  assert.doesNotMatch(only.text('slack'), /마지막 채널은/, '다시 고르면 이유 줄은 거둔다');
  await pickToggle(only, 'waiting', false);
  await pickGo(only).listeners.click();
  assert.equal(only.sent.filter(one => one.url === '/api/integrations/slack-channel').length, 0);
  same(only.sent.find(one => one.url === '/api/integrations/save').body, { slack: { enabled: true, token: '', channels: {}, off: ['waiting'], on: [] } });
  same(JSON.parse(only.app.run(`JSON.stringify(settingsSlackPickLabel({ add: ['a', 'b'], back: ['c'], off: ['d'] }))`)), '2개 만들고 1개 다시 연결하고 1개 빼기');
});

test('WP-E E·F. 뺐던 채널은 다시 체크하면 새로 만들지 않고 다시 연결(뺀 동안 온 메시지는 안 가져옴), 사라진 채널은 이름 칸(다시 만들기)', async () => {
  const fx = await intgPick({
    channels: { todo: { id: 'C1', name: '#my-todo' }, waiting: { id: 'C2', name: '#my-waiting', missing: true }, align: { id: '', name: '' }, someday: { id: '', name: '' } },
    off: { align: { name: '#my-align' }, someday: { name: '#my-someday', missing: true } },
  }, [{ body: { ok: true, restart: false } }]);
  // 카드 둘째 줄 아래: 사라진 채널은 주황 한 줄 + 채널 고르기(할 일이 아니면 멈춘 것으로 세지 않는다)
  // 사라진(연결된) 채널은 처음부터 체크된 채 — 그대로 두면 다시 만든다
  assert.equal(pickGo(fx).textContent, '1개 만들기');
  // 뺀 채널: 체크 풀린 채 고정 글자 + `뺀 채널`
  assert.equal(pickRow(fx, 'align').children[0].checked, false);
  assert.match(pickText(fx, 'align'), /#my-align뺀 채널$/);
  await pickToggle(fx, 'align', true);
  assert.equal(pickGo(fx).textContent, '1개 만들고 1개 다시 연결하기');
  assert.match(pickText(fx, 'align'), /다시 연결해요 — 뺀 동안 온 메시지는 가져오지 않아요/);
  assert.match(fx.text('slack'), /#my-align 채널을 다시 연결해요 — 뺀 동안 온 메시지는 가져오지 않아요/);
  // 뺀 채널이 슬랙에서도 사라졌으면 다시 체크할 때 새로 만든다(이름 칸)
  assert.equal(pickRow(fx, 'someday').children[2].className, 'nmwrap');
  // 사라진(연결된) 채널: 체크된 채 주황 판 + 이름 칸, 두면 다시 만들고 풀면 뺀다
  assert.equal(pickRow(fx, 'waiting').className, 'd-ich is-on is-gone');
  assert.match(pickText(fx, 'waiting'), /#my-waiting 채널을 찾을 수 없어요 — 체크한 채로 두면 다시 만들어요새 채널 이름/);
  await pickToggle(fx, 'waiting', false);
  assert.equal(pickGo(fx).textContent, '1개 다시 연결하고 1개 빼기');
  await pickGo(fx).listeners.click();
  assert.equal(fx.sent.filter(one => one.url === '/api/integrations/slack-channel').length, 0, '다시 연결은 새로 만들지 않는다');
  same(fx.sent.find(one => one.url === '/api/integrations/save').body, { slack: { enabled: true, token: '', channels: {}, off: ['waiting'], on: ['align'] } });
  assert.match(fx.live(), /다시 연결했어요 — 뺀 동안 온 메시지는 가져오지 않아요 · 채널 1개를 뺐어요/);
});

test('WP-E F. 사라진 채널: 일부면 카드에 주황 한 줄 + 채널 고르기, 켜진 채널이 모두 사라지면 빨간 상태 줄·요약에 멈춤으로 센다', async () => {
  const fx = intgClient({
    slack: {
      enabled: true, hasToken: true, readAt: ago(5),
      channels: { todo: { id: 'C1', name: '#my-todo' }, align: { id: 'C3', name: '#my-align', missing: true }, waiting: { id: '', name: '' }, someday: { id: '', name: '' } },
    },
  });
  await fx.app.run('renderSettingsIntegrations()');
  const warn = fx.find('slack', 'k-warn')[0];
  assert.equal(warn.dataset.missing, 'align');
  assert.match(fx.text('slack'), /#my-align 채널을 찾을 수 없어요 — 슬랙에서 지웠거나 보관했어요 · 채널 고르기/);
  assert.match(fx.shape("document.getElementById('settingsIntegrationsView').children[0]").text, /^1개 연결됨연결됨/, '일부만 사라지면 멈춘 것으로 세지 않는다(직접 옮기기는 셈에서 빠짐)');

  // 할 일 채널이 사라져도 다른 켜진 채널이 살아 있으면 주황(할 일 특별 취급 없음)
  const part = intgClient({
    slack: {
      enabled: true, hasToken: true, readAt: ago(5),
      channels: { todo: { id: 'C1', name: '#my-todo', missing: true }, align: { id: 'C3', name: '#my-align' }, waiting: { id: '', name: '' }, someday: { id: '', name: '' } },
    },
  });
  await part.app.run('renderSettingsIntegrations()');
  assert.equal(part.find('slack', 'k-warn')[0].dataset.missing, 'todo');
  assert.equal(part.find('slack', 'd-intgwhy').length, 0);
  assert.match(part.shape("document.getElementById('settingsIntegrationsView').children[0]").text, /^1개 연결됨연결됨/);

  // 켜진 채널 둘이 모두 사라지면 빨강 — 주황 줄 대신 상태 줄 하나
  const both = intgClient({
    slack: {
      enabled: true, hasToken: true, readAt: ago(5),
      channels: { todo: { id: '', name: '' }, align: { id: 'C3', name: '#my-align', missing: true }, waiting: { id: 'C2', name: '#my-waiting', missing: true }, someday: { id: '', name: '' } },
    },
  });
  await both.app.run('renderSettingsIntegrations()');
  assert.match(both.shape("document.getElementById('settingsIntegrationsView').children[0]").text, /^1개가 멈췄어요/);
  assert.equal(stText(both, 1), '켜진 채널을 모두 찾을 수 없어요');
  assert.equal(both.find('slack', 'k-warn').length, 0);

  // 할 일 없이 연결돼 있어도 연결된 카드다 — 대표 채널은 켜진 것 중 첫 번째, 보내는 법 예시도 그 채널
  const noTodo = intgClient({
    slack: {
      enabled: true, hasToken: true, readAt: ago(5),
      channels: { todo: { id: '', name: '' }, align: { id: 'C3', name: '#hana-align' }, waiting: { id: 'C2', name: '#hana-waiting' }, someday: { id: '', name: '' } },
    },
  });
  await noTodo.app.run('renderSettingsIntegrations()');
  assert.equal(stText(noTodo, 1), '#hana-waiting 외 1개 · 5분 전 읽음');
  await noTodo.menu('slack')[0].find(entry => entry.label === '보내는 법').onClick();
  assert.match(noTodo.text('slack'), /받는 곳에 #hana-waiting처럼 쓸 채널을 골라 보내요/);
  assert.doesNotMatch(noTodo.text('slack'), /#이름-todo/);

  const gone = intgClient({
    slack: {
      enabled: true, hasToken: true, readAt: ago(5),
      channels: { todo: { id: 'C1', name: '#my-todo', missing: true }, align: { id: '', name: '' }, waiting: { id: '', name: '' }, someday: { id: '', name: '' } },
    },
  }, [{ body: { ok: true, prefix: 'hana' } }]);
  await gone.app.run('renderSettingsIntegrations()');
  assert.match(gone.shape("document.getElementById('settingsIntegrationsView').children[0]").text, /^1개가 멈췄어요/);
  assert.equal(stText(gone, 1), '#my-todo 채널을 찾을 수 없어요');
  same(statOf(gone, 'slack'), ['d-istat k-stop', '멈췄어요']);
  assert.equal(fetchButton(gone, 'slack').hidden, true, '고칠 곳은 이유 줄의 채널 고르기 — 오른쪽 버튼은 두지 않는다');
  const why = gone.find('slack', 'd-intgwhy')[0];
  assert.equal(why.children.map(one => one.textContent).join(''), '슬랙에서 지웠거나 보관했어요 · 채널 고르기');
  await why.children[1].listeners.click();
  await new Promise(resolve => setImmediate(resolve));
  // 하나뿐인 채널이라 뺄 수 없다 — 체크된 채 이름 칸(다시 만들기)
  const todo = pickRow(gone, 'todo');
  same([todo.children[0].checked, todo.children[0].disabled, todo.className], [true, false, 'd-ich is-on is-gone']);
  assert.equal(todo.children[2].children[1].value, 'hana-todo');
  assert.equal(pickGo(gone).textContent, '1개 만들기');
});

test('WP-E ②. 처음 연결 위저드도 새 채널 기본 이름은 `<슬랙 사용자 이름>-키` — 사람이 고친 이름은 그대로', async () => {
  const fx = intgClient({}, [{ body: { ok: true, prefix: 'hana-kim' } }]);
  await fx.app.run('renderSettingsIntegrations()');
  fx.toggle('slack').listeners.click();
  fx.find('slack', 'd-din')[0].value = 'xoxp-good';
  await fx.button('slack', '다음 →').listeners.click();
  same(['todo', 'waiting', 'align', 'someday'].map(key => intgRow(fx, key).children[2].value), ['hana-kim-todo', 'hana-kim-waiting', 'hana-kim-align', 'hana-kim-someday']);
});

// 앱 탭 가짜 창 — /api/about · /api/backup · /api/update/status에 답한다.
function appClient({ about = {}, backup = null, now = null } = {}) {
  const info = { version: '1.1.0', install: 'managed', channel: 'stable', modified: [], update: { available: false }, updateFile: '~/workspace/업데이트.command', ...about };
  const app = settingsClient({});
  const sent = [];
  const copied = [];
  app.context.navigator = { clipboard: { writeText: async (text) => { copied.push(text); } }, platform: 'MacIntel' };
  app.context.request = async url => new Response(JSON.stringify(url === '/api/about' ? info : {}));
  app.context.fetch = async (url, options = {}) => {
    sent.push({ url: String(url), body: options.body ? JSON.parse(options.body) : null });
    let body = { ok: true };
    if (String(url) === '/api/about') body = info;
    else if (String(url) === '/api/backup') body = backup;
    else if (String(url) === '/api/update/status') body = { ok: true, status: null, pending: null, running: false };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  app.run(NODE_SHAPE);
  app.run(`window.findByClass = (node, cls) => {
    const hits = [];
    const walk = (one) => { if (one && String(one.className || '').split(' ').includes(cls)) hits.push(one); ((one && one.children) || []).forEach(walk); };
    walk(node);
    return hits;
  };`);
  const view = () => app.nodes.get('settingsAppView');
  const text = index => JSON.parse(app.run(`JSON.stringify(window.shapeOf(document.getElementById('settingsAppView').children[${index}]))`)).text;
  const find = cls => app.run(`window.findByClass(document.getElementById('settingsAppView'), ${JSON.stringify(cls)})`);
  return { app, sent, copied, view, text, find };
}
const backupAt = (daysAgo, time = '19:30') => { const d = new Date(); d.setDate(d.getDate() - daysAgo); const two = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${time}:04`; };

test('설정 정리: 앱 탭 차례는 버전 · 점검 · 데이터 백업 · (사용 통계) · (다른 기기) · 파일 위치 — 경로 둘은 맨 아래 접이식에 한 번씩', async () => {
  const fx = appClient({
    about: { update: { available: true, label: 'v1.1.1', changesUrl: null } },
    backup: { ok: true, path: '~/workspace-data-backup/daily', local: { state: 'ok', at: backupAt(1), days: 7 }, github: { on: false, state: 'never' } },
  });
  await fx.app.run('renderSettingsApp()');
  const kids = fx.view().children;
  same(kids.map(one => one.dataset.row), ['version', 'check', 'backup', 'place'], '사용 통계(usage-ui.js)가 없고 다른 기기에서 연 창이면 그 두 줄은 빠진다');
  // 버전 줄 맨 끝의 `지난 소식 전체`는 접이식 자체의 표지(summary) 글자다 — hidden이어도 textContent에는 남는다(실제 DOM과 같다).
  assert.match(fx.text(0), /^버전워크스페이스v1\.1\.0 · 배포된 버전만 받기새 버전 v1\.1\.1이 있어요업데이트 받기지난 소식 전체데이터는 먼저 백업하고 받아요\. 1분쯤 걸려요\.지난 소식 전체$/);
  assert.equal(fx.text(1), '점검문제가 있을 때점검하기문제 보고 복사설치·연동·자동화를 한 번에 확인하고, 고치는 법을 알려 줘요.');
  assert.equal(fx.text(2), '데이터 백업매일 19:30 이 맥에 매일 백업 · 어제 19:30 · 7일치', '백업 줄에는 경로·Finder 안내가 없다');
  assert.equal(fx.app.run("window.findByClass(document.getElementById('settingsAppView').children[2], 'd-btn')").length, 0);
  assert.equal(fx.text(3), '파일 위치찾을 때만경로 보기· 업데이트 파일 · 백업 폴더업데이트 파일~/workspace/업데이트.command복사백업 폴더~/workspace-data-backup/daily복사Finder에서 ⇧⌘G(폴더로 이동)에 붙여 넣으면 바로 가요', 'Dock 앱 경로 줄은 없다(WP-O)');
  const place = kids[3];
  assert.equal(place.className, 'd-pset d-pplace');
  const fold = place.children[1].children[0];
  assert.equal(fold.className, 'd-dsec d-dadd d-pplacefold');
  assert.ok(!fold.open, '파일 위치는 기본으로 접혀 있다');
  const all = [0, 1, 2, 3].map(index => fx.text(index)).join('\n');
  assert.equal(all.split('Finder에서 ⇧⌘G').length - 1, 1, 'Finder 안내는 한 번만');
  assert.equal(all.split('~/workspace-data-backup/daily').length - 1, 1, '백업 폴더 경로는 한 번만');
  const copies = fx.app.run("window.findByClass(document.getElementById('settingsAppView').children[3], 'd-btn')");
  assert.equal(copies.length, 2);
  await copies[0].listeners.click();
  await copies[1].listeners.click();
  same(fx.copied, ['~/workspace/업데이트.command', '~/workspace-data-backup/daily']);
  const report = fx.find('d-btn').find(one => one.id === 'settingsReportBtn');
  same([report.textContent, report.className], ['문제 보고 복사', 'd-btn']);
});

test('설정 정리: 사용 통계 줄은 자리만 옮긴다(한 번만 그린다) · 이 맥에서 열면 `다른 기기` 줄이 파일 위치 앞에 선다', async () => {
  const fx = appClient({ backup: { ok: true, path: '~/b/daily', local: { state: 'ok', at: backupAt(0), days: 1 }, github: { on: false } } });
  fx.app.run(`window.usageCalls = 0;
    usageSettingsRow = () => { window.usageCalls += 1; const row = document.createElement('div'); row.dataset.row = 'usage'; return row; };
    location = { hostname: 'localhost' };`);
  await fx.app.run('renderSettingsApp()');
  same(fx.view().children.map(one => one.dataset.row), ['version', 'check', 'backup', 'usage', 'access', 'place']);
  assert.equal(fx.app.run('window.usageCalls'), 1, '사용 통계 줄은 한 번만 만든다');
  assert.equal(fx.text(4), '다른 기기같은 와이파이에서접속 암호 복사같은 와이파이·Tailscale에서 이 주소를 열고, 사용자 이름은 workspace를 넣으면 돼요.');
  // 다시 그려도 줄이 둘이 되지 않는다
  await fx.app.run('renderSettingsApp()');
  assert.equal(fx.view().children.filter(one => one.dataset.row === 'usage').length, 1);
  // 버튼은 예전 도움말의 것과 같은 요청 · 같은 알림
  fx.app.run(`showNotice = (text, bad) => { window.lastNotice = [text, !!bad]; };`);
  fx.app.context.request = async url => new Response(JSON.stringify(url === '/api/access-token' ? { token: 'tok-1' } : {}));
  await fx.app.run("window.findByClass(document.getElementById('settingsAppView').children[4], 'd-btn')")[0].listeners.click();
  same(fx.copied.slice(-1), ['tok-1']);
  same(fx.app.run('window.lastNotice'), ['암호를 복사했어요 · 다른 기기에서 사용자 이름은 workspace를 넣어 주세요', false]);
  // 127.0.0.1도 이 맥이다
  fx.app.run(`location = { hostname: '127.0.0.1' };`);
  await fx.app.run('renderSettingsApp()');
  assert.ok(fx.view().children.some(one => one.dataset.row === 'access'));
});

test('설정 정리: 파일 위치 — 경로가 하나만 있으면 그것만, 둘 다 없으면 접이식 대신 한 줄', async () => {
  const onlyBackup = appClient({ about: { updateFile: undefined }, backup: { ok: true, path: '~/b/daily', local: { state: 'ok', at: backupAt(0), days: 1 }, github: { on: false } } });
  await onlyBackup.app.run('renderSettingsApp()');
  assert.equal(onlyBackup.text(3), '파일 위치찾을 때만경로 보기· 백업 폴더백업 폴더~/b/daily복사Finder에서 ⇧⌘G(폴더로 이동)에 붙여 넣으면 바로 가요');
  const onlyUpdate = appClient({ backup: null });
  await onlyUpdate.app.run('renderSettingsApp()');
  assert.equal(onlyUpdate.text(2), '데이터 백업매일 19:30백업 상태를 읽지 못했어요.');
  assert.match(onlyUpdate.text(3), /^파일 위치찾을 때만경로 보기· 업데이트 파일업데이트 파일~\/workspace\/업데이트\.command복사Finder/);
  const none = appClient({ about: { updateFile: '' }, backup: { ok: false } });
  await none.app.run('renderSettingsApp()');
  assert.equal(none.text(3), '파일 위치찾을 때만파일 위치를 읽지 못했어요.');
  assert.equal(none.view().children[3].dataset.row, 'place');
});

test('설정 정리: 창을 열면 초점은 창 자체(테 없음) · 이미 열린 창은 초점을 옮기지 않는다 · `점검하기` 표지면 그 버튼', async () => {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  assert.match(html, /<dialog id="settingsDialog" class="d-modal" aria-label="설정" tabindex="-1" autofocus>/);
  const css = fs.readFileSync(path.join(__dirname, 'ui.css'), 'utf8');
  assert.match(css, /#settingsDialog:focus \{ outline: none; \}/, '창 자체에만 테를 지운다');
  assert.match(css, /#settingsDialog \{ margin: min\(max\(32px, 8vh\), 120px\) auto auto; overflow: hidden; \}/, '윗변 고정 · 창은 스크롤하지 않는다');

  const fx = appClient({});
  fx.app.run(`settingsDialog.showModal = () => { settingsDialog.open = true; };
    window.dialogFocus = [];
    settingsDialog.focus = (options) => { settingsDialog.focused = true; window.dialogFocus.push(options); };
    renderSettingsIntegrations = async () => {}; escPush = () => 1;
    window.realRender = renderSettingsApp; renderSettingsApp = async () => {};`);
  fx.app.run("settingsOpen('app')");
  assert.equal(fx.app.run('settingsDialog.focused'), true, '창 자체가 초점을 받는다');
  same(fx.app.run('window.dialogFocus'), [{ preventScroll: true }]);
  fx.app.run("settingsOpen('guide')");
  assert.equal(fx.app.run('window.dialogFocus.length'), 1, '이미 열려 있으면 초점을 다시 옮기지 않는다(탭만 바꾼다)');
  // 도움말 `점검하기`처럼 갈 곳이 정해진 표지면 앱 탭이 그린 뒤 그 버튼으로 간다
  fx.app.run('settingsDialog.open = false');
  fx.app.run('renderSettingsApp = () => (window.appDone = window.realRender());');
  fx.app.run("settingsOpen('app', 'selfcheck')");
  await fx.app.run('window.appDone');
  assert.equal(fx.app.run('selfcheckMainButton.focused'), true);
  assert.equal(fx.app.run('settingsFocusKey'), null, '표지는 한 번만 쓴다');
});

test('WP-J C. 지난 소식 전체: 버전 줄 아래 접이식(기본 접힘) — 소식이 있을 때만, 버전마다 이름·날짜·줄', async () => {
  const withNews = appClient({
    about: {
      update: { available: false },
      news: [
        { version: '1.1.4', date: '2026-09-28', lines: ['Dock 아이콘을 눌러도 창이 하나만 떠요', '**굵게**도 돼요'] },
        { version: '1.1.0', date: '2026-09-24', lines: ['설정이 정리됐어요'] },
      ],
    },
  });
  await withNews.app.run('renderSettingsApp()');
  const history = withNews.app.nodes.get('settingsAboutHistory');
  assert.equal(history.hidden, false);
  assert.equal(history.className, 'd-dsec d-dadd');
  const summary = history.children[0];
  assert.equal(summary.className, 'lbl');
  const body = withNews.app.nodes.get('settingsAboutHistoryBody');
  assert.equal(body.className, 'inner d-newshist');
  assert.equal(body.children.length, 2);
  const first = body.children[0];
  const shapeText = expr => JSON.parse(withNews.app.run(`JSON.stringify(window.shapeOf(${expr}))`)).text;
  assert.equal(shapeText("document.getElementById('settingsAboutHistoryBody').children[0]"), 'v1.1.49월 28일Dock 아이콘을 눌러도 창이 하나만 떠요굵게도 돼요');
  assert.equal(first.children[0].className, 'hd');
  assert.equal(first.children[1].className, 'd-newslist');
  assert.equal(first.children[1].children[1].children[0].textContent, '굵게', '굵게는 <b> 요소다');
  assert.equal(body.children[1].children[0].children[0].textContent, 'v1.1.0', '두 번째 버전도 담긴다');

  // 소식이 없으면(옛 서버·소식.md 없음) 접이식 자체를 숨긴다
  const noNews = appClient({ about: { update: { available: false } } });
  await noNews.app.run('renderSettingsApp()');
  assert.equal(noNews.app.nodes.get('settingsAboutHistory').hidden, true);
});

test('WP-E D. 데이터 백업 줄: 로컬만 · GitHub 포함 · 실패(빨강 + 이유) · 아직 안 돎', async () => {
  const row = async (backup) => {
    const fx = appClient({ backup });
    await fx.app.run('renderSettingsApp()');
    return { text: fx.text(2), fx };
  };
  const both = await row({ ok: true, path: '~/workspace-data-backup/daily', local: { state: 'ok', at: backupAt(0), days: 3 }, github: { on: true, state: 'ok', at: backupAt(0) } });
  assert.match(both.text, /^데이터 백업매일 19:30 이 맥에 매일 백업 · 오늘 19:30 · 3일치GitHub 비공개 저장소에도 올려요 · 오늘 19:30$/, '경로는 이 줄이 아니라 파일 위치에');
  assert.equal(both.fx.find('d-bkline')[0].children[0].className, 'd-istat k-ok', '잘 되면 연동 카드와 같은 초록 점 부품');
  const gitFail = await row({ ok: true, path: '~/x/daily', local: { state: 'ok', at: backupAt(1), days: 7 }, github: { on: true, state: 'fail', at: backupAt(1), reason: '원격 업로드 실패 (이 맥의 백업 커밋은 남아 있음)' } });
  assert.match(gitFail.text, / GitHub에 올리지 못했어요 · 어제 19:30원격 업로드 실패 \(이 맥의 백업 커밋은 남아 있음\)/);
  const failed = await row({ ok: true, path: '~/x/daily', local: { state: 'fail', at: backupAt(0), reason: '파일을 복사하지 못함 (tasks.md)', days: 6 }, github: { on: false } });
  assert.match(failed.text, /^데이터 백업매일 19:30 이 맥 백업이 멈췄어요 · 오늘 19:30파일을 복사하지 못함 \(tasks\.md\)$/, '멈춰도 빨간 줄 + 이유는 백업 줄에 그대로, 경로만 파일 위치로');
  const line = failed.fx.find('d-bkline')[0];
  assert.equal(line.className, 'd-bkline k-neg');
  // 점은 연동 카드와 같은 부품(`.d-istat`의 점) — 10px 원 + 옅은 링, aria-hidden.
  assert.equal(line.children[0].className, 'd-istat k-stop');
  assert.equal(line.children[0].children[0].className, 'dot');
  assert.equal(line.children[0].children[0].getAttribute('aria-hidden'), 'true');
  assert.equal(failed.fx.find('k-neg').filter(one => one.className === 'd-ismall k-neg')[0].textContent, '파일을 복사하지 못함 (tasks.md)');
  // 아직 한 번도 안 돌았으면 — 19:30 전이면 오늘, 지났으면 내일
  const fx = appClient({});
  const never = { ok: true, path: '~/x/daily', local: { state: 'never', at: null, days: 0 }, github: { on: false } };
  const morning = JSON.parse(fx.app.run(`JSON.stringify(settingsBackupNodes(${JSON.stringify(never)}, new Date(2026, 8, 24, 9, 0)).map(one => one.textContent || one.children.map(k => k.textContent).join('')))`));
  assert.equal(morning[0], '오늘 19:30에 처음 백업해요');
  const night = JSON.parse(fx.app.run(`JSON.stringify(settingsBackupNodes(${JSON.stringify(never)}, new Date(2026, 8, 24, 20, 0)).map(one => one.textContent || one.children.map(k => k.textContent).join('')))`));
  assert.equal(night[0], '내일 19:30에 처음 백업해요');
  // 서버가 답하지 않으면 한 줄
  const none = await row(null);
  assert.equal(none.text, '데이터 백업매일 19:30백업 상태를 읽지 못했어요.');
  assert.equal(fx.app.run("settingsBackupWhen('2026-09-20 19:30:04', new Date(2026, 8, 24, 10, 0))"), '9월 20일 19:30');
});

test('WP-E 도움말: `상태 탭`을 가리키는 문구가 없고, 새 문답(채널 초대·채널 고르기·백업)이 있다', () => {
  const app = settingsClient({});
  app.run(NODE_SHAPE);
  app.run(`location = { hostname: 'example.com' };`);
  app.run('renderSettingsGuide()');
  const text = JSON.stringify(JSON.parse(app.run("JSON.stringify(window.shapeOf(document.getElementById('settingsGuideView')))")));
  const faq = app.run('JSON.stringify(SETTINGS_FAQ)');
  for (const where of [text, faq]) {
    assert.ok(!/상태<\/b> 탭|상태 탭|설정 &gt; 상태|설정 > 상태|설정 › 상태/.test(where), '옛 상태 탭을 가리키지 않는다');
  }
  assert.ok(faq.includes('이 채널들은 나만 있는 채널로 써요 — 다른 사람을 초대하면 그 사람이 쓴 메시지도 할 일로 들어와요.'));
  assert.match(faq, /⋯ › 채널 고르기/);
  assert.match(faq, /~\/workspace-data-backup\/daily/);
  assert.match(faq, /설정 &gt; 앱<\/b>의 <b>버전<\/b> 줄에 <b>업데이트 받기<\/b>/);
  // 화면 코드 어디에도 상태 탭으로 여는 길이 없다
  for (const file of ['settings-ui.js', 'app.js', 'meeting-notes-ui.js', 'attention-ui.js', 'jira-ui.js', 'index.html']) {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
    assert.ok(!/settingsOpen\('status'|data-settings-tab="status"|settingsStatusView/.test(source), `${file}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// QA 1.1.0 정정 2 — 점과 연동 탭이 한 기준 · 새로고침 뒤 되돌리기 · 첫 로드 파란 점 · 사라진 채널 · 첫 읽기 전

test('QA2 늦음 한 기준: syncLag가 톱니바퀴 주황 점과 연동 탭 요약·카드에 같은 답을 준다(연결 안 됨·첫 읽기 전은 늦음이 아니다)', async () => {
  const app = pureClient();
  const lag = (data, clock = '10:00', now = null) => JSON.parse(app.run(`JSON.stringify(syncLag(${JSON.stringify(data)}, { clock: '${clock}'${now ? `, now: ${now}` : ''} }))`));
  const day = days => app.run(`(() => { const d = new Date(); d.setDate(d.getDate() - ${days}); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })()`);
  const today = day(0);
  // 방금 연결한 슬랙(상태 파일 없음) — 기다리는 중이지 늦은 것이 아니다
  same(lag({ slackSync: { stale: true, lastSync: null, neverRead: true, connected: true, scheduled: true } }), { late: [], waiting: ['slack'] });
  // 수집이 launchd에 등록돼 있지 않으면 기다려도 읽지 않는다 — 늦은 쪽(setup)
  same(lag({ slackSync: { stale: true, lastSync: null, neverRead: true, connected: true, scheduled: false } }).late.map(one => [one.key, one.setup, one.text]), [['slack', true, '아직 읽기 전이에요']]);
  // 연결 안 된 것·쓰지 않는 것은 보지 않는다
  same(lag({ slackSync: { stale: true, lastSync: null, neverRead: true, connected: false, scheduled: false }, jiraSync: { used: false } }), { late: [], waiting: [] });
  // 마지막으로 읽은 시각을 알면 `N시간째`, 날짜만 알면 `어제부터`·`N일째`
  const now = Date.parse('2026-09-24T10:00:00');
  const late = lag({ slackSync: { stale: true, lastSync: day(1), lastSuccessAt: new Date(now - 15 * 3600000).toISOString(), connected: true }, calendar: { stale: true, lastSync: day(3) }, jiraSync: { stale: false, lastSync: today } }, '10:00', now).late;
  same(late.map(one => [one.key, one.name, one.text]), [['slack', '슬랙 수집', '15시간째 새로 읽지 못했어요'], ['calendar', '캘린더', '3일째 새로 읽지 못했어요']]);
  assert.equal(app.run(`syncLagText(null, 1)`), '어제부터 새로 읽지 못했어요');
  assert.equal(app.run(`syncLagText(new Date(Date.now() - 50 * 3600000).toISOString(), 3)`), '2일째 새로 읽지 못했어요');
  // 아침 첫 갱신 전의 `어제 기준`은 늦음이 아니다(점과 탭이 똑같이)
  same(lag({ calendar: { stale: true, lastSync: day(1) } }, '08:00').late, []);

  // 톱니바퀴: 첫 읽기 전이면 점이 없고, 툴팁은 카드 이름 + `연동 탭에서 봐요`
  const gear = data => JSON.parse(app.run(`(() => { nowHHMM = () => '10:00'; renderDateBar(${JSON.stringify({ today, ...data })}); const b = document.getElementById('settingsBtn'); return JSON.stringify({ label: b.getAttribute('aria-label'), title: b.title, keys: syncStale.map(one => one.key) }); })()`));
  same(gear({ slackSync: { stale: true, lastSync: null, neverRead: true, connected: true, scheduled: true }, calendar: { stale: false, lastSync: today }, jiraSync: { stale: false, lastSync: today } }).keys, []);
  const stale = gear({ calendar: { stale: true, lastSync: day(1) }, slackSync: { stale: false, lastSync: today }, jiraSync: { stale: false, lastSync: today } });
  assert.equal(stale.title, '설정 — 캘린더 어제 기준. 목록이 최신이 아닐 수 있어요. 누르면 연동 탭에서 봐요.');
  assert.doesNotMatch(stale.title, /슬랙 캡처|자세한 상태/);
});

test('paintGearBadge: 톱니바퀴 title·aria-label은 빨강(멈춘 연동) > 주황(낡음) > 파랑(새 버전) 한 우선순위로 한 곳에서 정하고, 다 풀리면 `설정`으로 돌아간다', () => {
  const app = pureClient();
  const gear = () => JSON.parse(app.run(`(() => { const b = document.getElementById('settingsBtn'); return JSON.stringify({ label: b.getAttribute('aria-label'), title: b.title }); })()`));
  // 아무 것도 없으면 평소 `설정`
  app.run(`settingsAlertKeys = []; syncStale = []; syncStaleSummary = ''; settingsAbout = null; paintGearBadge();`);
  same(gear(), { label: '설정', title: '설정' });
  // 파랑(새 버전)만
  app.run(`settingsAbout = { update: { available: true, label: 'v1.1.0' } }; paintGearBadge();`);
  same(gear(), { label: '설정 — 새 버전이 있어요', title: '설정 — 새 버전이 있어요' });
  // 주황(낡음)이 겹치면 파랑을 이긴다
  app.run(`syncStale = [{ key: 'calendar', text: '캘린더 어제 기준' }]; syncStaleSummary = '캘린더 어제 기준'; paintGearBadge();`);
  const orange = gear();
  assert.equal(orange.label, '설정 — 캘린더 어제 기준');
  assert.equal(orange.title, '설정 — 캘린더 어제 기준. 목록이 최신이 아닐 수 있어요. 누르면 연동 탭에서 봐요.');
  // 빨강(지금 멈춘 연동)이 겹치면 주황·파랑을 다 이긴다
  app.run(`settingsAlertKeys = ['slack', 'jira']; paintGearBadge();`);
  same(gear(), { label: '설정 — 연동 2개가 멈췄어요', title: '설정 — 연동 2개가 멈췄어요. 누르면 연동 탭에서 봐요.' });
  // 다 풀리면 다시 평소 `설정`
  app.run(`settingsAlertKeys = []; syncStale = []; syncStaleSummary = ''; settingsAbout = null; paintGearBadge();`);
  same(gear(), { label: '설정', title: '설정' });
});

test('QA2 연동 탭: 늦은 카드는 주황 `늦어요` + `다시 시도` + 요약 `N개가 늦어요`, 주황 점을 누르면 그 카드가 주황 판으로 잠깐 밝아진다', async () => {
  const today = new Date();
  const two = n => String(n).padStart(2, '0');
  const day = d => { const t = new Date(Date.now() - d * 86400000); return `${t.getFullYear()}-${two(t.getMonth() + 1)}-${two(t.getDate())}`; };
  const fx = wpd25();
  fx.payload.sync = {
    slackSync: { stale: true, lastSync: day(1), lastSuccessAt: new Date(Date.now() - 20 * 3600000).toISOString(), connected: true, scheduled: true },
    calendar: { stale: false, lastSync: day(0), live: true },
    jiraSync: { stale: false, lastSync: day(0), live: true, connected: true },
  };
  fx.app.run(`nowHHMM = () => '10:00'; settingsFocusKey = 'stale';`);
  await fx.app.run('renderSettingsIntegrations()');
  const head = fx.view().children[0];
  assert.equal(fx.shape("document.getElementById('settingsIntegrationsView').children[0]").text, '1개가 늦어요연결됨 4 · 남은 것 0');
  assert.equal(head.children[0].className, 'd-istat k-late');
  same(statOf(fx, 'slack'), ['d-istat k-late', '늦어요']);
  assert.equal(fetchButton(fx, 'slack').hidden, false);
  assert.equal(fetchButton(fx, 'slack').textContent, '다시 시도', '예정보다 늦으면 다시 시도(새로 받기와 같은 길)');
  assert.equal(fx.shape(`window.findByClass(document.getElementById('settingsIntegrationsView').children[1], 'now')[0]`).text, '20시간째 새로 읽지 못했어요');
  assert.equal(fx.card('slack').dataset.late, 'true');
  assert.match(fx.card('slack').className, /\bis-flash\b.*\bis-warn\b/, '주황 점을 누르고 들어오면 늦은 카드만 주황 판');
  assert.ok(!/is-flash/.test(fx.card('jira').className));
  // 점도 방금 읽은 같은 값으로 맞춘다
  same(fx.app.run('syncStale.map(one => one.key)'), ['slack']);
  // 톱니바퀴: 주황 점이면 연동 탭 + stale 표지
  fx.app.run(`settingsAlertKeys = []; document.getElementById('settingsBtn').classList.contains = cls => cls === 'has-stale';`);
  same(fx.app.run('settingsGearTab()'), ['integrations', 'stale']);
  const css = fs.readFileSync(path.join(__dirname, 'ui.css'), 'utf8');
  assert.match(css, /\.d-intg\.is-flash\.is-warn \{ background: var\(--warn-bg\); \}/);
  assert.match(css, /\.d-istat\.k-late \{ color: var\(--warn\); \}/);

  // 멈춘 카드는 빨강이 이긴다(늦음으로 세지 않는다)
  const bad = wpd25({ slack: { ...WPD25_CONNECTED.slack, fetch: { failing: true, auth: true, failedAt: ago(3) } } });
  bad.payload.sync = fx.payload.sync;
  bad.app.run(`nowHHMM = () => '10:00';`);
  await bad.app.run('renderSettingsIntegrations()');
  assert.equal(bad.shape("document.getElementById('settingsIntegrationsView').children[0]").text, '1개가 멈췄어요연결됨 4 · 남은 것 0');
});

test('QA2 첫 읽기 전: 요약 `N개 연결됨 · 슬랙은 곧 읽어요`, 카드 `연결됨 · 곧 읽어요`(흐린 초록) — 수집이 등록 안 됐으면 주황으로 업데이트.command 안내', async () => {
  const two = n => String(n).padStart(2, '0');
  const t = new Date();
  const today = `${t.getFullYear()}-${two(t.getMonth() + 1)}-${two(t.getDate())}`;
  const waiting = wpd25();
  waiting.payload.sync = {
    slackSync: { stale: true, lastSync: null, neverRead: true, connected: true, scheduled: true },
    calendar: { stale: false, lastSync: today, live: true },
    jiraSync: { stale: false, lastSync: today, live: true, connected: true },
  };
  await waiting.app.run('renderSettingsIntegrations()');
  assert.equal(waiting.shape("document.getElementById('settingsIntegrationsView').children[0]").text, '4개 연결됨 · 슬랙은 곧 읽어요연결됨 4 · 남은 것 0');
  assert.equal(waiting.view().children[0].children[0].className, 'd-istat k-ok');
  same(statOf(waiting, 'slack'), ['d-istat k-soon', '연결됨 · 곧 읽어요']);
  assert.equal(waiting.shape(`window.findByClass(document.getElementById('settingsIntegrationsView').children[1], 'now')[0]`).text, '#my-todo · 5분 전 읽음', '지금 상황 줄은 평소 그대로');
  assert.equal(waiting.find('slack', 'd-intgwhy').length, 0);
  assert.doesNotMatch(waiting.shape("document.getElementById('settingsIntegrationsView').children[0]").text, /모두 잘 읽고 있어요/, '읽기 전인데 잘 읽는다고 하지 않는다');

  const setup = wpd25();
  setup.payload.sync = { ...waiting.payload.sync, slackSync: { ...waiting.payload.sync.slackSync, scheduled: false } };
  await setup.app.run('renderSettingsIntegrations()');
  assert.equal(setup.shape("document.getElementById('settingsIntegrationsView').children[0]").text, '1개가 늦어요연결됨 4 · 남은 것 0');
  same(statOf(setup, 'slack'), ['d-istat k-late', '늦어요']);
  const line = setup.find('slack', 'd-intgwhy')[0];
  assert.equal(line.className, 'd-intgwhy k-warn');
  assert.equal(line.textContent, '업데이트.command를 한 번 실행하면 수집이 시작돼요');
});

test('QA2 새로고침 뒤 업데이트 실패: ③ 이후면 실패 줄 + 되돌리기, ①②면 다시 시도, 되돌리기가 끝났거나 뒤에 성공한 업데이트가 있으면 없다', () => {
  const app = pureClient();
  const left = data => JSON.parse(app.run(`JSON.stringify(settingsUpdateLeftover(${JSON.stringify(data)}))`));
  const failed = (step, extra = {}) => ({ status: { action: 'update', step, state: 'failed', message: '데이터 형식을 바꾸지 못했어요' }, running: false, updateFile: '~/workspace/업데이트.command', ...extra });
  same(left(failed(4, { rollback: true, settled: false })), { kind: 'failed', action: 'update', step: 4, message: '데이터 형식을 바꾸지 못했어요', updateFile: '~/workspace/업데이트.command' });
  assert.equal(left(failed(4, { rollback: false, settled: false })), null, '서버가 되돌리기를 받지 않으면 보이지 않는다');
  assert.equal(left(failed(4, { rollback: false, settled: true })), null, '뒤에 다른 업데이트가 끝까지 돌았으면 지난 일이다');
  assert.equal(left(failed(2, { rollback: false, settled: false })).step, 2, '①② 실패는 다시 시도로');
  assert.equal(left(failed(2, { settled: true })), null);
  assert.equal(left({ status: { action: 'rollback', step: 6, state: 'done' }, rollback: false }), null, '되돌리기가 끝났으면 없다');
  assert.equal(left({ status: { action: 'update', step: 6, state: 'done' } }), null);
  assert.equal(left({ status: null }), null);
  assert.equal(left(failed(4, { status: { action: 'rollback', step: 2, state: 'failed', message: 'x' } })).action, 'rollback', '되돌리기 자체의 실패는 그 줄');
});

test('QA2 새로고침 뒤 업데이트 실패: 앱 탭을 열면 상태 파일의 실패를 다시 그린다', async () => {
  const fx = updateClient(D3_ABOUT, { status: () => ({ ...d3Status('failed', 4, { message: '데이터 형식을 바꾸지 못했어요' }), rollback: true, settled: false }) });
  fx.app.run('settingsAboutFill()');
  await fx.flush();
  await fx.flush();
  assert.match(fx.text(), /업데이트하지 못했어요 — 데이터 형식을 바꾸지 못했어요/);
  assert.match(fx.text(), /이전 버전으로 되돌리기/);
});

test('QA2 파란 점: 페이지를 열 때 `?cached=1`로 한 번, 그 뒤 1시간마다(WP-U) — 설정을 열지 않아도 켜진다', async () => {
  const script = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  const boot = script.slice(script.indexOf(DEFINITIONS_MARKER));
  assert.match(boot, /settingsAboutLoad\(\{ cached: true \}\)/);
  assert.match(boot, /setInterval\(\(\) => settingsAboutLoad\(\{ cached: true \}\)\.then\(renderUpdateNotice\), 60 \* 60 \* 1000\)/);
  const fx = intgClient();
  const asked = [];
  fx.app.context.fetch = async (url) => { asked.push(String(url)); return new Response(JSON.stringify({ version: '1.0.0', update: { available: true, label: 'v1.1.0' } }), { status: 200 }); };
  let lit = false;
  fx.app.run(`document.getElementById('settingsBtn').classList.toggle = (cls, on) => { if (cls === 'has-update') window.__lit = on; };`);
  await fx.app.run('settingsAboutLoad({ cached: true })');
  lit = fx.app.run('window.__lit');
  same(asked, ['/api/about?cached=1']);
  assert.equal(lit, true);
  // 못 읽으면 조용히 가진 값을 둔다(알림을 띄우지 않는다)
  fx.app.context.fetch = async () => { throw new TypeError('offline'); };
  await fx.app.run('settingsAboutLoad({ cached: true })');
  assert.equal(fx.app.run('settingsHasUpdate()'), true);
});

test('QA2 사라진 채널: 뺐던 채널을 다시 체크했는데 서버가 channel_gone이면 그 줄이 곧바로 새로 만들기(기본 이름 = 원래 이름)', async () => {
  const fx = await intgPick({
    off: { align: { name: '#my-align' } },
  }, [{ status: 400, body: { ok: false, code: 'channel_gone', key: 'align', error: '#my-align 채널을 찾을 수 없어요 — 슬랙에서 지웠거나 보관했어요. 체크한 채로 두면 새로 만들어요' } }]);
  await pickToggle(fx, 'align', true);
  assert.equal(pickGo(fx).textContent, '1개 다시 연결하기');
  await pickGo(fx).listeners.click();
  assert.match(pickText(fx, 'align'), /#my-align 채널을 찾을 수 없어요 — 같은 이름으로 새로 만들어요/);
  const row = pickRow(fx, 'align');
  assert.equal(row.className, 'd-ich is-on is-gone');
  const field = row.children[2];
  assert.equal(field.className, 'nmwrap', '이름 칸이 열린다');
  assert.equal(field.children[1].value, 'my-align', '기본 이름은 원래 이름');
  assert.equal(field.children[1].focused, true, '초점은 그 칸');
  assert.equal(pickGo(fx).textContent, '1개 만들기');
  assert.equal(fx.find('slack', 'd-derr').map(one => one.textContent).join(''), '', '막다른 오류 줄은 남기지 않는다');

  // 슬랙에 닿지 못한 것은 사라진 것과 다르다 — 줄은 그대로, 다시 누르라는 말만
  const offline = await intgPick({
    off: { align: { name: '#my-align' } },
  }, [{ status: 400, body: { ok: false, code: 'slack_unreachable', key: 'align', error: '슬랙에 연결하지 못했어요 — 잠시 뒤 다시 눌러 주세요' } }]);
  await pickToggle(offline, 'align', true);
  await pickGo(offline).listeners.click();
  assert.match(pickText(offline, 'align'), /다시 연결해요 — 뺀 동안 온 메시지는 가져오지 않아요/);
  assert.match(offline.text('slack'), /슬랙에 연결하지 못했어요 — 잠시 뒤 다시 눌러 주세요/);
});

test('QA2 할 일 채널 예시: 도움말은 저장된 이름, 모르면 `#이름-todo` — `#my-todo`를 사람의 채널처럼 적지 않는다', () => {
  const app = pureClient();
  const faq = JSON.parse(app.run('JSON.stringify(SETTINGS_FAQ)'));
  const all = JSON.stringify(faq);
  assert.doesNotMatch(all, /#my-todo/);
  assert.equal((all.match(/\{todo\}/g) || []).length, 2);
  assert.equal(app.run('settingsTodoName()'), '#이름-todo');
  app.run(`settingsIntegrations = { slack: { channels: { todo: { id: 'C1', name: '#hana-todo' } } } }`);
  assert.equal(app.run('settingsTodoName()'), '#hana-todo');
  // 할 일을 켜지 않았으면 그 사람이 켠 첫 채널 이름으로(화면 차례: 할 일 · 기다리는 것 · 정해진 것 · 언젠가)
  app.run(`settingsIntegrations = { slack: { channels: { todo: { id: '', name: '' }, align: { id: 'C3', name: '#hana-align' }, waiting: { id: 'C2', name: '#hana-waiting' } } } }`);
  assert.equal(app.run('settingsTodoName()'), '#hana-waiting');
  assert.equal(app.run(`settingsChannelObject('#hana-todo')`), '#hana-todo 채널을');
  assert.equal(app.run(`settingsChannelObject('')`), '채널을');
});

test('슬랙 토큰 모양: xapp-·엉뚱한 토큰은 그 자리에서 알리고, xoxp- 입력 중에는 조용하다', () => {
  const fx = intgClient({});
  assert.match(fx.app.run("settingsSlackTokenShape('xapp-1-A0-1')"), /앱 수준 토큰/);
  assert.match(fx.app.run("settingsSlackTokenShape('xoxb-1')"), /Bot 토큰/);
  assert.match(fx.app.run("settingsSlackTokenShape('abc')"), /xoxp-로 시작해요/);
  assert.equal(fx.app.run("settingsSlackTokenShape('xox')"), '', '치는 중인 앞부분은 기다린다');
  assert.equal(fx.app.run("settingsSlackTokenShape('xoxp-1-2')"), '');
});

// ─────────────────────────────────────────────────────────────────────────────
// WP-K 설정 › 앱 › 점검하기(시안 A~C) · 도움말 `문제가 생겼어요`(시안 D)

const SC_BAD = {
  ok: true, at: '2026-09-28T05:05:00.000Z', version: '1.1.5', offline: false,
  skipped: ['회의록', '캘린더'],
  items: [
    { key: 'version', label: '앱 버전', state: 'ok', detail: 'v1.1.5 · 최신이에요' },
    { key: 'install', label: '설치 위치', state: 'ok', detail: '~/workspace' },
    { key: 'claude', label: 'Claude Code 로그인', state: 'bad', detail: '최근 슬랙 수집이 "로그인이 풀렸어요"로 실패했어요 · 오늘 10:05 기준', fix: { text: '① 아래 명령을 복사해 터미널에서 실행 ② 그 토큰을 설정 › 연동의 멈춘 카드 칸에 붙여 저장', command: 'claude setup-token' } },
    { key: 'slack_channels', label: '슬랙 채널', state: 'ok', detail: '#hana-todo 외 1개 · 모두 읽혀요', copy: '켜진 채널 2개 · 모두 읽혀요' },
    { key: 'slack', label: '슬랙 수집', state: 'bad', sameAs: 'claude', detail: 'Claude Code 로그인이 풀려서 멈췄어요', lag: 'slack' },
    { key: 'jira', label: '지라', state: 'ok', detail: '하나님 · 방금 확인', copy: '연결돼요 · 방금 확인', lag: 'jira' },
    { key: 'agents', label: '자동 실행 등록', state: 'warn', detail: '/Users/hana/x someone@example.test', fix: { text: '업데이트 파일(앱을 새로 받고 다시 켜 주는 파일)을 한 번 실행해 주세요', command: 'bash ~/workspace/업데이트.command', finder: '~/workspace/업데이트.command' } },
  ],
  sync: { slackSync: { used: false }, jiraSync: { used: false }, calendar: { used: false } },
};
const SC_GOOD = {
  ok: true, at: '2026-09-28T05:05:00.000Z', version: '1.1.5', offline: false, skipped: [],
  items: [
    { key: 'version', label: '앱 버전', state: 'ok', detail: 'v1.1.5 · 최신이에요' },
    { key: 'backup', label: '데이터 백업', state: 'unknown', detail: '오늘 19:30에 처음 해요' },
  ],
  sync: { slackSync: { used: false }, jiraSync: { used: false }, calendar: { used: false } },
};

// 앱 탭 가짜 창 + GET /api/selfcheck 답(부를 때마다 차례로 줄 수 있다).
function scClient(answers, { blocked = false } = {}) {
  const fx = appClient({});
  const list = Array.isArray(answers) ? answers : [answers];
  let asked = 0;
  const base = fx.app.context.fetch;
  fx.app.context.fetch = async (url, options) => {
    if (String(url) === '/api/selfcheck') {
      const body = list[Math.min(asked, list.length - 1)];
      asked += 1;
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return base(url, options);
  };
  if (blocked) fx.app.context.navigator = { clipboard: { writeText: async () => { throw new Error('denied'); } } };
  const slot = () => fx.app.nodes.get('selfcheckResult');
  const slotText = () => JSON.parse(fx.app.run("JSON.stringify(window.shapeOf(document.getElementById('selfcheckResult')))")).text;
  const button = () => fx.app.run('selfcheckMainButton');
  return { ...fx, asked: () => asked, slot, slotText, button };
}
const scKid = (fx, cls) => fx.slot().children.find(one => String(one.className).split(' ').includes(cls));

test('WP-K A. 앱 탭 `점검` 줄: 점검하기 + 문제 보고 복사, 결과 자리는 비어 있다가 누르면 같은 자리 아래 펼친다', async () => {
  const fx = scClient(SC_BAD);
  await fx.app.run('renderSettingsApp()');
  const row = fx.view().children[1];
  assert.equal(row.dataset.row, 'check', '점검은 버전 바로 아래 둘째 줄');
  assert.equal(fx.button().textContent, '점검하기');
  assert.equal(fx.slot().hidden, true);
  assert.equal(fx.slot().getAttribute('aria-live'), 'polite');
  await fx.button().listeners.click();
  assert.equal(fx.asked(), 1);
  assert.equal(fx.slot().hidden, false);
});

test('WP-K B. 문제가 있을 때: 요약은 ✗만 센다(같은 원인은 한 번) + warn은 따로 · 고치는 법은 문제 줄에만 · 명령 복사 · 연결 안 한 것 한 줄', async () => {
  const fx = scClient(SC_BAD);
  await fx.app.run('renderSettingsApp()');
  await fx.button().listeners.click();
  const kids = fx.slot().children;
  assert.equal(kids[0].className, 'd-scsum');
  assert.equal(kids[0].children[0].textContent, '● 1개를 고치면 돼요', 'Claude 로그인과 그 때문에 멈춘 수집은 한 번만 센다');
  assert.equal(kids[0].children[1].textContent, '방금 점검 · v1.1.5');
  assert.equal(kids[1].textContent, '확인해 보면 좋아요 1개');
  const rows = scKid(fx, 'd-sclist').children;
  same(rows.map(one => [one.dataset.key, one.className, one.children.length]), [
    ['version', 'ok', 3], ['install', 'ok', 3], ['claude', 'bad', 4], ['slack_channels', 'ok', 3], ['slack', 'bad', 3], ['jira', 'ok', 3], ['agents', 'warn', 4],
  ]);
  assert.equal(rows[2].children[0].textContent, '✗');
  assert.equal(rows[2].children[1].className, 'sr-only');
  const fix = rows[2].children[3];
  assert.equal(fix.className, 'fix');
  assert.equal(fix.children[0].textContent, '고치는 법');
  const command = fix.children[2];
  assert.equal(command.className, 'd-icode');
  assert.equal(command.children[1].textContent, '명령 복사');
  await command.children[1].listeners.click();
  same(fx.copied, ['claude setup-token']);
  // 업데이트 파일은 무엇인지 + 한 줄 명령 + Finder 길
  const upd = rows[6].children[3];
  assert.match(upd.children[1].textContent, /업데이트 파일\(앱을 새로 받고 다시 켜 주는 파일\)/);
  assert.equal(upd.children[2].children[0].textContent, 'bash ~/workspace/업데이트.command');
  assert.equal(upd.children[3].textContent, 'Finder: ⇧⌘G → 경로 붙여 넣기 → 더블클릭 (~/workspace/업데이트.command)');
  assert.equal(scKid(fx, 'd-scskip').textContent, '연결 안 한 것: 회의록 · 캘린더 — 필요하면 설정 › 연동에서 켜요');
  same(scKid(fx, 'd-scfoot').children.map(one => one.textContent), ['다시 점검', '결과 복사 → 만든 사람에게 보내기']);
});

test('WP-K C. 모두 정상: `✓ 모두 정상이에요` + 목록은 `자세히 보기` 접이식(? 줄은 문제로 세지 않는다) · 확인해 볼 것만 있으면 주황 요약', async () => {
  const fx = scClient(SC_GOOD);
  await fx.app.run('renderSettingsApp()');
  await fx.button().listeners.click();
  const kids = fx.slot().children;
  assert.equal(kids[0].className, 'd-scsum is-good');
  assert.equal(kids[0].children[0].textContent, '✓ 모두 정상이에요');
  const more = kids[1];
  assert.equal(more.className, 'd-dsec d-dadd d-scall');
  assert.ok(!more.open, '기본은 접혀 있다');
  assert.equal(more.children[0].children[0].textContent, '2개 항목을 확인했어요 · 자세히 보기');
  assert.equal(more.children[1].children[1].className, 'unknown');
  const warnOnly = { ...SC_GOOD, items: [...SC_GOOD.items, { key: 'install', label: '설치 위치', state: 'warn', detail: '바탕화면', fix: { text: '옮겨 주세요' } }] };
  const fx2 = scClient(warnOnly);
  await fx2.app.run('renderSettingsApp()');
  await fx2.button().listeners.click();
  assert.equal(fx2.slot().children[0].className, 'd-scsum is-warn');
  assert.equal(fx2.slot().children[0].children[0].textContent, '확인해 보면 좋아요 1개');
});

test('WP-K 오프라인: 맨 위 한 줄 `인터넷 연결을 확인해 주세요`, 그 줄들은 – (문제로 세지 않는다)', async () => {
  const off = { ...SC_GOOD, offline: true, items: [{ key: 'jira', label: '지라', state: 'offline', detail: '닿지 못했어요' }, { key: 'slack_token', label: '슬랙 토큰', state: 'offline', detail: '닿지 못했어요' }] };
  const fx = scClient(off);
  await fx.app.run('renderSettingsApp()');
  await fx.button().listeners.click();
  const kids = fx.slot().children;
  assert.equal(kids[0].className, 'd-scoff');
  assert.equal(kids[0].children[0].textContent, '인터넷 연결을 확인해 주세요');
  assert.equal(kids[0].getAttribute('role'), 'alert');
  assert.equal(kids[1].children[0].textContent, '✓ 인터넷 말고는 모두 정상이에요', '닿지 못한 줄이 있으면 "모두 정상"이라 하지 않는다');
  assert.equal(fx.app.run(`selfcheckCopyText(${JSON.stringify(off)}, ${JSON.stringify(off.items)})`).split('\n')[1], '인터넷 연결을 확인해 주세요 · 인터넷 말고는 모두 정상이에요');
});

test('WP-K 잠금: 점검 중·앱 안 업데이트 중·30초 안에는 버튼이 잠기고 서버에 다시 묻지 않는다 — 다시 점검해도 같은 ✗면 보내기 안내', async () => {
  const fx = scClient([SC_BAD, SC_BAD]);
  await fx.app.run('renderSettingsApp()');
  fx.app.run('settingsUpdateRun = { action: "update" }; selfcheckPaintButtons()');
  assert.equal(fx.button().disabled, true);
  assert.equal(fx.button().title, '업데이트하는 동안에는 점검할 수 없어요');
  assert.equal(await fx.app.run('selfcheckStart()'), false);
  assert.equal(fx.asked(), 0);
  fx.app.run('settingsUpdateRun = null; selfcheckPaintButtons()');
  assert.equal(fx.button().disabled, false);
  const running = fx.app.run('selfcheckStart()');
  assert.equal(fx.button().disabled, true, '점검 중에는 잠긴다');
  assert.equal(fx.button().textContent, '점검하는 중…');
  await running;
  assert.equal(fx.button().disabled, true, '30초 안에는 다시 점검할 수 없다');
  assert.equal(fx.button().title, '30초에 한 번 다시 점검할 수 있어요');
  assert.equal(scKid(fx, 'd-scfoot').children[0].disabled, true);
  assert.equal(await fx.app.run('selfcheckStart()'), false);
  assert.equal(fx.asked(), 1);
  assert.ok(!fx.slotText().includes('그래도 안 되면'), '첫 점검에는 보내기 안내가 없다');
  fx.app.run('selfcheckState.doneAt = Date.now() - 31000; selfcheckPaintButtons()');
  assert.equal(fx.button().disabled, false);
  assert.equal(await fx.app.run('selfcheckStart()'), true);
  assert.equal(fx.asked(), 2);
  assert.equal(scKid(fx, 'd-scagain').textContent, '그래도 안 되면 결과를 복사해 만든 사람에게 보내 주세요');
});

test('WP-K 결과 복사: 이름·상태·문구·버전·시각만 — 채널·지라 이름은 개수·고정 문구, 경로는 ~, 이메일은 가림 · 클립보드가 막히면 골라진 글 상자', async () => {
  const fx = scClient(SC_BAD);
  await fx.app.run('renderSettingsApp()');
  await fx.button().listeners.click();
  await scKid(fx, 'd-scfoot').children[1].listeners.click();
  assert.equal(fx.copied.length, 1);
  const text = fx.copied[0];
  const lines = text.split('\n');
  assert.match(lines[0], /^워크스페이스 점검 · v1\.1\.5 · 2026-09-2\d \d{2}:05$/);
  assert.equal(lines[1], '1개를 고치면 돼요 · 확인해 보면 좋아요 1개');
  assert.ok(lines.includes('✓ 슬랙 채널 (정상) — 켜진 채널 2개 · 모두 읽혀요'));
  assert.ok(lines.includes('✓ 지라 (정상) — 연결돼요 · 방금 확인'));
  assert.ok(lines.includes('! 자동 실행 등록 (확인해 보면 좋아요) — ~/x …'));
  assert.equal(lines[lines.length - 1], '연결 안 한 것: 회의록 · 캘린더');
  for (const secret of ['#hana-todo', '하나님', 'hana', 'someone@', 'mkdir', 'bash ~/', '고치는 법']) assert.ok(!text.includes(secret), secret);

  const blocked = scClient(SC_BAD, { blocked: true });
  await blocked.app.run('renderSettingsApp()');
  await blocked.button().listeners.click();
  assert.equal(await blocked.app.run('selfcheckCopy()'), false);
  const kids = blocked.slot().children;
  const area = kids[kids.length - 1];
  assert.equal(area.className, 'd-din d-scfallback');
  assert.equal(area.readOnly, true);
  assert.equal(area.selected, true, '글이 골라진 채로 보인다');
  assert.equal(area.value, blocked.app.run('selfcheckCopyText(selfcheckState.result, selfcheckState.items)'));
  assert.equal(kids[kids.length - 2].textContent, '복사가 막혀 있어요 — 아래 글이 골라져 있으니 ⌘C로 복사해 주세요');
});

test('WP-K 판단 일치: 늦음은 syncLag(톱니바퀴 주황 점·연동 탭)와 같은 답 — ✓ 줄만 !로, 첫 읽기 전은 ?, ✗는 그대로', () => {
  const app = pureClient();
  const two = n => String(n).padStart(2, '0');
  const day = d => { const t = new Date(Date.now() - d * 86400000); return `${t.getFullYear()}-${two(t.getMonth() + 1)}-${two(t.getDate())}`; };
  const sync = {
    slackSync: { stale: true, lastSync: day(2), connected: true, scheduled: true },
    jiraSync: { stale: true, lastSync: null, neverRead: true, connected: true },
    calendar: { stale: true, lastSync: day(3) },
  };
  const result = { items: [
    { key: 'slack', label: '슬랙 수집', state: 'ok', detail: '마지막 수집', lag: 'slack' },
    { key: 'jira', label: '지라', state: 'ok', detail: '하나님 · 방금 확인', copy: '연결돼요', lag: 'jira' },
    { key: 'calendar', label: '캘린더', state: 'bad', detail: '비밀 주소를 읽을 수 없어요', lag: 'calendar' },
    { key: 'node', label: 'Node', state: 'ok', detail: 'v22' },
  ], sync };
  const merged = JSON.parse(app.run(`JSON.stringify(selfcheckApplyLag(${JSON.stringify(result)}, { clock: '10:00' }))`));
  const lag = JSON.parse(app.run(`JSON.stringify(syncLag(${JSON.stringify(sync)}, { clock: '10:00' }))`));
  same(merged.filter(item => item.state === 'warn').map(item => item.lag), lag.late.map(one => one.key).filter(key => key !== 'calendar'));
  assert.equal(merged[0].detail, lag.late.find(one => one.key === 'slack').text, '문구도 연동 탭 카드와 같다');
  assert.match(merged[0].fix.text, /⋯ › 새로 받기/);
  same([merged[1].state, merged[1].detail, 'copy' in merged[1]], ['unknown', '아직 알 수 없어요 — 첫 읽기를 기다려요', false]);
  assert.ok(lag.waiting.includes('jira'));
  assert.equal(merged[2].state, 'bad', '멈춘 줄은 빨강이 이긴다(연동 탭과 같다)');
  assert.equal(merged[3].state, 'ok');
  // 연동 탭의 늦음(settingsIntgLagFrom — 멈춘 카드는 뺀다)과도 같은 답
  app.run(`nowHHMM = () => '10:00'`);
  const tab = JSON.parse(app.run(`JSON.stringify(settingsIntgLagFrom({ sync: ${JSON.stringify(sync)}, slack: { enabled: true, hasToken: true, channels: { todo: { id: 'C1' } } }, jira: { enabled: true, hasToken: true, siteUrl: 'https://x' }, calendar: { enabled: true }, meetingNotes: { mode: 'manual' } }, ['calendar']))`));
  assert.deepEqual(tab.late.map(one => one.key), ['slack']);
  assert.deepEqual(tab.waiting, ['jira']);
});

test('WP-K 판단 일치: "연결했나"는 연동 탭 settingsIntgConnected와 서버 connectedFlags가 같은 입력에 같은 답', () => {
  const app = pureClient();
  const { connectedFlags } = require('./selfcheck');
  const cases = [
    {},
    { slack: { enabled: true, hasToken: true, channels: { todo: { id: '' }, waiting: { id: 'C2' } } }, jira: { enabled: true, hasToken: false, siteUrl: 'https://x' }, calendar: { enabled: false }, meetingNotes: { mode: 'tiro' } },
    { slack: { enabled: true, hasToken: false, channels: { todo: { id: 'C1' } } }, jira: { enabled: true, hasToken: true, siteUrl: 'https://x' }, calendar: { enabled: true, source: 'ical' }, meetingNotes: { mode: 'manual' } },
    { slack: { enabled: false, hasToken: true, channels: { todo: { id: 'C1' } } }, jira: { enabled: true, hasToken: true, siteUrl: '' }, calendar: { enabled: true }, meetingNotes: { mode: 'other' } },
  ];
  cases.forEach((data) => {
    same(JSON.parse(app.run(`JSON.stringify(settingsIntgConnected(${JSON.stringify(data)}))`)), connectedFlags(data));
  });
});

test('WP-K D. 도움말 맨 위 `문제가 생겼어요`: 첫 줄은 점검하기로 데려가고, 증상 접이식 여섯 · 업데이트 파일은 무엇인지 + 한 줄 명령 + Finder 길', async () => {
  const app = settingsClient({});
  app.run(NODE_SHAPE);
  app.run(`location = { hostname: 'example.com' };`);
  app.run(`settingsAbout = { updateFile: '~/workspace/업데이트.command' }`);
  const copied = [];
  app.context.navigator = { clipboard: { writeText: async (text) => { copied.push(text); } } };
  app.run('renderSettingsGuide()');
  const box = app.nodes.get('settingsGuideView').children[0].children[0];
  assert.equal(box.className, 'd-trouble');
  assert.equal(box.getAttribute('aria-label'), '문제가 생겼어요');
  assert.equal(box.children[0].textContent, '문제가 생겼어요');
  const lead = box.children[1];
  assert.equal(lead.children.map(one => one.textContent).join(''), '먼저 설정 › 앱 › 점검하기 — 무엇이 안 되는지와 고치는 법을 한 번에 보여 줘요');
  const questions = box.children.slice(2);
  same(questions.map(one => one.children[0].children[0].textContent), [
    '슬랙 메시지가 할 일로 안 들어와요', '앱이 안 열려요 / 흰 화면이에요', '새 버전이 안 떠요',
    '창이 여러 개 떠요', '설치 파일이 “열지 않음”으로 막혀요', '캘린더 일정이 안 보여요',
  ]);
  assert.equal(questions[0].open, true, '첫 증상만 펼쳐 둔다');
  assert.equal(questions[0].className, 'd-dadd d-trq');
  const text = node => JSON.parse(app.run(`JSON.stringify(window.shapeOf(${node}))`)).text;
  const first = text("document.getElementById('settingsGuideView').children[0].children[0].children[2].children[1]");
  assert.match(first, /“로그인이 풀렸어요” → 설정 › 앱 › 점검하기가 고치는 법을 보여 줘요/);
  assert.match(first, /User OAuth Token\(xoxp-\)/);
  const open = text("document.getElementById('settingsGuideView').children[0].children[0].children[3].children[1]");
  assert.match(open, /그래도 안 되면 업데이트 파일\(앱을 새로 받고 다시 켜 주는 파일\)을 실행해요 — 앱을 다시 켜 줘요bash ~\/workspace\/업데이트\.command명령 복사Finder: ⇧⌘G → 경로 붙여 넣기 → 더블클릭 \(~\/workspace\/업데이트\.command\)/);
  assert.doesNotMatch(open, /업데이트\.command를 더블클릭/, '파일 이름만 던지지 않는다');
  const upd = questions[1].children[1].children[1].children.find(one => String(one.className).includes('d-trupd'));
  await upd.children[0].children[1].listeners.click();
  same(copied, ['bash ~/workspace/업데이트.command']);
  // `점검하기`는 앱 탭으로 가서 그 버튼에 초점
  app.run(`settingsSetTab = tab => { window.wentTo = tab; }`);
  lead.children[1].listeners.click();
  assert.equal(app.run('window.wentTo'), 'app');
  assert.equal(app.run('settingsFocusKey'), 'selfcheck');
  // 경로에 띄어쓰기가 있으면 따옴표로
  assert.equal(app.run(`selfcheckShellPath('~/내 폴더/업데이트.command')`), "~/'내 폴더/업데이트.command'");
  // 기존 문답도 새 버튼 이름을 쓴다
  assert.match(app.run('JSON.stringify(SETTINGS_FAQ)'), /점검하기<\/b>로 무엇이 안 되는지와 고치는 법을 봐요/);
  assert.doesNotMatch(app.run('JSON.stringify(SETTINGS_FAQ)'), /진단 내용 복사/);
});

test('WP-K 화면 파일 규칙: selfcheck-ui.js는 새 innerHTML을 uiIcon 아이콘에만 쓴다', () => {
  const source = fs.readFileSync(path.join(__dirname, 'selfcheck-ui.js'), 'utf8');
  const uses = source.split('\n').filter(line => /innerHTML/.test(line) && !/^\s*\/\//.test(line));
  assert.ok(uses.length >= 1);
  assert.ok(uses.every(line => /\.innerHTML = uiIcon\('chevron'\);/.test(line)), uses.join('\n'));
});

test('아이디어 줄: 평소 두 줄, (잘렸으면) 문구를 누르거나 Enter면 그 자리에서 펼치고 다시 누르면 접힘, 원문은 제목 옆이 아니라 아래 정보 줄에', () => {
  const app = workflowsClient();
  app.run('uiTitleClamped = () => true;'); // 가짜 DOM에는 크기가 없다 — 잘린 것으로 친다(안 잘린 경우는 WP-W 테스트)
  const row = app.run(`(() => {
    const row = recordIdeaRow({ id: 'i1', type: 'idea', description: '긴 아이디어 문구', created: '2026-09-24', permalink: 'https://example.slack.com/archives/C1/p1' });
    window.__ideaRow = row;
    return row;
  })()`);
  const kids = row.children;
  const title = kids.find(kid => String(kid.className) === 'ti');
  assert.ok(title, '제목은 줄 바로 아래(원문을 옆에 붙이지 않음)');
  assert.equal(title.getAttribute('role'), 'button');
  const info = kids.find(kid => String(kid.className) === 'd-recinfo');
  assert.ok(info, '아래 정보 줄');
  assert.ok(info.children.some(kid => String(kid.className) === 'd-src'), '원문 링크가 아래 줄에 늘 있다');
  const parts = JSON.parse(app.run(`JSON.stringify(recordInfoParts({ id: 'i1', created: '2026-09-24', permalink: 'https://x' }, '적음').map(p => p.text))`));
  assert.match(parts[0], /적음$/);
  title.listeners.click();
  assert.match(String(row.className), /is-open/);
  assert.equal(title.getAttribute('aria-expanded'), 'true');
  title.listeners.click();
  assert.doesNotMatch(String(row.className), /is-open/);
  title.listeners.keydown({ key: 'Enter', isComposing: false, preventDefault() {} });
  assert.match(String(row.className), /is-open/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 슬랙 원문 그대로 모드 — 설정 › 연동 › 슬랙 카드의 정리 방식 (2026-09-29)

const RAW_SLACK = {
  enabled: true, hasToken: true, readAt: ago(5), tidy: 'raw',
  channels: { todo: { id: 'C1', name: '#my-todo' }, waiting: { id: 'C2', name: '#my-waiting' }, align: { id: '', name: '' }, someday: { id: '', name: '' } },
};

test('원문 모드 카드: 상태 줄에 방식, 주의 한 줄, ⋯ › 슬랙 정리 방식은 세그먼트(Claude 없으면 흐리게 + 필요 표시)', async () => {
  const fx = intgClient({ slack: RAW_SLACK, claude: false });
  await fx.app.run('renderSettingsIntegrations()');
  assert.equal(stText(fx, 1), '원문 그대로 받는 중 · #my-todo 외 1개 · 5분 전 읽음');
  assert.match(fx.text('slack'), /요약하지 않고 메시지 첫 줄을 그대로 넣어요\. 문구가 길거나 정확하지 않을 수 있으니, 필요하면 앱에서 고쳐 주세요\./);
  assert.doesNotMatch(fx.text('slack'), /이제 Claude로 다듬을 수 있어요|원문 그대로로 바꾸기/);

  await fx.menu('slack')[0].find(entry => entry.label === '슬랙 정리 방식').onClick();
  const seg = fx.app.run("window.findByClass(document.getElementById('settingsIntegrationsView').children[1], 'd-seg')[0]");
  assert.equal(seg.getAttribute('role'), 'radiogroup');
  const [raw, claude] = seg.children;
  same([raw.textContent, raw.getAttribute('aria-checked'), claude.textContent, claude.getAttribute('aria-checked'), !!claude.disabled],
    ['원문 그대로', 'true', 'Claude로 다듬기', 'false', true]);
  assert.match(fx.text('slack'), /Claude Code가 있어야 해요/);
  assert.match(fx.text('slack'), /방식을 바꿔도 이미 들어온 항목은 그대로예요/);
  const before = fx.sent.length;
  await claude.listeners.click();
  assert.equal(fx.sent.length, before, '흐린 칸은 눌러도 저장하지 않는다');
});

test('원문 모드 카드: Claude가 생기면 조용히 알리고, 정리 방식을 바꾸면 그 칸만 저장·다시 켜지 않고 알림만', async () => {
  const fx = intgClient({ slack: RAW_SLACK, claude: true }, [{ body: { ok: true, slack: { tidy: 'claude' }, restart: false, quiet: true } }]);
  await fx.app.run('renderSettingsIntegrations()');
  assert.match(fx.text('slack'), /이제 Claude로 다듬을 수 있어요 · 슬랙 정리 방식/);
  await fx.button('slack', '슬랙 정리 방식').listeners.click();
  const seg = fx.app.run("window.findByClass(document.getElementById('settingsIntegrationsView').children[1], 'd-seg')[0]");
  assert.equal(!!seg.children[1].disabled, false);
  await seg.children[1].listeners.click();
  const saved = fx.sent.find(one => one.url === '/api/integrations/save');
  same(saved.body, { slack: { tidy: 'claude' } });
  assert.equal(fx.live(), '이제 Claude로 다듬어서 받아요', '다시 켜지 않는 저장이라 "서버를 다시 켜면" 말이 붙지 않는다');
});

test('Claude로 다듬는 중인데 Claude가 없거나 로그인이 풀려 멈췄으면 `원문 그대로로 바꾸기`(자동 전환 없음), 평소에는 예전 그대로', async () => {
  const base = { ...RAW_SLACK, tidy: 'claude' };
  const calm = intgClient({ slack: base, claude: true });
  await calm.app.run('renderSettingsIntegrations()');
  assert.equal(stText(calm, 1), '#my-todo 외 1개 · 5분 전 읽음', 'Claude로 다듬는 중이면 상태 줄은 예전 그대로');
  assert.doesNotMatch(calm.text('slack'), /원문 그대로|요약하지 않고/);

  const missing = intgClient({ slack: base, claude: false }, [{ body: { ok: true, slack: { tidy: 'raw' }, restart: false, quiet: true } }]);
  await missing.app.run('renderSettingsIntegrations()');
  assert.match(missing.text('slack'), /이 맥에 Claude Code가 없어 메시지를 다듬지 못해요 · 원문 그대로로 바꾸기/);
  assert.equal(missing.sent.filter(one => one.url === '/api/integrations/save').length, 0, '저절로 바꾸지 않는다');
  await missing.button('slack', '원문 그대로로 바꾸기').listeners.click();
  same(missing.sent.find(one => one.url === '/api/integrations/save').body, { slack: { tidy: 'raw' } });
  assert.equal(missing.live(), '이제 원문 그대로 받아요');

  const expired = intgClient({ slack: { ...base, fetch: { failing: true, auth: false, claudeAuth: true, failedAt: ago(7) } }, claude: true });
  await expired.app.run('renderSettingsIntegrations()');
  // 토큰 칸이 떠 있으면 같은 말을 되풀이하지 않고 대안임만 밝힌 조용한 한 줄(누르면 같은 저장)
  assert.match(expired.text('slack'), /Claude 없이 쓰려면 · 원문 그대로로 바꾸기/);
  assert.doesNotMatch(expired.text('slack'), /로그인이 풀려 메시지를 다듬지/);
  const alt = expired.find('slack', 'd-intgnote').find(one => one.dataset.tidy === 'stuck');
  assert.ok(alt, '주황 경고가 아니라 조용한 줄');
  await expired.button('slack', '원문 그대로로 바꾸기').listeners.click();
  same(expired.sent.find(one => one.url === '/api/integrations/save').body, { slack: { tidy: 'raw' } });
  // 칸이 없을 때(로그인 풀림이지만 멈춘 카드가 아님)는 예전 문구·모양 그대로
  const quiet = intgClient({ slack: { ...base, fetch: { failing: false, auth: false, claudeAuth: true } }, claude: true });
  await quiet.app.run('renderSettingsIntegrations()');
  assert.equal(quiet.find('slack', 'd-iclaude').length, 0);
  assert.match(quiet.text('slack'), /Claude Code 로그인이 풀려 메시지를 다듬지 못하고 있어요 · 원문 그대로로 바꾸기/);

  // 아직 연결 전이고 Claude가 없으면 원문으로 받는다는 사실만 한 줄
  const fresh = intgClient({ claude: false });
  await fresh.app.run('renderSettingsIntegrations()');
  assert.match(fresh.text('slack'), /이 맥에는 Claude Code가 없어서 요약하지 않고 메시지 첫 줄을 그대로 받아요/);
});

test('긴 문구: 업무 줄 제목은 두 줄까지(말줄임) — 줄 높이 안에 들어가고, 도움말에 원문 모드 문답', () => {
  const css = fs.readFileSync(path.join(__dirname, 'ui.css'), 'utf8');
  assert.match(css, /\.d-row \.d-title \{ white-space: normal; text-overflow: clip; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; \}/);
  assert.match(css, /--row: 54px;/, '두 줄(25px × 2)이 줄 높이 안에 들어간다');
  const app = pureClient();
  const faq = JSON.parse(app.run('JSON.stringify(SETTINGS_FAQ)')).flatMap(([, rows]) => rows);
  const entry = faq.find(([question]) => question === '슬랙에서 온 할 일이 요약되지 않고 길게 들어와요');
  assert.ok(entry);
  assert.match(entry[2], /원문 그대로.*정확하지 않을 수 있어요.*Claude Code.*Claude로 다듬기/);
  assert.ok(entry[2].length <= 260);
});

test('WP-S 캘린더 카드: 캘린더 파일이 갱신되지 않은 실패는 비밀 주소·커넥터 안내를 이유로 보인다', () => {
  const app = pureClient();
  const warn = '⚠️ 캘린더 파일이 갱신되지 않았어요 — Claude에 구글 캘린더가 연결돼 있지 않으면 설정 › 연동 › 캘린더에서 비밀 주소로 바꾸거나 Claude 커넥터에서 연결해 주세요';
  const why = app.run(`settingsFailWhy('calendar', { failing: true, summary: ${JSON.stringify(warn)} })`);
  assert.equal(why.length, 1);
  assert.match(why[0], /^캘린더가 갱신되지 않았어요 — Claude에 구글 캘린더가 연결돼 있지 않으면 비밀 주소로 바꾸거나 Claude 커넥터에서 연결해 주세요/);
  assert.match(app.run(`settingsLogText('calendar', { kind: 'fail', text: ${JSON.stringify(warn)} })`), /^읽지 못했어요 — 캘린더가 갱신되지 않았어요 — .*비밀 주소로 바꾸거나/);
});

// 슬랙 연결: 이미 있는 채널 이름이면 그 채널을 쓰기(2026-09-29)
test('이미 있는 채널 ②: 내 채널로 풀린 줄은 초록 `✓ 이미 있는 #이름 채널을 쓸게요`, 남의 채널은 그 줄에 이유 — 같은 채널을 두 줄에 두지 않고, 저장은 existing 칸을 알린다', async () => {
  const fx = await intgSlackAtChannels({}, [
    { body: { ok: true, id: 'C0MINE11', name: 'eren-todo', existing: true } },
    { status: 400, body: { ok: false, code: 'name_taken', error: '다른 사람이 쓰는 이름이에요 — 다른 이름을 적어 주세요' } },
    { body: { ok: true, id: 'C0MINE11', name: 'eren-todo', existing: true } },
    { body: { ok: true, id: 'C0WAIT22', name: 'my-wait2' } },
    { body: { ok: true, restart: false, slack: { channels: {} } } },
  ]);
  await fx.find('slack', 'pri')[0].listeners.click();
  const done = intgRow(fx, 'todo').children[2];
  assert.equal(done.textContent, '✓ 이미 있는 #eren-todo 채널을 쓸게요');
  assert.equal(done.className, 'nm is-done', '만든 줄과 같은 초록 글자');
  assert.equal(intgRow(fx, 'todo').children.at(-1).textContent, '', '이미 있는 내 채널은 오류가 아니다');
  assert.equal(intgRow(fx, 'waiting').children.at(-1).textContent, '다른 사람이 쓰는 이름이에요 — 다른 이름을 적어 주세요');
  assert.equal(fx.find('slack', 'pri')[0].textContent, '고른 채널 1개 만들어 주기', '찾은 것은 그대로, 실패 줄만 다시');

  // 기다리는 것에 같은 채널 이름을 적으면 — 할 일 줄이 이미 가져간 채널이라 막는다
  intgRow(fx, 'waiting').children[2].value = 'eren-todo';
  intgRow(fx, 'waiting').children[2].listeners.input();
  await fx.find('slack', 'pri')[0].listeners.click();
  assert.equal(intgRow(fx, 'waiting').children.at(-1).textContent, '이미 할 일 칸에 연결된 채널이에요 — 다른 이름을 적어 주세요');
  assert.equal(fx.find('slack', 'd-ich').length, 4, '② 단계에 머문다');

  intgRow(fx, 'waiting').children[2].value = 'my-wait2';
  intgRow(fx, 'waiting').children[2].listeners.input();
  await fx.find('slack', 'pri')[0].listeners.click();
  same(fx.sent.filter(one => one.url === '/api/integrations/slack-channel').map(one => one.body.key), ['todo', 'waiting', 'waiting', 'waiting'], '칸을 함께 보낸다');
  assert.match(fx.live(), /채널 1개를 만들고 이미 있는 채널 1개를 쓸게요/);
  // ③ 확인 — 채널마다 같은 줄
  same(fx.find('slack', 'd-iok').map(one => one.textContent), ['✓ #eren-todo · 할 일 · 잘 읽혀요', '✓ #my-wait2 · 기다리는 것 · 잘 읽혀요']);
  await fx.button('slack', '연결').listeners.click();
  same(fx.sent.find(one => one.url === '/api/integrations/save').body,
    { slack: { enabled: true, token: 'xoxp-good', channels: { todo: 'C0MINE11', waiting: 'C0WAIT22' }, existing: ['todo'] } });
});

test('이미 있는 채널 ⋯ 채널 고르기: 같은 규칙 — 이미 있는 내 채널을 쓰고 저장에 existing, 다른 칸 채널·보관 채널은 그 줄에 서버 문구', async () => {
  const fx = await intgPick({}, [
    { status: 400, body: { ok: false, code: 'channel_in_use', error: '이미 할 일 칸에 연결된 채널이에요 — 다른 이름을 적어 주세요' } },
    { body: { ok: true, id: 'C0ALIGN1', name: 'hana-align', existing: true } },
    { body: { ok: true, restart: false } },
  ]);
  await pickToggle(fx, 'align', true);
  await pickGo(fx).listeners.click();
  assert.equal(pickRow(fx, 'align').children.at(-1).textContent, '이미 할 일 칸에 연결된 채널이에요 — 다른 이름을 적어 주세요');
  assert.equal(fx.sent.filter(one => one.url === '/api/integrations/save').length, 0, '막히면 저장하지 않는다');
  await pickGo(fx).listeners.click();
  same(fx.sent.filter(one => one.url === '/api/integrations/slack-channel').map(one => one.body), [
    { token: '', name: 'hana-align', key: 'align' }, { token: '', name: 'hana-align', key: 'align' },
  ]);
  same(fx.sent.find(one => one.url === '/api/integrations/save').body,
    { slack: { enabled: true, token: '', channels: { align: 'C0ALIGN1' }, off: [], on: [], existing: ['align'] } });
  assert.match(fx.live(), /이미 있는 채널 1개를 쓸게요/);
  same(fx.app.run(`settingsSlackMadeText({ name: 'a', existing: true })`), '✓ 이미 있는 #a 채널을 쓸게요');
  same(fx.app.run(`settingsSlackMadeText({ name: 'a' })`), '✓ #a 만들었어요');
});

// ─────────────────────────────────────────────────────────────────────────────
// WP-U — 쉬는 틈에 자동 업데이트: 오늘 탭 한 줄 · 설정 › 앱 스위치 · 받는 동안 한 줄

const WPU_ABOUT = (notice, extra = {}) => ({ version: '1.2.1', update: { available: true, label: 'v1.2.2', auto: { eligible: true, on: notice !== 'off', notice } }, ...extra });

test('WP-U 오늘 탭 한 줄: 자동이 안 될 때(꺼짐·옮기기·고친 파일·에이전트 없음)만 `새 버전 v1.2.2가 있어요` + 업데이트 받기(설정 › 앱) + 닫기', () => {
  for (const notice of ['off', 'relocate', 'modified', 'not-installed']) {
    const fx = guideClient();
    fx.app.run(`settingsAbout = ${JSON.stringify(WPU_ABOUT(notice))}; renderUpdateNotice();`);
    const zone = fx.app.nodes.get('updateNoticeZone');
    assert.equal(zone.hidden, false, notice);
    const line = zone.children[0];
    assert.equal(line.className, 'd-abupd d-updnote');
    assert.equal(fx.shape("document.getElementById('updateNoticeZone').children[0]").text, '새 버전 v1.2.2가 있어요업데이트 받기닫기');
    line.children[1].listeners.click();
    same(fx.went(), [['app', null]], '누르면 설정 › 앱의 기존 흐름');
  }
});

test('WP-U 오늘 탭 한 줄: 자동이 잘 되는 중이거나(notice 없음)·이미 최신·main이면 없다', () => {
  const fx = guideClient();
  for (const about of [WPU_ABOUT(null), { version: '1.2.1', update: { available: false, label: 'v1.2.1', auto: { eligible: true, on: true, notice: null } } },
    { version: '1.2.1', update: { available: true, label: 'main', auto: { eligible: false, on: true, notice: null } } }, { version: '1.2.1', update: { available: true, label: 'v1.2.2' } }]) {
    fx.app.run(`settingsAbout = ${JSON.stringify(about)}; renderUpdateNotice();`);
    assert.equal(fx.app.nodes.get('updateNoticeZone').hidden, true);
    assert.equal(fx.app.nodes.get('updateNoticeZone').children.length, 0);
  }
});

test('WP-U 오늘 탭 한 줄: 자동 실패면 `자동 업데이트가 멈췄어요` 빨간 줄 — 닫으면 그 버전 동안 다시 뜨지 않고, 새 버전이면 다시 뜬다', () => {
  const fx = guideClient();
  fx.app.run(`settingsAbout = ${JSON.stringify(WPU_ABOUT('failed'))}; renderUpdateNotice();`);
  const line = fx.app.nodes.get('updateNoticeZone').children[0];
  assert.equal(line.className, 'd-abfail d-updnote');
  assert.equal(fx.shape("document.getElementById('updateNoticeZone').children[0]").text, '자동 업데이트가 멈췄어요 — 설정 › 앱에서 확인해 주세요설정 › 앱 열기닫기');
  // 다시 그려도 같은 줄(초점이 사라지지 않게)
  fx.app.run('renderUpdateNotice()');
  assert.equal(fx.app.nodes.get('updateNoticeZone').children[0], line);
  assert.equal(line.children[2].getAttribute('aria-label'), '새 버전 알림 닫기');
  line.children[2].listeners.click();
  assert.equal(fx.app.nodes.get('updateNoticeZone').hidden, true);
  assert.equal(fx.store.get('updateNoticeClosed'), 'v1.2.2:failed');
  fx.app.run('renderUpdateNotice()');
  assert.equal(fx.app.nodes.get('updateNoticeZone').hidden, true, '같은 버전 동안은 닫힌 채');
  fx.app.run(`settingsAbout = ${JSON.stringify({ ...WPU_ABOUT('off'), update: { ...WPU_ABOUT('off').update, label: 'v1.2.3' } })}; renderUpdateNotice();`);
  assert.equal(fx.shape("document.getElementById('updateNoticeZone').children[0]").text, '새 버전 v1.2.3이 있어요업데이트 받기닫기', '새 버전은 다시 알리고 조사도 맞춘다');
});

test('WP-U 설정 › 앱 `자동으로 업데이트` 스위치: 자격 있는 자리에서만 보이고, 누르면 곧바로 autoUpdate 한 키를 저장한다', async () => {
  const fx = updateClient({ ...D3_ABOUT, update: { ...D3_ABOUT.update, auto: { eligible: true, on: true, notice: null } } }, { replies: [{ body: { ok: true, autoUpdate: false } }] });
  fx.app.run('settingsAboutFill()');
  await fx.flush();
  const slot = fx.app.nodes.get('settingsAutoUpdate');
  assert.equal(slot.hidden, false);
  const row = slot.children[0];
  assert.equal(row.className, 'd-ich is-on');
  const box = row.children[0];
  assert.equal(box.type, 'checkbox');
  assert.equal(box.checked, true, '기본 켜짐');
  assert.equal(row.children[1].children[0].textContent, '자동으로 업데이트');
  box.checked = false;
  await box.listeners.change();
  const saved = fx.sent.find(one => one.url === '/api/personalize');
  same(saved.body, { autoUpdate: false });

  // main 갈래·개발용(eligible false)이면 스위치가 없다
  const main = updateClient({ ...D3_ABOUT, channel: 'main', update: { available: true, label: 'main', auto: { eligible: false, on: true, notice: null } } });
  main.app.run('settingsAboutFill()');
  assert.equal(main.app.nodes.get('settingsAutoUpdate').hidden, true);
  assert.equal(main.app.nodes.get('settingsAutoUpdate').children.length, 0);
});

test('WP-U 오늘 탭 한 줄: 하루 넘게 안 깔림(stale)은 새 버전 판 + 업데이트 받기, 요청이 처리되지 않음(stuck)은 빨간 판 + 설정 › 앱 열기', () => {
  const fx = guideClient();
  fx.app.run(`settingsAbout = ${JSON.stringify(WPU_ABOUT('stale'))}; renderUpdateNotice();`);
  assert.equal(fx.app.nodes.get('updateNoticeZone').children[0].className, 'd-abupd d-updnote');
  assert.equal(fx.shape("document.getElementById('updateNoticeZone').children[0]").text, '새 버전 v1.2.2가 하루 넘게 설치되지 않았어요업데이트 받기닫기');
  fx.app.nodes.get('updateNoticeZone').children[0].children[2].listeners.click();
  assert.equal(fx.store.get('updateNoticeClosed'), 'v1.2.2:stale');
  fx.app.run(`settingsAbout = ${JSON.stringify(WPU_ABOUT('stuck'))}; renderUpdateNotice();`);
  const line = fx.app.nodes.get('updateNoticeZone').children[0];
  assert.equal(line.className, 'd-abfail d-updnote', '다른 이유는 닫은 것과 따로 뜬다');
  assert.equal(fx.shape("document.getElementById('updateNoticeZone').children[0]").text, '업데이트 요청이 처리되지 않았어요 — 설정 › 앱에서 확인해 주세요설정 › 앱 열기닫기');
  line.children[1].listeners.click();
  same(fx.went(), [['app', null]]);
});

test('WP-U 입력 중 신호: 입력 중이거나 창(dialog)이 열려 있으면 본문 없는 POST /api/activity, 아니면 보내지 않고, 실패는 조용히', async () => {
  const app = pureClient();
  const sent = [];
  app.context.fetch = async (url, options = {}) => { sent.push([String(url), options.method, options.body]); throw new TypeError('offline'); };
  app.run('document.activeElement = null; document.querySelector = () => null;');
  assert.equal(app.run('activityPing()'), false);
  assert.equal(sent.length, 0, '아무것도 안 하고 있으면 보내지 않는다');
  app.run("document.activeElement = { matches: sel => sel.includes('textarea'), isContentEditable: false };");
  assert.equal(app.run('activityPing()'), true);
  app.run("document.activeElement = null; document.querySelector = sel => (sel === 'dialog[open]' ? {} : null);");
  assert.equal(app.run('activityPing()'), true, '체크인·설정 창이 열려 있어도 보낸다');
  await new Promise(resolve => setImmediate(resolve));
  same(sent, [['/api/activity', 'POST', null], ['/api/activity', 'POST', null]], '본문 없음');
  assert.notEqual(app.nodes.get('liveRegion')?.textContent || '', '목록을 불러오지 못했어요', '실패해도 알림을 띄우지 않는다');
  const script = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  assert.match(script.slice(script.indexOf(DEFINITIONS_MARKER)), /setInterval\(activityPing, 60 \* 1000\)/);
});

test('WP-U 설정 › 앱 새 버전 상자도 오늘 탭 한 줄과 같은 조사(끝 숫자 2·4·5·9는 `가`)', () => {
  for (const [label, want] of [['v1.2.2', '새 버전 v1.2.2가 있어요'], ['v1.2.4', '새 버전 v1.2.4가 있어요'], ['v1.3.0', '새 버전 v1.3.0이 있어요'], ['v2.0.1', '새 버전 v2.0.1이 있어요']]) {
    const fx = updateClient({ ...D3_ABOUT, update: { available: true, label } });
    fx.app.run('settingsAboutFill()');
    assert.ok(fx.text().startsWith(`${want}업데이트 받기`), `${label}: ${fx.text()}`);
  }
});

test('WP-U 설정 › 앱 스위치: 저장이 실패하면 체크를 되돌리고 이유를 알린다', async () => {
  const fx = updateClient({ ...D3_ABOUT, update: { ...D3_ABOUT.update, auto: { eligible: true, on: false, notice: 'off' } } }, { replies: [{ status: 400, body: { ok: false, error: '저장하지 못했어요.' } }] });
  fx.app.run('settingsAboutFill()');
  const row = fx.app.nodes.get('settingsAutoUpdate').children[0];
  const box = row.children[0];
  assert.equal(box.checked, false);
  box.checked = true;
  await box.listeners.change();
  assert.equal(box.checked, false, '실패하면 원래대로');
  assert.equal(box.disabled, false);
  assert.match(fx.app.nodes.get('liveRegion').textContent, /저장하지 못했어요/);
});

test('WP-U 받는 동안: 목록을 못 받았는데 업데이트 중이면(상태 응답 running, 또는 서버가 없고 방금 updating을 봤으면) `바꾸는 중이에요` 한 줄', async () => {
  const app = pureClient();
  app.context.AbortSignal = AbortSignal;
  const timers = [];
  app.context.setTimeout = (fn, delay) => { timers.push(delay); return 0; };
  app.context.fetch = async () => new Response(JSON.stringify({ running: true }), { status: 200 });
  await app.run('updateBusyCheck()');
  assert.equal(app.nodes.get('liveRegion').textContent, '새 버전으로 바꾸는 중이에요 — 1분쯤 걸려요');
  assert.ok(timers.includes(15000), '15초 뒤 다시 받는다');

  // 서버가 아예 없으면 — 방금 목록이 updating을 알려 줬을 때만
  const gone = pureClient();
  gone.context.AbortSignal = AbortSignal;
  gone.context.setTimeout = () => 0;
  gone.context.fetch = async () => { throw new TypeError('offline'); };
  gone.run("document.getElementById('liveRegion').textContent = '목록을 불러오지 못했어요'");
  await gone.run('updateBusyCheck()');
  assert.equal(gone.nodes.get('liveRegion').textContent, '목록을 불러오지 못했어요', '업데이트를 본 적이 없으면 기존 연결 실패 그대로');
  gone.run('updatingSeenAt = Date.now()');
  await gone.run('updateBusyCheck()');
  assert.equal(gone.nodes.get('liveRegion').textContent, '새 버전으로 바꾸는 중이에요 — 1분쯤 걸려요');

  // 서버가 답하는데 업데이트 중이 아니면 기존 안내 그대로
  const plain = pureClient();
  plain.context.AbortSignal = AbortSignal;
  plain.context.fetch = async () => new Response(JSON.stringify({ running: false }), { status: 200 });
  plain.run("document.getElementById('liveRegion').textContent = '목록을 불러오지 못했어요'");
  plain.run('updatingSeenAt = Date.now()');
  await plain.run('updateBusyCheck()');
  assert.equal(plain.nodes.get('liveRegion').textContent, '목록을 불러오지 못했어요');
});

// ─────────────────────────────────────────────────────────────────────────────
// WP-W — 리마인드 줄의 프로젝트 · `답변 왔어요` 한 번 보면 빠짐 · 회의 줄 두 줄/펼침 · 회의 연결 뒤 옮기기 묻기

function reminderClient(extraItems = []) {
  const { app, sent } = meetingRowClient(new Response(JSON.stringify({ ok: true, answerSeen: { at: '2026-09-29T00:00:00.000Z', answer: 'c1:2026-09-28' } })));
  app.context.extraItems = extraItems;
  app.run(`jiraIssuesByKey = new Map([['IO-1', { key: 'IO-1', summary: '결제 리뉴얼' }]]);
    projectAliasesCache = { 'IO-2': '알림 센터' };
    workflowData = { meetings: [], projectLinks: {}, items: [
      { id: 'c1', type: 'check', status: 'done', completed: '2026-09-28' },
      { id: 't1', type: 'task', status: 'to-do', description: '지라 업무', jira: 'IO-1', blockedBy: 'c1' },
      { id: 't2', type: 'task', status: 'to-do', description: '별칭 업무', jira: 'IO-2', blockedBy: 'c1' },
      { id: 't3', type: 'task', status: 'to-do', description: '프로젝트 없는 업무', blockedBy: 'c1' },
      { id: 't4', type: 'task', status: 'to-do', description: '그룹 업무', group: '가입 개선', blockedBy: 'c1',
        answerSeen: { at: '2026-09-28T10:00:00.000Z', answer: 'c1:2026-09-28' } },
      ...extraItems,
    ] }; wfIndexData(); itemsById = new Map(); latestData = { todayTasks: [], laterTasks: [] };`);
  return { app, sent };
}
const reminderRows = app => app.nodes.get('reminderList').children;
const reminderTitle = row => nodeFind(row, 'ti').textContent;

test('WP-W 리마인드 줄: 제목 뒤에 오늘 목록과 같은 `· ● 프로젝트`(지라는 요약, 별칭 반영), 없으면 아무것도 붙이지 않는다', () => {
  const { app } = reminderClient();
  app.run('remindersRender()');
  const rows = reminderRows(app);
  assert.deepEqual(rows.map(reminderTitle), ['지라 업무', '별칭 업무', '프로젝트 없는 업무'], '열어 본 답변(t4)은 빠진다');
  const project = row => nodeFind(row, 'd-inproj');
  assert.deepEqual(project(rows[0]).children.map(kid => typeof kid === 'string' ? kid : kid.className), ['· ', 'd-pjdot', '결제 리뉴얼']);
  assert.equal(project(rows[1]).children[2], '알림 센터', '별칭이 있으면 별칭');
  assert.equal(project(rows[2]), null, '프로젝트가 없으면 아무것도 붙이지 않는다');
  const wrap = nodeFind(rows[0], 'tiwrap');
  assert.equal(wrap.children[0].className, 'ti', '제목이 먼저, 그 바로 뒤에 프로젝트');
  assert.equal(wrap.children[1].className, 'd-inproj');
});

test('WP-W `답변 왔어요`: 적어 둔 답과 지금의 답이 같을 때만 본 것으로 친다 — 다시 걸렸다가 새 답이 오면 다시 뜬다', () => {
  const { app } = reminderClient([
    { id: 'c2', type: 'check', status: 'done', completed: '2026-09-29' },
    { id: 't5', type: 'task', status: 'to-do', description: '다시 걸린 업무', blockedBy: 'c2',
      answerSeen: { at: '2026-09-28T10:00:00.000Z', answer: 'c1:2026-09-28' } },
    { id: 'c3', type: 'check', status: 'done', completed: '2026-09-29' },
    { id: 't6', type: 'task', status: 'to-do', description: '같은 확인 대기가 다른 날 다시 끝남', blockedBy: 'c3',
      answerSeen: { at: '2026-09-28T10:00:00.000Z', answer: 'c3:2026-09-28' } },
  ]);
  assert.equal(app.run("answerSeenFor(wfItem('t4'))"), true);
  assert.equal(app.run("answerSeenFor(wfItem('t5'))"), false, '다른 확인 대기의 새 답');
  assert.equal(app.run("answerSeenFor(wfItem('t6'))"), false, '같은 확인 대기라도 완료일이 달라졌다');
  app.run('remindersRender()');
  assert.ok(reminderRows(app).map(reminderTitle).includes('다시 걸린 업무'));
  assert.ok(!reminderRows(app).map(reminderTitle).includes('그룹 업무'));
});

test('WP-W 업무 상세를 열면 답변 확인을 서버에 조용히 적고, 상세가 열린 동안은 줄을 남겼다가 닫으면 뺀다', async () => {
  const { app, sent } = reminderClient();
  app.run('remindersRender()');
  assert.ok(reminderRows(app).map(reminderTitle).includes('지라 업무'));
  // 상세가 열려 있다고 치고(panelState) 확인 표시만 부른다 — 카드 그리기는 이 가짜 DOM의 몫이 아니다.
  app.run("panelState = { kind: 'item', id: 't1' }");
  await app.run("answerSeenMark('t1')");
  assert.deepEqual(sent.map(call => call.url), ['/api/workflow/answer-seen']);
  assert.deepEqual(sent[0].body, { id: 't1' });
  assert.equal(app.run("wfItem('t1').answerSeen.answer"), 'c1:2026-09-28');
  app.run('remindersRender()');
  assert.ok(reminderRows(app).map(reminderTitle).includes('지라 업무'), '상세 카드가 붙어 있는 동안은 줄을 남긴다');
  app.run('panelState = null; answerSeenClosePending = null; remindersRender()');
  assert.ok(!reminderRows(app).map(reminderTitle).includes('지라 업무'), '닫으면 빠진다');
  // 이미 본 것·답이 아직 없는 것·완료한 것은 보내지 않는다.
  sent.length = 0;
  await app.run("answerSeenMark('t1')");
  await app.run("answerSeenMark('t4')");
  await app.run("answerSeenMark('c1')");
  assert.deepEqual(sent, []);
});

test('WP-W 답변 확인 보내기가 실패하면 화면 값을 되돌린다(리마인드에 다시 남는다)', async () => {
  const { app } = reminderClient();
  app.context.fetch = async () => new Response('{"ok":false,"error":"x"}', { status: 400 });
  await app.run("answerSeenMark('t2')");
  assert.equal(app.run("wfItem('t2').answerSeen"), undefined);
  assert.equal(app.run('answerSeenClosePending'), null);
});

test('WP-W 회의 줄: 잘린 제목만 누르면 펼치고(aria-expanded), 잘리지 않은 제목은 예전처럼 상세 열기·문구 고치기', () => {
  const { app } = meetingRowClient(new Response('{"ok":true}'));
  app.run("opened = []; window.__host = { ...MEETING_HOST_CARD, openItem: item => opened.push(item.id) };");
  app.run('uiMenu = (anchor, sections) => { window.__menu = sections; };');
  // ① 잘린 줄
  app.run('uiTitleClamped = () => true;');
  const row = app.run("panelMeetingRow({ id: 't1', type: 'task', description: '아주 긴 회의 항목 문구', status: 'to-do' }, { id: 'm1' }, null, window.__host)");
  const title = nodeFind(row, 'ti');
  assert.match(row.className, / is-clamp/);
  assert.equal(title.getAttribute('aria-expanded'), 'false');
  assert.equal(title.getAttribute('aria-label'), undefined, '잘린 줄의 이름은 문구 그대로다');
  title.listeners.click();
  assert.match(row.className, / is-open/);
  assert.equal(title.getAttribute('aria-expanded'), 'true');
  assert.equal(app.run('JSON.stringify(opened)'), '[]', '잘린 줄의 제목은 상세를 열지 않는다');
  title.listeners.click();
  assert.doesNotMatch(row.className, /is-open/);
  const more = row.children[row.children.length - 1].children[0];
  more.listeners.click({ stopPropagation() {} });
  const head = app.run('window.__menu')[0];
  assert.equal(head[0].label, '상세 열기');
  head[0].onClick();
  assert.equal(app.run('JSON.stringify(opened)'), '["t1"]');
  // ② 잘리지 않은 줄 — 누르면 상세, 펼치기 표시 없음
  app.run('uiTitleClamped = () => false; opened = [];');
  const plain = app.run("panelMeetingRow({ id: 't2', type: 'task', description: '짧은 줄', status: 'to-do' }, { id: 'm1' }, null, window.__host)");
  const plainTitle = nodeFind(plain, 'ti');
  assert.doesNotMatch(plain.className, /is-clamp/);
  assert.equal(plainTitle.getAttribute('aria-expanded'), undefined);
  assert.equal(plainTitle.getAttribute('aria-label'), '짧은 줄 상세 보기');
  plainTitle.listeners.click();
  assert.equal(app.run('JSON.stringify(opened)'), '["t2"]');
  assert.doesNotMatch(plain.className, /is-open/);
  // 결정(잘리지 않음)은 제목이 곧 문구 고치기다.
  const decision = app.run("panelMeetingRow({ id: 'd1', type: 'decision', description: '결정 문구', status: 'to-do' }, { id: 'm1' }, null, window.__host)");
  const box = firstCheckbox(decision.children[0]);
  nodeFind(decision, 'ti').listeners.click();
  assert.equal(box.disabled, true, '문구 고치기가 열려 체크를 잠근다');
  decision.children[decision.children.length - 1].children[0].listeners.click({ stopPropagation() {} });
  assert.equal(app.run('window.__menu')[0][0].label, '문구 고치기', '결정에는 `상세 열기`가 없다');
  // ③ 창 크기가 바뀌어 잘림이 풀리면 다시 재서 상세 열기로 돌아간다.
  app.run('uiTitleClamped = () => true;');
  const grow = app.run("panelMeetingRow({ id: 't3', type: 'task', description: '창에 따라 잘리는 줄', status: 'to-do' }, { id: 'm1' }, null, window.__host)");
  assert.match(grow.className, /is-clamp/);
  app.run('uiTitleClamped = () => false;');
  nodeFind(grow, 'ti').clampSync();
  assert.doesNotMatch(grow.className, /is-clamp/);
});

test('WP-W 아이디어 줄: 잘리지 않은 아이디어는 누를 수 없는 평범한 글자다', () => {
  const app = workflowsClient();
  app.run('uiTitleClamped = () => false;');
  const row = app.run("recordIdeaRow({ id: 'i1', type: 'idea', description: '짧은 아이디어', created: '2026-09-24' })");
  const title = nodeFind(row, 'ti');
  assert.equal(title.getAttribute('role'), undefined);
  assert.equal(title.getAttribute('aria-expanded'), undefined);
  assert.equal(title.tabIndex, -1);
  title.listeners.click();
  title.listeners.keydown({ key: 'Enter', isComposing: false, preventDefault() { throw new Error('누를 수 없는 글자는 키를 가로채지 않는다'); } });
  assert.doesNotMatch(String(row.className), /is-open/);
  app.run('uiTitleClamped = () => true;');
  title.clampSync();
  assert.equal(title.getAttribute('role'), 'button', '잘리면 그제야 버튼이 된다');
  assert.equal(title.tabIndex, 0);
});

test('WP-W 옮길 후보: 연결·변경은 없음·이전 프로젝트만(다른 프로젝트는 그대로 두고 센다), 해제는 이전 프로젝트만, 끝낸 것은 빼고 센다, 아이디어 포함', () => {
  const app = workflowsClient();
  const pick = (items, from, to) => JSON.parse(app.run(`JSON.stringify(meetingMoveCandidates(${JSON.stringify(items)}, ${JSON.stringify(from)}, ${JSON.stringify(to)}))`));
  const items = [
    { id: 'none', type: 'task' },
    { id: 'inA', type: 'check', group: '결제 리뉴얼' },
    { id: 'inC', type: 'decision', jira: 'IO-9' },
    { id: 'idea', type: 'idea', project: '결제_리뉴얼' },
    { id: 'doneA', type: 'task', group: '결제 리뉴얼', status: 'done' },
    { id: 'doneNone', type: 'task', status: 'done' },
    { id: 'inB', type: 'task', group: '알림 센터' },
  ];
  // 처음 연결(없음 → 결제 리뉴얼): 프로젝트 없는 것만. 이미 다른 프로젝트(IO-9·알림 센터)에 있는 것은 그대로 두고 센다.
  assert.deepEqual(pick(items, null, 'group:결제_리뉴얼'), { ids: ['none'], done: 1, other: 2 });
  // 변경(결제 리뉴얼 → 알림 센터): 없음 + A(아이디어 포함). C(IO-9)는 그대로, 이미 B인 것은 세지 않는다.
  assert.deepEqual(pick(items, 'group:결제 리뉴얼', 'group:알림 센터'), { ids: ['none', 'inA', 'idea'], done: 2, other: 1 });
  // 해제(결제 리뉴얼 → 없음): A에 있는 것만, 끝낸 것은 센다.
  assert.deepEqual(pick(items, 'group:결제 리뉴얼', null), { ids: ['inA', 'idea'], done: 1, other: 0 });
  // 옮길 것이 없으면 빈 목록(묻지 않는다).
  assert.deepEqual(pick([{ id: 'x', type: 'task', jira: 'IO-9' }], null, 'jira:IO-9'), { ids: [], done: 0, other: 0 });
});

test('WP-W 확인 줄: 문구(다른 프로젝트·끝낸 것)·`옮기기`/`그대로`, 해제는 `빼기`, 떠 있는 채 또 바꾸면 처음 기준으로 다시, ⌘Z 한 번', async () => {
  const { app, sent } = meetingRowClient(new Response(JSON.stringify({ ok: true, count: 2, moved: [{ id: 'a', from: null }, { id: 'b', from: 'group:가입 개선' }] })));
  app.run(`workflowData = { meetings: [{ id: 'm1', title: '결제 주간', date: '2026-09-20', project: { type: 'group', value: '결제_리뉴얼', label: '결제_리뉴얼' } }],
    items: [
      { id: 'a', type: 'task', meetingId: 'm1', description: 'A' },
      { id: 'b', type: 'check', meetingId: 'm1', description: 'B', group: '가입 개선' },
      { id: 'c', type: 'task', meetingId: 'm1', description: 'C', group: '결제 리뉴얼' },
      { id: 'e', type: 'task', meetingId: 'm1', description: 'E', group: '운영툴' },
      { id: 'f', type: 'task', meetingId: 'm1', description: 'F', status: 'done' },
    ] }; wfIndexData(); itemsById = new Map();
    redraws = 0; window.__host = { ...MEETING_HOST_CARD, redraw: () => { redraws += 1; } };`);
  const event = 'workflowData.meetings[0]';
  assert.equal(app.run(`meetingMoveAskNode(${event}, window.__host)`), null, '바꾸기 전에는 줄이 없다');
  // 가입 개선 → 결제 리뉴얼로 바꿨다: 없음(a) + 이전(b)만, 운영툴(e)은 그대로, 끝낸 f는 센다.
  app.run("meetingMoveAskOpen('m1', 'group:가입 개선', 'group:결제 리뉴얼', window.__host)");
  const line = app.run(`meetingMoveAskNode(${event}, window.__host)`);
  assert.equal(line.className, 'd-jline d-mmove');
  assert.equal(line.children[0].textContent, '이 회의에서 이미 담은 2개도 「결제 리뉴얼」로 옮길까요? (1개는 다른 프로젝트라 그대로 둬요 · 끝낸 1개는 그대로)');
  assert.deepEqual(line.children.filter(kid => kid.className === 'd-link').map(kid => kid.textContent), ['옮기기', '그대로']);
  line.children[4].listeners.click();
  assert.equal(app.run(`meetingMoveAskNode(${event}, window.__host)`), null, '`그대로`는 아무것도 보내지 않고 줄을 닫는다');
  assert.deepEqual(sent, []);
  // `옮기기`는 보여 준 번호만 한 번 보내고, ⌘Z 기록을 하나 남긴다.
  app.run("meetingMoveAskOpen('m1', 'group:가입 개선', 'group:결제 리뉴얼', window.__host)");
  await app.run(`meetingMoveAskNode(${event}, window.__host)`).children[2].listeners.click();
  assert.deepEqual(sent.map(call => call.url), ['/api/meeting/move-items']);
  assert.deepEqual(sent[0].body, { meetingId: 'm1', project: 'group:결제 리뉴얼', from: 'group:가입 개선', ids: ['a', 'b'] });
  assert.equal(app.run('undoStack[undoStack.length - 1].label'), '회의 항목 2개 옮기기');
  sent.length = 0;
  await app.run('undoStack[undoStack.length - 1].undo()');
  assert.deepEqual(sent[0], { url: '/api/meeting/move-items-undo', body: { meetingId: 'm1', project: 'group:결제 리뉴얼', moved: [{ id: 'a', from: null }, { id: 'b', from: 'group:가입 개선' }] } });
  // 떠 있는 채로 또 바꾸면(결제 리뉴얼 → 운영툴) 처음 기준(가입 개선)으로 새 목적지에 맞춰 다시 그린다.
  app.run("meetingMoveAskOpen('m1', 'group:가입 개선', 'group:결제 리뉴얼', window.__host)");
  app.run("workflowData.meetings[0].project = { type: 'group', value: '운영툴', label: '운영툴' }; meetingMoveAskOpen('m1', 'group:결제 리뉴얼', 'group:운영툴', window.__host)");
  assert.equal(app.run('JSON.stringify(meetingMoveAsk)'), JSON.stringify({ meetingId: 'm1', from: 'group:가입 개선', to: 'group:운영툴', busy: false }));
  assert.match(app.run(`meetingMoveAskNode(${event}, window.__host)`).children[0].textContent, /^이 회의에서 이미 담은 2개도 「운영툴」로 옮길까요\? \(1개는 다른 프로젝트라/);
  // 해제(운영툴 → 없음): `빼기`, 운영툴에 있는 것만.
  app.run("meetingMoveAsk = null; workflowData.meetings[0].project = null; meetingMoveAskOpen('m1', 'group:운영툴', null, window.__host)");
  const unlink = app.run(`meetingMoveAskNode(${event}, window.__host)`);
  assert.equal(unlink.children[0].textContent, '이 회의 항목 1개도 「운영툴」에서 뺄까요?');
  assert.equal(unlink.children[2].textContent, '빼기');
  sent.length = 0;
  await unlink.children[2].listeners.click();
  assert.deepEqual(sent[0].body, { meetingId: 'm1', project: null, from: 'group:운영툴', ids: ['e'] });
  // 프로젝트가 그 사이 또 바뀌었으면 묻던 줄은 사라진다.
  app.run("meetingMoveAskOpen('m1', null, 'jira:IO-7', window.__host)");
  assert.equal(app.run(`meetingMoveAskNode(${event}, window.__host)`), null);
});

test('WP-W 오늘 탭 미팅 줄 ⋯에서 바꾸면 알림 버튼으로 묻고(0개면 묻지 않음), 누르면 같은 서버 경로', async () => {
  const { app, sent } = meetingRowClient(new Response(JSON.stringify({ ok: true, count: 1, moved: [{ id: 'a', from: null }] })));
  app.run(`workflowData = { meetings: [], items: [
      { id: 'a', type: 'task', meetingId: 'w1', description: 'A' },
      { id: 'i', type: 'idea', meetingId: 'w1', description: 'I', project: '운영툴' },
    ] }; wfIndexData(); itemsById = new Map();
    notices = []; showNotice = (text, error, retry, action) => { if (action) notices.push({ text, action }); };
    renderGroupControl = opts => ({ opts });
    window.__sections = meetingMenuSections({ workflowId: 'w1', title: '운영 회의', project: null }, { fetchAll: false });`);
  const control = app.run('window.__sections[window.__sections.length - 1][0].control.opts');
  await control.onSetGroup('결제 리뉴얼');
  assert.equal(app.run('notices.length'), 1);
  assert.equal(app.run('notices[0].text'), '「결제 리뉴얼」로 연결했어요');
  assert.equal(app.run('notices[0].action.label'), '이미 담은 1개도 옮기기');
  assert.equal(sent.filter(call => call.url === '/api/meeting/move-items').length, 0, '누르기 전에는 아무것도 옮기지 않는다');
  await app.run('notices[0].action.onClick()');
  const move = sent.find(call => call.url === '/api/meeting/move-items');
  assert.deepEqual(move.body, { meetingId: 'w1', project: 'group:결제 리뉴얼', from: null, ids: ['a'] });
  // 해제: 운영툴 → 없음 — 그 프로젝트에 있는 아이디어를 빼자고 묻는다.
  app.run(`notices = []; window.__sections = meetingMenuSections({ workflowId: 'w1', title: '운영 회의', project: { type: 'group', value: '운영툴', label: '운영툴' } }, {});`);
  await app.run('window.__sections[window.__sections.length - 1][0].control.opts').onSetGroup(null);
  assert.equal(app.run('notices[0].action.label'), '이미 담은 1개도 빼기');
  // 옮길 것이 0개면 묻지 않는다.
  app.run(`notices = []; window.__sections = meetingMenuSections({ workflowId: 'w9', title: '빈 회의', project: null }, {});`);
  await app.run('window.__sections[window.__sections.length - 1][0].control.opts').onSetGroup('결제 리뉴얼');
  assert.equal(app.run('notices.length'), 0);
});

test('WP-W `답변 왔어요`가 빠지는 순간 `답변 확인했어요 · 되돌리기` — 되돌리면 서버 표시를 지우고, ⌘Z도 같은 기록', async () => {
  const { app, sent } = reminderClient();
  app.run("notices = []; showNotice = (text, error, retry, action) => notices.push({ text, action }); load = async () => {}; document.removeEventListener = () => {}; window.removeEventListener = () => {}; document.querySelectorAll = () => [];");
  app.run("panelState = { kind: 'item', id: 't1' }");
  await app.run("answerSeenMark('t1')");
  app.run('panelClose()');
  assert.equal(app.run('notices[notices.length - 1].text'), '답변 확인했어요');
  assert.equal(app.run('notices[notices.length - 1].action.label'), '되돌리기');
  assert.ok(!reminderRows(app).map(reminderTitle).includes('지라 업무'), '닫는 순간 빠진다');
  sent.length = 0;
  await app.run('notices[notices.length - 1].action.onClick()');
  assert.deepEqual(sent.map(call => call.url), ['/api/workflow/answer-seen-undo']);
  assert.deepEqual(sent[0].body, { id: 't1' });
  // ⌘Z로 되돌린 기록은 다시 실행(⇧⌘Z) 쪽으로 넘어가고, 다시 실행하면 확인을 다시 적는다.
  sent.length = 0;
  await app.run("replayUndo('redo')");
  assert.deepEqual(sent.map(call => call.url), ['/api/workflow/answer-seen']);
});

test('WP-W 회의 ⋯의 프로젝트 연결: 고르면 회의 번호를 함께 보내고 onLinked를 부르며, 해제에는 부르지 않는다', async () => {
  const { app, sent } = meetingRowClient(new Response('{"ok":true}'));
  app.run("linkedWith = []; renderGroupControl = opts => ({ opts }); window.__sections = meetingMenuSections({ id: 'm1', title: '결제 주간', project: null }, { open: false, toTab: false, onLinked: key => linkedWith.push(key) });");
  const control = app.run('window.__sections[window.__sections.length - 1][0].control.opts');
  await control.onSetGroup('결제 리뉴얼');
  assert.deepEqual(sent[0], { url: '/api/meeting/set-project', body: { title: '결제 주간', project: 'group:결제 리뉴얼', meetingId: 'm1' } });
  assert.equal(app.run('JSON.stringify(linkedWith)'), '["group:결제 리뉴얼"]');
  await control.onSetGroup(null);
  assert.deepEqual(sent[1].body, { title: '결제 주간', project: null, meetingId: 'm1' });
  assert.equal(app.run('JSON.stringify(linkedWith)'), '["group:결제 리뉴얼"]', '연결 해제에는 묻지 않는다');
});

test('WP-W 화면 파일 규칙: 회의 줄에 새 innerHTML이 없고, 두 줄/펼침 CSS가 아이디어 줄과 같은 규칙이다', () => {
  const css = fs.readFileSync(path.join(__dirname, 'ui.css'), 'utf8');
  assert.match(css, /\.d-mrow2 \.ti \{[^}]*-webkit-line-clamp: 2/);
  assert.match(css, /\.d-mrow2\.is-open \.ti \{ -webkit-line-clamp: unset; display: block; \}/);
  assert.match(css, /\.d-wrow\.is-wrap \.tiwrap \{ grid-area: ti; display: flex; flex-wrap: wrap;/);
  const meetings = fs.readFileSync(path.join(__dirname, 'meetings-ui.js'), 'utf8');
  const uses = meetings.split('\n').filter(line => /innerHTML/.test(line) && !/^\s*\/\//.test(line));
  assert.ok(uses.every(line => /innerHTML = uiIcon\(/.test(line)), uses.join('\n'));
});

test('WP-W 답변 확인은 서버가 적은 뒤에만 줄을 빼고 알린다 — 실패는 조용히(줄 유지·알림 없음), 이미 닫혔으면 그 자리에서', async () => {
  const { app } = reminderClient();
  app.run("notices = []; showNotice = (text, error, retry, action) => notices.push({ text, error, action }); document.removeEventListener = () => {}; window.removeEventListener = () => {}; document.querySelectorAll = () => [];");
  // ① 실패: 줄은 그대로, 저장 실패 알림도 되돌리기 알림도 없다.
  app.context.fetch = async () => new Response('{"ok":false,"error":"x"}', { status: 500 });
  app.run("panelState = { kind: 'item', id: 't1' }");
  await app.run("answerSeenMark('t1')");
  app.run('panelClose(); remindersRender()');
  assert.equal(app.run('notices.length'), 0, '상세를 열기만 했는데 알림이 뜨지 않는다');
  assert.ok(reminderRows(app).map(reminderTitle).includes('지라 업무'), '줄은 그대로다');
  assert.equal(app.run("wfItem('t1').answerSeen"), undefined);
  // ② 성공이 상세를 닫은 뒤에 오면 그때 빼고 알린다(닫는 순간에는 아직 아무것도 하지 않는다).
  let release;
  app.context.fetch = () => new Promise((resolve) => { release = () => resolve(new Response(JSON.stringify({ ok: true, answerSeen: { at: 'x', answer: 'c1:2026-09-28' } }))); });
  app.run("panelState = { kind: 'item', id: 't2' }");
  const pending = app.run("answerSeenMark('t2')");
  app.run('panelClose()');
  assert.equal(app.run('notices.length'), 0, '요청이 끝나기 전에는 빼지도 알리지도 않는다');
  assert.ok(reminderRows(app).map(reminderTitle).includes('별칭 업무'));
  release();
  await pending;
  assert.equal(app.run('notices[0].text'), '답변 확인했어요');
  assert.ok(!reminderRows(app).map(reminderTitle).includes('별칭 업무'), '성공한 뒤에 빠진다');
});

test('WP-W 옮기기 알림: 서버가 건너뛴 항목이 있으면 「M개는 그사이 바뀌어 그대로 뒀어요」를 붙이고, ⇧⌘Z도 같은 from을 보낸다', async () => {
  const { app, sent } = meetingRowClient(new Response(JSON.stringify({ ok: true, count: 1, moved: [{ id: 'a', from: null }], skipped: 1 })));
  app.run("notices = []; showNotice = (text, error, retry, action) => { if (action || /그사이/.test(text)) notices.push({ text, action }); };");
  app.run("workflowData = { meetings: [], items: [{ id: 'a', type: 'task', meetingId: 'm1' }, { id: 'b', type: 'task', meetingId: 'm1' }] }; wfIndexData(); itemsById = new Map();");
  await app.run("meetingMoveCommit('m1', ['a', 'b'], 'group:가입 개선', 'group:결제 리뉴얼')");
  assert.equal(app.run('notices[0].text'), '1개를 「결제 리뉴얼」로 옮겼어요 · 1개는 그사이 바뀌어 그대로 뒀어요');
  sent.length = 0;
  await app.run('undoStack[undoStack.length - 1].redo()');
  assert.deepEqual(sent[0].body, { meetingId: 'm1', project: 'group:결제 리뉴얼', from: 'group:가입 개선', ids: ['a'] });
});

// ---- 좁은 폭(≤520) 줄 동작: 줄에는 ⋯ 하나, 줄 누름 = 시트, 시트 발에서 옮기면 닫힘, 누르는 화면의 되돌리기 버튼 ----
function narrowClient(width = 390) {
  const app = workflowsClient();
  app.run(`window.innerWidth = ${width}; var opened = []; panelOpen = view => opened.push(view);`);
  return app;
}
// 누른 자리: kind가 있으면 그 선택자 안에서 온 누름이다(closest가 그 선택자를 포함하면 찾았다고 답한다).
const narrowTap = kind => ({ target: { closest: sel => (kind && sel.split(', ').includes(kind) ? {} : null) } });
const NARROW_TASK = "{ id: 't1', description: '결제 실패 알림 문구 정리', status: 'to-do', scheduled: todayStr(), priority: 'medium' }";

test('좁은 폭: 업무 줄 아무 데나 누르면 그 업무 시트가 열리고, 체크 칸·선택 칸·원문·버튼·입력칸·제목에서 온 누름은 제 할 일만 한다', () => {
  const app = narrowClient(390);
  const row = app.run(`uiTaskRow(${NARROW_TASK}, { mode: 'today' })`);
  assert.equal(row.getAttribute('tabindex'), undefined, '줄에 tabindex를 새로 주지 않는다');
  row.listeners.click(narrowTap(null));
  same(app.run('opened'), [{ id: 't1' }], '빈 자리·상태말 = 시트 열기');
  for (const kind of ['.d-check', '.d-sel', 'input', 'a', 'button', 'textarea', '.d-title']) row.listeners.click(narrowTap(kind));
  assert.equal(app.run('opened.length'), 1, '체크 칸 여백·원문·⋯·제목(제 누름이 따로 있다)은 시트를 열지 않는다');
  // 프로젝트 상세의 진행할 업무 줄도 같은 규칙
  const prow = app.run(`projectTaskRow(${NARROW_TASK})`);
  prow.listeners.click(narrowTap(null));
  prow.listeners.click(narrowTap('.d-check'));
  prow.listeners.click(narrowTap('button'));
  same(app.run('opened'), [{ id: 't1' }, { id: 't1' }]);
});

test('넓은 폭: 줄 누름은 아무 일도 하지 않고(제목만 연다), 줄의 내일·나중에 버튼은 그대로다', () => {
  const app = narrowClient(1280);
  const row = app.run(`uiTaskRow(${NARROW_TASK}, { mode: 'today' })`);
  row.listeners.click(narrowTap(null));
  app.run(`projectTaskRow(${NARROW_TASK})`).listeners.click(narrowTap(null));
  assert.equal(app.run('opened.length'), 0);
  const acts = row.children.find(kid => kid.className === 'd-acts');
  assert.deepEqual(acts.children.map(kid => kid.textContent || kid.getAttribute('aria-label')), ['내일', '나중에', '결제 실패 알림 문구 정리 — 더 보기'],
    '버튼은 그대로 그려지고, 좁은 폭에서 숨기는 것은 CSS 몫이다');
  const title = row.children.find(kid => kid.className === 'd-title');
  title.listeners.click();
  same(app.run('opened'), [{ id: 't1' }]);
});

test('좁은 폭: 여러 개 선택 중에는 줄 누름 = 선택(시트는 열리지 않는다)', () => {
  const app = narrowClient(390);
  app.run('taskSelectionMode = true;');
  const row = app.run(`uiTaskRow(${NARROW_TASK}, { mode: 'today' })`);
  const box = row.children.find(kid => kid.className === 'd-sel').children[0];
  let clicks = 0;
  box.click = () => { clicks += 1; };
  row.listeners.click(narrowTap(null));
  assert.equal(clicks, 1);
  assert.equal(app.run('opened.length'), 0);
});

// ---- 여러 개 선택(C안): 완료 체크 자리에 선택 칸 하나, 우선순위·진행 중은 오른쪽 글자, 줄 누름 = 선택(폭 무관) ----
const kidOf = (node, cls) => node.children.find(kid => String(kid?.className || '').split(' ').includes(cls));
const SEL_TASK = "{ id: 's1', description: '결제 실패 알림 문구 정리', status: 'to-do', scheduled: todayStr(), priority: 'high', doing: todayStr() }";

test('여러 개 선택: 줄에 누를 네모는 선택 칸 하나뿐이고(완료 체크 없음), 완료한 줄은 빈 자리만 — 모드를 끝내면 원래대로', () => {
  const app = narrowClient(1280);
  app.run('taskSelectionMode = true;');
  const row = app.run(`uiTaskRow(${SEL_TASK}, { mode: 'today' })`);
  assert.equal(kidOf(row, 'd-check'), undefined, '완료 체크 칸을 그리지 않는다');
  assert.equal(row.children[0].className, 'd-sel', '선택 칸이 첫 칸(완료 체크 자리)에 선다');
  assert.equal(row.children[0].children.length, 1);
  assert.equal(row.children[0].children[0].className, 'd-selcb');
  const done = app.run(`uiTaskRow({ id: 'd1', description: '끝난 일', status: 'done', priority: 'high' }, { mode: 'today' })`);
  assert.equal(kidOf(done, 'd-check'), undefined, '완료한 줄도 모드 중에는 완료 취소 체크가 없다');
  assert.equal(done.children[0].className, 'd-sel');
  assert.equal(done.children[0].children.length, 0, '완료한 줄은 고를 수 없다 — 자리만 지킨다');
  // 모드를 끝내면 완료 체크(꺾쇠·반쯤 참 포함)로 돌아온다.
  app.run('taskSelectionMode = false;');
  const back = app.run(`uiTaskRow(${SEL_TASK}, { mode: 'today' })`);
  assert.equal(kidOf(back, 'd-sel'), undefined);
  assert.equal(back.children[0].className, 'd-check');
  assert.equal(back.children[0].children[0].className, 'd-cb is-pri-high is-doing');
});

test('여러 개 선택: 체크박스가 말하던 우선순위·진행 중은 오른쪽 상태 글자로 옮겨 가고(진행 중 그룹 안은 제외), 모드 밖에서는 글자가 없다', () => {
  const app = narrowClient(1280);
  const meta = row => kidOf(row, 'd-meta').innerHTML;
  assert.doesNotMatch(meta(app.run(`uiTaskRow(${SEL_TASK}, { mode: 'today' })`)), /m-pri|m-doing/, '모드 밖: 체크박스가 말한다');
  app.run('taskSelectionMode = true;');
  const html = meta(app.run(`uiTaskRow(${SEL_TASK}, { mode: 'today' })`));
  assert.match(html, /m-pri k-warn"[^>]*>중요/);
  assert.match(html, /m-doing"[^>]*>.*진행 중/s);
  const critical = meta(app.run(`uiTaskRow(${SEL_TASK.replace("'high'", "'critical'")}, { mode: 'later' })`));
  assert.match(critical, /m-pri k-neg"[^>]*>긴급/, '서랍 줄도 같다');
  const grouped = meta(app.run(`uiTaskRow(${SEL_TASK}, { mode: 'today', inDoingGroup: true })`));
  assert.match(grouped, /중요/);
  assert.doesNotMatch(grouped, /m-doing/, '진행 중 그룹 안에서는 그룹 제목이 말한다');
});

test('여러 개 선택: 넓은 폭에서도 줄 빈 곳 누름 = 선택(제목·입력칸·링크·버튼은 제 할 일), 저장 중·완료한 줄은 무시', () => {
  const app = narrowClient(1280);
  app.run('taskSelectionMode = true;');
  const row = app.run(`uiTaskRow(${SEL_TASK}, { mode: 'today' })`);
  const box = row.children[0].children[0];
  let clicks = 0;
  box.click = () => { clicks += 1; };
  row.listeners.click(narrowTap(null));
  assert.equal(clicks, 1, '빈 자리·상태말 = 선택');
  row.listeners.click(narrowTap('.d-sel'));
  assert.equal(clicks, 2, '선택 칸의 빈 여백도 선택');
  for (const kind of ['input', 'a', 'button', 'textarea', 'select', 'label', '.d-title']) row.listeners.click(narrowTap(kind));
  assert.equal(clicks, 2, '선택 칸 자신·원문·제목(자기 클릭이 이미 선택)은 두 번 바꾸지 않는다');
  kidOf(row, 'd-title').listeners.click();
  assert.equal(clicks, 3, '제목 누름은 그대로 선택');
  app.run('taskBatchBusy = true;');
  row.listeners.click(narrowTap(null));
  assert.equal(clicks, 3, '저장 중에는 줄 누름을 무시한다');
  app.run('taskBatchBusy = false;');
  const done = app.run(`uiTaskRow({ id: 'd1', description: '끝난 일', status: 'done' }, { mode: 'today' })`);
  done.listeners.click(narrowTap(null));
  assert.equal(app.run('opened.length'), 0, '넓은 폭·선택 중에는 상세를 열지 않는다');
});

test('여러 개 선택: 키보드는 선택 칸에서만 멈추고(제목 tabIndex -1), 이름표가 우선순위·진행 중을 함께 읽는다', () => {
  const app = narrowClient(1280);
  const title = row => kidOf(row, 'd-title');
  assert.equal(title(app.run(`uiTaskRow(${SEL_TASK}, { mode: 'today' })`)).tabIndex, 0);
  app.run('taskSelectionMode = true;');
  const row = app.run(`uiTaskRow(${SEL_TASK}, { mode: 'today' })`);
  assert.equal(title(row).tabIndex, -1);
  assert.equal(row.children[0].children[0].getAttribute('aria-label'), '결제 실패 알림 문구 정리 — 중요 · 진행 중 · 선택');
  const plain = app.run("uiTaskRow({ id: 'p1', description: '보통 일', status: 'to-do', priority: 'medium' }, { mode: 'today' })");
  assert.equal(plain.children[0].children[0].getAttribute('aria-label'), '보통 일 — 선택');
  const critical = app.run("uiTaskRow({ id: 'c1', description: '급한 일', status: 'to-do', priority: 'critical' }, { mode: 'later' })");
  assert.equal(critical.children[0].children[0].getAttribute('aria-label'), '급한 일 — 긴급 · 선택');
  app.run('taskSelectionMode = false;');
  assert.equal(title(app.run(`uiTaskRow(${SEL_TASK}, { mode: 'today' })`)).tabIndex, 0, '끝내면 제목이 다시 탭 차례에 선다');
});

test('여러 개 선택 CSS: 열을 더하지 않고(줄이 밀리지 않는다) 선택 칸이 30px 첫 칸 가운데에 선다 — 좁은 폭·서랍도 같은 칸', () => {
  const css = fs.readFileSync(path.join(__dirname, 'ui.css'), 'utf8');
  assert.doesNotMatch(css, /body\.batch-open \.d-row[^{]*\{[^}]*grid-template-columns/, '선택 모드용 격자가 따로 없다');
  assert.doesNotMatch(css, /grid-area: sl|"sl /, '좁은 폭의 sl 칸도 없다');
  assert.match(css, /\n\.d-sel \{ width: 30px; height: var\(--row\); display: grid; place-items: center; \}/);
  assert.match(css, /\.d-row \.d-check, \.d-row \.d-sel \{ grid-area: ck;/);
  assert.match(css, /\.d-dbody \.d-check, \.d-dbody \.d-sel \{ grid-area: ck;/);
  assert.match(css, /\.d-selcb \{[^}]*width: 17px; height: 17px;[^}]*border-radius: 4px;/, '선택 칸 모양은 그대로');
  assert.match(css, /\.d-selbar \.hint \{ font-size: 13\.5px; font-weight: 500; color: var\(--dim\);/);
  assert.match(css, /\.d-selbar \.is-group \{ margin-left: 10px; \}/);
});

function selectBarClient() {
  const app = narrowClient(1280);
  const sent = [];
  app.context.fetch = async (url, init) => {
    sent.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({ ok: true, count: 1, undoToken: 'u1' }));
  };
  app.run(`document.body = document.createElement('div'); document.querySelectorAll = () => [];
    taskListsCache = { todayTasks: [${SEL_TASK}, { id: 's2', description: '두 번째', status: 'to-do', scheduled: todayStr() }], laterTasks: [] };
    var menus = []; uiMenu = (anchor, sections) => menus.push({ anchor, sections });
    var groupOpts = null; renderGroupControl = (opts) => { groupOpts = opts; return document.createElement('div'); };
    taskSelectionMode = true;`);
  const bar = () => app.nodes.get('taskSelectBar').children[0];
  return { app, sent, bar };
}

test('선택 막대: 0개면 `줄을 눌러 골라요`(조용한 글자), 고르면 `N개 선택` — 프로젝트…와 완료로 표시 앞에 묶음 간격', () => {
  const { app, bar } = selectBarClient();
  app.run('taskSelectionRefresh()');
  const lead = bar().children[0];
  assert.equal(lead.className, 'hint');
  assert.equal(lead.textContent, '줄을 눌러 골라요');
  const buttons = bar().children.filter(kid => kid.type === 'button');
  const byText = text => buttons.find(button => button.textContent === text);
  assert.deepEqual(buttons.map(button => button.textContent),
    ['전체 선택', '오늘로', '내일', '나중에', '날짜…', '프로젝트…', '완료로 표시', '삭제', '선택 끝내기'], '동작 목록·차례는 그대로');
  assert.equal(byText('프로젝트…').className, 'd-btn is-group');
  assert.equal(byText('완료로 표시').className, 'd-btn acc is-group');
  assert.equal(byText('삭제').className, 'd-btn dng is-group', '삭제는 완료와 떨어져 선다(잘못 누르지 않게)');
  assert.equal(byText('오늘로').className, 'd-btn');
  assert.ok(['오늘로', '프로젝트…', '완료로 표시', '삭제'].every(text => byText(text).disabled), '0개면 바꾸는 버튼은 눌리지 않는다');
  assert.equal(byText('선택 끝내기').disabled, false);
  app.run("taskSelection.add('s1'); taskSelectionRefresh()");
  assert.equal(bar().children[0].className, 'ct num');
  assert.equal(bar().children[0].textContent, '1개 선택');
});

test('선택 막대: `프로젝트…`는 그 자리에서 프로젝트 고르기를 열고, 고른 값을 기존 일괄 저장 길(task-batch)로 보낸다', async () => {
  const { app, sent, bar } = selectBarClient();
  app.run("taskSelection.add('s1'); taskSelection.add('s2'); taskSelectionRefresh()");
  const project = bar().children.find(kid => kid.textContent === '프로젝트…');
  assert.equal(project.getAttribute('aria-haspopup'), 'true');
  let stopped = false;
  project.listeners.click({ stopPropagation() { stopped = true; } });
  assert.ok(stopped);
  assert.equal(app.run('menus.length'), 1);
  assert.equal(app.run('menus[0].anchor') , project, '누른 버튼 자리에 붙는다');
  assert.equal(app.run('menus[0].sections[0][0].field'), '프로젝트');
  same(app.run('({ silent: groupOpts.silent, forceClearable: groupOpts.forceClearable, jira: groupOpts.jira, group: groupOpts.group })'),
    { silent: true, forceClearable: true, jira: null, group: null });
  await app.run('groupOpts.onSetGroup(null)');
  assert.equal(sent.length, 0, '`— 프로젝트 빼기 —`는 지라 해제 한 번으로 끝난다(두 번 보내지 않는다)');
  await app.run("groupOpts.onSetJira('AB-1')");
  same(sent.map(call => call.url), ['/api/workflow/task-batch']);
  same(sent[0].body, { ids: ['s1', 's2'], change: { project: 'jira:AB-1' } });
  app.run("taskSelection.add('s1')");
  await app.run("groupOpts.onSetGroup('가입 개선')");
  same(sent[1].body, { ids: ['s1'], change: { project: 'group:가입 개선' } });
});

test('여러 개 선택: 다른 탭으로 가면 선택 모드와 막대가 끝난다(오늘 탭 안에서는 그대로)', () => {
  // setActiveTab은 화면을 켜는 실행 코드 쪽이라 가짜 창에 올라오지 않는다 — 그 한 줄을 글자로 확인하고, 부르는 끝내기를 직접 돌린다.
  const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  const start = source.indexOf('function setActiveTab(');
  const tab = source.slice(start, source.indexOf('\n}\n', start));
  assert.match(tab, /if \(tab !== 'today' && taskSelectionMode\) taskSelectEnd\(\);/);
  assert.match(tab, /usageTabOpened\(tab, activeTabKey\)/, '사용 횟수 호출은 그대로');
  const { app } = selectBarClient();
  app.run("renderTodayTasks = () => {}; renderLaterTasks = () => {}; escStack.push(taskSelectEnd); taskSelection.add('s1'); taskSelectionRefresh()");
  assert.equal(app.nodes.get('taskSelectBar').hidden, false);
  app.run('taskSelectEnd()');
  assert.equal(app.run('taskSelectionMode'), false);
  assert.equal(app.run('taskSelection.size'), 0);
  assert.equal(app.nodes.get('taskSelectBar').hidden, true, '막대도 내려간다');
});

function narrowSheet(app, item) {
  return app.run(`(() => { const box = document.createElement('div'); panelTask({ item: ${item}, detail: null, type: 'task' }, box); return box; })()`)
    .children.find(kid => kid.className === 'd-dfoot');
}

test('시트 발: 밀린 업무(줄에 `오늘 할게요`가 뜨던 조건)면 좁은 폭에서 `오늘 할게요`가 더 서고, 아닌 업무·넓은 폭·진행 중이면 없다', () => {
  const carried = "{ id: 'c1', description: '주간 지표 대시보드 확인', status: 'to-do', scheduled: '2020-01-01', priority: 'medium' }";
  const app = narrowClient(390);
  app.run(`taskListsCache = { todayTasks: [${carried}], laterTasks: [] };`);
  assert.deepEqual(narrowSheet(app, carried).children.map(kid => kid.textContent), ['완료로 표시', '오늘 할게요', '내일', '나중에']);
  assert.deepEqual(narrowSheet(app, NARROW_TASK).children.map(kid => kid.textContent), ['완료로 표시', '내일', '나중에']);
  assert.deepEqual(narrowSheet(app, carried.replace("priority: 'medium'", "priority: 'medium', doing: todayStr()")).children.map(kid => kid.textContent),
    ['완료로 표시', '내일', '나중에'], '진행 중인 업무는 줄에서처럼 `오늘 할게요`가 없다');
  const wide = narrowClient(1280);
  wide.run(`taskListsCache = { todayTasks: [${carried}], laterTasks: [] };`);
  assert.deepEqual(narrowSheet(wide, carried).children.map(kid => kid.textContent), ['완료로 표시', '내일', '나중에'], '넓은 폭 카드는 그대로');
});

test('시트 발: 좁은 폭에서 내일·나중에·오늘로·오늘 할게요는 옮긴 뒤 시트를 닫고, 넓은 폭 카드는 닫지 않는다(줄이 사라지면 따라 닫힌다)', async () => {
  for (const [width, label, scheduled, closes] of [[390, '내일', 'tomorrow', 1], [390, '나중에', null, 1], [390, '오늘로', 'today', 1], [390, '오늘 할게요', 'today', 1], [1280, '내일', 'tomorrow', 0]]) {
    const app = narrowClient(width);
    const sent = [];
    app.context.fetch = async (url, init) => { sent.push({ url, body: init && init.body ? JSON.parse(init.body) : null }); return new Response('{"ok":true}'); };
    const item = label === '오늘로' ? "{ id: 'l1', description: '나중 일', status: 'to-do', scheduled: null, priority: 'medium' }"
      : label === '오늘 할게요' ? "{ id: 'c1', description: '밀린 일', status: 'to-do', scheduled: '2020-01-01', priority: 'medium' }" : NARROW_TASK;
    app.run(`taskListsCache = { todayTasks: [${label === '오늘로' ? '' : item}], laterTasks: [${label === '오늘로' ? item : ''}] };`);
    app.run("var closed = 0; panelClose = () => { closed += 1; }; panelState = { kind: 'item', id: 'x' };");
    const button = narrowSheet(app, item).children.find(kid => kid.textContent === label);
    await button.listeners.click();
    const want = scheduled === 'tomorrow' ? app.run('tomorrowStr()') : scheduled === 'today' ? app.run('todayStr()') : null;
    assert.deepEqual(sent.find(call => call.url === '/api/track/set-scheduled').body.scheduled, want, `${width} ${label}`);
    assert.equal(app.run('closed'), closes, `${width} ${label}`);
  }
});

test('시트 발 `완료로 표시`는 지금처럼 완료하고 닫는다', async () => {
  const app = narrowClient(390);
  app.context.fetch = async () => new Response('{"ok":true}');
  app.run("var closed = 0; panelClose = () => { closed += 1; }; panelState = { kind: 'item', id: 't1' };");
  await narrowSheet(app, NARROW_TASK).children[0].listeners.click();
  assert.equal(app.run('closed'), 1);
  assert.equal(app.nodes.get('liveRegion').textContent, '완료했어요');
});

test('시트 가림막: 열면 서고, 누르면 닫히며(회의 정리는 빈 자리로 닫히지 않는 규칙 그대로), 닫히면 걷힌다', () => {
  const app = narrowClient(390);
  app.run('document.body = document.createElement("div");');
  app.run('panelScrim(true)');
  const scrim = app.run('panelScrimEl');
  assert.equal(scrim.className, 'd-scrim');
  assert.equal(scrim.hidden, false);
  assert.equal(scrim.getAttribute('aria-hidden'), 'true');
  assert.equal(app.run('document.body.children[0] === panelScrimEl'), true, '문서 끝(선택 막대 뒤)에 붙는다');
  app.run("var closed = 0; var realClose = panelClose; panelClose = () => { closed += 1; };");
  app.run("panelState = { kind: 'meeting', id: 'm1' };");
  scrim.listeners.click();
  assert.equal(app.run('closed'), 0, '회의 정리 시트는 가림막으로 닫히지 않는다');
  app.run("panelState = { kind: 'item', id: 't1' };");
  scrim.listeners.click();
  assert.equal(app.run('closed'), 1);
  app.run('document.removeEventListener = () => {}; window.removeEventListener = () => {}; document.querySelectorAll = () => [];');
  app.run('panelClose = realClose; panelState = null; panelClose();');
  assert.equal(scrim.hidden, true, 'panelClose가 가림막도 걷는다');
});

test('시트가 닫히면 초점은 연 줄 제목 → 그 줄이 옮겨져 사라졌으면 다음 줄 제목 → 둘 다 없으면 목록 머리(h2, tabindex -1)', () => {
  const app = narrowClient(390);
  app.run('CSS = { escape: s => s };');
  // 줄 표식: 같은 목록 안의 다음 업무 줄(그룹 제목 등은 건너뛴다)
  const spot = app.run(`(() => {
    const next = { dataset: { taskId: 't3' } };
    const heading = { dataset: {}, nextElementSibling: next };
    const row = { dataset: { taskId: 't1' }, nextElementSibling: heading, closest: () => ({ id: 'todayTaskList' }) };
    return panelSheetSpot(row);
  })()`);
  same(spot, { id: 't1', nextId: 't3', host: 'todayTaskList' });
  const focusWith = (rows) => app.run(`(() => {
    const focused = [];
    const title = id => ({ focus: () => focused.push(id) });
    const rows = ${JSON.stringify(rows)};
    const h2 = { attrs: {}, hasAttribute(n) { return n in this.attrs; }, setAttribute(n, v) { this.attrs[n] = v; }, focus: () => focused.push('h2') };
    const host = {
      querySelector: sel => { const id = sel.match(/"(.+)"/)[1]; return rows.includes(id) ? { querySelector: () => title(id) } : null; },
      closest: () => ({ querySelector: () => h2 }),
    };
    document.getElementById = () => host;
    const ok = panelSheetFocus(${JSON.stringify(spot)});
    return { ok, focused, tabindex: h2.attrs.tabindex };
  })()`);
  same(focusWith(['t1', 't3']), { ok: true, focused: ['t1'] });
  same(focusWith(['t3']), { ok: true, focused: ['t3'] });
  same(focusWith([]), { ok: true, focused: ['h2'], tabindex: '-1' });
});

test('누르는 화면: 완료·옮기기 알림은 `⌘Z로 되돌리기` 글자 대신 `되돌리기` 버튼(→ replayUndo), 마우스 화면은 지금 글자 그대로', () => {
  const notice = (touch, action = false) => {
    const app = narrowClient(390);
    app.run(`window.matchMedia = q => ({ matches: ${touch} && q === '(hover: none) and (pointer: coarse)' }); navigator = { platform: 'MacIntel' };`);
    app.run("var replayed = []; replayUndo = dir => replayed.push(dir);");
    const region = app.run("document.getElementById('liveRegion')");
    region.insertBefore = (node, ref) => { const at = region.children.indexOf(ref); region.children.splice(at < 0 ? region.children.length : at, 0, node); };
    Object.defineProperty(region, 'lastChild', { get() { return region.children[region.children.length - 1]; } });
    app.run("pushUndo({ label: 'x', undo() {}, redo() {} });");
    app.run(action ? "workflowOutcome({ id: 't1' }, undoStack[undoStack.length - 1])" : "uiUndoNotice('내일로 미뤘어요', null, undoStack[undoStack.length - 1])");
    return { app, region, labels: region.children.map(kid => kid.textContent) };
  };
  const touch = notice(true);
  assert.deepEqual(touch.labels, ['⌘Z로 되돌리기', '되돌리기', '닫기'], '글자 안내는 ui.css가 누르는 화면에서 숨긴다');
  touch.region.children[1].listeners.click();
  same(touch.app.run('replayed'), ['undo']);
  assert.equal(touch.region.children[1].disabled, true, '두 번 눌리지 않게');
  assert.deepEqual(notice(false).labels, ['⌘Z로 되돌리기', '닫기'], '마우스 화면은 지금 그대로');
  assert.deepEqual(notice(true, true).labels, ['⌘Z로 되돌리기', '결과 한 줄 남기기', '되돌리기', '닫기'], '완료 알림은 결과 한 줄 남기기 옆에 되돌리기');
  assert.deepEqual(notice(false, true).labels, ['⌘Z로 되돌리기', '결과 한 줄 남기기', '닫기']);
  // 되돌릴 기록이 없으면(3초가 지났으면) 버튼을 달지 않는다
  const stale = narrowClient(390);
  stale.run("window.matchMedia = () => ({ matches: true }); pushUndo({ label: 'x', undo() {}, redo() {} }); lastUndoRecordedAt = 0; uiUndoNotice('내일로 미뤘어요', null, undoStack[0]);");
  assert.deepEqual(stale.nodes.get('liveRegion').children.map(kid => kid.textContent), ['닫기']);
});

test('누르는 화면 되돌리기 버튼은 그 작업의 기록만 — 저장이 겹쳐 어느 기록인지 모르면 버튼 없음, 맨 위가 아니면 되돌리지 않음', () => {
  const app = narrowClient(390);
  app.run("window.matchMedia = () => ({ matches: true }); var replayed = []; replayUndo = dir => replayed.push(dir);");
  // 작업 하나가 기록 하나를 남기면 그 기록, 둘 이상 겹치면 null, 기록이 없어도 null
  same(app.run(`(() => {
    const mark0 = uiUndoMark();
    pushUndo({ label: 'A', undo() {}, redo() {} });
    const one = uiUndoOwn(mark0)?.label || null;
    const mark1 = uiUndoMark();
    pushUndo({ label: 'B', undo() {}, redo() {} });
    pushUndo({ label: 'C', undo() {}, redo() {} });
    const many = uiUndoOwn(mark1);
    const none = uiUndoOwn(uiUndoMark());
    return { one, many, none };
  })()`), { one: 'A', many: null, none: null });
  // 알림은 A의 것인데 그 뒤에 B가 쌓였다 → 누르면 B를 되돌리지 않고 순서를 알린다
  const region = app.run("document.getElementById('liveRegion')");
  app.run("var entryA = { label: 'A', undo() {}, redo() {} }; pushUndo(entryA); uiUndoNotice('내일로 미뤘어요', null, entryA); pushUndo({ label: 'B', undo() {}, redo() {} });");
  const button = region.children.find(kid => kid.textContent === '되돌리기');
  app.run("var realNotice = showNotice; var said = []; showNotice = (text, error) => said.push([text, error]);");
  button.listeners.click();
  app.run('showNotice = realNotice');
  same(app.run('replayed'), []);
  same(app.run('said'), [['최근 작업부터 순서대로 실행 취소해 주세요', true]]);
  // 기록을 모르면(null) 버튼 없이 글자 안내만
  const blind = narrowClient(390);
  blind.run("window.matchMedia = () => ({ matches: true }); pushUndo({ label: 'D', undo() {}, redo() {} }); uiUndoNotice('내일로 미뤘어요', null, null);");
  assert.ok(!blind.run("document.getElementById('liveRegion')").children.some(kid => kid.textContent === '되돌리기'));
});

test('좁은 폭 시트: 탭을 옮기면 닫혀 가림막이 남지 않고, 창이 넓어지면 가림막을 걷고 줄 옆 카드로 옮겨 그린다', () => {
  const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  const tab = source.slice(source.indexOf('function setActiveTab('), source.indexOf('Object.entries(TABS).forEach', source.indexOf('function setActiveTab(')));
  assert.match(tab, /if \(tab !== activeTabKey && panelScrimEl && !panelScrimEl\.hidden\) panelClose\(\);/);
  assert.match(source, /window\.addEventListener\('resize', panelSheetResize\);/);
  const app = narrowClient(390);
  same(app.run(`(() => {
    const calls = [];
    panelState = { id: 't1' };
    panelScrimEl = { hidden: false };
    const side = { hidden: false, replaceChildren: () => calls.push('clear') };
    panelSide = () => side;
    panelRender = () => calls.push('render');
    window.innerWidth = 800;
    panelSheetResize();
    return { calls, scrimHidden: panelScrimEl.hidden, sideHidden: side.hidden };
  })()`), { calls: ['clear', 'render'], scrimHidden: true, sideHidden: true });
});

test('좁은 폭 CSS: 업무 줄에는 ⋯만(제안 줄은 그대로), 체크·⋯ 누르는 자리 38px, 가림막, 누르는 화면의 ⌘Z 글자 숨김 — 넓은 폭 규칙은 없다', () => {
  const css = fs.readFileSync(path.join(__dirname, 'ui.css'), 'utf8');
  const narrow = [...css.matchAll(/@media \(max-width: 520px\) \{([\s\S]*?)\n\}/g)].map(m => m[1]).join('\n');
  assert.match(narrow, /\.d-row:not\(\.is-sug\) \.d-acts > \.d-btn \{ display: none; \}/);
  assert.match(narrow, /\.d-prow2 \.ac > \.d-btn \{ display: none; \}/);
  assert.match(narrow, /\.d-row \.d-cb::after, \.d-prow2 \.d-cb::after \{ inset: -10px;/, '::after는 테두리 안쪽(19px)에서 재므로 19 + 10 × 2 = 39px');
  assert.match(narrow, /\.d-row \.d-acts \.d-more::after, \.d-prow2 \.ac \.d-more::after \{ content: ''; position: absolute; inset: -3px;/, '32 + 3 × 2 = 38px');
  assert.match(narrow, /\.d-scrim:not\(\[hidden\]\) \{ display: block; position: fixed; inset: 0; z-index: 46; background: var\(--scrim\); \}/);
  assert.doesNotMatch(narrow, /\.m-proj \{ display: inline/, '프로젝트 이름은 제목 뒤 .d-inproj 하나만 — 상태 줄에 또 찍지 않는다');
  const wide = css.replace(/@media \(max-width: 520px\) \{[\s\S]*?\n\}/g, '');
  assert.doesNotMatch(wide, /\.d-acts > \.d-btn \{ display: none|\.ac > \.d-btn \{ display: none|\.d-scrim:not/, '넓은 폭에는 새 규칙이 없다');
  assert.match(wide, /\.d-scrim \{ display: none; \}/);
  assert.match(css, /@media \(hover: none\) and \(pointer: coarse\) \{ \.d-tnote \{ display: none; \} \}/);
});

test('안전장치 정의 불변: request·showNotice·pushUndo·recordUndoFor·toggleTask·fadeOutAndRun·isClientFile은 한 글자도 바뀌지 않았다', () => {
  // 바꿔야 할 일이 생기면 이 값도 함께 바꾼다 — 검토에서 눈에 띄게 하려는 자물쇠다.
  const crypto = require('node:crypto');
  const fnSource = (file, name) => {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
    const at = source.indexOf(`function ${name}(`);
    const from = source.lastIndexOf('\n', at) + 1;
    let depth = 0;
    for (let i = source.indexOf('{', at); i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}' && --depth === 0) return source.slice(from, i + 1);
    }
    return '';
  };
  const hash = (file, name) => crypto.createHash('sha256').update(fnSource(file, name)).digest('hex').slice(0, 16);
  same(Object.fromEntries(['request', 'showNotice', 'pushUndo', 'recordUndoFor', 'toggleTask', 'fadeOutAndRun'].map(name => [name, hash('app.js', name)])), {
    request: 'f5330efee721c1be', showNotice: '27900565f62632d7', pushUndo: '9c58100ac7b9fe14',
    recordUndoFor: 'e4ace20da15f22d4', toggleTask: '56730551bbbf4bc4', fadeOutAndRun: '7863e32aa6abda7c',
  });
  assert.equal(hash('server.js', 'isClientFile'), 'c0879ada26c72b01');
  assert.match(fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8'), /if \(error\.code === 'RECOVERY_NEEDED'\) \{/);
});

// ─────────────────────────────────────────────────────────────────────────────
// WP-V — 캘린더 `맥 캘린더` 갈래. 화면은 요청(POST mac-check)만 하고 결과(GET calendar/mac)를 2초마다 기다린다 —
// 여기서는 기다림(setTimeout)을 곧바로 넘기고, 결과는 가짜 답(fx.mac.view)으로 바꿔 끼운다.
const MAC_CALS = [
  { id: 'CAL-HOLIDAY', name: '대한민국의 휴일', writable: false },
  { id: 'CAL-ME', name: 'me@example.test', writable: true },
];
const macState = (extra = {}) => ({ at: '2026-09-29T01:00:05.000Z', kind: 'check', requestedAt: '2026-09-29T01:00:00.000Z', ok: true, reason: null, calendars: MAC_CALS, suggested: ['CAL-ME'], read: ['CAL-ME'], missing: [], eventCount: 3, ...extra });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('WP-V F. 맥 캘린더: 허용하고 확인 → 요청만 보내고 결과를 기다려 `캘린더 N개 · 오늘 일정 M개를 읽었어요` + 체크 목록(기본은 내 이메일 캘린더) → 이 캘린더로 연결', async () => {
  const fx = intgClient({}, [
    { body: { ok: true, requestedAt: '2026-09-29T01:00:00.000Z' } },
    { body: { ok: true, restart: false, calendar: { source: 'mac', calendars: 1 } } },
  ]);
  await fx.app.run('renderSettingsIntegrations()');
  fx.toggle('calendar').listeners.click();
  await tick();
  const pick = () => fx.find('calendar', 'd-ichwrap')[0];
  assert.equal(pick().hidden, true, '확인 전에는 목록이 없다');
  fx.app.context.setTimeout = (fn) => { fn(); return 0; };
  // 기다리는 동안 처음 두 번은 아직 옛 결과(다른 요청) — 세 번째에 이번 요청의 결과가 온다
  let polls = 0;
  fx.mac.view = () => {
    polls += 1;
    return { ok: true, installed: true, requestedAt: '2026-09-29T01:00:00.000Z', chosen: [], state: polls < 3 ? macState({ requestedAt: '2026-09-28T01:00:00.000Z' }) : macState() };
  };
  const go = fx.button('calendar', '허용하고 확인');
  const waiting = go.listeners.click();
  assert.equal(go.disabled, true);
  assert.equal(go.textContent, '확인하는 중…');
  await waiting;
  assert.equal(polls, 3, '이번 요청의 결과가 올 때까지 기다린다');
  const asked = fx.sent.filter(one => one.url === '/api/integrations/calendar/mac-check');
  assert.equal(asked.length, 1, '요청은 한 번');
  assert.ok(fx.sent.filter(one => one.url === '/api/integrations/calendar/mac').length >= 2, '결과를 기다린다');
  assert.equal(go.disabled, false);
  assert.match(fx.text('calendar'), /캘린더 2개 · 오늘 일정 3개를 읽었어요/);
  const rows = fx.find('calendar', 'd-ich');
  same(rows.map(row => row.dataset.calendar), ['CAL-HOLIDAY', 'CAL-ME']);
  same(rows.map(row => row.children[0].checked), [false, true], '기본은 내 이메일 이름의 캘린더 하나');
  same(rows.map(row => row.className), ['d-ich is-cal', 'd-ich is-cal is-on']);
  assert.match(fx.text('calendar'), /대한민국의 휴일읽기 전용 — 휴일·구독·다른 사람 캘린더일 수 있어요/);
  assert.equal(rows[1].children[0].getAttribute('aria-label'), 'me@example.test 읽기');
  // 다 끄면 연결할 수 없다
  rows[1].children[0].checked = false;
  rows[1].children[0].listeners.change();
  const save = fx.button('calendar', '이 캘린더로 연결');
  assert.equal(save.disabled, true);
  rows[1].children[0].checked = true;
  rows[1].children[0].listeners.change();
  assert.equal(save.disabled, false);
  await save.listeners.click();
  same(fx.sent.find(one => one.url === '/api/integrations/save').body, { calendar: { enabled: true, source: 'mac', macCalendars: [{ id: 'CAL-ME', name: 'me@example.test' }] } });
  assert.match(fx.live(), /맥 캘린더를 연결했어요 · 캘린더 1개 — 1분 안에 오늘 일정이 채워져요/);
});

test('WP-V F. 맥 캘린더 확인 실패: 막힘은 이유 + 시스템 설정 가는 길, 계정 없음은 1단계 안내, 옛 설치는 업데이트 안내, 결과가 안 오면 다시 누르라고', async () => {
  const run = async (view, replies = [{ body: { ok: true, requestedAt: '2026-09-29T01:00:00.000Z' } }]) => {
    const fx = intgClient({}, replies);
    await fx.app.run('renderSettingsIntegrations()');
    fx.toggle('calendar').listeners.click();
    await tick();
    fx.app.context.setTimeout = (fn) => { fn(); return 0; };
    if (view) fx.mac.view = view;
    await fx.button('calendar', '허용하고 확인').listeners.click();
    const box = fx.find('calendar', 'd-ichoice').find(one => one.dataset.choice === 'mac');
    const error = box.children.find(one => one.className === 'd-derr').textContent;
    const help = box.children.find(one => one.className === 'd-imachelp');
    return { fx, error, help };
  };
  const denied = await run({ ok: true, installed: true, state: macState({ ok: false, reason: 'denied', calendars: [], eventCount: null }) });
  assert.equal(denied.error, '맥이 캘린더 접근을 막았어요 — 맥 설정 › 개인정보 보호 및 보안 › 캘린더(그리고 자동화)에서 목록의 이름을 찾아 켜 주세요');
  assert.equal(denied.help.hidden, false);
  assert.match(denied.help.children[0].textContent, /애플 메뉴 › 시스템 설정이에요\. 캘린더 목록에서 아래 같은 이름을 찾아 「전체 접근」으로 켜고, 같은 화면의 자동화에서도 캘린더를 켠 뒤/);
  // 찾을 이름 예시 그림 — 맥 화면이 아니라 예시임을 캡션이 말하고, 이름은 읽기 길에서 아는 것(node·osascript)만. 스위치는 그림이라 읽지 않는다.
  const pic = denied.help.children[1];
  assert.match(denied.fx.app.run('settingsMacDeniedPic.toString()'), /createElement\('figure'\)[\s\S]*createElement\('figcaption'\)/, '그림은 figure + figcaption');
  assert.equal(pic.className, 'd-imacpic');
  assert.equal(pic.children[0].textContent, '예시 그림 — 맥 화면이 아니에요. 이름은 맥에 따라 달라요');
  assert.equal(pic.children[1].textContent, '개인정보 보호 및 보안 › 캘린더');
  const picRows = pic.children.filter(one => one.className === 'row');
  same(picRows.map(row => row.children[0].textContent), ['node', 'osascript']);
  assert.ok(picRows.every(row => row.children[1].className === 'sw' && row.children[1].getAttribute('aria-hidden') === 'true'));
  assert.ok(!denied.fx.find('calendar', 'd-ichoice').some(one => /맥 설정 열기/.test(one.textContent)), '맥 설정 열기 버튼은 아직 없다(실기 확인 뒤)');
  assert.equal(denied.fx.find('calendar', 'd-ich').length, 0);

  const noAccount = await run({ ok: true, installed: true, state: macState({ ok: false, reason: 'noAccount', calendars: [{ id: 'L', name: '캘린더', writable: true }], suggested: [], read: [] }) });
  assert.equal(noAccount.error, '맥 캘린더에 구글 계정이 없어요 — 1단계를 먼저 해 주세요');
  assert.equal(noAccount.help.hidden, true);
  same(noAccount.fx.find('calendar', 'd-ich').map(row => row.children[0].checked), [false], '목록은 보여 주되 아무것도 켜지 않는다');

  const old = await run(null, [{ body: { ok: false, reason: 'not-installed', error: '업데이트.command를 한 번 실행하면 쓸 수 있어요' } }]);
  assert.equal(old.error, '업데이트.command를 한 번 실행하면 쓸 수 있어요');
  assert.equal(old.fx.sent.filter(one => one.url === '/api/integrations/calendar/mac').length, 1, '요청을 못 했으면 기다리지 않는다(처음 열 때 한 번만)');

  // 결과가 끝내 안 오면(launchd가 안 돎) — 시계를 90초 넘게 돌린다
  const fx = intgClient({}, [{ body: { ok: true, requestedAt: '2026-09-29T01:00:00.000Z' } }]);
  await fx.app.run('renderSettingsIntegrations()');
  fx.toggle('calendar').listeners.click();
  await tick();
  let clock = Date.now();
  fx.app.context.Date = class extends Date { static now() { clock += 5000; return clock; } };
  fx.app.context.setTimeout = (fn) => { fn(); return 0; };
  await fx.button('calendar', '허용하고 확인').listeners.click();
  const box = fx.find('calendar', 'd-ichoice').find(one => one.dataset.choice === 'mac');
  assert.equal(box.children.find(one => one.className === 'd-derr').textContent, '확인 결과가 오지 않았어요 — 잠시 뒤 다시 눌러 주세요');
});

test('WP-V F. 연결된 맥 캘린더: `맥 캘린더에서 읽는 중 · 10분 전` + 매일 8–20시 30분마다, 멈추면 ⚠️ 줄이 이유, ⋯ 캘린더 다시 고르기는 맥 갈래만', async () => {
  const fx = intgClient({
    calendar: { enabled: true, source: 'mac', macCalendars: [{ id: 'CAL-ME', name: 'me@example.test' }], fetch: { failing: false, lastRunAt: ago(10) }, log: [{ time: '2026-09-29 10:00:00', kind: 'run', text: '캘린더 1개 · 오늘 일정 3개를 읽었어요' }] },
    macView: { ok: true, installed: true, requestedAt: null, chosen: ['CAL-ME'], state: macState({ kind: 'run', calendars: [...MAC_CALS, { id: 'CAL-NEW', name: 'new@example.test', writable: true }] }) },
  }, [{ body: { ok: true, restart: false, calendar: { source: 'mac', calendars: 2 } } }]);
  await fx.app.run('renderSettingsIntegrations()');
  assert.match(fx.text('calendar'), /맥 캘린더에서 읽는 중 · 10분 전/);
  assert.match(fx.text('calendar'), /매일 8–20시, 30분마다$/);
  const menu = fx.menu('calendar');
  same(menu.map(section => section.map(entry => entry.label)), [['새로 받기', '최근 기록', '캘린더 다시 고르기'], ['해제…']]);
  menu[0][2].onClick();
  await tick();
  same(fx.find('calendar', 'd-ichoice').map(one => one.dataset.choice), ['mac'], '다시 고르기는 맥 캘린더 갈래 하나');
  assert.match(fx.text('calendar'), /읽을 캘린더를 다시 골라요/);
  const rows = fx.find('calendar', 'd-ich');
  same(rows.map(row => row.children[0].checked), [false, true, false], '전에 확인한 목록에 지금 고른 것이 켜져 있다');
  rows[2].children[0].checked = true;
  rows[2].children[0].listeners.change();
  await fx.button('calendar', '고른 캘린더로 바꾸기').listeners.click();
  same(fx.sent.find(one => one.url === '/api/integrations/save').body.calendar.macCalendars, [{ id: 'CAL-ME', name: 'me@example.test' }, { id: 'CAL-NEW', name: 'new@example.test' }]);
  assert.match(fx.live(), /읽을 캘린더를 2개로 바꿨어요 · 바로 보려면 ⋯ › 새로 받기를 눌러 주세요/);

  const stopped = intgClient({ calendar: { enabled: true, source: 'mac', macCalendars: [{ id: 'CAL-ME', name: 'me@example.test' }], fetch: { failing: true, lastRunAt: ago(5), summary: '⚠️ 고른 캘린더를 찾지 못했어요 — 다시 골라 주세요' } } });
  await stopped.app.run('renderSettingsIntegrations()');
  assert.match(stopped.text('calendar'), /고른 캘린더를 찾지 못했어요 — 다시 골라 주세요/);
  assert.doesNotMatch(stopped.text('calendar'), /⚠️|최근 기록에서/, '이유 한 줄만');
  assert.equal(stopped.find('calendar', 'd-imacpic').length, 0, '허용 막힘이 아니면 예시 그림이 없다');
});

test('WP-V G. 연결된 맥 캘린더 카드가 허용 막힘으로 멈추면 이유 줄은 새 안내 + 예시 그림 — 모르는 문구는 원문 그대로', async () => {
  const old = '⚠️ 맥이 캘린더 접근을 막았어요 — 시스템 설정 › 개인정보 보호 및 보안 › 캘린더(전체 접근)와 자동화에서 허용해 주세요';
  const card = async (summary) => {
    const fx = intgClient({ calendar: { enabled: true, source: 'mac', macCalendars: [{ id: 'CAL-ME', name: 'me@example.test' }], fetch: { failing: true, stuck: true, lastRunAt: ago(5), summary } } });
    await fx.app.run('renderSettingsIntegrations()');
    return fx;
  };
  const whyOf = fx => fx.shape("window.findByClass(document.getElementById('settingsIntegrationsView').children.find(one => one.dataset && one.dataset.integration === 'calendar'), 'd-intgwhy')[0]").text;
  const denied = await card(old);
  const why = denied.find('calendar', 'd-intgwhy');
  assert.equal(why.length, 1);
  assert.equal(whyOf(denied), '맥이 캘린더 접근을 막았어요 — 맥 설정 › 개인정보 보호 및 보안 › 캘린더(그리고 자동화)에서 목록의 이름을 찾아 켜 주세요. 켠 뒤 다시 시도를 눌러 주세요.', '옛 문구는 새 안내로 + 다시 시도');
  assert.doesNotMatch(denied.text('calendar'), /전체 접근\)와 자동화에서 허용/, '옛 문구는 보이지 않는다');
  const pic = denied.find('calendar', 'd-imacpic');
  assert.equal(pic.length, 1, '이유 줄 아래 예시 그림 하나');
  assert.equal(pic[0].children[0].textContent, '예시 그림 — 맥 화면이 아니에요. 이름은 맥에 따라 달라요');
  assert.doesNotMatch(denied.text('calendar'), /허용하고 확인을 다시 눌러/, '카드에는 없는 버튼을 말하지 않는다');
  // 카드 다른 줄(이름·효용·지금 상황·점)은 그대로
  const unknown = await card('⚠️ 처음 보는 오류예요 — 무언가 달라요');
  assert.equal(whyOf(unknown), '처음 보는 오류예요 — 무언가 달라요', '모르는 문구는 원문 그대로');
  assert.equal(unknown.find('calendar', 'd-imacpic').length, 0);
  const strip = fx => fx.text('calendar').replace(whyOf(fx), '').replace(/예시 그림[\s\S]*$/, '');
  assert.equal(strip(denied), strip(unknown), '이유 줄·그림 말고는 같다');
  assert.equal(strip(denied), '캘린더Claude 없이도 돼요멈췄어요연결하기다시 시도오늘 회의가 뜨고 회의 정리가 열려요읽지 못했어요매일 8–20시, 30분마다');
});

test('WP-V F. 허용 창에 답하지 않음(0)은 다시 누르라는 말만 — 막힘 안내(시스템 설정 가는 길)는 거부일 때만', async () => {
  const fx = intgClient({}, [{ body: { ok: true, requestedAt: '2026-09-29T01:00:00.000Z' } }]);
  await fx.app.run('renderSettingsIntegrations()');
  fx.toggle('calendar').listeners.click();
  await tick();
  fx.app.context.setTimeout = (fn) => { fn(); return 0; };
  fx.mac.view = { ok: true, installed: true, state: macState({ ok: false, reason: 'unanswered', calendars: [], eventCount: null }) };
  await fx.button('calendar', '허용하고 확인').listeners.click();
  const box = fx.find('calendar', 'd-ichoice').find(one => one.dataset.choice === 'mac');
  assert.equal(box.children.find(one => one.className === 'd-derr').textContent, '허용 창에 답하지 않았어요 — 허용하고 확인을 다시 눌러 주세요');
  assert.equal(box.children.find(one => one.className === 'd-imachelp').hidden, true, '가는 길·예시 그림은 보이지 않는다');
});

// ─────────────────────────────────────────────────────────────────────────────
// 첫 사용·빈 화면 정리 — 0은 적지 않는다 · 빈 화면엔 할 수 있는 것만 · 사용설명서는 네 칸 판(도움말은 그대로)
function firstRunClient() {
  const fx = guideClient();
  // 줄·그룹 부품은 이 묶음의 관심 밖이다 — 개수·버튼·빈 문장만 본다.
  fx.app.run(`uiTaskRow = () => document.createElement('div');
    uiGroupHeading = () => document.createElement('div');
    uiGroupAddRow = () => document.createElement('div');
    recordIdeaRow = () => document.createElement('div');
    recordDecisionRow = () => document.createElement('div');
    renderTodayProgress = () => {};
    wfMeetingProjectName = () => '';
    setInterval = () => 0; clearInterval = () => {};
    document.body = document.createElement('div');
    workflowData = { items: [], meetings: [] };`);
  const node = id => fx.app.run(`document.getElementById('${id}')`);
  // 가짜 노드는 붙인 고정 마크업(insertAdjacentHTML)을 \`html\`에 쌓기만 한다 — 다시 그리기 전에 비운다.
  fx.app.run(`window.freshHtml = (...ids) => ids.forEach(id => { document.getElementById(id).html = ''; });`);
  return { ...fx, node };
}

test('첫사용 1·2: 개수 칩은 1 이상일 때만 선다 — 0이면 숨고, 다시 그릴 때 1이 되면 나타난다(1 → 0은 사라짐)', () => {
  const fx = firstRunClient();
  const draw = (n) => {
    const list = JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: `t${i}`, description: `일 ${i}`, status: 'open' })));
    const events = JSON.stringify(Array.from({ length: n }, (_, i) => ({ start: '10:00', title: `회의 ${i}` })));
    fx.app.run(`renderTodayTasks(${list}); renderWaiting(${list}); renderIdeas(${list}); renderDecisions(${list});
      renderCalendar({ events: ${events} });`);
  };
  const ids = ['todayTaskCount', 'waitingSectionCount', 'ideaCount', 'decisionSectionCount', 'calendarSectionCount'];
  draw(0);
  ids.forEach(id => assert.equal(fx.node(id).hidden, true, `${id}: 0이면 숨김`));
  draw(1);
  ids.forEach((id) => {
    assert.equal(fx.node(id).hidden, false, `${id}: 1이면 나타남`);
    assert.equal(String(fx.node(id).textContent), '1');
  });
  draw(3);
  ids.forEach(id => assert.equal(String(fx.node(id).textContent), '3', `${id}: 데이터가 있으면 지금 그대로`));
  draw(0);
  ids.forEach(id => assert.equal(fx.node(id).hidden, true, `${id}: 1 → 0이면 다시 숨김`));
  // 오늘 할 일은 남은 개수다 — 모두 끝내 남은 것이 0이면 칩도 숨는다(`N개 중 N개 끝냈어요`가 말한다)
  fx.app.run(`renderTodayTasks([{ id: 'a', description: '끝', status: 'done' }])`);
  assert.equal(fx.node('todayTaskCount').hidden, true);
  assert.equal(fx.node('todayDoneSummary').textContent, '1개 중 1개 끝냈어요');
});

test('첫사용 2·3: `나중에 할 일 N` 버튼은 0이면 숨고 1이면 선다 — 서랍이 열린 채 0이 되면 서랍은 열어 두고 초점은 서랍 닫기로', () => {
  const fx = firstRunClient();
  const toggle = fx.node('laterTaskToggle');
  fx.app.run('renderLaterTasks([])');
  assert.equal(toggle.hidden, true, '0이면 버튼 없음');
  fx.app.run(`renderLaterTasks([{ id: 'l1', description: '나중 일', status: 'open' }])`);
  assert.equal(toggle.hidden, false, '1이면 나타남');
  assert.equal(String(fx.node('laterTaskSectionCount').textContent), '1');

  // 서랍을 연 채, 초점이 버튼에 있는 동안 마지막 하나가 오늘로 옮겨져 0이 된다
  fx.app.run(`laterDrawerOpen = true; document.activeElement = document.getElementById('laterTaskToggle');`);
  fx.app.run('renderLaterTasks([])');
  assert.equal(toggle.hidden, true);
  assert.equal(fx.app.run('laterDrawerOpen'), true, '서랍은 열린 채(닫기 버튼이 있다)');
  assert.equal(fx.node('laterTaskClose').focused, true, '초점은 사라진 버튼에 남지 않고 서랍 닫기로');
  assert.equal(fx.node('laterTaskList').innerHTML, '<div class="d-empty">나중에 할 일이 없어요.</div>', '서랍의 빈 문장은 그대로');

  // 그 뒤 서랍을 닫으면 숨은 버튼 대신 오늘 할 일 입력칸으로
  fx.app.run(`document.activeElement = null; escDrop = () => {}; drawerClose()`);
  assert.equal(fx.app.run('laterDrawerOpen'), false);
  assert.equal(fx.node('todayTaskInput').focused, true);
  assert.notEqual(toggle.focused, true);

  // 버튼이 보이면 닫을 때 지금처럼 버튼으로 / 초점이 딴 데 있으면 건드리지 않는다
  const other = firstRunClient();
  other.app.run(`renderLaterTasks([{ id: 'l1', description: '나중 일', status: 'open' }]); laterDrawerOpen = true; escDrop = () => {}; drawerClose()`);
  assert.equal(other.node('laterTaskToggle').focused, true);
  other.app.run(`document.activeElement = document.getElementById('todayTaskInput'); laterDrawerOpen = true; renderLaterTasks([])`);
  assert.notEqual(other.node('laterTaskClose').focused, true);
});

test('첫사용 5: 결정이 하나도 없으면(미반영 0 · 반영 완료 0) `결정 찾기`와 `반영 완료` 접힘을 숨기고, 반영 완료만 있어도 둘 다 선다', () => {
  const fx = firstRunClient();
  const draw = (pending, archived) => fx.app.run(`decisionArchiveCache = ${JSON.stringify(archived)};
    renderDecisions(${JSON.stringify(pending)}); renderDecisionArchive();`);
  draw([], []);
  assert.equal(fx.node('decisionSearch').hidden, true);
  assert.equal(fx.node('decisionArchiveZone').hidden, true);
  draw([], [{ id: 'a1', description: '반영한 결정' }]);
  assert.equal(fx.node('decisionSearch').hidden, false, '반영 완료가 있으면 찾기 그대로');
  assert.equal(fx.node('decisionArchiveZone').hidden, false, '접힘도 그대로');
  assert.equal(fx.node('decisionSectionCount').hidden, true, '미반영 0은 적지 않는다');
  draw([{ id: 'd1', description: '결정' }], []);
  assert.equal(fx.node('decisionSearch').hidden, false);
  assert.equal(fx.node('decisionArchiveZone').hidden, false);

  // 찾는 중에 마지막 결정이 사라지면 — 찾기 글자를 비우고 숨긴다(다음 결정이 생겼을 때 안 보이는 거름망이 되지 않게),
  // 초점이 찾기 칸에 있었으면 `결정 추가` 칸으로
  fx.app.run(`document.getElementById('decisionSearch').value = '결정'; decisionQuery = '결정';
    document.activeElement = document.getElementById('decisionSearch'); window.freshHtml('decisionList');`);
  draw([], []);
  assert.equal(fx.node('decisionSearch').value, '');
  assert.equal(fx.app.run('decisionQuery'), '');
  assert.equal(fx.node('decisionSearch').hidden, true);
  assert.equal(fx.node('decisionInput').focused, true);
  assert.equal(fx.node('decisionList').html, '<div class="d-empty is-short">정해진 내용이 아직 없어요. 적어 두면 PRD 반영까지 여기서 챙겨요.</div>');
});

test('첫사용 6: 입력 칸 바로 아래 빈 문장 세 자리만 짧고 조용해지고(is-short), 찾기 결과·다 끝냄·서랍의 빈 문장은 그대로', () => {
  const fx = firstRunClient();
  fx.app.run('renderTodayTasks([]); renderIdeas([]); renderDecisions([])');
  assert.equal(fx.node('todayTaskList').html, '<div class="d-empty is-short">오늘 할 일이 비었어요.</div>');
  assert.equal(fx.node('ideaList').html, '<div class="d-empty is-short">아이디어가 아직 없어요. 떠오를 때 적어 두는 자리예요.</div>');
  assert.equal(fx.node('decisionList').html, '<div class="d-empty is-short">정해진 내용이 아직 없어요. 적어 두면 PRD 반영까지 여기서 챙겨요.</div>');

  const done = firstRunClient();
  done.app.run(`renderTodayTasks([{ id: 'a', description: '끝', status: 'done' }])`);
  assert.equal(done.node('todayTaskList').html, '<div class="d-empty">오늘 할 일을 모두 끝냈어요.</div>');

  const found = firstRunClient();
  found.app.run(`decisionArchiveCache = [{ id: 'a1', description: '반영한 결정' }]; decisionQuery = '없는말';
    renderDecisions([{ id: 'd1', description: '결정' }]); renderDecisionArchive();`);
  assert.equal(found.node('decisionList').html, '<div class="d-empty">찾는 결정이 없어요.</div>');
  assert.equal(found.node('decisionArchiveList').html, '<div class="d-empty">찾는 결정이 없어요.</div>');

  const css = fs.readFileSync(path.join(__dirname, 'ui.css'), 'utf8');
  assert.match(css, /\.d-empty\.is-short \{ padding: 4px var\(--pad\) 14px; font-size: var\(--fs-body\); color: var\(--dim\); \}/);
  assert.match(css, /\.d-empty \{ font-size: var\(--fs-md\); font-weight: 500; color: var\(--muted\); padding: 34px var\(--pad\); \}/, '다른 자리의 빈 문장 모양은 그대로');
});

test('첫사용 4: 도움말의 사용설명서(renderSettingsManual)는 모양·문구가 그대로다 — 네 칸 판·꺾쇠·줄인 설치 문구는 오늘 탭 카드에만', () => {
  const fx = firstRunClient();
  fx.store.set('guideCardClosed', '1');
  fx.app.run('renderSettingsManual()');
  const box = fx.node('settingsManualView').children[0];
  assert.equal(box.className, 'd-manual');
  const rows = box.children.slice(1, 5);
  same(rows.map(row => row.className), ['d-guide', 'd-guide', 'd-guide', 'd-guide'], '판 없이 줄 넷이 바로 선다');
  same(rows.map(row => row.children[0].textContent), ['앱으로 설치', '할 일 적기', '연동은 나중에', '슬랙에서 보내는 법']);
  const text = index => fx.shape(`document.getElementById('settingsManualView').children[0].children[${index + 1}]`).text;
  assert.equal(text(0), '앱으로 설치크롬 ⋮ → 전송, 저장, 공유 → 페이지를 앱으로 설치이미 설치했으면 주소창 오른쪽 앱 열기');
  assert.equal(text(2), '연동은 나중에설정 ⚙ → 연동에서 하나씩');
  assert.ok(rows[0].children[1].children.some(kid => kid.className === 'd-guidedock'), 'Dock 그림은 도움말에 남는다');
  rows.forEach(row => assert.ok(!row.children.some(kid => kid.className === 'go' || kid.className === 'me'), '꺾쇠·앞 아이콘 없음'));
  // 설치 창을 줄 수 있으면 도움말은 지금처럼 버튼 + 설명 문장
  fx.app.run('appInstallOnPrompt({ preventDefault() {} })');
  assert.equal(text(0), '앱으로 설치설치하기 Dock·⌘Tab에 워크스페이스 아이콘이 따로 떠요');

  // 누르는 줄 셋은 카드에서도 여전히 button이고 같은 곳으로 데려간다
  const card = firstRunClient();
  card.app.run('renderGuideCard()');
  const cardRows = card.node('startCardZone').children[0].children[1].children;
  same(cardRows.slice(1).map(row => row.type), ['button', 'button', 'button']);
  cardRows[1].listeners.click();
  cardRows[2].listeners.click();
  cardRows[3].listeners.click();
  assert.equal(card.node('todayTaskInput').focused, true);
  same(card.went(), [['close'], ['integrations', null], ['guide', null], ['show', '슬랙에서 이렇게 보내요']]);

  const css = fs.readFileSync(path.join(__dirname, 'ui.css'), 'utf8');
  assert.match(css, /\.d-guidegrid \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/, '넓게 2×2');
  assert.match(css, /@media \(max-width: 520px\) \{\n  \.d-guidegrid \{ grid-template-columns: minmax\(0, 1fr\); \}/, '≤520 한 줄씩');
  assert.ok(!/\.d-usagenote/.test(css), 'ui.css는 사용 횟수 줄(.d-usagenote)을 덮지 않는다');
});

// ---------- BBUNDLE: 프로젝트 묶어 보기(덩어리 1 — 프로젝트 탭만) ----------
// 지라 티켓 둘을 화면에서만 한 줄로 본다. 항목의 jira 칸은 그대로라 오늘 탭 등은 묶음을 모른다.
function bundleClient() {
  const app = workflowsClient();
  app.run(`jiraIssuesByKey = new Map([
      ['IO-1', { key: 'IO-1', summary: '결제 리뉴얼', status: '개발 중', category: 'doing' }],
      ['IO-2', { key: 'IO-2', summary: '정기결제 재시도', status: '기획', category: 'todo' }],
      ['AL-9', { key: 'AL-9', summary: '알림센터', status: '대기', category: 'todo' }],
    ]);
    jiraIssuesCache = [...jiraIssuesByKey.values()]; customGroupsCache = []; projectAliasesCache = {};
    workflowData = { meetings: [], items: [
      { id: 'a1', type: 'task', status: 'to-do', jira: 'IO-1', description: '결제 수단 변경 케이스 정리', created: todayStr() },
      { id: 'a2', type: 'task', status: 'to-do', jira: 'IO-1', description: '영수증 메일 시점 확인', created: todayStr() },
      { id: 'b1', type: 'task', status: 'to-do', jira: 'IO-2', description: '재시도 3회 실패 문구', created: todayStr() },
      { id: 'b2', type: 'check', status: 'to-do', jira: 'IO-2', description: 'PG사 간격 제한 확인', created: todayStr(), who: '결제팀' },
      { id: 'c1', type: 'task', status: 'to-do', jira: 'AL-9', description: '알림 문구', created: todayStr() },
    ], projectBundles: [{ id: 'bd_1', lead: 'jira:IO-1', keys: ['jira:IO-1', 'jira:IO-2'], at: null }] };
    wfIndexData(); itemsById = new Map();
    projectKey = null; projectOrderKeys = null; projectOrderResort = true; projectPastOpen = null; projectBundleAsk = null; projectBundleAddTo = null;`);
  return app;
}
const bundleListRows = app => app.nodes.get('projectList').children.filter(child => String(child.className || '').startsWith('d-prow'));
const BUNDLE_ROW = "{ key: 'jira:IO-1', label: 'IO-1 · 결제 리뉴얼', open: 4, bundle: projectBundles()[0] }";
const bundleDetail = (app, row = BUNDLE_ROW) => app.run(`(() => { const body = document.createElement('div'); renderProjectDetail(body, ${row}); return body; })()`);

test('BBUNDLE 목록: 묶인 두 티켓은 대표 이름으로 한 줄, 열린 항목은 더하고 `티켓 2개`가 붙는다 — 풀면 두 줄', () => {
  const app = bundleClient();
  app.run('renderProjects();');
  const rows = bundleListRows(app);
  assert.deepEqual(rows.map(row => nodeFind(row, 'nm').textContent), ['결제 리뉴얼', '알림센터'], '묶음이 한 줄이고 많은 순');
  assert.equal(nodeFind(rows[0], 'n').textContent, 4, '열린 항목(업무 3 + 확인 대기 1)을 더한다');
  assert.equal(nodeFind(rows[0], 'bd').textContent, '티켓 2개');
  assert.equal(rows[0].children[0].dataset.pj, String(app.run("uiProjectHue('jira:IO-1')")), '색은 대표 티켓 것');
  // 묶음의 나머지 티켓 키로 들어와도(오늘 탭 그룹 제목 등) 대표 줄이 열린다.
  app.run("projectKey = 'jira:IO-2'; renderProjects();");
  assert.equal(app.run('projectKey'), 'jira:IO-1');
  // 별칭이 있는 대표면 별칭이 묶음 이름이다.
  app.run("projectAliasesCache = { 'IO-1': '결제 개편' }; renderProjects();");
  assert.equal(nodeFind(bundleListRows(app)[0], 'nm').textContent, '결제 개편');
  // 풀면(칸이 비면) 원래 두 줄.
  app.run("projectAliasesCache = {}; workflowData.projectBundles = []; projectOrderResort = true; renderProjects();");
  assert.deepEqual(bundleListRows(app).map(row => nodeFind(row, 'nm').textContent).sort(), ['결제 리뉴얼', '알림센터', '정기결제 재시도'].sort());
  // 두 티켓 다 목록에서 사라지면 묶음 줄도 없다.
  app.run(`workflowData.projectBundles = [{ id: 'bd_x', lead: 'jira:ZZ-1', keys: ['jira:ZZ-1', 'jira:ZZ-2'] }]; projectOrderResort = true; renderProjects();`);
  assert.equal(bundleListRows(app).some(row => nodeFind(row, 'nm').textContent === 'ZZ-1'), false);
});

test('BBUNDLE 상태·지난 프로젝트·배포·찾기: 하나라도 진행 중이면 진행 중, 모두 조용해야 지난 것, 배포는 가장 이른 것', () => {
  const app = bundleClient();
  const status = (open, cats) => app.run(`(() => {
    jiraIssuesByKey.get('IO-1').category = ${JSON.stringify(cats[0])}; jiraIssuesByKey.get('IO-2').category = ${JSON.stringify(cats[1])};
    return projectStatusOf({ key: 'jira:IO-1', open: ${open}, bundle: projectBundles()[0] }, false);
  })()`);
  assert.equal(status(0, ['todo', 'doing']), 'doing', '하나라도 진행 중이면 진행 중');
  assert.equal(status(0, ['todo', 'todo']), 'todo', '모두 시작 전일 때만 시작 전');
  assert.equal(status(2, ['todo', 'todo']), 'doing', '열린 항목이 있으면 진행 중');
  assert.equal(status(0, [null, 'todo']), 'todo', '상태를 모르는 티켓(목록에서 빠짐)은 판정에서 뺀다');
  const lastDay = app.run(`projectRowLastDay({ key: 'jira:IO-1', bundle: projectBundles()[0] }, [
      { id: 'o1', type: 'task', status: 'done', jira: 'IO-1', completed: '2026-01-02' },
      { id: 'o2', type: 'task', status: 'done', jira: 'IO-2', completed: '2026-03-04' },
    ], [])`);
  assert.equal(lastDay, '2026-03-04', '묶인 티켓 가운데 가장 최근 — 모두 조용해야 지난 프로젝트');
  app.run(`jiraIssuesByKey.get('IO-1').versions = [{ name: 'v2', releaseDate: '2026-12-20', released: false }];
    jiraIssuesByKey.get('IO-2').versions = [{ name: 'v1', releaseDate: '2026-12-01', released: false }];`);
  assert.equal(app.run("projectRowDeployVersion({ key: 'jira:IO-1', bundle: projectBundles()[0] }).name"), 'v1');
  assert.equal(app.run("projectFindFilter([{ key: 'jira:IO-1', label: 'x', open: 0, bundle: projectBundles()[0] }], '정기결제').length"), 1, '나머지 티켓 이름으로도 찾힌다');
});

test('BBUNDLE 상세: 두 티켓의 업무를 모아 줄마다 작은 KEY, 옆 티켓 카드는 따로 읽고, 할 일 추가는 대표 티켓(→ KEY로 바꿈)', async () => {
  const app = bundleClient();
  const sent = [];
  app.context.fetch = async (url) => {
    sent.push(String(url));
    return new Response(JSON.stringify({ ok: true, connected: true, issue: { key: 'IO-2', url: 'https://example-jira.test/browse/IO-2', summary: '정기결제 재시도', status: { name: '완료', category: 'done' } } }));
  };
  app.run("lastMenu = null; uiMenu = (anchor, sections) => { lastMenu = sections; return null; };");
  const body = bundleDetail(app);
  assert.equal(body.children[0].textContent, '결제 리뉴얼', '제목은 대표 이름');
  assert.equal(body.children[1].textContent, '열린 항목 4 · 티켓 2개 묶음');
  assert.deepEqual(nodeFindAll(body, 'd-pfrom').map(tag => tag.textContent).sort(), ['IO-1', 'IO-1', 'IO-2'], '진행할 업무 줄마다 어느 티켓인지');
  assert.match(nodeText(body), /결제팀 · IO-2/, '확인 대기 줄에도 티켓 번호');
  const seat = body.children.find(kid => kid.id === 'jiraStrip-IO-2');
  assert.ok(seat, '대표 카드 뒤에 나머지 티켓의 카드 자리');
  assert.equal(seat.dataset.project, 'jira:IO-2', '하위 티켓 펼침은 제 티켓 키로 기억');
  assert.equal(app.run('jiraSide.keys.join()'), 'IO-2');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(sent.some(url => url.startsWith('/api/jira/issue?key=IO-2')), '옆 카드는 제 티켓을 단건으로 읽는다');
  assert.equal(app.run("jiraSide.cards['IO-2'].state"), 'ok');
  const card = app.run("jiraStripBody('IO-2', 'jira:IO-2', { lead: false })");
  assert.match(nodeFind(card, 'sub').textContent, /^IO-2 · 끝남/, '지라에서 끝난 티켓 카드에는 끝남');
  const add = nodeFind(body, 'd-padd');
  assert.equal(add.dataset.addKey, '/api/today-task/create::jira:IO-1::project', '할 일 추가는 대표 티켓');
  const target = nodeFind(add, 'd-paddto');
  assert.equal(target.textContent, '→ IO-1');
  target.listeners.click({ stopPropagation() {} });
  const choices = app.run('lastMenu')[0].filter(entry => entry.label);
  assert.deepEqual([...choices.map(entry => entry.label)], ['결제 리뉴얼 · IO-1 · 대표 · 지금', '정기결제 재시도 · IO-2']);
  choices[1].onClick();
  assert.equal(nodeFind(bundleDetail(app), 'd-padd').dataset.addKey, '/api/today-task/create::jira:IO-2::project', '고른 티켓에 붙는다');
  bundleDetail(app, "{ key: 'jira:AL-9', label: 'x', open: 1 }");
  assert.equal(app.run('jiraSide.keys.length'), 0, '묶음이 아닌 프로젝트를 열면 옆 카드 기억을 비운다');
  // 묶음 상세 ⋯에는 대표 바꾸기·묶음 풀기가 있다.
  const menu = app.run(`(() => { const body = document.createElement('div'); renderProjectDetail(body, ${BUNDLE_ROW}); return body.children[0].children.find(kid => String(kid.className || '').includes('d-more')); })()`);
  menu.listeners.click({ stopPropagation() {} });
  const labels = app.run('lastMenu').flat().map(entry => entry.label);
  assert.ok(labels.includes('다른 티켓과 묶기…') && labels.includes('「정기결제 재시도」 대표로') && labels.includes('묶음 풀기'));
});

test('BBUNDLE 옆 카드: 새로고침·지라 바꾸기 확인 줄은 그 티켓 자리로만 가고, 대표 카드(jiraCard)는 그대로', async () => {
  const app = bundleClient();
  const sent = [];
  app.context.fetch = async (url) => {
    sent.push(String(url));
    const key = String(url).match(/key=([A-Z0-9-]+)/)[1];
    return new Response(JSON.stringify({ ok: true, connected: true, issue: { key, url: `https://example-jira.test/browse/${key}`, summary: key, status: { name: '진행 중', category: 'doing' } } }));
  };
  app.run(`jiraCard = { key: 'IO-1', state: 'ok', issue: { key: 'IO-1', summary: '결제 리뉴얼', status: { name: '개발 중', category: 'doing' } }, error: '', at: Date.now(), seq: 3 };
    jiraSide = { project: 'jira:IO-1', keys: ['IO-2'], cards: {} };`);
  await app.run("jiraCardLoad('IO-2', { fresh: true })");
  assert.ok(sent.some(url => url.includes('key=IO-2&fresh=1')));
  assert.equal(app.run('jiraCard.key'), 'IO-1', '대표 카드는 바뀌지 않는다');
  assert.equal(app.run('jiraCard.seq'), 3);
  assert.equal(app.run("jiraSide.cards['IO-2'].issue.summary"), 'IO-2');
  assert.equal(app.run("jiraCardFor('IO-2').key"), 'IO-2');
  assert.equal(app.run("jiraCardFor('IO-1').key"), 'IO-1');
  app.run("jiraConfirm = { key: 'IO-2', label: '지라 상태', pickLabel: '지라 상태', before: '진행 중', after: '완료', body: { key: 'IO-2', kind: 'status', transitionId: '9' }, onEsc: () => {} };");
  assert.ok(nodeFind(app.run("jiraStripBody('IO-2', 'jira:IO-2', { lead: false })"), 'd-jconfirm'), '옆 카드에 확인 줄');
  assert.equal(nodeFind(app.run("jiraStripBody('IO-1', 'jira:IO-1', { lead: true })"), 'd-jconfirm'), null, '대표 카드에는 없다');
  app.run('jiraSideEnsure(null, [])');
  assert.equal(app.run('jiraConfirm'), null, '다른 프로젝트로 옮기면 그 옆 카드의 확인 줄도 닫힌다');
});

test('BBUNDLE 묶기: ⋯ `다른 티켓과 묶기…` → 이미 다른 묶음인 것은 이유와 함께 비활성 → 확인 줄 → 묶기, ⌘Z는 bundle-restore로', async () => {
  const app = bundleClient();
  app.run(`jiraIssuesByKey.set('PAY-3', { key: 'PAY-3', summary: '정산', status: '대기', category: 'todo' });
    jiraIssuesByKey.set('IO-9', { key: 'IO-9', summary: '알림 서버', status: '대기', category: 'todo' });
    jiraIssuesCache = [...jiraIssuesByKey.values()];
    workflowData.projectBundles = [{ id: 'bd_1', lead: 'jira:IO-1', keys: ['jira:IO-1', 'jira:IO-2'] }, { id: 'bd_2', lead: 'jira:PAY-3', keys: ['jira:PAY-3', 'jira:PAY-4'] }];`);
  const sent = [];
  const after = { id: 'bd_9', lead: 'jira:AL-9', keys: ['jira:AL-9', 'jira:IO-9'], at: null };
  app.context.fetch = async (url, init) => {
    sent.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null });
    if (String(url) === '/api/project/bundle') return new Response(JSON.stringify({ ok: true, before: null, after }));
    return new Response(JSON.stringify({ ok: true }));
  };
  const row = "{ key: 'jira:AL-9', label: 'AL-9 · 알림센터', open: 1 }";
  app.run("projectKey = 'jira:AL-9';");
  const choices = app.run(`projectBundleChoices(${row})`)[0].filter(entry => entry.label);
  const byLabel = Object.fromEntries(choices.map(entry => [entry.label, !!entry.disabled]));
  assert.equal(byLabel['알림 서버 · IO-9'], false);
  assert.equal(byLabel['결제 리뉴얼 · IO-1 — 이미 「결제 리뉴얼」 묶음에 있어요'], true, '이미 다른 묶음은 이유와 함께 비활성');
  assert.equal(choices.some(entry => entry.label.startsWith('알림센터 ·')), false, '자기 자신은 없다');
  choices.find(entry => entry.label === '알림 서버 · IO-9').onClick();
  const body = bundleDetail(app, row);
  const ask = nodeFind(body, 'd-pbask');
  assert.match(nodeText(ask), /「알림 서버」도 이 프로젝트와 함께 볼까요\?/);
  assert.match(nodeText(ask), /지라 티켓은 그대로예요/);
  assert.equal(sent.filter(call => call.url.startsWith('/api/project/')).length, 0, '확인 줄을 거치기 전에는 아무것도 보내지 않는다');
  await ask.children.find(kid => kid.className === 'acts').children[1].listeners.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(sent.find(call => call.url === '/api/project/bundle').body, { project: 'jira:AL-9', add: ['jira:IO-9'] });
  assert.equal(app.run('projectBundleAsk'), null);
  assert.equal(app.run('projectKey'), 'jira:AL-9', '대표 줄을 연 채로');
  assert.equal(app.run('undoStack.length'), 1, '⌘Z 기록이 남는다');
  assert.match(app.nodes.get('liveRegion').textContent, /묶었어요/);
  await app.run('undoStack[undoStack.length - 1].undo()');
  assert.deepEqual(sent.find(call => call.url === '/api/project/bundle-restore').body, { id: 'bd_9', before: null, after }, '되돌리기는 "지금이 after일 때만 before로"');
});

// ─── WP-W 내 일 기록 — usage-ui.js의 순수 계산(usageWorkStats)과 그리기 ───
function usageWorkClient() {
  const app = client(new Response('{"ok":true}'));
  app.run(fs.readFileSync(path.join(__dirname, 'usage-ui.js'), 'utf8'));
  return app;
}
function usageStats(app, history, today, range) {
  return JSON.parse(app.run(`JSON.stringify(usageWorkStats(${JSON.stringify(history)}, ${JSON.stringify(today)}, ${JSON.stringify(range)}))`));
}
const usagePartsText = parts => parts.map(part => (typeof part === 'string' ? part : part.b)).join('');
const usageDay = (day, n) => { const at = new Date(`${day}T00:00:00Z`); at.setUTCDate(at.getUTCDate() + n); return at.toISOString().slice(0, 10); };
// from부터 count일 동안 fill(day, 요일 0=월)이 주는 칸으로 채운다(빈 값이면 그날은 기록 없음).
function usageFill(from, count, fill) {
  const history = {};
  for (let i = 0; i < count; i += 1) {
    const day = usageDay(from, i);
    const counts = fill(day, (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7);
    if (counts) history[day] = counts;
  }
  return history;
}

test('WP-W 기간 경계 — 주는 월요일 시작, 이번 달 1일부터, 90일은 월요일로 끊은 주(첫 주는 덜 참)', () => {
  const app = usageWorkClient();
  const history = { '2026-09-28': { task_done: 1 } };
  const monday = usageStats(app, history, '2026-09-28', 'week');
  assert.equal(monday.from, '2026-09-28');
  assert.equal(monday.periodLabel, '9월 28일(월) – 오늘');
  assert.deepEqual(monday.bars.map(bar => bar.label), ['월', '화', '수', '목', '금', '토', '일']);
  assert.deepEqual(monday.bars.map(bar => bar.future), [false, true, true, true, true, true, true], '오늘 뒤는 빈 칸');
  assert.equal(monday.bars[0].today, true);
  const sunday = usageStats(app, history, '2026-10-04', 'week');
  assert.equal(sunday.from, '2026-09-28', '일요일은 그 주 월요일부터');
  const month = usageStats(app, history, '2026-09-30', 'month');
  assert.equal(month.periodLabel, '9월 1일 – 오늘');
  assert.deepEqual(month.bars.map(bar => [bar.from, bar.to]), [['2026-09-01', '2026-09-06'], ['2026-09-07', '2026-09-13'], ['2026-09-14', '2026-09-20'], ['2026-09-21', '2026-09-27'], ['2026-09-28', '2026-09-30']]);
  const d90 = usageStats(app, history, '2026-09-30', '90');
  assert.equal(d90.periodLabel, '최근 90일');
  assert.equal(d90.from, '2026-07-03');
  assert.equal(d90.bars.length, 14);
  assert.deepEqual([d90.bars[0].from, d90.bars[0].to, d90.bars[0].partial], ['2026-07-03', '2026-07-05', true]);
  assert.equal(d90.compare, null, '90일은 비교 없음');
});

test('WP-W 숫자 정의 — 들어온·끝낸·남긴 기록, 하루 평균(기록 있는 날 기준·소수 한 자리·.0 뗌), 미래·모르는 키·음수는 무시', () => {
  const app = usageWorkClient();
  const history = {
    '2026-09-28': { slack_in: 4, task_add: 1, task_done: 3, slack_done: 1, decision_add: 1, tab_today: 3 },
    '2026-09-29': { task_add: 2, idea_add: 2, jira_create: 1, mystery: 50, task_done: -3 },
    '2026-09-30': { search: 1 },
    '2026-10-01': { task_done: 99 },
    'nope': { task_done: 5 },
  };
  const stats = usageStats(app, history, '2026-09-30', 'week');
  assert.deepEqual(stats.in, { total: 7, slack: 4, direct: 3 });
  assert.deepEqual(stats.done, { total: 3, slack: 1 }, '끝낸 일 = 할 일 끝냄만(슬랙 출처 할 일은 한 번), slack은 그중 슬랙');
  assert.deepEqual(usageStats(app, { '2026-09-29': { task_done: 1, slack_done: 4 } }, '2026-09-30', 'week').done, { total: 1, slack: 1 }, '그중 슬랙은 끝낸 일을 넘지 않는다');
  assert.deepEqual(stats.record, { total: 4, parts: [{ label: '결정', count: 1 }, { label: '아이디어', count: 2 }, { label: '지라', count: 1 }] }, '0인 칸은 빼고');
  assert.equal(stats.recordedDays, 3);
  assert.equal(stats.average, '1', '3 ÷ 3 = 1(.0 뗌)');
  assert.equal(usagePartsText(stats.headline), '이번 주 일 3개를 끝냈어요');
  assert.equal(usageStats(app, { '2026-09-28': { task_done: 3 }, '2026-09-29': { task_done: 0, search: 1 } }, '2026-09-30', 'week').average, '1.5');
  const none = usageStats(app, { '2026-09-29': { tab_today: 2, task_add: 1 } }, '2026-09-30', 'week');
  assert.equal(usagePartsText(none.headline), '이번 주는 아직 끝낸 일이 없어요');
  assert.equal(none.average, null, '끝낸 일이 0이면 하루 평균을 쓰지 않는다');
  assert.equal(usagePartsText(usageStats(app, { '2026-09-29': { task_done: 2 } }, '2026-09-30', 'month').headline), '이번 달 일 2개를 끝냈어요');
  assert.equal(usagePartsText(usageStats(app, { '2026-09-29': { task_done: 2 } }, '2026-09-30', '90').headline), '최근 90일 동안 일 2개를 끝냈어요');
  assert.equal(usageStats(app, history, '2026-09-30', 'bogus').range, 'week');
});

test('WP-W 빈 상태 — 90일 안에 기록이 없으면(설치 직후·옛 날만·미래만) empty', () => {
  const app = usageWorkClient();
  for (const history of [{}, null, { '2026-05-01': { task_done: 3 } }, { '2026-10-02': { task_done: 1 } }, { '2026-09-29': { task_done: 0, mystery: 3 } }]) {
    const stats = usageStats(app, history, '2026-09-30', 'week');
    assert.equal(stats.empty, true, JSON.stringify(history));
    assert.equal(stats.periodLabel, '9월 28일(월) – 오늘');
    assert.equal(stats.bars, undefined);
  }
  assert.equal(usageStats(app, { '2026-09-29': { task_done: 1 } }, 'not-a-day', 'week').empty, true, 'today가 이상하면 계산하지 않는다');
});

test('WP-W 같은 길이 비교 — 이번 주 월~오늘 ↔ 지난주 월~같은 요일, ±10%는 비슷, 비교 기간 0·기록 7일 미만이면 생략', () => {
  const app = usageWorkClient();
  // 9/14~9/25 평일에 기록(10일) — 지난주 월~수(9/21~23) 들어온 일 10개.
  const base = usageFill('2026-09-14', 12, (day, dow) => (dow < 5 ? { task_add: day >= '2026-09-21' && day <= '2026-09-23' ? (day === '2026-09-21' ? 4 : 3) : 1 } : null));
  const run = inToday => usageStats(app, { ...base, '2026-09-28': { task_add: 5 }, '2026-09-29': { task_add: 3 }, '2026-09-30': { task_add: inToday } }, '2026-09-30', 'week');
  const same = run(3);   // 11 vs 10 → +10%
  assert.deepEqual([same.compare.from, same.compare.to], ['2026-09-21', '2026-09-23']);
  assert.equal(same.compare.tone, 'same');
  assert.equal(same.compare.text, '지난주와 비슷했어요');
  const more = run(7);   // 15 vs 10
  assert.equal(more.compare.text, '지난주보다 50% 더 바빴어요');
  const less = usageStats(app, { ...base, '2026-09-28': { task_add: 1 } }, '2026-09-30', 'week');
  assert.equal(less.compare.text, '지난주보다 조금 여유로웠어요');
  // 월요일 아침 — 지난주 월요일 하루와.
  const monday = usageStats(app, { ...base, '2026-09-28': { task_add: 4 } }, '2026-09-28', 'week');
  assert.deepEqual([monday.compare.from, monday.compare.to, monday.compare.tone], ['2026-09-21', '2026-09-21', 'same']);
  // 비교 기간 들어온 일 0 → 생략.
  const quiet = usageStats(app, { ...usageFill('2026-09-10', 10, () => ({ task_done: 1 })), '2026-09-28': { task_add: 5 } }, '2026-09-28', 'week');
  assert.equal(quiet.compare, null);
  // 첫 기록 날이 비교 기간 시작보다 뒤(지난주 수요일부터 기록) → 비교 기간이 덜 차서 생략.
  const late = usageStats(app, { ...usageFill('2026-09-23', 8, () => ({ task_add: 2 })), '2026-09-28': { task_add: 9 } }, '2026-09-30', 'week');
  assert.equal(late.compare, null);
  const lateMonth = usageStats(app, usageFill('2026-08-20', 41, () => ({ task_add: 1 })), '2026-09-30', 'month');
  assert.equal(lateMonth.compare, null, '지난달 중간부터 기록이면 달 비교도 생략');
  // 기록 7일 미만 → 생략.
  const young = usageStats(app, { '2026-09-21': { task_add: 3 }, '2026-09-28': { task_add: 9 } }, '2026-09-28', 'week');
  assert.equal(young.compare, null);
});

test('WP-W 달 비교 — 1일~오늘 ↔ 지난달 1일~같은 날, 지난달이 짧으면 말일까지, 1일은 지난달 1일 하루와', () => {
  const app = usageWorkClient();
  const history = usageFill('2026-02-01', 59, () => ({ task_add: 1 }));
  const endOfMarch = usageStats(app, history, '2026-03-31', 'month');
  assert.deepEqual([endOfMarch.compare.from, endOfMarch.compare.to], ['2026-02-01', '2026-02-28']);
  assert.equal(endOfMarch.compare.text, '지난달보다 11% 더 바빴어요', '31 vs 28');
  const first = usageStats(app, history, '2026-03-01', 'month');
  assert.deepEqual([first.compare.from, first.compare.to], ['2026-02-01', '2026-02-01']);
  assert.equal(first.compare.text, '지난달과 비슷했어요');
  const january = usageStats(app, usageFill('2025-12-01', 45, () => ({ task_add: 1 })), '2026-01-10', 'month');
  assert.deepEqual([january.compare.from, january.compare.to], ['2025-12-01', '2025-12-10'], '해 넘김');
});

test('WP-W 막대 해설 — 몰린 날 뒤에 더 끝내 따라잡았으면 그 문장, 아니면 가장 많이 끝낸 날', () => {
  const app = usageWorkClient();
  const caught = usageStats(app, { '2026-09-28': { slack_in: 11, task_done: 2 }, '2026-09-29': { task_add: 1, task_done: 5 }, '2026-09-30': { task_done: 3 } }, '2026-09-30', 'week');
  assert.equal(caught.barNote, '월요일에 11개가 몰렸고, 화·수에 들어온 것보다 더 끝내서 따라잡았어요');
  const simple = usageStats(app, { '2026-09-28': { task_add: 3, task_done: 1 }, '2026-09-29': { task_add: 2, task_done: 2 }, '2026-09-30': { task_add: 1 } }, '2026-09-30', 'week');
  assert.equal(simple.barNote, '가장 많이 끝낸 날은 화요일(2개)예요');
  const onlyIn = usageStats(app, { '2026-09-29': { task_add: 4 } }, '2026-09-30', 'week');
  assert.equal(onlyIn.barNote, '가장 많이 들어온 날은 화요일(4개)예요');
  // 90일 — 덜 찬 첫 주는 후보가 아니다.
  const d90 = usageStats(app, { '2026-07-03': { task_done: 30 }, '2026-09-29': { task_done: 2 } }, '2026-09-30', '90');
  assert.equal(d90.barNote, '가장 많이 끝낸 주는 9월 28일 주(2개)예요');
});

test('WP-W 알게 된 것 — a 요일 몰림 → b 최고 기록 → d 잘 끝내는 요일(우선순위·최대 3개)', () => {
  const app = usageWorkClient();
  // 8/24(월)~9/29(화) 평일마다 기록 — 월요일에 들어온 일 10개, 다른 평일 2개. 끝낸 일은 금요일 6개, 다른 평일 2개.
  const history = usageFill('2026-08-24', 37, (day, dow) => (dow < 5 ? { task_add: dow === 0 ? 10 : 2, task_done: dow === 4 ? 6 : 2 } : null));
  history['2026-09-30'] = { task_done: 20 };
  const stats = usageStats(app, history, '2026-09-30', 'week');
  assert.deepEqual(stats.insights.map(item => item.kind), ['crowd', 'best', 'finish']);
  assert.equal(usagePartsText(stats.insights[0].parts), '일은 월요일에 몰려요 — 최근 5주 월요일 평균 10개, 다른 날의 5배예요.');
  assert.deepEqual(stats.insights[0].parts[1], { b: '월요일에 몰려요' }, '강조는 조각으로');
  assert.equal(usagePartsText(stats.insights[1].parts), '이번 주가 최근 6주 중 가장 많이 끝낸 주예요.');
  assert.equal(usagePartsText(stats.insights[2].parts), '금요일에 가장 많이 끝내요 — 평균 6개.');
  // 1.5배 미만이면 a 없음.
  const flat = usageFill('2026-08-24', 37, (day, dow) => (dow < 5 ? { task_add: dow === 0 ? 5 : 4, task_done: 1 } : null));
  assert.equal(usageStats(app, flat, '2026-09-30', 'week').insights.some(item => item.kind === 'crowd'), false);
  // 기록 4주 미만이면 a·d 없음.
  const short = usageFill('2026-09-08', 21, (day, dow) => (dow < 5 ? { task_add: dow === 0 ? 10 : 2, task_done: 2 } : null));
  assert.deepEqual(usageStats(app, short, '2026-09-30', 'week').insights.filter(item => item.kind === 'crowd' || item.kind === 'finish'), []);
  // 동점이면 최고 기록이 아니다.
  const tie = usageFill('2026-09-14', 16, () => ({ task_done: 1 }));
  assert.equal(usageStats(app, tie, '2026-09-29', 'week').insights.some(item => item.kind === 'best'), false);
  // 90일 보기는 하루 최고 기록.
  assert.equal(usagePartsText(usageStats(app, history, '2026-09-30', '90').insights.find(item => item.kind === 'best').parts), '하루 최고 기록은 9월 30일의 20개예요.');
  // 조건이 하나도 안 맞으면 빈 목록(칸째 숨김).
  assert.deepEqual(usageStats(app, { '2026-09-29': { task_done: 1 } }, '2026-09-30', 'week').insights, []);
});

test('WP-W 알게 된 것 c — 들어온 일 20% 이상 늘고 끝낸 비율이 5%p 넘게 떨어지지 않으면 `바빠도 유지`', () => {
  const app = usageWorkClient();
  const base = usageFill('2026-09-21', 5, () => ({ search: 1 }));
  const run = doneNow => usageStats(app, {
    ...base,
    '2026-09-21': { task_add: 5, task_done: 4 },
    '2026-09-28': { task_add: 6, task_done: doneNow },
    '2026-09-29': { task_add: 4 },
    '2026-09-30': { search: 1 },
  }, '2026-09-30', 'week');
  const kept = run(8);   // 10 vs 5(+100%), 80% ↔ 80%
  assert.deepEqual(kept.insights.map(item => item.kind), ['steady']);
  assert.equal(usagePartsText(kept.insights[0].parts), '들어온 일이 100% 늘었는데 끝낸 비율은 80%로 유지했어요. 바빠도 밀리지 않았어요.');
  assert.equal(run(7).insights.length, 0, '70%는 80%보다 5%p 넘게 떨어짐');
  assert.equal(run(8).compare.text, '지난주보다 100% 더 바빴어요');
  // 첫 기록이 비교 기간 시작(9/21)보다 뒤면 c도 없다.
  const late = usageStats(app, {
    ...usageFill('2026-09-22', 4, () => ({ search: 1 })),
    '2026-09-22': { task_add: 5, task_done: 4 },
    '2026-09-28': { task_add: 6, task_done: 8 },
    '2026-09-29': { task_add: 4 },
    '2026-09-30': { search: 1 },
    '2026-09-27': { search: 1 },
  }, '2026-09-30', 'week');
  assert.equal(late.compare, null);
  assert.deepEqual(late.insights.filter(item => item.kind === 'steady'), []);
});

// WP-X부터 이 내용은 설정이 아니라 주간요약의 자세히 창(usageWorkOpen)에 그린다.
test('WP-W 그리기 — 세그먼트(aria-pressed)·타일 3개·막대는 aria-hidden + 숨긴 목록, 빈 상태 한 줄, 기능별 전체 보기 표', () => {
  const app = usageWorkClient();
  app.run(`const __make = document.createElement;
    document.createElement = tag => Object.assign(__make(tag), { tagName: String(tag).toUpperCase(), style: {} });
    document.createElementNS = (ns, tag) => document.createElement(tag);
    document.createTextNode = value => ({ textContent: String(value), children: [] });`);
  const find = (node, match) => { if (!node || typeof node !== 'object') return null; if (match(node)) return node; for (const kid of node.children || []) { const hit = find(kid, match); if (hit) return hit; } return null; };
  const all = (node, match, out = []) => { if (!node || typeof node !== 'object') return out; if (match(node)) out.push(node); (node.children || []).forEach(kid => all(kid, match, out)); return out; };
  const text = node => (node && typeof node === 'object' ? (node.children && node.children.length ? node.children.map(text).join('') : (node.textContent || '')) : '');
  const rows = JSON.stringify(Array.from({ length: 17 }, (_, i) => ({ key: `k${i}`, label: `기능 ${i}`, count: i })));
  app.run(`usageInfo = { ok: true, send: true, canSend: true, days: 30, rows: ${rows}, today: '2026-09-30',
      history: { '2026-09-28': { slack_in: 11, task_done: 2 }, '2026-09-29': { task_add: 1, task_done: 5 }, '2026-09-30': { task_done: 3 } } };
    usageWorkOpen(null, null);`);
  const work = app.run('usageWorkDlg.body');
  assert.ok(work);
  assert.equal(text(find(app.run('usageWorkDlg.dialog'), node => node.tagName === 'H2')), '내 일 기록');
  const seg = all(work, node => node.dataset && node.dataset.range);
  assert.deepEqual(seg.map(button => [button.textContent, button.getAttribute('aria-pressed')]), [['이번 주', 'true'], ['이번 달', 'false'], ['90일', 'false']]);
  assert.equal(text(find(work, node => node.className === 'd-uwbig')), '이번 주 일 10개를 끝냈어요');
  assert.equal(find(work, node => node.className === 'd-uwbig').children[1].tagName, 'B');
  const tiles = all(work, node => /^d-uwtile( |$)/.test(String(node.className)));
  assert.deepEqual(tiles.map(tile => text(tile)), ['들어온 일12개슬랙\u00a011 · 직접\u00a01', '끝낸 일10개', '남긴 기록0개'], '항목 안은 붙는 빈칸 — `확인 대기 8`이 낱말 중간에서 안 끊긴다');
  assert.equal(tiles[1].className, 'd-uwtile is-done');
  const bars = find(work, node => String(node.className).startsWith('d-uwbars'));
  assert.equal(bars.getAttribute('aria-hidden'), 'true');
  assert.equal(bars.children.length, 7);
  const list = find(work, node => node.className === 'sr-only');
  assert.deepEqual(list.children.map(item => item.textContent), ['월요일: 들어옴 11개, 끝냄 2개', '화요일: 들어옴 1개, 끝냄 5개', '수요일(오늘): 들어옴 0개, 끝냄 3개']);
  assert.equal(text(find(work, node => node.className === 'd-uwnote')), '월요일에 11개가 몰렸고, 화·수에 들어온 것보다 더 끝내서 따라잡았어요');
  assert.equal(find(work, node => node.className === 'd-uwins'), null, '알게 된 것이 없으면 칸째 숨김');
  const table = find(work, node => String(node.className).includes('d-usagehist'));
  assert.equal(text(find(table, node => node.tagName === 'SUMMARY')), '기능별 전체 보기 (17개)');
  assert.equal(text(find(table, node => node.tagName === 'CAPTION')), '최근 30일 합계 · 이 맥에만 있어요');
  // 기간 바꾸기 — 다시 그린다.
  seg[1].listeners.click();
  const month = find(app.run('usageWorkDlg.body'), node => node.dataset && node.dataset.range === 'month');
  assert.equal(month.getAttribute('aria-pressed'), 'true');
  // 빈 상태.
  app.run('usageInfo = { ...usageInfo, history: {} }; usageWorkPaint();');
  const empty = app.run('usageWorkDlg.body');
  assert.equal(text(find(empty, node => String(node.className).includes('d-uwempty'))), '아직 기록이 없어요. 할 일을 끝내면 여기에 쌓여요.');
  assert.equal(find(empty, node => node.className === 'd-uwtiles'), null);
  assert.equal(find(empty, node => node.className === 'd-uwhead'), null, '기록이 없으면 기간 전환·기간 글자를 숨긴다');
  // 응답 실패.
  app.run('usageInfo = null; usageWorkPaint();');
  assert.equal(text(app.run('usageWorkDlg.body')), '사용 기록을 읽지 못했어요.');
});

// ---------- BBUNDLE 덩어리 2: 고르기 검색 칸 + 다른 화면에서 묶음 알아보기 ----------
// bundleClient(위): IO-1(대표)·IO-2가 한 묶음, AL-9는 따로.
test('BBUNDLE 2 오늘 탭: 묶음은 대표 키 한 그룹(이름·+는 대표), 줄마다 작은 KEY — 풀면 곧바로 두 그룹, 옛 데이터는 그대로', () => {
  const app = bundleClient();
  const groups = () => JSON.parse(app.run("JSON.stringify(uiGroupTasks(workflowData.items.filter(i => i.type === 'task')).map(([key, list]) => [key, list.map(i => i.id)]))"));
  assert.deepEqual(groups(), [['jira:AL-9', ['c1']], ['jira:IO-1', ['a1', 'a2', 'b1']]]);
  assert.equal(app.run("uiGroupFromKey('jira:IO-1', wfItem('b1'))"), 'IO-2', '묶음 그룹의 줄에는 제 티켓 번호');
  assert.equal(app.run("uiGroupFromKey('jira:AL-9', wfItem('c1'))"), '', '묶음이 아니면 붙이지 않는다');
  assert.equal(app.run("uiGroupLabels(['jira:IO-1']).get('jira:IO-1')"), '결제 리뉴얼', '그룹 이름은 대표 티켓');
  // 대표 티켓의 업무가 다 끝나 목록에서 빠져도 그룹 이름·열쇠는 대표 기준이다.
  assert.deepEqual(JSON.parse(app.run("JSON.stringify(uiGroupTasks([wfItem('b1')]).map(([key]) => key))")), ['jira:IO-1']);
  // 확인 대기(waitingGroups — uiGroupTasks의 복제본)도 같은 규칙.
  assert.deepEqual(JSON.parse(app.run("JSON.stringify(waitingGroups(workflowData.items.filter(i => i.type === 'check')).map(([key]) => key))")), ['jira:IO-1']);
  // 확인 대기 줄은 둘째 줄 맨 앞에 작은 번호(.d-pfrom), `+ 이 그룹에 추가` 줄은 그룹 열쇠(대표 티켓)로 붙는다.
  assert.equal(nodeFind(app.run("renderWaitingRow(wfItem('b2'), { fromKey: 'IO-2' })"), 'd-pfrom').textContent, 'IO-2');
  assert.equal(nodeFind(app.run("renderWaitingRow(wfItem('b2'))"), 'd-pfrom'), null);
  assert.equal(app.run("uiGroupAddRow('jira:IO-1', '/api/today-task/create', '').dataset.addKey"), '/api/today-task/create::jira:IO-1');
  // 풀기 직후(칸이 비면) 곧바로 두 그룹, 줄 번호도 사라진다. 옛 데이터(칸 없음)도 같다.
  app.run('workflowData.projectBundles = []');
  assert.deepEqual(groups().map(([key]) => key), ['jira:AL-9', 'jira:IO-1', 'jira:IO-2']);
  app.run('delete workflowData.projectBundles');
  assert.deepEqual(groups().map(([key]) => key), ['jira:AL-9', 'jira:IO-1', 'jira:IO-2']);
  assert.equal(app.run("uiGroupFromKey('jira:IO-1', wfItem('a1'))"), '');
});

test('BBUNDLE 2 고르기 선택지: 묶음 한 줄(굵게·대표로 저장) + 들여쓴 나머지 티켓, 나머지 티켓을 직접 골라도 된다', () => {
  const app = bundleClient();
  const entries = code => JSON.parse(app.run(`JSON.stringify(projectPickEntries(${code}))`));
  const options = entries('null, false').filter(entry => entry.type === 'option');
  assert.deepEqual(options.map(entry => [entry.value, entry.text, entry.level, !!entry.strong]), [
    ['jira:IO-1', '결제 리뉴얼', 0, true],
    ['jira:IO-2', '정기결제 재시도', 1, false],
    ['jira:AL-9', '알림센터', 0, false],
  ], '묶음 줄 바로 아래 들여쓴 티켓, 대표 티켓은 따로 한 줄을 더 만들지 않는다');
  assert.match(options[0].label, /묶음 · 티켓 2개 — 대표 IO-1로 지정/);
  assert.deepEqual(options.slice(0, 2).map(entry => entry.dot), ['jira:IO-1', 'jira:IO-1'], '들여쓴 티켓 색 점도 묶음(대표) 색 — 같은 프로젝트가 두 색으로 읽히지 않게');
  const picked = entries("{ type: 'jira', value: 'IO-2' }, false").filter(entry => entry.selected).map(entry => entry.value);
  assert.deepEqual(picked, ['jira:IO-2'], '나머지 티켓이 지금 값이면 그 들여쓴 줄이 골라져 있다');
  // 별칭이 있으면 묶음 이름도 별칭이다.
  app.run("projectAliasesCache = { 'IO-1': '결제 개편' }");
  assert.equal(entries('null, false').find(entry => entry.value === 'jira:IO-1').text, '결제 개편');
  // 옛 데이터(묶음 칸 없음)는 전부 한 줄씩, 들여쓰기 없음.
  app.run("projectAliasesCache = {}; delete workflowData.projectBundles");
  assert.deepEqual(entries('null, false').filter(entry => entry.type === 'option').map(entry => entry.level), [0, 0, 0]);
});

test('BBUNDLE 2 고르기 찾기: 이름·키·별칭·한글 부분 일치, 묶음은 티켓 하나만 맞아도 묶음 줄과 함께, 0개면 동작 줄만', () => {
  const app = bundleClient();
  app.run("projectAliasesCache = { 'AL-9': '푸시' }");
  const shown = query => JSON.parse(app.run(`JSON.stringify(uiPickFilter(projectPickEntries(null, true), ${JSON.stringify(query)}).map(e => e.value || '# ' + e.text))`));
  assert.deepEqual(shown('정기'), ['jira:IO-1', 'jira:IO-2', '__custom__', '__clear__'], '나머지 티켓만 맞아도 묶음 줄이 함께 선다');
  assert.deepEqual(shown('리뉴얼'), ['jira:IO-1', 'jira:IO-2', '__custom__', '__clear__'], '묶음 이름이 맞으면 티켓 전부');
  assert.deepEqual(shown('io-2'), ['jira:IO-1', 'jira:IO-2', '__custom__', '__clear__'], '키는 대소문자 무시');
  assert.deepEqual(shown('푸시'), ['jira:AL-9', '__custom__', '__clear__'], '별칭으로도');
  assert.deepEqual(shown('알림'), ['jira:AL-9', '__custom__', '__clear__'], '별칭이 있어도 지라 원래 요약으로도');
  assert.deepEqual(shown('없는 이름'), ['__custom__', '__clear__'], '0개면 직접 입력·해제만 남는다');
  assert.deepEqual(shown(''), shown('   '), '빈 말은 거르지 않는다');
  // 찾기 칸은 선택지가 PROJECT_FIND_MIN(8)개 이상일 때만.
  assert.equal(app.run('uiPickSearchable(projectPickEntries(null, false))'), false);
  app.run("customGroupsCache = ['가', '나', '다', '라', '마']");
  assert.equal(app.run('uiPickSearchable(projectPickEntries(null, false))'), true);
});

test('BBUNDLE 2 고르기 목록: 찾기 칸(type=search·aria) + listbox, 0개면 `찾는 프로젝트가 없어요`, Enter는 맨 위, Esc는 닫기', () => {
  const app = bundleClient();
  app.run(`picks = []; closes = [];
    pickNode = uiPickList({ entries: projectPickEntries(null, false), label: '프로젝트 고르기', search: true,
      onPick: (value, query) => picks.push([value, query]), onClose: byKey => closes.push(byKey) });`);
  const root = app.run('pickNode');
  const [input, none, list] = root.children;
  assert.equal(input.type, 'search');
  assert.equal(input.getAttribute('aria-label'), '프로젝트 고르기 — 찾기');
  assert.equal(input.getAttribute('aria-controls'), list.id);
  assert.equal(list.getAttribute('role'), 'listbox');
  const options = list.children.filter(kid => kid.getAttribute && kid.getAttribute('role') === 'option');
  assert.deepEqual(options.map(kid => kid.className), ['d-mitem d-gpopt is-bundle', 'd-mitem d-gpopt is-sub', 'd-mitem d-gpopt', 'd-mitem d-gpopt is-act']);
  assert.equal(nodeFind(options[0], 'nm').title, '결제 리뉴얼', '긴 이름은 말줄임 + title');
  assert.equal(none.hidden, true);
  input.value = '없는 이름';
  input.listeners.input();
  assert.equal(none.textContent, '찾는 프로젝트가 없어요');
  assert.equal(none.hidden, false);
  assert.equal(none.getAttribute('role'), 'status');
  // 찾던 글자로 Enter면 맨 위(맞는) 선택지를 고른다.
  input.value = '정기';
  input.listeners.input();
  const stop = { preventDefault() {}, stopPropagation() { this.stopped = true; } };
  root.listeners.keydown({ ...stop, key: 'Enter', target: input });
  assert.deepEqual(JSON.parse(app.run('JSON.stringify(picks)')), [['jira:IO-1', '정기']], '묶음 줄(대표)이 맨 위');
  // Esc는 목록만 닫고 바깥(⋯ 메뉴의 Esc)으로 올라가지 않는다.
  app.run(`closes = []; pickNode = uiPickList({ entries: projectPickEntries(null, false), label: '프로젝트 고르기', onPick() {}, onClose: byKey => closes.push(byKey) });`);
  const esc = { preventDefault() {}, stopPropagation() { esc.stopped = true; }, key: 'Escape' };
  app.run('pickNode').listeners.keydown(esc);
  assert.deepEqual(JSON.parse(app.run('JSON.stringify(closes)')), [true]);
  assert.equal(esc.stopped, true);
  // 찾기 칸이 없으면 첫 줄이 Tab으로 들어오는 자리다.
  assert.equal(app.run('pickNode').children.at(-1).children[0].tabIndex, 0);
});

test('BBUNDLE 2 배포 리마인드: 묶음도 티켓별로, 같은 묶음에서 버전·날짜가 같으면 한 줄, 그룹에 건 같은 티켓은 한 줄로', () => {
  const app = bundleClient();
  const soon = app.run('todayStr()');
  app.run(`const version = (name, releaseDate) => [{ name, releaseDate, released: false }];
    jiraIssuesByKey.get('IO-1').versions = version('v2.70.0', ${JSON.stringify(soon)});
    jiraIssuesByKey.get('IO-2').versions = version('v2.70.0', ${JSON.stringify(soon)});
    jiraIssuesByKey.get('AL-9').versions = version('v2.71.0', ${JSON.stringify(soon)});
    workflowData.projectLinks = { '알림 운영': 'AL-9' };`);
  const rows = "[{ key: 'jira:IO-1', open: 2 }, { key: 'jira:IO-2', open: 1 }, { key: 'jira:AL-9', open: 1 }, { key: 'group:알림 운영', open: 3 }]";
  const reminders = () => JSON.parse(app.run(`JSON.stringify(deployReminders(${rows}).map(e => [e.key, e.label, e.name, e.open]))`));
  assert.deepEqual(reminders().sort(), [
    ['jira:AL-9', '알림센터', 'v2.71.0', 4],
    ['jira:IO-1', '결제 리뉴얼', 'v2.70.0', 3],
  ].sort(), '같은 묶음·같은 버전은 대표 이름 한 줄(열린 업무 합), 그룹에 건 AL-9는 지라 줄 하나로');
  app.run(`jiraIssuesByKey.get('IO-2').versions = [{ name: 'v2.69.1', releaseDate: ${JSON.stringify(soon)}, released: false }]`);
  assert.deepEqual(reminders().map(([key]) => key).sort(), ['jira:AL-9', 'jira:IO-1', 'jira:IO-2'], '버전이 다르면 티켓별로 따로');
});

test('BBUNDLE 2 회의: 연결 뒤 옮기기 후보·다른 프로젝트 수는 목적지 묶음 전체를 같은 프로젝트로 보고, 프로젝트별 보기는 한 소제목', () => {
  const app = bundleClient();
  const items = `[
    { id: 'x1', type: 'task', status: 'to-do', jira: 'IO-2' },
    { id: 'x2', type: 'task', status: 'to-do' },
    { id: 'x3', type: 'task', status: 'to-do', jira: 'AL-9' },
  ]`;
  const moved = JSON.parse(app.run(`JSON.stringify(meetingMoveCandidates(${items}, null, 'jira:IO-1'))`));
  assert.deepEqual(moved, { ids: ['x2'], done: 0, other: 1 }, 'IO-2(같은 묶음)는 옮기지도 `다른 프로젝트`로 세지도 않는다');
  const groups = JSON.parse(app.run(`JSON.stringify(meetingsTabGroups([
    { id: 'm1', date: '2026-09-20', project: { type: 'jira', value: 'IO-1' } },
    { id: 'm2', date: '2026-09-21', project: { type: 'jira', value: 'IO-2' } },
    { id: 'm3', date: '2026-09-22', project: null },
  ], () => []).map(group => [group.key, group.list.map(event => event.id)]))`));
  assert.deepEqual(groups, [['jira:IO-1', ['m1', 'm2']], ['__misc__', ['m3']]]);
  assert.deepEqual(JSON.parse(app.run("JSON.stringify(meetingCaptureProject({ type: 'jira', value: 'IO-2', label: 'IO-2' }))")),
    { type: 'jira', value: 'IO-1', label: 'IO-2' }, '기록 안 된 회의에서 담아도 대표 티켓');
  assert.deepEqual(JSON.parse(app.run("JSON.stringify(meetingCaptureProject({ type: 'group', value: '운영툴' }))")), { type: 'group', value: '운영툴' });
});

test('BBUNDLE 2 반응 필요 색·하위 티켓 거르기: 묶인 티켓은 대표 색, 거르기는 카드(티켓)별이라 다른 카드로 번지지 않는다', () => {
  const app = bundleClient();
  assert.equal(app.run("projectGroupKey('jira:IO-2')"), 'jira:IO-1');
  assert.equal(app.run("projectGroupKey('jira:AL-9')"), 'jira:AL-9');
  assert.equal(app.run("projectGroupKey('group:운영툴')"), 'group:운영툴');
  assert.equal(app.run('projectGroupKey(null)'), null);
  const kids = [{ key: 'K-1', summary: '가', status: { name: '진행 중', category: 'doing' }, assignee: '루본' }, { key: 'K-2', summary: '나', status: { name: '할 일', category: 'todo' }, assignee: '하늘' }];
  app.run(`jiraChildPicks.set('IO-1', '루본')`);
  const rows = key => app.run(`jiraChildList({ key: '${key}', url: 'https://example-jira.test/browse/${key}' }, ${JSON.stringify(kids)})`).children.length;
  assert.equal(rows('IO-1'), 1, '거른 카드만 걸러진다');
  assert.equal(rows('IO-2'), 2, '옆 카드는 그대로');
});

test('BBUNDLE 2 좁은 폭 옆 카드: 접힌 한 줄은 `KEY · 이름 · 상태` 글자 + 꺾쇠, 줄 전체가 aria-expanded 버튼', () => {
  const app = bundleClient();
  app.run(`jiraSide = { project: 'jira:IO-1', keys: ['IO-2'], cards: { 'IO-2': { key: 'IO-2', state: 'ok', issue: { key: 'IO-2', summary: '정기결제 재시도', status: { name: '기획', category: 'todo' } }, at: 1, seq: 1 } } };
    jiraCard = { key: 'IO-1', state: 'loading', issue: null, error: '', at: 0, seq: 1 };`);
  const fold = app.run("jiraSideFold('IO-2')");
  assert.equal(fold.className, 'd-jfold');
  assert.equal(fold.getAttribute('aria-expanded'), 'false');
  assert.deepEqual(fold.children.map(kid => kid.textContent), ['IO-2', '·', '정기결제 재시도', '·', '기획']);
  assert.equal(fold.children[4].className, 'st k-dim', '상태는 색과 함께 글자로');
  assert.match(fold.html, /d-i/, '꺾쇠는 uiIcon');
  assert.equal(fold.getAttribute('aria-label'), 'IO-2 · 정기결제 재시도 · 기획 — 지라 카드 펼치기');
  fold.listeners.click();
  assert.equal(app.run("jiraSideOpen.has('IO-2')"), true);
  assert.equal(app.run("jiraSideFold('IO-2')").getAttribute('aria-expanded'), 'true');
  // 아직 읽는 중이면 상태 자리에 `읽는 중`.
  app.run("jiraSide.cards['IO-2'] = { key: 'IO-2', state: 'loading', issue: null, at: 0, seq: 2 }");
  assert.equal(app.run("jiraSideFold('IO-2')").children.at(-1).textContent, '읽는 중');
});

// ---------- 프로젝트 0개 빈 화면(첫 사용) ----------
// 정말 0개일 때만 머리의 개수와 `상태별 | 배포별`을 숨기고, 오른쪽에 한 판 + `프로젝트 만들기`를 세운다.
// 찾기로 거른 0개는 여기에 해당하지 않는다(BPVIEW 규칙 그대로).
function projectEmptyClient() {
  const fixture = projectListClient();
  fixture.app.run(`workflowData = { meetings: [], projectLinks: {}, items: [] }; wfIndexData(); itemsById = new Map();
    projectKey = null; projectOrderKeys = null; projectOrderResort = true; projectNew = null;
    projectListView = 'status'; projectFindQuery = '';
    newStarts = 0; projectNewStart = () => { newStarts += 1; };`);
  const head = () => fixture.list().children.find(kid => String(kid.className || '') === 'd-rhd');
  const count = () => nodeFind(head(), 'n');
  const seg = () => fixture.list().children.find(kid => String(kid.className || '').includes('d-pfseg'));
  const board = () => nodeFind(fixture.app.nodes.get('projectBody'), 'd-pempty');
  const addOne = () => fixture.app.run(`workflowData.items.push({ id: 'n1', type: 'task', status: 'to-do', group: '새 일', created: dayAgo(0) });
    wfIndexData(); projectOrderResort = true;`);
  return { ...fixture, head, count, seg, board, addOne };
}

test('프로젝트 0개: 개수·`상태별 | 배포별`이 숨고 오른쪽은 제목·한 줄·`프로젝트 만들기` 한 판이다', () => {
  const fx = projectEmptyClient();
  fx.render();
  assert.equal(fx.count().hidden, true, '개수 0은 적지 않는다');
  assert.equal(fx.seg().hidden, true, '정렬할 것이 없으니 세그먼트도 숨는다');
  assert.ok(nodeFind(fx.head(), 'd-pnewgo'), '머리의 `+`는 그대로 선다');
  const board = fx.board();
  assert.ok(board, '빈 판이 선다');
  assert.ok(String(board.className).split(' ').includes('d-psurf'), '기존 흰 카드 부품이다');
  const [title, text, button] = board.children;
  assert.equal(title.textContent, '아직 프로젝트가 없어요');
  assert.equal(title.id, board.getAttribute('aria-labelledby'), '판의 이름은 제목이다');
  assert.equal(text.textContent, '업무·결정·회의를 프로젝트로 묶으면 여기서 한 번에 봐요. 업무의 ⋯\u00a0›\u00a0프로젝트를 정해도 저절로 생겨요.',
    '메뉴 길은 붙는 빈칸으로 이어 한 덩어리로 줄바꿈된다');
  assert.ok(String(button.className).split(' ').includes('d-btn'), '기존 버튼 부품');
  assert.ok(String(button.className).split(' ').includes('acc'), '2차(연파랑) 버튼');
  assert.equal(button.html, fx.app.run("uiIcon('plus')"), '앞의 더하기는 앱 아이콘이다(유니코드 ＋가 아니다)');
  assert.deepEqual(button.children, ['프로젝트 만들기']);
  assert.equal(fx.app.nodes.get('projectBody').children.some(kid => String(kid.className || '') === 'd-empty'), false,
    '예전 한 문장은 없다');
  // 제목은 h2(프로젝트 화면 제목과 같은 층), 새 innerHTML은 없다(아이콘만 insertAdjacentHTML).
  const source = fs.readFileSync(path.join(__dirname, 'projects-ui.js'), 'utf8');
  const fn = source.slice(source.indexOf('function projectEmptyBoard('), source.indexOf('\n}\n', source.indexOf('function projectEmptyBoard(')));
  assert.match(fn, /createElement\('h2'\)/);
  assert.equal(/innerHTML/.test(fn), false);
});

test('프로젝트 0개: `프로젝트 만들기`는 머리의 `+`와 같은 함수(projectNewStart)를 부른다', () => {
  const fx = projectEmptyClient();
  fx.render();
  nodeFind(fx.head(), 'd-pnewgo').listeners.click();
  assert.equal(fx.app.run('newStarts'), 1);
  fx.board().children[2].listeners.click();
  assert.equal(fx.app.run('newStarts'), 2, '새 동작 없이 같은 길');
});

test('프로젝트 1개 이상이면 머리·세그먼트·오른쪽 화면이 그대로다', () => {
  const fixture = projectListClient();
  fixture.render();
  const head = fixture.list().children[0];
  assert.equal(nodeFind(head, 'n').hidden, false);
  assert.equal(fixture.list().children.find(kid => String(kid.className || '').includes('d-pfseg')).hidden, false);
  assert.equal(nodeFind(fixture.app.nodes.get('projectBody'), 'd-pempty'), null, '빈 판은 없다');
  assert.ok(nodeFind(fixture.app.nodes.get('projectBody'), 'd-ptitle'), '고른 프로젝트 화면이 그대로 선다');
});

test('프로젝트 0 → 1 → 0: 개수·세그먼트·빈 판이 나타났다 사라진다', () => {
  const fx = projectEmptyClient();
  fx.render();
  assert.equal(fx.seg().hidden, true);
  fx.addOne();
  fx.render();
  assert.equal(fx.count().hidden, false);
  assert.equal(fx.count().textContent, 1);
  assert.equal(fx.seg().hidden, false);
  assert.equal(fx.board(), null);
  fx.app.run('workflowData.items = []; wfIndexData(); projectOrderResort = true;');
  fx.render();
  assert.equal(fx.count().hidden, true);
  assert.equal(fx.seg().hidden, true);
  assert.ok(fx.board());
});

test('프로젝트 0개가 되며 세그먼트가 숨으면 거기 있던 초점은 머리의 `+`로 간다', () => {
  const fx = projectEmptyClient();
  fx.addOne();
  fx.render();
  const seg = fx.seg();
  fx.app.run("document.activeElement = { id: 'segButton' };");
  seg.contains = node => !!node && node.id === 'segButton';
  fx.app.run('workflowData.items = []; wfIndexData(); projectOrderResort = true;');
  fx.render();
  assert.equal(nodeFind(fx.head(), 'd-pnewgo').focused, true);
});

test('찾기로 거른 결과가 0이면 프로젝트 0개가 아니다 — 세그먼트·개수는 그대로, 오른쪽 빈 판도 없다', () => {
  const fixture = bpviewClient();
  fixture.render();
  const input = fixture.findInput();
  input.value = '존재하지않는프로젝트이름';
  input.listeners.input();
  assert.equal(fixture.list().children.find(kid => String(kid.className || '') === 'd-empty').textContent, '맞는 프로젝트가 없어요.');
  assert.equal(fixture.list().children.find(kid => String(kid.className || '').includes('d-pfseg')).hidden, false);
  assert.equal(nodeFind(fixture.list().children[0], 'n').hidden, false);
  assert.equal(nodeFind(fixture.app.nodes.get('projectBody'), 'd-pempty'), null);
});

// ---------- 회의 정리 판 다듬기: 초안 `빼기`(되돌리기·⌘Z) · 담기 바의 빈 초안 오류 · 앱 날짜 글자 ----------
function meetingBoardClient() {
  const app = workflowsClient();
  const sent = [];
  app.context.fetch = async (url, init) => {
    sent.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
    return new Response('{"ok":true,"created":[]}', { status: 200 });
  };
  app.run('requestAnimationFrame = () => 0;');
  app.run("var loaded = 0; load = async () => { loaded += 1; };");
  const meeting = {
    id: 'mb1', date: meetingNotesDay(0), start: '10:00', end: '10:30', title: '데일리 스크럼',
    drafts: [
      { id: 'mb1:stable:a', type: 'task', description: '백엔드 담당자에게 결제 스펙 요청하기', due: '2026-10-02' },
      { id: 'mb1:stable:b', type: 'check', description: '디자인 일정 회신 받기' },
      { id: 'mb1:stable:c', type: 'decision', description: '실패 알림은 푸시 대신 앱 안 배너로' },
    ],
  };
  app.context.__meeting = meeting;
  app.run('workflowData = { items: [], meetings: [__meeting] }; wfIndexData(); wfDraftEdits.clear();');
  const draw = () => app.run(`(() => {
    const box = document.createElement('div');
    const host = { kind: 'card', closable: false, getResult: () => null, setResult() {}, redraw() {}, box: () => box, openItem() {}, openMeeting() {} };
    panelMeetingDrafts(__meeting, box, host);
    return box;
  })()`);
  return { app, sent, meeting, draw };
}

test('회의 초안: 빼기는 조용한 글자 버튼 `빼기`(초안 앞부분이 이름)이고, 초안 카드의 ✕는 날짜 칸의 `날짜 지우기`뿐이다', () => {
  const { draw } = meetingBoardClient();
  const box = draw();
  const cards = nodeFindAll(box, 'd-draft');
  assert.equal(cards.length, 3);
  const pull = nodeFind(cards[0], 'd-dpull');
  assert.equal(pull.textContent, '빼기');
  assert.equal(pull.className, 'd-headnum d-dpull', '기존 조용한 글자 버튼 부품(28px)');
  assert.equal(pull.getAttribute('aria-label'), '초안 빼기: 백엔드 담당자에게 결제 스펙 요청하기');
  assert.equal(nodeFind(cards[0], 'x'), null, '예전 ✕(d-iconbtn x)는 없다');
  const closes = nodeFindAll(cards[0], 'd-iconbtn');
  assert.equal(closes.length, 1, '✕는 날짜 칸 하나');
  assert.equal(closes[0].getAttribute('aria-label'), '기한 지우기');
  // 날짜는 브라우저 기본 표기 대신 앱 날짜 글자, 누르면 입력칸
  const face = nodeFind(cards[0], 'is-shown');
  assert.equal(face.textContent, '10월 2일 (금)');
  assert.match(face.getAttribute('aria-label'), /^기한 10월 2일 \(금\) — 바꾸기$/);
  face.listeners.click();
  const field = nodeFind(cards[0], 'd-datefield');
  assert.equal(field.children[0].type, 'date', '누르면 그 자리에서 날짜 입력칸');
  assert.equal(field.children[0].value, '2026-10-02');
  // 긴 문구는 앞부분만, 빈 문구는 빈 초안이라고
  const text = nodeFind(cards[1], 'd-dtxt');
  text.style = {};
  text.value = '';
  text.listeners.input();
  assert.equal(nodeFind(cards[1], 'd-dpull').getAttribute('aria-label'), '빈 초안 빼기');
  text.value = '가'.repeat(40);
  text.listeners.input();
  assert.equal(nodeFind(cards[1], 'd-dpull').getAttribute('aria-label'), `초안 빼기: ${'가'.repeat(30)}…`);
});

test('회의 초안: 빈 문구로 담으면 담기 바의 요약 자리에 오류, 첫 빈 칸으로 초점·표시, 채우면 걷힌다(아무것도 보내지 않는다)', async () => {
  const { app, sent, draw } = meetingBoardClient();
  const box = draw();
  const cards = nodeFindAll(box, 'd-draft');
  const texts = cards.map(card => nodeFind(card, 'd-dtxt'));
  texts.forEach(text => { text.style = {}; });
  texts[1].value = ' '; texts[1].listeners.input();
  texts[2].value = ''; texts[2].listeners.input();
  const bar = nodeFind(box, 'd-dbar');
  const summary = nodeFind(bar, 'sm');
  const message = nodeFind(bar, 'er');
  assert.equal(message.getAttribute('role'), 'alert');
  const go = bar.children[bar.children.length - 1];
  assert.equal(go.textContent, '3개 담기');
  await go.listeners.click();
  assert.equal(sent.length, 0, '서버에 보내지 않는다');
  assert.equal(message.textContent, '빈 초안이 2개 있어요. 채우거나 빼 주세요');
  assert.equal(summary.hidden, true, '요약 글자 자리에 대신 선다');
  assert.equal(texts[1].getAttribute('aria-invalid'), 'true');
  assert.equal(texts[2].getAttribute('aria-invalid'), 'true');
  assert.equal(texts[1].getAttribute('aria-describedby'), message.id);
  assert.equal(texts[0].getAttribute('aria-invalid'), undefined);
  assert.equal(texts[1].focused, true, '첫 빈 칸으로 초점');
  assert.equal(nodeFind(box, 'd-derr'), null, '카드 머리 오류 줄에는 적지 않는다');
  texts[1].value = '채운 문구'; texts[1].listeners.input();
  assert.equal(texts[1].getAttribute('aria-invalid'), undefined);
  assert.equal(message.textContent, '빈 초안이 1개 있어요. 채우거나 빼 주세요');
  texts[2].value = '또 채운 문구'; texts[2].listeners.input();
  assert.equal(message.textContent, '');
  assert.equal(summary.hidden, false);
  await go.listeners.click();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, '/api/workflow/review');
  app.run('undoStack.length = 0;');
});

test('회의 초안: 빼면 `초안 하나를 뺐어요 · 되돌리기`, ⌘Z는 여러 번 역순으로 하나씩 되살리고 고쳐 둔 문구도 돌아온다', async () => {
  const { app, sent, draw, meeting } = meetingBoardClient();
  app.run('undoStack.length = 0; redoStack.length = 0;');
  let box = draw();
  const first = nodeFindAll(box, 'd-draft')[0];
  const text = nodeFind(first, 'd-dtxt');
  text.style = {};
  text.value = '고쳐 둔 첫 문구'; text.listeners.input();
  await nodeFind(first, 'd-dpull').listeners.click();
  assert.deepEqual(sent.map(call => call.url), ['/api/workflow/review']);
  assert.deepEqual(sent[0].body, { meetingId: 'mb1', dismiss: ['mb1:stable:a'] });
  assert.equal(app.run('loaded'), 1, '빼면 목록을 다시 읽는다');
  const notice = app.nodes.get('liveRegion');
  assert.match(notice.textContent, /^초안 하나를 뺐어요/);
  assert.ok(notice.children.some(kid => kid.textContent === '되돌리기'), '알림에 되돌리기');
  assert.equal(app.run("wfDraftEdits.has('mb1:stable:a')"), false);

  // 판을 닫았다 다시 연 것처럼 새로 그린 뒤 둘째도 뺀다
  app.run("__meeting.drafts = __meeting.drafts.slice(1);");
  box = draw();
  await nodeFind(nodeFindAll(box, 'd-draft')[0], 'd-dpull').listeners.click();
  assert.equal(app.run('undoStack.length'), 2);

  await app.run("replayUndo('undo')");
  assert.equal(sent[2].url, '/api/workflow/review-restore');
  assert.deepEqual(sent[2].body, { meetingId: 'mb1', drafts: ['mb1:stable:b'] }, '나중에 뺀 것부터');
  await app.run("replayUndo('undo')");
  assert.deepEqual(sent[3].body, { meetingId: 'mb1', drafts: ['mb1:stable:a'] });
  assert.equal(app.run("wfDraftEdits.get('mb1:stable:a').description"), '고쳐 둔 첫 문구', '고쳐 둔 문구가 그대로 돌아온다');
  assert.doesNotMatch(notice.textContent, /저장했어요/, '되살리기는 조용히 저장하고 결과만 알린다');
  // 다시 실행(⇧⌘Z)은 다시 뺀다
  await app.run("replayUndo('redo')");
  assert.equal(sent[4].url, '/api/workflow/review');
  assert.deepEqual(sent[4].body, { meetingId: 'mb1', dismiss: ['mb1:stable:a'] });
  assert.ok(meeting);
});

test('회의 초안: 알림의 `되돌리기`는 맨 위 기록일 때만 되살린다(아니면 순서대로 하라고 알린다)', async () => {
  const { app, sent, draw } = meetingBoardClient();
  app.run('undoStack.length = 0; redoStack.length = 0;');
  const box = draw();
  await nodeFind(nodeFindAll(box, 'd-draft')[2], 'd-dpull').listeners.click();
  const notice = app.nodes.get('liveRegion');
  const undo = notice.children.find(kid => kid.textContent === '되돌리기');
  app.run("pushUndo({ label: '다른 작업', undo: async () => {}, redo: async () => {} });");
  await undo.listeners.click();
  assert.equal(sent.filter(call => call.url === '/api/workflow/review-restore').length, 0);
  assert.match(notice.textContent, /최근 작업부터 순서대로/);
  app.run('undoStack.pop();');
  await undo.listeners.click();
  assert.deepEqual(sent[sent.length - 1], { url: '/api/workflow/review-restore', body: { meetingId: 'mb1', drafts: ['mb1:stable:c'] } });
});

test('회의 초안: 빼기가 실패하면 초안은 그대로(되돌리기 기록·알림 `뺐어요` 없음)', async () => {
  const { app, draw } = meetingBoardClient();
  app.run('undoStack.length = 0;');
  app.context.fetch = async () => new Response('{"ok":false,"error":"이미 처리했거나 찾을 수 없는 항목이에요."}', { status: 400 });
  const box = draw();
  await nodeFind(nodeFindAll(box, 'd-draft')[0], 'd-dpull').listeners.click();
  assert.equal(app.run('undoStack.length'), 0);
  assert.doesNotMatch(app.nodes.get('liveRegion').textContent, /뺐어요/);
  assert.equal(app.run("wfDraftEdits.has('mb1:stable:a')"), true);
});

test('회의 정리 판 화면 규칙: 초안·결과 줄 사이 실선 없음, 세그먼트 사이 넓힘, 새 innerHTML 없음, 빈 칸 오류는 기존 오류 토큰', () => {
  const css = fs.readFileSync(path.join(__dirname, 'ui.css'), 'utf8');
  assert.doesNotMatch(css, /\.d-draft \+ \.d-draft \{[^}]*border-top/);
  assert.doesNotMatch(css, /\.d-mrow2 \+ \.d-mrow2 \{[^}]*border-top/);
  assert.match(css, /\.d-draft \.ct \{[^}]*gap: 6px 14px/);
  assert.match(css, /\.d-dtxt\[aria-invalid="true"\] \{ background: var\(--urgent-bg\); box-shadow: 0 0 0 1\.5px var\(--urgent\); \}/);
  const ui = fs.readFileSync(path.join(__dirname, 'meetings-ui.js'), 'utf8');
  const drafts = ui.slice(ui.indexOf('function panelMeetingDrafts'), ui.indexOf('// 항목 한 줄: 종류 | 문구 | 기한·상태.'));
  assert.doesNotMatch(drafts, /innerHTML/, '초안 판에는 innerHTML이 없다');
  assert.doesNotMatch(drafts, /비어 있는 문구가 있어요/, '옛 머리 오류 문구는 없다');
});

// ---------- 주간요약 다듬기 A(화면): 바꾼 소제목·제목, 새로 표시, 버튼 등급 ----------
const POLISH_ROWS = `[
  { id: 'a1', heading: '완료한 일', group: 'PAY-1 · 결제 리뉴얼', groupKey: 'jira:PAY-1', shownGroup: '결제 개편 1차', groupOrigin: 'PAY-1 · 결제 리뉴얼', text: '정산 배치 점검함', sourceIds: ['s1'], excluded: false },
  { id: 'a2', heading: '완료한 일', group: 'PAY-2 · 결제 서버', groupKey: 'jira:PAY-1', shownGroup: '결제 개편 1차', groupOrigin: 'PAY-1 · 결제 리뉴얼', text: '서버 로그 정리함', sourceIds: ['s2'], excluded: false, fresh: true },
  { id: 'b1', heading: '진행중', group: '운영툴', groupKey: 'group:운영툴', text: '권한 재정리', sourceIds: ['s3'], excluded: false, changed: true },
  { id: 'p1', heading: '다음 주 계획', group: '직접 작성', text: '합의하기', sourceIds: [], excluded: false }
]`;
test('다듬기 A: 문서·슬랙은 보이는 소제목 이름(shownGroup)으로 묶고, 지라 정보는 원래 티켓 이름에서 찾는다', () => {
  const app = reportClient();
  const sections = JSON.parse(app.run(`JSON.stringify(reportDocSections(${POLISH_ROWS}).map(s => [s.heading, s.groups.map(g => [g.group, g.key, g.origin, g.rows.map(r => r.id)])]))`));
  assert.deepEqual(sections, [
    ['완료한 일', [['결제 개편 1차', 'jira:PAY-1', 'PAY-1 · 결제 리뉴얼', ['a1', 'a2']]]],
    ['진행중', [['운영툴', 'group:운영툴', null, ['b1']]]],
  ], '묶음의 두 티켓이 바꾼 소제목 하나로 모이고, 저장된 이름(group)은 쓰지 않는다');
  const model = JSON.parse(app.run(`JSON.stringify(reportSlackModel({ weekKey: '2026-09-14', title: '결제 보고', rows: ${POLISH_ROWS} }))`));
  assert.equal(model.title, '결제 보고 (9/14~9/20)', '바꾼 제목 뒤에 기간이 붙는다');
  assert.deepEqual(model.sections[0].projects.map(p => [p.name, p.source, p.items.map(i => i.text)]),
    [['결제 개편 1차', 'PAY-1 · 결제 리뉴얼', ['정산 배치 점검함', '서버 로그 정리함']]]);
  assert.equal(JSON.parse(app.run(`JSON.stringify(reportSlackModel({ weekKey: '2026-09-14', rows: ${POLISH_ROWS} }))`)).title, '9월 3주차 (9/14~9/20)', '제목을 바꾸지 않았으면 예전 그대로');
  // 지라 정보: 보이는 이름이 아니라 원래 이름(`PAY-1 · …`)으로 찾는다.
  app.run(`jiraIssuesByKey = new Map([['PAY-1', { key: 'PAY-1', status: 'QA 대기', versions: [] }]]);`);
  const annotated = JSON.parse(app.run(`JSON.stringify(reportSlackModel({ weekKey: '2026-09-14', rows: ${POLISH_ROWS} }, { jira: true }).sections[0].projects[0].note)`));
  assert.equal(annotated, ' (QA 대기)');
  assert.equal(app.run("reportHeadingText('진행중')"), '진행 중', '문서의 상태 소제목은 띄어 쓴다');
  assert.equal(app.run("reportHeadingText('완료한 일')"), '완료한 일');
  assert.equal(app.run("reportSlackSectionLabel('진행 중')"), '[진행중]', '슬랙 글의 구역 제목은 사용자가 올리던 모양 그대로');
});
test('다듬기 A: 제외·이름 바꾸기·모두 확인의 알림은 무엇을 했는지 적고 되돌리기를 준다', () => {
  const notice = (rows, action) => {
    const app = reportClient();
    app.run("reportUndo.set('2026-09-14', 'tok')");
    app.run(`reportSavedNotice({ weekKey: '2026-09-14', draft: { revision: 1, rows: ${rows} } }, ${action})`);
    const region = app.nodes.get('liveRegion');
    return [region.textContent, region.children.map(kid => kid.textContent)];
  };
  assert.deepEqual(notice("[{ id: 'r1', excluded: true }]", "{ action: 'exclude', id: 'r1' }"), ['보고에서 뺐어요', ['되돌리기', '닫기']]);
  assert.deepEqual(notice("[{ id: 'r1', excluded: false }]", "{ action: 'exclude', id: 'r1' }"), ['보고에 되살렸어요', ['되돌리기', '닫기']]);
  assert.deepEqual(notice('[]', "{ action: 'rename', heading: '완료한 일', groupKey: 'jira:PAY-1', text: 'x' }"), ['소제목 이름을 바꿨어요', ['되돌리기', '닫기']]);
  assert.deepEqual(notice('[]', "{ action: 'retitle', text: 'x' }"), ['제목을 바꿨어요', ['되돌리기', '닫기']]);
  assert.deepEqual(notice('[]', "{ action: 'ackNew' }"), ['새로 들어온 것을 모두 확인했어요', ['되돌리기', '닫기']]);
});
test('다듬기 A: 모으기 모드에서 넣을 수 있는 줄에는 오른쪽에 읽기 전용 과녁 표시가 선다', () => {
  const app = reportClient();
  app.run(`
    renderReportDraft = () => {};
    item = { weekKey: '2026-09-14', draft: { revision: 1, rows: [
      { id: 'a', heading: '완료한 일', group: '가입 개선', text: '퍼널 정리', sourceIds: [], excluded: false },
      { id: 'b', heading: '완료한 일', group: '가입 개선', text: '문구 정리', sourceIds: [], excluded: false },
    ] } };
    reportNestParentId = 'a';
    host = document.createElement('div');
    reportSentenceRow(item, item.draft.rows[1], { host });
    reportSentenceRow(item, item.draft.rows[0], { host });
  `);
  const aim = JSON.parse(app.run(`JSON.stringify(host.children.map(line => {
    const mark = line.children.find(kid => kid.className === 'rp-aim');
    return mark ? [mark.children[0].textContent, mark.children[0].getAttribute('aria-hidden')] : null;
  }))`));
  assert.deepEqual(aim, [['아래로 넣기', 'true'], null], '기준 문장 자신에게는 과녁이 없다');
});

// ---------- 주간요약 v3(화면): 글자를 누르면 고치기 · ⋯ 하나 · 점만 파랗게 · 머리 한 줄 · 상태 줄 ----------
const V3_ITEM = `{ weekKey: '2026-09-14', draft: { revision: 1, since: { at: '2026-09-16T00:00:00Z', fresh: 1, changed: 1 }, rows: ${POLISH_ROWS} } }`;
function v3Line(app, index, itemCode = V3_ITEM) {
  return app.run(`(() => {
    renderReportDraft = () => {};
    item = ${itemCode};
    const host = document.createElement('div');
    reportSentenceRow(item, item.draft.rows[${index}], { host, newIds: new Set() });
    return host.children[0];
  })()`);
}
const v3Kid = (node, cls) => node.children.find(kid => String(kid && kid.className).split(' ').includes(cls));
test('v3: 상태 줄 글은 다듬은 뒤 새로·바뀐 줄이 있을 때만이고, 없으면 빈 글자(줄 자체가 없다)', () => {
  const app = reportClient();
  assert.equal(app.run('reportStatusText(null)'), '');
  assert.equal(app.run("reportStatusText({ at: 'x', fresh: 0, changed: 0 })"), '');
  assert.equal(app.run("reportStatusText({ at: 'x', fresh: 2, changed: 0 })"), '지난번 다듬은 뒤 2줄이 새로 들어왔어요');
  assert.equal(app.run("reportStatusText({ at: 'x', fresh: 2, changed: 1 })"), '지난번 다듬은 뒤 2줄이 새로 들어왔어요 · 1줄이 바뀌었어요');
  const top = app.run(`(() => { renderReportDraft = () => {}; const host = document.createElement('div'); reportTopBlock(${V3_ITEM}, host); return host; })()`);
  const line = top.children[0].children[0];
  assert.deepEqual([line.className, line.children[0].textContent, line.children[1].textContent, line.children[1].className],
    ['rp-status', '지난번 다듬은 뒤 1줄이 새로 들어왔어요 · 1줄이 바뀌었어요', '확인했어요', 'd-link']);
  const none = app.run(`(() => { const host = document.createElement('div'); reportTopBlock({ weekKey: 'W', draft: { rows: [], since: null } }, host); return host; })()`);
  assert.equal(none.children.length, 0, '새로 들어온 게 없으면 줄이 없다');
});
test('v3: 문장 줄은 글자가 곧 고치는 자리(Tab·Enter·Space)이고, 끝에는 ⋯ 하나뿐이며, 새로 들어온 줄은 점만 파랗다', () => {
  const app = reportClient();
  const line = v3Line(app, 1);
  const bullet = line.children[0];
  assert.deepEqual([bullet.className, bullet.getAttribute('aria-label'), bullet.title, bullet.getAttribute('role')], ['bu is-fresh', '새로 들어옴', '새로 들어옴', 'img']);
  const text = v3Kid(line, 'tx');
  const first = text.children[0];
  assert.deepEqual([first.className, first.tabIndex, first.getAttribute('role'), first.getAttribute('aria-label')], ['ln rp-edit', 0, 'button', '문장 고치기: 서버 로그 정리함']);
  assert.equal(text.children.some(kid => ['nw', 'edt', 'rv'].includes(kid.className)), false, '`새로`·`직접 수정`·`원본 확인 필요` 글자 표시는 없다');
  const acts = v3Kid(line, 'ac');
  assert.equal(acts.children.length, 1, '줄 끝 동작은 ⋯ 하나');
  assert.match(acts.children[0].className, /d-more/);
  assert.equal(line.children.some(kid => /d-btn/.test(String(kid.className))), false, '수정·제외 버튼이 없다');
  // Space로 편집 시작 → 입력칸 + `Enter 저장 · Esc 취소` 한 줄, 저장·취소 버튼 없음.
  first.listeners.keydown({ key: ' ', preventDefault() {} });
  assert.equal(app.run("reportEdits.get('2026-09-14:a2')"), '서버 로그 정리함');
  const editing = v3Line(app, 1);
  const box = v3Kid(editing, 'tx');
  assert.deepEqual(box.children.map(kid => kid.className), ['rp-ta', 'rp-help']);
  assert.match(box.children[1].textContent, /^Enter 저장 · Esc 취소/);
});
test('v3: 편집 중 Enter는 저장(Shift+Enter·한글 조합 중은 아님), Esc는 취소, 글이 그대로면 저장하지 않는다', async () => {
  const app = reportClient();
  app.run(`calls = []; reportChange = async (target, action) => { calls.push(action); }; reportEdits.set('2026-09-14:a1', '정산 배치 점검 끝냄');`);
  const input = v3Kid(v3Line(app, 0), 'tx').children[0];
  input.value = '정산 배치 점검 끝냄';
  const key = (k, extra = {}) => input.listeners.keydown({ key: k, preventDefault() {}, stopPropagation() {}, ...extra });
  key('Enter', { isComposing: true });
  key('Enter', { shiftKey: true });
  assert.deepEqual(JSON.parse(app.run('JSON.stringify(calls)')), [], '조합 중·Shift+Enter는 저장하지 않는다');
  key('Enter');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(JSON.parse(app.run('JSON.stringify(calls)')), [{ action: 'edit', id: 'a1', text: '정산 배치 점검 끝냄' }]);
  const again = v3Kid(v3Line(app, 0), 'tx').children[0];
  again.listeners.keydown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(app.run("reportEdits.has('2026-09-14:a1')"), false, 'Esc는 적던 글을 버리고 닫는다');
  app.run("reportEdits.set('2026-09-14:a1', '정산 배치 점검함')");
  v3Kid(v3Line(app, 0), 'tx').children[0].listeners.keydown({ key: 'Enter', preventDefault() {}, stopPropagation() {} });
  assert.equal(JSON.parse(app.run('JSON.stringify(calls)')).length, 1, '글이 그대로면 저장하지 않고 닫는다');
});
test('v3: 원본이 바뀐 줄은 끝에 작은 알약(기존 칩) 하나 — 누르면 제안과 두 선택지가 메뉴로 뜬다', () => {
  const app = reportClient();
  const item = `{ weekKey: '2026-09-14', draft: { revision: 1, rows: [
    { id: 'l1', heading: '완료한 일', group: '가입', text: '가입 문구 다듬음', sourceIds: ['s1'], excluded: false, locked: true, needsReview: true,
      suggestion: { text: '문구 검토함\\n후속 확인함', added: 1, missing: false, mixed: false } },
    { id: 'l2', heading: '완료한 일', group: '가입', text: '지워진 업무', sourceIds: ['s9'], excluded: false, locked: true, needsReview: true,
      suggestion: { text: '', added: 0, missing: true, mixed: false } } ] } }`;
  const pill = v3Kid(v3Line(app, 0, item), 'rp-pill');
  assert.deepEqual([pill.className, pill.textContent], ['d-chip rp-pill', '새 업무 1개']);
  const menu = JSON.parse(app.run(`JSON.stringify(reportSuggestionMenuSections(${item}, (${item}).draft.rows[0]).map(s => s.map(e => [e.label, !!e.disabled])))`));
  assert.deepEqual(menu, [[['제안: 문구 검토함', true]], [['제안대로 바꾸기', false], ['지금 문장 그대로 두기', false]]]);
  assert.equal(v3Kid(v3Line(app, 1, item), 'rp-pill').textContent, '원본 확인');
  const missing = JSON.parse(app.run(`JSON.stringify(reportSuggestionMenuSections(${item}, (${item}).draft.rows[1]).flat().map(e => e.label))`));
  assert.equal(missing.includes('제안대로 바꾸기'), false, '원본이 지워졌으면 제안대로 바꿀 수 없다');
});
test('v3: 소제목은 색 점 + 이름 글자(버튼)이고 원래 프로젝트는 풍선(title)으로만 — 고치는 중이면 입력칸과 안내 한 줄', () => {
  const app = reportClient();
  app.run(`calls = []; reportChange = async (target, action) => { calls.push(action); }; renderReportDraft = () => {};
    item = ${V3_ITEM}; groups = reportDocSections(item.draft.rows);`);
  const head = app.run(`reportGroupHead(item, '완료한 일', groups[0].groups[0], '결제 개편 1차')`);
  assert.deepEqual(head.children.map(kid => kid.className), ['d-pjdot', 'rp-rename']);
  assert.equal(head.children[1].title, '원래 프로젝트: 결제 리뉴얼 · 누르면 이름을 고쳐요');
  assert.equal(app.run(`reportGroupHead(item, '진행중', groups[1].groups[0], '운영툴').children[1].title`), '누르면 이름을 고쳐요');
  assert.deepEqual(app.run(`reportGroupHead(item, '진행중', { group: '운영툴', rows: [] }, '운영툴').children.map(kid => kid.className)`), ['nm'], '열쇠가 없는 옛 응답은 글자만');
  head.children[1].listeners.click();
  const box = app.run(`reportGroupHead(item, '완료한 일', groups[0].groups[0], '결제 개편 1차').children[1]`);
  assert.deepEqual([box.className, box.children.map(kid => kid.className), box.children[1].textContent], ['rp-ren', ['d-din', 'rp-help'], 'Enter 저장 · Esc 취소']);
  assert.equal(box.children[0].placeholder, '결제 리뉴얼');
  box.children[0].value = '결제 개편';
  box.children[0].listeners.keydown({ key: 'Enter', preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(JSON.parse(app.run('JSON.stringify(calls)')), [{ action: 'rename', heading: '완료한 일', groupKey: 'jira:PAY-1', text: '결제 개편' }]);
});
test('v3(99 리뷰③): 소제목은 보이는 이름이 아니라 프로젝트 열쇠로 묶는다 — 같은 이름의 다른 프로젝트는 따로 선다', () => {
  const app = reportClient();
  const rows = `[
    { id: 'x1', heading: '완료한 일', group: '운영', groupKey: 'group:운영', text: '가', sourceIds: [], excluded: false },
    { id: 'x2', heading: '완료한 일', group: 'OPS-1 · 운영', groupKey: 'jira:OPS-1', shownGroup: '운영', groupOrigin: 'OPS-1 · 운영툴', text: '나', sourceIds: [], excluded: false },
    { id: 'x3', heading: '완료한 일', group: '운영', groupKey: 'group:운영', text: '다', sourceIds: [], excluded: false }
  ]`;
  const groups = JSON.parse(app.run(`JSON.stringify(reportDocSections(${rows})[0].groups.map(g => [g.group, g.key, g.rows.map(r => r.id)]))`));
  assert.deepEqual(groups, [['운영', 'group:운영', ['x1', 'x3']], ['운영', 'jira:OPS-1', ['x2']]]);
  const slack = JSON.parse(app.run(`JSON.stringify(reportSlackModel({ weekKey: '2026-09-14', rows: ${rows} }).sections[0].projects.map(p => [p.name, p.items.map(i => i.text)]))`));
  assert.deepEqual(slack, [['운영', ['가', '다']], ['운영', ['나']]], '슬랙 글도 같은 규칙');
});
test('v3: 머리 ⋯에는 전체 업무 기록·제외한 문장·되돌리기·개수 한 줄이 들어가고, 고치는 중·모으기 중에는 복사가 3차다', () => {
  const app = reportClient();
  const labels = JSON.parse(app.run(`(() => {
    reportUndo.set('2026-09-14', 'tok');
    const item = { weekKey: '2026-09-14', draft: { rows: [ { id: 'a', excluded: false, sourceIds: ['s1'] }, { id: 'b', excluded: true, sourceIds: [] } ] } };
    return JSON.stringify(reportHeadMenuSections(item).map(s => s.map(e => [e.label, !!e.disabled])));
  })()`));
  assert.deepEqual(labels, [[['이 보고 확정하기', false]], [['전체 업무 기록 보기', false], ['제외한 문장 보기 · 1개', false], ['직전 변경 되돌리기', false]], [['보고 1문장 · 근거 업무 1개', true]]]);
  app.run("reportMode = 'records'");
  assert.equal(app.run("reportHeadMenuSections({ weekKey: 'W', draft: { rows: [] } })[1][0].label"), '보고로 돌아가기');
  app.run("reportMode = 'draft'");
  app.run("reportEdits.set('2026-09-14:a1', '고치는 중')");
  assert.equal(app.run("reportEditing('2026-09-14')"), true);
  app.run("reportEdits.clear(); reportEdits.set('2026-09-14:new', '계획 적는 중'); reportEdits.set('2026-09-14:plan-add:가입', '또')");
  assert.equal(app.run("reportEditing('2026-09-14')"), false, '다음 주 계획 입력칸에 적던 글은 고치는 중이 아니다');
});
test('v3: `다른 문장 아래로 넣기` — 옮길 문장에서 시작해 받을 문장을 한 번 누르면 nest 하나로 끝난다', () => {
  const app = reportClient();
  app.run(`
    calls = [];
    reportChange = async (target, action) => { calls.push(action); };
    renderReportDraft = () => {};
    escPush = () => {}; escDrop = () => {};
    item = { weekKey: '2026-09-14', draft: { revision: 1, rows: [
      { id: 'a', heading: '완료한 일', group: '가입 개선', text: '퍼널 정리', sourceIds: [], excluded: false },
      { id: 'b', heading: '완료한 일', group: '가입 개선', text: '문구 정리', sourceIds: [], excluded: false },
      { id: 'c', heading: '진행중', group: '가입 개선', text: '다른 상태', sourceIds: [], excluded: false },
    ] } };
    reportRenderedItem = item;
    reportPlaceStart(item, item.draft.rows[1]);
    host = document.createElement('div');
    item.draft.rows.forEach(row => reportSentenceRow(item, row, { host }));
  `);
  const lines = app.run('host.children');
  assert.deepEqual(lines.map(line => line.getAttribute('role') || null), ['button', null, null], '같은 상태의 받을 수 있는 문장만 눌린다');
  lines[0].listeners.click();
  assert.deepEqual(JSON.parse(app.run('JSON.stringify(calls)')), [{ action: 'nest', id: 'b', parentId: 'a' }]);
  assert.equal(app.run('reportPlaceId'), null, '한 번 넣으면 모드가 끝난다');
});
// ---------- 상세 카드 입력 다듬기: 날짜 값 = 누르는 자리 · 빈 날짜 한 조각 · 기다리는 답변 목록 · 빈 값 change 막기 ----------
function detailInputClient() {
  const app = workflowsClient();
  const sent = [];
  app.context.fetch = async (url, init) => {
    sent.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
    return new Response('{"ok":true}', { status: 200 });
  };
  app.run('requestAnimationFrame = () => 0; load = async () => {};');
  app.run(`workflowData = { items: [
    { id: 'ck1', type: 'check', status: 'to-do', description: '법무팀 약관 검토 회신', who: '민지' },
    { id: 'ck2', type: 'check', status: 'to-do', description: '데이터팀 지표 정의 확인', who: '준호' },
    { id: 'ck3', type: 'check', status: 'done', description: '끝난 확인', who: '' },
  ], meetings: [] }; wfIndexData();`);
  // 가짜 창에는 contains·replaceChild가 없다 — 기다리는 답변 칸이 쓰는 두 가지만 채운다.
  const patch = (node) => {
    node.contains = kid => node.children.includes(kid);
    node.replaceChild = (next, old) => { const at = node.children.indexOf(old); if (at >= 0) { node.children[at] = next; next.parent = node; } return old; };
    return node;
  };
  const dateField = (opts) => app.run(`(() => { var calls = []; var wrap = uiDateField(Object.assign({ onChange: v => calls.push(v) }, ${opts})); wrap.calls = calls; return wrap; })()`);
  return { app, sent, patch, dateField };
}
const keyEvent = (key, extra = {}) => ({ key, isComposing: false, stopped: 0, prevented: 0, preventDefault() { this.prevented += 1; }, stopPropagation() { this.stopped += 1; }, ...extra });

test('상세 카드: 업무 카드에 선택 상자(select)가 없다 — 기다리는 답변은 필드 격자의 값(프로젝트 다음), 구역은 결과 한 줄만', () => {
  const { app } = detailInputClient();
  const box = app.run(`(() => { const box = document.createElement('div'); panelTask({ item: { id: 't1', description: '업무', status: 'to-do', due: '2026-10-02', priority: 'medium' }, detail: { blockedBy: 'ck1' }, type: 'task' }, box); return box; })()`);
  assert.equal(nodeFind(box, 'd-msel'), null);
  const fields = nodeFind(box, 'd-fields');
  const terms = fields.children.filter((kid, at) => at % 2 === 0).map(kid => kid.textContent);
  assert.deepEqual(terms, ['언제 할지', '기한', '우선순위', '프로젝트', '기다리는 답변']);
  assert.equal(box.children.some(kid => kid.dataset && kid.dataset.sec === '기다리는 답변'), false, '구역은 없어졌다');
  assert.ok(box.children.some(kid => kid.dataset && kid.dataset.sec === '결과 한 줄'), '결과 한 줄 구역은 그대로');
  const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  for (const name of ['function panelTask(', 'function panelTaskNotes(', 'function panelWaitingCell(', 'function panelCheck(', 'function panelDateCell(']) {
    const at = source.indexOf(name);
    const fn = source.slice(at, source.indexOf('\n}\n', at));
    assert.doesNotMatch(fn, /createElement\('select'\)/, name);
  }
});

test('상세 날짜 칸: 얼굴 글자는 uiDueDetail 말투 그대로(급함 색은 글자에만), 달력 아이콘, 옆에 따로 적는 글자·입력칸은 없다', () => {
  const { app } = detailInputClient();
  const due = app.run("(() => { const d = new Date(); d.setDate(d.getDate() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })()");
  app.context.__due = due;
  const wrap = app.run("panelDateCell('기한', __due, () => {})");
  const want = app.run('uiDueDetail(__due)');
  assert.ok(String(wrap.className).split(' ').includes('d-dvalue'));
  assert.equal(wrap.children.length, 2, '값 버튼 + ✕ 둘뿐');
  const [face, clear] = wrap.children;
  assert.equal(face.className, 'd-dpick');
  assert.equal(face.children[0].textContent, want.text);
  assert.match(want.text, /기한 1일 지남$/);
  assert.equal(face.children[0].className, 'v k-neg');
  assert.equal(face.getAttribute('aria-label'), `기한 ${want.text} — 바꾸기`);
  assert.equal(face.children[1].className, 'cv cal');
  assert.equal(face.children[1].innerHTML, app.run("uiIcon('calendar')"));
  assert.equal(clear.className, 'd-iconbtn xs');
  assert.equal(clear.getAttribute('aria-label'), '기한 지우기');
  // 기한이 아닌 날짜(다시 확인할 날짜)는 날짜만
  const follow = app.run("panelDateCell('다시 확인할 날짜', '2026-10-02', () => {}, false)");
  assert.equal(follow.children[0].children[0].textContent, '10월 2일 (금)');
  assert.equal(follow.children[0].children[0].className, 'v');
  // 옛 형식(날짜가 아닌 글자)은 원문을 보이고 말투를 붙이지 않는다
  const odd = app.run("panelDateCell('기한', '곧', () => {})");
  assert.equal(odd.children[0].children[0].textContent, '곧');
});

test('상세 날짜 칸: 빈 날짜는 회색 `없음` 한 조각(✕·`+ 기한` 없음), 누르면 그 자리 입력칸', () => {
  const { dateField } = detailInputClient();
  const wrap = dateField("{ value: '', label: '기한', shown: true, face: 'pick' }");
  assert.equal(wrap.children.length, 1);
  const face = wrap.children[0];
  assert.equal(face.className, 'd-dpick');
  assert.equal(face.children[0].textContent, '없음');
  assert.equal(face.children[0].className, 'v k-mute');
  assert.equal(face.getAttribute('aria-label'), '기한 없음 — 정하기');
  face.listeners.click();
  assert.equal(wrap.children[0].type, 'date');
  assert.equal(wrap.children[0].focused, true);
  assert.equal(wrap.children.length, 1, '값이 없으면 ✕도 없다');
});

test('상세 날짜 칸: 빈 값 change·Enter는 저장하지 않고 떠나면 원래 글자로, 치는 중 change는 Enter·Tab까지 기다림, 같은 날짜는 안 보냄, Esc는 입력칸만', () => {
  const { dateField } = detailInputClient();
  const wrap = dateField("{ value: '2026-10-02', label: '기한', shown: true, face: 'pick' }");
  wrap.children[0].listeners.click();
  let input = wrap.children[0];
  input.value = '';
  input.listeners.change();
  input.listeners.keydown(keyEvent('Enter'));
  assert.deepEqual([...wrap.calls], [], '비운 칸은 저장하지 않는다');
  assert.equal(wrap.children[0], input, '입력칸은 그대로');
  wrap.listeners.focusout({ relatedTarget: { other: true } });
  assert.equal(wrap.children[0].className, 'd-dpick', '떠나면 원래 글자로');
  assert.equal(wrap.children[0].children[0].textContent, '10월 2일 (금)');
  assert.deepEqual([...wrap.calls], []);
  // 달력이 열려 잠깐 비는 초점(relatedTarget 없음)에는 닫지 않는다
  wrap.children[0].listeners.click();
  input = wrap.children[0];
  wrap.listeners.focusout({ relatedTarget: null });
  assert.equal(wrap.children[0], input);
  // 입력칸 → 옆의 ✕로 Tab(같은 칸 안)은 떠난 것이 아니다
  wrap.contains = kid => wrap.children.includes(kid);
  wrap.listeners.focusout({ relatedTarget: wrap.children[1] });
  assert.equal(wrap.children[0], input);
  // 숫자를 치는 동안의 change는 확정하지 않는다 → Enter로 확정
  input.listeners.keydown(keyEvent('1'));
  input.value = '2026-01-02';
  input.listeners.change();
  assert.deepEqual([...wrap.calls], []);
  input.value = '2026-10-05';
  input.listeners.keydown(keyEvent('Enter'));
  assert.deepEqual([...wrap.calls], ['2026-10-05']);
  assert.equal(wrap.children[0].children[0].textContent, '10월 5일 (월)');
  assert.equal(wrap.children[0].focused, true, 'Enter 뒤 초점은 값 글자');
  // 같은 날짜: 보내지 않고 글자로만
  wrap.children[0].listeners.click();
  input = wrap.children[0];
  input.listeners.change();
  assert.deepEqual([...wrap.calls], ['2026-10-05']);
  assert.equal(wrap.children[0].className, 'd-dpick');
  // 달력에서 고른 change(키 입력과 떨어진)는 곧바로 확정
  wrap.children[0].listeners.click();
  input = wrap.children[0];
  input.value = '2026-10-07';
  input.listeners.change();
  assert.deepEqual([...wrap.calls], ['2026-10-05', '2026-10-07']);
  // Tab(다른 곳으로 초점)으로 확정
  wrap.children[0].listeners.click();
  input = wrap.children[0];
  input.listeners.keydown(keyEvent('2'));
  input.value = '2026-10-08';
  wrap.listeners.focusout({ relatedTarget: { other: true } });
  assert.deepEqual([...wrap.calls], ['2026-10-05', '2026-10-07', '2026-10-08']);
  // Esc: 입력칸만 닫고 문서의 Esc(카드 닫기)로 번지지 않는다
  wrap.children[0].listeners.click();
  input = wrap.children[0];
  const esc = keyEvent('Escape');
  input.listeners.keydown(esc);
  assert.equal(esc.stopped, 1);
  assert.equal(wrap.children[0].className, 'd-dpick');
  assert.equal(wrap.children[0].focused, true);
  // 한글 조합 중 Esc는 넘긴다
  wrap.children[0].listeners.click();
  input = wrap.children[0];
  const composing = keyEvent('Escape', { isComposing: true });
  input.listeners.keydown(composing);
  assert.equal(composing.stopped, 0);
  assert.equal(wrap.children[0], input);
  // ✕만 지운다
  const clear = wrap.children.find(kid => kid.className === 'd-iconbtn xs');
  clear.listeners.click();
  assert.deepEqual([...wrap.calls].slice(-1), [null]);
  assert.equal(wrap.children[0].children[0].textContent, '없음');
});

test('uiDateField 기본 모양(목록·메뉴의 날짜 칸)도 빈 값 change는 저장하지 않고, 떠나면 칸에 원래 날짜를 되돌린다', () => {
  const { dateField } = detailInputClient();
  const wrap = dateField("{ value: '2026-10-02', label: '기한' }");
  const input = wrap.children[0];
  assert.equal(input.type, 'date');
  input.value = '';
  input.listeners.change();
  assert.deepEqual([...wrap.calls], []);
  input.listeners.blur();
  assert.equal(input.value, '2026-10-02');
  input.value = '2026-10-03';
  input.listeners.change();
  assert.deepEqual([...wrap.calls], ['2026-10-03']);
});

test('상세 기다리는 답변: 값은 `설명 · 누구에게`, 누르면 그 자리 목록(열린 확인 대기 + 맨 끝 `연결 끊기`), 고르기·끊기가 blockedBy를 보낸다', async () => {
  const { app, sent, patch } = detailInputClient();
  const cell = patch(app.run("panelWaitingCell({ id: 't1' }, { blockedBy: 'ck1' })"));
  const button = cell.children[0];
  assert.equal(button.className, 'd-dpick');
  assert.equal(button.getAttribute('aria-haspopup'), 'listbox');
  assert.equal(button.children[0].textContent, '법무팀 약관 검토 회신 · 민지');
  button.listeners.click({ stopPropagation() {} });
  const picker = cell.children[0];
  assert.equal(picker.className, 'd-gpick');
  const list = picker.children.find(kid => kid.className === 'd-gplist');
  assert.equal(list.getAttribute('aria-label'), '기다리는 답변 고르기');
  assert.deepEqual(list.children.map(kid => kid.children.map(part => part.textContent).join('|')), ['법무팀 약관 검토 회신|민지', '데이터팀 지표 정의 확인|준호', '연결 끊기'],
    '해결된 확인 대기는 연결 대상일 때만 선다');
  assert.equal(list.children[0].getAttribute('aria-selected'), 'true');
  list.children[1].listeners.click({ stopPropagation() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent.map(call => [call.url, call.body]), [['/api/workflow/item', { id: 't1', blockedBy: 'ck2' }]]);
  assert.equal(cell.children[0], button, '고르면 값 자리로 돌아온다');
  assert.equal(button.children[0].textContent, '데이터팀 지표 정의 확인 · 준호');
  assert.equal(button.focused, true);
  // 끊기
  button.listeners.click({ stopPropagation() {} });
  const again = cell.children[0].children.find(kid => kid.className === 'd-gplist');
  const cut = again.children[again.children.length - 1];
  assert.equal(cut.children[0].textContent, '연결 끊기');
  cut.listeners.click({ stopPropagation() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent[1].body, { id: 't1', blockedBy: null });
  assert.equal(button.children[0].textContent, '연결 없음');
  assert.equal(button.children[0].className, 'v k-mute');
});

test('상세 기다리는 답변: 대상이 사라지면 `삭제된 확인 대기` + 안내 줄, 해결된 대상은 `해결됨 · `, 확인 대기가 없으면 한 줄 안내', () => {
  const { app, patch } = detailInputClient();
  const gone = patch(app.run("panelWaitingCell({ id: 't1' }, { blockedBy: 'nope' })"));
  assert.equal(gone.children[0].children[0].textContent, '삭제된 확인 대기');
  assert.equal(gone.children[0].children[0].className, 'v k-mute');
  assert.equal(gone.children[1].textContent, '연결했던 확인 대기가 삭제됐어요.');
  const solved = patch(app.run("panelWaitingCell({ id: 't1' }, { blockedBy: 'ck3' })"));
  assert.equal(solved.children[0].children[0].textContent, '해결됨 · 끝난 확인');
  app.run('workflowData = { items: [], meetings: [] }; wfIndexData();');
  const empty = patch(app.run("panelWaitingCell({ id: 't1' }, null)"));
  empty.children[0].listeners.click({ stopPropagation() {} });
  const none = empty.children[0].children.find(kid => kid.className === 'd-gpnone');
  assert.equal(none.textContent, '열린 확인 대기가 없어요');
  assert.equal(none.hidden, false);
  const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  const fn = source.slice(source.indexOf('function panelWaitingCell('), source.indexOf('\n}\n', source.indexOf('function panelWaitingCell(')));
  assert.match(fn, /placeholder: '확인 대기 찾기'/);
  assert.match(fn, /emptyText: '찾는 확인 대기가 없어요'/);
  assert.equal((fn.match(/innerHTML/g) || []).length, 1, '아이콘 한 곳(uiIcon)뿐');
});

test('회의 정리 판 날짜 칸(shown) 세 가지: ① 고르면 글자 버튼으로 ② 칩 안 ✕로 지우기 ③ 입력칸을 열고 고르지 않고 벗어나도 입력칸이 그대로', () => {
  const { draw } = meetingBoardClient();
  const box = draw();
  const card = nodeFindAll(box, 'd-draft')[0];
  const field = nodeFind(card, 'd-datefield');
  // ③ 열고 벗어나기 — 다시 그리지 않는다(달력이 곧바로 닫히지 않게). 빈 값으로 벗어나면 원래 날짜를 칸에 되돌릴 뿐.
  nodeFind(card, 'is-shown').listeners.click();
  const input = field.children[0];
  assert.equal(input.type, 'date');
  input.listeners.blur({ relatedTarget: { other: true } });
  assert.equal(field.children[0], input, '입력칸이 그대로 남는다');
  input.value = '';
  input.listeners.change();
  assert.equal(field.children[0], input, '빈 값 change는 무시');
  input.listeners.blur({ relatedTarget: null });
  assert.equal(input.value, '2026-10-02');
  // ① 고르면 앱 날짜 글자 버튼으로
  input.value = '2026-10-03';
  input.listeners.change();
  const face = field.children[0];
  assert.equal(face.className, 'd-dateinput is-shown');
  assert.equal(face.textContent, '10월 3일 (토)');
  // ② ✕(날짜 지우기)로 지우기는 계속 된다
  const clear = field.children.find(kid => kid.className === 'd-iconbtn sm');
  assert.equal(clear.getAttribute('aria-label'), '기한 지우기');
  clear.listeners.click();
  assert.equal(field.children.length, 1);
  assert.equal(field.children[0].textContent, '+ 기한');
});

test('상세 카드 화면 규칙: 누구에게 조용한 입력, 결정 내용 두 줄, 작은 ✕, 달력 아이콘은 돌리지 않는다', () => {
  const css = fs.readFileSync(path.join(__dirname, 'ui.css'), 'utf8');
  assert.match(css, /\.d-fields \.d-mtext \{[^}]*height: var\(--h-sm\);[^}]*background: none;/);
  assert.match(css, /\.d-fields \.d-mtext:hover \{ background: var\(--hover\); \}/);
  assert.match(css, /\.d-dsec\[data-sec="내용"\] \.d-din \{ min-height: 62px; \}/);
  assert.match(css, /\.d-iconbtn\.xs \{ width: 28px; height: var\(--h-sm\); \}/);
  assert.match(css, /\.d-dpick \.cv\.cal \.d-i \{ transform: none; \}/);
  assert.match(css, /\.d-dvalue \{ display: flex; align-items: center; gap: 4px; flex-wrap: nowrap;/);
});

test('글자 토큰: --fs-lg는 16px — ≤520px 입력칸(iOS 확대 방지)이 이 값에 묶여 있다', () => {
  const css = fs.readFileSync(path.join(__dirname, 'ui.css'), 'utf8');
  assert.match(css, /--fs-lg: 16px;/);
});

// ---------- 주간요약 다듬기 B(화면): 칸마다 `+ 한 줄 추가` · 완료 제안 알약 · 확정 ----------
const B_ROWS = `[
  { id: 'd1', heading: '완료한 일', group: '가입', groupKey: 'group:가입', text: '문구 검토함', sourceIds: ['s1'], excluded: false },
  { id: 'g1', heading: '진행중', group: 'PAY-1 · 결제 리뉴얼', groupKey: 'jira:PAY-1', text: '영수증 메일 발송 시점 정리 중', sourceIds: ['s2'], excluded: false, locked: true,
    needsReview: true, completable: true, suggestion: { text: '영수증 메일 발송 시점 정리함', added: 0, missing: false, mixed: false } },
  { id: 'w1', heading: '완료한 일', group: '가입', groupKey: 'group:가입', text: '가입 카피 전달함', sourceIds: ['s3'], excluded: false, locked: true, origin: 'weekly' },
  { id: 'm1', heading: '완료한 일', group: '여러 프로젝트', groupKey: 'name:여러 프로젝트', text: '요약', sourceIds: [], excluded: false, manual: true }
]`;
const B_ITEM = `{ weekKey: '2026-09-14', draft: { revision: 1, rows: ${B_ROWS} } }`;
test('다듬기 B(개편 A): 진행 중 줄의 업무가 끝나면 줄 끝 초록 글자 버튼 `끝났어요 · 완료로` 하나 — 누르면 complete를 보낸다', async () => {
  const app = reportClient();
  app.run('calls = []; reportChange = async (target, action) => { calls.push(action); };');
  const move = v3Kid(v3Line(app, 1, B_ITEM), 'rp-end');
  assert.equal(move.className, 'rp-end is-ok');
  assert.equal(move.textContent, '끝났어요 · 완료로');
  assert.equal(move.type, 'button');
  assert.equal(move.children.length, 0, '누르는 자리는 한 곳');
  assert.match(move.getAttribute('aria-label'), /완료한 일로 옮기기$/);
  move.listeners.click({ stopPropagation() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(JSON.parse(app.run('JSON.stringify(calls)')), [{ action: 'complete', id: 'g1' }]);
  assert.equal(v3Kid(v3Line(app, 0, B_ITEM), 'rp-end'), undefined, '그 줄에만 선다');
});
test('다듬기 B: `+ 한 줄 추가`는 완료한 일 칸(지난 주 포함)·이번 주 진행 중 칸의 프로젝트 소제목에만, 모으기 중에는 없다', () => {
  const app = reportClient();
  app.run("reportPlanIsCurrentWeek = weekKey => weekKey === '2026-09-14';");
  const can = (heading, key, week = '2026-09-14') => app.run(`reportCanAddLine({ weekKey: '${week}' }, '${heading}', { key: ${JSON.stringify(key)} })`);
  assert.equal(can('완료한 일', 'group:가입'), true);
  assert.equal(can('진행중', 'jira:PAY-1'), true);
  assert.equal(can('완료한 일', 'ungrouped'), true);
  assert.equal(can('진행중', 'jira:PAY-1', '2026-09-07'), false, '지난 주 진행 중 칸은 없다');
  assert.equal(can('완료한 일', 'group:가입', '2026-09-07'), true, '지난 주 완료한 일 칸은 있다');
  assert.equal(can('새로 정해진 것', 'group:가입'), false, '결정 칸은 없다');
  assert.equal(can('확인 대기', 'group:가입'), false);
  assert.equal(can('완료한 일', 'name:여러 프로젝트'), false, '프로젝트 열쇠가 없는 소제목은 없다');
  assert.equal(can('완료한 일', null), false);
  app.run("reportNestParentId = 'x'");
  assert.equal(can('완료한 일', 'group:가입'), false, '모으기 중에는 없다');
  app.run("reportNestParentId = null; reportMode = 'records'");
  assert.equal(can('완료한 일', 'group:가입'), false);
});
test('다듬기 B: `+ 한 줄 추가` — 누르면 그 자리 입력칸과 안내 한 줄, 빈 Enter는 아무 일 없음, Enter는 요청 id와 함께 addLine, Esc는 닫기', async () => {
  const app = reportClient();
  app.context.crypto = globalThis.crypto;
  app.run(`calls = []; reportChange = async (target, action, notice, options) => { calls.push([action, !!(options && options.key)]); };
    renderReportDraft = () => {}; reportPlanIsCurrentWeek = weekKey => weekKey === '2026-09-14';
    item = ${B_ITEM}; group = { group: '가입', key: 'group:가입', rows: [] };`);
  const draw = () => app.run(`(() => { const host = document.createElement('div'); reportAddLineRow(item, '완료한 일', group, '가입 개편', host); return host.children[0]; })()`);
  const closed = draw();
  assert.equal(closed.className, 'rp-s is-add');
  assert.deepEqual([closed.children[0].textContent, closed.children[0].getAttribute('aria-hidden')], ['+', 'true']);
  const open = v3Kid(closed, 'tx').children[0];
  assert.deepEqual([open.type, open.className, open.textContent, open.getAttribute('aria-label')], ['button', 'rp-pjadd', '한 줄 추가', '완료한 일 · 가입 개편에 한 줄 추가']);
  open.listeners.click();
  assert.equal(app.run("reportEdits.get('2026-09-14:addline:완료한 일|group:가입')"), '');
  assert.equal(app.run("reportEditing('2026-09-14')"), false, '열어만 둔 빈 칸은 고치는 중이 아니다(복사를 막지 않는다)');
  const box = v3Kid(draw(), 'tx');
  assert.deepEqual(box.children.map(kid => kid.className), ['rp-ta', 'rp-help']);
  assert.equal(box.children[1].textContent, 'Enter 추가 · 이번 주에 끝낸 업무로도 남아요 (가입 개편)');
  const input = box.children[0];
  const key = (k, extra = {}) => input.listeners.keydown({ key: k, preventDefault() {}, stopPropagation() {}, ...extra });
  input.value = '   '; key('Enter');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(JSON.parse(app.run('JSON.stringify(calls)')), [], '빈 문장 Enter는 아무 일 없음');
  input.value = '카피 최종본\n전달함'; input.listeners.input();
  assert.equal(input.value, '카피 최종본 전달함', '줄바꿈은 빈칸으로(업무 제목은 한 줄)');
  assert.equal(app.run("reportEditing('2026-09-14')"), true, '적기 시작하면 고치는 중');
  key('Enter', { isComposing: true });
  key('Enter');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(JSON.parse(app.run('JSON.stringify(calls)')), [[{ action: 'addLine', heading: '완료한 일', groupKey: 'group:가입', text: '카피 최종본 전달함' }, true]]);
  key('Escape');
  assert.equal(app.run("reportEdits.has('2026-09-14:addline:완료한 일|group:가입')"), false);
  // 진행 중 칸·지난 주 칸의 안내
  assert.equal(app.run("reportAddLineHint({ weekKey: '2026-09-14' }, '진행중', '결제')"), 'Enter 추가 · 진행 중인 업무로도 남아요 (결제)');
  assert.equal(app.run("reportAddLineHint({ weekKey: '2026-09-07' }, '완료한 일', '결제')"), 'Enter 추가 · 그 주 금요일에 끝낸 업무로도 남아요 (결제)');
});
test('다듬기 B: 같은 글을 다시 보내면(응답을 못 받음) 같은 요청 id, 성공하면 id를 버린다', async () => {
  const app = reportClient();
  app.context.crypto = globalThis.crypto;
  app.run(`keys = []; fail = true;
    reportChange = async (target, action, notice, options) => { keys.push(options.key); if (fail) throw new Error('끊김'); };`);
  const send = () => app.run(`reportAddLineSubmit({ weekKey: 'W' }, '완료한 일', { key: 'group:가입' }, 'W:addline:완료한 일|group:가입', '같은 글')`);
  await assert.rejects(send());
  await assert.rejects(send());
  app.run('fail = false');
  await send();
  await send();
  const keys = JSON.parse(app.run('JSON.stringify(keys)'));
  assert.equal(keys[0], keys[1]);
  assert.equal(keys[1], keys[2], '성공한 요청까지 같은 id');
  assert.notEqual(keys[2], keys[3], '성공한 뒤 같은 글을 또 쓰면 새 줄이다');
  assert.match(keys[0], /^[a-zA-Z0-9-]{16,100}$/);
});
test('다듬기 B(개편 A): 확정한 주의 상태 줄은 회색 글 한 줄 `M/D에 확정했어요`(+ 새로 N줄, 버튼 없음), 머리 ⋯ 첫 묶음은 `확정 풀기`', () => {
  const app = reportClient();
  const at = '2026-09-17T03:00:00.000Z';
  assert.equal(app.run(`reportConfirmedText({ at: '${at}', pending: 0, pendingDone: 0 })`), '9/17에 확정했어요');
  assert.equal(app.run(`reportConfirmedText({ at: '${at}', pending: 2, pendingDone: 2 })`), '9/17에 확정했어요 · 그 뒤 2줄이 새로 끝났어요');
  assert.equal(app.run(`reportConfirmedText({ at: '${at}', pending: 2, pendingDone: 1 })`), '9/17에 확정했어요 · 그 뒤 2줄이 새로 들어왔어요');
  const top = app.run(`(() => { renderReportDraft = () => {}; const host = document.createElement('div');
    reportTopBlock({ weekKey: '2026-09-14', draft: { rows: [], since: { at: 'x', fresh: 3, changed: 0 }, confirmed: { at: '${at}', pending: 1, pendingDone: 1 } } }, host); return host; })()`);
  const line = top.children[0].children[0];
  assert.deepEqual([line.className, line.children.map(kid => kid.textContent)], ['rp-status is-quiet', ['9/17에 확정했어요 · 그 뒤 1줄이 새로 끝났어요']], '확정하면 새로 표시 줄 대신 이 한 줄 — 넣기는 슬랙 카드 접힘 줄에서');
  const quiet = app.run(`(() => { const host = document.createElement('div');
    reportTopBlock({ weekKey: '2026-09-14', draft: { rows: [], confirmed: { at: '${at}', pending: 0, pendingDone: 0 } } }, host); return host; })()`);
  assert.deepEqual(quiet.children[0].children[0].children.map(kid => kid.textContent), ['9/17에 확정했어요'], '새로 없으면 버튼 없이 한 줄');
  const menu = JSON.parse(app.run(`JSON.stringify(reportHeadMenuSections({ weekKey: 'W', draft: { rows: [], confirmed: { at: '${at}', pending: 0 } } })[0].map(e => e.label))`));
  assert.deepEqual(menu, ['확정 풀기']);
});
test('다듬기 B: 확정·완료로·한 줄 추가·보고에 넣기의 알림은 무엇을 했는지 적고 되돌리기를 준다', () => {
  const notice = (rows, action) => {
    const app = reportClient();
    app.run("reportUndo.set('2026-09-14', 'tok')");
    app.run(`reportSavedNotice({ weekKey: '2026-09-14', draft: { revision: 1, rows: ${rows} } }, ${action})`);
    const region = app.nodes.get('liveRegion');
    return [region.textContent, region.children.map(kid => kid.textContent)];
  };
  assert.deepEqual(notice(B_ROWS, "{ action: 'complete', id: 'g1' }"), ['「영수증 메일 발송 시점 정리 중」 완료한 일로 옮겼어요', ['되돌리기', '닫기']]);
  assert.deepEqual(notice('[]', "{ action: 'addLine', heading: '완료한 일', groupKey: 'group:가입', text: 'x' }"), ['보고에 한 줄 더했어요 · 업무에도 남겼어요', ['되돌리기', '닫기']]);
  assert.deepEqual(notice('[]', "{ action: 'confirm' }"), ['이 보고를 확정했어요', ['되돌리기', '닫기']]);
  assert.deepEqual(notice('[]', "{ action: 'unconfirm' }"), ['확정을 풀었어요', ['되돌리기', '닫기']]);
  assert.deepEqual(notice('[]', "{ action: 'pullNew' }"), ['새로 들어온 줄을 보고에 넣었어요', ['되돌리기', '닫기']]);
});
test('다듬기 B: 확정은 고치는 중이면 막고, 아니면 confirm을 보낸다 · 사람이 더한 줄의 ⋯에는 `원래 문장으로`가 없다', async () => {
  const app = reportClient();
  app.run('calls = []; reportChange = async (target, action) => { calls.push(action); };');
  app.run("reportEdits.set('2026-09-14:d1', '고치는 중')");
  await app.run("reportConfirm({ weekKey: '2026-09-14' }, true)");
  assert.deepEqual(JSON.parse(app.run('JSON.stringify(calls)')), []);
  assert.match(app.nodes.get('liveRegion').textContent, /고치는 중인 글이 있어요/);
  app.run('reportEdits.clear()');
  await app.run("reportConfirm({ weekKey: '2026-09-14' }, true)");
  await app.run("reportConfirm({ weekKey: '2026-09-14' }, false)");
  assert.deepEqual(JSON.parse(app.run('JSON.stringify(calls)')), [{ action: 'confirm' }, { action: 'unconfirm' }]);
  const labels = JSON.parse(app.run(`JSON.stringify(reportSentenceMenuSections(${B_ITEM}, (${B_ITEM}).draft.rows[2]).flat().map(e => e.label))`));
  assert.equal(labels.includes('원래 문장으로'), false);
});
test('다듬기 B: 슬랙용으로 복사한 뒤 알림에 `이대로 확정`(확정한 주는 알림만)', async () => {
  const app = reportClient();
  app.run(`calls = []; notices = []; reportChange = async (target, action) => { calls.push(action); }; reportSlackCopy = async () => {}; usageTick = () => {};
    showNotice = (message, error, retry, action) => { notices.push([message, action ? action.label : null]); lastAction = action; };`);
  const copyButton = confirmed => app.run(`(() => { const host = document.createElement('div');
    reportDocHead({ weekKey: '2026-09-14', draft: { rows: [], confirmed: ${confirmed} } }, host);
    const acts = host.children[0].children.find(kid => kid.className === 'rp-acts');
    return acts.children.find(kid => kid.textContent === '슬랙용으로 복사'); })()`);
  await copyButton('null').listeners.click();
  assert.deepEqual(JSON.parse(app.run('JSON.stringify(notices)')), [['슬랙에 붙여 넣을 수 있게 복사했어요', '이대로 확정']]);
  await app.run('lastAction.onClick()');
  assert.deepEqual(JSON.parse(app.run('JSON.stringify(calls)')), [{ action: 'confirm' }]);
  await copyButton("{ at: '2026-09-17T00:00:00Z', pending: 0 }").listeners.click();
  assert.deepEqual(JSON.parse(app.run('JSON.stringify(notices)'))[1], ['슬랙에 붙여 넣을 수 있게 복사했어요', null], '확정한 주는 알림만');
});
test('다듬기 B(개편 A): `끝났어요 · 완료로`는 바탕 없는 --success 글자(상태 점 --success-dot 아님), 주차 목록에는 다음 버전 자리 둘(지금은 비어 있음)', () => {
  const css = fs.readFileSync(path.join(__dirname, 'report-ui.css'), 'utf8');
  const done = css.slice(css.indexOf('.rp-s .rp-end.is-ok {'), css.indexOf('/* `확인 필요 ›`로 옮겨 온 줄'));
  assert.match(done, /background: none/);
  assert.match(done, /color: var\(--success\)/);
  assert.doesNotMatch(done, /--success-dot|--success-bg/);
  const app = reportClient();
  assert.equal(app.run("reportWeekRowEnd({ weekKey: 'W' })"), null);
  assert.equal(app.run('reportWeeksFoot([])'), null);
  const main = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  assert.match(main, /reportWeekRowEnd\(item\)/);
  assert.match(main, /reportWeeksFoot\(items\)/);
  const ui = fs.readFileSync(path.join(__dirname, 'report-ui.js'), 'utf8');
  const added = ui.slice(ui.indexOf('// ---------- 칸마다 `+ 한 줄 추가`(다듬기 B)'), ui.indexOf('// 계획 문장에 붙일 프로젝트 — 앱의 다른 프로젝트 선택과 같은 목록'));
  assert.ok(added.length > 200);
  assert.doesNotMatch(added, /innerHTML/);
});
test('다듬기 B 검수②③: 추가 입력칸은 크기 조절 없음, `+ 한 줄 추가`는 묶음 hover·focus-within에서만(opacity — Tab은 늘 닿는다), 빈 묶음·열린 칸·손가락 화면은 늘', () => {
  const css = fs.readFileSync(path.join(__dirname, 'report-ui.css'), 'utf8');
  assert.match(css, /\.rp-s\.is-add \.rp-ta \{[^}]*resize: none/);
  assert.match(css, /\.rp-grp \.rp-s\.is-add \{ opacity: 0;/);
  assert.match(css, /\.rp-grp:hover \.rp-s\.is-add, \.rp-grp:focus-within \.rp-s\.is-add, \.rp-grp\.is-empty \.rp-s\.is-add, \.rp-s\.is-add\.is-open \{ opacity: 1; \}/);
  assert.match(css, /@media \(hover: none\) \{ \.rp-grp \.rp-s\.is-add \{ opacity: 1; \} \}/);
  assert.doesNotMatch(css.slice(css.indexOf('.rp-grp .rp-s.is-add')), /^[^\n]*is-add[^\n]*display: none/m, 'display:none으로 숨기지 않는다');
  const app = reportClient();
  app.run(`renderReportDraft = () => {}; item = { weekKey: '2026-09-14', draft: { rows: [] } }; reportEdits.set('2026-09-14:addline:완료한 일|group:가입', '');`);
  const open = app.run(`(() => { const host = document.createElement('div'); reportAddLineRow(item, '완료한 일', { key: 'group:가입' }, '가입', host); return host.children[0].className; })()`);
  assert.equal(open, 'rp-s is-add is-open');
});
test('주차 번호는 목요일 기준 — 목요일이 속한 달·연도의 N주차(N = 그 달에서 목요일이 몇 번째), 바꾼 제목은 그대로', () => {
  const app = reportClient();
  const week = key => app.run(`formatWeekLabel('${key}').week`);
  assert.equal(week('2026-09-28'), '10월 1주차', '9/28~10/4: 목요일 10/1');
  assert.equal(week('2026-09-21'), '9월 4주차', '9/21~9/27: 목요일 9/24');
  assert.equal(week('2026-10-26'), '10월 5주차', '10/26~11/1: 목요일 10/29 — 다섯째 주');
  assert.equal(week('2026-06-01'), '6월 1주차', '달 첫날이 월요일인 주');
  assert.equal(week('2026-06-29'), '7월 1주차', '6/29~7/5: 목요일 7/2');
  assert.equal(week('2025-12-29'), '1월 1주차', '12/29~1/4: 목요일이 이듬해 1/1');
  assert.equal(week('2026-12-28'), '12월 5주차', '12/28~1/3: 목요일 12/31 — 그해 12월');
  assert.equal(app.run(`reportSlackTitle('2025-12-29')`), '1월 1주차 (12/29~1/4)');
  assert.equal(app.run(`reportSlackTitle('2026-09-28', '결제 보고')`), '결제 보고 (9/28~10/4)', '사람이 바꾼 제목은 그대로');
});
test('다듬기 B(99 리뷰): 같은 id가 다른 내용이라 거절되면 id·적던 글을 버리고 목록을 다시 받는다(다시 보내지 않아 두 줄이 되지 않는다)', async () => {
  const app = reportClient();
  app.context.crypto = globalThis.crypto;
  app.run(`keys = []; loads = 0; load = async () => { loads += 1; };
    reportChange = async (target, action, notice, options) => { keys.push(options.key); throw new Error('다른 내용으로 같은 요청을 다시 쓸 수 없어요.'); };
    reportEdits.set('W:addline:완료한 일|group:가입', '같은 글');`);
  const send = () => app.run(`reportAddLineSubmit({ weekKey: 'W' }, '완료한 일', { key: 'group:가입' }, 'W:addline:완료한 일|group:가입', '같은 글')`);
  await assert.rejects(send(), /이미 더해 둔 줄이에요/);
  assert.equal(app.run('loads'), 1, '최신 보고를 받아 온다');
  assert.equal(app.run("reportEdits.has('W:addline:완료한 일|group:가입')"), false, '적던 글을 버려 다시 Enter로 보내지 않는다');
  assert.equal(app.run('reportAddLineIds.size'), 0, '그 id는 버린다');
});
test('다듬기 B(99 리뷰): crypto.randomUUID가 없는 곳(휴대폰 http 접속)에서도 서버가 받는 모양의 요청 id를 짓는다', () => {
  const app = reportClient();
  app.context.crypto = undefined;
  const a = app.run('reportRequestId()'), b = app.run('reportRequestId()');
  assert.match(a, /^[a-zA-Z0-9-]{16,100}$/);
  assert.notEqual(a, b);
  app.context.crypto = globalThis.crypto;
  assert.match(app.run('reportRequestId()'), /^[0-9a-f-]{36}$/);
});

// ─── WP-X 내 일 기록을 주간요약 탭으로 — 주차 목록 줄 끝·맨 아래 덩어리·자세히 창·설정 안내 줄 ───
// 같은 가짜 창(usageWorkClient)에 usage-ui.js를 올린다. 날짜는 서버가 준 today(2026-09-30 수요일) 기준.
const WPX_TODAY = '2026-09-30';
function wpxSummary(app, history, weekKeys, selected) {
  return JSON.parse(app.run(`JSON.stringify(usageWeeksSummary(${JSON.stringify(history)}, '${WPX_TODAY}', ${JSON.stringify(weekKeys)}, ${JSON.stringify(selected)},
    key => (${JSON.stringify({ '2026-09-28': '이번 주', '2026-09-21': '지난 주' })}[key] || '주' + key), key => '라벨' + key))`));
}
function wpxDomClient() {
  const app = usageWorkClient();
  app.run(`const __make = document.createElement;
    document.createElement = tag => Object.assign(__make(tag), { tagName: String(tag).toUpperCase(), style: {} });
    document.createElementNS = (ns, tag) => document.createElement(tag);
    document.createTextNode = value => ({ textContent: String(value), children: [] });`);
  return app;
}
const wpxText = node => (node && typeof node === 'object' ? (node.children && node.children.length ? node.children.map(wpxText).join('') : (node.textContent || '')) : '');
const wpxFind = (node, match) => { if (!node || typeof node !== 'object') return null; if (match(node)) return node; for (const kid of node.children || []) { const hit = wpxFind(kid, match); if (hit) return hit; } return null; };
const wpxAll = (node, match, out = []) => { if (!node || typeof node !== 'object') return out; if (match(node)) out.push(node); (node.children || []).forEach(kid => wpxAll(kid, match, out)); return out; };

test('WP-X 주별 합산 — 월~일 경계, 90일 밖·첫 기록 날보다 앞·오늘 뒤는 null, 첫 기록 날이 주 중간이면 덜 찬 주 그대로', () => {
  const app = usageWorkClient();
  const history = {
    '2026-06-20': { task_done: 50 },                 // 90일 밖 — 버린다
    '2026-09-09': { tab_today: 1 },                  // 첫 기록 날(수) — 9/7 주는 덜 찬 주
    '2026-09-10': { task_done: 2 },
    '2026-09-13': { task_done: 1 },                  // 일요일 — 9/7 주
    '2026-09-14': { task_done: 4 },                  // 월요일 — 9/14 주
    '2026-09-28': { task_done: 3, slack_done: 3 },   // 이번 주(슬랙 끝냄은 할 일로 한 번만)
    '2026-09-30': { task_done: 1 },
  };
  const weeks = ['2026-09-28', '2026-09-21', '2026-09-14', '2026-09-07', '2026-08-31', '2026-06-15', '2026-10-05'];
  const summary = wpxSummary(app, history, weeks, '2026-09-28');
  assert.equal(summary.empty, false);
  assert.deepEqual(summary.weeks['2026-09-28'], { done: 4, days: 2, full: true });
  assert.deepEqual(summary.weeks['2026-09-21'], { done: 0, days: 0, full: true }, '기록 뒤의 빈 주는 0(null 아님)');
  assert.deepEqual(summary.weeks['2026-09-14'], { done: 4, days: 1, full: true });
  assert.deepEqual(summary.weeks['2026-09-07'], { done: 3, days: 3, full: false }, '첫 기록 날이 주 중간 — 그대로 세고 온전한 주는 아님');
  assert.equal(summary.weeks['2026-08-31'], null, '첫 기록 날보다 앞선 주');
  assert.equal(summary.weeks['2026-06-15'], null, '90일보다 오래된 주');
  assert.equal(summary.weeks['2026-10-05'], null, '오늘 뒤의 주');
  assert.equal(summary.max, 4);
  // 같은 history·today면 다시 훑지 않는다(주별 캐시).
  assert.equal(app.run(`(() => { const h = { '2026-09-28': { task_done: 1 } }; return usageWeekIndex(h, '${WPX_TODAY}') === usageWeekIndex(h, '${WPX_TODAY}'); })()`), true);
  // 90일 안에 기록이 하나도 없으면 빈 상태.
  assert.deepEqual(wpxSummary(app, { '2026-05-01': { task_done: 3 } }, weeks, '2026-09-28'), { empty: true });
  assert.deepEqual(wpxSummary(app, {}, weeks, '2026-09-28'), { empty: true });
});

test('WP-X 맨 아래 첫 줄 — 이번 주·지난 주·그 밖·0개·기록 없음 문장, 하루 평균은 기록 있는 날 기준', () => {
  const app = usageWorkClient();
  const history = { '2026-09-01': { tab_today: 1 }, '2026-09-14': { task_done: 6 }, '2026-09-15': { task_done: 1 }, '2026-09-28': { task_done: 11 }, '2026-09-29': { search: 1 } };
  const line = selected => usagePartsText(wpxSummary(app, history, ['2026-09-28', '2026-09-21', '2026-09-14'], selected).line);
  assert.equal(line('2026-09-28'), '이번 주 일 11개를 끝냈어요');
  assert.equal(wpxSummary(app, history, ['2026-09-28'], '2026-09-28').average, '하루 평균 5.5개', '하루 평균은 제 줄(가운뎃점 없음)');
  assert.equal(wpxSummary(app, history, ['2026-09-28'], '2026-09-28').line[1].b, '11개', '숫자만 굵게');
  assert.equal(line('2026-09-14'), '주2026-09-14에 일 7개를 끝냈어요');
  assert.equal(wpxSummary(app, history, ['2026-09-14'], '2026-09-14').average, '하루 평균 3.5개');
  assert.equal(wpxSummary(app, history, ['2026-09-21'], '2026-09-21').average, null, '0개면 평균 줄 없음');
  assert.equal(line('2026-09-21'), '지난 주엔 끝낸 일이 없어요');
  assert.equal(usagePartsText(wpxSummary(app, { '2026-09-01': { tab_today: 1 }, '2026-09-29': { search: 1 } }, ['2026-09-28'], '2026-09-28').line), '이번 주는 아직 끝낸 일이 없어요');
  assert.equal(usagePartsText(wpxSummary(app, history, ['2026-08-24'], '2026-08-24').line), '이 주는 기록이 없어요');
  // 지난 주에 끝낸 일이 있으면.
  const real = wpxSummary(app, { '2026-09-01': { tab_today: 1 }, '2026-09-22': { task_done: 31 }, '2026-09-23': { task_done: 0, search: 1 } }, ['2026-09-21'], '2026-09-21');
  assert.equal(usagePartsText(real.line), '지난 주에 일 31개를 끝냈어요');
  assert.equal(real.average, '하루 평균 15.5개');
});

test('WP-X 최고 기록 줄 — 목록 안 온전한 주 3개 이상·최고가 하나일 때만, 이번 주면 `이번 주가 최고 기록이에요`', () => {
  const app = usageWorkClient();
  const base = { '2026-09-07': { task_done: 5 }, '2026-09-14': { task_done: 31 }, '2026-09-21': { task_done: 8 }, '2026-09-28': { task_done: 2 } };
  const keys = ['2026-09-28', '2026-09-21', '2026-09-14', '2026-09-07'];
  assert.deepEqual(wpxSummary(app, base, keys, '2026-09-28').best, ['최고 기록: ', '라벨2026-09-14 ', { b: '31개' }]);
  assert.deepEqual(wpxSummary(app, { ...base, '2026-09-28': { task_done: 40 } }, keys, '2026-09-28').best, ['이번 주가 최고 기록이에요']);
  assert.equal(wpxSummary(app, { ...base, '2026-09-21': { task_done: 31 } }, keys, '2026-09-28').best, null, '동점이면 없음');
  assert.equal(wpxSummary(app, base, ['2026-09-28', '2026-09-21'], '2026-09-28').best, null, '온전한 주 2개뿐');
  // 첫 기록 날이 걸친 덜 찬 주는 세지 않는다 — 9/9부터면 9/7 주가 빠져 3개 → 그래도 3개(9/14·9/21·9/28)면 있음.
  const late = { '2026-09-09': { task_done: 50 }, '2026-09-14': { task_done: 3 }, '2026-09-21': { task_done: 8 }, '2026-09-28': { task_done: 2 } };
  assert.deepEqual(wpxSummary(app, late, keys, '2026-09-28').best, ['최고 기록: ', '라벨2026-09-21 ', { b: '8개' }], '덜 찬 첫 주의 50개는 최고 기록이 아니다');
  assert.equal(wpxSummary(app, late, ['2026-09-28', '2026-09-21', '2026-09-07'], '2026-09-28').best, null, '덜 찬 주를 빼면 2개');
  assert.equal(wpxSummary(app, { '2026-09-01': { search: 1 }, '2026-09-14': { search: 1 } }, keys, '2026-09-28').best, null, '모두 0이면 없음');
});

test('WP-X usageWorkStats 넷째 인자 { week, name } — 지난 주는 그 주 월~일 전체·그 앞 주와 비교·막대 7칸 모두 과거·과거 시제, 없으면 예전 그대로', () => {
  const app = usageWorkClient();
  const history = usageFill('2026-09-07', 24, (day, dow) => (dow < 5 ? { task_add: 2, task_done: day >= '2026-09-21' ? 3 : 1 } : null));
  const plain = usageStats(app, history, WPX_TODAY, 'week');
  const same = JSON.parse(app.run(`JSON.stringify(usageWorkStats(${JSON.stringify(history)}, '${WPX_TODAY}', 'week', undefined))`));
  assert.deepEqual(same, plain, '인자가 없으면 결과가 같다');
  assert.equal(plain.week, undefined);
  const stats = options => JSON.parse(app.run(`JSON.stringify(usageWorkStats(${JSON.stringify(history)}, '${WPX_TODAY}', 'week', ${JSON.stringify(options)}))`));
  const last = stats({ week: '2026-09-21', name: '지난 주' });
  assert.equal(last.week, '2026-09-21');
  assert.equal(last.weekName, '지난 주');
  assert.equal(last.from, '2026-09-21');
  assert.equal(last.to, '2026-09-27');
  assert.equal(last.periodLabel, '9월 21일(월) – 9월 27일(일)');
  assert.equal(usagePartsText(last.headline), '지난 주에 일 15개를 끝냈어요');
  assert.equal(last.bars.length, 7);
  assert.equal(last.bars.some(bar => bar.future || bar.today), false, '미래·오늘 칸 없음');
  assert.deepEqual(last.compare && [last.compare.from, last.compare.to, last.compare.text], ['2026-09-14', '2026-09-20', '그 전 주와 비슷했어요']);
  // 이름을 안 주면 `지난 주`/`9월 14일 주`.
  assert.equal(stats({ week: '2026-09-21' }).weekName, '지난 주');
  const older = stats({ week: '2026-09-14', name: '9월 3주차' });
  assert.equal(usagePartsText(older.headline), '9월 3주차에 일 5개를 끝냈어요');
  assert.equal(stats({ week: '2026-09-14' }).weekName, '9월 14일 주');
  // 끝낸 일 0.
  assert.equal(usagePartsText(JSON.parse(app.run(`JSON.stringify(usageWorkStats({ '2026-09-01': { search: 1 }, '2026-09-22': { task_add: 1 } }, '${WPX_TODAY}', 'week', { week: '2026-09-21', name: '지난 주' }))`)).headline), '지난 주엔 끝낸 일이 없어요');
  // 이번 주·미래·월요일 아님·이상한 값 → 예전 그대로. 이번 달·90일은 늘 오늘 기준.
  for (const options of [{ week: '2026-09-28' }, { week: '2026-10-05' }, { week: '2026-09-22' }, { week: 'x' }, null, 'bogus']) {
    assert.deepEqual(stats(options), plain, JSON.stringify(options));
  }
  const month = JSON.parse(app.run(`JSON.stringify(usageWorkStats(${JSON.stringify(history)}, '${WPX_TODAY}', 'month', { week: '2026-09-21', name: '지난 주' }))`));
  assert.deepEqual(month, usageStats(app, history, WPX_TODAY, 'month'));
  // 최고 기록 인사이트는 그 주 이름으로, 뒤의 온전한 주도 비교한다.
  const peak = usageFill('2026-09-07', 24, (day, dow) => (dow < 5 ? { task_done: day >= '2026-09-14' && day <= '2026-09-20' ? 9 : 1 } : null));
  const best = JSON.parse(app.run(`JSON.stringify(usageWorkStats(${JSON.stringify(peak)}, '${WPX_TODAY}', 'week', { week: '2026-09-14', name: '9월 3주차' }))`));
  assert.equal(usagePartsText(best.insights.find(item => item.kind === 'best').parts), '9월 3주차가 최근 3주 중 가장 많이 끝낸 주예요.');
});

test('WP-X report-ui.js의 두 자리가 usage-ui.js로 넘기고, 주차 줄 aria-label 끝에 `끝낸 일 N개`가 붙는다', () => {
  const app = reportClient();
  assert.equal(app.run("reportWeekRowEnd({ weekKey: '2026-09-28' })"), null, 'usage-ui.js가 없으면 그대로 null');
  app.run(fs.readFileSync(path.join(__dirname, 'usage-ui.js'), 'utf8'));
  app.run(`const __make = document.createElement;
    document.createElement = tag => Object.assign(__make(tag), { tagName: String(tag).toUpperCase(), style: {} });
    document.createElementNS = (ns, tag) => document.createElement(tag);
    document.createTextNode = value => ({ textContent: String(value), children: [] });`);
  app.run(`reportWeekName = key => (${JSON.stringify({ '2026-09-28': '이번 주', '2026-09-21': '지난 주' })}[key] || formatWeekLabel(key).week);
    renderWeeklyReportDetail = () => {};
    document.getElementById('weeklyReportDetail').contains = () => false;
    activeTabKey = 'weekly';
    usageInfo = { ok: true, today: '${WPX_TODAY}', rows: [], history: { '2026-09-01': { search: 1 }, '2026-09-22': { task_done: 4 }, '2026-09-29': { task_done: 2 } } };`);
  // 기록이 없는 주(8월)는 칸 없음, 나머지는 막대 + 숫자.
  app.run(`renderWeeklyReports([{ weekKey: '2026-09-28', draft: { rows: [] } }, { weekKey: '2026-09-21', draft: { rows: [] } }, { weekKey: '2026-08-17', draft: { rows: [] } }])`);
  const nav = app.nodes.get('weeklyReportNav');
  const buttons = nav.children.filter(kid => kid.className === 'rp-wk');
  assert.equal(buttons.length, 3);
  const end = buttons[0].children.find(kid => kid.className === 'd-uwend');
  assert.ok(end);
  assert.equal(end.dataset.label, '끝낸 일 2개');
  assert.equal(end.children[0].getAttribute('aria-hidden'), 'true', '막대는 읽지 않는다');
  assert.equal(end.children[1].textContent, '2');
  assert.equal(end.children[0].children[0].style.width, '50%', '목록 안 최대(4) 대비');
  assert.match(buttons[0].getAttribute('aria-label'), /^이번 주, 2026년 9\/28 ~ 10\/4, 끝낸 일 2개$/);
  assert.match(buttons[1].getAttribute('aria-label'), /, 끝낸 일 4개$/);
  assert.equal(buttons[2].children.some(kid => kid.className === 'd-uwend'), false, '기록이 없는 주는 0으로 보이지 않는다');
  assert.doesNotMatch(buttons[2].getAttribute('aria-label'), /끝낸 일/);
  // 맨 위 판 — 고른 주(이번 주)의 하루 평균(끝낸 일 문장은 목록 줄 숫자와 겹쳐 빠짐) + 버튼.
  const foot = nav.children[0];
  assert.equal(foot.className, 'd-uwfoot');
  assert.deepEqual(foot.children[0].children.map(wpxText), ['하루 평균 2개'], '요약은 한 줄씩');
  const link = foot.children[foot.children.length - 1];
  assert.equal(link.textContent, '내 일 기록 자세히');
  assert.equal(link.className, 'd-uwmore');
  // 8월 주를 고르면 평균·최고 기록이 없어 `이 주는 기록이 없어요`가 첫 줄, 버튼은 그대로.
  app.run(`selectedWeekKey = '2026-08-17'; renderWeeklyReports(weeklyReportsCache);`);
  const foot2 = nav.children[0];
  assert.deepEqual(foot2.children[0].children.map(wpxText), ['이 주는 기록이 없어요']);
  assert.equal(foot2.children[foot2.children.length - 1].textContent, '내 일 기록 자세히');
  // 90일 전체에 기록이 없으면 칸·덩어리 모두 없음.
  app.run(`usageInfo = { ok: true, today: '${WPX_TODAY}', rows: [], history: {} }; renderWeeklyReports(weeklyReportsCache);`);
  assert.equal(nav.children.some(kid => kid.className === 'd-uwfoot'), false);
  assert.equal(nav.children.some(kid => (kid.children || []).some(one => one.className === 'd-uwend')), false);
  const main = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  assert.match(main, /end\.dataset\.label \? `, \$\{end\.dataset\.label\}` : ''/);
});

test('주차 목록 맨 위 `내 일 기록` 판 — 첫 주 앞에 붙고, 큰 끝낸 일 문장 없이 하루 평균·최고 기록, 판 폭 버튼(자세히 창), 기록을 못 읽어도 버튼은 남는다', () => {
  const app = reportClient();
  app.run(fs.readFileSync(path.join(__dirname, 'usage-ui.js'), 'utf8'));
  app.run(`const __make = document.createElement;
    document.createElement = tag => Object.assign(__make(tag), { tagName: String(tag).toUpperCase(), style: {} });
    document.createElementNS = (ns, tag) => document.createElement(tag);
    document.createTextNode = value => ({ textContent: String(value), children: [] });`);
  app.run(`reportWeekName = key => (${JSON.stringify({ '2026-09-28': '이번 주', '2026-09-21': '지난 주' })}[key] || formatWeekLabel(key).week);
    renderWeeklyReportDetail = () => {};
    document.getElementById('weeklyReportDetail').contains = () => false;
    activeTabKey = 'weekly';
    usageInfo = { ok: true, today: '${WPX_TODAY}', rows: [], history: { '2026-09-01': { search: 1 }, '2026-09-08': { task_done: 3 }, '2026-09-15': { task_done: 9 }, '2026-09-22': { task_done: 4 }, '2026-09-29': { task_done: 2 } } };
    selectedWeekKey = '2026-09-21';`);
  app.run(`renderWeeklyReports(['2026-09-28', '2026-09-21', '2026-09-14', '2026-09-07'].map(weekKey => ({ weekKey, draft: { rows: [] } })))`);
  const nav = app.nodes.get('weeklyReportNav');
  assert.equal(nav.children[0].className, 'd-uwfoot', '판은 목록 맨 앞(첫 주 줄 위)');
  assert.equal(nav.children.slice(1).every(kid => kid.className === 'rp-wk'), true, '판 뒤로는 주차 줄만');
  const foot = nav.children[0];
  const lines = foot.children[0].children.map(wpxText);
  assert.deepEqual(lines, ['하루 평균 4개', '최고 기록: 9월 3주차 9개'], '하루 평균이 첫 줄, 최고 기록이 둘째 줄');
  assert.equal(lines.some(line => /끝냈어요/.test(line)), false, '큰 끝낸 일 문장은 판에 없다');
  const button = foot.children[1];
  assert.equal(button.tagName, 'BUTTON');
  assert.equal(button.className, 'd-uwmore', '파란 글자 링크(.d-link)가 아니다');
  assert.equal(button.textContent, '내 일 기록 자세히');
  assert.equal(button.getAttribute('aria-haspopup'), 'dialog');
  button.listeners.click();
  assert.equal(app.run('usageWorkDlg.week'), '2026-09-21', '고른 주 기준으로 연다');
  app.run('usageWorkClose()');
  // 업무 기록을 못 읽음 — 판 안 한 줄 + 버튼 그대로.
  app.run(`usageInfo = { ...usageInfo, work: null }; renderWeeklyReports(weeklyReportsCache);`);
  const failed = nav.children[0];
  assert.equal(failed.className, 'd-uwfoot is-failed', '못 읽음 안내는 강조하지 않는 모양');
  assert.deepEqual(failed.children[0].children.map(wpxText), ['끝낸 일을 읽지 못했어요']);
  assert.equal(failed.children[1].textContent, '내 일 기록 자세히');
  // 모양 — 회색 판이 머리 아래에 머물고(sticky), 좁은 폭에서는 주차 칸 줄 위 한 줄.
  const css = fs.readFileSync(path.join(__dirname, 'usage-ui.css'), 'utf8');
  assert.match(css, /\.d-uwfoot \{[^}]*position: sticky; top: 22px;[^}]*background: var\(--neutral-bg\)/);
  assert.match(css, /\.d-uwmore \{[^}]*min-height: 40px;[^}]*border-top: 1px solid var\(--border\)[^}]*color: var\(--text\)/);
  assert.match(css, /#weeklyReportNav > \.rp-wk \{ grid-row: 2; \}/);
  assert.doesNotMatch(css, /\.d-uwfoot \.d-link/);
});

test('WP-X 아직 사용 기록을 못 불렀으면 줄 끝·덩어리는 null이고 한 번만 부른 뒤 주간요약이 보일 때만 다시 그린다', async () => {
  const app = usageWorkClient();
  app.run(`window.loads = 0; window.draws = 0;
    usageLoad = async () => { window.loads += 1; await null; usageInfo = { ok: true, today: '${WPX_TODAY}', rows: [], history: { '2026-09-29': { task_done: 1 } } }; return usageInfo; };
    renderWeeklyReports = () => { window.draws += 1; };
    weeklyReportsCache = [{ weekKey: '2026-09-28' }];
    activeTabKey = 'weekly';`);
  assert.equal(app.run("usageWeekRowEnd({ weekKey: '2026-09-28' })"), null);
  assert.equal(app.run('usageWeeksFoot(weeklyReportsCache)'), null);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.run('window.loads'), 1, '줄마다 부르지 않는다');
  assert.equal(app.run('window.draws'), 1);
  // 다른 탭이면 다시 그리지 않고 다음에 열 때 그리게 표시만.
  app.run(`activeTabKey = 'today'; tabStale.weekly = false; usageWeekRefresh();`);
  assert.equal(app.run('window.draws'), 1);
  assert.equal(app.run('tabStale.weekly'), true);
});

test('WP-X 자세히 창 — .d-modal 판·제목·닫기, 열면 초점은 창, Esc·✕·바깥 누름으로 닫고 누른 링크로 초점, 지난 주면 그 주 기준', () => {
  const app = wpxDomClient();
  app.run(`reportWeekName = key => (key === '2026-09-21' ? '지난 주' : '이번 주');
    usageInfo = { ok: true, today: '${WPX_TODAY}', days: 30, rows: [],
      history: { '2026-09-15': { task_done: 1 }, '2026-09-22': { task_add: 3, task_done: 5 }, '2026-09-29': { task_done: 2 } } };
    link = document.createElement('button');
    usageWorkOpen(link, '2026-09-21');`);
  const dialog = app.run('usageWorkDlg.dialog');
  assert.equal(dialog.className, 'd-modal d-uwdlg');
  assert.equal(dialog.getAttribute('aria-labelledby'), 'usageWorkTitle');
  assert.equal(wpxText(wpxFind(dialog, node => node.tagName === 'H2')), '내 일 기록');
  const close = wpxFind(dialog, node => node.className === 'd-iconbtn');
  assert.equal(close.getAttribute('aria-label'), '닫기');
  assert.equal(dialog.open, true);
  assert.equal(dialog.focused, true, '열면 초점은 창 자체');
  assert.equal(app.run('escStack.length'), 1, 'Esc는 앱의 스택 하나로');
  const body = app.run('usageWorkDlg.body');
  const seg = wpxAll(body, node => node.dataset && node.dataset.range);
  assert.deepEqual(seg.map(button => [button.textContent, button.getAttribute('aria-pressed')]), [['지난 주', 'true'], ['이번 달', 'false'], ['90일', 'false']]);
  assert.equal(wpxText(wpxFind(body, node => node.className === 'd-uwbig')), '지난 주에 일 5개를 끝냈어요');
  assert.equal(wpxText(wpxFind(body, node => node.className === 'd-uwperiod')), '9월 21일(월) – 9월 27일(일)');
  // ✕ → 닫히고 링크로.
  close.listeners.click();
  assert.equal(dialog.open, false);
  assert.equal(app.run('link.focused'), true);
  assert.equal(app.run('escStack.length'), 0);
  // 다시 열어 Esc(스택) → 닫힘.
  app.run(`link.focused = false; usageWorkOpen(link, null);`);
  assert.equal(wpxAll(app.run('usageWorkDlg.body'), node => node.dataset && node.dataset.range)[0].textContent, '이번 주', '이번 주·기록 없는 주는 오늘 기준');
  app.run('escStack.pop()()');
  assert.equal(dialog.open, false);
  assert.equal(app.run('link.focused'), true);
  // 브라우저 cancel(Esc) 길도 같은 닫기.
  app.run(`link.focused = false; usageWorkOpen(link, null);`);
  let prevented = false;
  dialog.listeners.cancel({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(dialog.open, false);
  assert.equal(app.run('escStack.length'), 0);
  // 바깥 누름 — 판 안 좌표는 무시, 판 밖이면 닫는다.
  app.run(`link.focused = false; usageWorkOpen(link, null); usageWorkDlg.dialog.getBoundingClientRect = () => ({ left: 100, right: 660, top: 50, bottom: 600 });`);
  dialog.listeners.click({ target: dialog, clientX: 300, clientY: 300 });
  assert.equal(dialog.open, true, '판 안(테두리)을 누르면 그대로');
  dialog.listeners.click({ target: close, clientX: 10, clientY: 10 });
  assert.equal(dialog.open, true, '안쪽 요소를 누른 것은 바깥이 아님');
  dialog.listeners.click({ target: dialog, clientX: 10, clientY: 10 });
  assert.equal(dialog.open, false);
  assert.equal(app.run('link.focused'), true);
  // 링크가 그 사이 다시 그려져 사라졌으면 주간요약 탭 버튼으로.
  app.run(`link.connected = false; usageWorkOpen(link, null); usageWorkClose();`);
  assert.equal(app.nodes.get('tabBtnWeekly').focused, true);
});

test('WP-X 설정 › 앱 `사용 통계` 줄 — 스위치와 안내 한 줄만(표·접이식 없음), `보기`는 설정을 닫고 주간요약으로 옮긴 뒤 자세히 창', () => {
  const app = wpxDomClient();
  app.run(`window.steps = [];
    settingsClose = () => window.steps.push('close');
    setActiveTab = tab => window.steps.push('tab:' + tab);
    selectedWeekKey = '2026-09-28'; weeklyReportsCache = [{ weekKey: '2026-09-28' }];
    usageSettingsNode = document.createElement('div');
    usageInfo = { ok: true, send: true, canSend: true, days: 30, rows: [{ key: 'task_done', label: '할 일 끝냄', count: 3 }], today: '${WPX_TODAY}', history: { '2026-09-29': { task_done: 3 } } };
    usageSettingsPaint();`);
  const cell = app.run('usageSettingsNode');
  assert.equal(cell.children.length, 2);
  assert.match(cell.children[0].className, /d-usageswitch/);
  assert.match(wpxText(cell.children[0]), /꺼도 내 일 기록은 이 맥에 계속 쌓여요/);
  assert.equal(wpxFind(cell, node => node.tagName === 'TABLE' || node.tagName === 'DETAILS' || node.className === 'd-uw'), null, '표·접이식·통계가 없다');
  const where = cell.children[1];
  assert.equal(where.className, 'd-ismall d-uwgo');
  assert.equal(wpxText(where), '내 일 기록은 주간요약 탭에서 볼 수 있어요 · 보기');
  const go = where.children[1];
  assert.equal(go.className, 'd-ablink');
  go.listeners.click();
  assert.deepEqual(JSON.parse(app.run('JSON.stringify(window.steps)')), ['close', 'tab:weekly']);
  assert.equal(app.run('usageWorkDlg.dialog.open'), true);
  assert.equal(app.run('usageWorkDlg.opener'), app.nodes.get('tabBtnWeekly'), '링크를 찾지 못하면 닫을 때 주간요약 탭 버튼으로');
});

test('회의 초안: 되돌리기 뒤 문구를 고치고 다시 실행 → 되돌리기 하면 고친 문구가 돌아온다', async () => {
  const { app, draw } = meetingBoardClient();
  app.run('undoStack.length = 0; redoStack.length = 0;');
  const box = draw();
  const first = nodeFindAll(box, 'd-draft')[0];
  const text = nodeFind(first, 'd-dtxt');
  text.style = {};
  text.value = '처음 문구'; text.listeners.input();
  await nodeFind(first, 'd-dpull').listeners.click();
  await app.run("replayUndo('undo')");
  assert.equal(app.run("wfDraftEdits.get('mb1:stable:a').description"), '처음 문구');
  app.run("wfDraftEdits.get('mb1:stable:a').description = '고친 문구'");
  await app.run("replayUndo('redo')");
  await app.run("replayUndo('undo')");
  assert.equal(app.run("wfDraftEdits.get('mb1:stable:a').description"), '고친 문구', '수정 전 문구가 아니라 그 순간의 문구');
});

test('회의 초안: 다른 되돌리기가 도는 중에 누른 알림의 `되돌리기`는 잠긴 채 남지 않는다', async () => {
  const { app, draw } = meetingBoardClient();
  app.run('undoStack.length = 0; redoStack.length = 0;');
  const box = draw();
  await nodeFind(nodeFindAll(box, 'd-draft')[2], 'd-dpull').listeners.click();
  const undo = app.nodes.get('liveRegion').children.find(kid => kid.textContent === '되돌리기');
  app.run('undoReplaying = true;');
  await undo.listeners.click();
  app.run('undoReplaying = false;');
  assert.notEqual(undo.disabled, true, '되돌리기가 실행되지 않았으니 다시 누를 수 있다');
});

test('회의 `기존 항목 연결`: <select> 대신 uiPickList — 고르면 버튼에 이름이 남고 `회의에 연결`이 그 항목을 보낸다, 0개면 한 줄', async () => {
  const { app, sent, meeting } = meetingBoardClient();
  const draw = () => app.run(`(() => {
    const box = document.createElement('div');
    const host = { kind: 'card', closable: false, getResult: () => null, setResult() {}, redraw() {}, box: () => box, openItem() {}, openMeeting() {} };
    panelMeetingLink(__meeting, box, host);
    return box;
  })()`);
  // 후보 0개 — 자리는 남고 한 줄로 알린다.
  let box = draw();
  assert.equal(nodeFind(nodeFind(box, 'd-dadd'), 'd-gpnone').textContent, '연결할 항목이 없어요');
  assert.equal(nodeFind(box, 'd-msel'), null);

  app.context.__items = [
    { id: 'i1', type: 'task', description: '결제 스펙 정리' },
    { id: 'i2', type: 'check', description: '디자인 회신', meetingId: 'other' },
    { id: 'i3', type: 'decision', description: '배너로 간다' },
  ];
  app.run('workflowData = { items: __items, meetings: [__meeting] }; wfIndexData();');
  box = draw();
  const section = nodeFind(box, 'd-dadd');
  assert.equal(nodeFindAll(section, 'd-gpnone').length, 0);
  const slot = nodeFind(section, 'd-dpickslot');
  const trigger = slot.children[0];
  assert.equal(trigger.textContent, '항목 선택');
  assert.notEqual(trigger.tagName, 'SELECT');
  const link = nodeFindAll(section, 'd-btn')[0];
  await link.listeners.click();
  assert.equal(sent.length, 0, '고르기 전에는 보내지 않는다');
  trigger.listeners.click();
  const root = slot.children[0];
  assert.equal(root.className, 'd-gpick');
  const list = root.children.find(kid => kid.getAttribute && kid.getAttribute('role') === 'listbox');
  assert.deepEqual(list.children.map(kid => kid.dataset.value), ['i1', 'i3'], '이미 다른 회의에 붙은 항목은 후보가 아니다');
  list.children[1].listeners.click({ stopPropagation() {} });
  assert.equal(slot.children[0], trigger, '고르면 목록이 접히고 버튼으로 돌아온다');
  assert.equal(trigger.textContent, '배너로 간다');
  await link.listeners.click();
  assert.deepEqual(sent[0], { url: '/api/workflow/link', body: { id: 'i3', meetingId: 'mb1' } });
  assert.ok(meeting);
});

test('회의 `기존 항목 연결` 목록은 8개 이상이면 찾기 칸이 서고, .d-msel.wide 규칙은 남지 않는다', () => {
  const { app } = meetingBoardClient();
  app.context.__items = Array.from({ length: 9 }, (_, index) => ({ id: `i${index}`, type: 'task', description: `항목 ${index}` }));
  app.run('workflowData = { items: __items, meetings: [__meeting] }; wfIndexData();');
  const box = app.run(`(() => { const b = document.createElement('div'); panelMeetingLink(__meeting, b, { redraw() {} }); return b; })()`);
  const slot = nodeFind(box, 'd-dpickslot');
  slot.children[0].listeners.click();
  assert.equal(slot.children[0].children[0].type, 'search');
  const css = fs.readFileSync(path.join(__dirname, 'ui.css'), 'utf8');
  assert.doesNotMatch(css, /\.d-msel\.wide/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, 'meetings-ui.js'), 'utf8'), /d-msel wide/);
});

// ---------- 작은 버튼 누르는 자리 · 문구 · 접근성 묶음 ----------

test('작은 버튼 1: 넓은 화면의 작은 글자 링크·버튼은 투명 ::after로 누르는 자리 28px(이미 28 이상이면 그대로), 그룹 이름은 여백으로', () => {
  const css = fs.readFileSync(path.join(__dirname, 'ui.css'), 'utf8');
  assert.match(css, /\n\.d-ablink, \.d-selbar \.d-link, \.d-src, \.d-sug \{ position: relative; \}/);
  const rule = css.slice(css.indexOf('.d-ablink::after, .d-selbar .d-link::after, .d-src::after, .d-sug::after {'));
  const body = rule.slice(0, rule.indexOf('}'));
  assert.match(body, /content: ''; position: absolute;/);
  ['top', 'bottom', 'left', 'right'].forEach(side => assert.match(body, new RegExp(`${side}: min\\(0px, calc\\(50% - 14px\\)\\)`), side));
  assert.match(css, /\.d-grp button\.gl \{ padding-block: 3px; margin-block: -3px; \}/, '말줄임이라 ::after가 잘리는 그룹 이름은 여백으로');
  assert.match(css, /\.d-wrow \.tiwrap \.d-src::after \{ top: -2px; bottom: min\(0px, calc\(100% - 26px\)\); \}/, '레일의 `원문`은 바로 위 제목을 덮지 않는다');
  assert.doesNotMatch(body, /background|border|color/, '모양은 그대로(투명)');
});

test('작은 버튼 2: 도움말의 `명령 복사`는 무슨 명령인지 이름을 말한다(보이는 글자는 그대로)', () => {
  const app = workflowsClient();
  const line = app.run("selfcheckCommandLine('bash ~/업데이트.command', '업데이트 파일 실행 명령 복사')");
  const button = line.children.find(kid => kid.textContent === '명령 복사');
  assert.ok(button);
  assert.equal(button.getAttribute('aria-label'), '업데이트 파일 실행 명령 복사');
  const plain = app.run("selfcheckCommandLine('npm test')").children.find(kid => kid.textContent === '명령 복사');
  assert.equal(plain.getAttribute('aria-label'), undefined, '이름을 주지 않으면 보이는 글자가 이름');
  const updateLines = app.run("selfcheckUpdateLines('~/업데이트.command')");
  const copy = updateLines.children[0].children.find(kid => kid.textContent === '명령 복사');
  assert.equal(copy.getAttribute('aria-label'), '업데이트 파일 실행 명령 복사');
});

// 가짜 상세 카드 한 벌: dd[data-field] 칸마다 누르는 자리 하나 + 카드 제목. focus()가 불린 곳을 모은다.
function focusBox(app, fields) {
  return app.run(`(() => {
    const hit = [];
    const node = (name) => ({ name, tagName: 'BUTTON', textContent: name, getAttribute: () => null, focus() { hit.push(name); } });
    const cells = ${JSON.stringify(fields)}.map(field => ({ dataset: { field }, querySelector: () => node(field + ' 값') }));
    const title = node('제목');
    const extra = node('오늘 확인 요청함');
    return {
      hit,
      querySelectorAll: sel => sel === 'dd[data-field]' ? cells : [extra],
      querySelector: sel => sel === '.d-dtitle' ? title : null,
    };
  })()`);
}

test('작은 버튼 3: 저장 뒤 다시 그린 카드에서 초점은 방금 고친 필드의 누르는 자리로(없으면 카드 제목), 다른 곳에 두었으면 건드리지 않는다', () => {
  const app = workflowsClient();
  // 필드 이름표: panelField가 dd에 붙인다
  const dl = app.run("(() => { const dl = document.createElement('dl'); panelField(dl, '우선순위', '보통'); return dl; })()");
  assert.equal(dl.children[1].dataset.field, '우선순위');
  const restore = app.run('(box, from) => panelFocusRestore(box, from)');

  app.run("panelState = { id: 't1', kind: 'item' }; panelFocusField = { id: 't1', field: '우선순위' }; document.activeElement = null;");
  let box = focusBox(app, ['언제 할지', '우선순위', '기한']);
  restore(box, null);
  same(box.hit, ['우선순위 값'], '초점이 빠졌고(문서 전체) 만진 필드가 있으면 그 칸으로');

  box = focusBox(app, ['언제 할지', '기한']);
  restore(box, null);
  same(box.hit, ['제목'], '그 필드가 없어졌으면 카드 제목');

  app.run("panelFocusField = { id: 'other', field: '우선순위' };");
  box = focusBox(app, ['우선순위']);
  restore(box, null);
  same(box.hit, [], '다른 항목에서 만진 필드이고 초점도 카드에 없었으면(자동 새로고침) 가만히');

  app.run("panelFocusField = { id: 't1', field: '우선순위' }; document.activeElement = { id: 'todayTaskInput' };");
  box = focusBox(app, ['우선순위']);
  restore(box, null);
  same(box.hit, [], '사람이 이미 다른 곳에 초점을 두었으면 빼앗지 않는다');

  app.run('panelFocusField = null; document.activeElement = null;');
  box = focusBox(app, ['우선순위']);
  restore(box, { tagName: 'BUTTON', textContent: '오늘 확인 요청함', getAttribute: () => null });
  same(box.hit, ['오늘 확인 요청함'], '필드 밖 버튼에 있던 초점은 새 카드의 같은 이름 버튼으로');

  const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  const render = source.slice(source.indexOf('function panelRender('), source.indexOf('function panelSheetMount('));
  assert.match(render, /const before = panelDetailBox\(\);[\s\S]*if \(detailSheet\(\)\)/, '갈아 끼우기 전에 옛 카드의 초점을 본다');
  assert.match(render, /if \(!meeting && !focusFirst\) panelFocusRestore\(box, focusFrom\);/, '처음 열 때(focusFirst)·회의는 제외');
  assert.match(source, /panelState = null;\n  panelFocusField = null;/, '닫으면 기억도 지운다');
});

test('작은 버튼 4: 선택 막대의 개수 칸은 aria-live 칸 하나를 모드 동안 그대로 두고 글자만 바꾼다, 선택 중 제목은 낭독기에서 숨는다', () => {
  const { app, bar } = selectBarClient();
  app.run('taskSelectionRefresh()');
  const count = bar().children[0];
  assert.equal(count.getAttribute('aria-live'), 'polite');
  assert.equal(count.getAttribute('aria-atomic'), 'true');
  assert.equal(count.textContent, '줄을 눌러 골라요');
  app.run("taskSelection.add('s1'); taskSelectionRefresh()");
  assert.equal(bar().children[0], count, '같은 요소(새로 만들면 바뀐 것으로 읽히지 않는다)');
  assert.equal(count.textContent, '1개 선택');
  assert.equal(bar().children.filter(kid => kid === count).length, 1, '개수 칸은 하나');
  assert.equal(bar().children.filter(kid => kid.textContent === '전체 선택').length, 1, '버튼은 겹쳐 쌓이지 않는다');
  app.run('taskSelectionMode = false; taskSelectionRefresh()');
  assert.equal(app.nodes.get('taskSelectBar').children.length, 0, '끝내면 막대를 비운다');

  const rows = narrowClient(1280);
  rows.run('taskSelectionMode = true;');
  const title = nodeFind(rows.run(`uiTaskRow(${SEL_TASK}, { mode: 'today' })`), 'd-title');
  assert.equal(title.getAttribute('aria-hidden'), 'true', '선택 칸이 `제목 — 선택`을 말하므로 제목은 한 번 더 읽히지 않는다');
  assert.equal(title.getAttribute('aria-label'), undefined);
  rows.run('taskSelectionMode = false;');
  const back = nodeFind(rows.run(`uiTaskRow(${SEL_TASK}, { mode: 'today' })`), 'd-title');
  assert.equal(back.getAttribute('aria-hidden'), undefined);
  assert.equal(back.getAttribute('role'), 'button');
  assert.equal(back.getAttribute('aria-label'), '결제 실패 알림 문구 정리 상세 보기');
});

test('작은 버튼 5: 결정 줄 체크박스는 PRD 반영이라는 뜻을 툴팁·이름표로 말한다(확인)', () => {
  const app = workflowsClient();
  const check = app.run("decisionCheckbox({ id: 'd1', description: '가입은 3단계' }, document.createElement('div'), false)");
  const box = check.children[0];
  assert.equal(box.title, 'PRD 반영함으로 표시');
  assert.equal(box.getAttribute('aria-label'), '가입은 3단계 — PRD 반영함으로 표시');
});

test('작은 버튼 6: 메뉴 안에서 값을 고르는 칩은 지금 값을 menuitemradio + aria-checked로 말한다', () => {
  const app = workflowsClient();
  const chips = app.run("uiMenuChips([['a', '보통'], ['b', '중요']], 'b', () => {})");
  same(chips.children.map(chip => [chip.textContent, chip.getAttribute('role'), chip.getAttribute('aria-checked')]),
    [['보통', 'menuitemradio', 'false'], ['중요', 'menuitemradio', 'true']]);
  const when = app.run("taskWhenControl({ id: 't1', description: '일', scheduled: todayStr() }, 'today', null)");
  same(when.children.map(chip => [chip.textContent, chip.getAttribute('role'), chip.getAttribute('aria-checked') ?? null]),
    [['오늘', 'menuitemradio', 'true'], ['내일', 'menuitemradio', 'false'], ['나중에', 'menuitemradio', 'false'], ['날짜…', 'menuitem', null]]);
  const later = app.run("taskWhenControl({ id: 't2', description: '일', scheduled: null }, 'later', null)");
  same(later.children.map(chip => chip.getAttribute('aria-checked') ?? null), ['false', 'false', null], '나중에 있는 업무에는 `나중에` 칩이 없다');
  // 나중에 할 일 버튼은 서랍 열림을 aria-expanded로(확인)
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  assert.match(html, /id="laterTaskToggle" aria-expanded="false" aria-controls="laterTaskDrawer"/);
});

test('작은 버튼 7: 오류 알림은 무엇이 안 됐는지 + 다음에 할 일 한 줄(showNotice 정의는 그대로)', () => {
  const settings = fs.readFileSync(path.join(__dirname, 'settings-ui.js'), 'utf8');
  assert.doesNotMatch(settings, /showNotice\('복사하지 못했어요', true\)/);
  assert.doesNotMatch(settings, /showNotice\('암호를 복사하지 못했어요', true\)/);
  assert.equal(settings.split("showNotice('복사하지 못했어요 · 이 맥의 앱 창에서 다시 눌러 주세요', true)").length - 1, 2);
  assert.match(settings, /showNotice\('암호를 복사하지 못했어요 · 이 맥의 앱 창에서 다시 눌러 주세요', true\)/);
  assert.match(settings, /\{ autoUpdate: want \}, '자동 업데이트 설정을 저장하지 못했어요 · 잠시 뒤 다시 눌러 주세요'\)/);
  const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  const start = app.indexOf('function showNotice(');
  const notice = app.slice(start, app.indexOf('\n}\n', start));
  assert.match(notice, /'⌘Z로 되돌리기' : 'Ctrl\+Z로 되돌리기'/, 'showNotice 안은 그대로');
});

test('작은 버튼 8: `오늘 신규` 대신 `오늘 들어온 것 N` — 낭독기 이름도 보이는 글자로 시작한다', () => {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  assert.match(html, /id="createdTodayBtn" aria-label="오늘 들어온 것 0 — 모아 보기" hidden>오늘 들어온 것 <span class="num" id="createdTodayCount">0<\/span><\/button>/);
  assert.doesNotMatch(html, /오늘 신규/);
  const app = workflowsClient();
  app.run('renderInboxHeadCount(3)');
  assert.equal(app.nodes.get('createdTodayBtn').getAttribute('aria-label'), '오늘 들어온 것 3 — 모아 보기');
  assert.equal(app.nodes.get('createdTodayBtn').hidden, false);
  assert.equal(app.nodes.get('createdTodayCount').textContent, 3);
  app.run('renderInboxHeadCount(0)');
  assert.equal(app.nodes.get('createdTodayBtn').hidden, true);
});

test('작은 버튼 9: 연동 요약 개수 — 회의록 직접 옮기기는 연결에도 남은 것에도 세지 않고, 캘린더는 켠 갈래 어느 것이든 연결(끔이면 남은 것)', () => {
  const app = workflowsClient();
  const count = data => JSON.parse(app.run(`JSON.stringify(settingsIntgCounts(${JSON.stringify(data)}))`));
  same(count({}), { on: 0, left: 3 }, '처음 설치(회의록 기본 = 직접 옮기기)는 연결 0 · 남은 것 3');
  same(count({ meetingNotes: { mode: 'manual' } }), { on: 0, left: 3 });
  same(count({ meetingNotes: { mode: 'tiro' } }), { on: 1, left: 3 }, '티로로 받으면 연결');
  ['mac', 'ical', undefined].forEach(source => same(count({ calendar: { enabled: true, source } }), { on: 1, left: 2 }, `캘린더 ${source || 'Claude'} 갈래`));
  same(count({ calendar: { enabled: false, source: 'mac' } }), { on: 0, left: 3 }, '캘린더 끔');
});

// 디자인 사후 확인: 계획 문장 ⋯ › `프로젝트 바꾸기` 목록이 펼쳐진 동안만 is-picking — 라벨은 목록 위 한 줄, 목록은 왼쪽 정렬.
test('계획 문장 프로젝트 바꾸기: 목록을 펼치면 is-picking, 고르면 풀린다 · CSS 규칙', () => {
  const app = reportClient();
  app.run("customGroupsCache = ['운영툴']; jiraIssuesCache = []; reportChange = async () => {}; uiMenuClose = () => {};");
  const wrap = app.run(`reportPlanRegroupPicker(${REPORT_ITEM}, { id: 'p1', heading: '다음 주 계획', group: '운영툴' })`);
  const log = [];
  // 가짜 DOM의 classList는 아무 일도 하지 않으므로 부른 기록으로 확인한다.
  wrap.classList = { add: name => log.push(`+${name}`), remove: name => log.push(`-${name}`), contains: () => false, toggle() {} };
  wrap.children[0].listeners.click({ stopPropagation() {} });
  assert.deepEqual(log, ['+is-picking'], '펼치면 is-picking');
  const list = wrap.children[0].children.find(kid => kid.getAttribute && kid.getAttribute('role') === 'listbox');
  list.children.find(kid => kid.dataset.value === '').listeners.click({ stopPropagation() {} });
  assert.deepEqual(log, ['+is-picking', '-is-picking'], '고르면 풀린다');
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, 'report-ui.css'), 'utf8');
  assert.match(css, /\.d-mfield:has\(\.rp-regroup\.is-picking\) > \.ml \{[^}]*font-size: var\(--fs-cap\); font-weight: 600; color: var\(--muted\)/);
  assert.match(css, /\.rp-regroup \.d-gplist \{ padding: 2px; \}/);
});

// v1.3.0 비교(디자인): 프로젝트 고르기의 해제 항목 이름은 `프로젝트 빼기`, 숨은 `+ 한 줄 추가`는 높이도 0.
test('1.3.1 작은 것: 해제 항목은 프로젝트 빼기, 숨은 한 줄 추가는 높이 0 규칙', () => {
  const app = pureClient();
  app.run("jiraIssuesCache = []; customGroupsCache = ['운영툴']");
  const texts = JSON.parse(app.run("JSON.stringify(projectPickEntries({ type: 'group', value: '운영툴' }, false).filter(e => e.type === 'action').map(e => e.text))"));
  assert.ok(texts.includes('프로젝트 빼기'));
  assert.ok(!texts.includes('그룹 해제'));
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, 'report-ui.css'), 'utf8');
  assert.match(css, /\.rp-grp:not\(\.is-empty\):not\(:hover\):not\(:focus-within\) \.rp-s\.is-add:not\(\.is-open\) \{ height: 0;/);
  assert.match(css, /\.rp-pick \.cv svg \{[^}]*rotate\(90deg\)/);
});

// ---------- WP-Y — 내 일 기록 숫자를 보고 본문 `완료한 일` 기준(서버의 work)으로 ----------
// work = 업무 목록에서 센 날짜별 숫자(usage.js workDaysFrom 모양). 없거나 깨졌으면 history 기준(예전 그대로).
const wpyWork = (over = {}) => ({ done: {}, doneSlack: {}, inSlack: {}, inDirect: {}, records: {}, ...over });
function wpySummary(app, history, weekKeys, selected, work) {
  return JSON.parse(app.run(`JSON.stringify(usageWeeksSummary(${JSON.stringify(history)}, '${WPX_TODAY}', ${JSON.stringify(weekKeys)}, ${JSON.stringify(selected)},
    key => (${JSON.stringify({ '2026-09-28': '이번 주', '2026-09-21': '지난 주' })}[key] || '주' + key), key => '라벨' + key, ${JSON.stringify(work)}))`));
}

test('WP-Y 주차 목록 — work가 있으면 끝낸 일은 업무 기준(사용 기록의 task_done 무시), 90일보다 오래된 주도 같은 눈금으로 숫자, 오늘 뒤는 버림', () => {
  const app = usageWorkClient();
  // 사용 기록은 끝낸 일 0(앱에서 누르지 않음) — 본문 `완료한 일`은 업무 기준 2개(픽스처 장면).
  const history = { '2026-09-22': { tab_weekly: 1, task_done: 7 }, '2026-09-29': { jira_create: 1 } };
  const work = wpyWork({
    done: { '2026-06-02': 6, '2026-09-22': 1, '2026-09-24': 1, '2026-09-29': 3, '2026-10-02': 9 },
    inDirect: { '2026-09-23': 2 },
    records: { '2026-09-25': { decision: 1 } },
  });
  const keys = ['2026-09-28', '2026-09-21', '2026-09-14', '2026-06-01', '2026-05-25'];
  const summary = wpySummary(app, history, keys, '2026-09-21', work);
  assert.equal(summary.basis, 'work');
  assert.deepEqual(summary.weeks['2026-09-21'], { done: 2, days: 4, full: true }, '끝냄 2 · 기록 있는 날 = 끝냄·들어옴·남김 중 하나라도(9/22·23·24·25)');
  assert.deepEqual(summary.weeks['2026-09-28'], { done: 3, days: 1, full: true }, '오늘(9/30) 뒤 10/2는 버림, 지라만 있는 날(9/29 사용 기록)은 끝냄 날과 같은 날');
  assert.deepEqual(summary.weeks['2026-06-01'], { done: 6, days: 1, full: false }, '90일보다 오래된 주도 숫자(첫 기록 날 6/2가 주 중간이라 덜 찬 주)');
  assert.deepEqual(summary.weeks['2026-09-14'], { done: 0, days: 0, full: true });
  assert.equal(summary.weeks['2026-05-25'], null, '첫 기록 날보다 앞선 주');
  assert.equal(summary.max, 6, '눈금은 목록 안 최대(오래된 주 포함)');
  assert.equal(usagePartsText(summary.line), '지난 주에 일 2개를 끝냈어요');
  assert.equal(summary.average, '하루 평균 0.5개', '끝낸 일 ÷ 활동한 날(4)');
  assert.equal(summary.note, '지난 주에 끝낸 할 일·버그 수(보고에서 뺀 것 포함)');
  assert.equal(wpySummary(app, history, keys, '2026-09-28', work).note, '이번 주에 끝낸 할 일·버그 수(보고에서 뺀 것 포함)');
  assert.equal(wpySummary(app, history, keys, '2026-06-01', work).note, '주2026-06-01에 끝낸 할 일·버그 수(보고에서 뺀 것 포함)');
  assert.equal(wpySummary(app, history, keys, '2026-05-25', work).note, null, '기록 밖 주는 뜻 풀이 없음');
  // work가 없거나 깨졌으면 사용 기록 기준(예전 그대로 — 9/21 주는 task_done 7, 오래된 주는 칸 없음, 뜻 풀이 없음).
  for (const bad of [null, undefined, { done: 'x' }, [], wpyWork({ records: null })]) {
    const old = wpySummary(app, history, keys, '2026-09-21', bad);
    assert.equal(old.basis, 'usage', JSON.stringify(bad));
    assert.deepEqual(old.weeks['2026-09-21'], { done: 7, days: 1, full: false });
    assert.equal(old.weeks['2026-06-01'], null);
    assert.equal(old.note, null);
    assert.deepEqual(old, wpxSummary(app, history, keys, '2026-09-21'), '일곱째 인자가 없을 때와 같다');
  }
});

test('WP-Y usageWorkStats 다섯째 인자 work — 끝낸·들어온·남긴 기록(지라는 사용 기록)·하루 평균·막대가 업무 기준, 90일은 그대로 90일, 오래된 지난 주도 연다', () => {
  const app = usageWorkClient();
  const history = { '2026-09-29': { task_done: 9, task_add: 9, slack_in: 9, jira_create: 2, idea_add: 9 } };
  const work = wpyWork({
    done: { '2026-05-06': 4, '2026-09-28': 2, '2026-09-30': 1 }, doneSlack: { '2026-09-28': 1 },
    inSlack: { '2026-09-28': 3 }, inDirect: { '2026-09-29': 1 },
    records: { '2026-09-29': { decision: 1, check: 2 }, '2026-09-30': { idea: 1 } },
  });
  const stats = (range, options, w = work) => JSON.parse(app.run(`JSON.stringify(usageWorkStats(${JSON.stringify(history)}, '${WPX_TODAY}', '${range}', ${JSON.stringify(options)}, ${JSON.stringify(w)}))`));
  const week = stats('week', undefined);
  assert.equal(week.basis, 'work');
  assert.equal(week.doneNote, '이번 주에 끝낸 할 일·버그 수(보고에서 뺀 것 포함)');
  assert.equal(usagePartsText(week.headline), '이번 주 일 3개를 끝냈어요');
  assert.deepEqual(week.done, { total: 3, slack: 1 });
  assert.deepEqual(week.in, { total: 4, slack: 3, direct: 1 });
  assert.deepEqual(week.record, { total: 6, parts: [{ label: '결정', count: 1 }, { label: '아이디어', count: 1 }, { label: '지라', count: 2 }, { label: '확인 대기', count: 2 }] }, '지라만 사용 기록');
  assert.equal(week.recordedDays, 3);
  assert.equal(week.average, '1', '3 ÷ 활동한 날 3');
  assert.deepEqual(week.bars.slice(0, 3).map(bar => [bar.in, bar.done]), [[3, 2], [1, 0], [0, 1]]);
  assert.equal(stats('month', undefined).doneNote, '이번 달에 끝낸 할 일·버그 수(보고에서 뺀 것 포함)');
  const d90 = stats('90', undefined);
  assert.equal(d90.from, '2026-07-03');
  assert.equal(d90.done.total, 3, '90일 보기는 90일(5/6의 4개는 빠짐)');
  assert.equal(d90.doneNote, '최근 90일에 끝낸 할 일·버그 수(보고에서 뺀 것 포함)');
  // 90일보다 오래된 지난 주도 그 주 숫자로 연다(알게 된 것은 창 밖이라 없음).
  const old = stats('week', { week: '2026-05-04', name: '5월 1주차' });
  assert.equal(usagePartsText(old.headline), '5월 1주차에 일 4개를 끝냈어요');
  assert.equal(old.doneNote, '5월 1주차에 끝낸 할 일·버그 수(보고에서 뺀 것 포함)');
  assert.deepEqual(old.insights, []);
  // work가 없거나 깨졌으면 예전 그대로(사용 기록 기준, 뜻 풀이 없음).
  for (const bad of [null, { done: 1 }]) {
    const fallback = stats('week', undefined, bad);
    assert.equal(fallback.basis, undefined);
    assert.equal(fallback.doneNote, undefined);
    assert.deepEqual(fallback, usageStats(app, history, WPX_TODAY, 'week'));
  }
});

test('WP-Y 화면 — 주차 줄 끝 숫자·맨 위 판 요약·자세히 창 `끝낸 일` 타일이 업무 기준, 요약 줄·타일에 title과 읽어 주는 같은 뜻 글자', () => {
  const app = reportClient();
  app.run(fs.readFileSync(path.join(__dirname, 'usage-ui.js'), 'utf8'));
  app.run(`const __make = document.createElement;
    document.createElement = tag => Object.assign(__make(tag), { tagName: String(tag).toUpperCase(), style: {} });
    document.createElementNS = (ns, tag) => document.createElement(tag);
    document.createTextNode = value => ({ textContent: String(value), children: [] });`);
  app.run(`reportWeekName = key => (${JSON.stringify({ '2026-09-28': '이번 주', '2026-09-21': '지난 주' })}[key] || formatWeekLabel(key).week);
    renderWeeklyReportDetail = () => {};
    document.getElementById('weeklyReportDetail').contains = () => false;
    activeTabKey = 'weekly';
    usageInfo = { ok: true, today: '${WPX_TODAY}', days: 30, rows: [{ key: 'task_done', label: '할 일 끝냄', count: 0 }],
      history: { '2026-09-22': { tab_weekly: 3 } },
      work: ${JSON.stringify(wpyWork({ done: { '2026-06-03': 4, '2026-09-22': 2 }, inDirect: { '2026-09-22': 2 } }))} };
    selectedWeekKey = '2026-09-21';`);
  app.run(`renderWeeklyReports([{ weekKey: '2026-09-28', draft: { rows: [] } }, { weekKey: '2026-09-21', draft: { rows: [] } }, { weekKey: '2026-06-01', draft: { rows: [] } }])`);
  const nav = app.nodes.get('weeklyReportNav');
  const buttons = nav.children.filter(kid => kid.className === 'rp-wk');
  const endOf = button => button.children.find(kid => kid.className === 'd-uwend');
  assert.equal(endOf(buttons[1]).children[1].textContent, '2', '지난 주 = 본문 근거 2');
  assert.equal(endOf(buttons[1]).children[0].children[0].style.width, '50%', '목록 안 최대(오래된 주 4) 대비');
  assert.equal(endOf(buttons[2]).children[1].textContent, '4', '90일보다 오래된 주도 숫자');
  assert.equal(endOf(buttons[2]).children[0].children[0].style.width, '100%');
  assert.equal(endOf(buttons[0]).children[1].textContent, '0');
  const foot = nav.children[0];
  const first = foot.children[0].children[0];
  assert.equal(first.title, '지난 주에 끝낸 할 일·버그 수(보고에서 뺀 것 포함)');
  const hidden = first.children.find(kid => kid.className === 'sr-only');
  assert.equal(hidden.textContent, ' — 지난 주에 끝낸 할 일·버그 수(보고에서 뺀 것 포함)');
  assert.equal(wpxText(first).startsWith('하루 평균 2개'), true, '판 첫 줄은 하루 평균(끝낸 일 문장은 목록 줄 숫자와 겹쳐 빠짐)');
  assert.equal(foot.children[0].children.some(line => /끝냈어요/.test(wpxText(line))), false);
  // 자세히 창 — 지난 주 기준, 끝낸 일 타일에 같은 뜻.
  const link = foot.children[foot.children.length - 1];
  link.listeners.click();
  const body = app.run('usageWorkDlg.body');
  const tile = wpxFind(body, node => node.className === 'd-uwtile is-done');
  assert.equal(tile.title, '지난 주에 끝낸 할 일·버그 수(보고에서 뺀 것 포함)');
  assert.equal(tile.children.find(kid => kid.className === 'sr-only').textContent, tile.title);
  assert.equal(wpxText(wpxFind(tile, node => node.className === 'd-uwv')), '2개');
  // 기능별 전체 보기 표는 사용 기록(rows) 그대로.
  assert.equal(wpxText(wpxFind(body, node => node.tagName === 'TD')), '0');
  app.run('usageWorkClose()');
  // 업무 기록을 못 읽었으면(work: null) 옛 사용 기록으로 떨어지지 않는다 — 줄 끝 칸 모두 없음, 맨 아래는 한 줄 + 자세히 링크.
  app.run(`usageInfo = { ...usageInfo, work: null, history: { '2026-09-22': { task_done: 5 } } }; renderWeeklyReports(weeklyReportsCache);`);
  const rows2 = nav.children.filter(kid => kid.className === 'rp-wk');
  assert.equal(rows2.some(button => endOf(button)), false, '줄 끝 막대·숫자 모두 없음');
  assert.equal(rows2.some(button => /끝낸 일/.test(button.getAttribute('aria-label'))), false);
  const foot2 = nav.children[0];
  assert.equal(foot2.className, 'd-uwfoot is-failed');
  assert.deepEqual(foot2.children[0].children.map(wpxText), ['끝낸 일을 읽지 못했어요']);
  assert.equal(foot2.children[0].children[0].title, undefined);
  const link2 = foot2.children[foot2.children.length - 1];
  assert.equal(link2.textContent, '내 일 기록 자세히');
  link2.listeners.click();
  const body2 = app.run('usageWorkDlg.body');
  assert.equal(wpxText(wpxFind(body2, node => node.className === 'd-ismall d-uwempty')), '끝낸 일을 읽지 못했어요');
  assert.equal(wpxFind(body2, node => /d-uwtile|d-uwbig|d-uwhead|d-uwchart/.test(String(node.className || ''))), null, '숫자·기간 전환·막대 없음');
  assert.ok(wpxFind(body2, node => node.tagName === 'TABLE'), '기능별 전체 보기는 그대로');
  app.run('usageWorkClose()');
  // 응답에 work 칸 자체가 없으면(예전 응답) 사용 기록 기준 그대로.
  app.run(`usageInfo = { ok: true, today: '${WPX_TODAY}', days: 30, rows: [], history: { '2026-09-22': { task_done: 5 } } }; renderWeeklyReports(weeklyReportsCache);`);
  assert.equal(endOf(nav.children.filter(kid => kid.className === 'rp-wk')[1]).children[1].textContent, '5');
});

test('WP-Y 자세히 창 타일 작은 글자 — 들어온 일은 0인 항목을 빼고(둘 다 0이면 빈칸), 끝낸 일 `그중 슬랙 0`도 없다', () => {
  const app = wpxDomClient();
  const tilesOf = work => {
    app.run(`usageWorkDlg = null; usageInfo = { ok: true, today: '${WPX_TODAY}', days: 30, rows: [], history: {}, work: ${JSON.stringify(work)} }; usageWorkOpen(document.createElement('button'), null);`);
    const body = app.run('usageWorkDlg.body');
    return wpxAll(body, node => /^d-uwtile( |$)/.test(String(node.className || ''))).map(tile => wpxText(wpxFind(tile, node => node.className === 'd-uws')));
  };
  assert.deepEqual(tilesOf(wpyWork({ done: { '2026-09-29': 2 }, inDirect: { '2026-09-29': 3 } })), ['직접\u00a03', '', '']);
  assert.deepEqual(tilesOf(wpyWork({ done: { '2026-09-29': 2 }, inSlack: { '2026-09-29': 1 }, inDirect: { '2026-09-29': 3 }, doneSlack: { '2026-09-29': 1 } })), ['슬랙\u00a01 · 직접\u00a03', '그중\u00a0슬랙\u00a01', '']);
  assert.deepEqual(tilesOf(wpyWork({ done: { '2026-09-29': 2 } })), ['', '', ''], '둘 다 0이면 빈칸');
});

// ─── 개편 A 7단계 주간요약: 보내기 전 확인 · 확인 필요(서버 판단, 화면은 표시만) · 근거 한 줄 · 접힘 줄(넣기·되살리기) · 복사 버튼 한 자리 ───
const A7_ROWS = `[
  { id: 's1', heading: '완료한 일', group: '가입', groupKey: 'group:가입', text: '원본 바뀐 문장', sourceIds: ['t2'], excluded: false, locked: true, needsReview: true,
    review: { reason: 'undone' }, suggestion: { text: '다른 문장', added: 0, missing: false, mixed: false } },
  { id: 'r1', heading: '완료한 일', group: '가입', groupKey: 'group:가입', text: '확인할 문장', sourceIds: ['t3'], excluded: false, needsReview: true, review: { reason: 'marked' },
    currentEvidence: [{ id: 't3', description: '환불 표 정리하기 (확인 필요)', status: 'done', type: 'task', outcome: '' }] },
  { id: 'o1', heading: '완료한 일', group: '가입', groupKey: 'group:가입', text: '결과 있는 문장', sourceIds: ['t6'], excluded: false,
    currentEvidence: [{ id: 't6', description: '문구 검토하기', status: 'done', type: 'task', outcome: '문구 12개 넘김' }] },
  { id: 'p0', heading: '완료한 일', group: '운영', groupKey: 'group:운영', text: '운영 요약', sourceIds: [], excluded: false, manual: true, folded: true },
  { id: 'k1', heading: '완료한 일', group: '운영', groupKey: 'group:운영', text: '가려진 문장', sourceIds: ['t4'], excluded: false, parent: 'p0', review: { reason: 'missing' } },
  { id: 'c1', heading: '진행중', group: '결제', groupKey: 'group:결제', text: '끝난 진행 문장', sourceIds: ['t1'], excluded: false, locked: true, completable: true, needsReview: true,
    suggestion: { text: '끝남', added: 0, missing: false, mixed: false } },
  { id: 'x1', heading: '완료한 일', group: '가입', groupKey: 'group:가입', text: '뺀 문장 하나\\n둘째 줄', sourceIds: ['t5'], excluded: true, needsReview: true },
  { id: 'pl', heading: '다음 주 계획', group: '가입_개선', text: 'A/B 결과 공유', sourceIds: [], excluded: false }
]`;
const A7_ITEM = `{ weekKey: '2026-09-14', draft: { revision: 1, rows: ${A7_ROWS}, review: { count: 3, first: 's1' },
  material: { pending: [{ id: 'n1', description: '알림 발송 로그 확인', label: '알림 센터', completed: '2026-09-16' }] },
  confirmed: { at: '2026-09-16T00:00:00Z', pending: 1, pendingDone: 1 } } }`;
function a7Client() {
  const app = reportClient();
  app.context.document.createTextNode = text => ({ textContent: String(text) });
  app.run(`calls = []; reportChange = async (target, action) => { calls.push(action); }; renderReportDraft = () => {}; item = ${A7_ITEM};`);
  return app;
}
const a7Line = (app, id) => app.run(`(() => { const host = document.createElement('div');
  reportSentenceRow(item, item.draft.rows.find(row => row.id === '${id}'), { host, newIds: new Set() }); return host.children[0]; })()`);
const a7Kid = (node, cls) => (node.children || []).find(kid => String(kid && kid.className).split(' ').includes(cls));

test('개편 A: 줄 끝 한 마디는 끝났어요 > 제안 알약 > 확인 필요 순서로 하나만 — 확인 필요는 바탕 없는 주황 글자, 이유는 풍선', () => {
  const app = a7Client();
  const done = a7Line(app, 'c1');
  assert.equal(a7Kid(done, 'rp-end').className, 'rp-end is-ok', '끝났어요가 제안 알약보다 먼저');
  assert.equal(a7Kid(done, 'rp-pill'), undefined);
  const changed = a7Line(app, 's1');
  const pill = a7Kid(changed, 'rp-pill');
  assert.equal(pill.textContent, '원본 바뀜', '제안 알약이 확인 필요보다 먼저');
  assert.equal(pill.title, '근거 업무가 아직 끝나지 않았어요 — 문장은 완료한 일 칸에 있어요', '그 줄의 확인 필요 이유는 알약 풍선에');
  assert.equal(a7Kid(changed, 'rp-end'), undefined);
  assert.equal(changed.dataset.review, 'true');
  const warn = a7Kid(a7Line(app, 'r1'), 'rp-end');
  assert.deepEqual([warn.className, warn.textContent, warn.title], ['rp-end is-warn', '확인 필요', '업무 제목에 (확인 필요)·(미확정) 표시가 있어요']);
  const folded = a7Line(app, 'p0');
  assert.equal(a7Kid(folded, 'rp-end').title, '근거 업무가 지워졌어요', '접힌 부모는 가려진 아래 문장의 이유를 빌린다');
  assert.equal(a7Kid(a7Line(app, 'o1'), 'rp-end'), undefined);
  assert.equal(a7Line(app, 'o1').dataset.review, undefined);
  // 옛 서버(응답에 review 없음) — needsReview로 `확인 필요`만.
  app.run(`item = { weekKey: '2026-09-14', draft: { revision: 1, rows: [
    { id: 'l1', heading: '완료한 일', group: '가입', text: '옛 서버 문장', sourceIds: ['t1'], excluded: false, needsReview: true },
    { id: 'l2', heading: '완료한 일', group: '가입', text: '평범한 문장', sourceIds: ['t2'], excluded: false } ] } };`);
  const old = a7Kid(a7Line(app, 'l1'), 'rp-end');
  assert.deepEqual([old.textContent, old.title], ['확인 필요', '원본을 확인해 주세요']);
  assert.equal(a7Kid(a7Line(app, 'l2'), 'rp-end'), undefined);
  assert.equal(app.run('reportReviewCount(item.draft)'), 1, '옛 서버는 화면에 보이는 줄 수');
});

test('개편 A: `확인 필요 N ›`은 서버의 첫 문장부터 문서 순서로 차례로 가고(접힌 부모 한 번), 그 문장 글자에 초점을 둔다', () => {
  const app = a7Client();
  assert.deepEqual(JSON.parse(app.run('JSON.stringify(reportReviewTargets(item.draft))')), ['s1', 'r1', 'p0']);
  assert.equal(app.run('reportReviewButton(item)').getAttribute('aria-label'), '확인 필요 3개 중 1번째로 이동');
  assert.equal(app.run('reportReviewCount(item.draft)'), 3, '머리 한 줄은 서버 개수');
  app.run(`focused = []; document.getElementById('weeklyReportDetail').querySelector = sel => (/data-edit-text/.test(sel) ? { focus() { focused.push(sel); }, scrollIntoView() {} } : null);`);
  const go = () => { app.run('reportReviewGo(item)'); return app.run('reportReviewPick'); };
  assert.deepEqual([go(), go(), go(), go()], ['s1', 'r1', 'p0', 's1']);
  assert.match(app.run('focused[0]'), /data-edit-text="s1"/);
  const button = app.run('reportReviewButton(item)');
  assert.deepEqual([button.className, button.children[0].textContent, button.getAttribute('aria-label')], ['rp-go', '확인 필요 3', '확인 필요 3개 중 2번째로 이동'], '지금 s1에 있으니 다음은 2번째');
  app.run("reportReviewPick = 'p0'");
  assert.equal(app.run('reportReviewButton(item)').getAttribute('aria-label'), '확인 필요 3개 중 1번째로 이동', '끝이면 처음으로 돈다');
  // 편집 중에 누르면 적던 글은 그대로 두고 이동만 한다.
  app.run(`reportEdits.set('2026-09-14:o1', '적던 글'); reportReviewPick = null;`);
  go();
  assert.equal(app.run("reportEdits.get('2026-09-14:o1')"), '적던 글');
});

test('개편 A: 고르거나 고치는 문장 아래 근거 한 줄 — 업무 제목·상태, 끝낸 업무의 결과 한 줄이 비면 주황 글자, 계획·근거 없는 줄은 없음', () => {
  const app = a7Client();
  assert.equal(a7Kid(a7Line(app, 'r1'), 'rp-ev1'), undefined, '평소에는 없다');
  app.run("reportReviewPick = 'r1'");
  const line = a7Line(app, 'r1');
  const ev = a7Kid(line, 'rp-ev1');
  assert.deepEqual(ev.children.map(kid => kid.textContent), ['근거', '·', '환불 표 정리하기 (확인 필요)', '·', '완료', '·', '결과 한 줄 비었어요']);
  assert.equal(ev.children[6].className, 'w');
  assert.equal(ev.children[1].getAttribute('aria-hidden'), 'true');
  // 고치는 중이면 입력칸 아래(글 칸 구성은 그대로 — 입력칸 + 안내 한 줄).
  app.run("reportReviewPick = null; reportEdits.set('2026-09-14:o1', '결과 있는 문장')");
  const editing = a7Line(app, 'o1');
  assert.deepEqual(a7Kid(editing, 'tx').children.map(kid => kid.className), ['rp-ta', 'rp-help']);
  assert.deepEqual(a7Kid(editing, 'rp-ev1').children.map(kid => kid.textContent), ['근거', '·', '문구 검토하기', '·', '완료'], '결과 한 줄이 있으면 주황 글자 없음');
  app.run("reportEdits.set('2026-09-14:pl', 'A/B 결과 공유')");
  assert.equal(a7Kid(a7Line(app, 'pl'), 'rp-ev1'), undefined, '다음 주 계획에는 근거 줄이 없다');
  assert.equal(app.run("reportEvidenceLine({ heading: '완료한 일', sourceIds: [] }, [])"), null);
  const gone = app.run("reportEvidenceLine({ heading: '완료한 일', sourceIds: ['a', 'b'], currentEvidence: [{ id: 'a', description: '남은 업무', status: 'to-do', type: 'task' }] }, [])");
  assert.deepEqual(gone.children.filter(kid => kid.className !== 'dot').map(kid => [kid.textContent, kid.className]),
    [['근거', 'k'], ['남은 업무', 't'], ['미완료', 'w'], ['지워진 업무 1개', 'w']]);
});

test('개편 A: 복사 버튼은 화면에 하나 — 좁은 폭(matchMedia 없음 포함)은 문서 머리 + 왼쪽 `확인 필요 N ›`, 넓은 폭은 슬랙 카드 머리 + `보내기 전 확인` 줄', () => {
  const app = a7Client();
  const copies = () => app.run(`(() => {
    const doc = document.createElement('div'); reportDocHead(item, doc);
    reportPreview(item.draft, item);
    const all = []; const walk = node => { if (!node || typeof node !== 'object') return; if (node.textContent === '슬랙용으로 복사') all.push(node); (node.children || []).forEach(walk); };
    walk(doc); const inDoc = all.length; walk(document.getElementById('weeklyReportPreview'));
    return { inDoc, total: all.length, acts: doc.children[0].children.find(kid => kid.className === 'rp-acts').children.map(kid => kid.className) };
  })()`);
  const narrow = copies();
  assert.deepEqual([narrow.inDoc, narrow.total], [1, 1]);
  assert.equal(narrow.acts.indexOf('rp-go') + 1, narrow.acts.indexOf('d-btn pri'), '`확인 필요 N ›`은 복사 버튼 바로 왼쪽');
  const preview = app.nodes.get('weeklyReportPreview');
  assert.equal(preview.children.some(kid => kid.className === 'rp-check'), false, '좁은 폭에는 슬랙 카드의 확인 줄이 없다');
  app.run('window.matchMedia = query => ({ matches: false })');
  const wide = copies();
  assert.deepEqual([wide.inDoc, wide.total], [0, 1]);
  assert.equal(wide.acts.includes('rp-go'), false);
  const top = preview.children[0];
  assert.deepEqual(top.children.map(kid => kid.className), ['rp-slackhd', 'd-btn pri']);
  const check = preview.children[1];
  assert.equal(check.className, 'rp-check');
  assert.deepEqual(check.children.map(kid => [kid.className, kid.textContent || kid.children[0].textContent]), [['hl', '보내기 전 확인'], ['rp-go', '확인 필요 3']]);
  assert.deepEqual(preview.children.map(kid => kid.className), ['rp-slacktop', 'rp-check', 'rp-flw', 'rp-secs', 'rp-slackbox']);
  // 걸린 문장이 없으면 회색 한 마디, 보낼 문장이 없으면 그 말.
  app.run(`reportPreview({ ...item.draft, review: { count: 0, first: null } }, { ...item, draft: { ...item.draft, review: { count: 0, first: null } } })`);
  assert.deepEqual(preview.children[1].children.map(kid => kid.textContent), ['보내기 전 확인', '확인할 것 없어요']);
  app.run(`reportPreview({ weekKey: '2026-09-14', rows: [], review: { count: 0, first: null } }, { weekKey: '2026-09-14', draft: { weekKey: '2026-09-14', rows: [], review: { count: 0, first: null } } })`);
  assert.deepEqual(preview.children[1].children.map(kid => kid.textContent), ['보내기 전 확인', '보낼 문장이 아직 없어요']);
  // 고치는 중이면 어느 자리든 3차.
  app.run("reportEdits.set('2026-09-14:r1', '고치는 중')");
  assert.equal(copies().total, 1);
  assert.equal(preview.children[0].children[1].className, 'd-btn');
});

test('개편 A: 슬랙 카드 맨 위 접힘 줄 — `보고에 없는 끝낸 일 N · 뺀 문장 N`, 펼치면 줄마다 넣기(pullOne)·되살리기(exclude), 둘 다 0이면 없다', async () => {
  const app = a7Client();
  const block = app.run('reportMaterialBlock(item)');
  const [toggle, body] = block.children;
  assert.equal(block.className, 'rp-flw');
  assert.equal(toggle.children[0].textContent, '보고에 없는 끝낸 일 1 · 뺀 문장 1');
  assert.deepEqual([toggle.getAttribute('aria-expanded'), toggle.getAttribute('aria-controls'), body.id, body.hidden], ['false', 'reportMaterialBody', 'reportMaterialBody', true]);
  toggle.listeners.click();
  assert.deepEqual([toggle.getAttribute('aria-expanded'), body.hidden, app.run('reportMaterialOpen')], ['true', false, true]);
  assert.deepEqual(body.children.map(kid => kid.className), ['g', 'mr', 'g', 'mr']);
  const take = body.children[1].children[1].children[1];
  assert.deepEqual([body.children[1].children[1].children[0].textContent, take.textContent, take.getAttribute('aria-label')], ['알림 센터 · 9/16', '넣기', '알림 발송 로그 확인 — 보고에 넣기']);
  await take.listeners.click();
  const back = body.children[3].children[1].children[0];
  assert.equal(body.children[3].children[0].textContent, '뺀 문장 하나', '뺀 문장은 첫 줄만');
  await back.listeners.click();
  assert.deepEqual(JSON.parse(app.run('JSON.stringify(calls)')), [{ action: 'pullOne', ids: ['n1'] }, { action: 'exclude', id: 'x1' }]);
  // 확정하지 않은 주·옛 서버(material 없음)는 뺀 문장만, 둘 다 없으면 줄이 없다.
  assert.equal(app.run(`reportMaterialBlock({ ...item, draft: { ...item.draft, confirmed: null } }).children[0].children[0].textContent`), '뺀 문장 1');
  assert.equal(app.run(`reportMaterialBlock({ ...item, draft: { ...item.draft, material: undefined } }).children[0].children[0].textContent`), '보고에 없는 새 줄 1 · 뺀 문장 1',
    '옛 서버(material 없음)도 확정 뒤 새 줄은 모두 넣기로 넣을 수 있다');
  assert.equal(app.run(`reportMaterialBlock({ ...item, draft: { ...item.draft, rows: item.draft.rows.filter(row => !row.excluded), material: { pending: [] }, confirmed: { at: 'x', pending: 0, pendingDone: 0 } } })`), null);
  // 머리 ⋯ `제외한 문장 보기`는 이 줄을 펼친다(문서 맨 아래 접힘은 없다).
  app.run('reportMaterialOpen = false');
  const menu = app.run('reportHeadMenuSections(item)');
  const open = menu[1].find(entry => /^제외한 문장 보기/.test(entry.label));
  open.onClick();
  assert.equal(app.run('reportMaterialOpen'), true);
  assert.equal(app.run("typeof reportExcludedBlock"), 'undefined');
  assert.match(REPORT_A7_UI(), /REPORT_MOVE_NOTICE = \{[\s\S]*pullOne: '보고에 한 줄 넣었어요'/);
});
const REPORT_A7_UI = () => fs.readFileSync(path.join(__dirname, 'report-ui.js'), 'utf8');

test('개편 A: 넣을 구역은 글자 고르개 하나 — 메뉴 안 체크 줄로 켜고 끄고(저장 키 그대로), 내용 없는 구역은 잠긴다', () => {
  const app = a7Client();
  const saved = new Map();
  app.context.localStorage = { getItem: key => (saved.has(key) ? saved.get(key) : null), setItem: (key, value) => saved.set(key, String(value)) };
  app.run(`menus = []; uiMenu = (anchor, sections) => { const list = document.createElement('div'); menus.push([anchor, sections, list]); return list; };`);
  const wrap = app.run('reportSlackChips(item.draft)');
  const pick = wrap.children[0];
  assert.deepEqual(pick.children.map(kid => kid.className), ['k', 'v', 'cv']);
  assert.equal(pick.children[1].textContent, '완료 · 진행 중 · 예정');
  assert.equal(pick.getAttribute('aria-label'), '슬랙에 넣을 구역: 완료 · 진행 중 · 예정 — 고르기');
  pick.listeners.click({ stopPropagation() {} });
  const list = app.run('menus[0][2]');
  assert.deepEqual(list.children.map(row => [row.children[1].textContent, row.children[0].checked, row.children[0].disabled]),
    [['완료', true, false], ['진행 중', true, false], ['결정', false, true], ['확인 대기', false, true], ['예정', true, false]]);
  const doing = list.children[1].children[0];
  doing.checked = false;
  doing.listeners.change();
  assert.equal(pick.children[1].textContent, '완료 · 예정', '얼굴 글자가 바로 바뀐다');
  assert.deepEqual(JSON.parse(saved.get('workspace-report-slack-sections')).on, ['완료', '예정']);
});

test('개편 A(B8): 다음 주 계획 소제목은 위 칸과 같은 표기(색 점 + 밑줄 없는 이름) — 슬랙 글도 `가입 개선`, 지라 정보는 원래 이름으로 찾는다', () => {
  const app = reportClient();
  assert.equal(app.run("reportPlanShownName('가입_개선')"), '가입 개선');
  assert.equal(app.run("reportPlanShownName('IO-1 · 예시 게시글 작성하기_샘플 기능')"), 'IO-1 · 예시 게시글 작성하기_샘플 기능', '지라 이름의 밑줄은 그대로');
  const head = app.run(`reportPlanProjectHead('가입 개선', null, '가입_개선')`);
  assert.deepEqual(head.children.map(kid => [kid.className, kid.textContent]), [['d-pjdot', ''], ['nm', '가입 개선']]);
  const report = `{ weekKey: '2026-09-21', rows: [
    { id: 'p1', heading: '다음 주 계획', group: '가입_개선', text: 'A/B 결과 공유', sourceIds: [], excluded: false },
    { id: 'p2', heading: '다음 주 계획', group: 'IO-1 · 예시 게시글 작성하기_샘플 기능', text: '임베드 QA', sourceIds: [], excluded: false } ] }`;
  const text = app.run(`reportSlackText(reportSlackModel(${report}, { sections: ['예정'] }))`);
  assert.equal(text, ['9월 4주차 (9/21~9/27)', '', '[예정]', '', '가입 개선', '• A/B 결과 공유', '', '예시 게시글 작성하기_샘플 기능', '• 임베드 QA'].join('\n'));
  const projects = JSON.parse(app.run(`JSON.stringify(reportSlackModel(${report}, { sections: ['예정'] }).sections[0].projects.map(p => [p.name, p.source || null]))`));
  assert.deepEqual(projects, [['가입 개선', '가입_개선'], ['IO-1 · 예시 게시글 작성하기_샘플 기능', null]]);
  app.run(`workflowData = { items: [], meetings: [], projectLinks: { '가입_개선': 'PAY-77' } }; jiraIssuesByKey = new Map([['PAY-77', { key: 'PAY-77', status: 'QA 대기', versions: [] }]]);`);
  assert.match(app.run(`reportSlackText(reportSlackModel(${report}, { sections: ['예정'], jira: true }))`), /^가입 개선 \(QA 대기\)$/m, '지라 정보는 저장된 이름(연결)으로 찾는다');
});

test('개편 A: 슬랙 복사 결과(reportSlackModel·Text·Html·Lines)는 v1.3.0과 한 글자도 같다 — 가입_개선(다음 주 계획 밑줄 이름) 한 건만 예외, review·material·needsReview와 무관', () => {
  let oldUi = '';
  try { oldUi = require('node:child_process').execFileSync('git', ['show', 'v1.3.0:tracker/inbox-app/report-ui.js'], { cwd: __dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch {}
  const fresh = reportClient();
  const now = code => fresh.run(code);
  const corpus = [REPORT_ROWS, REPORT_RECORD_ROWS, REPORT_SLACK_ROWS, REPORT_NEST_ROWS, REPORT_FOLD_PICK_ROWS, REPORT_FOLD_ROWS, POLISH_ROWS, B_ROWS,
    JSON.stringify(JSON.parse(REPORT_JIRA_REPORT).rows), A7_ROWS.replace("group: '가입_개선'", "group: '가입 개선'")];
  const outputs = (run) => corpus.flatMap(rows => ['undefined', "{ sections: ['완료', '진행 중', '결정', '확인 대기', '예정'] }", "{ sections: ['완료', '진행 중', '예정'], jira: true }"].map((options) => {
    run(REPORT_JIRA_SETUP);
    const call = `reportSlackModel({ weekKey: '2026-09-21', title: null, rows: ${rows} }, ${options})`;
    return run(`JSON.stringify([${call}, reportSlackText(${call}), reportSlackHtml(${call}), reportSlackLines(${call})])`);
  }));
  const mine = outputs(now);
  // 확인 필요·재료·옛 표시 칸을 붙여도(또는 떼도) 같은 글자다.
  const stripped = code => now(`JSON.stringify((${code}).map(row => { const { review, needsReview, ...rest } = row; return rest; }))`);
  const decorate = code => now(`JSON.stringify((${code}).map(row => ({ ...row, review: { reason: 'marked' }, needsReview: true })))`);
  for (const rows of corpus) {
    const a = now(`reportSlackText(reportSlackModel({ weekKey: '2026-09-21', rows: ${stripped(rows)}, material: { pending: [] } }))`);
    const b = now(`reportSlackText(reportSlackModel({ weekKey: '2026-09-21', rows: ${decorate(rows)}, review: { count: 9, first: 'x' }, material: { pending: [{ id: 'n' }] } }))`);
    assert.equal(a, b);
  }
  if (!oldUi) return;
  const old = pureClient();
  old.run(oldUi);
  assert.deepEqual(outputs(code => old.run(code)), mine, '기존 픽스처 전부 같은 글자');
  // 예외 한 건 — 다음 주 계획의 밑줄 이름만 `가입 개선`으로.
  const plan = A7_ROWS;
  const both = [now, code => old.run(code)].map(run => run(`reportSlackText(reportSlackModel({ weekKey: '2026-09-21', rows: ${plan} }))`));
  assert.notEqual(both[0], both[1]);
  assert.equal(both[0], both[1].replace('가입_개선', '가입 개선'));
});

test('개편 A: 주간요약을 다시 그려도 주차 칸 맨 위 `내 일 기록` 판은 하나(빠지거나 두 번 붙지 않는다)', () => {
  const app = reportClient();
  app.run(fs.readFileSync(path.join(__dirname, 'usage-ui.js'), 'utf8'));
  app.run(`const __make = document.createElement;
    document.createElement = tag => Object.assign(__make(tag), { tagName: String(tag).toUpperCase(), style: {} });
    document.createElementNS = (ns, tag) => document.createElement(tag);
    document.createTextNode = value => ({ textContent: String(value), children: [] });
    escDrop = () => {}; escPush = () => {};
    document.body = document.createElement('body');
    document.getElementById('weeklyReportDetail').contains = () => false;
    activeTabKey = 'weekly';
    usageInfo = { ok: true, today: '${WPX_TODAY}', rows: [], history: { '2026-09-01': { search: 1 }, '2026-09-22': { task_done: 4 }, '2026-09-29': { task_done: 2 } } };`);
  const weeks = `[{ weekKey: '2026-09-28', draft: { revision: 1, rows: ${A7_ROWS}, review: { count: 3, first: 's1' }, material: { pending: [] } } }, { weekKey: '2026-09-21', draft: { revision: 2, rows: [] } }]`;
  app.run(`renderWeeklyReports(${weeks})`);
  const nav = app.nodes.get('weeklyReportNav');
  const boards = () => nav.children.filter(kid => /^d-uwfoot/.test(String(kid.className)));
  assert.equal(boards().length, 1);
  assert.equal(nav.children[0], boards()[0], '첫 주 앞(맨 위)');
  app.run(`renderWeeklyReports(weeklyReportsCache); renderWeeklyReports(weeklyReportsCache); reportChange = async () => {}; renderReportDraft(weeklyReportsCache[0]);`);
  assert.equal(boards().length, 1, '다시 그려도 하나');
  assert.equal(nav.children[0], boards()[0]);
  const index = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  assert.match(index, /<aside class="rp-slack" id="weeklyReportPreview" aria-label="슬랙 미리보기"><\/aside>/, '오른쪽 칸 구조는 그대로');
  assert.equal((index.match(/id="weeklyReportNav"/g) || []).length, 1);
});

test('개편 A 화면 규칙: 새 innerHTML은 uiIcon뿐, 확인 필요·끝났어요는 토큰 글자색(새 색 없음), 왼쪽 색 세로줄 없음, 접힘 꺾쇠는 reduced-motion에서 멈춘다', () => {
  const ui = REPORT_A7_UI();
  const start = ui.indexOf('// ---------- 보내기 전 확인(개편 A) ----------');
  assert.ok(start > 0);
  const lines = ui.split('\n').filter(line => /innerHTML/.test(line));
  assert.ok(lines.every(line => /innerHTML = uiIcon\('(chevron|plus|check)'\)/.test(line)), lines.join('\n'));
  const css = fs.readFileSync(path.join(__dirname, 'report-ui.css'), 'utf8');
  const block = css.slice(css.indexOf('/* 줄 끝 한 마디(개편 A)'), css.indexOf('/* 소제목 묶음 맨 아래'));
  assert.match(block, /\.rp-s \.rp-end\.is-warn \{ color: var\(--warn\);/);
  assert.match(block, /\.rp-s\.is-hit \{ background: var\(--sel\); \}/);
  const card = css.slice(css.indexOf('/* 머리(개편 A)'), css.indexOf('/* 한 줄이 곧 붙여 넣을 한 줄이다'));
  assert.doesNotMatch(block + card, /#[0-9a-fA-F]{3,8}\b|rgb\(/, '색은 토큰만');
  assert.doesNotMatch(block + card, /border-left:\s*[2-9]px/, '왼쪽 색 세로줄 없음');
  assert.match(card, /@media \(prefers-reduced-motion: reduce\) \{ \.rp-fl \.d-i \{ transition: none; \} \}/);
  assert.doesNotMatch(css, /\.rp-ex\b|\.rp-pill\.is-done|\.rp-secg/, '옛 부품(문서 맨 아래 제외 접힘·초록 알약·구역 칩 묶음)은 지웠다');
});

test('개편 A 검수: 접힘 줄의 `보고에 없는 끝낸 일 N` 머리 오른쪽 `모두 넣기`는 2줄 이상일 때만이고 기존 pullNew를 보내며, 문서 위 확정 줄에는 버튼이 없다', async () => {
  const app = a7Client();
  const two = `{ ...item, draft: { ...item.draft, material: { pending: [
    { id: 'n1', description: '알림 발송 로그 확인', label: '알림 센터', completed: '2026-09-16' },
    { id: 'n2', description: '가입 카피 최종 확인', label: '가입 개선', completed: '2026-09-17' } ] },
    confirmed: { at: '2026-09-16T00:00:00Z', pending: 2, pendingDone: 2 } } }`;
  const body = app.run(`reportMaterialBlock(${two})`).children[1];
  const head = body.children[0];
  assert.equal(head.className, 'g');
  assert.equal(head.children[0].textContent, '보고에 없는 끝낸 일 2');
  const all = head.children[1];
  assert.deepEqual([all.textContent, all.className, all.getAttribute('aria-label')], ['새로 들어온 줄 2 모두 넣기', 'rp-all', '확정 뒤 새로 들어온 줄 2개 모두 보고에 넣기']);
  await all.listeners.click();
  assert.deepEqual(JSON.parse(app.run('JSON.stringify(calls)')), [{ action: 'pullNew' }]);
  const one = app.run('reportMaterialBlock(item)').children[1].children[0];
  assert.deepEqual([one.textContent, one.children.length], ['보고에 없는 끝낸 일 1', 0], '1줄이면 머리 글만');
  const top = app.run(`(() => { const host = document.createElement('div'); reportTopBlock(item, host); return host; })()`);
  assert.deepEqual(top.children[0].children[0].children.map(kid => kid.textContent), ['9/16에 확정했어요 · 그 뒤 1줄이 새로 끝났어요']);
  const ui = REPORT_A7_UI();
  assert.doesNotMatch(ui.slice(ui.indexOf('function reportTopBlock'), ui.indexOf('function reportConfirmedText')), /pullNew/);
  assert.match(ui, /REPORT_MOVE_NOTICE = \{[\s\S]*pullNew: '새로 들어온 줄을 보고에 넣었어요'/, '알림·되돌리기는 기존 그대로');
});

test('개편 A 99 리뷰 장면①: 확정 뒤 진행 중 업무만 새로 들어오면(끝낸 일 0) 접힘 줄이 `보고에 없는 새 줄 1`로 서고 `보고에 넣기`(한 줄이면 이 이름)가 pullNew를 보낸다', async () => {
  const app = a7Client();
  app.run(`item = { weekKey: '2026-09-14', draft: { revision: 1, rows: [], review: { count: 0, first: null }, material: { pending: [] },
    confirmed: { at: '2026-09-16T00:00:00Z', pending: 1, pendingDone: 0 } } };`);
  assert.equal(app.run('reportConfirmedText(item.draft.confirmed)'), '9/16에 확정했어요 · 그 뒤 1줄이 새로 들어왔어요');
  const block = app.run('reportMaterialBlock(item)');
  assert.ok(block, '끝낸 일이 0이어도 접힘 줄이 있다');
  assert.equal(block.children[0].children[0].textContent, '보고에 없는 새 줄 1');
  const head = block.children[1].children[0];
  assert.equal(head.children[0].textContent, '보고에 없는 새 줄 1');
  const all = head.children[1];
  assert.equal(all.textContent, '보고에 넣기', '한 줄씩 넣을 수 없는 줄이 있으면 1줄이어도 선다');
  await all.listeners.click();
  assert.deepEqual(JSON.parse(app.run('JSON.stringify(calls)')), [{ action: 'pullNew' }]);
});
test('개편 A 99 리뷰 장면②: 끝낸 일 2 + 진행 중 1이면 요약은 `끝낸 일 2 · 새 줄 1`, 전부 넣기 이름은 실제로 넣는 수 `새로 들어온 줄 3 모두 넣기`', () => {
  const app = a7Client();
  app.run(`item = { weekKey: '2026-09-14', draft: { revision: 1, rows: [], review: { count: 0, first: null },
    material: { pending: [{ id: 'n1', description: '가', label: '가입', completed: '2026-09-16' }, { id: 'n2', description: '나', label: '결제', completed: '2026-09-16' }] },
    confirmed: { at: '2026-09-16T00:00:00Z', pending: 3, pendingDone: 2 } } };`);
  const block = app.run('reportMaterialBlock(item)');
  assert.equal(block.children[0].children[0].textContent, '보고에 없는 끝낸 일 2 · 새 줄 1');
  const body = block.children[1];
  assert.equal(body.children[0].children[0].textContent, '보고에 없는 끝낸 일 2');
  assert.equal(body.children[0].children[1].textContent, '새로 들어온 줄 3 모두 넣기');
  assert.equal(body.children.filter(kid => kid.className === 'mr').length, 2, '한 줄씩 넣기는 끝낸 일만');
});
test('개편 A 99 리뷰: `확인 필요 N`의 숫자와 aria의 N은 화면이 실제로 들르는 줄 수(접힌 부모 아래 여럿이면 한 번)', () => {
  const app = a7Client();
  app.run(`item.draft.rows.push({ id: 'k2', heading: '완료한 일', group: '운영', groupKey: 'group:운영', text: '가려진 둘째', sourceIds: ['t9'], excluded: false, parent: 'p0', review: { reason: 'marked' } });
    item.draft.review = { count: 4, first: 's1' }; reportReviewPick = null;`);
  const button = app.run('reportReviewButton(item)');
  assert.equal(button.children[0].textContent, '확인 필요 3', '서버 4(가려진 문장 둘) → 들르는 줄 3');
  assert.equal(button.getAttribute('aria-label'), '확인 필요 3개 중 1번째로 이동');
});

// 1.3.2: 새로 들어온 것 줄의 `오늘`·`나중에`·`완료`는 회색 알약이 아니라 바탕 없는 파란 글자 버튼이다.
test('새로 들어온 것 버튼 CSS: 평소 회색 바탕 없이 파란 글자, 줄 hover 연한 파랑, 버튼 hover 진한 파랑', () => {
  const css = fs.readFileSync(path.join(__dirname, 'ui.css'), 'utf8');
  const rules = css.split('\n').filter(line => /\.d-ibacts \.d-btn[^{]*\{/.test(line));
  assert.ok(rules.length >= 3);
  assert.ok(rules.every(line => !/--neutral-bg/.test(line)), '회색 알약 바탕 규칙이 없다');
  assert.match(css, /^\.d-ibacts \.d-btn \{ background: none; color: var\(--accent-text\); \}$/m);
  assert.match(css, /^\.d-ibrow:hover \.d-ibacts \.d-btn, \.d-ibrow:focus-within \.d-ibacts \.d-btn \{ background: var\(--accent-soft\);/m);
  assert.match(css, /^\.d-ibacts \.d-btn:hover, [^{]*\{ background: var\(--accent-strong\); color: var\(--on-fill\); \}$/m);
});

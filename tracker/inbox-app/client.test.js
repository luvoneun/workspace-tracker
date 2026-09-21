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
function pureClient() {
  const app = client(new Response('{}'));
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

test('projectVisibleRows hides 0-open projects but keeps the one currently selected', () => {
  const app = pureClient();
  const rows = "[{ key: 'a', open: 2 }, { key: 'b', open: 0 }, { key: 'c', open: 0 }]";
  const collapsed = JSON.parse(app.run(`JSON.stringify((() => {
    const r = projectVisibleRows(${rows}, { showEmpty: false, selectedKey: 'b' });
    return { visible: r.visible.map(x => x.key), hiddenCount: r.hiddenCount };
  })())`));
  assert.deepEqual(collapsed, { visible: ['a', 'b'], hiddenCount: 1 }, '0개인 b는 지금 보는 중이라 남고, c만 숨는다');
  const expanded = JSON.parse(app.run(`JSON.stringify((() => {
    const r = projectVisibleRows(${rows}, { showEmpty: true, selectedKey: 'b' });
    return { visible: r.visible.map(x => x.key), hiddenCount: r.hiddenCount };
  })())`));
  assert.deepEqual(expanded, { visible: ['a', 'b', 'c'], hiddenCount: 0 }, '펼치면 전부 보인다');
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

test('uiProjectName: short spots show only the jira summary (fall back to the key when unknown), long spots keep "KEY · 요약"', () => {
  const app = pureClient();
  app.run("jiraIssuesByKey = new Map([['AB-1', { key: 'AB-1', summary: '가입 개선' }]])");
  assert.equal(app.run("uiProjectName({ jira: 'AB-1' }, { short: true })"), '가입 개선', 'short form drops the key once the summary is known');
  assert.equal(app.run("uiProjectName({ jira: 'AB-1' })"), 'AB-1 · 가입 개선', 'long form keeps KEY · 요약');
  assert.equal(app.run("uiProjectName({ jira: 'ZZ-9' }, { short: true })"), 'ZZ-9', 'falls back to the key when the summary is unknown');
  assert.equal(app.run("uiProjectName({ jira: 'ZZ-9' })"), 'ZZ-9', 'long form also falls back to the key when unknown');
  assert.equal(app.run("uiProjectName({ group: '운영툴' }, { short: true })"), '운영툴', 'a plain group has no summary to drop');
  assert.equal(app.run("uiProjectName({ project: '운영툴' })"), '운영툴', 'an idea\'s project field is read the same way');
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

test('group headings read as "이름 개수" and jira headings add the summary', () => {
  const app = pureClient();
  app.run("jiraIssuesByKey = new Map([['AB-1', { key: 'AB-1', summary: '가입 개선' }]])");
  assert.equal(app.run("uiGroupLabel('jira:AB-1')"), 'AB-1 · 가입 개선');
  assert.equal(app.run("uiGroupLabel('jira:ZZ-9')"), 'ZZ-9', 'falls back to the key when the issue is not cached');
  assert.equal(app.run("uiGroupLabel('group:운영툴')"), '운영툴');
  assert.equal(app.run("uiGroupLabel('__misc__')"), '프로젝트 없음');
  const order = JSON.parse(app.run("JSON.stringify(uiGroupTasks([{ id: 1 }, { id: 2, group: '나' }, { id: 3, jira: 'AB-1' }]).map(g => g[0]))"));
  assert.deepEqual(order, ['group:나', 'jira:AB-1', '__misc__'], 'tasks without a project go last');
});

test('group select options offer clearing only when there is something to clear', () => {
  const app = pureClient();
  app.run("jiraIssuesCache = [{ key: 'AB-1', summary: '가입' }]; customGroupsCache = ['운영툴', '<b>x</b>']");
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

test('wfMeetingProjectName: short is jira-summary-only (or the key), long keeps "KEY · 요약"; the color key ignores both', () => {
  const app = workflowsClient();
  app.run("jiraIssuesByKey = new Map([['AB-1', { key: 'AB-1', summary: '가입 개선' }]])");
  const jiraEvent = "{ project: { type: 'jira', value: 'AB-1', label: 'AB-1' } }";
  assert.equal(app.run(`wfMeetingProjectName(${jiraEvent}, { short: true })`), '가입 개선');
  assert.equal(app.run(`wfMeetingProjectName(${jiraEvent})`), 'AB-1 · 가입 개선');
  assert.equal(app.run(`wfMeetingColorKey(${jiraEvent})`), 'AB-1');
  const unknownJira = "{ project: { type: 'jira', value: 'ZZ-9', label: 'ZZ-9' } }";
  assert.equal(app.run(`wfMeetingProjectName(${unknownJira}, { short: true })`), 'ZZ-9');
  const groupEvent = "{ project: { type: 'group', value: '가입_개선', label: '가입_개선' } }";
  assert.equal(app.run(`wfMeetingProjectName(${groupEvent}, { short: true })`), '가입 개선', '파일 표기(밑줄)를 사람이 읽는 꼴로 맞춘다');
  assert.equal(app.run(`wfMeetingProjectName(${groupEvent})`), '가입 개선');
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

test('회의 탭 필터(초안 있음·미완료만·프로젝트)를 켜면 기간·기록 유무와 상관없이 전체 회의에서 거른다', () => {
  const app = workflowsClient();
  app.run(MEETINGS_TAB_FIXTURE);
  const ids = state => JSON.parse(app.run(
    `JSON.stringify(meetingsTabList(events, { today: '2026-09-21', ...${state} }, itemsOf).map(e => e.id))`));
  assert.deepEqual(ids("{ reviewOnly: true }"), ['recent-record'], '초안 있음만');
  assert.deepEqual(ids("{ unresolved: true }"), ['today1', 'old-open'],
    '미완료 항목이 남은 회의만 — 기간 밖인 old-open도 찾아낸다(찾는 행동이라 기간 제한이 없다)');
  assert.deepEqual(ids("{ project: 'group:운영툴' }"), ['recent-record', 'recent-norecord'],
    '프로젝트로 거르면 기록 없는 recent-norecord도 나온다 — 기간·기록 제한이 풀린다');
  assert.deepEqual(ids("{ project: 'group:운영툴', reviewOnly: true }"), ['recent-record'], '조건은 함께 걸린다');
  assert.deepEqual(ids("{ project: 'group:없는프로젝트' }"), []);
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

test('회의 탭 필터 줄의 칩 이름: `초안 있음`·`미완료만`·`빈 회의 포함`', () => {
  const app = workflowsClient();
  const labels = JSON.parse(app.run(`(() => {
    meetingsTabState = { key: null, unresolved: false, reviewOnly: false, project: '', windowDays: 14, showNoRecord: false, result: null };
    const bar = meetingsTabFilters([]);
    return JSON.stringify(bar.children.filter(kid => kid.textContent).map(kid => [kid.textContent, kid.title || null]));
  })()`));
  assert.deepEqual(labels, [['초안 있음', null], ['미완료만', null],
    ['빈 회의 포함', '초안도 담은 항목도 없는 지난 회의까지 보여 줘요']], '짧은 칩 이름의 뜻은 툴팁이 풀어 준다');
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
  assert.deepEqual(menu('decision'), [['문구 고치기'], ['프로젝트'], ['삭제']], '결정에는 날짜가 없다');
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
    '가입 개선',
    '• 가입 실패율 급증 원인 파악',
    '• 퍼널 데이터 정리해 대시보드 반영',
    '    ◦ 이슈: 집계 지연',
    '• 약관 문구 법무 회신 받음',
    '결제 리뉴얼',
    '• 결제 실패 알림 슬랙 채널 공지',
    '기타',
    '• 주간 회의 자료 준비',
    '',
    '[진행중]',
    '알림센터',
    '• 발송 실패 로그 확인',
    '',
    '[예정]',
    '알림센터',
    '• 웹/앱 검수 처리 기획 진행 및 논의',
    '* 과금 기획은 차차주 진행 예정',
  ].join('\n'), '제목 → 구역 → 프로젝트 → 글머리, 부연은 공백 4칸 + ◦, 프로젝트 없는 것은 기타로 구역 끝');
  assert.doesNotMatch(text, /숨긴 문장/, '제외한 문장은 복사에서 빠진다');
  assert.doesNotMatch(text, /이번 주|확인 완료/, '슬랙 글에는 상대 표현을 쓰지 않고, 확인 완료는 완료 안으로 들어간다');
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
  assert.equal(app.run(`reportSlackText(${model(['결정'])})`), ['9월 3주차 (9/21~9/27)', '', '[결정]', '운영툴', '• 접근 로그는 90일 보존'].join('\n'));
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
  assert.deepEqual(lines.slice(0, 4).map(line => line.kind), ['title', 'gap', 'section', 'project']);
  assert.ok(lines.some(line => line.kind === 'note' && line.text === '    ◦ 이슈: 집계 지연'));
  assert.ok(lines.some(line => line.kind === 'memo' && line.text === '* 과금 기획은 차차주 진행 예정'));

  const html = app.run(`reportSlackHtml(${model})`);
  assert.match(html, /^<p><b>9월 3주차 \(9\/21~9\/27\)<\/b><\/p><p><b>\[완료\]<\/b><\/p><p><b>가입 개선<\/b><\/p><ul><li>가입 실패율 급증 원인 파악<\/li>/);
  assert.match(html, /<li>퍼널 데이터 정리해 대시보드 반영<ul><li>이슈: 집계 지연<\/li><\/ul><\/li>/, '부연은 한 단계 들여 쓴 목록이 된다');
  assert.match(html, /<p>\* 과금 기획은 차차주 진행 예정<\/p>/, '프로젝트 없는 계획 문장은 메모 줄로 남는다');
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
    '가입 개선',
    '• 가입 실패율 급증 원인 파악',
    '    ◦ 결제 로그 확인',
    '    ◦ 로그 보존 기간도 정리',
    '여러 프로젝트',
    '• 옛 합치기 문장',
    '기타',
    '• 주간 회의 자료 준비',
  ].join('\n'), '자식 문장은 부모 아래 부연으로만 나가고, 다른 프로젝트 이름은 슬랙 글에 적지 않는다');
  // 부모를 제외하면 서버가 자식의 `parent`를 지워 주므로 자식은 최상위 항목으로 나간다.
  const orphaned = `{ weekKey: '2026-09-21', rows: [
    { id: 'a1', heading: '완료한 일', group: '가입 개선', text: '부모 문장', sourceIds: [], excluded: true },
    { id: 'a2', heading: '완료한 일', group: '결제 리뉴얼', text: '혼자 남은 문장', sourceIds: [], excluded: false }
  ] }`;
  assert.equal(app.run(`reportSlackText(reportSlackModel(${orphaned}, { sections: ['완료'] }))`), [
    '9월 3주차 (9/21~9/27)', '', '[완료]', '결제 리뉴얼', '• 혼자 남은 문장',
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
    '알림센터',
    '• 검수 처리 기획',
    '• 발송 정책 정리',
    '* 먼저 적은 메모',
    '* 프로젝트 없이 적은 문장',
  ].join('\n'), '슬랙에서도 프로젝트 없는 계획 문장만 구역 끝 메모 줄이 된다');
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
    '가입 개선',
    '• 퍼널 정리',
    '',
    '[리스크]',
    '운영툴',
    '• 큐 지연이 계속되고 있어요',
    '기타',
    '• 인력 공백',
    '',
    '[예정]',
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

// `지라에서 완료됨`은 프로젝트 탭에만 붙는 회색 글자다. 판정은 상태 글자 하나(`완료`)로 한다.
test('프로젝트 탭: 지라에서 완료된 이슈에만 `지라에서 완료됨`이 붙는다', () => {
  const app = workflowsClient();
  app.run(`jiraIssuesByKey = new Map([
    ['ZZ-9', { key: 'ZZ-9', summary: '끝난 이슈', status: '완료', extra: true }],
    ['AB-1', { key: 'AB-1', summary: '가입', status: '진행 중', extra: false }],
  ]);`);
  assert.equal(app.run("uiJiraDone('jira:ZZ-9')"), true);
  assert.equal(app.run("uiJiraDone('jira:AB-1')"), false);
  assert.equal(app.run("uiJiraDone('jira:없음')"), false);
  assert.equal(app.run("uiJiraDone('group:운영툴')"), false, '그룹 프로젝트에는 붙지 않는다');

  app.run("workflowData = { items: [], meetings: [] }; wfIndexData(); itemsById = new Map();");
  const titleOf = key => app.run(`(() => {
    const body = document.createElement('div');
    renderProjectDetail(body, { key: '${key}', label: '${key}', open: 0 });
    return body.children[0];
  })()`);
  const done = titleOf('jira:ZZ-9');
  assert.equal(done.children.length, 1);
  assert.equal(done.children[0].className, 'd-jdone');
  assert.equal(done.children[0].textContent, '지라에서 완료됨');
  assert.equal(titleOf('jira:AB-1').children.length, 0, '진행 중인 이슈에는 아무것도 붙지 않는다');
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
  assert.equal(list.children[0].children[1].className, 'd-wnext', '그 아래에 `다음은?` 줄이 붙는다');
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
  assert.equal(rows[1].className, 'd-mrow2 is-done');
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

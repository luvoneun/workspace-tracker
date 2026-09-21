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
    value: '', disabled: false, hidden: false, textContent: '', children: [], listeners: {},
    parent: null, connected: true, blurs: 0,
    get isConnected() { return this.connected; },
    classList: { toggle() {}, contains() { return false; } },
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
      createElement: element, addEventListener() {},
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
  // 종류마다 작은 아이콘과 풀어 쓴 툴팁이 함께 붙는다.
  assert.match(cells("{ scheduled: '2000-01-01' }"), /title="오늘 하려다 넘어온 업무예요"/);
  assert.match(cells("{ priority: 'critical' }"), /<svg class="d-i"/, '상태말 앞에는 종류 아이콘이 붙는다');
  const escaped = cells('{}', "{ project: '가입 <개선>' }");
  assert.match(escaped, /m-proj">가입 &lt;개선&gt;/, 'user text is escaped');
  assert.doesNotMatch(escaped, /<개선>/);
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

test('the project column stays empty when the group heading already says it, and jira shows its key', () => {
  const app = pureClient();
  assert.equal(app.run("uiProjectLabel({ jira: 'AB-1' }, true)"), '');
  assert.equal(app.run('uiProjectLabel({}, false)'), '');
  assert.equal(app.run("uiProjectLabel({ jira: 'AB-1', group: '운영툴' }, false)"), 'AB-1', 'jira wins and only the key is printed');
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

test('the palette meeting filter keeps drafts to review on top and can narrow to unresolved meetings', () => {
  const app = workflowsClient();
  app.run(`var events = [
    { id: 'm1', date: '2026-09-20', start: '10:00', title: '주간 운영 회의', drafts: [{ description: '권한 정책 초안' }] },
    { id: 'm2', date: '2026-09-21', start: '09:00', title: '가입 개선 킥오프' },
    { id: 'm3', date: '2026-09-21', start: '14:00', title: '지표 점검' },
  ];
  var related = { m2: [{ id: 'x', status: 'to-do', description: '권한 범위 확인' }], m3: [{ id: 'y', status: 'done', description: '끝난 일' }] };
  var itemsOf = id => related[id] || [];`);
  const ids = state => JSON.parse(app.run(`JSON.stringify(palMeetings(events, { today: '2026-09-21', ...${state} }, itemsOf).map(e => e.id))`));
  assert.deepEqual(ids("{ type: 'meeting' }"), ['m1', 'm2', 'm3'], '검색어가 없으면 전체, 검토할 초안이 있는 회의가 먼저');
  assert.deepEqual(ids("{ type: 'meeting', unresolved: true }"), ['m2'], '미해결 항목이 남은 회의만');
  assert.deepEqual(ids("{ type: 'meeting', reviewOnly: true }"), ['m1']);
  assert.deepEqual(ids("{ type: 'meeting', newOnly: true }"), ['m2', 'm3'], '오늘 열린 회의만, 하루 안에서는 회의 순서대로');
  assert.deepEqual(ids("{ query: '권한' }"), ['m1', 'm2'], '초안 문구와 이 회의에서 나온 항목까지 찾는다');
  assert.deepEqual(ids("{}"), [], '검색어도 회의 필터도 없으면 회의를 끼워 넣지 않는다');
  assert.deepEqual(ids("{ query: '권한', type: 'task' }"), [], '다른 종류를 고르면 회의는 빠진다');
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
  assert.deepEqual(['task', 'check', 'decision'].map(type => app.run(`wfDateLabel('${type}')`)), ['기한', '회신 기한', null],
    '날짜 이름은 화면 어디서나 같다 — 할 일은 `기한`, 확인 대기만 `회신 기한`');
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
    '확인 대기는 확인 대기 줄의 메뉴를 그대로 쓴다(회신 기한 포함)');
  assert.ok(menu('check').flat().includes('회신 기한'));
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
    '완료',
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
    '진행 중',
    '알림센터',
    '• 발송 실패 로그 확인',
    '',
    '예정',
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
  assert.equal(app.run(`reportSlackText(${model(['결정'])})`), ['9월 3주차 (9/21~9/27)', '', '결정', '운영툴', '• 접근 로그는 90일 보존'].join('\n'));
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
  assert.match(html, /^<p><b>9월 3주차 \(9\/21~9\/27\)<\/b><\/p><p><b>완료<\/b><\/p><p><b>가입 개선<\/b><\/p><ul><li>가입 실패율 급증 원인 파악<\/li>/);
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
    '예정',
    '알림센터',
    '• 검수 처리 기획',
    '• 발송 정책 정리',
    '* 먼저 적은 메모',
    '* 프로젝트 없이 적은 문장',
  ].join('\n'), '슬랙에서도 프로젝트 없는 계획 문장만 구역 끝 메모 줄이 된다');
});

test('반영 완료 검색은 문구·프로젝트·지라 키·지라 요약을 함께 본다', () => {
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
    '완료',
    '가입 개선',
    '• 퍼널 정리',
    '',
    '리스크',
    '운영툴',
    '• 큐 지연이 계속되고 있어요',
    '기타',
    '• 인력 공백',
    '',
    '예정',
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

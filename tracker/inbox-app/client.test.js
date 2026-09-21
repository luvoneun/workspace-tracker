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
    classList: { toggle() {}, contains() { return false; } },
    addEventListener(name, handler) { this.listeners[name] = handler; },
    appendChild(child) { this.children.push(child); return child; },
    setAttribute(name, value) { attributes.set(name, value); },
    getAttribute(name) { return attributes.get(name); },
    removeAttribute(name) { attributes.delete(name); },
    querySelectorAll() { return []; },
    focus() { this.focused = true; },
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
  assert.match(app.nodes.get('liveRegion').textContent, /저장을 확인하지 못했습니다/);
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
  const app = client(new Response(JSON.stringify({ ok: false, code: 'RECOVERY_NEEDED', error: '데이터를 지키기 위해 저장을 멈췄습니다.' }), { status: 503 }));
  await assert.rejects(app.run("request('/api/track/toggle', { method: 'POST', body: '{}' })"));
  assert.equal(app.nodes.get('storageBanner').hidden, false);
  assert.match(app.nodes.get('storageBanner').textContent, /복구 필요 상태/);
  assert.match(app.nodes.get('liveRegion').textContent, /저장을 멈췄습니다/);
});

// escapeHtml은 브라우저 DOM(textContent → innerHTML)에 기대는데 이 테스트의 가짜 DOM에는 그 동작이 없다.
// 같은 결과를 내는 함수를 넣어, 화면 문자열을 만드는 나머지 로직을 검증한다.
function pureClient() {
  const app = client(new Response('{}'));
  app.run("escapeHtml = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')");
  return app;
}

test('the status column shows overdue, due today, carried-over and in-progress, and stays empty when there is nothing to say', () => {
  const app = pureClient();
  const cells = (item, opts = '{}') => app.run(`uiMetaCells(${item}, ${opts})`);
  assert.match(cells("{ due: '2000-01-01' }"), /m-due k-neg">\d+일 지남/);
  assert.match(cells('{ due: todayStr() }'), /m-due k-warn">오늘까지/);
  assert.match(cells('{ due: tomorrowStr() }'), /m-due">내일까지/);
  assert.equal(cells("{ due: '2999-12-31' }"), '', 'a far deadline is not printed on a today row');
  assert.match(cells("{ due: '2999-12-31' }", "{ where: 'full' }"), /12월 31일 \(.\)까지/, 'but it is printed where there is room');
  assert.match(cells("{ scheduled: '2000-01-01' }"), /m-carry">\d+일 전부터/);
  assert.equal(cells("{ scheduled: '2999-01-01' }"), '', 'a task planned for later is not called carried over');
  assert.match(cells('{ doing: todayStr() }'), /m-doing">진행 중/);
  assert.equal(cells('{ doing: todayStr(), status: "done" }'), '', 'a done task is not shown as in progress');
  assert.equal(cells("{ doing: todayStr() }", '{ inDoingGroup: true }'), '', 'the group heading already says it');
  assert.equal(cells("{ priority: 'medium' }"), '', 'a middling priority is not printed');
  assert.match(cells("{ priority: 'critical' }"), /m-pri k-neg"><i class="d-dot"><\/i>긴급/);
  const escaped = cells('{}', "{ project: '가입 <개선>' }");
  assert.match(escaped, /m-proj">가입 &lt;개선&gt;/, 'user text is escaped');
  assert.doesNotMatch(escaped, /<개선>/);
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
  assert.match(due("'2000-01-01'", 'full').text, /^\d+일 지남$/);
  assert.equal(due("'2000-01-01'", 'full').tone, 'urgent');
  assert.deepEqual(due('todayStr()', 'full'), { text: '오늘까지', tone: 'warn' });
  assert.deepEqual(due('tomorrowStr()', 'full'), { text: '내일까지', tone: '' });
  assert.match(due("'2999-12-31'", 'full').text, /^12월 31일 \(.\)까지$/);
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
  assert.match(carry("'2000-01-01'"), /^\d+일 전부터$/);
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
  assert.deepEqual(['task', 'check', 'decision'].map(type => app.run(`wfDateLabel('${type}')`)), ['마감일', '회신 기한', null]);
});

test('saves from the meeting review window stay quiet on success (its result card reports them) but failures are still announced', async () => {
  const notice = app => app.nodes.get('liveRegion')?.textContent ?? '';
  const ok = () => new Response('{"ok":true}', { status: 200 });
  const normal = client(ok());
  await normal.run("request('/api/today-task/create', { method: 'POST', body: '{}' })");
  assert.match(notice(normal), /저장했습니다/);
  for (const route of ['review', 'review-undo', 'capture']) {
    const quiet = client(ok());
    await quiet.run(`request('/api/workflow/${route}', { method: 'POST', body: '{}' })`);
    assert.doesNotMatch(notice(quiet), /저장/, `${route} is quiet on success`);
  }
  const failing = client(new Response('{"ok":false,"error":"이미 처리했거나 찾을 수 없는 항목입니다."}', { status: 400 }));
  await assert.rejects(failing.run("request('/api/workflow/review', { method: 'POST', body: '{}' })"));
  assert.match(notice(failing), /저장을 확인하지 못했습니다|이미 처리/);
  const item = client(ok());
  await item.run("request('/api/workflow/item', { method: 'POST', body: '{}' })");
  assert.match(notice(item), /저장했습니다/, 'other workflow saves (item details) keep their notice');
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

test('the quiet option keeps a successful save from announcing itself, while failures still do', async () => {
  const notice = app => app.nodes.get('liveRegion')?.textContent ?? '';
  const loud = client(new Response('{"ok":true}'));
  await loud.run("request('/api/track/set-scheduled', { method: 'POST', body: '{}' })");
  assert.match(notice(loud), /저장했습니다/);
  const quiet = client(new Response('{"ok":true}'));
  await quiet.run("request('/api/track/set-scheduled', { method: 'POST', body: '{}', quiet: true })");
  assert.equal(notice(quiet), '');
  const failing = client(new Response('{"ok":false,"error":"x"}', { status: 400 }));
  await assert.rejects(failing.run("request('/api/track/set-scheduled', { method: 'POST', body: '{}', quiet: true })"));
  assert.notEqual(notice(failing), '');
});

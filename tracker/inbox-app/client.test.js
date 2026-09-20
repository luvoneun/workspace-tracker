const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise error paths against the actual client functions, without touching live data.
const script = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const definitions = script.slice(0, script.indexOf("setupQuickAdd('todayTaskInput'"));
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

test('task badges show overdue, due today, carried-over and doing states', () => {
  const app = pureClient();
  const badges = code => app.run(`taskBadges(${code}).join('|')`);
  assert.match(badges("{ due: '2000-01-01' }, 'today', false, false"), /badge overdue">\d+일 지남/);
  assert.match(badges('{ due: todayStr() }, \'today\', false, false'), /due-today">오늘 마감/);
  assert.match(badges("{ due: '2999-12-31' }, 'today', false, false"), /badge due">마감 2999-12-31/);
  assert.match(badges("{ scheduled: '2999-01-01' }, 'later', false, false"), /실행 예정 2999-01-01/);
  assert.equal(badges("{ scheduled: '2999-01-01' }, 'today', false, false"), '');
  assert.match(badges("{ scheduled: '2000-01-01' }, 'today', false, true"), /stale plan-only/);
  assert.match(badges('{ doing: todayStr() }, \'today\', false, false'), /진행 중/);
  assert.equal(badges('{ doing: todayStr() }, \'today\', true, false'), '', 'a done task is not shown as in progress');
});

test('task eyebrow shows the project label unless the group header already does', () => {
  const app = pureClient();
  app.run("jiraIssuesCache = [{ key: 'AB-1', summary: '가입 <개선>' }]");
  assert.equal(app.run("taskEyebrow({ jira: 'AB-1' }, true)"), '');
  assert.equal(app.run('taskEyebrow({}, false)'), '');
  const jira = app.run("taskEyebrow({ jira: 'AB-1' }, false)");
  assert.match(jira, /AB-1 · 가입 &lt;개선&gt;/);
  assert.doesNotMatch(jira, /<개선>/, 'user text is escaped');
  assert.match(app.run("taskEyebrow({ jira: 'ZZ-9' }, false)"), />ZZ-9</, 'falls back to the key when the issue is not cached');
  assert.match(app.run("taskEyebrow({ group: '운영툴' }, false)"), />운영툴</);
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

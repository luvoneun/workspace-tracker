const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise error paths against the actual client functions, without touching live data.
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
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

test('failed weekly save does not replace the cached saved version', async () => {
  const app = client(new Response('{"ok":false}', { status: 500 }));
  app.run("weeklyReportsCache = [{weekKey:'2026-09-14', body:'original'}]");
  await assert.rejects(app.run("saveWeeklyReportSections('2026-09-14', [{heading:'완료한 일', lines:[{text:'edited'}]}])"));
  assert.equal(app.run('weeklyReportsCache[0].body'), 'original');
});

test('successful weekly save updates the cache used by week navigation', async () => {
  const app = client(new Response('{"ok":true}'));
  app.run("weeklyReportsCache = [{weekKey:'2026-09-14', body:'original'}]");
  await app.run("saveWeeklyReportSections('2026-09-14', [{heading:'완료한 일', lines:[{text:'edited'}]}])");
  assert.match(app.run('weeklyReportsCache[0].body'), /edited/);
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

test('moving a summary line to another group rewrites its bracket prefix', () => {
  const app = client(new Response('{"ok":true}'));
  const rewritten = app.run(`(() => {
    const sections = parseReportBody('**완료한 일**\\n- [IO-1 · 잘못 들어간 그룹] 배포 팔로업\\n');
    const next = structuredClone(sections);
    next[0].lines[0].group = '웹 커뮤니티';
    return serializeReportBody(next);
  })()`);
  assert.match(rewritten, /- \[웹 커뮤니티\] 배포 팔로업/);
  assert.doesNotMatch(rewritten, /잘못 들어간 그룹/);
});

test('clearing a summary line group drops the bracket prefix but keeps the text', () => {
  const app = client(new Response('{"ok":true}'));
  const rewritten = app.run(`(() => {
    const sections = parseReportBody('**완료한 일**\\n- [웹 커뮤니티] 배포 팔로업\\n');
    const next = structuredClone(sections);
    next[0].lines[0].group = null;
    return serializeReportBody(next);
  })()`);
  assert.match(rewritten, /- 배포 팔로업/);
  assert.doesNotMatch(rewritten, /\[/);
});

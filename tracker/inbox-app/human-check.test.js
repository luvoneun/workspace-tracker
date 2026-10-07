const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

// tools/human-check.mjs — 시나리오 읽기·지키는 선·요약 줄. 크롬을 띄우는 시험은 크롬이 있을 때만, 작은 가짜 페이지(임시 포트)로 한 번.
const TOOL = path.join(__dirname, '..', '..', 'tools', 'human-check.mjs');
const SCENARIOS = path.join(__dirname, '..', '..', 'tools', 'human-check', 'scenarios');
const load = () => import(TOOL);

test('시나리오: 배열·{ steps } 객체를 읽고, 모르는 동작·모르는 칸·빠진 칸은 거절한다', async () => {
  const { parseScenario } = await load();
  const ok = parseScenario(JSON.stringify([{ do: 'goto', url: '/' }, { do: 'click', selector: '#a', hold: 80 }]), 'a.json');
  assert.equal(ok.steps.length, 2);
  assert.equal(ok.name, 'a');
  assert.equal(parseScenario(JSON.stringify({ name: '이름', steps: [{ do: 'key', key: 'Enter' }] })).name, '이름');
  const bad = (steps, re) => assert.throws(() => parseScenario(JSON.stringify(steps)), re);
  bad([{ do: 'drag', selector: '#a' }], /모르는 동작 "drag"/);
  bad([{ do: 'click', selector: '#a', hodl: 50 }], /모르는 칸 "hodl"/);
  bad([{ do: 'click' }], /"selector" 칸이 없어요/);
  bad([{ do: 'key', key: 'F5' }], /모르는 키/);
  bad([{ do: 'wait' }], /ms나 selector/);
  bad([{ do: 'frames', name: 'f', ms: [] }], /ms는 0 이상 숫자 배열/);
  bad([{ do: 'shot', name: '../밖' }], /name은/);
  bad([{ do: 'type', text: '가', during: [{ do: 'eval', expr: '1' }] }], /ime: true 일 때만/);
  bad([{ do: 'type', text: '가', ime: true, during: [{ do: 'oops' }] }], /during 안 1번째 동작: 모르는 동작/);
  bad([], /비었거나/);
  assert.throws(() => parseScenario('{', 'x.json'), /JSON이 아니에요/);
  assert.throws(() => parseScenario(JSON.stringify({ steps: [{ do: 'key', key: 'Tab' }], extra: 1 })), /모르는 칸 "extra"/);
});

test('저장소의 시나리오 파일은 모두 검증을 통과한다', async () => {
  const { parseScenario } = await load();
  const files = fs.readdirSync(SCENARIOS).filter(f => f.endsWith('.json'));
  assert.ok(files.length >= 2);
  for (const f of files) parseScenario(fs.readFileSync(path.join(SCENARIOS, f), 'utf8'), f);
});

test('지키는 선: 운영·금지 포트를 --url로 주면 거절하고, 기존 크롬·디버그 포트에 붙는 옵션은 없다', async () => {
  const { parseArgs, checkUrl, FORBIDDEN_PORTS } = await load();
  assert.deepEqual(FORBIDDEN_PORTS, [4321, 4340, 4318, 4319, 9333]);
  for (const port of FORBIDDEN_PORTS) {
    assert.throws(() => parseArgs(['s.json', '--url', `http://127.0.0.1:${port}/`]), /금지 포트/);
    assert.throws(() => checkUrl(`http://localhost:${port}/#/x`), /금지 포트/);
  }
  assert.throws(() => checkUrl('file:///etc/passwd'), /http·https/);
  assert.equal(parseArgs(['s.json', '--url', 'http://127.0.0.1:4322/']).url, 'http://127.0.0.1:4322/');
  for (const flag of ['--port', '--ws', '--browser-url', '--remote-debugging-port', '--connect', '--cdp', '--user-data-dir']) {
    assert.throws(() => parseArgs(['s.json', flag, '9222']), /모르는 옵션/, flag);
  }
  assert.throws(() => parseArgs(['s.json']), /--url <주소> 나 --serve/);
  assert.throws(() => parseArgs(['s.json', '--serve', '--url', 'http://127.0.0.1:4322/']), /같이 쓰지 않아요/);
  assert.deepEqual(parseArgs(['s.json', '--serve', '--holds', '0,120']).holds, [0, 120]);
  assert.throws(() => parseArgs(['s.json', '--serve', '--holds', '0,-1']), /--holds/);
});

test('지키는 선: 코드에 프로세스 목록 훑기·이름으로 끄기·기존 크롬 붙기가 없고, 크롬은 새 임시 프로필·포트 0으로 띄운다', () => {
  const src = fs.readFileSync(TOOL, 'utf8');
  for (const word of ['pkill', 'killall', 'pgrep', 'lsof', 'ps aux', "'ps'", 'execSync', 'exec(', 'connectOverCDP', 'browserURL', 'browserWSEndpoint', 'robotjs', 'osascript', 'cliclick', 'System Events']) {
    assert.ok(!src.includes(word), `들어 있으면 안 되는 말: ${word}`);
  }
  assert.match(src, /'--remote-debugging-port=0'/);
  assert.doesNotMatch(src, /remote-debugging-port=[1-9]/);
  assert.match(src, /mkdtempSync\(path\.join\(os\.tmpdir\(\), 'human-check-chrome-'\)\)/);
  assert.match(src, /`--user-data-dir=\$\{profile\}`/);
  // 끄는 신호는 우리가 띄운 크롬 그룹(-child.pid)과 우리가 띄운 서버 child 뿐이다.
  const kills = src.match(/(process|child)\.kill\([^)]*\)/g) || [];
  assert.ok(kills.length > 0);
  for (const k of kills) assert.match(k, /^(process\.kill\(-child\.pid, sig\)|child\.kill\((sig|'SIGTERM'|'SIGKILL')\))$/, k);
  // 입력은 CDP 입력 이벤트로만.
  for (const m of ['Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.imeSetComposition', 'Input.insertText']) assert.ok(src.includes(m), m);
});

test('요약 줄 형식과 사람이 볼 index.html', async () => {
  const { summaryLine, renderHtml } = await load();
  const runs = [{ hold: 0, status: 'pass', steps: [] }, { hold: 50, status: 'fail', steps: [] }, { hold: 300, status: 'error', steps: [] }];
  assert.equal(summaryLine(runs), 'human-check: 통과 1 · 실패 1 · 못 돎 1 (hold 0/50/300)');
  const html = renderHtml({ scenario: '<가>', description: '', summary: summaryLine(runs), target: 'x', at: 't',
    runs: [{ hold: 50, status: 'fail', ms: 1, steps: [{ n: 1, do: 'assert', ok: false, ms: 2, error: '<b>' }], shots: ['h50-a.png'] }] });
  assert.match(html, /&lt;가&gt;/);
  assert.match(html, /&lt;b&gt;/);
  assert.match(html, /<img src="h50-a.png"/); // 같은 폴더 상대 경로
  assert.match(html, /name="viewport"/);
});

test('한글 조합 단계: 완성형을 입력기 단계로 나눈다', async () => {
  const { composeStages } = await load();
  assert.deepEqual(composeStages('한'), ['ㅎ', '하', '한']);
  assert.deepEqual(composeStages('가'), ['ㄱ', '가']);
  assert.deepEqual(composeStages('a'), ['a']);
});

// 크롬이 있으면: 가짜 페이지에서 hold 클릭이 누름 → (hold) → 뗌 → click 순서로 오고, ime 입력이 조합 이벤트를 거쳐 글이 되며,
// during 동작이 조합 도중(compositionstart 뒤, compositionend 앞)에 도는지 본다.
const { CHROME } = { CHROME: process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' };
test('크롬: hold 클릭과 ime 입력이 이벤트 순서대로 온다', { skip: fs.existsSync(CHROME) ? false : `크롬이 없어 건너뜀: ${CHROME}` }, async () => {
  const { runAll } = await load();
  const page = `<!doctype html><meta charset="utf-8"><button id="b">누름</button><input id="t">
<script>
window.__log = [];
const t0 = performance.now(); const at = () => Math.round(performance.now() - t0);
for (const n of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) document.getElementById('b').addEventListener(n, () => __log.push([n, at()]));
for (const n of ['compositionstart', 'compositionupdate', 'compositionend']) document.getElementById('t').addEventListener(n, (e) => __log.push([n, e.data]));
document.getElementById('t').addEventListener('input', (e) => __log.push(['input', e.isComposing]));
</script>`;
  const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(page); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'human-check-test-'));
  try {
    const scenario = { name: '가짜', description: '', steps: [
      { do: 'goto', url: '/' },
      { do: 'click', selector: '#b' },
      { do: 'assert', message: '누름·뗌·click 순서', expr: "__log.map(x => x[0]).join(',') === 'pointerdown,mousedown,pointerup,mouseup,click'" },
      { do: 'assert', message: '누름~뗌 사이가 hold 만큼', expr: "__log[3][1] - __log[1][1] >= 110" },
      { do: 'eval', expr: '__log.length = 0' },
      { do: 'type', selector: '#t', text: '한', ime: true, during: [{ do: 'eval', expr: "__log.push(['during'])" }] },
      { do: 'assert', message: '글이 한', expr: "document.getElementById('t').value === '한'" },
      { do: 'assert', message: '조합 이벤트 순서', expr: "(() => { const k = __log.map(x => x[0]); return k[0] === 'compositionstart' && k.includes('compositionupdate') && k.indexOf('during') > 0 && k.indexOf('during') < k.indexOf('compositionend') && k[k.length - 1] !== 'compositionstart'; })()" },
      { do: 'assert', message: '조합 중 input은 isComposing', expr: "__log.some(x => x[0] === 'input' && x[1] === true)" },
    ] };
    const report = await runAll({ scenario, holds: [120], url: `http://127.0.0.1:${server.address().port}/`, out });
    const run = report.runs[0];
    assert.equal(run.status, 'pass', JSON.stringify(run.steps.find(s => !s.ok) || run.error));
    assert.equal(report.summary, 'human-check: 통과 1 · 실패 0 · 못 돎 0 (hold 120)');
    assert.ok(fs.existsSync(path.join(out, 'index.html')));
    assert.ok(fs.existsSync(path.join(out, 'result.json')));
  } finally {
    server.close();
    fs.rmSync(out, { recursive: true, force: true });
  }
});

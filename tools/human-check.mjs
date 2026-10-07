#!/usr/bin/env node
// human-check — 사람 속도로 눌러 보고 쳐 보는 도구. 시험이 건너뛰는 "시간 간격"과 "한글 조합 상태"를 실제 브라우저 입력 장치로 만든다.
// 누름(mousePressed)과 뗌(mouseReleased) 사이를 hold ms 벌리고, 한글은 Input.imeSetComposition으로 조합 단계를 거친 뒤 확정한다.
// 손맛·이해하기 쉬움은 판단하지 않는다 — 단계별 통과/실패와 그림·프레임을 찍어 사람에게 보여 줄 뿐이다.
//
// 지키는 선(이 파일 안에서 막고 human-check.test.js가 고정한다):
//  - 헤드리스 크롬은 매번 새 임시 프로필(--user-data-dir 임시 폴더, --remote-debugging-port=0)로 새로 띄우고, 끝나면 그 프로세스 그룹에만 신호를 보낸다.
//    이미 떠 있는 크롬·디버그 포트에 붙는 옵션은 없다. 프로세스 목록을 훑지 않는다.
//  - 입력은 CDP 입력 이벤트(Input.dispatchMouseEvent·dispatchKeyEvent·imeSetComposition·insertText)만 쓴다. OS 마우스·키보드는 쓰지 않는다.
//  - 운영·금지 포트(FORBIDDEN_PORTS)를 --url로 주면 거절한다. --serve는 가짜 데이터 서버(browser-fixture.js)를 4350~4399 빈 포트에 직접 띄우고 그 pid만 끈다.
// Node 기본 모듈과 내장 WebSocket만 쓴다(Node 22+).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_APP = path.resolve(HERE, '..', 'tracker', 'inbox-app');
export const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const FORBIDDEN_PORTS = [4321, 4340, 4318, 4319, 9333];
export const SERVE_PORTS = [4350, 4399];
export const DEFAULT_HOLDS = [0, 50, 100, 150, 300];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HELP = `human-check: 사람 속도로 눌러 보고 쳐 봐요(실제 브라우저 입력 장치 · 실제 한글 조합)

  node tools/human-check.mjs <시나리오.json> [--url <주소> | --serve] [--out <폴더>] [--holds 0,50,100,150,300] [--app <inbox-app 폴더>]

  --url <주소>     이 주소만 쓴다(운영·금지 포트 ${FORBIDDEN_PORTS.join('·')} 는 거절)
  --serve          가짜 데이터 서버(browser-fixture.js)를 ${SERVE_PORTS[0]}~${SERVE_PORTS[1]} 빈 포트에 hold마다 새로 띄우고 끝나면 그 pid만 끈다
  --app <폴더>     --serve로 띄울 inbox-app 폴더(기본: 이 저장소의 tracker/inbox-app — 옛 커밋을 꺼낸 복사본을 시험할 때)
  --out <폴더>     결과 JSON · 그림 · index.html 을 둘 곳(기본: 임시 폴더)
  --holds <ms,…>   click 의 누름~뗌 간격. 간격마다 시나리오 전체를 새 탭에서 다시 돈다(기본 ${DEFAULT_HOLDS.join(',')})
  시나리오 동작은 tools/human-check/README.md. 새 임시 프로필 헤드리스 크롬만 쓰고, 떠 있는 크롬에는 붙지 않는다.`;

// ---------- 시나리오 읽기·검증 ----------
// 동작마다 꼭 있어야 하는 칸과 받을 수 있는 칸. 모르는 동작·모르는 칸은 거절한다(오타가 조용히 건너뛰어지지 않게).
export const ACTIONS = {
  goto: { need: ['url'], may: ['waitFor', 'timeout', 'wait'] },
  click: { need: ['selector'], may: ['hold', 'nth'] },
  type: { need: ['text'], may: ['selector', 'nth', 'ime', 'during', 'duringAt', 'delay'] },
  key: { need: ['key'], may: [] },
  wait: { need: [], may: ['ms', 'selector', 'gone', 'timeout'] },
  eval: { need: ['expr'], may: [] },
  failRequests: { need: [], may: ['pattern', 'status', 'clear'] },
  assert: { need: ['expr'], may: ['message'] },
  shot: { need: ['name'], may: [] },
  frames: { need: ['name', 'ms'], may: [] },
};
export const KEYS = {
  Enter: { code: 'Enter', vk: 13, text: '\r' },
  Escape: { code: 'Escape', vk: 27 },
  Tab: { code: 'Tab', vk: 9 },
  Backspace: { code: 'Backspace', vk: 8 },
};
const COMMON = ['do', 'note'];

export function validateSteps(steps, where = '') {
  if (!Array.isArray(steps) || !steps.length) throw new Error(`${where || '시나리오'}: 동작 배열이 비었거나 배열이 아니에요`);
  steps.forEach((s, i) => {
    const at = `${where}${i + 1}번째 동작`;
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error(`${at}: 객체가 아니에요`);
    const spec = ACTIONS[s.do];
    if (!spec) throw new Error(`${at}: 모르는 동작 "${s.do}" (받는 것: ${Object.keys(ACTIONS).join(' · ')})`);
    for (const k of spec.need) if (s[k] === undefined || s[k] === '') throw new Error(`${at}(${s.do}): "${k}" 칸이 없어요`);
    for (const k of Object.keys(s)) if (!COMMON.includes(k) && !spec.need.includes(k) && !spec.may.includes(k)) throw new Error(`${at}(${s.do}): 모르는 칸 "${k}"`);
    if (s.do === 'key' && !KEYS[s.key]) throw new Error(`${at}(key): 모르는 키 "${s.key}" (받는 것: ${Object.keys(KEYS).join(' · ')})`);
    if (s.do === 'click' && s.hold !== undefined && !(Number.isFinite(s.hold) && s.hold >= 0)) throw new Error(`${at}(click): hold는 0 이상 숫자예요`);
    if (s.do === 'wait' && s.ms === undefined && !s.selector) throw new Error(`${at}(wait): ms나 selector 중 하나가 있어야 해요`);
    if (s.do === 'frames' && !(Array.isArray(s.ms) && s.ms.length && s.ms.every((v) => Number.isFinite(v) && v >= 0))) throw new Error(`${at}(frames): ms는 0 이상 숫자 배열이에요`);
    if ((s.do === 'shot' || s.do === 'frames') && !/^[\p{L}\p{N}_-]+$/u.test(String(s.name))) throw new Error(`${at}(${s.do}): name은 글자·숫자·_·- 만 써요`);
    if (s.do === 'failRequests' && !s.clear && !s.pattern) throw new Error(`${at}(failRequests): pattern이나 clear가 있어야 해요`);
    if (s.do === 'type' && s.during !== undefined) {
      if (!s.ime) throw new Error(`${at}(type): during은 ime: true 일 때만 써요(조합 도중에 끼우는 동작)`);
      validateSteps(s.during, `${at} during 안 `);
      if (s.during.some((d) => d.do === 'type')) throw new Error(`${at}(type): during 안에 type은 못 넣어요`);
    }
  });
  return steps;
}

// 시나리오 파일: 동작 배열이거나 { name, description, steps } 객체.
export function parseScenario(text, file = '시나리오') {
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error(`${file}: JSON이 아니에요 (${e.message})`); }
  const scenario = Array.isArray(data) ? { steps: data } : data;
  if (!scenario || typeof scenario !== 'object') throw new Error(`${file}: 배열이나 { steps } 객체여야 해요`);
  for (const k of Object.keys(scenario)) if (!['name', 'description', 'steps'].includes(k)) throw new Error(`${file}: 모르는 칸 "${k}"`);
  validateSteps(scenario.steps);
  return { name: scenario.name || path.basename(file, '.json'), description: scenario.description || '', steps: scenario.steps };
}

// ---------- 인자·주소 ----------
export function checkUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error(`주소가 아니에요: ${raw}`); }
  if (!/^https?:$/.test(u.protocol)) throw new Error(`http·https 주소만 받아요: ${raw}`);
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  if (FORBIDDEN_PORTS.includes(port)) throw new Error(`운영·금지 포트(${port})는 쓰지 않아요 — 가짜 데이터로 시험하려면 --serve`);
  return u;
}

export function parseHolds(raw) {
  if (raw === undefined) return DEFAULT_HOLDS.slice();
  const list = String(raw).split(',').map((v) => v.trim()).filter(Boolean).map(Number);
  if (!list.length || list.some((v) => !Number.isFinite(v) || v < 0 || v > 10000)) throw new Error(`--holds는 0~10000 숫자를 쉼표로: ${raw}`);
  return [...new Set(list)];
}

const VALUE_FLAGS = ['url', 'out', 'holds', 'app'];
const BOOL_FLAGS = ['serve', 'help'];
export function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') { o.help = true; continue; }
    if (!a.startsWith('--')) { o._.push(a); continue; }
    let [k, v] = a.slice(2).split(/=(.*)/s);
    if (BOOL_FLAGS.includes(k)) { if (v !== undefined) throw new Error(`--${k} 는 값을 받지 않아요`); o[k] = true; continue; }
    if (!VALUE_FLAGS.includes(k)) throw new Error(`모르는 옵션 --${k} (받는 것: ${[...VALUE_FLAGS, ...BOOL_FLAGS].map((f) => '--' + f).join(' ')})`);
    if (v === undefined) v = argv[++i];
    if (v === undefined) throw new Error(`--${k} 에 값이 없어요`);
    o[k] = v;
  }
  if (o.help) return o;
  if (o._.length !== 1) throw new Error('시나리오 파일 하나를 주세요');
  if (o.url && o.serve) throw new Error('--url 과 --serve 는 같이 쓰지 않아요');
  if (!o.url && !o.serve) throw new Error('--url <주소> 나 --serve 중 하나를 주세요');
  if (o.url) checkUrl(o.url);
  o.holds = parseHolds(o.holds);
  return o;
}

// ---------- 결과 요약 ----------
// 간격(hold) 하나 = 한 번 돎. 통과(모든 단계 통과) · 실패(단계가 실패) · 못 돎(서버·크롬·첫 화면 열기가 안 됨).
export function summaryLine(runs) {
  const n = (s) => runs.filter((r) => r.status === s).length;
  return `human-check: 통과 ${n('pass')} · 실패 ${n('fail')} · 못 돎 ${n('error')} (hold ${runs.map((r) => r.hold).join('/')})`;
}

// ---------- 한글 조합 단계 ----------
// 완성형 한 글자를 입력기가 보여 주는 단계로 나눈다: '한' → ['ㅎ', '하', '한']. 한글이 아니면 [글자] 하나.
const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
export function composeStages(ch) {
  const c = ch.codePointAt(0);
  if (c < 0xac00 || c > 0xd7a3) return [ch];
  const n = c - 0xac00, t = n % 28, lv = n - t;
  const stages = [CHO[Math.floor(n / 588)], String.fromCodePoint(0xac00 + lv)];
  if (t) stages.push(ch);
  return stages;
}

// ---------- 크롬 ----------
// 새 임시 프로필로 띄운다. detached 로 띄워 크롬과 그 도우미 프로세스가 우리 그룹 하나에 들고, 끌 때는 그 그룹(-pid)에만 신호를 보낸다.
export async function launchChrome({ width = 1280, height = 860 } = {}) {
  if (!fs.existsSync(CHROME)) throw new Error(`크롬이 없어요: ${CHROME} (CHROME_BIN 으로 알려 주세요)`);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'human-check-chrome-'));
  const child = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-notifications', '--mute-audio', '--hide-scrollbars',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    `--window-size=${width},${height}`, 'about:blank'], { stdio: 'ignore', detached: true });
  let dead = false;
  child.on('exit', () => { dead = true; });
  const signal = (sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch {} } };
  const close = async () => {
    if (!dead) {
      signal('SIGTERM');
      for (let i = 0; i < 40 && !dead; i++) await sleep(100);
      if (!dead) signal('SIGKILL'); // 우리가 띄운 그룹 하나만
    }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  };
  try {
    let port = null;
    for (let i = 0; i < 80 && !port; i++) {
      await sleep(250);
      if (dead) throw new Error('크롬이 뜨다가 꺼졌어요');
      try { port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim(); } catch {}
    }
    if (!port) throw new Error('크롬이 20초 안에 안 떴어요');
    return { http: `http://127.0.0.1:${port}`, close, pid: child.pid, signal, isDead: () => dead };
  } catch (e) { await close(); throw e; }
}

// 탭 하나에 붙는다. send(method, params) · on(event, fn) · ev(식) · errors(콘솔 오류)
async function attach(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error('크롬 탭에 못 붙었어요')); });
  let id = 0; const wait = new Map(); const listeners = new Map(); const errors = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && wait.has(d.id)) { const [ok, no] = wait.get(d.id); wait.delete(d.id); d.error ? no(new Error(d.error.message)) : ok(d.result); return; }
    if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push(d.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    for (const fn of listeners.get(d.method) || []) fn(d.params);
  };
  ws.onclose = () => { for (const [, [, no]] of wait) no(new Error('크롬 탭 연결이 끊겼어요')); wait.clear(); };
  const send = (method, params = {}) => new Promise((ok, no) => {
    if (ws.readyState !== WebSocket.OPEN) { no(new Error('크롬 탭 연결이 닫혔어요')); return; }
    const i = ++id; wait.set(i, [ok, no]); ws.send(JSON.stringify({ id: i, method, params }));
  });
  const on = (method, fn) => { (listeners.get(method) || listeners.set(method, []).get(method)).push(fn); };
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: false });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  return { send, on, ev, errors, close: () => { try { ws.close(); } catch {} } };
}

// ---------- 가짜 데이터 서버(--serve) ----------
async function portFree(port) {
  return new Promise((ok) => {
    const s = net.createServer();
    s.once('error', () => ok(false));
    s.listen(port, '127.0.0.1', () => s.close(() => ok(true)));
  });
}
export async function startFixture(appDir = DEFAULT_APP) {
  const fixture = path.join(appDir, 'browser-fixture.js');
  if (!fs.existsSync(fixture)) throw new Error(`browser-fixture.js 가 없어요: ${appDir}`);
  let port = null;
  for (let p = SERVE_PORTS[0]; p <= SERVE_PORTS[1] && !port; p++) if (await portFree(p)) port = p;
  if (!port) throw new Error(`${SERVE_PORTS[0]}~${SERVE_PORTS[1]} 에 빈 포트가 없어요`);
  // 가짜 데이터 서버도 WORKSPACE_FIXTURE=1 로 뜬다 — 실제 설치 위치를 가리키면 서버가 스스로 시작하지 않는다.
  const env = { ...process.env, WORKSPACE_FIXTURE_PORT: String(port) };
  for (const k of Object.keys(env)) if (/^WORKSPACE_(?!FIXTURE_PORT$)/.test(k)) delete env[k]; // 바깥 설정이 끼지 않게(픽스처가 새로 채운다)
  const child = spawn(process.execPath, [fixture], { cwd: appDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let dead = false, log = '';
  child.on('exit', () => { dead = true; });
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const close = async () => {
    if (dead) return;
    child.kill('SIGTERM'); // 우리가 띄운 pid 하나만(픽스처가 임시 폴더를 치우고 끝난다)
    for (let i = 0; i < 50 && !dead; i++) await sleep(100);
    if (!dead) child.kill('SIGKILL');
  };
  const url = `http://127.0.0.1:${port}/`;
  for (const t0 = Date.now(); Date.now() - t0 < 40000;) {
    if (dead) throw new Error(`가짜 데이터 서버가 꺼졌어요: ${log.trim().slice(-400)}`);
    try { const r = await fetch(url, { signal: AbortSignal.timeout(3000) }); if (r.status < 500) return { url, port, close, pid: child.pid }; } catch {}
    await sleep(200);
  }
  await close();
  throw new Error(`가짜 데이터 서버가 40초 안에 안 떴어요(포트 ${port}): ${log.trim().slice(-300)}`);
}

// ---------- 한 번 돎 ----------
const js = (v) => JSON.stringify(v);
const pick = (sel, nth = 0) => `(() => { const l = document.querySelectorAll(${js(sel)}); return l[${nth < 0 ? `l.length + (${nth})` : Number(nth)}] || null; })()`;

async function runOnce({ chrome, base, steps, hold, out, tag }) {
  const tab = await (await fetch(`${chrome.http}/json/new?about:blank`, { method: 'PUT' })).json();
  const page = await attach(tab.webSocketDebuggerUrl);
  const shots = [];
  const results = [];
  let loads = 0;
  page.on('Page.loadEventFired', () => { loads++; });
  const failRules = [];
  page.on('Fetch.requestPaused', (p) => {
    const rule = failRules.find((r) => r.re.test(p.request.url));
    if (!rule) { page.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {}); return; }
    rule.hits++;
    if (rule.status === 0) page.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'Failed' }).catch(() => {});
    else page.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: rule.status, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify({ error: 'human-check가 일부러 실패시킨 요청' })).toString('base64') }).catch(() => {});
  });
  try {
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    await page.send('Page.bringToFront');
    await page.send('Emulation.setFocusEmulationEnabled', { enabled: true }); // 창이 가려진 것처럼 굴지 않게(포커스·blur가 실제 창처럼)
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
  } catch (e) { page.close(); throw e; }

  const center = async (sel, nth) => page.ev(`(() => { const e = ${pick(sel, nth)}; if (!e) return null; e.scrollIntoView({ block: 'center', inline: 'center' });
    const r = e.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; const t = document.elementFromPoint(x, y);
    return { x, y, w: r.width, h: r.height, covered: !!t && t !== e && !e.contains(t) ? (t.tagName.toLowerCase() + (t.className && typeof t.className === 'string' ? '.' + t.className.trim().split(/\\s+/).join('.') : '')) : '' }; })()`);
  const mouse = (type, x, y, extra = {}) => page.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1, pointerType: 'mouse', ...extra });
  const keyDown = async (name) => {
    const k = KEYS[name];
    await page.send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', key: name, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}) });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk });
  };
  const snap = async (name) => {
    const r = await page.send('Page.captureScreenshot', { format: 'png' });
    const file = `${tag}-${name}.png`;
    fs.writeFileSync(path.join(out, file), Buffer.from(r.data, 'base64'));
    shots.push(file);
    return file;
  };
  const waitUntil = async (expr, timeout) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { if (await page.ev(expr).catch(() => false)) return true; await sleep(50); }
    return false;
  };

  const doStep = async (s, ctx) => {
    switch (s.do) {
      case 'goto': {
        const url = new URL(s.url, base).href;
        const n = loads;
        await page.send('Page.navigate', { url });
        const t0 = Date.now(), timeout = s.timeout ?? 20000;
        while (loads === n && Date.now() - t0 < timeout) await sleep(50);
        if (loads === n) throw Object.assign(new Error(`${timeout}ms 안에 안 열렸어요: ${url}`), { setup: true });
        if (s.waitFor && !(await waitUntil(`!!document.querySelector(${js(s.waitFor)})`, timeout))) throw Object.assign(new Error(`안 나왔어요: ${s.waitFor}`), { setup: true });
        if (s.wait) await sleep(s.wait);
        return {};
      }
      case 'click': {
        const h = s.hold ?? hold;
        const c = await center(s.selector, s.nth ?? 0);
        if (!c) throw new Error(`누를 것이 없어요: ${s.selector}${s.nth ? ` [${s.nth}]` : ''}`);
        await mouse('mouseMoved', c.x, c.y);
        await mouse('mousePressed', c.x, c.y);
        if (h) await sleep(h);
        await mouse('mouseReleased', c.x, c.y);
        return { hold: h, at: [Math.round(c.x), Math.round(c.y)], ...(c.covered ? { covered: c.covered } : {}) };
      }
      case 'type': {
        if (s.selector) {
          const ok = await page.ev(`(() => { const e = ${pick(s.selector, s.nth ?? 0)}; if (!e) return false; e.focus(); if (typeof e.setSelectionRange === 'function' && typeof e.value === 'string') e.setSelectionRange(e.value.length, e.value.length); return document.activeElement === e; })()`);
          if (!ok) throw new Error(`칠 칸이 없거나 초점이 안 가요: ${s.selector}`);
        }
        const delay = s.delay ?? 40;
        const chars = [...s.text];
        const duringAt = s.duringAt ?? 0;
        let ranDuring = false;
        for (let i = 0; i < chars.length; i++) {
          const ch = chars[i];
          if (!s.ime) {
            await page.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch, key: ch });
            await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
            await sleep(delay);
            continue;
          }
          const stages = composeStages(ch);
          for (let k = 0; k < stages.length; k++) {
            await page.send('Input.imeSetComposition', { text: stages[k], selectionStart: stages[k].length, selectionEnd: stages[k].length });
            await sleep(delay);
            if (s.during && !ranDuring && i === Math.min(duringAt, chars.length - 1) && k === 0) {
              ranDuring = true; // 조합 한가운데(첫 자모만 친 상태)에서 끼운다
              for (const d of s.during) await doStep(d, ctx);
            }
          }
          await page.send('Input.insertText', { text: ch }); // 조합 확정
          await sleep(delay);
        }
        return { chars: chars.length, ime: !!s.ime, ...(s.during ? { during: s.during.length } : {}) };
      }
      case 'key': await keyDown(s.key); return {};
      case 'wait': {
        if (s.selector) {
          const expr = s.gone ? `!document.querySelector(${js(s.selector)})` : `!!document.querySelector(${js(s.selector)})`;
          if (!(await waitUntil(expr, s.timeout ?? 5000))) throw new Error(`${s.gone ? '안 사라졌어요' : '안 나왔어요'}: ${s.selector}`);
        }
        if (s.ms) await sleep(s.ms);
        return {};
      }
      case 'eval': { const v = await page.ev(s.expr); return v === undefined ? {} : { value: v }; }
      case 'assert': {
        let v;
        try { v = await page.ev(s.expr); } catch (e) { throw new Error(`${s.message || s.expr} — 식 오류: ${e.message.split('\n')[0]}`); }
        if (!v) throw Object.assign(new Error(s.message || `거짓: ${s.expr}`), { assert: true, value: v });
        return {};
      }
      case 'failRequests': {
        if (s.clear) { failRules.length = 0; await page.send('Fetch.disable'); return {}; }
        const status = s.status ?? 500;
        failRules.push({ re: new RegExp(s.pattern), status, hits: 0 });
        await page.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
        return { status };
      }
      case 'shot': return { file: await snap(s.name) };
      case 'frames': {
        // 지금 도는 애니메이션·전환을 멈추고 시작점에서 ms 만큼씩 옮겨 찍는다(실제 시계를 기다리지 않는다 — 가려진 창에서도 같은 그림).
        const count = await page.ev(`(() => { const l = document.getAnimations(); window.__hcFrames = l.map((a) => { a.pause(); return [a, a.currentTime || 0]; }); return l.length; })()`);
        const files = [];
        for (const ms of s.ms) {
          await page.ev(`(() => { for (const [a, t] of window.__hcFrames || []) { try { a.currentTime = t + ${Number(ms)}; } catch {} } })()`);
          await page.ev('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
          files.push(await snap(`${s.name}-${ms}ms`));
        }
        await page.ev(`(() => { for (const [a] of window.__hcFrames || []) { try { a.play(); } catch {} } delete window.__hcFrames; })()`);
        return { animations: count, files };
      }
      default: throw new Error(`모르는 동작: ${s.do}`);
    }
  };

  let status = 'pass';
  const t0 = Date.now();
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const st = Date.now();
    const errs = page.errors.length;
    try {
      const info = await doStep(s, {});
      results.push({ n: i + 1, do: s.do, ok: true, ms: Date.now() - st, ...(s.note ? { note: s.note } : {}), ...info, ...(page.errors.length > errs ? { consoleErrors: page.errors.slice(errs) } : {}) });
    } catch (e) {
      status = e.setup ? 'error' : 'fail';
      const r = { n: i + 1, do: s.do, ok: false, ms: Date.now() - st, error: e.message.split('\n')[0], ...(s.note ? { note: s.note } : {}) };
      try { r.file = await snap(`실패-${i + 1}`); } catch {}
      results.push(r);
      break;
    }
  }
  const run = { hold, status, ms: Date.now() - t0, steps: results, shots, consoleErrors: page.errors.slice() };
  page.close();
  try { await fetch(`${chrome.http}/json/close/${tab.id}`); } catch {}
  return run;
}

// ---------- 사람이 볼 index.html ----------
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const LABEL = { pass: '통과', fail: '실패', error: '못 돎' };
export function renderHtml(report) {
  const step = (s) => `<li class="${s.ok ? 'ok' : 'bad'}"><span class="mk">${s.ok ? '✓' : '✗'}</span><code>${esc(s.do)}</code>${s.note ? ` ${esc(s.note)}` : ''}<span class="ms">${s.ms}ms${s.hold !== undefined ? ` · hold ${s.hold}` : ''}${s.covered ? ` · 가려짐: ${esc(s.covered)}` : ''}</span>${s.error ? `<div class="err">${esc(s.error)}</div>` : ''}${(s.consoleErrors || []).map((c) => `<div class="con">콘솔: ${esc(c)}</div>`).join('')}</li>`;
  const runs = report.runs.map((r) => `<section class="run ${r.status}"><h2><span class="badge">${LABEL[r.status]}</span> hold ${r.hold}ms <small>${r.ms}ms</small></h2>
${r.error ? `<p class="err">${esc(r.error)}</p>` : ''}<ol>${(r.steps || []).map(step).join('')}</ol>
${(r.shots || []).length ? `<div class="shots">${r.shots.map((f) => `<figure><a href="${esc(f)}"><img src="${esc(f)}" alt="${esc(f)}" loading="lazy"></a><figcaption>${esc(f)}</figcaption></figure>`).join('')}</div>` : ''}</section>`).join('\n');
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>human-check 결과</title><style>
:root{--bg:#fff;--fg:#1f2328;--muted:#6b7280;--line:#e5e7eb;--ok:#15803d;--bad:#b91c1c;--warn:#a16207;--card:#f8fafc}
@media (prefers-color-scheme:dark){:root{--bg:#111418;--fg:#e6e8eb;--muted:#9aa3ad;--line:#2a2f36;--ok:#4ade80;--bad:#f87171;--warn:#facc15;--card:#181c21}}
*{box-sizing:border-box}body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,system-ui,sans-serif;max-width:1100px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:0 0 8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}small,.ms{color:var(--muted);font-size:13px}
.sum{font-family:ui-monospace,monospace;font-size:14px;padding:8px 12px;background:var(--card);border:1px solid var(--line);border-radius:8px;overflow-wrap:anywhere}
.run{border:1px solid var(--line);border-radius:10px;padding:12px;margin:12px 0;background:var(--card)}
.badge{font-size:13px;padding:2px 8px;border-radius:999px;color:#fff;background:var(--ok)}.fail .badge{background:var(--bad)}.error .badge{background:var(--warn);color:#111}
ol{margin:0;padding-left:0;list-style:none}li{padding:4px 0;border-top:1px solid var(--line);overflow-wrap:anywhere}li:first-child{border-top:0}
.mk{display:inline-block;width:20px;font-weight:700}.ok .mk{color:var(--ok)}.bad .mk{color:var(--bad)}code{font-size:13px}.ms{margin-left:8px}
.err{color:var(--bad);margin:4px 0 0 20px}.con{color:var(--warn);font-size:13px;margin-left:20px}
.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:8px;margin-top:8px}figure{margin:0}img{width:100%;border:1px solid var(--line);border-radius:6px;display:block}figcaption{font-size:12px;color:var(--muted);overflow-wrap:anywhere}
</style></head><body>
<h1>${esc(report.scenario)}</h1>${report.description ? `<p>${esc(report.description)}</p>` : ''}
<p class="sum">${esc(report.summary)}</p><p><small>${esc(report.target)} · ${esc(report.at)}</small></p>
${runs}
</body></html>
`;
}

// ---------- 실행 ----------
// 시나리오를 hold마다 한 번씩 돌린다. url(--url) 이나 serve(--serve, appDir)로 주소를 정한다. 크롬은 한 번 띄워 탭만 새로 열고, 끝나면 그 그룹만 끈다.
export async function runAll({ scenario, holds = DEFAULT_HOLDS, url = null, serve = false, appDir = DEFAULT_APP, out, log = () => {} }) {
  if (url) checkUrl(url);
  fs.mkdirSync(out, { recursive: true });
  let chrome = null, server = null;
  const cleanup = async () => { if (server) { await server.close(); server = null; } if (chrome) { await chrome.close(); chrome = null; } };
  const onSig = () => { cleanup().finally(() => process.exit(130)); };
  process.once('SIGINT', onSig); process.once('SIGTERM', onSig);
  const runs = [];
  try {
    chrome = await launchChrome();
    for (const hold of holds) {
      try {
        let base = url;
        if (serve) { server = await startFixture(appDir); base = server.url; }
        runs.push(await runOnce({ chrome, base, steps: scenario.steps, hold, out, tag: `h${hold}` }));
      } catch (e) {
        runs.push({ hold, status: 'error', error: e.message.split('\n')[0], steps: [], shots: [] });
      } finally {
        if (server) { await server.close(); server = null; }
      }
      const r = runs[runs.length - 1];
      const bad = (r.steps || []).find((s) => !s.ok);
      log(`  hold ${String(hold).padStart(4)}ms  ${LABEL[r.status]}${bad ? ` — ${bad.n}번째 ${bad.do}: ${bad.error}` : r.error ? ` — ${r.error}` : ''}`);
    }
  } catch (e) {
    for (const hold of holds.slice(runs.length)) runs.push({ hold, status: 'error', error: e.message.split('\n')[0], steps: [], shots: [] });
  } finally {
    await cleanup();
    process.off('SIGINT', onSig); process.off('SIGTERM', onSig);
  }
  const report = { scenario: scenario.name, description: scenario.description, target: url || `--serve ${appDir}`, at: new Date().toISOString(), holds, runs };
  report.summary = summaryLine(runs);
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(out, 'index.html'), renderHtml(report));
  return report;
}

export async function main(argv = process.argv.slice(2)) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { console.error(`human-check: ${e.message}\n\n${HELP}`); return 2; }
  if (opts.help) { console.log(HELP); return 0; }
  const file = path.resolve(opts._[0]);
  let scenario;
  try { scenario = parseScenario(fs.readFileSync(file, 'utf8'), path.basename(file)); } catch (e) { console.error(`human-check: ${e.message}`); return 2; }
  const out = opts.out ? path.resolve(opts.out) : fs.mkdtempSync(path.join(os.tmpdir(), 'human-check-'));
  const report = await runAll({ scenario, holds: opts.holds, url: opts.url || null, serve: !!opts.serve, appDir: path.resolve(opts.app || DEFAULT_APP), out, log: (l) => console.log(l) });
  console.log(`결과: ${path.join(out, 'index.html')}`);
  console.log(report.summary);
  return report.runs.every((r) => r.status === 'pass') ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main().then((code) => { process.exitCode = code; });
}

// 서버 API·자동화 테스트 파일들이 함께 쓰는 준비 — 환경 변수·임시 폴더·서버 띄우기·before/after·도우미.
// 이름이 `.test.js`로 끝나지 않아 `node --test *.test.js`가 따로 돌리지 않고, 화면에도 나가지 않는다(server.js의 차단 목록).
// 각 테스트 파일은 맨 위에서 이 파일을 require한다 — 그 순간 서버가 임시 폴더를 보고 뜰 준비를 하고,
// 아래 before/after/beforeEach는 그 파일의 모든 테스트에 걸린다(예전 server.test.js 한 파일일 때와 같다).
const { before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');

process.env.TZ = 'Asia/Seoul';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-regression-'));
process.env.WORKSPACE_DATA_DIR = directory;
// 자동화 로그·요청 폴더도 임시 폴더로 끼운다 — 테스트가 실제 홈 폴더(`~/.local/share/workspace-automation`)를
// 읽지도 쓰지도 않게.
const automationHome = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-automation-'));
process.env.WORKSPACE_AUTOMATION_DIR = automationHome;
// `지금 가져오기`가 "등록돼 있는지" 보는 launchd 폴더도 임시 폴더다 — 실제 ~/Library/LaunchAgents를 보지 않게.
process.env.WORKSPACE_LAUNCH_AGENTS_DIR = path.join(automationHome, 'LaunchAgents');
// Applications 폴더도 임시 폴더다 — 서버의 픽스처 안전망이 실제 ~/Applications를 가리키지 않게.
process.env.WORKSPACE_APPLICATIONS_DIR = path.join(automationHome, 'Applications');
// 설정 › 앱의 `데이터 백업` 줄이 읽는 백업 폴더도 임시 폴더다 — 실제 ~/workspace-data-backup을 보지 않게.
process.env.WORKSPACE_BACKUP_DIR = path.join(automationHome, 'workspace-data-backup');
// 설정도 없는 파일로 끼운다 — 운영 폴더에서 돌릴 때 실제 `workspace.config.json`(지라 주소·토큰 위치)을 읽어
// 테스트가 실제 지라에 닿는 일이 없게. 설정이 필요한 테스트는 따로 띄운 서버에 자기 설정을 준다.
process.env.WORKSPACE_CONFIG = path.join(directory, 'absent.config.json');
// 새 버전이 나왔는지 원격에 묻는 것도 끈다 — 테스트가 네트워크에 닿지 않게.
process.env.WORKSPACE_NO_REMOTE_CHECK = '1';
// 토큰 폴더도 임시 폴더다 — 설정 없는 서버가 실제 `~/.config`의 토큰·갱신 정보 파일을 보지 않게(값은 물론 있는지도).
// 슬랙 자동 갱신 타이머도 확실히 끈다(진짜 서버를 띄우는 시험이 이 환경을 물려받는다).
process.env.WORKSPACE_TOKEN_DIR = path.join(automationHome, 'tokens');
process.env.WORKSPACE_NO_SLACK_REFRESH = '1';
// 점검하기 `앱 자동화가 쓰는 Claude 계정` 줄이 읽는 Claude Code 기본 설정 파일도 없는 임시 자리로 — 실제 ~/.claude.json(로그인 계정)을 보지 않게.
process.env.WORKSPACE_CLAUDE_GLOBAL_CONFIG = path.join(automationHome, 'claude-global.json');
// 슬랙 수집의 쉬는 시간(9~19시 밖이면 카드가 `대기 중`·실패를 숨김)이 시험을 돌린 시각에 따라 달라지지 않게 — 기본은 오늘 낮 12시
// (이 프로세스의 서버와 시험이 띄우는 서버 모두). 쉬는 시간을 보는 시험은 setSlackClockForTests로 따로 끼우고 끝나면 null로 되돌린다.
process.env.WORKSPACE_SLACK_TEST_HOUR = '12';
const { server } = require('./server');
const date = value => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
const today = date(new Date());
const shifted = days => { const value = new Date(); value.setDate(value.getDate() + days); return date(value); };
let base;
const tasksPath = path.join(directory, 'tasks.md');
const readTasks = () => fs.readFileSync(tasksPath, 'utf8');
async function post(route, body) {
  const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, ...await response.json() };
}
const items = async () => (await fetch(base + '/api/items')).json();

// 서버는 한 번만 띄운다. 테스트 파일도 같은 약속(ready)을 기다려 주소를 받는다 — before 훅이 도는 차례에 기대지 않게
// (node:test는 테스트 파일의 before를 이 파일의 before보다 먼저 돌릴 수 있다).
let listening = null;
const ready = () => (listening ||= new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  .then(() => { base = `http://127.0.0.1:${server.address().port}`; return base; }));
before(ready);
after(async () => {
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(directory, { recursive: true });
  fs.rmSync(automationHome, { recursive: true, force: true });
});
beforeEach(() => {
  fs.writeFileSync(path.join(directory, '.workflow.json'), JSON.stringify({ items: {}, meetings: {} }));
  fs.writeFileSync(tasksPath, `# Tasks\n- Legacy overdue #task[id:legacy status:to-do priority:high created:${shifted(-4)} due:${shifted(-2)} source:slack:https://example.test/message]\n- New unseen #task[id:unseen status:to-do priority:medium created:${today} scheduled:${today} source:slack:https://example.test/another]\n`);
});


// 시작 시 복구는 모듈로 불러올 때 실행되지 않는다. 실제 `node server.js`를 띄워서 확인한다.
const freePort = () => new Promise(resolve => {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;

// 시험이 띄운 자식 프로세스를 기다리는 **안전망** — 성공 경로는 이 값에 기대지 않는다. 자식이 멈춰 버렸을 때 시험이
// 영원히 걸려 있지 않게 하는 것뿐이다(release.sh는 --test-timeout 없이 돈다). 맥이 메모리·CPU로 멈칫하면 node 하나 뜨는 데
// 10~20초, setup.sh 한 번에 60초도 걸려(2026-10-08 측정 — 평소 0.1초·몇 초) 예전의 10·20·60초 마감이 진짜 실패가 아닌데 울렸다.
const HANG_MS = 5 * 60 * 1000;
// 안전망에 걸린 실패는 이 머리말로 시작한다 — 일반 실패(값이 틀림)와 "멈춤"을 글자로 가른다.
const HANG_LABEL = `멈춤(안전망 ${HANG_MS / 60000}분):`;

// 끝나기만 기다리는 동기 자식(셸 스크립트·node 한 번) — spawnSync에 안전망을 걸고, 거기 걸리면 "멈춤"으로 던진다.
// 그 밖에는 spawnSync 결과를 그대로 돌려준다(종료 코드·출력은 부른 쪽이 본다).
function runSync(command, args, options = {}) {
  const result = spawnSync(command, args, { ...options, timeout: HANG_MS });
  if (result.error && result.error.code === 'ETIMEDOUT') {
    throw new Error(`${HANG_LABEL} ${path.basename(String(command))} ${args.map(String).join(' ').slice(0, 200)}\n${result.stdout || ''}${result.stderr || ''}`);
  }
  return result;
}

// 띄운 서버가 들을 때까지 기다린다 — 벽시계 몇 초가 아니라 "듣기 시작했다"는 한 줄(server.js의 `슬랙 인박스 앱: http…`,
// 가짜 래퍼의 `ready`)과 "끝나 버림"을 기다린다. 들은 뒤 storage-status가 200인지 한 번 본다(예전 확인 그대로).
// `log`는 부른 쪽이 stdout·stderr를 모으는 함수 — 부른 쪽의 'data' 듣기가 먼저 걸려 있어야 한다(모두 spawn 바로 뒤에 건다).
function serverReady(child, origin, log) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`${HANG_LABEL} 서버가 듣기 시작하지 않았습니다: ${log()}`)), HANG_MS);
    const onData = () => { if (/^(?:ready|슬랙 인박스 앱: http)/m.test(log())) finish(); };
    // 'exit'가 아니라 'close' — 죽기 전에 찍은 이유(stderr)가 log에 다 들어온 뒤에 알린다.
    const onExit = code => finish(new Error(`서버가 종료되었습니다 (${code}): ${log()}`));
    function finish(error) {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.off('close', onExit);
      if (error) reject(error); else resolve();
    }
    child.stdout.on('data', onData);
    child.once('close', onExit);
    if (child.exitCode !== null && child.stdout.destroyed) onExit(child.exitCode); else onData();
  }).then(async () => {
    const response = await fetch(origin + '/api/storage-status');
    if (!response.ok) throw new Error(`서버가 듣기 시작했지만 storage-status가 ${response.status}입니다: ${log()}`);
  });
}
const journalEntry = (file, before, after) => JSON.stringify({ changes: [{ file, before: Buffer.from(before).toString('base64'), after: createHash('sha256').update(after).digest('hex'), intermediate: [] }] });
async function startServer(t, seed) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-recovery-'));
  seed(home);
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, WORKSPACE_DATA_DIR: home, WORKSPACE_PORT: String(port), WORKSPACE_NO_OPEN: '1', WORKSPACE_HOST: '', WORKSPACE_CONFIG: path.join(home, 'absent.config.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(home, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  await serverReady(child, base, () => log);
  return { home, base, log: () => log };
}

// ---------- 지라 직접 읽기 (BJR 1단계 — 보기만) ----------
// 실제 지라는 절대 부르지 않는다: 아래 테스트는 전부 가짜 fetch와 가짜 토큰 읽기만 쓴다.
const jiraModule = require('./jira-client');
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function jiraFake(routes) {
  const calls = [];
  const request = async (url, options) => {
    const method = (options && options.method) || 'GET';
    calls.push({ url, headers: options.headers, method, body: options && options.body ? JSON.parse(options.body) : null });
    const hit = Object.keys(routes).find(part => String(url).includes(part));
    if (!hit) return json({ errorMessages: ['no route'] }, 500);
    const answer = routes[hit];
    if (typeof answer === 'function') return answer(String(url), method);
    return answer();
  };
  return { request, calls };
}
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.test', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.test' };
const runGit = (cwd, args) => spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: gitEnv });
const gitReady = spawnSync('git', ['--version']).status === 0;

// 서버를 실제로 띄운다(모듈로 부르면 시작 검사가 돌지 않는다).
async function startAppServer(t, env) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, WORKSPACE_PORT: String(port), WORKSPACE_NO_OPEN: '1', WORKSPACE_HOST: '', WORKSPACE_NO_REMOTE_CHECK: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  t.after(() => child.kill('SIGKILL'));
  const address = `http://127.0.0.1:${port}`;
  await serverReady(child, address, () => log);
  return { base: address, log: () => log };
}

// ─────────────────────────────────────────────────────────────────────────────
// 설정 > 연동 (WP-B) — 앱이 `workspace.config.json`을 쓰는 단 하나의 자리
//
// 여기서도 **실제 설정·실제 토큰 파일·실제 지라/슬랙에는 절대 닿지 않는다**: config는 임시 폴더에
// 따로 만든 파일이고, 토큰 폴더도 임시 폴더를 끼우며(WORKSPACE_TOKEN_DIR), 바깥으로 나가는 길은
// 전부 가짜 fetch다. 프로세스를 끝내는 `exit`도 끼워 넣으므로 테스트가 스스로 종료되지 않는다.
const integrationsStore = require('./integrations');

// 임시 config + 임시 토큰 폴더 한 벌. 실제 `~/.config`·실제 설정에는 닿지 않는다.
function integrationsFixture(t, seed = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-integrations-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const configPath = path.join(home, 'workspace.config.json');
  fs.writeFileSync(configPath, JSON.stringify(seed, null, 2));
  const tokenDir = path.join(home, 'config');
  const read = () => JSON.parse(fs.readFileSync(configPath, 'utf8'));
  return { home, configPath, tokenDir, read };
}

// 업무 줄을 고치면 수정 시각(updated)이 새로 붙고, 쓰기 응답에는 그 시각(revisions)이 실린다 — 줄·응답의 다른 칸을 볼 때 뺀다.
const withoutStamp = text => text.replace(/ updated:[^\s\]]+/g, '');
const withoutRevisions = ({ revisions, ...rest }) => rest;

module.exports = {
  withoutStamp, withoutRevisions,
  directory, automationHome, server, date, today, shifted, tasksPath, readTasks, post, items,
  // 서버 주소(`base`)는 띄운 뒤에야 정해지므로 값이 아니라 기다릴 약속으로 내보낸다.
  ready,
  freePort, deadPid, HANG_MS, HANG_LABEL, runSync, serverReady, journalEntry, startServer, jiraModule, json, jiraFake, readJson, gitEnv, runGit, gitReady, startAppServer, integrationsStore, integrationsFixture,
};

// 써 보기 서버(tryout-server.js)와 저장소 뿌리 tryout.sh의 안전 시험.
// 서버는 진짜로 띄우되 임시 폴더(TMPDIR)·가짜 홈(HOME)·빈 포트를 끼우고, tryout.sh는 LaunchAgents 자리와 launchctl을 가짜로 끼운다
// — 실제 ~/Library/LaunchAgents·launchd·운영 포트에는 닿지 않는다.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const tryout = require('./tryout-server');

const REPO = path.join(__dirname, '..', '..');
const SCRIPT = path.join(REPO, 'tryout.sh');
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tryout-test-')));
const children = new Set();
after(() => {
  for (const child of children) child.kill('SIGTERM');   // 이 시험이 직접 띄운 것만
  fs.rmSync(sandbox, { recursive: true, force: true });
});

let boxes = 0;
// 시험 하나가 쓰는 자리 — 가짜 홈과 그 밖의 임시 폴더.
function box() {
  const root = path.join(sandbox, `box-${++boxes}`);
  const home = path.join(root, 'home'), tmp = path.join(root, 'tmp');
  fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(tmp, { recursive: true });
  return { root, home, tmp };
}
const freePort = () => new Promise(resolve => {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});
// 써 보기 서버를 띄운다 — 뜨면 주소를, 뜨기 전에 끝나면 종료 코드를 돌려준다.
function launch({ home, tmp }, port, extra = {}) {
  const child = spawn(process.execPath, [path.join(__dirname, 'tryout-server.js')], {
    env: { PATH: process.env.PATH, TZ: 'Asia/Seoul', HOME: home, TMPDIR: tmp, TRYOUT_PORT: String(port), ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let out = '';
  const exited = new Promise(resolve => child.on('exit', code => { children.delete(child); resolve(code); }));
  const up = new Promise(resolve => {
    const read = chunk => { out += chunk; if (out.includes('써 보기 서버: http')) resolve(true); };
    child.stdout.on('data', read); child.stderr.on('data', read);
    exited.then(() => resolve(false));
  });
  return { child, exited, up, base: `http://localhost:${port}`, log: () => out };
}
const stop = async run => { run.child.kill('SIGTERM'); return run.exited; };
const items = async base => (await fetch(`${base}/api/items`)).json();
const post = (base, route, body) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const counts = data => [data.inboxTasks.length, data.todayTasks.length, data.laterTasks.length, data.waiting.length, data.decisions.length, data.ideas.length];
const SEEDED = [5, 10, 4, 3, 2, 1];
// 폴더 아래 모든 파일 경로(가짜 홈이 비어 있는지 볼 때).
const tree = dir => fs.readdirSync(dir, { recursive: true }).map(String).sort();

test('가짜 데이터가 기대한 개수로 읽히고, 물려받은 환경변수가 실제 자리를 가리켜도 임시 폴더만 쓴다', async () => {
  const at = box(), port = await freePort();
  const hostile = path.join(at.home, '.config', 'real');
  // 운영처럼 보이는 값을 일부러 물려준다 — 써 보기 서버가 전부 덮어쓰거나 지워야 한다.
  const run = launch(at, port, {
    WORKSPACE_DATA_DIR: hostile, WORKSPACE_CONFIG: path.join(hostile, 'workspace.config.json'), WORKSPACE_TOKEN_DIR: hostile,
    WORKSPACE_AUTOMATION_DIR: hostile, WORKSPACE_LAUNCH_AGENTS_DIR: hostile, WORKSPACE_LOCAL_DIR: hostile, WORKSPACE_BACKUP_DIR: hostile,
    WORKSPACE_MANAGED: '1', WORKSPACE_CHECKIN: '1', WORKSPACE_SLACK_FOLLOW: '1', WORKSPACE_PORT: '4321',
  });
  assert.equal(await run.up, true, run.log());
  const data = await items(run.base);
  assert.deepEqual(counts(data), SEEDED, '새로 들어온 것 5 · 오늘 10 · 나중에 4 · 확인 대기 3 · 결정 2 · 아이디어 1');
  assert.equal(data.title, tryout.TITLE);
  assert.equal(data.todayTasks.filter(task => task.status === 'done').length, 2);
  assert.equal(data.todayTasks.filter(task => task.doing).length, 1);
  assert.ok(data.inboxTasks.some(task => task.group) && data.inboxTasks.some(task => !task.group) && data.inboxTasks.some(task => task.due));
  assert.ok(data.customGroups.length >= 3);
  assert.equal(data.calendar.events.length, 3);
  assert.equal(data.calendar.stale, false);
  const withDrafts = data.workflows.meetings.filter(meeting => (meeting.drafts || []).length);
  assert.equal(withDrafts.length, 1);
  assert.equal(withDrafts[0].drafts.length, 5);
  assert.equal(data.slackSync.connected, true);
  assert.ok(data.weeklyReports.some(week => JSON.stringify(week.draft || {}).includes('완료한 일')), '지난 주 기록이 비지 않는다');
  // 원문 링크는 전부 example.test다.
  const links = JSON.stringify(data).match(/https?:\/\/[^"\\\s]+/g) || [];
  assert.ok(links.length > 0);
  for (const link of links) assert.match(link, /^https:\/\/(example\.test|fixture-team\.slack\.com)\//, link);
  // 슬랙 연결은 포트 때문에 주소를 내주지 않는다.
  const oauth = await post(run.base, '/api/integrations/slack-oauth/start', {});
  const answer = await oauth.json();
  assert.equal(answer.kind, 'port');
  assert.equal(JSON.stringify(answer).includes('slack.com'), false);
  // 사람이 연동 화면에서 누르는 확인(앱 서버의 가드 밖)도 바깥에 닿지 않는다 — 슬랙이 답했다면 `invalid_auth`였을 것이다.
  const check = await (await post(run.base, '/api/integrations/slack-token-check', {})).json();
  assert.equal(check.ok, false);
  assert.notEqual(check.code, 'invalid_auth');
  assert.match(run.log(), /바깥 요청을 막았어요: slack\.com/);
  // 서버 파일은 화면으로 나가지 않는다.
  assert.equal((await fetch(`${run.base}/tryout-server.js`)).status, 404);
  assert.equal(await stop(run), 0);
  assert.deepEqual(tree(at.home), [], '가짜 홈(실제 자리로 꾸민 곳)에 아무것도 쓰지 않는다');
  assert.deepEqual(fs.readdirSync(at.tmp), [], '끝나면 임시 폴더를 치운다');
});

test('처음 상태로 — 서버를 다시 띄우지 않고 돌아오고, 임시 폴더 밖을 쓰지 않으며, 다른 출처의 요청은 거절한다', async () => {
  const at = box(), port = await freePort();
  const run = launch(at, port);
  assert.equal(await run.up, true, run.log());
  const page = await fetch(`${run.base}/__tryout`);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /<form method="post" action="\/__tryout\/reset"><button type="submit">처음 상태로<\/button><\/form>/);
  assert.doesNotMatch(html, /<script|src=|https?:\/\//, '스크립트·외부 자원이 없다');
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);

  assert.equal((await post(run.base, '/api/today-task/create', { description: '망가뜨리기 시험', priority: 'medium' })).status, 200);
  assert.equal((await post(run.base, '/api/track/remove', { id: 'i1' })).status, 200);
  assert.deepEqual(counts(await items(run.base)), [4, 11, 4, 3, 2, 1]);

  const reset = headers => fetch(`${run.base}/__tryout/reset`, { method: 'POST', headers, redirect: 'manual' });
  assert.equal((await reset({ Origin: 'http://evil.example' })).status, 403, '다른 출처');
  assert.equal((await reset({ Origin: `http://localhost:${port + 1}` })).status, 403, '다른 포트의 출처');
  assert.equal((await reset({ 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await reset({ 'Sec-Fetch-Site': 'same-site' })).status, 403);
  assert.equal((await fetch(`${run.base}/__tryout/reset`)).status, 405, 'GET으로는 돌리지 않는다');
  assert.deepEqual(counts(await items(run.base)), [4, 11, 4, 3, 2, 1], '거절한 요청은 아무것도 바꾸지 않는다');

  const [folder] = fs.readdirSync(at.tmp);
  const done = await reset({ Origin: `http://localhost:${port}`, 'Sec-Fetch-Site': 'same-origin' });
  assert.equal(done.status, 303);
  assert.equal(done.headers.get('location'), '/');
  assert.deepEqual(counts(await items(run.base)), SEEDED);
  assert.deepEqual(fs.readdirSync(at.tmp), [folder], '같은 임시 폴더 하나만 남는다(새로 만든 폴더는 치운다)');
  assert.deepEqual(tree(at.home), []);

  // 설정(제목)을 바꿨으면 손으로 띄운 서버는 데이터만 돌리고 살아 있다.
  assert.equal((await post(run.base, '/api/personalize', { title: '바꾼 제목' })).status, 200);
  assert.equal((await reset({})).status, 303);
  assert.equal((await fetch(`${run.base}/__tryout`)).status, 200);
  const config = JSON.parse(fs.readFileSync(path.join(at.tmp, folder, 'repo', 'workspace.config.json'), 'utf8'));
  assert.equal(config.title, tryout.TITLE);
  assert.ok(config.slack.tokenFile.startsWith(path.join(at.tmp, folder)), '설정의 토큰 칸도 지금 임시 폴더를 가리킨다');
  assert.equal(await stop(run), 0);
});

test('launchd가 띄운 자리에서는 설정까지 바뀌었을 때 스스로 끝나 다시 켜지게 한다(자기 자신만)', async () => {
  const at = box(), port = await freePort();
  const run = launch(at, port, { TRYOUT_KEEPALIVE: '1' });
  assert.equal(await run.up, true, run.log());
  // 데이터만 바뀌었으면 끝나지 않는다.
  assert.equal((await fetch(`${run.base}/__tryout/reset`, { method: 'POST', redirect: 'manual' })).status, 303);
  assert.equal((await post(run.base, '/api/personalize', { title: '바꾼 제목' })).status, 200);
  const answer = await fetch(`${run.base}/__tryout/reset`, { method: 'POST', redirect: 'manual' });
  assert.equal(answer.status, 200);
  assert.match(await answer.text(), /http-equiv="refresh" content="4;url=\/"/);
  assert.equal(await run.exited, 0);
  assert.deepEqual(fs.readdirSync(at.tmp), []);
});

test('시작할 때 자기 이름표가 있는 같은 포트의 옛 폴더만 치운다', async () => {
  const at = box(), port = await freePort();
  const make = (name, mark) => {
    const dir = path.join(at.tmp, name);
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    if (mark !== undefined) fs.writeFileSync(path.join(dir, tryout.MARK), mark);
    return dir;
  };
  make('workspace-browser-mine', JSON.stringify({ port, pid: 1 }));
  make('workspace-browser-otherport', JSON.stringify({ port: port + 1, pid: 1 }));
  make('workspace-browser-nomark');
  make('workspace-browser-broken', '{');
  make('something-else', JSON.stringify({ port, pid: 1 }));
  const run = launch(at, port);
  assert.equal(await run.up, true, run.log());
  const left = fs.readdirSync(at.tmp).sort();
  assert.equal(left.includes('workspace-browser-mine'), false);
  for (const name of ['workspace-browser-otherport', 'workspace-browser-nomark', 'workspace-browser-broken', 'something-else']) assert.ok(left.includes(name), name);
  assert.equal(left.length, 5, '지금 쓰는 폴더 하나 + 남긴 넷');
  assert.equal(await stop(run), 0);
});

test('임시 폴더가 실제 설치 위치 아래면 시작하지 않는다(서버의 안전망)', async () => {
  const at = box(), port = await freePort();
  const tmp = path.join(at.home, '.config', 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const run = launch({ home: at.home, tmp }, port);
  assert.equal(await run.up, false);
  assert.equal(await run.exited, 1);
  assert.match(run.log(), /실제 설치 위치를 가리켜서 시작하지 않아요/);
  assert.deepEqual(fs.readdirSync(tmp), [], '만들던 폴더도 남기지 않는다');
  await assert.rejects(fetch(`http://localhost:${port}/api/items`));
});

test('운영 앱·슬랙 연결 자리(4321~4331)에서는 열지 않는다', async () => {
  const at = box();
  for (const port of ['4321', '4325', '4331', '80', 'abc']) {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'tryout-server.js')], {
      env: { PATH: process.env.PATH, HOME: at.home, TMPDIR: at.tmp, TRYOUT_PORT: port }, encoding: 'utf8',
    });
    assert.equal(result.status, 1, port);
    assert.match(result.stderr, /열지 않아요/);
  }
  assert.deepEqual(fs.readdirSync(at.tmp), [], '임시 폴더도 만들지 않는다');
  assert.equal(tryout.DEFAULT_PORT, 4340);
});

test('/__tryout 요청 판단 — 루프백 소켓·localhost 주소·같은 출처만', () => {
  const req = (over = {}) => ({ method: 'POST', socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:4340' }, ...over });
  assert.equal(tryout.tryoutAllowed(req(), 4340), true);
  assert.equal(tryout.tryoutAllowed(req({ headers: { host: '127.0.0.1:4340', origin: 'http://127.0.0.1:4340' } }), 4340), true);
  assert.equal(tryout.tryoutAllowed(req({ socket: { remoteAddress: '192.168.0.7' } }), 4340), false, '루프백 밖');
  assert.equal(tryout.tryoutAllowed(req({ socket: { remoteAddress: '100.64.0.2' }, method: 'GET' }), 4340), false);
  assert.equal(tryout.tryoutAllowed(req({ headers: { host: 'evil.example' } }), 4340), false);
  assert.equal(tryout.tryoutAllowed(req({ headers: { host: 'localhost:4321' } }), 4340), false, '다른 포트의 주소');
  assert.equal(tryout.tryoutAllowed(req({ headers: { host: 'localhost:4340', origin: 'null' } }), 4340), false);
  assert.equal(tryout.tryoutAllowed(req({ headers: {} }), 4340), false);
});

test('회의 시각 — 하루 어느 때든 세 회의가 겹치지 않는 바른 시각이고 가운데 것이 지금을 덮는다', () => {
  for (const [hour, minute] of [[0, 0], [0, 40], [1, 59], [9, 5], [13, 40], [20, 30], [21, 15], [23, 50]]) {
    const now = new Date(2030, 0, 15, hour, minute);
    const times = tryout.meetingTimes(now);
    const spans = Object.values(times);
    for (const [start, end] of spans) {
      assert.match(start, /^([01]\d|2[0-3]):[0-5]\d$/); assert.match(end, /^([01]\d|2[0-3]):[0-5]\d$/);
      assert.ok(start < end, `${hour}:${minute} ${start}-${end}`);
    }
    assert.equal(new Set(spans.map(span => span[0])).size, 3);
    const at = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    if (hour < 23) assert.ok(times.live[0] <= at && at < times.live[1], `${at} 진행 중`);
  }
});

test('가짜 데이터에는 지어낸 주소만 있고 날짜는 실행하는 날 기준이다', () => {
  const dir = path.join(box().tmp, 'data');
  fs.mkdirSync(dir);
  tryout.seedData(dir, new Date(2030, 0, 15, 13, 40));
  const all = fs.readdirSync(dir).map(name => fs.readFileSync(path.join(dir, name), 'utf8')).join('\n');
  assert.match(all, /scheduled:2030-01-15/);
  assert.match(all, /due:2030-01-25/);
  assert.match(all, /마지막 갱신: 2030-01-15/);
  for (const link of all.match(/https?:\/\/[^\s"\]]+/g)) assert.match(link, /^https:\/\/example\.test\//);
  assert.equal((all.match(/@/g) || []).length, 0, '메일 주소·멘션이 없다');
});

// ---------- tryout.sh — LaunchAgents 자리와 launchctl을 가짜로 끼운다 ----------
function shellBox({ channel = 'main', port } = {}) {
  const at = box();
  const agents = path.join(at.root, 'LaunchAgents'), logs = path.join(at.root, 'logs'), calls = path.join(at.root, 'launchctl.calls');
  const fake = path.join(at.root, 'fake-launchctl');
  fs.writeFileSync(fake, `#!/bin/bash\necho "$@" >> "${calls}"\nexit 0\n`, { mode: 0o755 });
  const config = path.join(at.root, 'workspace.config.json');
  if (channel !== null) fs.writeFileSync(config, JSON.stringify({ server: { port: 4321, updateChannel: channel } }));
  const env = {
    PATH: process.env.PATH, HOME: at.home, TRYOUT_LAUNCH_AGENTS_DIR: agents, TRYOUT_LOG_DIR: logs, TRYOUT_CONFIG: config,
    TRYOUT_LAUNCHCTL: fake, TRYOUT_PORT: String(port),
  };
  const run = (...args) => spawnSync('/bin/bash', [SCRIPT, ...args], { env, encoding: 'utf8' });
  const called = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : []);
  return { at, env, agents, logs, plist: path.join(agents, 'com.workspace.app.tryout.plist'), run, called };
}

test('tryout.sh install — 자기 plist 하나만 만들고 올린다', async () => {
  const sh = shellBox({ port: await freePort() });
  fs.mkdirSync(sh.agents, { recursive: true });
  const other = path.join(sh.agents, 'com.workspace.app.server.plist');
  fs.writeFileSync(other, 'other');
  const result = sh.run('install');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const plist = fs.readFileSync(sh.plist, 'utf8');
  assert.match(plist, /<string>com\.workspace\.app\.tryout<\/string>/);
  assert.ok(plist.includes(`<string>${path.join(fs.realpathSync(REPO), 'tracker', 'inbox-app', 'tryout-server.js')}</string>`) || plist.includes(`<string>${path.join(REPO, 'tracker', 'inbox-app', 'tryout-server.js')}</string>`), '저장소 코드를 그대로 실행한다');
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<key>TRYOUT_KEEPALIVE<\/key>\s*<string>1<\/string>/);
  assert.ok(plist.includes(`<string>${path.join(sh.logs, 'tryout.log')}</string>`));
  assert.doesNotMatch(plist, /WORKSPACE_MANAGED/, '운영 설치본 표시를 넘기지 않는다');
  assert.equal(spawnSync('/usr/bin/plutil', ['-lint', sh.plist]).status, 0);
  assert.deepEqual(sh.called(), [`load ${sh.plist}`]);
  assert.equal(fs.readFileSync(other, 'utf8'), 'other');
  assert.deepEqual(fs.readdirSync(sh.agents).sort(), ['com.workspace.app.server.plist', 'com.workspace.app.tryout.plist']);
  // 다시 돌리면 내 것을 내렸다가 다시 올린다.
  assert.equal(sh.run('install').status, 0);
  assert.deepEqual(sh.called(), [`load ${sh.plist}`, `unload ${sh.plist}`, `load ${sh.plist}`]);
  assert.deepEqual(tree(sh.at.home), []);
});

test('tryout.sh install — 받는 갈래가 main이 아니면(동료 설치) 아무것도 바꾸지 않는다', async () => {
  for (const channel of ['stable', '', null]) {
    const sh = shellBox({ channel, port: await freePort() });
    const result = sh.run('install');
    assert.equal(result.status, 0);
    assert.match(result.stdout, /아무것도 바꾸지 않았어요/);
    assert.equal(fs.existsSync(sh.agents), false);
    assert.deepEqual(sh.called(), []);
  }
});

test('tryout.sh install — 포트가 쓰이는 중이면 알리고 끝낸다(그 프로그램은 건드리지 않는다)', async () => {
  const holder = net.createServer();
  await new Promise(resolve => holder.listen(0, '127.0.0.1', resolve));
  try {
    const sh = shellBox({ port: holder.address().port });
    // 포트를 쥔 채로 스크립트를 기다려야 하므로 비동기로 돌린다.
    const result = await new Promise(resolve => {
      const child = spawn('/bin/bash', [SCRIPT, 'install'], { env: sh.env });
      let out = '';
      child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { out += chunk; });
      child.on('exit', status => resolve({ status, out }));
    });
    assert.equal(result.status, 1);
    assert.match(result.out, /다른 프로그램이 쓰고 있어요/);
    assert.equal(fs.existsSync(sh.plist), false);
    assert.deepEqual(sh.called(), []);
    assert.equal(holder.listening, true);
  } finally { await new Promise(resolve => holder.close(resolve)); }
  for (const port of ['4321', '4331', 'abc']) {
    const sh = shellBox({ port });
    assert.equal(sh.run('install').status, 1, port);
    assert.equal(fs.existsSync(sh.plist), false);
  }
});

test('tryout.sh uninstall·restart·status — 자기 이름표 하나만 다룬다', async () => {
  const sh = shellBox({ port: await freePort() });
  assert.equal(sh.run('restart').status, 1, '올리기 전에는 다시 켜지 않는다');
  assert.equal(sh.run('uninstall').status, 0);
  assert.match(sh.run('status').stdout, /올리지 않았어요/);
  assert.deepEqual(sh.called(), []);
  assert.equal(sh.run('install').status, 0);
  const other = path.join(sh.agents, 'com.workspace.app.server.plist');
  fs.writeFileSync(other, 'other');
  assert.equal(sh.run('restart').status, 0);
  assert.match(sh.run('status').stdout, /launchd에 올라가 있어요/);
  assert.equal(sh.run('uninstall').status, 0);
  const uid = process.getuid();
  assert.deepEqual(sh.called(), [
    `load ${sh.plist}`, `kickstart -k gui/${uid}/com.workspace.app.tryout`, 'list com.workspace.app.tryout', `unload ${sh.plist}`,
  ]);
  assert.deepEqual(fs.readdirSync(sh.agents), ['com.workspace.app.server.plist']);
  assert.equal(sh.run('nope').status, 2);
});

test('tryout.sh는 프로세스를 훑거나 끝내지 않고, 설치·업데이트·배포 스크립트는 써 보기 서버를 모른다', () => {
  const script = fs.readFileSync(SCRIPT, 'utf8').split('\n').filter(row => !row.trim().startsWith('#')).join('\n');
  assert.doesNotMatch(script, /\b(pkill|killall|kill|pgrep|lsof)\b|\bps\s|xargs/);
  for (const label of script.match(/com\.workspace\.[\w.]+/g)) assert.equal(label, 'com.workspace.app.tryout');
  for (const name of ['setup.sh', 'update.sh', 'release.sh', 'make-team-installer.sh']) {
    const file = path.join(REPO, name);
    if (fs.existsSync(file)) assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /tryout/i, name);
  }
  const server = fs.readFileSync(path.join(__dirname, 'tryout-server.js'), 'utf8');
  assert.doesNotMatch(server, /child_process|process\.kill|\bfetch\(/, '프로세스를 띄우지도, 신호를 보내지도, 바깥에 요청하지도 않는다');
});

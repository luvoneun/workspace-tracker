// 서버: 앱 정보·데이터 버전·꾸미기·픽스처 안전망. 공용 준비는 test-support.js.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const support = require('./test-support');
const { directory, freePort, runGit, gitReady, startAppServer } = support;
let base;
before(async () => { base = await support.ready(); });

// ─────────────────────────────────────────────────────────────────────────────
// 배포·업데이트 (VERSION · /api/about · 데이터 형식 · 자동화 설치 위치 · update.sh)
//
// 사람의 데이터가 업데이트로 깨지지 않는 것이 이 묶음의 목적이다. 그래서 여기서는
// **실제 launchd·실제 홈 폴더·실제 저장소를 절대 건드리지 않고** 임시 폴더 + 로컬 bare 저장소 +
// PATH 앞에 세운 가짜 `launchctl`·`curl`로만 확인한다(run-task.sh 테스트와 같은 방식).
const migrateStore = require('./migrate');

test('GET /api/about은 버전·데이터 형식·받는 갈래를 알려 주고 파일을 쓰지 않는다', async () => {
  const before = fs.readdirSync(directory).sort();
  const about = await (await fetch(base + '/api/about')).json();
  assert.equal(about.version, fs.readFileSync(path.join(__dirname, '..', '..', 'VERSION'), 'utf8').trim());
  assert.equal(about.dataFormat, 1);
  assert.equal(about.channel, 'stable', '설정이 없으면 배포된 버전만 받는 갈래다');
  assert.equal(about.install, 'manual', 'launchd가 띄운 자리가 아니면 manual이다');
  assert.equal(about.latest, null, 'WORKSPACE_NO_REMOTE_CHECK=1이면 원격에 묻지 않는다');
  assert.ok(about.modified === null || Array.isArray(about.modified));
  assert.deepEqual(fs.readdirSync(directory).sort(), before, '조회는 어떤 파일도 만들지 않는다');
});

test('/api/about의 `고친 파일`은 추적 파일의 수정·삭제만 세고, git이 없으면 null이다', { skip: !gitReady }, async (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-about-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const data = path.join(repo, 'tracker');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(repo, 'VERSION'), '9.9.9\n');
  fs.writeFileSync(path.join(repo, 'ui.css'), 'body{}\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'tracker/\n');
  runGit(repo, ['init', '-b', 'main']);
  runGit(repo, ['add', '-A']);
  runGit(repo, ['commit', '-m', '첫 커밋']);
  fs.writeFileSync(path.join(repo, 'ui.css'), 'body{color:red}\n');
  fs.writeFileSync(path.join(data, 'tasks.md'), '# Tasks\n');   // 업무 데이터는 gitignore라 잡히면 안 된다

  const app = await startAppServer(t, { WORKSPACE_REPO_DIR: repo, WORKSPACE_DATA_DIR: data, WORKSPACE_CONFIG: path.join(repo, 'absent.json') });
  const about = await (await fetch(app.base + '/api/about')).json();
  assert.equal(about.version, '9.9.9');
  assert.deepEqual(about.modified, ['ui.css'], '고친 추적 파일만 이름으로 센다 — 업무 데이터는 절대 들어가지 않는다');
  assert.match(about.gitRef, /^[0-9a-f]{7,}$/);

  // git을 찾을 수 없는 컴퓨터에서도 앱은 그대로 돌고, 모른다는 뜻으로 null을 준다.
  const blind = await startAppServer(t, { WORKSPACE_REPO_DIR: repo, WORKSPACE_DATA_DIR: data, WORKSPACE_CONFIG: path.join(repo, 'absent.json'), PATH: path.join(repo, 'no-such-bin') });
  const unknown = await (await fetch(blind.base + '/api/about')).json();
  assert.equal(unknown.modified, null);
  assert.equal(unknown.gitRef, null);
  assert.equal(unknown.version, '9.9.9', 'git이 없어도 버전은 파일에서 읽는다');
});

test('데이터가 더 새 형식이면 서버는 아예 시작하지 않는다(종료 코드 3)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-dataver-'));
  fs.writeFileSync(path.join(home, '.data-version'), '9\n');
  fs.writeFileSync(path.join(home, 'tasks.md'), '# Tasks\n');
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, WORKSPACE_DATA_DIR: home, WORKSPACE_PORT: String(port), WORKSPACE_NO_OPEN: '1', WORKSPACE_HOST: '', WORKSPACE_NO_REMOTE_CHECK: '1', WORKSPACE_CONFIG: path.join(home, 'absent.config.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  const code = await new Promise(resolve => child.on('exit', resolve));
  assert.equal(code, 3);
  assert.match(log, /더 새 버전의 앱이 만든 거예요/);
  assert.equal(fs.readFileSync(path.join(home, 'tasks.md'), 'utf8'), '# Tasks\n', '데이터는 손대지 않는다');
  fs.rmSync(home, { recursive: true, force: true });
});

test('migrate.js는 버전이 없으면 1로 보고, 같으면 아무것도 하지 않고, 더 높으면 멈춘다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-migrate-'));
  // 1) 빈 폴더 — 파일이 없으면 지금 형식(1)으로 보고, 조회만으로 파일을 만들지 않는다
  assert.equal(migrateStore.readDataVersion(home), 1);
  assert.equal(fs.existsSync(path.join(home, '.data-version')), false);

  // 2) 같은 버전 — 아무 일도 없다
  const same = migrateStore.migrate(home);
  assert.deepEqual(same.applied, []);
  assert.equal(fs.existsSync(path.join(home, '.data-version')), false, '바꿀 것이 없으면 파일도 만들지 않는다');

  // 3) 더 새 형식 — 옛 앱이 새 데이터를 망치지 않게 멈춘다(CLI는 종료 코드 3)
  fs.writeFileSync(path.join(home, '.data-version'), '9\n');
  assert.equal(migrateStore.migrate(home).ok, false);
  const cli = spawnSync(process.execPath, [path.join(__dirname, 'migrate.js'), '--data', home], { encoding: 'utf8' });
  assert.equal(cli.status, 3);
  assert.match(cli.stderr, /더 새 버전의 앱이 만든 거예요/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('migrate.js는 단계를 번호 순서대로 밟고 .data-version을 갱신하며, --dry-run은 아무것도 바꾸지 않는다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-migrate-steps-'));
  const trail = path.join(home, 'trail.txt');
  const steps = {
    2: dir => fs.appendFileSync(path.join(dir, 'trail.txt'), '2'),
    3: dir => fs.appendFileSync(path.join(dir, 'trail.txt'), '3'),
  };
  const dry = migrateStore.migrate(home, { to: 3, steps, dryRun: true });
  assert.deepEqual(dry.applied, [2, 3]);
  assert.equal(fs.existsSync(trail), false, '확인만 할 때는 파일을 건드리지 않는다');
  assert.equal(fs.existsSync(path.join(home, '.data-version')), false);

  const done = migrateStore.migrate(home, { to: 3, steps });
  assert.deepEqual(done.applied, [2, 3]);
  assert.equal(fs.readFileSync(trail, 'utf8'), '23', '번호가 작은 단계부터 밟는다');
  assert.equal(migrateStore.readDataVersion(home), 3);
  assert.deepEqual(migrateStore.migrate(home, { to: 3, steps }).applied, [], '두 번 밟지 않는다');
  fs.rmSync(home, { recursive: true, force: true });
});
const personalizeStore = require('./personalize');

// 가짜 그림 바이트 — 서버는 시그니처와 머리(IHDR / SOF)만 읽는다.
const fakePng = (width, height, extra = 0) => {
  const head = Buffer.alloc(33 + extra);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write('IHDR', 12, 'ascii');
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return head;
};
const fakeJpeg = (width, height) => Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  0xff, 0xd9,
]);

test('WP-D2 꾸미기: 그림은 형식·크기·치수를 확인하고, Dock 이름·제목은 규칙대로만 받는다', () => {
  assert.deepEqual(personalizeStore.imageInfo(fakePng(512, 256)), { type: 'png', width: 512, height: 256 });
  assert.deepEqual(personalizeStore.imageInfo(fakeJpeg(300, 200)), { type: 'jpeg', width: 300, height: 200 });
  assert.equal(personalizeStore.imageInfo(Buffer.from('GIF89a' + 'x'.repeat(40))), null);
  assert.throws(() => personalizeStore.checkIcon(fakePng(64, 512)), /가로세로 128px 이상인 그림을 골라 주세요/);
  assert.throws(() => personalizeStore.checkIcon(Buffer.from('GIF89a' + 'x'.repeat(40))), /PNG나 JPG 그림만 쓸 수 있어요/);
  assert.throws(() => personalizeStore.checkIcon(fakePng(512, 512, 5 * 1024 * 1024)), /그림은 5MB까지 쓸 수 있어요/);
  assert.equal(personalizeStore.checkIcon(fakeJpeg(128, 128)).type, 'jpeg');

  assert.equal(personalizeStore.checkDockName('  내 일터 '), '내 일터');
  for (const wrong of ['', ' ', 'a/b', 'a:b', '줄\n바꿈', '.숨김', 'x'.repeat(31)]) {
    assert.throws(() => personalizeStore.checkDockName(wrong), /Dock 이름은 1~30자로/, JSON.stringify(wrong));
  }
  assert.equal(personalizeStore.checkDockName('가'.repeat(30)).length, 30, '한글 30자까지');
  assert.throws(() => personalizeStore.checkTitle(''), /워크스페이스 제목은 1~40자로/);
  assert.throws(() => personalizeStore.checkTitle('가'.repeat(41)), /1~40자/);
  assert.equal(personalizeStore.tildePath('/Users/someone/work/업데이트.command', '/Users/someone'), '~/work/업데이트.command');
  assert.equal(personalizeStore.tildePath('/opt/work/업데이트.command', '/Users/someone'), '/opt/work/업데이트.command');
});

// WP-L 크롬 `앱으로 설치`가 읽는 manifest — 파일이 아니라 꾸미기(Dock 이름·아이콘)를 따라 서버가 만든다.
test('WP-L manifest: 이름·아이콘이 꾸미기를 따르고(없으면 워크스페이스·기본 토끼), 인증 없이 여는 목록은 그대로다', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-manifest-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const repo = path.join(home, 'repo');
  const data = path.join(repo, 'tracker');
  fs.mkdirSync(path.join(repo, 'local'), { recursive: true });
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(repo, 'VERSION'), '1.0.0\n');
  const config = path.join(home, 'workspace.config.json');
  const writeConfig = server => fs.writeFileSync(config, JSON.stringify({ title: '제목', integrations: { slack: false, calendar: false, jira: false, tiro: false }, server }, null, 2));
  writeConfig({ port: 1 });
  const app = await startAppServer(t, { WORKSPACE_REPO_DIR: repo, WORKSPACE_DATA_DIR: data, WORKSPACE_CONFIG: config, WORKSPACE_AUTOMATION_DIR: path.join(home, 'automation') });
  const read = async () => {
    const response = await fetch(app.base + '/manifest.webmanifest');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^application\/manifest\+json/);
    return response.json();
  };

  // 기본 — 이름은 워크스페이스, 아이콘은 /app-icon.png(512) + 앱에 든 192
  const plain = await read();
  assert.deepEqual(Object.keys(plain).sort(), ['background_color', 'display', 'icons', 'id', 'name', 'short_name', 'start_url', 'theme_color'], '이름·아이콘 말고 다른 정보는 없다');
  assert.equal(plain.name, '워크스페이스');
  assert.equal(plain.short_name, '워크스페이스');
  assert.equal(plain.id, '/');
  assert.equal(plain.start_url, '/');
  assert.equal(plain.display, 'standalone');
  assert.deepEqual(plain.icons, [
    { src: '/app-icon.png?v=default', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
  ]);
  assert.equal((await fetch(app.base + plain.icons[0].src)).status, 200, '아이콘 주소가 실제로 열린다');
  assert.equal((await fetch(app.base + plain.icons[1].src)).status, 200);

  // 꾸미기 — Dock 이름과 내 그림(실제 크기 한 벌)을 따른다. 설정을 새로 읽어 서버를 다시 켤 필요가 없다
  writeConfig({ port: 1, dockName: '  내 일터 ' });
  fs.writeFileSync(path.join(repo, 'local', 'icon.png'), fakePng(1024, 1024, 64));
  const custom = await read();
  assert.equal(custom.name, '내 일터');
  assert.equal(custom.short_name, '내 일터');
  assert.equal(custom.icons.length, 1, '내 그림이면 기본 192는 적지 않는다');
  assert.match(custom.icons[0].src, /^\/app-icon\.png\?v=\d+$/, '그림이 바뀌면 주소가 달라진다');
  assert.equal(custom.icons[0].sizes, '1024x1024');
  assert.equal(custom.icons[0].purpose, 'any');

  // 규칙에 안 맞는 이름은 기본으로
  writeConfig({ port: 1, dockName: 'a/b' });
  assert.equal((await read()).name, '워크스페이스');
  // 파일로 두던 manifest는 없앴다 — 이 경로 하나만 서버가 만든다
  assert.equal(fs.existsSync(path.join(__dirname, 'manifest.webmanifest')), false);
});

test('WP-L 인증 없이 여는 경로는 아이콘(/icons/*.png)과 manifest뿐이다(아이폰 홈 화면 추가) — /app-icon.png·화면은 넣지 않는다', () => {
  const { publicAssetRequest } = require('./server');
  const open = (url, method = 'GET') => publicAssetRequest({ method, url });
  assert.equal(open('/manifest.webmanifest'), true);
  assert.equal(open('/manifest.webmanifest?v=1'), true);
  assert.equal(open('/icons/icon-192.png'), true);
  assert.equal(open('/manifest.webmanifest', 'POST'), false);
  for (const url of ['/', '/index.html', '/app-icon.png', '/app.js', '/api/items', '/api/personalize', '/icons/../server.js', '/fonts/a.woff2']) {
    assert.equal(open(url), false, url);
  }
});

test('WP-D2 꾸미기 라우트: local/icon.png 한 파일만 쓰고 지우며, 제목은 곧바로 반영되고, Dock이 바뀌면 요청 표시 파일 하나만 쓴다', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-personalize-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const repo = path.join(home, 'repo');
  const data = path.join(repo, 'tracker');
  fs.mkdirSync(path.join(repo, 'local'), { recursive: true });
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(repo, 'VERSION'), '1.0.0\n');
  fs.writeFileSync(path.join(repo, 'local', 'local.css'), 'body{}\n');
  const config = path.join(home, 'workspace.config.json');
  fs.writeFileSync(config, JSON.stringify({ title: '처음 제목', integrations: { slack: false, calendar: false, jira: false, tiro: false }, server: { port: 1 } }, null, 2));
  const automation = path.join(home, 'automation');
  const app = await startAppServer(t, { WORKSPACE_REPO_DIR: repo, WORKSPACE_DATA_DIR: data, WORKSPACE_CONFIG: config, WORKSPACE_AUTOMATION_DIR: automation });
  const request = path.join(automation, 'requests', 'app-refresh.request');
  const send = (route, body) => fetch(app.base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const icon = path.join(repo, 'local', 'icon.png');

  // 기본은 앱에 든 토끼
  const plain = await fetch(app.base + '/app-icon.png');
  assert.equal(plain.status, 200);
  assert.equal(plain.headers.get('content-type'), 'image/png');
  assert.ok(Buffer.from(await plain.arrayBuffer()).equals(fs.readFileSync(path.join(__dirname, 'icons', 'icon-512.png'))));
  const first = await (await fetch(app.base + '/api/personalize')).json();
  assert.deepEqual([first.title, first.dockName, first.customIcon], ['처음 제목', 'Workspace', false]);

  // 틀린 그림은 아무것도 쓰지 않는다
  for (const [image, words] of [[fakePng(100, 100), /128px/], [Buffer.from('GIF89a' + 'x'.repeat(40)), /PNG나 JPG/], [fakePng(512, 512, 5 * 1024 * 1024), /5MB/]]) {
    const refused = await send('/api/personalize/icon', { image: image.toString('base64') });
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).error, words);
  }
  assert.equal(fs.existsSync(icon), false);
  assert.equal(fs.existsSync(request), false, '실패하면 Dock을 다시 만들라고 하지 않는다');

  // 맞는 그림 — local/icon.png에만 쓰고, 요청 표시 파일 하나를 남긴다(프로세스는 띄우지 않는다)
  const good = fakePng(256, 256, 64);
  const saved = await (await send('/api/personalize/icon', { image: `data:image/png;base64,${good.toString('base64')}` })).json();
  assert.deepEqual(saved, { ok: true, customIcon: true, refresh: true });
  assert.ok(fs.readFileSync(icon).equals(good));
  assert.deepEqual(fs.readdirSync(path.join(repo, 'local')).sort(), ['icon.png', 'local.css'], '임시 파일이 남지 않는다');
  assert.equal(JSON.parse(fs.readFileSync(request, 'utf8')).reason, 'icon');
  assert.ok(Buffer.from(await (await fetch(app.base + '/app-icon.png')).arrayBuffer()).equals(good), '탭·Dock 아이콘 주소가 내 그림을 준다');

  // 되돌리기는 icon.png 한 파일만 지운다
  fs.rmSync(request);
  assert.deepEqual(await (await send('/api/personalize/icon', { reset: true })).json(), { ok: true, customIcon: false, refresh: true });
  assert.equal(fs.existsSync(icon), false);
  assert.equal(fs.readFileSync(path.join(repo, 'local', 'local.css'), 'utf8'), 'body{}\n', '다른 파일은 그대로');
  assert.ok(fs.existsSync(request));

  // 제목만 바꾸면 곧바로 목록 응답에 쓰이고, Dock은 다시 만들지 않는다
  fs.rmSync(request);
  const titled = await (await send('/api/personalize', { title: '  새 제목 ' })).json();
  assert.deepEqual(titled, { ok: true, title: '새 제목', dockName: 'Workspace', refresh: false });
  assert.equal((await (await fetch(app.base + '/api/items')).json()).title, '새 제목', '서버를 다시 켜지 않아도 된다');
  assert.equal(fs.existsSync(request), false);
  let written = JSON.parse(fs.readFileSync(config, 'utf8'));
  assert.equal(written.title, '새 제목');
  assert.deepEqual(written.server, { port: 1 }, '아는 키만 바꾼다');

  // Dock 이름 — config의 server.dockName, 요청 표시 파일, 앱 위치 경로
  const docked = await (await send('/api/personalize', { dockName: 'My Work' })).json();
  assert.equal(docked.refresh, true);
  written = JSON.parse(fs.readFileSync(config, 'utf8'));
  assert.deepEqual(written.server, { port: 1, dockName: 'My Work' });
  assert.equal(JSON.parse(fs.readFileSync(request, 'utf8')).reason, 'dockName');
  const about = await (await fetch(app.base + '/api/about')).json();
  assert.equal(about.appBundle, '~/Applications/My Work.app');
  assert.ok(about.updateFile.endsWith('/업데이트.command'));
  // 틀린 이름은 설정을 바꾸지 않는다
  const before = fs.readFileSync(config, 'utf8');
  const wrong = await send('/api/personalize', { dockName: '../밖' });
  assert.equal(wrong.status, 400);
  assert.match((await wrong.json()).error, /Dock 이름은 1~30자로/);
  assert.equal((await send('/api/personalize', {})).status, 400);
  assert.equal(fs.readFileSync(config, 'utf8'), before);
});

// ─────────────────────────────────────────────────────────────────────────────
// QA v1.1.0 정정 — 픽스처 격리·안전망 · 되돌리기 기준점 · Dock 이름 충돌 · 실행기 작은 것

// 서버 모듈만 읽어 들이는 자식 프로세스(듣지 않는다 — require.main이 아니다). 안전망이 막으면 1로 끝난다.
const loadServerChild = env => spawnSync(process.execPath, ['-e',
  "const s=require('./server.js');process.stdout.write(JSON.stringify(s.workspacePaths()));process.exit(0)"],
{ cwd: __dirname, encoding: 'utf8', timeout: 20000, env });
const underPath = (child, parent) => child === parent || child.startsWith(parent + path.sep);

test('QA 픽스처: browser-fixture가 서버에 넘기는 경로는 전부 임시 폴더 아래이고, 그 환경으로 뜬 서버도 실제 경로를 하나도 쓰지 않는다', (t) => {
  const { prepareFixture } = require('./browser-fixture');
  const { root, env } = prepareFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rootReal = fs.realpathSync(root);
  assert.equal(env.WORKSPACE_FIXTURE, '1', '안전망을 켠다');
  assert.equal(env.WORKSPACE_NO_OPEN, '1');
  assert.equal(env.WORKSPACE_NO_REMOTE_CHECK, '1');
  const keys = ['WORKSPACE_DATA_DIR', 'WORKSPACE_CONFIG', 'WORKSPACE_REPO_DIR', 'WORKSPACE_LOCAL_DIR', 'WORKSPACE_TOKEN_DIR',
    'WORKSPACE_AUTOMATION_DIR', 'WORKSPACE_LAUNCH_AGENTS_DIR', 'WORKSPACE_APPLICATIONS_DIR', 'WORKSPACE_BACKUP_DIR'];
  for (const key of keys) {
    assert.ok(env[key], `${key}를 넘긴다`);
    assert.ok(underPath(env[key], root), `${key}=${env[key]}`);
  }
  // 복사한 예시 설정의 토큰 파일 칸도 임시 토큰 폴더를 가리킨다
  const config = JSON.parse(fs.readFileSync(env.WORKSPACE_CONFIG, 'utf8'));
  assert.ok(underPath(config.slack.tokenFile, env.WORKSPACE_TOKEN_DIR));
  assert.ok(underPath(config.jira.tokenFile, env.WORKSPACE_TOKEN_DIR));

  // 그 환경으로 서버를 읽어 들이면 안전망을 통과하고, 서버가 고른 경로도 전부 임시 폴더 아래다
  const loaded = loadServerChild({ ...process.env, ...env });
  assert.equal(loaded.status, 0, loaded.stderr);
  const used = JSON.parse(loaded.stdout);
  assert.deepEqual(Object.keys(used).sort(), ['applications', 'automation', 'backup', 'config', 'data', 'launchAgents', 'local', 'repo', 'tokens']);
  for (const [name, value] of Object.entries(used)) {
    const real = fs.existsSync(value) ? fs.realpathSync(value) : value;
    assert.ok(underPath(value, root) || underPath(real, rootReal), `${name}=${value}`);
    assert.ok(!underPath(value, os.homedir()), `${name}는 홈 폴더 밖`);
  }
});

test('QA 안전망: WORKSPACE_FIXTURE=1인데 경로가 하나라도 실제 설치 위치(또는 그 위)를 가리키면 서버가 시작하지 않고 이유를 알린다', (t) => {
  const { prepareFixture } = require('./browser-fixture');
  const { root, env } = prepareFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // 홈은 가짜다 — 이 테스트가 실제 홈 아래를 열어 보지 않게(서버는 os.homedir() = HOME으로 기본 위치를 만든다).
  const fakeHome = path.join(root, 'home');
  fs.mkdirSync(fakeHome);
  const base = { ...process.env, ...env, HOME: fakeHome };
  const without = key => { const next = { ...base }; delete next[key]; return next; };
  const repoRoot = path.join(__dirname, '..', '..');
  const cases = [
    ['tokens', without('WORKSPACE_TOKEN_DIR'), '~/.config'],
    ['tokens', { ...base, WORKSPACE_TOKEN_DIR: fakeHome }, '~/.config'],
    ['automation', without('WORKSPACE_AUTOMATION_DIR'), '~/.local/share/workspace-automation'],
    ['launchAgents', without('WORKSPACE_LAUNCH_AGENTS_DIR'), '~/Library/LaunchAgents'],
    ['applications', without('WORKSPACE_APPLICATIONS_DIR'), '~/Applications'],
    ['backup', without('WORKSPACE_BACKUP_DIR'), '~/workspace-data-backup'],
    ['config', without('WORKSPACE_CONFIG'), '저장소의 workspace.config.json'],
    ['local', { ...base, WORKSPACE_LOCAL_DIR: path.join(repoRoot, 'local') }, '저장소의 local/'],
    ['data', without('WORKSPACE_DATA_DIR'), '저장소의 tracker/'],
    ['repo', without('WORKSPACE_REPO_DIR'), '저장소의'],
  ];
  for (const [name, childEnv, label] of cases) {
    const refused = loadServerChild(childEnv);
    assert.equal(refused.status, 1, `${name}: ${refused.stdout}${refused.stderr}`);
    assert.equal(refused.stdout, '', `${name}: 서버를 읽어 들이기 전에 멈춘다`);
    assert.match(refused.stderr, /화면 확인용 픽스처가 실제 설치 위치를 가리켜서 시작하지 않아요/);
    assert.ok(refused.stderr.includes(`- ${name}: `) && refused.stderr.includes(label), `${name}: ${refused.stderr}`);
  }
  // 설정의 토큰 파일 칸이 실제 ~/.config를 가리켜도 막는다
  const config = JSON.parse(fs.readFileSync(env.WORKSPACE_CONFIG, 'utf8'));
  config.jira.tokenFile = '~/.config/workspace-jira-token';
  fs.writeFileSync(env.WORKSPACE_CONFIG, JSON.stringify(config));
  const byConfig = loadServerChild(base);
  assert.equal(byConfig.status, 1);
  assert.match(byConfig.stderr, /config jira\.tokenFile: .* — 실제 ~\/\.config 자리예요/);
  // 안전망은 픽스처 표시가 있을 때만 — 표시가 없으면 테스트·운영은 예전대로 뜬다
  const plain = without('WORKSPACE_FIXTURE');
  delete plain.WORKSPACE_TOKEN_DIR;
  assert.equal(loadServerChild(plain).status, 0);
});

test('QA 꾸미기: 바꾸는 Dock 이름이 Applications의 남의 앱(스크립트 앱 아님)과 같으면 저장하지 않고 400', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-dock-clash-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const repo = path.join(home, 'repo');
  const data = path.join(repo, 'tracker');
  const apps = path.join(home, 'Applications');
  const automation = path.join(home, 'automation');
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(path.join(apps, 'Slack.app', 'Contents', 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(apps, 'Mine.app', 'Contents', 'Resources', 'Scripts'), { recursive: true });
  fs.writeFileSync(path.join(apps, 'Mine.app', 'Contents', 'Resources', 'Scripts', 'main.scpt'), '');
  const config = path.join(home, 'workspace.config.json');
  fs.writeFileSync(config, JSON.stringify({ title: '제목', server: { port: 1 } }, null, 2));
  const app = await startAppServer(t, { WORKSPACE_REPO_DIR: repo, WORKSPACE_DATA_DIR: data, WORKSPACE_CONFIG: config,
    WORKSPACE_AUTOMATION_DIR: automation, WORKSPACE_APPLICATIONS_DIR: apps });
  const send = body => fetch(app.base + '/api/personalize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const request = path.join(automation, 'requests', 'app-refresh.request');
  const before = fs.readFileSync(config, 'utf8');

  const clash = await send({ dockName: ' Slack ' });
  assert.equal(clash.status, 400);
  assert.deepEqual(await clash.json(), { ok: false, error: '같은 이름의 앱이 이미 있어요 — 다른 이름을 적어 주세요' });
  assert.equal(fs.readFileSync(config, 'utf8'), before, '설정을 바꾸지 않는다');
  assert.equal(fs.existsSync(request), false, 'Dock 앱을 다시 만들라고 하지 않는다');
  assert.ok(fs.existsSync(path.join(apps, 'Slack.app', 'Contents', 'MacOS')), '그 앱은 건드리지 않는다');
  // 제목을 함께 보내도 통째로 저장하지 않는다
  assert.equal((await send({ title: '새 제목', dockName: 'Slack' })).status, 400);
  assert.equal(fs.readFileSync(config, 'utf8'), before);

  // 이 설치가 만든 스크립트 앱이면(예전 이름) 그 이름으로 바꿀 수 있다 · 없는 이름도 된다
  const mine = await (await send({ dockName: 'Mine' })).json();
  assert.equal(mine.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(config, 'utf8')).server.dockName, 'Mine');
  assert.equal((await (await send({ dockName: 'Brand New' })).json()).ok, true);

  // 모듈 단위: 있는지 보기만 한다
  const personalizeStore = require('./personalize');
  assert.equal(personalizeStore.dockNameTaken(apps, 'Slack'), true);
  assert.equal(personalizeStore.dockNameTaken(apps, 'Mine'), false);
  assert.equal(personalizeStore.dockNameTaken(apps, 'Nothing'), false);
  assert.equal(personalizeStore.dockNameTaken('', 'Slack'), false);
});

test('QA2 GET /api/about?cached=1은 원격 확인을 기다리지 않고 가진 값만 준다', async () => {
  const about = await (await fetch(base + '/api/about?cached=1')).json();
  assert.ok('version' in about && 'update' in about);
});

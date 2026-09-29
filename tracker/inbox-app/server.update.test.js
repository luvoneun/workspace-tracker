// 서버: 앱 안 업데이트(새 버전 판단·요청·상태·되돌리기 기준점). 공용 준비는 test-support.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const support = require('./test-support');
const { post, runGit, gitReady, startAppServer } = support;

// ─────────────────────────────────────────────────────────────────────────────
// WP-D3 — 앱 안 `업데이트 받기`(+되돌리기) · 팀 전용 설치 파일 · 설치 마무리 문구
//
// 실제 원격·실제 launchd·실제 홈 폴더에는 닿지 않는다: 원격은 임시 폴더의 bare 저장소(파일 경로)이고, launchd 등록은
// 주입한 임시 폴더에서 "있는지만" 보며, 스크립트는 가짜 update.sh/setup.sh/git과 임시 HOME으로만 돌린다.

// 원격(bare) + 내 복사본. 복사본은 v1.0.0에 있고, 원격에는 그 뒤 v1.1.0(main 한 커밋 더)이 올라가 있다 —
// 복사본은 그 새 커밋을 아직 받지 않았다.
function remoteFixture(t, { channel = 'stable' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-d3-remote-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const origin = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  const clone = path.join(root, 'clone');
  fs.mkdirSync(seed);
  fs.writeFileSync(path.join(seed, 'VERSION'), '1.0.0\n');
  fs.writeFileSync(path.join(seed, '.gitignore'), 'workspace.config.json\ntracker/\n');
  runGit(seed, ['init', '-b', 'main']);
  runGit(seed, ['add', '-A']);
  runGit(seed, ['commit', '-m', '첫 버전']);
  runGit(seed, ['tag', 'v1.0.0']);
  runGit(root, ['init', '--bare', '-b', 'main', origin]);
  runGit(seed, ['remote', 'add', 'origin', origin]);
  runGit(seed, ['push', '-q', 'origin', 'main', '--tags']);
  runGit(root, ['clone', '-q', origin, clone]);
  fs.writeFileSync(path.join(seed, 'VERSION'), '1.1.0\n');
  runGit(seed, ['commit', '-am', '다음 버전']);
  runGit(seed, ['tag', 'v1.1.0']);
  runGit(seed, ['push', '-q', 'origin', 'main', '--tags']);
  fs.mkdirSync(path.join(clone, 'tracker'));
  const config = path.join(clone, 'workspace.config.json');
  fs.writeFileSync(config, JSON.stringify({ server: { updateChannel: channel } }));
  const env = {
    WORKSPACE_REPO_DIR: clone, WORKSPACE_DATA_DIR: path.join(clone, 'tracker'), WORKSPACE_CONFIG: config,
    WORKSPACE_NO_REMOTE_CHECK: '', WORKSPACE_AUTOMATION_DIR: path.join(root, 'automation'), WORKSPACE_LAUNCH_AGENTS_DIR: path.join(root, 'agents'),
  };
  return { root, clone, env };
}

test('WP-D3 새 버전 판단: stable은 원격 태그 중 최신 > VERSION, main은 원격 main 커밋이 HEAD와 다르고 아직 받지 않았을 때', { skip: !gitReady }, async (t) => {
  const stable = remoteFixture(t);
  const about = await (await fetch((await startAppServer(t, stable.env)).base + '/api/about')).json();
  assert.equal(about.latest.tag, 'v1.1.0');
  assert.equal(about.update.available, true, 'v1.1.0 > 1.0.0');
  assert.equal(about.update.label, 'v1.1.0');
  assert.equal(about.update.changesUrl, null, '원격이 github.com이 아니면 `무엇이 바뀌었나요`를 숨긴다');

  const main = remoteFixture(t, { channel: 'main' });
  const mainAbout = await (await fetch((await startAppServer(t, main.env)).base + '/api/about')).json();
  assert.equal(mainAbout.channel, 'main');
  assert.equal(mainAbout.update.available, true, '원격 main이 앞서 있고 이 저장소는 그 커밋이 아직 없다');
  assert.equal(mainAbout.update.label, 'main');

  // 받은 뒤(HEAD = 원격 main)에는 새 버전이 아니다
  runGit(main.clone, ['pull', '-q', '--ff-only', 'origin', 'main']);
  const after = await (await fetch((await startAppServer(t, main.env)).base + '/api/about')).json();
  assert.equal(after.update.available, false);
  // 내가 앞서 있으면(원격 커밋을 이미 가짐) 역시 새 버전이 아니다
  fs.writeFileSync(path.join(main.clone, 'VERSION'), '1.2.0\n');
  runGit(main.clone, ['commit', '-qam', '내가 앞선 커밋']);
  const ahead = await (await fetch((await startAppServer(t, main.env)).base + '/api/about')).json();
  assert.equal(ahead.update.available, false, 'HEAD와 달라도 이 저장소가 가진 커밋이면 알리지 않는다');
});

test('WP-D3 `무엇이 바뀌었나요` 주소는 origin이 github.com일 때만, 소유자/저장소만 뽑아 새로 짓는다', () => {
  const { changesUrlFrom } = require('./server');
  const line = url => `origin\t${url} (fetch)\norigin\t${url} (push)\n`;
  assert.equal(changesUrlFrom(line('https://github.com/luvon/workspace.git'), 'stable'), 'https://github.com/luvon/workspace/releases');
  assert.equal(changesUrlFrom(line('git@github.com:luvon/workspace.git'), 'main'), 'https://github.com/luvon/workspace/commits/main');
  assert.equal(changesUrlFrom(line('https://github.com/luvon/workspace'), 'stable'), 'https://github.com/luvon/workspace/releases');
  assert.equal(changesUrlFrom(line('https://user:ghp_secret@github.com/luvon/workspace.git'), 'stable'), null, '주소에 다른 글자가 섞이면 만들지 않는다');
  assert.equal(changesUrlFrom(line('https://gitlab.com/luvon/workspace.git'), 'stable'), null);
  assert.equal(changesUrlFrom(line('/tmp/origin.git'), 'stable'), null);
  assert.equal(changesUrlFrom(null, 'stable'), null);
});

// 업데이트 요청 서버 하나 — 원격 확인은 끄고, 자동화·launchd 폴더는 임시 폴더다.
async function startUpdateServer(t, { repoName = 'repo', outer = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-d3-update-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const parent = outer ? path.join(home, 'outer') : home;
  if (outer) {
    fs.mkdirSync(parent);
    runGit(parent, ['init', '-q', '-b', 'main']);
    runGit(parent, ['remote', 'add', 'origin', outer]);
  }
  const repo = path.join(parent, repoName);
  const automation = path.join(home, 'automation');
  const agents = path.join(home, 'agents');
  const tokens = path.join(home, 'tokens');
  [path.join(repo, 'tracker'), automation, agents, tokens].forEach(dir => fs.mkdirSync(dir, { recursive: true }));
  fs.writeFileSync(path.join(repo, 'VERSION'), '1.0.0\n');
  fs.writeFileSync(path.join(tokens, 'workspace-jira-token'), 'jira-secret-token\n', { mode: 0o600 });
  const config = path.join(repo, 'workspace.config.json');
  fs.writeFileSync(config, JSON.stringify({
    jira: { siteUrl: 'https://jira.example.test', email: 'me@secret.example.test', tokenFile: path.join(tokens, 'workspace-jira-token') },
    slack: { channels: { todo: { id: 'C0SECRET1', name: '#secret-todo' } } },
  }));
  const app = await startAppServer(t, {
    WORKSPACE_REPO_DIR: repo, WORKSPACE_DATA_DIR: path.join(repo, 'tracker'), WORKSPACE_CONFIG: config,
    WORKSPACE_AUTOMATION_DIR: automation, WORKSPACE_LAUNCH_AGENTS_DIR: agents, WORKSPACE_TOKEN_DIR: tokens,
  });
  // HTTP 상태는 `code`로 싣는다(응답 본문에 `status` 칸이 따로 있다).
  const post = async (body) => {
    const response = await fetch(app.base + '/api/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const text = await response.text();
    return { ...JSON.parse(text), code: response.status, text };
  };
  const status = async () => {
    const response = await fetch(app.base + '/api/update/status');
    const text = await response.text();
    return { ...JSON.parse(text), code: response.status, text };
  };
  const request = path.join(automation, 'requests', 'update.request');
  const statusFile = path.join(automation, 'update-status.json');
  const plist = () => fs.writeFileSync(path.join(agents, 'com.workspace.app.update.plist'), '<plist/>\n');
  return { home, repo, automation, post, status, request, statusFile, plist };
}
const D3_SECRETS = /jira-secret-token|me@secret|C0SECRET1|secret-todo/;

test('WP-D3 POST /api/update: action 두 값만 받고, plist가 있을 때만 요청 파일 하나를 쓰며, 진행 중이면 다시 쓰지 않는다', async (t) => {
  const app = await startUpdateServer(t);
  const odd = await app.post({ action: 'rm -rf /' });
  assert.equal(odd.code, 400, '모르는 action은 400');
  assert.equal(odd.reason, 'action');
  assert.equal((await app.post({})).code, 400);
  assert.equal(fs.existsSync(app.request), false);

  const missing = await app.post({ action: 'update' });
  assert.equal(missing.code, 200);
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'not-installed');
  assert.equal(missing.message, '처음 한 번은 업데이트.command로 받아 주세요');
  assert.match(missing.updateFile, /업데이트\.command$/, '그 파일 경로를 함께 준다(복사용)');
  assert.equal(fs.existsSync(app.request), false, '막힐 때는 파일을 쓰지 않는다');

  app.plist();
  const ok = await app.post({ action: 'update', extra: '$(touch /tmp/pwned)' });
  assert.equal(ok.code, 200);
  assert.equal(ok.ok, true);
  const written = JSON.parse(fs.readFileSync(app.request, 'utf8'));
  assert.deepEqual(Object.keys(written), ['action', 'requestedAt'], '요청 파일에는 action·requestedAt 두 칸뿐');
  assert.equal(written.action, 'update');
  assert.ok(Math.abs(Date.parse(written.requestedAt) - Date.now()) < 60000);
  assert.match(fs.readFileSync(app.request, 'utf8'), /^\{"action":"update","requestedAt":"[0-9T:.Z-]+"\}\n$/, '실행기가 그대로 알아보는 한 줄');

  // 아직 실행기가 집어 가지 않은 요청이 있으면 진행 중이다 — 덮어쓰지 않는다
  const again = await app.post({ action: 'rollback' });
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'running');
  assert.equal(JSON.parse(fs.readFileSync(app.request, 'utf8')).action, 'update');

  // 실행기가 요청을 집어 가고 상태 파일에 running(10분 안)을 쓰는 중 → 진행 목록을 그대로 돌려준다
  fs.unlinkSync(app.request);
  const now = new Date().toISOString();
  fs.writeFileSync(app.statusFile, JSON.stringify({ action: 'update', from: '1.0.0', to: '1.1.0', step: 3, state: 'running', startedAt: now, updatedAt: now,
    steps: [{ name: '고친 파일 확인', state: 'done' }, { name: '데이터 백업', state: 'done' }, { name: '새 버전 받기', state: 'doing' }] }));
  const busy = await app.post({ action: 'update' });
  assert.equal(busy.reason, 'running');
  assert.equal(busy.status.step, 3, '진행 중이면 그 상태를 그대로 싣는다');
  assert.equal(fs.existsSync(app.request), false);

  // 10분 넘게 running에 머문 상태(실행기가 죽은 흔적)는 막지 않는다
  const old = new Date(Date.now() - 11 * 60000).toISOString();
  fs.writeFileSync(app.statusFile, JSON.stringify({ action: 'update', step: 3, state: 'running', startedAt: old, updatedAt: old, steps: [] }));
  const retry = await app.post({ action: 'rollback' });
  assert.equal(retry.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(app.request, 'utf8')).action, 'rollback');
  for (const one of [odd, missing, ok, again, busy, retry]) assert.doesNotMatch(one.text, D3_SECRETS, '응답에 토큰·이메일·채널이 없다');
});

test('WP-D3 POST /api/update: 회사(playio) 폴더면 파일을 쓰지 않고 업데이트.command로 안내한다(경로 칸·바깥 저장소 remote)', { skip: !gitReady }, async (t) => {
  const named = await startUpdateServer(t, { repoName: 'Playio-workspace' });
  named.plist();
  const byName = await named.post({ action: 'update' });
  assert.equal(byName.ok, false);
  assert.equal(byName.reason, 'relocate');
  assert.equal(byName.message, '폴더를 옮겨야 하는 업데이트예요 — 업데이트.command를 더블클릭해 주세요');
  assert.match(byName.updateFile, /Playio-workspace\/업데이트\.command$/);
  assert.equal(fs.existsSync(named.request), false);

  const nested = await startUpdateServer(t, { outer: 'git@github.com:PlayIO/company-docs.git' });
  nested.plist();
  const byRemote = await nested.post({ action: 'rollback' });
  assert.equal(byRemote.reason, 'relocate', '바깥 저장소의 remote에 playio가 있으면 옮겨야 한다');
  assert.equal(fs.existsSync(nested.request), false);

  const plain = await startUpdateServer(t, { outer: 'https://github.com/someone/notes.git' });
  plain.plist();
  assert.equal((await plain.post({ action: 'update' })).ok, true, '그 밖의 바깥 저장소는 막지 않는다');
});

test('WP-D3 GET /api/update/status: 파일 없음·진행·실패를 정해 둔 칸만 옮겨 싣는다', async (t) => {
  const app = await startUpdateServer(t);
  const none = await app.status();
  assert.equal(none.code, 200);
  assert.equal(none.status, null);
  assert.equal(none.pending, null);
  assert.equal(none.running, false);
  assert.match(none.updateFile, /업데이트\.command$/);

  const now = new Date().toISOString();
  const names = ['고친 파일 확인', '데이터 백업', '새 버전 받기', '데이터 형식 변환', '앱 다시 시작', '잘 떴는지 확인'];
  fs.writeFileSync(app.statusFile, JSON.stringify({
    action: 'update', from: '1.0.0', to: '1.1.0', step: 5, state: 'running', startedAt: now, updatedAt: now, secret: 'jira-secret-token',
    steps: names.map((name, index) => ({ name, state: index < 4 ? 'done' : (index === 4 ? 'doing' : 'weird') })),
  }));
  const running = await app.status();
  assert.equal(running.running, true);
  assert.equal(running.status.step, 5);
  assert.deepEqual(running.status.steps.map(step => step.state), ['done', 'done', 'done', 'done', 'doing', 'todo'], '모르는 단계 상태는 todo로');
  assert.equal(running.status.secret, undefined, '정해 둔 칸 밖은 싣지 않는다');
  assert.doesNotMatch(running.text, D3_SECRETS);

  fs.writeFileSync(app.statusFile, JSON.stringify({ action: 'update', from: '1.0.0', to: '1.1.0', step: 6, state: 'failed', message: '앱이 응답하지 않아요',
    startedAt: now, updatedAt: now, finishedAt: now, steps: names.map((name, index) => ({ name, state: index < 5 ? 'done' : 'failed' })) }));
  const failed = await app.status();
  assert.equal(failed.running, false);
  assert.equal(failed.status.state, 'failed');
  assert.equal(failed.status.message, '앱이 응답하지 않아요');
  assert.doesNotMatch(failed.text, D3_SECRETS);
});

test('QA 되돌리기 기준점: rollback은 업데이트가 ③ 새 버전 받기 이후에서 멈췄을 때만 받고, 아니면 200 ok:false nothing-to-undo', async (t) => {
  const app = await startUpdateServer(t);
  app.plist();
  const now = new Date().toISOString();
  const status = (body) => fs.writeFileSync(app.statusFile, JSON.stringify({ from: '1.0.0', to: '1.1.0', startedAt: now, updatedAt: now, steps: [], ...body }));
  const refuse = async (label) => {
    const answer = await app.post({ action: 'rollback' });
    assert.equal(answer.code, 200, label);
    assert.equal(answer.ok, false, label);
    assert.equal(answer.reason, 'nothing-to-undo', label);
    assert.equal(answer.message, '되돌릴 것이 없어요 — 앱과 데이터는 그대로예요');
    assert.equal(fs.existsSync(app.request), false, `${label}: 요청 파일을 쓰지 않는다`);
  };
  await refuse('상태 파일 없음');
  status({ action: 'update', step: 1, state: 'failed', message: '고친 내용을 보관하지 못해 멈췄어요' });
  await refuse('① 실패');
  status({ action: 'update', step: 2, state: 'failed', message: '백업 폴더를 만들지 못했어요' });
  await refuse('② 실패');
  status({ action: 'update', step: 0, state: 'failed', message: '업데이트를 끝내지 못했어요' });
  await refuse('실행기가 시작 전에 멈춤');
  status({ action: 'update', step: 6, state: 'done' });
  await refuse('성공으로 끝남(.workspace-last-good은 남아 있어도)');
  status({ action: 'rollback', step: 4, state: 'failed', message: '앱이 아직 응답하지 않아요' });
  await refuse('되돌리기 실패 뒤');
  // ①② 실패여도 다시 시도(같은 update 요청)는 받는다
  status({ action: 'update', step: 2, state: 'failed' });
  assert.equal((await app.post({ action: 'update' })).ok, true);
  fs.unlinkSync(app.request);

  for (const step of [3, 4, 6]) {
    status({ action: 'update', step, state: 'failed', message: '앱이 응답하지 않아요' });
    const ok = await app.post({ action: 'rollback' });
    assert.equal(ok.ok, true, `${step}단계 실패면 되돌린다`);
    assert.equal(JSON.parse(fs.readFileSync(app.request, 'utf8')).action, 'rollback');
    fs.unlinkSync(app.request);
  }
  // 실행기가 죽어 running에 머문 채 10분이 지난 것(③ 이후)도 멈춘 것으로 본다
  const old = new Date(Date.now() - 11 * 60000).toISOString();
  status({ action: 'update', step: 4, state: 'running', startedAt: old, updatedAt: old });
  assert.equal((await app.post({ action: 'rollback' })).ok, true);
});

test('QA2 update 상태: 새로고침 뒤 화면이 되돌리기를 다시 보일지 `rollback`·`settled`로 알린다(뒤에 다른 업데이트가 끝까지 돌았으면 받지 않는다)', async (t) => {
  const app = await startUpdateServer(t);
  app.plist();
  const at = new Date(Date.now() - 60000).toISOString();
  fs.writeFileSync(app.statusFile, JSON.stringify({ action: 'update', from: '1.0.0', to: '1.1.0', step: 4, state: 'failed', message: '데이터 형식을 바꾸지 못했어요', startedAt: at, updatedAt: at, finishedAt: at, steps: [] }));
  const first = await app.status();
  assert.equal(first.rollback, true);
  assert.equal(first.settled, false);
  // 터미널의 업데이트.command로 다시 받아 ③에서 되돌릴 자리를 새로 적었다(상태 파일은 그대로)
  fs.writeFileSync(path.join(app.repo, '.workspace-last-good'), 'abc\n');
  const later = await app.status();
  assert.equal(later.settled, true);
  assert.equal(later.rollback, false);
  const refused = await app.post({ action: 'rollback' });
  assert.equal(refused.reason, 'nothing-to-undo', '지난 실패 기록으로 새 업데이트를 되돌리지 않는다');
  assert.equal(fs.existsSync(app.request), false);
  // 되돌릴 자리가 멈춘 기록보다 옛것이면(그 업데이트가 ③에서 적은 것) 그대로 받는다
  const past = new Date(Date.now() - 120000);
  fs.utimesSync(path.join(app.repo, '.workspace-last-good'), past, past);
  assert.equal((await app.status()).rollback, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// WP-U — 쉬는 틈에 자동 업데이트: 실제 서버(launchd 설치본처럼 WORKSPACE_MANAGED)를 띄워 배선을 본다.
// 원격은 임시 bare 저장소(파일 경로)라 바깥 네트워크에 닿지 않고, 체크인 전송은 끈다. 판단 주기·쉬는 시간만 줄인다.
async function startAutoServer(t, { channel = 'stable', idleMs = 0, plist = true } = {}) {
  const fx = remoteFixture(t, { channel });
  const agents = fx.env.WORKSPACE_LAUNCH_AGENTS_DIR;
  fs.mkdirSync(agents, { recursive: true });
  if (plist) fs.writeFileSync(path.join(agents, 'com.workspace.app.update.plist'), '<plist/>\n');
  const app = await startAppServer(t, {
    ...fx.env, WORKSPACE_MANAGED: '1', WORKSPACE_CHECKIN: '0', WORKSPACE_LOCAL_DIR: path.join(fx.clone, 'local'),
    WORKSPACE_AUTO_UPDATE_TICK_MS: '200', WORKSPACE_AUTO_UPDATE_IDLE_MS: String(idleMs),
  });
  const request = path.join(fx.env.WORKSPACE_AUTOMATION_DIR, 'requests', 'update.request');
  const record = path.join(fx.clone, 'local', 'auto-update.json');
  return { ...fx, app, request, record };
}
const waitFor = async (check, ms) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (check()) return true; await new Promise(resolve => setTimeout(resolve, 100)); }
  return check();
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sameJson = (actual, expected, message) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message);

test('WP-U 자동 업데이트: launchd 설치본 · stable · 새 버전 · 쉬는 중이면 `업데이트 받기`와 같은 요청 파일 한 줄 + local/auto-update.json', { skip: !gitReady }, async (t) => {
  const fx = await startAutoServer(t);
  assert.equal(await waitFor(() => fs.existsSync(fx.request), 8000), true, '요청 파일을 쓴다');
  assert.match(fs.readFileSync(fx.request, 'utf8'), /^\{"action":"update","requestedAt":"[0-9T:.Z-]+"\}\n$/, '실행기가 알아보는 그 한 줄');
  const record = JSON.parse(fs.readFileSync(fx.record, 'utf8'));
  assert.equal(record.version, 'v1.1.0');
  assert.match(record.triedOn, /^\d{4}-\d{2}-\d{2}$/);
  // 실행기가 집어 간 뒤에도(요청 파일이 지워짐) 같은 날 같은 버전은 다시 쓰지 않는다
  fs.unlinkSync(fx.request);
  await sleep(1200);
  assert.equal(fs.existsSync(fx.request), false, '하루 한 번만');
  const about = await (await fetch(fx.app.base + '/api/about?cached=1')).json();
  sameJson(about.update.auto, { eligible: true, on: true, notice: null });
});

test('WP-U 자동 업데이트: 갈래가 main이면(만든 사람의 저장소) 새 버전·쉬는 중·에이전트가 다 있어도 **절대** 요청하지 않는다', { skip: !gitReady }, async (t) => {
  const fx = await startAutoServer(t, { channel: 'main' });
  const about = await (await fetch(fx.app.base + '/api/about')).json();
  assert.equal(about.update.available, true, '원격 main이 앞서 있다(새 버전은 보인다 — 파란 점은 그대로)');
  await sleep(2500);
  assert.equal(fs.existsSync(fx.request), false, '요청 파일이 없다');
  assert.equal(fs.existsSync(fx.record), false, '기록도 없다');
  sameJson(about.update.auto, { eligible: false, on: true, notice: null }, '스위치도 오늘 탭 한 줄도 없다');

  // 뜰 때는 stable이었는데 그 뒤 설정 파일만 main으로 바뀐 자리도 main으로 본다
  const later = await startAutoServer(t, { idleMs: 60 * 60 * 1000 });
  fs.writeFileSync(path.join(later.clone, 'workspace.config.json'), JSON.stringify({ server: { updateChannel: 'main' } }));
  const view = await (await fetch(later.app.base + '/api/about?cached=1')).json();
  sameJson(view.update.auto, { eligible: false, on: true, notice: null });
});

test('WP-U 자동 업데이트: git worktree가 둘이면(만든 사람의 개발 저장소) stable이어도 요청하지 않고 스위치·한 줄도 없다', { skip: !gitReady }, async (t) => {
  const fx = remoteFixture(t);
  runGit(fx.clone, ['worktree', 'add', '-q', '--detach', path.join(fx.root, 'second')]);
  const agents = fx.env.WORKSPACE_LAUNCH_AGENTS_DIR;
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(agents, 'com.workspace.app.update.plist'), '<plist/>\n');
  const app = await startAppServer(t, {
    ...fx.env, WORKSPACE_MANAGED: '1', WORKSPACE_CHECKIN: '0', WORKSPACE_LOCAL_DIR: path.join(fx.clone, 'local'),
    WORKSPACE_AUTO_UPDATE_TICK_MS: '200', WORKSPACE_AUTO_UPDATE_IDLE_MS: '0',
  });
  const about = await (await fetch(app.base + '/api/about')).json();
  assert.equal(about.update.available, true);
  await sleep(2500);
  assert.equal(fs.existsSync(path.join(fx.env.WORKSPACE_AUTOMATION_DIR, 'requests', 'update.request')), false, '요청 파일이 없다');
  assert.equal(fs.existsSync(path.join(fx.clone, 'local', 'auto-update.json')), false);
  sameJson(about.update.auto, { eligible: false, on: true, notice: null });
});

test('WP-U 입력 중 신호: 본문 없는 POST /api/activity(204, 파일 안 씀)가 이어지면 쉬는 시간을 다시 세고, 멈추면 요청한다', { skip: !gitReady }, async (t) => {
  const fx = await startAutoServer(t, { idleMs: 2500 });
  const until = Date.now() + 3500;
  while (Date.now() < until) {
    const answer = await fetch(fx.app.base + '/api/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    assert.equal(answer.status, 204);
    await sleep(400);
  }
  assert.equal(fs.existsSync(fx.request), false, '입력 중이라고 알리는 동안은 요청하지 않는다');
  assert.equal(await waitFor(() => fs.existsSync(fx.request), 8000), true, '신호가 멈추면 쉬는 중으로 보고 요청한다');
});

test('WP-U 지금 갈래 하나: 뜬 뒤 설정 파일만 main으로 바뀌면 /api/about의 channel도 main이다(판단과 같은 함수)', { skip: !gitReady }, async (t) => {
  const fx = await startAutoServer(t, { idleMs: 60 * 60 * 1000 });
  assert.equal((await (await fetch(fx.app.base + '/api/about?cached=1')).json()).channel, 'stable');
  fs.writeFileSync(path.join(fx.clone, 'workspace.config.json'), JSON.stringify({ server: { updateChannel: 'main' } }));
  const view = await (await fetch(fx.app.base + '/api/about?cached=1')).json();
  assert.equal(view.channel, 'main');
  assert.equal(view.update.auto.eligible, false);
});

test('WP-U 쉬는 중: 사람의 쓰기(POST)가 이어지면 기다리고, 목록 새로 받기(GET)·슬랙 수집(/api/import)은 사람의 동작으로 세지 않는다', { skip: !gitReady }, async (t) => {
  const fx = await startAutoServer(t, { idleMs: 2500 });
  const send = (route, body) => fetch(fx.app.base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  // 3.5초 동안 0.4초마다 사람의 쓰기(바꿀 것이 없는 꾸미기 저장 — 400이고 아무것도 쓰지 않는다)
  const until = Date.now() + 3500;
  while (Date.now() < until) {
    await send('/api/personalize', {});
    await sleep(400);
  }
  assert.equal(fs.existsSync(fx.request), false, '쓰는 동안은 요청하지 않는다');
  // 이제 GET과 슬랙 수집만 계속 온다 — 그래도 쉬는 중이다
  let seen = false;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !seen) {
    await fetch(fx.app.base + '/api/items');
    await send('/api/import', {});
    await sleep(300);
    seen = fs.existsSync(fx.request);
  }
  assert.equal(seen, true, 'GET·/api/import만 오면 쉬는 중으로 보고 요청한다');
});

test('WP-U 자동이 안 될 때 오늘 탭 한 줄의 이유: 에이전트 없음 → not-installed, 꺼짐 → off (둘 다 요청 없음)', { skip: !gitReady }, async (t) => {
  const missing = await startAutoServer(t, { plist: false });
  await sleep(1000);
  assert.equal(fs.existsSync(missing.request), false);
  const aboutMissing = await (await fetch(missing.app.base + '/api/about')).json();
  sameJson(aboutMissing.update.auto, { eligible: true, on: true, notice: 'not-installed' });

  const off = await startAutoServer(t, { idleMs: 60 * 60 * 1000 });
  const config = () => JSON.parse(fs.readFileSync(path.join(off.clone, 'workspace.config.json'), 'utf8'));
  const save = body => fetch(off.app.base + '/api/personalize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const saved = await (await save({ autoUpdate: false })).json();
  assert.equal(saved.ok, true);
  assert.equal(config().server.autoUpdate, false, '끄면 server.autoUpdate: false');
  assert.equal(config().server.updateChannel, 'stable', '다른 키는 그대로');
  const aboutOff = await (await fetch(off.app.base + '/api/about?cached=1')).json();
  sameJson(aboutOff.update.auto, { eligible: true, on: false, notice: 'off' });
  // 다시 켜면 그 칸을 지운다(기본 켜짐)
  await save({ autoUpdate: true });
  assert.equal('autoUpdate' in config().server, false);
  assert.equal((await save({ autoUpdate: 'no' })).status, 400, '참/거짓만 받는다');
  assert.equal(fs.existsSync(off.request), false);
});

test('WP-U 개발용 서버(WORKSPACE_MANAGED 없음)는 자동으로 요청하지 않고 스위치·한 줄도 없다', { skip: !gitReady }, async (t) => {
  const fx = remoteFixture(t);
  const agents = fx.env.WORKSPACE_LAUNCH_AGENTS_DIR;
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(agents, 'com.workspace.app.update.plist'), '<plist/>\n');
  const app = await startAppServer(t, { ...fx.env, WORKSPACE_CHECKIN: '0', WORKSPACE_LOCAL_DIR: path.join(fx.clone, 'local'), WORKSPACE_AUTO_UPDATE_TICK_MS: '200', WORKSPACE_AUTO_UPDATE_IDLE_MS: '0' });
  const about = await (await fetch(app.base + '/api/about')).json();
  assert.equal(about.update.available, true);
  await sleep(1500);
  assert.equal(fs.existsSync(path.join(fx.env.WORKSPACE_AUTOMATION_DIR, 'requests', 'update.request')), false);
  sameJson(about.update.auto, { eligible: false, on: true, notice: null });
});

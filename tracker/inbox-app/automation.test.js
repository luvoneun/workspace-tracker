// 자동화 셸 스크립트(`automation/*.sh`·setup.sh·update.sh·설치 스크립트). 공용 준비는 test-support.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const support = require('./test-support');
const { today, deadPid, gitEnv, runGit, gitReady } = support;

// launchd가 부르는 자동화 스크립트. 앱과 따로 돌지만 여기가 멈추면 수집이 통째로 멎기 때문에,
// 실제 스크립트를 임시 폴더·가짜 claude로 돌려서 "멈춤 방지" 장치만 확인한다.
// (슬랙 API나 운영 서버는 건드리지 않는다 — 채널이 없는 설정이라 곧바로 실패하고 끝난다)
const automationScript = name => path.join(__dirname, 'automation', name);
const runScript = (script, args, env) => spawnSync('/bin/bash', [script, ...args], {
  env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60000,
});
const gone = pid => { try { process.kill(pid, 0); return false; } catch { return true; } };
// slack-capture.sh는 설치 폴더의 tracker/inbox-app/slack-collect.js를 부른다 — 임시 설치 폴더에 진짜 파일을 둔다.
function placeCollector(home) {
  const app = path.join(home, 'tracker', 'inbox-app');
  fs.mkdirSync(app, { recursive: true });
  for (const name of ['slack-collect.js', 'slack-history.js', 'slack-auth.js', 'import-record.js']) fs.copyFileSync(path.join(__dirname, name), path.join(app, name));
  return app;
}

test('run-task.sh는 매달린 실행을 시간 제한으로 끊고 자식 프로세스까지 정리한다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-run-task-'));
  const claude = path.join(home, 'fake-claude.sh');
  fs.writeFileSync(claude, '#!/bin/bash\nsleep 60 &\necho "child=$!"\necho "parent=$$"\nsleep 60\n');
  fs.chmodSync(claude, 0o755);
  const result = runScript(automationScript('run-task.sh'), ['hang', '프롬프트', 'Read'], {
    WORKSPACE_DIR: home, AUTOMATION_LOG_DIR: path.join(home, 'logs'), CLAUDE_BIN: claude,
    TASK_TIMEOUT_SECONDS: '2', TASK_KILL_GRACE_SECONDS: '1',
  });
  assert.equal(result.status, 124);
  const log = fs.readFileSync(path.join(home, 'logs', 'hang.log'), 'utf8');
  assert.match(log, /hang 시간 초과 \(2초\)/);
  // 상태 탭이 읽는 시작/종료 줄 형식은 그대로여야 한다
  assert.match(log, /^───── \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} hang 시작$/m);
  assert.match(log, /^───── \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} hang 종료 \(exit 124\)$/m);
  const pids = [...log.matchAll(/(?:child|parent)=(\d+)/g)].map(match => Number(match[1]));
  assert.equal(pids.length, 2);
  assert.deepEqual(pids.map(gone), [true, true]); // MCP 자식 흉내까지 남지 않는다
  fs.rmSync(home, { recursive: true, force: true });
});

test('run-task.sh는 정상 실행의 인자·종료 코드·로그 형식을 그대로 넘긴다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-run-task-'));
  const claude = path.join(home, 'fake-claude.sh');
  fs.writeFileSync(claude, `#!/bin/bash\nprintf '%s\\n' "$*" > "${path.join(home, 'args.txt')}"\necho "수집 결과 요약"\nexit \${FAKE_EXIT:-0}\n`);
  fs.chmodSync(claude, 0o755);
  const env = { WORKSPACE_DIR: home, AUTOMATION_LOG_DIR: path.join(home, 'logs'), CLAUDE_BIN: claude };
  assert.equal(runScript(automationScript('run-task.sh'), ['ok', '프롬프트', 'Read,Write'], env).status, 0);
  assert.equal(fs.readFileSync(path.join(home, 'args.txt'), 'utf8').trim(), '-p 프롬프트 --model sonnet --permission-mode acceptEdits --allowedTools Read,Write');
  assert.equal(runScript(automationScript('run-task.sh'), ['ok', '프롬프트', 'Read,Write'], { ...env, FAKE_EXIT: '7' }).status, 7);
  // 권한 모드·금지 도구는 선택 인자다(슬랙 캡처만 쓴다). 안 주면 위처럼 예전 그대로다.
  assert.equal(runScript(automationScript('run-task.sh'), ['ok', '프롬프트', 'Read', 'manual', 'Write,Edit'], env).status, 0);
  assert.equal(fs.readFileSync(path.join(home, 'args.txt'), 'utf8').trim(), '-p 프롬프트 --model sonnet --permission-mode manual --allowedTools Read --disallowedTools Write,Edit');
  // 모델은 TASK_MODEL로 바꿀 수 있다(계정 기본 모델과 무관하게 자동화 비용을 고정하려는 장치).
  // 로그 문구 개수 단언을 건드리지 않게 다른 이름(ok2)으로 실행한다.
  assert.equal(runScript(automationScript('run-task.sh'), ['ok2', '프롬프트', 'Read,Write'], { ...env, TASK_MODEL: 'opus' }).status, 0);
  assert.equal(fs.readFileSync(path.join(home, 'args.txt'), 'utf8').trim(), '-p 프롬프트 --model opus --permission-mode acceptEdits --allowedTools Read,Write');
  const log = fs.readFileSync(path.join(home, 'logs', 'ok.log'), 'utf8');
  assert.doesNotMatch(log, /시간 초과/);
  assert.match(log, /^───── \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} ok 종료 \(exit 0\)$/m);
  assert.match(log, /^───── \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} ok 종료 \(exit 7\)$/m);
  assert.equal(log.split('수집 결과 요약').length - 1, 3);
  fs.rmSync(home, { recursive: true, force: true });
});

test('slack-capture.sh 잠금은 살아 있는 실행만 존중하고 죽은 잠금은 회수한다', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-slack-lock-'));
  const logs = path.join(home, 'logs');
  const lock = path.join(logs, '.slack-capture.lock');
  const config = path.join(home, 'workspace.config.json');
  fs.writeFileSync(config, '{}'); // 켜진 채널이 없으니 잠금만 잡고 곧바로 "건너뛰어요"로 끝난다
  placeCollector(home);
  const logText = () => fs.readFileSync(path.join(logs, 'slack-capture.log'), 'utf8');
  const capture = () => runScript(automationScript('slack-capture.sh'), [], {
    WORKSPACE_DIR: home, WORKSPACE_CONFIG: config, AUTOMATION_LOG_DIR: logs,
    SLACK_CAPTURE_IGNORE_HOURS: '1', WORKSPACE_PORT: '4322',
  });
  const holdLock = pid => { fs.mkdirSync(lock, { recursive: true }); fs.writeFileSync(path.join(lock, 'pid'), `${pid}\n`); };
  const longRunning = name => {
    const script = path.join(home, name);
    fs.writeFileSync(script, '#!/bin/bash\nsleep 60\n');
    fs.chmodSync(script, 0o755);
    const child = spawn('/bin/bash', [script], { stdio: 'ignore' });
    t.after(() => child.kill('SIGKILL'));
    return child.pid;
  };

  // 1) 진짜 캡처가 아직 돌고 있으면 건너뛰고, 남의 잠금은 풀지 않는다
  const holder = longRunning('slack-capture-holder.sh');
  holdLock(holder);
  assert.equal(capture().status, 0);
  assert.match(logText(), /이전 실행이 아직 진행 중/);
  assert.equal(fs.readFileSync(path.join(lock, 'pid'), 'utf8').trim(), String(holder));

  // 2) 잠금 폴더만 있고 pid를 아직 못 쓴 찰나도 "진행 중"으로 본다
  fs.rmSync(lock, { recursive: true, force: true });
  fs.mkdirSync(lock, { recursive: true });
  assert.equal(capture().status, 0);
  assert.equal(fs.existsSync(lock), true);

  // 3) 주인이 죽은 잠금은 회수한다(예전 30분 규칙 없이 즉시)
  fs.rmSync(lock, { recursive: true, force: true });
  holdLock(deadPid());
  fs.writeFileSync(path.join(logs, 'slack-capture.log'), '');
  assert.equal(capture().status, 0);
  assert.match(logText(), /켜진 채널이 없어 건너뛰어요/);
  assert.equal(fs.existsSync(lock), false); // 잡았다가 스스로 풀었다

  // 4) 번호만 같고 다른 프로그램이 쓰고 있는 PID도 회수한다
  holdLock(longRunning('other-program.sh'));
  fs.writeFileSync(path.join(logs, 'slack-capture.log'), '');
  assert.equal(capture().status, 0);
  assert.doesNotMatch(logText(), /이전 실행이 아직 진행 중/);
  assert.match(logText(), /켜진 채널이 없어 건너뛰어요/);
  assert.equal(fs.existsSync(lock), false);
  fs.rmSync(home, { recursive: true, force: true });
});

// 앱의 연동 탭에서 껐는데 자동화가 계속 도는 문제(최종 QA). 두 스크립트 모두 **시작하자마자**
// 설정(`integrations.<키>`)을 node로 읽고, 꺼져 있으면 로그 한 줄만 남기고 끝낸다.
test('연동을 끄면 run-task.sh·slack-capture.sh는 claude를 부르지 않고 건너뛴다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-intg-off-'));
  const logs = path.join(home, 'logs');
  const called = path.join(home, 'called.txt');
  const claude = path.join(home, 'fake-claude.sh');
  // 캘린더 파일도 스킬처럼 새로 쓴다 — 안 쓰면 calendar-sync는 WP-S 규칙대로 실패(65)로 끝난다.
  writeExec(claude, `#!/bin/bash\necho "불렸음" >> ${JSON.stringify(called)}\nmkdir -p tracker && date > tracker/calendar_today.md\n`);
  const config = path.join(home, 'workspace.config.json');
  const env = {
    WORKSPACE_DIR: home, WORKSPACE_CONFIG: config, AUTOMATION_LOG_DIR: logs,
    CLAUDE_BIN: claude, SLACK_CAPTURE_IGNORE_HOURS: '1',
  };
  const logOf = name => fs.readFileSync(path.join(logs, `${name}.log`), 'utf8');
  const task = name => runScript(automationScript('run-task.sh'), [name, '프롬프트', 'Read'], env);

  // 1) 껐으면 곧바로 끝난다 — 시작 줄도 남기지 않고 claude도 부르지 않는다
  // jira-sync는 없앴다(앱이 지라를 직접 읽는다) — run-task.sh의 연동 칸 매핑에서도 빠졌다.
  fs.writeFileSync(config, JSON.stringify({ integrations: { jira: false, calendar: false, tiro: false, slack: false } }));
  for (const name of ['calendar-sync', 'tiro-sync']) {
    assert.equal(task(name).status, 0, `${name}은 꺼져 있으면 조용히 끝난다`);
    assert.match(logOf(name), new RegExp(`${name} 연동이 꺼져 있어 건너뛰어요`));
    assert.doesNotMatch(logOf(name), /시작$/m);
  }
  assert.equal(runScript(automationScript('slack-capture.sh'), [], env).status, 0);
  assert.match(logOf('slack-capture'), /슬랙 수집이 꺼져 있어 건너뛰어요/);
  assert.equal(fs.existsSync(called), false, '꺼진 자동화는 claude를 부르지 않는다');

  // 2) 표에 없는 작업 이름은 검사하지 않고 예전 그대로 돈다
  assert.equal(task('envok').status, 0);
  assert.match(logOf('envok'), /envok 종료 \(exit 0\)/);
  assert.equal(fs.readFileSync(called, 'utf8').trim(), '불렸음');

  // 3) 칸이 없으면 켜진 것이다(옛 설정 파일) — 설정이 아예 없어도 같다
  fs.writeFileSync(config, JSON.stringify({ integrations: { slack: true } }));
  assert.equal(task('jira-sync').status, 0);
  assert.match(logOf('jira-sync'), /jira-sync 종료 \(exit 0\)/);
  fs.rmSync(config, { force: true });
  assert.equal(task('calendar-sync').status, 0);
  assert.match(logOf('calendar-sync'), /calendar-sync 종료 \(exit 0\)/, '설정을 못 읽으면 예전처럼 그냥 돈다');
  fs.rmSync(home, { recursive: true, force: true });
});
const writeExec = (file, body) => { fs.writeFileSync(file, body); fs.chmodSync(file, 0o755); };

test('자동화 스크립트는 설치 위치를 workspace.env에서 찾고, 그것도 없으면 안내하고 멈춘다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-env-'));
  const claude = path.join(home, 'fake-claude.sh');
  writeExec(claude, '#!/bin/bash\necho "됐어요"\n');
  const envFile = path.join(home, 'workspace.env');
  fs.writeFileSync(envFile, `WORKSPACE_DIR="${home}"\n`);
  const shared = { WORKSPACE_DIR: '', AUTOMATION_LOG_DIR: path.join(home, 'logs'), CLAUDE_BIN: claude };

  const found = runScript(automationScript('run-task.sh'), ['envok', '프롬프트', 'Read'], { ...shared, WORKSPACE_ENV_FILE: envFile });
  assert.equal(found.status, 0, 'setup.sh가 적어 둔 파일에서 설치 위치를 찾는다');
  assert.match(fs.readFileSync(path.join(home, 'logs', 'envok.log'), 'utf8'), /envok 종료 \(exit 0\)/);

  const missing = path.join(home, 'no-such.env');
  for (const script of ['run-task.sh', 'slack-capture.sh', 'backup-data.sh']) {
    const args = script === 'run-task.sh' ? ['envfail', '프롬프트', 'Read'] : [];
    const result = runScript(automationScript(script), args, { ...shared, WORKSPACE_ENV_FILE: missing, SLACK_CAPTURE_IGNORE_HOURS: '1' });
    assert.equal(result.status, 1, `${script}은 설치 정보가 없으면 멈춘다`);
    assert.match(result.stderr, /설치 정보를 찾을 수 없어요 — setup.sh를 먼저 실행해 주세요/);
  }
  fs.rmSync(home, { recursive: true, force: true });
});

// update.sh — 임시 폴더 안에 "원격 저장소(bare) + 내려받은 복사본"을 통째로 만들어 돌린다.
// PATH 앞에 가짜 `launchctl`·`curl`을 세우므로 이 테스트는 실제 앱·실제 맥 스케줄러에 닿지 않는다.
const REPO_ROOT = path.join(__dirname, '..', '..');
function updateFixture(t, { channel = 'stable' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-update-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const origin = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  const clone = path.join(root, 'clone');
  const bin = path.join(root, 'bin');
  const backups = path.join(root, 'backups');
  fs.mkdirSync(bin);
  writeExec(path.join(bin, 'launchctl'), `#!/bin/bash\necho "$@" >> ${JSON.stringify(path.join(root, 'launchctl.log'))}\nexit 0\n`);
  writeExec(path.join(bin, 'curl'), `#!/bin/bash\nprintf '{"version":"%s","dataFormat":1}' "$(tr -d '[:space:]' < ${JSON.stringify(path.join(clone, 'VERSION'))})"\n`);

  fs.mkdirSync(path.join(seed, 'tracker', 'inbox-app', 'automation'), { recursive: true });
  for (const rel of ['update.sh', 'tracker/inbox-app/migrate.js', 'tracker/inbox-app/safe-storage.js',
    'tracker/inbox-app/automation/run-task.sh', 'tracker/inbox-app/automation/slack-capture.sh', 'tracker/inbox-app/automation/backup-data.sh']) {
    fs.copyFileSync(path.join(REPO_ROOT, rel), path.join(seed, rel));
  }
  fs.writeFileSync(path.join(seed, 'VERSION'), '1.0.0\n');
  fs.writeFileSync(path.join(seed, 'ui.css'), 'body{}\n');
  fs.writeFileSync(path.join(seed, '.gitignore'), 'workspace.config.json\ntracker/*.md\ntracker/.*\n.workspace-last-good\n');
  runGit(seed, ['init', '-b', 'main']);
  runGit(seed, ['add', '-A']);
  runGit(seed, ['commit', '-m', '첫 버전']);
  runGit(seed, ['tag', 'v1.0.0']);
  fs.writeFileSync(path.join(seed, 'VERSION'), '1.1.0\n');
  fs.writeFileSync(path.join(seed, 'ui.css'), 'body{color:blue}\n');
  runGit(seed, ['commit', '-am', '다음 버전']);
  runGit(seed, ['tag', 'v1.1.0']);
  runGit(root, ['init', '--bare', '-b', 'main', origin]);
  runGit(seed, ['remote', 'add', 'origin', origin]);
  runGit(seed, ['push', '-q', 'origin', 'main', '--tags']);
  runGit(root, ['clone', '-q', origin, clone]);
  // 동료의 맥은 배포된 태그(stable)에 고정돼 있고, 나는 main 갈래를 따라간다.
  if (channel === 'main') runGit(clone, ['reset', '--hard', '-q', 'v1.0.0']);
  else runGit(clone, ['checkout', '--detach', '-q', 'v1.0.0']);

  fs.writeFileSync(path.join(clone, 'workspace.config.json'), JSON.stringify({ server: { updateChannel: channel, port: 4399 } }, null, 2));
  fs.writeFileSync(path.join(clone, 'tracker', 'tasks.md'), '# Tasks\n- 지켜야 할 업무\n');
  fs.writeFileSync(path.join(clone, 'tracker', '.workflow.json'), '{"items":{},"meetings":{}}');

  // `extra`는 물음에 답을 넣거나(input) 환경을 하나 더 끼울 때만 쓴다 — 주지 않으면 예전 그대로다.
  const run = (args = [], extra = {}) => spawnSync('/bin/bash', [path.join(clone, 'update.sh'), ...args], {
    cwd: clone, encoding: 'utf8', timeout: 120000, input: extra.input,
    // 이 테스트 파일이 쓰는 WORKSPACE_DATA_DIR이 새어 들어가면 안 된다 — 복사본 안의 tracker/를 보게 비운다.
    env: { ...gitEnv, WORKSPACE_DATA_DIR: '', HOME: root, PATH: `${bin}:${process.env.PATH}`, WORKSPACE_BACKUP_DIR: backups, WORKSPACE_INSTALL_DIR: path.join(root, 'install'), ...(extra.env || {}) },
  });
  const dated = () => (fs.existsSync(backups) ? fs.readdirSync(backups) : []).filter(name => /^\d{4}-\d{2}-\d{2}-\d{4}$/.test(name)).sort();
  const versionOf = () => fs.readFileSync(path.join(clone, 'VERSION'), 'utf8').trim();
  const tasks = () => fs.readFileSync(path.join(clone, 'tracker', 'tasks.md'), 'utf8');
  return { root, clone, backups, run, dated, versionOf, tasks };
}

test('update.sh: 깨끗한 트리에서는 배포된 최신 버전으로 옮기고, 데이터를 먼저 백업하고 최근 5개만 남긴다', { skip: !gitReady }, (t) => {
  const fix = updateFixture(t);
  fs.mkdirSync(fix.backups, { recursive: true });
  for (const day of ['01', '02', '03', '04', '05', '06']) fs.mkdirSync(path.join(fix.backups, `2020-01-${day}-0900`));
  fs.mkdirSync(path.join(fix.backups, '내가-만든-폴더'));

  const result = fix.run(['--yes']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const step of ['[1/6]', '[2/6]', '[3/6]', '[4/6]', '[5/6]', '[6/6]']) assert.ok(result.stdout.includes(step), `${step} 줄이 보인다`);
  assert.match(result.stdout, /v1\.1\.0으로 업데이트했어요/);
  assert.equal(fix.versionOf(), '1.1.0');
  assert.match(fix.tasks(), /지켜야 할 업무/, '업무 데이터는 그대로다');

  const dated = fix.dated();
  assert.equal(dated.length, 5, '이 스크립트가 만든 백업은 최근 5개만 남긴다');
  assert.ok(fs.existsSync(path.join(fix.backups, '내가-만든-폴더')), '이름 규칙이 다른 폴더는 건드리지 않는다');
  const newest = path.join(fix.backups, dated[dated.length - 1]);
  assert.match(fs.readFileSync(path.join(newest, 'tasks.md'), 'utf8'), /지켜야 할 업무/);
  assert.ok(fs.existsSync(path.join(newest, '.workflow.json')));
  assert.ok(fs.existsSync(path.join(newest, 'workspace.config.json')));

  const calls = fs.readFileSync(path.join(fix.root, 'launchctl.log'), 'utf8');
  assert.match(calls, /kickstart -k gui\/\d+\/com\.workspace\.app\.server/, '정확한 이름 하나에만 부탁한다');
  assert.doesNotMatch(calls, /pkill|killall/);
});

test('update.sh: 고친 파일을 그대로 두기로 하면 업데이트를 멈추고 데이터를 지킨다', { skip: !gitReady }, (t) => {
  const fix = updateFixture(t);
  fs.writeFileSync(path.join(fix.clone, 'ui.css'), '/* 내가 고친 것 */\n');

  const result = fix.run(['--yes']);   // --yes는 "그대로 두기"를 고른다
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /고친 파일이 있어요: ui\.css/);
  assert.match(result.stdout, /고친 파일 때문에 업데이트를 이어 갈 수 없어요/);
  assert.equal(fs.readFileSync(path.join(fix.clone, 'ui.css'), 'utf8'), '/* 내가 고친 것 */\n', '고친 파일을 덮어쓰지 않는다');
  assert.equal(fix.versionOf(), '1.0.0');
  assert.match(fix.tasks(), /지켜야 할 업무/, '멈춰도 업무 데이터는 그대로다');
  assert.equal(fix.dated().length, 1, '멈추기 전에 백업은 이미 만들어 둔다');
});

test('update.sh --rollback은 이전 코드와 백업 데이터를 함께 되돌린다', { skip: !gitReady }, (t) => {
  const fix = updateFixture(t);
  assert.equal(fix.run(['--yes']).status, 0);
  assert.equal(fix.versionOf(), '1.1.0');
  // 새 버전에서 데이터가 망가진 상황을 흉내 낸다
  fs.writeFileSync(path.join(fix.clone, 'tracker', 'tasks.md'), '# Tasks\n- 망가진 내용\n');

  const back = fix.run(['--rollback', '--yes']);
  assert.equal(back.status, 0, back.stdout + back.stderr);
  assert.equal(fix.versionOf(), '1.0.0', '코드는 이전 자리로 돌아간다');
  assert.match(fix.tasks(), /지켜야 할 업무/, '데이터도 백업에서 돌아온다');
  assert.equal(fs.existsSync(path.join(fix.clone, '.workspace-last-good')), false, '두 번 되돌리지 않는다');
});

// 고친 내용을 보관하지 못했는데 되돌리면 그 내용이 그대로 사라진다(최종 QA). 보관에 실패하면
// 지우지 않고 멈춘다. `git stash create`가 빈 값을 주는 상황은 명령을 바꿔 끼워 흉내 낸다.
test('update.sh: 고친 내용을 보관하지 못하면 되돌리지 않고 멈춘다', { skip: !gitReady }, (t) => {
  const fix = updateFixture(t);
  fs.writeFileSync(path.join(fix.clone, 'ui.css'), '/* 내가 고친 것 */\n');

  // `되돌리고 받을까요? [y]`에 y라고 답하는데, 보관이 실패한다
  const result = fix.run([], { input: 'y\n', env: { WORKSPACE_STASH_CREATE: 'true' } });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /고친 내용을 보관하지 못해 멈췄어요/);
  assert.equal(fs.readFileSync(path.join(fix.clone, 'ui.css'), 'utf8'), '/* 내가 고친 것 */\n', '고친 내용은 지워지지 않는다');
  assert.equal(fix.versionOf(), '1.0.0', '멈췄으니 새 버전을 받지도 않는다');
  assert.match(fix.tasks(), /지켜야 할 업무/);

  // 보관이 되면 예전처럼 가지에 담고 되돌린 뒤 이어 간다
  const ok = fix.run([], { input: 'y\n' });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /고친 내용을 local-changes-[0-9-]+ 가지에 담아 뒀어요/);
  assert.equal(fix.versionOf(), '1.1.0');
  assert.doesNotMatch(fs.readFileSync(path.join(fix.clone, 'ui.css'), 'utf8'), /내가 고친 것/);
  assert.match(runGit(fix.clone, ['branch', '--list', 'local-changes-*']).stdout, /local-changes-/, '고친 내용은 가지로 남아 있다');
});

test('update.sh: main 갈래는 태그가 아니라 origin/main을 앞으로만 따라간다', { skip: !gitReady }, (t) => {
  const fix = updateFixture(t, { channel: 'main' });
  const result = fix.run(['--yes']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fix.versionOf(), '1.1.0');
  assert.equal(runGit(fix.clone, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim(), 'main', '갈래를 떼어 놓지 않는다');
  assert.equal(runGit(fix.clone, ['rev-parse', 'HEAD']).stdout.trim(), runGit(fix.clone, ['rev-parse', 'origin/main']).stdout.trim());
});

// setup.sh는 실행하지 않는다(실제 launchd·홈 폴더를 건드린다) — 설정을 읽는 그 조각만 꺼내 돌린다.
test('setup.sh: 설정은 python3가 아니라 node로 읽고, 못 읽으면 에이전트를 내리기 전에 멈춘다', () => {
  const script = fs.readFileSync(path.join(REPO_ROOT, 'setup.sh'), 'utf8');
  assert.ok(!script.includes('json.load(open('), '설정을 python3로 읽던 자리는 남아 있지 않다');
  for (const key of ['slack', 'calendar', 'jira', 'tiro']) {
    assert.ok(script.includes(`config_read uses ${key})`) && script.includes('|| die "$CONFIG_UNREADABLE"'),
      `${key}는 읽기에 실패하면 멈춘다(꺼진 것으로 읽지 않는다)`);
  }
  const reader = script.split("CONFIG_READER='")[1].split("\n'\n")[0];

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-setup-read-'));
  const config = path.join(home, 'workspace.config.json');
  const read = (...args) => spawnSync(process.execPath, ['-e', reader, config, ...args], { encoding: 'utf8' });

  fs.writeFileSync(config, JSON.stringify({
    integrations: { slack: false, calendar: true },
    server: { port: 4399, chromeProfile: 'Profile 1' },
    slack: { tokenFile: '~/.config/workspace-slack-token' },
  }));
  assert.equal(read('uses', 'slack').stdout, 'no');
  assert.equal(read('uses', 'calendar').stdout, 'yes');
  assert.equal(read('uses', 'jira').stdout, 'yes', '칸이 없으면 켜진 것이다(서버 USES와 같은 규칙)');
  assert.equal(read('server', 'port').stdout, '4399');
  assert.equal(read('server', 'extraHost').stdout, '', '없는 칸은 빈 값이다');
  assert.equal(read('slackToken').stdout, path.join(os.homedir(), '.config', 'workspace-slack-token'));
  // 슬랙 연결 방식 — 칸이 없으면 옛 방식이고, 새 방식이면 갱신 정보 파일 자리를 준다(파일은 읽지 않는다).
  assert.equal(read('slackAuth').stdout, 'token');
  assert.equal(read('slackOAuthFile').stdout, path.join(os.homedir(), '.config', 'workspace-slack-oauth.json'));
  fs.writeFileSync(config, JSON.stringify({ slack: { auth: 'oauth', oauthFile: '/somewhere/oauth.json' } }));
  assert.equal(read('slackAuth').stdout, 'oauth');
  assert.equal(read('slackOAuthFile').stdout, '/somewhere/oauth.json');
  assert.match(script, /elif \[ -f "\$HOME\/\.config\/workspace-slack-token" \]; then[\s\S]*?ok "슬랙 토큰 있음 \(기본 자리\)"/, '기본 자리 토큰으로 도는 설치에 "돌지 않아요"라고 하지 않는다');
  assert.doesNotMatch(script, /슬랙 캡처는 돌지 않아요/);
  assert.match(script, /if \[ "\$SLACK_AUTH" = "oauth" \]; then[\s\S]*?ok "슬랙 연결 있음 \(자동 갱신\)"[\s\S]*?elif \[ -n "\$TOKEN_FILE" \]/, '새 방식 설치는 토큰 파일 경고 대신 갱신 정보 파일을 본다');
  // 크롬 프로필은 예전 Dock 앱만 썼다 — 이제 읽지 않는다(값은 쉘 명령 어디에도 들어가지 않는다)
  assert.equal(read('chromeProfile').stdout, '');
  assert.ok(!script.includes('CHROME_PROFILE'), 'setup.sh는 크롬 프로필을 읽지 않는다');

  // 깨진 설정은 "빈 값"이 아니라 오류다 — setup.sh는 여기서 멈춘다
  fs.writeFileSync(config, '{망가짐');
  assert.notEqual(read('uses', 'slack').status, 0);
  assert.equal(read('uses', 'slack').stdout, '');
  fs.rmSync(home, { recursive: true, force: true });
});

// jira-sync(지라 담당 이슈 캐시 갱신) 자동화는 없앴다 — 앱이 지라를 직접 읽는다(DECISIONS 2026-09-24).
// setup.sh는 실행하지 않는다 — 등록·해제 조각을 문자열로만 확인한다.
test('setup.sh는 jira-sync를 등록하지 않고, 지라 켬/끔과 무관하게 등록을 내린다', () => {
  const script = fs.readFileSync(path.join(REPO_ROOT, 'setup.sh'), 'utf8');
  assert.ok(!script.includes('write_task_agent "jira-sync"'), 'jira-sync를 새로 등록하는 자리는 없다');
  assert.ok(!/\[\s*"\$USE_JIRA"\s*=\s*"yes"\s*\]\s*\|\|\s*remove_agent jira-sync/.test(script),
    '지라를 켰을 때만 내리던 예전 조건문은 없다');
  assert.match(script, /\nremove_agent jira-sync\n/, '켬/끔과 무관하게 무조건 내린다');
  // 등록 루프(launchctl load)에는 이제 jira-sync가 없다 — 나머지는 그대로다.
  const loadLoop = script.split('for f in server slack-capture calendar-sync')[1].split('\n')[0];
  assert.ok(!loadLoop.includes('jira-sync'), '등록 루프 목록에서 jira-sync를 뺐다');
  assert.ok(loadLoop.includes('tiro-sync') && loadLoop.includes('data-backup'), '나머지 자동화는 그대로 등록한다');
  // 옛 이름(com.luvon.workspace.jira-sync) 정리용 목록에는 남겨 둔다 — 옛 설치가 지운다.
  assert.match(script, /AGENT_NAMES="[^"]*\bjira-sync\b[^"]*"/, '옛 라벨 정리용 이름 목록은 그대로 남긴다');
});

// 화면의 "Claude Code 설치됨"과 자동화가 claude를 찾는 자리가 어긋나면, 스크립트는 claude를 돌리는데 화면은 "설치 안 됨"이 된다.
test('claude 찾는 자리: integrations.js의 claudeCandidateDirs가 run-task.sh의 PATH 줄에 있는 자리를 모두 본다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-claude-dirs-'));
  fs.mkdirSync(path.join(home, '.nvm', 'versions', 'node', 'v18.0.0', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(home, '.nvm', 'versions', 'node', 'v20.1.0', 'bin'), { recursive: true });
  const script = fs.readFileSync(automationScript('run-task.sh'), 'utf8');
  const nodeLine = script.split('\n').find(line => line.startsWith('NODE_BIN='));
  const pathLine = script.split('\n').find(line => line.startsWith('export PATH='));
  assert.ok(nodeLine && pathLine);
  // 스크립트의 두 줄만 떼어 돌린다(claude는 부르지 않는다)
  const shown = spawnSync('/bin/bash', ['-c', `${nodeLine}\n${pathLine}\nprintf %s "$PATH"`], { encoding: 'utf8', env: { HOME: home, PATH: '/usr/bin:/bin' } });
  const { claudeCandidateDirs, claudeInstalled } = require('./integrations');
  const seen = claudeCandidateDirs('', home);
  for (const dir of shown.stdout.split(':').filter(d => d && !['/usr/bin', '/bin'].includes(d))) {
    assert.ok(seen.includes(dir), `run-task.sh가 보는 ${dir}을 화면도 본다`);
  }
  assert.match(script, /CLAUDE="\$\{CLAUDE_BIN:-\$\(command -v claude \|\| echo "\$HOME\/\.local\/bin\/claude"\)\}"/, '못 찾을 때의 자리도 ~/.local/bin');

  // PATH에 없어도 그 자리들 중 하나에 있으면 설치됨 — 여러 자리에 있어도 마찬가지
  const empty = path.join(home, 'empty');
  fs.mkdirSync(empty);
  assert.equal(claudeInstalled(empty, home), fs.existsSync('/opt/homebrew/bin/claude') || fs.existsSync('/usr/local/bin/claude') || fs.existsSync('/usr/bin/claude'));
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  writeExec(path.join(home, '.local', 'bin', 'claude'), '#!/bin/bash\nexit 0\n');
  assert.equal(claudeInstalled(empty, home), true, '~/.local/bin/claude');
  fs.rmSync(path.join(home, '.local', 'bin', 'claude'));
  writeExec(path.join(home, '.nvm', 'versions', 'node', 'v20.1.0', 'bin', 'claude'), '#!/bin/bash\nexit 0\n');
  assert.equal(claudeInstalled(empty, home), true, 'nvm의 가장 뒤 버전 bin');
  writeExec(path.join(empty, 'claude'), '#!/bin/bash\nexit 0\n');
  assert.equal(claudeInstalled(empty, home), true, 'PATH에도 있고 nvm에도 있으면 설치됨');
  fs.rmSync(home, { recursive: true, force: true });
});

test('WP-D2 run-task.sh: 캘린더가 비밀 주소 갈래면 calendar-sync는 claude를 부르지 않고 건너뛴다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-ical-skip-'));
  const logs = path.join(home, 'logs');
  const called = path.join(home, 'called.txt');
  const claude = path.join(home, 'fake-claude.sh');
  writeExec(claude, `#!/bin/bash\necho "불렸음" >> ${JSON.stringify(called)}\n`);
  const config = path.join(home, 'workspace.config.json');
  fs.writeFileSync(config, JSON.stringify({ integrations: { calendar: true, tiro: true }, calendar: { source: 'ical' } }));
  const env = { WORKSPACE_DIR: home, WORKSPACE_CONFIG: config, AUTOMATION_LOG_DIR: logs, CLAUDE_BIN: claude };
  assert.equal(runScript(automationScript('run-task.sh'), ['calendar-sync', '프롬프트', 'Read'], env).status, 0);
  assert.match(fs.readFileSync(path.join(logs, 'calendar-sync.log'), 'utf8'), /calendar-sync 비밀 주소로 앱이 직접 읽고 있어 건너뛰어요/);
  assert.equal(fs.existsSync(called), false);
  // 다른 작업은 그대로 돈다
  assert.equal(runScript(automationScript('run-task.sh'), ['tiro-sync', '프롬프트', 'Read'], env).status, 0);
  assert.equal(fs.readFileSync(called, 'utf8').trim(), '불렸음');
  // Claude Code 갈래로 돌아가면 예전처럼 돈다(이 가짜는 캘린더 파일을 쓰지 않으므로 WP-S 규칙대로 65로 끝난다)
  fs.writeFileSync(config, JSON.stringify({ integrations: { calendar: true }, calendar: { source: 'claude' } }));
  fs.rmSync(called);
  assert.equal(runScript(automationScript('run-task.sh'), ['calendar-sync', '프롬프트', 'Read'], env).status, 65);
  assert.equal(fs.readFileSync(called, 'utf8').trim(), '불렸음');
  fs.rmSync(home, { recursive: true, force: true });
});

// 동료 맥에서 Claude에 구글 캘린더 도구가 없어 calendar-sync가 "못 했어요"라고 답하고 0으로 끝났는데 기록은 성공이었다.
test('WP-S run-task.sh: calendar-sync가 0으로 끝났는데 캘린더 파일이 그대로면 ⚠️ 한 줄 + exit 65, 바뀌었으면 0', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-cal-stale-'));
  const logs = path.join(home, 'logs');
  const claude = path.join(home, 'fake-claude.sh');
  // FAKE_WRITE가 있으면 스킬처럼 캘린더 파일을 새로 쓴다(같은 내용이어도). FAKE_EXIT로 claude 자체의 실패를 흉내 낸다.
  writeExec(claude, '#!/bin/bash\necho "Google Calendar 도구를 찾지 못했어요. 인증이 필요해요."\n'
    + 'if [ -n "${FAKE_WRITE:-}" ]; then mkdir -p tracker && printf \'# 오늘 캘린더 일정\\n\' > tracker/calendar_today.md; fi\nexit ${FAKE_EXIT:-0}\n');
  const config = path.join(home, 'workspace.config.json');
  fs.writeFileSync(config, JSON.stringify({ integrations: { calendar: true }, calendar: { source: 'claude' } }));
  const env = { WORKSPACE_DIR: home, WORKSPACE_CONFIG: config, AUTOMATION_LOG_DIR: logs, CLAUDE_BIN: claude };
  const run = (name, extra = {}) => runScript(automationScript('run-task.sh'), [name, '프롬프트', 'Read'], { ...env, ...extra }).status;
  const log = name => fs.readFileSync(path.join(logs, `${name}.log`), 'utf8');
  const WARN = '⚠️ 캘린더 파일이 갱신되지 않았어요 — Claude에 구글 캘린더가 연결돼 있지 않으면 설정 › 연동 › 캘린더에서 비밀 주소로 바꾸거나 Claude 커넥터에서 연결해 주세요';
  const warnings = name => log(name).split(WARN).length - 1;

  // (1) 파일이 없고 claude도 만들지 않음 → 실패
  assert.equal(run('calendar-sync'), 65);
  assert.equal(warnings('calendar-sync'), 1);
  assert.match(log('calendar-sync'), /^───── \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} calendar-sync 종료 \(exit 65\)$/m);
  // 경고 줄은 종료 줄 바로 앞(같은 실행 블록 안)에 있다
  assert.match(log('calendar-sync'), new RegExp(`${WARN}\\n\\n───── [^\\n]+ calendar-sync 종료 \\(exit 65\\)`));
  // (2) claude가 파일을 새로 만듦 → 성공
  assert.equal(run('calendar-sync', { FAKE_WRITE: '1' }), 0);
  // (3) 파일이 있는데 이번에도 다시 씀(같은 초 안이라도 나노초로 구분) → 성공
  assert.equal(run('calendar-sync', { FAKE_WRITE: '1' }), 0);
  // (4) 파일이 있는데 건드리지 않음 → 실패
  assert.equal(run('calendar-sync'), 65);
  assert.equal(warnings('calendar-sync'), 2);
  // (5) claude 자체가 실패하면 그 코드 그대로(경고 줄을 덧붙이지 않는다)
  assert.equal(run('calendar-sync', { FAKE_EXIT: '3' }), 3);
  assert.equal(warnings('calendar-sync'), 2);
  // (6) 다른 작업은 캘린더 파일을 보지 않는다
  assert.equal(run('tiro-sync'), 0);
  assert.equal(warnings('tiro-sync'), 0);
  assert.equal(fs.readFileSync(path.join(home, 'tracker', 'calendar_today.md'), 'utf8'), '# 오늘 캘린더 일정\n', '스크립트는 캘린더 파일을 쓰지 않는다');
  fs.rmSync(home, { recursive: true, force: true });
});

// setup.sh는 실행하지 않는다 — 조각을 문자열로 확인하고, 설정 읽기 조각만 돌려 본다.
test('WP-D2 setup.sh: 캘린더가 비밀 주소면 calendar-sync를 내리고, app-refresh는 더 등록하지 않는다(WP-O)', () => {
  const script = fs.readFileSync(path.join(REPO_ROOT, 'setup.sh'), 'utf8');
  assert.doesNotMatch(script, /<string>\$LABEL\.app-refresh<\/string>/, 'app-refresh plist를 새로 쓰지 않는다');
  // WP-D2.5에서 `지금 가져오기` 에이전트 둘(slack-capture-now·calendar-sync-now)이 뒤에 붙었다.
  // WP-V에서 맥 캘린더 둘(mac-calendar·mac-calendar-now)이 뒤에 붙었다.
  assert.match(script, /for f in server slack-capture calendar-sync tiro-sync data-backup slack-capture-now calendar-sync-now mac-calendar mac-calendar-now; do/);
  assert.doesNotMatch(script, /"\$APP_DIR\/automation\/app-refresh\.sh"/, 'app-refresh.sh를 복사하지 않는다');
  assert.ok(!/osacompile|iconutil|sips |lsregister|codesign/.test(script), 'Dock 앱 만드는 코드가 없다');
  assert.match(script, /\[ "\$USE_CAL_SYNC" = "yes" \] && write_task_agent "calendar-sync"/);
  assert.match(script, /\[ "\$USE_CAL_SYNC" = "yes" \] \|\| remove_agent calendar-sync/);
  assert.match(script, /\[ "\$CAL_SOURCE" = "ical" \] && USE_CAL_SYNC="no"/);
  assert.ok(!/killall|pkill/.test(script), 'Dock·프로세스를 이름으로 끝내지 않는다');

  const reader = script.split("CONFIG_READER='")[1].split("\n'\n")[0];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-setup-ical-'));
  const config = path.join(home, 'workspace.config.json');
  const read = (...args) => spawnSync(process.execPath, ['-e', reader, config, ...args], { encoding: 'utf8' }).stdout;
  fs.writeFileSync(config, JSON.stringify({ integrations: { calendar: true }, calendar: { source: 'ical' } }));
  assert.equal(read('calendarSource'), 'ical');
  fs.writeFileSync(config, JSON.stringify({ integrations: { calendar: true }, calendar: { source: 'claude' } }));
  assert.equal(read('calendarSource'), '');
  fs.writeFileSync(config, JSON.stringify({ integrations: { calendar: true }, calendar: { source: 'mac' } }));
  assert.equal(read('calendarSource'), 'mac');
  fs.writeFileSync(config, JSON.stringify({ calendar: { source: 'other' } }));
  assert.equal(read('calendarSource'), '');
  fs.writeFileSync(config, JSON.stringify({}));
  assert.equal(read('calendarSource'), '');
  fs.rmSync(home, { recursive: true, force: true });
});

test('WP-D2.5 slack-capture.sh: SLACK_CAPTURE_MANUAL=1이면 시간대 판단을 건너뛰고, 연동을 껐으면 여전히 멈춘다', () => {
  const script = fs.readFileSync(automationScript('slack-capture.sh'), 'utf8');
  assert.match(script, /if \[ "\$\{SLACK_CAPTURE_IGNORE_HOURS:-0\}" != "1" \] && \[ "\$\{SLACK_CAPTURE_MANUAL:-0\}" != "1" \]; then/);
  // 연동 끔 검사가 시간 판단보다 먼저다
  assert.ok(script.indexOf('슬랙 수집이 꺼져 있어 건너뛰어요') < script.indexOf('SLACK_CAPTURE_MANUAL:-0'));

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-slack-manual-'));
  const logs = path.join(home, 'logs');
  const config = path.join(home, 'workspace.config.json');
  const env = { WORKSPACE_DIR: home, WORKSPACE_CONFIG: config, AUTOMATION_LOG_DIR: logs };
  fs.writeFileSync(config, '{}');
  placeCollector(home);
  // 스크립트가 PATH를 새로 잡아 시계를 바꿔 끼울 수 없다 — 지금 시각이 9~19시 밖일 때만 "주기 실행은 조용히 빠진다"를 본다.
  const hour = new Date().getHours();
  if (hour < 9 || hour >= 19) {
    assert.equal(runScript(automationScript('slack-capture.sh'), [], env).status, 0, '5분 주기 실행은 시간대 밖이면 조용히 빠진다');
    assert.equal(fs.existsSync(path.join(logs, 'slack-capture.log')), false);
  }
  // 수동 실행은 몇 시든 채널 확인까지 간다(켜진 채널이 없어 수집하지 않고 한 줄 남긴다)
  const manual = runScript(automationScript('slack-capture.sh'), [], { ...env, SLACK_CAPTURE_MANUAL: '1' });
  assert.equal(manual.status, 0);
  assert.match(fs.readFileSync(path.join(logs, 'slack-capture.log'), 'utf8'), /켜진 채널이 없어 건너뛰어요/);
  fs.writeFileSync(config, JSON.stringify({ integrations: { slack: false } }));
  assert.equal(runScript(automationScript('slack-capture.sh'), [], { ...env, SLACK_CAPTURE_MANUAL: '1' }).status, 0);
  assert.match(fs.readFileSync(path.join(logs, 'slack-capture.log'), 'utf8'), /슬랙 수집이 꺼져 있어 건너뛰어요/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('WP-D2.5 setup.sh: 지금 가져오기 에이전트 둘을 등록하고(ical이면 calendar-sync-now 없음), 티로 프롬프트는 calendar.source로 고른다', () => {
  const script = fs.readFileSync(path.join(REPO_ROOT, 'setup.sh'), 'utf8');
  // 슬랙: 같은 slack-capture.sh를 SLACK_CAPTURE_MANUAL=1로, 요청 파일을 지켜본다(슬랙을 켰을 때만)
  const slackBlock = script.split('if [ "$USE_SLACK" = "yes" ]; then\ncat > "$AGENTS_DIR/$LABEL.slack-capture.plist"')[1].split('\nfi\n')[0];
  assert.match(slackBlock, /<string>\$LABEL\.slack-capture-now<\/string>/);
  assert.match(slackBlock, /<key>SLACK_CAPTURE_MANUAL<\/key>\n\s*<string>1<\/string>/);
  assert.match(slackBlock, /<string>\$\(xml_escape "\$INSTALL_DIR\/requests\/slack-capture\.request"\)<\/string>/);
  assert.match(slackBlock, /<key>WatchPaths<\/key>/);
  assert.match(slackBlock, /<key>RunAtLoad<\/key>\n\s*<false\/>/);
  // 캘린더(Claude): calendar-sync-now는 USE_CAL_SYNC일 때만(ical이면 no) — run-task.sh에는 calendar-sync 이름으로
  assert.match(script, /\[ "\$USE_CAL_SYNC" = "yes" \] && write_watch_agent "calendar-sync-now" "\$INSTALL_DIR\/requests\/calendar-sync\.request" \\\n\s*"\$CAL_SYNC_PROMPT" "\$CAL_SYNC_TOOLS" "calendar-sync"/);
  assert.match(script, /\[ "\$CAL_SOURCE" = "ical" \] && USE_CAL_SYNC="no"/);
  assert.match(script, /\[ "\$USE_SLACK" = "yes" \] \|\| remove_agent slack-capture-now/);
  assert.match(script, /\[ "\$USE_CAL_SYNC" = "yes" \] \|\| remove_agent calendar-sync-now/);
  assert.match(script, /local name="\$1" watch="\$2" prompt tools task/);
  assert.match(script, /<string>\$task<\/string>/);

  // write_watch_agent 조각만 꺼내 임시 폴더에 plist를 써 본다(launchctl은 부르지 않는다)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-setup-watch-'));
  const piece = script.split('xml_escape() {')[1].split('\n# 슬랙 캡처 — 새 메시지가 있을 때만')[0];
  const runner = `AGENTS_DIR=${JSON.stringify(home)}; LABEL=com.workspace.app; INSTALL_DIR=/x/inst; WORKSPACE=/x/ws\nxml_escape() {${piece}\nwrite_watch_agent "calendar-sync-now" "/x/inst/requests/calendar-sync.request" "프롬프트 <&>" "Read" "calendar-sync"\nwrite_watch_agent "tiro-sync" "/x/inst/requests/tiro-sync.request" "p" "t"\n`;
  const ran = spawnSync('/bin/bash', ['-c', runner], { encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  const now = fs.readFileSync(path.join(home, 'com.workspace.app.calendar-sync-now.plist'), 'utf8');
  assert.match(now, /<string>com\.workspace\.app\.calendar-sync-now<\/string>/);
  assert.match(now, /<string>\/x\/inst\/run-task\.sh<\/string>\n\s*<string>calendar-sync<\/string>/, '실행 이름은 calendar-sync(로그·상태를 한 줄로)');
  assert.match(now, /프롬프트 &lt;&amp;&gt;/);
  assert.match(now, /logs\/calendar-sync\.err/);
  const tiro = fs.readFileSync(path.join(home, 'com.workspace.app.tiro-sync.plist'), 'utf8');
  assert.match(tiro, /<string>\/x\/inst\/run-task\.sh<\/string>\n\s*<string>tiro-sync<\/string>/, '다섯째 값이 없으면 예전 그대로');
  fs.rmSync(home, { recursive: true, force: true });

  // 티로 프롬프트: calendar.source를 보고 고른다 — ical이면 calendar-sync를 시도하지 않고 앱의 오늘 미팅을
  const tiroPrompt = script.split('write_watch_agent "tiro-sync"')[1].split('\n\n')[0];
  assert.match(tiroPrompt, /calendar\.source를 보고 골라라/);
  assert.match(tiroPrompt, /캘린더 갱신\(calendar-sync\)을 시도하지 말고 앱의 GET \/api\/items가 주는 오늘 미팅/);
  const skill = fs.readFileSync(path.join(REPO_ROOT, '.claude', 'skills', 'tiro-sync.md'), 'utf8');
  assert.match(skill, /`calendar\.source`가 `"ical"`/);
  assert.match(skill, /\/api\/items`를 불러 응답의 `calendar\.events`/);
});

// 설치 위치 지키기 — 함수 조각만 source해서 임시 HOME·임시 폴더·가짜 git 저장소로만 시험한다.
test('WP-D2.5 install-location: playio 폴더면 ~/workspace로 옮겨 새 위치의 스크립트로 이어 가고, 못 옮기면 멈추며, 그 밖은 그대로(바탕화면은 경고만)', { skip: !gitReady }, () => {
  const lib = path.join(__dirname, 'automation', 'install-location.sh');
  const script = fs.readFileSync(lib, 'utf8');
  assert.ok(!/rm -rf|rm -r /.test(script), '옮기기 코드는 지우지 않는다');
  assert.ok(!/pkill|killall|xargs kill/.test(script));
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-relocate-')));
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const target = path.join(home, 'workspace');
  // 설치 폴더 하나를 흉내 낸다 — 옮긴 뒤 이어서 돌 `setup.sh`는 받은 인자와 표시를 적기만 한다
  const makeInstall = (dir) => {
    fs.mkdirSync(dir, { recursive: true });
    writeExec(path.join(dir, 'setup.sh'), '#!/bin/bash\necho "continued:$(cd "$(dirname "$0")" && pwd -P):${WORKSPACE_RELOCATED:-}:$*"\n');
    fs.writeFileSync(path.join(dir, 'marker.txt'), 'data\n');
    return dir;
  };
  const guard = (dir, extra = '') => spawnSync('/bin/bash', ['-c',
    `. ${JSON.stringify(lib)}\n${extra}\ncd ${JSON.stringify(root)}\ninstall_location_guard ${JSON.stringify(dir)} setup.sh --one two\necho "stayed:$?"`], {
    encoding: 'utf8', env: { ...process.env, HOME: home, WORKSPACE_RELOCATE_TARGET: target, WORKSPACE_RELOCATED: '' },
  });

  // 1) 경로에 PlayIO(대소문자 무시) → 옮기고 새 위치의 같은 스크립트로 이어 간다(인자·표시 그대로)
  const company = makeInstall(path.join(root, 'PlayIO-docs', 'tools', 'workspace-tracker'));
  const moved = guard(company);
  assert.equal(moved.status, 0, moved.stderr);
  assert.match(moved.stdout, new RegExp(`continued:${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:1:--one two`));
  assert.ok(!moved.stdout.includes('stayed:'), 'exec로 넘어가 돌아오지 않는다');
  assert.equal(fs.readFileSync(path.join(target, 'marker.txt'), 'utf8'), 'data\n');
  assert.equal(fs.existsSync(company), false, '옛 자리에 링크·폴더를 새로 만들지 않는다');
  assert.ok(fs.existsSync(path.join(root, 'PlayIO-docs', 'tools')), '회사 쪽 다른 폴더는 그대로다');

  // 2) 대상이 이미 있으면(무엇이든) 멈추고 아무것도 바꾸지 않는다
  const second = makeInstall(path.join(root, 'playio', 'workspace-tracker'));
  const blocked = guard(second);
  assert.match(blocked.stdout, /회사\(playio\) 폴더 안에 설치돼 있어서 ~\/workspace로 옮겨야 하는데, ~\/workspace가 이미 있어요\. 그 폴더 이름을 바꾼 뒤 다시 실행해 주세요\./);
  assert.match(blocked.stdout, /stayed:1/);
  assert.ok(fs.existsSync(path.join(second, 'marker.txt')));
  fs.rmSync(target, { recursive: true, force: true });
  fs.symlinkSync(path.join(root, 'nowhere'), target);
  assert.match(guard(second).stdout, /이미 있어요[\s\S]*stayed:1/, '깨진 링크도 "있음"이다');
  fs.unlinkSync(target);

  // 3) 다른 디스크(장치 번호가 다름 — 주입) → 복사하지 않고 멈춘다
  const otherDisk = guard(second, 'install_location_device() { case "$1" in *playio*) echo 1 ;; *) echo 2 ;; esac; }');
  assert.match(otherDisk.stdout, /다른 디스크라 한 번에 옮길 수 없어요[\s\S]*stayed:1/);
  assert.ok(fs.existsSync(path.join(second, 'marker.txt')) && !fs.existsSync(target));

  // 4) 바깥쪽 git 저장소의 remote에 playio → 옮긴다(설치 폴더 자신의 .git은 보지 않는다)
  const outer = path.join(root, 'company-repo');
  fs.mkdirSync(outer);
  runGit(outer, ['init', '-q']);
  runGit(outer, ['remote', 'add', 'origin', 'git@github.com:PlayIO-Corp/docs.git']);
  const nested = makeInstall(path.join(outer, 'sub', 'tracker-copy'));
  runGit(nested, ['init', '-q']);
  runGit(nested, ['remote', 'add', 'origin', 'https://github.com/luvoneun/workspace-tracker.git']);
  const viaRemote = guard(nested);
  assert.match(viaRemote.stdout, /continued:.*\/home\/workspace:1:/);
  fs.rmSync(target, { recursive: true, force: true });

  // 5) 일반 폴더·이름을 바꾼 폴더 → 그대로(자기 저장소 remote는 보지 않는다)
  const plain = makeInstall(path.join(root, 'elsewhere', 'my-renamed-tracker'));
  runGit(plain, ['init', '-q']);
  runGit(plain, ['remote', 'add', 'origin', 'https://github.com/playio-mirror/workspace-tracker.git']);
  const stay = guard(plain);
  assert.equal(stay.stdout.trim(), 'stayed:0');
  assert.ok(fs.existsSync(path.join(plain, 'marker.txt')) && !fs.existsSync(target));

  // 6) 바탕화면 아래 → 경고 한 줄만, 그대로
  const desk = makeInstall(path.join(home, 'Desktop', 'workspace-tracker'));
  const warned = guard(desk);
  assert.match(warned.stdout, /바탕화면·문서·iCloud 폴더는 동기화 때문에 느리거나 파일이 꼬일 수 있어요 — 권장 위치는 ~\/workspace예요\.\nstayed:0/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('WP-D2.5 update.sh·setup.sh는 설치 위치 판단을 맨 앞에서 부르고, 옮겼으면 0단계 한 줄 + 새 위치에서 setup.sh를 다시 돌린다', () => {
  const update = fs.readFileSync(path.join(REPO_ROOT, 'update.sh'), 'utf8');
  const setup = fs.readFileSync(path.join(REPO_ROOT, 'setup.sh'), 'utf8');
  const command = fs.readFileSync(path.join(REPO_ROOT, '업데이트.command'), 'utf8');
  const guardAt = text => text.indexOf('install_location_guard "$WORKSPACE"');
  assert.ok(guardAt(update) > 0 && guardAt(update) < update.indexOf('cd "$WORKSPACE" || exit 1'), 'update.sh: 폴더에 들어가기 전에');
  assert.ok(guardAt(update) < update.indexOf('[1/6]') && guardAt(update) < update.indexOf('ROLLBACK" = "1"'));
  assert.match(update, /install_location_guard "\$WORKSPACE" "update\.sh" "\$@"/);
  assert.ok(guardAt(setup) > 0 && guardAt(setup) < setup.indexOf('[1/4]') && guardAt(setup) < setup.indexOf('xattr -d'), 'setup.sh: 맨 앞에서');
  assert.match(setup, /install_location_guard "\$WORKSPACE" "setup\.sh" "\$@"/);
  for (const text of [update, setup]) {
    assert.match(text, /\. "\$WORKSPACE\/tracker\/inbox-app\/automation\/install-location\.sh"/);
    assert.match(text, /echo "0\. 설치 위치 옮기기 — 회사 폴더 밖 ~\/workspace로 옮겼어요"/);
  }
  assert.match(update, /if \[ "\$\{WORKSPACE_RELOCATED:-\}" = "1" \]; then\n[\s\S]*?WORKSPACE_RELOCATED= bash "\$WORKSPACE\/setup\.sh"/);
  // 복사본 규칙: 두 스크립트 모두 install-location.sh를 설치 폴더로 복사한다
  assert.match(setup, /\ncp "\$APP_DIR\/automation\/run-task\.sh" [^\n]*"\$APP_DIR\/automation\/install-location\.sh" [^\n]*"\$INSTALL_DIR\/"\n/);
  assert.match(update, /cp "\$APP_DIR\/automation\/install-location\.sh" "\$INSTALL_DIR\/"/);
  assert.match(command, /bash update\.sh && cd "\$\(pwd -P\)" && bash setup\.sh/);
  for (const text of [update, setup]) assert.ok(!/pkill|killall|xargs kill/.test(text));
});

// update-runner.sh — 가짜 update.sh/setup.sh가 부른 순서와 받은 인자·환경만 적는다.
function runnerFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-d3-runner-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const install = path.join(root, 'install');
  const trail = path.join(root, 'trail.txt');
  fs.mkdirSync(workspace);
  fs.mkdirSync(path.join(install, 'requests'), { recursive: true });
  const fake = (name, extra = '') => writeExec(path.join(workspace, name),
    `#!/bin/bash\necho "${name} $* status=\${WORKSPACE_UPDATE_STATUS:-} runner=\${WORKSPACE_UPDATE_RUNNER:-}" >> ${JSON.stringify(trail)}\n${extra}exit 0\n`);
  fake('update.sh');
  fake('setup.sh');
  const request = path.join(install, 'requests', 'update.request');
  const ask = action => fs.writeFileSync(request, `${JSON.stringify({ action, requestedAt: new Date().toISOString() })}\n`);
  const run = () => runScript(automationScript('update-runner.sh'), [], { HOME: root, WORKSPACE_DIR: workspace, WORKSPACE_INSTALL_DIR: install });
  const lines = () => (fs.existsSync(trail) ? fs.readFileSync(trail, 'utf8').trim().split('\n').filter(Boolean) : []);
  const statusFile = path.join(install, 'update-status.json');
  return { root, workspace, install, trail, fake, request, ask, run, lines, statusFile };
}

test('WP-D3 update-runner.sh: update면 update.sh --yes 다음 setup.sh, rollback이면 --rollback --yes만, 모르는 action은 아무것도 안 한다', (t) => {
  const fix = runnerFixture(t);
  fix.ask('update');
  assert.equal(fix.run().status, 0);
  assert.deepEqual(fix.lines(), ['update.sh --yes status=1 runner=', 'setup.sh  status= runner=1'],
    'update.sh는 상태 파일을 쓰게, setup.sh는 update 에이전트를 다시 올리지 않게 부른다');
  assert.equal(fs.existsSync(fix.request), false, '요청은 한 번만 처리한다(읽고 지운다)');
  assert.equal(fs.existsSync(path.join(fix.install, 'logs', '.update.lock')), false, '잠금은 풀고 끝난다');
  assert.match(fs.readFileSync(path.join(fix.install, 'logs', 'update.log'), 'utf8'), /update-runner update 종료 \(exit 0\)/);

  fs.writeFileSync(fix.trail, '');
  fix.ask('rollback');
  assert.equal(fix.run().status, 0);
  assert.deepEqual(fix.lines(), ['update.sh --rollback --yes status=1 runner='], '되돌리기는 setup.sh를 부르지 않는다');

  // 모르는 값·다른 모양의 요청은 아무것도 하지 않는다(글자를 명령·경로로 쓰지 않는다)
  fs.writeFileSync(fix.trail, '');
  for (const body of ['{"action":"update; touch pwned","requestedAt":"2026-09-24T00:00:00.000Z"}\n', '{"action":"UPDATE","requestedAt":"2026-09-24T00:00:00.000Z"}\n',
    '{"requestedAt":"2026-09-24T00:00:00.000Z","action":"update","x":1}\n', 'update\n']) {
    fs.writeFileSync(fix.request, body);
    assert.equal(fix.run().status, 0);
    assert.equal(fs.existsSync(fix.request), false, '모양이 틀린 요청은 그 파일만 지운다');
  }
  assert.deepEqual(fix.lines(), []);
  assert.equal(fs.existsSync(path.join(fix.workspace, 'pwned')), false);
  assert.equal(fs.existsSync(fix.statusFile), false, '틀린 요청은 상태 파일도 쓰지 않는다');
  assert.equal(fix.run().status, 0, '요청 파일이 없으면(지운 것도 launchd를 깨운다) 조용히 끝난다');
  assert.deepEqual(fix.lines(), []);
});

test('WP-D3 update-runner.sh: 한 번에 하나만 돌고(살아 있는 실행기가 쥔 잠금은 건너뜀), 죽은 잠금은 치우며, update.sh가 실패를 못 적고 멈추면 한 줄을 남긴다', async (t) => {
  const fix = runnerFixture(t);
  const lock = path.join(fix.install, 'logs', '.update.lock');
  fs.mkdirSync(lock, { recursive: true });
  // 명령줄에 update-runner가 보이는 프로세스 하나를 직접 띄워 잠금 주인으로 삼는다(끝날 때 그 자식만 끝낸다).
  // (`sleep 30; true` — 명령 하나면 bash가 sleep으로 바꿔 끼워 명령줄에서 이름이 사라진다.)
  const holder = spawn('/bin/bash', ['-c', 'sleep 30; true', 'update-runner'], { stdio: 'ignore' });
  t.after(() => { if (holder.exitCode === null) holder.kill(); });
  fs.writeFileSync(path.join(lock, 'pid'), `${holder.pid}\n`);
  for (let i = 0; i < 40 && !/update-runner/.test(spawnSync('ps', ['-o', 'command=', '-p', String(holder.pid)], { encoding: 'utf8' }).stdout); i += 1) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  fix.ask('update');
  assert.equal(fix.run().status, 0);
  assert.deepEqual(fix.lines(), [], '도는 실행기가 있으면 건너뛴다');
  assert.ok(fs.existsSync(fix.request), '건너뛴 요청은 그대로 남는다');
  holder.kill();
  await new Promise(resolve => holder.once('exit', resolve));

  // 주인이 이미 없는 잠금 → 치우고 돈다
  assert.equal(fix.run().status, 0);
  assert.equal(fix.lines().length, 2);
  assert.equal(fs.existsSync(lock), false);

  // update.sh가 상태를 못 쓰고 실패 → 실행기가 고정 문구로 실패를 남기고, setup.sh는 부르지 않는다
  fs.writeFileSync(fix.trail, '');
  fix.fake('update.sh', 'exit 1\n');
  fix.ask('update');
  assert.equal(fix.run().status, 0);
  assert.deepEqual(fix.lines(), ['update.sh --yes status=1 runner=']);
  const failed = JSON.parse(fs.readFileSync(fix.statusFile, 'utf8'));
  assert.equal(failed.state, 'failed');
  assert.equal(failed.action, 'update');
  assert.equal(failed.message, '업데이트를 끝내지 못했어요 — 업데이트.command를 더블클릭해 주세요');

  // update.sh가 스스로 실패를 적었으면 그 이유를 덮어쓰지 않는다
  fix.fake('update.sh', `printf '{"action":"update","state":"failed","message":"새 버전을 받아오지 못했어요","steps":[]}' > ${JSON.stringify(fix.statusFile)}\nexit 1\n`);
  fix.ask('update');
  fix.run();
  assert.equal(JSON.parse(fs.readFileSync(fix.statusFile, 'utf8')).message, '새 버전을 받아오지 못했어요');

  const script = fs.readFileSync(automationScript('update-runner.sh'), 'utf8');
  assert.ok(!/rm -rf|pkill|killall|xargs kill|\bkill\b/.test(script), '지우기는 파일 하나·잠금은 rmdir, 프로세스는 끝내지 않는다');
  assert.match(script, /^main "\$@"; exit \$\?$/m, '본문을 통째로 읽고 시작한다(복사본이 바뀌어도 안전)');
});

test('WP-D3 update.sh: WORKSPACE_UPDATE_STATUS가 있을 때만 단계마다 상태 파일을 쓴다', { skip: !gitReady }, (t) => {
  const fix = updateFixture(t);
  const statusFile = path.join(fix.root, 'install', 'update-status.json');
  assert.equal(fix.run(['--yes']).status, 0);
  assert.equal(fs.existsSync(statusFile), false, '터미널 실행(환경변수 없음)은 아무것도 쓰지 않는다');

  const again = updateFixture(t);
  const againStatus = path.join(again.root, 'install', 'update-status.json');
  const result = again.run(['--yes'], { env: { WORKSPACE_UPDATE_STATUS: '1' } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const done = JSON.parse(fs.readFileSync(againStatus, 'utf8'));
  assert.equal(done.action, 'update');
  assert.equal(done.state, 'done');
  assert.equal(done.from, '1.0.0');
  assert.equal(done.to, '1.1.0');
  assert.equal(done.step, 6);
  assert.deepEqual(done.steps.map(step => step.name), ['고친 파일 확인', '데이터 백업', '새 버전 받기', '데이터 형식 변환', '앱 다시 시작', '잘 떴는지 확인']);
  assert.ok(done.steps.every(step => step.state === 'done'));
  assert.ok(done.finishedAt);
  assert.deepEqual(fs.readdirSync(path.dirname(againStatus)).filter(name => name.includes('.tmp-')), [], '임시 파일을 남기지 않는다');

  // 되돌리기도 네 단계로 적는다
  const back = again.run(['--rollback', '--yes'], { env: { WORKSPACE_UPDATE_STATUS: '1' } });
  assert.equal(back.status, 0, back.stdout + back.stderr);
  const rolled = JSON.parse(fs.readFileSync(againStatus, 'utf8'));
  assert.equal(rolled.action, 'rollback');
  assert.equal(rolled.state, 'done');
  assert.equal(rolled.from, '1.1.0');
  assert.equal(rolled.to, '1.0.0');
  assert.deepEqual(rolled.steps.map(step => step.name), ['코드 되돌리기', '데이터 되돌리기', '앱 다시 시작', '잘 떴는지 확인']);
});

test('WP-D3 update.sh --yes: 6단계에서 앱이 응답하지 않으면 되돌리지 않고 상태 파일에 실패를 남긴다', { skip: !gitReady }, (t) => {
  const fix = updateFixture(t);
  const bin = path.join(fix.root, 'bin-down');
  fs.mkdirSync(bin);
  writeExec(path.join(bin, 'curl'), '#!/bin/bash\necho "{}"\n');
  writeExec(path.join(bin, 'sleep'), '#!/bin/bash\nexit 0\n');
  const result = fix.run(['--yes'], { env: { WORKSPACE_UPDATE_STATUS: '1', PATH: `${bin}:${path.join(fix.root, 'bin')}:${process.env.PATH}` } });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /앱이 응답하지 않아요/);
  assert.doesNotMatch(result.stdout, /이전 버전으로 되돌려요/, '묻지도, 스스로 되돌리지도 않는다');
  assert.equal(fix.versionOf(), '1.1.0', '받은 버전 그대로 둔다 — 사람이 화면에서 되돌리기를 누른다');
  assert.ok(fs.existsSync(path.join(fix.clone, '.workspace-last-good')), '되돌릴 자리는 남겨 둔다');
  const failed = JSON.parse(fs.readFileSync(path.join(fix.root, 'install', 'update-status.json'), 'utf8'));
  assert.equal(failed.state, 'failed');
  assert.equal(failed.step, 6);
  assert.equal(failed.message, '앱이 응답하지 않아요');
  assert.deepEqual(failed.steps.map(step => step.state), ['done', 'done', 'done', 'done', 'done', 'failed']);

  const script = fs.readFileSync(path.join(REPO_ROOT, 'update.sh'), 'utf8');
  const tail = script.slice(script.indexOf('echo "[6/6] 잘 떴는지 확인"'));
  assert.match(tail, /if \[ "\$ASSUME_YES" = "1" \]; then\n  ANSWER="n"/, '--yes는 되돌리기 질문에 n');
  assert.ok(tail.indexOf('status_write failed "앱이 응답하지 않아요"') < tail.indexOf('ANSWER="n"'));
  assert.match(script, /status_write\(\) \{\n  \[ -n "\$\{WORKSPACE_UPDATE_STATUS:-\}" \] \|\| return 0/, '환경변수가 없으면 쓰지 않는다');
  assert.match(script, /cp "\$APP_DIR\/automation\/update-runner\.sh" "\$INSTALL_DIR\/"/, '받은 뒤 실행기 복사본도 갱신한다');
});

// 갓 켜진 서버의 /api/about은 원격(새 버전 확인)을 최대 5초 기다린다 — 회사망이 느리면 2초 제한 10번이 모두 시간 초과였다.
test('WP-S update.sh: ⑥ 점검은 /api/about?cached=1을 5초 제한으로 20번 묻고, 끝내 안 뜨면 사실 한 줄 뒤에 되돌릴지 묻는다', { skip: !gitReady }, (t) => {
  const fix = updateFixture(t);
  const bin = path.join(fix.root, 'bin-slow');
  fs.mkdirSync(bin);
  const calls = path.join(fix.root, 'curl-calls.txt');
  writeExec(path.join(bin, 'curl'), `#!/bin/bash\necho "$*" >> ${JSON.stringify(calls)}\necho "{}"\n`);
  writeExec(path.join(bin, 'sleep'), '#!/bin/bash\nexit 0\n');
  const result = fix.run([], { input: 'n\n', env: { PATH: `${bin}:${path.join(fix.root, 'bin')}:${process.env.PATH}` } });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const lines = fs.readFileSync(calls, 'utf8').trim().split('\n');
  assert.equal(lines.length, 20, '20번 묻는다');
  lines.forEach(line => assert.equal(line, '-s --max-time 5 http://127.0.0.1:4399/api/about?cached=1'));
  const out = result.stdout;
  assert.ok(out.indexOf('앱이 1~2분 안에 뜨지 않았어요.') > out.indexOf('! 앱이 응답하지 않아요'), '사실 한 줄이 먼저');
  // `read -p`의 물음은 터미널일 때만 찍히므로 순서는 스크립트 글자로 본다
  const script = fs.readFileSync(path.join(REPO_ROOT, 'update.sh'), 'utf8');
  assert.match(script, /echo "    앱이 1~2분 안에 뜨지 않았어요\."\n  read -r -p "  이전 버전으로 되돌릴까요\? \[y\/n\] " ANSWER/, '그다음 되돌리기 질문');
  assert.match(out, /그대로 뒀어요\. 되돌리려면:  bash update\.sh --rollback/);
  assert.equal(fix.versionOf(), '1.1.0', 'n이면 받은 버전 그대로');

  // 몇 번 만에 새 버전을 말하면 곧바로 성공(버전 비교는 그대로)
  fs.rmSync(calls);
  writeExec(path.join(bin, 'curl'), `#!/bin/bash\necho "$*" >> ${JSON.stringify(calls)}\n`
    + `[ "$(wc -l < ${JSON.stringify(calls)})" -ge 3 ] && printf '{"version":"%s"}' "$(tr -d '[:space:]' < ${JSON.stringify(path.join(fix.clone, 'VERSION'))})" || echo "{}"\n`);
  const ok = fix.run(['--yes'], { env: { PATH: `${bin}:${path.join(fix.root, 'bin')}:${process.env.PATH}` } });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.equal(fs.readFileSync(calls, 'utf8').trim().split('\n').length, 3);
  assert.doesNotMatch(ok.stdout, /1~2분 안에 뜨지 않았어요/);
});

// setup.sh는 실행하지 않는다 — 조각을 문자열로 확인하고, 마무리 세 줄 조각만 가짜 `open`으로 돌려 본다.
test('WP-D3 setup.sh: update 에이전트를 늘 등록하고(실행기 안에서는 다시 올리지 않음), 남은 일(/mcp)은 Claude 갈래일 때만', (t) => {
  const script = fs.readFileSync(path.join(REPO_ROOT, 'setup.sh'), 'utf8');
  assert.match(script, /<string>\$LABEL\.update<\/string>/);
  assert.match(script, /<string>\$\(xml_escape "\$INSTALL_DIR\/update-runner\.sh"\)<\/string>/);
  assert.match(script, /<string>\$\(xml_escape "\$INSTALL_DIR\/requests\/update\.request"\)<\/string>/);
  const plist = script.slice(script.indexOf('cat > "$AGENTS_DIR/$LABEL.update.plist"'), script.indexOf('# 업무 데이터 백업'));
  assert.match(plist, /<key>RunAtLoad<\/key>\n  <false\/>/);
  const intro = script.slice(script.indexOf('# 앱 안 `업데이트 받기`'), script.indexOf('cat > "$AGENTS_DIR/$LABEL.update.plist"'));
  assert.ok(intro.length > 0 && !/USE_(SLACK|CAL|JIRA|TIRO)/.test(intro), '연동과 무관하게 늘');
  assert.match(script, /"\$APP_DIR\/automation\/update-runner\.sh" "\$INSTALL_DIR\/"/, '실행기도 설치 위치로 복사한다');
  assert.match(script, /\[ "\$\{WORKSPACE_UPDATE_RUNNER:-\}" = "1" \] && IN_RUNNER="update"/);
  assert.match(script, /if \[ "\$IN_RUNNER" = "update" \]; then\n  ok "update 그대로 \(지금 도는 업데이트\)"\nelif/);
  assert.match(script, /\[ "\$f" = "server" \] && \[ -n "\$IN_RUNNER" \] && \[ "\$OLD_SERVER_PLIST" = "\$\(cat "\$plist"\)" \]/,
    '실행기 안에서는 내용이 그대로인 서버를 다시 올리지 않는다(update.sh가 이미 새 코드로 다시 띄웠다)');
  // 남은 일(/mcp)은 Claude 갈래 연동이 켜져 있을 때만 — 지라는 앱이 직접 읽는다
  const connect = script.slice(script.indexOf('CONNECT=""'), script.indexOf('# 마무리.'));
  assert.ok(!connect.includes('USE_JIRA'), '지라는 /mcp가 필요 없다');
  assert.ok(!connect.includes('USE_SLACK'), '슬랙은 앱이 토큰으로 직접 읽는다 — /mcp가 필요 없다');
  assert.match(connect, /if \[ -n "\$CONNECT" \]; then/);

  assert.ok(!/pkill|killall|xargs kill/.test(script));
});

// make-team-installer.sh — 임시 저장소에 스크립트를 복사해 돌린다(origin 주소는 적어 두기만 하고 받지 않는다).
const dittoReady = process.platform === 'darwin' && fs.existsSync('/usr/bin/ditto');
function teamFixture(t, config, { origin = 'https://github.com/someone/workspace.git' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-d3-team-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const out = path.join(root, 'out');
  fs.mkdirSync(repo);
  fs.mkdirSync(out);
  fs.copyFileSync(path.join(REPO_ROOT, 'make-team-installer.sh'), path.join(repo, 'make-team-installer.sh'));
  fs.writeFileSync(path.join(repo, 'workspace.config.json'), JSON.stringify(config, null, 2));
  runGit(repo, ['init', '-q', '-b', 'main']);
  if (origin) runGit(repo, ['remote', 'add', 'origin', origin]);
  const run = () => spawnSync('/bin/bash', [path.join(repo, 'make-team-installer.sh'), out], { encoding: 'utf8', env: { ...process.env, HOME: root } });
  const zip = path.join(out, '워크스페이스-설치.zip');
  const unpack = () => {
    const dir = fs.mkdtempSync(path.join(root, 'unzip-'));
    assert.equal(spawnSync('/usr/bin/ditto', ['-x', '-k', zip, dir]).status, 0);
    const folder = path.join(dir, '워크스페이스-설치');
    return { dir, folder, command: path.join(folder, '설치.command'), readme: path.join(folder, '먼저 읽어 주세요.txt') };
  };
  return { root, repo, out, run, zip, unpack };
}
const TEAM_SECRET_CONFIG = {
  title: '비밀 제목',
  integrations: { slack: true, jira: true, calendar: true },
  slack: { workspaceUrl: 'https://myco.slack.com', appUrl: 'https://api.slack.com/apps/A0SECRETAPP', tokenFile: '~/.config/SECRET-slack-token',
    // 슬랙 연결(자동 갱신) — Client ID만 팀 값이고, 연결 방식·갱신 정보 파일 자리는 사람마다 다르다.
    clientId: '1234567890.9876543210', auth: 'oauth', oauthFile: '~/.config/SECRET-slack-oauth.json',
    channels: { todo: { id: 'C0SECRETCH', name: '#secret-todo' } } },
  jira: { siteUrl: 'https://myco.atlassian.net', email: 'me@secret-mail.test', displayName: '비밀이름', tokenFile: '~/.config/SECRET-jira-token' },
  calendar: { source: 'ical', icalFile: '/secret/ical-file' },
  server: { updateChannel: 'main', extraHost: 'secret-host.ts.net', chromeProfile: 'Profile 9', dockName: 'SecretDock', port: 4999 },
};
const TEAM_SECRETS = /SECRET|secret|비밀|Profile 9|4999|ical|C0SECRETCH/;

test('WP-D3 make-team-installer.sh: 허용 목록 값만 담고(규칙에 어긋난 값은 빼고 알림), zip 안 설치.command는 실행 권한이 있으며, 이미 있으면 덮어쓰지 않는다', { skip: !(gitReady && dittoReady) }, (t) => {
  const fix = teamFixture(t, TEAM_SECRET_CONFIG);
  const tmpBase = process.env.TMPDIR || '/tmp';
  const tmpBefore = new Set(fs.readdirSync(tmpBase).filter(n => n.startsWith('workspace-team-installer.')));
  const made = fix.run();
  assert.equal(made.status, 0, made.stdout + made.stderr);
  assert.ok(fs.existsSync(fix.zip));
  const tmpLeftover = fs.readdirSync(tmpBase).filter(n => n.startsWith('workspace-team-installer.') && !tmpBefore.has(n));
  assert.deepEqual(tmpLeftover, [], '임시 폴더는 rm -rf 없이도 남지 않는다');
  assert.match(made.stdout, /저장소 : https:\/\/github\.com\/someone\/workspace\.git/);
  assert.match(made.stdout, /slack\.workspaceUrl = https:\/\/myco\.slack\.com/);
  assert.match(made.stdout, /slack\.appUrl = https:\/\/api\.slack\.com\/apps\/A0SECRETAPP/);
  assert.match(made.stdout, /jira\.siteUrl = https:\/\/myco\.atlassian\.net/);
  assert.match(made.stdout, /server\.updateChannel = stable/, '내 설정이 main이어도 팀은 stable');
  assert.doesNotMatch(made.stdout.replace(/A0SECRETAPP/g, ''), TEAM_SECRETS, '화면에 보여 주는 값도 허용 목록뿐');

  const { command, readme } = fix.unpack();
  assert.ok(fs.statSync(command).mode & 0o100, 'zip을 풀어도 실행 권한이 남아 있다');
  assert.deepEqual(fs.readdirSync(path.dirname(command)), ['설치.command'], 'zip에는 설치 파일 하나뿐 — 설명서 파일은 넣지 않는다(앱이 바뀌어도 다시 만들지 않게)');
  assert.match(made.stdout, /보낼 문구[\s\S]*bash 를 치고[\s\S]*「설치하기」/, '여는 법은 같이 보낼 문구로 보여 준다');
  const text = fs.readFileSync(command, 'utf8');
  assert.equal(spawnSync('/bin/bash', ['-n', command]).status, 0, '생성된 파일은 bash 문법이 맞다');
  const team = JSON.parse(/^TEAM_CONFIG='(.*)'$/m.exec(text)[1]);
  assert.deepEqual(team, {
    slack: { workspaceUrl: 'https://myco.slack.com', appUrl: 'https://api.slack.com/apps/A0SECRETAPP', clientId: '1234567890.9876543210' },
    jira: { siteUrl: 'https://myco.atlassian.net' },
    server: { updateChannel: 'stable' },
  }, '허용 목록 다섯 칸만');
  assert.match(made.stdout, /slack\.clientId = 1234567890\.9876543210/);
  assert.doesNotMatch(text, /oauth|refresh|xox[a-z]/i, '연결 방식·갱신 정보·토큰은 묶음에 없다');
  assert.doesNotMatch(text.replace(/A0SECRETAPP/g, ''), TEAM_SECRETS, '토큰·토큰 파일·이메일·이름·채널·extraHost·chromeProfile·제목·Dock 이름·캘린더·포트는 없다');
  assert.doesNotMatch(text, /me@|tokenFile|displayName|extraHost|chromeProfile|dockName|icalFile|channels/);
  assert.match(text, /^REPO_URL='https:\/\/github\.com\/someone\/workspace\.git'$/m);
  assert.match(text, /^CHANNEL='stable'$/m);

  // 같은 이름이 이미 있으면 멈추고 그대로 둔다
  const before = fs.statSync(fix.zip).mtimeMs;
  const again = fix.run();
  assert.equal(again.status, 1);
  assert.match(again.stdout, /이미 있어요 — 옮기거나 이름을 바꾼 뒤 다시 실행해 주세요\(덮어쓰지 않아요\)/);
  assert.equal(fs.statSync(fix.zip).mtimeMs, before);

  // 규칙에 어긋난 값은 그 값만 뺀다
  const odd = teamFixture(t, { slack: { workspaceUrl: 'http://myco.slack.com', appUrl: 'https://evil.test/apps/A1' }, jira: { siteUrl: 'https://myco.atlassian.net.evil.test' }, server: { updateChannel: 'nightly' } });
  const oddRun = odd.run();
  assert.equal(oddRun.status, 0, oddRun.stdout + oddRun.stderr);
  for (const key of ['slack\\.workspaceUrl', 'slack\\.appUrl', 'jira\\.siteUrl']) {
    assert.match(oddRun.stdout, new RegExp(`! ${key} — 규칙에 맞지 않아 뺐어요`));
  }
  const oddText = fs.readFileSync(odd.unpack().command, 'utf8');
  assert.deepEqual(JSON.parse(/^TEAM_CONFIG='(.*)'$/m.exec(oddText)[1]), { server: { updateChannel: 'stable' } }, '갈래가 없거나 이상하면 stable');
  assert.doesNotMatch(oddText, /evil|http:\/\/myco/);

  // 저장소 주소는 github.com https만
  const ssh = teamFixture(t, {}, { origin: 'git@github.com:someone/workspace.git' });
  const sshRun = ssh.run();
  assert.equal(sshRun.status, 1);
  assert.match(sshRun.stdout, /origin이 https:\/\/github\.com\/… 주소가 아니에요/);
  assert.equal(fs.existsSync(ssh.zip), false);

  const script = fs.readFileSync(path.join(REPO_ROOT, 'make-team-installer.sh'), 'utf8');
  assert.ok(!/rm -rf|pkill|killall|xargs kill/.test(script));
  assert.match(script, /ditto -c -k --sequesterRsrc --keepParent/);
});

test('WP-D3 설치.command: 새로 받기 · 이미 같은 저장소면 이어 가기 · 다른 폴더면 멈춤 · 설정은 빈 팀 칸만 채움 · node가 없으면 안내', { skip: !(gitReady && dittoReady) }, (t) => {
  const fix = teamFixture(t, { slack: { workspaceUrl: 'https://myco.slack.com' }, jira: { siteUrl: 'https://myco.atlassian.net' }, server: { updateChannel: 'stable' } });
  assert.equal(fix.run().status, 0);
  const { command } = fix.unpack();

  // 가짜 git — clone이면 폴더와 .git, 이 앱의 예시 설정·가짜 setup.sh를 둔다. 네트워크에 닿지 않는다.
  const bin = path.join(fix.root, 'fakebin');
  const trail = path.join(fix.root, 'git-trail.txt');
  const seed = path.join(fix.root, 'seed');
  fs.mkdirSync(bin);
  fs.mkdirSync(seed);
  fs.copyFileSync(path.join(REPO_ROOT, 'workspace.config.example.json'), path.join(seed, 'workspace.config.example.json'));
  writeExec(path.join(seed, 'setup.sh'), `#!/bin/bash\necho "setup $(pwd -P) open=\${WORKSPACE_OPEN_APP:-}" >> ${JSON.stringify(trail)}\n`);
  writeExec(path.join(seed, 'update.sh'), `#!/bin/bash\necho "update $(pwd -P)" >> ${JSON.stringify(trail)}\n`);
  writeExec(path.join(bin, 'git'), `#!/bin/bash
echo "git $*" >> ${JSON.stringify(trail)}
case "$1" in
  --version) echo "git version 2.0-fake" ;;
  clone) shift; [ "$1" = "--quiet" ] && shift; mkdir -p "$2/.git"; echo "$1" > "$2/.git/origin-url"; cp ${JSON.stringify(seed)}/* "$2/" ;;
  -C) dir="$2"; shift 2
      case "$1" in
        remote) cat "$dir/.git/origin-url" 2>/dev/null || exit 2 ;;
        tag) printf 'v1.2.0\\nv1.10.0\\nv1.9.3\\n' ;;
        checkout) : ;;
        *) exit 1 ;;
      esac ;;
  *) exit 1 ;;
esac
`);
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const install = (home, pathValue = `${bin}:/usr/bin:/bin`, extra = {}) => spawnSync('/bin/bash', [command], { encoding: 'utf8', input: '', env: { HOME: home, PATH: pathValue, TMPDIR: os.tmpdir(), ...extra } });
  const log = () => (fs.existsSync(trail) ? fs.readFileSync(trail, 'utf8') : '');

  // 1) 새로 받기 — stable이면 가장 높은 태그(v1.10.0)로, 설정은 예시 + 팀 값, 끝에 WORKSPACE_OPEN_APP=1 setup.sh
  const home = path.join(fix.root, 'home1');
  fs.mkdirSync(home);
  const fresh = install(home);
  assert.equal(fresh.status, 0, fresh.stdout + fresh.stderr);
  const target = path.join(home, 'workspace');
  assert.match(log(), /git clone --quiet https:\/\/github\.com\/someone\/workspace\.git /);
  assert.match(log(), /checkout --detach --quiet v1\.10\.0/, '숫자로 가장 높은 태그');
  assert.ok(log().includes(`setup ${fs.realpathSync(target)} open=1`), log());
  assert.doesNotMatch(log(), /^update /m, '새로 받은 것은 업데이트하지 않는다');
  const config = JSON.parse(fs.readFileSync(path.join(target, 'workspace.config.json'), 'utf8'));
  assert.equal(config.slack.workspaceUrl, 'https://myco.slack.com', '예시의 자리 표시를 팀 값으로');
  assert.equal(config.jira.siteUrl, 'https://myco.atlassian.net');
  assert.equal(config.server.updateChannel, 'stable');
  assert.equal(config.jira.email, '나@내회사.com', '팀 값이 아닌 칸은 예시 그대로');
  assert.ok(config.title.endsWith('워크스페이스'));

  // 2) 이미 같은 저장소 — 새로 받지 않고, 설정은 비어 있는(또는 자리 표시) 팀 칸만 채운다
  fs.writeFileSync(trail, '');
  fs.writeFileSync(path.join(target, 'workspace.config.json'), JSON.stringify({ title: '내 제목', slack: { workspaceUrl: 'https://other.slack.com' }, jira: { siteUrl: '' }, server: { port: 4400 } }));
  const resume = install(home);
  assert.equal(resume.status, 0, resume.stdout + resume.stderr);
  assert.doesNotMatch(log(), /git clone/);
  assert.match(resume.stdout, /이미 받아 뒀어요 — 그대로 이어서 설치해요/);
  const kept = JSON.parse(fs.readFileSync(path.join(target, 'workspace.config.json'), 'utf8'));
  assert.deepEqual(kept, { title: '내 제목', slack: { workspaceUrl: 'https://other.slack.com' }, jira: { siteUrl: 'https://myco.atlassian.net' }, server: { port: 4400, updateChannel: 'stable' } });
  assert.match(log(), /^setup .* open=1/m, '설치가 덜 끝난 폴더면 setup.sh만 마저 한다');
  assert.doesNotMatch(log(), /^update /m, 'workspace.env가 없으면(설치 미완) 업데이트부터 하지 않는다');

  // 3) ~/workspace에 다른 것이 있으면 멈춘다(아무것도 부르지 않는다)
  fs.writeFileSync(trail, '');
  const other = path.join(fix.root, 'home2');
  fs.mkdirSync(path.join(other, 'workspace'), { recursive: true });
  fs.writeFileSync(path.join(other, 'workspace', 'memo.txt'), '내 파일\n');
  const blocked = install(other);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stdout, /~\/workspace가 이미 있어요 — 이름을 바꾼 뒤 다시 실행해 주세요/);
  assert.doesNotMatch(log(), /git clone|setup /);
  assert.deepEqual(fs.readdirSync(path.join(other, 'workspace')), ['memo.txt']);
  // 한글 로케일(UTF-8)에서도 안내 문구의 경로가 사라지지 않는다(`$SHOWN가`처럼 변수 바로 뒤에 한글을 붙이면 bash가 이름으로 읽는다)
  for (const locale of ['ko_KR.UTF-8', 'en_US.UTF-8']) {
    const localized = install(other, `${bin}:/usr/bin:/bin`, { LC_ALL: locale, LANG: locale });
    assert.equal(localized.status, 1, locale);
    assert.match(localized.stdout, /~\/workspace가 이미 있어요 — 이름을 바꾼 뒤 다시 실행해 주세요/, `${locale}: ${localized.stdout}`);
  }
  assert.doesNotMatch(log(), /git clone|setup /);

  // 4) node가 없으면 설치 방법 한 줄을 알리고 멈춘다
  const bare = path.join(fix.root, 'bare-bin');
  fs.mkdirSync(bare);
  fs.symlinkSync(path.join(bin, 'git'), path.join(bare, 'git'));
  const home3 = path.join(fix.root, 'home3');
  fs.mkdirSync(home3);
  const noNode = install(home3, `${bare}:/usr/bin:/bin`);
  assert.equal(noNode.status, 1);
  assert.match(noNode.stdout, /Node가 없어요 — https:\/\/nodejs\.org 에서 LTS를 설치한 뒤/);
  assert.equal(fs.existsSync(path.join(home3, 'workspace')), false);
  const text = fs.readFileSync(command, 'utf8');
  assert.match(text, /xcode-select --install/);
  assert.match(text, /WORKSPACE_OPEN_APP=1 bash setup\.sh/);
});

test('WP-H 설치.command: 기존 설치(workspace.env)가 있으면 새로 받지 않고 그 폴더에서 update.sh → setup.sh · ~/workspace에 한 벌 더 있으면 멈춤 · env가 없는 폴더면 새 설치', { skip: !(gitReady && dittoReady) }, (t) => {
  const fix = teamFixture(t, { slack: { workspaceUrl: 'https://myco.slack.com' }, jira: { siteUrl: 'https://myco.atlassian.net' }, server: { updateChannel: 'stable' } });
  assert.equal(fix.run().status, 0);
  const { command } = fix.unpack();

  // 가짜 git(네트워크 없음)·가짜 update.sh/setup.sh — 부른 순서와 위치만 적는다.
  const bin = path.join(fix.root, 'fakebin');
  const trail = path.join(fix.root, 'trail.txt');
  const seed = path.join(fix.root, 'seed');
  fs.mkdirSync(bin);
  fs.mkdirSync(seed);
  fs.copyFileSync(path.join(REPO_ROOT, 'workspace.config.example.json'), path.join(seed, 'workspace.config.example.json'));
  writeExec(path.join(seed, 'setup.sh'), `#!/bin/bash\necho "setup $(pwd -P) open=\${WORKSPACE_OPEN_APP:-}" >> ${JSON.stringify(trail)}\n`);
  writeExec(path.join(seed, 'update.sh'), `#!/bin/bash\necho "update $(pwd -P)" >> ${JSON.stringify(trail)}\n`);
  writeExec(path.join(bin, 'git'), `#!/bin/bash
echo "git $*" >> ${JSON.stringify(trail)}
case "$1" in
  --version) echo "git version 2.0-fake" ;;
  clone) shift; [ "$1" = "--quiet" ] && shift; mkdir -p "$2/.git"; echo "$1" > "$2/.git/origin-url"; cp ${JSON.stringify(seed)}/* "$2/" ;;
  -C) dir="$2"; shift 2
      case "$1" in
        remote) cat "$dir/.git/origin-url" 2>/dev/null || exit 2 ;;
        tag) printf 'v1.2.0\\n' ;;
        checkout) : ;;
        *) exit 1 ;;
      esac ;;
  *) exit 1 ;;
esac
`);
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const install = (home, extra = {}) => spawnSync('/bin/bash', [command], { encoding: 'utf8', input: '', env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, TMPDIR: os.tmpdir(), ...extra } });
  const log = () => (fs.existsSync(trail) ? fs.readFileSync(trail, 'utf8') : '');
  const lines = (prefix) => log().split('\n').filter(l => /^(update|setup) /.test(l)).map(l => l.replace(prefix, '<>'));
  // 이 저장소를 받아 둔 폴더(clone과 같은 모양)를 만든다.
  const makeCopy = (dir, origin = 'https://github.com/someone/workspace') => {
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'origin-url'), origin + '\n');
    for (const f of fs.readdirSync(seed)) fs.copyFileSync(path.join(seed, f), path.join(dir, f));
    fs.writeFileSync(path.join(dir, 'workspace.config.json'), JSON.stringify({ title: '쓰던 제목', jira: { siteUrl: '' } }));
    fs.writeFileSync(path.join(dir, 'tasks.md'), '쓰던 데이터\n');
  };
  const newHome = (name, envDir) => {
    const home = path.join(fix.root, name);
    fs.mkdirSync(home);
    if (envDir !== undefined) {
      const envDirPath = path.join(home, '.local', 'share', 'workspace-automation');
      fs.mkdirSync(envDirPath, { recursive: true });
      fs.writeFileSync(path.join(envDirPath, 'workspace.env'), `WORKSPACE_DIR="${envDir}"\n`);
    }
    return fs.realpathSync(home);
  };

  // (a) 다른 폴더에 설치돼 있음 → clone 없음, 그 폴더에서 update.sh → setup.sh, 빈 팀 칸만 채움
  fs.writeFileSync(trail, '');
  let home = newHome('home-a', '');
  const elsewhere = path.join(home, 'Projects', 'my-app');
  makeCopy(elsewhere);
  fs.writeFileSync(path.join(home, '.local/share/workspace-automation/workspace.env'), `WORKSPACE_DIR="${elsewhere}"\n`);
  let run = install(home);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /✓ 이미 설치돼 있어요\(~\/Projects\/my-app\) — 업데이트로 진행할게요/);
  assert.doesNotMatch(log(), /git clone/);
  assert.equal(fs.existsSync(path.join(home, 'workspace')), false, '~/workspace를 새로 만들지 않는다');
  assert.deepEqual(lines(elsewhere), ['update <>', 'setup <> open=1']);
  const filled = JSON.parse(fs.readFileSync(path.join(elsewhere, 'workspace.config.json'), 'utf8'));
  assert.equal(filled.title, '쓰던 제목');
  assert.equal(filled.jira.siteUrl, 'https://myco.atlassian.net', '빈 팀 칸은 채운다');
  assert.equal(fs.readFileSync(path.join(elsewhere, 'tasks.md'), 'utf8'), '쓰던 데이터\n');

  // (b) ~/workspace에 설치돼 있음 → update.sh → setup.sh
  fs.writeFileSync(trail, '');
  home = newHome('home-b', '');
  const ws = path.join(home, 'workspace');
  makeCopy(ws);
  fs.writeFileSync(path.join(home, '.local/share/workspace-automation/workspace.env'), `WORKSPACE_DIR="${ws}"\n`);
  run = install(home);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /이미 설치돼 있어요\(~\/workspace\) — 업데이트로 진행할게요/);
  assert.doesNotMatch(log(), /git clone/);
  assert.deepEqual(lines(ws), ['update <>', 'setup <> open=1']);

  // (c) 기존 설치 + ~/workspace에 이 앱이 한 벌 더 → 아무것도 부르지 않고 안내, 종료 코드 1(한글 로케일 포함)
  home = newHome('home-c', '');
  const old = path.join(home, 'playio', 'workspace');
  makeCopy(old);
  makeCopy(path.join(home, 'workspace'));
  fs.writeFileSync(path.join(home, '.local/share/workspace-automation/workspace.env'), `WORKSPACE_DIR="${old}"\n`);
  const configBefore = fs.readFileSync(path.join(old, 'workspace.config.json'), 'utf8');
  for (const locale of [null, 'ko_KR.UTF-8', 'en_US.UTF-8']) {
    fs.writeFileSync(trail, '');
    run = install(home, locale ? { LC_ALL: locale, LANG: locale } : {});
    assert.equal(run.status, 1, `${locale}: ${run.stdout}`);
    assert.match(run.stdout, /✗ 이미 설치된 앱\(~\/playio\/workspace\)과 ~\/workspace에 한 벌이 더 있어요\. 쓰던 데이터는 ~\/playio\/workspace에 있어요\. ~\/workspace 폴더 이름을 바꾼 뒤\(예: workspace-old\) 다시 열어 주세요\./, `${locale}: ${run.stdout}`);
    assert.doesNotMatch(run.stdout, /업데이트로 진행할게요/);
    assert.doesNotMatch(log(), /git clone|^update |^setup /m);
  }
  assert.equal(fs.readFileSync(path.join(old, 'workspace.config.json'), 'utf8'), configBefore, '설정도 건드리지 않는다');

  // (b') ~/workspace가 기존 설치를 가리키는 링크면 같은 폴더로 본다
  fs.writeFileSync(trail, '');
  home = newHome('home-link', '');
  const real = path.join(home, 'real-app');
  makeCopy(real);
  fs.symlinkSync(real, path.join(home, 'workspace'));
  fs.writeFileSync(path.join(home, '.local/share/workspace-automation/workspace.env'), `WORKSPACE_DIR="${real}"\n`);
  run = install(home);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.deepEqual(lines(real), ['update <>', 'setup <> open=1']);

  // (e) workspace.env가 없는 폴더를 가리킴 → 새 설치(update.sh 없음)
  fs.writeFileSync(trail, '');
  home = newHome('home-e', path.join(fix.root, 'gone'));
  run = install(home);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(log(), /git clone --quiet /);
  assert.deepEqual(lines(path.join(home, 'workspace')), ['setup <> open=1']);

  // (e') 가리키는 폴더가 다른 저장소면 기존 설치로 보지 않는다 → 새 설치
  fs.writeFileSync(trail, '');
  home = newHome('home-e2', '');
  const foreign = path.join(home, 'other-repo');
  makeCopy(foreign, 'https://github.com/else/thing');
  fs.writeFileSync(path.join(home, '.local/share/workspace-automation/workspace.env'), `WORKSPACE_DIR="${foreign}"\n`);
  run = install(home);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(log(), /git clone --quiet /);
  assert.doesNotMatch(log(), /^update /m);

  // workspace.env는 실행하지 않는다(글자로 한 줄만 읽는다)
  fs.writeFileSync(trail, '');
  home = newHome('home-inject', '');
  const marker = path.join(fix.root, 'injected');
  fs.writeFileSync(path.join(home, '.local/share/workspace-automation/workspace.env'), `WORKSPACE_DIR="$(touch ${marker})"\ntouch ${marker}\n`);
  run = install(home);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(fs.existsSync(marker), false, 'workspace.env 안의 명령은 돌지 않는다');

  const text = fs.readFileSync(command, 'utf8');
  assert.ok(!/rm -rf|pkill|killall|xargs kill|\. "\$ENV_FILE"|^\s*(source|\.) /m.test(text));
});

test('QA update-runner.sh: update.sh가 실패를 못 적고 멈추면 멈춘 단계 번호(숫자만)를 이어 적는다', (t) => {
  const fix = runnerFixture(t);
  fix.fake('update.sh', `printf '{"action":"update","step":4,"state":"running","steps":[]}' > ${JSON.stringify(fix.statusFile)}\nexit 1\n`);
  fix.ask('update');
  assert.equal(fix.run().status, 0);
  const failed = JSON.parse(fs.readFileSync(fix.statusFile, 'utf8'));
  assert.equal(failed.state, 'failed');
  assert.equal(failed.step, 4, '③ 이후에서 멈췄다는 것이 남아야 화면이 되돌리기를 보여 준다');
  // 상태 파일이 없거나 단계가 이상하면 0
  fix.fake('update.sh', 'exit 1\n');
  fix.ask('update');
  fix.run();
  assert.equal(JSON.parse(fs.readFileSync(fix.statusFile, 'utf8')).step, 0);
  fix.fake('update.sh', `printf '{"action":"update","step":"4; touch pwned","state":"running"}' > ${JSON.stringify(fix.statusFile)}\nexit 1\n`);
  fix.ask('update');
  fix.run();
  assert.equal(JSON.parse(fs.readFileSync(fix.statusFile, 'utf8')).step, 0);
  assert.equal(fs.existsSync(path.join(fix.workspace, 'pwned')), false);
});

// slack-capture.sh를 임시 HOME에서 끝까지 돌린다. 슬랙·앱 서버·Claude 어디에도 닿지 않는다:
//  - `NODE_OPTIONS=--require 가짜-fetch.js`로 node의 fetch를 바꿔 끼운다(slack-collect.js와 import-record.js 둘 다).
//    슬랙 응답·앱 응답은 spec 파일에서 읽고, 요청은 전부 기록한다. 그 밖의 주소는 곧바로 오류다(네트워크 없음).
//  - Claude는 가짜 실행 파일(CLAUDE_BIN)이다 — 받은 인자를 적어 두고, 입력 JSON을 보고 정해진 답을 낸다.
//  - 진짜 slack-collect.js·slack-history.js·import-record.js·지침 파일·run-task.sh를 임시 폴더에 복사해 쓴다.
const SLACK_TOKEN = 'xoxp-SECRET-FIXTURE-TOKEN';
function captureFixture(t, config, stateJson) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-wpe-capture-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const bin = path.join(home, '.nvm', 'versions', 'node', 'v0', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const app = placeCollector(home);
  const skills = path.join(home, '.claude', 'skills');
  fs.mkdirSync(skills, { recursive: true });
  for (const name of ['slack-todos.md', 'slack-alignments.md', 'slack-someday.md', 'slack-waiting.md']) fs.copyFileSync(path.join(REPO_ROOT, '.claude', 'skills', name), path.join(skills, name));
  if (stateJson) fs.writeFileSync(path.join(app, '.slack_capture_state.json'), JSON.stringify(stateJson));
  fs.writeFileSync(path.join(home, 'VERSION'), '9.9.9\n');
  const install = path.join(home, '.local', 'share', 'workspace-automation');
  fs.mkdirSync(install, { recursive: true });
  fs.copyFileSync(automationScript('run-task.sh'), path.join(install, 'run-task.sh'));

  const specFile = path.join(home, 'fake-spec.json');
  const requestLog = path.join(home, 'requests.log');
  const preload = path.join(home, 'fake-fetch.js');
  fs.writeFileSync(preload, `
const fs = require('fs');
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const spec = JSON.parse(fs.readFileSync(process.env.FAKE_FETCH_SPEC, 'utf8'));
  const headers = init.headers || {};
  fs.appendFileSync(process.env.FAKE_FETCH_LOG, JSON.stringify({ url: String(input), auth: headers.Authorization === 'Bearer ' + process.env.FAKE_SLACK_TOKEN, body: init.body ? (String(init.body).startsWith('{') ? JSON.parse(init.body) : { grant: new URLSearchParams(String(init.body)).get('grant_type') }) : null }) + '\\n');
  const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
  if (url.hostname === 'slack.com') {
    const method = url.pathname.replace('/api/', '');
    // 토큰 갱신(새 방식) — spec.refresh가 응답 본문이고, status만 있으면 그 HTTP 상태로 답한다.
    if (method === 'oauth.v2.access') {
      if (!spec.refresh) throw new Error('네트워크 금지: 갱신');
      return spec.refresh.status ? reply({}, spec.refresh.status) : reply(spec.refresh);
    }
    // spec.rejected에 든 토큰으로 온 요청은 슬랙이 거절한다(만료).
    if ((spec.rejected || []).some(one => headers.Authorization === 'Bearer ' + one)) return reply({ ok: false, error: 'token_expired' });
    if (method === 'conversations.history') {
      const found = (spec.history || {})[url.searchParams.get('channel')] || [];
      return Array.isArray(found) ? reply({ ok: true, messages: found, has_more: false }) : reply({ ok: false, error: found.error });
    }
    if (method === 'conversations.replies') {
      const found = (spec.replies || {})[url.searchParams.get('channel') + ':' + url.searchParams.get('ts')];
      return found ? reply({ ok: true, messages: found }) : reply({ ok: false, error: 'channel_not_found' });
    }
    if (method === 'users.info') {
      const name = (spec.users || {})[url.searchParams.get('user')];
      return name ? reply({ ok: true, user: { name, profile: { display_name: name } } }) : reply({ ok: false, error: 'user_not_found' });
    }
  }
  if (url.hostname === '127.0.0.1') {
    if (url.pathname === '/api/items') return reply(spec.items || { reportRefs: {}, jiraIssues: [] });
    if (url.pathname === '/api/import') {
      const body = JSON.parse(init.body);
      if (body.kind === 'item' && (spec.failItems || []).includes(body.payload.description)) return reply({ ok: false, error: '저장 실패' }, 400);
      if (body.kind === 'item' && (spec.dupLinks || []).includes(body.payload.permalink)) return reply({ ok: true, duplicate: true, id: 'old' });
      return reply({ ok: true, id: 'new' });
    }
  }
  throw new Error('네트워크 금지: ' + url.hostname);
};
`);
  const calls = path.join(home, 'claude-calls.log');
  const claude = path.join(home, 'fake-claude');
  // 가짜 Claude: 메시지마다 한 줄 — 원본을 못 읽은 공유는 표시를 붙이고, 글이 'SKIP'이면 비슷한 일로 건너뛴다.
  writeExec(claude, `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CLAUDE_CALLS, JSON.stringify(args) + '\\n');
const mode = process.env.FAKE_CLAUDE_MODE || '';
if (mode === 'garbage') { process.stdout.write('할 일 2개를 저장했어요!'); process.exit(0); }
if (mode === 'exit') { process.stderr.write('로그인 만료'); process.exit(3); }
const prompt = args[args.indexOf('-p') + 1];
const input = JSON.parse(prompt.slice(prompt.indexOf('## 입력 JSON\\n') + '## 입력 JSON\\n'.length));
const items = [], skipped = [];
for (const m of input.messages) {
  if (m.text === 'SKIP') { skipped.push({ ts: m.ts, reason: '비슷한 일', existing: '이미 있는 일' }); continue; }
  if (m.kind === 'share') {
    for (const s of m.shares) items.push(s.threadError
      ? { ts: m.ts, description: '원본 못 읽은 일 ' + m.ts, permalink: s.permalink, notes: ['원본 못 읽음'] }
      : { ts: m.ts, description: '공유된 일 ' + m.ts, permalink: s.permalink });
  } else items.push({ ts: m.ts, description: '할 일 ' + m.ts, permalink: m.permalink });
}
const answer = JSON.stringify({ items: mode === 'badlink' ? items.map(one => ({ ...one, permalink: 'https://evil.example/x' })) : items, skipped });
process.stdout.write(mode === 'fence' ? '\`\`\`json\\n' + answer + '\\n\`\`\`\\n' : answer + '\\n');
`);
  fs.writeFileSync(path.join(home, 'token'), `${SLACK_TOKEN}\n`);
  const configPath = path.join(home, 'workspace.config.json');
  fs.writeFileSync(configPath, JSON.stringify({ ...config, slack: { tokenFile: path.join(home, 'token'), workspaceUrl: 'https://team.slack.com', ...config.slack } }));
  const logs = path.join(home, 'logs');
  let spec = {};
  const setSlack = next => { spec = next; fs.writeFileSync(specFile, JSON.stringify(spec)); };
  setSlack({});
  const run = (env = {}) => {
    for (const file of [requestLog, calls]) fs.rmSync(file, { force: true });
    return runScript(automationScript('slack-capture.sh'), [], {
      // 토큰 폴더 끼우기(공용 준비의 WORKSPACE_TOKEN_DIR)는 비운다 — launchd가 돌릴 때처럼 설정의 경로와 (임시) HOME의 ~/.config를 본다.
      HOME: home, WORKSPACE_TOKEN_DIR: '', WORKSPACE_DIR: home, WORKSPACE_CONFIG: configPath, AUTOMATION_LOG_DIR: logs, SLACK_CAPTURE_IGNORE_HOURS: '1',
      WORKSPACE_PORT: '4322', CLAUDE_BIN: claude, WORKSPACE_CLAUDE_TOKEN_FILE: path.join(home, 'no-claude-token'),
      NODE_OPTIONS: `--require ${preload}`, FAKE_FETCH_SPEC: specFile, FAKE_FETCH_LOG: requestLog, FAKE_CLAUDE_CALLS: calls, FAKE_SLACK_TOKEN: SLACK_TOKEN,
      ...env,
    });
  };
  const lines = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []);
  const requests = () => lines(requestLog);
  const urls = () => requests().filter(one => one.url.includes('conversations.history')).map(one => one.url);
  const imports = kind => requests().filter(one => one.url.endsWith('/api/import') && one.body.kind === kind).map(one => one.body.payload);
  const claudeCalls = () => lines(calls);
  const promptOf = call => call[call.indexOf('-p') + 1];
  const inputOf = call => { const prompt = promptOf(call); return JSON.parse(prompt.slice(prompt.indexOf('## 입력 JSON\n') + '## 입력 JSON\n'.length)); };
  const logText = () => fs.readFileSync(path.join(logs, 'slack-capture.log'), 'utf8');
  const allLogs = () => (fs.existsSync(logs) ? fs.readdirSync(logs).filter(name => name.endsWith('.log')).map(name => fs.readFileSync(path.join(logs, name), 'utf8')).join('\n') : '');
  return { home, run, urls, requests, imports, claudeCalls, promptOf, inputOf, logText, allLogs, setSlack };
}
// 서버 parseAutomationLog과 같은 규칙(시작/종료 줄 사이 = 한 실행, 밖의 시각 줄 = 한 줄 기록)으로 마지막 기록을 읽는다.
function lastLogEvent(text) {
  const startRe = /^─+ (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \S+ 시작(?: \(v[0-9A-Za-z.+-]{1,20}\))?$/;
  const endRe = /^─+ (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \S+ 종료 \(exit (-?\d+)\)$/;
  const plainRe = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (.+)$/;
  const events = [];
  let block = null;
  text.split('\n').forEach(line => {
    if (startRe.test(line)) { block = []; return; }
    const end = endRe.exec(line);
    if (end) { events.push({ kind: Number(end[2]) === 0 ? 'run' : 'fail', text: (block || []).join(' ').replace(/\s+/g, ' ').trim() }); block = null; return; }
    if (block) { block.push(line); return; }
    const plain = plainRe.exec(line);
    if (plain) events.push({ kind: plain[2].includes('채널 확인 실패') ? 'fail' : 'skip', text: plain[2] });
  });
  return events[events.length - 1];
}
const TODO_ONLY = { slack: { channels: { todo: { id: 'C0TODO11', name: '#my-todo' } } } };
const memo = (ts, text) => ({ type: 'message', user: 'U0ME', ts, text });

test('WP-E slack-capture.sh: 뺀 채널(off)은 읽지도 Claude에 넘기지도 않고, 어디서부터는 커서와 since 중 큰 값이다', (t) => {
  const fix = captureFixture(t, { slack: { channels: {
    todo: { id: 'C0TODO11', name: '#my-todo', since: '1790000000.000000' },
    align: { id: 'C0ALIGN1', name: '#my-align', off: true },
    waiting: { id: 'C0WAIT11', name: '#my-waiting', since: '1780000000.000000' },
    someday: { id: 'C0SOME11', name: '#my-someday' },
  } } }, { 'my-todo': '1789999999.999999', 'my-waiting': '1790000500.000100' });
  const quiet = fix.run();
  assert.equal(quiet.status, 0, quiet.stderr + fix.logText());
  const urls = fix.urls();
  assert.equal(urls.length, 3, '뺀 채널은 부르지 않는다');
  assert.ok(!urls.some(url => url.includes('C0ALIGN1')));
  assert.ok(urls.includes('https://slack.com/api/conversations.history?channel=C0TODO11&limit=100&oldest=1790000000.000000'), 'since가 커서보다 뒤면 since부터');
  assert.ok(urls.includes('https://slack.com/api/conversations.history?channel=C0WAIT11&limit=100&oldest=1790000500.000100'), '커서가 뒤면 커서부터');
  assert.ok(urls.includes('https://slack.com/api/conversations.history?channel=C0SOME11&limit=100'), 'since도 커서도 없으면 예전처럼');
  assert.ok(fix.requests().filter(one => one.url.startsWith('https://slack.com/')).every(one => one.auth), '슬랙 요청은 토큰을 머리글로만 보낸다');
  assert.deepEqual(fix.claudeCalls(), [], '새 메시지가 없으면 Claude를 부르지 않는다');
  assert.deepEqual(fix.imports('health'), [{ success: true }]);

  // 앱 API의 응답({"ok":true})은 로그에 남지 않는다 — 다음 줄이 그 뒤에 붙어 "마지막 실행"을 못 읽던 원인
  const log = fix.logText();
  assert.ok(!log.includes('{"ok":true}'), log);
  assert.match(log, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} 새 메시지 없음 — Claude 호출 생략$/m);

  // 새 메시지가 있으면 켜 둔 채널마다 그 채널의 지침만 넣어 부른다(뺀 채널의 지침은 넘기지 않는다)
  fix.setSlack({ history: { C0TODO11: [memo('1790000600.000100', '가')], C0WAIT11: [memo('1790000600.000200', '나')], C0SOME11: [memo('1790000600.000300', '다')] } });
  const busy = fix.run();
  assert.equal(busy.status, 0, busy.stderr + fix.logText());
  const prompts = fix.claudeCalls().map(fix.promptOf);
  assert.equal(prompts.length, 3);
  assert.match(prompts[0], /# 슬랙발 할 일 캡처/);
  assert.match(prompts[1], /# 슬랙발 언젠가\(참고용\) 캡처/);
  assert.match(prompts[2], /# 슬랙발 확인 대기 캡처/);
  assert.ok(!prompts.some(prompt => prompt.includes('# 슬랙발 정책/얼라인 캡처')), '뺀 채널의 지침은 넘기지 않는다');
  assert.ok(!fix.logText().includes('{"ok":true}'));
});

// backup-data.sh를 임시 HOME에서 돌린다 — 데이터·백업 폴더·로그·Git 저장 공간 모두 임시 폴더.
function backupFixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-wpe-backup-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const ws = path.join(home, 'ws');
  const tracker = path.join(ws, 'tracker');
  const app = path.join(tracker, 'inbox-app');
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(tracker, 'tasks.md'), '# Tasks\n- 오늘 업무\n');
  fs.writeFileSync(path.join(tracker, '.workflow.json'), '{"items":{}}');
  fs.writeFileSync(path.join(tracker, '.access-token'), 'secret-password\n');
  fs.writeFileSync(path.join(tracker, '메모.txt'), '목록에 없는 파일\n');
  fs.writeFileSync(path.join(app, '.slack_capture_state.json'), '{"my-todo":"1.0"}');
  const backup = path.join(home, 'workspace-data-backup');
  const logs = path.join(home, 'logs');
  const run = (env = {}) => runScript(automationScript('backup-data.sh'), [], {
    ...gitEnv, HOME: home, WORKSPACE_DIR: ws, WORKSPACE_DATA_DIR: '', WORKSPACE_BACKUP_DIR: backup, AUTOMATION_LOG_DIR: logs,
    DATA_BACKUP_GIT_DIR: path.join(home, 'data-backup.git'), ...env,
  });
  const daily = () => (fs.existsSync(path.join(backup, 'daily')) ? fs.readdirSync(path.join(backup, 'daily')) : []).sort();
  const logText = () => fs.readFileSync(path.join(logs, 'data-backup.log'), 'utf8');
  const two = n => String(n).padStart(2, '0');
  const now = new Date();
  const today = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
  return { home, ws, tracker, backup, run, daily, logText, today };
}

test('WP-E backup-data.sh: 이 맥 안 daily/YYYY-MM-DD에 복사(접속 암호 제외)하고 7개만 남기며, 다른 폴더·업데이트 백업은 건드리지 않는다', (t) => {
  const fix = backupFixture(t);
  for (let day = 1; day <= 8; day += 1) {
    const dir = path.join(fix.backup, 'daily', `2020-01-0${day}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'tasks.md'), `옛 ${day}`);
  }
  fs.mkdirSync(path.join(fix.backup, 'daily', '내 메모'), { recursive: true });
  fs.mkdirSync(path.join(fix.backup, 'daily', '2020-01-01-extra'), { recursive: true });
  fs.mkdirSync(path.join(fix.backup, '2020-01-01-0900'), { recursive: true });
  fs.writeFileSync(path.join(fix.backup, '2020-01-01-0900', 'tasks.md'), '업데이트 직전 백업');

  const result = fix.run();
  assert.equal(result.status, 0, result.stderr + fix.logText());
  const dated = fix.daily().filter(name => /^\d{4}-\d{2}-\d{2}$/.test(name));
  assert.equal(dated.length, 7, '7일치만 남긴다');
  assert.deepEqual(dated, ['2020-01-03', '2020-01-04', '2020-01-05', '2020-01-06', '2020-01-07', '2020-01-08', fix.today], '가장 오래된 것부터 지운다');
  assert.ok(fix.daily().includes('내 메모') && fix.daily().includes('2020-01-01-extra'), '이름이 정확히 날짜가 아닌 폴더는 건드리지 않는다');
  assert.equal(fs.readFileSync(path.join(fix.backup, '2020-01-01-0900', 'tasks.md'), 'utf8'), '업데이트 직전 백업', 'update.sh의 백업은 그대로');
  assert.ok(!fix.daily().some(name => name.startsWith('.tmp-')), '임시 폴더는 남지 않는다');

  const todayDir = path.join(fix.backup, 'daily', fix.today);
  assert.deepEqual(fs.readdirSync(todayDir).sort(), ['.slack_capture_state.json', '.workflow.json', 'tasks.md'], '목록에 있는 데이터 파일만, 접속 암호는 빼고');
  assert.match(fs.readFileSync(path.join(todayDir, 'tasks.md'), 'utf8'), /오늘 업무/);
  assert.match(fix.logText(), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} 로컬 성공 · 7일치$/m);
  assert.match(fix.logText(), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} GitHub 건너뜀 — 백업 저장 공간을 만들지 않음$/m, 'GitHub 저장 공간이 없으면 로컬만');

  // 같은 날 다시 돌면 그날 것을 바꿔 넣는다
  fs.writeFileSync(path.join(fix.tracker, 'tasks.md'), '# Tasks\n- 저녁에 고친 업무\n');
  assert.equal(fix.run().status, 0);
  assert.match(fs.readFileSync(path.join(todayDir, 'tasks.md'), 'utf8'), /저녁에 고친 업무/);
  assert.equal(fix.daily().filter(name => /^\d{4}-\d{2}-\d{2}$/.test(name)).length, 7);

  // 백업 자리에 폴더를 만들 수 없으면 실패를 이유와 함께 남기고 1로 끝난다(데이터는 그대로)
  const blocked = path.join(fix.home, 'blocked');
  fs.writeFileSync(blocked, '폴더가 아니라 파일');
  const failed = fix.run({ WORKSPACE_BACKUP_DIR: blocked });
  assert.equal(failed.status, 1);
  assert.match(fix.logText(), /로컬 실패 — 백업 폴더를 만들지 못함/);
  assert.match(fs.readFileSync(path.join(fix.tracker, 'tasks.md'), 'utf8'), /저녁에 고친 업무/);

  // 스크립트의 지우기는 날짜 폴더 하나씩만(글자 검사 후) — 다른 rm -rf는 없다
  const script = fs.readFileSync(automationScript('backup-data.sh'), 'utf8');
  const removes = script.split('\n').filter(line => /\brm -rf\b/.test(line) && !/^\s*#/.test(line));
  assert.deepEqual(removes.map(line => line.trim()), ['rm -rf -- "$DAILY/$name"', 'rm -rf -- "$DAILY/$name"'], '날짜 폴더 하나 · 남은 임시/옛 폴더 하나 — 둘 다 이름 검사 뒤');
  assert.match(script, /\[\[ "\$name" =~ \^\[0-9\]\{4\}-\[0-9\]\{2\}-\[0-9\]\{2\}\$ \]\] \|\| return 1/);
  assert.match(script, /\[\[ "\$name" =~ \^\\\.\(tmp\|old\)-\[0-9\]\{4\}-\[0-9\]\{2\}-\[0-9\]\{2\}-\[0-9\]\+\$ \]\] \|\| return 1/);
});

test('WP-E backup-data.sh: 데이터 목록은 update.sh와 같고(접속 암호만 뺌), GitHub 저장 공간이 있으면 한 겹 더 올린다', { skip: !gitReady }, (t) => {
  const listOf = (text, name) => (new RegExp(`^${name}="([^"]*)"$`, 'm').exec(text) || [])[1].split(' ');
  const update = fs.readFileSync(path.join(REPO_ROOT, 'update.sh'), 'utf8');
  const backupScript = fs.readFileSync(automationScript('backup-data.sh'), 'utf8');
  assert.deepEqual(listOf(backupScript, 'DATA_FILES'), listOf(update, 'DATA_FILES').filter(name => name !== '.access-token'));
  assert.deepEqual(listOf(backupScript, 'STATE_FILES'), listOf(update, 'STATE_FILES'));

  const fix = backupFixture(t);
  const gitDir = path.join(fix.home, 'data-backup.git');
  runGit(fix.home, ['init', '-q', '--bare', '-b', 'main', gitDir]);
  fs.mkdirSync(path.join(gitDir, 'info'), { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'info', 'exclude'), '*\n!tasks.md\n');
  assert.equal(fix.run().status, 0, fix.logText());
  assert.match(fix.logText(), /로컬 성공 · 1일치/);
  assert.match(fix.logText(), /GitHub 건너뜀 — 원격 저장소가 연결되지 않음 \(이 맥에만 커밋함\)/);
  const remote = path.join(fix.home, 'remote.git');
  runGit(fix.home, ['init', '-q', '--bare', '-b', 'main', remote]);
  runGit(fix.home, [`--git-dir=${gitDir}`, 'remote', 'add', 'origin', remote]);
  fs.writeFileSync(path.join(fix.tracker, 'tasks.md'), '# Tasks\n- 올릴 업무\n');
  assert.equal(fix.run().status, 0, fix.logText());
  assert.match(fix.logText(), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} GitHub 성공$/m);
  assert.match(runGit(fix.home, [`--git-dir=${remote}`, 'show', 'main:tasks.md']).stdout, /올릴 업무/);
});

test('WP-E setup.sh: data-backup을 늘 등록하고(저장 공간 조건 없음), 채널 자리표시자 검사는 뺀 채널을 없는 것으로 본다', () => {
  const script = fs.readFileSync(path.join(REPO_ROOT, 'setup.sh'), 'utf8');
  assert.ok(!script.includes('if [ -d "$INSTALL_DIR/data-backup.git" ]'), 'GitHub 저장 공간이 있을 때만 등록하던 조건은 없다');
  const at = script.indexOf('cat > "$AGENTS_DIR/$LABEL.data-backup.plist"');
  assert.ok(at > 0);
  const before = script.slice(Math.max(0, script.lastIndexOf('\n\n', at)), at);
  assert.ok(!/^\s*if /m.test(before), '등록 앞에 조건문이 없다');
  assert.match(script, /<dict><key>Hour<\/key><integer>19<\/integer><key>Minute<\/key><integer>30<\/integer><\/dict>/);
  assert.ok(!/grep -q "여기에_채널ID" "\$CONFIG"/.test(script), '파일 글자 검사 대신 설정을 읽는다');

  // 설정 읽기 조각만 꺼내 돌린다 — 뺀 채널의 자리표시자는 세지 않는다
  const reader = /CONFIG_READER='\n([\s\S]*?)\n'/.exec(script)[1];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-wpe-setup-'));
  const config = path.join(home, 'workspace.config.json');
  const read = () => spawnSync(process.execPath, ['-e', reader, config, 'slackPlaceholder'], { encoding: 'utf8' }).stdout;
  fs.writeFileSync(config, JSON.stringify({ slack: { channels: { todo: { id: 'C0TODO11' }, align: { id: '여기에_채널ID', off: true } } } }));
  assert.equal(read(), 'no');
  fs.writeFileSync(config, JSON.stringify({ slack: { channels: { todo: { id: '여기에_채널ID' } } } }));
  assert.equal(read(), 'yes');
  fs.rmSync(home, { recursive: true, force: true });
});

test('WP-E update.sh: 매일 백업(daily/)은 업데이트 백업의 목록·정리·되돌리기에 절대 잡히지 않는다', { skip: !gitReady }, (t) => {
  const fix = updateFixture(t);
  const daily = path.join(fix.backups, 'daily');
  for (const day of ['2099-01-01', '2099-01-02']) {
    fs.mkdirSync(path.join(daily, day), { recursive: true });
    fs.writeFileSync(path.join(daily, day, 'tasks.md'), '# Tasks\n- 매일 백업의 내용\n');
  }
  for (const day of ['01', '02', '03', '04', '05', '06']) fs.mkdirSync(path.join(fix.backups, `2020-01-${day}-0900`));
  const snapshot = () => fs.readdirSync(daily).sort().map(day => [day, fs.readFileSync(path.join(daily, day, 'tasks.md'), 'utf8')]);
  const before = snapshot();

  assert.equal(fix.run(['--yes']).status, 0);
  assert.equal(fix.dated().length, 5, '업데이트 백업은 최근 5개');
  assert.deepEqual(snapshot(), before, 'daily/는 그대로(정리 대상이 아니다)');

  fs.writeFileSync(path.join(fix.clone, 'tracker', 'tasks.md'), '# Tasks\n- 망가진 내용\n');
  const back = fix.run(['--rollback', '--yes']);
  assert.equal(back.status, 0, back.stdout + back.stderr);
  assert.match(fix.tasks(), /지켜야 할 업무/, '되돌리기는 업데이트 직전 백업에서(날짜가 더 늦은 daily/가 아니라)');
  assert.deepEqual(snapshot(), before);
  const script = fs.readFileSync(path.join(REPO_ROOT, 'update.sh'), 'utf8');
  assert.match(script, /^BACKUP_NAME_RE='\^\[0-9\]\{4\}-\[0-9\]\{2\}-\[0-9\]\{2\}-\[0-9\]\{4\}\$'$/m, 'daily는 이 이름 규칙에 맞지 않는다');
});

// ─────────────────────────────────────────────────────────────────────────────
// QA 1.1.0 정정 2

test('QA2 backup-data.sh: 같은 날 다시 돌면 옛 것을 먼저 지우지 않고(옆 이름으로 비켜 둔 뒤) 새 것이 자리 잡으면 지운다', (t) => {
  const fix = backupFixture(t);
  assert.equal(fix.run().status, 0, fix.logText());
  const todayDir = path.join(fix.backup, 'daily', fix.today);
  fs.writeFileSync(path.join(fix.tracker, 'tasks.md'), '# Tasks\n- 두 번째\n');
  assert.equal(fix.run().status, 0, fix.logText());
  assert.match(fs.readFileSync(path.join(todayDir, 'tasks.md'), 'utf8'), /두 번째/);
  assert.deepEqual(fix.daily().filter(name => name.startsWith('.')), [], '옆 이름(.old-)·임시(.tmp-) 폴더가 남지 않는다');
  const script = fs.readFileSync(automationScript('backup-data.sh'), 'utf8');
  const swap = script.slice(script.indexOf('# 다 복사한 뒤에만'), script.indexOf('# 7일치만 남긴다'));
  assert.ok(!/drop_day "\$DAY"/.test(swap), '옛 날짜 폴더를 먼저 지우지 않는다');
  assert.ok(swap.indexOf('mv "$DAILY/$DAY" "$OLD"') < swap.indexOf('mv "$TMP" "$DAILY/$DAY"'), '옛 것을 비켜 둔 뒤 새 것을 옮긴다');
  assert.match(swap, /if ! mv "\$TMP" "\$DAILY\/\$DAY"; then\n\s+\[ -d "\$OLD" \] && mv "\$OLD" "\$DAILY\/\$DAY"/, '실패하면 옛 것을 원래 이름으로 되돌린다');
  assert.ok(swap.indexOf('drop_leftover "${OLD##*/}"') > swap.indexOf('mv "$TMP" "$DAILY/$DAY"'), '옛 것은 성공한 뒤에만 지운다');
});

test('QA2 backup-data.sh: 시작할 때 daily/의 `.tmp-`·`.old-` 중 이름 규칙에 정확히 맞고 하루가 넘은 것만 정리한다', (t) => {
  const fix = backupFixture(t);
  const daily = path.join(fix.backup, 'daily');
  fs.mkdirSync(daily, { recursive: true });
  const old = new Date(Date.now() - 2 * 86400000);
  const make = (name, aged, file = 'tasks.md') => {
    const dir = path.join(daily, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, file), name);
    if (aged) fs.utimesSync(dir, old, old);
    return dir;
  };
  make('.tmp-2020-01-01-123', true);
  make('.old-2020-01-01-456', true);
  make('.tmp-2020-01-02-789', false);          // 하루가 안 됨 — 지금 도는 다른 실행일 수 있다
  make('.tmp-notes', true);                     // 이름 규칙이 아님
  make('.old-2020-01-01-12x', true);            // 이름 규칙이 아님
  make('.old-2020-01-01', true);                // 번호가 없음
  const outside = path.join(fix.home, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep.txt'), '밖의 파일');
  fs.symlinkSync(outside, path.join(daily, '.old-2020-01-01-999'));
  assert.equal(fix.run().status, 0, fix.logText());
  const left = fix.daily().filter(name => name.startsWith('.'));
  assert.deepEqual(left, ['.old-2020-01-01', '.old-2020-01-01-12x', '.old-2020-01-01-999', '.tmp-2020-01-02-789', '.tmp-notes']);
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), '밖의 파일', '바로가기는 따라가지 않는다');
  assert.ok(fs.lstatSync(path.join(daily, '.old-2020-01-01-999')).isSymbolicLink());
});

// apply-runner.sh — 가짜 setup.sh가 받은 환경만 적는다(실제 setup.sh·launchctl은 부르지 않는다).
function applyRunnerFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-wpf-apply-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const install = path.join(root, 'install');
  const trail = path.join(root, 'trail.txt');
  fs.mkdirSync(workspace);
  fs.mkdirSync(path.join(install, 'requests'), { recursive: true });
  const request = path.join(install, 'requests', 'apply.request');
  const fakeSetup = (extra = '', code = 0) => writeExec(path.join(workspace, 'setup.sh'),
    `#!/bin/bash\necho "setup $* apply=\${WORKSPACE_APPLY_RUNNER:-} update=\${WORKSPACE_UPDATE_RUNNER:-}" >> ${JSON.stringify(trail)}\n${extra}exit ${code}\n`);
  fakeSetup();
  const ask = () => fs.writeFileSync(request, `${JSON.stringify({ action: 'apply', requestedAt: new Date().toISOString() })}\n`);
  const run = () => runScript(automationScript('apply-runner.sh'), [], { HOME: root, WORKSPACE_DIR: workspace, WORKSPACE_INSTALL_DIR: install });
  const lines = () => (fs.existsSync(trail) ? fs.readFileSync(trail, 'utf8').trim().split('\n').filter(Boolean) : []);
  const logFile = path.join(install, 'logs', 'apply.log');
  const log = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '');
  const lock = path.join(install, 'logs', '.apply.lock');
  return { root, workspace, install, trail, request, fakeSetup, ask, run, lines, log, lock };
}

test('WP-F apply-runner.sh: 모양이 맞는 요청만 setup.sh를 WORKSPACE_APPLY_RUNNER=1로 한 번 돌리고, 결과 한 줄을 apply.log에 남긴다', (t) => {
  const fix = applyRunnerFixture(t);
  fix.ask();
  assert.equal(fix.run().status, 0);
  assert.deepEqual(fix.lines(), ['setup  apply=1 update='], 'apply·update 에이전트를 다시 올리지 않게 표시를 준다');
  assert.equal(fs.existsSync(fix.request), false, '요청은 한 번만 처리한다');
  assert.equal(fs.existsSync(fix.lock), false, '잠금은 풀고 끝난다');
  assert.match(fix.log(), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} 자동화 등록 완료\n$/);
  assert.match(fs.readFileSync(path.join(fix.install, 'logs', 'apply-setup.log'), 'utf8'), /apply-runner 종료 \(exit 0\)/);

  // 모양이 틀린 요청은 그 파일만 지우고 아무것도 하지 않는다(글자를 명령·경로로 쓰지 않는다)
  fs.writeFileSync(fix.trail, '');
  for (const body of ['{"action":"apply; touch pwned","requestedAt":"2026-09-24T00:00:00.000Z"}\n', '{"action":"update","requestedAt":"2026-09-24T00:00:00.000Z"}\n',
    '{"requestedAt":"2026-09-24T00:00:00.000Z","action":"apply"}\n', 'apply\n',
    '{"action":"apply","requestedAt":"2026-09-24T00:00:00.000Z"}\n{"action":"apply","requestedAt":"$(touch pwned)"}\n']) {
    fs.writeFileSync(fix.request, body);
    assert.equal(fix.run().status, 0);
    assert.equal(fs.existsSync(fix.request), false, '모양이 틀린 요청은 그 파일만 지운다');
  }
  assert.deepEqual(fix.lines(), []);
  assert.equal(fs.existsSync(path.join(fix.workspace, 'pwned')), false);
  assert.equal(fix.run().status, 0, '요청 파일이 없으면(지운 것도 launchd를 깨운다) 조용히 끝난다');
  assert.deepEqual(fix.lines(), []);

  // setup.sh가 실패하면 고정 문구 한 줄
  fix.fakeSetup('', 1);
  fix.ask();
  assert.equal(fix.run().status, 0);
  assert.match(fix.log().trim().split('\n').pop(), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} 자동화 등록 실패 — 업데이트\.command를 한 번 실행해 주세요$/);

  // 도는 사이에 새 요청이 오면 끝난 뒤 한 번 더
  fs.writeFileSync(fix.trail, '');
  const once = path.join(fix.root, 'once');
  fix.fakeSetup(`if [ ! -f ${JSON.stringify(once)} ]; then touch ${JSON.stringify(once)}; printf '{"action":"apply","requestedAt":"2026-09-24T00:00:01.000Z"}\\n' > ${JSON.stringify(fix.request)}; fi\n`);
  fix.ask();
  assert.equal(fix.run().status, 0);
  assert.equal(fix.lines().length, 2);
  assert.equal(fs.existsSync(fix.request), false);

  const script = fs.readFileSync(automationScript('apply-runner.sh'), 'utf8');
  assert.ok(!/rm -rf|pkill|killall|xargs kill|\bkill\b/.test(script), '지우기는 파일 하나·잠금은 rmdir, 프로세스는 끝내지 않는다');
  assert.match(script, /^main "\$@"; exit \$\?$/m, '본문을 통째로 읽고 시작한다(복사본이 바뀌어도 안전)');
  assert.match(script, /rmdir "\$lock"/);
});

test('WP-F apply-runner.sh: 살아 있는 실행기가 쥔 잠금이면 건너뛰고(요청은 남김), 주인이 없는 잠금은 치우고 돈다', async (t) => {
  const fix = applyRunnerFixture(t);
  fs.mkdirSync(fix.lock, { recursive: true });
  // 명령줄에 apply-runner가 보이는 프로세스 하나를 직접 띄워 잠금 주인으로 삼는다(끝날 때 그 자식만 끝낸다).
  const holder = spawn('/bin/bash', ['-c', 'sleep 30; true', 'apply-runner'], { stdio: 'ignore' });
  t.after(() => { if (holder.exitCode === null) holder.kill(); });
  fs.writeFileSync(path.join(fix.lock, 'pid'), `${holder.pid}\n`);
  for (let i = 0; i < 40 && !/apply-runner/.test(spawnSync('ps', ['-o', 'command=', '-p', String(holder.pid)], { encoding: 'utf8' }).stdout); i += 1) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  fix.ask();
  assert.equal(fix.run().status, 0);
  assert.deepEqual(fix.lines(), [], '도는 실행기가 있으면 건너뛴다');
  assert.ok(fs.existsSync(fix.request), '건너뛴 요청은 그대로 남는다(도는 실행기가 이어서 처리한다)');
  holder.kill();
  await new Promise(resolve => holder.once('exit', resolve));
  assert.equal(fix.run().status, 0);
  assert.deepEqual(fix.lines(), ['setup  apply=1 update=']);
  assert.equal(fs.existsSync(fix.lock), false);
});

test('WP-F setup.sh: apply 에이전트를 늘 등록하고, 실행기 표시일 때 apply·update·(내용 같으면) server를 다시 올리지 않는다', () => {
  const script = fs.readFileSync(path.join(REPO_ROOT, 'setup.sh'), 'utf8');
  assert.match(script, /<string>\$LABEL\.apply<\/string>/);
  assert.match(script, /<string>\$\(xml_escape "\$INSTALL_DIR\/apply-runner\.sh"\)<\/string>/);
  assert.match(script, /<string>\$\(xml_escape "\$INSTALL_DIR\/requests\/apply\.request"\)<\/string>/);
  const plist = script.slice(script.indexOf('cat > "$AGENTS_DIR/$LABEL.apply.plist"'), script.indexOf('# 업무 데이터 백업'));
  assert.match(plist, /<key>WatchPaths<\/key>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\n  <false\/>/);
  const intro = script.slice(script.indexOf('# 켠 연동 자동 등록 — 일정표가 없다'), script.indexOf('cat > "$AGENTS_DIR/$LABEL.apply.plist"'));
  assert.ok(intro.length > 0 && !/USE_(SLACK|CAL|JIRA|TIRO)/.test(intro), '연동과 무관하게 늘');
  assert.match(script, /"\$APP_DIR\/automation\/apply-runner\.sh" "\$APP_DIR\/automation\/update-runner\.sh"/, '실행기도 설치 위치로 복사한다');
  assert.match(script, /\[ "\$\{WORKSPACE_APPLY_RUNNER:-\}" = "1" \] && IN_RUNNER="apply"/);
  assert.match(script, /if \[ "\$IN_RUNNER" = "apply" \]; then\n  ok "apply 그대로 \(지금 도는 등록\)"\nelif/, 'apply 실행기 안에서는 apply를 다시 올리지 않는다');
  assert.match(script, /elif \[ "\$IN_RUNNER" = "apply" \] && \[ "\$OLD_UPDATE_PLIST" = "\$\(cat "\$UPDATE_PLIST"\)" \]; then\n  ok "update 그대로"/, 'apply 실행기 안에서는 내용이 그대로인 update도 다시 올리지 않는다');
  assert.match(script, /\[ "\$f" = "server" \] && \[ -n "\$IN_RUNNER" \] && \[ "\$OLD_SERVER_PLIST" = "\$\(cat "\$plist"\)" \]/);
  // 요청 파일로 돈 setup은 폴더를 옮기지 않는다(회사 폴더면 멈추고 업데이트.command로)
  const guard = script.indexOf('install_location_guard "$WORKSPACE"');
  const stop = script.indexOf('if [ "${WORKSPACE_APPLY_RUNNER:-}" = "1" ] && install_location_is_playio "$WORKSPACE"; then');
  assert.ok(stop > 0 && stop < guard);
  const update = fs.readFileSync(path.join(REPO_ROOT, 'update.sh'), 'utf8');
  assert.match(update, /cp "\$APP_DIR\/automation\/apply-runner\.sh" "\$INSTALL_DIR\/"/, '업데이트 뒤 실행기 복사본도 갱신한다');
});

test('WP-F slack-capture.sh: 할 일 채널 없이도 켜진 채널만 읽고 그 지침만 넘긴다', (t) => {
  const fix = captureFixture(t, { slack: { channels: {
    waiting: { id: 'C0WAIT11', name: '#hana-waiting' },
    someday: { id: 'C0SOME11', name: '#hana-someday' },
  } } });
  fix.setSlack({ history: { C0WAIT11: [memo('1790000600.000200', '나')], C0SOME11: [memo('1790000600.000300', '다')] } });
  const busy = fix.run();
  assert.equal(busy.status, 0, busy.stderr + fix.logText());
  assert.equal(fix.urls().length, 2);
  const prompts = fix.claudeCalls().map(fix.promptOf);
  assert.equal(prompts.length, 2);
  assert.ok(prompts.every(prompt => !prompt.includes('# 슬랙발 할 일 캡처')));

  // 모두 뺐으면(손으로 고친 설정) 수집하지 않고 한 줄만 — 실패로 세지 않는다
  const none = captureFixture(t, { slack: { channels: { todo: { id: 'C0TODO11', off: true } } } });
  assert.equal(none.run().status, 0);
  assert.deepEqual(none.urls(), []);
  assert.match(none.logText(), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} 켜진 채널이 없어 건너뛰어요$/m);
  assert.doesNotMatch(none.logText(), /채널 확인 실패/);
});

test('WP-I 슬랙 수집: 할 일 채널 새 메시지 2개 → Claude는 도구 없이 분류만, 스크립트가 2개 저장하고 커서를 올린다', (t) => {
  const fix = captureFixture(t, TODO_ONLY, { 'my-todo': '1790000000.000000' });
  fix.setSlack({ history: { C0TODO11: [memo('1790000002.000200', 'RAWMEMO-둘째 메모'), memo('1790000001.000100', 'RAWMEMO-첫 메모')] } });
  const result = fix.run();
  assert.equal(result.status, 0, result.stderr + fix.logText());

  // Claude 호출: 허용 도구 없음(Bash 없음) · 도구를 쓰지 않는 권한 모드 · 막는 목록에 Bash
  const calls = fix.claudeCalls();
  assert.equal(calls.length, 1);
  const args = calls[0];
  assert.ok(!args.includes('--allowedTools'), '허용 도구 칸을 넘기지 않는다');
  assert.ok(!args.some(arg => /Bash\(/.test(arg)), 'Bash 명령 허용이 없다');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.match(args[args.indexOf('--disallowedTools') + 1], /(^|,)Bash(,|$)/);
  assert.equal(args[args.indexOf('--model') + 1], 'sonnet');
  const prompt = fix.promptOf(args);
  assert.ok(!prompt.includes(SLACK_TOKEN), '프롬프트에 토큰이 없다');
  assert.match(prompt, /# 슬랙발 할 일 캡처/, '지침 파일을 스크립트가 읽어 붙인다');
  const input = fix.inputOf(args);
  assert.equal(input.channel, 'my-todo');
  assert.equal(input.type, 'task');
  assert.deepEqual(input.messages.map(one => one.ts), ['1790000001.000100', '1790000002.000200'], '오래된 것부터');
  assert.equal(input.messages[0].permalink, 'https://team.slack.com/archives/C0TODO11/p1790000001000100');
  assert.equal(input.messages[0].kind, 'memo');

  // 저장은 스크립트가 import-record.js로 — 받는 형식 그대로
  assert.deepEqual(fix.imports('item'), [
    { type: 'task', description: '할 일 1790000001.000100', permalink: 'https://team.slack.com/archives/C0TODO11/p1790000001000100' },
    { type: 'task', description: '할 일 1790000002.000200', permalink: 'https://team.slack.com/archives/C0TODO11/p1790000002000200' },
  ]);
  assert.deepEqual(fix.imports('cursor'), [{ channel: 'my-todo', ts: '1790000002.000200' }], '모두 저장한 뒤 최신 ts로 커서');
  assert.deepEqual(fix.imports('health'), [{ channel: 'my-todo', success: true }]);

  // 로그: 한 회차 = 시작/종료 블록 하나, 채널마다 `채널 · 새 N개 · 저장 N · 건너뜀 N` — 연동 카드의 파서가 그대로 읽는다
  const log = fix.logText();
  assert.match(log, /^───── \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} slack-capture 시작 \(v9\.9\.9\)$/m, '시작 줄에 이 회차의 앱 버전');
  assert.match(log, /^이번에 본 메시지 2개 = 등록 2 · 링크 중복 0 · 비슷한 일이라 건너뜀 0 · 시스템 0$/m, '연동 카드가 읽는 처리 대장 문장');
  assert.match(log, /^my-todo · 새 2개 · 저장 2 · 건너뜀 0$/m);
  const last = lastLogEvent(log);
  assert.equal(last.kind, 'run');
  assert.match(last.text, /my-todo · 새 2개 · 저장 2 · 건너뜀 0/);
  assert.match(fix.allLogs(), /^───── \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} slack-classify 시작 \(v9\.9\.9\)$/m, 'run-task.sh 시작 줄에도 버전');
  // 로그에는 토큰·메시지 원문이 없다(수치와 항목 문구만)
  assert.ok(!fix.allLogs().includes(SLACK_TOKEN));
  assert.ok(!fix.allLogs().includes('RAWMEMO'), '메시지 원문은 로그에 없다');
  assert.ok(!fix.allLogs().includes('"items"'), 'Claude의 답(JSON)은 로그가 아니라 임시 파일로 받는다');
});

test('WP-I 슬랙 수집: 공유 메시지는 원본 스레드 전체(댓글이면 그 스레드)가 입력에 들어가고, 못 읽은 원본은 표시되어 넘어간다', (t) => {
  const fix = captureFixture(t, TODO_ONLY);
  const share = (ts, fromUrl, extra = {}) => ({ type: 'message', user: 'U0ME', ts, text: '더블체크 필요할듯',
    attachments: [{ is_share: true, from_url: fromUrl, channel_id: extra.channel || 'C0SRC', ts: extra.ts || '1700000000.000100', text: '공유 당시 글', author_name: '가나' }] });
  fix.setSlack({
    history: { C0TODO11: [
      share('1790000001.000100', 'https://team.slack.com/archives/C0SRC/p1700000000000200?thread_ts=1700000000.000100&cid=C0SRC', { ts: '1700000000.000200' }),
      share('1790000002.000100', 'https://team.slack.com/archives/C0LOCK/p1700000009000100', { channel: 'C0LOCK', ts: '1700000009.000100' }),
    ] },
    replies: { 'C0SRC:1700000000.000100': [
      { user: 'U0KIM', ts: '1700000000.000100', text: '비밀스레드원문 <@U0LEE> 금요일까지 부탁해요' },
      { user: 'U0LEE', ts: '1700000000.000200', text: '넵 확인할게요' },
    ] },
    users: { U0KIM: '김하나', U0LEE: '이두리' },
  });
  const result = fix.run();
  assert.equal(result.status, 0, result.stderr + fix.logText());
  const input = fix.inputOf(fix.claudeCalls()[0]);
  const [readable, locked] = input.messages;
  assert.equal(readable.kind, 'share');
  assert.equal(readable.text, '더블체크 필요할듯', '공유하며 같이 적은 메모');
  assert.equal(readable.shares[0].permalink, 'https://team.slack.com/archives/C0SRC/p1700000000000200', '쿼리를 뗀 원본 링크');
  assert.deepEqual(readable.shares[0].thread.map(one => [one.user, one.text]), [
    ['김하나', '비밀스레드원문 @이두리 금요일까지 부탁해요'], ['이두리', '넵 확인할게요'],
  ], '댓글을 공유했으면 thread_ts로 스레드 전체, 사람 이름은 스크립트가 찾아 둔다');
  assert.ok(fix.requests().some(one => one.url.includes('conversations.replies?channel=C0SRC&ts=1700000000.000100')));
  assert.equal(locked.shares[0].thread, undefined);
  assert.match(locked.shares[0].threadError, /원본 스레드를 못 읽음\(channel_not_found\)/);
  assert.equal(locked.shares[0].text, '공유 당시 글');

  assert.deepEqual(fix.imports('item').map(one => [one.description, one.permalink]), [
    ['공유된 일 1790000001.000100', 'https://team.slack.com/archives/C0SRC/p1700000000000200'],
    ['원본 못 읽은 일 1790000002.000100', 'https://team.slack.com/archives/C0LOCK/p1700000009000100'],
  ]);
  assert.deepEqual(fix.imports('cursor'), [{ channel: 'my-todo', ts: '1790000002.000100' }]);
  const log = fix.logText();
  assert.match(log, /^my-todo · 새 2개 · 저장 2 · 건너뜀 0 · 표시 1$/m);
  assert.match(log, /\+ 원본 못 읽은 일 1790000002\.000100 \(원본 못 읽음\)/);
  assert.match(log, /^⚠️ 원본 스레드를 못 읽어서 공유 당시 텍스트만 사용함: 원본 못 읽은 일/m, '연동 카드가 뽑아 보이는 ⚠️ 줄');
  assert.ok(!fix.allLogs().includes('비밀스레드원문'), '원본 스레드 원문은 로그에 없다');
  assert.ok(!fix.allLogs().includes(SLACK_TOKEN));
});

test('WP-I 슬랙 수집: Claude가 이상한 답을 내거나 실패하면 그 채널은 실패 — 저장 없음·커서 그대로', (t) => {
  const fix = captureFixture(t, TODO_ONLY);
  fix.setSlack({ history: { C0TODO11: [memo('1790000001.000100', '가'), memo('1790000002.000200', '나')] } });
  for (const [mode, reason] of [['garbage', /분류 답을 쓸 수 없음 — 답이 JSON이 아니에요/], ['badlink', /permalink가 입력의 링크가 아니에요/], ['exit', /분류 실패\(exit 3\)/]]) {
    const result = fix.run({ FAKE_CLAUDE_MODE: mode });
    assert.equal(result.status, 1, mode);
    assert.equal(fix.claudeCalls().length, 1);
    assert.deepEqual(fix.imports('item'), [], `${mode}: 저장 없음`);
    assert.deepEqual(fix.imports('cursor'), [], `${mode}: 커서 그대로`);
    assert.equal(fix.imports('health')[0].success, false);
    const last = lastLogEvent(fix.logText());
    assert.equal(last.kind, 'fail', mode);
    assert.match(last.text, reason);
    assert.match(last.text, /my-todo · 새 2개 · 저장 0 · 건너뜀 0 · 실패: .* — 커서 그대로/);
  }
  // 코드 블록 하나로 감싼 답은 받아 준다(내용 검증은 같다)
  const fenced = fix.run({ FAKE_CLAUDE_MODE: 'fence' });
  assert.equal(fenced.status, 0, fix.logText());
  assert.equal(fix.imports('item').length, 2);
});

test('WP-I 슬랙 수집: 저장이 하나라도 실패하면 그 채널만 커서를 그대로 두고, 다른 채널은 올린다', (t) => {
  const fix = captureFixture(t, { slack: { channels: { todo: { id: 'C0TODO11' }, waiting: { id: 'C0WAIT11' } } } });
  fix.setSlack({
    history: { C0TODO11: [memo('1790000001.000100', '가'), memo('1790000002.000200', '나'), memo('1790000003.000300', 'SKIP')], C0WAIT11: [memo('1790000004.000100', '다')] },
    failItems: ['할 일 1790000001.000100'],
    items: { reportRefs: { a: { id: 'a', type: 'task', description: '이미 있는 일', status: 'to-do', created: '2026-09-01', permalink: null } }, jiraIssues: [] },
  });
  const result = fix.run();
  assert.equal(result.status, 1);
  assert.equal(fix.imports('item').length, 3, '실패한 것 뒤의 항목도 저장을 시도한다(다음 회차에 원본 링크로 중복이 걸러진다)');
  assert.deepEqual(fix.imports('cursor'), [{ channel: 'my-waiting', ts: '1790000004.000100' }]);
  assert.deepEqual(fix.imports('health'), [{ channel: 'my-todo', success: false, error: '저장 1건 실패' }, { channel: 'my-waiting', success: true }]);
  const [todoInput] = fix.claudeCalls().map(fix.inputOf);
  assert.deepEqual(todoInput.existing, [{ type: 'task', description: '이미 있는 일', status: 'to-do', created: '2026-09-01' }], '중복 판단용 기존 항목을 앱 API에서 읽어 넣는다');
  const log = fix.logText();
  assert.match(log, /^my-todo · 새 3개 · 저장 1 · 건너뜀 1 \(비슷한 일 1\) · 실패: 저장 1건 실패 — 커서 그대로$/m);
  assert.match(log, /^my-waiting · 새 1개 · 저장 1 · 건너뜀 0$/m);
  assert.match(log, /^🔁 이미 있는 '이미 있는 일'랑 중복돼서 안 가져왔어요$/m);
  assert.match(log, /^이번에 본 메시지 4개 = 등록 2 · 링크 중복 0 · 비슷한 일이라 건너뜀 1 · 시스템 0$/m);
  assert.equal(lastLogEvent(log).kind, 'fail');
});

test('WP-I 슬랙 수집: 시스템 메시지만 있으면 Claude 없이 커서만 올리고, 한 번에 넣는 수를 넘치면 나머지는 다음 회차로', (t) => {
  const fix = captureFixture(t, TODO_ONLY);
  fix.setSlack({ history: { C0TODO11: [{ type: 'message', subtype: 'channel_join', user: 'U0ME', ts: '1790000001.000100', text: '들어옴' }, { type: 'message', bot_id: 'B1', ts: '1790000002.000100', text: '봇' }] } });
  assert.equal(fix.run().status, 0, fix.logText());
  assert.deepEqual(fix.claudeCalls(), []);
  assert.deepEqual(fix.imports('cursor'), [{ channel: 'my-todo', ts: '1790000002.000100' }]);
  assert.match(fix.logText(), /^my-todo · 새 2개 · 저장 0 · 건너뜀 2 \(시스템 2\)$/m);

  fix.setSlack({ history: { C0TODO11: [memo('1790000011.000100', '가'), memo('1790000012.000100', '나'), memo('1790000013.000100', '다')] } });
  assert.equal(fix.run({ SLACK_COLLECT_MAX_MESSAGES: '2' }).status, 0, fix.logText());
  assert.equal(fix.inputOf(fix.claudeCalls()[0]).messages.length, 2);
  assert.deepEqual(fix.imports('cursor'), [{ channel: 'my-todo', ts: '1790000012.000100' }], '넣은 데까지만 커서');
  assert.match(fix.logText(), /^my-todo · 새 2개 · 저장 2 · 건너뜀 0 · 남은 1개는 다음 회차$/m);
});

test('WP-I 슬랙 수집: 앱 서버가 꺼져 있으면(기존 항목을 못 읽음) Claude를 부르지 않고 실패, 커서 그대로', (t) => {
  const fix = captureFixture(t, TODO_ONLY);
  fix.setSlack({ history: { C0TODO11: [memo('1790000001.000100', '가')] }, items: null });
  const preloadDown = path.join(fix.home, 'app-down.js');
  fs.writeFileSync(preloadDown, "const real=globalThis.fetch;globalThis.fetch=async(input,init)=>{if(String(input).startsWith('http://127.0.0.1'))throw new Error('ECONNREFUSED');return real(input,init);};");
  const result = fix.run({ NODE_OPTIONS: `--require ${path.join(fix.home, 'fake-fetch.js')} --require ${preloadDown}` });
  assert.equal(result.status, 1);
  assert.deepEqual(fix.claudeCalls(), []);
  assert.match(fix.logText(), /my-todo · 새 1개 · 저장 0 · 건너뜀 0 · 실패: ECONNREFUSED — 커서 그대로/);
});

// ---- 새 방식(slack.auth: 'oauth') — 수집이 실행 직전 갱신 모듈로 토큰을 받는다 ----
// 갱신 정보는 임시 HOME의 ~/.config에만 있다(가짜 값). 슬랙·갱신 요청은 전부 가짜 fetch다.
const OLD_SLACK_TOKEN = 'xoxe.xoxp-OLD-FIXTURE-TOKEN';
const REFRESH_SECRET = 'xoxe-1-REFRESH-FIXTURE';
function oauthCapture(t, { expiresInMs }) {
  const fix = captureFixture(t, { slack: { auth: 'oauth', clientId: '111.222', tidy: 'raw', ...TODO_ONLY.slack } });
  const dir = path.join(fix.home, '.config');
  fs.mkdirSync(dir, { recursive: true });
  const oauthFile = path.join(dir, 'workspace-slack-oauth.json');
  const now = Date.now();
  fs.writeFileSync(oauthFile, JSON.stringify({
    version: 1, accessToken: OLD_SLACK_TOKEN, refreshToken: REFRESH_SECRET, expiresAt: now + expiresInMs,
    teamId: 'T1', teamName: '팀', userId: 'U1', scopes: [], clientId: '111.222', connectedAt: now, refreshedAt: null, savedAt: now,
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(fix.home, 'token'), `${OLD_SLACK_TOKEN}\n`);
  const info = () => JSON.parse(fs.readFileSync(oauthFile, 'utf8'));
  const state = () => { try { return JSON.parse(fs.readFileSync(`${oauthFile}.state`, 'utf8')); } catch { return null; } };
  const history = () => fix.requests().filter(one => one.url.includes('conversations.history'));
  const refreshes = () => fix.requests().filter(one => one.url.includes('oauth.v2.access'));
  const noSecrets = () => {
    const text = `${fix.allLogs()}\n${JSON.stringify(state())}\n${JSON.stringify(fix.imports('health'))}`;
    for (const secret of [SLACK_TOKEN, OLD_SLACK_TOKEN, REFRESH_SECRET, 'NEW-REFRESH']) assert.ok(!text.includes(secret), '로그·상태에 토큰 값이 없다');
  };
  const granted = { ok: true, access_token: SLACK_TOKEN, refresh_token: 'xoxe-1-NEW-REFRESH', expires_in: 43200, scope: 'channels:read' };
  return { ...fix, info, state, history, refreshes, noSecrets, granted, copy: () => fs.readFileSync(path.join(fix.home, 'token'), 'utf8').trim() };
}

test('슬랙 수집(새 방식): 만료가 10분 안이면 실행 직전에 갱신하고 새 토큰으로 읽는다 — 갱신 정보·한 줄 사본이 바뀐다', (t) => {
  const fix = oauthCapture(t, { expiresInMs: 5 * 60 * 1000 });
  fix.setSlack({ refresh: fix.granted, history: { C0TODO11: [memo('1790000001.000100', '새 방식으로 받은 일')] } });
  const run = fix.run();
  assert.equal(run.status, 0, run.stderr + fix.logText());
  assert.equal(fix.refreshes().length, 1);
  assert.deepEqual(fix.refreshes()[0].body, { grant: 'refresh_token' });
  assert.deepEqual(fix.history().map(one => one.auth), [true], '갱신한 토큰으로 한 번만 읽는다');
  assert.equal(fix.info().accessToken, SLACK_TOKEN);
  assert.equal(fix.info().refreshToken, 'xoxe-1-NEW-REFRESH', '바뀐 갱신 토큰을 저장한다');
  assert.equal(fix.copy(), SLACK_TOKEN);
  assert.equal(fix.imports('item').length, 1);
  fix.noSecrets();
});

test('슬랙 수집(새 방식): 넉넉히 남았으면 갱신하지 않고, 슬랙이 토큰을 거절하면 강제 갱신 한 번 뒤 그 호출만 한 번 다시 부른다', (t) => {
  const fix = oauthCapture(t, { expiresInMs: 6 * 60 * 60 * 1000 });
  fix.setSlack({ history: { C0TODO11: [] } });
  assert.equal(fix.run().status, 0);
  assert.equal(fix.refreshes().length, 0, '만료가 멀면 갱신 요청이 없다');
  assert.deepEqual(fix.history().map(one => one.auth), [false], '가진 토큰 그대로 읽는다');

  fix.setSlack({ rejected: [OLD_SLACK_TOKEN], refresh: fix.granted, history: { C0TODO11: [memo('1790000002.000100', '거절 뒤에 받은 일')] } });
  const run = fix.run();
  assert.equal(run.status, 0, run.stderr + fix.logText());
  assert.equal(fix.refreshes().length, 1, '강제 갱신은 한 번');
  assert.deepEqual(fix.history().map(one => one.auth), [false, true], '거절된 호출을 새 토큰으로 한 번만 다시');
  assert.equal(fix.copy(), SLACK_TOKEN);
  assert.equal(fix.imports('item').length, 1);
  fix.noSecrets();
});

test('슬랙 수집(새 방식): 거절 뒤 갱신도 거절되면(다시 연결 필요) 그 회차는 실패, 종류가 값 없이 상태에 남고 다음부터는 슬랙에 묻지 않는다', (t) => {
  const fix = oauthCapture(t, { expiresInMs: 5 * 60 * 1000 });
  fix.setSlack({ refresh: { ok: false, error: 'invalid_refresh_token' }, history: { C0TODO11: [memo('1790000003.000100', '못 받는 일')] } });
  const run = fix.run();
  assert.equal(run.status, 1);
  assert.equal(fix.refreshes().length, 1);
  assert.equal(fix.history().length, 0, '죽은 토큰으로 슬랙을 두드리지 않는다');
  assert.match(fix.logText(), /my-todo 채널 확인 실패 — 슬랙 연결이 풀림, 다시 연결 필요\(slack_reconnect · invalid_refresh_token\)/);
  assert.equal(lastLogEvent(fix.logText()).kind, 'fail');
  assert.deepEqual(fix.state().failure, { kind: 'reconnect', reason: 'slack_error', code: 'invalid_refresh_token' });
  assert.match(fix.imports('health').pop().error, /slack_reconnect/);
  assert.equal(fix.info().accessToken, OLD_SLACK_TOKEN, '갱신 정보는 건드리지 않는다');
  // 다음 회차 — 이미 판정된 갱신 토큰으로는 갱신도 다시 묻지 않는다.
  assert.equal(fix.run().status, 1);
  assert.equal(fix.refreshes().length, 0);
  assert.equal(fix.history().length, 0);
  fix.noSecrets();
});

test('슬랙 수집(새 방식): 갱신이 잠시 안 되면(슬랙 5xx) 이전 토큰으로 그대로 읽고 한 줄만 남긴다 — 멈춤이 아니다', (t) => {
  const fix = oauthCapture(t, { expiresInMs: 5 * 60 * 1000 });
  fix.setSlack({ refresh: { status: 503 }, history: { C0TODO11: [] } });
  const run = fix.run();
  assert.equal(run.status, 0, run.stderr + fix.logText());
  assert.deepEqual(fix.history().map(one => one.auth), [false], '이전 토큰으로 읽는다');
  assert.match(fix.logText(), /슬랙 토큰 갱신이 잠시 안 됨\(retry · http\) — 이전 토큰으로 진행/);
  assert.doesNotMatch(fix.logText(), /채널 확인 실패/);
  assert.equal(fix.state().failure.kind, 'retry');
  assert.equal(fix.imports('health').pop().success, true);
  fix.noSecrets();
});

test('슬랙 수집(새 방식): 갱신이 잠시 안 되는데 토큰이 이미 만료면 슬랙에 묻지 않고 건너뛴다 — 풀림(다시 연결)으로 읽히는 낱말을 남기지 않는다', (t) => {
  const AUTH_WORDS = /invalid_auth|token_revoked|account_inactive|token_expired|invalid_refresh_token|slack_reconnect/;
  const fix = oauthCapture(t, { expiresInMs: -60 * 1000 });
  fix.setSlack({ refresh: { status: 503 }, rejected: [OLD_SLACK_TOKEN], history: { C0TODO11: [memo('1790000004.000100', '나중에 받을 일')] } });
  const run = fix.run();
  assert.equal(run.status, 0, run.stderr + fix.logText());
  assert.equal(fix.history().length, 0, '만료된 토큰으로 슬랙을 두드리지 않는다');
  assert.match(fix.logText(), /슬랙 토큰 갱신이 잠시 안 됨\(retry · http\) — 토큰이 만료돼 이번 회차는 건너뛰고 다음 회차에 다시/);
  assert.doesNotMatch(fix.logText(), AUTH_WORDS);
  assert.equal(lastLogEvent(fix.logText()).kind, 'skip', '실패 기록이 아니다(서버의 멈춤 판정에 걸리지 않는다)');
  assert.equal(fix.imports('health').length, 0, '성공으로도 적지 않는다 — 늦어지면 늦음이 말한다');
  assert.equal(fix.state().failure.kind, 'retry');
  // 다음 회차에 갱신이 되면 그대로 받는다.
  fs.rmSync(path.join(fix.home, '.config', 'workspace-slack-oauth.json.state'));
  fix.setSlack({ refresh: fix.granted, history: { C0TODO11: [memo('1790000004.000100', '나중에 받을 일')] } });
  assert.equal(fix.run().status, 0);
  assert.equal(fix.imports('item').length, 1);

  // 만료 전인 토큰을 슬랙이 거절했고 강제 갱신이 잠시 안 되면 — 그 회차만 실패, 토큰 문제 낱말은 남기지 않는다.
  const mid = oauthCapture(t, { expiresInMs: 6 * 60 * 60 * 1000 });
  mid.setSlack({ refresh: { status: 503 }, rejected: [OLD_SLACK_TOKEN], history: { C0TODO11: [] } });
  assert.equal(mid.run().status, 1);
  assert.equal(mid.history().length, 1, '다시 부르지 않는다');
  assert.match(mid.logText(), /my-todo 채널 확인 실패 — 슬랙 토큰 갱신이 잠시 안 됨 — 다음 회차에 다시/);
  assert.doesNotMatch(mid.logText(), AUTH_WORDS);
  mid.noSecrets();
});

test('슬랙 수집(옛 방식): 토큰 파일을 읽기만 한다 — 갱신 요청도 없고 ~/.config에 아무것도 쓰지 않는다', (t) => {
  const fix = captureFixture(t, TODO_ONLY);
  fix.setSlack({ rejected: [SLACK_TOKEN], history: { C0TODO11: [] } });
  assert.equal(fix.run().status, 1);
  assert.equal(fix.requests().filter(one => one.url.includes('oauth.v2.access')).length, 0);
  assert.equal(fix.requests().filter(one => one.url.includes('conversations.history')).length, 1, '옛 방식은 다시 부르지 않는다');
  assert.match(fix.logText(), /my-todo 채널 확인 실패 — Slack: token_expired/);
  assert.equal(fs.existsSync(path.join(fix.home, '.config')), false);
});

test('WP-I slack-collect.js 검증: 모양·필수 칸·길이·링크·처리 대장이 어긋나면 받지 않는다', () => {
  const { validate } = require('./slack-collect');
  const entries = [{ ts: '1.1', permalink: 'https://team.slack.com/archives/C/p11', shares: [{ permalink: 'https://team.slack.com/archives/S/p22' }] }];
  const ok = validate(JSON.stringify({ items: [{ ts: '1.1', description: '할 일', permalink: 'https://team.slack.com/archives/S/p22', due: '2026-10-01', who: '버려짐' }], skipped: [] }), entries, 'task');
  assert.deepEqual(ok.items[0].payload, { type: 'task', description: '할 일', permalink: 'https://team.slack.com/archives/S/p22', due: '2026-10-01' }, '종류에 없는 칸(할 일의 who)은 버린다');
  const bad = [
    ['', /JSON이 아니에요/],
    ['[]', /모양이 달라요/],
    ['{"items":[]}', /items·skipped/],
    ['{"items":[],"skipped":[]}', /처리 대장이 모자라요/],
    ['{"items":[{"ts":"9.9","description":"x","permalink":"https://team.slack.com/archives/C/p11"}],"skipped":[]}', /ts가 입력에 없어요/],
    ['{"items":[{"ts":"1.1","description":"두\\n줄","permalink":"https://team.slack.com/archives/C/p11"}],"skipped":[]}', /한 줄/],
    [JSON.stringify({ items: [{ ts: '1.1', description: '가'.repeat(1001), permalink: 'https://team.slack.com/archives/C/p11' }], skipped: [] }), /1,000자/],
    ['{"items":[{"ts":"1.1","description":"x","permalink":"https://team.slack.com/archives/C/p11","due":"다음주"}],"skipped":[]}', /due/],
    ['{"items":[{"ts":"1.1","description":"x","permalink":"https://team.slack.com/archives/C/p11","type":"idea"}],"skipped":[]}', /type/],
    ['{"items":[],"skipped":[{"ts":"1.1","reason":""}]}', /reason/],
  ];
  for (const [text, reason] of bad) assert.throws(() => validate(text, entries, 'task'), reason, text);
});

test('run-task.sh: 오래 가는 Claude 토큰 파일이 있으면 그 값을 CLAUDE_CODE_OAUTH_TOKEN으로 넘기고, 로그에는 남기지 않는다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-claude-token-'));
  const claude = path.join(home, 'fake-claude.sh');
  fs.writeFileSync(claude, `#!/bin/bash\nprintf '%s' "\${CLAUDE_CODE_OAUTH_TOKEN:-없음}" > "${path.join(home, 'seen.txt')}"\necho ok\n`);
  fs.chmodSync(claude, 0o755);
  const tokenFile = path.join(home, 'claude-token');
  const env = { WORKSPACE_DIR: home, AUTOMATION_LOG_DIR: path.join(home, 'logs'), CLAUDE_BIN: claude, WORKSPACE_CLAUDE_TOKEN_FILE: tokenFile };
  assert.equal(runScript(automationScript('run-task.sh'), ['ok', '프롬프트', 'Read'], env).status, 0);
  assert.equal(fs.readFileSync(path.join(home, 'seen.txt'), 'utf8'), '없음', '파일이 없으면 넘기지 않는다');
  fs.writeFileSync(tokenFile, 'sk-ant-oat01-TESTTOKEN\n', { mode: 0o600 });
  assert.equal(runScript(automationScript('run-task.sh'), ['ok', '프롬프트', 'Read'], env).status, 0);
  assert.equal(fs.readFileSync(path.join(home, 'seen.txt'), 'utf8'), 'sk-ant-oat01-TESTTOKEN');
  assert.doesNotMatch(fs.readFileSync(path.join(home, 'logs', 'ok.log'), 'utf8'), /TESTTOKEN/, '토큰 값은 로그에 없다');
  fs.rmSync(home, { recursive: true, force: true });
});

test('WP-I run-task.sh: 허용 도구를 비우면 --allowedTools를 넘기지 않고, TASK_OUTPUT_FILE이면 답은 그 파일로·오류와 시작/종료 줄은 로그로', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-run-task-'));
  const claude = path.join(home, 'fake-claude.sh');
  writeExec(claude, `#!/bin/bash\nprintf '%s\\n' "$*" > "${path.join(home, 'args.txt')}"\necho '{"items":[],"skipped":[]}'\necho "경고 한 줄" >&2\n`);
  const env = { WORKSPACE_DIR: home, AUTOMATION_LOG_DIR: path.join(home, 'logs'), CLAUDE_BIN: claude, WORKSPACE_CLAUDE_TOKEN_FILE: path.join(home, 'none') };
  const answer = path.join(home, 'answer.txt');
  assert.equal(runScript(automationScript('run-task.sh'), ['slack-classify', '프롬프트', '', 'dontAsk', 'Bash,Write'], { ...env, TASK_OUTPUT_FILE: answer }).status, 0);
  assert.equal(fs.readFileSync(path.join(home, 'args.txt'), 'utf8').trim(), '-p 프롬프트 --model sonnet --permission-mode dontAsk --disallowedTools Bash,Write');
  assert.equal(fs.readFileSync(answer, 'utf8'), '{"items":[],"skipped":[]}\n');
  const log = fs.readFileSync(path.join(home, 'logs', 'slack-classify.log'), 'utf8');
  assert.doesNotMatch(log, /items/, '답은 로그에 없다');
  assert.match(log, /경고 한 줄/);
  assert.match(log, /^───── \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} slack-classify 종료 \(exit 0\)$/m);
  fs.rmSync(home, { recursive: true, force: true });
});

test('slack-collect: Claude 로그인이 풀려 분류가 실패하면 그 말을 수집 기록으로 옮겨 앱의 로그인 안내가 잡는다', () => {
  const { claudeAuthPhrase } = require('./slack-collect');
  const { CLAUDE_AUTH_RE } = require('./server');
  const phrase = claudeAuthPhrase('…\nFailed to authenticate: OAuth session expired and could not be refreshed\n');
  assert.equal(phrase, 'OAuth session expired and could not be refreshed');
  assert.ok(CLAUDE_AUTH_RE.test(`my-todo 채널 확인 실패 — 분류 실패(exit 1) — ${phrase}`), '서버 안내 규칙이 이 줄을 잡는다');
  assert.equal(claudeAuthPhrase('authentication_error from connector'), '', '다른 인증 오류는 아니다');
});

// ---------- WP-O: 예전 Dock 앱 만드는 장치 정리 ----------
// setup.sh를 **통째로** 임시 HOME에서 돌린다 — 저장소는 필요한 파일만 임시 폴더로 복사하고, launchctl·lsof·open·curl·id는
// PATH 앞의 가짜다(실제 launchd·~/Applications·~/Library·~/.local/share에 닿지 않는다). python3·osacompile·sips·iconutil·
// codesign·killall·pkill도 가짜로 두어 **불리면 기록만 남기고 실패**한다 — python3 없는 맥과 같고, 부르지 않았는지 기록으로 본다.
function setupRunFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-wpo-setup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const ws = path.join(root, 'ws');
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'calls.log');
  fs.mkdirSync(path.join(ws, 'tracker', 'inbox-app', 'automation'), { recursive: true });
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  fs.copyFileSync(path.join(REPO_ROOT, 'setup.sh'), path.join(ws, 'setup.sh'));
  fs.copyFileSync(path.join(REPO_ROOT, 'workspace.config.example.json'), path.join(ws, 'workspace.config.example.json'));
  for (const name of fs.readdirSync(path.join(__dirname, 'automation'))) {
    fs.copyFileSync(automationScript(name), path.join(ws, 'tracker', 'inbox-app', 'automation', name));
  }
  const fake = (name, body) => writeExec(path.join(bin, name), `#!/bin/bash\necho "${name} $*" >> ${JSON.stringify(log)}\n${body}\n`);
  fake('launchctl', 'exit 0');
  fake('lsof', 'exit 1');   // 4321을 쓰는 프로그램이 없다
  fake('curl', 'exit 0');   // 방금 올린 앱 서버가 곧바로 응답한다
  fake('open', '[ "$1" = "-a" ] && [ -n "${FAKE_NO_CHROME:-}" ] && exit 1\nexit 0');
  fake('id', '[ "$1" = "-F" ] && { echo "테스트 사람"; exit 0; }\n[ "$1" = "-u" ] && { echo 501; exit 0; }\nexec /usr/bin/id "$@"');
  fake('claude', 'echo 1.0.0');
  for (const name of ['python3', 'python', 'osacompile', 'sips', 'iconutil', 'codesign', 'lsregister', 'killall', 'pkill']) fake(name, 'exit 127');
  const install = path.join(home, '.local', 'share', 'workspace-automation');
  const agents = path.join(home, 'Library', 'LaunchAgents');
  const apps = path.join(home, 'Applications');
  const run = (env = {}) => {
    fs.writeFileSync(log, '');
    return spawnSync('/bin/bash', [path.join(ws, 'setup.sh')], {
      cwd: ws, encoding: 'utf8', timeout: 60000,
      // 이 테스트 프로세스의 WORKSPACE_* 값이 새어 들어가지 않게 필요한 것만 넘긴다.
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, TMPDIR: os.tmpdir(), LANG: 'en_US.UTF-8', ...env },
    });
  };
  const calls = () => fs.readFileSync(log, 'utf8');
  // 폴더 안 모든 경로(없으면 빈 목록) — ~/Applications를 건드리지 않았는지 전후를 견준다.
  const listAll = (dir) => {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { recursive: true }).map(String).sort();
  };
  return { root, home, ws, install, agents, apps, run, calls, listAll };
}

test('WP-O setup.sh: python3 없이 새로 설치하고, Dock 앱을 만들지 않으며, 끝에 크롬으로 앱 주소를 연다 · 설정 파일 모양은 예전과 같다', (t) => {
  const fix = setupRunFixture(t);
  const result = fix.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const calls = fix.calls();
  assert.doesNotMatch(calls, /^(python3?|osacompile|sips|iconutil|codesign|lsregister|killall|pkill) /m, 'python3·Dock 앱 만드는 명령·프로세스 끄는 명령을 부르지 않는다');
  assert.doesNotMatch(result.stdout, /python3/);

  // 설정 파일 — 예전 python3(json.dump ensure_ascii=False, indent=2 + 줄바꿈)와 같은 모양: 들여쓰기 2칸·한글 그대로·끝 줄바꿈 하나.
  const example = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'workspace.config.example.json'), 'utf8'));
  example.title = '테스트 사람의 워크스페이스';
  example.server.port = 4321;
  assert.equal(fs.readFileSync(path.join(fix.ws, 'workspace.config.json'), 'utf8'), `${JSON.stringify(example, null, 2)}\n`);

  // Dock 앱·app-refresh 없음
  assert.equal(fs.existsSync(fix.apps), false, '~/Applications에 아무것도 만들지 않는다');
  assert.equal(fs.existsSync(path.join(fix.agents, 'com.workspace.app.app-refresh.plist')), false);
  assert.equal(fs.existsSync(path.join(fix.install, 'app-refresh.sh')), false);
  for (const name of ['server', 'update', 'apply', 'data-backup']) {
    assert.ok(fs.existsSync(path.join(fix.agents, `com.workspace.app.${name}.plist`)), `${name}는 그대로 등록한다`);
  }
  // xml_escape(node) — 경로가 plist 안에 그대로 들어간다(형식 검사도 통과했다).
  assert.match(fs.readFileSync(path.join(fix.agents, 'com.workspace.app.update.plist'), 'utf8'),
    new RegExp(`<string>${fix.install.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/update-runner\\.sh</string>`));

  // 새 설치 끝: 크롬으로 앱 주소 하나만 연다 + 「설치하기」 안내
  assert.deepEqual(calls.split('\n').filter(line => line.startsWith('open ')), ['open -a Google Chrome http://localhost:4321']);
  assert.match(result.stdout, /\[1\/4\][\s\S]*\[4\/4\]/);
  assert.match(result.stdout, /✓ 설치를 끝냈어요 — 크롬에서 앱이 열려요\.\n사용설명서의 「설치하기」를 눌러 크롬 앱으로 설치해요\(창이 따로 떠요\)\.\n$/);
  assert.doesNotMatch(result.stdout, /Dock 추가|확인되지 않은 개발자/);

  // 다시 돌리면(설정이 이미 있다 = 업데이트 뒤) 열지 않는다
  const again = fix.run();
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.ok(!fix.calls().split('\n').some(line => line.startsWith('open ')), '업데이트 때는 열지 않는다');
  assert.match(again.stdout, /✓ 설치를 끝냈어요\.\n$/);
  // 팀 설치 파일(WORKSPACE_OPEN_APP=1)이면 설정이 있어도 연다. 실행기 안이면 열지 않는다.
  fix.run({ WORKSPACE_OPEN_APP: '1' });
  assert.deepEqual(fix.calls().split('\n').filter(line => line.startsWith('open ')), ['open -a Google Chrome http://localhost:4321']);
  fix.run({ WORKSPACE_OPEN_APP: '1', WORKSPACE_APPLY_RUNNER: '1' });
  assert.ok(!fix.calls().split('\n').some(line => line.startsWith('open ')), '실행기 안에서는 열지 않는다');
});

test('WP-O setup.sh: 크롬이 없으면 기본 브라우저로 열고 크롬 설치를 한 줄 권한다', (t) => {
  const fix = setupRunFixture(t);
  const result = fix.run({ FAKE_NO_CHROME: '1' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(fix.calls().split('\n').filter(line => line.startsWith('open ')),
    ['open -a Google Chrome http://localhost:4321', 'open http://localhost:4321']);
  assert.match(result.stdout, /✓ 설치를 끝냈어요 — 브라우저에서 앱이 열려요\.\n크롬을 설치하면 앱으로 설치할 수 있어요\(지금은 브라우저 탭으로 써요\)\.\n$/);
});

test('WP-O setup.sh: 옛 설치의 app-refresh는 그 라벨 하나만 bootout하고 plist·복사본·요청 파일·옛 이름 기록 하나씩만 지우며, ~/Applications의 앱은 그대로 둔다', (t) => {
  const fix = setupRunFixture(t);
  // 옛 설치(1.1.x)의 흔적
  fs.mkdirSync(path.join(fix.install, 'requests'), { recursive: true });
  fs.mkdirSync(fix.agents, { recursive: true });
  fs.writeFileSync(path.join(fix.agents, 'com.workspace.app.app-refresh.plist'), '<plist/>');
  fs.writeFileSync(path.join(fix.agents, 'com.someone.else.plist'), '<plist/>');
  fs.writeFileSync(path.join(fix.install, 'app-refresh.sh'), '#!/bin/bash\n');
  fs.writeFileSync(path.join(fix.install, 'app-bundle-name'), 'Workspace\n');
  fs.writeFileSync(path.join(fix.install, 'requests', 'app-refresh.request'), '{}\n');
  fs.writeFileSync(path.join(fix.install, 'requests', 'tiro-sync.request'), '{}\n');
  fs.mkdirSync(path.join(fix.apps, 'Workspace.app', 'Contents', 'Resources', 'Scripts'), { recursive: true });
  fs.writeFileSync(path.join(fix.apps, 'Workspace.app', 'Contents', 'Resources', 'Scripts', 'main.scpt'), 'old launcher');
  fs.mkdirSync(path.join(fix.apps, 'Other.app'));
  fs.writeFileSync(path.join(fix.apps, 'note.txt'), 'mine');
  const appsBefore = fix.listAll(fix.apps);
  fs.copyFileSync(path.join(REPO_ROOT, 'workspace.config.example.json'), path.join(fix.ws, 'workspace.config.json'));

  const result = fix.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /예전 Dock 앱 다시 만들기 등록을 내렸어요 \(Dock 앱은 그대로 둬요\)/);
  const launchctl = fix.calls().split('\n').filter(line => line.startsWith('launchctl '));
  assert.deepEqual(launchctl.filter(line => / bootout /.test(` ${line} `)), ['launchctl bootout gui/501/com.workspace.app.app-refresh'],
    'bootout은 app-refresh 라벨 하나에만');
  assert.ok(!launchctl.some(line => /app-refresh/.test(line) && !/bootout/.test(line)), 'app-refresh를 다시 load하지 않는다');
  assert.equal(fs.existsSync(path.join(fix.agents, 'com.workspace.app.app-refresh.plist')), false);
  assert.equal(fs.existsSync(path.join(fix.install, 'app-refresh.sh')), false);
  assert.equal(fs.existsSync(path.join(fix.install, 'requests', 'app-refresh.request')), false);
  assert.ok(fs.existsSync(path.join(fix.agents, 'com.someone.else.plist')), '다른 plist는 그대로');
  assert.equal(fs.existsSync(path.join(fix.install, 'app-bundle-name')), false, '옛 이름 기록 파일도 지운다');
  assert.ok(fs.existsSync(path.join(fix.install, 'requests', 'tiro-sync.request')), '다른 요청 파일은 그대로');
  assert.deepEqual(fix.listAll(fix.apps), appsBefore, '~/Applications는 하나도 건드리지 않는다');
  assert.ok(!fix.calls().split('\n').some(line => line.startsWith('open ')), '설정이 있던 설치(업데이트)는 열지 않는다');

  // 두 번째부터는 조용히 넘어간다(plist가 없으면 bootout도 없다)
  const again = fix.run();
  assert.equal(again.status, 0);
  assert.ok(!/bootout/.test(fix.calls()), '없으면 부르지 않는다');
  assert.doesNotMatch(again.stdout, /예전 Dock 앱 다시 만들기/);
});

test('WP-O update.sh: python3 없이 설정을 읽고, 옛 app-refresh는 그 라벨 하나만 bootout · plist·복사본만 지우며 ~/Applications는 그대로', { skip: !gitReady }, (t) => {
  const fix = updateFixture(t);
  const bin = path.join(fix.root, 'bin');
  const pyLog = path.join(fix.root, 'python3.log');
  writeExec(path.join(bin, 'python3'), `#!/bin/bash\necho "$*" >> ${JSON.stringify(pyLog)}\nexit 127\n`);
  const agents = path.join(fix.root, 'Library', 'LaunchAgents');
  const install = path.join(fix.root, 'install');
  const apps = path.join(fix.root, 'Applications');
  fs.mkdirSync(agents, { recursive: true });
  fs.mkdirSync(path.join(install, 'requests'), { recursive: true });
  fs.mkdirSync(path.join(apps, 'Workspace.app', 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(agents, 'com.workspace.app.app-refresh.plist'), '<plist/>');
  fs.writeFileSync(path.join(agents, 'com.workspace.app.server.plist'), '<plist/>');
  fs.writeFileSync(path.join(install, 'app-refresh.sh'), '#!/bin/bash\n');
  fs.writeFileSync(path.join(install, 'requests', 'app-refresh.request'), '{}\n');
  fs.writeFileSync(path.join(install, 'app-bundle-name'), 'Workspace\n');
  fs.writeFileSync(path.join(install, 'workspace.env'), 'WORKSPACE_DIR="/nowhere"\n');
  fs.writeFileSync(path.join(apps, 'Workspace.app', 'Contents', 'Info.plist'), 'old');

  const result = fix.run(['--yes']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /v1\.1\.0으로 업데이트했어요/);
  assert.equal(fs.existsSync(pyLog), false, 'python3를 부르지 않는다');
  const calls = fs.readFileSync(path.join(fix.root, 'launchctl.log'), 'utf8').split('\n').filter(Boolean);
  const bootouts = calls.filter(line => line.startsWith('bootout '));
  assert.equal(bootouts.length, 1);
  assert.match(bootouts[0], /^bootout gui\/\d+\/com\.workspace\.app\.app-refresh$/);
  assert.equal(fs.existsSync(path.join(agents, 'com.workspace.app.app-refresh.plist')), false);
  assert.equal(fs.existsSync(path.join(install, 'app-refresh.sh')), false);
  assert.equal(fs.existsSync(path.join(install, 'requests', 'app-refresh.request')), false);
  assert.equal(fs.existsSync(path.join(install, 'app-bundle-name')), false, '옛 이름 기록 파일도 지운다');
  assert.ok(fs.existsSync(path.join(agents, 'com.workspace.app.server.plist')), '다른 등록은 그대로');
  assert.ok(fs.existsSync(path.join(install, 'workspace.env')));
  assert.equal(fs.readFileSync(path.join(apps, 'Workspace.app', 'Contents', 'Info.plist'), 'utf8'), 'old', '~/Applications의 옛 앱은 그대로');
  const script = fs.readFileSync(path.join(REPO_ROOT, 'update.sh'), 'utf8');
  assert.ok(!/python3 -|python3 -c|pkill|killall|xargs kill/.test(script));
});

test('WP-O 없앤 것: app-refresh.sh·Dock 앱 만드는 코드가 저장소 스크립트·서버에 없고, 프로세스를 끄거나 ~/Applications를 지우는 코드도 없다', () => {
  assert.equal(fs.existsSync(automationScript('app-refresh.sh')), false);
  const files = ['setup.sh', 'update.sh', 'make-team-installer.sh', 'tracker/inbox-app/automation/run-task.sh',
    'tracker/inbox-app/personalize.js', 'tracker/inbox-app/routes-personalize.js', 'tracker/inbox-app/server.js', 'tracker/inbox-app/integrations.js'];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    assert.ok(!/osacompile|iconutil|lsregister|app-refresh\.request.*writeFile|writeRefreshRequest|dockNameTaken/.test(text), `${rel}에 Dock 앱 만드는 코드가 없다`);
    assert.ok(!/pkill|killall|xargs kill/.test(text), `${rel}에 프로세스를 이름으로 끄는 코드가 없다`);
    assert.ok(!/rm -rf? [^\n]*Applications/.test(text), `${rel}은 ~/Applications를 지우지 않는다`);
  }
  // setup.sh·update.sh의 bootout은 app-refresh 라벨 하나뿐이다.
  for (const rel of ['setup.sh', 'update.sh']) {
    const text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    const lines = text.split('\n').filter(line => /launchctl bootout/.test(line));
    assert.equal(lines.length, 1, `${rel}: bootout 한 줄`);
    assert.match(lines[0], /com\.workspace\.app\.app-refresh"|\$LABEL\.app-refresh"/);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 슬랙 수집 원문 그대로 모드(`slack.tidy: 'raw'`) — 2026-09-29. Claude가 없는 맥(CLAUDE_BIN이 없는 파일)에서 돈다.

const NO_CLAUDE = home => ({ CLAUDE_BIN: path.join(home, 'claude-없음') });
const shareMsg = (ts, { text = '', memoText = '', author = '김하나', authorId = 'U0KIM', link = 'https://team.slack.com/archives/C0SRC/p1700000000000100', files } = {}) => ({
  type: 'message', user: 'U0ME', ts, text: memoText,
  attachments: [{ is_share: true, from_url: link, channel_id: 'C0SRC', ts: '1700000000.000100', text, author_name: author, author_id: authorId, ...(files ? { files } : {}) }],
});

test('원문 모드: Claude 없이 할 일 채널 메시지를 규칙대로 저장한다 — 슬랙 표기·인사말·목록·긴 글·파일만·공유+메모 (예외 1~5)', (t) => {
  const fix = captureFixture(t, { slack: { tidy: 'raw', channels: { todo: { id: 'C0TODO11', name: '#my-todo' } } } });
  const long = '가'.repeat(250);
  fix.setSlack({
    history: { C0TODO11: [
      memo('1790000001.000100', '*<@U0KIM>* 님께 <#C0AB12|design> 채널 <https://x.example/a|기획서> 확인 &amp; 공유 :pray: `v2` ~옛 안~ _급함_ &lt;필수&gt;'),
      memo('1790000002.000100', '안녕하세요!\n다음 주 배포 일정 공유 부탁드려요\n감사합니다'),
      memo('1790000003.000100', '• 로그인 오류 확인\n• 결제 문구 수정\n• QA 요청'),
      memo('1790000004.000100', long),
      { type: 'message', user: 'U0ME', ts: '1790000005.000100', text: '', files: [{ name: '화면.png', title: '화면.png' }] },
      { type: 'message', user: 'U0ME', ts: '1790000006.000100', text: '', files: [{ name: 'IMG_1.png', title: 'IMG_1.png', alt_txt: '결제 화면 오류 캡처' }] },
      shareMsg('1790000007.000100', { text: '금요일까지 <@U0LEE> 검토 부탁해요\n자세한 건 스레드에', memoText: '내가 챙기기\n둘째 줄' }),
      memo('1790000008.000100', '<https://x.example/b>'),
    ] },
    users: { U0KIM: '김하나', U0LEE: '이두리' },
  });
  const result = fix.run(NO_CLAUDE(fix.home));
  assert.equal(result.status, 0, result.stderr + fix.logText());
  assert.deepEqual(fix.claudeCalls(), [], 'Claude를 부르지 않는다');
  assert.ok(!fix.requests().some(one => one.url.includes('conversations.replies') || one.url.endsWith('/api/items')), '원본 스레드·기존 항목을 읽지 않는다');
  const own = ts => `https://team.slack.com/archives/C0TODO11/p${ts.replace('.', '')}`;
  assert.deepEqual(fix.imports('item'), [
    { type: 'task', description: '@김하나 님께 #design 채널 기획서 확인 & 공유 v2 옛 안 급함 <필수>', permalink: own('1790000001.000100') },
    { type: 'task', description: '안녕하세요! 다음 주 배포 일정 공유 부탁드려요', permalink: own('1790000002.000100') },
    { type: 'task', description: '로그인 오류 확인', permalink: own('1790000003.000100') },
    { type: 'task', description: `${'가'.repeat(200)}…`, permalink: own('1790000004.000100') },
    { type: 'task', description: '(파일) 화면.png', permalink: own('1790000005.000100') },
    { type: 'task', description: '결제 화면 오류 캡처', permalink: own('1790000006.000100') },
    { type: 'task', description: '금요일까지 @이두리 검토 부탁해요 — 내가 챙기기', permalink: own('1790000007.000100') },
    { type: 'task', description: 'https://x.example/b', permalink: own('1790000008.000100') },
  ]);
  assert.ok(fix.imports('item').every(one => !/[\r\n]/.test(one.description) && one.description.length <= 201), '한 줄 · 200자(+…)');
  assert.deepEqual(fix.imports('cursor'), [{ channel: 'my-todo', ts: '1790000008.000100' }]);
  const log = fix.logText();
  assert.match(log, /^이번에 본 메시지 8개 = 등록 8 · 링크 중복 0 · 비슷한 일이라 건너뜀 0 · 시스템 0$/m);
  assert.match(log, /^my-todo · 새 8개 · 저장 8 · 건너뜀 0 · 표시 2 · 원문 그대로$/m);
  assert.match(log, /^⚠️ 글 없이 파일만 있는 메시지: \(파일\) 화면\.png$/m);
  assert.equal(lastLogEvent(log).kind, 'run');
});

test('원문 모드: 확인 대기에도 담당자를 넣지 않음(추측 금지), 날짜가 있어도 기한 없음, 결정은 지라 연결 없음 (예외 6·7)', (t) => {
  const fix = captureFixture(t, { slack: { tidy: 'raw', channels: {
    waiting: { id: 'C0WAIT11', name: '#my-waiting' }, align: { id: 'C0ALIGN1', name: '#my-align' }, someday: { id: 'C0SOME11', name: '#my-someday' },
  } } });
  fix.setSlack({ history: {
    C0WAIT11: [
      shareMsg('1790000001.000100', { text: '10/3까지 시안 회신 드릴게요', author: '김하나', authorId: 'U0KIM' }),
      shareMsg('1790000002.000100', { text: '내일까지 답 주세요', author: '나', authorId: 'U0ME', link: 'https://team.slack.com/archives/C0SRC/p1700000000000200' }),
      memo('1790000003.000100', '2026-10-05까지 법무 검토 받기'),
    ],
    C0ALIGN1: [memo('1790000004.000100', 'PROJ-12 환불 정책: 7일 안이면 전액')],
    C0SOME11: [memo('1790000005.000100', '온보딩 영상 만들어 보기')],
  } });
  const result = fix.run(NO_CLAUDE(fix.home));
  assert.equal(result.status, 0, result.stderr + fix.logText());
  assert.deepEqual(fix.claudeCalls(), []);
  const items = fix.imports('item');
  assert.deepEqual(items.filter(one => one.type === 'check'), [
    { type: 'check', description: '10/3까지 시안 회신 드릴게요', permalink: 'https://team.slack.com/archives/C0SRC/p1700000000000100' },
    { type: 'check', description: '내일까지 답 주세요', permalink: 'https://team.slack.com/archives/C0SRC/p1700000000000200' },
    { type: 'check', description: '2026-10-05까지 법무 검토 받기', permalink: 'https://team.slack.com/archives/C0WAIT11/p1790000003000100' },
  ], '담당자·기한은 넣지 않는다');
  assert.deepEqual(items.find(one => one.type === 'decision'), { type: 'decision', description: 'PROJ-12 환불 정책: 7일 안이면 전액', permalink: 'https://team.slack.com/archives/C0ALIGN1/p1790000004000100' }, '지라 키가 보여도 연결하지 않는다');
  assert.deepEqual(items.find(one => one.type === 'idea'), { type: 'idea', description: '온보딩 영상 만들어 보기', permalink: 'https://team.slack.com/archives/C0SOME11/p1790000005000100' });
  assert.ok(items.every(one => one.due === undefined && one.jira === undefined && one.priority === undefined && one.who === undefined));
});

test('원문 모드: 링크 중복은 지금처럼 건너뛰고, 밀린 메시지는 한 회차 최대 개수까지만 — 나머지는 다음 회차 (예외 11·12)', (t) => {
  const fix = captureFixture(t, { slack: { tidy: 'raw', channels: { todo: { id: 'C0TODO11', name: '#my-todo' } } } });
  fix.setSlack({
    history: { C0TODO11: [memo('1790000001.000100', '가'), memo('1790000002.000100', '나'), memo('1790000003.000100', '다'), { type: 'message', subtype: 'channel_join', user: 'U0ME', ts: '1790000000.000100', text: '들어옴' }] },
    dupLinks: ['https://team.slack.com/archives/C0TODO11/p1790000001000100'],
  });
  assert.equal(fix.run({ ...NO_CLAUDE(fix.home), SLACK_COLLECT_MAX_MESSAGES: '3' }).status, 0, fix.logText());
  assert.deepEqual(fix.imports('item').map(one => one.description), ['가', '나'], '시스템 메시지는 거르고, 넣은 데까지만');
  assert.deepEqual(fix.imports('cursor'), [{ channel: 'my-todo', ts: '1790000002.000100' }], '넣은 데까지만 커서');
  const log = fix.logText();
  assert.match(log, /^my-todo · 새 3개 · 저장 1 · 건너뜀 2 \(시스템 1 · 링크 중복 1\) · 원문 그대로 · 남은 1개는 다음 회차$/m);
  assert.match(log, /^이번에 본 메시지 3개 = 등록 1 · 링크 중복 1 · 비슷한 일이라 건너뜀 0 · 시스템 1$/m);
});

test('원문 모드가 아니면(칸 없음·claude) 예전처럼 Claude로 다듬고, Claude가 실패하면 원문으로 대신 넣지 않는다 (예외 8·9)', (t) => {
  for (const tidy of [undefined, 'claude']) {
    const fix = captureFixture(t, { slack: { ...(tidy ? { tidy } : {}), channels: { todo: { id: 'C0TODO11', name: '#my-todo' } } } });
    fix.setSlack({ history: { C0TODO11: [memo('1790000001.000100', '원문 문구')] } });
    assert.equal(fix.run().status, 0, fix.logText());
    assert.equal(fix.claudeCalls().length, 1, `${tidy || '칸 없음'}: Claude를 부른다`);
    assert.deepEqual(fix.imports('item').map(one => one.description), ['할 일 1790000001.000100'], 'Claude의 문구로 저장');
    assert.doesNotMatch(fix.logText(), /원문 그대로/);
    const failed = fix.run({ FAKE_CLAUDE_MODE: 'exit' });
    assert.equal(failed.status, 1);
    assert.deepEqual(fix.imports('item'), [], 'Claude가 실패해도 원문으로 대신 넣지 않는다');
    assert.deepEqual(fix.imports('cursor'), [], '커서 그대로 — 다음 회차에 다시');
    assert.match(lastLogEvent(fix.logText()).text, /분류 실패\(exit 3\).* — 커서 그대로/);
  }
});

test('원문 규칙(slackPlain·firstLine): 모르는 사람은 표시 이름·id로, @here·그룹 멘션, 짧은 첫 줄 한 번만 이어 붙임', () => {
  const { slackPlain, firstLine } = require('./slack-collect');
  assert.equal(slackPlain('<@U0NOPE> <@U0X|하늘> <!here> <!subteam^S01|@디자인팀> <mailto:a@b.c|a@b.c>'), '@U0NOPE @하늘 @here @디자인팀 a@b.c');
  assert.equal(slackPlain('snake_case_name 10:30:00 3.5'), 'snake_case_name 10:30:00 3.5', '글자 속 밑줄·시각은 건드리지 않는다');
  assert.equal(firstLine('네\n좋아요\n그럼 진행해요'), '네 좋아요', '한 번만 이어 붙인다');
  assert.equal(firstLine('1. 첫째\n2. 둘째'), '첫째', '목록 첫 항목은 짧아도 다음 항목을 붙이지 않는다');
  assert.equal(firstLine('> 인용한 글입니다 길게 적어 둠\n메모'), '인용한 글입니다 길게 적어 둠');
  assert.equal(firstLine(''), '');
});

test('원문 모드 슬랙 표기 정리는 단어 경계에서만 — 범위 표기(3~5명)·곱셈(2*3*4)·주소 속 콜론은 망가뜨리지 않는다', () => {
  const { slackPlain } = require('./slack-collect');
  assert.equal(slackPlain('3~5명, 7~9명'), '3~5명, 7~9명');
  assert.equal(slackPlain('9/1~9/5, 9/8~9/12'), '9/1~9/5, 9/8~9/12');
  assert.equal(slackPlain('2*3*4 와 a*b'), '2*3*4 와 a*b');
  assert.equal(slackPlain('status:done:ok http://localhost:3000/api:v2:x'), 'status:done:ok http://localhost:3000/api:v2:x');
  const { firstLine } = require('./slack-collect');
  assert.equal(firstLine(slackPlain('*중요* ~취소~ 확인 :smile: 좋아요 :+1:')), '중요 취소 확인 좋아요');
});

test('원문 모드: 이모지만 있는 메시지는 할 일로 넣지 않고 건너뜀(글 없음)으로 남긴다 — 공유는 글이 없어도 링크로 넣는다', () => {
  const { rawItem } = require('./slack-collect');
  const channel = { workspaceUrl: 'https://x.slack.com', id: 'C1', type: 'task' };
  assert.equal(rawItem(channel, { ts: '1.1', user: 'U9', text: ':fire: :+1:' }, {}).empty, true);
  const shared = rawItem(channel, { ts: '1.2', user: 'U9', text: '', attachments: [{ is_share: true, text: '', from_url: 'https://x.slack.com/archives/C2/p1' }] }, {});
  assert.equal(shared.payload.description, '(글 없는 메시지)');
});

test('원문 모드: 같은 원본을 다른 메모로 다시 공유하면 내 메시지 링크로 따로 남고, 붙은 이모지만 있는 메시지도 건너뛴다', () => {
  const { rawItem } = require('./slack-collect');
  const channel = { workspaceUrl: 'https://x.slack.com', id: 'C1', type: 'task' };
  const share = { is_share: true, text: '배포 일정 공유', from_url: 'https://x.slack.com/archives/C2/p100' };
  const first = rawItem(channel, { ts: '1.1', user: 'U9', text: '', attachments: [share] }, {});
  const again = rawItem(channel, { ts: '1.2', user: 'U9', text: '금요일까지 답하기', attachments: [share] }, {});
  assert.equal(first.payload.permalink, 'https://x.slack.com/archives/C2/p100', '메모 없는 공유는 원본 링크');
  assert.equal(again.payload.permalink, 'https://x.slack.com/archives/C1/p12', '메모가 있으면 내 메시지 링크');
  assert.equal(rawItem(channel, { ts: '1.3', user: 'U9', text: ':fire::+1:' }, {}).empty, true);
});

// setup.sh는 실행하지 않는다 — 맥 캘린더 등록 조각만 임시 폴더에 plist로 써 보고(launchctl은 부르지 않는다) 모양을 본다.
test('WP-V setup.sh: 맥 캘린더 갈래면 mac-calendar(매일 8–20시 30분마다 + 등록될 때 한 번), 확인용 mac-calendar-now는 늘 — calendar-sync는 내린다', () => {
  const script = fs.readFileSync(path.join(REPO_ROOT, 'setup.sh'), 'utf8');
  assert.match(script, /\[ "\$USE_CAL" = "yes" \] && \[ "\$CAL_SOURCE" = "mac" \] && USE_MAC_CAL="yes" && USE_CAL_SYNC="no"/);
  assert.match(script, /\[ "\$USE_MAC_CAL" = "yes" \] \|\| remove_agent mac-calendar\n/);
  assert.doesNotMatch(script, /remove_agent mac-calendar-now/, '확인용은 갈래와 무관하게 늘 둔다');
  assert.match(script, /cp "\$APP_DIR\/automation\/mac-calendar\.sh" "\$INSTALL_DIR\/"/, '실행기도 설치 위치로 복사한다');
  const update = fs.readFileSync(path.join(REPO_ROOT, 'update.sh'), 'utf8');
  assert.match(update, /\[ -f "\$APP_DIR\/automation\/mac-calendar\.sh" \] && cp "\$APP_DIR\/automation\/mac-calendar\.sh" "\$INSTALL_DIR\/"/, '업데이트도 복사본을 갱신한다');

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-setup-mac-'));
  const escape = script.split('xml_escape() {')[1].split('\n}\n')[0];
  const piece = script.slice(script.indexOf('mac_calendar_intervals() {'), script.indexOf('# 미팅 노트 가져오기 — 일정표가 없다.'));
  const run = mac => spawnSync('/bin/bash', ['-c', `AGENTS_DIR=${JSON.stringify(home)}; LABEL=com.workspace.app; INSTALL_DIR='/x/inst & co'; WORKSPACE=/x/ws; USE_MAC_CAL=${mac}\nxml_escape() {${escape}\n}\n${piece}`], { encoding: 'utf8' });
  assert.equal(run('no').status, 0);
  assert.equal(fs.existsSync(path.join(home, 'com.workspace.app.mac-calendar.plist')), false, '맥 캘린더 갈래가 아니면 주기 읽기는 없다');
  const now = fs.readFileSync(path.join(home, 'com.workspace.app.mac-calendar-now.plist'), 'utf8');
  assert.match(now, /<string>\/x\/inst &amp; co\/mac-calendar\.sh<\/string>\n\s*<string>now<\/string>/);
  assert.match(now, /<key>WatchPaths<\/key>\n\s*<array>\n\s*<string>\/x\/inst &amp; co\/requests\/mac-calendar\.request<\/string>/);
  assert.match(now, /<key>RunAtLoad<\/key>\n\s*<false\/>/);
  assert.equal(run('yes').status, 0);
  const every = fs.readFileSync(path.join(home, 'com.workspace.app.mac-calendar.plist'), 'utf8');
  assert.match(every, /<string>\/x\/inst &amp; co\/mac-calendar\.sh<\/string>\n\s*<string>run<\/string>/);
  const slots = [...every.matchAll(/<key>Hour<\/key><integer>(\d+)<\/integer><key>Minute<\/key><integer>(\d+)<\/integer>/g)].map(m => `${m[1]}:${m[2]}`);
  assert.equal(slots.length, 25);
  assert.equal(slots[0], '8:0');
  assert.equal(slots[24], '20:0');
  assert.match(every, /<key>RunAtLoad<\/key>\n\s*<true\/>/, '연결하자마자 한 번 읽는다');
  assert.match(every, /logs\/mac-calendar\.err/);
  if (fs.existsSync('/usr/bin/plutil')) {
    for (const name of ['mac-calendar', 'mac-calendar-now']) {
      assert.equal(spawnSync('/usr/bin/plutil', ['-lint', path.join(home, `com.workspace.app.${name}.plist`)]).status, 0, name);
    }
  }
  fs.rmSync(home, { recursive: true, force: true });

  // 티로 프롬프트: mac이면 캘린더 갱신을 시도하지 않고 calendar_today.md를 그대로 쓴다
  assert.match(script, /\\"mac\\"이면 캘린더 갱신을 시도하지 말고 tracker\/calendar_today\.md를 그대로 써라/);
});

test('WP-V run-task.sh: 캘린더가 맥 캘린더 갈래면 calendar-sync는 claude를 부르지 않고 건너뛴다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-run-mac-'));
  const logs = path.join(home, 'logs');
  const config = path.join(home, 'workspace.config.json');
  fs.writeFileSync(config, JSON.stringify({ integrations: { calendar: true }, calendar: { source: 'mac' } }));
  const claude = path.join(home, 'claude');
  fs.writeFileSync(claude, '#!/bin/bash\necho "불리면 안 된다" >&2\nexit 9\n');
  fs.chmodSync(claude, 0o755);
  const env = { WORKSPACE_DIR: home, WORKSPACE_CONFIG: config, AUTOMATION_LOG_DIR: logs, CLAUDE_BIN: claude, WORKSPACE_CLAUDE_TOKEN_FILE: path.join(home, 'no-token') };
  assert.equal(runScript(automationScript('run-task.sh'), ['calendar-sync', '프롬프트', 'Read'], env).status, 0);
  assert.match(fs.readFileSync(path.join(logs, 'calendar-sync.log'), 'utf8'), /calendar-sync 맥 캘린더에서 읽고 있어 건너뛰어요/);
  fs.rmSync(home, { recursive: true, force: true });
});

// setup.sh는 실행하지 않는다 — 등록 루프 조각만 가짜 launchctl·plutil로 돌려 본다(실제 launchd에 닿지 않는다).
test('WP-V setup.sh: mac-calendar-now는 plist 내용이 그대로면 다시 올리지 않고, 바뀌었거나 처음이면 올린다', () => {
  const script = fs.readFileSync(path.join(REPO_ROOT, 'setup.sh'), 'utf8');
  assert.match(script, /OLD_MAC_NOW_PLIST="\$\(cat "\$AGENTS_DIR\/\$LABEL\.mac-calendar-now\.plist" 2>\/dev\/null\)"\ncat > "\$AGENTS_DIR\/\$LABEL\.mac-calendar-now\.plist"/, '쓰기 전에 전 내용을 적어 둔다');
  const from = script.indexOf('for f in server slack-capture calendar-sync');
  const loop = script.slice(from, script.indexOf('\ndone\n', from) + 6);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-setup-reload-'));
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  const calls = path.join(home, 'launchctl.log');
  writeExec(path.join(bin, 'launchctl'), `#!/bin/bash\necho "$@" >> ${JSON.stringify(calls)}\nexit 0\n`);
  writeExec(path.join(bin, 'plutil'), '#!/bin/bash\nexit 0\n');
  fs.writeFileSync(path.join(home, 'com.workspace.app.mac-calendar-now.plist'), '<plist>같은 내용</plist>');
  const run = (old) => {
    fs.rmSync(calls, { force: true });
    const r = spawnSync('/bin/bash', ['-c', `AGENTS_DIR=${JSON.stringify(home)}; LABEL=com.workspace.app; IN_RUNNER=''; OLD_SERVER_PLIST=''; OLD_MAC_NOW_PLIST=${JSON.stringify(old)}\nok() { echo "$1"; }\ndie() { exit 1; }\n${loop}`], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return { out: r.stdout, calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '' };
  };
  const same = run('<plist>같은 내용</plist>');
  assert.match(same.out, /mac-calendar-now 그대로/);
  assert.equal(same.calls, '', '내용이 같으면 launchctl을 부르지 않는다');
  const changed = run('<plist>옛 내용</plist>');
  assert.match(changed.calls, /unload .*mac-calendar-now\.plist\nload .*mac-calendar-now\.plist/);
  const first = run('');
  assert.match(first.calls, /load .*mac-calendar-now\.plist/, '처음이면 올린다');
  fs.rmSync(home, { recursive: true, force: true });
});

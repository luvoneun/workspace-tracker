const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

// 임시 git 저장소·임시 장부 자리·가짜 claude/장부 명령만 쓴다 — 진짜 세션·장부는 건드리지 않는다.
const SCRIPT = path.join(__dirname, '../../tools/after-merge.sh');
function git(cwd, ...a) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8' });
}
function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'am-test-'));
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a'), '1');
  git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'init');
  const board = path.join(tmp, 'board');
  fs.mkdirSync(path.join(board, 'launch-queue', 'launched'), { recursive: true });
  fs.mkdirSync(path.join(board, 'ledger'));
  const calls = path.join(tmp, 'calls.log');
  const claude = path.join(tmp, 'claude');
  fs.writeFileSync(claude, `#!/bin/sh\necho "claude $*" >> "${calls}"\nif [ "$1" = agents ]; then echo '[{"sessionId":"abcd1234-0000-0000-0000-000000000000"}]'; fi\n`, { mode: 0o755 });
  const ledger = path.join(tmp, 'ledger.js');
  fs.writeFileSync(ledger, `require('fs').appendFileSync(${JSON.stringify(calls)}, 'ledger ' + process.argv[3] + '\\n');\n`);
  fs.writeFileSync(path.join(board, 'launch-queue', 'launched', 'impl.json'), JSON.stringify({ task: 'impl', sessionId: 'abcd1234-0000-0000-0000-000000000000' }));
  const env = { ...process.env, AFTER_MERGE_CLAUDE: claude, AFTER_MERGE_LEDGER_JS: ledger, AFTER_MERGE_BOARD: board };
  const run = (...args) => spawnSync('bash', [SCRIPT, ...args], { cwd: repo, env, encoding: 'utf8' });
  const log = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '');
  return { repo, run, log, tmp };
}
function mergedBranch(repo, name, { wt = true } = {}) {
  git(repo, 'branch', name);
  const dir = path.join(repo, '.claude', 'worktrees', name);
  if (wt) git(repo, 'worktree', 'add', '-q', dir, name);
  return dir;
}

test('--dry-run은 할 일만 보이고 아무것도 바꾸지 않는다', () => {
  const s = setup();
  const dir = mergedBranch(s.repo, 'feat');
  const r = s.run('feat', '--task', 'impl', '--merge-task', 'mrg', '--dry-run');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /claude stop abcd1234/);
  assert.match(r.stdout, /git worktree remove/);
  assert.match(r.stdout, /git branch -d feat/);
  assert.match(r.stdout, /"task":"mrg"/);
  assert.ok(fs.existsSync(dir));
  assert.match(git(s.repo, 'branch', '--list', 'feat'), /feat/);
  assert.doesNotMatch(s.log(), /claude stop|ledger/);
});

test('합쳐지지 않은 가지면 멈추고 아무것도 안 한다', () => {
  const s = setup();
  git(s.repo, 'checkout', '-q', '-b', 'wip');
  fs.writeFileSync(path.join(s.repo, 'b'), '2');
  git(s.repo, 'add', '.'); git(s.repo, 'commit', '-q', '-m', 'wip');
  git(s.repo, 'checkout', '-q', 'main');
  const r = s.run('wip', '--task', 'impl');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /합쳐지지 않았음/);
  assert.match(git(s.repo, 'branch', '--list', 'wip'), /wip/);
  assert.equal(s.log(), '');
});

test('복사본에 커밋 안 된 파일이 있으면 목록을 보이고 멈춘다', () => {
  const s = setup();
  const dir = mergedBranch(s.repo, 'feat');
  fs.writeFileSync(path.join(dir, 'dirty.txt'), 'x');
  const r = s.run('feat', '--task', 'impl');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /dirty\.txt/);
  assert.ok(fs.existsSync(dir));
  assert.match(git(s.repo, 'branch', '--list', 'feat'), /feat/);
  assert.equal(s.log(), '');
});

test('실제 실행(가짜 claude·장부): 세션 종료·복사본·가지 삭제·장부 두 줄', () => {
  const s = setup();
  const dir = mergedBranch(s.repo, 'feat');
  const r = s.run('feat', '--task', 'impl', '--merge-task', 'mrg');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(dir));
  assert.equal(git(s.repo, 'branch', '--list', 'feat').trim(), '');
  const log = s.log();
  assert.match(log, /claude stop abcd1234/);
  assert.match(log, /ledger \{"task":"mrg","state":"done"/);
  assert.match(log, /ledger \{"task":"impl","state":"done"/);
  // 영수증 사다리가 "합침"의 증거로 세려면 조율이 적은 줄이어야 한다(by:조율)
  assert.match(log, /ledger \{"task":"mrg","state":"done","say":"합쳤어요\. main [0-9a-f]+\.","by":"조율"\}/);
});

test('세션 id를 못 찾으면 그 단계만 건너뛰고 stop은 부르지 않는다', () => {
  const s = setup();
  mergedBranch(s.repo, 'feat', { wt: false });
  const r = s.run('feat', '--task', 'nosuch');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /세션 id 를 못 찾음/);
  assert.doesNotMatch(s.log(), /claude stop/);
});

test('스크립트에 kill 계열·강제 삭제가 없다', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8').split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  assert.doesNotMatch(src, /\b(kill|pkill|killall)\b|rm -rf|branch -D|--force|worktree remove -f/);
});

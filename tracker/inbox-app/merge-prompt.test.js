const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { run, classify } = require('../../tools/merge-prompt.js');

// 모든 시험은 임시 git 저장소 안에서만 돈다 — 진짜 저장소·~/.session-board·네트워크·launchctl은 쓰지 않는다.
function sh(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
}
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-test-'));
  sh(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'init');
  return dir;
}
function branchWith(dir, name, files, from = 'main') {
  sh(dir, 'checkout', '-q', '-b', name, from);
  for (const [f, body] of Object.entries(files)) {
    const p = path.join(dir, f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', `${name} 변경`);
  sh(dir, 'checkout', '-q', 'main');
}
function gen(repo, args) {
  let o = '';
  let e = '';
  const code = run([...args, '--repo', repo], { stdout: (s) => { o += s; }, stderr: (s) => { e += s; } });
  return { code, out: o, err: e };
}
const BASE = ['--task', 't1', '--name', '세션', '--summary', '요약 문단'];
const IA = 'tracker/inbox-app/';

test('classify: 파일 경로로 종류를 가른다', () => {
  assert.equal(classify(`${IA}ui.css`), '화면');
  assert.equal(classify(`${IA}meetings-ui.js`), '화면');
  assert.equal(classify(`${IA}app.js`), '화면');
  assert.equal(classify(`${IA}server.js`), '서버');
  assert.equal(classify(`${IA}slack-collect.js`), '서버');
  assert.equal(classify(`${IA}automation/slack-capture.sh`), '스크립트');
  assert.equal(classify('DESIGN.md'), '문서');
  assert.equal(classify(`${IA}client.test.js`), '시험');
  assert.equal(classify(`${IA}test-support.js`), '시험');
});

test('화면 파일: 파일 목록·개수 정확, 간격 측정 줄 포함, 시험 1번, 서버 블록 없음', () => {
  const r = makeRepo();
  branchWith(r, 'b1', { [`${IA}ui.css`]: 'a{}\n', 'DESIGN.md': 'd\n', [`${IA}client.test.js`]: 't\n' });
  const { code, out } = gen(r, ['b1', ...BASE, '--dry-run']);
  assert.equal(code, 0);
  assert.match(out, /정확히 3개\*\*여야 함: DESIGN\.md, tracker\/inbox-app\/client\.test\.js, tracker\/inbox-app\/ui\.css/);
  assert.match(out, /간격 측정\(필수\)/);
  assert.match(out, /간격 N곳·잘림 N곳/);
  assert.match(out, /전체 시험 \*\*1번\*\*/);
  assert.doesNotMatch(out, /안전 검사 강화/);
  assert.match(out, /모델: sonnet/);
  assert.match(out, /ui\.css \+1\/-0/);
  assert.match(out, /git merge --ff-only b1/);
  assert.match(out, /open-queued\.mjs t1/);
});

test('화면 파일 없으면 간격 줄이 없다', () => {
  const r = makeRepo();
  branchWith(r, 'b1', { 'DESIGN.md': 'd\n' });
  const { out } = gen(r, ['b1', ...BASE, '--dry-run']);
  assert.doesNotMatch(out, /간격 측정/);
});

test('서버 파일: 안전 검사 강화·시험 2번·opus·되돌림 기준·Codex 미검토 줄', () => {
  const r = makeRepo();
  const baseTip = sh(r, 'rev-parse', '--short', 'main').trim();
  branchWith(r, 'b1', { [`${IA}server.js`]: 'x\n' });
  const { out } = gen(r, ['b1', ...BASE, '--dry-run']);
  assert.match(out, /안전 검사 강화/);
  assert.match(out, /전체 시험 \*\*2번\*\*/);
  assert.match(out, /모델: opus/);
  assert.match(out, new RegExp(`git reset --keep ${baseTip}`));
  assert.match(out, /Codex 미검토 — 합치기 전에 조율에게 확인/);
  assert.match(out, /server\.js \+1\/-0/);
  assert.doesNotMatch(out, /간격 측정/);
});

test('검수 플래그를 주면 미검토 줄 대신 검수 상태를 적는다', () => {
  const r = makeRepo();
  branchWith(r, 'b1', { [`${IA}server.js`]: 'x\n' });
  const { out } = gen(r, ['b1', ...BASE, '--codex-done', '--opus-review-done', '--dry-run']);
  assert.match(out, /검수 상태: Codex 읽기 전용 검토 받음 · Opus 검수 받음/);
  assert.doesNotMatch(out, /Codex 미검토/);
});

test('automation 파일: 설치본 복사 블록, 없으면 변경 없음 한 줄', () => {
  const r = makeRepo();
  branchWith(r, 'b1', { [`${IA}automation/slack-capture.sh`]: '#!/bin/sh\n' });
  branchWith(r, 'b2', { 'DESIGN.md': 'd\n' });
  const a = gen(r, ['b1', ...BASE, '--dry-run']).out;
  assert.match(a, /설치본 복사 필수/);
  assert.match(a, /~\/\.local\/share\/workspace-automation\/slack-capture\.sh/);
  assert.match(a, /조율에게 먼저 물어/);
  const b = gen(r, ['b2', ...BASE, '--dry-run']).out;
  assert.match(b, /automation\/ 변경 없음 확인\(설치본 복사 불필요\)/);
  assert.doesNotMatch(b, /설치본 복사 필수/);
});

test('문서·시험만: 시험 1번, 재시작 생략 가능, 4321·4340 확인은 남김', () => {
  const r = makeRepo();
  branchWith(r, 'b1', { 'docs/a.md': 'a\n', [`${IA}x.test.js`]: 't\n' });
  const { out } = gen(r, ['b1', ...BASE, '--dry-run']);
  assert.match(out, /전체 시험 \*\*1번\*\*/);
  assert.match(out, /재시작은 생략해도 됨.*4321·4340/);
  assert.doesNotMatch(out, /launchctl kickstart/);
});

test('항상 들어가는 줄: 금지 목록·안전장치 8개·재시작·끝 보고', () => {
  const r = makeRepo();
  branchWith(r, 'b1', { [`${IA}ui.css`]: 'a{}\n' });
  const { out } = gen(r, ['b1', ...BASE, '--dry-run']);
  for (const s of ['git push', 'release.sh', '태그', 'VERSION', '소식.md', 'request·showNotice·pushUndo·recordUndoFor·toggleTask·fadeOutAndRun·isClientFile·RECOVERY_NEEDED',
    'launchctl kickstart -k gui/$(id -u)/com.workspace.app.server', './tryout.sh restart', 'kill 계열', '미추적', '발견했지만 안 건드린 것', '미푸시 커밋 수', '항목 개수만']) {
    assert.ok(out.includes(s), `없음: ${s}`);
  }
  assert.match(out, /"task":"t1","stage":"합치기"/);
});

test('한글 파일명은 인용 부호 없이 풀어서 적는다', () => {
  const r = makeRepo();
  branchWith(r, 'b1', { '소식.md': 'a\n', 'docs/합치기-글.md': 'b\n' });
  const { out } = gen(r, ['b1', ...BASE, '--dry-run']);
  assert.match(out, /정확히 2개\*\*여야 함: docs\/합치기-글\.md, 소식\.md/);
  assert.doesNotMatch(out, /\\\d{3}/);
});

test('가지가 base 위가 아니면 --no-ff 안내', () => {
  const r = makeRepo();
  branchWith(r, 'b1', { 'a.md': 'a\n' });
  fs.writeFileSync(path.join(r, 'm.md'), 'm\n');
  sh(r, 'add', '.');
  sh(r, 'commit', '-q', '-m', 'main 앞서감');
  const { out } = gen(r, ['b1', ...BASE, '--dry-run']);
  assert.match(out, /--no-ff로 합침/);
  assert.match(out, /git merge --no-ff b1 -m/);
  assert.doesNotMatch(out, /git merge --ff-only/);
});

test('여러 가지: 순서대로 절을 붙이고 뒤 가지는 --no-ff', () => {
  const r = makeRepo();
  branchWith(r, 'first', { 'a.md': 'a\n' });
  branchWith(r, 'second', { 'b.md': 'b\n' });
  const { out } = gen(r, ['first', 'second', ...BASE, '--dry-run']);
  assert.ok(out.indexOf('### ① first') < out.indexOf('### ② second'));
  assert.match(out, /git merge --ff-only first/);
  assert.match(out, /git merge --no-ff second/);
  assert.match(out, /앞 가지가 합쳐지면 main이 앞서므로/);
  assert.match(out, /first → second/);
});

test('바뀐 파일 0개·없는 가지·필수 옵션 빠짐은 에러', () => {
  const r = makeRepo();
  sh(r, 'branch', 'same');
  let g = gen(r, ['same', ...BASE, '--dry-run']);
  assert.equal(g.code, 1);
  assert.match(g.err, /바뀐 파일이 0개/);
  g = gen(r, ['nope', ...BASE, '--dry-run']);
  assert.equal(g.code, 1);
  assert.match(g.err, /가지를 찾을 수 없음/);
  g = gen(r, ['same', '--task', 't', '--dry-run']);
  assert.equal(g.code, 1);
  assert.match(g.err, /--name 필요/);
  g = gen(r, ['same', '--task', '../x', '--name', 'n', '--summary', 's', '--dry-run']);
  assert.equal(g.code, 1);
  assert.match(g.err, /--task/);
});

test('--out 임시 폴더에 .md/.json만 쓰고, 이미 있으면 에러, --force로만 덮어씀', () => {
  const r = makeRepo();
  branchWith(r, 'b1', { 'a.md': 'a\n' });
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-out-'));
  const first = gen(r, ['b1', ...BASE, '--out', outDir]);
  assert.equal(first.code, 0);
  assert.deepEqual(fs.readdirSync(outDir).sort(), ['t1.json', 't1.md']);
  const json = JSON.parse(fs.readFileSync(path.join(outDir, 't1.json'), 'utf8'));
  assert.deepEqual(Object.keys(json), ['task', 'name', 'project', 'account', 'model', 'cwd', 'promptFile', 'note']);
  assert.equal(json.project, '워크');
  assert.equal(json.account, '루렌');
  assert.equal(json.promptFile, 't1.md');
  assert.equal(json.model, 'sonnet');
  assert.equal(json.cwd, fs.realpathSync(r));
  assert.match(first.out, /node \/Users\/luvon\/session-board\/app\/bin\/open-queued\.mjs t1/);
  fs.writeFileSync(path.join(outDir, 't1.md'), 'KEEP');
  const again = gen(r, ['b1', ...BASE, '--out', outDir]);
  assert.equal(again.code, 1);
  assert.match(again.err, /이미 있음/);
  assert.equal(fs.readFileSync(path.join(outDir, 't1.md'), 'utf8'), 'KEEP');
  const forced = gen(r, ['b1', ...BASE, '--out', outDir, '--force']);
  assert.equal(forced.code, 0);
  assert.notEqual(fs.readFileSync(path.join(outDir, 't1.md'), 'utf8'), 'KEEP');
});

test('--dry-run은 아무것도 쓰지 않는다', () => {
  const r = makeRepo();
  branchWith(r, 'b1', { 'a.md': 'a\n' });
  const outDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mp-dry-')), 'q');
  const g = gen(r, ['b1', ...BASE, '--out', outDir, '--dry-run']);
  assert.equal(g.code, 0);
  assert.equal(fs.existsSync(outDir), false);
  assert.match(g.out, /dry-run/);
});

test('--model 지정이 우선하고 근거 주석을 맨 위에 적는다', () => {
  const r = makeRepo();
  branchWith(r, 'b1', { 'a.md': 'a\n' });
  const { out } = gen(r, ['b1', ...BASE, '--model', 'opus', '--dry-run']);
  assert.match(out.split('\n')[0], /^<!-- 모델: opus — --model 로 지정/);
});

test('도구 코드는 open-queued·launchctl·네트워크를 실행하지 않는다', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../tools/merge-prompt.js'), 'utf8');
  const execCalls = src.match(/execFileSync\([^)]*\)/g) || [];
  assert.ok(execCalls.every((c) => /'git'/.test(c)), '실행하는 바깥 프로그램은 git뿐');
  assert.doesNotMatch(src, /require\('node:(http|https|net)'\)/);
  assert.doesNotMatch(src, /\bspawn\w*\(/);
});

test('입력·클릭 파일이 바뀌면 사람 속도 확인 줄이 붙고, 아니면 안 붙는다', () => {
  const r = makeRepo();
  branchWith(r, 'b1', { [`${IA}report-ui.js`]: 'x\n' });
  branchWith(r, 'b2', { [`${IA}ui.css`]: 'a{}\n' });
  const yes = gen(r, ['b1', ...BASE, '--dry-run']).out;
  assert.match(yes, /## 사람 속도 확인/);
  assert.match(yes, /imeSetComposition/);
  assert.match(yes, /누름 100ms/);
  const no = gen(r, ['b2', ...BASE, '--dry-run']).out;
  assert.doesNotMatch(no, /사람 속도 확인/);
});

test('--summary에 백틱이 있으면 거절한다', () => {
  const r = makeRepo();
  branchWith(r, 'b1', { 'a.md': 'a\n' });
  const g = gen(r, ['b1', '--task', 't1', '--name', '세션', '--summary', '명령 `x` 포함', '--dry-run']);
  assert.equal(g.code, 1);
  assert.match(g.err, /백틱 대신 「」/);
});

test('끝 안내에 after-merge 정리 명령이 찍힌다', () => {
  const r = makeRepo();
  branchWith(r, 'b1', { 'a.md': 'a\n' });
  assert.match(gen(r, ['b1', ...BASE, '--dry-run']).out, /tools\/after-merge\.sh b1 --task <구현 이름표> --merge-task t1/);
});

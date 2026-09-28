// release.sh(저장소 뿌리) — 쉬운 말 소식(WP-J) 없으면 배포를 막는 조각만 확인한다.
// 실제 태그·커밋·푸시는 하지 않는다: release.sh를 통째로 임시 폴더에 복사해 돌리므로(그 폴더는 git 저장소가
// 아니다) `git status`·`git rev-parse` 같은 안쪽 호출은 전부 조용히 실패하고 넘어간다 — 이 검사는 그보다
// 앞서 있어서 실제 git 동작 없이도 멈추는지 확인할 수 있다.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');
const RELEASE_SH = fs.readFileSync(path.join(REPO_ROOT, 'release.sh'), 'utf8');

test('release.sh 소스에 소식.md 검사 조각이 있다(문자열)', () => {
  assert.match(RELEASE_SH, /소식\.md에 v\$NEW 소식을 먼저 적어 주세요/);
  assert.match(RELEASE_SH, /NEWS_FILE="\$WORKSPACE\/소식\.md"/);
});

// release.sh를 임시 폴더에 그대로 복사해 돌린다 — WORKSPACE는 `dirname BASH_SOURCE`로 그 임시 폴더가 된다.
function releaseFixture(t, { news = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-release-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'release.sh'), RELEASE_SH);
  fs.writeFileSync(path.join(dir, 'VERSION'), '1.0.0\n');
  if (news !== null) fs.writeFileSync(path.join(dir, '소식.md'), news);
  return dir;
}
const run = (dir, args) => spawnSync('bash', [path.join(dir, 'release.sh'), ...args], { cwd: dir, encoding: 'utf8' });

test('소식.md 자체가 없으면 멈추고 안내한다', (t) => {
  const dir = releaseFixture(t);
  const result = run(dir, ['1.1.0']);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /소식\.md에 v1\.1\.0 소식을 먼저 적어 주세요 — 3~5줄/);
  assert.match(result.stdout, /릴리스를 멈췄어요/);
});

test('소식.md는 있지만 그 버전 절이 없으면 멈추고 안내한다', (t) => {
  const dir = releaseFixture(t, { news: '## v1.0.0 · 2026-09-24\n- 첫 버전\n' });
  const result = run(dir, ['1.1.0']);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /소식\.md에 v1\.1\.0 소식을 먼저 적어 주세요 — 3~5줄/);
});

test('비슷한 버전(v1.1.0 vs v1.1.09)을 섞어 읽지 않는다', (t) => {
  const dir = releaseFixture(t, { news: '## v1.1.09 · 2026-09-28\n- 다른 버전\n' });
  const result = run(dir, ['1.1.0']);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /소식\.md에 v1\.1\.0 소식을 먼저 적어 주세요/);
});

test('그 버전 절이 있으면 검사를 통과하고 다음 단계(테스트 돌리기)로 넘어간다', (t) => {
  const dir = releaseFixture(t, { news: '## v1.1.0 · 2026-09-28\n- 새 소식 한 줄\n' });
  const result = run(dir, ['1.1.0']);
  assert.doesNotMatch(result.stdout, /소식\.md에 v1\.1\.0 소식을 먼저 적어 주세요/);
  assert.match(result.stdout, /소식\.md에 v1\.1\.0 있음/);
  assert.match(result.stdout, /테스트를 돌려요/, '검사를 통과해 다음 단계로 넘어간다(tracker/inbox-app이 없어 이후 실패하는 것은 이 픽스처의 한계다)');
});

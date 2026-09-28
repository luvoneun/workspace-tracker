// 서버: 쉬운 말 소식(WP-J) — GET /api/about의 news · 새 버전 상자의 원격 소식 배선.
// 실제 네트워크는 어디서도 쓰지 않는다: 로컬 파일 읽기 · 로컬 bare 저장소(git) · 가짜 fetch(setRemoteFetchForTests)뿐이다.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const support = require('./test-support');
const { runGit, gitReady, startAppServer } = support;
const serverModule = require('./server');
const { setRemoteFetchForTests, setLatestReleaseForTests, refreshRemoteNews, updateOffer } = serverModule;
let base;
before(async () => { base = await support.ready(); });

// ─────────────────────────────────────────────────────────────────────────────
// C. GET /api/about의 `news` — 저장소 소식.md를 최근 10개 버전까지 읽어 준다.

test('GET /api/about의 news는 저장소 소식.md를 파싱해 준다(형식·최신이 위)', async () => {
  const about = await (await fetch(base + '/api/about')).json();
  assert.ok(Array.isArray(about.news) && about.news.length > 0, '이 저장소의 소식.md를 읽는다');
  const first = about.news[0];
  // 배포 직전에는 소식.md가 VERSION보다 한 버전 앞선다(release.sh는 소식을 확인하고 테스트한 뒤 VERSION을 올린다).
  const parts = v => String(v).split('.').map(Number);
  const [a, b] = [parts(first.version), parts(about.version)];
  const notOlder = a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] >= b[2];
  assert.ok(notOlder, `맨 위는 지금 버전이거나 곧 낼 버전의 소식이다(${first.version} / ${about.version})`);
  assert.match(first.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(Array.isArray(first.lines) && first.lines.length > 0);
  // 최신이 위 — 버전 내림차순
  for (let i = 1; i < about.news.length; i += 1) {
    const a = about.news[i - 1].version.split('.').map(Number);
    const b = about.news[i].version.split('.').map(Number);
    assert.ok(a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2]))), '버전 내림차순');
  }
});

test('news는 최근 10개 버전까지만 담고, 소식.md가 없으면 빈 목록이다', { skip: !gitReady }, async (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-news-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const data = path.join(repo, 'tracker');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(repo, 'VERSION'), '1.12.0\n');
  const sections = Array.from({ length: 12 }, (_, i) => `## v1.${12 - i}.0 · 2026-09-2${(8 - (i % 8))}\n- 줄 ${12 - i}\n`).join('\n');
  fs.writeFileSync(path.join(repo, '소식.md'), sections);
  fs.writeFileSync(path.join(repo, '.gitignore'), 'tracker/\n');

  const app = await startAppServer(t, { WORKSPACE_REPO_DIR: repo, WORKSPACE_DATA_DIR: data, WORKSPACE_CONFIG: path.join(repo, 'absent.json') });
  const about = await (await fetch(app.base + '/api/about')).json();
  assert.equal(about.news.length, 10, '최근 10개까지만');
  assert.equal(about.news[0].version, '1.12.0');

  // 소식.md 자체가 없으면
  fs.rmSync(path.join(repo, '소식.md'));
  const bare = await startAppServer(t, { WORKSPACE_REPO_DIR: repo, WORKSPACE_DATA_DIR: data, WORKSPACE_CONFIG: path.join(repo, 'absent.json') });
  const noFile = await (await fetch(bare.base + '/api/about')).json();
  assert.deepEqual(noFile.news, []);
});

// ─────────────────────────────────────────────────────────────────────────────
// A. 새 버전 상자의 원격 소식 — github이 아니면 묻지 않는다(로컬 bare 저장소만, 네트워크 없음).

function remoteFixtureNoGithub(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-news-remote-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const origin = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  const clone = path.join(root, 'clone');
  fs.mkdirSync(seed);
  fs.writeFileSync(path.join(seed, 'VERSION'), '1.0.0\n');
  fs.writeFileSync(path.join(seed, '소식.md'), '## v1.0.0 · 2026-09-24\n- 첫 버전\n');
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
  fs.writeFileSync(path.join(seed, '소식.md'), '## v1.1.0 · 2026-09-28\n- 새 소식\n\n## v1.0.0 · 2026-09-24\n- 첫 버전\n');
  runGit(seed, ['commit', '-am', '다음 버전']);
  runGit(seed, ['tag', 'v1.1.0']);
  runGit(seed, ['push', '-q', 'origin', 'main', '--tags']);
  fs.mkdirSync(path.join(clone, 'tracker'));
  const config = path.join(clone, 'workspace.config.json');
  fs.writeFileSync(config, JSON.stringify({ server: { updateChannel: 'stable' } }));
  return {
    clone,
    env: {
      WORKSPACE_REPO_DIR: clone, WORKSPACE_DATA_DIR: path.join(clone, 'tracker'), WORKSPACE_CONFIG: config,
      WORKSPACE_NO_REMOTE_CHECK: '', WORKSPACE_AUTOMATION_DIR: path.join(root, 'automation'), WORKSPACE_LAUNCH_AGENTS_DIR: path.join(root, 'agents'),
    },
  };
}

test('새 버전은 있어도 origin이 github.com이 아니면 원격 소식을 묻지 않고 줄 없이 지금처럼', { skip: !gitReady }, async (t) => {
  const fixture = remoteFixtureNoGithub(t);
  const about = await (await fetch((await startAppServer(t, fixture.env)).base + '/api/about')).json();
  assert.equal(about.update.available, true, 'v1.1.0 > v1.0.0');
  assert.equal(about.update.news, null, 'github이 아니면 원격 소식을 읽지 않는다(로컬 소식.md와도 무관)');
});

// ─────────────────────────────────────────────────────────────────────────────
// 배선 확인(가짜 fetch) — 이 저장소의 실제 origin은 github.com이므로 `refreshRemoteNews`가 실제로
// 어떤 주소로 읽으려 하는지, 갈래·태그가 맞을 때만 싣는지를 가짜 fetch로 검증한다. 진짜 네트워크는 없다.

test('원격 소식 성공 — 새 버전이 있으면 그 태그의 소식.md를 읽어 update.news에 싣는다', async (t) => {
  t.after(() => { setLatestReleaseForTests(null); setRemoteFetchForTests(null); });
  setLatestReleaseForTests({ tag: 'v99.0.0', checkedAt: new Date().toISOString() });
  let calledUrl = null;
  setRemoteFetchForTests(async (url) => {
    calledUrl = url;
    return { ok: true, headers: { get: () => null }, arrayBuffer: async () => Buffer.from('## v99.0.0 · 2026-09-28\n- 가짜 새 소식\n', 'utf8') };
  });
  await refreshRemoteNews('stable');
  assert.match(calledUrl, /^https:\/\/raw\.githubusercontent\.com\/.+\/v99\.0\.0\/.+md$/);
  const offer = updateOffer('1.0.0', 'stable');
  assert.equal(offer.available, true);
  assert.deepEqual(offer.news, ['가짜 새 소식']);
});

test('원격 소식 실패(네트워크 오류)는 조용히 news 없음, 새 버전 상자 자체는 그대로', async (t) => {
  t.after(() => { setLatestReleaseForTests(null); setRemoteFetchForTests(null); });
  setLatestReleaseForTests({ tag: 'v99.0.0', checkedAt: new Date().toISOString() });
  setRemoteFetchForTests(async () => { throw new TypeError('network down'); });
  await refreshRemoteNews('stable');
  const offer = updateOffer('1.0.0', 'stable');
  assert.equal(offer.available, true, '읽기 실패와 새 버전 여부는 별개다');
  assert.equal(offer.news, null);
});

test('원격 소식이 200KB를 넘으면 조용히 news 없음', async (t) => {
  t.after(() => { setLatestReleaseForTests(null); setRemoteFetchForTests(null); });
  setLatestReleaseForTests({ tag: 'v99.0.0', checkedAt: new Date().toISOString() });
  setRemoteFetchForTests(async () => ({ ok: true, headers: { get: (name) => (name === 'content-length' ? String(300 * 1024) : null) }, arrayBuffer: async () => { throw new Error('여기까지 오면 안 된다'); } }));
  await refreshRemoteNews('stable');
  assert.equal(updateOffer('1.0.0', 'stable').news, null);
});

test('새 버전이 없으면 원격에 묻지 않는다(가짜 fetch가 불리지 않는다)', async (t) => {
  t.after(() => { setLatestReleaseForTests(null); setRemoteFetchForTests(null); });
  setLatestReleaseForTests(null); // 지금 버전이 최신
  let called = false;
  setRemoteFetchForTests(async () => { called = true; return { ok: true, headers: { get: () => null }, arrayBuffer: async () => Buffer.from('') }; });
  await refreshRemoteNews('stable');
  assert.equal(called, false);
  assert.equal(updateOffer('1.0.0', 'stable').news, null);
});

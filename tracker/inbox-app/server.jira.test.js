// 서버: 지라(읽기·쓰기·목록·완료·연결·옮기기·만들기·배정)·반응 필요. 공용 준비는 test-support.js.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const support = require('./test-support');
const { directory, server, today, post, items, freePort, deadPid, journalEntry, startServer, jiraModule, json, jiraFake, readJson } = support;
let base;
before(async () => { base = await support.ready(); });

// 지라 동기화가 "업무에 연결돼 있는데 기본 조회에서 빠진 이슈"를 적는 구역. 줄 형식은 기본 구역과
// 같아서 구역을 모르는 옛 서버가 읽어도 그냥 이슈로 읽히고(오류 없음), 구역이 없는 옛 파일은
// 지금 서버가 읽어도 예전과 똑같다.
test('지라 캐시는 `그 밖의 이슈` 구역을 extra로 표시하고, 구역 없는 옛 파일도 그대로 읽는다', async () => {
  const jiraPath = path.join(directory, 'jira_issues.md');
  const before = fs.existsSync(jiraPath) ? fs.readFileSync(jiraPath, 'utf8') : null;
  const head = ['# 지라 이슈 (내 담당, 진행중/백로그)', '', '마지막 갱신: 2026-09-24', '', '- IO-1 | 에픽 | 진행 중 | 보드 AI', ''];
  try {
    fs.writeFileSync(jiraPath, head.join('\n'));
    assert.deepEqual((await items()).jiraIssues,
      [{ key: 'IO-1', type: '에픽', status: '진행 중', summary: '보드 AI', extra: false }],
      '구역이 없는 옛 파일은 예전과 같이 전부 보통 이슈다');

    const withSection = [...head, '## 업무에 연결된 그 밖의 이슈', '', '- IO-2 | 에픽 | 완료 | 게임 임베드', '',
      '## 다른 소제목', '', '- IO-3 | 스토리 | Backlog | 알림 로그 정리', ''];
    fs.writeFileSync(jiraPath, withSection.join('\n'));
    assert.deepEqual((await items()).jiraIssues.map(issue => [issue.key, issue.status, issue.extra]),
      [['IO-1', '진행 중', false], ['IO-2', '완료', true], ['IO-3', 'Backlog', false]],
      '그 구역 안의 줄만 extra이고, 다른 소제목이 나오면 다시 보통 이슈로 돌아온다');

    // 옛 서버(구역을 모르는 버전)의 파서 — 새 파일을 읽어도 오류 없이 이슈 셋을 얻는다.
    const legacy = withSection.map(line => line.match(/^- (\S+) \| (.+?) \| (.+?) \| (.+)$/)).filter(Boolean);
    assert.deepEqual(legacy.map(m => m[1]), ['IO-1', 'IO-2', 'IO-3']);
  } finally {
    if (before === null) fs.rmSync(jiraPath, { force: true });
    else fs.writeFileSync(jiraPath, before);
  }
});
const JIRA_SITE = 'https://example-jira.test';
const JIRA_EMAIL = 'someone@example.test';
const JIRA_TOKEN = 'fixture-token-never-real';
const jiraConfig = { jira: { siteUrl: JIRA_SITE, email: JIRA_EMAIL, tokenFile: '/tmp/never-read-this' } };
const jiraSettings = () => jiraModule.jiraSettings(jiraConfig);
const jiraIssueBody = (extra = {}) => ({
  fields: {
    summary: '게시글 작성하기_게임 임베드',
    status: { name: '진행 중', statusCategory: { key: 'indeterminate' } },
    issuetype: { name: '에픽' },
    assignee: { displayName: '루본' },
    duedate: '2026-10-02',
    fixVersions: [{ id: '10101', name: 'v2.70.0', releaseDate: '2026-09-30', released: false }],
    ...extra,
  },
});
// 하위 티켓 — 완료 2 / 전체 3. 3단계부터는 줄에 쓸 값(요약·담당·배포 버전)까지 함께 온다.
// 지라는 담당자 덩어리에 이메일·계정 id도 실어 주지만 앱은 **표시 이름만** 옮긴다(아래 테스트로 고정).
const jiraChildBody = { issues: [
  {
    key: 'IO-48395',
    fields: {
      summary: '임베드 카드 붙이기',
      status: { name: '완료', statusCategory: { key: 'done' } },
      issuetype: { name: '하위 작업' },
      assignee: { displayName: '루본', emailAddress: JIRA_EMAIL, accountId: '5b10a2844c20165700ede21g' },
      fixVersions: [{ id: '10101', name: 'v2.70.0', releaseDate: '2026-09-30', released: false }],
    },
  },
  {
    key: 'IO-48396',
    fields: {
      summary: '임베드 미리보기 붙이기',
      status: { name: '완료', statusCategory: { key: 'done' } },
      issuetype: { name: '하위 작업' },
      assignee: null,
      fixVersions: [],
    },
  },
  {
    key: 'IO-48397',
    fields: {
      summary: '게임 목록 불러오기',
      status: { name: '진행 중', statusCategory: { key: 'indeterminate' } },
      issuetype: { name: '하위 작업' },
      assignee: { displayName: '하늘', emailAddress: 'elly@example.test', accountId: '712020:aaaa' },
      fixVersions: [],
    },
  },
] };
// `children.items` 한 줄의 기대 모양 — 담당은 표시 이름, 배포 버전은 이름뿐이다.
const jiraChildItems = [
  { key: 'IO-48395', url: `${JIRA_SITE}/browse/IO-48395`, summary: '임베드 카드 붙이기', type: '하위 작업', status: { name: '완료', category: 'done' }, assignee: '루본', version: 'v2.70.0' },
  { key: 'IO-48396', url: `${JIRA_SITE}/browse/IO-48396`, summary: '임베드 미리보기 붙이기', type: '하위 작업', status: { name: '완료', category: 'done' }, assignee: null, version: null },
  { key: 'IO-48397', url: `${JIRA_SITE}/browse/IO-48397`, summary: '게임 목록 불러오기', type: '하위 작업', status: { name: '진행 중', category: 'doing' }, assignee: '하늘', version: null },
];

test('지라 읽기는 요약·상태 범주·배포 버전·기한·담당과 하위 집계를 한 덩어리로 돌려준다', async () => {
  const fake = jiraFake({
    '/rest/api/3/issue/IO-48394': () => json(jiraIssueBody()),
    '/rest/api/3/search/jql': () => json(jiraChildBody),
  });
  const client = jiraModule.createJiraClient({ settings: jiraSettings(), request: fake.request, readToken: () => JIRA_TOKEN });
  const issue = await client.getIssueOverview('IO-48394');
  assert.deepEqual(issue, {
    key: 'IO-48394',
    url: `${JIRA_SITE}/browse/IO-48394`,
    summary: '게시글 작성하기_게임 임베드',
    type: '에픽',
    status: { name: '진행 중', category: 'doing' },
    assignee: '루본',
    due: '2026-10-02',
    versions: [{ id: '10101', name: 'v2.70.0', releaseDate: '2026-09-30', released: false }],
    children: { total: 3, done: 2, items: jiraChildItems },
  });
  // 링크는 앱이 조립한다(siteUrl + /browse/KEY) — 지라가 준 self 주소를 쓰지 않는다.
  assert.equal(issue.url, `${JIRA_SITE}/browse/IO-48394`);
  // 요청은 두 번뿐이다: 이슈 하나 + 하위 조회 하나(목록 전체를 미리 부르지 않는다).
  assert.equal(fake.calls.length, 2);
  assert.match(fake.calls[0].url, /fields=summary,status,issuetype,assignee,duedate,fixVersions,subtasks$/);
  // 하위 조회가 받아 오는 칸은 이 다섯뿐이다 — 이메일·계정 id를 달라고 하지 않는다.
  assert.match(fake.calls[1].url, /\/rest\/api\/3\/search\/jql\?jql=parent%3DIO-48394&fields=summary,status,assignee,fixVersions,issuetype&maxResults=100$/);
  // 인증은 Basic 한 벌이고, 그 값은 요청에만 실린다.
  assert.equal(fake.calls[0].headers.Authorization, `Basic ${Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64')}`);
});

test('하위가 search에 없으면 subtasks로 세고, 새 search 주소가 없으면 옛 주소로 한 번 물러선다', async () => {
  const subtasks = [
    { key: 'AB-2', fields: { summary: '먼저 한 것', status: { name: '완료', statusCategory: { key: 'done' } } } },
    { key: 'AB-3', fields: { summary: '아직 안 한 것', status: { name: '할 일', statusCategory: { key: 'new' } } } },
  ];
  const fallback = jiraFake({
    '/rest/api/3/issue/AB-1': () => json(jiraIssueBody({ subtasks })),
    '/rest/api/3/search/jql': () => json({ errorMessages: ['not found'] }, 404),
    '/rest/api/3/search?': () => json(jiraChildBody),
  });
  const fellBack = await jiraModule.createJiraClient({ settings: jiraSettings(), request: fallback.request, readToken: () => JIRA_TOKEN }).getIssueOverview('AB-1');
  assert.deepEqual(fellBack.children, { total: 3, done: 2, items: jiraChildItems });
  assert.equal(fallback.calls.length, 3);

  const empty = jiraFake({
    '/rest/api/3/issue/AB-1': () => json(jiraIssueBody({ subtasks })),
    '/rest/api/3/search': () => json({ issues: [] }),
  });
  const counted = await jiraModule.createJiraClient({ settings: jiraSettings(), request: empty.request, readToken: () => JIRA_TOKEN }).getIssueOverview('AB-1');
  assert.equal(counted.children.total, 2);
  assert.equal(counted.children.done, 1);
  // `subtasks`에는 담당자·배포 버전이 없다 — 그 줄은 `담당 없음`으로 선다(줄 자체는 그대로 보여 준다).
  assert.deepEqual(counted.children.items, [
    { key: 'AB-2', url: `${JIRA_SITE}/browse/AB-2`, summary: '먼저 한 것', type: '', status: { name: '완료', category: 'done' }, assignee: null, version: null },
    { key: 'AB-3', url: `${JIRA_SITE}/browse/AB-3`, summary: '아직 안 한 것', type: '', status: { name: '할 일', category: 'todo' }, assignee: null, version: null },
  ]);

  const none = jiraFake({ '/rest/api/3/issue/AB-1': () => json(jiraIssueBody()), '/rest/api/3/search': () => json({ issues: [] }) });
  assert.equal((await jiraModule.createJiraClient({ settings: jiraSettings(), request: none.request, readToken: () => JIRA_TOKEN }).getIssueOverview('AB-1')).children, null);
});

// ---------- 지라 하위 티켓 목록 (BJR 3단계 — 읽기 전용) ----------
test('하위 티켓 목록은 담당자를 표시 이름으로만 싣고 이메일·계정 id는 어디에도 남기지 않는다', async () => {
  const fake = jiraFake({
    '/rest/api/3/issue/IO-48394': () => json(jiraIssueBody()),
    '/rest/api/3/search/jql': () => json(jiraChildBody),
  });
  const api = jiraModule.createJiraApi({ config: jiraConfig, request: fake.request, readFile: () => JIRA_TOKEN });
  const answer = await api.read('IO-48394');
  assert.deepEqual(answer.issue.children.items, jiraChildItems);
  // 1단계의 `total`/`done`은 그대로다 — 진행률 줄과 기존 화면이 그대로 돈다.
  assert.equal(answer.issue.children.total, 3);
  assert.equal(answer.issue.children.done, 2);
  const payload = JSON.stringify(answer);
  assert.doesNotMatch(payload, new RegExp(JIRA_EMAIL), '지라가 준 담당자 이메일이 응답에 실리지 않는다');
  assert.doesNotMatch(payload, /elly@example\.test/);
  assert.doesNotMatch(payload, /accountId|emailAddress|5b10a2844c20165700ede21g|712020:aaaa/);
  assert.doesNotMatch(payload, new RegExp(JIRA_TOKEN));
  // 나가는 요청에도 그 칸을 달라고 하지 않는다.
  assert.doesNotMatch(fake.calls.map(call => call.url).join(' '), /emailAddress|accountId/);
});

test('하위 티켓 목록은 키 형식이 아닌 것을 버리고, 모르는 값은 빈 자리로 흘린다', () => {
  const shaped = jiraModule.shapeChildren(JIRA_SITE, [
    { key: 'AB-2', fields: { summary: '정상', status: { name: '진행 중', statusCategory: { key: 'indeterminate' } } } },
    // 키가 없거나 형식이 아니면 버린다 — 그 키로 주소를 조립하기 때문이다.
    { fields: { status: { statusCategory: { key: 'done' } } } },
    { key: 'javascript:alert(1)', fields: { summary: '수상한 것', status: { statusCategory: { key: 'new' } } } },
    // 모르는 모양이 와도 오류가 아니라 빈 값으로 흐른다(범주를 모르면 `진행`으로 본다).
    { key: 'AB-9', fields: {} },
  ]);
  // total·done은 지라가 준 목록 전체를 그대로 센다(줄을 버린 것과 별개다).
  assert.equal(shaped.total, 4);
  assert.equal(shaped.done, 1);
  assert.deepEqual(shaped.items.map(item => item.key), ['AB-2', 'AB-9']);
  assert.deepEqual(shaped.items[1], {
    key: 'AB-9', url: `${JIRA_SITE}/browse/AB-9`, summary: '', type: '',
    status: { name: '', category: 'doing' }, assignee: null, version: null,
  });
  assert.equal(jiraModule.shapeChildren(JIRA_SITE, []), null, '하나도 없으면 줄 자체가 없다');
  assert.equal(jiraModule.shapeChildren(JIRA_SITE, null), null);
});

test('하위가 100개를 넘어도 지라에서 읽어 오는 것은 100개까지다', async () => {
  const many = { issues: Array.from({ length: 100 }, (unused, at) => ({
    key: `AB-${at + 2}`,
    fields: { summary: `하위 ${at + 1}`, status: { name: '진행 중', statusCategory: { key: 'indeterminate' } }, assignee: { displayName: '루본' } },
  })) };
  const fake = jiraFake({ '/rest/api/3/issue/AB-1': () => json(jiraIssueBody()), '/rest/api/3/search/jql': () => json(many) });
  const issue = await jiraModule.createJiraClient({ settings: jiraSettings(), request: fake.request, readToken: () => JIRA_TOKEN }).getIssueOverview('AB-1');
  assert.equal(issue.children.items.length, 100);
  assert.match(fake.calls[1].url, /maxResults=100$/, '더 달라고 조르지 않는다 — 나머지는 지라에서 본다');
});

test('지라 실패는 해요체 문구와 갈래로만 알리고 토큰·이메일을 싣지 않는다', async () => {
  const settings = jiraSettings();
  const run = async (routes) => {
    try {
      await jiraModule.createJiraClient({ settings, request: jiraFake(routes).request, readToken: () => JIRA_TOKEN }).getIssueOverview('AB-1');
      return null;
    } catch (error) { return error; }
  };
  const auth = await run({ '/issue/AB-1': () => json({ errorMessages: ['Client must be authenticated'] }, 401) });
  assert.equal(auth.kind, 'auth');
  assert.equal(auth.message, '지라 토큰을 확인해 주세요.');
  assert.equal((await run({ '/issue/AB-1': () => json({}, 403) })).kind, 'auth');
  const missing = await run({ '/issue/AB-1': () => json({ errorMessages: ['Issue does not exist'] }, 404) });
  assert.equal(missing.kind, 'notfound');
  assert.equal(missing.message, '지라에서 이 티켓을 찾지 못했어요.');
  const timeout = await run({ '/issue/AB-1': () => { throw new DOMException('The operation was aborted', 'TimeoutError'); } });
  assert.equal(timeout.kind, 'network');
  assert.equal(timeout.message, '지라에 연결하지 못했어요.');
  assert.equal((await run({ '/issue/AB-1': () => json({}, 500) })).kind, 'other');
  // 잘못된 키는 아예 지라를 부르지 않는다.
  const fake = jiraFake({ '/issue/': () => json(jiraIssueBody()) });
  const client = jiraModule.createJiraClient({ settings, request: fake.request, readToken: () => JIRA_TOKEN });
  for (const bad of ['io-1', 'AB1', 'AB-', 'AB-1x', '../../etc/passwd', '']) {
    await assert.rejects(() => client.getIssueOverview(bad), error => error.kind === 'key' && error.message === '지라 번호를 확인해 주세요.');
  }
  assert.equal(fake.calls.length, 0);
  // 어떤 문구에도 토큰·이메일이 섞이지 않는다.
  for (const error of [auth, missing, timeout]) {
    assert.doesNotMatch(error.message, new RegExp(JIRA_TOKEN));
    assert.doesNotMatch(error.message, new RegExp(JIRA_EMAIL));
  }
});

test('지라 API는 설정이 없거나 토큰을 못 읽으면 연결 안 됨으로만 답한다', async () => {
  const fake = jiraFake({ '/issue/': () => json(jiraIssueBody()) });
  const off = jiraModule.createJiraApi({ config: {}, request: fake.request });
  assert.deepEqual(await off.read('AB-1'), { ok: true, connected: false });
  assert.equal(off.connected, false);
  // siteUrl이 https가 아니면 설정이 없는 것으로 본다.
  const plain = jiraModule.createJiraApi({ config: { jira: { siteUrl: 'http://example-jira.test', email: JIRA_EMAIL, tokenFile: '/tmp/x' } }, request: fake.request });
  assert.deepEqual(await plain.read('AB-1'), { ok: true, connected: false });
  const noToken = jiraModule.createJiraApi({ config: jiraConfig, request: fake.request, readFile: () => { throw new Error('ENOENT'); } });
  assert.deepEqual(await noToken.read('AB-1'), { ok: true, connected: false });
  const blank = jiraModule.createJiraApi({ config: jiraConfig, request: fake.request, readFile: () => '  \n' });
  assert.deepEqual(await blank.read('AB-1'), { ok: true, connected: false });
  assert.equal(fake.calls.length, 0, '연결되지 않았으면 지라를 부르지 않는다');
});

test('지라 API는 키별로 60초 캐시하고 fresh=1이면 건너뛴다', async () => {
  const fake = jiraFake({ '/rest/api/3/issue/': () => json(jiraIssueBody()), '/rest/api/3/search': () => json({ issues: [] }) });
  let clock = 1000;
  const api = jiraModule.createJiraApi({ config: jiraConfig, request: fake.request, readFile: () => JIRA_TOKEN, now: () => clock });
  const first = await api.read('AB-1');
  assert.equal(first.connected, true);
  assert.equal(first.issue.summary, '게시글 작성하기_게임 임베드');
  const issueCalls = () => fake.calls.filter(call => call.url.includes('/rest/api/3/issue/')).length;
  assert.equal(issueCalls(), 1);
  await api.read('AB-1');
  assert.equal(issueCalls(), 1, '60초 안에는 다시 부르지 않는다');
  await api.read('AB-2');
  assert.equal(issueCalls(), 2, '캐시는 키마다 따로다');
  await api.read('AB-1', { fresh: true });
  assert.equal(issueCalls(), 3, 'fresh=1이면 캐시를 건너뛴다');
  clock += 61 * 1000;
  await api.read('AB-1');
  assert.equal(issueCalls(), 4, '60초가 지나면 다시 읽는다');
  // 키 형식은 API에서도 막는다.
  assert.deepEqual(await api.read('nope'), { ok: false, error: '지라 번호를 확인해 주세요.', kind: 'key' });
  // 돌려주는 값 어디에도 토큰·이메일이 없다.
  const payload = JSON.stringify(await api.read('AB-1'));
  assert.doesNotMatch(payload, new RegExp(JIRA_TOKEN));
  assert.doesNotMatch(payload, new RegExp(JIRA_EMAIL));
});

test('지라 API의 실패 응답은 화면에 그대로 쓸 문구와 갈래를 담는다', async () => {
  const api = kind => jiraModule.createJiraApi({
    config: jiraConfig, readFile: () => JIRA_TOKEN,
    request: jiraFake({ '/rest/api/3/issue/': () => (kind === 'network' ? (() => { throw new TypeError('fetch failed'); })() : json({}, kind)) }).request,
  });
  assert.deepEqual(await api(401).read('AB-1'), { ok: false, error: '지라 토큰을 확인해 주세요.', kind: 'auth' });
  assert.deepEqual(await api(404).read('AB-1'), { ok: false, error: '지라에서 이 티켓을 찾지 못했어요.', kind: 'notfound' });
  assert.deepEqual(await api('network').read('AB-1'), { ok: false, error: '지라에 연결하지 못했어요.', kind: 'network' });
  assert.deepEqual(await api(500).read('AB-1'), { ok: false, error: '지라에 연결하지 못했어요.', kind: 'other' });
});

test('GET /api/jira/issue는 파일을 쓰지 않고, 설정이 없으면 연결 안 됨으로 답한다', async () => {
  const snapshot = () => fs.readdirSync(directory).sort().map(name => {
    const stat = fs.statSync(path.join(directory, name));
    return `${name}:${stat.size}:${stat.mtimeMs}`;
  }).join('|');
  const before = snapshot();
  const response = await fetch(`${base}/api/jira/issue?key=IO-48394`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, connected: false });
  // 형식이 틀린 키만 400이다. 지라 쪽 실패는 200 + `ok:false`로 오므로 화면이 조용히 그 문구를 적는다.
  const bad = await fetch(`${base}/api/jira/issue?key=not-a-key`);
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { ok: false, error: '지라 번호를 확인해 주세요.', kind: 'key' });
  assert.equal(snapshot(), before, '조회는 어떤 파일도 만들거나 고치지 않는다');
});

// ---------- 지라 바꾸기 (BJR 2단계 — 지라에 쓴다) ----------
// 여기서도 실제 지라에는 절대 닿지 않는다: 모든 요청은 가짜 fetch가 받아 기록만 한다.
// `쓰기 요청이 나갔는가`는 기록된 method로 판정한다(GET만 나갔으면 아무것도 쓰지 않은 것이다).
const jiraTransitionsBody = {
  transitions: [
    { id: '11', name: '작업 시작', to: { name: '진행 중', statusCategory: { key: 'indeterminate' } } },
    // 같은 `to.name`이 둘이다 — 이름만으로는 구분되지 않으므로 전환 이름이 괄호로 붙어야 한다.
    { id: '21', name: '완료 처리', to: { name: '완료', statusCategory: { key: 'done' } } },
    { id: '31', name: '배포 대기로', to: { name: '완료', statusCategory: { key: 'indeterminate' } } },
    // 기본값 없는 필수 입력이 있는 전환 — 선택지에는 두되 앱에서 쓰지 않는다.
    { id: '41', name: '보류', to: { name: '보류', statusCategory: { key: 'new' } }, fields: { reason: { required: true, hasDefaultValue: false } } },
    // statusCategory가 없으면(모르는 모양) 범주는 `doing`으로 흐른다. 필수지만 기본값이 있는 칸은 입력 화면이 필요 없다.
    { id: '51', name: '취소', to: { name: '취소됨' }, fields: { resolution: { required: true, hasDefaultValue: true } } },
  ],
};
const jiraVersionsBody = [
  { id: '10101', name: 'v2.70.0', releaseDate: '2026-09-30', released: false, archived: false },
  { id: '10102', name: 'v2.71.0', releaseDate: null, released: false, archived: false },
  { id: '10099', name: 'v2.60.0', releaseDate: '2026-08-01', released: true, archived: false },
  { id: '10098', name: 'v2.50.0', released: false, archived: true },
];
// 순서가 중요하다 — 앞선 열쇠가 먼저 걸린다(`/transitions`가 `/issue/AB-1`보다 앞).
const jiraChangeRoutes = (extra = {}) => ({
  '/rest/api/3/issue/AB-1/transitions': () => json(jiraTransitionsBody),
  '/rest/api/3/project/AB/versions': () => json(jiraVersionsBody),
  '/rest/api/3/version/': () => new Response(null, { status: 204 }),
  '/rest/api/3/issue/AB-1': () => json(jiraIssueBody()),
  '/rest/api/3/search': () => json({ issues: [] }),
  ...extra,
});
function jiraChangeApi(routes = jiraChangeRoutes(), options = {}) {
  const fake = jiraFake(routes);
  return { fake, api: jiraModule.createJiraApi({ config: jiraConfig, request: fake.request, readFile: () => JIRA_TOKEN, ...options }) };
}
const jiraWrites = fake => fake.calls.filter(call => call.method !== 'GET');

test('지라 고르개의 선택지는 허용된 전환과 미배포 버전뿐이고, 읽기만 한다', async () => {
  const { fake, api } = jiraChangeApi();
  const payload = await api.options('AB-1');
  assert.equal(payload.ok, true);
  assert.equal(payload.connected, true);
  assert.deepEqual(payload.transitions, [
    { id: '11', name: '진행 중', category: 'doing', requiresInput: false },
    // 같은 이름이 둘일 때만 전환 이름이 괄호로 붙는다.
    { id: '21', name: '완료 (완료 처리)', category: 'done', requiresInput: false },
    { id: '31', name: '완료 (배포 대기로)', category: 'doing', requiresInput: false },
    { id: '41', name: '보류', category: 'todo', requiresInput: true },
    // statusCategory를 안 준 전환은 `doing`으로 흐른다(BJCOLOR — 진행 범주와 같은 기본값).
    { id: '51', name: '취소됨', category: 'doing', requiresInput: false },
  ]);
  // 배포됐거나 보관된 버전은 고를 수 없다.
  assert.deepEqual(payload.versions, [
    { id: '10101', name: 'v2.70.0', releaseDate: '2026-09-30' },
    { id: '10102', name: 'v2.71.0', releaseDate: null },
  ]);
  assert.equal(jiraWrites(fake).length, 0, '선택지를 읽는 것만으로는 지라에 아무것도 쓰지 않는다');
  // 프로젝트 키는 티켓 키에서 뽑는다 — 따로 더 묻지 않는다.
  assert.ok(fake.calls.some(call => call.url.endsWith('/rest/api/3/project/AB/versions')));
  assert.equal(jiraModule.projectOf('IO-48394'), 'IO');
  // 설정이 없으면 지라를 부르지 않는다.
  const off = jiraModule.createJiraApi({ config: {}, request: jiraFake({}).request });
  assert.deepEqual(await off.options('AB-1'), { ok: true, connected: false });
  assert.deepEqual(await off.options('nope'), { ok: false, error: '지라 번호를 확인해 주세요.', kind: 'key' });
});

test('지라 상태 바꾸기는 쓰기 직전에 전환 목록을 다시 조회해 대조한다', async () => {
  const { fake, api } = jiraChangeApi();
  assert.deepEqual(await api.change({ key: 'AB-1', kind: 'status', transitionId: '21' }), { ok: true });
  const writes = jiraWrites(fake);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, 'POST');
  assert.ok(writes[0].url.endsWith('/rest/api/3/issue/AB-1/transitions'));
  assert.deepEqual(writes[0].body, { transition: { id: '21' } });
  // 쓰기 바로 앞에 전환 목록을 다시 읽는다(고르개가 본 목록을 믿지 않는다).
  assert.ok(fake.calls[fake.calls.length - 2].url.includes('/transitions?expand=transitions.fields'));

  // 목록에 없는 id는 쓰지 않는다.
  const stale = jiraChangeApi();
  assert.deepEqual(await stale.api.change({ key: 'AB-1', kind: 'status', transitionId: '99' }),
    { ok: false, error: '지라에서 고를 수 있는 값이 바뀌었어요. 카드를 새로 읽고 다시 골라 주세요.', kind: 'stale' });
  assert.equal(jiraWrites(stale.fake).length, 0);

  // 필수 입력이 있는 전환도 쓰지 않는다 — 지라에서 직접 하게 안내한다.
  const screen = jiraChangeApi();
  assert.deepEqual(await screen.api.change({ key: 'AB-1', kind: 'status', transitionId: '41' }),
    { ok: false, error: '이 전환은 지라에서 직접 해 주세요.', kind: 'screen' });
  assert.equal(jiraWrites(screen.fake).length, 0);

  // id 형식이 숫자가 아니면 아예 나가지 않는다(주소에 끼우는 값이다).
  const bad = jiraChangeApi();
  assert.equal((await bad.api.change({ key: 'AB-1', kind: 'status', transitionId: '../../x' })).kind, 'stale');
  assert.equal(jiraWrites(bad.fake).length, 0);
});

test('배포 버전은 한 개짜리 티켓만 옮기고, `버전 없음`은 빈 배열로 보낸다', async () => {
  const single = jiraChangeApi();
  assert.deepEqual(await single.api.change({ key: 'AB-1', kind: 'version', versionId: '10102' }), { ok: true });
  const [write] = jiraWrites(single.fake);
  assert.equal(write.method, 'PUT');
  assert.ok(write.url.endsWith('/rest/api/3/issue/AB-1'));
  assert.deepEqual(write.body, { fields: { fixVersions: [{ id: '10102' }] } });

  const cleared = jiraChangeApi();
  assert.deepEqual(await cleared.api.change({ key: 'AB-1', kind: 'version', versionId: null }), { ok: true });
  assert.deepEqual(jiraWrites(cleared.fake)[0].body, { fields: { fixVersions: [] } });

  // 버전이 여러 개 걸린 티켓은 앱에서 바꾸지 않는다 — 다른 버전을 실수로 지우지 않게.
  const many = jiraChangeApi(jiraChangeRoutes({
    '/rest/api/3/issue/AB-1': () => json(jiraIssueBody({ fixVersions: [{ id: '10101', name: 'v2.70.0' }, { id: '10102', name: 'v2.71.0' }] })),
  }));
  assert.deepEqual(await many.api.change({ key: 'AB-1', kind: 'version', versionId: '10102' }),
    { ok: false, error: '버전이 여러 개라 지라에서 직접 바꿔 주세요.', kind: 'multi' });
  assert.equal(jiraWrites(many.fake).length, 0);

  // 그 프로젝트의 버전이 아니면 쓰지 않는다.
  const foreign = jiraChangeApi();
  assert.equal((await foreign.api.change({ key: 'AB-1', kind: 'version', versionId: '99999' })).kind, 'stale');
  assert.equal(jiraWrites(foreign.fake).length, 0);
});

test('지라의 기한은 지울 수 있고, 날짜 형식이 아니면 아무것도 보내지 않는다', async () => {
  const set = jiraChangeApi();
  assert.deepEqual(await set.api.change({ key: 'AB-1', kind: 'due', due: '2026-11-02' }), { ok: true });
  assert.deepEqual(jiraWrites(set.fake)[0].body, { fields: { duedate: '2026-11-02' } });
  assert.equal(jiraWrites(set.fake)[0].method, 'PUT');

  const cleared = jiraChangeApi();
  assert.deepEqual(await cleared.api.change({ key: 'AB-1', kind: 'due', due: null }), { ok: true });
  assert.deepEqual(jiraWrites(cleared.fake)[0].body, { fields: { duedate: null } });

  for (const due of ['내일', '2026-13-01x', 20261102, { }]) {
    const bad = jiraChangeApi();
    assert.deepEqual(await bad.api.change({ key: 'AB-1', kind: 'due', due }), { ok: false, error: '보낸 값을 확인해 주세요.', kind: 'value' });
    assert.equal(jiraWrites(bad.fake).length, 0);
  }
});

test('버전 고치기는 바뀐 칸만 보내고, 그 프로젝트의 버전만 받는다', async () => {
  const renamed = jiraChangeApi();
  assert.deepEqual(await renamed.api.change({ key: 'AB-1', kind: 'versionEdit', versionId: '10101', name: 'v2.70.1' }), { ok: true });
  const [write] = jiraWrites(renamed.fake);
  assert.equal(write.method, 'PUT');
  assert.ok(write.url.endsWith('/rest/api/3/version/10101'));
  assert.deepEqual(write.body, { name: 'v2.70.1' }, '이름만 고쳤으면 배포일은 보내지 않는다');

  const dated = jiraChangeApi();
  assert.deepEqual(await dated.api.change({ key: 'AB-1', kind: 'versionEdit', versionId: '10101', releaseDate: '2026-10-07' }), { ok: true });
  assert.deepEqual(jiraWrites(dated.fake)[0].body, { releaseDate: '2026-10-07' });

  const wiped = jiraChangeApi();
  assert.deepEqual(await wiped.api.change({ key: 'AB-1', kind: 'versionEdit', versionId: '10101', releaseDate: null }), { ok: true });
  assert.deepEqual(jiraWrites(wiped.fake)[0].body, { releaseDate: null });

  for (const patch of [{ name: '  ' }, { name: 'a\nb' }, { name: 'x'.repeat(256) }, {}, { versionId: '99999', name: 'v9' }]) {
    const bad = jiraChangeApi();
    const result = await bad.api.change({ key: 'AB-1', kind: 'versionEdit', versionId: '10101', ...patch });
    assert.equal(result.ok, false);
    assert.ok(['value', 'stale'].includes(result.kind), `${JSON.stringify(patch)} → ${result.kind}`);
    assert.equal(jiraWrites(bad.fake).length, 0);
  }
});

test('지라 쓰기 실패는 갈래별 해요체 문구로만 알리고 토큰·이메일을 싣지 않는다', async () => {
  const fail = (status) => jiraChangeApi(jiraChangeRoutes({
    '/rest/api/3/issue/AB-1/transitions': (url, method) => (method === 'GET'
      ? json(jiraTransitionsBody)
      : status === 'network' ? (() => { throw new TypeError('fetch failed'); })() : json({ errorMessages: ['지라 원문 오류 — 화면에 나오면 안 된다'] }, status)),
  }));
  const run = async (status) => (await fail(status).api.change({ key: 'AB-1', kind: 'status', transitionId: '21' }));
  assert.deepEqual(await run(403), { ok: false, error: '지라에서 이 티켓을 바꿀 권한이 없어요.', kind: 'forbidden' });
  assert.deepEqual(await run(401), { ok: false, error: '지라에서 이 티켓을 바꿀 권한이 없어요.', kind: 'forbidden' });
  assert.deepEqual(await run(400), { ok: false, error: '지라가 이 변경을 받아들이지 않았어요. 지라에서 직접 확인해 주세요.', kind: 'reject' });
  assert.deepEqual(await run(404), { ok: false, error: '지라에서 이 티켓을 찾지 못했어요.', kind: 'notfound' });
  assert.deepEqual(await run(409), { ok: false, error: '지라에 반영하지 못했어요.', kind: 'write' });
  assert.deepEqual(await run(500), { ok: false, error: '지라에 반영하지 못했어요.', kind: 'write' });
  assert.deepEqual(await run('network'), { ok: false, error: '지라에 반영하지 못했어요.', kind: 'write' });
  // 지라가 준 원문도, 토큰·이메일도 응답에 섞이지 않는다.
  for (const status of [403, 400, 500]) {
    const payload = JSON.stringify(await run(status));
    assert.doesNotMatch(payload, /지라 원문 오류/);
    assert.doesNotMatch(payload, new RegExp(JIRA_TOKEN));
    assert.doesNotMatch(payload, new RegExp(JIRA_EMAIL));
  }
  // 설정이 없거나 토큰을 못 읽으면 지라를 부르지 않고 연결 안내만 한다.
  const off = jiraModule.createJiraApi({ config: {}, request: jiraFake({}).request });
  assert.deepEqual(await off.change({ key: 'AB-1', kind: 'status', transitionId: '21' }), { ok: false, error: '지라 연결이 필요해요.', kind: 'off' });
  const noToken = jiraChangeApi(jiraChangeRoutes(), { readFile: () => '' });
  assert.deepEqual(await noToken.api.change({ key: 'AB-1', kind: 'status', transitionId: '21' }), { ok: false, error: '지라 연결이 필요해요.', kind: 'off' });
  assert.equal(jiraWrites(noToken.fake).length, 0);
  // 키·종류가 틀리면 지라를 부르지도 않는다.
  const shape = jiraChangeApi();
  assert.deepEqual(await shape.api.change({ key: 'nope', kind: 'status' }), { ok: false, error: '지라 번호를 확인해 주세요.', kind: 'key' });
  assert.deepEqual(await shape.api.change({ key: 'AB-1', kind: 'delete' }), { ok: false, error: '보낸 값을 확인해 주세요.', kind: 'value' });
  assert.deepEqual(await shape.api.change(null), { ok: false, error: '지라 번호를 확인해 주세요.', kind: 'key' });
  assert.equal(shape.fake.calls.length, 0);
});

test('지라를 바꾸면 그 키의 읽기 캐시를 비운다', async () => {
  const { fake, api } = jiraChangeApi();
  const issueReads = () => fake.calls.filter(call => call.method === 'GET' && /\/rest\/api\/3\/issue\/AB-1\?fields=summary/.test(call.url)).length;
  await api.read('AB-1');
  await api.read('AB-1');
  assert.equal(issueReads(), 1, '60초 캐시는 그대로다');
  assert.deepEqual(await api.change({ key: 'AB-1', kind: 'due', due: '2026-11-02' }), { ok: true });
  await api.read('AB-1');
  assert.equal(issueReads(), 2, '바꾼 뒤에는 캐시가 비어 지라에서 새로 읽는다');
});

test('/api/jira/change는 확인된 요청만 받고, 조회는 파일을 쓰지 않는다', async () => {
  const snapshot = () => fs.readdirSync(directory).sort().map((name) => {
    const stat = fs.statSync(path.join(directory, name));
    return `${name}:${stat.size}:${stat.mtimeMs}`;
  }).join('|');
  const before = snapshot();
  // 이 서버에는 지라 설정이 없다(테스트 머리에서 없는 파일로 고정) — 그래서 바깥으로 나가지 않는다.
  const options = await fetch(`${base}/api/jira/options?key=AB-1`);
  assert.equal(options.status, 200);
  assert.deepEqual(await options.json(), { ok: true, connected: false });
  const badKey = await fetch(`${base}/api/jira/options?key=not-a-key`);
  assert.equal(badKey.status, 400);
  assert.deepEqual(await badKey.json(), { ok: false, error: '지라 번호를 확인해 주세요.', kind: 'key' });

  const off = await post('/api/jira/change', { key: 'AB-1', kind: 'status', transitionId: '21' });
  assert.equal(off.status, 200);
  assert.deepEqual({ ok: off.ok, kind: off.kind, error: off.error }, { ok: false, kind: 'off', error: '지라 연결이 필요해요.' });
  assert.equal((await post('/api/jira/change', { key: 'nope', kind: 'status' })).status, 400);
  assert.equal((await post('/api/jira/change', { key: 'AB-1', kind: 'delete' })).status, 400);
  // 지라 쓰기는 앱 파일을 하나도 건드리지 않는다(요청 원장에도 남지 않는다).
  assert.equal(snapshot(), before);
});

test('복구가 필요한 동안에는 지라 쓰기도 막히고 조회만 된다', async (t) => {
  const external = '# Tasks\n- 바깥에서 고친 줄 #task[id:outside status:to-do created:2026-09-20]\n';
  const server = await startServer(t, (home) => {
    fs.writeFileSync(path.join(home, 'tasks.md'), external);
    fs.writeFileSync(path.join(home, '.mutation-journal.json'), journalEntry(path.join(home, 'tasks.md'), '# Tasks\n', '# Tasks\n- 중단된 저장\n'));
    fs.writeFileSync(path.join(home, '.mutation.lock'), String(deadPid()));
  });
  const blocked = await fetch(server.base + '/api/jira/change', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'AB-1', kind: 'status', transitionId: '21' }),
  });
  assert.equal(blocked.status, 503);
  assert.match((await blocked.json()).error, /저장을 멈췄어요/, '앱 저장소가 아픈 동안에는 바깥에도 쓰지 않는다');
  // 조회는 그대로 된다(설정이 없으므로 연결 안 됨으로 답한다).
  assert.equal((await fetch(server.base + '/api/jira/issue?key=AB-1')).status, 200);
  assert.equal((await fetch(server.base + '/api/jira/options?key=AB-1')).status, 200);
});

// ---------- 직접 만든(그룹) 프로젝트 ↔ 지라 티켓 연결 (BJLINK) ----------
// 여기서도 실제 지라에는 닿지 않는다: 아래 서버는 자기 임시 폴더의 가짜 설정·가짜 토큰을 쓰고,
// 지라 주소로 나가는 fetch는 자식 프로세스 안의 가짜 응답이 전부 가로챈다.
const JIRA_LINK_SITE = 'https://link-jira.test';
// 가짜 지라를 끼운 서버를 하나 띄운다(설정·토큰 파일은 그 임시 폴더 안에만 있다).
async function startLinkedJiraServer(t, seed) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-jiralink-'));
  seed(home);
  const tokenFile = path.join(home, '.jira_token_fixture');
  fs.writeFileSync(tokenFile, 'fixture-token-never-real\n');
  const config = path.join(home, 'workspace.config.json');
  fs.writeFileSync(config, JSON.stringify({ jira: { siteUrl: JIRA_LINK_SITE, email: 'fixture@example.test', tokenFile } }));
  const known = { 'IO-12345': '게시글 작성하기_게임 임베드' };
  const wrapper = path.join(home, 'fake-jira-server.js');
  fs.writeFileSync(wrapper, `'use strict';
const SITE = ${JSON.stringify(JIRA_LINK_SITE)};
const KNOWN = ${JSON.stringify(known)};
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input && input.url ? input.url : input);
  if (!url.startsWith(SITE)) return realFetch(input, init);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const hit = url.match(/\\/rest\\/api\\/3\\/issue\\/([A-Z][A-Z0-9]*-\\d+)/);
  if (hit && KNOWN[hit[1]]) return json({ fields: { summary: KNOWN[hit[1]], status: { name: '진행 중', statusCategory: { key: 'indeterminate' } }, issuetype: { name: '스토리' }, assignee: { displayName: '루본' }, duedate: null, fixVersions: [], subtasks: [] } });
  if (hit) return json({ errorMessages: ['no issue'] }, 404);
  return json({ issues: [] });
};
const { server } = require(${JSON.stringify(path.join(__dirname, 'server.js'))});
server.listen(Number(process.env.WORKSPACE_PORT), '127.0.0.1', () => console.log('ready'));
`);
  const port = await freePort();
  const child = spawn(process.execPath, [wrapper], {
    env: { ...process.env, WORKSPACE_DATA_DIR: home, WORKSPACE_PORT: String(port), WORKSPACE_NO_OPEN: '1', WORKSPACE_HOST: '', WORKSPACE_CONFIG: config },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(home, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`서버가 종료되었습니다 (${child.exitCode}): ${log}`);
    try { if ((await fetch(origin + '/api/storage-status')).ok) return { home, origin }; } catch { /* 아직 안 떴다 */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`서버가 응답하지 않았습니다: ${log}`);
}
const linkPost = (origin, body) => fetch(origin + '/api/project/jira-link', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then(async response => ({ status: response.status, ...await response.json() }));

test('지라 연결은 직접 만든 프로젝트에만, 형식이 맞는 키로만, 지라에 연결돼 있을 때만 걸린다', async () => {
  // 이 서버에는 지라 설정이 없다(테스트 맨 위의 `absent.config.json`) — 연결은 전부 거절된다.
  assert.equal((await post('/api/today-task/create', { description: '연결 실험용 업무', group: '연결 실험' })).ok, true);
  const workflowFile = path.join(directory, '.workflow.json');
  const before = fs.existsSync(workflowFile) ? fs.readFileSync(workflowFile, 'utf8') : null;
  const refuse = async (body, message) => {
    const answer = await linkPost(base, body);
    assert.equal(answer.status, 400, JSON.stringify(body));
    assert.equal(answer.error, message);
  };
  await refuse({ project: 'jira:IO-12345', jira: 'IO-12345' }, '직접 만든 프로젝트에만 지라 티켓을 연결할 수 있어요.');
  await refuse({ project: '연결 실험', jira: 'IO-12345' }, '직접 만든 프로젝트에만 지라 티켓을 연결할 수 있어요.');
  await refuse({ project: 'group:없는 프로젝트', jira: 'IO-12345' }, '프로젝트를 찾을 수 없어요.');
  await refuse({ project: 'group:연결 실험', jira: 'io-12345' }, '지라 번호를 확인해 주세요.');
  await refuse({ project: 'group:연결 실험', jira: 'IO-' }, '지라 번호를 확인해 주세요.');
  // 키는 맞지만 지라에 연결돼 있지 않다 — 읽어 볼 수 없으므로 걸지 않는다.
  await refuse({ project: 'group:연결 실험', jira: 'IO-12345' }, '지라 연결이 필요해요.');
  assert.equal(fs.existsSync(workflowFile) ? fs.readFileSync(workflowFile, 'utf8') : null, before, '거절된 요청은 파일을 고치지 않는다');
  // 해제는 지라에 묻지 않는다 — 걸린 것이 없어도 조용히 통과하고, 목록에도 연결이 없다.
  assert.equal((await linkPost(base, { project: 'group:연결 실험', jira: null })).ok, true);
  assert.deepEqual((await items()).workflows.projectLinks, {});
});

test('지라 티켓 하나를 그룹 프로젝트에 걸고 풀 수 있다 — 저장 전에 지라에서 읽어 보고, 옛 파일도 그대로 읽힌다', async (t) => {
  const server = await startLinkedJiraServer(t, (home) => {
    fs.writeFileSync(path.join(home, 'tasks.md'), '# Tasks\n- 정산 배치 설계 검토하기 #task[id:lk01 status:to-do created:2026-09-20 group:결제_리뉴얼]\n');
    // projectLinks 칸이 없는 옛 파일 — 빈 연결로 읽혀야 한다.
    fs.writeFileSync(path.join(home, '.workflow.json'), JSON.stringify({ items: {}, meetings: {} }));
  });
  const read = async () => (await (await fetch(server.origin + '/api/items')).json());
  const first = await read();
  assert.deepEqual(first.workflows.projectLinks, {}, '옛 파일은 빈 연결로 읽힌다');
  assert.equal(first.jiraSync.connected, true);
  assert.equal(first.jiraSync.siteUrl, JIRA_LINK_SITE, '화면이 붙여 넣은 주소를 견줄 수 있게 주소만 싣는다');
  assert.equal(JSON.stringify(first).includes('fixture-token-never-real'), false, '토큰은 어디에도 싣지 않는다');
  assert.equal(JSON.stringify(first).includes('fixture@example.test'), false, '이메일도 싣지 않는다');

  // 지라에 없는 티켓은 걸리지 않는다(저장도 하지 않는다).
  const missing = await linkPost(server.origin, { project: 'group:결제 리뉴얼', jira: 'IO-99999' });
  assert.equal(missing.status, 400);
  assert.equal(missing.error, '지라에서 이 티켓을 찾지 못했어요.');
  assert.deepEqual((await read()).workflows.projectLinks, {});

  // 지라에서 읽히는 티켓만 걸린다. 파일 표기(`결제_리뉴얼`)와 화면 표기(`결제 리뉴얼`)는 한 꼴로 맞춘다.
  const linked = await linkPost(server.origin, { project: 'group:결제 리뉴얼', jira: 'IO-12345' });
  assert.deepEqual(linked, { status: 200, ok: true, project: 'group:결제 리뉴얼', jira: 'IO-12345' });
  assert.deepEqual((await read()).workflows.projectLinks, { '결제 리뉴얼': 'IO-12345' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(server.home, '.workflow.json'), 'utf8')).projectLinks, { '결제 리뉴얼': 'IO-12345' });
  // 프로젝트 이름도 항목도 그대로다 — 붙은 것은 연결 표시뿐이다.
  const task = (await read()).todayTasks.concat((await read()).laterTasks).find(item => item.id === 'lk01');
  assert.equal(task.group, '결제 리뉴얼');
  assert.equal(task.jira, null);

  // 같은 내용을 같은 식별자로 다시 보내면 한 번만 쓴다(기존 idempotency 규칙 그대로).
  const key = 'bjlink-idempotency-key-0001';
  const send = () => fetch(server.origin + '/api/project/jira-link', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ project: 'group:결제 리뉴얼', jira: null }),
  }).then(response => response.json());
  assert.deepEqual(await send(), { ok: true, project: 'group:결제 리뉴얼', jira: null });
  assert.deepEqual(await send(), { ok: true, project: 'group:결제 리뉴얼', jira: null });
  assert.deepEqual((await read()).workflows.projectLinks, {}, '해제하면 칸에서 사라진다');
});

test('복구가 필요한 동안에는 지라 연결도 걸리지 않는다', async (t) => {
  const server = await startServer(t, (home) => {
    fs.writeFileSync(path.join(home, 'tasks.md'), '# Tasks\n- 막힌 저장 #task[id:lk02 status:to-do created:2026-09-20 group:운영툴]\n');
    fs.writeFileSync(path.join(home, '.mutation-journal.json'), journalEntry(path.join(home, 'tasks.md'), '# Tasks\n', '# Tasks\n- 중단된 저장\n'));
    fs.writeFileSync(path.join(home, '.mutation.lock'), String(deadPid()));
  });
  const blocked = await linkPost(server.base, { project: 'group:운영툴', jira: null });
  assert.equal(blocked.status, 503);
  assert.match(blocked.error, /저장을 멈췄어요/, '앱 저장소가 아픈 동안에는 연결도 걸지 않는다');
});

// ---------- 내 담당 지라 목록도 앱이 직접 읽는다 (BJLIVE) ----------
// 여기서도 실제 지라에는 절대 닿지 않는다: 아래는 전부 가짜 fetch이고, 서버를 띄우는 자리는
// 자기 임시 폴더의 가짜 설정·가짜 토큰만 쓴다.
const jiraListBody = (issues) => ({ issues });
const jiraListIssue = (key, extra = {}) => ({
  key,
  fields: {
    summary: `${key}의 요약`,
    status: { name: '진행 중', statusCategory: { key: 'indeterminate' } },
    issuetype: { name: '스토리' },
    duedate: '2026-10-02',
    fixVersions: [{ id: '10101', name: 'v2.70.0', releaseDate: '2026-09-30', released: false }],
    ...extra,
  },
});
const jiraListClient = fake => jiraModule.createJiraClient({ settings: jiraSettings(), request: fake.request, readToken: () => JIRA_TOKEN });

test('내 담당 목록은 파일과 같은 칸에 새 칸(범주·기한·배포 버전)만 얹어 돌려주고, 담당자는 아예 묻지 않는다', async () => {
  const fake = jiraFake({ '/rest/api/3/search/jql': () => json(jiraListBody([jiraListIssue('IO-48394'), { key: '수상한키', fields: {} }])) });
  const issues = await jiraListClient(fake).listMyIssues();
  assert.deepEqual(issues, [{
    // 기존 자리(프로젝트 이름 붙이기·고르기 목록)가 그대로 읽는 칸 — `status`는 상태 이름 글자다.
    key: 'IO-48394', type: '스토리', status: '진행 중', summary: 'IO-48394의 요약', extra: false,
    // 이번에 더한 칸(화면은 아직 그리지 않는다 — 배포 임박 알림·주간요약이 쓸 값이다).
    category: 'doing', due: '2026-10-02',
    versions: [{ name: 'v2.70.0', releaseDate: '2026-09-30', released: false }],
  }], '키 형식이 아닌 줄은 버린다');
  assert.equal(fake.calls.length, 1, '연결된 키가 없으면 한 번만 묻는다');
  const [call] = fake.calls;
  assert.match(call.url, /\/rest\/api\/3\/search\/jql\?jql=/);
  assert.match(call.url, /fields=summary,status,issuetype,fixVersions,duedate&maxResults=100$/);
  assert.equal(decodeURIComponent(call.url.split('jql=')[1].split('&')[0]), 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC');
  // 담당자 칸은 애초에 달라고 하지 않는다 — 그래야 이메일·계정 id가 응답에 실릴 일이 없다.
  assert.doesNotMatch(fake.calls.map(entry => entry.url).join(' '), /assignee&|assignee,|emailAddress|accountId/);
});

test('업무에 걸린 키는 기본 목록에 없을 때만 한 번 더 묻고 `그 밖의 이슈`로 표시된다', async () => {
  const routes = {
    '/rest/api/3/search/jql': (url) => {
      const jql = decodeURIComponent(String(url).split('jql=')[1].split('&')[0]);
      if (jql.startsWith('key in')) {
        assert.equal(jql, 'key in (IO-77777)', '기본 목록에 이미 있는 키는 다시 묻지 않는다');
        return json(jiraListBody([jiraListIssue('IO-77777', { status: { name: '완료', statusCategory: { key: 'done' } } })]));
      }
      return json(jiraListBody([jiraListIssue('IO-48394')]));
    },
  };
  const fake = jiraFake(routes);
  const issues = await jiraListClient(fake).listMyIssues(['IO-48394', 'IO-77777', 'IO-77777', 'not-a-key', null]);
  assert.deepEqual(issues.map(issue => [issue.key, issue.extra, issue.status, issue.category]),
    [['IO-48394', false, '진행 중', 'doing'], ['IO-77777', true, '완료', 'done']]);
  assert.equal(fake.calls.length, 2, '기본 목록 한 번 + 남은 키 한 번');

  // 걸린 키가 전부 기본 목록에 있으면 두 번째 조회는 아예 나가지 않는다.
  const covered = jiraFake(routes);
  await jiraListClient(covered).listMyIssues(['IO-48394']);
  assert.equal(covered.calls.length, 1);
});

test('목록은 100개까지만 들고 오고, 새 search 주소가 없으면 옛 주소로 한 번 물러선다', async () => {
  const many = jiraListBody(Array.from({ length: 140 }, (unused, index) => jiraListIssue(`IO-${1000 + index}`)));
  const capped = jiraFake({ '/rest/api/3/search/jql': () => json(many) });
  assert.equal((await jiraListClient(capped).listMyIssues()).length, 100);
  assert.match(capped.calls[0].url, /maxResults=100$/);

  const fallback = jiraFake({
    '/rest/api/3/search/jql': () => json({ errorMessages: ['not found'] }, 404),
    '/rest/api/3/search?': () => json(jiraListBody([jiraListIssue('IO-48394')])),
  });
  assert.deepEqual((await jiraListClient(fallback).listMyIssues()).map(issue => issue.key), ['IO-48394']);
  assert.equal(fallback.calls.length, 2, '새 주소가 404일 때만, 옛 주소로 한 번만 물러선다');
});

test('목록 API는 설정·토큰이 없으면 연결 안 됨으로만 답하고, 실패는 해요체 문구로 알린다', async () => {
  const fake = jiraFake({ '/rest/api/3/search': () => json(jiraListBody([jiraListIssue('IO-48394')])) });
  const off = jiraModule.createJiraApi({ config: {}, request: fake.request });
  assert.deepEqual(await off.list(['IO-48394']), { ok: true, connected: false });
  assert.equal(fake.calls.length, 0, '연결되지 않았으면 지라를 부르지 않는다');

  const noToken = jiraModule.createJiraApi({ config: jiraConfig, request: fake.request, readFile: () => '' });
  assert.deepEqual(await noToken.list(), { ok: true, connected: false });

  const ok = jiraModule.createJiraApi({ config: jiraConfig, request: fake.request, readFile: () => JIRA_TOKEN });
  const answer = await ok.list();
  assert.equal(answer.connected, true);
  assert.equal(answer.issues.length, 1);
  assert.doesNotMatch(JSON.stringify(answer), new RegExp(`${JIRA_TOKEN}|${JIRA_EMAIL}`), '토큰·이메일은 어디에도 싣지 않는다');

  const broken = jiraModule.createJiraApi({
    config: jiraConfig, readFile: () => JIRA_TOKEN,
    request: jiraFake({ '/rest/api/3/search': () => json({}, 401) }).request,
  });
  assert.deepEqual(await broken.list(), { ok: false, error: '지라 토큰을 확인해 주세요.', kind: 'auth' });
});

// 보관함(jira-live)의 시간 규칙 — 가짜 시계와 가짜 목록 API로만 확인한다(지라에 닿지 않는다).
const jiraLiveModule = require('./jira-live');
function liveHarness({ answers = [], connected = true } = {}) {
  let clock = 0;
  const calls = [];
  let pending = null;
  const list = (keys) => {
    calls.push(keys);
    const answer = answers.length ? answers.shift() : { ok: true, connected: true, issues: [{ key: 'IO-1' }] };
    if (answer === 'hang') return new Promise((resolve) => { pending = resolve; });
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(answer);
  };
  const live = jiraLiveModule.createJiraLive({ list, keys: () => ['IO-9'], connected: () => connected, now: () => clock });
  return { live, calls, tick: ms => { clock += ms; }, release: value => { const resolve = pending; pending = null; resolve(value); } };
}

test('지라 목록 보관함은 실패해도 이전 값을 30분까지 쓰고, 그보다 묵으면 버린다', async () => {
  const held = liveHarness({ answers: [
    { ok: true, connected: true, issues: [{ key: 'IO-1' }] },
    { ok: false, error: '지라에 연결하지 못했어요.', kind: 'network' },
    new Error('fetch failed'),
  ] });
  await held.live.refresh();
  assert.deepEqual(held.live.current().issues, [{ key: 'IO-1' }]);
  assert.deepEqual(held.calls[0], ['IO-9'], '업무에 걸린 키를 함께 넘긴다');

  held.tick(10 * 60 * 1000);
  assert.equal(await held.live.refresh(), false);
  assert.deepEqual(held.live.current().issues, [{ key: 'IO-1' }], '실패하면 이전 값을 그대로 둔다');
  assert.equal(await held.live.refresh(), false, '던지는 실패도 조용히 흘린다');

  held.tick(21 * 60 * 1000); // 마지막으로 성공한 지 31분
  assert.equal(held.live.current(), null, '30분보다 묵으면 버린다(그때부터 파일 스냅샷을 쓴다)');
});

test('지라 목록 보관함은 동시에 두 번 돌지 않고, 5분 넘게 묵었을 때만 뒤에서 갱신을 건다', async () => {
  const harness = liveHarness({ answers: ['hang', { ok: true, connected: true, issues: [{ key: 'IO-2' }] }] });
  const first = harness.live.refresh();
  const second = harness.live.refresh();
  assert.equal(first, second, '도는 중이면 같은 갱신을 나눠 쓴다');
  assert.equal(harness.calls.length, 1);
  harness.release({ ok: true, connected: true, issues: [{ key: 'IO-1' }] });
  await first;

  harness.live.nudge();
  assert.equal(harness.calls.length, 1, '방금 읽은 값은 그대로 쓴다');
  harness.tick(5 * 60 * 1000);
  harness.live.nudge();
  assert.equal(harness.calls.length, 2, '5분이 지나면 갱신을 건다');
});

test('지라 설정이 없으면 목록 보관함은 타이머도 첫 읽기도 돌리지 않는다', async () => {
  const off = liveHarness({ connected: false });
  assert.equal(off.live.start(), false);
  assert.equal(off.live.started(), false);
  assert.equal(off.calls.length, 0);
  off.live.nudge();
  assert.equal(off.calls.length, 0);

  const on = liveHarness();
  assert.equal(on.live.start(), true);
  assert.equal(on.calls.length, 1, '설정이 있으면 뜰 때 한 번 읽는다');
  assert.equal(on.live.holdsProcess(), false, '타이머는 unref — 이것 때문에 프로세스가 남지 않는다');
  assert.equal(on.live.start(), false, '두 번 켜지지 않는다');
  on.live.stop();
  assert.equal(on.live.started(), false);
});

// 가짜 지라를 끼운 서버 하나. 목록 응답이 스냅샷 파일과 **다르게** 오도록 두어,
// 화면에 실린 값이 어디서 왔는지 눈으로 가를 수 있게 한다.
const JIRA_LIVE_SITE = 'https://live-jira.test';
async function startLiveJiraServer(t, { fail = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-jiralive-'));
  fs.writeFileSync(path.join(home, 'tasks.md'),
    '# Tasks\n- 정산 배치 설계 검토하기 #task[id:lv01 status:to-do created:2026-09-20 jira:IO-77777]\n');
  // 스냅샷 파일(대비책) — 요약이 일부러 낡았고 날짜도 어제다.
  fs.writeFileSync(path.join(home, 'jira_issues.md'),
    '# 지라 이슈 (내 담당, 진행중/백로그)\n\n마지막 갱신: 2026-01-02\n\n- IO-12345 | 에픽 | 진행 중 | 파일에서 온 낡은 요약\n');
  const tokenFile = path.join(home, '.jira_token_fixture');
  fs.writeFileSync(tokenFile, 'fixture-token-never-real\n');
  const config = path.join(home, 'workspace.config.json');
  fs.writeFileSync(config, JSON.stringify({ jira: { siteUrl: JIRA_LIVE_SITE, email: 'fixture@example.test', tokenFile } }));
  const wrapper = path.join(home, 'fake-jira-list-server.js');
  fs.writeFileSync(wrapper, `'use strict';
const SITE = ${JSON.stringify(JIRA_LIVE_SITE)};
const FAIL = ${fail ? 'true' : 'false'};
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input && input.url ? input.url : input);
  if (!url.startsWith(SITE)) return realFetch(input, init);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (FAIL) return json({ errorMessages: ['down'] }, 500);
  const jql = url.includes('jql=') ? decodeURIComponent(url.split('jql=')[1].split('&')[0]) : '';
  const issue = (key, summary, done) => ({ key, fields: {
    summary,
    status: done ? { name: '완료', statusCategory: { key: 'done' } } : { name: '진행 중', statusCategory: { key: 'indeterminate' } },
    issuetype: { name: '에픽' }, duedate: '2026-10-02',
    fixVersions: [{ id: '10101', name: 'v2.70.0', releaseDate: '2026-09-30', released: false }],
    // 지라는 묻지 않아도 이런 칸을 끼워 보낼 수 있다 — 앱이 옮기지 않는지 함께 본다.
    assignee: { displayName: '루본', emailAddress: 'lubon@live-jira.test', accountId: '712020:live' },
  } });
  if (jql.startsWith('key in')) return json({ issues: [issue('IO-77777', '업무에 걸린 다 끝난 티켓', true)] });
  return json({ issues: [issue('IO-12345', '지라에서 바로 읽은 요약', false)] });
};
const { server } = require(${JSON.stringify(path.join(__dirname, 'server.js'))});
server.listen(Number(process.env.WORKSPACE_PORT), '127.0.0.1', () => console.log('ready'));
`);
  const port = await freePort();
  const child = spawn(process.execPath, [wrapper], {
    env: { ...process.env, WORKSPACE_DATA_DIR: home, WORKSPACE_PORT: String(port), WORKSPACE_NO_OPEN: '1', WORKSPACE_HOST: '', WORKSPACE_CONFIG: config },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(home, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`서버가 종료되었습니다 (${child.exitCode}): ${log}`);
    try { if ((await fetch(origin + '/api/storage-status')).ok) return { home, origin }; } catch { /* 아직 안 떴다 */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`서버가 응답하지 않았습니다: ${log}`);
}

test('목록이 살아 있으면 고르기 목록·요약이 지라 값이 되고 낡음 경고가 사라진다 — 파일은 쓰지 않는다', async (t) => {
  const server = await startLiveJiraServer(t);
  const snapshotFile = path.join(server.home, 'jira_issues.md');
  const stamp = () => { const stat = fs.statSync(snapshotFile); return `${stat.size}:${stat.mtimeMs}`; };
  const before = stamp();
  const read = async () => (await (await fetch(server.origin + '/api/items')).json());

  // 첫 조회는 지라를 기다리지 않는다 — 그 자리에서 파일 값으로 답하고 갱신은 뒤에서 돈다.
  const first = await read();
  assert.equal(first.jiraIssues[0].summary, '파일에서 온 낡은 요약');
  assert.notEqual(first.jiraSync.live, true);

  const deadline = Date.now() + 10000;
  let live = first;
  while (Date.now() < deadline && live.jiraSync.live !== true) {
    await new Promise(resolve => setTimeout(resolve, 50));
    live = await read();
  }
  assert.equal(live.jiraSync.live, true, '뒤에서 돈 갱신이 들어오면 그때부터 지라 값이다');
  assert.equal(live.jiraSync.stale, false, '앱이 직접 읽는 동안에는 `어제 기준` 경고가 뜨지 않는다');
  assert.match(live.jiraSync.liveAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(live.jiraSync.connected, true);
  assert.deepEqual(live.jiraIssues.map(issue => [issue.key, issue.summary, issue.extra, issue.category]), [
    ['IO-12345', '지라에서 바로 읽은 요약', false, 'doing'],
    // 업무에 걸렸지만 내 담당·미완료 목록에는 없는 티켓 — 요약만 쓰는 `그 밖의 이슈`다.
    ['IO-77777', '업무에 걸린 다 끝난 티켓', true, 'done'],
  ]);
  assert.deepEqual(live.jiraIssues[0].versions, [{ name: 'v2.70.0', releaseDate: '2026-09-30', released: false }]);
  assert.equal(live.jiraIssues[0].due, '2026-10-02');
  // 항목의 프로젝트 이름(요약)도 지라에서 온 값이 붙는다(`projectLabelOf`가 같은 목록을 읽는다).
  const task = live.workflows.items.find(item => item.id === 'lv01');
  assert.equal(task.label, 'IO-77777 · 업무에 걸린 다 끝난 티켓');

  const payload = JSON.stringify(live);
  assert.doesNotMatch(payload, /emailAddress|accountId|lubon@live-jira\.test|712020:live/, '담당자 칸은 어디에도 옮기지 않는다');
  assert.doesNotMatch(payload, /fixture-token-never-real|fixture@example\.test/);
  assert.equal(stamp(), before, '조회도 갱신도 스냅샷 파일을 고치지 않는다');

  // 즉시 갱신 주소 — 티켓은 싣지 않고 결과 한 줄만 돌려주고, 여기서도 파일을 쓰지 않는다.
  const listed = await (await fetch(server.origin + '/api/jira/list?fresh=1')).json();
  assert.deepEqual(Object.keys(listed).sort(), ['connected', 'count', 'liveAt', 'ok']);
  assert.deepEqual([listed.ok, listed.connected, listed.count], [true, true, 2]);
  assert.match(listed.liveAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(stamp(), before);
  assert.equal(fs.existsSync(path.join(server.home, '.request-ledger.json')), false, 'GET은 앱 파일도 만들지 않는다');
});

test('지라가 죽어 있으면 스냅샷 파일 값으로 물러서고 낡음 경고도 그대로다', async (t) => {
  const server = await startLiveJiraServer(t, { fail: true });
  const listed = await (await fetch(server.origin + '/api/jira/list?fresh=1')).json();
  assert.deepEqual([listed.ok, listed.connected, listed.count, listed.liveAt], [true, true, 0, null]);
  const data = await (await fetch(server.origin + '/api/items')).json();
  assert.deepEqual(data.jiraIssues.map(issue => [issue.key, issue.summary, issue.extra]), [['IO-12345', '파일에서 온 낡은 요약', false]]);
  assert.equal(data.jiraSync.lastSync, '2026-01-02', '판정은 지금까지처럼 스냅샷 파일 날짜로 한다');
  assert.equal(data.jiraSync.stale, true);
  assert.notEqual(data.jiraSync.live, true);
});

test('GET /api/jira/list는 설정이 없으면 연결 안 됨으로 답하고 아무 파일도 건드리지 않는다', async () => {
  const snapshot = () => fs.readdirSync(directory).sort().map((name) => {
    const stat = fs.statSync(path.join(directory, name));
    return `${name}:${stat.size}:${stat.mtimeMs}`;
  }).join('|');
  const before = snapshot();
  const response = await fetch(`${base}/api/jira/list?fresh=1`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, connected: false, count: 0, liveAt: null });
  assert.equal(snapshot(), before);
  // 인증 예외가 아니다 — 원격에서 토큰 없이 부르면 다른 주소와 똑같이 막힌다(여기서는 로컬이라 열린다).
  assert.equal((await fetch(`${base}/api/jira/list`)).status, 200);
});

// ---------- 완료한 내 티켓도 연결 후보로 (BARCHIVE 1) ----------
// 여기서도 실제 지라에는 닿지 않는다 — 전부 가짜 fetch다.
const jiraDoneIssue = key => ({
  key,
  fields: {
    summary: `${key}의 끝난 일`,
    status: { name: '완료', statusCategory: { key: 'done' } },
    issuetype: { name: '스토리' },
    // 묻지 않은 칸을 지라가 끼워 보내도 앱이 옮기지 않는지 함께 본다.
    assignee: { displayName: '루본', emailAddress: JIRA_EMAIL, accountId: '712020:done' },
  },
});

test('완료한 내 티켓은 최근 90일·완료 범주만, 요약·상태·종류 세 칸만 묻는다', async () => {
  const fake = jiraFake({ '/rest/api/3/search/jql': () => json(jiraListBody([jiraDoneIssue('IO-48394'), { key: '수상한키', fields: {} }])) });
  const issues = await jiraListClient(fake).listDoneIssues(90);
  assert.deepEqual(issues, [{
    key: 'IO-48394', type: '스토리', status: '완료', summary: 'IO-48394의 끝난 일', extra: false,
    // 묻지 않은 칸은 빈 값으로 흐른다(고르는 줄에 쓰지 않는다).
    category: 'done', due: null, versions: [],
  }], '키 형식이 아닌 줄은 버린다');
  assert.equal(fake.calls.length, 1);
  const [call] = fake.calls;
  assert.equal(decodeURIComponent(call.url.split('jql=')[1].split('&')[0]),
    'assignee = currentUser() AND statusCategory = Done AND resolved >= -90d ORDER BY resolved DESC');
  assert.match(call.url, /fields=summary,status,issuetype&maxResults=100$/);
  // 담당자 칸은 애초에 달라고 하지 않는다.
  assert.doesNotMatch(call.url, /assignee&|assignee,|emailAddress|accountId/);
  assert.doesNotMatch(JSON.stringify(issues), /emailAddress|accountId|lubon|루본/);
  assert.doesNotMatch(JSON.stringify(issues), new RegExp(JIRA_EMAIL));
});

test('완료 목록도 100개까지만 들고 오고, 새 search 주소가 없으면 옛 주소로 한 번 물러선다', async () => {
  const many = jiraListBody(Array.from({ length: 140 }, (unused, index) => jiraDoneIssue(`IO-${2000 + index}`)));
  const capped = jiraFake({ '/rest/api/3/search/jql': () => json(many) });
  assert.equal((await jiraListClient(capped).listDoneIssues()).length, 100);
  // 기간을 주지 않거나 말이 안 되는 값이면 기본 90일이다(주소에 그대로 끼우므로 형식을 고정한다).
  assert.match(decodeURIComponent(capped.calls[0].url), /resolved >= -90d/);
  const odd = jiraFake({ '/rest/api/3/search/jql': () => json(jiraListBody([])) });
  await jiraListClient(odd).listDoneIssues(0);
  await jiraListClient(odd).listDoneIssues(9999);
  await jiraListClient(odd).listDoneIssues('90; DROP');
  assert.equal(odd.calls.every(call => decodeURIComponent(call.url).includes('resolved >= -90d')), true);
  await jiraListClient(odd).listDoneIssues(30);
  assert.match(decodeURIComponent(odd.calls[3].url), /resolved >= -30d/);

  const fallback = jiraFake({
    '/rest/api/3/search/jql': () => json({ errorMessages: ['not found'] }, 404),
    '/rest/api/3/search?': () => json(jiraListBody([jiraDoneIssue('IO-48394')])),
  });
  assert.deepEqual((await jiraListClient(fallback).listDoneIssues()).map(issue => issue.key), ['IO-48394']);
  assert.equal(fallback.calls.length, 2, '새 주소가 404일 때만, 옛 주소로 한 번만 물러선다');
});

test('완료 목록 API는 60초 메모리 캐시 한 벌이고, 설정·토큰이 없으면 연결 안 됨으로만 답한다', async () => {
  const fake = jiraFake({ '/rest/api/3/search': () => json(jiraListBody([jiraDoneIssue('IO-48394')])) });
  const off = jiraModule.createJiraApi({ config: {}, request: fake.request });
  assert.deepEqual(await off.listDone(90), { ok: true, connected: false });
  assert.equal(fake.calls.length, 0, '연결되지 않았으면 지라를 부르지 않는다');

  const noToken = jiraModule.createJiraApi({ config: jiraConfig, request: fake.request, readFile: () => '' });
  assert.deepEqual(await noToken.listDone(), { ok: true, connected: false });

  let clock = 0;
  const api = jiraModule.createJiraApi({ config: jiraConfig, request: fake.request, readFile: () => JIRA_TOKEN, now: () => clock });
  const first = await api.listDone(90);
  assert.equal(first.connected, true);
  assert.deepEqual(first.issues.map(issue => issue.key), ['IO-48394']);
  await api.listDone(90);
  assert.equal(fake.calls.length, 1, '60초 안에는 다시 묻지 않는다(키 없이 한 벌)');
  await api.listDone(30);
  assert.equal(fake.calls.length, 2, '기간이 다르면 새로 읽는다');
  clock += 61 * 1000;
  await api.listDone(30);
  assert.equal(fake.calls.length, 3, '60초가 지나면 새로 읽는다');
  assert.doesNotMatch(JSON.stringify(first), new RegExp(`${JIRA_TOKEN}|${JIRA_EMAIL}`), '토큰·이메일은 어디에도 싣지 않는다');

  const broken = jiraModule.createJiraApi({
    config: jiraConfig, readFile: () => JIRA_TOKEN,
    request: jiraFake({ '/rest/api/3/search': () => json({}, 401) }).request,
  });
  assert.deepEqual(await broken.listDone(), { ok: false, error: '지라 토큰을 확인해 주세요.', kind: 'auth' });
});

test('GET /api/jira/done은 설정이 없으면 연결 안 됨으로 답하고, 기간이 이상하면 400이고, 파일을 건드리지 않는다', async () => {
  const snapshot = () => fs.readdirSync(directory).sort().map((name) => {
    const stat = fs.statSync(path.join(directory, name));
    return `${name}:${stat.size}:${stat.mtimeMs}`;
  }).join('|');
  const before = snapshot();
  const response = await fetch(`${base}/api/jira/done?days=90`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, connected: false });
  assert.equal((await fetch(`${base}/api/jira/done`)).status, 200, '기간을 안 보내면 기본 90일이다');
  for (const bad of ['0', '400', '-3', '9.5', 'ninety']) {
    const refused = await fetch(`${base}/api/jira/done?days=${bad}`);
    assert.equal(refused.status, 400, bad);
    assert.equal((await refused.json()).error, '보낸 값을 확인해 주세요.');
  }
  assert.equal(snapshot(), before, 'GET은 어떤 파일도 쓰지 않는다');
});

// ---------- 직접 만든 프로젝트 → 지라 에픽으로 옮기기 (BMOVE) ----------
// 항목·회의·주간요약 소속을 한 트랜잭션으로 지라 에픽 쪽으로 옮긴다. renameProject와 같은 자리를
// 건드리되, 그룹 칸을 지우고 지라 칸을 새로 넣는다는 점이 다르다. 여기서도 실제 지라에는 닿지
// 않는다 — 서버는 자기 임시 폴더의 가짜 설정·가짜 토큰을 쓰고, 지라로 나가는 fetch는 자식 프로세스
// 안의 가짜 응답이 전부 가로챈다.
const movePost = (origin, body, key) => fetch(origin + '/api/project/move', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
  body: JSON.stringify(body),
}).then(async response => ({ status: response.status, ...await response.json() }));
const moveUndoPost = (origin, body) => fetch(origin + '/api/project/move-undo', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then(async response => ({ status: response.status, ...await response.json() }));

const JIRA_MOVE_SITE = 'https://move-jira.test';
const MOVE_TYPES = { issueTypes: [
  { id: '10000', name: '에픽', subtask: false, hierarchyLevel: 1 },
  { id: '10001', name: '작업', subtask: false, hierarchyLevel: 0 },
  { id: '10101', name: '하위 작업', subtask: true, hierarchyLevel: -1 },
] };
// IO-48501은 에픽, IO-9002는 에픽이 아닌 스토리 — "에픽만" 검증에 쓴다. IO-99999는 아예 모르는
// 티켓이라(못 읽음) 검증에 쓴다.
const MOVE_KNOWN = {
  'IO-48501': { summary: '결제 리뉴얼 v2', typeId: '10000' },
  'IO-9002': { summary: '알림센터 스토리', typeId: '10001' },
};
// `direct`는 복구(BRECOVERY) 테스트만 쓴다 — server.js를 `require()`로 빌려 쓰면(다른 BMOVE 서버들과
// 같은 방식) `require.main === module`이 거짓이라 시작할 때 도는 `mutations.recover()`가 통째로
// 건너뛰어진다(서버가 그 검사로 "지금 막 시작했을 때"를 가려서다). 복구가 실제로 걸리는지 보려면
// server.js를 **그대로 진입점**으로 띄우고, 가짜 지라는 `--require` 미리 불러오기로 fetch만 바꿔치기한다.
async function startMoveJiraServer(t, seed, { direct = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-jiramove-'));
  seed(home);
  const tokenFile = path.join(home, '.jira_token_fixture');
  fs.writeFileSync(tokenFile, 'fixture-token-never-real\n');
  const config = path.join(home, 'workspace.config.json');
  fs.writeFileSync(config, JSON.stringify({ jira: { siteUrl: JIRA_MOVE_SITE, email: 'fixture@example.test', tokenFile } }));
  const fetchPatch = `'use strict';
const SITE = ${JSON.stringify(JIRA_MOVE_SITE)};
const KNOWN = ${JSON.stringify(MOVE_KNOWN)};
const TYPES = ${JSON.stringify(MOVE_TYPES)};
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input && input.url ? input.url : input);
  if (!url.startsWith(SITE)) return realFetch(input, init);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (url.includes('/issue/createmeta/')) return json(TYPES);
  const hit = url.match(/\\/rest\\/api\\/3\\/issue\\/([A-Z][A-Z0-9]*-\\d+)/);
  if (hit && KNOWN[hit[1]]) return json({ fields: { summary: KNOWN[hit[1]].summary, issuetype: { id: KNOWN[hit[1]].typeId } } });
  if (hit) return json({ errorMessages: ['no issue'] }, 404);
  return json({ issues: [] });
};
`;
  const port = await freePort();
  let child;
  if (direct) {
    const preload = path.join(home, 'fake-jira-move-preload.js');
    fs.writeFileSync(preload, fetchPatch);
    child = spawn(process.execPath, ['--require', preload, path.join(__dirname, 'server.js')], {
      env: { ...process.env, WORKSPACE_DATA_DIR: home, WORKSPACE_PORT: String(port), WORKSPACE_NO_OPEN: '1', WORKSPACE_HOST: '', WORKSPACE_CONFIG: config },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } else {
    const wrapper = path.join(home, 'fake-jira-move-server.js');
    fs.writeFileSync(wrapper, `${fetchPatch}
const { server } = require(${JSON.stringify(path.join(__dirname, 'server.js'))});
server.listen(Number(process.env.WORKSPACE_PORT), '127.0.0.1', () => console.log('ready'));
`);
    child = spawn(process.execPath, [wrapper], {
      env: { ...process.env, WORKSPACE_DATA_DIR: home, WORKSPACE_PORT: String(port), WORKSPACE_NO_OPEN: '1', WORKSPACE_HOST: '', WORKSPACE_CONFIG: config },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(home, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`서버가 종료되었습니다 (${child.exitCode}): ${log}`);
    try { if ((await fetch(origin + '/api/storage-status')).ok) return { home, origin }; } catch { /* 아직 안 떴다 */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`서버가 응답하지 않았습니다: ${log}`);
}

const MOVE_REPORT = {
  schema: 1,
  weeks: {
    '2026-09-14': {
      rows: [
        { id: 'r1', heading: '완료한 일', group: '결제 리뉴얼', bucket: 'group:결제 리뉴얼:완료한 일:정산 배치',
          text: '정산 배치 설계 검토함', sourceIds: ['mv02'],
          evidence: [{ id: 'mv02', description: '완료한 정산 작업', status: 'done', type: 'task', outcome: '', label: '결제 리뉴얼', permalink: null }],
          locked: true, excluded: false },
        { id: 'r2', heading: '진행중', group: '운영툴', bucket: 'group:운영툴:진행중:운영툴 대시보드',
          text: '운영툴 대시보드 개선', sourceIds: [], evidence: [], locked: true, excluded: false },
      ],
      updatedAt: '2026-09-20T00:00:00.000Z',
    },
  },
};
function seedMove(home, report = MOVE_REPORT) {
  fs.writeFileSync(path.join(home, 'tasks.md'), '# Tasks\n'
    + '- 정산 배치 설계 검토하기 #task[id:mv01 status:to-do priority:high created:2026-09-20 group:결제_리뉴얼]\n'
    + '- 완료한 정산 작업 #task[id:mv02 status:done priority:medium created:2026-09-18 completed:2026-09-19 group:결제_리뉴얼]\n'
    + '- 게임 임베드 검수하기 #task[id:mv03 status:to-do priority:medium created:2026-09-20 jira:IO-9999]\n'
    + '- 대시보드 지표 정리하기 #task[id:mv06 status:to-do priority:medium created:2026-09-20 group:운영툴]\n');
  fs.writeFileSync(path.join(home, 'checks.md'), '# Checks\n'
    + '- 법무 검토 회신 #check[id:mv04 status:to-do priority:medium created:2026-09-20 who:하늘 group:결제_리뉴얼]\n');
  fs.writeFileSync(path.join(home, 'decisions.md'), '# Decisions\n'
    + '- 정산 주기는 주 단위로 한다 #decision[id:mv05 status:to-do priority:medium created:2026-09-20 group:결제_리뉴얼]\n');
  fs.writeFileSync(path.join(home, 'ideas.md'), '# Ideas\n'
    + '- 정산 리포트 자동화 #idea[id:mv07 status:to-do priority:low created:2026-09-20 project:결제_리뉴얼]\n');
  fs.writeFileSync(path.join(home, '.workflow.json'), JSON.stringify({
    items: {}, meetings: {
      m1: { id: 'm1', date: '2026-09-20', start: '10:00', end: '11:00', title: '결제 주간 싱크', series: '결제 주간 싱크', link: null,
        project: { type: 'group', value: '결제 리뉴얼', label: '결제 리뉴얼' } },
      m2: { id: 'm2', date: '2026-09-19', start: '14:00', end: '15:00', title: '운영 회의', series: '운영 회의', link: null,
        project: { type: 'group', value: '운영툴', label: '운영툴' } },
    },
    projectLinks: { '결제 리뉴얼': 'IO-1111' },
  }, null, 2));
  fs.writeFileSync(path.join(home, '.meeting_links.json'), JSON.stringify({ '결제 주간 싱크': 'group:결제 리뉴얼', '운영 회의': 'group:운영툴' }, null, 2));
  fs.writeFileSync(path.join(home, '.report-drafts.json'), JSON.stringify(report, null, 2));
}

test('BMOVE: 검증 — 직접 만든 프로젝트만, 에픽만, 읽을 수 있을 때만, 있는 그룹만 옮길 수 있다', async (t) => {
  const server = await startMoveJiraServer(t, seedMove);
  const refuse = async (body, message) => {
    const answer = await movePost(server.origin, body);
    assert.equal(answer.status, 400, JSON.stringify(body));
    assert.equal(answer.error, message, JSON.stringify(body));
  };
  // 직접 만든 프로젝트만(group:이 아니면).
  await refuse({ project: 'jira:IO-9999', to: 'IO-48501' }, '직접 만든 프로젝트만 옮길 수 있어요.');
  await refuse({ project: '결제 리뉴얼', to: 'IO-48501' }, '직접 만든 프로젝트만 옮길 수 있어요.');
  // 지라 번호 형식.
  await refuse({ project: 'group:결제 리뉴얼', to: 'io-48501' }, '지라 번호를 확인해 주세요.');
  await refuse({ project: 'group:결제 리뉴얼', to: '' }, '지라 번호를 확인해 주세요.');
  // 에픽만(IO-9002는 스토리).
  await refuse({ project: 'group:결제 리뉴얼', to: 'IO-9002' }, '에픽에만 옮길 수 있어요.');
  // 지라에서 읽을 수 있을 때만(IO-99999는 가짜 지라가 모른다).
  await refuse({ project: 'group:결제 리뉴얼', to: 'IO-99999' }, '지라에서 이 티켓을 읽지 못했어요.');
  // 있는 그룹만.
  await refuse({ project: 'group:없는 프로젝트', to: 'IO-48501' }, '프로젝트를 찾을 수 없어요.');

  // 전부 거절됐으니 어떤 파일도 바뀌지 않는다.
  assert.match(fs.readFileSync(path.join(server.home, 'tasks.md'), 'utf8'), /group:결제_리뉴얼\]/);
  assert.equal(fs.existsSync(path.join(server.home, '.mutation-journal.json')), false);
});

test('BMOVE: 옮기면 항목·회의·연결·주간요약이 한 트랜잭션으로 지라 쪽으로 넘어가고 그룹은 저절로 사라진다', async (t) => {
  const server = await startMoveJiraServer(t, seedMove);
  const answer = await movePost(server.origin, { project: 'group:결제 리뉴얼', to: 'IO-48501' });
  assert.equal(answer.status, 200);
  assert.equal(answer.ok, true);
  assert.equal(answer.project, 'jira:IO-48501');
  assert.equal(answer.from, '결제 리뉴얼');
  assert.equal(answer.to, 'IO-48501');
  assert.match(answer.moveId, /^mv_/);
  assert.deepEqual(answer.changed, { items: 5, meetings: 2, links: 1, report: 1 });

  // ① 업무 파일 — 지라가 걸린 줄(mv03)과 다른 그룹(mv06)은 그대로, 나머지 넷은 jira:IO-48501로.
  const tasks = fs.readFileSync(path.join(server.home, 'tasks.md'), 'utf8');
  assert.match(tasks, /정산 배치 설계 검토하기 #task\[id:mv01 status:to-do priority:high created:2026-09-20 jira:IO-48501\]/);
  assert.doesNotMatch(tasks, /id:mv01[^\n]*group:/);
  assert.match(tasks, /완료한 정산 작업 #task\[id:mv02 status:done priority:medium created:2026-09-18 completed:2026-09-19 jira:IO-48501\]/);
  assert.match(tasks, /id:mv03 status:to-do priority:medium created:2026-09-20 jira:IO-9999\]/, '이미 지라가 걸린 줄은 그대로다');
  assert.match(tasks, /id:mv06[^\n]*group:운영툴\]/, '다른 그룹은 그대로다');
  assert.match(fs.readFileSync(path.join(server.home, 'checks.md'), 'utf8'), /id:mv04 status:to-do priority:medium created:2026-09-20 who:하늘 jira:IO-48501\]/);
  assert.match(fs.readFileSync(path.join(server.home, 'decisions.md'), 'utf8'), /id:mv05 status:to-do priority:medium created:2026-09-20 jira:IO-48501\]/);
  assert.match(fs.readFileSync(path.join(server.home, 'ideas.md'), 'utf8'), /id:mv07 status:to-do priority:low created:2026-09-20 jira:IO-48501\]/, '아이디어도 project: 대신 jira:로 옮긴다');

  // ②③ 회의 프로젝트 · 수동 지라 연결(옮긴 뒤에는 뜻이 없어 지운다)
  const workflow = readJson(path.join(server.home, '.workflow.json'));
  assert.deepEqual(workflow.meetings.m1.project, { type: 'jira', value: 'IO-48501', label: 'IO-48501' });
  assert.deepEqual(workflow.meetings.m2.project, { type: 'group', value: '운영툴', label: '운영툴' });
  assert.deepEqual(workflow.projectLinks, {});

  // ④ 회의 제목 → 프로젝트 표
  assert.deepEqual(readJson(path.join(server.home, '.meeting_links.json')), { '결제 주간 싱크': 'jira:IO-48501', '운영 회의': 'group:운영툴' });

  // ⑤ 주간요약 저장본 — group:결제 리뉴얼: 행만 jira:IO-48501: 꼴로, 이름은 방금 읽은 지라 요약으로.
  const rows = readJson(path.join(server.home, '.report-drafts.json')).weeks['2026-09-14'].rows;
  const r1 = rows.find(row => row.id === 'r1');
  assert.equal(r1.group, 'IO-48501 · 결제 리뉴얼 v2');
  assert.equal(r1.bucket, 'jira:IO-48501:완료한 일:정산 배치');
  assert.equal(r1.evidence[0].label, 'IO-48501 · 결제 리뉴얼 v2');
  assert.equal(r1.text, '정산 배치 설계 검토함', '보고 문장은 손대지 않는다');
  const r2 = rows.find(row => row.id === 'r2');
  assert.deepEqual([r2.group, r2.bucket], ['운영툴', 'group:운영툴:진행중:운영툴 대시보드']);

  // ⑥ 이동 기록은 저장은 되지만 화면(snapshot)에는 내려보내지 않는다.
  assert.ok(Array.isArray(workflow.projectMoves) && workflow.projectMoves.length === 1);
  const record = workflow.projectMoves[0];
  assert.equal(record.id, answer.moveId);
  assert.equal(record.from, '결제 리뉴얼');
  assert.equal(record.to, 'IO-48501');
  assert.deepEqual([...record.items].sort(), ['mv01', 'mv02', 'mv04', 'mv05', 'mv07']);
  assert.deepEqual(record.meetings, ['m1']);
  assert.deepEqual(record.links, { '결제 리뉴얼': 'IO-1111' });
  assert.deepEqual(record.meetingLinks, ['결제 주간 싱크']);
  assert.deepEqual(record.reportRows, ['r1']);

  // 그룹은 항목이 하나도 안 남아 화면 목록에서 저절로 사라진다.
  const data = await (await fetch(server.origin + '/api/items')).json();
  assert.ok(!data.customGroups.includes('결제 리뉴얼') && data.customGroups.includes('운영툴'));
  assert.equal(data.workflows.projectMoves, undefined, '이동 기록은 화면에 내려보내지 않는다');
});

test('BMOVE: 한 자리라도 실패하면 전부 되돌아간다 — 업무 파일까지 쓴 뒤 되돌린 것이다', async (t) => {
  const server = await startMoveJiraServer(t, home => seedMove(home, { schema: 2, weeks: {} }));
  const files = ['tasks.md', 'checks.md', 'decisions.md', 'ideas.md', '.workflow.json', '.meeting_links.json', '.report-drafts.json'];
  const before = files.map(name => fs.readFileSync(path.join(server.home, name), 'utf8'));

  const failed = await movePost(server.origin, { project: 'group:결제 리뉴얼', to: 'IO-48501' });
  assert.equal(failed.status, 400);
  assert.match(failed.error, /보고 기록 형식을 확인해 주세요/);
  assert.deepEqual(files.map(name => fs.readFileSync(path.join(server.home, name), 'utf8')), before);

  assert.equal((await (await fetch(server.origin + '/api/storage-status')).json()).recoveryNeeded, false, '되돌리기가 받아들여져 저장은 잠기지 않는다');
  fs.writeFileSync(path.join(server.home, '.report-drafts.json'), JSON.stringify(MOVE_REPORT, null, 2));
  assert.equal((await movePost(server.origin, { project: 'group:결제 리뉴얼', to: 'IO-48501' })).ok, true, '형식을 고친 뒤에는 통한다');
});

test('BMOVE: 복구가 필요한 동안에는 옮기지 않는다', async (t) => {
  const server = await startMoveJiraServer(t, (home) => {
    seedMove(home);
    fs.writeFileSync(path.join(home, '.mutation-journal.json'), journalEntry(path.join(home, 'tasks.md'), '# Tasks\n', '# Tasks\n- 중단된 저장\n'));
    fs.writeFileSync(path.join(home, '.mutation.lock'), String(deadPid()));
  }, { direct: true });
  const blocked = await movePost(server.origin, { project: 'group:결제 리뉴얼', to: 'IO-48501' });
  assert.equal(blocked.status, 503);
  assert.match(blocked.error, /저장을 멈췄어요/);
  assert.match(fs.readFileSync(path.join(server.home, 'tasks.md'), 'utf8'), /group:결제_리뉴얼\]/);
});

test('BMOVE: 이동 기록은 최근 20개만 남긴다', async (t) => {
  const server = await startMoveJiraServer(t, (home) => {
    seedMove(home);
    const workflow = readJson(path.join(home, '.workflow.json'));
    workflow.projectMoves = Array.from({ length: 20 }, (unused, index) => ({ id: `mv_old${index}`, from: `옛 프로젝트${index}`, to: 'IO-0', at: '2026-09-01T00:00:00.000Z', items: [], meetings: [], links: null, meetingLinks: [], reportRows: [], reportLabel: 'IO-0', counts: { items: 0, meetings: 0, report: 0 } }));
    fs.writeFileSync(path.join(home, '.workflow.json'), JSON.stringify(workflow, null, 2));
  });
  const answer = await movePost(server.origin, { project: 'group:결제 리뉴얼', to: 'IO-48501' });
  assert.equal(answer.ok, true);
  const moves = readJson(path.join(server.home, '.workflow.json')).projectMoves;
  assert.equal(moves.length, 20, '가장 오래된 기록을 밀어내고 20개만 유지한다');
  assert.equal(moves[0].id, 'mv_old1', '가장 오래된 것(mv_old0)이 밀려난다');
  assert.equal(moves[19].id, answer.moveId);
});

test('BMOVE: 되돌리기는 기록에 있는 그 대상만 반대로 옮기고, 한 번만 된다', async (t) => {
  const server = await startMoveJiraServer(t, seedMove);
  const files = ['tasks.md', 'checks.md', 'decisions.md', 'ideas.md', '.meeting_links.json', '.report-drafts.json'];
  const before = files.map(name => fs.readFileSync(path.join(server.home, name), 'utf8'));
  const workflowBefore = readJson(path.join(server.home, '.workflow.json'));

  const moved = await movePost(server.origin, { project: 'group:결제 리뉴얼', to: 'IO-48501' });
  assert.equal(moved.ok, true);
  const undone = await moveUndoPost(server.origin, { moveId: moved.moveId });
  assert.equal(undone.status, 200);
  assert.deepEqual(undone, { status: 200, ok: true, project: 'group:결제 리뉴얼', restored: { items: 5, meetings: 2, report: 1 }, skipped: 0 });
  assert.deepEqual(files.map(name => fs.readFileSync(path.join(server.home, name), 'utf8')), before, '옮기기 전과 글자 하나까지 같다');
  // .workflow.json은 meetings·projectLinks가 옮기기 전과 같다 — 이동 기록(`projectMoves`)만 빈 배열로
  // 남는다(비운 기록도 한 번 만들어진 칸은 다른 표(반응 필요 치우기 등)처럼 지우지 않고 둔다).
  const workflowAfter = readJson(path.join(server.home, '.workflow.json'));
  assert.deepEqual(workflowAfter.meetings, workflowBefore.meetings);
  assert.deepEqual(workflowAfter.projectLinks, workflowBefore.projectLinks);
  assert.deepEqual(workflowAfter.projectMoves, []);

  // 한 번 되돌리면 기록이 지워져 다시는 되돌릴 수 없다.
  const again = await moveUndoPost(server.origin, { moveId: moved.moveId });
  assert.equal(again.status, 400);
  assert.match(again.error, /되돌릴 기록이 없어요/);
  const missing = await moveUndoPost(server.origin, { moveId: 'mv_없는것' });
  assert.equal(missing.status, 400);
  assert.match(missing.error, /되돌릴 기록이 없어요/);
});

test('BMOVE: 옮긴 뒤 그 에픽에 새로 생긴 항목·다시 바뀐 회의는 되돌리기가 건드리지 않는다', async (t) => {
  const server = await startMoveJiraServer(t, seedMove);
  const moved = await movePost(server.origin, { project: 'group:결제 리뉴얼', to: 'IO-48501' });
  assert.equal(moved.ok, true);

  // 이 에픽에 새로 생긴 항목 — 이동 기록에는 없는 id다.
  const created = await fetch(server.origin + '/api/today-task/create', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description: '옮긴 뒤 새로 생긴 일', jira: 'IO-48501' }),
  }).then(r => r.json());
  assert.equal(created.ok, true);

  // 회의 m1은 옮긴 뒤 이미 다른 지라 키로 다시 바뀌었다고 가정한다(그 사이 사람이 손으로 바꿈).
  const workflow = readJson(path.join(server.home, '.workflow.json'));
  workflow.meetings.m1.project = { type: 'jira', value: 'IO-9002', label: 'IO-9002' };
  fs.writeFileSync(path.join(server.home, '.workflow.json'), JSON.stringify(workflow, null, 2));

  const undone = await moveUndoPost(server.origin, { moveId: moved.moveId });
  assert.equal(undone.ok, true);
  assert.equal(undone.restored.items, 5, '기록에 있던 항목은 그대로 되돌아간다');
  assert.equal(undone.restored.meetings, 1, 'm1은 건너뛰고 회의 제목 표(m1 아닌 결제 주간 싱크)만 돌아간다');
  assert.equal(undone.skipped, 1, 'm1 하나는 건너뛴다');

  // 새로 생긴 항목은 그대로 지라에 남는다.
  const data = await (await fetch(server.origin + '/api/items')).json();
  const survivor = [...data.todayTasks, ...data.laterTasks].find(item => item.id === created.id);
  assert.equal(survivor.jira, 'IO-48501');
  // m1은 사람이 다시 바꾼 값(IO-9002) 그대로 남는다 — undo가 덮어쓰지 않는다.
  assert.deepEqual(readJson(path.join(server.home, '.workflow.json')).meetings.m1.project, { type: 'jira', value: 'IO-9002', label: 'IO-9002' });
});

// ---------- 지라에 새로 만들기 (BJCREATE — 지라에 이슈를 만든다) ----------
// 여기서도 실제 지라에는 절대 닿지 않는다: 모든 요청은 가짜 fetch가 받아 기록만 한다.
// `무엇이 만들어졌는가`는 기록된 method·본문으로 판정한다(GET만 나갔으면 아무것도 만들지 않은 것이다).
// 확정된 값 그대로다: 에픽 10000(계층 1) · 작업 10001 · 스토리 10003 · 버그 10004 · 하위 작업은 계층 -1.
const jiraCreateTypes = { issueTypes: [
  { id: '10000', name: '에픽', subtask: false, hierarchyLevel: 1 },
  { id: '10001', name: '작업', subtask: false, hierarchyLevel: 0 },
  { id: '10003', name: '스토리', subtask: false, hierarchyLevel: 0 },
  { id: '10004', name: '버그', subtask: false, hierarchyLevel: 0 },
  { id: '10101', name: '하위 작업', subtask: true, hierarchyLevel: -1 },
] };
// BJASSIGN — 새로 만든 에픽만 이 계정으로 배정한다(하위 티켓은 배정을 아예 시도하지 않는다).
const JIRA_CREATE_ME = 'fixture-create-me-account';
// 만들기 요청을 차례대로 받아 새 키를 내주는 가짜 지라. `refuse`에 적은 요약은 그 상태로 거절한다.
// `mineId`가 null이면 `/myself`가 401을 돌려주고(누가 나인지 조회 실패), `assignStatus`가 204가
// 아니면 에픽 배정(`PUT .../assignee`)이 그 상태로 거절된다.
function jiraMakeFake({ types = jiraCreateTypes, refuse = {}, epic = null, mineId = JIRA_CREATE_ME, assignStatus = 204 } = {}) {
  let next = 48400;
  const made = [];
  const assigned = [];
  const fake = jiraFake({
    '/issue/createmeta': () => json(types),
    '/rest/api/3/myself': () => (mineId ? json({ accountId: mineId }) : json({}, 401)),
    // 이미 있는 에픽을 대조할 때 읽는 자리(요약과 종류 id만 묻는다)
    '/rest/api/3/issue/IO-': () => (epic ? json({ fields: { summary: epic.summary, issuetype: { id: epic.typeId } } }) : json({ errorMessages: ['no issue'] }, 404)),
  });
  const request = async (url, options) => {
    const method = (options && options.method) || 'GET';
    if (method === 'POST' && String(url).endsWith('/rest/api/3/issue')) {
      const sent = JSON.parse(options.body);
      fake.calls.push({ url, headers: options.headers, method, body: sent });
      const summary = sent.fields.summary;
      if (refuse[summary]) return json({ errorMessages: ['refused'] }, refuse[summary]);
      next += 1;
      const key = `IO-${next}`;
      made.push({ key, summary, parent: sent.fields.parent ? sent.fields.parent.key : null, type: sent.fields.issuetype.id });
      return json({ id: '1', key });
    }
    if (method === 'PUT' && String(url).endsWith('/assignee')) {
      const sent = JSON.parse(options.body);
      fake.calls.push({ url, headers: options.headers, method, body: sent });
      if (assignStatus !== 204) return json({ errorMessages: ['assign refused'] }, assignStatus);
      assigned.push({ url, accountId: sent.accountId });
      return new Response(null, { status: 204 });
    }
    return fake.request(url, options);
  };
  return { request, calls: fake.calls, made, assigned };
}
const jiraMakeApi = (fake, extra = {}) => jiraModule.createJiraApi({ config: jiraConfig, request: fake.request, readFile: () => JIRA_TOKEN, ...extra });

test('BJCREATE: 만들 수 있는 종류는 계층으로 가른다 — 에픽은 계층 1, 하위 후보는 표준 타입뿐', () => {
  const shaped = jiraModule.shapeCreateTypes(jiraCreateTypes);
  assert.deepEqual(shaped.map(type => [type.id, type.level]), [['10000', 1], ['10001', 0], ['10003', 0], ['10004', 0], ['10101', -1]]);
  assert.equal(jiraModule.epicTypeOf(shaped).id, '10000', '이름이 아니라 계층 1로 고른다');
  assert.deepEqual(jiraModule.childTypesOf(shaped).map(type => type.id), ['10001', '10003', '10004'], '하위 작업(subtask)은 쓰지 않는다');
  assert.equal(jiraModule.defaultChildType(shaped).id, '10001', '기본은 이름에 `작업`/`Task`가 있는 것');
  // 옛 주소의 모양(projects[0].issuetypes)도 같은 결과로 편다. `hierarchyLevel`이 없으면 subtask로만 가른다.
  const old = jiraModule.shapeCreateTypes({ projects: [{ key: 'IO', issuetypes: [
    { id: '10000', name: 'Epic', subtask: false },
    { id: '10002', name: 'Task', subtask: false },
    { id: '10101', name: 'Sub-task', subtask: true },
  ] }] });
  assert.deepEqual(old.map(type => [type.id, type.level]), [['10000', 0], ['10002', 0], ['10101', -1]]);
  assert.equal(jiraModule.defaultChildType(old).id, '10002');
  assert.equal(jiraModule.shapeCreateTypes({}).length, 0, '모르는 모양이 와도 빈 목록으로 흐른다');
});

test('BJCREATE: create-meta는 새 주소를 먼저 부르고 없으면 옛 주소로 한 번 물러서며 60초 캐시한다', async () => {
  const fallback = jiraFake({
    '/issue/createmeta/IO/issuetypes': () => json({ errorMessages: ['not found'] }, 404),
    '/issue/createmeta?projectKeys=IO': () => json({ projects: [{ key: 'IO', issuetypes: jiraCreateTypes.issueTypes }] }),
  });
  const fellBack = await jiraMakeApi(fallback).createMeta('IO');
  assert.equal(fellBack.ok, true);
  assert.deepEqual(fellBack.types.map(type => type.name), ['작업', '스토리', '버그']);
  assert.deepEqual(fellBack.epic, { id: '10000', name: '에픽' });
  assert.equal(fellBack.defaultTypeId, '10001');
  assert.equal(fallback.calls.length, 2);

  let clock = 1000;
  const fake = jiraFake({ '/issue/createmeta': () => json(jiraCreateTypes) });
  const api = jiraMakeApi(fake, { now: () => clock });
  await api.createMeta('IO');
  await api.createMeta('IO');
  assert.equal(fake.calls.length, 1, '60초 안에는 다시 부르지 않는다');
  await api.createMeta('PAY');
  assert.equal(fake.calls.length, 2, '캐시는 프로젝트마다 따로다');
  clock += 61 * 1000;
  await api.createMeta('IO');
  assert.equal(fake.calls.length, 3, '60초가 지나면 다시 읽는다');
  // 프로젝트 키 형식은 API에서도 막는다(지라를 부르지 않는다).
  assert.deepEqual(await api.createMeta('io-1'), { ok: false, error: '지라 번호를 확인해 주세요.', kind: 'key' });
  assert.equal(fake.calls.length, 3);
  // 돌려주는 값 어디에도 토큰·이메일이 없다.
  const payload = JSON.stringify(await api.createMeta('IO'));
  assert.doesNotMatch(payload, new RegExp(JIRA_TOKEN));
  assert.doesNotMatch(payload, new RegExp(JIRA_EMAIL));
});

test('BJCREATE: 에픽을 먼저 만들고 하위를 차례대로 그 에픽에 붙인다 — 보내는 칸은 넷뿐이다', async () => {
  const fake = jiraMakeFake();
  const result = await jiraMakeApi(fake).create({ plan: {
    projectKey: 'IO',
    epic: { summary: '게시글 작성하기_게임 임베드' },
    children: [
      { summary: '[Web] 게시글 작성하기_게임 임베드', issueTypeId: '10001' },
      { summary: '[QA] 게시글 작성하기_게임 임베드', issueTypeId: '10001' },
    ],
  } });
  assert.equal(result.ok, true);
  assert.equal(result.made, 3);
  assert.equal(result.failed, 0);
  assert.equal(result.epic.created, true);
  assert.equal(result.epic.url, `${JIRA_SITE}/browse/${result.epic.key}`);
  assert.deepEqual(result.children.map(child => child.summary), ['[Web] 게시글 작성하기_게임 임베드', '[QA] 게시글 작성하기_게임 임베드']);
  // 순서: 종류 조회(GET) → 에픽 → 하위 둘. 하위는 모두 그 에픽을 부모로 단다.
  assert.deepEqual(fake.made.map(entry => [entry.summary, entry.parent, entry.type]), [
    ['게시글 작성하기_게임 임베드', null, '10000'],
    ['[Web] 게시글 작성하기_게임 임베드', result.epic.key, '10001'],
    ['[QA] 게시글 작성하기_게임 임베드', result.epic.key, '10001'],
  ]);
  const posts = fake.calls.filter(call => call.method === 'POST');
  assert.equal(posts.length, 3);
  assert.deepEqual(Object.keys(posts[1].body.fields).sort(), ['issuetype', 'parent', 'project', 'summary']);
  assert.deepEqual(posts[0].body.fields.project, { key: 'IO' });
  // 쓰기 직전에 만들 수 있는 종류를 **다시 읽어** 대조한다.
  assert.match(fake.calls[0].url, /\/issue\/createmeta\/IO\/issuetypes/);
  assert.equal(fake.calls[0].method, 'GET');
  // 응답과 요청 어디에도 토큰·이메일이 없다.
  assert.doesNotMatch(JSON.stringify(result), new RegExp(`${JIRA_TOKEN}|${JIRA_EMAIL}`));
  assert.doesNotMatch(fake.calls.map(call => call.url).join(' '), new RegExp(`${JIRA_TOKEN}|${JIRA_EMAIL}`));
});

test('BJCREATE: 하위 하나가 실패해도 다음은 계속하고, 실패한 줄만 이유를 달고 온다', async () => {
  const fake = jiraMakeFake({ refuse: { '[Android] 임베드': 400, '[QA] 임베드': 403 } });
  const result = await jiraMakeApi(fake).create({ plan: {
    projectKey: 'IO',
    epic: { summary: '임베드' },
    children: [
      { summary: '[Web] 임베드', issueTypeId: '10001' },
      { summary: '[Android] 임베드', issueTypeId: '10001' },
      { summary: '[QA] 임베드', issueTypeId: '10001' },
    ],
  } });
  assert.equal(result.ok, true);
  assert.equal(result.made, 2, '에픽 + 성공한 하위 하나');
  assert.equal(result.failed, 2);
  assert.ok(result.children[0].key);
  assert.equal(result.children[1].kind, 'makeReject');
  assert.match(result.children[1].error, /필수 항목이 더 있을 수 있어요/);
  assert.equal(result.children[2].kind, 'makeForbidden');
  assert.match(result.children[2].error, /권한이 없어요/);
  assert.equal(fake.made.length, 2, '실패한 것은 만들어지지 않았다');
  // 지라 원문(`refused`)은 어느 문구에도 섞이지 않는다.
  assert.doesNotMatch(JSON.stringify(result), /refused/);
});

test('BJCREATE: 에픽 자체가 실패하면 하위는 시작하지도 않는다', async () => {
  const fake = jiraMakeFake({ refuse: { '만들 수 없는 에픽': 400 } });
  const result = await jiraMakeApi(fake).create({ plan: {
    projectKey: 'IO',
    epic: { summary: '만들 수 없는 에픽' },
    children: [{ summary: '[Web] 하위', issueTypeId: '10001' }],
  } });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'makeReject');
  assert.equal(fake.made.length, 0);
  assert.equal(fake.calls.filter(call => call.method === 'POST').length, 1, '에픽 하나만 시도했다');
});

test('BJCREATE: 이미 있는 에픽에 붙일 때는 그 티켓이 정말 에픽인지 쓰기 직전에 확인한다', async () => {
  const good = jiraMakeFake({ epic: { summary: '게시글 작성하기_게임 임베드', typeId: '10000' } });
  const ok = await jiraMakeApi(good).create({ plan: {
    projectKey: 'IO', epic: { key: 'IO-48394' }, children: [{ summary: '[Web] 붙임', issueTypeId: '10001' }],
  } });
  assert.equal(ok.ok, true);
  assert.equal(ok.epic.created, false);
  assert.equal(ok.epic.summary, '게시글 작성하기_게임 임베드');
  assert.equal(ok.made, 1, '에픽은 이미 있으므로 세지 않는다');
  assert.deepEqual(good.made.map(entry => entry.parent), ['IO-48394']);

  // 에픽이 아닌 티켓(작업)에는 붙이지 않는다 — 아무것도 만들지 않는다.
  const wrong = jiraMakeFake({ epic: { summary: '그냥 작업', typeId: '10001' } });
  const refused = await jiraMakeApi(wrong).create({ plan: {
    projectKey: 'IO', epic: { key: 'IO-48394' }, children: [{ summary: '[Web] 붙임', issueTypeId: '10001' }],
  } });
  assert.deepEqual(refused, { ok: false, error: '고른 티켓이 에픽이 아니에요.', kind: 'notEpic' });
  assert.equal(wrong.made.length, 0);

  // 다른 프로젝트의 에픽 키는 형식 단계에서 거절한다(지라를 부르지도 않는다).
  const other = jiraMakeFake();
  assert.equal((await jiraMakeApi(other).create({ plan: {
    projectKey: 'IO', epic: { key: 'PAY-1' }, children: [{ summary: '[Web] 붙임', issueTypeId: '10001' }],
  } })).kind, 'key');
  assert.equal(other.calls.length, 0);
});

test('BJCREATE: 보낸 값은 개수·요약·종류까지 다시 검증하고, 종류가 바뀌었으면 아무것도 만들지 않는다', async () => {
  const many = jiraMakeFake();
  const over = await jiraMakeApi(many).create({ plan: {
    projectKey: 'IO', epic: { summary: '너무 많음' },
    children: Array.from({ length: 13 }, (unused, at) => ({ summary: `[R${at}] 하위`, issueTypeId: '10001' })),
  } });
  assert.deepEqual(over, { ok: false, error: '한 번에 12개까지 만들 수 있어요.', kind: 'tooMany' });
  assert.equal(many.calls.length, 0, '개수부터 틀리면 지라를 부르지 않는다');

  const bad = jiraMakeFake();
  const api = jiraMakeApi(bad);
  const cases = [
    { plan: { projectKey: 'io', epic: { summary: 'x' }, children: [] }, kind: 'key' },
    { plan: { projectKey: 'IO', epic: { summary: '   ' }, children: [] }, kind: 'value' },
    { plan: { projectKey: 'IO', epic: { summary: 'x'.repeat(256) }, children: [] }, kind: 'value' },
    { plan: { projectKey: 'IO', epic: { summary: '줄\n바꿈' }, children: [] }, kind: 'value' },
    { plan: { projectKey: 'IO', epic: { summary: 'x' }, children: [{ summary: '', issueTypeId: '10001' }] }, kind: 'value' },
    { plan: { projectKey: 'IO', epic: { summary: 'x' }, children: [{ summary: '하위', issueTypeId: '../etc' }] }, kind: 'value' },
    { plan: { projectKey: 'IO', epic: { key: 'IO-1' }, children: [] }, kind: 'value' },
    { kind: 'value' },
  ];
  for (const entry of cases) assert.equal((await api.create(entry.plan ? { plan: entry.plan } : {})).kind, entry.kind, JSON.stringify(entry.plan));
  assert.equal(bad.calls.length, 0, '형식이 틀리면 지라를 부르지 않는다');

  // 화면이 본 종류가 지라에서 사라졌으면(쓰기 직전 재조회 대조) 아무것도 만들지 않는다.
  const stale = jiraMakeFake({ types: { issueTypes: [{ id: '10000', name: '에픽', subtask: false, hierarchyLevel: 1 }] } });
  const gone = await jiraMakeApi(stale).create({ plan: {
    projectKey: 'IO', epic: { summary: 'x' }, children: [{ summary: '[Web] 하위', issueTypeId: '10001' }],
  } });
  assert.equal(gone.kind, 'typeStale');
  assert.equal(stale.made.length, 0);

  // 에픽 타입이 아예 없는 프로젝트에는 새 에픽을 만들지 않는다.
  const noEpic = jiraMakeFake({ types: { issueTypes: [{ id: '10001', name: '작업', subtask: false, hierarchyLevel: 0 }] } });
  assert.equal((await jiraMakeApi(noEpic).create({ plan: { projectKey: 'IO', epic: { summary: 'x' }, children: [] } })).kind, 'epicType');
  assert.equal(noEpic.made.length, 0);
});

test('BJCREATE: 같은 계획을 60초 안에 두 번 받으면 거절하고, 아무것도 못 만든 요청은 곧바로 다시 받는다', async () => {
  let clock = 1000;
  const fake = jiraMakeFake();
  const api = jiraMakeApi(fake, { now: () => clock });
  const plan = { projectKey: 'IO', epic: { summary: '한 번만' }, children: [{ summary: '[Web] 한 번만', issueTypeId: '10001' }] };
  assert.equal((await api.create({ plan })).ok, true);
  assert.equal(fake.made.length, 2);
  assert.deepEqual(await api.create({ plan }), { ok: false, error: '같은 내용을 방금 보냈어요. 잠시 뒤에 다시 시도해 주세요.', kind: 'duplicate' });
  assert.equal(fake.made.length, 2, '두 번째 요청은 지라에 닿지 않는다');
  clock += 61 * 1000;
  assert.equal((await api.create({ plan })).ok, true, '60초가 지나면 같은 계획도 다시 받는다');
  assert.equal(fake.made.length, 4);

  // 아무것도 만들지 못하고 끝난 계획은 지문을 남기지 않는다(바로 다시 시도할 수 있어야 한다).
  const refusing = jiraMakeFake({ refuse: { '거절되는 에픽': 400 } });
  const retry = jiraMakeApi(refusing);
  const badPlan = { plan: { projectKey: 'IO', epic: { summary: '거절되는 에픽' }, children: [] } };
  assert.equal((await retry.create(badPlan)).kind, 'makeReject');
  assert.equal((await retry.create(badPlan)).kind, 'makeReject', '중복이 아니라 같은 실패로 답한다');
});

test('BJCREATE: 설정이 없거나 토큰을 못 읽으면 지라를 부르지 않고 연결 필요로만 답한다', async () => {
  const fake = jiraMakeFake();
  const plan = { plan: { projectKey: 'IO', epic: { summary: 'x' }, children: [] } };
  const off = jiraModule.createJiraApi({ config: {}, request: fake.request });
  assert.deepEqual(await off.create(plan), { ok: false, error: '지라 연결이 필요해요.', kind: 'off' });
  assert.deepEqual(await off.createMeta('IO'), { ok: true, connected: false });
  const noToken = jiraModule.createJiraApi({ config: jiraConfig, request: fake.request, readFile: () => { throw new Error('ENOENT'); } });
  assert.deepEqual(await noToken.create(plan), { ok: false, error: '지라 연결이 필요해요.', kind: 'off' });
  assert.equal(fake.calls.length, 0);
});

test('BJCREATE: 새 주소 둘은 조회면 파일을 쓰지 않고, 형식이 틀린 값만 400이다', async () => {
  const snapshot = () => fs.readdirSync(directory).sort().map(name => {
    const stat = fs.statSync(path.join(directory, name));
    return `${name}:${stat.size}:${stat.mtimeMs}`;
  }).join('|');
  const before = snapshot();
  const meta = await fetch(`${base}/api/jira/create-meta?project=IO`);
  assert.equal(meta.status, 200);
  assert.deepEqual(await meta.json(), { ok: true, connected: false });
  const badMeta = await fetch(`${base}/api/jira/create-meta?project=io-1`);
  assert.equal(badMeta.status, 400);
  assert.deepEqual(await badMeta.json(), { ok: false, error: '지라 번호를 확인해 주세요.', kind: 'key' });
  // 설정이 없으면 만들기도 `지라 연결이 필요해요`로만 답한다(200 + ok:false).
  const off = await post('/api/jira/create', { plan: { projectKey: 'IO', epic: { summary: 'x' }, children: [] } });
  assert.equal(off.status, 200);
  assert.equal(off.kind, 'off');
  // 보낸 쪽 잘못(키·값·개수)만 400이다.
  assert.equal((await post('/api/jira/create', { plan: { projectKey: 'io', epic: { summary: 'x' } } })).status, 400);
  assert.equal((await post('/api/jira/create', {})).status, 400);
  assert.equal(snapshot(), before, '두 주소 모두 어떤 파일도 만들거나 고치지 않는다');
});

test('BJCREATE: 직군 세트는 앱 데이터로만 저장하고 검증을 통과한 것만 목록에 실린다', async () => {
  const saved = await post('/api/workflow/jira-roles', { roles: [{ label: 'Web', prefix: '[Web]' }, { label: ' Data ', prefix: ' [Data] ' }] });
  assert.equal(saved.ok, true);
  assert.deepEqual((await items()).workflows.jiraRoles, [{ label: 'Web', prefix: '[Web]' }, { label: 'Data', prefix: '[Data]' }]);
  const bad = [
    { roles: 'nope' },
    { roles: Array.from({ length: 21 }, (unused, at) => ({ label: `R${at}`, prefix: `[R${at}]` })) },
    { roles: [{ label: '', prefix: '[x]' }] },
    { roles: [{ label: 'x'.repeat(31), prefix: '[x]' }] },
    { roles: [{ label: 'x', prefix: 'y'.repeat(21) }] },
    { roles: [{ label: '줄\n바꿈', prefix: '[x]' }] },
    { roles: [{ label: 'Web', prefix: '[Web]' }, { label: 'web', prefix: '[W]' }] },
  ];
  for (const body of bad) assert.equal((await post('/api/workflow/jira-roles', body)).status, 400, JSON.stringify(body));
  assert.deepEqual((await items()).workflows.jiraRoles, [{ label: 'Web', prefix: '[Web]' }, { label: 'Data', prefix: '[Data]' }], '거절된 요청은 저장을 고치지 않는다');
  // 전부 지우면 빈 목록이 그대로 남는다(기본값이 되살아나지 않는다 — 기본값은 화면이 쓴다).
  assert.equal((await post('/api/workflow/jira-roles', { roles: [] })).ok, true);
  assert.deepEqual((await items()).workflows.jiraRoles, []);
});

test('BJCREATE: 복구가 필요한 동안에는 지라에 만들지도, 직군 세트를 저장하지도 않는다', async (t) => {
  const server = await startServer(t, (home) => {
    // 저널이 기억하는 `이전 내용`과 파일이 다르다 = 밖에서 바뀐 파일이라 복구를 거절한다.
    fs.writeFileSync(path.join(home, 'tasks.md'), '# Tasks\n- 바깥에서 고친 줄 #task[id:outside status:to-do created:2026-09-20]\n');
    fs.writeFileSync(path.join(home, '.mutation-journal.json'), journalEntry(path.join(home, 'tasks.md'), '# Tasks\n', '# Tasks\n- 중단된 저장\n'));
    fs.writeFileSync(path.join(home, '.mutation.lock'), String(deadPid()));
  });
  const send = async (route, body) => {
    const response = await fetch(server.base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, ...await response.json() };
  };
  const made = await send('/api/jira/create', { plan: { projectKey: 'IO', epic: { summary: 'x' }, children: [] } });
  assert.equal(made.status, 503);
  assert.match(made.error, /저장을 멈췄어요/);
  const roles = await send('/api/workflow/jira-roles', { roles: [{ label: 'Web', prefix: '[Web]' }] });
  assert.equal(roles.status, 503);
  // 조회는 그대로 된다.
  assert.equal((await fetch(`${server.base}/api/jira/create-meta?project=IO`)).status, 200);
});

// ---------- BJASSIGN — 새로 만든 에픽만 나에게 자동 배정 ----------
// 하위 티켓은 직군별로 다른 사람에게 갈 수 있어 배정을 아예 시도하지 않는다(지금처럼 담당 없음).
test('BJASSIGN: 새로 만든 에픽은 만든 직후 나에게 배정하고, 배정 주소·본문은 accountId 하나뿐이다', async () => {
  const fake = jiraMakeFake();
  const result = await jiraMakeApi(fake).create({ plan: {
    projectKey: 'IO',
    epic: { summary: '게시글 작성하기_게임 임베드' },
    children: [{ summary: '[Web] 게시글 작성하기_게임 임베드', issueTypeId: '10001' }],
  } });
  assert.equal(result.ok, true);
  assert.equal(result.epic.created, true);
  assert.equal(result.epic.assigned, true);
  assert.equal(result.epic.assignError, undefined);
  assert.equal(fake.assigned.length, 1, '배정은 에픽 하나뿐이다');
  assert.equal(fake.assigned[0].url, `${JIRA_SITE}/rest/api/3/issue/${result.epic.key}/assignee`);
  assert.equal(fake.assigned[0].accountId, JIRA_CREATE_ME);
  // 몸통(body)에는 accountId 하나만 실리고, 주소(querystring)에는 accountId 값 자체가 없다.
  const put = fake.calls.find(call => call.method === 'PUT' && call.url.endsWith('/assignee'));
  assert.deepEqual(Object.keys(put.body), ['accountId']);
  assert.doesNotMatch(put.url.split('?')[1] || '', new RegExp(JIRA_CREATE_ME));
  // 하위 티켓에는 배정을 아예 시도하지 않는다 — `children[]`에 `assigned`/`assignError` 칸도 없다.
  assert.ok(result.children[0].key, '하위는 그대로 만들어진다');
  assert.equal('assigned' in result.children[0], false);
  assert.equal('assignError' in result.children[0], false);
  // 응답·계정 id 어디에도 계정 식별자가 노출되지 않는다.
  assert.doesNotMatch(JSON.stringify(result), new RegExp(JIRA_CREATE_ME));
});

test('BJASSIGN: 누가 나인지는 프로세스마다(같은 api 인스턴스) 한 번만 묻고 재사용한다', async () => {
  const fake = jiraMakeFake();
  const api = jiraMakeApi(fake);
  await api.create({ plan: { projectKey: 'IO', epic: { summary: '한 번' }, children: [] } });
  await api.create({ plan: { projectKey: 'IO', epic: { summary: '두 번' }, children: [] } });
  assert.equal(fake.calls.filter(call => call.url.includes('/myself')).length, 1, '두 번째 create()는 myself를 다시 묻지 않는다');
  assert.equal(fake.assigned.length, 2, '배정 자체는 매번 시도한다');
});

test('BJASSIGN: 누가 나인지 조회에 실패하면 아무것도 만들지 않고 전체를 중단한다', async () => {
  const denied = jiraMakeFake({ mineId: null });
  const result = await jiraMakeApi(denied).create({ plan: {
    projectKey: 'IO', epic: { summary: '만들면 안 됨' }, children: [{ summary: '[Web] 하위', issueTypeId: '10001' }],
  } });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'makeForbidden');
  assert.equal(denied.made.length, 0, '에픽도 하위도 만들지 않는다');
  assert.equal(denied.assigned.length, 0);
  assert.equal(denied.calls.filter(call => call.method === 'POST').length, 0, '지라에 쓰기 요청 자체가 없다');
});

test('BJASSIGN: myself가 401/403이면 다음 create() 때 다시 묻는다', async () => {
  let denied = true;
  const flaky = jiraMakeFake({ mineId: JIRA_CREATE_ME });
  // 첫 시도만 401로 거절되게 route를 뒤엎는다(누가 나인지 조회만) — `create()`가 이 값을 읽기 전에 끼운다.
  const base = flaky.request;
  const request = (url, options) => (String(url).includes('/rest/api/3/myself') && denied ? Promise.resolve(json({}, 401)) : base(url, options));
  const api = jiraModule.createJiraApi({ config: jiraConfig, request, readFile: () => JIRA_TOKEN });
  const first = await api.create({ plan: { projectKey: 'IO', epic: { summary: '거절됨' }, children: [] } });
  assert.equal(first.kind, 'makeForbidden');
  assert.equal(flaky.made.length, 0);
  denied = false;
  const second = await api.create({ plan: { projectKey: 'IO', epic: { summary: '이번엔 됨' }, children: [] } });
  assert.equal(second.ok, true);
  assert.equal(second.epic.assigned, true);
});

test('BJASSIGN: 이미 있는 에픽에 붙일 때는 에픽을 재배정하지 않는다 — `assigned` 칸 자체가 없다', async () => {
  const fake = jiraMakeFake({ epic: { summary: '남의 에픽', typeId: '10000' } });
  const result = await jiraMakeApi(fake).create({ plan: {
    projectKey: 'IO', epic: { key: 'IO-48394' }, children: [{ summary: '[Web] 붙임', issueTypeId: '10001' }],
  } });
  assert.equal(result.ok, true);
  assert.equal(result.epic.created, false);
  assert.equal('assigned' in result.epic, false, 'attach 모드는 assigned 칸을 두지 않는다');
  assert.equal('assignError' in result.epic, false);
  assert.equal(fake.assigned.length, 0, '배정 요청 자체가 나가지 않는다');
});

test('BJASSIGN: 배정만 실패해도 이미 만든 티켓은 그대로 유지되고 assignError만 붙는다', async () => {
  const fake = jiraMakeFake({ assignStatus: 403 });
  const result = await jiraMakeApi(fake).create({ plan: {
    projectKey: 'IO', epic: { summary: '배정만 실패' }, children: [{ summary: '[Web] 하위', issueTypeId: '10001' }],
  } });
  assert.equal(result.ok, true, '만들기 자체는 성공이다');
  assert.equal(result.epic.created, true);
  assert.ok(result.epic.key, '에픽은 실제로 만들어졌다');
  assert.equal(result.epic.assigned, undefined);
  assert.equal(result.epic.assignError, '지라에서 이 프로젝트에 이슈를 만들 권한이 없어요.');
  assert.equal(fake.made.length, 2, '에픽 + 하위 모두 만들어졌다');
  assert.equal(result.made, 2, '배정 실패가 만든 개수를 깎지 않는다');
  assert.equal(result.failed, 0);
});

test('BJASSIGN: 설정·토큰이 없으면 myself도 묻지 않는다', async () => {
  const fake = jiraMakeFake();
  const off = jiraModule.createJiraApi({ config: {}, request: fake.request });
  await off.create({ plan: { projectKey: 'IO', epic: { summary: 'x' }, children: [] } });
  assert.equal(fake.calls.length, 0);
});

// ---------- 반응 필요 (BATTENTION 1차 — 지라 댓글) ----------
// 여기도 실제 지라에는 절대 닿지 않는다: 전부 가짜 fetch이고, 사람 이름·계정 id·댓글 글자는
// 모두 이 파일에서 지어낸 것이다. 내 계정 id는 판별에만 쓰이고 응답에 실리지 않는지도 함께 본다.
const ATTENTION_ME = 'fixture-me-account';
const ATTENTION_OTHER = 'fixture-other-account';
const adfDoc = (...parts) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: parts }] });
const adfSay = value => adfDoc({ type: 'text', text: value });
const attentionComment = (id, accountId, name, created, body) => ({
  id, created, body,
  // 지라는 묻지 않아도 이메일·계정 id를 끼워 보낸다 — 앱이 옮기지 않는지 함께 본다.
  author: { accountId, displayName: name, emailAddress: `${name}@example.test` },
});
const attentionIssue = (key, comments, extra = {}) => ({
  key,
  fields: {
    summary: `${key}의 요약`,
    status: extra.status || { name: '진행 중', statusCategory: { key: 'indeterminate' } },
    comment: { comments, total: extra.total === undefined ? comments.length : extra.total },
  },
});
const attentionRow = (comments, extra = {}) =>
  jiraModule.shapeAttention(JIRA_SITE, attentionIssue(extra.key || 'IO-48394', comments, extra), ATTENTION_ME, comments);
const mineSaid = (id, at, body) => attentionComment(id, ATTENTION_ME, '나', at, body || adfSay('제가 확인할게요'));
const theySaid = (id, at, name, body) => attentionComment(id, ATTENTION_OTHER + name, name, at, body || adfSay(`${name}의 댓글`));

test('반응 필요는 내 마지막 댓글 뒤에 남은 다른 사람 댓글만 줄로 만든다', () => {
  const a = theySaid('10002', '2026-09-21T02:00:00.000+0000', '테스터A');
  const mine = mineSaid('10001', '2026-09-21T09:00:00.000+0000');
  const b = theySaid('10003', '2026-09-22T03:00:00.000+0000', '테스터B');
  assert.deepEqual(attentionRow([a, mine, b]), {
    id: 'jira:IO-48394:10003', source: 'jira', key: 'IO-48394', url: `${JIRA_SITE}/browse/IO-48394`,
    summary: 'IO-48394의 요약', status: '진행 중', statusTone: 'doing',
    who: '테스터B', others: 0, count: 1, preview: '테스터B의 댓글',
    at: '2026-09-22T03:00:00.000Z', mention: false,
  }, '내 댓글보다 앞선 댓글은 세지 않는다');

  // 내 댓글이 없으면 다른 사람 댓글 전부가 대상이고, 작성자가 둘이면 `외 N명`이 붙는다.
  const many = attentionRow([a, b]);
  assert.deepEqual([many.count, many.who, many.others], [2, '테스터B', 1]);
  // 같은 사람이 두 번 적었으면 `외 N명`은 없다.
  assert.equal(attentionRow([a, theySaid('10004', '2026-09-22T04:00:00.000+0000', '테스터A')]).others, 0);

  assert.equal(attentionRow([a, b, mineSaid('10005', '2026-09-23T01:00:00.000+0000')]), null, '내가 마지막으로 답했으면 줄이 없다');
  assert.equal(attentionRow([mine]), null, '다른 사람 댓글이 하나도 없으면 줄이 없다');
  assert.equal(attentionRow([]), null);
  // 주소를 이 키로 조립하고 치우기가 이 id로 걸린다 — 형식이 아니면 줄을 만들지 않는다.
  assert.equal(attentionRow([a], { key: '수상한키' }), null);
  assert.equal(attentionRow([theySaid('10-a', '2026-09-22T03:00:00.000+0000', '테스터A')]), null);
  assert.equal(jiraModule.shapeAttention(JIRA_SITE, attentionIssue('IO-48394', [a]), '', [a]), null, '누가 나인지 모르면 아무 줄도 만들지 않는다');
});

test('댓글이 최신순으로 와도 created 차례로 놓고 판정한다', () => {
  const mine = mineSaid('10001', '2026-09-22T05:00:00.000+0000');
  const theirs = theySaid('10002', '2026-09-22T04:00:00.000+0000', '테스터A');
  // 최신순(내 댓글이 먼저)으로 와도 "내가 마지막으로 답한" 것이므로 줄이 없어야 한다.
  assert.equal(attentionRow([mine, theirs]), null);
  const later = theySaid('10003', '2026-09-22T06:00:00.000+0000', '테스터A');
  assert.equal(attentionRow([later, mine, theirs]).id, 'jira:IO-48394:10003');
});

test('완료한 이슈도 빼지 않고, 지라 상태 글자와 범주를 함께 싣는다', () => {
  const row = attentionRow([theySaid('10002', '2026-09-22T03:00:00.000+0000', '테스터A')], {
    status: { name: '완료', statusCategory: { key: 'done' } },
  });
  assert.deepEqual([row.status, row.statusTone], ['완료', 'done'], '완료된 티켓에도 질문이 달린다');
  const unknown = attentionRow([theySaid('10002', '2026-09-22T03:00:00.000+0000', '테스터A')], { status: {} });
  assert.deepEqual([unknown.status, unknown.statusTone], ['', 'doing'], '모르는 범주는 진행으로 본다');
});

test('나를 부른 댓글은 표시가 붙고, 미리보기는 140자까지 편다', () => {
  const called = adfDoc(
    { type: 'text', text: '이거 ' },
    { type: 'mention', attrs: { id: ATTENTION_ME, text: '@나' } },
    { type: 'text', text: ' 확인 부탁해요' },
  );
  const row = attentionRow([theySaid('10002', '2026-09-22T03:00:00.000+0000', '테스터A', called)]);
  assert.equal(row.mention, true);
  assert.equal(row.preview, '이거 @나 확인 부탁해요', 'mention은 @표시이름으로 펴진다');
  // 다른 사람을 부른 댓글은 나를 부른 것이 아니다.
  const elsewhere = adfDoc({ type: 'mention', attrs: { id: 'someone-else', text: '@테스터B' } });
  assert.equal(attentionRow([theySaid('10002', '2026-09-22T03:00:00.000+0000', '테스터A', elsewhere)]).mention, false);

  // 문단 사이는 공백 하나, 글자가 아닌 노드(그림·첨부)는 비운다.
  const mixed = { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: '첫 문단' }] },
    { type: 'mediaSingle', attrs: { layout: 'center' } },
    { type: 'paragraph', content: [{ type: 'text', text: '둘째 문단' }] },
  ] };
  assert.equal(jiraModule.attentionPreview(mixed), '첫 문단 둘째 문단');
  const long = jiraModule.attentionPreview(adfSay('가'.repeat(400)));
  assert.equal(long.length, 140);
  assert.match(long, /…$/);
  assert.equal(jiraModule.attentionPreview(null), '');
});

test('줄 차례는 나를 부른 것이 먼저, 그 안에서는 마지막 댓글이 최신인 것부터다', () => {
  const rows = [
    { mention: false, at: '2026-09-22T09:00:00.000Z', key: 'A-1' },
    { mention: true, at: '2026-09-20T09:00:00.000Z', key: 'A-2' },
    { mention: false, at: '2026-09-22T11:00:00.000Z', key: 'A-3' },
    { mention: true, at: '2026-09-21T09:00:00.000Z', key: 'A-4' },
  ].sort(jiraModule.attentionOrder);
  assert.deepEqual(rows.map(row => row.key), ['A-4', 'A-2', 'A-3', 'A-1']);
});

test('반응 필요 조회는 이슈 50개·칸 셋만 묻고, 댓글이 잘린 이슈만 한 번 더 읽는다', async () => {
  const cut = attentionIssue('IO-48395', [theySaid('20002', '2026-09-22T03:00:00.000+0000', '테스터A')], { total: 30 });
  const fake = jiraFake({
    '/rest/api/3/myself': () => json({ accountId: ATTENTION_ME, emailAddress: JIRA_EMAIL, displayName: '나' }),
    '/rest/api/3/search/jql': () => json({ issues: [
      attentionIssue('IO-48394', [mineSaid('10001', '2026-09-20T01:00:00.000+0000'), theySaid('10002', '2026-09-21T02:00:00.000+0000', '테스터A')]),
      cut,
      attentionIssue('IO-48396', [theySaid('30002', '2026-09-20T02:00:00.000+0000', '테스터B'), mineSaid('30003', '2026-09-21T02:00:00.000+0000')]),
      { key: '수상한키', fields: {} },
    ] }),
    '/rest/api/3/issue/IO-48395/comment': () => json({ comments: [
      theySaid('20003', '2026-09-22T05:00:00.000+0000', '테스터B'),
      theySaid('20002', '2026-09-22T03:00:00.000+0000', '테스터A'),
    ] }),
  });
  const items = await jiraListClient(fake).listAttention(ATTENTION_ME);
  assert.deepEqual(items.map(item => item.id), ['jira:IO-48395:20003', 'jira:IO-48394:10002'],
    '내가 마지막으로 답한 이슈와 형식이 틀린 키는 빠진다');
  assert.equal(items[0].count, 2, '다시 읽어 온 댓글로 판정한다');
  // 요청은 둘뿐이다: 목록 하나 + 잘린 이슈 하나(다른 이슈는 다시 읽지 않는다).
  assert.equal(fake.calls.length, 2);
  const [list, comment] = fake.calls;
  assert.equal(decodeURIComponent(list.url.split('jql=')[1].split('&')[0]), jiraModule.ATTENTION_JQL);
  assert.match(list.url, /fields=summary,status,comment&maxResults=50$/);
  assert.match(comment.url, /\/rest\/api\/3\/issue\/IO-48395\/comment\?orderBy=-created&maxResults=20$/);
  // 담당자 칸은 애초에 달라고 하지 않는다(JQL의 `assignee = currentUser()`는 조건이지 받아 오는 칸이 아니다).
  assert.doesNotMatch(fake.calls.map(call => call.url).join(' '), /emailAddress|accountId|fields=[^&]*assignee/);

  // 다시 읽기가 실패해도 목록 전체를 오류로 만들지 않는다 — 받아 온 댓글로만 판단한다.
  const broken = jiraFake({
    '/rest/api/3/search/jql': () => json({ issues: [cut] }),
    '/rest/api/3/issue/IO-48395/comment': () => json({}, 500),
  });
  assert.deepEqual((await jiraListClient(broken).listAttention(ATTENTION_ME)).map(item => item.count), [1]);
});

test('반응 필요 API는 내 계정 id를 한 번만 묻고 응답 어디에도 싣지 않는다', async () => {
  const routes = {
    '/rest/api/3/myself': () => json({ accountId: ATTENTION_ME, emailAddress: JIRA_EMAIL, displayName: '나' }),
    '/rest/api/3/search': () => json({ issues: [attentionIssue('IO-48394', [theySaid('10002', '2026-09-22T03:00:00.000+0000', '테스터A')])] }),
  };
  const fake = jiraFake(routes);
  const api = jiraModule.createJiraApi({ config: jiraConfig, request: fake.request, readFile: () => JIRA_TOKEN });
  const answer = await api.attention();
  assert.equal(answer.connected, true);
  assert.deepEqual(answer.items.map(item => [item.key, item.who]), [['IO-48394', '테스터A']]);
  await api.attention();
  assert.equal(fake.calls.filter(call => call.url.includes('/myself')).length, 1, '누가 나인지는 프로세스마다 한 번만 묻는다');
  const payload = JSON.stringify(answer);
  assert.doesNotMatch(payload, /accountId|emailAddress|fixture-me-account|fixture-other-account/);
  assert.doesNotMatch(payload, new RegExp(`${JIRA_TOKEN}|${JIRA_EMAIL}`));
  assert.doesNotMatch(payload, /@/, '이메일이 섞일 자리가 없다(부름 표시가 없는 댓글이라 @도 없다)');

  // 설정·토큰이 없으면 지라를 부르지 않는다.
  const off = jiraModule.createJiraApi({ config: {}, request: jiraFake(routes).request });
  assert.deepEqual(await off.attention(), { ok: true, connected: false });
  const noToken = jiraModule.createJiraApi({ config: jiraConfig, request: fake.request, readFile: () => '' });
  assert.deepEqual(await noToken.attention(), { ok: true, connected: false });

  // 토큰이 만료되면 해요체 문구로만 알리고, 다음번에는 누가 나인지 다시 묻는다.
  let denied = true;
  const flaky = jiraFake({
    '/rest/api/3/myself': () => (denied ? json({}, 401) : json({ accountId: ATTENTION_ME })),
    '/rest/api/3/search': () => json({ issues: [] }),
  });
  const retried = jiraModule.createJiraApi({ config: jiraConfig, request: flaky.request, readFile: () => JIRA_TOKEN });
  assert.deepEqual(await retried.attention(), { ok: false, error: '지라 토큰을 확인해 주세요.', kind: 'auth' });
  denied = false;
  assert.deepEqual((await retried.attention()).items, []);
  assert.equal(flaky.calls.filter(call => call.url.includes('/myself')).length, 2);
});

// 보관함(attention-live)의 시간 규칙 — 가짜 시계와 가짜 목록으로만 확인한다(지라에 닿지 않는다).
const attentionLiveModule = require('./attention-live');
function attentionHarness({ answers = [], connected = true } = {}) {
  let clock = 0;
  const calls = [];
  let pending = null;
  const load = () => {
    calls.push(clock);
    const answer = answers.length ? answers.shift() : { ok: true, connected: true, items: [{ id: 'jira:IO-1:1' }] };
    if (answer === 'hang') return new Promise((resolve) => { pending = resolve; });
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(answer);
  };
  const live = attentionLiveModule.createAttentionLive({ load, connected: () => connected, now: () => clock });
  return { live, calls, tick: (ms) => { clock += ms; }, release: (value) => { const resolve = pending; pending = null; resolve(value); } };
}

test('반응 필요 보관함은 실패하면 30분까지 이전 값을 `기준`으로 쓰고, 그보다 묵으면 빈 목록 + 문구다', async () => {
  const held = attentionHarness({ answers: [
    { ok: true, connected: true, items: [{ id: 'jira:IO-1:1' }] },
    { ok: false, error: '지라에 연결하지 못했어요.', kind: 'network' },
    new Error('fetch failed'),
  ] });
  await held.live.refresh();
  assert.deepEqual(held.live.view(), { items: [{ id: 'jira:IO-1:1' }], updatedAt: new Date(0).toISOString(), stale: false });

  held.tick(10 * 60 * 1000);
  assert.equal(await held.live.refresh(), false);
  const kept = held.live.view();
  assert.deepEqual(kept.items, [{ id: 'jira:IO-1:1' }], '실패하면 이전 값을 그대로 쓴다');
  assert.equal(kept.stale, true);
  assert.equal(kept.error, undefined);
  assert.equal(await held.live.refresh(), false, '던지는 실패도 조용히 흘린다');

  held.tick(21 * 60 * 1000); // 마지막으로 성공한 지 31분
  assert.deepEqual(held.live.view(), { items: [], updatedAt: null, stale: false, error: '지라 댓글을 읽지 못했어요.' });
});

test('반응 필요 보관함은 동시에 두 번 돌지 않고, 설정이 없으면 타이머도 첫 읽기도 없다', async () => {
  const harness = attentionHarness({ answers: ['hang'] });
  const first = harness.live.refresh();
  assert.equal(harness.live.refresh(), first, '도는 중이면 같은 갱신을 나눠 쓴다');
  assert.equal(harness.calls.length, 1);
  harness.release({ ok: true, connected: true, items: [] });
  await first;

  const off = attentionHarness({ connected: false });
  assert.equal(off.live.start(), false);
  assert.equal(off.calls.length, 0);
  const on = attentionHarness();
  assert.equal(on.live.start(), true);
  assert.equal(on.calls.length, 1, '설정이 있으면 뜰 때 한 번 읽는다');
  assert.equal(on.live.holdsProcess(), false, '타이머는 unref — 이것 때문에 프로세스가 남지 않는다');
  assert.equal(on.live.start(), false, '두 번 켜지지 않는다');
  on.live.stop();
  assert.equal(on.live.started(), false);
  // 설정이 없다는 답은 실패가 아니다 — 오류 문구를 만들지 않는다.
  const none = attentionHarness({ answers: [{ ok: true, connected: false }] });
  await none.live.refresh();
  assert.deepEqual(none.live.view(), { items: [], updatedAt: null, stale: false });

  // 값이 없는 동안 조회가 스스로 읽는 것은 1분에 한 번까지다(지라가 죽어 있어도 화면을 열 때마다 묻지 않게).
  const down = attentionHarness({ answers: [new Error('down'), new Error('down'), new Error('down')] });
  assert.equal(down.live.needsRead(), true, '아직 한 번도 못 읽었으면 읽는다');
  await down.live.refresh();
  assert.equal(down.live.needsRead(), false, '방금 읽어 봤으면 다시 묻지 않는다');
  down.tick(61 * 1000);
  assert.equal(down.live.needsRead(), true);
  await down.live.refresh();
  assert.equal(down.calls.length, 2);
});

// 가짜 지라를 끼운 서버 하나. 반응 필요만 보려고 이슈 셋을 둔다:
// ① 나를 부른 댓글 · ② 작성자가 둘인 댓글 · ③ 내가 마지막으로 답한 이슈(줄이 없어야 한다).
const ATTENTION_SITE = 'https://attention-jira.test';
async function startAttentionServer(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-attention-'));
  fs.writeFileSync(path.join(home, 'tasks.md'), '# Tasks\n- 댓글 확인하기 #task[id:at01 status:to-do created:2026-09-20]\n');
  const tokenFile = path.join(home, '.jira_token_fixture');
  fs.writeFileSync(tokenFile, 'fixture-token-never-real\n');
  const config = path.join(home, 'workspace.config.json');
  fs.writeFileSync(config, JSON.stringify({ jira: { siteUrl: ATTENTION_SITE, email: 'fixture@example.test', tokenFile } }));
  const wrapper = path.join(home, 'fake-attention-server.js');
  fs.writeFileSync(wrapper, `'use strict';
const SITE = ${JSON.stringify(ATTENTION_SITE)};
const ME = ${JSON.stringify(ATTENTION_ME)};
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input && input.url ? input.url : input);
  if (!url.startsWith(SITE)) return realFetch(input, init);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (url.includes('/rest/api/3/myself')) return json({ accountId: ME, emailAddress: 'fixture@example.test', displayName: '나' });
  const say = (line, mention) => ({ type: 'doc', content: [{ type: 'paragraph', content: [
    ...(mention ? [{ type: 'mention', attrs: { id: ME, text: '@나' } }, { type: 'text', text: ' ' }] : []),
    { type: 'text', text: line },
  ] }] });
  const comment = (id, who, at, line, mention) => ({
    id, created: at, body: say(line, mention),
    author: { accountId: who === '나' ? ME : 'other-' + who, displayName: who, emailAddress: 'someone@example.test' },
  });
  const issue = (key, comments) => ({ key, fields: {
    summary: key + '의 요약',
    status: { name: '배포 대기', statusCategory: { key: 'indeterminate' } },
    comment: { comments, total: comments.length },
  } });
  return json({ issues: [
    issue('IO-48394', [comment('10001', '테스터A', '2026-09-22T05:31:00.000+0000', '해외 서버에서는 안 뜨나요?', true)]),
    issue('IO-48395', [
      comment('20001', '나', '2026-09-21T01:00:00.000+0000', '제가 볼게요', false),
      comment('20002', '테스터B', '2026-09-21T02:00:00.000+0000', '문구만 확인 부탁해요', false),
      comment('20003', '테스터C', '2026-09-21T03:00:00.000+0000', '저도 같은 생각이에요', false),
    ]),
    issue('IO-48396', [
      comment('30001', '테스터A', '2026-09-20T01:00:00.000+0000', '이건 어떻게 할까요', false),
      comment('30002', '나', '2026-09-20T02:00:00.000+0000', '제가 처리했어요', false),
    ]),
  ] });
};
const { server } = require(${JSON.stringify(path.join(__dirname, 'server.js'))});
server.listen(Number(process.env.WORKSPACE_PORT), '127.0.0.1', () => console.log('ready'));
`);
  const port = await freePort();
  const child = spawn(process.execPath, [wrapper], {
    env: { ...process.env, WORKSPACE_DATA_DIR: home, WORKSPACE_PORT: String(port), WORKSPACE_NO_OPEN: '1', WORKSPACE_HOST: '', WORKSPACE_CONFIG: config },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(home, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`서버가 종료되었습니다 (${child.exitCode}): ${log}`);
    try { if ((await fetch(origin + '/api/storage-status')).ok) return { home, origin }; } catch { /* 아직 안 떴다 */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`서버가 응답하지 않았습니다: ${log}`);
}

test('GET /api/attention은 나를 부른 줄을 맨 위에 두고, 조회는 어떤 파일도 만들지 않는다', async (t) => {
  const server = await startAttentionServer(t);
  const snapshot = () => fs.readdirSync(server.home).sort().map((name) => {
    const stat = fs.statSync(path.join(server.home, name));
    return `${name}:${stat.size}:${stat.mtimeMs}`;
  }).join('|');
  const before = snapshot();
  const read = async (query = '') => (await (await fetch(`${server.origin}/api/attention${query}`)).json());
  const first = await read();
  assert.equal(first.ok, true);
  assert.equal(first.connected, true);
  assert.deepEqual(first.items.map(item => [item.key, item.mention, item.count, item.who, item.others]), [
    ['IO-48394', true, 1, '테스터A', 0],
    ['IO-48395', false, 2, '테스터C', 1],
  ], '내가 마지막으로 답한 이슈는 줄이 없다');
  assert.equal(first.items[0].preview, '@나 해외 서버에서는 안 뜨나요?');
  assert.deepEqual([first.items[0].status, first.items[0].statusTone], ['배포 대기', 'doing']);
  assert.equal(first.items[0].url, `${ATTENTION_SITE}/browse/IO-48394`);
  assert.match(first.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(first.stale, false);
  assert.equal(first.error, undefined);
  // 토큰·이메일·계정 id는 어디에도 실리지 않는다(부름 표시의 `@나`만 남는다).
  const payload = JSON.stringify(first);
  assert.doesNotMatch(payload, /accountId|emailAddress|fixture-token-never-real|fixture@example\.test|someone@example\.test|other-테스터/);
  assert.doesNotMatch(payload, /@(?!나)/);
  assert.equal((await read('?fresh=1')).items.length, 2);
  assert.equal(snapshot(), before, '조회도 갱신도 파일을 만들지 않는다');
  assert.equal(fs.existsSync(path.join(server.home, '.workflow.json')), false);

  // `했어요` — 그 줄이 빠지고, 저장은 `.workflow.json` 한 칸뿐이다.
  const send = async (route, id) => {
    const response = await fetch(`${server.origin}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
    return { status: response.status, ...await response.json() };
  };
  const done = await send('/api/attention/dismiss', 'jira:IO-48394:10001');
  assert.deepEqual([done.status, done.ok, done.id], [200, true, 'jira:IO-48394:10001']);
  const saved = JSON.parse(fs.readFileSync(path.join(server.home, '.workflow.json'), 'utf8'));
  assert.match(saved.attention.dismissed['jira:IO-48394:10001'], /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual((await read()).items.map(item => item.key), ['IO-48395'], '치운 줄은 빠진 채로 온다');
  // `되돌리기` — 다시 나타난다.
  assert.equal((await send('/api/attention/undismiss', 'jira:IO-48394:10001')).ok, true);
  assert.deepEqual((await read()).items.map(item => item.key), ['IO-48394', 'IO-48395']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(server.home, '.workflow.json'), 'utf8')).attention, { dismissed: {} });
});

test('GET /api/attention은 지라 설정이 없으면 연결 안 됨으로만 답한다', async () => {
  const before = fs.readdirSync(directory).sort().join('|');
  const response = await fetch(`${base}/api/attention`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, connected: false, items: [] });
  assert.equal(fs.readdirSync(directory).sort().join('|'), before);
  // 인증 예외가 아니다 — 원격에서 토큰 없이 부르면 다른 주소와 똑같이 막힌다(여기서는 로컬이라 열린다).
  assert.equal((await fetch(`${base}/api/attention?fresh=1`)).status, 200);
});

test('반응 필요 치우기는 id 형식을 검증하고 같은 요청을 두 번 쓰지 않는다', async () => {
  assert.equal((await post('/api/attention/dismiss', { id: 'jira:IO-48394' })).status, 400);
  assert.equal((await post('/api/attention/dismiss', { id: 'JIRA:IO-48394:10001' })).status, 400);
  assert.equal((await post('/api/attention/dismiss', { id: 'jira:io-48394:10001' })).status, 400);
  assert.equal((await post('/api/attention/dismiss', {})).status, 400);
  assert.equal((await post('/api/attention/undismiss', { id: '../../etc/passwd' })).status, 400);
  const workflowPath = path.join(directory, '.workflow.json');
  assert.equal(JSON.parse(fs.readFileSync(workflowPath, 'utf8')).attention, undefined, '거절한 요청은 파일을 고치지 않는다');

  const call = () => fetch(`${base}/api/attention/dismiss`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'attention-request-0001' },
    body: JSON.stringify({ id: 'jira:IO-48394:10001' }),
  }).then(r => r.json());
  const a = await call();
  const b = await call();
  assert.deepEqual(a, b);
  assert.equal(a.id, 'jira:IO-48394:10001');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(workflowPath, 'utf8')).attention.dismissed), ['jira:IO-48394:10001']);
});

test('저장이 멈춘 동안에는 반응 필요도 치우지 못한다', async (t) => {
  const server = await startServer(t, (home) => {
    fs.writeFileSync(path.join(home, 'tasks.md'), '# Tasks\n- 바깥에서 고친 줄 #task[id:outside status:to-do created:2026-09-20]\n');
    fs.writeFileSync(path.join(home, '.mutation-journal.json'), journalEntry(path.join(home, 'tasks.md'), '# Tasks\n', '# Tasks\n- 중단된 저장\n'));
    fs.writeFileSync(path.join(home, '.mutation.lock'), String(deadPid()));
  });
  const response = await fetch(`${server.base}/api/attention/dismiss`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'jira:IO-48394:10001' }),
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'RECOVERY_NEEDED');
  // 조회는 그대로 된다(지라 설정이 없으니 연결 안 됨으로 답한다).
  assert.equal((await fetch(`${server.base}/api/attention`)).status, 200);
  assert.equal(fs.existsSync(path.join(server.home, '.workflow.json')), false);
});

test('치운 목록은 200개·30일로 정리하되 지금 화면에 있는 줄은 지킨다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-attention-store-'));
  const store = require('./workflow-store')({
    directory: home, refs: () => ({}), calendar: () => ({ events: [] }),
    today: () => today, validateDate: () => {}, create: {}, remove: () => {}, move: () => {},
  });
  const ago = days => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const seeded = { 'jira:OLD-1:1': ago(40), 'jira:OLD-2:2': ago(31) };
  // 200개를 넘기려고 오래되지 않은 줄을 잔뜩 넣어 둔다(오래된 것부터 버려야 한다).
  for (let index = 0; index < 205; index += 1) seeded[`jira:FILL-${index}:${index + 1}`] = new Date(Date.now() - (205 - index) * 60000).toISOString();
  fs.writeFileSync(path.join(home, '.workflow.json'), JSON.stringify({ items: {}, meetings: {}, attention: { dismissed: seeded } }));

  // 30일이 지난 `OLD-2`는 버리고, 지금 화면에 있는 `OLD-1`은 오래됐어도 지킨다(버리면 곧바로 다시 올라온다).
  store.dismissAttention({ id: 'jira:NEW-1:9' }, new Set(['jira:OLD-1:1', 'jira:NEW-1:9']));
  const table = store.attentionDismissed();
  assert.equal(table['jira:OLD-2:2'], undefined, '30일이 지난 줄은 버린다');
  assert.ok(table['jira:OLD-1:1'], '지금 목록에 있는 줄은 오래됐어도 지킨다');
  assert.ok(table['jira:NEW-1:9']);
  assert.equal(Object.keys(table).length, 200, '200개를 넘으면 오래된 것부터 버린다');
  assert.equal(table['jira:FILL-0:1'], undefined, '가장 오래된 것부터 빠진다');
  assert.ok(table['jira:FILL-204:205']);

  store.undismissAttention({ id: 'jira:NEW-1:9' });
  assert.equal(store.attentionDismissed()['jira:NEW-1:9'], undefined);
  assert.throws(() => store.dismissAttention({ id: 'nope' }), /보낸 값을 확인해 주세요/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('추가 조회(key in)만 400이면 추가분만 빠지고 내 담당 목록은 새로 받는다', async () => {
  const fake = jiraFake({
    '/rest/api/3/search/jql': (url) => {
      const jql = decodeURIComponent(String(url).split('jql=')[1].split('&')[0]);
      if (jql.startsWith('key in')) return json({ errorMessages: ["An issue with key 'IO-99999' does not exist for field 'key'."] }, 400);
      return json(jiraListBody([jiraListIssue('IO-48394')]));
    },
  });
  const issues = await jiraListClient(fake).listMyIssues(['IO-48394', 'IO-99999']);
  assert.deepEqual(issues.map(issue => [issue.key, issue.extra]), [['IO-48394', false]]);
  assert.equal(fake.calls.length, 2, '기본 목록 한 번 + 추가 조회 한 번(다시 묻지 않는다)');
});

test('내 담당 목록 조회가 401이면 예전처럼 실패하고, 추가 조회가 403이어도 실패한다', async () => {
  const mineDenied = jiraFake({ '/rest/api/3/search/jql': () => json({}, 401) });
  await assert.rejects(() => jiraListClient(mineDenied).listMyIssues(['IO-1']), error => error.status === 401);
  assert.equal(mineDenied.calls.length, 1);

  const mineBad = jiraFake({ '/rest/api/3/search/jql': () => json({}, 400) });
  await assert.rejects(() => jiraListClient(mineBad).listMyIssues(), error => error.status === 400, '내 담당 목록 자체의 400은 그대로 실패');

  const extraDenied = jiraFake({
    '/rest/api/3/search/jql': (url) => String(url).includes('key%20in') ? json({}, 403) : json(jiraListBody([jiraListIssue('IO-48394')])),
  });
  await assert.rejects(() => jiraListClient(extraDenied).listMyIssues(['IO-1']), error => error.status === 403);
});

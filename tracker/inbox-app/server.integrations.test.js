// 서버: 연동(미팅 노트·자동화 상태·연동 저장·슬랙 토큰/채널). 공용 준비는 test-support.js.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const support = require('./test-support');
const { directory, automationHome, today, shifted, post, items, freePort, serverReady, jiraModule, json, jiraFake, startAppServer, integrationsStore, integrationsFixture } = support;
let base;
before(async () => { base = await support.ready(); });

// ---------- 미팅 노트 가져오기 ----------
// 앱 서버는 아무것도 실행하지 않는다: 요청 표시 파일 하나를 쓰고, 진행 상태는 실행기(run-task.sh)가
// 남긴 로그로만 읽는다. 여기서는 그 로그를 손으로 써 넣어 판정만 확인한다(티로·캘린더·claude는 부르지 않는다).
const notesRequestFile = path.join(automationHome, 'requests', 'tiro-sync.request');
const notesLogFile = path.join(automationHome, 'logs', 'tiro-sync.log');
const logTime = (msAgo = 0) => {
  const at = new Date(Date.now() - msAgo);
  const pad = value => String(value).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
};
const notesBlock = (startAgo, endAgo, exitCode, body = []) => [
  `───── ${logTime(startAgo)} tiro-sync 시작`,
  ...body,
  ...(endAgo === null ? [] : [`───── ${logTime(endAgo)} tiro-sync 종료 (exit ${exitCode})`]),
];
const writeNotesLog = (...lines) => {
  fs.mkdirSync(path.dirname(notesLogFile), { recursive: true });
  fs.writeFileSync(notesLogFile, lines.length ? `${lines.join('\n')}\n` : '');
};
const writeNotesRequest = (msAgo, extra = {}) => {
  fs.mkdirSync(path.dirname(notesRequestFile), { recursive: true });
  fs.writeFileSync(notesRequestFile, `${JSON.stringify({ requestedAt: new Date(Date.now() - msAgo).toISOString(), scope: 'today', ...extra })}\n`);
};
const clearNotes = () => { fs.rmSync(notesRequestFile, { force: true }); fs.rmSync(notesLogFile, { force: true }); };
const notesStatus = async () => (await fetch(base + '/api/meeting-notes/status')).json();

test('미팅 노트 요청은 프로세스를 띄우지 않고 요청 표시 파일(JSON) 하나만 남긴다', async () => {
  clearNotes();
  const before = fs.readdirSync(directory).sort();
  const asked = await post('/api/meeting-notes/request', { scope: 'today' });
  assert.equal(asked.ok, true);
  assert.equal(asked.state, 'requested');
  const written = JSON.parse(fs.readFileSync(notesRequestFile, 'utf8'));
  assert.deepEqual(Object.keys(written).sort(), ['requestedAt', 'scope']);
  assert.equal(written.scope, 'today');
  assert.match(written.requestedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  // 업무 데이터(tracker/)는 손대지 않는다
  assert.deepEqual(fs.readdirSync(directory).sort(), before);

  // 조회는 파일을 쓰지 않는다(요청 표시 파일도 그대로다)
  const stamp = fs.statSync(notesRequestFile).mtimeMs;
  const status = await notesStatus();
  assert.equal(status.state, 'requested');
  assert.equal(status.scope, 'today');
  assert.equal(fs.statSync(notesRequestFile).mtimeMs, stamp);
  assert.equal(fs.existsSync(notesLogFile), false);
  clearNotes();
});

test('미팅 노트 상태는 요청 시각 뒤의 로그로 다섯 갈래를 가른다', async () => {
  // 1) 아직 시작 줄이 없다 — 방금 요청했으면 `requested`
  writeNotesRequest(5 * 1000);
  writeNotesLog(...notesBlock(2 * 60 * 60 * 1000, 2 * 60 * 60 * 1000 - 1000, 0, ['지난 실행 결과']));
  let status = await notesStatus();
  assert.equal(status.state, 'requested', '요청 전의 옛 실행 기록은 이번 판정에 끼지 않는다');

  // 2) 60초가 넘도록 시작 줄이 없다 — 자동 실행이 등록되지 않은 것으로 본다
  writeNotesRequest(90 * 1000);
  status = await notesStatus();
  assert.equal(status.state, 'failed');
  assert.match(status.summary, /setup\.sh를 다시 실행/);

  // 3) 시작만 있고 끝이 없다 — `running`
  writeNotesRequest(5 * 60 * 1000);
  writeNotesLog(...notesBlock(4 * 60 * 1000, null, null, ['노트를 읽는 중']));
  status = await notesStatus();
  assert.equal(status.state, 'running');
  assert.ok(status.startedAt);

  // 4) 35분이 넘도록 끝나지 않았다 — 실패로 본다
  writeNotesRequest(40 * 60 * 1000);
  writeNotesLog(...notesBlock(39 * 60 * 1000, null, null, []));
  assert.equal((await notesStatus()).state, 'failed');

  // 5) 종료 (exit 0) — `done` + 그 블록의 글이 요약
  writeNotesRequest(10 * 60 * 1000);
  writeNotesLog(...notesBlock(9 * 60 * 1000, 8 * 60 * 1000, 0, ['노트 2개, 초안 5개']));
  status = await notesStatus();
  assert.equal(status.state, 'done');
  assert.match(status.summary, /노트 2개, 초안 5개/);
  assert.equal(status.lastKind, 'run');

  // 6) 0이 아닌 종료 코드 — 실패
  writeNotesRequest(10 * 60 * 1000);
  writeNotesLog(...notesBlock(9 * 60 * 1000, 8 * 60 * 1000, 1, ['티로 연결 실패']));
  status = await notesStatus();
  assert.equal(status.state, 'failed');
  assert.match(status.summary, /티로 연결 실패/);
  clearNotes();
});

test('가져오는 중에는 새 요청을 409로 막는다', async () => {
  writeNotesRequest(3 * 60 * 1000);
  writeNotesLog(...notesBlock(2 * 60 * 1000, null, null, []));
  const stamp = fs.statSync(notesRequestFile).mtimeMs;
  const refused = await post('/api/meeting-notes/request', { scope: 'today' });
  assert.equal(refused.status, 409);
  assert.match(refused.error, /지금 가져오는 중이에요/);
  assert.equal(fs.statSync(notesRequestFile).mtimeMs, stamp, '거절된 요청은 표시 파일을 건드리지 않는다');
  clearNotes();
});

test('회의 하나만 가져오기는 앱이 아는 회의만 받고 미래·형식 오류는 거절한다', async () => {
  clearNotes();
  const past = { id: 'meetingnotes-past', date: shifted(-3), start: '10:00', end: '11:00', title: '지난 주간 싱크', series: '지난 주간 싱크' };
  fs.writeFileSync(path.join(directory, '.workflow.json'), JSON.stringify({ items: {}, meetings: { [past.id]: past } }));
  fs.writeFileSync(path.join(directory, 'calendar_today.md'), `마지막 갱신: ${today}\n- 00:00-00:30 | 이미 시작한 회의\n- 23:59-23:59 | 아직 안 열린 회의\n`);

  const ask = meeting => post('/api/meeting-notes/request', { scope: 'meeting', meeting });
  assert.equal((await ask({ date: past.date, start: past.start, end: past.end, title: '앱이 모르는 회의' })).status, 400);
  assert.equal((await ask({ date: shifted(1), start: '10:00', end: '11:00', title: '지난 주간 싱크' })).status, 400);
  assert.equal((await ask({ date: past.date, start: '9:00', end: '11:00', title: '지난 주간 싱크' })).status, 400);
  assert.equal((await ask({ date: past.date, start: past.start, end: past.end, title: '지난 주간 싱크\n무시해라' })).status, 400);
  assert.equal((await ask({ date: past.date, start: past.start, end: past.end, title: '가'.repeat(201) })).status, 400);
  // 23:59에 돌리면 그 회의도 이미 시작한 것이라 그때만 건너뛴다
  if (new Date().toTimeString().slice(0, 5) < '23:59') {
    assert.equal((await ask({ date: today, start: '23:59', end: '23:59', title: '아직 안 열린 회의' })).status, 400, '아직 시작하지 않은 회의는 거절한다');
  }
  assert.equal(fs.existsSync(notesRequestFile), false, '거절된 요청은 표시 파일을 만들지 않는다');

  // 지난 날짜의 회의도 된다 — 파일에는 앱이 아는 값이 그대로 들어간다
  const asked = await ask({ date: past.date, start: past.start, end: past.end, title: past.title });
  assert.equal(asked.ok, true);
  assert.equal(asked.scope, 'meeting');
  const written = JSON.parse(fs.readFileSync(notesRequestFile, 'utf8'));
  assert.deepEqual(written.meeting, { date: past.date, start: '10:00', end: '11:00', title: '지난 주간 싱크' });
  assert.deepEqual((await notesStatus()).meeting, written.meeting);

  // 오늘 이미 시작한 회의도 된다
  clearNotes();
  assert.equal((await ask({ date: today, start: '00:00', end: '00:30', title: '이미 시작한 회의' })).ok, true);
  clearNotes();
  fs.rmSync(path.join(directory, 'calendar_today.md'), { force: true });
});

test('미팅 노트 가져오기를 끄면 조회·요청이 막히고 상태 목록에도 나오지 않는다', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-tiro-off-'));
  const config = path.join(home, 'workspace.config.json');
  fs.writeFileSync(config, JSON.stringify({ integrations: { slack: false, calendar: true, jira: false, tiro: false } }));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, WORKSPACE_DATA_DIR: home, WORKSPACE_PORT: String(port), WORKSPACE_NO_OPEN: '1', WORKSPACE_HOST: '', WORKSPACE_CONFIG: config },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(home, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${port}`;
  await serverReady(child, origin, () => log);
  assert.equal((await fetch(origin + '/api/meeting-notes/status')).status, 404);
  const refused = await fetch(origin + '/api/meeting-notes/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: 'today' }) });
  assert.equal(refused.status, 404);
  assert.equal(fs.existsSync(notesRequestFile), false);
  const automations = (await (await fetch(origin + '/api/automation/status')).json()).automations;
  assert.equal(automations.some(entry => entry.key === 'tiro'), false);
  // 지라도 꺼 둔 설정이다 — 직접 읽기·바꾸기 주소가 아예 열리지 않고, 화면도 `used:false`로 구역을 그리지 않는다.
  assert.equal((await fetch(origin + '/api/jira/issue?key=ABC-1234')).status, 404);
  assert.equal((await fetch(origin + '/api/jira/options?key=ABC-1234')).status, 404);
  assert.equal((await fetch(origin + '/api/jira/change', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'ABC-1234', kind: 'status', transitionId: '21' }),
  })).status, 404);
  assert.deepEqual((await (await fetch(origin + '/api/items')).json()).jiraSync, { used: false });
  assert.deepEqual((await (await fetch(origin + '/api/items')).json()).meetingNotes, { used: false, state: 'off' });
});

// jira-sync 자동화(지라 담당 이슈 캐시 갱신)는 없앴다 — 앱이 지라를 직접 읽는다(DECISIONS 2026-09-24).
// 지라를 켜 둔 설정이어도(이 테스트가 쓰는 기본 서버는 설정 파일이 없어 켜진 것으로 본다) 상태 목록에는
// 다시는 나오지 않는다. 화면은 jiraSync(/api/items)로 직접 읽기 상태를 따로 그린다.
test('설정 > 상태의 자동화 목록에는 지라를 켜도 지라 동기화가 없다', async () => {
  const automations = (await (await fetch(base + '/api/automation/status')).json()).automations;
  assert.equal(automations.some(entry => entry.key === 'jira'), false, '지라 자동화는 목록에서 없앴다');
  assert.notDeepEqual((await items()).jiraSync, { used: false }, '이 서버는 지라를 켜 둔 것이다(대조군)');
});

test('연동: 문제 보고에 실을 오류 줄만 고르고 이메일·지라 키·주소의 조회 조건을 가린다', () => {
  const log = [
    '2026-09-23 09:00:00 잘 돌았어요 — 회의에서 나온 업무 3건 등록',
    '2026-09-23 09:01:00 Error: connect ECONNREFUSED https://회사.atlassian.net/rest/api/3/search?jql=assignee=me',
    '    at Object.<anonymous> (/Users/someone/app/server.js:1:1)',
    '2026-09-23 09:02:00 지라 동기화 실패 — 나@회사.com 계정으로 ABC-1234를 읽지 못했어요',
    `2026-09-23 09:03:00 에러: ${'가'.repeat(400)}`,
  ].join('\n');
  const lines = integrationsStore.errorLines(log);
  assert.equal(lines.length, 4, '오류 줄과 스택만 남는다(정상 보고문은 빠진다)');
  assert.ok(!lines.join('\n').includes('회의에서 나온 업무'), '업무 문장은 실리지 않는다');
  assert.ok(!lines.join('\n').includes('나@회사.com'), '이메일은 가린다');
  assert.ok(!lines.join('\n').includes('ABC-1234'), '지라 키는 가린다');
  assert.ok(!lines.join('\n').includes('jql='), '주소의 조회 조건은 가린다');
  assert.ok(lines.every(line => line.length <= 200), '줄마다 200자에서 자른다');
  assert.deepEqual(integrationsStore.errorLines(''), []);
});

test('연동: 채널 링크·ID에서 채널만 뽑고, 아니면 null이다', () => {
  const id = integrationsStore.parseChannelId;
  assert.equal(id('https://회사.slack.com/archives/C0123ABCD'), 'C0123ABCD');
  assert.equal(id('https://회사.slack.com/archives/C0123ABCD/p1700000000000'), 'C0123ABCD');
  assert.equal(id(' C0123ABCD '), 'C0123ABCD');
  assert.equal(id('#my-todo'), null);
  assert.equal(id(''), null);
});

test('연동: 켜짐/꺼짐은 서버(USES)와 같은 뜻 — 칸이 없으면 켜진 것이고, 회의록은 tiro 칸을 따라간다', () => {
  const read = (config) => integrationsStore.readIntegrations(config, { tokenDir: fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-int-')) });
  // 옛 설정: integrations에 tiro 칸이 없고 meetingNotes도 없다 — 서버는 tiro를 켜진 것으로 돌리고 있었다.
  const legacy = read({ integrations: { slack: true, calendar: true, jira: true } });
  assert.equal(legacy.meetingNotes.mode, 'tiro', '칸이 없으면 켜진 것 — 화면이 "직접"으로 잘못 보여 주면 누르는 순간 실제로 꺼진다');
  assert.equal(legacy.jira.enabled, true);
  // 아무 칸도 없는 설정(예: 빈 파일)도 서버와 같이 전부 켜진 것으로 읽는다.
  const empty = read({});
  assert.deepEqual([empty.jira.enabled, empty.slack.enabled, empty.calendar.enabled, empty.meetingNotes.mode], [true, true, true, 'tiro']);
  // 새 설치의 예시 설정은 전부 false — 그때만 꺼짐·직접이다.
  const fresh = read({ integrations: { slack: false, calendar: false, jira: false, tiro: false } });
  assert.deepEqual([fresh.jira.enabled, fresh.slack.enabled, fresh.calendar.enabled, fresh.meetingNotes.mode], [false, false, false, 'manual']);
  // meetingNotes가 적혀 있으면 그 값이 우선이다.
  assert.equal(read({ integrations: { tiro: true }, meetingNotes: 'manual' }).meetingNotes.mode, 'manual');
});

test('연동: 지라 계정 확인은 myself 하나만 부르고 표시 이름만 돌려준다(토큰은 어디에도 안 실린다)', async () => {
  const fake = jiraFake({ '/rest/api/3/myself': () => json({ accountId: 'acc-1', displayName: '하늘' }) });
  const ok = await jiraModule.checkJiraAccount({ siteUrl: 'https://example-jira.test/', email: 'me@example.test', token: 'secret-token', request: fake.request });
  assert.deepEqual(ok, { ok: true, displayName: '하늘' });
  assert.equal(fake.calls.length, 1);
  assert.ok(fake.calls[0].url.endsWith('/rest/api/3/myself'));
  assert.ok(!JSON.stringify(ok).includes('secret-token'));

  const denied = jiraFake({ '/rest/api/3/myself': () => json({}, 401) });
  assert.deepEqual(await jiraModule.checkJiraAccount({ siteUrl: 'https://example-jira.test', email: 'me@example.test', token: 'bad', request: denied.request }), { ok: false, kind: 'auth' });
  // 주소가 https가 아니면 아무 데도 부르지 않는다
  const never = jiraFake({});
  assert.equal((await jiraModule.checkJiraAccount({ siteUrl: 'http://example-jira.test', email: 'me@example.test', token: 't', request: never.request })).ok, false);
  assert.equal(never.calls.length, 0);
});

test('연동: 슬랙 채널 확인은 이름과 비공개 여부만 읽고, 실패는 우리 문구로 바꾼다', async () => {
  const calls = [];
  const okFetch = async (url, options) => { calls.push({ url, options }); return json({ ok: true, channel: { name: 'my-todo', is_private: true, topic: '비밀 이야기' } }); };
  const info = await integrationsStore.slackCheckChannel('slack-secret', 'C0123ABCD', okFetch);
  assert.deepEqual(info, { name: 'my-todo', isPrivate: true, created: null, archived: false }, '주제 같은 다른 값은 싣지 않는다');
  // 만든 때(초)와 보관 여부는 새 채널의 since·뺐던 채널 다시 켜기에 쓴다
  const made = await integrationsStore.slackCheckChannel('t', 'C0123ABCD', async () => json({ ok: true, channel: { name: 'x', created: 1790000000, is_archived: true } }));
  assert.deepEqual(made, { name: 'x', isPrivate: false, created: 1790000000, archived: true });
  assert.match(calls[0].url, /conversations\.info\?channel=C0123ABCD$/);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer slack-secret');

  const bad = async () => json({ ok: false, error: 'channel_not_found' });
  await assert.rejects(() => integrationsStore.slackCheckChannel('t', 'C1', bad), /슬랙에서 이 채널을 읽지 못했어요/);
});

// SLACKEZ: 동료가 슬랙에서 채널을 손수 만들지 않아도 되게, 앱이 대신 만들어 주는 길.
test('SLACKEZ: 채널 만들기는 auth.test로 토큰을 먼저 보고 맞을 때만 만들며, 실패는 우리 문구로 바꾼다', async () => {
  const slackFake = (steps) => {
    const calls = [];
    const request = async (url, options) => {
      calls.push({ url: String(url), options });
      const method = String(url).split('/api/')[1].split('?')[0];
      return json(steps[method] ? steps[method](options, String(url)) : { ok: false, error: 'unknown_method' });
    };
    return { calls, request };
  };

  const ok = slackFake({
    'auth.test': () => ({ ok: true, user: 'me' }),
    'conversations.create': () => ({ ok: true, channel: { id: 'C0NEW111', name: 'my-todo', is_private: true } }),
  });
  const made = await integrationsStore.slackCreateChannel('slack-secret', 'my-todo', ok.request);
  assert.deepEqual(made, { id: 'C0NEW111', name: 'my-todo' });
  assert.deepEqual(ok.calls.map(call => call.url),
    ['https://slack.com/api/auth.test', 'https://slack.com/api/conversations.create'], '토큰부터 확인하고 그다음에 만든다');
  assert.equal(ok.calls[1].options.headers.Authorization, 'Bearer slack-secret', '토큰은 헤더로만 나간다');
  assert.deepEqual(JSON.parse(ok.calls[1].options.body), { name: 'my-todo', is_private: true }, '늘 비공개로 만든다');
  assert.ok(!JSON.stringify(made).includes('slack-secret'), '돌려주는 값에 토큰은 없다');

  // 토큰이 틀리면 채널을 만들지 않는다
  const denied = slackFake({ 'auth.test': () => ({ ok: false, error: 'invalid_auth' }) });
  await assert.rejects(() => integrationsStore.slackCreateChannel('bad', 'my-todo', denied.request), /토큰이 맞지 않아요/);
  assert.deepEqual(denied.calls.map(call => call.url), ['https://slack.com/api/auth.test'], '틀린 토큰으로는 만들기를 부르지 않는다');

  // 슬랙이 거절한 이유마다 사람 말로 바꾼다
  const refuse = error => slackFake({
    'auth.test': () => ({ ok: true }), 'conversations.create': () => ({ ok: false, error }),
    'users.conversations': () => ({ ok: true, channels: [] }),
  });
  await assert.rejects(() => integrationsStore.slackCreateChannel('t', 'my-todo', refuse('missing_scope').request),
    /이 슬랙 앱에는 채널 만들기 권한이 없어요 — 만든 사람에게 권한 추가를 요청해 주세요/);
  await assert.rejects(() => integrationsStore.slackCreateChannel('t', 'my-todo', refuse('name_taken').request),
    /다른 사람이 쓰는 이름이에요 — 다른 이름을 적어 주세요/);
  await assert.rejects(() => integrationsStore.slackCreateChannel('t', 'my-todo', refuse('not_authed').request), /토큰이 맞지 않아요/);
  await assert.rejects(() => integrationsStore.slackCreateChannel('t', 'my-todo', refuse('ratelimited').request), /슬랙에서 채널을 만들지 못했어요/);
  // 슬랙이 ok라 해도 id가 없으면 만들어진 것으로 보지 않는다
  const noId = slackFake({ 'auth.test': () => ({ ok: true }), 'conversations.create': () => ({ ok: true, channel: {} }) });
  await assert.rejects(() => integrationsStore.slackCreateChannel('t', 'my-todo', noId.request), /슬랙에서 채널을 만들지 못했어요/);

  // 이름·토큰 규칙은 슬랙을 부르기 전에 본다
  const never = slackFake({});
  for (const name of ['내 할일', 'my todo!', 'MY#TODO', 'a'.repeat(81), '  ']) {
    await assert.rejects(() => integrationsStore.slackCreateChannel('t', name, never.request), /채널 이름은 소문자·숫자·-·_만 80자까지 쓸 수 있어요/);
  }
  await assert.rejects(() => integrationsStore.slackCreateChannel('', 'my-todo', never.request), /슬랙 토큰을 붙여 넣어 주세요/);
  assert.deepEqual(never.calls, [], '이름이나 토큰이 틀리면 슬랙에 닿지 않는다');
});

test('SLACKEZ: 토큰 받는 곳 주소는 설정의 slack.appUrl이고, 없거나 https가 아니면 슬랙 앱 목록이다', () => {
  const read = config => integrationsStore.readIntegrations(config, { tokenDir: fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-int-')) });
  assert.equal(integrationsStore.SLACK_APPS_URL, 'https://api.slack.com/apps');
  assert.equal(read({ slack: { appUrl: 'https://api.slack.com/apps/A0XXXX' } }).slack.appUrl, 'https://api.slack.com/apps/A0XXXX');
  assert.equal(read({}).slack.appUrl, 'https://api.slack.com/apps', '적어 두지 않았으면 목록 화면으로 보낸다');
  assert.equal(read({ slack: { appUrl: '' } }).slack.appUrl, 'https://api.slack.com/apps');
  assert.equal(read({ slack: { appUrl: 'javascript:alert(1)' } }).slack.appUrl, 'https://api.slack.com/apps', 'https가 아니면 쓰지 않는다');
  assert.equal(read({ slack: { appUrl: 'http://api.slack.com/apps' } }).slack.appUrl, 'https://api.slack.com/apps');
});

test('연동 저장: 아는 키만 바꾸고 모르는 키는 그대로 두며, 토큰은 파일(0600)에만 들어간다', async (t) => {
  const fix = integrationsFixture(t, {
    title: '내가 지은 이름',
    integrations: { slack: false, calendar: false, jira: false, tiro: false },
    server: { port: 4321, extraHost: '', chromeProfile: 'Profile 1' },
    내가적어둔칸: { 아무거나: true },
    jira: { siteUrl: 'https://옛주소.atlassian.net', 메모: '지우면 안 됨' },
  });
  const { result } = await integrationsStore.saveIntegrations({
    configPath: fix.configPath, current: fix.read(), tokenDir: fix.tokenDir,
    body: { jira: { enabled: true, siteUrl: 'https://회사.atlassian.net/', email: '나@회사.com', token: 'jira-secret' } },
    jiraCheck: async () => ({ ok: true, displayName: '하늘' }),
  });

  const saved = fix.read();
  assert.equal(saved.title, '내가 지은 이름', '모르는 키는 그대로 둔다');
  assert.deepEqual(saved.내가적어둔칸, { 아무거나: true });
  assert.equal(saved.server.chromeProfile, 'Profile 1');
  assert.equal(saved.jira.메모, '지우면 안 됨', '같은 묶음 안의 모르는 칸도 지킨다');
  assert.equal(saved.integrations.jira, true);
  assert.equal(saved.integrations.slack, false, '건드리지 않은 연동은 그대로다');
  assert.equal(saved.jira.siteUrl, 'https://회사.atlassian.net', '끝의 빗금은 떼고 적는다');
  assert.equal(saved.jira.email, '나@회사.com');
  assert.match(saved.jira.tokenFile, /workspace-jira-token$/);

  assert.ok(!JSON.stringify(saved).includes('jira-secret'), '토큰은 설정 파일에 절대 적지 않는다');
  assert.ok(!JSON.stringify(result).includes('jira-secret'), '토큰은 응답에도 실리지 않는다');
  assert.deepEqual(result.jira, { displayName: '하늘' });

  const tokenFile = path.join(fix.tokenDir, 'workspace-jira-token');
  assert.equal(fs.readFileSync(tokenFile, 'utf8').trim(), 'jira-secret');
  assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600, '토큰 파일은 나만 읽는다');
});

test('연동 저장: 12시간짜리 토큰(xoxe.xoxp-)을 붙여 넣어도 저장은 되고 응답에 경고 종류만 싣는다 — 보통 토큰에는 없다', async (t) => {
  const save = (token) => {
    const fix = integrationsFixture(t, {});
    return integrationsStore.saveIntegrations({
      configPath: fix.configPath, current: fix.read(), tokenDir: fix.tokenDir,
      body: { slack: { enabled: true, token, channels: { todo: 'C0TODO11' } } },
      slackCheck: async () => ({ name: 'my-todo', isPrivate: true }),
    }).then(saved => ({ saved, fix }));
  };
  const rotating = await save('xoxe.xoxp-1-ROTATING');
  assert.equal(rotating.saved.result.slack.warning, 'rotating_token');
  assert.equal(fs.readFileSync(path.join(rotating.fix.tokenDir, 'workspace-slack-token'), 'utf8'), 'xoxe.xoxp-1-ROTATING\n', '막지 않는다');
  assert.ok(!JSON.stringify(rotating.saved.result).includes('ROTATING'));
  assert.equal((await save('xoxp-plain')).saved.result.slack.warning, undefined);
});

test('연동 저장: 슬랙 채널은 넷 중 하나 이상이면 되고(할 일도 선택), 채널 이름은 슬랙이 준 것으로 적는다', async (t) => {
  const fix = integrationsFixture(t, { slack: { channels: { todo: { id: '옛ID', name: '#옛이름' } } } });
  const asked = [];
  const { result } = await integrationsStore.saveIntegrations({
    configPath: fix.configPath, current: fix.read(), tokenDir: fix.tokenDir,
    body: {
      slack: {
        enabled: true, token: 'slack-secret',
        channels: { todo: 'https://회사.slack.com/archives/C0TODO11', waiting: 'C0WAIT11' },
      },
    },
    slackCheck: async (token, id) => { asked.push([token, id]); return { name: id === 'C0TODO11' ? 'my-todo' : 'my-waiting', isPrivate: id === 'C0TODO11', created: id === 'C0TODO11' ? 1790000000 : null }; },
    now: () => 1790000123456,
  });
  const saved = fix.read();
  assert.deepEqual(asked, [['slack-secret', 'C0TODO11'], ['slack-secret', 'C0WAIT11']]);
  // 새로 연결한 채널은 만든 때부터 읽는다(since, 슬랙 ts 모양) — 슬랙이 만든 때를 안 알려 주면 저장한 때부터.
  assert.deepEqual(saved.slack.channels.todo, { id: 'C0TODO11', name: '#my-todo', since: '1790000000.000000' });
  assert.deepEqual(saved.slack.channels.waiting, { id: 'C0WAIT11', name: '#my-waiting', since: '1790000123.456000' });
  assert.equal(saved.integrations.slack, true);
  assert.equal(result.slack.channels.todo.isPrivate, true);
  assert.equal(result.slack.channels.waiting.isPrivate, false, '공개 채널도 막지는 않고 알려만 준다');
  assert.ok(!JSON.stringify(saved).includes('slack-secret'));
  assert.equal(fs.statSync(path.join(fix.tokenDir, 'workspace-slack-token')).mode & 0o777, 0o600);
});

test('연동 저장: 회의록 세 갈래와 해제는 토큰 파일을 지우지 않는다', async (t) => {
  const fix = integrationsFixture(t, {});
  const save = body => integrationsStore.saveIntegrations({ configPath: fix.configPath, current: fix.read(), tokenDir: fix.tokenDir, body });

  await save({ meetingNotes: { mode: 'tiro' } });
  assert.equal(fix.read().integrations.tiro, true);
  assert.equal(fix.read().meetingNotes, 'tiro');
  await save({ meetingNotes: { mode: 'manual' } });
  assert.equal(fix.read().integrations.tiro, false);
  assert.equal(fix.read().meetingNotes, 'manual');
  await save({ meetingNotes: { mode: 'other', name: '노션' } });
  assert.deepEqual(fix.read().meetingNotes, { other: '노션' });
  await assert.rejects(() => save({ meetingNotes: { mode: 'other', name: '  ' } }), /어떤 앱인지 이름을 적어 주세요/);

  // 해제는 켬 값만 끄고 토큰 파일은 사람 것이라 두고 간다
  fs.mkdirSync(fix.tokenDir, { recursive: true });
  fs.writeFileSync(path.join(fix.tokenDir, 'workspace-jira-token'), 'keep-me\n', { mode: 0o600 });
  await save({ jira: { enabled: false } });
  assert.equal(fix.read().integrations.jira, false);
  assert.equal(fs.readFileSync(path.join(fix.tokenDir, 'workspace-jira-token'), 'utf8').trim(), 'keep-me');
});

test('연동 저장: 값이 틀리거나 확인에 실패하면 설정 파일도 토큰 파일도 건드리지 않는다', async (t) => {
  const fix = integrationsFixture(t, { title: '그대로' });
  const before = fs.readFileSync(fix.configPath, 'utf8');
  const save = body => integrationsStore.saveIntegrations({
    configPath: fix.configPath, current: fix.read(), tokenDir: fix.tokenDir, body,
    jiraCheck: async () => ({ ok: false }),
    slackCheck: async () => { throw Object.assign(new Error('슬랙에서 이 채널을 읽지 못했어요 — 토큰과 채널을 확인해 주세요'), { status: 400 }); },
  });
  await assert.rejects(() => save({ jira: { enabled: true, siteUrl: 'http://회사.atlassian.net', email: 'a@b.c', token: 't' } }), /지라 주소는 https:\/\/로 시작해야 해요/);
  await assert.rejects(() => save({ jira: { enabled: true, siteUrl: 'https://회사.atlassian.net', email: 'a@b.c', token: 't' } }), /이메일이나 토큰이 맞지 않아요/);
  await assert.rejects(() => save({ slack: { enabled: true, token: 't', channels: { todo: '#my-todo' } } }), /슬랙 채널 링크나 ID를 붙여 넣어 주세요/);
  await assert.rejects(() => save({ slack: { enabled: true, token: 't', channels: { todo: 'C0TODO11' } } }), /슬랙에서 이 채널을 읽지 못했어요/);
  assert.equal(fs.readFileSync(fix.configPath, 'utf8'), before, '실패하면 설정은 한 글자도 바뀌지 않는다');
  assert.equal(fs.existsSync(path.join(fix.tokenDir, 'workspace-jira-token')), false, '실패하면 토큰 파일도 만들지 않는다');
});

test('연동 저장(지라): 주소창째 붙인 주소는 origin만 남기고, 스킴이 없으면 https://를 붙이며, http://는 거절한다', async (t) => {
  const fix = integrationsFixture(t, {});
  const asked = [];
  const save = siteUrl => integrationsStore.saveIntegrations({
    configPath: fix.configPath, current: fix.read(), tokenDir: fix.tokenDir,
    body: { jira: { enabled: true, siteUrl, email: 'me@example.test', token: 'fake-jira-token-000' } },
    jiraCheck: async (settings) => { asked.push(settings.siteUrl); return { ok: true, displayName: '가짜' }; },
  });
  await save('https://mycompany.atlassian.net/jira/software/projects/AB/boards/1?selectedIssue=AB-1#x');
  assert.equal(fix.read().jira.siteUrl, 'https://mycompany.atlassian.net', '경로·쿼리·조각은 떼고 적는다');
  await save('mycompany.atlassian.net/browse/AB-1');
  assert.equal(fix.read().jira.siteUrl, 'https://mycompany.atlassian.net', 'https:// 없이 오면 붙여 준다');
  await save('https://jira.example.test:8443/secure/Dashboard.jspa');
  assert.equal(fix.read().jira.siteUrl, 'https://jira.example.test:8443', '커스텀 도메인은 호스트(포트 포함) 그대로');
  await save('https://회사.atlassian.net/');
  assert.equal(fix.read().jira.siteUrl, 'https://회사.atlassian.net', '한글 호스트도 붙인 글자 그대로');
  assert.deepEqual(asked, ['https://mycompany.atlassian.net', 'https://mycompany.atlassian.net', 'https://jira.example.test:8443', 'https://회사.atlassian.net'], '지라에 묻는 주소도 정리한 주소');
  const before = fs.readFileSync(fix.configPath, 'utf8');
  await assert.rejects(() => save('http://mycompany.atlassian.net'), (error) => error.message === '지라 주소는 https://로 시작해야 해요' && error.code === 'jira_site');
  await assert.rejects(() => save('my company'), (error) => /지라 주소를 확인해 주세요/.test(error.message) && error.code === 'jira_site');
  await assert.rejects(() => save(''), (error) => error.code === 'jira_site');
  assert.equal(fs.readFileSync(fix.configPath, 'utf8'), before);
});

test('연동 저장(지라): 실패는 갈래별 문구(이메일 모양 / 이메일이나 토큰 / 연결 안 됨)이고 주소·이메일·토큰은 싣지 않는다', async (t) => {
  const fix = integrationsFixture(t, {});
  const secret = 'fake-jira-token-SECRET-123';
  const email = 'someone@example.test';
  const site = 'https://secret-site.atlassian.net';
  const save = (body, kind) => integrationsStore.saveIntegrations({
    configPath: fix.configPath, current: fix.read(), tokenDir: fix.tokenDir,
    body: { jira: { enabled: true, siteUrl: site, email, token: secret, ...body } },
    jiraCheck: async () => ({ ok: false, kind }),
  });
  const caught = async (promise) => { try { await promise; } catch (error) { return error; } assert.fail('거절돼야 한다'); };
  const cases = [
    [await caught(save({ email: 'someone.example.test' }, 'auth')), 'jira_email', /이메일 모양이 아니에요/],
    [await caught(save({}, 'auth')), 'jira_auth', /^이메일이나 토큰이 맞지 않아요/],
    [await caught(save({}, 'network')), 'jira_unreachable', /^지라에 연결하지 못했어요 — 주소와 인터넷 연결을 확인/],
    [await caught(save({}, 'other')), 'jira_unreachable', /^지라에 연결하지 못했어요/],
    [await caught(save({}, 'notfound')), 'jira_unreachable', /^지라에 연결하지 못했어요/],
    [await caught(save({}, undefined)), 'jira_auth', /^이메일이나 토큰이 맞지 않아요/],
  ];
  for (const [error, code, words] of cases) {
    assert.equal(error.code, code);
    assert.match(error.message, words);
    for (const value of [secret, email, 'someone.example.test', 'secret-site']) assert.ok(!error.message.includes(value), '문구에 주소·이메일·토큰이 없다');
  }
  assert.equal(fs.existsSync(path.join(fix.tokenDir, 'workspace-jira-token')), false, '실패하면 토큰 파일을 만들지 않는다');
});

test('연동 저장: 다시 켜기는 launchd가 띄운 자리에서만 하고, 테스트에서는 끼워 넣은 exit만 불린다', () => {
  const calls = [];
  const timers = [];
  const timer = (fn, delay) => { timers.push([fn, delay]); return { unref() {} }; };
  assert.equal(integrationsStore.scheduleRestart({ managed: false, exit: code => calls.push(code), timer }), false);
  assert.deepEqual(timers, [], '개발용 서버는 끝내지 않는다');

  assert.equal(integrationsStore.scheduleRestart({ managed: true, exit: code => calls.push(code), timer }), true);
  assert.equal(timers.length, 1);
  assert.equal(timers[0][1], 500, '응답이 나간 뒤에 끝낸다');
  timers[0][0]();
  assert.deepEqual(calls, [0], '실제 process.exit은 불리지 않는다');
});

test('연동 라우트: 지금 상태는 토큰 값을 싣지 않고, 저장은 설정 파일 하나만 쓰며 local.css는 없어도 빈 200이다', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-intg-route-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const data = path.join(home, 'tracker');
  fs.mkdirSync(data);
  const config = path.join(home, 'workspace.config.json');
  const tokens = path.join(home, 'tokens');
  fs.mkdirSync(tokens);
  fs.writeFileSync(path.join(tokens, 'workspace-slack-token'), 'slack-secret\n', { mode: 0o600 });
  fs.writeFileSync(config, JSON.stringify({
    title: '내가 지은 이름',
    integrations: { slack: true, calendar: false, jira: false, tiro: false },
    slack: { tokenFile: path.join(tokens, 'workspace-slack-token'), channels: { todo: { id: 'C0TODO11', name: '#my-todo' } } },
  }, null, 2));
  const app = await startAppServer(t, {
    WORKSPACE_DATA_DIR: data, WORKSPACE_CONFIG: config, WORKSPACE_TOKEN_DIR: tokens,
    WORKSPACE_AUTOMATION_DIR: path.join(home, 'automation'),
  });

  const state = await (await fetch(app.base + '/api/integrations')).json();
  assert.equal(state.slack.enabled, true);
  assert.equal(state.slack.hasToken, true, '토큰이 있는지만 알려 준다');
  assert.equal(state.slack.channels.todo.name, '#my-todo');
  assert.equal(state.slack.appUrl, 'https://api.slack.com/apps', '설정에 팀 슬랙 앱 주소가 없으면 목록 화면을 준다');
  assert.equal(state.jira.enabled, false);
  assert.equal(state.meetingNotes.mode, 'manual');
  assert.equal(state.install, 'manual');
  assert.ok(!JSON.stringify(state).includes('slack-secret'), '토큰 값은 응답에 절대 없다');

  // 값이 틀리면 우리 문구 그대로 400이고 설정은 그대로다
  const before = fs.readFileSync(config, 'utf8');
  const refused = await fetch(app.base + '/api/integrations/save', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jira: { enabled: true, siteUrl: 'ftp://회사', email: 'a@b.c', token: 't' } }),
  });
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /지라 주소는 https:\/\/로 시작해야 해요/);
  assert.equal(fs.readFileSync(config, 'utf8'), before);

  // 켜기는 설정 파일만 바꾼다. 개발용 서버(manual)라 스스로 끝내지 않는다.
  const saved = await (await fetch(app.base + '/api/integrations/save', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ calendar: { enabled: true } }),
  })).json();
  assert.equal(saved.ok, true);
  assert.equal(saved.restart, false, '개발용 서버는 스스로 끝내지 않는다');
  const after = JSON.parse(fs.readFileSync(config, 'utf8'));
  assert.equal(after.integrations.calendar, true);
  assert.equal(after.title, '내가 지은 이름');
  assert.equal(after.slack.channels.todo.id, 'C0TODO11');
  assert.ok((await fetch(app.base + '/api/about')).ok, '저장 뒤에도 서버는 그대로 떠 있다');

  // 이 컴퓨터에만 두는 꾸밈 — 파일이 없어도 빈 CSS를 200으로 준다(콘솔에 404가 남지 않게)
  const css = await fetch(app.base + '/local/local.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type') || '', /text\/css/);
  assert.equal((await css.text()).trim(), '');
  assert.equal((await fetch(app.base + '/local/other.css')).status, 404, '그 한 경로 말고는 열리지 않는다');

  // 문제 보고가 읽는 오류 줄 — 로그가 없으면 조용히 빈 목록이다
  const diagnostics = await (await fetch(app.base + '/api/about/diagnostics')).json();
  assert.equal(diagnostics.found, false);
  assert.deepEqual(diagnostics.lines, []);
});

test('SLACKEZ 라우트: 채널 만들기는 설정도 토큰 파일도 쓰지 않고 id·이름만 돌려준다(토큰은 응답에 없다)', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-slackez-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const data = path.join(home, 'tracker');
  fs.mkdirSync(data);
  const tokens = path.join(home, 'tokens');
  fs.mkdirSync(tokens);
  const config = path.join(home, 'workspace.config.json');
  fs.writeFileSync(config, JSON.stringify({
    title: '내가 지은 이름',
    integrations: { slack: false, calendar: false, jira: false, tiro: false },
    slack: { appUrl: 'https://api.slack.com/apps/A0FAKE11' },
  }, null, 2));

  // 슬랙을 흉내 내는 껍데기 — 실제 slack.com에는 한 번도 닿지 않는다(지라 링크 테스트와 같은 방식).
  const wrapper = path.join(home, 'fake-slack-server.js');
  fs.writeFileSync(wrapper, `'use strict';
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input && input.url ? input.url : input);
  if (!url.startsWith('https://slack.com/api/')) return realFetch(input, init);
  const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const good = (init.headers || {}).Authorization === 'Bearer good-token';
  if (url.endsWith('/auth.test')) return json(good ? { ok: true, user: 'me', user_id: 'U0ME' } : { ok: false, error: 'invalid_auth' });
  if (url.includes('/users.conversations')) return json({ ok: true, channels: [{ id: 'C0MINE11', name: 'mine', is_private: true, is_member: true, creator: 'U0ME' }] });
  const name = JSON.parse(init.body || '{}').name;
  if (name === 'noscope') return json({ ok: false, error: 'missing_scope' });
  if (name === 'taken' || name === 'mine') return json({ ok: false, error: 'name_taken' });
  return json({ ok: true, channel: { id: 'C0NEW111', name, is_private: true } });
};
const { server } = require(${JSON.stringify(path.join(__dirname, 'server.js'))});
server.listen(Number(process.env.WORKSPACE_PORT), '127.0.0.1', () => console.log('ready'));
`);
  const port = await freePort();
  const child = spawn(process.execPath, [wrapper], {
    env: {
      ...process.env, WORKSPACE_PORT: String(port), WORKSPACE_NO_OPEN: '1', WORKSPACE_HOST: '', WORKSPACE_NO_REMOTE_CHECK: '1',
      WORKSPACE_DATA_DIR: data, WORKSPACE_CONFIG: config, WORKSPACE_TOKEN_DIR: tokens,
      WORKSPACE_AUTOMATION_DIR: path.join(home, 'automation'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  t.after(() => child.kill('SIGKILL'));
  const origin = `http://127.0.0.1:${port}`;
  await serverReady(child, origin, () => log);

  const before = fs.readFileSync(config, 'utf8');
  const make = body => fetch(origin + '/api/integrations/slack-channel', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  const made = await make({ token: 'good-token', name: 'my-todo' });
  const text = await made.text();
  assert.equal(made.status, 200);
  assert.deepEqual(JSON.parse(text), { ok: true, id: 'C0NEW111', name: 'my-todo' });
  assert.ok(!text.includes('good-token'), '토큰은 응답에 절대 없다');

  const noScope = await make({ token: 'good-token', name: 'noscope' });
  assert.equal(noScope.status, 400);
  assert.deepEqual(await noScope.json(), {
    ok: false, code: 'missing_scope',
    error: '이 슬랙 앱에는 채널 만들기 권한이 없어요 — 만든 사람에게 권한 추가를 요청해 주세요',
  }, '화면이 줄 오류와 전체 안내를 가를 수 있게 표지를 함께 준다');

  assert.match((await (await make({ token: 'good-token', name: 'taken' })).json()).error, /다른 사람이 쓰는 이름이에요 — 다른 이름을 적어 주세요/);
  // 이미 있는 내 채널이면 새로 만들지 않고 그 채널을 돌려준다(`existing`) — 이것도 설정은 쓰지 않는다
  assert.deepEqual(await (await make({ token: 'good-token', name: 'mine', key: 'todo' })).json(), { ok: true, id: 'C0MINE11', name: 'mine', existing: true });
  assert.match((await (await make({ token: 'nope', name: 'my-todo' })).json()).error, /토큰이 맞지 않아요/);
  assert.match((await (await make({ token: 'good-token', name: '내 할일' })).json()).error, /채널 이름은 소문자/);

  // 만들기는 조회와 같다 — 설정도 토큰 파일도 만들어지지 않는다(저장은 `연결`이 따로 한다).
  assert.equal(fs.readFileSync(config, 'utf8'), before, '설정은 한 글자도 바뀌지 않는다');
  assert.deepEqual(fs.readdirSync(tokens), [], '토큰 파일도 만들지 않는다');

  // 이미 있는 내 채널이 다른 칸(뺀 칸 포함)에 연결돼 있으면 저장된 설정을 보고 막는다
  fs.writeFileSync(config, JSON.stringify({ ...JSON.parse(before), slack: { ...JSON.parse(before).slack, channels: { align: { id: 'C0MINE11', name: '#mine', off: true } } } }, null, 2));
  assert.deepEqual(await (await make({ token: 'good-token', name: 'mine', key: 'todo' })).json(),
    { ok: false, code: 'channel_in_use', error: '이미 정해진 것 칸에 연결된 채널이에요 — 다른 이름을 적어 주세요' });
  assert.equal((await (await make({ token: 'good-token', name: 'mine', key: 'align' })).json()).existing, true, '같은 칸이면 그대로 쓴다');
  fs.writeFileSync(config, before);

  const state = await (await fetch(origin + '/api/integrations')).json();
  assert.equal(state.slack.appUrl, 'https://api.slack.com/apps/A0FAKE11', '적어 둔 팀 슬랙 앱 주소를 그대로 준다');
});

// ─────────────────────────────────────────────────────────────────────────────
// WP-D1 — 연동 탭 재설계: 슬랙 토큰 먼저 확인 · 채널 여러 개 만들기 · 채널 이름 따라가기 · 지라 표시 이름

test('WP-D1: 슬랙 토큰 확인은 auth.test 하나만 부르고, Bot 토큰·빈 칸은 슬랙에 보내지 않는다(토큰은 어디에도 안 실린다)', async () => {
  const calls = [];
  const fake = answer => async (url, options) => { calls.push({ url: String(url), options }); if (answer instanceof Error) throw answer; return json(answer); };

  const ok = await integrationsStore.slackTokenCheck(' xoxp-good ', fake({ ok: true, user: 'me', team: '회사', user_id: 'U1' }));
  assert.deepEqual(ok, { ok: true, prefix: 'me' }, '새 채널 이름의 앞머리만 돌려준다(팀·사용자 id는 싣지 않는다)');
  assert.deepEqual(calls.map(call => call.url), ['https://slack.com/api/auth.test']);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer xoxp-good', '토큰은 헤더로만 나간다');
  assert.ok(!JSON.stringify(ok).includes('xoxp-good'));
  // 12시간짜리 토큰(토큰 교체를 켠 앱의 `xoxe.xoxp-`)은 받되 경고 종류를 같이 돌려준다 — 막지 않는다.
  const rotating = await integrationsStore.slackTokenCheck('xoxe.xoxp-1-ROTATING', fake({ ok: true, user: 'me' }));
  assert.deepEqual(rotating, { ok: true, prefix: 'me', warning: 'rotating_token' });

  calls.length = 0;
  await assert.rejects(() => integrationsStore.slackTokenCheck('xoxp-bad', fake({ ok: false, error: 'invalid_auth' })),
    error => error.code === 'invalid_auth' && /토큰이 맞지 않아요/.test(error.message) && !error.message.includes('xoxp-bad'));
  await assert.rejects(() => integrationsStore.slackTokenCheck('xoxp-t', fake(new Error('offline'))), /슬랙에 닿지 못했어요/);
  const before = calls.length;
  await assert.rejects(() => integrationsStore.slackTokenCheck('xoxb-bot', fake({ ok: true })),
    error => error.code === 'bot_token' && /이건 Bot 토큰이에요 — 바로 위의 User OAuth Token\(xoxp-\)을 복사해 주세요/.test(error.message));
  await assert.rejects(() => integrationsStore.slackTokenCheck('   ', fake({ ok: true })), /슬랙 토큰을 붙여 넣어 주세요/);
  assert.equal(calls.length, before, 'Bot 토큰·빈 칸은 슬랙에 닿지 않는다');
});

test('WP-D1: 지라 표시 이름은 연결할 때 config의 jira.displayName에 적고 연동 상태로 돌려준다(토큰·이메일이 아니다)', async (t) => {
  const fix = integrationsFixture(t, { integrations: { jira: false } });
  await integrationsStore.saveIntegrations({
    configPath: fix.configPath, current: fix.read(), tokenDir: fix.tokenDir,
    body: { jira: { enabled: true, siteUrl: 'https://회사.atlassian.net', email: '나@회사.com', token: 'jira-secret' } },
    jiraCheck: async () => ({ ok: true, displayName: ' 하늘 ' }),
  });
  const saved = fix.read();
  assert.equal(saved.jira.displayName, '하늘');
  assert.ok(!JSON.stringify(saved).includes('jira-secret'));
  const state = integrationsStore.readIntegrations(saved, { tokenDir: fix.tokenDir });
  assert.equal(state.jira.displayName, '하늘');
  assert.equal(state.jira.hasToken, true);
  // 해제해도 표시 이름은 남는다(다시 연결하면 새 값으로 바뀐다)
  await integrationsStore.saveIntegrations({ configPath: fix.configPath, current: fix.read(), tokenDir: fix.tokenDir, body: { jira: { enabled: false } } });
  assert.equal(fix.read().jira.displayName, '하늘');
  assert.equal(integrationsStore.readIntegrations({}, { tokenDir: fix.tokenDir }).jira.displayName, '', '적힌 적이 없으면 빈 글자');
});

test('WP-D1: 회의록 `다른 것`(옛 설정)은 그대로 읽고 저장도 된다 — 화면에서만 요청하기로 옮겼다', async (t) => {
  const read = config => integrationsStore.readIntegrations(config, { tokenDir: fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-int-')) });
  assert.deepEqual(read({ integrations: { tiro: false }, meetingNotes: { other: '노션' } }).meetingNotes, { mode: 'other', name: '노션' });
  const fix = integrationsFixture(t, {});
  await integrationsStore.saveIntegrations({ configPath: fix.configPath, current: fix.read(), tokenDir: fix.tokenDir, body: { meetingNotes: { mode: 'other', name: '노션' } } });
  assert.deepEqual(fix.read().meetingNotes, { other: '노션' });
  assert.equal(fix.read().integrations.tiro, false);
});

test('WP-D1: 채널 이름 따라가기 — 바뀐 이름만 config에 고치고, 사라진 채널은 missing, 5분 동안은 다시 묻지 않는다', async (t) => {
  const fix = integrationsFixture(t, {
    title: '그대로',
    integrations: { slack: true },
    slack: {
      tokenFile: '~/.config/workspace-slack-token',
      memo: '지우면 안 됨',
      channels: {
        todo: { id: 'C0TODO11', name: '#my-todo' },
        waiting: { id: 'C0WAIT11', name: '#my-waiting' },
        align: { id: 'C0GONE11', name: '#my-align' },
        someday: { id: 'C0ARCH11', name: '#my-someday' },
      },
    },
  });
  fs.mkdirSync(fix.tokenDir, { recursive: true });
  fs.writeFileSync(path.join(fix.tokenDir, 'workspace-slack-token'), 'xoxp-follow\n', { mode: 0o600 });
  let clock = 1000;
  const calls = [];
  const request = async (url, options) => {
    const id = new URL(url).searchParams.get('channel');
    calls.push({ id, auth: options.headers.Authorization });
    if (id === 'C0TODO11') return json({ ok: true, channel: { id, name: 'todo-renamed' } });
    if (id === 'C0WAIT11') return json({ ok: true, channel: { id, name: 'my-waiting' } });
    if (id === 'C0GONE11') return json({ ok: false, error: 'channel_not_found' });
    return json({ ok: true, channel: { id, name: 'my-someday', is_archived: true } });
  };
  const follower = integrationsStore.createSlackNameFollower({ now: () => clock, request });
  const run = () => follower.follow({ read: fix.read, configPath: fix.configPath, tokenDir: fix.tokenDir });

  const first = await run();
  assert.deepEqual(first.renamed, { todo: '#todo-renamed' });
  assert.deepEqual(first.missing, { align: true, someday: true });
  const saved = fix.read();
  assert.deepEqual(saved.slack.channels.todo, { id: 'C0TODO11', name: '#todo-renamed' }, '이름 한 칸만 고친다');
  assert.deepEqual(saved.slack.channels.align, { id: 'C0GONE11', name: '#my-align' }, '사라진 채널은 config를 건드리지 않는다');
  assert.equal(saved.title, '그대로');
  assert.equal(saved.slack.memo, '지우면 안 됨', '모르는 칸은 그대로다');
  assert.ok(!fs.readFileSync(fix.configPath, 'utf8').includes('xoxp-follow'), '토큰은 config에 적지 않는다');
  assert.equal(calls.length, 4);
  assert.ok(calls.every(call => call.auth === 'Bearer xoxp-follow'), '토큰은 헤더로만 나간다');

  // 5분 안에는 다시 묻지 않는다(사라진 채널도 기억한다) — 이름이 이미 같으니 쓰기도 없다
  const written = fs.readFileSync(fix.configPath, 'utf8');
  clock += 60 * 1000;
  const second = await run();
  assert.equal(calls.length, 4, '캐시 안에서는 슬랙을 부르지 않는다');
  assert.deepEqual(second.missing, { align: true, someday: true });
  assert.deepEqual(second.renamed, {});
  assert.equal(fs.readFileSync(fix.configPath, 'utf8'), written);
  clock += integrationsStore.SLACK_FOLLOW_MS;
  await run();
  assert.equal(calls.length, 8, '5분이 지나면 다시 묻는다');

  // 슬랙이 답하지 않으면 조용히 옛 이름 — 쓰기도 missing도 없다
  const quiet = integrationsStore.createSlackNameFollower({ now: () => clock, request: async () => { throw new Error('offline'); } });
  const fallback = await quiet.follow({ read: fix.read, configPath: fix.configPath, tokenDir: fix.tokenDir });
  assert.deepEqual(fallback, { renamed: {}, missing: {} });
  assert.equal(fix.read().slack.channels.todo.name, '#todo-renamed');

  // 슬랙을 껐거나 토큰이 없으면 아무 데도 묻지 않는다
  const never = [];
  const idle = integrationsStore.createSlackNameFollower({ request: async (...args) => { never.push(args); return json({}); } });
  await idle.follow({ read: () => ({ ...fix.read(), integrations: { slack: false } }), configPath: fix.configPath, tokenDir: fix.tokenDir });
  await idle.follow({ read: fix.read, configPath: fix.configPath, tokenDir: path.join(fix.home, 'no-tokens') });
  assert.equal(never.length, 0);
});

test('연동 상태(새 방식): 한 줄 사본만 없어도 갱신 정보가 있으면 연결된 것으로 읽는다 — 옛 방식은 토큰 파일 유무 그대로', (t) => {
  const slackAuth = require('./slack-auth');
  const fix = integrationsFixture(t, { integrations: { slack: true }, slack: { auth: 'oauth', channels: { todo: { id: 'C0TODO11', name: '#my-todo' } } } });
  fs.mkdirSync(fix.tokenDir, { recursive: true });
  const paths = slackAuth.authPaths({ config: fix.read(), tokenDir: fix.tokenDir });
  const read = config => integrationsStore.readIntegrations(config, { tokenDir: fix.tokenDir, claude: false }).slack;
  assert.equal(read(fix.read()).hasToken, false, '갱신 정보도 사본도 없으면 연결 안 됨');
  const at = Date.now();
  fs.writeFileSync(paths.oauthFile, JSON.stringify({ version: 1, accessToken: 'xoxe.xoxp-A', refreshToken: 'xoxe-1-R', expiresAt: at + 3600000, teamId: 'T1', scopes: [], connectedAt: at, savedAt: at }), { mode: 0o600 });
  const state = read(fix.read());
  assert.equal(state.hasToken, true, '사본 쓰기가 실패했거나 지워져도 수집은 도니까 연결된 것이다');
  assert.equal(state.oauth.connected, true);
  assert.ok(!JSON.stringify(state).includes('xoxe'));
  // 풀렸어도 카드는 연결된 카드(풀림)로 남는다 — 연결 안 한 카드로 돌아가지 않는다.
  fs.writeFileSync(paths.stateFile, JSON.stringify({ failure: { kind: 'reconnect', reason: 'slack_error', code: 'token_revoked' }, at, failCount: 0, savedAt: at }));
  assert.deepEqual([read(fix.read()).hasToken, read(fix.read()).oauth.connected], [true, false]);
  assert.equal(read({ integrations: { slack: true }, slack: {} }).hasToken, false, '옛 방식은 갱신 정보 파일을 보지 않는다');
});

test('채널 이름 따라가기(새 방식): 한 줄 사본이 아니라 갱신 모듈이 준 토큰으로 묻고, 다시 연결해야 하면 조용히 지나간다', async (t) => {
  const slackAuth = require('./slack-auth');
  const fix = integrationsFixture(t, { integrations: { slack: true }, slack: { auth: 'oauth', clientId: '111.222', channels: { todo: { id: 'C0TODO11', name: '#my-todo' } } } });
  fs.mkdirSync(fix.tokenDir, { recursive: true });
  const paths = slackAuth.authPaths({ config: fix.read(), tokenDir: fix.tokenDir });
  const at = Date.now();
  // 서버가 꺼져 있던 사이 만료된 상태 — 한 줄 사본에는 죽은 토큰이 남아 있다.
  fs.writeFileSync(paths.tokenFile, 'xoxe.xoxp-STALE\n', { mode: 0o600 });
  fs.writeFileSync(paths.oauthFile, JSON.stringify({ version: 1, accessToken: 'xoxe.xoxp-STALE', refreshToken: 'xoxe-1-R', expiresAt: at - 1000, teamId: 'T1', scopes: [], clientId: '111.222', connectedAt: at, savedAt: at }), { mode: 0o600 });
  const asked = [];
  const request = async (url, options) => { asked.push(options.headers.Authorization); return json({ ok: true, channel: { id: 'C0TODO11', name: 'todo-renamed' } }); };
  let refreshes = 0;
  let answer = { ok: true, access_token: 'xoxe.xoxp-FRESH', refresh_token: 'xoxe-1-R2', expires_in: 43200 };
  const refresh = async () => { refreshes += 1; return json(answer); };
  const token = (config, tokenDir) => integrationsStore.slackTokenForUse(config, { tokenDir, request: refresh });
  const follower = integrationsStore.createSlackNameFollower({ request, token });
  const first = await follower.follow({ read: fix.read, configPath: fix.configPath, tokenDir: fix.tokenDir });
  assert.deepEqual(first.renamed, { todo: '#todo-renamed' });
  assert.deepEqual(asked, ['Bearer xoxe.xoxp-FRESH']);
  assert.equal(refreshes, 1);
  assert.ok(!fs.readFileSync(fix.configPath, 'utf8').includes('xoxe'), '토큰은 config에 적지 않는다');

  // 갱신 토큰이 죽었으면(다시 연결 필요) 슬랙에 묻지 않고 빈 답 — 던지지 않는다.
  const info = JSON.parse(fs.readFileSync(paths.oauthFile, 'utf8'));
  fs.writeFileSync(paths.oauthFile, JSON.stringify({ ...info, expiresAt: Date.now() - 1000 }));
  answer = { ok: false, error: 'invalid_refresh_token' };
  const lost = integrationsStore.createSlackNameFollower({ request, token });
  assert.deepEqual(await lost.follow({ read: fix.read, configPath: fix.configPath, tokenDir: fix.tokenDir }), { renamed: {}, missing: {} });
  assert.equal(asked.length, 1);
});

// ---------- 설정 쓰기가 서로를 덮지 않는다(writeConfig) ----------
// 저장은 확인(지라·슬랙·캘린더)을 기다리는 동안 다른 저장이 끼어들 수 있다 — 쓰기 직전에 파일을 다시 읽고 바꾼 칸만 얹는다.
// 확인 함수는 손으로 푸는 약속(later)이라 실제 시간을 기다리지 않는다.
const later = () => { let resolve; let reject; const promise = new Promise((ok, no) => { resolve = ok; reject = no; }); return { promise, resolve, reject }; };
const settle = () => new Promise(resolve => setImmediate(resolve));

test('설정 쓰기: 연동 저장이 지라 확인을 기다리는 동안 자동 업데이트를 끄면, 저장이 끝난 뒤에도 꺼져 있다', async (t) => {
  const fix = integrationsFixture(t, { title: '그대로', server: { dockName: '내 앱' } });
  const check = later();
  const jira = integrationsStore.saveIntegrations({
    configPath: fix.configPath, current: fix.read(), tokenDir: fix.tokenDir,
    body: { jira: { enabled: true, siteUrl: 'https://team.atlassian.net', email: 'a@b.c', token: 'jira-secret' } },
    jiraCheck: () => check.promise,
  });
  await settle();
  await integrationsStore.savePersonalize({ configPath: fix.configPath, current: fix.read(), body: { autoUpdate: false } });
  assert.equal(fix.read().server.autoUpdate, false);
  check.resolve({ ok: true, displayName: '나' });
  const { config } = await jira;
  const saved = fix.read();
  assert.equal(saved.server.autoUpdate, false, '꺼 둔 자동 업데이트가 되살아나지 않는다');
  assert.equal(saved.server.dockName, '내 앱');
  assert.equal(saved.integrations.jira, true);
  assert.equal(saved.jira.siteUrl, 'https://team.atlassian.net');
  assert.deepEqual(config, saved, '돌려주는 설정은 실제로 쓴 설정이다');
});

test('설정 쓰기: 확인이 실패하면 그 사이 다른 저장만 남고 이 저장은 설정·토큰 아무것도 쓰지 않는다', async (t) => {
  const fix = integrationsFixture(t, { title: '그대로' });
  const check = later();
  const jira = integrationsStore.saveIntegrations({
    configPath: fix.configPath, current: fix.read(), tokenDir: fix.tokenDir,
    body: { jira: { enabled: true, siteUrl: 'https://team.atlassian.net', email: 'a@b.c', token: 'jira-secret' } },
    jiraCheck: () => check.promise,
  });
  await settle();
  await integrationsStore.savePersonalize({ configPath: fix.configPath, current: fix.read(), body: { autoUpdate: false } });
  const between = fs.readFileSync(fix.configPath, 'utf8');
  check.resolve({ ok: false, kind: 'auth' });
  await assert.rejects(jira, /이메일이나 토큰이 맞지 않아요/);
  assert.equal(fs.readFileSync(fix.configPath, 'utf8'), between);
  assert.equal(fs.existsSync(path.join(fix.tokenDir, 'workspace-jira-token')), false);
});

test('설정 쓰기: 서로 다른 칸을 바꾸는 두 저장이 겹치면 둘 다 남는다', async (t) => {
  const fix = integrationsFixture(t, { title: '옛 이름', meetingNotes: 'tiro' });
  const check = later();
  const jira = integrationsStore.saveIntegrations({
    configPath: fix.configPath, current: fix.read(), tokenDir: fix.tokenDir,
    body: { jira: { enabled: true, siteUrl: 'https://team.atlassian.net', email: 'a@b.c', token: 'jira-secret' } },
    jiraCheck: () => check.promise,
  });
  await settle();
  await integrationsStore.saveIntegrations({ configPath: fix.configPath, current: fix.read(), tokenDir: fix.tokenDir, body: { meetingNotes: { mode: 'manual' } } });
  await integrationsStore.savePersonalize({ configPath: fix.configPath, current: fix.read(), body: { title: '새 이름' } });
  check.resolve({ ok: true, displayName: '나' });
  await jira;
  const saved = fix.read();
  assert.equal(saved.meetingNotes, 'manual');
  assert.equal(saved.integrations.tiro, false);
  assert.equal(saved.title, '새 이름');
  assert.equal(saved.integrations.jira, true, '같은 객체(integrations)의 다른 칸도 둘 다 남는다');
  assert.equal(saved.jira.email, 'a@b.c');
});

test('설정 쓰기: 이름 따라가기(자동)와 사람의 저장이 같은 채널 칸이면 사람 값이 남고, 다른 채널 칸은 둘 다 남는다 — 어느 쪽이 먼저 끝나도', async (t) => {
  const seed = { title: '그대로', integrations: { slack: true }, slack: { channels: { todo: { id: 'C0TODO11', name: '#my-todo' }, waiting: { id: 'C0WAIT11', name: '#my-waiting' } } } };
  const renameAnswer = async url => json({ ok: true, channel: { id: new URL(url).searchParams.get('channel'), name: 'todo-renamed' } });

  // 1) 따라가기가 슬랙을 기다리는 동안 사람이 채널 하나를 빼면 — 따라가기는 그 채널만 건너뛰고 다른 채널 이름은 고친다
  const one = integrationsFixture(t, seed);
  const answer = later();
  const follower = integrationsStore.createSlackNameFollower({ request: url => answer.promise.then(() => renameAnswer(url)), token: async () => 'xoxp-follow' });
  const following = follower.follow({ read: one.read, configPath: one.configPath, tokenDir: one.tokenDir });
  await settle();
  await integrationsStore.saveIntegrations({ configPath: one.configPath, current: one.read(), tokenDir: one.tokenDir, body: { slack: { enabled: true, off: ['waiting'] } } });
  answer.resolve();
  assert.deepEqual((await following).renamed, { todo: '#todo-renamed', waiting: '#todo-renamed' });
  const first = one.read();
  assert.deepEqual(first.slack.channels.waiting, { id: 'C0WAIT11', name: '#my-waiting', off: true }, '사람이 뺀 표시가 남고, 자동 갱신은 그 채널 이름을 덮지 않는다');
  assert.equal(first.slack.channels.todo.name, '#todo-renamed', '사람이 안 바꾼 채널 칸은 이름을 고친다');
  assert.equal(first.title, '그대로');

  // 2) 사람의 저장이 슬랙 확인을 기다리는 동안 따라가기가 먼저 이름을 고치면 — 사람의 저장이 끝나며 그 칸은 사람 값
  const two = integrationsFixture(t, seed);
  const check = later();
  const human = integrationsStore.saveIntegrations({
    configPath: two.configPath, current: two.read(), tokenDir: two.tokenDir,
    body: { slack: { enabled: true, token: 'xoxp-human', channels: { todo: 'C0TODO22' } } },
    slackCheck: () => check.promise,
  });
  await settle();
  const auto = integrationsStore.createSlackNameFollower({ request: renameAnswer, token: async () => 'xoxp-follow' });
  await auto.follow({ read: two.read, configPath: two.configPath, tokenDir: two.tokenDir });
  assert.equal(two.read().slack.channels.todo.name, '#todo-renamed', '그 사이 따라가기는 썼다');
  check.resolve({ name: 'new-todo', created: 0 });
  await human;
  const second = two.read();
  assert.equal(second.slack.channels.todo.id, 'C0TODO22', '마지막에 누른 사람의 저장이 이긴다');
  assert.equal(second.slack.channels.todo.name, '#new-todo');
  assert.equal(second.slack.channels.waiting.name, '#todo-renamed', '사람이 안 바꾼 채널 칸의 이름 고치기는 남는다');
  assert.equal(second.title, '그대로');
});

test('설정 쓰기: 겹친 지라 저장 — 같은 이메일로 토큰만 새로 넣은 저장이 나중에 끝나면 그 저장의 연결 묶음(이메일·토큰)이 통째로 남는다', async (t) => {
  const fix = integrationsFixture(t, {});
  fs.mkdirSync(fix.tokenDir, { recursive: true });
  const tokenFile = path.join(fix.tokenDir, 'workspace-jira-token');
  fs.writeFileSync(tokenFile, 'token-a-old\n', { mode: 0o600 });
  fs.writeFileSync(fix.configPath, JSON.stringify({
    integrations: { jira: true }, jira: { siteUrl: 'https://team.atlassian.net', email: 'a@b.c', tokenFile, displayName: '가' },
  }));
  const check = later();
  const renew = integrationsStore.saveIntegrations({
    configPath: fix.configPath, current: fix.read(), tokenDir: fix.tokenDir,
    body: { jira: { enabled: true, siteUrl: 'https://team.atlassian.net', email: 'a@b.c', token: 'token-a-new' } },
    jiraCheck: () => check.promise,
  });
  await settle();
  await integrationsStore.saveIntegrations({
    configPath: fix.configPath, current: fix.read(), tokenDir: fix.tokenDir,
    body: { jira: { enabled: true, siteUrl: 'https://other.atlassian.net', email: 'b@b.c', token: 'token-b' } },
    jiraCheck: async () => ({ ok: true, displayName: '나' }),
  });
  assert.equal(fix.read().jira.email, 'b@b.c');
  check.resolve({ ok: true, displayName: '가' });
  await renew;
  const saved = fix.read();
  assert.equal(fs.readFileSync(tokenFile, 'utf8').trim(), 'token-a-new');
  assert.deepEqual(saved.jira, { siteUrl: 'https://team.atlassian.net', email: 'a@b.c', tokenFile, displayName: '가' }, '토큰 A에 이메일 B가 남지 않는다');
});

test('설정 쓰기: 이름 따라가기 중 설정 파일이 없어지거나 깨지거나 빈 객체로 읽히면 아무것도 쓰지 않는다', async (t) => {
  const seed = { title: '그대로', integrations: { slack: true }, slack: { channels: { todo: { id: 'C0TODO11', name: '#my-todo' } } } };
  const renameAnswer = async url => json({ ok: true, channel: { id: new URL(url).searchParams.get('channel'), name: 'todo-renamed' } });
  const cases = [
    ['없어짐', fix => fs.rmSync(fix.configPath), fix => fix.read],
    ['깨짐', fix => fs.writeFileSync(fix.configPath, '{ "title": '), fix => fix.read],
    // 서버의 currentConfigFile처럼 못 읽으면 {}를 주는 read
    ['빈 객체', fix => fs.writeFileSync(fix.configPath, '{ "title": '), fix => () => { try { return fix.read(); } catch { return {}; } }],
  ];
  for (const [label, breakIt, readerOf] of cases) {
    const fix = integrationsFixture(t, seed);
    const read = readerOf(fix);
    const answer = later();
    const writes = [];
    const follower = integrationsStore.createSlackNameFollower({ request: url => answer.promise.then(() => renameAnswer(url)), token: async () => 'xoxp-follow' });
    const following = follower.follow({ read, configPath: fix.configPath, tokenDir: fix.tokenDir, write: (...args) => writes.push(args) });
    await settle();
    breakIt(fix);
    const broken = fs.existsSync(fix.configPath) ? fs.readFileSync(fix.configPath, 'utf8') : null;
    answer.resolve();
    await following;
    assert.deepEqual(writes, [], `${label}: 쓰지 않는다`);
    assert.equal(fs.existsSync(fix.configPath) ? fs.readFileSync(fix.configPath, 'utf8') : null, broken, `${label}: 파일 그대로`);
  }
});

test('설정 쓰기: 사람 둘이 서로 다른 채널을 바꾸면 둘 다 남는다', async (t) => {
  const fix = integrationsFixture(t, { integrations: { slack: true }, slack: { channels: { todo: { id: 'C0TODO11', name: '#my-todo' }, waiting: { id: 'C0WAIT11', name: '#my-waiting' } } } });
  const check = later();
  const first = integrationsStore.saveIntegrations({
    configPath: fix.configPath, current: fix.read(), tokenDir: fix.tokenDir,
    body: { slack: { enabled: true, token: 'xoxp-human', channels: { someday: 'C0SOME11' } } },
    slackCheck: () => check.promise,
  });
  await settle();
  await integrationsStore.saveIntegrations({ configPath: fix.configPath, current: fix.read(), tokenDir: fix.tokenDir, body: { slack: { enabled: true, off: ['waiting'] } } });
  check.resolve({ name: 'my-someday', created: 0 });
  await first;
  const channels = fix.read().slack.channels;
  assert.equal(channels.someday.id, 'C0SOME11');
  assert.equal(channels.waiting.off, true, '먼저 끝난 사람의 빼기가 되살아나지 않는다');
  assert.deepEqual(channels.todo, { id: 'C0TODO11', name: '#my-todo' });
});

test('설정 쓰기(mergeConfig): 바꾼 칸만 얹고, 지운 칸은 지우며, 자동 갱신은 남이 바꾼 칸을 건너뛴다', () => {
  const base = { title: 'a', server: { dockName: 'x', autoUpdate: false }, slack: { tidy: 'raw' } };
  const latest = { title: 'b', server: { dockName: 'y', autoUpdate: false, extraHost: 'h' }, slack: { tidy: 'claude' }, added: 1 };
  const next = { title: 'a', server: { dockName: 'x' }, slack: { tidy: 'raw', auth: 'oauth' }, jira: { email: 'e' } };
  assert.deepEqual(integrationsStore.mergeConfig({ base, next, latest }),
    { title: 'b', server: { dockName: 'y', extraHost: 'h' }, slack: { tidy: 'claude', auth: 'oauth' }, added: 1, jira: { email: 'e' } });
  const auto = { ...base, title: 'c', server: { dockName: 'z', autoUpdate: false } };
  assert.deepEqual(integrationsStore.mergeConfig({ base, next: auto, latest, wins: 'theirs' }), latest, '남이 바꾼 칸은 자동 갱신이 덮지 않는다');
  assert.deepEqual(integrationsStore.mergeConfig({ base, next: auto, latest }).title, 'c', '사람의 저장은 같은 칸에서 이긴다');
});

test('WP-D1 라우트: 토큰 확인·채널 여러 개 만들기(부분 실패)·채널 고치기(저장된 토큰)·이름 따라가기 — 토큰은 응답·파일 어디에도 없다', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-wpd1-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const data = path.join(home, 'tracker');
  fs.mkdirSync(data);
  const tokens = path.join(home, 'tokens');
  fs.mkdirSync(tokens);
  const config = path.join(home, 'workspace.config.json');
  const calls = path.join(home, 'slack-calls.log');
  fs.writeFileSync(config, JSON.stringify({
    title: '내가 지은 이름',
    integrations: { slack: false, calendar: false, jira: false, tiro: false },
  }, null, 2));

  // 슬랙을 흉내 내는 껍데기 — 실제 slack.com에는 한 번도 닿지 않는다. 부른 메서드·이름만 적는다(토큰은 적지 않는다).
  const wrapper = path.join(home, 'fake-slack-server.js');
  fs.writeFileSync(wrapper, `'use strict';
const fs = require('node:fs');
const realFetch = globalThis.fetch;
const names = { C0TODO11: 'my-todo' };
globalThis.fetch = async (input, init = {}) => {
  const url = String(input && input.url ? input.url : input);
  if (!url.startsWith('https://slack.com/api/')) return realFetch(input, init);
  const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const auth = (init.headers || {}).Authorization || '';
  const good = auth === 'Bearer xoxp-good' || auth === 'Bearer xoxp-saved';
  const method = url.split('/api/')[1].split('?')[0];
  const body = JSON.parse(init.body || '{}');
  fs.appendFileSync(${JSON.stringify(calls)}, method + ' ' + (body.name || new URL(url).searchParams.get('channel') || '') + (auth === 'Bearer xoxp-saved' ? ' saved' : '') + '\\n');
  if (method === 'auth.test') return json(good ? { ok: true, user: 'me' } : { ok: false, error: 'invalid_auth' });
  if (method === 'conversations.info') {
    const id = new URL(url).searchParams.get('channel');
    if (id === 'C0GONE11') return json({ ok: false, error: 'channel_not_found' });
    return json({ ok: true, channel: { id, name: names[id] || 'renamed-todo', is_private: true } });
  }
  if (method === 'users.conversations') return json({ ok: true, channels: [] });
  if (body.name === 'taken') return json({ ok: false, error: 'name_taken' });
  if (body.name === 'noscope') return json({ ok: false, error: 'missing_scope' });
  const id = 'C0' + body.name.replace(/[^a-z0-9]/g, '').toUpperCase().slice(0, 7).padEnd(7, '1');
  names[id] = body.name;
  return json({ ok: true, channel: { id, name: body.name, is_private: true } });
};
const { server } = require(${JSON.stringify(path.join(__dirname, 'server.js'))});
server.listen(Number(process.env.WORKSPACE_PORT), '127.0.0.1', () => console.log('ready'));
`);
  const port = await freePort();
  const child = spawn(process.execPath, [wrapper], {
    env: {
      ...process.env, WORKSPACE_PORT: String(port), WORKSPACE_NO_OPEN: '1', WORKSPACE_HOST: '', WORKSPACE_NO_REMOTE_CHECK: '1',
      WORKSPACE_SLACK_FOLLOW: '1',
      WORKSPACE_DATA_DIR: data, WORKSPACE_CONFIG: config, WORKSPACE_TOKEN_DIR: tokens,
      WORKSPACE_AUTOMATION_DIR: path.join(home, 'automation'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  t.after(() => child.kill('SIGKILL'));
  const origin = `http://127.0.0.1:${port}`;
  await serverReady(child, origin, () => log);
  const post = (route, body) => fetch(origin + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const slackLog = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) : []);

  // ① 토큰 확인 — 파일은 하나도 쓰지 않는다
  const before = fs.readFileSync(config, 'utf8');
  const checked = await post('/api/integrations/slack-token-check', { token: 'xoxp-good' });
  const checkedText = await checked.text();
  assert.equal(checked.status, 200);
  assert.deepEqual(JSON.parse(checkedText), { ok: true, prefix: 'me' });
  assert.ok(!checkedText.includes('xoxp-good'));
  const wrong = await post('/api/integrations/slack-token-check', { token: 'xoxp-wrong' });
  assert.equal(wrong.status, 400);
  const wrongBody = await wrong.json();
  assert.deepEqual(wrongBody, { ok: false, error: '토큰이 맞지 않아요', code: 'invalid_auth' });
  const bot = await (await post('/api/integrations/slack-token-check', { token: 'xoxb-bot' })).json();
  assert.equal(bot.code, 'bot_token');
  assert.equal(slackLog().filter(line => line.startsWith('auth.test')).length, 2, 'Bot 토큰은 슬랙에 보내지 않는다');
  assert.equal(fs.readFileSync(config, 'utf8'), before, '토큰 확인은 설정을 쓰지 않는다');
  assert.deepEqual(fs.readdirSync(tokens), [], '토큰 파일도 만들지 않는다');

  // ② 고른 채널을 차례로 만든다 — 하나가 name_taken이어도 만든 것은 그대로다(화면이 줄마다 부른다)
  const made = [];
  for (const name of ['my-todo', 'taken', 'my-align']) made.push(await (await post('/api/integrations/slack-channel', { token: 'xoxp-good', name })).json());
  assert.equal(made[0].ok, true);
  assert.deepEqual(made[1], { ok: false, error: '다른 사람이 쓰는 이름이에요 — 다른 이름을 적어 주세요', code: 'name_taken' });
  assert.equal(made[2].ok, true);
  const scope = await (await post('/api/integrations/slack-channel', { token: 'xoxp-good', name: 'noscope' })).json();
  assert.equal(scope.code, 'missing_scope');
  assert.equal(fs.readFileSync(config, 'utf8'), before, '채널 만들기도 설정을 쓰지 않는다');

  // ③ 연결 — 저장은 예전 길 하나
  const saved = await (await post('/api/integrations/save', {
    slack: { enabled: true, token: 'xoxp-saved', channels: { todo: made[0].id, align: made[2].id } },
  })).json();
  assert.equal(saved.ok, true);
  assert.ok(!JSON.stringify(saved).includes('xoxp-saved'));
  assert.equal(fs.readFileSync(path.join(tokens, 'workspace-slack-token'), 'utf8').trim(), 'xoxp-saved');

  // 채널 고치기 — 토큰 칸 없이 보내면 서버가 저장된 토큰을 쓴다(응답에는 없다)
  const fixText = await (await post('/api/integrations/slack-channel', { token: '', name: 'my-waiting' })).text();
  assert.equal(JSON.parse(fixText).ok, true);
  assert.ok(!fixText.includes('xoxp-saved'));
  assert.ok(slackLog().includes('conversations.create my-waiting saved'), '저장된 토큰으로 만들었다');

  // 이름 따라가기 — todo 이름을 슬랙에서 바꾼 셈 치고 연동 상태를 연다
  const current = JSON.parse(fs.readFileSync(config, 'utf8'));
  current.slack.channels.waiting = { id: 'C0GONE11', name: '#my-waiting' };
  current.slack.channels.todo.id = 'C0ZZZZ11';
  fs.writeFileSync(config, JSON.stringify(current, null, 2));
  const state = await (await fetch(origin + '/api/integrations')).json();
  assert.equal(state.slack.channels.todo.name, '#renamed-todo', '바뀐 이름을 돌려준다');
  assert.equal(state.slack.channels.waiting.missing, true, '사라진 채널은 표시한다');
  assert.equal(state.slack.channels.align.missing, undefined);
  assert.equal(JSON.parse(fs.readFileSync(config, 'utf8')).slack.channels.todo.name, '#renamed-todo', 'config의 name만 고쳤다');
  assert.equal(JSON.parse(fs.readFileSync(config, 'utf8')).title, '내가 지은 이름');
  assert.equal(state.slack.readAt, null, '수집 기록이 없으면 읽은 때도 없다');
  assert.equal(state.jira.readAt, null);
  const infos = slackLog().filter(line => line.startsWith('conversations.info')).length;
  await (await fetch(origin + '/api/integrations')).json();
  assert.equal(slackLog().filter(line => line.startsWith('conversations.info')).length, infos, '5분 안에는 다시 묻지 않는다');
  assert.ok(!JSON.stringify(state).includes('xoxp-'), '토큰 값은 응답에 절대 없다');
});

// ─────────────────────────────────────────────────────────────────────────────
// 최종 QA에서 나온 것들 — 예시 자리표시자 채널 · 토큰 경로 · 토큰 폴더 울타리 · setup.sh의 설정 읽기

test('연동 저장: 사람이 채우지 않은 예시 채널 칸은 config에서 지우고, 진짜 채널은 지킨다', async (t) => {
  const example = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'workspace.config.example.json'), 'utf8'));
  // 예시 설정은 네 채널이 모두 자리표시자다 — 화면에서는 "연결 안 된 칸"으로 읽힌다.
  const fresh = integrationsStore.readIntegrations(example, { tokenDir: fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-int-')) });
  assert.deepEqual(fresh.slack.channels.todo, { id: '', name: '' }, '자리표시자는 채널이 없는 것과 같다');
  assert.equal(Object.values(fresh.slack.channels).filter(channel => channel.id).length, 0, '연동 탭의 `외 N개`가 거짓말하지 않는다');

  const fix = integrationsFixture(t, example);
  await integrationsStore.saveIntegrations({
    configPath: fix.configPath, current: fix.read(), tokenDir: fix.tokenDir,
    body: { slack: { enabled: true, token: 'slack-secret', channels: { todo: 'C0TODO11' } } },
    slackCheck: async () => ({ name: 'my-todo', isPrivate: true, created: 1790000000 }), now: () => 1790000123456,
  });
  const saved = fix.read();
  assert.deepEqual(Object.keys(saved.slack.channels), ['todo'], '채우지 않은 세 칸은 사라진다');
  assert.deepEqual(saved.slack.channels.todo, { id: 'C0TODO11', name: '#my-todo', since: '1790000000.000000' });
  // setup.sh는 이 글자를 찾으면 설치를 멈춘다 — 이제 아무것도 찾지 못한다.
  assert.ok(!fs.readFileSync(fix.configPath, 'utf8').includes('여기에_채널ID'));

  // 이미 연결된 진짜 채널은 그대로 남는다
  const kept = integrationsFixture(t, {
    slack: {
      channels: {
        todo: { id: 'C0TODO11', name: '#my-todo' },
        align: { id: 'C0ALIGN1', name: '#my-align' },
        someday: { id: 'C0SOME11', name: '#my-someday' },
      },
    },
  });
  await integrationsStore.saveIntegrations({
    configPath: kept.configPath, current: kept.read(), tokenDir: kept.tokenDir,
    body: { slack: { enabled: true, token: 'slack-secret', channels: { waiting: 'C0WAIT11' } } },
    slackCheck: async () => ({ name: 'my-waiting', isPrivate: true }),
  });
  assert.deepEqual(Object.keys(kept.read().slack.channels).sort(), ['align', 'someday', 'todo', 'waiting']);
});

test('연동 저장: 토큰 칸을 비우면 config에 적힌 경로의 토큰을 쓰고 그 경로를 그대로 둔다', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-token-path-'));
  // `~`가 이 임시 폴더를 가리키게 해서 실제 `~/.config`에는 닿지 않는다.
  const realHome = process.env.HOME;
  const realTokenDir = process.env.WORKSPACE_TOKEN_DIR;
  process.env.HOME = home;
  delete process.env.WORKSPACE_TOKEN_DIR;
  t.after(() => {
    process.env.HOME = realHome;
    if (realTokenDir === undefined) delete process.env.WORKSPACE_TOKEN_DIR;
    else process.env.WORKSPACE_TOKEN_DIR = realTokenDir;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const moved = path.join(home, '내가-옮겨둔', 'jira-token');
  fs.mkdirSync(path.dirname(moved), { recursive: true });
  fs.writeFileSync(moved, '옮겨둔-토큰\n', { mode: 0o600 });
  const configPath = path.join(home, 'workspace.config.json');
  const current = {
    integrations: { jira: false },
    jira: { siteUrl: 'https://회사.atlassian.net', email: '나@회사.com', tokenFile: '~/내가-옮겨둔/jira-token' },
  };
  fs.writeFileSync(configPath, JSON.stringify(current, null, 2));

  const seen = [];
  await integrationsStore.saveIntegrations({
    configPath, current,
    body: { jira: { enabled: true, siteUrl: 'https://회사.atlassian.net', email: '나@회사.com', token: '' } },
    jiraCheck: async ({ token }) => { seen.push(token); return { ok: true, displayName: '하늘' }; },
  });
  assert.deepEqual(seen, ['옮겨둔-토큰'], '토큰 칸이 비면 config에 적힌 자리에서 찾는다');
  const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(saved.jira.tokenFile, '~/내가-옮겨둔/jira-token', '사람이 옮겨 둔 경로를 기본 경로로 덮어쓰지 않는다');
  assert.equal(saved.integrations.jira, true);
  assert.equal(fs.existsSync(path.join(home, '.config', 'workspace-jira-token')), false, '기본 자리에 빈 파일을 만들지 않는다');
  assert.equal(integrationsStore.readIntegrations(saved).jira.hasToken, true, '화면도 같은 규칙으로 본다');

  // 새 토큰을 붙였을 때는 지금처럼 기본 자리에 쓰고 config도 그쪽으로 바꾼다
  await integrationsStore.saveIntegrations({
    configPath, current: saved,
    body: { jira: { enabled: true, siteUrl: 'https://회사.atlassian.net', email: '나@회사.com', token: '새-토큰' } },
    jiraCheck: async () => ({ ok: true, displayName: '하늘' }),
  });
  const again = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(again.jira.tokenFile, '~/.config/workspace-jira-token');
  assert.equal(fs.readFileSync(path.join(home, '.config', 'workspace-jira-token'), 'utf8').trim(), '새-토큰');
});

test('연동: 토큰 폴더를 끼우면 config가 어디를 가리키든 그 폴더 안만 본다', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-token-fence-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const outside = path.join(home, 'outside-token');
  fs.writeFileSync(outside, '바깥-토큰\n');
  const tokenDir = path.join(home, 'tokens');
  fs.mkdirSync(tokenDir);
  const config = {
    integrations: { jira: true, slack: true },
    jira: { siteUrl: 'https://회사.atlassian.net', email: '나@회사.com', tokenFile: outside },
    slack: { tokenFile: outside, channels: { todo: { id: 'C0TODO11', name: '#my-todo' } } },
  };

  const fenced = integrationsStore.readIntegrations(config, { tokenDir });
  assert.equal(fenced.jira.hasToken, false, '끼운 폴더 밖의 파일은 보지 않는다');
  assert.equal(fenced.slack.hasToken, false);
  fs.writeFileSync(path.join(tokenDir, 'workspace-jira-token'), '안쪽-토큰\n', { mode: 0o600 });
  assert.equal(integrationsStore.readIntegrations(config, { tokenDir }).jira.hasToken, true, '그 폴더 안 파일은 본다');

  // 저장도 같은 울타리를 쓴다
  const configPath = path.join(home, 'workspace.config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  const seen = [];
  await integrationsStore.saveIntegrations({
    configPath, current: config, tokenDir,
    body: { jira: { enabled: true, siteUrl: 'https://회사.atlassian.net', email: '나@회사.com', token: '' } },
    jiraCheck: async ({ token }) => { seen.push(token); return { ok: true, displayName: '하늘' }; },
  });
  assert.deepEqual(seen, ['안쪽-토큰']);
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).jira.tokenFile, path.join(tokenDir, 'workspace-jira-token'));

  // 그 폴더가 비면 바깥에 토큰이 있어도 "붙여 넣어 주세요"다
  fs.rmSync(path.join(tokenDir, 'workspace-jira-token'));
  await assert.rejects(() => integrationsStore.saveIntegrations({
    configPath, current: config, tokenDir,
    body: { jira: { enabled: true, siteUrl: 'https://회사.atlassian.net', email: '나@회사.com', token: '' } },
    jiraCheck: async () => ({ ok: true, displayName: '하늘' }),
  }), /API 토큰을 붙여 넣어 주세요/);
});

test('WP-E 자동화 기록: 줄 앞에 `{"ok":true}`가 붙은 옛 로그도 시각을 찾아 읽어서, 마지막 실행이 성공이면 멈춘 것이 아니다', async () => {
  const logs = path.join(automationHome, 'logs');
  const file = path.join(logs, 'slack-capture.log');
  fs.mkdirSync(logs, { recursive: true });
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  try {
    fs.writeFileSync(file, [
      '2026-09-23 18:22:00 my-todo 채널 확인 실패 — fetch 실패 (exit 28)',
      '{"ok":true}2026-09-24 06:34:07 새 메시지 없음 — Claude 호출 생략',
      '',
    ].join('\n'));
    const status = await (await fetch(base + '/api/automation/status')).json();
    const slack = status.automations.find(one => one.key === 'slack');
    assert.equal(slack.lastKind, 'skip', '붙은 줄의 성공(건너뜀)을 읽는다');
    assert.equal(slack.lastRunAt, '2026-09-24 06:34:07');
    assert.ok(!status.alerts.includes('slack'), '빨간 점이 켜지지 않는다');
    assert.deepEqual(slack.events.map(one => [one.time, one.kind]), [['2026-09-24 06:34:07', 'skip'], ['2026-09-23 18:22:00', 'fail']], '최근 기록(새것 먼저)도 같은 파서');

    // 실행 블록 선 앞에 붙은 찌꺼기도
    fs.appendFileSync(file, '{"ok":true}───── 2026-09-24 07:00:00 slack-capture 시작\n새 항목 1개\n───── 2026-09-24 07:00:30 slack-capture 종료 (exit 0)\n');
    const again = (await (await fetch(base + '/api/automation/status')).json()).automations.find(one => one.key === 'slack');
    assert.equal(again.lastKind, 'run');
    assert.equal(again.lastSummary, '새 항목 1개');
    const intg = await (await fetch(base + '/api/integrations')).json();
    assert.equal(intg.slack.fetch.failing, false);
    assert.equal(intg.slack.log[0].kind, 'run');
    const refs = Object.values((await items()).reportRefs);
    assert.equal(intg.slack.todayCount, refs.filter(ref => ref.permalink && ref.created === today).length, '오늘 슬랙에서 들어온 항목(원본 링크가 슬랙이고 오늘 만든 것)');
    assert.ok(intg.slack.todayCount >= 1, '오늘 만든 슬랙 항목(unseen)을 센다');

    // 지금 실패 중이면 이유 한 줄(summary)과 빨간 점
    fs.appendFileSync(file, '2026-09-24 07:05:00 my-todo 채널 확인 실패 — ERR:invalid_auth\n');
    const failing = await (await fetch(base + '/api/integrations')).json();
    assert.equal(failing.slack.fetch.failing, true);
    assert.equal(failing.slack.fetch.auth, true);
    assert.match(failing.slack.fetch.summary, /ERR:invalid_auth/);
    assert.equal(failing.slack.fetch.claudeAuth, false, '슬랙 토큰 문제는 Claude 로그인 안내가 아니다');
    assert.ok(failing.alerts.includes('slack'));

    // 가장 최근 실패가 Claude 로그인 풀림이면 claudeAuth — 토큰 문제가 아니라 auth는 false(버튼은 다시 시도)
    fs.appendFileSync(file, '───── 2026-09-24 07:10:00 slack-capture 시작\nFailed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth session expired and could not be refreshed"}}\n───── 2026-09-24 07:10:20 slack-capture 종료 (exit 1)\n');
    const expired = await (await fetch(base + '/api/integrations')).json();
    assert.equal(expired.slack.fetch.failing, true);
    assert.equal(expired.slack.fetch.claudeAuth, true);
    assert.equal(expired.slack.fetch.auth, false);
    assert.match(expired.slack.log[0].text, /Failed to authenticate/, '최근 기록에는 원문이 그대로 남는다');
    // 다른 말투(`Invalid API key · Please run /login`)도 같은 판단
    fs.appendFileSync(file, '───── 2026-09-24 07:15:00 slack-capture 시작\nInvalid API key · Please run /login\n───── 2026-09-24 07:15:20 slack-capture 종료 (exit 1)\n');
    assert.equal((await (await fetch(base + '/api/integrations')).json()).slack.fetch.claudeAuth, true);
    // 그 뒤에 다른 이유로 실패했으면 가장 최근 실패만 본다 — 안내하지 않는다
    fs.appendFileSync(file, '2026-09-24 07:20:00 my-todo 채널 확인 실패 — fetch 실패 (exit 28)\n');
    const other = await (await fetch(base + '/api/integrations')).json();
    assert.equal(other.slack.fetch.failing, true);
    assert.equal(other.slack.fetch.claudeAuth, false);
    // 성공하면 풀린다
    fs.appendFileSync(file, '───── 2026-09-24 07:25:00 slack-capture 시작\n(새 항목 없음)\n───── 2026-09-24 07:25:20 slack-capture 종료 (exit 0)\n');
    const fine = await (await fetch(base + '/api/integrations')).json();
    assert.equal(fine.slack.fetch.failing, false);
    assert.equal(fine.slack.fetch.claudeAuth, false);
  } finally {
    if (before === null) fs.rmSync(file, { force: true }); else fs.writeFileSync(file, before);
  }
});

test('WP-I 자동화 기록: 시작 줄의 `(v1.1.2)`를 그 회차의 버전으로 읽어 최근 기록에 싣고, 옛 시작 줄(버전 없음)도 그대로 읽는다', async () => {
  const logs = path.join(automationHome, 'logs');
  const file = path.join(logs, 'slack-capture.log');
  fs.mkdirSync(logs, { recursive: true });
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  try {
    fs.writeFileSync(file, [
      '───── 2026-09-27 10:00:00 slack-capture 시작',
      '옛 회차',
      '───── 2026-09-27 10:00:30 slack-capture 종료 (exit 0)',
      '───── 2026-09-28 10:00:00 slack-capture 시작 (v1.1.2)',
      '이번에 본 메시지 2개 = 등록 1 · 링크 중복 0 · 비슷한 일이라 건너뜀 0 · 시스템 0',
      'my-todo · 새 2개 · 저장 1 · 건너뜀 0 · 실패: 저장 1건 실패 — 커서 그대로',
      '───── 2026-09-28 10:00:30 slack-capture 종료 (exit 1)',
      '',
    ].join('\n'));
    const slack = (await (await fetch(base + '/api/automation/status')).json()).automations.find(one => one.key === 'slack');
    assert.deepEqual(slack.events.map(one => [one.time, one.kind, one.version || null]), [['2026-09-28 10:00:30', 'fail', '1.1.2'], ['2026-09-27 10:00:30', 'run', null]]);
    assert.match(slack.events[0].text, /my-todo · 새 2개 · 저장 1 · 건너뜀 0 · 실패/);
    const intg = await (await fetch(base + '/api/integrations')).json();
    assert.equal(intg.slack.log[0].version, '1.1.2', '연동 카드 ⋯ › 최근 기록 줄에도 버전');
    assert.equal(intg.slack.log[1].version, undefined);
    assert.equal(intg.slack.fetch.failing, true, '저장 실패 회차는 실패로 읽힌다');
  } finally {
    if (before === null) fs.rmSync(file, { force: true }); else fs.writeFileSync(file, before);
  }
});

// ---------- 슬랙 헛경고 줄이기 (DECISIONS 2026-10-06) ----------
// 회차 블록은 slack-collect.js가 남기는 모양 그대로다(채널 확인 실패 줄이 블록 안, 잠깐 오류·지금 가져오기 표시가 끝에).
const same = (actual, expected, message) => assert.deepEqual(actual, expected, message);
const slackRun = (start, body, exit = 1) => [`───── ${start} slack-capture 시작 (v9.9.9)`, ...body, '', `───── ${start.slice(0, -2)}40 slack-capture 종료 (exit ${exit})`];
const timeoutRun = (start, manual = false) => slackRun(start, [
  `my-todo 채널 확인 실패 — The operation was aborted due to timeout (잠깐 오류)${manual ? ' (지금 가져오기)' : ''}`,
  `채널 1개 확인 실패 (잠깐 오류) — 다음 회차에 다시${manual ? ' (지금 가져오기)' : ''}`,
]);
const atHour = (hour, minute = 0) => () => { const at = new Date(); at.setHours(hour, minute, 0, 0); return at; };
async function withSlackLog(lines, fn) {
  const file = path.join(automationHome, 'logs', 'slack-capture.log');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const serverModule = require('./server');
  const write = next => fs.writeFileSync(file, `${next.flat().join('\n')}\n`);
  try { write(lines); await fn({ write, clock: fn2 => serverModule.setSlackClockForTests(fn2) }); } finally {
    serverModule.setSlackClockForTests(null);
    if (before === null) fs.rmSync(file, { force: true }); else fs.writeFileSync(file, before);
  }
}
const slackState = async () => {
  const intg = await (await fetch(base + '/api/integrations')).json();
  return { ...intg.slack.fetch, alert: intg.alerts.includes('slack'), sync: intg.sync.slackSync };
};

test('헛경고 줄이기 ①: 잠깐의 오류(시간 초과)는 연속 3회차부터 실패 — 한 번·두 번은 실패가 아니고, 한 번 성공하면 처음부터, 밤새 안 돌아도 늘지 않는다', async () => {
  const ok = start => slackRun(start, ['이번에 본 메시지 0개 = 등록 0 · 링크 중복 0 · 비슷한 일이라 건너뜀 0 · 시스템 0'], 0);
  await withSlackLog([timeoutRun('2026-10-05 10:00:00')], async ({ write }) => {
    let state = await slackState();
    same([state.failing, state.stuck, state.alert], [false, false, false], '한 번 늦은 건 실패가 아니다');
    const status = (await (await fetch(base + '/api/automation/status')).json()).automations.find(one => one.key === 'slack');
    same([status.failTimes.length, status.failTransient, status.failManual], [1, true, false], '블록 안의 채널 줄은 회차 하나로 센다');
    write([timeoutRun('2026-10-05 10:00:00'), timeoutRun('2026-10-05 10:05:00')]);
    state = await slackState();
    same([state.failing, state.alert], [false, false], '두 번째도 아직');
    write([timeoutRun('2026-10-05 10:00:00'), timeoutRun('2026-10-05 10:05:00'), timeoutRun('2026-10-05 10:10:00')]);
    state = await slackState();
    same([state.failing, state.stuck, state.alert], [true, true, true], '연속 3회차면 멈췄어요·빨간 점');
    assert.match(state.summary, /aborted due to timeout/);
    // 한 번 성공하면 0부터 — 그 뒤 한 번 늦은 건 다시 실패가 아니다
    write([timeoutRun('2026-10-05 10:00:00'), timeoutRun('2026-10-05 10:05:00'), ok('2026-10-05 10:10:00'), timeoutRun('2026-10-05 10:15:00')]);
    state = await slackState();
    same([state.failing, state.alert], [false, false]);
    // 어제 저녁(19시 전) 한 번 늦고 밤새 안 돌았다 — 1시간이 넘어도(예전엔 멈춤) 실패가 아니다
    write([timeoutRun('2026-10-04 18:55:00')]);
    state = await slackState();
    same([state.failing, state.stuck, state.alert], [false, false, false]);
  });
});

test('헛경고 줄이기 ②: 토큰 문제·잠깐 오류가 아닌 실패는 예전처럼 바로, 잠깐 오류와 섞이면 바로, 표시 없는 옛 로그도 예전처럼', async () => {
  await withSlackLog([slackRun('2026-10-05 10:00:00', ['my-todo 채널 확인 실패 — Slack: invalid_auth'])], async ({ write }) => {
    let state = await slackState();
    same([state.failing, state.auth, state.stuck, state.alert], [true, true, true, true], '인증 문제는 한 번이어도 멈춤');
    write([slackRun('2026-10-05 10:00:00', ['my-todo 채널 확인 실패 — 슬랙 연결이 풀림, 다시 연결 필요(slack_reconnect · invalid_refresh_token)'])]);
    same((await slackState()).auth, true, '블록 안의 다시 연결 줄도 토큰 문제로 읽는다');
    write([slackRun('2026-10-05 10:00:00', ['my-todo 채널 확인 실패 — Slack: channel_not_found'])]);
    state = await slackState();
    same([state.failing, state.auth], [true, false], '잠깐 오류가 아닌 실패는 기다리지 않고 바로 실패');
    write([slackRun('2026-10-05 10:00:00', ['my-todo 채널 확인 실패 — Slack: channel_not_found']), timeoutRun('2026-10-05 10:05:00')]);
    same((await slackState()).failing, true, '이어진 회차에 잠깐 오류가 아닌 실패가 있으면 기다리지 않는다');
    // 채널 줄 끝의 `(잠깐 오류)`만으로는 세지 않는다 — 다른 실패와 섞인 회차는 맺음 줄이 없다
    write([slackRun('2026-10-05 10:00:00', ['my-align 채널 확인 실패 — Slack: not_in_channel', 'my-todo 채널 확인 실패 — The operation was aborted due to timeout (잠깐 오류)'])]);
    same((await slackState()).failing, true, '섞인 회차는 바로 실패');
    write([slackRun('2026-10-05 10:00:00', ['이번에 본 메시지 1개 = 등록 0 · 링크 중복 0 · 비슷한 일이라 건너뜀 0 · 시스템 0', 'my-todo 채널 확인 실패 — fetch failed (잠깐 오류)', 'my-waiting · 새 1개 · 저장 0 · 건너뜀 0 · 실패: 분류 실패(exit 3) — 커서 그대로'])]);
    same((await slackState()).failing, true, '정리 실패와 섞인 회차도 바로 실패');
    write(['2026-10-05 10:00:00 my-todo 채널 확인 실패 — The operation was aborted due to timeout']);
    same((await slackState()).failing, true, '표시 없는 옛 줄은 예전 판단 그대로');
    // 메시지 내용에 같은 글이 섞여도 끝에 붙은 표시만 본다
    write([slackRun('2026-10-05 10:00:00', ['my-todo · 새 1개 · 저장 0 · 건너뜀 0 · 실패: 저장 1건 실패 — 커서 그대로', '  - (잠깐 오류) 라는 제목의 일'])]);
    same((await slackState()).failing, true);
  });
});

test('헛경고 줄이기 ③: 쉬는 시간(9~19시 밖)이면 `대기 중` — 지난 실패·빨간 점을 숨기고, 토큰 문제·밤에 누른 지금 가져오기의 실패는 보인다(경계 8:59·9:00·18:59·19:00)', async () => {
  const hard = slackRun('2026-10-05 18:50:00', ['my-todo 채널 확인 실패 — Slack: channel_not_found']);
  const stuckHard = [hard, slackRun('2026-10-05 18:55:00', ['my-todo 채널 확인 실패 — Slack: channel_not_found'])];
  await withSlackLog(stuckHard, async ({ write, clock }) => {
    clock(atHour(23));
    let state = await slackState();
    same([state.resting, state.restUntil, state.failing, state.stuck, state.alert, state.summary], [true, 9, false, false, false, null], '밤에는 지난 실패를 숨긴다');
    same(state.sync.resting, true, '늦음 판단 재료(slackSync)에도 쉬는 시간');
    const items = await (await fetch(base + '/api/items')).json();
    same(items.slackSync.resting, true, '톱니바퀴 주황 점(/api/items)도 같은 값');
    // 경계 — 8:59는 쉬는 시간, 9:00부터 실제 상태, 18:59까지 실제 상태, 19:00부터 쉬는 시간
    for (const [hour, minute, resting] of [[8, 59, true], [9, 0, false], [18, 59, false], [19, 0, true]]) {
      clock(atHour(hour, minute));
      state = await slackState();
      // 낮이면 실제 상태 — 어제 저녁의 실패가 1시간 넘게 이어진 것이라 멈춤(빨간 점)이다(첫 회차가 돌면 바뀐다)
      same([state.resting, state.failing, state.alert], [resting, !resting, !resting], `${hour}:${minute}`);
    }
    clock(atHour(2));
    // 토큰 문제는 밤에도 그대로 보인다(사람이 고칠 일)
    write([slackRun('2026-10-05 18:55:00', ['my-todo 채널 확인 실패 — Slack: invalid_auth'])]);
    state = await slackState();
    same([state.resting, state.failing, state.auth, state.stuck, state.alert], [true, true, true, true, true]);
    // 밤에 누른 지금 가져오기의 실패는 잠깐 오류여도 바로 보인다 — 다만 밤에는 시간이 흘러도 멈춤(빨강)이 되지 않는다
    write([timeoutRun('2026-10-05 21:00:00', true)]);
    state = await slackState();
    same([state.resting, state.failing, state.stuck, state.alert], [true, true, false, false]);
    assert.match(state.summary, /지금 가져오기/);
    // 낮에 누른 지금 가져오기의 잠깐 오류도 바로 보인다(사람이 방금 누른 것)
    clock(atHour(14));
    same((await slackState()).failing, true);
  });
});

test('헛경고 줄이기 ④: 잠깐의 오류만 남긴 수집 상태(`lastError` 끝 표시)는 늦음의 오류로 치지 않는다', async () => {
  const file = path.join(directory, '.slack_capture_state.json');
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  try {
    assert.equal((await post('/api/import', { kind: 'health', payload: { success: false, error: '일부 채널을 확인하지 못했습니다. (잠깐 오류)' } })).ok, true);
    const soft = (await (await fetch(base + '/api/items')).json()).slackSync;
    same([soft.error, soft.resting], [null, false]);
    assert.equal((await post('/api/import', { kind: 'health', payload: { success: false, error: '일부 채널을 확인하지 못했습니다.' } })).ok, true);
    same((await (await fetch(base + '/api/items')).json()).slackSync.error, '일부 채널을 확인하지 못했습니다.');
  } finally {
    if (before === null) fs.rmSync(file, { force: true }); else fs.writeFileSync(file, before);
  }
});

test('헛경고 줄이기 ⑤: 시간대 값은 slack-capture.sh(CAPTURE_FROM·CAPTURE_UNTIL)와 서버(SLACK_CAPTURE_HOURS)가 같다', () => {
  const { SLACK_CAPTURE_HOURS, slackCaptureResting } = require('./server');
  const script = fs.readFileSync(path.join(__dirname, 'automation', 'slack-capture.sh'), 'utf8');
  same({ from: Number(/^CAPTURE_FROM=(\d+)$/m.exec(script)[1]), until: Number(/^CAPTURE_UNTIL=(\d+)$/m.exec(script)[1]) }, SLACK_CAPTURE_HOURS);
  assert.match(script, /if \[ "\$hour" -lt "\$CAPTURE_FROM" \] \|\| \[ "\$hour" -ge "\$CAPTURE_UNTIL" \]; then/);
  const at = (h, m) => new Date(2026, 9, 6, h, m);
  same([at(8, 59), at(9, 0), at(18, 59), at(19, 0), at(0, 0)].map(one => slackCaptureResting(one)), [true, false, false, true, true]);
});

test('claudeInstalled: launchd의 짧은 PATH여도 기본 설치 자리(~/.local/bin)·nvm 등의 claude를 찾는다', () => {
  const integrations = require('./integrations');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-claude-find-'));
  assert.equal(integrations.claudeInstalled('/usr/bin:/bin', home), false, '없으면 없다');
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(home, '.local', 'bin', 'claude'), '');
  assert.equal(integrations.claudeInstalled('/usr/bin:/bin', home), true, '~/.local/bin');
  fs.rmSync(path.join(home, '.local'), { recursive: true, force: true });
  fs.mkdirSync(path.join(home, '.nvm', 'versions', 'node', 'v22.1.0', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(home, '.nvm', 'versions', 'node', 'v22.1.0', 'bin', 'claude'), '');
  assert.equal(integrations.claudeInstalled('/usr/bin:/bin', home), true, 'nvm');
  fs.rmSync(home, { recursive: true, force: true });
});

test('slackTokenCheck: 앱 수준 토큰(xapp-)·xoxp-가 아닌 토큰은 슬랙에 보내지 않고 알린다', async () => {
  const integrations = require('./integrations');
  let called = 0;
  const request = async () => { called += 1; return { ok: true, json: async () => ({ ok: true, user: 'me' }) }; };
  await assert.rejects(integrations.slackTokenCheck('xapp-1-A0-123-abc', request), /앱 수준 토큰\(xapp-\)/);
  await assert.rejects(integrations.slackTokenCheck('xoxe-1-abc', request), /xoxp-로 시작해요/, '교체용 새로고침 토큰(xoxe-)은 아니다');
  assert.equal(called, 0, '슬랙에 보내지 않는다');
});

test('Claude 로그인 풀림 판단은 claude 자신의 로그인 문구만 — 커넥터·API의 흔한 인증 오류는 로그인 안내로 바꾸지 않는다', () => {
  const { CLAUDE_AUTH_RE } = require('./server');
  assert.ok(CLAUDE_AUTH_RE.test('Failed to authenticate. API Error: 401 OAuth session expired and could not be refreshed'));
  assert.ok(CLAUDE_AUTH_RE.test('Invalid API key · Please run /login'));
  for (const other of ['tiro-mcp: authentication_error (token expired)', 'Failed to authenticate with Jira', 'Not logged in to tiro', 'tiro-mcp: OAuth token could not be refreshed']) {
    assert.equal(CLAUDE_AUTH_RE.test(other), false, other);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 슬랙 정리 방식(`slack.tidy`: claude | raw) — 2026-09-29 원문 그대로 모드

test('슬랙 정리 방식: 처음 연결할 때만 이 맥의 Claude Code로 기본을 정하고, 이미 연결했던 설정(칸 없음)은 claude 그대로다', async (t) => {
  const connect = async (seed, claude) => {
    const fix = integrationsFixture(t, seed);
    const { result } = await integrationsStore.saveIntegrations({
      configPath: fix.configPath, current: fix.read(), tokenDir: fix.tokenDir, claude,
      body: { slack: { enabled: true, token: 'slack-secret', channels: { todo: 'C0TODO11' } } },
      slackCheck: async () => ({ name: 'my-todo', isPrivate: true }),
    });
    return { saved: fix.read(), result, read: integrationsStore.readIntegrations(fix.read(), { tokenDir: fix.tokenDir }) };
  };
  const noClaude = await connect({}, false);
  assert.equal(noClaude.saved.slack.tidy, 'raw', 'Claude가 없으면 원문 그대로로 시작한다');
  assert.equal(noClaude.result.slack.tidy, 'raw');
  assert.equal(noClaude.read.slack.tidy, 'raw');
  const withClaude = await connect({ slack: { channels: { todo: { id: '여기에_채널ID' } } } }, true);
  assert.equal(withClaude.saved.slack.tidy, 'claude', 'Claude가 있으면 예전처럼 다듬는다(예시 자리표시자만 있으면 처음 연결)');
  // 예외 9: 이미 연결했던 사람(채널 있음·tidy 칸 없음)은 Claude가 없어도 칸을 적지 않는다 — 읽으면 claude(동작 변화 0)
  const old = await connect({ slack: { channels: { todo: { id: 'C0OLD111', name: '#옛' } } } }, false);
  assert.equal(old.saved.slack.tidy, undefined, '칸을 새로 적지 않는다');
  assert.equal(old.read.slack.tidy, 'claude');
  assert.equal(old.result.slack.tidy, undefined);
  // 이미 고른 값은 다시 연결해도 그대로
  const kept = await connect({ slack: { tidy: 'raw', channels: {} } }, true);
  assert.equal(kept.saved.slack.tidy, 'raw');
  assert.equal(integrationsStore.readIntegrations({}, {}).slack.tidy, 'claude', '칸이 없으면 claude로 읽는다');
  assert.equal(integrationsStore.readIntegrations({ slack: { tidy: '이상한 값' } }, {}).slack.tidy, 'claude');
});

test('슬랙 정리 방식만 바꾸는 저장: 그 칸 하나만 쓰고(슬랙에 묻지 않음·다시 켜지 않음), claude는 Claude Code가 있을 때만 받는다', async (t) => {
  const seed = {
    title: '그대로', integrations: { slack: true },
    slack: { tokenFile: '~/.config/workspace-slack-token', workspaceUrl: 'https://team.slack.com', channels: { todo: { id: 'C0TODO11', name: '#my-todo', since: '1.000000' } } },
  };
  const fix = integrationsFixture(t, seed);
  const asked = [];
  const save = (body, claude) => integrationsStore.saveIntegrations({
    configPath: fix.configPath, current: fix.read(), tokenDir: fix.tokenDir, body, claude,
    slackCheck: async () => { asked.push('slack'); return { name: 'x' }; },
  });
  const raw = await save({ slack: { tidy: 'raw' } }, false);
  assert.equal(raw.quiet, true, '정리 방식만 바꾸면 서버를 다시 켜지 않는다');
  assert.deepEqual(raw.result.slack, { tidy: 'raw' });
  // 예외 10: 방식 전환은 설정의 그 칸만 바꾼다 — 채널·토큰 경로·다른 값은 그대로(이미 들어온 항목은 업무 데이터라 건드릴 길이 없다)
  assert.deepEqual(fix.read(), { ...seed, slack: { ...seed.slack, tidy: 'raw' } });
  assert.equal(integrationsStore.registrationKey(fix.read()), integrationsStore.registrationKey(seed), 'launchd 등록 값과 무관하다');
  assert.deepEqual(asked, [], '슬랙에 묻지 않는다');
  const before = fs.readFileSync(fix.configPath, 'utf8');
  await assert.rejects(() => save({ slack: { tidy: 'claude' } }, false), /Claude Code가 있어야 해요/);
  await assert.rejects(() => save({ slack: { tidy: 'summary' } }, true), /보낸 값을 확인해 주세요/);
  assert.equal(fs.readFileSync(fix.configPath, 'utf8'), before, '거절하면 한 글자도 바꾸지 않는다');
  const back = await save({ slack: { tidy: 'claude' } }, true);
  assert.equal(fix.read().slack.tidy, 'claude');
  assert.equal(back.quiet, true);
  // 다른 연동과 함께 저장하면 예전처럼 다시 켠다
  const mixed = await save({ slack: { tidy: 'raw' }, meetingNotes: { mode: 'manual' } }, true);
  assert.equal(mixed.quiet, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// 슬랙 연결: 이미 있는 채널 이름이면 그 채널을 쓰기(2026-09-29 동료 제보 — 예전 시도로 만든 채널 때문에 막다른 길)

// 가짜 슬랙 — 만들기는 늘 `name_taken`, 목록은 쪽마다 `pages`에서 준다. 실제 slack.com에는 닿지 않는다.
function takenSlack(pages, { create = { ok: false, error: 'name_taken' }, fail = null } = {}) {
  const calls = [];
  const reply = body => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const request = async (url, options = {}) => {
    const text = String(url);
    const method = text.split('/api/')[1].split('?')[0];
    calls.push({ method, url: text, options });
    if (fail && fail[method]) throw fail[method];
    if (method === 'auth.test') return reply({ ok: true, user: 'me', user_id: 'U0ME' });
    if (method === 'conversations.create') return reply(create);
    if (method === 'users.conversations') {
      const cursor = new URL(text).searchParams.get('cursor') || '';
      const page = typeof pages === 'function' ? pages(cursor) : pages[cursor];
      return reply(page || { ok: false, error: 'invalid_cursor' });
    }
    return reply({ ok: false, error: 'unknown_method' });
  };
  return { calls, request, lists: () => calls.filter(one => one.method === 'users.conversations') };
}

test('이미 있는 채널: 이름이 겹쳐도 내가 들어가 있는 내 비공개 채널이면 새로 만들지 않고 그 채널을 쓴다(읽기만)', async () => {
  const fake = takenSlack({ '': { ok: true, channels: [
    { id: 'C0OTHER1', name: 'general', is_member: true },
    { id: 'C0MINE11', name: 'Eren-Jang-Todo', is_private: true, is_member: true, is_archived: false, creator: 'U0ME' },
  ] } });
  const made = await integrationsStore.slackCreateChannel('slack-secret', 'eren-jang-todo', fake.request, { key: 'todo', channels: {} });
  assert.deepEqual(made, { id: 'C0MINE11', name: 'Eren-Jang-Todo', existing: true }, '대소문자는 무시하고 같은 이름을 찾는다');
  assert.deepEqual(fake.calls.map(one => one.method), ['auth.test', 'conversations.create', 'users.conversations'], '만들기는 한 번뿐 — 찾기만 더한다');
  const query = new URL(fake.lists()[0].url).searchParams;
  assert.equal(query.get('types'), 'public_channel,private_channel');
  assert.equal(query.get('exclude_archived'), 'false', '보관된 채널도 본다(보관이라고 알려 주려고)');
  assert.equal(query.get('limit'), '200');
  assert.equal(fake.lists()[0].options.method || 'GET', 'GET', '목록은 읽기만 한다');
  assert.equal(fake.lists()[0].options.headers.Authorization, 'Bearer slack-secret', '토큰은 헤더로만');
  assert.ok(!JSON.stringify(made).includes('slack-secret'));
  assert.deepEqual([...new Set(fake.calls.map(one => one.method))].sort(), ['auth.test', 'conversations.create', 'users.conversations'], '보관·삭제·나가기는 부르지 않는다');
});

test('이미 있는 채널: 남의 채널(목록에 없음·멤버 아님)은 name_taken, 보관된 같은 이름은 archived 문구', async () => {
  const hidden = takenSlack({ '': { ok: true, channels: [{ id: 'C0X', name: 'someone-else', is_member: true }] } });
  await assert.rejects(() => integrationsStore.slackCreateChannel('t', 'my-todo', hidden.request),
    error => error.code === 'name_taken' && error.message === '다른 사람이 쓰는 이름이에요 — 다른 이름을 적어 주세요');
  const notMember = takenSlack({ '': { ok: true, channels: [{ id: 'C0PUB111', name: 'my-todo', is_member: false }] } });
  await assert.rejects(() => integrationsStore.slackCreateChannel('t', 'my-todo', notMember.request),
    error => error.code === 'name_taken' && /다른 사람이 쓰는 이름이에요/.test(error.message));
  const archived = takenSlack({ '': { ok: true, channels: [{ id: 'C0OLD111', name: 'my-todo', is_member: true, is_archived: true }] } });
  await assert.rejects(() => integrationsStore.slackCreateChannel('t', 'my-todo', archived.request),
    error => error.code === 'archived' && error.message === '보관된 채널이에요 — 슬랙에서 보관을 풀거나 다른 이름을 적어 주세요');
  assert.deepEqual(archived.calls.map(one => one.method), ['auth.test', 'conversations.create', 'users.conversations'], '보관을 풀어 주지도 않는다');
});

test('이미 있는 채널: 만든 사람을 알 수 없는 비공개 채널(초대받은 채널 등)은 내 채널로 보지 않는다', async () => {
  const unknown = takenSlack({ '': { ok: true, channels: [{ id: 'C0INVITE', name: 'my-todo', is_private: true, is_member: true }] } });
  await assert.rejects(() => integrationsStore.slackCreateChannel('t', 'my-todo', unknown.request), error => error.code === 'name_taken');
});

test('이미 있는 채널: 목록이 여러 쪽이면 cursor로 끝까지(최대 10쪽), 상한·시간 초과·슬랙 오류는 "다 찾지 못했어요"(이름 중복과 구분)', async () => {
  const paged = takenSlack({
    '': { ok: true, channels: [{ id: 'C1', name: 'a' }], response_metadata: { next_cursor: 'p2' } },
    p2: { ok: true, channels: [{ id: 'C2', name: 'b' }], response_metadata: { next_cursor: 'p3' } },
    p3: { ok: true, channels: [{ id: 'C0MINE11', name: 'my-todo', is_private: true, is_member: true, creator: 'U0ME' }], response_metadata: { next_cursor: 'p4' } },
  });
  const found = await integrationsStore.slackCreateChannel('t', 'my-todo', paged.request);
  assert.equal(found.id, 'C0MINE11');
  assert.deepEqual(paged.lists().map(one => new URL(one.url).searchParams.get('cursor')), [null, 'p2', 'p3'], '찾으면 더 넘기지 않는다');
  assert.ok(paged.lists().every(one => one.options.signal === paged.lists()[0].options.signal), '시간 제한은 전체에 한 번(8초)');

  // 끝까지 봤는데 없으면 남의 채널
  const done = takenSlack({ '': { ok: true, channels: [], response_metadata: { next_cursor: '' } } });
  await assert.rejects(() => integrationsStore.slackCreateChannel('t', 'my-todo', done.request), error => error.code === 'name_taken');

  // 10쪽을 넘기면 멈추고 이름 중복이라고 하지 않는다
  const endless = takenSlack(cursor => ({ ok: true, channels: [], response_metadata: { next_cursor: `n${Number(cursor.slice(1) || 0) + 1}` } }));
  await assert.rejects(() => integrationsStore.slackCreateChannel('t', 'my-todo', endless.request),
    error => error.code === 'slack_unreachable' && error.message === '슬랙에서 채널을 다 찾지 못했어요 — 잠시 뒤 다시 눌러 주세요');
  assert.equal(endless.lists().length, 10, '최대 10쪽');

  // 시간 초과(신호가 끊음)·슬랙 오류도 같은 문구
  const timeout = new Error('The operation was aborted due to timeout');
  timeout.name = 'TimeoutError';
  const slow = takenSlack({}, { fail: { 'users.conversations': timeout } });
  await assert.rejects(() => integrationsStore.slackCreateChannel('t', 'my-todo', slow.request),
    error => error.code === 'slack_unreachable' && /다 찾지 못했어요/.test(error.message));
  const limited = takenSlack({ '': { ok: false, error: 'ratelimited' } });
  await assert.rejects(() => integrationsStore.slackCreateChannel('t', 'my-todo', limited.request),
    error => error.code === 'slack_unreachable' && /다 찾지 못했어요/.test(error.message));
  // 목록 권한이 없으면 권한 안내(기존 문구)
  const noScope = takenSlack({ '': { ok: false, error: 'missing_scope' } });
  await assert.rejects(() => integrationsStore.slackCreateChannel('t', 'my-todo', noScope.request), error => error.code === 'missing_scope');
});

test('이미 있는 채널: 다른 칸(뺀 칸 포함)에 이미 연결된 채널이면 막고, 같은 칸이면 그대로 쓴다', async () => {
  const mine = () => takenSlack({ '': { ok: true, channels: [{ id: 'C0MINE11', name: 'my-todo', is_private: true, is_member: true, creator: 'U0ME' }] } });
  const channels = { todo: { id: 'C0TODO99', name: '#x' }, align: { id: 'C0MINE11', name: '#my-todo', off: true } };
  await assert.rejects(() => integrationsStore.slackCreateChannel('t', 'my-todo', mine().request, { key: 'todo', channels }),
    error => error.code === 'channel_in_use' && error.message === '이미 정해진 것 칸에 연결된 채널이에요 — 다른 이름을 적어 주세요');
  const same = await integrationsStore.slackCreateChannel('t', 'my-todo', mine().request, { key: 'align', channels });
  assert.equal(same.id, 'C0MINE11', '같은 칸이면 막지 않는다');
  // 예시 자리표시자는 연결된 것으로 보지 않는다
  const placeholder = await integrationsStore.slackCreateChannel('t', 'my-todo', mine().request, { key: 'todo', channels: { align: { id: '여기에_채널ID' } } });
  assert.equal(placeholder.existing, true);
});

test('이미 있는 채널: 슬랙에 닿지 못하면(토큰 확인·만들기) slack_unreachable — 이름 문제와 가른다', async () => {
  const offline = new TypeError('fetch failed');
  for (const method of ['auth.test', 'conversations.create']) {
    const fake = takenSlack({}, { fail: { [method]: offline } });
    await assert.rejects(() => integrationsStore.slackCreateChannel('t', 'my-todo', fake.request),
      error => error.code === 'slack_unreachable' && error.message === '슬랙에 연결하지 못했어요 — 잠시 뒤 다시 눌러 주세요');
  }
});

test('이미 있는 채널 저장: existing 칸은 since가 지금(예전 메시지를 한꺼번에 가져오지 않음), 새로 만든 칸은 예전처럼 만든 때부터', async (t) => {
  const fix = integrationsFixture(t, {});
  const check = async (token, id) => ({ name: id === 'C0MINE11' ? 'eren-jang-todo' : 'my-waiting', isPrivate: true, created: id === 'C0MINE11' ? 1600000000 : 1790000100 });
  await integrationsStore.saveIntegrations({
    configPath: fix.configPath, current: fix.read(), tokenDir: fix.tokenDir,
    body: { slack: { enabled: true, token: 'xoxp-t', channels: { todo: 'C0MINE11', waiting: 'C0NEW111' }, existing: ['todo'] } },
    slackCheck: check, now: () => 1790000123456,
  });
  const saved = fix.read().slack.channels;
  assert.deepEqual(saved.todo, { id: 'C0MINE11', name: '#eren-jang-todo', since: '1790000123.456000' }, '이미 있던 채널은 연결하는 지금부터');
  assert.deepEqual(saved.waiting, { id: 'C0NEW111', name: '#my-waiting', since: '1790000100.000000' }, '새로 만든 채널은 그대로 만든 때부터');
  await assert.rejects(() => integrationsStore.saveIntegrations({
    configPath: fix.configPath, current: fix.read(), tokenDir: fix.tokenDir,
    body: { slack: { enabled: true, token: 'xoxp-t', channels: { todo: 'C0MINE11' }, existing: ['nope'] } }, slackCheck: check,
  }), /보낸 값을 확인해 주세요/, '모르는 칸은 받지 않는다');
});

test('이미 있는 채널 저장: 같은 채널을 두 칸에 두지 않는다(이번에 같이 붙이는 칸·그대로 남는 다른 칸·뺀 칸)', async (t) => {
  const fix = integrationsFixture(t, { slack: { channels: { align: { id: 'C0ALIGN1', name: '#a', off: true } } } });
  const before = JSON.stringify(fix.read());
  const check = async () => ({ name: 'x', isPrivate: true, created: 1 });
  const save = channels => integrationsStore.saveIntegrations({
    configPath: fix.configPath, current: fix.read(), tokenDir: fix.tokenDir,
    body: { slack: { enabled: true, token: 'xoxp-t', channels } }, slackCheck: check,
  });
  await assert.rejects(() => save({ todo: 'C0SAME11', waiting: 'C0SAME11' }),
    error => error.code === 'channel_in_use' && error.key === 'todo' && error.message === '이미 기다리는 것 칸에 연결된 채널이에요 — 다른 이름을 적어 주세요');
  await assert.rejects(() => save({ todo: 'C0ALIGN1' }),
    error => error.code === 'channel_in_use' && error.key === 'todo' && /이미 정해진 것 칸에 연결된 채널이에요/.test(error.message));
  assert.equal(JSON.stringify(fix.read()), before, '막히면 설정은 그대로');
  await save({ align: 'C0ALIGN1' });
  assert.equal(fix.read().slack.channels.align.id, 'C0ALIGN1', '같은 칸에 같은 채널은 된다');
});

test('이미 있는 채널: 내가 들어가 있어도 공개 채널이거나 다른 사람이 만든 채널이면 쓰지 않는다(나만 있는 채널만)', async () => {
  const pub = takenSlack({ '': { ok: true, channels: [{ id: 'C0TEAM11', name: 'todo', is_private: false, is_member: true }] } });
  await assert.rejects(() => integrationsStore.slackCreateChannel('t', 'todo', pub.request), error => error.code === 'name_taken', '만든 사람을 모르는 공개 채널은 쓰지 않는다');
  // 내가 만든 공개 채널: 나 혼자면 쓰고, 여러 명이면(팀 채널) 쓰지 않는다 — 인원은 conversations.info로 읽기만
  const solo = (members) => {
    const base = takenSlack({ '': { ok: true, channels: [{ id: 'C0PUBME1', name: 'my-todo', is_private: false, is_member: true, creator: 'U0ME' }] } });
    return async (url, options) => {
      const text = String(url);
      if (text.includes('/auth.test')) return new Response(JSON.stringify({ ok: true, user: 'me', user_id: 'U0ME' }), { status: 200 });
      if (text.includes('/conversations.info')) {
        assert.equal(new URL(text).searchParams.get('include_num_members'), 'true');
        return new Response(JSON.stringify({ ok: true, channel: { id: 'C0PUBME1', num_members: members } }), { status: 200 });
      }
      return base.request(url, options);
    };
  };
  assert.equal((await integrationsStore.slackCreateChannel('t', 'my-todo', solo(1), { key: 'todo', channels: {} })).id, 'C0PUBME1', '혼자 쓰는 내 공개 채널은 쓴다');
  await assert.rejects(() => integrationsStore.slackCreateChannel('t', 'my-todo', solo(5), { key: 'todo', channels: {} }), error => error.code === 'name_taken', '여러 명 있는 공개 채널은 쓰지 않는다');
  const others = takenSlack({ '': { ok: true, channels: [{ id: 'C0SHARE1', name: 'my-todo', is_private: true, is_member: true, creator: 'U0OTHER' }] } });
  const request = async (url, options) => (String(url).includes('/auth.test')
    ? new Response(JSON.stringify({ ok: true, user: 'me', user_id: 'U0ME' }), { status: 200 })
    : others.request(url, options));
  await assert.rejects(() => integrationsStore.slackCreateChannel('t', 'my-todo', request), error => error.code === 'name_taken');
  const mine = takenSlack({ '': { ok: true, channels: [{ id: 'C0MINE22', name: 'my-todo', is_private: true, is_member: true, creator: 'U0ME' }] } });
  const request2 = async (url, options) => (String(url).includes('/auth.test')
    ? new Response(JSON.stringify({ ok: true, user: 'me', user_id: 'U0ME' }), { status: 200 })
    : mine.request(url, options));
  const made = await integrationsStore.slackCreateChannel('t', 'my-todo', request2, { key: 'todo', channels: {} });
  assert.equal(made.id, 'C0MINE22');
  // 칸 값 없이 부르면(예전 화면) 겹침 확인은 건너뛴다 — 같은 칸에 저장된 채널이어도 막지 않는다
  const again = await integrationsStore.slackCreateChannel('t', 'my-todo', request2, { channels: { todo: { id: 'C0MINE22' } } });
  assert.equal(again.id, 'C0MINE22');
});

test('이미 있는 채널 저장: existing 표시가 없어도 만든 지 한 시간이 넘은 채널은 지금부터 읽는다(예전 화면·직접 호출 대비)', async (t) => {
  const fix = integrationsFixture(t, {});
  await integrationsStore.saveIntegrations({
    configPath: fix.configPath, current: fix.read(), tokenDir: fix.tokenDir,
    body: { slack: { enabled: true, token: 'slack-secret', channels: { todo: 'C0OLD111' } } },
    slackCheck: async () => ({ name: 'old-todo', isPrivate: true, created: 1600000000 }), now: () => 1790000123456,
  });
  assert.equal(fix.read().slack.channels.todo.since, '1790000123.456000', '예전 메시지를 한꺼번에 가져오지 않는다');
});

// ---------- Claude 로그인 토큰(연동 1층-B ②) ----------
// 값은 전부 **명백한 가짜**다. 실패 메시지에도 값이 나오지 않게 `includes` 결과만 단언한다(값을 메시지에 싣지 않는다).
const FAKE_CLAUDE = `sk-ant-oat01-FAKE-TEST-ONLY-${'x'.repeat(40)}`;
const noSecret = (text, label) => assert.equal(String(text).includes('FAKE-TEST-ONLY'), false, label);

test('Claude 토큰 저장: 임시 토큰 폴더의 파일 하나에만 0600으로 쓰고(있던 파일도 덮어쓰고 권한 재조임), config는 안 건드리며 응답에 값이 없다', async (t) => {
  const fix = integrationsFixture(t, { title: '그대로', integrations: { slack: true } });
  const before = fs.readFileSync(fix.configPath, 'utf8');
  const file = path.join(fix.tokenDir, 'workspace-claude-token');
  assert.equal(integrationsStore.tokenPaths(fix.tokenDir).claude.file, file, '임시 폴더 안 자리');
  assert.equal(integrationsStore.tokenPaths(fix.tokenDir).claude.config, undefined, 'config에 적을 경로가 없다');

  const result = integrationsStore.saveClaudeToken({ body: { token: `  ${FAKE_CLAUDE}\n` }, tokenDir: fix.tokenDir });
  assert.deepEqual(result, { ok: true, saved: true });
  noSecret(JSON.stringify(result), '돌려주는 값에 토큰이 없다');
  assert.equal(fs.readFileSync(file, 'utf8') === `${FAKE_CLAUDE}\n`, true, '앞뒤 공백은 떼고 한 줄(run-task.sh가 공백을 빼고 읽는 모양)');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(fix.configPath, 'utf8'), before, 'config는 한 글자도 바뀌지 않는다');
  assert.deepEqual(fs.readdirSync(fix.tokenDir), ['workspace-claude-token'], '다른 파일은 만들지 않는다');

  // 이미 있던 파일(느슨한 권한)도 덮어쓰고 0600으로 다시 조인다
  fs.writeFileSync(file, 'sk-ant-old-FAKE-TEST-ONLY\n');
  fs.chmodSync(file, 0o644);
  integrationsStore.saveClaudeToken({ body: { token: `${FAKE_CLAUDE}2` }, tokenDir: fix.tokenDir });
  assert.equal(fs.readFileSync(file, 'utf8') === `${FAKE_CLAUDE}2\n`, true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, '있던 파일도 0600');
});

test('Claude 토큰 저장: 빈 값·공백/줄바꿈·형식 아님·너무 긴 값은 거절하고, 문구에 값이 없으며 파일을 만들지 않는다', async (t) => {
  const fix = integrationsFixture(t, {});
  const file = path.join(fix.tokenDir, 'workspace-claude-token');
  const cases = [
    [{}, 'claude_empty'], [{ token: '' }, 'claude_empty'], [{ token: '   \n ' }, 'claude_empty'], [{ token: 42 }, 'claude_empty'], [null, 'claude_empty'],
    [{ token: 'sk-ant-FAKE-TEST-ONLY part2' }, 'claude_space'],
    [{ token: 'sk-ant-FAKE-TEST-ONLY\npart2' }, 'claude_space'],
    [{ token: 'sk-ant-FAKE-TEST-ONLY\tpart2' }, 'claude_space'],
    [{ token: 'xoxp-FAKE-TEST-ONLY' }, 'claude_shape'],
    [{ token: 'sk-ant-' }, 'claude_shape'],
    [{ token: 'sk-ant-FAKE-TEST-ONLY-토큰' }, 'claude_shape'],
    [{ token: `sk-ant-FAKE-TEST-ONLY${'y'.repeat(integrationsStore.CLAUDE_TOKEN_MAX)}` }, 'claude_long'],
  ];
  for (const [body, code] of cases) {
    let caught = null;
    try { integrationsStore.saveClaudeToken({ body, tokenDir: fix.tokenDir }); } catch (error) { caught = error; }
    assert.ok(caught, `거절: ${code}`);
    assert.equal(caught.code, code);
    assert.equal(caught.status, 400);
    noSecret(caught.message, `문구에 값이 없다: ${code}`);
    assert.ok(!/part2|yyyy|xoxp|토큰-/.test(caught.message), `문구에 값 조각이 없다: ${code}`);
  }
  assert.equal(fs.existsSync(file), false, '거절하면 파일을 만들지 않는다');
  // 딱 상한 길이는 받는다
  const edge = `sk-ant-FAKE-TEST-ONLY${'z'.repeat(integrationsStore.CLAUDE_TOKEN_MAX - 21)}`;
  assert.equal(edge.length, integrationsStore.CLAUDE_TOKEN_MAX);
  integrationsStore.saveClaudeToken({ body: { token: edge }, tokenDir: fix.tokenDir });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('Claude 토큰 라우트: 저장은 {ok, saved}만, 다른 Origin·깨진 본문은 거절, 응답·서버 로그·연동 상태·config에 값이 없고 읽는 길도 없다', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-claude-token-route-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const data = path.join(home, 'tracker');
  fs.mkdirSync(data);
  const config = path.join(home, 'workspace.config.json');
  const tokens = path.join(home, 'tokens');
  fs.writeFileSync(config, JSON.stringify({ title: '그대로', integrations: { slack: false, calendar: false, jira: false, tiro: false } }, null, 2));
  const configBefore = fs.readFileSync(config, 'utf8');
  const automation = path.join(home, 'automation');
  const app = await startAppServer(t, { WORKSPACE_DATA_DIR: data, WORKSPACE_CONFIG: config, WORKSPACE_TOKEN_DIR: tokens, WORKSPACE_AUTOMATION_DIR: automation });
  const file = path.join(tokens, 'workspace-claude-token');
  const send = (body, headers = {}) => fetch(app.base + '/api/integrations/claude-token', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body),
  });

  // 다른 Origin — 기존 방어(safeHandle) 그대로 403, 파일을 만들지 않는다
  const foreign = await send({ token: FAKE_CLAUDE }, { Origin: 'https://untrusted.example' });
  assert.equal(foreign.status, 403);
  noSecret(await foreign.text(), '거절 응답에 값이 없다');
  assert.equal(fs.existsSync(file), false);

  // 모양 틀림 — 우리 문구 그대로(값 없음)
  const wrong = await send({ token: 'sk-ant-FAKE-TEST-ONLY with space' });
  assert.equal(wrong.status, 400);
  const wrongBody = await wrong.text();
  noSecret(wrongBody, '거절 문구에 값이 없다');
  assert.equal(JSON.parse(wrongBody).code, 'claude_space');
  assert.equal(fs.existsSync(file), false);

  // 깨진 JSON(본문 일부가 오류 메시지에 섞일 수 있다) — 한 줄 문구만
  const broken = await send(`{"token":"${FAKE_CLAUDE}`);
  assert.equal(broken.status, 400);
  const brokenBody = await broken.text();
  noSecret(brokenBody, '깨진 본문의 조각이 응답에 없다');
  assert.equal(JSON.parse(brokenBody).error, '저장하지 못했어요 — 다시 눌러 주세요');
  // 짧은 깨진 본문은 JSON.parse 오류 메시지가 본문을 그대로 싣는다 — 그 메시지를 돌려주지 않는다
  let echoed = '';
  try { JSON.parse('xFAKE-TEST-ONLY'); } catch (error) { echoed = error.message; }
  assert.equal(echoed.includes('FAKE-TEST-ONLY'), true, '전제: 파서 메시지는 본문을 싣는다');
  const shortBroken = await send('xFAKE-TEST-ONLY');
  assert.equal(shortBroken.status, 400);
  noSecret(await shortBroken.text(), '파서 메시지를 그대로 돌려주지 않는다');

  // 너무 큰 본문
  const huge = await send({ token: `sk-ant-FAKE-TEST-ONLY${'q'.repeat(20000)}` });
  assert.ok(huge.status === 413 || huge.status === 400);
  noSecret(await huge.text(), '너무 큰 본문 응답에 값이 없다');
  assert.equal(fs.existsSync(file), false);

  // 저장
  const ok = await send({ token: FAKE_CLAUDE });
  assert.equal(ok.status, 200);
  const okText = await ok.text();
  noSecret(okText, '성공 응답에 값이 없다');
  assert.deepEqual(JSON.parse(okText), { ok: true, saved: true });
  assert.equal(fs.readFileSync(file, 'utf8') === `${FAKE_CLAUDE}\n`, true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(config, 'utf8'), configBefore, 'config는 그대로');
  assert.equal(fs.existsSync(path.join(automation, 'requests', 'apply.request')), false, '등록 요청 파일을 쓰지 않는다');

  // 읽는 길이 없다 — GET은 이 경로가 아니고, 연동 상태에도 값이 없다
  const read = await fetch(app.base + '/api/integrations/claude-token');
  assert.notEqual(read.status, 200);
  noSecret(await read.text(), 'GET 응답에 값이 없다');
  const state = await fetch(app.base + '/api/integrations');
  noSecret(await state.text(), '연동 상태에 값이 없다');
  noSecret(app.log(), '서버 로그에 값이 없다');
  assert.ok((await fetch(app.base + '/api/about')).ok, '저장 뒤에도 서버는 그대로 떠 있다(다시 켜지 않는다)');
});

test('연동 경로의 깨진 본문·너무 큰 본문: 파서 메시지(본문 조각) 대신 고정 문구, 상태 코드와 우리 검증 문구·정상 응답은 그대로', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-body-error-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const data = path.join(home, 'tracker');
  fs.mkdirSync(data);
  const config = path.join(home, 'workspace.config.json');
  fs.writeFileSync(config, JSON.stringify({ integrations: { slack: false, calendar: false, jira: false, tiro: true } }, null, 2));
  const app = await startAppServer(t, {
    WORKSPACE_DATA_DIR: data, WORKSPACE_CONFIG: config, WORKSPACE_TOKEN_DIR: path.join(home, 'tokens'), WORKSPACE_AUTOMATION_DIR: path.join(home, 'automation'),
  });
  const send = (route, body) => fetch(app.base + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const READ = '요청을 읽지 못했어요 — 다시 눌러 주세요';
  // 전제: 짧은 깨진 본문이면 파서 메시지가 본문 조각을 싣는다
  let echoed = '';
  try { JSON.parse('xoxp-FAKE-TEST-ONLY'); } catch (error) { echoed = error.message; }
  assert.equal(echoed.includes('FAKE-TEST-ONLY'), true, '전제: 파서 메시지는 본문을 싣는다');

  const routes = ['/api/integrations/save', '/api/integrations/slack-token-check', '/api/integrations/slack-channel', '/api/meeting-notes/request'];
  for (const route of routes) {
    for (const broken of ['xoxp-FAKE-TEST-ONLY', '{"token":"xoxp-FAKE-TEST-ONLY', '{"slack":{"token":"xoxp-FAKE-TEST-ONLY"}']) {
      const res = await send(route, broken);
      const text = await res.text();
      assert.equal(res.status, 400, `${route} 깨진 본문은 400`);
      noSecret(text, `${route} 응답에 본문 조각이 없다`);
      assert.equal(JSON.parse(text).ok, false);
      assert.equal(JSON.parse(text).error, READ, `${route} 고정 문구`);
    }
    const huge = await send(route, { token: `xoxp-FAKE-TEST-ONLY${'q'.repeat(1024 * 1024)}` });
    const hugeText = await huge.text();
    assert.equal(huge.status, 413, `${route} 너무 큰 본문은 413`);
    noSecret(hugeText, `${route} 413 응답에 값이 없다`);
    assert.equal(JSON.parse(hugeText).error, '요청이 너무 커요.');
  }

  // 우리 검증 문구는 그대로(바깥에 나가지 않는 갈래만)
  assert.deepEqual(await (await send('/api/integrations/slack-token-check', { token: 'xoxb-FAKE-TEST-ONLY' })).json(),
    { ok: false, error: integrationsStore.INTEGRATION_MESSAGE.slackBot, code: 'bot_token' });
  const noToken = await send('/api/integrations/slack-channel', { token: '', name: 'my-todo' });
  assert.equal(noToken.status, 400);
  assert.equal((await noToken.json()).error, integrationsStore.INTEGRATION_MESSAGE.slackToken);
  const noUrl = await send('/api/integrations/save', { calendar: { enabled: true, source: 'ical', url: '' } });
  assert.equal(noUrl.status, 400);
  assert.equal((await noUrl.json()).error, integrationsStore.INTEGRATION_MESSAGE.icalUrl);
  const noScope = await send('/api/meeting-notes/request', { scope: 'nope' });
  assert.equal(noScope.status, 400);
  assert.equal((await noScope.json()).error, '무엇을 가져올지 확인해 주세요.');

  // 정상 요청은 그대로
  const saved = await send('/api/integrations/save', { meetingNotes: { mode: 'other', name: '노션' } });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).ok, true);
  noSecret(app.log(), '서버 로그에 값이 없다');
});

test('Claude 토큰 라우트는 프로세스를 띄우지 않고 설정·등록·재시작 길을 부르지 않는다(코드 모양)', () => {
  const routes = fs.readFileSync(path.join(__dirname, 'routes-integrations.js'), 'utf8');
  const start = routes.indexOf("url.pathname === '/api/integrations/claude-token'");
  assert.ok(start > 0);
  const route = routes.slice(start, routes.indexOf('return true;', start));
  assert.ok(!/exec|spawn|child_process|requestApply|scheduleRestart|currentConfigFile|saveIntegrations|console\./.test(route), '파일 하나만 쓴다');
  const source = fs.readFileSync(path.join(__dirname, 'integrations.js'), 'utf8');
  const fn = source.slice(source.indexOf('function saveClaudeToken'), source.indexOf('\n}\n', source.indexOf('function saveClaudeToken')));
  assert.ok(!/exec|spawn|atomicWrite|configPath|console\./.test(fn));
  assert.ok(!/require\(['"](node:)?child_process['"]\)/.test(source), 'integrations.js는 child_process를 읽지 않는다');
});

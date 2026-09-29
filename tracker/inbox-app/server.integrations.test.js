// 서버: 연동(미팅 노트·자동화 상태·연동 저장·슬랙 토큰/채널). 공용 준비는 test-support.js.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const support = require('./test-support');
const { directory, automationHome, today, shifted, post, items, freePort, jiraModule, json, jiraFake, startAppServer, integrationsStore, integrationsFixture } = support;
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
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(home, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { if ((await fetch(origin + '/api/storage-status')).ok) break; } catch { /* 아직 안 떴다 */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal((await fetch(origin + '/api/meeting-notes/status')).status, 404);
  const refused = await fetch(origin + '/api/meeting-notes/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: 'today' }) });
  assert.equal(refused.status, 404);
  assert.equal(fs.existsSync(notesRequestFile), false);
  const automations = (await (await fetch(origin + '/api/automation/status')).json()).automations;
  assert.equal(automations.some(entry => entry.key === 'tiro'), false);
  // 지라도 꺼 둔 설정이다 — 직접 읽기·바꾸기 주소가 아예 열리지 않고, 화면도 `used:false`로 구역을 그리지 않는다.
  assert.equal((await fetch(origin + '/api/jira/issue?key=IO-48394')).status, 404);
  assert.equal((await fetch(origin + '/api/jira/options?key=IO-48394')).status, 404);
  assert.equal((await fetch(origin + '/api/jira/change', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'IO-48394', kind: 'status', transitionId: '21' }),
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
    '2026-09-23 09:02:00 지라 동기화 실패 — 나@회사.com 계정으로 IO-48394를 읽지 못했어요',
    `2026-09-23 09:03:00 에러: ${'가'.repeat(400)}`,
  ].join('\n');
  const lines = integrationsStore.errorLines(log);
  assert.equal(lines.length, 4, '오류 줄과 스택만 남는다(정상 보고문은 빠진다)');
  assert.ok(!lines.join('\n').includes('회의에서 나온 업무'), '업무 문장은 실리지 않는다');
  assert.ok(!lines.join('\n').includes('나@회사.com'), '이메일은 가린다');
  assert.ok(!lines.join('\n').includes('IO-48394'), '지라 키는 가린다');
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
      const method = String(url).split('/api/')[1];
      return json(steps[method] ? steps[method](options) : { ok: false, error: 'unknown_method' });
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
  const refuse = error => slackFake({ 'auth.test': () => ({ ok: true }), 'conversations.create': () => ({ ok: false, error }) });
  await assert.rejects(() => integrationsStore.slackCreateChannel('t', 'my-todo', refuse('missing_scope').request),
    /이 슬랙 앱에는 채널 만들기 권한이 없어요 — 만든 사람에게 권한 추가를 요청해 주세요/);
  await assert.rejects(() => integrationsStore.slackCreateChannel('t', 'my-todo', refuse('name_taken').request),
    /이미 있는 이름이에요 — 다른 이름을 적어 주세요/);
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
  await assert.rejects(() => save({ jira: { enabled: true, siteUrl: 'https://회사.atlassian.net', email: 'a@b.c', token: 't' } }), /지라에서 이 토큰으로 로그인하지 못했어요/);
  await assert.rejects(() => save({ slack: { enabled: true, token: 't', channels: { todo: '#my-todo' } } }), /슬랙 채널 링크나 ID를 붙여 넣어 주세요/);
  await assert.rejects(() => save({ slack: { enabled: true, token: 't', channels: { todo: 'C0TODO11' } } }), /슬랙에서 이 채널을 읽지 못했어요/);
  assert.equal(fs.readFileSync(fix.configPath, 'utf8'), before, '실패하면 설정은 한 글자도 바뀌지 않는다');
  assert.equal(fs.existsSync(path.join(fix.tokenDir, 'workspace-jira-token')), false, '실패하면 토큰 파일도 만들지 않는다');
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
  if (url.endsWith('/auth.test')) return json(good ? { ok: true, user: 'me' } : { ok: false, error: 'invalid_auth' });
  const name = JSON.parse(init.body || '{}').name;
  if (name === 'noscope') return json({ ok: false, error: 'missing_scope' });
  if (name === 'taken') return json({ ok: false, error: 'name_taken' });
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
  const deadline = Date.now() + 10000;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`서버가 응답하지 않았습니다: ${log}`);
    if (child.exitCode !== null) throw new Error(`서버가 종료되었습니다 (${child.exitCode}): ${log}`);
    try { if ((await fetch(origin + '/api/storage-status')).ok) break; } catch { /* 아직 안 떴다 */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }

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

  assert.match((await (await make({ token: 'good-token', name: 'taken' })).json()).error, /이미 있는 이름이에요 — 다른 이름을 적어 주세요/);
  assert.match((await (await make({ token: 'nope', name: 'my-todo' })).json()).error, /토큰이 맞지 않아요/);
  assert.match((await (await make({ token: 'good-token', name: '내 할일' })).json()).error, /채널 이름은 소문자/);

  // 만들기는 조회와 같다 — 설정도 토큰 파일도 만들어지지 않는다(저장은 `연결`이 따로 한다).
  assert.equal(fs.readFileSync(config, 'utf8'), before, '설정은 한 글자도 바뀌지 않는다');
  assert.deepEqual(fs.readdirSync(tokens), [], '토큰 파일도 만들지 않는다');

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
  const deadline = Date.now() + 10000;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`서버가 응답하지 않았습니다: ${log}`);
    if (child.exitCode !== null) throw new Error(`서버가 종료되었습니다 (${child.exitCode}): ${log}`);
    try { if ((await fetch(origin + '/api/storage-status')).ok) break; } catch { /* 아직 안 떴다 */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
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
  assert.deepEqual(made[1], { ok: false, error: '이미 있는 이름이에요 — 다른 이름을 적어 주세요', code: 'name_taken' });
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
    slackCheck: async () => ({ name: 'my-todo', isPrivate: true, created: 1790000000 }),
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

// 서버: 설정 › 앱 › 점검하기(GET /api/selfcheck, WP-K). 공용 준비는 test-support.js.
// 실제 슬랙·지라·캘린더·설정·토큰·설치 위치에는 닿지 않는다: 판단은 가짜 값으로, 바깥 확인은 가짜 fetch로만 돈다.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const support = require('./test-support');
const { directory, automationHome } = support;
const serverModule = require('./server');
const integrations = require('./integrations');
const jiraClient = require('./jira-client');
const { createSelfcheck, connectedFlags, installPlace, whenText, shellPath, SELFCHECK_CACHE_MS } = require('./selfcheck');
let base;
before(async () => { base = await support.ready(); });

const SLACK_TOKEN = 'xoxp-secret-token-value-123';
const JIRA_TOKEN = 'jira-secret-token-456';
const ICAL_URL = 'https://calendar.example.test/private-abc123/basic.ics';
const JIRA_EMAIL = 'someone@example.test';
const ICS = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n';
const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

// 임시 설정 + 임시 토큰 폴더 한 벌(실제 ~/.config에 닿지 않는다).
function home(t, { slack = true, jira = true, calendar = 'ical', notes = 'manual' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-selfcheck-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tokens = path.join(root, 'tokens');
  fs.mkdirSync(tokens);
  fs.writeFileSync(path.join(tokens, 'workspace-slack-token'), `${SLACK_TOKEN}\n`);
  fs.writeFileSync(path.join(tokens, 'workspace-jira-token'), `${JIRA_TOKEN}\n`);
  fs.writeFileSync(path.join(tokens, 'workspace-calendar-ical'), `${ICAL_URL}\n`);
  const config = {
    integrations: { slack, jira, calendar: !!calendar, tiro: notes === 'tiro' },
    slack: { tokenFile: path.join(tokens, 'workspace-slack-token'), channels: { todo: { id: 'CTODO1234', name: '#hana-todo' }, waiting: { id: 'CWAIT1234', name: '#hana-waiting' } } },
    jira: { siteUrl: 'https://team.example.test', email: JIRA_EMAIL, tokenFile: path.join(tokens, 'workspace-jira-token') },
    calendar: calendar === 'ical' ? { source: 'ical', icalFile: path.join(tokens, 'workspace-calendar-ical') } : {},
    meetingNotes: notes,
  };
  const agents = path.join(root, 'LaunchAgents');
  fs.mkdirSync(agents);
  return { root, tokens, config, agents };
}

// 가짜 바깥: 주소 조각 → 답. 부른 주소·방법을 모두 적어 둔다.
function fakeNet(routes) {
  const calls = [];
  const request = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', body: options.body || null });
    const hit = Object.keys(routes).find(part => String(url).includes(part));
    if (!hit) throw new TypeError('fetch failed');
    return routes[hit](String(url), options);
  };
  return { request, calls };
}
const okRoutes = {
  'auth.test': () => json({ ok: true, user: 'hana' }),
  'conversations.info': () => json({ ok: true, channel: { name: 'hana-todo', is_private: true, created: 1 } }),
  '/rest/api/3/myself': () => json({ accountId: 'acc-1', displayName: '하나' }),
  'calendar.example.test': () => new Response(ICS, { status: 200, headers: { 'Content-Type': 'text/calendar' } }),
};

// 서버가 넘기는 것과 같은 모양의 deps — 진짜 integrations·jira-client 함수에 가짜 fetch만 끼운다.
function depsFor(h, net, extra = {}) {
  const alerts = extra.alerts || [];
  return {
    now: extra.now || Date.now,
    home: '/Users/tester',
    nodeVersion: 'v22.11.0',
    managed: true,
    messages: integrations.INTEGRATION_MESSAGE,
    slackAuthRe: /\b(invalid_auth|token_revoked|account_inactive)\b/,
    itemTimeoutMs: extra.itemTimeoutMs, totalTimeoutMs: extra.totalTimeoutMs,
    updateFile: () => '~/workspace/업데이트.command',
    version: extra.version || (() => '1.1.5'),
    updateOffer: () => ({ available: false, label: 'v1.1.5', checkedAt: '2026-09-28T00:00:00Z' }),
    installPlace: () => extra.place || { real: '/Users/tester/workspace', playio: false, synced: false, other: null },
    agentInstalled: name => fs.existsSync(path.join(h.agents, `com.workspace.app.${name}.plist`)),
    applyFailing: () => false,
    config: () => h.config,
    readIntegrations: config => integrations.readIntegrations(config, { tokenDir: h.tokens, claude: false }),
    automations: () => extra.automations || [],
    alerts: () => alerts,
    fetchStateAutomation: (automation) => {
      const failing = !!automation && automation.lastKind === 'fail';
      return { failing, auth: false, claudeAuth: failing && /OAuth session expired/.test(automation.lastSummary || ''), failedAt: failing ? '2026-09-28T01:05:00Z' : null, lastRunAt: null, summary: null };
    },
    fetchStateLive: failure => ({ failing: !!failure, auth: !!(failure && failure.auth), failedAt: null }),
    calendarFailure: () => null,
    jiraFailure: () => null,
    claudeInstalled: () => extra.claude !== false,
    slackSuccessAt: () => null,
    slackToken: config => integrations.savedSlackToken(config, h.tokens),
    slackTokenCheck: token => integrations.slackTokenCheck(token, net.request),
    slackCheckChannel: (token, id) => integrations.slackCheckChannel(token, id, net.request),
    icalCheck: async (config) => {
      let failed = false;
      const request = (...args) => Promise.resolve().then(() => net.request(...args)).catch((error) => { failed = true; throw error; });
      try { return await integrations.icalCheck(integrations.savedIcalUrl(config, h.tokens), { request }); } catch (error) { if (failed) error.net = true; throw error; }
    },
    jiraCheck: async (config) => {
      const settings = jiraClient.jiraSettings(config);
      const token = fs.readFileSync(settings.tokenFile, 'utf8').trim();
      return jiraClient.checkJiraAccount({ siteUrl: settings.siteUrl, email: settings.email, token, request: net.request });
    },
    backup: () => extra.backup || { ok: true, local: { state: 'ok', at: '2026-09-27 19:30:04', days: 7 }, github: { on: false } },
    sync: () => ({ slackSync: { used: false }, jiraSync: { used: false }, calendar: { used: false } }),
    ...(extra.override || {}),
  };
}
const byKey = (result, key) => result.items.find(item => item.key === key);
const snapshot = dir => {
  const out = {};
  const walk = (at) => { for (const name of fs.readdirSync(at)) { const full = path.join(at, name); const stat = fs.statSync(full); if (stat.isDirectory()) walk(full); else out[full] = stat.mtimeMs; } };
  walk(dir);
  return out;
};

test('WP-K 점검: 연결한 것만 본다 — 연결 안 한 연동은 결과에서 빼고 이름만 skipped(문제 수에 세지 않는다)', async (t) => {
  const h = home(t, { slack: false, jira: true, calendar: false, notes: 'manual' });
  const net = fakeNet(okRoutes);
  const result = await createSelfcheck(depsFor(h, net)).run();
  assert.deepEqual(result.skipped, ['슬랙', '캘린더', '회의록']);
  assert.deepEqual(result.items.map(item => item.key), ['version', 'install', 'node', 'agents', 'jira', 'backup']);
  assert.ok(!net.calls.some(call => /slack\.com|calendar\.example/.test(call.url)), '연결 안 한 슬랙·캘린더에는 묻지 않는다');
  assert.equal(byKey(result, 'jira').state, 'ok');
  assert.equal(byKey(result, 'jira').detail, '하나님 · 방금 확인');
  assert.equal(byKey(result, 'jira').copy, '연결돼요 · 방금 확인', '결과 복사에는 지라 이름 대신 고정 문구');
  assert.equal(byKey(result, 'jira').lag, 'jira', '늦음은 화면이 syncLag로 더한다');
  // 연동 탭과 같은 "연결됐나" — 켜짐 + 토큰 + 주소
  assert.deepEqual(connectedFlags(integrations.readIntegrations(h.config, { tokenDir: h.tokens })), { slack: false, jira: true, calendar: false, notes: false });
});

test('WP-K 점검: 모두 정상 — 슬랙 토큰·채널(이름은 화면에만)·캘린더 비밀 주소·지라·자동 실행 등록·백업', async (t) => {
  const h = home(t);
  ['server', 'update', 'apply', 'data-backup', 'slack-capture', 'slack-capture-now'].forEach(name => fs.writeFileSync(path.join(h.agents, `com.workspace.app.${name}.plist`), ''));
  const net = fakeNet(okRoutes);
  const result = await createSelfcheck(depsFor(h, net, { automations: [{ key: 'slack', lastKind: 'run', lastRunAt: '2026-09-28 10:05:00', events: [{ time: '2026-09-28 10:05:00', kind: 'run', text: '완료' }] }] })).run();
  assert.equal(result.offline, false);
  assert.deepEqual(result.skipped, ['회의록']);
  const states = Object.fromEntries(result.items.map(item => [item.key, item.state]));
  assert.deepEqual(states, { version: 'ok', install: 'ok', node: 'ok', agents: 'ok', claude: 'ok', slack_token: 'ok', slack_channels: 'ok', slack: 'ok', calendar: 'ok', jira: 'ok', backup: 'ok' });
  assert.equal(byKey(result, 'agents').detail, '6개 모두 등록돼 있어요', '예전 Dock 앱 다시 만들기(app-refresh)는 기대하지 않는다(WP-O)');
  assert.equal(byKey(result, 'slack_channels').detail, '#hana-todo 외 1개 · 모두 읽혀요');
  assert.equal(byKey(result, 'slack_channels').copy, '켜진 채널 2개 · 모두 읽혀요');
  assert.equal(byKey(result, 'calendar').detail, '비밀 주소로 읽혀요 · 오늘 0개');
  assert.match(byKey(result, 'claude').detail, /^최근 기록 기준 · .* 슬랙 수집 성공$/);
  assert.equal(byKey(result, 'install').detail, '~/workspace');
  assert.ok(result.items.every(item => !item.fix), '정상 줄에는 고치는 법이 없다');
});

test('WP-K 점검: 바깥에는 읽기 확인만(auth.test·conversations.info·myself·주소 한 번 읽기) — 토큰·주소·이메일은 응답에 없다', async (t) => {
  const h = home(t);
  const net = fakeNet(okRoutes);
  const before = snapshot(h.root);
  const result = await createSelfcheck(depsFor(h, net)).run();
  const paths = net.calls.map(call => new URL(call.url).pathname);
  assert.deepEqual([...new Set(paths)].sort(), ['/api/auth.test', '/api/conversations.info', '/private-abc123/basic.ics', '/rest/api/3/myself'].sort());
  assert.ok(net.calls.every(call => !call.body), '본문을 싣는 호출(만들기·쓰기)이 없다');
  assert.ok(!net.calls.some(call => /conversations\.create|chat\.|\/issue|\/transitions/.test(call.url)), '쓰는 길은 부르지 않는다');
  const text = JSON.stringify(result);
  for (const secret of [SLACK_TOKEN, JIRA_TOKEN, ICAL_URL, 'private-abc123', JIRA_EMAIL, h.tokens]) assert.ok(!text.includes(secret), `응답에 ${secret}가 없다`);
  assert.deepEqual(snapshot(h.root), before, '파일을 하나도 쓰지 않는다');
});

test('WP-K 점검: 판단 근거가 없으면 unknown — 첫 백업 전(오늘/내일 19:30)·Claude 기록 없음·개발용 서버·원격 확인 전', async (t) => {
  const h = home(t, { slack: true, jira: false, calendar: false });
  const net = fakeNet(okRoutes);
  const at = (hh, mm) => () => new Date(2026, 8, 28, hh, mm).getTime();
  const deps = depsFor(h, net, { now: at(9, 0), backup: { ok: true, local: { state: 'never', days: 0 }, github: { on: false } }, override: { managed: false, updateOffer: () => ({ available: false, label: null, checkedAt: null }) } });
  const morning = await createSelfcheck(deps).run();
  assert.deepEqual([byKey(morning, 'backup').state, byKey(morning, 'backup').detail], ['unknown', '오늘 19:30에 처음 해요']);
  assert.deepEqual([byKey(morning, 'claude').state, byKey(morning, 'claude').detail], ['unknown', '아직 알 수 없어요 — Claude가 한 번 돌면 최근 기록으로 알려 줘요']);
  assert.deepEqual([byKey(morning, 'agents').state, byKey(morning, 'agents').detail], ['unknown', '개발용 서버라 아직 알 수 없어요']);
  assert.deepEqual([byKey(morning, 'version').state, byKey(morning, 'version').detail], ['unknown', 'v1.1.5 · 최신인지는 아직 알 수 없어요']);
  const night = await createSelfcheck({ ...deps, now: at(20, 0) }).run();
  assert.equal(byKey(night, 'backup').detail, '내일 19:30에 처음 해요');
});

test('WP-K 점검: 슬랙·지라·캘린더에 모두 닿지 못하면 각각 ✗ 대신 offline으로 묶는다(고치는 법 없음) — 하나만 막히면 그 줄만 ✗', async (t) => {
  const h = home(t);
  const down = fakeNet({});
  const all = await createSelfcheck(depsFor(h, down)).run();
  assert.equal(all.offline, true);
  for (const key of ['slack_token', 'calendar', 'jira']) {
    assert.equal(byKey(all, key).state, 'offline', key);
    assert.equal(byKey(all, key).fix, undefined);
  }
  assert.equal(byKey(all, 'slack_channels').state, 'unknown', '토큰 확인이 안 됐으면 채널은 알 수 없다');
  const { 'auth.test': _gone, ...noSlack } = okRoutes;
  const some = await createSelfcheck(depsFor(h, fakeNet(noSlack))).run();
  assert.equal(some.offline, false);
  assert.deepEqual([byKey(some, 'slack_token').state, byKey(some, 'slack_token').detail], ['bad', '슬랙에 닿지 못했어요']);
  assert.equal(byKey(some, 'jira').state, 'ok');
});

test('WP-K 점검: 바깥 확인은 항목마다 시간 제한 — 넘기면 `확인 못 함`(unknown), 전체도 제한 안에서 끝난다', async (t) => {
  const h = home(t);
  const hang = () => new Promise(() => {});
  const net = fakeNet({ ...okRoutes, 'auth.test': hang, '/rest/api/3/myself': hang });
  const started = Date.now();
  const result = await createSelfcheck(depsFor(h, net, { itemTimeoutMs: 60, totalTimeoutMs: 150 })).run();
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual([byKey(result, 'slack_token').state, byKey(result, 'slack_token').detail], ['unknown', '확인 못 함 — 슬랙이 제시간에 답하지 않았어요']);
  assert.deepEqual([byKey(result, 'jira').state, byKey(result, 'jira').detail], ['unknown', '확인 못 함 — 지라가 제시간에 답하지 않았어요']);
  assert.equal(byKey(result, 'calendar').state, 'ok', '제시간에 답한 것은 그대로');
  assert.equal(result.offline, false, '시간을 넘긴 것은 인터넷 문제로 묶지 않는다');
});

test('WP-K 점검: 같은 결과를 30초 들고 있는다(다시 불러도 바깥에 다시 묻지 않는다)', async (t) => {
  const h = home(t);
  const net = fakeNet(okRoutes);
  let clock = Date.parse('2026-09-28T01:00:00Z');
  const check = createSelfcheck(depsFor(h, net, { now: () => clock }));
  const first = await check.run();
  const calls = net.calls.length;
  clock += SELFCHECK_CACHE_MS - 1000;
  const second = await check.run();
  assert.equal(second.at, first.at);
  assert.equal(second.cached, true);
  assert.equal(net.calls.length, calls);
  clock += 2000;
  const third = await check.run();
  assert.notEqual(third.at, first.at);
  assert.ok(net.calls.length > calls);
});

test('WP-K 점검: 고치는 법 — 토큰 만료·Claude 로그인(명령)·자동 실행 빠짐(업데이트 파일 한 줄 명령)·같은 원인은 한 번만 센다', async (t) => {
  const h = home(t, { calendar: false, jira: false });
  ['server', 'update', 'apply', 'slack-capture', 'slack-capture-now'].forEach(name => fs.writeFileSync(path.join(h.agents, `com.workspace.app.${name}.plist`), ''));
  const net = fakeNet({ ...okRoutes, 'auth.test': () => json({ ok: false, error: 'invalid_auth' }) });
  const automations = [{ key: 'slack', lastKind: 'fail', lastRunAt: '2026-09-28 10:05:00', lastSummary: 'OAuth session expired and could not be refreshed', events: [] }];
  const result = await createSelfcheck(depsFor(h, net, { automations, alerts: ['slack'] })).run();
  const token = byKey(result, 'slack_token');
  assert.deepEqual([token.state, token.detail], ['bad', '토큰이 만료됐거나 권한이 없어요']);
  assert.match(token.fix.text, /슬랙 ⋯ › 다시 연결/);
  const claude = byKey(result, 'claude');
  assert.equal(claude.state, 'bad');
  assert.match(claude.detail, /^최근 슬랙 수집이 "로그인이 풀렸어요"로 실패했어요 · .* 기준$/);
  assert.equal(claude.fix.command, 'claude setup-token', '터미널에는 이 명령 하나만(긴 저장 명령은 없다)');
  assert.match(claude.fix.text, /설정 › 연동의 멈춘 카드/);
  assert.match(claude.fix.text, /칸에 붙여 저장/);
  assert.doesNotMatch(claude.fix.text, /read -s|printf|chmod/);
  const collect = byKey(result, 'slack');
  assert.deepEqual([collect.state, collect.sameAs], ['bad', 'claude'], '수집이 멈춘 원인이 Claude 로그인이면 그 줄을 가리킨다');
  const agents = byKey(result, 'agents');
  assert.equal(agents.state, 'bad');
  assert.match(agents.detail, /6개 중 1개가 등록돼 있지 않아요 \(data-backup\)/);
  assert.deepEqual(agents.fix, { text: '업데이트 파일(앱을 새로 받고 다시 켜 주는 파일)을 한 번 실행해 주세요', command: 'bash ~/workspace/업데이트.command', finder: '~/workspace/업데이트.command' });
  assert.equal(byKey(result, 'slack_channels').detail, '토큰을 고친 뒤 확인할 수 있어요');
});

test('WP-K 점검: 설치 위치 — playio는 ✗(업데이트 파일이 옮겨 줌), 바탕화면·문서는 !, workspace.env가 다른 폴더면 `한 벌 더`', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-place-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fake = path.join(root, 'home');
  const repo = path.join(fake, 'Desktop', 'workspace');
  const other = path.join(fake, 'workspace');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(other, { recursive: true });
  const env = path.join(root, 'workspace.env');
  fs.writeFileSync(env, `WORKSPACE_DIR="${other}"\n`);
  const real = p => fs.realpathSync(p);
  const place = installPlace({ repoDir: repo, home: real(fake), envFile: env });
  assert.equal(place.synced, true);
  assert.equal(place.other, real(other));
  assert.equal(installPlace({ repoDir: other, home: real(fake), envFile: env }).other, null, '같은 폴더면 한 벌 더가 아니다');
  const company = path.join(root, 'PlayIO', 'ws');
  fs.mkdirSync(company, { recursive: true });
  assert.equal(installPlace({ repoDir: company, home: real(fake), envFile: path.join(root, 'none.env') }).playio, true);
  // 바깥 저장소 remote에 playio(파일만 읽는다 — git을 부르지 않는다)
  const outer = path.join(root, 'outer');
  fs.mkdirSync(path.join(outer, '.git'), { recursive: true });
  fs.writeFileSync(path.join(outer, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:playio-team/docs.git\n');
  fs.mkdirSync(path.join(outer, 'ws'));
  assert.equal(installPlace({ repoDir: path.join(outer, 'ws'), home: real(fake), envFile: env }).playio, true);

  const h = home(t, { slack: false, jira: false, calendar: false });
  const run = async p => (await createSelfcheck(depsFor(h, fakeNet(okRoutes), { place: p })).run()).items.find(item => item.key === 'install');
  const playio = await run({ real: '/Users/tester/PlayIO/workspace', playio: true, synced: false, other: null });
  assert.equal(playio.state, 'bad');
  assert.equal(playio.detail, '~/PlayIO/workspace · 회사(playio) 폴더 안이에요');
  assert.equal(playio.fix.command, 'bash ~/workspace/업데이트.command');
  const twin = await run({ real: '/Users/tester/workspace', playio: false, synced: false, other: '/Users/tester/old-ws' });
  assert.equal(twin.state, 'warn');
  assert.match(twin.detail, /한 벌 더 있는 ~\/old-ws/);
  assert.equal(shellPath('~/내 폴더/업데이트.command'), "~/'내 폴더/업데이트.command'");
  assert.equal(whenText('2026-09-27 19:30:04', new Date(2026, 8, 28, 9).getTime()), '어제 19:30');
});

test('WP-K GET /api/selfcheck: 연동 탭·톱니바퀴 빨간 점과 같은 판단(같은 로그 → 같은 멈춤), 파일은 쓰지 않는다', async (t) => {
  const logs = path.join(automationHome, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const stamp = '2026-09-28 10:05:00';
  const fail = name => `───── ${stamp} ${name} 시작\n실패 이유\n───── ${stamp} ${name} 종료 (exit 1)\n`;
  const ok = name => `───── ${stamp} ${name} 시작\n완료\n───── ${stamp} ${name} 종료 (exit 0)\n`;
  const files = ['calendar-sync.log', 'tiro-sync.log'].map(name => path.join(logs, name));
  t.after(() => { files.forEach(file => fs.rmSync(file, { force: true })); serverModule.selfcheck.clear(); });
  const compare = async () => {
    serverModule.selfcheck.clear();
    const before = { data: snapshot(directory), auto: snapshot(automationHome) };
    const status = await (await fetch(`${base}/api/automation/status`)).json();
    const check = await (await fetch(`${base}/api/selfcheck`)).json();
    assert.deepEqual({ data: snapshot(directory), auto: snapshot(automationHome) }, before, '조회는 파일을 쓰지 않는다');
    assert.equal(check.ok, true);
    const alertKey = { calendar: 'calendar', notes: 'notes' };
    for (const key of ['calendar', 'notes']) {
      // 설정이 없으면 캘린더(켜짐)·회의록(티로)이 연동 탭처럼 연결된 것으로 읽힌다 — 두 줄이 늘 있다.
      const item = check.items.find(one => one.key === alertKey[key]);
      assert.ok(item, `${key} 줄이 있다`);
      assert.equal(item.state === 'bad', status.alerts.includes(key), `${key}: 점검 ✗ ⇔ 톱니바퀴 빨간 점`);
    }
    return { status, check };
  };
  fs.writeFileSync(files[0], fail('calendar-sync'));
  fs.writeFileSync(files[1], fail('tiro-sync'));
  const failing = await compare();
  assert.ok(failing.status.alerts.includes('calendar') && failing.status.alerts.includes('notes'));
  fs.writeFileSync(files[0], ok('calendar-sync'));
  fs.writeFileSync(files[1], ok('tiro-sync'));
  const fine = await compare();
  assert.deepEqual(fine.status.alerts.filter(key => ['calendar', 'notes'].includes(key)), []);
  // 응답 모양 — 정한 칸만
  assert.ok(Array.isArray(fine.check.items) && Array.isArray(fine.check.skipped));
  assert.ok(fine.check.items.every(item => ['ok', 'bad', 'warn', 'unknown', 'offline'].includes(item.state)));
  assert.ok(fine.check.sync && 'slackSync' in fine.check.sync, '늦음 판단 재료(sync)를 /api/integrations와 같은 모양으로 싣는다');
  const again = await (await fetch(`${base}/api/selfcheck`)).json();
  assert.equal(again.at, fine.check.at, '30초 안에는 같은 결과');
  assert.equal(again.cached, true);
  assert.ok(serverModule.CLIENT_BLOCKED.has('selfcheck.js'), '서버 파일은 화면으로 나가지 않는다');
  assert.equal((await fetch(`${base}/selfcheck.js`)).status, 404);
});

test('WP-V 점검: 맥 캘린더 갈래는 mac-calendar 등록 둘을 보고, Claude는 필요 없으며, 멈춤 이유는 ⚠️ 줄(허용 막힘 → 고치는 법)', async (t) => {
  const h = home(t, { slack: false, jira: false, calendar: 'mac', notes: 'manual' });
  h.config.calendar = { source: 'mac', macCalendars: [{ id: 'CAL-ME', name: 'me@example.test' }] };
  const net = fakeNet(okRoutes);
  ['server', 'update', 'apply', 'data-backup', 'mac-calendar'].forEach(name => fs.writeFileSync(path.join(h.agents, `com.workspace.app.${name}.plist`), '<plist/>'));
  // 등록 실행기가 실패 중이면 빠진 이름을 그대로 보인다(아니면 `등록하는 중`).
  const missing = await createSelfcheck(depsFor(h, net, { claude: false, override: { applyFailing: () => true } })).run();
  assert.match(byKey(missing, 'agents').detail, /mac-calendar-now/, '확인용 등록도 있어야 한다');
  assert.ok(!missing.items.some(item => item.key === 'claude'), '맥 캘린더는 Claude가 필요 없다');
  assert.ok(!net.calls.some(call => /calendar\.example/.test(call.url)), '비밀 주소에 묻지 않는다');
  assert.equal(byKey(missing, 'calendar').state, 'ok');
  assert.equal(byKey(missing, 'calendar').detail, '맥 캘린더에서 읽어요');

  fs.writeFileSync(path.join(h.agents, 'com.workspace.app.mac-calendar-now.plist'), '<plist/>');
  const summary = '⚠️ 맥이 캘린더 접근을 막았어요 — 시스템 설정 › 개인정보 보호 및 보안 › 캘린더(전체 접근)와 자동화에서 허용해 주세요';
  const stopped = await createSelfcheck(depsFor(h, net, {
    claude: false,
    alerts: ['calendar'],
    automations: [{ key: 'calendar', lastKind: 'fail', lastSummary: summary, events: [] }],
    override: { fetchStateAutomation: automation => ({ failing: !!automation && automation.lastKind === 'fail', auth: false, claudeAuth: false, failedAt: null, lastRunAt: null, summary: automation ? automation.lastSummary : null }) },
  })).run();
  assert.equal(byKey(stopped, 'agents').state, 'ok');
  const item = byKey(stopped, 'calendar');
  assert.equal(item.state, 'bad');
  assert.equal(item.detail, '맥이 캘린더 접근을 막았어요');
  assert.deepEqual(item.fix, { text: '시스템 설정 › 개인정보 보호 및 보안 › 캘린더(전체 접근)와 자동화에서 허용해 주세요' });
});

// ---- 슬랙 새 방식(슬랙 연결 버튼·자동 갱신) — 점검 줄이 갱신 상태를 말한다 ----
// 갱신 정보는 임시 토큰 폴더에만 있고(가짜 값), 갱신·확인 요청은 전부 가짜다.
const slackAuth = require('./slack-auth');
const OAUTH_ACCESS = 'xoxe.xoxp-1-CHECK-ACCESS';
const OAUTH_REFRESH = 'xoxe-1-CHECK-REFRESH';
const HOUR_MS = 60 * 60 * 1000;
function oauthHome(t, { expiresInMs = 9 * HOUR_MS, scopes = slackAuth.REQUIRED_SCOPES, failure = null, noFile = false } = {}) {
  const h = home(t, { jira: false, calendar: false });
  h.config.slack.auth = 'oauth';
  h.config.slack.clientId = '111.222';
  const paths = slackAuth.authPaths({ config: h.config, tokenDir: h.tokens });
  const at = Date.now();
  fs.writeFileSync(paths.tokenFile, `${OAUTH_ACCESS}\n`);
  if (!noFile) {
    fs.writeFileSync(paths.oauthFile, JSON.stringify({
      version: 1, accessToken: OAUTH_ACCESS, refreshToken: OAUTH_REFRESH, expiresAt: at + expiresInMs,
      teamId: 'T1', teamName: '팀', userId: 'U1', scopes, clientId: '111.222', connectedAt: at, refreshedAt: null, savedAt: at,
    }));
  }
  if (failure) fs.writeFileSync(paths.stateFile, JSON.stringify({ failure, at, failCount: 1, savedAt: at }));
  ['server', 'update', 'apply', 'data-backup', 'slack-capture', 'slack-capture-now'].forEach(name => fs.writeFileSync(path.join(h.agents, `com.workspace.app.${name}.plist`), ''));
  return { h, paths };
}
// 서버가 넘기는 것과 같은 두 길 — 지금 쓸 토큰(갱신 모듈)과 갱신 상태.
const oauthDeps = (h, net, extra = {}) => depsFor(h, net, {
  ...extra,
  override: {
    slackToken: config => integrations.slackTokenForUse(config, { tokenDir: h.tokens, request: net.request }).catch(() => ''),
    slackOAuth: config => slackAuth.readOAuthStatus({ config, tokenDir: h.tokens, minValidMs: slackAuth.REFRESH_AHEAD_MS }),
    ...(extra.override || {}),
  },
});
const noOAuthSecrets = (result) => {
  const text = JSON.stringify(result);
  for (const secret of [OAUTH_ACCESS, OAUTH_REFRESH]) assert.ok(!text.includes(secret), '점검 응답에 토큰 값이 없다');
};

test('점검(슬랙 새 방식): 정상이면 `자동 갱신 · 다음 갱신 N시간 뒤`(✓)와 받은 권한 한 줄 — 갱신 요청은 없다', async (t) => {
  const { h } = oauthHome(t, { expiresInMs: 9 * HOUR_MS + 5 * 60 * 1000 });
  const net = fakeNet(okRoutes);
  const result = await createSelfcheck(oauthDeps(h, net)).run();
  const token = byKey(result, 'slack_token');
  assert.deepEqual({ label: token.label, state: token.state, detail: token.detail }, { label: '슬랙 연결', state: 'ok', detail: '자동 갱신 · 다음 갱신 8시간 뒤' });
  assert.equal(token.fix, undefined);
  assert.deepEqual(byKey(result, 'slack_scopes'), { key: 'slack_scopes', label: '받은 권한', state: 'ok', detail: '6개 · 필요한 권한을 모두 받았어요' });
  assert.equal(byKey(result, 'slack_channels').state, 'ok');
  assert.equal(byKey(result, 'slack').state, 'ok');
  assert.deepEqual(result.items.map(item => item.key).filter(key => key.startsWith('slack')), ['slack_token', 'slack_scopes', 'slack_channels', 'slack']);
  assert.ok(!net.calls.some(call => call.url.includes('oauth.v2.access')), '만료가 멀면 점검이 갱신을 부르지 않는다');
  noOAuthSecrets(result);
});

test('점검(슬랙 새 방식): 만료가 가까우면 점검이 갱신한 토큰으로 확인하고, 갱신할 때가 됐으면 `곧`이라고 말한다', async (t) => {
  const { h, paths } = oauthHome(t, { expiresInMs: 5 * 60 * 1000 });
  const seen = [];
  const net = fakeNet({
    'oauth.v2.access': () => json({ ok: true, access_token: 'xoxe.xoxp-1-CHECK-RENEWED', refresh_token: 'xoxe-1-CHECK-RENEWED-R', expires_in: 43200 }),
    'auth.test': (url, options) => { seen.push(options.headers.Authorization); return json({ ok: true, user: 'hana' }); },
    'conversations.info': () => json({ ok: true, channel: { name: 'hana-todo', is_private: true, created: 1 } }),
  });
  const result = await createSelfcheck(oauthDeps(h, net)).run();
  assert.deepEqual(seen, ['Bearer xoxe.xoxp-1-CHECK-RENEWED'], '한 줄 사본이 아니라 갱신한 토큰으로 묻는다');
  assert.equal(byKey(result, 'slack_token').detail, '자동 갱신 · 다음 갱신 11시간 뒤');
  assert.equal(JSON.parse(fs.readFileSync(paths.oauthFile, 'utf8')).refreshToken, 'xoxe-1-CHECK-RENEWED-R');
  assert.ok(!JSON.stringify(result).includes('RENEWED'));
  // 서버 타이머가 아직 안 돈 사이(만료 40분 전) — 수집 기준(10분)으로는 아직 갱신할 때가 아니다.
  const soon = oauthHome(t, { expiresInMs: 40 * 60 * 1000 });
  const quiet = fakeNet(okRoutes);
  assert.equal(byKey(await createSelfcheck(oauthDeps(soon.h, quiet)).run(), 'slack_token').detail, '자동 갱신 · 다음 갱신 곧');
});

test('점검(슬랙 새 방식): 갱신이 잠시 안 되면 `!`(주의) — 채널은 그대로 확인하고 멈춤으로 세지 않는다', async (t) => {
  const { h } = oauthHome(t, { failure: { kind: 'retry', reason: 'network' } });
  const net = fakeNet(okRoutes);
  const result = await createSelfcheck(oauthDeps(h, net)).run();
  const token = byKey(result, 'slack_token');
  assert.deepEqual({ state: token.state, detail: token.detail }, { state: 'warn', detail: '갱신이 잠시 안 돼요 — 곧 다시 해 봐요' });
  assert.match(token.fix.text, /기다리면 앱이 다시 해 봐요/);
  assert.equal(byKey(result, 'slack_channels').state, 'ok');
  assert.equal(byKey(result, 'slack').state, 'ok');
});

test('점검(슬랙 새 방식): 만료된 뒤에도 갱신이 이어지지 않으면 ✗ `슬랙 연결을 이어 가지 못하고 있어요` + 슬랙 오류 이름 — 죽은 토큰으로 묻지 않는다', async (t) => {
  const { h, paths } = oauthHome(t, { expiresInMs: -60 * 1000 });
  const at = JSON.parse(fs.readFileSync(paths.oauthFile, 'utf8')).savedAt;
  // 이미 두 번 거절당한 상태에서 점검이 한 번 더 갱신을 해 보고(가짜 슬랙이 모르는 오류로 거절) 세 번째가 된다.
  fs.writeFileSync(paths.stateFile, JSON.stringify({ failure: { kind: 'retry', reason: 'slack_error', code: 'some_new_error' }, at: Date.now(), failCount: 2, savedAt: at, rejects: 2, downCount: 2, downSince: Date.now() }));
  const net = fakeNet({ ...okRoutes, 'oauth.v2.access': () => json({ ok: false, error: 'some_new_error' }) });
  const result = await createSelfcheck(oauthDeps(h, net, { alerts: ['slack'] })).run();
  const token = byKey(result, 'slack_token');
  assert.deepEqual({ label: token.label, state: token.state, detail: token.detail }, { label: '슬랙 연결', state: 'bad', detail: '슬랙 연결을 이어 가지 못하고 있어요 (슬랙 오류: some_new_error)' });
  assert.equal(token.fix.text, '설정 › 연동 › 슬랙 카드의 다시 연결을 눌러 주세요 — 안 되면 카드의 고급: 토큰 직접 붙여 넣기로 연결할 수 있어요');
  assert.equal(byKey(result, 'slack_channels').detail, '다시 연결한 뒤 확인할 수 있어요');
  assert.deepEqual({ state: byKey(result, 'slack').state, sameAs: byKey(result, 'slack').sameAs, detail: byKey(result, 'slack').detail },
    { state: 'bad', sameAs: 'slack_token', detail: '연결을 이어 가지 못해 멈췄어요 — 위 슬랙 연결 줄대로 고치면 돼요' });
  assert.equal(net.calls.filter(call => /auth\.test|conversations/.test(call.url)).length, 0, '만료된 토큰으로 슬랙을 두드리지 않는다');
  noOAuthSecrets(result);

  // 닿지 못해서 멈춘 것(네트워크·슬랙 장애)은 다시 연결을 권하지 않는다 — 예전 `슬랙에 닿지 못했어요` 갈래와 같은 쪽 말.
  const off = oauthHome(t, { expiresInMs: -60 * 1000 });
  const offAt = JSON.parse(fs.readFileSync(off.paths.oauthFile, 'utf8')).savedAt;
  fs.writeFileSync(off.paths.stateFile, JSON.stringify({ failure: { kind: 'retry', reason: 'network' }, at: Date.now(), failCount: 6, savedAt: offAt, rejects: 0, downCount: 6, downSince: Date.now() - 31 * 60 * 1000 }));
  const down = fakeNet({ ...okRoutes, 'oauth.v2.access': () => { throw new Error('offline'); } });
  const offResult = await createSelfcheck(oauthDeps(off.h, down, { alerts: ['slack'] })).run();
  const offToken = byKey(offResult, 'slack_token');
  // 바깥 확인이 슬랙 하나뿐이고 그것이 네트워크에서 막혔으니 점검 전체가 예전처럼 `offline`으로 묶인다(다른 연동이 닿으면
  // 이 줄은 ✗ `슬랙에 닿지 못하고 있어요` + 인터넷 확인 안내다). 어느 쪽이든 다시 연결을 권하지 않는다.
  assert.deepEqual({ state: offToken.state, detail: offToken.detail, fix: offToken.fix }, { state: 'offline', detail: '닿지 못했어요', fix: undefined });
  assert.equal(offResult.offline, true);
  assert.doesNotMatch(JSON.stringify(offResult.items.filter(item => item.key.startsWith('slack'))), /다시 연결을 눌러/);
  assert.equal(byKey(offResult, 'slack').detail, '슬랙에 닿지 못해 멈췄어요 — 위 슬랙 연결 줄대로 고치면 돼요');
  assert.equal(byKey(offResult, 'slack_channels').detail, '슬랙에 닿은 뒤 확인할 수 있어요');
  assert.equal(down.calls.filter(call => /auth\.test|conversations/.test(call.url)).length, 0);

  // 아직 기준을 넘지 않은 잠시 안 됨에도 슬랙이 준 오류 이름은 보인다(원인을 알아야 고친다).
  const early = oauthHome(t, { failure: { kind: 'retry', reason: 'slack_error', code: 'some_new_error' } });
  const warn = byKey(await createSelfcheck(oauthDeps(early.h, fakeNet(okRoutes))).run(), 'slack_token');
  assert.deepEqual({ state: warn.state, detail: warn.detail }, { state: 'warn', detail: '갱신이 잠시 안 돼요 — 곧 다시 해 봐요 (슬랙 오류: some_new_error)' });
});

test('점검(슬랙 새 방식): 연결이 풀렸으면 ✗ `연결이 풀렸어요` + 다시 연결 안내 — 슬랙에 묻지 않고, 수집 줄은 같은 원인으로 한 번만 센다', async (t) => {
  for (const setup of [{ failure: { kind: 'reconnect', reason: 'slack_error', code: 'invalid_refresh_token' } }, { noFile: true }]) {
    const { h } = oauthHome(t, setup);
    const net = fakeNet(okRoutes);
    const result = await createSelfcheck(oauthDeps(h, net, { alerts: ['slack'] })).run();
    const token = byKey(result, 'slack_token');
    assert.deepEqual({ label: token.label, state: token.state, detail: token.detail }, { label: '슬랙 연결', state: 'bad', detail: '연결이 풀렸어요' });
    assert.match(token.fix.text, /다시 연결을 누르고 슬랙에서 허용/);
    assert.doesNotMatch(token.fix.text, /xoxp/, '새 방식은 토큰을 찾으라고 하지 않는다');
    assert.equal(byKey(result, 'slack_channels').detail, '다시 연결한 뒤 확인할 수 있어요');
    assert.deepEqual({ state: byKey(result, 'slack').state, sameAs: byKey(result, 'slack').sameAs }, { state: 'bad', sameAs: 'slack_token' });
    assert.equal(byKey(result, 'slack').fix, undefined);
    assert.equal(net.calls.filter(call => call.url.includes('slack.com')).length, 0, '죽은 토큰으로 슬랙을 두드리지 않는다');
    assert.equal(!!byKey(result, 'slack_scopes'), !setup.noFile, '갱신 정보가 없으면 권한 줄도 없다');
    noOAuthSecrets(result);
  }
  // 갱신 기록은 멀쩡한데 슬랙이 토큰을 거절해도 같은 말·같은 고치는 법이다.
  const { h } = oauthHome(t);
  const rejecting = fakeNet({ ...okRoutes, 'auth.test': () => json({ ok: false, error: 'token_revoked' }) });
  const token = byKey(await createSelfcheck(oauthDeps(h, rejecting)).run(), 'slack_token');
  assert.deepEqual({ state: token.state, detail: token.detail }, { state: 'bad', detail: '연결이 풀렸어요' });
});

test('점검(슬랙 새 방식): 받은 권한이 모자라면 빠진 권한 이름을 말한다(!)', async (t) => {
  const { h } = oauthHome(t, { scopes: ['channels:read', 'channels:history', 'users:read'] });
  const result = await createSelfcheck(oauthDeps(h, fakeNet(okRoutes))).run();
  const scopes = byKey(result, 'slack_scopes');
  assert.deepEqual({ state: scopes.state, detail: scopes.detail }, { state: 'warn', detail: '빠진 권한: groups:read, groups:history, groups:write' });
  assert.match(scopes.fix.text, /허용을 한 번 더/);
  assert.equal(byKey(result, 'slack_token').state, 'ok');
});

test('점검(슬랙 옛 방식): 갱신 상태 길이 있어도 줄은 예전 그대로 — 슬랙 토큰 한 줄, 권한 줄 없음', async (t) => {
  const h = home(t, { jira: false, calendar: false });
  const result = await createSelfcheck(depsFor(h, fakeNet(okRoutes), { override: {
    slackOAuth: config => slackAuth.readOAuthStatus({ config, tokenDir: h.tokens }),
  } })).run();
  assert.deepEqual({ label: byKey(result, 'slack_token').label, detail: byKey(result, 'slack_token').detail }, { label: '슬랙 토큰', detail: 'User OAuth Token(xoxp-) · 연결돼요' });
  assert.equal(byKey(result, 'slack_scopes'), undefined);
  assert.deepEqual(fs.readdirSync(h.tokens).sort(), ['workspace-calendar-ical', 'workspace-jira-token', 'workspace-slack-token']);
});

test('서버: 토큰을 다시 받아야 하는 수집 실패 낱말(SLACK_AUTH_RE)에 자동 갱신의 것이 들어 있고, 자동 갱신 타이머는 시험에서 돌지 않는다', () => {
  const re = serverModule.SLACK_AUTH_RE;
  for (const line of ['my-todo 채널 확인 실패 — Slack: token_expired', 'Slack: invalid_refresh_token', 'Slack: invalid_auth', 'Slack: token_revoked',
    'my-todo 채널 확인 실패 — 슬랙 연결이 풀림, 다시 연결 필요(slack_reconnect · no_oauth_file)']) assert.ok(re.test(line), line);
  for (const line of ['my-todo 채널 확인 실패 — Slack: ratelimited', '슬랙 토큰 갱신이 잠시 안 됨(retry · network) — 이전 토큰으로 진행', 'Slack: channel_not_found']) assert.ok(!re.test(line), line);
  // 만료 + 갱신 안 됨으로 건너뛴 회차의 한 줄 — 오류 이름이 최근 기록에 보이고, 멈춤 판정 낱말에는 걸리지 않는다(판정은 갱신 상태 파일).
  const { expiredSkipLine } = require('./slack-collect');
  const failure = { kind: 'retry', reason: 'slack_error', code: 'some_new_error' };
 assert.equal(expiredSkipLine({ kind: 'retry', reason: 'network' }, 'unreachable'), '슬랙에 닿지 못함(retry · network) — 토큰이 만료돼 수집을 건너뜀, 인터넷 연결 확인 필요');
  assert.equal(expiredSkipLine(failure, ''), '슬랙 토큰 갱신이 잠시 안 됨(retry · some_new_error) — 토큰이 만료돼 이번 회차는 건너뛰고 다음 회차에 다시');
  assert.equal(expiredSkipLine(failure, 'rejected'), '슬랙 연결을 이어 가지 못함(retry · some_new_error) — 토큰이 만료돼 수집을 건너뜀, 설정 › 연동에서 다시 연결 필요');
  for (const stalled of ['', 'rejected', 'unreachable']) assert.ok(!re.test(expiredSkipLine(failure, stalled)) && !/채널 확인 실패/.test(expiredSkipLine(failure, stalled)));
  assert.equal(serverModule.slackRefresher.running(), false, '운영(직접 띄운 서버)에서만 켠다');
  assert.equal(serverModule.fetchStateAutomation({ lastKind: 'fail', lastSummary: 'my-todo 채널 확인 실패 — Slack: token_expired', failTimes: [Date.now()] }, re).stuck, true, '한 번이어도 토큰 문제면 멈춤');
});

test('시험 환경: 토큰 폴더는 늘 임시 폴더이고 슬랙 자동 갱신 타이머는 꺼져 있다 — 진짜 서버를 띄우는 시험도 실제 ~/.config에 닿지 않는다', () => {
  const tokens = process.env.WORKSPACE_TOKEN_DIR;
  assert.ok(tokens && tokens.startsWith(automationHome + path.sep), '공용 준비가 토큰 폴더를 임시 폴더로 끼운다');
  assert.ok(!tokens.startsWith(path.join(os.homedir(), '.config')));
  assert.equal(process.env.WORKSPACE_NO_SLACK_REFRESH, '1');
  assert.equal(integrations.tokenPaths().dir, tokens);
  assert.ok(require('./slack-auth').authPaths({ config: { slack: { auth: 'oauth' } } }).lockDir.startsWith(tokens + path.sep), '갱신 잠금도 그 폴더 안');
  const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  assert.match(source, /if \(!process\.env\.WORKSPACE_NO_REMOTE_CHECK && !process\.env\.WORKSPACE_NO_SLACK_REFRESH\) slackRefresher\.start\(\);/);
  // 바깥 확인을 켜고 진짜 서버를 띄우는 시험(업데이트·소식)은 둘 다 직접 준다.
  for (const name of ['server.update.test.js', 'server.news.test.js']) {
    assert.match(fs.readFileSync(path.join(__dirname, name), 'utf8'), /WORKSPACE_NO_REMOTE_CHECK: '', WORKSPACE_NO_SLACK_REFRESH: '1', WORKSPACE_TOKEN_DIR: path\.join\(root, 'tokens'\)/, name);
  }
});

// ---------- 앱 자동화가 쓰는 Claude 계정(run-task.sh와 같은 순서: 앱 토큰 → 이 맥 기본 로그인 → 없음) ----------
const FAKE_CLAUDE_TOKEN = 'sk-ant-oat01-fake-claude-token-value-789';
const FAKE_CLAUDE_EMAIL = 'tester.person@mailhost.example';
const FAKE_ORG = 'Fake Org Name 42';
function claudeHome(t, { token = null, login = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-claude-account-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tokenFile = path.join(root, 'workspace-claude-token');
  const globalConfigFile = path.join(root, '.claude.json');
  if (token !== null) fs.writeFileSync(tokenFile, token);
  if (login) fs.writeFileSync(globalConfigFile, JSON.stringify({ numStartups: 3, oauthAccount: { accountUuid: 'uuid-1', emailAddress: FAKE_CLAUDE_EMAIL, organizationName: FAKE_ORG, displayName: 'Tester' } }));
  return { tokenFile, globalConfigFile };
}

test('Claude 계정 출처: 토큰 파일(공백 빼고 한 글자라도) → 기본 로그인(가린 이메일) → 없음 — 토큰·이메일 원문은 돌려주지 않는다', (t) => {
  const { claudeAccountSource, maskEmail } = integrations;
  assert.deepEqual(claudeAccountSource(claudeHome(t, { token: `${FAKE_CLAUDE_TOKEN}\n` })), { source: 'token' }, '토큰이 있으면 기본 로그인이 있어도 토큰(run-task.sh와 같다)');
  assert.deepEqual(claudeAccountSource(claudeHome(t, { token: '' })), { source: 'default', account: 't***@m***.example' }, '빈 토큰 파일은 없는 것');
  assert.deepEqual(claudeAccountSource(claudeHome(t, { token: ' \n\t ' })), { source: 'default', account: 't***@m***.example' }, '공백뿐인 파일도 없는 것');
  assert.deepEqual(claudeAccountSource(claudeHome(t)), { source: 'default', account: 't***@m***.example' });
  assert.deepEqual(claudeAccountSource(claudeHome(t, { login: false })), { source: 'none' });
  // 기본 설정 파일이 깨졌거나 oauthAccount가 없거나 이메일이 이상하면
  const odd = claudeHome(t, { login: false });
  fs.writeFileSync(odd.globalConfigFile, '{ not json');
  assert.deepEqual(claudeAccountSource(odd), { source: 'none' });
  fs.writeFileSync(odd.globalConfigFile, JSON.stringify({ numStartups: 1 }));
  assert.deepEqual(claudeAccountSource(odd), { source: 'none' }, '로그아웃하면 oauthAccount가 없다');
  fs.writeFileSync(odd.globalConfigFile, JSON.stringify({ oauthAccount: { emailAddress: 'not-an-email' } }));
  assert.deepEqual(claudeAccountSource(odd), { source: 'default' }, '계정을 못 읽으면 출처만');
  assert.deepEqual(claudeAccountSource({}), { source: 'none' }, '자리를 모르면 없음');
  assert.equal(maskEmail('a@b.co.kr'), 'a***@b***.kr');
  assert.equal(maskEmail('하나@회사'), '하***@회***');
  assert.equal(maskEmail(''), '');
  assert.equal(maskEmail('x@'), '');
});

test('점검: `앱 자동화가 쓰는 Claude 계정` 줄 — Claude Code 로그인 줄 바로 뒤, 출처 셋, 문제로 세지 않고, 토큰·이메일·조직 원문이 없다', async (t) => {
  const h = home(t, { slack: true, jira: false, calendar: false });
  const net = fakeNet(okRoutes);
  const run = async (where, extra = {}) => createSelfcheck(depsFor(h, net, { ...extra, override: { claudeAccount: () => integrations.claudeAccountSource(where), ...(extra.override || {}) } })).run();
  const automations = [{ key: 'slack', lastKind: 'run', events: [{ time: '2026-09-28 10:05:00', kind: 'run', text: '완료' }] }];

  const token = await run(claudeHome(t, { token: FAKE_CLAUDE_TOKEN }), { automations });
  const keys = token.items.map(item => item.key);
  assert.equal(keys.indexOf('claudeAccount'), keys.indexOf('claude') + 1, 'Claude Code 로그인 줄 바로 뒤');
  assert.deepEqual(byKey(token, 'claudeAccount'), { key: 'claudeAccount', label: '앱 자동화가 쓰는 Claude 계정', state: 'ok', detail: '앱에 붙여 넣은 토큰 · 토큰만으로는 어느 계정인지 알 수 없어요 · 터미널에서 쓰는 계정과 다를 수 있어요', copy: '앱에 붙여 넣은 토큰' });

  const login = await run(claudeHome(t), { automations });
  assert.deepEqual(byKey(login, 'claudeAccount'), { key: 'claudeAccount', label: '앱 자동화가 쓰는 Claude 계정', state: 'ok', detail: '이 맥의 기본 Claude Code 로그인 (t***@m***.example) · 터미널에서 쓰는 계정과 다를 수 있어요', copy: '이 맥의 기본 Claude Code 로그인' });

  const none = await run(claudeHome(t, { token: '', login: false }), { automations });
  assert.deepEqual([byKey(none, 'claudeAccount').state, byKey(none, 'claudeAccount').copy], ['unknown', '로그인 없음']);
  assert.match(byKey(none, 'claudeAccount').detail, /^로그인 없음 — /);
  assert.ok(!byKey(none, 'claudeAccount').fix, '고치는 법 없이 알리기만');

  // 기존 `Claude Code 로그인` 줄의 판단은 그대로 — 계정 줄은 상태를 바꾸지 않는다(로그인 풀림 ✗도 그대로 한 번만 센다)
  const failing = [{ key: 'slack', lastKind: 'fail', lastSummary: 'OAuth session expired and could not be refreshed', events: [] }];
  const bad = await run(claudeHome(t), { automations: failing });
  assert.equal(byKey(bad, 'claude').state, 'bad');
  assert.equal(byKey(bad, 'claudeAccount').state, 'ok');
  const withoutLine = await createSelfcheck(depsFor(h, net, { automations: failing })).run();
  assert.deepEqual(bad.items.filter(item => item.key !== 'claudeAccount'), withoutLine.items, '계정 줄 말고는 예전과 같다');

  // Claude가 필요한 연동이 없거나 claude가 없으면 줄이 없다(Claude Code 줄과 같은 조건)
  const noClaude = await run(claudeHome(t), { automations, override: { claudeInstalled: () => false } });
  assert.ok(!byKey(noClaude, 'claudeAccount'));
  const rawOnly = home(t, { slack: false, jira: true, calendar: false });
  const plain = await createSelfcheck(depsFor(rawOnly, net, { override: { claudeAccount: () => integrations.claudeAccountSource(claudeHome(t)) } })).run();
  assert.ok(!byKey(plain, 'claudeAccount') && !byKey(plain, 'claude'));

  // 원문이 어디에도 없다
  for (const result of [token, login, none, bad]) {
    const text = JSON.stringify(result);
    for (const secret of [FAKE_CLAUDE_TOKEN, 'fake-claude-token', FAKE_CLAUDE_EMAIL, 'tester.person', 'mailhost', FAKE_ORG, 'uuid-1']) assert.ok(!text.includes(secret), `응답에 ${secret}가 없다`);
  }
});

test('GET /api/selfcheck: 진짜 서버도 임시 자리의 토큰 파일·기본 설정 파일만 읽고, 응답에 원문이 없다', async (t) => {
  const tokenFile = integrations.tokenPaths().claude.file;
  const globalConfigFile = process.env.WORKSPACE_CLAUDE_GLOBAL_CONFIG;
  assert.ok(globalConfigFile && globalConfigFile.startsWith(automationHome + path.sep), '공용 준비가 실제 ~/.claude.json 대신 임시 자리를 끼운다');
  assert.ok(tokenFile.startsWith(automationHome + path.sep));
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  t.after(() => { fs.rmSync(tokenFile, { force: true }); fs.rmSync(globalConfigFile, { force: true }); serverModule.selfcheck.clear(); });
  fs.writeFileSync(globalConfigFile, JSON.stringify({ oauthAccount: { emailAddress: FAKE_CLAUDE_EMAIL, organizationName: FAKE_ORG } }));
  const look = async () => { serverModule.selfcheck.clear(); const body = await (await fetch(`${base}/api/selfcheck`)).json(); return { body, text: JSON.stringify(body), item: body.items.find(one => one.key === 'claudeAccount') }; };
  const first = await look();
  // 설정이 없으면 캘린더(Claude로 읽기)·회의록이 켜진 것으로 읽혀 Claude가 필요하다 — 이 맥에 claude가 있을 때만 줄이 선다.
  if (!integrations.claudeInstalled()) { assert.ok(!first.item); return; }
  assert.equal(first.item.detail, '이 맥의 기본 Claude Code 로그인 (t***@m***.example) · 터미널에서 쓰는 계정과 다를 수 있어요');
  fs.writeFileSync(tokenFile, `${FAKE_CLAUDE_TOKEN}\n`);
  const second = await look();
  assert.equal(second.item.copy, '앱에 붙여 넣은 토큰');
  for (const { text } of [first, second]) for (const secret of [FAKE_CLAUDE_TOKEN, FAKE_CLAUDE_EMAIL, FAKE_ORG]) assert.ok(!text.includes(secret), `응답에 ${secret}가 없다`);
});

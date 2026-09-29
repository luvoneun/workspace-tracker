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
  assert.match(claude.fix.command, /workspace-claude-token/);
  assert.match(claude.fix.text, /claude setup-token/);
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

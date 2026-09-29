// 서버: 슬랙 채널 고르기·백업 상태·자동 등록 값. 공용 준비는 test-support.js.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const support = require('./test-support');
const { automationHome, post, freePort, integrationsStore, integrationsFixture } = support;
let base;
before(async () => { base = await support.ready(); });

// ─────────────────────────────────────────────────────────────────────────────
// WP-E — 설정 합치기(연동이 유일한 상태 자리) · 슬랙 채널 고르기(빼기 = off 표시, 다시 켜기 = 그때부터) · 매일 백업
//
// 여기서도 실제 슬랙·실제 설정·실제 홈 폴더(~/workspace-data-backup·~/.local/share)에는 닿지 않는다: 슬랙은 가짜
// fetch가 전부 가로채고, 스크립트는 임시 HOME·가짜 curl·가짜 run-task.sh·가짜 import-record.js로만 돈다.

test('WP-E 연동 상태: 뺀 채널(off)은 없는 것으로 읽고(연결 수·상태 줄), 이름만 따로 알려 준다', () => {
  const state = integrationsStore.readIntegrations({
    slack: {
      channels: {
        todo: { id: 'C0TODO11', name: '#my-todo' },
        waiting: { id: 'C0WAIT11', name: '#my-waiting', off: true, since: '1790000000.000000' },
        align: { id: 'C0ALIGN1', name: '#my-align' },
      },
    },
  }, { tokenDir: fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-wpe-read-')) });
  assert.deepEqual(state.slack.channels.waiting, { id: '', name: '' }, '뺀 채널은 연결 안 된 칸과 같다');
  assert.deepEqual(state.slack.channels.align, { id: 'C0ALIGN1', name: '#my-align' });
  assert.deepEqual(state.slack.off, { waiting: { name: '#my-waiting' } }, 'id는 싣지 않고 이름만');
  assert.ok(!JSON.stringify(state).includes('since'), 'since는 화면에 나가지 않는다');
});

test('WP-E 채널 고르기 저장: 빼기는 off만 적고(id·이름 유지) 슬랙에 묻지 않으며, 마지막 하나는 뺄 수 없다', async (t) => {
  const fix = integrationsFixture(t, {
    title: '그대로',
    integrations: { slack: true },
    slack: { tokenFile: '/어딘가/토큰', channels: { todo: { id: 'C0TODO11', name: '#my-todo' }, waiting: { id: 'C0WAIT11', name: '#my-waiting' } } },
  });
  let asked = 0;
  const slackCheck = async () => { asked += 1; return { name: 'x', isPrivate: true }; };
  const save = body => integrationsStore.saveIntegrations({ configPath: fix.configPath, current: fix.read(), tokenDir: fix.tokenDir, body, slackCheck });
  await save({ slack: { enabled: true, token: '', channels: {}, off: ['waiting'], on: [] } });
  assert.equal(asked, 0, '빼기만 하는 저장은 슬랙에 묻지 않는다(토큰도 필요 없다)');
  const saved = fix.read();
  assert.deepEqual(saved.slack.channels.waiting, { id: 'C0WAIT11', name: '#my-waiting', off: true }, '지우지 않고 off 표시만');
  assert.deepEqual(saved.slack.channels.todo, { id: 'C0TODO11', name: '#my-todo' });
  assert.equal(saved.slack.tokenFile, '/어딘가/토큰', '토큰 경로는 건드리지 않는다');
  assert.equal(saved.title, '그대로');

  const before = fs.readFileSync(fix.configPath, 'utf8');
  // 기다리는 것은 이미 뺐다 — 남은 할 일이 마지막 하나라 뺄 수 없다
  await assert.rejects(() => save({ slack: { enabled: true, token: '', off: ['todo'] } }), /^Error: 마지막 채널은 뺄 수 없어요 — 슬랙 수집을 끄려면 ⋯ › 해제$/);
  await assert.rejects(() => save({ slack: { enabled: true, token: '', off: ['todo', 'waiting'] } }), /마지막 채널은 뺄 수 없어요/);
  await assert.rejects(() => save({ slack: { enabled: true, token: '', off: ['아무거나'] } }), /보낸 값을 확인해 주세요/);
  assert.equal(fs.readFileSync(fix.configPath, 'utf8'), before, '거절하면 한 글자도 바뀌지 않는다');
  assert.equal(asked, 0);

  // 다른 채널이 켜져 있으면 할 일도 뺄 수 있다(할 일 특별 취급 없음)
  const other = integrationsFixture(t, {
    integrations: { slack: true },
    slack: { channels: { todo: { id: 'C0TODO11', name: '#my-todo' }, waiting: { id: 'C0WAIT11', name: '#my-waiting' } } },
  });
  await integrationsStore.saveIntegrations({ configPath: other.configPath, current: other.read(), tokenDir: other.tokenDir,
    body: { slack: { enabled: true, token: '', channels: {}, off: ['todo'], on: [] } }, slackCheck });
  assert.deepEqual(other.read().slack.channels.todo, { id: 'C0TODO11', name: '#my-todo', off: true });
  assert.deepEqual(other.read().slack.channels.waiting, { id: 'C0WAIT11', name: '#my-waiting' });
  assert.equal(asked, 0);
});

test('WP-E 채널 고르기 저장: 뺐던 채널을 다시 켜면 같은 id로(새로 만들지 않고) 지금부터 읽고, 사라졌으면 channel_gone으로 거절한다', async (t) => {
  const fix = integrationsFixture(t, {
    slack: { channels: {
      todo: { id: 'C0TODO11', name: '#my-todo' },
      align: { id: 'C0ALIGN1', name: '#my-align', off: true },
      someday: { id: 'C0GONE11', name: '#my-someday', off: true },
    } },
  });
  fs.mkdirSync(fix.tokenDir, { recursive: true });
  fs.writeFileSync(path.join(fix.tokenDir, 'workspace-slack-token'), 'xoxp-saved\n', { mode: 0o600 });
  const asked = [];
  const slackCheck = async (token, id) => {
    asked.push([token, id]);
    if (id === 'C0GONE11') throw Object.assign(new Error('슬랙에서 이 채널을 읽지 못했어요'), { status: 400 });
    return { name: 'my-align-renamed', isPrivate: true, created: 1700000000 };
  };
  const save = body => integrationsStore.saveIntegrations({
    configPath: fix.configPath, current: fix.read(), tokenDir: fix.tokenDir, body, slackCheck, now: () => 1790000123456,
  });
  const { result } = await save({ slack: { enabled: true, token: '', channels: {}, off: [], on: ['align'] } });
  assert.deepEqual(asked, [['xoxp-saved', 'C0ALIGN1']], '저장된 id로 읽어 보기만 한다(만들지 않는다)');
  assert.deepEqual(fix.read().slack.channels.align, { id: 'C0ALIGN1', name: '#my-align-renamed', since: '1790000123.456000' },
    'off를 지우고 다시 켠 때부터 읽는다(만든 때가 아니다 — 뺀 동안 온 메시지는 가져오지 않는다)');
  assert.equal(result.slack.channels.align.reconnected, true);

  const before = fs.readFileSync(fix.configPath, 'utf8');
  await assert.rejects(() => save({ slack: { enabled: true, token: '', on: ['someday'] } }),
    error => error.code === 'channel_gone' && error.key === 'someday' && /#my-someday 채널을 찾을 수 없어요/.test(error.message));
  assert.equal(fs.readFileSync(fix.configPath, 'utf8'), before, '사라진 채널을 켜려 하면 아무것도 쓰지 않는다');
  // 보관된 채널도 사라진 것과 같다
  const archived = integrationsStore.saveIntegrations({
    configPath: fix.configPath, current: { slack: { channels: { todo: { id: 'C0TODO11' }, align: { id: 'C0ALIGN1', off: true } } } },
    tokenDir: fix.tokenDir, body: { slack: { enabled: true, token: '', on: ['align'] } },
    slackCheck: async () => ({ name: 'my-align', archived: true }),
  });
  await assert.rejects(() => archived, error => error.code === 'channel_gone');
  // 슬랙에 닿지 못한 것은 사라진 것이 아니다 — slack_unreachable(그 칸과 함께)로 거절하고 아무것도 쓰지 않는다
  const offlineBefore = fs.readFileSync(fix.configPath, 'utf8');
  await assert.rejects(() => integrationsStore.saveIntegrations({
    configPath: fix.configPath, current: fix.read(), tokenDir: fix.tokenDir, body: { slack: { enabled: true, token: '', on: ['someday'] } },
    slackCheck: async () => { throw Object.assign(new Error('x'), { status: 400, code: 'slack_unreachable' }); },
  }), error => error.code === 'slack_unreachable' && error.key === 'someday' && error.message === '슬랙에 연결하지 못했어요 — 잠시 뒤 다시 눌러 주세요');
  assert.equal(fs.readFileSync(fix.configPath, 'utf8'), offlineBefore);

  // 사라진 뺀 채널을 다시 체크하면 화면은 새로 만든다 — 새 id는 channels로 오고, off는 지워지고 만든 때부터 읽는다
  await integrationsStore.saveIntegrations({
    configPath: fix.configPath, current: fix.read(), tokenDir: fix.tokenDir,
    body: { slack: { enabled: true, token: '', channels: { someday: 'C0NEWSOM1' } } },
    slackCheck: async () => ({ name: 'hana-someday', isPrivate: true, created: 1790000200 }), now: () => 1790000300000,
  });
  assert.deepEqual(fix.read().slack.channels.someday, { id: 'C0NEWSOM1', name: '#hana-someday', since: '1790000200.000000' });
});

test('WP-E 기본 채널 이름: 슬랙 사용자 이름을 채널 이름 규칙으로 다듬고, 없거나 비면 my', () => {
  const prefix = integrationsStore.slackChannelPrefix;
  assert.equal(prefix('hana'), 'hana');
  assert.equal(prefix('Hana.Kim'), 'hana-kim', '점·띄어쓰기는 -');
  assert.equal(prefix('  Hana  Kim  '), 'hana-kim');
  assert.equal(prefix('하나'), 'my', '쓸 수 없는 글자만이면 my');
  assert.equal(prefix(''), 'my');
  assert.equal(prefix(undefined), 'my');
  assert.equal(prefix('--a__b--'), 'a__b', '앞뒤의 -·_는 뗀다');
  const long = prefix('a'.repeat(200));
  assert.ok(`${long}-someday`.length <= 80, '가장 긴 뒷머리를 붙여도 80자 이하');
  assert.match(integrationsStore.slackTsNow(() => 1790000000001), /^1790000000\.001000$/);
});

test('WP-E 라우트: 빼기 저장은 슬랙에 한 번도 묻지 않고, 다시 켜기는 conversations.info만(만들기 없음), 할 일 채널이 사라지면 빨간 점(alerts)에 센다', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-wpe-route-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const data = path.join(home, 'tracker');
  fs.mkdirSync(data);
  const tokens = path.join(home, 'tokens');
  fs.mkdirSync(tokens);
  fs.writeFileSync(path.join(tokens, 'workspace-slack-token'), 'xoxp-saved\n', { mode: 0o600 });
  const config = path.join(home, 'workspace.config.json');
  const calls = path.join(home, 'slack-calls.log');
  fs.writeFileSync(config, JSON.stringify({
    integrations: { slack: true, calendar: false, jira: false, tiro: false },
    slack: { tokenFile: path.join(tokens, 'workspace-slack-token'), channels: {
      todo: { id: 'C0TODO11', name: '#my-todo' },
      waiting: { id: 'C0WAIT11', name: '#my-waiting' },
      align: { id: 'C0ALIGN1', name: '#my-align', off: true },
      someday: { id: 'C0GONE11', name: '#my-someday', off: true },
    } },
  }, null, 2));
  const wrapper = path.join(home, 'fake-slack-server.js');
  fs.writeFileSync(wrapper, `'use strict';
const fs = require('node:fs');
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input && input.url ? input.url : input);
  if (!url.startsWith('https://slack.com/api/')) return realFetch(input, init);
  const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const method = url.split('/api/')[1].split('?')[0];
  const id = new URL(url).searchParams.get('channel') || '';
  fs.appendFileSync(${JSON.stringify(calls)}, method + ' ' + id + '\\n');
  if (method === 'auth.test') return json({ ok: true, user: 'Hana.Kim' });
  if (method === 'conversations.info') {
    if (id === 'C0GONE11') return json({ ok: false, error: 'channel_not_found' });
    return json({ ok: true, channel: { id, name: { C0TODO11: 'my-todo', C0WAIT11: 'my-waiting', C0ALIGN1: 'my-align' }[id] || 'x', is_private: true } });
  }
  return json({ ok: false, error: 'unexpected_' + method });
};
const { server } = require(${JSON.stringify(path.join(__dirname, 'server.js'))});
server.listen(Number(process.env.WORKSPACE_PORT), '127.0.0.1', () => console.log('ready'));
`);
  // 켠 연동 자동 등록(launchd apply)이 있는 설치 — plist는 있는지만 본다
  const agents = path.join(home, 'agents');
  fs.mkdirSync(agents);
  fs.writeFileSync(path.join(agents, 'com.workspace.app.apply.plist'), '<plist/>');
  const port = await freePort();
  const child = spawn(process.execPath, [wrapper], {
    env: {
      ...process.env, WORKSPACE_PORT: String(port), WORKSPACE_NO_OPEN: '1', WORKSPACE_HOST: '', WORKSPACE_NO_REMOTE_CHECK: '1',
      WORKSPACE_SLACK_FOLLOW: '1', WORKSPACE_DATA_DIR: data, WORKSPACE_CONFIG: config, WORKSPACE_TOKEN_DIR: tokens,
      WORKSPACE_AUTOMATION_DIR: path.join(home, 'automation'), WORKSPACE_BACKUP_DIR: path.join(home, 'backup'),
      WORKSPACE_LAUNCH_AGENTS_DIR: agents,
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
  const channels = () => JSON.parse(fs.readFileSync(config, 'utf8')).slack.channels;
  const applyRequest = path.join(home, 'automation', 'requests', 'apply.request');
  const takeApply = () => { const text = fs.existsSync(applyRequest) ? fs.readFileSync(applyRequest, 'utf8') : null; fs.rmSync(applyRequest, { force: true }); return text; };

  // 지금 상태 — 뺀 채널은 없는 칸, 이름·사라짐만 off로
  const state = await (await fetch(origin + '/api/integrations')).json();
  assert.equal(state.slack.channels.align.id, '');
  assert.deepEqual(state.slack.off, { align: { name: '#my-align' }, someday: { name: '#my-someday', missing: true } });
  assert.equal(state.slack.channels.someday.missing, undefined, '뺀 채널의 사라짐은 연결된 칸에 붙이지 않는다');
  assert.deepEqual(state.alerts, [], '할 일 채널이 있으면 멈춘 것이 아니다');
  assert.ok(Array.isArray(state.slack.log) && Array.isArray(state.jira.log), '카드 최근 기록 자리');

  // 새 채널 이름의 앞머리 — 토큰 칸 없이(저장된 토큰)
  const prefix = await (await post('/api/integrations/slack-token-check', { token: '' })).json();
  assert.deepEqual(prefix, { ok: true, prefix: 'hana-kim' });

  // 빼기 — 슬랙 호출 0번
  const count = slackLog().length;
  const off = await (await post('/api/integrations/save', { slack: { enabled: true, token: '', channels: {}, off: ['waiting'], on: [] } })).json();
  assert.equal(off.ok, true);
  assert.equal(slackLog().length, count, '빼기 저장은 슬랙에 한 번도 묻지 않는다(보관·삭제·나가기 없음)');
  assert.deepEqual(channels().waiting, { id: 'C0WAIT11', name: '#my-waiting', off: true });
  // 슬랙 채널(off 포함)이 바뀌었다 — 켠 연동 자동 등록 요청 파일 한 줄(서버는 프로세스를 띄우지 않는다)
  assert.equal(off.apply, 'requested');
  assert.match(takeApply(), /^\{"action":"apply","requestedAt":"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"\}\n$/);
  // 등록과 무관한 저장(회의록 갈래가 그대로 꺼짐)은 요청 파일을 쓰지 않는다
  const notes = await (await post('/api/integrations/save', { meetingNotes: { mode: 'other', name: '노션' } })).json();
  assert.equal(notes.ok, true);
  assert.equal(notes.apply, undefined);
  assert.equal(takeApply(), null);

  // 다시 켜기 — conversations.info 하나, 만들기 없음
  const on = await (await post('/api/integrations/save', { slack: { enabled: true, token: '', channels: {}, off: [], on: ['align'] } })).json();
  assert.equal(on.ok, true);
  assert.deepEqual(slackLog().slice(count), ['conversations.info C0ALIGN1']);
  assert.equal(channels().align.id, 'C0ALIGN1', '같은 채널');
  assert.equal(channels().align.off, undefined);
  const since = Number(channels().align.since);
  assert.ok(Math.abs(since * 1000 - Date.now()) < 60000, '다시 켠 때부터 읽는다');
  const gone = await post('/api/integrations/save', { slack: { enabled: true, token: '', on: ['someday'] } });
  assert.equal(gone.status, 400);
  const goneBody = await gone.json();
  assert.equal(goneBody.code, 'channel_gone');
  assert.equal(goneBody.key, 'someday');
  // 다시 켜기(align)는 등록 값이 바뀐 저장, 실패한 저장(someday)은 요청 파일을 쓰지 않는다
  assert.equal(on.apply, 'requested');
  fs.rmSync(applyRequest, { force: true });
  const failed = await post('/api/integrations/save', { slack: { enabled: true, token: '', on: ['someday'] } });
  assert.equal(failed.status, 400);
  assert.equal(takeApply(), null, '실패한 저장은 요청하지 않는다');
  assert.ok(!slackLog().some(line => /^conversations\.(create|archive|leave|kick)|^channels\./.test(line)), '슬랙 쓰기 API는 한 번도 부르지 않았다');
  assert.ok(!JSON.stringify(state).includes('xoxp-') && !JSON.stringify(goneBody).includes('xoxp-'), '토큰은 응답에 없다');

  // 할 일 채널만 사라지면(정해진 것은 살아 있다) 일부라 멈춘 것이 아니다 — 카드의 주황 줄일 뿐
  const moved = JSON.parse(fs.readFileSync(config, 'utf8'));
  moved.slack.channels.todo = { id: 'C0GONE11', name: '#my-todo' };
  fs.writeFileSync(config, JSON.stringify(moved, null, 2));
  const partly = await (await fetch(origin + '/api/integrations')).json();
  assert.equal(partly.slack.channels.todo.missing, true);
  assert.deepEqual(partly.alerts, [], '일부만 사라지면 빨간 점이 아니다');
  // 켜진 채널이 모두 사라지면 — 연동 탭을 열 때(이름 따라가기) 알게 되고, 톱니바퀴 빨간 점의 근거(alerts)에 센다
  moved.slack.channels.align = { id: 'C0GONE11', name: '#my-align' };
  fs.writeFileSync(config, JSON.stringify(moved, null, 2));
  const broken = await (await fetch(origin + '/api/integrations')).json();
  assert.equal(broken.slack.channels.todo.missing, true);
  assert.equal(broken.slack.channels.align.missing, true);
  assert.deepEqual(broken.alerts, ['slack']);
  const status = await (await fetch(origin + '/api/automation/status')).json();
  assert.deepEqual(status.alerts, ['slack'], '빨간 점도 같은 판단(슬랙에 다시 묻지 않고 들고 있는 답만 본다)');

  // 켠 연동 자동 등록이 마지막에 실패했으면 launchd에 기대는 카드(슬랙)의 최근 기록 맨 위에 한 줄 — 다음에 성공하면 거둔다
  const applyLog = path.join(home, 'automation', 'logs', 'apply.log');
  fs.mkdirSync(path.dirname(applyLog), { recursive: true });
  fs.writeFileSync(applyLog, '2099-01-01 09:00:00 자동화 등록 실패 — 업데이트.command를 한 번 실행해 주세요\n');
  const withFail = await (await fetch(origin + '/api/integrations')).json();
  assert.deepEqual(withFail.slack.log[0], { time: '2099-01-01 09:00:00', kind: 'fail', text: '자동화 등록 실패 — 업데이트.command를 한 번 실행해 주세요' });
  assert.ok(!withFail.jira.log.some(one => /자동화 등록/.test(one.text)), '앱이 직접 읽는 지라에는 싣지 않는다');
  fs.appendFileSync(applyLog, '2099-01-01 09:05:00 자동화 등록 완료\n');
  const fixed = await (await fetch(origin + '/api/integrations')).json();
  assert.ok(!fixed.slack.log.some(one => /자동화 등록/.test(one.text)));
});

test('WP-E 앱 탭 백업 상태(GET /api/backup): 처음 · 로컬만 · GitHub 포함 · 실패 — 로그와 날짜 폴더만 읽는다', async () => {
  const logs = path.join(automationHome, 'logs');
  const logFile = path.join(logs, 'data-backup.log');
  const root = process.env.WORKSPACE_BACKUP_DIR;
  const gitDir = path.join(automationHome, 'data-backup.git');
  fs.mkdirSync(logs, { recursive: true });
  const backup = async () => (await fetch(base + '/api/backup')).json();
  try {
    const never = await backup();
    assert.equal(never.ok, true);
    assert.deepEqual(never.local, { state: 'never', at: null, reason: null, days: 0 });
    assert.deepEqual(never.github, { on: false, state: 'never', at: null, reason: null });
    assert.match(never.path, /workspace-data-backup\/daily$/);

    for (const day of ['2026-09-18', '2026-09-19', '2026-09-20']) fs.mkdirSync(path.join(root, 'daily', day), { recursive: true });
    fs.mkdirSync(path.join(root, 'daily', '.tmp-2026-09-21-1'), { recursive: true });
    fs.mkdirSync(path.join(root, 'daily', '메모'), { recursive: true });
    fs.mkdirSync(path.join(root, '2026-09-20-1930'), { recursive: true });
    fs.writeFileSync(logFile, [
      '2026-09-19 19:30:02 로컬 실패 — 파일을 복사하지 못함 (tasks.md)',
      '2026-09-19 19:30:03 GitHub 건너뜀 — 백업 저장 공간을 만들지 않음',
      '{"ok":true}2026-09-20 19:30:04 로컬 성공 · 3일치',
      '2026-09-20 19:30:05 GitHub 건너뜀 — 백업 저장 공간을 만들지 않음',
      '',
    ].join('\n'));
    const local = await backup();
    assert.deepEqual(local.local, { state: 'ok', at: '2026-09-20 19:30:04', reason: null, days: 3 }, '정확히 날짜 이름인 폴더만 센다(임시·다른 이름·업데이트 백업은 빼고)');
    assert.equal(local.github.on, false, 'GitHub 저장 공간이 없으면 둘째 줄은 없다');

    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'config'), '[core]\n\tbare = true\n[remote "origin"]\n\turl = git@github.com:someone/data.git\n');
    fs.appendFileSync(logFile, '2026-09-21 19:30:04 로컬 성공 · 3일치\n2026-09-21 19:30:09 GitHub 성공\n');
    const both = await backup();
    assert.deepEqual(both.github, { on: true, state: 'ok', at: '2026-09-21 19:30:09', reason: null });
    assert.ok(!JSON.stringify(both).includes('github.com'), '원격 주소는 싣지 않는다');

    fs.appendFileSync(logFile, '2026-09-22 19:30:01 로컬 실패 — 백업 폴더를 만들지 못함 (/x)\n2026-09-22 19:30:03 GitHub 실패 — 원격 업로드 실패 (이 맥의 백업 커밋은 남아 있음)\n');
    const failed = await backup();
    assert.deepEqual(failed.local, { state: 'fail', at: '2026-09-22 19:30:01', reason: '백업 폴더를 만들지 못함 (/x)', days: 3 });
    assert.equal(failed.github.state, 'fail');
    assert.equal(failed.github.reason, '원격 업로드 실패 (이 맥의 백업 커밋은 남아 있음)');

    // 예전(GitHub만 하던) 로그도 읽는다
    fs.writeFileSync(logFile, '2026-09-10 19:30:04 백업 커밋 완료\n2026-09-10 19:30:06 원격 업로드 완료\n');
    const legacy = await backup();
    assert.equal(legacy.github.state, 'ok');
    assert.equal(legacy.local.state, 'ok', '날짜 폴더가 있으면 로그가 없어도 백업은 있는 것');
  } finally {
    fs.rmSync(logFile, { force: true });
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(gitDir, { recursive: true, force: true });
  }
});

test('QA2 슬랙 채널 확인: 닿지 못한 것(slack_unreachable)과 사라진 것(channel_not_found)을 구분한다', async () => {
  const unreachable = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(() => integrationsStore.slackCheckChannel('t', 'C0X', unreachable), error => error.code === 'slack_unreachable');
  const gone = async () => new Response(JSON.stringify({ ok: false, error: 'channel_not_found' }));
  await assert.rejects(() => integrationsStore.slackCheckChannel('t', 'C0X', gone), error => error.code === 'channel_not_found');
});

// ---------- WP-F 켠 연동 자동 등록 · 슬랙 할 일 채널 선택 ----------

test('WP-F 연동 저장: 할 일 없이 다른 채널 하나로 연결할 수 있고, 하나도 없으면 거절한다', async (t) => {
  const fix = integrationsFixture(t, {});
  const slackCheck = async (token, id) => ({ name: id === 'C0WAIT11' ? 'hana-waiting' : 'x', isPrivate: true, created: 1790000000 });
  const save = body => integrationsStore.saveIntegrations({ configPath: fix.configPath, current: fix.read(), tokenDir: fix.tokenDir, body, slackCheck, now: () => 1790000060000 });
  const before = fs.readFileSync(fix.configPath, 'utf8');
  await assert.rejects(() => save({ slack: { enabled: true, token: 'xoxp-new', channels: {} } }), /슬랙 채널 링크나 ID를 붙여 넣어 주세요/);
  assert.equal(fs.readFileSync(fix.configPath, 'utf8'), before, '채널이 하나도 없으면 아무것도 쓰지 않는다');
  await save({ slack: { enabled: true, token: 'xoxp-new', channels: { waiting: 'C0WAIT11' } } });
  const saved = fix.read();
  assert.equal(saved.integrations.slack, true);
  assert.deepEqual(saved.slack.channels.waiting, { id: 'C0WAIT11', name: '#hana-waiting', since: '1790000000.000000' });
  assert.equal(saved.slack.channels.todo, undefined, '할 일 칸은 만들지 않는다');
  // 다시 연결(토큰만 바꾸기)도 할 일 없이 된다 — 저장된 켜진 채널로 충분하다
  await save({ slack: { enabled: true, token: 'xoxp-newer', channels: {} } });
  assert.equal(fix.read().slack.channels.waiting.id, 'C0WAIT11');
});

test('WP-F 등록 값(registrationKey): 켬/끔·캘린더 갈래·슬랙 채널(off 포함)만 보고 제목·이름·회의록 앱 이름은 보지 않는다', () => {
  const key = integrationsStore.registrationKey;
  const base = {
    title: 'A', integrations: { slack: true, calendar: true, jira: false, tiro: false },
    calendar: { source: 'claude' }, meetingNotes: 'manual',
    slack: { channels: { todo: { id: 'C1', name: '#a' }, waiting: { id: 'C2', name: '#b' } } },
  };
  const same = next => key(base) === key(next);
  assert.ok(same({ ...base, title: 'B' }), '제목');
  assert.ok(same({ ...base, meetingNotes: { other: '노션' } }), '회의록이 그대로 꺼져 있으면 무관');
  assert.ok(same({ ...base, slack: { channels: { todo: { id: 'C1', name: '#renamed' }, waiting: { id: 'C2', name: '#b' } } } }), '채널 이름만 바뀜');
  assert.ok(!same({ ...base, integrations: { ...base.integrations, tiro: true } }), '회의록(티로) 켬');
  assert.ok(!same({ ...base, integrations: { ...base.integrations, slack: false } }), '슬랙 끔');
  assert.ok(!same({ ...base, calendar: { source: 'ical' } }), '캘린더 갈래');
  assert.ok(!same({ ...base, slack: { channels: { ...base.slack.channels, waiting: { id: 'C2', name: '#b', off: true } } } }), '채널 빼기');
  assert.ok(!same({ ...base, slack: { channels: { ...base.slack.channels, align: { id: 'C3' } } } }), '채널 더하기');
});

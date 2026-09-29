// 캘린더 `맥 캘린더` 갈래(WP-V) — calendar-mac.js(고르기·일정 뽑기·실행 스크립트·osascript 부르기)와 mac-calendar.sh.
//
// **실제 맥 캘린더는 절대 읽지 않는다**: osascript 자리는 가짜 함수(osa)나 가짜 실행 파일(WORKSPACE_OSASCRIPT)이고,
// 설정·데이터·자동화 폴더·HOME은 전부 임시 폴더다. 캘린더 이름·일정은 아래에 지어 둔 예시뿐이다.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const mac = require('./calendar-mac');

const ZONE = 'Asia/Seoul';
// 2026-09-29(화) 10:00 KST
const NOW = Date.UTC(2026, 8, 29, 1, 0, 0);
const kst = (d, h, mi = 0) => Date.UTC(2026, 8, d, h - 9, mi, 0);
const REPO_ROOT = path.join(__dirname, '..', '..');

const CALENDARS = [
  { id: 'CAL-HOLIDAY', name: '대한민국의 휴일', writable: false },
  { id: 'CAL-OTHER', name: 'colleague@example.test', writable: false },
  { id: 'CAL-ME', name: 'me@example.test', writable: true },
  { id: 'CAL-LOCAL', name: '캘린더', writable: true },
];

function tempHome(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-mac-calendar-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dirs = { root, data: path.join(root, 'tracker'), automation: path.join(root, 'automation'), config: path.join(root, 'workspace.config.json') };
  fs.mkdirSync(dirs.data, { recursive: true });
  fs.mkdirSync(path.join(dirs.automation, 'requests'), { recursive: true });
  dirs.env = {
    HOME: root, WORKSPACE_CONFIG: dirs.config, WORKSPACE_DATA_DIR: dirs.data,
    WORKSPACE_AUTOMATION_DIR: dirs.automation, AUTOMATION_LOG_DIR: path.join(dirs.automation, 'logs'),
    WORKSPACE_OSASCRIPT: path.join(root, 'no-osascript-here'),
  };
  dirs.writeConfig = value => fs.writeFileSync(dirs.config, JSON.stringify(value));
  dirs.log = () => { try { return fs.readFileSync(path.join(dirs.automation, 'logs', 'mac-calendar.log'), 'utf8'); } catch { return ''; } };
  dirs.state = () => JSON.parse(fs.readFileSync(path.join(dirs.automation, 'mac-calendar.json'), 'utf8'));
  dirs.snapshot = () => { try { return fs.readFileSync(path.join(dirs.data, 'calendar_today.md'), 'utf8'); } catch { return null; } };
  return dirs;
}

// 가짜 osascript(함수) — 부른 요청을 적어 두고, 목록·읽기에 정해 둔 답을 준다.
function fakeOsa({ list = { ok: true, calendars: CALENDARS }, read = null } = {}) {
  const calls = [];
  const osa = async (input, ms) => {
    calls.push({ input, ms });
    if (input.mode === 'list') return list;
    return read || { ok: true, calendars: CALENDARS, events: [], failed: [] };
  };
  return { osa, calls };
}

const localDay = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

test('WP-V 고르기: 기본은 내 이메일 이름의 캘린더 하나(없으면 메일 이름의 쓰기 가능한 첫 캘린더) — 휴일·다른 사람 캘린더는 기본 꺼짐', () => {
  assert.deepEqual(mac.suggestCalendars(CALENDARS, 'ME@example.test'), ['CAL-ME'], '내 이메일과 같은 이름(대소문자 무시)');
  assert.deepEqual(mac.suggestCalendars(CALENDARS, ''), ['CAL-ME'], '메일 이름 중 쓰기 가능한 첫 캘린더 — 읽기 전용 다른 사람 캘린더는 건너뛴다');
  assert.deepEqual(mac.suggestCalendars([{ id: 'A', name: '대한민국의 휴일', writable: false }, { id: 'B', name: '캘린더' }], ''), [], '구글 캘린더가 없으면 고르지 않는다');
  // 캘린더 계정의 기본 캘린더(이름 = 계정 = 메일)를 먼저 믿고, 지라 메일은 그런 캘린더가 여럿일 때만 고르는 데 쓴다(Codex 검토).
  const twoAccounts = [
    { id: 'SHARED', name: 'team@corp.test', account: 'me@corp.test', writable: true },
    { id: 'WORK', name: 'me@corp.test', account: 'me@corp.test', writable: true },
    { id: 'HOME', name: 'me@home.test', account: 'me@home.test', writable: true },
  ];
  assert.deepEqual(mac.suggestCalendars(twoAccounts, 'me@home.test'), ['HOME'], '계정 기본 캘린더가 여럿이면 지라 메일과 같은 쪽');
  assert.deepEqual(mac.suggestCalendars(twoAccounts, 'other@jira.test'), ['WORK'], '지라 메일이 달라도 남의 공유 캘린더가 아니라 계정 기본 캘린더');
  assert.equal(mac.hasAccount(CALENDARS), true);
  assert.equal(mac.hasAccount([{ id: 'B', name: '캘린더' }]), false);
  // EventKit의 계정 이름(source.title) — 이름이 계정 메일과 같은 캘린더가 내 기본 캘린더다
  const withAccount = [
    { id: 'X', name: 'colleague@example.test', writable: true, account: 'me@example.test' },
    { id: 'Y', name: 'me@example.test', writable: true, account: 'me@example.test' },
  ];
  assert.deepEqual(mac.suggestCalendars(withAccount, ''), ['Y']);
  assert.equal(mac.hasAccount([{ id: 'B', name: '업무', account: 'me@example.test' }]), true, '계정 이름이 메일이면 계정이 있다');
  // ID로 따라간다(이름이 바뀌어도), ID가 사라졌으면 같은 이름이 하나뿐일 때만 이름으로, 아니면 못 찾음
  assert.deepEqual(mac.resolveChosen(CALENDARS, [{ id: 'CAL-ME', name: '옛 이름' }]), { ids: ['CAL-ME'], missing: [] });
  assert.deepEqual(mac.resolveChosen(CALENDARS, [{ id: 'GONE', name: 'me@example.test' }]), { ids: ['CAL-ME'], missing: [] });
  assert.deepEqual(mac.resolveChosen(CALENDARS, [{ id: 'GONE', name: '없는 캘린더' }, { id: 'CAL-LOCAL', name: '캘린더' }]), { ids: ['CAL-LOCAL'], missing: ['없는 캘린더'] });
});

test('WP-V 일정 뽑기: EventKit이 펼쳐 준 회차 중 오늘 시작하는 것만 — 종일·취소(상태 3)·내가 거절한 것 제외, 같은 회차 중복은 하나', () => {
  const rows = [
    { id: 'E1', externalId: 'one@google.com', title: '기획 리뷰 | 1차', start: kst(29, 14), end: kst(29, 15), allDay: false, status: 1, recurring: false },
    { id: 'E2', externalId: 'allday@google.com', title: '창립기념일', start: kst(29, 0), end: kst(30, 0), allDay: true, status: 0, recurring: false },
    { id: 'E3', externalId: 'cancel@google.com', title: '취소된 회의', start: kst(29, 11), end: kst(29, 12), allDay: false, status: 3, recurring: false },
    { id: 'E4', externalId: 'declined@google.com', title: '거절한 초대', start: kst(29, 16), end: kst(29, 17), allDay: false, status: 1, recurring: false, declined: true },
    // 반복 일정의 오늘 회차(EventKit이 펼쳐 준다) — 구글 id 꼴에 회차 시각을 붙인다
    { id: 'E5', externalId: 'weekly@google.com', title: '주간 회의', start: kst(29, 9, 30), end: kst(29, 10), allDay: false, status: 0, recurring: true },
    { id: 'E5', externalId: 'weekly@google.com', title: '주간 회의', start: kst(29, 9, 30), end: kst(29, 10), allDay: false, status: 0, recurring: true },
    // 어제 시작해 오늘로 넘어온 일정은 오늘 미팅이 아니다(비밀 주소 갈래와 같은 규칙), 자정을 넘기는 오늘 일정은 23:59
    { id: 'E6', externalId: 'late@google.com', title: '어제 밤 회의', start: kst(28, 23), end: kst(29, 1), allDay: false, status: 0, recurring: false },
    { id: 'E7', externalId: 'night@google.com', title: '밤샘 점검', start: kst(29, 23), end: kst(30, 1), allDay: false, status: 0, recurring: false },
  ];
  const events = mac.todayFromRows(rows, { now: NOW, timeZone: ZONE });
  assert.deepEqual(events.map(one => `${one.start}-${one.end} ${one.title}`), [
    '09:30-10:00 주간 회의',
    '14:00-15:00 기획 리뷰 / 1차',
    '23:00-23:59 밤샘 점검',
  ]);
  assert.equal(events[1].externalId, 'one', '구글 일정 id 꼴(비밀 주소 갈래와 같다)');
  assert.equal(events[0].externalId, 'weekly_20260929T003000Z', '반복 회차는 회차 시각을 붙인다');
  const text = mac.snapshotText(events, '2026-09-29');
  assert.equal(text, '# 오늘 캘린더 일정\n\n마지막 갱신: 2026-09-29\n\n- 09:30-10:00 | 주간 회의 | id:weekly_20260929T003000Z\n- 14:00-15:00 | 기획 리뷰 / 1차 | id:one\n- 23:00-23:59 | 밤샘 점검 | id:night\n');
  // 서버가 읽는 줄 모양(CALENDAR_ITEM_RE)과 같다 — 제목의 `|`는 링크 칸으로 읽히지 않게 바꿨다
  const re = /^- (\d{2}:\d{2})-(\d{2}:\d{2}) \| (.+?)(?: \| (\S+))?$/;
  const parsed = text.split('\n').filter(line => line.startsWith('- ')).map(line => line.replace(/ \| id:\S+$/, '').match(re));
  assert.ok(parsed.every(Boolean));
  assert.deepEqual(parsed.map(m => [m[3], m[4] || null]), [['주간 회의', null], ['기획 리뷰 / 1차', null], ['밤샘 점검', null]]);
});

test('WP-V 실행(run): 고른 캘린더만 읽어 calendar_today.md를 쓰고, 기록은 한 블록 + 상태 파일 — 내용이 같으면 다시 쓰지 않는다', async (t) => {
  const h = tempHome(t);
  h.writeConfig({ integrations: { calendar: true }, jira: { email: 'me@example.test' }, calendar: { source: 'mac', macCalendars: [{ id: 'CAL-ME', name: 'me@example.test' }, { id: 'CAL-GONE', name: '사라진 캘린더' }] } });
  const read = { ok: true, calendars: CALENDARS, failed: [], events: [
    { calendarId: 'CAL-ME', externalId: 'a@google.com', title: '오늘 회의', start: kst(29, 10), end: kst(29, 11), allDay: false, status: '' },
    { calendarId: 'CAL-HOLIDAY', externalId: 'h', title: '고르지 않은 캘린더', start: kst(29, 12), end: kst(29, 13), allDay: false, status: '' },
  ] };
  const fake = fakeOsa({ read });
  const code = await mac.main({ mode: 'run', env: h.env, now: () => NOW, osa: fake.osa, timeZone: ZONE });
  assert.equal(code, 0);
  assert.deepEqual(fake.calls.map(call => call.input.mode), ['list', 'read']);
  const ask = fake.calls[1].input;
  assert.deepEqual(ask.ids, ['CAL-ME'], '고른 캘린더만 읽는다');
  assert.equal(ask.me, undefined, '거절은 EventKit의 isCurrentUser로 판단한다(메일을 넘기지 않는다)');
  assert.ok(fake.calls.every(call => call.ms > 0 && call.ms <= mac.TIMEOUT_MS), '합쳐서 60초 안');
  assert.equal(h.snapshot(), `# 오늘 캘린더 일정\n\n마지막 갱신: ${localDay(NOW)}\n\n- 10:00-11:00 | 오늘 회의 | id:a\n`);
  const log = h.log();
  assert.match(log, /^───── \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} mac-calendar 시작( \(v[0-9A-Za-z.+-]+\))?\n캘린더 1개 · 오늘 일정 1개를 읽었어요 · 고른 캘린더 1개를 찾지 못했어요 — 다시 골라 주세요\n\n───── [^\n]+ mac-calendar 종료 \(exit 0\)\n$/);
  const state = h.state();
  assert.equal(state.kind, 'run');
  assert.equal(state.ok, true);
  assert.equal(state.eventCount, 1);
  assert.deepEqual(state.missing, ['사라진 캘린더']);
  assert.ok(!JSON.stringify(state).includes('오늘 회의'), '상태 파일에는 일정 제목을 남기지 않는다');

  // 같은 내용이면 스냅샷을 다시 쓰지 않는다(회의 기록 맞추기를 괜히 깨우지 않게)
  const before = fs.statSync(path.join(h.data, 'calendar_today.md')).mtimeMs;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(await mac.main({ mode: 'run', env: h.env, now: () => NOW, osa: fakeOsa({ read }).osa, timeZone: ZONE }), 0);
  assert.equal(fs.statSync(path.join(h.data, 'calendar_today.md')).mtimeMs, before);
});

test('WP-V 실행 실패: 허용 막힘·계정 없음·고른 캘린더 모두 사라짐·시간 초과는 ⚠️ 한 줄 + 0 아닌 종료 — 스냅샷은 그대로', async (t) => {
  const h = tempHome(t);
  h.writeConfig({ integrations: { calendar: true }, calendar: { source: 'mac', macCalendars: [{ id: 'CAL-ME', name: 'me@example.test' }] } });
  fs.writeFileSync(path.join(h.data, 'calendar_today.md'), '이전 스냅샷\n');
  const cases = [
    [fakeOsa({ list: { ok: false, error: 'denied', code: -1743 } }), 77, '⚠️ 맥이 캘린더 접근을 막았어요 — 시스템 설정 → 개인정보 보호 및 보안 → 캘린더에서 허용해 주세요', 'denied'],
    [fakeOsa({ list: { ok: true, calendars: [] } }), 78, '⚠️ 맥 캘린더에 구글 계정이 없어요 — 1단계를 먼저 해 주세요', 'noAccount'],
    [fakeOsa({ list: { ok: true, calendars: [{ id: 'X', name: '다른 것' }] } }), 79, '⚠️ 고른 캘린더를 찾지 못했어요 — 다시 골라 주세요', 'missing'],
    [fakeOsa({ list: { ok: false, error: 'timeout' } }), 124, '⚠️ 맥 캘린더가 60초 안에 답하지 않았어요 — 캘린더가 많으면 잠시 뒤 다시 시도해 주세요', 'timeout'],
    [fakeOsa({ read: { ok: true, calendars: CALENDARS, events: [], failed: ['CAL-ME'] } }), 1, '⚠️ 맥 캘린더를 읽지 못했어요 — 잠시 뒤 다시 시도해 주세요', 'failed'],
  ];
  for (const [fake, exit, line, reason] of cases) {
    assert.equal(await mac.main({ mode: 'run', env: h.env, now: () => NOW, osa: fake.osa, timeZone: ZONE }), exit, reason);
    assert.ok(h.log().includes(`${line}\n\n───── `), reason);
    assert.match(h.log(), new RegExp(`mac-calendar 종료 \\(exit ${exit}\\)\\n$`));
    assert.equal(h.state().reason, reason);
    assert.equal(h.snapshot(), '이전 스냅샷\n', '실패하면 스냅샷은 건드리지 않는다');
  }
  // 고른 캘린더가 없으면(설정에 없음) 읽지 않고 알린다
  h.writeConfig({ integrations: { calendar: true }, calendar: { source: 'mac' } });
  assert.equal(await mac.main({ mode: 'run', env: h.env, now: () => NOW, osa: fakeOsa().osa, timeZone: ZONE }), 79);
  assert.match(h.log(), /⚠️ 읽을 캘린더를 아직 고르지 않았어요/);
});

test('WP-V 실행(run)은 맥 캘린더 갈래·켜짐일 때만 — 아니면 한 줄 남기고 osascript를 부르지 않는다', async (t) => {
  const h = tempHome(t);
  for (const [config, words] of [
    [{ integrations: { calendar: false }, calendar: { source: 'mac', macCalendars: [{ id: 'CAL-ME' }] } }, '캘린더 연동이 꺼져 있어 건너뛰어요'],
    [{ integrations: { calendar: true }, calendar: { source: 'claude' } }, '맥 캘린더 갈래가 아니라 건너뛰어요'],
    [{}, '맥 캘린더 갈래가 아니라 건너뛰어요'],
  ]) {
    h.writeConfig(config);
    const fake = fakeOsa();
    assert.equal(await mac.main({ mode: 'run', env: h.env, now: () => NOW, osa: fake.osa, timeZone: ZONE }), 0);
    assert.equal(fake.calls.length, 0);
    assert.ok(h.log().trim().endsWith(`mac-calendar ${words}`));
  }
  assert.equal(h.snapshot(), null);
});

test('WP-V 허용하고 확인(now + mode:check): 갈래와 무관하게 목록·기본 캘린더를 읽어 상태만 남기고 스냅샷은 쓰지 않는다', async (t) => {
  const h = tempHome(t);
  h.writeConfig({ integrations: { calendar: true }, calendar: { source: 'claude' } });
  fs.writeFileSync(path.join(h.automation, 'requests', 'mac-calendar.request'), JSON.stringify({ mode: 'check', requestedAt: '2026-09-29T01:00:00.000Z', extra: '$(rm -rf /)' }));
  const read = { ok: true, calendars: CALENDARS, failed: [], events: [
    { calendarId: 'CAL-ME', externalId: 'a', title: '회의', start: kst(29, 10), end: kst(29, 11), allDay: false, status: '' },
    { calendarId: 'CAL-ME', externalId: 'b', title: '회의2', start: kst(29, 15), end: kst(29, 16), allDay: false, status: '' },
  ] };
  const fake = fakeOsa({ read });
  assert.equal(await mac.main({ mode: 'now', env: h.env, now: () => NOW, osa: fake.osa, timeZone: ZONE }), 0);
  assert.deepEqual(fake.calls[1].input.ids, ['CAL-ME'], '기본 캘린더(내 이메일 이름) 하나로 센다');
  assert.equal(h.snapshot(), null, '확인은 스냅샷을 쓰지 않는다(아직 다른 갈래일 수 있다)');
  const state = h.state();
  assert.equal(state.kind, 'check');
  assert.equal(state.requestedAt, '2026-09-29T01:00:00.000Z');
  assert.equal(state.eventCount, 2);
  assert.deepEqual(state.suggested, ['CAL-ME']);
  assert.deepEqual(state.calendars.map(one => one.id), CALENDARS.map(one => one.id));
  // 구글 캘린더가 하나도 없으면 계정 없음(목록은 그대로 준다 — 화면이 보여 줄 수 있게)
  const none = fakeOsa({ list: { ok: true, calendars: [{ id: 'L', name: '캘린더', writable: true }] } });
  assert.equal(await mac.main({ mode: 'now', env: h.env, now: () => NOW, osa: none.osa, timeZone: ZONE }), 78);
  assert.equal(none.calls.length, 1, '읽기까지 가지 않는다');
  assert.equal(h.state().reason, 'noAccount');
  assert.deepEqual(h.state().calendars, [{ id: 'L', name: '캘린더', writable: true, account: '' }]);
  // 이미 맥 캘린더 갈래면 확인도 고른 캘린더로 센다
  h.writeConfig({ integrations: { calendar: true }, calendar: { source: 'mac', macCalendars: [{ id: 'CAL-LOCAL', name: '캘린더' }] } });
  const again = fakeOsa({ read });
  await mac.main({ mode: 'now', env: h.env, now: () => NOW, osa: again.osa, timeZone: ZONE });
  assert.deepEqual(again.calls[1].input.ids, ['CAL-LOCAL']);
  assert.equal(h.snapshot(), null);
  // 요청 파일에 mode가 없으면(지금 가져오기) 주기 실행과 같다 — 스냅샷을 쓴다
  fs.writeFileSync(path.join(h.automation, 'requests', 'mac-calendar.request'), JSON.stringify({ requestedAt: '2026-09-29T01:05:00.000Z' }));
  assert.equal(await mac.main({ mode: 'now', env: h.env, now: () => NOW, osa: fakeOsa({ read }).osa, timeZone: ZONE }), 0);
  assert.equal(h.state().kind, 'run');
  assert.ok(h.snapshot() && h.snapshot().includes('마지막 갱신:'));
});

test('WP-V osascript 부르기: 직접 띄운 자식 하나에 `-l JavaScript <스크립트> <요청>` — 막힘(-1743)·실패·60초 초과(그 자식만 끝낸다)', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-fake-osascript-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'osascript');
  const argsFile = path.join(root, 'args.json');
  fs.writeFileSync(bin, `#!${process.execPath}
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
const input = JSON.parse(process.argv[5] || '{}');
if (input.how === 'denied') { process.stderr.write('execution error: Not authorized to send Apple events to Calendar. (-1743)\\n'); process.exit(1); }
if (input.how === 'broken') { process.stdout.write('not json'); process.exit(0); }
if (input.how === 'slow') { setTimeout(() => {}, 60000); return; }
process.stdout.write(JSON.stringify({ ok: true, calendars: [{ id: 'A', name: 'a@b.test', writable: true }] }) + '\\n');
`);
  fs.chmodSync(bin, 0o755);
  const ok = await mac.runOsascript({ mode: 'list' }, { bin, timeoutMs: 5000 });
  assert.deepEqual(ok, { ok: true, calendars: [{ id: 'A', name: 'a@b.test', writable: true }] });
  const args = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
  assert.deepEqual(args.slice(0, 2), ['-l', 'JavaScript']);
  assert.equal(args[2], path.join(__dirname, 'automation', 'mac-calendar.js'));
  assert.deepEqual(JSON.parse(args[3]), { mode: 'list' });
  assert.deepEqual(await mac.runOsascript({ how: 'denied' }, { bin, timeoutMs: 5000 }), { ok: false, error: 'denied' });
  assert.deepEqual(await mac.runOsascript({ how: 'broken' }, { bin, timeoutMs: 5000 }), { ok: false, error: 'failed' });
  const started = Date.now();
  assert.deepEqual(await mac.runOsascript({ how: 'slow' }, { bin, timeoutMs: 300 }), { ok: false, error: 'timeout' });
  assert.ok(Date.now() - started < 5000, '제한 시간에 끊는다');
  assert.deepEqual(await mac.runOsascript({ mode: 'list' }, { bin: path.join(root, 'none'), timeoutMs: 1000 }), { ok: false, error: 'failed' });
  // 신호는 직접 띄운 자식에게만 — 프로세스 목록을 훑거나 그룹·이름으로 끝내지 않는다
  const source = fs.readFileSync(path.join(__dirname, 'calendar-mac.js'), 'utf8');
  assert.ok(!/pkill|killall|process\.kill\(|ps -|lsof|kill -/.test(source));
  assert.equal((source.match(/child\.kill\(/g) || []).length, 2, 'TERM 한 번, 남으면 KILL 한 번 — 둘 다 그 자식');
});

test('WP-V JXA 스크립트: EventKit(ObjC 다리)으로 읽고 캘린더 앱은 켜지 않는다 — 장소·참석자 목록·메모는 싣지 않는다', () => {
  const jxa = fs.readFileSync(path.join(__dirname, 'automation', 'mac-calendar.js'), 'utf8');
  assert.match(jxa, /ObjC\.import\('EventKit'\)/);
  assert.match(jxa, /predicateForEventsWithStartDateEndDateCalendars/);
  assert.ok(!/Application\('Calendar'\)|\.quit\(|\.activate\(/.test(jxa), '캘린더 앱을 켜거나 끄지 않는다');
  assert.ok(!/\.location|\.notes|\.URL\b|\.url\b/.test(jxa), '장소·메모·주소를 읽지 않는다');
  assert.match(jxa, /isCurrentUser/, '참석자는 내가 거절했는지에만');
  // 허용 상태는 숫자로 견준다(ObjC 값을 !==로 견주면 늘 참이라 허용을 다시 묻고 30초를 기다렸다)
  assert.match(jxa, /Number\(\$\.EKEventStore\.authorizationStatusForEntityType/);
  assert.match(jxa, /requestFullAccessToEventsWithCompletion:/);
  assert.match(jxa, /dateWithTimeIntervalSinceNow\(30\)/, '허용 대기는 30초까지');
  // 줄 모양만 확인 — 실제 osascript로 돌리지 않는다
  assert.equal(spawnSync(process.execPath, ['--check', path.join(__dirname, 'automation', 'mac-calendar.js')]).status, 0);
});

test('WP-V mac-calendar.sh: WORKSPACE_DIR로 calendar-mac.js를 부른다(run·now만) — 임시 폴더와 가짜 osascript로만', (t) => {
  const h = tempHome(t);
  const bin = path.join(h.root, 'osascript');
  fs.writeFileSync(bin, `#!${process.execPath}
const input = JSON.parse(process.argv[5] || '{}');
const day = new Date(); day.setHours(15, 0, 0, 0);
if (input.mode === 'list') process.stdout.write(JSON.stringify({ ok: true, calendars: [{ id: 'CAL-ME', name: 'me@example.test', writable: true }] }));
else process.stdout.write(JSON.stringify({ ok: true, calendars: [], failed: [], events: [{ calendarId: 'CAL-ME', externalId: 'x@google.com', title: '셸로 읽은 회의', start: day.getTime(), end: day.getTime() + 1800000, allDay: false, status: '' }] }));
`);
  fs.chmodSync(bin, 0o755);
  h.writeConfig({ integrations: { calendar: true }, calendar: { source: 'mac', macCalendars: [{ id: 'CAL-ME', name: 'me@example.test' }] } });
  const script = path.join(__dirname, 'automation', 'mac-calendar.sh');
  const env = { PATH: process.env.PATH, ...h.env, WORKSPACE_DIR: REPO_ROOT, WORKSPACE_OSASCRIPT: bin };
  const run = spawnSync('/bin/bash', [script, 'run'], { env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(h.snapshot(), /\n- 15:00-15:30 \| 셸로 읽은 회의 \| id:x\n$/);
  assert.match(h.log(), /캘린더 1개 · 오늘 일정 1개를 읽었어요/);
  // 설치 정보가 없으면 멈춘다
  const lost = spawnSync('/bin/bash', [script, 'run'], { env: { PATH: process.env.PATH, HOME: h.root, WORKSPACE_ENV_FILE: path.join(h.root, 'none.env') }, encoding: 'utf8' });
  assert.equal(lost.status, 1);
  assert.match(lost.stderr, /설치 정보를 찾을 수 없어요/);
  assert.equal(spawnSync('/bin/bash', ['-n', script]).status, 0);
});

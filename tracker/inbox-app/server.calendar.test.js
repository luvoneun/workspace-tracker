// 서버: 캘린더 비밀 주소(iCal)·지금 가져오기. 공용 준비는 test-support.js.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const support = require('./test-support');
const { today, items, freePort, integrationsStore } = support;
let base;
before(async () => { base = await support.ready(); });

// ─────────────────────────────────────────────────────────────────────────────
// WP-D2 — 캘린더 비밀 주소(iCal) 직접 읽기 · 설정 › 꾸미기
//
// 여기서도 **실제 캘린더·실제 설정·실제 홈 폴더에는 절대 닿지 않는다**: iCal은 아래 픽스처 글자이고,
// 캘린더 주소로 나가는 fetch는 가짜 응답이 전부 가로챈다. 스크립트는 PATH 앞에 세운 가짜
// osacompile·iconutil·codesign·plutil·xattr·python3와 임시 HOME으로만 돈다.
const ical = require('./ical');
const { createCalendarLive } = require('./calendar-live');

// 2026-09-24(목)을 오늘로 두는 캘린더. 줄마다 무엇을 확인하는지 SUMMARY에 적었다.
const ICAL_FIXTURE = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'X-WR-TIMEZONE:Asia/Seoul',
  'BEGIN:VEVENT', 'UID:single@google.com',
  'DTSTART;TZID=Asia/Seoul:20260924T100000', 'DTEND;TZID=Asia/Seoul:20260924T110000',
  'SUMMARY:단일 회의\\, 확인', 'X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij',
  'BEGIN:VALARM', 'ACTION:DISPLAY', 'SUMMARY:알림은 제목이 아니다', 'TRIGGER:-PT10M', 'END:VALARM',
  'END:VEVENT',
  'BEGIN:VEVENT', 'UID:utc@google.com', 'DTSTART:20260924T050000Z', 'DTEND:20260924T053000Z', 'SUMMARY:UTC 회의', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:allday@google.com', 'DTSTART;VALUE=DATE:20260924', 'DTEND;VALUE=DATE:20260925', 'SUMMARY:휴가', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:cancel@google.com', 'STATUS:CANCELLED',
  'DTSTART;TZID=Asia/Seoul:20260924T120000', 'DTEND;TZID=Asia/Seoul:20260924T123000', 'SUMMARY:취소된 회의', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:daily@google.com',
  'DTSTART;TZID=Asia/Seoul:20260901T090000', 'DTEND;TZID=Asia/Seoul:20260901T091500',
  'RRULE:FREQ=DAILY;UNTIL=20260930T000000Z', 'SUMMARY:데일리 스탠드업', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:weekly@google.com',
  'DTSTART;TZID=Asia/Seoul:20260907T160000', 'DURATION:PT1H',
  'RRULE:FREQ=WEEKLY;BYDAY=MO,TH', 'EXDATE;TZID=Asia/Seoul:20260917T160000', 'SUMMARY:주간 싱크', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:count@google.com', 'DTSTART;TZID=Asia/Seoul:20260903T170000',
  'RRULE:FREQ=WEEKLY;COUNT=3', 'SUMMARY:세 번만', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:ex@google.com', 'DTSTART;TZID=Asia/Seoul:20260922T130000',
  'RRULE:FREQ=DAILY', 'EXDATE;TZID=Asia/Seoul:20260924T130000', 'SUMMARY:오늘은 빠짐', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:moved@google.com', 'DTSTART;TZID=Asia/Seoul:20260921T150000', 'DTEND;TZID=Asia/Seoul:20260921T153000',
  'RRULE:FREQ=DAILY', 'SUMMARY:매일 리뷰', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:moved@google.com', 'RECURRENCE-ID;TZID=Asia/Seoul:20260924T150000',
  'DTSTART;TZID=Asia/Seoul:20260924T153000', 'DTEND;TZID=Asia/Seoul:20260924T160000', 'SUMMARY:매일 리뷰(미룸)', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:monthly@google.com', 'DTSTART;TZID=Asia/Seoul:20260827T113000',
  'RRULE:FREQ=MONTHLY;BYDAY=4TH', 'SUMMARY:월간 회고', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:floating@google.com', 'DTSTART:20260924T180000', 'DTEND:20260924T183000',
  'SUMMARY:떠 있는 시각은 캘린더 시간', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:ny@google.com', 'DTSTART;TZID=America/New_York:20260924T060000',
  'DTEND;TZID=America/New_York:20260924T070000', 'SUMMARY:뉴욕 회의', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:late@google.com', 'DTSTART;TZID=Asia/Seoul:20260924T233000',
  'DTEND;TZID=Asia/Seoul:20260925T003000', 'SUMMARY:자정을 넘는', '  회의', 'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');
const SEOUL = { timeZone: 'Asia/Seoul' };
const at = (y, m, d, h = 12) => Date.UTC(y, m - 1, d, h - 9, 0, 0);   // 서울 시각 → 순간

test('WP-D2 iCal: 오늘 시작하는 일정만 — 단일·UTC·반복(DAILY UNTIL·WEEKLY BYDAY·COUNT·EXDATE·MONTHLY 몇째 요일)·옮긴 회차·시간대, 취소·종일은 뺀다', () => {
  const calendar = ical.parseCalendar(ICAL_FIXTURE);
  assert.equal(calendar.ok, true);
  assert.equal(calendar.zone, 'Asia/Seoul');
  const events = ical.todayEvents(calendar, { now: at(2026, 9, 24), ...SEOUL });
  assert.deepEqual(events.map(one => `${one.start}-${one.end} ${one.title}`), [
    '09:00-09:15 데일리 스탠드업',
    '10:00-11:00 단일 회의, 확인',
    '11:30-11:30 월간 회고',
    '14:00-14:30 UTC 회의',
    '15:30-16:00 매일 리뷰(미룸)',
    '16:00-17:00 주간 싱크',
    '18:00-18:30 떠 있는 시각은 캘린더 시간',
    '19:00-20:00 뉴욕 회의',
    '23:30-23:59 자정을 넘는 회의',
  ]);
  // calendar_today.md를 읽었을 때와 같은 모양 — 회의 링크는 https만, id는 구글 일정 id 꼴
  const single = events.find(one => one.title.startsWith('단일'));
  assert.deepEqual(Object.keys(single).sort(), ['end', 'externalId', 'link', 'start', 'title']);
  assert.equal(single.link, 'https://meet.google.com/abc-defg-hij');
  assert.equal(single.externalId, 'single');
  assert.equal(events[0].externalId, 'daily_20260924T000000Z', '반복 회차는 `_시각Z`가 붙는다');
  assert.equal(events.find(one => one.title === 'UTC 회의').link, null);

  // 종일 일정은 읽기는 하되(allDay) 오늘 목록에는 넣지 않는다
  const all = ical.occurrencesOn(calendar, { now: at(2026, 9, 24), ...SEOUL });
  assert.ok(all.some(one => one.allDay && one.title === '휴가'));
  assert.ok(!events.some(one => one.title === '휴가'));

  const titlesOn = (...day) => ical.todayEvents(calendar, { now: at(...day), ...SEOUL }).map(one => one.title);
  assert.ok(!titlesOn(2026, 9, 17).includes('주간 싱크'), 'EXDATE로 뺀 회차');
  assert.ok(titlesOn(2026, 9, 21).includes('주간 싱크'), 'BYDAY 월요일');
  assert.ok(!titlesOn(2026, 9, 22).includes('주간 싱크'), 'BYDAY에 없는 화요일');
  assert.ok(titlesOn(2026, 9, 17).includes('세 번만') && !titlesOn(2026, 9, 24).includes('세 번만'), 'COUNT=3이면 세 번째에서 끝난다');
  assert.ok(titlesOn(2026, 9, 29).includes('데일리 스탠드업') && !titlesOn(2026, 10, 1).includes('데일리 스탠드업'), 'UNTIL 다음 날부터 없다');
  assert.ok(titlesOn(2026, 10, 22).includes('월간 회고') && !titlesOn(2026, 10, 15).includes('월간 회고'), '넷째 목요일만');
  assert.ok(titlesOn(2026, 9, 23).includes('매일 리뷰') && !titlesOn(2026, 9, 24).includes('매일 리뷰'), '옮긴 회차만 그날 원래 자리를 대신한다');
  assert.ok(titlesOn(2026, 9, 23).includes('오늘은 빠짐'));
  // VCALENDAR가 아니면 읽지 않는다
  assert.equal(ical.parseCalendar('<html>로그인</html>').ok, false);
});

test('WP-D2 calendar-live: 메모리에만 들고, 실패하면 이전 값, 묵으면 버리고, 자정이 지나면 새 날 일정을 뽑는다', async () => {
  let clock = at(2026, 9, 24, 23);
  let answer = ICAL_FIXTURE;
  let calls = 0;
  const live = createCalendarLive({
    load: async () => { calls += 1; if (answer instanceof Error) throw answer; return answer; },
    connected: () => true, now: () => clock, ...SEOUL, keepMs: 3 * 3600000,
  });
  assert.equal(live.current(), null, '읽기 전에는 값이 없다(그때는 calendar_today.md를 본다)');
  assert.equal(await live.refresh(), true);
  assert.equal(live.current().events.length, 9);
  assert.equal(live.failed(), false);

  // 동시에 두 번 돌지 않는다
  await Promise.all([live.refresh(), live.refresh()]);
  assert.equal(calls, 2);

  answer = new Error('닿지 못함');
  clock += 60000;
  assert.equal(await live.refresh(), false);
  assert.equal(live.current().events.length, 9, '실패해도 이전 값을 쓴다');
  assert.equal(live.failed(), true);

  // 자정이 지나면 다시 읽지 않아도 새 날(9/25 금)의 일정이 나온다(마지막 성공에서 두 시간 — 아직 버리지 않는다)
  clock = at(2026, 9, 25, 1);
  assert.ok(!live.current().events.some(one => one.title === '주간 싱크'), '금요일에는 주간 싱크가 없다');
  assert.ok(live.current().events.some(one => one.title === '데일리 스탠드업'));

  clock += 3 * 3600000;
  assert.equal(live.current(), null, '세 시간 넘게 못 읽으면 버린다');

  // 연결이 없으면 타이머도 첫 읽기도 없다. 있으면 타이머는 프로세스를 붙잡지 않는다.
  const off = createCalendarLive({ load: async () => { throw new Error('불리면 안 된다'); }, connected: () => false });
  assert.equal(off.start(), false);
  assert.equal(off.started(), false);
  const on = createCalendarLive({ load: async () => ICAL_FIXTURE, connected: () => true });
  assert.equal(on.start(), true);
  assert.equal(on.holdsProcess(), false);
  on.stop();
});

test('WP-D2 연동 저장: 비밀 주소는 한 번 읽어 센 뒤 0600 파일로만, config에는 갈래·경로만 — 실패하면 아무것도 쓰지 않는다', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-ical-save-'));
  const tokenDir = path.join(home, 'tokens');
  const configPath = path.join(home, 'workspace.config.json');
  const secret = 'https://calendar.google.com/calendar/ical/me%40example.test/private-0123456789abcdef/basic.ics';
  const writes = [];
  const write = (file, text) => { writes.push(file); fs.writeFileSync(file, text); };
  const current = { title: '내 이름', integrations: { calendar: false } };

  // 1) 읽어 보다 실패하면 설정도 주소 파일도 만들지 않는다
  await assert.rejects(() => integrationsStore.saveIntegrations({
    configPath, current, tokenDir, write,
    body: { calendar: { enabled: true, source: 'ical', url: secret } },
    calendarCheck: async () => { throw Object.assign(new Error(integrationsStore.INTEGRATION_MESSAGE.icalRead), { status: 400 }); },
  }), /이 주소를 읽지 못했어요 — 비밀 주소를 다시 복사해 주세요/);
  assert.deepEqual(writes, []);
  assert.equal(fs.existsSync(path.join(tokenDir, 'workspace-calendar-ical')), false);

  // 1-1) 구글의 공개 주소(…/public/basic.ics)는 읽어 보기 전에 비공개 주소를 쓰라고 알려 준다
  let checkedPublic = false;
  await assert.rejects(() => integrationsStore.saveIntegrations({
    configPath, current, tokenDir, write,
    body: { calendar: { enabled: true, source: 'ical', url: 'https://calendar.google.com/calendar/ical/me%40example.test/public/basic.ics' } },
    calendarCheck: async () => { checkedPublic = true; return { ok: true, count: 0 }; },
  }), /공개 주소를 붙였어요 — 같은 화면 조금 아래 「iCal 형식의 비공개 주소」를 복사해 주세요/);
  assert.equal(checkedPublic, false, '공개 주소는 읽으러 가지 않는다');
  assert.deepEqual(writes, []);
  const okCheck = async () => ({ ok: true, count: 1 });
  await assert.rejects(() => integrationsStore.saveIntegrations({ configPath, current, tokenDir, write, body: { calendar: { enabled: true, source: 'ical', url: 'http://calendar.google.com/x.ics' } }, calendarCheck: okCheck }), /https:\/\/로 시작해야/);
  await assert.rejects(() => integrationsStore.saveIntegrations({ configPath, current, tokenDir, write, body: { calendar: { enabled: true, source: 'ical', url: '' } }, calendarCheck: okCheck }), /비밀 주소를 붙여 넣어 주세요/);
  assert.deepEqual(writes, []);

  // 2) 성공 — 주소는 파일(0600)로만, config에는 source·icalFile만, 결과에는 개수만
  const checked = [];
  const { config, result } = await integrationsStore.saveIntegrations({
    configPath, current, tokenDir, write,
    body: { calendar: { enabled: true, source: 'ical', url: ` ${secret} ` } },
    calendarCheck: async (address) => { checked.push(address); return { ok: true, count: 3 }; },
  });
  assert.deepEqual(checked, [secret]);
  assert.deepEqual(result.calendar, { source: 'ical', count: 3 });
  assert.equal(config.integrations.calendar, true);
  assert.deepEqual(config.calendar, { source: 'ical', icalFile: path.join(tokenDir, 'workspace-calendar-ical') });
  assert.equal(config.title, '내 이름', '모르는 키는 그대로');
  const file = path.join(tokenDir, 'workspace-calendar-ical');
  assert.equal(fs.readFileSync(file, 'utf8').trim(), secret);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify({ config, result }).includes('private-0123456789abcdef'), '주소는 config·결과 어디에도 없다');
  const state = integrationsStore.readIntegrations(config, { tokenDir });
  assert.deepEqual(state.calendar, { enabled: true, source: 'ical', hasIcal: true });
  assert.ok(!JSON.stringify(state).includes('private-'), '지금 상태에도 주소는 없다(있음/없음만)');
  assert.equal(integrationsStore.savedIcalUrl(config, tokenDir), secret, '서버 안에서만 꺼내 쓴다');

  // 3) 칸을 비운 다시 연결은 저장된 주소로 다시 확인하고, 파일은 다시 쓰지 않는다
  const again = [];
  await integrationsStore.saveIntegrations({
    configPath, current: config, tokenDir, write,
    body: { calendar: { enabled: true, source: 'ical', url: '' } },
    calendarCheck: async (address) => { again.push(address); return { ok: true, count: 2 }; },
    writeToken: () => { throw new Error('주소 파일을 다시 쓰면 안 된다'); },
  });
  assert.deepEqual(again, [secret]);

  // 4) `Claude Code로`를 고르면 갈래만 claude로 — 주소 파일·경로는 그대로(사람 것)
  const claude = await integrationsStore.saveIntegrations({ configPath, current: config, tokenDir, write, body: { calendar: { enabled: true } } });
  assert.deepEqual(claude.config.calendar, { source: 'claude', icalFile: path.join(tokenDir, 'workspace-calendar-ical') });
  assert.deepEqual(claude.result.calendar, { source: 'claude' });
  assert.equal(integrationsStore.readIntegrations(claude.config, { tokenDir }).calendar.source, 'claude');
  // 5) 해제는 켜짐만 끈다
  const off = await integrationsStore.saveIntegrations({ configPath, current: config, tokenDir, write, body: { calendar: { enabled: false } } });
  assert.equal(off.config.integrations.calendar, false);
  assert.equal(off.config.calendar.source, 'ical');
  assert.ok(fs.existsSync(file), '주소 파일은 지우지 않는다');
  fs.rmSync(home, { recursive: true, force: true });
});

test('WP-D2 비밀 주소 읽기: webcal은 https로, 10초 제한, 캘린더가 아니거나 못 읽으면 우리 문구(주소는 문구에 없다)', async () => {
  const secret = 'webcal://calendar.example.test/private-abc/basic.ics';
  const seen = [];
  const answer = (body, status = 200) => async (url, options) => { seen.push({ url, options }); return new Response(body, { status }); };
  const text = await integrationsStore.fetchIcal(secret, answer(ICAL_FIXTURE));
  assert.ok(text.startsWith('BEGIN:VCALENDAR'));
  assert.equal(seen[0].url, 'https://calendar.example.test/private-abc/basic.ics');
  assert.ok(seen[0].options.signal, '제한 시간이 있다');
  const errorOf = async (request) => { try { await integrationsStore.fetchIcal(secret, request); return ''; } catch (error) { return error.message; } };
  assert.equal(await errorOf(answer('<html>로그인</html>')), '캘린더 주소가 아니에요 — iCal 형식의 비공개 주소를 복사해 주세요');
  assert.equal(await errorOf(answer('없음', 404)), '이 주소를 읽지 못했어요 — 비밀 주소를 다시 복사해 주세요');
  assert.equal(await errorOf(async () => { throw new Error(`connect failed ${secret}`); }), '이 주소를 읽지 못했어요 — 비밀 주소를 다시 복사해 주세요');
  const counted = await integrationsStore.icalCheck(secret, { request: answer(ICAL_FIXTURE), now: at(2026, 9, 24), timeZone: 'Asia/Seoul' });
  assert.deepEqual(counted, { ok: true, count: 9 }, '오늘 일정 수만 돌려준다');
});

test('WP-D2 서버: 비밀 주소로 읽은 오늘 일정이 calendar_today.md보다 먼저이고, 연동 탭에 개수·시각만 싣는다(주소는 없다)', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-ical-route-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const data = path.join(home, 'tracker');
  fs.mkdirSync(data);
  const tokens = path.join(home, 'tokens');
  fs.mkdirSync(tokens);
  const secret = 'https://calendar.example.test/calendar/ical/private-feedface/basic.ics';
  fs.writeFileSync(path.join(tokens, 'workspace-calendar-ical'), `${secret}\n`, { mode: 0o600 });
  const config = path.join(home, 'workspace.config.json');
  fs.writeFileSync(config, JSON.stringify({
    integrations: { slack: false, calendar: true, jira: false, tiro: false },
    calendar: { source: 'ical', icalFile: path.join(tokens, 'workspace-calendar-ical') },
  }, null, 2));
  // 대비책 파일에는 다른 회의를 적어 둔다 — 직접 읽은 게 있으면 이 파일은 보지 않아야 한다.
  fs.writeFileSync(path.join(data, 'calendar_today.md'), `마지막 갱신: ${today}\n- 08:00-09:00 | 파일에만 있는 회의\n`);
  const automation = path.join(home, 'automation');
  const wrapper = path.join(home, 'fake-ical-server.js');
  fs.writeFileSync(wrapper, `'use strict';
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input && input.url ? input.url : input);
  if (!url.startsWith('https://calendar.example.test/')) return realFetch(input, init);
  const d = new Date();
  const day = String(d.getFullYear()) + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  const body = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:a@google.com', 'DTSTART:' + day + 'T100000', 'DTEND:' + day + 'T110000', 'SUMMARY:주소로 읽은 회의', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:b@google.com', 'DTSTART:' + day + 'T140000', 'DTEND:' + day + 'T143000', 'SUMMARY:두 번째 회의', 'END:VEVENT', 'END:VCALENDAR'].join('\\r\\n');
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/calendar' } });
};
const { server, calendarLive } = require(${JSON.stringify(path.join(__dirname, 'server.js'))});
server.listen(Number(process.env.WORKSPACE_PORT), '127.0.0.1', () => { calendarLive.start(); console.log('ready'); });
`);
  const port = await freePort();
  const child = spawn(process.execPath, [wrapper], {
    env: {
      ...process.env, WORKSPACE_PORT: String(port), WORKSPACE_NO_OPEN: '1', WORKSPACE_HOST: '', WORKSPACE_NO_REMOTE_CHECK: '1',
      WORKSPACE_DATA_DIR: data, WORKSPACE_CONFIG: config, WORKSPACE_TOKEN_DIR: tokens, WORKSPACE_AUTOMATION_DIR: automation,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  t.after(() => child.kill('SIGKILL'));
  const origin = `http://127.0.0.1:${port}`;
  let calendar = null;
  const deadline = Date.now() + 10000;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`직접 읽은 일정이 오지 않았습니다: ${log} ${JSON.stringify(calendar)}`);
    if (child.exitCode !== null) throw new Error(`서버가 종료되었습니다 (${child.exitCode}): ${log}`);
    try { calendar = (await (await fetch(origin + '/api/items')).json()).calendar; if (calendar && calendar.live) break; } catch { /* 아직 */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.deepEqual(calendar.events.map(one => `${one.start}-${one.end} ${one.title}`), ['10:00-11:00 주소로 읽은 회의', '14:00-14:30 두 번째 회의']);
  assert.equal(calendar.stale, false);
  assert.equal(calendar.events[0].externalId, 'a');

  const stateText = await (await fetch(origin + '/api/integrations')).text();
  const state = JSON.parse(stateText);
  assert.equal(state.calendar.source, 'ical');
  assert.equal(state.calendar.eventCount, 2);
  assert.ok(state.calendar.readAt);
  assert.equal(state.calendar.failed, false);
  assert.ok(!stateText.includes('feedface') && !stateText.includes('calendar.example.test'), '비밀 주소는 응답에 없다');
  const automations = (await (await fetch(origin + '/api/automation/status')).json()).automations;
  assert.ok(!automations.some(one => one.key === 'calendar'), '비밀 주소 갈래에는 calendar-sync 자동화 줄이 없다');
  assert.ok(!log.includes('feedface'), '로그에도 주소가 없다');
});

// ─────────────────────────────────────────────────────────────────────────────
// WP-D2.5 — `지금 가져오기` · 설치 위치 지키기 · 티로 프롬프트
//
// 실제 지라·캘린더·슬랙·launchd·홈 폴더에는 닿지 않는다: 바깥으로 나가는 fetch는 가짜 응답이 전부 가로채고,
// launchd 파일은 주입한 임시 폴더(WORKSPACE_LAUNCH_AGENTS_DIR)에서 "있는지만" 본다. 스크립트는 조각만 돌린다.

// 가짜 지라·캘린더를 끼운 서버 하나. `mode` 파일의 글자(ok|auth)로 두 쪽의 답을 바꾼다.
async function startFetchServer(t, { calendarSource = 'ical', mode = 'ok' } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-fetch-now-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const data = path.join(home, 'tracker');
  const tokens = path.join(home, 'tokens');
  const agents = path.join(home, 'LaunchAgents');
  const automation = path.join(home, 'automation');
  [data, tokens, agents, path.join(automation, 'logs')].forEach(dir => fs.mkdirSync(dir, { recursive: true }));
  fs.writeFileSync(path.join(tokens, 'workspace-jira-token'), 'jira-secret-token\n', { mode: 0o600 });
  fs.writeFileSync(path.join(tokens, 'workspace-slack-token'), 'slack-secret-token\n', { mode: 0o600 });
  fs.writeFileSync(path.join(tokens, 'workspace-calendar-ical'), 'https://calendar.example.test/feedface/basic.ics\n', { mode: 0o600 });
  const modeFile = path.join(home, 'mode');
  fs.writeFileSync(modeFile, mode);
  const config = path.join(home, 'workspace.config.json');
  fs.writeFileSync(config, JSON.stringify({
    integrations: { slack: true, calendar: true, jira: true, tiro: true },
    jira: { siteUrl: 'https://jira.example.test', email: 'me@example.test', tokenFile: path.join(tokens, 'workspace-jira-token') },
    slack: { tokenFile: path.join(tokens, 'workspace-slack-token'), channels: { todo: { id: 'C0TODO11', name: '#my-todo' } } },
    calendar: calendarSource === 'ical' ? { source: 'ical', icalFile: path.join(tokens, 'workspace-calendar-ical') } : { source: 'claude' },
    meetingNotes: 'tiro',
  }, null, 2));
  const wrapper = path.join(home, 'fake-remote-server.js');
  fs.writeFileSync(wrapper, `'use strict';
const fs = require('fs');
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input && input.url ? input.url : input);
  const mode = fs.readFileSync(${JSON.stringify(modeFile)}, 'utf8').trim();
  if (url.startsWith('https://jira.example.test/')) {
    if (mode === 'auth') return new Response('{}', { status: 401 });
    const issue = key => ({ key, fields: { summary: key + ' 요약', status: { name: '진행 중', statusCategory: { key: 'indeterminate' } }, issuetype: { name: 'Task' } } });
    return new Response(JSON.stringify({ issues: [issue('IO-1'), issue('IO-2')] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (url.startsWith('https://calendar.example.test/')) {
    if (mode === 'auth') return new Response('gone', { status: 404 });
    const d = new Date();
    const day = String(d.getFullYear()) + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
    const body = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:a@google.com', 'DTSTART:' + day + 'T100000', 'DTEND:' + day + 'T110000', 'SUMMARY:지금 읽은 회의', 'END:VEVENT', 'END:VCALENDAR'].join('\\r\\n');
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/calendar' } });
  }
  return realFetch(input, init);
};
const { server } = require(${JSON.stringify(path.join(__dirname, 'server.js'))});
server.listen(Number(process.env.WORKSPACE_PORT), '127.0.0.1', () => console.log('ready'));
`);
  const port = await freePort();
  const child = spawn(process.execPath, [wrapper], {
    env: {
      ...process.env, WORKSPACE_PORT: String(port), WORKSPACE_NO_OPEN: '1', WORKSPACE_HOST: '', WORKSPACE_NO_REMOTE_CHECK: '1',
      WORKSPACE_DATA_DIR: data, WORKSPACE_CONFIG: config, WORKSPACE_TOKEN_DIR: tokens,
      WORKSPACE_AUTOMATION_DIR: automation, WORKSPACE_LAUNCH_AGENTS_DIR: agents,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  t.after(() => child.kill('SIGKILL'));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10000;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`서버가 응답하지 않았습니다: ${log}`);
    if (child.exitCode !== null) throw new Error(`서버가 종료되었습니다 (${child.exitCode}): ${log}`);
    try { if ((await fetch(base + '/api/storage-status')).ok) break; } catch { /* 아직 */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const ask = async (key) => {
    const response = await fetch(base + '/api/integrations/fetch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
    const text = await response.text();
    return { status: response.status, text, ...JSON.parse(text) };
  };
  const plist = name => fs.writeFileSync(path.join(agents, `com.workspace.app.${name}.plist`), '<plist/>\n');
  const request = name => path.join(automation, 'requests', name);
  return { home, base, ask, plist, request, modeFile, automation, log: () => log };
}
const SECRETS = /jira-secret-token|slack-secret-token|feedface|calendar\.example\.test/;

test('WP-D2.5 지금 가져오기: 지라·캘린더(비밀 주소)는 곧바로 다시 읽고, 슬랙·티로는 plist가 있을 때만 요청 파일을 쓰며, 같은 연동은 1분에 한 번', async (t) => {
  const app = await startFetchServer(t);
  // 지라 — 서버가 곧바로 다시 읽어 개수와 시각을 준다
  const jira = await app.ask('jira');
  assert.equal(jira.status, 200);
  assert.equal(jira.mode, 'done');
  assert.equal(jira.count, 2);
  assert.ok(Date.parse(jira.readAt) > Date.now() - 60000);
  // 1분 안에 다시 누르면 막는다(서버 메모리에서 센다)
  const again = await app.ask('jira');
  assert.equal(again.status, 200, '결과를 알리는 답이라 200(브라우저 콘솔에 오류로 남지 않게)');
  assert.equal(again.reason, 'throttled');
  assert.equal(again.message, '방금 가져왔어요 — 1분 뒤에 다시 할 수 있어요');

  // 캘린더(비밀 주소) — 곧바로 다시 읽어 오늘 일정 수를 준다. 오늘 미팅도 그 값으로 바뀐다
  const calendar = await app.ask('calendar');
  assert.equal(calendar.status, 200);
  assert.equal(calendar.mode, 'done');
  assert.equal(calendar.count, 1);
  const items = await (await fetch(app.base + '/api/items')).json();
  assert.deepEqual(items.calendar.events.map(one => one.title), ['지금 읽은 회의']);

  // 슬랙 — launchd 파일이 없으면(옛 설치·setup 미실행) 파일을 쓰지 않고 안내만 한다. 1분 제한도 쓰지 않는다
  const missing = await app.ask('slack');
  assert.equal(missing.status, 200);
  assert.equal(missing.reason, 'not-installed');
  assert.equal(missing.message, '업데이트.command를 한 번 실행하면 쓸 수 있어요');
  assert.equal(fs.existsSync(app.request('slack-capture.request')), false, '등록이 없으면 요청 파일을 쓰지 않는다');
  app.plist('slack-capture-now');
  const slack = await app.ask('slack');
  assert.equal(slack.status, 200);
  assert.equal(slack.mode, 'requested');
  const asked = JSON.parse(fs.readFileSync(app.request('slack-capture.request'), 'utf8'));
  assert.deepEqual(Object.keys(asked), ['requestedAt']);
  assert.equal((await app.ask('slack')).reason, 'throttled');

  // 티로 — 이미 있는 미팅 노트 가져오기(오늘 모드) 길 그대로, tiro-sync plist가 있을 때만
  assert.equal((await app.ask('tiro')).reason, 'not-installed');
  assert.equal(fs.existsSync(app.request('tiro-sync.request')), false);
  app.plist('tiro-sync');
  const tiro = await app.ask('tiro');
  assert.equal(tiro.mode, 'requested');
  assert.equal(JSON.parse(fs.readFileSync(app.request('tiro-sync.request'), 'utf8')).scope, 'today');

  // 모르는 키는 거절
  const wrong = await app.ask('figma');
  assert.equal(wrong.status, 400);
  assert.equal(wrong.ok, false);

  // 응답·연동 상태·로그 어디에도 토큰·비밀 주소가 없다
  for (const one of [jira, again, calendar, missing, slack, tiro]) assert.ok(!SECRETS.test(one.text), one.text);
  const state = await (await fetch(app.base + '/api/integrations')).text();
  assert.ok(!SECRETS.test(state), '연동 상태에도 없다');
  assert.deepEqual(JSON.parse(state).jira.fetch, { failing: false, auth: false, failedAt: null });
  assert.ok(!SECRETS.test(app.log()), '서버 로그에도 없다');
  // 서버는 프로세스를 띄우지 않는다 — 이 경로 어디에도 child_process가 없다
  const route = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8').split('async function fetchNow(key) {')[1].split('\n}\n')[0];
  assert.ok(!/exec|spawn|execFile/.test(route), '지금 가져오기는 프로세스를 띄우지 않는다');
});

test('WP-D2.5 지금 가져오기 실패: 지라 401·비밀 주소 404는 auth, 연동 상태의 fetch도 실패 중·auth로, 슬랙은 로그의 invalid_auth로 가른다', async (t) => {
  const app = await startFetchServer(t, { mode: 'auth' });
  const jira = await app.ask('jira');
  assert.equal(jira.status, 200);
  assert.equal(jira.reason, 'auth');
  assert.match(jira.message, /다시 연결해 주세요/);
  const calendar = await app.ask('calendar');
  assert.equal(calendar.reason, 'auth');
  assert.ok(!SECRETS.test(jira.text + calendar.text));

  // 슬랙: 상태 탭과 같은 기준 — 가장 최근 실행이 실패이고 그 이유가 토큰이면 auth
  const slackLog = path.join(app.automation, 'logs', 'slack-capture.log');
  const stamp = offset => { const d = new Date(Date.now() - offset * 60000); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
  fs.writeFileSync(slackLog, `${stamp(30)} 새 메시지 없음 — Claude 호출 생략\n${stamp(10)} todo 채널 확인 실패 — ERR:invalid_auth\n`);
  fs.writeFileSync(path.join(app.automation, 'logs', 'tiro-sync.log'), `───── ${stamp(20)} tiro-sync 시작\n가져온 노트 1개\n───── ${stamp(19)} tiro-sync 종료 (exit 0)\n`);
  const state = await (await fetch(app.base + '/api/integrations')).json();
  assert.equal(state.jira.fetch.failing, true);
  assert.equal(state.jira.fetch.auth, true);
  assert.ok(state.jira.fetch.failedAt);
  assert.equal(state.calendar.fetch.failing, true);
  assert.equal(state.calendar.fetch.auth, true);
  assert.equal(state.slack.fetch.failing, true);
  assert.equal(state.slack.fetch.auth, true);
  assert.ok(Math.abs(Date.parse(state.slack.fetch.failedAt) - (Date.now() - 10 * 60000)) < 5000);
  assert.equal(state.meetingNotes.fetch.failing, false);
  assert.ok(state.meetingNotes.fetch.lastRunAt, '티로는 마지막으로 가져온 때를 준다');

  // 네트워크 같은 다른 실패는 auth가 아니다(슬랙: 토큰 말고 다른 오류)
  fs.writeFileSync(slackLog, `${stamp(5)} todo 채널 확인 실패 — ERR:ratelimited\n`);
  const other = await (await fetch(app.base + '/api/integrations')).json();
  assert.deepEqual([other.slack.fetch.failing, other.slack.fetch.auth], [true, false]);
  // 다음 실행이 성공하면 실패 중이 아니다(지난 실패는 접어 둔다)
  fs.appendFileSync(slackLog, `${stamp(1)} 새 메시지 없음 — Claude 호출 생략\n`);
  const healed = await (await fetch(app.base + '/api/integrations')).json();
  assert.equal(healed.slack.fetch.failing, false);
});

test('WP-D2.5 지금 가져오기(캘린더 Claude 갈래): calendar-sync-now plist가 있을 때만 calendar-sync.request를 쓰고, 상태 줄 시각은 calendar-sync 로그에서', async (t) => {
  const app = await startFetchServer(t, { calendarSource: 'claude' });
  assert.equal((await app.ask('calendar')).reason, 'not-installed');
  assert.equal(fs.existsSync(app.request('calendar-sync.request')), false);
  app.plist('calendar-sync-now');
  const asked = await app.ask('calendar');
  assert.equal(asked.mode, 'requested');
  assert.ok(Date.parse(JSON.parse(fs.readFileSync(app.request('calendar-sync.request'), 'utf8')).requestedAt));
  fs.writeFileSync(path.join(app.automation, 'logs', 'calendar-sync.log'), '───── 2026-09-24 10:13:00 calendar-sync 시작\n일정 3개\n───── 2026-09-24 10:14:00 calendar-sync 종료 (exit 0)\n');
  const state = await (await fetch(app.base + '/api/integrations')).json();
  assert.equal(state.calendar.fetch.failing, false);
  assert.equal(state.calendar.fetch.lastRunAt, new Date('2026-09-24T10:14:00').toISOString());
});

// run-task.sh가 calendar-sync를 실패로 바꾸며 남긴 ⚠️ 줄은 Claude의 긴 답 뒤에 붙는다 — 200자 자르기에 잘리지 않고 요약이 된다.
test('WP-S 캘린더(Claude 갈래): 캘린더 파일이 갱신되지 않아 exit 65로 끝난 실행은 실패 중이고, 멈춤 이유는 ⚠️ 줄이다', async (t) => {
  const app = await startFetchServer(t, { calendarSource: 'claude' });
  const warn = '⚠️ 캘린더 파일이 갱신되지 않았어요 — Claude에 구글 캘린더가 연결돼 있지 않으면 설정 › 연동 › 캘린더에서 비밀 주소로 바꾸거나 Claude 커넥터에서 연결해 주세요';
  const answer = 'Google Calendar MCP 도구를 찾지 못했어요. '.repeat(10);
  const logFile = path.join(app.automation, 'logs', 'calendar-sync.log');
  fs.writeFileSync(logFile, '───── 2026-09-24 10:13:00 calendar-sync 시작 (v1.2.1)\n' + answer + '\n\n' + warn + '\n\n───── 2026-09-24 10:14:00 calendar-sync 종료 (exit 65)\n');
  const state = await (await fetch(app.base + '/api/integrations')).json();
  assert.equal(state.calendar.fetch.failing, true);
  assert.equal(state.calendar.fetch.claudeAuth, false);
  assert.equal(state.calendar.fetch.summary, warn);
  assert.equal(state.calendar.log[0].kind, 'fail');
  assert.equal(state.calendar.log[0].text, warn);
  assert.ok(state.alerts.includes('calendar'), '톱니바퀴의 빨간 점·연동 탭 요약도 멈춤으로 본다');
  // 다음 실행이 파일을 갱신해 0으로 끝나면 실패 중이 아니다
  fs.appendFileSync(logFile, '───── 2026-09-24 11:13:00 calendar-sync 시작\n일정 3개\n───── 2026-09-24 11:14:00 calendar-sync 종료 (exit 0)\n');
  const healed = await (await fetch(app.base + '/api/integrations')).json();
  assert.equal(healed.calendar.fetch.failing, false);
  assert.equal(healed.alerts.includes('calendar'), false);
});

test('WP-D2.5 지라·캘린더 보관함은 마지막 실패의 갈래(auth)를 들고 있다가 성공하면 지운다', async () => {
  const { createJiraLive } = require('./jira-live');
  let answer = { ok: false, kind: 'auth' };
  const live = createJiraLive({ list: async () => answer, now: () => 1000 });
  await live.refresh();
  assert.deepEqual(live.failure(), { at: 1000, auth: true });
  answer = { ok: false, kind: 'network' };
  await live.refresh();
  assert.deepEqual(live.failure(), { at: 1000, auth: false });
  answer = { ok: true, connected: true, issues: [] };
  await live.refresh();
  assert.equal(live.failure(), null);

  let status = 403;
  const calendar = createCalendarLive({
    load: () => integrationsStore.fetchIcal('https://calendar.example.test/x.ics', async () => new Response('no', { status })),
    now: () => 2000,
  });
  await calendar.refresh();
  assert.deepEqual(calendar.failure(), { at: 2000, auth: true });
  status = 500;
  await calendar.refresh();
  assert.deepEqual(calendar.failure(), { at: 2000, auth: false });
  await assert.rejects(integrationsStore.fetchIcal('https://calendar.example.test/x.ics', async () => new Response('no', { status: 404 })),
    error => error.auth === true && !/calendar\.example\.test/.test(error.message));
});

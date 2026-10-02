// 써 보기 서버 — 가짜 데이터로 앱을 눌러 보는 자리(만든 사람 맥 전용, 저장소 뿌리 `tryout.sh`가 launchd에 올린다).
// browser-fixture.js의 임시 폴더 한 벌(prepareFixture)을 그대로 쓰고 그 위에 넉넉한 가짜 데이터를 심는다.
// 데이터·설정·토큰·자동화 폴더·LaunchAgents·local/·백업 자리가 전부 임시 폴더라 운영 앱(4321)과 실제 파일에 닿지 않고,
// 하나라도 실제 설치 위치를 가리키면 server.js의 안전망(WORKSPACE_FIXTURE)이 시작을 막는다.
// server.js를 모듈로 불러 쓰므로 운영에서만 켜는 타이머(지라·캘린더·슬랙 갱신·자동 업데이트)는 돌지 않는다.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

const DEFAULT_PORT = 4340;
const TITLE = '써 보기 · 가짜 데이터';
// 임시 폴더 안에 두는 이름표 — 시작할 때 이 파일이 있고 같은 포트의 것인 옛 폴더만 치운다(다른 픽스처·시험의 폴더는 건드리지 않는다).
const MARK = '.tryout-server';
const FOLDER_RE = /^workspace-browser-/;
const PARTS = ['data', 'repo', 'tokens', 'automation', 'LaunchAgents', 'Applications', 'workspace-data-backup'];
const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];

const pad = n => String(n).padStart(2, '0');
const dayFrom = (now, n = 0) => { const d = new Date(now); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const clock = minutes => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;

// 오늘 회의 세 개의 시각 — 가운데 것이 지금 진행 중이 되게 지금 시각에서 잡는다(자정 근처에서는 하루 안으로 접는다).
function meetingTimes(now = new Date()) {
  const at = now.getHours() * 60 + now.getMinutes();
  const live = Math.min(Math.floor(at / 30) * 30, 22 * 60 + 30);
  const span = start => [clock(start), clock(start + 60)];
  const before = live >= 120 ? live - 120 : null, after = live + 120 <= 22 * 60 + 30 ? live + 120 : null;
  // 앞뒤 자리가 없으면(새벽·늦은 밤) 남는 쪽에 둘을 나란히 둔다.
  const drafts = before !== null ? before : live + 240, empty = after !== null ? after : live - 240;
  return { drafts: span(drafts), live: span(live), empty: span(empty) };
}

const line = (kind, text, fields) => `- ${text} #${kind}[${Object.entries(fields).map(([key, value]) => `${key}:${value}`).join(' ')}]`;

// 가짜 업무 데이터 한 벌 — 이름·프로젝트는 전부 지어낸 것이고 날짜는 실행하는 날 기준이다.
function seedData(dataDir, now = new Date()) {
  const day = n => dayFrom(now, n), T = day(0);
  const task = (text, fields) => line('task', text, { status: 'to-do', ...fields });
  const slack = n => `slack:https://example.test/m/${n}`;
  const write = (name, lines) => fs.writeFileSync(path.join(dataDir, name), `${lines.join('\n')}\n`);
  write('tasks.md', ['# Tasks',
    // 오늘 할 일 10 — 끝낸 것 2 · 진행 중 1 · 기한 오늘/내일/3일/7일/10일 뒤/지남 · 중요 · 긴급
    task('가입 오류 문구 검토하기', { id: 't1', status: 'done', created: day(-2), completed: T, scheduled: T, group: '가입_개선' }),
    task('빈 화면 안내 확인하기', { id: 't2', status: 'done', created: day(-1), completed: T, scheduled: T, group: '가입_개선' }),
    task('운영툴 권한 표 확인하기', { id: 't3', created: day(-3), doing: day(-1), scheduled: T, group: '운영툴' }),
    task('결제 실패 사유 문구 3종 초안 쓰기', { id: 't4', priority: 'high', created: day(-1), scheduled: T, due: T, group: '결제_리뉴얼' }),
    task('환불 한도 정책 문서 다듬기', { id: 't5', created: day(-4), scheduled: T, due: day(1), group: '결제_리뉴얼' }),
    task('QA 체크리스트 공유하기', { id: 't6', created: day(-2), scheduled: T, due: day(3), group: '가입_개선' }),
    task('릴리스 노트 문장 다듬기', { id: 't7', created: day(-5), scheduled: T, due: day(7), group: '운영툴' }),
    task('온보딩 메일 문구 검토', { id: 't8', created: day(-3), scheduled: T, due: day(10), group: '가입_개선' }),
    task('지난 분기 지표 정리하기', { id: 't9', created: day(-9), scheduled: T, due: day(-2), group: '운영툴' }),
    task('알림 장애 공지 초안 쓰기', { id: 't10', priority: 'critical', created: T, scheduled: T, group: '앱_알림' }),
    // 나중에 4 — 날짜 정한 것 2 · 미정 2
    task('디자인 리뷰 일정 조율하기', { id: 'l1', created: day(-6), scheduled: 'none', group: '결제_리뉴얼' }),
    task('알림 설정 화면 요구사항 정리', { id: 'l2', created: day(-7), scheduled: day(3), group: '앱_알림' }),
    task('가입 퍼널 이탈 구간 살펴보기', { id: 'l3', created: day(-8), scheduled: day(5), due: day(6), group: '가입_개선' }),
    task('테스터 피드백 모아 보기', { id: 'l4', priority: 'low', created: day(-2), scheduled: 'none' }),
    // 새로 들어온 것 5 — 프로젝트 있는 것·없는 것·기한 있는 것
    task('결제 화면 오류 제보 확인', { id: 'i1', created: T, scheduled: 'none', inbox: 'true', source: slack(1) }),
    task('가입 안내 문구 검수 요청 답하기', { id: 'i2', created: T, scheduled: 'none', inbox: 'true', group: '가입_개선', source: slack(2) }),
    task('운영툴 접근 권한 요청 처리', { id: 'i3', created: day(-1), scheduled: 'none', inbox: 'true', group: '운영툴', source: slack(3) }),
    task('다음 주 데모 자료 준비 요청', { id: 'i4', created: T, scheduled: 'none', inbox: 'true', due: day(4), source: slack(4) }),
    task('정산 리포트 숫자 확인 요청', { id: 'i5', created: T, scheduled: 'none', inbox: 'true', source: slack(5) }),
    // 지난 주 기록 — 주간요약·내 일 기록이 비지 않게
    task('가입 화면 문구 1차 정리', { id: 'p1', status: 'done', created: day(-8), scheduled: day(-6), completed: day(-6), group: '가입_개선' }),
    task('결제 수단 목록 조사', { id: 'p2', status: 'done', created: day(-9), scheduled: day(-5), completed: day(-5), group: '결제_리뉴얼' }),
    task('운영툴 메뉴 이름 통일안 쓰기', { id: 'p3', status: 'done', created: day(-7), scheduled: day(-4), completed: day(-4), group: '운영툴' }),
    task('알림 문구 톤 점검', { id: 'p4', status: 'done', created: day(-6), scheduled: day(-3), completed: day(-3), group: '앱_알림' }),
    task('환불 화면 흐름 그려 보기', { id: 'p5', status: 'done', created: day(-5), scheduled: day(-2), completed: day(-2), group: '결제_리뉴얼' }),
    task('회의실 예약 정리', { id: 'p6', status: 'done', created: day(-3), scheduled: day(-1), completed: day(-1) }),
  ]);
  const check = (text, fields) => line('check', text, { status: 'to-do', priority: 'medium', ...fields });
  write('checks.md', ['# Checks',
    check('환불 한도 검토 회신', { id: 'w1', created: day(-4), who: '테스터A', due: day(-1), group: '결제_리뉴얼', source: slack(6) }),
    check('디자인 시안 2차 회신', { id: 'w2', created: day(-2), who: '테스터B', due: T, group: '가입_개선', source: slack(7) }),
    check('서버 배포 일정 확인', { id: 'w3', created: day(-1), who: '테스터C', group: '운영툴', source: slack(8) }),
    check('약관 문구 검토 회신', { id: 'w0', status: 'done', created: day(-8), completed: day(-4), who: '테스터A', group: '가입_개선' }),
  ]);
  write('decisions.md', [
    line('decision', '권한 정책은 기존 방식 유지', { id: 'd1', status: 'to-do', created: day(-1), group: '운영툴' }),
    line('decision', '영수증은 결제 완료 화면 하단 버튼으로 제공', { id: 'd2', status: 'to-do', created: T, group: '결제_리뉴얼' }),
  ]);
  write('ideas.md', [line('idea', '알림 묶어 보내기', { id: 'a1', status: 'to-do', priority: 'low', created: day(-3), project: '앱_알림' })]);
  // 캘린더는 Claude 갈래의 스냅샷 파일 모양 그대로 — 바깥 캘린더를 읽지 않는다.
  const times = meetingTimes(now);
  const meetings = [
    { key: 'drafts', title: '결제 리뉴얼 주간 회의' },
    { key: 'live', title: '가입 개선 스탠드업' },
    { key: 'empty', title: '운영툴 킥오프' },
  ].map(one => ({ ...one, start: times[one.key][0], end: times[one.key][1] })).sort((a, b) => a.start.localeCompare(b.start));
  write('calendar_today.md', [`마지막 갱신: ${T}`, '', ...meetings.map(one => `- ${one.start}-${one.end} | ${one.title}`)]);
  const drafts = meetings.find(one => one.key === 'drafts');
  fs.writeFileSync(path.join(dataDir, 'meeting_drafts.json'), `${JSON.stringify({ notes: [{
    noteGuid: 'tryout-note-1', noteTitle: drafts.title, webUrl: 'https://example.test/n/1', date: T, start: drafts.start, end: drafts.end, title: drafts.title,
    items: [
      { type: 'task', description: '환불 API 스펙 요청하기', due: day(3) },
      { type: 'task', description: '실패 사유 문구 3종 초안 쓰기' },
      { type: 'decision', description: '영수증은 결제 완료 화면 하단 고정 버튼으로 제공' },
      { type: 'check', description: '테스터B에게 디자인 일정 회신 받기' },
      { type: 'task', description: 'QA 범위 문서에 정산 화면 추가' },
    ],
  }] }, null, 2)}\n`);
}

// 임시 폴더 한 벌을 만들고 가짜 데이터·설정을 심는다. 슬랙은 "옛 토큰 방식으로 연결된 가짜 상태"다(진짜 토큰이 아니다).
function build(port, now = new Date()) {
  const { prepareFixture } = require('./browser-fixture');
  const { root, env } = prepareFixture({ slack: 'token' });
  try {
    fs.writeFileSync(path.join(root, MARK), `${JSON.stringify({ port, pid: process.pid })}\n`);
    const config = JSON.parse(fs.readFileSync(env.WORKSPACE_CONFIG, 'utf8'));
    config.title = TITLE;
    config.integrations = { ...(config.integrations || {}), calendar: true, tiro: true, jira: false };
    config.calendar = { ...(config.calendar || {}), source: 'claude' };
    fs.writeFileSync(env.WORKSPACE_CONFIG, `${JSON.stringify(config, null, 2)}\n`);
    seedData(env.WORKSPACE_DATA_DIR, now);
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });   // 심다 만 폴더는 남기지 않는다
    throw error;
  }
  return { root, env };
}

// 처음 상태로 — 새 폴더를 한 벌 더 만들어 심고, 그 내용물을 지금 폴더 자리로 바꿔 끼운다(서버가 기억하는 경로는 그대로다).
// 쓰는 곳은 자기 임시 폴더 둘뿐이다. 설정이 처음과 달라져 있었으면 true(서버 메모리의 제목·켬/끔이 어긋났다는 뜻).
function resetInPlace(current, port, now = new Date()) {
  const configPath = current.env.WORKSPACE_CONFIG;
  let before = null;
  try { before = fs.readFileSync(configPath, 'utf8'); } catch { /* 지워졌으면 달라진 것 */ }
  const fresh = build(port, now);
  // 새 폴더는 성공하든 실패하든 치운다. 바꿔 끼우기를 시작한 뒤에 실패하면 지금 폴더가 반쪽이라는 표시(`partial`)를 달아 던진다.
  let swapping = false;
  try {
    const freshConfig = fresh.env.WORKSPACE_CONFIG;
    fs.writeFileSync(freshConfig, fs.readFileSync(freshConfig, 'utf8').split(fresh.root).join(current.root));
    swapping = true;
    for (const name of PARTS) {
      fs.rmSync(path.join(current.root, name), { recursive: true, force: true });
      fs.renameSync(path.join(fresh.root, name), path.join(current.root, name));
    }
  } catch (error) {
    error.partial = swapping;
    throw error;
  } finally {
    fs.rmSync(fresh.root, { recursive: true, force: true });
  }
  return before !== fs.readFileSync(configPath, 'utf8');
}

// 죽을 때 못 지운 옛 임시 폴더 치우기 — 이름표가 있고 같은 포트의 것만(포트를 잡은 뒤에 부르므로 그 주인은 이미 없다).
function sweepStale(keepRoot, port, tmp = os.tmpdir()) {
  const removed = [];
  let names = [];
  try { names = fs.readdirSync(tmp); } catch { return removed; }
  for (const name of names) {
    const at = path.join(tmp, name);
    if (!FOLDER_RE.test(name) || at === keepRoot) continue;
    let mark = null;
    try { mark = JSON.parse(fs.readFileSync(path.join(at, MARK), 'utf8')); } catch { continue; }
    if (!mark || mark.port !== port) continue;
    try { fs.rmSync(at, { recursive: true, force: true }); removed.push(at); } catch { /* 다음에 */ }
  }
  return removed;
}

// `/__tryout` 두 경로를 받아도 되는 요청인가 — 이 맥의 브라우저(루프백 소켓 + localhost 주소)만, 쓰기는 같은 출처에서 온 것만.
function tryoutAllowed(req, port) {
  const headers = req.headers || {};
  const host = String(headers.host || '');
  if (!LOOPBACK.includes((req.socket || {}).remoteAddress)) return false;
  if (![`localhost:${port}`, `127.0.0.1:${port}`].includes(host)) return false;
  if (req.method !== 'POST') return true;
  // 출처 표시(Origin·Sec-Fetch-Site)가 둘 다 없는 POST는 받는다 — 브라우저는 폼 POST에 늘 붙이므로 없는 것은 이 맥의 curl류뿐이고,
  // 하는 일도 가짜 데이터를 처음으로 돌리는 것뿐이다.
  if (headers.origin && headers.origin !== `http://${host}`) return false;
  if (headers['sec-fetch-site'] && headers['sec-fetch-site'] !== 'same-origin') return false;
  return true;
}

const page = body => `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${TITLE}</title>
<style>body{font:16px/1.6 -apple-system,system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.25rem;color:#222;background:#fafafa}
h1{font-size:1.25rem}button{font:inherit;padding:.5rem 1rem;border:1px solid #888;border-radius:.5rem;background:#fff;cursor:pointer}a{color:inherit}
@media(prefers-color-scheme:dark){body{color:#eee;background:#1c1c1e}button{background:#2c2c2e;color:#eee}}</style>
${body}</html>`;
const HOME_PAGE = page(`<h1>${TITLE}</h1>
<p>가짜 데이터로 앱을 눌러 보는 자리예요. 여기서 한 일은 진짜 앱과 실제 업무 데이터에 닿지 않아요.</p>
<form method="post" action="/__tryout/reset"><button type="submit">처음 상태로</button></form>
<p><a href="/">앱으로 돌아가기</a></p>`);
const RESTART_PAGE = page(`<meta http-equiv="refresh" content="4;url=/"><h1>처음 상태로 돌리는 중이에요</h1>
<p>설정까지 되돌리느라 써 보기 서버를 다시 켜요. 몇 초 뒤에 앱이 열려요 — 안 열리면 <a href="/">여기</a>를 눌러 주세요.</p>`);
const HTML_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
};

// 이 프로세스에서 바깥으로 나가는 요청(fetch)을 통째로 막는다 — 앱 서버의 가드가 닿지 않는 길(연동 화면에서 사람이 누르는
// 슬랙 토큰·채널 확인, 지라·캘린더 연결 확인)까지. 써 보기 서버 자신은 fetch를 쓰지 않는다. 막은 곳은 주소의 호스트만 기록한다.
function blockOutbound() {
  globalThis.fetch = input => {
    let host = '';
    try { host = new URL(typeof input === 'string' ? input : input.url || String(input)).host; } catch { host = '?'; }
    console.error(`바깥 요청을 막았어요: ${host}`);
    return Promise.reject(new Error('써 보기 서버는 바깥에 요청하지 않아요'));
  };
}

// 처음 상태로 돌리기와 날짜 바뀜 확인을 한 묶음으로 — 시계(`now`)와 끝내기(`exit`)는 시험이 끼운다.
// `reset()`은 "다시 켜져야 한다"(설정까지 바뀌어 있었고 launchd가 다시 띄워 주는 자리)를 돌려준다.
// 바꿔 끼우다 실패해 폴더가 반쪽이면 어디서 띄웠든 스스로 끝낸다(자기 자신만) — 반쪽 데이터로 계속 돌지 않게.
function createKeeper({ current, port, keepAlive = false, now = () => new Date(), exit = code => process.exit(code) }) {
  let seededDay = dayFrom(now());
  const reset = () => {
    let changed = false;
    try { changed = resetInPlace(current, typeof port === 'function' ? port() : port, now()); } catch (error) {
      if (error.partial) { console.error('처음 상태로 돌리다 멈춰서 써 보기 서버를 끝내요:', error.message); exit(1); }
      throw error;
    }
    seededDay = dayFrom(now());
    return changed && keepAlive;
  };
  // 맥이 계속 켜져 있으면 "오늘" 데이터가 어제 것이 된다 — 날짜가 바뀌었으면 처음 상태로 돌린다(1분마다 부른다).
  const tick = () => {
    if (dayFrom(now()) === seededDay) return false;
    try { if (reset()) exit(0); } catch (error) { console.error('날짜가 바뀌어 처음 상태로 돌리려다 실패했어요(1분 뒤 다시):', error.message); }
    return true;
  };
  return { reset, tick };
}

function main() {
  // `TRYOUT_PORT=0`은 시험용이다 — 빈 포트를 운영체제가 골라 주고(임시 포트 범위), 뜬 뒤에 그 포트로 판단한다.
  let port = Number(process.env.TRYOUT_PORT || DEFAULT_PORT);
  // 4321~4331은 운영 앱과 슬랙 연결이 쓰는 자리다 — 그 포트에서는 `슬랙 연결` 버튼이 살아나므로 열지 않는다.
  const refused = value => !Number.isInteger(value) || value < 1024 || value > 65535 || require('./slack-oauth').portAllowed(value);
  if (port !== 0 && refused(port)) {
    console.error(`써 보기 서버는 ${port} 포트에서 열지 않아요 — 4321~4331(운영 앱·슬랙 연결 자리) 밖의 포트를 골라 주세요.`);
    process.exit(1);
  }
  // 바깥에서 물려받은 값이 실제 자리·바깥 전송을 켜지 못하게 지우고, 임시 폴더 한 벌로 덮어쓴다.
  blockOutbound();
  for (const name of ['WORKSPACE_MANAGED', 'WORKSPACE_CHECKIN', 'WORKSPACE_SLACK_FOLLOW', 'WORKSPACE_HOST', 'WORKSPACE_PORT']) delete process.env[name];
  const current = build(port);
  process.on('exit', () => { try { fs.rmSync(current.root, { recursive: true, force: true }); } catch { /* 다음 시작 때 치운다 */ } });
  Object.assign(process.env, current.env, { WORKSPACE_NO_SLACK_REFRESH: '1' });
  // 설정까지 바뀌었을 때는 launchd가 다시 띄워 주는 자리(tryout.sh가 넘긴다)에서만 스스로 끝난다 — 손으로 띄운 서버는 그대로 둔다.
  const { reset, tick } = createKeeper({ current, port: () => port, keepAlive: process.env.TRYOUT_KEEPALIVE === '1' });

  const { server } = require('./server');   // 실제 설치 위치를 가리키면 여기서 안전망이 끝낸다
  const [app] = server.listeners('request');
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    const route = String(req.url || '').split('?')[0];
    if (route !== '/__tryout' && route !== '/__tryout/reset') { app(req, res); return; }
    req.resume();
    if (!tryoutAllowed(req, port)) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Forbidden request'); return; }
    if (route === '/__tryout' && req.method === 'GET') { res.writeHead(200, HTML_HEADERS); res.end(HOME_PAGE); return; }
    if (route === '/__tryout/reset' && req.method === 'POST') {
      let restart = false;
      try { restart = reset(); } catch (error) {
        console.error('처음 상태로 돌리지 못했어요:', error.message);
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('처음 상태로 돌리지 못했어요 — tryout.sh restart로 다시 켜 주세요.');
        return;
      }
      if (!restart) { res.writeHead(303, { Location: '/', 'Cache-Control': 'no-store' }); res.end(); return; }
      res.writeHead(200, { ...HTML_HEADERS, Connection: 'close' });
      res.end(RESTART_PAGE, () => process.exit(0));
      return;
    }
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Method not allowed');
  });

  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `${port} 포트를 다른 프로그램이 쓰고 있어서 써 보기 서버를 열지 못했어요.` : `써 보기 서버를 열지 못했어요: ${error.message}`);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    if (port === 0) {
      port = server.address().port;
      if (refused(port)) { console.error(`써 보기 서버는 ${port} 포트에서 열지 않아요.`); process.exit(1); }
      fs.writeFileSync(path.join(current.root, MARK), `${JSON.stringify({ port, pid: process.pid })}\n`);
    }
    sweepStale(current.root, port);
    console.log(`써 보기 서버: http://localhost:${port} (처음 상태로: http://localhost:${port}/__tryout)`);
  });
  setInterval(tick, 60 * 1000).unref();
  const stop = () => { if (server.closeAllConnections) server.closeAllConnections(); server.close(() => process.exit(0)); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}

if (require.main === module) main();

module.exports = { seedData, meetingTimes, resetInPlace, build, sweepStale, tryoutAllowed, createKeeper, DEFAULT_PORT, TITLE, MARK };

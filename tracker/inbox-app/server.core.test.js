// 서버: 화면 파일 차단·항목·워크플로·회의·삭제한 항목·프로젝트 이름/별칭. 공용 준비는 test-support.js.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const support = require('./test-support');
const { directory, server, date, today, shifted, tasksPath, readTasks, post, items, deadPid, journalEntry, startServer, readJson } = support;
let base;
before(async () => { base = await support.ready(); });

test('static server denies implementation and private state files', async () => {
  assert.equal((await fetch(base+'/server.js')).status,404);
  assert.equal((await fetch(base+'/.weekly_report_state.json')).status,404);
});
// 화면 코드가 여러 파일이라 세 곳(index.html의 <script>, 정적 파일 허용, appVersion)이 어긋나면
// 화면이 조용히 깨진다(404 · 자동 새로고침 누락). 셋이 같은 집합을 보는지 여기서 못 박는다.
// 허용은 이름을 적지 않고 패턴으로 하므로, 나가면 안 되는 서버 파일은 아래에서 따로 확인한다.
test('every screen script is served and counted in appVersion, and server files never are', async () => {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script src="\/([\w.-]+\.js)"><\/script>/g)].map(match => match[1]);
  assert.ok(scripts.includes('app.js'), 'index.html이 app.js를 읽어야 한다');
  for (const name of scripts) {
    const response = await fetch(base + '/' + name);
    assert.equal(response.status, 200, `${name}은 화면에 나가야 한다`);
    assert.match(response.headers.get('content-type') || '', /javascript/);
  }
  // 이 폴더의 `*.js`/`*.css` 가운데 실제로 나가는 것 = appVersion이 세는 것(index.html 한 줄을 더한 수).
  const candidates = fs.readdirSync(__dirname).filter(name => /\.(js|css)$/.test(name)).sort();
  const served = [];
  for (const name of candidates) {
    if ((await fetch(base + '/' + name)).status === 200) served.push(name);
  }
  assert.ok(served.includes('ui.css') && scripts.every(name => served.includes(name)));
  assert.equal((await items()).appVersion.split(':').length, served.length + 1,
    'appVersion은 index.html + 나가는 화면 파일 전부를 센다');
  // 브라우저에 절대 나가면 안 되는 파일들 — 서버·저장소·테스트·픽스처.
  // 목록을 여기에 따로 적지 않는다: 서버의 차단 목록(CLIENT_BLOCKED)을 그대로 가져와 전부 막히는지 보고,
  // 이 폴더의 `*.js` 가운데 index.html이 읽지 않는 것(= 서버용)은 목록·패턴에 하나도 빠짐없이 걸리는지 본다.
  // 새 서버 파일을 만들고 목록에 넣지 않으면 여기서 실패한다.
  const { CLIENT_BLOCKED, isClientFile } = require('./server');
  assert.ok(CLIENT_BLOCKED.size > 0);
  for (const name of CLIENT_BLOCKED) {
    assert.equal(isClientFile(name), false, `${name}은 차단 목록에 있으니 화면 파일이 아니다`);
    assert.equal((await fetch(base + '/' + name)).status, 404, `${name}은 화면에 나가면 안 된다`);
  }
  const serverSide = fs.readdirSync(__dirname).filter(name => /\.js$/.test(name) && !scripts.includes(name)).sort();
  assert.ok(serverSide.includes('server.js'));
  for (const name of serverSide) {
    assert.equal(isClientFile(name), false, `${name}은 화면이 읽지 않는 서버용 파일이라 차단 목록·패턴에 걸려야 한다`);
    assert.equal((await fetch(base + '/' + name)).status, 404, `${name}은 화면에 나가면 안 된다`);
  }
  assert.equal((await fetch(base + '/automation/run-task.sh')).status, 404);
});

test('the screen stylesheet is served', async () => {
  const response = await fetch(base + '/ui.css');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/css/);
});
test('the embedded font is served, and nothing else under /fonts', async () => {
  const font = await fetch(base + '/fonts/PretendardVariable.woff2');
  assert.equal(font.status, 200);
  assert.match(font.headers.get('content-type') || '', /font\/woff2/);
  // 허용한 것은 `/fonts/<이름>.woff2` 하나뿐이다 — 상위 경로 탈출도, 다른 확장자도 열리지 않는다.
  assert.equal((await fetch(base + '/fonts/../server.js')).status, 404);
  assert.equal((await fetch(base + '/fonts/x.txt')).status, 404);
  assert.equal((await fetch(base + '/fonts/Pretendard-LICENSE.txt')).status, 404);
});
test('cross-origin mutations are rejected',async()=>{
  const response=await fetch(base+'/api/track/toggle',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://untrusted.example'},body:JSON.stringify({id:'legacy'})});
  assert.equal(response.status,403);
});
test('multiline creation fails without changing tasks',async()=>{
  const before=readTasks();assert.equal((await post('/api/today-task/create',{description:'first\nsecond'})).status,400);assert.equal(readTasks(),before);
});
test('a later task keeps its deadline and stays unscheduled',async()=>{
  const created=await post('/api/later-task/create',{description:'Backlog with a deadline',due:'2026-12-31'});
  assert.equal(created.ok,true);
  assert.match(readTasks(),new RegExp(`id:${created.id} [^\\n]*scheduled:none due:2026-12-31`));
  const later=(await items()).laterTasks.find(task=>task.id===created.id);
  assert.equal(later.due,'2026-12-31');assert.equal(later.scheduled,null);
});
test('explicit completion is safe to retry',async()=>{
  await post('/api/track/toggle',{id:'legacy',status:'done'});await post('/api/track/toggle',{id:'legacy',status:'done'});
  assert.equal((await items()).reportRefs.legacy.status,'done');
});
test('full item reads never create or rewrite weekly report files',async()=>{
  const file=path.join(directory,'weekly_reports.md');const before=fs.existsSync(file)?fs.readFileSync(file,'utf8'):null;await items();assert.equal(fs.existsSync(file)?fs.readFileSync(file,'utf8'):null,before);
});

test('여러 주에 걸친 기록도 주간 보고에 주마다 제 내용만 담긴다',async()=>{
  const older=shifted(-21),newer=shifted(-7);
  const week=value=>{const d=new Date(`${value}T12:00:00`);d.setDate(d.getDate()-((d.getDay()+6)%7));return date(d);};
  fs.writeFileSync(tasksPath,`# Tasks\n- 지난달 마감 업무 #task[id:wk-old status:done priority:medium created:${older} completed:${older}]\n- 지난주 마감 업무 #task[id:wk-new status:done priority:medium created:${newer} completed:${newer}]\n`);
  const reports=(await items()).weeklyReports;
  const weekText=key=>reports.find(report=>report.weekKey===key)?.draft.rows.map(row=>row.text).join('\n') || '';
  assert.ok(reports.length>=2);assert.ok(reports.every(report=>Array.isArray(report.draft?.rows)));
  assert.match(weekText(week(older)),/지난달 마감 업무/);assert.doesNotMatch(weekText(week(older)),/지난주 마감 업무/);
  assert.match(weekText(week(newer)),/지난주 마감 업무/);assert.doesNotMatch(weekText(week(newer)),/지난달 마감 업무/);
});
test('repeated create with a request key creates only once',async()=>{
  const call=()=>fetch(base+'/api/today-task/create',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'fixture-request-0001'},body:JSON.stringify({description:'재시도 업무'})}).then(r=>r.json());
  const a=await call(),b=await call();assert.equal(a.id,b.id);assert.equal(readTasks().split('재시도 업무').length-1,1);
});
test('automation import validates, deduplicates source links, and uses inbox',async()=>{
  const payload={type:'task',description:'자동화 수집',permalink:'https://example.test/import-fixture'};
  const a=await post('/api/import',{kind:'item',payload});const b=await post('/api/import',{kind:'item',payload:{...payload,description:'다시 표현'}});
  assert.equal(a.ok,true);assert.equal(a.id,b.id);assert.equal(b.duplicate,true);assert.ok((await items()).inboxTasks.some(item=>item.id===a.id));
  const before=readTasks();assert.equal((await post('/api/import',{kind:'item',payload:{...payload,description:'줄\n바꿈'}})).status,400);assert.equal(readTasks(),before);
});
test('a successful Slack channel cannot conceal another channel failure',async()=>{
  await post('/api/import',{kind:'health',payload:{channel:'my-todo',success:false,error:'fixture failure'}});
  await post('/api/import',{kind:'health',payload:{channel:'my-align',success:true}});
  const state=JSON.parse(fs.readFileSync(path.join(directory,'.slack_capture_state.json'),'utf8'));assert.match(state.lastError,/my-todo/);
});

test('workflow metadata validates links and dates and survives item completion', async () => {
  const check = await post('/api/waiting/create', { description: '담당자 확인' });
  assert.equal((await post('/api/workflow/item', { id: check.id, followUp: today, contacted: today })).ok, true);
  assert.equal((await post('/api/workflow/item', { id: 'legacy', blockedBy: check.id, outcome: '담당자 확정' })).ok, true);
  const before = fs.readFileSync(path.join(directory, '.workflow.json'), 'utf8');
  assert.equal((await post('/api/workflow/item', { id: check.id, followUp: '2026-02-30' })).status, 400);
  assert.equal((await post('/api/workflow/item', { id: 'legacy', blockedBy: 'unseen' })).status, 400);
  assert.equal(fs.readFileSync(path.join(directory, '.workflow.json'), 'utf8'), before);
  await post('/api/track/toggle', { id: check.id });
  const data = (await items()).workflows;
  assert.equal(data.items.find(item => item.id === 'legacy').blockedBy, check.id);
  assert.equal(data.items.find(item => item.id === check.id).status, 'done');
});

test('meeting capture persists across calendar rollover and resolves live completion state', async () => {
  fs.writeFileSync(path.join(directory, 'calendar_today.md'), `마지막 갱신: ${today}\n- 10:00-11:00 | 반복 회의\n- 14:00-15:00 | 반복 회의\n`);
  const events = (await items()).workflows.meetings;
  assert.equal(events.length, 2);
  assert.notEqual(events[0].id, events[1].id);
  const meeting = events[0];
  await post('/api/workflow/meeting', { id: meeting.id, project: 'group:기획', series: '기획 주간회의' });
  const created = await post('/api/workflow/capture', { meetingId: meeting.id, type: 'task', description: '후속 작업' });
  assert.equal(created.ok, true);
  fs.writeFileSync(path.join(directory, 'calendar_today.md'), `마지막 갱신: ${shifted(1)}\n- 10:00-11:00 | 새로운 회의\n`);
  await post('/api/track/toggle', { id: created.id });
  const data = (await items()).workflows;
  assert.equal(data.meetings.find(event => event.id === meeting.id).series, '기획 주간회의');
  assert.equal(data.items.find(item => item.id === created.id).meetingId, meeting.id);
  assert.equal(data.items.find(item => item.id === created.id).group, '기획');
  assert.equal(data.items.find(item => item.id === created.id).status, 'done');
  const original = readTasks();
  assert.equal((await post('/api/workflow/capture', { meetingId: 'missing', type: 'task', description: '생성 금지' })).status, 400);
  assert.equal(readTasks(), original);
});

test('completed outcome is used in the report draft text', async () => {
  await post('/api/workflow/item', { id: 'legacy', outcome: '디자인 전달일 금요일로 확정' });
  await post('/api/track/toggle', { id: 'legacy' });
  const rows = (await items()).weeklyReports.flatMap(report => report.draft?.rows || []);
  assert.ok(rows.some(row => row.sourceIds.includes('legacy') && row.text.includes('디자인 전달일 금요일로 확정')));
});

// 확인 대기의 `답변 한 줄`은 업무의 `결과 한 줄`과 같은 칸(outcome)에 담긴다 — 주간요약 문장이 되는 값이다.
test('답변 한 줄은 확인 대기에도 담기고, 결정·아이디어는 그대로 거절한다', async () => {
  const check = await post('/api/waiting/create', { description: '번역 벤더 확인 회신 받기' });
  assert.equal((await post('/api/workflow/item', { id: check.id, outcome: '벤더는 A사로 확정' })).ok, true);
  assert.equal((await items()).workflows.items.find(item => item.id === check.id).outcome, '벤더는 A사로 확정');
  // 업무 규칙은 그대로다
  assert.equal((await post('/api/workflow/item', { id: 'legacy', outcome: '업무 결과 한 줄' })).ok, true);
  const decision = await post('/api/decision/create', { description: '정산 주기는 매주 화요일' });
  const idea = await post('/api/idea/create', { description: '온보딩에 진행률 바' });
  assert.equal((await post('/api/workflow/item', { id: decision.id, outcome: '결정에는 결과가 없다' })).status, 400);
  assert.equal((await post('/api/workflow/item', { id: idea.id, outcome: '아이디어에도 없다' })).status, 400);
  // 한 줄·1,000자 규칙도 확인 대기에 그대로 걸린다
  assert.equal((await post('/api/workflow/item', { id: check.id, outcome: 'ㄱ'.repeat(1001) })).status, 400);
  assert.equal((await post('/api/workflow/item', { id: check.id, outcome: '두\n줄' })).status, 400);
  assert.equal((await items()).workflows.items.find(item => item.id === check.id).outcome, '벤더는 A사로 확정');
});

test('주간요약의 `확인 완료` 문장은 답변 한 줄을 그대로 쓴다', async () => {
  const check = await post('/api/waiting/create', { description: '법무 검토 회신 받기' });
  await post('/api/workflow/item', { id: check.id, outcome: '법무 검토 통과, 문구 수정 없음' });
  await post('/api/track/toggle', { id: check.id });
  const rows = (await items()).weeklyReports.flatMap(report => report.draft?.rows || []);
  const row = rows.find(entry => entry.sourceIds.includes(check.id));
  assert.equal(row.heading, '확인 완료');
  assert.equal(row.text, '법무 검토 통과, 문구 수정 없음');
});

test('workflow GET remains read-only', async () => {
  const before = fs.readFileSync(path.join(directory, '.workflow.json'), 'utf8');
  await items();
  assert.equal(fs.readFileSync(path.join(directory, '.workflow.json'), 'utf8'), before);
});

test('existing items can be linked to a meeting without duplication or reassignment', async () => {
  fs.writeFileSync(path.join(directory, 'calendar_today.md'), `마지막 갱신: ${today}\n- 10:00-11:00 | 회의 A\n- 14:00-15:00 | 회의 B\n`);
  const events = (await items()).workflows.meetings;
  const original = readTasks();
  assert.equal((await post('/api/workflow/link', { id: 'legacy', meetingId: events[0].id })).ok, true);
  assert.equal((await post('/api/workflow/link', { id: 'legacy', meetingId: events[1].id })).status, 400);
  assert.equal(readTasks(), original);
  assert.equal((await items()).workflows.items.find(item => item.id === 'legacy').meetingId, events[0].id);
});

// ---------- 담은 항목의 종류 바꾸기 (같은 id로 파일만 옮긴다) ----------
const lineOf = (file, id) => (fs.existsSync(path.join(directory, file))
  ? fs.readFileSync(path.join(directory, file), 'utf8').split('\n').find(line => line.includes(`id:${id} `) || line.includes(`id:${id}]`))
  : undefined);

test('종류 바꾸기는 같은 id로 파일을 옮기고 회의 연결·검토 기록을 지킨다', async () => {
  fs.writeFileSync(path.join(directory, 'calendar_today.md'), `마지막 갱신: ${today}\n- 09:00-10:00 | 종류 바꾸기 회의\n`);
  const meeting = (await items()).workflows.meetings[0];
  const created = await post('/api/workflow/capture', { meetingId: meeting.id, type: 'check', description: '종류를 바꿀 확인 대기', due: shifted(3) });
  assert.equal(created.ok, true);
  await post('/api/workflow/item', { id: created.id, followUp: today, contacted: today });
  assert.ok(lineOf('checks.md', created.id));

  const moved = await post('/api/workflow/retype', { id: created.id, type: 'decision' });
  assert.deepEqual({ ok: moved.ok, id: moved.id, type: moved.type, from: moved.from }, { ok: true, id: created.id, type: 'decision', from: 'check' });
  assert.equal(lineOf('checks.md', created.id), undefined, '옛 파일에서는 빠지고');
  const line = lineOf('decisions.md', created.id);
  assert.match(line, /#decision\[/, '새 파일에 같은 번호로 들어간다');
  assert.match(line, /^- 종류를 바꿀 확인 대기 /, '문구는 그대로다');
  assert.match(line, new RegExp(`id:${created.id} `));
  assert.doesNotMatch(line, /due:/, '결정에는 날짜가 없다');
  assert.doesNotMatch(line, /who:/);

  const data = (await items()).workflows;
  const item = data.items.find(entry => entry.id === created.id);
  assert.equal(item.type, 'decision');
  assert.equal(item.meetingId, meeting.id, '회의 연결은 번호가 같아 그대로 남는다');
  assert.equal(item.followUp, undefined, '확인 대기의 칸은 함께 정리된다');
  assert.equal(item.contacted, undefined);
});

test('세 방향 전환 모두 되고, 할 일로 올 때는 나중에 할 일로 들어간다', async () => {
  const created = await post('/api/today-task/create', { description: '세 방향 전환 업무', due: shifted(5), priority: 'high' });
  assert.equal((await post('/api/workflow/retype', { id: created.id, type: 'check' })).ok, true);
  let line = lineOf('checks.md', created.id);
  assert.match(line, /#check\[/);
  assert.match(line, /priority:high/, '우선순위는 세 종류 모두 파일에 적는 칸이라 남는다');
  assert.match(line, new RegExp(`due:${shifted(5)}`), '확인 대기에도 날짜가 있다(답변 받을 날)');
  assert.doesNotMatch(line, /scheduled:/, '실행 예정일은 할 일의 칸이다');

  assert.equal((await post('/api/workflow/retype', { id: created.id, type: 'decision' })).ok, true);
  assert.doesNotMatch(lineOf('decisions.md', created.id), /due:/);

  assert.equal((await post('/api/workflow/retype', { id: created.id, type: 'task' })).ok, true);
  line = lineOf('tasks.md', created.id);
  assert.match(line, /#task\[/);
  assert.match(line, /scheduled:none/, '종류를 바꿨다고 오늘 목록이 채워지지 않는다');
  const lists = await items();
  assert.ok(lists.laterTasks.some(task => task.id === created.id));
  assert.ok(!lists.todayTasks.some(task => task.id === created.id));
});

test('종류 바꾸기는 완료한 항목·같은 종류·없는 항목을 거절하고 파일을 건드리지 않는다', async () => {
  const done = await post('/api/waiting/create', { description: '이미 끝난 확인' });
  await post('/api/track/toggle', { id: done.id, status: 'done' });
  const checks = fs.readFileSync(path.join(directory, 'checks.md'), 'utf8');
  const refused = await post('/api/workflow/retype', { id: done.id, type: 'decision' });
  assert.equal(refused.status, 400);
  assert.match(refused.error, /완료한 항목은 종류를 바꿀 수 없어요/);
  assert.equal((await post('/api/workflow/retype', { id: done.id, type: 'check' })).status, 400, '같은 종류는 거절한다');
  assert.equal((await post('/api/workflow/retype', { id: 'missing-id', type: 'task' })).status, 400);
  assert.equal((await post('/api/workflow/retype', { id: 'legacy', type: 'idea' })).status, 400, '아이디어로는 바꾸지 않는다');
  assert.equal(fs.readFileSync(path.join(directory, 'checks.md'), 'utf8'), checks);
  assert.match(readTasks(), /id:legacy /);
});

test('종류 바꾸기도 같은 요청 식별자로 두 번 보내면 한 번만 옮긴다', async () => {
  const created = await post('/api/later-task/create', { description: '재시도 전환 업무' });
  const call = () => fetch(base + '/api/workflow/retype', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'fixture-retype-0001' },
    body: JSON.stringify({ id: created.id, type: 'decision' }),
  }).then(response => response.json());
  const a = await call(), b = await call();
  assert.deepEqual(a, b);
  assert.equal(fs.readFileSync(path.join(directory, 'decisions.md'), 'utf8').split(created.id).length - 1, 1);
  assert.equal(lineOf('tasks.md', created.id), undefined);
});

// ---------- 결정의 `내용`(note) ----------
test('결정의 내용은 .workflow.json에만 담기고 decisions.md는 그대로다', async () => {
  const decision = await post('/api/decision/create', { description: '정산 주기는 매주 화요일로 한다' });
  const before = fs.readFileSync(path.join(directory, 'decisions.md'), 'utf8');
  const note = '배경: 벤더 정산이 월요일에 몰렸다.\n예외: 공휴일이면 다음 영업일.';
  assert.equal((await post('/api/workflow/item', { id: decision.id, note })).ok, true);
  assert.equal(fs.readFileSync(path.join(directory, 'decisions.md'), 'utf8'), before, '업무 파일의 형식은 건드리지 않는다');
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, '.workflow.json'), 'utf8')).items[decision.id].note, note);
  assert.equal((await items()).workflows.items.find(item => item.id === decision.id).note, note);
  // 종류를 가리지 않고 적을 수 있고(업무에도), 4,000자를 넘으면 거절한다.
  assert.equal((await post('/api/workflow/item', { id: 'legacy', note: '업무에도 적을 수 있다' })).ok, true);
  assert.equal((await post('/api/workflow/item', { id: decision.id, note: 'ㄱ'.repeat(4001) })).status, 400);
  assert.equal((await post('/api/workflow/item', { id: decision.id, note: 4000 })).status, 400);
  assert.equal((await post('/api/workflow/item', { id: decision.id, note: 'ㄱ'.repeat(4000) })).ok, true);
  // 지우는 것은 빈 글자다.
  assert.equal((await post('/api/workflow/item', { id: decision.id, note: '' })).ok, true);
  assert.equal((await items()).workflows.items.find(item => item.id === decision.id).note, '');
});

test('내용을 적어도 주간요약 문장은 그대로다', async () => {
  await post('/api/workflow/item', { id: 'legacy', outcome: '디자인 전달일 확정' });
  await post('/api/track/toggle', { id: 'legacy' });
  const textOf = data => data.weeklyReports.flatMap(report => report.draft?.rows || []).filter(row => row.sourceIds.includes('legacy')).map(row => row.text).join('|');
  const before = textOf(await items());
  await post('/api/workflow/item', { id: 'legacy', note: '주간요약에는 나가지 않는 본문' });
  assert.equal(textOf(await items()), before);
});

test('note 칸이 없는 옛 흐름 기록도 그대로 읽힌다', async () => {
  fs.writeFileSync(path.join(directory, '.workflow.json'), JSON.stringify({ items: { legacy: { meetingId: null } }, meetings: {} }));
  const item = (await items()).workflows.items.find(entry => entry.id === 'legacy');
  assert.equal(item.note, undefined);
  assert.equal((await post('/api/workflow/item', { id: 'legacy', note: '나중에 적은 내용' })).ok, true);
  assert.equal((await items()).workflows.items.find(entry => entry.id === 'legacy').note, '나중에 적은 내용');
});

test('calendar archive preserves meetings without captured items and reads do not write', () => {
  let events = [{ title: '기록할 회의', start: '09:00', end: '10:00' }];
  const store = require('./workflow-store')({ directory, refs: () => ({}), calendar: () => ({ events }), today: () => today });
  store.archive();
  const before = fs.readFileSync(path.join(directory, '.workflow.json'), 'utf8');
  events = [];
  store.archive();
  assert.equal(store.snapshot().meetings.length, 1);
  assert.equal(fs.readFileSync(path.join(directory, '.workflow.json'), 'utf8'), before);
});

test('GET is read-only and does not clear unread flags or overwrite overdue deadlines', async () => {
  const original = readTasks();
  const first = await items();
  const second = await items();
  assert.equal(readTasks(), original);
  assert.equal(first.todayTasks.find(item => item.id === 'legacy').due, shifted(-2));
  assert.equal(second.todayTasks.find(item => item.id === 'legacy').isNew, true);
});

test('batch rescheduling preserves deadlines and undo restores legacy schedules', async () => {
  const changed = await post('/api/workflow/task-batch', { ids: ['legacy', 'unseen'], change: { scheduled: shifted(1) } });
  assert.equal(changed.ok, true);
  let data = await items();
  assert.equal(data.laterTasks.find(item => item.id === 'legacy').due, shifted(-2));
  assert.equal(data.laterTasks.find(item => item.id === 'unseen').scheduled, shifted(1));
  const restored = await post('/api/workflow/task-batch', { undoToken: changed.undoToken });
  assert.equal(restored.ok, true);
  data = await items();
  assert.equal(data.todayTasks.find(item => item.id === 'legacy').scheduled, shifted(-2));
  assert.doesNotMatch(readTasks().split('\n').find(line => line.includes('id:legacy')), /scheduled:/);
  assert.equal((await post('/api/workflow/task-batch', { undoToken: restored.undoToken })).ok, true);
  assert.equal((await items()).laterTasks.find(item => item.id === 'legacy').scheduled, shifted(1));
});

test('invalid batch targets and dates never partially modify tasks', async () => {
  const original = readTasks();
  assert.equal((await post('/api/workflow/task-batch', { ids: ['legacy', 'missing'], change: { project: 'group:수정 금지' } })).status, 400);
  assert.equal((await post('/api/workflow/task-batch', { ids: ['legacy', 'unseen'], change: { scheduled: '2026-02-30' } })).status, 400);
  assert.equal((await post('/api/workflow/task-batch', { ids: ['legacy', 'legacy'], change: { scheduled: today } })).status, 400);
  assert.equal(readTasks(), original);
});

test('batch group undo preserves later title edits but rejects conflicting group edits', async () => {
  await post('/api/track/set-jira', { id: 'legacy', jiraKey: 'IO-123' });
  const changed = await post('/api/workflow/task-batch', { ids: ['legacy', 'unseen'], change: { project: 'group:새 그룹' } });
  assert.equal(changed.ok, true);
  assert.equal((await items()).todayTasks.find(item => item.id === 'legacy').jira, null);
  await post('/api/track/set-description', { id: 'legacy', description: '나중에 수정한 제목' });
  assert.equal((await post('/api/workflow/task-batch', { undoToken: changed.undoToken })).ok, true);
  const task = (await items()).todayTasks.find(item => item.id === 'legacy');
  assert.equal(task.description, '나중에 수정한 제목');
  assert.equal(task.jira, 'IO-123');
  const changedAgain = await post('/api/workflow/task-batch', { ids: ['legacy', 'unseen'], change: { project: null } });
  await post('/api/track/set-group', { id: 'unseen', group: '다른 편집' });
  const beforeUndo = readTasks();
  assert.equal((await post('/api/workflow/task-batch', { undoToken: changedAgain.undoToken })).status, 400);
  assert.equal(readTasks(), beforeUndo);
});

test('일괄 완료는 오늘 날짜로 끝내고, 실행 취소는 완료 표시를 걷어낸다', async () => {
  const changed = await post('/api/workflow/task-batch', { ids: ['legacy', 'unseen'], change: { status: 'done' } });
  assert.equal(changed.ok, true);
  const line = id => readTasks().split('\n').find(text => text.includes(`id:${id}`));
  assert.match(line('legacy'), new RegExp(`status:done[^\\n]*completed:${today}|completed:${today}[^\\n]*status:done`));
  let data = await items();
  assert.equal(data.todayTasks.find(item => item.id === 'legacy').status, 'done');
  assert.equal(data.todayTasks.find(item => item.id === 'unseen').status, 'done');
  assert.equal(data.todayTasks.find(item => item.id === 'legacy').due, shifted(-2), '마감일은 그대로 남는다');
  const restored = await post('/api/workflow/task-batch', { undoToken: changed.undoToken });
  assert.equal(restored.ok, true);
  assert.doesNotMatch(line('legacy'), /completed:/);
  data = await items();
  assert.equal(data.reportRefs.legacy.status, 'to-do');
  assert.equal(data.reportRefs.unseen.status, 'to-do');
});

test('일괄 완료 뒤에 바뀐 업무가 있으면 실행 취소를 거절한다', async () => {
  const changed = await post('/api/workflow/task-batch', { ids: ['legacy', 'unseen'], change: { status: 'done' } });
  assert.equal(changed.ok, true);
  assert.equal((await post('/api/track/toggle', { id: 'unseen', status: 'to-do' })).ok, true);
  const before = readTasks();
  assert.equal((await post('/api/workflow/task-batch', { undoToken: changed.undoToken })).status, 400);
  assert.equal(readTasks(), before, '거절된 실행 취소는 한 줄도 바꾸지 않는다');
  assert.equal((await post('/api/workflow/task-batch', { ids: ['legacy'], change: { status: 'to-do' } })).status, 400, '일괄로 여는 상태 변경은 완료 하나뿐이다');
});

test('acknowledgement affects only the requested item', async () => {
  assert.equal((await post('/api/track/seen', { id: 'legacy' })).ok, true);
  const data = await items();
  assert.equal(data.todayTasks.find(item => item.id === 'legacy').isNew, false);
  assert.equal(data.todayTasks.find(item => item.id === 'unseen').isNew, true);
});

test('rescheduling and removing a schedule preserve the deadline', async () => {
  await post('/api/track/set-scheduled', { id: 'legacy', scheduled: shifted(1) });
  let item = (await items()).laterTasks.find(item => item.id === 'legacy');
  assert.equal(item.scheduled, shifted(1));
  assert.equal(item.due, shifted(-2));
  await post('/api/track/set-scheduled', { id: 'legacy', scheduled: null });
  item = (await items()).laterTasks.find(item => item.id === 'legacy');
  assert.equal(item.scheduled, null);
  assert.equal(item.due, shifted(-2));
});

test('editing a legacy deadline does not change its execution day', async () => {
  await post('/api/track/set-due', { id: 'legacy', due: shifted(7) });
  const item = (await items()).todayTasks.find(item => item.id === 'legacy');
  assert.equal(item.scheduled, shifted(-2));
  assert.equal(item.due, shifted(7));
});

test('new today tasks have a schedule without an artificial deadline', async () => {
  const created = await post('/api/today-task/create', { description: 'New task' });
  assert.equal(created.status, 200);
  const item = (await items()).todayTasks.find(item => item.id === created.id);
  assert.equal(item.scheduled, today);
  assert.equal(item.due, undefined);
});

test('invalid schedules do not modify stored data', async () => {
  const original = readTasks();
  assert.equal((await post('/api/track/set-scheduled', { id: 'legacy', scheduled: '2026-02-30' })).status, 400);
  assert.equal(readTasks(), original);
});

test('completion uses the completion day rather than the deadline', async () => {
  await post('/api/track/toggle', { id: 'legacy' });
  assert.match(readTasks(), new RegExp(`completed:${today}`));
  assert.equal((await items()).todayTasks.find(item => item.id === 'legacy').status, 'done');
});

test('delete and undo restore the exact original line and position', async () => {
  const original = readTasks();
  await post('/api/track/remove', { id: 'legacy' });
  assert.doesNotMatch(readTasks(), /id:legacy/);
  assert.equal((await post('/api/track/restore', { id: 'legacy' })).ok, true);
  assert.equal(readTasks(), original);
});

test('stale calendar data is not presented as today’s meetings', async () => {
  fs.writeFileSync(path.join(directory, 'calendar_today.md'), `마지막 갱신: ${shifted(-1)}\n- 10:00-11:00 | Old meeting\n`);
  let calendar = (await items()).calendar;
  assert.equal(calendar.stale, true);
  assert.equal(calendar.events.length, 0);
  fs.writeFileSync(path.join(directory, 'calendar_today.md'), `마지막 갱신: ${today}\n- 10:00-11:00 | Today meeting\n`);
  calendar = (await items()).calendar;
  assert.equal(calendar.stale, false);
  assert.equal(calendar.events[0].end, '11:00');
});

test('promoting a non-idea fails without deleting the task', async () => {
  const original = readTasks();
  assert.equal((await post('/api/idea/promote', { id: 'legacy' })).status, 404);
  assert.equal(readTasks(), original);
});

test('a decision kept from a waiting item carries its Slack link without showing as NEW', async () => {
  const created = await post('/api/decision/create', { description: 'Kept from waiting', jira: 'IO-1', permalink: 'https://example.test/thread' });
  const decision = (await items()).decisions.find(item => item.id === created.id);
  assert.equal(decision.permalink, 'https://example.test/thread');
  assert.equal(decision.jira, 'IO-1');
  assert.equal(decision.isNew, false);
  assert.equal((await post('/api/decision/create', { description: 'Bad link', permalink: 'https://example.test/a b' })).status, 400);
});

test('a refused startup recovery keeps the app up with saving locked', async (t) => {
  const external = '# Tasks\n- 바깥에서 고친 줄 #task[id:outside status:to-do created:2026-09-20]\n';
  const server = await startServer(t, home => {
    fs.writeFileSync(path.join(home, 'tasks.md'), external);
    fs.writeFileSync(path.join(home, '.mutation-journal.json'), journalEntry(path.join(home, 'tasks.md'), '# Tasks\n', '# Tasks\n- 중단된 저장\n'));
    fs.writeFileSync(path.join(home, '.mutation.lock'), String(deadPid()));
  });
  const status = await (await fetch(server.base + '/api/storage-status')).json();
  assert.equal(status.recoveryNeeded, true);
  assert.match(status.reason, /밖에서 바뀐 파일/);
  const response = await fetch(server.base + '/api/today-task/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description: '저장되면 안 되는 업무' }) });
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.code, 'RECOVERY_NEEDED');
  assert.match(body.error, /저장을 멈췄어요/);
  assert.equal(fs.readFileSync(path.join(server.home, 'tasks.md'), 'utf8'), external);
  // 종류 바꾸기도 같은 저장 길을 타므로 복구 필요 상태에서는 파일을 열어 보지도 않고 503으로 멈춘다.
  const retype = await fetch(server.base + '/api/workflow/retype', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'outside', type: 'check' }) });
  assert.equal(retype.status, 503);
  assert.equal((await retype.json()).code, body.code, '다른 저장과 똑같이 막힌다');
  assert.equal(fs.readFileSync(path.join(server.home, 'tasks.md'), 'utf8'), external);
  assert.ok(fs.existsSync(path.join(server.home, '.mutation-journal.json')));
  assert.ok(fs.existsSync(path.join(server.home, '.mutation.lock')));
  assert.equal(fs.existsSync(path.join(server.home, '.workflow.json')), false);
});

test('a restorable journal is recovered at startup and saving continues', async (t) => {
  const interrupted = '# Tasks\n- 중단된 저장 #task[id:half status:to-do created:2026-09-20]\n';
  const server = await startServer(t, home => {
    fs.writeFileSync(path.join(home, 'tasks.md'), interrupted);
    fs.writeFileSync(path.join(home, '.mutation-journal.json'), journalEntry(path.join(home, 'tasks.md'), '# Tasks\n', interrupted));
    fs.writeFileSync(path.join(home, '.mutation.lock'), String(deadPid()));
  });
  assert.deepEqual(await (await fetch(server.base + '/api/storage-status')).json(), { recoveryNeeded: false, reason: null, message: null });
  assert.equal(fs.readFileSync(path.join(server.home, 'tasks.md'), 'utf8'), '# Tasks\n');
  assert.equal(fs.existsSync(path.join(server.home, '.mutation-journal.json')), false);
  assert.equal(fs.existsSync(path.join(server.home, '.mutation.lock')), false);
  const created = await fetch(server.base + '/api/today-task/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description: '복구 후 저장' }) });
  assert.equal(created.status, 200);
  assert.match(fs.readFileSync(path.join(server.home, 'tasks.md'), 'utf8'), /복구 후 저장/);
});

test('meeting drafts from tiro-sync are reviewed once: accepted items land in their lists, dismissed ones stay hidden', async () => {
  const draftsPath = path.join(directory, 'meeting_drafts.json');
  fs.writeFileSync(path.join(directory, 'calendar_today.md'), `마지막 갱신: ${today}\n- 15:00-16:00 | 운영툴 킥오프\n`);
  fs.writeFileSync(draftsPath, JSON.stringify({ notes: [{
    noteGuid: 'n1', webUrl: 'https://tiro.ooo/n/1', date: today, start: '15:00', end: '16:00', title: '운영툴 킥오프',
    items: [
      { type: 'task', description: '백엔드 담당자에게 스펙 요청하기', due: shifted(3) },
      { type: 'decision', description: '프롬프트 버전은 운영툴에서만 관리' },
      { type: 'check', description: '디자인 일정 회신 받기' },
      { type: 'nonsense', description: '무시됨' },
    ],
  }] }));
  try {
    const meeting = (await items()).workflows.meetings.find(event => event.title === '운영툴 킥오프');
    assert.deepEqual(meeting.tiroNotes, ['https://tiro.ooo/n/1']);
    assert.equal(meeting.drafts.length, 3);
    const [task, decision, check] = meeting.drafts;
    const original = readTasks();
    assert.equal((await post('/api/workflow/review', { meetingId: meeting.id, accept: [{ id: 'n1:9', type: 'task', description: '없는 초안' }] })).status, 400);
    assert.equal((await post('/api/workflow/review', { meetingId: meeting.id, accept: [{ ...task, description: '' }] })).status, 400);
    assert.equal(readTasks(), original);

    assert.equal((await post('/api/workflow/review', { meetingId: meeting.id, dismiss: [check.id] })).ok, true);
    const result = await post('/api/workflow/review', { meetingId: meeting.id, accept: [{ ...task, description: '스펙 요청하기' }, { ...decision, type: 'check' }] });
    assert.equal(result.created.length, 2);
    assert.match(readTasks(), new RegExp(`- 스펙 요청하기 #task\\[id:${result.created[0]} .*scheduled:none due:${shifted(3)}`));
    assert.match(fs.readFileSync(path.join(directory, 'checks.md'), 'utf8'), /프롬프트 버전은 운영툴에서만 관리 #check/);

    const data = (await items()).workflows;
    assert.equal(data.meetings.find(event => event.id === meeting.id).drafts.length, 0);
    assert.deepEqual(data.items.filter(item => item.meetingId === meeting.id).map(item => item.id).sort(), [...result.created].sort());
    assert.equal((await post('/api/workflow/review', { meetingId: meeting.id, accept: [task] })).status, 400);
  } finally {
    fs.rmSync(draftsPath);
  }
});

test('meeting drafts: a task can be accepted for today, and an accepted batch can be undone', async () => {
  const draftsPath = path.join(directory, 'meeting_drafts.json');
  const trashPath = path.join(directory, '.trash.json');
  fs.writeFileSync(path.join(directory, 'calendar_today.md'), `마지막 갱신: ${today}\n- 11:00-11:50 | 온보딩 지표 리뷰\n`);
  fs.writeFileSync(draftsPath, JSON.stringify({ notes: [{
    noteGuid: 'u1', webUrl: 'https://tiro.ooo/n/u1', date: today, start: '11:00', end: '11:50', title: '온보딩 지표 리뷰',
    items: [
      { type: 'task', description: '퍼널 이탈 원인 가설 정리하기', due: shifted(2) },
      { type: 'task', description: '코호트 쿼리 요청하기' },
      { type: 'decision', description: '온보딩 실험은 2주 단위로 진행' },
    ],
  }] }));
  try {
    const meeting = (await items()).workflows.meetings.find(event => event.title === '온보딩 지표 리뷰');
    const [first, second, third] = meeting.drafts;
    // 잘못된 선택은 아무것도 만들지 않는다: 알 수 없는 값, 그리고 할 일이 아닌 항목의 "오늘"
    const before = readTasks();
    assert.equal((await post('/api/workflow/review', { meetingId: meeting.id, accept: [{ ...first, when: 'tomorrow' }] })).status, 400);
    assert.equal((await post('/api/workflow/review', { meetingId: meeting.id, accept: [{ ...third, when: 'today' }] })).status, 400);
    assert.equal(readTasks(), before);

    // 기본은 나중, "오늘"을 고른 할 일만 오늘 목록으로 (마감일은 초안에 있던 것만)
    const result = await post('/api/workflow/review', { meetingId: meeting.id, accept: [{ ...first, when: 'today' }, second, third] });
    assert.equal(result.created.length, 3);
    assert.match(readTasks(), new RegExp(`퍼널 이탈 원인 가설 정리하기 #task\\[id:${result.created[0]} .*scheduled:${today} due:${shifted(2)}`));
    assert.match(readTasks(), new RegExp(`코호트 쿼리 요청하기 #task\\[id:${result.created[1]} .*scheduled:none`));

    // 되돌리기: 다른 회의·모르는 항목은 거절하고, 맞으면 항목은 삭제 휴지통으로, 초안은 다시 검토 대기로
    assert.equal((await post('/api/workflow/review-undo', { meetingId: 'other', created: result.created })).status, 400);
    assert.equal((await post('/api/workflow/review-undo', { meetingId: meeting.id, created: ['nope'] })).status, 400);
    assert.equal((await post('/api/workflow/review-undo', { meetingId: meeting.id, created: [] })).status, 400);
    const undo = await post('/api/workflow/review-undo', { meetingId: meeting.id, created: result.created });
    assert.equal(undo.ok, true);
    assert.equal(undo.restored, 3);
    assert.doesNotMatch(readTasks(), /퍼널 이탈 원인 가설 정리하기|코호트 쿼리 요청하기/);
    assert.doesNotMatch(fs.readFileSync(path.join(directory, 'decisions.md'), 'utf8'), /온보딩 실험은 2주 단위로 진행/);
    const trashed = JSON.parse(fs.readFileSync(trashPath, 'utf8')).map(entry => entry.id);
    result.created.forEach(id => assert.ok(trashed.includes(id), '되돌린 항목은 삭제 휴지통에 원문이 남는다'));
    const data = (await items()).workflows;
    assert.equal(data.meetings.find(event => event.id === meeting.id).drafts.length, 3);
    assert.equal(data.items.filter(item => item.meetingId === meeting.id).length, 0);
    // 이미 되돌린 것은 다시 되돌릴 수 없고, 초안은 다시 담을 수 있다
    assert.equal((await post('/api/workflow/review-undo', { meetingId: meeting.id, created: result.created })).status, 400);
    assert.equal((await post('/api/workflow/review', { meetingId: meeting.id, accept: [second] })).ok, true);
  } finally {
    fs.rmSync(draftsPath, { force: true });
  }
});

test('meeting review and capture take a due date for tasks and a reply deadline for checks, never for decisions', async () => {
  const draftsPath = path.join(directory, 'meeting_drafts.json');
  const checksPath = path.join(directory, 'checks.md');
  fs.writeFileSync(path.join(directory, 'calendar_today.md'), `마지막 갱신: ${today}\n- 14:00-14:30 | 결제 실패 싱크\n`);
  fs.writeFileSync(draftsPath, JSON.stringify({ notes: [{
    noteGuid: 'due1', webUrl: 'https://tiro.ooo/n/due1', date: today, start: '14:00', end: '14:30', title: '결제 실패 싱크',
    items: [
      { type: 'task', description: '실패 사유 문구 초안 쓰기', due: shifted(2) },
      { type: 'task', description: '재시도 정책 화면 목록 뽑기' },
      { type: 'check', description: 'PG사에 실패 코드 명세 회신 받기' },
      { type: 'decision', description: '실패 안내는 결제 화면 상단 배너로' },
    ],
  }] }));
  try {
    const meeting = (await items()).workflows.meetings.find(event => event.title === '결제 실패 싱크');
    const [draftTask, plainTask, check, decision] = meeting.drafts;
    // 잘못된 값은 아무것도 만들지 않는다: 날짜 형식, 결정의 마감
    const before = { tasks: readTasks(), checks: fs.existsSync(checksPath) ? fs.readFileSync(checksPath, 'utf8') : '' };
    assert.equal((await post('/api/workflow/review', { meetingId: meeting.id, accept: [{ ...check, due: '2026/09/30' }] })).status, 400);
    assert.equal((await post('/api/workflow/review', { meetingId: meeting.id, accept: [{ ...decision, due: shifted(3) }] })).status, 400);
    assert.equal(readTasks(), before.tasks);
    assert.equal(fs.existsSync(checksPath) ? fs.readFileSync(checksPath, 'utf8') : '', before.checks);

    // 사람이 고친 날짜: 초안의 마감을 지우고(null), 마감이 없던 할 일에 지정하고, 확인 대기에는 회신 기한을 지정한다
    const result = await post('/api/workflow/review', { meetingId: meeting.id, accept: [{ ...draftTask, due: null }, { ...plainTask, due: shifted(5) }, { ...check, due: shifted(4) }, decision] });
    assert.equal(result.created.length, 4);
    assert.doesNotMatch(readTasks(), new RegExp(`실패 사유 문구 초안 쓰기 #task\\[id:${result.created[0]}[^\\]]* due:`));
    assert.match(readTasks(), new RegExp(`재시도 정책 화면 목록 뽑기 #task\\[id:${result.created[1]} .*due:${shifted(5)}`));
    assert.match(fs.readFileSync(checksPath, 'utf8'), new RegExp(`PG사에 실패 코드 명세 회신 받기 #check\\[id:${result.created[2]} [^\\]]*due:${shifted(4)}`));
    assert.doesNotMatch(fs.readFileSync(path.join(directory, 'decisions.md'), 'utf8').split('\n').find(line => line.includes('결제 화면 상단 배너')) || '', /due:/);
    assert.equal((await items()).workflows.items.find(item => item.id === result.created[2]).due, shifted(4), '화면에 실려 가는 항목에도 기한이 있다');

    // 직접 담기도 같다
    const captured = await post('/api/workflow/capture', { meetingId: meeting.id, type: 'check', description: '법무 회신 받기', due: shifted(6) });
    assert.equal(captured.ok, true);
    assert.match(fs.readFileSync(checksPath, 'utf8'), new RegExp(`법무 회신 받기 #check\\[id:${captured.id} [^\\]]*due:${shifted(6)}`));
    assert.equal((await post('/api/workflow/capture', { meetingId: meeting.id, type: 'decision', description: '결정에 마감', due: shifted(6) })).status, 400);
    assert.equal((await post('/api/workflow/capture', { meetingId: meeting.id, type: 'task', description: '잘못된 날짜', due: 'nope' })).status, 400);
    assert.doesNotMatch(readTasks(), /잘못된 날짜/);
  } finally {
    fs.rmSync(draftsPath, { force: true });
  }
});

test('import-record.js는 JSON을 명령줄 인자로도, 표준 입력으로도 받는다', async () => {
  const script = path.join(__dirname, 'import-record.js');
  const env = { ...process.env, WORKSPACE_PORT: String(server.address().port), WORKSPACE_CONFIG: path.join(directory, 'absent.config.json') };
  // 이 서버는 같은 프로세스에서 돌기 때문에 spawnSync로 막으면 응답을 못 한다 — 비동기로 부른다.
  const record = (args, input) => new Promise(resolve => {
    const child = spawn(process.execPath, [script, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stdin.end(input || '');
    child.on('close', code => resolve({ code, out }));
  });
  // 캡처 실행은 파이프·히어독이 막혀 있어서 인자 방식만 쓴다
  const argv = await record(['item', JSON.stringify({ type: 'task', description: '인자로 넘긴 수집', permalink: 'https://example.test/argv' })]);
  assert.equal(argv.code, 0);
  assert.equal(JSON.parse(argv.out).ok, true);
  assert.ok((await items()).inboxTasks.some(item => item.description === '인자로 넘긴 수집'));
  // slack-capture.sh의 record_health는 여전히 표준 입력으로 보낸다
  const stdin = await record(['health'], JSON.stringify({ channel: 'my-todo', success: true }));
  assert.equal(stdin.code, 0);
  assert.equal(JSON.parse(stdin.out).ok, true);
  assert.equal((await record(['item', '깨진 JSON'])).code, 1);
});

// 같은 원본을 다른 메모로 다시 공유한 것은 개인 채널의 그 메시지 링크로 들어온다(슬랙 수집 지침 B).
// 서버의 원본 링크 중복 제거는 permalink 글자가 같을 때만 걸린다는 것을 고정해 둔다.
test('개인 채널 메시지 링크도 원본 링크로 받고, 링크가 다르면 별개 항목이 된다', async () => {
  const channelLink = ts => `https://example-workspace.slack.com/archives/C09PERSONAL/p${ts}`;
  const first = await post('/api/import', { kind: 'item', payload: { type: 'task', description: '공유에 메모를 달아 담은 일', permalink: channelLink('1758697200123456') } });
  assert.equal(first.ok, true);
  assert.notEqual(first.duplicate, true);
  const again = await post('/api/import', { kind: 'item', payload: { type: 'task', description: '같은 링크를 다시', permalink: channelLink('1758697200123456') } });
  assert.equal(again.duplicate, true, '같은 링크는 지금처럼 중복이다');
  const second = await post('/api/import', { kind: 'item', payload: { type: 'task', description: '같은 원본을 다른 메모로 다시 공유', permalink: channelLink('1758783600987654') } });
  assert.equal(second.ok, true);
  assert.notEqual(second.duplicate, true, '개인 채널의 다른 메시지 링크는 별개 항목으로 들어온다');
  assert.notEqual(second.id, first.id);
});

// ---------- 설정 > 삭제한 항목 (BTRASH) ----------
// 삭제한 줄의 원문은 `.trash.json`에 남는다. 목록은 조회이고(파일을 쓰지 않는다), 되살리기는 기존
// `/api/track/restore`가, 완전히 지우기는 아래 `trash-purge`가 맡는다. 자동 영구 삭제는 없다.
const purgePost = (origin, body, key) => fetch(origin + '/api/track/trash-purge', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
  body: JSON.stringify(body),
}).then(async response => ({ status: response.status, ...await response.json() }));

const seedTrash = (home) => {
  fs.writeFileSync(path.join(home, 'tasks.md'), '# Tasks\n');
  fs.writeFileSync(path.join(home, 'checks.md'), '# Checks\n');
  fs.writeFileSync(path.join(home, '.trash.json'), JSON.stringify([
    { id: 'tr01', file: 'tasks.md', index: 1, deletedAt: '2026-09-21T13:10:00.000Z',
      line: '- 정산 배치 설계 검토하기 #task[id:tr01 status:to-do priority:high created:2026-09-20 group:결제_리뉴얼]' },
    { id: 'tr02', file: 'checks.md', index: 1, deletedAt: '2026-09-22T01:05:00.000Z',
      line: '- 법무 검토 회신 #check[id:tr02 status:to-do priority:medium created:2026-09-21 who:하늘 jira:IO-12345]' },
    { id: 'tr03', file: 'ideas.md', index: 1, deletedAt: '2026-09-20T09:00:00.000Z',
      line: '- 알림 묶어 보내기 #idea[id:tr03 status:to-do priority:low created:2026-09-19 project:알림센터]' },
  ], null, 2));
};
const homeSnapshot = home => fs.readdirSync(home).sort().map((name) => {
  const stat = fs.statSync(path.join(home, name));
  return `${name}:${stat.size}:${stat.mtimeMs}`;
}).join('|');

test('BTRASH: 삭제한 항목 목록은 원문 줄에서 종류·문구·프로젝트만 뽑아 최근 순으로 주고 파일을 쓰지 않는다', async (t) => {
  const server = await startServer(t, seedTrash);
  const before = homeSnapshot(server.home);
  const list = await (await fetch(server.base + '/api/track/trash')).json();
  assert.equal(list.ok, true);
  assert.deepEqual(list.items.map(entry => entry.id), ['tr02', 'tr01', 'tr03'], '삭제 시각 내림차순이다');
  assert.deepEqual(list.items[1], {
    id: 'tr01', type: 'task', typeLabel: '할 일', description: '정산 배치 설계 검토하기',
    file: 'tasks.md', deletedAt: '2026-09-21T13:10:00.000Z', project: '결제 리뉴얼', projectKey: 'group:결제 리뉴얼',
  });
  assert.equal(list.items[0].typeLabel, '확인 대기');
  assert.equal(list.items[0].project, 'IO-12345', '지라 요약을 모르면 키만 적는다(BKEY)');
  assert.deepEqual([list.items[2].typeLabel, list.items[2].project], ['아이디어', '알림센터'], '아이디어의 프로젝트 칸은 `project:`다');
  assert.ok(!JSON.stringify(list).includes('status:to-do'), '원문 줄 전체(흐름 기록 칸)는 싣지 않는다');
  assert.equal(homeSnapshot(server.home), before, 'GET은 어떤 파일도 쓰지 않는다');
});

test('BTRASH: 완전히 지우기는 그 줄만 휴지통에서 빼고, 같은 식별자로 다시 보내도 한 번만 지운다', async (t) => {
  const server = await startServer(t, seedTrash);
  const trashFile = path.join(server.home, '.trash.json');
  const ids = () => JSON.parse(fs.readFileSync(trashFile, 'utf8')).map(entry => entry.id);

  const gone = await purgePost(server.base, { id: 'tr03' });
  assert.deepEqual(gone, { status: 200, ok: true, id: 'tr03', removed: 1 });
  assert.deepEqual(ids(), ['tr01', 'tr02'], '고른 항목만 빠지고 나머지 원문은 그대로 남는다');
  assert.deepEqual((await (await fetch(server.base + '/api/track/trash')).json()).items.map(entry => entry.id), ['tr02', 'tr01']);

  const again = await purgePost(server.base, { id: 'tr03' });
  assert.deepEqual([again.status, again.error], [400, '이미 지운 항목이에요.']);
  for (const bad of [{}, { id: '' }, { id: 7 }]) {
    assert.deepEqual((await purgePost(server.base, bad)).error, '지울 항목을 확인해 주세요.', JSON.stringify(bad));
  }
  assert.deepEqual(ids(), ['tr01', 'tr02'], '거절된 요청은 파일을 고치지 않는다');

  // 같은 내용을 같은 식별자로 다시 보내면 한 번만 쓴다(앱의 기존 저장 길 그대로).
  const key = 'btrash-idempotency-key-001';
  const send = () => purgePost(server.base, { id: 'tr01' }, key);
  assert.deepEqual(await send(), { status: 200, ok: true, id: 'tr01', removed: 1 });
  assert.deepEqual(await send(), { status: 200, ok: true, id: 'tr01', removed: 1 });
  assert.deepEqual(ids(), ['tr02'], '두 번 보내도 한 번만 빠진다');

  // 남은 항목은 여전히 기존 되살리기 길로 원래 자리에 돌아간다.
  const restored = await fetch(server.base + '/api/track/restore', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'tr02' }),
  });
  assert.equal(restored.status, 200);
  assert.match(fs.readFileSync(path.join(server.home, 'checks.md'), 'utf8'), /법무 검토 회신 #check\[id:tr02/);
  assert.deepEqual(ids(), []);
});

test('BTRASH: 복구가 필요한 동안에는 완전히 지우기도 막힌다', async (t) => {
  const server = await startServer(t, (home) => {
    seedTrash(home);
    // 저널이 되돌리려는 내용과 지금 파일이 달라(바깥에서 고친 파일) 복구가 거절된다 → 저장이 잠긴다.
    fs.writeFileSync(path.join(home, 'tasks.md'), '# Tasks\n- 바깥에서 고친 줄 #task[id:tr09 status:to-do created:2026-09-20]\n');
    fs.writeFileSync(path.join(home, '.mutation-journal.json'), journalEntry(path.join(home, 'tasks.md'), '# Tasks\n', '# Tasks\n- 중단된 저장\n'));
    fs.writeFileSync(path.join(home, '.mutation.lock'), String(deadPid()));
  });
  const blocked = await purgePost(server.base, { id: 'tr01' });
  assert.equal(blocked.status, 503);
  assert.match(blocked.error, /저장을 멈췄어요/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(server.home, '.trash.json'), 'utf8')).length, 3);
  // 조회는 복구 필요 상태에서도 그대로 된다(무엇이 남아 있는지 볼 수 있어야 한다).
  assert.equal((await (await fetch(server.base + '/api/track/trash')).json()).items.length, 3);
});

// ---------- 직접 만든 프로젝트 이름 바꾸기 (BRENAME) ----------
// 이름은 업무 줄·회의·연결·보관·주간요약에 글자로 박혀 있다. 한 트랜잭션으로 전부 바꾸고,
// 하나라도 실패하면 전부 되돌아간다(반쯤 바뀐 이름을 남기지 않는다).
const renamePost = (origin, body, key) => fetch(origin + '/api/project/rename', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
  body: JSON.stringify(body),
}).then(async response => ({ status: response.status, ...await response.json() }));

const RENAME_REPORT = {
  schema: 1,
  weeks: {
    '2026-09-14': {
      rows: [
        { id: 'r1', heading: '완료한 일', group: '결제 리뉴얼', bucket: 'group:결제 리뉴얼:완료한 일:정산 배치',
          text: '정산 배치 설계 검토함', sourceIds: ['rn01'],
          evidence: [{ id: 'rn01', description: '정산 배치 설계 검토하기', status: 'done', type: 'task', outcome: '', label: '결제 리뉴얼', permalink: null }],
          locked: true, excluded: false },
        { id: 'r2', heading: '진행중', group: '운영툴', bucket: 'group:운영툴:진행중:운영툴 대시보드',
          text: '운영툴 대시보드 개선', sourceIds: [], evidence: [], locked: true, excluded: false },
      ],
      updatedAt: '2026-09-20T00:00:00.000Z',
    },
  },
};
function seedRename(home, report = RENAME_REPORT) {
  fs.writeFileSync(path.join(home, 'tasks.md'), '# Tasks\n'
    + '- 정산 배치 설계 검토하기 #task[id:rn01 status:to-do priority:high created:2026-09-20 group:결제_리뉴얼]\n'
    + '- 게임 임베드 검수하기 #task[id:rn02 status:to-do priority:medium created:2026-09-20 jira:IO-12345]\n'
    + '- 대시보드 지표 정리하기 #task[id:rn06 status:to-do priority:medium created:2026-09-20 group:운영툴]\n');
  fs.writeFileSync(path.join(home, 'checks.md'), '# Checks\n'
    + '- 법무 검토 회신 #check[id:rn03 status:to-do priority:medium created:2026-09-20 who:하늘 group:결제_리뉴얼]\n');
  fs.writeFileSync(path.join(home, 'decisions.md'), '# Decisions\n'
    + '- 정산 주기는 주 단위로 한다 #decision[id:rn04 status:to-do priority:medium created:2026-09-20 group:결제_리뉴얼]\n');
  fs.writeFileSync(path.join(home, 'ideas.md'), '# Ideas\n'
    + '- 정산 리포트 자동화 #idea[id:rn05 status:to-do priority:low created:2026-09-20 project:결제_리뉴얼]\n');
  fs.writeFileSync(path.join(home, '.workflow.json'), JSON.stringify({
    items: {}, meetings: {
      m1: { id: 'm1', date: '2026-09-20', start: '10:00', end: '11:00', title: '결제 주간 싱크', series: '결제 주간 싱크', link: null,
        project: { type: 'group', value: '결제 리뉴얼', label: '결제 리뉴얼' } },
      m2: { id: 'm2', date: '2026-09-19', start: '14:00', end: '15:00', title: '운영 회의', series: '운영 회의', link: null,
        project: { type: 'group', value: '운영툴', label: '운영툴' } },
    },
    projectLinks: { '결제 리뉴얼': 'IO-12345' },
    projectArchive: { 'group:결제 리뉴얼': '2026-09-19', 'jira:IO-9999': '2026-09-18' },
  }, null, 2));
  fs.writeFileSync(path.join(home, '.meeting_links.json'), JSON.stringify({ '결제 주간 싱크': 'group:결제 리뉴얼', '운영 회의': 'group:운영툴' }, null, 2));
  fs.writeFileSync(path.join(home, '.report-drafts.json'), JSON.stringify(report, null, 2));
}

test('BRENAME: 직접 만든 프로젝트의 이름만, 형식과 겹침을 확인한 뒤에 바꾼다 — 거절된 요청은 파일을 고치지 않는다', async (t) => {
  const server = await startServer(t, seedRename);
  const files = ['tasks.md', 'checks.md', 'decisions.md', 'ideas.md', '.workflow.json', '.meeting_links.json', '.report-drafts.json'];
  const before = files.map(name => fs.readFileSync(path.join(server.home, name), 'utf8'));
  const refuse = async (body, message) => {
    const answer = await renamePost(server.base, body);
    assert.equal(answer.status, 400, JSON.stringify(body));
    assert.equal(answer.error, message, JSON.stringify(body));
  };
  const FORMAT = '새 이름은 60자 이내 한 줄로, 대괄호 없이 적어 주세요.';
  await refuse({ project: 'jira:IO-12345', name: '결제 정산' }, '직접 만든 프로젝트의 이름만 바꿀 수 있어요. 지라 프로젝트의 이름은 지라 요약을 따라요.');
  await refuse({ project: '결제 리뉴얼', name: '결제 정산' }, '직접 만든 프로젝트의 이름만 바꿀 수 있어요. 지라 프로젝트의 이름은 지라 요약을 따라요.');
  await refuse({ project: 'group:   ', name: '결제 정산' }, '프로젝트를 확인해 주세요.');
  await refuse({ project: 'group:없는 프로젝트', name: '결제 정산' }, '프로젝트를 찾을 수 없어요.');
  await refuse({ project: 'group:결제 리뉴얼' }, '새 이름을 입력해 주세요.');
  await refuse({ project: 'group:결제 리뉴얼', name: '   ' }, FORMAT);
  await refuse({ project: 'group:결제 리뉴얼', name: '가'.repeat(61) }, FORMAT);
  await refuse({ project: 'group:결제 리뉴얼', name: '결제\n정산' }, FORMAT);
  await refuse({ project: 'group:결제 리뉴얼', name: '결제 [정산]' }, FORMAT);
  await refuse({ project: 'group:결제 리뉴얼', name: '결제 리뉴얼' }, '이미 같은 이름이에요.');
  await refuse({ project: 'group:결제 리뉴얼', name: '결제_리뉴얼' }, '이미 같은 이름이에요.');
  await refuse({ project: 'group:결제 리뉴얼', name: '운영툴' }, '같은 이름의 프로젝트가 이미 있어요.');
  await refuse({ project: 'group:결제 리뉴얼', name: ' 운영툴 ' }, '같은 이름의 프로젝트가 이미 있어요.');
  assert.deepEqual(files.map(name => fs.readFileSync(path.join(server.home, name), 'utf8')), before);
  // 띄어쓰기만 고치는 것은 자기 이름과의 겹침이 아니다.
  assert.equal((await renamePost(server.base, { project: 'group:결제 리뉴얼', name: '결제  리뉴얼' })).ok, true);
});

test('BRENAME: 이름을 바꾸면 항목·회의·연결·보관·주간요약이 한 번에 따라오고 지라 항목은 그대로다', async (t) => {
  const server = await startServer(t, seedRename);
  const answer = await renamePost(server.base, { project: 'group:결제 리뉴얼', name: '결제 정산' });
  assert.deepEqual(answer, {
    status: 200, ok: true, project: 'group:결제 정산', from: '결제 리뉴얼', to: '결제 정산',
    changed: { items: 4, meetings: 2, links: 1, archive: 1, report: 1 },
  });

  // ① 업무 파일 — 파일 표기의 공백→밑줄 규칙은 그대로, 지라가 걸린 줄과 다른 그룹은 손대지 않는다.
  const tasks = fs.readFileSync(path.join(server.home, 'tasks.md'), 'utf8');
  assert.match(tasks, /정산 배치 설계 검토하기 #task\[id:rn01 status:to-do priority:high created:2026-09-20 group:결제_정산\]/);
  assert.match(tasks, /게임 임베드 검수하기 #task\[id:rn02 status:to-do priority:medium created:2026-09-20 jira:IO-12345\]/);
  assert.match(tasks, /group:운영툴\]/);
  assert.match(fs.readFileSync(path.join(server.home, 'checks.md'), 'utf8'), /who:하늘 group:결제_정산\]/);
  assert.match(fs.readFileSync(path.join(server.home, 'decisions.md'), 'utf8'), /group:결제_정산\]/);
  assert.match(fs.readFileSync(path.join(server.home, 'ideas.md'), 'utf8'), /project:결제_정산\]/, '아이디어의 프로젝트 칸도 함께 바뀐다');

  // ②③④ 회의 프로젝트 · 수동 지라 연결 · 보관 표
  const workflow = readJson(path.join(server.home, '.workflow.json'));
  assert.deepEqual(workflow.meetings.m1.project, { type: 'group', value: '결제 정산', label: '결제 정산' });
  assert.deepEqual(workflow.meetings.m2.project, { type: 'group', value: '운영툴', label: '운영툴' });
  assert.deepEqual(workflow.projectLinks, { '결제 정산': 'IO-12345' });
  assert.deepEqual(workflow.projectArchive, { 'group:결제 정산': '2026-09-19', 'jira:IO-9999': '2026-09-18' });

  // ⑤ 회의 제목 → 프로젝트 표
  assert.deepEqual(readJson(path.join(server.home, '.meeting_links.json')), { '결제 주간 싱크': 'group:결제 정산', '운영 회의': 'group:운영툴' });

  // ⑥ 주간요약 저장본 — 저장 형식은 그대로 두고 그룹 이름 값만 바뀐다.
  const rows = readJson(path.join(server.home, '.report-drafts.json')).weeks['2026-09-14'].rows;
  assert.equal(rows[0].group, '결제 정산');
  assert.equal(rows[0].bucket, 'group:결제 정산:완료한 일:정산 배치');
  assert.equal(rows[0].evidence[0].label, '결제 정산');
  assert.equal(rows[0].text, '정산 배치 설계 검토함', '보고 문장은 손대지 않는다');
  assert.deepEqual(rows[0].sourceIds, ['rn01']);
  assert.deepEqual([rows[1].group, rows[1].bucket], ['운영툴', 'group:운영툴:진행중:운영툴 대시보드']);

  // 화면이 받는 값(왼쪽 목록·오늘 목록·주간요약)도 새 이름 하나로 모인다.
  const data = await (await fetch(server.base + '/api/items')).json();
  assert.ok(data.customGroups.includes('결제 정산') && !data.customGroups.includes('결제 리뉴얼'));
  assert.equal(data.workflows.items.find(item => item.id === 'rn01').group, '결제 정산');
  assert.equal(data.workflows.items.find(item => item.id === 'rn05').project, '결제 정산');
  assert.equal(data.workflows.meetings.find(event => event.id === 'm1').project.value, '결제 정산');
  const week = data.weeklyReports.find(entry => entry.weekKey === '2026-09-14');
  assert.deepEqual([...new Set(week.draft.rows.map(row => row.group))].sort(), ['결제 정산', '운영툴']);
  assert.equal(data.ideas.find(item => item.id === 'rn05').project, '결제 정산');

  // 반대 방향으로 한 번 더 보내면 그대로 돌아간다(화면의 `되돌리기`가 쓰는 길).
  assert.equal((await renamePost(server.base, { project: 'group:결제 정산', name: '결제 리뉴얼' })).ok, true);
  assert.match(fs.readFileSync(path.join(server.home, 'tasks.md'), 'utf8'), /group:결제_리뉴얼\]/);
  assert.deepEqual(readJson(path.join(server.home, '.workflow.json')).projectLinks, { '결제 리뉴얼': 'IO-12345' });
});

test('BRENAME: 한 자리라도 실패하면 전부 되돌아간다 — 반쯤 바뀐 이름을 남기지 않는다', async (t) => {
  // 가짜 실패 주입: 주간요약 저장본의 형식을 깨 둔다(마지막 자리에서 터진다).
  const server = await startServer(t, home => seedRename(home, { schema: 2, weeks: {} }));
  const files = ['tasks.md', 'checks.md', 'decisions.md', 'ideas.md', '.workflow.json', '.meeting_links.json', '.report-drafts.json'];
  const before = files.map(name => fs.readFileSync(path.join(server.home, name), 'utf8'));

  const failed = await renamePost(server.base, { project: 'group:결제 리뉴얼', name: '결제 정산' });
  assert.equal(failed.status, 400);
  assert.match(failed.error, /보고 기록 형식을 확인해 주세요/);
  assert.deepEqual(files.map(name => fs.readFileSync(path.join(server.home, name), 'utf8')), before,
    '앞서 쓴 업무 파일·회의 기록·연결 표까지 전부 되돌아간다');

  // 저장은 잠기지 않는다(되돌리기가 받아들여졌으므로) — 다른 저장은 그대로 된다.
  assert.equal((await (await fetch(server.base + '/api/storage-status')).json()).recoveryNeeded, false);
  const created = await fetch(server.base + '/api/today-task/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description: '되돌린 뒤에도 저장은 된다' }) }).then(r => r.json());
  assert.equal(created.ok, true);

  // 같은 요청이 형식을 고친 뒤에는 통한다 — 위에서 되돌아간 것이 "아무것도 안 했다"가 아니라
  // **업무 파일까지 쓴 뒤 되돌린 것**임을 이 줄이 보여 준다.
  fs.writeFileSync(path.join(server.home, '.report-drafts.json'), JSON.stringify(RENAME_REPORT, null, 2));
  assert.equal((await renamePost(server.base, { project: 'group:결제 리뉴얼', name: '결제 정산' })).ok, true);
  assert.match(fs.readFileSync(path.join(server.home, 'tasks.md'), 'utf8'), /group:결제_정산\]/);
});

test('BRENAME: 복구가 필요한 동안에는 이름도 바꾸지 않는다', async (t) => {
  const server = await startServer(t, (home) => {
    seedRename(home);
    fs.writeFileSync(path.join(home, '.mutation-journal.json'), journalEntry(path.join(home, 'tasks.md'), '# Tasks\n', '# Tasks\n- 중단된 저장\n'));
    fs.writeFileSync(path.join(home, '.mutation.lock'), String(deadPid()));
  });
  const blocked = await renamePost(server.base, { project: 'group:결제 리뉴얼', name: '결제 정산' });
  assert.equal(blocked.status, 503);
  assert.match(blocked.error, /저장을 멈췄어요/);
  assert.match(fs.readFileSync(path.join(server.home, 'tasks.md'), 'utf8'), /group:결제_리뉴얼\]/);
});

// ---------- 지라 프로젝트 앱 안 별칭 (BJALIAS) ----------
// 기본은 지라 요약, 별칭이 있으면 앱 안 어디서나 그 이름이다. 지라 요약 자체는 고쳐 쓰지 않는다
// (GET /api/jira/list 응답 불변) — `.workflow.json`의 `projectAliases` 칸 하나만 바뀐다.
const aliasPost = (origin, body) => fetch(origin + '/api/project/alias', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then(async response => ({ status: response.status, ...await response.json() }));

const ALIAS_REPORT = {
  schema: 1,
  weeks: {
    '2026-09-14': {
      rows: [
        { id: 'ar1', heading: '진행중', group: 'IO-48501 · [Q4] 결제 리뉴얼 v2 (iOS/AOS)', bucket: 'jira:IO-48501:진행중:API',
          text: 'API 정리', sourceIds: ['al01'],
          evidence: [{ id: 'al01', description: 'API 정리하기', status: 'to-do', type: 'task', outcome: '', label: 'IO-48501 · [Q4] 결제 리뉴얼 v2 (iOS/AOS)', permalink: null }],
          locked: true, excluded: false },
        // 다른 지라 키(IO-9002)의 행 — 별칭을 바꿔도 이 행은 손대지 않아야 한다.
        { id: 'ar2', heading: '진행중', group: 'IO-9002 · 알림센터', bucket: 'jira:IO-9002:진행중:정비',
          text: '정비', sourceIds: ['al02'],
          evidence: [{ id: 'al02', description: '정비하기', status: 'to-do', type: 'task', outcome: '', label: 'IO-9002 · 알림센터', permalink: null }],
          locked: true, excluded: false },
        // 합쳐진(merge) 행 — parts 안의 문장도 같은 규칙으로 함께 바뀐다.
        { id: 'ar3', heading: '완료한 일', group: 'IO-48501 · [Q4] 결제 리뉴얼 v2 (iOS/AOS)', bucket: 'jira:IO-48501:완료한 일:QA',
          text: 'QA함\nQA 재확인함', sourceIds: ['al04', 'al05'],
          evidence: [{ id: 'al04', description: 'QA', status: 'done', type: 'task', outcome: '', label: 'IO-48501 · [Q4] 결제 리뉴얼 v2 (iOS/AOS)', permalink: null }],
          locked: true, excluded: false,
          parts: [
            { id: 'p1', heading: '완료한 일', group: 'IO-48501 · [Q4] 결제 리뉴얼 v2 (iOS/AOS)', bucket: 'jira:IO-48501:완료한 일:QA', text: 'QA함', sourceIds: ['al04'],
              evidence: [{ id: 'al04', description: 'QA', status: 'done', type: 'task', outcome: '', label: 'IO-48501 · [Q4] 결제 리뉴얼 v2 (iOS/AOS)', permalink: null }], locked: true, excluded: false },
            { id: 'p2', heading: '완료한 일', group: 'IO-48501 · [Q4] 결제 리뉴얼 v2 (iOS/AOS)', bucket: 'jira:IO-48501:완료한 일:QA2', text: 'QA 재확인함', sourceIds: ['al05'],
              evidence: [{ id: 'al05', description: 'QA 재확인', status: 'done', type: 'task', outcome: '', label: 'IO-48501 · [Q4] 결제 리뉴얼 v2 (iOS/AOS)', permalink: null }], locked: true, excluded: false },
          ] },
      ],
      updatedAt: '2026-09-20T00:00:00.000Z',
    },
  },
};
function seedAlias(home) {
  fs.writeFileSync(path.join(home, 'tasks.md'), '# Tasks\n'
    + '- API 정리하기 #task[id:al01 status:to-do priority:high created:2026-09-20 jira:IO-48501]\n'
    + '- 알림센터 정비하기 #task[id:al02 status:to-do priority:medium created:2026-09-20 jira:IO-9002]\n'
    + '- 운영툴 정리하기 #task[id:al03 status:to-do priority:medium created:2026-09-20 group:운영툴]\n');
  fs.writeFileSync(path.join(home, 'jira_issues.md'),
    '# 지라 이슈 (내 담당, 진행중/백로그)\n\n마지막 갱신: 2026-09-20\n\n'
    + '- IO-48501 | 에픽 | 진행 중 | [Q4] 결제 리뉴얼 v2 (iOS/AOS)\n'
    + '- IO-9002 | 에픽 | 진행 중 | 알림센터 정리\n'
    + '- IO-6100 | 에픽 | 진행 중 | 정산 배치 자동화\n');
  // 오늘 캘린더 + 회의↔프로젝트 연결 — resolveProject가 GET마다 새로 라벨을 짓는 자리라, 저장된
  // 정적 문자열이 아니라 이 길로만 별칭 반영을 확인할 수 있다.
  fs.writeFileSync(path.join(home, 'calendar_today.md'), `마지막 갱신: ${today}\n- 10:00-11:00 | 결제 주간 싱크\n`);
  fs.writeFileSync(path.join(home, '.meeting_links.json'), JSON.stringify({ '결제 주간 싱크': 'jira:IO-48501' }, null, 2));
  fs.writeFileSync(path.join(home, '.workflow.json'), JSON.stringify({
    items: {}, meetings: {},
    projectAliases: { 'IO-9002': '알림센터' },
  }, null, 2));
  fs.writeFileSync(path.join(home, '.report-drafts.json'), JSON.stringify(ALIAS_REPORT, null, 2));
}

test('BJALIAS: 별칭 검증 — 형식·길이·대괄호·겹침 3갈래·지라 요약과 같으면 null로 저장한다', async (t) => {
  const server = await startServer(t, seedAlias);
  const refuse = async (body, message) => {
    const answer = await aliasPost(server.base, body);
    assert.equal(answer.status, 400, JSON.stringify(body));
    assert.equal(answer.error, message, JSON.stringify(body));
  };
  const FORMAT = '별칭은 60자 이내 한 줄로, 대괄호 없이 적어 주세요.';
  await refuse({ jira: 'io-48501', alias: '결제 리뉴얼' }, '지라 번호를 확인해 주세요.');
  await refuse({ jira: '결제', alias: '결제 리뉴얼' }, '지라 번호를 확인해 주세요.');
  await refuse({ jira: 'IO-48501', alias: '가'.repeat(61) }, FORMAT);
  await refuse({ jira: 'IO-48501', alias: '결제\n리뉴얼' }, FORMAT);
  await refuse({ jira: 'IO-48501', alias: '결제 [리뉴얼]' }, FORMAT);
  await refuse({ jira: 'IO-48501', alias: '   ' }, FORMAT);
  // 겹침 3갈래: 그룹 이름 · 다른 지라의 별칭 · (자기 자신을 뺀) 지라 요약.
  await refuse({ jira: 'IO-48501', alias: '운영툴' }, '같은 이름의 프로젝트가 이미 있어요.');
  await refuse({ jira: 'IO-48501', alias: '알림센터' }, '같은 이름의 프로젝트가 이미 있어요.');
  await refuse({ jira: 'IO-48501', alias: '알림센터 정리' }, '같은 이름의 프로젝트가 이미 있어요.');

  // 자기 자신의 별칭과는 겹치지 않는다 — 같은 값으로 다시 저장해도 거절되지 않는다.
  assert.equal((await aliasPost(server.base, { jira: 'IO-9002', alias: '알림센터' })).ok, true);
  // 지라 키가 내 목록·캐시에 없어도(IO-77777) 저장은 허용한다 — 요약을 모르는 프로젝트도 이름을 붙일 수 있다.
  assert.deepEqual(await aliasPost(server.base, { jira: 'IO-77777', alias: '모르는 프로젝트' }),
    { status: 200, ok: true, jira: 'IO-77777', alias: '모르는 프로젝트', previous: null });

  // 지라 요약과 정확히 같은 별칭은 저장하지 않고 지운 것과 같이 처리한다(alias:null) — 대괄호가
  // 없는 요약(IO-48501의 요약은 대괄호가 있어 애초에 별칭으로 적을 수 없으므로 다른 키로 확인한다).
  assert.deepEqual(await aliasPost(server.base, { jira: 'IO-6100', alias: '정산 배치 자동화' }),
    { status: 200, ok: true, jira: 'IO-6100', alias: null, previous: null });
});

test('BJALIAS: 저장·지우기가 .workflow.json과 GET /api/items(workflows.projectAliases)에 그대로 나타난다', async (t) => {
  const server = await startServer(t, seedAlias);
  const saved = await aliasPost(server.base, { jira: 'IO-48501', alias: '결제 리뉴얼' });
  assert.deepEqual(saved, { status: 200, ok: true, jira: 'IO-48501', alias: '결제 리뉴얼', previous: null });
  assert.deepEqual(readJson(path.join(server.home, '.workflow.json')).projectAliases, { 'IO-9002': '알림센터', 'IO-48501': '결제 리뉴얼' });
  const data = await (await fetch(server.base + '/api/items')).json();
  assert.deepEqual(data.workflows.projectAliases, { 'IO-9002': '알림센터', 'IO-48501': '결제 리뉴얼' });
  // 지라 요약(GET /api/jira/list에 해당하는 캐시)은 건드리지 않는다.
  assert.equal(data.jiraIssues.find(issue => issue.key === 'IO-48501').summary, '[Q4] 결제 리뉴얼 v2 (iOS/AOS)');

  const cleared = await aliasPost(server.base, { jira: 'IO-48501', alias: null });
  assert.deepEqual(cleared, { status: 200, ok: true, jira: 'IO-48501', alias: null, previous: '결제 리뉴얼' });
  assert.deepEqual(readJson(path.join(server.home, '.workflow.json')).projectAliases, { 'IO-9002': '알림센터' });
});

test('BJALIAS: 회의 프로젝트 라벨(resolveProject)에도 별칭이 붙는다', async (t) => {
  const server = await startServer(t, seedAlias);
  const before = await (await fetch(server.base + '/api/items')).json();
  assert.equal(before.calendar.events[0].project.label, 'IO-48501 · [Q4] 결제 리뉴얼 v2 (iOS/AOS)', '별칭 전에는 지라 요약 그대로다');

  await aliasPost(server.base, { jira: 'IO-48501', alias: '결제 리뉴얼' });
  const after = await (await fetch(server.base + '/api/items')).json();
  assert.equal(after.calendar.events[0].project.label, 'IO-48501 · 결제 리뉴얼');
});

test('BJALIAS: 주간요약 저장본의 group·evidence[].label·parts가 별칭으로 바뀌고, bucket은 그대로이며 다른 키의 행은 손대지 않는다', async (t) => {
  const server = await startServer(t, seedAlias);
  const answer = await aliasPost(server.base, { jira: 'IO-48501', alias: '결제 리뉴얼' });
  assert.equal(answer.ok, true);
  const rows = readJson(path.join(server.home, '.report-drafts.json')).weeks['2026-09-14'].rows;

  const ar1 = rows.find(row => row.id === 'ar1');
  assert.equal(ar1.group, 'IO-48501 · 결제 리뉴얼');
  assert.equal(ar1.bucket, 'jira:IO-48501:진행중:API', 'bucket은 그대로다 — 지라 키는 바뀌지 않는다');
  assert.equal(ar1.evidence[0].label, 'IO-48501 · 결제 리뉴얼');

  const ar3 = rows.find(row => row.id === 'ar3');
  assert.equal(ar3.group, 'IO-48501 · 결제 리뉴얼');
  assert.equal(ar3.evidence[0].label, 'IO-48501 · 결제 리뉴얼');
  assert.equal(ar3.text, 'QA함\nQA 재확인함', '문장은 손대지 않는다');
  assert.equal(ar3.parts[0].group, 'IO-48501 · 결제 리뉴얼');
  assert.equal(ar3.parts[1].group, 'IO-48501 · 결제 리뉴얼');
  assert.equal(ar3.parts[0].evidence[0].label, 'IO-48501 · 결제 리뉴얼');
  assert.equal(ar3.parts[1].evidence[0].label, 'IO-48501 · 결제 리뉴얼');

  // 다른 지라 키(IO-9002)의 행은 손대지 않는다.
  const ar2 = rows.find(row => row.id === 'ar2');
  assert.equal(ar2.group, 'IO-9002 · 알림센터');
  assert.equal(ar2.evidence[0].label, 'IO-9002 · 알림센터');
});

test('BJALIAS: renameProject(그룹 이름 바꾸기)의 겹침 검사에도 별칭이 들어간다', async (t) => {
  const server = await startServer(t, seedAlias);
  await aliasPost(server.base, { jira: 'IO-48501', alias: '결제 리뉴얼' });
  const answer = await renamePost(server.base, { project: 'group:운영툴', name: '결제 리뉴얼' });
  assert.equal(answer.status, 400);
  assert.equal(answer.error, '같은 이름의 프로젝트가 이미 있어요.');
});

test('BJALIAS: projectAliases 칸이 없는 옛 파일은 하나도 없다로 읽히고, 관련 없는 저장이 그 칸을 새로 만들지 않는다', async (t) => {
  const server = await startServer(t, seedRename); // seedRename의 .workflow.json에는 projectAliases 칸이 없다
  const data = await (await fetch(server.base + '/api/items')).json();
  assert.deepEqual(data.workflows.projectAliases, {});
  await renamePost(server.base, { project: 'group:운영툴', name: '운영 콘솔' });
  assert.equal('projectAliases' in readJson(path.join(server.home, '.workflow.json')), false, '고쳐 쓰지 않는다');
});

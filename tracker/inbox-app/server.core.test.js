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
test('set-scheduled의 inbox:true+expect는 새로 들어온 것 표시를 되살린다 — 칸이 없으면 예전 그대로, 그 사이 바뀐 업무·끝낸 업무·틀린 값·없는 업무는 거절', async () => {
  const link = 'https://example.test/undo-inbox';
  const made = await post('/api/import', { kind: 'item', payload: { type: 'task', description: '되돌릴 수집', permalink: link } });
  const line = (id = made.id) => readTasks().split('\n').find(one => one.includes(`id:${id} `) || one.includes(`id:${id}]`));
  const set = body => post('/api/track/set-scheduled', body);
  const inInbox = async () => (await items()).inboxTasks.some(item => item.id === made.id);
  const original = line();
  assert.match(original, /inbox:true/);
  // 칸이 없으면 예전 그대로: 값이 정해지면 표시가 지워지고 다른 칸은 그대로다.
  assert.equal((await set({ id: made.id, scheduled: shifted(1) })).ok, true);
  assert.doesNotMatch(line(), /inbox:/);
  assert.match(line(), new RegExp(`scheduled:${shifted(1)}`));
  assert.equal(await inInbox(), false);
  // 틀린 값·expect 없음·없는 업무·다른 종류는 한 줄도 바꾸지 않는다.
  const check = await post('/api/waiting/create', { description: '되돌리기 대상 아님', who: '동료' });
  assert.ok(check.id);
  const before = readTasks();
  for (const inbox of [false, 'true', 1, null]) assert.equal((await set({ id: made.id, scheduled: null, inbox, expect: shifted(1) })).status, 400, String(inbox));
  assert.equal((await set({ id: made.id, scheduled: null, inbox: true })).status, 400, 'expect 없이 표시만 붙이는 길은 없다');
  for (const expect of ['', 5, '2026-02-30']) assert.equal((await set({ id: made.id, scheduled: null, inbox: true, expect })).status, 400, String(expect));
  assert.equal((await set({ id: made.id, scheduled: '2026-02-30', inbox: true, expect: shifted(1) })).status, 400);
  assert.equal((await set({ id: made.id, scheduled: shifted(2), inbox: true, expect: shifted(1) })).status, 400, 'expect가 맞아도 예정일이 있는 받지 않은 업무는 만들지 않는다');
  assert.equal((await set({ id: 'no-such-task', scheduled: null, inbox: true, expect: null })).status, 404);
  assert.equal((await set({ id: check.id, scheduled: null, inbox: true, expect: null })).status, 404, '할 일이 아니면 대상이 아니다');
  // 그 사이 다른 창에서 다른 날로 옮겼으면(expect와 다름) 409 — 그 날짜를 덮지 않는다.
  const stale = await set({ id: made.id, scheduled: null, inbox: true, expect: shifted(3) });
  assert.equal(stale.status, 409);
  assert.equal(stale.code, 'CHANGED_SINCE');
  assert.equal((await set({ id: made.id, scheduled: null, inbox: true, expect: null })).status, 409, '나중에로 정했던 기록인데 지금은 날짜가 있다');
  assert.equal(readTasks(), before);
  // 되돌리기: 예정일을 없음으로 돌리면서 표시를 되살린다 — 줄이 처음과 같다(원문 링크·새 점 포함).
  assert.equal((await set({ id: made.id, scheduled: null, inbox: true, expect: shifted(1) })).ok, true);
  assert.equal(line(), original);
  assert.equal(await inInbox(), true);
  let data = await items();
  assert.equal(data.laterTasks.some(item => item.id === made.id), false);
  assert.equal(data.todayTasks.some(item => item.id === made.id), false);
  // 나중에: 예정일이 그대로(없음→없음)여도 표시는 지워지고, 되돌리면(expect:null) 되살아나며, 다시 하기는 다시 지운다.
  assert.equal((await set({ id: made.id, scheduled: null })).ok, true);
  assert.doesNotMatch(line(), /inbox:/);
  assert.ok((await items()).laterTasks.some(item => item.id === made.id));
  assert.equal((await set({ id: made.id, scheduled: null, inbox: true, expect: shifted(1) })).status, 409);
  assert.equal((await set({ id: made.id, scheduled: null, inbox: true, expect: null })).ok, true);
  assert.equal(line(), original);
  assert.equal(await inInbox(), true);
  assert.equal((await set({ id: made.id, scheduled: null })).ok, true);
  assert.equal(await inInbox(), false);
  // 끝낸 업무에는 표시를 붙이지 않는다.
  await post('/api/track/toggle', { id: made.id, status: 'done' });
  const done = readTasks();
  assert.equal((await set({ id: made.id, scheduled: null, inbox: true, expect: null })).status, 409);
  assert.equal(readTasks(), done);
  await post('/api/track/toggle', { id: made.id, status: 'to-do' });
  // 원래 새로 들어온 것이 아니던 업무도 expect가 맞아야만 — 틀리면 그대로다.
  const manual = await post('/api/later-task/create', { description: '직접 만든 업무' });
  assert.equal((await set({ id: manual.id, scheduled: null, inbox: true, expect: shifted(2) })).status, 409);
  assert.doesNotMatch(line(manual.id), /inbox:/);
  // 같은 원문을 다시 수집해도 새 항목은 생기지 않는다(중복 판정은 원문 링크).
  assert.equal((await post('/api/import', { kind: 'item', payload: { type: 'task', description: '되돌릴 수집', permalink: link } })).duplicate, true);
});
test('Slack에서 가져온 아이디어는 원문 링크를 들고 있다(아이디어 줄의 원문)',async()=>{
  const permalink='https://example.test/idea-fixture';
  const a=await post('/api/import',{kind:'item',payload:{type:'idea',description:'슬랙 아이디어',permalink}});
  assert.equal(a.ok,true);const ref=(await items()).reportRefs[a.id];assert.equal(ref.type,'idea');assert.equal(ref.permalink,permalink);
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
  // 기한이 지난 legacy는 실행 예정일을 내일로 옮겨도 기한 때문에 오늘 목록에 남는다(WP-T).
  assert.equal(data.todayTasks.find(item => item.id === 'legacy').due, shifted(-2));
  assert.equal(data.todayTasks.find(item => item.id === 'legacy').scheduled, shifted(1));
  assert.equal(data.laterTasks.find(item => item.id === 'unseen').scheduled, shifted(1));
  const restored = await post('/api/workflow/task-batch', { undoToken: changed.undoToken });
  assert.equal(restored.ok, true);
  data = await items();
  assert.equal(data.todayTasks.find(item => item.id === 'legacy').scheduled, shifted(-2));
  assert.doesNotMatch(readTasks().split('\n').find(line => line.includes('id:legacy')), /scheduled:/);
  assert.equal((await post('/api/workflow/task-batch', { undoToken: restored.undoToken })).ok, true);
  assert.equal((await items()).todayTasks.find(item => item.id === 'legacy').scheduled, shifted(1));
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
  // legacy는 기한이 지났으므로 실행 예정일을 옮기거나 지워도 오늘 목록에 선다(WP-T) — 기한은 그대로다.
  await post('/api/track/set-scheduled', { id: 'legacy', scheduled: shifted(1) });
  let item = (await items()).todayTasks.find(item => item.id === 'legacy');
  assert.equal(item.scheduled, shifted(1));
  assert.equal(item.due, shifted(-2));
  await post('/api/track/set-scheduled', { id: 'legacy', scheduled: null });
  item = (await items()).todayTasks.find(item => item.id === 'legacy');
  assert.equal(item.scheduled, null);
  assert.equal(item.due, shifted(-2));
});

// WP-T: 기한이 오늘이거나 지난 미완료 할 일은 실행 예정일이 없거나 미래여도 오늘 목록에 선다(보여 주기만 — 파일은 그대로).
test('기한 오늘·지남 미완료 할 일은 오늘 목록에 서고 나중에 할 일에서는 빠진다 — 받지 않은 슬랙·완료·미래 기한은 제외', async () => {
  fs.writeFileSync(tasksPath, `# Tasks
- 기한 오늘 예정 없음 #task[id:dt1 status:to-do created:${shifted(-3)} scheduled:none due:${today}]
- 기한 지남 예정 미래 #task[id:dt2 status:to-do created:${shifted(-3)} scheduled:${shifted(3)} due:${shifted(-1)}]
- 기한 지남 진행 중 #task[id:dt3 status:to-do created:${shifted(-5)} scheduled:none due:${shifted(-2)} doing:${shifted(-4)}]
- 받지 않은 슬랙 #task[id:dt4 status:to-do created:${today} due:${shifted(-1)} inbox:true source:slack:https://example.test/x]
- 완료한 지난 기한 #task[id:dt5 status:done created:${shifted(-5)} due:${shifted(-1)} completed:${shifted(-1)}]
- 기한 미래 #task[id:dt6 status:to-do created:${shifted(-1)} scheduled:none due:${shifted(2)}]
- 기한 없음 #task[id:dt7 status:to-do created:${shifted(-1)} scheduled:none]
`);
  const original = readTasks();
  const data = await items();
  const ids = list => list.map(item => item.id).filter(id => id.startsWith('dt')).sort();
  assert.deepEqual(ids(data.todayTasks), ['dt1', 'dt2', 'dt3']);
  assert.deepEqual(ids(data.laterTasks), ['dt6', 'dt7'], '오늘 목록에 선 업무는 나중에 할 일에서 빠진다(두 번 나오지 않는다)');
  const all = [...data.todayTasks, ...data.laterTasks].map(item => item.id);
  assert.equal(new Set(all).size, all.length, '같은 업무가 두 목록에 겹치지 않는다');
  assert.equal(data.todayTasks.find(item => item.id === 'dt1').scheduled, null, '실행 예정일을 지어 넣지 않는다(밀림이 아니다)');
  assert.equal(data.todayTasks.find(item => item.id === 'dt2').scheduled, shifted(3));
  assert.equal(data.todayTasks.find(item => item.id === 'dt3').doing, shifted(-4));
  assert.equal(readTasks(), original, '파일은 한 글자도 바뀌지 않는다');
  // 기한을 미래로 미루면 원래 자리(나중에 할 일)로 돌아간다.
  assert.equal((await post('/api/track/set-due', { id: 'dt1', due: shifted(5) })).ok, true);
  const after = await items();
  assert.ok(after.laterTasks.some(item => item.id === 'dt1'));
  assert.ok(!after.todayTasks.some(item => item.id === 'dt1'));
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

// 서버는 당겨오기·미루기 제안을 보내지 않는다 — 앱이 먼저 말 걸지 않는다.
test('the items response carries no suggestions', async (t) => {
  const lines = Array.from({ length: 3 }, (_, i) => `- 업무 ${i} #task[id:few${i} status:to-do priority:low created:${today} scheduled:${today}]`).join('\n');
  const later = `- 나중 업무 #task[id:later1 status:to-do priority:high created:${today} due:${today}]`;
  const server = await startServer(t, home => fs.writeFileSync(path.join(home, 'tasks.md'), `# Tasks\n${lines}\n${later}\n`));
  const data = await (await fetch(server.base + '/api/items')).json();
  assert.ok(data.todayTasks.length >= 3, '시험 준비: 오늘 할 일이 있어야 한다');
  assert.equal('suggestions' in data, false);
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
    + '- 샘플 기능 검수하기 #task[id:rn02 status:to-do priority:medium created:2026-09-20 jira:IO-12345]\n'
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

// 고르는 목록(customGroups)은 프로젝트 탭 왼쪽 목록과 한 출처(workflows.groupList)다 — 끝낸 업무뿐이거나
// 확인 대기·결정·아이디어·회의에만 건 프로젝트도 고르는 목록에서 사라지지 않는다.
test('고르는 목록 출처: 끝낸 업무·모든 종류·회의에 건 이름이 다 들어오고, 밑줄은 공백·코드 순 정렬·중복 없음, 지라 항목의 그룹 칸은 빠진다', async (t) => {
  const server = await startServer(t, (home) => {
    fs.writeFileSync(path.join(home, 'tasks.md'), '# Tasks\n'
      + '- 끝낸 일 #task[id:cg01 status:done priority:medium created:2026-09-01 completed:2026-09-02 group:다_끝남]\n'
      + '- 진행 중 일 #task[id:cg02 status:to-do priority:medium created:2026-09-20 group:운영툴]\n'
      + '- 같은 그룹 둘째 #task[id:cg03 status:to-do priority:medium created:2026-09-20 group:운영툴]\n'
      + '- 지라 일 #task[id:cg04 status:to-do priority:medium created:2026-09-20 jira:IO-1 group:지라에 묻힌_이름]\n');
    fs.writeFileSync(path.join(home, 'checks.md'), '# Checks\n'
      + '- 회신 기다림 #check[id:cg05 status:to-do priority:medium created:2026-09-20 who:하늘 group:확인만]\n');
    fs.writeFileSync(path.join(home, 'decisions.md'), '# Decisions\n'
      + '- 주 단위로 한다 #decision[id:cg06 status:to-do priority:medium created:2026-09-20 group:Beta_결정]\n');
    fs.writeFileSync(path.join(home, 'ideas.md'), '# Ideas\n'
      + '- 리포트 자동화 #idea[id:cg07 status:to-do priority:low created:2026-09-20 project:아이디어_칸]\n');
    fs.writeFileSync(path.join(home, '.workflow.json'), JSON.stringify({
      items: {}, meetings: {
        m1: { id: 'm1', date: '2026-09-20', start: '10:00', end: '11:00', title: '회의', series: '회의', link: null,
          project: { type: 'group', value: '회의에만_건', label: '회의에만 건' } },
      },
    }, null, 2));
  });
  const data = await (await fetch(server.base + '/api/items')).json();
  assert.deepEqual(data.customGroups, ['Beta 결정', '다 끝남', '아이디어 칸', '운영툴', '확인만', '회의에만 건']);
  // 프로젝트 탭 왼쪽 목록(화면 wfProjects)이 같은 내려받은 값에서 세는 그룹과 같다.
  const tab = new Set();
  data.workflows.items.forEach(item => { if (!item.jira && (item.group || item.project)) tab.add(String(item.group || item.project).replace(/_/g, ' ')); });
  data.workflows.meetings.forEach(event => { if (event.project && event.project.type === 'group') tab.add(String(event.project.value).replace(/_/g, ' ')); });
  assert.deepEqual([...tab].sort(), data.customGroups);
  // 이름 겹침 검사(projectNamesTaken)는 그대로 — 끝낸 업무·회의에만 있는 이름과도 겹치면 거절, 지라 항목의 그룹 칸은 자유.
  const taken = async (name) => (await renamePost(server.base, { project: 'group:운영툴', name })).error;
  assert.equal(await taken('다 끝남'), '같은 이름의 프로젝트가 이미 있어요.');
  assert.equal(await taken('회의에만 건'), '같은 이름의 프로젝트가 이미 있어요.');
  assert.equal(await taken('beta  결정'), '같은 이름의 프로젝트가 이미 있어요.');
  assert.equal((await renamePost(server.base, { project: 'group:운영툴', name: '지라에 묻힌 이름' })).ok, true);
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
  assert.match(tasks, /샘플 기능 검수하기 #task\[id:rn02 status:to-do priority:medium created:2026-09-20 jira:IO-12345\]/);
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

// ---------- 직접 만든 프로젝트 합치기·지우기 (BMERGE) ----------
// A를 B로 합치거나(to: 'group:B') A의 소속을 풀어(to: null) 여섯 자리를 한 트랜잭션으로 바꾼다. 되돌리기는
// 기록(`projectMerges`)에 남은 것만, 지금도 합친 뒤 모양일 때만 돌린다.
const mergeFetch = (route) => (origin, body, key) => fetch(origin + route, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
  body: JSON.stringify(body),
}).then(async response => ({ status: response.status, ...await response.json() }));
const mergePost = mergeFetch('/api/project/merge');
const mergeUndoPost = mergeFetch('/api/project/merge-undo');
const MERGE_FILES = ['tasks.md', 'checks.md', 'decisions.md', 'ideas.md', '.workflow.json', '.meeting_links.json', '.report-drafts.json'];
const mergeSnapshot = home => MERGE_FILES.map(name => fs.readFileSync(path.join(home, name), 'utf8'));
const MERGE_REPORT = {
  schema: 1,
  weeks: {
    '2026-09-07': {
      rows: [
        { id: 'w1', heading: '완료한 일', group: '결제 리뉴얼', bucket: 'group:결제 리뉴얼:완료한 일:정산 설계',
          text: '정산 설계 마침', sourceIds: ['mg02'], evidence: [{ id: 'mg02', description: '정산 설계', status: 'done', type: 'task', outcome: '', label: '결제 리뉴얼', permalink: null }],
          locked: true, excluded: false },
      ],
      updatedAt: '2026-09-12T00:00:00.000Z',
    },
    '2026-09-14': {
      rows: [
        { id: 'r1', heading: '진행중', group: '결제 리뉴얼', bucket: 'group:결제 리뉴얼:진행중:정산 배치',
          text: '정산 배치 진행', sourceIds: ['mg01'], evidence: [{ id: 'mg01', description: '정산 배치', status: 'to-do', type: 'task', outcome: '', label: '결제 리뉴얼', permalink: null }],
          locked: true, excluded: false },
        { id: 'r2', heading: '진행중', group: '가입 개편', bucket: 'group:가입 개편:진행중:가입 화면',
          text: '가입 화면 개편', sourceIds: ['mg04'], evidence: [], locked: true, excluded: false },
      ],
      updatedAt: '2026-09-20T00:00:00.000Z',
    },
  },
  weekPolish: {
    // 확정한 주 — 합치기는 이 주의 기록도 바꾼다.
    '2026-09-07': { lockedAt: '2026-09-12T00:00:00.000Z', names: { '완료한 일|group:결제 리뉴얼': '정산 마무리' } },
    // 같은 주에 A·B 소제목 이름이 다 있으면 B 것을 남긴다.
    '2026-09-14': { names: { '진행중|group:결제 리뉴얼': 'A가 고친 이름', '진행중|group:가입 개편': 'B가 고친 이름' } },
  },
};
function seedMerge(home, { report = MERGE_REPORT, links = { '결제 리뉴얼': 'PAY-1' } } = {}) {
  fs.writeFileSync(path.join(home, 'tasks.md'), '# Tasks\n'
    + '- 정산 배치 만들기 #task[id:mg01 status:to-do priority:high created:2026-09-20 group:결제_리뉴얼]\n'
    + '- 정산 설계 #task[id:mg02 status:done priority:medium created:2026-09-01 completed:2026-09-08 group:결제_리뉴얼]\n'
    + '- 지라에 걸린 일 #task[id:mg03 status:to-do priority:medium created:2026-09-20 jira:PAY-12 group:결제_리뉴얼]\n'
    + '- 가입 화면 개편 #task[id:mg04 status:to-do priority:medium created:2026-09-20 group:가입_개편]\n');
  fs.writeFileSync(path.join(home, 'checks.md'), '# Checks\n'
    + '- 법무 회신 #check[id:mg05 status:to-do priority:medium created:2026-09-20 who:하늘 group:결제_리뉴얼]\n');
  fs.writeFileSync(path.join(home, 'decisions.md'), '# Decisions\n'
    + '- 주 단위로 정산 #decision[id:mg06 status:to-do priority:medium created:2026-09-20 group:결제_리뉴얼]\n');
  fs.writeFileSync(path.join(home, 'ideas.md'), '# Ideas\n'
    + '- 정산 리포트 자동화 #idea[id:mg07 status:to-do priority:low created:2026-09-20 project:결제_리뉴얼]\n');
  fs.writeFileSync(path.join(home, '.workflow.json'), JSON.stringify({
    items: {}, meetings: {
      m1: { id: 'm1', date: '2026-09-20', start: '10:00', end: '11:00', title: '결제 주간 싱크', series: '결제 주간 싱크', link: null,
        project: { type: 'group', value: '결제 리뉴얼', label: '결제 리뉴얼' } },
      m2: { id: 'm2', date: '2026-09-19', start: '14:00', end: '15:00', title: '가입 회의', series: '가입 회의', link: null,
        project: { type: 'group', value: '가입 개편', label: '가입 개편' } },
    },
    projectLinks: links,
    projectArchive: { 'group:결제 리뉴얼': '2026-09-19' },
    projectMoves: [],
  }, null, 2));
  fs.writeFileSync(path.join(home, '.meeting_links.json'), JSON.stringify({ '결제 주간 싱크': 'group:결제 리뉴얼', '가입 회의': 'group:가입 개편' }, null, 2));
  fs.writeFileSync(path.join(home, '.report-drafts.json'), JSON.stringify(report, null, 2));
}

test('BMERGE: 그룹 → 그룹 합치기 — 업무 넷(끝낸 것 포함)·아이디어·회의·연결표·주간요약이 한 요청에 바뀌고 원래 프로젝트가 사라진다', async (t) => {
  const server = await startServer(t, seedMerge);
  const answer = await mergePost(server.base, { project: 'group:결제 리뉴얼', to: 'group:가입 개편' });
  assert.equal(answer.status, 200, JSON.stringify(answer));
  assert.match(answer.mergeId, /^mg_/);
  assert.deepEqual({ ...answer, mergeId: undefined }, {
    status: 200, ok: true, project: 'group:가입 개편', from: '결제 리뉴얼', to: '가입 개편', mergeId: undefined,
    changed: { items: 5, meetings: 2, links: 1, report: 2 },
  });
  const tasks = fs.readFileSync(path.join(server.home, 'tasks.md'), 'utf8');
  assert.match(tasks, /id:mg01 status:to-do priority:high created:2026-09-20 group:가입_개편\]/);
  assert.match(tasks, /id:mg02 status:done .* group:가입_개편\]/, '끝낸 항목도 따라간다');
  assert.match(tasks, /id:mg03 .* jira:PAY-12 group:결제_리뉴얼\]/, '지라가 걸린 줄은 건너뛴다');
  assert.match(fs.readFileSync(path.join(server.home, 'checks.md'), 'utf8'), /group:가입_개편\]/);
  assert.match(fs.readFileSync(path.join(server.home, 'decisions.md'), 'utf8'), /group:가입_개편\]/);
  assert.match(fs.readFileSync(path.join(server.home, 'ideas.md'), 'utf8'), /project:가입_개편\]/);
  const workflow = readJson(path.join(server.home, '.workflow.json'));
  assert.deepEqual(workflow.meetings.m1.project, { type: 'group', value: '가입 개편', label: '가입 개편' });
  assert.deepEqual(workflow.projectLinks, { '가입 개편': 'PAY-1' }, 'B에 연결이 없으면 A 것이 B로 옮겨 간다');
  assert.deepEqual(workflow.projectArchive, { 'group:가입 개편': '2026-09-19' });
  assert.deepEqual(workflow.projectMoves, [], '옮기기 기록과 섞이지 않는다');
  assert.equal(workflow.projectMerges.length, 1);
  assert.deepEqual(readJson(path.join(server.home, '.meeting_links.json')), { '결제 주간 싱크': 'group:가입 개편', '가입 회의': 'group:가입 개편' });
  const report = readJson(path.join(server.home, '.report-drafts.json'));
  assert.deepEqual([report.weeks['2026-09-14'].rows[0].group, report.weeks['2026-09-14'].rows[0].bucket, report.weeks['2026-09-14'].rows[0].evidence[0].label],
    ['가입 개편', 'group:가입 개편:진행중:정산 배치', '가입 개편']);
  assert.equal(report.weeks['2026-09-07'].rows[0].bucket, 'group:가입 개편:완료한 일:정산 설계', '확정한 지난 주도 바뀐다');
  assert.deepEqual(report.weekPolish['2026-09-07'].names, { '완료한 일|group:가입 개편': '정산 마무리' });
  assert.deepEqual(report.weekPolish['2026-09-14'].names, { '진행중|group:결제 리뉴얼': 'A가 고친 이름', '진행중|group:가입 개편': 'B가 고친 이름' },
    '같은 주에 B 소제목 이름이 있으면 B 것을 남긴다(A 것은 옛 열쇠에 남아 쓰이지 않는다)');
  const data = await (await fetch(server.base + '/api/items')).json();
  assert.ok(!data.customGroups.includes('결제 리뉴얼') && data.customGroups.includes('가입 개편'), '원래 프로젝트는 목록에서 사라진다');
  assert.equal(JSON.stringify(data).includes('projectMerges'), false, '기록은 화면에 내려보내지 않는다');
});

test('BMERGE: 합치기 되돌리기 — 기록된 것만 원래대로, 그 사이 다른 프로젝트로 옮긴 항목은 건너뛰고 skipped로 센다', async (t) => {
  const server = await startServer(t, seedMerge);
  const before = mergeSnapshot(server.home);
  const merged = await mergePost(server.base, { project: 'group:결제 리뉴얼', to: 'group:가입 개편' });
  // 그 사이 mg05를 다른 프로젝트로 옮긴다(앱의 다른 저장 길).
  const moved = await fetch(server.base + '/api/track/set-group', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'mg05', group: '운영툴' }) });
  assert.equal(moved.status, 200, await moved.text());
  const undone = await mergeUndoPost(server.base, { mergeId: merged.mergeId });
  assert.equal(undone.status, 200, JSON.stringify(undone));
  assert.equal(undone.project, 'group:결제 리뉴얼');
  assert.equal(undone.skipped, 1, '옮긴 확인 대기 하나만 건너뛴다');
  assert.deepEqual(undone.restored, { items: 4, meetings: 2, report: 2 });
  assert.match(fs.readFileSync(path.join(server.home, 'checks.md'), 'utf8'), /id:mg05 .*group:운영툴/, '건너뛴 것은 그대로 둔다');
  const after = mergeSnapshot(server.home);
  ['tasks.md', 'decisions.md', 'ideas.md', '.meeting_links.json', '.report-drafts.json'].forEach((name) => {
    assert.equal(after[MERGE_FILES.indexOf(name)], before[MERGE_FILES.indexOf(name)], `${name}은 합치기 전과 같다`);
  });
  const workflow = readJson(path.join(server.home, '.workflow.json'));
  const original = JSON.parse(before[MERGE_FILES.indexOf('.workflow.json')]);
  assert.deepEqual(workflow.meetings, original.meetings);
  assert.deepEqual(workflow.projectLinks, original.projectLinks);
  assert.deepEqual(workflow.projectArchive, original.projectArchive);
  assert.deepEqual(workflow.projectMerges, [], '한 번 되돌리면 기록이 지워진다');
  // 두 번째는 기록이 없다.
  const again = await mergeUndoPost(server.base, { mergeId: merged.mergeId });
  assert.equal(again.status, 400);
  assert.equal(again.error, '되돌릴 기록이 없어요.');
});

test('BMERGE: 지우기 — 항목 칸·회의 프로젝트가 비고 연결표 줄이 빠지며 주간요약은 바이트 그대로, 되돌리면 모두 돌아온다', async (t) => {
  const server = await startServer(t, seedMerge);
  const before = mergeSnapshot(server.home);
  const answer = await mergePost(server.base, { project: 'group:결제 리뉴얼', to: null });
  assert.equal(answer.status, 200, JSON.stringify(answer));
  assert.equal(answer.project, null);
  assert.equal(answer.to, null);
  assert.deepEqual(answer.changed, { items: 5, meetings: 2, links: 1, report: 0 });
  const tasks = fs.readFileSync(path.join(server.home, 'tasks.md'), 'utf8');
  assert.match(tasks, /id:mg01 status:to-do priority:high created:2026-09-20\]/, '칸이 빠진다');
  assert.match(tasks, /id:mg03 .* jira:PAY-12 group:결제_리뉴얼\]/);
  assert.match(fs.readFileSync(path.join(server.home, 'ideas.md'), 'utf8'), /id:mg07 status:to-do priority:low created:2026-09-20\]/);
  const workflow = readJson(path.join(server.home, '.workflow.json'));
  assert.equal(workflow.meetings.m1.project, null);
  assert.deepEqual(workflow.projectLinks, {});
  assert.deepEqual(workflow.projectArchive, { 'group:결제 리뉴얼': '2026-09-19' }, '보관 표는 그대로 둔다');
  assert.deepEqual(readJson(path.join(server.home, '.meeting_links.json')), { '가입 회의': 'group:가입 개편' });
  assert.equal(fs.readFileSync(path.join(server.home, '.report-drafts.json'), 'utf8'), before[MERGE_FILES.indexOf('.report-drafts.json')], '주간요약은 건드리지 않는다');
  const data = await (await fetch(server.base + '/api/items')).json();
  assert.ok(!data.customGroups.includes('결제 리뉴얼'));
  assert.equal((await (await fetch(server.base + '/api/track/trash')).json()).items.length, 0, '항목은 휴지통으로 가지 않는다');

  const undone = await mergeUndoPost(server.base, { mergeId: answer.mergeId });
  assert.equal(undone.status, 200, JSON.stringify(undone));
  assert.equal(undone.skipped, 0);
  const after = mergeSnapshot(server.home);
  ['checks.md', 'decisions.md', '.report-drafts.json'].forEach((name) => {
    assert.equal(after[MERGE_FILES.indexOf(name)], before[MERGE_FILES.indexOf(name)], `${name}은 지우기 전과 같다`);
  });
  // 연결표는 뺐던 줄이 다시 들어가 열쇠 차례만 바뀐다(뜻은 같다).
  assert.deepEqual(JSON.parse(after[MERGE_FILES.indexOf('.meeting_links.json')]), JSON.parse(before[MERGE_FILES.indexOf('.meeting_links.json')]));
  // 업무 줄은 칸이 끝에 다시 붙는다(칸 차례는 뜻이 없다) — 같은 프로젝트로 돌아왔는지 본다.
  const back = await (await fetch(server.base + '/api/items')).json();
  assert.ok(back.customGroups.includes('결제 리뉴얼'));
  ['mg01', 'mg02', 'mg05', 'mg06'].forEach((id) => {
    assert.equal(back.workflows.items.find(item => item.id === id).group, '결제 리뉴얼', id);
  });
  assert.equal(back.workflows.items.find(item => item.id === 'mg07').project, '결제 리뉴얼');
  const workflowBack = readJson(path.join(server.home, '.workflow.json'));
  assert.deepEqual(workflowBack.meetings, JSON.parse(before[MERGE_FILES.indexOf('.workflow.json')]).meetings);
  assert.deepEqual(workflowBack.projectLinks, { '결제 리뉴얼': 'PAY-1' });
});

test('BMERGE: 주간요약 되돌리기는 합치기가 바꾼 칸만 — 한 문장에 원래부터 있던 B 근거·B 소제목은 A로 가지 않는다', async (t) => {
  const report = structuredClone(MERGE_REPORT);
  report.weeks['2026-09-14'].rows.push({ id: 'r3', heading: '진행중', group: '가입 개편', bucket: 'group:가입 개편:진행중:섞인 문장',
    text: '두 프로젝트 근거가 섞인 문장', sourceIds: ['mg01', 'mg04'],
    evidence: [{ id: 'mg01', label: '결제 리뉴얼' }, { id: 'mg04', label: '가입 개편' }], locked: true, excluded: false });
  const server = await startServer(t, home => seedMerge(home, { report }));
  const before = fs.readFileSync(path.join(server.home, '.report-drafts.json'), 'utf8');
  const merged = await mergePost(server.base, { project: 'group:결제 리뉴얼', to: 'group:가입 개편' });
  const mixed = readJson(path.join(server.home, '.report-drafts.json')).weeks['2026-09-14'].rows.find(row => row.id === 'r3');
  assert.deepEqual(mixed.evidence.map(item => item.label), ['가입 개편', '가입 개편']);
  const undone = await mergeUndoPost(server.base, { mergeId: merged.mergeId });
  assert.equal(undone.skipped, 0);
  assert.equal(fs.readFileSync(path.join(server.home, '.report-drafts.json'), 'utf8'), before, '원래부터 B였던 소제목·근거는 B 그대로, 저장본이 합치기 전과 같다');
});

test('BMERGE: 수동 지라 연결이 둘 다 있으면 대상 것을 남기고, 되돌리면 원래 것이 다시 붙는다', async (t) => {
  const server = await startServer(t, home => seedMerge(home, { links: { '결제 리뉴얼': 'PAY-1', '가입 개편': 'PAY-2' } }));
  const answer = await mergePost(server.base, { project: 'group:결제 리뉴얼', to: 'group:가입 개편' });
  assert.equal(answer.changed.links, 1);
  assert.deepEqual(readJson(path.join(server.home, '.workflow.json')).projectLinks, { '가입 개편': 'PAY-2' });
  await mergeUndoPost(server.base, { mergeId: answer.mergeId });
  assert.deepEqual(readJson(path.join(server.home, '.workflow.json')).projectLinks, { '가입 개편': 'PAY-2', '결제 리뉴얼': 'PAY-1' });
});

test('BMERGE: 거절 — 지라 프로젝트를 원래로·자기 자신·없는 대상·지라 대상·모르는 프로젝트·빈 to는 어떤 파일도 바꾸지 않는다', async (t) => {
  const server = await startServer(t, seedMerge);
  const before = mergeSnapshot(server.home);
  const refuse = async (body, message) => {
    const answer = await mergePost(server.base, body);
    assert.equal(answer.status, 400, JSON.stringify(body));
    assert.equal(answer.error, message, JSON.stringify(body));
  };
  await refuse({ project: 'jira:PAY-12', to: 'group:가입 개편' }, '직접 만든 프로젝트만 합치거나 지울 수 있어요.');
  await refuse({ project: 'group:결제 리뉴얼', to: 'group:결제 리뉴얼' }, '같은 프로젝트예요.');
  await refuse({ project: 'group:결제 리뉴얼', to: 'group:결제_리뉴얼' }, '같은 프로젝트예요.');
  await refuse({ project: 'group:결제 리뉴얼', to: 'group:없는 프로젝트' }, '합칠 프로젝트를 찾을 수 없어요.');
  await refuse({ project: 'group:결제 리뉴얼', to: 'jira:PAY-12' }, '지라 에픽으로 합칠 때는 옮기기를 써요.');
  await refuse({ project: 'group:모르는 프로젝트', to: 'group:가입 개편' }, '프로젝트를 찾을 수 없어요.');
  await refuse({ project: 'group:결제 리뉴얼' }, '합칠 프로젝트를 확인해 주세요.');
  await refuse({ project: 'group:결제 리뉴얼', to: '가입 개편' }, '합칠 프로젝트를 확인해 주세요.');
  await refuse({ project: 'group:결제 리뉴얼', to: 'group:  ' }, '합칠 프로젝트를 확인해 주세요.');
  assert.deepEqual(mergeSnapshot(server.home), before);
  const undo = await mergeUndoPost(server.base, { mergeId: 'mg_없는기록' });
  assert.equal(undo.error, '되돌릴 기록이 없어요.');
  assert.deepEqual(mergeSnapshot(server.home), before);
});

test('BMERGE: 대소문자만 다른 두 프로젝트(Pay Renewal · pay renewal)도 합칠 수 있다', async (t) => {
  const server = await startServer(t, (home) => {
    seedMerge(home);
    fs.appendFileSync(path.join(home, 'tasks.md'), '- 큰 글자 #task[id:mg08 status:to-do created:2026-09-20 group:Pay_Renewal]\n- 작은 글자 #task[id:mg09 status:to-do created:2026-09-20 group:pay_renewal]\n');
  });
  const answer = await mergePost(server.base, { project: 'group:Pay Renewal', to: 'group:pay renewal' });
  assert.equal(answer.status, 200, JSON.stringify(answer));
  assert.equal(answer.changed.items, 1);
  assert.match(fs.readFileSync(path.join(server.home, 'tasks.md'), 'utf8'), /id:mg08 status:to-do created:2026-09-20 group:pay_renewal\]/);
});

test('BMERGE: id가 없는 줄이 있으면 아무것도 쓰기 전에 거절한다', async (t) => {
  const server = await startServer(t, (home) => {
    seedMerge(home);
    fs.appendFileSync(path.join(home, 'decisions.md'), '- 아주 옛 줄 #decision[status:to-do created:2026-01-01 group:결제_리뉴얼]\n');
  });
  const before = mergeSnapshot(server.home);
  const answer = await mergePost(server.base, { project: 'group:결제 리뉴얼', to: null });
  assert.equal(answer.status, 400);
  assert.equal(answer.error, 'id가 없는 항목이 있어 되돌릴 수 없어요.');
  assert.deepEqual(mergeSnapshot(server.home), before);
});

test('BMERGE: 중간(주간요약 쓰기)에서 실패하면 업무 파일·회의·연결표까지 전부 원래대로 — 부분 쓰기가 없다', async (t) => {
  const server = await startServer(t, home => seedMerge(home, { report: { schema: 2, weeks: {} } }));
  const before = mergeSnapshot(server.home);
  const failed = await mergePost(server.base, { project: 'group:결제 리뉴얼', to: 'group:가입 개편' });
  assert.equal(failed.status, 400);
  assert.match(failed.error, /보고 기록 형식을 확인해 주세요/);
  assert.deepEqual(mergeSnapshot(server.home), before, '앞서 쓴 업무 파일·.workflow.json·연결표까지 되돌아간다');
  assert.equal((await (await fetch(server.base + '/api/storage-status')).json()).recoveryNeeded, false);
});

test('BMERGE: 같은 요청 id 두 번이면 한 번만 합친다', async (t) => {
  const server = await startServer(t, seedMerge);
  const key = 'bmerge-idempotency-key-0001';
  const first = await mergePost(server.base, { project: 'group:결제 리뉴얼', to: 'group:가입 개편' }, key);
  const second = await mergePost(server.base, { project: 'group:결제 리뉴얼', to: 'group:가입 개편' }, key);
  assert.equal(first.ok, true);
  assert.deepEqual(second, first, '두 번째는 처음 결과를 그대로 돌려준다');
  assert.equal(readJson(path.join(server.home, '.workflow.json')).projectMerges.length, 1);
});

test('BMERGE: projectMerges 칸이 없는 옛 파일에서도 되고, 옮기기 되돌리기(move-undo)에 합치기 id를 주면 거절한다', async (t) => {
  const server = await startServer(t, (home) => {
    seedMerge(home);
    const state = readJson(path.join(home, '.workflow.json'));
    delete state.projectMoves;
    fs.writeFileSync(path.join(home, '.workflow.json'), JSON.stringify(state, null, 2));
  });
  assert.equal(readJson(path.join(server.home, '.workflow.json')).projectMerges, undefined);
  const answer = await mergePost(server.base, { project: 'group:결제 리뉴얼', to: 'group:가입 개편' });
  assert.equal(answer.ok, true);
  const workflow = readJson(path.join(server.home, '.workflow.json'));
  assert.equal(workflow.projectMerges.length, 1);
  assert.equal(workflow.projectMoves, undefined, '옮기기 기록 칸을 만들지 않는다');
  const wrong = await fetch(server.base + '/api/project/move-undo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ moveId: answer.mergeId }) })
    .then(async response => ({ status: response.status, ...await response.json() }));
  assert.equal(wrong.status, 400);
  assert.equal(wrong.error, '되돌릴 기록이 없어요.');
  assert.equal(readJson(path.join(server.home, '.workflow.json')).projectMerges.length, 1, '합치기 기록은 그대로 남는다');
});

test('BMERGE: 복구가 필요한 동안에는 합치지도 되돌리지도 않는다', async (t) => {
  const server = await startServer(t, (home) => {
    seedMerge(home);
    fs.writeFileSync(path.join(home, '.mutation-journal.json'), journalEntry(path.join(home, 'tasks.md'), '# Tasks\n', '# Tasks\n- 중단된 저장\n'));
    fs.writeFileSync(path.join(home, '.mutation.lock'), String(deadPid()));
  });
  const blocked = await mergePost(server.base, { project: 'group:결제 리뉴얼', to: null });
  assert.equal(blocked.status, 503);
  assert.match(blocked.error, /저장을 멈췄어요/);
  assert.equal((await mergeUndoPost(server.base, { mergeId: 'mg_x' })).status, 503);
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

// ---------- WP-W: `답변 왔어요` 확인 · 회의 연결 뒤 이미 담은 항목 옮기기 ----------

test('WP-W 답변 확인: 답이 온 업무에만 적고(흐름 기록 칸 하나), 종류를 바꾸면 함께 지운다', async () => {
  const check = await post('/api/waiting/create', { description: 'WP-W 답을 기다리는 확인' });
  assert.equal((await post('/api/workflow/item', { id: 'legacy', blockedBy: check.id })).ok, true);
  const before = fs.readFileSync(path.join(directory, '.workflow.json'), 'utf8');
  assert.equal((await post('/api/workflow/answer-seen', { id: 'legacy' })).status, 400, '아직 답이 없으면 거절');
  assert.equal((await post('/api/workflow/answer-seen', { id: check.id })).status, 400, '업무가 아니면 거절');
  assert.equal((await post('/api/workflow/answer-seen', { id: 'missing' })).status, 400);
  assert.equal(fs.readFileSync(path.join(directory, '.workflow.json'), 'utf8'), before, '거절하면 아무것도 쓰지 않는다');
  await post('/api/track/toggle', { id: check.id, status: 'done' });
  const tasksBefore = readTasks();
  const seen = await post('/api/workflow/answer-seen', { id: 'legacy' });
  assert.equal(seen.ok, true);
  assert.equal(seen.answerSeen.answer, `${check.id}:${today}`, '답 = 기다리던 확인 대기 번호 + 그 완료일');
  assert.ok(!Number.isNaN(Date.parse(seen.answerSeen.at)));
  assert.equal(readTasks(), tasksBefore, '업무 파일은 건드리지 않는다');
  const item = (await items()).workflows.items.find(entry => entry.id === 'legacy');
  assert.deepEqual(item.answerSeen, seen.answerSeen, '목록 응답에 그대로 실려 기기마다 같다');
  // 같은 답을 두 번 적어도 처음 확인 시각이 남는다.
  assert.equal((await post('/api/workflow/answer-seen', { id: 'legacy' })).answerSeen.at, seen.answerSeen.at);
  // 할 일 → 확인 대기로 바꾸면 기다리던 답변 연결과 함께 확인 표시도 지워진다.
  assert.equal((await post('/api/workflow/retype', { id: 'legacy', type: 'check' })).ok, true);
  const moved = (await items()).workflows.items.find(entry => entry.id === 'legacy');
  assert.equal(moved.blockedBy, undefined);
  assert.equal(moved.answerSeen, undefined);
});

test('WP-W 지난 회의에서 프로젝트를 연결하면 그 회의도 바뀌고, 이미 담은 항목은 `옮기기`로만 옮겨지며(아이디어 포함·끝낸 것 거절) 한 번에 되돌린다, 해제는 `빼기`', async (t) => {
  const checksPath = path.join(directory, 'checks.md');
  const decisionsPath = path.join(directory, 'decisions.md');
  const ideasPath = path.join(directory, 'ideas.md');
  const calendarPath = path.join(directory, 'calendar_today.md');
  const keep = [checksPath, decisionsPath, ideasPath, calendarPath].map(file => [file, fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null]);
  const linksPath = path.join(directory, '.meeting_links.json');
  const linksBefore = fs.existsSync(linksPath) ? fs.readFileSync(linksPath, 'utf8') : null;
  t.after(() => {
    keep.forEach(([file, text]) => { if (text === null) fs.rmSync(file, { force: true }); else fs.writeFileSync(file, text); });
    if (linksBefore === null) fs.rmSync(linksPath, { force: true }); else fs.writeFileSync(linksPath, linksBefore);
  });
  const title = 'WP-W 결제 주간';
  fs.writeFileSync(checksPath, `# Checks\n- 법무 회신 #check[id:wpw-c status:to-do priority:medium created:${today} group:가입_개선]\n`);
  fs.writeFileSync(decisionsPath, `# Decisions\n- 정산은 매주 #decision[id:wpw-d status:to-do priority:medium created:${today} jira:IO-9]\n- 끝낸 결정 #decision[id:wpw-done status:done priority:medium created:${today} completed:${today}]\n`);
  fs.writeFileSync(ideasPath, `# Ideas\n- 결제 화면 개선 아이디어 #idea[id:wpw-i status:to-do created:${today}]\n`);
  fs.appendFileSync(tasksPath, `- 이미 그 프로젝트 #task[id:wpw-same status:to-do priority:medium created:${today} group:결제_리뉴얼]\n- 다른 회의 #task[id:wpw-other status:to-do priority:medium created:${today}]\n`);
  fs.writeFileSync(path.join(directory, '.workflow.json'), JSON.stringify({
    items: { legacy: { meetingId: 'wpw-past' }, 'wpw-c': { meetingId: 'wpw-past' }, 'wpw-d': { meetingId: 'wpw-past' }, 'wpw-same': { meetingId: 'wpw-past' }, 'wpw-i': { meetingId: 'wpw-past' }, 'wpw-done': { meetingId: 'wpw-past' } },
    meetings: { 'wpw-past': { id: 'wpw-past', date: shifted(-7), start: '10:00', end: '11:00', title, series: title, project: null } },
  }));

  // ① 지난 회의에서 연결: 제목별 연결 + 그 회의의 프로젝트가 함께 바뀐다(항목은 아직 그대로).
  const tasksBefore = readTasks();
  assert.equal((await post('/api/meeting/set-project', { title, project: 'group:결제 리뉴얼', meetingId: 'wpw-past' })).ok, true);
  const past = (await items()).workflows.meetings.find(event => event.id === 'wpw-past');
  assert.deepEqual(past.project, { type: 'group', value: '결제 리뉴얼', label: '결제 리뉴얼' });
  assert.equal(readTasks(), tasksBefore, '연결만으로는 이미 담은 항목이 옮겨지지 않는다');
  assert.equal(readJson(linksPath)[title], 'group:결제 리뉴얼');

  // ② 거절: 다른 회의 항목·끝낸 항목·틀린 프로젝트 — 하나라도 틀리면 전부 그대로(한 트랜잭션).
  assert.equal((await post('/api/meeting/move-items', { meetingId: 'wpw-past', project: 'group:결제 리뉴얼', ids: ['legacy', 'wpw-other'] })).status, 400);
  const doneSkip = await post('/api/meeting/move-items', { meetingId: 'wpw-past', project: 'group:결제 리뉴얼', ids: ['wpw-done'] });
  assert.deepEqual({ ok: doneSkip.ok, count: doneSkip.count, skipped: doneSkip.skipped }, { ok: true, count: 0, skipped: 1 }, '끝낸 항목은 옮기지 않고 건너뛴다');
  assert.equal(readTasks(), tasksBefore);
  assert.equal((await post('/api/meeting/move-items', { meetingId: 'wpw-past', project: 'nope', ids: ['legacy'] })).status, 400);
  // ③ 옮기기: 보여 준 번호만, 이미 그 프로젝트인 것은 세지 않는다. 아이디어는 제 프로젝트 칸으로.
  // from(이전 프로젝트)이 없으면(처음 연결) 프로젝트가 없는 것만 옮기고, 이미 다른 프로젝트에 있는 것(wpw-c·wpw-d)은 건너뛴다.
  const first = await post('/api/meeting/move-items', { meetingId: 'wpw-past', project: 'group:결제 리뉴얼', from: null, ids: ['wpw-c'] });
  assert.deepEqual({ count: first.count, skipped: first.skipped }, { count: 0, skipped: 1 }, '그 사이 다른 프로젝트에 있으면 덮지 않는다');
  assert.match(fs.readFileSync(checksPath, 'utf8'), /group:가입_개선/);
  // 변경 A→B에서 from=A면 A에 있던 것만 옮긴다 — 여기서는 각 항목의 원래 자리를 from으로 한 번씩 확인하는 대신,
  // 가입 개선(C)에 있던 wpw-c를 from으로 준 경우 옮겨지는 것을 본다.
  const moved = await post('/api/meeting/move-items', { meetingId: 'wpw-past', project: 'group:결제 리뉴얼', from: 'group:가입_개선', ids: ['legacy', 'wpw-c', 'wpw-d', 'wpw-same', 'wpw-i'] });
  assert.equal(moved.ok, true);
  assert.equal(moved.skipped, 1, '지라 IO-9에 있던 결정은 from이 아니라 건너뛴다');
  const movedD = await post('/api/meeting/move-items', { meetingId: 'wpw-past', project: 'group:결제 리뉴얼', from: 'jira:IO-9', ids: ['wpw-d'] });
  assert.equal(movedD.count, 1);
  moved.moved.splice(2, 0, ...movedD.moved);
  moved.count += movedD.count;
  assert.equal(moved.count, 4);
  assert.deepEqual(moved.moved, [{ id: 'legacy', from: null }, { id: 'wpw-c', from: 'group:가입 개선' }, { id: 'wpw-d', from: 'jira:IO-9' }, { id: 'wpw-i', from: null }]);
  const keyAll = async () => { const list = (await items()).workflows.items; return id => { const item = list.find(entry => entry.id === id); return item.jira ? `jira:${item.jira}` : (item.group || item.project) ? `group:${item.group || item.project}` : null; }; };
  let keyOf = await keyAll();
  assert.deepEqual(['legacy', 'wpw-c', 'wpw-d', 'wpw-same', 'wpw-i', 'wpw-other', 'wpw-done'].map(keyOf),
    ['group:결제 리뉴얼', 'group:결제 리뉴얼', 'group:결제 리뉴얼', 'group:결제 리뉴얼', 'group:결제 리뉴얼', null, null]);
  assert.match(fs.readFileSync(ideasPath, 'utf8'), /id:wpw-i [^\]]*project:결제_리뉴얼/, '아이디어는 project 칸(아이디어의 프로젝트 규칙)');
  assert.doesNotMatch(fs.readFileSync(decisionsPath, 'utf8'), /jira:IO-9/);

  // ④ 되돌리기: 그 사이 사람이 다른 프로젝트로 바꾼 것은 건너뛴다.
  await post('/api/track/set-group', { id: 'wpw-c', group: '운영툴' });
  const undo = await post('/api/meeting/move-items-undo', { meetingId: 'wpw-past', project: 'group:결제 리뉴얼', moved: moved.moved });
  assert.deepEqual({ restored: undo.restored, skipped: undo.skipped }, { restored: 3, skipped: 1 });
  keyOf = await keyAll();
  assert.deepEqual(['legacy', 'wpw-c', 'wpw-d', 'wpw-same', 'wpw-i'].map(keyOf), [null, 'group:운영툴', 'jira:IO-9', 'group:결제 리뉴얼', null]);

  // ⑤ 빼기(해제 뒤): project null이면 from에 있는 항목들의 프로젝트를 비운다. 되돌리면 돌아온다.
  const removed = await post('/api/meeting/move-items', { meetingId: 'wpw-past', project: null, from: 'group:결제 리뉴얼', ids: ['wpw-same'] });
  assert.deepEqual(removed.moved, [{ id: 'wpw-same', from: 'group:결제 리뉴얼' }]);
  keyOf = await keyAll();
  assert.equal(keyOf('wpw-same'), null);
  assert.deepEqual((await post('/api/meeting/move-items-undo', { meetingId: 'wpw-past', project: null, moved: removed.moved })).restored, 1);
  keyOf = await keyAll();
  assert.equal(keyOf('wpw-same'), 'group:결제 리뉴얼');
  // 옮긴 뒤 끝낸 항목은 되돌리기에서 건드리지 않는다(지난 기록의 프로젝트가 바뀌지 않게).
  const again = await post('/api/meeting/move-items', { meetingId: 'wpw-past', project: 'group:운영툴', from: 'group:결제 리뉴얼', ids: ['wpw-same'] });
  assert.equal(again.count, 1);
  await post('/api/track/toggle', { id: 'wpw-same', status: 'done' });
  const undoDone = await post('/api/meeting/move-items-undo', { meetingId: 'wpw-past', project: 'group:운영툴', moved: again.moved });
  assert.deepEqual({ restored: undoDone.restored, skipped: undoDone.skipped }, { restored: 0, skipped: 1 });
  keyOf = await keyAll();
  assert.equal(keyOf('wpw-same'), 'group:운영툴');

  // ⑥ 같은 제목의 앞으로 회의(오늘 캘린더)에 새로 담는 항목은 연결된 프로젝트로 간다.
  fs.writeFileSync(calendarPath, `마지막 갱신: ${today}\n- 15:00-16:00 | ${title}\n`);
  const next = (await items()).workflows.meetings.find(event => event.title === title && event.date === today);
  assert.equal(next.project.value, '결제 리뉴얼');
  const captured = await post('/api/workflow/capture', { meetingId: next.id, type: 'task', description: 'WP-W 다음 회차 할 일' });
  assert.equal(captured.ok, true);
  assert.equal((await items()).workflows.items.find(entry => entry.id === captured.id).group, '결제 리뉴얼');

  // ⑦ 연결 해제 자체는 항목을 옮기지 않는다(빼기는 화면의 확인 줄이 따로 묻는다). 지난 회의의 프로젝트만 풀린다.
  const beforeUnlink = readTasks();
  assert.equal((await post('/api/meeting/set-project', { title, project: null, meetingId: 'wpw-past' })).ok, true);
  assert.equal(readTasks(), beforeUnlink);
  assert.equal((await items()).workflows.meetings.find(event => event.id === 'wpw-past').project, null);
});

test('WP-W 답변 확인 되돌리기: answerSeen만 지우고, 없으면 조용히 넘어간다', async () => {
  const check = await post('/api/waiting/create', { description: 'WP-W 되돌릴 답' });
  await post('/api/workflow/item', { id: 'legacy', blockedBy: check.id });
  await post('/api/track/toggle', { id: check.id, status: 'done' });
  assert.equal((await post('/api/workflow/answer-seen', { id: 'legacy' })).ok, true);
  const undo = await post('/api/workflow/answer-seen-undo', { id: 'legacy' });
  assert.deepEqual({ ok: undo.ok, changed: undo.changed }, { ok: true, changed: true });
  const item = (await items()).workflows.items.find(entry => entry.id === 'legacy');
  assert.equal(item.answerSeen, undefined);
  assert.equal(item.blockedBy, check.id, '기다리던 답변 연결은 그대로');
  assert.equal((await post('/api/workflow/answer-seen-undo', { id: 'legacy' })).changed, false);
  assert.equal((await post('/api/workflow/answer-seen-undo', { id: 'missing' })).status, 400);
});

test('WP-W 회의 번호 없이 연결하면(오늘 미팅 줄) 예전처럼 오늘 그 제목의 회의만 바뀐다', async (t) => {
  const linksPath = path.join(directory, '.meeting_links.json');
  const linksBefore = fs.existsSync(linksPath) ? fs.readFileSync(linksPath, 'utf8') : null;
  t.after(() => { if (linksBefore === null) fs.rmSync(linksPath, { force: true }); else fs.writeFileSync(linksPath, linksBefore); });
  const title = 'WP-W 지난 회차';
  fs.writeFileSync(path.join(directory, '.workflow.json'), JSON.stringify({
    items: {}, meetings: { old: { id: 'old', date: shifted(-7), start: '10:00', end: '11:00', title, series: title, project: null } },
  }));
  assert.equal((await post('/api/meeting/set-project', { title, project: 'group:운영툴' })).ok, true);
  assert.equal((await items()).workflows.meetings.find(event => event.id === 'old').project, null, '지난 회차는 그때의 기록 그대로');
  await post('/api/meeting/set-project', { title, project: null });
});

// ---------- BBUNDLE: 프로젝트 묶어 보기 ----------
// 화면에서만 묶는다 — `.workflow.json`의 `projectBundles` 표시 정보만 바뀌고 업무 파일(jira 칸)은 그대로다.
test('BBUNDLE: 묶기·더하기·대표 바꾸기·풀기·되돌리기는 projectBundles만 바꾸고 업무 파일은 그대로', async () => {
  const tasksBefore = readTasks();
  assert.deepEqual((await items()).workflows.projectBundles, [], '칸이 없으면 묶음 없음');
  const made = await post('/api/project/bundle', { project: 'jira:IO-1', add: ['jira:IO-2'] });
  assert.equal(made.ok, true);
  assert.equal(made.before, null);
  assert.deepEqual({ lead: made.after.lead, keys: made.after.keys }, { lead: 'jira:IO-1', keys: ['jira:IO-1', 'jira:IO-2'] });
  const id = made.after.id;
  assert.match(id, /^bd_/);
  // 한 키는 한 묶음에만 — 이미 묶음에 든 키를 또 묶으면 400.
  const taken = await post('/api/project/bundle', { project: 'jira:IO-3', add: ['jira:IO-2'] });
  assert.equal(taken.status, 400);
  assert.match(taken.error, /이미 다른 묶음/);
  assert.equal((await post('/api/project/bundle', { project: 'group:운영툴', add: ['jira:IO-9'] })).status, 400, '지금은 지라끼리만');
  assert.equal((await post('/api/project/bundle', { project: 'jira:IO-5', add: ['jira:IO-5'] })).status, 400, '자기 자신과는 못 묶는다');
  // 묶음 안의 키에서 더하면 그 묶음에 더해진다(id 그대로).
  const grown = await post('/api/project/bundle', { project: 'jira:IO-2', add: ['jira:IO-3'] });
  assert.deepEqual(grown.after.keys, ['jira:IO-1', 'jira:IO-2', 'jira:IO-3']);
  assert.equal(grown.after.id, id);
  // 대표 바꾸기 → 되돌리기(⌘Z) → 같은 되돌리기를 또 보내면 "그 사이 바뀜"으로 거절.
  const lead = await post('/api/project/bundle-lead', { id, lead: 'jira:IO-3' });
  assert.equal(lead.after.lead, 'jira:IO-3');
  assert.equal((await post('/api/project/bundle-lead', { id, lead: 'jira:IO-8' })).status, 400, '묶음 밖 키는 대표가 될 수 없다');
  assert.equal((await post('/api/project/bundle-restore', { id, before: lead.before, after: lead.after })).ok, true);
  assert.equal((await items()).workflows.projectBundles[0].lead, 'jira:IO-1');
  assert.equal((await post('/api/project/bundle-restore', { id, before: lead.before, after: lead.after })).status, 400, '지금이 after가 아니면 덮지 않는다');
  // 풀기 → 되돌리기로 다시 묶임 → 다시 실행(redo)으로 다시 풀림.
  const gone = await post('/api/project/unbundle', { id });
  assert.deepEqual((await items()).workflows.projectBundles, []);
  assert.equal((await post('/api/project/bundle-restore', { id, before: gone.before, after: null })).ok, true);
  assert.deepEqual((await items()).workflows.projectBundles.map(bundle => bundle.keys.length), [3]);
  assert.equal((await post('/api/project/bundle-restore', { id, before: null, after: gone.before })).ok, true);
  assert.deepEqual((await items()).workflows.projectBundles, []);
  // 되돌리는 사이 그 키가 다른 묶음에 들어갔으면 되돌리지 않는다(한 키 한 묶음).
  await post('/api/project/bundle', { project: 'jira:IO-2', add: ['jira:IO-7'] });
  assert.equal((await post('/api/project/bundle-restore', { id, before: gone.before, after: null })).status, 400);
  assert.equal(readTasks(), tasksBefore, '업무 파일(jira 칸)은 하나도 바뀌지 않는다');
});

test('BBUNDLE: 옛 파일·깨진 값은 안전하게 거르고, 관련 없는 저장(옛 앱과 같은 "읽고 고쳐 통째로 쓰기")이 그 칸을 지우지 않는다', async () => {
  const file = path.join(directory, '.workflow.json');
  fs.writeFileSync(file, JSON.stringify({ items: {}, meetings: {}, projectBundles: [
    { id: 'one', lead: 'jira:IO-1', keys: ['jira:IO-1'] },                                   // 키 1개 → 버림
    { lead: 'jira:NO-1', keys: ['jira:IO-5', 'jira:IO-5', 'jira:IO-6'] },                  // lead 없음·중복 키 → 정리
    { id: 'late', lead: 'jira:IO-7', keys: ['jira:IO-6', 'jira:IO-7', 'group:운영툴', 7] }, // IO-6은 앞 묶음 것 → 1개 → 버림
    'garbage', null,
  ] }));
  const bundles = (await items()).workflows.projectBundles;
  assert.equal(bundles.length, 1);
  assert.deepEqual({ lead: bundles[0].lead, keys: bundles[0].keys }, { lead: 'jira:IO-5', keys: ['jira:IO-5', 'jira:IO-6'] });
  assert.match(bundles[0].id, /^bd_/, 'id가 없으면 키로 지은 id');
  await post('/api/workflow/item', { id: 'legacy', note: '관련 없는 저장' });
  assert.equal(readJson(file).projectBundles.length, 5, '읽기만으로는 파일을 고쳐 쓰지 않고, 다른 저장도 칸을 그대로 둔다');
  // 묶기 저장 때는 정리된 모양으로 쓴다.
  await post('/api/project/bundle', { project: 'jira:IO-5', add: ['jira:IO-8'] });
  assert.deepEqual(readJson(file).projectBundles.map(bundle => bundle.keys), [['jira:IO-5', 'jira:IO-6', 'jira:IO-8']]);
  fs.writeFileSync(file, JSON.stringify({ items: {}, meetings: {}, projectBundles: 'x' }));
  assert.deepEqual((await items()).workflows.projectBundles, [], '배열이 아니면 묶음 없음');
});

// ---------- BBUNDLE 덩어리 2 ----------
test('BBUNDLE 2: 같은 묶음에 이미 든 키는 맞는 문구로 거절하고, 새 묶음은 100개까지(지라 추가 조회 한도)', async () => {
  const file = path.join(directory, '.workflow.json');
  fs.writeFileSync(file, JSON.stringify({ items: {}, meetings: {}, projectBundles: [] }));
  await post('/api/project/bundle', { project: 'jira:IO-1', add: ['jira:IO-2'] });
  const again = await post('/api/project/bundle', { project: 'jira:IO-1', add: ['jira:IO-2'] });
  assert.equal(again.status, 400);
  assert.match(again.error, /이미 이 묶음에 들어 있어요 — IO-2/, '같은 묶음이면 "다른 묶음"이라고 하지 않는다');
  assert.doesNotMatch(again.error, /다른 묶음/);
  // 100개가 차면 새 묶음은 거절하고, 있는 묶음에 더하는 것은 된다.
  const many = Array.from({ length: 100 }, (unused, at) => ({ id: `bd_c${at}`, lead: `jira:CAP-${at * 2 + 1}`, keys: [`jira:CAP-${at * 2 + 1}`, `jira:CAP-${at * 2 + 2}`] }));
  fs.writeFileSync(file, JSON.stringify({ items: {}, meetings: {}, projectBundles: many }));
  const full = await post('/api/project/bundle', { project: 'jira:IO-8', add: ['jira:IO-9'] });
  assert.equal(full.status, 400);
  assert.match(full.error, /100개까지/);
  assert.equal((await post('/api/project/bundle', { project: 'jira:CAP-1', add: ['jira:IO-9'] })).ok, true, '있는 묶음에 더하기는 그대로');
  fs.writeFileSync(file, JSON.stringify({ items: {}, meetings: {} }));
});

test('BBUNDLE 2: 회의에서 담을 때 회의가 묶음의 다른 티켓에 걸려 있어도 기본 프로젝트는 대표 티켓이다', async (t) => {
  const file = path.join(directory, '.workflow.json');
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  t.after(() => { if (before === null) fs.rmSync(file, { force: true }); else fs.writeFileSync(file, before); });
  const meeting = { id: 'bb2m', date: today, start: '10:00', end: '11:00', title: 'BB2 결제 싱크', series: 'BB2 결제 싱크', link: null, project: { type: 'jira', value: 'IO-2', label: 'IO-2' } };
  fs.writeFileSync(file, JSON.stringify({ items: {}, meetings: { bb2m: meeting },
    projectBundles: [{ id: 'bd_bb2', lead: 'jira:IO-1', keys: ['jira:IO-1', 'jira:IO-2'] }] }));
  const lead = await post('/api/workflow/capture', { meetingId: 'bb2m', type: 'task', description: 'BB2 대표로 담기' });
  assert.equal(lead.ok, true);
  const data = (await items()).workflows.items;
  assert.equal(data.find(item => item.id === lead.id).jira, 'IO-1', '고르지 않았으면 대표 티켓');
  await post('/api/track/remove', { id: lead.id });
});

// 회의 정리 판 다듬기 — 뺀 초안 되살리기(review-restore). "뺀 직후 모양"일 때만 되살리고, 거절하면 아무것도 쓰지 않는다.
test('회의 초안: 뺀 초안은 review-restore로 되살아나고, 여러 개는 하나씩 · 담은 것은 그대로다', async () => {
  const draftsPath = path.join(directory, 'meeting_drafts.json');
  const wf = path.join(directory, '.workflow.json');
  fs.writeFileSync(path.join(directory, 'calendar_today.md'), `마지막 갱신: ${today}\n- 15:00-15:30 | 빼기 되돌리기 싱크\n`);
  fs.writeFileSync(draftsPath, JSON.stringify({ notes: [{
    noteGuid: 'rs1', webUrl: 'https://tiro.ooo/n/rs1', date: today, start: '15:00', end: '15:30', title: '빼기 되돌리기 싱크',
    items: [
      { type: 'task', description: '되돌리기 첫 초안' },
      { type: 'check', description: '되돌리기 둘째 초안' },
      { type: 'decision', description: '되돌리기 셋째 초안' },
    ],
  }] }));
  try {
    const meeting = (await items()).workflows.meetings.find(event => event.title === '빼기 되돌리기 싱크');
    const [first, second, third] = meeting.drafts;
    const draftsNow = async () => (await items()).workflows.meetings.find(event => event.id === meeting.id).drafts.map(draft => draft.id);

    // 연달아 둘을 빼고, 되돌리기는 역순으로 하나씩
    assert.equal((await post('/api/workflow/review', { meetingId: meeting.id, dismiss: [first.id] })).ok, true);
    assert.equal((await post('/api/workflow/review', { meetingId: meeting.id, dismiss: [second.id] })).ok, true);
    assert.deepEqual(await draftsNow(), [third.id]);
    const back2 = await post('/api/workflow/review-restore', { meetingId: meeting.id, drafts: [second.id] });
    assert.equal(back2.ok, true);
    assert.equal(back2.restored, 1);
    assert.deepEqual((await draftsNow()).sort(), [second.id, third.id].sort());
    assert.equal((await post('/api/workflow/review-restore', { meetingId: meeting.id, drafts: [first.id] })).ok, true);
    assert.deepEqual((await draftsNow()).sort(), [first.id, second.id, third.id].sort());

    // 하나를 빼고 나머지를 담은 뒤 되돌리면 뺀 것만 돌아오고 담은 것은 그대로
    assert.equal((await post('/api/workflow/review', { meetingId: meeting.id, dismiss: [first.id] })).ok, true);
    const accepted = await post('/api/workflow/review', { meetingId: meeting.id, accept: [second, third] });
    assert.equal(accepted.created.length, 2);
    assert.equal((await post('/api/workflow/review-restore', { meetingId: meeting.id, drafts: [first.id] })).ok, true);
    assert.deepEqual(await draftsNow(), [first.id]);
    const linked = (await items()).workflows.items.filter(item => item.meetingId === meeting.id).map(item => item.id).sort();
    assert.deepEqual(linked, [...accepted.created].sort(), '담은 항목은 회의에 그대로 걸려 있다');
    assert.match(fs.readFileSync(path.join(directory, 'checks.md'), 'utf8'), /되돌리기 둘째 초안/);

    // 거절: 살아 있는 초안 · 이미 담은 초안 · 없는 초안 · 다른 회의 · 빈 목록 · 같은 초안 두 번 — 파일은 한 글자도 안 바뀐다
    const before = fs.readFileSync(wf, 'utf8');
    for (const body of [
      { meetingId: meeting.id, drafts: [first.id] },
      { meetingId: meeting.id, drafts: [second.id] },
      { meetingId: meeting.id, drafts: ['rs1:stable:nope'] },
      { meetingId: 'other-meeting', drafts: [first.id] },
      { meetingId: meeting.id, drafts: [] },
      { meetingId: meeting.id },
      { meetingId: meeting.id, drafts: [second.id, second.id] },
      { meetingId: meeting.id, drafts: ['__proto__'] },
    ]) {
      const refused = await post('/api/workflow/review-restore', body);
      assert.equal(refused.status, 400, JSON.stringify(body));
      assert.equal(refused.ok, false);
    }
    assert.equal(fs.readFileSync(wf, 'utf8'), before);
    // 여럿 중 하나라도 안 되면 전부 거절(반쯤 되살리지 않는다)
    assert.equal((await post('/api/workflow/review', { meetingId: meeting.id, dismiss: [first.id] })).ok, true);
    const mixed = fs.readFileSync(wf, 'utf8');
    assert.equal((await post('/api/workflow/review-restore', { meetingId: meeting.id, drafts: [first.id, second.id] })).status, 400);
    assert.equal(fs.readFileSync(wf, 'utf8'), mixed);
  } finally {
    fs.rmSync(draftsPath, { force: true });
  }
});

test('회의 초안: 뺀 기록이 옛 모양이면 되살리기를 거절하고, 목록은 그대로 읽힌다', async () => {
  const draftsPath = path.join(directory, 'meeting_drafts.json');
  const wf = path.join(directory, '.workflow.json');
  fs.writeFileSync(path.join(directory, 'calendar_today.md'), `마지막 갱신: ${today}\n- 16:00-16:30 | 옛 기록 싱크\n`);
  fs.writeFileSync(draftsPath, JSON.stringify({ notes: [{
    noteGuid: 'rs2', date: today, start: '16:00', end: '16:30', title: '옛 기록 싱크',
    items: [{ type: 'task', description: '옛 기록 첫 초안' }, { type: 'task', description: '옛 기록 둘째 초안' }],
  }] }));
  try {
    const meeting = (await items()).workflows.meetings.find(event => event.title === '옛 기록 싱크');
    const [first, second] = meeting.drafts;
    // 옛 설치가 남긴 모양: 값이 'dismissed'가 아닌 표시(true) · 예전 번호 꼴(noteGuid:순번)
    const state = JSON.parse(fs.readFileSync(wf, 'utf8'));
    state.reviewed = { [first.id]: true, 'rs2:1': 'dismissed' };
    fs.writeFileSync(wf, JSON.stringify(state));
    const before = fs.readFileSync(wf, 'utf8');
    assert.equal((await post('/api/workflow/review-restore', { meetingId: meeting.id, drafts: [first.id] })).status, 400);
    assert.equal((await post('/api/workflow/review-restore', { meetingId: meeting.id, drafts: ['rs2:1'] })).status, 400);
    assert.equal(fs.readFileSync(wf, 'utf8'), before);
    const data = (await items()).workflows.meetings.find(event => event.id === meeting.id);
    assert.ok(Array.isArray(data.drafts), '목록은 깨지지 않는다');
    assert.ok(!data.drafts.some(draft => draft.id === first.id), '옛 표시가 붙은 초안은 그대로 빠져 있다');
    assert.ok(data.drafts.some(draft => draft.id === second.id));
    // reviewed 칸이 아예 없는 옛 파일도 거절만 한다
    fs.writeFileSync(wf, JSON.stringify({ items: {}, meetings: {} }));
    assert.equal((await post('/api/workflow/review-restore', { meetingId: meeting.id, drafts: [first.id] })).status, 400);
  } finally {
    fs.rmSync(draftsPath, { force: true });
  }
});

// ---------- 주간요약 다듬기 B: `+ 한 줄 추가`는 업무 파일과 보고 저장본을 한 트랜잭션으로 쓴다(personal-99 ②) ----------
const weeklyLine = async (body, key) => {
  const response = await fetch(base + '/api/report/change', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: JSON.stringify(body),
  });
  return { status: response.status, ...await response.json() };
};
const weeklyNow = async () => (await items()).weeklyReports[0];
function weeklySeed(t) {
  fs.appendFileSync(tasksPath, `- 가입 문구 검토하기 #task[id:wb_seed status:done priority:medium created:${today} completed:${today} group:가입_개편]\n`);
  const drafts = path.join(directory, '.report-drafts.json');
  t.after(() => { fs.rmSync(drafts, { force: true }); });
  return drafts;
}
test('다듬기 B: `+ 한 줄 추가`는 출처 `weekly`의 끝낸 업무와 사람이 쓴 문장 그대로의 보고 줄을 함께 만들고, 같은 요청을 다시 보내도 하나다', async t => {
  weeklySeed(t);
  const week = await weeklyNow();
  const body = { weekKey: week.weekKey, revision: week.draft.revision, action: 'addLine', heading: '완료한 일', groupKey: 'group:가입 개편', text: '가입 완료 화면 카피 최종본 전달함' };
  const first = await weeklyLine(body, 'weekly-addline-000001');
  assert.equal(first.status, 200);
  assert.equal(first.tasksChanged, true);
  const lines = readTasks().split('\n').filter(line => line.startsWith('- 가입 완료 화면 카피 최종본 전달함 #task['));
  assert.equal(lines.length, 1);
  assert.match(lines[0], new RegExp(`status:done .*group:가입_개편.*source:weekly.*completed:${today}`));
  const again = await weeklyLine(body, 'weekly-addline-000001');
  assert.equal(again.status, 200, '같은 요청 id면 앞 결과를 돌려준다');
  assert.equal(readTasks().split('\n').filter(line => line.startsWith('- 가입 완료 화면 카피 최종본 전달함 #task[')).length, 1, '업무가 두 번 생기지 않는다');
  const rows = (await weeklyNow()).draft.rows.filter(row => row.text === '가입 완료 화면 카피 최종본 전달함');
  assert.equal(rows.length, 1, '보고 줄도 하나');
  assert.deepEqual([rows[0].heading, rows[0].groupKey, rows[0].origin], ['완료한 일', 'group:가입 개편', 'weekly']);
  // 되돌리면 업무 줄도 함께 사라진다(업무는 늘 지운 항목에 남는다).
  const now = await weeklyNow();
  const undone = await weeklyLine({ weekKey: now.weekKey, revision: now.draft.revision, action: 'undo', token: first.undoToken });
  assert.equal(undone.status, 200);
  assert.equal(readTasks().includes('가입 완료 화면 카피 최종본 전달함'), false);
  assert.equal((await weeklyNow()).draft.rows.some(row => row.text === '가입 완료 화면 카피 최종본 전달함'), false);
  const trash = path.join(directory, '.trash.json');
  assert.equal(fs.existsSync(trash) && fs.readFileSync(trash, 'utf8').includes('가입 완료 화면 카피 최종본 전달함'), true);
});
test('다듬기 B: `+ 한 줄 추가`에서 보고 저장이 실패하면 만든 업무도 되돌아가고(반쯤 된 상태 없음), 같은 요청 id로 다시 보내면 한 번만 된다', async t => {
  const drafts = weeklySeed(t);
  fs.writeFileSync(drafts, JSON.stringify({ schema: 1, weeks: {} }));
  // 업무를 만든 **뒤** 보고 저장본을 쓰는 순간만 한 번 실패시킨다(디스크 오류 흉내 — 서버가 같은 프로세스라 fs를 잠시 바꿔 끼운다).
  const realRename = fs.renameSync;
  let failOnce = true;
  fs.renameSync = (from, to) => {
    if (failOnce && String(to).endsWith('.report-drafts.json')) { failOnce = false; throw new Error('디스크에 쓰지 못했어요'); }
    return realRename(from, to);
  };
  t.after(() => { fs.renameSync = realRename; });
  const before = readTasks();
  const week = await weeklyNow();
  const body = { weekKey: week.weekKey, revision: week.draft.revision, action: 'addLine', heading: '완료한 일', groupKey: 'group:가입 개편', text: '약관 개편 끝냄' };
  const failed = await weeklyLine(body, 'weekly-addline-000002');
  fs.renameSync = realRename;
  assert.equal(failed.status, 400);
  assert.equal(failOnce, false, '보고 쓰기까지 갔다(업무는 이미 만든 뒤)');
  assert.equal(readTasks(), before, '업무 파일이 그대로다');
  assert.equal(JSON.parse(fs.readFileSync(drafts, 'utf8')).weeks[week.weekKey], undefined, '보고 저장본도 그대로다');
  assert.equal((await fetch(base + '/api/storage-status').then(r => r.json())).recoveryNeeded, false, '복구 필요 상태가 되지 않는다');
  const retried = await weeklyLine(body, 'weekly-addline-000002');
  assert.equal(retried.status, 200, '실패한 요청은 기록되지 않아 같은 id로 다시 보낼 수 있다');
  assert.equal(readTasks().split('\n').filter(line => line.startsWith('- 약관 개편 끝냄 #task[')).length, 1);
  assert.equal((await weeklyNow()).draft.rows.filter(row => row.text === '약관 개편 끝냄').length, 1);
  assert.equal((await weeklyLine(body, 'weekly-addline-000002')).status, 200);
  assert.equal(readTasks().split('\n').filter(line => line.startsWith('- 약관 개편 끝냄 #task[')).length, 1, '성공 뒤 같은 id를 또 보내도 하나');
});
test('양식 ②: 정리 막대 `프로젝트 옮기기`는 업무 파일의 프로젝트와 보고 줄을 한 트랜잭션으로 바꾸고, 되돌리기가 업무까지 되돌린다', async t => {
  weeklySeed(t);
  fs.appendFileSync(tasksPath, `- 정산 표 점검하기 #task[id:wb_other status:done priority:medium created:${today} completed:${today} group:운영툴]\n`);
  const row = async () => (await weeklyNow()).draft.rows.find(entry => entry.sourceIds && entry.sourceIds.includes('wb_seed'));
  const week = await weeklyNow();
  const moved = await weeklyLine({ weekKey: week.weekKey, revision: week.draft.revision, action: 'move', ids: [(await row()).id], to: { name: '운영툴' } });
  assert.equal(moved.status, 200);
  assert.equal(moved.tasksChanged, true);
  const line = () => readTasks().split('\n').find(entry => entry.includes('id:wb_seed'));
  assert.match(line(), /group:운영툴/, '같은 이름의 프로젝트로 옮긴다(새로 만들지 않음)');
  assert.doesNotMatch(line(), /group:가입_개편/);
  assert.equal((await row()).groupKey, 'group:운영툴');
  // 보고 저장이 실패하면 업무 파일도 그대로다(반쯤 된 상태 없음).
  const realRename = fs.renameSync;
  let failOnce = true;
  fs.renameSync = (from, to) => { if (failOnce && String(to).endsWith('.report-drafts.json')) { failOnce = false; throw new Error('디스크에 쓰지 못했어요'); } return realRename(from, to); };
  t.after(() => { fs.renameSync = realRename; });
  const before = readTasks();
  const now = await weeklyNow();
  const failed = await weeklyLine({ weekKey: now.weekKey, revision: now.draft.revision, action: 'move', ids: [(await row()).id], to: 'etc' });
  fs.renameSync = realRename;
  assert.equal(failed.status, 400);
  assert.equal(readTasks(), before, '업무 파일이 그대로다');
  const latest = await weeklyNow();
  const undone = await weeklyLine({ weekKey: latest.weekKey, revision: latest.draft.revision, action: 'undo', token: moved.undoToken });
  assert.equal(undone.status, 200);
  assert.match(line(), /group:가입_개편/, '되돌리면 업무도 원래 프로젝트');
  assert.equal((await row()).groupKey, 'group:가입 개편');
});
test('다듬기 B: 진행 중 칸의 `+ 한 줄 추가`는 오늘 진행 중 업무를 만든다', async t => {
  weeklySeed(t);
  fs.appendFileSync(tasksPath, `- 정산 배치 고치기 #task[id:wb_doing status:to-do priority:medium created:${today} scheduled:${today} doing:${today} group:가입_개편]\n`);
  const week = await weeklyNow();
  const result = await weeklyLine({ weekKey: week.weekKey, revision: week.draft.revision, action: 'addLine', heading: '진행중', groupKey: 'group:가입 개편', text: '환불 규칙 정리 중' }, 'weekly-addline-000003');
  assert.equal(result.status, 200);
  const line = readTasks().split('\n').find(entry => entry.startsWith('- 환불 규칙 정리 중 #task['));
  assert.match(line, new RegExp(`status:to-do .*scheduled:${today}.*group:가입_개편.*source:weekly.*doing:${today}`));
  assert.equal((await weeklyNow()).draft.rows.find(row => row.text === '환불 규칙 정리 중').heading, '진행중');
});
test('다듬기 B(99 리뷰): `+ 한 줄 추가`로 만든 업무에 마감을 더한 뒤 되돌리면 업무는 .trash.json에 남는다', async t => {
  weeklySeed(t);
  const week = await weeklyNow();
  const added = await weeklyLine({ weekKey: week.weekKey, revision: week.draft.revision, action: 'addLine', heading: '완료한 일', groupKey: 'group:가입 개편', text: '마감 더할 업무' }, 'weekly-addline-000004');
  assert.equal(added.status, 200);
  const id = readTasks().split('\n').find(line => line.startsWith('- 마감 더할 업무 #task[')).match(/id:(\S+)/)[1];
  assert.equal((await post('/api/track/set-due', { id, due: '2026-12-31' })).status, 200);
  assert.match(readTasks(), /- 마감 더할 업무 #task\[[^\]]*due:2026-12-31/);
  const now = await weeklyNow();
  assert.equal((await weeklyLine({ weekKey: now.weekKey, revision: now.draft.revision, action: 'undo', token: added.undoToken })).status, 200);
  assert.equal(readTasks().includes('마감 더할 업무'), false, '업무 목록에서는 사라진다');
  const trash = JSON.parse(fs.readFileSync(path.join(directory, '.trash.json'), 'utf8'));
  const kept = trash.find(entry => entry.id === id);
  assert.ok(kept, '지운 항목에 남는다');
  assert.match(kept.line, /due:2026-12-31/, '더한 마감까지 그대로');
});
test('다듬기 B(99 리뷰): 저장된 요청과 같은 id를 보고가 바뀐 뒤(다른 revision) 다시 보내면 거절되고 줄·업무는 하나다', async t => {
  weeklySeed(t);
  const week = await weeklyNow();
  const body = { weekKey: week.weekKey, revision: week.draft.revision, action: 'addLine', heading: '완료한 일', groupKey: 'group:가입 개편', text: '응답 잃은 줄' };
  assert.equal((await weeklyLine(body, 'weekly-addline-000005')).status, 200);
  const later = await weeklyNow();
  const again = await weeklyLine({ ...body, revision: later.draft.revision }, 'weekly-addline-000005');
  assert.equal(again.status, 400);
  assert.match(again.error, /다른 내용으로 같은 요청/);
  assert.equal(readTasks().split('\n').filter(line => line.startsWith('- 응답 잃은 줄 #task[')).length, 1);
  assert.equal((await weeklyNow()).draft.rows.filter(row => row.text === '응답 잃은 줄').length, 1);
});
test('개편 A: 목록 응답의 보고에 review{count,first}·material{pending}이 오고, `넣기`(pullOne)는 같은 길(/api/report/change)로 한 줄만 넣으며 저장 파일에 review가 없다', async t => {
  const drafts = weeklySeed(t);
  fs.appendFileSync(tasksPath, `- 환불 정책 표 업데이트 (확인 필요) #task[id:wa7_mark status:done priority:medium created:${today} completed:${today} group:가입_개편]\n`);
  let week = await weeklyNow();
  assert.deepEqual(Object.keys(week.draft.review).sort(), ['count', 'first']);
  assert.equal(week.draft.review.count, 1);
  assert.equal(week.draft.rows.find(row => row.id === week.draft.review.first).review.reason, 'marked');
  assert.deepEqual(week.draft.material, { pending: [] });
  assert.equal((await weeklyLine({ weekKey: week.weekKey, revision: week.draft.revision, action: 'confirm' })).status, 200);
  fs.appendFileSync(tasksPath, `- 가입 카피 최종 확인하기 #task[id:wa7_new status:done priority:medium created:${today} completed:${today} group:가입_개편]\n`);
  week = await weeklyNow();
  assert.deepEqual(week.draft.material.pending.map(entry => [entry.id, entry.label]), [['wa7_new', '가입 개편']]);
  const pulled = await weeklyLine({ weekKey: week.weekKey, revision: week.draft.revision, action: 'pullOne', ids: ['wa7_new'] }, 'weekly-pullone-0000001');
  assert.equal(pulled.status, 200);
  assert.equal(pulled.report.rows.filter(row => row.sourceIds.includes('wa7_new')).length, 1);
  assert.deepEqual(pulled.report.material, { pending: [] });
  assert.ok(pulled.report.confirmed, '확정 그대로');
  assert.equal(fs.readFileSync(drafts, 'utf8').includes('"review"'), false);
  const again = await weeklyLine({ weekKey: week.weekKey, revision: week.draft.revision, action: 'pullOne', ids: ['wa7_new'] }, 'weekly-pullone-0000001');
  assert.equal(again.status, 200, '같은 요청 id면 앞 결과');
  assert.equal((await weeklyNow()).draft.rows.filter(row => row.sourceIds.includes('wa7_new')).length, 1, '두 번 들어가지 않는다');
  const stale = await weeklyLine({ weekKey: week.weekKey, revision: week.draft.revision, action: 'pullOne', ids: ['wa7_new'] });
  assert.equal(stale.status, 409, '다른 창의 오래된 판이면 409');
});

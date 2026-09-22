const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');

process.env.TZ = 'Asia/Seoul';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-regression-'));
process.env.WORKSPACE_DATA_DIR = directory;
// 자동화 로그·요청 폴더도 임시 폴더로 끼운다 — 테스트가 실제 홈 폴더(`~/.local/share/workspace-automation`)를
// 읽지도 쓰지도 않게.
const automationHome = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-automation-'));
process.env.WORKSPACE_AUTOMATION_DIR = automationHome;
// 설정도 없는 파일로 끼운다 — 운영 폴더에서 돌릴 때 실제 `workspace.config.json`(지라 주소·토큰 위치)을 읽어
// 테스트가 실제 지라에 닿는 일이 없게. 설정이 필요한 테스트는 따로 띄운 서버에 자기 설정을 준다.
process.env.WORKSPACE_CONFIG = path.join(directory, 'absent.config.json');
const { server } = require('./server');
const date = value => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
const today = date(new Date());
const shifted = days => { const value = new Date(); value.setDate(value.getDate() + days); return date(value); };
let base;
const tasksPath = path.join(directory, 'tasks.md');
const readTasks = () => fs.readFileSync(tasksPath, 'utf8');
async function post(route, body) {
  const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, ...await response.json() };
}
const items = async () => (await fetch(base + '/api/items')).json();

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
  const blocked = ['server.js', 'safe-storage.js', 'jira-client.js', 'jira-live.js', 'report-drafts.js',
    'task-batch.js', 'slack-history.js', 'import-record.js', 'browser-fixture.js',
    'workflow-store.js', 'mutation-store.js', 'server.test.js', 'client.test.js', 'report-drafts.test.js'];
  for (const name of blocked) {
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

before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(directory, { recursive: true });
  fs.rmSync(automationHome, { recursive: true, force: true });
});
beforeEach(() => {
  fs.writeFileSync(path.join(directory, '.workflow.json'), JSON.stringify({ items: {}, meetings: {} }));
  fs.writeFileSync(tasksPath, `# Tasks\n- Legacy overdue #task[id:legacy status:to-do priority:high created:${shifted(-4)} due:${shifted(-2)} source:slack:https://example.test/message]\n- New unseen #task[id:unseen status:to-do priority:medium created:${today} scheduled:${today} source:slack:https://example.test/another]\n`);
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

// 시작 시 복구는 모듈로 불러올 때 실행되지 않는다. 실제 `node server.js`를 띄워서 확인한다.
const freePort = () => new Promise(resolve => {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;
const journalEntry = (file, before, after) => JSON.stringify({ changes: [{ file, before: Buffer.from(before).toString('base64'), after: createHash('sha256').update(after).digest('hex'), intermediate: [] }] });
async function startServer(t, seed) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-recovery-'));
  seed(home);
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, WORKSPACE_DATA_DIR: home, WORKSPACE_PORT: String(port), WORKSPACE_NO_OPEN: '1', WORKSPACE_HOST: '', WORKSPACE_CONFIG: path.join(home, 'absent.config.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(home, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`서버가 종료되었습니다 (${child.exitCode}): ${log}`);
    try { if ((await fetch(base + '/api/storage-status')).ok) return { home, base, log: () => log }; } catch { /* 아직 안 떴다 */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`서버가 응답하지 않았습니다: ${log}`);
}

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

// launchd가 부르는 자동화 스크립트. 앱과 따로 돌지만 여기가 멈추면 수집이 통째로 멎기 때문에,
// 실제 스크립트를 임시 폴더·가짜 claude로 돌려서 "멈춤 방지" 장치만 확인한다.
// (슬랙 API나 운영 서버는 건드리지 않는다 — 채널이 없는 설정이라 곧바로 실패하고 끝난다)
const automationScript = name => path.join(__dirname, 'automation', name);
const runScript = (script, args, env) => spawnSync('/bin/bash', [script, ...args], {
  env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60000,
});
const gone = pid => { try { process.kill(pid, 0); return false; } catch { return true; } };

test('run-task.sh는 매달린 실행을 시간 제한으로 끊고 자식 프로세스까지 정리한다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-run-task-'));
  const claude = path.join(home, 'fake-claude.sh');
  fs.writeFileSync(claude, '#!/bin/bash\nsleep 60 &\necho "child=$!"\necho "parent=$$"\nsleep 60\n');
  fs.chmodSync(claude, 0o755);
  const result = runScript(automationScript('run-task.sh'), ['hang', '프롬프트', 'Read'], {
    WORKSPACE_DIR: home, AUTOMATION_LOG_DIR: path.join(home, 'logs'), CLAUDE_BIN: claude,
    TASK_TIMEOUT_SECONDS: '2', TASK_KILL_GRACE_SECONDS: '1',
  });
  assert.equal(result.status, 124);
  const log = fs.readFileSync(path.join(home, 'logs', 'hang.log'), 'utf8');
  assert.match(log, /hang 시간 초과 \(2초\)/);
  // 상태 탭이 읽는 시작/종료 줄 형식은 그대로여야 한다
  assert.match(log, /^───── \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} hang 시작$/m);
  assert.match(log, /^───── \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} hang 종료 \(exit 124\)$/m);
  const pids = [...log.matchAll(/(?:child|parent)=(\d+)/g)].map(match => Number(match[1]));
  assert.equal(pids.length, 2);
  assert.deepEqual(pids.map(gone), [true, true]); // MCP 자식 흉내까지 남지 않는다
  fs.rmSync(home, { recursive: true, force: true });
});

test('run-task.sh는 정상 실행의 인자·종료 코드·로그 형식을 그대로 넘긴다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-run-task-'));
  const claude = path.join(home, 'fake-claude.sh');
  fs.writeFileSync(claude, `#!/bin/bash\nprintf '%s\\n' "$*" > "${path.join(home, 'args.txt')}"\necho "수집 결과 요약"\nexit \${FAKE_EXIT:-0}\n`);
  fs.chmodSync(claude, 0o755);
  const env = { WORKSPACE_DIR: home, AUTOMATION_LOG_DIR: path.join(home, 'logs'), CLAUDE_BIN: claude };
  assert.equal(runScript(automationScript('run-task.sh'), ['ok', '프롬프트', 'Read,Write'], env).status, 0);
  assert.equal(fs.readFileSync(path.join(home, 'args.txt'), 'utf8').trim(), '-p 프롬프트 --permission-mode acceptEdits --allowedTools Read,Write');
  assert.equal(runScript(automationScript('run-task.sh'), ['ok', '프롬프트', 'Read,Write'], { ...env, FAKE_EXIT: '7' }).status, 7);
  // 권한 모드·금지 도구는 선택 인자다(슬랙 캡처만 쓴다). 안 주면 위처럼 예전 그대로다.
  assert.equal(runScript(automationScript('run-task.sh'), ['ok', '프롬프트', 'Read', 'manual', 'Write,Edit'], env).status, 0);
  assert.equal(fs.readFileSync(path.join(home, 'args.txt'), 'utf8').trim(), '-p 프롬프트 --permission-mode manual --allowedTools Read --disallowedTools Write,Edit');
  const log = fs.readFileSync(path.join(home, 'logs', 'ok.log'), 'utf8');
  assert.doesNotMatch(log, /시간 초과/);
  assert.match(log, /^───── \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} ok 종료 \(exit 0\)$/m);
  assert.match(log, /^───── \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} ok 종료 \(exit 7\)$/m);
  assert.equal(log.split('수집 결과 요약').length - 1, 3);
  fs.rmSync(home, { recursive: true, force: true });
});

test('slack-capture.sh 잠금은 살아 있는 실행만 존중하고 죽은 잠금은 회수한다', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-slack-lock-'));
  const logs = path.join(home, 'logs');
  const lock = path.join(logs, '.slack-capture.lock');
  const config = path.join(home, 'workspace.config.json');
  fs.writeFileSync(config, '{}'); // 채널이 없으니 잠금만 잡고 곧바로 실패하고 끝난다
  const logText = () => fs.readFileSync(path.join(logs, 'slack-capture.log'), 'utf8');
  const capture = () => runScript(automationScript('slack-capture.sh'), [], {
    WORKSPACE_DIR: home, WORKSPACE_CONFIG: config, AUTOMATION_LOG_DIR: logs,
    SLACK_CAPTURE_IGNORE_HOURS: '1', WORKSPACE_PORT: '4322',
  });
  const holdLock = pid => { fs.mkdirSync(lock, { recursive: true }); fs.writeFileSync(path.join(lock, 'pid'), `${pid}\n`); };
  const longRunning = name => {
    const script = path.join(home, name);
    fs.writeFileSync(script, '#!/bin/bash\nsleep 60\n');
    fs.chmodSync(script, 0o755);
    const child = spawn('/bin/bash', [script], { stdio: 'ignore' });
    t.after(() => child.kill('SIGKILL'));
    return child.pid;
  };

  // 1) 진짜 캡처가 아직 돌고 있으면 건너뛰고, 남의 잠금은 풀지 않는다
  const holder = longRunning('slack-capture-holder.sh');
  holdLock(holder);
  assert.equal(capture().status, 0);
  assert.match(logText(), /이전 실행이 아직 진행 중/);
  assert.equal(fs.readFileSync(path.join(lock, 'pid'), 'utf8').trim(), String(holder));

  // 2) 잠금 폴더만 있고 pid를 아직 못 쓴 찰나도 "진행 중"으로 본다
  fs.rmSync(lock, { recursive: true, force: true });
  fs.mkdirSync(lock, { recursive: true });
  assert.equal(capture().status, 0);
  assert.equal(fs.existsSync(lock), true);

  // 3) 주인이 죽은 잠금은 회수한다(예전 30분 규칙 없이 즉시)
  fs.rmSync(lock, { recursive: true, force: true });
  holdLock(deadPid());
  fs.writeFileSync(path.join(logs, 'slack-capture.log'), '');
  assert.equal(capture().status, 1);
  assert.match(logText(), /채널 확인 실패/);
  assert.equal(fs.existsSync(lock), false); // 잡았다가 스스로 풀었다

  // 4) 번호만 같고 다른 프로그램이 쓰고 있는 PID도 회수한다
  holdLock(longRunning('other-program.sh'));
  fs.writeFileSync(path.join(logs, 'slack-capture.log'), '');
  assert.equal(capture().status, 1);
  assert.doesNotMatch(logText(), /이전 실행이 아직 진행 중/);
  assert.equal(fs.existsSync(lock), false);
  fs.rmSync(home, { recursive: true, force: true });
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

// 지라 동기화가 "업무에 연결돼 있는데 기본 조회에서 빠진 이슈"를 적는 구역. 줄 형식은 기본 구역과
// 같아서 구역을 모르는 옛 서버가 읽어도 그냥 이슈로 읽히고(오류 없음), 구역이 없는 옛 파일은
// 지금 서버가 읽어도 예전과 똑같다.
test('지라 캐시는 `그 밖의 이슈` 구역을 extra로 표시하고, 구역 없는 옛 파일도 그대로 읽는다', async () => {
  const jiraPath = path.join(directory, 'jira_issues.md');
  const before = fs.existsSync(jiraPath) ? fs.readFileSync(jiraPath, 'utf8') : null;
  const head = ['# 지라 이슈 (내 담당, 진행중/백로그)', '', '마지막 갱신: 2026-09-24', '', '- IO-1 | 에픽 | 진행 중 | 보드 AI', ''];
  try {
    fs.writeFileSync(jiraPath, head.join('\n'));
    assert.deepEqual((await items()).jiraIssues,
      [{ key: 'IO-1', type: '에픽', status: '진행 중', summary: '보드 AI', extra: false }],
      '구역이 없는 옛 파일은 예전과 같이 전부 보통 이슈다');

    const withSection = [...head, '## 업무에 연결된 그 밖의 이슈', '', '- IO-2 | 에픽 | 완료 | 게임 임베드', '',
      '## 다른 소제목', '', '- IO-3 | 스토리 | Backlog | 알림 로그 정리', ''];
    fs.writeFileSync(jiraPath, withSection.join('\n'));
    assert.deepEqual((await items()).jiraIssues.map(issue => [issue.key, issue.status, issue.extra]),
      [['IO-1', '진행 중', false], ['IO-2', '완료', true], ['IO-3', 'Backlog', false]],
      '그 구역 안의 줄만 extra이고, 다른 소제목이 나오면 다시 보통 이슈로 돌아온다');

    // 옛 서버(구역을 모르는 버전)의 파서 — 새 파일을 읽어도 오류 없이 이슈 셋을 얻는다.
    const legacy = withSection.map(line => line.match(/^- (\S+) \| (.+?) \| (.+?) \| (.+)$/)).filter(Boolean);
    assert.deepEqual(legacy.map(m => m[1]), ['IO-1', 'IO-2', 'IO-3']);
  } finally {
    if (before === null) fs.rmSync(jiraPath, { force: true });
    else fs.writeFileSync(jiraPath, before);
  }
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

// ---------- 지라 직접 읽기 (BJR 1단계 — 보기만) ----------
// 실제 지라는 절대 부르지 않는다: 아래 테스트는 전부 가짜 fetch와 가짜 토큰 읽기만 쓴다.
const jiraModule = require('./jira-client');
const JIRA_SITE = 'https://example-jira.test';
const JIRA_EMAIL = 'someone@example.test';
const JIRA_TOKEN = 'fixture-token-never-real';
const jiraConfig = { jira: { siteUrl: JIRA_SITE, email: JIRA_EMAIL, tokenFile: '/tmp/never-read-this' } };
const jiraSettings = () => jiraModule.jiraSettings(jiraConfig);
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const jiraIssueBody = (extra = {}) => ({
  fields: {
    summary: '게시글 작성하기_게임 임베드',
    status: { name: '진행 중', statusCategory: { key: 'indeterminate' } },
    issuetype: { name: '에픽' },
    assignee: { displayName: '루본' },
    duedate: '2026-10-02',
    fixVersions: [{ id: '10101', name: 'v2.70.0', releaseDate: '2026-09-30', released: false }],
    ...extra,
  },
});
// 하위 티켓 — 완료 2 / 전체 3. 3단계부터는 줄에 쓸 값(요약·담당·배포 버전)까지 함께 온다.
// 지라는 담당자 덩어리에 이메일·계정 id도 실어 주지만 앱은 **표시 이름만** 옮긴다(아래 테스트로 고정).
const jiraChildBody = { issues: [
  {
    key: 'IO-48395',
    fields: {
      summary: '임베드 카드 붙이기',
      status: { name: '완료', statusCategory: { key: 'done' } },
      issuetype: { name: '하위 작업' },
      assignee: { displayName: '루본', emailAddress: JIRA_EMAIL, accountId: '5b10a2844c20165700ede21g' },
      fixVersions: [{ id: '10101', name: 'v2.70.0', releaseDate: '2026-09-30', released: false }],
    },
  },
  {
    key: 'IO-48396',
    fields: {
      summary: '임베드 미리보기 붙이기',
      status: { name: '완료', statusCategory: { key: 'done' } },
      issuetype: { name: '하위 작업' },
      assignee: null,
      fixVersions: [],
    },
  },
  {
    key: 'IO-48397',
    fields: {
      summary: '게임 목록 불러오기',
      status: { name: '진행 중', statusCategory: { key: 'indeterminate' } },
      issuetype: { name: '하위 작업' },
      assignee: { displayName: '엘리', emailAddress: 'elly@example.test', accountId: '712020:aaaa' },
      fixVersions: [],
    },
  },
] };
// `children.items` 한 줄의 기대 모양 — 담당은 표시 이름, 배포 버전은 이름뿐이다.
const jiraChildItems = [
  { key: 'IO-48395', url: `${JIRA_SITE}/browse/IO-48395`, summary: '임베드 카드 붙이기', type: '하위 작업', status: { name: '완료', category: 'done' }, assignee: '루본', version: 'v2.70.0' },
  { key: 'IO-48396', url: `${JIRA_SITE}/browse/IO-48396`, summary: '임베드 미리보기 붙이기', type: '하위 작업', status: { name: '완료', category: 'done' }, assignee: null, version: null },
  { key: 'IO-48397', url: `${JIRA_SITE}/browse/IO-48397`, summary: '게임 목록 불러오기', type: '하위 작업', status: { name: '진행 중', category: 'doing' }, assignee: '엘리', version: null },
];
function jiraFake(routes) {
  const calls = [];
  const request = async (url, options) => {
    const method = (options && options.method) || 'GET';
    calls.push({ url, headers: options.headers, method, body: options && options.body ? JSON.parse(options.body) : null });
    const hit = Object.keys(routes).find(part => String(url).includes(part));
    if (!hit) return json({ errorMessages: ['no route'] }, 500);
    const answer = routes[hit];
    if (typeof answer === 'function') return answer(String(url), method);
    return answer();
  };
  return { request, calls };
}

test('지라 읽기는 요약·상태 범주·배포 버전·기한·담당과 하위 집계를 한 덩어리로 돌려준다', async () => {
  const fake = jiraFake({
    '/rest/api/3/issue/IO-48394': () => json(jiraIssueBody()),
    '/rest/api/3/search/jql': () => json(jiraChildBody),
  });
  const client = jiraModule.createJiraClient({ settings: jiraSettings(), request: fake.request, readToken: () => JIRA_TOKEN });
  const issue = await client.getIssueOverview('IO-48394');
  assert.deepEqual(issue, {
    key: 'IO-48394',
    url: `${JIRA_SITE}/browse/IO-48394`,
    summary: '게시글 작성하기_게임 임베드',
    type: '에픽',
    status: { name: '진행 중', category: 'doing' },
    assignee: '루본',
    due: '2026-10-02',
    versions: [{ id: '10101', name: 'v2.70.0', releaseDate: '2026-09-30', released: false }],
    children: { total: 3, done: 2, items: jiraChildItems },
  });
  // 링크는 앱이 조립한다(siteUrl + /browse/KEY) — 지라가 준 self 주소를 쓰지 않는다.
  assert.equal(issue.url, `${JIRA_SITE}/browse/IO-48394`);
  // 요청은 두 번뿐이다: 이슈 하나 + 하위 조회 하나(목록 전체를 미리 부르지 않는다).
  assert.equal(fake.calls.length, 2);
  assert.match(fake.calls[0].url, /fields=summary,status,issuetype,assignee,duedate,fixVersions,subtasks$/);
  // 하위 조회가 받아 오는 칸은 이 다섯뿐이다 — 이메일·계정 id를 달라고 하지 않는다.
  assert.match(fake.calls[1].url, /\/rest\/api\/3\/search\/jql\?jql=parent%3DIO-48394&fields=summary,status,assignee,fixVersions,issuetype&maxResults=100$/);
  // 인증은 Basic 한 벌이고, 그 값은 요청에만 실린다.
  assert.equal(fake.calls[0].headers.Authorization, `Basic ${Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64')}`);
});

test('하위가 search에 없으면 subtasks로 세고, 새 search 주소가 없으면 옛 주소로 한 번 물러선다', async () => {
  const subtasks = [
    { key: 'AB-2', fields: { summary: '먼저 한 것', status: { name: '완료', statusCategory: { key: 'done' } } } },
    { key: 'AB-3', fields: { summary: '아직 안 한 것', status: { name: '할 일', statusCategory: { key: 'new' } } } },
  ];
  const fallback = jiraFake({
    '/rest/api/3/issue/AB-1': () => json(jiraIssueBody({ subtasks })),
    '/rest/api/3/search/jql': () => json({ errorMessages: ['not found'] }, 404),
    '/rest/api/3/search?': () => json(jiraChildBody),
  });
  const fellBack = await jiraModule.createJiraClient({ settings: jiraSettings(), request: fallback.request, readToken: () => JIRA_TOKEN }).getIssueOverview('AB-1');
  assert.deepEqual(fellBack.children, { total: 3, done: 2, items: jiraChildItems });
  assert.equal(fallback.calls.length, 3);

  const empty = jiraFake({
    '/rest/api/3/issue/AB-1': () => json(jiraIssueBody({ subtasks })),
    '/rest/api/3/search': () => json({ issues: [] }),
  });
  const counted = await jiraModule.createJiraClient({ settings: jiraSettings(), request: empty.request, readToken: () => JIRA_TOKEN }).getIssueOverview('AB-1');
  assert.equal(counted.children.total, 2);
  assert.equal(counted.children.done, 1);
  // `subtasks`에는 담당자·배포 버전이 없다 — 그 줄은 `담당 없음`으로 선다(줄 자체는 그대로 보여 준다).
  assert.deepEqual(counted.children.items, [
    { key: 'AB-2', url: `${JIRA_SITE}/browse/AB-2`, summary: '먼저 한 것', type: '', status: { name: '완료', category: 'done' }, assignee: null, version: null },
    { key: 'AB-3', url: `${JIRA_SITE}/browse/AB-3`, summary: '아직 안 한 것', type: '', status: { name: '할 일', category: 'todo' }, assignee: null, version: null },
  ]);

  const none = jiraFake({ '/rest/api/3/issue/AB-1': () => json(jiraIssueBody()), '/rest/api/3/search': () => json({ issues: [] }) });
  assert.equal((await jiraModule.createJiraClient({ settings: jiraSettings(), request: none.request, readToken: () => JIRA_TOKEN }).getIssueOverview('AB-1')).children, null);
});

// ---------- 지라 하위 티켓 목록 (BJR 3단계 — 읽기 전용) ----------
test('하위 티켓 목록은 담당자를 표시 이름으로만 싣고 이메일·계정 id는 어디에도 남기지 않는다', async () => {
  const fake = jiraFake({
    '/rest/api/3/issue/IO-48394': () => json(jiraIssueBody()),
    '/rest/api/3/search/jql': () => json(jiraChildBody),
  });
  const api = jiraModule.createJiraApi({ config: jiraConfig, request: fake.request, readFile: () => JIRA_TOKEN });
  const answer = await api.read('IO-48394');
  assert.deepEqual(answer.issue.children.items, jiraChildItems);
  // 1단계의 `total`/`done`은 그대로다 — 진행률 줄과 기존 화면이 그대로 돈다.
  assert.equal(answer.issue.children.total, 3);
  assert.equal(answer.issue.children.done, 2);
  const payload = JSON.stringify(answer);
  assert.doesNotMatch(payload, new RegExp(JIRA_EMAIL), '지라가 준 담당자 이메일이 응답에 실리지 않는다');
  assert.doesNotMatch(payload, /elly@example\.test/);
  assert.doesNotMatch(payload, /accountId|emailAddress|5b10a2844c20165700ede21g|712020:aaaa/);
  assert.doesNotMatch(payload, new RegExp(JIRA_TOKEN));
  // 나가는 요청에도 그 칸을 달라고 하지 않는다.
  assert.doesNotMatch(fake.calls.map(call => call.url).join(' '), /emailAddress|accountId/);
});

test('하위 티켓 목록은 키 형식이 아닌 것을 버리고, 모르는 값은 빈 자리로 흘린다', () => {
  const shaped = jiraModule.shapeChildren(JIRA_SITE, [
    { key: 'AB-2', fields: { summary: '정상', status: { name: '진행 중', statusCategory: { key: 'indeterminate' } } } },
    // 키가 없거나 형식이 아니면 버린다 — 그 키로 주소를 조립하기 때문이다.
    { fields: { status: { statusCategory: { key: 'done' } } } },
    { key: 'javascript:alert(1)', fields: { summary: '수상한 것', status: { statusCategory: { key: 'new' } } } },
    // 모르는 모양이 와도 오류가 아니라 빈 값으로 흐른다(범주를 모르면 `진행`으로 본다).
    { key: 'AB-9', fields: {} },
  ]);
  // total·done은 지라가 준 목록 전체를 그대로 센다(줄을 버린 것과 별개다).
  assert.equal(shaped.total, 4);
  assert.equal(shaped.done, 1);
  assert.deepEqual(shaped.items.map(item => item.key), ['AB-2', 'AB-9']);
  assert.deepEqual(shaped.items[1], {
    key: 'AB-9', url: `${JIRA_SITE}/browse/AB-9`, summary: '', type: '',
    status: { name: '', category: 'doing' }, assignee: null, version: null,
  });
  assert.equal(jiraModule.shapeChildren(JIRA_SITE, []), null, '하나도 없으면 줄 자체가 없다');
  assert.equal(jiraModule.shapeChildren(JIRA_SITE, null), null);
});

test('하위가 100개를 넘어도 지라에서 읽어 오는 것은 100개까지다', async () => {
  const many = { issues: Array.from({ length: 100 }, (unused, at) => ({
    key: `AB-${at + 2}`,
    fields: { summary: `하위 ${at + 1}`, status: { name: '진행 중', statusCategory: { key: 'indeterminate' } }, assignee: { displayName: '루본' } },
  })) };
  const fake = jiraFake({ '/rest/api/3/issue/AB-1': () => json(jiraIssueBody()), '/rest/api/3/search/jql': () => json(many) });
  const issue = await jiraModule.createJiraClient({ settings: jiraSettings(), request: fake.request, readToken: () => JIRA_TOKEN }).getIssueOverview('AB-1');
  assert.equal(issue.children.items.length, 100);
  assert.match(fake.calls[1].url, /maxResults=100$/, '더 달라고 조르지 않는다 — 나머지는 지라에서 본다');
});

test('지라 실패는 해요체 문구와 갈래로만 알리고 토큰·이메일을 싣지 않는다', async () => {
  const settings = jiraSettings();
  const run = async (routes) => {
    try {
      await jiraModule.createJiraClient({ settings, request: jiraFake(routes).request, readToken: () => JIRA_TOKEN }).getIssueOverview('AB-1');
      return null;
    } catch (error) { return error; }
  };
  const auth = await run({ '/issue/AB-1': () => json({ errorMessages: ['Client must be authenticated'] }, 401) });
  assert.equal(auth.kind, 'auth');
  assert.equal(auth.message, '지라 토큰을 확인해 주세요.');
  assert.equal((await run({ '/issue/AB-1': () => json({}, 403) })).kind, 'auth');
  const missing = await run({ '/issue/AB-1': () => json({ errorMessages: ['Issue does not exist'] }, 404) });
  assert.equal(missing.kind, 'notfound');
  assert.equal(missing.message, '지라에서 이 티켓을 찾지 못했어요.');
  const timeout = await run({ '/issue/AB-1': () => { throw new DOMException('The operation was aborted', 'TimeoutError'); } });
  assert.equal(timeout.kind, 'network');
  assert.equal(timeout.message, '지라에 연결하지 못했어요.');
  assert.equal((await run({ '/issue/AB-1': () => json({}, 500) })).kind, 'other');
  // 잘못된 키는 아예 지라를 부르지 않는다.
  const fake = jiraFake({ '/issue/': () => json(jiraIssueBody()) });
  const client = jiraModule.createJiraClient({ settings, request: fake.request, readToken: () => JIRA_TOKEN });
  for (const bad of ['io-1', 'AB1', 'AB-', 'AB-1x', '../../etc/passwd', '']) {
    await assert.rejects(() => client.getIssueOverview(bad), error => error.kind === 'key' && error.message === '지라 번호를 확인해 주세요.');
  }
  assert.equal(fake.calls.length, 0);
  // 어떤 문구에도 토큰·이메일이 섞이지 않는다.
  for (const error of [auth, missing, timeout]) {
    assert.doesNotMatch(error.message, new RegExp(JIRA_TOKEN));
    assert.doesNotMatch(error.message, new RegExp(JIRA_EMAIL));
  }
});

test('지라 API는 설정이 없거나 토큰을 못 읽으면 연결 안 됨으로만 답한다', async () => {
  const fake = jiraFake({ '/issue/': () => json(jiraIssueBody()) });
  const off = jiraModule.createJiraApi({ config: {}, request: fake.request });
  assert.deepEqual(await off.read('AB-1'), { ok: true, connected: false });
  assert.equal(off.connected, false);
  // siteUrl이 https가 아니면 설정이 없는 것으로 본다.
  const plain = jiraModule.createJiraApi({ config: { jira: { siteUrl: 'http://example-jira.test', email: JIRA_EMAIL, tokenFile: '/tmp/x' } }, request: fake.request });
  assert.deepEqual(await plain.read('AB-1'), { ok: true, connected: false });
  const noToken = jiraModule.createJiraApi({ config: jiraConfig, request: fake.request, readFile: () => { throw new Error('ENOENT'); } });
  assert.deepEqual(await noToken.read('AB-1'), { ok: true, connected: false });
  const blank = jiraModule.createJiraApi({ config: jiraConfig, request: fake.request, readFile: () => '  \n' });
  assert.deepEqual(await blank.read('AB-1'), { ok: true, connected: false });
  assert.equal(fake.calls.length, 0, '연결되지 않았으면 지라를 부르지 않는다');
});

test('지라 API는 키별로 60초 캐시하고 fresh=1이면 건너뛴다', async () => {
  const fake = jiraFake({ '/rest/api/3/issue/': () => json(jiraIssueBody()), '/rest/api/3/search': () => json({ issues: [] }) });
  let clock = 1000;
  const api = jiraModule.createJiraApi({ config: jiraConfig, request: fake.request, readFile: () => JIRA_TOKEN, now: () => clock });
  const first = await api.read('AB-1');
  assert.equal(first.connected, true);
  assert.equal(first.issue.summary, '게시글 작성하기_게임 임베드');
  const issueCalls = () => fake.calls.filter(call => call.url.includes('/rest/api/3/issue/')).length;
  assert.equal(issueCalls(), 1);
  await api.read('AB-1');
  assert.equal(issueCalls(), 1, '60초 안에는 다시 부르지 않는다');
  await api.read('AB-2');
  assert.equal(issueCalls(), 2, '캐시는 키마다 따로다');
  await api.read('AB-1', { fresh: true });
  assert.equal(issueCalls(), 3, 'fresh=1이면 캐시를 건너뛴다');
  clock += 61 * 1000;
  await api.read('AB-1');
  assert.equal(issueCalls(), 4, '60초가 지나면 다시 읽는다');
  // 키 형식은 API에서도 막는다.
  assert.deepEqual(await api.read('nope'), { ok: false, error: '지라 번호를 확인해 주세요.', kind: 'key' });
  // 돌려주는 값 어디에도 토큰·이메일이 없다.
  const payload = JSON.stringify(await api.read('AB-1'));
  assert.doesNotMatch(payload, new RegExp(JIRA_TOKEN));
  assert.doesNotMatch(payload, new RegExp(JIRA_EMAIL));
});

test('지라 API의 실패 응답은 화면에 그대로 쓸 문구와 갈래를 담는다', async () => {
  const api = kind => jiraModule.createJiraApi({
    config: jiraConfig, readFile: () => JIRA_TOKEN,
    request: jiraFake({ '/rest/api/3/issue/': () => (kind === 'network' ? (() => { throw new TypeError('fetch failed'); })() : json({}, kind)) }).request,
  });
  assert.deepEqual(await api(401).read('AB-1'), { ok: false, error: '지라 토큰을 확인해 주세요.', kind: 'auth' });
  assert.deepEqual(await api(404).read('AB-1'), { ok: false, error: '지라에서 이 티켓을 찾지 못했어요.', kind: 'notfound' });
  assert.deepEqual(await api('network').read('AB-1'), { ok: false, error: '지라에 연결하지 못했어요.', kind: 'network' });
  assert.deepEqual(await api(500).read('AB-1'), { ok: false, error: '지라에 연결하지 못했어요.', kind: 'other' });
});

test('GET /api/jira/issue는 파일을 쓰지 않고, 설정이 없으면 연결 안 됨으로 답한다', async () => {
  const snapshot = () => fs.readdirSync(directory).sort().map(name => {
    const stat = fs.statSync(path.join(directory, name));
    return `${name}:${stat.size}:${stat.mtimeMs}`;
  }).join('|');
  const before = snapshot();
  const response = await fetch(`${base}/api/jira/issue?key=IO-48394`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, connected: false });
  // 형식이 틀린 키만 400이다. 지라 쪽 실패는 200 + `ok:false`로 오므로 화면이 조용히 그 문구를 적는다.
  const bad = await fetch(`${base}/api/jira/issue?key=not-a-key`);
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { ok: false, error: '지라 번호를 확인해 주세요.', kind: 'key' });
  assert.equal(snapshot(), before, '조회는 어떤 파일도 만들거나 고치지 않는다');
});

// ---------- 지라 바꾸기 (BJR 2단계 — 지라에 쓴다) ----------
// 여기서도 실제 지라에는 절대 닿지 않는다: 모든 요청은 가짜 fetch가 받아 기록만 한다.
// `쓰기 요청이 나갔는가`는 기록된 method로 판정한다(GET만 나갔으면 아무것도 쓰지 않은 것이다).
const jiraTransitionsBody = {
  transitions: [
    { id: '11', name: '작업 시작', to: { name: '진행 중', statusCategory: { key: 'indeterminate' } } },
    // 같은 `to.name`이 둘이다 — 이름만으로는 구분되지 않으므로 전환 이름이 괄호로 붙어야 한다.
    { id: '21', name: '완료 처리', to: { name: '완료', statusCategory: { key: 'done' } } },
    { id: '31', name: '배포 대기로', to: { name: '완료', statusCategory: { key: 'indeterminate' } } },
    // 기본값 없는 필수 입력이 있는 전환 — 선택지에는 두되 앱에서 쓰지 않는다.
    { id: '41', name: '보류', to: { name: '보류', statusCategory: { key: 'new' } }, fields: { reason: { required: true, hasDefaultValue: false } } },
    // statusCategory가 없으면(모르는 모양) 범주는 `doing`으로 흐른다. 필수지만 기본값이 있는 칸은 입력 화면이 필요 없다.
    { id: '51', name: '취소', to: { name: '취소됨' }, fields: { resolution: { required: true, hasDefaultValue: true } } },
  ],
};
const jiraVersionsBody = [
  { id: '10101', name: 'v2.70.0', releaseDate: '2026-09-30', released: false, archived: false },
  { id: '10102', name: 'v2.71.0', releaseDate: null, released: false, archived: false },
  { id: '10099', name: 'v2.60.0', releaseDate: '2026-08-01', released: true, archived: false },
  { id: '10098', name: 'v2.50.0', released: false, archived: true },
];
// 순서가 중요하다 — 앞선 열쇠가 먼저 걸린다(`/transitions`가 `/issue/AB-1`보다 앞).
const jiraChangeRoutes = (extra = {}) => ({
  '/rest/api/3/issue/AB-1/transitions': () => json(jiraTransitionsBody),
  '/rest/api/3/project/AB/versions': () => json(jiraVersionsBody),
  '/rest/api/3/version/': () => new Response(null, { status: 204 }),
  '/rest/api/3/issue/AB-1': () => json(jiraIssueBody()),
  '/rest/api/3/search': () => json({ issues: [] }),
  ...extra,
});
function jiraChangeApi(routes = jiraChangeRoutes(), options = {}) {
  const fake = jiraFake(routes);
  return { fake, api: jiraModule.createJiraApi({ config: jiraConfig, request: fake.request, readFile: () => JIRA_TOKEN, ...options }) };
}
const jiraWrites = fake => fake.calls.filter(call => call.method !== 'GET');

test('지라 고르개의 선택지는 허용된 전환과 미배포 버전뿐이고, 읽기만 한다', async () => {
  const { fake, api } = jiraChangeApi();
  const payload = await api.options('AB-1');
  assert.equal(payload.ok, true);
  assert.equal(payload.connected, true);
  assert.deepEqual(payload.transitions, [
    { id: '11', name: '진행 중', category: 'doing', requiresInput: false },
    // 같은 이름이 둘일 때만 전환 이름이 괄호로 붙는다.
    { id: '21', name: '완료 (완료 처리)', category: 'done', requiresInput: false },
    { id: '31', name: '완료 (배포 대기로)', category: 'doing', requiresInput: false },
    { id: '41', name: '보류', category: 'todo', requiresInput: true },
    // statusCategory를 안 준 전환은 `doing`으로 흐른다(BJCOLOR — 진행 범주와 같은 기본값).
    { id: '51', name: '취소됨', category: 'doing', requiresInput: false },
  ]);
  // 배포됐거나 보관된 버전은 고를 수 없다.
  assert.deepEqual(payload.versions, [
    { id: '10101', name: 'v2.70.0', releaseDate: '2026-09-30' },
    { id: '10102', name: 'v2.71.0', releaseDate: null },
  ]);
  assert.equal(jiraWrites(fake).length, 0, '선택지를 읽는 것만으로는 지라에 아무것도 쓰지 않는다');
  // 프로젝트 키는 티켓 키에서 뽑는다 — 따로 더 묻지 않는다.
  assert.ok(fake.calls.some(call => call.url.endsWith('/rest/api/3/project/AB/versions')));
  assert.equal(jiraModule.projectOf('IO-48394'), 'IO');
  // 설정이 없으면 지라를 부르지 않는다.
  const off = jiraModule.createJiraApi({ config: {}, request: jiraFake({}).request });
  assert.deepEqual(await off.options('AB-1'), { ok: true, connected: false });
  assert.deepEqual(await off.options('nope'), { ok: false, error: '지라 번호를 확인해 주세요.', kind: 'key' });
});

test('지라 상태 바꾸기는 쓰기 직전에 전환 목록을 다시 조회해 대조한다', async () => {
  const { fake, api } = jiraChangeApi();
  assert.deepEqual(await api.change({ key: 'AB-1', kind: 'status', transitionId: '21' }), { ok: true });
  const writes = jiraWrites(fake);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, 'POST');
  assert.ok(writes[0].url.endsWith('/rest/api/3/issue/AB-1/transitions'));
  assert.deepEqual(writes[0].body, { transition: { id: '21' } });
  // 쓰기 바로 앞에 전환 목록을 다시 읽는다(고르개가 본 목록을 믿지 않는다).
  assert.ok(fake.calls[fake.calls.length - 2].url.includes('/transitions?expand=transitions.fields'));

  // 목록에 없는 id는 쓰지 않는다.
  const stale = jiraChangeApi();
  assert.deepEqual(await stale.api.change({ key: 'AB-1', kind: 'status', transitionId: '99' }),
    { ok: false, error: '지라에서 고를 수 있는 값이 바뀌었어요. 카드를 새로 읽고 다시 골라 주세요.', kind: 'stale' });
  assert.equal(jiraWrites(stale.fake).length, 0);

  // 필수 입력이 있는 전환도 쓰지 않는다 — 지라에서 직접 하게 안내한다.
  const screen = jiraChangeApi();
  assert.deepEqual(await screen.api.change({ key: 'AB-1', kind: 'status', transitionId: '41' }),
    { ok: false, error: '이 전환은 지라에서 직접 해 주세요.', kind: 'screen' });
  assert.equal(jiraWrites(screen.fake).length, 0);

  // id 형식이 숫자가 아니면 아예 나가지 않는다(주소에 끼우는 값이다).
  const bad = jiraChangeApi();
  assert.equal((await bad.api.change({ key: 'AB-1', kind: 'status', transitionId: '../../x' })).kind, 'stale');
  assert.equal(jiraWrites(bad.fake).length, 0);
});

test('배포 버전은 한 개짜리 티켓만 옮기고, `버전 없음`은 빈 배열로 보낸다', async () => {
  const single = jiraChangeApi();
  assert.deepEqual(await single.api.change({ key: 'AB-1', kind: 'version', versionId: '10102' }), { ok: true });
  const [write] = jiraWrites(single.fake);
  assert.equal(write.method, 'PUT');
  assert.ok(write.url.endsWith('/rest/api/3/issue/AB-1'));
  assert.deepEqual(write.body, { fields: { fixVersions: [{ id: '10102' }] } });

  const cleared = jiraChangeApi();
  assert.deepEqual(await cleared.api.change({ key: 'AB-1', kind: 'version', versionId: null }), { ok: true });
  assert.deepEqual(jiraWrites(cleared.fake)[0].body, { fields: { fixVersions: [] } });

  // 버전이 여러 개 걸린 티켓은 앱에서 바꾸지 않는다 — 다른 버전을 실수로 지우지 않게.
  const many = jiraChangeApi(jiraChangeRoutes({
    '/rest/api/3/issue/AB-1': () => json(jiraIssueBody({ fixVersions: [{ id: '10101', name: 'v2.70.0' }, { id: '10102', name: 'v2.71.0' }] })),
  }));
  assert.deepEqual(await many.api.change({ key: 'AB-1', kind: 'version', versionId: '10102' }),
    { ok: false, error: '버전이 여러 개라 지라에서 직접 바꿔 주세요.', kind: 'multi' });
  assert.equal(jiraWrites(many.fake).length, 0);

  // 그 프로젝트의 버전이 아니면 쓰지 않는다.
  const foreign = jiraChangeApi();
  assert.equal((await foreign.api.change({ key: 'AB-1', kind: 'version', versionId: '99999' })).kind, 'stale');
  assert.equal(jiraWrites(foreign.fake).length, 0);
});

test('지라의 기한은 지울 수 있고, 날짜 형식이 아니면 아무것도 보내지 않는다', async () => {
  const set = jiraChangeApi();
  assert.deepEqual(await set.api.change({ key: 'AB-1', kind: 'due', due: '2026-11-02' }), { ok: true });
  assert.deepEqual(jiraWrites(set.fake)[0].body, { fields: { duedate: '2026-11-02' } });
  assert.equal(jiraWrites(set.fake)[0].method, 'PUT');

  const cleared = jiraChangeApi();
  assert.deepEqual(await cleared.api.change({ key: 'AB-1', kind: 'due', due: null }), { ok: true });
  assert.deepEqual(jiraWrites(cleared.fake)[0].body, { fields: { duedate: null } });

  for (const due of ['내일', '2026-13-01x', 20261102, { }]) {
    const bad = jiraChangeApi();
    assert.deepEqual(await bad.api.change({ key: 'AB-1', kind: 'due', due }), { ok: false, error: '보낸 값을 확인해 주세요.', kind: 'value' });
    assert.equal(jiraWrites(bad.fake).length, 0);
  }
});

test('버전 고치기는 바뀐 칸만 보내고, 그 프로젝트의 버전만 받는다', async () => {
  const renamed = jiraChangeApi();
  assert.deepEqual(await renamed.api.change({ key: 'AB-1', kind: 'versionEdit', versionId: '10101', name: 'v2.70.1' }), { ok: true });
  const [write] = jiraWrites(renamed.fake);
  assert.equal(write.method, 'PUT');
  assert.ok(write.url.endsWith('/rest/api/3/version/10101'));
  assert.deepEqual(write.body, { name: 'v2.70.1' }, '이름만 고쳤으면 배포일은 보내지 않는다');

  const dated = jiraChangeApi();
  assert.deepEqual(await dated.api.change({ key: 'AB-1', kind: 'versionEdit', versionId: '10101', releaseDate: '2026-10-07' }), { ok: true });
  assert.deepEqual(jiraWrites(dated.fake)[0].body, { releaseDate: '2026-10-07' });

  const wiped = jiraChangeApi();
  assert.deepEqual(await wiped.api.change({ key: 'AB-1', kind: 'versionEdit', versionId: '10101', releaseDate: null }), { ok: true });
  assert.deepEqual(jiraWrites(wiped.fake)[0].body, { releaseDate: null });

  for (const patch of [{ name: '  ' }, { name: 'a\nb' }, { name: 'x'.repeat(256) }, {}, { versionId: '99999', name: 'v9' }]) {
    const bad = jiraChangeApi();
    const result = await bad.api.change({ key: 'AB-1', kind: 'versionEdit', versionId: '10101', ...patch });
    assert.equal(result.ok, false);
    assert.ok(['value', 'stale'].includes(result.kind), `${JSON.stringify(patch)} → ${result.kind}`);
    assert.equal(jiraWrites(bad.fake).length, 0);
  }
});

test('지라 쓰기 실패는 갈래별 해요체 문구로만 알리고 토큰·이메일을 싣지 않는다', async () => {
  const fail = (status) => jiraChangeApi(jiraChangeRoutes({
    '/rest/api/3/issue/AB-1/transitions': (url, method) => (method === 'GET'
      ? json(jiraTransitionsBody)
      : status === 'network' ? (() => { throw new TypeError('fetch failed'); })() : json({ errorMessages: ['지라 원문 오류 — 화면에 나오면 안 된다'] }, status)),
  }));
  const run = async (status) => (await fail(status).api.change({ key: 'AB-1', kind: 'status', transitionId: '21' }));
  assert.deepEqual(await run(403), { ok: false, error: '지라에서 이 티켓을 바꿀 권한이 없어요.', kind: 'forbidden' });
  assert.deepEqual(await run(401), { ok: false, error: '지라에서 이 티켓을 바꿀 권한이 없어요.', kind: 'forbidden' });
  assert.deepEqual(await run(400), { ok: false, error: '지라가 이 변경을 받아들이지 않았어요. 지라에서 직접 확인해 주세요.', kind: 'reject' });
  assert.deepEqual(await run(404), { ok: false, error: '지라에서 이 티켓을 찾지 못했어요.', kind: 'notfound' });
  assert.deepEqual(await run(409), { ok: false, error: '지라에 반영하지 못했어요.', kind: 'write' });
  assert.deepEqual(await run(500), { ok: false, error: '지라에 반영하지 못했어요.', kind: 'write' });
  assert.deepEqual(await run('network'), { ok: false, error: '지라에 반영하지 못했어요.', kind: 'write' });
  // 지라가 준 원문도, 토큰·이메일도 응답에 섞이지 않는다.
  for (const status of [403, 400, 500]) {
    const payload = JSON.stringify(await run(status));
    assert.doesNotMatch(payload, /지라 원문 오류/);
    assert.doesNotMatch(payload, new RegExp(JIRA_TOKEN));
    assert.doesNotMatch(payload, new RegExp(JIRA_EMAIL));
  }
  // 설정이 없거나 토큰을 못 읽으면 지라를 부르지 않고 연결 안내만 한다.
  const off = jiraModule.createJiraApi({ config: {}, request: jiraFake({}).request });
  assert.deepEqual(await off.change({ key: 'AB-1', kind: 'status', transitionId: '21' }), { ok: false, error: '지라 연결이 필요해요.', kind: 'off' });
  const noToken = jiraChangeApi(jiraChangeRoutes(), { readFile: () => '' });
  assert.deepEqual(await noToken.api.change({ key: 'AB-1', kind: 'status', transitionId: '21' }), { ok: false, error: '지라 연결이 필요해요.', kind: 'off' });
  assert.equal(jiraWrites(noToken.fake).length, 0);
  // 키·종류가 틀리면 지라를 부르지도 않는다.
  const shape = jiraChangeApi();
  assert.deepEqual(await shape.api.change({ key: 'nope', kind: 'status' }), { ok: false, error: '지라 번호를 확인해 주세요.', kind: 'key' });
  assert.deepEqual(await shape.api.change({ key: 'AB-1', kind: 'delete' }), { ok: false, error: '보낸 값을 확인해 주세요.', kind: 'value' });
  assert.deepEqual(await shape.api.change(null), { ok: false, error: '지라 번호를 확인해 주세요.', kind: 'key' });
  assert.equal(shape.fake.calls.length, 0);
});

test('지라를 바꾸면 그 키의 읽기 캐시를 비운다', async () => {
  const { fake, api } = jiraChangeApi();
  const issueReads = () => fake.calls.filter(call => call.method === 'GET' && /\/rest\/api\/3\/issue\/AB-1\?fields=summary/.test(call.url)).length;
  await api.read('AB-1');
  await api.read('AB-1');
  assert.equal(issueReads(), 1, '60초 캐시는 그대로다');
  assert.deepEqual(await api.change({ key: 'AB-1', kind: 'due', due: '2026-11-02' }), { ok: true });
  await api.read('AB-1');
  assert.equal(issueReads(), 2, '바꾼 뒤에는 캐시가 비어 지라에서 새로 읽는다');
});

test('/api/jira/change는 확인된 요청만 받고, 조회는 파일을 쓰지 않는다', async () => {
  const snapshot = () => fs.readdirSync(directory).sort().map((name) => {
    const stat = fs.statSync(path.join(directory, name));
    return `${name}:${stat.size}:${stat.mtimeMs}`;
  }).join('|');
  const before = snapshot();
  // 이 서버에는 지라 설정이 없다(테스트 머리에서 없는 파일로 고정) — 그래서 바깥으로 나가지 않는다.
  const options = await fetch(`${base}/api/jira/options?key=AB-1`);
  assert.equal(options.status, 200);
  assert.deepEqual(await options.json(), { ok: true, connected: false });
  const badKey = await fetch(`${base}/api/jira/options?key=not-a-key`);
  assert.equal(badKey.status, 400);
  assert.deepEqual(await badKey.json(), { ok: false, error: '지라 번호를 확인해 주세요.', kind: 'key' });

  const off = await post('/api/jira/change', { key: 'AB-1', kind: 'status', transitionId: '21' });
  assert.equal(off.status, 200);
  assert.deepEqual({ ok: off.ok, kind: off.kind, error: off.error }, { ok: false, kind: 'off', error: '지라 연결이 필요해요.' });
  assert.equal((await post('/api/jira/change', { key: 'nope', kind: 'status' })).status, 400);
  assert.equal((await post('/api/jira/change', { key: 'AB-1', kind: 'delete' })).status, 400);
  // 지라 쓰기는 앱 파일을 하나도 건드리지 않는다(요청 원장에도 남지 않는다).
  assert.equal(snapshot(), before);
});

test('복구가 필요한 동안에는 지라 쓰기도 막히고 조회만 된다', async (t) => {
  const external = '# Tasks\n- 바깥에서 고친 줄 #task[id:outside status:to-do created:2026-09-20]\n';
  const server = await startServer(t, (home) => {
    fs.writeFileSync(path.join(home, 'tasks.md'), external);
    fs.writeFileSync(path.join(home, '.mutation-journal.json'), journalEntry(path.join(home, 'tasks.md'), '# Tasks\n', '# Tasks\n- 중단된 저장\n'));
    fs.writeFileSync(path.join(home, '.mutation.lock'), String(deadPid()));
  });
  const blocked = await fetch(server.base + '/api/jira/change', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'AB-1', kind: 'status', transitionId: '21' }),
  });
  assert.equal(blocked.status, 503);
  assert.match((await blocked.json()).error, /저장을 멈췄어요/, '앱 저장소가 아픈 동안에는 바깥에도 쓰지 않는다');
  // 조회는 그대로 된다(설정이 없으므로 연결 안 됨으로 답한다).
  assert.equal((await fetch(server.base + '/api/jira/issue?key=AB-1')).status, 200);
  assert.equal((await fetch(server.base + '/api/jira/options?key=AB-1')).status, 200);
});

// ---------- 직접 만든(그룹) 프로젝트 ↔ 지라 티켓 연결 (BJLINK) ----------
// 여기서도 실제 지라에는 닿지 않는다: 아래 서버는 자기 임시 폴더의 가짜 설정·가짜 토큰을 쓰고,
// 지라 주소로 나가는 fetch는 자식 프로세스 안의 가짜 응답이 전부 가로챈다.
const JIRA_LINK_SITE = 'https://link-jira.test';
// 가짜 지라를 끼운 서버를 하나 띄운다(설정·토큰 파일은 그 임시 폴더 안에만 있다).
async function startLinkedJiraServer(t, seed) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-jiralink-'));
  seed(home);
  const tokenFile = path.join(home, '.jira_token_fixture');
  fs.writeFileSync(tokenFile, 'fixture-token-never-real\n');
  const config = path.join(home, 'workspace.config.json');
  fs.writeFileSync(config, JSON.stringify({ jira: { siteUrl: JIRA_LINK_SITE, email: 'fixture@example.test', tokenFile } }));
  const known = { 'IO-12345': '게시글 작성하기_게임 임베드' };
  const wrapper = path.join(home, 'fake-jira-server.js');
  fs.writeFileSync(wrapper, `'use strict';
const SITE = ${JSON.stringify(JIRA_LINK_SITE)};
const KNOWN = ${JSON.stringify(known)};
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input && input.url ? input.url : input);
  if (!url.startsWith(SITE)) return realFetch(input, init);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const hit = url.match(/\\/rest\\/api\\/3\\/issue\\/([A-Z][A-Z0-9]*-\\d+)/);
  if (hit && KNOWN[hit[1]]) return json({ fields: { summary: KNOWN[hit[1]], status: { name: '진행 중', statusCategory: { key: 'indeterminate' } }, issuetype: { name: '스토리' }, assignee: { displayName: '루본' }, duedate: null, fixVersions: [], subtasks: [] } });
  if (hit) return json({ errorMessages: ['no issue'] }, 404);
  return json({ issues: [] });
};
const { server } = require(${JSON.stringify(path.join(__dirname, 'server.js'))});
server.listen(Number(process.env.WORKSPACE_PORT), '127.0.0.1', () => console.log('ready'));
`);
  const port = await freePort();
  const child = spawn(process.execPath, [wrapper], {
    env: { ...process.env, WORKSPACE_DATA_DIR: home, WORKSPACE_PORT: String(port), WORKSPACE_NO_OPEN: '1', WORKSPACE_HOST: '', WORKSPACE_CONFIG: config },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(home, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`서버가 종료되었습니다 (${child.exitCode}): ${log}`);
    try { if ((await fetch(origin + '/api/storage-status')).ok) return { home, origin }; } catch { /* 아직 안 떴다 */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`서버가 응답하지 않았습니다: ${log}`);
}
const linkPost = (origin, body) => fetch(origin + '/api/project/jira-link', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then(async response => ({ status: response.status, ...await response.json() }));

test('지라 연결은 직접 만든 프로젝트에만, 형식이 맞는 키로만, 지라에 연결돼 있을 때만 걸린다', async () => {
  // 이 서버에는 지라 설정이 없다(테스트 맨 위의 `absent.config.json`) — 연결은 전부 거절된다.
  assert.equal((await post('/api/today-task/create', { description: '연결 실험용 업무', group: '연결 실험' })).ok, true);
  const workflowFile = path.join(directory, '.workflow.json');
  const before = fs.existsSync(workflowFile) ? fs.readFileSync(workflowFile, 'utf8') : null;
  const refuse = async (body, message) => {
    const answer = await linkPost(base, body);
    assert.equal(answer.status, 400, JSON.stringify(body));
    assert.equal(answer.error, message);
  };
  await refuse({ project: 'jira:IO-12345', jira: 'IO-12345' }, '직접 만든 프로젝트에만 지라 티켓을 연결할 수 있어요.');
  await refuse({ project: '연결 실험', jira: 'IO-12345' }, '직접 만든 프로젝트에만 지라 티켓을 연결할 수 있어요.');
  await refuse({ project: 'group:없는 프로젝트', jira: 'IO-12345' }, '프로젝트를 찾을 수 없어요.');
  await refuse({ project: 'group:연결 실험', jira: 'io-12345' }, '지라 번호를 확인해 주세요.');
  await refuse({ project: 'group:연결 실험', jira: 'IO-' }, '지라 번호를 확인해 주세요.');
  // 키는 맞지만 지라에 연결돼 있지 않다 — 읽어 볼 수 없으므로 걸지 않는다.
  await refuse({ project: 'group:연결 실험', jira: 'IO-12345' }, '지라 연결이 필요해요.');
  assert.equal(fs.existsSync(workflowFile) ? fs.readFileSync(workflowFile, 'utf8') : null, before, '거절된 요청은 파일을 고치지 않는다');
  // 해제는 지라에 묻지 않는다 — 걸린 것이 없어도 조용히 통과하고, 목록에도 연결이 없다.
  assert.equal((await linkPost(base, { project: 'group:연결 실험', jira: null })).ok, true);
  assert.deepEqual((await items()).workflows.projectLinks, {});
});

test('지라 티켓 하나를 그룹 프로젝트에 걸고 풀 수 있다 — 저장 전에 지라에서 읽어 보고, 옛 파일도 그대로 읽힌다', async (t) => {
  const server = await startLinkedJiraServer(t, (home) => {
    fs.writeFileSync(path.join(home, 'tasks.md'), '# Tasks\n- 정산 배치 설계 검토하기 #task[id:lk01 status:to-do created:2026-09-20 group:결제_리뉴얼]\n');
    // projectLinks 칸이 없는 옛 파일 — 빈 연결로 읽혀야 한다.
    fs.writeFileSync(path.join(home, '.workflow.json'), JSON.stringify({ items: {}, meetings: {} }));
  });
  const read = async () => (await (await fetch(server.origin + '/api/items')).json());
  const first = await read();
  assert.deepEqual(first.workflows.projectLinks, {}, '옛 파일은 빈 연결로 읽힌다');
  assert.equal(first.jiraSync.connected, true);
  assert.equal(first.jiraSync.siteUrl, JIRA_LINK_SITE, '화면이 붙여 넣은 주소를 견줄 수 있게 주소만 싣는다');
  assert.equal(JSON.stringify(first).includes('fixture-token-never-real'), false, '토큰은 어디에도 싣지 않는다');
  assert.equal(JSON.stringify(first).includes('fixture@example.test'), false, '이메일도 싣지 않는다');

  // 지라에 없는 티켓은 걸리지 않는다(저장도 하지 않는다).
  const missing = await linkPost(server.origin, { project: 'group:결제 리뉴얼', jira: 'IO-99999' });
  assert.equal(missing.status, 400);
  assert.equal(missing.error, '지라에서 이 티켓을 찾지 못했어요.');
  assert.deepEqual((await read()).workflows.projectLinks, {});

  // 지라에서 읽히는 티켓만 걸린다. 파일 표기(`결제_리뉴얼`)와 화면 표기(`결제 리뉴얼`)는 한 꼴로 맞춘다.
  const linked = await linkPost(server.origin, { project: 'group:결제 리뉴얼', jira: 'IO-12345' });
  assert.deepEqual(linked, { status: 200, ok: true, project: 'group:결제 리뉴얼', jira: 'IO-12345' });
  assert.deepEqual((await read()).workflows.projectLinks, { '결제 리뉴얼': 'IO-12345' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(server.home, '.workflow.json'), 'utf8')).projectLinks, { '결제 리뉴얼': 'IO-12345' });
  // 프로젝트 이름도 항목도 그대로다 — 붙은 것은 연결 표시뿐이다.
  const task = (await read()).todayTasks.concat((await read()).laterTasks).find(item => item.id === 'lk01');
  assert.equal(task.group, '결제 리뉴얼');
  assert.equal(task.jira, null);

  // 같은 내용을 같은 식별자로 다시 보내면 한 번만 쓴다(기존 idempotency 규칙 그대로).
  const key = 'bjlink-idempotency-key-0001';
  const send = () => fetch(server.origin + '/api/project/jira-link', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ project: 'group:결제 리뉴얼', jira: null }),
  }).then(response => response.json());
  assert.deepEqual(await send(), { ok: true, project: 'group:결제 리뉴얼', jira: null });
  assert.deepEqual(await send(), { ok: true, project: 'group:결제 리뉴얼', jira: null });
  assert.deepEqual((await read()).workflows.projectLinks, {}, '해제하면 칸에서 사라진다');
});

test('복구가 필요한 동안에는 지라 연결도 걸리지 않는다', async (t) => {
  const server = await startServer(t, (home) => {
    fs.writeFileSync(path.join(home, 'tasks.md'), '# Tasks\n- 막힌 저장 #task[id:lk02 status:to-do created:2026-09-20 group:운영툴]\n');
    fs.writeFileSync(path.join(home, '.mutation-journal.json'), journalEntry(path.join(home, 'tasks.md'), '# Tasks\n', '# Tasks\n- 중단된 저장\n'));
    fs.writeFileSync(path.join(home, '.mutation.lock'), String(deadPid()));
  });
  const blocked = await linkPost(server.base, { project: 'group:운영툴', jira: null });
  assert.equal(blocked.status, 503);
  assert.match(blocked.error, /저장을 멈췄어요/, '앱 저장소가 아픈 동안에는 연결도 걸지 않는다');
});

// ---------- 내 담당 지라 목록도 앱이 직접 읽는다 (BJLIVE) ----------
// 여기서도 실제 지라에는 절대 닿지 않는다: 아래는 전부 가짜 fetch이고, 서버를 띄우는 자리는
// 자기 임시 폴더의 가짜 설정·가짜 토큰만 쓴다.
const jiraListBody = (issues) => ({ issues });
const jiraListIssue = (key, extra = {}) => ({
  key,
  fields: {
    summary: `${key}의 요약`,
    status: { name: '진행 중', statusCategory: { key: 'indeterminate' } },
    issuetype: { name: '스토리' },
    duedate: '2026-10-02',
    fixVersions: [{ id: '10101', name: 'v2.70.0', releaseDate: '2026-09-30', released: false }],
    ...extra,
  },
});
const jiraListClient = fake => jiraModule.createJiraClient({ settings: jiraSettings(), request: fake.request, readToken: () => JIRA_TOKEN });

test('내 담당 목록은 파일과 같은 칸에 새 칸(범주·기한·배포 버전)만 얹어 돌려주고, 담당자는 아예 묻지 않는다', async () => {
  const fake = jiraFake({ '/rest/api/3/search/jql': () => json(jiraListBody([jiraListIssue('IO-48394'), { key: '수상한키', fields: {} }])) });
  const issues = await jiraListClient(fake).listMyIssues();
  assert.deepEqual(issues, [{
    // 기존 자리(프로젝트 이름 붙이기·고르기 목록)가 그대로 읽는 칸 — `status`는 상태 이름 글자다.
    key: 'IO-48394', type: '스토리', status: '진행 중', summary: 'IO-48394의 요약', extra: false,
    // 이번에 더한 칸(화면은 아직 그리지 않는다 — 배포 임박 알림·주간요약이 쓸 값이다).
    category: 'doing', due: '2026-10-02',
    versions: [{ name: 'v2.70.0', releaseDate: '2026-09-30', released: false }],
  }], '키 형식이 아닌 줄은 버린다');
  assert.equal(fake.calls.length, 1, '연결된 키가 없으면 한 번만 묻는다');
  const [call] = fake.calls;
  assert.match(call.url, /\/rest\/api\/3\/search\/jql\?jql=/);
  assert.match(call.url, /fields=summary,status,issuetype,fixVersions,duedate&maxResults=100$/);
  assert.equal(decodeURIComponent(call.url.split('jql=')[1].split('&')[0]), 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC');
  // 담당자 칸은 애초에 달라고 하지 않는다 — 그래야 이메일·계정 id가 응답에 실릴 일이 없다.
  assert.doesNotMatch(fake.calls.map(entry => entry.url).join(' '), /assignee&|assignee,|emailAddress|accountId/);
});

test('업무에 걸린 키는 기본 목록에 없을 때만 한 번 더 묻고 `그 밖의 이슈`로 표시된다', async () => {
  const routes = {
    '/rest/api/3/search/jql': (url) => {
      const jql = decodeURIComponent(String(url).split('jql=')[1].split('&')[0]);
      if (jql.startsWith('key in')) {
        assert.equal(jql, 'key in (IO-77777)', '기본 목록에 이미 있는 키는 다시 묻지 않는다');
        return json(jiraListBody([jiraListIssue('IO-77777', { status: { name: '완료', statusCategory: { key: 'done' } } })]));
      }
      return json(jiraListBody([jiraListIssue('IO-48394')]));
    },
  };
  const fake = jiraFake(routes);
  const issues = await jiraListClient(fake).listMyIssues(['IO-48394', 'IO-77777', 'IO-77777', 'not-a-key', null]);
  assert.deepEqual(issues.map(issue => [issue.key, issue.extra, issue.status, issue.category]),
    [['IO-48394', false, '진행 중', 'doing'], ['IO-77777', true, '완료', 'done']]);
  assert.equal(fake.calls.length, 2, '기본 목록 한 번 + 남은 키 한 번');

  // 걸린 키가 전부 기본 목록에 있으면 두 번째 조회는 아예 나가지 않는다.
  const covered = jiraFake(routes);
  await jiraListClient(covered).listMyIssues(['IO-48394']);
  assert.equal(covered.calls.length, 1);
});

test('목록은 100개까지만 들고 오고, 새 search 주소가 없으면 옛 주소로 한 번 물러선다', async () => {
  const many = jiraListBody(Array.from({ length: 140 }, (unused, index) => jiraListIssue(`IO-${1000 + index}`)));
  const capped = jiraFake({ '/rest/api/3/search/jql': () => json(many) });
  assert.equal((await jiraListClient(capped).listMyIssues()).length, 100);
  assert.match(capped.calls[0].url, /maxResults=100$/);

  const fallback = jiraFake({
    '/rest/api/3/search/jql': () => json({ errorMessages: ['not found'] }, 404),
    '/rest/api/3/search?': () => json(jiraListBody([jiraListIssue('IO-48394')])),
  });
  assert.deepEqual((await jiraListClient(fallback).listMyIssues()).map(issue => issue.key), ['IO-48394']);
  assert.equal(fallback.calls.length, 2, '새 주소가 404일 때만, 옛 주소로 한 번만 물러선다');
});

test('목록 API는 설정·토큰이 없으면 연결 안 됨으로만 답하고, 실패는 해요체 문구로 알린다', async () => {
  const fake = jiraFake({ '/rest/api/3/search': () => json(jiraListBody([jiraListIssue('IO-48394')])) });
  const off = jiraModule.createJiraApi({ config: {}, request: fake.request });
  assert.deepEqual(await off.list(['IO-48394']), { ok: true, connected: false });
  assert.equal(fake.calls.length, 0, '연결되지 않았으면 지라를 부르지 않는다');

  const noToken = jiraModule.createJiraApi({ config: jiraConfig, request: fake.request, readFile: () => '' });
  assert.deepEqual(await noToken.list(), { ok: true, connected: false });

  const ok = jiraModule.createJiraApi({ config: jiraConfig, request: fake.request, readFile: () => JIRA_TOKEN });
  const answer = await ok.list();
  assert.equal(answer.connected, true);
  assert.equal(answer.issues.length, 1);
  assert.doesNotMatch(JSON.stringify(answer), new RegExp(`${JIRA_TOKEN}|${JIRA_EMAIL}`), '토큰·이메일은 어디에도 싣지 않는다');

  const broken = jiraModule.createJiraApi({
    config: jiraConfig, readFile: () => JIRA_TOKEN,
    request: jiraFake({ '/rest/api/3/search': () => json({}, 401) }).request,
  });
  assert.deepEqual(await broken.list(), { ok: false, error: '지라 토큰을 확인해 주세요.', kind: 'auth' });
});

// 보관함(jira-live)의 시간 규칙 — 가짜 시계와 가짜 목록 API로만 확인한다(지라에 닿지 않는다).
const jiraLiveModule = require('./jira-live');
function liveHarness({ answers = [], connected = true } = {}) {
  let clock = 0;
  const calls = [];
  let pending = null;
  const list = (keys) => {
    calls.push(keys);
    const answer = answers.length ? answers.shift() : { ok: true, connected: true, issues: [{ key: 'IO-1' }] };
    if (answer === 'hang') return new Promise((resolve) => { pending = resolve; });
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(answer);
  };
  const live = jiraLiveModule.createJiraLive({ list, keys: () => ['IO-9'], connected: () => connected, now: () => clock });
  return { live, calls, tick: ms => { clock += ms; }, release: value => { const resolve = pending; pending = null; resolve(value); } };
}

test('지라 목록 보관함은 실패해도 이전 값을 30분까지 쓰고, 그보다 묵으면 버린다', async () => {
  const held = liveHarness({ answers: [
    { ok: true, connected: true, issues: [{ key: 'IO-1' }] },
    { ok: false, error: '지라에 연결하지 못했어요.', kind: 'network' },
    new Error('fetch failed'),
  ] });
  await held.live.refresh();
  assert.deepEqual(held.live.current().issues, [{ key: 'IO-1' }]);
  assert.deepEqual(held.calls[0], ['IO-9'], '업무에 걸린 키를 함께 넘긴다');

  held.tick(10 * 60 * 1000);
  assert.equal(await held.live.refresh(), false);
  assert.deepEqual(held.live.current().issues, [{ key: 'IO-1' }], '실패하면 이전 값을 그대로 둔다');
  assert.equal(await held.live.refresh(), false, '던지는 실패도 조용히 흘린다');

  held.tick(21 * 60 * 1000); // 마지막으로 성공한 지 31분
  assert.equal(held.live.current(), null, '30분보다 묵으면 버린다(그때부터 파일 스냅샷을 쓴다)');
});

test('지라 목록 보관함은 동시에 두 번 돌지 않고, 5분 넘게 묵었을 때만 뒤에서 갱신을 건다', async () => {
  const harness = liveHarness({ answers: ['hang', { ok: true, connected: true, issues: [{ key: 'IO-2' }] }] });
  const first = harness.live.refresh();
  const second = harness.live.refresh();
  assert.equal(first, second, '도는 중이면 같은 갱신을 나눠 쓴다');
  assert.equal(harness.calls.length, 1);
  harness.release({ ok: true, connected: true, issues: [{ key: 'IO-1' }] });
  await first;

  harness.live.nudge();
  assert.equal(harness.calls.length, 1, '방금 읽은 값은 그대로 쓴다');
  harness.tick(5 * 60 * 1000);
  harness.live.nudge();
  assert.equal(harness.calls.length, 2, '5분이 지나면 갱신을 건다');
});

test('지라 설정이 없으면 목록 보관함은 타이머도 첫 읽기도 돌리지 않는다', async () => {
  const off = liveHarness({ connected: false });
  assert.equal(off.live.start(), false);
  assert.equal(off.live.started(), false);
  assert.equal(off.calls.length, 0);
  off.live.nudge();
  assert.equal(off.calls.length, 0);

  const on = liveHarness();
  assert.equal(on.live.start(), true);
  assert.equal(on.calls.length, 1, '설정이 있으면 뜰 때 한 번 읽는다');
  assert.equal(on.live.holdsProcess(), false, '타이머는 unref — 이것 때문에 프로세스가 남지 않는다');
  assert.equal(on.live.start(), false, '두 번 켜지지 않는다');
  on.live.stop();
  assert.equal(on.live.started(), false);
});

// 가짜 지라를 끼운 서버 하나. 목록 응답이 스냅샷 파일과 **다르게** 오도록 두어,
// 화면에 실린 값이 어디서 왔는지 눈으로 가를 수 있게 한다.
const JIRA_LIVE_SITE = 'https://live-jira.test';
async function startLiveJiraServer(t, { fail = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-jiralive-'));
  fs.writeFileSync(path.join(home, 'tasks.md'),
    '# Tasks\n- 정산 배치 설계 검토하기 #task[id:lv01 status:to-do created:2026-09-20 jira:IO-77777]\n');
  // 스냅샷 파일(대비책) — 요약이 일부러 낡았고 날짜도 어제다.
  fs.writeFileSync(path.join(home, 'jira_issues.md'),
    '# 지라 이슈 (내 담당, 진행중/백로그)\n\n마지막 갱신: 2026-01-02\n\n- IO-12345 | 에픽 | 진행 중 | 파일에서 온 낡은 요약\n');
  const tokenFile = path.join(home, '.jira_token_fixture');
  fs.writeFileSync(tokenFile, 'fixture-token-never-real\n');
  const config = path.join(home, 'workspace.config.json');
  fs.writeFileSync(config, JSON.stringify({ jira: { siteUrl: JIRA_LIVE_SITE, email: 'fixture@example.test', tokenFile } }));
  const wrapper = path.join(home, 'fake-jira-list-server.js');
  fs.writeFileSync(wrapper, `'use strict';
const SITE = ${JSON.stringify(JIRA_LIVE_SITE)};
const FAIL = ${fail ? 'true' : 'false'};
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input && input.url ? input.url : input);
  if (!url.startsWith(SITE)) return realFetch(input, init);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (FAIL) return json({ errorMessages: ['down'] }, 500);
  const jql = url.includes('jql=') ? decodeURIComponent(url.split('jql=')[1].split('&')[0]) : '';
  const issue = (key, summary, done) => ({ key, fields: {
    summary,
    status: done ? { name: '완료', statusCategory: { key: 'done' } } : { name: '진행 중', statusCategory: { key: 'indeterminate' } },
    issuetype: { name: '에픽' }, duedate: '2026-10-02',
    fixVersions: [{ id: '10101', name: 'v2.70.0', releaseDate: '2026-09-30', released: false }],
    // 지라는 묻지 않아도 이런 칸을 끼워 보낼 수 있다 — 앱이 옮기지 않는지 함께 본다.
    assignee: { displayName: '루본', emailAddress: 'lubon@live-jira.test', accountId: '712020:live' },
  } });
  if (jql.startsWith('key in')) return json({ issues: [issue('IO-77777', '업무에 걸린 다 끝난 티켓', true)] });
  return json({ issues: [issue('IO-12345', '지라에서 바로 읽은 요약', false)] });
};
const { server } = require(${JSON.stringify(path.join(__dirname, 'server.js'))});
server.listen(Number(process.env.WORKSPACE_PORT), '127.0.0.1', () => console.log('ready'));
`);
  const port = await freePort();
  const child = spawn(process.execPath, [wrapper], {
    env: { ...process.env, WORKSPACE_DATA_DIR: home, WORKSPACE_PORT: String(port), WORKSPACE_NO_OPEN: '1', WORKSPACE_HOST: '', WORKSPACE_CONFIG: config },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(home, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`서버가 종료되었습니다 (${child.exitCode}): ${log}`);
    try { if ((await fetch(origin + '/api/storage-status')).ok) return { home, origin }; } catch { /* 아직 안 떴다 */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`서버가 응답하지 않았습니다: ${log}`);
}

test('목록이 살아 있으면 고르기 목록·요약이 지라 값이 되고 낡음 경고가 사라진다 — 파일은 쓰지 않는다', async (t) => {
  const server = await startLiveJiraServer(t);
  const snapshotFile = path.join(server.home, 'jira_issues.md');
  const stamp = () => { const stat = fs.statSync(snapshotFile); return `${stat.size}:${stat.mtimeMs}`; };
  const before = stamp();
  const read = async () => (await (await fetch(server.origin + '/api/items')).json());

  // 첫 조회는 지라를 기다리지 않는다 — 그 자리에서 파일 값으로 답하고 갱신은 뒤에서 돈다.
  const first = await read();
  assert.equal(first.jiraIssues[0].summary, '파일에서 온 낡은 요약');
  assert.notEqual(first.jiraSync.live, true);

  const deadline = Date.now() + 10000;
  let live = first;
  while (Date.now() < deadline && live.jiraSync.live !== true) {
    await new Promise(resolve => setTimeout(resolve, 50));
    live = await read();
  }
  assert.equal(live.jiraSync.live, true, '뒤에서 돈 갱신이 들어오면 그때부터 지라 값이다');
  assert.equal(live.jiraSync.stale, false, '앱이 직접 읽는 동안에는 `어제 기준` 경고가 뜨지 않는다');
  assert.match(live.jiraSync.liveAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(live.jiraSync.connected, true);
  assert.deepEqual(live.jiraIssues.map(issue => [issue.key, issue.summary, issue.extra, issue.category]), [
    ['IO-12345', '지라에서 바로 읽은 요약', false, 'doing'],
    // 업무에 걸렸지만 내 담당·미완료 목록에는 없는 티켓 — 요약만 쓰는 `그 밖의 이슈`다.
    ['IO-77777', '업무에 걸린 다 끝난 티켓', true, 'done'],
  ]);
  assert.deepEqual(live.jiraIssues[0].versions, [{ name: 'v2.70.0', releaseDate: '2026-09-30', released: false }]);
  assert.equal(live.jiraIssues[0].due, '2026-10-02');
  // 항목의 프로젝트 이름(요약)도 지라에서 온 값이 붙는다(`projectLabelOf`가 같은 목록을 읽는다).
  const task = live.workflows.items.find(item => item.id === 'lv01');
  assert.equal(task.label, 'IO-77777 · 업무에 걸린 다 끝난 티켓');

  const payload = JSON.stringify(live);
  assert.doesNotMatch(payload, /emailAddress|accountId|lubon@live-jira\.test|712020:live/, '담당자 칸은 어디에도 옮기지 않는다');
  assert.doesNotMatch(payload, /fixture-token-never-real|fixture@example\.test/);
  assert.equal(stamp(), before, '조회도 갱신도 스냅샷 파일을 고치지 않는다');

  // 즉시 갱신 주소 — 티켓은 싣지 않고 결과 한 줄만 돌려주고, 여기서도 파일을 쓰지 않는다.
  const listed = await (await fetch(server.origin + '/api/jira/list?fresh=1')).json();
  assert.deepEqual(Object.keys(listed).sort(), ['connected', 'count', 'liveAt', 'ok']);
  assert.deepEqual([listed.ok, listed.connected, listed.count], [true, true, 2]);
  assert.match(listed.liveAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(stamp(), before);
  assert.equal(fs.existsSync(path.join(server.home, '.request-ledger.json')), false, 'GET은 앱 파일도 만들지 않는다');
});

test('지라가 죽어 있으면 스냅샷 파일 값으로 물러서고 낡음 경고도 그대로다', async (t) => {
  const server = await startLiveJiraServer(t, { fail: true });
  const listed = await (await fetch(server.origin + '/api/jira/list?fresh=1')).json();
  assert.deepEqual([listed.ok, listed.connected, listed.count, listed.liveAt], [true, true, 0, null]);
  const data = await (await fetch(server.origin + '/api/items')).json();
  assert.deepEqual(data.jiraIssues.map(issue => [issue.key, issue.summary, issue.extra]), [['IO-12345', '파일에서 온 낡은 요약', false]]);
  assert.equal(data.jiraSync.lastSync, '2026-01-02', '판정은 지금까지처럼 스냅샷 파일 날짜로 한다');
  assert.equal(data.jiraSync.stale, true);
  assert.notEqual(data.jiraSync.live, true);
});

test('GET /api/jira/list는 설정이 없으면 연결 안 됨으로 답하고 아무 파일도 건드리지 않는다', async () => {
  const snapshot = () => fs.readdirSync(directory).sort().map((name) => {
    const stat = fs.statSync(path.join(directory, name));
    return `${name}:${stat.size}:${stat.mtimeMs}`;
  }).join('|');
  const before = snapshot();
  const response = await fetch(`${base}/api/jira/list?fresh=1`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, connected: false, count: 0, liveAt: null });
  assert.equal(snapshot(), before);
  // 인증 예외가 아니다 — 원격에서 토큰 없이 부르면 다른 주소와 똑같이 막힌다(여기서는 로컬이라 열린다).
  assert.equal((await fetch(`${base}/api/jira/list`)).status, 200);
});

// ---------- 완료한 내 티켓도 연결 후보로 (BARCHIVE 1) ----------
// 여기서도 실제 지라에는 닿지 않는다 — 전부 가짜 fetch다.
const jiraDoneIssue = key => ({
  key,
  fields: {
    summary: `${key}의 끝난 일`,
    status: { name: '완료', statusCategory: { key: 'done' } },
    issuetype: { name: '스토리' },
    // 묻지 않은 칸을 지라가 끼워 보내도 앱이 옮기지 않는지 함께 본다.
    assignee: { displayName: '루본', emailAddress: JIRA_EMAIL, accountId: '712020:done' },
  },
});

test('완료한 내 티켓은 최근 90일·완료 범주만, 요약·상태·종류 세 칸만 묻는다', async () => {
  const fake = jiraFake({ '/rest/api/3/search/jql': () => json(jiraListBody([jiraDoneIssue('IO-48394'), { key: '수상한키', fields: {} }])) });
  const issues = await jiraListClient(fake).listDoneIssues(90);
  assert.deepEqual(issues, [{
    key: 'IO-48394', type: '스토리', status: '완료', summary: 'IO-48394의 끝난 일', extra: false,
    // 묻지 않은 칸은 빈 값으로 흐른다(고르는 줄에 쓰지 않는다).
    category: 'done', due: null, versions: [],
  }], '키 형식이 아닌 줄은 버린다');
  assert.equal(fake.calls.length, 1);
  const [call] = fake.calls;
  assert.equal(decodeURIComponent(call.url.split('jql=')[1].split('&')[0]),
    'assignee = currentUser() AND statusCategory = Done AND resolved >= -90d ORDER BY resolved DESC');
  assert.match(call.url, /fields=summary,status,issuetype&maxResults=100$/);
  // 담당자 칸은 애초에 달라고 하지 않는다.
  assert.doesNotMatch(call.url, /assignee&|assignee,|emailAddress|accountId/);
  assert.doesNotMatch(JSON.stringify(issues), /emailAddress|accountId|lubon|루본/);
  assert.doesNotMatch(JSON.stringify(issues), new RegExp(JIRA_EMAIL));
});

test('완료 목록도 100개까지만 들고 오고, 새 search 주소가 없으면 옛 주소로 한 번 물러선다', async () => {
  const many = jiraListBody(Array.from({ length: 140 }, (unused, index) => jiraDoneIssue(`IO-${2000 + index}`)));
  const capped = jiraFake({ '/rest/api/3/search/jql': () => json(many) });
  assert.equal((await jiraListClient(capped).listDoneIssues()).length, 100);
  // 기간을 주지 않거나 말이 안 되는 값이면 기본 90일이다(주소에 그대로 끼우므로 형식을 고정한다).
  assert.match(decodeURIComponent(capped.calls[0].url), /resolved >= -90d/);
  const odd = jiraFake({ '/rest/api/3/search/jql': () => json(jiraListBody([])) });
  await jiraListClient(odd).listDoneIssues(0);
  await jiraListClient(odd).listDoneIssues(9999);
  await jiraListClient(odd).listDoneIssues('90; DROP');
  assert.equal(odd.calls.every(call => decodeURIComponent(call.url).includes('resolved >= -90d')), true);
  await jiraListClient(odd).listDoneIssues(30);
  assert.match(decodeURIComponent(odd.calls[3].url), /resolved >= -30d/);

  const fallback = jiraFake({
    '/rest/api/3/search/jql': () => json({ errorMessages: ['not found'] }, 404),
    '/rest/api/3/search?': () => json(jiraListBody([jiraDoneIssue('IO-48394')])),
  });
  assert.deepEqual((await jiraListClient(fallback).listDoneIssues()).map(issue => issue.key), ['IO-48394']);
  assert.equal(fallback.calls.length, 2, '새 주소가 404일 때만, 옛 주소로 한 번만 물러선다');
});

test('완료 목록 API는 60초 메모리 캐시 한 벌이고, 설정·토큰이 없으면 연결 안 됨으로만 답한다', async () => {
  const fake = jiraFake({ '/rest/api/3/search': () => json(jiraListBody([jiraDoneIssue('IO-48394')])) });
  const off = jiraModule.createJiraApi({ config: {}, request: fake.request });
  assert.deepEqual(await off.listDone(90), { ok: true, connected: false });
  assert.equal(fake.calls.length, 0, '연결되지 않았으면 지라를 부르지 않는다');

  const noToken = jiraModule.createJiraApi({ config: jiraConfig, request: fake.request, readFile: () => '' });
  assert.deepEqual(await noToken.listDone(), { ok: true, connected: false });

  let clock = 0;
  const api = jiraModule.createJiraApi({ config: jiraConfig, request: fake.request, readFile: () => JIRA_TOKEN, now: () => clock });
  const first = await api.listDone(90);
  assert.equal(first.connected, true);
  assert.deepEqual(first.issues.map(issue => issue.key), ['IO-48394']);
  await api.listDone(90);
  assert.equal(fake.calls.length, 1, '60초 안에는 다시 묻지 않는다(키 없이 한 벌)');
  await api.listDone(30);
  assert.equal(fake.calls.length, 2, '기간이 다르면 새로 읽는다');
  clock += 61 * 1000;
  await api.listDone(30);
  assert.equal(fake.calls.length, 3, '60초가 지나면 새로 읽는다');
  assert.doesNotMatch(JSON.stringify(first), new RegExp(`${JIRA_TOKEN}|${JIRA_EMAIL}`), '토큰·이메일은 어디에도 싣지 않는다');

  const broken = jiraModule.createJiraApi({
    config: jiraConfig, readFile: () => JIRA_TOKEN,
    request: jiraFake({ '/rest/api/3/search': () => json({}, 401) }).request,
  });
  assert.deepEqual(await broken.listDone(), { ok: false, error: '지라 토큰을 확인해 주세요.', kind: 'auth' });
});

test('GET /api/jira/done은 설정이 없으면 연결 안 됨으로 답하고, 기간이 이상하면 400이고, 파일을 건드리지 않는다', async () => {
  const snapshot = () => fs.readdirSync(directory).sort().map((name) => {
    const stat = fs.statSync(path.join(directory, name));
    return `${name}:${stat.size}:${stat.mtimeMs}`;
  }).join('|');
  const before = snapshot();
  const response = await fetch(`${base}/api/jira/done?days=90`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, connected: false });
  assert.equal((await fetch(`${base}/api/jira/done`)).status, 200, '기간을 안 보내면 기본 90일이다');
  for (const bad of ['0', '400', '-3', '9.5', 'ninety']) {
    const refused = await fetch(`${base}/api/jira/done?days=${bad}`);
    assert.equal(refused.status, 400, bad);
    assert.equal((await refused.json()).error, '보낸 값을 확인해 주세요.');
  }
  assert.equal(snapshot(), before, 'GET은 어떤 파일도 쓰지 않는다');
});

// ---------- 지난 프로젝트로 보관하기 (BARCHIVE 2) ----------
const archivePost = (origin, body, key) => fetch(origin + '/api/project/archive', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
  body: JSON.stringify(body),
}).then(async response => ({ status: response.status, ...await response.json() }));

test('보관은 앱이 아는 프로젝트만, 키 형식대로만 받고 거절된 요청은 파일을 고치지 않는다', async () => {
  assert.equal((await post('/api/today-task/create', { description: '보관 실험용 업무', group: '보관 실험' })).ok, true);
  const workflowFile = path.join(directory, '.workflow.json');
  const before = fs.readFileSync(workflowFile, 'utf8');
  const refuse = async (body, message) => {
    const answer = await archivePost(base, body);
    assert.equal(answer.status, 400, JSON.stringify(body));
    assert.equal(answer.error, message);
  };
  await refuse({ project: 'group:보관 실험' }, '보관할지 해제할지 알려 주세요.');
  await refuse({ project: 'group:보관 실험', archived: 'true' }, '보관할지 해제할지 알려 주세요.');
  await refuse({ project: '보관 실험', archived: true }, '프로젝트를 확인해 주세요.');
  await refuse({ project: 'jira:io-12345', archived: true }, '프로젝트를 확인해 주세요.');
  await refuse({ project: 'jira:IO-', archived: true }, '프로젝트를 확인해 주세요.');
  await refuse({ project: 'group:없는 프로젝트', archived: true }, '프로젝트를 찾을 수 없어요.');
  assert.equal(fs.readFileSync(workflowFile, 'utf8'), before, '거절된 요청은 파일을 고치지 않는다');
});

test('보관·해제는 프로젝트 키 하나만 저장하고 업무·기록은 하나도 바뀌지 않는다 — 옛 파일도 그대로 읽힌다', async (t) => {
  const server = await startServer(t, (home) => {
    fs.writeFileSync(path.join(home, 'tasks.md'),
      '# Tasks\n- 정산 배치 설계 검토하기 #task[id:ar01 status:to-do created:2026-09-20 group:결제_리뉴얼]\n'
      + '- 게임 임베드 검수하기 #task[id:ar02 status:to-do created:2026-09-20 jira:IO-12345]\n');
    // projectArchive 칸이 없는 옛 파일 — 빈 표로 읽혀야 한다.
    fs.writeFileSync(path.join(home, '.workflow.json'), JSON.stringify({ items: {}, meetings: {} }));
  });
  const read = async () => (await (await fetch(server.base + '/api/items')).json());
  const first = await read();
  assert.deepEqual(first.workflows.projectArchive, {}, '옛 파일은 빈 표로 읽힌다');

  // 파일 표기(`결제_리뉴얼`)와 화면 표기(`결제 리뉴얼`)는 연결과 같은 한 꼴로 맞춘다.
  const archived = await archivePost(server.base, { project: 'group:결제 리뉴얼', archived: true });
  assert.deepEqual(archived, { status: 200, ok: true, project: 'group:결제 리뉴얼', archived: true });
  const after = await read();
  assert.deepEqual(Object.keys(after.workflows.projectArchive), ['group:결제 리뉴얼']);
  assert.match(after.workflows.projectArchive['group:결제 리뉴얼'], /^\d{4}-\d{2}-\d{2}$/, '보관한 날이 함께 남는다');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(server.home, '.workflow.json'), 'utf8')).projectArchive,
    after.workflows.projectArchive);
  // 업무·기록·주간요약은 그대로다 — 바뀌는 것은 화면의 왼쪽 목록 배치뿐이다.
  assert.equal(fs.readFileSync(path.join(server.home, 'tasks.md'), 'utf8'), fs.readFileSync(path.join(server.home, 'tasks.md'), 'utf8'));
  const task = after.laterTasks.concat(after.todayTasks).find(item => item.id === 'ar01');
  assert.deepEqual([task.group, task.jira, task.status], ['결제 리뉴얼', null, 'to-do']);
  assert.deepEqual(first.weeklyReports.map(week => week.draft.rows.length), after.weeklyReports.map(week => week.draft.rows.length));

  // 지라 프로젝트는 키 형식으로만 받는다(이 저장소는 내 담당 목록을 들고 있지 않다).
  assert.equal((await archivePost(server.base, { project: 'jira:IO-12345', archived: true })).ok, true);
  assert.deepEqual(Object.keys((await read()).workflows.projectArchive).sort(), ['group:결제 리뉴얼', 'jira:IO-12345']);

  // 같은 내용을 같은 식별자로 다시 보내면 한 번만 쓴다(기존 idempotency 규칙 그대로).
  const key = 'barchive-idempotency-key-001';
  const send = () => archivePost(server.base, { project: 'group:결제 리뉴얼', archived: false }, key);
  assert.deepEqual(await send(), { status: 200, ok: true, project: 'group:결제 리뉴얼', archived: false });
  assert.deepEqual(await send(), { status: 200, ok: true, project: 'group:결제 리뉴얼', archived: false });
  assert.deepEqual(Object.keys((await read()).workflows.projectArchive), ['jira:IO-12345'], '해제하면 표에서 사라진다');
});

test('복구가 필요한 동안에는 보관도 저장되지 않는다', async (t) => {
  const server = await startServer(t, (home) => {
    fs.writeFileSync(path.join(home, 'tasks.md'), '# Tasks\n- 막힌 저장 #task[id:ar03 status:to-do created:2026-09-20 group:운영툴]\n');
    fs.writeFileSync(path.join(home, '.mutation-journal.json'), journalEntry(path.join(home, 'tasks.md'), '# Tasks\n', '# Tasks\n- 중단된 저장\n'));
    fs.writeFileSync(path.join(home, '.mutation.lock'), String(deadPid()));
  });
  const blocked = await archivePost(server.base, { project: 'group:운영툴', archived: true });
  assert.equal(blocked.status, 503);
  assert.match(blocked.error, /저장을 멈췄어요/);
});

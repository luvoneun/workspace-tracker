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
// 새 버전이 나왔는지 원격에 묻는 것도 끈다 — 테스트가 네트워크에 닿지 않게.
process.env.WORKSPACE_NO_REMOTE_CHECK = '1';
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
  const blocked = ['server.js', 'safe-storage.js', 'jira-client.js', 'jira-live.js', 'attention-live.js', 'report-drafts.js',
    'task-batch.js', 'slack-history.js', 'import-record.js', 'browser-fixture.js', 'migrate.js', 'integrations.js',
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
  assert.equal(fs.readFileSync(path.join(home, 'args.txt'), 'utf8').trim(), '-p 프롬프트 --model sonnet --permission-mode acceptEdits --allowedTools Read,Write');
  assert.equal(runScript(automationScript('run-task.sh'), ['ok', '프롬프트', 'Read,Write'], { ...env, FAKE_EXIT: '7' }).status, 7);
  // 권한 모드·금지 도구는 선택 인자다(슬랙 캡처만 쓴다). 안 주면 위처럼 예전 그대로다.
  assert.equal(runScript(automationScript('run-task.sh'), ['ok', '프롬프트', 'Read', 'manual', 'Write,Edit'], env).status, 0);
  assert.equal(fs.readFileSync(path.join(home, 'args.txt'), 'utf8').trim(), '-p 프롬프트 --model sonnet --permission-mode manual --allowedTools Read --disallowedTools Write,Edit');
  // 모델은 TASK_MODEL로 바꿀 수 있다(계정 기본 모델과 무관하게 자동화 비용을 고정하려는 장치).
  // 로그 문구 개수 단언을 건드리지 않게 다른 이름(ok2)으로 실행한다.
  assert.equal(runScript(automationScript('run-task.sh'), ['ok2', '프롬프트', 'Read,Write'], { ...env, TASK_MODEL: 'opus' }).status, 0);
  assert.equal(fs.readFileSync(path.join(home, 'args.txt'), 'utf8').trim(), '-p 프롬프트 --model opus --permission-mode acceptEdits --allowedTools Read,Write');
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

// 앱의 연동 탭에서 껐는데 자동화가 계속 도는 문제(최종 QA). 두 스크립트 모두 **시작하자마자**
// 설정(`integrations.<키>`)을 node로 읽고, 꺼져 있으면 로그 한 줄만 남기고 끝낸다.
test('연동을 끄면 run-task.sh·slack-capture.sh는 claude를 부르지 않고 건너뛴다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-intg-off-'));
  const logs = path.join(home, 'logs');
  const called = path.join(home, 'called.txt');
  const claude = path.join(home, 'fake-claude.sh');
  writeExec(claude, `#!/bin/bash\necho "불렸음" >> ${JSON.stringify(called)}\n`);
  const config = path.join(home, 'workspace.config.json');
  const env = {
    WORKSPACE_DIR: home, WORKSPACE_CONFIG: config, AUTOMATION_LOG_DIR: logs,
    CLAUDE_BIN: claude, SLACK_CAPTURE_IGNORE_HOURS: '1',
  };
  const logOf = name => fs.readFileSync(path.join(logs, `${name}.log`), 'utf8');
  const task = name => runScript(automationScript('run-task.sh'), [name, '프롬프트', 'Read'], env);

  // 1) 껐으면 곧바로 끝난다 — 시작 줄도 남기지 않고 claude도 부르지 않는다
  fs.writeFileSync(config, JSON.stringify({ integrations: { jira: false, calendar: false, tiro: false, slack: false } }));
  for (const name of ['jira-sync', 'calendar-sync', 'tiro-sync']) {
    assert.equal(task(name).status, 0, `${name}은 꺼져 있으면 조용히 끝난다`);
    assert.match(logOf(name), new RegExp(`${name} 연동이 꺼져 있어 건너뛰어요`));
    assert.doesNotMatch(logOf(name), /시작$/m);
  }
  assert.equal(runScript(automationScript('slack-capture.sh'), [], env).status, 0);
  assert.match(logOf('slack-capture'), /슬랙 수집이 꺼져 있어 건너뛰어요/);
  assert.equal(fs.existsSync(called), false, '꺼진 자동화는 claude를 부르지 않는다');

  // 2) 표에 없는 작업 이름은 검사하지 않고 예전 그대로 돈다
  assert.equal(task('envok').status, 0);
  assert.match(logOf('envok'), /envok 종료 \(exit 0\)/);
  assert.equal(fs.readFileSync(called, 'utf8').trim(), '불렸음');

  // 3) 칸이 없으면 켜진 것이다(옛 설정 파일) — 설정이 아예 없어도 같다
  fs.writeFileSync(config, JSON.stringify({ integrations: { slack: true } }));
  assert.equal(task('jira-sync').status, 0);
  assert.match(logOf('jira-sync'), /jira-sync 종료 \(exit 0\)/);
  fs.rmSync(config, { force: true });
  assert.equal(task('calendar-sync').status, 0);
  assert.match(logOf('calendar-sync'), /calendar-sync 종료 \(exit 0\)/, '설정을 못 읽으면 예전처럼 그냥 돈다');
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
      assignee: { displayName: '하늘', emailAddress: 'elly@example.test', accountId: '712020:aaaa' },
      fixVersions: [],
    },
  },
] };
// `children.items` 한 줄의 기대 모양 — 담당은 표시 이름, 배포 버전은 이름뿐이다.
const jiraChildItems = [
  { key: 'IO-48395', url: `${JIRA_SITE}/browse/IO-48395`, summary: '임베드 카드 붙이기', type: '하위 작업', status: { name: '완료', category: 'done' }, assignee: '루본', version: 'v2.70.0' },
  { key: 'IO-48396', url: `${JIRA_SITE}/browse/IO-48396`, summary: '임베드 미리보기 붙이기', type: '하위 작업', status: { name: '완료', category: 'done' }, assignee: null, version: null },
  { key: 'IO-48397', url: `${JIRA_SITE}/browse/IO-48397`, summary: '게임 목록 불러오기', type: '하위 작업', status: { name: '진행 중', category: 'doing' }, assignee: '하늘', version: null },
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
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

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

// ---------- 직접 만든 프로젝트 → 지라 에픽으로 옮기기 (BMOVE) ----------
// 항목·회의·주간요약 소속을 한 트랜잭션으로 지라 에픽 쪽으로 옮긴다. renameProject와 같은 자리를
// 건드리되, 그룹 칸을 지우고 지라 칸을 새로 넣는다는 점이 다르다. 여기서도 실제 지라에는 닿지
// 않는다 — 서버는 자기 임시 폴더의 가짜 설정·가짜 토큰을 쓰고, 지라로 나가는 fetch는 자식 프로세스
// 안의 가짜 응답이 전부 가로챈다.
const movePost = (origin, body, key) => fetch(origin + '/api/project/move', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
  body: JSON.stringify(body),
}).then(async response => ({ status: response.status, ...await response.json() }));
const moveUndoPost = (origin, body) => fetch(origin + '/api/project/move-undo', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then(async response => ({ status: response.status, ...await response.json() }));

const JIRA_MOVE_SITE = 'https://move-jira.test';
const MOVE_TYPES = { issueTypes: [
  { id: '10000', name: '에픽', subtask: false, hierarchyLevel: 1 },
  { id: '10001', name: '작업', subtask: false, hierarchyLevel: 0 },
  { id: '10101', name: '하위 작업', subtask: true, hierarchyLevel: -1 },
] };
// IO-48501은 에픽, IO-9002는 에픽이 아닌 스토리 — "에픽만" 검증에 쓴다. IO-99999는 아예 모르는
// 티켓이라(못 읽음) 검증에 쓴다.
const MOVE_KNOWN = {
  'IO-48501': { summary: '결제 리뉴얼 v2', typeId: '10000' },
  'IO-9002': { summary: '알림센터 스토리', typeId: '10001' },
};
// `direct`는 복구(BRECOVERY) 테스트만 쓴다 — server.js를 `require()`로 빌려 쓰면(다른 BMOVE 서버들과
// 같은 방식) `require.main === module`이 거짓이라 시작할 때 도는 `mutations.recover()`가 통째로
// 건너뛰어진다(서버가 그 검사로 "지금 막 시작했을 때"를 가려서다). 복구가 실제로 걸리는지 보려면
// server.js를 **그대로 진입점**으로 띄우고, 가짜 지라는 `--require` 미리 불러오기로 fetch만 바꿔치기한다.
async function startMoveJiraServer(t, seed, { direct = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-jiramove-'));
  seed(home);
  const tokenFile = path.join(home, '.jira_token_fixture');
  fs.writeFileSync(tokenFile, 'fixture-token-never-real\n');
  const config = path.join(home, 'workspace.config.json');
  fs.writeFileSync(config, JSON.stringify({ jira: { siteUrl: JIRA_MOVE_SITE, email: 'fixture@example.test', tokenFile } }));
  const fetchPatch = `'use strict';
const SITE = ${JSON.stringify(JIRA_MOVE_SITE)};
const KNOWN = ${JSON.stringify(MOVE_KNOWN)};
const TYPES = ${JSON.stringify(MOVE_TYPES)};
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input && input.url ? input.url : input);
  if (!url.startsWith(SITE)) return realFetch(input, init);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (url.includes('/issue/createmeta/')) return json(TYPES);
  const hit = url.match(/\\/rest\\/api\\/3\\/issue\\/([A-Z][A-Z0-9]*-\\d+)/);
  if (hit && KNOWN[hit[1]]) return json({ fields: { summary: KNOWN[hit[1]].summary, issuetype: { id: KNOWN[hit[1]].typeId } } });
  if (hit) return json({ errorMessages: ['no issue'] }, 404);
  return json({ issues: [] });
};
`;
  const port = await freePort();
  let child;
  if (direct) {
    const preload = path.join(home, 'fake-jira-move-preload.js');
    fs.writeFileSync(preload, fetchPatch);
    child = spawn(process.execPath, ['--require', preload, path.join(__dirname, 'server.js')], {
      env: { ...process.env, WORKSPACE_DATA_DIR: home, WORKSPACE_PORT: String(port), WORKSPACE_NO_OPEN: '1', WORKSPACE_HOST: '', WORKSPACE_CONFIG: config },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } else {
    const wrapper = path.join(home, 'fake-jira-move-server.js');
    fs.writeFileSync(wrapper, `${fetchPatch}
const { server } = require(${JSON.stringify(path.join(__dirname, 'server.js'))});
server.listen(Number(process.env.WORKSPACE_PORT), '127.0.0.1', () => console.log('ready'));
`);
    child = spawn(process.execPath, [wrapper], {
      env: { ...process.env, WORKSPACE_DATA_DIR: home, WORKSPACE_PORT: String(port), WORKSPACE_NO_OPEN: '1', WORKSPACE_HOST: '', WORKSPACE_CONFIG: config },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
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

const MOVE_REPORT = {
  schema: 1,
  weeks: {
    '2026-09-14': {
      rows: [
        { id: 'r1', heading: '완료한 일', group: '결제 리뉴얼', bucket: 'group:결제 리뉴얼:완료한 일:정산 배치',
          text: '정산 배치 설계 검토함', sourceIds: ['mv02'],
          evidence: [{ id: 'mv02', description: '완료한 정산 작업', status: 'done', type: 'task', outcome: '', label: '결제 리뉴얼', permalink: null }],
          locked: true, excluded: false },
        { id: 'r2', heading: '진행중', group: '운영툴', bucket: 'group:운영툴:진행중:운영툴 대시보드',
          text: '운영툴 대시보드 개선', sourceIds: [], evidence: [], locked: true, excluded: false },
      ],
      updatedAt: '2026-09-20T00:00:00.000Z',
    },
  },
};
function seedMove(home, report = MOVE_REPORT) {
  fs.writeFileSync(path.join(home, 'tasks.md'), '# Tasks\n'
    + '- 정산 배치 설계 검토하기 #task[id:mv01 status:to-do priority:high created:2026-09-20 group:결제_리뉴얼]\n'
    + '- 완료한 정산 작업 #task[id:mv02 status:done priority:medium created:2026-09-18 completed:2026-09-19 group:결제_리뉴얼]\n'
    + '- 게임 임베드 검수하기 #task[id:mv03 status:to-do priority:medium created:2026-09-20 jira:IO-9999]\n'
    + '- 대시보드 지표 정리하기 #task[id:mv06 status:to-do priority:medium created:2026-09-20 group:운영툴]\n');
  fs.writeFileSync(path.join(home, 'checks.md'), '# Checks\n'
    + '- 법무 검토 회신 #check[id:mv04 status:to-do priority:medium created:2026-09-20 who:하늘 group:결제_리뉴얼]\n');
  fs.writeFileSync(path.join(home, 'decisions.md'), '# Decisions\n'
    + '- 정산 주기는 주 단위로 한다 #decision[id:mv05 status:to-do priority:medium created:2026-09-20 group:결제_리뉴얼]\n');
  fs.writeFileSync(path.join(home, 'ideas.md'), '# Ideas\n'
    + '- 정산 리포트 자동화 #idea[id:mv07 status:to-do priority:low created:2026-09-20 project:결제_리뉴얼]\n');
  fs.writeFileSync(path.join(home, '.workflow.json'), JSON.stringify({
    items: {}, meetings: {
      m1: { id: 'm1', date: '2026-09-20', start: '10:00', end: '11:00', title: '결제 주간 싱크', series: '결제 주간 싱크', link: null,
        project: { type: 'group', value: '결제 리뉴얼', label: '결제 리뉴얼' } },
      m2: { id: 'm2', date: '2026-09-19', start: '14:00', end: '15:00', title: '운영 회의', series: '운영 회의', link: null,
        project: { type: 'group', value: '운영툴', label: '운영툴' } },
    },
    projectLinks: { '결제 리뉴얼': 'IO-1111' },
  }, null, 2));
  fs.writeFileSync(path.join(home, '.meeting_links.json'), JSON.stringify({ '결제 주간 싱크': 'group:결제 리뉴얼', '운영 회의': 'group:운영툴' }, null, 2));
  fs.writeFileSync(path.join(home, '.report-drafts.json'), JSON.stringify(report, null, 2));
}

test('BMOVE: 검증 — 직접 만든 프로젝트만, 에픽만, 읽을 수 있을 때만, 있는 그룹만 옮길 수 있다', async (t) => {
  const server = await startMoveJiraServer(t, seedMove);
  const refuse = async (body, message) => {
    const answer = await movePost(server.origin, body);
    assert.equal(answer.status, 400, JSON.stringify(body));
    assert.equal(answer.error, message, JSON.stringify(body));
  };
  // 직접 만든 프로젝트만(group:이 아니면).
  await refuse({ project: 'jira:IO-9999', to: 'IO-48501' }, '직접 만든 프로젝트만 옮길 수 있어요.');
  await refuse({ project: '결제 리뉴얼', to: 'IO-48501' }, '직접 만든 프로젝트만 옮길 수 있어요.');
  // 지라 번호 형식.
  await refuse({ project: 'group:결제 리뉴얼', to: 'io-48501' }, '지라 번호를 확인해 주세요.');
  await refuse({ project: 'group:결제 리뉴얼', to: '' }, '지라 번호를 확인해 주세요.');
  // 에픽만(IO-9002는 스토리).
  await refuse({ project: 'group:결제 리뉴얼', to: 'IO-9002' }, '에픽에만 옮길 수 있어요.');
  // 지라에서 읽을 수 있을 때만(IO-99999는 가짜 지라가 모른다).
  await refuse({ project: 'group:결제 리뉴얼', to: 'IO-99999' }, '지라에서 이 티켓을 읽지 못했어요.');
  // 있는 그룹만.
  await refuse({ project: 'group:없는 프로젝트', to: 'IO-48501' }, '프로젝트를 찾을 수 없어요.');

  // 전부 거절됐으니 어떤 파일도 바뀌지 않는다.
  assert.match(fs.readFileSync(path.join(server.home, 'tasks.md'), 'utf8'), /group:결제_리뉴얼\]/);
  assert.equal(fs.existsSync(path.join(server.home, '.mutation-journal.json')), false);
});

test('BMOVE: 옮기면 항목·회의·연결·주간요약이 한 트랜잭션으로 지라 쪽으로 넘어가고 그룹은 저절로 사라진다', async (t) => {
  const server = await startMoveJiraServer(t, seedMove);
  const answer = await movePost(server.origin, { project: 'group:결제 리뉴얼', to: 'IO-48501' });
  assert.equal(answer.status, 200);
  assert.equal(answer.ok, true);
  assert.equal(answer.project, 'jira:IO-48501');
  assert.equal(answer.from, '결제 리뉴얼');
  assert.equal(answer.to, 'IO-48501');
  assert.match(answer.moveId, /^mv_/);
  assert.deepEqual(answer.changed, { items: 5, meetings: 2, links: 1, report: 1 });

  // ① 업무 파일 — 지라가 걸린 줄(mv03)과 다른 그룹(mv06)은 그대로, 나머지 넷은 jira:IO-48501로.
  const tasks = fs.readFileSync(path.join(server.home, 'tasks.md'), 'utf8');
  assert.match(tasks, /정산 배치 설계 검토하기 #task\[id:mv01 status:to-do priority:high created:2026-09-20 jira:IO-48501\]/);
  assert.doesNotMatch(tasks, /id:mv01[^\n]*group:/);
  assert.match(tasks, /완료한 정산 작업 #task\[id:mv02 status:done priority:medium created:2026-09-18 completed:2026-09-19 jira:IO-48501\]/);
  assert.match(tasks, /id:mv03 status:to-do priority:medium created:2026-09-20 jira:IO-9999\]/, '이미 지라가 걸린 줄은 그대로다');
  assert.match(tasks, /id:mv06[^\n]*group:운영툴\]/, '다른 그룹은 그대로다');
  assert.match(fs.readFileSync(path.join(server.home, 'checks.md'), 'utf8'), /id:mv04 status:to-do priority:medium created:2026-09-20 who:하늘 jira:IO-48501\]/);
  assert.match(fs.readFileSync(path.join(server.home, 'decisions.md'), 'utf8'), /id:mv05 status:to-do priority:medium created:2026-09-20 jira:IO-48501\]/);
  assert.match(fs.readFileSync(path.join(server.home, 'ideas.md'), 'utf8'), /id:mv07 status:to-do priority:low created:2026-09-20 jira:IO-48501\]/, '아이디어도 project: 대신 jira:로 옮긴다');

  // ②③ 회의 프로젝트 · 수동 지라 연결(옮긴 뒤에는 뜻이 없어 지운다)
  const workflow = readJson(path.join(server.home, '.workflow.json'));
  assert.deepEqual(workflow.meetings.m1.project, { type: 'jira', value: 'IO-48501', label: 'IO-48501' });
  assert.deepEqual(workflow.meetings.m2.project, { type: 'group', value: '운영툴', label: '운영툴' });
  assert.deepEqual(workflow.projectLinks, {});

  // ④ 회의 제목 → 프로젝트 표
  assert.deepEqual(readJson(path.join(server.home, '.meeting_links.json')), { '결제 주간 싱크': 'jira:IO-48501', '운영 회의': 'group:운영툴' });

  // ⑤ 주간요약 저장본 — group:결제 리뉴얼: 행만 jira:IO-48501: 꼴로, 이름은 방금 읽은 지라 요약으로.
  const rows = readJson(path.join(server.home, '.report-drafts.json')).weeks['2026-09-14'].rows;
  const r1 = rows.find(row => row.id === 'r1');
  assert.equal(r1.group, 'IO-48501 · 결제 리뉴얼 v2');
  assert.equal(r1.bucket, 'jira:IO-48501:완료한 일:정산 배치');
  assert.equal(r1.evidence[0].label, 'IO-48501 · 결제 리뉴얼 v2');
  assert.equal(r1.text, '정산 배치 설계 검토함', '보고 문장은 손대지 않는다');
  const r2 = rows.find(row => row.id === 'r2');
  assert.deepEqual([r2.group, r2.bucket], ['운영툴', 'group:운영툴:진행중:운영툴 대시보드']);

  // ⑥ 이동 기록은 저장은 되지만 화면(snapshot)에는 내려보내지 않는다.
  assert.ok(Array.isArray(workflow.projectMoves) && workflow.projectMoves.length === 1);
  const record = workflow.projectMoves[0];
  assert.equal(record.id, answer.moveId);
  assert.equal(record.from, '결제 리뉴얼');
  assert.equal(record.to, 'IO-48501');
  assert.deepEqual([...record.items].sort(), ['mv01', 'mv02', 'mv04', 'mv05', 'mv07']);
  assert.deepEqual(record.meetings, ['m1']);
  assert.deepEqual(record.links, { '결제 리뉴얼': 'IO-1111' });
  assert.deepEqual(record.meetingLinks, ['결제 주간 싱크']);
  assert.deepEqual(record.reportRows, ['r1']);

  // 그룹은 항목이 하나도 안 남아 화면 목록에서 저절로 사라진다.
  const data = await (await fetch(server.origin + '/api/items')).json();
  assert.ok(!data.customGroups.includes('결제 리뉴얼') && data.customGroups.includes('운영툴'));
  assert.equal(data.workflows.projectMoves, undefined, '이동 기록은 화면에 내려보내지 않는다');
});

test('BMOVE: 한 자리라도 실패하면 전부 되돌아간다 — 업무 파일까지 쓴 뒤 되돌린 것이다', async (t) => {
  const server = await startMoveJiraServer(t, home => seedMove(home, { schema: 2, weeks: {} }));
  const files = ['tasks.md', 'checks.md', 'decisions.md', 'ideas.md', '.workflow.json', '.meeting_links.json', '.report-drafts.json'];
  const before = files.map(name => fs.readFileSync(path.join(server.home, name), 'utf8'));

  const failed = await movePost(server.origin, { project: 'group:결제 리뉴얼', to: 'IO-48501' });
  assert.equal(failed.status, 400);
  assert.match(failed.error, /보고 기록 형식을 확인해 주세요/);
  assert.deepEqual(files.map(name => fs.readFileSync(path.join(server.home, name), 'utf8')), before);

  assert.equal((await (await fetch(server.origin + '/api/storage-status')).json()).recoveryNeeded, false, '되돌리기가 받아들여져 저장은 잠기지 않는다');
  fs.writeFileSync(path.join(server.home, '.report-drafts.json'), JSON.stringify(MOVE_REPORT, null, 2));
  assert.equal((await movePost(server.origin, { project: 'group:결제 리뉴얼', to: 'IO-48501' })).ok, true, '형식을 고친 뒤에는 통한다');
});

test('BMOVE: 복구가 필요한 동안에는 옮기지 않는다', async (t) => {
  const server = await startMoveJiraServer(t, (home) => {
    seedMove(home);
    fs.writeFileSync(path.join(home, '.mutation-journal.json'), journalEntry(path.join(home, 'tasks.md'), '# Tasks\n', '# Tasks\n- 중단된 저장\n'));
    fs.writeFileSync(path.join(home, '.mutation.lock'), String(deadPid()));
  }, { direct: true });
  const blocked = await movePost(server.origin, { project: 'group:결제 리뉴얼', to: 'IO-48501' });
  assert.equal(blocked.status, 503);
  assert.match(blocked.error, /저장을 멈췄어요/);
  assert.match(fs.readFileSync(path.join(server.home, 'tasks.md'), 'utf8'), /group:결제_리뉴얼\]/);
});

test('BMOVE: 이동 기록은 최근 20개만 남긴다', async (t) => {
  const server = await startMoveJiraServer(t, (home) => {
    seedMove(home);
    const workflow = readJson(path.join(home, '.workflow.json'));
    workflow.projectMoves = Array.from({ length: 20 }, (unused, index) => ({ id: `mv_old${index}`, from: `옛 프로젝트${index}`, to: 'IO-0', at: '2026-09-01T00:00:00.000Z', items: [], meetings: [], links: null, meetingLinks: [], reportRows: [], reportLabel: 'IO-0', counts: { items: 0, meetings: 0, report: 0 } }));
    fs.writeFileSync(path.join(home, '.workflow.json'), JSON.stringify(workflow, null, 2));
  });
  const answer = await movePost(server.origin, { project: 'group:결제 리뉴얼', to: 'IO-48501' });
  assert.equal(answer.ok, true);
  const moves = readJson(path.join(server.home, '.workflow.json')).projectMoves;
  assert.equal(moves.length, 20, '가장 오래된 기록을 밀어내고 20개만 유지한다');
  assert.equal(moves[0].id, 'mv_old1', '가장 오래된 것(mv_old0)이 밀려난다');
  assert.equal(moves[19].id, answer.moveId);
});

test('BMOVE: 되돌리기는 기록에 있는 그 대상만 반대로 옮기고, 한 번만 된다', async (t) => {
  const server = await startMoveJiraServer(t, seedMove);
  const files = ['tasks.md', 'checks.md', 'decisions.md', 'ideas.md', '.meeting_links.json', '.report-drafts.json'];
  const before = files.map(name => fs.readFileSync(path.join(server.home, name), 'utf8'));
  const workflowBefore = readJson(path.join(server.home, '.workflow.json'));

  const moved = await movePost(server.origin, { project: 'group:결제 리뉴얼', to: 'IO-48501' });
  assert.equal(moved.ok, true);
  const undone = await moveUndoPost(server.origin, { moveId: moved.moveId });
  assert.equal(undone.status, 200);
  assert.deepEqual(undone, { status: 200, ok: true, project: 'group:결제 리뉴얼', restored: { items: 5, meetings: 2, report: 1 }, skipped: 0 });
  assert.deepEqual(files.map(name => fs.readFileSync(path.join(server.home, name), 'utf8')), before, '옮기기 전과 글자 하나까지 같다');
  // .workflow.json은 meetings·projectLinks가 옮기기 전과 같다 — 이동 기록(`projectMoves`)만 빈 배열로
  // 남는다(비운 기록도 한 번 만들어진 칸은 다른 표(반응 필요 치우기 등)처럼 지우지 않고 둔다).
  const workflowAfter = readJson(path.join(server.home, '.workflow.json'));
  assert.deepEqual(workflowAfter.meetings, workflowBefore.meetings);
  assert.deepEqual(workflowAfter.projectLinks, workflowBefore.projectLinks);
  assert.deepEqual(workflowAfter.projectMoves, []);

  // 한 번 되돌리면 기록이 지워져 다시는 되돌릴 수 없다.
  const again = await moveUndoPost(server.origin, { moveId: moved.moveId });
  assert.equal(again.status, 400);
  assert.match(again.error, /되돌릴 기록이 없어요/);
  const missing = await moveUndoPost(server.origin, { moveId: 'mv_없는것' });
  assert.equal(missing.status, 400);
  assert.match(missing.error, /되돌릴 기록이 없어요/);
});

test('BMOVE: 옮긴 뒤 그 에픽에 새로 생긴 항목·다시 바뀐 회의는 되돌리기가 건드리지 않는다', async (t) => {
  const server = await startMoveJiraServer(t, seedMove);
  const moved = await movePost(server.origin, { project: 'group:결제 리뉴얼', to: 'IO-48501' });
  assert.equal(moved.ok, true);

  // 이 에픽에 새로 생긴 항목 — 이동 기록에는 없는 id다.
  const created = await fetch(server.origin + '/api/today-task/create', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description: '옮긴 뒤 새로 생긴 일', jira: 'IO-48501' }),
  }).then(r => r.json());
  assert.equal(created.ok, true);

  // 회의 m1은 옮긴 뒤 이미 다른 지라 키로 다시 바뀌었다고 가정한다(그 사이 사람이 손으로 바꿈).
  const workflow = readJson(path.join(server.home, '.workflow.json'));
  workflow.meetings.m1.project = { type: 'jira', value: 'IO-9002', label: 'IO-9002' };
  fs.writeFileSync(path.join(server.home, '.workflow.json'), JSON.stringify(workflow, null, 2));

  const undone = await moveUndoPost(server.origin, { moveId: moved.moveId });
  assert.equal(undone.ok, true);
  assert.equal(undone.restored.items, 5, '기록에 있던 항목은 그대로 되돌아간다');
  assert.equal(undone.restored.meetings, 1, 'm1은 건너뛰고 회의 제목 표(m1 아닌 결제 주간 싱크)만 돌아간다');
  assert.equal(undone.skipped, 1, 'm1 하나는 건너뛴다');

  // 새로 생긴 항목은 그대로 지라에 남는다.
  const data = await (await fetch(server.origin + '/api/items')).json();
  const survivor = [...data.todayTasks, ...data.laterTasks].find(item => item.id === created.id);
  assert.equal(survivor.jira, 'IO-48501');
  // m1은 사람이 다시 바꾼 값(IO-9002) 그대로 남는다 — undo가 덮어쓰지 않는다.
  assert.deepEqual(readJson(path.join(server.home, '.workflow.json')).meetings.m1.project, { type: 'jira', value: 'IO-9002', label: 'IO-9002' });
});

// ---------- 지라에 새로 만들기 (BJCREATE — 지라에 이슈를 만든다) ----------
// 여기서도 실제 지라에는 절대 닿지 않는다: 모든 요청은 가짜 fetch가 받아 기록만 한다.
// `무엇이 만들어졌는가`는 기록된 method·본문으로 판정한다(GET만 나갔으면 아무것도 만들지 않은 것이다).
// 확정된 값 그대로다: 에픽 10000(계층 1) · 작업 10001 · 스토리 10003 · 버그 10004 · 하위 작업은 계층 -1.
const jiraCreateTypes = { issueTypes: [
  { id: '10000', name: '에픽', subtask: false, hierarchyLevel: 1 },
  { id: '10001', name: '작업', subtask: false, hierarchyLevel: 0 },
  { id: '10003', name: '스토리', subtask: false, hierarchyLevel: 0 },
  { id: '10004', name: '버그', subtask: false, hierarchyLevel: 0 },
  { id: '10101', name: '하위 작업', subtask: true, hierarchyLevel: -1 },
] };
// BJASSIGN — 새로 만든 에픽만 이 계정으로 배정한다(하위 티켓은 배정을 아예 시도하지 않는다).
const JIRA_CREATE_ME = 'fixture-create-me-account';
// 만들기 요청을 차례대로 받아 새 키를 내주는 가짜 지라. `refuse`에 적은 요약은 그 상태로 거절한다.
// `mineId`가 null이면 `/myself`가 401을 돌려주고(누가 나인지 조회 실패), `assignStatus`가 204가
// 아니면 에픽 배정(`PUT .../assignee`)이 그 상태로 거절된다.
function jiraMakeFake({ types = jiraCreateTypes, refuse = {}, epic = null, mineId = JIRA_CREATE_ME, assignStatus = 204 } = {}) {
  let next = 48400;
  const made = [];
  const assigned = [];
  const fake = jiraFake({
    '/issue/createmeta': () => json(types),
    '/rest/api/3/myself': () => (mineId ? json({ accountId: mineId }) : json({}, 401)),
    // 이미 있는 에픽을 대조할 때 읽는 자리(요약과 종류 id만 묻는다)
    '/rest/api/3/issue/IO-': () => (epic ? json({ fields: { summary: epic.summary, issuetype: { id: epic.typeId } } }) : json({ errorMessages: ['no issue'] }, 404)),
  });
  const request = async (url, options) => {
    const method = (options && options.method) || 'GET';
    if (method === 'POST' && String(url).endsWith('/rest/api/3/issue')) {
      const sent = JSON.parse(options.body);
      fake.calls.push({ url, headers: options.headers, method, body: sent });
      const summary = sent.fields.summary;
      if (refuse[summary]) return json({ errorMessages: ['refused'] }, refuse[summary]);
      next += 1;
      const key = `IO-${next}`;
      made.push({ key, summary, parent: sent.fields.parent ? sent.fields.parent.key : null, type: sent.fields.issuetype.id });
      return json({ id: '1', key });
    }
    if (method === 'PUT' && String(url).endsWith('/assignee')) {
      const sent = JSON.parse(options.body);
      fake.calls.push({ url, headers: options.headers, method, body: sent });
      if (assignStatus !== 204) return json({ errorMessages: ['assign refused'] }, assignStatus);
      assigned.push({ url, accountId: sent.accountId });
      return new Response(null, { status: 204 });
    }
    return fake.request(url, options);
  };
  return { request, calls: fake.calls, made, assigned };
}
const jiraMakeApi = (fake, extra = {}) => jiraModule.createJiraApi({ config: jiraConfig, request: fake.request, readFile: () => JIRA_TOKEN, ...extra });

test('BJCREATE: 만들 수 있는 종류는 계층으로 가른다 — 에픽은 계층 1, 하위 후보는 표준 타입뿐', () => {
  const shaped = jiraModule.shapeCreateTypes(jiraCreateTypes);
  assert.deepEqual(shaped.map(type => [type.id, type.level]), [['10000', 1], ['10001', 0], ['10003', 0], ['10004', 0], ['10101', -1]]);
  assert.equal(jiraModule.epicTypeOf(shaped).id, '10000', '이름이 아니라 계층 1로 고른다');
  assert.deepEqual(jiraModule.childTypesOf(shaped).map(type => type.id), ['10001', '10003', '10004'], '하위 작업(subtask)은 쓰지 않는다');
  assert.equal(jiraModule.defaultChildType(shaped).id, '10001', '기본은 이름에 `작업`/`Task`가 있는 것');
  // 옛 주소의 모양(projects[0].issuetypes)도 같은 결과로 편다. `hierarchyLevel`이 없으면 subtask로만 가른다.
  const old = jiraModule.shapeCreateTypes({ projects: [{ key: 'IO', issuetypes: [
    { id: '10000', name: 'Epic', subtask: false },
    { id: '10002', name: 'Task', subtask: false },
    { id: '10101', name: 'Sub-task', subtask: true },
  ] }] });
  assert.deepEqual(old.map(type => [type.id, type.level]), [['10000', 0], ['10002', 0], ['10101', -1]]);
  assert.equal(jiraModule.defaultChildType(old).id, '10002');
  assert.equal(jiraModule.shapeCreateTypes({}).length, 0, '모르는 모양이 와도 빈 목록으로 흐른다');
});

test('BJCREATE: create-meta는 새 주소를 먼저 부르고 없으면 옛 주소로 한 번 물러서며 60초 캐시한다', async () => {
  const fallback = jiraFake({
    '/issue/createmeta/IO/issuetypes': () => json({ errorMessages: ['not found'] }, 404),
    '/issue/createmeta?projectKeys=IO': () => json({ projects: [{ key: 'IO', issuetypes: jiraCreateTypes.issueTypes }] }),
  });
  const fellBack = await jiraMakeApi(fallback).createMeta('IO');
  assert.equal(fellBack.ok, true);
  assert.deepEqual(fellBack.types.map(type => type.name), ['작업', '스토리', '버그']);
  assert.deepEqual(fellBack.epic, { id: '10000', name: '에픽' });
  assert.equal(fellBack.defaultTypeId, '10001');
  assert.equal(fallback.calls.length, 2);

  let clock = 1000;
  const fake = jiraFake({ '/issue/createmeta': () => json(jiraCreateTypes) });
  const api = jiraMakeApi(fake, { now: () => clock });
  await api.createMeta('IO');
  await api.createMeta('IO');
  assert.equal(fake.calls.length, 1, '60초 안에는 다시 부르지 않는다');
  await api.createMeta('PAY');
  assert.equal(fake.calls.length, 2, '캐시는 프로젝트마다 따로다');
  clock += 61 * 1000;
  await api.createMeta('IO');
  assert.equal(fake.calls.length, 3, '60초가 지나면 다시 읽는다');
  // 프로젝트 키 형식은 API에서도 막는다(지라를 부르지 않는다).
  assert.deepEqual(await api.createMeta('io-1'), { ok: false, error: '지라 번호를 확인해 주세요.', kind: 'key' });
  assert.equal(fake.calls.length, 3);
  // 돌려주는 값 어디에도 토큰·이메일이 없다.
  const payload = JSON.stringify(await api.createMeta('IO'));
  assert.doesNotMatch(payload, new RegExp(JIRA_TOKEN));
  assert.doesNotMatch(payload, new RegExp(JIRA_EMAIL));
});

test('BJCREATE: 에픽을 먼저 만들고 하위를 차례대로 그 에픽에 붙인다 — 보내는 칸은 넷뿐이다', async () => {
  const fake = jiraMakeFake();
  const result = await jiraMakeApi(fake).create({ plan: {
    projectKey: 'IO',
    epic: { summary: '게시글 작성하기_게임 임베드' },
    children: [
      { summary: '[Web] 게시글 작성하기_게임 임베드', issueTypeId: '10001' },
      { summary: '[QA] 게시글 작성하기_게임 임베드', issueTypeId: '10001' },
    ],
  } });
  assert.equal(result.ok, true);
  assert.equal(result.made, 3);
  assert.equal(result.failed, 0);
  assert.equal(result.epic.created, true);
  assert.equal(result.epic.url, `${JIRA_SITE}/browse/${result.epic.key}`);
  assert.deepEqual(result.children.map(child => child.summary), ['[Web] 게시글 작성하기_게임 임베드', '[QA] 게시글 작성하기_게임 임베드']);
  // 순서: 종류 조회(GET) → 에픽 → 하위 둘. 하위는 모두 그 에픽을 부모로 단다.
  assert.deepEqual(fake.made.map(entry => [entry.summary, entry.parent, entry.type]), [
    ['게시글 작성하기_게임 임베드', null, '10000'],
    ['[Web] 게시글 작성하기_게임 임베드', result.epic.key, '10001'],
    ['[QA] 게시글 작성하기_게임 임베드', result.epic.key, '10001'],
  ]);
  const posts = fake.calls.filter(call => call.method === 'POST');
  assert.equal(posts.length, 3);
  assert.deepEqual(Object.keys(posts[1].body.fields).sort(), ['issuetype', 'parent', 'project', 'summary']);
  assert.deepEqual(posts[0].body.fields.project, { key: 'IO' });
  // 쓰기 직전에 만들 수 있는 종류를 **다시 읽어** 대조한다.
  assert.match(fake.calls[0].url, /\/issue\/createmeta\/IO\/issuetypes/);
  assert.equal(fake.calls[0].method, 'GET');
  // 응답과 요청 어디에도 토큰·이메일이 없다.
  assert.doesNotMatch(JSON.stringify(result), new RegExp(`${JIRA_TOKEN}|${JIRA_EMAIL}`));
  assert.doesNotMatch(fake.calls.map(call => call.url).join(' '), new RegExp(`${JIRA_TOKEN}|${JIRA_EMAIL}`));
});

test('BJCREATE: 하위 하나가 실패해도 다음은 계속하고, 실패한 줄만 이유를 달고 온다', async () => {
  const fake = jiraMakeFake({ refuse: { '[Android] 임베드': 400, '[QA] 임베드': 403 } });
  const result = await jiraMakeApi(fake).create({ plan: {
    projectKey: 'IO',
    epic: { summary: '임베드' },
    children: [
      { summary: '[Web] 임베드', issueTypeId: '10001' },
      { summary: '[Android] 임베드', issueTypeId: '10001' },
      { summary: '[QA] 임베드', issueTypeId: '10001' },
    ],
  } });
  assert.equal(result.ok, true);
  assert.equal(result.made, 2, '에픽 + 성공한 하위 하나');
  assert.equal(result.failed, 2);
  assert.ok(result.children[0].key);
  assert.equal(result.children[1].kind, 'makeReject');
  assert.match(result.children[1].error, /필수 항목이 더 있을 수 있어요/);
  assert.equal(result.children[2].kind, 'makeForbidden');
  assert.match(result.children[2].error, /권한이 없어요/);
  assert.equal(fake.made.length, 2, '실패한 것은 만들어지지 않았다');
  // 지라 원문(`refused`)은 어느 문구에도 섞이지 않는다.
  assert.doesNotMatch(JSON.stringify(result), /refused/);
});

test('BJCREATE: 에픽 자체가 실패하면 하위는 시작하지도 않는다', async () => {
  const fake = jiraMakeFake({ refuse: { '만들 수 없는 에픽': 400 } });
  const result = await jiraMakeApi(fake).create({ plan: {
    projectKey: 'IO',
    epic: { summary: '만들 수 없는 에픽' },
    children: [{ summary: '[Web] 하위', issueTypeId: '10001' }],
  } });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'makeReject');
  assert.equal(fake.made.length, 0);
  assert.equal(fake.calls.filter(call => call.method === 'POST').length, 1, '에픽 하나만 시도했다');
});

test('BJCREATE: 이미 있는 에픽에 붙일 때는 그 티켓이 정말 에픽인지 쓰기 직전에 확인한다', async () => {
  const good = jiraMakeFake({ epic: { summary: '게시글 작성하기_게임 임베드', typeId: '10000' } });
  const ok = await jiraMakeApi(good).create({ plan: {
    projectKey: 'IO', epic: { key: 'IO-48394' }, children: [{ summary: '[Web] 붙임', issueTypeId: '10001' }],
  } });
  assert.equal(ok.ok, true);
  assert.equal(ok.epic.created, false);
  assert.equal(ok.epic.summary, '게시글 작성하기_게임 임베드');
  assert.equal(ok.made, 1, '에픽은 이미 있으므로 세지 않는다');
  assert.deepEqual(good.made.map(entry => entry.parent), ['IO-48394']);

  // 에픽이 아닌 티켓(작업)에는 붙이지 않는다 — 아무것도 만들지 않는다.
  const wrong = jiraMakeFake({ epic: { summary: '그냥 작업', typeId: '10001' } });
  const refused = await jiraMakeApi(wrong).create({ plan: {
    projectKey: 'IO', epic: { key: 'IO-48394' }, children: [{ summary: '[Web] 붙임', issueTypeId: '10001' }],
  } });
  assert.deepEqual(refused, { ok: false, error: '고른 티켓이 에픽이 아니에요.', kind: 'notEpic' });
  assert.equal(wrong.made.length, 0);

  // 다른 프로젝트의 에픽 키는 형식 단계에서 거절한다(지라를 부르지도 않는다).
  const other = jiraMakeFake();
  assert.equal((await jiraMakeApi(other).create({ plan: {
    projectKey: 'IO', epic: { key: 'PAY-1' }, children: [{ summary: '[Web] 붙임', issueTypeId: '10001' }],
  } })).kind, 'key');
  assert.equal(other.calls.length, 0);
});

test('BJCREATE: 보낸 값은 개수·요약·종류까지 다시 검증하고, 종류가 바뀌었으면 아무것도 만들지 않는다', async () => {
  const many = jiraMakeFake();
  const over = await jiraMakeApi(many).create({ plan: {
    projectKey: 'IO', epic: { summary: '너무 많음' },
    children: Array.from({ length: 13 }, (unused, at) => ({ summary: `[R${at}] 하위`, issueTypeId: '10001' })),
  } });
  assert.deepEqual(over, { ok: false, error: '한 번에 12개까지 만들 수 있어요.', kind: 'tooMany' });
  assert.equal(many.calls.length, 0, '개수부터 틀리면 지라를 부르지 않는다');

  const bad = jiraMakeFake();
  const api = jiraMakeApi(bad);
  const cases = [
    { plan: { projectKey: 'io', epic: { summary: 'x' }, children: [] }, kind: 'key' },
    { plan: { projectKey: 'IO', epic: { summary: '   ' }, children: [] }, kind: 'value' },
    { plan: { projectKey: 'IO', epic: { summary: 'x'.repeat(256) }, children: [] }, kind: 'value' },
    { plan: { projectKey: 'IO', epic: { summary: '줄\n바꿈' }, children: [] }, kind: 'value' },
    { plan: { projectKey: 'IO', epic: { summary: 'x' }, children: [{ summary: '', issueTypeId: '10001' }] }, kind: 'value' },
    { plan: { projectKey: 'IO', epic: { summary: 'x' }, children: [{ summary: '하위', issueTypeId: '../etc' }] }, kind: 'value' },
    { plan: { projectKey: 'IO', epic: { key: 'IO-1' }, children: [] }, kind: 'value' },
    { kind: 'value' },
  ];
  for (const entry of cases) assert.equal((await api.create(entry.plan ? { plan: entry.plan } : {})).kind, entry.kind, JSON.stringify(entry.plan));
  assert.equal(bad.calls.length, 0, '형식이 틀리면 지라를 부르지 않는다');

  // 화면이 본 종류가 지라에서 사라졌으면(쓰기 직전 재조회 대조) 아무것도 만들지 않는다.
  const stale = jiraMakeFake({ types: { issueTypes: [{ id: '10000', name: '에픽', subtask: false, hierarchyLevel: 1 }] } });
  const gone = await jiraMakeApi(stale).create({ plan: {
    projectKey: 'IO', epic: { summary: 'x' }, children: [{ summary: '[Web] 하위', issueTypeId: '10001' }],
  } });
  assert.equal(gone.kind, 'typeStale');
  assert.equal(stale.made.length, 0);

  // 에픽 타입이 아예 없는 프로젝트에는 새 에픽을 만들지 않는다.
  const noEpic = jiraMakeFake({ types: { issueTypes: [{ id: '10001', name: '작업', subtask: false, hierarchyLevel: 0 }] } });
  assert.equal((await jiraMakeApi(noEpic).create({ plan: { projectKey: 'IO', epic: { summary: 'x' }, children: [] } })).kind, 'epicType');
  assert.equal(noEpic.made.length, 0);
});

test('BJCREATE: 같은 계획을 60초 안에 두 번 받으면 거절하고, 아무것도 못 만든 요청은 곧바로 다시 받는다', async () => {
  let clock = 1000;
  const fake = jiraMakeFake();
  const api = jiraMakeApi(fake, { now: () => clock });
  const plan = { projectKey: 'IO', epic: { summary: '한 번만' }, children: [{ summary: '[Web] 한 번만', issueTypeId: '10001' }] };
  assert.equal((await api.create({ plan })).ok, true);
  assert.equal(fake.made.length, 2);
  assert.deepEqual(await api.create({ plan }), { ok: false, error: '같은 내용을 방금 보냈어요. 잠시 뒤에 다시 시도해 주세요.', kind: 'duplicate' });
  assert.equal(fake.made.length, 2, '두 번째 요청은 지라에 닿지 않는다');
  clock += 61 * 1000;
  assert.equal((await api.create({ plan })).ok, true, '60초가 지나면 같은 계획도 다시 받는다');
  assert.equal(fake.made.length, 4);

  // 아무것도 만들지 못하고 끝난 계획은 지문을 남기지 않는다(바로 다시 시도할 수 있어야 한다).
  const refusing = jiraMakeFake({ refuse: { '거절되는 에픽': 400 } });
  const retry = jiraMakeApi(refusing);
  const badPlan = { plan: { projectKey: 'IO', epic: { summary: '거절되는 에픽' }, children: [] } };
  assert.equal((await retry.create(badPlan)).kind, 'makeReject');
  assert.equal((await retry.create(badPlan)).kind, 'makeReject', '중복이 아니라 같은 실패로 답한다');
});

test('BJCREATE: 설정이 없거나 토큰을 못 읽으면 지라를 부르지 않고 연결 필요로만 답한다', async () => {
  const fake = jiraMakeFake();
  const plan = { plan: { projectKey: 'IO', epic: { summary: 'x' }, children: [] } };
  const off = jiraModule.createJiraApi({ config: {}, request: fake.request });
  assert.deepEqual(await off.create(plan), { ok: false, error: '지라 연결이 필요해요.', kind: 'off' });
  assert.deepEqual(await off.createMeta('IO'), { ok: true, connected: false });
  const noToken = jiraModule.createJiraApi({ config: jiraConfig, request: fake.request, readFile: () => { throw new Error('ENOENT'); } });
  assert.deepEqual(await noToken.create(plan), { ok: false, error: '지라 연결이 필요해요.', kind: 'off' });
  assert.equal(fake.calls.length, 0);
});

test('BJCREATE: 새 주소 둘은 조회면 파일을 쓰지 않고, 형식이 틀린 값만 400이다', async () => {
  const snapshot = () => fs.readdirSync(directory).sort().map(name => {
    const stat = fs.statSync(path.join(directory, name));
    return `${name}:${stat.size}:${stat.mtimeMs}`;
  }).join('|');
  const before = snapshot();
  const meta = await fetch(`${base}/api/jira/create-meta?project=IO`);
  assert.equal(meta.status, 200);
  assert.deepEqual(await meta.json(), { ok: true, connected: false });
  const badMeta = await fetch(`${base}/api/jira/create-meta?project=io-1`);
  assert.equal(badMeta.status, 400);
  assert.deepEqual(await badMeta.json(), { ok: false, error: '지라 번호를 확인해 주세요.', kind: 'key' });
  // 설정이 없으면 만들기도 `지라 연결이 필요해요`로만 답한다(200 + ok:false).
  const off = await post('/api/jira/create', { plan: { projectKey: 'IO', epic: { summary: 'x' }, children: [] } });
  assert.equal(off.status, 200);
  assert.equal(off.kind, 'off');
  // 보낸 쪽 잘못(키·값·개수)만 400이다.
  assert.equal((await post('/api/jira/create', { plan: { projectKey: 'io', epic: { summary: 'x' } } })).status, 400);
  assert.equal((await post('/api/jira/create', {})).status, 400);
  assert.equal(snapshot(), before, '두 주소 모두 어떤 파일도 만들거나 고치지 않는다');
});

test('BJCREATE: 직군 세트는 앱 데이터로만 저장하고 검증을 통과한 것만 목록에 실린다', async () => {
  const saved = await post('/api/workflow/jira-roles', { roles: [{ label: 'Web', prefix: '[Web]' }, { label: ' Data ', prefix: ' [Data] ' }] });
  assert.equal(saved.ok, true);
  assert.deepEqual((await items()).workflows.jiraRoles, [{ label: 'Web', prefix: '[Web]' }, { label: 'Data', prefix: '[Data]' }]);
  const bad = [
    { roles: 'nope' },
    { roles: Array.from({ length: 21 }, (unused, at) => ({ label: `R${at}`, prefix: `[R${at}]` })) },
    { roles: [{ label: '', prefix: '[x]' }] },
    { roles: [{ label: 'x'.repeat(31), prefix: '[x]' }] },
    { roles: [{ label: 'x', prefix: 'y'.repeat(21) }] },
    { roles: [{ label: '줄\n바꿈', prefix: '[x]' }] },
    { roles: [{ label: 'Web', prefix: '[Web]' }, { label: 'web', prefix: '[W]' }] },
  ];
  for (const body of bad) assert.equal((await post('/api/workflow/jira-roles', body)).status, 400, JSON.stringify(body));
  assert.deepEqual((await items()).workflows.jiraRoles, [{ label: 'Web', prefix: '[Web]' }, { label: 'Data', prefix: '[Data]' }], '거절된 요청은 저장을 고치지 않는다');
  // 전부 지우면 빈 목록이 그대로 남는다(기본값이 되살아나지 않는다 — 기본값은 화면이 쓴다).
  assert.equal((await post('/api/workflow/jira-roles', { roles: [] })).ok, true);
  assert.deepEqual((await items()).workflows.jiraRoles, []);
});

test('BJCREATE: 복구가 필요한 동안에는 지라에 만들지도, 직군 세트를 저장하지도 않는다', async (t) => {
  const server = await startServer(t, (home) => {
    // 저널이 기억하는 `이전 내용`과 파일이 다르다 = 밖에서 바뀐 파일이라 복구를 거절한다.
    fs.writeFileSync(path.join(home, 'tasks.md'), '# Tasks\n- 바깥에서 고친 줄 #task[id:outside status:to-do created:2026-09-20]\n');
    fs.writeFileSync(path.join(home, '.mutation-journal.json'), journalEntry(path.join(home, 'tasks.md'), '# Tasks\n', '# Tasks\n- 중단된 저장\n'));
    fs.writeFileSync(path.join(home, '.mutation.lock'), String(deadPid()));
  });
  const send = async (route, body) => {
    const response = await fetch(server.base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, ...await response.json() };
  };
  const made = await send('/api/jira/create', { plan: { projectKey: 'IO', epic: { summary: 'x' }, children: [] } });
  assert.equal(made.status, 503);
  assert.match(made.error, /저장을 멈췄어요/);
  const roles = await send('/api/workflow/jira-roles', { roles: [{ label: 'Web', prefix: '[Web]' }] });
  assert.equal(roles.status, 503);
  // 조회는 그대로 된다.
  assert.equal((await fetch(`${server.base}/api/jira/create-meta?project=IO`)).status, 200);
});

// ---------- BJASSIGN — 새로 만든 에픽만 나에게 자동 배정 ----------
// 하위 티켓은 직군별로 다른 사람에게 갈 수 있어 배정을 아예 시도하지 않는다(지금처럼 담당 없음).
test('BJASSIGN: 새로 만든 에픽은 만든 직후 나에게 배정하고, 배정 주소·본문은 accountId 하나뿐이다', async () => {
  const fake = jiraMakeFake();
  const result = await jiraMakeApi(fake).create({ plan: {
    projectKey: 'IO',
    epic: { summary: '게시글 작성하기_게임 임베드' },
    children: [{ summary: '[Web] 게시글 작성하기_게임 임베드', issueTypeId: '10001' }],
  } });
  assert.equal(result.ok, true);
  assert.equal(result.epic.created, true);
  assert.equal(result.epic.assigned, true);
  assert.equal(result.epic.assignError, undefined);
  assert.equal(fake.assigned.length, 1, '배정은 에픽 하나뿐이다');
  assert.equal(fake.assigned[0].url, `${JIRA_SITE}/rest/api/3/issue/${result.epic.key}/assignee`);
  assert.equal(fake.assigned[0].accountId, JIRA_CREATE_ME);
  // 몸통(body)에는 accountId 하나만 실리고, 주소(querystring)에는 accountId 값 자체가 없다.
  const put = fake.calls.find(call => call.method === 'PUT' && call.url.endsWith('/assignee'));
  assert.deepEqual(Object.keys(put.body), ['accountId']);
  assert.doesNotMatch(put.url.split('?')[1] || '', new RegExp(JIRA_CREATE_ME));
  // 하위 티켓에는 배정을 아예 시도하지 않는다 — `children[]`에 `assigned`/`assignError` 칸도 없다.
  assert.ok(result.children[0].key, '하위는 그대로 만들어진다');
  assert.equal('assigned' in result.children[0], false);
  assert.equal('assignError' in result.children[0], false);
  // 응답·계정 id 어디에도 계정 식별자가 노출되지 않는다.
  assert.doesNotMatch(JSON.stringify(result), new RegExp(JIRA_CREATE_ME));
});

test('BJASSIGN: 누가 나인지는 프로세스마다(같은 api 인스턴스) 한 번만 묻고 재사용한다', async () => {
  const fake = jiraMakeFake();
  const api = jiraMakeApi(fake);
  await api.create({ plan: { projectKey: 'IO', epic: { summary: '한 번' }, children: [] } });
  await api.create({ plan: { projectKey: 'IO', epic: { summary: '두 번' }, children: [] } });
  assert.equal(fake.calls.filter(call => call.url.includes('/myself')).length, 1, '두 번째 create()는 myself를 다시 묻지 않는다');
  assert.equal(fake.assigned.length, 2, '배정 자체는 매번 시도한다');
});

test('BJASSIGN: 누가 나인지 조회에 실패하면 아무것도 만들지 않고 전체를 중단한다', async () => {
  const denied = jiraMakeFake({ mineId: null });
  const result = await jiraMakeApi(denied).create({ plan: {
    projectKey: 'IO', epic: { summary: '만들면 안 됨' }, children: [{ summary: '[Web] 하위', issueTypeId: '10001' }],
  } });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'makeForbidden');
  assert.equal(denied.made.length, 0, '에픽도 하위도 만들지 않는다');
  assert.equal(denied.assigned.length, 0);
  assert.equal(denied.calls.filter(call => call.method === 'POST').length, 0, '지라에 쓰기 요청 자체가 없다');
});

test('BJASSIGN: myself가 401/403이면 다음 create() 때 다시 묻는다', async () => {
  let denied = true;
  const flaky = jiraMakeFake({ mineId: JIRA_CREATE_ME });
  // 첫 시도만 401로 거절되게 route를 뒤엎는다(누가 나인지 조회만) — `create()`가 이 값을 읽기 전에 끼운다.
  const base = flaky.request;
  const request = (url, options) => (String(url).includes('/rest/api/3/myself') && denied ? Promise.resolve(json({}, 401)) : base(url, options));
  const api = jiraModule.createJiraApi({ config: jiraConfig, request, readFile: () => JIRA_TOKEN });
  const first = await api.create({ plan: { projectKey: 'IO', epic: { summary: '거절됨' }, children: [] } });
  assert.equal(first.kind, 'makeForbidden');
  assert.equal(flaky.made.length, 0);
  denied = false;
  const second = await api.create({ plan: { projectKey: 'IO', epic: { summary: '이번엔 됨' }, children: [] } });
  assert.equal(second.ok, true);
  assert.equal(second.epic.assigned, true);
});

test('BJASSIGN: 이미 있는 에픽에 붙일 때는 에픽을 재배정하지 않는다 — `assigned` 칸 자체가 없다', async () => {
  const fake = jiraMakeFake({ epic: { summary: '남의 에픽', typeId: '10000' } });
  const result = await jiraMakeApi(fake).create({ plan: {
    projectKey: 'IO', epic: { key: 'IO-48394' }, children: [{ summary: '[Web] 붙임', issueTypeId: '10001' }],
  } });
  assert.equal(result.ok, true);
  assert.equal(result.epic.created, false);
  assert.equal('assigned' in result.epic, false, 'attach 모드는 assigned 칸을 두지 않는다');
  assert.equal('assignError' in result.epic, false);
  assert.equal(fake.assigned.length, 0, '배정 요청 자체가 나가지 않는다');
});

test('BJASSIGN: 배정만 실패해도 이미 만든 티켓은 그대로 유지되고 assignError만 붙는다', async () => {
  const fake = jiraMakeFake({ assignStatus: 403 });
  const result = await jiraMakeApi(fake).create({ plan: {
    projectKey: 'IO', epic: { summary: '배정만 실패' }, children: [{ summary: '[Web] 하위', issueTypeId: '10001' }],
  } });
  assert.equal(result.ok, true, '만들기 자체는 성공이다');
  assert.equal(result.epic.created, true);
  assert.ok(result.epic.key, '에픽은 실제로 만들어졌다');
  assert.equal(result.epic.assigned, undefined);
  assert.equal(result.epic.assignError, '지라에서 이 프로젝트에 이슈를 만들 권한이 없어요.');
  assert.equal(fake.made.length, 2, '에픽 + 하위 모두 만들어졌다');
  assert.equal(result.made, 2, '배정 실패가 만든 개수를 깎지 않는다');
  assert.equal(result.failed, 0);
});

test('BJASSIGN: 설정·토큰이 없으면 myself도 묻지 않는다', async () => {
  const fake = jiraMakeFake();
  const off = jiraModule.createJiraApi({ config: {}, request: fake.request });
  await off.create({ plan: { projectKey: 'IO', epic: { summary: 'x' }, children: [] } });
  assert.equal(fake.calls.length, 0);
});

// ---------- 반응 필요 (BATTENTION 1차 — 지라 댓글) ----------
// 여기도 실제 지라에는 절대 닿지 않는다: 전부 가짜 fetch이고, 사람 이름·계정 id·댓글 글자는
// 모두 이 파일에서 지어낸 것이다. 내 계정 id는 판별에만 쓰이고 응답에 실리지 않는지도 함께 본다.
const ATTENTION_ME = 'fixture-me-account';
const ATTENTION_OTHER = 'fixture-other-account';
const adfDoc = (...parts) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: parts }] });
const adfSay = value => adfDoc({ type: 'text', text: value });
const attentionComment = (id, accountId, name, created, body) => ({
  id, created, body,
  // 지라는 묻지 않아도 이메일·계정 id를 끼워 보낸다 — 앱이 옮기지 않는지 함께 본다.
  author: { accountId, displayName: name, emailAddress: `${name}@example.test` },
});
const attentionIssue = (key, comments, extra = {}) => ({
  key,
  fields: {
    summary: `${key}의 요약`,
    status: extra.status || { name: '진행 중', statusCategory: { key: 'indeterminate' } },
    comment: { comments, total: extra.total === undefined ? comments.length : extra.total },
  },
});
const attentionRow = (comments, extra = {}) =>
  jiraModule.shapeAttention(JIRA_SITE, attentionIssue(extra.key || 'IO-48394', comments, extra), ATTENTION_ME, comments);
const mineSaid = (id, at, body) => attentionComment(id, ATTENTION_ME, '나', at, body || adfSay('제가 확인할게요'));
const theySaid = (id, at, name, body) => attentionComment(id, ATTENTION_OTHER + name, name, at, body || adfSay(`${name}의 댓글`));

test('반응 필요는 내 마지막 댓글 뒤에 남은 다른 사람 댓글만 줄로 만든다', () => {
  const a = theySaid('10002', '2026-09-21T02:00:00.000+0000', '테스터A');
  const mine = mineSaid('10001', '2026-09-21T09:00:00.000+0000');
  const b = theySaid('10003', '2026-09-22T03:00:00.000+0000', '테스터B');
  assert.deepEqual(attentionRow([a, mine, b]), {
    id: 'jira:IO-48394:10003', source: 'jira', key: 'IO-48394', url: `${JIRA_SITE}/browse/IO-48394`,
    summary: 'IO-48394의 요약', status: '진행 중', statusTone: 'doing',
    who: '테스터B', others: 0, count: 1, preview: '테스터B의 댓글',
    at: '2026-09-22T03:00:00.000Z', mention: false,
  }, '내 댓글보다 앞선 댓글은 세지 않는다');

  // 내 댓글이 없으면 다른 사람 댓글 전부가 대상이고, 작성자가 둘이면 `외 N명`이 붙는다.
  const many = attentionRow([a, b]);
  assert.deepEqual([many.count, many.who, many.others], [2, '테스터B', 1]);
  // 같은 사람이 두 번 적었으면 `외 N명`은 없다.
  assert.equal(attentionRow([a, theySaid('10004', '2026-09-22T04:00:00.000+0000', '테스터A')]).others, 0);

  assert.equal(attentionRow([a, b, mineSaid('10005', '2026-09-23T01:00:00.000+0000')]), null, '내가 마지막으로 답했으면 줄이 없다');
  assert.equal(attentionRow([mine]), null, '다른 사람 댓글이 하나도 없으면 줄이 없다');
  assert.equal(attentionRow([]), null);
  // 주소를 이 키로 조립하고 치우기가 이 id로 걸린다 — 형식이 아니면 줄을 만들지 않는다.
  assert.equal(attentionRow([a], { key: '수상한키' }), null);
  assert.equal(attentionRow([theySaid('10-a', '2026-09-22T03:00:00.000+0000', '테스터A')]), null);
  assert.equal(jiraModule.shapeAttention(JIRA_SITE, attentionIssue('IO-48394', [a]), '', [a]), null, '누가 나인지 모르면 아무 줄도 만들지 않는다');
});

test('댓글이 최신순으로 와도 created 차례로 놓고 판정한다', () => {
  const mine = mineSaid('10001', '2026-09-22T05:00:00.000+0000');
  const theirs = theySaid('10002', '2026-09-22T04:00:00.000+0000', '테스터A');
  // 최신순(내 댓글이 먼저)으로 와도 "내가 마지막으로 답한" 것이므로 줄이 없어야 한다.
  assert.equal(attentionRow([mine, theirs]), null);
  const later = theySaid('10003', '2026-09-22T06:00:00.000+0000', '테스터A');
  assert.equal(attentionRow([later, mine, theirs]).id, 'jira:IO-48394:10003');
});

test('완료한 이슈도 빼지 않고, 지라 상태 글자와 범주를 함께 싣는다', () => {
  const row = attentionRow([theySaid('10002', '2026-09-22T03:00:00.000+0000', '테스터A')], {
    status: { name: '완료', statusCategory: { key: 'done' } },
  });
  assert.deepEqual([row.status, row.statusTone], ['완료', 'done'], '완료된 티켓에도 질문이 달린다');
  const unknown = attentionRow([theySaid('10002', '2026-09-22T03:00:00.000+0000', '테스터A')], { status: {} });
  assert.deepEqual([unknown.status, unknown.statusTone], ['', 'doing'], '모르는 범주는 진행으로 본다');
});

test('나를 부른 댓글은 표시가 붙고, 미리보기는 140자까지 편다', () => {
  const called = adfDoc(
    { type: 'text', text: '이거 ' },
    { type: 'mention', attrs: { id: ATTENTION_ME, text: '@나' } },
    { type: 'text', text: ' 확인 부탁해요' },
  );
  const row = attentionRow([theySaid('10002', '2026-09-22T03:00:00.000+0000', '테스터A', called)]);
  assert.equal(row.mention, true);
  assert.equal(row.preview, '이거 @나 확인 부탁해요', 'mention은 @표시이름으로 펴진다');
  // 다른 사람을 부른 댓글은 나를 부른 것이 아니다.
  const elsewhere = adfDoc({ type: 'mention', attrs: { id: 'someone-else', text: '@테스터B' } });
  assert.equal(attentionRow([theySaid('10002', '2026-09-22T03:00:00.000+0000', '테스터A', elsewhere)]).mention, false);

  // 문단 사이는 공백 하나, 글자가 아닌 노드(그림·첨부)는 비운다.
  const mixed = { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: '첫 문단' }] },
    { type: 'mediaSingle', attrs: { layout: 'center' } },
    { type: 'paragraph', content: [{ type: 'text', text: '둘째 문단' }] },
  ] };
  assert.equal(jiraModule.attentionPreview(mixed), '첫 문단 둘째 문단');
  const long = jiraModule.attentionPreview(adfSay('가'.repeat(400)));
  assert.equal(long.length, 140);
  assert.match(long, /…$/);
  assert.equal(jiraModule.attentionPreview(null), '');
});

test('줄 차례는 나를 부른 것이 먼저, 그 안에서는 마지막 댓글이 최신인 것부터다', () => {
  const rows = [
    { mention: false, at: '2026-09-22T09:00:00.000Z', key: 'A-1' },
    { mention: true, at: '2026-09-20T09:00:00.000Z', key: 'A-2' },
    { mention: false, at: '2026-09-22T11:00:00.000Z', key: 'A-3' },
    { mention: true, at: '2026-09-21T09:00:00.000Z', key: 'A-4' },
  ].sort(jiraModule.attentionOrder);
  assert.deepEqual(rows.map(row => row.key), ['A-4', 'A-2', 'A-3', 'A-1']);
});

test('반응 필요 조회는 이슈 50개·칸 셋만 묻고, 댓글이 잘린 이슈만 한 번 더 읽는다', async () => {
  const cut = attentionIssue('IO-48395', [theySaid('20002', '2026-09-22T03:00:00.000+0000', '테스터A')], { total: 30 });
  const fake = jiraFake({
    '/rest/api/3/myself': () => json({ accountId: ATTENTION_ME, emailAddress: JIRA_EMAIL, displayName: '나' }),
    '/rest/api/3/search/jql': () => json({ issues: [
      attentionIssue('IO-48394', [mineSaid('10001', '2026-09-20T01:00:00.000+0000'), theySaid('10002', '2026-09-21T02:00:00.000+0000', '테스터A')]),
      cut,
      attentionIssue('IO-48396', [theySaid('30002', '2026-09-20T02:00:00.000+0000', '테스터B'), mineSaid('30003', '2026-09-21T02:00:00.000+0000')]),
      { key: '수상한키', fields: {} },
    ] }),
    '/rest/api/3/issue/IO-48395/comment': () => json({ comments: [
      theySaid('20003', '2026-09-22T05:00:00.000+0000', '테스터B'),
      theySaid('20002', '2026-09-22T03:00:00.000+0000', '테스터A'),
    ] }),
  });
  const items = await jiraListClient(fake).listAttention(ATTENTION_ME);
  assert.deepEqual(items.map(item => item.id), ['jira:IO-48395:20003', 'jira:IO-48394:10002'],
    '내가 마지막으로 답한 이슈와 형식이 틀린 키는 빠진다');
  assert.equal(items[0].count, 2, '다시 읽어 온 댓글로 판정한다');
  // 요청은 둘뿐이다: 목록 하나 + 잘린 이슈 하나(다른 이슈는 다시 읽지 않는다).
  assert.equal(fake.calls.length, 2);
  const [list, comment] = fake.calls;
  assert.equal(decodeURIComponent(list.url.split('jql=')[1].split('&')[0]), jiraModule.ATTENTION_JQL);
  assert.match(list.url, /fields=summary,status,comment&maxResults=50$/);
  assert.match(comment.url, /\/rest\/api\/3\/issue\/IO-48395\/comment\?orderBy=-created&maxResults=20$/);
  // 담당자 칸은 애초에 달라고 하지 않는다(JQL의 `assignee = currentUser()`는 조건이지 받아 오는 칸이 아니다).
  assert.doesNotMatch(fake.calls.map(call => call.url).join(' '), /emailAddress|accountId|fields=[^&]*assignee/);

  // 다시 읽기가 실패해도 목록 전체를 오류로 만들지 않는다 — 받아 온 댓글로만 판단한다.
  const broken = jiraFake({
    '/rest/api/3/search/jql': () => json({ issues: [cut] }),
    '/rest/api/3/issue/IO-48395/comment': () => json({}, 500),
  });
  assert.deepEqual((await jiraListClient(broken).listAttention(ATTENTION_ME)).map(item => item.count), [1]);
});

test('반응 필요 API는 내 계정 id를 한 번만 묻고 응답 어디에도 싣지 않는다', async () => {
  const routes = {
    '/rest/api/3/myself': () => json({ accountId: ATTENTION_ME, emailAddress: JIRA_EMAIL, displayName: '나' }),
    '/rest/api/3/search': () => json({ issues: [attentionIssue('IO-48394', [theySaid('10002', '2026-09-22T03:00:00.000+0000', '테스터A')])] }),
  };
  const fake = jiraFake(routes);
  const api = jiraModule.createJiraApi({ config: jiraConfig, request: fake.request, readFile: () => JIRA_TOKEN });
  const answer = await api.attention();
  assert.equal(answer.connected, true);
  assert.deepEqual(answer.items.map(item => [item.key, item.who]), [['IO-48394', '테스터A']]);
  await api.attention();
  assert.equal(fake.calls.filter(call => call.url.includes('/myself')).length, 1, '누가 나인지는 프로세스마다 한 번만 묻는다');
  const payload = JSON.stringify(answer);
  assert.doesNotMatch(payload, /accountId|emailAddress|fixture-me-account|fixture-other-account/);
  assert.doesNotMatch(payload, new RegExp(`${JIRA_TOKEN}|${JIRA_EMAIL}`));
  assert.doesNotMatch(payload, /@/, '이메일이 섞일 자리가 없다(부름 표시가 없는 댓글이라 @도 없다)');

  // 설정·토큰이 없으면 지라를 부르지 않는다.
  const off = jiraModule.createJiraApi({ config: {}, request: jiraFake(routes).request });
  assert.deepEqual(await off.attention(), { ok: true, connected: false });
  const noToken = jiraModule.createJiraApi({ config: jiraConfig, request: fake.request, readFile: () => '' });
  assert.deepEqual(await noToken.attention(), { ok: true, connected: false });

  // 토큰이 만료되면 해요체 문구로만 알리고, 다음번에는 누가 나인지 다시 묻는다.
  let denied = true;
  const flaky = jiraFake({
    '/rest/api/3/myself': () => (denied ? json({}, 401) : json({ accountId: ATTENTION_ME })),
    '/rest/api/3/search': () => json({ issues: [] }),
  });
  const retried = jiraModule.createJiraApi({ config: jiraConfig, request: flaky.request, readFile: () => JIRA_TOKEN });
  assert.deepEqual(await retried.attention(), { ok: false, error: '지라 토큰을 확인해 주세요.', kind: 'auth' });
  denied = false;
  assert.deepEqual((await retried.attention()).items, []);
  assert.equal(flaky.calls.filter(call => call.url.includes('/myself')).length, 2);
});

// 보관함(attention-live)의 시간 규칙 — 가짜 시계와 가짜 목록으로만 확인한다(지라에 닿지 않는다).
const attentionLiveModule = require('./attention-live');
function attentionHarness({ answers = [], connected = true } = {}) {
  let clock = 0;
  const calls = [];
  let pending = null;
  const load = () => {
    calls.push(clock);
    const answer = answers.length ? answers.shift() : { ok: true, connected: true, items: [{ id: 'jira:IO-1:1' }] };
    if (answer === 'hang') return new Promise((resolve) => { pending = resolve; });
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(answer);
  };
  const live = attentionLiveModule.createAttentionLive({ load, connected: () => connected, now: () => clock });
  return { live, calls, tick: (ms) => { clock += ms; }, release: (value) => { const resolve = pending; pending = null; resolve(value); } };
}

test('반응 필요 보관함은 실패하면 30분까지 이전 값을 `기준`으로 쓰고, 그보다 묵으면 빈 목록 + 문구다', async () => {
  const held = attentionHarness({ answers: [
    { ok: true, connected: true, items: [{ id: 'jira:IO-1:1' }] },
    { ok: false, error: '지라에 연결하지 못했어요.', kind: 'network' },
    new Error('fetch failed'),
  ] });
  await held.live.refresh();
  assert.deepEqual(held.live.view(), { items: [{ id: 'jira:IO-1:1' }], updatedAt: new Date(0).toISOString(), stale: false });

  held.tick(10 * 60 * 1000);
  assert.equal(await held.live.refresh(), false);
  const kept = held.live.view();
  assert.deepEqual(kept.items, [{ id: 'jira:IO-1:1' }], '실패하면 이전 값을 그대로 쓴다');
  assert.equal(kept.stale, true);
  assert.equal(kept.error, undefined);
  assert.equal(await held.live.refresh(), false, '던지는 실패도 조용히 흘린다');

  held.tick(21 * 60 * 1000); // 마지막으로 성공한 지 31분
  assert.deepEqual(held.live.view(), { items: [], updatedAt: null, stale: false, error: '지라 댓글을 읽지 못했어요.' });
});

test('반응 필요 보관함은 동시에 두 번 돌지 않고, 설정이 없으면 타이머도 첫 읽기도 없다', async () => {
  const harness = attentionHarness({ answers: ['hang'] });
  const first = harness.live.refresh();
  assert.equal(harness.live.refresh(), first, '도는 중이면 같은 갱신을 나눠 쓴다');
  assert.equal(harness.calls.length, 1);
  harness.release({ ok: true, connected: true, items: [] });
  await first;

  const off = attentionHarness({ connected: false });
  assert.equal(off.live.start(), false);
  assert.equal(off.calls.length, 0);
  const on = attentionHarness();
  assert.equal(on.live.start(), true);
  assert.equal(on.calls.length, 1, '설정이 있으면 뜰 때 한 번 읽는다');
  assert.equal(on.live.holdsProcess(), false, '타이머는 unref — 이것 때문에 프로세스가 남지 않는다');
  assert.equal(on.live.start(), false, '두 번 켜지지 않는다');
  on.live.stop();
  assert.equal(on.live.started(), false);
  // 설정이 없다는 답은 실패가 아니다 — 오류 문구를 만들지 않는다.
  const none = attentionHarness({ answers: [{ ok: true, connected: false }] });
  await none.live.refresh();
  assert.deepEqual(none.live.view(), { items: [], updatedAt: null, stale: false });

  // 값이 없는 동안 조회가 스스로 읽는 것은 1분에 한 번까지다(지라가 죽어 있어도 화면을 열 때마다 묻지 않게).
  const down = attentionHarness({ answers: [new Error('down'), new Error('down'), new Error('down')] });
  assert.equal(down.live.needsRead(), true, '아직 한 번도 못 읽었으면 읽는다');
  await down.live.refresh();
  assert.equal(down.live.needsRead(), false, '방금 읽어 봤으면 다시 묻지 않는다');
  down.tick(61 * 1000);
  assert.equal(down.live.needsRead(), true);
  await down.live.refresh();
  assert.equal(down.calls.length, 2);
});

// 가짜 지라를 끼운 서버 하나. 반응 필요만 보려고 이슈 셋을 둔다:
// ① 나를 부른 댓글 · ② 작성자가 둘인 댓글 · ③ 내가 마지막으로 답한 이슈(줄이 없어야 한다).
const ATTENTION_SITE = 'https://attention-jira.test';
async function startAttentionServer(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-attention-'));
  fs.writeFileSync(path.join(home, 'tasks.md'), '# Tasks\n- 댓글 확인하기 #task[id:at01 status:to-do created:2026-09-20]\n');
  const tokenFile = path.join(home, '.jira_token_fixture');
  fs.writeFileSync(tokenFile, 'fixture-token-never-real\n');
  const config = path.join(home, 'workspace.config.json');
  fs.writeFileSync(config, JSON.stringify({ jira: { siteUrl: ATTENTION_SITE, email: 'fixture@example.test', tokenFile } }));
  const wrapper = path.join(home, 'fake-attention-server.js');
  fs.writeFileSync(wrapper, `'use strict';
const SITE = ${JSON.stringify(ATTENTION_SITE)};
const ME = ${JSON.stringify(ATTENTION_ME)};
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input && input.url ? input.url : input);
  if (!url.startsWith(SITE)) return realFetch(input, init);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (url.includes('/rest/api/3/myself')) return json({ accountId: ME, emailAddress: 'fixture@example.test', displayName: '나' });
  const say = (line, mention) => ({ type: 'doc', content: [{ type: 'paragraph', content: [
    ...(mention ? [{ type: 'mention', attrs: { id: ME, text: '@나' } }, { type: 'text', text: ' ' }] : []),
    { type: 'text', text: line },
  ] }] });
  const comment = (id, who, at, line, mention) => ({
    id, created: at, body: say(line, mention),
    author: { accountId: who === '나' ? ME : 'other-' + who, displayName: who, emailAddress: 'someone@example.test' },
  });
  const issue = (key, comments) => ({ key, fields: {
    summary: key + '의 요약',
    status: { name: '배포 대기', statusCategory: { key: 'indeterminate' } },
    comment: { comments, total: comments.length },
  } });
  return json({ issues: [
    issue('IO-48394', [comment('10001', '테스터A', '2026-09-22T05:31:00.000+0000', '해외 서버에서는 안 뜨나요?', true)]),
    issue('IO-48395', [
      comment('20001', '나', '2026-09-21T01:00:00.000+0000', '제가 볼게요', false),
      comment('20002', '테스터B', '2026-09-21T02:00:00.000+0000', '문구만 확인 부탁해요', false),
      comment('20003', '테스터C', '2026-09-21T03:00:00.000+0000', '저도 같은 생각이에요', false),
    ]),
    issue('IO-48396', [
      comment('30001', '테스터A', '2026-09-20T01:00:00.000+0000', '이건 어떻게 할까요', false),
      comment('30002', '나', '2026-09-20T02:00:00.000+0000', '제가 처리했어요', false),
    ]),
  ] });
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

test('GET /api/attention은 나를 부른 줄을 맨 위에 두고, 조회는 어떤 파일도 만들지 않는다', async (t) => {
  const server = await startAttentionServer(t);
  const snapshot = () => fs.readdirSync(server.home).sort().map((name) => {
    const stat = fs.statSync(path.join(server.home, name));
    return `${name}:${stat.size}:${stat.mtimeMs}`;
  }).join('|');
  const before = snapshot();
  const read = async (query = '') => (await (await fetch(`${server.origin}/api/attention${query}`)).json());
  const first = await read();
  assert.equal(first.ok, true);
  assert.equal(first.connected, true);
  assert.deepEqual(first.items.map(item => [item.key, item.mention, item.count, item.who, item.others]), [
    ['IO-48394', true, 1, '테스터A', 0],
    ['IO-48395', false, 2, '테스터C', 1],
  ], '내가 마지막으로 답한 이슈는 줄이 없다');
  assert.equal(first.items[0].preview, '@나 해외 서버에서는 안 뜨나요?');
  assert.deepEqual([first.items[0].status, first.items[0].statusTone], ['배포 대기', 'doing']);
  assert.equal(first.items[0].url, `${ATTENTION_SITE}/browse/IO-48394`);
  assert.match(first.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(first.stale, false);
  assert.equal(first.error, undefined);
  // 토큰·이메일·계정 id는 어디에도 실리지 않는다(부름 표시의 `@나`만 남는다).
  const payload = JSON.stringify(first);
  assert.doesNotMatch(payload, /accountId|emailAddress|fixture-token-never-real|fixture@example\.test|someone@example\.test|other-테스터/);
  assert.doesNotMatch(payload, /@(?!나)/);
  assert.equal((await read('?fresh=1')).items.length, 2);
  assert.equal(snapshot(), before, '조회도 갱신도 파일을 만들지 않는다');
  assert.equal(fs.existsSync(path.join(server.home, '.workflow.json')), false);

  // `했어요` — 그 줄이 빠지고, 저장은 `.workflow.json` 한 칸뿐이다.
  const send = async (route, id) => {
    const response = await fetch(`${server.origin}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
    return { status: response.status, ...await response.json() };
  };
  const done = await send('/api/attention/dismiss', 'jira:IO-48394:10001');
  assert.deepEqual([done.status, done.ok, done.id], [200, true, 'jira:IO-48394:10001']);
  const saved = JSON.parse(fs.readFileSync(path.join(server.home, '.workflow.json'), 'utf8'));
  assert.match(saved.attention.dismissed['jira:IO-48394:10001'], /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual((await read()).items.map(item => item.key), ['IO-48395'], '치운 줄은 빠진 채로 온다');
  // `되돌리기` — 다시 나타난다.
  assert.equal((await send('/api/attention/undismiss', 'jira:IO-48394:10001')).ok, true);
  assert.deepEqual((await read()).items.map(item => item.key), ['IO-48394', 'IO-48395']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(server.home, '.workflow.json'), 'utf8')).attention, { dismissed: {} });
});

test('GET /api/attention은 지라 설정이 없으면 연결 안 됨으로만 답한다', async () => {
  const before = fs.readdirSync(directory).sort().join('|');
  const response = await fetch(`${base}/api/attention`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, connected: false, items: [] });
  assert.equal(fs.readdirSync(directory).sort().join('|'), before);
  // 인증 예외가 아니다 — 원격에서 토큰 없이 부르면 다른 주소와 똑같이 막힌다(여기서는 로컬이라 열린다).
  assert.equal((await fetch(`${base}/api/attention?fresh=1`)).status, 200);
});

test('반응 필요 치우기는 id 형식을 검증하고 같은 요청을 두 번 쓰지 않는다', async () => {
  assert.equal((await post('/api/attention/dismiss', { id: 'jira:IO-48394' })).status, 400);
  assert.equal((await post('/api/attention/dismiss', { id: 'JIRA:IO-48394:10001' })).status, 400);
  assert.equal((await post('/api/attention/dismiss', { id: 'jira:io-48394:10001' })).status, 400);
  assert.equal((await post('/api/attention/dismiss', {})).status, 400);
  assert.equal((await post('/api/attention/undismiss', { id: '../../etc/passwd' })).status, 400);
  const workflowPath = path.join(directory, '.workflow.json');
  assert.equal(JSON.parse(fs.readFileSync(workflowPath, 'utf8')).attention, undefined, '거절한 요청은 파일을 고치지 않는다');

  const call = () => fetch(`${base}/api/attention/dismiss`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'attention-request-0001' },
    body: JSON.stringify({ id: 'jira:IO-48394:10001' }),
  }).then(r => r.json());
  const a = await call();
  const b = await call();
  assert.deepEqual(a, b);
  assert.equal(a.id, 'jira:IO-48394:10001');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(workflowPath, 'utf8')).attention.dismissed), ['jira:IO-48394:10001']);
});

test('저장이 멈춘 동안에는 반응 필요도 치우지 못한다', async (t) => {
  const server = await startServer(t, (home) => {
    fs.writeFileSync(path.join(home, 'tasks.md'), '# Tasks\n- 바깥에서 고친 줄 #task[id:outside status:to-do created:2026-09-20]\n');
    fs.writeFileSync(path.join(home, '.mutation-journal.json'), journalEntry(path.join(home, 'tasks.md'), '# Tasks\n', '# Tasks\n- 중단된 저장\n'));
    fs.writeFileSync(path.join(home, '.mutation.lock'), String(deadPid()));
  });
  const response = await fetch(`${server.base}/api/attention/dismiss`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'jira:IO-48394:10001' }),
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'RECOVERY_NEEDED');
  // 조회는 그대로 된다(지라 설정이 없으니 연결 안 됨으로 답한다).
  assert.equal((await fetch(`${server.base}/api/attention`)).status, 200);
  assert.equal(fs.existsSync(path.join(server.home, '.workflow.json')), false);
});

test('치운 목록은 200개·30일로 정리하되 지금 화면에 있는 줄은 지킨다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-attention-store-'));
  const store = require('./workflow-store')({
    directory: home, refs: () => ({}), calendar: () => ({ events: [] }),
    today: () => today, validateDate: () => {}, create: {}, remove: () => {}, move: () => {},
  });
  const ago = days => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const seeded = { 'jira:OLD-1:1': ago(40), 'jira:OLD-2:2': ago(31) };
  // 200개를 넘기려고 오래되지 않은 줄을 잔뜩 넣어 둔다(오래된 것부터 버려야 한다).
  for (let index = 0; index < 205; index += 1) seeded[`jira:FILL-${index}:${index + 1}`] = new Date(Date.now() - (205 - index) * 60000).toISOString();
  fs.writeFileSync(path.join(home, '.workflow.json'), JSON.stringify({ items: {}, meetings: {}, attention: { dismissed: seeded } }));

  // 30일이 지난 `OLD-2`는 버리고, 지금 화면에 있는 `OLD-1`은 오래됐어도 지킨다(버리면 곧바로 다시 올라온다).
  store.dismissAttention({ id: 'jira:NEW-1:9' }, new Set(['jira:OLD-1:1', 'jira:NEW-1:9']));
  const table = store.attentionDismissed();
  assert.equal(table['jira:OLD-2:2'], undefined, '30일이 지난 줄은 버린다');
  assert.ok(table['jira:OLD-1:1'], '지금 목록에 있는 줄은 오래됐어도 지킨다');
  assert.ok(table['jira:NEW-1:9']);
  assert.equal(Object.keys(table).length, 200, '200개를 넘으면 오래된 것부터 버린다');
  assert.equal(table['jira:FILL-0:1'], undefined, '가장 오래된 것부터 빠진다');
  assert.ok(table['jira:FILL-204:205']);

  store.undismissAttention({ id: 'jira:NEW-1:9' });
  assert.equal(store.attentionDismissed()['jira:NEW-1:9'], undefined);
  assert.throws(() => store.dismissAttention({ id: 'nope' }), /보낸 값을 확인해 주세요/);
  fs.rmSync(home, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// 배포·업데이트 (VERSION · /api/about · 데이터 형식 · 자동화 설치 위치 · update.sh)
//
// 사람의 데이터가 업데이트로 깨지지 않는 것이 이 묶음의 목적이다. 그래서 여기서는
// **실제 launchd·실제 홈 폴더·실제 저장소를 절대 건드리지 않고** 임시 폴더 + 로컬 bare 저장소 +
// PATH 앞에 세운 가짜 `launchctl`·`curl`로만 확인한다(run-task.sh 테스트와 같은 방식).
const migrateStore = require('./migrate');

test('GET /api/about은 버전·데이터 형식·받는 갈래를 알려 주고 파일을 쓰지 않는다', async () => {
  const before = fs.readdirSync(directory).sort();
  const about = await (await fetch(base + '/api/about')).json();
  assert.equal(about.version, fs.readFileSync(path.join(__dirname, '..', '..', 'VERSION'), 'utf8').trim());
  assert.equal(about.dataFormat, 1);
  assert.equal(about.channel, 'stable', '설정이 없으면 배포된 버전만 받는 갈래다');
  assert.equal(about.install, 'manual', 'launchd가 띄운 자리가 아니면 manual이다');
  assert.equal(about.latest, null, 'WORKSPACE_NO_REMOTE_CHECK=1이면 원격에 묻지 않는다');
  assert.ok(about.modified === null || Array.isArray(about.modified));
  assert.deepEqual(fs.readdirSync(directory).sort(), before, '조회는 어떤 파일도 만들지 않는다');
});

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.test', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.test' };
const runGit = (cwd, args) => spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: gitEnv });
const gitReady = spawnSync('git', ['--version']).status === 0;
const writeExec = (file, body) => { fs.writeFileSync(file, body); fs.chmodSync(file, 0o755); };

// 서버를 실제로 띄운다(모듈로 부르면 시작 검사가 돌지 않는다).
async function startAppServer(t, env) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, WORKSPACE_PORT: String(port), WORKSPACE_NO_OPEN: '1', WORKSPACE_HOST: '', WORKSPACE_NO_REMOTE_CHECK: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  t.after(() => child.kill('SIGKILL'));
  const address = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`서버가 종료되었습니다 (${child.exitCode}): ${log}`);
    try { if ((await fetch(address + '/api/storage-status')).ok) return { base: address, log: () => log }; } catch { /* 아직 안 떴다 */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`서버가 응답하지 않았습니다: ${log}`);
}

test('/api/about의 `고친 파일`은 추적 파일의 수정·삭제만 세고, git이 없으면 null이다', { skip: !gitReady }, async (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-about-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const data = path.join(repo, 'tracker');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(repo, 'VERSION'), '9.9.9\n');
  fs.writeFileSync(path.join(repo, 'ui.css'), 'body{}\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'tracker/\n');
  runGit(repo, ['init', '-b', 'main']);
  runGit(repo, ['add', '-A']);
  runGit(repo, ['commit', '-m', '첫 커밋']);
  fs.writeFileSync(path.join(repo, 'ui.css'), 'body{color:red}\n');
  fs.writeFileSync(path.join(data, 'tasks.md'), '# Tasks\n');   // 업무 데이터는 gitignore라 잡히면 안 된다

  const app = await startAppServer(t, { WORKSPACE_REPO_DIR: repo, WORKSPACE_DATA_DIR: data, WORKSPACE_CONFIG: path.join(repo, 'absent.json') });
  const about = await (await fetch(app.base + '/api/about')).json();
  assert.equal(about.version, '9.9.9');
  assert.deepEqual(about.modified, ['ui.css'], '고친 추적 파일만 이름으로 센다 — 업무 데이터는 절대 들어가지 않는다');
  assert.match(about.gitRef, /^[0-9a-f]{7,}$/);

  // git을 찾을 수 없는 컴퓨터에서도 앱은 그대로 돌고, 모른다는 뜻으로 null을 준다.
  const blind = await startAppServer(t, { WORKSPACE_REPO_DIR: repo, WORKSPACE_DATA_DIR: data, WORKSPACE_CONFIG: path.join(repo, 'absent.json'), PATH: path.join(repo, 'no-such-bin') });
  const unknown = await (await fetch(blind.base + '/api/about')).json();
  assert.equal(unknown.modified, null);
  assert.equal(unknown.gitRef, null);
  assert.equal(unknown.version, '9.9.9', 'git이 없어도 버전은 파일에서 읽는다');
});

test('데이터가 더 새 형식이면 서버는 아예 시작하지 않는다(종료 코드 3)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-dataver-'));
  fs.writeFileSync(path.join(home, '.data-version'), '9\n');
  fs.writeFileSync(path.join(home, 'tasks.md'), '# Tasks\n');
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, WORKSPACE_DATA_DIR: home, WORKSPACE_PORT: String(port), WORKSPACE_NO_OPEN: '1', WORKSPACE_HOST: '', WORKSPACE_NO_REMOTE_CHECK: '1', WORKSPACE_CONFIG: path.join(home, 'absent.config.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  const code = await new Promise(resolve => child.on('exit', resolve));
  assert.equal(code, 3);
  assert.match(log, /더 새 버전의 앱이 만든 거예요/);
  assert.equal(fs.readFileSync(path.join(home, 'tasks.md'), 'utf8'), '# Tasks\n', '데이터는 손대지 않는다');
  fs.rmSync(home, { recursive: true, force: true });
});

test('migrate.js는 버전이 없으면 1로 보고, 같으면 아무것도 하지 않고, 더 높으면 멈춘다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-migrate-'));
  // 1) 빈 폴더 — 파일이 없으면 지금 형식(1)으로 보고, 조회만으로 파일을 만들지 않는다
  assert.equal(migrateStore.readDataVersion(home), 1);
  assert.equal(fs.existsSync(path.join(home, '.data-version')), false);

  // 2) 같은 버전 — 아무 일도 없다
  const same = migrateStore.migrate(home);
  assert.deepEqual(same.applied, []);
  assert.equal(fs.existsSync(path.join(home, '.data-version')), false, '바꿀 것이 없으면 파일도 만들지 않는다');

  // 3) 더 새 형식 — 옛 앱이 새 데이터를 망치지 않게 멈춘다(CLI는 종료 코드 3)
  fs.writeFileSync(path.join(home, '.data-version'), '9\n');
  assert.equal(migrateStore.migrate(home).ok, false);
  const cli = spawnSync(process.execPath, [path.join(__dirname, 'migrate.js'), '--data', home], { encoding: 'utf8' });
  assert.equal(cli.status, 3);
  assert.match(cli.stderr, /더 새 버전의 앱이 만든 거예요/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('migrate.js는 단계를 번호 순서대로 밟고 .data-version을 갱신하며, --dry-run은 아무것도 바꾸지 않는다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-migrate-steps-'));
  const trail = path.join(home, 'trail.txt');
  const steps = {
    2: dir => fs.appendFileSync(path.join(dir, 'trail.txt'), '2'),
    3: dir => fs.appendFileSync(path.join(dir, 'trail.txt'), '3'),
  };
  const dry = migrateStore.migrate(home, { to: 3, steps, dryRun: true });
  assert.deepEqual(dry.applied, [2, 3]);
  assert.equal(fs.existsSync(trail), false, '확인만 할 때는 파일을 건드리지 않는다');
  assert.equal(fs.existsSync(path.join(home, '.data-version')), false);

  const done = migrateStore.migrate(home, { to: 3, steps });
  assert.deepEqual(done.applied, [2, 3]);
  assert.equal(fs.readFileSync(trail, 'utf8'), '23', '번호가 작은 단계부터 밟는다');
  assert.equal(migrateStore.readDataVersion(home), 3);
  assert.deepEqual(migrateStore.migrate(home, { to: 3, steps }).applied, [], '두 번 밟지 않는다');
  fs.rmSync(home, { recursive: true, force: true });
});

test('자동화 스크립트는 설치 위치를 workspace.env에서 찾고, 그것도 없으면 안내하고 멈춘다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-env-'));
  const claude = path.join(home, 'fake-claude.sh');
  writeExec(claude, '#!/bin/bash\necho "됐어요"\n');
  const envFile = path.join(home, 'workspace.env');
  fs.writeFileSync(envFile, `WORKSPACE_DIR="${home}"\n`);
  const shared = { WORKSPACE_DIR: '', AUTOMATION_LOG_DIR: path.join(home, 'logs'), CLAUDE_BIN: claude };

  const found = runScript(automationScript('run-task.sh'), ['envok', '프롬프트', 'Read'], { ...shared, WORKSPACE_ENV_FILE: envFile });
  assert.equal(found.status, 0, 'setup.sh가 적어 둔 파일에서 설치 위치를 찾는다');
  assert.match(fs.readFileSync(path.join(home, 'logs', 'envok.log'), 'utf8'), /envok 종료 \(exit 0\)/);

  const missing = path.join(home, 'no-such.env');
  for (const script of ['run-task.sh', 'slack-capture.sh', 'backup-data.sh']) {
    const args = script === 'run-task.sh' ? ['envfail', '프롬프트', 'Read'] : [];
    const result = runScript(automationScript(script), args, { ...shared, WORKSPACE_ENV_FILE: missing, SLACK_CAPTURE_IGNORE_HOURS: '1' });
    assert.equal(result.status, 1, `${script}은 설치 정보가 없으면 멈춘다`);
    assert.match(result.stderr, /설치 정보를 찾을 수 없어요 — setup.sh를 먼저 실행해 주세요/);
  }
  fs.rmSync(home, { recursive: true, force: true });
});

// update.sh — 임시 폴더 안에 "원격 저장소(bare) + 내려받은 복사본"을 통째로 만들어 돌린다.
// PATH 앞에 가짜 `launchctl`·`curl`을 세우므로 이 테스트는 실제 앱·실제 맥 스케줄러에 닿지 않는다.
const REPO_ROOT = path.join(__dirname, '..', '..');
function updateFixture(t, { channel = 'stable' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-update-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const origin = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  const clone = path.join(root, 'clone');
  const bin = path.join(root, 'bin');
  const backups = path.join(root, 'backups');
  fs.mkdirSync(bin);
  writeExec(path.join(bin, 'launchctl'), `#!/bin/bash\necho "$@" >> ${JSON.stringify(path.join(root, 'launchctl.log'))}\nexit 0\n`);
  writeExec(path.join(bin, 'curl'), `#!/bin/bash\nprintf '{"version":"%s","dataFormat":1}' "$(tr -d '[:space:]' < ${JSON.stringify(path.join(clone, 'VERSION'))})"\n`);

  fs.mkdirSync(path.join(seed, 'tracker', 'inbox-app', 'automation'), { recursive: true });
  for (const rel of ['update.sh', 'tracker/inbox-app/migrate.js', 'tracker/inbox-app/safe-storage.js',
    'tracker/inbox-app/automation/run-task.sh', 'tracker/inbox-app/automation/slack-capture.sh', 'tracker/inbox-app/automation/backup-data.sh']) {
    fs.copyFileSync(path.join(REPO_ROOT, rel), path.join(seed, rel));
  }
  fs.writeFileSync(path.join(seed, 'VERSION'), '1.0.0\n');
  fs.writeFileSync(path.join(seed, 'ui.css'), 'body{}\n');
  fs.writeFileSync(path.join(seed, '.gitignore'), 'workspace.config.json\ntracker/*.md\ntracker/.*\n.workspace-last-good\n');
  runGit(seed, ['init', '-b', 'main']);
  runGit(seed, ['add', '-A']);
  runGit(seed, ['commit', '-m', '첫 버전']);
  runGit(seed, ['tag', 'v1.0.0']);
  fs.writeFileSync(path.join(seed, 'VERSION'), '1.1.0\n');
  fs.writeFileSync(path.join(seed, 'ui.css'), 'body{color:blue}\n');
  runGit(seed, ['commit', '-am', '다음 버전']);
  runGit(seed, ['tag', 'v1.1.0']);
  runGit(root, ['init', '--bare', '-b', 'main', origin]);
  runGit(seed, ['remote', 'add', 'origin', origin]);
  runGit(seed, ['push', '-q', 'origin', 'main', '--tags']);
  runGit(root, ['clone', '-q', origin, clone]);
  // 동료의 맥은 배포된 태그(stable)에 고정돼 있고, 나는 main 갈래를 따라간다.
  if (channel === 'main') runGit(clone, ['reset', '--hard', '-q', 'v1.0.0']);
  else runGit(clone, ['checkout', '--detach', '-q', 'v1.0.0']);

  fs.writeFileSync(path.join(clone, 'workspace.config.json'), JSON.stringify({ server: { updateChannel: channel, port: 4399 } }, null, 2));
  fs.writeFileSync(path.join(clone, 'tracker', 'tasks.md'), '# Tasks\n- 지켜야 할 업무\n');
  fs.writeFileSync(path.join(clone, 'tracker', '.workflow.json'), '{"items":{},"meetings":{}}');

  // `extra`는 물음에 답을 넣거나(input) 환경을 하나 더 끼울 때만 쓴다 — 주지 않으면 예전 그대로다.
  const run = (args = [], extra = {}) => spawnSync('/bin/bash', [path.join(clone, 'update.sh'), ...args], {
    cwd: clone, encoding: 'utf8', timeout: 120000, input: extra.input,
    // 이 테스트 파일이 쓰는 WORKSPACE_DATA_DIR이 새어 들어가면 안 된다 — 복사본 안의 tracker/를 보게 비운다.
    env: { ...gitEnv, WORKSPACE_DATA_DIR: '', HOME: root, PATH: `${bin}:${process.env.PATH}`, WORKSPACE_BACKUP_DIR: backups, WORKSPACE_INSTALL_DIR: path.join(root, 'install'), ...(extra.env || {}) },
  });
  const dated = () => (fs.existsSync(backups) ? fs.readdirSync(backups) : []).filter(name => /^\d{4}-\d{2}-\d{2}-\d{4}$/.test(name)).sort();
  const versionOf = () => fs.readFileSync(path.join(clone, 'VERSION'), 'utf8').trim();
  const tasks = () => fs.readFileSync(path.join(clone, 'tracker', 'tasks.md'), 'utf8');
  return { root, clone, backups, run, dated, versionOf, tasks };
}

test('update.sh: 깨끗한 트리에서는 배포된 최신 버전으로 옮기고, 데이터를 먼저 백업하고 최근 5개만 남긴다', { skip: !gitReady }, (t) => {
  const fix = updateFixture(t);
  fs.mkdirSync(fix.backups, { recursive: true });
  for (const day of ['01', '02', '03', '04', '05', '06']) fs.mkdirSync(path.join(fix.backups, `2020-01-${day}-0900`));
  fs.mkdirSync(path.join(fix.backups, '내가-만든-폴더'));

  const result = fix.run(['--yes']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const step of ['[1/6]', '[2/6]', '[3/6]', '[4/6]', '[5/6]', '[6/6]']) assert.ok(result.stdout.includes(step), `${step} 줄이 보인다`);
  assert.match(result.stdout, /v1\.1\.0으로 업데이트했어요/);
  assert.equal(fix.versionOf(), '1.1.0');
  assert.match(fix.tasks(), /지켜야 할 업무/, '업무 데이터는 그대로다');

  const dated = fix.dated();
  assert.equal(dated.length, 5, '이 스크립트가 만든 백업은 최근 5개만 남긴다');
  assert.ok(fs.existsSync(path.join(fix.backups, '내가-만든-폴더')), '이름 규칙이 다른 폴더는 건드리지 않는다');
  const newest = path.join(fix.backups, dated[dated.length - 1]);
  assert.match(fs.readFileSync(path.join(newest, 'tasks.md'), 'utf8'), /지켜야 할 업무/);
  assert.ok(fs.existsSync(path.join(newest, '.workflow.json')));
  assert.ok(fs.existsSync(path.join(newest, 'workspace.config.json')));

  const calls = fs.readFileSync(path.join(fix.root, 'launchctl.log'), 'utf8');
  assert.match(calls, /kickstart -k gui\/\d+\/com\.workspace\.app\.server/, '정확한 이름 하나에만 부탁한다');
  assert.doesNotMatch(calls, /pkill|killall/);
});

test('update.sh: 고친 파일을 그대로 두기로 하면 업데이트를 멈추고 데이터를 지킨다', { skip: !gitReady }, (t) => {
  const fix = updateFixture(t);
  fs.writeFileSync(path.join(fix.clone, 'ui.css'), '/* 내가 고친 것 */\n');

  const result = fix.run(['--yes']);   // --yes는 "그대로 두기"를 고른다
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /고친 파일이 있어요: ui\.css/);
  assert.match(result.stdout, /고친 파일 때문에 업데이트를 이어 갈 수 없어요/);
  assert.equal(fs.readFileSync(path.join(fix.clone, 'ui.css'), 'utf8'), '/* 내가 고친 것 */\n', '고친 파일을 덮어쓰지 않는다');
  assert.equal(fix.versionOf(), '1.0.0');
  assert.match(fix.tasks(), /지켜야 할 업무/, '멈춰도 업무 데이터는 그대로다');
  assert.equal(fix.dated().length, 1, '멈추기 전에 백업은 이미 만들어 둔다');
});

test('update.sh --rollback은 이전 코드와 백업 데이터를 함께 되돌린다', { skip: !gitReady }, (t) => {
  const fix = updateFixture(t);
  assert.equal(fix.run(['--yes']).status, 0);
  assert.equal(fix.versionOf(), '1.1.0');
  // 새 버전에서 데이터가 망가진 상황을 흉내 낸다
  fs.writeFileSync(path.join(fix.clone, 'tracker', 'tasks.md'), '# Tasks\n- 망가진 내용\n');

  const back = fix.run(['--rollback', '--yes']);
  assert.equal(back.status, 0, back.stdout + back.stderr);
  assert.equal(fix.versionOf(), '1.0.0', '코드는 이전 자리로 돌아간다');
  assert.match(fix.tasks(), /지켜야 할 업무/, '데이터도 백업에서 돌아온다');
  assert.equal(fs.existsSync(path.join(fix.clone, '.workspace-last-good')), false, '두 번 되돌리지 않는다');
});

// 고친 내용을 보관하지 못했는데 되돌리면 그 내용이 그대로 사라진다(최종 QA). 보관에 실패하면
// 지우지 않고 멈춘다. `git stash create`가 빈 값을 주는 상황은 명령을 바꿔 끼워 흉내 낸다.
test('update.sh: 고친 내용을 보관하지 못하면 되돌리지 않고 멈춘다', { skip: !gitReady }, (t) => {
  const fix = updateFixture(t);
  fs.writeFileSync(path.join(fix.clone, 'ui.css'), '/* 내가 고친 것 */\n');

  // `되돌리고 받을까요? [y]`에 y라고 답하는데, 보관이 실패한다
  const result = fix.run([], { input: 'y\n', env: { WORKSPACE_STASH_CREATE: 'true' } });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /고친 내용을 보관하지 못해 멈췄어요/);
  assert.equal(fs.readFileSync(path.join(fix.clone, 'ui.css'), 'utf8'), '/* 내가 고친 것 */\n', '고친 내용은 지워지지 않는다');
  assert.equal(fix.versionOf(), '1.0.0', '멈췄으니 새 버전을 받지도 않는다');
  assert.match(fix.tasks(), /지켜야 할 업무/);

  // 보관이 되면 예전처럼 가지에 담고 되돌린 뒤 이어 간다
  const ok = fix.run([], { input: 'y\n' });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /고친 내용을 local-changes-[0-9-]+ 가지에 담아 뒀어요/);
  assert.equal(fix.versionOf(), '1.1.0');
  assert.doesNotMatch(fs.readFileSync(path.join(fix.clone, 'ui.css'), 'utf8'), /내가 고친 것/);
  assert.match(runGit(fix.clone, ['branch', '--list', 'local-changes-*']).stdout, /local-changes-/, '고친 내용은 가지로 남아 있다');
});

test('update.sh: main 갈래는 태그가 아니라 origin/main을 앞으로만 따라간다', { skip: !gitReady }, (t) => {
  const fix = updateFixture(t, { channel: 'main' });
  const result = fix.run(['--yes']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fix.versionOf(), '1.1.0');
  assert.equal(runGit(fix.clone, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim(), 'main', '갈래를 떼어 놓지 않는다');
  assert.equal(runGit(fix.clone, ['rev-parse', 'HEAD']).stdout.trim(), runGit(fix.clone, ['rev-parse', 'origin/main']).stdout.trim());
});

// ─────────────────────────────────────────────────────────────────────────────
// 설정 > 연동 (WP-B) — 앱이 `workspace.config.json`을 쓰는 단 하나의 자리
//
// 여기서도 **실제 설정·실제 토큰 파일·실제 지라/슬랙에는 절대 닿지 않는다**: config는 임시 폴더에
// 따로 만든 파일이고, 토큰 폴더도 임시 폴더를 끼우며(WORKSPACE_TOKEN_DIR), 바깥으로 나가는 길은
// 전부 가짜 fetch다. 프로세스를 끝내는 `exit`도 끼워 넣으므로 테스트가 스스로 종료되지 않는다.
const integrationsStore = require('./integrations');

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
  assert.deepEqual(info, { name: 'my-todo', isPrivate: true });
  assert.match(calls[0].url, /conversations\.info\?channel=C0123ABCD$/);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer slack-secret');

  const bad = async () => json({ ok: false, error: 'channel_not_found' });
  await assert.rejects(() => integrationsStore.slackCheckChannel('t', 'C1', bad), /슬랙에서 이 채널을 읽지 못했어요/);
});

// 임시 config + 임시 토큰 폴더 한 벌. 실제 `~/.config`·실제 설정에는 닿지 않는다.
function integrationsFixture(t, seed = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-integrations-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const configPath = path.join(home, 'workspace.config.json');
  fs.writeFileSync(configPath, JSON.stringify(seed, null, 2));
  const tokenDir = path.join(home, 'config');
  const read = () => JSON.parse(fs.readFileSync(configPath, 'utf8'));
  return { home, configPath, tokenDir, read };
}

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

test('연동 저장: 슬랙은 todo 하나만 필수이고 나머지 셋은 선택, 채널 이름은 슬랙이 준 것으로 적는다', async (t) => {
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
    slackCheck: async (token, id) => { asked.push([token, id]); return { name: id === 'C0TODO11' ? 'my-todo' : 'my-waiting', isPrivate: id === 'C0TODO11' }; },
  });
  const saved = fix.read();
  assert.deepEqual(asked, [['slack-secret', 'C0TODO11'], ['slack-secret', 'C0WAIT11']]);
  assert.deepEqual(saved.slack.channels.todo, { id: 'C0TODO11', name: '#my-todo' });
  assert.deepEqual(saved.slack.channels.waiting, { id: 'C0WAIT11', name: '#my-waiting' });
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
    slackCheck: async () => ({ name: 'my-todo', isPrivate: true }),
  });
  const saved = fix.read();
  assert.deepEqual(Object.keys(saved.slack.channels), ['todo'], '채우지 않은 세 칸은 사라진다');
  assert.deepEqual(saved.slack.channels.todo, { id: 'C0TODO11', name: '#my-todo' });
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

// setup.sh는 실행하지 않는다(실제 launchd·홈 폴더를 건드린다) — 설정을 읽는 그 조각만 꺼내 돌린다.
test('setup.sh: 설정은 python3가 아니라 node로 읽고, 못 읽으면 에이전트를 내리기 전에 멈춘다', () => {
  const script = fs.readFileSync(path.join(REPO_ROOT, 'setup.sh'), 'utf8');
  assert.ok(!script.includes('json.load(open('), '설정을 python3로 읽던 자리는 남아 있지 않다');
  for (const key of ['slack', 'calendar', 'jira', 'tiro']) {
    assert.ok(script.includes(`config_read uses ${key})`) && script.includes('|| die "$CONFIG_UNREADABLE"'),
      `${key}는 읽기에 실패하면 멈춘다(꺼진 것으로 읽지 않는다)`);
  }
  const reader = script.split("CONFIG_READER='")[1].split("\n'\n")[0];

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-setup-read-'));
  const config = path.join(home, 'workspace.config.json');
  const read = (...args) => spawnSync(process.execPath, ['-e', reader, config, ...args], { encoding: 'utf8' });

  fs.writeFileSync(config, JSON.stringify({
    integrations: { slack: false, calendar: true },
    server: { port: 4399, chromeProfile: 'Profile 1' },
    slack: { tokenFile: '~/.config/workspace-slack-token' },
  }));
  assert.equal(read('uses', 'slack').stdout, 'no');
  assert.equal(read('uses', 'calendar').stdout, 'yes');
  assert.equal(read('uses', 'jira').stdout, 'yes', '칸이 없으면 켜진 것이다(서버 USES와 같은 규칙)');
  assert.equal(read('server', 'port').stdout, '4399');
  assert.equal(read('server', 'extraHost').stdout, '', '없는 칸은 빈 값이다');
  assert.equal(read('chromeProfile').stdout, 'Profile 1');
  assert.equal(read('slackToken').stdout, path.join(os.homedir(), '.config', 'workspace-slack-token'));

  // 이 값은 쉘 명령에 들어간다 — 폴더 이름에 쓰이는 글자만 통과한다
  fs.writeFileSync(config, JSON.stringify({ server: { chromeProfile: "'; rm -rf ~" } }));
  assert.equal(read('chromeProfile').stdout, '');

  // 깨진 설정은 "빈 값"이 아니라 오류다 — setup.sh는 여기서 멈춘다
  fs.writeFileSync(config, '{망가짐');
  assert.notEqual(read('uses', 'slack').status, 0);
  assert.equal(read('uses', 'slack').stdout, '');
  fs.rmSync(home, { recursive: true, force: true });
});

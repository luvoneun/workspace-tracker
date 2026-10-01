// Manual browser QA server: isolated temporary records, never the personal tracker.
// 데이터뿐 아니라 설정·토큰·자동화 폴더·LaunchAgents·local/·Applications·백업 폴더·저장소 자리까지 전부 임시 폴더 하나 아래로 끼운다.
// WORKSPACE_FIXTURE=1이면 서버가 그중 하나라도 실제 설치 위치를 가리킬 때 시작하지 않는다(server.js의 안전망).
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');

// "연결된 슬랙" 가짜 상태(`WORKSPACE_FIXTURE_SLACK`) — 연결된 카드·⋯ 메뉴·풀림 카드·점검하기 줄을 화면으로 보려는 것.
//   token      옛 방식(토큰 붙여 넣기)으로 연결됨 — ⋯ 에 `새 방식으로 다시 연결`이 보인다
//   oauth      새 방식 정상(자동 갱신 켜짐, 9시간 남음, 옛 토큰 보관분 있음)
//   oauth-retry 새 방식인데 갱신이 잠시 안 됨(멈춤 아님)
//   oauth-lost 새 방식 연결이 풀림(다시 연결 필요)
// 전부 임시 폴더의 가짜 값이다 — 진짜 토큰이 아니고 슬랙에 요청하지 않는다(픽스처는 바깥 확인을 끈 자리다).
const SLACK_STATES=['token','oauth','oauth-retry','oauth-lost'];
function seedSlack({config,tokens,data,agents},kind) {
  if(!SLACK_STATES.includes(kind))return;
  const {REQUIRED_SCOPES}=require('./slack-auth');
  const now=Date.now(),hour=60*60*1000;
  config.integrations={...(config.integrations||{}),slack:true};
  config.slack={...(config.slack||{}),tokenFile:path.join(tokens,'workspace-slack-token'),workspaceUrl:'https://fixture-team.slack.com',
    channels:{todo:{id:'C0FIXTODO1',name:'#my-todo'},waiting:{id:'C0FIXWAIT1',name:'#my-waiting'}}};
  const secret=(name,text)=>fs.writeFileSync(path.join(tokens,name),text,{mode:0o600});
  if(kind==='token') {
    secret('workspace-slack-token','xoxp-fixture-not-a-real-token\n');
  } else {
    config.slack.auth='oauth';
    const savedAt=now-3*hour;
    secret('workspace-slack-token','xoxe.xoxp-fixture-not-a-real-token\n');
    secret('workspace-slack-token.legacy','xoxp-fixture-old-not-a-real-token\n');
    secret('workspace-slack-oauth.json',`${JSON.stringify({version:1,accessToken:'xoxe.xoxp-fixture-not-a-real-token',refreshToken:'xoxe-1-fixture-not-a-real-token',
      expiresAt:now+9*hour,teamId:'T0FIXTURE',teamName:'가짜 팀',userId:'U0FIXTURE',scopes:REQUIRED_SCOPES,clientId:'0.0',
      connectedAt:now-48*hour,refreshedAt:savedAt,savedAt,legacyKeptAt:now-48*hour},null,2)}\n`);
    const failure={'oauth-retry':{kind:'retry',reason:'network'},'oauth-lost':{kind:'reconnect',reason:'slack_error',code:'invalid_refresh_token'}}[kind];
    if(failure)secret('workspace-slack-oauth.json.state',`${JSON.stringify({failure,at:now-5*60*1000,failCount:failure.kind==='retry'?1:0,savedAt})}\n`);
  }
  // 수집이 등록돼 있고 10분 전에 읽은 것처럼 — 카드 상태 줄이 `#my-todo 외 1개 · 10분 전 읽음`으로 나온다.
  for(const name of ['slack-capture','slack-capture-now'])fs.writeFileSync(path.join(agents,`com.workspace.app.${name}.plist`),'');
  const at=new Date(now-10*60*1000).toISOString();
  fs.writeFileSync(path.join(data,'.slack_capture_state.json'),JSON.stringify({lastSuccessAt:at,lastAttemptAt:at,checkedAt:at,lastError:null}));
}

// 임시 폴더를 만들고 서버에 넘길 환경변수 한 벌을 돌려준다(테스트도 이 함수를 그대로 쓴다).
// `slack`은 위의 가짜 슬랙 상태 이름(없으면 예전처럼 연결 안 한 상태).
function prepareFixture({slack}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'workspace-browser-'));
  const dir=name=>{const at=path.join(root,name);fs.mkdirSync(at,{recursive:true});return at;};
  const data=dir('data'),repo=dir('repo'),local=dir('repo/local'),tokens=dir('tokens'),automation=dir('automation'),agents=dir('LaunchAgents'),apps=dir('Applications'),backup=dir('workspace-data-backup');
  // 화면의 버전 줄이 비지 않게 VERSION만 복사한다(git 기록은 없다 — 고친 파일·원격 확인은 조용히 비어 있다).
  try{fs.copyFileSync(path.join(__dirname,'..','..','VERSION'),path.join(repo,'VERSION'));}catch{/* 없으면 버전 모름 */}
  // 예시 설정을 복사하되 토큰·비밀 주소 파일 칸은 임시 토큰 폴더를 가리키게 바꾼다.
  let config={};
  try{config=JSON.parse(fs.readFileSync(path.join(__dirname,'..','..','workspace.config.example.json'),'utf8'));}catch{config={};}
  if(config.slack)config.slack.tokenFile=path.join(tokens,'workspace-slack-token');
  if(config.jira)config.jira.tokenFile=path.join(tokens,'workspace-jira-token');
  if(config.calendar&&config.calendar.icalFile)config.calendar.icalFile=path.join(tokens,'workspace-calendar-ical');
  seedSlack({config,tokens,data,agents},slack);
  const configPath=path.join(repo,'workspace.config.json');
  fs.writeFileSync(configPath,`${JSON.stringify(config,null,2)}\n`);
  const d=new Date(),date=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  fs.writeFileSync(path.join(data,'tasks.md'),`# Tasks\n- 가입 오류 문구 검토하기 #task[id:a status:done created:${date} completed:${date} group:가입_개선]\n- 빈 화면 안내 확인하기 #task[id:b status:done created:${date} completed:${date} group:가입_개선]\n- 운영툴 권한 확인하기 #task[id:c status:to-do created:${date} doing:${date} scheduled:${date} group:운영툴]\n`);
  fs.writeFileSync(path.join(data,'decisions.md'),`- 권한 정책은 기존 방식 유지 #decision[id:d status:to-do created:${date} group:운영툴]\n`);
  const env={
    WORKSPACE_FIXTURE:'1',
    WORKSPACE_DATA_DIR:data,
    WORKSPACE_CONFIG:configPath,
    WORKSPACE_REPO_DIR:repo,
    WORKSPACE_LOCAL_DIR:local,
    WORKSPACE_TOKEN_DIR:tokens,
    WORKSPACE_AUTOMATION_DIR:automation,
    WORKSPACE_LAUNCH_AGENTS_DIR:agents,
    WORKSPACE_APPLICATIONS_DIR:apps,
    // 설정 › 앱의 `데이터 백업` 줄이 읽는 자리 — 실제 ~/workspace-data-backup을 보지 않게.
    WORKSPACE_BACKUP_DIR:backup,
    WORKSPACE_NO_OPEN:'1',
    WORKSPACE_NO_REMOTE_CHECK:'1',
  };
  return {root,env};
}

if(require.main===module){
  const slackState=process.env.WORKSPACE_FIXTURE_SLACK||'';
  if(slackState&&!SLACK_STATES.includes(slackState)){console.error(`WORKSPACE_FIXTURE_SLACK은 ${SLACK_STATES.join(' · ')} 중 하나예요`);process.exit(1);}
  const {root,env}=prepareFixture({slack:slackState});
  Object.assign(process.env,env);
  const port=Number(process.env.WORKSPACE_FIXTURE_PORT||4322);
  const serverModule=require('./server');const {server}=serverModule;
  // 가짜 슬랙 상태를 켰으면 점검하기의 슬랙 확인(auth.test·conversations.info)에만 가짜 답을 끼운다 — 그 밖의 주소는 예전처럼 막힌다.
  if(slackState){
    const answer=body=>new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
    serverModule.setSelfcheckFetchForTests(async(url)=>{
      const text=String(url);
      if(text.startsWith('https://slack.com/api/auth.test'))return answer({ok:true,user:'fixture'});
      if(text.startsWith('https://slack.com/api/conversations.info'))return answer({ok:true,channel:{name:'my-todo',is_private:true,created:1}});
      throw new Error('바깥 확인을 끈 자리예요');
    });
  }
  // 체크인 창(WP-N)은 픽스처에서 기본 꺼짐이다. `WORKSPACE_CHECKIN=1`이면 켜고, 실제 구글 대신 가짜 전송을 끼운다
  // (`WORKSPACE_CHECKIN_FAKE=fail`이면 보내기가 실패해 대기로 남는다). `WORKSPACE_CHECKIN_DAYS=3`(또는 8)이면 그만큼 전에 설치한 것처럼 시작한다.
  if(process.env.WORKSPACE_CHECKIN==='1'){
    const fail=process.env.WORKSPACE_CHECKIN_FAKE==='fail';
    serverModule.setCheckinFetchForTests(async()=>{if(fail)throw new Error('가짜 오프라인');return new Response('ok',{status:200});});
    const days=Number(process.env.WORKSPACE_CHECKIN_DAYS||0);
    if(days>0){
      const day=n=>{const d=new Date();d.setDate(d.getDate()-n);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
      const openDays=[...Array(days>=8?5:2).keys()].map(n=>day(n+1)).reverse();
      fs.writeFileSync(path.join(env.WORKSPACE_LOCAL_DIR,'checkin.json'),JSON.stringify({id:'fixture-anon',firstDay:day(days),openDays,rounds:{d3:{state:'pending'},d8:{state:'pending'}}},null,2));
    }
  }
  server.listen(port,'127.0.0.1',()=>console.log(`Isolated browser QA: http://localhost:${port}`));
  // Ctrl+C(SIGINT)·kill <PID>(SIGTERM) 모두 임시 폴더를 치우고 끝난다.
  const stop=()=>{if(server.closeAllConnections)server.closeAllConnections();server.close(()=>{fs.rmSync(root,{recursive:true,force:true});process.exit(0);});};
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
}

module.exports={prepareFixture,SLACK_STATES};

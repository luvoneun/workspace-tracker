// Manual browser QA server: isolated temporary records, never the personal tracker.
// 데이터뿐 아니라 설정·토큰·자동화 폴더·LaunchAgents·local/·Applications·저장소 자리까지 전부 임시 폴더 하나 아래로 끼운다.
// WORKSPACE_FIXTURE=1이면 서버가 그중 하나라도 실제 설치 위치를 가리킬 때 시작하지 않는다(server.js의 안전망).
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');

// 임시 폴더를 만들고 서버에 넘길 환경변수 한 벌을 돌려준다(테스트도 이 함수를 그대로 쓴다).
function prepareFixture() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'workspace-browser-'));
  const dir=name=>{const at=path.join(root,name);fs.mkdirSync(at,{recursive:true});return at;};
  const data=dir('data'),repo=dir('repo'),local=dir('repo/local'),tokens=dir('tokens'),automation=dir('automation'),agents=dir('LaunchAgents'),apps=dir('Applications');
  // 화면의 버전 줄이 비지 않게 VERSION만 복사한다(git 기록은 없다 — 고친 파일·원격 확인은 조용히 비어 있다).
  try{fs.copyFileSync(path.join(__dirname,'..','..','VERSION'),path.join(repo,'VERSION'));}catch{/* 없으면 버전 모름 */}
  // 예시 설정을 복사하되 토큰·비밀 주소 파일 칸은 임시 토큰 폴더를 가리키게 바꾼다.
  let config={};
  try{config=JSON.parse(fs.readFileSync(path.join(__dirname,'..','..','workspace.config.example.json'),'utf8'));}catch{config={};}
  if(config.slack)config.slack.tokenFile=path.join(tokens,'workspace-slack-token');
  if(config.jira)config.jira.tokenFile=path.join(tokens,'workspace-jira-token');
  if(config.calendar&&config.calendar.icalFile)config.calendar.icalFile=path.join(tokens,'workspace-calendar-ical');
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
    WORKSPACE_NO_OPEN:'1',
    WORKSPACE_NO_REMOTE_CHECK:'1',
  };
  return {root,env};
}

if(require.main===module){
  const {root,env}=prepareFixture();
  Object.assign(process.env,env);
  const port=Number(process.env.WORKSPACE_FIXTURE_PORT||4322);
  const {server}=require('./server');server.listen(port,'127.0.0.1',()=>console.log(`Isolated browser QA: http://localhost:${port}`));
  // Ctrl+C(SIGINT)·kill <PID>(SIGTERM) 모두 임시 폴더를 치우고 끝난다.
  const stop=()=>{if(server.closeAllConnections)server.closeAllConnections();server.close(()=>{fs.rmSync(root,{recursive:true,force:true});process.exit(0);});};
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
}

module.exports={prepareFixture};

// Manual browser QA server: isolated temporary records, never the personal tracker.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'workspace-browser-'));
process.env.WORKSPACE_DATA_DIR=directory;
const d=new Date(),date=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
fs.writeFileSync(path.join(directory,'tasks.md'),`# Tasks\n- 가입 오류 문구 검토하기 #task[id:a status:done created:${date} completed:${date} group:가입_개선]\n- 빈 화면 안내 확인하기 #task[id:b status:done created:${date} completed:${date} group:가입_개선]\n- 운영툴 권한 확인하기 #task[id:c status:to-do created:${date} doing:${date} scheduled:${date} group:운영툴]\n`);
fs.writeFileSync(path.join(directory,'decisions.md'),`- 권한 정책은 기존 방식 유지 #decision[id:d status:to-do created:${date} group:운영툴]\n`);
const {server}=require('./server');server.listen(4322,'127.0.0.1',()=>console.log('Isolated browser QA: http://localhost:4322'));
process.on('SIGINT',()=>server.close(()=>{fs.rmSync(directory,{recursive:true,force:true});process.exit(0);}));

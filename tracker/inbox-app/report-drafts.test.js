const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const factory=require('./report-drafts');
function fixture(t,legacy=[]) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'report-drafts-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const items=[{id:'a',type:'task',description:'문구 검토하기',status:'done',created:'2026-09-14',completed:'2026-09-15',group:'가입'}];
  const store=factory({directory,sources:()=>items,legacy:()=>legacy,currentWeek:()=> '2026-09-14'});
  const view=()=>store.view('2026-09-14');
  const change=(action)=>store.change({weekKey:'2026-09-14',revision:view().revision,...action});
  return {directory,items,store,view,change};
}
test('reading automatic drafts never writes and preserves source wording',t=>{
  const f=fixture(t);assert.equal(f.view().rows[0].text,'문구 검토');assert.deepEqual(fs.readdirSync(f.directory),[]);
});
test('edited sentences survive new evidence; proposal is explicit',t=>{
  const f=fixture(t),id=f.view().rows[0].id;f.change({action:'edit',id,text:'가입 문구 검토 완료'});
  f.items.push({...f.items[0],id:'b',description:'문구 검토하기 후속 확인'});
  const row=f.view().rows[0];assert.equal(row.text,'가입 문구 검토 완료');assert.equal(row.suggestion.added,1);
  f.change({action:'acknowledge',id});assert.equal(f.view().rows[0].text,'가입 문구 검토 완료');assert.equal(f.view().rows[0].suggestion,undefined);assert.equal(f.view().rows[0].sourceIds.length,2);
});
test('슬랙 원문처럼 긴 할 일 문구는 첫 문장(또는 80자)까지만 보고 문장이 되고, 짧은 문구·근거는 그대로다',t=>{
  const f=fixture(t);
  const long='결제 화면 오류 문의 대응하기. 고객센터에서 받은 스크린샷 세 장과 재현 절차를 정리해 두었어요! 다음 주 배포 전에 꼭 확인하고 담당자에게 다시 알려 주세요';
  f.items[0]={...f.items[0],description:long,status:'to-do',doing:'2026-09-15',completed:undefined};
  f.items.push({id:'v',type:'task',description:'v2.1 배포 확인하기',status:'done',created:'2026-09-14',completed:'2026-09-15',group:'배포'});
  f.items.push({id:'n',type:'task',description:'가'.repeat(120),status:'to-do',doing:'2026-09-15',created:'2026-09-14',group:'긴 글'});
  f.items.push({id:'s',type:'task',description:'1. 기획서 정리 2. 공유하기',status:'to-do',doing:'2026-09-15',created:'2026-09-14',group:'짧은 글'});
  f.items.push({id:'d',type:'decision',description:'환불은 7일. 그 뒤는 부분 환불',created:'2026-09-15',status:'to-do',group:'정책'});
  const rows=f.view().rows,byId=id=>rows.find(row=>row.sourceIds.includes(id));
  assert.equal(byId('a').text,'결제 화면 오류 문의 대응하기. 고객센터에서 받은 스크린샷 세 장과 재현 절차를 정리해 두었어요!','80자가 넘으면 20자 넘게 간 뒤 첫 문장 끝까지');
  assert.equal(byId('a').evidence[0].description,long,'근거에는 전문이 남는다');
  assert.equal(byId('v').text,'v2.1 배포 확인','버전 번호 속 점에서 자르지 않는다 · 짧은 문구는 예전 그대로');
  assert.equal(byId('n').text,`${'가'.repeat(80)}…`);
  assert.equal(byId('s').text,'1. 기획서 정리 2. 공유','80자 이하는 마침표가 있어도 자르지 않는다(끝말 `하기`만 뗀다)');
  assert.equal(byId('d').text,'환불은 7일. 그 뒤는 부분 환불','할 일이 아닌 것은 그대로');
});
test('stale revision cannot erase newly collected work',t=>{
  const f=fixture(t),old=f.view();f.items.push({...f.items[0],id:'b'});
  assert.throws(()=>f.store.change({weekKey:old.weekKey,revision:old.revision,action:'edit',id:old.rows[0].id,text:'old'}),error=>error.status===409);
  assert.equal(f.view().rows[0].sourceIds.length,2);
});
test('excluded work remains available and new work does not reuse its identity',t=>{
  const f=fixture(t),id=f.view().rows[0].id;f.change({action:'exclude',id});f.items.push({...f.items[0],id:'b'});
  const rows=f.view().rows;assert.equal(rows.length,2);assert.equal(new Set(rows.map(row=>row.id)).size,2);assert.equal(rows.filter(row=>!row.excluded).length,1);
  f.change({action:'exclude',id});assert.equal(f.view().rows.filter(row=>row.excluded).length,0);
});
test('legacy prose and private archived work are preserved',t=>{
  const f=fixture(t,[{weekKey:'2026-09-14',body:'**완료한 일**\n- 내가 수정한 문장 ^a\n**조용히 완료한 일**\n- 보고 제외 문장'}]);
  assert.equal(f.view().rows[0].text,'내가 수정한 문장');assert.equal(f.view().rows[1].excluded,true);
});
test('past report never imports future decisions or current running tasks',t=>{
  const f=fixture(t);f.items.push({id:'d',type:'decision',description:'새 결정',created:'2026-09-20',status:'to-do'},{id:'r',type:'task',description:'진행',created:'2026-09-07',doing:'2026-09-08',status:'to-do'});
  assert.equal(f.store.view('2026-09-07').rows.length,0);
});
test('merge rejects completion-state mixing and undo restores edited text',t=>{
  const f=fixture(t);f.items.push({...f.items[0],id:'b',status:'to-do',doing:'2026-09-15'});
  assert.throws(()=>f.change({action:'merge',ids:f.view().rows.map(row=>row.id)}));
  const id=f.view().rows[0].id,result=f.change({action:'edit',id,text:'편집'});f.change({action:'undo',token:result.undoToken});assert.equal(f.view().rows[0].text,'문구 검토');
});
test('corrupt report storage is never silently reset',t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.directory,'.report-drafts.json'),'{bad');assert.throws(()=>f.view());assert.equal(fs.readFileSync(path.join(f.directory,'.report-drafts.json'),'utf8'),'{bad');
});
test('transaction failure restores only touched files',t=>{
  const f=fixture(t),a=path.join(f.directory,'tasks.md'),b=path.join(f.directory,'checks.md');fs.writeFileSync(a,'before');
  const tx=require('./mutation-store')(f.directory),{atomicWrite}=require('./safe-storage');
  assert.throws(()=>tx.run(()=>{atomicWrite(a,'after');atomicWrite(b,'new');throw new Error('failure');}));
  assert.equal(fs.readFileSync(a,'utf8'),'before');assert.equal(fs.existsSync(b),false);assert.equal(fs.existsSync(path.join(f.directory,'.mutation.lock')),false);
});
test('a refused restore pauses saving instead of looking busy',t=>{
  const f=fixture(t),file=path.join(f.directory,'tasks.md'),journal=path.join(f.directory,'.mutation-journal.json'),lock=path.join(f.directory,'.mutation.lock');
  fs.writeFileSync(file,'before');
  const tx=require('./mutation-store')(f.directory),{atomicWrite}=require('./safe-storage');
  // 거래가 건드린 파일을 바깥에서 다시 고친 뒤 실패시킨다 — 되돌리면 그 수정이 사라진다.
  assert.throws(()=>tx.run(()=>{atomicWrite(file,'after');fs.writeFileSync(file,'외부 편집');throw new Error('저장 실패');}),error=>error.status===503 && error.code==='RECOVERY_NEEDED');
  assert.equal(fs.readFileSync(file,'utf8'),'외부 편집');
  assert.ok(fs.existsSync(journal));assert.ok(fs.existsSync(lock));
  assert.equal(tx.status().recoveryNeeded,true);assert.match(tx.status().reason,/저장 실패.*밖에서 바뀐 파일/);
  const kept=[file,journal,lock].map(name=>fs.readFileSync(name,'utf8'));
  assert.throws(()=>tx.run(()=>{throw new Error('실행되면 안 된다');}),error=>error.status===503 && error.code==='RECOVERY_NEEDED' && /저장을 멈췄어요/.test(error.message));
  assert.deepEqual([file,journal,lock].map(name=>fs.readFileSync(name,'utf8')),kept);
});
test('Slack history collects every page, and never returns partial success',async()=>{
  const {history}=require('./slack-history');let calls=0;
  const request=async()=>({ok:true,json:async()=>++calls===1?{ok:true,messages:[{ts:'2'}],has_more:true,response_metadata:{next_cursor:'next'}}:{ok:true,messages:[{ts:'1'}],has_more:false}});
  assert.equal((await history({token:'fixture',channel:'C',request})).messages.length,2);
  await assert.rejects(history({token:'fixture',channel:'C',request:async()=>({ok:true,json:async()=>({ok:true,messages:[],has_more:true})})}));
});

test('untouched completed work stays discoverable after the week changes',t=>{
  const f=fixture(t);f.items[0].created='2026-09-01';f.items[0].completed='2026-09-02';
  assert.ok(f.store.weeks().includes('2026-08-31'));assert.equal(f.store.view('2026-08-31').rows.length,1);
});
test('old undo cannot erase a later edit from another tab',t=>{
  const f=fixture(t),id=f.view().rows[0].id;
  const first=f.change({action:'edit',id,text:'첫 편집'});f.change({action:'edit',id,text:'두 번째 편집'});
  assert.throws(()=>f.change({action:'undo',token:first.undoToken}));assert.equal(f.view().rows[0].text,'두 번째 편집');
});
test('보고 기록을 한 번만 읽어도 주마다 만드는 내용은 그대로다',t=>{
  const f=fixture(t);f.items.push({id:'b',type:'task',description:'지난주 정리하기',status:'done',created:'2026-09-01',completed:'2026-09-02',group:'가입'},{id:'c',type:'decision',description:'그 전 주 결정',status:'to-do',created:'2026-08-25'});
  f.change({action:'edit',id:f.view().rows[0].id,text:'가입 문구 검토 완료'});
  const separate=f.store.weeks(f.items).map(key=>f.store.view(key,undefined,f.items));
  const file=path.join(f.directory,'.report-drafts.json'),real=fs.readFileSync;let reads=0;
  fs.readFileSync=(name,...rest)=>{if(name===file)reads+=1;return real(name,...rest);};
  let shared;try{const state=f.store.read();shared=f.store.weeks(f.items,state).map(key=>f.store.view(key,state,f.items));}finally{fs.readFileSync=real;}
  assert.ok(shared.length>2);assert.deepEqual(shared,separate);assert.equal(reads,1);
});
test('다음 주 계획 문장은 프로젝트를 붙여 담을 수 있고, 없으면 예전처럼 직접 작성으로 담긴다',t=>{
  const f=fixture(t);
  f.change({action:'add',text:'정산 배치 QA 붙기',group:' 결제 리뉴얼 '});
  const withGroup=f.view().rows.find(row=>row.text==='정산 배치 QA 붙기');
  assert.equal(withGroup.group,'결제 리뉴얼','앞뒤 공백은 떼고 고른 프로젝트를 그대로 적는다');
  assert.equal(withGroup.heading,'다음 주 계획');
  f.change({action:'add',text:'과금 기획 정리'});
  assert.equal(f.view().rows.find(row=>row.text==='과금 기획 정리').group,'직접 작성','group이 없는 기존 add는 그대로 동작한다');
  f.change({action:'add',text:'프로젝트 없이 적기',group:''});
  assert.equal(f.view().rows.find(row=>row.text==='프로젝트 없이 적기').group,'직접 작성','빈 문자열도 프로젝트 없음이다');
});
test('잘못된 프로젝트 이름은 계획 문장과 함께 거절된다',t=>{
  const f=fixture(t);
  for(const group of ['줄\n바꿈','가'.repeat(61),'  ',{name:'객체'},'제어\u0007문자'])
    assert.throws(()=>f.change({action:'add',text:'문장',group}),error=>!error.status && /프로젝트 이름/.test(error.message));
  assert.equal(f.view().rows.filter(row=>row.heading==='다음 주 계획').length,0,'거절된 요청은 아무것도 남기지 않는다');
  // 낡은 revision이면 프로젝트를 붙였더라도 먼저 409로 막힌다(충돌 규칙은 그대로다).
  const old=f.view();f.items.push({...f.items[0],id:'b'});
  assert.throws(()=>f.store.change({weekKey:old.weekKey,revision:old.revision,action:'add',text:'문장',group:'가입 개선'}),error=>error.status===409);
});
// 후보에서 눌러 담은 계획 문장은 어느 업무에서 왔는지를 `planOf`로만 들고 있는다 —
// `sourceIds`에 넣으면 그 업무가 이번 주 자동 문장에서 빠져 버린다.
test('후보에서 담은 계획 문장은 planOf만 들고, 그 업무의 이번 주 자동 문장은 그대로 남는다',t=>{
  const f=fixture(t);
  f.items.push({id:'r',type:'task',description:'정산 배치 설계하기',status:'to-do',created:'2026-09-14',doing:'2026-09-15',group:'결제'});
  const before=f.view().rows.find(row=>row.heading==='진행중');
  assert.deepEqual(before.sourceIds,['r'],'담기 전에는 진행중 자동 문장이 그 업무를 들고 있다');
  f.change({action:'add',text:'정산 배치 설계하기',group:'결제 리뉴얼',planOf:'r'});
  const plan=f.view().rows.find(row=>row.heading==='다음 주 계획');
  assert.equal(plan.planOf,'r');
  assert.deepEqual(plan.sourceIds,[],'담은 연결은 sourceIds·evidence로 새지 않는다');
  assert.deepEqual(plan.evidence,[]);
  const after=f.view().rows.find(row=>row.heading==='진행중');
  assert.ok(after,'담아도 이번 주 진행중 문장은 사라지지 않는다');
  assert.deepEqual(after.sourceIds,['r']);
  assert.equal(after.text,'정산 배치 설계');
});
test('planOf는 clean·carry·새 인스턴스를 거쳐도 보존되고, 없으면 붙지 않는다',t=>{
  const f=fixture(t);
  f.change({action:'add',text:'담은 문장',planOf:' task-1 '});
  f.change({action:'add',text:'직접 쓴 문장'});
  const linked=()=>f.view().rows.find(row=>row.planOf==='task-1');
  assert.equal(linked().text,'담은 문장','앞뒤 공백은 뗀다');
  assert.equal(f.view().rows.find(row=>row.text==='직접 쓴 문장').planOf,undefined,'연결 없이 쓴 문장에는 붙지 않는다');
  // 다른 변경(수정·제외·되돌리기·프로젝트 바꾸기)을 거쳐도 연결은 살아 있다.
  f.change({action:'edit',id:linked().id,text:'담았다가 고친 문장'});
  assert.equal(f.view().rows.find(row=>row.text==='담았다가 고친 문장').planOf,'task-1');
  const excluded=f.change({action:'exclude',id:linked().id});
  assert.equal(f.view().rows.find(row=>row.planOf==='task-1').excluded,true);
  f.change({action:'undo',token:excluded.undoToken});
  assert.equal(f.view().rows.find(row=>row.planOf==='task-1').excluded,false);
  const fresh=factory({directory:f.directory,sources:()=>f.items,legacy:()=>[],currentWeek:()=>'2026-09-14'});
  assert.equal(fresh.view('2026-09-14').rows.find(row=>row.planOf==='task-1').text,'담았다가 고친 문장','새 인스턴스로 읽어도 그대로다');
});
test('잘못된 planOf는 계획 문장과 함께 거절된다',t=>{
  const f=fixture(t);
  for(const link of ['줄\n바꿈','t'.repeat(101),'   ',{id:'객체'},['t'],'제어\u0007문자',7])
    assert.throws(()=>f.change({action:'add',text:'문장',planOf:link}),error=>!error.status && /담은 업무 표시/.test(error.message));
  assert.equal(f.view().rows.filter(row=>row.heading==='다음 주 계획').length,0,'거절된 요청은 아무것도 남기지 않다');
  assert.deepEqual(fs.readdirSync(f.directory),[]);
});
test('계획 문장의 프로젝트는 regroup으로 바꾸고, 계획 문장에만 허용된다',t=>{
  const f=fixture(t);
  f.change({action:'add',text:'정산 배치 QA 붙기',group:'결제 리뉴얼',planOf:'lt01'});
  const plan=()=>f.view().rows.find(row=>row.heading==='다음 주 계획');
  const id=plan().id;
  f.change({action:'regroup',id,group:' 가입 개선 '});
  assert.equal(plan().group,'가입 개선','앞뒤 공백은 떼고 고른 프로젝트를 적는다');
  assert.equal(plan().planOf,'lt01','프로젝트를 바꿔도 담은 연결은 그대로다');
  assert.equal(plan().text,'정산 배치 QA 붙기');
  // 빈 값이면 프로젝트 없음(`직접 작성`)으로 돌아간다.
  f.change({action:'regroup',id,group:''});
  assert.equal(plan().group,'직접 작성');
  // 잘못된 이름은 planGroup 검증이 그대로 막고, 되돌리기도 기존 길 그대로다.
  assert.throws(()=>f.change({action:'regroup',id,group:'줄\n바꿈'}),/프로젝트 이름/);
  const moved=f.change({action:'regroup',id,group:'알림센터'});
  assert.equal(plan().group,'알림센터');
  f.change({action:'undo',token:moved.undoToken});
  assert.equal(plan().group,'직접 작성','되돌리면 바꾸기 전 프로젝트로 돌아간다');
  // 자동 문장(다음 주 계획이 아닌 구역)은 프로젝트를 바꿀 수 없다.
  const auto=f.view().rows.find(row=>row.heading==='완료한 일');
  assert.throws(()=>f.change({action:'regroup',id:auto.id,group:'가입 개선'}),/다음 주 계획 문장만/);
  assert.equal(f.view().rows.find(row=>row.id===auto.id).group,'가입','거절된 요청은 아무것도 바꾸지 않는다');
  assert.throws(()=>f.change({action:'regroup',id:'없는-행',group:'가입 개선'}),/보고 항목을 찾을 수 없어요/);
});
test('planOf가 없던 옛 계획 문장은 그대로 읽히고 고칠 수 있다',t=>{
  const f=fixture(t);
  f.change({action:'add',text:'옛날에 직접 쓴 계획',group:'가입 개선'});
  const file=path.join(f.directory,'.report-drafts.json'),saved=JSON.parse(fs.readFileSync(file,'utf8'));
  assert.equal(saved.weeks['2026-09-14'].rows.find(row=>row.text==='옛날에 직접 쓴 계획').planOf,undefined);
  const old=()=>f.view().rows.find(row=>row.text==='옛날에 직접 쓴 계획'||row.text==='고친 옛 계획');
  assert.equal(old().group,'가입 개선');
  f.change({action:'regroup',id:old().id,group:'결제 리뉴얼'});
  assert.equal(old().group,'결제 리뉴얼');
  f.change({action:'edit',id:old().id,text:'고친 옛 계획'});
  assert.equal(old().text,'고친 옛 계획');
  assert.equal(old().planOf,undefined,'없던 연결이 저절로 생기지도 않는다');
});
// 묶기·묶음 풀기 — 묶을 때 묶기 전 문장을 저장해 두고(`parts`), 나중에 `split`으로 되살린다.
const REPORT_FILE='.report-drafts.json';
function mergeFixture(t) {
  const f=fixture(t);
  f.items.push(
    {id:'b',type:'task',description:'알림 배너 정리하기',status:'done',created:'2026-09-14',completed:'2026-09-15',group:'알림'},
    {id:'c',type:'task',description:'정산 배치 설계하기',status:'done',created:'2026-09-14',completed:'2026-09-15',group:'결제'},
  );
  // 두 문장만 묶고 셋째(`정산 배치 설계`)는 낱 문장으로 남겨 둔다.
  f.mergeTwo=()=>f.change({action:'merge',ids:f.view().rows.filter(row=>row.text!=='정산 배치 설계').map(row=>row.id)});
  f.merged=()=>f.view().rows.find(row=>row.canSplit);
  f.savedRows=()=>JSON.parse(fs.readFileSync(path.join(f.directory,REPORT_FILE),'utf8')).weeks['2026-09-14'].rows;
  return f;
}
test('묶은 문장은 묶기 전 문장을 함께 저장하고, 화면에는 풀 수 있다는 것만 알린다',t=>{
  const f=mergeFixture(t);f.mergeTwo();
  const merged=f.merged();
  assert.equal(merged.partCount,2);
  assert.equal(merged.parts,undefined,'묶기 전 문장 전체는 화면으로 내보내지 않는다');
  const parts=f.savedRows().find(row=>row.parts).parts;
  assert.deepEqual(parts.map(part=>part.text).sort(),['문구 검토','알림 배너 정리']);
  assert.deepEqual(parts.map(part=>part.group).sort(),['가입','알림']);
});
test('묶음 풀기는 묶기 전 문장을 그대로 되살린다',t=>{
  const f=mergeFixture(t);
  const shape=rows=>rows.filter(row=>row.text!=='정산 배치 설계').map(row=>[row.text,row.group,row.sourceIds,!!row.excluded]);
  const before=shape(f.view().rows);
  f.mergeTwo();
  f.change({action:'split',id:f.merged().id});
  assert.deepEqual(shape(f.view().rows),before);
  assert.equal(f.view().rows.some(row=>row.canSplit),false,'푼 뒤에는 풀 것이 남지 않는다');
});
test('묶음을 다시 묶은 것을 풀면 한 단계만 풀린다',t=>{
  const f=mergeFixture(t);f.mergeTwo();
  f.change({action:'merge',ids:[f.merged().id,f.view().rows.find(row=>row.text==='정산 배치 설계').id]});
  assert.equal(f.view().rows.length,1);
  f.change({action:'split',id:f.merged().id});
  assert.equal(f.view().rows.length,2,'바깥 묶음만 풀려 안쪽 묶음 하나와 낱 문장 하나가 된다');
  assert.equal(f.merged().text,'문구 검토\n알림 배너 정리');
  assert.equal(f.merged().partCount,2);
  f.change({action:'split',id:f.merged().id});
  assert.equal(f.view().rows.length,3);
  assert.equal(f.view().rows.some(row=>row.canSplit),false);
});
test('묶지 않은 문장과 없는 문장은 풀 수 없다',t=>{
  const f=fixture(t);
  assert.throws(()=>f.change({action:'split',id:f.view().rows[0].id}),/풀 수 없어요/);
  assert.throws(()=>f.change({action:'split',id:'없는-행'}),/찾을 수 없어요/);
  assert.deepEqual(fs.readdirSync(f.directory),[],'거절된 요청은 아무것도 남기지 않는다');
});
test('묶음을 푼 뒤 되돌리면 다시 묶음 상태가 된다',t=>{
  const f=mergeFixture(t);f.mergeTwo();
  const result=f.change({action:'split',id:f.merged().id});
  assert.equal(f.merged(),undefined);
  f.change({action:'undo',token:result.undoToken});
  assert.equal(f.merged().text,'문구 검토\n알림 배너 정리');
  assert.equal(f.merged().partCount,2,'되돌린 묶음도 다시 풀 수 있다');
});
test('저장 파일을 새로 읽어도(새 인스턴스) 묶음을 풀 수 있다',t=>{
  const f=mergeFixture(t);f.mergeTwo();
  const fresh=factory({directory:f.directory,sources:()=>f.items,legacy:()=>[],currentWeek:()=>'2026-09-14'});
  const view=()=>fresh.view('2026-09-14');
  assert.equal(view().rows.find(row=>row.canSplit).partCount,2);
  fresh.change({weekKey:'2026-09-14',revision:view().revision,action:'split',id:view().rows.find(row=>row.canSplit).id});
  assert.deepEqual(view().rows.map(row=>row.text).sort(),['문구 검토','알림 배너 정리','정산 배치 설계'].sort());
  assert.equal(view().rows.some(row=>row.canSplit),false);
});
test('묶기 전 문장이 없는 옛 묶음은 그대로 읽히고, 풀기만 할 수 없다',t=>{
  const f=mergeFixture(t);f.mergeTwo();
  const file=path.join(f.directory,REPORT_FILE),saved=JSON.parse(fs.readFileSync(file,'utf8'));
  saved.weeks['2026-09-14'].rows.forEach(row=>{delete row.parts;});
  fs.writeFileSync(file,JSON.stringify(saved,null,2));
  const merged=f.view().rows.find(row=>row.text==='문구 검토\n알림 배너 정리');
  assert.ok(merged,'옛 묶음 문장은 그대로 읽힌다');
  assert.equal(merged.canSplit,undefined);
  assert.throws(()=>f.change({action:'split',id:merged.id}),/풀 수 없어요/);
  f.change({action:'edit',id:merged.id,text:'가입·알림 정리 완료'});
  assert.equal(f.view().rows.find(row=>row.id===merged.id).text,'가입·알림 정리 완료','다른 변경은 옛 데이터에서도 그대로 된다');
});
// 문장을 다른 문장 아래로 넣기(`nest`/`unnest`) — 글자를 합치지 않고 행에 `parent`만 붙인다.
function nestFixture(t) {
  const f=fixture(t);
  f.items.push(
    {id:'b',type:'task',description:'알림 배너 정리하기',status:'done',created:'2026-09-14',completed:'2026-09-15',group:'알림'},
    {id:'c',type:'task',description:'정산 배치 설계하기',status:'done',created:'2026-09-14',completed:'2026-09-15',group:'결제'},
  );
  f.row=text=>f.view().rows.find(row=>row.text===text);
  f.shape=()=>f.view().rows.map(row=>[row.text,row.parent||null]);
  f.savedRows=()=>JSON.parse(fs.readFileSync(path.join(f.directory,REPORT_FILE),'utf8')).weeks['2026-09-14'].rows;
  return f;
}
test('문장을 다른 문장 아래로 넣으면 글자는 그대로 두고 부모 바로 뒤에 선다',t=>{
  const f=nestFixture(t);
  assert.deepEqual(f.shape(),[['문구 검토',null],['정산 배치 설계',null],['알림 배너 정리',null]],'넣기 전에는 프로젝트 이름순이다');
  const parent=f.row('문구 검토').id;
  f.change({action:'nest',id:f.row('알림 배너 정리').id,parentId:parent});
  assert.deepEqual(f.shape(),[['문구 검토',null],['알림 배너 정리',parent],['정산 배치 설계',null]],'넣은 문장은 부모 바로 뒤로 온다');
  assert.equal(f.row('알림 배너 정리').text,'알림 배너 정리','글자는 합치지 않는다');
  assert.equal(f.row('알림 배너 정리').group,'알림','프로젝트·근거도 그대로 남는다');
  assert.deepEqual(f.row('알림 배너 정리').sourceIds,['b']);
  // 여러 개를 넣으면 넣은 순서대로 부모 뒤에 줄을 선다.
  f.change({action:'nest',id:f.row('정산 배치 설계').id,parentId:parent});
  assert.deepEqual(f.shape().map(([text])=>text),['문구 검토','알림 배너 정리','정산 배치 설계']);
  // 따로 빼면 원래 자리로 돌아간다.
  f.change({action:'unnest',id:f.row('알림 배너 정리').id});
  assert.deepEqual(f.shape(),[['문구 검토',null],['정산 배치 설계',parent],['알림 배너 정리',null]]);
});
test('아래로 넣기는 같은 상태의 낱 문장끼리만 된다',t=>{
  const f=nestFixture(t);
  f.items.push({id:'d',type:'task',description:'진행 중인 일',status:'to-do',created:'2026-09-14',doing:'2026-09-15',group:'가입'});
  const a=f.row('문구 검토').id,b=f.row('알림 배너 정리').id,c=f.row('정산 배치 설계').id,doing=f.row('진행 중인 일').id;
  assert.throws(()=>f.change({action:'nest',id:b,parentId:'없는-행'}),/찾을 수 없어요/);
  assert.throws(()=>f.change({action:'nest',id:b}),/찾을 수 없어요/,'부모를 적지 않으면 거절한다');
  assert.throws(()=>f.change({action:'nest',id:b,parentId:b}),/찾을 수 없어요/,'자기 자신 아래로는 넣을 수 없다');
  assert.throws(()=>f.change({action:'nest',id:'없는-행',parentId:a}),/보고 항목을 찾을 수 없어요/);
  assert.throws(()=>f.change({action:'nest',id:doing,parentId:a}),/같은 상태의 문장 아래로만/);
  assert.deepEqual(f.shape().filter(([,parent])=>parent),[],'거절된 요청은 아무것도 남기지 않는다');
  f.change({action:'nest',id:b,parentId:a});
  assert.throws(()=>f.change({action:'nest',id:c,parentId:b}),/이미 다른 문장 아래에 있는/,'한 단계까지만 넣는다');
  assert.throws(()=>f.change({action:'nest',id:a,parentId:c}),/먼저 비워 주세요/,'아래에 문장이 있는 문장은 옮기지 않는다');
  f.change({action:'exclude',id:c});
  assert.throws(()=>f.change({action:'nest',id:f.view().rows.find(row=>row.excluded).id,parentId:a}),/제외한 문장은/);
  assert.throws(()=>f.change({action:'nest',id:a,parentId:f.view().rows.find(row=>row.excluded).id}),/제외한 문장은/);
  assert.deepEqual(f.view().rows.find(row=>row.id===b).parent,a,'거절된 요청들 뒤에도 먼저 넣은 문장은 그대로다');
});
test('자동 초안 문장을 넣어도 id는 그대로고 원본을 계속 따라온다',t=>{
  const f=nestFixture(t);
  const a=f.row('문구 검토').id,b=f.row('알림 배너 정리').id;
  assert.ok(a.startsWith('auto-')&&b.startsWith('auto-'),'아직 저장되지 않은 자동 초안이다');
  f.change({action:'nest',id:b,parentId:a});
  assert.deepEqual(f.savedRows().map(row=>row.id).sort(),f.view().rows.map(row=>row.id).sort(),'넣는 순간 모든 행이 저장 행이 된다');
  assert.equal(f.view().rows.find(row=>row.id===b).parent,a);
  // 저장된 뒤에도 잠기지 않은 행은 원본을 따라 갱신되고, id는 바뀌지 않아 들여쓰기가 끊기지 않는다.
  f.items.find(item=>item.id==='b').description='알림 배너 정리 마무리하기';
  f.items.find(item=>item.id==='a').outcome='가입 문구 확정';
  const after=f.view().rows;
  assert.equal(after.find(row=>row.id===b).text,'알림 배너 정리 마무리');
  assert.equal(after.find(row=>row.id===a).text,'가입 문구 확정');
  assert.equal(after.find(row=>row.id===b).parent,a,'id가 그대로라 들여쓰기도 그대로다');
});
test('부모가 사라지거나 제외되거나 상태가 달라지면 넣었던 문장은 최상위로 보인다',t=>{
  const f=nestFixture(t);
  const a=f.row('문구 검토').id,b=f.row('알림 배너 정리').id;
  f.change({action:'nest',id:b,parentId:a});
  // ① 부모를 제외하면 자식은 최상위로 보이고, 복원하면 다시 들어간다(저장값은 그대로다).
  f.change({action:'exclude',id:a});
  assert.equal(f.view().rows.find(row=>row.id===b).parent,undefined);
  assert.equal(f.savedRows().find(row=>row.id===b).parent,a,'보이는 결과에서만 빼고 저장값은 지우지 않는다');
  f.change({action:'exclude',id:a});
  assert.equal(f.view().rows.find(row=>row.id===b).parent,a);
  // ② 부모의 상태(소제목)가 원본을 따라 달라지면 최상위로 보인다.
  const source=f.items.find(item=>item.id==='a');
  source.status='to-do';delete source.completed;source.doing='2026-09-15';
  assert.equal(f.view().rows.find(row=>row.id===a).heading,'진행중');
  assert.equal(f.view().rows.find(row=>row.id===b).parent,undefined);
  source.status='done';source.completed='2026-09-15';
  assert.equal(f.view().rows.find(row=>row.id===b).parent,a,'상태가 돌아오면 다시 들여쓴다');
  // ③ 가리키는 부모가 아예 없으면(근거가 바뀌어 자동 행 id가 달라진 경우 등) 조용히 최상위로 선다.
  const file=path.join(f.directory,REPORT_FILE),saved=JSON.parse(fs.readFileSync(file,'utf8'));
  saved.weeks['2026-09-14'].rows.find(row=>row.id===b).parent='사라진-행';
  fs.writeFileSync(file,JSON.stringify(saved,null,2));
  assert.equal(f.view().rows.find(row=>row.id===b).parent,undefined);
  assert.equal(f.view().rows.length,3,'문장이 사라지지도, 두 번 나오지도 않는다');
});
test('아래로 넣기는 되돌릴 수 있고, 저장 파일을 새로 읽어도 그대로다',t=>{
  const f=nestFixture(t);
  const a=f.row('문구 검토').id,b=f.row('알림 배너 정리').id;
  const result=f.change({action:'nest',id:b,parentId:a});
  f.change({action:'undo',token:result.undoToken});
  assert.equal(f.view().rows.find(row=>row.id===b).parent,undefined,'되돌리면 넣기 전으로 돌아간다');
  const again=f.change({action:'nest',id:b,parentId:a});
  const removed=f.change({action:'unnest',id:b});
  f.change({action:'undo',token:removed.undoToken});
  assert.equal(f.view().rows.find(row=>row.id===b).parent,a,'따로 빼기도 되돌린다');
  assert.ok(again.undoToken);
  const fresh=factory({directory:f.directory,sources:()=>f.items,legacy:()=>[],currentWeek:()=>'2026-09-14'});
  assert.equal(fresh.view('2026-09-14').rows.find(row=>row.id===b).parent,a,'새 인스턴스로 읽어도 유지된다');
});
test('옛 데이터와 요청 본문의 임의 필드는 아래로 넣기에 영향을 주지 않는다',t=>{
  const f=nestFixture(t);
  // `parent`가 없던 옛 행은 그대로 읽히고, 요청에 직접 적어 보낸 `parent`는 무시된다.
  const a=f.row('문구 검토').id,b=f.row('알림 배너 정리').id;
  f.change({action:'edit',id:b,text:'직접 고친 문장',parent:a,rows:[],parts:[{text:'끼워 넣기'}]});
  const saved=f.savedRows().find(row=>row.id===b);
  assert.equal(saved.parent,undefined,'서버가 검증한 id만 `parent`로 저장한다');
  assert.equal(saved.parts,undefined);
  assert.equal(f.view().rows.find(row=>row.id===b).text,'직접 고친 문장');
  // 잠근(직접 고친) 문장도 아래로 넣을 수 있다.
  f.change({action:'nest',id:b,parentId:a});
  assert.equal(f.view().rows.find(row=>row.id===b).parent,a);
  assert.equal(f.view().rows.find(row=>row.id===b).text,'직접 고친 문장');
});
test('a historical saved draft is not silently rewritten by source changes',t=>{
  const f=fixture(t);f.items[0].created='2026-09-01';f.items[0].completed='2026-09-02';
  let old=f.store.view('2026-08-31');f.store.change({weekKey:old.weekKey,revision:old.revision,action:'add',text:'기록 보존'});
  f.items[0].description='이후 수정된 제목';old=f.store.view('2026-08-31');
  assert.equal(old.rows.find(row=>row.sourceIds.includes('a')).text,'문구 검토');
});
// 확인 대기도 답변 한 줄(outcome)을 가질 수 있다 — `확인 완료` 문장은 그 한 줄이 되고, 없으면 문구 그대로다.
test('확인 완료 문장은 답변 한 줄이 있으면 그것을 쓰고, 없으면 확인 대기 문구를 그대로 쓴다',t=>{
  const f=fixture(t);
  f.items.push({id:'c1',type:'check',description:'법무 검토 회신 받기',status:'done',created:'2026-09-15',completed:'2026-09-16',group:'가입',outcome:'법무 검토 통과, 문구 수정 없음'});
  f.items.push({id:'c2',type:'check',description:'벤더 확인 회신 받기',status:'to-do',created:'2026-09-15',group:'결제'});
  const rows=f.view().rows;
  const answered=rows.find(row=>row.sourceIds.includes('c1'));
  assert.equal(answered.heading,'확인 완료');
  assert.equal(answered.text,'법무 검토 통과, 문구 수정 없음');
  const waiting=rows.find(row=>row.sourceIds.includes('c2'));
  assert.equal(waiting.heading,'확인 대기');
  assert.equal(waiting.text,'벤더 확인 회신 받기');
});
test('BRENAME: 그룹 이름 바꾸기는 소제목·묶음 열쇠·근거 이름표만 고치고 문장과 연결은 그대로 둔다',t=>{
  const f=fixture(t);
  const id=f.view().rows[0].id;
  f.change({action:'edit',id,text:'가입 문구 검토 완료'});
  // 묶기 전 문장(parts)까지 같은 규칙으로 따라가는지 함께 본다.
  const file=path.join(f.directory,'.report-drafts.json');
  const state=JSON.parse(fs.readFileSync(file,'utf8'));
  const row=state.weeks['2026-09-14'].rows[0];
  row.parts=[{id:'p1',heading:row.heading,group:'가입',bucket:row.bucket,text:'묶기 전 문장',sourceIds:['a'],evidence:[{id:'a',label:'가입'}],locked:true,excluded:false}];
  state.weeks['2026-09-14'].rows.push({id:'other',heading:'진행중',group:'운영툴',bucket:'group:운영툴:진행중:운영',text:'운영툴 개선',sourceIds:[],evidence:[],locked:true,excluded:false});
  fs.writeFileSync(file,JSON.stringify(state,null,2));

  assert.equal(f.store.renameGroup('가입','가입 개선'),2,'바뀐 줄 수를 돌려준다(묶기 전 문장 포함)');
  const saved=JSON.parse(fs.readFileSync(file,'utf8')).weeks['2026-09-14'].rows;
  assert.equal(saved[0].group,'가입 개선');
  assert.equal(saved[0].bucket,'group:가입 개선:완료한 일:문구 검토하기');
  assert.equal(saved[0].evidence[0].label,'가입 개선');
  assert.equal(saved[0].text,'가입 문구 검토 완료','보고 문장은 손대지 않는다');
  assert.deepEqual(saved[0].sourceIds,['a']);
  assert.equal(saved[0].parts[0].group,'가입 개선');
  assert.equal(saved[0].parts[0].bucket,'group:가입 개선:완료한 일:문구 검토하기');
  assert.equal(saved[0].parts[0].evidence[0].label,'가입 개선');
  assert.deepEqual([saved[1].group,saved[1].bucket],['운영툴','group:운영툴:진행중:운영'],'다른 프로젝트는 그대로다');

  // 바꿀 것이 없으면 파일을 쓰지 않는다.
  const before=fs.statSync(file).mtimeMs;
  assert.equal(f.store.renameGroup('없는 프로젝트','새 이름'),0);
  assert.equal(fs.statSync(file).mtimeMs,before);
});
test('BRENAME: 보고 기록 형식이 깨져 있으면 이름 바꾸기는 저장하지 않고 멈춘다',t=>{
  const f=fixture(t);
  const file=path.join(f.directory,'.report-drafts.json');
  fs.writeFileSync(file,JSON.stringify({schema:2,weeks:{}}));
  assert.throws(()=>f.store.renameGroup('가입','가입 개선'),/보고 기록 형식을 확인해 주세요/);
  assert.equal(fs.readFileSync(file,'utf8'),JSON.stringify({schema:2,weeks:{}}));
});
// ---------- BJALIAS: 지라 프로젝트 앱 안 별칭 ----------
// relabelProject는 renameGroup과 정확히 대칭이지만, 짝짓는 자리가 bucket 머리(jira:KEY:)다 —
// 지라 키는 별칭을 붙여도 바뀌지 않으므로 bucket 값 자체는 손대지 않는다(renameGroup은 bucket도 고친다).
test('BJALIAS: relabelProject는 bucket이 그 프로젝트인 행에서만 group·evidence[].label·parts를 바꾸고 bucket은 그대로 둔다',t=>{
  const f=fixture(t);
  const file=path.join(f.directory,'.report-drafts.json');
  const state={schema:1,weeks:{'2026-09-14':{rows:[
    {id:'j1',heading:'완료한 일',group:'IO-1 · 결제 리뉴얼(요약)',bucket:'jira:IO-1:완료한 일:정산',text:'정산 배치 검토함',sourceIds:['x1'],
      evidence:[{id:'x1',label:'IO-1 · 결제 리뉴얼(요약)'}],locked:true,excluded:false},
    // 다른 지라 키(IO-2) — 같은 글자(우연히 겹쳐도) 건드리면 안 된다.
    {id:'j2',heading:'완료한 일',group:'IO-2 · 알림센터',bucket:'jira:IO-2:완료한 일:정비',text:'정비함',sourceIds:['x2'],
      evidence:[{id:'x2',label:'IO-2 · 알림센터'}],locked:true,excluded:false},
    // 합쳐진(merge) 행 — parts 안의 IO-1 문장도 같이 바뀐다.
    {id:'j3',heading:'진행중',group:'IO-1 · 결제 리뉴얼(요약)',bucket:'jira:IO-1:진행중:API',text:'API 작업\nAPI 검토',sourceIds:['x3','x4'],
      evidence:[{id:'x3',label:'IO-1 · 결제 리뉴얼(요약)'}],locked:true,excluded:false,
      parts:[
        {id:'p1',heading:'진행중',group:'IO-1 · 결제 리뉴얼(요약)',bucket:'jira:IO-1:진행중:API',text:'API 작업',sourceIds:['x3'],evidence:[{id:'x3',label:'IO-1 · 결제 리뉴얼(요약)'}],locked:true,excluded:false},
        {id:'p2',heading:'진행중',group:'IO-1 · 결제 리뉴얼(요약)',bucket:'jira:IO-1:진행중:API2',text:'API 검토',sourceIds:['x4'],evidence:[{id:'x4',label:'IO-1 · 결제 리뉴얼(요약)'}],locked:true,excluded:false},
      ]},
  ],updatedAt:'2026-09-20T00:00:00.000Z'}}};
  fs.writeFileSync(file,JSON.stringify(state,null,2));

  const changed=f.store.relabelProject('jira:IO-1:','IO-1 · 결제 리뉴얼(요약)','IO-1 · 결제 리뉴얼');
  assert.equal(changed,4,'바뀐 줄 수 — j1·j3와 j3의 parts(p1·p2)를 각각 센다(renameGroup과 같은 셈법)');
  const rows=JSON.parse(fs.readFileSync(file,'utf8')).weeks['2026-09-14'].rows;
  const j1=rows.find(row=>row.id==='j1');
  assert.equal(j1.group,'IO-1 · 결제 리뉴얼');
  assert.equal(j1.bucket,'jira:IO-1:완료한 일:정산','지라 키는 바뀌지 않으므로 bucket은 그대로다');
  assert.equal(j1.evidence[0].label,'IO-1 · 결제 리뉴얼');
  assert.equal(j1.text,'정산 배치 검토함','문장은 손대지 않는다');

  const j3=rows.find(row=>row.id==='j3');
  assert.equal(j3.group,'IO-1 · 결제 리뉴얼');
  assert.equal(j3.evidence[0].label,'IO-1 · 결제 리뉴얼');
  assert.equal(j3.parts[0].group,'IO-1 · 결제 리뉴얼');
  assert.equal(j3.parts[0].bucket,'jira:IO-1:진행중:API');
  assert.equal(j3.parts[0].evidence[0].label,'IO-1 · 결제 리뉴얼');
  assert.equal(j3.parts[1].group,'IO-1 · 결제 리뉴얼');
  assert.equal(j3.parts[1].evidence[0].label,'IO-1 · 결제 리뉴얼');

  const j2=rows.find(row=>row.id==='j2');
  assert.equal(j2.group,'IO-2 · 알림센터','다른 지라 키의 행은 손대지 않는다');
  assert.equal(j2.evidence[0].label,'IO-2 · 알림센터');

  // 바꿀 것이 없으면 파일을 쓰지 않는다.
  const before=fs.statSync(file).mtimeMs;
  assert.equal(f.store.relabelProject('jira:IO-9:','없는 이름','새 이름'),0);
  assert.equal(fs.statSync(file).mtimeMs,before);
});
test('BJALIAS: 자동(초안) row의 group·evidence[].label은 원본 항목의 label을 그대로 쓴다 — 서버가 별칭을 입혀 보내면 그 값이 쓰인다',t=>{
  const f=fixture(t);
  // label은 서버(projectLabelOf)가 "별칭 있으면 별칭, 없으면 요약"으로 지어 붙이는 값이다.
  // report-drafts.js는 이 값을 그대로 group·evidence[].label로 옮길 뿐 스스로 별칭을 짓지 않는다.
  f.items.push({id:'jb',type:'task',description:'배포 파이프라인 정리하기',status:'done',created:'2026-09-15',completed:'2026-09-16',jira:'IO-3',label:'IO-3 · 배포 자동화'});
  const row=f.view().rows.find(row=>row.sourceIds.includes('jb'));
  assert.equal(row.group,'IO-3 · 배포 자동화');
  assert.equal(row.evidence.find(item=>item.id==='jb').label,'IO-3 · 배포 자동화');
  assert.match(row.bucket,/^jira:IO-3:/,'bucket은 지라 키로 짓는다(라벨 글자가 아니다) — relabelProject가 이 자리로 행을 찾는다');
});
// ---------- BMOVE: 그룹 → 지라 에픽으로 옮기기 ----------
// moveGroup은 renameGroup·relabelProject와 같은 세 자리(group·bucket 머리·evidence[].label)를
// 보되, bucket의 종류 자체가 `group:`→`jira:`로 바뀐다는 점이 다르다. 되돌리기(moveGroupUndo)가
// 정확해야 하므로 **바뀐 행의 id 목록**을 돌려준다(renameGroup은 개수만 돌려줬다).
test('BMOVE: moveGroup은 group:from: 행만 jira:to: 꼴로 바꾸고 바뀐 행 id를 돌려준다',t=>{
  const f=fixture(t);
  const file=path.join(f.directory,'.report-drafts.json');
  const state={schema:1,weeks:{'2026-09-14':{rows:[
    {id:'m1',heading:'완료한 일',group:'결제 리뉴얼',bucket:'group:결제 리뉴얼:완료한 일:정산',text:'정산 배치 검토함',sourceIds:['x1'],
      evidence:[{id:'x1',label:'결제 리뉴얼'}],locked:true,excluded:false},
    // 다른 그룹 — 손대면 안 된다.
    {id:'m2',heading:'완료한 일',group:'운영툴',bucket:'group:운영툴:완료한 일:정비',text:'정비함',sourceIds:['x2'],
      evidence:[{id:'x2',label:'운영툴'}],locked:true,excluded:false},
    // 합쳐진(merge) 행 — parts 안의 문장도 같이 바뀐다.
    {id:'m3',heading:'진행중',group:'결제 리뉴얼',bucket:'group:결제 리뉴얼:진행중:API',text:'API 작업\nAPI 검토',sourceIds:['x3','x4'],
      evidence:[{id:'x3',label:'결제 리뉴얼'}],locked:true,excluded:false,
      parts:[
        {id:'p1',heading:'진행중',group:'결제 리뉴얼',bucket:'group:결제 리뉴얼:진행중:API',text:'API 작업',sourceIds:['x3'],evidence:[{id:'x3',label:'결제 리뉴얼'}],locked:true,excluded:false},
        {id:'p2',heading:'진행중',group:'결제 리뉴얼',bucket:'group:결제 리뉴얼:진행중:API2',text:'API 검토',sourceIds:['x4'],evidence:[{id:'x4',label:'결제 리뉴얼'}],locked:true,excluded:false},
      ]},
  ],updatedAt:'2026-09-20T00:00:00.000Z'}}};
  fs.writeFileSync(file,JSON.stringify(state,null,2));

  const ids=f.store.moveGroup('결제 리뉴얼','IO-48501','IO-48501 · 결제 리뉴얼');
  assert.deepEqual(ids,['m1','m3'],'옮긴 최상위 행 id만 돌려준다');
  const rows=JSON.parse(fs.readFileSync(file,'utf8')).weeks['2026-09-14'].rows;
  const m1=rows.find(row=>row.id==='m1');
  assert.equal(m1.group,'IO-48501 · 결제 리뉴얼');
  assert.equal(m1.bucket,'jira:IO-48501:완료한 일:정산');
  assert.equal(m1.evidence[0].label,'IO-48501 · 결제 리뉴얼');
  assert.equal(m1.text,'정산 배치 검토함','문장은 손대지 않는다');

  const m3=rows.find(row=>row.id==='m3');
  assert.equal(m3.group,'IO-48501 · 결제 리뉴얼');
  assert.equal(m3.bucket,'jira:IO-48501:진행중:API');
  assert.equal(m3.parts[0].group,'IO-48501 · 결제 리뉴얼');
  assert.equal(m3.parts[0].bucket,'jira:IO-48501:진행중:API');
  assert.equal(m3.parts[1].group,'IO-48501 · 결제 리뉴얼');
  assert.equal(m3.parts[1].bucket,'jira:IO-48501:진행중:API2');

  const m2=rows.find(row=>row.id==='m2');
  assert.equal(m2.group,'운영툴','다른 그룹은 손대지 않는다');
  assert.equal(m2.bucket,'group:운영툴:완료한 일:정비');

  // view()에서 지라 프로젝트 소제목으로 나온다(그룹 소제목이 아니다).
  const view=f.store.view('2026-09-14');
  assert.ok(view.rows.some(row=>row.group==='IO-48501 · 결제 리뉴얼' && row.bucket==='jira:IO-48501:완료한 일:정산'));

  // 바꿀 것이 없으면 파일을 쓰지 않는다.
  const before=fs.statSync(file).mtimeMs;
  assert.deepEqual(f.store.moveGroup('없는 프로젝트','IO-9','IO-9'),[]);
  assert.equal(fs.statSync(file).mtimeMs,before);
});
test('BMOVE: moveGroupUndo는 기록에 있는 id들만 되돌리고, 그 사이 새로 생긴 행·없는 id는 건드리지 않는다',t=>{
  const f=fixture(t);
  const file=path.join(f.directory,'.report-drafts.json');
  const state={schema:1,weeks:{'2026-09-14':{rows:[
    {id:'u1',heading:'완료한 일',group:'IO-48501 · 결제 리뉴얼',bucket:'jira:IO-48501:완료한 일:정산',text:'정산 배치 검토함',sourceIds:['x1'],
      evidence:[{id:'x1',label:'IO-48501 · 결제 리뉴얼'}],locked:true,excluded:false},
    // 옮긴 뒤 이 에픽에 새로 생긴 행(이동 기록에는 없다) — undo가 건드리면 안 된다.
    {id:'u2',heading:'완료한 일',group:'IO-48501 · 결제 리뉴얼',bucket:'jira:IO-48501:완료한 일:새작업',text:'새 작업함',sourceIds:['x2'],
      evidence:[{id:'x2',label:'IO-48501 · 결제 리뉴얼'}],locked:true,excluded:false},
  ],updatedAt:'2026-09-20T00:00:00.000Z'}}};
  fs.writeFileSync(file,JSON.stringify(state,null,2));

  const result=f.store.moveGroupUndo(['u1'],'결제 리뉴얼','IO-48501','IO-48501 · 결제 리뉴얼');
  assert.deepEqual(result,{restored:1,skipped:0});
  const rows=JSON.parse(fs.readFileSync(file,'utf8')).weeks['2026-09-14'].rows;
  const u1=rows.find(row=>row.id==='u1');
  assert.equal(u1.group,'결제 리뉴얼');
  assert.equal(u1.bucket,'group:결제 리뉴얼:완료한 일:정산');
  assert.equal(u1.evidence[0].label,'결제 리뉴얼');
  const u2=rows.find(row=>row.id==='u2');
  assert.equal(u2.group,'IO-48501 · 결제 리뉴얼','기록에 없는(새로 생긴) 행은 그대로 둔다');

  // 이미 되돌렸거나 없는 id는 건너뛴다.
  const skip=f.store.moveGroupUndo(['u1','없는-id'],'결제 리뉴얼','IO-48501','IO-48501 · 결제 리뉴얼');
  assert.deepEqual(skip,{restored:0,skipped:2});
});
// 최종 QA에서 나온 반쪽 되돌리기: 옮긴 뒤 그 에픽의 별칭을 바꾸면 표시 이름이 다시 지어지는데,
// 예전 undo는 "옮길 때의 이름과 같을 때만" 되돌려서 bucket만 돌아오고 이름은 지라 쪽으로 남았다.
test('BMOVE: 옮긴 뒤 별칭을 바꿔도(지웠어도) 되돌리기는 group·evidence·bucket을 전부 원래 이름으로 돌린다',t=>{
  const f=fixture(t);
  const file=path.join(f.directory,'.report-drafts.json');
  const state={schema:1,weeks:{'2026-09-14':{rows:[
    {id:'v1',heading:'완료한 일',group:'결제 리뉴얼',bucket:'group:결제 리뉴얼:완료한 일:정산',text:'정산 배치 검토함',sourceIds:['x1'],
      evidence:[{id:'x1',label:'결제 리뉴얼'}],locked:true,excluded:false},
    {id:'v2',heading:'진행중',group:'결제 리뉴얼',bucket:'group:결제 리뉴얼:진행중:API',text:'API 작업\nAPI 검토',sourceIds:['x3','x4'],
      evidence:[{id:'x3',label:'결제 리뉴얼'}],locked:true,excluded:false,
      parts:[
        {id:'q1',heading:'진행중',group:'결제 리뉴얼',bucket:'group:결제 리뉴얼:진행중:API',text:'API 작업',sourceIds:['x3'],evidence:[{id:'x3',label:'결제 리뉴얼'}],locked:true,excluded:false},
      ]},
  ],updatedAt:'2026-09-20T00:00:00.000Z'}}};
  fs.writeFileSync(file,JSON.stringify(state,null,2));

  const ids=f.store.moveGroup('결제 리뉴얼','IO-48501','IO-48501 · 결제 리뉴얼');
  assert.deepEqual(ids,['v1','v2']);
  // 옮긴 뒤 별칭을 지었다가 다시 지웠다 — 표시 이름은 그때마다 `IO-48501 · …`로 다시 지어진다.
  assert.equal(f.store.relabelProject('jira:IO-48501:','IO-48501 · 결제 리뉴얼','IO-48501 · 새 별칭'),3,'묶기 전 문장까지 센다');
  assert.equal(f.store.relabelProject('jira:IO-48501:','IO-48501 · 새 별칭','IO-48501 · 지라가 준 요약'),3);

  const result=f.store.moveGroupUndo(ids,'결제 리뉴얼','IO-48501','IO-48501 · 결제 리뉴얼');
  assert.deepEqual(result,{restored:2,skipped:0});
  const rows=JSON.parse(fs.readFileSync(file,'utf8')).weeks['2026-09-14'].rows;
  const v1=rows.find(row=>row.id==='v1');
  assert.equal(v1.group,'결제 리뉴얼','이름이 그 사이 바뀌었어도 bucket으로 짝을 찾아 되돌린다');
  assert.equal(v1.bucket,'group:결제 리뉴얼:완료한 일:정산');
  assert.equal(v1.evidence[0].label,'결제 리뉴얼');
  const v2=rows.find(row=>row.id==='v2');
  assert.equal(v2.group,'결제 리뉴얼');
  assert.equal(v2.bucket,'group:결제 리뉴얼:진행중:API');
  assert.equal(v2.parts[0].group,'결제 리뉴얼','묶기 전 문장도 같은 규칙으로 따라간다');
  assert.equal(v2.parts[0].bucket,'group:결제 리뉴얼:진행중:API');
  assert.equal(v2.parts[0].evidence[0].label,'결제 리뉴얼');
  assert.equal(v1.text,'정산 배치 검토함','문장은 손대지 않는다');
});
// BFOLD — 여러 문장을 골라 사람이 지은 요약 한 줄(`manual`) 아래로 모으고(`fold`), 그 부모를 접고
// 펼치고(`setFolded`) 풀 수 있다(`unfold`). 글자는 합치지 않는다 — nest처럼 각 문장은 독립으로 남는다.
test('한 줄로 모으기 검증: 최소 개수·같은 상태·제외 안 함·중첩 금지·요약 글 길이',t=>{
  const f=nestFixture(t);
  f.items.push({id:'d',type:'task',description:'가입 배너 문구 확인하기',status:'done',created:'2026-09-14',completed:'2026-09-15',group:'가입'});
  const a=f.row('문구 검토').id,b=f.row('알림 배너 정리').id,c=f.row('정산 배치 설계').id,d=f.row('가입 배너 문구 확인').id;
  assert.throws(()=>f.change({action:'fold',ids:[a],text:'요약'}),/두 개 이상 골라 주세요/);
  assert.throws(()=>f.change({action:'fold',ids:[a,a],text:'요약'}),/두 개 이상 골라 주세요/,'중복도 거절한다');
  f.items.push({id:'e',type:'task',description:'진행 중인 일',status:'to-do',created:'2026-09-14',doing:'2026-09-15',group:'가입'});
  const doing=f.row('진행 중인 일').id;
  assert.throws(()=>f.change({action:'fold',ids:[a,doing],text:'요약'}),/같은 상태의 문장만 한 줄로 모을 수 있어요/);
  assert.throws(()=>f.change({action:'fold',ids:[a,'없는-행'],text:'요약'}),/같은 상태의 문장만 한 줄로 모을 수 있어요/,'화면에 없는 id도 같은 문구로 거절한다');
  f.change({action:'exclude',id:d});
  assert.throws(()=>f.change({action:'fold',ids:[a,f.view().rows.find(row=>row.excluded).id],text:'요약'}),/제외한 문장은 모을 수 없어요/);
  f.change({action:'exclude',id:d});
  f.change({action:'nest',id:b,parentId:a});
  assert.throws(()=>f.change({action:'fold',ids:[b,c],text:'요약'}),/이미 다른 문장 아래에 있는 문장은 모을 수 없어요/,'이미 다른 문장 아래에 있는 문장은 고를 수 없다');
  assert.throws(()=>f.change({action:'fold',ids:[a,c],text:'요약'}),/아래에 문장이 있는 문장은 먼저 비워 주세요/,'이미 부모 역할인 문장도 고를 수 없다');
  f.change({action:'unnest',id:b});
  assert.throws(()=>f.change({action:'fold',ids:[a,c],text:''}),/200자 이내 한 줄로 적어 주세요/,'빈 글은 거절한다');
  assert.throws(()=>f.change({action:'fold',ids:[a,c],text:'가'.repeat(201)}),/200자 이내 한 줄로 적어 주세요/,'201자는 거절한다');
  assert.throws(()=>f.change({action:'fold',ids:[a,c],text:'줄바꿈\n있음'}),/200자 이내 한 줄로 적어 주세요/,'줄바꿈이 있으면 거절한다');
  assert.equal(f.view().rows.filter(row=>row.manual).length,0,'거절된 요청은 아무것도 남기지 않는다');
});
test('한 줄로 모으기: 새 부모는 먼저 고른 문장이 서 있던 자리를 그대로 쓰고, 같은 프로젝트끼리는 그 프로젝트로 남는다',t=>{
  const f=fixture(t);
  f.items.push(
    {id:'b',type:'task',description:'가입 배너 문구 확인하기',status:'done',created:'2026-09-14',completed:'2026-09-15',group:'가입'},
    {id:'c',type:'task',description:'가입 온보딩 문구 확정하기',status:'done',created:'2026-09-14',completed:'2026-09-15',group:'가입'},
  );
  const row=text=>f.view().rows.find(r=>r.text===text);
  assert.deepEqual(f.view().rows.map(r=>r.text),['문구 검토','가입 배너 문구 확인','가입 온보딩 문구 확정'],'같은 프로젝트 안에서는 원본 순서 그대로다');
  const a=row('문구 검토').id,b=row('가입 배너 문구 확인').id;
  const result=f.change({action:'fold',ids:[a,b],text:'가입 소소한 작업 2건'});
  const after=f.view().rows;
  assert.equal(after[0].text,'가입 소소한 작업 2건','새 부모가 먼저 고른 문장(맨 앞)의 자리를 그대로 쓴다');
  assert.equal(after[0].group,'가입','같은 프로젝트를 모으면 그 프로젝트로 남는다');
  assert.deepEqual(after.map(r=>[r.text,r.parent||null]),[
    ['가입 소소한 작업 2건',null],
    ['문구 검토',after[0].id],
    ['가입 배너 문구 확인',after[0].id],
    ['가입 온보딩 문구 확정',null],
  ]);
  assert.ok(result.undoToken);
});
test('한 줄로 모으기: 프로젝트가 다르면 여러 프로젝트로 묶이고, folded:true·manual인 새 부모가 생긴다',t=>{
  const f=nestFixture(t);
  const a=f.row('문구 검토').id,b=f.row('알림 배너 정리').id;
  f.change({action:'fold',ids:[a,b],text:'소소한 작업 2건'});
  const parent=f.view().rows.find(row=>row.manual);
  assert.equal(parent.text,'소소한 작업 2건');
  assert.equal(parent.group,'여러 프로젝트');
  assert.equal(parent.folded,true);
  assert.equal(parent.manual,true);
  assert.equal(parent.locked,true);
  assert.equal(parent.excluded,false);
  assert.equal(parent.bucket,null);
  assert.deepEqual(parent.sourceIds,[]);
  assert.deepEqual(parent.evidence,[]);
  assert.equal(f.view().rows.find(row=>row.id===a).parent,parent.id);
  assert.equal(f.view().rows.find(row=>row.id===b).parent,parent.id);
});
test('setFolded는 아래에 문장이 있는 최상위 문장만 접고 펼치며, 기존 nest 부모에도 쓸 수 있다',t=>{
  const f=nestFixture(t);
  const a=f.row('문구 검토').id,b=f.row('알림 배너 정리').id;
  assert.throws(()=>f.change({action:'setFolded',id:a,folded:true}),/아래에 문장이 있는 문장만 접을 수 있어요/,'아직 아무것도 안 들어간 문장은 접을 수 없다');
  f.change({action:'nest',id:b,parentId:a});
  assert.throws(()=>f.change({action:'setFolded',id:b,folded:true}),/아래에 문장이 있는 문장만 접을 수 있어요/,'자식 문장은 최상위가 아니라 접을 수 없다');
  f.change({action:'setFolded',id:a,folded:true});
  assert.equal(f.view().rows.find(row=>row.id===a).folded,true,'기존 nest로 만든 부모에도 쓸 수 있다');
  f.change({action:'setFolded',id:a,folded:false});
  assert.equal(f.view().rows.find(row=>row.id===a).folded,false);
});
test('unfold: 사람이 지은 요약 부모는 지워지고, 원래 문장을 부모로 쓴 묶음은 남아서 펼쳐진다',t=>{
  const f=nestFixture(t);
  const a=f.row('문구 검토').id,b=f.row('알림 배너 정리').id,c=f.row('정산 배치 설계').id;
  f.change({action:'nest',id:b,parentId:a});
  f.change({action:'setFolded',id:a,folded:true});
  f.change({action:'unfold',id:a});
  assert.equal(f.view().rows.some(row=>row.id===a),true,'원래 문장을 부모로 쓴 묶음은 unfold해도 그 행이 남는다');
  assert.equal(f.view().rows.find(row=>row.id===a).folded,false);
  assert.equal(f.view().rows.find(row=>row.id===b).parent,undefined,'아래 문장은 최상위로 돌아온다');

  f.change({action:'fold',ids:[a,c],text:'소소한 작업 2건'});
  const parent=f.view().rows.find(row=>row.manual);
  const unfoldResult=f.change({action:'unfold',id:parent.id});
  assert.equal(f.view().rows.some(row=>row.id===parent.id),false,'사람이 지은 요약 부모는 아래가 최상위로 돌아오면 함께 지워진다');
  assert.equal(f.view().rows.find(row=>row.id===a).parent,undefined);
  assert.equal(f.view().rows.find(row=>row.id===c).parent,undefined);
  f.change({action:'undo',token:unfoldResult.undoToken});
  assert.equal(f.view().rows.some(row=>row.id===parent.id),true,'되돌리면 부모가 되살아난다');
  assert.equal(f.view().rows.find(row=>row.id===a).parent,parent.id);
  assert.equal(f.view().rows.find(row=>row.id===c).parent,parent.id);
});
test('unnest: manual 부모의 마지막 아래 문장을 빼면 그 부모도 함께 지워지고, 원래 문장 부모는 남는다',t=>{
  const f=nestFixture(t);
  const a=f.row('문구 검토').id,b=f.row('알림 배너 정리').id,c=f.row('정산 배치 설계').id;
  f.change({action:'fold',ids:[a,b],text:'소소한 작업 2건'});
  const parentId=f.view().rows.find(row=>row.manual).id;
  f.change({action:'unnest',id:a});
  assert.equal(f.view().rows.some(row=>row.id===parentId),true,'아직 아래 문장이 남아 있으면 부모는 지워지지 않는다');
  f.change({action:'unnest',id:b});
  assert.equal(f.view().rows.some(row=>row.id===parentId),false,'마지막 아래 문장을 빼면 manual 부모도 함께 지워진다');
  // 원래 문장을 부모로 쓴 묶음(nest)의 마지막 아래 문장을 빼도 부모는 남는다(기존 동작 그대로다).
  f.change({action:'nest',id:c,parentId:a});
  f.change({action:'unnest',id:c});
  assert.equal(f.view().rows.some(row=>row.id===a),true,'원래 문장 부모는 마지막 아래 문장이 빠져도 남는다');
});
test('view: folded를 그대로 내보내고, manual 부모 아래가 고아 규칙으로 전부 비면 화면에서만 숨기고 저장은 지우지 않는다',t=>{
  const f=nestFixture(t);
  const a=f.row('문구 검토').id,b=f.row('알림 배너 정리').id;
  f.change({action:'fold',ids:[a,b],text:'소소한 작업 2건'});
  const parentId=f.view().rows.find(row=>row.manual).id;
  assert.equal(f.view().rows.find(row=>row.id===parentId).folded,true,'view가 folded를 그대로 내보낸다');
  // 두 자식 모두 자동 초안이라 아직 잠기지 않았다 — 원본 상태가 바뀌어 소제목이 달라지면 고아 규칙이 걸린다.
  const srcA=f.items.find(item=>item.id==='a'),srcB=f.items.find(item=>item.id==='b');
  srcA.status='to-do';delete srcA.completed;srcA.doing='2026-09-15';
  srcB.status='to-do';delete srcB.completed;srcB.doing='2026-09-15';
  assert.equal(f.view().rows.some(row=>row.id===parentId),false,'아래가 전부 고아로 떨어져 나가면 화면에서만 뺀다');
  const saved=JSON.parse(fs.readFileSync(path.join(f.directory,REPORT_FILE),'utf8')).weeks['2026-09-14'].rows;
  assert.ok(saved.some(row=>row.id===parentId),'저장값은 지우지 않는다');
  // 다른 변경(편집)을 저장해도 숨은 부모는 사라지지 않는다.
  f.change({action:'edit',id:a,text:'편집한 문장'});
  const savedAfter=JSON.parse(fs.readFileSync(path.join(f.directory,REPORT_FILE),'utf8')).weeks['2026-09-14'].rows;
  assert.ok(savedAfter.some(row=>row.id===parentId),'숨겨진 뒤 다른 저장을 해도 사라지지 않는다');
  // 상태가 되돌아오면 다시 보인다.
  srcA.status='done';srcA.completed='2026-09-15';delete srcA.doing;
  srcB.status='done';srcB.completed='2026-09-15';delete srcB.doing;
  assert.equal(f.view().rows.find(row=>row.id===parentId)?.folded,true,'상태가 돌아오면 다시 보인다');
});
test('한 줄로 모으기는 되돌릴 수 있고, 저장 파일을 새로 읽어도 유지된다',t=>{
  const f=nestFixture(t);
  const a=f.row('문구 검토').id,b=f.row('알림 배너 정리').id;
  const before=f.shape();
  const result=f.change({action:'fold',ids:[a,b],text:'소소한 작업 2건'});
  f.change({action:'undo',token:result.undoToken});
  assert.deepEqual(f.shape(),before,'되돌리면 모으기 전으로 돌아간다');
  const again=f.change({action:'fold',ids:[a,b],text:'소소한 작업 2건'});
  assert.ok(again.undoToken);
  const fresh=factory({directory:f.directory,sources:()=>f.items,legacy:()=>[],currentWeek:()=>'2026-09-14'});
  const parent=fresh.view('2026-09-14').rows.find(row=>row.manual);
  assert.equal(parent.text,'소소한 작업 2건');
});
// ---------- 주간요약 다듬기 A: 고친 제목·소제목은 그대로, 새로 표시, 묶음 소제목 ----------
// 소제목 이름은 프로젝트 열쇠(`jira:KEY`·`group:이름`)에 묶인다 — 이름을 바꾼 뒤 그 프로젝트에 새 업무가 들어와도
// 바뀐 소제목 아래로 선다. 저장은 파일 맨 위 `weekPolish` 칸이고 문장 행에는 새 칸을 더하지 않는다.
function polishFixture(t,{labels={},bundles=[],week='2026-09-14'}={}) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'report-polish-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const items=[
    {id:'a',type:'task',description:'문구 검토하기',status:'done',created:'2026-09-14',completed:'2026-09-15',group:'가입',label:'가입'},
    {id:'j1',type:'task',description:'정산 배치 점검하기',status:'done',created:'2026-09-14',completed:'2026-09-15',jira:'PAY-1',label:'PAY-1 · 결제 리뉴얼'},
    {id:'j2',type:'task',description:'서버 로그 정리하기',status:'done',created:'2026-09-14',completed:'2026-09-15',jira:'PAY-2',label:'PAY-2 · 결제 서버'},
  ];
  const opts={directory,sources:()=>items,legacy:()=>[],currentWeek:()=>week,bundles:()=>bundles,projectLabel:key=>labels[key]||null};
  const store=factory(opts);
  const view=(key=week)=>store.view(key);
  const change=(action,key=week)=>store.change({weekKey:key,revision:view(key).revision,...action});
  const row=(text,key=week)=>view(key).rows.find(entry=>entry.text===text);
  const file=path.join(directory,'.report-drafts.json');
  const saved=()=>JSON.parse(fs.readFileSync(file,'utf8'));
  return {directory,items,store,view,change,row,file,saved,labels,bundles,opts};
}
test('다듬기 A: 보고 제목은 저장되고 비우면 원래대로, 60자 넘거나 여러 줄이면 거절한다',t=>{
  const f=polishFixture(t);
  assert.equal(f.view().title,null,'고치기 전에는 제목이 없다(화면이 원래 이름을 쓴다)');
  f.change({action:'retitle',text:'  9월 3주차 결제·가입 보고 '});
  assert.equal(f.view().title,'9월 3주차 결제·가입 보고');
  assert.equal(f.saved().weekPolish['2026-09-14'].title,'9월 3주차 결제·가입 보고','주 칸이 아니라 파일 맨 위 칸에 둔다');
  assert.throws(()=>f.change({action:'retitle',text:'가'.repeat(61)}),/60자 이내 한 줄/);
  assert.throws(()=>f.change({action:'retitle',text:'두\n줄'}),/60자 이내 한 줄/);
  f.change({action:'retitle',text:''});
  assert.equal(f.view().title,null);
});
test('다듬기 A: 소제목 이름은 그 소제목의 프로젝트에 묶이고, 새 업무도 바뀐 소제목 아래로 들어가며 원래 이름이 함께 온다',t=>{
  const f=polishFixture(t,{labels:{'group:가입':'가입'}});
  const a=f.row('문구 검토');
  assert.equal(a.groupKey,'group:가입');
  assert.equal(a.shownGroup,undefined,'바꾸기 전에는 저장된 이름 그대로(따로 싣지 않는다)');
  f.change({action:'rename',heading:'완료한 일',groupKey:'group:가입',text:'가입 개편 1차'});
  const after=f.row('문구 검토');
  assert.deepEqual([after.shownGroup,after.groupOrigin,after.group],['가입 개편 1차','가입','가입'],'저장된 프로젝트 이름은 그대로, 보이는 이름만 바뀐다');
  // 같은 프로젝트의 새 완료 업무(다른 주제) — 새 문장이 바뀐 소제목 아래로 선다.
  f.items.push({id:'a2',type:'task',description:'약관 동의 화면 확인하기',status:'done',created:'2026-09-15',completed:'2026-09-16',group:'가입',label:'가입'});
  assert.equal(f.row('약관 동의 화면 확인').shownGroup,'가입 개편 1차');
  // 칸이 둘(한 일·할 일)이 된 뒤로 같은 프로젝트의 진행 중 줄도 한 일 칸 같은 소제목 아래 서서, `완료한 일|열쇠` 이름을 함께 쓴다.
  f.items.push({id:'a3',type:'task',description:'가입 퍼널 분석하기',status:'to-do',doing:'2026-09-15',created:'2026-09-15',group:'가입',label:'가입'});
  assert.equal(f.row('가입 퍼널 분석').shownGroup,'가입 개편 1차');
  // 문장·연결·프로젝트는 손대지 않았다.
  assert.equal(f.saved().weeks['2026-09-14'].rows.every(row=>row.shownGroup===undefined&&row.groupKey===undefined&&row.groupOrigin===undefined),true,'계산한 칸은 행에 저장하지 않는다');
  assert.throws(()=>f.change({action:'rename',heading:'완료한 일',groupKey:'group:없음',text:'x'}),/소제목을 찾을 수 없어요/);
  assert.throws(()=>f.change({action:'rename',heading:'다음 주 계획',groupKey:'group:가입',text:'x'}),/소제목을 찾을 수 없어요/);
  // 원래 이름과 같게 적거나 비우면 원래대로.
  f.change({action:'rename',heading:'완료한 일',groupKey:'group:가입',text:'가입'});
  assert.equal(f.row('문구 검토').shownGroup,undefined);
  assert.equal(f.saved().weekPolish['2026-09-14'].names,undefined);
});
test('다듬기 A: 소제목 이름을 바꾼 뒤 지라 요약이 바뀌어도 바꾼 이름은 그대로이고 원래 이름 표시는 새 이름이다',t=>{
  const f=polishFixture(t,{labels:{'jira:PAY-1':'PAY-1 · 결제 리뉴얼'}});
  f.change({action:'rename',heading:'완료한 일',groupKey:'jira:PAY-1',text:'결제 개편 1차'});
  const locked=f.row('정산 배치 점검');
  f.change({action:'edit',id:locked.id,text:'정산 배치 점검 끝냄'});
  // 지라에서 요약이 바뀜 — 서버가 입히는 label·projectLabel이 새 이름이 된다.
  f.labels['jira:PAY-1']='PAY-1 · 결제 개편';
  f.items[1].label='PAY-1 · 결제 개편';
  f.items.push({id:'j3',type:'task',description:'환불 정책 반영하기',status:'done',created:'2026-09-15',completed:'2026-09-16',jira:'PAY-1',label:'PAY-1 · 결제 개편'});
  const old=f.row('정산 배치 점검 끝냄'),fresh=f.row('환불 정책 반영');
  assert.deepEqual([old.shownGroup,old.groupOrigin],['결제 개편 1차','PAY-1 · 결제 개편']);
  assert.deepEqual([fresh.shownGroup,fresh.groupOrigin],['결제 개편 1차','PAY-1 · 결제 개편'],'옛 이름으로 저장된 문장과 새 문장이 한 소제목으로 모인다');
  assert.equal(old.text,'정산 배치 점검 끝냄','고친 문장은 그대로다');
});
test('다듬기 A: 프로젝트 이름 바꾸기(renameGroup)·에픽으로 옮기기(moveGroup)와 되돌리기 뒤에도 바꾼 소제목 이름이 따라간다',t=>{
  const f=polishFixture(t,{labels:{'group:가입':'가입'}});
  f.change({action:'rename',heading:'완료한 일',groupKey:'group:가입',text:'가입 개편 1차'});
  f.change({action:'edit',id:f.row('문구 검토').id,text:'가입 문구 다듬음'});
  f.store.renameGroup('가입','가입 개선');
  Object.assign(f.items[0],{group:'가입 개선',label:'가입 개선'});f.labels['group:가입 개선']='가입 개선';
  let row=f.row('가입 문구 다듬음');
  assert.deepEqual([row.groupKey,row.shownGroup,row.groupOrigin],['group:가입 개선','가입 개편 1차','가입 개선']);
  assert.deepEqual(Object.keys(f.saved().weekPolish['2026-09-14'].names),['완료한 일|group:가입 개선']);
  const ids=f.store.moveGroup('가입 개선','IO-9','IO-9 · 가입 에픽');
  Object.assign(f.items[0],{group:undefined,jira:'IO-9',label:'IO-9 · 가입 에픽'});f.labels['jira:IO-9']='IO-9 · 가입 에픽';
  row=f.row('가입 문구 다듬음');
  assert.deepEqual([row.groupKey,row.shownGroup,row.groupOrigin],['jira:IO-9','가입 개편 1차','IO-9 · 가입 에픽']);
  f.store.moveGroupUndo(ids,'가입 개선','IO-9','IO-9 · 가입 에픽',ids.names);
  Object.assign(f.items[0],{group:'가입 개선',jira:undefined,label:'가입 개선'});
  row=f.row('가입 문구 다듬음');
  assert.deepEqual([row.groupKey,row.shownGroup],['group:가입 개선','가입 개편 1차']);
});
test('다듬기 A: 옛 데이터(다듬기 칸 없음)는 지금과 같고 새로 표시가 없으며, 처음 다듬은 뒤 새로 들어온 줄만 새로다',t=>{
  const f=polishFixture(t);
  f.store.change({weekKey:'2026-09-14',revision:f.view().revision,action:'exclude',id:f.row('서버 로그 정리').id});
  // 옛 앱이 남긴 것처럼 다듬기 칸을 지운다.
  const state=f.saved();delete state.weekPolish;fs.writeFileSync(f.file,JSON.stringify(state,null,2));
  f.items.push({id:'n1',type:'task',description:'알림 배너 정리하기',status:'done',created:'2026-09-15',completed:'2026-09-16',group:'알림',label:'알림'});
  const old=f.view();
  assert.equal(old.since,null,'기록이 없으면 요약 줄도 없다');
  assert.equal(old.rows.some(row=>row.fresh||row.changed),false);
  // 처음 다듬기(문장 하나 고치기) — 지금 보이는 업무를 전부 본 것으로 적는다.
  f.change({action:'edit',id:f.row('문구 검토').id,text:'가입 문구 다듬음'});
  assert.deepEqual(f.view().since&&[f.view().since.fresh,f.view().since.changed],[0,0]);
  // 다듬은 뒤: 새 주제의 업무 → 새로, 기존 자동 문장에 붙는 업무 → 바뀜, 고친 문장에 붙는 업무 → 바뀜(제안).
  f.items.push({id:'n2',type:'task',description:'운영툴 권한 재정리하기',status:'done',created:'2026-09-16',completed:'2026-09-17',group:'운영툴',label:'운영툴'});
  f.items.push({id:'n3',type:'task',description:'알림 배너 문구 확인하기',status:'done',created:'2026-09-16',completed:'2026-09-17',group:'알림',label:'알림'});
  f.items.push({id:'n4',type:'task',description:'문구 검토하기 후속',status:'done',created:'2026-09-16',completed:'2026-09-17',group:'가입',label:'가입'});
  const now=f.view();
  const by=id=>now.rows.find(row=>row.sourceIds.includes(id));
  assert.equal(by('n2').fresh,true);
  assert.equal(by('n1').changed,true,'자동 문장이 새 업무를 더 품었다');
  assert.equal(by('a').changed,undefined,'고친 문장은 그대로 두고 알약(제안)으로만 알린다 — 상태 줄에서 다시 세지 않는다(다듬기 B 검수)');
  assert.equal(by('a').text,'가입 문구 다듬음');
  assert.equal(by('a').suggestion.added,1);
  assert.deepEqual([now.since.fresh,now.since.changed],[1,1]);
  assert.equal(now.rows.find(row=>row.excluded).fresh,undefined,'제외한 문장은 세지 않는다');
  // 한 줄을 고치면 그 줄만 걷히고 다른 줄의 새로는 남는다.
  f.change({action:'edit',id:by('n1').id,text:'알림 배너 정리·문구 확인함'});
  assert.equal(f.view().rows.find(row=>row.sourceIds.includes('n2')).fresh,true);
  assert.equal(f.view().rows.find(row=>row.sourceIds.includes('n1')).changed,undefined);
  // 모두 확인 — 전부 걷힌다. 되돌리면 다시 선다.
  const ack=f.change({action:'ackNew'});
  assert.deepEqual([f.view().since.fresh,f.view().since.changed],[0,0]);
  f.store.change({weekKey:'2026-09-14',revision:f.view().revision,action:'undo',token:ack.undoToken});
  assert.equal(f.view().since.fresh,1);
});
test('다듬기 A: 다듬은 뒤 같은 업무가 되돌렸다 다시 완료되면 줄이 겹치지 않고, 원본이 지워진 고친 문장은 그대로 둔 채 표시만 한다',t=>{
  const f=polishFixture(t);
  f.change({action:'edit',id:f.row('문구 검토').id,text:'가입 문구 다듬음'});
  f.change({action:'ackNew'});
  Object.assign(f.items[0],{status:'to-do',doing:'2026-09-16',completed:undefined});
  Object.assign(f.items[0],{status:'done',completed:'2026-09-17',doing:undefined});
  const rows=f.view().rows.filter(row=>row.sourceIds.includes('a')||row.suggestion?.sourceIds.includes('a'));
  assert.equal(rows.length,1,'같은 업무의 줄은 하나다');
  assert.equal(rows[0].fresh,undefined);
  assert.equal(f.view().since.fresh,0);
  // 원본 업무가 지워짐 — 문장은 그대로, 제안(원본 확인)과 바뀜 표시만.
  f.items.splice(0,1);
  const row=f.row('가입 문구 다듬음');
  assert.equal(row.suggestion.missing,true);
  assert.equal(row.changed,undefined,'알약(원본 확인)이 알리므로 상태 줄에서는 세지 않는다');
  assert.equal(row.text,'가입 문구 다듬음');
});
test('다듬기 A: 묶음은 그 묶음이 생긴 주의 보고부터 대표 이름 소제목 하나이고, 그 전 주 보고는 티켓별 그대로다',t=>{
  const bundles=[{id:'bd_1',lead:'jira:PAY-1',keys:['jira:PAY-1','jira:PAY-2'],at:'2026-09-16T03:00:00.000Z'}];
  const f=polishFixture(t,{bundles,labels:{'jira:PAY-1':'PAY-1 · 결제 리뉴얼'}});
  const one=f.row('정산 배치 점검'),two=f.row('서버 로그 정리');
  assert.deepEqual([one.groupKey,two.groupKey],['jira:PAY-1','jira:PAY-1']);
  assert.deepEqual([one.shownGroup,two.shownGroup],[undefined,'PAY-1 · 결제 리뉴얼'],'묶인 티켓의 문장은 대표 이름 아래로');
  assert.equal(two.group,'PAY-2 · 결제 서버','저장된 이름은 그대로다');
  // 묶음 소제목도 이름을 바꿀 수 있다(열쇠는 대표).
  f.change({action:'rename',heading:'완료한 일',groupKey:'jira:PAY-1',text:'결제 개편'});
  assert.deepEqual([f.row('정산 배치 점검').shownGroup,f.row('서버 로그 정리').shownGroup],['결제 개편','결제 개편']);
  // 묶음이 생기기 전 주 — 소급하지 않는다.
  f.items.push({id:'p1',type:'task',description:'지난주 서버 점검하기',status:'done',created:'2026-09-07',completed:'2026-09-08',jira:'PAY-2',label:'PAY-2 · 결제 서버'});
  const past=f.store.view('2026-09-07').rows.find(row=>row.sourceIds.includes('p1'));
  assert.deepEqual([past.groupKey,past.shownGroup],['jira:PAY-2',undefined]);
  // 생긴 때를 모르는 묶음은 이번 주부터만.
  f.bundles[0].at=null;
  assert.equal(f.store.view('2026-09-07').rows.find(row=>row.sourceIds.includes('p1')).shownGroup,undefined);
  assert.equal(f.row('서버 로그 정리').shownGroup,'결제 개편');
});
test('다듬기 A: 제목·소제목 이름 바꾸기는 되돌릴 수 있고, 다른 창의 변경과 겹치면 저장하지 않는다',t=>{
  const f=polishFixture(t);
  const stale=f.view().revision;
  const done=f.change({action:'retitle',text:'결제 보고'});
  assert.throws(()=>f.store.change({weekKey:'2026-09-14',revision:stale,action:'rename',heading:'완료한 일',groupKey:'group:가입',text:'x'}),error=>error.status===409);
  f.store.change({weekKey:'2026-09-14',revision:f.view().revision,action:'undo',token:done.undoToken});
  assert.equal(f.view().title,null);
});
test('다듬기 A: 옛 앱(1.2.1)이 보고를 저장해도 파일 맨 위의 다듬기 칸(제목·소제목 이름·새로 기록)은 남는다',t=>{
  // 옛 앱의 report-drafts.js를 태그에서 꺼내 같은 파일에 실제로 저장시켜 본다(태그가 없는 복사본에서는 건너뛴다).
  let source='';
  try { source=require('node:child_process').execFileSync('git',['show','v1.2.1:tracker/inbox-app/report-drafts.js'],{cwd:__dirname,encoding:'utf8',stdio:['ignore','pipe','ignore']}); } catch {}
  if(!source){t.skip('v1.2.1 태그를 읽을 수 없어요');return;}
  const f=polishFixture(t);
  f.change({action:'retitle',text:'결제 보고'});
  f.change({action:'rename',heading:'완료한 일',groupKey:'group:가입',text:'가입 개편 1차'});
  f.change({action:'edit',id:f.row('문구 검토').id,text:'가입 문구 다듬음'});
  const oldFile=path.join(f.directory,'old-report-drafts.js');
  fs.writeFileSync(oldFile,source.replace("require('./safe-storage')",`require(${JSON.stringify(path.join(__dirname,'safe-storage'))})`));
  const oldStore=require(oldFile)({directory:f.directory,sources:()=>f.items,legacy:()=>[],currentWeek:()=>'2026-09-14'});
  const oldView=oldStore.view('2026-09-14');
  oldStore.change({weekKey:'2026-09-14',revision:oldView.revision,action:'exclude',id:oldView.rows.find(row=>row.text==='서버 로그 정리함').id});
  oldStore.renameGroup('운영툴','운영 도구');
  const state=f.saved();
  assert.equal(state.weekPolish['2026-09-14'].title,'결제 보고');
  assert.equal(state.weekPolish['2026-09-14'].names['완료한 일|group:가입'],'가입 개편 1차');
  assert.ok(state.weekPolish['2026-09-14'].seen.ids.a);
  // 다시 새 앱으로 올라오면 고친 것이 그대로 보인다.
  const back=factory(f.opts);
  const view=back.view('2026-09-14');
  assert.equal(view.title,'결제 보고');
  assert.equal(view.rows.find(row=>row.text==='가입 문구 다듬음').shownGroup,'가입 개편 1차');
  assert.equal(view.rows.find(row=>row.text==='서버 로그 정리함').excluded,true,'옛 앱에서 한 변경도 남는다');
});
test('다듬기 A(99 리뷰①): 에픽 옮기기를 되돌리면 옮길 때 가져간 소제목 이름만 돌아가고, 에픽이 원래 갖고 있던 이름은 남는다',t=>{
  const f=polishFixture(t,{labels:{'group:가입':'가입'}});
  f.change({action:'rename',heading:'완료한 일',groupKey:'group:가입',text:'가입 개편 1차'});
  // 에픽(IO-9)이 원래 다른 소제목(진행중)에 이름을 갖고 있었다.
  const state=f.saved();state.weekPolish['2026-09-14'].names['진행중|jira:IO-9']='에픽 원래 이름';fs.writeFileSync(f.file,JSON.stringify(state,null,2));
  const ids=f.store.moveGroup('가입','IO-9','IO-9 · 가입 에픽');
  assert.deepEqual(ids.names,[['2026-09-14','완료한 일|group:가입','완료한 일|jira:IO-9']],'옮긴 이름 열쇠를 함께 돌려준다');
  assert.deepEqual(JSON.parse(JSON.stringify(ids)),[...ids],'행 id 배열 모양은 그대로(숨은 칸은 JSON에 실리지 않는다)');
  f.store.moveGroupUndo([...ids],'가입','IO-9','IO-9 · 가입 에픽',ids.names);
  const names=f.saved().weekPolish['2026-09-14'].names;
  assert.deepEqual(names,{'진행중|jira:IO-9':'에픽 원래 이름','완료한 일|group:가입':'가입 개편 1차'},'에픽 원래 이름은 그룹으로 넘어가지 않는다');
  // 이름 기록 없이(옛 이동 기록) 되돌리면 이름은 손대지 않는다.
  const again=f.store.moveGroup('가입','IO-9','IO-9 · 가입 에픽');
  f.store.moveGroupUndo([...again],'가입','IO-9','IO-9 · 가입 에픽');
  assert.equal(f.saved().weekPolish['2026-09-14'].names['완료한 일|jira:IO-9'],'가입 개편 1차');
});
test('다듬기 A(99 리뷰②): 다듬기 칸(맨 위·주 칸·이름표)이 배열로 깨져 있어도 저장할 때 새 값이 사라지지 않는다',t=>{
  const f=polishFixture(t);
  fs.writeFileSync(f.file,JSON.stringify({schema:1,weeks:{},weekPolish:[]}));
  f.change({action:'retitle',text:'결제 보고'});
  assert.equal(f.saved().weekPolish['2026-09-14'].title,'결제 보고','맨 위 칸이 배열이면 객체로 새로 쓴다');
  const state=f.saved();state.weekPolish['2026-09-14']=[];fs.writeFileSync(f.file,JSON.stringify(state));
  assert.equal(f.view().title,null,'깨진 주 칸은 없는 것으로 본다');
  f.change({action:'rename',heading:'완료한 일',groupKey:'group:가입',text:'가입 개편'});
  assert.equal(f.saved().weekPolish['2026-09-14'].names['완료한 일|group:가입'],'가입 개편');
  const broken=f.saved();broken.weekPolish['2026-09-14'].names=['x'];broken.weekPolish['2026-09-14'].seen={at:'x',ids:[]};fs.writeFileSync(f.file,JSON.stringify(broken));
  assert.equal(f.view().since,null,'깨진 새로 기록은 없는 것으로 본다');
  f.change({action:'rename',heading:'완료한 일',groupKey:'group:가입',text:'가입 개편 2차'});
  assert.deepEqual(f.saved().weekPolish['2026-09-14'].names,{'완료한 일|group:가입':'가입 개편 2차'});
  assert.equal(typeof f.saved().weekPolish['2026-09-14'].seen.ids.a,'string');
});
test('다듬기 A(v3): `원래 문장으로`는 고친 문장을 원본에서 다시 지은 문장으로 돌리고, 원본이 없거나 고치지 않은 문장은 거절한다',t=>{
  const f=polishFixture(t);
  const id=f.row('문구 검토').id;
  assert.throws(()=>f.change({action:'revert',id}),/원래 문장으로 돌릴 수 없어요/,'고치지 않은 문장');
  f.change({action:'edit',id,text:'가입 문구 다듬음'});
  f.change({action:'revert',id});
  const row=f.view().rows.find(entry=>entry.id===id);
  assert.deepEqual([row.text,row.locked],['문구 검토',false]);
  f.items[0].description='문구 검토하기(최종)';
  assert.equal(f.view().rows.find(entry=>entry.id===id).text,'문구 검토하기(최종)'.replace(/하기$/,'함'),'다시 자동으로 따라간다');
  f.change({action:'edit',id,text:'다시 고침'});
  f.items.splice(0,1);
  assert.throws(()=>f.change({action:'revert',id}),/원래 문장으로 돌릴 수 없어요/,'원본이 지워졌으면 거절');
});
test('다듬기 A(Codex P2): 묶음 소제목 이름을 바꾼 뒤 대표를 바꿔도 이름이 남고, 다시 바꾸거나 되돌리면 옛 자리도 치우며, 묶음을 풀면 저장된 티켓 소제목에만 남는다',t=>{
  const bundles=[{id:'bd_1',lead:'jira:PAY-1',keys:['jira:PAY-1','jira:PAY-2'],at:'2026-09-15T03:00:00.000Z'}];
  const f=polishFixture(t,{bundles,labels:{'jira:PAY-1':'PAY-1 · 결제 리뉴얼','jira:PAY-2':'PAY-2 · 결제 서버'}});
  f.change({action:'rename',heading:'완료한 일',groupKey:'jira:PAY-1',text:'결제 개편'});
  // 대표를 PAY-2로 바꿈 — 열쇠는 새 대표, 저장된 이름은 옛 대표 자리에 있다.
  f.bundles[0].lead='jira:PAY-2';
  const one=f.row('정산 배치 점검'),two=f.row('서버 로그 정리');
  assert.deepEqual([one.groupKey,one.shownGroup,two.shownGroup],['jira:PAY-2','결제 개편','결제 개편'],'대표를 바꿔도 바꾼 이름이 그대로');
  assert.equal(one.groupOrigin,'PAY-2 · 결제 서버','원래 이름 풍선은 지금 대표');
  assert.deepEqual(Object.keys(f.saved().weekPolish['2026-09-14'].names),['완료한 일|jira:PAY-1'],'읽기만으로는 저장을 바꾸지 않는다');
  // 새 대표 자리에서 다시 바꾸면 옛 자리는 치우고 새 자리에 쓴다.
  f.change({action:'rename',heading:'완료한 일',groupKey:'jira:PAY-2',text:'결제 개편 2차'});
  assert.deepEqual(f.saved().weekPolish['2026-09-14'].names,{'완료한 일|jira:PAY-2':'결제 개편 2차'});
  // 원래 이름으로 되돌리기(빈 값) — 옛 자리에서 찾은 이름도 남지 않는다.
  f.bundles[0].lead='jira:PAY-1';
  assert.equal(f.row('정산 배치 점검').shownGroup,'결제 개편 2차');
  f.change({action:'rename',heading:'완료한 일',groupKey:'jira:PAY-1',text:''});
  assert.equal(f.row('정산 배치 점검').shownGroup,undefined);
  assert.equal(f.saved().weekPolish['2026-09-14'].names,undefined,'되돌리면 옛 대표 자리의 이름도 지운다');
  // 묶음 풀기 — 이름은 저장된(바꿀 때의 대표) 티켓 소제목에만 남는다.
  f.change({action:'rename',heading:'완료한 일',groupKey:'jira:PAY-1',text:'결제 개편'});
  f.bundles.length=0;
  assert.deepEqual([f.row('정산 배치 점검').shownGroup,f.row('서버 로그 정리').shownGroup],['결제 개편',undefined]);
});

// ---------- 다듬기 B: `+ 한 줄 추가`(업무로도) · 완료 제안 · 확정 ----------
function lineFixture(t,{week='2026-09-14',bundles=[]}={}) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'report-lines-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const items=[
    {id:'a',type:'task',description:'문구 검토하기',status:'done',created:'2026-09-14',completed:'2026-09-15',group:'가입',label:'가입'},
    {id:'p',type:'task',description:'영수증 메일 발송 시점 정리하기',status:'to-do',doing:'2026-09-15',created:'2026-09-14',jira:'PAY-1',label:'PAY-1 · 결제 리뉴얼'},
  ];
  const made=[],removed=[];
  let seq=0,failCreate=false;
  const tasks={
    create:({description,done,completed,jira,group})=>{
      if(failCreate)throw new Error('업무 파일을 쓰지 못했어요');
      const id=`w${++seq}`;
      items.push({id,type:'task',description,status:done?'done':'to-do',created:'2026-09-16',...(done?{completed:completed||'2026-09-16'}:{doing:'2026-09-16'}),
        ...(jira?{jira,label:`${jira} · 결제 리뉴얼`}:{}),...(group?{group,label:group}:{})});
      made.push({id,description,done,completed,jira,group});return id;
    },
    remove:(id,keep)=>{removed.push([id,keep]);const at=items.findIndex(item=>item.id===id);if(at>=0)items.splice(at,1);return true;},
  };
  const opts={directory,sources:()=>items,legacy:()=>[],currentWeek:()=>week,bundles:()=>bundles,tasks};
  const store=factory(opts);
  const view=(key=week)=>store.view(key);
  const change=(action,key=week)=>store.change({weekKey:key,revision:view(key).revision,...action});
  const row=(text,key=week)=>view(key).rows.find(entry=>entry.text===text);
  const file=path.join(directory,'.report-drafts.json');
  const saved=()=>JSON.parse(fs.readFileSync(file,'utf8'));
  return {directory,items,store,view,change,row,file,saved,opts,made,removed,fail:value=>{failCreate=value;}};
}
test('다듬기 B: `+ 한 줄 추가`는 완료한 일 칸이면 이 주에 끝낸 업무를, 진행 중 칸이면 진행 중 업무를 같은 프로젝트로 만들고 사람이 쓴 문장 그대로 한 줄을 넣는다',t=>{
  const f=lineFixture(t);
  const result=f.change({action:'addLine',heading:'완료한 일',groupKey:'group:가입',text:'  가입 완료 화면 카피 최종본 전달함 '});
  assert.equal(result.tasksChanged,true,'화면이 업무 목록을 다시 받게 알린다');
  assert.deepEqual(f.made[0],{id:'w1',description:'가입 완료 화면 카피 최종본 전달함',done:true,completed:null,jira:undefined,group:'가입'},'이번 주면 완료일은 오늘(만드는 쪽이 정한다)');
  const line=f.row('가입 완료 화면 카피 최종본 전달함');
  assert.deepEqual([line.heading,line.groupKey,line.sourceIds,line.locked,line.origin],['완료한 일','group:가입',['w1'],true,'weekly']);
  assert.equal(line.fresh,undefined,'방금 더한 줄은 `새로`가 아니다');
  assert.equal(f.view().rows.filter(entry=>entry.sourceIds.includes('w1')).length,1,'자동 문장이 같은 업무로 한 줄 더 생기지 않는다');
  f.items.find(item=>item.id==='w1').description='가입 완료 화면 카피 최종본 전달하기';
  assert.ok(f.row('가입 완료 화면 카피 최종본 전달함'),'자동 문장으로 다시 쓰지 않는다(고친 것 불변)');
  f.change({action:'addLine',heading:'진행중',groupKey:'jira:PAY-1',text:'환불 규칙 정리 중'});
  assert.deepEqual(f.made[1],{id:'w2',description:'환불 규칙 정리 중',done:false,completed:null,jira:'PAY-1',group:undefined});
  assert.deepEqual([f.row('환불 규칙 정리 중').heading,f.row('환불 규칙 정리 중').groupKey],['진행중','jira:PAY-1']);
  // 60자 넘는 긴 문장도 그대로 한 줄(줄바꿈은 화면이 보여 줄 때만).
  const long='가'.repeat(120);
  f.change({action:'addLine',heading:'완료한 일',groupKey:'group:가입',text:long});
  assert.equal(f.row(long).text.length,120);
});
test('다듬기 B: 묶음이면 `+ 한 줄 추가`의 업무는 대표 티켓에 붙는다',t=>{
  const bundles=[{id:'bd_1',lead:'jira:PAY-1',keys:['jira:PAY-1','jira:PAY-2'],at:'2026-09-15T03:00:00.000Z'}];
  const f=lineFixture(t,{bundles});
  f.items.push({id:'q',type:'task',description:'서버 로그 정리하기',status:'done',created:'2026-09-14',completed:'2026-09-15',jira:'PAY-2',label:'PAY-2 · 결제 서버'});
  assert.equal(f.row('서버 로그 정리').groupKey,'jira:PAY-1');
  f.change({action:'addLine',heading:'완료한 일',groupKey:'jira:PAY-1',text:'정산 알림 켬'});
  assert.equal(f.made[0].jira,'PAY-1');
  assert.equal(f.row('정산 알림 켬').groupKey,'jira:PAY-1');
});
test('다듬기 B: `+ 한 줄 추가`를 되돌리면 줄과 업무가 함께 사라지고(업무는 늘 지운 항목에 남긴다), 그 되돌리기는 다시 되돌리지 않는다',t=>{
  const f=lineFixture(t);
  const first=f.change({action:'addLine',heading:'완료한 일',groupKey:'group:가입',text:'약관 링크 고침'});
  const undone=f.change({action:'undo',token:first.undoToken});
  assert.equal(f.row('약관 링크 고침'),undefined);
  assert.equal(f.items.some(item=>item.id==='w1'),false);
  assert.deepEqual(f.removed,[['w1',true]],'늘 지운 항목에 남긴다(마감·일정 등을 더했을 수 있다 — 99 리뷰)');
  assert.equal(undone.undoToken,null);
  assert.equal(undone.tasksChanged,true);
  const second=f.change({action:'addLine',heading:'완료한 일',groupKey:'group:가입',text:'약관 링크 다시 고침'});
  f.items.find(item=>item.id==='w2').description='약관 링크 다시 고침(최종)';
  f.change({action:'undo',token:second.undoToken});
  assert.deepEqual(f.removed[1],['w2',true],'만든 뒤 고친 업무는 지운 항목에 남긴다');
  assert.equal(f.view().rows.some(entry=>entry.sourceIds.includes('w2')),false);
});
test('다듬기 B: 빈 문장·여러 줄·결정 칸·모르는 소제목·오지 않은 주는 거절하고 업무도 보고도 쓰지 않는다',t=>{
  const f=lineFixture(t);
  f.items.push({id:'d',type:'decision',description:'환불은 7일',created:'2026-09-15',status:'to-do',group:'가입',label:'가입'});
  const bad=[
    [{heading:'완료한 일',groupKey:'group:가입',text:'   '},/1,000자 이내 한 줄/],
    [{heading:'완료한 일',groupKey:'group:가입',text:'두\n줄'},/1,000자 이내 한 줄/],
    [{heading:'새로 정해진 것',groupKey:'group:가입',text:'결정 한 줄'},/완료한 일·진행 중 칸에만/],
    [{heading:'완료한 일',groupKey:'group:없는',text:'한 줄'},/소제목을 찾을 수 없어요/],
    [{heading:'진행중',groupKey:'group:가입',text:'한 줄'},/소제목을 찾을 수 없어요/],
    [{heading:'완료한 일',groupKey:'name:여러 프로젝트',text:'한 줄'},/소제목을 찾을 수 없어요/],
  ];
  for(const [action,pattern] of bad)assert.throws(()=>f.change({action:'addLine',...action}),pattern);
  assert.throws(()=>f.change({action:'addLine',heading:'완료한 일',groupKey:'group:가입',text:'미래'},'2026-09-21'),/아직 오지 않은 주/);
  assert.equal(f.made.length,0);
  assert.equal(fs.existsSync(f.file),false,'거절하면 보고 저장본도 쓰지 않는다');
});
test('다듬기 B: 지난 주 보고의 `+ 한 줄 추가`는 완료한 일 칸만 되고 완료일은 그 주 금요일이다',t=>{
  const f=lineFixture(t,{week:'2026-09-21'});
  f.change({action:'addLine',heading:'완료한 일',groupKey:'group:가입',text:'지난주에 한 일 적음'},'2026-09-14');
  assert.equal(f.made[0].completed,'2026-09-18');
  assert.equal(f.row('지난주에 한 일 적음','2026-09-14').heading,'완료한 일');
  f.items.push({id:'r',type:'task',description:'진행 업무',status:'to-do',doing:'2026-09-22',created:'2026-09-21',group:'가입',label:'가입'});
  assert.throws(()=>f.change({action:'addLine',heading:'진행중',groupKey:'group:가입',text:'x'},'2026-09-14'),/지난 주 보고에는 진행 중/);
  assert.equal(f.made.length,1);
});
test('다듬기 B: 업무를 만들지 못하면(또는 만든 업무를 읽지 못하면) 줄도 쓰지 않는다',t=>{
  const f=lineFixture(t);
  f.fail(true);
  assert.throws(()=>f.change({action:'addLine',heading:'완료한 일',groupKey:'group:가입',text:'반쯤'}),/업무 파일을 쓰지 못했어요/);
  assert.equal(fs.existsSync(f.file),false);
  f.fail(false);
  const lost=factory({...f.opts,tasks:{create:()=>'없는-id',remove:()=>true}});
  assert.throws(()=>lost.change({weekKey:'2026-09-14',revision:lost.view('2026-09-14').revision,action:'addLine',heading:'완료한 일',groupKey:'group:가입',text:'반쯤'}),/업무를 만들지 못했어요/);
  assert.equal(fs.existsSync(f.file),false);
  const none=factory({...f.opts,tasks:null});
  assert.throws(()=>none.change({weekKey:'2026-09-14',revision:none.view('2026-09-14').revision,action:'addLine',heading:'완료한 일',groupKey:'group:가입',text:'x'}),/더할 수 없어요/);
});
test('다듬기 B: 더한 줄의 업무를 지우면 줄은 남고 원본 확인 제안, 미완료로 되돌리면 완료 칸에 남고 제안만(자동으로 옮기지 않는다)',t=>{
  const f=lineFixture(t);
  f.change({action:'addLine',heading:'완료한 일',groupKey:'group:가입',text:'첫 줄'});
  f.change({action:'addLine',heading:'완료한 일',groupKey:'group:가입',text:'둘째 줄'});
  f.items.splice(f.items.findIndex(item=>item.id==='w1'),1);
  const gone=f.row('첫 줄');
  assert.deepEqual([gone.heading,gone.suggestion.missing,gone.completable],['완료한 일',true,undefined]);
  const task=f.items.find(item=>item.id==='w2');task.status='to-do';delete task.completed;
  const back=f.row('둘째 줄');
  assert.equal(back.heading,'완료한 일');
  assert.ok(back.suggestion&&!back.suggestion.missing);
  assert.equal(back.completable,undefined);
});
test('다듬기 B: 고친 진행 중 줄의 업무가 이 주에 끝나면 `완료로` 제안 — 누르면 문장 그대로 완료한 일 칸 같은 프로젝트로, 되돌리기도 된다',t=>{
  const f=lineFixture(t);
  const id=f.row('영수증 메일 발송 시점 정리').id;
  f.change({action:'edit',id,text:'영수증 메일 발송 시점 정리 중'});
  assert.equal(f.row('영수증 메일 발송 시점 정리 중').completable,undefined,'아직 안 끝났으면 제안 없음');
  assert.throws(()=>f.change({action:'complete',id}),/완료로 옮길 수 없어요/);
  const task=f.items.find(item=>item.id==='p');
  Object.assign(task,{status:'done',completed:'2026-09-17'});delete task.doing;
  const offer=f.row('영수증 메일 발송 시점 정리 중');
  assert.deepEqual([offer.heading,offer.completable],['진행중',true]);
  const moved=f.change({action:'complete',id});
  const done=f.row('영수증 메일 발송 시점 정리 중');
  assert.deepEqual([done.heading,done.groupKey,done.suggestion,done.completable],['완료한 일','jira:PAY-1',undefined,undefined]);
  f.change({action:'undo',token:moved.undoToken});
  assert.equal(f.row('영수증 메일 발송 시점 정리 중').heading,'진행중');
});
test('다듬기 B: 업무 문구까지 바뀌었거나 이 주 밖에서 끝났으면 `완료로` 제안이 없고, 자동 문장은 스스로 완료 칸으로 간다',t=>{
  const f=lineFixture(t);
  const task=f.items.find(item=>item.id==='p');
  Object.assign(task,{status:'done',completed:'2026-09-16'});
  assert.equal(f.view().rows.find(entry=>entry.sourceIds.includes('p')).heading,'완료한 일');
  Object.assign(task,{status:'to-do',completed:undefined});
  f.change({action:'edit',id:f.view().rows.find(entry=>entry.sourceIds.includes('p')).id,text:'정리 중'});
  Object.assign(task,{status:'done',completed:'2026-09-16',description:'영수증 메일 발송 시점 정리하기(재작업)'});
  const changed=f.row('정리 중');
  assert.ok(changed.suggestion);
  assert.equal(changed.completable,undefined,'문구가 바뀌면 원래 제안만');
  Object.assign(task,{description:'영수증 메일 발송 시점 정리하기',completed:'2026-09-22'});
  assert.equal(f.row('정리 중').completable,undefined,'다음 주에 끝났으면 이 주 완료로 옮기지 않는다');
});
test('다듬기 B: 아래로 넣은 진행 중 줄을 완료로 옮기면 자리 연결을 풀고, 더한 줄도 다른 문장 아래로 넣을 수 있다',t=>{
  const f=lineFixture(t);
  f.change({action:'addLine',heading:'진행중',groupKey:'jira:PAY-1',text:'환불 규칙 정리 중'});
  const parent=f.row('영수증 메일 발송 시점 정리').id,child=f.row('환불 규칙 정리 중').id;
  f.change({action:'nest',id:child,parentId:parent});
  assert.equal(f.row('환불 규칙 정리 중').parent,parent,'더한 줄도 다른 문장 아래로 넣는다');
  const task=f.items.find(item=>item.id==='w1');
  Object.assign(task,{status:'done',completed:'2026-09-17'});delete task.doing;
  assert.equal(f.row('환불 규칙 정리 중').completable,true);
  f.change({action:'complete',id:child});
  const moved=f.row('환불 규칙 정리 중');
  assert.deepEqual([moved.heading,moved.parent],['완료한 일',undefined]);
  assert.equal(f.saved().weeks['2026-09-14'].rows.find(entry=>entry.id===child).parent,undefined,'저장된 자리 연결도 푼다');
});
test('다듬기 B: 확정하면 자동 모으기가 새 문장을 넣지 않고 줄 수로만 세고, 있던 문장은 바뀌어도 그대로(제안만), `보고에 넣기`로 새 줄로 들어간다',t=>{
  const f=lineFixture(t);
  f.change({action:'confirm'});
  const at=f.view().confirmed.at;
  assert.match(at,/^\d{4}-\d{2}-\d{2}T/);
  assert.equal(f.saved().weekPolish['2026-09-14'].lockedAt,at,'맨 위 다듬기 칸에 둔다');
  f.items.push({id:'n',type:'task',description:'가입 문구 후속 확인하기',status:'done',created:'2026-09-16',completed:'2026-09-16',group:'가입',label:'가입'});
  f.items.push({id:'m',type:'decision',description:'새 결정',status:'to-do',created:'2026-09-16',group:'결제',label:'결제'});
  let view=f.view();
  assert.deepEqual(view.confirmed,{at,pending:1,pendingDone:1},'결정 묶음은 넣어도 처음부터 빠진 줄이라 세지 않는다(양식 ①)');
  assert.equal(view.rows.some(entry=>entry.sourceIds.includes('n')||entry.sourceIds.includes('m')),false,'새 업무는 문장이 되지 않는다');
  assert.equal(view.rows.find(entry=>entry.sourceIds.includes('a')).suggestion,undefined,'같은 소제목 문장에 새 업무를 붙이지도 않는다');
  f.items.find(item=>item.id==='a').description='문구 검토하기(최종)';
  const row=f.view().rows.find(entry=>entry.sourceIds.includes('a'));
  assert.deepEqual([row.text,!!row.suggestion],['문구 검토',true],'확정 뒤 원본이 바뀌어도 문장은 그대로, 제안만');
  f.change({action:'confirm'});
  assert.equal(f.view().confirmed.at,at,'다시 확정해도 처음 때 그대로');
  const pulled=f.change({action:'pullNew'});
  view=f.view();
  assert.deepEqual(view.confirmed,{at,pending:0,pendingDone:0});
  assert.ok(view.rows.some(entry=>entry.sourceIds.includes('n'))&&view.rows.some(entry=>entry.sourceIds.includes('m')));
  assert.equal(view.rows.filter(entry=>entry.fresh).length,0,'넣은 줄은 본 것으로 적는다');
  assert.throws(()=>f.change({action:'pullNew'}),/새로 넣을 줄이 없어요/);
  f.change({action:'undo',token:pulled.undoToken});
  assert.equal(f.view().confirmed.pending,1,'되돌리면 다시 붙들어 둔다');
});
test('다듬기 B: 확정·확정 풀기는 되돌릴 수 있고, 풀면 자동 모으기가 다시 새 업무를 넣는다',t=>{
  const f=lineFixture(t);
  const on=f.change({action:'confirm'});
  f.change({action:'undo',token:on.undoToken});
  assert.equal(f.view().confirmed,null);
  f.change({action:'confirm'});
  assert.throws(()=>lineFixture(t).change({action:'unconfirm'}),/확정하지 않은 보고예요/);
  f.items.push({id:'n',type:'task',description:'가입 후속 확인하기',status:'done',created:'2026-09-16',completed:'2026-09-16',group:'가입',label:'가입'});
  const off=f.change({action:'unconfirm'});
  assert.equal(f.view().confirmed,null);
  assert.ok(f.view().rows.some(entry=>entry.sourceIds.includes('n')),'풀면 새 업무가 다시 들어온다');
  f.change({action:'undo',token:off.undoToken});
  assert.equal(f.view().confirmed.pending,1,'되돌리면 확정으로 — 풀 때 들어온 줄은 다시 붙들어 둔다');
});
test('다듬기 B: 확정 뒤에도 사람이 하는 일(더하기·아래로 넣기·따로 빼기·완료로)은 되고 확정은 그대로다',t=>{
  const f=lineFixture(t);
  f.change({action:'confirm'});
  f.change({action:'addLine',heading:'진행중',groupKey:'jira:PAY-1',text:'환불 규칙 정리 중'});
  assert.equal(f.view().confirmed.pending,0,'더한 줄의 업무는 새로 들어온 것으로 세지 않는다');
  const parent=f.row('영수증 메일 발송 시점 정리').id,child=f.row('환불 규칙 정리 중').id;
  f.change({action:'nest',id:child,parentId:parent});
  f.change({action:'unnest',id:child});
  assert.equal(f.row('환불 규칙 정리 중').parent,undefined);
  const task=f.items.find(item=>item.id==='p');
  Object.assign(task,{status:'done',completed:'2026-09-17'});delete task.doing;
  const auto=f.row('영수증 메일 발송 시점 정리');
  assert.deepEqual([auto.heading,auto.completable],['진행중',true],'확정으로 굳은 자동 문장도 완료 제안');
  f.change({action:'complete',id:auto.id});
  assert.equal(f.row('영수증 메일 발송 시점 정리').heading,'완료한 일');
  assert.ok(f.view().confirmed);
});
test('다듬기 B(99 ③): 옛 앱(1.2.1)이 저장해도 확정(맨 위 칸)과 더한 줄의 `origin`(행 안 칸)이 남고, origin이 사라져도 줄은 사람이 쓴 그대로다',t=>{
  let source='';
  try { source=require('node:child_process').execFileSync('git',['show','v1.2.1:tracker/inbox-app/report-drafts.js'],{cwd:__dirname,encoding:'utf8',stdio:['ignore','pipe','ignore']}); } catch {}
  if(!source){t.skip('v1.2.1 태그를 읽을 수 없어요');return;}
  const f=lineFixture(t);
  f.change({action:'addLine',heading:'완료한 일',groupKey:'group:가입',text:'가입 카피 전달함'});
  f.change({action:'confirm'});
  const oldFile=path.join(f.directory,'old-report-drafts.js');
  fs.writeFileSync(oldFile,source.replace("require('./safe-storage')",`require(${JSON.stringify(path.join(__dirname,'safe-storage'))})`));
  const oldStore=require(oldFile)({directory:f.directory,sources:()=>f.items,legacy:()=>[],currentWeek:()=>'2026-09-14'});
  const oldView=oldStore.view('2026-09-14');
  assert.equal(oldView.rows.find(row=>row.text==='가입 카피 전달함').origin,'weekly','옛 앱도 행 안의 모르는 칸은 들고 있다');
  oldStore.change({weekKey:'2026-09-14',revision:oldView.revision,action:'exclude',id:oldView.rows.find(row=>row.text==='문구 검토함').id});
  const state=f.saved();
  assert.equal(typeof state.weekPolish['2026-09-14'].lockedAt,'string','확정은 맨 위 칸이라 남는다');
  assert.equal(state.weeks['2026-09-14'].rows.find(row=>row.text==='가입 카피 전달함').origin,'weekly','옛 앱의 저장(clean)도 행 안 칸은 버리지 않는다');
  // 행 안 칸이 어떤 이유로 사라져도(손으로 고친 파일 등) 줄은 locked라 자동 문장으로 덮이지 않는다.
  delete state.weeks['2026-09-14'].rows.find(row=>row.text==='가입 카피 전달함').origin;
  state.weekPolish['2026-09-14']={};
  fs.writeFileSync(f.file,JSON.stringify(state));
  f.items.find(item=>item.id==='w1').description='다른 문구';
  const back=factory(f.opts).view('2026-09-14');
  const line=back.rows.find(row=>row.sourceIds.includes('w1'));
  assert.deepEqual([line.text,line.heading,back.rows.filter(row=>row.sourceIds.includes('w1')).length],['가입 카피 전달함','완료한 일',1]);
  assert.ok(f.items.some(item=>item.id==='w1'),'업무는 그대로 남는다');
});
test('다듬기 B 검수①: 줄 끝 알약(제안)이 선 줄은 상태 줄의 새로·바뀜 개수에서 빠진다',t=>{
  const f=lineFixture(t);
  const id=f.row('영수증 메일 발송 시점 정리').id;
  f.change({action:'edit',id,text:'정리 중'});
  f.change({action:'ackNew'});
  const task=f.items.find(item=>item.id==='p');
  Object.assign(task,{status:'done',completed:'2026-09-17'});delete task.doing;
  const view=f.view();
  assert.equal(view.rows.find(row=>row.id===id).completable,true,'알약은 선다');
  assert.deepEqual([view.since.fresh,view.since.changed],[0,0],'같은 변화를 상태 줄에서 다시 세지 않는다');
  f.items.push({id:'n',type:'task',description:'새 업무 끝내기',status:'done',created:'2026-09-16',completed:'2026-09-16',group:'운영',label:'운영'});
  assert.deepEqual([f.view().since.fresh,f.view().since.changed],[1,0],'알약 없는 새 줄은 그대로 센다');
});

// ---------- 개편 A 7단계: 확인 필요(서버 판단)·재료(붙들어 둔 끝낸 일)·한 줄씩 넣기 ----------
function reviewFixture(t,week='2026-09-14') {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'report-review-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const items=[
    {id:'a',type:'task',description:'문구 검토하기',status:'done',created:'2026-09-14',completed:'2026-09-15',group:'가입',label:'가입'},
    {id:'k',type:'task',description:'권한 표 정리하기',status:'done',created:'2026-09-14',completed:'2026-09-15',group:'운영',label:'운영'},
    {id:'d1',type:'task',description:'배치 설계하기 1차',status:'to-do',doing:'2026-09-15',created:'2026-09-14',group:'정산',label:'정산'},
    {id:'d2',type:'task',description:'배치 설계하기 2차',status:'to-do',doing:'2026-09-15',created:'2026-09-14',group:'정산',label:'정산'},
  ];
  const opts={directory,sources:()=>items,legacy:()=>[],currentWeek:()=>week};
  const store=factory(opts);
  const view=(key=week)=>store.view(key);
  const change=(action,key=week)=>store.change({weekKey:key,revision:view(key).revision,...action});
  const row=(match,key=week)=>view(key).rows.find(entry=>entry.sourceIds.includes(match)||entry.text===match);
  const file=path.join(directory,'.report-drafts.json');
  const saved=()=>JSON.parse(fs.readFileSync(file,'utf8'));
  return {directory,items,store,view,change,row,file,saved,opts,week};
}
test('개편 A: 확인 필요 이유는 undone·missing·mixed·changed·marked 다섯이고, 결과 한 줄이 빈 것은 이유가 아니다',t=>{
  const f=reviewFixture(t);
  let v=f.view();
  assert.deepEqual(v.review,{count:0,first:null},'처음에는 없다 — 끝낸 업무에 결과 한 줄이 없어도(noOutcome) 세지 않는다');
  assert.equal(v.rows.every(entry=>entry.review===undefined),true);
  // marked — 근거 업무 제목의 `(확인 필요)`
  f.items.find(item=>item.id==='k').description='권한 표 정리하기 (확인 필요)';
  assert.deepEqual(f.row('k').review,{reason:'marked'});
  // mixed — 진행 중 두 업무 중 하나만 끝남(문장은 진행 중 칸이라 undone은 아니다). 먼저 한 번 저장해 두 업무를 한 문장으로 둔다.
  f.change({action:'ackNew'});
  assert.deepEqual(f.row('d2').sourceIds,['d1','d2']);
  Object.assign(f.items.find(item=>item.id==='d1'),{status:'done',completed:'2026-09-16'});
  assert.deepEqual(f.row('d2').review,{reason:'mixed'});
  // undone — 고친 완료 문장의 업무가 다시 미완료
  f.change({action:'edit',id:f.row('a').id,text:'가입 문구 다듬음'});
  Object.assign(f.items.find(item=>item.id==='a'),{status:'to-do'});
  assert.deepEqual(f.row('a').review,{reason:'undone'},'원본 바뀜 제안보다 급한 이유 하나');
  assert.equal(f.row('a').needsReview,true,'옛 화면이 읽는 needsReview는 그대로');
  v=f.view();
  assert.equal(v.review.count,3);
  const order=v.rows.filter(entry=>entry.review).map(entry=>entry.id);
  assert.equal(v.review.first,order[0],'첫 문장은 문서 순서');
  assert.equal(v.rows.find(entry=>entry.id===v.review.first).heading,'완료한 일');
});
test('개편 A: missing·changed, 완료 제안이 선 줄·뺀 문장·다음 주 계획은 세지 않는다',t=>{
  const f=reviewFixture(t);
  f.change({action:'edit',id:f.row('a').id,text:'가입 문구 다듬음'});
  f.items.find(item=>item.id==='a').description='문구 검토하기(최종)';
  assert.deepEqual(f.row('a').review,{reason:'changed'});
  f.items.splice(f.items.findIndex(item=>item.id==='a'),1);
  assert.deepEqual(f.row('가입 문구 다듬음').review,{reason:'missing'});
  // 뺀 문장은 세지 않는다
  f.items.find(item=>item.id==='k').description='권한 표 정리하기 (미확정)';
  assert.deepEqual(f.row('k').review,{reason:'marked'});
  f.change({action:'exclude',id:f.row('k').id});
  assert.equal(f.row('k').review,undefined);
  f.change({action:'add',text:'(확인 필요) 계획',group:'가입'});
  assert.equal(f.row('(확인 필요) 계획').review,undefined,'다음 주 계획은 보지 않는다');
  assert.equal(f.view().review.count,1);
  // 완료 제안(`끝났어요 · 완료로`)이 선 줄은 그 제안이 말한다 — changed로 세지 않는다
  const g=lineFixture(t);
  g.change({action:'edit',id:g.row('영수증 메일 발송 시점 정리').id,text:'정리 중'});
  const task=g.items.find(item=>item.id==='p');Object.assign(task,{status:'done',completed:'2026-09-17'});delete task.doing;
  const line=g.row('정리 중');
  assert.deepEqual([line.completable,line.review],[true,undefined]);
});
test('개편 A: 접힌 부모 아래 문장이 걸리면 첫 문장은 그 부모(화면에 보이는 줄)이고, 개수는 문장 수다',t=>{
  const f=reviewFixture(t);
  f.items.push({id:'k2',type:'task',description:'요청 흐름 정리 (확인 필요)',status:'done',created:'2026-09-14',completed:'2026-09-15',group:'운영',label:'운영'});
  f.items.find(item=>item.id==='k').description='권한 표 정리하기 (확인 필요)';
  const ids=[f.row('k').id,f.row('k2').id];
  assert.equal(new Set(ids).size,2);
  f.change({action:'fold',ids,text:'운영 권한 정리'});
  const v=f.view();
  const parent=v.rows.find(entry=>entry.manual);
  assert.equal(parent.folded,true);
  assert.equal(v.review.count,2);
  assert.equal(v.review.first,parent.id,'가려진 문장 대신 접힌 부모로 간다');
  assert.equal(parent.review,undefined,'부모 자신은 세지 않는다');
});
test('개편 A: review는 저장 파일에 들어가지 않고(clean), 파일에 남아 있던 review 칸도 다시 계산한다',t=>{
  const f=reviewFixture(t);
  f.items.find(item=>item.id==='k').description='권한 표 정리하기 (확인 필요)';
  f.change({action:'edit',id:f.row('a').id,text:'가입 문구 다듬음'});
  f.change({action:'ackNew'});
  assert.equal(fs.readFileSync(f.file,'utf8').includes('"review"'),false,'행 안에 review가 저장되지 않는다');
  assert.equal(f.row('k').review.reason,'marked');
  // 손상·옛 파일에 review 칸이 들어 있어도 그대로 믿지 않는다
  const state=f.saved();
  state.weeks[f.week].rows.forEach(entry=>{entry.review={reason:'undone'};});
  fs.writeFileSync(f.file,JSON.stringify(state));
  const v=factory(f.opts).view(f.week);
  assert.deepEqual(v.rows.filter(entry=>entry.review).map(entry=>[entry.sourceIds[0],entry.review.reason]),[['k','marked']]);
  f.change({action:'edit',id:f.row('가입 문구 다듬음').id,text:'가입 문구 다듬음 2'});
  assert.equal(fs.readFileSync(f.file,'utf8').includes('"review"'),false,'다시 저장하면 걷힌다');
});
test('개편 A: 재료(material.pending)는 확정한 주에 붙들어 둔 끝낸 일만 한 건씩 — 확정 전 주·진행 중·결정은 없다',t=>{
  const f=lineFixture(t);
  f.items.push({id:'n',type:'task',description:'가입 문구 후속 확인하기',status:'done',created:'2026-09-16',completed:'2026-09-16',group:'가입',label:'가입'});
  assert.deepEqual(f.view().material,{pending:[]},'확정 전에는 자동 모으기가 넣으므로 비어 있다');
  f.items.pop();
  f.change({action:'confirm'});
  f.items.push({id:'n',type:'task',description:'가입 문구 후속 확인하기',status:'done',created:'2026-09-16',completed:'2026-09-16',group:'가입',label:'가입'});
  f.items.push({id:'n2',type:'task',description:'가입 카피 최종 확인하기',status:'done',created:'2026-09-16',completed:'2026-09-17',group:'가입',label:'가입'});
  f.items.push({id:'m',type:'decision',description:'새 결정',status:'to-do',created:'2026-09-16',group:'결제',label:'결제'});
  f.items.push({id:'q',type:'task',description:'새로 진행하기',status:'to-do',doing:'2026-09-16',created:'2026-09-16',group:'결제',label:'결제'});
  const v=f.view();
  assert.deepEqual(v.material.pending.map(entry=>[entry.id,entry.label,entry.completed]).sort(),[['n','가입','2026-09-16'],['n2','가입','2026-09-17']]);
  assert.deepEqual([v.confirmed.pending,v.confirmed.pendingDone],[3,2],'줄 수(pending)는 결정·확인 묶음을 빼고 센다(양식 ①)');
});
test('개편 A: 한 줄씩 넣기(pullOne) — 그 업무 하나만 새 줄, 확정 그대로, 되돌리기, 없는 업무·확정 전·오래된 revision은 거절',t=>{
  const f=lineFixture(t);
  assert.throws(()=>f.change({action:'pullOne',ids:['a']}),/확정한 보고에서만/);
  f.change({action:'confirm'});
  f.items.push({id:'n',type:'task',description:'가입 문구 후속 확인하기',status:'done',created:'2026-09-16',completed:'2026-09-16',group:'가입',label:'가입'});
  f.items.push({id:'n2',type:'task',description:'가입 문구 후속 점검하기',status:'done',created:'2026-09-16',completed:'2026-09-16',group:'가입',label:'가입'});
  assert.throws(()=>f.change({action:'pullOne',ids:['a']}),/넣을 업무를 찾을 수 없어요/,'이미 문장에 든 업무');
  assert.throws(()=>f.change({action:'pullOne',ids:['zz']}),/넣을 업무를 찾을 수 없어요/);
  assert.throws(()=>f.change({action:'pullOne',ids:['n','n2']}),/넣을 업무를 찾을 수 없어요/,'한 번에 하나만');
  const old=f.view();
  const done=f.change({action:'pullOne',ids:['n']});
  let v=f.view();
  const line=v.rows.find(entry=>entry.sourceIds.includes('n'));
  assert.deepEqual([line.heading,line.text,line.sourceIds,line.group],['완료한 일','가입 문구 후속 확인',['n'],'가입']);
  assert.equal(v.rows.some(entry=>entry.sourceIds.includes('n2')),false,'같은 소제목의 다른 업무는 그대로 붙들어 둔다');
  assert.deepEqual(v.material.pending.map(entry=>entry.id),['n2']);
  assert.ok(v.confirmed,'확정은 그대로');
  assert.equal(line.fresh,undefined,'사람이 넣은 줄은 새로 들어온 것이 아니다');
  assert.throws(()=>f.store.change({weekKey:'2026-09-14',revision:old.revision,action:'pullOne',ids:['n2']}),error=>error.status===409);
  f.change({action:'undo',token:done.undoToken});
  v=f.view();
  assert.equal(v.rows.some(entry=>entry.sourceIds.includes('n')),false);
  assert.deepEqual(v.material.pending.map(entry=>entry.id).sort(),['n','n2']);
  // 넣기 직전에 업무가 지워졌으면 거절
  f.items.splice(f.items.findIndex(item=>item.id==='n'),1);
  assert.throws(()=>f.change({action:'pullOne',ids:['n']}),/넣을 업무를 찾을 수 없어요/);
});
test('개편 A: 옛 앱(1.3.0)이 보고를 저장해도 review는 파일에 없고, 새 앱으로 다시 올라오면 확인 필요·재료·한 줄씩 넣기가 그대로 된다',t=>{
  let source='';
  try { source=require('node:child_process').execFileSync('git',['show','v1.3.0:tracker/inbox-app/report-drafts.js'],{cwd:__dirname,encoding:'utf8',stdio:['ignore','pipe','ignore']}); } catch {}
  if(!source){t.skip('v1.3.0 태그를 읽을 수 없어요');return;}
  const f=lineFixture(t);
  f.items.push({id:'k',type:'task',description:'권한 표 정리하기 (확인 필요)',status:'done',created:'2026-09-14',completed:'2026-09-15',group:'운영',label:'운영'});
  f.change({action:'edit',id:f.row('문구 검토').id,text:'가입 문구 다듬음'});
  f.change({action:'confirm'});
  f.items.push({id:'n',type:'task',description:'가입 문구 후속 확인하기',status:'done',created:'2026-09-16',completed:'2026-09-16',group:'가입',label:'가입'});
  f.change({action:'pullOne',ids:['n']});
  assert.equal(fs.readFileSync(f.file,'utf8').includes('"review"'),false);
  const oldFile=path.join(f.directory,'old-report-drafts.js');
  fs.writeFileSync(oldFile,source.replace("require('./safe-storage')",`require(${JSON.stringify(path.join(__dirname,'safe-storage'))})`));
  const oldStore=require(oldFile)({directory:f.directory,sources:()=>f.items,legacy:()=>[],currentWeek:()=>'2026-09-14',tasks:f.opts.tasks});
  const oldView=oldStore.view('2026-09-14');
  assert.equal(oldView.review,undefined,'옛 앱은 review를 모른다');
  assert.equal(oldView.rows.some(entry=>entry.sourceIds.includes('n')),true,'한 줄씩 넣은 줄은 옛 앱에도 보통 줄이다');
  oldStore.change({weekKey:'2026-09-14',revision:oldView.revision,action:'edit',id:oldView.rows.find(entry=>entry.sourceIds.includes('n')).id,text:'후속 확인 끝'});
  assert.equal(fs.readFileSync(f.file,'utf8').includes('"review"'),false,'옛 앱이 다시 써도 review는 파일에 없다');
  const back=factory(f.opts).view('2026-09-14');
  assert.ok(back.confirmed,'확정 그대로');
  assert.equal(back.rows.find(entry=>entry.sourceIds.includes('k')).review.reason,'marked');
  assert.equal(back.review.count,1);
  assert.deepEqual(back.material,{pending:[]});
  assert.equal(back.rows.find(entry=>entry.sourceIds.includes('n')).text,'후속 확인 끝');
  f.items.push({id:'n3',type:'task',description:'가입 카피 전달하기',status:'done',created:'2026-09-16',completed:'2026-09-17',group:'가입',label:'가입'});
  const again=factory(f.opts);
  const r=again.change({weekKey:'2026-09-14',revision:again.view('2026-09-14').revision,action:'pullOne',ids:['n3']});
  assert.equal(r.report.rows.some(entry=>entry.sourceIds.includes('n3')),true);
});

// ---------- 주간 보고 양식 ① — 끝말 규칙 · 결정·확인 기본 빠짐 · 할 일 칸 미리 채우기 · keep ----------
function formFixture(t,{items=[],current='2026-09-21'}={}) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'report-form-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const state={current};
  const store=factory({directory,sources:()=>items,legacy:()=>[],currentWeek:()=>state.current});
  const view=(week=state.current)=>store.view(week);
  const change=(action,week=state.current)=>store.change({weekKey:week,revision:view(week).revision,...action});
  const file=path.join(directory,'.report-drafts.json');
  const saved=()=>JSON.parse(fs.readFileSync(file,'utf8'));
  const plan=(week)=>view(week).rows.filter(row=>row.heading==='다음 주 계획');
  return {directory,items,store,view,change,saved,plan,state,file};
}
test('양식 ①: 끝말 규칙 — `요청 답하기`·`하기`·`했음`만 떼고, 2자 미만·잘린 글·결과 한 줄은 그대로다',t=>{
  const done=(id,description,extra={})=>({id,type:'task',description,status:'done',created:'2026-09-21',completed:'2026-09-22',group:id,...extra});
  const items=[
    done('p1','결제 실패 사유 문구 초안 작성하기'), done('p2','환불 정책 문서 1차 작성했음'), done('p4','부분 환불 QA 케이스 추가 요청 답하기'),
    done('j2','가입 안내 문구 검수 요청 답하기'), done('j3','본인 인증 오류 문의 대응하기'),
    {id:'q2',type:'task',description:'환불 API 연동 확인하기',status:'to-do',created:'2026-09-21',doing:'2026-09-22',group:'q2'},
    done('s1','하기'), done('s2','답했음'), done('o1','정산 배치 점검하기',{outcome:'정산 배치 점검 끝냄'}),
    done('l1',`${'가'.repeat(90)}하기`),
    {id:'d1',type:'decision',description:'부분 환불은 1차 범위에서 제외하기',status:'to-do',created:'2026-09-22',group:'d1'},
  ];
  const f=formFixture(t,{items});
  const text=id=>f.view().rows.find(row=>row.sourceIds.includes(id)).text;
  assert.deepEqual(['p1','p2','p4','j2','j3','q2'].map(text),
    ['결제 실패 사유 문구 초안 작성','환불 정책 문서 1차 작성','부분 환불 QA 케이스 추가','가입 안내 문구 검수','본인 인증 오류 문의 대응','환불 API 연동 확인']);
  assert.equal(text('s1'),'하기','떼고 남은 글이 2자 미만이면 그대로');
  assert.equal(text('s2'),'답했음');
  assert.equal(text('o1'),'정산 배치 점검 끝냄','결과 한 줄은 사람이 쓴 글이라 그대로');
  assert.equal(text('l1'),`${'가'.repeat(80)}…`,'80자에서 잘린 글은 끝말을 떼지 않는다');
  assert.equal(text('d1'),'부분 환불은 1차 범위에서 제외하기','결정·확인은 업무 제목이 아니라 그대로');
  assert.equal(f.view().rows.find(row=>row.sourceIds.includes('p1')).evidence[0].description,'결제 실패 사유 문구 초안 작성하기','근거에는 업무 제목 전문');
  // 저장된(고친) 문장은 다시 다듬지 않는다.
  f.change({action:'edit',id:f.view().rows.find(row=>row.sourceIds.includes('p2')).id,text:'환불 정책 문서 1차 작성했음'});
  assert.equal(text('p2'),'환불 정책 문서 1차 작성했음');
});
test('양식 ①: 결정·확인 줄은 처음부터 빠져 있고(확인 필요·새로 표시에서도), include로 넣고 빼며 되돌릴 수 있다 · 저장값은 그대로',t=>{
  const items=[
    {id:'a',type:'task',description:'문구 검토하기',status:'done',created:'2026-09-21',completed:'2026-09-22',group:'가입'},
    {id:'d',type:'decision',description:'부분 환불은 제외 (미확정)',status:'to-do',created:'2026-09-22',group:'가입'},
    {id:'c1',type:'check',description:'수수료 정책 확인',status:'done',created:'2026-09-22',group:'가입'},
    {id:'c2',type:'check',description:'권한 기준 확인',status:'to-do',created:'2026-09-22',group:'운영'},
  ];
  const f=formFixture(t,{items});
  const row=id=>f.view().rows.find(entry=>entry.sourceIds.includes(id));
  assert.deepEqual(['d','c1','c2'].map(id=>[row(id).excluded,row(id).optOut]),[[true,true],[true,true],[true,true]]);
  assert.equal(row('a').excluded,false);
  assert.equal(f.view().review.count,0,'빠진 결정 줄의 (미확정)은 확인 필요로 세지 않는다');
  f.change({action:'ackNew'});
  items.push({id:'d2',type:'decision',description:'환불 수수료는 유지',status:'to-do',created:'2026-09-23',group:'운영'});
  assert.equal(f.view().since.fresh,0,'새로 들어온 결정 줄도 새로로 세지 않는다');
  const result=f.change({action:'include',id:row('d').id,on:true});
  assert.deepEqual([row('d').excluded,row('d').optOut,row('d').included],[false,undefined,true]);
  assert.equal(f.view().review.count,1,'다시 넣으면 확인 필요로 센다');
  assert.equal(f.saved().weeks['2026-09-21'].rows.find(entry=>entry.sourceIds.includes('c1')).excluded,false,'저장 파일의 excluded는 바꾸지 않는다');
  f.change({action:'undo',token:result.undoToken});
  assert.equal(row('d').excluded,true,'되돌리면 다시 빠진다');
  f.change({action:'include',id:row('c2').id,on:true});
  f.change({action:'include',id:row('c2').id,on:false});
  assert.deepEqual([row('c2').excluded,row('c2').included],[true,undefined]);
  // 옛 앱처럼 저장값에 excluded:true인 결정 줄도 다시 넣으면 들어온다.
  const state=f.saved();state.weeks['2026-09-21'].rows.find(entry=>entry.sourceIds.includes('c1')).excluded=true;fs.writeFileSync(f.file,JSON.stringify(state));
  f.change({action:'include',id:row('c1').id,on:true});
  assert.equal(row('c1').excluded,false);
  assert.throws(()=>f.change({action:'include',id:row('a').id,on:true}),/결정·확인 줄만/);
  assert.throws(()=>f.change({action:'include',id:row('d').id}),/넣을지 뺄지/);
});
test('양식 ①: 할 일 칸 미리 채우기 — 진행 중 + 지난주 업무와 이어진 계획 중 안 끝난 것만, 다음 주 기한만으로는 넣지 않고, 하나만',t=>{
  const items=[
    {id:'doing',type:'task',description:'관리자 권한 등급 확인하기',status:'to-do',created:'2026-09-10',doing:'2026-09-18',group:'운영툴',label:'운영툴'},
    {id:'both',type:'task',description:'환불 API 연동 확인하기',status:'to-do',created:'2026-09-10',doing:'2026-09-22',group:'결제'},
    {id:'left',type:'task',description:'결제 문구 정리하기',status:'to-do',created:'2026-09-10',jira:'PAY-1',label:'PAY-1 · 결제 리뉴얼'},
    {id:'over',type:'task',description:'끝난 계획 업무',status:'done',created:'2026-09-10',completed:'2026-09-16',group:'결제'},
    {id:'due',type:'task',description:'다음 주 마감 업무',status:'to-do',created:'2026-09-10',due:'2026-09-29',scheduled:'2026-09-28',group:'결제'},
    {id:'lone',type:'task',description:'프로젝트 없는 진행 업무',status:'to-do',created:'2026-09-10',doing:'2026-09-22'},
  ];
  const f=formFixture(t,{items,current:'2026-09-14'});
  // 지난주(9/14)에 계획 줄을 셋 담아 저장해 둔다 — 업무와 이어진 것 둘 + 직접 적은 것 하나 + 뺀 것 하나.
  f.change({action:'add',text:'환불 연동',group:'결제',planOf:'both'});
  f.change({action:'add',text:'결제 문구',group:'PAY-1 · 결제 리뉴얼',planOf:'left'});
  f.change({action:'add',text:'끝난 것',group:'결제',planOf:'over'});
  f.change({action:'add',text:'직접 적은 계획'});
  f.change({action:'add',text:'뺀 계획',planOf:'due'});
  f.change({action:'exclude',id:f.plan().find(row=>row.text==='뺀 계획').id});
  assert.ok(f.plan('2026-09-14').every(row=>row.origin!=='carry'||row.planOf==='doing'||row.planOf==='both'||row.planOf==='lone'),'지난주에는 그때의 진행 중만');
  f.state.current='2026-09-21';
  const plan=f.plan();
  const carried=plan.filter(row=>row.origin==='carry');
  assert.deepEqual(carried.map(row=>row.planOf).sort(),['both','doing','left','lone'],'진행 중 둘 + 지난주 계획 중 안 끝난 것(진행 중과 겹친 것은 하나)');
  const by=id=>carried.find(row=>row.planOf===id);
  assert.deepEqual([by('doing').text,by('doing').group,by('doing').carryWhy,by('doing').locked],['관리자 권한 등급 확인','운영툴','doing',false]);
  assert.deepEqual([by('left').group,by('left').carryWhy],['PAY-1 · 결제 리뉴얼','plan'],'한 일 칸과 같은 이름 규칙(서버 label)');
  assert.equal(by('lone').group,'그룹 없음');
  assert.deepEqual([by('doing').sourceIds,by('doing').evidence],[[],[]],'planOf만 들고 이번 주 진행 중 자동 문장은 그대로');
  assert.ok(f.view().rows.some(row=>row.heading==='진행중'&&row.sourceIds.includes('doing')));
  assert.equal(by('doing').review,undefined);
  assert.equal(fs.existsSync(f.file)&&f.saved().weeks['2026-09-21'],undefined,'GET은 파일을 쓰지 않는다');
});
test('양식 ①: 미리 채운 줄 — 뺀 줄은 다시 안 들어오고, 안 고친 줄은 업무가 끝나거나 지워지면 빠지며, 고친 줄은 남는다 · 지난 주·확정한 주는 없다',t=>{
  const items=[
    {id:'x',type:'task',description:'권한 확인하기',status:'to-do',created:'2026-09-10',doing:'2026-09-22',group:'운영툴'},
    {id:'y',type:'task',description:'배너 정리하기',status:'to-do',created:'2026-09-10',doing:'2026-09-22',group:'운영툴'},
    {id:'z',type:'task',description:'메일 보내기',status:'to-do',created:'2026-09-10',doing:'2026-09-22',group:'운영툴'},
  ];
  const f=formFixture(t,{items});
  const carry=id=>f.plan().find(row=>row.planOf===id);
  f.change({action:'exclude',id:carry('x').id});
  assert.equal(carry('x').excluded,true);
  assert.equal(f.plan().filter(row=>row.planOf==='x').length,1,'뺀 줄은 다시 들어오지 않는다(제자리에 하나)');
  f.change({action:'edit',id:carry('y').id,text:'배너 정리 마무리'});
  assert.equal(f.saved().weeks['2026-09-21'].rows.find(row=>row.planOf==='y').origin,'carry','행 안 칸으로 저장된다(형식 번호 그대로)');
  assert.equal(f.saved().schema,1);
  items.find(item=>item.id==='y').status='done';
  items.find(item=>item.id==='z').status='done';
  assert.equal(carry('y').text,'배너 정리 마무리','고친 줄은 업무가 끝나도 남는다');
  assert.equal(carry('z'),undefined,'안 고친 줄은 업무가 끝나면 빠진다');
  items.find(item=>item.id==='z').status='to-do';
  items.find(item=>item.id==='z').description='메일 다시 보내기';
  assert.equal(carry('z').text,'메일 다시 보내기','안 고친 줄은 업무 제목을 따라간다');
  items.splice(items.findIndex(item=>item.id==='z'),1);
  assert.equal(carry('z'),undefined,'업무가 지워지면 빠진다');
  // 확정한 주·지난 주에는 새로 채우지 않는다.
  f.change({action:'confirm'});
  items.push({id:'w',type:'task',description:'새 진행 업무',status:'to-do',created:'2026-09-10',doing:'2026-09-23',group:'결제'});
  assert.equal(carry('w'),undefined,'확정한 주는 미리 채우기가 줄을 더하지 않는다');
  f.change({action:'unconfirm'});
  assert.ok(carry('w'));
  f.state.current='2026-09-28';
  assert.equal(f.plan('2026-09-21').some(row=>row.planOf==='w'),false,'지난 주 화면은 저장된 줄만');
});
test('양식 ①: keep은 지금 보이는 줄(미리 채운 줄 포함)을 문장·새로 기록·되돌리기 그대로 적고, 다음 주의 지난주 계획이 된다',t=>{
  const items=[
    {id:'a',type:'task',description:'문구 검토하기',status:'done',created:'2026-09-21',completed:'2026-09-22',group:'가입'},
    {id:'x',type:'task',description:'권한 확인하기',status:'to-do',created:'2026-09-10',doing:'2026-09-22',group:'운영툴'},
  ];
  const f=formFixture(t,{items});
  const before=f.view();
  const result=f.change({action:'keep'});
  assert.equal(result.undoToken,null,'되돌리기 기록을 남기지 않는다');
  const saved=f.saved();
  assert.deepEqual(saved.weeks['2026-09-21'].rows.map(row=>row.text).sort(),before.rows.map(row=>row.text).sort(),'문장은 그대로');
  assert.equal(saved.weekPolish,undefined,'새로 기록(seen)을 적지 않는다');
  assert.equal(saved.weeks['2026-09-21'].rows.find(row=>row.planOf==='x').carryWhy,undefined,'계산 값은 저장하지 않는다');
  const at=fs.statSync(f.file).mtimeMs;
  f.change({action:'keep'});
  assert.equal(fs.statSync(f.file).mtimeMs,at,'바뀐 것이 없으면 다시 쓰지 않는다');
  // 다음 주: 진행 중을 멈췄어도 지난주 계획(이어진 줄)에서 안 끝났으면 들어온다.
  delete items.find(item=>item.id==='x').doing;
  f.state.current='2026-09-28';
  assert.equal(f.plan().find(row=>row.planOf==='x').carryWhy,'plan');
});
test('양식 ①: link는 할 일 칸 줄만 업무와 잇고 끊으며 되돌리기 기록을 남기지 않는다',t=>{
  const f=formFixture(t,{items:[{id:'a',type:'task',description:'문구 검토하기',status:'done',created:'2026-09-21',completed:'2026-09-22',group:'가입'}]});
  f.change({action:'add',text:'금요일 휴가'});
  const line=f.plan()[0];
  const linked=f.change({action:'link',id:line.id,planOf:'new-task'});
  assert.equal(linked.undoToken,null);
  assert.equal(f.plan()[0].planOf,'new-task');
  f.change({action:'link',id:line.id,planOf:null});
  assert.equal(f.plan()[0].planOf,undefined);
  assert.throws(()=>f.change({action:'link',id:f.view().rows.find(row=>row.heading==='완료한 일').id,planOf:'x'}),/할 일 칸 줄만/);
});
test('양식 ①: 한 일 칸 소제목 이름은 `완료한 일|열쇠` → `진행중|열쇠` 순서로 찾고, 진행 중만 있는 프로젝트도 고치며, 고치면 옛 진행중 이름을 치운다',t=>{
  const items=[
    {id:'a',type:'task',description:'문구 검토하기',status:'done',created:'2026-09-21',completed:'2026-09-22',group:'가입'},
    {id:'b',type:'task',description:'퍼널 분석하기',status:'to-do',created:'2026-09-21',doing:'2026-09-22',group:'가입'},
    {id:'c',type:'task',description:'권한 정리하기',status:'to-do',created:'2026-09-21',doing:'2026-09-22',group:'운영'},
  ];
  const f=formFixture(t,{items});
  f.change({action:'rename',heading:'진행중',groupKey:'group:가입',text:'가입 옛 이름'});
  const row=id=>f.view().rows.find(entry=>entry.sourceIds.includes(id));
  assert.deepEqual([row('a').shownGroup,row('b').shownGroup],['가입 옛 이름','가입 옛 이름'],'옛 진행중 이름도 한 일 칸 전체에 보인다');
  f.change({action:'rename',heading:'완료한 일',groupKey:'group:운영',text:'운영 도구'});
  assert.equal(row('c').shownGroup,'운영 도구','완료 줄이 없는 프로젝트도 완료한 일 자리로 고친다');
  f.change({action:'rename',heading:'완료한 일',groupKey:'group:가입',text:'가입 개편'});
  assert.deepEqual(f.saved().weekPolish['2026-09-21'].names,{'완료한 일|group:운영':'운영 도구','완료한 일|group:가입':'가입 개편'},'진행중 자리는 치운다');
  f.change({action:'rename',heading:'완료한 일',groupKey:'group:가입',text:''});
  assert.equal(row('b').shownGroup,undefined,'비우면 원래대로');
  // 한 일 칸 `+ 한 줄 추가`는 진행 중만 있는 프로젝트에도 완료한 일로 더한다.
  const tasks={made:[],create(entry){const id=`w${tasks.made.length}`;tasks.made.push(id);items.push({id,type:'task',description:entry.description,status:'done',created:'2026-09-21',completed:'2026-09-22',group:entry.group});return id;},remove(){}};
  const store=factory({directory:f.directory,sources:()=>items,legacy:()=>[],currentWeek:()=>'2026-09-21',tasks});
  store.change({weekKey:'2026-09-21',revision:store.view('2026-09-21').revision,action:'addLine',heading:'완료한 일',groupKey:'group:운영',text:'권한 표 공유'});
  assert.ok(store.view('2026-09-21').rows.some(entry=>entry.text==='권한 표 공유'&&entry.heading==='완료한 일'));
});
test('양식 ① 검수: 확정한 주의 `보고에 없는 새 줄 N`은 결정·확인 묶음을 세지 않는다(넣어도 처음부터 빠진 줄이라)',t=>{
  const items=[{id:'a',type:'task',description:'문구 검토하기',status:'done',created:'2026-09-21',completed:'2026-09-22',group:'가입'}];
  const f=formFixture(t,{items});
  f.change({action:'confirm'});
  items.push({id:'d',type:'decision',description:'환불은 7일',status:'to-do',created:'2026-09-23',group:'가입'});
  items.push({id:'c',type:'check',description:'수수료 확인',status:'to-do',created:'2026-09-23',group:'운영'});
  assert.deepEqual([f.view().confirmed.pending,f.view().confirmed.pendingDone],[0,0],'결정·확인만 새로 들어오면 0');
  assert.throws(()=>f.change({action:'pullNew'}),/새로 넣을 줄이 없어요/);
  items.push({id:'b',type:'task',description:'배너 정리하기',status:'done',created:'2026-09-21',completed:'2026-09-23',group:'가입'});
  assert.equal(f.view().confirmed.pending,1,'끝낸 일은 그대로 센다');
});
test('양식 ① 검수: keep은 저장본과 줄 차례만 다르면 쓰지 않아 그 전 되돌리기가 살아 있다',t=>{
  const items=[
    {id:'a',type:'task',description:'문구 검토하기',status:'done',created:'2026-09-21',completed:'2026-09-22',group:'가입'},
    {id:'x',type:'task',description:'권한 확인하기',status:'to-do',created:'2026-09-10',doing:'2026-09-22',group:'운영툴'},
  ];
  const f=formFixture(t,{items});
  f.change({action:'add',text:'금요일 휴가'});
  const edit=f.change({action:'add',text:'가 먼저 오는 이름',group:'가나다'});
  const before=fs.readFileSync(f.file,'utf8');
  assert.notDeepEqual(f.view().rows.map(row=>row.id),f.saved().weeks['2026-09-21'].rows.map(row=>row.id),'보이는 차례와 저장 차례가 다르다');
  f.change({action:'keep'});
  assert.equal(fs.readFileSync(f.file,'utf8'),before,'차례만 다르면 쓰지 않는다');
  f.change({action:'undo',token:edit.undoToken});
  assert.equal(f.plan().some(row=>row.text==='가 먼저 오는 이름'),false,'그 전 변경을 ⌘Z로 되돌릴 수 있다');
});
test('양식 ① 검수: link는 미리 채운 줄(origin carry)에는 걸 수 없다',t=>{
  const f=formFixture(t,{items:[{id:'x',type:'task',description:'권한 확인하기',status:'to-do',created:'2026-09-10',doing:'2026-09-22',group:'운영툴'}]});
  const carry=f.plan().find(row=>row.origin==='carry');
  assert.throws(()=>f.change({action:'link',id:carry.id,planOf:'other'}),/미리 채운 줄은 이미 업무와 이어져 있어요/);
  assert.equal(f.plan().find(row=>row.origin==='carry').planOf,'x');
});

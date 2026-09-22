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
  const f=fixture(t);assert.equal(f.view().rows[0].text,'문구 검토함');assert.deepEqual(fs.readdirSync(f.directory),[]);
});
test('edited sentences survive new evidence; proposal is explicit',t=>{
  const f=fixture(t),id=f.view().rows[0].id;f.change({action:'edit',id,text:'가입 문구 검토 완료'});
  f.items.push({...f.items[0],id:'b',description:'문구 검토하기 후속 확인'});
  const row=f.view().rows[0];assert.equal(row.text,'가입 문구 검토 완료');assert.equal(row.suggestion.added,1);
  f.change({action:'acknowledge',id});assert.equal(f.view().rows[0].text,'가입 문구 검토 완료');assert.equal(f.view().rows[0].suggestion,undefined);assert.equal(f.view().rows[0].sourceIds.length,2);
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
  const id=f.view().rows[0].id,result=f.change({action:'edit',id,text:'편집'});f.change({action:'undo',token:result.undoToken});assert.equal(f.view().rows[0].text,'문구 검토함');
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
  assert.equal(after.text,'정산 배치 설계하기');
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
  // 두 문장만 묶고 셋째(`정산 배치 설계함`)는 낱 문장으로 남겨 둔다.
  f.mergeTwo=()=>f.change({action:'merge',ids:f.view().rows.filter(row=>row.text!=='정산 배치 설계함').map(row=>row.id)});
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
  assert.deepEqual(parts.map(part=>part.text).sort(),['문구 검토함','알림 배너 정리함']);
  assert.deepEqual(parts.map(part=>part.group).sort(),['가입','알림']);
});
test('묶음 풀기는 묶기 전 문장을 그대로 되살린다',t=>{
  const f=mergeFixture(t);
  const shape=rows=>rows.filter(row=>row.text!=='정산 배치 설계함').map(row=>[row.text,row.group,row.sourceIds,!!row.excluded]);
  const before=shape(f.view().rows);
  f.mergeTwo();
  f.change({action:'split',id:f.merged().id});
  assert.deepEqual(shape(f.view().rows),before);
  assert.equal(f.view().rows.some(row=>row.canSplit),false,'푼 뒤에는 풀 것이 남지 않는다');
});
test('묶음을 다시 묶은 것을 풀면 한 단계만 풀린다',t=>{
  const f=mergeFixture(t);f.mergeTwo();
  f.change({action:'merge',ids:[f.merged().id,f.view().rows.find(row=>row.text==='정산 배치 설계함').id]});
  assert.equal(f.view().rows.length,1);
  f.change({action:'split',id:f.merged().id});
  assert.equal(f.view().rows.length,2,'바깥 묶음만 풀려 안쪽 묶음 하나와 낱 문장 하나가 된다');
  assert.equal(f.merged().text,'문구 검토함\n알림 배너 정리함');
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
  assert.equal(f.merged().text,'문구 검토함\n알림 배너 정리함');
  assert.equal(f.merged().partCount,2,'되돌린 묶음도 다시 풀 수 있다');
});
test('저장 파일을 새로 읽어도(새 인스턴스) 묶음을 풀 수 있다',t=>{
  const f=mergeFixture(t);f.mergeTwo();
  const fresh=factory({directory:f.directory,sources:()=>f.items,legacy:()=>[],currentWeek:()=>'2026-09-14'});
  const view=()=>fresh.view('2026-09-14');
  assert.equal(view().rows.find(row=>row.canSplit).partCount,2);
  fresh.change({weekKey:'2026-09-14',revision:view().revision,action:'split',id:view().rows.find(row=>row.canSplit).id});
  assert.deepEqual(view().rows.map(row=>row.text).sort(),['문구 검토함','알림 배너 정리함','정산 배치 설계함'].sort());
  assert.equal(view().rows.some(row=>row.canSplit),false);
});
test('묶기 전 문장이 없는 옛 묶음은 그대로 읽히고, 풀기만 할 수 없다',t=>{
  const f=mergeFixture(t);f.mergeTwo();
  const file=path.join(f.directory,REPORT_FILE),saved=JSON.parse(fs.readFileSync(file,'utf8'));
  saved.weeks['2026-09-14'].rows.forEach(row=>{delete row.parts;});
  fs.writeFileSync(file,JSON.stringify(saved,null,2));
  const merged=f.view().rows.find(row=>row.text==='문구 검토함\n알림 배너 정리함');
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
  assert.deepEqual(f.shape(),[['문구 검토함',null],['정산 배치 설계함',null],['알림 배너 정리함',null]],'넣기 전에는 프로젝트 이름순이다');
  const parent=f.row('문구 검토함').id;
  f.change({action:'nest',id:f.row('알림 배너 정리함').id,parentId:parent});
  assert.deepEqual(f.shape(),[['문구 검토함',null],['알림 배너 정리함',parent],['정산 배치 설계함',null]],'넣은 문장은 부모 바로 뒤로 온다');
  assert.equal(f.row('알림 배너 정리함').text,'알림 배너 정리함','글자는 합치지 않는다');
  assert.equal(f.row('알림 배너 정리함').group,'알림','프로젝트·근거도 그대로 남는다');
  assert.deepEqual(f.row('알림 배너 정리함').sourceIds,['b']);
  // 여러 개를 넣으면 넣은 순서대로 부모 뒤에 줄을 선다.
  f.change({action:'nest',id:f.row('정산 배치 설계함').id,parentId:parent});
  assert.deepEqual(f.shape().map(([text])=>text),['문구 검토함','알림 배너 정리함','정산 배치 설계함']);
  // 따로 빼면 원래 자리로 돌아간다.
  f.change({action:'unnest',id:f.row('알림 배너 정리함').id});
  assert.deepEqual(f.shape(),[['문구 검토함',null],['정산 배치 설계함',parent],['알림 배너 정리함',null]]);
});
test('아래로 넣기는 같은 상태의 낱 문장끼리만 된다',t=>{
  const f=nestFixture(t);
  f.items.push({id:'d',type:'task',description:'진행 중인 일',status:'to-do',created:'2026-09-14',doing:'2026-09-15',group:'가입'});
  const a=f.row('문구 검토함').id,b=f.row('알림 배너 정리함').id,c=f.row('정산 배치 설계함').id,doing=f.row('진행 중인 일').id;
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
  const a=f.row('문구 검토함').id,b=f.row('알림 배너 정리함').id;
  assert.ok(a.startsWith('auto-')&&b.startsWith('auto-'),'아직 저장되지 않은 자동 초안이다');
  f.change({action:'nest',id:b,parentId:a});
  assert.deepEqual(f.savedRows().map(row=>row.id).sort(),f.view().rows.map(row=>row.id).sort(),'넣는 순간 모든 행이 저장 행이 된다');
  assert.equal(f.view().rows.find(row=>row.id===b).parent,a);
  // 저장된 뒤에도 잠기지 않은 행은 원본을 따라 갱신되고, id는 바뀌지 않아 들여쓰기가 끊기지 않는다.
  f.items.find(item=>item.id==='b').description='알림 배너 정리 마무리하기';
  f.items.find(item=>item.id==='a').outcome='가입 문구 확정';
  const after=f.view().rows;
  assert.equal(after.find(row=>row.id===b).text,'알림 배너 정리 마무리함');
  assert.equal(after.find(row=>row.id===a).text,'가입 문구 확정');
  assert.equal(after.find(row=>row.id===b).parent,a,'id가 그대로라 들여쓰기도 그대로다');
});
test('부모가 사라지거나 제외되거나 상태가 달라지면 넣었던 문장은 최상위로 보인다',t=>{
  const f=nestFixture(t);
  const a=f.row('문구 검토함').id,b=f.row('알림 배너 정리함').id;
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
  const a=f.row('문구 검토함').id,b=f.row('알림 배너 정리함').id;
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
  const a=f.row('문구 검토함').id,b=f.row('알림 배너 정리함').id;
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
  assert.equal(old.rows.find(row=>row.sourceIds.includes('a')).text,'문구 검토함');
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

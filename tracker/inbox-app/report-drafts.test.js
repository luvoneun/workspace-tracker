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
test('a historical saved draft is not silently rewritten by source changes',t=>{
  const f=fixture(t);f.items[0].created='2026-09-01';f.items[0].completed='2026-09-02';
  let old=f.store.view('2026-08-31');f.store.change({weekKey:old.weekKey,revision:old.revision,action:'add',text:'기록 보존'});
  f.items[0].description='이후 수정된 제목';old=f.store.view('2026-08-31');
  assert.equal(old.rows.find(row=>row.sourceIds.includes('a')).text,'문구 검토함');
});

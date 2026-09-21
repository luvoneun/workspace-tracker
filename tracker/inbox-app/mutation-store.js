const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { atomicWrite, observeWrites } = require('./safe-storage');
const digest = value => createHash('sha256').update(value).digest('hex');
// 복구가 끝나지 않았으면 저장을 통째로 멈춘다. 사람이 파일을 확인하기 전에 다음 저장이 덮어쓰지 못하게.
const RECOVERY_MESSAGE='복구가 필요해서 저장을 멈췄어요. 기존 기록은 그대로 있어요. README의 "복구 필요 상태"를 따라 정리한 뒤 서버를 다시 시작해 주세요.';
module.exports = directory => {
  const journal=path.join(directory,'.mutation-journal.json'),lock=path.join(directory,'.mutation.lock');
  let depth=0,recovery=null;
  const status=()=>({recoveryNeeded:!!recovery,reason:recovery?recovery.reason:null,message:recovery?RECOVERY_MESSAGE:null});
  function recoveryError() {
    const error=new Error(`${RECOVERY_MESSAGE} (원인: ${recovery.reason})`);
    error.status=503;error.code='RECOVERY_NEEDED';return error;
  }
  function restore(changes) {
    // Never overwrite a file changed by an external writer after this transaction.
    for(const change of changes) {
      const current=fs.existsSync(change.file)?fs.readFileSync(change.file):null;
      const before=change.before===null?null:Buffer.from(change.before,'base64');
      if(current && ![change.after,...(change.intermediate || [])].includes(digest(current)) && (!before || digest(current)!==digest(before))) throw new Error('밖에서 바뀐 파일이 있어요. 복구 저널과 지금 파일은 그대로 뒀어요.');
    }
    for(const change of [...changes].reverse()) {
      if(change.before===null){if(fs.existsSync(change.file))fs.unlinkSync(change.file);}
      else atomicWrite(change.file,Buffer.from(change.before,'base64'));
    }
  }
  function recover() {
    try {
      if(fs.existsSync(lock)) {
        const pid=Number(fs.readFileSync(lock,'utf8'));
        if(pid && pid!==process.pid) {try{process.kill(pid,0);throw new Error('다른 저장 프로세스가 돌고 있어요.');}catch(error){if(error.code!=='ESRCH')throw error;}}
      }
      if(fs.existsSync(journal)) {const value=JSON.parse(fs.readFileSync(journal,'utf8'));if(!value.committed)restore(value.changes);fs.unlinkSync(journal);}
      if(fs.existsSync(lock))fs.unlinkSync(lock);
      recovery=null;
    } catch(error) {recovery={reason:error.message};throw error;}
  }
  function run(action) {
    if(depth)return action();
    if(recovery)throw recoveryError();
    let fd;
    try{fd=fs.openSync(lock,'wx',0o600);}catch(error){if(error.code==='EEXIST'){const busy=new Error('다른 저장 작업이 돌고 있어요. 잠시 뒤 다시 시도해 주세요.');busy.status=409;throw busy;}throw error;}
    fs.writeFileSync(fd,String(process.pid));fs.closeSync(fd);
    const changes=new Map();let succeeded=false;
    try {
      depth++;
      observeWrites((file,content)=>{
        if(file===journal)return;
        const existing=changes.get(file);
        changes.set(file,{file,before:existing?existing.before:fs.existsSync(file)?fs.readFileSync(file).toString('base64'):null,after:digest(content),intermediate:existing?[...(existing.intermediate || []),existing.after]:[]});
        atomicWrite(journal,JSON.stringify({changes:[...changes.values()]}));
      });
      const result=action();
      observeWrites(null);atomicWrite(journal,JSON.stringify({committed:true}));succeeded=true;return result;
    } catch(error) {
      observeWrites(null);
      // 되돌리기가 거절되면 원래 실패 이유까지 남기고, 잠금과 저널은 그대로 둔 채 저장을 멈춘다.
      try{restore([...changes.values()]);}catch(refusal){recovery={reason:`${error.message} / ${refusal.message}`};throw recoveryError();}
      succeeded=true;throw error;
    }
    finally {observeWrites(null);depth=0;if(succeeded){if(fs.existsSync(journal))fs.unlinkSync(journal);fs.unlinkSync(lock);}}
  }
  return {run,recover,status};
};

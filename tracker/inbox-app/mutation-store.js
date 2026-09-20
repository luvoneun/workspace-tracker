const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { atomicWrite, observeWrites } = require('./safe-storage');
const digest = value => createHash('sha256').update(value).digest('hex');
module.exports = directory => {
  const journal=path.join(directory,'.mutation-journal.json'),lock=path.join(directory,'.mutation.lock');
  let depth=0;
  function restore(changes) {
    // Never overwrite a file changed by an external writer after this transaction.
    for(const change of changes) {
      const current=fs.existsSync(change.file)?fs.readFileSync(change.file):null;
      const before=change.before===null?null:Buffer.from(change.before,'base64');
      if(current && ![change.after,...(change.intermediate || [])].includes(digest(current)) && (!before || digest(current)!==digest(before))) throw new Error('외부에서 변경된 파일이 있습니다. 복구 저널과 현재 파일을 보존했습니다.');
    }
    for(const change of [...changes].reverse()) {
      if(change.before===null){if(fs.existsSync(change.file))fs.unlinkSync(change.file);}
      else atomicWrite(change.file,Buffer.from(change.before,'base64'));
    }
  }
  function recover() {
    if(fs.existsSync(lock)) {
      const pid=Number(fs.readFileSync(lock,'utf8'));
      if(pid && pid!==process.pid) {try{process.kill(pid,0);throw new Error('다른 저장 프로세스가 실행 중입니다.');}catch(error){if(error.code!=='ESRCH')throw error;}}
    }
    if(fs.existsSync(journal)) {const value=JSON.parse(fs.readFileSync(journal,'utf8'));if(!value.committed)restore(value.changes);fs.unlinkSync(journal);}
    if(fs.existsSync(lock))fs.unlinkSync(lock);
  }
  function run(action) {
    if(depth)return action();
    let fd;
    try{fd=fs.openSync(lock,'wx',0o600);}catch(error){if(error.code==='EEXIST'){const busy=new Error('다른 저장 작업이 진행 중입니다. 잠시 후 다시 시도해 주세요.');busy.status=409;throw busy;}throw error;}
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
    } catch(error) {observeWrites(null);restore([...changes.values()]);succeeded=true;throw error;}
    finally {observeWrites(null);depth=0;if(succeeded){if(fs.existsSync(journal))fs.unlinkSync(journal);fs.unlinkSync(lock);}}
  }
  return {run,recover};
};

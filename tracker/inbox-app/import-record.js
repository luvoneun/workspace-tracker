// JSON on stdin; uses the same validation/transaction boundary as the app.
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
let input='';process.stdin.on('data',chunk=>{input+=chunk;if(input.length>1024*1024){console.error('입력이 너무 큽니다.');process.exit(1);}});
process.stdin.on('end',async()=>{
  try {
    const payload=JSON.parse(input),kind=process.argv[2] || 'item';
    const configPath=process.env.WORKSPACE_CONFIG || path.join(__dirname,'../../workspace.config.json');
    const config=fs.existsSync(configPath)?JSON.parse(fs.readFileSync(configPath,'utf8')):{};
    const port=Number(process.env.WORKSPACE_PORT || config.server?.port || 4321);
    const body=JSON.stringify({kind,payload,...(kind==='health'?{attempt:new Date().toISOString()}:{})});
    const response=await fetch(`http://127.0.0.1:${port}/api/import`,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':createHash('sha256').update(body).digest('hex')},body,signal:AbortSignal.timeout(20000)});
    const result=await response.json();if(!response.ok || !result.ok)throw new Error(result.error || `HTTP ${response.status}`);process.stdout.write(JSON.stringify(result));
  } catch(error){console.error(`저장하지 못했습니다: ${error.message}. 원본 파일을 직접 수정하지 말고 커서를 유지해 주세요.`);process.exitCode=1;}
});

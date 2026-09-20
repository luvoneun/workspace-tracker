// JSON from a command-line argument (stdin when it is omitted); uses the same validation/transaction boundary as the app.
// 인자 방식이 기본인 이유: 헤드리스 캡처는 파일 수정 권한 없이 도는데, 그 상태에서 JSON을
// 보내는 방법 중 파이프(echo … | node …)와 히어독은 Bash 도구의 명령 검사에 막힌다.
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
async function send(input){
  try {
    const payload=JSON.parse(input),kind=process.argv[2] || 'item';
    const configPath=process.env.WORKSPACE_CONFIG || path.join(__dirname,'../../workspace.config.json');
    const config=fs.existsSync(configPath)?JSON.parse(fs.readFileSync(configPath,'utf8')):{};
    const port=Number(process.env.WORKSPACE_PORT || config.server?.port || 4321);
    const body=JSON.stringify({kind,payload,...(kind==='health'?{attempt:new Date().toISOString()}:{})});
    const response=await fetch(`http://127.0.0.1:${port}/api/import`,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':createHash('sha256').update(body).digest('hex')},body,signal:AbortSignal.timeout(20000)});
    const result=await response.json();if(!response.ok || !result.ok)throw new Error(result.error || `HTTP ${response.status}`);process.stdout.write(JSON.stringify(result));
  } catch(error){console.error(`저장하지 못했습니다: ${error.message}. 원본 파일을 직접 수정하지 말고 커서를 유지해 주세요.`);process.exitCode=1;}
}
if(process.argv[3]!==undefined)send(process.argv[3]);
else{let input='';process.stdin.on('data',chunk=>{input+=chunk;if(input.length>1024*1024){console.error('입력이 너무 큽니다.');process.exit(1);}});process.stdin.on('end',()=>send(input));}

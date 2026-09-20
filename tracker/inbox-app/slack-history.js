const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
async function history({ token, channel, oldest, limit = 100, request = fetch }) {
  const messages = [], seen = new Set(); let cursor = '';
  do {
    const url = new URL('https://slack.com/api/conversations.history');
    url.searchParams.set('channel', channel);url.searchParams.set('limit', String(limit));
    if(oldest)url.searchParams.set('oldest',oldest);if(cursor)url.searchParams.set('cursor',cursor);
    const response=await request(url,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw new Error(`Slack HTTP ${response.status}; 커서는 유지됩니다.`);
    const result=await response.json();if(!result.ok)throw new Error(`Slack: ${result.error || 'unknown'}`);
    if(!Array.isArray(result.messages))throw new Error('Slack 응답을 확인해 주세요.');
    messages.push(...result.messages);
    const next=result.response_metadata?.next_cursor || '';
    if(result.has_more && !next)throw new Error('다음 페이지 커서가 없습니다. 커서는 유지됩니다.');
    if(next && seen.has(next))throw new Error('페이지 커서가 반복됩니다.');
    seen.add(next);cursor=next;
  } while(cursor);
  return {ok:true,messages,has_more:false,response_metadata:{next_cursor:''}};
}
if(require.main===module) {
  (async()=>{
    const config=JSON.parse(fs.readFileSync(process.env.WORKSPACE_CONFIG || path.join(__dirname,'../../workspace.config.json'),'utf8'));
    const tokenPath=(config.slack?.tokenFile || '').replace(/^~(?=\/|$)/,os.homedir());
    const token=fs.readFileSync(tokenPath,'utf8').trim();if(!token)throw new Error('토큰을 읽지 못했습니다.');
    const result=await history({token,channel:process.argv[2],limit:Number(process.argv[3]||100),oldest:process.argv[4]});process.stdout.write(JSON.stringify(result));
  })().catch(error=>{console.error(error.message);process.exitCode=1;});
}
module.exports={history};

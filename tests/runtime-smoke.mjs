// Real official Claude Code + real SDK + local scripted provider. No paid API or model intelligence test.
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
const temp=mkdtempSync(join(tmpdir(),'Portable AI runtime smoke '));
process.env.PORTABLE_AI_DATA_DIR=join(temp,'data');
const {saveProfile,readConfig}=await import('../lib/config.mjs');
const {SessionStore}=await import('../lib/sessions.mjs');
const {AgentManager}=await import('../lib/agent.mjs');
const {readBody}=await import('../lib/http.mjs');
writeFileSync(join(temp,'input.txt'),'portable-runtime-read-check');
let requests=0,approvals=0;
const upstream=createServer(async(req,res)=>{
  try{
    if(req.url==='/v1/models'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({data:[{id:'portable-test'}]}));}
    if(req.url!=='/v1/chat/completions'){res.writeHead(404);return res.end('{}');}
    const body=await readBody(req);requests++;
    const results=body.messages.filter(m=>m.role==='tool'&&m.tool_call_id?.startsWith('smoke-'));
    const steps=[{name:'Read',input:{file_path:join(temp,'input.txt')}},{name:'Write',input:{file_path:join(temp,'output.txt'),content:'verified official Claude Code\n'}},{name:'Bash',input:{command:'node --version',description:'Verify Node.js in the smoke-test workspace'}}];
    const step=steps[results.length];
    let message={content:'Smoke workflow complete.\n\n```js\nconst runtime = "official";\n```'};
    if(step&&body.tools?.some(t=>t.function.name===step.name))message={content:null,tool_calls:[{id:`smoke-${results.length}`,type:'function',function:{name:step.name,arguments:JSON.stringify(step.input)}}]};
    const choice={message,finish_reason:message.tool_calls?'tool_calls':'stop'};
    if(body.stream){res.writeHead(200,{'Content-Type':'text/event-stream'});const delta=message.tool_calls?{tool_calls:message.tool_calls.map((t,index)=>({...t,index}))}:{content:message.content};res.write(`data: ${JSON.stringify({id:'smoke-message',choices:[{index:0,delta,finish_reason:null}]})}\n\n`);res.write(`data: ${JSON.stringify({choices:[{index:0,delta:{},finish_reason:choice.finish_reason}],usage:{prompt_tokens:100,completion_tokens:20}})}\n\n`);res.end('data: [DONE]\n\n');}
    else{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'smoke-message',choices:[choice],usage:{prompt_tokens:100,completion_tokens:20}}));}
  }catch(e){res.writeHead(500);res.end(JSON.stringify({error:{message:e.message}}));}
});
await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
const profile={provider:'custom',model:'portable-test',auth:'api',baseUrl:`http://127.0.0.1:${upstream.address().port}/v1`,key:''};saveProfile(profile);
const store=new SessionStore(),manager=new AgentManager(store);const session=store.create({workspace:temp,profile:readConfig().profiles.custom,trusted:true});
const timeout=setTimeout(()=>{console.error('Smoke test timed out');manager.cancel(session.id);},90000);
try{
  const run=await manager.start(session.id,'Read input.txt, write output.txt with the agreed content, then run node --version.',{},e=>{if(['result','session','approval'].includes(e.type))console.log(e.type,e.status||e.tool||e.sdkSessionId,e.error||'');if(e.type==='approval'){approvals++;setImmediate(()=>manager.approve(session.id,e.requestId,true));}});await run.promise;
  const saved=store.get(session.id);assert.equal(saved.status,'completed',saved.error||'Agent failed');assert.ok(saved.sdkSessionId);assert.ok(existsSync(join(temp,'output.txt')),'Write tool did not execute');assert.equal(readFileSync(join(temp,'output.txt'),'utf8'),'verified official Claude Code\n');assert.ok(approvals>0,'No approval was requested');assert.ok(saved.events.some(e=>e.type==='tool'&&e.name==='Bash'),'Bash tool did not execute');
  const resumed=await manager.start(session.id,'Confirm that the workflow is complete.',{},()=>{});await resumed.promise;assert.equal(store.get(session.id).status,'completed');assert.equal(store.get(session.id).sdkSessionId,saved.sdkSessionId);
  console.log(JSON.stringify({result:'PASS',runtime:'official Claude Code',provider:'local scripted mock',requests,approvals,readWriteCommand:true,resume:true},null,2));
}finally{clearTimeout(timeout);await manager.close();upstream.closeAllConnections();await new Promise(r=>upstream.close(r));rmSync(temp,{recursive:true,force:true,maxRetries:10,retryDelay:100});}

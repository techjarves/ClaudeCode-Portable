import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
const temp=mkdtempSync(join(tmpdir(),'portable-ai-tests-'));process.env.PORTABLE_AI_DATA_DIR=join(temp,'data');
const { saveProfile,activateProfile,readConfig,publicConfig,redact,parseLegacy,migrateLegacy,validateBaseURL }=await import('../lib/config.mjs');
const { PROVIDERS,providerEnvironment,testConnection }=await import('../lib/providers.mjs');
const { SessionStore }=await import('../lib/sessions.mjs');
const { AgentManager }=await import('../lib/agent.mjs');
const { startDashboard }=await import('../dashboard/server.mjs');
const { installRuntime,rollbackRuntime }=await import('../lib/runtime.mjs');
const { sessionTranscript }=await import('../lib/transcript.mjs');
const { pickWorkspace }=await import('../lib/workspace-picker.mjs');
test.after(()=>rmSync(temp,{recursive:true,force:true}));
const profile={provider:'custom',model:'test-model',auth:'api',baseUrl:'http://127.0.0.1:9099/v1',key:'test-secret-not-real'};
test('all nine providers and safe configuration round trips',()=>{
  assert.equal(Object.keys(PROVIDERS).length,9);saveProfile({...profile,contextWindow:128000});
  assert.equal(readConfig().profiles.custom.contextWindow,128000);assert.throws(()=>saveProfile({...profile,contextWindow:100}),/Context window/);
  assert.equal(readConfig().profiles.custom.key,profile.key);assert.equal(publicConfig().profiles.custom.hasKey,true);assert.equal(publicConfig().profiles.custom.key,undefined);
  saveProfile({...profile,key:undefined,model:'next'});assert.equal(readConfig().profiles.custom.key,profile.key);saveProfile(profile);
  assert.equal(redact(`value ${profile.key}`),'value [REDACTED]');
  assert.throws(()=>validateBaseURL('http://remote.example/v1'),/HTTPS/);assert.throws(()=>validateBaseURL('https://key:secret@example.com'),/without credentials/);
  saveProfile({provider:'openrouter',model:'free-test',auth:'api',baseUrl:'https://openrouter.ai/api/v1',key:'fixture-key'});assert.equal(readConfig().profiles.openrouter.baseUrl,'https://openrouter.ai/api');
  assert.equal(activateProfile('openrouter').active,'openrouter');assert.throws(()=>activateProfile('gemini'),/Configure/);saveProfile(profile);
});
test('legacy config parsing handles CRLF and keeps equal signs',()=>{
  const env=parseLegacy('# c\r\nAI_PROVIDER=openai\r\nOPENAI_BASE_URL=https://openrouter.ai/api/v1\r\nOPENAI_API_KEY=abc=def\r\nOPENAI_MODEL=model-a\r\n');
  const migrated=migrateLegacy(env);assert.equal(migrated.provider,'openrouter');assert.equal(migrated.key,'abc=def');assert.equal(migrated.baseUrl,'https://openrouter.ai/api');
});
test('provider environments remove ambient credentials and pin all model roles',()=>{
  const parent={HOME:'/unchanged',PATH:'/bin',ANTHROPIC_API_KEY:'must-not-leak',ANTHROPIC_AUTH_TOKEN:'must-not-leak',CLAUDE_CODE_USE_OPENAI:'1',OPENAI_API_KEY:'must-not-leak',AWS_SECRET_ACCESS_KEY:'must-not-leak'};
  const env=providerEnvironment(profile,{adapter:{url:'http://127.0.0.1:1',token:'local-token'},parent});
  assert.equal(env.HOME,'/unchanged');assert.equal(env.ANTHROPIC_AUTH_TOKEN,'local-token');assert.equal(env.OPENAI_API_KEY,undefined);assert.equal(env.AWS_SECRET_ACCESS_KEY,undefined);assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL,profile.model);
  assert.throws(()=>providerEnvironment({provider:'openrouter',auth:'login',baseUrl:'https://openrouter.ai/api'},{}),/Subscription/);
  assert.throws(()=>providerEnvironment({provider:'anthropic',auth:'login'},{dashboard:true}),/terminal-only/);
});
test('connection test uses an authenticated provider endpoint and reports rejected keys',async()=>{
  let request;
  const candidate={provider:'openrouter',baseUrl:PROVIDERS.openrouter.baseUrl,key:'candidate-key'};
  const success=await testConnection(candidate,{fetcher:async(url,options)=>{request={url,options};return new Response('{}',{status:200,headers:{'content-type':'application/json'}});}});
  assert.equal(request.url,'https://openrouter.ai/api/v1/auth/key');assert.equal(request.options.headers.Authorization,'Bearer candidate-key');assert.equal(success.ok,true);
  await assert.rejects(testConnection(candidate,{fetcher:async()=>new Response(JSON.stringify({error:{message:'API key expired: candidate-key'}}),{status:401,headers:{'content-type':'application/json'}})}),error=>/credential was rejected.*API key expired.*\[REDACTED\]/i.test(error.message));
});
test('session workspace trust, traversal rejection, fingerprint and recovery',()=>{
  const store=new SessionStore(join(temp,'sessions'));assert.throws(()=>store.create({workspace:temp,profile,trusted:false}),/trust/);
  const session=store.create({workspace:temp,profile,trusted:true});assert.throws(()=>store.get('../secret'),/Invalid/);
  session.status='running';store.save(session);store.recover();assert.equal(store.get(session.id).status,'interrupted');assert.equal(store.list().length,1);store.delete(session.id);assert.equal(store.list().length,0);
});
test('native workspace picker validates the selected directory and handles cancellation',async()=>{
  let invocation;
  assert.equal(await pickWorkspace(temp,{platform:'darwin',runner:async(command,args)=>{invocation={command,args};return `${temp}\n`;}}),realpathSync(temp));
  assert.equal(invocation.command,'/usr/bin/osascript');assert.equal(invocation.args.at(-1),realpathSync(temp));
  assert.equal(await pickWorkspace(temp,{platform:'darwin',runner:async()=>{throw Object.assign(new Error('User canceled.'),{code:1});}}),null);
});
test('failed runtime installation preserves the working copy',async()=>{
  const target=join(temp,'runtime/current');mkdirSync(target,{recursive:true});writeFileSync(join(target,'keep.txt'),'working');
  await assert.rejects(installRuntime({target,runner:async()=>{throw new Error('simulated install failure');}}),/simulated/);
  assert.equal(readFileSync(join(target,'keep.txt'),'utf8'),'working');assert.equal(existsSync(join(temp,'runtime/install.lock')),false);
});
test('verified runtime replacement retains the old copy and rollback restores it',async()=>{
  const target=join(temp,'transaction/current');
  const writeRuntime=(dir,tag)=>{mkdirSync(join(dir,'node_modules/@anthropic-ai/claude-code/bin'),{recursive:true});writeFileSync(join(dir,'node_modules/@anthropic-ai/claude-code/package.json'),JSON.stringify({bin:{claude:'bin/claude.exe'}}));writeFileSync(join(dir,'node_modules/@anthropic-ai/claude-code/bin/claude.exe'),tag);};
  writeRuntime(target,'old');
  await installRuntime({target,runner:async(cmd,args,options)=>{if(args[0]==='--version')return '2.1.247 (Claude Code)';writeRuntime(options.cwd,'new');return '';}});
  const exe='node_modules/@anthropic-ai/claude-code/bin/claude.exe';assert.equal(readFileSync(join(target,exe),'utf8'),'new');
  await rollbackRuntime({target,runner:async()=> '2.1.247 (Claude Code)'});assert.equal(readFileSync(join(target,exe),'utf8'),'old');
});
test('dashboard blocks unauthenticated, cross-origin and rebinding requests',async t=>{
  const app=await startDashboard({port:0,store:new SessionStore(join(temp,'http-sessions')),workspacePicker:async()=>temp,connectionTester:async candidate=>({ok:true,message:`Validated ${candidate.provider}`} )});t.after(()=>app.close());
  assert.equal((await fetch(`${app.origin}/api/config`)).status,401);
  assert.equal((await fetch(`${app.origin}/api/config`,{headers:{'X-Portable-Token':app.token,Origin:'http://evil.example'}})).status,403);
  const rebinding=await new Promise((resolve,reject)=>{const req=request(`${app.origin}/api/config`,{headers:{'X-Portable-Token':app.token,Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});assert.equal(rebinding,403);
  const response=await fetch(`${app.origin}/api/config`,{headers:{'X-Portable-Token':app.token}});assert.equal(response.status,200);assert.doesNotMatch(await response.text(),/test-secret-not-real/);
  const keyResponse=await fetch(`${app.origin}/api/config/key?provider=custom`,{headers:{'X-Portable-Token':app.token}});assert.equal(keyResponse.status,200);assert.deepEqual(await keyResponse.json(),{key:'test-secret-not-real'});
  const switched=await fetch(`${app.origin}/api/config/active`,{method:'POST',headers:{'X-Portable-Token':app.token,'Content-Type':'application/json'},body:JSON.stringify({provider:'openrouter'})});assert.equal(switched.status,200);assert.equal((await switched.json()).active,'openrouter');activateProfile('custom');
  const page=await fetch(app.origin);assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  assert.equal((await fetch(`${app.origin}/data/settings.json`)).status,404);
  assert.equal((await fetch(`${app.origin}/api/config`,{method:'POST',headers:{'X-Portable-Token':app.token,'Content-Type':'text/plain'},body:'{}'})).status,415);
  const picked=await fetch(`${app.origin}/api/workspace/pick`,{method:'POST',headers:{'X-Portable-Token':app.token,'Content-Type':'application/json'},body:JSON.stringify({initial:'/ignored'})});
  assert.deepEqual(await picked.json(),{workspace:temp,cancelled:false});
  const created=await fetch(`${app.origin}/api/sessions`,{method:'POST',headers:{'X-Portable-Token':app.token,'Content-Type':'application/json'},body:JSON.stringify({workspace:temp,trusted:true})});const session=await created.json();assert.equal(created.status,201);
  const upload=await fetch(`${app.origin}/api/sessions/${session.id}/attachments`,{method:'POST',headers:{'X-Portable-Token':app.token,'Content-Type':'application/json'},body:JSON.stringify({files:[{name:'screen.png',type:'image/png',data:Buffer.from('image fixture').toString('base64')}]})});const uploaded=await upload.json();assert.equal(upload.status,201);assert.equal(uploaded.attachments[0].name,'screen.png');
  assert.equal((await fetch(`${app.origin}/api/sessions/${session.id}`,{method:'DELETE',headers:{'X-Portable-Token':app.token}})).status,200);
  const tested=await fetch(`${app.origin}/api/connection/test`,{method:'POST',headers:{'X-Portable-Token':app.token,'Content-Type':'application/json'},body:JSON.stringify(profile)});
  assert.deepEqual(await tested.json(),{ok:true,message:'Validated custom'});
});
test('SDK bridge forwards approval decisions, stores real session IDs and resumes',async()=>{
  saveProfile({...profile,provider:'lmstudio',baseUrl:PROVIDERS.lmstudio.baseUrl});const p=readConfig().profiles.lmstudio;
  const store=new SessionStore(join(temp,'agent-sessions'));const s=store.create({workspace:temp,profile:p,trusted:true});let decisions=[],resumes=[],prompts=[],visible=[];
  const manager=new AgentManager(store,{executable:()=>'/fake/claude',sdkLoader:async()=>({query:({prompt,options})=>{
    prompts.push(prompt);resumes.push(options.resume);const q=(async function*(){yield {type:'system',subtype:'init',session_id:'sdk-session-123'};
      decisions.push(await options.canUseTool('Write',{file_path:'file.txt',content:'hello'},{signal:new AbortController().signal,toolUseID:'tool1'}));
      yield {type:'assistant',message:{id:'a',content:[{type:'text',text:'Done.'}]}};
      yield {type:'result',session_id:'sdk-session-123',is_error:false,usage:{input_tokens:10,output_tokens:5},total_cost_usd:0.001};})();q.close=()=>{};return q;
  }})});
  for(const approved of [true,false]){
    const run=await manager.start(s.id,'test',approved?{attachments:[{id:'file-id',name:'screen.png',type:'image/png',size:12,path:'/private/verified/screen.png'}]}:{},event=>{visible.push(event);if(event.type==='approval')setImmediate(()=>manager.approve(s.id,event.requestId,approved));});await run.promise;
  }
  assert.match(prompts[0],/screen\.png.*\/private\/verified\/screen\.png/);assert.doesNotMatch(JSON.stringify(visible.filter(event=>event.type==='message')),/\/private\/verified/);
  assert.equal(visible.find(event=>event.type==='message'&&event.role==='user').attachments[0].name,'screen.png');assert.equal(decisions[0].behavior,'allow');assert.equal(decisions[1].behavior,'deny');assert.equal(resumes[1],'sdk-session-123');assert.equal(store.get(s.id).sdkSessionId,'sdk-session-123');assert.equal(store.get(s.id).status,'completed');
  await assert.rejects(manager.start(s.id,'bad',{unrestricted:true}),/confirmation/);
});
test('OpenAI adapters resume the same native Claude conversation',async()=>{
  saveProfile(profile);const p=readConfig().profiles.custom;
  const store=new SessionStore(join(temp,'adapter-handoff-sessions')),s=store.create({workspace:temp,profile:p,trusted:true});const calls=[];let turn=0;
  const manager=new AgentManager(store,{executable:()=>'/fake/claude',sdkLoader:async()=>({query:({prompt,options})=>{calls.push({prompt,resume:options.resume});const q=(async function*(){yield {type:'system',subtype:'init',session_id:`fresh-${++turn}`};yield {type:'assistant',message:{id:`a-${turn}`,content:[{type:'text',text:turn===1?'Your name is usaram.':'It is usaram.'}]}};yield {type:'result',is_error:false};})();q.close=()=>{};return q;}})});
  await(await manager.start(s.id,'my name is usaram')).promise;
  await(await manager.start(s.id,"what's my name?")).promise;
  assert.equal(calls[1].resume,'fresh-1');assert.equal(calls[1].prompt,"what's my name?");
});
test('native Claude terminal conversations are imported with their project and timeline',()=>{
  saveProfile(profile);const id='11111111-2222-4333-8444-555555555555',project=join(process.env.PORTABLE_AI_DATA_DIR,'claude','custom-api','projects','fixture-project');mkdirSync(project,{recursive:true});
  const rows=[{type:'user',cwd:temp,timestamp:'2026-01-01T00:00:00.000Z',message:{content:[{type:'text',text:'Terminal conversation'}]}},{type:'assistant',cwd:temp,timestamp:'2026-01-01T00:00:01.000Z',message:{id:'a',model:'test-model',content:[{type:'text',text:'Shared reply'}]}}];writeFileSync(join(project,`${id}.jsonl`),rows.map(JSON.stringify).join('\n')+'\n');
  const store=new SessionStore(join(temp,'native-import-sessions'));store.syncNative(readConfig());const imported=store.list().find(session=>session.sdkSessionId===id);assert.ok(imported);assert.equal(imported.workspace,temp);assert.equal(imported.nativeConversation,true);assert.deepEqual(store.get(imported.id).transcript.map(event=>event.text),['Terminal conversation','Shared reply']);
});
test('composer permissions map to the SDK and unrestricted access requires confirmation',async()=>{
  saveProfile({...profile,provider:'lmstudio',baseUrl:PROVIDERS.lmstudio.baseUrl});const p=readConfig().profiles.lmstudio;
  const store=new SessionStore(join(temp,'permission-sessions')),s=store.create({workspace:temp,profile:p,trusted:true});const observed=[];
  const manager=new AgentManager(store,{executable:()=>'/fixture/claude',sdkLoader:async()=>({query:({options})=>(async function*(){observed.push(options);yield {type:'result',is_error:false};})()})});
  for(const permissionMode of ['default','acceptEdits','bypassPermissions']){
    await(await manager.start(s.id,'test permissions',{permissionMode,...(permissionMode==='bypassPermissions'?{confirmation:'UNRESTRICTED'}:{})})).promise;
    assert.equal(observed.at(-1).permissionMode,permissionMode);assert.equal(observed.at(-1).allowDangerouslySkipPermissions,permissionMode==='bypassPermissions');assert.equal(store.get(s.id).permissionMode,permissionMode);
  }
  await assert.rejects(manager.start(s.id,'bad',{permissionMode:'bypassPermissions'}),/confirmation/);
  await assert.rejects(manager.start(s.id,'bad',{permissionMode:'auto'}),/Unsupported permission/);
});
test('runtime questions require every answer and preserve multi-choice/custom text',async()=>{
  const p=readConfig().profiles.lmstudio,store=new SessionStore(join(temp,'question-sessions')),s=store.create({workspace:temp,profile:p,trusted:true});let decision;
  const manager=new AgentManager(store,{executable:()=>'/fixture/claude',sdkLoader:async()=>({query:({options})=>(async function*(){decision=await options.canUseTool('AskUserQuestion',{questions:[{question:'Focus?'},{question:'Details?',multiSelect:true}]},{toolUseID:'question',signal:options.abortController.signal});yield {type:'result',is_error:false};})()})});
  const run=await manager.start(s.id,'question',{},event=>{if(event.type==='approval')setImmediate(()=>{
    assert.throws(()=>manager.approve(s.id,event.requestId,true,{'Focus?':'UI'}),/Every question/);
    manager.approve(s.id,event.requestId,true,{'Focus?':'UI','Details?':'Keyboard\nMobile\nCustom detail'});
  });});await run.promise;assert.equal(decision.behavior,'allow');assert.equal(decision.updatedInput.answers['Details?'],'Keyboard\nMobile\nCustom detail');
});
test('cancellation denies pending approval and persists cancelled state',async()=>{
  const p=readConfig().profiles.lmstudio;const store=new SessionStore(join(temp,'cancel-sessions'));const s=store.create({workspace:temp,profile:p,trusted:true});let answer;
  const manager=new AgentManager(store,{executable:()=>'/fake/claude',sdkLoader:async()=>({query:({options})=>{const q=(async function*(){answer=await options.canUseTool('Write',{file_path:'x'},{signal:options.abortController.signal,toolUseID:'cancel-tool'});yield {type:'result',is_error:false,session_id:'cancel-sdk'};})();q.close=()=>{};q.interrupt=async()=>{};return q;}})});
  const run=await manager.start(s.id,'cancel',{},event=>{if(event.type==='approval')setImmediate(()=>manager.cancel(s.id));});await run.promise;assert.equal(answer.behavior,'deny');assert.equal(store.get(s.id).status,'cancelled');assert.equal(manager.runs.size,0);
});
test('model response waits stop at the configured limit',async()=>{
  saveProfile({provider:'lmstudio',model:'timeout-model',auth:'api',baseUrl:PROVIDERS.lmstudio.baseUrl,key:''});const p=readConfig().profiles.lmstudio;
  const store=new SessionStore(join(temp,'timeout-sessions')),s=store.create({workspace:temp,profile:p,trusted:true});
  const manager=new AgentManager(store,{executable:()=>'/fake/claude',responseTimeoutMs:20,sdkLoader:async()=>({query:({options})=>{
    const q=(async function*(){yield {type:'system',subtype:'init',session_id:'timeout-session'};await new Promise((resolve,reject)=>{const abort=()=>reject(new Error('aborted'));options.abortController.signal.addEventListener('abort',abort,{once:true});if(options.abortController.signal.aborted)abort();});})();
    q.interrupt=async()=>{};q.close=()=>{};return q;
  }})});
  await(await manager.start(s.id,'wait forever')).promise;
  assert.equal(store.get(s.id).status,'failed');assert.match(store.get(s.id).error,/did not respond within .*stopped automatically/i);assert.equal(manager.runs.size,0);
});
test('runtime provider errors fail immediately with their real message',async()=>{
  saveProfile({provider:'lmstudio',model:'error-model',auth:'api',baseUrl:PROVIDERS.lmstudio.baseUrl,key:''});const p=readConfig().profiles.lmstudio;
  const store=new SessionStore(join(temp,'provider-error-sessions')),s=store.create({workspace:temp,profile:p,trusted:true});
  const manager=new AgentManager(store,{executable:()=>'/fake/claude',responseTimeoutMs:5000,sdkLoader:async()=>({query:({options})=>{
    const q=(async function*(){options.stderr('API Error: HTTP 401 upstream credential rejected');await new Promise((resolve,reject)=>{const abort=()=>reject(new Error('aborted'));options.abortController.signal.addEventListener('abort',abort,{once:true});if(options.abortController.signal.aborted)abort();});})();q.interrupt=async()=>{};q.close=()=>{};return q;
  }})});
  const started=Date.now();await(await manager.start(s.id,'fail fast')).promise;
  assert.equal(store.get(s.id).status,'failed');assert.match(store.get(s.id).error,/HTTP 401 upstream credential rejected/);assert.ok(Date.now()-started<1000);
});
test('opaque runtime failures become honest provider diagnostics',async()=>{
  const p=readConfig().profiles.lmstudio;const store=new SessionStore(join(temp,'opaque-error-sessions')),s=store.create({workspace:temp,profile:p,trusted:true});
  const manager=new AgentManager(store,{executable:()=>'/fake/claude',sdkLoader:async()=>({query:()=>{const q=(async function*(){yield {type:'result',is_error:true,errors:['Internal server error']};})();q.close=()=>{};return q;}})});
  await(await manager.start(s.id,'trigger opaque error')).promise;const error=store.get(s.id).error;assert.match(error,/LM Studio request failed.*model.*no diagnostic details/i);assert.doesNotMatch(error,/^Internal server error$/i);
});
test('multiple blocks with one SDK message ID retain text and tools',async()=>{
  const p=readConfig().profiles.lmstudio;const store=new SessionStore(join(temp,'blocks-sessions'));const s=store.create({workspace:temp,profile:p,trusted:true});
  const manager=new AgentManager(store,{executable:()=>'/fake/claude',sdkLoader:async()=>({query:()=>{const q=(async function*(){yield {type:'assistant',message:{id:'same',content:[{type:'text',text:'Read first'}]}};yield {type:'assistant',message:{id:'same',content:[{type:'tool_use',id:'read-1',name:'Read',input:{file_path:'x'}}]}};yield {type:'result',is_error:false};})();q.close=()=>{};return q;}})});
  await (await manager.start(s.id,'blocks',{},()=>{})).promise;const saved=store.get(s.id);assert.equal(saved.messages.filter(m=>m.role==='assistant').length,1);assert.ok(saved.events.some(e=>e.type==='tool'&&e.id==='read-1'));
});
test('conversation transcript preserves model text, tools, results and readable thinking in order',async()=>{
  const p=readConfig().profiles.lmstudio;const store=new SessionStore(join(temp,'timeline-sessions'));const s=store.create({workspace:temp,profile:p,trusted:true});
  const manager=new AgentManager(store,{executable:()=>'/fake/claude',sdkLoader:async()=>({query:()=>{const q=(async function*(){
    yield {type:'assistant',message:{id:'one',content:[{type:'text',text:'I will inspect it.'},{type:'tool_use',id:'read',name:'Read',input:{file_path:'package.json'}}]}};
    yield {type:'user',message:{content:[{type:'tool_result',tool_use_id:'read',content:'package contents'}]}};
    yield {type:'assistant',message:{id:'two',content:[{type:'thinking',thinking:'This is provider-returned thinking.'},{type:'text',text:'Now I will test it.'},{type:'tool_use',id:'bash',name:'Bash',input:{command:'npm test'}}]}};
    yield {type:'user',message:{content:[{type:'tool_result',tool_use_id:'bash',content:'pass'}]}};
    yield {type:'assistant',message:{id:'three',content:[{type:'redacted_thinking',data:'never-show'},{type:'text',text:'Done.'}]}};
    yield {type:'result',is_error:false};})();q.close=()=>{};return q;}})});
  await(await manager.start(s.id,'Check the project')).promise;
  const timeline=store.get(s.id).transcript;
  assert.deepEqual(timeline.map(e=>e.type),['message','message','tool','tool_result','thinking','message','tool','tool_result','message']);
  assert.deepEqual(timeline.filter(e=>e.type==='tool').map(e=>e.name),['Read','Bash']);
  assert.equal(timeline.filter(e=>e.type==='thinking').length,1);assert.equal(timeline.at(-1).text,'Done.');
});
test('legacy transcript migration never fabricates ordering when event boundaries are missing',()=>{
  const migrated=sessionTranscript({messages:[{role:'user',content:'old question'},{role:'assistant',content:'old answer'}],events:[{type:'tool',id:'old-tool',name:'Read'},{type:'tool_result',id:'old-tool',output:'x'}]});
  assert.deepEqual(migrated.map(e=>e.type),['message','message','history_note','tool','tool_result']);
  assert.match(migrated[2].text,/positions were not recorded/);
});

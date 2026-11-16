import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

const temp=mkdtempSync(join(tmpdir(),'autodev-dashboard-'));
process.env.PORTABLE_AI_DATA_DIR=join(temp,'data');
const { parseAutoDevCommand }=await import('../lib/autodev/commands.mjs');
const { startDashboard }=await import('../dashboard/server.mjs');

test.after(()=>rmSync(temp,{recursive:true,force:true}));

class FakeChatManager {
  runs=new Map();
  responseTimeoutMs=1000;
  closed=false;
  async close(){this.closed=true;}
}
class FakeStore {
  recover(){}
  syncNative(){}
  list(){return [];}
  legacy(){return [];}
  get(){return null;}
}
class FakeAutoDevManager {
  #events=new EventEmitter();
  runs=[];
  calls=[];
  closed=false;
  #sequence=0;
  constructor({empty=false}={}){
    if(!empty){
      this.runs.push(this.#run({id:'persisted',mode:'auto-dev',request:'persisted request',status:'interrupted',phase:'TEST'}));
      this.#append(this.runs[0],'created',{status:'queued'});this.#append(this.runs[0],'phase',{changes:{phase:'TEST'}});
    }
  }
  #run(input){return {...input,createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z',packages:[],approvals:[],events:[]};}
  #append(run,type,detail={}){const event={sequence:++this.#sequence,at:'2026-01-01T00:00:00.000Z',type,...detail};run.events.push(event);run.updatedAt=event.at;this.#events.emit(`run:${run.id}`,structuredClone(event));return event;}
  async list({limit=100,offset=0}={}){this.calls.push(['list',{limit,offset}]);return structuredClone(this.runs.slice(offset,offset+limit));}
  async create(input){this.calls.push(['create',input]);const run=this.#run({id:`run-${this.runs.length+1}`,...input,status:'queued',phase:null});this.#append(run,'created',{status:'queued'});this.runs.push(run);return structuredClone(run);}
  async start(id){this.calls.push(['start',id]);const run=this.runs.find(item=>item.id===id);run.status='running';run.phase='PLAN';this.#append(run,'phase',{changes:{status:'running',phase:'PLAN'}});return structuredClone(run);}
  async status(id){this.calls.push(['status',id]);const run=this.runs.find(item=>item.id===id);if(!run)throw Object.assign(new Error(`unknown run: ${id}`),{status:404});return structuredClone(run);}
  async events(id,{after=0,listener}={}){this.calls.push(['events',id,after]);const run=this.runs.find(item=>item.id===id);if(!run)throw Object.assign(new Error(`unknown run: ${id}`),{status:404});for(const event of run.events.filter(item=>item.sequence>after))listener?.(structuredClone(event));if(!listener)return structuredClone(run.events.filter(item=>item.sequence>after));const wrapped=event=>{if(event.sequence>after)listener(structuredClone(event));};this.#events.on(`run:${id}`,wrapped);return()=>this.#events.off(`run:${id}`,wrapped);}
  async approve(id,approvalId,approved,detail){this.calls.push(['approve',id,approvalId,approved,detail]);const run=this.runs.find(item=>item.id===id);const approval=run.approvals.find(item=>item.id===approvalId);approval.status=approved?'approved':'rejected';this.#append(run,approved?'approved':'approval_rejected');return structuredClone(run);}
  async cancel(id,reason){this.calls.push(['cancel',id,reason]);const run=this.runs.find(item=>item.id===id);run.status='cancelled';this.#append(run,'cancelled');return structuredClone(run);}
  async resume(id){this.calls.push(['resume',id]);const run=this.runs.find(item=>item.id===id);const rejected=run.approvals?.find(item=>item.status==='rejected');run.status=rejected?'cancelled':'running';this.#append(run,rejected?'cancelled':'phase',rejected?{}:{changes:{status:'running'}});return structuredClone(run);}
  close(){this.closed=true;}
}

function auth(app,extra={}){return {'X-Portable-Token':app.token,...extra};}
async function body(response){const value=await response.json();assert.ok(value);return value;}
async function readSse(response,count=1){
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';const events=[];
  while(events.length<count){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let index;while((index=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,index);buffer=buffer.slice(index+2);const data=frame.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trim()).join('\n');if(data)events.push(JSON.parse(data));}}
  await reader.cancel();return events;
}

test('command parser explicitly routes only supported commands',()=>{
  assert.deepEqual({...parseAutoDevCommand('/auto-dev build dashboard')},{command:'/auto-dev',mode:'auto-dev',action:'create',argument:'build dashboard',raw:'/auto-dev build dashboard'});
  assert.equal(parseAutoDevCommand('/multi-review\tlib').argument,'lib');
  assert.equal(parseAutoDevCommand('/deep-review src').mode,'deep-review');
  assert.equal(parseAutoDevCommand('/agent-status').action,'status');
  for(const message of ['normal message',' /auto-dev prefixed space','/auto-devil nope','/unknown command','/AUTO-DEV nope'])assert.equal(parseAutoDevCommand(message),null,message);
});

test('authenticated AutoDev routes create, status, replay, approve, cancel, resume, and close',async t=>{
  const autodev=new FakeAutoDevManager(),manager=new FakeChatManager();
  const app=await startDashboard({port:0,store:new FakeStore(),manager,autodev,workspacePicker:async()=>temp});
  t.after(()=>app.close());

  assert.equal((await fetch(`${app.origin}/api/autodev/runs`)).status,401);
  const bootstrap=await body(await fetch(`${app.origin}/api/bootstrap`,{headers:auth(app)}));
  assert.equal(bootstrap.autodev.total,1);assert.equal(bootstrap.autodev.latest.id,'persisted');
  assert.equal(bootstrap.autodev.latest.events,undefined);assert.equal(bootstrap.autodev.latest.lastSequence,2);
  const listed=await body(await fetch(`${app.origin}/api/autodev/runs`,{headers:auth(app)}));
  assert.equal(listed.runs[0].events,undefined);assert.equal(listed.runs[0].lastSequence,2);

  const normal=await body(await fetch(`${app.origin}/api/autodev/command`,{method:'POST',headers:auth(app,{'Content-Type':'application/json'}),body:JSON.stringify({message:'ordinary chat'})}));
  assert.deepEqual(normal,{handled:false});assert.equal(autodev.calls.some(([name])=>name==='create'),false);

  const statusBefore=autodev.calls.length;
  const statusResponse=await fetch(`${app.origin}/api/autodev/command`,{method:'POST',headers:auth(app,{'Content-Type':'application/json'}),body:JSON.stringify({message:'/agent-status'})});
  assert.equal(statusResponse.status,200);assert.equal((await body(statusResponse)).handled,true);
  assert.equal(autodev.calls.slice(statusBefore).some(([name])=>['create','start','resume'].includes(name)),false,'status must not launch workers');

  const createdResponse=await fetch(`${app.origin}/api/autodev/command`,{method:'POST',headers:auth(app,{'Content-Type':'application/json'}),body:JSON.stringify({message:'/multi-review inspect lib',target:'/repo'})});
  assert.equal(createdResponse.status,201);const created=(await body(createdResponse)).run;assert.equal(created.mode,'multi-review');assert.equal(created.request,'inspect lib');
  await new Promise(resolve=>setImmediate(resolve));assert.ok(autodev.calls.some(call=>call[0]==='start'&&call[1]===created.id));

  const replayResponse=await fetch(`${app.origin}/api/autodev/runs/persisted/events?after=0`,{headers:auth(app)});
  assert.equal(replayResponse.headers.get('content-type'),'text/event-stream');const replay=await readSse(replayResponse,2);assert.deepEqual(replay.map(event=>event.type),['created','phase']);

  const liveRun=autodev.runs.find(run=>run.id===created.id);liveRun.status='pending_approval';liveRun.approvals=[{id:'approve-1',action:'integrate',status:'pending',summary:'Integrate'}];
  const approved=await fetch(`${app.origin}/api/autodev/runs/${created.id}/approve`,{method:'POST',headers:auth(app,{'Content-Type':'application/json'}),body:JSON.stringify({approvalId:'approve-1',approved:true,detail:'scoped approval'})});
  assert.equal(approved.status,202);assert.equal((await body(approved)).run.approvals[0].status,'approved');
  await new Promise(resolve=>setImmediate(resolve));assert.ok(autodev.calls.some(call=>call[0]==='resume'&&call[1]===created.id));
  const cancelled=await fetch(`${app.origin}/api/autodev/runs/${created.id}/cancel`,{method:'POST',headers:auth(app,{'Content-Type':'application/json'}),body:'{}'});assert.equal((await body(cancelled)).run.status,'cancelled');
  const persistedRun=autodev.runs.find(run=>run.id==='persisted');persistedRun.status='pending_approval';persistedRun.approvals=[{id:'integration',kind:'destination-integration',status:'pending'}];
  const rejected=await fetch(`${app.origin}/api/autodev/runs/persisted/approve`,{method:'POST',headers:auth(app,{'Content-Type':'application/json'}),body:JSON.stringify({approvalId:'integration',approved:false})});
  assert.equal(rejected.status,202);assert.equal((await body(rejected)).run.status,'cancelled');assert.ok(autodev.calls.some(call=>call[0]==='resume'&&call[1]==='persisted'));
  persistedRun.status='interrupted';persistedRun.approvals=[];
  const resumed=await fetch(`${app.origin}/api/autodev/runs/persisted/resume`,{method:'POST',headers:auth(app,{'Content-Type':'application/json'}),body:'{}'});assert.equal(resumed.status,202);await new Promise(resolve=>setImmediate(resolve));assert.ok(autodev.calls.filter(call=>call[0]==='resume'&&call[1]==='persisted').length>=2);

  await app.close();assert.equal(autodev.closed,true);assert.equal(manager.closed,true);
});

async function post(app,path,value={}){
  return fetch(`${app.origin}${path}`,{method:'POST',headers:auth(app,{'Content-Type':'application/json'}),body:JSON.stringify(value)});
}

async function waitFor(predicate,{timeout=1000}={}){
  const started=Date.now();
  while(!predicate()){
    if(Date.now()-started>timeout)throw new Error('condition was not reached');
    await new Promise(resolve=>setTimeout(resolve,5));
  }
}

test('bootstrap stays available when AutoDev startup rejects asynchronously',async t=>{
  const manager=new FakeChatManager();
  const app=await startDashboard({
    port:0,
    store:new FakeStore(),
    manager,
    createAutodev:async()=>{await Promise.resolve();throw new Error('ledger unavailable');},
    workspacePicker:async()=>temp,
  });
  t.after(()=>app.close());

  const response=await fetch(`${app.origin}/api/bootstrap`,{headers:auth(app)});
  assert.equal(response.status,200);
  const data=await body(response);
  assert.equal(data.autodev.available,false);
  assert.match(data.autodev.error,/ledger unavailable/);
  assert.equal(data.autodev.total,0);

  const create=await post(app,'/api/autodev/command',{message:'/auto-dev inspect'});
  assert.equal(create.status,503);
  assert.match((await body(create)).error,/AutoDev unavailable/);
});

test('bootstrap degrades when an optional AutoDev list fails',async t=>{
  const autodev=new FakeAutoDevManager();
  autodev.list=async()=>{throw new Error('corrupt optional ledger');};
  const app=await startDashboard({port:0,store:new FakeStore(),manager:new FakeChatManager(),autodev,workspacePicker:async()=>temp});
  t.after(()=>app.close());

  const response=await fetch(`${app.origin}/api/bootstrap`,{headers:auth(app)});
  assert.equal(response.status,200);
  const data=await body(response);
  assert.equal(data.autodev.available,false);
  assert.match(data.autodev.error,/corrupt optional ledger/);
});

test('AutoDev creation is rejected during maintenance and after a runtime change',async t=>{
  const autodev=new FakeAutoDevManager({empty:true});
  let releaseInstall,installStarted=false;
  const installing=new Promise(resolve=>{releaseInstall=resolve;});
  const app=await startDashboard({
    port:0,
    store:new FakeStore(),
    manager:new FakeChatManager(),
    autodev,
    runtimeInstaller:()=>{installStarted=true;return installing;},
    workspacePicker:async()=>temp,
  });
  t.after(()=>app.close());

  const maintenance=post(app,'/api/runtime',{action:'install'});
  await waitFor(()=>installStarted);
  const during=await post(app,'/api/autodev/command',{message:'/auto-dev during maintenance'});
  assert.equal(during.status,409);
  assert.match((await body(during)).error,/maintenance/i);
  releaseInstall();
  assert.equal((await maintenance).status,200);

  const after=await post(app,'/api/autodev/command',{message:'/auto-dev after runtime change'});
  assert.equal(after.status,409);
  assert.match((await body(after)).error,/restart/i);
  assert.equal(autodev.calls.some(([name])=>name==='create'),false);
});

test('AutoDev creation enforces a serialized global active-run limit',async t=>{
  const autodev=new FakeAutoDevManager({empty:true});
  const app=await startDashboard({port:0,store:new FakeStore(),manager:new FakeChatManager(),autodev,maxActiveAutoDevRuns:1,workspacePicker:async()=>temp});
  t.after(()=>app.close());

  const [first,second]=await Promise.all([
    post(app,'/api/autodev/command',{message:'/auto-dev first'}),
    post(app,'/api/autodev/command',{message:'/auto-dev second'}),
  ]);
  assert.deepEqual([first.status,second.status].sort(),[201,429]);
  assert.equal(autodev.calls.filter(([name])=>name==='create').length,1);
});

test('runtime maintenance blocks chat admission before awaiting AutoDev scans',async t=>{
  const autodev=new FakeAutoDevManager({empty:true});
  const originalList=autodev.list.bind(autodev);
  let releaseScan,scanStarted=false,installStarted=false;
  const scanning=new Promise(resolve=>{releaseScan=resolve;});
  autodev.list=async options=>{scanStarted=true;await scanning;return originalList(options);};
  const manager=new FakeChatManager();
  let chatStarts=0;
  manager.start=async()=>{chatStarts++;return {listeners:new Set(),approvals:new Map(),promise:Promise.resolve()};};
  const store=new FakeStore();
  store.get=id=>id==='abc'?{id,events:[]}:null;
  const app=await startDashboard({
    port:0,store,manager,autodev,
    runtimeInstaller:async()=>{installStarted=true;},workspacePicker:async()=>temp,
  });
  t.after(()=>app.close());

  const maintenance=post(app,'/api/runtime',{action:'install'});
  await waitFor(()=>scanStarted);
  const chat=post(app,'/api/sessions/abc/run',{prompt:'race'});
  const chatResponse=await chat;
  assert.equal(chatResponse.status,400);
  assert.match((await body(chatResponse)).error,/maintenance/i);
  assert.equal(chatStarts,0);
  assert.equal(installStarted,false);
  releaseScan();
  assert.equal((await maintenance).status,200);
});

test('runtime maintenance is serialized behind AutoDev admission',async t=>{
  const autodev=new FakeAutoDevManager({empty:true});
  const originalList=autodev.list.bind(autodev);
  let releaseScan,scanStarted=false,listCalls=0,installStarted=false;
  const scanning=new Promise(resolve=>{releaseScan=resolve;});
  autodev.list=async options=>{
    listCalls+=1;
    if(listCalls===1){scanStarted=true;await scanning;}
    return originalList(options);
  };
  const app=await startDashboard({
    port:0,store:new FakeStore(),manager:new FakeChatManager(),autodev,
    runtimeInstaller:async()=>{installStarted=true;},workspacePicker:async()=>temp,
  });
  t.after(()=>app.close());

  const creation=post(app,'/api/autodev/command',{message:'/auto-dev admitted first'});
  await waitFor(()=>scanStarted);
  const maintenance=post(app,'/api/runtime',{action:'install'});
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(listCalls,1,'maintenance must wait for the admission scan');
  assert.equal(installStarted,false);

  releaseScan();
  assert.equal((await creation).status,201);
  const maintenanceResponse=await maintenance;
  assert.equal(maintenanceResponse.status,400);
  assert.match((await body(maintenanceResponse)).error,/AutoDev/);
  assert.equal(installStarted,false);
});

test('concurrent AutoDev resumes claim capacity before releasing admission',async t=>{
  const autodev=new FakeAutoDevManager({empty:true});
  autodev.runs.push(
    {id:'first',status:'interrupted',updatedAt:'2026-01-02T00:00:00.000Z',events:[]},
    {id:'second',status:'interrupted',updatedAt:'2026-01-01T00:00:00.000Z',events:[]},
  );
  let releaseResume,resumeStarted=false;
  const waiting=new Promise(resolve=>{releaseResume=resolve;});
  const originalResume=autodev.resume.bind(autodev);
  autodev.resume=async id=>{
    if(id==='first'){resumeStarted=true;await waiting;}
    return originalResume(id);
  };
  const app=await startDashboard({port:0,store:new FakeStore(),manager:new FakeChatManager(),autodev,maxActiveAutoDevRuns:1,workspacePicker:async()=>temp});
  t.after(()=>app.close());

  const first=post(app,'/api/autodev/runs/first/resume');
  await waitFor(()=>resumeStarted);
  const second=post(app,'/api/autodev/runs/second/resume');
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(autodev.calls.some(([name,id])=>name==='resume'&&id==='second'),false);
  releaseResume();
  assert.equal((await first).status,202);
  assert.equal((await second).status,429);
  assert.equal(autodev.runs.find(run=>run.id==='second').status,'interrupted');
});

test('AutoDev resume and approval continuation obey the global active-run cap',async t=>{
  const autodev=new FakeAutoDevManager({empty:true});
  autodev.runs.push(
    {id:'active',status:'running',updatedAt:'2026-01-02T00:00:00.000Z',events:[]},
    {id:'resume-me',status:'interrupted',updatedAt:'2026-01-01T00:00:00.000Z',events:[]},
    {id:'approve-me',status:'pending_approval',updatedAt:'2025-12-31T00:00:00.000Z',events:[],approvals:[{id:'integration',kind:'destination-integration',status:'pending'}]},
  );
  const app=await startDashboard({port:0,store:new FakeStore(),manager:new FakeChatManager(),autodev,maxActiveAutoDevRuns:1,workspacePicker:async()=>temp});
  t.after(()=>app.close());

  const resume=await post(app,'/api/autodev/runs/resume-me/resume');
  assert.equal(resume.status,429);
  assert.equal(autodev.calls.some(([name,id])=>name==='resume'&&id==='resume-me'),false);

  const approve=await post(app,'/api/autodev/runs/approve-me/approve',{approvalId:'integration',approved:true});
  assert.equal(approve.status,429);
  assert.equal(autodev.runs.find(run=>run.id==='approve-me').approvals[0].status,'pending');
  assert.equal(autodev.calls.some(([name,id])=>name==='approve'&&id==='approve-me'),false);
  assert.equal(autodev.calls.some(([name,id])=>name==='resume'&&id==='approve-me'),false);
});

test('AutoDev summaries remain globally accurate beyond the first page',async t=>{
  const autodev=new FakeAutoDevManager({empty:true});
  for(let index=0;index<105;index+=1){
    autodev.runs.push({id:`done-${index}`,status:'succeeded',updatedAt:String(1000-index),events:[]});
  }
  autodev.runs.push({id:'old-active',status:'running',updatedAt:'0',events:[]});
  const app=await startDashboard({port:0,store:new FakeStore(),manager:new FakeChatManager(),autodev,workspacePicker:async()=>temp});
  t.after(()=>app.close());

  const bootstrap=await body(await fetch(`${app.origin}/api/bootstrap`,{headers:auth(app)}));
  assert.equal(bootstrap.autodev.total,106);
  assert.equal(bootstrap.autodev.active,1);
  const status=await body(await fetch(`${app.origin}/api/autodev/status`,{headers:auth(app)}));
  assert.equal(status.total,106);
  assert.equal(status.active,1);
  assert.equal(status.runs.length,100);
  const command=await body(await post(app,'/api/autodev/command',{message:'/agent-status'}));
  assert.equal(command.summary.total,106);
  assert.equal(command.summary.active,1);
  assert.equal(command.runs.length,100);
});

test('provider changes are blocked while AutoDev is active',async t=>{
  const autodev=new FakeAutoDevManager({empty:true});
  autodev.runs.push({id:'active',status:'running',updatedAt:'2026-01-01T00:00:00.000Z',events:[]});
  const app=await startDashboard({port:0,store:new FakeStore(),manager:new FakeChatManager(),autodev,workspacePicker:async()=>temp});
  t.after(()=>app.close());

  const active=await post(app,'/api/config/active',{provider:'anthropic'});
  assert.equal(active.status,400);
  assert.match((await body(active)).error,/AutoDev/);
  const settings=await post(app,'/api/config',{provider:'anthropic'});
  assert.equal(settings.status,400);
  assert.match((await body(settings)).error,/AutoDev/);
});

test('switching providers requires restart before cached AutoDev runtimes can run again',async t=>{
  const autodev=new FakeAutoDevManager({empty:true});
  const app=await startDashboard({port:0,store:new FakeStore(),manager:new FakeChatManager(),autodev,workspacePicker:async()=>temp});
  t.after(()=>app.close());

  const configured=await post(app,'/api/config',{
    provider:'ollama',model:'local-model',baseUrl:'http://127.0.0.1:11434',
  });
  assert.equal(configured.status,200);
  await app.close();
  const restarted=await startDashboard({port:0,store:new FakeStore(),manager:new FakeChatManager(),autodev,workspacePicker:async()=>temp});
  t.after(()=>restarted.close());
  const switched=await post(restarted,'/api/config/active',{provider:'ollama'});
  assert.equal(switched.status,200);
  const create=await post(restarted,'/api/autodev/command',{message:'/auto-dev after provider switch'});
  assert.equal(create.status,409);
  assert.match((await body(create)).error,/restart/i);
  assert.equal(autodev.calls.some(([name])=>name==='create'),false);
});

test('active-run guards scan beyond the first thousand records',async t=>{
  const autodev=new FakeAutoDevManager({empty:true});
  for(let index=0;index<1000;index+=1)autodev.runs.push({id:`done-${index}`,status:'succeeded',updatedAt:String(2000-index),events:[]});
  autodev.runs.push({id:'old-active',status:'running',updatedAt:'0',events:[]});
  const app=await startDashboard({port:0,store:new FakeStore(),manager:new FakeChatManager(),autodev,workspacePicker:async()=>temp});
  t.after(()=>app.close());

  const response=await post(app,'/api/config/active',{provider:'anthropic'});
  assert.equal(response.status,400);
  assert.match((await body(response)).error,/AutoDev/);
  assert.ok(autodev.calls.some(([name,options])=>name==='list'&&options?.offset===1000));
});

test('AutoDev resume and approval continuation honor maintenance and restart guards',async t=>{
  const autodev=new FakeAutoDevManager();
  const persisted=autodev.runs[0];
  persisted.approvals=[{id:'integration',kind:'destination-integration',action:'integrate',status:'pending'}];
  let releaseInstall,installStarted=false;
  const installing=new Promise(resolve=>{releaseInstall=resolve;});
  const app=await startDashboard({
    port:0,store:new FakeStore(),manager:new FakeChatManager(),autodev,
    runtimeInstaller:()=>{installStarted=true;return installing;},workspacePicker:async()=>temp,
  });
  t.after(()=>app.close());

  const maintenance=post(app,'/api/runtime',{action:'install'});
  await waitFor(()=>installStarted);
  const resumeDuring=await post(app,'/api/autodev/runs/persisted/resume');
  assert.equal(resumeDuring.status,409);
  const approveDuring=await post(app,'/api/autodev/runs/persisted/approve',{approvalId:'integration',approved:true});
  assert.equal(approveDuring.status,409);
  assert.equal(persisted.approvals[0].status,'pending');
  releaseInstall();await maintenance;

  const resumeAfter=await post(app,'/api/autodev/runs/persisted/resume');
  assert.equal(resumeAfter.status,409);
  const approveAfter=await post(app,'/api/autodev/runs/persisted/approve',{approvalId:'integration',approved:true});
  assert.equal(approveAfter.status,409);
  assert.equal(autodev.calls.some(([name])=>name==='resume'),false);
});

test('AutoDev list and replay requests use bounded limits',async t=>{
  const autodev=new FakeAutoDevManager();
  const listOptions=[];let eventOptions;
  const originalList=autodev.list.bind(autodev),originalEvents=autodev.events.bind(autodev);
  autodev.list=async options=>{listOptions.push(options);return originalList();};
  autodev.events=async(id,options)=>{eventOptions=options;return originalEvents(id,options);};
  const app=await startDashboard({port:0,store:new FakeStore(),manager:new FakeChatManager(),autodev,workspacePicker:async()=>temp});
  t.after(()=>app.close());

  assert.equal((await fetch(`${app.origin}/api/autodev/runs?limit=1&offset=0`,{headers:auth(app)})).status,200);
  const invalid=await fetch(`${app.origin}/api/autodev/runs?limit=101`,{headers:auth(app)});
  assert.equal(invalid.status,400);
  const stream=await fetch(`${app.origin}/api/autodev/runs/persisted/events`,{headers:auth(app)});
  await readSse(stream,2);
  assert.ok(listOptions.some(options=>options?.limit===1&&options?.offset===0));
  assert.equal(eventOptions.limit,1000);
});

test('unknown AutoDev event streams return an ordinary 404 response',async t=>{
  const app=await startDashboard({port:0,store:new FakeStore(),manager:new FakeChatManager(),autodev:new FakeAutoDevManager(),workspacePicker:async()=>temp});
  t.after(()=>app.close());

  const response=await fetch(`${app.origin}/api/autodev/runs/missing/events`,{headers:auth(app)});
  assert.equal(response.status,404);
  assert.match(response.headers.get('content-type'),/application\/json/);
  assert.match((await body(response)).error,/unknown run/);
});

test('disconnect during delayed AutoDev subscription removes the listener',async t=>{
  const autodev=new FakeAutoDevManager();
  let release,subscribed=false,unsubscribed=false;
  const waiting=new Promise(resolve=>{release=resolve;});
  autodev.events=async(id,{listener})=>{
    await autodev.status(id);
    subscribed=true;
    await waiting;
    listener({sequence:1,type:'created'});
    return()=>{unsubscribed=true;};
  };
  const app=await startDashboard({port:0,store:new FakeStore(),manager:new FakeChatManager(),autodev,workspacePicker:async()=>temp});
  t.after(()=>app.close());

  const controller=new AbortController();
  const request=fetch(`${app.origin}/api/autodev/runs/persisted/events`,{headers:auth(app),signal:controller.signal}).catch(error=>error);
  await waitFor(()=>subscribed);
  controller.abort();release();
  await request;
  await waitFor(()=>unsubscribed);
  assert.equal(unsubscribed,true);
});

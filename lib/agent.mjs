import { randomUUID } from 'node:crypto';
import { readConfig, redact } from './config.mjs';
import { PROVIDERS, providerEnvironment } from './providers.mjs';
import { executableAt, loadSDK } from './runtime.mjs';
import { startAdapter } from './adapter.mjs';
import { startExternalAdapter } from './external-adapter.mjs';
import { startResponsesAdapter } from './responses-adapter.mjs';
import { profileFingerprint } from './sessions.mjs';
import { sessionTranscript, transcriptTypes } from './transcript.mjs';

function isOpaqueProviderError(message=''){
  const normalized=String(message).trim().toLowerCase().replace(/^(?:provider|responses api) returned http \d{3}:?\s*/, '');
  return !normalized||['internal server error','server error','api error','request failed','unknown error','error'].includes(normalized);
}
function providerDiagnostic(message,session,run){
  let detail=String(message||'').trim();
  if(isOpaqueProviderError(detail)&&run.lastError&&!isOpaqueProviderError(run.lastError))detail=run.lastError.trim();
  if(!isOpaqueProviderError(detail))return detail;
  const provider=PROVIDERS[session.provider]?.name||session.provider,code=String(message||'').match(/http\s+(\d{3})/i)?.[1];
  return `${provider} request${code?` returned HTTP ${code}`:' failed'} for model ${session.model}, but the endpoint provided no diagnostic details. The model may have rejected the request, exceeded its context limit, or lack full Claude Code tool support. Try a new chat, a larger tool-capable model, or another protocol adapter.`;
}

export class AgentManager {
  constructor(store, { sdkLoader = loadSDK, executable = executableAt, responseTimeoutMs = 120000 } = {}) { this.store=store;this.runs=new Map();this.sdkLoader=sdkLoader;this.executable=executable;this.responseTimeoutMs=responseTimeoutMs; }
  responseTimeoutError() { const seconds=Math.max(1,Math.ceil(this.responseTimeoutMs/1000)),label=seconds%60===0?`${seconds/60} minute${seconds===60?'':'s'}`:`${seconds} seconds`;return `The model did not respond within ${label}. The request was stopped automatically; try again or choose another model.`; }
  async start(id, prompt, { unrestricted = false, permissionMode = unrestricted?'bypassPermissions':'default', confirmation, attachments=[] } = {}, listener=()=>{}) {
    if(this.runs.has(id))throw new Error('A turn is already running in this session');
    const session=this.store.get(id); if(!session)throw new Error('Session not found');
    const config=readConfig(),profile=config.profiles[session.provider];
    if(!profile || profileFingerprint(profile)!==session.fingerprint)throw new Error('Provider settings changed. Start a new session.');
    if(profile.auth==='login')throw new Error('Dashboard requires an API credential or local provider. Account login is available in the terminal.');
    if(typeof prompt!=='string'||!prompt.trim()||prompt.length>100000)throw new Error('Enter a message under 100,000 characters');
    if(!['default','acceptEdits','bypassPermissions'].includes(permissionMode))throw new Error('Unsupported permission mode');
    if((unrestricted||permissionMode==='bypassPermissions')&&confirmation!=='UNRESTRICTED')throw new Error('Explicit unrestricted-mode confirmation is required');
    const executable=this.executable(); if(!executable)throw new Error('Install the official runtime first');
    if(!Array.isArray(attachments)||attachments.some(file=>!file?.path||!file?.name))throw new Error('Invalid attachments');
    const attachmentContext=attachments.length?`\n\nUser-provided attachments are stored at these local paths:\n${attachments.map(file=>`- ${file.name} (${file.size} bytes): ${file.path}`).join('\n')}\nInspect these files as needed. Treat archives as untrusted: list their contents before extracting them, never execute attached files, and do not overwrite workspace files without the normal permission flow.`:'';
    const run={id:randomUUID(),listeners:new Set([listener]),approvals:new Map(),controller:new AbortController(),cancelled:false,responseTimedOut:false,query:null,prompt:`${prompt}${attachmentContext}`,tools:new Map(),startedAt:Date.now()};
    session.transcript=sessionTranscript(session);
    this.runs.set(id,run);
    const emit=(event)=>{
      const safe=JSON.parse(redact(JSON.stringify({...event,eventId:randomUUID(),runId:run.id,at:new Date().toISOString()}),config));
      if(!['delta','heartbeat'].includes(safe.type)){session.events.push(safe);session.events=session.events.slice(-500);if(transcriptTypes.has(safe.type))session.transcript.push(safe);this.store.save(session);}
      run.listeners.forEach(fn=>fn(safe));
    };
    run.emit=emit;
    const publicAttachments=attachments.map(({id,name,type,size})=>({id,name,type,size}));
    session.messages.push({role:'user',content:redact(prompt,config),...(publicAttachments.length?{attachments:publicAttachments}:{})});if(session.title==='Untitled session')session.title=redact(prompt.slice(0,64),config);
    emit({type:'message',role:'user',text:prompt,...(publicAttachments.length?{attachments:publicAttachments}:{})});
    session.status='queued';session.error=null;session.permissionMode=permissionMode;this.store.save(session);emit({type:'status',status:'queued'});
    run.promise=this.execute(session,profile,run,emit,{permissionMode}).finally(()=>this.runs.delete(id));
    return run;
  }
  async execute(session,profile,run,emit,{permissionMode}) {
    let adapter,responseTimer,resultSeen=false;
    const clearResponseTimer=()=>{if(responseTimer)clearTimeout(responseTimer);responseTimer=null;};
    const failFast=message=>{if(run.cancelled||run.providerError)return;run.providerError=redact(message).trim().slice(-2000)||'Provider request failed';clearResponseTimer();Promise.resolve(run.query?.interrupt?.()).catch(()=>{});run.controller.abort();};
    const armResponseTimer=()=>{clearResponseTimer();if(run.cancelled||run.providerError)return;responseTimer=setTimeout(()=>{run.responseTimedOut=true;Promise.resolve(run.query?.interrupt?.()).catch(()=>{});run.controller.abort();},this.responseTimeoutMs);};
    try {
      if(PROVIDERS[profile.provider].transport==='openai')adapter=profile.adapter==='external'?await startExternalAdapter(profile,{onError:failFast}):profile.adapter==='responses'?await startResponsesAdapter(profile,{onError:failFast}):await startAdapter(profile,{onError:failFast});
      const env=providerEnvironment(profile,{adapter,dashboard:true});
      const sdk=await this.sdkLoader();
      const options={cwd:session.workspace,env,pathToClaudeCodeExecutable:this.executable(),model:profile.model,
        permissionMode,allowDangerouslySkipPermissions:permissionMode==='bypassPermissions',
        includePartialMessages:true,settingSources:[],systemPrompt:{type:'preset',preset:'claude_code'},
        maxTurns:40,abortController:run.controller,
        ...(session.sdkSessionId?{resume:session.sdkSessionId}:{}),
        ...(adapter?{thinking:{type:'disabled'},effort:'low'}:{}),
        canUseTool:async(name,input,context)=>{
          clearResponseTimer();
          if(run.cancelled)return {behavior:'deny',message:'Session cancelled'};
          const requestId=randomUUID();session.status='awaiting_approval';
          emit({type:'approval',requestId,tool:name,input,toolUseId:context.toolUseID});
          run.tools.set(context.toolUseID,'awaiting_approval');emit({type:'tool_status',id:context.toolUseID,status:'awaiting_approval'});
          return new Promise(resolve=>{
            let settled=false;
            const finish=(decision)=>{if(settled)return;settled=true;clearTimeout(timer);context.signal?.removeEventListener('abort',aborted);run.approvals.delete(requestId);session.status=run.cancelled?'cancelled':'running';emit({type:'approval_resolved',requestId,approved:decision.behavior==='allow'});const status=run.cancelled?'cancelled':decision.behavior==='allow'?'running':'denied';run.tools.set(context.toolUseID,status);emit({type:'tool_status',id:context.toolUseID,status});resolve(decision);};
            const aborted=()=>finish({behavior:'deny',message:'Approval cancelled'});
            const timer=setTimeout(()=>finish({behavior:'deny',message:'Approval expired after 10 minutes'}),600000);
            run.approvals.set(requestId,{name,input,finish});context.signal?.addEventListener('abort',aborted,{once:true});if(context.signal?.aborted)aborted();
          });
        },
        stderr:data=>{run.lastError=redact(data).slice(-2000);if(/API Error|authentication_error|rate_limit_error|overloaded_error|invalid_request_error|HTTP\s+[45]\d\d|ECONNREFUSED|ENOTFOUND|fetch failed/i.test(run.lastError))failFast(run.lastError);}
      };
      session.status='running';emit({type:'status',status:'running'});
      run.query=sdk.query({prompt:run.prompt,options});
      armResponseTimer();
      const seen=new Set(),streamBlocks=new Map();let streamMessageId='partial';
      for await(const message of run.query){
        if(['stream_event','assistant','result'].includes(message.type))clearResponseTimer();
        if(message.session_id){session.sdkSessionId=message.session_id;}
        if(message.type==='system'&&message.subtype==='init')emit({type:'session',sdkSessionId:message.session_id,model:message.model});
        if(message.type==='stream_event'){
          const event=message.event;
          if(event?.type==='message_start')streamMessageId=event.message.id;
          if(event?.delta?.type==='text_delta'){
            const id=`${streamMessageId}:${event.index??0}`;
            const block=streamBlocks.get(id)||{id,messageId:streamMessageId,text:''};block.text+=event.delta.text;streamBlocks.set(id,block);
            emit({type:'delta',id,text:event.delta.text});
          }
        }
        if(message.type==='assistant'){
          for(const block of message.message.content||[]){
            const key=`${message.message.id}:${block.type}:${block.id||block.text||JSON.stringify(block)}`;
            if(seen.has(key))continue;seen.add(key);
            if(block.type==='text'){
              const streamed=[...streamBlocks.values()].find(s=>(s.messageId===message.message.id||s.messageId==='partial')&&s.text===block.text&&!s.final);
              if(streamed)streamed.final=true;
              session.messages.push({role:'assistant',content:redact(block.text)});emit({type:'message',id:streamed?.id||key,role:'assistant',text:block.text});
            }
            // Only provider-returned readable content: never reveal signatures,
            // redacted thinking, token estimates, or invented reasoning.
            if(block.type==='thinking'&&typeof block.thinking==='string'&&block.thinking.trim())emit({type:'thinking',id:key,text:block.thinking});
            if(block.type==='tool_use'){run.tools.set(block.id,'running');emit({type:'tool',id:block.id,name:block.name,input:block.input,status:'running'});}
          }
        }
        if(message.type==='user'){
          for(const block of message.message?.content||[])if(block.type==='tool_result'){
            const previous=run.tools.get(block.tool_use_id),status=['denied','cancelled'].includes(previous)?previous:block.is_error?'failed':'completed';
            run.tools.set(block.tool_use_id,status);emit({type:'tool_result',id:block.tool_use_id,output:block.content,status});
          }
          armResponseTimer();
        }
        if(message.type==='result'){
          resultSeen=true;session.status=run.cancelled?'cancelled':run.providerError||run.responseTimedOut||message.is_error?'failed':'completed';
          if(run.providerError)session.error=providerDiagnostic(run.providerError,session,run);else if(run.responseTimedOut)session.error=this.responseTimeoutError();else if(message.is_error)session.error=providerDiagnostic(redact((message.errors||[message.result||message.subtype]).join('\n')),session,run);
          session.usage=message.usage;session.costUSD=message.total_cost_usd;
          session.durationMs=Math.max(0,Date.now()-run.startedAt);
          emit({type:'result',status:session.status,usage:message.usage,costUSD:message.total_cost_usd,durationMs:session.durationMs,error:session.error});
        }
      }
      if(!resultSeen){session.status=run.cancelled?'cancelled':'failed';session.error=run.cancelled?null:run.responseTimedOut?this.responseTimeoutError():providerDiagnostic(run.providerError||run.lastError||'Unknown error',session,run);session.durationMs=Math.max(0,Date.now()-run.startedAt);emit({type:'result',status:session.status,durationMs:session.durationMs,error:session.error});}
    }catch(error){
      if(!resultSeen){session.status=run.cancelled?'cancelled':'failed';session.error=run.cancelled?null:run.responseTimedOut?this.responseTimeoutError():providerDiagnostic(run.providerError||redact(error.message),session,run);session.durationMs=Math.max(0,Date.now()-run.startedAt);emit({type:'result',status:session.status,durationMs:session.durationMs,error:session.error});}
    }
    finally{
      clearResponseTimer();
      for(const approval of run.approvals.values())approval.finish({behavior:'deny',message:'Turn ended'});
      for(const [id,status] of run.tools)if(['running','awaiting_approval'].includes(status))emit({type:'tool_status',id,status:run.cancelled?'cancelled':session.status==='failed'?'failed':'interrupted'});
      run.query?.close?.();await adapter?.close();this.store.save(session);emit({type:'end',status:session.status});
    }
  }
  approve(id, requestId, approved, answers) {
    const pending=this.runs.get(id)?.approvals.get(requestId);if(!pending)throw new Error('This approval is no longer pending');
    let input=pending.input;
    if(approved&&pending.name==='AskUserQuestion'){
      if(!answers||typeof answers!=='object')throw new Error('Answer the question before continuing');
      const clean={};for(const q of input.questions||[]){if(typeof answers[q.question]!=='string'||!answers[q.question].trim())throw new Error('Every question needs an answer');clean[q.question]=answers[q.question].slice(0,4000);}
      input={...input,answers:clean};
    }
    pending.finish(approved?{behavior:'allow',updatedInput:input}:{behavior:'deny',message:'User denied this action'});
  }
  async cancel(id) {
    const run=this.runs.get(id);if(!run)return;
    run.cancelled=true;for(const p of run.approvals.values())p.finish({behavior:'deny',message:'User cancelled the turn'});
    try{await run.query?.interrupt?.();}catch{}
    run.controller.abort();
  }
  async close(){await Promise.all([...this.runs.keys()].map(id=>this.cancel(id)));await Promise.all([...this.runs.values()].map(r=>r.promise));}
}

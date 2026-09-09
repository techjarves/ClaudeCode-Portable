import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ROOT, DATA, RUNTIME, LOGS, CHAT_WORKSPACE } from '../lib/paths.mjs';
import { readConfig, publicConfig, saveProfile, activateProfile, redact, validateBaseURL } from '../lib/config.mjs';
import { PROVIDERS, discoverModels, testConnection } from '../lib/providers.mjs';
import { runtimeStatus, installRuntime, rollbackRuntime, listLogs } from '../lib/runtime.mjs';
import { SessionStore } from '../lib/sessions.mjs';
import { AgentManager } from '../lib/agent.mjs';
import { externalAdapterAvailable } from '../lib/external-adapter.mjs';
import { readBody, json } from '../lib/http.mjs';
import { localStatus, startLocal, stopLocal, pullModel } from '../lib/local-models.mjs';
import { sessionTranscript } from '../lib/transcript.mjs';
import { pickWorkspace } from '../lib/workspace-picker.mjs';
import { removeAttachments, resolveAttachments, saveAttachments } from '../lib/attachments.mjs';

export async function startDashboard({port=Number(process.env.PORTABLE_AI_PORT||3000),store=new SessionStore(),manager,token=randomBytes(32).toString('hex'),workspacePicker=pickWorkspace,connectionTester=testConnection}={}) {
  store.recover(); manager ||= new AgentManager(store);
  mkdirSync(LOGS,{recursive:true});
  let origin; let maintenance=false; let restartRequired=false; const pulls=new Set();
  const staticFiles={
    '/':'dashboard/index.html','/app.js':'dashboard/app.js','/requests.js':'dashboard/requests.js','/styles.css':'dashboard/styles.css','/icons.js':'dashboard/icons.js',
    '/vendor/marked.js':join(RUNTIME,'node_modules/marked/lib/marked.esm.js'),
    '/vendor/purify.js':join(RUNTIME,'node_modules/dompurify/dist/purify.es.mjs'),
    '/vendor/highlight.js':join(RUNTIME,'node_modules/@highlightjs/cdn-assets/es/highlight.min.js')
  };
  const validToken=value=>typeof value==='string'&&value.length===token.length&&timingSafeEqual(Buffer.from(value),Buffer.from(token));
  const server=createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cache-Control','no-store');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const url=new URL(req.url,'http://127.0.0.1');
    try{
      // Reject DNS rebinding, cross-origin API access, and unauthenticated calls.
      if(req.headers.host!==new URL(origin).host)return json(res,403,{error:'Invalid host'});
      if(req.headers.origin&&req.headers.origin!==origin)return json(res,403,{error:'Cross-origin requests are not allowed'});
      const file=staticFiles[url.pathname];
      if(req.method==='GET'&&file){
        const path=file.startsWith(ROOT)?file:join(ROOT,file);
        if(!existsSync(path))return json(res,503,{error:'Dashboard dependency missing. Run start.sh install or START.bat install.'});
        res.writeHead(200,{'Content-Type':extname(path)==='.css'?'text/css':extname(path)==='.html'?'text/html; charset=utf-8':'text/javascript; charset=utf-8'});return res.end(readFileSync(path));
      }
      if(!url.pathname.startsWith('/api/'))return json(res,404,{error:'Not found'});
      if(!validToken(req.headers['x-portable-token']))return json(res,401,{error:'Open the dashboard using the launch link in your terminal'});
      if(!['GET','POST','DELETE'].includes(req.method))return json(res,405,{error:'Method not allowed'});
      if(req.method==='POST'&&!req.headers['content-type']?.startsWith('application/json'))return json(res,415,{error:'JSON required'});
      const body=req.method==='POST'?await readBody(req,url.pathname.endsWith('/attachments')?28*1024*1024:4*1024*1024):{};
      if(url.pathname==='/api/bootstrap'&&req.method==='GET'){const config=readConfig();store.syncNative(config,new Set(manager.runs.keys()));return json(res,200,{config:publicConfig(config),providers:PROVIDERS,adapterOptions:['builtin','external','responses'],externalAdapterAvailable:externalAdapterAvailable(),sessions:store.list(),runtime:await runtimeStatus(),workspace:ROOT,responseTimeoutMs:manager.responseTimeoutMs});}
      if(url.pathname==='/api/config'&&req.method==='GET')return json(res,200,publicConfig());
      if(url.pathname==='/api/config/key'&&req.method==='GET'){
        const provider=url.searchParams.get('provider');if(!PROVIDERS[provider])throw new Error('Unknown provider');
        return json(res,200,{key:readConfig().profiles[provider]?.key||''});
      }
      if(url.pathname==='/api/config/active'&&req.method==='POST'){
        if(manager.runs.size)throw new Error('Stop the active turn before switching models');
        return json(res,200,activateProfile(body.provider));
      }
      if(url.pathname==='/api/config'&&req.method==='POST'){
        if(manager.runs.size)throw new Error('Stop active turns before changing provider settings');
        return json(res,200,saveProfile(body));
      }
      if(url.pathname==='/api/models'&&req.method==='POST'){
        if(!PROVIDERS[body.provider])throw new Error('Unknown provider');
        const saved=readConfig().profiles[body.provider]||{};
        const profile={...saved,...body,key:body.key===undefined?saved.key:body.key,baseUrl:validateBaseURL(body.baseUrl||PROVIDERS[body.provider].baseUrl)};
        return json(res,200,{models:await discoverModels(profile)});
      }
      if(url.pathname==='/api/connection/test'&&req.method==='POST'){
        if(!PROVIDERS[body.provider])throw new Error('Unknown provider');
        const saved=readConfig().profiles[body.provider]||{};
        const profile={...saved,...body,key:body.key===undefined?saved.key:body.key,baseUrl:validateBaseURL(body.baseUrl||PROVIDERS[body.provider].baseUrl)};
        if(profile.auth==='login')throw new Error('Account login is tested in the Claude Code terminal. Choose API key authentication for the dashboard.');
        return json(res,200,await connectionTester(profile));
      }
      if(url.pathname==='/api/workspace/pick'&&req.method==='POST'){
        const workspace=await workspacePicker(body.initial||ROOT);return json(res,200,{workspace,cancelled:!workspace});
      }
      if(url.pathname==='/api/sessions'&&req.method==='GET'){store.syncNative(readConfig(),new Set(manager.runs.keys()));return json(res,200,{sessions:store.list(),legacy:store.legacy()});}
      if(url.pathname==='/api/sessions'&&req.method==='POST'){
        const config=readConfig(),profile=config.profiles[config.active];if(!profile)throw new Error('Configure a provider first');
        const projectless=body.projectless===true;if(projectless)mkdirSync(CHAT_WORKSPACE,{recursive:true,mode:0o700});
        return json(res,201,store.createConversation({workspace:projectless?CHAT_WORKSPACE:body.workspace,profile,trusted:body.trusted===true,projectless}));
      }
      const match=url.pathname.match(/^\/api\/sessions\/([a-f0-9-]+)(?:\/(run|approve|cancel|events|attachments))?$/);
      if(match){
        const [,id,action]=match;
        if(!store.get(id))return json(res,404,{error:'Session not found'});
        if(!action&&req.method==='GET'){const session=store.get(id);return json(res,200,{...session,transcript:sessionTranscript(session)});}
        if(!action&&req.method==='DELETE'){if(manager.runs.has(id))throw new Error('Stop this session before deleting it');store.delete(id);removeAttachments(id);return json(res,200,{ok:true});}
        if(action==='attachments'&&req.method==='POST')return json(res,201,{attachments:saveAttachments(id,body.files)});
        if(action==='approve'&&req.method==='POST'){manager.approve(id,body.requestId,body.approved===true,body.answers);return json(res,200,{ok:true});}
        if(action==='cancel'&&req.method==='POST'){await manager.cancel(id);return json(res,200,{ok:true});}
        if((action==='run'&&req.method==='POST')||(action==='events'&&req.method==='GET')){
          if(maintenance)throw new Error('Runtime maintenance is in progress');
          if(restartRequired)throw new Error('Runtime changed. Restart the studio to load the verified runtime and SDK together.');
          let send;const queue=[];const listener=e=>send?send(e):queue.push(e);
          let active;
          if(action==='run')active=await manager.start(id,body.prompt,{...body,attachments:resolveAttachments(id,body.attachments)},listener);
          else{active=manager.runs.get(id);if(!active)return json(res,409,{error:'No active turn to reconnect'});active.listeners.add(listener);}
          res.writeHead(200,{'Content-Type':'text/event-stream','Connection':'keep-alive','Cache-Control':'no-store'});
          send=e=>res.write(`data: ${JSON.stringify(e)}\n\n`);queue.forEach(send);
          if(action==='events')for(const e of store.get(id).events)if(e.type==='approval'&&active.approvals.has(e.requestId))send(e);
          const heartbeat=setInterval(()=>res.write(': keepalive\n\n'),15000);
          res.on('close',()=>{clearInterval(heartbeat);active.listeners.delete(listener);});
          active.promise.finally(()=>{clearInterval(heartbeat);res.end();});return;
        }
      }
      if(url.pathname==='/api/system'&&req.method==='GET')return json(res,200,{runtime:await runtimeStatus(),local:await localStatus(),logs:listLogs(),dataDirectory:DATA,root:ROOT});
      if(url.pathname==='/api/log'&&req.method==='GET'){
        const name=url.searchParams.get('name');if(!listLogs().includes(name))return json(res,404,{error:'Log not found'});
        return json(res,200,{text:redact(readFileSync(join(LOGS,name),'utf8').slice(-50000))});
      }
      if(url.pathname==='/api/runtime'&&req.method==='POST'){
        if(manager.runs.size||maintenance)throw new Error('Stop active turns before runtime maintenance');
        if(!['install','rollback'].includes(body.action))throw new Error('Unknown runtime action');
        maintenance=true;
        try{if(body.action==='rollback')await rollbackRuntime();else await installRuntime();restartRequired=true;return json(res,200,await runtimeStatus());}finally{maintenance=false;}
      }
      if(url.pathname==='/api/local'&&req.method==='POST'){
        if(body.action==='start')return json(res,200,await startLocal());
        if(body.action==='stop'){stopLocal();return json(res,200,{ok:true});}
        if(body.action==='pull'){
          if(body.confirm!==true)throw new Error('Confirm the model download; it may require many gigabytes');
          const controller=new AbortController();pulls.add(controller);res.on('close',()=>{if(!res.writableEnded)controller.abort();});
          try{return json(res,200,await pullModel(body.model,controller.signal));}finally{pulls.delete(controller);}
        }
        throw new Error('Unknown local-model action');
      }
      return json(res,404,{error:'Not found'});
    }catch(error){
      const message=redact(error.message);appendFileSync(join(LOGS,'dashboard.log'),`${new Date().toISOString()} ${req.method} ${url.pathname}: ${message}\n`,{mode:0o600});
      if(!res.headersSent)json(res,error.status||400,{error:message});else res.end();
    }
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  origin=`http://127.0.0.1:${server.address().port}`;
  return {server,manager,token,origin,url:`${origin}/#token=${token}`,close:async()=>{pulls.forEach(c=>c.abort());await manager.close();try{if((await localStatus()).owned)stopLocal();}catch{}server.closeAllConnections();await new Promise(r=>server.close(r));}};
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1])startDashboard().then(app=>{console.log(`Portable AI: ${app.url}`);for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await app.close();process.exit(0);});}).catch(e=>{console.error(e.message);process.exitCode=1;});

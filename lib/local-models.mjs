import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { DATA, ROOT } from './paths.mjs';
let owned=null;
let ownedProxy=null;
export const PROXY_PORT = Number(process.env.PORTABLE_PROXY_PORT || 11435);
export const PROXY_URL = `http://127.0.0.1:${PROXY_PORT}`;
export function ollamaExecutable(){return [join(DATA,'ollama',process.platform==='win32'?'ollama.exe':'ollama'),join(DATA,'ollama',`ollama-${process.platform}`),join(DATA,'ollama/bin/ollama')].find(existsSync);}
export async function localStatus(){
  let models=[],online=false;
  try{const r=await fetch('http://127.0.0.1:11434/api/tags',{signal:AbortSignal.timeout(1500)});if(r.ok){models=(await r.json()).models||[];online=true;}}catch{}
  return {installed:!!ollamaExecutable(),online,owned:!!owned,proxy:await proxyStatus(),models:models.map(m=>({name:m.name,size:m.size}))};
}
export async function startLocal(){
  if((await localStatus()).online)return {alreadyRunning:true};
  const exe=ollamaExecutable();if(!exe)throw new Error('Install portable Ollama using the local-model setup command shown in System');
  await new Promise((resolve,reject)=>{owned=spawn(exe,['serve'],{env:{...process.env,OLLAMA_MODELS:join(DATA,'ollama/data'),OLLAMA_HOST:'127.0.0.1:11434'},stdio:'ignore'});owned.once('spawn',resolve);owned.once('error',e=>{owned=null;reject(e);});owned.once('exit',()=>{owned=null;});});
  return {starting:true};
}
export function stopLocal(){if(!owned)throw new Error('This server was not started by ClaudeCode-Portable; stop it in its own application');owned.kill('SIGTERM');owned=null;}
export async function pullModel(model,signal){
  if(typeof model!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,180}$/.test(model))throw new Error('Invalid Ollama model name');
  const res=await fetch('http://127.0.0.1:11434/api/pull',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model,stream:false}),signal});
  const body=await res.json();if(!res.ok||body.error)throw new Error(body.error||`HTTP ${res.status}`);return body;
}

// --- speed proxy ---------------------------------------------------------
// Claude Code's system prompt is ~10k tokens. Trimming it before a CPU-only
// local model sees it is the difference between a 60s and a 10s first token.

// Any service on the port answering 200 is not necessarily ours. The proxy
// reports its upstream in /health, so a plain `r.ok` would happily adopt a
// stranger's listener and send every prompt there.
export async function proxyStatus({upstream,url=PROXY_URL}={}){
  try{
    const r=await fetch(`${url}/health`,{signal:AbortSignal.timeout(1000)});
    if(!r.ok)return false;
    const body=await r.json().catch(()=>null);
    if(!body||body.ok!==true)return false;
    if(upstream&&body.upstream&&body.upstream!==upstream)return false;
    return true;
  }catch{return false;}
}

async function waitForProxy(timeoutMs=5000){
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    if(await proxyStatus())return true;
    await new Promise(resolve=>setTimeout(resolve,150));
  }
  return false;
}

/**
 * Parses the upstream a profile points at. Only the proxy's target matters, so
 * a path such as `/v1` is dropped; an unparseable URL yields null and the proxy
 * keeps its own default.
 */
export function ollamaUpstream(baseUrl){
  try{
    const u=new URL(String(baseUrl||''));
    if(!u.hostname)return null;
    // The scheme has to survive: a remote Ollama may require HTTPS, and turning
    // that into plaintext against a TLS listener simply fails.
    const secure=u.protocol==='https:';
    const port=u.port||(secure?'443':'11434');
    const scheme=secure?'https':'http';
    return {host:u.hostname,port:Number(port),secure,url:`${scheme}://${u.hostname}:${port}`};
  }catch{return null;}
}

/**
 * Starts the proxy unless one already answers on the port. `upstream` lets a
 * profile on another machine (a LAN Ollama) be forwarded to instead of the
 * local default, which is what the profile asked for.
 */
export async function startProxy({spawnImpl=spawn,nodeExecutable=process.execPath,timeoutMs=5000,upstream}={}){
  if(await proxyStatus({upstream:upstream?.url}))return {alreadyRunning:true,url:PROXY_URL};
  const env={...process.env,PORTABLE_PROXY_PORT:String(PROXY_PORT)};
  if(upstream?.host&&Number.isInteger(upstream.port)){
    env.PORTABLE_OLLAMA_HOST=upstream.host;
    env.PORTABLE_OLLAMA_PORT=String(upstream.port);
    env.PORTABLE_OLLAMA_SECURE=upstream.secure?'1':'0';
  }
  ownedProxy=spawnImpl(nodeExecutable,[join(ROOT,'tools','local-proxy.mjs')],{stdio:'ignore',env});
  ownedProxy.once('error',()=>{ownedProxy=null;});
  ownedProxy.once('exit',()=>{ownedProxy=null;});
  if(!await waitForProxy(timeoutMs)){stopProxy();throw new Error(`The local speed proxy did not start on port ${PROXY_PORT}`);}
  return {started:true,url:PROXY_URL};
}

/** Stops only a proxy this process started; a user's own instance is left alone. */
export function stopProxy(){
  if(!ownedProxy)return false;
  ownedProxy.kill();
  ownedProxy=null;
  return true;
}

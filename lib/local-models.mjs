import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { DATA, ROOT } from './paths.mjs';
let owned=null;
let ownedProxy=null;
export const PROXY_PORT = Number(process.env.PORTABLE_PROXY_PORT || 11435);
export const PROXY_URL = `http://127.0.0.1:${PROXY_PORT}`;

// Every launch is its own OS process, so "I started this" cannot be module
// state when two sessions share one Ollama server and proxy: the first to exit
// would stop both and break the second. The registry records who is still
// using the role and which child process serves it, across processes.
const CONSUMERS_FILE = join(DATA, 'run', 'local-consumers.json');
const ROLES = ['server', 'proxy'];

function isAlive(pid){
  try{process.kill(pid,0);return true;}
  catch(error){return error.code==='EPERM';}
}

function readConsumers(file){
  try{
    const parsed=JSON.parse(readFileSync(file,'utf8'));
    return {
      consumers:Array.isArray(parsed?.consumers)?parsed.consumers.filter(entry=>entry&&Number.isInteger(entry.pid)&&ROLES.includes(entry.role)):[],
      owners:parsed?.owners&&typeof parsed.owners==='object'?parsed.owners:{},
    };
  }catch{return {consumers:[],owners:{}};}
}

function writeConsumers(file,state){
  try{
    mkdirSync(dirname(file),{recursive:true});
    // Write-then-rename: a reader never sees a half-written file.
    const temporary=`${file}.${process.pid}.tmp`;
    writeFileSync(temporary,JSON.stringify(state));
    renameSync(temporary,file);
  }catch{}
}

// A synchronous sleep, so the lock below stays usable from the sync registry
// functions the session wiring calls.
function sleepSync(ms){
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);
}

function readLockOwner(lock){
  try{return JSON.parse(readFileSync(lock,'utf8'));}catch{return null;}
}

/**
 * Removes a lock whose owner is gone, without ever deleting a live one.
 *
 * A plain unlink-by-path has a time-of-check/time-of-use hole: two waiters can
 * both see the same stale lock, the first removes it and acquires a fresh one,
 * and the second then deletes that fresh lock - both end up inside the critical
 * section, which is the lost update the lock exists to prevent. The lock is
 * therefore moved aside first and the moved file is compared with what was
 * inspected; if it is not the same file, it is put back and the caller retries.
 */
function breakStaleLock(lock,{staleMs,alive}){
  const owner=readLockOwner(lock);
  // A live owner means a slow critical section, not a dead process.
  if(owner&&Number.isInteger(owner.pid)&&alive(owner.pid))return false;
  let before;
  try{before=statSync(lock);}catch{return false;}
  if(owner===null&&Date.now()-before.mtimeMs<=staleMs)return false;
  const aside=`${lock}.stale.${process.pid}.${Date.now()}`;
  try{renameSync(lock,aside);}catch{return false;}
  let after;
  try{after=statSync(aside);}catch{return false;}
  const sameFile=after.mtimeMs===before.mtimeMs&&after.size===before.size&&(before.ino===0||after.ino===before.ino);
  if(!sameFile){
    // A fresh lock was taken in between: restore it so its owner keeps it.
    try{renameSync(aside,lock);}catch{try{unlinkSync(aside);}catch{}}
    return false;
  }
  try{unlinkSync(aside);}catch{}
  return true;
}

/**
 * Cross-process lock for the registry.
 *
 * The atomic rename inside writeConsumers() prevents a torn file, not a lost
 * update: two launches registering the same role can both read the old state
 * and the later write drops the earlier pid, after which the survivor counts
 * itself as the last consumer and stops a process the other session still uses.
 * Exactly one process can create the lock file, so the read/modify/write
 * sequence runs serialised. A lock left behind by a killed process is broken
 * after `staleMs`; that limit stays below `timeoutMs` so a dead lock is always
 * cleaned up before a waiter falls back to running unserialised.
 */
function withConsumersLock(file,run,{timeoutMs=1500,staleMs=750,pollMs=10,alive=isAlive}={}){
  const lock=`${file}.lock`;
  const deadline=Date.now()+timeoutMs;
  let acquired=false;
  // A read-only data directory must not fail a session start; the registry then
  // simply behaves like it did before the lock existed.
  try{mkdirSync(dirname(file),{recursive:true});}catch{return run();}
  while(!acquired){
    try{
      closeSync(openSync(lock,'wx'));
      // The owner is written right away; an empty file is young and simply
      // blocks until its mtime passes staleMs.
      try{writeFileSync(lock,JSON.stringify({pid:process.pid,since:Date.now()}));}catch{}
      acquired=true;
    }catch(error){
      if(error.code!=='EEXIST')break;
      if(breakStaleLock(lock,{staleMs,alive}))continue;
      if(Date.now()>=deadline)break;
      sleepSync(pollMs);
    }
  }
  try{
    // Timed out on a lock that looked live: run unserialised rather than
    // dropping the registration, which would look like "nobody else uses this"
    // and stop a shared process.
    return run();
  }finally{
    if(acquired){
      // Only remove the lock this call created.
      const owner=readLockOwner(lock);
      if(!owner||owner.pid===process.pid)try{unlinkSync(lock);}catch{}
    }
  }
}

/**
 * Records that this process uses a role, and which child process serves it.
 * `pid`/`alive` are injectable so the bookkeeping is testable without spawning.
 */
export function registerLocalConsumer(role,{pid=process.pid,childPid=null,file=CONSUMERS_FILE,alive=isAlive}={}){
  return withConsumersLock(file,()=>{
    const state=readConsumers(file);
    state.consumers=state.consumers.filter(entry=>entry.pid===pid?entry.role!==role:alive(entry.pid));
    state.consumers.push({pid,role,since:Date.now()});
    if(childPid&&Number.isInteger(childPid))state.owners={...state.owners,[role]:childPid};
    writeConsumers(file,state);
  },{alive});
}

/**
 * Forgets a serving process that has exited. Without this the recorded pid
 * outlives the process, and once the operating system reuses that number the
 * last consumer would signal an unrelated process.
 */
export function clearLocalOwner(role,childPid,{file=CONSUMERS_FILE}={}){
  if(!Number.isInteger(childPid))return;
  withConsumersLock(file,()=>{
    const state=readConsumers(file);
    if(state.owners?.[role]!==childPid)return;
    delete state.owners[role];
    writeConsumers(file,state);
  });
}

/**
 * Drops this process's claim on a role and reports what is left.
 * `others` counts the live consumers of that role after the removal; `childPid`
 * is the serving process, so the last consumer can stop it even when the
 * process that spawned it has already exited.
 *
 * `onLast` runs inside the lock when this was the last consumer. Stopping the
 * process there closes the window in which a new session could register between
 * the "nobody else uses it" decision and the kill.
 */
export function releaseLocalConsumer(role,{pid=process.pid,file=CONSUMERS_FILE,alive=isAlive,onLast=null}={}){
  return withConsumersLock(file,()=>{
    const state=readConsumers(file);
    state.consumers=state.consumers.filter(entry=>entry.pid===pid?entry.role!==role:alive(entry.pid));
    const others=state.consumers.filter(entry=>entry.role===role).length;
    const recorded=state.owners?.[role];
    const childPid=Number.isInteger(recorded)&&alive(recorded)?recorded:null;
    // The recorded process is only meaningful while somebody uses it. Keeping it
    // after the last consumer leaves would risk killing an unrelated process once
    // the operating system reuses that pid.
    if(!childPid||others===0)delete state.owners[role];
    writeConsumers(file,state);
    if(others===0&&onLast)try{onLast(childPid);}catch{}
    return {others,childPid};
  },{alive});
}
export function ollamaExecutable(){return [join(DATA,'ollama',process.platform==='win32'?'ollama.exe':'ollama'),join(DATA,'ollama',`ollama-${process.platform}`),join(DATA,'ollama/bin/ollama')].find(existsSync);}
export async function localStatus({tagsUrl='http://127.0.0.1:11434/api/tags'}={}){
  let models=[],online=false;
  try{
    const r=await fetch(tagsUrl,{signal:AbortSignal.timeout(1500)});
    if(r.ok){
      const body=await r.json().catch(()=>null);
      // Ollama answers /api/tags with a `models` array. Any other 200 on the
      // port is somebody else's service: treating it as Ollama would skip
      // starting ours and route every turn to that listener.
      if(Array.isArray(body?.models)){models=body.models;online=true;}
    }
  }catch{}
  return {installed:!!ollamaExecutable(),online,owned:!!owned,proxy:await proxyStatus(),models:models.map(m=>({name:m.name,size:m.size}))};
}
export async function startLocal(){
  if((await localStatus()).online){registerLocalConsumer('server');return {alreadyRunning:true};}
  const exe=ollamaExecutable();if(!exe)throw new Error('Install portable Ollama using the local-model setup command shown in System');
  await new Promise((resolve,reject)=>{owned=spawn(exe,['serve'],{env:{...process.env,OLLAMA_MODELS:join(DATA,'ollama/data'),OLLAMA_HOST:'127.0.0.1:11434'},stdio:'ignore'});owned.once('spawn',resolve);owned.once('error',e=>{owned=null;reject(e);});owned.once('exit',()=>{owned=null;});});
  const childPid=owned?.pid;
  // Dying on its own must also forget the recorded pid, or a reused pid becomes
  // a kill target for the last session that leaves.
  owned.once('exit',()=>clearLocalOwner('server',childPid));
  registerLocalConsumer('server',{childPid});
  return {starting:true};
}
/**
 * Stops the bundled server. With `release` it is session cleanup and never
 * throws; the server then only stops when this was the last session using it,
 * so a second terminal is not left talking to a dead server.
 */
export function stopLocal({release=false}={}){
  const handle=owned;
  if(!handle&&!release)throw new Error('This server was not started by ClaudeCode-Portable; stop it in its own application');
  owned=null;
  let stopped=false;
  const {others}=releaseLocalConsumer('server',{onLast:childPid=>{
    // The session that started it may already have exited; the recorded child
    // process is then the only handle left.
    if(handle){stopped=true;try{handle.kill('SIGTERM');}catch{}}
    else if(childPid){stopped=true;try{process.kill(childPid,'SIGTERM');}catch{}}
  }});
  return others===0&&stopped;
}
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
    // An exact match, not "if it says something else": a foreign listener that
    // returns `{ok:true}` without an upstream field used to be adopted, and
    // every prompt then went there.
    if(upstream&&body.upstream!==upstream)return false;
    return true;
  }catch{return false;}
}

/**
 * Waits for the proxy this process spawned. A healthy proxy for another
 * upstream is not ours: two launches may point at different Ollama servers on
 * the same port, and adopting the stranger would send this profile's prompts
 * to the other endpoint. A child that already exited (EADDRINUSE) can never
 * become ready, so the poll stops instead of waiting out the timeout.
 */
export async function waitForProxy(timeoutMs=5000,{upstream,child,status=proxyStatus,pollMs=150}={}){
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    if(await status({upstream}))return true;
    if(child&&child.exitCode!==null)return false;
    await new Promise(resolve=>setTimeout(resolve,pollMs));
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
    // URL keeps the brackets an IPv6 literal needs inside an authority, but
    // node:http wants a bare hostname: it resolves "[::1]" to nothing
    // (ENOTFOUND). Keep them only where the value is formatted as a URL.
    const host=u.hostname.startsWith('[')?u.hostname.slice(1,-1):u.hostname;
    const authority=host.includes(':')?`[${host}]`:host;
    return {host,port:Number(port),secure,url:`${scheme}://${authority}:${port}`};
  }catch{return null;}
}

/**
 * Starts the proxy unless one already answers on the port. `upstream` lets a
 * profile on another machine (a LAN Ollama) be forwarded to instead of the
 * local default, which is what the profile asked for.
 */
export async function startProxy({spawnImpl=spawn,nodeExecutable=process.execPath,timeoutMs=5000,upstream}={}){
  if(await proxyStatus({upstream:upstream?.url})){registerLocalConsumer('proxy');return {alreadyRunning:true,url:PROXY_URL};}
  const env={...process.env,PORTABLE_PROXY_PORT:String(PROXY_PORT)};
  if(upstream?.host&&Number.isInteger(upstream.port)){
    env.PORTABLE_OLLAMA_HOST=upstream.host;
    env.PORTABLE_OLLAMA_PORT=String(upstream.port);
    env.PORTABLE_OLLAMA_SECURE=upstream.secure?'1':'0';
  }
  const child=spawnImpl(nodeExecutable,[join(ROOT,'tools','local-proxy.mjs')],{stdio:'ignore',env});
  ownedProxy=child;
  child.once('error',()=>{if(ownedProxy===child)ownedProxy=null;});
  child.once('exit',()=>{
    if(ownedProxy===child)ownedProxy=null;
    // Do not leave a dead pid recorded as the serving process.
    clearLocalOwner('proxy',child.pid);
  });
  // The readiness poll must expect this profile's upstream, or it accepts a
  // proxy another launch started for a different Ollama server.
  if(!await waitForProxy(timeoutMs,{upstream:upstream?.url,child})){
    // Kill only this child: it never registered, and stopping through the
    // registry could signal a healthy proxy another launch owns.
    if(ownedProxy===child)ownedProxy=null;
    try{child.kill();}catch{}
    throw new Error(`The local speed proxy did not start on port ${PROXY_PORT}`);
  }
  // Registered only after the health check passed: a child that lost the bind
  // must not overwrite the pid of a healthy proxy another launch owns.
  registerLocalConsumer('proxy',{childPid:child.pid});
  return {started:true,url:PROXY_URL};
}

/** Stops only a proxy this process started; a user's own instance is left alone. */
export function stopProxy(){
  const handle=ownedProxy;
  ownedProxy=null;
  let stopped=false;
  // Another session adopted this proxy; the registry only lets the last live
  // consumer stop it, and does so inside the lock.
  const {others}=releaseLocalConsumer('proxy',{onLast:childPid=>{
    if(handle){stopped=true;try{handle.kill();}catch{}}
    else if(childPid){stopped=true;try{process.kill(childPid);}catch{}}
  }});
  return others===0&&stopped;
}

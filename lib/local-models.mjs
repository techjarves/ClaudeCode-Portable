import { closeSync, constants as fsConstants, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
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
 * inspected; if it is not the same file, the caller retries and the moved file
 * is discarded without touching whatever lock is current.
 *
 * Age is taken from the owner record as well as the mtime, and a live owner is
 * only trusted for `maxAgeMs`: a lock whose unlink failed, or whose pid was
 * reused after a crash, would otherwise stay forever and degrade every call to
 * the unserialised fallback.
 */
function breakStaleLock(lock,{staleMs,maxAgeMs,alive}){
  const owner=readLockOwner(lock);
  let before;
  try{before=statSync(lock);}catch{return false;}
  const ownerPid=owner&&Number.isInteger(owner.pid)?owner.pid:null;
  const ownerAlive=ownerPid!==null&&alive(ownerPid);
  const since=Number(owner?.since);
  const age=Date.now()-Math.max(before.mtimeMs,Number.isFinite(since)?since:0);
  // A live owner may be slow; a dead or unknown one is stale much sooner.
  if(age<=(ownerAlive?maxAgeMs:staleMs))return false;
  const aside=`${lock}.stale.${process.pid}.${Date.now()}`;
  try{renameSync(lock,aside);}catch{return false;}
  let after;
  try{after=statSync(aside);}catch{return false;}
  const sameFile=after.mtimeMs===before.mtimeMs&&after.size===before.size&&(before.ino===0||after.ino===before.ino);
  if(!sameFile){
    // Another process took the lock in between. Never rename this file back
    // over it: restoring blindly would evict a live owner. COPYFILE_EXCL fails
    // when a lock exists, which is exactly when the aside copy must be dropped.
    try{copyFileSync(aside,lock,fsConstants.COPYFILE_EXCL);}catch{}
    try{unlinkSync(aside);}catch{}
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
 * after `staleMs`, well before `timeoutMs`; a lock whose recorded owner is alive
 * is honoured for `maxAgeMs`, because such a critical section takes microseconds
 * and a much older one means the record is wrong, not that the owner is slow.
 */
function withConsumersLock(file,run,{timeoutMs=1500,staleMs=750,maxAgeMs=15000,pollMs=10,alive=isAlive}={}){
  const lock=`${file}.lock`;
  const deadline=Date.now()+timeoutMs;
  let acquired=false;
  // Random enough that this call cannot be confused with an earlier lock this
  // same pid held (a leftover after a failed unlink).
  const token=`${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  // A read-only data directory must not fail a session start; the registry then
  // simply behaves like it did before the lock existed.
  try{mkdirSync(dirname(file),{recursive:true});}catch{return run();}
  while(!acquired){
    try{
      closeSync(openSync(lock,'wx'));
      // The owner is written right away; an empty file is young and simply
      // blocks until its mtime passes staleMs.
      try{writeFileSync(lock,JSON.stringify({pid:process.pid,since:Date.now(),token}));}catch{}
      acquired=true;
    }catch(error){
      if(error.code!=='EEXIST')break;
      if(breakStaleLock(lock,{staleMs,maxAgeMs,alive}))continue;
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
      // Only remove the lock this call created: the token survives a pid that
      // was reused for a later lock by the same process.
      const owner=readLockOwner(lock);
      if(!owner||owner.token===token)try{unlinkSync(lock);}catch{}
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
export async function startLocal({timeoutMs=15000,spawnImpl=spawn,status=localStatus,executable=ollamaExecutable(),graceMs=250,adoptionWindowMs=3000}={}){
  if((await status()).online){registerLocalConsumer('server');return {alreadyRunning:true};}
  const exe=executable;if(!exe)throw new Error('Install portable Ollama using the local-model setup command shown in System');
  const child=spawnImpl(exe,['serve'],{env:{...process.env,OLLAMA_MODELS:join(DATA,'ollama/data'),OLLAMA_HOST:'127.0.0.1:11434'},stdio:'ignore'});
  owned=child;
  // A failed spawn must reach the caller as the real error, not as "did not
  // answer" after a pointless poll.
  let spawnError=null;
  child.once('error',error=>{spawnError=error;if(owned===child)owned=null;});
  child.once('exit',()=>{if(owned===child)owned=null;});
  const outcome=await waitForOwnership({
    status:async()=>{const state=await status();return state?.online?state:null;},
    child,timeoutMs,pollMs:150,graceMs,adoptionWindowMs,
  });
  if(spawnError){if(owned===child)owned=null;throw spawnError;}
  if(outcome.ready&&outcome.ours){
    const childPid=child.pid;
    // Dying on its own must also forget the recorded pid, or a reused pid
    // becomes a kill target for the last session that leaves.
    child.once('exit',()=>clearLocalOwner('server',childPid));
    registerLocalConsumer('server',{childPid});
    return {starting:true};
  }
  if(outcome.ready){
    // Another launch won the port; this session may use it but owns nothing.
    registerLocalConsumer('server');
    return {alreadyRunning:true};
  }
  if(owned===child)owned=null;
  try{child.kill();}catch{}
  throw new Error('The bundled Ollama server did not answer on 127.0.0.1:11434');
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
/** The health answer of a listener, or null when nothing usable answers. */
export async function proxyHealth({url=PROXY_URL}={}){
  try{
    const r=await fetch(`${url}/health`,{signal:AbortSignal.timeout(1000)});
    if(!r.ok)return null;
    const body=await r.json().catch(()=>null);
    if(!body||body.ok!==true)return null;
    return body;
  }catch{return null;}
}

export async function proxyStatus({upstream,url=PROXY_URL}={}){
  const body=await proxyHealth({url});
  if(!body)return false;
  // An exact match, not "if it says something else": a foreign listener that
  // returns `{ok:true}` without an upstream field used to be adopted, and
  // every prompt then went there.
  if(upstream&&body.upstream!==upstream)return false;
  return true;
}

function childIsGone(child){
  return !!child&&(child.exitCode!==null||child.signalCode!==null);
}

/**
 * Decides whether the process answering on the port is the child we spawned.
 *
 * A still-running child is not proof: two launches race for the port, the loser
 * has not reached `bind()` yet while the winner already answers, and the loser
 * dies moments later. Recording that child as the owner and then clearing it on
 * exit would delete the winner's record and leave the shared server orphaned.
 *
 * The listener is therefore identified, not inferred: when the answer names its
 * pid (the proxy does), a pid match settles it. Ollama names no pid, so the
 * child has to outlive a short grace window while the port answers - a child
 * that lost the bind dies within it.
 *
 * The exit of our own child never ends the wait: the winner may take a moment
 * to answer, and adopting it is exactly the point. Only the absence of an
 * answer for `adoptionWindowMs` after our child died gives up.
 */
async function waitForOwnership({status,child,timeoutMs,pollMs,graceMs=250,adoptionWindowMs=3000}){
  const deadline=Date.now()+timeoutMs;
  let onlineSince=null;
  let goneSince=null;
  while(Date.now()<deadline){
    const answer=await status();
    if(answer){
      if(childIsGone(child))return {ready:true,ours:false};
      if(Number.isInteger(answer.pid))return {ready:true,ours:answer.pid===child?.pid};
      if(onlineSince===null)onlineSince=Date.now();
      if(Date.now()-onlineSince>=graceMs)return {ready:true,ours:true};
    }else{
      onlineSince=null;
      if(childIsGone(child)){
        if(goneSince===null)goneSince=Date.now();
        else if(Date.now()-goneSince>=adoptionWindowMs)return {ready:false,ours:false};
      }
    }
    await new Promise(resolve=>setTimeout(resolve,pollMs));
  }
  const answer=await status();
  if(answer)return {ready:true,ours:!childIsGone(child)};
  return {ready:false,ours:false};
}

/**
 * Waits for the proxy this process spawned, or for the one that won the port.
 * `ready` means a proxy answers for the expected upstream; `ours` means the
 * answering process is the child passed in.
 */
export async function waitForProxy(timeoutMs=5000,{upstream,child,status=proxyHealth,pollMs=150,graceMs=250,adoptionWindowMs=3000}={}){
  return waitForOwnership({
    status:async()=>{
      const body=await status({upstream});
      if(!body)return null;
      // The status probe may be a plain boolean in older callers and tests.
      if(body===true)return {ok:true};
      return body.upstream===upstream||upstream===undefined?body:null;
    },
    child,timeoutMs,pollMs,graceMs,adoptionWindowMs,
  });
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
export async function startProxy({spawnImpl=spawn,nodeExecutable=process.execPath,timeoutMs=5000,upstream,health=proxyHealth,graceMs=250,adoptionWindowMs=3000}={}){
  const expected=upstream?.url;
  const answer=async()=>{
    const body=await health();
    if(!body)return null;
    // The probe may be a plain boolean in older callers.
    if(body===true)return {ok:true};
    // An answer for a different upstream is somebody else's proxy.
    return expected===undefined||body.upstream===expected?body:null;
  };
  const existing=await answer();
  if(existing){registerLocalConsumer('proxy');return {alreadyRunning:true,url:PROXY_URL};}

  const env={...process.env,PORTABLE_PROXY_PORT:String(PROXY_PORT)};
  if(upstream?.host&&Number.isInteger(upstream.port)){
    env.PORTABLE_OLLAMA_HOST=upstream.host;
    env.PORTABLE_OLLAMA_PORT=String(upstream.port);
    env.PORTABLE_OLLAMA_SECURE=upstream.secure?'1':'0';
  }
  const child=spawnImpl(nodeExecutable,[join(ROOT,'tools','local-proxy.mjs')],{stdio:'ignore',env});
  ownedProxy=child;
  let spawnError=null;
  child.once('error',error=>{spawnError=error;if(ownedProxy===child)ownedProxy=null;});
  child.once('exit',()=>{if(ownedProxy===child)ownedProxy=null;});
  const outcome=await waitForOwnership({status:answer,child,timeoutMs,pollMs:150,graceMs,adoptionWindowMs});
  if(spawnError){if(ownedProxy===child)ownedProxy=null;throw spawnError;}
  // The listener names its pid, so ownership is decided by identity rather than
  // by "our child is still alive" - a child that has not reached bind() yet is
  // alive while the winner already answers.
  if(outcome.ready&&outcome.ours){
    child.once('exit',()=>clearLocalOwner('proxy',child.pid));
    registerLocalConsumer('proxy',{childPid:child.pid});
    return {started:true,url:PROXY_URL};
  }
  if(outcome.ready){
    // Another launch won the port: this session uses that proxy but owns
    // nothing, so it must not replace the recorded pid.
    if(ownedProxy===child)ownedProxy=null;
    registerLocalConsumer('proxy');
    return {alreadyRunning:true,url:PROXY_URL};
  }
  // Not ready and not adopted: kill only this child. It never registered, and
  // stopping through the registry could signal a proxy another launch owns.
  if(ownedProxy===child)ownedProxy=null;
  try{child.kill();}catch{}
  throw new Error(`The local speed proxy did not start on port ${PROXY_PORT}`);
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

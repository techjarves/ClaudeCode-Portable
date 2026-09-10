import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { DATA } from './paths.mjs';
let owned=null;
export function ollamaExecutable(){return [join(DATA,'ollama',process.platform==='win32'?'ollama.exe':'ollama'),join(DATA,'ollama',`ollama-${process.platform}`),join(DATA,'ollama/bin/ollama')].find(existsSync);}
export async function localStatus(){
  let models=[],online=false;
  try{const r=await fetch('http://127.0.0.1:11434/api/tags',{signal:AbortSignal.timeout(1500)});if(r.ok){models=(await r.json()).models||[];online=true;}}catch{}
  return {installed:!!ollamaExecutable(),online,owned:!!owned,models:models.map(m=>({name:m.name,size:m.size}))};
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

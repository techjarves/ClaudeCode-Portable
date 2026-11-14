import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { DATA } from './paths.mjs';

const textBlocks=content=>(Array.isArray(content)?content:[]).filter(block=>block?.type==='text'&&typeof block.text==='string').map(block=>block.text).filter(text=>text&&text!=='[Request interrupted by user]');
export const nativeSessionId=path=>String(path).split(/[\\/]/).pop().replace(/\.jsonl$/i,'');
export function parseNativeSession(path,profile){
  const rows=readFileSync(path,'utf8').split(/\r?\n/).filter(Boolean).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}}),transcript=[],messages=[];let workspace='',model=profile.model,created='',title='';
  for(const row of rows){
    if(row.isSidechain)continue;workspace ||= row.cwd||'';created ||= row.timestamp||'';
    if(row.type==='user'){
      for(const text of textBlocks(row.message?.content)){transcript.push({type:'message',role:'user',text});messages.push({role:'user',content:text});title ||= text.slice(0,64);}
      for(const block of Array.isArray(row.message?.content)?row.message.content:[])if(block?.type==='tool_result')transcript.push({type:'tool_result',id:block.tool_use_id,output:block.content,status:block.is_error?'failed':'completed'});
    }
    if(row.type==='assistant'&&row.message?.model!=='<synthetic>'){
      model=row.message?.model||model;
      for(const block of Array.isArray(row.message?.content)?row.message.content:[]){
        if(block.type==='text'&&block.text){transcript.push({type:'message',role:'assistant',text:block.text});messages.push({role:'assistant',content:block.text});}
        if(block.type==='thinking'&&block.thinking)transcript.push({type:'thinking',id:`native-${row.uuid}`,text:block.thinking});
        if(block.type==='tool_use')transcript.push({type:'tool',id:block.id,name:block.name,input:block.input,status:'running'});
      }
    }
    if(row.type==='last-prompt')title ||= row.lastPrompt?.slice(0,64)||'';
  }
  if(!workspace||!messages.length)return null;const source=statSync(path),sdkSessionId=nativeSessionId(path);
  return {sdkSessionId,title:title||'Claude conversation',workspace,provider:profile.provider,model,contextWindow:profile.contextWindow,created:created||source.birthtime.toISOString(),updated:source.mtime.toISOString(),messages,transcript,status:'completed',error:null,nativeSource:path,nativeSourceMtime:source.mtimeMs,nativeConversation:true,projectless:false};
}
export function removeNativeSession(session){
  const sdkSessionId=String(session?.sdkSessionId||'');if(!/^[a-f0-9-]{36}$/.test(sdkSessionId))return;
  const root=join(DATA,'claude');if(!existsSync(root))return;
  const candidates=session.nativeSource?[session.nativeSource]:[];
  for(const provider of readdirSync(root,{withFileTypes:true}))if(provider.isDirectory()){
    const projects=join(root,provider.name,'projects');if(!existsSync(projects))continue;
    for(const project of readdirSync(projects,{withFileTypes:true}))if(project.isDirectory()){const file=join(projects,project.name,`${sdkSessionId}.jsonl`);if(existsSync(file))candidates.push(file);}
  }
  for(const candidate of candidates){
    const target=resolve(candidate),rel=relative(root,target);
    // Stale records can point at an older installation; never delete outside this history root.
    if(!rel||rel.startsWith('..')||isAbsolute(rel))continue;
    if(existsSync(target))unlinkSync(target);
  }
}
export function nativeSessions(config){
  const found=[];
  for(const profile of Object.values(config.profiles||{})){
    const root=join(DATA,'claude',`${profile.provider}-${profile.auth}`,'projects');if(!existsSync(root))continue;
    for(const project of readdirSync(root,{withFileTypes:true}))if(project.isDirectory())for(const file of readdirSync(join(root,project.name)))if(/^[a-f0-9-]{36}\.jsonl$/.test(file)){
      try{const session=parseNativeSession(join(root,project.name,file),profile);if(session)found.push(session);}catch{}
    }
  }
  return found;
}

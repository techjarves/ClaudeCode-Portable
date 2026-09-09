import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA } from './paths.mjs';

export const MAX_ATTACHMENT_FILES = 10;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENT_TOTAL_BYTES = 20 * 1024 * 1024;
const validSession=id=>typeof id==='string'&&/^[a-f0-9-]{36}$/.test(id);
const safeName=value=>basename(String(value||'attachment')).replace(/[^\p{L}\p{N}._() -]/gu,'_').slice(0,160)||'attachment';

export function saveAttachments(sessionId, files, root=join(DATA,'attachments')) {
  if(!validSession(sessionId))throw new Error('Invalid session ID');
  if(!Array.isArray(files)||!files.length||files.length>MAX_ATTACHMENT_FILES)throw new Error(`Attach between 1 and ${MAX_ATTACHMENT_FILES} files`);
  const directory=join(root,sessionId);mkdirSync(directory,{recursive:true,mode:0o700});
  let total=0;const saved=[];
  try{
    for(const file of files){
      const encoded=String(file?.data||'');
      if(!encoded||encoded.length>Math.ceil(MAX_ATTACHMENT_BYTES*4/3)+4||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))throw new Error('Invalid attachment data');
      const bytes=Buffer.from(encoded,'base64');total+=bytes.length;
      if(!bytes.length||bytes.length>MAX_ATTACHMENT_BYTES)throw new Error(`Each attachment must be ${MAX_ATTACHMENT_BYTES/1024/1024} MB or smaller`);
      if(total>MAX_ATTACHMENT_TOTAL_BYTES)throw new Error(`Attachments must total ${MAX_ATTACHMENT_TOTAL_BYTES/1024/1024} MB or less`);
      const id=randomUUID(),name=safeName(file.name),path=join(directory,`${id}-${name}`),type=String(file.type||'application/octet-stream').slice(0,120);
      writeFileSync(path,bytes,{mode:0o600,flag:'wx'});saved.push({id,name,type,size:bytes.length,path});
    }
    return saved.map(({path,...item})=>item);
  }catch(error){for(const item of saved)rmSync(join(directory,`${item.id}-${item.name}`),{force:true});throw error;}
}

export function resolveAttachments(sessionId, ids, root=join(DATA,'attachments')) {
  if(!validSession(sessionId))throw new Error('Invalid session ID');
  if(ids===undefined)return [];
  if(!Array.isArray(ids)||ids.length>MAX_ATTACHMENT_FILES||ids.some(id=>typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id)))throw new Error('Invalid attachments');
  const directory=join(root,sessionId),names=existsSync(directory)?readdirSync(directory):[];
  return ids.map(id=>{
    const stored=names.find(name=>name.startsWith(`${id}-`));if(!stored)throw new Error('An attachment is missing; add it again');
    const path=join(directory,stored),size=statSync(path).size,name=stored.slice(id.length+1);
    return {id,name,type:'application/octet-stream',size,path};
  });
}

export function removeAttachments(sessionId, root=join(DATA,'attachments')) {
  if(validSession(sessionId))rmSync(join(root,sessionId),{recursive:true,force:true});
}

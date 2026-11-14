import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA } from './paths.mjs';

export const MAX_ATTACHMENT_FILES = 10;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENT_TOTAL_BYTES = 20 * 1024 * 1024;
// Images travel to the model as base64, which grows by a third, and providers
// cap them far below the generic file limit.
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const validSession=id=>typeof id==='string'&&/^[a-f0-9-]{36}$/.test(id);
const safeName=value=>basename(String(value||'attachment')).replace(/[^\p{L}\p{N}._() -]/gu,'_').slice(0,160)||'attachment';

// Magic-byte detection mirrors what the Claude Code terminal does, so a pasted
// screenshot is recognised even when the browser reports no MIME type.
export function detectImageType(bytes) {
  if(!bytes||bytes.length<12)return null;
  if(bytes[0]===0x89&&bytes[1]===0x50&&bytes[2]===0x4e&&bytes[3]===0x47)return 'image/png';
  if(bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff)return 'image/jpeg';
  if(bytes.subarray(0,6).toString('latin1')==='GIF87a'||bytes.subarray(0,6).toString('latin1')==='GIF89a')return 'image/gif';
  if(bytes.subarray(0,4).toString('latin1')==='RIFF'&&bytes.subarray(8,12).toString('latin1')==='WEBP')return 'image/webp';
  return null;
}

export const isImageType=type=>typeof type==='string'&&/^image\/(png|jpeg|gif|webp)$/.test(type);

// Metadata sidecar per attachment, so the stored type survives a restart instead
// of being guessed from the file extension.
const metaPath=(directory,id)=>join(directory,`${id}.meta.json`);
function writeMeta(directory,id,value){writeFileSync(metaPath(directory,id),`${JSON.stringify(value)}\n`,{mode:0o600});}
function readMeta(directory,id){try{return JSON.parse(readFileSync(metaPath(directory,id),'utf8'));}catch{return null;}}

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
      // Trust the bytes over the reported type: a pasted image often arrives as
      // application/octet-stream with no name.
      const reported=String(file.type||'application/octet-stream').slice(0,120);
      const type=detectImageType(bytes)||reported;
      if(type.startsWith('image/')&&!isImageType(type))throw new Error(`Unsupported image format: ${type}`);
      if(isImageType(type)&&bytes.length>MAX_IMAGE_BYTES)throw new Error(`Each image must be ${MAX_IMAGE_BYTES/1024/1024} MB or smaller`);
      const id=randomUUID(),name=safeName(file.name),path=join(directory,`${id}-${name}`);
      writeFileSync(path,bytes,{mode:0o600,flag:'wx'});
      writeMeta(directory,id,{name,type});
      saved.push({id,name,type,size:bytes.length,path});
    }
    return saved.map(({path,...item})=>item);
  }catch(error){for(const item of saved){rmSync(join(directory,`${item.id}-${item.name}`),{force:true});rmSync(metaPath(directory,item.id),{force:true});}throw error;}
}

/**
 * Resolves stored attachments for a run. Image types are returned with their
 * MIME type so the agent can hand them to the model as real image blocks; the
 * base64 payload is only read when `withData` is set.
 */
export function resolveAttachments(sessionId, ids, root=join(DATA,'attachments'), {withData=false}={}) {
  if(!validSession(sessionId))throw new Error('Invalid session ID');
  if(ids===undefined)return [];
  if(!Array.isArray(ids)||ids.length>MAX_ATTACHMENT_FILES||ids.some(id=>typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id)))throw new Error('Invalid attachments');
  const directory=join(root,sessionId),names=existsSync(directory)?readdirSync(directory):[];
  return ids.map(id=>{
    const stored=names.find(name=>name.startsWith(`${id}-`));if(!stored)throw new Error('An attachment is missing; add it again');
    const path=join(directory,stored),size=statSync(path).size,name=stored.slice(id.length+1);
    const meta=readMeta(directory,id);
    const type=meta?.type||'application/octet-stream';
    return {id,name,type,size,path,...(withData&&isImageType(type)?{data:readFileSync(path).toString('base64')}:{})};
  });
}

export function removeAttachments(sessionId, root=join(DATA,'attachments')) {
  if(validSession(sessionId))rmSync(join(root,sessionId),{recursive:true,force:true});
}

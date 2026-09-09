import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DATA } from './paths.mjs';
import { writeJSON } from './config.mjs';
import { nativeSessions } from './native-sessions.mjs';

export const profileFingerprint = p => createHash('sha256').update(JSON.stringify({ provider:p.provider, model:p.model, baseUrl:p.baseUrl, auth:p.auth, adapter:p.adapter||'builtin', toolFormat:p.toolFormat||'native', modelAliases:p.modelAliases||{} })).digest('hex');
export class SessionStore {
  constructor(directory = join(DATA,'sessions')) { this.directory = directory; mkdirSync(directory,{recursive:true,mode:0o700}); }
  path(id) { if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid session ID'); return join(this.directory,`${id}.json`); }
  get(id) { const p=this.path(id); return existsSync(p) ? JSON.parse(readFileSync(p,'utf8')) : null; }
  save(session) { session.updated=new Date().toISOString(); writeJSON(this.path(session.id),session); }
  create({ workspace, profile, trusted }) {
    if (!trusted) throw new Error('Confirm that you trust this workspace before starting an agent');
    const cwd = realpathSync(workspace); if (!statSync(cwd).isDirectory()) throw new Error('Workspace must be a directory');
    const session = { id:randomUUID(),title:'Untitled session',workspace:cwd,provider:profile.provider,model:profile.model,...(profile.contextWindow?{contextWindow:profile.contextWindow}:{}),fingerprint:profileFingerprint(profile),created:new Date().toISOString(),messages:[],events:[],status:'idle',sdkSessionId:null };
    this.save(session); return session;
  }
  createConversation({workspace,profile,trusted,projectless=false}){const session=this.create({workspace,profile,trusted});session.projectless=projectless;this.save(session);return session;}
  syncNative(config,activeIds=new Set()){
    const local=this.list(),bySdk=new Map(local.filter(s=>s.sdkSessionId).map(s=>[s.sdkSessionId,s]));
    for(const native of nativeSessions(config)){
      const existing=bySdk.get(native.sdkSessionId);if(existing&&activeIds.has(existing.id))continue;
      if(existing&&Number(existing.nativeSourceMtime||0)>=native.nativeSourceMtime)continue;
      const id=existing?.id||native.sdkSessionId,current=existing?this.get(id):null;
      writeJSON(this.path(id),{...current,...native,id,fingerprint:profileFingerprint(config.profiles[native.provider]),projectless:current?.projectless||false,title:current?.title&&current.title!=='Untitled session'?current.title:native.title});
    }
  }
  list() { return readdirSync(this.directory).filter(n=>/^[a-f0-9-]{36}\.json$/.test(n)).flatMap(n=>{try{return [this.get(n.slice(0,-5))];}catch{return [];}}).sort((a,b)=>b.updated.localeCompare(a.updated)).map(({messages,events,...s})=>s); }
  delete(id) { const path=this.path(id); if(existsSync(path)) unlinkSync(path); }
  recover() { for(const summary of this.list()) if(['running','queued','awaiting_approval'].includes(summary.status)){const s=this.get(summary.id);s.status='interrupted';this.save(s);} }
  legacy() {
    const directory=join(DATA,'chats'); if(!existsSync(directory))return [];
    return readdirSync(directory).filter(n=>/^[\w-]+\.json$/.test(n)).flatMap(n=>{try {const s=JSON.parse(readFileSync(join(directory,n),'utf8'));return [{id:n.slice(0,-5),title:s.title||'Legacy conversation',messages:s.messages||[],legacy:true}];}catch{return [];}});
  }
}

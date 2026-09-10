import { marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';
import hljs from '/vendor/highlight.js';
import { icon, hydrateIcons } from '/icons.js';
import { ComposerRequests } from '/requests.js';

const $=s=>document.querySelector(s);
const $$=s=>[...document.querySelectorAll(s)];
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const state={config:{profiles:{}},providers:{},sessions:[],legacy:[],current:null,workspace:'',projectless:true,expandedProjects:new Set(),runtime:{},responseTimeoutMs:120000,page:'studio',selectedProvider:'anthropic',models:[],attachments:[],running:false,runStatus:'idle',runStartedAt:null,runTimer:null,lastRunDurationMs:0,followOutput:true,durationNote:null,permissionMode:'default',activePermissionMode:'default',streaming:null,waiting:null,tools:new Map(),thinking:new Map(),seenEvents:new Set(),requestController:null};
let token=new URLSearchParams(location.hash.slice(1)).get('token')||sessionStorage.getItem('portable-token')||'';
if(token){sessionStorage.setItem('portable-token',token);history.replaceState(null,'',location.pathname);}
const profile=()=>state.config.profiles[state.config.active];
const shortPath=p=>String(p||'').split(/[\\/]/).filter(Boolean).at(-1)||'Workspace';
const pretty=value=>typeof value==='string'?value:JSON.stringify(value,null,2);
let toastTimer;
function toast(message){$('#toast').textContent=message;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,5500);}
async function api(path,body,method=body?'POST':'GET'){
  const res=await fetch(path,{method,headers:{'X-Portable-Token':token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const data=await res.json();if(!res.ok)throw new Error(data.error||`Request failed (${res.status})`);return data;
}
function formMessage(id,message,error=false){const el=$(id);el.textContent=message;el.classList.toggle('error',error);}
async function busy(button,fn){const label=button.innerHTML;button.disabled=true;button.textContent='Working…';try{return await fn();}catch(e){toast(e.message);throw e;}finally{button.disabled=false;button.innerHTML=label;}}
function setTheme(theme){
  document.documentElement.dataset.theme=theme;localStorage.setItem('portable-theme',theme);
  const next=theme==='dark'?'light':'dark',symbol=theme==='dark'?'sun':'moon';$('#settings-theme').innerHTML=icon(symbol)+`Switch to ${next} theme`;
  const toggle=$('#theme-toggle');toggle.innerHTML=icon(symbol);toggle.setAttribute('aria-label',`Switch to ${next} theme`);toggle.setAttribute('title',`Switch to ${next} theme`);toggle.setAttribute('aria-pressed',String(theme==='light'));
}
function toggleTheme(){setTheme(document.documentElement.dataset.theme==='dark'?'light':'dark');}
hydrateIcons();setTheme(localStorage.getItem('portable-theme')||'dark');
const sidebarLayout={width:Math.min(480,Math.max(220,Number(localStorage.getItem('portable-sidebar-width'))||240)),hidden:localStorage.getItem('portable-sidebar-hidden')==='true'};
function desktopSidebar(){return innerWidth>=768;}
function applySidebarLayout(){
  const desktop=desktopSidebar(),hidden=desktop&&sidebarLayout.hidden,shell=$('.shell'),resizer=$('#sidebar-resizer');
  shell.style.setProperty('--sidebar-width',`${sidebarLayout.width}px`);shell.classList.toggle('sidebar-collapsed',hidden);
  $('#sidebar-show').hidden=!hidden;$('#sidebar-hide').hidden=!desktop;resizer.hidden=!desktop||hidden;resizer.setAttribute('aria-valuenow',String(sidebarLayout.width));
}
function setSidebarHidden(hidden){sidebarLayout.hidden=hidden;localStorage.setItem('portable-sidebar-hidden',String(hidden));applySidebarLayout();}
$('#sidebar-hide').onclick=()=>setSidebarHidden(true);$('#sidebar-show').onclick=()=>setSidebarHidden(false);
const sidebarResizer=$('#sidebar-resizer');
sidebarResizer.addEventListener('pointerdown',event=>{
  if(!desktopSidebar()||event.button!==0)return;event.preventDefault();sidebarResizer.setPointerCapture(event.pointerId);
  const startX=event.clientX,startWidth=sidebarLayout.width;document.body.classList.add('resizing-sidebar');
  const move=moveEvent=>{sidebarLayout.width=Math.min(480,Math.max(220,startWidth+moveEvent.clientX-startX));applySidebarLayout();};
  const finish=()=>{document.body.classList.remove('resizing-sidebar');localStorage.setItem('portable-sidebar-width',String(sidebarLayout.width));sidebarResizer.removeEventListener('pointermove',move);sidebarResizer.removeEventListener('pointerup',finish);sidebarResizer.removeEventListener('pointercancel',finish);};
  sidebarResizer.addEventListener('pointermove',move);sidebarResizer.addEventListener('pointerup',finish);sidebarResizer.addEventListener('pointercancel',finish);
});
sidebarResizer.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();sidebarLayout.width=event.key==='Home'?220:event.key==='End'?480:Math.min(480,Math.max(220,sidebarLayout.width+(event.key==='ArrowLeft'?-10:10)));localStorage.setItem('portable-sidebar-width',String(sidebarLayout.width));applySidebarLayout();});
sidebarResizer.ondblclick=()=>{sidebarLayout.width=240;localStorage.setItem('portable-sidebar-width','240');applySidebarLayout();};
applySidebarLayout();
const permissionNames={default:'Review actions',acceptEdits:'Allow file edits',bypassPermissions:'Unrestricted'};
const requests=new ComposerRequests({panel:$('#composer-request'),prompt:$('#prompt'),decide:body=>api(`/api/sessions/${state.current.id}/approve`,body),changed:syncComposer});
function syncComposer(){
  const pending=requests.active;
  const actions=$('.composer-actions'),actionDeny=actions.querySelector(':scope > .request-deny'),panelDeny=$('#composer-request .request-deny');
  if(!pending||requests.isQuestion)actionDeny?.remove();
  else if(panelDeny){actionDeny?.remove();actions.insertBefore(panelDeny,$('#stop'));}
  $('#composer').classList.toggle('has-request',!!pending);$('#stop').hidden=!state.running;
  $('#send').hidden=state.running&&!pending;$('#send').disabled=!!state.current?.legacy||!!pending?.sending||(!pending&&!$('#prompt').value.trim()&&!state.attachments.length);
  const label=pending?(requests.isQuestion?(requests.finalQuestion?'Send answer':'Continue'):'Allow once'):'Send message';
  $('#send').setAttribute('aria-label',label);$('#send').classList.toggle('request-send',!!pending);
  $('#send').innerHTML=pending?`${pending.sending?'Sending…':label}${icon('arrow-right')}`:icon('arrow-up');
  $('#prompt').disabled=!!state.current?.legacy||!!pending?.sending;
  $('#attach-button').disabled=state.running||!!state.current?.legacy||!!pending;
  const prompt=$('#prompt'),style=getComputedStyle(prompt),lineHeight=parseFloat(style.lineHeight)||23,padding=(parseFloat(style.paddingTop)||0)+(parseFloat(style.paddingBottom)||0),minHeight=Math.ceil(lineHeight*2+padding),maxHeight=Math.ceil(lineHeight*5+padding);
  prompt.style.height='auto';const target=Math.min(maxHeight,Math.max(minHeight,prompt.scrollHeight));prompt.style.height=`${target}px`;prompt.style.overflowY=prompt.scrollHeight>maxHeight?'auto':'hidden';
}
function closePermissions(focus=false){$('#permission-menu').hidden=true;$('#permission-picker').setAttribute('aria-expanded','false');if(focus)$('#permission-picker').focus();}
function openPermissions(){ $('#permission-menu').hidden=false;$('#permission-picker').setAttribute('aria-expanded','true');$('#permission-menu [aria-pressed="true"]').focus(); }
$('#permission-picker').onclick=()=>$('#permission-menu').hidden?openPermissions():closePermissions(true);
document.addEventListener('click',e=>{if(!e.target.closest('.permission-control'))closePermissions();});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('#permission-menu').hidden){e.preventDefault();closePermissions(true);}});
$('#permission-menu').addEventListener('focusout',e=>{if(!e.currentTarget.parentElement.contains(e.relatedTarget))closePermissions();});
$('#permission-menu').onkeydown=e=>{const buttons=$$('[data-permission]'),i=buttons.indexOf(document.activeElement);if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();buttons[e.key==='Home'?0:e.key==='End'?buttons.length-1:(i+(e.key==='ArrowDown'?1:buttons.length-1))%buttons.length].focus();}};
$$('[data-permission]').forEach(button=>button.onclick=async()=>{
  const mode=button.dataset.permission;closePermissions(true);
  if(mode==='bypassPermissions'&&state.permissionMode!==mode){
    const confirmed=await dialog({title:'Allow unrestricted actions?',html:'<p>The next turn can change files and execute commands without approval. This does not restrict the agent to your workspace. Use only in an isolated environment you trust.</p><label for="confirmation-input">Type UNRESTRICTED to continue<input id="confirmation-input" required pattern="UNRESTRICTED" autocomplete="off"></label>',confirm:'Enable for next turn',value:()=>$('#confirmation-input').value==='UNRESTRICTED'});
    if(!confirmed)return;
  }
  state.permissionMode=mode;updateHeader();toast(state.running?`${permissionNames[mode]} selected for the next turn. The current turn is unchanged.`:`Permissions: ${permissionNames[mode]}.`);
});
$('#settings-permissions').onclick=()=>{setPage('studio');openPermissions();};

let dialogResolve=null;
function dialog({title,html,confirm='Continue',cancel='Cancel',value}){
  if(dialogResolve){dialogResolve(null);dialogResolve=null;}
  $('#dialog-title').textContent=title;$('#dialog-content').innerHTML=html;$('#dialog-confirm').textContent=confirm;$('#dialog-cancel').textContent=cancel;
  $('#dialog').showModal();return new Promise(resolve=>{dialogResolve=result=>resolve(result);$('#dialog-form').onsubmit=e=>{e.preventDefault();const result=value?value():true;if(result===false)return;$('#dialog').close();dialogResolve?.(result);dialogResolve=null;};});
}
function closeDialog(){ $('#dialog').close();dialogResolve?.(null);dialogResolve=null; }
$('#dialog-cancel').onclick=closeDialog;$('#dialog-close').onclick=closeDialog;$('#dialog').addEventListener('cancel',()=>{dialogResolve?.(null);dialogResolve=null;});
async function confirmAction(title,text,confirm='Confirm'){return dialog({title,html:`<p>${escape(text)}</p>`,confirm});}

let lastDrawerFocus=null;
function syncPanels(){const open=$('.sidebar.open,.inspector.open');$('.main').inert=!!open;$('#sidebar').inert=open?open.id!=='sidebar':innerWidth<768;$('#inspector').inert=open?open.id!=='inspector':true;}
function closeDrawers(){for(const id of ['sidebar','inspector']){const el=$(`#${id}`);el.classList.remove('open');el.removeAttribute('role');el.removeAttribute('aria-modal');}$('#drawer-backdrop').hidden=true;$('#nav-toggle').setAttribute('aria-expanded','false');$('#inspector-toggle').setAttribute('aria-expanded','false');syncPanels();lastDrawerFocus?.focus();lastDrawerFocus=null;}
function openDrawer(id){closeDrawers();lastDrawerFocus=document.activeElement;const panel=$(`#${id}`);panel.classList.add('open');panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');$('#drawer-backdrop').hidden=false;$(`#${id==='sidebar'?'nav':'inspector'}-toggle`).setAttribute('aria-expanded','true');syncPanels();panel.querySelector('button')?.focus();}
$('#nav-toggle').onclick=()=>openDrawer('sidebar');$('#inspector-toggle').onclick=()=>openDrawer('inspector');$('#drawer-backdrop').onclick=closeDrawers;$$('[data-close-drawers]').forEach(b=>b.onclick=closeDrawers);
document.addEventListener('keydown',e=>{
  if(e.key==='Escape')closeDrawers();
  if((e.metaKey||e.ctrlKey)&&e.key==='n'){e.preventDefault();newSession();}
  if((e.metaKey||e.ctrlKey)&&e.key==='o'){e.preventDefault();chooseWorkspace();}
  const panel=$('.sidebar.open,.inspector.open');if(panel&&e.key==='Tab'&&!$('#dialog').open){const f=[...panel.querySelectorAll('button,input,a,summary')].filter(x=>!x.disabled&&x.getClientRects().length);const first=f[0],last=f.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}
});
window.addEventListener('resize',()=>{if(innerWidth>=768&&$('#sidebar').classList.contains('open'))closeDrawers();applySidebarLayout();syncPanels();});syncPanels();

function renderBreadcrumb(){
  const settingsChild=state.page==='providers'||state.page==='system';
  $('#breadcrumb-icon').innerHTML=icon(state.page==='studio'?'folder':'settings');
  $('#workspace-picker').textContent=state.page==='studio'?(state.projectless?'No project':shortPath(state.workspace)):'Settings';
  $('#workspace-picker').title=state.page==='studio'?(state.projectless?'Attach this chat to a project folder':state.workspace):settingsChild?'Back to Settings':'Back to chat';
  $('#workspace-picker').classList.toggle('breadcrumb-current',state.page==='settings');
  $('#breadcrumb-separator').hidden=state.page==='settings';
  $('#page-title').hidden=state.page==='settings';
  $('#page-title').textContent=state.page==='studio'?state.current?.title||'New session':state.page==='providers'?'AI Provider':'System diagnostics';
}
function setPage(page){state.page=page;$$('.view').forEach(el=>el.hidden=el.id!==`view-${page}`);$$('[data-page]').forEach(el=>{el.classList.toggle('active',el.dataset.page===page);if(el.closest('nav'))el.setAttribute('aria-current',el.dataset.page===page?'page':'false');});renderBreadcrumb();closeDrawers();if(page==='providers'){renderProviders();selectProvider(state.config.active||state.selectedProvider);}if(page==='system')loadSystem().catch(e=>toast(e.message));}
$$('[data-page]').forEach(el=>el.onclick=()=>setPage(el.dataset.page));$('.brand').addEventListener('click',e=>{if(e.target.closest('button'))return;e.preventDefault();setPage('studio');});
$('#settings-launch').onclick=()=>setPage(state.page==='settings'?'studio':'settings');$('#settings-theme').onclick=toggleTheme;$('#theme-toggle').onclick=toggleTheme;
$('#settings-providers').onclick=()=>setPage('providers');$('#settings-system').onclick=()=>setPage('system');$('#connection').onclick=()=>setPage('providers');
$$('[data-back-settings]').forEach(button=>button.onclick=()=>setPage('settings'));
function selectableProfiles(){return Object.entries(state.config.profiles||{}).filter(([id,p])=>state.providers[id]&&p.auth!=='login');}
function renderModelSwitcher(){
  const select=$('#composer-model'),profiles=selectableProfiles(),selected=state.current?.provider||state.config.active,hasSelected=profiles.some(([id])=>id===selected);
  const options=profiles.map(([id,p])=>{const model=state.current?.provider===id?state.current.model:p.model;return `<option value="${escape(id)}">${escape(state.providers[id].name)} · ${escape(model||'Model not selected')}</option>`;}).join('');
  select.innerHTML=profiles.length?`${hasSelected?'':'<option value="">Choose a model</option>'}${options}`:'<option value="">Configure a model</option>';
  if(hasSelected)select.value=selected;
  select.disabled=!profiles.length||state.running||!!state.current?.legacy;
  select.title=state.running?'Stop the active turn before switching models':state.current?.legacy?'Legacy sessions are read-only':'Switching starts a new chat and keeps this chat in history';
}
const tokenCount=value=>{const n=Number(value);if(!Number.isFinite(n))return '—';if(n>=1000000)return `${(n/1000000).toFixed(n>=10000000?0:1)}m`;if(n>=1000)return `${Math.round(n/1000)}k`;return String(Math.round(n));};
function renderContextMeter(usage=state.current?.usage){
  const context=state.current||profile()||{},used=Number(usage?.input_tokens),limit=Number(context.contextWindow),meter=$('#context-meter');
  const knownUsed=Number.isFinite(used)&&used>=0,knownLimit=Number.isFinite(limit)&&limit>0,ratio=knownUsed&&knownLimit?used/limit:0;
  meter.hidden=!state.current||!knownUsed||used<=0;
  meter.textContent=`Context ${knownUsed?tokenCount(used):'—'} / ${knownLimit?tokenCount(limit):'?'}`;meter.classList.toggle('warning',ratio>=.8&&ratio<1);meter.classList.toggle('danger',ratio>=1);
  meter.title=knownLimit?`Latest request used ${knownUsed?used.toLocaleString():'an unknown number of'} of ${limit.toLocaleString()} configured context tokens${knownUsed?` (${Math.round(ratio*100)}%)`:''}.`:'The provider did not report this model’s context window. Set it in provider settings.';
}
function updateHeader(){
  const p=profile(),context=state.current||p,provider=state.providers[context?.provider]?.name;
  $('#connection').innerHTML=`<span class="status-dot ${context?'':'pending'}"></span>${context?`${escape(provider||context.provider)} · ${escape(context.model||'Model not selected')}`:'Choose an AI provider and model'}`;
  $('#settings-connection-summary').textContent=context?`${provider||context.provider} · ${context.model||'Model not selected'}`:'No AI provider selected';
  $('#setup-nudge').hidden=!!p;$('#workspace-name').textContent=state.projectless?'No project':shortPath(state.workspace);$('#composer-workspace').title=state.projectless?'Choose a project folder':state.workspace;renderBreadcrumb();
  $('#detail-workspace').textContent=state.projectless?'No project':shortPath(state.current?.workspace||state.workspace);$('#detail-workspace').title=state.projectless?'Projectless agent conversation':state.current?.workspace||state.workspace;
  $('#detail-provider').textContent=state.providers[context?.provider]?.name||'—';$('#detail-model').textContent=context?.model||'—';
  const mode=state.running?state.activePermissionMode:state.permissionMode,danger=mode==='bypassPermissions';
  $('#detail-permissions').textContent=permissionNames[mode];$('#permission-label').textContent=permissionNames[state.permissionMode];$('#permission-picker').classList.toggle('danger',state.permissionMode==='bypassPermissions');
  $$('[data-permission]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.permission===state.permissionMode)));
  $('.composer-foot>span:first-child').innerHTML=icon(danger?'alert':'shield')+(state.running&&mode!==state.permissionMode?`Current turn: ${permissionNames[mode]}. Next: ${permissionNames[state.permissionMode]}.`:danger?'Unrestricted mode. Actions run without approval.':mode==='acceptEdits'?'File edits allowed. Other permission checks remain on.':'You stay in control. Approvals are on.');
  $('#settings-version').textContent=state.runtime.version||'Not installed';$('#health-runtime').textContent=state.runtime.installed?'Ready':'Not installed';renderModelSwitcher();renderContextMeter();
}
function renderSessions(){
  const search=$('#session-search').value.toLowerCase(),sessions=[...state.sessions,...state.legacy].filter(s=>s.title.toLowerCase().includes(search));$('#session-count').textContent=state.sessions.length;
  const age=value=>{const seconds=Math.max(0,(Date.now()-new Date(value||0))/1000);return seconds<60?'now':seconds<3600?`${Math.floor(seconds/60)}m`:seconds<86400?`${Math.floor(seconds/3600)}h`:seconds<604800?`${Math.floor(seconds/86400)}d`:`${Math.floor(seconds/604800)}w`;};
  const row=s=>`<div class="session-row ${state.current?.id===s.id?'current':''}"><button class="session-select" data-session="${escape(s.id)}" ${s.legacy?'data-legacy="true"':''} title="${escape(s.title)}"><span>${escape(s.title)}</span><time>${age(s.updated||s.created)}</time></button>${!s.legacy&&!s.nativeConversation?`<button class="icon-btn delete-session" data-delete="${escape(s.id)}" aria-label="Delete ${escape(s.title)}">${icon('trash')}</button>`:''}</div>`;
  const recent=sessions.filter(s=>s.projectless||s.legacy),projects=new Map();for(const s of sessions.filter(s=>!s.projectless&&!s.legacy)){const key=s.workspace||'Unknown project';if(!projects.has(key))projects.set(key,[]);projects.get(key).push(s);}
  let html='';
  for(const [workspace,items] of projects){
    const expanded=!!search||state.expandedProjects.has(workspace);
    html+=`<section class="sidebar-group project-group ${expanded?'expanded':'collapsed'}"><button type="button" class="project-heading" data-project-toggle="${escape(workspace)}" aria-expanded="${expanded}" title="${expanded?'Collapse':'Expand'} ${escape(shortPath(workspace))}">${icon('folder')}<strong>${escape(shortPath(workspace))}</strong><span class="project-count">${items.length}</span><span class="project-chevron">${icon('chevron')}</span></button><div class="project-conversations" ${expanded?'':'hidden'}>${items.map(row).join('')}</div></section>`;
  }
  if(recent.length)html+=`<section class="sidebar-group conversations-group"><div class="sidebar-group-title"><span>Conversations</span><span>${recent.length}</span></div>${recent.map(row).join('')}</section>`;
  $('#session-list').innerHTML=html||`<p class="sidebar-empty">${search?'No matching conversations.':'Start a normal chat or open a project folder.'}</p>`;
  $$('[data-session]').forEach(b=>b.onclick=()=>loadSession(b.dataset.session,!!b.dataset.legacy).catch(e=>toast(e.message)));
  $$('[data-project-toggle]').forEach(b=>b.onclick=()=>{const workspace=b.dataset.projectToggle;if(state.expandedProjects.has(workspace))state.expandedProjects.delete(workspace);else state.expandedProjects.add(workspace);renderSessions();});
  $$('[data-delete]').forEach(b=>b.onclick=async()=>{if(!await confirmAction('Delete session?','This removes its dashboard transcript. Runtime session files are retained.','Delete'))return;try{await api(`/api/sessions/${b.dataset.delete}`,null,'DELETE');if(state.current?.id===b.dataset.delete)resetSession();await refreshSessions();}catch(e){toast(e.message);}});
}
async function refreshSessions(){const data=await api('/api/sessions');state.sessions=data.sessions;state.legacy=data.legacy;const latest=state.sessions.find(s=>s.id===state.current?.id);if(latest){Object.assign(state.current,latest);if(state.page==='studio')$('#page-title').textContent=latest.title;}renderSessions();}
$('#session-search').oninput=renderSessions;
function detachRunStream(){state.requestController?.abort();state.requestController=null;}
function resetSession(){detachRunStream();state.current=null;state.attachments=[];renderAttachments();state.running=false;state.followOutput=true;state.durationNote=null;state.tools.clear();state.thinking.clear();state.seenEvents.clear();requests.clear();state.streaming=null;clearWaiting();$('#transcript').replaceChildren();$('#welcome').hidden=false;$('#activity-list').innerHTML=`<div class="activity-empty"><div class="activity-empty-icon">${icon('activity')}</div><strong>A clear view of every step</strong><p>Tool calls and results appear here.<br>Answer requests in your composer.</p></div>`;$('#activity-count').textContent='0';$('#usage-details').replaceChildren();$('#prompt').disabled=false;setRunStatus('idle');updateHeader();renderSessions();}
async function newSession(){state.projectless=true;resetSession();setPage('studio');$('#prompt').focus();}
$('#new-session').onclick=newSession;
async function chooseWorkspace(){
  const apply=async selected=>{
    const currentWorkspace=state.current?.workspace||state.workspace;
    if(selected===currentWorkspace){toast(`This chat is already working in ${shortPath(currentWorkspace)}.`);return currentWorkspace;}
    if(state.current){
      const startNew=await dialog({title:'Start a new chat for this folder?',html:`<p>This chat stays connected to <strong>${escape(shortPath(currentWorkspace))}</strong>. To work in <strong>${escape(shortPath(selected))}</strong>, start a new chat.</p>`,confirm:'Start new chat',cancel:'Continue in current workspace'});
      if(!startNew){toast(`Continuing in ${shortPath(currentWorkspace)}.`);return null;}
    }
    state.workspace=selected;state.projectless=false;resetSession();setPage('studio');toast(`Opened ${shortPath(state.workspace)} in a new chat.`);return state.workspace;
  };
  try{
    const result=await api('/api/workspace/pick',{initial:state.workspace});
    if(result.cancelled)return null;
    return apply(result.workspace);
  }catch(error){
    const result=await dialog({title:'Enter a workspace path',html:`<p>${escape(error.message)}</p><p>The agent can read files and request changes in this directory. Only select a project you trust.</p><label for="workspace-input">Absolute directory path<input id="workspace-input" required value="${escape(state.workspace)}" autocomplete="off"></label>`,confirm:'Use workspace',value:()=>$('#workspace-input').value.trim()||false});
    return result?apply(result):null;
  }
}
$('#workspace-picker').onclick=()=>state.page==='studio'?chooseWorkspace():state.page==='settings'?setPage('studio'):setPage('settings');$('#composer-workspace').onclick=chooseWorkspace;
$('#composer-model').onchange=async()=>{
  const select=$('#composer-model'),provider=select.value,current=state.current?.provider||state.config.active;
  if(!provider||provider===current)return;
  try{
    state.config=await api('/api/config/active',{provider});
    const next=state.config.profiles[provider];resetSession();setPage('studio');
    toast(`New chat will use ${state.providers[provider].name} · ${next.model}.`);$('#prompt').focus();
  }catch(error){renderModelSwitcher();toast(error.message);}
};
$('#open-folder').onclick=chooseWorkspace;
async function ensureSession(){
  if(state.current)return true;
  if(!profile()){setPage('providers');toast('Connect a provider to start a session.');return false;}
  if(profile().auth==='login'){setPage('providers');toast('Use an API credential for the dashboard, or launch account login in the terminal.');return false;}
  state.current=await api('/api/sessions',{workspace:state.workspace,projectless:state.projectless,trusted:true});updateHeader();await refreshSessions();return true;
}
function renderMessageBody(body,text){
  body.innerHTML=DOMPurify.sanitize(marked.parse(text||''),{FORBID_TAGS:['style','iframe','form','input','button'],FORBID_ATTR:['style'],ALLOW_DATA_ATTR:false});
  body.querySelectorAll('a').forEach(a=>{if(!/^https?:\/\//i.test(a.getAttribute('href')||''))a.removeAttribute('href');else{a.target='_blank';a.rel='noopener noreferrer';}});
  body.querySelectorAll('img').forEach(img=>{if(!/^data:image\/(png|jpeg|gif|webp);base64,/.test(img.getAttribute('src')||''))img.remove();});
  body.querySelectorAll('pre code').forEach(code=>{
    if(code.textContent.length<100000)try{hljs.highlightElement(code);}catch{}
    const label=document.createElement('span');label.className='code-label';label.textContent=[...code.classList].find(c=>c.startsWith('language-'))?.slice(9)||'code';
    const copy=document.createElement('button');copy.type='button';copy.className='copy-code';copy.innerHTML=icon('copy')+'Copy';copy.setAttribute('aria-label','Copy code');copy.onclick=()=>navigator.clipboard.writeText(code.textContent).then(()=>toast('Code copied.')).catch(()=>toast('Clipboard unavailable. Select the code to copy.'));
    code.parentElement.prepend(label,copy);
  });
}
function continuesAssistantTurn(){
  for(const node of [...$('#transcript').children].reverse()){
    if(node.matches?.('.message.user'))return false;
    if(node.matches?.('.message.assistant:not(.model-waiting)'))return true;
  }
  return false;
}
function normalizeAssistantHeaders(){
  let headerShown=false;
  for(const node of $('#transcript').children){
    if(node.matches?.('.message.user')){headerShown=false;continue;}
    if(!node.matches?.('.message.assistant:not(.model-waiting)'))continue;
    const continuation=headerShown;
    node.classList.toggle('assistant-continuation',continuation);
    const header=node.querySelector('.message-header');if(header)header.hidden=continuation;
    headerShown=true;
  }
}
function addMessage(role,text,streaming=false,id,attachments=[]){
  const continuation=role==='assistant'&&continuesAssistantTurn();
  const el=document.createElement('article');el.className=`message ${role}${streaming?' streaming':''}${continuation?' assistant-continuation':''}`;
  if(id)el.dataset.messageId=id;
  el.innerHTML=`<div class="message-header"${continuation?' hidden':''}><span class="avatar">${role==='user'?'Y':icon('spark')}</span>${role==='user'?'You':'Agent'}${streaming?'<span class="muted">· working</span>':''}</div><div class="message-body"></div>`;
  const body=el.querySelector('.message-body');if(streaming||role==='user'){body.textContent=text;if(role==='user')body.style.whiteSpace='pre-wrap';}else{
    renderMessageBody(body,text);
  }
  if(attachments.length){const files=document.createElement('div');files.className='message-attachments';files.innerHTML=attachments.map(file=>`<span>${icon('paperclip')}<span>${escape(file.name)}</span><small>${formatBytes(file.size)}</small></span>`).join('');body.append(files);}
  $('#transcript').append(el);
  normalizeAssistantHeaders();$('#welcome').hidden=true;scrollConversation();return el;
}
function renderDurationNote(status){
  if(!state.lastRunDurationMs||state.durationNote)return;
  const note=document.createElement('p');note.className='run-duration-note';
  note.innerHTML=`${icon('check')}<span>${status==='cancelled'?'Stopped after':'Worked for'} ${workDuration(state.lastRunDurationMs)}</span>`;
  state.durationNote=note;$('#transcript').append(note);scrollConversation();
}
function toolSummary(name,input={}){
  if(name==='Read')return input.file_path||'Read file';
  if(name==='Bash')return input.description||input.command||'Run command';
  if(['Write','Edit','NotebookEdit'].includes(name))return input.file_path||input.notebook_path||'Update file';
  if(name==='Glob')return input.pattern||'Find files';
  if(name==='Grep')return input.pattern||'Search files';
  return input.description||input.query||input.url||'Tool request';
}
function toolInput(name,input={}){
  if(name==='Bash'&&input.command)return input.command;
  if(name==='Read'&&input.file_path)return input.file_path;
  return pretty(input);
}
function compactToolSummary(name,input={}){
  const summary=toolSummary(name,input);
  if(['Read','Write','Edit','NotebookEdit'].includes(name))return summary.split(/[\\/]/).filter(Boolean).pop()||summary;
  return summary.replace(/\s+/g,' ').trim();
}
function ensureAgentTurnHeader(){
  if(continuesAssistantTurn())return;
  const header=document.createElement('article');header.className='message assistant agent-step-header';header.innerHTML=`<div class="message-header"><span class="avatar">${icon('spark')}</span>Agent</div>`;$('#transcript').append(header);normalizeAssistantHeaders();
}
function appendTimelineStep(el){
  ensureAgentTurnHeader();$('#transcript').append(el);$('#welcome').hidden=true;scrollConversation();return el;
}
function renderChatTool(event){
  const el=document.createElement('details');el.className='chat-tool';el.dataset.toolId=event.id;
  el.innerHTML=`<summary title="Expand ${escape(event.name)} details"><span class="chat-tool-icon">${icon(event.name==='Read'?'review':'terminal')}</span><span class="chat-tool-name">${escape(event.name)}</span><span class="step-separator">·</span><span class="chat-tool-summary">${escape(compactToolSummary(event.name,event.input))}</span><span class="chat-tool-state ${escape(event.status)}">${escape(event.status)}</span><span class="chat-tool-chevron">${icon('chevron')}</span></summary><div class="chat-tool-body"><div class="chat-tool-section"><span>INPUT</span><pre>${escape(toolInput(event.name,event.input))}</pre></div><div class="chat-tool-result" hidden><span>OUTPUT</span><pre></pre></div></div>`;
  return appendTimelineStep(el);
}
function renderThinking(event){
  if(!event.text?.trim()||state.thinking.has(event.id))return;
  const el=document.createElement('details');el.className='thinking-step';el.dataset.thinkingId=event.id;
  el.innerHTML=`<summary title="Expand model thinking">${icon('spark')}<span>Think</span><span class="step-separator">·</span><span class="thinking-chevron">${icon('chevron')}</span></summary><div></div>`;
  el.querySelector('div').textContent=event.text;state.thinking.set(event.id,el);appendTimelineStep(el);
}
function renderHistoryNote(text){const el=document.createElement('p');el.className='history-note';el.innerHTML=`${icon('info')}${escape(text)}`;appendTimelineStep(el);}
function scrollConversation(force=false){
  if(!force&&!state.followOutput)return;
  requestAnimationFrame(()=>{const box=$('#conversation');if(force||state.followOutput)box.scrollTop=box.scrollHeight;});
}
$('#conversation').addEventListener('scroll',()=>{const box=$('#conversation');state.followOutput=box.scrollHeight-box.scrollTop-box.clientHeight<=48;},{passive:true});
async function loadSession(id,legacy=false){
  if(!legacy&&state.current?.id===id){setPage('studio');scrollConversation(true);return;}
  resetSession();const s=legacy?state.legacy.find(x=>x.id===id):await api(`/api/sessions/${id}`);state.current=s;state.lastRunDurationMs=Number(s.durationMs)||0;state.workspace=s.workspace||state.workspace;state.projectless=!!s.projectless;state.activePermissionMode=s.permissionMode||'default';
  if(legacy)s.messages?.forEach(m=>addMessage(m.role,typeof m.content==='string'?m.content:pretty(m.content)));
  else for(const event of s.transcript||[])renderEvent(event,true);
  if(!['running','queued','awaiting_approval'].includes(s.status))requests.clear();
  setRunStatus(s.status||'idle');updateUsage(s.usage,s.costUSD);updateHeader();renderSessions();setPage('studio');
  if(legacy){$('#prompt').disabled=true;$('#run-status').textContent='Legacy OpenClaude history · read-only. Start a new session to use Claude Code.';}
  else if(['running','queued','awaiting_approval'].includes(s.status))consumeRun(`/api/sessions/${id}/events`,null,id).catch(e=>toast(e.message));
}
const statusNames={idle:'Ready when you are',queued:'Queued',running:'Agent is working',awaiting_approval:'Your approval is needed',completed:'Turn completed',failed:'Something needs attention',cancelled:'Turn cancelled',interrupted:'Session interrupted'};
function showWaiting(status){
  if(state.streaming)return;
  if(!state.waiting){
    const el=document.createElement('article');el.className='message assistant model-waiting';el.setAttribute('role','status');el.setAttribute('aria-live','polite');
    el.innerHTML=`<div class="message-header"><span class="avatar">${icon('spark')}</span>Agent</div><div class="message-body"><span>Thinking</span><span class="waiting-dots" aria-hidden="true"><i></i><i></i><i></i></span></div>`;
    $('#transcript').append(el);$('#welcome').hidden=true;state.waiting=el;scrollConversation();
  }
}
function clearWaiting(){state.waiting?.remove();state.waiting=null;}
function workDuration(ms){
  const seconds=Math.max(0,Math.floor(ms/1000)),minutes=Math.floor(seconds/60),remaining=seconds%60;
  return minutes?`${minutes}m${remaining?` ${remaining}s`:''}`:`${seconds}s`;
}
function renderWorkingStatus(){
  if(!state.runStartedAt||!['queued','running'].includes(state.runStatus))return;
  $('#run-status').innerHTML=`<span>Working for ${workDuration(Date.now()-state.runStartedAt)}</span><span class="waiting-dots" aria-hidden="true"><i></i><i></i><i></i></span>`;
}
function updateRunClock(status){
  if(['queued','running'].includes(status)&&!state.runStartedAt){state.runStartedAt=Date.now();state.lastRunDurationMs=0;clearInterval(state.runTimer);state.runTimer=setInterval(renderWorkingStatus,1000);}
  if(['completed','failed','cancelled','interrupted','idle'].includes(status)){
    if(state.runStartedAt)state.lastRunDurationMs=Date.now()-state.runStartedAt;
    state.runStartedAt=null;clearInterval(state.runTimer);state.runTimer=null;
    if(status==='idle')state.lastRunDurationMs=0;
  }
}
function setRunStatus(status,error){
  state.runStatus=status;
  updateRunClock(status);
  state.running=['queued','running','awaiting_approval'].includes(status);$('#state-label').textContent=statusNames[status]||status;
  $('#state-icon').innerHTML=icon(status==='completed'?'check':status==='failed'?'alert':status==='awaiting_approval'?'shield':status==='running'?'activity':'circle');
  $('#state-copy').textContent=error||({idle:'Start a conversation to see your agent at work.',queued:'Preparing the runtime and your provider.',running:'Follow tool activity and results below.',awaiting_approval:'Review the exact action before continuing.',completed:'Ready for your next instruction.',cancelled:'No further actions will be started.',interrupted:'The studio restarted. Send a message to resume.'})[status]||'Check the error and try again.';
  if(status==='awaiting_approval'){$('#state-label').textContent=requests.isQuestion?'Waiting for your answer':'Waiting for approval';$('#state-copy').textContent='Respond in the composer below your conversation.';}
  if(['queued','running'].includes(status))showWaiting(status);else clearWaiting();
  $('#session-dot').className=`status-dot ${status==='failed'?'failed':status==='awaiting_approval'?'pending':''}`;
  if(error)$('#run-status').textContent=error;
  else if(['queued','running'].includes(status))renderWorkingStatus();
  else if(['completed','cancelled'].includes(status)){renderDurationNote(status);$('#run-status').textContent='';}
  else $('#run-status').textContent=['idle','completed'].includes(status)?'':statusNames[status]||status;
  $('#run-status').classList.toggle('error',status==='failed');
  syncComposer();updateHeader();
}
function updateUsage(usage,cost){
  if(state.current&&usage)state.current.usage=usage;renderContextMeter(usage);
  const lines=[];if(usage?.input_tokens!==undefined)lines.push(['Input tokens',usage.input_tokens.toLocaleString()]);if(usage?.output_tokens!==undefined)lines.push(['Output tokens',usage.output_tokens.toLocaleString()]);
  if(typeof cost==='number')lines.push(['Runtime cost estimate',`$${cost.toFixed(4)}`]);$('#usage-details').innerHTML=lines.map(([k,v])=>`<div class="usage-line"><span>${escape(k)}</span><span>${escape(v)}</span></div>`).join('');
}
function renderEvent(event,replay=false,sessionId=state.current?.id){
  if(sessionId&&state.current?.id!==sessionId)return;
  if(event.eventId&&event.type!=='delta'){if(state.seenEvents.has(event.eventId))return;state.seenEvents.add(event.eventId);}
  if(event.type==='status')setRunStatus(event.status);
  if(event.type==='delta'){
    clearWaiting();
    if(!state.streaming||state.streaming.dataset.messageId!==event.id){state.streaming=addMessage('assistant','',true,event.id);state.streaming.streamText='';}
    state.streaming.streamText+=event.text;renderMessageBody(state.streaming.querySelector('.message-body'),state.streaming.streamText);scrollConversation();
  }
  if(event.type==='message'){
    if(event.role==='assistant')clearWaiting();
    if(event.role==='assistant'&&state.streaming&&(!event.id||state.streaming.dataset.messageId===event.id)){
      const el=state.streaming;el.classList.remove('streaming');el.querySelector('.message-header .muted')?.remove();renderMessageBody(el.querySelector('.message-body'),event.text);state.streaming=null;
    }else{
      const el=addMessage(event.role||'assistant',event.text,false,event.id,event.attachments||[]);
      if(event.role==='user'&&state.waiting)state.waiting.before(el);
    }
  }
  if(event.type==='thinking'){clearWaiting();renderThinking(event);}
  if(event.type==='history_note')renderHistoryNote(event.text);
  if(event.type==='tool'){
    clearWaiting();
    if(!state.tools.size)$('#activity-list').replaceChildren();
    const inspector=document.createElement('details');inspector.className='tool-item';inspector.innerHTML=`<summary>${icon('terminal')}<strong>${escape(event.name)}</strong><span class="tool-state">${escape(event.status)}</span></summary><pre class="tool-output">${escape(pretty(event.input))}</pre>`;
    const chat=renderChatTool(event);state.tools.set(event.id,{inspector,chat,name:event.name,input:event.input,status:event.status});$('#activity-list').append(inspector);$('#activity-count').textContent=state.tools.size;scrollConversation();
  }
  if(['tool_result','tool_status'].includes(event.type)){
    const record=state.tools.get(event.id);if(record){
      record.status=event.status;
      for(const el of [record.inspector,record.chat]){const status=el.querySelector('.tool-state,.chat-tool-state');status.textContent=event.status;status.className=status.classList.contains('tool-state')?'tool-state':'chat-tool-state';status.classList.add(event.status);}
      if(event.type==='tool_result'){
        const out=document.createElement('pre');out.className='tool-output';out.textContent=pretty(event.output);record.inspector.append(out);
        const result=record.chat.querySelector('.chat-tool-result');result.hidden=false;result.querySelector('pre').textContent=pretty(event.output);
      }
    }
  }
  if(event.type==='approval'){
    requests.add(event,{focus:!replay&&state.page==='studio'});
    if(!replay){setRunStatus('awaiting_approval');$('#run-status').textContent=event.tool==='AskUserQuestion'?'The agent has a question for you.':'Review the action below to continue.';if(state.page!=='studio')toast('The agent needs your input. Return to Workspace to respond.');}
  }
  if(event.type==='approval_resolved'){requests.remove(event.requestId);if(!replay)setRunStatus(requests.active?'awaiting_approval':'running');}
  if(event.type==='result'){requests.clear();if(Number(event.durationMs)>0)state.lastRunDurationMs=Number(event.durationMs);setRunStatus(event.status,event.error);updateUsage(event.usage,event.costUSD);}
  if(event.type==='end'){setRunStatus(event.status,$('#run-status').classList.contains('error')?$('#run-status').textContent:undefined);state.streaming?.classList.remove('streaming');state.streaming=null;refreshSessions().catch(()=>{});}
  normalizeAssistantHeaders();
}
async function consumeRun(path,body,sessionId=state.current?.id){
  const controller=new AbortController();state.requestController=controller;
  if(body&&state.current?.id===sessionId)setRunStatus('queued');
  try{
    const res=await fetch(path,{method:body?'POST':'GET',headers:{'X-Portable-Token':token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:controller.signal});
    if(!res.ok){const err=await res.json();throw new Error(err.error||'Could not start the agent');}
    const reader=res.body.getReader(),decoder=new TextDecoder();let buffer='';
    while(true){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let n;while((n=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,n);buffer=buffer.slice(n+2);const data=frame.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trim()).join('\n');if(data)renderEvent(JSON.parse(data),false,sessionId);}}
    if(state.current?.id===sessionId&&state.running)setRunStatus('interrupted','Connection ended. Reopen this session to reconnect.');
  }catch(e){if(e.name!=='AbortError'&&state.current?.id===sessionId)setRunStatus('failed',e.message);}
  finally{if(state.requestController===controller)state.requestController=null;await refreshSessions().catch(()=>{});}
}
$('#composer').onsubmit=async e=>{
  e.preventDefault();if(requests.active){await requests.submit();return;}if(state.running)return;const written=$('#prompt').value.trim();if(!written&&!state.attachments.length)return;
  try{
    if(!await ensureSession())return;
    const uploaded=state.attachments.length?await uploadAttachments():[];
    const prompt=written||'Please inspect the attached files and help me continue this project.';
    state.attachments=[];renderAttachments();state.followOutput=true;$('#prompt').value='';$('#prompt').style.height='';setPage('studio');state.activePermissionMode=state.permissionMode;scrollConversation(true);
    const sessionId=state.current.id;
    await consumeRun(`/api/sessions/${sessionId}/run`,{prompt,attachments:uploaded.map(file=>file.id),permissionMode:state.permissionMode,...(state.permissionMode==='bypassPermissions'?{confirmation:'UNRESTRICTED'}:{})},sessionId);
  }catch(err){toast(err.message);}
};
$('#prompt').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();$('#composer').requestSubmit();}});
$('#prompt').addEventListener('input',syncComposer);
const formatBytes=size=>size>=1024*1024?`${(size/1024/1024).toFixed(1)} MB`:size>=1024?`${Math.ceil(size/1024)} KB`:`${size} B`;
function renderAttachments(){
  const list=$('#attachment-list');list.hidden=!state.attachments.length;
  list.innerHTML=state.attachments.map((file,index)=>`<span class="attachment-chip">${icon('paperclip')}<span title="${escape(file.name)}">${escape(file.name)}</span><small>${formatBytes(file.size)}</small><button type="button" data-remove-attachment="${index}" aria-label="Remove ${escape(file.name)}">${icon('close')}</button></span>`).join('');
  $$('[data-remove-attachment]').forEach(button=>button.onclick=()=>{state.attachments.splice(Number(button.dataset.removeAttachment),1);renderAttachments();syncComposer();});syncComposer();
}
function fileBase64(file){return file.arrayBuffer().then(buffer=>{const bytes=new Uint8Array(buffer);let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(binary);});}
async function uploadAttachments(){const files=await Promise.all(state.attachments.map(async file=>({name:file.name,type:file.type,data:await fileBase64(file)})));return (await api(`/api/sessions/${state.current.id}/attachments`,{files})).attachments;}
$('#attach-button').onclick=()=>$('#attachment-input').click();
$('#attachment-input').onchange=()=>{
  const incoming=[...$('#attachment-input').files],combined=[...state.attachments];$('#attachment-input').value='';
  for(const file of incoming){if(file.size>10*1024*1024){toast(`${file.name} is larger than 10 MB.`);continue;}if(combined.length>=10){toast('You can attach up to 10 files.');break;}if(!combined.some(saved=>saved.name===file.name&&saved.size===file.size&&saved.lastModified===file.lastModified))combined.push(file);}
  if(combined.reduce((sum,file)=>sum+file.size,0)>20*1024*1024){toast('Attachments must total 20 MB or less.');return;}state.attachments=combined;renderAttachments();
};
$('#stop').onclick=async()=>{try{await api(`/api/sessions/${state.current.id}/cancel`,{});}catch(e){toast(e.message);}};
$$('[data-suggestion]').forEach(b=>b.onclick=()=>{$('#prompt').value=b.dataset.suggestion;$('#prompt').dispatchEvent(new Event('input'));$('#prompt').focus();});

function renderProviders(){
  $('#provider-grid').innerHTML=Object.entries(state.providers).map(([id,p])=>`<button type="button" class="provider-option ${state.selectedProvider===id?'selected':''}" data-provider="${id}" aria-pressed="${state.selectedProvider===id}"><span class="provider-monogram">${escape(p.short)}</span><strong>${escape(p.name)}</strong><small>${escape(p.description)}</small>${state.config.profiles[id]?`<span class="connected-mark">${icon('check')}</span>`:''}</button>`).join('');
  $$('[data-provider]').forEach(b=>b.onclick=()=>selectProvider(b.dataset.provider));
}
function selectProvider(id){
  state.selectedProvider=id;state.models=[];const p=state.providers[id];if(!p)return;const saved=state.config.profiles[id];
  renderProviders();$('#provider-title').textContent=p.name;$('#transport-tag').textContent=p.transport==='anthropic'?'Direct Messages API':'Local compatibility adapter';
  $('#provider-note').textContent=id==='anthropic'?'Use an API key in the studio, or choose account login for terminal sessions.':p.transport==='openai'?'The official agent connects through a local protocol adapter. Extended thinking and provider-specific server tools are not supported.':'This provider exposes an Anthropic-compatible endpoint. Non-Claude model capabilities vary.';
  $('#base-url').value=saved?.baseUrl||p.baseUrl;$('#api-key').value='';setApiKeyVisibility(false);$('#api-key').placeholder=saved?.hasKey?'Credential saved · leave blank to keep':'Enter your provider API key';$('#key-saved').textContent=saved?.hasKey?'· saved':'';
  $('#model-name').value=saved?.model||p.defaultModel||'';$('#context-window').value=saved?.contextWindow||'';$('#auth').value=saved?.auth||'api';$('#auth-field').hidden=id!=='anthropic';$('#model-results').hidden=true;formMessage('#provider-message','');updateAuthField();updateAdapterFields(true);
}
function updateAdapterFields(loadSaved=false){
  const p=state.providers[state.selectedProvider];const saved=state.config.profiles[state.selectedProvider];
  const supportsExternal=p?.transport==='openai';
  $('#adapter-field').hidden=!supportsExternal;
  if(loadSaved||!supportsExternal)$('#adapter-choice').value=supportsExternal?(saved?.adapter||'builtin'):'builtin';
  const external=supportsExternal&&$('#adapter-choice').value==='external';
  $('#tool-format-field').hidden=!external;$('#alias-field').hidden=!external;
  if(external&&loadSaved){$('#tool-format').value=saved?.toolFormat||'native';$('#alias-opus').value=saved?.modelAliases?.opus||'';$('#alias-sonnet').value=saved?.modelAliases?.sonnet||'';$('#alias-haiku').value=saved?.modelAliases?.haiku||'';}
}
$('#adapter-choice').onchange=()=>updateAdapterFields();
function setApiKeyVisibility(visible){const input=$('#api-key'),button=$('#toggle-api-key');input.type=visible?'text':'password';button.setAttribute('aria-pressed',String(visible));button.setAttribute('aria-label',visible?'Hide API credential':'Show API credential');button.title=visible?'Hide API credential':'Show API credential';button.innerHTML=icon(visible?'eye-off':'eye');}
$('#toggle-api-key').onclick=async()=>{const reveal=$('#api-key').type==='password';if(reveal&&!$('#api-key').value&&state.config.profiles[state.selectedProvider]?.hasKey){try{$('#api-key').value=(await api(`/api/config/key?provider=${encodeURIComponent(state.selectedProvider)}`)).key||'';}catch(error){toast(error.message);return;}}setApiKeyVisibility(reveal);};
function updateAuthField(){const login=state.selectedProvider==='anthropic'&&$('#auth').value==='login';$('#key-field').hidden=login;$('#discover-models').disabled=login;$('#test-connection').disabled=login;$('#base-url').readOnly=login;if(login)$('#base-url').value=state.providers.anthropic.baseUrl;}
$('#auth').onchange=updateAuthField;
function providerInput(){const id=state.selectedProvider;const value={provider:id,auth:id==='anthropic'?$('#auth').value:'api',baseUrl:$('#base-url').value.trim(),model:$('#model-name').value.trim(),contextWindow:$('#context-window').value.trim()};if($('#api-key').value||!state.config.profiles[id]?.hasKey)value.key=$('#api-key').value;const p=state.providers[id];if(p?.transport==='openai'){value.adapter=$('#adapter-choice').value||'builtin';if(value.adapter==='external'){value.toolFormat=$('#tool-format').value||'native';const aliases={opus:$('#alias-opus').value.trim(),sonnet:$('#alias-sonnet').value.trim(),haiku:$('#alias-haiku').value.trim()};for(const k of Object.keys(aliases))if(!aliases[k])delete aliases[k];if(Object.keys(aliases).length)value.modelAliases=aliases;}}return value;}
$('#discover-models').onclick=()=>busy($('#discover-models'),async()=>{try{const data=await api('/api/models',providerInput());state.models=data.models;renderModels();formMessage('#provider-message',`${data.models.length} models discovered. Select one or enter its identifier.`);}catch(e){formMessage('#provider-message',e.message,true);throw e;}}).catch(()=>{});
$('#test-connection').onclick=()=>busy($('#test-connection'),async()=>{formMessage('#provider-message','Testing endpoint and credential…');try{const result=await api('/api/connection/test',providerInput());formMessage('#provider-message',result.message);}catch(error){formMessage('#provider-message',error.message,true);throw error;}}).catch(()=>{});
function renderModels(){const query=$('#model-name').value.toLowerCase();const items=state.models.filter(m=>m.id.toLowerCase().includes(query)||m.name.toLowerCase().includes(query)).slice(0,100);$('#model-results').hidden=!state.models.length;$('#model-results').innerHTML=items.length?items.map(m=>`<button type="button" data-model="${escape(m.id)}" data-context-window="${escape(m.contextWindow||'')}"><span>${escape(m.id)}</span>${m.contextWindow?`<small>${escape(tokenCount(m.contextWindow))} context</small>`:''}</button>`).join(''):'<p>No matching models. You can enter an identifier manually.</p>';$$('[data-model]').forEach(b=>b.onclick=()=>{$('#model-name').value=b.dataset.model;if(b.dataset.contextWindow)$('#context-window').value=b.dataset.contextWindow;$('#model-results').hidden=true;});}
$('#model-name').oninput=renderModels;
$('#provider-form').onsubmit=e=>{e.preventDefault();busy($('#provider-form button[type=submit]'),async()=>{state.config=await api('/api/config',providerInput());resetSession();renderProviders();formMessage('#provider-message','Connection saved. Start a new session when you’re ready.');toast('Provider saved. Your next session will use this connection.');}).catch(e=>formMessage('#provider-message',e.message,true));};

async function loadSystem(){
  const data=await api('/api/system');state.runtime=data.runtime;updateHeader();
  $('#system-grid').innerHTML=[['Claude Code',data.runtime.version||'Not installed'],['Agent SDK',data.runtime.sdk],['Platform',data.runtime.platform],['Bundled Node.js',data.runtime.node]].map(([k,v])=>`<div class="system-stat"><span>${escape(k)}</span><strong>${escape(v)}</strong></div>`).join('');
  $('#ollama-status').textContent=data.local.online?'Online':data.local.installed?'Installed · stopped':'Not installed';$('#local-start').disabled=data.local.online||!data.local.installed;$('#local-stop').disabled=!data.local.owned;
  $('#local-model-list').innerHTML=data.local.models.length?data.local.models.map(m=>`<div class="local-model"><strong>${escape(m.name)}</strong><small>${(m.size/1e9).toFixed(1)} GB</small></div>`).join(''):'<p class="muted">No local models available. Start your server or download a model below.</p>';
  $('#local-command').textContent=data.runtime.platform.startsWith('win32')?'.\\START.bat local-setup':'bash start.sh local-setup';
  $('#log-buttons').innerHTML=data.logs.length?data.logs.map(name=>`<button class="secondary" data-log="${escape(name)}">${icon('terminal')}${escape(name)}</button>`).join(''):'<p class="muted">No logs yet.</p>';
  $$('[data-log]').forEach(b=>b.onclick=async()=>{try{$('#log-output').textContent=(await api(`/api/log?name=${encodeURIComponent(b.dataset.log)}`)).text||'This log is empty.';}catch(e){toast(e.message);}});
}
$('#system-refresh').onclick=()=>loadSystem().catch(e=>toast(e.message));
$('#copy-local-command').onclick=()=>navigator.clipboard.writeText($('#local-command').textContent).then(()=>toast('Setup command copied.'));
for(const [id,action]of[['local-start','start'],['local-stop','stop']])$(`#${id}`).onclick=()=>busy($(`#${id}`),async()=>{await api('/api/local',{action});await loadSystem();toast(action==='start'?'Server is starting. Refresh to check its status.':'Owned server stopped.');}).catch(()=>{});
$('#pull-form').onsubmit=async e=>{e.preventDefault();const model=$('#pull-name').value.trim();if(!await confirmAction('Download a local model?',`Download ${model}? This may consume many gigabytes of storage and network traffic. The download is managed by your local Ollama server.`,'Download'))return;busy($('#pull-form button'),async()=>{formMessage('#pull-status','Downloading model. Keep this page open; large models may take a while.');await api('/api/local',{action:'pull',model,confirm:true});formMessage('#pull-status','Model downloaded. Select it in Providers → Ollama.');await loadSystem();}).catch(e=>formMessage('#pull-status',e.message,true));};
for(const [id,action]of[['runtime-install','install'],['runtime-rollback','rollback']])$(`#${id}`).onclick=async()=>{if(!await confirmAction(action==='install'?'Repair / update runtime?':'Roll back runtime?','All active turns must be stopped. The current working installation is preserved until the replacement is verified.','Continue'))return;busy($(`#${id}`),async()=>{formMessage('#runtime-message','Runtime maintenance in progress. This can take several minutes.');state.runtime=await api('/api/runtime',{action});updateHeader();formMessage('#runtime-message','Runtime ready. Restart the studio before starting another session.');}).catch(e=>formMessage('#runtime-message',e.message,true));};

async function init(){
  const data=await api('/api/bootstrap');Object.assign(state,{config:data.config,providers:data.providers,sessions:data.sessions,runtime:data.runtime,workspace:data.workspace,responseTimeoutMs:data.responseTimeoutMs||state.responseTimeoutMs});
  $('#health-connection').textContent='Connected';updateHeader();resetSession();renderProviders();await refreshSessions();$('#send').disabled=true;
}
init().catch(e=>{$('#connection').innerHTML='<span class="status-dot failed"></span>Disconnected';$('#health-connection').textContent='Disconnected';setRunStatus('failed',e.message);toast(e.message);});

import { icon } from './icons.js';

const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// One interaction surface for runtime questions and approval requests. The normal
// message draft is restored after the queue has been answered or cancelled.
export class ComposerRequests {
  constructor({panel,prompt,decide,changed}) {
    Object.assign(this,{panel,prompt,decide,changed});this.pending=new Map();this.draft=null;
  }
  get active(){return this.pending.values().next().value;}
  get isQuestion(){return this.active?.event.tool==='AskUserQuestion';}
  get finalQuestion(){return this.active?.step===(this.active?.event.input.questions?.length||1)-1;}
  add(event,{focus=false}={}) {
    if(this.pending.has(event.requestId))return;
    if(!this.active){this.draft=this.prompt.value;this.prompt.value='';}
    this.pending.set(event.requestId,{event,step:0,answers:[],sending:false});
    if(this.pending.size===1)this.render(focus);else this.updateCount();
  }
  remove(id) {
    const current=this.active?.event.requestId===id;this.pending.delete(id);
    if(current)this.render(true);else this.updateCount();
  }
  clear(){this.pending.clear();this.render();}
  updateCount(){const count=this.panel.querySelector('.request-queue');if(count)count.textContent=this.pending.size>1?`${this.pending.size} requests waiting`:'';}
  saveAnswer(){
    const item=this.active;if(!this.isQuestion||!item)return;
    item.answers[item.step]={selected:[...this.panel.querySelectorAll('input:checked')].map(input=>input.value),custom:this.prompt.value.trim()};
  }
  render(focus=false) {
    const item=this.active;this.panel.hidden=!item;
    this.panel.classList.toggle('approval-request',!!item&&!this.isQuestion);this.panel.classList.toggle('question-request',!!item&&this.isQuestion);
    this.prompt.hidden=!!item&&!this.isQuestion;
    this.prompt.placeholder=item?'Or write your own answer…':'What would you like to build?';
    this.prompt.setAttribute('aria-label',item?'Your answer or additional details':'Message your coding agent');
    if(!item){this.panel.replaceChildren();if(this.draft!==null){this.prompt.value=this.draft;this.draft=null;}this.prompt.removeAttribute('aria-describedby');this.changed();if(focus)this.prompt.focus();return;}
    const question=this.isQuestion;
    const q=question?item.event.input.questions?.[item.step]:null;
    const answer=item.answers[item.step]||{selected:[],custom:''};
    const questions=item.event.input.questions||[];
    this.prompt.value=question?answer.custom:'';
    this.panel.innerHTML=`<div class="request-heading"><span class="request-symbol">${icon(question?'spark':'shield')}</span><span class="request-eyebrow">${question?'YOUR INPUT':'ACTION REVIEW'}</span><span class="request-queue"></span>${question?`<span class="request-progress">${item.step+1} / ${questions.length}</span>`:''}</div><div class="request-body">${question?`<fieldset class="request-question"><legend id="request-title">${escape(q?.question||'What would you like the agent to know?')}</legend><p class="request-help" id="request-help">${q?.multiSelect?'Select any that apply':'Choose an option'}, or write below.</p><div class="request-options">${(q?.options||[]).map((o,i)=>`<label class="request-option"><input type="${q.multiSelect?'checkbox':'radio'}" name="request-choice" value="${escape(o.label)}" ${answer.selected.includes(o.label)?'checked':''}><span class="option-number" aria-hidden="true">${i+1}</span><span class="option-copy"><strong>${escape(o.label)}</strong>${o.description?`<small>${escape(o.description)}</small>`:''}</span><span class="option-check">${icon('check')}</span></label>`).join('')}</div></fieldset>`:`<h2 id="request-title">Allow this action?</h2><p class="request-help">The agent is paused until you decide. This allows one tool call only.</p><div class="request-tool"><span>${icon('terminal')}${escape(item.event.tool)}</span><code>${escape(item.event.input.file_path||item.event.input.command||item.event.input.description||'Review the arguments below')}</code></div><details class="request-arguments"><summary>Exact tool arguments</summary><pre>${escape(JSON.stringify(item.event.input,null,2))}</pre></details>`}<p id="request-error" class="request-error" role="alert"></p></div><div class="request-footer"><button type="button" class="text-btn request-back" ${!question||item.step===0?'hidden':''}>${icon('undo')}Back</button><span class="request-caption">${question?'Your answer goes back to the agent.':'No permission is remembered for future actions.'}</span><button type="button" class="request-deny">${question?'Skip request':'Deny action'}</button></div>`;
    this.updateCount();this.prompt.setAttribute('aria-describedby','request-title');
    this.panel.querySelector('.request-back').onclick=()=>{this.saveAnswer();item.step--;this.render(true);};
    this.panel.querySelector('.request-deny').onclick=()=>this.resolve(false);
    this.changed();if(focus){const target=this.panel.querySelector('input')||this.panel.querySelector('.request-deny');target?.focus();}
  }
  async submit(){
    if(!this.active||this.active.sending)return;
    if(this.isQuestion){
      this.saveAnswer();const item=this.active,answer=item.answers[item.step];
      if(!answer.selected.length&&!answer.custom){this.panel.querySelector('#request-error').textContent='Choose an option or write an answer to continue.';this.prompt.focus();return;}
      if(!this.finalQuestion){item.step++;this.render(true);return;}
    }
    await this.resolve(true);
  }
  async resolve(approved){
    const item=this.active;if(!item||item.sending)return;
    item.sending=true;this.changed();this.panel.querySelectorAll('button,input').forEach(el=>el.disabled=true);
    const answers=this.isQuestion?Object.fromEntries((item.event.input.questions||[]).map((q,i)=>{const a=item.answers[i]||{selected:[],custom:''};return[q.question,[...a.selected,a.custom].filter(Boolean).join('\n')];})):undefined;
    try{await this.decide({requestId:item.event.requestId,approved,answers});this.remove(item.event.requestId);}
    catch(error){item.sending=false;if(this.active===item){this.panel.querySelectorAll('button,input').forEach(el=>el.disabled=false);this.panel.querySelector('#request-error').textContent=error.message;this.changed();}}
  }
}

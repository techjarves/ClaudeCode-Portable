// Explicit, isolated UI-only fixture. Not part of the application or a live model.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
const fixture=mkdtempSync(join(tmpdir(),'portable-ui-fixture-'));
process.env.PORTABLE_AI_DATA_DIR=join(fixture,'data');
const {saveProfile}=await import('../lib/config.mjs');
const {SessionStore}=await import('../lib/sessions.mjs');
const {AgentManager}=await import('../lib/agent.mjs');
const {startDashboard}=await import('../dashboard/server.mjs');
const models=createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'ui-fixture-model'},{id:'ui-fixture-alternative'}]}));});
await new Promise(r=>models.listen(0,'127.0.0.1',r));
saveProfile({provider:'lmstudio',auth:'api',baseUrl:`http://127.0.0.1:${models.address().port}`,model:'ui-fixture-model',contextWindow:128000,key:''});
const store=new SessionStore();
const manager=new AgentManager(store,{sdkLoader:async()=>({query:({prompt,options})=>{
  const q=(async function*(){
    yield {type:'system',subtype:'init',session_id:'ui-fixture-session',model:'ui-fixture-model'};
    if(prompt.includes('waiting fixture'))await new Promise(resolve=>setTimeout(resolve,5000));
    if(prompt.includes('error fixture')){yield {type:'result',is_error:true,errors:['Intentional UI fixture error. No provider request was sent.']};return;}
    if(prompt.includes('timeline fixture')){
      yield {type:'assistant',message:{id:'timeline-intro',content:[{type:'text',text:'UI TEST FIXTURE — showing runtime events in their real sequence.'}]}};
      yield {type:'assistant',message:{id:'timeline-read',content:[{type:'tool_use',id:'read-fixture',name:'Read',input:{file_path:join(fixture,'package.json'),offset:1,limit:80}}]}};
      yield {type:'user',message:{content:[{type:'tool_result',tool_use_id:'read-fixture',content:'{\n  "name": "portable-ai-fixture"\n}'}]}};
      yield {type:'assistant',message:{id:'timeline-after-read',content:[{type:'thinking',thinking:'The model returned this readable thinking block after inspecting the file.'},{type:'text',text:'The package metadata is valid. I’ll run the focused test next.'}]}};
      yield {type:'assistant',message:{id:'timeline-bash',content:[{type:'tool_use',id:'bash-fixture',name:'Bash',input:{command:'npm test -- --test-name-pattern=timeline',description:'Run focused timeline test'}}]}};
      yield {type:'user',message:{content:[{type:'tool_result',tool_use_id:'bash-fixture',content:'1 test passed\n0 tests failed'}]}};
      yield {type:'assistant',message:{id:'timeline-finish',content:[{type:'text',text:'The focused check passed.'}]}};
      yield {type:'result',is_error:false,session_id:'ui-fixture-session',usage:{input_tokens:42000,output_tokens:250}};return;
    }
    if(prompt.includes('question fixture')){
      const input={questions:[{question:'What would you like to improve first?',header:'Focus',multiSelect:false,options:[{label:'The conversation',description:'Make reading and replying feel more natural.'},{label:'The activity view',description:'Bring clarity to tools, progress, and results.'},{label:'The overall layout',description:'Refine spacing and navigation across the studio.'}]},{question:'Which details matter most?',header:'Details',multiSelect:true,options:[{label:'Keyboard access',description:'Keep every action reachable without a mouse.'},{label:'Mobile layout',description:'Keep the composer comfortable on a small screen.'},{label:'Clear feedback',description:'Show exactly what the agent needs from you.'}]}]};
      yield {type:'assistant',message:{id:'fixture-question',content:[{type:'text',text:'UI TEST FIXTURE — no live model. A couple of quick choices will help me focus the work.'},{type:'tool_use',id:'question-tool',name:'AskUserQuestion',input}]}};
      const answer=await options.canUseTool('AskUserQuestion',input,{signal:options.abortController.signal,toolUseID:'question-tool'});
      yield {type:'user',message:{content:[{type:'tool_result',tool_use_id:'question-tool',content:JSON.stringify(answer.updatedInput?.answers||answer.behavior)}]}};
      yield {type:'assistant',message:{id:'fixture-answer',content:[{type:'text',text:'Fixture received: '+JSON.stringify(answer.updatedInput?.answers||answer.behavior)}]}};
      yield {type:'result',is_error:false,session_id:'ui-fixture-session'};return;
    }
    const text='UI TEST FIXTURE — no live model or file operations.\n\n## Review the proposed change\n\n```js\nconst status = "ready";\nconsole.log(status);\n'+ '// '+ 'long-code-segment-'.repeat(30)+'\n```\n\n<script>document.body.textContent="unsafe"</script><img src="x" onerror="alert(1)">\n\nThis text tests Markdown sanitization.';
    yield {type:'stream_event',event:{delta:{type:'text_delta',text}}};yield {type:'assistant',message:{id:'fixture-message',content:[{type:'text',text}]}};
    const id='fixture-tool';const input={file_path:join(fixture,'example.js'),content:'console.log("fixture");\n'};
    yield {type:'assistant',message:{id:'fixture-message',content:[{type:'tool_use',id,name:'Write',input}]}};
    const answer=await options.canUseTool('Write',input,{signal:options.abortController.signal,toolUseID:id});
    yield {type:'user',message:{content:[{type:'tool_result',tool_use_id:id,is_error:answer.behavior!=='allow',content:'UI fixture only. Decision: '+answer.behavior+'\n'+Array.from({length:80},(_,i)=>`Output line ${i+1}`).join('\n')}]}};
    yield {type:'result',is_error:false,session_id:'ui-fixture-session'};
  })();q.interrupt=async()=>{};q.close=()=>{};return q;
}})});
const app=await startDashboard({port:3001,store,manager,workspacePicker:async()=>fixture});console.log(`UI TEST FIXTURE ONLY: ${app.url}\nFixture workspace: ${fixture}`);
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await app.close();models.closeAllConnections();await new Promise(r=>models.close(r));rmSync(fixture,{recursive:true,force:true});process.exit(0);});

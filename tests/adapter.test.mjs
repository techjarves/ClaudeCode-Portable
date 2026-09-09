import test from 'node:test';
import assert from 'node:assert/strict';
import { translateRequest, translateResponse, translateStream, startAdapter } from '../lib/adapter.mjs';
import { sseData } from '../lib/http.mjs';

const input={model:'ignored',system:[{type:'text',text:'Keep every instruction.'}],max_tokens:100,messages:[{role:'user',content:'Hello'}]};
test('preserves system prompt, model, text, tool schemas, choices and tool results',()=>{
  const req=translateRequest({...input,tools:[{name:'Read',description:'Read file',input_schema:{type:'object'}}],tool_choice:{type:'any',disable_parallel_tool_use:true},messages:[...input.messages,{role:'assistant',content:[{type:'text',text:'Reading'},{type:'tool_use',id:'a',name:'Read',input:{file_path:'a.txt'}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'a',content:[{type:'text',text:'file data'}]}]}]},'chosen-model');
  assert.equal(req.model,'chosen-model');assert.equal(req.messages[0].content,'Keep every instruction.');assert.equal(req.messages.at(-1).role,'tool');assert.equal(req.messages.at(-1).tool_call_id,'a');assert.equal(req.messages[2].tool_calls[0].function.arguments,'{"file_path":"a.txt"}');assert.equal(req.tool_choice,'required');assert.equal(req.parallel_tool_calls,false);
});
test('rejects unsupported thinking, content, tools and roles',()=>{
  assert.throws(()=>translateRequest({...input,thinking:{type:'enabled'}},'m'),/thinking/);
  assert.throws(()=>translateRequest({...input,messages:[{role:'user',content:[{type:'document'}]}]},'m'),/Unsupported/);
  assert.throws(()=>translateRequest({...input,tools:[{type:'web_search_20250305'}]},'m'),/Server tool/);
  assert.throws(()=>translateRequest({...input,messages:[{role:'invalid',content:'x'}]},'m'),/role/);
  assert.equal(translateRequest({...input,messages:[{role:'system',content:'Keep runtime reminder'}]},'m').messages[1].content,'Keep runtime reminder');
});
test('translates image blocks and error tool results without removing them',()=>{
  const image={type:'image',source:{type:'base64',media_type:'image/png',data:'AAAA'}};
  const req=translateRequest({...input,messages:[{role:'user',content:[image]}]},'m');
  assert.equal(req.messages[1].content[0].image_url.url,'data:image/png;base64,AAAA');
  const toolImage=translateRequest({...input,messages:[{role:'assistant',content:[{type:'tool_use',id:'read-1',name:'Read',input:{}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'read-1',content:[image]}]}]},'m');
  assert.equal(toolImage.messages.at(-2).role,'tool');assert.equal(toolImage.messages.at(-1).content[1].image_url.url,'data:image/png;base64,AAAA');
});
test('preserves Gemini thought signatures across tool-call history',async()=>{
  const metadata={google:{thought_signature:'opaque-signature'}},remembered=new Map();
  const body=translateResponse({choices:[{message:{tool_calls:[{id:'call-1',extra_content:metadata,function:{name:'Read',arguments:'{}'}}]},finish_reason:'tool_calls'}]},'gemini',{onToolCall:(id,value)=>remembered.set(id,value)});
  assert.equal(body.content[0].id,'call-1');
  const next=translateRequest({...input,messages:[{role:'assistant',content:[{type:'tool_use',id:'call-1',name:'Read',input:{}}]}]},'gemini',{toolMetadata:remembered});
  assert.deepEqual(next.messages.at(-1).tool_calls[0].extra_content,metadata);
  const streamed=[];await translateStream(chunks([{choices:[{delta:{tool_calls:[{index:0,id:'call-2',extra_content:metadata,function:{name:'Bash',arguments:'{}'}}]},finish_reason:'tool_calls'}]},'[DONE]']),'gemini',()=>{},{onToolCall:(id,value)=>streamed.push([id,value])});
  assert.deepEqual(streamed,[['call-2',metadata]]);
});
test('non-streaming responses preserve tool calls, usage and stop reasons',()=>{
  const body=translateResponse({id:'x',choices:[{message:{content:'Now',tool_calls:[{id:'a',function:{name:'Write',arguments:'{"a":1}'}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:12,completion_tokens:4}},'m');
  assert.deepEqual(body.content[1].input,{a:1});assert.equal(body.stop_reason,'tool_use');assert.equal(body.usage.input_tokens,12);
  assert.throws(()=>translateResponse({choices:[{message:{content:'',tool_calls:[{function:{arguments:'bad'}}]}}]},'m'));
});
function chunks(frames){const bytes=new TextEncoder().encode(frames.map(x=>`data: ${typeof x==='string'?x:JSON.stringify(x)}\r\n\r\n`).join(''));return new ReadableStream({start(c){for(let n=0;n<bytes.length;n+=7)c.enqueue(bytes.slice(n,n+7));c.close();}});}
test('streaming handles fragmented UTF-8 and multiple fragmented tool calls',async()=>{
  const frames=[{choices:[{delta:{content:'hello ✓'}}]},{choices:[{delta:{tool_calls:[{index:0,id:'a',function:{name:'Read',arguments:'{"file'}},{index:1,id:'b',function:{name:'Write',arguments:'{"x":'}}]}}]},{choices:[{delta:{tool_calls:[{index:0,function:{arguments:'":"a"}'}},{index:1,function:{arguments:'2}'}}]},finish_reason:'tool_calls'}]},{choices:[],usage:{prompt_tokens:10,completion_tokens:20}},'[DONE]'];
  const events=[];await translateStream(chunks(frames),'m',(name,data)=>events.push(data));
  assert.equal(events[0].type,'message_start');assert.equal(events.at(-1).type,'message_stop');assert.equal(events.filter(e=>e.type==='content_block_start').length,3);
  assert.equal(events.find(e=>e.delta?.text)?.delta.text,'hello ✓');assert.equal(events.find(e=>e.type==='message_delta').usage.output_tokens,20);
});
test('incomplete stream and malformed tool JSON fail clearly',async()=>{
  await assert.rejects(translateStream(chunks([{choices:[{delta:{content:'x'}}]}]),'m',()=>{}),/completion marker/);
  await assert.rejects(translateStream(chunks([{choices:[{delta:{tool_calls:[{index:0,id:'a',function:{name:'X',arguments:'bad'}}]},finish_reason:'tool_calls'}]}]),'m',()=>{}));
});
test('adapter authenticates, exposes estimated token counts, maps upstream errors',async t=>{
  let status=429;
  const app=await startAdapter({baseUrl:'http://example.test/v1',model:'m',key:'private-key'},{fetchImpl:async()=>new Response('{}',{status})});t.after(()=>app.close());
  assert.equal((await fetch(`${app.url}/v1/messages`,{method:'POST',body:'{}'})).status,401);
  const headers={Authorization:`Bearer ${app.token}`,'Content-Type':'application/json'};
  const count=await fetch(`${app.url}/v1/messages/count_tokens`,{method:'POST',headers,body:JSON.stringify(input)});assert.equal(count.headers.get('x-portable-ai-token-count'),'estimate');assert.equal((await count.json()).estimated,true);
  for(const expected of [429,401,403,500]){status=expected;const res=await fetch(`${app.url}/v1/messages`,{method:'POST',headers,body:JSON.stringify(input)});assert.equal(res.status,expected);assert.doesNotMatch(await res.text(),/private-key/);}
});
test('adapter cancellation propagates to the upstream request',async t=>{
  let upstreamSignal;let requested;const ready=new Promise(r=>requested=r);
  const app=await startAdapter({baseUrl:'http://example.test/v1',model:'m'}, {fetchImpl:async(url,options)=>{upstreamSignal=options.signal;requested();return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));}});t.after(()=>app.close());
  const controller=new AbortController();const request=fetch(`${app.url}/v1/messages`,{method:'POST',headers:{Authorization:`Bearer ${app.token}`},body:JSON.stringify(input),signal:controller.signal}).catch(()=>{});
  await ready;controller.abort();await request;
  await new Promise(resolve=>upstreamSignal.aborted?resolve():upstreamSignal.addEventListener('abort',resolve,{once:true}));assert.equal(upstreamSignal.aborted,true);
});
test('adapter reports the sanitized upstream error immediately',async t=>{
  let reported;
  const app=await startAdapter({baseUrl:'http://example.test/v1',model:'m',key:'private-key'},{fetchImpl:async()=>new Response(JSON.stringify({error:{message:'Rejected private-key for this model'}}),{status:400}),onError:message=>{reported=message;}});t.after(()=>app.close());
  const res=await fetch(`${app.url}/v1/messages`,{method:'POST',headers:{Authorization:`Bearer ${app.token}`,'Content-Type':'application/json'},body:JSON.stringify(input)});
  assert.equal(res.status,400);assert.match(reported,/HTTP 400.*Rejected.*\[REDACTED\]/);assert.doesNotMatch(reported,/private-key/);
});
test('adapter preserves a plain-text upstream error body',async t=>{
  let reported;const app=await startAdapter({baseUrl:'http://example.test/v1',model:'m'},{fetchImpl:async()=>new Response('model context length exceeded',{status:413}),onError:value=>{reported=value;}});t.after(()=>app.close());
  await fetch(`${app.url}/v1/messages`,{method:'POST',headers:{Authorization:`Bearer ${app.token}`,'Content-Type':'application/json'},body:JSON.stringify(input)});assert.match(reported,/HTTP 413.*context length exceeded/);
});

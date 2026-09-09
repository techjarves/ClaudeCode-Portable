import test from 'node:test';
import assert from 'node:assert/strict';
import { toResponsesRequest, fromResponsesResponse, translateResponsesStream, startResponsesAdapter } from '../lib/responses-adapter.mjs';

const input = { model: 'ignored', max_tokens: 100, stream: true, system: 'Be concise.', messages: [{ role: 'user', content: 'Hello' }], tools: [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }] };
const streamBody=frames=>new ReadableStream({start(controller){for(const frame of frames)controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`));controller.close();}});

test('Responses adapter maps prompts, tools, results, output, and usage', () => {
  const request = toResponsesRequest({ ...input, messages: [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'Read', input: { path: 'a.txt' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'contents' }] }
  ] }, 'target-model');
  assert.equal(request.model, 'target-model');
  assert.equal(request.max_output_tokens, 100);
  assert.deepEqual(request.input.find(item => item.type === 'function_call'), { type: 'function_call', call_id: 'call_1', name: 'Read', arguments: '{"path":"a.txt"}' });
  assert.deepEqual(request.input.find(item => item.type === 'function_call_output'), { type: 'function_call_output', call_id: 'call_1', output: 'contents' });
  assert.equal(request.tools[0].name, 'Read');
  const response = fromResponsesResponse({ id: 'resp_1', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Done' }] }, { type: 'function_call', call_id: 'call_2', name: 'Write', arguments: '{"ok":true}' }], usage: { input_tokens: 12, output_tokens: 4 } }, 'target-model');
  assert.equal(response.content[0].text, 'Done');
  assert.deepEqual(response.content[1].input, { ok: true });
  assert.equal(response.stop_reason, 'tool_use');
  assert.deepEqual(response.usage, { input_tokens: 12, output_tokens: 4 });
});

test('Responses adapter forwards images returned by local tools',()=>{
  const request=toResponsesRequest({...input,messages:[
    {role:'assistant',content:[{type:'tool_use',id:'read-image',name:'Read',input:{path:'screen.png'}}]},
    {role:'user',content:[{type:'tool_result',tool_use_id:'read-image',content:[{type:'image',source:{type:'base64',media_type:'image/jpeg',data:'AAAA'}}]}]}
  ]},'vision-model');
  assert.equal(request.input.find(item=>item.type==='function_call_output').call_id,'read-image');
  assert.equal(request.input.find(item=>item.role==='user').content.find(part=>part.type==='input_image').image_url,'data:image/jpeg;base64,AAAA');
});

test('Responses adapter calls /responses with required headers and returns Anthropic SSE', async t => {
  let seen;
  const app = await startResponsesAdapter({ baseUrl: 'https://example.test/v1', model: 'm', key: 'secret' }, { fetchImpl: async (url, options) => {
    seen = { url, options };
    return new Response(streamBody([{type:'response.created',response:{id:'resp_1'}},{type:'response.output_text.delta',item_id:'msg_1',output_index:1,content_index:0,delta:'Hel'},{type:'response.output_text.delta',item_id:'msg_1',output_index:1,content_index:0,delta:'lo'},{type:'response.output_text.done',item_id:'msg_1',output_index:1,content_index:0,text:'Hello'},{type:'response.completed',response:{id:'resp_1',status:'completed',usage:{input_tokens:15,output_tokens:406}}}]), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  } });
  t.after(() => app.close());
  assert.equal((await fetch(`${app.url}/v1/messages`, { method: 'POST', body: '{}' })).status, 401);
  const response = await fetch(`${app.url}/v1/messages`, { method: 'POST', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  assert.equal(response.status, 200);
  assert.equal(seen.url, 'https://example.test/v1/responses');
  assert.equal(seen.options.headers.Authorization, 'Bearer secret');
  assert.equal(seen.options.headers['User-Agent'], 'opencode/1.18.20');
  assert.match(seen.options.headers['x-session-id'], /^session-/);
  assert.equal(JSON.parse(seen.options.body).stream,true);
  const events = await response.text();
  assert.match(events, /message_start/);
  assert.match(events, /"text":"Hel"/);assert.match(events,/"text":"lo"/);
  assert.match(events, /message_stop/);
});

test('Responses streaming forwards text and tool argument deltas incrementally',async()=>{
  const upstream=streamBody([{type:'response.created',response:{id:'resp_2'}},{type:'response.output_item.added',output_index:0,item:{id:'fc_1',call_id:'call_1',type:'function_call',name:'Read',arguments:''}},{type:'response.function_call_arguments.delta',item_id:'fc_1',output_index:0,delta:'{"pa'},{type:'response.function_call_arguments.delta',item_id:'fc_1',output_index:0,delta:'th":"a"}'},{type:'response.function_call_arguments.done',item_id:'fc_1',output_index:0,name:'Read',arguments:'{"path":"a"}'},{type:'response.completed',response:{status:'completed',usage:{input_tokens:9,output_tokens:3}}}]);
  const events=[];await translateResponsesStream(upstream,'m',(name,data)=>events.push({name,data}));
  assert.deepEqual(events.filter(event=>event.data.delta?.type==='input_json_delta').map(event=>event.data.delta.partial_json),['{"pa','th":"a"}']);
  assert.equal(events.find(event=>event.name==='content_block_start').data.content_block.name,'Read');
  assert.equal(events.find(event=>event.name==='message_delta').data.delta.stop_reason,'tool_use');
  assert.equal(events.at(-1).name,'message_stop');
});

test('Responses adapter reports upstream errors without waiting', async t => {
  let reported;
  const app=await startResponsesAdapter({baseUrl:'https://example.test/v1',model:'m',key:'secret'},{fetchImpl:async()=>new Response(JSON.stringify({error:{message:'Bad secret'}}),{status:422}),onError:message=>{reported=message;}});t.after(()=>app.close());
  const response=await fetch(`${app.url}/v1/messages`,{method:'POST',headers:{Authorization:`Bearer ${app.token}`,'Content-Type':'application/json'},body:JSON.stringify(input)});
  assert.equal(response.status,422);assert.match(reported,/HTTP 422.*Bad \[REDACTED\]/);assert.doesNotMatch(reported,/secret/);
});

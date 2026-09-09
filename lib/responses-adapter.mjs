import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { readBody, json, sseData } from './http.mjs';
import { translateRequest, translateResponse } from './adapter.mjs';

function responseContent(content, role) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => {
    if (part.type === 'text') return { type: role === 'assistant' ? 'output_text' : 'input_text', text: part.text };
    if (part.type === 'image_url' && role === 'user') return { type: 'input_image', image_url: part.image_url.url };
    throw new Error(`Unsupported Responses API content: ${part.type}`);
  });
}

export function toResponsesRequest(body, model) {
  const chat = translateRequest(body, model);
  const input = [];
  for (const message of chat.messages) {
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: message.content });
      continue;
    }
    if (message.content !== null && message.content !== '') input.push({ role: message.role, content: responseContent(message.content, message.role) });
    for (const call of message.tool_calls || []) input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
  }
  const request = { model: chat.model, input };
  if (chat.max_tokens) request.max_output_tokens = chat.max_tokens;
  if (chat.temperature !== undefined) request.temperature = chat.temperature;
  if (chat.top_p !== undefined) request.top_p = chat.top_p;
  if (chat.tools) request.tools = chat.tools.map(tool => ({ type: 'function', name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters }));
  if (chat.tool_choice !== undefined) request.tool_choice = typeof chat.tool_choice === 'object' ? { type: 'function', name: chat.tool_choice.function.name } : chat.tool_choice;
  if (chat.parallel_tool_calls !== undefined) request.parallel_tool_calls = chat.parallel_tool_calls;
  return request;
}

export function fromResponsesResponse(body, model) {
  if (body.error) throw new Error(body.error.message || 'Responses API returned an error');
  if (!['completed','incomplete'].includes(body.status)) throw new Error(body.status === 'failed' ? body.error?.message || 'Responses API request failed' : `Responses API returned status ${body.status || 'unknown'}`);
  const message = { content: '', tool_calls: [] };
  for (const item of body.output || []) {
    if (item.type === 'message') {
      for (const part of item.content || []) {
        if (part.type === 'output_text') message.content += part.text || '';
        else if (part.type === 'refusal') message.refusal = part.refusal || 'Request refused';
      }
    } else if (item.type === 'function_call') {
      message.tool_calls.push({ id: item.call_id || item.id, type: 'function', function: { name: item.name, arguments: item.arguments || '{}' } });
    }
  }
  const finish = message.tool_calls.length ? 'tool_calls' : body.status === 'incomplete' ? 'length' : 'stop';
  return translateResponse({ id: body.id, choices: [{ message, finish_reason: finish }], usage: { prompt_tokens: body.usage?.input_tokens || 0, completion_tokens: body.usage?.output_tokens || 0 } }, model);
}

export async function translateResponsesStream(body, model, send) {
  let started=false,nextIndex=0,hasTool=false;const blocks=new Map();
  const startMessage=id=>{if(started)return;started=true;send('message_start',{type:'message_start',message:{id:id||`msg_${randomUUID()}`,type:'message',role:'assistant',model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:0,output_tokens:0}}});};
  const startText=(key,id)=>{let block=blocks.get(key);if(block)return block;startMessage();block={type:'text',index:nextIndex++,id,text:'',open:true};blocks.set(key,block);send('content_block_start',{type:'content_block_start',index:block.index,content_block:{type:'text',text:''}});return block;};
  const startTool=(key,item={})=>{let block=blocks.get(key);if(block)return block;startMessage();hasTool=true;block={type:'tool',index:nextIndex++,id:item.call_id||item.id||key,name:item.name||'',args:'',open:true};blocks.set(key,block);send('content_block_start',{type:'content_block_start',index:block.index,content_block:{type:'tool_use',id:block.id,name:block.name,input:{}}});return block;};
  const stop=block=>{if(block?.open){block.open=false;send('content_block_stop',{type:'content_block_stop',index:block.index});}};
  for await(const data of sseData(body)){
    if(data==='[DONE]')break;
    const event=JSON.parse(data),type=event.type;
    if(type==='error')throw new Error(event.message||event.error?.message||'Responses API streaming error');
    if(type==='response.created'){startMessage(event.response?.id);continue;}
    if(type==='response.output_item.added'&&event.item?.type==='function_call'){startTool(event.item.id||String(event.output_index),event.item);continue;}
    if(type==='response.output_text.delta'){
      const block=startText(`${event.item_id||event.output_index}:${event.content_index||0}`,event.item_id);block.text+=event.delta||'';
      if(event.delta)send('content_block_delta',{type:'content_block_delta',index:block.index,delta:{type:'text_delta',text:event.delta}});
      continue;
    }
    if(type==='response.output_text.done'){
      const block=startText(`${event.item_id||event.output_index}:${event.content_index||0}`,event.item_id);
      if(!block.text&&event.text){block.text=event.text;send('content_block_delta',{type:'content_block_delta',index:block.index,delta:{type:'text_delta',text:event.text}});}stop(block);continue;
    }
    if(type==='response.function_call_arguments.delta'){
      const block=startTool(event.item_id||String(event.output_index),{id:event.item_id,name:event.name});block.args+=event.delta||'';
      if(event.delta)send('content_block_delta',{type:'content_block_delta',index:block.index,delta:{type:'input_json_delta',partial_json:event.delta}});
      continue;
    }
    if(type==='response.function_call_arguments.done'){
      const block=startTool(event.item_id||String(event.output_index),{id:event.item_id,name:event.name});
      if(!block.args&&event.arguments){block.args=event.arguments;send('content_block_delta',{type:'content_block_delta',index:block.index,delta:{type:'input_json_delta',partial_json:event.arguments}});}JSON.parse(block.args||'{}');stop(block);continue;
    }
    if(type==='response.output_item.done'&&event.item?.type==='function_call'){
      const block=startTool(event.item.id||String(event.output_index),event.item);if(!block.args&&event.item.arguments){block.args=event.item.arguments;send('content_block_delta',{type:'content_block_delta',index:block.index,delta:{type:'input_json_delta',partial_json:event.item.arguments}});}JSON.parse(block.args||'{}');stop(block);continue;
    }
    if(type==='response.refusal.delta'||type==='response.refusal.done')throw new Error(event.delta||event.refusal||'Provider refused the request');
    if(['response.completed','response.incomplete','response.failed'].includes(type)){
      if(type==='response.failed'||event.response?.status==='failed')throw new Error(event.response?.error?.message||'Responses API request failed');
      startMessage(event.response?.id);for(const block of blocks.values())stop(block);
      const usage=event.response?.usage||{},incomplete=type==='response.incomplete'||event.response?.status==='incomplete';
      send('message_delta',{type:'message_delta',delta:{stop_reason:hasTool?'tool_use':incomplete?'max_tokens':'end_turn',stop_sequence:null},usage:{input_tokens:usage.input_tokens||0,output_tokens:usage.output_tokens||0}});
      send('message_stop',{type:'message_stop'});return;
    }
  }
  throw new Error('Responses API stream ended without a completion event');
}

async function upstreamError(response, key) {
  let detail='';
  try { const text=await response.text();try{const body=JSON.parse(text);detail=body?.error?.message||body?.message||body?.detail||text;}catch{detail=text;} } catch {}
  if(key&&detail)detail=String(detail).split(key).join('[REDACTED]');
  return `Responses API returned HTTP ${response.status}${detail?`: ${String(detail).slice(0,500)}`:''}`;
}

export async function startResponsesAdapter(profile, { fetchImpl = fetch, onError = () => {} } = {}) {
  const token = randomBytes(32).toString('hex');
  const sessionId = `session-${randomUUID()}`;
  const controllers = new Set();
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}` && req.headers['x-api-key'] !== token) return json(res, 401, { error: { type: 'authentication_error', message: 'Invalid local adapter token' } });
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (req.method !== 'POST' || !['/v1/messages','/v1/messages/count_tokens'].includes(pathname)) return json(res, 404, { error: { type: 'not_found_error', message: 'Unsupported adapter endpoint' } });
    const controller = new AbortController(); controllers.add(controller);
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    let streaming = false;
    try {
      const body = await readBody(req,20*1024*1024);
      if (pathname.endsWith('/count_tokens')) {
        const count = Math.ceil(JSON.stringify({ system: body.system, messages: body.messages, tools: body.tools }).length / 3);
        res.setHeader('X-Portable-AI-Token-Count', 'estimate');
        return json(res, 200, { input_tokens: count, estimated: true });
      }
      const request=toResponsesRequest(body, profile.model);if(body.stream)request.stream=true;
      const upstream = await fetchImpl(`${profile.baseUrl.replace(/\/+$/,'')}/responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'opencode/1.18.20', 'x-session-id': sessionId, ...(profile.key ? { Authorization: `Bearer ${profile.key}` } : {}) },
        body: JSON.stringify(request), redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180000)])
      });
      if (!upstream.ok) { const message=await upstreamError(upstream,profile.key);onError(message);return json(res, upstream.status, { type: 'error', error: { type: [401,403].includes(upstream.status) ? 'authentication_error' : upstream.status === 429 ? 'rate_limit_error' : 'api_error', message } }); }
      if(body.stream){streaming=true;res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','X-Accel-Buffering':'no'});res.flushHeaders?.();const send=(event,value)=>res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);await translateResponsesStream(upstream.body,profile.model,send);res.end();}
      else json(res, 200, fromResponsesResponse(await upstream.json(), profile.model));
    } catch (error) {
      let message = error.message;
      if (profile.key) message = message.split(profile.key).join('[REDACTED]');
      if(!controller.signal.aborted)onError(message);
      const value = { type: 'error', error: { type: 'invalid_request_error', message } };
      if (streaming) res.end(`event: error\ndata: ${JSON.stringify(value)}\n\n`); else if (!res.destroyed) json(res, error.status || 400, value);
    } finally { controllers.delete(controller); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { token, url: `http://127.0.0.1:${server.address().port}`, close: async () => { controllers.forEach(c => c.abort()); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

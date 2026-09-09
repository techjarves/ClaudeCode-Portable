import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { readBody, json, sseData } from './http.mjs';

function textContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) throw new Error('Unsupported message content');
  return content.map(b => { if (b.type !== 'text') throw new Error(`Unsupported content: ${b.type}`); return b.text; }).join('\n');
}
function imageContent(block) {
  const source=block?.source;
  if(source?.type!=='base64'||!/^image\/(png|jpeg|gif|webp)$/.test(source.media_type))throw new Error('Only base64 PNG/JPEG/GIF/WebP images are supported');
  return {type:'image_url',image_url:{url:`data:${source.media_type};base64,${source.data}`}};
}
function toolResultContent(block) {
  if(typeof block.content==='string')return {text:block.content,images:[]};
  if(!Array.isArray(block.content))return {text:'',images:[]};
  const text=[],images=[];
  for(const part of block.content){if(part.type==='text')text.push(part.text);else if(part.type==='image')images.push(imageContent(part));else throw new Error(`Unsupported content: ${part.type}`);}
  return {text:text.join('\n'),images};
}
export function translateRequest(body, model, {toolMetadata}={}) {
  if (!Array.isArray(body.messages)) throw new Error('messages must be an array');
  if (body.thinking && body.thinking.type !== 'disabled') throw new Error('Extended thinking is unavailable through the Chat Completions adapter. Disable thinking for this provider.');
  const messages = [];
  if (body.system) messages.push({ role: 'system', content: textContent(body.system) });
  for (const message of body.messages) {
    // Newer Claude Code releases also place runtime reminders in system-role messages.
    if (message.role === 'system') { messages.push({ role: 'system', content: textContent(message.content) }); continue; }
    if (!['user','assistant'].includes(message.role)) throw new Error(`Unsupported message role: ${String(message.role)}`);
    if (typeof message.content === 'string') { messages.push({ role: message.role, content: message.content }); continue; }
    const content = []; const calls = []; const results = [];
    for (const b of message.content || []) {
      if (b.type === 'text') content.push({ type: 'text', text: b.text });
      else if (b.type === 'image' && message.role === 'user') {
        content.push(imageContent(b));
      } else if (b.type === 'tool_use' && message.role === 'assistant') {
        const call={id:b.id,type:'function',function:{name:b.name,arguments:JSON.stringify(b.input)}};const metadata=toolMetadata?.get(b.id);if(metadata)call.extra_content=metadata;calls.push(call);
      } else if (b.type === 'tool_result' && message.role === 'user') {
        const converted=toolResultContent(b),label=converted.images.length?'Image content was returned by this tool.':'';
        results.push({role:'tool',tool_call_id:b.tool_use_id,content:(b.is_error?'Tool error: ':'')+(converted.text||label)});
        if(converted.images.length)content.push({type:'text',text:`Image returned by tool call ${b.tool_use_id}.`},...converted.images);
      }
      else throw new Error(`Unsupported content block: ${b.type}. Choose a compatible model or disable this feature.`);
    }
    messages.push(...results);
    if (content.length || calls.length) messages.push({ role: message.role, content: content.length ? content.every(b=>b.type==='text') ? content.map(b=>b.text).join('\n') : content : null, ...(calls.length ? { tool_calls: calls } : {}) });
  }
  const request = { model, messages, stream: !!body.stream };
  if (body.max_tokens) request.max_tokens = body.max_tokens;
  if (body.temperature !== undefined) request.temperature = body.temperature;
  if (body.top_p !== undefined) request.top_p = body.top_p;
  if (body.stop_sequences?.length) request.stop = body.stop_sequences;
  if (body.tools?.length) request.tools = body.tools.map(t => {
    if (t.type && t.type !== 'custom') throw new Error(`Server tool ${t.type} is unsupported by this provider`);
    return { type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } };
  });
  if (body.tool_choice) {
    const c = body.tool_choice;
    request.tool_choice = c.type === 'tool' ? { type: 'function', function: { name: c.name } } : c.type === 'any' ? 'required' : c.type;
    if (!['auto','none','any','tool'].includes(c.type)) throw new Error('Unsupported tool choice');
    if (c.disable_parallel_tool_use) request.parallel_tool_calls = false;
  }
  if (request.stream) request.stream_options = { include_usage: true };
  return request;
}
const stopReason = reason => reason === 'tool_calls' || reason === 'function_call' ? 'tool_use' : reason === 'length' ? 'max_tokens' : 'end_turn';
function usage(value = {}) { return { input_tokens: value.prompt_tokens || 0, output_tokens: value.completion_tokens || 0 }; }
export function translateResponse(body, model, {onToolCall=()=>{}}={}) {
  const choice = body.choices?.[0];
  if (!choice) throw new Error('Provider returned no completion');
  if (choice.finish_reason === 'content_filter' || choice.message?.refusal) throw new Error('Provider refused the request');
  const content = [];
  if (choice.message?.content) content.push({ type: 'text', text: choice.message.content });
  for (const call of choice.message?.tool_calls || []) {onToolCall(call.id,call.extra_content);content.push({ type: 'tool_use', id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) });}
  return { id: body.id || `msg_${randomUUID()}`, type: 'message', role: 'assistant', model, content, stop_reason: stopReason(choice.finish_reason), stop_sequence: null, usage: usage(body.usage) };
}

export async function translateStream(body, model, send, {onToolCall=()=>{}}={}) {
  send('message_start', { type: 'message_start', message: { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: usage() } });
  let next = 0, textIndex = null, finish = null, counts = usage(); const calls = new Map();
  for await (const data of sseData(body)) {
    if (data === '[DONE]') break;
    const chunk = JSON.parse(data);
    if (chunk.error) throw new Error(chunk.error.message || 'Provider streaming error');
    if (chunk.usage) counts = usage(chunk.usage);
    const choice = chunk.choices?.[0]; if (!choice) continue;
    if (choice.finish_reason) finish = choice.finish_reason;
    const delta = choice.delta || {};
    if (delta.refusal || finish === 'content_filter') throw new Error('Provider refused the request');
    if (delta.content) {
      if (textIndex === null) { textIndex = next++; send('content_block_start', { type: 'content_block_start', index: textIndex, content_block: { type: 'text', text: '' } }); }
      send('content_block_delta', { type: 'content_block_delta', index: textIndex, delta: { type: 'text_delta', text: delta.content } });
    }
    for (const t of delta.tool_calls || []) {
      let call = calls.get(t.index);
      if (!call) { call = { id: '', name: '', args: '', extraContent:null }; calls.set(t.index, call); }
      call.id ||= t.id || ''; call.name += t.function?.name || ''; call.args += t.function?.arguments || '';if(t.extra_content)call.extraContent=t.extra_content;
    }
  }
  if (!finish) throw new Error('Provider stream ended without a completion marker');
  if(textIndex!==null)send('content_block_stop',{type:'content_block_stop',index:textIndex});
  // Tool arguments can arrive as arbitrarily fragmented JSON. Emit only validated objects.
  for (const call of calls.values()) {
    call.index=next++;
    if (!call.id || !call.name) throw new Error('Provider returned an incomplete tool call');
    JSON.parse(call.args || '{}');
    onToolCall(call.id,call.extraContent);
    send('content_block_start', { type: 'content_block_start', index: call.index, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } });
    send('content_block_delta', { type: 'content_block_delta', index: call.index, delta: { type: 'input_json_delta', partial_json: call.args || '{}' } });
    send('content_block_stop',{type:'content_block_stop',index:call.index});
  }
  send('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason(finish), stop_sequence: null }, usage: counts });
  send('message_stop', { type: 'message_stop' });
}

async function upstreamError(response, label, key) {
  let detail='';
  try { const text=await response.text();try{const body=JSON.parse(text);detail=body?.error?.message||body?.message||body?.detail||text;}catch{detail=text;} } catch {}
  if(key&&detail)detail=String(detail).split(key).join('[REDACTED]');
  return `${label} returned HTTP ${response.status}${detail?`: ${String(detail).slice(0,500)}`:''}`;
}

export async function startAdapter(profile, { fetchImpl = fetch, onError = () => {} } = {}) {
  const token = randomBytes(32).toString('hex'); const controllers = new Set(),toolMetadata=new Map();
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}` && req.headers['x-api-key'] !== token) return json(res, 401, { error: { type: 'authentication_error', message: 'Invalid local adapter token' } });
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (req.method !== 'POST' || !['/v1/messages','/v1/messages/count_tokens'].includes(pathname)) return json(res, 404, { error: { type: 'not_found_error', message: 'Unsupported adapter endpoint' } });
    const controller = new AbortController(); controllers.add(controller);
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    let streaming = false;
    const send = (event, value) => res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
    try {
      const body = await readBody(req,20*1024*1024);
      if (pathname.endsWith('/count_tokens')) {
        const count = Math.ceil(JSON.stringify({ system: body.system, messages: body.messages, tools: body.tools }).length / 3);
        res.setHeader('X-Portable-AI-Token-Count', 'estimate');
        return json(res, 200, { input_tokens: count, estimated: true });
      }
      const remember=(id,metadata)=>{if(id&&metadata)toolMetadata.set(id,metadata);};
      const request = translateRequest(body, profile.model,{toolMetadata});
      const upstream = await fetchImpl(`${profile.baseUrl.replace(/\/+$/,'')}/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(profile.key ? { Authorization: `Bearer ${profile.key}` } : {}) }, body: JSON.stringify(request), redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180000)])
      });
      if (!upstream.ok) {
        const status = upstream.status, message = await upstreamError(upstream, 'Provider', profile.key);onError(message);
        return json(res, status, { type: 'error', error: { type: status === 429 ? 'rate_limit_error' : status === 401 || status === 403 ? 'authentication_error' : 'api_error', message } });
      }
      if (body.stream) {
        streaming = true; res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
        await translateStream(upstream.body, profile.model, send,{onToolCall:remember}); res.end();
      } else json(res, 200, translateResponse(await upstream.json(), profile.model,{onToolCall:remember}));
    } catch (error) {
      let message = error.message;
      if (profile.key) message = message.split(profile.key).join('[REDACTED]');
      if(!controller.signal.aborted)onError(message);
      const value = { type: 'error', error: { type: 'invalid_request_error', message } };
      if (streaming) { send('error', value); res.end(); } else if (!res.destroyed) json(res, error.status || 400, value);
    } finally { controllers.delete(controller); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { token, url: `http://127.0.0.1:${server.address().port}`, close: async () => { controllers.forEach(c => c.abort()); server.closeAllConnections(); await new Promise(r => server.close(r)); } };
}

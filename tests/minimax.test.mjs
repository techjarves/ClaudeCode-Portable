import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const temp=mkdtempSync(join(tmpdir(),'portable-minimax-'));
process.env.PORTABLE_AI_DATA_DIR=join(temp,'data');
const { PROVIDERS, discoverModels, providerEnvironment }=await import('../lib/providers.mjs');
const { saveProfile, readConfig }=await import('../lib/config.mjs');
const { startAdapter }=await import('../lib/adapter.mjs');
const { startResponsesAdapter }=await import('../lib/responses-adapter.mjs');
const { AgentManager }=await import('../lib/agent.mjs');
const { SessionStore }=await import('../lib/sessions.mjs');
test.after(()=>rmSync(temp,{recursive:true,force:true}));
const flash='MiniMax-M3.1-Flash', m3='MiniMax-M3';
const completion=()=>new Response(JSON.stringify({choices:[{message:{content:'Fixture reply'},finish_reason:'stop'}]}),{headers:{'Content-Type':'application/json'}});
const image={type:'image',source:{type:'base64',media_type:'image/png',data:'AAAA'}};
const input={messages:[{role:'user',content:[{type:'text',text:'Describe'},image]}],max_tokens:100};

test('MiniMax catalog projects current choices in both regions without changing saved or custom IDs',async t=>{
  assert.equal(PROVIDERS.minimax.defaultModel,flash);
  assert.deepEqual(PROVIDERS.minimax.models.map(m=>[m.id,m.contextWindow]),[[flash,1000000],[m3,1000000]]);
  const upstream=[{id:'MiniMax-M2.5'},{id:m3},{id:flash},{id:'speech-2.8-hd'},{id:'custom-model'}];
  const original=structuredClone(upstream),requests=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{requests.push({url,options});return new Response(JSON.stringify({data:upstream}));});
  for(const endpoint of PROVIDERS.minimax.endpoints){
    const profile={provider:'minimax',baseUrl:endpoint.baseUrl,key:'fixture-key',model:'MiniMax-M2.5',auth:'api'};
    saveProfile(profile);
    assert.deepEqual(await discoverModels(profile),PROVIDERS.minimax.models);
    assert.equal(requests.at(-1).url,`${endpoint.baseUrl}/models`);
    assert.equal(requests.at(-1).options.headers.Authorization,'Bearer fixture-key');
    assert.equal(readConfig().profiles.minimax.model,'MiniMax-M2.5');
  }
  assert.deepEqual(upstream,original);
  assert.deepEqual((await discoverModels({provider:'custom',baseUrl:'https://custom.example/v1'})).map(m=>m.id),upstream.map(m=>m.id));
  saveProfile({provider:'minimax',baseUrl:PROVIDERS.minimax.baseUrl,model:'my-private-alias',auth:'api',key:'fixture-key'});
  assert.equal(readConfig().profiles.minimax.model,'my-private-alias');
});

test('real local HTTP adapter serializes MiniMax defaults, efforts, images and tool history for both regions',async t=>{
  for(const endpoint of PROVIDERS.minimax.endpoints)for(const model of [flash,m3,'MiniMax-M2.5','my-private-alias']){
    const profile={provider:'minimax',baseUrl:endpoint.baseUrl,model,key:'fixture-key'};
    let captured;
    const app=await startAdapter(profile,{fetchImpl:async(url,options)=>{captured={url,options,body:JSON.parse(options.body)};return completion();}});
    try{
      const send=body=>fetch(`${app.url}/v1/messages`,{method:'POST',headers:{Authorization:`Bearer ${app.token}`},body:JSON.stringify(body)});
      const history={...input,messages:[...input.messages,{role:'assistant',content:[{type:'tool_use',id:'call-1',name:'Read',input:{file_path:'saved.txt'}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'call-1',content:'saved history'}]}]};
      const response=await send(history);assert.equal(response.status,200);assert.equal((await response.json()).model,model);
      assert.equal(captured.url,`${endpoint.baseUrl}/chat/completions`);
      assert.equal(captured.options.headers.Authorization,'Bearer fixture-key');assert.equal(captured.body.model,model);
      assert.equal(captured.body.messages[0].content[1].image_url.url,'data:image/png;base64,AAAA');
      assert.equal(captured.body.messages.at(-1).content,'saved history');assert.equal(captured.body.messages.at(-1).tool_call_id,'call-1');
      assert.equal(captured.body.messages[1].tool_calls[0].function.arguments,'{"file_path":"saved.txt"}');
      assert.equal(captured.body.service_tier,undefined);assert.equal(captured.body.reasoning_split,undefined);
      if(model===flash){
        assert.deepEqual(captured.body.thinking,{type:'adaptive'});assert.equal(captured.body.reasoning_effort,'max');
        for(const effort of ['low','medium','high','xhigh','max']){
          assert.equal((await send({...input,thinking:{type:'adaptive'},output_config:{effort}})).status,200);
          assert.equal(captured.body.reasoning_effort,effort);assert.equal(captured.body.output_config,undefined);
        }
        for(const invalid of [{thinking:{type:'disabled'}},{reasoning_effort:'none'},{service_tier:'priority'},{reasoning_split:false}]){
          captured=null;assert.equal((await send({...input,...invalid})).status,400);assert.equal(captured,null);
        }
      }else if(model===m3){
        assert.deepEqual(captured.body.thinking,{type:'adaptive'});assert.equal(captured.body.reasoning_effort,undefined);
        assert.equal((await send({...input,thinking:{type:'disabled'},output_config:{effort:'none'}})).status,200);
        assert.deepEqual(captured.body.thinking,{type:'disabled'});assert.equal(captured.body.reasoning_effort,undefined);
      }else{
        assert.equal(captured.body.thinking,undefined);assert.equal(captured.body.reasoning_effort,undefined);
      }
    }finally{await app.close();}
  }
});

test('MiniMax streaming requests retain the Chat Completions boundary and response events',async()=>{
  for(const endpoint of PROVIDERS.minimax.endpoints)for(const model of [flash,m3]){
    let wire;
    const app=await startAdapter({provider:'minimax',baseUrl:endpoint.baseUrl,model},{fetchImpl:async(_url,options)=>{
      wire=JSON.parse(options.body);
      const frames=[{choices:[{delta:{content:'Fixture stream'},finish_reason:null}]},{choices:[{delta:{},finish_reason:'stop'}]},'[DONE]'];
      return new Response(frames.map(frame=>`data: ${typeof frame==='string'?frame:JSON.stringify(frame)}\n\n`).join(''),{headers:{'Content-Type':'text/event-stream'}});
    }});
    try{
      const response=await fetch(`${app.url}/v1/messages`,{method:'POST',headers:{Authorization:`Bearer ${app.token}`},body:JSON.stringify({...input,stream:true})});
      assert.equal(response.status,200);const events=await response.text();assert.match(events,/Fixture stream/);assert.match(events,/message_stop/);
      assert.equal(wire.stream,true);assert.deepEqual(wire.stream_options,{include_usage:true});assert.equal(wire.model,model);assert.deepEqual(wire.thinking,{type:'adaptive'});
      assert.equal(wire.reasoning_effort,model===flash?'max':undefined);
    }finally{await app.close();}
  }
});

test('explicit Responses selection preserves full image and tool history without server-side state',async()=>{
  // This checks the existing adapter contract, not regional service availability.
  for(const model of [flash,m3,'MiniMax-M2.5']){
    let wire;
    const app=await startResponsesAdapter({provider:'minimax',baseUrl:PROVIDERS.minimax.baseUrl,model},{fetchImpl:async(url,options)=>{
      assert.equal(url,'https://api.minimax.io/v1/responses');wire=JSON.parse(options.body);
      return new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'Fixture response'}]}]}));
    }});
    try{
      const messages=[...input.messages,{role:'assistant',content:[{type:'tool_use',id:'saved-call',name:'Read',input:{}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'saved-call',content:'saved history'}]}];
      const response=await fetch(`${app.url}/v1/messages`,{method:'POST',headers:{Authorization:`Bearer ${app.token}`},body:JSON.stringify({...input,messages,thinking:{type:'disabled'}})});
      assert.equal(response.status,200);assert.equal(wire.model,model);assert.equal(wire.input[0].content[1].type,'input_image');
      assert.equal(wire.input.at(-1).output,'saved history');assert.equal(wire.input.at(-1).call_id,'saved-call');
      for(const field of ['previous_response_id','store','conversation','service_tier','reasoning'])assert.equal(wire[field],undefined);
    }finally{await app.close();}
  }
});

test('non-MiniMax provider with the same model name retains generic request semantics',async()=>{
  let request;
  const app=await startAdapter({provider:'custom',baseUrl:'https://custom.example/v1',model:flash},{fetchImpl:async(_url,options)=>{request=JSON.parse(options.body);return completion();}});
  try{
    const response=await fetch(`${app.url}/v1/messages`,{method:'POST',headers:{Authorization:`Bearer ${app.token}`},body:JSON.stringify({...input,thinking:{type:'disabled'},output_config:{effort:'low'}})});
    assert.equal(response.status,200);assert.equal(request.model,flash);assert.equal(request.thinking,undefined);assert.equal(request.reasoning_effort,undefined);
  }finally{await app.close();}
});

test('SDK bridge passes current defaults through its real adapter and preserves legacy/custom configuration',async t=>{
  const realFetch=globalThis.fetch,requests=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    if(String(url).startsWith('http://127.0.0.1:'))return realFetch(url,options);
    assert.ok(PROVIDERS.minimax.endpoints.some(e=>url===`${e.baseUrl}/chat/completions`));
    requests.push(JSON.parse(options.body));return completion();
  });
  for(const baseUrl of PROVIDERS.minimax.endpoints.map(e=>e.baseUrl))for(const model of [flash,m3,'MiniMax-M2.5','my-private-alias']){
    saveProfile({provider:'minimax',baseUrl,model,auth:'api',key:'fixture-key',adapter:'builtin'});
    const profile=readConfig().profiles.minimax,store=new SessionStore(join(temp,`sessions-${requests.length}`));
    const session=store.create({workspace:temp,profile,trusted:true});let observed;
    const manager=new AgentManager(store,{executable:()=>'/fixture/claude',sdkLoader:async()=>({query:({options})=>(async function*(){
      observed=options;
      const response=await fetch(`${options.env.ANTHROPIC_BASE_URL}/v1/messages`,{method:'POST',headers:{Authorization:`Bearer ${options.env.ANTHROPIC_AUTH_TOKEN}`},body:JSON.stringify({...input,thinking:options.thinking,...(options.effort?{output_config:{effort:options.effort}}:{})})});
      assert.equal(response.status,200);yield {type:'result',is_error:false};
    })()})});
    await(await manager.start(session.id,'Fixture request')).promise;
    assert.equal(store.get(session.id).status,'completed');assert.equal(observed.model,model);
    assert.equal(observed.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,model);assert.equal(requests.at(-1).model,model);
    assert.equal(readConfig().profiles.minimax.model,model);
    if([flash,m3].includes(model)){assert.deepEqual(observed.thinking,{type:'adaptive'});assert.equal(observed.effort,model===flash?'max':undefined);}
    else{assert.deepEqual(observed.thinking,{type:'disabled'});assert.equal(observed.effort,'low');}
  }
  const custom={provider:'custom',model:'saved-custom',auth:'api',adapter:'external',modelAliases:{opus:'legacy-opus',sonnet:'legacy-sonnet',haiku:'legacy-haiku'}};
  const env=providerEnvironment(custom,{adapter:{url:'http://127.0.0.1:1',token:'fixture'},parent:{}});
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL,'legacy-opus');assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL,'legacy-sonnet');assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL,'legacy-haiku');
});

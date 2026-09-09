import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DATA } from './paths.mjs';

export const PROVIDERS = {
  anthropic: { name: 'Anthropic', short: 'AN', description: 'Claude models · API or terminal login', transport: 'anthropic', baseUrl: 'https://api.anthropic.com', defaultModel: 'sonnet' },
  openrouter: { name: 'OpenRouter', short: 'OR', description: 'A unified model marketplace', transport: 'anthropic', baseUrl: 'https://openrouter.ai/api', modelsUrl: 'https://openrouter.ai/api/v1/models' },
  deepseek: { name: 'DeepSeek', short: 'DS', description: 'Direct Anthropic-compatible API', transport: 'anthropic', baseUrl: 'https://api.deepseek.com/anthropic', modelsUrl: 'https://api.deepseek.com/models' },
  nvidia: { name: 'NVIDIA NIM', short: 'NV', description: 'Cloud inference · local adapter', transport: 'openai', baseUrl: 'https://integrate.api.nvidia.com/v1' },
  gemini: { name: 'Google Gemini', short: 'GE', description: 'Google AI · local adapter', transport: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  openai: { name: 'OpenAI', short: 'OA', description: 'Chat Completions · local adapter', transport: 'openai', baseUrl: 'https://api.openai.com/v1' },
  ollama: { name: 'Ollama', short: 'OL', description: 'Local models · offline inference', transport: 'anthropic', baseUrl: 'http://127.0.0.1:11434', local: true },
  lmstudio: { name: 'LM Studio', short: 'LM', description: 'Your local model server', transport: 'anthropic', baseUrl: 'http://127.0.0.1:1234', local: true },
  custom: { name: 'Custom API', short: '</>', description: 'Any compatible Chat Completions API', transport: 'openai', baseUrl: 'http://127.0.0.1:8080/v1', local: true }
};

export const ADAPTER_CHOICES = ['builtin', 'external', 'responses'];

function tierModel(profile, tier) {
  // Opus/sonnet/haiku aliases only apply to the external adapter, which maps
  // Claude tiers to upstream models. The built-in adapter always sends one model.
  if (profile.adapter !== 'external') return profile.model;
  const alias = profile.modelAliases?.[tier];
  return typeof alias === 'string' && alias.trim() ? alias.trim() : profile.model;
}

export function providerEnvironment(profile, { adapter, dashboard = false, parent = process.env } = {}) {
  const env = { ...parent };
  // Do not allow ambient credentials or old OpenClaude switches to choose a different backend.
  for (const k of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDE_CONFIG_DIR$|OPENAI_|GEMINI_|GOOGLE_API_KEY$|OPENROUTER_|DEEPSEEK_|NVIDIA_|AWS_|AZURE_)/.test(k)) delete env[k];
  const directory = join(DATA, 'claude', `${profile.provider}-${profile.auth}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  Object.assign(env, { CLAUDE_CONFIG_DIR: directory, XDG_CACHE_HOME: join(DATA, 'cache'), DISABLE_AUTOUPDATER: '1', DISABLE_UPDATES: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' });
  if (profile.auth === 'login') {
    if (dashboard) throw new Error('Account login is terminal-only. Configure an API key for the dashboard.');
    if (profile.provider !== 'anthropic' || profile.baseUrl !== PROVIDERS.anthropic.baseUrl) throw new Error('Subscription credentials cannot be used with another endpoint');
    return env;
  }
  const p = PROVIDERS[profile.provider];
  if (!p) throw new Error('Unknown provider');
  if (p.transport === 'openai' && !adapter) throw new Error('Provider adapter is not running');
  env.ANTHROPIC_BASE_URL = adapter?.url || profile.baseUrl;
  if (profile.provider === 'anthropic') env.ANTHROPIC_API_KEY = profile.key;
  else { env.ANTHROPIC_AUTH_TOKEN = adapter?.token || profile.key || profile.provider; env.ANTHROPIC_API_KEY = ''; }
  Object.assign(env, { ANTHROPIC_MODEL: profile.model, ANTHROPIC_DEFAULT_OPUS_MODEL: tierModel(profile, 'opus'), ANTHROPIC_DEFAULT_SONNET_MODEL: tierModel(profile, 'sonnet'), ANTHROPIC_DEFAULT_HAIKU_MODEL: tierModel(profile, 'haiku'), ANTHROPIC_SMALL_FAST_MODEL: tierModel(profile, 'haiku'), CLAUDE_CODE_SUBAGENT_MODEL: tierModel(profile, 'sonnet') });
  if (profile.provider !== 'anthropic') env.CLAUDE_CODE_ATTRIBUTION_HEADER = '0';
  return env;
}

function providerURL(profile) {
  const p=PROVIDERS[profile.provider];if(!p)throw new Error('Unknown provider');
  const base=profile.baseUrl||p.baseUrl;
  return profile.provider==='ollama'?`${base}/api/tags`:p.modelsUrl&&base===p.baseUrl?p.modelsUrl:`${base}${p.transport==='anthropic'&&['anthropic','lmstudio'].includes(profile.provider)?'/v1':''}/models`;
}
function providerHeaders(profile) {
  return profile.provider==='anthropic'?{'x-api-key':profile.key||'','anthropic-version':'2023-06-01'}:profile.key?{Authorization:`Bearer ${profile.key}`} : {};
}

export async function discoverModels(profile, signal) {
  const p = PROVIDERS[profile.provider];
  if (!p) throw new Error('Unknown provider');
  const res = await fetch(providerURL(profile), { headers:providerHeaders(profile), signal:signal||AbortSignal.timeout(15000), redirect:'error' });
  if (!res.ok) throw new Error(`Model discovery returned HTTP ${res.status}. Check the endpoint/credential or enter a model manually.`);
  const body = await res.json();
  return (body.data || body.models || []).map(m => {
    const raw=m.context_length??m.context_window??m.max_context_length??m.max_input_tokens??m.inputTokenLimit;
    const contextWindow=Number(raw);
    return { id:m.id||m.name,name:m.display_name||m.displayName||m.name||m.id,...(Number.isSafeInteger(contextWindow)&&contextWindow>0?{contextWindow}:{}) };
  }).filter(m => m.id);
}

export async function testConnection(profile,{fetcher=fetch,signal}={}) {
  const p=PROVIDERS[profile.provider];if(!p)throw new Error('Unknown provider');
  const base=profile.baseUrl||p.baseUrl;
  const responses=profile.adapter==='responses';
  const url=responses?`${base.replace(/\/+$/,'')}/responses`:profile.provider==='openrouter'&&base===p.baseUrl?`${base}/v1/auth/key`:providerURL(profile);
  let res;
  try{res=await fetcher(url,{method:responses?'POST':'GET',headers:{...providerHeaders(profile),...(responses?{'Content-Type':'application/json','User-Agent':'opencode/1.18.20','x-session-id':`session-${randomUUID()}`}:{})},...(responses?{body:JSON.stringify({model:profile.model,input:[{role:'user',content:[{type:'input_text',text:'Reply OK.'}]}]})}:{}),signal:signal||AbortSignal.timeout(15000),redirect:'error'});}catch(error){
    if(error.name==='TimeoutError')throw new Error('Connection timed out after 15 seconds. Check the endpoint and network.');
    throw new Error(`Could not reach the endpoint: ${error.message}`);
  }
  if(!res.ok){
    let detail='';try{const body=await res.json();detail=body?.error?.message||body?.message||body?.detail||'';}catch{}
    if(profile.key&&detail)detail=String(detail).split(profile.key).join('[REDACTED]');
    const reason=res.status===401||res.status===403?'The API credential was rejected.':'The endpoint returned an error.';
    throw new Error(`${reason} HTTP ${res.status}${detail?`: ${String(detail).slice(0,300)}`:''}`);
  }
  return {ok:true,message:profile.key?'Connection successful. The endpoint and API credential are valid.':'Connection successful. The endpoint is reachable.'};
}

import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DATA, PORTABLE_HOME, PORTABLE_XDG_CONFIG, PORTABLE_XDG_DATA, PORTABLE_APP_DATA, PORTABLE_LOCAL_APP_DATA, PORTABLE_CACHE } from './paths.mjs';
import { gitEnvironment } from './git.mjs';

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

// Claude Code only ships a catalogue of Anthropic model IDs. For any other ID it
// warns "Model ... isn't recognized", assumes a 200K window and exposes reduced
// capabilities. Both problems have documented, binary-free fixes:
// https://code.claude.com/docs/en/model-config#correct-the-window-for-a-gateway-or-custom-model-id
// https://code.claude.com/docs/en/settings-reference#fields-for-modelpicker
// Bump this when a newer native-1M model ships in the bundled runtime.
const BEHAVES_AS = 'claude-sonnet-5-5';

// A behavesAs row makes Claude Code treat the ID as a known model, which also
// replaces the window with that model's own. Only map when the window declared
// in the dashboard is the mapped model's native 1M window; otherwise rely on
// CLAUDE_CODE_MAX_CONTEXT_TOKENS so the declared value stays authoritative.
function behavesAsFor(profile) {
  if (profile.provider === 'anthropic') return null;
  if (!profile.model) return null;
  return Number(profile.contextWindow) >= 1000000 ? BEHAVES_AS : null;
}

export function profileSettings(profile) {
  const behavesAs = behavesAsFor(profile);
  return behavesAs ? { modelPicker: { options: [{ model: profile.model, behavesAs }] } } : null;
}

// Claude Code reads modelPicker from the user settings file of the profile's
// CLAUDE_CONFIG_DIR. Merge, never replace: Claude Code stores its own keys there.
function syncProfileSettings(profile, directory) {
  const wanted = profileSettings(profile);
  if (!wanted) return;
  const file = join(directory, 'settings.json');
  let current = {};
  try { if (existsSync(file)) current = JSON.parse(readFileSync(file, 'utf8')); } catch { current = {}; }
  const next = { ...current, ...wanted };
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
}

// Redirects the host-specific locations Claude Code, npm and Git would write to.
// The dashboard server itself keeps the host environment; only the child process
// that runs the session receives this.
export function portableEnvironment() {
  const dirs = [PORTABLE_HOME, PORTABLE_XDG_CONFIG, PORTABLE_XDG_DATA, PORTABLE_LOCAL_APP_DATA, PORTABLE_CACHE];
  for (const dir of dirs) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return {
    HOME: PORTABLE_HOME,
    USERPROFILE: PORTABLE_HOME,
    XDG_CONFIG_HOME: PORTABLE_XDG_CONFIG,
    XDG_DATA_HOME: PORTABLE_XDG_DATA,
    XDG_CACHE_HOME: PORTABLE_CACHE,
    ...(process.platform === 'win32' ? { APPDATA: PORTABLE_APP_DATA, LOCALAPPDATA: PORTABLE_LOCAL_APP_DATA } : {}),
  };
}

export function providerEnvironment(profile, { adapter, dashboard = false, parent = process.env } = {}) {
  const env = { ...parent };
  // Do not allow ambient credentials or old OpenClaude switches to choose a different backend.
  for (const k of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDE_CONFIG_DIR$|OPENAI_|GEMINI_|GOOGLE_API_KEY$|OPENROUTER_|DEEPSEEK_|NVIDIA_|AWS_|AZURE_)/.test(k)) delete env[k];
  const directory = join(DATA, 'claude', `${profile.provider}-${profile.auth}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (profile.auth !== 'login') syncProfileSettings(profile, directory);
  Object.assign(env, { CLAUDE_CONFIG_DIR: directory, DISABLE_AUTOUPDATER: '1', DISABLE_UPDATES: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' });
  Object.assign(env, portableEnvironment());
  // Claude Code on Windows needs Git Bash for its shell tool. Prefer a system
  // Git for Windows and fall back to the bundled PortableGit.
  Object.assign(env, gitEnvironment({ env }));
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
  Object.assign(env, { ANTHROPIC_MODEL: profile.model, ANTHROPIC_DEFAULT_OPUS_MODEL: tierModel(profile, 'opus'), ANTHROPIC_DEFAULT_SONNET_MODEL: tierModel(profile, 'sonnet'), ANTHROPIC_DEFAULT_HAIKU_MODEL: tierModel(profile, 'haiku'), ANTHROPIC_SMALL_FAST_MODEL: tierModel(profile, 'haiku'), CLAUDE_CODE_SUBAGENT_MODEL: tierModel(profile, 'sonnet'),
    // Tell Claude Code the window declared in the dashboard for IDs it doesn't know.
    ...(profile.contextWindow ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(profile.contextWindow) } : {}) });
  if (profile.provider !== 'anthropic') env.CLAUDE_CODE_ATTRIBUTION_HEADER = '0';
  // Extended thinking cannot pass through the local adapters. MAX_THINKING_TOKENS=0
  // alone is not enough: when the modelPicker behavesAs mapping makes Claude Code
  // treat the custom ID as a thinking-capable Claude model, it sends adaptive
  // thinking anyway. CLAUDE_CODE_DISABLE_THINKING is honored in both cases.
  if (adapter) Object.assign(env, { CLAUDE_CODE_DISABLE_THINKING: '1', MAX_THINKING_TOKENS: '0' });
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

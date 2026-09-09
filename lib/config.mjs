import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, copyFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA, CONFIG } from './paths.mjs';
import { PROVIDERS } from './providers.mjs';

export function writeJSON(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, path);
  if (process.platform !== 'win32') chmodSync(path, 0o600);
}
export function parseLegacy(raw) {
  return Object.fromEntries(raw.split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('#') && l.includes('=')).map(l => {
    const n = l.indexOf('='); return [l.slice(0,n).trim(), l.slice(n+1).trim()];
  }));
}
export function migrateLegacy(env) {
  const url = env.OPENAI_BASE_URL || '';
  let provider = env.AI_PROVIDER;
  if (provider === 'openai') {
    provider = url.includes('openrouter.ai') ? 'openrouter' : url.includes('nvidia.com') ? 'nvidia' : url.includes('deepseek.com') ? 'deepseek' : url.includes(':1234') ? 'lmstudio' : url.includes('api.openai.com') || !url ? 'openai' : 'custom';
  }
  if (!PROVIDERS[provider]) return null;
  const p = PROVIDERS[provider];
  let baseUrl=env.ANTHROPIC_BASE_URL||url||p.baseUrl;
  if(provider==='openrouter'&&baseUrl==='https://openrouter.ai/api/v1')baseUrl=p.baseUrl;
  if(provider==='deepseek'&&/^https:\/\/api\.deepseek\.com(?:\/v1)?\/?$/.test(baseUrl))baseUrl=p.baseUrl;
  if(['lmstudio','ollama'].includes(provider))baseUrl=baseUrl.replace(/\/v1\/?$/,'');
  return { provider, auth: 'api', model: env.AI_DISPLAY_MODEL || env.OPENAI_MODEL || env.GEMINI_MODEL || env.OLLAMA_MODEL || '',
    baseUrl,
    key: env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY || env.GEMINI_API_KEY || '' };
}
export function readConfig() {
  mkdirSync(DATA, { recursive: true, mode: 0o700 });
  if (existsSync(CONFIG)) return JSON.parse(readFileSync(CONFIG, 'utf8'));
  const old = join(DATA, 'ai_settings.env');
  const config = { version: 2, active: null, profiles: {}, preferences: {} };
  if (existsSync(old)) {
    copyFileSync(old, `${old}.pre-claude-code.bak`);
    if (process.platform !== 'win32') chmodSync(`${old}.pre-claude-code.bak`, 0o600);
    const profile = migrateLegacy(parseLegacy(readFileSync(old, 'utf8')));
    if (profile) { config.active = profile.provider; config.profiles[profile.provider] = profile; }
    config.migrated = true;
    writeJSON(CONFIG, config);
  }
  return config;
}
export function saveProfile(input) {
  if (!PROVIDERS[input.provider]) throw new Error('Unknown provider');
  const config = readConfig();
  const old = config.profiles[input.provider] || {};
  const auth = input.provider === 'anthropic' && input.auth === 'login' ? 'login' : 'api';
  const model = String(input.model || '').trim();
  if (!model || model.length > 250 || /[\r\n\0]/.test(model)) throw new Error('Enter a valid model identifier');
  const rawContext=input.contextWindow===undefined?old.contextWindow:input.contextWindow;let contextWindow;
  if(rawContext!==undefined&&rawContext!==null&&String(rawContext).trim()!==''){contextWindow=Number(rawContext);if(!Number.isSafeInteger(contextWindow)||contextWindow<1024||contextWindow>100000000)throw new Error('Context window must be between 1,024 and 100,000,000 tokens');}
  let baseUrl = validateBaseURL(input.baseUrl || PROVIDERS[input.provider].baseUrl);
  if(input.provider==='openrouter'&&baseUrl==='https://openrouter.ai/api/v1')baseUrl=PROVIDERS.openrouter.baseUrl;
  if (auth === 'login' && baseUrl !== PROVIDERS.anthropic.baseUrl) throw new Error('Account login is only allowed with Anthropic');
  const key = input.key === undefined ? old.key || '' : String(input.key);
  if (/[\r\n\0]/.test(key)) throw new Error('Invalid credential');
  if (auth === 'api' && !PROVIDERS[input.provider].local && !key && input.provider !== 'custom') throw new Error('An API credential is required');
  const adapter = input.adapter === undefined ? old.adapter || 'builtin' : String(input.adapter);
  if (!['builtin', 'external', 'responses'].includes(adapter)) throw new Error('Unknown adapter choice');
  if (adapter !== 'builtin' && PROVIDERS[input.provider].transport !== 'openai') throw new Error('This adapter is only available for OpenAI-compatible providers');
  const toolFormat = input.toolFormat === undefined ? old.toolFormat || 'native' : String(input.toolFormat);
  if (!['native', 'xml'].includes(toolFormat)) throw new Error('Unknown tool format');
  const rawAliases = input.modelAliases === undefined ? old.modelAliases || {} : input.modelAliases || {};
  if (typeof rawAliases !== 'object' || Array.isArray(rawAliases)) throw new Error('Invalid model aliases');
  const modelAliases = {};
  for (const tier of ['opus', 'sonnet', 'haiku']) {
    if (rawAliases[tier] === undefined || rawAliases[tier] === null || String(rawAliases[tier]).trim() === '') continue;
    const alias = String(rawAliases[tier]).trim();
    if (alias.length > 250 || /[\r\n\0]/.test(alias)) throw new Error('Enter a valid model identifier');
    modelAliases[tier] = alias;
  }
  config.profiles[input.provider] = { provider: input.provider, auth, model, ...(contextWindow?{contextWindow}:{}), baseUrl, key: auth === 'login' ? '' : key, adapter, toolFormat, ...(Object.keys(modelAliases).length ? { modelAliases } : {}) };
  config.active = input.provider;
  writeJSON(CONFIG, config);
  return publicConfig(config);
}
export function activateProfile(provider) {
  if (!PROVIDERS[provider]) throw new Error('Unknown provider');
  const config = readConfig();
  const profile = config.profiles[provider];
  if (!profile) throw new Error('Configure this provider before selecting it');
  if (profile.auth === 'login') throw new Error('Account login profiles are terminal-only. Use an API credential in the dashboard.');
  config.active = provider;
  writeJSON(CONFIG, config);
  return publicConfig(config);
}
export function validateBaseURL(value) {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTP(S) base URL without credentials, query, or fragment');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Remote endpoints require HTTPS');
  return url.href.replace(/\/+$/, '');
}
export function publicConfig(config = readConfig()) {
  return { ...config, profiles: Object.fromEntries(Object.entries(config.profiles).map(([k,v]) => { const { key, ...safe } = v; return [k, { ...safe, hasKey: !!key }]; })) };
}
export function redact(value, config = readConfig()) {
  let text = String(value);
  for (const p of Object.values(config.profiles)) if (p.key) text = text.split(p.key).join('[REDACTED]');
  return text.replace(/(?:sk-ant-|sk-or-|sk-)[A-Za-z0-9_-]{12,}/g, '[REDACTED]');
}

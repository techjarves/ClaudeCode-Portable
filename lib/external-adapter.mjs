import { randomBytes } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RUNTIME } from './paths.mjs';

// Portable wrapper around the pinned `claude-adapter` engine dependency.
// Uses only its programmatic server factory: per-run token, loopback-only,
// ephemeral port. Never touches home-directory config, the standalone CLI,
// or Claude Code settings files. Those behaviors are intentionally excluded
// to preserve the USB-portable guarantee.
export const EXTERNAL_ADAPTER_PIN = '2.2.1';
export const ADAPTER_CHOICES = ['builtin', 'external', 'responses'];
export const TOOL_FORMATS = ['native', 'xml'];

function cleanModel(value, fallback) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return fallback;
  if (text.length > 250 || /[\r\n\0]/.test(text)) throw new Error('Enter a valid model identifier');
  return text;
}

export function resolveExternalModels(profile) {
  const fallback = String(profile.model || '').trim();
  if (!fallback) throw new Error('Configure a model before starting the external adapter');
  const aliases = profile.modelAliases || {};
  return {
    opus: cleanModel(aliases.opus, fallback),
    sonnet: cleanModel(aliases.sonnet, fallback),
    haiku: cleanModel(aliases.haiku, fallback)
  };
}

export function externalAdapterAvailable(directory = RUNTIME) {
  try {
    return !!createRequire(join(directory, 'package.json')).resolve('claude-adapter');
  } catch { return false; }
}

async function loadServerFactory(directory = RUNTIME) {
  let resolved;
  try {
    resolved = createRequire(join(directory, 'package.json')).resolve('claude-adapter');
  } catch {
    throw new Error('External adapter is not installed. Run start.sh install or START.bat install.');
  }
  const module = await import(pathToFileURL(resolved).href);
  if (typeof module.createServer !== 'function') throw new Error('External adapter package is invalid. Run install to repair the runtime.');
  return module.createServer;
}

function findEphemeralPort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function startOnPort(server, preferred) {
  try {
    return await server.start(preferred);
  } catch (error) {
    // A stale socket can claim the probed port between probe and bind.
    if (!/EADDRINUSE|already in use/i.test(error.message)) throw error;
    return server.start(await findEphemeralPort());
  }
}

export async function startExternalAdapter(profile, { directory = RUNTIME, factory, onError = () => {} } = {}) {
  if (!profile || typeof profile.baseUrl !== 'string' || !profile.baseUrl) throw new Error('Configure a provider before starting the external adapter');
  const createServer = factory || await loadServerFactory(directory);
  const token = randomBytes(32).toString('hex');
  const models = resolveExternalModels(profile);
  const server = createServer({
    baseUrl: profile.baseUrl,
    apiKey: profile.key || '',
    proxyAuthToken: token,
    models,
    toolFormat: profile.toolFormat === 'xml' ? 'xml' : 'native'
  });
  server.app?.addHook?.('onSend',(request,reply,payload,done)=>{
    if(reply.statusCode>=400&&new URL(request.url,'http://localhost').pathname==='/v1/messages'){
      let detail='';try{const text=String(payload);try{const body=JSON.parse(text);detail=body?.error?.message||body?.message||text;}catch{detail=text;}}catch{}
      if(profile.key&&detail)detail=String(detail).split(profile.key).join('[REDACTED]');
      onError(`Provider returned HTTP ${reply.statusCode}${detail?`: ${String(detail).slice(0,500)}`:''}`);
    }
    done();
  });
  let url;
  try {
    url = await startOnPort(server, await findEphemeralPort());
  } catch (error) {
    const message = profile.key ? String(error.message).split(profile.key).join('[REDACTED]') : error.message;
    throw new Error(`External adapter failed to start: ${message}`);
  }
  if (typeof url !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) {
    try { await server.stop(); } catch {}
    throw new Error('External adapter bound to an unexpected address');
  }
  return {
    token,
    url,
    models,
    close: async () => { try { await server.stop(); } catch {} }
  };
}

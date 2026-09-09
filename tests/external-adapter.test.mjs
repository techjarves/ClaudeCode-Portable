import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const temp = mkdtempSync(join(tmpdir(), 'portable-ai-external-')); process.env.PORTABLE_AI_DATA_DIR = join(temp, 'data');
test.after(() => rmSync(temp, { recursive: true, force: true }));
const { resolveExternalModels, externalAdapterAvailable, startExternalAdapter } = await import('../lib/external-adapter.mjs');
const { saveProfile, readConfig } = await import('../lib/config.mjs');
const { providerEnvironment, PROVIDERS } = await import('../lib/providers.mjs');

test('model alias resolution defaults to the main model', () => {
  assert.deepEqual(resolveExternalModels({ model: 'm' }), { opus: 'm', sonnet: 'm', haiku: 'm' });
  assert.deepEqual(resolveExternalModels({ model: 'm', modelAliases: { opus: 'big' } }), { opus: 'big', sonnet: 'm', haiku: 'm' });
  assert.throws(() => resolveExternalModels({ model: '' }), /model/);
  assert.throws(() => resolveExternalModels({ model: 'm', modelAliases: { sonnet: 'a\nb' } }), /valid model/);
});

test('profile validation accepts the external adapter only for Chat Completions providers', () => {
  saveProfile({ provider: 'custom', auth: 'api', baseUrl: 'http://127.0.0.1:8080/v1', model: 'ext-model', key: '', adapter: 'external', toolFormat: 'xml', modelAliases: { opus: 'big-one' } });
  const saved = readConfig().profiles.custom;
  assert.equal(saved.adapter, 'external'); assert.equal(saved.toolFormat, 'xml'); assert.deepEqual(saved.modelAliases, { opus: 'big-one' });
  assert.throws(() => saveProfile({ provider: 'ollama', auth: 'api', baseUrl: PROVIDERS.ollama.baseUrl, model: 'm', key: '', adapter: 'external' }), /only available/);
  assert.throws(() => saveProfile({ provider: 'custom', auth: 'api', baseUrl: 'http://127.0.0.1:8080/v1', model: 'm', key: '', adapter: 'other' }), /adapter/);
  assert.throws(() => saveProfile({ provider: 'custom', auth: 'api', baseUrl: 'http://127.0.0.1:8080/v1', model: 'm', key: '', toolFormat: 'yaml' }), /tool format/);
  saveProfile({ provider: 'custom', auth: 'api', baseUrl: 'http://127.0.0.1:8080/v1', model: 'ext-model', key: '' });
});

test('tier env vars use aliases for external, single model for built-in', () => {
  const parent = {};
  const external = providerEnvironment({ provider: 'custom', auth: 'api', baseUrl: 'http://127.0.0.1:8080/v1', model: 'main', key: 'k', adapter: 'external', modelAliases: { opus: 'big', haiku: 'small' } }, { adapter: { url: 'http://127.0.0.1:9', token: 't' }, parent });
  assert.equal(external.ANTHROPIC_DEFAULT_OPUS_MODEL, 'big');
  assert.equal(external.ANTHROPIC_DEFAULT_SONNET_MODEL, 'main');
  assert.equal(external.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'small');
  assert.equal(external.ANTHROPIC_SMALL_FAST_MODEL, 'small');
  const builtin = providerEnvironment({ provider: 'custom', auth: 'api', baseUrl: 'http://127.0.0.1:8080/v1', model: 'main', key: 'k', modelAliases: { opus: 'big' } }, { adapter: { url: 'http://127.0.0.1:9', token: 't' }, parent: {} });
  assert.equal(builtin.ANTHROPIC_DEFAULT_OPUS_MODEL, 'main');
});

test('missing engine dependency fails with a portable repair message', async () => {
  assert.equal(externalAdapterAvailable(join(temp, 'no-runtime-here')), false);
  await assert.rejects(startExternalAdapter({ provider: 'custom', model: 'm', baseUrl: 'http://127.0.0.1:1/v1', key: '' }, { directory: join(temp, 'no-runtime-here') }), /start.sh install|START.bat install/);
});

test('wrapper starts, authenticates over loopback, and closes with a stub factory', async () => {
  let seen;
  const factory = config => {
    seen = config;
    return {
      start: async port => `http://127.0.0.1:${port}`,
      stop: async () => {}
    };
  };
  const first = await startExternalAdapter({ provider: 'custom', model: 'm', baseUrl: 'http://127.0.0.1:1/v1', key: 'shh', toolFormat: 'xml', modelAliases: { opus: 'big' } }, { factory });
  const second = await startExternalAdapter({ provider: 'custom', model: 'm', baseUrl: 'http://127.0.0.1:1/v1', key: '' }, { factory });
  assert.match(first.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.notEqual(first.token, second.token);
  assert.equal(seen.toolFormat, 'native');
  assert.deepEqual(seen.models, { opus: 'm', sonnet: 'm', haiku: 'm' });
  assert.equal(typeof seen.proxyAuthToken, 'string');
  await first.close(); await second.close();
});

test('non-loopback bind is rejected', async () => {
  const lan = [0, 0, 0, 0].join('.');
  const factory = () => ({ start: async () => `http://${lan}:8082`, stop: async () => {} });
  await assert.rejects(startExternalAdapter({ provider: 'custom', model: 'm', baseUrl: 'http://127.0.0.1:1/v1', key: '' }, { factory }), /unexpected address/);
});

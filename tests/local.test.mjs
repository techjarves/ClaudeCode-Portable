import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const temp = mkdtempSync(join(tmpdir(), 'portable-local-tests-'));
process.env.PORTABLE_AI_DATA_DIR = join(temp, 'data');
const { resolveGitBash, gitEnvironment, bundledGitBash, hostGitConfigPath } = await import('../lib/git.mjs');
const { portableEnvironment, providerEnvironment } = await import('../lib/providers.mjs');
const { trimSystemPrompt, trimAnthropicBody, trimOpenAIBody, createProxyServer } = await import('../tools/local-proxy.mjs');
const { prepareLocalSession } = await import('../lib/local-session.mjs');

test.after(() => rmSync(temp, { recursive: true, force: true }));

// ── Git for Windows ────────────────────────────────────────────────

test('git detection prefers the explicit path, then the bundled copy, then the system', () => {
  const bundled = bundledGitBash();
  const paths = new Set([bundled, '/system/Git/bin/bash.exe']);
  const exists = path => paths.has(path);
  assert.equal(resolveGitBash({ exists, env: {}, platform: 'win32', findExecutable: () => '' }), bundled);
  assert.equal(resolveGitBash({ exists, env: { CLAUDE_CODE_GIT_BASH_PATH: '/system/Git/bin/bash.exe' }, platform: 'win32', findExecutable: () => '' }), '/system/Git/bin/bash.exe');
  // Nothing on disk: no crash, just null.
  assert.equal(resolveGitBash({ exists: () => false, env: {}, platform: 'win32', findExecutable: () => '' }), null);
  // Other platforms never need Git Bash.
  assert.equal(resolveGitBash({ exists, env: {}, platform: 'linux', findExecutable: () => '' }), null);
});

test('git detection derives bash from a system git.exe on PATH', () => {
  const gitExe = 'C:\\Tools\\Git\\ucrt64\\bin\\git.exe';
  const bash = 'C:\\Tools\\Git\\bin\\bash.exe';
  const found = resolveGitBash({
    exists: path => path === bash,
    env: {},
    platform: 'win32',
    findExecutable: () => `${gitExe}\r\n`,
  });
  assert.equal(found, bash);
});

test('git environment exposes the bash path and prepends Git directories', () => {
  const root = join(temp, 'git');
  const bash = join(root, 'bin', 'bash.exe');
  mkdirSync(dirname(bash), { recursive: true });
  writeFileSync(bash, '');
  mkdirSync(join(root, 'cmd'), { recursive: true });
  const env = gitEnvironment({ exists: path => path === bash || existsSync(path), env: { PATH: 'C:\\Windows', CLAUDE_CODE_GIT_BASH_PATH: bash }, platform: 'win32', findExecutable: () => '' });
  assert.equal(env.CLAUDE_CODE_GIT_BASH_PATH, bash);
  assert.match(env.PATH, /git[\\/]cmd/);
  assert.match(env.PATH, /C:\\Windows$/);
  // No Git: keep the runtime defaults.
  assert.deepEqual(gitEnvironment({ exists: () => false, env: {}, platform: 'win32', findExecutable: () => '' }), {});
});

// ── Host Git configuration ─────────────────────────────────────────

test('the host Git configuration survives the HOME redirect', () => {
  const home = join(temp, 'host-home');
  const config = join(home, '.gitconfig');
  mkdirSync(home, { recursive: true });
  writeFileSync(config, '[user]\n\tname = Host User\n');
  // Found through the real user profile.
  assert.equal(hostGitConfigPath({ env: { HOME: home } }), config);
  // An explicit GIT_CONFIG_GLOBAL wins when it exists.
  const explicit = join(temp, 'explicit-gitconfig');
  writeFileSync(explicit, '');
  assert.equal(hostGitConfigPath({ env: { HOME: home, GIT_CONFIG_GLOBAL: explicit } }), explicit);
  // A stale path is ignored and detection falls back to the profile.
  assert.equal(hostGitConfigPath({ env: { HOME: home, GIT_CONFIG_GLOBAL: join(temp, 'gone') } }), config);
  // No profile and no config: nothing to point at.
  assert.equal(hostGitConfigPath({ env: {}, exists: () => false }), null);
  assert.equal(hostGitConfigPath({ env: { HOME: join(temp, 'nobody') } }), null);
  // Opt-out keeps Git confined to the drive.
  assert.equal(hostGitConfigPath({ env: { HOME: home, PORTABLE_AI_NO_HOST_GIT_CONFIG: '1' } }), null);
});

test('a provider environment points GIT_CONFIG_GLOBAL at the host, not the portable home', () => {
  const home = join(temp, 'host-home-provider');
  const config = join(home, '.gitconfig');
  mkdirSync(home, { recursive: true });
  writeFileSync(config, '[user]\n\tname = Host User\n');
  // HOME is redirected by the portable environment, so detection must run on the
  // parent environment; otherwise it would look in data/home/.gitconfig.
  const env = providerEnvironment(
    { provider: 'deepseek', auth: 'api', model: 'm', baseUrl: 'https://api.deepseek.com/anthropic', key: 'k' },
    { parent: { HOME: home, PATH: 'C:\\Windows' } },
  );
  assert.equal(env.GIT_CONFIG_GLOBAL, config);
  assert.equal(env.HOME, join(temp, 'data', 'home'));
});

// ── Zero footprint ─────────────────────────────────────────────────

test('portable environment redirects host folders into data/', () => {
  const env = portableEnvironment();
  const data = join(temp, 'data');
  assert.equal(env.HOME, join(data, 'home'));
  assert.equal(env.USERPROFILE, join(data, 'home'));
  assert.equal(env.XDG_CONFIG_HOME, join(data, 'config'));
  assert.equal(env.XDG_DATA_HOME, join(data, 'app_data'));
  assert.equal(env.XDG_CACHE_HOME, join(data, 'cache'));
  if (process.platform === 'win32') {
    assert.equal(env.APPDATA, join(data, 'app_data'));
    assert.equal(env.LOCALAPPDATA, join(data, 'local_app_data'));
  }
  for (const dir of [env.HOME, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_CACHE_HOME]) assert.ok(existsSync(dir), dir);
});

test('a provider environment redirects host folders and keeps host credentials out', () => {
  const env = providerEnvironment(
    { provider: 'deepseek', auth: 'api', model: 'm', baseUrl: 'https://api.deepseek.com/anthropic', key: 'k' },
    { parent: { HOME: 'C:\\Users\\someone', APPDATA: 'C:\\Users\\someone\\AppData\\Roaming', ANTHROPIC_API_KEY: 'leak', PATH: 'C:\\Windows' } },
  );
  assert.equal(env.HOME, join(temp, 'data', 'home'));
  assert.notEqual(env.APPDATA, 'C:\\Users\\someone\\AppData\\Roaming');
  assert.notEqual(env.ANTHROPIC_API_KEY, 'leak');
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
});

// ── Speed proxy ────────────────────────────────────────────────────

const longPrompt = 'You are a coding agent. '.repeat(200);

test('the system prompt is trimmed to a sentence boundary, short prompts stay intact', () => {
  assert.equal(trimSystemPrompt('short prompt'), 'short prompt');
  const trimmed = trimSystemPrompt(longPrompt);
  assert.ok(trimmed.length < 1300, `expected a trimmed prompt, got ${trimmed.length}`);
  assert.match(trimmed, /System prompt truncated/);
  // Never cuts mid-word: the kept part ends with a period.
  assert.match(trimmed.split('\n')[0], /\.$/);
});

test('both protocols are trimmed without touching the conversation', () => {
  const anthropic = trimAnthropicBody({ system: longPrompt, messages: [{ role: 'user', content: 'hello' }] });
  assert.ok(anthropic.saved > 0);
  assert.deepEqual(anthropic.body.messages, [{ role: 'user', content: 'hello' }]);
  assert.match(anthropic.body.system, /truncated/);

  const blocks = trimAnthropicBody({ system: [{ type: 'text', text: longPrompt }], messages: [] });
  assert.match(blocks.body.system[0].text, /truncated/);

  const openai = trimOpenAIBody({ messages: [{ role: 'system', content: longPrompt }, { role: 'user', content: 'hi' }] });
  assert.ok(openai.saved > 0);
  assert.equal(openai.body.messages[1].content, 'hi');
  assert.match(openai.body.messages[0].content, /truncated/);

  // Bodies without a system prompt are returned untouched.
  const untouched = { messages: [{ role: 'user', content: 'hi' }] };
  assert.equal(trimAnthropicBody(untouched).saved, 0);
  assert.deepEqual(trimOpenAIBody({ messages: [{ role: 'user', content: 'hi' }] }).body.messages, untouched.messages);
});

test('the proxy forwards requests upstream after trimming and answers /health', async t => {
  const upstream = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ path: req.url, length: body.length, system: JSON.parse(body).system }));
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = createProxyServer({ upstreamPort: upstream.address().port });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => { proxy.close(); upstream.close(); });
  const base = `http://127.0.0.1:${proxy.address().port}`;

  const health = await fetch(`${base}/health`).then(r => r.json());
  assert.equal(health.ok, true);

  const payload = JSON.stringify({ system: longPrompt, messages: [{ role: 'user', content: 'hi' }] });
  const forwarded = await new Promise((resolve, reject) => {
    const req = httpRequest(`${base}/v1/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve(JSON.parse(body)));
    });
    req.on('error', reject);
    req.end(payload);
  });
  assert.equal(forwarded.path, '/v1/messages');
  assert.ok(forwarded.length < payload.length);
  assert.match(forwarded.system, /truncated/);
});

// ── Local session wiring ───────────────────────────────────────────

test('only Ollama gets the local stack; cleanup stops what we started', async () => {
  const calls = [];
  const maker = () => ({
    startServer: async () => { calls.push('server'); return { starting: true }; },
    startSpeedProxy: async () => { calls.push('proxy'); return { started: true, url: 'http://127.0.0.1:11435' }; },
    stopSpeedProxy: () => calls.push('stopProxy'),
    stopServer: () => calls.push('stopServer'),
    hasServer: () => true,
  });

  const cloud = await prepareLocalSession({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com/anthropic' }, maker());
  assert.deepEqual(calls, []);
  assert.deepEqual(cloud.notes, []);

  const local = await prepareLocalSession({ provider: 'ollama', baseUrl: 'http://127.0.0.1:11434' }, maker());
  assert.deepEqual(calls, ['server', 'proxy']);
  assert.equal(local.profile.baseUrl, 'http://127.0.0.1:11435');
  await local.cleanup();
  assert.deepEqual(calls, ['server', 'proxy', 'stopProxy', 'stopServer']);
});

test('an external server or a failed proxy never blocks the session', async () => {
  const profile = { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434' };
  const external = await prepareLocalSession(profile, {
    hasServer: () => false,
    startSpeedProxy: async () => { throw new Error('port busy'); },
  });
  assert.equal(external.profile, profile, 'no proxy means the original profile is used');
  assert.match(external.notes.join(' '), /not installed/);
  assert.match(external.notes.join(' '), /untrimmed/);
  await external.cleanup();

  const running = await prepareLocalSession(profile, {
    hasServer: () => true,
    startServer: async () => ({ alreadyRunning: true }),
    startSpeedProxy: async () => ({ alreadyRunning: true, url: 'http://127.0.0.1:11435' }),
  });
  assert.equal(running.profile.baseUrl, 'http://127.0.0.1:11435');
  const stops = [];
  const tracking = await prepareLocalSession(profile, {
    hasServer: () => true,
    startServer: async () => ({ alreadyRunning: true }),
    startSpeedProxy: async () => ({ alreadyRunning: true, url: 'http://127.0.0.1:11435' }),
    stopServer: () => stops.push('server'),
    stopSpeedProxy: () => stops.push('proxy'),
  });
  await tracking.cleanup();
  assert.deepEqual(stops, [], 'processes we did not start are left alone');
});

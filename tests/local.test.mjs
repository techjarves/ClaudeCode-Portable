import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const temp = mkdtempSync(join(tmpdir(), 'portable-local-tests-'));
process.env.PORTABLE_AI_DATA_DIR = join(temp, 'data');
const { resolveGitBash, gitEnvironment, bundledGitBash, hostGitConfigPath } = await import('../lib/git.mjs');
const { portableEnvironment, providerEnvironment } = await import('../lib/providers.mjs');
const { trimSystemPrompt, trimAnthropicBody, trimOpenAIBody, createProxyServer } = await import('../tools/local-proxy.mjs');
const { prepareLocalSession } = await import('../lib/local-session.mjs');
const { proxyStatus, ollamaUpstream, localStatus, waitForProxy, registerLocalConsumer, releaseLocalConsumer, startLocal, startProxy } = await import('../lib/local-models.mjs');
const { PLAYWRIGHT_BROWSERS_DIR } = await import('../lib/playwright.mjs');

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

// The candidate list is built with the host's path module because this is a
// Windows-only code path; the simulated win32 platform cannot be exercised on
// a POSIX host (dirname('C:\\x\\git.exe') is "." there).
test('git detection derives bash from a system git.exe on PATH', { skip: process.platform !== 'win32' && 'Windows path layout only' }, () => {
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

test('a session finds the portable Node on PATH even when resumed', () => {
  // RESUME.bat and resume.sh exec the portable Node without exporting its
  // directory, unlike bootstrap.ps1 and start.sh. Shell commands inside that
  // session could not find `node` on a host without a system installation.
  const nodeDirectory = dirname(process.execPath);
  const separator = process.platform === 'win32' ? ';' : ':';
  const profile = { provider: 'deepseek', auth: 'api', model: 'm', baseUrl: 'https://api.deepseek.com/anthropic', key: 'k' };

  const env = providerEnvironment(profile, { parent: { PATH: '/usr/bin', HOME: temp } });
  const entries = String(env.PATH).split(separator);
  assert.equal(entries[0], nodeDirectory, 'the running interpreter comes first');
  assert.ok(entries.includes('/usr/bin'), 'the original PATH is kept');
  assert.equal(entries.filter(entry => entry === nodeDirectory).length, 1);

  // Already present: no duplicate entry on every start.
  const again = providerEnvironment(profile, { parent: { PATH: [nodeDirectory, '/usr/bin'].join(separator), HOME: temp } });
  assert.equal(String(again.PATH).split(separator).filter(entry => entry === nodeDirectory).length, 1);
});

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

test('a provider environment points Playwright at the portable browsers when installed', () => {
  const env = providerEnvironment(
    { provider: 'deepseek', auth: 'api', model: 'm', baseUrl: 'https://api.deepseek.com/anthropic', key: 'k' },
    { parent: { PATH: 'C:\\Windows' } },
  );
  // Only set when the browsers actually exist, so a script is never pointed at an empty folder.
  if (existsSync(PLAYWRIGHT_BROWSERS_DIR)) assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, PLAYWRIGHT_BROWSERS_DIR);
  else assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, undefined);
});

test('a provider environment redirects host folders and keeps host credentials out', () => {
  const env = providerEnvironment(
    { provider: 'deepseek', auth: 'api', model: 'm', baseUrl: 'https://api.deepseek.com/anthropic', key: 'k' },
    { parent: { HOME: 'C:\\Users\\someone', APPDATA: 'C:\\Users\\someone\\AppData\\Roaming', ANTHROPIC_API_KEY: 'leak', PATH: 'C:\\Windows' } },
  );
  assert.equal(env.HOME, join(temp, 'data', 'home'));
  // APPDATA is Windows-only: redirected there, untouched elsewhere.
  if (process.platform === 'win32') assert.notEqual(env.APPDATA, 'C:\\Users\\someone\\AppData\\Roaming');
  else assert.equal(env.APPDATA, 'C:\\Users\\someone\\AppData\\Roaming');
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

test('an HTTPS upstream is reached over TLS, and /health reports it', async t => {
  // A remote Ollama may require HTTPS. Forwarding with node:http would send
  // plaintext to a TLS listener and every turn would fail.
  const { createServer: createTlsServer } = await import('node:https');
  // A throwaway self-signed certificate keeps the test hermetic. It proves the
  // transport (TLS, not plaintext), not the trust store.
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, readFileSync: readFile } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const certDir = mkdtempSync(join(tmpdir(), 'portable-tls-'));
  let key, cert;
  try {
    const keyFile = join(certDir, 'key.pem'), certFile = join(certDir, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '1', '-subj', '/CN=127.0.0.1'], { stdio: 'pipe' });
    key = readFile(keyFile, 'utf8');
    cert = readFile(certFile, 'utf8');
  } catch {
    t.skip('openssl not available');
    return;
  }
  t.after(() => rmSync(certDir, { recursive: true, force: true }));
  const upstream = createTlsServer({ key, cert }, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tls: true, path: req.url }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = createProxyServer({ upstreamPort: upstream.address().port, upstreamSecure: true });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => { proxy.close(); upstream.close(); });
  const base = `http://127.0.0.1:${proxy.address().port}`;

  const health = await (await fetch(`${base}/health`)).json();
  assert.match(health.upstream, /^https:/, 'health must advertise the TLS scheme');

  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    const res = await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ system: 'x', messages: [] }) });
    const body = await res.json();
    assert.equal(body.tls, true, 'the upstream was reached over TLS');
  } finally {
    if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
  }
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
  // The pid identifies the listener, which is how a launch decides whether the
  // proxy answering on the port is the child it spawned or the winner of a race.
  assert.equal(health.pid, process.pid);

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

test('the proxy forwards to the server the profile names', async () => {
  // A LAN Ollama must not be silently replaced by localhost.
  const seen = [];
  const lan = await prepareLocalSession(
    { provider: 'ollama', baseUrl: 'http://192.168.1.50:11434' },
    {
      hasServer: () => false,
      startSpeedProxy: async options => { seen.push(options); return { started: true, url: 'http://127.0.0.1:11435' }; },
    },
  );
  assert.deepEqual(seen[0].upstream, { host: '192.168.1.50', port: 11434, secure: false, url: 'http://192.168.1.50:11434' });
  await lan.cleanup();
});

test('ollamaUpstream keeps the scheme and defaults the port', () => {
  assert.deepEqual(ollamaUpstream('http://192.168.1.50:11434/v1'), { host: '192.168.1.50', port: 11434, secure: false, url: 'http://192.168.1.50:11434' });
  assert.deepEqual(ollamaUpstream('http://box'), { host: 'box', port: 11434, secure: false, url: 'http://box:11434' });
  // HTTPS must survive: the proxy would otherwise send plaintext to a TLS listener.
  assert.deepEqual(ollamaUpstream('https://box'), { host: 'box', port: 443, secure: true, url: 'https://box:443' });
  assert.deepEqual(ollamaUpstream('https://box:8443/v1'), { host: 'box', port: 8443, secure: true, url: 'https://box:8443' });
  // An IPv6 literal keeps its brackets in the URL but not in the request
  // hostname; node:http resolves "[::1]" to nothing.
  assert.deepEqual(ollamaUpstream('http://[::1]:11434'), { host: '::1', port: 11434, secure: false, url: 'http://[::1]:11434' });
  assert.deepEqual(ollamaUpstream('https://[fd00::1]/v1'), { host: 'fd00::1', port: 443, secure: true, url: 'https://[fd00::1]:443' });
  assert.equal(ollamaUpstream('not a url'), null);
  assert.equal(ollamaUpstream(''), null);
});

test('the proxy reaches an IPv6 upstream and brackets it in /health', async t => {
  const upstream = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ via: 'ipv6', path: req.url }));
  });
  try {
    await new Promise((resolve, reject) => { upstream.once('error', reject); upstream.listen(0, '::1', resolve); });
  } catch {
    t.skip('IPv6 loopback not available');
    return;
  }
  const proxy = createProxyServer({ upstreamHost: '::1', upstreamPort: upstream.address().port });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => { proxy.close(); upstream.close(); });
  const base = `http://127.0.0.1:${proxy.address().port}`;

  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.upstream, `http://[::1]:${upstream.address().port}`);
  const res = await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [] }) });
  assert.equal((await res.json()).via, 'ipv6', 'a bracketed hostname would never reach the server');
});

test('an HTTPS profile reaches the proxy as HTTPS', async () => {
  const seen = [];
  const session = await prepareLocalSession(
    { provider: 'ollama', baseUrl: 'https://ollama.example.com' },
    {
      hasServer: () => false,
      startSpeedProxy: async options => { seen.push(options); return { started: true, url: 'http://127.0.0.1:11435' }; },
    },
  );
  assert.deepEqual(seen[0].upstream, { host: 'ollama.example.com', port: 443, secure: true, url: 'https://ollama.example.com:443' });
  await session.cleanup();
});

test('a foreign service on the proxy port is not adopted', async () => {
  // A 200 from somebody else's listener used to count as "our proxy is up",
  // which routed every prompt to that service.
  const foreign = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<h1>not a proxy</h1>'); });
  const other = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, upstream: 'http://127.0.0.1:11434' })); });
  const wrongUpstream = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, upstream: 'http://10.0.0.9:11434' })); });
  // Looks healthy but names no upstream at all: the previous guard only
  // compared when the field was present, so this listener was adopted.
  const silentUpstream = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })); });
  const servers = [foreign, other, wrongUpstream, silentUpstream];
  await Promise.all(servers.map(s => new Promise(r => s.listen(0, '127.0.0.1', r))));
  const url = s => `http://127.0.0.1:${s.address().port}`;
  try {
    assert.equal(await proxyStatus({ url: url(foreign) }), false, 'an unrelated 200 is not the proxy');
    assert.equal(await proxyStatus({ url: url(other) }), true, 'the proxy shape is accepted');
    assert.equal(await proxyStatus({ url: url(other), upstream: 'http://127.0.0.1:11434' }), true);
    assert.equal(await proxyStatus({ url: url(wrongUpstream), upstream: 'http://127.0.0.1:11434' }), false, 'a different upstream is a different server');
    assert.equal(await proxyStatus({ url: url(silentUpstream), upstream: 'http://127.0.0.1:11434' }), false, 'a health answer without the expected upstream is not ours');
    assert.equal(await proxyStatus({ url: url(silentUpstream) }), true, 'without an expectation the shape is enough');
    assert.equal(await proxyStatus({ url: 'http://127.0.0.1:1' }), false, 'nothing listening');
  } finally {
    await Promise.all(servers.map(s => new Promise(r => s.close(r))));
  }
});

test('a shared server or proxy is only stopped by the last session using it', () => {
  // Two terminals, same Ollama profile: the second adopts both processes. The
  // first to exit used to stop them and broke the second.
  const file = join(temp, 'consumers.json');
  const alive = () => true;
  const a = 41001, b = 41002;

  registerLocalConsumer('server', { pid: a, childPid: 51001, file, alive });
  registerLocalConsumer('proxy', { pid: a, childPid: 51002, file, alive });
  registerLocalConsumer('server', { pid: b, file, alive });
  registerLocalConsumer('proxy', { pid: b, file, alive });

  // The first session leaves: the processes must survive for the second.
  const firstServer = releaseLocalConsumer('server', { pid: a, file, alive });
  const firstProxy = releaseLocalConsumer('proxy', { pid: a, file, alive });
  assert.equal(firstServer.others, 1, 'the second session still needs the server');
  assert.equal(firstProxy.others, 1, 'the second session still needs the proxy');
  assert.equal(firstServer.childPid, 51001, 'the serving process stays recorded');

  // The last session leaves and is told which process it may now stop, even
  // though the spawning session is long gone.
  const lastServer = releaseLocalConsumer('server', { pid: b, file, alive });
  const lastProxy = releaseLocalConsumer('proxy', { pid: b, file, alive });
  assert.equal(lastServer.others, 0);
  assert.equal(lastProxy.others, 0);
  assert.equal(lastServer.childPid, 51001);
  assert.equal(lastProxy.childPid, 51002);

  // The recorded pids are gone once nobody uses them: a reused pid must never
  // become a kill target for a later session.
  const state = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(state.owners, {});
  assert.deepEqual(state.consumers, []);
});

test('concurrent processes registering the same role never lose an entry', async () => {
  // Two launches registering at once used to read the same old file and the
  // later write dropped the other pid. The survivor then counted itself as the
  // last consumer and stopped the shared server. Real child processes, released
  // together, must all survive.
  const file = join(temp, 'consumers-race.json');
  const script = join(temp, 'register-consumer.mjs');
  const library = new URL('../lib/local-models.mjs', import.meta.url).href;
  // A real launch stays alive after registering, so the children hold here:
  // an exited pid is pruned on purpose and would hide the race.
  writeFileSync(script, [
    `const [file, role, startAt] = process.argv.slice(2);`,
    `const { registerLocalConsumer } = await import(${JSON.stringify(library)});`,
    `while (Date.now() < Number(startAt)) {}`,
    `registerLocalConsumer(role, { file });`,
    `process.stdout.write(String(process.pid) + '\\n');`,
    // Hold without a timing assumption: the parent ends it by closing stdin.
    `process.stdin.resume();`,
  ].join('\n'));

  const startAt = Date.now() + 1200;
  const children = Array.from({ length: 8 }, () => spawn(process.execPath, [script, file, 'server', String(startAt)], { stdio: ['pipe', 'pipe', 'inherit'] }));
  try {
    const pids = await Promise.all(children.map(child => new Promise((resolve, reject) => {
      child.stdout.once('data', data => resolve(Number(String(data).trim())));
      child.once('exit', code => reject(new Error(`child exited early with ${code}`)));
    })));
    assert.equal(pids.length, 8);

    const state = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(state.consumers.length, 8, 'no registration was overwritten');
    assert.deepEqual(state.consumers.map(entry => entry.pid).sort(), [...pids].sort(), 'the registered pids are the live children');
  } finally {
    for (const child of children) child.kill();
  }
});

test('a lock whose owner is still alive is waited for, never stolen', async t => {
  // Breaking by age alone would delete the lock of a slow but healthy process.
  const file = join(temp, 'consumers-live-lock.json');
  const lock = `${file}.lock`;
  mkdirSync(dirname(file), { recursive: true });
  const holder = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)']);
  t.after(() => holder.kill());
  await new Promise(resolve => holder.once('spawn', resolve));

  // Young and owned by a live process: this is a slow critical section, not a
  // crash. The old file age does not matter; the owner record is newer.
  writeFileSync(lock, JSON.stringify({ pid: holder.pid, since: Date.now() }));
  const past = new Date(Date.now() - 60_000);
  utimesSync(lock, past, past);

  const started = Date.now();
  registerLocalConsumer('server', { pid: 44001, file, alive: () => true });
  assert.ok(Date.now() - started >= 600, 'the live lock is waited for, not taken immediately');
  // Strict: the lock must still exist and still name the holder. "Gone" would
  // also be true for a lock that was stolen, which is the regression to catch.
  assert.ok(existsSync(lock), 'the live lock still exists');
  assert.equal(JSON.parse(readFileSync(lock, 'utf8')).pid, holder.pid, 'the live lock still belongs to its owner');
});

test('a lock whose recorded owner is alive but far too old is recovered', () => {
  // A failed unlink or a reused pid would otherwise strand the lock forever and
  // push every registry call onto the unserialised fallback.
  const file = join(temp, 'consumers-ancient-lock.json');
  const lock = `${file}.lock`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(lock, JSON.stringify({ pid: process.pid, since: Date.now() - 120_000 }));
  const past = new Date(Date.now() - 120_000);
  utimesSync(lock, past, past);

  const started = Date.now();
  registerLocalConsumer('server', { pid: 44002, file, alive: () => true });
  assert.ok(Date.now() - started < 500, 'the ancient lock is broken instead of waited out');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).consumers.length, 1);
  assert.equal(existsSync(lock), false, 'our own lock is removed again');
});

test('a lock left behind by a killed process is broken', () => {
  const file = join(temp, 'consumers-stale-lock.json');
  const lock = `${file}.lock`;
  mkdirSync(dirname(file), { recursive: true });
  // A pid that is certainly not running, plus a mtime two seconds old. That age
  // is above staleMs (750 ms) but below maxAgeMs (15 s), so the test only
  // passes when a dead owner uses the short threshold: a live owner with the
  // same age must be waited for (see the test above), and a dead one must not
  // get the benefit of the doubt.
  writeFileSync(lock, JSON.stringify({ pid: 999_999, since: Date.now() - 2000 }));
  const past = new Date(Date.now() - 2000);
  utimesSync(lock, past, past);
  const started = Date.now();
  registerLocalConsumer('proxy', { pid: 43001, file, alive: pid => pid !== 999_999 });
  // Well under the 1500 ms timeout: a lock that is only waited out would also
  // write the registry, so the duration is what proves it was broken.
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 500, `the stale lock is broken without waiting, took ${elapsed} ms`);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).consumers.length, 1);
  assert.equal(existsSync(lock), false, 'our own lock is removed again');
});

test('a consumer that died without cleanup is pruned', () => {
  // A killed terminal never releases its claim; a stale pid must not keep the
  // processes alive forever.
  const file = join(temp, 'consumers-stale.json');
  registerLocalConsumer('proxy', { pid: 42001, childPid: 52001, file, alive: () => true });
  registerLocalConsumer('proxy', { pid: 42002, file, alive: () => true });
  const result = releaseLocalConsumer('proxy', { pid: 42002, file, alive: pid => pid !== 42001 });
  assert.equal(result.others, 0, 'the dead consumer no longer counts');
  assert.equal(result.childPid, 52001, 'the recorded process is still reported');
});

test('the readiness poll adopts a winner that answers after our child died', async () => {
  // Two launches may point at different Ollama servers using the same proxy
  // port. The second spawns, loses the bind and its child exits - but the
  // winner may answer only afterwards. Giving up at the exit would leave this
  // session unregistered, so the last consumer would stop the shared proxy.
  const seen = [];
  let calls = 0;
  // Silent for the first polls (as during a cold start), then the winner answers.
  const late = async ({ upstream }) => { seen.push(upstream); return ++calls > 3 ? { ok: true, upstream, pid: 4242 } : null; };
  const outcome = await waitForProxy(5000, { upstream: 'http://10.0.0.9:11434', child: { exitCode: 1 }, status: late, pollMs: 5 });
  assert.deepEqual(outcome, { ready: true, ours: false }, 'the winner is adopted, not claimed');
  assert.ok(seen.every(u => u === 'http://10.0.0.9:11434'), 'the poll checks the upstream this profile asked for');

  // Nobody ever answers and our child is gone: give up after the adoption
  // window instead of waiting out the full timeout.
  const started = Date.now();
  const silent = async () => null;
  await assert.doesNotReject(async () => {
    assert.equal((await waitForProxy(5000, { upstream: 'http://10.0.0.9:11434', child: { exitCode: 1 }, status: silent, pollMs: 5, adoptionWindowMs: 100 })).ready, false);
  });
  assert.ok(Date.now() - started < 1500, 'the dead child ends the wait early');
});

test('a launch that lost the port does not take over the winner', async () => {
  // Two launches race for the same server: the loser exits on EADDRINUSE while
  // the winner answers for the very same upstream. Health alone cannot tell
  // them apart, and a still-starting loser is alive while the winner already
  // answers - so ownership must come from identity, not from "our child lives".
  // startLocal/startProxy write to the module's registry, which lives under the
  // test data directory.
  const file = join(process.env.PORTABLE_AI_DATA_DIR, 'run', 'local-consumers.json');
  const registry = () => JSON.parse(readFileSync(file, 'utf8'));
  rmSync(file, { force: true });

  const fakeChild = (exitCode) => {
    const child = new EventEmitter();
    child.pid = 999_998;
    child.exitCode = exitCode;
    child.kill = () => {};
    return child;
  };
  // Not online before the spawn, answered by the winner afterwards.
  const readyAfterSpawn = online => {
    let calls = 0;
    return async () => (++calls === 1 ? { online: false } : { online });
  };

  // Dead before the first poll.
  const server = await startLocal({ spawnImpl: () => fakeChild(1), status: readyAfterSpawn(true), timeoutMs: 300, executable: join(temp, 'ollama-fixture') });
  assert.deepEqual(server, { alreadyRunning: true }, 'the winner\'s server is used');
  assert.deepEqual(registry().owners, {}, 'no dead pid is recorded for the server');
  assert.equal(registry().consumers.length, 1, 'the adopting session is still a consumer');

  rmSync(file, { force: true });
  // The proxy names its pid, so a live child that is not the listener is
  // rejected outright - the case a liveness check cannot see.
  let proxyCalls = 0;
  const proxy = await startProxy({
    spawnImpl: () => fakeChild(null),
    health: async () => { ++proxyCalls; return proxyCalls === 1 ? null : { ok: true, upstream: 'http://127.0.0.1:11434', pid: 4242 }; },
    upstream: { host: '127.0.0.1', port: 11434, secure: false, url: 'http://127.0.0.1:11434' },
    timeoutMs: 300,
  });
  assert.equal(proxy.alreadyRunning, true, 'the running proxy is adopted');
  assert.deepEqual(registry().owners, {}, 'a live child that is not the listener is not recorded');
  assert.equal(registry().consumers.length, 1, 'the adopting session is counted');
});

test('a successful start records its own child as the owner', async () => {
  // Nothing else covers the claim path: without this, dropping childPid from the
  // registration would go unnoticed.
  const file = join(process.env.PORTABLE_AI_DATA_DIR, 'run', 'local-consumers.json');
  rmSync(file, { force: true });
  const child = new EventEmitter();
  child.pid = 999_997;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => {};
  let calls = 0;
  const proxy = await startProxy({
    spawnImpl: () => child,
    health: async () => (++calls === 1 ? null : { ok: true, upstream: 'http://127.0.0.1:11434', pid: 999_997 }),
    upstream: { host: '127.0.0.1', port: 11434, secure: false, url: 'http://127.0.0.1:11434' },
    timeoutMs: 500,
  });
  assert.deepEqual(proxy, { started: true, url: 'http://127.0.0.1:11435' });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).owners, { proxy: 999_997 });

  // The server has no pid in its health answer, so a child that stays alive
  // across the grace window is taken as the listener.
  rmSync(file, { force: true });
  const server = new EventEmitter();
  server.pid = 999_996;
  server.exitCode = null;
  server.signalCode = null;
  server.kill = () => {};
  let polls = 0;
  const started = await startLocal({
    spawnImpl: () => server,
    status: async () => (++polls === 1 ? { online: false } : { online: true }),
    executable: join(temp, 'ollama-fixture'),
    graceMs: 20,
    timeoutMs: 1000,
  });
  assert.deepEqual(started, { starting: true });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).owners, { server: 999_996 });
});

test('a foreign service on the Ollama port is not treated as Ollama', async t => {
  // A JSON 200 with no `models` array used to mark Ollama online, so the
  // bundled server was never started and every turn went to the stranger.
  const foreign = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); });
  const real = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ models: [{ name: 'llama3', size: 42 }] }));
  });
  await Promise.all([foreign, real].map(s => new Promise(r => s.listen(0, '127.0.0.1', r))));
  t.after(() => Promise.all([foreign, real].map(s => new Promise(r => s.close(r)))));
  const tags = s => `http://127.0.0.1:${s.address().port}/api/tags`;
  assert.equal((await localStatus({ tagsUrl: tags(foreign) })).online, false);
  const status = await localStatus({ tagsUrl: tags(real) });
  assert.equal(status.online, true);
  assert.deepEqual(status.models, [{ name: 'llama3', size: 42 }]);
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
    stopServer: options => stops.push({ role: 'server', options }),
    stopSpeedProxy: options => stops.push({ role: 'proxy', options }),
  });
  await tracking.cleanup();
  // A process we adopted is released, never stopped unconditionally: another
  // terminal may still be using it, so the decision moves into the registry.
  assert.deepEqual(stops, [
    { role: 'proxy', options: { release: true } },
    { role: 'server', options: { release: true } },
  ], 'cleanup releases the claim instead of stopping a shared process');
});

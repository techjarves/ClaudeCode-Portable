import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temp = mkdtempSync(join(tmpdir(), 'portable-resume-tests-'));
process.env.PORTABLE_AI_DATA_DIR = join(temp, 'data');
const { parseResumeArgs, buildResumeArguments, runResume } = await import('../lib/resume.mjs');
const { readConfig, saveProfile } = await import('../lib/config.mjs');

test.after(() => rmSync(temp, { recursive: true, force: true }));

const projectRoot = join(temp, 'project');
const workspace = join(temp, 'workspace');
mkdirSync(projectRoot, { recursive: true });
mkdirSync(workspace, { recursive: true });
const executable = join(temp, 'claude.exe');
writeFileSync(executable, 'fixture-claude-executable');

function makeSpawn(exitCodes = [0]) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    const code = exitCodes.length ? exitCodes.shift() : 0;
    queueMicrotask(() => child.emit('exit', code, null));
    return child;
  };
  return { calls, spawnImpl };
}

const customConfig = () => {
  saveProfile({ provider: 'custom', model: 'resume-model', auth: 'api', baseUrl: 'http://127.0.0.1:9099/v1', key: 'fixture-key', adapter: 'builtin' });
  return readConfig();
};
const deepseekConfig = () => {
  saveProfile({ provider: 'deepseek', model: 'deepseek-chat', auth: 'api', baseUrl: 'https://api.deepseek.com/anthropic', key: 'fixture-key' });
  return readConfig();
};

const adapterFixture = () => {
  const state = { closed: false, started: 0 };
  const start = async () => { state.started++; return { url: 'http://127.0.0.1:4242', token: 'fixture-token', close: async () => { state.closed = true; } }; };
  return { state, start };
};

const parsed = (sessionId, workDir, { safe = false, forceOn = false } = {}) => ({ sessionId, workDir, safe, forceOn });

test('parses a session ID, a working directory and the defaults', () => {
  assert.deepEqual(parseResumeArgs([], { projectRoot }), parsed(null, projectRoot));
  assert.deepEqual(parseResumeArgs(['11ed2a6e-3b31-4535-8f47-25fcba70bede'], { projectRoot }), parsed('11ed2a6e-3b31-4535-8f47-25fcba70bede', projectRoot));
  assert.deepEqual(parseResumeArgs(['--resume', 'abc'], { projectRoot }), parsed('abc', projectRoot));
  assert.deepEqual(parseResumeArgs([workspace], { projectRoot }), parsed(null, workspace));
  assert.deepEqual(parseResumeArgs(['--cwd', workspace], { projectRoot }), parsed(null, workspace));
  // Any order, positional directory relative to the caller, both kinds of ID.
  assert.deepEqual(parseResumeArgs(['--resume', 'abc', '--cwd', workspace], { projectRoot }), parsed('abc', workspace));
  assert.deepEqual(parseResumeArgs(['--cwd', workspace, 'abc'], { projectRoot }), parsed('abc', workspace));
  assert.deepEqual(parseResumeArgs(['abc', workspace], { projectRoot }), parsed('abc', workspace));
  assert.deepEqual(parseResumeArgs(['--cwd', '.', 'abc'], { cwd: workspace, projectRoot }), parsed('abc', workspace));
});

test('parses the one-off permission overrides', () => {
  assert.deepEqual(parseResumeArgs(['--safe', 'abc'], { projectRoot }), parsed('abc', projectRoot, { safe: true }));
  assert.deepEqual(parseResumeArgs(['abc', '--unrestricted'], { projectRoot }), parsed('abc', projectRoot, { forceOn: true }));
  assert.throws(() => parseResumeArgs(['--safe', '--unrestricted'], { projectRoot }), /Cannot combine/);
});

test('rejects duplicates, missing values, unknown flags and bad IDs', () => {
  assert.throws(() => parseResumeArgs(['--resume', 'a', '--resume', 'b'], { projectRoot }), /Duplicate --resume/);
  assert.throws(() => parseResumeArgs(['--cwd', workspace, '--cwd', workspace], { projectRoot }), /Duplicate --cwd/);
  assert.throws(() => parseResumeArgs(['--resume'], { projectRoot }), /Missing session ID/);
  assert.throws(() => parseResumeArgs(['--cwd'], { projectRoot }), /Missing working directory/);
  assert.throws(() => parseResumeArgs(['--resume', '--cwd'], { projectRoot }), /Invalid session ID/);
  assert.throws(() => parseResumeArgs(['--cwd', '--resume'], { projectRoot }), /Invalid working directory/);
  assert.throws(() => parseResumeArgs(['--bogus'], { projectRoot }), /Unknown argument: --bogus/);
  assert.throws(() => parseResumeArgs(['abc', '--bogus'], { projectRoot }), /Unknown argument: --bogus/);
  assert.throws(() => parseResumeArgs(['bad id'], { projectRoot }), /Invalid positional session ID/);
  assert.throws(() => parseResumeArgs(['abc', 'missing-dir'], { projectRoot }), /Working directory not found/);
  assert.throws(() => parseResumeArgs(['--cwd', join(projectRoot, 'nope')], { projectRoot }), /Working directory not found/);
});

test('builds unrestricted resume, continue and fresh-session arguments', () => {
  assert.deepEqual(buildResumeArguments({ model: 'm' }, 'session-1'), ['--model', 'm', '--dangerously-skip-permissions', '--resume', 'session-1']);
  assert.deepEqual(buildResumeArguments({ model: 'm' }, null), ['--model', 'm', '--dangerously-skip-permissions', '--continue']);
  assert.deepEqual(buildResumeArguments({ model: 'm' }, null, { continueSession: false }), ['--model', 'm', '--dangerously-skip-permissions']);
  // Bypass permissions off: no unrestricted flag at all.
  assert.deepEqual(buildResumeArguments({ model: 'm' }, 'session-1', { unrestricted: false }), ['--model', 'm', '--resume', 'session-1']);
});

test('resumes a specific session through the active adapter', async () => {
  const config = customConfig();
  const { calls, spawnImpl } = makeSpawn([0]);
  const { state, start } = adapterFixture();
  const result = await runResume({ sessionId: 'session-1', workDir: workspace, config, executable, deps: { spawn: spawnImpl, startAdapter: start } });
  assert.deepEqual(result, { status: 0, mode: 'resumed' });
  assert.equal(state.started, 1);
  assert.equal(state.closed, true);
  assert.deepEqual(calls[0].args, ['--model', 'resume-model', '--dangerously-skip-permissions', '--resume', 'session-1']);
  assert.equal(calls[0].options.cwd, workspace);
  assert.equal(calls[0].options.stdio, 'inherit');
  assert.equal(calls[0].options.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4242');
  assert.match(calls[0].options.env.CLAUDE_CONFIG_DIR, /custom-api$/);
});

test('continues the most recent session without an adapter for Anthropic transports', async () => {
  const config = deepseekConfig();
  const { calls, spawnImpl } = makeSpawn([0]);
  const result = await runResume({ workDir: workspace, config, executable, deps: { spawn: spawnImpl } });
  assert.deepEqual(result, { status: 0, mode: 'continued' });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['--model', 'deepseek-chat', '--dangerously-skip-permissions', '--continue']);
  assert.equal(calls[0].options.env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
});

test('falls back to a fresh session when nothing can be continued', async () => {
  const config = deepseekConfig();
  const { calls, spawnImpl } = makeSpawn([1, 0]);
  const result = await runResume({ workDir: workspace, config, executable, deps: { spawn: spawnImpl } });
  assert.deepEqual(result, { status: 0, mode: 'new' });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, ['--model', 'deepseek-chat', '--dangerously-skip-permissions', '--continue']);
  assert.deepEqual(calls[1].args, ['--model', 'deepseek-chat', '--dangerously-skip-permissions']);
});

test('resume honours the stored permission preference and one-off overrides', async () => {
  const base = deepseekConfig();
  const withPreference = value => ({ ...base, preferences: { ...base.preferences, bypassPermissions: value } });

  const on = makeSpawn([0]);
  await runResume({ sessionId: 's', workDir: workspace, config: withPreference(undefined), executable, deps: { spawn: on.spawnImpl } });
  assert.ok(on.calls[0].args.includes('--dangerously-skip-permissions'), 'default is ON');

  const off = makeSpawn([0]);
  await runResume({ sessionId: 's', workDir: workspace, config: withPreference(false), executable, deps: { spawn: off.spawnImpl } });
  assert.ok(!off.calls[0].args.includes('--dangerously-skip-permissions'), 'stored OFF disables the flag');

  const safe = makeSpawn([0]);
  await runResume({ sessionId: 's', workDir: workspace, config: withPreference(true), executable, safe: true, deps: { spawn: safe.spawnImpl } });
  assert.ok(!safe.calls[0].args.includes('--dangerously-skip-permissions'), '--safe wins over a stored ON');

  const forced = makeSpawn([0]);
  await runResume({ sessionId: 's', workDir: workspace, config: withPreference(false), executable, forceOn: true, deps: { spawn: forced.spawnImpl } });
  assert.ok(forced.calls[0].args.includes('--dangerously-skip-permissions'), '--unrestricted wins over a stored OFF');
});

test('propagates the Claude Code exit code', async () => {
  const config = deepseekConfig();
  const { spawnImpl } = makeSpawn([7]);
  const result = await runResume({ sessionId: 'session-1', workDir: workspace, config, executable, deps: { spawn: spawnImpl } });
  assert.equal(result.status, 7);
});

test('fails clearly instead of installing or reconfiguring', async () => {
  const config = deepseekConfig();
  const { calls, spawnImpl } = makeSpawn();
  await assert.rejects(runResume({ config: { version: 2, active: null, profiles: {} }, executable, workDir: workspace, deps: { spawn: spawnImpl } }), /No AI provider is configured/);
  await assert.rejects(runResume({ config, executable: join(temp, 'missing.exe'), workDir: workspace, deps: { spawn: spawnImpl } }), /Run START.bat first/);
  await assert.rejects(runResume({ config, workDir: join(temp, 'missing-dir'), executable, deps: { spawn: spawnImpl } }), /Working directory not found/);
  const stub = join(temp, 'stub.exe');
  writeFileSync(stub, 'claude native binary not installed');
  await assert.rejects(runResume({ config, executable: stub, workDir: workspace, deps: { spawn: spawnImpl } }), /Run START.bat to repair/);
  assert.equal(calls.length, 0);
});

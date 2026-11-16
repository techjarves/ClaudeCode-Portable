import test from 'node:test';
import assert from 'node:assert/strict';
import { AutoDevRegistry, createAutoDevRegistry } from '../lib/autodev/registry.mjs';

function manager(repo, ledgers, closed) {
  const ledger = ledgers.get(repo);
  const required = (id) => {
    const run = ledger.runs.find((item) => item.id === id);
    if (!run) throw new Error(`unknown run: ${id}`);
    return run;
  };
  return {
    async list() { return structuredClone(ledger.runs); },
    async create(input) {
      const run = { ...structuredClone(input), id: input.id ?? `run-${ledger.runs.length + 1}`, status: 'queued', events: [], updatedAt: repo };
      ledger.runs.push(run); return structuredClone(run);
    },
    async start(id) { const run = required(id); run.status = 'running'; return structuredClone(run); },
    async status(id) { return structuredClone(required(id)); },
    async events(id) { return structuredClone(required(id).events); },
    async approve(id) { return structuredClone(required(id)); },
    async cancel(id) { const run = required(id); run.status = 'cancelled'; return structuredClone(run); },
    async resume(id) { const run = required(id); run.status = 'running'; return structuredClone(run); },
    async close() { closed.push(repo); },
  };
}

function harness() {
  const files = new Map();
  const ledgers = new Map();
  const created = [];
  const closed = [];
  const targetByLedger = new Map();
  const writeJSON = (file, value) => files.set(file, structuredClone(value));
  const runtimeFactory = async ({ repo, ledgerFile }) => {
    created.push({ repo, ledgerFile });
    let value = files.get(ledgerFile);
    if (!value) {
      value = { version: 1, nextEvent: 1, runs: [] };
      files.set(ledgerFile, value);
    }
    targetByLedger.set(ledgerFile, repo);
    const state = { runs: value.runs };
    ledgers.set(repo, state);
    return manager(repo, ledgers, closed);
  };
  const ledgerOptions = {
    exists: (file) => files.has(file),
    readJSON: (file) => structuredClone(files.get(file)),
    writeJSON,
    mkdir: () => {},
  };
  const options = {
    root: '/app', indexFile: '/data/repositories.json', ledgerRoot: '/data/repositories', legacyLedger: '/data/ledger.json',
    runtimeFactory, repositoryValidator: async (repo) => repo, writeJSON, mkdir: () => {},
    readJSON: (file) => structuredClone(files.get(file)), exists: (file) => files.has(file), ledgerOptions,
  };
  return { options, files, ledgers, created, closed, targetByLedger };
}

test('registry creates one isolated runtime per canonical repository and routes by run id', async () => {
  const value = harness();
  const registry = new AutoDevRegistry(value.options);
  const appRun = await registry.create({ id: 'app-run', request: 'app', target: '/app' });
  const projectRun = await registry.create({ id: 'project-run', request: 'project', target: '/project' });
  assert.equal(appRun.target, '/app');
  assert.equal(projectRun.target, '/project');
  assert.equal(value.created.length, 2);
  assert.notEqual(value.created[0].ledgerFile, value.created[1].ledgerFile);
  assert.equal((await registry.start('project-run')).status, 'running');
  assert.equal((await registry.status('app-run')).target, '/app');
  assert.deepEqual(new Set((await registry.list()).map((run) => run.id)), new Set(['app-run', 'project-run']));
  await registry.close();
  assert.deepEqual(new Set(value.closed), new Set(['/app', '/project']));
});

test('registry factory recovers stale unopened ledgers without starting providers', async () => {
  const value = harness();
  const first = new AutoDevRegistry(value.options);
  await first.create({ id: 'stale', request: 'project', target: '/project' });
  const projectCall = value.created.find((call) => call.repo === '/project');
  const index = structuredClone(value.files.get('/data/repositories.json'));
  const ledger = value.files.get(projectCall.ledgerFile);
  ledger.runs = [{
    id: 'stale',
    request: 'project',
    target: '/project',
    status: 'running',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    events: [],
  }];
  ledger.nextEvent = 1;
  value.files.set(projectCall.ledgerFile, ledger);
  await first.close();

  value.files.set('/data/repositories.json', index);
  value.created.length = 0;
  value.closed.length = 0;
  const registry = await createAutoDevRegistry(value.options);
  const recovered = await registry.status('stale');
  assert.equal(recovered.status, 'interrupted');
  assert.equal(recovered.events.at(-1).type, 'recovered');
  assert.equal(value.created.length, 0);
  await registry.close();
});

test('registry reloads persisted targets and lazily opens their runtimes', async () => {
  const value = harness();
  const first = new AutoDevRegistry(value.options);
  await first.create({ id: 'persisted', request: 'project', target: '/project' });
  await first.close();

  const projectCall = value.created.find((call) => call.repo === '/project');
  const ledger = value.files.get(projectCall.ledgerFile);
  ledger.runs = structuredClone(value.ledgers.get('/project').runs);
  value.files.set(projectCall.ledgerFile, ledger);
  value.created.length = 0;
  const second = new AutoDevRegistry(value.options);
  assert.equal((await second.status('persisted')).target, '/project');
  assert.equal(value.created.length, 0, 'status reads persisted state without starting providers');
  await second.resume('persisted');
  assert.deepEqual(value.created.map((call) => call.repo), ['/project']);
  await second.close();
});

test('registry coalesces concurrent runtime creation for one target', async () => {
  const value = harness();
  const registry = new AutoDevRegistry(value.options);
  await Promise.all([
    registry.create({ id: 'one', request: 'one', target: '/project' }),
    registry.create({ id: 'two', request: 'two', target: '/project' }),
  ]);
  assert.equal(value.created.filter((call) => call.repo === '/project').length, 1);
  await registry.close();
});

test('registry close during canonicalization prevents a late runtime from opening', async () => {
  const value = harness();
  let release;
  let canonicalizing;
  const waiting = new Promise((resolve) => { release = resolve; });
  value.options.repositoryValidator = async (repo) => {
    canonicalizing?.();
    await waiting;
    return repo;
  };
  const registry = new AutoDevRegistry(value.options);
  const entered = new Promise((resolve) => { canonicalizing = resolve; });
  const creating = registry.create({ id: 'late', request: 'late', target: '/project' });
  await entered;
  await registry.close();
  release();
  await assert.rejects(creating, /registry is closed/);
  assert.equal(value.created.length, 0);
});

test('registry closes a runtime created while shutdown is in progress', async () => {
  const value = harness();
  let release;
  let opened;
  const waiting = new Promise((resolve) => { release = resolve; });
  const originalFactory = value.options.runtimeFactory;
  value.options.runtimeFactory = async (input) => {
    const result = await originalFactory(input);
    opened?.();
    await waiting;
    return result;
  };
  const registry = new AutoDevRegistry(value.options);
  const entered = new Promise((resolve) => { opened = resolve; });
  const creating = registry.create({ id: 'late-runtime', request: 'late', target: '/project' });
  await entered;
  const closing = registry.close();
  release();
  await closing;
  await assert.rejects(creating, /registry is closed/);
  assert.deepEqual(value.closed, ['/project']);
});

test('registry bounds and paginates run listings', async () => {
  const value = harness();
  const registry = new AutoDevRegistry(value.options);
  for (let index = 0; index < 105; index += 1) {
    await registry.create({ id: `run-${index}`, request: String(index), target: '/app' });
  }
  assert.equal((await registry.list()).length, 100);
  const page = await registry.list({ limit: 10, offset: 100 });
  assert.equal(page.length, 5);
  await assert.rejects(async () => registry.list({ limit: 1001 }), /list limit/);
  await registry.close();
});

test('registry creates its index directory before the first save', async () => {
  const value = harness();
  const calls = [];
  value.options.mkdir = async (directory) => calls.push(['mkdir', directory]);
  value.options.writeJSON = async (file, content) => {
    calls.push(['write', file]);
    value.files.set(file, structuredClone(content));
  };
  const registry = new AutoDevRegistry(value.options);
  await registry.create({ id: 'fresh', request: 'fresh install', target: '/project' });
  assert.deepEqual(calls.slice(0, 2), [['mkdir', '/data'], ['write', '/data/repositories.json']]);
  await registry.close();
});

test('registry closes a runtime when index persistence fails', async () => {
  const value = harness();
  value.options.mkdir = async () => {};
  value.options.writeJSON = async () => { throw new Error('index unavailable'); };
  const registry = new AutoDevRegistry(value.options);
  await assert.rejects(
    registry.create({ id: 'failed', request: 'save failure', target: '/project' }),
    /index unavailable/,
  );
  assert.deepEqual(value.closed, ['/project']);
  await registry.close();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  createAutoDevRuntime, createOwnedWorkspace, createRepositoryValidator, validateRepository,
} from '../lib/autodev/runtime.mjs';
import { runGit } from '../lib/autodev/worktrees.mjs';

function fakeProcess(code = 0, output = '') {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  queueMicrotask(() => {
    if (output) child.stdout.write(output);
    child.emit('close', code, null);
  });
  return child;
}

test('runtime wires configured Claude provider and saved OpenAI credential without persisting it', async () => {
  const captured = {};
  let adapterClosed = 0;
  const adapter = { url: 'http://127.0.0.1:4444', token: 'adapter-token', close: async () => { adapterClosed++; } };
  const manager = { close: async () => captured.workers.claude.close() };
  const result = await createAutoDevRuntime({
    repo: '/repo',
    ledgerFile: '/data/ledger.json',
    repositoryValidator: async (value) => value,
    readConfigImpl: () => ({
      active: 'custom',
      profiles: {
        custom: { provider: 'custom', auth: 'api', model: 'custom/claude', adapter: 'builtin', key: 'custom-secret' },
        openai: { provider: 'openai', auth: 'api', model: 'gpt', adapter: 'builtin', key: 'codex-secret' },
      },
    }),
    executableImpl: () => '/portable/claude',
    findExecutableImpl: () => '/portable/codex',
    git: async (args) => args[0] === 'rev-parse' && args[1] === '--show-toplevel' ? '/repo' : 'a'.repeat(40),
    adapterStarters: { builtin: async () => adapter },
    providerEnv: (profile, options) => {
      captured.provider = { profile, options };
      return { ANTHROPIC_BASE_URL: options.adapter.url, SAFE: 'yes' };
    },
    claudeFactory: (options) => ({ run() {}, close: options.closeHook, options }),
    codexFactory: (options) => ({ run() {}, options }),
    managerFactory: async (options) => { Object.assign(captured, options); return manager; },
    validator: async () => ({ checks: [] }),
  });
  assert.equal(result, manager);
  assert.equal(captured.workers.claude.options.model, 'custom/claude');
  assert.equal(captured.workers.claude.options.baseOptions.pathToClaudeCodeExecutable, '/portable/claude');
  assert.equal(captured.workers.claude.options.baseOptions.env.SAFE, 'yes');
  assert.equal(captured.workers.claude.options.baseOptions.effort, 'high');
  assert.deepEqual(captured.workers.claude.options.baseOptions.thinking, { type: 'disabled' });
  assert.equal(captured.workers.codex.options.executable, '/portable/codex');
  assert.deepEqual(captured.workerOptions, { codex: { apiKey: 'codex-secret' } });
  assert.doesNotMatch(JSON.stringify({ repo: captured.repo, ledgerFile: captured.ledgerFile }), /codex-secret/);
  await result.close();
  assert.equal(adapterClosed, 1);
});

test('runtime retains high effort without disabling thinking for native providers', async () => {
  let captured;
  const manager = { close: async () => {} };
  const result = await createAutoDevRuntime({
    repo: '/repo',
    repositoryValidator: async (value) => value,
    readConfigImpl: () => ({
      active: 'anthropic',
      profiles: {
        anthropic: { provider: 'anthropic', auth: 'api', model: 'claude-opus-5', key: 'native-secret' },
      },
    }),
    executableImpl: () => '/portable/claude',
    findExecutableImpl: () => undefined,
    git: async () => 'a'.repeat(40),
    providerEnv: () => ({ SAFE: 'yes' }),
    claudeFactory: (options) => ({ run() {}, options }),
    managerFactory: async (options) => {
      captured = options.workers.claude.options;
      return manager;
    },
  });
  assert.equal(result, manager);
  assert.equal(captured.baseOptions.effort, 'high');
  assert.equal('thinking' in captured.baseOptions, false);
});

test('runtime closes adapters after setup failure and rejects login or missing runtime', async () => {
  let closed = 0;
  await assert.rejects(createAutoDevRuntime({
    repo: '/repo',
    repositoryValidator: async (value) => value,
    readConfigImpl: () => ({ active: 'openai', profiles: { openai: { provider: 'openai', auth: 'api', model: 'gpt', adapter: 'builtin', key: 'key' } } }),
    executableImpl: () => '/portable/claude',
    git: async (args) => args.includes('--show-toplevel') ? '/repo' : '',
    adapterStarters: { builtin: async () => ({ url: 'http://127.0.0.1', close: async () => { closed++; } }) },
    providerEnv: () => ({}),
    managerFactory: async () => { throw new Error('setup failed'); },
  }), /setup failed/);
  assert.equal(closed, 1);

  const common = { repo: '/repo', git: async () => '/repo', repositoryValidator: async (value) => value };
  await assert.rejects(createAutoDevRuntime({
    ...common,
    readConfigImpl: () => ({ active: 'anthropic', profiles: { anthropic: { provider: 'anthropic', auth: 'login', model: 'sonnet' } } }),
  }), /API credential/);
  await assert.rejects(createAutoDevRuntime({
    ...common,
    readConfigImpl: () => ({ active: 'anthropic', profiles: { anthropic: { provider: 'anthropic', auth: 'api', model: 'sonnet', key: 'key' } } }),
    executableImpl: () => null,
  }), /official Claude runtime/);
});

test('Git runner preserves porcelain status leading columns', async () => {
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    queueMicrotask(() => {
      child.stdout.end(' M packages/example.mjs\n');
      child.stderr.end();
      child.emit('close', 0, null);
    });
    return child;
  };
  assert.equal(await runGit(['status', '--porcelain'], { cwd: '/repo', spawnImpl }), ' M packages/example.mjs');
});

test('repository validation requires the canonical Git root', async () => {
  assert.equal(await validateRepository('/repo', { git: async () => '/repo', realpath: (value) => value, stat: () => ({ isDirectory: () => true }) }), '/repo');
  await assert.rejects(validateRepository('/repo/sub', {
    git: async () => '/repo', realpath: (value) => value, stat: () => ({ isDirectory: () => true }),
  }), /repository root/);
});

test('owned workspace uses dependency branches, scoped commits, and topological integration', async () => {
  const commands = [];
  let destinationHead = 'a'.repeat(40);
  const dependencyHead = 'd'.repeat(40);
  const records = new Map();
  const owned = {
    async create({ name, runId, taskId, base }) {
      const record = { name, runId, taskId, path: `/work/${name}`, branch: `autodev/${name}`, base };
      records.set(taskId, record);
      return record;
    },
    async status(name) { commands.push(['status', name]); return ` M lib/${name.includes('first') ? 'first' : 'second'}.mjs\0`; },
    async commit(name, options) { commands.push(['commit', name, options]); return `${name}-commit`; },
    async integrate(name, options) { commands.push(['integrate', name, options]); destinationHead = `${commands.length}`.repeat(40).slice(0, 40); },
    async remove(name) { commands.push(['remove', name]); },
  };
  const git = async (args, options) => {
    commands.push(['git', args, options.cwd]);
    if (args[0] === 'rev-parse') {
      if (args[1] === 'HEAD') return options.cwd === '/repo' ? destinationHead : options.cwd.includes('second') ? dependencyHead : destinationHead;
      const record = [...records.values()].find((entry) => entry.branch === args[1]);
      return record?.name ? `${record.name}-commit` : destinationHead;
    }
    if (args[0] === 'diff') return '';
    if (args[0] === 'merge-base') return '';
    return '';
  };
  const workspace = createOwnedWorkspace({ repo: '/repo', root: '/owned', git, owned });
  const first = { id: 'first', title: 'First', paths: ['lib/first.mjs'], dependsOn: [] };
  const firstWorkspace = await workspace.prepare({ run: { id: 'run', packages: [first] }, package: first });
  const second = { id: 'second', title: 'Second', paths: ['lib/second.mjs'], dependsOn: ['first'] };
  const secondWorkspace = await workspace.prepare({
    run: { id: 'run', packages: [{ ...first, workspace: firstWorkspace }, second] }, package: second,
  });
  assert.ok(commands.some((entry) => entry[0] === 'git' && entry[1][0] === 'merge' && entry[1].includes(firstWorkspace.branch) && entry[2] === secondWorkspace.cwd));
  assert.equal(secondWorkspace.baseHead, dependencyHead);
  const completedFirst = await workspace.complete({ package: first, workspace: firstWorkspace });
  const completedSecond = await workspace.complete({ package: second, workspace: secondWorkspace });
  const result = await workspace.integrate({ run: { id: 'run' }, packages: [{ ...second, workspace: completedSecond }, { ...first, workspace: completedFirst }] });
  assert.equal(result.success, true);
  assert.deepEqual(commands.filter((entry) => entry[0] === 'commit').map((entry) => entry[2].paths), [['lib/first.mjs'], ['lib/second.mjs']]);
  const stagingCreate = [...records.values()].find((entry) => entry.taskId === 'integration');
  assert.ok(stagingCreate);
  assert.equal(commands.filter((entry) => entry[0] === 'git' && entry[1][0] === 'merge' && entry[2] === stagingCreate.path).length, 2);
  assert.deepEqual(commands.filter((entry) => entry[0] === 'integrate').map((entry) => entry[1]), [stagingCreate.name]);
  assert.deepEqual(commands.filter((entry) => entry[0] === 'remove').map((entry) => entry[1]), [firstWorkspace.name, secondWorkspace.name, stagingCreate.name]);
});

test('owned workspace stages all package merges before one destination integration', async () => {
  const commands = [];
  const destinationHead = 'a'.repeat(40);
  const packageHead = 'b'.repeat(40);
  let integrated = false;
  let removed = false;
  const workspace = createOwnedWorkspace({
    repo: '/repo', root: '/owned',
    git: async (args, options) => {
      commands.push({ args, cwd: options.cwd });
      if (args[0] === 'rev-parse') return args[1] === 'autodev/conflict' ? packageHead : destinationHead;
      if (args[0] === 'merge' && options.cwd === '/work/staging') throw new Error('merge conflict');
      return '';
    },
    owned: {
      async create() { return { name: 'staging', path: '/work/staging', branch: 'autodev/staging' }; },
      async integrate() { integrated = true; },
      async remove() { removed = true; },
    },
  });
  await assert.rejects(
    workspace.integrate({ run: { id: 'run' }, packages: [{
      id: 'conflict', title: 'Conflict', paths: ['lib/file.mjs'], dependsOn: [],
      workspace: { name: 'conflict', branch: 'autodev/conflict', commit: packageHead },
    }] }),
    /merge conflict/,
  );
  assert.equal(commands.some(({ args, cwd }) => args[0] === 'merge' && args[1] === '--abort' && cwd === '/work/staging'), true);
  assert.equal(integrated, false);
  assert.equal(removed, false);
});

test('owned workspace refuses integration when an approved package branch moved', async () => {
  let staged = false;
  const workspace = createOwnedWorkspace({
    repo: '/repo', root: '/owned',
    git: async (args) => args[0] === 'rev-parse' && args[1] !== 'HEAD' ? 'c'.repeat(40) : 'a'.repeat(40),
    owned: { async create() { staged = true; } },
  });
  await assert.rejects(workspace.integrate({ run: { id: 'run' }, packages: [{
    id: 'moved', title: 'Moved', paths: ['lib/file.mjs'], dependsOn: [],
    workspace: { name: 'moved', branch: 'autodev/moved', commit: 'b'.repeat(40) },
  }] }), /branch moved from approved commit/);
  assert.equal(staged, false);
});

test('owned workspace rejects changes outside the declared path scope', async () => {
  let committed = false;
  const complete = async (status, paths = ['lib']) => {
    const workspace = createOwnedWorkspace({
      repo: '/repo', root: '/owned',
      git: async (args) => args[0] === 'diff' ? 'M\0lib/café\tfile.mjs\0' : 'a'.repeat(40),
      owned: {
        async status() { return status; },
        async commit() { committed = true; },
      },
    });
    return workspace.complete({
      package: { id: 'scoped', title: 'Scoped', paths, dependsOn: [] },
      workspace: { cwd: '/work/scoped', name: 'scoped', branch: 'autodev/scoped', baseHead: 'a'.repeat(40) },
    });
  };
  await assert.rejects(complete(' M secrets.txt\0'), /outside its scope: secrets\.txt/);
  await assert.rejects(complete('R  lib/secrets.txt\0secrets.txt\0'), /outside its scope: secrets\.txt/);
  await assert.rejects(complete('R  lib/secret file.txt\0secret file.txt\0'), /outside its scope: secret file\.txt/);
  await complete(' M lib/café\tfile.mjs\0', ['lib']);
  assert.equal(committed, true);
});

test('owned workspace rejects clean commits outside the declared path scope', async () => {
  const workspace = createOwnedWorkspace({
    repo: '/repo', root: '/owned',
    git: async (args) => {
      if (args[0] === 'rev-parse') return 'b'.repeat(40);
      if (args[0] === 'diff') return 'A\0secrets.txt\0';
      return '';
    },
    owned: { async status() { return ''; } },
  });
  await assert.rejects(workspace.complete({
    package: { id: 'scoped', title: 'Scoped', paths: ['lib'], dependsOn: [] },
    workspace: { cwd: '/work/scoped', name: 'scoped', branch: 'autodev/scoped', baseHead: 'a'.repeat(40) },
  }), /outside its scope: secrets\.txt/);
});

test('owned workspace produces bounded authoritative review evidence and revalidates branch head', async () => {
  const base = 'a'.repeat(40);
  const commit = 'b'.repeat(40);
  let branchHead = commit;
  let patch = 'diff --git a/lib/old.mjs b/lib/new.mjs';
  const calls = [];
  const workspace = createOwnedWorkspace({
    repo: '/repo',
    root: '/owned',
    git: async (args, options) => {
      calls.push({ args: [...args], cwd: options.cwd });
      if (args[0] === 'rev-parse') return branchHead;
      if (args[0] === 'diff' && args.includes('--name-status')) {
        return 'R100\0lib/old.mjs\0lib/new.mjs\0';
      }
      if (args[0] === '-c') return patch;
      return '';
    },
    owned: {},
  });
  const item = {
    id: 'reviewed',
    paths: ['lib'],
    workspace: {
      cwd: '/work/reviewed',
      branch: 'autodev/reviewed',
      baseHead: base,
      commit,
    },
  };
  const evidence = await workspace.reviewEvidence({ package: item, maxPatchBytes: 100 });
  assert.equal(evidence.baseCommit, base);
  assert.equal(evidence.acceptedCommit, commit);
  assert.deepEqual(evidence.paths, ['lib/old.mjs', 'lib/new.mjs']);
  assert.equal(evidence.patch, patch);
  assert.deepEqual(calls.at(-1).args, [
    '-c', 'diff.external=', '-c', 'diff.trustExitCode=false',
    'diff', '--no-ext-diff', '--binary', '--no-color', base, commit,
  ]);

  branchHead = 'c'.repeat(40);
  await assert.rejects(workspace.reviewEvidence({ package: item }), /branch moved/);
  branchHead = commit;
  patch = 'x'.repeat(10);
  await assert.rejects(
    workspace.reviewEvidence({ package: item, maxPatchBytes: 5 }),
    /review patch exceeds 5 bytes/,
  );
});

test('owned workspace reconciles prepared integration without duplicate apply', async () => {
  const expectedHead = 'a'.repeat(40);
  const stagedHead = 'b'.repeat(40);
  let head = expectedHead;
  let applies = 0;
  const workspace = createOwnedWorkspace({
    repo: '/repo', root: '/owned',
    git: async (args, options) => {
      if (args[0] === 'rev-parse') return options.cwd === '/work/staging' ? stagedHead : head;
      if (args[0] === 'merge-base') return '';
      return '';
    },
    owned: {
      async integrate() { applies++; head = 'c'.repeat(40); },
      async remove() {},
    },
  });
  const intent = { version: 1, state: 'prepared', expectedHead, stagedHead, staging: { name: 'staging', cwd: '/work/staging' }, packages: [], artifacts: [] };
  assert.equal((await workspace.reconcileIntegration(intent)).state, 'not_applied');
  assert.equal((await workspace.applyIntegration(intent)).success, true);
  assert.equal(applies, 1);
  assert.equal((await workspace.reconcileIntegration(intent)).state, 'applied');
  assert.equal((await workspace.applyIntegration(intent)).success, true);
  assert.equal(applies, 1);
});

test('owned workspace rejects a staging branch moved after validation', async () => {
  const expectedHead = 'a'.repeat(40);
  const stagedHead = 'b'.repeat(40);
  const movedHead = 'c'.repeat(40);
  let applies = 0;
  const workspace = createOwnedWorkspace({
    repo: '/repo', root: '/owned',
    git: async (args, options) => {
      if (args[0] === 'rev-parse') return options.cwd === '/work/staging' ? movedHead : expectedHead;
      return '';
    },
    owned: { async integrate() { applies++; } },
  });
  const intent = { version: 1, state: 'prepared', expectedHead, stagedHead, staging: { name: 'staging', cwd: '/work/staging' }, packages: [], artifacts: [] };
  await assert.rejects(workspace.applyIntegration(intent), /staging branch moved/);
  assert.equal(applies, 0);
});

test('owned workspace blocks divergent integration and keeps cleanup retryable', async () => {
  const expectedHead = 'a'.repeat(40);
  const stagedHead = 'b'.repeat(40);
  let applies = 0;
  let cleanupAttempts = 0;
  const workspace = createOwnedWorkspace({
    repo: '/repo', root: '/owned',
    git: async (args) => {
      if (args[0] === 'rev-parse') return 'd'.repeat(40);
      if (args[0] === 'merge-base') throw new Error('not ancestor');
      return '';
    },
    owned: {
      async integrate() { applies++; },
      async remove() {
        cleanupAttempts++;
        if (cleanupAttempts === 1) throw new Error('temporary cleanup failure');
      },
    },
  });
  const intent = { version: 1, state: 'prepared', expectedHead, stagedHead, staging: { name: 'staging', cwd: '/work/staging' }, packages: [], artifacts: [] };
  assert.equal((await workspace.reconcileIntegration(intent)).state, 'diverged');
  await assert.rejects(workspace.applyIntegration(intent), /diverged/);
  assert.equal(applies, 0);
  await assert.rejects(workspace.cleanupIntegration(intent), /cleanup failed/);
  assert.deepEqual(await workspace.cleanupIntegration(intent), { success: true });
});

test('repository validator records timeout and output-limit failures', async () => {
  let timeoutCallback;
  const children = [];
  const validator = createRepositoryValidator({
    exists: (path) => path.endsWith('/tests'),
    readdir: () => ['one.test.mjs'],
    timeoutMs: 5,
    maxOutputBytes: 4,
    setTimeoutImpl: (callback) => { timeoutCallback = callback; return 1; },
    clearTimeoutImpl: () => {},
    spawnImpl: () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => { child.emit('close', null, 'SIGTERM'); return true; };
      children.push(child);
      return child;
    },
  });
  const pending = validator({ cwd: '/repo' });
  timeoutCallback();
  const result = await pending;
  assert.equal(result.checks[0].passed, false);
  assert.match(result.checks[0].detail, /timed out after 5ms/);

  const limited = createRepositoryValidator({
    exists: (path) => path.endsWith('/tests'), readdir: () => ['one.test.mjs'], maxOutputBytes: 4,
    spawnImpl: () => {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => { queueMicrotask(() => child.emit('close', null, 'SIGTERM')); return true; };
      queueMicrotask(() => child.stdout.write('12345'));
      return child;
    },
  });
  const limitedResult = await limited({ cwd: '/repo' });
  assert.equal(limitedResult.checks[0].passed, false);
  assert.match(limitedResult.checks[0].detail, /output exceeded 4 bytes/);
});

test('repository validator escalates termination and settles only after child close', async () => {
  const timers = [];
  const signals = [];
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = (signal) => { signals.push(signal); return true; };
  const validator = createRepositoryValidator({
    exists: (path) => path.endsWith('/tests'),
    readdir: () => ['one.test.mjs'],
    timeoutMs: 5,
    terminationGraceMs: 2,
    setTimeoutImpl: (callback) => { timers.push(callback); return timers.length; },
    clearTimeoutImpl: () => {},
    spawnImpl: () => child,
  });
  let settled = false;
  const pending = validator({ cwd: '/repo', gates: ['repository tests'] })
    .finally(() => { settled = true; });
  timers[0]();
  await Promise.resolve();
  assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(settled, false);
  timers[1]();
  await Promise.resolve();
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(settled, false);
  child.emit('close', null, 'SIGKILL');
  const result = await pending;
  assert.equal(result.checks[0].passed, false);
  assert.match(result.checks[0].detail, /SIGKILL: timed out after 5ms/);
});

test('repository validator records observed pass and failure evidence', async () => {
  let invocation = 0;
  const validator = createRepositoryValidator({
    node: '/node',
    exists: () => true,
    readdir: () => ['b.test.mjs', 'a.test.mjs', 'ignore.txt'],
    spawnImpl: (command, args) => {
      assert.equal(command, '/node');
      const child = fakeProcess(invocation++ === 0 ? 0 : 2, args.join(' '));
      return child;
    },
  });
  const result = await validator({ cwd: '/repo' });
  assert.equal(result.checks.length, 2);
  assert.equal(result.checks[0].passed, true);
  assert.match(result.checks[0].detail, /a\.test\.mjs/);
  assert.equal(result.checks[1].passed, false);
  assert.match(result.checks[1].detail, /exit 2/);
});

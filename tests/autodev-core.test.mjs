import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import {
  AUTODEV_DEFAULTS, AutodevLedger, CodexAbortError, CodexExitError, CodexOutputLimitError,
  CodexProtocolError, CodexTimeoutError, CodexWorker, LedgerVersionError, OwnedWorktrees,
  TransitionError, buildReport, createRunState, createSchedule, evaluateQualityGate, isTerminal,
  normalizeReview, pathsOverlap, requireCrossModelReview, runDag, transition, validateConfig, validateDag,
} from '../lib/autodev/index.mjs';

const noSecrets = (value) => String(value).replaceAll('secret-key-value', '[REDACTED]');

function memoryLedger(initial) {
  let document = initial ? structuredClone(initial) : null;
  const writes = [];
  const options = {
    exists: () => document !== null,
    readJSON: () => structuredClone(document),
    writeJSON: async (_file, value) => {
      await Promise.resolve();
      document = structuredClone(value);
      writes.push(structuredClone(value));
    },
    mkdir: () => {}, redact: noSecrets,
    clock: (() => { let tick = 0; return () => `2026-10-27T00:00:0${tick++}.000Z`; })(),
    id: () => 'generated-id',
  };
  return { ledger: new AutodevLedger('/virtual/ledger.json', options), writes, document: () => document };
}

function fakeChild(onEnd = () => {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const originalEnd = child.stdin.end.bind(child.stdin);
  child.stdin.end = (value) => { onEnd(String(value)); return originalEnd(value); };
  child.killedWith = null;
  child.kill = (signal) => {
    child.killedWith = signal;
    queueMicrotask(() => child.emit('close', null, signal));
    return true;
  };
  return child;
}

function codexHarness({ run, setTimeoutImpl = () => 1 } = {}) {
  const files = new Map();
  const directories = new Set();
  const calls = [];
  let serial = 0;
  const worker = new CodexWorker({
    executable: '/opt/codex', env: { KEEP: 'yes' }, redact: noSecrets,
    temporaryFile: (kind) => `/tmp/${kind}-${serial++}.json`,
    temporaryHome: () => `/tmp/codex-home-${serial++}`,
    mkdir: (directory) => directories.add(directory),
    removeTree: (directory) => {
      directories.delete(`${directory}/rules`);
      for (const file of [...files.keys()]) if (file.startsWith(`${directory}/`)) files.delete(file);
    },
    writeFile: (file, value) => files.set(file, String(value)),
    readFile: (file) => files.get(file), unlink: (file) => files.delete(file),
    setTimeoutImpl, clearTimeoutImpl: () => {},
    spawnImpl: (command, args, options) => {
      const child = fakeChild((prompt) => run?.({ child, prompt, files, command, args, options }));
      calls.push({ command, args, options, child });
      return child;
    },
  });
  return { worker, files, directories, calls };
}

const schema = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } };

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

test('validated config supplies immutable approved defaults', () => {
  assert.deepEqual(AUTODEV_DEFAULTS, { concurrency: 3, reviews: 2, repairs: 3 });
  assert.deepEqual(validateConfig(), AUTODEV_DEFAULTS);
  assert.deepEqual(validateConfig({ concurrency: 1, extra: true }), { concurrency: 1, reviews: 2, repairs: 3, extra: true });
  assert.throws(() => validateConfig({ reviews: 0 }), /positive integer/);
  assert.throws(() => validateConfig({ repairs: 1.5 }), /positive integer/);
  assert.throws(() => validateConfig(null), /object/);
});

test('ledger atomically serializes create, update, list, and get with monotonic redacted events', async () => {
  const memory = memoryLedger();
  const created = await memory.ledger.create({ id: 'run-1', request: 'use secret-key-value' });
  const updates = await Promise.all([
    memory.ledger.update('run-1', { status: 'planning', note: 'secret-key-value' }, 'planned'),
    memory.ledger.update('run-1', { status: 'running' }, 'started'),
  ]);
  assert.equal(created.events[0].sequence, 1);
  assert.equal(updates[1].status, 'running');
  assert.deepEqual(updates[1].events.map((event) => event.sequence), [1, 2, 3]);
  assert.doesNotMatch(JSON.stringify(memory.document()), /secret-key-value/);
  assert.match(JSON.stringify(memory.document()), /\[REDACTED\]/);
  assert.equal((await memory.ledger.list()).length, 1);
  assert.equal((await memory.ledger.get('run-1')).id, 'run-1');
  assert.equal(await memory.ledger.get('missing'), null);
  assert.equal(memory.writes.length, 3);
  assert.equal(memory.document().version, 1);
  assert.equal(memory.document().nextEvent, 4);
});

test('ledger rejects versions and recovers active runs without rewriting terminal runs', async () => {
  const bad = memoryLedger({ version: 99, nextEvent: 1, runs: [] });
  await assert.rejects(bad.ledger.list(), LedgerVersionError);
  const memory = memoryLedger();
  await memory.ledger.create({ id: 'active', status: 'reviewing' });
  await memory.ledger.create({ id: 'done', status: 'succeeded' });
  const recovered = await memory.ledger.recover();
  assert.deepEqual(recovered.map((run) => run.id), ['active']);
  assert.equal((await memory.ledger.get('active')).status, 'interrupted');
  assert.equal((await memory.ledger.get('done')).status, 'succeeded');
  assert.equal((await memory.ledger.get('active')).events.at(-1).type, 'recovered');
});

test('DAG validation detects missing, duplicate, and cyclic dependencies', () => {
  assert.throws(() => validateDag([{ id: 'a' }, { id: 'a' }]), /duplicate/);
  assert.throws(() => validateDag([{ id: 'a', dependsOn: ['b'] }]), /missing/);
  assert.throws(() => validateDag([{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }]), /cycle/);
});

test('scheduler bounds concurrency and never overlaps owned paths in a wave', async () => {
  const tasks = [
    { id: 'a', paths: ['lib/a'] },
    { id: 'b', paths: ['lib/a/file.mjs'] },
    { id: 'c', paths: ['tests'] },
    { id: 'd', dependsOn: ['a'], paths: ['docs'] },
  ];
  assert.equal(pathsOverlap('lib/a', 'lib/a/file.mjs'), true);
  assert.equal(pathsOverlap('lib/a', 'lib/ab'), false);
  assert.throws(() => pathsOverlap('../escape', 'lib'), /escapes/);
  const waves = createSchedule(tasks, { concurrency: 2 });
  assert.deepEqual(waves.map((wave) => wave.map((task) => task.id)), [['a', 'c'], ['b', 'd']]);
  let active = 0;
  let high = 0;
  const results = await runDag(tasks, async (task) => {
    active++;
    high = Math.max(high, active);
    await Promise.resolve();
    active--;
    return task.id.toUpperCase();
  }, { concurrency: 2 });
  assert.equal(high, 2);
  assert.equal(results.get('d'), 'D');
});

test('owned worktree helper emits only scoped non-destructive Git commands', async () => {
  const commands = [];
  const owners = new Map();
  const git = async (args, options) => {
    commands.push({ args: [...args], cwd: options.cwd });
    if (args[0] === 'status') return '';
    if (args[0] === 'diff') return 'lib/file.mjs\0';
    if (args[0] === 'rev-parse') return args[1] === 'HEAD' ? 'a'.repeat(40) : 'abc123';
    return '';
  };
  const helper = new OwnedWorktrees({
    repo: '/repo', root: '/autodev-worktrees', git, mkdir: () => {},
    writeJSON: (file, value) => owners.set(file, structuredClone(value)),
    readJSON: (file) => structuredClone(owners.get(file)), unlink: (file) => owners.delete(file),
    exists: (file) => owners.has(file),
  });
  const record = await helper.create({ name: 'run-1-task-a', runId: 'run-1', taskId: 'a', base: 'main' });
  assert.equal(record.branch, 'autodev/run-1-task-a');
  assert.deepEqual(commands[0].args, ['worktree', 'add', '-b', record.branch, record.path, 'main']);
  assert.equal(await helper.commit('run-1-task-a', { paths: ['lib/file.mjs'], message: 'Implement task' }), 'a'.repeat(40));
  await helper.integrate('run-1-task-a', { expectedHead: 'a'.repeat(40) });
  await helper.status('run-1-task-a');
  const flattened = commands.flatMap((call) => call.args);
  assert.equal(flattened.includes('reset'), false);
  assert.equal(flattened.includes('clean'), false);
  assert.equal(flattened.includes('--force'), false);
  assert.deepEqual(commands.find((call) => call.args[0] === 'restore').args, ['restore', '--staged', '--', '.']);
  assert.deepEqual(commands.find((call) => call.args[0] === 'add').args, ['add', '--', 'lib/file.mjs']);
  assert.deepEqual(commands.find((call) => call.args[0] === 'diff').args, ['diff', '--cached', '--name-only', '-z']);
  const statusCall = commands.find((call) => call.args.includes('--porcelain=v1'));
  assert.deepEqual(statusCall.args, ['status', '--porcelain=v1', '-z']);
  await helper.remove('run-1-task-a');
  await assert.rejects(helper.create({ name: '../bad', runId: 'r', taskId: 't' }), /invalid/);
  await assert.rejects(helper.commit('run-1-task-a', { paths: ['../outside'], message: 'bad' }), /ownership|unsafe|invalid/);
});

test('owned worktree rollback removes both worktree and branch when owner persistence fails', async () => {
  const commands = [];
  const helper = new OwnedWorktrees({
    repo: '/repo',
    root: '/owned',
    mkdir: () => {},
    exists: () => false,
    git: async (args, options) => {
      commands.push({ args: [...args], cwd: options.cwd });
      return '';
    },
    writeJSON: async () => { throw new Error('owner write failed'); },
  });
  await assert.rejects(
    helper.create({ name: 'rollback', runId: 'run', taskId: 'task' }),
    /owner write failed/,
  );
  assert.deepEqual(commands.map((entry) => entry.args), [
    ['worktree', 'add', '-b', 'autodev/rollback', '/owned/rollback', 'HEAD'],
    ['worktree', 'remove', '/owned/rollback'],
    ['branch', '-d', 'autodev/rollback'],
  ]);
});

test('owned worktree safely adopts a matching registered worktree', async () => {
  const owners = new Map();
  let additions = 0;
  const helper = new OwnedWorktrees({
    repo: '/repo', root: '/owned', mkdir: () => {},
    git: async (args) => {
      if (args[0] === 'worktree' && args[1] === 'add') { additions++; return ''; }
      if (args[0] === 'worktree' && args[1] === 'list') return 'worktree /owned/adopted\nHEAD abc\nbranch refs/heads/autodev/adopted';
      if (args[0] === 'branch') return 'autodev/adopted';
      return '';
    },
    writeJSON: (file, value) => owners.set(file, structuredClone(value)),
    readJSON: (file) => structuredClone(owners.get(file)), unlink: () => {},
    exists: (file) => owners.has(file),
  });
  const created = await helper.create({ name: 'adopted', runId: 'run', taskId: 'task' });
  const adopted = await helper.create({ name: 'adopted', runId: 'run', taskId: 'task' });
  assert.deepEqual(adopted, created);
  assert.equal(additions, 1);
  await assert.rejects(helper.create({ name: 'adopted', runId: 'other', taskId: 'task' }), /ownership does not match/);
});

test('owned worktree refuses unowned paths and unregistered ownership records', async () => {
  const owners = new Map();
  const helper = new OwnedWorktrees({
    repo: '/repo', root: '/owned', mkdir: () => {}, git: async () => '',
    writeJSON: (file, value) => owners.set(file, structuredClone(value)),
    readJSON: (file) => structuredClone(owners.get(file)), unlink: () => {},
    exists: (file) => file === '/owned/unowned' || owners.has(file),
  });
  await assert.rejects(helper.create({ name: 'unowned', runId: 'run', taskId: 'task' }), /unowned worktree path/);
  owners.set('/owned/.owners/missing.json', { version: 1, name: 'missing', runId: 'run', taskId: 'task', repo: '/repo', path: '/owned/missing', branch: 'autodev/missing' });
  await assert.rejects(helper.create({ name: 'missing', runId: 'run', taskId: 'task' }), /not registered/);
});

test('owned worktree clears inherited staging and refuses staged paths outside scope', async () => {
  const owners = new Map();
  let commitCalled = false;
  const helper = new OwnedWorktrees({
    repo: '/repo', root: '/owned', mkdir: () => {},
    git: async (args) => {
      if (args[0] === 'diff') return 'lib/file.mjs\0secrets.txt\0';
      if (args[0] === 'commit') commitCalled = true;
      return args[0] === 'rev-parse' ? 'a'.repeat(40) : '';
    },
    writeJSON: (file, value) => owners.set(file, structuredClone(value)),
    readJSON: (file) => structuredClone(owners.get(file)), unlink: () => {},
    exists: (file) => owners.has(file),
  });
  await helper.create({ name: 'scoped', runId: 'r', taskId: 't' });
  await assert.rejects(helper.commit('scoped', { paths: ['lib/file.mjs'], message: 'Scoped' }), /outside the explicit commit scope/);
  assert.equal(commitCalled, false);
});

test('owned worktree accepts exact NUL-delimited staged filenames', async () => {
  const owners = new Map();
  let commitCalled = false;
  const filename = 'lib/café\tfile.mjs';
  const helper = new OwnedWorktrees({
    repo: '/repo', root: '/owned', mkdir: () => {},
    git: async (args) => {
      if (args[0] === 'diff') return `${filename}\0`;
      if (args[0] === 'commit') commitCalled = true;
      return args[0] === 'rev-parse' ? 'a'.repeat(40) : '';
    },
    writeJSON: (file, value) => owners.set(file, structuredClone(value)),
    readJSON: (file) => structuredClone(owners.get(file)), unlink: () => {},
    exists: (file) => owners.has(file),
  });
  await helper.create({ name: 'quoted', runId: 'r', taskId: 't' });
  assert.equal(await helper.commit('quoted', { paths: [filename], message: 'Scoped' }), 'a'.repeat(40));
  assert.equal(commitCalled, true);
});

test('owned worktree refuses stale or dirty integration destinations', async () => {
  const owners = new Map();
  let head = 'b'.repeat(40);
  let dirty = '';
  const helper = new OwnedWorktrees({
    repo: '/repo', root: '/owned', mkdir: () => {},
    git: async (args) => args[0] === 'rev-parse' ? head : args[0] === 'status' ? dirty : '',
    writeJSON: (file, value) => owners.set(file, structuredClone(value)),
    readJSON: (file) => structuredClone(owners.get(file)), unlink: () => {},
    exists: (file) => owners.has(file),
  });
  await helper.create({ name: 'guarded', runId: 'r', taskId: 't' });
  await assert.rejects(helper.integrate('guarded', { expectedHead: 'a'.repeat(40) }), /destination moved/);
  head = 'a'.repeat(40); dirty = ' M user-file';
  await assert.rejects(helper.integrate('guarded', { expectedHead: head }), /uncommitted/);
  await assert.rejects(helper.integrate('guarded'), /expected destination/);
});

test('owned worktree refuses dirty removal and never requests force', async () => {
  const owners = new Map();
  const helper = new OwnedWorktrees({
    repo: '/repo', root: '/owned', mkdir: () => {},
    git: async (args) => args[0] === 'status' ? ' M file' : '',
    writeJSON: (file, value) => owners.set(file, structuredClone(value)),
    readJSON: (file) => structuredClone(owners.get(file)), unlink: () => {},
    exists: (file) => owners.has(file),
  });
  await helper.create({ name: 'dirty', runId: 'r', taskId: 't' });
  await assert.rejects(helper.remove('dirty'), /uncommitted/);
});

test('Codex worker uses explicit executable, isolated key, schema, cwd, sandbox, approval, and streams JSONL', async () => {
  const events = [];
  let policy;
  const harness = codexHarness({ run: ({ child, files, args, options }) => {
    const output = args[args.indexOf('--output-last-message') + 1];
    policy = files.get(`${options.env.CODEX_HOME}/rules/autodev.rules`);
    files.set(output, JSON.stringify({ ok: true, token: 'secret-key-value' }));
    queueMicrotask(() => {
      child.stdout.write(`${JSON.stringify({ type: 'turn', token: 'secret-key-value' })}\n`);
      child.emit('close', 0, null);
    });
  } });
  const result = await harness.worker.run({ prompt: 'work', cwd: '/repo/worktree', apiKey: 'secret-key-value', schema, onEvent: (event) => events.push(event) });
  const call = harness.calls[0];
  assert.equal(call.command, '/opt/codex');
  assert.deepEqual(call.args.slice(0, 3), ['--ask-for-approval', 'never', 'exec']);
  assert.equal(call.args.includes('--ephemeral'), true);
  assert.equal(call.args.includes('--ignore-user-config'), true);
  const configIndex = call.args.indexOf('-c');
  assert.equal(call.args[configIndex + 1], 'shell_environment_policy.exclude=["CODEX_API_KEY"]');
  assert.equal(call.args.includes('--json'), true);
  assert.equal(call.args.includes('--output-schema'), true);
  assert.equal(call.args.includes('-C'), true);
  assert.equal(call.args.includes('--sandbox'), true);
  assert.equal(call.options.env.CODEX_API_KEY, 'secret-key-value');
  assert.equal(call.options.env.KEEP, 'yes');
  assert.match(call.options.env.CODEX_HOME, /^\/tmp\/codex-home-/);
  assert.match(policy, /pattern=\["git"\].*decision="forbidden"/);
  assert.match(policy, /pattern=\["rm"\].*decision="forbidden"/);
  assert.match(policy, /pattern=\["npm"\].*decision="forbidden"/);
  assert.match(policy, /pattern=\["bash"\].*decision="forbidden"/);
  assert.deepEqual(events, [{ type: 'turn', token: '[REDACTED]' }]);
  assert.deepEqual(result.final, { ok: true, token: '[REDACTED]' });
  assert.equal(harness.files.size, 0);
});

test('Codex read-only runs do not receive a writable policy home', async () => {
  const harness = codexHarness({ run: ({ child, files, args }) => {
    const output = args[args.indexOf('--output-last-message') + 1];
    files.set(output, JSON.stringify({ ok: true }));
    queueMicrotask(() => child.emit('close', 0, null));
  } });
  await harness.worker.run({
    prompt: 'review', cwd: '/repo', apiKey: 'secret-key-value', schema,
    sandbox: 'read-only',
  });
  assert.equal(harness.calls[0].options.env.CODEX_HOME, undefined);
});

test('Codex writable runs fail closed when policy setup fails', async () => {
  const worker = new CodexWorker({
    executable: '/opt/codex',
    temporaryFile: (() => { let serial = 0; return () => `/tmp/policy-${serial++}.json`; })(),
    temporaryHome: () => { throw new Error('policy unavailable'); },
    writeFile: () => {},
    unlink: () => {},
  });
  await assert.rejects(
    worker.run({ prompt: 'write', cwd: '/repo', apiKey: 'key', schema }),
    (error) => error.code === 'CODEX_POLICY' && /policy unavailable/.test(error.message),
  );
});

test('Codex worker classifies malformed output, exit failure, cap, timeout, and abort without leaking keys', async () => {
  const malformed = codexHarness({ run: ({ child }) => queueMicrotask(() => { child.stdout.write('not-json\n'); }) });
  await assert.rejects(malformed.worker.run({ prompt: 'p', cwd: '/repo', apiKey: 'secret-key-value', schema }), CodexProtocolError);

  const failed = codexHarness({ run: ({ child }) => queueMicrotask(() => {
    child.stdout.write(`${JSON.stringify({
      type: 'error',
      message: 'structured failure secret-key-value',
    })}\n`);
    child.stderr.write('stderr failure secret-key-value');
    child.emit('close', 7, null);
  }) });
  await assert.rejects(failed.worker.run({ prompt: 'p', cwd: '/repo', apiKey: 'secret-key-value', schema }), (error) => {
    assert.equal(error instanceof CodexExitError, true);
    assert.match(error.message, /stderr failure/);
    assert.match(error.message, /structured failure/);
    assert.doesNotMatch(error.message, /secret-key-value/);
    return true;
  });

  const capped = codexHarness({ run: ({ child }) => queueMicrotask(() => child.stdout.write('123456789')) });
  await assert.rejects(capped.worker.run({ prompt: 'p', cwd: '/repo', apiKey: 'secret-key-value', schema, maxOutputBytes: 4 }), CodexOutputLimitError);
  assert.equal(capped.calls[0].child.killedWith, 'SIGTERM');

  let fireTimeout;
  const timed = codexHarness({ setTimeoutImpl: (callback) => { fireTimeout = callback; return 1; } });
  const timeout = timed.worker.run({ prompt: 'p', cwd: '/repo', apiKey: 'secret-key-value', schema, timeoutMs: 10 });
  fireTimeout();
  await assert.rejects(timeout, CodexTimeoutError);
  assert.equal(timed.calls[0].child.killedWith, 'SIGTERM');

  const controller = new AbortController();
  const aborted = codexHarness();
  const abort = aborted.worker.run({ prompt: 'p', cwd: '/repo', apiKey: 'secret-key-value', schema, signal: controller.signal });
  controller.abort();
  await assert.rejects(abort, CodexAbortError);
  assert.equal(aborted.calls[0].child.killedWith, 'SIGTERM');
});

test('Codex worker waits for process close and escalates stalled termination', async () => {
  const files = new Map();
  const signals = [];
  const timers = [];
  const child = fakeChild();
  child.kill = (signal) => {
    signals.push(signal);
    if (signal === 'SIGKILL') queueMicrotask(() => child.emit('close', null, signal));
    return true;
  };
  const worker = new CodexWorker({
    executable: '/opt/codex',
    temporaryFile: (() => { let serial = 0; return () => `/tmp/close-${serial++}.json`; })(),
    writeFile: (file, value) => files.set(file, String(value)),
    readFile: (file) => files.get(file),
    unlink: (file) => files.delete(file),
    removeTree: (directory) => {
      for (const file of [...files.keys()]) if (file.startsWith(`${directory}/`)) files.delete(file);
    },
    spawnImpl: () => child,
    setTimeoutImpl: (callback) => { timers.push(callback); return timers.length; },
    clearTimeoutImpl: () => {},
    terminationGraceMs: 5,
  });
  const controller = new AbortController();
  let settled = false;
  const running = worker.run({ prompt: 'p', cwd: '/repo', apiKey: 'key', schema, signal: controller.signal, timeoutMs: 100 }).finally(() => { settled = true; });
  controller.abort();
  await flush();
  assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(settled, false);
  assert.equal(files.size, 2, 'schema and policy files remain until the child exits');
  timers.at(-1)();
  await assert.rejects(running, CodexAbortError);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(files.size, 0);
});

test('reviews normalize verdict and quality gate aggregates only required failures', () => {
  const review = normalizeReview({ reviewer: 'codex-reviewer', backend: 'codex', subjectBackend: 'claude', findings: [
    { severity: 'low', title: 'Style', detail: 'Optional.' },
    { id: 'security', severity: 'HIGH', title: 'Leak', detail: 'Credential exposed.' },
  ] });
  assert.equal(review.verdict, 'changes_requested');
  assert.deepEqual(review.findings.map((finding) => finding.id), ['security', 'finding-1']);
  assert.equal(requireCrossModelReview(review).backend, 'codex');
  assert.throws(() => requireCrossModelReview({ reviewer: 'self', backend: 'claude', subjectBackend: 'claude', findings: [] }), /different model/);
  const gate = evaluateQualityGate({
    checks: [{ name: 'tests', passed: false, observed: true }, { name: 'lint', passed: false, required: false }],
    reviews: [review],
  });
  assert.equal(gate.passed, false);
  assert.equal(gate.failedChecks.length, 1);
  assert.equal(gate.blockingFindings.length, 1);
  assert.deepEqual(gate.reasons, ['quality check failed: tests', 'blocking review finding: security']);
});

test('quality gate rejects required unobserved checks but keeps optional evidence advisory', () => {
  const required = evaluateQualityGate({
    checks: [{ name: 'tests', passed: true, observed: false }],
  });
  assert.equal(required.passed, false);
  assert.deepEqual(required.failedChecks.map((check) => check.name), ['tests']);
  assert.deepEqual(required.reasons, ['quality check was not host-observed: tests']);

  const optional = evaluateQualityGate({
    checks: [{ name: 'advisory', passed: true, required: false, observed: false }],
  });
  assert.equal(optional.passed, true);
  assert.equal(optional.failedChecks.length, 0);
});

test('truthful report never infers success from status alone', () => {
  const failedQuality = evaluateQualityGate({ checks: [{ name: 'tests', passed: false, observed: true }] });
  const report = buildReport({ id: 'r', status: 'succeeded' }, {
    tasks: [{ status: 'succeeded' }], reviews: [], quality: failedQuality,
  });
  assert.equal(report.successful, false);
  assert.match(report.summary, /not verified/);
  const passed = buildReport({ id: 'r', status: 'succeeded' }, {
    tasks: [{ status: 'succeeded' }], reviews: [], quality: evaluateQualityGate({ checks: [{ name: 'tests', passed: true, observed: true }] }),
  });
  assert.equal(passed.successful, true);
  const incomplete = buildReport({ id: 'r', status: 'succeeded' }, {
    tasks: [{ status: 'succeeded' }, { status: 'planned' }],
    reviews: [],
    quality: evaluateQualityGate({ checks: [{ name: 'tests', passed: true, observed: true }] }),
  });
  assert.equal(incomplete.successful, false);
  assert.match(incomplete.summary, /not verified/);
  assert.deepEqual(incomplete.tasks, { total: 2, completed: 1, failed: 0 });
});

test('orchestration transitions are explicit, terminal, and bounded', () => {
  let state = createRunState();
  state = transition(state, 'planning');
  state = transition(state, 'running');
  state = transition(state, 'reviewing', { reviewLimit: 1 });
  state = transition(state, 'repairing', { repairLimit: 1 });
  state = transition(state, 'reviewing', { reviewLimit: 2, repairLimit: 1 });
  assert.deepEqual(state, { status: 'reviewing', reviews: 2, repairs: 1 });
  assert.throws(() => transition(state, 'repairing', { repairLimit: 1 }), TransitionError);
  assert.throws(() => transition(state, 'reviewing'), TransitionError);
  const failed = transition(state, 'failed');
  assert.equal(isTerminal(failed), true);
  assert.throws(() => transition(failed, 'running'), TransitionError);
});

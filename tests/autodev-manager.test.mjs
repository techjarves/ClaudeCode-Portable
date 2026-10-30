import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  AutoDevManager, AUTODEV_PHASES, AUTODEV_RESULT_SCHEMA, commandMode, createAutoDevManager, normalizeWorkPackages,
} from '../lib/autodev/manager.mjs';
import {
  ClaudeWorker, ClaudeWorkerAbortError, ClaudeWorkerProtocolError, ClaudeWorkerResultError,
  CLAUDE_WORKER_AGENTS,
} from '../lib/autodev/claude-worker.mjs';

function memoryLedger() {
  const runs = new Map();
  let sequence = 1;
  let clock = 0;
  let queue = Promise.resolve();
  const serialize = (operation) => {
    const result = queue.then(operation, operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };
  const event = (run, type, detail = {}) => {
    const value = { sequence: sequence++, at: `2026-10-27T00:00:${String(clock++).padStart(2, '0')}.000Z`, type, ...structuredClone(detail) };
    run.events.push(value);
    run.updatedAt = value.at;
  };
  const ledger = {
    create(input) {
      return serialize(() => {
        if (runs.has(input.id)) throw new Error('duplicate');
        const run = { ...structuredClone(input), createdAt: '2026-10-27T00:00:00.000Z', updatedAt: '2026-10-27T00:00:00.000Z', events: [] };
        event(run, 'created', { status: run.status });
        runs.set(run.id, run);
        return structuredClone(run);
      });
    },
    get(id) { return serialize(() => runs.has(id) ? structuredClone(runs.get(id)) : null); },
    list() { return serialize(() => [...runs.values()].map(structuredClone)); },
    update(id, patch, eventType = 'updated') { return ledger.mutate(id, () => patch, eventType); },
    mutate(id, updater, eventType = 'updated') {
      return serialize(async () => {
        const run = runs.get(id);
        if (!run) throw new Error(`unknown run: ${id}`);
        const patch = await updater(structuredClone(run));
        if (patch == null) return structuredClone(run);
        Object.assign(run, structuredClone(patch));
        event(run, eventType, { changes: structuredClone(patch) });
        return structuredClone(run);
      });
    },
  };
  return ledger;
}

const emptyResult = (overrides = {}) => ({
  status: 'succeeded', summary: 'ok', workPackages: [], changes: [], checks: [], findings: [], artifacts: [], criticalActions: [], ...overrides,
});

function fakeWorker(name, calls, respond) {
  return {
    async run(input) {
      calls.push({ backend: name, ...structuredClone({ ...input, signal: undefined, onEvent: undefined }) });
      input.onEvent?.({ type: 'worker', backend: name });
      return { final: emptyResult(await respond(input)), sessionId: `${name}-session` };
    },
    close() { calls.push({ backend: name, close: true }); },
  };
}

function reviewEvidence(item) {
  return {
    baseCommit: item.workspace?.baseHead ?? 'base',
    acceptedCommit: item.workspace?.commit ?? 'commit',
    branch: item.workspace?.branch ?? `autodev/${item.id}`,
    paths: [...item.paths],
    nameStatus: `M\0${item.paths[0]}\0`,
    patch: `diff --git a/${item.paths[0]} b/${item.paths[0]}`,
  };
}

function planPackage(backend = 'claude') {
  return {
    id: 'pkg', title: 'Implement feature', description: 'Make the requested change.', paths: ['lib/feature.mjs'], dependsOn: [],
    acceptanceCriteria: ['Focused tests pass.'], backend, gates: ['repository tests'],
  };
}

function managerHarness({ planBackend = 'claude', reviews = 1, workerRespond, workspaceComplete, validatorRespond } = {}) {
  const ledger = memoryLedger();
  const calls = [];
  const integrations = [];
  const workers = {
    claude: fakeWorker('claude', calls, async (input) => {
      if (workerRespond) return workerRespond('claude', input);
      if (input.role === 'planner') return { workPackages: [planPackage(planBackend)] };
      if (input.role === 'tester') return { checks: [{ name: 'repository tests', passed: true, required: true, detail: 'exit 0' }] };
      return {};
    }),
    codex: fakeWorker('codex', calls, async (input) => {
      if (workerRespond) return workerRespond('codex', input);
      return {};
    }),
  };
  const workspace = {
    async prepare({ package: item }) { return { cwd: `/owned/${item.id}`, name: `owned-${item.id}` }; },
    ...(workspaceComplete ? { complete: workspaceComplete } : {}),
    async reviewEvidence({ package: item }) { return reviewEvidence(item); },
    async integrate(input) { integrations.push(structuredClone({ ...input, signal: undefined })); return { success: true, artifacts: [{ type: 'commit', path: 'HEAD', description: 'integrated' }] }; },
  };
  const validator = async (input = {}) => validatorRespond
    ? validatorRespond(input)
    : ({ checks: [{
        name: input.package?.gates?.[0] ?? 'post-integration',
        passed: true,
        required: true,
        detail: 'exit 0',
      }] });
  const manager = new AutoDevManager({ ledger, workers, workspace, validator, repo: '/repo', limits: { reviews }, id: (() => { let id = 0; return () => `id-${++id}`; })() });
  return { manager, ledger, calls, integrations };
}

test('manager bounds event replay before subscribing listeners', async () => {
  const ledger = memoryLedger();
  await ledger.create({ id: 'history', status: 'queued' });
  for (let index = 0; index < 5; index += 1) {
    await ledger.update('history', { phase: String(index) }, 'phase');
  }
  const manager = new AutoDevManager({
    ledger,
    workers: { claude: fakeWorker('claude', [], async () => ({})) },
    repo: '/repo',
  });
  await assert.rejects(
    manager.events('history', { after: 0, limit: 3, listener: () => {} }),
    (error) => error.code === 'EVENT_REPLAY_LIMIT' && error.status === 409,
  );
  assert.equal((await manager.events('history', { after: 3, limit: 3 })).length, 3);
  await manager.close();
});

test('manager factory recovers persisted active runs before serving requests', async () => {
  let recovered = 0;
  const ledger = {
    ...memoryLedger(),
    async recover() { recovered++; return []; },
  };
  const manager = await createAutoDevManager({ ledger, workers: { claude: fakeWorker('claude', [], async () => ({})) }, repo: '/repo' });
  assert.equal(recovered, 0, 'an injected ledger is owned by its caller');
  await manager.close();

  const files = new Map([['/ledger.json', { version: 1, nextEvent: 2, runs: [{ id: 'active', status: 'running', events: [], createdAt: 'now', updatedAt: 'now' }] }]]);
  const recoveredManager = await createAutoDevManager({
    ledgerFile: '/ledger.json',
    ledgerOptions: {
      exists: (file) => files.has(file),
      readJSON: (file) => structuredClone(files.get(file)),
      writeJSON: (file, value) => files.set(file, structuredClone(value)),
      mkdir: () => {},
      clock: () => 'later',
    },
    workers: { claude: fakeWorker('claude', [], async () => ({})) },
    repo: '/repo',
  });
  assert.equal((await recoveredManager.status('active')).status, 'interrupted');
  assert.equal((await recoveredManager.status('active')).events.at(-1).type, 'recovered');
  await recoveredManager.close();
});

test('command modes and work-package schemas are deterministic and bounded', () => {
  assert.deepEqual(AUTODEV_PHASES, ['PLAN', 'DELEGATE', 'IMPLEMENT', 'TEST', 'REVIEW', 'FIX', 'INTEGRATE', 'VALIDATE', 'REPORT']);
  assert.equal(commandMode('/auto-dev build it'), 'auto-dev');
  assert.equal(commandMode('multi-review target'), 'multi-review');
  assert.equal(AUTODEV_RESULT_SCHEMA.additionalProperties, false);
  for (const name of ['artifacts', 'criticalActions']) {
    const item = AUTODEV_RESULT_SCHEMA.properties[name].items;
    assert.deepEqual(
      new Set(item.required),
      new Set(Object.keys(item.properties)),
      `${name} must satisfy strict provider schema rules`,
    );
  }
  const packages = normalizeWorkPackages([planPackage()], { maxTasks: 1 });
  assert.equal(packages[0].paths[0], 'lib/feature.mjs');
  assert.throws(() => normalizeWorkPackages([planPackage(), { ...planPackage(), id: 'two' }], { maxTasks: 1 }), /task limit/);
  assert.throws(() => normalizeWorkPackages([{ ...planPackage(), paths: ['../outside'] }]), /unsafe/);
  assert.throws(() => normalizeWorkPackages([{ ...planPackage(), dependsOn: ['missing'] }]), /missing/);
  assert.throws(() => normalizeWorkPackages([
    { ...planPackage(), id: 'one', dependsOn: ['two'] },
    { ...planPackage(), id: 'two', dependsOn: ['one'] },
  ]), /cycle/);
});

test('manager binds every run to its configured repository', async () => {
  const { manager } = managerHarness();
  const created = await manager.create({ id: 'bound-target', request: 'feature' });
  assert.equal(created.target, '/repo');
  await assert.rejects(
    manager.create({ id: 'wrong-target', request: 'feature', target: '/other' }),
    (error) => error.code === 'TARGET_MISMATCH',
  );
  await manager.close();
});

test('status mode is deterministic and does not invoke workers', async () => {
  const { manager, calls } = managerHarness();
  await manager.create({ id: 'status-run', mode: 'status' });
  const run = await manager.start('status-run');
  assert.equal(run.status, 'succeeded');
  assert.deepEqual(run.phaseHistory, ['REPORT']);
  assert.equal(run.report.successful, false);
  assert.equal(calls.length, 0);
  manager.close();
});

test('manager persists phases, enforces cross-model review, pauses for integration approval, resumes, validates, and reports truthfully', async () => {
  const { manager, calls, integrations } = managerHarness();
  const created = await manager.create({ id: 'run-1', mode: 'auto-dev', request: 'Implement feature', backend: 'claude' });
  assert.equal(created.status, 'queued');
  const pending = await manager.start('run-1');
  assert.equal(pending.status, 'pending_approval');
  assert.equal(pending.phase, 'INTEGRATE');
  assert.deepEqual(pending.phaseHistory, ['PLAN', 'DELEGATE', 'IMPLEMENT', 'TEST', 'REVIEW', 'INTEGRATE']);
  assert.deepEqual(calls.filter((call) => call.role === 'reviewer').map((call) => call.backend), ['codex']);
  assert.equal(integrations.length, 0);
  const approval = pending.approvals.find((item) => item.status === 'pending');
  assert.equal(approval.kind, 'destination-integration');
  await manager.approve('run-1', approval.id, true, 'approved by operator');
  const finished = await manager.resume('run-1');
  assert.equal(finished.status, 'succeeded');
  assert.equal(finished.report.successful, true);
  assert.equal(integrations.length, 1);
  assert.deepEqual(finished.phaseHistory.slice(-3), ['INTEGRATE', 'VALIDATE', 'REPORT']);
  manager.close();
});

test('manager persists an exact integration intent before apply and cleanup', async () => {
  const ledger = memoryLedger();
  const calls = [];
  const worker = fakeWorker('claude', calls, async (input) => {
    if (input.role === 'planner') return { workPackages: [planPackage('claude')] };
    if (input.role === 'tester') return { checks: [{ name: 'repository tests', passed: true, required: true, detail: 'exit 0' }] };
    return {};
  });
  const order = [];
  let intentPersisted = false;
  let integratedPersisted = false;
  const baseMutate = ledger.mutate.bind(ledger);
  ledger.mutate = (id, updater, eventType) => baseMutate(id, async (current) => {
    const patch = await updater(current);
    if (eventType === 'integration_intent') intentPersisted = Boolean(patch.integrationIntent?.approvalDigest);
    if (eventType === 'integrated') integratedPersisted = patch.integrated === true;
    order.push(eventType);
    return patch;
  }, eventType);
  const intent = {
    version: 1, state: 'prepared', expectedHead: 'a'.repeat(40), stagedHead: 'b'.repeat(40),
    staging: { name: 'staging' }, packages: [{ id: 'pkg', name: 'owned-pkg', commit: 'c'.repeat(40) }], artifacts: [],
  };
  const workspace = {
    prepare: async () => ({ cwd: '/owned/pkg', name: 'owned-pkg', commit: 'c'.repeat(40) }),
    reviewEvidence: async ({ package: item }) => reviewEvidence(item),
    prepareIntegration: async () => cloneForTest(intent),
    reconcileIntegration: async () => ({ state: 'not_applied', head: intent.expectedHead }),
    applyIntegration: async () => {
      assert.equal(intentPersisted, true);
      order.push('apply');
      return { success: true, state: 'applied', head: 'd'.repeat(40), stagedHead: intent.stagedHead, artifacts: [] };
    },
    cleanupIntegration: async () => {
      assert.equal(integratedPersisted, true);
      order.push('cleanup');
    },
  };
  const manager = new AutoDevManager({
    ledger, workers: { claude: worker, codex: fakeWorker('codex', calls, async () => ({})) }, workspace,
    validator: async ({ package: item } = {}) => ({ checks: [{ name: item?.gates?.[0] ?? 'validation', passed: true, required: true, detail: 'exit 0' }] }),
    repo: '/repo', limits: { reviews: 1 }, id: (() => { let id = 0; return () => `intent-${++id}`; })(),
  });
  await manager.create({ id: 'intent-run', request: 'feature' });
  const pending = await manager.start('intent-run');
  assert.equal(pending.status, 'pending_approval');
  assert.ok(pending.integrationIntent.approvalDigest);
  const approval = pending.approvals.find((item) => item.kind === 'destination-integration');
  assert.equal(approval.digest, pending.integrationIntent.approvalDigest);
  await manager.approve('intent-run', approval.id, true);
  const finished = await manager.resume('intent-run');
  assert.equal(finished.status, 'succeeded');
  assert.equal(finished.integrated, true);
  assert.equal(finished.integrationIntent.state, 'complete');
  assert.ok(order.indexOf('integration_intent') < order.indexOf('apply'));
  assert.ok(order.indexOf('integrated') < order.indexOf('validation_gate'));
  assert.ok(order.indexOf('validation_gate') < order.indexOf('cleanup'));
  await manager.close();
});

test('manager retains integration work when final validation fails', async () => {
  const ledger = memoryLedger();
  const calls = [];
  const intent = {
    version: 1, state: 'prepared', expectedHead: 'a'.repeat(40), stagedHead: 'b'.repeat(40),
    staging: { name: 'staging' }, packages: [{ id: 'pkg', name: 'owned-pkg', commit: 'c'.repeat(40) }], artifacts: [],
  };
  let cleanup = 0;
  let validationRound = 0;
  const worker = fakeWorker('claude', calls, async (input) => {
    if (input.role === 'planner') return { workPackages: [planPackage('claude')] };
    return {};
  });
  const manager = new AutoDevManager({
    ledger,
    workers: { claude: worker, codex: fakeWorker('codex', calls, async () => ({})) },
    workspace: {
      prepare: async () => ({ cwd: '/owned/pkg', name: 'owned-pkg', commit: 'c'.repeat(40) }),
      reviewEvidence: async ({ package: item }) => reviewEvidence(item),
      prepareIntegration: async () => cloneForTest(intent),
      reconcileIntegration: async () => ({ state: 'not_applied', head: intent.expectedHead }),
      applyIntegration: async () => ({ success: true, state: 'applied', head: 'd'.repeat(40), stagedHead: intent.stagedHead, artifacts: [] }),
      cleanupIntegration: async () => { cleanup++; },
    },
    validator: async ({ package: item, cwd } = {}) => {
      if (item) return { checks: [{ name: item.gates[0], passed: true, required: true, detail: 'pass' }] };
      if (cwd === '/repo') {
        validationRound++;
        return { checks: [{ name: 'validation', passed: false, required: true, detail: 'controlled final failure' }] };
      }
      return { checks: [{ name: 'validation', passed: true, required: true, detail: 'pass' }] };
    },
    repo: '/repo', limits: { reviews: 1 }, id: (() => { let value = 0; return () => `retain-${++value}`; })(),
  });

  await manager.create({ id: 'validation-retains-work', request: 'feature' });
  const pending = await manager.start('validation-retains-work');
  const approval = pending.approvals.find((item) => item.kind === 'destination-integration');
  await manager.approve('validation-retains-work', approval.id, true);
  const blocked = await manager.resume('validation-retains-work');
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.errorCode, 'VALIDATION_FAILED');
  assert.equal(blocked.integrated, true);
  assert.equal(blocked.integrationIntent.state, 'cleanup_pending');
  assert.equal(blocked.finalValidation, undefined);
  assert.equal(validationRound, 1);
  assert.equal(cleanup, 0);
  await manager.close();
});

test('manager blocks on cleanup failure and resumes cleanup without rerunning validation', async () => {
  const ledger = memoryLedger();
  const calls = [];
  const intent = {
    version: 1, state: 'prepared', expectedHead: 'a'.repeat(40), stagedHead: 'b'.repeat(40),
    staging: { name: 'staging' }, packages: [{ id: 'pkg', name: 'owned-pkg', commit: 'c'.repeat(40) }], artifacts: [],
  };
  let cleanupCalls = 0;
  let finalValidations = 0;
  const worker = fakeWorker('claude', calls, async (input) => {
    if (input.role === 'planner') return { workPackages: [planPackage('claude')] };
    return {};
  });
  const manager = new AutoDevManager({
    ledger,
    workers: { claude: worker, codex: fakeWorker('codex', calls, async () => ({})) },
    workspace: {
      prepare: async () => ({ cwd: '/owned/pkg', name: 'owned-pkg', commit: 'c'.repeat(40) }),
      reviewEvidence: async ({ package: item }) => reviewEvidence(item),
      prepareIntegration: async () => cloneForTest(intent),
      reconcileIntegration: async () => ({ state: 'not_applied', head: intent.expectedHead }),
      applyIntegration: async () => ({ success: true, state: 'applied', head: 'd'.repeat(40), stagedHead: intent.stagedHead, artifacts: [] }),
      cleanupIntegration: async () => {
        cleanupCalls++;
        if (cleanupCalls === 1) throw new Error('controlled cleanup failure');
      },
    },
    validator: async ({ package: item, cwd } = {}) => {
      if (item) return { checks: [{ name: item.gates[0], passed: true, required: true, detail: 'pass' }] };
      if (cwd === '/repo') finalValidations++;
      return { checks: [{ name: 'validation', passed: true, required: true, detail: 'pass' }] };
    },
    repo: '/repo', limits: { reviews: 1 }, id: (() => { let value = 0; return () => `cleanup-${++value}`; })(),
  });

  await manager.create({ id: 'cleanup-resume', request: 'feature' });
  const pending = await manager.start('cleanup-resume');
  const approval = pending.approvals.find((item) => item.kind === 'destination-integration');
  await manager.approve('cleanup-resume', approval.id, true);
  const blocked = await manager.resume('cleanup-resume');
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.errorCode, 'INTEGRATION_CLEANUP_FAILED');
  assert.equal(blocked.integrationIntent.state, 'cleanup_pending');
  assert.equal(blocked.finalValidation.passed, true);
  assert.match(blocked.integrationCleanupFailure, /controlled cleanup failure/);
  assert.equal(finalValidations, 1);

  const callIndex = calls.length;
  const finished = await manager.resume('cleanup-resume');
  assert.equal(finished.status, 'succeeded');
  assert.equal(finished.integrationIntent.state, 'complete');
  assert.equal(finished.integrationCleanupFailure, null);
  assert.equal(cleanupCalls, 2);
  assert.equal(finalValidations, 1, 'cleanup-only resume must not rerun validation');
  assert.equal(calls.length, callIndex, 'cleanup-only resume must not invoke workers');
  await manager.close();
});

test('manager reconciles already-applied integration and does not apply twice', async () => {
  const ledger = memoryLedger();
  const calls = [];
  const intent = {
    version: 1, state: 'prepared', expectedHead: 'a'.repeat(40), stagedHead: 'b'.repeat(40),
    staging: { name: 'staging' }, packages: [{ id: 'pkg', name: 'owned-pkg', commit: 'c'.repeat(40) }], artifacts: [],
  };
  let applies = 0;
  const worker = fakeWorker('claude', calls, async (input) => {
    if (input.role === 'planner') return { workPackages: [planPackage('claude')] };
    if (input.role === 'tester') return { checks: [{ name: 'repository tests', passed: true, required: true, detail: 'exit 0' }] };
    return {};
  });
  const workspace = {
    prepare: async () => ({ cwd: '/owned/pkg', name: 'owned-pkg', commit: 'c'.repeat(40) }),
    reviewEvidence: async ({ package: item }) => reviewEvidence(item),
    prepareIntegration: async () => cloneForTest(intent),
    reconcileIntegration: async () => ({ state: 'applied', head: 'd'.repeat(40) }),
    applyIntegration: async () => { applies++; return { success: true }; },
    cleanupIntegration: async () => {},
  };
  const manager = new AutoDevManager({
    ledger, workers: { claude: worker, codex: fakeWorker('codex', calls, async () => ({})) }, workspace,
    validator: async ({ package: item } = {}) => ({ checks: [{ name: item?.gates?.[0] ?? 'validation', passed: true, required: true, detail: 'exit 0' }] }),
    repo: '/repo', limits: { reviews: 1 }, id: (() => { let id = 0; return () => `reconcile-${++id}`; })(),
  });
  await manager.create({ id: 'reconcile-run', request: 'feature' });
  const pending = await manager.start('reconcile-run');
  const approval = pending.approvals.find((item) => item.kind === 'destination-integration');
  await manager.approve('reconcile-run', approval.id, true);
  const finished = await manager.resume('reconcile-run');
  assert.equal(finished.status, 'succeeded');
  assert.equal(applies, 0);
  await manager.close();
});

function cloneForTest(value) { return structuredClone(value); }

test('multi-review and deep-review modes are deterministic, read-only, and cross-model', async () => {
  for (const selectedMode of ['multi-review', 'deep-review']) {
    const { manager, calls, integrations } = managerHarness({ reviews: 2 });
    await manager.create({ id: `${selectedMode}-run`, mode: selectedMode, request: 'Review feature', backend: 'claude' });
    const run = await manager.start(`${selectedMode}-run`);
    assert.equal(run.status, 'succeeded');
    assert.equal(calls.some((call) => call.role === 'implementer' || call.role === 'tester' || call.role === 'fixer'), false);
    assert.equal(calls.filter((call) => call.role === 'reviewer').length, 2);
    assert.equal(calls.filter((call) => call.role === 'reviewer').every((call) => call.backend === 'codex'), true);
    assert.equal(integrations.length, 0);
    manager.close();
  }
});

test('manager event API replays persisted events then streams live events', async () => {
  const { manager } = managerHarness();
  await manager.create({ id: 'event-run', request: 'Implement feature' });
  const seen = [];
  const unsubscribe = await manager.events('event-run', { listener: (event) => seen.push(event) });
  assert.equal(seen[0].type, 'created');
  const pending = await manager.start('event-run');
  assert.equal(seen.some((event) => event.type === 'approval_required'), true);
  assert.deepEqual(await manager.events('event-run', { after: pending.events.at(-2).sequence }), [pending.events.at(-1)]);
  unsubscribe();
  manager.close();
});

test('manager blocks when cross-model reviewer or validation evidence is unavailable and never integrates', async () => {
  const ledger = memoryLedger();
  const calls = [];
  const claude = fakeWorker('claude', calls, async (input) => {
    if (input.role === 'planner') return { workPackages: [planPackage('claude')] };
    if (input.role === 'tester') return { checks: [{ name: 'repository tests', passed: true, required: true, detail: 'ok' }] };
    return {};
  });
  let integrated = false;
  const manager = new AutoDevManager({
    ledger, workers: { claude }, repo: '/repo', limits: { reviews: 1 },
    workspace: { prepare: async () => ({ cwd: '/owned/pkg' }), integrate: async () => { integrated = true; return { success: true }; } },
    validator: async () => ({ checks: [] }), id: () => 'approval',
  });
  await manager.create({ id: 'blocked', request: 'feature', backend: 'claude' });
  const run = await manager.start('blocked');
  assert.equal(run.status, 'blocked');
  assert.equal(run.errorCode, 'BACKEND_UNAVAILABLE');
  assert.equal(integrated, false);
  assert.equal(run.report.successful, false);
  manager.close();
});

test('manager repairs bounded failures, finalizes fixes, and blocks instead of falsely claiming success', async () => {
  let tests = 0;
  const completions = [];
  const { manager, integrations } = managerHarness({
    reviews: 1,
    workspaceComplete: async ({ workspace }) => {
      completions.push(workspace.commit ?? null);
      return { ...workspace, commit: `commit-${completions.length}` };
    },
    validatorRespond: async ({ package: item } = {}) => ({
      checks: [{
        name: item?.gates?.[0] ?? 'validation',
        passed: item ? false : true,
        required: true,
        detail: item ? 'failed' : 'exit 0',
      }],
    }),
    workerRespond: async (backend, input) => {
      if (input.role === 'planner') return { workPackages: [planPackage('claude')] };
      if (input.role === 'tester') {
        tests++;
        return { checks: [{ name: 'repository tests', passed: true, required: true, detail: 'untrusted assertion' }] };
      }
      if (input.role === 'reviewer') assert.equal(backend, 'codex');
      return {};
    },
  });
  await manager.create({ id: 'repair-run', request: 'feature', limits: { repairs: 1 } });
  const run = await manager.start('repair-run');
  assert.equal(run.status, 'blocked');
  assert.equal(run.repairCount, 1);
  assert.equal(run.report.successful, false);
  assert.equal(integrations.length, 0);
  assert.equal(tests, 2);
  assert.deepEqual(completions, [null, 'commit-1']);
  assert.equal(run.packages[0].workspace.commit, 'commit-2');
  manager.close();
});

test('manager resumes an interrupted repair checkpoint without repeating completed fixes or pre-repair gates', async () => {
  const ledger = memoryLedger();
  const calls = [];
  const repaired = new Set();
  let interruptSecond = true;
  const packages = [
    { ...planPackage('claude'), id: 'first', paths: ['lib/first.mjs'] },
    { ...planPackage('claude'), id: 'second', paths: ['lib/second.mjs'] },
  ];
  const claude = fakeWorker('claude', calls, async (input) => {
    if (input.role === 'planner') return { workPackages: packages };
    if (input.role === 'tester') return {};
    if (input.role === 'fixer') {
      const id = input.prompt.includes('"id":"first"') ? 'first' : 'second';
      if (id === 'second' && interruptSecond) {
        interruptSecond = false;
        throw new Error('simulated interruption');
      }
      repaired.add(id);
    }
    return {};
  });
  const workspace = {
    prepare: async ({ package: item }) => ({ cwd: `/owned/${item.id}`, name: item.id }),
    complete: async ({ workspace: owned }) => ({ ...owned, commit: `${owned.name}-${repaired.has(owned.name) ? 'fixed' : 'initial'}` }),
    reviewEvidence: async ({ package: item }) => reviewEvidence(item),
    integrate: async () => ({ success: true }),
  };
  const manager = new AutoDevManager({
    ledger,
    workers: {
      claude,
      codex: fakeWorker('codex', calls, async () => ({})),
    },
    workspace,
    validator: async ({ package: item } = {}) => ({ checks: [{
      name: item?.gates?.[0] ?? 'validation',
      passed: item ? repaired.has(item.id) : true,
      required: true,
      detail: item && !repaired.has(item.id) ? 'controlled failure' : 'pass',
    }] }),
    repo: '/repo',
    limits: { reviews: 1, repairs: 1 },
    id: (() => { let value = 0; return () => `checkpoint-${++value}`; })(),
  });

  await manager.create({ id: 'repair-checkpoint', request: 'feature' });
  const interrupted = await manager.start('repair-checkpoint');
  assert.equal(interrupted.status, 'failed');
  assert.equal(interrupted.repairCount, 1);
  assert.deepEqual(interrupted.repairState.completed, ['first']);
  assert.deepEqual([...repaired], ['first']);

  await ledger.update('repair-checkpoint', { status: 'interrupted' }, 'recovered');
  const resumeIndex = calls.length;
  const pending = await manager.resume('repair-checkpoint');
  const resumedCalls = calls.slice(resumeIndex);
  assert.equal(pending.status, 'pending_approval');
  assert.deepEqual([...repaired].sort(), ['first', 'second']);
  assert.equal(resumedCalls.filter((call) => call.role === 'fixer').length, 1);
  assert.match(resumedCalls.find((call) => call.role === 'fixer').prompt, /"id":"second"/);
  assert.equal(resumedCalls[0].role, 'fixer', 'remaining repair must run before tests and reviews');
  assert.equal(pending.repairState, null);
  await manager.close();
});

test('manager ignores fabricated worker passes and requires host-observed package gates', async () => {
  const { manager, integrations } = managerHarness({
    reviews: 1,
    validatorRespond: async ({ package: item } = {}) => ({
      checks: [{
        name: item?.gates?.[0] ?? 'validation',
        passed: item ? false : true,
        required: true,
        detail: item ? 'host observed exit 1' : 'exit 0',
      }],
    }),
    workspaceComplete: async ({ workspace }) => ({ ...workspace, commit: 'commit' }),
    workerRespond: async (_backend, input) => {
      if (input.role === 'planner') return { workPackages: [planPackage('claude')] };
      if (input.role === 'tester') {
        return { checks: [{ name: 'repository tests', passed: true, required: true, detail: 'claimed pass' }] };
      }
      return {};
    },
  });
  await manager.create({ id: 'fabricated-check', request: 'feature', limits: { repairs: 1 } });
  const run = await manager.start('fabricated-check');
  assert.equal(run.status, 'blocked');
  assert.equal(run.errorCode, 'QUALITY_FAILED');
  assert.equal(run.checks.find((check) => check.name === 'repository tests')?.passed, false);
  assert.equal(run.checks.find((check) => check.name === 'repository tests')?.observed, true);
  assert.equal(integrations.length, 0);
  await manager.close();
});

test('manager rejects empty and unknown writable gate IDs before workspace preparation', async () => {
  for (const [gates, errorCode] of [
    [[], 'GATE_REQUIRED'],
    [['not-registered'], 'UNKNOWN_GATE'],
  ]) {
    const ledger = memoryLedger();
    let prepared = 0;
    const worker = fakeWorker('claude', [], async (input) => input.role === 'planner'
      ? { workPackages: [{ ...planPackage('claude'), gates }] }
      : {});
    const manager = new AutoDevManager({
      ledger,
      workers: { claude: worker },
      workspace: { async prepare() { prepared++; return { cwd: '/owned/pkg' }; } },
      validator: async () => ({ checks: [] }),
      repo: '/repo',
    });
    await manager.create({ id: `gate-${errorCode}`, request: 'feature' });
    const run = await manager.start(`gate-${errorCode}`);
    assert.equal(run.status, 'blocked');
    assert.equal(run.errorCode, errorCode);
    assert.equal(prepared, 0);
    await manager.close();
  }
});

test('manager requires exact host evidence for each named package gate', async () => {
  const { manager, integrations } = managerHarness({
    reviews: 1,
    workspaceComplete: async ({ workspace }) => ({ ...workspace, commit: 'commit' }),
    validatorRespond: async ({ package: item } = {}) => ({
      checks: [{
        name: item ? 'repository checks' : 'validation',
        passed: true,
        required: true,
        detail: 'exit 0',
      }],
    }),
    workerRespond: async (_backend, input) => {
      if (input.role === 'planner') return { workPackages: [planPackage('claude')] };
      return {};
    },
  });
  await manager.create({ id: 'missing-exact-gate', request: 'feature', limits: { repairs: 1 } });
  const run = await manager.start('missing-exact-gate');
  assert.equal(run.status, 'blocked');
  assert.equal(run.errorCode, 'QUALITY_FAILED');
  assert.deepEqual(run.checks.find((check) => check.name === 'repository tests'), {
    name: 'repository tests',
    passed: false,
    required: true,
    detail: 'Required gate has no exact host-observed result.',
    observed: false,
    packageId: 'pkg',
  });
  assert.equal(run.checks.find((check) => check.name === 'repository checks').observed, true);
  assert.equal(integrations.length, 0);
  await manager.close();
});

test('manager routes verified package failures only to their owning fixer', async () => {
  const ledger = memoryLedger();
  const fixerPackages = [];
  let testRound = 0;
  const workers = {
    claude: fakeWorker('claude', [], async (input) => {
      if (input.role === 'planner') {
        return {
          workPackages: [
            { ...planPackage('claude'), id: 'claude-package', paths: ['lib/claude.mjs'] },
            { ...planPackage('codex'), id: 'codex-package', paths: ['lib/codex.mjs'] },
          ],
        };
      }
      if (input.role === 'tester') {
        testRound++;
        return { checks: [{ name: 'repository tests', passed: true, required: true, detail: 'pass' }] };
      }
      if (input.role === 'fixer') fixerPackages.push('claude-package');
      return {};
    }),
    codex: fakeWorker('codex', [], async (input) => {
      if (input.role === 'tester') {
        testRound++;
        return { checks: [{ name: 'repository tests', passed: testRound > 2, required: true, detail: testRound > 2 ? 'pass' : 'controlled failure' }] };
      }
      if (input.role === 'fixer') {
        assert.match(input.prompt, /"id":"codex-package"/);
        assert.match(input.prompt, /"paths":\["lib\/codex\.mjs"\]/);
        fixerPackages.push('codex-package');
      }
      return {};
    }),
  };
  const manager = new AutoDevManager({
    ledger,
    workers,
    workspace: {
      prepare: async ({ package: item }) => ({ cwd: `/owned/${item.id}`, name: item.id }),
      complete: async ({ workspace }) => ({ ...workspace, commit: `${workspace.name}-commit` }),
      reviewEvidence: async ({ package: item }) => reviewEvidence(item),
      integrate: async () => ({ success: true }),
    },
    validator: async ({ package: item } = {}) => ({ checks: [{
      name: item?.gates?.[0] ?? 'validation',
      passed: item?.id !== 'codex-package' || testRound > 2,
      required: true,
      detail: item?.id === 'codex-package' && testRound <= 2 ? 'controlled failure' : 'pass',
    }] }),
    repo: '/repo',
    limits: { reviews: 1, repairs: 1 },
    id: (() => { let value = 0; return () => `owner-${++value}`; })(),
  });
  await manager.create({ id: 'owner-repair', request: 'feature' });
  const pending = await manager.start('owner-repair');
  assert.deepEqual(fixerPackages, ['codex-package']);
  assert.equal(pending.status, 'pending_approval');
  const approval = pending.approvals.find((item) => item.kind === 'destination-integration');
  await manager.approve('owner-repair', approval.id, true);
  const finished = await manager.resume('owner-repair');
  assert.equal(finished.status, 'succeeded');
  await manager.close();
});

test('manager rejects writable work without an explicit path scope', async () => {
  const ledger = memoryLedger();
  const worker = fakeWorker('claude', [], async (input) => {
    if (input.role === 'planner') return { workPackages: [{ ...planPackage('claude'), paths: [] }] };
    return {};
  });
  let prepared = false;
  const manager = new AutoDevManager({
    ledger,
    workers: { claude: worker },
    workspace: { prepare: async () => { prepared = true; return { cwd: '/owned/pkg' }; } },
    repo: '/repo',
  });
  await manager.create({ id: 'unscoped-run', request: 'feature' });
  const run = await manager.start('unscoped-run');
  assert.equal(run.status, 'blocked');
  assert.equal(run.errorCode, 'PATH_SCOPE_REQUIRED');
  assert.equal(prepared, false);
  await manager.close();
});

test('manager checkpoints prepared workspaces before invoking implementers', async () => {
  const ledger = memoryLedger();
  let checkpointed = false;
  const baseMutate = ledger.mutate.bind(ledger);
  ledger.mutate = async (id, updater, eventType) => baseMutate(id, async (current) => {
    const patch = await updater(current);
    if (eventType === 'workspace_prepared') {
      checkpointed = patch.packages[0].status === 'implementing' && patch.packages[0].workspace.cwd === '/owned/pkg';
    }
    return patch;
  }, eventType);
  const worker = fakeWorker('claude', [], async (input) => {
    if (input.role === 'planner') return { workPackages: [planPackage('claude')] };
    if (input.role === 'implementer') {
      assert.equal(checkpointed, true);
      assert.match(
        input.prompt,
        /Do not run gate commands; host-owned validation/,
      );
    }
    return {};
  });
  const manager = new AutoDevManager({
    ledger,
    workers: { claude: worker },
    workspace: { prepare: async () => ({ cwd: '/owned/pkg', name: 'pkg' }) },
    repo: '/repo',
    limits: { reviews: 1 },
    validator: async ({ package: item } = {}) => ({ checks: [{ name: item?.gates?.[0] ?? 'validation', passed: true, required: true, detail: 'pass' }] }),
  });
  await manager.create({ id: 'checkpoint-run', request: 'feature' });
  const run = await manager.start('checkpoint-run');
  assert.equal(checkpointed, true);
  assert.equal(run.errorCode, 'BACKEND_UNAVAILABLE');
  await manager.close();
});

test('manager finalizes completed workspaces before dependent waves start', async () => {
  const ledger = memoryLedger();
  const calls = [];
  const worker = fakeWorker('claude', calls, async (input) => {
    if (input.role === 'planner') {
      return {
        workPackages: [
          { ...planPackage('claude'), id: 'first', paths: ['lib/first.mjs'] },
          { ...planPackage('claude'), id: 'second', paths: ['lib/second.mjs'], dependsOn: ['first'] },
        ],
      };
    }
    return {};
  });
  const completed = [];
  const prepared = [];
  const manager = new AutoDevManager({
    ledger,
    workers: { claude: worker },
    workspace: {
      async prepare({ run, package: item }) {
        if (item.id === 'second') {
          assert.deepEqual(completed, ['first']);
          assert.equal(run.packages.find((entry) => entry.id === 'first').workspace.commit, 'first-commit');
        }
        prepared.push(item.id);
        return { cwd: `/owned/${item.id}`, name: item.id };
      },
      async complete({ package: item, workspace }) {
        completed.push(item.id);
        return { ...workspace, commit: `${item.id}-commit` };
      },
    },
    repo: '/repo',
    limits: { reviews: 1 },
    validator: async ({ package: item } = {}) => ({ checks: [{ name: item?.gates?.[0] ?? 'validation', passed: true, required: true, detail: 'pass' }] }),
  });
  await manager.create({ id: 'dependency-run', request: 'feature' });
  const run = await manager.start('dependency-run');
  assert.deepEqual(prepared, ['first', 'second']);
  assert.deepEqual(completed, ['first', 'second']);
  assert.equal(run.packages.every((item) => item.workspace.commit), true);
  assert.equal(run.status, 'blocked');
  assert.equal(run.errorCode, 'BACKEND_UNAVAILABLE');
  await manager.close();
});

test('manager selects role-specific Codex sandboxes', async () => {
  const calls = [];
  const ledger = memoryLedger();
  const workers = {
    claude: fakeWorker('claude', calls, async (input) => input.role === 'reviewer' ? {} : { workPackages: [planPackage('codex')] }),
    codex: fakeWorker('codex', calls, async (input) => input.role === 'tester'
      ? { checks: [{ name: 'repository tests', passed: true, required: true, detail: 'ok' }] }
      : {}),
  };
  const manager = new AutoDevManager({
    ledger,
    workers,
    workspace: {
      prepare: async () => ({ cwd: '/owned/pkg' }),
      reviewEvidence: async ({ package: item }) => reviewEvidence(item),
    },
    repo: '/repo',
    limits: { reviews: 1 },
    validator: async ({ package: item } = {}) => ({ checks: [{ name: item?.gates?.[0] ?? 'validation', passed: true, required: true, detail: 'pass' }] }),
  });
  await manager.create({ id: 'sandboxes', request: 'feature', backend: 'claude' });
  await manager.start('sandboxes');
  const byRole = Object.fromEntries(calls.filter(call => call.role).map(call => [call.role, call.sandbox]));
  assert.equal(byRole.planner, 'read-only');
  assert.equal(byRole.implementer, 'workspace-write');
  assert.equal(byRole.tester, 'read-only');
  assert.equal(byRole.reviewer, 'read-only');
  await manager.close();
});

test('manager runs independent non-overlapping packages concurrently within its limit', async () => {
  const ledger = memoryLedger();
  let active = 0;
  let peak = 0;
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  let entered = 0;
  const worker = fakeWorker('claude', [], async (input) => {
    if (input.role === 'planner') {
      return {
        workPackages: [
          { ...planPackage('claude'), id: 'one', paths: ['lib/one.mjs'] },
          { ...planPackage('claude'), id: 'two', paths: ['lib/two.mjs'] },
        ],
      };
    }
    if (input.role === 'implementer') {
      active++;
      peak = Math.max(peak, active);
      entered++;
      if (entered === 2) release();
      await waiting;
      active--;
    }
    return {};
  });
  const manager = new AutoDevManager({
    ledger,
    workers: { claude: worker },
    workspace: { prepare: async ({ package: item }) => ({ cwd: `/owned/${item.id}` }) },
    repo: '/repo',
    limits: { concurrency: 2, reviews: 1 },
    validator: async ({ package: item } = {}) => ({ checks: [{ name: item?.gates?.[0] ?? 'validation', passed: true, required: true, detail: 'pass' }] }),
  });
  await manager.create({ id: 'parallel-run', request: 'feature' });
  const run = await manager.start('parallel-run');
  assert.equal(peak, 2);
  assert.equal(run.status, 'blocked');
  assert.equal(run.errorCode, 'BACKEND_UNAVAILABLE');
  assert.equal(run.packages.every((item) => item.status === 'succeeded'), true);
  await manager.close();
});

test('manager serializes packages with overlapping paths', async () => {
  const ledger = memoryLedger();
  let active = 0;
  let peak = 0;
  const worker = fakeWorker('claude', [], async (input) => {
    if (input.role === 'planner') {
      return {
        workPackages: [
          { ...planPackage('claude'), id: 'one', paths: ['lib'] },
          { ...planPackage('claude'), id: 'two', paths: ['lib/two.mjs'] },
        ],
      };
    }
    if (input.role === 'implementer') {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
    }
    return {};
  });
  const manager = new AutoDevManager({
    ledger,
    workers: { claude: worker },
    workspace: { prepare: async ({ package: item }) => ({ cwd: `/owned/${item.id}` }) },
    repo: '/repo',
    limits: { concurrency: 2, reviews: 1 },
    validator: async ({ package: item } = {}) => ({ checks: [{ name: item?.gates?.[0] ?? 'validation', passed: true, required: true, detail: 'pass' }] }),
  });
  await manager.create({ id: 'overlap-run', request: 'feature' });
  const run = await manager.start('overlap-run');
  assert.equal(peak, 1);
  assert.equal(run.status, 'blocked');
  assert.equal(run.errorCode, 'BACKEND_UNAVAILABLE');
  await manager.close();
});

test('manager records worker-requested critical actions as pending and refuses blind execution', async () => {
  const { manager, integrations } = managerHarness({
    reviews: 1,
    workerRespond: async (_backend, input) => {
      if (input.role === 'planner') return { workPackages: [planPackage('claude')] };
      if (input.role === 'implementer') return { criticalActions: [{ id: 'publish', action: 'publish', summary: 'Publish package', command: 'npm publish' }] };
      return {};
    },
  });
  await manager.create({ id: 'critical-run', request: 'publish feature' });
  const run = await manager.start('critical-run');
  assert.equal(run.status, 'pending_approval');
  const approval = run.approvals.find((item) => item.kind === 'worker-critical-action');
  assert.equal(approval.action, 'publish');
  assert.match(approval.id, /^approval-/);
  assert.notEqual(approval.id, 'publish');
  assert.equal(approval.request.id, 'publish');
  await assert.rejects(manager.approve('critical-run', approval.id, true), /will not execute them blindly/);
  assert.equal(integrations.length, 0);
  manager.close();
});

test('manager allocates unique approval IDs for duplicate worker action IDs', async () => {
  const { manager } = managerHarness({
    workerRespond: async (_backend, input) => {
      if (input.role === 'planner') return { workPackages: [planPackage('claude')] };
      if (input.role === 'implementer') {
        return {
          criticalActions: [
            { id: 'duplicate', action: 'publish', summary: 'First' },
            { id: 'duplicate', action: 'publish', summary: 'Second' },
          ],
        };
      }
      return {};
    },
  });
  await manager.create({ id: 'duplicate-actions', request: 'feature' });
  const run = await manager.start('duplicate-actions');
  const approvals = run.approvals.filter((item) => item.kind === 'worker-critical-action');
  assert.deepEqual(approvals.map((item) => item.request.id), ['duplicate', 'duplicate']);
  assert.equal(new Set(approvals.map((item) => item.id)).size, 2);
  assert.equal(approvals.every((item) => item.id.startsWith('approval-')), true);
  assert.equal(approvals.every((item) => item.id !== 'duplicate'), true);
  await manager.close();
});

test('manager records fixer-requested critical actions before committing repairs', async () => {
  let tests = 0;
  let hostChecks = 0;
  let completions = 0;
  const { manager, integrations } = managerHarness({
    reviews: 1,
    workspaceComplete: async ({ workspace }) => {
      completions++;
      return { ...workspace, commit: `commit-${completions}` };
    },
    validatorRespond: async ({ package: item } = {}) => {
      if (!item) return { checks: [{ name: 'validation', passed: true, required: true, detail: 'pass' }] };
      hostChecks++;
      return { checks: [{
        name: item.gates[0],
        passed: hostChecks > 1,
        required: true,
        detail: hostChecks > 1 ? 'pass' : 'fail',
      }] };
    },
    workerRespond: async (_backend, input) => {
      if (input.role === 'planner') return { workPackages: [planPackage('claude')] };
      if (input.role === 'tester') {
        tests++;
        return { checks: [{ name: 'repository tests', passed: true, required: true, detail: 'advisory' }] };
      }
      if (input.role === 'fixer') {
        return { criticalActions: [{ id: 'deploy-fix', action: 'deploy', summary: 'Deploy repair', command: 'deploy repair' }] };
      }
      return {};
    },
  });
  await manager.create({ id: 'fixer-critical', request: 'feature', limits: { repairs: 1 } });
  const run = await manager.start('fixer-critical');
  assert.equal(run.status, 'pending_approval');
  const approval = run.approvals.find((item) => item.request?.id === 'deploy-fix');
  assert.equal(approval?.kind, 'worker-critical-action');
  assert.match(approval.id, /^approval-/);
  assert.notEqual(approval.id, 'deploy-fix');
  assert.equal(completions, 1, 'repair workspace was not finalized after the critical action request');
  assert.equal(integrations.length, 0);
  await manager.close();
});

test('manager atomically claims starts and approval decisions', async () => {
  const { manager } = managerHarness();
  await manager.create({ id: 'atomic-run', request: 'feature' });
  const starts = await Promise.allSettled([
    manager.start('atomic-run'),
    manager.start('atomic-run'),
  ]);
  assert.equal(starts.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(starts.filter((result) => result.status === 'rejected').length, 1);
  const pending = starts.find((result) => result.status === 'fulfilled').value;
  const approval = pending.approvals.find((item) => item.kind === 'destination-integration');
  const decisions = await Promise.allSettled([
    manager.approve('atomic-run', approval.id, true, 'approve'),
    manager.approve('atomic-run', approval.id, false, 'reject'),
  ]);
  assert.equal(decisions.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(decisions.filter((result) => result.status === 'rejected').length, 1);
  const decided = await manager.status('atomic-run');
  assert.equal(decided.approvals.filter((item) => item.id === approval.id && item.status !== 'pending').length, 1);
  await manager.close();
});

test('manager event handoff catches updates created during replay without duplicates', async () => {
  const ledger = memoryLedger();
  const manager = new AutoDevManager({
    ledger,
    workers: { claude: fakeWorker('claude', [], async () => ({})) },
    repo: '/repo',
  });
  await manager.create({ id: 'handoff-run', mode: 'status' });
  const seen = [];
  let running;
  const unsubscribe = await manager.events('handoff-run', {
    listener: (event) => {
      seen.push(event.sequence);
      if (!running) running = manager.start('handoff-run');
    },
  });
  const status = await running;
  unsubscribe();
  assert.equal(status.status, 'succeeded');
  assert.deepEqual(seen, status.events.map((event) => event.sequence));
  assert.equal(new Set(seen).size, seen.length);
  await manager.close();
});

test('manager preserves completed siblings when a concurrent package fails', async () => {
  const ledger = memoryLedger();
  const completed = [];
  let releaseFailure;
  const successful = new Promise((resolve) => { releaseFailure = resolve; });
  const worker = fakeWorker('claude', [], async (input) => {
    if (input.role === 'planner') {
      return {
        workPackages: [
          { ...planPackage('claude'), id: 'good', paths: ['lib/good.mjs'] },
          { ...planPackage('claude'), id: 'bad', paths: ['lib/bad.mjs'] },
        ],
      };
    }
    if (input.role === 'implementer' && input.cwd.endsWith('/bad')) {
      await successful;
      throw new Error('simulated sibling failure');
    }
    return {};
  });
  const manager = new AutoDevManager({
    ledger,
    workers: { claude: worker },
    workspace: {
      prepare: async ({ package: item }) => ({ cwd: `/owned/${item.id}`, name: item.id }),
      complete: async ({ package: item, workspace }) => {
        completed.push(item.id);
        if (item.id === 'good') releaseFailure();
        return { ...workspace, commit: `${item.id}-commit` };
      },
    },
    repo: '/repo',
    limits: { concurrency: 2, reviews: 1 },
  });
  await manager.create({ id: 'partial-run', request: 'feature' });
  const run = await manager.start('partial-run');
  assert.equal(run.status, 'failed');
  assert.deepEqual(completed, ['good']);
  const good = run.packages.find((item) => item.id === 'good');
  assert.equal(good.status, 'succeeded');
  assert.equal(good.workspace.commit, 'good-commit');
  await manager.close();
});

test('manager close interrupts active execution and waits for worker settlement', async () => {
  const ledger = memoryLedger();
  let entered;
  let settled = false;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const worker = {
    run({ signal }) {
      entered();
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
        setImmediate(() => {
          settled = true;
          reject(signal.reason);
        });
      }, { once: true }));
    },
    async close() {
      assert.equal(settled, true);
    },
  };
  const manager = new AutoDevManager({ ledger, workers: { claude: worker }, repo: '/repo' });
  await manager.create({ id: 'close-run', request: 'feature' });
  const running = manager.start('close-run');
  await waiting;
  await manager.close();
  assert.equal(settled, true);
  assert.equal((await ledger.get('close-run')).status, 'interrupted');
  assert.equal((await running).status, 'interrupted');
});

test('manager reports an explicitly unavailable package backend', async () => {
  const ledger = memoryLedger();
  const worker = fakeWorker('claude', [], async (input) => input.role === 'planner'
    ? { workPackages: [planPackage('codex')] }
    : {});
  const manager = new AutoDevManager({
    ledger,
    workers: { claude: worker },
    workspace: { prepare: async () => ({ cwd: '/owned/pkg' }) },
    repo: '/repo',
    limits: { reviews: 1 },
    validator: async ({ package: item } = {}) => ({ checks: [{ name: item?.gates?.[0] ?? 'validation', passed: true, required: true, detail: 'pass' }] }),
  });
  await manager.create({ id: 'missing-codex', request: 'feature' });
  const run = await manager.start('missing-codex');
  assert.equal(run.status, 'blocked');
  assert.equal(run.errorCode, 'BACKEND_UNAVAILABLE');
  assert.match(run.failure, /codex/);
  await manager.close();
});

test('manager cancellation during the claim gap prevents worker launch', async () => {
  const ledger = memoryLedger();
  const mutate = ledger.mutate.bind(ledger);
  let releaseClaim;
  let claimed;
  const claimPersisted = new Promise((resolve) => { claimed = resolve; });
  ledger.mutate = async (id, updater, eventType) => {
    const result = await mutate(id, updater, eventType);
    if (eventType === 'claimed') {
      claimed();
      await new Promise((resolve) => { releaseClaim = resolve; });
    }
    return result;
  };
  let workerCalls = 0;
  const worker = {
    async run() { workerCalls++; return { final: emptyResult() }; },
  };
  const manager = new AutoDevManager({ ledger, workers: { claude: worker }, repo: '/repo' });
  await manager.create({ id: 'claim-gap', request: 'feature' });
  const starting = manager.start('claim-gap');
  await claimPersisted;
  const cancelled = await manager.cancel('claim-gap', 'operator stop');
  releaseClaim();
  assert.equal(cancelled.status, 'cancelled');
  assert.equal((await starting).status, 'cancelled');
  assert.equal(workerCalls, 0);
  assert.equal((await manager.status('claim-gap')).status, 'cancelled');
  await manager.close();
});

test('manager cancellation aborts active workers and persists cancellation', async () => {
  const ledger = memoryLedger();
  let entered;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const worker = {
    run({ signal }) {
      entered();
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
  };
  const manager = new AutoDevManager({ ledger, workers: { claude: worker }, repo: '/repo', id: () => 'cancel-id' });
  await manager.create({ id: 'cancel-run', request: 'feature' });
  const running = manager.start('cancel-run');
  await waiting;
  await manager.cancel('cancel-run', 'operator stop');
  const result = await running;
  assert.equal(result.status, 'cancelled');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await manager.status('cancel-run')).status, 'cancelled');
  assert.equal((await manager.status('cancel-run')).failure, 'operator stop');
  manager.close();
});

function sdkQuery(messages, capture) {
  return ({ prompt, options }) => {
    capture.push({ prompt, options });
    let closed = false;
    return {
      async *[Symbol.asyncIterator]() { for (const message of messages) yield message; },
      close() { closed = true; capture.push({ closed }); },
      get closed() { return closed; },
    };
  };
}

test('Claude worker uses explicit Agent SDK agents/options and returns structured final output', async () => {
  const capture = [];
  const final = emptyResult({ summary: 'structured' });
  let closeHooks = 0;
  const worker = new ClaudeWorker({
    query: sdkQuery([
      { type: 'system', subtype: 'init', session_id: 'session-1' },
      { type: 'result', subtype: 'success', is_error: false, session_id: 'session-1', structured_output: final, result: 'text', num_turns: 2, total_cost_usd: 0.25, usage: { input_tokens: 4 } },
    ], capture),
    baseOptions: { pathToClaudeCodeExecutable: '/portable/claude', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1' } },
    closeHook: async () => { closeHooks++; },
    setTimeoutImpl: () => 1, clearTimeoutImpl: () => {},
  });
  const events = [];
  const result = await worker.run({ prompt: 'review', cwd: '/repo', role: 'reviewer', onEvent: (event) => events.push(event) });
  assert.deepEqual(result.final, final);
  assert.equal(result.sessionId, 'session-1');
  const { options } = capture[0];
  assert.equal(options.agent, undefined);
  assert.equal(options.systemPrompt.type, 'preset');
  assert.equal(options.systemPrompt.preset, 'claude_code');
  assert.equal(options.systemPrompt.append, CLAUDE_WORKER_AGENTS.reviewer.prompt);
  assert.equal(options.allowedTools, undefined);
  assert.deepEqual(options.tools, ['Read', 'Glob', 'Grep']);
  assert.deepEqual(options.disallowedTools, ['Edit', 'Write', 'Bash']);
  assert.equal(options.permissionMode, CLAUDE_WORKER_AGENTS.reviewer.permissionMode);
  assert.equal(options.model, 'claude-opus-5');
  assert.equal(options.pathToClaudeCodeExecutable, '/portable/claude');
  assert.equal(options.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1');
  assert.equal(options.settingSources.length, 0);
  assert.deepEqual(options.sandbox, {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: false,
    allowUnsandboxedCommands: false,
    network: {
      allowedDomains: [],
      strictAllowlist: true,
      allowUnixSockets: [],
      allowAllUnixSockets: false,
      allowLocalBinding: false,
    },
    filesystem: { denyWrite: ['/repo'] },
  });
  assert.equal(options.outputFormat.type, 'json_schema');
  assert.equal(options.outputFormat.schema.additionalProperties, false);
  assert.equal(options.agents, CLAUDE_WORKER_AGENTS);
  assert.equal(options.agents.reviewer.disallowedTools.includes('Bash'), true);
  assert.equal(events.length, 2);
  assert.deepEqual(capture.at(-1), { closed: true });
  await worker.close();
  assert.equal(closeHooks, 1);
});

test('Claude worker exposes only each role tool set without bypassing host permissions', async () => {
  for (const [role, expected] of [
    ['planner', ['Read', 'Glob', 'Grep']],
    ['implementer', ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash']],
    ['tester', ['Read', 'Glob', 'Grep']],
    ['reviewer', ['Read', 'Glob', 'Grep']],
    ['fixer', ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash']],
  ]) {
    const capture = [];
    const worker = new ClaudeWorker({
      query: sdkQuery([{ type: 'result', subtype: 'success', is_error: false, session_id: 's', structured_output: emptyResult(), result: '', num_turns: 1, total_cost_usd: 0, usage: {} }], capture),
      setTimeoutImpl: () => 1, clearTimeoutImpl: () => {},
    });
    await worker.run({ prompt: role, cwd: '/repo', role });
    assert.deepEqual(capture[0].options.tools, expected, role);
    assert.equal(capture[0].options.allowedTools, undefined, role);
    assert.equal(typeof capture[0].options.canUseTool, 'function', role);
    if (role === 'tester') assert.equal(capture[0].options.disallowedTools.includes('Bash'), true);
  }
});

test('Claude worker refuses critical Bash through host permission callback', async () => {
  const capture = [];
  const worker = new ClaudeWorker({
    query: sdkQuery([{ type: 'result', subtype: 'success', is_error: false, session_id: 's', structured_output: emptyResult(), result: '', num_turns: 1, total_cost_usd: 0, usage: {} }], capture),
    setTimeoutImpl: () => 1, clearTimeoutImpl: () => {},
  });
  await worker.run({ prompt: 'implement', cwd: '/repo' });
  for (const command of [
    'git push origin main',
    'git -C . merge feature',
    'command git push origin main',
    'command rm -rf src',
    'find src -delete',
    'npm --workspace pkg publish',
  ]) {
    assert.equal((await capture[0].options.canUseTool('Bash', { command }, {})).behavior, 'deny', command);
  }
  assert.equal((await capture[0].options.canUseTool('Bash', { command: 'npm test' }, {})).behavior, 'allow');
  assert.equal((await capture[0].options.canUseTool('Write', { file_path: '/repo/lib/file.mjs' }, {})).behavior, 'allow');
  assert.equal((await capture[0].options.canUseTool('Write', { file_path: '/outside/file.mjs' }, {})).behavior, 'deny');
  assert.equal((await capture[0].options.canUseTool('Edit', { file_path: '../outside.mjs' }, {})).behavior, 'deny');
});

test('Claude worker rejects file writes through symlinks outside an existing workspace', async t => {
  const { mkdtempSync, mkdirSync, symlinkSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'autodev-claude-scope-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const outside = join(root, 'outside');
  mkdirSync(workspace); mkdirSync(outside);
  symlinkSync(outside, join(workspace, 'escape'), 'dir');
  const capture = [];
  const worker = new ClaudeWorker({
    query: sdkQuery([{ type: 'result', subtype: 'success', is_error: false, session_id: 's', structured_output: emptyResult(), result: '', num_turns: 1, total_cost_usd: 0, usage: {} }], capture),
    setTimeoutImpl: () => 1, clearTimeoutImpl: () => {},
  });
  await worker.run({ prompt: 'implement', cwd: workspace });
  assert.equal((await capture[0].options.canUseTool('Write', { file_path: join(workspace, 'escape', 'file.mjs') }, {})).behavior, 'deny');
  assert.equal((await capture[0].options.canUseTool('Write', { file_path: join(workspace, 'new', 'file.mjs') }, {})).behavior, 'allow');
});

test('Claude worker classifies result/protocol errors and aborts without network', async () => {
  const failed = new ClaudeWorker({ query: sdkQuery([{ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['limit'], session_id: 's' }], []), setTimeoutImpl: () => 1, clearTimeoutImpl: () => {} });
  await assert.rejects(failed.run({ prompt: 'p', cwd: '/repo' }), ClaudeWorkerResultError);
  const missing = new ClaudeWorker({ query: sdkQuery([], []), setTimeoutImpl: () => 1, clearTimeoutImpl: () => {} });
  await assert.rejects(missing.run({ prompt: 'p', cwd: '/repo' }), ClaudeWorkerProtocolError);
  const controller = new AbortController(); controller.abort();
  const aborted = new ClaudeWorker({ query: sdkQuery([], []) });
  await assert.rejects(aborted.run({ prompt: 'p', cwd: '/repo', signal: controller.signal }), ClaudeWorkerAbortError);
});

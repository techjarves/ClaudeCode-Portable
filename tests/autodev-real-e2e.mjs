import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  createAutoDevManager,
  createAutoDevRuntime,
} from '../lib/autodev/index.mjs';

if (process.env.AUTODEV_REAL_E2E !== '1') {
  console.log('SKIP: set AUTODEV_REAL_E2E=1 to run the billed real-provider fixture.');
  process.exit(0);
}

const RUN_ID = 'real-cross-model-fixture';
const LIMITS = Object.freeze({
  concurrency: 2,
  reviews: 1,
  repairs: 1,
  maxTasks: 2,
  maxTurns: 16,
  maxBudgetUsd: 0.75,
  timeoutMs: 300_000,
});
const PACKAGES = Object.freeze([
  Object.freeze({
    id: 'claude-package',
    title: 'Implement Claude package',
    description: 'Implement label(value) so it returns `claude:${value}`. Do not modify tests. The host runs all required tests after implementation.',
    paths: ['packages/claude/index.mjs'],
    dependsOn: [],
    acceptanceCriteria: ['label("x") returns "claude:x".'],
    backend: 'claude',
    gates: ['claude fixture test'],
  }),
  Object.freeze({
    id: 'codex-package',
    title: 'Implement Codex package',
    description: 'Implement double(value) so it returns value multiplied by two. Do not modify tests. The host runs all required tests after implementation.',
    paths: ['packages/codex/index.mjs'],
    dependsOn: [],
    acceptanceCriteria: ['double(4) returns 8.'],
    backend: 'codex',
    gates: ['codex fixture test'],
  }),
]);

function result(overrides = {}) {
  return {
    status: 'succeeded',
    summary: 'Controlled fixture result.',
    workPackages: [],
    changes: [],
    checks: [],
    findings: [],
    artifacts: [],
    criticalActions: [],
    ...overrides,
  };
}

function command(cwd, executable, args, { allowFailure = false, timeout = 30_000 } = {}) {
  const run = spawnSync(executable, args, {
    cwd,
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim();
  if (!allowFailure && (run.error || run.status !== 0)) {
    throw new Error(`${executable} ${args[0]} failed (${run.error?.message ?? run.signal ?? run.status}): ${output.slice(-1500)}`);
  }
  return { passed: !run.error && run.status === 0, status: run.status, signal: run.signal, output };
}

function git(cwd, ...args) {
  return command(cwd, 'git', args).output;
}

function writeFixture(repo) {
  const files = {
    'packages/claude/index.mjs': "export function label() {\n  throw new Error('TODO');\n}\n",
    'packages/codex/index.mjs': "export function double() {\n  throw new Error('TODO');\n}\n",
    'tests/claude.test.mjs': `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { label } from '../packages/claude/index.mjs';\ntest('Claude package contract', () => assert.equal(label('x'), 'claude:x'));\n`,
    'tests/codex.test.mjs': `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { double } from '../packages/codex/index.mjs';\ntest('Codex package contract', () => assert.equal(double(4), 8));\n`,
    'tests/integration.test.mjs': `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { label } from '../packages/claude/index.mjs';\nimport { double } from '../packages/codex/index.mjs';\ntest('integrated contracts', () => assert.deepEqual([label('ok'), double(6)], ['claude:ok', 12]));\n`,
  };
  for (const [relative, content] of Object.entries(files)) {
    const file = join(repo, relative);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

function fixtureTest(cwd, packageId) {
  const file = packageId === 'claude-package' ? 'tests/claude.test.mjs' : 'tests/codex.test.mjs';
  const gate = packageId === 'claude-package' ? 'claude fixture test' : 'codex fixture test';
  const observed = command(cwd, process.execPath, ['--test', file], { allowFailure: true });
  return {
    name: gate,
    passed: observed.passed,
    required: true,
    detail: observed.passed
      ? `${file} exited 0`
      : `${file} failed (${observed.signal ?? observed.status}): ${observed.output.slice(-1200)}`,
  };
}

const fixtureValidator = async ({ cwd, package: item, gates } = {}) => {
  if (item) {
    const selected = gates ?? item.gates;
    const unknown = selected.filter((gate) => !fixtureValidator.gateIds.includes(gate));
    if (unknown.length) throw new Error(`unknown fixture gate IDs: ${unknown.join(', ')}`);
    return { checks: selected.map(() => fixtureTest(cwd, item.id)) };
  }
  const files = ['tests/claude.test.mjs', 'tests/codex.test.mjs', 'tests/integration.test.mjs'];
  const observed = command(cwd, process.execPath, ['--test', ...files], { allowFailure: true, timeout: 60_000 });
  return { checks: [{
    name: 'fixture integration suite',
    passed: observed.passed,
    required: true,
    detail: observed.passed
      ? 'fixture integration suite exited 0'
      : `fixture integration suite failed (${observed.signal ?? observed.status}): ${observed.output.slice(-1200)}`,
  }] };
};
Object.defineProperty(fixtureValidator, 'gateIds', {
  value: Object.freeze(['claude fixture test', 'codex fixture test']),
});

const root = mkdtempSync(join(tmpdir(), 'openclaude-autodev-real-'));
const repo = join(root, 'fixture');
const worktreeRoot = join(root, 'worktrees');
const ledgerFile = join(root, 'ledger.json');
mkdirSync(repo, { recursive: true });
writeFixture(repo);
git(repo, 'init', '-q');
git(repo, 'config', 'user.name', 'OpenClaude AutoDev Fixture');
git(repo, 'config', 'user.email', 'autodev-fixture@example.invalid');
git(repo, 'add', '--', '.');
git(repo, 'commit', '-q', '-m', 'Fixture baseline');
const initialHead = git(repo, 'rev-parse', 'HEAD');

const calls = [];
const claudeUsage = [];
const cwdPackages = new Map();
let manager;
let injected = 0;
let activeImplementers = 0;
let maxActiveImplementers = 0;
let watchdog;

function wrapWorker(backend, worker) {
  return {
    async run(input) {
      const packageId = cwdPackages.get(input.cwd) ?? null;
      calls.push({ backend, role: input.role, packageId, sandbox: input.sandbox });
      if (input.role === 'planner') {
        return { final: result({ summary: 'Seeded deterministic two-package plan.', workPackages: PACKAGES }), sessionId: 'seeded-plan' };
      }

      if (input.role === 'implementer') {
        activeImplementers++;
        maxActiveImplementers = Math.max(maxActiveImplementers, activeImplementers);
      }
      console.log(`[real-e2e] start ${backend}:${input.role}:${packageId ?? 'run'}`);
      let response;
      try {
        response = await worker.run(input);
        console.log(`[real-e2e] finish ${backend}:${input.role}:${packageId ?? 'run'}:${response.final?.status ?? 'unknown'}`);
      } catch (error) {
        console.log(`[real-e2e] fail ${backend}:${input.role}:${packageId ?? 'run'}:${error.code ?? error.name ?? 'error'}`);
        throw error;
      } finally {
        if (input.role === 'implementer') activeImplementers--;
      }
      if (backend === 'claude') {
        claudeUsage.push({ role: input.role, packageId, usage: response.usage, costUsd: response.costUsd });
      }
      if (input.role === 'tester') {
        const check = fixtureTest(input.cwd, packageId);
        return {
          ...response,
          final: result({
            summary: `${backend} tester invoked; host oracle observed ${check.passed ? 'pass' : 'failure'}.`,
            checks: [check],
          }),
        };
      }
      if (input.role === 'reviewer') {
        return {
          ...response,
          final: {
            ...response.final,
            status: 'succeeded',
            summary: response.final?.summary || `${backend} review completed.`,
            findings: (response.final?.findings ?? []).map((finding) => ({ ...finding, blocking: false })),
          },
        };
      }
      return response;
    },
    close() {
      return worker.close?.();
    },
  };
}

try {
  manager = await createAutoDevRuntime({
    repo,
    ledgerFile,
    worktreeRoot,
    validator: fixtureValidator,
    managerFactory: async (options) => {
      assert.ok(options.workers.claude, 'Claude worker is unavailable');
      assert.ok(options.workers.codex, 'Codex worker or saved OpenAI credential is unavailable');
      const baseWorkspace = options.workspace;
      const workspace = {
        async prepare(input) {
          const prepared = await baseWorkspace.prepare(input);
          cwdPackages.set(prepared.cwd, input.package.id);
          return prepared;
        },
        async complete(input) {
          const completed = await baseWorkspace.complete(input);
          if (input.package.id === 'codex-package' && injected === 0) {
            const implementation = fixtureTest(completed.cwd, 'codex-package');
            assert.equal(implementation.passed, true, `Codex implementation did not satisfy its contract before controlled injection: ${implementation.detail}`);
            writeFileSync(join(completed.cwd, 'packages/codex/index.mjs'), 'export function double(value) {\n  return value + 2;\n}\n');
            injected++;
          }
          return completed;
        },
        reviewEvidence: (input) => baseWorkspace.reviewEvidence(input),
        prepareIntegration: (input) => baseWorkspace.prepareIntegration(input),
        reconcileIntegration: (intent, options) => baseWorkspace.reconcileIntegration(intent, options),
        applyIntegration: (intent, options) => baseWorkspace.applyIntegration(intent, options),
        cleanupIntegration: (intent) => baseWorkspace.cleanupIntegration(intent),
      };
      return createAutoDevManager({
        ...options,
        workers: {
          claude: wrapWorker('claude', options.workers.claude),
          codex: wrapWorker('codex', options.workers.codex),
        },
        workspace,
        limits: LIMITS,
      });
    },
  });

  watchdog = setTimeout(() => {
    manager.cancel(RUN_ID, 'real provider E2E watchdog expired').catch(() => {});
  }, 40 * 60_000);

  await manager.create({
    id: RUN_ID,
    mode: 'auto-dev',
    request: 'Implement both independent fixture packages, verify them, cross-review them, repair verified defects, and integrate only after approval.',
    backend: 'claude',
    limits: LIMITS,
  });
  const pending = await manager.start(RUN_ID);
  assert.equal(pending.status, 'pending_approval', pending.failure);
  assert.equal(pending.phase, 'INTEGRATE');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), initialHead, 'destination changed before integration approval');
  assert.equal(injected, 1, 'controlled defect was not injected exactly once');
  assert.equal(maxActiveImplementers, 2, 'independent implementations did not overlap');
  assert.deepEqual(
    calls.filter((call) => call.role === 'fixer').map(({ backend, packageId }) => ({ backend, packageId })),
    [{ backend: 'codex', packageId: 'codex-package' }],
  );
  assert.ok(calls.some((call) => call.role === 'reviewer' && call.backend === 'codex' && call.packageId === 'claude-package'));
  assert.ok(calls.some((call) => call.role === 'reviewer' && call.backend === 'claude' && call.packageId === 'codex-package'));
  assert.equal(pending.repairCount, 1);
  assert.ok(pending.phaseHistory.filter((phase) => phase === 'TEST').length >= 2);
  assert.ok(pending.phaseHistory.filter((phase) => phase === 'REVIEW').length >= 2);
  assert.ok(pending.phaseHistory.includes('FIX'));

  const approval = pending.approvals.find((item) => item.kind === 'destination-integration' && item.status === 'pending');
  assert.ok(approval, 'destination integration approval was not requested');
  await manager.approve(RUN_ID, approval.id, true, 'Approved only for this disposable fixture.');
  const finished = await manager.resume(RUN_ID);
  assert.equal(finished.status, 'succeeded', finished.failure);
  assert.equal(finished.integrated, true);
  assert.equal(finished.report?.successful, true);
  assert.deepEqual(finished.phaseHistory.slice(-3), ['INTEGRATE', 'VALIDATE', 'REPORT']);
  assert.ok(finished.checks.some((check) => check.name === 'fixture integration suite' && check.required && check.passed));
  assert.notEqual(git(repo, 'rev-parse', 'HEAD'), initialHead);
  const finalTests = command(repo, process.execPath, ['--test', 'tests/claude.test.mjs', 'tests/codex.test.mjs', 'tests/integration.test.mjs'], { allowFailure: true, timeout: 60_000 });
  assert.equal(finalTests.passed, true, finalTests.output);
  assert.match(readFileSync(join(repo, 'packages/codex/index.mjs'), 'utf8'), /value\s*\*\s*2|2\s*\*\s*value/);
  assert.ok(finished.reviews.every((review) => review.backend !== review.subjectBackend));

  const observedCost = claudeUsage.reduce((sum, item) => sum + (typeof item.costUsd === 'number' ? item.costUsd : 0), 0);
  const observedInput = claudeUsage.reduce((sum, item) => sum + (item.usage?.input_tokens ?? 0), 0);
  const observedOutput = claudeUsage.reduce((sum, item) => sum + (item.usage?.output_tokens ?? 0), 0);
  console.log(JSON.stringify({
    status: finished.status,
    lifecycle: finished.phaseHistory,
    packages: finished.packages.map((item) => ({ id: item.id, backend: item.backend, commit: item.workspace.commit })),
    controlledDefectInjections: injected,
    ownerRepair: calls.filter((call) => call.role === 'fixer'),
    reciprocalReviews: calls.filter((call) => call.role === 'reviewer'),
    realProviderCalls: calls.length - 1,
    maxConcurrentImplementers: maxActiveImplementers,
    validation: finished.checks.filter((check) => check.name === 'fixture integration suite'),
    claudeUsage: { inputTokens: observedInput, outputTokens: observedOutput, costUsd: observedCost },
    codexUsage: 'not exposed by Codex CLI worker',
  }, null, 2));
} finally {
  clearTimeout(watchdog);
  await manager?.close?.();
  rmSync(root, { recursive: true, force: true });
}

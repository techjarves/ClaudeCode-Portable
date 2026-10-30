import { createHash } from 'node:crypto';
import { existsSync, realpathSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { ROOT, DATA } from '../paths.mjs';
import { readConfig } from '../config.mjs';
import { PROVIDERS, providerEnvironment } from '../providers.mjs';
import { executableAt, loadSDK } from '../runtime.mjs';
import { startAdapter } from '../adapter.mjs';
import { startExternalAdapter } from '../external-adapter.mjs';
import { startResponsesAdapter } from '../responses-adapter.mjs';
import { createClaudeWorker } from './claude-worker.mjs';
import { createCodexWorker } from './codex-worker.mjs';
import { createAutoDevManager } from './manager.mjs';
import { OwnedWorktrees, runGit } from './worktrees.mjs';
import { normalizeTaskPath } from './scheduler.mjs';

const DEFAULT_VALIDATION_TIMEOUT = 10 * 60 * 1000;
const DEFAULT_OUTPUT_LIMIT = 1024 * 1024;
const DEFAULT_REVIEW_DIFF_LIMIT = 512 * 1024;

function findExecutable(name) {
  const locator = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(locator, [name], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
  return result.status === 0 ? result.stdout.split(/\r?\n/).map((value) => value.trim()).find(Boolean) : undefined;
}

function canonicalDirectory(value, { realpath = realpathSync, stat = statSync } = {}) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('repository path is required');
  const path = realpath(resolve(value));
  if (!stat(path).isDirectory()) throw new Error('AutoDev repository must be a directory');
  return path;
}

function safeName(runId, taskId) {
  const source = `${runId}-${taskId}`;
  const prefix = source.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 42) || 'autodev';
  return `${prefix}-${createHash('sha256').update(source).digest('hex').slice(0, 12)}`.slice(0, 64);
}

function statusPaths(status) {
  if (typeof status !== 'string') throw new TypeError('worktree status must be a string');
  const entries = status.split('\0');
  if (entries.at(-1) === '') entries.pop();
  const paths = [];
  for (let index = 0; index < entries.length;) {
    const entry = entries[index++];
    if (entry.length < 4 || entry[2] !== ' ') throw new Error('invalid worktree status output');
    paths.push(normalizeTaskPath(entry.slice(3)));
    if (/^[RC]/.test(entry) || /^[RC]/.test(entry.slice(1))) {
      if (index >= entries.length) throw new Error('invalid worktree rename output');
      paths.push(normalizeTaskPath(entries[index++]));
    }
  }
  return [...new Set(paths)];
}

function assertScopedPaths(paths, scopes, taskId) {
  for (const path of paths) {
    if (!scopes.some((scope) => path === scope || path.startsWith(`${scope}/`))) {
      throw new Error(`work package ${taskId} changed path outside its scope: ${path}`);
    }
  }
  return paths;
}

function assertScopedChanges(status, scopes, taskId) {
  return assertScopedPaths(statusPaths(status), scopes, taskId);
}

function diffPaths(status) {
  if (typeof status !== 'string') throw new TypeError('commit diff must be a string');
  const entries = status.split('\0');
  if (entries.at(-1) === '') entries.pop();
  const paths = [];
  for (let index = 0; index < entries.length;) {
    const code = entries[index++];
    if (!code) continue;
    const count = /^[RC]/.test(code) ? 2 : 1;
    if (entries.length - index < count) throw new Error('invalid commit diff output');
    for (let pathIndex = 0; pathIndex < count; pathIndex++) {
      paths.push(normalizeTaskPath(entries[index++]));
    }
  }
  return [...new Set(paths)];
}

function integrationPackages(packages) {
  return packages.map((item) => ({ id: item.id, name: item.workspace.name, commit: item.workspace.commit }));
}

function dependencyOrder(packages) {
  const remaining = new Map(packages.map((item) => [item.id, item]));
  const complete = new Set();
  const ordered = [];
  while (remaining.size) {
    const ready = [...remaining.values()].filter((item) => item.dependsOn.every((id) => complete.has(id)));
    if (!ready.length) throw new Error('work package dependency cycle');
    for (const item of ready) {
      ordered.push(item);
      complete.add(item.id);
      remaining.delete(item.id);
    }
  }
  return ordered;
}

function defaultWorktreeRoot(repo) {
  const hash = createHash('sha256').update(repo).digest('hex').slice(0, 16);
  return join(dirname(repo), `.openclaude-autodev-${hash}`);
}

export async function validateRepository(repo, { git = runGit, realpath = realpathSync, stat = statSync } = {}) {
  const canonical = canonicalDirectory(repo, { realpath, stat });
  const top = canonicalDirectory(await git(['rev-parse', '--show-toplevel'], { cwd: canonical }), { realpath, stat });
  if (top !== canonical) throw new Error(`AutoDev target must be the Git repository root: ${top}`);
  return canonical;
}

export function createOwnedWorkspace({ repo, root = defaultWorktreeRoot(repo), git = runGit, owned } = {}) {
  const worktrees = owned ?? new OwnedWorktrees({ repo, root, git });
  return {
    async prepare({ run, package: item, signal }) {
      const name = safeName(run.id, item.id);
      const repositoryHead = await git(['rev-parse', 'HEAD'], { cwd: repo, signal });
      const record = await worktrees.create({ name, runId: run.id, taskId: item.id, base: repositoryHead });
      const adopted = item.workspace?.name === record.name;
      if (!adopted) {
        for (const dependency of item.dependsOn) {
          const parent = run.packages.find((candidate) => candidate.id === dependency);
          if (!parent?.workspace?.branch) throw new Error(`dependency workspace is unavailable: ${dependency}`);
          await git(['merge', '--no-ff', '--no-edit', parent.workspace.branch], { cwd: record.path, signal });
        }
      }
      const baseHead = adopted && item.workspace?.baseHead
        ? item.workspace.baseHead
        : await git(['rev-parse', 'HEAD'], { cwd: record.path, signal });
      return { cwd: record.path, name: record.name, branch: record.branch, baseHead };
    },
    async complete({ package: item, workspace, signal }) {
      const scopes = item.paths.map(normalizeTaskPath);
      const dirty = await worktrees.status(workspace.name);
      let commit = workspace.commit ?? null;
      if (dirty) {
        const changedPaths = assertScopedChanges(dirty, scopes, item.id);
        commit = await worktrees.commit(workspace.name, { paths: changedPaths, message: `AutoDev: ${item.title}` });
      } else if (!commit) {
        commit = await git(['rev-parse', 'HEAD'], { cwd: workspace.cwd, signal });
      }
      const committed = diffPaths(await git(['diff', '--name-status', '-z', workspace.baseHead, commit], { cwd: workspace.cwd, signal }));
      assertScopedPaths(committed, scopes, item.id);
      return { ...workspace, commit };
    },
    async reviewEvidence({ package: item, maxPatchBytes = DEFAULT_REVIEW_DIFF_LIMIT, signal }) {
      const workspace = item?.workspace;
      if (!workspace?.cwd || !workspace?.branch || !workspace?.baseHead || !workspace?.commit) {
        throw new Error(`package ${item?.id ?? 'unknown'} has incomplete review coordinates`);
      }
      if (!Number.isSafeInteger(maxPatchBytes) || maxPatchBytes < 1) {
        throw new TypeError('maxPatchBytes must be a positive integer');
      }
      const branchHead = await git(['rev-parse', workspace.branch], { cwd: repo, signal });
      if (branchHead !== workspace.commit) {
        throw new Error(`package ${item.id} branch moved from accepted commit ${workspace.commit} to ${branchHead}`);
      }
      const nameStatus = await git(['diff', '--name-status', '-z', workspace.baseHead, workspace.commit], {
        cwd: workspace.cwd,
        signal,
      });
      const paths = diffPaths(nameStatus);
      assertScopedPaths(paths, item.paths.map(normalizeTaskPath), item.id);
      const patch = await git([
        '-c', 'diff.external=',
        '-c', 'diff.trustExitCode=false',
        'diff', '--no-ext-diff', '--binary', '--no-color',
        workspace.baseHead, workspace.commit,
      ], { cwd: workspace.cwd, signal });
      if (Buffer.byteLength(patch) > maxPatchBytes) {
        throw new Error(`package ${item.id} review patch exceeds ${maxPatchBytes} bytes`);
      }
      return {
        baseCommit: workspace.baseHead,
        acceptedCommit: workspace.commit,
        branch: workspace.branch,
        paths,
        nameStatus,
        patch,
      };
    },
    async prepareIntegration({ run, packages, signal }) {
      const expectedHead = await git(['rev-parse', 'HEAD'], { cwd: repo, signal });
      const ordered = dependencyOrder(packages);
      for (const item of ordered) {
        if (!item.workspace?.name || !item.workspace?.branch || !item.workspace?.commit || !item.paths?.length) {
          throw new Error(`package ${item.id} has no completed owned workspace or path scope`);
        }
        const branchHead = await git(['rev-parse', item.workspace.branch], { cwd: repo, signal });
        if (branchHead !== item.workspace.commit) {
          throw new Error(`package ${item.id} branch moved from approved commit ${item.workspace.commit} to ${branchHead}`);
        }
      }
      const stagingName = safeName(run?.id ?? 'integration', 'integration');
      const staging = await worktrees.create({
        name: stagingName,
        runId: run?.id ?? 'integration',
        taskId: 'integration',
        base: expectedHead,
      });
      const artifacts = [];
      try {
        for (const item of ordered) {
          await git(['merge', '--no-ff', '--no-edit', item.workspace.branch], { cwd: staging.path, signal });
          artifacts.push({ type: 'commit', path: item.workspace.commit, description: `Integrated ${item.id}` });
        }
        const stagedHead = await git(['rev-parse', 'HEAD'], { cwd: staging.path, signal });
        return {
          version: 1,
          state: 'prepared',
          expectedHead,
          stagedHead,
          staging: { name: staging.name, branch: staging.branch, cwd: staging.path },
          packages: integrationPackages(ordered),
          artifacts,
        };
      } catch (error) {
        try { await git(['merge', '--abort'], { cwd: staging.path }); } catch {}
        throw error;
      }
    },
    async reconcileIntegration(intent, { signal } = {}) {
      if (intent?.version !== 1 || !intent.expectedHead || !intent.stagedHead) throw new Error('integration intent is invalid');
      const head = await git(['rev-parse', 'HEAD'], { cwd: repo, signal });
      if (head === intent.expectedHead) return { state: 'not_applied', head };
      try {
        await git(['merge-base', '--is-ancestor', intent.stagedHead, head], { cwd: repo, signal });
        return { state: 'applied', head };
      } catch {
        return { state: 'diverged', head };
      }
    },
    async applyIntegration(intent, { signal } = {}) {
      const reconciliation = await this.reconcileIntegration(intent, { signal });
      if (reconciliation.state === 'applied') return { success: true, ...reconciliation, stagedHead: intent.stagedHead, artifacts: intent.artifacts ?? [] };
      if (reconciliation.state !== 'not_applied') throw new Error(`integration destination diverged at ${reconciliation.head}`);
      const stagingHead = await git(['rev-parse', 'HEAD'], { cwd: intent.staging.cwd, signal });
      if (stagingHead !== intent.stagedHead) {
        throw new Error(`integration staging branch moved from validated commit ${intent.stagedHead} to ${stagingHead}`);
      }
      await worktrees.integrate(intent.staging.name, { expectedHead: intent.expectedHead });
      const head = await git(['rev-parse', 'HEAD'], { cwd: repo, signal });
      return { success: true, state: 'applied', stagedHead: intent.stagedHead, head, artifacts: intent.artifacts ?? [] };
    },
    async cleanupIntegration(intent) {
      const names = [...(intent.packages ?? []).map((item) => item.name), intent.staging?.name].filter(Boolean);
      const failures = [];
      for (const name of names) {
        try { await worktrees.remove(name); }
        catch (error) {
          if (!/ownership|not registered|ENOENT|not found/i.test(error.message)) failures.push(`${name}: ${error.message}`);
        }
      }
      if (failures.length) throw new Error(`integration cleanup failed: ${failures.join('; ')}`);
      return { success: true };
    },
    async integrate({ run, packages, signal }) {
      const intent = await this.prepareIntegration({ run, packages, signal });
      const result = await this.applyIntegration(intent, { signal });
      await this.cleanupIntegration(intent);
      return result;
    },
  };
}

function runCheck(command, args, {
  cwd, signal, spawnImpl = spawn, timeoutMs = DEFAULT_VALIDATION_TIMEOUT, maxOutputBytes = DEFAULT_OUTPUT_LIMIT,
  terminationGraceMs = 2000, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout,
} = {}) {
  return new Promise((resolvePromise) => {
    let output = '';
    let bytes = 0;
    let stopReason = null;
    let stopping = false;
    let settled = false;
    let child;
    let timeoutTimer;
    let forceTimer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeoutImpl(timeoutTimer);
      clearTimeoutImpl(forceTimer);
      signal?.removeEventListener('abort', abort);
      resolvePromise(result);
    };
    const stop = (reason) => {
      if (settled || stopping) return;
      stopping = true;
      stopReason = reason;
      try { child.kill('SIGTERM'); } catch {}
      forceTimer = setTimeoutImpl(() => {
        if (settled) return;
        try { child.kill('SIGKILL'); } catch {}
      }, terminationGraceMs);
    };
    const abort = () => stop('cancelled');
    if (signal?.aborted) {
      finish({ passed: false, detail: 'cancelled before launch' });
      return;
    }
    try {
      child = spawnImpl(command, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      finish({ passed: false, detail: `launch failed: ${error.message}` });
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    timeoutTimer = setTimeoutImpl(() => stop(`timed out after ${timeoutMs}ms`), timeoutMs);
    const consume = (chunk) => {
      if (stopping) return;
      const text = String(chunk);
      bytes += Buffer.byteLength(text);
      if (bytes > maxOutputBytes) {
        stop(`output exceeded ${maxOutputBytes} bytes`);
        return;
      }
      output += text;
    };
    child.stdout?.on('data', consume);
    child.stderr?.on('data', consume);
    child.once('error', (error) => finish({ passed: false, detail: `launch failed: ${error.message}` }));
    child.once('close', (code, closeSignal) => {
      const reason = stopReason ?? output.trim().slice(-4000);
      finish({
        passed: code === 0 && stopReason === null,
        detail: `exit ${closeSignal || code}${reason ? `: ${reason}` : ''}`,
      });
    });
  });
}

export function createRepositoryValidator({ node = process.execPath, spawnImpl = spawn, exists = existsSync, readdir = readdirSync,
  timeoutMs = DEFAULT_VALIDATION_TIMEOUT, maxOutputBytes = DEFAULT_OUTPUT_LIMIT, terminationGraceMs = 2000,
  setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
  const gateIds = Object.freeze(['repository tests', 'repository checks']);
  const validator = async ({ cwd, signal, gates } = {}) => {
    const selected = gates == null ? gateIds : [...new Set(gates)];
    const unknown = selected.filter((gate) => !gateIds.includes(gate));
    if (unknown.length) throw new Error(`unknown repository gate IDs: ${unknown.join(', ')}`);
    const checks = [];
    if (selected.includes('repository tests')) {
      const testDirectory = join(cwd, 'tests');
      const tests = exists(testDirectory)
        ? readdir(testDirectory).filter((name) => name.endsWith('.test.mjs')).sort().map((name) => join(testDirectory, name))
        : [];
      if (tests.length) {
        const result = await runCheck(node, ['--test', ...tests], {
          cwd, signal, spawnImpl, timeoutMs, maxOutputBytes, terminationGraceMs, setTimeoutImpl, clearTimeoutImpl,
        });
        checks.push({ name: 'repository tests', passed: result.passed, required: true, detail: result.detail });
      } else {
        checks.push({ name: 'repository tests', passed: false, required: true, detail: 'No tests/*.test.mjs files were found.' });
      }
    }
    if (selected.includes('repository checks')) {
      const checkScript = join(cwd, 'tools', 'check.mjs');
      if (exists(checkScript)) {
        const result = await runCheck(node, [checkScript], {
          cwd, signal, spawnImpl, timeoutMs, maxOutputBytes, terminationGraceMs, setTimeoutImpl, clearTimeoutImpl,
        });
        checks.push({ name: 'repository checks', passed: result.passed, required: true, detail: result.detail });
      } else {
        checks.push({ name: 'repository checks', passed: false, required: true, detail: 'tools/check.mjs was not found.' });
      }
    }
    return { checks };
  };
  Object.defineProperty(validator, 'gateIds', { value: gateIds });
  return validator;
}

export async function createAutoDevRuntime({
  repo = ROOT,
  ledgerFile = join(DATA, 'autodev', 'ledger.json'),
  worktreeRoot,
  readConfigImpl = readConfig,
  executableImpl = executableAt,
  sdkLoader = loadSDK,
  findExecutableImpl = findExecutable,
  git = runGit,
  providerEnv = providerEnvironment,
  adapterStarters = { builtin: startAdapter, external: startExternalAdapter, responses: startResponsesAdapter },
  managerFactory = createAutoDevManager,
  claudeFactory = createClaudeWorker,
  codexFactory = createCodexWorker,
  validator = createRepositoryValidator(),
  repositoryValidator = validateRepository,
} = {}) {
  const canonicalRepo = await repositoryValidator(repo, { git });
  const config = readConfigImpl();
  const profile = config.profiles?.[config.active];
  if (!profile) throw new Error('Configure an active provider before starting AutoDev');
  if (profile.auth === 'login') throw new Error('AutoDev dashboard requires an API credential or local provider');
  const claudeExecutable = executableImpl();
  if (!claudeExecutable) throw new Error('Install the official Claude runtime before starting AutoDev');

  let adapter;
  try {
    if (PROVIDERS[profile.provider]?.transport === 'openai') {
      const starter = adapterStarters[profile.adapter ?? 'builtin'];
      if (typeof starter !== 'function') throw new Error(`unsupported adapter: ${profile.adapter}`);
      adapter = await starter(profile, { onError: () => {} });
    }
    const env = providerEnv(profile, { adapter, dashboard: true });
    const workers = {
      claude: claudeFactory({
        loadSdk: sdkLoader,
        model: profile.model,
        baseOptions: {
          env,
          pathToClaudeCodeExecutable: claudeExecutable,
          effort: 'high',
          ...(adapter ? { thinking: { type: 'disabled' } } : {}),
        },
        closeHook: async () => adapter?.close?.(),
      }),
    };
    const workerOptions = {};
    const codexExecutable = process.env.CODEX_EXECUTABLE || findExecutableImpl('codex');
    const codexKey = config.profiles?.openai?.key;
    if (codexExecutable && codexKey) {
      workers.codex = codexFactory({ executable: codexExecutable });
      workerOptions.codex = { apiKey: codexKey };
    }
    const workspace = createOwnedWorkspace({ repo: canonicalRepo, root: worktreeRoot ?? defaultWorktreeRoot(canonicalRepo), git });
    return await managerFactory({ ledgerFile, workers, workerOptions, workspace, validator, repo: canonicalRepo });
  } catch (error) {
    await adapter?.close?.();
    throw error;
  }
}

import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createSchedule } from './scheduler.mjs';
import { evaluateQualityGate } from './quality.mjs';

export const AUTODEV_PHASES = Object.freeze([
  'PLAN', 'DELEGATE', 'IMPLEMENT', 'TEST', 'REVIEW', 'FIX', 'INTEGRATE', 'VALIDATE', 'REPORT',
]);

export const AUTODEV_COMMAND_MODES = Object.freeze(['auto-dev', 'multi-review', 'deep-review', 'status']);

export const WORK_PACKAGE_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  required: ['id', 'title', 'description', 'paths', 'dependsOn', 'acceptanceCriteria', 'backend', 'gates'],
  properties: {
    id: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' },
    paths: { type: 'array', items: { type: 'string' } }, dependsOn: { type: 'array', items: { type: 'string' } },
    acceptanceCriteria: { type: 'array', items: { type: 'string' } }, backend: { type: 'string', enum: ['claude', 'codex', 'auto'] },
    gates: { type: 'array', items: { type: 'string' } },
  },
});
const CHANGE_SCHEMA = { type: 'object', additionalProperties: false, required: ['path', 'summary', 'status'], properties: { path: { type: 'string' }, summary: { type: 'string' }, status: { type: 'string', enum: ['changed', 'unchanged', 'blocked'] } } };
const CHECK_SCHEMA = { type: 'object', additionalProperties: false, required: ['name', 'passed', 'required', 'detail'], properties: { name: { type: 'string' }, passed: { type: 'boolean' }, required: { type: 'boolean' }, detail: { type: 'string' } } };
const FINDING_SCHEMA = { type: 'object', additionalProperties: false, required: ['id', 'severity', 'file', 'line', 'title', 'detail', 'blocking'], properties: { id: { type: 'string' }, severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] }, file: { anyOf: [{ type: 'string' }, { type: 'null' }] }, line: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] }, title: { type: 'string' }, detail: { type: 'string' }, blocking: { type: 'boolean' } } };
const ARTIFACT_SCHEMA = { type: 'object', additionalProperties: false, required: ['type', 'path', 'description', 'digest'], properties: { type: { type: 'string' }, path: { type: 'string' }, description: { type: 'string' }, digest: { anyOf: [{ type: 'string' }, { type: 'null' }] } } };
const CRITICAL_ACTION_SCHEMA = { type: 'object', additionalProperties: false, required: ['id', 'action', 'summary', 'command'], properties: { id: { type: 'string' }, action: { type: 'string' }, summary: { type: 'string' }, command: { anyOf: [{ type: 'string' }, { type: 'null' }] } } };

export const AUTODEV_RESULT_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  required: ['status', 'summary', 'workPackages', 'changes', 'checks', 'findings', 'artifacts', 'criticalActions'],
  properties: {
    status: { type: 'string', enum: ['succeeded', 'failed', 'blocked'] }, summary: { type: 'string' },
    workPackages: { type: 'array', items: WORK_PACKAGE_SCHEMA }, changes: { type: 'array', items: CHANGE_SCHEMA },
    checks: { type: 'array', items: CHECK_SCHEMA }, findings: { type: 'array', items: FINDING_SCHEMA },
    artifacts: { type: 'array', items: ARTIFACT_SCHEMA }, criticalActions: { type: 'array', items: CRITICAL_ACTION_SCHEMA },
  },
});

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'blocked']);
const WRITABLE_MODES = new Set(['auto-dev']);
const DEFAULT_GATE_IDS = Object.freeze(['repository tests', 'repository checks']);
const DEFAULT_LIMITS = Object.freeze({ concurrency: 3, reviews: 2, repairs: 3, maxTasks: 20, maxTurns: 24, maxBudgetUsd: 10, timeoutMs: 15 * 60 * 1000 });

export class AutoDevManagerError extends Error {
  constructor(message, { code = 'AUTODEV_MANAGER_ERROR', cause, details } = {}) {
    super(message, { cause });
    this.name = this.constructor.name;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
export class AutoDevPreconditionError extends AutoDevManagerError {}
export class AutoDevCancelledError extends AutoDevManagerError {}
export class AutoDevApprovalRequiredError extends AutoDevManagerError {}

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}
function text(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required`);
  return value.trim();
}
function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  return value;
}
function positiveNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be positive`);
  return value;
}
function clone(value) { return structuredClone(value); }
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}
function approvalDigest(value) {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}
function integrationApprovalScope(run, intent) {
  return {
    version: 1,
    runId: run.id,
    action: 'integrate',
    expectedHead: intent.expectedHead,
    stagedHead: intent.stagedHead,
    packages: (intent.packages ?? []).map(({ id, commit }) => ({ id, commit })),
  };
}
function mode(value) {
  const normalized = text(value ?? 'auto-dev', 'mode').toLowerCase();
  if (!AUTODEV_COMMAND_MODES.includes(normalized)) throw new TypeError(`unsupported AutoDev mode: ${normalized}`);
  return normalized;
}
function backendName(value, name = 'backend') {
  const normalized = text(value, name).toLowerCase();
  if (!['claude', 'codex'].includes(normalized)) throw new TypeError(`${name} must be claude or codex`);
  return normalized;
}
function safePath(value) {
  const path = text(value, 'work package path').replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
  if (!path || path.startsWith('/') || /^[a-z]:\//i.test(path) || path === '..' || path.startsWith('../') || path.includes('/../')) {
    throw new TypeError(`unsafe work package path: ${value}`);
  }
  return path;
}

function normalizeLimits(input = {}) {
  object(input, 'limits');
  return Object.freeze({
    concurrency: positiveInteger(input.concurrency ?? DEFAULT_LIMITS.concurrency, 'concurrency'),
    reviews: positiveInteger(input.reviews ?? DEFAULT_LIMITS.reviews, 'reviews'),
    repairs: positiveInteger(input.repairs ?? DEFAULT_LIMITS.repairs, 'repairs'),
    maxTasks: positiveInteger(input.maxTasks ?? DEFAULT_LIMITS.maxTasks, 'maxTasks'),
    maxTurns: positiveInteger(input.maxTurns ?? DEFAULT_LIMITS.maxTurns, 'maxTurns'),
    maxBudgetUsd: positiveNumber(input.maxBudgetUsd ?? DEFAULT_LIMITS.maxBudgetUsd, 'maxBudgetUsd'),
    timeoutMs: positiveInteger(input.timeoutMs ?? DEFAULT_LIMITS.timeoutMs, 'timeoutMs'),
  });
}

export function normalizeWorkPackage(value, index = 0) {
  object(value, `work package ${index}`);
  const item = {
    id: text(value.id, `work package ${index} id`),
    title: text(value.title, `work package ${index} title`),
    description: text(value.description, `work package ${index} description`),
    paths: [...new Set((value.paths ?? []).map(safePath))],
    dependsOn: [...new Set((value.dependsOn ?? []).map((entry) => text(entry, `work package ${index} dependency`)))],
    acceptanceCriteria: (value.acceptanceCriteria ?? []).map((entry) => text(entry, `work package ${index} acceptance criterion`)),
    backend: String(value.backend ?? 'auto').toLowerCase(),
    gates: [...new Set((value.gates ?? []).map((entry) => text(entry, `work package ${index} gate`)))],
  };
  if (!item.acceptanceCriteria.length) throw new TypeError(`work package ${item.id} requires acceptance criteria`);
  if (!['claude', 'codex', 'auto'].includes(item.backend)) throw new TypeError(`work package ${item.id} has unsupported backend`);
  if (item.dependsOn.includes(item.id)) throw new TypeError(`work package ${item.id} depends on itself`);
  return Object.freeze(item);
}

export function normalizeWorkPackages(values, { maxTasks = DEFAULT_LIMITS.maxTasks, validateDag } = {}) {
  if (!Array.isArray(values) || !values.length) throw new TypeError('at least one work package is required');
  if (values.length > maxTasks) throw new AutoDevPreconditionError(`plan exceeds task limit of ${maxTasks}`, { code: 'TASK_LIMIT' });
  const packages = values.map(normalizeWorkPackage);
  const ids = new Set();
  for (const item of packages) {
    if (ids.has(item.id)) throw new TypeError(`duplicate work package id: ${item.id}`);
    ids.add(item.id);
  }
  for (const item of packages) for (const dependency of item.dependsOn) if (!ids.has(dependency)) throw new TypeError(`work package ${item.id} depends on missing ${dependency}`);
  const byId = new Map(packages.map((item) => [item.id, item]));
  const visiting = new Set();
  const visited = new Set();
  const visit = (id, trail = []) => {
    if (visiting.has(id)) throw new TypeError(`work package dependency cycle: ${[...trail, id].join(' -> ')}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id).dependsOn) visit(dependency, [...trail, id]);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
  const normalized = validateDag ? validateDag(packages) : packages;
  return Object.freeze(normalized.map((item) => Object.freeze(clone(item))));
}

function normalizeCheck(value, index = 0) {
  object(value, `check ${index}`);
  return Object.freeze({
    name: text(value.name, `check ${index} name`),
    passed: value.passed === true,
    required: value.required !== false,
    detail: typeof value.detail === 'string' ? value.detail : '',
    observed: value.observed === true,
    ...(typeof value.packageId === 'string' && value.packageId ? { packageId: value.packageId } : {}),
  });
}

function normalizeFinding(value, index = 0) {
  object(value, `finding ${index}`);
  const severity = String(value.severity ?? '').toLowerCase();
  if (!['critical', 'high', 'medium', 'low', 'info'].includes(severity)) throw new TypeError(`finding ${index} has invalid severity`);
  return Object.freeze({
    id: typeof value.id === 'string' && value.id.trim() ? value.id.trim() : `finding-${index + 1}`,
    severity,
    file: value.file == null ? null : safePath(value.file),
    line: value.line == null ? null : positiveInteger(value.line, `finding ${index} line`),
    title: text(value.title ?? value.summary, `finding ${index} title`),
    detail: text(value.detail ?? value.description, `finding ${index} detail`),
    blocking: value.blocking == null ? ['critical', 'high'].includes(severity) : value.blocking === true,
    ...(typeof value.packageId === 'string' && value.packageId ? { packageId: value.packageId } : {}),
  });
}

function normalizeWorkerResult(result, label) {
  const value = result?.final ?? result;
  object(value, `${label} result`);
  const status = String(value.status ?? '').toLowerCase();
  if (!['succeeded', 'failed', 'blocked'].includes(status)) throw new AutoDevPreconditionError(`${label} returned an invalid status`, { code: 'WORKER_PROTOCOL' });
  return Object.freeze({
    status,
    summary: typeof value.summary === 'string' ? value.summary : '',
    workPackages: Array.isArray(value.workPackages) ? value.workPackages : [],
    changes: Array.isArray(value.changes) ? value.changes.map(clone) : [],
    checks: Array.isArray(value.checks) ? value.checks.map(normalizeCheck) : [],
    findings: Array.isArray(value.findings) ? value.findings.map(normalizeFinding) : [],
    artifacts: Array.isArray(value.artifacts) ? value.artifacts.map(clone) : [],
    criticalActions: Array.isArray(value.criticalActions) ? value.criticalActions.map(clone) : [],
    sessionId: result?.sessionId,
  });
}

function makeReport(run) {
  const tasks = run.packages ?? [];
  const reviews = run.reviews ?? [];
  const quality = run.quality;
  const successful = run.status === 'succeeded' && tasks.every((task) => task.status === 'succeeded') && quality?.passed === true;
  return {
    runId: run.id,
    status: run.status,
    successful,
    summary: successful ? 'Completed and passed all recorded quality gates.' : `Run ended with status ${run.status}; success is not verified.`,
    tasks: { total: tasks.length, completed: tasks.filter((task) => task.status === 'succeeded').length, failed: tasks.filter((task) => task.status === 'failed').length },
    reviews: { total: reviews.length, blocking: reviews.flatMap((review) => review.findings ?? []).filter((finding) => finding.blocking).length },
    quality: quality ? { passed: quality.passed === true, reasons: [...(quality.reasons ?? [])] } : null,
    artifacts: clone(run.artifacts ?? []),
  };
}

export function commandMode(command) {
  const first = text(command, 'command').trim().split(/\s+/, 1)[0].toLowerCase().replace(/^\//, '');
  return mode(first);
}

export class AutoDevManager {
  #ledger;
  #workers;
  #workspace;
  #validator;
  #core;
  #repo;
  #limits;
  #workerOptions;
  #gateIds;
  #events = new EventEmitter();
  #running = new Map();
  #controllers = new Map();
  #closed = false;
  #id;

  constructor({ ledger, workers, workspace, validator, core = {}, repo = process.cwd(), limits = {}, workerOptions = {}, gateIds = validator?.gateIds, id = randomUUID } = {}) {
    if (!ledger || !['create', 'get', 'list', 'update'].every((method) => typeof ledger[method] === 'function')) throw new TypeError('a persistent ledger is required');
    object(workers, 'workers');
    const entries = Object.entries(workers);
    if (!entries.length || entries.some(([name, worker]) => !['claude', 'codex'].includes(name) || typeof worker?.run !== 'function')) {
      throw new TypeError('workers must provide claude and/or codex run implementations');
    }
    if (workspace !== undefined && (!workspace || typeof workspace !== 'object')) throw new TypeError('workspace must be an object');
    if (validator !== undefined && typeof validator !== 'function') throw new TypeError('validator must be a function');
    if (typeof repo !== 'string') throw new TypeError('repo must be a path');
    const configuredGateIds = gateIds ?? DEFAULT_GATE_IDS;
    if (!Array.isArray(configuredGateIds) || configuredGateIds.some((gate) => typeof gate !== 'string' || !gate.trim())) {
      throw new TypeError('gateIds must be an array of non-empty strings');
    }
    this.#ledger = ledger;
    this.#workers = Object.freeze({ ...workers });
    this.#workspace = workspace;
    this.#validator = validator;
    this.#core = core;
    this.#repo = resolve(repo);
    this.#limits = normalizeLimits(limits);
    this.#workerOptions = workerOptions;
    this.#gateIds = new Set(configuredGateIds.map((gate) => gate.trim()));
    this.#id = id;
    this.#events.setMaxListeners(0);
  }

  async create(input = {}) {
    this.#assertOpen();
    object(input, 'run');
    const selectedMode = mode(input.mode);
    if (selectedMode !== 'status') text(input.request, 'request');
    const preferredBackend = input.backend == null || input.backend === 'auto' ? 'auto' : backendName(input.backend, 'preferred backend');
    const run = await this.#ledger.create({
      id: input.id ?? this.#id(),
      mode: selectedMode,
      request: typeof input.request === 'string' ? input.request.trim() : '',
      target: input.target == null ? this.#repo : this.#target(input.target),
      preferredBackend,
      status: 'queued',
      phase: null,
      phaseHistory: [],
      limits: normalizeLimits({ ...this.#limits, ...(input.limits ?? {}) }),
      packages: [], reviews: [], checks: [], artifacts: [], approvals: [], repairCount: 0,
      metadata: input.metadata && typeof input.metadata === 'object' ? clone(input.metadata) : {},
    });
    this.#publish(run);
    return run;
  }

  async start(id) {
    this.#assertOpen();
    const runId = text(id, 'run id');
    const controller = this.#reserve(runId);
    try {
      const run = await this.#mutate(runId, (current) => {
        if (current.status !== 'queued') throw new AutoDevPreconditionError(`run ${id} is ${current.status}, not queued`, { code: 'NOT_STARTABLE' });
        return { status: 'running' };
      }, 'claimed');
      if (this.#closed || controller.signal.aborted || run.status !== 'running') {
        if (this.#controllers.get(runId) === controller) this.#controllers.delete(runId);
        if (run.status === 'cancelled') return run;
        return this.#mutate(run.id, () => ({
          status: 'interrupted',
          failure: 'AutoDev manager closed'
        }), 'interrupted');
      }
      return this.#launch(run, controller);
    } catch (error) {
      if (!this.#running.has(runId) && this.#controllers.get(runId) === controller) this.#controllers.delete(runId);
      throw error;
    }
  }

  async resume(id) {
    this.#assertOpen();
    const runId = text(id, 'run id');
    const controller = this.#reserve(runId);
    try {
      const run = await this.#mutate(runId, (current) => {
        if (!['interrupted', 'pending_approval', 'blocked'].includes(current.status)) {
          throw new AutoDevPreconditionError(`run ${id} is ${current.status}, not resumable`, { code: 'NOT_RESUMABLE' });
        }
        if (current.status === 'pending_approval') {
          const pending = current.approvals?.find((approval) => approval.status === 'pending');
          if (pending) throw new AutoDevPreconditionError(`approval ${pending.id} is still pending`, { code: 'APPROVAL_PENDING' });
          const rejected = current.approvals?.findLast((approval) => approval.status === 'rejected');
          if (rejected) return { status: 'cancelled', failure: `approval rejected: ${rejected.id}` };
        }
        return { status: 'running' };
      }, 'resumed');
      if (run.status === 'cancelled') return run;
      if (this.#closed || controller.signal.aborted || run.status !== 'running') {
        if (this.#controllers.get(runId) === controller) this.#controllers.delete(runId);
        if (run.status === 'cancelled') return run;
        return this.#mutate(run.id, () => ({
          status: 'interrupted',
          failure: 'AutoDev manager closed'
        }), 'interrupted');
      }
      return this.#launch(run, controller);
    } catch (error) {
      if (!this.#running.has(runId) && this.#controllers.get(runId) === controller) this.#controllers.delete(runId);
      throw error;
    }
  }

  status(id) { return this.#required(id); }
  list() { this.#assertOpen(); return this.#ledger.list(); }

  async events(id, { after = 0, listener, limit = 1000 } = {}) {
    this.#assertOpen();
    if (!Number.isSafeInteger(after) || after < 0) throw new TypeError('after must be a non-negative event sequence');
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('event replay limit must be a positive integer');
    const runId = text(id, 'run id');
    const run = await this.#required(runId);
    const replay = (run.events ?? []).filter((event) => event.sequence > after);
    if (replay.length > limit) {
      throw Object.assign(new AutoDevPreconditionError(`event replay exceeds ${limit} entries; refresh run status and reconnect from its latest sequence`, { code: 'EVENT_REPLAY_LIMIT' }), { status: 409 });
    }
    if (listener === undefined) return replay;
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    const key = `run:${runId}`;
    let cursor = after;
    const deliver = (event) => {
      if (event.sequence <= cursor) return;
      cursor = event.sequence;
      try { listener(clone(event)); } catch {}
    };
    this.#events.on(key, deliver);
    try {
      for (const event of replay) deliver(event);
      const caughtUp = await this.#required(runId);
      for (const event of caughtUp.events ?? []) deliver(event);
    } catch (error) {
      this.#events.off(key, deliver);
      throw error;
    }
    return () => this.#events.off(key, deliver);
  }

  #approvalId(approvals = []) {
    const used = new Set(approvals.map((approval) => approval.id));
    const generated = String(this.#id() ?? '').trim().replace(/[\0\r\n]/g, '');
    const base = `approval-${generated || randomUUID()}`;
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) candidate = `${base}-${suffix++}`;
    return candidate;
  }

  #criticalApprovals(actions, existing = []) {
    const approvals = [...existing];
    const created = [];
    for (const action of actions) {
      const approval = {
        id: this.#approvalId(approvals),
        kind: 'worker-critical-action',
        action: String(action.action ?? 'worker-critical-action'),
        status: 'pending',
        critical: true,
        summary: String(action.summary ?? 'Worker requested a critical action.'),
        request: clone(action),
      };
      approvals.push(approval);
      created.push(approval);
    }
    return created;
  }

  async approve(id, approvalId, decision = true, detail = '') {
    this.#assertOpen();
    return this.#mutate(text(id, 'run id'), (run) => {
      const approvals = clone(run.approvals ?? []);
      const index = approvals.findIndex((approval) => approval.id === approvalId);
      if (index < 0) throw new AutoDevPreconditionError(`unknown approval: ${approvalId}`, { code: 'UNKNOWN_APPROVAL' });
      if (approvals[index].status !== 'pending') throw new AutoDevPreconditionError(`approval ${approvalId} is already ${approvals[index].status}`, { code: 'APPROVAL_DECIDED' });
      if (approvals[index].kind !== 'destination-integration' && decision === true) {
        throw new AutoDevPreconditionError('worker-requested critical actions are recorded for an application-owned executor; the manager will not execute them blindly', { code: 'CRITICAL_EXECUTOR_REQUIRED' });
      }
      approvals[index] = { ...approvals[index], status: decision === true ? 'approved' : 'rejected', decidedAt: new Date().toISOString(), detail: String(detail) };
      return { approvals };
    }, decision === true ? 'approved' : 'approval_rejected');
  }

  async cancel(id, reason = 'cancelled by operator') {
    this.#assertOpen();
    const runId = text(id, 'run id');
    this.#controllers.get(runId)?.abort(new Error(String(reason)));
    const run = await this.#mutate(runId, (current) => TERMINAL.has(current.status) ? null : { status: 'cancelled', failure: String(reason) }, 'cancelled');
    this.#controllers.get(runId)?.abort(new Error(String(reason)));
    return run;
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    const active = [...this.#running.keys()];
    for (const controller of this.#controllers.values()) controller.abort(new Error('AutoDev manager closed'));
    for (const id of active) {
      try {
        await this.#mutate(id, (run) => TERMINAL.has(run.status) || run.status === 'pending_approval' ? null : { status: 'interrupted', failure: 'AutoDev manager closed' }, 'interrupted');
      } catch {}
    }
    await Promise.allSettled([...this.#running.values()]);
    await Promise.all(Object.values(this.#workers).map(worker=>Promise.resolve(worker.close?.()).catch(()=>{})));
    this.#events.removeAllListeners();
  }

  #assertOpen() { if (this.#closed) throw new AutoDevManagerError('AutoDev manager is closed', { code: 'CLOSED' }); }

  #target(value) {
    const target = resolve(text(value, 'target'));
    if (target !== this.#repo) {
      throw new AutoDevPreconditionError(`target must match the configured repository: ${this.#repo}`, { code: 'TARGET_MISMATCH' });
    }
    return target;
  }

  async #required(id) {
    this.#assertOpen();
    const run = await this.#ledger.get(text(id, 'run id'));
    if (!run) throw new AutoDevPreconditionError(`unknown run: ${id}`, { code: 'UNKNOWN_RUN' });
    return run;
  }

  #publish(run) {
    const event = run.events?.at(-1);
    if (event) this.#events.emit(`run:${run.id}`, clone(event));
  }

  async #mutate(id, updater, eventType) {
    if (typeof updater !== 'function') throw new TypeError('updater must be a function');
    let run;
    if (typeof this.#ledger.mutate === 'function') {
      run = await this.#ledger.mutate(id, (current) => {
        const patch = updater(clone(current));
        if (patch == null) return null;
        if (current.status === 'cancelled' && patch.status !== 'cancelled') return null;
        if (current.status === 'interrupted' && patch.status !== 'interrupted' && !(eventType === 'resumed' && patch.status === 'running')) return null;
        return patch;
      }, eventType);
    } else {
      const current = await this.#ledger.get(id);
      if (!current) throw new AutoDevPreconditionError(`unknown run: ${id}`, { code: 'UNKNOWN_RUN' });
      const patch = updater(clone(current));
      if (
        patch == null ||
        (current.status === 'cancelled' && patch.status !== 'cancelled') ||
        (current.status === 'interrupted' && patch.status !== 'interrupted' && !(eventType === 'resumed' && patch.status === 'running'))
      ) return current;
      run = await this.#ledger.update(id, patch, eventType);
    }
    this.#publish(run);
    return run;
  }

  #update(id, patch, eventType) {
    return this.#mutate(id, () => patch, eventType);
  }

  #reserve(runId) {
    if (this.#running.has(runId) || this.#controllers.has(runId)) {
      throw new AutoDevPreconditionError(`run ${runId} is already launching or running`, { code: 'ALREADY_RUNNING' });
    }
    const controller = new AbortController();
    this.#controllers.set(runId, controller);
    return controller;
  }

  #launch(run, controller = this.#controllers.get(run.id)) {
    if (this.#running.has(run.id)) return this.#running.get(run.id);
    if (!controller || this.#controllers.get(run.id) !== controller) {
      throw new AutoDevPreconditionError(`run ${run.id} has no launch reservation`, { code: 'LAUNCH_RESERVATION_REQUIRED' });
    }
    if (controller.signal.aborted) return this.#required(run.id);
    const promise = this.#execute(run, controller.signal).finally(() => {
      this.#running.delete(run.id);
      if (this.#controllers.get(run.id) === controller) this.#controllers.delete(run.id);
    });
    this.#running.set(run.id, promise);
    return promise;
  }

  async #phase(run, phase, detail = {}) {
    const phaseHistory = [...(run.phaseHistory ?? []), phase];
    return this.#update(run.id, { status: 'running', phase, phaseHistory, ...detail }, 'phase');
  }

  #selectBackend(preferred, { exclude } = {}) {
    const names = Object.keys(this.#workers).filter((name) => name !== exclude);
    if (preferred && preferred !== 'auto' && this.#workers[preferred] && preferred !== exclude) return preferred;
    if (this.#workers.claude && exclude !== 'claude') return 'claude';
    if (this.#workers.codex && exclude !== 'codex') return 'codex';
    if (names.length) return names[0];
    throw new AutoDevPreconditionError(exclude ? `cross-model backend unavailable; cannot review ${exclude} output` : 'no worker backend is available', { code: 'BACKEND_UNAVAILABLE' });
  }

  async #call(run, backend, role, prompt, cwd, signal) {
    if (signal.aborted) throw new AutoDevCancelledError('run cancelled', { code: 'CANCELLED' });
    const worker = this.#workers[backend];
    if (!worker) throw new AutoDevPreconditionError(`backend unavailable: ${backend}`, { code: 'BACKEND_UNAVAILABLE' });
    let lastEvent;
    const response = await worker.run({
      prompt,
      cwd,
      schema: AUTODEV_RESULT_SCHEMA,
      role,
      maxTurns: run.limits.maxTurns,
      maxBudgetUsd: run.limits.maxBudgetUsd,
      timeoutMs: run.limits.timeoutMs,
      signal,
      onEvent: (event) => { lastEvent = clone(event); },
      ...(this.#workerOptions[backend] ?? {}),
      sandbox: ['planner', 'tester', 'reviewer'].includes(role) ? 'read-only' : 'workspace-write',
    });
    if (lastEvent) await this.#update(run.id, { lastWorkerEvent: lastEvent }, 'worker_event');
    const result = normalizeWorkerResult(response, `${backend} ${role}`);
    if (result.status !== 'succeeded') throw new AutoDevPreconditionError(`${backend} ${role} ${result.status}: ${result.summary}`, { code: 'WORKER_BLOCKED', details: result });
    return result;
  }

  async #execute(initial, signal) {
    let run = initial;
    try {
      if (run.mode === 'status') {
        run = await this.#phase(run, 'REPORT');
        run = await this.#update(run.id, { status: 'succeeded', report: makeReport({ ...run, status: 'succeeded' }) }, 'report');
        return run;
      }
      if (
        run.integrated &&
        run.integrationIntent?.state === 'cleanup_pending' &&
        run.finalValidation?.passed === true
      ) {
        if (typeof this.#workspace?.cleanupIntegration !== 'function') {
          throw new AutoDevPreconditionError('integration cleanup is unavailable', { code: 'INTEGRATION_CLEANUP_REQUIRED' });
        }
        try {
          await this.#workspace.cleanupIntegration(run.integrationIntent);
          run = await this.#update(run.id, {
            integrationIntent: { ...clone(run.integrationIntent), state: 'complete' },
            integrationCleanupFailure: null,
          }, 'integration_cleanup');
        } catch (error) {
          await this.#update(run.id, { integrationCleanupFailure: error.message }, 'integration_cleanup_failed');
          throw new AutoDevPreconditionError(`integration cleanup failed: ${error.message}`, {
            code: 'INTEGRATION_CLEANUP_FAILED',
            cause: error,
          });
        }
        return this.#finish(run, true);
      }
      if (!run.packages?.length) {
        run = await this.#phase(run, 'PLAN');
        const plannerBackend = this.#selectBackend(run.preferredBackend);
        const plan = await this.#call(run, plannerBackend, 'planner', `Plan this ${run.mode} request:\n${run.request}\nTarget: ${run.target ?? this.#repo}`, this.#repo, signal);
        let planned = plan.workPackages;
        if (!planned.length && run.mode !== 'auto-dev') {
          planned = [{ id: 'review-target', title: 'Review target', description: run.request, paths: [], dependsOn: [], acceptanceCriteria: ['Review completed with concrete evidence.'], backend: plannerBackend, gates: [] }];
        }
        const packages = normalizeWorkPackages(planned, { maxTasks: run.limits.maxTasks, validateDag: this.#core.validateDag });
        if (WRITABLE_MODES.has(run.mode)) {
          for (const item of packages) {
            if (!item.gates.length) {
              throw new AutoDevPreconditionError(`writable work package ${item.id} requires at least one registered gate`, { code: 'GATE_REQUIRED' });
            }
            const unknown = item.gates.filter((gate) => !this.#gateIds.has(gate));
            if (unknown.length) {
              throw new AutoDevPreconditionError(`work package ${item.id} requested unknown gate IDs: ${unknown.join(', ')}`, { code: 'UNKNOWN_GATE' });
            }
          }
        }
        run = await this.#update(run.id, { plannerBackend, packages: packages.map((item) => ({ ...item, status: 'planned' })), artifacts: [...run.artifacts, ...plan.artifacts] }, 'planned');
      }

      run = await this.#phase(run, 'DELEGATE');
      const packages = run.packages.map((item) => ({
        ...item,
        backend: item.backend === 'auto' ? this.#selectBackend(run.preferredBackend) : backendName(item.backend, `work package ${item.id} backend`),
        status: item.status === 'succeeded' ? item.status : 'delegated',
      }));
      run = await this.#update(run.id, { packages }, 'delegated');

      if (WRITABLE_MODES.has(run.mode) && !run.implementationComplete) {
        run = await this.#phase(run, 'IMPLEMENT');
        if (!this.#workspace?.prepare) throw new AutoDevPreconditionError('workspace.prepare is required before implementation', { code: 'WORKSPACE_REQUIRED' });
        const byId = new Map(run.packages.map((item) => [item.id, item]));
        for (const item of run.packages) {
          if (!item.paths.length) {
            throw new AutoDevPreconditionError(`writable work package ${item.id} requires an explicit path scope`, { code: 'PATH_SCOPE_REQUIRED' });
          }
        }
        const waves = (this.#core.createSchedule ?? createSchedule)(run.packages, { concurrency: run.limits.concurrency });
        for (const wave of waves) {
          const pending = wave.map((scheduled) => byId.get(scheduled.id)).filter((item) => item.status !== 'succeeded');
          if (!pending.length) continue;
          for (const item of pending) {
            if (!item.dependsOn.every((id) => byId.get(id)?.status === 'succeeded')) {
              throw new AutoDevPreconditionError(`dependencies for ${item.id} have not succeeded`, { code: 'DEPENDENCY_FAILED' });
            }
          }
          const settled = await Promise.allSettled(pending.map(async (item) => {
            const currentRun = { ...run, packages: run.packages.map((entry) => byId.get(entry.id) ?? entry) };
            const workspace = await this.#workspace.prepare({ run: clone(currentRun), package: clone(item), signal });
            if (!workspace || typeof workspace.cwd !== 'string') throw new AutoDevPreconditionError('workspace.prepare did not return cwd', { code: 'WORKSPACE_PROTOCOL' });
            const implementing = { ...item, workspace: clone(workspace), status: 'implementing' };
            byId.set(item.id, implementing);
            await this.#mutate(run.id, (current) => ({
              packages: current.packages.map((entry) => entry.id === item.id ? clone(implementing) : entry),
            }), 'workspace_prepared');
            const dependencyEvidence = Object.fromEntries(item.dependsOn.map((id) => [id, byId.get(id).result]));
            const result = await this.#call(run, item.backend, 'implementer', `Implement work package ${JSON.stringify(item)}. Acceptance criteria are mandatory. Dependency evidence: ${JSON.stringify(dependencyEvidence)}. Do not run gate commands; host-owned validation executes every required gate after implementation. Return succeeded when the scoped implementation is complete, with checks left advisory or empty.`, workspace.cwd, signal);
            const finalized = this.#workspace.complete
              ? await this.#workspace.complete({ run: clone(run), package: clone(item), workspace: clone(workspace), result: clone(result), signal })
              : workspace;
            if (!finalized || typeof finalized.cwd !== 'string') {
              throw new AutoDevPreconditionError('workspace.complete did not return cwd', { code: 'WORKSPACE_PROTOCOL' });
            }
            const completed = { ...item, status: 'succeeded', workspace: clone(finalized), result: clone(result) };
            byId.set(item.id, completed);
            await this.#mutate(run.id, (current) => ({
              packages: current.packages.map((entry) => entry.id === item.id ? clone(completed) : entry),
              artifacts: [...(current.artifacts ?? []), ...result.artifacts],
            }), 'package_completed');
            return { item, result };
          }));
          const criticalActions = settled
            .filter((entry) => entry.status === 'fulfilled')
            .flatMap(({ value }) => value.result.criticalActions);
          const approvals = this.#criticalApprovals(criticalActions, run.approvals ?? []);
          if (approvals.length) {
            run = await this.#update(run.id, { status: 'pending_approval', approvals: [...(run.approvals ?? []), ...approvals] }, 'approval_required');
            throw new AutoDevApprovalRequiredError('worker requested critical action approval', { code: 'APPROVAL_REQUIRED' });
          }
          const rejected = settled.find((entry) => entry.status === 'rejected');
          if (rejected) throw rejected.reason;
        }
        run = await this.#update(run.id, { implementationComplete: true, packages: run.packages.map((item) => byId.get(item.id)) }, 'implementation_completed');
      }

      let gate;
      if (WRITABLE_MODES.has(run.mode) && run.repairState) {
        gate = run.quality ?? this.#quality(run.checks, run.reviews);
      } else {
        if (WRITABLE_MODES.has(run.mode)) run = await this.#runTests(run, signal);
        run = await this.#runReviews(run, signal);
        gate = this.#quality(run.checks, run.reviews);
      }
      while (
        !gate.passed &&
        WRITABLE_MODES.has(run.mode) &&
        (run.repairState || run.repairCount < run.limits.repairs)
      ) {
        let repairState = run.repairState ? clone(run.repairState) : null;
        if (!repairState) {
          const repairRound = run.repairCount + 1;
          const affected = new Map();
          for (const check of gate.failedChecks ?? []) {
            if (!check.packageId) continue;
            const reasons = affected.get(check.packageId) ?? [];
            reasons.push(`check ${check.name}: ${check.detail || 'failed'}`);
            affected.set(check.packageId, reasons);
          }
          for (const finding of gate.blockingFindings ?? []) {
            if (!finding.packageId) continue;
            const reasons = affected.get(finding.packageId) ?? [];
            reasons.push(`finding ${finding.id}: ${finding.detail}`);
            affected.set(finding.packageId, reasons);
          }
          if (!affected.size) {
            for (const item of run.packages) affected.set(item.id, gate.reasons);
          }
          repairState = {
            round: repairRound,
            affected: Object.fromEntries(affected),
            completed: [],
          };
          run = await this.#phase(run, 'FIX', {
            quality: gate,
            repairCount: repairRound,
            repairState,
          });
        } else {
          run = await this.#phase(run, 'FIX', { quality: gate });
        }
        const repairRound = repairState.round;
        const completed = new Set(repairState.completed ?? []);
        for (const item of run.packages) {
          const reasons = repairState.affected?.[item.id];
          if (!reasons || completed.has(item.id)) continue;
          const result = await this.#call(
            run,
            item.backend,
            'fixer',
            `Repair these verified failures for work package ${JSON.stringify({
              id: item.id,
              title: item.title,
              description: item.description,
              paths: item.paths,
              acceptanceCriteria: item.acceptanceCriteria,
              gates: item.gates,
            })}: ${JSON.stringify(reasons)}. Modify only the declared paths.`,
            item.workspace.cwd,
            signal,
          );
          if (result.criticalActions.length) {
            const approvals = this.#criticalApprovals(result.criticalActions, run.approvals ?? []);
            run = await this.#update(run.id, { status: 'pending_approval', approvals: [...(run.approvals ?? []), ...approvals] }, 'approval_required');
            throw new AutoDevApprovalRequiredError('fixer requested critical action approval', { code: 'APPROVAL_REQUIRED' });
          }
          const workspace = this.#workspace.complete
            ? await this.#workspace.complete({ run: clone(run), package: clone(item), workspace: clone(item.workspace), result: clone(result), signal })
            : item.workspace;
          if (!workspace || typeof workspace.cwd !== 'string') {
            throw new AutoDevPreconditionError('workspace.complete did not return cwd after repair', { code: 'WORKSPACE_PROTOCOL' });
          }
          completed.add(item.id);
          const repaired = {
            ...item,
            workspace: clone(workspace),
            result: clone(result),
            status: 'succeeded',
            repairRound,
          };
          repairState = { ...repairState, completed: [...completed] };
          run = await this.#mutate(run.id, (current) => ({
            packages: current.packages.map((entry) => entry.id === item.id ? clone(repaired) : entry),
            repairState: clone(repairState),
            artifacts: [...(current.artifacts ?? []), ...result.artifacts],
          }), 'repair_package_completed');
        }
        run = await this.#update(run.id, {
          repairState: null,
          reviews: [],
          checks: [],
        }, 'repaired');
        run = await this.#runTests(run, signal);
        run = await this.#runReviews(run, signal);
        gate = this.#quality(run.checks, run.reviews);
      }
      run = await this.#update(run.id, { quality: gate }, 'quality_evaluated');
      if (!gate.passed) throw new AutoDevPreconditionError(`quality gates did not pass: ${gate.reasons.join('; ')}`, { code: 'QUALITY_FAILED', details: gate });

      if (WRITABLE_MODES.has(run.mode) && !run.integrated) {
        run = await this.#phase(run, 'INTEGRATE');
        const splitIntegration = ['prepareIntegration', 'applyIntegration', 'reconcileIntegration'].every((method) => typeof this.#workspace?.[method] === 'function');
        if (!splitIntegration && !this.#workspace?.integrate) {
          throw new AutoDevPreconditionError('workspace integration is required; refusing blind integration', { code: 'INTEGRATION_REQUIRED' });
        }
        if (splitIntegration) {
          let intent = run.integrationIntent;
          if (!intent) {
            intent = await this.#workspace.prepareIntegration({ run: clone(run), packages: clone(run.packages), signal });
            if (!intent?.expectedHead || !intent?.stagedHead) throw new AutoDevPreconditionError('workspace returned an invalid integration intent', { code: 'INTEGRATION_PROTOCOL' });
            const scope = integrationApprovalScope(run, intent);
            intent = { ...clone(intent), approvalDigest: approvalDigest(scope) };
            run = await this.#update(run.id, { integrationIntent: intent }, 'integration_intent');
          }
          const scope = integrationApprovalScope(run, intent);
          const digest = approvalDigest(scope);
          if (digest !== intent.approvalDigest) throw new AutoDevPreconditionError('integration intent approval digest is invalid', { code: 'APPROVAL_MISMATCH' });
          if (run.integrationValidation?.stagedHead !== intent.stagedHead) {
            if (!this.#validator) throw new AutoDevPreconditionError('an application-level validator is required before integration approval', { code: 'VALIDATOR_REQUIRED' });
            const validation = await this.#validator({ run: clone(run), cwd: intent.staging?.cwd, signal });
            const validationChecks = (validation?.checks ?? []).map((check) => ({ ...normalizeCheck(check), observed: true }));
            if (!validationChecks.length) throw new AutoDevPreconditionError('staged integration validator returned no checks', { code: 'VALIDATION_EMPTY' });
            const validationGate = this.#quality(validationChecks, run.reviews);
            run = await this.#update(run.id, {
              integrationValidation: { stagedHead: intent.stagedHead, checks: validationChecks },
            }, 'integration_validated');
            if (!validationGate.passed) {
              throw new AutoDevPreconditionError(`staged integration validation failed: ${validationGate.reasons.join('; ')}`, { code: 'VALIDATION_FAILED', details: validationGate });
            }
          }
          const prior = run.approvals?.find((approval) => approval.kind === 'destination-integration' && approval.status === 'approved' && approval.digest === digest && !approval.consumedAt);
          if (!prior) {
            const pending = run.approvals?.find((approval) => approval.kind === 'destination-integration' && approval.status === 'pending' && approval.digest === digest);
            if (pending) return this.#update(run.id, { status: 'pending_approval' }, 'approval_required');
            const approval = { id: this.#approvalId(run.approvals ?? []), kind: 'destination-integration', action: 'integrate', status: 'pending', critical: true, digest, scope, summary: 'Integrate the exact validated work packages into the destination checkout.' };
            return this.#update(run.id, { status: 'pending_approval', approvals: [...(run.approvals ?? []), approval] }, 'approval_required');
          }
          const reconciliation = await this.#workspace.reconcileIntegration(intent, { signal });
          if (reconciliation?.state === 'diverged') {
            throw new AutoDevPreconditionError(`integration destination diverged at ${reconciliation.head}`, { code: 'INTEGRATION_DIVERGED', details: reconciliation });
          }
          let integration = reconciliation?.state === 'applied'
            ? { success: true, ...reconciliation, stagedHead: intent.stagedHead, artifacts: intent.artifacts ?? [] }
            : await this.#workspace.applyIntegration(intent, { signal });
          if (!integration || integration.success !== true) throw new AutoDevPreconditionError('integration did not return verified success', { code: 'INTEGRATION_FAILED', details: integration });
          run = await this.#mutate(run.id, (current) => ({
            integrated: true,
            integration: clone(integration),
            integrationIntent: { ...clone(intent), state: 'cleanup_pending' },
            artifacts: [...(current.artifacts ?? []), ...(integration.artifacts ?? [])],
            approvals: (current.approvals ?? []).map((approval) => approval.id === prior.id ? { ...approval, consumedAt: new Date().toISOString() } : approval),
          }), 'integrated');
        } else {
          const prior = run.approvals?.find((approval) => approval.kind === 'destination-integration' && approval.action === 'integrate' && approval.status === 'approved');
          if (!prior) {
            const approval = { id: this.#approvalId(run.approvals ?? []), kind: 'destination-integration', action: 'integrate', status: 'pending', critical: true, summary: 'Integrate verified work packages into the destination checkout.' };
            return this.#update(run.id, { status: 'pending_approval', approvals: [...(run.approvals ?? []), approval] }, 'approval_required');
          }
          const integration = await this.#workspace.integrate({ run: clone(run), packages: clone(run.packages), approval: clone(prior), signal });
          if (!integration || integration.success !== true) throw new AutoDevPreconditionError('integration did not return verified success', { code: 'INTEGRATION_FAILED', details: integration });
          run = await this.#update(run.id, { integrated: true, integration: clone(integration), artifacts: [...run.artifacts, ...(integration.artifacts ?? [])] }, 'integrated');
        }
      }

      run = await this.#phase(run, 'VALIDATE');
      if (!this.#validator) throw new AutoDevPreconditionError('an application-level validator is required before reporting success', { code: 'VALIDATOR_REQUIRED' });
      const result = await this.#validator({ run: clone(run), cwd: this.#repo, signal });
      const checks = (result?.checks ?? []).map((check) => ({ ...normalizeCheck(check), observed: true }));
      if (!checks.length) throw new AutoDevPreconditionError('validator returned no checks', { code: 'VALIDATION_EMPTY' });
      run = await this.#update(run.id, { checks: [...run.checks, ...checks] }, 'validated');
      gate = this.#quality(run.checks, run.reviews);
      if (!gate.passed || !run.checks.length) throw new AutoDevPreconditionError(!run.checks.length ? 'no validation checks were recorded' : `validation failed: ${gate.reasons.join('; ')}`, { code: 'VALIDATION_FAILED', details: gate });
      run = await this.#update(run.id, {
        quality: gate,
        finalValidation: {
          passed: true,
          head: run.integration?.head ?? null,
          checks: clone(checks),
        },
      }, 'validation_gate');
      if (run.integrationIntent?.state === 'cleanup_pending') {
        if (typeof this.#workspace?.cleanupIntegration !== 'function') {
          throw new AutoDevPreconditionError('integration cleanup is unavailable', { code: 'INTEGRATION_CLEANUP_REQUIRED' });
        }
        try {
          await this.#workspace.cleanupIntegration(run.integrationIntent);
          run = await this.#update(run.id, {
            integrationIntent: { ...clone(run.integrationIntent), state: 'complete' },
            integrationCleanupFailure: null,
          }, 'integration_cleanup');
        } catch (error) {
          await this.#update(run.id, { integrationCleanupFailure: error.message }, 'integration_cleanup_failed');
          throw new AutoDevPreconditionError(`integration cleanup failed: ${error.message}`, {
            code: 'INTEGRATION_CLEANUP_FAILED',
            cause: error,
          });
        }
      }
      return this.#finish(run, true);
    } catch (error) {
      const current = await this.#ledger.get(initial.id);
      if (current?.status === 'cancelled' || signal.aborted || error instanceof AutoDevCancelledError) return current ?? initial;
      if (error instanceof AutoDevApprovalRequiredError && current?.status === 'pending_approval') return current;
      const status = error instanceof AutoDevPreconditionError ? 'blocked' : 'failed';
      const failed = await this.#update(initial.id, { status, failure: error.message, errorCode: error.code ?? 'UNEXPECTED' }, status);
      return this.#finish(failed, false);
    }
  }

  async #runTests(run, signal) {
    run = await this.#phase(run, 'TEST');
    if (!this.#validator) {
      throw new AutoDevPreconditionError('an application-level validator is required for package gates', { code: 'VALIDATOR_REQUIRED' });
    }
    const checks = [];
    for (const item of run.packages) {
      const advisory = await this.#call(run, item.backend, 'tester', `Inspect the required gates for ${item.id}: ${JSON.stringify(item.gates)}. Do not edit files. Your reported checks are advisory; the host will execute and verify every required gate.`, item.workspace.cwd, signal);
      const validation = await this.#validator({
        run: clone(run),
        package: clone(item),
        cwd: item.workspace.cwd,
        gates: [...item.gates],
        signal,
      });
      const observed = (validation?.checks ?? []).map((check) => ({
        ...normalizeCheck(check),
        observed: true,
        packageId: item.id,
      }));
      for (const required of item.gates) {
        const direct = observed.find((check) => check.name === required);
        if (direct) continue;
        observed.push({
          name: required,
          passed: false,
          required: true,
          detail: 'Required gate has no exact host-observed result.',
          observed: false,
          packageId: item.id,
        });
      }
      checks.push(...observed);
      for (const check of advisory.checks) {
        if (!observed.some((entry) => entry.name === check.name)) {
          checks.push({
            ...check,
            passed: false,
            required: false,
            detail: `Advisory worker assertion only: ${check.detail}`,
            observed: false,
            packageId: item.id,
          });
        }
      }
    }
    if (!checks.length) throw new AutoDevPreconditionError('implementation produced no host-observed tests or gates', { code: 'TEST_EVIDENCE_REQUIRED' });
    return this.#update(run.id, { checks }, 'tested');
  }

  async #runReviews(run, signal) {
    run = await this.#phase(run, 'REVIEW');
    const reviews = [];
    const reviewCount = run.mode === 'deep-review' ? Math.max(2, run.limits.reviews) : run.limits.reviews;
    for (const item of run.packages) {
      for (let index = 0; index < reviewCount; index++) {
        const reviewerBackend = this.#selectBackend(index ? 'auto' : undefined, { exclude: item.backend });
        if (reviewerBackend === item.backend) throw new AutoDevPreconditionError('cross-model review is required', { code: 'CROSS_MODEL_REQUIRED' });
        const cwd = item.workspace?.cwd ?? this.#repo;
        const evidence = WRITABLE_MODES.has(run.mode)
          ? await this.#workspace?.reviewEvidence?.({ run: clone(run), package: clone(item), signal })
          : null;
        if (WRITABLE_MODES.has(run.mode) && !evidence) {
          throw new AutoDevPreconditionError(`authoritative review evidence is unavailable for package ${item.id}`, { code: 'REVIEW_EVIDENCE_REQUIRED' });
        }
        const result = await this.#call(run, reviewerBackend, 'reviewer', `Independently review package ${item.id} produced by ${item.backend}. Request: ${run.request}. Host-authoritative evidence: ${JSON.stringify(evidence ?? { readOnlyRequest: run.request })}`, cwd, signal);
        let review = { reviewer: `${reviewerBackend}-reviewer-${index + 1}`, backend: reviewerBackend, subjectBackend: item.backend, packageId: item.id, summary: result.summary, findings: result.findings.map((finding) => ({ ...finding, packageId: item.id })) };
        review = this.#core.requireCrossModelReview ? this.#core.requireCrossModelReview(review) : review;
        reviews.push(clone(review));
      }
    }
    return this.#update(run.id, {
      reviews,
      ...(WRITABLE_MODES.has(run.mode)
        ? {}
        : {
            packages: run.packages.map((item) => ({
              ...item,
              status: 'succeeded',
              result: {
                status: 'succeeded',
                summary: 'Read-only cross-model review completed.',
              },
            })),
          }),
    }, 'reviewed');
  }

  #quality(checks, reviews) {
    return clone((this.#core.evaluateQualityGate ?? evaluateQualityGate)({ checks, reviews }));
  }

  async #finish(run, passed) {
    if (passed) run = await this.#phase(run, 'REPORT');
    else run = await this.#update(run.id, { phase: 'REPORT', phaseHistory: [...(run.phaseHistory ?? []), 'REPORT'] }, 'phase');
    const status = passed ? 'succeeded' : run.status;
    run = await this.#update(run.id, { status }, passed ? 'succeeded' : 'reported');
    const report = this.#core.buildReport ? this.#core.buildReport(run, { tasks: run.packages, reviews: run.reviews, quality: run.quality, artifacts: run.artifacts }) : makeReport(run);
    return this.#update(run.id, { report }, 'report');
  }
}

export async function createAutoDevManager({ ledger, ledgerFile, ledgerOptions, core, ...options } = {}) {
  let resolvedLedger = ledger;
  if (!resolvedLedger && ledgerFile) {
    const { createLedger } = await import('./ledger.mjs');
    resolvedLedger = createLedger(ledgerFile, ledgerOptions);
    await resolvedLedger.recover();
  }
  if (!resolvedLedger) throw new TypeError('ledger or ledgerFile is required');
  let resolvedCore = core;
  if (!resolvedCore) {
    const [scheduler, review, quality, report] = await Promise.all([
      import('./scheduler.mjs'), import('./review.mjs'), import('./quality.mjs'), import('./report.mjs'),
    ]);
    resolvedCore = { ...scheduler, ...review, ...quality, ...report };
  }
  return new AutoDevManager({ ...options, ledger: resolvedLedger, core: resolvedCore });
}

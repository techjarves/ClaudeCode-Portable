import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { redact as defaultRedact } from '../config.mjs';

const RO_TOOLS = Object.freeze(['Read', 'Glob', 'Grep']);
const RW_TOOLS = Object.freeze(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash']);
const ROLES = new Set(['planner', 'implementer', 'tester', 'reviewer', 'fixer']);

const workPackageSchema = {
  type: 'object', additionalProperties: false,
  required: ['id', 'title', 'description', 'paths', 'dependsOn', 'acceptanceCriteria', 'backend', 'gates'],
  properties: {
    id: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' },
    paths: { type: 'array', items: { type: 'string' } },
    dependsOn: { type: 'array', items: { type: 'string' } },
    acceptanceCriteria: { type: 'array', items: { type: 'string' } },
    backend: { type: 'string', enum: ['claude', 'codex', 'auto'] },
    gates: { type: 'array', items: { type: 'string' } },
  },
};
const changeSchema = {
  type: 'object', additionalProperties: false, required: ['path', 'summary', 'status'],
  properties: { path: { type: 'string' }, summary: { type: 'string' }, status: { type: 'string', enum: ['changed', 'unchanged', 'blocked'] } },
};
const checkSchema = {
  type: 'object', additionalProperties: false, required: ['name', 'passed', 'required', 'detail'],
  properties: { name: { type: 'string' }, passed: { type: 'boolean' }, required: { type: 'boolean' }, detail: { type: 'string' } },
};
const findingSchema = {
  type: 'object', additionalProperties: false, required: ['id', 'severity', 'file', 'line', 'title', 'detail', 'blocking'],
  properties: {
    id: { type: 'string' }, severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
    file: { anyOf: [{ type: 'string' }, { type: 'null' }] }, line: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
    title: { type: 'string' }, detail: { type: 'string' }, blocking: { type: 'boolean' },
  },
};
const artifactSchema = {
  type: 'object', additionalProperties: false, required: ['type', 'path', 'description', 'digest'],
  properties: {
    type: { type: 'string' }, path: { type: 'string' }, description: { type: 'string' },
    digest: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
};
const criticalActionSchema = {
  type: 'object', additionalProperties: false, required: ['id', 'action', 'summary', 'command'],
  properties: {
    id: { type: 'string' }, action: { type: 'string' }, summary: { type: 'string' },
    command: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
};

export const CLAUDE_WORKER_FINAL_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['status', 'summary', 'workPackages', 'changes', 'checks', 'findings', 'artifacts', 'criticalActions'],
  properties: {
    status: { type: 'string', enum: ['succeeded', 'failed', 'blocked'] }, summary: { type: 'string' },
    workPackages: { type: 'array', items: workPackageSchema }, changes: { type: 'array', items: changeSchema },
    checks: { type: 'array', items: checkSchema }, findings: { type: 'array', items: findingSchema },
    artifacts: { type: 'array', items: artifactSchema }, criticalActions: { type: 'array', items: criticalActionSchema },
  },
});

export const CLAUDE_WORKER_AGENTS = Object.freeze({
  planner: Object.freeze({
    description: 'Creates bounded, dependency-aware implementation work packages without changing files.',
    prompt: 'Inspect the request and repository. Return only the required structured result. Plan concrete work packages with explicit paths, dependencies, acceptance criteria, and backend preferences. Do not modify files.',
    tools: RO_TOOLS,
    disallowedTools: ['Edit', 'Write', 'Bash'],
    model: 'inherit',
    maxTurns: 12,
    effort: 'high',
    permissionMode: 'dontAsk',
  }),
  implementer: Object.freeze({
    description: 'Implements one explicitly scoped work package and records truthful checks and artifacts.',
    prompt: 'Implement only the assigned work package and its declared paths. Never merge, push, deploy, publish, delete broadly, or claim a check ran when it did not. Return only the required structured result.',
    tools: RW_TOOLS,
    model: 'inherit',
    maxTurns: 24,
    effort: 'high',
    permissionMode: 'default',
  }),
  tester: Object.freeze({
    description: 'Inspects validation requirements and reports advisory observations without editing files or running commands.',
    prompt: 'Inspect only the requested checks. Do not edit files or run commands. Your report is advisory; the host executes every authoritative gate.',
    tools: RO_TOOLS,
    disallowedTools: ['Edit', 'Write', 'Bash'],
    model: 'inherit',
    maxTurns: 12,
    effort: 'high',
    permissionMode: 'default',
  }),
  reviewer: Object.freeze({
    description: 'Performs an independent correctness and security review without changing files.',
    prompt: 'Review the supplied implementation and evidence. Do not edit files. Return concrete findings with severity, path, line, blocking status, and detail. Return only the required structured result.',
    tools: RO_TOOLS,
    disallowedTools: ['Edit', 'Write', 'Bash'],
    model: 'inherit',
    maxTurns: 16,
    effort: 'high',
    permissionMode: 'dontAsk',
  }),
  fixer: Object.freeze({
    description: 'Repairs only verified gate failures or review findings in the assigned scope.',
    prompt: 'Fix only the supplied failed checks and review findings. Do not merge, push, deploy, publish, or perform broad deletion. Return only the required structured result.',
    tools: RW_TOOLS,
    model: 'inherit',
    maxTurns: 20,
    effort: 'high',
    permissionMode: 'default',
  }),
});

const SHELL_PREFIX = '(?:(?:sudo|command|env|builtin|nohup)\\s+)+';
const CRITICAL_BASH = new RegExp(
  `(?:^|[;&|]\\s*)(?:${SHELL_PREFIX})?(?:` +
  'rm\\s+(?:-[^\\s;|]*[rR][^\\s;|]*\\s+|--recursive\\b)|' +
  'find\\b[^;&|]*(?:-delete|-exec(?:dir)?\\s+rm\\b)|' +
  'git(?:\\s+-[^\\s;|]+(?:\\s+[^\\s;|]+)?)*\\s+(?:push|merge|rebase|reset|clean)\\b|' +
  '(?:npm|pnpm|yarn)(?:\\s+--[^\\s;|]+(?:\\s+[^\\s;|]+)?)*\\s+publish\\b|' +
  '(?:[^\\s;|]+\\s+)?deploy\\b|kubectl\\s+(?:apply|delete)\\b|terraform\\s+apply\\b' +
  ')',
  'i',
);
const FILE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);

function contained(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function insideWorkspace(cwd, value) {
  if (typeof value !== 'string' || !value || /[\0\r\n]/.test(value)) return false;
  const lexicalRoot = resolve(cwd);
  const target = isAbsolute(value) ? resolve(value) : resolve(lexicalRoot, value);
  if (!contained(lexicalRoot, target)) return false;
  if (!existsSync(lexicalRoot)) return true;
  const root = realpathSync(lexicalRoot);
  let existing = target;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return false;
    existing = parent;
  }
  return contained(root, realpathSync(existing));
}

function workspacePermission(cwd, fallback) {
  return async (toolName, input, context = {}) => {
    if (FILE_TOOLS.has(toolName)) {
      const path = input?.file_path ?? input?.notebook_path ?? input?.path;
      if (!insideWorkspace(cwd, path)) {
        return { behavior: 'deny', message: 'AutoDev file writes must stay inside the owned worktree.' };
      }
    }
    return fallback(toolName, input, context);
  };
}

export class ClaudeWorkerError extends Error {
  constructor(message, { code = 'CLAUDE_WORKER_ERROR', cause, details } = {}) {
    super(message, { cause });
    this.name = this.constructor.name;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
export class ClaudeWorkerAbortError extends ClaudeWorkerError {}
export class ClaudeWorkerTimeoutError extends ClaudeWorkerError {}
export class ClaudeWorkerProtocolError extends ClaudeWorkerError {}
export class ClaudeWorkerResultError extends ClaudeWorkerError {}

function positive(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function finitePositive(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be positive`);
  return value;
}

function safeClone(value, redact) {
  const visit = (item) => {
    if (typeof item === 'string') return redact(item);
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child)]));
    return item;
  };
  return visit(structuredClone(value));
}

function validateSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || schema.type !== 'object') {
    throw new TypeError('Claude output schema must be a JSON object schema');
  }
  return schema;
}

function defaultCanUseTool(toolName, input, { signal } = {}) {
  if (signal?.aborted) return Promise.resolve({ behavior: 'deny', message: 'Operation was cancelled.', interrupt: true });
  if (toolName === 'Bash') {
    const command = String(input?.command ?? '');
    if (CRITICAL_BASH.test(command)) {
      return Promise.resolve({
        behavior: 'deny',
        message: 'Critical integration, deployment, publication, destructive, and privilege-changing actions must be returned in criticalActions for host approval.',
      });
    }
  }
  return Promise.resolve({ behavior: 'allow', updatedInput: input });
}

export class ClaudeWorker {
  #query;
  #loadSdk;
  #model;
  #agents;
  #defaults;
  #redact;
  #setTimeout;
  #clearTimeout;
  #baseOptions;
  #closeHook;
  #active = new Set();

  constructor({
    query,
    loadSdk = () => import('@anthropic-ai/claude-agent-sdk'),
    model = 'claude-opus-5',
    agents = CLAUDE_WORKER_AGENTS,
    maxTurns = 24,
    maxBudgetUsd = 10,
    timeoutMs = 15 * 60 * 1000,
    permissionMode = 'default',
    canUseTool = defaultCanUseTool,
    redact = defaultRedact,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    baseOptions = {},
    closeHook,
  } = {}) {
    if (query !== undefined && typeof query !== 'function') throw new TypeError('query must be a function');
    if (typeof loadSdk !== 'function') throw new TypeError('loadSdk must be a function');
    if (typeof model !== 'string' || !model.trim()) throw new TypeError('Claude model is required');
    if (!agents || typeof agents !== 'object' || Array.isArray(agents)) throw new TypeError('Claude agents must be an object');
    for (const role of ROLES) if (!agents[role]) throw new TypeError(`missing Claude agent definition: ${role}`);
    if (typeof canUseTool !== 'function') throw new TypeError('canUseTool must be a function');
    if (!baseOptions || typeof baseOptions !== 'object' || Array.isArray(baseOptions)) throw new TypeError('baseOptions must be an object');
    if (closeHook !== undefined && typeof closeHook !== 'function') throw new TypeError('closeHook must be a function');
    this.#query = query;
    this.#loadSdk = loadSdk;
    this.#model = model;
    this.#agents = agents;
    this.#defaults = {
      maxTurns: positive(maxTurns, 'maxTurns'),
      maxBudgetUsd: finitePositive(maxBudgetUsd, 'maxBudgetUsd'),
      timeoutMs: positive(timeoutMs, 'timeoutMs'),
      permissionMode,
      canUseTool,
    };
    this.#redact = redact;
    this.#setTimeout = setTimeoutImpl;
    this.#clearTimeout = clearTimeoutImpl;
    this.#baseOptions = { ...baseOptions };
    this.#closeHook = closeHook;
  }

  async run({
    prompt,
    cwd,
    schema = CLAUDE_WORKER_FINAL_SCHEMA,
    role = 'implementer',
    model = this.#model,
    maxTurns = this.#defaults.maxTurns,
    maxBudgetUsd = this.#defaults.maxBudgetUsd,
    timeoutMs = this.#defaults.timeoutMs,
    sessionId,
    resume,
    signal,
    onEvent = () => {},
    sandbox,
  } = {}) {
    if (typeof prompt !== 'string' || !prompt.trim()) throw new TypeError('Claude prompt is required');
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new TypeError('an absolute Claude working directory is required');
    if (!ROLES.has(role)) throw new TypeError(`unsupported Claude worker role: ${role}`);
    if (typeof model !== 'string' || !model.trim()) throw new TypeError('Claude model is required');
    positive(maxTurns, 'maxTurns');
    finitePositive(maxBudgetUsd, 'maxBudgetUsd');
    positive(timeoutMs, 'timeoutMs');
    validateSchema(schema);
    if (sessionId !== undefined && (typeof sessionId !== 'string' || !sessionId)) throw new TypeError('sessionId must be a non-empty string');
    if (resume !== undefined && (typeof resume !== 'string' || !resume)) throw new TypeError('resume must be a non-empty string');
    if (sessionId && resume) throw new TypeError('sessionId and resume are mutually exclusive');
    if (typeof onEvent !== 'function') throw new TypeError('onEvent must be a function');
    const roleSandbox = sandbox ?? (['planner', 'tester', 'reviewer'].includes(role) ? 'read-only' : 'workspace-write');
    if (!['read-only', 'workspace-write'].includes(roleSandbox)) throw new TypeError('unsupported Claude sandbox');
    if (['planner', 'tester', 'reviewer'].includes(role) && roleSandbox !== 'read-only') {
      throw new TypeError(`${role} requires a read-only Claude sandbox`);
    }
    if (signal?.aborted) throw new ClaudeWorkerAbortError('Claude run aborted', { code: 'CLAUDE_ABORTED' });

    const query = this.#query ?? (await this.#loadSdk()).query;
    if (typeof query !== 'function') throw new ClaudeWorkerProtocolError('Claude Agent SDK does not export query()', { code: 'CLAUDE_SDK' });

    const controller = new AbortController();
    const operation = { controller, stream: null };
    this.#active.add(operation);
    let timedOut = false;
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const timer = this.#setTimeout(() => { timedOut = true; controller.abort(new Error('timeout')); }, timeoutMs);
    let result;

    const roleTools = this.#agents[role].tools.filter(
      (tool) => !this.#agents[role].disallowedTools?.includes(tool),
    );
    const options = {
      ...this.#baseOptions,
      cwd,
      model,
      maxTurns,
      maxBudgetUsd,
      abortController: controller,
      persistSession: true,
      settingSources: [],
      tools: roleTools,
      agents: this.#agents,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: this.#agents[role].prompt,
      },
      disallowedTools: [
        ...new Set([
          ...RO_TOOLS.filter((tool) => !this.#agents[role].tools?.includes(tool)),
          ...RW_TOOLS.filter((tool) => !this.#agents[role].tools?.includes(tool)),
          ...(this.#agents[role].disallowedTools ?? []),
        ]),
      ],
      permissionMode: this.#agents[role].permissionMode ?? this.#defaults.permissionMode,
      canUseTool: workspacePermission(cwd, this.#defaults.canUseTool),
      sandbox: {
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
        filesystem: roleSandbox === 'workspace-write'
          ? { allowWrite: [cwd] }
          : { denyWrite: [cwd] },
      },
      outputFormat: { type: 'json_schema', schema },
      ...(sessionId ? { sessionId } : {}),
      ...(resume ? { resume } : {}),
    };

    try {
      operation.stream = query({ prompt, options });
      if (!operation.stream || typeof operation.stream[Symbol.asyncIterator] !== 'function') {
        throw new ClaudeWorkerProtocolError('Claude query() did not return an async iterable', { code: 'CLAUDE_PROTOCOL' });
      }
      for await (const message of operation.stream) {
        onEvent(safeClone(message, this.#redact));
        if (message?.type === 'result') result = message;
      }
    } catch (cause) {
      if (timedOut) throw new ClaudeWorkerTimeoutError(`Claude timed out after ${timeoutMs}ms`, { code: 'CLAUDE_TIMEOUT', cause });
      if (signal?.aborted || controller.signal.aborted) throw new ClaudeWorkerAbortError('Claude run aborted', { code: 'CLAUDE_ABORTED', cause });
      if (cause instanceof ClaudeWorkerError) throw cause;
      throw new ClaudeWorkerError(`Claude worker failed: ${this.#redact(cause?.message ?? String(cause))}`, { code: 'CLAUDE_EXECUTION', cause });
    } finally {
      this.#clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      try { operation.stream?.close?.(); } catch {}
      this.#active.delete(operation);
    }

    if (!result) throw new ClaudeWorkerProtocolError('Claude query ended without a result message', { code: 'CLAUDE_PROTOCOL' });
    if (result.subtype !== 'success' || result.is_error === true) {
      throw new ClaudeWorkerResultError(`Claude returned ${result.subtype ?? 'an error result'}`, {
        code: 'CLAUDE_RESULT',
        details: safeClone({ subtype: result.subtype, errors: result.errors ?? [] }, this.#redact),
      });
    }
    if (result.structured_output === undefined || result.structured_output === null || typeof result.structured_output !== 'object' || Array.isArray(result.structured_output)) {
      throw new ClaudeWorkerProtocolError('Claude success result did not include structured_output', { code: 'CLAUDE_PROTOCOL' });
    }
    return Object.freeze({
      final: safeClone(result.structured_output, this.#redact),
      sessionId: result.session_id,
      result: this.#redact(result.result ?? ''),
      turns: result.num_turns,
      costUsd: result.total_cost_usd,
      usage: safeClone(result.usage ?? {}, this.#redact),
    });
  }

  async close() {
    for (const operation of this.#active) {
      operation.controller.abort(new Error('Claude worker closed'));
      try { operation.stream?.close?.(); } catch {}
    }
    await this.#closeHook?.();
  }
}

export function createClaudeWorker(options) {
  return new ClaudeWorker(options);
}

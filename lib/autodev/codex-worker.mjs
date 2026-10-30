import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { redact as defaultRedact } from '../config.mjs';

const SANDBOXES = new Set(['read-only', 'workspace-write']);
const APPROVALS = new Set(['never', 'on-request']);
const WRITE_POLICY = Object.freeze([
  'git',
  'rm',
  'find',
  'npm',
  'npx',
  'pnpm',
  'yarn',
  'bun',
  'curl',
  'wget',
  'ssh',
  'scp',
  'rsync',
  'kubectl',
  'terraform',
  'docker',
  'deploy',
  'sudo',
  'command',
  'env',
  'nohup',
  'sh',
  'bash',
  'zsh',
  'node',
  'python',
  'python3',
  'perl',
  'ruby',
  'php',
].map((command) => [command]));

function writePolicy() {
  return `${WRITE_POLICY.map((pattern) =>
    `prefix_rule(pattern=${JSON.stringify(pattern)}, decision="forbidden", justification="AutoDev host owns consequential repository and publication actions")`
  ).join('\n')}\n`;
}

export class CodexWorkerError extends Error {
  constructor(message, { code = 'CODEX_ERROR', cause, details } = {}) {
    super(message, { cause });
    this.name = this.constructor.name;
    this.code = code;
    if (details) this.details = details;
  }
}
export class CodexExecutableError extends CodexWorkerError {}
export class CodexTimeoutError extends CodexWorkerError {}
export class CodexAbortError extends CodexWorkerError {}
export class CodexOutputLimitError extends CodexWorkerError {}
export class CodexProtocolError extends CodexWorkerError {}
export class CodexExitError extends CodexWorkerError {}

function positive(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function secretRedactor(redact, key) {
  return (value) => {
    let text = redact(String(value));
    if (key) text = text.split(key).join('[REDACTED]');
    return text;
  };
}

export class CodexWorker {
  #executable;
  #spawn;
  #readFile;
  #writeFile;
  #unlink;
  #temporaryFile;
  #temporaryHome;
  #mkdir;
  #removeTree;
  #redact;
  #setTimeout;
  #clearTimeout;
  #env;
  #terminate;
  #terminationGraceMs;

  constructor({ executable, spawnImpl = spawn, readFile = (file) => readFileSync(file, 'utf8'),
    writeFile = writeFileSync, unlink = unlinkSync,
    temporaryFile = () => join(tmpdir(), `autodev-codex-${randomUUID()}.json`),
    temporaryHome = () => mkdtempSync(join(tmpdir(), 'autodev-codex-home-')),
    mkdir = (directory) => mkdirSync(directory, { recursive: true, mode: 0o700 }),
    removeTree = (directory) => rmSync(directory, { recursive: true, force: true }),
    redact = defaultRedact, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout,
    env = process.env, terminate = (child, signal = 'SIGTERM') => child?.kill?.(signal), terminationGraceMs = 1000 } = {}) {
    if (typeof executable !== 'string' || !isAbsolute(executable)) {
      throw new TypeError('an explicit absolute Codex executable is required');
    }
    positive(terminationGraceMs, 'terminationGraceMs');
    this.#executable = executable;
    this.#spawn = spawnImpl;
    this.#readFile = readFile;
    this.#writeFile = writeFile;
    this.#unlink = unlink;
    this.#temporaryFile = temporaryFile;
    this.#temporaryHome = temporaryHome;
    this.#mkdir = mkdir;
    this.#removeTree = removeTree;
    this.#redact = redact;
    this.#setTimeout = setTimeoutImpl;
    this.#clearTimeout = clearTimeoutImpl;
    this.#env = env;
    this.#terminate = terminate;
    this.#terminationGraceMs = terminationGraceMs;
  }

  run({ prompt, cwd, apiKey, schema, sandbox = 'workspace-write', approval = 'never',
    timeoutMs = 120000, maxOutputBytes = 4 * 1024 * 1024, signal, onEvent = () => {} } = {}) {
    if (typeof prompt !== 'string' || !prompt.trim()) throw new TypeError('Codex prompt is required');
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new TypeError('an absolute Codex working directory is required');
    if (typeof apiKey !== 'string' || !apiKey || /[\0\r\n]/.test(apiKey)) throw new TypeError('CODEX_API_KEY is required');
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new TypeError('output schema must be an object');
    if (!SANDBOXES.has(sandbox)) throw new TypeError('unsupported Codex sandbox');
    if (!APPROVALS.has(approval)) throw new TypeError('unsupported Codex approval policy');
    positive(timeoutMs, 'timeoutMs');
    positive(maxOutputBytes, 'maxOutputBytes');
    if (signal?.aborted) return Promise.reject(new CodexAbortError('Codex run aborted', { code: 'CODEX_ABORTED' }));

    const schemaFile = this.#temporaryFile('schema');
    const outputFile = this.#temporaryFile('output');
    let codexHome;
    try {
      this.#writeFile(schemaFile, JSON.stringify(schema), { mode: 0o600 });
      if (sandbox === 'workspace-write') {
        codexHome = this.#temporaryHome();
        const rules = join(codexHome, 'rules');
        this.#mkdir(rules);
        this.#writeFile(join(rules, 'autodev.rules'), writePolicy(), { mode: 0o600 });
      }
    } catch (cause) {
      for (const file of [schemaFile, outputFile]) {
        try { this.#unlink(file); } catch {}
      }
      if (codexHome) {
        try { this.#removeTree(codexHome); } catch {}
      }
      return Promise.reject(new CodexExecutableError(`unable to prepare Codex policy: ${cause.message}`, {
        code: 'CODEX_POLICY', cause,
      }));
    }
    const args = ['--ask-for-approval', approval, 'exec', '--ephemeral', '--ignore-user-config',
      '-c', 'shell_environment_policy.exclude=["CODEX_API_KEY"]', '--json', '--output-schema', schemaFile,
      '--output-last-message', outputFile, '-C', cwd, '--sandbox', sandbox, '-'];
    const safe = secretRedactor(this.#redact, apiKey);

    return new Promise((resolve, reject) => {
      let child;
      let timer;
      let bytes = 0;
      let stderr = '';
      let buffer = '';
      const eventErrors = [];
      let settled = false;
      let stopping = false;
      let stopError;
      let forceTimer;
      const cleanup = () => {
        this.#clearTimeout(timer);
        this.#clearTimeout(forceTimer);
        signal?.removeEventListener('abort', abort);
        for (const file of [schemaFile, outputFile]) {
          try { this.#unlink(file); } catch {}
        }
        if (codexHome) {
          try { this.#removeTree(codexHome); } catch {}
        }
      };
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error); else resolve(result);
      };
      const stop = (error) => {
        if (settled || stopping) return;
        stopping = true;
        stopError = error;
        try { this.#terminate(child, 'SIGTERM'); } catch {}
        forceTimer = this.#setTimeout(() => {
          if (settled) return;
          try { this.#terminate(child, 'SIGKILL'); } catch {}
        }, this.#terminationGraceMs);
      };
      const count = (chunk) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > maxOutputBytes) {
          stop(new CodexOutputLimitError(`Codex output exceeded ${maxOutputBytes} bytes`, { code: 'CODEX_OUTPUT_LIMIT' }));
          return false;
        }
        return true;
      };
      const emitLine = (line) => {
        if (!line.trim()) return true;
        let event;
        try { event = JSON.parse(line); }
        catch (cause) {
          stop(new CodexProtocolError(`invalid Codex JSONL: ${safe(line).slice(0, 500)}`, { code: 'CODEX_PROTOCOL', cause }));
          return false;
        }
        const sanitized = JSON.parse(
          safe(JSON.stringify(event))
        );
        if (
          sanitized?.type === 'error' ||
          sanitized?.type === 'turn.failed'
        ) {
          const detail =
            sanitized.message ||
            sanitized.error?.message ||
            JSON.stringify(sanitized);
          eventErrors.push(String(detail));
          if (eventErrors.length > 4) {
            eventErrors.shift();
          }
        }
        onEvent(sanitized);
        return true;
      };
      const consume = (chunk) => {
        const text = String(chunk);
        if (!count(text)) return;
        buffer += text;
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, '');
          buffer = buffer.slice(newline + 1);
          if (!emitLine(line)) return;
        }
      };
      const abort = () => stop(new CodexAbortError('Codex run aborted', { code: 'CODEX_ABORTED' }));

      try {
        child = this.#spawn(this.#executable, args, {
          cwd, shell: false, windowsHide: true,
          env: {
            ...this.#env,
            CODEX_API_KEY: apiKey,
            ...(codexHome ? { CODEX_HOME: codexHome } : {}),
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (cause) {
        finish(new CodexExecutableError(`unable to launch Codex: ${safe(cause.message)}`, { code: 'CODEX_EXECUTABLE', cause }));
        return;
      }
      signal?.addEventListener('abort', abort, { once: true });
      timer = this.#setTimeout(() => stop(new CodexTimeoutError(`Codex timed out after ${timeoutMs}ms`, { code: 'CODEX_TIMEOUT' })), timeoutMs);
      child.stdout?.on('data', consume);
      child.stderr?.on('data', (chunk) => {
        const text = String(chunk);
        if (!count(text)) return;
        stderr = (stderr + text).slice(-4000);
      });
      child.once('error', (cause) => {
        if (stopping) finish(stopError);
        else finish(new CodexExecutableError(`unable to launch Codex: ${safe(cause.message)}`, { code: 'CODEX_EXECUTABLE', cause }));
      });
      child.once('close', (code, closeSignal) => {
        if (settled) return;
        if (stopping) {
          finish(stopError);
          return;
        }
        if (buffer && !emitLine(buffer.replace(/\r$/, ''))) return;
        if (code !== 0) {
          const diagnostic = [
            safe(stderr).trim(),
            ...eventErrors.map((item) => safe(item)),
          ].filter(Boolean).join('\n').slice(-4000);
          finish(new CodexExitError(
            `Codex exited with ${closeSignal || code}: ${diagnostic}`,
            {
              code: 'CODEX_EXIT',
              details: {
                exitCode: code,
                signal: closeSignal,
              },
            },
          ));
          return;
        }
        try {
          const final = JSON.parse(safe(this.#readFile(outputFile)));
          finish(null, { final, outputBytes: bytes });
        } catch (cause) {
          finish(new CodexProtocolError(`invalid Codex final output: ${safe(cause.message)}`, { code: 'CODEX_PROTOCOL', cause }));
        }
      });
      child.stdin?.end(prompt);
    });
  }
}

export function createCodexWorker(options) {
  return new CodexWorker(options);
}

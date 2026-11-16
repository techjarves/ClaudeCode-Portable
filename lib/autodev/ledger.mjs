import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { redact as defaultRedact, writeJSON as defaultWriteJSON } from '../config.mjs';

export const LEDGER_VERSION = 1;
const ACTIVE = new Set(['queued', 'planning', 'running', 'reviewing', 'repairing', 'quality']);

function clone(value) {
  return structuredClone(value);
}

function redactValue(value, redact) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, redact));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item, redact)]));
  }
  return value;
}

function validId(id) {
  if (typeof id !== 'string' || !id.trim() || id.length > 200 || /[\0\r\n]/.test(id)) {
    throw new TypeError('run id must be a non-empty string');
  }
  return id;
}

export class LedgerVersionError extends Error {
  constructor(version) {
    super(`unsupported autodev ledger version: ${version}`);
    this.name = 'LedgerVersionError';
    this.version = version;
  }
}

export class AutodevLedger {
  #file;
  #writeJSON;
  #readJSON;
  #exists;
  #mkdir;
  #redact;
  #clock;
  #id;
  #queue = Promise.resolve();

  constructor(file, {
    writeJSON = defaultWriteJSON,
    readJSON = (target) => JSON.parse(readFileSync(target, 'utf8')),
    exists = existsSync,
    mkdir = (target) => mkdirSync(target, { recursive: true, mode: 0o700 }),
    redact = defaultRedact,
    clock = () => new Date().toISOString(),
    id = randomUUID,
  } = {}) {
    if (typeof file !== 'string' || !file) throw new TypeError('ledger file is required');
    this.#file = file;
    this.#writeJSON = writeJSON;
    this.#readJSON = readJSON;
    this.#exists = exists;
    this.#mkdir = mkdir;
    this.#redact = redact;
    this.#clock = clock;
    this.#id = id;
  }

  #empty() {
    return { version: LEDGER_VERSION, nextEvent: 1, runs: [] };
  }

  #read() {
    if (!this.#exists(this.#file)) return this.#empty();
    const ledger = this.#readJSON(this.#file);
    if (!ledger || ledger.version !== LEDGER_VERSION) throw new LedgerVersionError(ledger?.version);
    if (!Number.isSafeInteger(ledger.nextEvent) || ledger.nextEvent < 1 || !Array.isArray(ledger.runs)) {
      throw new Error('invalid autodev ledger');
    }
    return ledger;
  }

  #serialize(operation) {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async #save(ledger) {
    this.#mkdir(dirname(this.#file));
    await this.#writeJSON(this.#file, redactValue(ledger, this.#redact));
  }

  #event(ledger, run, type, detail = {}) {
    const event = {
      sequence: ledger.nextEvent++,
      at: this.#clock(),
      type,
      ...redactValue(detail, this.#redact),
    };
    run.events.push(event);
    run.updatedAt = event.at;
    return event;
  }

  create(input = {}) {
    return this.#serialize(async () => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('run must be an object');
      const ledger = this.#read();
      const id = validId(input.id ?? this.#id());
      if (ledger.runs.some((run) => run.id === id)) throw new Error(`run already exists: ${id}`);
      const at = this.#clock();
      const { events, createdAt, updatedAt, ...safe } = redactValue(input, this.#redact);
      const run = { ...safe, id, status: input.status ?? 'queued', createdAt: at, updatedAt: at, events: [] };
      this.#event(ledger, run, 'created', { status: run.status });
      ledger.runs.push(run);
      await this.#save(ledger);
      return clone(run);
    });
  }

  list() {
    return this.#serialize(() => clone(this.#read().runs));
  }

  get(id) {
    return this.#serialize(() => {
      const run = this.#read().runs.find((item) => item.id === id);
      return run ? clone(run) : null;
    });
  }

  update(id, patch = {}, eventType = 'updated') {
    return this.mutate(id, () => patch, eventType);
  }

  mutate(id, updater, eventType = 'updated') {
    return this.#serialize(async () => {
      if (typeof updater !== 'function') throw new TypeError('updater must be a function');
      const ledger = this.#read();
      const run = ledger.runs.find((item) => item.id === id);
      if (!run) throw new Error(`unknown run: ${id}`);
      const patch = await updater(clone(run));
      if (patch == null) return clone(run);
      if (typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('patch must be an object');
      const { id: ignoredId, events, createdAt, updatedAt, ...safe } = redactValue(patch, this.#redact);
      Object.assign(run, safe);
      this.#event(ledger, run, eventType, { changes: safe });
      await this.#save(ledger);
      return clone(run);
    });
  }

  recover() {
    return this.#serialize(async () => {
      const ledger = this.#read();
      const recovered = [];
      for (const run of ledger.runs) {
        if (!ACTIVE.has(run.status)) continue;
        const previousStatus = run.status;
        run.status = 'interrupted';
        this.#event(ledger, run, 'recovered', { previousStatus });
        recovered.push(clone(run));
      }
      if (recovered.length) await this.#save(ledger);
      return recovered;
    });
  }
}

export function createLedger(file, options) {
  return new AutodevLedger(file, options);
}

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { writeJSON as defaultWriteJSON } from '../config.mjs';
import { createLedger } from './ledger.mjs';
import { createAutoDevRuntime, validateRepository } from './runtime.mjs';

const REGISTRY_VERSION = 1;
const DEFAULT_LIST_LIMIT = 100;

function clone(value) { return structuredClone(value); }

function pageOptions(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('list options must be an object');
  const limit = options.limit ?? DEFAULT_LIST_LIMIT;
  const offset = options.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TypeError('list limit must be an integer from 1 to 1000');
  if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError('list offset must be a non-negative integer');
  return { limit, offset };
}

function keyFor(repo) {
  return createHash('sha256').update(repo).digest('hex').slice(0, 24);
}

export class AutoDevRegistry {
  #root;
  #indexFile;
  #ledgerRoot;
  #legacyLedger;
  #runtimeFactory;
  #repositoryValidator;
  #git;
  #writeJSON;
  #readJSON;
  #exists;
  #mkdir;
  #ledgerOptions;
  #targets = new Map();
  #managers = new Map();
  #opening = new Map();
  #closed = false;
  #saveQueue = Promise.resolve();
  #recovery;

  constructor({
    root,
    indexFile,
    ledgerRoot,
    legacyLedger,
    runtimeFactory = createAutoDevRuntime,
    repositoryValidator = validateRepository,
    git,
    writeJSON = defaultWriteJSON,
    readJSON = (file) => JSON.parse(readFileSync(file, 'utf8')),
    exists = existsSync,
    mkdir = (directory) => mkdirSync(directory, { recursive: true, mode: 0o700 }),
    ledgerOptions,
  } = {}) {
    if (typeof root !== 'string' || !root) throw new TypeError('registry root repository is required');
    if (typeof indexFile !== 'string' || !indexFile) throw new TypeError('registry index file is required');
    if (typeof ledgerRoot !== 'string' || !ledgerRoot) throw new TypeError('registry ledger root is required');
    this.#root = resolve(root);
    this.#indexFile = indexFile;
    this.#ledgerRoot = ledgerRoot;
    this.#legacyLedger = legacyLedger;
    this.#runtimeFactory = runtimeFactory;
    this.#repositoryValidator = repositoryValidator;
    this.#git = git;
    this.#writeJSON = writeJSON;
    this.#readJSON = readJSON;
    this.#exists = exists;
    this.#mkdir = mkdir;
    this.#ledgerOptions = ledgerOptions;
    this.#load();
    this.#targets.set(this.#root, this.#record(this.#root));
    this.#recovery = this.#recoverLedgers();
  }

  async #recoverLedgers() {
    for (const record of this.#targets.values()) {
      await this.#ledger(record).recover();
    }
  }

  async ready() {
    this.#assertOpen();
    await this.#recovery;
    this.#assertOpen();
    return this;
  }

  #assertOpen() {
    if (this.#closed) throw new Error('AutoDev registry is closed');
  }

  #record(repo) {
    const key = keyFor(repo);
    return {
      repo,
      key,
      ledgerFile: repo === this.#root && this.#legacyLedger
        ? this.#legacyLedger
        : join(this.#ledgerRoot, `${key}.json`),
    };
  }

  #load() {
    if (!this.#exists(this.#indexFile)) return;
    const value = this.#readJSON(this.#indexFile);
    if (!value || value.version !== REGISTRY_VERSION || !Array.isArray(value.targets)) {
      throw new Error('invalid AutoDev repository registry');
    }
    for (const target of value.targets) {
      if (!target || typeof target.repo !== 'string' || typeof target.key !== 'string') {
        throw new Error('invalid AutoDev repository registry target');
      }
      const repo = resolve(target.repo);
      if (target.key !== keyFor(repo)) throw new Error('invalid AutoDev repository registry key');
      this.#targets.set(repo, this.#record(repo));
    }
  }

  #save() {
    const value = {
      version: REGISTRY_VERSION,
      targets: [...this.#targets.values()]
        .map(({ repo, key }) => ({ repo, key }))
        .sort((left, right) => left.repo.localeCompare(right.repo)),
    };
    const operation = this.#saveQueue.then(async () => {
      await this.#mkdir(dirname(this.#indexFile));
      return this.#writeJSON(this.#indexFile, value);
    });
    this.#saveQueue = operation.catch(() => {});
    return operation;
  }

  async #canonical(repo) {
    const value = await this.#repositoryValidator(repo, this.#git ? { git: this.#git } : undefined);
    return resolve(value);
  }

  #ledger(record) {
    return createLedger(record.ledgerFile, this.#ledgerOptions);
  }

  async #manager(repo) {
    this.#assertOpen();
    await this.#recovery;
    this.#assertOpen();
    const canonical = await this.#canonical(repo);
    this.#assertOpen();
    if (this.#managers.has(canonical)) return this.#managers.get(canonical);
    if (this.#opening.has(canonical)) return this.#opening.get(canonical);
    const record = this.#record(canonical);
    const opening = Promise.resolve(this.#runtimeFactory({ repo: canonical, ledgerFile: record.ledgerFile }))
      .then(async (manager) => {
        if (!manager || typeof manager.create !== 'function') {
          await Promise.resolve(manager?.close?.()).catch(() => {});
          throw new Error('AutoDev runtime did not return a manager');
        }
        if (this.#closed) {
          await Promise.resolve(manager.close?.()).catch(() => {});
          throw new Error('AutoDev registry is closed');
        }
        this.#targets.set(canonical, record);
        try {
          await this.#save();
          if (this.#closed) throw new Error('AutoDev registry is closed');
        } catch (error) {
          this.#targets.delete(canonical);
          await Promise.resolve(manager.close?.()).catch(() => {});
          throw error;
        }
        this.#managers.set(canonical, manager);
        return manager;
      })
      .finally(() => this.#opening.delete(canonical));
    this.#opening.set(canonical, opening);
    return opening;
  }

  async #locate(id) {
    await this.#recovery;
    for (const record of this.#targets.values()) {
      const run = await this.#ledger(record).get(id);
      if (run) return { record, run };
    }
    throw Object.assign(new Error(`unknown run: ${id}`), { status: 404 });
  }

  async list(options = {}) {
    this.#assertOpen();
    await this.#recovery;
    this.#assertOpen();
    const { limit, offset } = pageOptions(options);
    const runs = [];
    for (const record of this.#targets.values()) {
      const manager = this.#managers.get(record.repo);
      runs.push(...(manager ? await manager.list() : await this.#ledger(record).list()));
    }
    return runs
      .sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')))
      .slice(offset, offset + limit);
  }

  async create(input = {}) {
    this.#assertOpen();
    const target = input.target ?? this.#root;
    const manager = await this.#manager(target);
    return manager.create({ ...clone(input), target: await this.#canonical(target) });
  }

  async start(id) {
    const { record } = await this.#locate(id);
    return (await this.#manager(record.repo)).start(id);
  }

  async status(id) {
    const { record, run } = await this.#locate(id);
    const manager = this.#managers.get(record.repo);
    return manager ? manager.status(id) : run;
  }

  async events(id, options) {
    const { record } = await this.#locate(id);
    return (await this.#manager(record.repo)).events(id, options);
  }

  async approve(id, approvalId, decision, detail) {
    const { record } = await this.#locate(id);
    return (await this.#manager(record.repo)).approve(id, approvalId, decision, detail);
  }

  async cancel(id, reason) {
    const { record } = await this.#locate(id);
    return (await this.#manager(record.repo)).cancel(id, reason);
  }

  async resume(id) {
    const { record } = await this.#locate(id);
    return (await this.#manager(record.repo)).resume(id);
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    const pending = await Promise.allSettled(this.#opening.values());
    const managers = new Set(this.#managers.values());
    for (const result of pending) if (result.status === 'fulfilled') managers.add(result.value);
    await Promise.all([...managers].map((manager) => Promise.resolve(manager.close?.()).catch(() => {})));
  }
}

export async function createAutoDevRegistry(options) {
  const registry = new AutoDevRegistry(options);
  try {
    return await registry.ready();
  } catch (error) {
    await registry.close().catch(() => {});
    throw error;
  }
}

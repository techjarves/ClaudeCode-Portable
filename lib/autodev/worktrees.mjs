import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { writeJSON as defaultWriteJSON } from '../config.mjs';

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FORBIDDEN = new Set(['reset', 'clean']);

function inside(parent, child) {
  const value = relative(resolve(parent), resolve(child));
  return value && !value.startsWith('..') && !value.includes(`..${process.platform === 'win32' ? '\\' : '/'}`) && !value.startsWith('/');
}

function validateGitArgs(args) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string' || /[\0\r\n]/.test(arg))) {
    throw new TypeError('git arguments must be safe strings');
  }
  if (FORBIDDEN.has(args[0]) || args.includes('--force') || args.includes('-f')) {
    throw new Error('destructive Git operation is not allowed');
  }
}

export function runGit(args, { cwd, spawnImpl = spawn, signal } = {}) {
  validateGitArgs(args);
  return new Promise((resolvePromise, reject) => {
    const child = spawnImpl('git', args, { cwd, signal, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout?.on('data', (chunk) => { output += chunk; });
    child.stderr?.on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('close', (code, closeSignal) => {
      if (code === 0) resolvePromise(output.trimEnd());
      else reject(new Error(`git ${args[0]} failed (${closeSignal || code}): ${output.trim().slice(-1500)}`));
    });
  });
}

export class OwnedWorktrees {
  #repo;
  #root;
  #git;
  #writeJSON;
  #readJSON;
  #mkdir;
  #unlink;
  #exists;

  constructor({ repo, root, git = runGit, writeJSON = defaultWriteJSON,
    readJSON = (file) => JSON.parse(readFileSync(file, 'utf8')),
    mkdir = (directory) => mkdirSync(directory, { recursive: true, mode: 0o700 }),
    unlink = unlinkSync, exists = existsSync } = {}) {
    if (!repo || !root) throw new TypeError('repo and worktree root are required');
    this.#repo = resolve(repo);
    this.#root = resolve(root);
    if (this.#root === this.#repo || inside(this.#repo, this.#root)) {
      throw new Error('owned worktrees must live outside the source repository');
    }
    this.#git = git;
    this.#writeJSON = writeJSON;
    this.#readJSON = readJSON;
    this.#mkdir = mkdir;
    this.#unlink = unlink;
    this.#exists = exists;
  }

  #paths(name) {
    if (!SAFE_NAME.test(name)) throw new TypeError('invalid worktree name');
    return {
      target: resolve(this.#root, name),
      owner: resolve(this.#root, '.owners', `${name}.json`),
    };
  }

  async create({ name, runId, taskId, base = 'HEAD' }) {
    if (typeof runId !== 'string' || !runId || typeof taskId !== 'string' || !taskId) {
      throw new TypeError('runId and taskId are required');
    }
    if (typeof base !== 'string' || !base || base.startsWith('-') || /[\0\r\n]/.test(base)) throw new TypeError('invalid base ref');
    const { target, owner } = this.#paths(name);
    const branch = `autodev/${name}`;
    if (this.#exists(owner)) {
      const existing = this.get(name);
      if (existing.runId !== runId || existing.taskId !== taskId || existing.path !== target || existing.branch !== branch) {
        throw new Error(`worktree ownership does not match requested package: ${name}`);
      }
      const registered = await this.#git(['worktree', 'list', '--porcelain'], { cwd: this.#repo });
      if (!registered.split(/\r?\n/).includes(`worktree ${target}`)) {
        throw new Error(`owned worktree is not registered: ${name}`);
      }
      const currentBranch = await this.#git(['branch', '--show-current'], { cwd: target });
      if (currentBranch !== branch) throw new Error(`owned worktree branch changed: ${name}`);
      return existing;
    }
    if (this.#exists(target)) throw new Error(`unowned worktree path already exists: ${name}`);
    this.#mkdir(dirname(owner));
    await this.#git(['worktree', 'add', '-b', branch, target, base], { cwd: this.#repo });
    const record = { version: 1, name, runId, taskId, repo: this.#repo, path: target, branch };
    try {
      await this.#writeJSON(owner, record);
    } catch (error) {
      try {
        await this.#git(['worktree', 'remove', target], { cwd: this.#repo });
        await this.#git(['branch', '-d', branch], { cwd: this.#repo });
      } catch {}
      throw error;
    }
    return structuredClone(record);
  }

  get(name) {
    const { owner } = this.#paths(name);
    const record = this.#readJSON(owner);
    if (record?.version !== 1 || record.name !== name || record.repo !== this.#repo || basename(record.path) !== name) {
      throw new Error(`worktree ownership record is invalid: ${name}`);
    }
    return structuredClone(record);
  }

  async status(name) {
    const record = this.get(name);
    return this.#git(['status', '--porcelain=v1', '-z'], { cwd: record.path });
  }

  async commit(name, { paths, message }) {
    const record = this.get(name);
    if (!Array.isArray(paths) || !paths.length || typeof message !== 'string' || !message.trim()) {
      throw new TypeError('explicit paths and commit message are required');
    }
    const safePaths = paths.map((item) => {
      if (typeof item !== 'string' || !item || item.startsWith('-') || resolve(record.path, item) === record.path || !inside(record.path, resolve(record.path, item))) {
        throw new TypeError(`unsafe commit path: ${item}`);
      }
      return item;
    });
    await this.#git(['restore', '--staged', '--', '.'], { cwd: record.path });
    await this.#git(['add', '--', ...safePaths], { cwd: record.path });
    const staged = await this.#git(['diff', '--cached', '--name-only', '-z'], { cwd: record.path });
    const stagedPaths = staged.split('\0').filter(Boolean);
    if (stagedPaths.some((item) => !safePaths.includes(item))) {
      throw new Error('staged changes include paths outside the explicit commit scope');
    }
    await this.#git(['commit', '-m', message], { cwd: record.path });
    return this.#git(['rev-parse', 'HEAD'], { cwd: record.path });
  }

  async integrate(name, { expectedHead } = {}) {
    const record = this.get(name);
    if (typeof expectedHead !== 'string' || !/^[0-9a-f]{40,64}$/i.test(expectedHead)) throw new TypeError('expected destination commit is required');
    const [head, dirty] = await Promise.all([
      this.#git(['rev-parse', 'HEAD'], { cwd: this.#repo }),
      this.#git(['status', '--porcelain'], { cwd: this.#repo }),
    ]);
    if (head !== expectedHead) throw new Error(`integration destination moved from ${expectedHead} to ${head}`);
    if (dirty) throw new Error('integration destination has uncommitted changes');
    return this.#git(['merge', '--no-ff', '--no-edit', record.branch], { cwd: this.#repo });
  }

  async remove(name) {
    const record = this.get(name);
    const dirty = await this.#git(['status', '--porcelain'], { cwd: record.path });
    if (dirty) throw new Error(`owned worktree has uncommitted changes: ${name}`);
    await this.#git(['worktree', 'remove', record.path], { cwd: this.#repo });
    await this.#git(['branch', '-d', record.branch], { cwd: this.#repo });
    this.#unlink(this.#paths(name).owner);
  }
}

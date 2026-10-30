import path from 'node:path';

function taskId(task) {
  if (!task || typeof task.id !== 'string' || !task.id.trim()) {
    throw new TypeError('every task requires a non-empty string id');
  }
  return task.id;
}

function dependencies(task) {
  const value = task.dependsOn ?? [];
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !id)) {
    throw new TypeError(`task ${task.id} dependsOn must be an array of ids`);
  }
  return [...new Set(value)];
}

export function normalizeTaskPath(value) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('task paths must be non-empty strings');
  const portable = value.replaceAll('\\', '/');
  if (portable.startsWith('/') || /^[a-z]:\//i.test(portable)) throw new TypeError(`task path must be relative: ${value}`);
  const normalized = path.posix.normalize(portable).replace(/^\.\//, '').replace(/\/$/, '');
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new TypeError(`task path escapes the workspace: ${value}`);
  }
  return normalized;
}

export function pathsOverlap(left, right) {
  const a = normalizeTaskPath(left).toLowerCase();
  const b = normalizeTaskPath(right).toLowerCase();
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function taskPathsOverlap(left, right) {
  const a = left.paths ?? [];
  const b = right.paths ?? [];
  if (!Array.isArray(a) || !Array.isArray(b)) throw new TypeError('task paths must be arrays');
  return a.some((first) => b.some((second) => pathsOverlap(first, second)));
}

export function validateDag(tasks) {
  if (!Array.isArray(tasks)) throw new TypeError('tasks must be an array');
  const byId = new Map();
  for (const task of tasks) {
    const id = taskId(task);
    if (byId.has(id)) throw new TypeError(`duplicate task id: ${id}`);
    const paths = task.paths ?? [];
    if (!Array.isArray(paths)) throw new TypeError(`task ${id} paths must be an array`);
    byId.set(id, { ...task, id, dependsOn: dependencies(task), paths: paths.map(normalizeTaskPath) });
  }
  for (const task of byId.values()) {
    for (const dependency of task.dependsOn) {
      if (!byId.has(dependency)) throw new TypeError(`task ${task.id} depends on missing task ${dependency}`);
      if (dependency === task.id) throw new TypeError(`task ${task.id} depends on itself`);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (id, trail) => {
    if (visiting.has(id)) throw new TypeError(`task dependency cycle: ${[...trail, id].join(' -> ')}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id).dependsOn) visit(dependency, [...trail, id]);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of byId.keys()) visit(id, []);
  return [...byId.values()];
}

export function createSchedule(tasks, { concurrency = 3 } = {}) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new TypeError('concurrency must be a positive integer');
  const normalized = validateDag(tasks);
  const remaining = new Map(normalized.map((task) => [task.id, task]));
  const complete = new Set();
  const waves = [];
  while (remaining.size) {
    const ready = [...remaining.values()].filter((task) => task.dependsOn.every((id) => complete.has(id)));
    const wave = [];
    for (const task of ready) {
      if (wave.length >= concurrency) break;
      if (wave.every((selected) => !taskPathsOverlap(task, selected))) wave.push(task);
    }
    if (!wave.length) throw new Error('unable to schedule task DAG');
    waves.push(wave);
    for (const task of wave) {
      remaining.delete(task.id);
      complete.add(task.id);
    }
  }
  return waves;
}

export async function runDag(tasks, worker, options = {}) {
  if (typeof worker !== 'function') throw new TypeError('worker must be a function');
  const results = new Map();
  for (const wave of createSchedule(tasks, options)) {
    const settled = await Promise.all(wave.map(async (task) => [task.id, await worker(task, results)]));
    for (const [id, result] of settled) results.set(id, result);
  }
  return results;
}

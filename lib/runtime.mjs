import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, realpathSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { ROOT, DATA, PLATFORM, RUNTIME, LOGS } from './paths.mjs';

export const manifest = JSON.parse(readFileSync(join(ROOT, 'tools/runtime-manifest.json'), 'utf8'));
export function executableAt(directory = RUNTIME) {
  const pkgPath = join(directory, 'node_modules/@anthropic-ai/claude-code/package.json');
  if (!existsSync(pkgPath)) return null;
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.claude;
  if (!bin) return null;
  const result = join(dirname(pkgPath), bin);
  return existsSync(result) ? result : null;
}
export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore','pipe','pipe'], ...options }); let output = '';
    child.stdout?.on('data', c => { output += c; options.onOutput?.(c.toString()); });
    child.stderr?.on('data', c => { output += c; options.onOutput?.(c.toString()); });
    child.on('error', reject);
    child.on('exit', (code, signal) => code === 0 ? resolve(output.trim()) : reject(new Error(`${command.split(/[\\/]/).pop()} exited ${code ?? signal}: ${output.slice(-1500)}`)));
  });
}
function npmCLI() {
  const base = dirname(process.execPath);
  const candidates = [join(base, 'node_modules/npm/bin/npm-cli.js'), join(base, '../lib/node_modules/npm/bin/npm-cli.js')];
  try { candidates.push(realpathSync(join(base, 'npm'))); } catch {}
  const found = candidates.find(existsSync);
  if (!found) throw new Error('Bundled npm is missing. Run start.sh or START.bat to repair Node.js.');
  return found;
}
export async function runtimeStatus() {
  const executable = executableAt();
  let version = null;
  if (executable) try { version = await run(executable, ['--version'], { timeout: 15000 }); } catch {}
  return { installed: !!version, version, platform: PLATFORM, node: process.version, pinned: manifest.dependencies['@anthropic-ai/claude-code'], sdk: manifest.dependencies['@anthropic-ai/claude-agent-sdk'], executable };
}
export async function installRuntime({ onOutput = () => {}, target = RUNTIME, runner = run } = {}) {
  const base = dirname(target); const staging = join(base, 'staging'); const backup = join(base, 'previous'); const lock = join(base, 'install.lock');
  mkdirSync(base, { recursive: true }); mkdirSync(LOGS, { recursive: true }); mkdirSync(join(DATA, 'npm-cache'), { recursive: true });
  try { mkdirSync(lock); } catch { throw new Error('An installation is already running. If it was interrupted, remove engine/<platform>/install.lock after checking no installer is active.'); }
  try {
    rmSync(staging, { recursive: true, force: true }); mkdirSync(staging);
    writeFileSync(join(staging, 'package.json'), JSON.stringify(manifest, null, 2));
    const log = join(LOGS, 'runtime-install.log'); writeFileSync(log, '', { mode: 0o600 });
    const { appendFileSync } = await import('node:fs');
    onOutput('Installing pinned official Claude Code and dashboard dependencies…\n');
    await runner(process.execPath, [npmCLI(), 'install', '--prefix', staging, '--include=optional', '--no-audit', '--no-fund', '--save=false', '--no-bin-links', '--cache', join(DATA, 'npm-cache')], { cwd: staging, env: { ...process.env, npm_config_cache: join(DATA, 'npm-cache') }, onOutput: s => { appendFileSync(log, s); onOutput(s); } });
    const exe = executableAt(staging);
    if (!exe) throw new Error('The official executable was not installed; existing runtime was preserved');
    const version = await runner(exe, ['--version'], { timeout: 15000 });
    if (!version.includes('Claude Code')) throw new Error('Runtime identity check failed');
    rmSync(backup, { recursive: true, force: true });
    if (existsSync(target)) renameSync(target, backup);
    try { renameSync(staging, target); } catch (e) { if (existsSync(backup)) renameSync(backup, target); throw e; }
    onOutput(`Ready: ${version}\n`);
    return version;
  } finally { rmSync(staging, { recursive: true, force: true }); rmSync(lock, { recursive: true, force: true }); }
}
export async function rollbackRuntime({target=RUNTIME,runner=run}={}) {
  const base = dirname(target), backup = join(base, 'previous'), swap = join(base, 'rollback-swap');
  if (existsSync(join(base, 'install.lock'))) throw new Error('Installation is in progress');
  const exe = executableAt(backup);
  if (!exe) throw new Error('No previous installation is available');
  await runner(exe, ['--version'], { timeout: 15000 });
  renameSync(target, swap);
  try { renameSync(backup, target); } catch (e) { renameSync(swap, target); throw e; }
  renameSync(swap, backup);
}
export async function loadSDK() {
  const require = createRequire(join(RUNTIME, 'package.json'));
  return import(pathToFileURL(require.resolve('@anthropic-ai/claude-agent-sdk')).href);
}
export function listLogs() {
  mkdirSync(LOGS, { recursive: true });
  return readdirSync(LOGS).filter(n => /^[\w.-]+\.log$/.test(n));
}

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync, rmSync, realpathSync, readdirSync, copyFileSync, statSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { ROOT, DATA, PLATFORM, RUNTIME, LOGS } from './paths.mjs';

export const manifest = JSON.parse(readFileSync(join(ROOT, 'tools/runtime-manifest.json'), 'utf8'));
// The published @anthropic-ai/claude-code wrapper ships bin/claude.exe as a
// ~500-byte stub until its postinstall copies the ~250MB platform-native
// binary over it. The postinstall prefers a filesystem hardlink, which
// removable drives (FAT32/exFAT pen drives) do not support, so a Windows USB
// install can silently be left with the stub. These helpers detect that state
// and repair it with a plain copy, which works on every filesystem.
const STUB_MARKER = 'claude native binary not installed';
function nativeBinaryName() {
  return process.platform === 'win32' ? 'claude.exe' : 'claude';
}
export function isStubExecutable(executable) {
  try {
    if (statSync(executable).size >= 4096) return false;
    return readFileSync(executable, 'utf8').includes(STUB_MARKER);
  } catch {
    return false;
  }
}
export function nativeBinarySource(directory = RUNTIME) {
  const candidate = join(directory, `node_modules/@anthropic-ai/claude-code-${PLATFORM}`, nativeBinaryName());
  return existsSync(candidate) ? candidate : null;
}
function wrapperExecutableAt(directory = RUNTIME) {
  const pkgPath = join(directory, 'node_modules/@anthropic-ai/claude-code/package.json');
  if (!existsSync(pkgPath)) return null;
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.claude;
  if (!bin) return null;
  const result = join(dirname(pkgPath), bin);
  return existsSync(result) ? result : null;
}
export function repairNativeBinary(directory = RUNTIME) {
  const executable = wrapperExecutableAt(directory);
  if (!executable || !isStubExecutable(executable)) return false;
  const source = nativeBinarySource(directory);
  if (!source) return false;
  copyFileSync(source, executable);
  if (process.platform !== 'win32') chmodSync(executable, 0o755);
  return !isStubExecutable(executable);
}
export function executableAt(directory = RUNTIME) {
  // Prefer the platform package itself. The generic wrapper is always named
  // claude.exe, including on macOS/Linux, and the Agent SDK may consequently
  // try to run a native Mach-O/ELF binary through Node instead of spawning it.
  // Using the platform-native path also avoids link/copy quirks on FAT/exFAT.
  return nativeBinarySource(directory) || wrapperExecutableAt(directory);
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
  const stub = !!executable && isStubExecutable(executable);
  let version = null;
  if (executable && !stub) try { version = await run(executable, ['--version'], { timeout: 15000 }); } catch {}
  return { installed: !!version, version, platform: PLATFORM, node: process.version, pinned: manifest.dependencies['@anthropic-ai/claude-code'], sdk: manifest.dependencies['@anthropic-ai/claude-agent-sdk'], executable, stub };
}
export function stagingComplete(directory) {
  return Object.keys(manifest.dependencies).every(dep => existsSync(join(directory, 'node_modules', dep, 'package.json')));
}
export async function installRuntime({ onOutput = () => {}, target = RUNTIME, runner = run } = {}) {
  const base = dirname(target); const staging = join(base, 'staging'); const backup = join(base, 'previous'); const lock = join(base, 'install.lock');
  mkdirSync(base, { recursive: true }); mkdirSync(LOGS, { recursive: true }); mkdirSync(join(DATA, 'npm-cache'), { recursive: true });
  try { mkdirSync(lock); } catch { throw new Error('An installation is already running. If it was interrupted, remove engine/<platform>/install.lock after checking no installer is active.'); }
  const log = join(LOGS, 'runtime-install.log');
  try {
    const resuming = existsSync(staging);
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, 'package.json'), JSON.stringify(manifest, null, 2));
    appendFileSync(log, `\n=== Runtime installation ${new Date().toISOString()} ===\n`, { mode: 0o600 });
    onOutput('Installing pinned official Claude Code and dashboard dependencies...\n');
    if (resuming) onOutput('Resuming the previous incomplete installation; verified files will be reused.\n');
    onOutput('This step downloads ~300MB and can take several minutes on USB or network drives. Please wait.\n');
    const started = Date.now();
    const heartbeat = setInterval(() => {
      onOutput(`Still installing... ${Math.round((Date.now() - started) / 1000)}s elapsed. Do not close this window.\n`);
    }, 20000);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();
    try {
      await runner(process.execPath, [npmCLI(), 'install', '--prefix', staging, '--include=optional', '--no-audit', '--no-fund', '--save=false', '--no-bin-links', '--no-install-links', '--cache', join(DATA, 'npm-cache')], { cwd: staging, env: { ...process.env, npm_config_cache: join(DATA, 'npm-cache') }, onOutput: s => { appendFileSync(log, s); onOutput(s); } });
    } finally {
      clearInterval(heartbeat);
    }
    const wrapper = wrapperExecutableAt(staging);
    let exe = executableAt(staging);
    if (!exe) throw new Error('The official executable was not installed; existing runtime was preserved');
    if (wrapper && isStubExecutable(wrapper)) {
      onOutput('Native binary is still a placeholder (common on FAT32/exFAT pen drives, which block hardlinks). Copying it into place - the ~250MB file can take a few minutes on USB 2.0...\n');
      if (!repairNativeBinary(staging)) throw new Error('The native Claude binary is missing its platform package. Check disk space, then run the repair option again.');
      exe = executableAt(staging);
      onOutput('Native binary copy complete.\n');
    }
    if (!stagingComplete(staging)) throw new Error('Runtime dependencies are incomplete; existing runtime was preserved');
    const version = await runner(exe, ['--version'], { timeout: 15000 });
    if (!version.includes('Claude Code')) throw new Error('Runtime identity check failed');
    rmSync(backup, { recursive: true, force: true });
    if (existsSync(target)) renameSync(target, backup);
    try { renameSync(staging, target); } catch (e) { if (existsSync(backup)) renameSync(backup, target); throw e; }
    onOutput(`Ready: ${version}\n`);
    return version;
  } catch (error) {
    const detail=error?.stack||error?.message||String(error);
    try { appendFileSync(log, `\nINSTALL FAILED\n${detail}\n`); } catch {}
    throw new Error(`${error.message}\nIncomplete installation files were preserved for the next attempt. Details: ${log}`, { cause:error });
  } finally { rmSync(lock, { recursive: true, force: true }); }
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

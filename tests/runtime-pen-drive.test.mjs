import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Simulates a removable-drive install: the wrapper postinstall leaves the
// ~500-byte stub because FAT32/exFAT pen drives reject its hardlink step.
const temp = mkdtempSync(join(tmpdir(), 'portable-pen-drive-'));
process.env.PORTABLE_AI_DATA_DIR = join(temp, 'data');
const { installRuntime, isStubExecutable, repairNativeBinary, executableAt, manifest } = await import('../lib/runtime.mjs');
const { PLATFORM } = await import('../lib/paths.mjs');
test.after(() => rmSync(temp, { recursive: true, force: true }));

const STUB = 'echo "Error: claude native binary not installed." >&2\nexit 1\n';
function writeWrapper(dir, { stub = true, native = true } = {}) {
  const binDir = join(dir, 'node_modules/@anthropic-ai/claude-code/bin');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(dir, 'node_modules/@anthropic-ai/claude-code/package.json'), JSON.stringify({ bin: { claude: 'bin/claude.exe' } }));
  writeFileSync(join(binDir, 'claude.exe'), stub ? STUB : 'REAL-BINARY');
  for (const dep of Object.keys(manifest.dependencies)) {
    if (dep === '@anthropic-ai/claude-code') continue;
    mkdirSync(join(dir, 'node_modules', dep), { recursive: true });
    writeFileSync(join(dir, 'node_modules', dep, 'package.json'), JSON.stringify({ name: dep }));
  }
  if (native) {
    const nativeFile = process.platform === 'win32' ? 'claude.exe' : 'claude';
    const nativeDir = join(dir, `node_modules/@anthropic-ai/claude-code-${PLATFORM}`);
    mkdirSync(nativeDir, { recursive: true });
    writeFileSync(join(nativeDir, 'package.json'), JSON.stringify({ name: `@anthropic-ai/claude-code-${PLATFORM}` }));
    writeFileSync(join(nativeDir, nativeFile), 'REAL-BINARY');
  }
}
function stubInstaller(options, seen = {}) {
  return async (cmd, args, runOptions) => {
    if (args[0] === '--version') {
      assert.equal(readFileSync(cmd, 'utf8'), 'REAL-BINARY', 'version check must run against the repaired binary');
      return '2.1.247 (Claude Code)';
    }
    seen.args = args;
    writeWrapper(runOptions.cwd, options);
    if (options.failInstall) throw new Error('simulated postinstall failure on exFAT');
    return '';
  };
}

test('stub executables are detected and repaired with a plain copy', () => {
  const dir = join(temp, 'repair/current');
  writeWrapper(dir, { stub: true, native: true });
  const exe = executableAt(dir);
  assert.ok(exe);
  assert.equal(isStubExecutable(exe), true);
  assert.equal(repairNativeBinary(dir), true);
  assert.equal(readFileSync(exe, 'utf8'), 'REAL-BINARY');
  assert.equal(isStubExecutable(exe), false);
  assert.equal(repairNativeBinary(dir), false, 'a healthy binary needs no repair');
});

test('pen-drive install replaces the leftover stub before verifying', async () => {
  const target = join(temp, 'pen/current');
  const notes = [];
  const seen = {};
  await installRuntime({ target, runner: stubInstaller({ stub: true, native: true }, seen), onOutput: s => notes.push(s) });
  assert.equal(readFileSync(executableAt(target), 'utf8'), 'REAL-BINARY');
  assert.match(notes.join(''), /pen drives/i);
  assert.ok(seen.args.includes('--no-bin-links'), 'link-free install flags are passed');
  assert.ok(seen.args.includes('--no-install-links'), 'directory specs must extract, never link');
});

test('pen-drive install without the native package fails with a clear error', async () => {
  const target = join(temp, 'broken/current');
  await assert.rejects(
    installRuntime({ target, runner: stubInstaller({ stub: true, native: false }) }),
    /native Claude binary is missing/
  );
});

test('pen-drive install never accepts an npm error as a complete runtime', async () => {
  const target = join(temp, 'exfat/current');
  writeWrapper(target, { stub: false, native: true });
  await assert.rejects(
    installRuntime({ target, runner: stubInstaller({ stub: true, native: true, failInstall: true }) }),
    /simulated postinstall failure/
  );
  assert.equal(readFileSync(executableAt(target), 'utf8'), 'REAL-BINARY', 'the existing runtime must remain active');
});

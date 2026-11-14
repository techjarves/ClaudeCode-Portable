import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temp = mkdtempSync(join(tmpdir(), 'portable-permissions-tests-'));
process.env.PORTABLE_AI_DATA_DIR = join(temp, 'data');
const { readConfig } = await import('../lib/config.mjs');
const { bypassPermissionsEnabled, setBypassPermissions, resolvePermissionFlags, hasExplicitBypass, defaultPermissionMode, resolveDashboardPermissions, DEFAULT_BYPASS_PERMISSIONS } = await import('../lib/permissions.mjs');

test.after(() => rmSync(temp, { recursive: true, force: true }));

test('bypass permissions defaults to ON before anything is configured', () => {
  assert.equal(DEFAULT_BYPASS_PERMISSIONS, true);
  assert.equal(bypassPermissionsEnabled({ version: 2, active: null, profiles: {}, preferences: {} }), true);
  assert.equal(bypassPermissionsEnabled({ version: 2, active: null, profiles: {} }), true);
});

test('the preference can be turned off and on and is stored in settings.json', () => {
  setBypassPermissions(false);
  assert.equal(bypassPermissionsEnabled(readConfig()), false);
  // Only an explicit `true` turns it on again; other junk keeps it off.
  assert.equal(bypassPermissionsEnabled({ preferences: { bypassPermissions: 'yes' } }), true);
  setBypassPermissions(true);
  assert.equal(bypassPermissionsEnabled(readConfig()), true);
  const stored = JSON.parse(readFileSync(join(temp, 'data', 'settings.json'), 'utf8'));
  assert.equal(stored.preferences.bypassPermissions, true);
});

test('resolves the launch flags from preference, --safe and --unrestricted', () => {
  const on = resolvePermissionFlags([], { bypass: true });
  assert.deepEqual(on.args, ['--dangerously-skip-permissions']);
  assert.equal(on.bypass, true);
  assert.equal(on.explicit, false);

  const off = resolvePermissionFlags([], { bypass: false });
  assert.deepEqual(off.args, []);
  assert.equal(off.bypass, false);

  // --safe and --unrestricted are launcher-only and never reach Claude Code.
  assert.deepEqual(resolvePermissionFlags(['--safe'], { bypass: true }), { args: [], bypass: false, explicit: false });
  assert.deepEqual(resolvePermissionFlags(['--unrestricted'], { bypass: false }), { args: ['--dangerously-skip-permissions'], bypass: true, explicit: false });

  // An explicit flag is forwarded once and still needs the confirmation.
  const explicit = resolvePermissionFlags(['--dangerously-skip-permissions'], { bypass: true });
  assert.deepEqual(explicit.args, ['--dangerously-skip-permissions']);
  assert.equal(explicit.explicit, true);
  assert.equal(hasExplicitBypass(['--permission-mode=bypassPermissions']), true);
  assert.equal(hasExplicitBypass(['bypassPermissions']), true);
  assert.equal(hasExplicitBypass(['--permission-mode=acceptEdits']), false);
});

test('an explicit --permission-mode overrides the stored bypass default', () => {
  // README documents `START.bat cli --permission-mode acceptEdits`. Appending
  // --dangerously-skip-permissions would hand Claude Code two contradicting
  // modes and could run unrestricted instead of edit-only.
  const separate = resolvePermissionFlags(['--permission-mode', 'acceptEdits'], { bypass: true });
  assert.deepEqual(separate, { args: ['--permission-mode', 'acceptEdits'], bypass: false, explicit: false });
  const inline = resolvePermissionFlags(['--permission-mode=plan'], { bypass: true });
  assert.deepEqual(inline, { args: ['--permission-mode=plan'], bypass: false, explicit: false });
  // Nothing to suppress when the preference is already off.
  assert.deepEqual(resolvePermissionFlags(['--permission-mode', 'acceptEdits'], { bypass: false }).args, ['--permission-mode', 'acceptEdits']);
  // Contradicting the one-off opt-in is an error, not a silent widening.
  assert.throws(() => resolvePermissionFlags(['--permission-mode=acceptEdits', '--unrestricted']), /Cannot combine/);
  // An explicit bypass mode still requires the UNRESTRICTED confirmation.
  const bypass = resolvePermissionFlags(['--permission-mode=bypassPermissions'], { bypass: false });
  assert.deepEqual(bypass.args, ['--permission-mode=bypassPermissions']);
  assert.equal(bypass.explicit, true);
});

test('rejects contradictory permission flags', () => {
  assert.throws(() => resolvePermissionFlags([], { safe: true, forceOn: true }), /Cannot combine/);
  assert.throws(() => resolvePermissionFlags(['--dangerously-skip-permissions'], { safe: true }), /Cannot combine/);
});

test('the studio follows the same stored default', () => {
  assert.equal(defaultPermissionMode({ preferences: {} }), 'bypassPermissions');
  assert.equal(defaultPermissionMode({ preferences: { bypassPermissions: true } }), 'bypassPermissions');
  assert.equal(defaultPermissionMode({ preferences: { bypassPermissions: false } }), 'default');

  // Nothing chosen by the client: the stored mode applies and carries the
  // standing consent the agent's unrestricted gate requires.
  assert.deepEqual(resolveDashboardPermissions({}, { preferences: {} }), { permissionMode: 'bypassPermissions', confirmation: 'UNRESTRICTED' });
  assert.deepEqual(resolveDashboardPermissions({}, { preferences: { bypassPermissions: false } }), { permissionMode: 'default', confirmation: undefined });

  // A per-turn choice is honoured and keeps its own confirmation requirement.
  assert.deepEqual(resolveDashboardPermissions({ permissionMode: 'acceptEdits' }, { preferences: {} }), { permissionMode: 'acceptEdits', confirmation: undefined });
  assert.deepEqual(resolveDashboardPermissions({ permissionMode: 'bypassPermissions' }, { preferences: { bypassPermissions: false } }), { permissionMode: 'bypassPermissions', confirmation: undefined });
});

test('unrelated arguments are passed through untouched', () => {
  const result = resolvePermissionFlags(['--model', 'm', '--resume', 'session-1'], { bypass: false });
  assert.deepEqual(result.args, ['--model', 'm', '--resume', 'session-1']);
  assert.equal(result.bypass, false);
});

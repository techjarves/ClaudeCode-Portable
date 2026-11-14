import test from 'node:test';
import assert from 'node:assert/strict';
import { permissionModeAfterRun } from '../dashboard/permission-turn.js';

test('a one-off override ends with the turn it was chosen for', () => {
  // Stored mode OFF, the user confirmed Unrestricted for this turn. Keeping it
  // would attach the UNRESTRICTED confirmation to every later run.
  assert.deepEqual(
    permissionModeAfterRun({ runMode: 'bypassPermissions', currentMode: 'bypassPermissions', defaultMode: 'default' }),
    { mode: 'default', reset: true },
  );
  // The same applies to any picker choice, not only Unrestricted.
  assert.deepEqual(
    permissionModeAfterRun({ runMode: 'acceptEdits', currentMode: 'acceptEdits', defaultMode: 'default' }),
    { mode: 'default', reset: true },
  );
});

test('the stored mode is kept and never triggers an update', () => {
  assert.deepEqual(
    permissionModeAfterRun({ runMode: 'bypassPermissions', currentMode: 'bypassPermissions', defaultMode: 'bypassPermissions' }),
    { mode: 'bypassPermissions', reset: false },
  );
  assert.deepEqual(
    permissionModeAfterRun({ runMode: 'default', currentMode: 'default', defaultMode: 'default' }),
    { mode: 'default', reset: false },
  );
});

test('a mode picked while the turn was running belongs to the next turn', () => {
  // The picker changed during the run, so the finished turn's mode is stale.
  assert.deepEqual(
    permissionModeAfterRun({ runMode: 'bypassPermissions', currentMode: 'acceptEdits', defaultMode: 'default' }),
    { mode: 'acceptEdits', reset: false },
  );
});

test('re-picking the mode the running turn already uses is still a choice', () => {
  // Without the flag this looked like "nothing was picked" and was reset, even
  // though the user had just opened the picker and selected it again.
  assert.deepEqual(
    permissionModeAfterRun({ runMode: 'acceptEdits', currentMode: 'acceptEdits', defaultMode: 'default', pickedDuringRun: true }),
    { mode: 'acceptEdits', reset: false },
  );
  // Nothing picked: the one-off still ends with the turn.
  assert.deepEqual(
    permissionModeAfterRun({ runMode: 'acceptEdits', currentMode: 'acceptEdits', defaultMode: 'default', pickedDuringRun: false }),
    { mode: 'default', reset: true },
  );
});

/**
 * The composer's permission picker chooses the mode for the next turn, not for
 * the rest of the session: the dialog says "Enable for next turn", the toast
 * says "selected for the next turn", and the README describes it as a
 * single-turn override. Without this the confirmed Unrestricted choice would be
 * attached to every later run - in every workspace - and bypass approvals
 * silently.
 *
 * `runMode` is the mode the finished turn ran with, `currentMode` is what the
 * picker holds now, `defaultMode` is the stored preference the studio starts
 * from, and `pickedDuringRun` says whether the user opened the picker while the
 * turn was running. Such a deliberate choice belongs to the next turn and is
 * kept - even when it names the same mode the running turn already used, which
 * a value comparison alone cannot tell apart from "nothing was picked".
 *
 * @returns {{mode: string, reset: boolean}} the mode to keep and whether the UI
 *   has to update because it changed.
 */
export function permissionModeAfterRun({ runMode, currentMode, defaultMode, pickedDuringRun = false }) {
  if (pickedDuringRun) return { mode: currentMode, reset: false };
  // Picked while the turn was running before this flag existed.
  if (currentMode !== runMode) return { mode: currentMode, reset: false };
  if (runMode === defaultMode) return { mode: currentMode, reset: false };
  return { mode: defaultMode, reset: currentMode !== defaultMode };
}

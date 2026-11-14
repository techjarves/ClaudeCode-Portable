import { CONFIG } from './paths.mjs';
import { readConfig, writeJSON } from './config.mjs';

// Bypass permissions is the default: every launch of the Claude Code terminal
// runs with approvals disabled. Users who want approval prompts turn it off
// permanently (START.bat permissions off, or menu option 8) or per launch
// (START.bat cli --safe).
export const DEFAULT_BYPASS_PERMISSIONS = true;

export const BYPASS_FLAGS = ['--dangerously-skip-permissions', '--permission-mode=bypassPermissions'];
const BYPASS_PATTERN = /dangerously-skip-permissions|permission-mode=bypassPermissions/;

/** Stored preference; undefined means "never configured" and stays ON. */
export function bypassPermissionsEnabled(config = readConfig()) {
  const value = config?.preferences?.bypassPermissions;
  if (value === undefined) return DEFAULT_BYPASS_PERMISSIONS;
  return value !== false;
}

export function setBypassPermissions(enabled, config = readConfig()) {
  const next = { ...config, preferences: { ...(config.preferences || {}), bypassPermissions: enabled === true } };
  writeJSON(CONFIG, next);
  return next.preferences.bypassPermissions;
}

/** Dashboard permission mode for a turn the client did not configure. */
export function defaultPermissionMode(config = readConfig()) {
  return bypassPermissionsEnabled(config) ? 'bypassPermissions' : 'default';
}

/**
 * Resolves the permission mode for a dashboard turn.
 *
 * An explicit client choice is used as-is and still needs its own confirmation.
 * Otherwise the stored preference decides, and — because it is a deliberate
 * setting rather than a per-turn switch — it carries the standing consent the
 * agent's unrestricted-mode gate expects.
 */
export function resolveDashboardPermissions({ permissionMode, confirmation } = {}, config = readConfig()) {
  if (permissionMode) return { permissionMode, confirmation };
  const mode = defaultPermissionMode(config);
  return { permissionMode: mode, confirmation: mode === 'bypassPermissions' ? 'UNRESTRICTED' : undefined };
}

/** True when the caller passed an unrestricted flag by hand. */
export function hasExplicitBypass(args) {
  return args.some(arg => BYPASS_PATTERN.test(arg)) || args.includes('bypassPermissions');
}

/**
 * Resolves the permission flags for a terminal launch.
 *
 * @param {string[]} args        Forwarded Claude Code arguments.
 * @param {object}   options
 * @param {boolean}  options.bypass    Stored preference.
 * @param {boolean}  options.safe      One-off opt-out (`--safe`).
 * @param {boolean}  options.forceOn   One-off opt-in (`--unrestricted`).
 * @returns {{args: string[], bypass: boolean, explicit: boolean}}
 *   `explicit` is true when the caller supplied the flag itself, which still
 *   requires the interactive UNRESTRICTED confirmation.
 */
export function resolvePermissionFlags(args, { bypass = DEFAULT_BYPASS_PERMISSIONS, safe = false, forceOn = false } = {}) {
  // The one-off switches are read from the argument list as well, so callers
  // cannot forget to forward them.
  const safeMode = safe || args.includes('--safe');
  const forceMode = forceOn || args.includes('--unrestricted');
  if (safeMode && forceMode) throw new Error('Cannot combine --safe and --unrestricted.');
  if (safeMode && hasExplicitBypass(args)) throw new Error('Cannot combine --safe with --dangerously-skip-permissions.');
  const explicit = hasExplicitBypass(args);
  const cleaned = args.filter(arg => arg !== '--safe' && arg !== '--unrestricted');
  const effective = forceMode || (safeMode ? false : bypass);
  // Never duplicate a flag the caller already passed.
  if (effective && !explicit) cleaned.push(BYPASS_FLAGS[0]);
  return { args: cleaned, bypass: effective, explicit };
}

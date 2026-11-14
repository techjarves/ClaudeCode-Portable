import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from './paths.mjs';
import { readConfig } from './config.mjs';
import { PROVIDERS, providerEnvironment } from './providers.mjs';
import { executableAt, isStubExecutable } from './runtime.mjs';
import { startAdapter } from './adapter.mjs';
import { startExternalAdapter } from './external-adapter.mjs';
import { startResponsesAdapter } from './responses-adapter.mjs';
import { bypassPermissionsEnabled } from './permissions.mjs';
import { prepareLocalSession } from './local-session.mjs';

// Same permissive shape the portable OpenClaude launcher accepts. Real IDs are
// UUIDs, but anything path-free and non-empty is forwarded to Claude Code,
// which reports unusable IDs itself.
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function isDirectory(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

/**
 * Parses RESUME.bat/resume.sh arguments.
 *
 * Accepted, in any order:
 *   [<session-id>] [--resume <session-id>] [--cwd <directory>] [<directory>]
 *   [--safe] [--unrestricted]
 *
 * Without a session ID the most recent conversation in the working directory
 * is continued. Without --cwd the project folder is used. --safe turns bypass
 * permissions off for this launch, --unrestricted forces it on.
 *
 * @returns {{sessionId: string|null, workDir: string, safe: boolean, forceOn: boolean}}
 */
export function parseResumeArgs(argv, { cwd = process.cwd(), projectRoot = ROOT } = {}) {
  let sessionId = null;
  let sessionDefined = false;
  let workDir = null;
  let cwdDefined = false;
  let safe = false;
  let forceOn = false;
  const args = [...argv];

  for (let index = 0; index < args.length; index++) {
    const value = args[index];

    if (value === '--safe') { safe = true; continue; }
    if (value === '--unrestricted') { forceOn = true; continue; }

    if (value === '--resume') {
      if (sessionDefined) throw new Error('Duplicate --resume parameter.');
      const next = args[index + 1];
      if (next === undefined || next === '') throw new Error('Missing session ID after --resume.');
      if (next === '--' || next.startsWith('--')) throw new Error(`Invalid session ID: ${next}`);
      if (!SESSION_ID_PATTERN.test(next)) throw new Error(`Invalid session ID format: ${next}`);
      sessionId = next;
      sessionDefined = true;
      index++;
      continue;
    }

    if (value === '--cwd') {
      if (cwdDefined) throw new Error('Duplicate --cwd parameter.');
      const next = args[index + 1];
      if (next === undefined || next === '') throw new Error('Missing working directory after --cwd.');
      if (next === '--' || next.startsWith('--')) throw new Error(`Invalid working directory: ${next}`);
      workDir = resolve(cwd, next);
      cwdDefined = true;
      index++;
      continue;
    }

    // Anything flag-shaped that is not --resume/--cwd is unknown. Without this
    // check "--bogus" would match the permissive session ID shape.
    if (value.startsWith('--')) throw new Error(`Unknown argument: ${value}`);

    if (!sessionDefined) {
      const candidate = resolve(cwd, value);
      if (isDirectory(candidate)) {
        if (cwdDefined) throw new Error('Duplicate working directory argument.');
        workDir = candidate;
        cwdDefined = true;
        continue;
      }
      if (!SESSION_ID_PATTERN.test(value)) throw new Error(`Invalid positional session ID: ${value}`);
      sessionId = value;
      sessionDefined = true;
      continue;
    }

    if (!cwdDefined) {
      if (value === '--' || value.startsWith('--')) throw new Error(`Unknown argument: ${value}`);
      workDir = resolve(cwd, value);
      cwdDefined = true;
      continue;
    }

    throw new Error(`Unknown argument: ${value}`);
  }

  workDir = workDir ?? resolve(projectRoot);
  if (!isDirectory(workDir)) throw new Error(`Working directory not found: ${workDir}`);
  if (safe && forceOn) throw new Error('Cannot combine --safe and --unrestricted.');
  return { sessionId, workDir, safe, forceOn };
}

/**
 * Resume follows the stored bypass-permissions preference, which defaults to
 * ON: no approval prompts and no UNRESTRICTED confirmation. Turn it off with
 * `START.bat permissions off` or for one launch with `RESUME.bat --safe`.
 */
export function buildResumeArguments(profile, sessionId, { continueSession = true, unrestricted = true } = {}) {
  const args = ['--model', profile.model];
  if (unrestricted) args.push('--dangerously-skip-permissions');
  if (sessionId) args.push('--resume', sessionId);
  else if (continueSession) args.push('--continue');
  return args;
}

function spawnAndWait(spawnImpl, command, args, options) {
  const child = spawnImpl(command, args, options);
  return new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolvePromise(code ?? 1));
  });
}

/**
 * Starts Claude Code in an existing session. Reuses the provider configuration,
 * adapters and environment of the launcher but never installs, repairs, updates
 * or prompts for configuration.
 *
 * @returns {Promise<{status: number, mode: 'resumed'|'continued'|'new'}>}
 */
export async function runResume({
  sessionId = null,
  workDir = ROOT,
  config = readConfig(),
  executable = executableAt(),
  safe = false,
  forceOn = false,
  deps = {},
} = {}) {
  const spawnImpl = deps.spawn ?? spawn;
  const buildEnvironment = deps.providerEnvironment ?? providerEnvironment;
  const starters = {
    builtin: deps.startAdapter ?? startAdapter,
    external: deps.startExternalAdapter ?? startExternalAdapter,
    responses: deps.startResponsesAdapter ?? startResponsesAdapter,
  };

  const profile = config?.profiles?.[config.active];
  if (!profile) throw new Error('No AI provider is configured. Run START.bat and choose a provider first.');
  const provider = PROVIDERS[profile.provider];
  if (!provider) throw new Error(`The saved profile uses an unknown provider: ${String(profile.provider)}`);
  if (!executable || !existsSync(executable)) {
    throw new Error('The portable Claude Code runtime is not installed. Run START.bat first.');
  }
  if (isStubExecutable(executable)) {
    throw new Error('The portable Claude Code executable is incomplete. Run START.bat to repair the runtime.');
  }
  if (!isDirectory(workDir)) throw new Error(`Working directory not found: ${workDir}`);

  const useAdapter = provider.transport === 'openai';
  const adapter = !useAdapter ? null
    : profile.adapter === 'external' ? await starters.external(profile)
    : profile.adapter === 'responses' ? await starters.responses(profile)
    : await starters.builtin(profile);

  const unrestricted = forceOn || (safe ? false : bypassPermissionsEnabled(config));
  // Ollama: start the bundled server and the prompt-trimming proxy first.
  const local = await (deps.prepareLocalSession ?? prepareLocalSession)(profile);

  try {
    const env = buildEnvironment(local.profile, { adapter });
    const options = { cwd: workDir, env, stdio: 'inherit' };
    console.log(`\nClaudeCode-Portable → ${provider.name} / ${profile.model}`);
    console.log(`Bypass permissions: ${unrestricted ? 'ON (no approval prompts)' : 'OFF (approval prompts enabled)'}`);
    console.log(sessionId ? `Resuming session ${sessionId} in ${workDir}\n` : `Continuing the most recent session in ${workDir}\n`);

    if (sessionId) {
      const status = await spawnAndWait(spawnImpl, executable, buildResumeArguments(profile, sessionId, { unrestricted }), options);
      return { status, mode: 'resumed' };
    }

    const continued = await spawnAndWait(spawnImpl, executable, buildResumeArguments(profile, null, { unrestricted }), options);
    if (continued === 0) return { status: 0, mode: 'continued' };

    console.warn('[WARN] No conversation found to continue. Starting a new session...');
    const fresh = await spawnAndWait(spawnImpl, executable, buildResumeArguments(profile, null, { continueSession: false, unrestricted }), options);
    return { status: fresh, mode: 'new' };
  } finally {
    await adapter?.close();
    await local.cleanup();
  }
}

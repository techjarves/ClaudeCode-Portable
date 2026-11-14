import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from './paths.mjs';

const WINDOWS = process.platform === 'win32';

/** Bundled PortableGit, installed by tools/bootstrap.ps1 only when no system Git for Windows exists. */
export function bundledGitBash() {
  return join(ROOT, 'engine', 'git-win-x64', 'bin', 'bash.exe');
}

// Git for Windows keeps bash next to git.exe, in bin/ or usr/bin/. MSYS2 layouts
// such as <root>/ucrt64/bin/git.exe put bash two levels up.
function bashCandidatesForGitExe(gitExe) {
  const dir = dirname(gitExe);
  return [
    join(dir, 'bash.exe'),
    join(dir, '..', 'bin', 'bash.exe'),
    join(dir, '..', 'usr', 'bin', 'bash.exe'),
    join(dir, '..', '..', 'bin', 'bash.exe'),
    join(dir, '..', '..', 'usr', 'bin', 'bash.exe'),
  ];
}

function gitOnPath(findExecutable) {
  try {
    const output = findExecutable('git');
    return output.split(/\r?\n/).map(line => line.trim()).filter(line => /git\.exe$/i.test(line));
  } catch {
    return [];
  }
}

/**
 * Finds a usable Git Bash, preferring the bundled copy and then the system
 * installation. Returns null when none is available, which makes the launcher
 * fall back to the Claude Code default.
 */
export function resolveGitBash({
  exists = existsSync,
  env = process.env,
  platform = process.platform,
  findExecutable = name => execFileSync('where', [name], { encoding: 'utf8', windowsHide: true }),
} = {}) {
  if (platform !== 'win32') return null;
  const bundled = bundledGitBash();
  const candidates = [
    env.CLAUDE_CODE_GIT_BASH_PATH,
    bundled,
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    ...(env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe')] : []),
    ...(env.ProgramFiles ? [join(env.ProgramFiles, 'Git', 'bin', 'bash.exe')] : []),
    ...gitOnPath(findExecutable).flatMap(bashCandidatesForGitExe),
  ];
  return candidates.find(path => typeof path === 'string' && path && exists(path)) || null;
}

// Candidate home directories, most specific first. USERPROFILE and HOME can
// both be redirected in a nested portable session, while HOMEDRIVE+HOMEPATH
// usually still names the real Windows profile - so every candidate is tried
// and the first one that actually holds a Git configuration wins.
function hostHomes(env) {
  const homes = [
    env.USERPROFILE,
    env.HOMEDRIVE && env.HOMEPATH ? `${env.HOMEDRIVE}${env.HOMEPATH}` : null,
    env.HOME,
  ].filter(Boolean);
  return [...new Set(homes)];
}

/**
 * Path to the user's real Git configuration.
 *
 * A session runs with HOME redirected into data/, so Git no longer sees the
 * host's ~/.gitconfig and an agent's `git commit` would fail with "Author
 * identity unknown". Pointing GIT_CONFIG_GLOBAL at the host file keeps identity
 * and credential helpers working. `env` must be the environment *before*
 * redirection; when no host config exists the variable is left alone.
 *
 * Note: GIT_CONFIG_GLOBAL is also a write target. `git config --global` inside
 * a session edits the host configuration, which is the deliberate trade-off of
 * this option.
 */
export function hostGitConfigPath({ env = process.env, exists = existsSync } = {}) {
  // Opt-out for users who want Git confined to the drive.
  if (env.PORTABLE_AI_NO_HOST_GIT_CONFIG === '1') return null;
  const explicitly = env.GIT_CONFIG_GLOBAL;
  if (explicitly && exists(explicitly)) return explicitly;
  const candidates = hostHomes(env).flatMap(home => [
    join(home, '.gitconfig'),
    ...(process.platform === 'win32' ? [] : [join(home, '.config', 'git', 'config')]),
  ]);
  return candidates.find(path => exists(path)) || null;
}

/**
 * Environment for a Claude Code child process: points it at the resolved Git
 * Bash and adds Git's own directories to PATH. Returns an empty object when no
 * Git installation is present, so the runtime keeps its defaults.
 */
export function gitEnvironment(options = {}) {
  const env = options.env ?? process.env;
  // Independent of Git Bash: Git may be installed without a shell we can use.
  const globalConfig = hostGitConfigPath({ ...options, env });
  const configEnvironment = globalConfig ? { GIT_CONFIG_GLOBAL: globalConfig } : {};
  const bash = resolveGitBash(options);
  if (!bash) return configEnvironment;
  const gitRoot = dirname(dirname(bash));
  const pathParts = [join(gitRoot, 'cmd'), join(gitRoot, 'bin'), join(gitRoot, 'usr', 'bin')].filter(existsSync);
  const current = env.PATH ?? '';
  return {
    CLAUDE_CODE_GIT_BASH_PATH: bash,
    ...(pathParts.length ? { PATH: [...pathParts, current].join(';') } : {}),
    ...configEnvironment,
  };
}

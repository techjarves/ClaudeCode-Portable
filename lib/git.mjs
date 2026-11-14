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

/**
 * Environment for a Claude Code child process: points it at the resolved Git
 * Bash and adds Git's own directories to PATH. Returns an empty object when no
 * Git installation is present, so the runtime keeps its defaults.
 */
export function gitEnvironment(options = {}) {
  const bash = resolveGitBash(options);
  if (!bash) return {};
  const gitRoot = dirname(dirname(bash));
  const pathParts = [join(gitRoot, 'cmd'), join(gitRoot, 'bin'), join(gitRoot, 'usr', 'bin')].filter(existsSync);
  const current = options.env?.PATH ?? process.env.PATH ?? '';
  return {
    CLAUDE_CODE_GIT_BASH_PATH: bash,
    ...(pathParts.length ? { PATH: [...pathParts, current].join(';') } : {}),
  };
}

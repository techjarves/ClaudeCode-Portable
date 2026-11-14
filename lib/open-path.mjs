import { spawn } from 'node:child_process';

// Hands a local file or folder to the operating system so it opens with the
// user's own application. Arguments are passed as an array and never through a
// shell, so a path containing spaces, quotes or metacharacters cannot turn into
// a command.
export function openerFor(platform = process.platform) {
  if (platform === 'win32') return { command: 'explorer.exe', args: [] };
  if (platform === 'darwin') return { command: 'open', args: [] };
  return { command: 'xdg-open', args: [] };
}

export function openLocalPath(target, { platform = process.platform, spawnImpl = spawn } = {}) {
  const { command, args } = openerFor(platform);
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve({ command, target });
    };
    let child;
    try {
      // Detached and unref'd: the opener must outlive the request, not hold it open.
      child = spawnImpl(command, [...args, target], { detached: true, stdio: 'ignore', windowsHide: false });
    } catch (error) {
      return settle(error);
    }
    child.once('error', settle);
    // explorer.exe exits with code 1 even when it opened the item; only a
    // failure to start the process is a real error, which 'error' reports.
    child.once('spawn', () => { child.unref(); settle(); });
  });
}

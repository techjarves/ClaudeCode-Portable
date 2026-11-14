import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const DATA = process.env.PORTABLE_AI_DATA_DIR || join(ROOT, 'data');
export const PLATFORM = `${process.platform}-${process.arch}`;
export const RUNTIME = join(ROOT, 'engine', PLATFORM, 'current');
export const CONFIG = join(DATA, 'settings.json');
export const LOGS = join(DATA, 'logs');
export const CHAT_WORKSPACE = join(DATA, 'conversations');
// Directories the Claude Code child process would otherwise create on the host.
// Everything it owns stays on the drive: even HOME and the Windows roaming
// folders are redirected here before the runtime starts.
export const PORTABLE_HOME = join(DATA, 'home');
export const PORTABLE_XDG_CONFIG = join(DATA, 'config');
export const PORTABLE_XDG_DATA = join(DATA, 'app_data');
export const PORTABLE_APP_DATA = join(DATA, 'app_data');
export const PORTABLE_LOCAL_APP_DATA = join(DATA, 'local_app_data');
export const PORTABLE_CACHE = join(DATA, 'cache');

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const DATA = process.env.PORTABLE_AI_DATA_DIR || join(ROOT, 'data');
export const PLATFORM = `${process.platform}-${process.arch}`;
export const RUNTIME = join(ROOT, 'engine', PLATFORM, 'current');
export const CONFIG = join(DATA, 'settings.json');
export const LOGS = join(DATA, 'logs');
export const CHAT_WORKSPACE = join(DATA, 'conversations');

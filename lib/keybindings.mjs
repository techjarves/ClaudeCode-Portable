import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Claude Code binds image paste to alt+v on Windows (ctrl+v only on macOS, Linux,
// and WSL), so a user who presses ctrl+v gets nothing. This adds ctrl+v to the
// profile's keybindings without touching what the user already configured.
// The action falls back to a text paste when the clipboard holds no image.
const ACTION = 'chat:imagePaste';
const SCHEMA = 'https://json.schemastore.org/claude-code-keybindings.json';

export function keybindingsPath(directory) {
  return join(directory, 'keybindings.json');
}

/**
 * Merges ctrl+v -> chat:imagePaste into an existing keybindings file.
 * Returns the next document; a malformed file is left untouched so a user's
 * syntax error is not silently overwritten.
 */
export function withImagePasteBinding(document) {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) return null;
  if (!Array.isArray(document.bindings)) {
    // An existing file without a bindings array is invalid; report it by
    // returning null rather than replacing the user's content.
    if (Object.keys(document).length) return null;
    document = { $schema: SCHEMA, bindings: [] };
  } else {
    document = { ...document };
  }
  const bindings = document.bindings.map(entry => (entry && typeof entry === 'object' ? { ...entry } : entry));
  const chat = bindings.find(entry => entry && entry.context === 'Chat');
  if (chat) {
    if (typeof chat.bindings !== 'object' || chat.bindings === null) chat.bindings = {};
    // An explicit user choice for ctrl+v always wins.
    if (chat.bindings['ctrl+v'] === ACTION) return document;
    if (chat.bindings['ctrl+v'] !== undefined) return document;
    chat.bindings = { ...chat.bindings, 'ctrl+v': ACTION };
  } else {
    bindings.push({ context: 'Chat', bindings: { 'ctrl+v': ACTION } });
  }
  return { ...document, bindings };
}

export function syncImagePasteKeybinding(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = keybindingsPath(directory);
  let current = null;
  if (existsSync(file)) {
    try {
      current = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      // Leave a file the user is editing alone.
      return { file, changed: false, reason: 'unreadable' };
    }
  }
  const next = withImagePasteBinding(current ?? { $schema: SCHEMA, bindings: [] });
  if (!next) return { file, changed: false, reason: 'unexpected-shape' };
  const serialized = `${JSON.stringify(next, null, 2)}\n`;
  if (existsSync(file) && readFileSync(file, 'utf8') === serialized) return { file, changed: false };
  writeFileSync(file, serialized, { mode: 0o600 });
  return { file, changed: true };
}

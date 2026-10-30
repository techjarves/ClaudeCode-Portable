export const AUTODEV_COMMANDS = Object.freeze({
  '/auto-dev': Object.freeze({ command: '/auto-dev', mode: 'auto-dev', action: 'create' }),
  '/multi-review': Object.freeze({ command: '/multi-review', mode: 'multi-review', action: 'create' }),
  '/deep-review': Object.freeze({ command: '/deep-review', mode: 'deep-review', action: 'create' }),
  '/agent-status': Object.freeze({ command: '/agent-status', mode: 'status', action: 'status' }),
});

const COMMAND_PATTERN = /^\/(auto-dev|multi-review|deep-review|agent-status)(?=$|[ \t])(?:[ \t]+([\s\S]*))?$/;

/**
 * Parse only the four dashboard commands. Unknown slash commands and ordinary
 * messages return null so the existing chat path receives the original text.
 */
export function parseAutoDevCommand(message) {
  if (typeof message !== 'string') return null;
  const match = COMMAND_PATTERN.exec(message);
  if (!match) return null;
  const definition = AUTODEV_COMMANDS[`/${match[1]}`];
  const argument = (match[2] ?? '').trim();
  return Object.freeze({ ...definition, argument, raw: message });
}

export function isAutoDevCommand(message) {
  return parseAutoDevCommand(message) !== null;
}

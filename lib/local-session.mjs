import { ollamaExecutable, startLocal, stopLocal, startProxy, stopProxy, PROXY_URL, ollamaUpstream } from './local-models.mjs';

/**
 * Prepares the local-model stack for a terminal session and returns the profile
 * to launch with plus a cleanup function.
 *
 * For Ollama: starts the bundled server when it is not already online, starts
 * the prompt-trimming proxy, and routes the session through it. Both processes
 * are stopped afterwards unless the user started them outside the app.
 *
 * Every failure is reported as a note instead of aborting: a missing bundled
 * Ollama or an occupied proxy port should not prevent the session from starting
 * against an external server.
 */
export async function prepareLocalSession(profile, {
  startServer = startLocal,
  startSpeedProxy = startProxy,
  stopSpeedProxy = stopProxy,
  stopServer = stopLocal,
  hasServer = ollamaExecutable,
} = {}) {
  if (profile.provider !== 'ollama') return { profile, cleanup: async () => {}, notes: [] };

  const notes = [];
  let startedServer = false;
  let startedProxy = false;
  let usingProxy = false;

  if (hasServer()) {
    try {
      const result = await startServer();
      startedServer = !result?.alreadyRunning;
      notes.push(startedServer ? 'Started the portable Ollama server.' : 'Ollama server is already running.');
    } catch (error) {
      notes.push(`Could not start the portable Ollama server: ${error.message}`);
    }
  } else {
    notes.push('Portable Ollama is not installed; using an external Ollama server.');
  }

  try {
    // The proxy forwards to the server the profile names. Without this, a
    // profile pointing at another machine would silently talk to localhost.
    const upstream = ollamaUpstream(profile.baseUrl);
    const result = await startSpeedProxy({ upstream });
    usingProxy = true;
    startedProxy = !result?.alreadyRunning;
    notes.push(result?.alreadyRunning ? 'Speed proxy already running; system prompts are trimmed.' : 'Speed proxy started; system prompts are trimmed.');
  } catch (error) {
    notes.push(`Speed proxy unavailable (${error.message}); sending system prompts untrimmed.`);
  }

  // Cleanup releases this session's claim even when both processes were
  // adopted: another terminal may still be using them, and the registry inside
  // local-models decides whether anything is actually stopped.
  const cleanup = async () => {
    try { await stopSpeedProxy({ release: true }); } catch {}
    try { await stopServer({ release: true }); } catch {}
  };
  return { profile: usingProxy ? { ...profile, baseUrl: PROXY_URL } : profile, cleanup, notes };
}

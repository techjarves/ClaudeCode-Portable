#!/usr/bin/env node
// Standalone resume entry point used by RESUME.bat and resume.sh.
// It never installs, repairs, updates or reconfigures anything: when the
// portable runtime or the provider profile is missing it fails with a hint to
// run START.bat / start.sh once.
import { ROOT } from '../lib/paths.mjs';
import { parseResumeArgs, runResume } from '../lib/resume.mjs';

try {
  const { sessionId, workDir, safe, forceOn } = parseResumeArgs(process.argv.slice(2), { projectRoot: ROOT });
  const { status } = await runResume({ sessionId, workDir, safe, forceOn });
  process.exitCode = status;
} catch (error) {
  console.error(`\nClaudeCode-Portable: ${error.message}`);
  process.exitCode = 1;
}

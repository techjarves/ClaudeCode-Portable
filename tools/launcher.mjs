import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { ROOT } from '../lib/paths.mjs';
import { readConfig, saveProfile } from '../lib/config.mjs';
import { PROVIDERS, providerEnvironment } from '../lib/providers.mjs';
import { executableAt, installRuntime, runtimeStatus, rollbackRuntime, run } from '../lib/runtime.mjs';
import { startAdapter } from '../lib/adapter.mjs';
import { startExternalAdapter } from '../lib/external-adapter.mjs';
import { startResponsesAdapter } from '../lib/responses-adapter.mjs';

async function main() {
  let [command, ...args] = process.argv.slice(2);
  if (command === '--quick') command = 'cli';
  if (command === '--offline') command = 'cli';
  if (command === 'install' || command === 'update') return console.log(await installRuntime({ onOutput: s => process.stdout.write(s) }));
  if (command === 'rollback') return rollbackRuntime();
  if (command === 'status') return console.log(JSON.stringify(await runtimeStatus(), null, 2));
  if (command === 'use-ollama') {
    if(!args[0]) throw new Error('Provide the installed Ollama model name');
    saveProfile({provider:'ollama',auth:'api',baseUrl:PROVIDERS.ollama.baseUrl,key:'',model:args[0]});
    return console.log(`Ollama profile configured for ${args[0]}. Start its server in System before launching a session.`);
  }
  if (!executableAt()) await installRuntime({ onOutput: s => process.stdout.write(s) });
  if (!command) {
    console.log('\n  CLAUDECODE-PORTABLE\n  Official Claude Code · Your choice of model\n\n  1  Open studio dashboard\n  2  Launch Claude Code terminal\n  3  Configure providers\n  4  Set up local models\n  5  Repair / update pinned runtime\n  6  Roll back runtime\n');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question('Choose [1]: '); rl.close();
    command = ({ '2': 'cli', '3': 'dashboard', '4': 'local-setup', '5': 'update', '6': 'rollback' })[answer] || 'dashboard';
  }
  if (command === 'update') return installRuntime({ onOutput: s => process.stdout.write(s) });
  if (command === 'rollback') return rollbackRuntime();
  if (command === 'local-setup') {
    const windows = process.platform === 'win32';
    return run(windows ? 'powershell.exe' : 'bash', windows ? ['-NoProfile','-ExecutionPolicy','Bypass','-File',join(ROOT,'tools/setup_local_models.ps1')] : [join(ROOT,'tools/setup_local_models.sh')], { stdio: 'inherit', cwd: ROOT });
  }
  if (command === 'dashboard') {
    const { startDashboard } = await import('../dashboard/server.mjs');
    const dashboard = await startDashboard();
    console.log(`\nClaudeCode-Portable studio: ${dashboard.url}\nKeep this terminal open. Ctrl+C stops the studio.`);
    if (!process.env.PORTABLE_AI_NO_OPEN) {
      const op = process.platform === 'darwin' ? ['open',[dashboard.url]] : process.platform === 'win32' ? ['rundll32.exe',['url.dll,FileProtocolHandler',dashboard.url]] : ['xdg-open',[dashboard.url]];
      const child = spawn(op[0],op[1],{ stdio:'ignore',detached:true }); child.on('error',()=>{}); child.unref();
    }
    const stop = async () => { await dashboard.close(); process.exit(0); }; process.once('SIGINT',stop); process.once('SIGTERM',stop); return;
  }
  if (!['cli','resume'].includes(command)) throw new Error('Commands: dashboard, cli, resume <session-id>, install, update, rollback, status, local-setup');
  let config = readConfig(); let profile = config.profiles[config.active];
  if (!profile) {
    if (!process.stdin.isTTY) throw new Error('Configure a provider in the dashboard first');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question('No provider configured. Use official Claude account login? [y/N] '); rl.close();
    if (answer.toLowerCase() !== 'y') throw new Error('Run the dashboard to configure any of the nine providers');
    saveProfile({ provider:'anthropic', auth:'login', model:'sonnet', baseUrl: PROVIDERS.anthropic.baseUrl });
    config = readConfig(); profile = config.profiles[config.active];
  }
  if (command === 'resume') {
    if (!args[0] || !/^[a-zA-Z0-9-]+$/.test(args[0])) throw new Error('Provide an official Claude Code session ID');
    args = ['--resume',...args];
  }
  if (args.some(a => /dangerously-skip-permissions|permission-mode=bypassPermissions/.test(a)) || args.includes('bypassPermissions')) {
    if (!process.stdin.isTTY) throw new Error('Unrestricted mode requires an interactive confirmation');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question('Unrestricted mode can execute commands and change files without asking. Type UNRESTRICTED: '); rl.close();
    if (answer !== 'UNRESTRICTED') throw new Error('Unrestricted mode cancelled');
  }
  const useAdapter = PROVIDERS[profile.provider].transport === 'openai';
  const adapter = !useAdapter ? null : profile.adapter === 'external' ? await startExternalAdapter(profile) : profile.adapter === 'responses' ? await startResponsesAdapter(profile) : await startAdapter(profile);
  const env = providerEnvironment(profile, { adapter });
  if (adapter) env.MAX_THINKING_TOKENS = '0';
  console.log(`\nOfficial Claude Code → ${PROVIDERS[profile.provider].name} / ${profile.model}${useAdapter && profile.adapter === 'external' ? ` · external adapter (${profile.toolFormat || 'native'})` : useAdapter && profile.adapter === 'responses' ? ' · Responses API adapter' : ''}\nNon-Claude models have provider-dependent feature compatibility.\n`);
  try { await run(executableAt(), ['--model',profile.model,...args], { stdio:'inherit', env, cwd: process.cwd() }); }
  finally { await adapter?.close(); }
}
main().catch(e => { console.error(`\nClaudeCode-Portable: ${e.message}`); process.exitCode=1; });

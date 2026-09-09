import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../lib/paths.mjs';
let failed=false;
for(const dir of ['lib','tools','dashboard','tests'])for(const file of readdirSync(join(ROOT,dir))){
  if(!/\.(mjs|js)$/.test(file))continue;
  const path=join(ROOT,dir,file);const result=spawnSync(process.execPath,['--check',path],{encoding:'utf8'});
  if(result.status!==0){console.error(result.stderr);failed=true;}
  if(/@gitlawb\/openclaude|CLAUDE_CODE_USE_OPENAI\s*=|dist\/cli\.mjs/.test(readFileSync(path,'utf8'))){console.error(`Obsolete runtime reference: ${dir}/${file}`);failed=true;}
  if(/\.claude-adapter|updateClaudeSettings|updateClaudeJson|checkForUpdates|0\.0\.0\.0|Access-Control-Allow-Origin/.test(readFileSync(path,'utf8'))&&file!=='check.mjs'){console.error(`Non-portable adapter reference: ${dir}/${file}`);failed=true;}
}
if(failed)process.exitCode=1;else console.log('JavaScript syntax and runtime reference checks passed.');

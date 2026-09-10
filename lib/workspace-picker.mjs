import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { ROOT } from './paths.mjs';

function executable(name,pathValue=process.env.PATH||'') {
  for(const directory of pathValue.split(delimiter))try{const candidate=join(directory,name);accessSync(candidate,constants.X_OK);return candidate;}catch{}
  return null;
}

function run(command,args) {
  return new Promise((resolve,reject)=>execFile(command,args,{encoding:'utf8',maxBuffer:1024*1024},(error,stdout,stderr)=>{
    if(error){error.stderr=stderr;reject(error);}else resolve(stdout);
  }));
}

function cancelled(error) { return error?.code===1||/cancel(?:led|ed)|-128/i.test(error?.stderr||error?.message||''); }

export async function pickWorkspace(initial=ROOT,{platform=process.platform,runner=run,pathValue=process.env.PATH}={}) {
  const start=typeof initial==='string'&&existsSync(initial)?realpathSync(initial):ROOT;
  let command,args;
  if(platform==='darwin'){
    command='/usr/bin/osascript';
    args=['-e','on run argv\nset chosenFolder to choose folder with prompt "Choose a folder for ClaudeCode-Portable" default location (POSIX file (item 1 of argv))\nreturn POSIX path of chosenFolder\nend run','--',start];
  }else if(platform==='win32'){
    command='powershell.exe';
    const script='$dialog = New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description = "Choose a folder for ClaudeCode-Portable"; $dialog.SelectedPath = $args[0]; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }';
    args=['-NoProfile','-STA','-Command','Add-Type -AssemblyName System.Windows.Forms; '+script,start];
  }else{
    const zenity=executable('zenity',pathValue),kdialog=executable('kdialog',pathValue);
    if(zenity){command=zenity;args=['--file-selection','--directory','--title=Choose a folder for ClaudeCode-Portable',`--filename=${start}/`];}
    else if(kdialog){command=kdialog;args=['--getexistingdirectory',start,'--title','Choose a folder for ClaudeCode-Portable'];}
    else throw new Error('No graphical folder picker is available. Install zenity or kdialog, or enter a folder path manually.');
  }
  let output;
  try{output=String(await runner(command,args)).trim();}catch(error){if(cancelled(error))return null;throw new Error(`Could not open the folder picker: ${error.message}`);}
  if(!output)return null;
  const selected=realpathSync(output);
  if(!statSync(selected).isDirectory())throw new Error('The selected workspace is not a directory');
  return selected;
}

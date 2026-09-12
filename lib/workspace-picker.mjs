import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { ROOT } from './paths.mjs';

function executable(name,pathValue=process.env.PATH||'') {
  for(const directory of pathValue.split(delimiter))try{const candidate=join(directory,name);accessSync(candidate,constants.X_OK);return candidate;}catch{}
  return null;
}

function run(command,args,options={}) {
  return new Promise((resolve,reject)=>execFile(command,args,{encoding:'utf8',maxBuffer:1024*1024,...options},(error,stdout,stderr)=>{
    if(error){error.stderr=stderr;reject(error);}else resolve(stdout);
  }));
}

function cancelled(error) { return error?.code===1||/cancel(?:led|ed)|-128/i.test(error?.stderr||error?.message||''); }

export async function pickWorkspace(initial=ROOT,{platform=process.platform,runner=run,pathValue=process.env.PATH}={}) {
  const start=typeof initial==='string'&&existsSync(initial)?realpathSync(initial):ROOT;
  let command,args,options;
  if(platform==='darwin'){
    command='/usr/bin/osascript';
    args=['-e','on run argv\nset chosenFolder to choose folder with prompt "Choose a folder for ClaudeCode-Portable" default location (POSIX file (item 1 of argv))\nreturn POSIX path of chosenFolder\nend run','--',start];
  }else if(platform==='win32'){
    command='powershell.exe';
    // Keep -Command last: Windows PowerShell otherwise treats the selected path as
    // more PowerShell source instead of a value in $args. A topmost owner also
    // prevents the modal picker from opening unnoticed behind the browser.
    const script='Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; $owner = New-Object System.Windows.Forms.Form; $dialog.Description = "Choose a folder for ClaudeCode-Portable"; $dialog.SelectedPath = $env:PORTABLE_AI_WORKSPACE_PICKER_INITIAL; $owner.ShowInTaskbar = $false; $owner.TopMost = $true; $owner.StartPosition = "CenterScreen"; $owner.Size = New-Object System.Drawing.Size(1, 1); $owner.Opacity = 0; try { $owner.Show(); $owner.Activate(); if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) } } finally { $dialog.Dispose(); $owner.Dispose() }';
    args=['-NoProfile','-STA','-Command',script];
    options={env:{...process.env,PORTABLE_AI_WORKSPACE_PICKER_INITIAL:start}};
  }else{
    const zenity=executable('zenity',pathValue),kdialog=executable('kdialog',pathValue);
    if(zenity){command=zenity;args=['--file-selection','--directory','--title=Choose a folder for ClaudeCode-Portable',`--filename=${start}/`];}
    else if(kdialog){command=kdialog;args=['--getexistingdirectory',start,'--title','Choose a folder for ClaudeCode-Portable'];}
    else throw new Error('No graphical folder picker is available. Install zenity or kdialog, or enter a folder path manually.');
  }
  let output;
  try{output=String(await runner(command,args,options)).trim();}catch(error){if(cancelled(error))return null;throw new Error(`Could not open the folder picker: ${error.message}`);}
  if(!output)return null;
  const selected=realpathSync(output);
  if(!statSync(selected).isDirectory())throw new Error('The selected workspace is not a directory');
  return selected;
}

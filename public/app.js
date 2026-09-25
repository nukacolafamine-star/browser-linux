// SPDX-License-Identifier: GPL-2.0-only
import {Machine} from './machine.js';
import {load,store,validateSnapshot} from './storage.js';
import {verifySnapshot} from './integrity.js';
const $=id=>document.getElementById(id);
const machine=new Machine();window.machine=machine;
const term=new Terminal({fontFamily:'Consolas, ui-monospace, monospace',fontSize:14,lineHeight:1.25,cursorBlink:true,scrollback:3000,theme:{background:'#0a0e16',foreground:'#d5deee',cursor:'#b8f269',selectionBackground:'#344755',green:'#b8f269',brightGreen:'#d1ff98',blue:'#86b7ff',brightBlue:'#aacfff'}});
const fit=new FitAddon.FitAddon();term.loadAddon(fit);term.open($('terminal'));
let active='terminal',folder='/home/web',editorPath=null,editorDirty=false,editorOriginal='',toastTimer,resizeTimer,draftTimer,interactive=false,bootBuffer='',busyBoot=false;
const nameOf=path=>path.split('/').pop();
const bytesLabel=n=>n<1024?`${n} B`:n<1048576?`${(n/1024).toFixed(1)} KiB`:`${(n/1048576).toFixed(1)} MiB`;
function toast(message,error=false){clearTimeout(toastTimer);$('toast').textContent=message;$('toast').classList.toggle('error',error);$('toast').hidden=false;toastTimer=setTimeout(()=>$('toast').hidden=true,error?8000:3500);}
const action=fn=>async event=>{try{await fn(event);}catch(error){toast(error.message,true);}};
function ask(title,{description='',value='',label='Name',confirm='Continue',input=true}={}){
  const dialog=$('prompt-dialog');if(dialog.open)return Promise.resolve(null);
  $('prompt-title').textContent=title;$('prompt-description').textContent=description;$('prompt-input').value=value;$('prompt-label').textContent=label;
  $('prompt-input').hidden=!input;$('prompt-label').hidden=!input;$('prompt-confirm').textContent=confirm;dialog.returnValue='';dialog.showModal();
  if(input)$('prompt-input').select();
  return new Promise(resolve=>dialog.addEventListener('close',()=>resolve(dialog.returnValue==='ok'?(input?$('prompt-input').value:true):null),{once:true}));
}
function updateEditor(){
  $('editor-title').textContent=editorPath?nameOf(editorPath):'Untitled';$('editor-path').textContent=editorPath||'Save a new file into /home/web';
  $('editor-state').textContent=editorDirty?'Unsaved changes':editorPath?'Saved':'New document';$('character-count').textContent=`${$('editor').value.length.toLocaleString()} characters`;
}
async function persistDraft(){await store({path:editorPath,text:$('editor').value,dirty:editorDirty,original:editorOriginal},'editor-draft');}
async function canReplaceEditor(){return !editorDirty || await ask('Discard unsaved edits?',{description:'Your current editor changes have not been saved to Linux.',confirm:'Discard edits',input:false});}
function switchView(view){
  active=view;document.querySelectorAll('.view').forEach(el=>el.classList.toggle('active',el.id==='view-'+view));
  document.querySelectorAll('[data-view]').forEach(el=>{el.classList.toggle('selected',el.dataset.view===view);el.setAttribute('aria-current',el.dataset.view===view?'page':'false');});
  if(view==='terminal')requestAnimationFrame(()=>{fitTerminal();term.focus();});
  if(view==='files'&&machine.state==='running')refreshFiles().catch(error=>toast(error.message,true));
  if(view==='machine')refreshInfo().catch(()=>{});
}
function fitTerminal(){
  if(active!=='terminal')return;fit.fit();
  if(machine.state==='running')machine.rpc('resize',{cols:term.cols,rows:term.rows}).catch(()=>{});
}
new ResizeObserver(()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(fitTerminal,100);}).observe($('terminal'));
term.onData(data=>{if(machine.state==='running')machine.os.key_input(data);});
machine.addEventListener('console',({detail:text})=>{
  if(interactive)term.write(text);
  else{bootBuffer+=text;const index=bootBuffer.indexOf('Browser Linux |');if(index>=0){interactive=true;term.write(bootBuffer.slice(index));bootBuffer='';}}
});
machine.addEventListener('state',({detail:{state,detail}})=>{
  const running=state==='running';$('status').textContent=running?'Linux is running':detail||state;$('status').classList.toggle('live',running);
  for(const id of ['save-workspace','export-workspace','machine-export','interrupt','refresh-files','up-folder','new-file','new-folder','import-file','save-as','save-file'])$(id).disabled=!running;
  $('editor').disabled=!running;
  if(state==='error'){$('error-message').textContent=detail;$('error-banner').hidden=false;$('saved-state').textContent='Session stopped · saved files retained';}
});
machine.addEventListener('saving',()=>$('saved-state').textContent='Saving workspace…');
machine.addEventListener('saved',({detail:snapshot})=>{$('saved-state').textContent='Saved '+new Date(snapshot.savedAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});$('storage-size').textContent=bytesLabel(snapshot.totalBytes);});
machine.addEventListener('save-error',({detail:error})=>{$('saved-state').textContent='Save failed · export your work';toast(error.message,true);});
machine.addEventListener('boot-progress',({detail:stage})=>$('status').textContent=stage);
async function boot(options={}){
  if(busyBoot)return;busyBoot=true;$('restart').disabled=true;$('retry').disabled=true;$('error-banner').hidden=true;interactive=false;bootBuffer='';term.reset();
  try{await machine.boot({memoryMiB:Number($('memory-choice').value),...options});await refreshFiles();await refreshInfo();fitTerminal();term.focus();$('saved-state').textContent='Autosave every 10 seconds';}
  finally{busyBoot=false;$('restart').disabled=false;$('retry').disabled=false;}
}
async function restart(){
  if(machine.state==='running'){
    const ok=await ask('Restart Linux?',{description:'Workspace files will be saved first. Running commands will stop. Your editor draft will stay here.',confirm:'Save and restart',input:false});if(!ok)return;
    await machine.save();await persistDraft();
  }
  await boot();
}
async function refreshFiles(path=folder){
  if(machine.state!=='running')return;
  const entries=await machine.rpc('list',{path});folder=path.replace(/\/$/,'')||'/';$('current-path').value=folder;
  const writable=folder==='/home/web'||folder.startsWith('/home/web/');
  $('new-file').disabled=!writable;$('new-folder').disabled=!writable;$('import-file').disabled=!writable;
  $('folder-note').textContent=writable?'Files here are shared with the Linux terminal and saved in this browser.':'System files · browse only. Changes outside /home/web are not saved.';
  const list=$('file-list');list.replaceChildren();
  if(!entries.length){const empty=document.createElement('p');empty.className='empty-state';empty.textContent='This folder is empty.';list.append(empty);}
  for(const entry of entries){
    const row=document.createElement('div');row.className='file-row';const button=document.createElement('button');button.className='file-name';button.title=entry.path;
    const icon=document.createElement('span');icon.className='file-icon';icon.textContent=entry.type==='directory'?'▰':entry.type==='symlink'?'↗':'▤';
    const name=document.createElement('span');name.textContent=entry.name;button.append(icon,name);button.onclick=action(()=>entry.type==='directory'?refreshFiles(entry.path):openFile(entry.path));
    if(entry.type==='symlink'||entry.type==='special')button.disabled=true;
    const type=document.createElement('span');type.className='file-type';type.textContent=entry.type;
    const actions=document.createElement('div');actions.className='file-actions';
    if(entry.type==='file'){const download=document.createElement('button');download.textContent='Export';download.title='Export '+entry.name;download.onclick=action(async()=>downloadBytes(await machine.rpc('read',{path:entry.path}),entry.name));actions.append(download);}
    if(writable){const remove=document.createElement('button');remove.textContent='Delete';remove.title='Delete '+entry.name;remove.onclick=action(async()=>{
      if(!await ask('Delete '+entry.name+'?',{description:entry.type==='directory'?'Only empty folders can be deleted.':'This deletes the file from your Linux workspace.',confirm:'Delete',input:false}))return;
      await machine.rpc('remove',{path:entry.path,directory:entry.type==='directory'});await machine.save();await refreshFiles();
    });actions.append(remove);}
    row.append(button,type,actions);list.append(row);
  }
}
async function openFile(path){
  if(!await canReplaceEditor())return;const bytes=await machine.rpc('read',{path});
  if(bytes.includes(0))throw new Error('This looks like a binary file. Use Export to download it.');
  let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new Error('The editor supports UTF-8 text. Export this file to open it elsewhere.');}
  editorPath=path;editorOriginal=text;editorDirty=false;$('editor').value=text;updateEditor();await persistDraft();switchView('editor');
}
function validName(name){if(!name||name==='.'||name==='..'||name.includes('/')||name.includes('\\')||name.includes('\0'))throw new Error('Use a name without slashes');return name;}
async function newFile(){
  if(!await canReplaceEditor())return;const name=await ask('New file',{value:'notes.txt',confirm:'Create'});if(name===null)return;
  const path=folder+'/'+validName(name);if((await machine.rpc('list',{path:folder})).some(e=>e.path===path))throw new Error('A file with that name already exists');
  await machine.write(path,'');await machine.save();await openFile(path);
}
async function saveFile(asNew=false){
  let path=editorPath;
  if(asNew||!path||!path.startsWith('/home/web/')){
    const value=await ask('Save file',{label:'Linux workspace path',value:path?.startsWith('/home/web/')?path:'/home/web/'+(path?nameOf(path):'notes.txt'),confirm:'Save'});if(value===null)return;path=value;
  }
  if(!path.startsWith('/home/web/'))throw new Error('Save files inside /home/web');
  if(path===editorPath){
    let current;try{current=new TextDecoder().decode(await machine.rpc('read',{path}));}catch{}
    if(current!==undefined&&current!==editorOriginal&&!await ask('File changed in Linux',{description:'The terminal or another command changed this file. Replace it with the editor contents?',confirm:'Replace file',input:false}))return;
  }else{
    let exists=false;try{await machine.rpc('read',{path});exists=true;}catch{}
    if(exists&&!await ask('Replace existing file?',{description:path,confirm:'Replace file',input:false}))return;
  }
  const text=$('editor').value;await machine.write(path,text);editorPath=path;editorOriginal=text;editorDirty=$('editor').value!==text;updateEditor();await persistDraft();await machine.save();toast('File saved to Linux and browser storage');
}
function downloadBytes(bytes,name,type='application/octet-stream'){
  const url=URL.createObjectURL(new Blob([bytes],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
}
async function exportWorkspace(){const snapshot=await machine.save();downloadBytes(JSON.stringify(snapshot,(_,v)=>v instanceof Uint8Array?Array.from(v):v),'browser-linux-'+new Date().toISOString().slice(0,10)+'.json','application/json');toast('Workspace backup exported');}
async function restoreBackup(snapshot){
  const valid=validateSnapshot(snapshot);
  await verifySnapshot(valid);
  if(!await ask('Restore this workspace?',{description:`This replaces the current Linux workspace with ${valid.entries.length} saved entries. Your current workspace will be saved first. Running commands will stop.`,confirm:'Restore and restart',input:false}))return;
  if(machine.state==='running')await machine.save();await boot({snapshot:valid});await machine.save();toast('Workspace restored');
}
async function refreshInfo(){
  if(machine.state!=='running')return;const info=await machine.rpc('info');const total=Number(info.memory.match(/MemTotal:\s+(\d+)/)?.[1]||0),available=Number(info.memory.match(/MemAvailable:\s+(\d+)/)?.[1]||0);
  $('memory-used').textContent=`${Math.round((total-available)/1024)} MiB used`;$('memory-total').textContent=`${Math.round(total/1024)} MiB available to Linux`;
  const seconds=Math.floor(parseFloat(info.uptime));$('uptime').textContent=seconds<60?`${seconds}s`:`${Math.floor(seconds/60)}m ${seconds%60}s`;
  $('workers').textContent=machine.os.stats().workers+' active browser workers';$('boot-time').textContent=(machine.bootMs/1000).toFixed(2)+' s';$('shared-memory').textContent=crossOriginIsolated?'Enabled':'Unavailable';$('host-cores').textContent=navigator.hardwareConcurrency||'Unknown';
}
document.querySelectorAll('[data-view]').forEach(button=>button.onclick=()=>switchView(button.dataset.view));
const keys={escape:'\x1b',tab:'\t',interrupt:'\x03',eof:'\x04',up:'\x1b[A',down:'\x1b[B'};
document.querySelectorAll('[data-key]').forEach(button=>button.onclick=()=>{if(machine.state==='running')machine.os.key_input(keys[button.dataset.key]);term.focus();});
$('interrupt').onclick=()=>{machine.os?.key_input('\x03');term.focus();};$('clear-terminal').onclick=()=>{term.clear();term.focus();};
function showBootDetails(){
  const {bootOutput,logs,...diagnostics}=machine.diagnostics();
  $('boot-log').textContent=(bootOutput||'No kernel output yet.').replace(/\r\n/g,'\n')+'\n\nRuntime log:\n'+(logs.join('\n')||'No runtime messages yet.')+'\n\nStartup report:\n'+JSON.stringify(diagnostics,null,2);
  $('boot-copy-status').hidden=true;$('log-dialog').showModal();
}
$('show-boot-log').onclick=showBootDetails;$('error-boot-details').onclick=showBootDetails;$('close-log').onclick=()=>$('log-dialog').close();
$('copy-boot-report').onclick=async()=>{
  const report=$('boot-log'),status=$('boot-copy-status');status.hidden=false;
  try{await navigator.clipboard.writeText(report.textContent);status.textContent='Report copied.';}
  catch{
    report.focus();const range=document.createRange();range.selectNodeContents(report);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
    status.textContent='Automatic copying is unavailable. The report is selected; use your browser’s Copy action.';
  }
};
$('save-workspace').onclick=action(async()=>{await machine.save();toast('Workspace saved in this browser');if(navigator.storage?.persist){const persistent=await navigator.storage.persist();$('persist-state').textContent=persistent?'Persistent browser storage granted.':'Browser-managed storage. Keep exported backups.';}});
$('export-workspace').onclick=action(exportWorkspace);$('machine-export').onclick=action(exportWorkspace);$('restart').onclick=action(restart);$('retry').onclick=action(()=>boot());$('about-button').onclick=()=>switchView('machine');
$('refresh-files').onclick=action(()=>refreshFiles());$('path-form').onsubmit=action(async event=>{event.preventDefault();await refreshFiles($('current-path').value);});
$('up-folder').onclick=action(()=>refreshFiles(folder.slice(0,folder.lastIndexOf('/'))||'/'));
$('new-file').onclick=action(newFile);$('new-folder').onclick=action(async()=>{const name=await ask('New folder',{confirm:'Create'});if(name===null)return;await machine.rpc('mkdir',{path:folder+'/'+validName(name)});await machine.save();await refreshFiles();});
$('import-file').onclick=()=>$('file-input').click();$('file-input').onchange=action(async()=>{
  for(const file of $('file-input').files){if(file.size>8*1024*1024)throw new Error('Files are limited to 8 MiB');const path=folder+'/'+validName(file.name);const exists=(await machine.rpc('list',{path:folder})).some(e=>e.path===path);
    if(exists&&!await ask('Replace '+file.name+'?',{confirm:'Replace',input:false}))continue;await machine.write(path,new Uint8Array(await file.arrayBuffer()));}
  await machine.save();await refreshFiles();$('file-input').value='';toast('Files imported into Linux');
});
$('save-file').onclick=action(()=>saveFile());$('save-as').onclick=action(()=>saveFile(true));
$('editor').oninput=()=>{editorDirty=$('editor').value!==editorOriginal;updateEditor();clearTimeout(draftTimer);draftTimer=setTimeout(()=>persistDraft().catch(error=>toast(error.message,true)),300);};
$('editor').onkeydown=event=>{if(event.key==='Tab'){event.preventDefault();const editor=$('editor');editor.setRangeText('  ',editor.selectionStart,editor.selectionEnd,'end');editor.dispatchEvent(new Event('input'));}};
$('import-backup').onclick=()=>$('backup-input').click();$('backup-input').onchange=action(async()=>{const file=$('backup-input').files[0];if(!file)return;if(file.size>140*1024*1024)throw new Error('Backup is too large');const snapshot=JSON.parse(await file.text());$('backup-input').value='';await restoreBackup(snapshot);});
$('recover-previous').onclick=action(async()=>{const snapshot=await load('previous-workspace');if(!snapshot)throw new Error('No previous save is available yet');await restoreBackup(snapshot);});
$('export-saved').onclick=action(async()=>{
  const saved=await load();if(!saved)throw new Error('No saved workspace is available yet');
  const snapshot=validateSnapshot(saved);await verifySnapshot(snapshot);
  downloadBytes(JSON.stringify(snapshot,(_,v)=>v instanceof Uint8Array?Array.from(v):v),'browser-linux-last-saved.json','application/json');
});
document.addEventListener('keydown',event=>{
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'){event.preventDefault();action(active==='editor'?()=>saveFile():()=>machine.save())();}
  if(event.altKey&&['1','2','3','4'].includes(event.key)){event.preventDefault();switchView(['terminal','files','editor','machine'][Number(event.key)-1]);}
});
document.addEventListener('visibilitychange',()=>{if(document.hidden&&machine.state==='running'){machine.save().catch(()=>{});persistDraft().catch(()=>{});}});
window.addEventListener('pagehide',()=>machine.stop());
window.addEventListener('beforeunload',event=>{if(editorDirty){event.preventDefault();event.returnValue='';}});
setInterval(()=>{if(active==='machine')refreshInfo().catch(()=>{});},3000);
async function offlineSetup(){
  if(!('serviceWorker'in navigator)){$('offline-state').textContent='Offline cache unavailable';return;}
  let attempts=0,timer;
  const controlled=()=>{
    if(navigator.serviceWorker.controller?.state!=='activated')return false;
    $('offline-state').textContent='Available offline';clearInterval(timer);return true;
  };
  navigator.serviceWorker.addEventListener('controllerchange',controlled);
  // A repeated registration/update can remain pending across a quick reload.
  // Read the active registration independently so an installed cache is usable.
  const refresh=async()=>{
    if(controlled())return;
    try{
      const registration=await navigator.serviceWorker.getRegistration(new URL('./',location.href));
      if(registration?.active?.state==='activated'){$('offline-state').textContent='Available offline';clearInterval(timer);return;}
      if(++attempts>=30){clearInterval(timer);$('offline-state').textContent='Offline cache not ready. Reload to retry.';}
    }catch(error){clearInterval(timer);console.warn('Offline cache:',error.message);$('offline-state').textContent='Offline cache unavailable';}
  };
  timer=setInterval(refresh,1000);refresh();
  navigator.serviceWorker.register('sw.js').then(refresh).catch(error=>{console.warn('Offline cache:',error.message);refresh();});
}
offlineSetup();
await boot().catch(error=>toast(error.message,true));
if(machine.state==='running'){
  const draft=await load('editor-draft').catch(()=>null);if(draft){editorPath=draft.path;$('editor').value=draft.text;editorDirty=draft.dirty;editorOriginal=draft.original||'';updateEditor();}
  if(navigator.storage?.persisted)navigator.storage.persisted().then(persistent=>$('persist-state').textContent=persistent?'Persistent browser storage granted.':'Browser-managed storage. Keep exported backups.').catch(()=>{});
}

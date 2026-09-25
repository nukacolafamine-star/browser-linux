// SPDX-License-Identifier: GPL-2.0-only
// GitHub Pages cannot set our HTTP isolation headers. The same offline worker
// supplies them to the page and its workers after one controlled reload.
const status=document.getElementById('status');
const panel=document.getElementById('startup-panel');
const message=document.getElementById('startup-message');
const scope=new URL('./',location.href).href;
const reloadKey='browser-linux-isolation:'+scope;
const timeout=(promise,ms,label)=>{
  let timer;
  return Promise.race([promise,new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error(label)),ms))]).finally(()=>clearTimeout(timer));
};
function fail(error){
  panel.hidden=true;status.textContent='Linux could not start';
  document.getElementById('error-message').textContent=error.message;
  document.getElementById('error-banner').hidden=false;
  document.getElementById('export-saved').hidden=true;
  document.getElementById('retry').textContent='Try again';
  document.getElementById('retry').onclick=()=>{sessionStorage.removeItem(reloadKey);location.reload();};
}
async function start(){
  if(!isSecureContext)throw new Error('Open this site over HTTPS, or use the supplied local server. A downloaded HTML file cannot start Linux.');
  if(!crossOriginIsolated){
    if(!('serviceWorker' in navigator))throw new Error('This browser cannot prepare the shared memory Linux needs. Open this link in an up-to-date Safari, Chrome or Edge browser.');
    if(navigator.serviceWorker.controller&&sessionStorage.getItem(reloadKey))throw new Error('This browser did not enable shared memory after preparation. Close other tabs for this site, then try again in Safari, Chrome or Edge.');
    status.textContent='Preparing Linux';message.textContent='Downloading the first few megabytes. This page will reload once when ready.';
    await timeout(navigator.serviceWorker.register('sw.js',{scope:'./',updateViaCache:'none'}),90000,'Browser setup took too long. Check your connection and try again.');
    await timeout(new Promise(resolve=>{
      if(navigator.serviceWorker.controller){resolve();return;}
      navigator.serviceWorker.addEventListener('controllerchange',()=>resolve(),{once:true});
    }),90000,'The browser could not finish setup. Close other tabs for this site and try again.');
    sessionStorage.setItem(reloadKey,'1');location.reload();return;
  }
  sessionStorage.removeItem(reloadKey);
  if(typeof SharedArrayBuffer==='undefined')throw new Error('This browser does not expose the shared memory needed by this Linux build.');
  if(matchMedia('(max-width: 700px)').matches)document.getElementById('memory-choice').value='128';
  panel.hidden=true;
  await import('./app.js');
}
start().catch(fail);

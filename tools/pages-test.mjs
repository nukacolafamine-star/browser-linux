// SPDX-License-Identifier: GPL-2.0-only
// Exercise the actual static-host deployment path: no COOP/COEP server headers.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const publicRoot=path.join(root,'public');
const results=path.join(root,'test-results');
const temporary=path.join(root,'.cache','tmp');
await Promise.all([fs.mkdir(results,{recursive:true}),fs.mkdir(temporary,{recursive:true})]);
process.env.TEMP=temporary;process.env.TMP=temporary;
const prefix='/browser-linux/';
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css','.wasm':'application/wasm','.gz':'application/gzip','.svg':'image/svg+xml','.json':'application/json','.webmanifest':'application/manifest+json'};
const serverRequests=[];
const server=http.createServer(async(request,response)=>{
  const url=new URL(request.url,'http://localhost');serverRequests.push(url.pathname);
  response.setHeader('Cache-Control','no-cache');
  try{
    if(request.method!=='GET'&&request.method!=='HEAD'){response.writeHead(405).end();return;}
    if(!url.pathname.startsWith(prefix)){response.writeHead(404).end('Outside app prefix');return;}
    const relative=decodeURIComponent(url.pathname.slice(prefix.length))||'index.html';
    // GitHub Pages uses .nojekyll as a build marker, but does not serve it.
    if(relative.split(/[\\/]/).some(segment=>segment.startsWith('.'))){response.writeHead(404).end('Hidden files are not published');return;}
    const filename=await fs.realpath(path.resolve(publicRoot,relative));
    if(!filename.startsWith(publicRoot+path.sep)){response.writeHead(403).end();return;}
    const body=await fs.readFile(filename);
    response.setHeader('Content-Type',mime[path.extname(filename)]||'application/octet-stream');
    response.setHeader('Content-Length',body.length);response.writeHead(200);
    response.end(request.method==='HEAD'?undefined:body);
  }catch{response.writeHead(404).end('Not found');}
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
const origin=`http://127.0.0.1:${server.address().port}`;
const url=origin+prefix;
const report={url,startedAt:new Date().toISOString(),assetVersion:JSON.parse(await fs.readFile(path.join(publicRoot,'asset-manifest.json'),'utf8')).version,checks:[],errors:[],navigations:[]};
const record=(name,detail)=>{report.checks.push({name,passed:true,...(detail===undefined?{}:{detail})});console.log('PASS',name,detail===undefined?'':JSON.stringify(detail));};
let browser,page,context;
const waitForBoot=async()=>{
  await page.waitForFunction(()=>window.machine?.state==='running'||window.machine?.state==='error'||(document.querySelector('#error-banner:not([hidden])')&&document.querySelector('#error-message')?.textContent),null,{timeout:75000,polling:100});
  const state=await page.evaluate(()=>({state:window.machine?.state,error:document.querySelector('#error-message')?.textContent,output:window.machine?.output?.slice(-2000)}));
  assert.equal(state.state,'running',`Linux failed to boot: ${JSON.stringify(state)}`);
  assert.match(state.output,/root@browser-linux:~#/,'The real guest shell did not become ready');
};
try{
  const initialResponse=await fetch(url);
  assert.equal(initialResponse.status,200);
  assert.equal(initialResponse.headers.get('cross-origin-opener-policy'),null);
  assert.equal(initialResponse.headers.get('cross-origin-embedder-policy'),null);
  record('test server provides no isolation headers');
  assert.equal((await fetch(url+'.nojekyll')).status,404);
  assert.equal((await fetch(url+'assets/.hidden/example.js')).status,404);
  const manifest=JSON.parse(await fs.readFile(path.join(publicRoot,'asset-manifest.json'),'utf8'));
  const serviceWorker=await fs.readFile(path.join(publicRoot,'sw.js'),'utf8');
  const assetDeclaration=serviceWorker.match(/^const ASSETS=(\[.*\]);$/m);
  assert.ok(assetDeclaration,'Generated service worker must declare its precache assets');
  const precache=JSON.parse(assetDeclaration[1]);
  const hiddenAsset=asset=>decodeURIComponent(new URL(asset,url).pathname).split('/').some(segment=>segment.startsWith('.'));
  assert.deepEqual(Object.keys(manifest.assets).filter(hiddenAsset),[],'Build manifest includes a dotfile that GitHub Pages will not serve');
  assert.deepEqual(precache.filter(hiddenAsset),[],'Offline precache includes a dotfile that would abort service-worker installation on GitHub Pages');
  record('Pages-style hidden-file 404s cannot break app manifest or offline precache');
  browser=await chromium.launch({channel:'chrome',headless:true});report.browser=browser.version();
  context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:1});
  page=await context.newPage();
  page.on('pageerror',error=>{report.errors.push(error.message);console.error('BROWSER ERROR',error.message);});
  page.on('framenavigated',frame=>{if(frame===page.mainFrame())report.navigations.push(frame.url());});
  await page.goto(url);await waitForBoot();
  const boot=await page.evaluate(()=>({isolated:crossOriginIsolated,shared:typeof SharedArrayBuffer!=='undefined',controller:navigator.serviceWorker.controller?.scriptURL,bootMs:machine.bootMs,memoryBytes:machine.os.stats().memoryBytes}));
  assert.equal(boot.isolated,true);assert.equal(boot.shared,true);assert.equal(boot.controller,url+'sw.js');
  assert.equal(report.navigations.filter(address=>address===url).length,2,'First visit should need exactly one automatic isolation reload');
  const info=await page.evaluate(()=>machine.rpc('info'));assert.match(info.uname,/Linux version 6\.4/);
  record('first visit registers worker, reloads once, and boots genuine Linux',boot);
  for(const resource of ['assets/vmlinux.wasm','runtime/linux-worker.js'])assert.ok(serverRequests.includes(prefix+resource),`Missing prefixed request: ${resource}`);
  assert.equal(serverRequests.filter(resource=>!resource.startsWith(prefix)&&resource!=='/favicon.ico').length,0,'App requested a resource outside its repository path');
  const headers=await page.evaluate(async()=>{
    const result={};for(const file of ['index.html','runtime/linux-worker.js','assets/vmlinux.wasm']){
      const response=await fetch(file);result[file]={status:response.status,coop:response.headers.get('cross-origin-opener-policy'),coep:response.headers.get('cross-origin-embedder-policy'),type:response.headers.get('content-type')};
    }return result;
  });
  for(const resource of Object.values(headers)){assert.equal(resource.status,200);assert.equal(resource.coop,'same-origin');assert.equal(resource.coep,'require-corp');}
  assert.equal(headers['assets/vmlinux.wasm'].type,'application/wasm');
  record('prefixed cached documents, workers and Wasm receive isolation headers',headers);
  const contents='Saved from the phone layout into genuine Linux.\n';
  await page.locator('[data-view="files"]').click();await page.locator('#new-file').click();
  await page.locator('#prompt-input').fill('pages-phone.txt');await page.locator('#prompt-confirm').click();
  await page.waitForFunction(()=>document.querySelector('#editor-path').textContent==='/home/web/pages-phone.txt',null,{polling:100});
  await page.locator('#editor').fill(contents);await page.locator('#save-file').click();
  await page.waitForFunction(()=>document.querySelector('#toast').textContent==='File saved to Linux and browser storage',null,{polling:100});
  assert.equal(await page.evaluate(async()=>new TextDecoder().decode(await machine.rpc('read',{path:'/home/web/pages-phone.txt'}))),contents);
  await page.reload();await waitForBoot();
  assert.equal(await page.evaluate(async()=>new TextDecoder().decode(await machine.rpc('read',{path:'/home/web/pages-phone.txt'}))),contents);
  record('phone editor writes to Linux and saved file survives document reload');
  await page.waitForFunction(()=>document.querySelector('#offline-state').textContent==='Available offline',null,{timeout:30000,polling:100});
  await context.setOffline(true);await page.reload();await waitForBoot();
  assert.equal(await page.evaluate(()=>crossOriginIsolated),true);
  assert.equal(await page.evaluate(async()=>new TextDecoder().decode(await machine.rpc('read',{path:'/home/web/pages-phone.txt'}))),contents);
  record('offline reload retains isolation, boots Linux and restores exact saved file');
  await page.locator('[data-view="files"]').click();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:path.join(results,'pages-phone.png')});
  record('390px touch viewport has no horizontal document overflow');
  assert.deepEqual(report.errors,[]);record('no uncaught browser errors');
  report.passed=true;
}catch(error){
  report.passed=false;report.failure=error.message;
  if(page)report.diagnostics=await page.evaluate(async()=>({state:window.machine?.state,error:document.querySelector('#error-message')?.textContent,isolated:crossOriginIsolated,controller:navigator.serviceWorker.controller?.scriptURL,output:window.machine?.output?.slice(-4000),logs:window.machine?.logs?.slice(-20),registrations:(await navigator.serviceWorker.getRegistrations()).map(registration=>({scope:registration.scope,active:registration.active?.state,installing:registration.installing?.state,waiting:registration.waiting?.state})),caches:await caches.keys()})).catch(()=>null);
  console.error('FAIL',error.message);process.exitCode=1;
}finally{
  report.finishedAt=new Date().toISOString();report.serverRequests=serverRequests;
  await fs.writeFile(path.join(results,'pages-report.json'),JSON.stringify(report,null,2)+'\n');
  await browser?.close();
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}

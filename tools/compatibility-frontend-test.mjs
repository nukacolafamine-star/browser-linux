// SPDX-License-Identifier: GPL-2.0-only
// Negative frontend tests only. Tiny fixtures NEVER claim a Linux boot.
// Real kernel/desktop acceptance is exclusively compatibility-test.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const temporary=path.join(root,'.cache','tmp'),results=path.join(root,'test-results');
await Promise.all([fs.mkdir(temporary,{recursive:true}),fs.mkdir(results,{recursive:true})]);
process.env.TEMP=temporary;process.env.TMP=temporary;
// Portable Windows WebKit writes auxiliary caches relative to its process cwd,
// including when userDataDir is explicit. Keep those test files in the project.
const browserWorkingDirectory=await fs.mkdtemp(path.join(temporary,'frontend-browser-'));
process.chdir(browserWorkingDirectory);
const portable=path.join(root,'.cache','playwright-browsers');
if(!process.env.PLAYWRIGHT_BROWSERS_PATH&&await fs.stat(portable).then(()=>true,()=>false))process.env.PLAYWRIGHT_BROWSERS_PATH=portable;
const {chromium,webkit}=await import('playwright');
const selection=process.env.COMPATIBILITY_ENGINE||'both';
assert.ok(['both','chrome','webkit'].includes(selection));
const prefix='builds/0123456789abcdef/';
const payloads=new Map([
  [`${prefix}runtime/failing-runtime.js`,Buffer.from(`export default async function(){
    new Worker(new URL('./compatibility/builds/0123456789abcdef/runtime/idle-worker.js',location.href));
    await new Promise(resolve=>setTimeout(resolve,30));
    throw new Error('INTENTIONAL_PARTIAL_INIT_FAILURE');
  }`)],
  [`${prefix}runtime/pty-fixture.js`,Buffer.from(`export function openpty(){return {
    master:{activate(){},dispose(){},onWrite(){return {dispose(){}};}},
    slave:{readable:false,writable:true}
  };}`)],
  [`${prefix}runtime/runtime.wasm`,Buffer.from([0,97,115,109,1,0,0,0])],
  [`${prefix}pack/kernel`,Buffer.from('not a kernel')],
  [`${prefix}pack/initrd`,Buffer.from('not an initrd')],
  [`${prefix}pack/disk`,Buffer.from('not a disk')],
]);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const roles=[['script'],['pty'],['wasm'],['kernel','/pack/vmlinuz-virt'],['initrd','/pack/initramfs-virt'],['disk','/pack/rootfs.img']];
const baseManifest={schema:1,architecture:'x86_64',build:'0123456789abcdef',engineMemoryMiB:1,
  files:[...payloads].map(([name,bytes],index)=>({name,bytes:bytes.length,sha256:hash(bytes),role:roles[index][0],...(roles[index][1]?{guestPath:roles[index][1]}:{})}))};
const fixtures=new Map();
function fixture(name,mutate,expected){const manifest=structuredClone(baseManifest);mutate(manifest);fixtures.set(name,{manifest,expected,payloadRequests:[]});}
fixture('duplicate-guest-path',m=>m.files.push({...m.files[5],name:prefix+'pack/duplicate',role:'rom'}),/duplicate guest file path/);
fixture('duplicate-file-name',m=>m.files.push({...m.files[0],role:'worker'}),/one versioned build/);
fixture('duplicate-kernel-role',m=>m.files.push({...m.files[3],name:prefix+'pack/second-kernel',guestPath:'/pack/second-kernel'}),/manifest: kernel/);
fixture('wrong-disk-path',m=>m.files[5].guestPath='/pack/wrong.img',/Incorrect guest path for disk/);
fixture('mixed-build',m=>m.files[0].name=m.files[0].name.replace('0123456789abcdef','fedcba9876543210'),/one versioned build/);
fixture('path-traversal',m=>m.files[0].name=prefix+'../outside.js',/Invalid image file path/);
fixture('missing-kernel',m=>m.files=m.files.filter(file=>file.role!=='kernel'),/manifest: kernel/);
fixture('partial-init-failure',()=>{},/INTENTIONAL_PARTIAL_INIT_FAILURE/);
fixture('cached-runtime-origin-unavailable',()=>{},/INTENTIONAL_PARTIAL_INIT_FAILURE/);
fixtures.get('cached-runtime-origin-unavailable').cacheOnly=true;

const staticNames=['compatibility-session.html','compatibility-session.js','compatibility-storage.js','compatibility-images.js','compatibility-exchange.js','compatibility-input.js','capabilities.js','capability-worker.js',
  'assets/xterm.js','assets/addon-fit.js','assets/xterm.css','style.css','compatibility.css'];
const staticFiles=new Map(await Promise.all(staticNames.map(async name=>[name,await fs.readFile(path.join(root,'public',name))])));
const server=http.createServer((request,response)=>{
  const segments=new URL(request.url,'http://local.test').pathname.slice(1).split('/');
  const current=fixtures.get(segments.shift()),name=segments.join('/');
  const headers={'Cache-Control':'no-store','Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'};
  if(!current){response.writeHead(404,headers);response.end();return;}
  if(name==='setup'){response.writeHead(200,{...headers,'Content-Type':'text/html'});response.end('<!doctype html><title>Storage setup</title>');return;}
  if(name==='compatibility/manifest.json'){
    response.writeHead(200,{...headers,'Content-Type':'application/json'});response.end(JSON.stringify(current.manifest));return;
  }
  let body=staticFiles.get(name);
  if(name.startsWith('compatibility/builds/')){
    current.payloadRequests.push(name);
    body=name.endsWith('/idle-worker.js')?Buffer.from('self.onmessage=()=>{};'):(current.cacheOnly?undefined:payloads.get(name.slice('compatibility/'.length)));
  }
  if(!body){response.writeHead(404,headers);response.end();return;}
  const contentType=name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.wasm')?'application/wasm':name.endsWith('.html')?'text/html':'application/octet-stream';
  response.writeHead(200,{...headers,'Content-Type':contentType});response.end(body);
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
const base=`http://127.0.0.1:${server.address().port}`;
const report={startedAt:new Date().toISOString(),browserWorkingDirectory,scope:'Frontend rejection and worker cleanup only; no real or simulated successful kernel boot',engines:[]};
let browser;
try{
  for(const [engine,type,options] of [['chrome',chromium,{channel:'chrome'}],['webkit',webkit,{}]]){
    if(selection!=='both'&&selection!==engine)continue;
    browser=await type.launch({headless:true,...options});
    const result={engine,version:browser.version(),cases:[]};report.engines.push(result);
    for(const [name,current] of fixtures){
      current.payloadRequests=[];
      // Portable Windows WebKit's ephemeral context loses CacheStorage bodies
      // when the writer document navigates, even in a minimal app-free repro.
      // A project-local persistent profile retains them across browser restart.
      // Keep every cache/import/worker assertion; this changes only the harness
      // storage lifetime, never production capability selection.
      const persistentProfile=engine==='webkit'&&current.cacheOnly
        ?await fs.mkdtemp(path.join(temporary,'webkit-cache-navigation-')):null;
      const context=persistentProfile
        ?await type.launchPersistentContext(persistentProfile,{headless:true,...options,serviceWorkers:'allow'})
        :await browser.newContext({serviceWorkers:current.cacheOnly?'allow':'block'});
      try{
        await context.addInitScript(()=>{
          const NativeWorker=window.Worker;
          window.frontendWorkers={created:0,terminated:0,active:[]};
          window.Worker=class extends NativeWorker{
            constructor(...args){
              super(...args);this.testId=++window.frontendWorkers.created;
              window.frontendWorkers.active.push(this.testId);
            }
            terminate(){
              window.frontendWorkers.terminated++;
              window.frontendWorkers.active=window.frontendWorkers.active.filter(id=>id!==this.testId);
              return super.terminate();
            }
          };
        });
        const page=await context.newPage(),errors=[];
        page.on('pageerror',error=>errors.push(error.message));
        if(current.cacheOnly){
          await page.goto(`${base}/${name}/setup`,{waitUntil:'domcontentloaded'});
          current.cacheBefore=await page.evaluate(async entries=>{
            const scope=new URL('./',location.href).href;
            const cache=await caches.open('browser-linux-image-v1:'+scope);
            for(const [name,values] of entries)await cache.put(new URL('compatibility/'+name,scope),new Response(new Uint8Array(values)));
            return {scope,names:await caches.keys(),keys:(await cache.keys()).map(request=>request.url)};
          },[...payloads].map(([name,bytes])=>[name,[...bytes]]));
        }
        await page.goto(`${base}/${name}/compatibility-session.html`,{waitUntil:'domcontentloaded'});
        await page.waitForFunction(()=>window.guestReport?.state==='error',null,{timeout:12000});
        const outcome=await page.evaluate(()=>({report:window.guestReport,workers:window.frontendWorkers}));
        const entry={name,...outcome,payloadRequests:[...current.payloadRequests],errors};result.cases.push(entry);
        if(current.cacheOnly){
          entry.persistentProfile=persistentProfile;
          entry.cacheBefore=current.cacheBefore;
          entry.cacheAfter=await page.evaluate(async()=>({scope:new URL('./',location.href).href,names:await caches.keys(),keys:(await (await caches.open('browser-linux-image-v1:'+new URL('./',location.href).href)).keys()).map(request=>request.url)}));
        }
        assert.match(outcome.report.message,current.expected);
        assert.equal(outcome.report.wayland,false);
        assert.doesNotMatch(outcome.report.serial,/BROWSER_LINUX_(?:GUEST_BOOT|SERIAL_READY|WAYLAND_CLIENT_STARTED)/);
        assert.deepEqual(outcome.workers.active,[],'A failed session retained a dedicated worker');
        assert.deepEqual(errors,[]);
        if(name==='partial-init-failure'||current.cacheOnly){
          assert.equal(outcome.workers.created,2,'Expected one real capability worker and one failing-module worker');
          assert.equal(outcome.workers.terminated,2);
          assert.ok(current.payloadRequests.some(url=>url.endsWith('/idle-worker.js')));
          if(current.cacheOnly)assert.deepEqual(current.payloadRequests,[`compatibility/${prefix}runtime/idle-worker.js`],'The verified cached module was fetched again from its removed origin URL');
        }else{
          assert.deepEqual(current.payloadRequests,[],'Malformed metadata triggered a runtime payload download');
          assert.equal(outcome.workers.created,1);
          assert.equal(outcome.workers.terminated,1);
        }
        entry.passed=true;console.log('PASS',engine,name);
      }finally{await context.close();}
    }
    await browser.close();browser=undefined;
  }
  report.passed=true;
}catch(error){report.passed=false;report.failure=error.stack;process.exitCode=1;console.error(error);}
finally{
  report.finishedAt=new Date().toISOString();await browser?.close();
  await new Promise(resolve=>server.close(resolve));
  await fs.writeFile(path.join(results,'compatibility-frontend-report.json'),JSON.stringify(report,null,2)+'\n');
}

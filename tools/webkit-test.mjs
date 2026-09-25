// SPDX-License-Identifier: GPL-2.0-only
// WebKit engine check; Windows WebKit is not a substitute for physical iOS Safari.
// WEBKIT_SMOKE=1 checks online files/shell/reloads. WEBKIT_OFFLINE=1 additionally
// opts into the separate offline navigation check; skipped checks stay explicit.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';

const root=fileURLToPath(new URL('../',import.meta.url));
const temporary=path.join(root,'.cache','tmp');
await fs.mkdir(temporary,{recursive:true});
await fs.mkdir(path.join(root,'test-results'),{recursive:true});
process.env.TEMP=temporary;process.env.TMP=temporary;
process.env.PLAYWRIGHT_BROWSERS_PATH=path.join(root,'.cache','playwright-browsers');
const {webkit}=await import('playwright');
const target=process.argv[2]||'https://nukacolafamine-star.github.io/browser-linux/';
const variant=process.env.WEBKIT_CMDLINE;
const report={target,variant,kernel:process.env.WEBKIT_KERNEL,wallClock:!!process.env.WEBKIT_WALLCLOCK,offline:{requested:!!process.env.WEBKIT_OFFLINE,status:'not tested'},startedAt:new Date().toISOString(),engine:'Playwright WebKit on Windows, not physical iOS Safari',console:[],errors:[],failures:[],navigations:[]};
let browser,page;
try{
 browser=await webkit.launch({headless:true});report.browser=browser.version();
 const context=await browser.newContext({viewport:{width:430,height:932},isMobile:true,hasTouch:true,deviceScaleFactor:1,ignoreHTTPSErrors:true,...(variant?{serviceWorkers:'block'}:{})});
 if(variant){
  if(process.env.WEBKIT_KERNEL)await context.route('**/assets/vmlinux.wasm',async route=>route.fulfill({status:200,contentType:'application/wasm',body:await fs.readFile(process.env.WEBKIT_KERNEL),headers:{'Cross-Origin-Resource-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'}}));
  await context.route('**/machine.js',async route=>{
   let source=await fs.readFile(path.join(root,'public','machine.js'),'utf8');
   source=source.replace(/maxcpus=3 nohz_full=(?:0,)?2-63 rcu_nocbs=(?:0,)?2-63/,variant).replace(/,45000\)/g,',12000)');
   await route.fulfill({status:200,contentType:'text/javascript',body:source,headers:{'Cross-Origin-Resource-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'}});
  });
  if(process.env.WEBKIT_WALLCLOCK||process.env.WEBKIT_HOSTTRACE||process.env.WEBKIT_FUNCTIONTRACE)await context.route('**/runtime/linux-worker.js',async route=>{
   let source=await fs.readFile(path.join(root,'public','runtime','linux-worker.js'),'utf8');
   if(process.env.WEBKIT_FUNCTIONTRACE){
    source=source.replace('let port = self;', 'let port = self; const functionTrace=new Int32Array(new SharedArrayBuffer(1025*4));');
    source=source.replace('runner_name = message.runner_name;', "runner_name = message.runner_name; port.postMessage({method:'log',message:'TRACE BUFFER',functionTrace,runner_name});");
    source=source.replace('wasm_driver_hvc_put: (buffer, count) => {', 'wasm_driver_hvc_put: (buffer, count) => { if(count===-1){const old=Atomics.add(functionTrace,0,1);Atomics.store(functionTrace,1+(old%1024),buffer);return 0;}');
   }
   if(process.env.WEBKIT_WALLCLOCK)source=source.replace('BigInt(Math.round(1000 * (performance.timeOrigin + performance.now()))) * 1000n','BigInt(Date.now()) * 1000000n');
   if(process.env.WEBKIT_HOSTTRACE){
    source=source.replace('const host_callbacks = {','const traceCounts={}; const host_callbacks = {');
    source=source.replace('...host_callbacks,',`...Object.fromEntries(Object.entries(host_callbacks).map(([name,fn])=>[name,(...args)=>{
     const count=traceCounts[name]=(traceCounts[name]||0)+1;
     const trace=name!=='wasm_driver_hvc_put'&&(name!=='wasm_cpu_clock_get_monotonic'||count<=3||count%100000===0);
     if(trace)port.postMessage({method:'log',message:'TRACE '+runner_name+' '+name+' enter '+count+' '+args.map(String).join(',')});
     const result=fn(...args);
     if(trace)port.postMessage({method:'log',message:'TRACE '+runner_name+' '+name+' returned '+String(result)});
     return result;
    }])),`);
   }
   await route.fulfill({status:200,contentType:'text/javascript',body:source,headers:{'Cross-Origin-Resource-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'}});
  });
 }
 await context.addInitScript(()=>{
  const NativeWorker=window.Worker;window.workerTrace=[];window.functionTraces={};
  window.Worker=class extends NativeWorker{
   constructor(url,options){super(url,options);const name=options?.name||url;window.workerTrace.push({at:performance.now(),name,event:'created'});this.addEventListener('message',event=>{if(event.data?.functionTrace)window.functionTraces[name]=event.data.functionTrace;window.workerTrace.push({at:performance.now(),name,event:event.data?.method,phase:event.data?.phase,prev:event.data?.prev_task,next:event.data?.next_task,message:event.data?.message?.slice(0,500)});});this.addEventListener('error',event=>window.workerTrace.push({at:performance.now(),name,event:'error',message:event.message}));}
  };
 });
 page=await context.newPage();
 page.on('console',message=>{const entry={type:message.type(),text:message.text()};report.console.push(entry);console.log(entry.type,entry.text.slice(0,1500));});
 page.on('pageerror',error=>{report.errors.push(error.message);console.log('ERROR',error.message);});
 page.on('requestfailed',request=>{report.failures.push({url:request.url(),error:request.failure()});console.log('FAILED',request.url(),request.failure());});
 page.on('framenavigated',frame=>{if(frame===page.mainFrame())report.navigations.push(frame.url());});
 await page.goto(target,{waitUntil:'domcontentloaded',timeout:45000});
 await page.waitForFunction(()=>window.machine?.state==='running'||window.machine?.state==='error'||(document.querySelector('#error-banner:not([hidden])')&&document.querySelector('#error-message')?.textContent),null,{timeout:75000,polling:100});
 report.diagnostics=await page.evaluate(async()=>({state:window.machine?.state,error:document.querySelector('#error-message')?.textContent,output:window.machine?.output,logs:window.machine?.logs,details:window.machine?.diagnostics?.(),workerTrace:window.workerTrace,isolated:crossOriginIsolated,shared:typeof SharedArrayBuffer,agent:navigator.userAgent,memory:window.machine?.os?.stats(),controller:navigator.serviceWorker.controller?.scriptURL,registrations:(await navigator.serviceWorker.getRegistrations()).map(r=>({scope:r.scope,active:r.active?.state})),caches:await caches.keys()}));
 if(process.env.WEBKIT_FUNCTIONTRACE)report.functionTraces=await page.evaluate(()=>Object.fromEntries(Object.entries(window.functionTraces).map(([name,trace])=>{const count=Atomics.load(trace,0);return[name,{count,functions:Array.from({length:Math.min(count,1024)},(_,i)=>Atomics.load(trace,1+((Math.max(0,count-1024)+i)%1024)))}];})));
 report.passed=report.diagnostics.state==='running';
 if(!report.passed)process.exitCode=1;
 if(report.passed){
  report.info=await page.evaluate(()=>machine.rpc('info'));
  report.loadedKernelSha256=await page.evaluate(async()=>{const bytes=await(await fetch('assets/vmlinux.wasm')).arrayBuffer();return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');});
 }
 if(report.passed&&(process.env.WEBKIT_SMOKE||process.env.WEBKIT_OFFLINE)){
  report.checks=[];report.boots=[await page.evaluate(()=>machine.bootMs)];
  const binary=Array.from({length:150000},(_,i)=>(i*17+31)%256);
  await page.evaluate(async bytes=>{await machine.write('/home/web/webkit-binary.bin',bytes);await machine.write('/home/web/webkit-shell.txt','WEBKIT_REAL_LINUX_FILE_OK\n');await machine.save();},binary);
  assert.deepEqual(Array.from(await page.evaluate(()=>machine.rpc('read',{path:'/home/web/webkit-binary.bin'}))),binary);
  report.checks.push('150000-byte patterned file write/read verified and saved');
  await page.evaluate(()=>machine.os.key_input('cat /home/web/webkit-shell.txt\n'));
  await page.waitForFunction(()=>machine.output.includes('WEBKIT_REAL_LINUX_FILE_OK'),null,{timeout:10000,polling:100});
  report.checks.push('Real Linux cat command reads file created through desktop bridge');
  await page.evaluate(()=>{window.commandStart=machine.output.length;machine.os.key_input("printf 'WEBKIT_%s_%s\\n' SHELL OK; uname -r\n");});
  await page.waitForFunction(()=>machine.output.slice(window.commandStart).includes('WEBKIT_SHELL_OK')&&machine.output.slice(window.commandStart).includes('6.4.16-00012-gf3e782cb608b'),null,{timeout:10000,polling:100});
  report.checks.push('Real shell printf and uname commands completed');
  for(let i=0;i<5;i++){
   await page.reload({waitUntil:'domcontentloaded'});
   await page.waitForFunction(()=>window.machine?.state==='running'||window.machine?.state==='error',null,{timeout:30000,polling:100});
   assert.equal(await page.evaluate(()=>machine.state),'running');
   assert.deepEqual(Array.from(await page.evaluate(()=>machine.rpc('read',{path:'/home/web/webkit-binary.bin'}))),binary);
   report.boots.push(await page.evaluate(()=>machine.bootMs));
  }
  report.checks.push('Five document reloads booted and restored all binary bytes exactly');
  if(process.env.WEBKIT_OFFLINE&&!variant){
   report.offline.status='running';
   await page.waitForFunction(()=>document.querySelector('#offline-state')?.textContent==='Available offline',null,{timeout:30000,polling:100});
   await context.setOffline(true);
   await page.reload({waitUntil:'domcontentloaded'});
   await page.waitForFunction(()=>window.machine?.state==='running'||window.machine?.state==='error',null,{timeout:30000,polling:100});
   assert.equal(await page.evaluate(()=>machine.state),'running');
   assert.equal(await page.evaluate(()=>crossOriginIsolated),true);
   assert.deepEqual(Array.from(await page.evaluate(()=>machine.rpc('read',{path:'/home/web/webkit-binary.bin'}))),binary);
   report.boots.push(await page.evaluate(()=>machine.bootMs));
   report.checks.push('Offline document reload retained isolation, booted Linux and restored all binary bytes exactly');
   report.offline.status='passed';
   await context.setOffline(false);
  }
  if(process.env.WEBKIT_OFFLINE&&variant)report.offline.reason='Diagnostic routing disables service workers';
  assert.deepEqual(report.errors,[]);report.checks.push('No uncaught browser errors');
  console.log('SMOKE PASS',JSON.stringify({checks:report.checks,boots:report.boots,offline:report.offline}));
 }
 console.log('RESULT',JSON.stringify({state:report.diagnostics.state,error:report.diagnostics.error,outputTail:report.diagnostics.output?.slice(-1000),logs:report.diagnostics.logs?.slice(-10),details:report.diagnostics.details?{...report.diagnostics.details,bootOutput:undefined,logs:undefined,runtime:{...report.diagnostics.details.runtime,workerStates:undefined}}:undefined,workerTrace:report.diagnostics.workerTrace?.slice(-5)},null,2));
 await page.screenshot({path:path.join(root,'test-results','webkit.png')});
}catch(error){
 report.passed=false;report.failure=error.stack;
 if(report.offline.status==='running'){report.offline.status='failed';report.offline.error=error.message;}
 if(page){
  report.failureDiagnostics=await page.evaluate(()=>({state:window.machine?.state,error:document.querySelector('#error-message')?.textContent,details:window.machine?.diagnostics?.(),workerTrace:window.workerTrace})).catch(()=>null);
  if(process.env.WEBKIT_FUNCTIONTRACE)report.functionTraces=await page.evaluate(()=>Object.fromEntries(Object.entries(window.functionTraces).map(([name,trace])=>{const count=Atomics.load(trace,0);return[name,{count,functions:Array.from({length:Math.min(count,1024)},(_,i)=>Atomics.load(trace,1+((Math.max(0,count-1024)+i)%1024)))}];}))).catch(()=>null);
 }
 console.error(error);process.exitCode=1;
}
finally{report.finishedAt=new Date().toISOString();await fs.writeFile(path.join(root,'test-results','webkit-report.json'),JSON.stringify(report,null,2)+'\n');await browser?.close();}

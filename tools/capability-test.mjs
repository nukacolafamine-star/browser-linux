// SPDX-License-Identifier: GPL-2.0-only
// Real browser probes against the shipped modules; no Linux boot or app server.
// Uses already installed browsers only. Portable WebKit is not physical iOS.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const temporary=path.join(root,'.cache','tmp'),results=path.join(root,'test-results');
await Promise.all([fs.mkdir(temporary,{recursive:true}),fs.mkdir(results,{recursive:true})]);
process.env.TEMP=temporary;process.env.TMP=temporary;
const portable=path.join(root,'.cache','playwright-browsers');
if(!process.env.PLAYWRIGHT_BROWSERS_PATH&&await fs.stat(portable).then(()=>true,()=>false))process.env.PLAYWRIGHT_BROWSERS_PATH=portable;
const {chromium,webkit}=await import('playwright');
const engine=process.argv.find(argument=>argument.startsWith('--engine='))?.slice(9)||'both';
assert.ok(['both','chrome','webkit'].includes(engine),'Use --engine=both, --engine=chrome, or --engine=webkit');

const [capabilities,worker]=await Promise.all(['capabilities.js','capability-worker.js'].map(file=>fs.readFile(path.join(root,'public',file),'utf8')));
const fixtures={
  null:'self.onmessage=()=>self.postMessage(null);',
  malformed:'self.onmessage=({data})=>{Atomics.add(new Int32Array(data.memory.buffer),0,1);self.postMessage({ok:"yes"});};',
  forged:'self.onmessage=()=>self.postMessage({ok:true});',
};
const server=http.createServer((request,response)=>{
  const [test,file]=new URL(request.url,'http://local.test').pathname.slice(1).split('/');
  const headers={'Cache-Control':'no-store'};
  if(test!=='not-isolated')Object.assign(headers,{'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'});
  if(file==='capabilities.js'){
    response.writeHead(200,{...headers,'Content-Type':'text/javascript'});response.end(capabilities);
  }else if(file==='capability-worker.js'){
    response.writeHead(test==='missing'?404:200,{...headers,'Content-Type':'text/javascript'});
    response.end(test==='missing'?'Missing worker':fixtures[test]??worker);
  }else{
    response.writeHead(200,{...headers,'Content-Type':'text/html'});
    response.end('<!doctype html><title>Capability probe regression</title>');
  }
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
const base=`http://127.0.0.1:${server.address().port}`;
const report={startedAt:new Date().toISOString(),engines:[]};
let browser;
try{
  for(const [name,type,options] of [['chrome',chromium,{channel:'chrome'}],['webkit',webkit,{}]]){
    if(engine!=='both'&&engine!==name)continue;
    browser=await type.launch({headless:true,...options});
    const result={name,version:browser.version(),cases:[]};report.engines.push(result);
    for(const test of ['working','missing','null','malformed','forged','no-shared-memory','not-isolated']){
      const context=await browser.newContext({serviceWorkers:'block'});
      try{
        await context.addInitScript(({disableSharedMemory})=>{
          window.probeWorkers={created:0,terminated:0};
          const NativeWorker=window.Worker;
          window.Worker=class extends NativeWorker{
            constructor(...args){super(...args);window.probeWorkers.created++;}
            terminate(){window.probeWorkers.terminated++;return super.terminate();}
          };
          if(disableSharedMemory)Object.defineProperty(window,'SharedArrayBuffer',{value:undefined,configurable:true});
        },{disableSharedMemory:test==='no-shared-memory'});
        const page=await context.newPage(),errors=[];
        page.on('pageerror',error=>errors.push(error.message));
        await page.goto(`${base}/${test}/`);
        const started=Date.now();
        const outcome=await page.evaluate(async({graphics})=>{
          const {detectCapabilities,missingRequirements}=await import('./capabilities.js');
          let timer;
          try{
            const report=await Promise.race([
              detectCapabilities({graphics}),
              new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Capability test exceeded 16 seconds')),16000);}),
            ]);
            return {report,missing:missingRequirements(report),workers:window.probeWorkers};
          }finally{clearTimeout(timer);}
        },{graphics:test==='working'});
        const entry={test,elapsedMs:Date.now()-started,...outcome,errors};result.cases.push(entry);
        assert.deepEqual(errors,[],`${name}/${test}: unexpected uncaught browser error`);
        assert.equal(outcome.report.secureContext,true);
        assert.equal(outcome.report.graphics.guestAcceleration,false,'Browser graphics exposure must never claim guest acceleration');
        if(test==='working'){
          assert.equal(outcome.report.compatibilityEngine,true);
          assert.equal(outcome.report.workers.available,true);
          assert.deepEqual(outcome.missing,[]);
          assert.equal(outcome.report.graphics.checked,true);
          assert.equal(typeof outcome.report.graphics.webgl2,'boolean');
          assert.equal(typeof outcome.report.graphics.webgpu,'boolean');
          assert.deepEqual(outcome.workers,{created:1,terminated:1});
          assert.match(outcome.report.memoryBudget,/Unknown/);
        }else{
          assert.equal(outcome.report.compatibilityEngine,false,`${name}/${test}: failed probe must not select the compatibility engine`);
          assert.equal(outcome.report.graphics.checked,false);
          if(test==='no-shared-memory'){
            assert.equal(outcome.report.sharedMemory,false);
            assert.ok(outcome.missing.includes('shared memory'));
            assert.deepEqual(outcome.workers,{created:0,terminated:0});
          }else if(test==='not-isolated'){
            assert.equal(outcome.report.isolated,false);
            assert.ok(outcome.missing.includes('browser isolation'));
          }else{
            assert.equal(outcome.report.workers.available,false);
            assert.ok(outcome.report.workers.detail.length>0);
            assert.ok(outcome.missing.includes('working WebAssembly workers'));
            assert.deepEqual(outcome.workers,{created:1,terminated:1});
          }
        }
        entry.passed=true;console.log('PASS',name,test,`${entry.elapsedMs} ms`);
      }finally{await context.close();}
    }
    await browser.close();browser=undefined;
  }
  report.passed=true;
}catch(error){report.passed=false;report.failure=error.stack;process.exitCode=1;console.error(error);}
finally{
  report.finishedAt=new Date().toISOString();
  await browser?.close();
  await new Promise(resolve=>server.close(resolve));
  await fs.writeFile(path.join(results,'capability-report.json'),JSON.stringify(report,null,2)+'\n');
}

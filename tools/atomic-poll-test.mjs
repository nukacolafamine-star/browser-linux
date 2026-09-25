// SPDX-License-Identifier: GPL-2.0-only
// Standalone regression probe: no Linux boot or running app server required.
// Install Playwright WebKit first; --engine=chrome or --engine=webkit narrows it.
// Windows WebKit is not a substitute for testing physical iOS Safari.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import wabtFactory from 'wabt';

const root=fileURLToPath(new URL('../',import.meta.url));
const temporary=path.join(root,'.cache','tmp'),results=path.join(root,'test-results');
await Promise.all([fs.mkdir(temporary,{recursive:true}),fs.mkdir(results,{recursive:true})]);
process.env.TEMP=temporary;process.env.TMP=temporary;
if(!process.env.PLAYWRIGHT_BROWSERS_PATH&&await fs.stat(path.join(root,'.cache','playwright-browsers')).then(()=>true,()=>false))process.env.PLAYWRIGHT_BROWSERS_PATH=path.join(root,'.cache','playwright-browsers');
const {webkit,chromium}=await import('playwright');
const engine=process.argv.find(argument=>argument.startsWith('--engine='))?.slice(9)||'both';
assert.ok(['both','webkit','chrome'].includes(engine),'Use --engine=both, --engine=webkit, or --engine=chrome');

// Exact _raw_spin_lock instruction body from the pinned Linux/Wasm kernel.
// Its ticket is the high 16 bits; the current owner is the low 16 bits.
const lock=`(param $p0 i32) (local $l1 i32) (local $l2 i32)
  local.get $p0
  i32.load
  local.set $l1
  loop $L0
    local.get $l1
    local.tee $l2
    local.get $p0
    local.get $l2
    local.get $l2
    i32.const 65536
    i32.add
    i32.atomic.rmw.cmpxchg
    local.tee $l1
    i32.ne
    br_if $L0
  end
  block $B1
    local.get $l2
    i32.const 16
    i32.shr_u
    local.tee $l1
    local.get $l2
    i32.const 65535
    i32.and
    i32.eq
    br_if $B1
    block $B2
      local.get $l1
      local.get $p0
      i32.load
      i32.const 65535
      i32.and
      i32.eq
      br_if $B2
      loop $L3
        local.get $l1
        local.get $p0
        i32.load
        i32.const 65535
        i32.and
        i32.ne
        br_if $L3
      end
    end
    atomic.fence
  end`;
const wat=`(module (import "env" "memory" (memory 1 1 shared)) (func (export "plain") ${lock}) (func (export "atomic") ${lock.replaceAll('i32.load','i32.atomic.load')}))`;
const wabt=await wabtFactory(),module=wabt.parseWat('ticket-lock.wat',wat,{threads:true});
module.validate({threads:true});const bytes=Array.from(module.toBinary({}).buffer);module.destroy();
const server=http.createServer((request,response)=>{
  response.writeHead(200,{'Content-Type':'text/html','Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'});
  response.end('<!doctype html><title>Atomic ticket-lock regression</title>');
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
const report={startedAt:new Date().toISOString(),description:'Exact kernel ticket-lock body; atomic variant changes only its three polling loads. Every worker is terminated after completion or a 5-second watchdog.',engines:[]};
let browser;
try{
  for(const [name,type,options] of [['webkit',webkit,{}],['chrome',chromium,{channel:'chrome'}]]){
    if(engine!=='both'&&engine!==name)continue;
    browser=await type.launch({headless:true,...options});
    const result={name,version:browser.version(),errors:[],cases:[]};report.engines.push(result);
    const context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage();
    page.on('pageerror',error=>result.errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    assert.equal(await page.evaluate(()=>crossOriginIsolated&&typeof SharedArrayBuffer==='function'),true);
    const cases=[{load:'plain',warmup:0},...Array.from({length:2},()=>[{load:'plain',warmup:100000},{load:'atomic',warmup:100000}]).flat()];
    for(const test of cases){
      const outcome=await page.evaluate(async({bytes,load,warmup})=>{
        const module=await WebAssembly.compile(new Uint8Array(bytes)),memory=new WebAssembly.Memory({initial:1,maximum:1,shared:true});
        const words=new Int32Array(memory.buffer);
        const source=`onmessage=async ({data:{module,memory,load,warmup}})=>{
          try{
            const instance=await WebAssembly.instantiate(module,{env:{memory}}),words=new Int32Array(memory.buffer);
            for(let i=0;i<warmup;i++){Atomics.store(words,0,0);instance.exports[load](0);}
            Atomics.store(words,0,65536);
            postMessage({kind:'ready',before:Atomics.load(words,0)});
            const started=performance.now();instance.exports[load](0);
            postMessage({kind:'done',observed:Atomics.load(words,0),spinMs:performance.now()-started});
          }catch(error){postMessage({kind:'error',message:error.stack});}
        };`;
        const url=URL.createObjectURL(new Blob([source],{type:'text/javascript'})),worker=new Worker(url);
        const started=performance.now(),result={load,warmup,releaseDelayMs:100,watchdogMs:5000};
        let releaseTimer,watchdog;
        try{
          return await new Promise(resolve=>{
            const finish=details=>resolve({...result,...details,elapsedMs:performance.now()-started,finalValue:Atomics.load(words,0)});
            watchdog=setTimeout(()=>finish({status:'timeout'}),5000);
            worker.onerror=error=>finish({status:'worker-error',message:error.message});
            worker.onmessage=({data})=>{
              if(data.kind==='ready'){
                result.readyAtMs=performance.now()-started;result.before=data.before;
                releaseTimer=setTimeout(()=>{
                  result.releasedAtMs=performance.now()-started;
                  result.beforeRelease=Atomics.add(words,0,1);result.afterRelease=Atomics.load(words,0);
                },result.releaseDelayMs);
              }else if(data.kind==='done')finish({status:'completed',observed:data.observed,spinMs:data.spinMs});
              else finish({status:'worker-error',message:data.message});
            };
            worker.postMessage({module,memory,load,warmup});
          });
        }finally{clearTimeout(releaseTimer);clearTimeout(watchdog);worker.terminate();URL.revokeObjectURL(url);}
      },{bytes,...test});
      result.cases.push(outcome);console.log(name,JSON.stringify(outcome));
      assert.equal(outcome.before,65536,'Worker did not start with the pre-held lock');
      assert.equal(outcome.beforeRelease,131072,'Worker did not acquire a waiting ticket before the release');
      assert.equal(outcome.afterRelease,131073);assert.equal(outcome.finalValue,131073);
      // A future WebKit fix may make the original body pass. Record that outcome
      // rather than requiring an engine bug; the atomic variant must always pass.
      if(name==='webkit'&&test.load==='plain')assert.ok(['completed','timeout'].includes(outcome.status));
      else assert.equal(outcome.status,'completed','Ticket lock did not observe its release');
      if(outcome.status==='completed')assert.equal(outcome.observed,131073);
    }
    assert.deepEqual(result.errors,[]);
    result.originalStallReproduced=result.cases.some(test=>test.load==='plain'&&test.status==='timeout');
    result.atomicPassed=result.cases.filter(test=>test.load==='atomic').every(test=>test.status==='completed');
    console.log('RESULT',name,JSON.stringify({originalStallReproduced:result.originalStallReproduced,atomicPassed:result.atomicPassed}));
    await browser.close();browser=null;
  }
  report.passed=true;
}catch(error){report.passed=false;report.failure=error.stack;console.error(error);process.exitCode=1;}
finally{
  await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  report.finishedAt=new Date().toISOString();
  await fs.writeFile(path.join(results,'atomic-poll-report.json'),JSON.stringify(report,null,2)+'\n');
}

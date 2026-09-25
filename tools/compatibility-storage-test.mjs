// SPDX-License-Identifier: GPL-2.0-only
// Real browser IndexedDB tests on small opaque disks. No kernel is mocked.
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
const selection=process.env.COMPATIBILITY_ENGINE||'both';
assert.ok(['both','chrome','webkit'].includes(selection));
const source=await fs.readFile(path.join(root,'public','compatibility-storage.js'));
const server=http.createServer((request,response)=>{
  const module=request.url==='/compatibility-storage.js';
  response.writeHead(200,{'Content-Type':module?'text/javascript':'text/html','Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'});
  response.end(module?source:'<!doctype html><title>Opaque disk persistence test</title>');
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
const report={startedAt:new Date().toISOString(),engines:[]};
let browser;
try{
  for(const [name,type,options] of [['chrome',chromium,{channel:'chrome'}],['webkit',webkit,{}]]){
    if(selection!=='both'&&selection!==name)continue;
    browser=await type.launch({headless:true,...options});
    const context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage();
    const result={name,version:browser.version(),errors:[]};report.engines.push(result);
    page.on('pageerror',error=>result.errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const deadline=setTimeout(()=>{void browser?.close().catch(()=>{});},90000);
    try{
      result.outcome=await page.evaluate(async()=>{
        const {DiskStore,makeBaseMetadata}=await import('./compatibility-storage.js');
        const checks=[],stores=[],databases=new Set();
        const check=(value,message)=>{if(!value)throw new Error(message);};
        const same=(left,right)=>left.length===right.length&&left.every((value,index)=>value===right[index]);
        const pass=name=>checks.push({name,passed:true});
        const rejected=async(promise,code)=>{
          try{await promise;}catch(error){check(error.code===code,`Expected ${code}, got ${error.code||error.name}: ${error.message}`);return error;}
          throw new Error(`Expected ${code} rejection`);
        };
        const newStore=scope=>{const value=new DiskStore(scope);stores.push(value);databases.add(value.databaseName);return value;};
        const idbRequest=value=>new Promise((resolve,reject)=>{value.onsuccess=()=>resolve(value.result);value.onerror=()=>reject(value.error);});
        const edit=async(store,names,action)=>{
          const database=await idbRequest(indexedDB.open(store.databaseName,1));
          try{
            const transaction=database.transaction(names,'readwrite');
            const finished=new Promise((resolve,reject)=>{transaction.oncomplete=resolve;transaction.onabort=()=>reject(transaction.error);});
            finished.catch(()=>{});
            const result=await action(transaction,idbRequest);await finished;return result;
          }finally{database.close();}
        };
        const wholeHash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');
        const scope=location.href+'disk-test-'+crypto.randomUUID(),store=newStore(scope);
        const size=4*1024*1024,baseBytes=new Uint8Array(size*2+17);
        for(let index=0;index<baseBytes.length;index++)baseBytes[index]=(index*29+37)%251;
        const base=await makeBaseMetadata(baseBytes,await wholeHash(baseBytes));
        let release;
        try{
          check(base.blockSize===size&&base.blocks.length===3,'Base metadata must contain 4 MiB hashes and a final partial block');
          const empty=await store.describe();check(empty.current===null&&empty.previous===null&&empty.chunkCount===0,'Fresh store is not empty');
          let readCount=0;
          const unchanged=await store.save(base,async(offset,length)=>{readCount++;return baseBytes.subarray(offset,offset+length);},{expectedCurrent:null});
          check(readCount===3&&unchanged.changedBlocks===0,'Save did not stream exactly the three requested blocks');
          check((await store.describe()).chunkCount===0,'Unchanged base blocks must never be stored');
          pass('base hashing, bounded block reads, and zero stored chunks for an unchanged disk');

          const diskA=baseBytes.slice();diskA[9]^=255;diskA[size*2]=0;diskA[size*2+16]=255;
          const savedA=await store.save(base,async(offset,length)=>diskA.subarray(offset,offset+length),{expectedCurrent:unchanged.id});
          check(savedA.changedBlocks===2&&savedA.changedBytes===size+17,'Partial final-block accounting differs');
          const restoredA=baseBytes.slice();await store.restore(base,restoredA);
          check(same(restoredA,diskA),'Opaque disk bytes were changed during storage');
          check((await store.describe()).previous.id===unchanged.id,'Previous snapshot was not retained');
          pass('opaque binary bytes round-trip exactly, including final partial block');

          const diskB=baseBytes.slice();diskB.fill(106,0,size*2);
          const shared=new Uint8Array(new SharedArrayBuffer(diskB.byteLength));shared.set(diskB);
          const savedB=await store.save(base,async(offset,length)=>shared.subarray(offset,offset+length),{expectedCurrent:savedA.id});
          const beforeFailure=await store.describe();
          check(savedB.changedBlocks===2&&beforeFailure.chunkCount===3,'Identical changed blocks were not content-addressed/deduplicated');
          const current=baseBytes.slice();await store.restore(base,current);check(same(current,diskB),'Current snapshot restore differs');
          const previous=baseBytes.slice();const previousResult=await store.restore(base,previous,{previous:true});check(same(previous,diskA),'Previous snapshot restore differs');
          check(previousResult.id===savedA.id&&previousResult.currentId===savedB.id,'Previous recovery lost the current CAS identity');
          await rejected(store.restore(base,current),'INVALID_TARGET');
          pass('content-addressed deduplication, shared-buffer reader, and explicit previous recovery');

          let staleReads=0;
          await rejected(store.save(base,async()=>{staleReads++;return diskA;},{expectedCurrent:savedA.id}),'STALE_SNAPSHOT');
          check(staleReads===0&&(await store.describe()).current.id===savedB.id,'A stale guest overwrote a newer saved disk');
          await rejected(store.save(base,async()=>diskA),'MISSING_EXPECTED_CURRENT');
          pass('stale snapshot identity and missing CAS token reject before reading the guest disk');

          const diskC=baseBytes.slice();diskC.fill(123,0,size);diskC[size*2+3]^=127;
          const originalPut=IDBObjectStore.prototype.put;
          IDBObjectStore.prototype.put=function(value,key){
            if(this.name==='state'&&key==='heads')throw new DOMException('Injected manifest commit quota failure','QuotaExceededError');
            return originalPut.call(this,value,key);
          };
          try{
            let error;try{await store.save(base,async(offset,length)=>diskC.subarray(offset,offset+length),{expectedCurrent:savedB.id});}catch(value){error=value;}
            check(error?.name==='QuotaExceededError','Injected IndexedDB write failure did not reach caller');
          }finally{IDBObjectStore.prototype.put=originalPut;}
          const afterFailure=await store.describe();
          check(afterFailure.current.id===beforeFailure.current.id&&afterFailure.previous.id===beforeFailure.previous.id,'Failed commit replaced a good snapshot pointer');
          check(afterFailure.chunkCount===beforeFailure.chunkCount,'Failed-save orphan chunks were not reclaimed');
          const afterFailureBytes=baseBytes.slice();await store.restore(base,afterFailureBytes);
          check(same(afterFailureBytes,diskB),'Current snapshot was damaged by failed write');
          pass('aborted IndexedDB manifest write preserves current and previous snapshots');

          const malformedDisk=baseBytes.slice();malformedDisk.fill(55,0,size);malformedDisk.fill(106,size,size*2);
          let malformedWrites=0;
          IDBObjectStore.prototype.put=function(value,key){
            if(this.name==='chunks'){
              const corrupted=structuredClone(value);new Uint8Array(corrupted.bytes)[0]^=255;malformedWrites++;
              return originalPut.call(this,corrupted,key);
            }
            return originalPut.call(this,value,key);
          };
          try{
            await rejected(store.save(base,async(offset,length)=>malformedDisk.subarray(offset,offset+length),{expectedCurrent:savedB.id}),'CORRUPT_CHUNK');
          }finally{IDBObjectStore.prototype.put=originalPut;}
          check(malformedWrites===1,'Existing good content-addressed chunks were rewritten');
          const afterMalformed=await store.describe();
          check(afterMalformed.current.id===savedB.id&&afterMalformed.previous.id===savedA.id,'Malformed stored bytes were committed');
          const intact=baseBytes.slice();await store.restore(base,intact);check(same(intact,diskB),'A malformed new write damaged old snapshot chunks');
          pass('stored-block readback catches malformed writes before commit and never rewrites good chunks');

          await store.save(base,async(offset,length)=>diskC.subarray(offset,offset+length),{expectedCurrent:savedB.id});
          const originalSnapshot=await edit(store,['state','snapshots','chunks'],async(transaction,get)=>{
            const heads=await get(transaction.objectStore('state').get('heads'));
            const snapshot=await get(transaction.objectStore('snapshots').get(heads.current));
            const key=snapshot.changes[1].sha256,chunk=await get(transaction.objectStore('chunks').get(key));
            new Uint8Array(chunk.bytes)[0]^=255;transaction.objectStore('chunks').put(chunk,key);
            return snapshot;
          });
          const untouched=baseBytes.slice();await rejected(store.restore(base,untouched),'CORRUPT_CHUNK');
          check(same(untouched,baseBytes),'Restore mutated target before validating every changed chunk');
          const recovered=baseBytes.slice();await store.restore(base,recovered,{previous:true});check(same(recovered,diskB),'Previous snapshot could not recover a corrupted current disk');
          pass('late corrupt chunk rejects without any target mutation; previous snapshot still recovers');

          const wrongBase={...base,sha256:'0'.repeat(64)},wrongTarget=baseBytes.slice();
          await rejected(store.restore(wrongBase,wrongTarget),'BASE_MISMATCH');
          check(same(wrongTarget,baseBytes),'Base mismatch changed target bytes');
          let mismatchReads=0;
          await rejected(store.save(wrongBase,async()=>{mismatchReads++;return new Uint8Array();},{expectedCurrent:originalSnapshot.id}),'BASE_MISMATCH');
          check(mismatchReads===0&&(await store.describe()).current.id===originalSnapshot.id,'Base mismatch read or replaced the saved image');
          pass('base mismatch explicitly refuses save/restore and preserves saved data');

          await edit(store,['snapshots'],async transaction=>{
            const invalid=structuredClone(originalSnapshot);invalid.changes[1].index=256;
            transaction.objectStore('snapshots').put(invalid,invalid.id);
          });
          const invalidTarget=baseBytes.slice();await rejected(store.restore(base,invalidTarget),'CORRUPT_SNAPSHOT');
          check(same(invalidTarget,baseBytes),'Malformed block metadata changed target');
          const recoveryAfterBadMetadata=baseBytes.slice();await store.restore(base,recoveryAfterBadMetadata,{previous:true});
          check(same(recoveryAfterBadMetadata,diskB),'Bad current metadata prevented explicit previous recovery');
          let oversizedReads=0;
          await rejected(store.save({...base,byteLength:1024*1024*1024+1},async()=>{oversizedReads++;return baseBytes;}),'INVALID_BASE');
          check(oversizedReads===0,'Oversized disk triggered disk I/O');
          pass('finite metadata/block limits reject before mutation or disk reads');

          const selectedPrevious=await store.describeSnapshot({previous:true});
          check(selectedPrevious.snapshot.id===savedB.id&&selectedPrevious.currentId===originalSnapshot.id,
            'Chosen previous metadata did not preserve the current CAS identity');
          await rejected(store.describeSnapshot(),'CORRUPT_SNAPSHOT');
          let recoveryReads=0;
          const recoveryReader=async(offset,length)=>{recoveryReads++;return recoveryAfterBadMetadata.subarray(offset,offset+length);};
          await rejected(store.save(base,recoveryReader,{expectedCurrent:originalSnapshot.id}),'CORRUPT_SNAPSHOT');
          await rejected(store.save(base,recoveryReader,{expectedCurrent:originalSnapshot.id,recoveredPrevious:crypto.randomUUID()}),'STALE_SNAPSHOT');
          await rejected(store.save(wrongBase,recoveryReader,{expectedCurrent:originalSnapshot.id,recoveredPrevious:savedB.id}),'BASE_MISMATCH');
          check(recoveryReads===0,'Invalid or implicit recovery read the stopped guest disk');
          pass('chosen previous metadata survives corrupt current metadata; recovery requires exact previous identity and matching base');

          const brokenCurrent=await edit(store,['snapshots'],(transaction,get)=>get(transaction.objectStore('snapshots').get(originalSnapshot.id)));
          const recoveryDisk=diskB.slice();recoveryDisk[77]^=127;recoveryDisk[size*2+2]=88;
          IDBObjectStore.prototype.put=function(value,key){
            if(this.name==='state'&&key==='heads')throw new DOMException('Injected recovery commit failure','QuotaExceededError');
            return originalPut.call(this,value,key);
          };
          try{
            let error;try{await store.save(base,async(offset,length)=>recoveryDisk.subarray(offset,offset+length),
              {expectedCurrent:originalSnapshot.id,recoveredPrevious:savedB.id});}catch(value){error=value;}
            check(error?.name==='QuotaExceededError','Recovery did not reach the injected atomic commit failure');
          }finally{IDBObjectStore.prototype.put=originalPut;}
          const brokenAfterFailure=await edit(store,['snapshots'],(transaction,get)=>get(transaction.objectStore('snapshots').get(originalSnapshot.id)));
          check(JSON.stringify(brokenAfterFailure)===JSON.stringify(brokenCurrent),'Failed recovery pruned or rewrote the corrupt current metadata');
          const selectedAfterFailure=await store.describeSnapshot({previous:true});
          check(selectedAfterFailure.currentId===originalSnapshot.id&&selectedAfterFailure.snapshot.id===savedB.id,
            'Failed recovery replaced current or previous pointers');
          const goodAfterFailure=baseBytes.slice();await store.restore(base,goodAfterFailure,{previous:true});
          check(same(goodAfterFailure,diskB),'Failed recovery damaged the good previous disk');
          pass('failed recovery commit preserves corrupt current metadata and the complete good previous generation');

          const recoveredSave=await store.save(base,async(offset,length)=>recoveryDisk.subarray(offset,offset+length),
            {expectedCurrent:originalSnapshot.id,recoveredPrevious:savedB.id});
          const recoveryHeads=await store.describe();
          check(recoveryHeads.current.id===recoveredSave.id&&recoveryHeads.previous.id===savedB.id,
            'Successful recovery did not retain the good previous generation');
          const recoveredCurrent=baseBytes.slice(),retainedPrevious=baseBytes.slice();
          await store.restore(base,recoveredCurrent);await store.restore(base,retainedPrevious,{previous:true});
          check(same(recoveredCurrent,recoveryDisk)&&same(retainedPrevious,diskB),'Recovered or retained disk bytes differ');
          pass('verified recovery publishes the replacement atomically while retaining the intact previous disk');

          const normalRecovery=await store.save(base,async(offset,length)=>diskB.subarray(offset,offset+length),
            {expectedCurrent:recoveredSave.id,recoveredPrevious:savedB.id});
          const normalRecoveryHeads=await store.describe();
          check(normalRecoveryHeads.current.id===normalRecovery.id&&normalRecoveryHeads.previous.id===recoveredSave.id,
            'Explicit previous recovery with intact current metadata changed normal generation rotation');
          const normalPrevious=baseBytes.slice();await store.restore(base,normalPrevious,{previous:true});
          check(same(normalPrevious,recoveryDisk),'Intact old current disk was not preserved as the normal previous generation');
          pass('previous recovery with intact current metadata preserves normal current-to-previous rotation');

          const parallelScope=scope+'/concurrent',first=newStore(parallelScope),second=newStore(parallelScope),isolated=newStore(scope+'/isolated');
          let entered;const ready=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
          const pending=first.save(base,async(offset,length)=>{if(offset===0){entered();await gate;}return baseBytes.subarray(offset,offset+length);},{expectedCurrent:null});
          await ready;
          try{
            await rejected(first.save(base,async(offset,length)=>baseBytes.subarray(offset,offset+length),{expectedCurrent:null}),'DISK_BUSY');
            await rejected(second.save(base,async(offset,length)=>baseBytes.subarray(offset,offset+length),{expectedCurrent:null}),'DISK_BUSY');
            await rejected(second.restore(base,baseBytes.slice()),'DISK_BUSY');
            await isolated.save(base,async(offset,length)=>baseBytes.subarray(offset,offset+length),{expectedCurrent:null});
          }finally{release();release=undefined;await pending;}
          check((await first.describe()).current.changedBlocks===0,'First concurrent writer was damaged');
          check((await second.describe()).current.id===(await first.describe()).current.id,'Instances do not share the committed snapshot');
          check((await isolated.describe()).current.id!==(await first.describe()).current.id,'Application scopes were not isolated');
          pass('concurrent writers/restores reject through instance and IndexedDB guards; other scopes remain independent');
          return {passed:true,checks,diskBytes:baseBytes.byteLength,blockSize:size};
        }catch(error){return {passed:false,checks,failure:error.stack};}
        finally{
          release?.();for(const value of stores)await value.close().catch(()=>{});
          for(const name of databases)await idbRequest(indexedDB.deleteDatabase(name));
        }
      });
    }finally{clearTimeout(deadline);}
    assert.equal(result.outcome.passed,true,result.outcome.failure);
    // A separate page has no shared JavaScript instance guard. Only the real
    // IndexedDB lease can reject its competing write.
    const scope=await page.evaluate(async()=>{
      const {DiskStore,makeBaseMetadata}=await import('./compatibility-storage.js');
      const bytes=new Uint8Array(37).fill(23),sha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
      const base=await makeBaseMetadata(bytes,sha),scope=location.href+'cross-tab-'+crypto.randomUUID();
      window.crossTabStore=new DiskStore(scope);
      let entered;const ready=new Promise(resolve=>{entered=resolve;});
      const gate=new Promise(resolve=>{window.releaseCrossTab=resolve;});
      window.crossTabSave=window.crossTabStore.save(base,async()=>{entered();await gate;return bytes;},{expectedCurrent:null});
      await ready;return scope;
    });
    const otherPage=await context.newPage();
    try{
      await otherPage.goto(`http://127.0.0.1:${server.address().port}/`);
      const competing=await otherPage.evaluate(async scope=>{
        const {DiskStore,makeBaseMetadata}=await import('./compatibility-storage.js');
        const bytes=new Uint8Array(37).fill(23),sha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
        const base=await makeBaseMetadata(bytes,sha),store=new DiskStore(scope);
        try{await store.save(base,async()=>bytes,{expectedCurrent:null});return 'unexpected success';}
        catch(error){return error.code;}
        finally{await store.close();}
      },scope);
      assert.equal(competing,'DISK_BUSY','A competing tab bypassed the IndexedDB lease');
      result.outcome.checks.push({name:'separate browser tab cannot bypass the active IndexedDB writer lease',passed:true});
      const committed=await page.evaluate(async()=>{window.releaseCrossTab();return window.crossTabSave;});
      const stale=await otherPage.evaluate(async scope=>{
        const {DiskStore,makeBaseMetadata}=await import('./compatibility-storage.js');
        const bytes=new Uint8Array(37).fill(23),sha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
        const base=await makeBaseMetadata(bytes,sha),store=new DiskStore(scope);let reads=0;
        try{await store.save(base,async()=>{reads++;return bytes;},{expectedCurrent:null});return {code:'unexpected success'};}
        catch(error){return {code:error.code,reads,current:(await store.describe()).current.id};}
        finally{await store.close();}
      },scope);
      assert.equal(stale.code,'STALE_SNAPSHOT');assert.equal(stale.reads,0);assert.equal(stale.current,committed.id);
      result.outcome.checks.push({name:'older guest in a separate tab cannot overwrite the newer committed disk',passed:true});

      const secondCommit=await page.evaluate(async expectedCurrent=>{
        const {makeBaseMetadata}=await import('./compatibility-storage.js');
        const bytes=new Uint8Array(37).fill(23),sha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
        const base=await makeBaseMetadata(bytes,sha);
        return window.crossTabStore.save(base,async()=>new Uint8Array(37).fill(24),{expectedCurrent});
      },committed.id);
      const recoveryChoice=await otherPage.evaluate(async scope=>{
        const {DiskStore,makeBaseMetadata}=await import('./compatibility-storage.js');
        const bytes=new Uint8Array(37).fill(23),sha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
        const base=await makeBaseMetadata(bytes,sha),store=new DiskStore(scope);
        try{
          const chosen=await store.describeSnapshot({previous:true});
          const restored=await store.restore(base,bytes,{previous:true});
          window.previousRecoveryAttempt={scope,base,bytes,expectedCurrent:restored.currentId,recoveredPrevious:restored.id};
          return chosen;
        }finally{await store.close();}
      },scope);
      assert.equal(recoveryChoice.snapshot.id,committed.id);assert.equal(recoveryChoice.currentId,secondCommit.id);
      const thirdCommit=await page.evaluate(async expectedCurrent=>{
        const {makeBaseMetadata}=await import('./compatibility-storage.js');
        const bytes=new Uint8Array(37).fill(23),sha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
        const base=await makeBaseMetadata(bytes,sha);
        return window.crossTabStore.save(base,async()=>new Uint8Array(37).fill(25),{expectedCurrent});
      },secondCommit.id);
      const staleRecovery=await otherPage.evaluate(async()=>{
        const {DiskStore}=await import('./compatibility-storage.js');
        const {scope,base,bytes,expectedCurrent,recoveredPrevious}=window.previousRecoveryAttempt,store=new DiskStore(scope);let reads=0;
        try{await store.save(base,async()=>{reads++;return bytes;},{expectedCurrent,recoveredPrevious});return {code:'unexpected success'};}
        catch(error){return {code:error.code,reads,heads:await store.describe()};}
        finally{await store.close();}
      });
      assert.equal(staleRecovery.code,'STALE_SNAPSHOT');assert.equal(staleRecovery.reads,0);
      assert.equal(staleRecovery.heads.current.id,thirdCommit.id);assert.equal(staleRecovery.heads.previous.id,secondCommit.id);
      result.outcome.checks.push({name:'explicit previous recovery in another browser tab cannot overwrite a newer current or previous generation',passed:true});
    }finally{
      await otherPage.close();
      await page.evaluate(async()=>{
        window.releaseCrossTab();await window.crossTabSave;
        const name=window.crossTabStore.databaseName;await window.crossTabStore.close();
        await new Promise((resolve,reject)=>{const request=indexedDB.deleteDatabase(name);request.onsuccess=resolve;request.onerror=()=>reject(request.error);});
      });
    }
    assert.deepEqual(result.errors,[]);
    for(const check of result.outcome.checks)console.log('PASS',name,check.name);
    await context.close();await browser.close();browser=undefined;
  }
  report.passed=true;
}catch(error){report.passed=false;report.failure=error.stack;console.error(error);process.exitCode=1;}
finally{
  report.finishedAt=new Date().toISOString();await browser?.close();
  await new Promise(resolve=>server.close(resolve));
  await fs.writeFile(path.join(results,'compatibility-storage-report.json'),JSON.stringify(report,null,2)+'\n');
}

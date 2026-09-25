import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
await fs.mkdir('.cache/tmp',{recursive:true});process.env.TEMP=path.resolve('.cache/tmp');process.env.TMP=process.env.TEMP;
await fs.mkdir('test-results',{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const report=[];
try{
 const page=await browser.newPage({acceptDownloads:true});await page.goto('http://127.0.0.1:4173');
 await page.waitForFunction(()=>window.machine?.state==='running');
 const result=await page.evaluate(async()=>{
   clearInterval(machine.autoSave);
   await machine.write('/home/web/important.txt','known good bytes');
   const original=await machine.save();
   const {load}=await import('./storage.js');
   const rpc=machine.rpc.bind(machine);
   // Simulate corruption visible only in the final whole-workspace restore check.
   machine.rpc=async(method,args)=>{
     const value=await rpc(method,args);
     if(method==='snapshot'&&machine.state==='restoring')value.entries.find(e=>e.path==='/home/web/important.txt').data[0]^=1;
     return value;
   };
   let error='';try{await machine.boot();}catch(e){error=e.message;}
   const failedState=machine.state;const after=await load();machine.rpc=rpc;
   return {error,failedState,original:original.digest,after:after.digest,stored:Array.from(after.entries.find(e=>e.path==='/home/web/important.txt').data)};
 });
 assert.match(result.error,/did not match/);assert.equal(result.failedState,'error');assert.equal(result.original,result.after);
 assert.equal(new TextDecoder().decode(Uint8Array.from(result.stored)),'known good bytes');
 report.push({check:'injected restore corruption stops Linux and preserves saved bytes',passed:true});
 const pending=page.waitForEvent('download');await page.locator('#export-saved').click();const download=await pending;await download.saveAs('test-results/recovery-export.json');
 const backup=JSON.parse(await fs.readFile('test-results/recovery-export.json','utf8'));assert.equal(backup.digest,result.original);
 report.push({check:'last good backup remains exportable while guest is stopped',passed:true});
 await page.locator('#retry').click();await page.waitForFunction(()=>machine.state==='running');
 assert.equal(await page.evaluate(async()=>new TextDecoder().decode(await machine.rpc('read',{path:'/home/web/important.txt'}))),'known good bytes');
 report.push({check:'retry restores original workspace after rejected restore',passed:true});
 // Exercise real document reloads, creating fresh kernels each time.
 for(let i=0;i<10;i++){
   await page.evaluate(async i=>{
     await machine.write('/home/web/binary.dat',Uint8Array.from({length:150000},(_,j)=>(j+i)%256));
     await machine.rpc('mkdir',{path:'/home/web/nested'});
     await machine.write('/home/web/nested/note.txt','reload '+i);await machine.save();
   },i);
   await page.reload();await page.waitForFunction(()=>machine.state==='running'||machine.state==='error');
   assert.equal(await page.evaluate(()=>machine.state),'running',await page.locator('#error-message').textContent());
   assert.equal(await page.evaluate(async i=>{const bytes=await machine.rpc('read',{path:'/home/web/binary.dat'});return bytes.length===150000&&bytes.every((n,j)=>n===(j+i)%256);},i),true);
 }
 report.push({check:'ten page reloads restore nested files and exact 150000-byte binary',passed:true});
 console.log(JSON.stringify(report,null,2));
}finally{await fs.writeFile('test-results/recovery-report.json',JSON.stringify(report,null,2));await browser.close();}

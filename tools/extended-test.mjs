import {chromium} from 'playwright';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';
import {createHash} from 'node:crypto';
await fs.mkdir('.cache/tmp',{recursive:true});process.env.TEMP=path.resolve('.cache/tmp');process.env.TMP=process.env.TEMP;
const reports=[];
await fs.mkdir('test-results',{recursive:true});
for(const channel of ['chrome','msedge']){
 const browser=await chromium.launch({channel,headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:800}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:4173');await page.waitForFunction(()=>window.machine?.state==='running',null,{timeout:60000});
  if(channel==='chrome'){
   // Test the real UI restore flow, including replacement of extra files.
   await page.evaluate(async()=>{await machine.write('/home/web/restore.txt','backup version');await machine.save();});
   const snapshot=await page.evaluate(()=>machine.rpc('snapshot'));
   // Playwright serializes Uint8Array to a plain object. Normalize explicitly.
   for(const entry of snapshot.entries)if(entry.type==='file')entry.data=Object.values(entry.data);
   await page.evaluate(async()=>{await machine.write('/home/web/restore.txt','newer version');await machine.write('/home/web/extra.txt','will disappear');});
   await page.locator('[data-view="machine"]').click();
   await page.locator('#backup-input').setInputFiles({name:'backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(snapshot))});
   await page.locator('#prompt-confirm').click();await page.waitForFunction(()=>window.machine?.state==='running'&&document.querySelector('#toast').textContent==='Workspace restored',null,{timeout:60000});
   assert.equal(await page.evaluate(async()=>new TextDecoder().decode(await machine.rpc('read',{path:'/home/web/restore.txt'}))),'backup version');
   await assert.rejects(()=>page.evaluate(()=>machine.rpc('read',{path:'/home/web/extra.txt'})));
   reports.push({check:'backup restore UI replaces workspace exactly',passed:true});
   await page.evaluate(()=>machine.boot({memoryMiB:128}));
   assert.equal(await page.evaluate(()=>machine.os.stats().memoryBytes),128*1024*1024);
   reports.push({check:'128 MiB kernel boot',passed:true});
   await page.waitForFunction(()=>machine.output.includes('root@browser-linux:~#'));
   const start=performance.now();await page.evaluate(()=>machine.os.key_input('dd if=/dev/zero bs=1048576 count=8 2>/dev/null | sha256sum; echo HASH_BENCH_DONE\n'));
   await page.waitForFunction(()=>machine.output.includes('\r\nHASH_BENCH_DONE\r\n'),null,{timeout:30000});
   const output=await page.evaluate(()=>machine.output);
   assert.ok(output.includes(createHash('sha256').update(Buffer.alloc(8*1024*1024)).digest('hex')));
   reports.push({check:'Linux BusyBox hashes 8 MiB through pipe',passed:true,wallMs:Math.round(performance.now()-start)});
  }
  assert.deepEqual(errors,[]);reports.push({check:`${channel} kernel and desktop`,version:browser.version(),passed:true});
 }finally{await browser.close();}
}
await fs.writeFile('test-results/extended-report.json',JSON.stringify(reports,null,2));console.log(JSON.stringify(reports,null,2));

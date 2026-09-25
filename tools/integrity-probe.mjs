import {chromium} from 'playwright';import fs from 'node:fs/promises';import path from 'node:path';
await fs.mkdir('.cache/tmp',{recursive:true});process.env.TEMP=path.resolve('.cache/tmp');process.env.TMP=process.env.TEMP;
const browser=await chromium.launch({channel:'chrome',headless:true});const report=[];
try{const page=await browser.newPage();await page.goto('http://127.0.0.1:4173');await page.waitForFunction(()=>machine?.state==='running');
 for(let i=0;i<12;i++){
  const result=await page.evaluate(async i=>{
   const expected=Uint8Array.from({length:150000},(_,j)=>(j+i)%256);
   const compare=actual=>{const diff=[];for(let j=0;j<expected.length;j++)if(actual[j]!==expected[j]){diff.push([j,expected[j],actual[j]]);if(diff.length===20)break;}return diff;};
   await machine.write('/home/web/integrity.bin',expected);
   const written=compare(await machine.rpc('read',{path:'/home/web/integrity.bin'}));
   const snapshot=await machine.save();const saved=compare(snapshot.entries.find(e=>e.path==='/home/web/integrity.bin').data);
   await machine.boot();
   const restored=compare(await machine.rpc('read',{path:'/home/web/integrity.bin'}));
   return {i,written,saved,restored};
  },i);report.push(result);console.log(JSON.stringify(result));if(result.written.length||result.saved.length||result.restored.length)break;
 }
}finally{await fs.writeFile('test-results/integrity-probe.json',JSON.stringify(report,null,2));await browser.close();}

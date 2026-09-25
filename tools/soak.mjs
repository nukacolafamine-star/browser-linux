import {chromium} from 'playwright';
import fs from 'node:fs/promises';import path from 'node:path';
await fs.mkdir('.cache/tmp',{recursive:true});process.env.TEMP=path.resolve('.cache/tmp');process.env.TMP=process.env.TEMP;
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
const page=await browser.newPage();page.on('pageerror',e=>console.log('ERROR',e.message));
await page.goto('http://127.0.0.1:4173');await page.waitForFunction(()=>window.machine?.state==='running',null,{timeout:60000});
await page.waitForFunction(()=>machine.output.includes('root@browser-linux:~#'));
for(let i=0;i<=7;i++){
  if(i)await new Promise(r=>setTimeout(r,60000));
  const start=Date.now();await page.evaluate(i=>machine.os.key_input(`echo SOAK_${i}_ALIVE\n`),i);
  await page.waitForFunction(i=>machine.output.includes('\r\nSOAK_'+i+'_ALIVE\r\n'),i,{timeout:15000});
  const info=await page.evaluate(()=>machine.rpc('info'));
  console.log(JSON.stringify({minute:i,latencyMs:Date.now()-start,uptime:info.uptime,state:await page.evaluate(()=>machine.state)}));
}
}finally{await browser.close();}

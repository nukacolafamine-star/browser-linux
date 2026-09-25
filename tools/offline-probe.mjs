import {chromium} from 'playwright';import fs from 'node:fs/promises';import path from 'node:path';
await fs.mkdir('.cache/tmp',{recursive:true});process.env.TEMP=path.resolve('.cache/tmp');process.env.TMP=process.env.TEMP;
const browser=await chromium.launch({channel:'chrome',headless:true});
try{const page=await browser.newPage();page.on('console',m=>console.log(m.type(),m.text()));page.on('pageerror',e=>console.log('ERROR',e.message));await page.goto('http://127.0.0.1:4173');await page.waitForFunction(()=>machine?.state==='running');
for(let i=0;i<3;i++){
 await page.evaluate(()=>machine.save());await page.reload();await page.waitForFunction(()=>machine?.state==='running');
 console.log(await page.evaluate(async()=>({offline:document.querySelector('#offline-state').textContent,registrations:(await navigator.serviceWorker.getRegistrations()).map(r=>({active:r.active?.state,installing:r.installing?.state,waiting:r.waiting?.state})),caches:await caches.keys()})));
}
await page.waitForFunction(()=>document.querySelector('#offline-state').textContent==='Available offline',null,{timeout:10000});console.log('OFFLINE READY');}finally{await browser.close();}

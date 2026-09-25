// SPDX-License-Identifier: GPL-2.0-only
// Exercise the real startup/error UI with a stalled runtime, without booting Linux.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const temporary=path.join(root,'.cache','tmp'),results=path.join(root,'test-results');
await Promise.all([fs.mkdir(temporary,{recursive:true}),fs.mkdir(results,{recursive:true})]);
process.env.TEMP=temporary;process.env.TMP=temporary;
const url='http://127.0.0.1:4173/';
const source=await fs.readFile(path.join(root,'public','machine.js'),'utf8');
assert.equal(source.split(',45000);').length,2,'Expected exactly one startup watchdog to shorten');
const machineSource=source.replace(',45000);',',100);');
const fakeRuntime=`
window.linux=async function(_worker,_kernel,_commandLine,_initrd,log,output){
  window.runtimeStarts=(window.runtimeStarts||0)+1;
  let stopped=false;
  setTimeout(()=>{
    if(stopped)return;
    log('Starting cpu 0 with init_task 318080');
    output('Run /init as init process\\r\\n\\r\\nBrowser Linux | Linux 6.4 / wasm32\\r\\nYour workspace: /home/web\\r\\n');
  },10);
  return {
    stop(){stopped=true;},
    stats(){return {workers:stopped?0:3,cpus:stopped?0:3,memoryBytes:134217728,workerStates:stopped?[]:[{name:'CPU 0',phase:'kernel entered',ageMs:12}]};}
  };
};`;
const report={url,startedAt:new Date().toISOString(),checks:[],errors:[]};
const record=name=>{report.checks.push({name,passed:true});console.log('PASS',name);};
let browser,page;
try{
  browser=await chromium.launch({channel:'chrome',headless:true});report.browser=browser.version();
  const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true,serviceWorkers:'block'});
  await context.route('**/runtime/linux.js',route=>route.fulfill({contentType:'text/javascript',body:fakeRuntime}));
  await context.route('**/machine.js',route=>route.fulfill({contentType:'text/javascript',body:machineSource}));
  await context.route('**/assets/vmlinux.wasm',route=>route.fulfill({contentType:'application/wasm',body:Buffer.from([0,97,115,109,1,0,0,0])}));
  await context.route('**/assets/initramfs.cpio.gz',route=>route.fulfill({contentType:'application/gzip',body:Buffer.alloc(0)}));
  await context.addInitScript(()=>{
    window.startupStatuses=[];
    new MutationObserver(()=>{
      const text=document.getElementById('status')?.textContent;
      if(text&&window.startupStatuses.at(-1)!==text)window.startupStatuses.push(text);
    }).observe(document,{childList:true,subtree:true,characterData:true});
    Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{
      window.copyAttempts=(window.copyAttempts||0)+1;
      if(!window.allowCopy)throw new DOMException('Clipboard blocked for test','NotAllowedError');
      window.copiedReport=text;
    }}});
  });
  page=await context.newPage();page.setDefaultTimeout(10000);
  page.on('pageerror',error=>report.errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(()=>window.machine?.state==='error');
  assert.match(await page.locator('#error-message').textContent(),/Linux stopped while starting the terminal/);
  assert.ok(await page.evaluate(()=>startupStatuses.includes('Starting the terminal')),'Startup progress never reached the visible status');
  assert.equal(await page.locator('#error-banner').isVisible(),true);
  assert.equal(await page.locator('#retry').isEnabled(),true);
  record('stalled startup identifies the terminal stage and keeps restart available');

  const diagnostics=await page.evaluate(()=>({report:machine.diagnostics(),current:machine.os.stats()}));
  assert.equal(diagnostics.current.workers,0);
  assert.equal(diagnostics.report.runtime.workers,3);
  assert.equal(diagnostics.report.runtime.workerStates[0].phase,'kernel entered');
  assert.equal(diagnostics.report.bridgeReady,false);assert.equal(diagnostics.report.shellReady,false);
  record('failure preserves worker diagnostics before shutdown clears runtime state');

  await page.locator('#error-boot-details').click();
  assert.equal(await page.locator('#log-dialog').isVisible(),true);
  const bootReport=await page.locator('#boot-log').textContent();
  assert.match(bootReport,/Browser Linux \| Linux 6\.4/);
  assert.match(bootReport,/Runtime log:\nStarting cpu 0/);
  const json=JSON.parse(bootReport.split('\n\nStartup report:\n')[1]);
  assert.equal(json.stage,'Starting the terminal');assert.equal(json.runtime.workers,3);
  assert.equal('bootOutput' in json,false);assert.equal('logs' in json,false);
  record('Boot details contains readable logs and diagnostic JSON without duplicated logs');

  await page.locator('#copy-boot-report').click();
  await page.waitForFunction(()=>document.getElementById('boot-copy-status').textContent.includes('Automatic copying is unavailable'));
  assert.equal(await page.evaluate(()=>getSelection().toString()),bootReport);
  assert.equal(await page.locator('#boot-copy-status').isVisible(),true);
  assert.equal(await page.evaluate(()=>copyAttempts),1);
  record('blocked clipboard selects the full report and shows manual-copy instructions');
  await page.evaluate(()=>window.allowCopy=true);await page.locator('#copy-boot-report').click();
  assert.equal(await page.evaluate(()=>copiedReport),bootReport);
  assert.equal(await page.locator('#boot-copy-status').textContent(),'Report copied.');
  record('clipboard success copies the displayed report');

  await page.locator('#close-log').click();await page.locator('#retry').click();
  await page.waitForFunction(()=>window.runtimeStarts===2&&machine.state==='error');
  assert.equal(await page.evaluate(()=>machine.diagnostics().runtime.workers),3);
  assert.equal(await page.locator('#retry').isEnabled(),true);
  record('restart retries the runtime and retains diagnostics for the new failure');

  const unsupported=await browser.newContext({serviceWorkers:'block'});
  await unsupported.addInitScript(()=>Object.defineProperty(window,'SharedArrayBuffer',{value:undefined}));
  const unsupportedPage=await unsupported.newPage();unsupportedPage.setDefaultTimeout(10000);
  unsupportedPage.on('pageerror',error=>report.errors.push(error.message));
  await unsupportedPage.goto(url);await unsupportedPage.locator('#error-banner').waitFor({state:'visible'});
  assert.match(await unsupportedPage.locator('#error-message').textContent(),/does not expose the shared memory/);
  assert.equal(await unsupportedPage.locator('#error-boot-details').isVisible(),false);
  assert.equal(await unsupportedPage.locator('#show-boot-log').isVisible(),false);
  assert.equal(await unsupportedPage.locator('#retry').isEnabled(),true);
  assert.equal(await unsupportedPage.evaluate(()=>typeof window.machine),'undefined');
  record('bootstrap failure hides unavailable report actions and offers retry');
  assert.deepEqual(report.errors,[]);record('no uncaught browser errors');report.passed=true;
}catch(error){
  report.passed=false;report.failure=error.stack;
  report.diagnostics=await page?.evaluate(()=>({state:window.machine?.state,report:window.machine?.diagnostics(),error:document.getElementById('error-message')?.textContent})).catch(()=>null);
  console.error(error);process.exitCode=1;
}finally{
  report.finishedAt=new Date().toISOString();
  await fs.writeFile(path.join(results,'startup-report.json'),JSON.stringify(report,null,2)+'\n');
  await browser?.close();
}

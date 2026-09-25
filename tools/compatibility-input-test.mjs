// SPDX-License-Identifier: GPL-2.0-only
// Real DOM keyboard/focus checks for the shipped adapter. No QEMU or guest mock;
// these checks establish browser event behavior only, not Linux input success.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const temporary=path.join(root,'.cache','tmp'),results=path.join(root,'test-results');
await Promise.all([fs.mkdir(temporary,{recursive:true}),fs.mkdir(results,{recursive:true})]);
process.env.TEMP=temporary;process.env.TMP=temporary;
const initialDirectory=process.cwd(),browserDirectory=await fs.mkdtemp(path.join(temporary,'input-browser-'));
process.chdir(browserDirectory);
const portable=path.join(root,'.cache','playwright-browsers');
if(!process.env.PLAYWRIGHT_BROWSERS_PATH&&await fs.stat(portable).then(()=>true,()=>false))process.env.PLAYWRIGHT_BROWSERS_PATH=portable;
const {chromium,webkit}=await import('playwright');
const selection=process.env.COMPATIBILITY_ENGINE||'both';
assert.ok(['both','chrome','webkit'].includes(selection));
const module=await fs.readFile(path.join(root,'public','compatibility-input.js'));
const document=`<!doctype html><meta charset="utf-8"><title>Canvas input regression</title>
<canvas id="canvas" tabindex="0" width="320" height="200" style="background:#123"></canvas>
<input id="ui" aria-label="Unrelated UI"><button id="next">Next UI control</button>
<script type="module">
import {connectCanvasKeyboard} from './compatibility-input.js';
const canvas=document.getElementById('canvas');
window.disconnect=connectCanvasKeyboard(canvas);
window.events=[];
for(const type of ['keydown','keyup'])document.addEventListener(type,event=>window.events.push({
  type,code:event.code,key:event.key,location:event.location,keyCode:event.keyCode,which:event.which,
  repeat:event.repeat,trusted:event.isTrusted,prevented:event.defaultPrevented,target:event.target.id,
}));
window.ready=true;
</script>`;
const server=http.createServer((request,response)=>{
  const script=new URL(request.url,'http://test.local').pathname==='/compatibility-input.js';
  response.writeHead(200,{'Content-Type':script?'text/javascript':'text/html','Cache-Control':'no-store'});
  response.end(script?module:document);
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
const url=`http://127.0.0.1:${server.address().port}/`;
const report={startedAt:new Date().toISOString(),selection,fullEngineCoverage:selection==='both',
  scope:'Real DOM focus/default-action tests only; does not prove guest input, SDL integration, or physical iOS.',engines:[]};
let browser,context;
const cases=[
  ['canvas Tab prevents browser focus navigation',async page=>{
    await page.locator('#canvas').focus();await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'canvas');
    const events=await page.evaluate(()=>window.events);
    assert.ok(events.some(event=>event.type==='keydown'&&event.code==='Tab'&&event.prevented&&event.trusted));
    assert.ok(events.some(event=>event.type==='keyup'&&event.code==='Tab'&&event.trusted));
  }],
  ['UI focus releases repeated and modifier keys exactly once with physical identity',async page=>{
    await page.locator('#canvas').focus();
    await page.keyboard.down('ShiftRight');await page.keyboard.down('KeyA');await page.keyboard.down('KeyA');
    await page.locator('#ui').focus();
    // A second focus/window notification must not release the same held keys.
    await page.locator('#next').focus();await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
    const events=await page.evaluate(()=>window.events),released=events.filter(event=>event.type==='keyup'&&!event.trusted);
    assert.equal(released.length,2);
    assert.ok(events.some(event=>event.code==='KeyA'&&event.repeat),'The repeated keydown path was not exercised');
    for(const code of ['ShiftRight','KeyA']){
      const down=events.filter(event=>event.type==='keydown'&&event.code===code).at(-1);
      const up=released.find(event=>event.code===code);assert.ok(up,`Missing release for ${code}`);
      for(const field of ['code','key','location','keyCode','which'])assert.equal(up[field],down[field],`${code} ${field}`);
      assert.equal(up.target,'canvas');assert.equal(up.prevented,false);
    }
    assert.equal(released.find(event=>event.code==='ShiftRight').location,2);
    assert.equal(released.find(event=>event.code==='KeyA').keyCode,65);
    await page.keyboard.up('KeyA');await page.keyboard.up('ShiftRight');
    const after=await page.evaluate(()=>window.events);
    assert.equal(after.filter(event=>event.type==='keyup'&&!event.trusted).length,2);
    assert.ok(after.filter(event=>event.type==='keyup'&&event.trusted).every(event=>event.target==='next'));
  }],
  ['normal keyup is not released again on blur',async page=>{
    await page.locator('#canvas').focus();await page.keyboard.press('KeyB');await page.locator('#ui').focus();
    await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
    const events=await page.evaluate(()=>window.events);
    assert.equal(events.filter(event=>event.type==='keyup').length,1);
    assert.equal(events.find(event=>event.type==='keyup').trusted,true);
  }],
  ['window blur releases held key once',async page=>{
    await page.locator('#canvas').focus();await page.keyboard.down('ArrowLeft');
    await page.evaluate(()=>{window.dispatchEvent(new Event('blur'));window.dispatchEvent(new Event('blur'));});
    const events=await page.evaluate(()=>window.events),up=events.filter(event=>event.type==='keyup'&&!event.trusted);
    assert.equal(up.length,1);assert.equal(up[0].code,'ArrowLeft');assert.equal(up[0].keyCode,37);
    await page.keyboard.up('ArrowLeft');
  }],
  ['unrelated UI typing and Tab navigation retain browser behavior',async page=>{
    await page.locator('#ui').focus();await page.keyboard.type('UI text >42');await page.keyboard.press('Tab');
    assert.equal(await page.locator('#ui').inputValue(),'UI text >42');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'next');
    const events=await page.evaluate(()=>window.events);
    assert.ok(events.length>0);assert.ok(events.every(event=>!event.prevented&&event.trusted));
    assert.ok(events.every(event=>event.target!=='canvas'));
  }],
  ['unfocused canvas keydown does not intercept UI or become held',async page=>{
    await page.locator('#ui').focus();
    const prevented=await page.evaluate(()=>{
      const event=new KeyboardEvent('keydown',{key:'x',code:'KeyX',keyCode:88,which:88,bubbles:true,cancelable:true});
      document.getElementById('canvas').dispatchEvent(event);window.dispatchEvent(new Event('blur'));return event.defaultPrevented;
    });
    assert.equal(prevented,false);
    assert.equal((await page.evaluate(()=>window.events)).filter(event=>event.type==='keyup').length,0);
  }],
  ['cleanup releases held keys once and removes all focus/default handlers',async page=>{
    await page.locator('#canvas').focus();await page.keyboard.down('KeyZ');
    await page.evaluate(()=>{window.disconnect();window.disconnect();});
    let events=await page.evaluate(()=>window.events);
    assert.equal(events.filter(event=>event.type==='keyup'&&!event.trusted).length,1);
    assert.equal(events.find(event=>event.type==='keyup').code,'KeyZ');
    await page.keyboard.up('KeyZ');await page.keyboard.down('KeyQ');await page.locator('#ui').focus();
    await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await page.keyboard.up('KeyQ');
    await page.locator('#canvas').focus();await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'ui');
    events=await page.evaluate(()=>window.events);
    assert.equal(events.filter(event=>event.type==='keyup'&&!event.trusted).length,1);
    assert.ok(events.filter(event=>event.type==='keydown'&&['KeyQ','Tab'].includes(event.code)).every(event=>!event.prevented));
  }],
];
try{
  for(const [name,type,options] of [['chrome',chromium,{channel:'chrome'}],['webkit',webkit,{}]]){
    if(selection!=='both'&&selection!==name)continue;
    const entry={name,cases:[]};report.engines.push(entry);
    const deadline=setTimeout(()=>{void context?.close().catch(()=>{});void browser?.close().catch(()=>{});},60000);
    try{
      browser=await type.launch({headless:true,timeout:15000,...options});entry.version=browser.version();
      context=await browser.newContext({serviceWorkers:'block'});
      for(const [label,test] of cases){
        const item={label,passed:false};entry.cases.push(item);
        const page=await context.newPage(),errors=[];page.setDefaultTimeout(10000);
        page.on('pageerror',error=>errors.push(error.message));
        try{
          await page.goto(url,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.ready);
          await test(page);assert.deepEqual(errors,[]);item.passed=true;console.log('PASS',name,label);
        }catch(error){item.error=error.stack;item.events=await page.evaluate(()=>window.events).catch(()=>null);console.error('FAIL',name,label,error.message);}
        finally{item.errors=errors;await page.close().catch(()=>{});}
      }
      entry.passed=entry.cases.every(item=>item.passed);
    }catch(error){entry.passed=false;entry.error=error.stack;}
    finally{clearTimeout(deadline);await context?.close().catch(()=>{});await browser?.close().catch(()=>{});context=null;browser=null;}
  }
}finally{
  await context?.close().catch(()=>{});await browser?.close().catch(()=>{});
  await new Promise(resolve=>server.close(resolve));process.chdir(initialDirectory);
  // Resolve the owned directory before recursive removal; never remove a path
  // outside this project's test cache or an unrelated profile.
  const resolvedTemporary=await fs.realpath(temporary),resolvedDirectory=await fs.realpath(browserDirectory);
  assert.equal(path.dirname(resolvedDirectory),resolvedTemporary);
  assert.ok(path.basename(resolvedDirectory).startsWith('input-browser-'));
  await fs.rm(resolvedDirectory,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  report.passed=report.engines.length>0&&report.engines.every(entry=>entry.passed);
  report.finishedAt=new Date().toISOString();
  await fs.writeFile(path.join(results,'compatibility-input-report.json'),JSON.stringify(report,null,2)+'\n');
}
if(!report.passed)process.exitCode=1;

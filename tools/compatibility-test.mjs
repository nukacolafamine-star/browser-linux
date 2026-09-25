// SPDX-License-Identifier: GPL-2.0-only
// Real x86-64 Linux/Wayland acceptance through the shipped Start Linux UI.
// Requires the local server and assembled artifacts. Never mocks kernel success.
// Default: both installed engines. COMPATIBILITY_ENGINE=chrome|webkit is a
// development shortcut, reported explicitly as incomplete engine coverage.
// COMPATIBILITY_PERSISTENCE=1 adds a real shutdown/save/reload round trip.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const temporary=path.join(root,'.cache','tmp'),results=path.join(root,'test-results');
await Promise.all([fs.mkdir(temporary,{recursive:true}),fs.mkdir(results,{recursive:true})]);
process.env.TEMP=temporary;process.env.TMP=temporary;
const portable=path.join(root,'.cache','playwright-browsers');
if(!process.env.PLAYWRIGHT_BROWSERS_PATH&&await fs.stat(portable).then(()=>true,()=>false))process.env.PLAYWRIGHT_BROWSERS_PATH=portable;
const {chromium,webkit}=await import('playwright');
const selection=process.env.COMPATIBILITY_ENGINE||'both';
assert.ok(['both','chrome','webkit'].includes(selection),'COMPATIBILITY_ENGINE must be both, chrome, or webkit');
const target=new URL(process.env.COMPATIBILITY_URL||'http://127.0.0.1:4173/compatibility.html');
assert.ok(['127.0.0.1','localhost','[::1]'].includes(target.hostname),'This acceptance tool targets a local server');
const budgetMs=300000;
const persistence=process.env.COMPATIBILITY_PERSISTENCE==='1';
const earlyDiagnostics=process.env.COMPATIBILITY_EARLY_DIAGNOSTICS==='1';
assert.ok([undefined,'0','1'].includes(process.env.COMPATIBILITY_PERSISTENCE),'COMPATIBILITY_PERSISTENCE must be 0 or 1');
assert.ok([undefined,'0','1'].includes(process.env.COMPATIBILITY_EARLY_DIAGNOSTICS),'COMPATIBILITY_EARLY_DIAGNOSTICS must be 0 or 1');
const report={startedAt:new Date().toISOString(),target:target.href,budgetMsPerEngine:budgetMs,selection,
  fullEngineCoverage:selection==='both',physicalDeviceCoverage:false,
  earlyDiagnostics,
  persistence:{requested:persistence,saveBudgetMs:120000,reloadBudgetMs:240000},
  maximumBudgetMsPerEngine:persistence?660000:budgetMs,
  scope:'Real browser-local x86-64 Linux, serial shell, files, /proc, compositor/client, displayed canvas, and genuine graphical keyboard input independently verified through serial. Optional persistence uses the actual shutdown/save UI and reboots the saved ext4 disk. Does not establish Minecraft, guest GPU acceleration, networking, or physical device coverage.',engines:[]};

// Shell markers are assembled by printf. An echoed command cannot satisfy them.
function shellCommand(command,nonce){
  return `printf '\\n__BL_%s_BEGIN__\\n' '${nonce}'; ( ${command} ); bl_rc=$?; printf '\\n__BL_%s_EXIT_%s__\\n' '${nonce}' "$bl_rc"\r`;
}
function cleanSerial(value){return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/\r/g,'');}
const guestStartupDiagnostics=[
  `printf 'BOOT_DIAGNOSTIC_PROCESSES\\n'; ps`,
  `printf 'BOOT_DIAGNOSTIC_ENTROPY\\n'; cat /proc/sys/kernel/random/entropy_avail; dmesg | grep -E 'random|crng' | tail -n 20`,
  `printf 'BOOT_DIAGNOSTIC_WAIT_CHANNELS_AND_STACKS\\n'; for pid in $(pidof modprobe mount weston weston-terminal seatd); do printf '%s %s %s\\n' "$pid" "$(cat /proc/$pid/comm 2>/dev/null)" "$(cat /proc/$pid/wchan 2>/dev/null)"; cat /proc/$pid/stack 2>/dev/null || true; done`,
  `printf 'BOOT_DIAGNOSTIC_LOGS\\n'; for f in /var/log/browser* /var/log/weston* /var/log/seatd*; do test -f "$f" || continue; printf '\\nFILE %s\\n' "$f"; tail -n 80 "$f"; done`,
  `printf '\\nBOOT_DIAGNOSTIC_KERNEL\\n'; dmesg | tail -n 30`,
].join('; ');

for(const [name,type,options] of [['chrome',chromium,{channel:'chrome'}],['webkit',webkit,{}]]){
  if(selection!=='both'&&selection!==name)continue;
  const entry={name,checks:[],errors:[],console:[],requestFailures:[],stages:[],workers:[]};report.engines.push(entry);
  let browser,context,page,guest,deadlineTimer,persistentProfile,timedOut=false;
  const start=Date.now();let deadline=start+budgetMs,phase='initial desktop',phaseBudget=budgetMs;
  const remaining=maximum=>Math.max(1,Math.min(maximum,deadline-Date.now()));
  const armDeadline=(nextPhase,duration)=>{
    clearTimeout(deadlineTimer);phase=nextPhase;phaseBudget=duration;deadline=Date.now()+duration;
    entry.phases??=[];entry.phases.push({phase,budgetMs:duration,startedMs:Date.now()-start});
    deadlineTimer=setTimeout(()=>{timedOut=true;void context?.close().catch(()=>{});void browser?.close().catch(()=>{});},duration);
  };
  const record=(check,details)=>{entry.checks.push({check,passed:true,...(details===undefined?{}:{details})});console.log('PASS',name,check);};
  const parentState=async()=>page.evaluate(()=>({
    capabilityStatus:document.getElementById('capability-status')?.textContent,
    imageStatus:document.getElementById('image-status')?.textContent,
    sessionStatus:document.getElementById('session-status')?.textContent,
    capabilities:window.compatibilityCapabilities,
    startDisabled:document.getElementById('start-compatibility')?.disabled,
  }));
  const guestState=async()=>guest?.evaluate(()=>({
    ...window.guestReport,
    runtimeMemoryBytes:window.guestEngine?.HEAPU8?.buffer?.byteLength??null,
    canvas:{width:document.getElementById('canvas')?.width,height:document.getElementById('canvas')?.height},
    terminalAvailable:typeof window.guestTerminal?.input==='function',
    isolated:crossOriginIsolated,
  }));
  async function runShell(command,label,timeout=45000){
    const nonce=randomUUID().replaceAll('-','');
    await guest.evaluate(input=>window.guestTerminal.input(input,true),shellCommand(command,nonce));
    await guest.waitForFunction(nonce=>{
      const state=window.guestReport;
      return state?.state==='error'||new RegExp(`(?:^|[\\r\\n])__BL_${nonce}_EXIT_[0-9]+__(?:[\\r\\n]|$)`).test(state?.serial||'');
    },nonce,{timeout:remaining(timeout),polling:100});
    const state=await guestState();
    assert.notEqual(state.state,'error',state.message);
    const serial=cleanSerial(state.serial);
    const begin=`__BL_${nonce}_BEGIN__\n`,at=serial.lastIndexOf(begin);
    const end=serial.match(new RegExp(`\\n__BL_${nonce}_EXIT_([0-9]+)__`));
    assert.ok(at>=0&&end,`${label}: shell did not produce framed output`);
    assert.ok(end.index>at,`${label}: shell markers arrived out of order`);
    const output=serial.slice(at+begin.length,end.index);
    entry.shell??=[];entry.shell.push({label,command,output,exitCode:Number(end[1])});
    assert.equal(Number(end[1]),0,`${label}: guest command failed:\n${output}`);
    return output;
  }
  async function waitForDesktop(){
    let previousStage='',serialReadyAt=null,diagnosed=false,exchangeReported=false;
    for(;;){
      const state=await guestState();entry.guest=state;
      if(state.exchangeReady&&!exchangeReported){
        exchangeReported=true;entry.stages.push({phase,elapsedMs:Date.now()-start,stage:'guest file exchange ready'});
        console.log('STATE',name,phase,'guest file exchange ready');
      }
      const stage=`${state.state}: ${state.message||''}`;
      if(stage!==previousStage){
        entry.stages.push({phase,elapsedMs:Date.now()-start,stage});previousStage=stage;
        console.log('STATE',name,phase,stage);
      }
      assert.notEqual(state.state,'error',state.message);
      assert.doesNotMatch(state.serial,/BROWSER_LINUX_(?:GRAPHICS_FAILED|WAYLAND_CLIENT_FAILED)/,
        'The real guest reported a compositor/client startup failure');
      if(state.serial.includes('BROWSER_LINUX_SERIAL_READY')
        &&state.serial.includes('BROWSER_LINUX_WAYLAND_CLIENT_STARTED'))return state;
      if(state.serial.includes('BROWSER_LINUX_SERIAL_READY'))serialReadyAt??=Date.now();
      if(serialReadyAt!==null&&!diagnosed&&(earlyDiagnostics||deadline-Date.now()<=45000)){
        // Preserve actionable evidence while the guest and browser are alive.
        // Read only: never repair or restart a compositor to make acceptance pass.
        diagnosed=true;const diagnostic={phase,elapsedMs:Date.now()-start};
        entry.bootDiagnostics??=[];entry.bootDiagnostics.push(diagnostic);
        console.log('DIAGNOSTIC',name,phase,'serial is ready but Wayland has not started');
        await page.screenshot({path:path.join(results,`compatibility-${name}-${phase.replaceAll(' ','-')}-waiting.png`),
          fullPage:true,timeout:remaining(10000)}).catch(error=>{diagnostic.screenshotError=error.message;});
        try{
          diagnostic.output=await runShell(guestStartupDiagnostics,
            'read-only diagnostics for stalled Wayland startup',20000);
          console.log('DIAGNOSTIC_RESULT',name,'real serial shell responded');
        }catch(error){diagnostic.error=error.message;console.log('DIAGNOSTIC_RESULT',name,error.message);}
        await fs.writeFile(path.join(results,`compatibility-${name}-boot-diagnostic.json`),JSON.stringify(diagnostic,null,2)+'\n');
        if(earlyDiagnostics&&diagnostic.error)throw new Error('Early real serial diagnostic failed: '+diagnostic.error);
      }
      assert.ok(Date.now()<deadline,`Real Linux/Wayland did not become ready within the ${phase} deadline`);
      await guest.waitForFunction(previous=>{
        const value=window.guestReport;
        return value?.state==='error'||value?.serial?.length!==previous;
      },state.serial.length,{timeout:remaining(5000),polling:250}).catch(error=>{
        if(error.name!=='TimeoutError')throw error;
      });
    }
  }
  try{
    const contextOptions={viewport:{width:1440,height:1100},serviceWorkers:'block'};
    if(name==='webkit'&&persistence){
      // Portable WebKit's ephemeral contexts discard CacheStorage entries when
      // their writer document navigates. A fresh, isolated local profile tests
      // the browser's durable storage semantics without changing production
      // feature detection or reusing anyone's normal browser/account state.
      persistentProfile=path.join(temporary,'compatibility-webkit-'+randomUUID());
      context=await type.launchPersistentContext(persistentProfile,{headless:true,timeout:remaining(30000),...contextOptions,...options});
      browser=context.browser();entry.contextKind='isolated persistent profile';
    }else{
      browser=await type.launch({headless:true,timeout:remaining(30000),...options});
      context=await browser.newContext(contextOptions);entry.contextKind='ephemeral';
    }
    entry.version=browser?.version()??null;
    page=context.pages()[0]||await context.newPage();page.setDefaultTimeout(15000);
    page.on('pageerror',error=>entry.errors.push(error.message));
    page.on('worker',worker=>{
      const item={url:worker.url(),createdMs:Date.now()-start};entry.workers.push(item);
      worker.on('close',()=>{item.closedMs=Date.now()-start;});
    });
    page.on('console',message=>{
      if(['warning','error'].includes(message.type())){
        entry.console.push({type:message.type(),text:message.text()});
        if(entry.console.length>100)entry.console.shift();
      }
    });
    page.on('requestfailed',request=>entry.requestFailures.push({url:request.url(),error:request.failure()?.errorText}));
    // A hard deadline closes the browser even if a worker stops responding.
    armDeadline('initial desktop',remaining(budgetMs));
    await page.goto(target.href,{waitUntil:'domcontentloaded',timeout:remaining(30000)});
    await page.waitForFunction(()=>{
      const button=document.getElementById('start-compatibility');
      const image=document.getElementById('image-status')?.textContent||'';
      const capabilities=window.compatibilityCapabilities;
      return button&&!button.disabled||/No verified|not supported|requires the browser|failed|unavailable/i.test(image)
        ||capabilities&&capabilities.compatibilityEngine===false;
    },null,{timeout:remaining(30000),polling:100});
    entry.initial=await parentState();
    assert.equal(entry.initial.startDisabled,false,
      `Start Linux is unavailable: ${entry.initial.capabilityStatus}; ${entry.initial.imageStatus}`);
    assert.equal(entry.initial.capabilities.compatibilityEngine,true);
    record('required browser primitives and installed image permit Start Linux');
    await page.locator('#start-compatibility').click({timeout:remaining(10000)});
    const frameElement=await page.locator('#session-container iframe').elementHandle({timeout:remaining(10000)});
    await frameElement.scrollIntoViewIfNeeded({timeout:remaining(10000)});
    guest=await frameElement.contentFrame();
    assert.ok(guest,'Start Linux did not create the session iframe');
    await guest.waitForFunction(()=>!!window.guestReport,null,{timeout:remaining(15000)});
    assert.equal(await page.locator('#start-compatibility').isDisabled(),true);
    assert.equal(await page.locator('#stop-compatibility').isVisible(),true);
    record('Start button creates the actual session and exposes Stop');

    await waitForDesktop();
    assert.match(entry.guest.serial,/BROWSER_LINUX_GUEST_BOOT arch=x86_64 kernel=\S+/);
    assert.match(entry.guest.serial,/BROWSER_LINUX_WAYLAND_READY compositor_pid=\d+ socket=\S+ renderer=pixman/);
    assert.equal(entry.guest.architecture,'x86_64');
    assert.equal(entry.guest.wayland,true);
    assert.equal(entry.guest.guestGPU,false);
    assert.equal(entry.guest.terminalAvailable,true);
    record('actual x86-64 kernel, serial shell and Wayland client markers',{
      elapsedMs:Date.now()-start,guestMemoryMiB:entry.guest.guestMemoryMiB,
      engineMemoryMiB:entry.guest.engineMemoryMiB,runtimeMemoryBytes:entry.guest.runtimeMemoryBytes,
    });

    const uname=await runShell('uname -a; printf "SHELL="; readlink /proc/$$/exe','uname and actual guest shell');
    assert.match(uname,/Linux\s+\S+\s+\S+[\s\S]*x86_64/);
    assert.match(uname,/SHELL=\//);
    record('real serial input executes uname in Linux',uname.trim());

    const fileToken=randomUUID().replaceAll('-','');
    const fileOutput=await runShell(`file=/tmp/browser-linux-acceptance-${fileToken}; printf '%s_%s\\n' 'BROWSER_LINUX_FILE' '${fileToken}' > "$file" && cat "$file" && wc -c < "$file"`,'guest filesystem write/read');
    const expected=`BROWSER_LINUX_FILE_${fileToken}`;
    assert.ok(fileOutput.split('\n').includes(expected),'Guest cat did not return the bytes written by the shell');
    assert.ok(fileOutput.split('\n').some(line=>line.trim()===String(Buffer.byteLength(expected+'\n'))),'Guest byte count differs');
    record('guest shell writes and reads exact bytes through the real filesystem');

    const processes=await runShell(`printf 'INIT='; cat /proc/1/comm; cat /proc/version; head -n 3 /proc/meminfo; for entry in /proc/[0-9]*/comm; do name=$(cat "$entry" 2>/dev/null) || continue; case "$name" in weston|weston-terminal|seatd) pid="\${entry%/comm}"; pid="\${pid##*/}"; state=$(sed -n 's/^State:[[:space:]]*//p' "/proc/$pid/status"); printf 'PROC %s %s %s\\n' "$pid" "$name" "$state";; esac; done; test -S /run/user/0/wayland-0 && printf 'WAYLAND_SOCKET_PRESENT\\n'`,'live proc and Wayland socket inspection');
    assert.match(processes,/INIT=\S+/);assert.match(processes,/Linux version\s+\S+/);
    assert.match(processes,/MemTotal:\s+\d+ kB/);
    for(const name of ['weston','weston-terminal','seatd']){
      assert.match(processes,new RegExp(`(?:^|\\n)PROC \\d+ ${name} [RSDITt]\\b`),`No live ${name} process in /proc`);
    }
    assert.match(processes,/(?:^|\n)WAYLAND_SOCKET_PRESENT(?:\n|$)/);
    const compositorPid=entry.guest.serial.match(/BROWSER_LINUX_WAYLAND_READY compositor_pid=(\d+)/)[1];
    const clientPid=entry.guest.serial.match(/BROWSER_LINUX_WAYLAND_CLIENT_STARTED terminal_pid=(\d+)/)[1];
    assert.match(processes,new RegExp(`PROC ${compositorPid} weston `));
    assert.match(processes,new RegExp(`PROC ${clientPid} weston-terminal `));
    record('live /proc processes match compositor/client marker PIDs and the Wayland socket exists');

    await guest.locator('#show-desktop').click({timeout:remaining(10000)});
    const canvas=guest.locator('#canvas');
    await canvas.waitFor({state:'visible',timeout:remaining(10000)});
    await canvas.scrollIntoViewIfNeeded({timeout:remaining(10000)});
    async function sampleDisplayedCanvas(){
    const screenshot=await canvas.screenshot({path:path.join(results,`compatibility-${name}-canvas.png`),timeout:remaining(15000)});
    // Inspect screenshot pixels through a disposable browser canvas. This does
    // not ask the transferred guest canvas for a new rendering context.
    return page.evaluate(async base64=>{
      const image=new Image();image.src='data:image/png;base64,'+base64;await image.decode();
      const sample=document.createElement('canvas');sample.width=64;sample.height=64;
      const drawing=sample.getContext('2d');drawing.drawImage(image,0,0,64,64);
      const pixels=drawing.getImageData(0,0,64,64).data,colors=new Set();
      for(let i=0;i<pixels.length;i+=4)colors.add(`${pixels[i]},${pixels[i+1]},${pixels[i+2]},${pixels[i+3]}`);
      // Weston uses a blue desktop background and a dark terminal interior.
      // Pick a real image-derived click candidate, avoiding the top panel.
      // The later file proof, not this heuristic, decides whether input worked.
      const visited=new Uint8Array(64*64),regions=[];
      const dark=index=>pixels[index*4+3]>0&&Math.max(pixels[index*4],pixels[index*4+1],pixels[index*4+2])<48;
      for(let index=0;index<visited.length;index++){
        if(visited[index]||!dark(index))continue;
        const queue=[index];visited[index]=1;let left=63,right=0,top=63,bottom=0;
        for(let at=0;at<queue.length;at++){
          const value=queue[at],x=value%64,y=Math.floor(value/64);
          left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);
          for(const next of [x>0?value-1:-1,x<63?value+1:-1,y>0?value-64:-1,y<63?value+64:-1]){
            if(next>=0&&!visited[next]&&dark(next)){visited[next]=1;queue.push(next);}
          }
        }
        if(queue.length>=64&&right-left>=8&&bottom-top>=8)regions.push({pixels:queue.length,x:(left+right+1)/128,y:(top+bottom+1)/128});
      }
      regions.sort((a,b)=>b.pixels-a.pixels);
      return {width:image.naturalWidth,height:image.naturalHeight,sampledColors:colors.size,
        focusCandidate:regions[0]?{x:regions[0].x,y:regions[0].y,source:'largest dark image region'}:null};
    },screenshot.toString('base64'));
    }
    // Browsers may defer iframe animation frames while it is offscreen. A live
    // compositor marker precedes its first displayed frame, so wait on actual
    // pixels after scrolling, without treating elapsed time as successful paint.
    const paintStart=Date.now(),paintDeadline=paintStart+remaining(30000);
    entry.paintSamples=[];
    do{
      entry.canvas=await sampleDisplayedCanvas();
      entry.paintSamples.push({elapsedMs:Date.now()-paintStart,colors:entry.canvas.sampledColors,terminalInterior:!!entry.canvas.focusCandidate});
      if(entry.canvas.sampledColors>=4&&entry.canvas.focusCandidate)break;
      await new Promise(resolve=>setTimeout(resolve,Math.max(1,Math.min(1000,paintDeadline-Date.now()))));
    }while(Date.now()<paintDeadline);
    assert.ok(entry.canvas.width>=320&&entry.canvas.height>=200,'Guest canvas is too small to show the desktop');
    if(entry.canvas.sampledColors<4||!entry.canvas.focusCandidate){
      try{
        entry.displayDiagnostic=await runShell(guestStartupDiagnostics,
          'read-only startup logs after first desktop frame failed to appear',15000);
      }catch(error){entry.displayDiagnosticError=error.message;}
    }
    assert.ok(entry.canvas.sampledColors>=4,'Guest canvas screenshot is blank or effectively uniform');
    assert.ok(entry.canvas.focusCandidate,'The configured dark graphical terminal did not become visible within the first-frame deadline');
    await page.screenshot({path:path.join(results,`compatibility-${name}-page.png`),fullPage:true,timeout:remaining(15000)});
    record('real guest canvas is displayed and a nonblank desktop screenshot is saved',entry.canvas);

    const graphicalToken=randomUUID().replaceAll('-','').slice(0,20);
    const graphicalPath=`/root/browser-graphical-${graphicalToken}`;
    const graphicalContents=`graphical-keyboard-${graphicalToken}`;
    // This check never writes the proof file through serial, guestEngine.FS,
    // or a fixture. Only actual browser keyboard events can create the file.
    await runShell(`test ! -e '${graphicalPath}'`,'graphical proof file does not already exist');
    const candidates=[entry.canvas.focusCandidate,{x:0.5,y:0.5,source:'canvas center'}].filter(Boolean)
      .filter((point,index,array)=>!array.slice(0,index).some(other=>Math.abs(point.x-other.x)<0.05&&Math.abs(point.y-other.y)<0.05));
    entry.graphicalInput={path:graphicalPath,expected:graphicalContents,attempts:[],passed:false};
    for(const candidate of candidates){
      await guest.locator('#show-desktop').click({timeout:remaining(10000)});
      const bounds=await canvas.boundingBox();assert.ok(bounds,'Graphical canvas has no displayed bounds');
      await canvas.click({position:{x:bounds.width*candidate.x,y:bounds.height*candidate.y},timeout:remaining(10000)});
      assert.equal(await guest.evaluate(()=>document.activeElement?.id),'canvas','Keyboard focus did not enter the guest canvas');
      await page.keyboard.press('Control+u');
      await page.keyboard.type(`echo ${graphicalContents} > ${graphicalPath}`,{delay:150});
      await page.keyboard.press('Enter');
      // Leave the canvas visible while serial independently waits for the file.
      // A hidden canvas or the wrong QEMU text console cannot pass this proof.
      const output=await runShell(`for i in 1 2 3 4 5 6 7 8 9 10; do test -f '${graphicalPath}' && break; sleep 0.1; done; if test -f '${graphicalPath}'; then cat '${graphicalPath}'; else printf 'GRAPHICAL_FILE_MISSING\\n'; fi`,
        'independent serial read of graphical keyboard result',20000);
      entry.graphicalInput.attempts.push({candidate,output});
      if(output.split('\n').includes(graphicalContents)){entry.graphicalInput.passed=true;break;}
    }
    await canvas.screenshot({path:path.join(results,`compatibility-${name}-graphical-input.png`),timeout:remaining(15000)});
    assert.equal(entry.graphicalInput.passed,true,
      'Graphical keyboard input did not create the unique file. Kernel/Wayland markers or a colored text-console canvas are not desktop acceptance.');
    record('actual graphical keyboard input writes a unique guest file independently read through serial',entry.graphicalInput);
    entry.guest=await guestState();
    assert.notEqual(entry.guest.state,'error',entry.guest.message);
    assert.deepEqual(entry.errors,[],'Uncaught browser errors were recorded');
    record('no uncaught browser errors during the genuine boot and shell tests');
    entry.persistence={requested:persistence,passed:null,...(!persistence?{reason:'Not requested; run with COMPATIBILITY_PERSISTENCE=1 for the real save/reload proof.'}:{})};
    if(persistence){
      assert.equal(entry.guest.persistentDisk,true,'Persistence was requested but this verified build does not support saving');
      assert.equal(entry.guest.exchangeReady,true,'Guest shutdown control is unavailable');
      assert.equal(entry.guest.restoredDisk?.restored,false,'A fresh browser context unexpectedly restored an existing snapshot');
      const directory=`/root/browser-persistence-${graphicalToken}`;
      const setup=`mkdir '${directory}' && printf '\\000\\001\\177\\200\\377\\012' > '${directory}/bytes' && chmod 0640 '${directory}/bytes' && chown 1234:2345 '${directory}/bytes' && ln '${directory}/bytes' '${directory}/hard' && ln -s '../browser-graphical-${graphicalToken}' '${directory}/link' && chmod 0750 '${directory}' && chown 42:43 '${directory}' && sync`;
      await runShell(setup,'create persistent binary bytes and Unix filesystem metadata');
      const verify=`test "$(cat '${graphicalPath}')" = '${graphicalContents}' && test "$(od -An -v -tx1 '${directory}/bytes' | tr -d ' \\n')" = 00017f80ff0a && test "$(stat -c '%a:%u:%g:%h' '${directory}/bytes')" = 640:1234:2345:2 && test "$(stat -c '%a:%u:%g' '${directory}')" = 750:42:43 && test "$(stat -c '%i' '${directory}/bytes')" = "$(stat -c '%i' '${directory}/hard')" && test "$(readlink '${directory}/link')" = '../browser-graphical-${graphicalToken}' && test "$(cat '${directory}/link')" = '${graphicalContents}' && printf 'PERSISTENT_UNIX_BYTES_AND_METADATA_OK\\n'`;
      assert.match(await runShell(verify,'verify persistence data before shutdown'),/(?:^|\n)PERSISTENT_UNIX_BYTES_AND_METADATA_OK(?:\n|$)/);
      entry.persistence.directory=directory;
      armDeadline('shutdown and save',120000);
      await guest.locator('#save-disk').click({timeout:remaining(10000)});
      await guest.waitForFunction(()=>['saved','save-error','error'].includes(window.guestReport?.state),null,
        {timeout:remaining(120000),polling:100});
      const saved=await guestState();entry.persistence.saved=saved;
      assert.equal(saved.state,'saved',saved.saveError||saved.message);
      assert.equal(saved.exitCode,0,'Snapshot must follow successful real QEMU shutdown');
      assert.match(saved.savedDisk?.id||'',/^[a-f0-9-]{36}$/);
      assert.ok(saved.savedDisk.changedBlocks>0,'Guest changes did not produce any stored disk blocks');
      record('actual shutdown control stops Linux before committing its changed disk blocks',saved.savedDisk);
      // Reload the whole parent page in the SAME context: IndexedDB survives,
      // while all in-memory Linux/QEMU state and browser runtime objects die.
      armDeadline('saved disk reload',240000);
      await page.reload({waitUntil:'domcontentloaded',timeout:remaining(30000)});
      await page.waitForFunction(()=>{const button=document.getElementById('start-compatibility');return button&&!button.disabled;},null,
        {timeout:remaining(30000),polling:100});
      await page.locator('#disk-mode').selectOption('current');
      await page.locator('#start-compatibility').click({timeout:remaining(10000)});
      const restoredFrame=await page.locator('#session-container iframe').elementHandle({timeout:remaining(10000)});
      await restoredFrame.scrollIntoViewIfNeeded({timeout:remaining(10000)});
      guest=await restoredFrame.contentFrame();assert.ok(guest,'Reload did not create a new guest iframe');
      await guest.waitForFunction(()=>!!window.guestReport,null,{timeout:remaining(15000)});
      const restored=await waitForDesktop();entry.persistence.restored=restored.restoredDisk;
      assert.match(restored.serial,/BROWSER_LINUX_GUEST_BOOT arch=x86_64 kernel=\S+/);
      assert.equal(restored.restoredDisk?.restored,true);
      assert.equal(restored.restoredDisk.id,saved.savedDisk.id);
      assert.equal(restored.restoredDisk.currentId,saved.savedDisk.id);
      assert.match(await runShell(verify,'read saved graphical bytes, binary bytes, modes, ownership, symlink and hard link after a real reboot'),
        /(?:^|\n)PERSISTENT_UNIX_BYTES_AND_METADATA_OK(?:\n|$)/);
      await guest.locator('#show-desktop').click({timeout:remaining(10000)});
      await guest.locator('#canvas').screenshot({path:path.join(results,`compatibility-${name}-restored.png`),timeout:remaining(15000)});
      assert.deepEqual(entry.errors,[],'Uncaught browser errors were recorded during save or restore');
      entry.persistence.passed=true;
      record('full parent reload boots the saved disk and preserves graphical bytes plus Unix file metadata');
    }
    await page.locator('#stop-compatibility').click({timeout:remaining(10000)});
    assert.equal(await page.locator('#session-container iframe').count(),0);
    assert.equal(await page.locator('#start-compatibility').isEnabled(),true);
    record('Stop removes the session and permits a fresh start');
    if(entry.workers.length){
      const cleanupDeadline=Date.now()+remaining(10000);
      while(entry.workers.some(worker=>worker.closedMs===undefined)&&Date.now()<cleanupDeadline){
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      assert.deepEqual(entry.workers.filter(worker=>worker.closedMs===undefined),[],'Session workers remained alive after Stop');
      record('all browser-observed dedicated workers close after Stop');
    }else{
      entry.workerCleanup='Not observable through this browser backend; iframe removal alone is verified.';
    }
    entry.passed=true;
  }catch(error){
    entry.passed=false;entry.failure=timedOut?`Engine exceeded ${phaseBudget} ms ${phase} deadline: ${error.message}`:error.stack;
    console.error('FAIL',name,entry.failure);
    if(page&&!page.isClosed()){
      entry.parent=await parentState().catch(diagnosticError=>({error:diagnosticError.message}));
      entry.guest=await guestState().catch(diagnosticError=>({error:diagnosticError.message}));
      await page.screenshot({path:path.join(results,`compatibility-${name}-failure.png`),fullPage:true,timeout:10000}).catch(screenshotError=>{entry.screenshotFailure=screenshotError.message;});
    }
  }finally{
    clearTimeout(deadlineTimer);entry.elapsedMs=Date.now()-start;
    await context?.close().catch(()=>{});await browser?.close().catch(()=>{});
    if(persistentProfile){
      try{
        const resolvedRoot=await fs.realpath(root),resolvedProfile=await fs.realpath(persistentProfile);
        const relative=path.relative(resolvedRoot,resolvedProfile);
        assert.ok(relative&&!path.isAbsolute(relative)&&!relative.startsWith('..'),
          'Refusing to remove a browser profile outside the project');
        assert.equal(path.dirname(persistentProfile),temporary);
        assert.ok(path.basename(persistentProfile).startsWith('compatibility-webkit-'));
        await fs.rm(persistentProfile,{recursive:true,force:true,maxRetries:5,retryDelay:100});
      }catch(error){entry.profileCleanupError=error.message;}
    }
    report.passed=report.engines.length>0&&report.engines.every(value=>value.passed===true);
    report.finishedAt=new Date().toISOString();
    await fs.writeFile(path.join(results,'compatibility-report.json'),JSON.stringify(report,null,2)+'\n');
  }
}
if(!report.passed)process.exitCode=1;

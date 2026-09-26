// SPDX-License-Identifier: GPL-2.0-only
// Development diagnostic: runs a Browser Linux session in installed Chrome,
// optionally starts a command in the guest, and when the emulator stops
// answering its monitor, captures the JavaScript/WebAssembly stack of every
// worker thread through the DevTools protocol. Needs the local server.
//   node tools/hang-probe.mjs [session query] [guest command]
// Writes test-results/hang-probe.json.
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const query = process.argv[2] || 'memory=3072&cpus=4&disk=temporary&network=on&verbose=1';
const guestCommand = process.argv[3] || '';
const port = 9333;
const server = process.env.PROBE_SERVER || 'http://127.0.0.1:4180';
const chrome = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const profile = path.join(root, '.cache', 'hang-probe-profile');
const out = path.join(root, 'test-results', 'hang-probe.json');
const report = {query, guestCommand, started: new Date().toISOString(), samples: [], stacks: null};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

await fs.rm(profile, {recursive: true, force: true});
const browser = spawn(chrome, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--no-first-run',
  '--no-default-browser-check', '--enable-features=SharedArrayBuffer', 'about:blank'], {stdio: 'ignore'});

let version;
for (let i = 0; i < 50 && !version; i++) {
  await sleep(200);
  version = await fetch(`http://127.0.0.1:${port}/json/version`).then(r => r.json()).catch(() => null);
}
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise(resolve => ws.addEventListener('open', resolve, {once: true}));
let nextId = 1;
const waiting = new Map(), listeners = [];
ws.addEventListener('message', ({data}) => {
  const message = JSON.parse(data);
  if (message.id && waiting.has(message.id)) {
    const {resolve, reject} = waiting.get(message.id);
    waiting.delete(message.id);
    message.error ? reject(new Error(message.error.message)) : resolve(message.result);
  } else if (message.method) {
    for (const listener of listeners) listener(message);
  }
});
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = nextId++;
  waiting.set(id, {resolve, reject});
  ws.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}));
});

// Attach to the page, then to each worker it starts.
const workers = new Map();
listeners.push(message => {
  if (message.method === 'Target.attachedToTarget') {
    const {sessionId, targetInfo} = message.params;
    if (targetInfo.type === 'worker') workers.set(sessionId, targetInfo.url);
    send('Target.setAutoAttach', {autoAttach: true, waitForDebuggerOnStart: false, flatten: true}, sessionId).catch(() => {});
    send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
  }
});
const {targetInfos} = await send('Target.getTargets');
const pageTarget = targetInfos.find(t => t.type === 'page');
const {sessionId: pageSession} = await send('Target.attachToTarget', {targetId: pageTarget.targetId, flatten: true});
await send('Target.setAutoAttach', {autoAttach: true, waitForDebuggerOnStart: false, flatten: true}, pageSession);
await send('Page.navigate', {url: `${server}/compatibility-session.html?${query}`}, pageSession);

const evaluate = async (expression, timeout = 20000) => {
  const result = await Promise.race([
    send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true}, pageSession),
    sleep(timeout).then(() => ({result: {value: 'EVALUATE TIMEOUT'}}))]);
  return result.result?.value;
};

async function captureStacks() {
  const stacks = [];
  for (const [sessionId, url] of workers) {
    try {
      await send('Debugger.enable', {}, sessionId);
      const paused = new Promise(resolve => {
        const listener = message => {
          if (message.sessionId === sessionId && message.method === 'Debugger.paused') {
            listeners.splice(listeners.indexOf(listener), 1);
            resolve(message.params.callFrames.map(frame => `${frame.functionName || '(anonymous)'} ${frame.url.split('/').pop()}:${frame.location.lineNumber}`));
          }
        };
        listeners.push(listener);
      });
      await send('Debugger.pause', {}, sessionId);
      const frames = await Promise.race([paused, sleep(10000).then(() => ['(did not pause within 10 s: blocked outside JavaScript, e.g. Atomics.wait)'])]);
      stacks.push({url, frames});
      await send('Debugger.resume', {}, sessionId).catch(() => {});
      await send('Debugger.disable', {}, sessionId).catch(() => {});
    } catch (error) {
      stacks.push({url, error: error.message});
    }
  }
  return stacks;
}

// Liveness: once the serial shell is up, each sample types "echo tick-N"
// and checks that the previous tick came back. The display is sampled too.
const started = Date.now();
let commandSent = !guestCommand, missed = 0, tick = 0;
try {
  while (Date.now() - started < 90 * 60000) {
    await sleep(20000);
    const sample = await evaluate(`(async () => {
      const r = window.guestReport || {};
      const race = (p, ms) => Promise.race([p, new Promise(res => setTimeout(() => res('TIMEOUT'), ms))]);
      const qmp = window.guestMonitor?.ready ? await race(window.guestMonitor.execute('query-status').then(s => s.status).catch(e => 'ERR ' + e.message), 8000) : 'not ready';
      let display = null;
      try {
        const c = document.getElementById('canvas'), probe = document.createElement('canvas');
        probe.width = 64; probe.height = 36; const g = probe.getContext('2d'); g.drawImage(c, 0, 0, 64, 36);
        const d = g.getImageData(0, 0, 64, 36).data; let h = 0; for (let i = 0; i < d.length; i++) h = (h * 31 + d[i]) >>> 0; display = h;
      } catch {}
      const serial = r.serial || '';
      return {t: Math.round(performance.now() / 1000), state: r.state, serialLen: serial.length, qmp, display,
        ready: serial.includes('BROWSER_LINUX_SERIAL_READY'), ticks: (serial.match(/tick-[0-9]+-ok/g) || []).slice(-1)[0] || '',
        tail: serial.slice(-120), jit: (r.logs || []).filter(l => l.includes('JIT')).slice(-1)[0] || ''};
    })()`);
    // Largest Chrome process (the tab's renderer) in MiB, via wmic on Windows.
    if (typeof sample === 'object') {
      try {
        const {execSync} = await import('node:child_process');
        const rows = execSync('wmic process where "name=\'chrome.exe\'" get PrivatePageCount /format:csv', {encoding: 'utf8'});
        sample.chromeMiB = Math.max(...rows.split(/\r?\n/).map(line => Number(line.split(',')[1]) || 0)) / 1048576 | 0;
      } catch {}
    }
    report.samples.push(sample);
    console.log(JSON.stringify(sample));
    if (typeof sample !== 'object') { if (++missed >= 3) { report.stacks = await captureStacks(); break; } continue; }
    if (sample.state === 'error') break;
    if (!sample.ready) continue;
    if (!commandSent) {
      await evaluate(`window.guestTerminal.input(${JSON.stringify(guestCommand + '\r')}, true), true`);
      commandSent = true;
      report.commandAt = sample.t;
      continue;
    }
    if (tick > 0) missed = sample.ticks === `tick-${tick}-ok` ? 0 : missed + 1;
    if (missed >= 4) {
      report.frozenAt = sample.t;
      report.stacks = await captureStacks();
      break;
    }
    tick++;
    await evaluate(`window.guestTerminal.input('echo tick-${tick}-ok\\r', true), true`);
  }
} finally {
  report.finished = new Date().toISOString();
  report.logs = await evaluate('(window.guestReport?.logs || []).slice(-40)').catch(() => null);
  await fs.mkdir(path.dirname(out), {recursive: true});
  await fs.writeFile(out, JSON.stringify(report, null, 2));
  console.log('wrote ' + out);
  ws.close();
  browser.kill();
}

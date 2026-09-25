// SPDX-License-Identifier: GPL-2.0-only
// Browser acceptance for the Debian desktop engine, driven through the real
// Start Linux page in installed Chrome. Needs the local server (node
// tools/serve.mjs) and an assembled build. Never mocks guest success.
//   DESKTOP_MEMORY=2048 DESKTOP_CPUS=2   guest size
//   DESKTOP_PERSISTENCE=0                skip the shutdown/restart disk check
//   DESKTOP_LAUNCHER=1                   also install and open the official Minecraft Launcher
//   DESKTOP_KEEP_PROFILE=1               keep the browser profile (and its saved disk)
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const results = path.join(root, 'test-results');
const profile = path.join(root, '.cache', 'desktop-test-profile');
await fs.mkdir(results, {recursive: true});
const portable = path.join(root, '.cache', 'playwright-browsers');
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && await fs.stat(portable).then(() => true, () => false)) process.env.PLAYWRIGHT_BROWSERS_PATH = portable;
const {chromium} = await import('playwright');
const target = new URL(process.env.DESKTOP_URL || 'http://127.0.0.1:4173/compatibility.html');
const memory = process.env.DESKTOP_MEMORY || '2048', cpus = process.env.DESKTOP_CPUS || '2';
const persistence = process.env.DESKTOP_PERSISTENCE !== '0', launcher = process.env.DESKTOP_LAUNCHER === '1';
const report = {startedAt: new Date().toISOString(), target: target.href, memory, cpus, checks: [], timings: {}};
const started = Date.now();
const elapsed = () => Math.round((Date.now() - started) / 1000);
const pass = (check, details) => {report.checks.push({check, passed: true, ...(details ? {details} : {})}); console.log(`PASS [${elapsed()}s] ${check}`);};

function shellCommand(command, nonce) {
  return `printf '\\n__BL_%s_BEGIN__\\n' '${nonce}'; ( ${command} ); bl_rc=$?; printf '\\n__BL_%s_EXIT_%s__\\n' '${nonce}' "$bl_rc"\r`;
}
const clean = value => value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
function physicalKey(character) {
  if (/^[a-z]$/.test(character)) return {code: 'Key' + character.toUpperCase(), shift: false};
  if (/^[0-9]$/.test(character)) return {code: 'Digit' + character, shift: false};
  const keys = {' ': ['Space'], '/': ['Slash'], '-': ['Minus'], '.': ['Period'], '>': ['Period', true], '\n': ['Enter']};
  assert.ok(keys[character], `No physical key for ${JSON.stringify(character)}`);
  return {code: keys[character][0], shift: !!keys[character][1]};
}

let context, page, guest;
async function state() {return guest.evaluate(() => ({...window.guestReport, serial: undefined}));}
async function runShell(command, label, timeout = 120000) {
  const nonce = randomUUID().replaceAll('-', '');
  await guest.evaluate(input => window.guestTerminal.input(input, true), shellCommand(command, nonce));
  await guest.waitForFunction(nonce => window.guestReport?.state === 'error'
    || new RegExp(`__BL_${nonce}_EXIT_[0-9]+__`).test(window.guestReport?.serial || ''), nonce, {timeout, polling: 250});
  const serial = clean(await guest.evaluate(() => window.guestReport.serial));
  const begin = `__BL_${nonce}_BEGIN__\n`, at = serial.lastIndexOf(begin);
  const end = serial.match(new RegExp(`\\n__BL_${nonce}_EXIT_([0-9]+)__`));
  assert.ok(at >= 0 && end, `${label}: no framed output`);
  const output = serial.slice(at + begin.length, end.index);
  report.shell ??= []; report.shell.push({label, output: output.slice(-4000), exitCode: Number(end[1])});
  assert.equal(Number(end[1]), 0, `${label} failed:\n${output}`);
  return output;
}
async function typePhysical(text) {
  for (const character of text) {
    const key = physicalKey(character);
    if (key.shift) await page.keyboard.down('Shift');
    try {await page.keyboard.press(key.code, {delay: 30});}
    finally {if (key.shift) await page.keyboard.up('Shift');}
    await new Promise(resolve => setTimeout(resolve, 60));
  }
}
async function startSession(label) {
  await page.goto(target.href, {waitUntil: 'load'});
  await page.waitForFunction(() => !document.getElementById('start-compatibility').disabled, null, {timeout: 60000});
  await page.selectOption('#guest-memory', memory);
  await page.selectOption('#guest-cpus', cpus);
  await page.selectOption('#disk-mode', 'saved');
  const relay = await page.evaluate(() => !document.getElementById('guest-network').disabled);
  report.networkRelay = relay;
  if (relay) await page.check('#guest-network');
  await page.click('#start-compatibility');
  const handle = await page.waitForSelector('#session-container iframe');
  guest = await handle.contentFrame();
  const bootStarted = Date.now();
  await guest.waitForFunction(() => window.guestReport?.serialMs || window.guestReport?.state === 'error', null, {timeout: 600000, polling: 1000});
  let current = await state();
  assert.notEqual(current.state, 'error', current.message);
  report.timings[label + 'SerialSeconds'] = Math.round((Date.now() - bootStarted) / 1000);
  await guest.waitForFunction(() => window.guestReport?.wayland || window.guestReport?.state === 'error'
    || /BROWSER_LINUX_(GRAPHICS|WAYLAND_CLIENT)_FAILED/.test(window.guestReport?.serial || ''), null, {timeout: 600000, polling: 1000});
  current = await state();
  assert.equal(current.wayland, true, 'desktop did not start: ' + current.message);
  report.timings[label + 'DesktopSeconds'] = Math.round((Date.now() - bootStarted) / 1000);
  return current;
}
async function canvasShot(name) {
  const canvas = await guest.$('#canvas');
  await canvas.screenshot({path: path.join(results, `desktop-${name}.png`)});
}

try {
  if (process.env.DESKTOP_KEEP_PROFILE !== '1') await fs.rm(profile, {recursive: true, force: true});
  context = await chromium.launchPersistentContext(profile, {channel: 'chrome', viewport: {width: 1440, height: 1000},
    args: ['--enable-features=SharedArrayBuffer']});
  page = context.pages()[0] || await context.newPage();
  page.on('console', message => {if (message.type() === 'error') (report.console ??= []).push(message.text());});
  report.browser = context.browser()?.version?.() || 'chrome';

  let current = await startSession('first');
  pass('Debian desktop booted through the Start Linux page', {serialSeconds: report.timings.firstSerialSeconds, desktopSeconds: report.timings.firstDesktopSeconds});
  await canvasShot('booted');

  const system = await runShell('uname -m; uname -r; . /etc/os-release; echo "$PRETTY_NAME"; pgrep -a -u user | head -n 20; cat /proc/meminfo | head -n 2; nproc', 'system');
  assert.match(system, /x86_64/); assert.match(system, /Debian GNU\/Linux 13/); assert.match(system, /weston/);
  report.system = system;
  pass('Real x86-64 Debian 13 with Weston running as the desktop user');

  if (report.networkRelay) {
    const net = await runShell("curl -sS -o /dev/null -w 'HTTP=%{http_code} TIME=%{time_total}\\n' https://deb.debian.org/debian/dists/trixie/Release", 'network', 180000);
    assert.match(net, /HTTP=200/);
    pass('Guest reached HTTPS on the Internet through the local relay', {net: net.trim()});
  }

  const nonce = randomUUID().slice(0, 8).replace(/[^a-z0-9]/g, 'x');
  const expected = `graphicsproof-${nonce}`;
  // DOM focus only: a click would also reach Linux and could move its focus.
  await guest.focus('#canvas');
  await typePhysical(`echo ${expected} > /tmp/graphics.txt\n`);
  await new Promise(resolve => setTimeout(resolve, 3000));
  const typed = await runShell('cat /tmp/graphics.txt', 'graphical input', 60000);
  assert.equal(typed.trim(), expected, 'Typed text reached Linux with missing or repeated keys');
  pass('Physical keyboard typing into the Wayland terminal arrived exactly (no dropped or repeated keys)');
  await canvasShot('typed');

  if (launcher) {
    const launchStarted = Date.now();
    await runShell('runuser -u user -- env HOME=/home/user XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0 DISPLAY=:0 setsid /usr/local/bin/minecraft-launcher > /tmp/launcher.log 2>&1 < /dev/null &', 'launch launcher');
    let windows = '';
    const deadline = Date.now() + Number(process.env.DESKTOP_LAUNCHER_TIMEOUT || 1800000);
    while (Date.now() < deadline) {
      windows = await runShell("runuser -u user -- env DISPLAY=:0 xwininfo -root -tree | grep -i -E '\"[^\"]*(minecraft|launcher)' | head -n 5; tail -n 3 /tmp/launcher.log", 'launcher windows');
      if (/"[^"]*(Minecraft|Launcher)[^"]*"/.test(windows)) break;
      await new Promise(resolve => setTimeout(resolve, 20000));
    }
    report.launcher = {windows, seconds: Math.round((Date.now() - launchStarted) / 1000)};
    await canvasShot('launcher');
    assert.match(windows, /"[^"]*(Minecraft|Launcher)[^"]*"/, 'The official launcher did not open a window');
    pass('Official Minecraft Launcher was downloaded from Mojang and opened a window', report.launcher);
  }

  if (persistence) {
    const marker = `persist-${randomUUID()}`;
    await runShell(`echo ${marker} > /home/user/persistence.txt && chown user:user /home/user/persistence.txt && sync`, 'write persistence marker');
    await guest.click('#shutdown');
    await guest.waitForFunction(() => ['stopped', 'error'].includes(window.guestReport?.state), null, {timeout: 180000, polling: 500});
    current = await state();
    assert.equal(current.state, 'stopped', current.message);
    pass('Shut down cleanly and closed the disk');
    await startSession('second');
    const again = await runShell('cat /home/user/persistence.txt', 'read persistence marker');
    assert.equal(again.trim(), marker);
    pass('A file written before shutdown was present after starting Linux again', {secondDesktopSeconds: report.timings.secondDesktopSeconds});
  }
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.stack || String(error);
  console.error(error);
  try {await page?.screenshot({path: path.join(results, 'desktop-failure.png'), fullPage: true});} catch {}
} finally {
  try {
    const final = guest ? await guest.evaluate(() => ({state: window.guestReport?.state, message: window.guestReport?.message,
      serial: window.guestReport?.serial?.slice(-20000), logs: window.guestReport?.logs?.slice(-80), disk: window.guestReport?.disk,
      arguments: window.guestReport?.arguments})) : null;
    report.final = final;
  } catch {}
  report.elapsedSeconds = elapsed();
  await fs.writeFile(path.join(results, 'desktop-report.json'), JSON.stringify(report, null, 2));
  await context?.close();
  console.log(JSON.stringify({passed: report.passed, timings: report.timings, elapsedSeconds: report.elapsedSeconds, error: report.error?.split('\n')[0]}));
  process.exitCode = report.passed ? 0 : 1;
}

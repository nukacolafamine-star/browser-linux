// SPDX-License-Identifier: GPL-2.0-only
// Engine selection must depend on working primitives, never a browser name.
const i64Program = new Uint8Array([
  0,97,115,109,1,0,0,0,1,9,2,96,0,1,126,96,0,1,127,
  2,16,1,3,101,110,118,6,109,101,109,111,114,121,2,3,1,1,
  3,3,2,0,1,7,22,2,6,97,110,115,119,101,114,0,0,
  9,105,110,99,114,101,109,101,110,116,0,1,
  10,17,2,4,0,66,42,11,10,0,65,0,65,1,254,30,2,0,11,
]);

async function sharedWorkerProbe() {
  let worker;
  let timer;
  try {
    const memory = new WebAssembly.Memory({initial: 1, maximum: 1, shared: true});
    const view = new Int32Array(memory.buffer);
    Atomics.store(view, 0, 41);
    worker = new Worker(new URL('./capability-worker.js', import.meta.url));
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Worker check timed out')), 8000);
      worker.onerror = event => {event.preventDefault(); reject(new Error(event.message || 'Worker failed'));};
      worker.onmessage = ({data}) => data?.ok === true && Atomics.load(view, 0) === 42
        ? resolve() : reject(new Error(data?.error || 'Shared-memory check failed'));
      worker.postMessage({memory, program: i64Program});
    });
    return {available: true, detail: 'Worker executed WebAssembly i64 and an atomic shared-memory increment.'};
  } catch (error) {
    return {available: false, detail: error.message};
  } finally {
    clearTimeout(timer);
    worker?.terminate();
  }
}

export async function detectCapabilities({graphics = false} = {}) {
  const report = {
    checkedAt: new Date().toISOString(),
    secureContext: globalThis.isSecureContext === true,
    isolated: globalThis.crossOriginIsolated === true,
    webAssembly: typeof WebAssembly === 'object',
    sharedMemory: typeof SharedArrayBuffer === 'function',
    workers: {available: false, detail: 'Shared WebAssembly memory is unavailable.'},
    storage: {opfsAPI: typeof navigator.storage?.getDirectory === 'function'},
    graphics: {checked: false, webgl2: false, webgpu: false, guestAcceleration: false},
  };
  if (report.webAssembly && report.sharedMemory && typeof Worker === 'function') {
    report.workers = await sharedWorkerProbe();
  }
  if (graphics) {
    report.graphics.checked = true;
    const canvas = document.createElement('canvas');
    try {
      const gl = canvas.getContext('webgl2');
      report.graphics.webgl2 = !!gl;
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
    } catch { /* The browser may expose an API but deny its use. */ }
    if (navigator.gpu) {
      let timer;
      try {
        // API exposure is insufficient: a browser may have no usable adapter.
        const adapter = await Promise.race([
          navigator.gpu.requestAdapter(),
          new Promise((_, reject) => {timer = setTimeout(() => reject(new Error('GPU adapter check timed out')), 5000);}),
        ]);
        report.graphics.webgpu = !!adapter;
        report.graphics.fallbackAdapter = adapter?.info?.isFallbackAdapter ?? null;
      } catch (error) {report.graphics.detail = error.message;}
      finally {clearTimeout(timer);}
    }
  }
  report.compatibilityEngine = report.secureContext && report.isolated
    && report.webAssembly && report.sharedMemory && report.workers.available;
  // Passing this small probe never claims a device can allocate a whole guest.
  report.memoryBudget = 'Unknown until an engine successfully allocates memory.';
  return report;
}

export function missingRequirements(report) {
  const missing = [];
  if (!report.secureContext) missing.push('an HTTPS connection');
  if (!report.isolated) missing.push('browser isolation');
  if (!report.webAssembly) missing.push('WebAssembly');
  if (!report.sharedMemory) missing.push('shared memory');
  if (!report.workers.available) missing.push('working WebAssembly workers');
  return missing;
}

// SPDX-License-Identifier: GPL-2.0-only
// Exercise the same worker/shared-memory primitives used by the engines.
self.onmessage = async ({data}) => {
  try {
    const {instance} = await WebAssembly.instantiate(data.program, {env: {memory: data.memory}});
    if (instance.exports.answer() !== 42n) throw new Error('Incorrect WebAssembly i64 result');
    const shared = new Int32Array(data.memory.buffer);
    if (instance.exports.increment() !== 41) throw new Error('Incorrect WebAssembly atomic result');
    self.postMessage({ok: Atomics.load(shared, 0) === 42});
  } catch (error) {
    self.postMessage({ok: false, error: error.message});
  }
};

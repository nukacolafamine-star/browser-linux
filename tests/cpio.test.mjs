import test from 'node:test';import assert from 'node:assert/strict';import {unpackCpio,packCpio} from '../tools/cpio.mjs';
test('initramfs round trip preserves regular files, symlinks and device nodes',()=>{
  const original=new Map([['dev',{mode:0o40755,data:Buffer.alloc(0)}],['dev/console',{mode:0o20600,rdevmajor:5,rdevminor:1,data:Buffer.alloc(0)}],['bin/sh',{mode:0o120777,data:Buffer.from('busybox')}],['hello',{mode:0o100755,data:Buffer.from([0,1,2,255])}]]);
  const copy=unpackCpio(packCpio(original));assert.equal(copy.get('dev/console').rdevmajor,5);assert.equal(copy.get('dev/console').rdevminor,1);assert.equal(copy.get('bin/sh').mode,0o120777);assert.deepEqual(copy.get('hello').data,original.get('hello').data);
});

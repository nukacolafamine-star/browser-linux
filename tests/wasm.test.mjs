import test from 'node:test';import assert from 'node:assert/strict';import {stripDwarf} from '../tools/wasm.mjs';
test('removes DWARF while preserving other custom sections exactly',()=>{
  const custom=name=>Buffer.concat([Buffer.from([0,name.length+2,name.length]),Buffer.from(name),Buffer.from([123])]);
  const header=Buffer.from('0061736d01000000','hex');const keep=custom('name');const source=Buffer.concat([header,custom('.debug_info'),keep]);const result=stripDwarf(source);
  assert.deepEqual(result.bytes,Buffer.concat([header,keep]));assert.equal(result.removed.length,1);
});
test('rejects truncated Wasm without writing a partial kernel',()=>assert.throws(()=>stripDwarf(Buffer.from('0061736d010000000a7f','hex')),/Truncated/));

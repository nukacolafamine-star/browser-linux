import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {stripDwarf} from '../tools/wasm.mjs';
import {patchKernelSpinlockReads,KERNEL_FIX} from '../tools/kernel-fix.mjs';

const original=stripDwarf(fs.readFileSync(new URL('../vendor/linux-wasm/vmlinux.original.wasm',import.meta.url))).bytes;
const patched=patchKernelSpinlockReads(original);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function decode(bytes){
  let offset=8;
  const integer=()=>{let value=0,shift=0,byte;do{byte=bytes[offset++];value|=(byte&127)<<shift;shift+=7;}while(byte&128);return value;};
  const sections=[];let bodies;
  while(offset<bytes.length){const start=offset,id=bytes[offset++],length=integer(),end=offset+length;
    if(id===10){const count=integer();bodies=[];for(let i=0;i<count;i++){const size=integer();bodies.push(bytes.subarray(offset,offset+size));offset+=size;}assert.equal(offset,end);}
    sections.push({id,raw:bytes.subarray(start,end)});offset=end;
  }
  return {sections,bodies};
}
test('kernel lock fix produces the pinned valid module without mutating the input',async()=>{
  assert.equal(sha(original),KERNEL_FIX.inputSha256);
  assert.equal(sha(patched.bytes),KERNEL_FIX.outputSha256);
  assert.equal(patched.bytes.length,original.length+27);
  assert.equal(patched.patch.changedLoads,27);
  await WebAssembly.compile(patched.bytes);
});
test('only twenty-seven aligned synchronization reads in six named functions change',()=>{
  const before=decode(original),after=decode(patched.bytes);
  assert.equal(before.sections.length,after.sections.length);
  before.sections.forEach((section,index)=>{assert.equal(section.id,after.sections[index].id);if(section.id!==10)assert.deepEqual(after.sections[index].raw,section.raw);});
  assert.equal(before.bodies.length,after.bodies.length);
  const intended=new Set([1100,1379,1641,1642,1643,1644]);let changes=0;
  for(let i=0;i<before.bodies.length;i++){
    if(!intended.has(i)){assert.deepEqual(after.bodies[i],before.bodies[i]);continue;}
    // Reverse only the specified aligned atomic lock reads, then compare every
    // remaining byte to the original function. Other opcodes must be identical.
    let body=after.bodies[i],reads=0;
    const patterns=i===1379?[
      ['2204fe1002cc0a','22042802cc0a'],['2002fe10028807','200228028807'],
      ['2002fe10029c07','200228029c07'],['2002fe10029807','200228029807'],['2008fe100200','2008280200'],
    ]:(i===1100?[20,40,72]:[0]).map(field=>[Buffer.from([0x20,0,0xfe,0x10,2,field]),Buffer.from([0x20,0,0x28,2,field])]);
    for(const [changed,previous] of patterns){
      const atomic=Buffer.from(changed,'hex'),plain=Buffer.from(previous,'hex');
      let offset=body.indexOf(atomic);
      while(offset>=0){body=Buffer.concat([body.subarray(0,offset),plain,body.subarray(offset+atomic.length)]);reads++;offset=body.indexOf(atomic,offset+plain.length);}
    }
    assert.equal(reads,i===1100?8:i===1379?7:3);changes+=reads;assert.deepEqual(body,before.bodies[i]);
  }
  assert.equal(changes,27);
});
test('refuses a different kernel or applying the compatibility fix twice',()=>{
  const corrupted=Buffer.from(original);corrupted[100]^=1;
  assert.throws(()=>patchKernelSpinlockReads(corrupted),/unexpected input SHA-256/);
  assert.throws(()=>patchKernelSpinlockReads(patched.bytes),/unexpected input SHA-256/);
});

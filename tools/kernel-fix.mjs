// SPDX-License-Identifier: GPL-2.0-only
// The pinned LLVM 18 kernel lowers ticket-lock READ_ONCE polling to ordinary
// Wasm loads. A second-stage Wasm optimizer can hoist those loads and leave a
// contended lock spinning forever. The same lowering affects task parking.
// Strengthen twenty-seven aligned synchronization reads in six functions
// to sequentially consistent i32.atomic.load instructions. No other code,
// data, imports, exports, or custom sections are changed.
import {createHash} from 'node:crypto';

const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export const KERNEL_FIX=Object.freeze({
  id:'wasm-synchronization-atomic-reads-v1',
  inputSha256:'a4a03de3418c729997df707946d71dafe32d5655febcb3d9ec1987fe832545f1',
  outputSha256:'e325182240518e4cf2e226a37ff947b827b9d0677ba7e5afedf9558bb9eba441',
  changedLoads:27,
});
const targets=[
  {name:'_raw_spin_lock',index:1737,sha:'8f30725f35d435dc4543da387ae10182c1d79bd31742558cc099417885938f46',offsets:[3,60,77]},
  {name:'_raw_spin_lock_irqsave',index:1738,sha:'8e470ea250f4840e6bd19fb71db30a285f8ac2d8fb5ac98f915fc9bf71814b64',offsets:[19,76,93]},
  {name:'_raw_spin_lock_irq',index:1739,sha:'53c6e8322cdb22eeaa7b48a6aeca038398337aefea19e27080f83458380f550e',offsets:[11,68,85]},
  {name:'_raw_spin_lock_bh',index:1740,sha:'fbac31f657d1db9564baa2498f65ca8057ba88639c8fd53159ba5eaf7a030ac5',offsets:[35,92,109]},
  {name:'wait_task_inactive',index:1196,sha:'b382b94071bdf710a910a9f835dcaf04cc94615d37b6ed5fbeecb12172ec4616',reads:[
    {offset:55,field:40},{offset:67,field:20},{offset:84,field:40},
    {offset:169,field:72},{offset:212,field:72},{offset:224,field:72},
    {offset:239,field:20},{offset:246,field:40},
  ]},
  {name:'kcpustat_cpu_fetch',index:1475,sha:'c30993371d5de1bb9ac67612708ec98ac838dc15592a931f04c25c19cb80a82a',reads:[
    {offset:94,op:0x22,local:4,field:1356},
    {offset:205,local:2,field:904},{offset:221,local:2,field:904},
    {offset:239,local:2,field:924},{offset:247,local:2,field:920},
    {offset:534,local:2,field:904},{offset:548,local:8,field:0},
  ]},
];
function readULEB(bytes,start){
  let value=0,shift=0;
  for(let end=start;end<bytes.length&&end<start+5;end++){
    const byte=bytes[end];value+=(byte&127)*2**shift;
    if(!(byte&128))return {value,end:end+1};shift+=7;
  }
  throw new Error('Invalid WebAssembly section length');
}
function uleb(value){
  const bytes=[];
  do{let byte=value&127;value=Math.floor(value/128);if(value)byte|=128;bytes.push(byte);}while(value);
  return Buffer.from(bytes);
}
function sectionsOf(bytes){
  const sections=[];
  for(let cursor=8;cursor<bytes.length;){
    const start=cursor,id=bytes[cursor++],size=readULEB(bytes,cursor),end=size.end+size.value;
    if(end>bytes.length)throw new Error('Truncated WebAssembly section');
    sections.push({id,start,end,body:bytes.subarray(size.end,end)});cursor=end;
  }
  return sections;
}

/** Apply only to the exact pinned, DWARF-stripped upstream kernel. */
export function patchKernelSpinlockReads(input){
  const bytes=Buffer.from(input);
  if(sha256(bytes)!==KERNEL_FIX.inputSha256)throw new Error('Kernel compatibility patch refused: unexpected input SHA-256');
  const sections=sectionsOf(bytes),code=sections.find(s=>s.id===10),exportsSection=sections.find(s=>s.id===7);
  if(!code||!exportsSection)throw new Error('Kernel code or exports section missing');
  const exports=new Map(),exportCount=readULEB(exportsSection.body,0);let cursor=exportCount.end;
  for(let i=0;i<exportCount.value;i++){
    const length=readULEB(exportsSection.body,cursor);cursor=length.end;
    const name=exportsSection.body.toString('utf8',cursor,cursor+length.value);cursor+=length.value;
    const kind=exportsSection.body[cursor++],index=readULEB(exportsSection.body,cursor);cursor=index.end;
    if(kind===0)exports.set(name,index.value);
  }
  const module=new WebAssembly.Module(bytes);
  const imports=WebAssembly.Module.imports(module).filter(item=>item.kind==='function').length;
  if(imports!==96)throw new Error('Unexpected kernel function imports');
  const count=readULEB(code.body,0),bodies=[];cursor=count.end;
  for(let i=0;i<count.value;i++){
    const length=readULEB(code.body,cursor);cursor=length.end;
    bodies.push(code.body.subarray(cursor,cursor+length.value));cursor+=length.value;
  }
  if(cursor!==code.body.length)throw new Error('Unexpected kernel code section shape');
  // Preserve the address expression and four-byte alignment; replace only
  // i32.load with i32.atomic.load. Local 0 addresses locks/task state; other
  // locals address the current task and its vtime sequence/state/cpu fields.
  const functions=[];
  for(const target of targets){
    if(exports.get(target.name)!==target.index)throw new Error('Unexpected kernel export: '+target.name);
    const index=target.index-imports,original=bodies[index];
    if(sha256(original)!==target.sha)throw new Error('Unexpected kernel function body: '+target.name);
    const reads=target.reads||target.offsets.map(offset=>({offset,field:0}));
    let patched=original;
    for(const {offset,field,local=0,op=0x20} of reads.slice().sort((a,b)=>b.offset-a.offset)){
      const before=Buffer.concat([Buffer.from([op,local,0x28,2]),uleb(field)]);
      const after=Buffer.concat([Buffer.from([op,local,0xfe,0x10,2]),uleb(field)]);
      if(!original.subarray(offset,offset+before.length).equals(before))throw new Error('Unexpected synchronization read instruction: '+target.name);
      patched=Buffer.concat([patched.subarray(0,offset),after,patched.subarray(offset+before.length)]);
    }
    bodies[index]=patched;
    functions.push({name:target.name,functionIndex:target.index,bodySha256:target.sha,changedLoads:reads.length,reads});
  }
  const newCode=Buffer.concat([uleb(count.value),...bodies.flatMap(body=>[uleb(body.length),body])]);
  const output=Buffer.concat([bytes.subarray(0,8),...sections.map(section=>section===code
    ?Buffer.concat([Buffer.from([10]),uleb(newCode.length),newCode])
    :bytes.subarray(section.start,section.end))]);
  if(sha256(output)!==KERNEL_FIX.outputSha256)throw new Error('Kernel compatibility patch produced an unexpected SHA-256');
  return {bytes:output,patch:{...KERNEL_FIX,functions}};
}

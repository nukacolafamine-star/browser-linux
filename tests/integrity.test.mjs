import test from 'node:test';
import assert from 'node:assert/strict';
import {fingerprint,verifySnapshot} from '../public/integrity.js';
import {validateSnapshot} from '../public/storage.js';
const backup=()=>({version:1,entries:[{path:'/home/web/test',type:'file',data:Uint8Array.of(0,255,42)},{path:'/home/web/link',type:'symlink',target:'test'}]});
test('checksums survive JSON export and entry reordering',async()=>{
  const value=backup();value.digest=await fingerprint(value);
  const json=JSON.stringify(value,(_,v)=>v instanceof Uint8Array?Array.from(v):v);
  const restored=validateSnapshot(JSON.parse(json));restored.entries.reverse();
  assert.equal(await verifySnapshot(restored),value.digest);
});
test('backup checksum detects altered bytes, paths and link targets',async()=>{
  for(const change of [v=>v.entries[0].data[1]=0,v=>v.entries[0].path+='.changed',v=>v.entries[1].target='other']){
    const value=backup();value.digest=await fingerprint(value);change(value);
    await assert.rejects(()=>verifySnapshot(validateSnapshot(value)),/integrity check failed/);
  }
});

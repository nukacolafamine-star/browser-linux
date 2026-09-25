import test from 'node:test';import assert from 'node:assert/strict';
import {validateSnapshot} from '../public/storage.js';
const file=(path='/home/web/a',data=[0,255,42])=>({path,type:'file',data});
test('binary backup restores exact bytes and directories',()=>{const result=validateSnapshot({version:1,entries:[{path:'/home/web/d',type:'directory'},file('/home/web/d/a')]});assert.deepEqual(Array.from(result.entries[1].data),[0,255,42]);assert.equal(result.totalBytes,3);});
test('rejects traversal and paths outside workspace',()=>{for(const path of ['/etc/passwd','/home/web/../etc/a','/home/web/a/../../a','/home/web/a\0b','/home/web/a/','/home/web//a'])assert.throws(()=>validateSnapshot({version:1,entries:[file(path)]}));});
test('rejects files beneath symlinks and missing parents',()=>{assert.throws(()=>validateSnapshot({version:1,entries:[{path:'/home/web/d',type:'symlink',target:'/etc'},file('/home/web/d/a')]}));assert.throws(()=>validateSnapshot({version:1,entries:[file('/home/web/missing/a')]}));});
test('rejects duplicates, corrupt data, oversized files',()=>{for(const entries of [[file(),file()],[file('/home/web/a',[999])],[file('/home/web/a','bad')],[file('/home/web/a',new Uint8Array(8*1024*1024+1))]])assert.throws(()=>validateSnapshot({version:1,entries}));});

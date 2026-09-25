// SPDX-License-Identifier: GPL-2.0-only
// Opaque ext4 bytes: this module never interprets or rewrites guest files.
// Call save only after the guest has fully powered off. Restore into a freshly
// verified base image, never a live or already modified guest disk.
const BLOCK_SIZE=4*1024*1024,MAX_BYTES=1024*1024*1024,MAX_BLOCKS=MAX_BYTES/BLOCK_SIZE;
const LEASE_MS=120000,READ_TIMEOUT_MS=15000;
const SHA=/^[a-f0-9]{64}$/;
const failure=(code,message)=>Object.assign(new Error(message),{name:'DiskStorageError',code});
const request=value=>new Promise((resolve,reject)=>{value.onsuccess=()=>resolve(value.result);value.onerror=()=>reject(value.error);});
const digest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');
const blockLength=(base,index)=>Math.min(BLOCK_SIZE,base.byteLength-index*BLOCK_SIZE);

function validateBase(base){
  if(!base||base.schema!==1||base.blockSize!==BLOCK_SIZE||!Number.isSafeInteger(base.byteLength)
    ||base.byteLength<=0||base.byteLength>MAX_BYTES||!SHA.test(base.sha256)
    ||!Array.isArray(base.blocks)||base.blocks.length!==Math.ceil(base.byteLength/BLOCK_SIZE)
    ||base.blocks.length>MAX_BLOCKS||Array.from(base.blocks).some(hash=>typeof hash!=='string'||!SHA.test(hash))){
    throw failure('INVALID_BASE','Invalid base disk metadata; disks must be at most 1 GiB with 4 MiB blocks.');
  }
}
function validateSnapshot(snapshot){
  if(!snapshot||snapshot.schema!==1||typeof snapshot.id!=='string'||!/^[a-f0-9-]{36}$/.test(snapshot.id)
    ||typeof snapshot.createdAt!=='string'||snapshot.createdAt.length>32||!Number.isFinite(Date.parse(snapshot.createdAt))
    ||!snapshot.base||snapshot.base.blockSize!==BLOCK_SIZE||!SHA.test(snapshot.base.sha256)
    ||!Number.isSafeInteger(snapshot.base.byteLength)||snapshot.base.byteLength<=0||snapshot.base.byteLength>MAX_BYTES
    ||!Array.isArray(snapshot.changes)||snapshot.changes.length>MAX_BLOCKS){
    throw failure('CORRUPT_SNAPSHOT','Saved disk metadata is invalid. The saved disk was not changed.');
  }
  const seen=new Set();let changedBytes=0;
  for(const entry of snapshot.changes){
    if(!entry||!Number.isSafeInteger(entry.index)||entry.index<0||entry.index>=Math.ceil(snapshot.base.byteLength/BLOCK_SIZE)
      ||seen.has(entry.index)||typeof entry.sha256!=='string'||!SHA.test(entry.sha256)
      ||entry.bytes!==blockLength(snapshot.base,entry.index)){
      throw failure('CORRUPT_SNAPSHOT','Saved disk block metadata is invalid. The saved disk was not changed.');
    }
    seen.add(entry.index);changedBytes+=entry.bytes;
  }
  if(changedBytes>MAX_BYTES)throw failure('CORRUPT_SNAPSHOT','Saved disk changes exceed the 1 GiB limit.');
  return snapshot;
}
function checkBase(snapshot,base){
  if(snapshot.base.sha256!==base.sha256||snapshot.base.byteLength!==base.byteLength||snapshot.base.blockSize!==base.blockSize){
    throw failure('BASE_MISMATCH','This saved disk belongs to a different base image. It has been preserved; load the matching image to restore it.');
  }
}
function checkCurrent(heads,expected){
  if(heads.current!==expected)throw failure('STALE_SNAPSHOT','The saved disk changed in another session. This save was refused and the newer snapshot was preserved.');
}
function checkRecovery(heads,expected){
  if(heads.previous!==expected)throw failure('STALE_SNAPSHOT','The previous recovery point changed in another session. This save was refused and saved data was preserved.');
}
function summary(snapshot){
  return snapshot?{id:snapshot.id,createdAt:snapshot.createdAt,baseSha256:snapshot.base.sha256,
    byteLength:snapshot.base.byteLength,blockSize:snapshot.base.blockSize,changedBlocks:snapshot.changes.length,
    changedBytes:snapshot.changes.reduce((sum,entry)=>sum+entry.bytes,0)}:null;
}

// wholeSha is the digest the image loader has already verified. Rehashing the
// entire ArrayBuffer here would duplicate a large disk in WebCrypto internals.
export async function makeBaseMetadata(bytes,wholeSha){
  if(!(bytes instanceof Uint8Array)||bytes.byteLength===0||bytes.byteLength>MAX_BYTES||typeof wholeSha!=='string'||!SHA.test(wholeSha)){
    throw failure('INVALID_BASE','A verified base image of at most 1 GiB and its SHA-256 are required.');
  }
  const blocks=[];
  for(let offset=0;offset<bytes.byteLength;offset+=BLOCK_SIZE){
    blocks.push(await digest(new Uint8Array(bytes.subarray(offset,offset+BLOCK_SIZE))));
  }
  return Object.freeze({schema:1,sha256:wholeSha,byteLength:bytes.byteLength,blockSize:BLOCK_SIZE,blocks:Object.freeze(blocks)});
}

export class DiskStore{
  constructor(scope){
    if(typeof scope!=='string'||!scope.length||scope.length>2048)throw failure('INVALID_SCOPE','A nonempty application scope is required.');
    this.databaseName='browser-linux-ext4-v1:'+scope;
    this._opening=null;this._busy=false;
  }
  async _db(){
    if(!this._opening){
      this._opening=new Promise((resolve,reject)=>{
        const opening=indexedDB.open(this.databaseName,1);
        opening.onupgradeneeded=()=>{for(const name of ['state','snapshots','chunks'])opening.result.createObjectStore(name);};
        opening.onerror=()=>reject(opening.error);
        opening.onblocked=()=>reject(failure('STORAGE_BLOCKED','Close other sessions using this disk and retry.'));
        opening.onsuccess=()=>{const db=opening.result;db.onversionchange=()=>{db.close();this._opening=null;};resolve(db);};
      }).catch(error=>{this._opening=null;throw error;});
    }
    return this._opening;
  }
  async _transaction(stores,mode,action){
    const db=await this._db(),transaction=db.transaction(stores,mode);
    const finished=new Promise((resolve,reject)=>{
      transaction.oncomplete=resolve;
      transaction.onabort=()=>reject(transaction.error||failure('STORAGE_ABORTED','Disk storage transaction was aborted.'));
      transaction.onerror=()=>{};
    });
    finished.catch(()=>{});
    try{const result=await action(transaction);await finished;return result;}
    catch(error){try{transaction.abort();}catch{}await finished.catch(()=>{});throw error;}
  }
  async _heads(transaction){
    const heads=await request(transaction.objectStore('state').get('heads'));
    if(heads===undefined)return {schema:1,current:null,previous:null};
    if(!heads||heads.schema!==1||!['current','previous'].every(key=>heads[key]===null||typeof heads[key]==='string'&&/^[a-f0-9-]{36}$/.test(heads[key]))){
      throw failure('CORRUPT_SNAPSHOT','Saved disk pointers are invalid. No saved data was deleted.');
    }
    return heads;
  }
  async _snapshot(transaction,id){
    if(id===null)return null;
    const value=validateSnapshot(await request(transaction.objectStore('snapshots').get(id)));
    if(value.id!==id)throw failure('CORRUPT_SNAPSHOT','Saved disk identity is invalid.');
    return value;
  }
  async _checkLease(transaction,owner){
    const state=transaction.objectStore('state'),lease=await request(state.get('writer'));
    if(!lease||lease.owner!==owner||lease.expires<=Date.now())throw failure('DISK_BUSY','Disk storage changed in another session. Retry after that session finishes.');
    state.put({owner,expires:Date.now()+LEASE_MS},'writer');
  }
  async _exclusive(action){
    if(this._busy)throw failure('DISK_BUSY','A disk save or restore is already in progress.');
    this._busy=true;const owner=crypto.randomUUID();let acquired=false;
    try{
      await this._transaction(['state'],'readwrite',async transaction=>{
        const state=transaction.objectStore('state'),lease=await request(state.get('writer'));
        if(lease&&lease.expires>Date.now())throw failure('DISK_BUSY','Another session is saving or restoring this disk.');
        state.put({owner,expires:Date.now()+LEASE_MS},'writer');
      });
      acquired=true;return await action(owner);
    }finally{
      if(acquired)await this._transaction(['state'],'readwrite',async transaction=>{
        const state=transaction.objectStore('state'),lease=await request(state.get('writer'));
        if(lease?.owner===owner)state.delete('writer');
      }).catch(()=>{});
      this._busy=false;
    }
  }
  async _prune(owner){
    await this._transaction(['state','snapshots','chunks'],'readwrite',async transaction=>{
      await this._checkLease(transaction,owner);
      const heads=await this._heads(transaction),ids=new Set([heads.current,heads.previous].filter(Boolean)),hashes=new Set();
      for(const id of ids){const snapshot=await this._snapshot(transaction,id);for(const entry of snapshot.changes)hashes.add(entry.sha256);}
      for(const name of ['snapshots','chunks']){
        const store=transaction.objectStore(name),keep=name==='snapshots'?ids:hashes;
        for(const key of await request(store.getAllKeys()))if(!keep.has(key))store.delete(key);
      }
    });
  }
  async _readChunk(owner,entry){
    const chunk=await this._transaction(['state','chunks'],'readwrite',async transaction=>{
      await this._checkLease(transaction,owner);return request(transaction.objectStore('chunks').get(entry.sha256));
    });
    if(!chunk||chunk.sha256!==entry.sha256||!(chunk.bytes instanceof ArrayBuffer)||chunk.bytes.byteLength!==entry.bytes){
      throw failure('CORRUPT_CHUNK','A saved disk block is missing or invalid. The restore target was not changed.');
    }
    const bytes=new Uint8Array(chunk.bytes);
    if(await digest(bytes)!==entry.sha256)throw failure('CORRUPT_CHUNK','A saved disk block failed its checksum. The restore target was not changed.');
    return bytes;
  }
  async save(base,readBlock,{expectedCurrent,recoveredPrevious=null}={}){
    validateBase(base);
    if(typeof readBlock!=='function')throw failure('INVALID_READER','A stopped guest disk reader is required.');
    if(expectedCurrent!==null&&(typeof expectedCurrent!=='string'||!/^[a-f0-9-]{36}$/.test(expectedCurrent))){
      throw failure('MISSING_EXPECTED_CURRENT','Saving requires the snapshot identity captured when this guest was loaded, or null for a new disk.');
    }
    if(recoveredPrevious!==null&&(typeof recoveredPrevious!=='string'||!/^[a-f0-9-]{36}$/.test(recoveredPrevious))){
      throw failure('INVALID_RECOVERY','Previous recovery requires the identity of the previous snapshot that was restored.');
    }
    return this._exclusive(async owner=>{
      const {recovery,preserveRecovered}=await this._transaction(['state','snapshots'],'readonly',async transaction=>{
        const heads=await this._heads(transaction);
        checkCurrent(heads,expectedCurrent);
        let recovery=null,current=null;
        if(recoveredPrevious!==null){
          checkRecovery(heads,recoveredPrevious);
          recovery=await this._snapshot(transaction,recoveredPrevious);
          checkBase(recovery,base);
        }
        try{current=await this._snapshot(transaction,heads.current);}
        catch(error){if(!recovery||error.code!=='CORRUPT_SNAPSHOT')throw error;}
        if(current)checkBase(current,base);
        return {recovery,preserveRecovered:!!recovery&&!current};
      });
      // Explicit recovery can bypass only corrupt current metadata, never a
      // stale head or an invalid recovery point. Verify that the retained
      // previous generation is complete before staging a replacement.
      if(recovery){
        const verified=new Set();
        for(const entry of recovery.changes)if(!verified.has(entry.sha256)){await this._readChunk(owner,entry);verified.add(entry.sha256);}
      }
      // Invalid current metadata cannot safely enumerate its referenced chunks.
      // Leave it and all existing data untouched until a replacement commits.
      if(!preserveRecovered)await this._prune(owner);
      try{
        const changes=[],stagedHashes=new Set();
        for(let index=0;index<base.blocks.length;index++){
          const length=blockLength(base,index);let timer;
          let value;
          try{
            value=await Promise.race([Promise.resolve().then(()=>readBlock(index*BLOCK_SIZE,length)),
              new Promise((_,reject)=>{timer=setTimeout(()=>reject(failure('READ_TIMEOUT','Reading the stopped guest disk timed out. The previous snapshot is safe.')),READ_TIMEOUT_MS);})]);
          }finally{clearTimeout(timer);}
          if(!(value instanceof Uint8Array)||value.byteLength!==length)throw failure('INVALID_BLOCK','The disk reader returned an incorrectly sized block.');
          // A single stable block copy also supports SharedArrayBuffer-backed
          // guest memory, which WebCrypto cannot consume directly.
          const bytes=new Uint8Array(value),sha256=await digest(bytes),changed=sha256!==base.blocks[index];
          await this._transaction(['state','chunks'],'readwrite',async transaction=>{
            await this._checkLease(transaction,owner);
            if(changed&&!stagedHashes.has(sha256)){
              const chunks=transaction.objectStore('chunks');
              // Existing chunks can belong to either good snapshot. Never
              // overwrite them while preparing an uncommitted new snapshot.
              if(await request(chunks.getKey(sha256))===undefined)chunks.put({sha256,bytes:bytes.buffer},sha256);
            }
          });
          if(changed){changes.push({index,sha256,bytes:length});stagedHashes.add(sha256);}
        }
        // Verify what IndexedDB actually stored, one block at a time, before
        // publishing pointers. Do not retain another complete changed image.
        const verified=new Set();
        for(const entry of changes)if(!verified.has(entry.sha256)){await this._readChunk(owner,entry);verified.add(entry.sha256);}
        const snapshot={schema:1,id:crypto.randomUUID(),createdAt:new Date().toISOString(),
          base:{sha256:base.sha256,byteLength:base.byteLength,blockSize:BLOCK_SIZE},changes};
        validateSnapshot(snapshot);
        await this._transaction(['state','snapshots'],'readwrite',async transaction=>{
          await this._checkLease(transaction,owner);
          const heads=await this._heads(transaction);
          checkCurrent(heads,expectedCurrent);
          if(recoveredPrevious!==null){
            checkRecovery(heads,recoveredPrevious);
            checkBase(await this._snapshot(transaction,recoveredPrevious),base);
          }
          transaction.objectStore('snapshots').put(snapshot,snapshot.id);
          transaction.objectStore('state').put({schema:1,current:snapshot.id,previous:preserveRecovered?recoveredPrevious:heads.current},'heads');
        });
        // Pruning is optional maintenance after the atomic commit. Failure
        // cannot turn a committed save into a reported failed save.
        await this._prune(owner).catch(()=>{});
        return summary(snapshot);
      }catch(error){if(!preserveRecovered)await this._prune(owner).catch(()=>{});throw error;}
    });
  }
  async restore(base,target,{previous=false}={}){
    validateBase(base);
    if(!(target instanceof Uint8Array)||target.byteLength!==base.byteLength)throw failure('INVALID_TARGET','Restore needs a fresh verified base image of the exact disk size.');
    return this._exclusive(async owner=>{
      const {snapshot,currentId}=await this._transaction(['state','snapshots'],'readonly',async transaction=>{
        const heads=await this._heads(transaction);
        return {snapshot:await this._snapshot(transaction,previous?heads.previous:heads.current),currentId:heads.current};
      });
      if(!snapshot)return {restored:false,id:null,currentId,source:previous?'previous':'current'};
      checkBase(snapshot,base);
      // Refuse an already modified target: absent snapshot blocks always mean
      // original base bytes, including when recovering the previous snapshot.
      for(let index=0;index<base.blocks.length;index++){
        if(await digest(new Uint8Array(target.subarray(index*BLOCK_SIZE,index*BLOCK_SIZE+blockLength(base,index))))!==base.blocks[index]){
          throw failure('INVALID_TARGET','Restore target is not the verified base image. Reload the base before restoring.');
        }
        await this._transaction(['state'],'readwrite',transaction=>this._checkLease(transaction,owner));
      }
      const staged=[],validated=new Map();
      for(const entry of snapshot.changes){
        const bytes=validated.get(entry.sha256)||await this._readChunk(owner,entry);
        if(bytes.byteLength!==entry.bytes)throw failure('CORRUPT_CHUNK','Saved disk block sizes do not agree.');
        validated.set(entry.sha256,bytes);
        staged.push({offset:entry.index*BLOCK_SIZE,bytes});
      }
      // Recheck ownership after the final asynchronous digest (a tab may have
      // been suspended long enough for its lease to expire).
      await this._transaction(['state'],'readwrite',transaction=>this._checkLease(transaction,owner));
      // No asynchronous work or validation remains once target mutation starts.
      for(const entry of staged)target.set(entry.bytes,entry.offset);
      return {restored:true,currentId,source:previous?'previous':'current',...summary(snapshot)};
    });
  }
  async describe(){
    return this._transaction(['state','snapshots','chunks'],'readonly',async transaction=>{
      const heads=await this._heads(transaction);
      return {schema:1,current:summary(await this._snapshot(transaction,heads.current)),
        previous:summary(await this._snapshot(transaction,heads.previous)),chunkCount:await request(transaction.objectStore('chunks').count())};
    });
  }
  // Image selection must not depend on metadata for the generation the user
  // is explicitly recovering from. currentId remains the save CAS token.
  async describeSnapshot({previous=false}={}){
    return this._transaction(['state','snapshots'],'readonly',async transaction=>{
      const heads=await this._heads(transaction);
      return {schema:1,currentId:heads.current,source:previous?'previous':'current',
        snapshot:summary(await this._snapshot(transaction,previous?heads.previous:heads.current))};
    });
  }
  async close(){
    if(this._busy)throw failure('DISK_BUSY','Wait for the disk operation to finish before closing storage.');
    if(this._opening)(await this._opening).close();this._opening=null;
  }
}

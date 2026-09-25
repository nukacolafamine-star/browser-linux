// SPDX-License-Identifier: GPL-2.0-only
let connection;
const scopePath=typeof location==='undefined'?'/':new URL('./',location.href).pathname;
export const workspaceName='browser-linux-v1'+(scopePath==='/'?'':':'+scopePath);
async function database(){
  if(connection)return connection;
  connection=await new Promise((resolve,reject)=>{const r=indexedDB.open(workspaceName,1);r.onupgradeneeded=()=>r.result.createObjectStore('state');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  connection.onversionchange=()=>{connection.close();connection=null;};return connection;
}
export async function load(key='workspace'){
  const db=await database();return new Promise((resolve,reject)=>{const r=db.transaction('state').objectStore('state').get(key);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
}
export async function store(value,key='workspace'){
  const db=await database();return new Promise((resolve,reject)=>{const tx=db.transaction('state','readwrite');tx.objectStore('state').put(value,key);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('Save interrupted'));});
}
export async function saveSnapshot(snapshot){
  const db=await database();return new Promise((resolve,reject)=>{
    const tx=db.transaction('state','readwrite'),data=tx.objectStore('state');
    const old=data.get('workspace');old.onsuccess=()=>{if(old.result&&old.result.digest!==snapshot.digest)data.put(old.result,'previous-workspace');data.put(snapshot,'workspace');};
    tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('Save interrupted'));
  });
}
export function validateSnapshot(value){
  if(!value||value.version!==1||!Array.isArray(value.entries)||value.entries.length>2048)throw new Error('This is not a supported Browser Linux backup');
  const seen=new Map();let total=0;
  const entries=value.entries.map(entry=>{
    if(typeof entry.path!=='string'||!entry.path.startsWith('/home/web/')||entry.path.includes('\0')||entry.path.endsWith('/')||entry.path.split('/').some(p=>p==='.'||p==='..')||entry.path.includes('//')||seen.has(entry.path))throw new Error('Backup contains an invalid or duplicate path');
    if(!['file','directory','symlink'].includes(entry.type))throw new Error('Unsupported backup entry');
    seen.set(entry.path,entry.type);
    if(entry.type==='file'){
      let data;
      if(entry.data instanceof Uint8Array)data=entry.data;
      else if(Array.isArray(entry.data)&&entry.data.every(n=>Number.isInteger(n)&&n>=0&&n<=255))data=Uint8Array.from(entry.data);
      else throw new Error('Invalid file data in backup');
      if(data.length>8*1024*1024)throw new Error('Backup contains a file larger than 8 MiB');total+=data.length;
      return {...entry,data};
    }
    if(entry.type==='symlink'&&(typeof entry.target!=='string'||entry.target.includes('\0')||entry.target.length>4095))throw new Error('Invalid symbolic link');
    return {...entry};
  });
  if(total>32*1024*1024)throw new Error('Backup exceeds the 32 MiB workspace limit');
  for(const entry of entries){let p=entry.path.slice(0,entry.path.lastIndexOf('/'));while(p!=='/home/web'){if(seen.get(p)!=='directory')throw new Error('Backup is missing a parent directory');p=p.slice(0,p.lastIndexOf('/'));}}
  const digest=typeof value.digest==='string'&&value.digest.startsWith('sha256:')?value.digest:undefined;
  if(digest&&!/^sha256:[a-f0-9]{64}$/.test(digest))throw new Error('Invalid backup checksum');
  return {version:1,entries,totalBytes:total,savedAt:value.savedAt||null,...(digest?{digest}:{})};
}

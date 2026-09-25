// SPDX-License-Identifier: GPL-2.0-only
// Runs synchronously on the dedicated Linux browser-agent task worker.
// Every filesystem operation below goes through the real Linux syscall ABI.
function runBrowserAgent({base, memory, mailbox, syscall, send}) {
  const enc = new TextEncoder(), dec = new TextDecoder();
  const control = new Int32Array(mailbox,0,4);
  const PATH = base + 4096, PATH2 = base + 8192, DATA = base + 16384, CHUNK = 65536;
  const MAX_FILE = 8 * 1024 * 1024, MAX_SNAPSHOT = 32 * 1024 * 1024, MAX_ENTRIES = 2048;
  const check = (value, operation) => { if (value < 0) throw new Error(`${operation}: Linux error ${-value}`); return value; };
  const string = (value, address=PATH) => {
    if (typeof value !== 'string' || value.includes('\0')) throw new Error('Invalid path');
    const bytes=enc.encode(value); if(bytes.length>4095) throw new Error('Path is too long');
    const view=new Uint8Array(memory.buffer); view.set(bytes,address); view[address+bytes.length]=0; return address;
  };
  const normalize = value => {
    if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\0')) throw new Error('Use an absolute Linux path');
    const parts=[]; for(const part of value.split('/')) { if(part==='..') parts.pop(); else if(part && part!=='.') parts.push(part); }
    return '/'+parts.join('/');
  };
  const writable = value => {
    const p=normalize(value);
    if(p!=='/home/web' && !p.startsWith('/home/web/')) throw new Error('Desktop changes are limited to /home/web');
    // Refuse parent symlinks: GUI write operations must stay in the workspace.
    let parent='/home';
    for(const component of p.split('/').slice(2,-1)) {
      parent+='/'+component;
      const result=syscall(78,-100,string(parent),DATA,CHUNK);
      if(result>=0) throw new Error('Writing through symbolic links is not supported');
    }
    return p;
  };
  const close=fd=>syscall(57,fd);
  const uploads = new Map(); let nextUpload = 0;
  const beginWrite = value => {
    const p=writable(value), token=++nextUpload, temp=p+'.browser-linux-'+crypto.randomUUID();
    const fd=check(syscall(56,-100,string(temp),1|64|128|0x20000,0o644),'Create file');
    uploads.set(token,{p,temp,fd,size:0});return token;
  };
  const chunkWrite = (token,data) => {
    const upload=uploads.get(token);if(!upload)throw new Error('Upload has ended');
    const bytes=Uint8Array.from(data);if(upload.size+bytes.length>MAX_FILE)throw new Error('File exceeds the 8 MiB limit');
    for(let offset=0;offset<bytes.length;) {
      const block=bytes.subarray(offset,offset+CHUNK);new Uint8Array(memory.buffer).set(block,DATA);
      const n=check(syscall(64,upload.fd,DATA,block.length),'Write file');if(!n)throw new Error('Short write');offset+=n;upload.size+=n;
    }
    return upload.size;
  };
  const endWrite = (token,abort=false) => {
    const upload=uploads.get(token);if(!upload)throw new Error('Upload has ended');uploads.delete(token);close(upload.fd);
    if(abort){syscall(35,-100,string(upload.temp),0);return false;}
    check(syscall(276,-100,string(upload.temp),-100,string(upload.p,PATH2),0),'Replace file');return {size:upload.size};
  };
  const readFile = value => {
    const p=normalize(value);
    // Nonblocking avoids stalling the bridge on FIFO/device reads. Directories fail below.
    const fd=check(syscall(56,-100,string(p),0x800|0x20000,0),'Open file');
    const chunks=[]; let size=0;
    try { while(true) { const n=check(syscall(63,fd,DATA,CHUNK),'Read file'); if(!n) break; size+=n; if(size>MAX_FILE) throw new Error('File exceeds the 8 MiB editor/import limit'); chunks.push(new Uint8Array(memory.buffer).slice(DATA,DATA+n)); } }
    finally {close(fd);}
    const bytes=new Uint8Array(size); let offset=0; for(const b of chunks) {bytes.set(b,offset);offset+=b.length;} return bytes;
  };
  const writeFile = (value,data) => {
    const token=beginWrite(value);
    try {chunkWrite(token,data);return endWrite(token);} catch(error){if(uploads.has(token))endWrite(token,true);throw error;}
  };
  const list = value => {
    const p=normalize(value); const fd=check(syscall(56,-100,string(p),0x10000|0x20000,0),'Open directory'); const entries=[];
    try { while(true) {
      const n=check(syscall(61,fd,DATA,CHUNK),'Read directory'); if(!n) break;
      const view=new DataView(memory.buffer); const bytes=new Uint8Array(memory.buffer);
      for(let offset=0;offset<n;) {
        const start=DATA+offset,length=view.getUint16(start+16,true),type=bytes[start+18];
        if(length<20 || offset+length>n) throw new Error('Invalid directory record');
        let end=start+19;while(end<start+length && bytes[end])end++;
        const name=dec.decode(bytes.slice(start+19,end));
        if(name!=='.' && name!=='..') entries.push({name,type:type===4?'directory':type===10?'symlink':type===8?'file':'special',path:(p==='/'?'':p)+'/'+name});
        if(entries.length>MAX_ENTRIES)throw new Error('Directory exceeds 2048 entries');
        offset+=length;
      }
    }}finally{close(fd);}
    return entries.sort((a,b)=>(a.type!=='directory')-(b.type!=='directory') || a.name.localeCompare(b.name));
  };
  const mkdir = value => { const p=writable(value);const result=syscall(34,-100,string(p),0o755);if(result!==-17)check(result,'Create directory');return true; };
  const snapshot = () => {
    const entries=[]; let total=0;
    const walk=p=>{for(const entry of list(p)) {
      if(entries.length>=MAX_ENTRIES)throw new Error('Workspace exceeds 2048 entries');
      if(entry.type==='directory'){entries.push({path:entry.path,type:'directory'});walk(entry.path);}
      else if(entry.type==='file'){const data=readFile(entry.path);total+=data.length;if(total>MAX_SNAPSHOT)throw new Error('Workspace exceeds 32 MiB');entries.push({path:entry.path,type:'file',data});}
      else if(entry.type==='symlink'){
        const n=check(syscall(78,-100,string(entry.path),DATA,CHUNK),'Read symbolic link');
        entries.push({path:entry.path,type:'symlink',target:dec.decode(new Uint8Array(memory.buffer,DATA,n).slice())});
      } else throw new Error('Workspace contains unsupported special files');
    }}; walk('/home/web'); return {version:1,entries,totalBytes:total};
  };
  const methods={
    info:()=>({uname:dec.decode(readFile('/proc/version')),memory:dec.decode(readFile('/proc/meminfo')),uptime:dec.decode(readFile('/proc/uptime'))}),
    list:r=>list(r.path), read:r=>readFile(r.path), write:r=>writeFile(r.path,r.data), mkdir:r=>mkdir(r.path),
    writeBegin:r=>beginWrite(r.path), writeChunk:r=>chunkWrite(r.token,r.data), writeEnd:r=>endWrite(r.token,r.abort),
    rename:r=>check(syscall(276,-100,string(writable(r.path)),-100,string(writable(r.to),PATH2),0),'Rename'),
    remove:r=>{const p=writable(r.path);if(p==='/home/web')throw new Error('Cannot remove workspace root');return check(syscall(35,-100,string(p),r.directory?0x200:0),'Remove');},
    symlink:r=>{const p=writable(r.path);return check(syscall(36,string(r.target,PATH2),-100,string(p)),'Create symbolic link');},
    snapshot,
    resize:r=>{const fd=check(syscall(56,-100,string('/dev/console'),2,0),'Open console');try{const v=new DataView(memory.buffer);v.setUint16(DATA,r.rows,true);v.setUint16(DATA+2,r.cols,true);v.setUint32(DATA+4,0,true);return check(syscall(29,fd,0x5414,DATA),'Resize console');}finally{close(fd);}},
  };
  send({method:'bridge_ready'});
  while(true) {
    while(Atomics.load(control,0)!==1) Atomics.wait(control,0,0);
    const length=Atomics.load(control,1); const raw=new Uint8Array(mailbox,16,length).slice();Atomics.store(control,0,0);
    let request;
    try{request=JSON.parse(dec.decode(raw));const method=methods[request.method];if(!method)throw new Error('Unknown request');const result=method(request);send({method:'bridge_result',id:request.id,result});}
    catch(error){send({method:'bridge_result',id:request?.id,error:error.message});}
  }
}

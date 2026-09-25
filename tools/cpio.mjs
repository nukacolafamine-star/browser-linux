import { gunzipSync, gzipSync } from 'node:zlib';
const align = n => (n + 3) & ~3;
export function unpackCpio(input) {
  const bytes = input[0] === 0x1f ? gunzipSync(input) : Buffer.from(input);
  const entries = new Map(); let pos = 0;
  while (pos < bytes.length) {
    if (bytes.toString('ascii',pos,pos+6) !== '070701') { pos++; continue; }
    const fields = Array.from({length:13},(_,i)=>parseInt(bytes.toString('ascii',pos+6+i*8,pos+14+i*8),16));
    const name = bytes.toString('utf8',pos+110,pos+110+fields[11]-1).replace(/^\.\//,'');
    pos = align(pos+110+fields[11]);
    const data = Buffer.from(bytes.subarray(pos,pos+fields[6])); pos=align(pos+fields[6]);
    if (name !== 'TRAILER!!!') entries.set(name,{mode:fields[1],uid:fields[2],gid:fields[3],rdevmajor:fields[9],rdevminor:fields[10],data});
  }
  return entries;
}
export function packCpio(entries) {
  const parts=[]; let ino=1;
  for (const [name,e] of [...entries,['TRAILER!!!',{mode:0,data:Buffer.alloc(0)}]]) {
    const data=Buffer.from(e.data||[]); const n=Buffer.from(name+'\0');
    const fields=[ino++,e.mode,e.uid||0,e.gid||0,1,0,data.length,0,0,e.rdevmajor||0,e.rdevminor||0,n.length,0];
    const header=Buffer.from('070701'+fields.map(v=>v.toString(16).padStart(8,'0')).join(''));
    parts.push(header,n,Buffer.alloc(align(110+n.length)-110-n.length),data,Buffer.alloc(align(data.length)-data.length));
  }
  return gzipSync(Buffer.concat(parts),{level:9,mtime:0});
}

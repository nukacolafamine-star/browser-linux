// Strip only DWARF debug custom sections. Keep code/data/imports/exports unchanged.
export function stripDwarf(input){
  const bytes=Buffer.from(input);if(bytes.subarray(0,8).toString('hex')!=='0061736d01000000')throw new Error('Invalid WebAssembly header');
  let pos=8;const parts=[bytes.subarray(0,8)];const removed=[];
  const leb=()=>{let value=0,shift=0;for(let i=0;i<5;i++){if(pos>=bytes.length)throw new Error('Truncated WebAssembly');const n=bytes[pos++];value+=(n&127)*2**shift;if(!(n&128))return value;shift+=7;}throw new Error('Invalid section length');};
  while(pos<bytes.length){const start=pos,id=bytes[pos++],size=leb(),end=pos+size;if(end>bytes.length)throw new Error('Truncated section');let drop=false;
    if(id===0){const n=leb();if(pos+n>end)throw new Error('Invalid custom section');const name=bytes.toString('utf8',pos,pos+n);drop=name.startsWith('.debug_');if(drop)removed.push({name,bytes:end-start});}
    if(!drop)parts.push(bytes.subarray(start,end));pos=end;
  }
  return {bytes:Buffer.concat(parts),removed};
}

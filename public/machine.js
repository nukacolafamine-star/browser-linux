// SPDX-License-Identifier: GPL-2.0-only
import {load,saveSnapshot,validateSnapshot,workspaceName} from './storage.js';
import {fingerprint,verifySnapshot} from './integrity.js';
export class Machine extends EventTarget {
  constructor(){super();this.state='stopped';this.output='';this.logs=[];this.generation=0;this.saveQueue=Promise.resolve();}
  emit(name,detail){this.dispatchEvent(new CustomEvent(name,{detail}));}
  setState(state,detail=''){this.state=state;this.emit('state',{state,detail});}
  async claim(){
    if(this.claimed)return;
    if(!navigator.locks)throw new Error('This browser is missing workspace locking. Use an up-to-date browser.');
    await new Promise((resolve,reject)=>navigator.locks.request(workspaceName==='browser-linux-v1'?'browser-linux-workspace':workspaceName,{ifAvailable:true},async lock=>{
      if(!lock){reject(new Error('This workspace is already running in another tab. Close that tab and retry.'));return;}
      this.claimed=true;resolve();await new Promise(done=>this.releaseLock=done);
    }).catch(reject));
  }
  async boot({memoryMiB=256,snapshot}={}){
    const generation=++this.generation;
    clearInterval(this.autoSave);this.os?.stop();this.os=null;this.output='';this.logs=[];
    this.setState('booting','Checking browser');const start=performance.now();
    try{
      if(!isSecureContext||!crossOriginIsolated||typeof SharedArrayBuffer==='undefined')throw new Error('Open this app through its local server or HTTPS with COOP/COEP headers. Opening the HTML file directly cannot run this kernel.');
      await this.claim();
      await this.saveQueue;
      const saved=snapshot===undefined?await load():snapshot;
      const workspace=saved?validateSnapshot(saved):null;
      if(workspace)await verifySnapshot(workspace);
      this.setState('booting','Loading Linux');
      const [kernel,initrd]=await Promise.all([
        WebAssembly.compileStreaming(fetch('assets/vmlinux.wasm').then(r=>{if(!r.ok)throw new Error('Linux kernel could not be loaded');return r;})),
        fetch('assets/initramfs.cpio.gz').then(r=>{if(!r.ok)throw new Error('Linux filesystem could not be loaded');return r.arrayBuffer();})
      ]);
      if(generation!==this.generation)return;
      let readyResolve,readyReject;const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
      let bridgeReady=false;
      const checkReady=()=>{if(bridgeReady&&this.output.includes('root@browser-linux:~#'))readyResolve();};
      const timeout=setTimeout(()=>readyReject(new Error('Linux did not finish booting within 45 seconds')),45000);
      this.os=await linux('runtime/linux-worker.js',kernel,'maxcpus=3 nohz_full=2-63 rcu_nocbs=2-63 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0',initrd,
        text=>{this.logs.push(text);if(this.logs.length>1000)this.logs.shift();if(text.startsWith('FATAL:')){const e=new Error(text);readyReject(e);this.fail(e);}},
        text=>{this.output=(this.output+text).slice(-1000000);this.emit('console',text);checkReady();},
        {memoryMiB,ready:()=>{bridgeReady=true;checkReady();},error:e=>{readyReject(e);this.fail(e);}});
      try{await ready;}finally{clearTimeout(timeout);}
      this.setState('restoring','Restoring workspace');
      if(workspace)await this.restore(workspace);
      this.info=await this.os.rpc('info');
      this.bootMs=performance.now()-start;this.setState('running');this.emit('ready',this.info);
      this.autoSave=setInterval(()=>{if(this.state==='running')this.save().catch(error=>this.emit('save-error',error));},10000);
      return this.info;
    }catch(error){this.os?.stop();this.fail(error);throw error;}
  }
  fail(error){clearInterval(this.autoSave);this.os?.stop();if(this.state!=='error')this.setState('error',error.message);}
  rpc(method,args){if(!this.os)throw new Error('Linux is not running');return this.os.rpc(method,args);}
  async write(path,data){
    const bytes=typeof data==='string'?new TextEncoder().encode(data):new Uint8Array(data);
    if(bytes.length>8*1024*1024)throw new Error('Files are limited to 8 MiB in this version');
    const token=await this.rpc('writeBegin',{path});
    try{
      for(let offset=0;offset<bytes.length;offset+=32768)await this.rpc('writeChunk',{token,data:Array.from(bytes.subarray(offset,offset+32768))});
      const result=await this.rpc('writeEnd',{token});
      const actual=await this.rpc('read',{path});
      if(actual.length!==bytes.length||actual.some((n,i)=>n!==bytes[i])){
        const error=new Error('Linux file verification failed. Session stopped; the last saved backup is retained.');this.fail(error);throw error;
      }
      return result;
    }
    catch(error){await this.rpc('writeEnd',{token,abort:true}).catch(()=>{});throw error;}
  }
  async restore(snapshot){
    const expected=await verifySnapshot(snapshot);
    for(const entry of await this.rpc('list',{path:'/home/web'}))await this.rpc('remove',{path:entry.path,directory:entry.type==='directory'});
    for(const e of snapshot.entries.filter(e=>e.type==='directory').sort((a,b)=>a.path.length-b.path.length))await this.rpc('mkdir',{path:e.path});
    for(const e of snapshot.entries.filter(e=>e.type==='file'))await this.write(e.path,e.data);
    for(const e of snapshot.entries.filter(e=>e.type==='symlink'))await this.rpc('symlink',{path:e.path,target:e.target});
    const actual=await this.rpc('snapshot');
    if(await fingerprint(actual)!==expected)throw new Error('Restored files did not match the backup. Session stopped; the last saved backup is retained.');
  }
  save(){
    const save=async()=>{
      if(this.state!=='running')throw new Error('Start Linux before saving');
      const generation=this.generation;this.emit('saving');const snapshot=await this.rpc('snapshot');snapshot.savedAt=new Date().toISOString();
      snapshot.digest=await fingerprint(snapshot);
      const second=await this.rpc('snapshot');
      if(snapshot.digest!==await fingerprint(second))throw new Error('Files changed during saving. Wait for running commands to finish and save again. The previous backup is retained.');
      if(generation!==this.generation||this.state!=='running')throw new Error('Session changed before saving; the previous backup is retained.');
      await saveSnapshot(snapshot);this.emit('saved',snapshot);return snapshot;
    };
    const result=this.saveQueue.then(save);this.saveQueue=result.catch(()=>{});return result;
  }
  stop(){clearInterval(this.autoSave);this.generation++;this.os?.stop();this.os=null;this.setState('stopped');}
}

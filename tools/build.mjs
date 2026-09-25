import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import wabtFactory from 'wabt';
import { unpackCpio, packCpio } from './cpio.mjs';
import {stripDwarf} from './wasm.mjs';
const root = fileURLToPath(new URL('../',import.meta.url));
const originalKernel=await fs.readFile(path.join(root,'vendor/linux-wasm/vmlinux.original.wasm'));
const stripped=stripDwarf(originalKernel);
await WebAssembly.compile(stripped.bytes);
await fs.writeFile(path.join(root,'public/assets/vmlinux.wasm'),stripped.bytes);
console.log(`Kernel payload: ${originalKernel.length} → ${stripped.bytes.length} bytes (DWARF metadata removed)`);
const wabt=await wabtFactory();
const parsed=wabt.parseWat('browser-agent.wat',await fs.readFile(path.join(root,'guest/browser-agent.wat'),'utf8'),{threads:true});
const {buffer}=parsed.toBinary({}); parsed.destroy();
const leb=n=>{const b=[];do{const v=n&127;n>>>=7;b.push(v|(n?128:0));}while(n);return b;};
// Linux's Wasm executable loader requires a dylink.0 memory-info section.
const info=[...leb(1024*1024),4,0,0];
const content=[8,...Buffer.from('dylink.0'),1,...leb(info.length),...info];
const binary=Buffer.concat([Buffer.from(buffer.subarray(0,8)),Buffer.from([0,...leb(content.length),...content]),Buffer.from(buffer.subarray(8))]);
await WebAssembly.compile(binary);
const entries=unpackCpio(await fs.readFile(path.join(root,'vendor/linux-wasm/initramfs.cpio.gz')));
entries.set('init',{mode:0o100755,data:await fs.readFile(path.join(root,'guest/init'))});
entries.set('bin/browser-agent',{mode:0o100755,data:binary});
entries.set('etc/passwd',{mode:0o100644,data:Buffer.from('root:x:0:0:Browser Linux:/home/web:/bin/sh\n')});
entries.set('etc/profile',{mode:0o100644,data:Buffer.from("export HOME=/home/web USER=root TERM=xterm-256color\nexport PS1='root@browser-linux:\\w# '\ncd /home/web\n")});
for(const directory of ['home/web','tmp','run','dev/pts']) entries.set(directory,{mode:0o40755,data:Buffer.alloc(0)});
for(const [name,major,minor] of [['null',1,3],['zero',1,5],['full',1,7],['tty',5,0]]) entries.set('dev/'+name,{mode:0o20666,rdevmajor:major,rdevminor:minor,data:Buffer.alloc(0)});
entries.set('home/web/Welcome.txt',{mode:0o100644,data:Buffer.from('Welcome to Browser Linux.\n\nThis file lives in the running Linux kernel filesystem.\nEdit it here or from the terminal: vi /home/web/Welcome.txt\n\nThe browser shell is new; the Linux/Wasm kernel port is experimental.\nSave workspace keeps /home/web in this browser. Export a backup for portability.\n')});
await fs.writeFile(path.join(root,'public/assets/initramfs.cpio.gz'),packCpio(entries));
await fs.mkdir(path.join(root,'public/assets'),{recursive:true});
for(const [from,to] of [
 ['@xterm/xterm/lib/xterm.js','xterm.js'],['@xterm/xterm/css/xterm.css','xterm.css'],['@xterm/addon-fit/lib/addon-fit.js','addon-fit.js']
]) await fs.copyFile(path.join(root,'node_modules',from),path.join(root,'public/assets',to));
console.log(`Built Linux initramfs with browser-agent (${binary.length} bytes)`);
await fs.mkdir(path.join(root,'public/licenses'),{recursive:true});
for(const [from,to] of [['LICENSE','GPL-2.0.txt'],['vendor/xterm-LICENSE','xterm.txt'],['vendor/xterm-addon-fit-LICENSE','xterm-addon-fit.txt']])await fs.copyFile(path.join(root,from),path.join(root,'public/licenses',to));
const publicRoot=path.join(root,'public');
const assets=[];
async function walk(dir,prefix=''){
  for(const entry of await fs.readdir(dir,{withFileTypes:true})){
    const name=prefix+entry.name;
    if(entry.isDirectory())await walk(path.join(dir,entry.name),name+'/');
    else if(!['sw.js','asset-manifest.json'].includes(name))assets.push(name);
  }
}
await walk(publicRoot);assets.sort();
const manifest={};
for(const name of assets){const data=await fs.readFile(path.join(publicRoot,name));manifest[name]={bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')};}
const template=await fs.readFile(path.join(root,'tools/sw-template.js'),'utf8');
const version=createHash('sha256').update(JSON.stringify(manifest)).update(template).digest('hex').slice(0,16);
await fs.writeFile(path.join(publicRoot,'sw.js'),template.replace('__VERSION__',version).replace('__ASSETS__',JSON.stringify(['./',...assets])));
await fs.writeFile(path.join(publicRoot,'asset-manifest.json'),JSON.stringify({version,assets:manifest},null,2)+'\n');
console.log(`Offline cache ${version}: ${assets.length} files`);

import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const files={};
for(const name of ['vendor/linux-wasm/vmlinux.original.wasm','vendor/linux-wasm/initramfs.cpio.gz','vendor/linux-wasm/linux.js','vendor/linux-wasm/linux-worker.js','vendor/linux-wasm/source.tar']){
 const bytes=await fs.readFile(path.join(root,name));files[name]={bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
}
const provenance={
 project:'Browser Linux',version:'0.1.0',
 upstream:{repository:'https://github.com/joelseverin/linux-wasm',artifactRef:'855319c0fed3b98e23979e364a1d6270322d3975',artifactBranch:'gh-pages',sourceRecipeRef:'719cd8d974dc37181204eb2db1d9b96dad260c9a',taskReleaseFix:'d94d6b5d7c9c937c7a7158055b8ef56f75d90a8a'},
 kernel:'6.4.16-00012-gf3e782cb608b',kernelSourceRebuiltHere:false,
 sourceBundle:{url:'https://github.com/nukacolafamine-star/browser-linux/releases/download/v0.1.0/browser-linux-sources-0.1.0.tar',bytes:275240960,sha256:'9606fbd908ed4d362a025d2da72fa27c0181d985cceaa4a00eb0828e8c127b58',verification:'All base archives and 15 component patches verified; kernel source patch chain ends at the running binary revision. Byte-for-byte binary reproduction not performed.'},
 sourceRecipeBases:{linux:'v6.4.16',llvm:'llvmorg-18.1.2',musl:'v1.2.5',busybox:'1_36_1'},
 runtimeDependencies:{'@xterm/xterm':'6.0.0','@xterm/addon-fit':'0.11.0'},
 kernelTransformation:'Remove .debug_* custom sections only. Preserve executable and other custom sections.',files,
 servedAssets:JSON.parse(await fs.readFile(path.join(root,'public/asset-manifest.json'),'utf8'))
};
await fs.writeFile(path.join(root,'provenance.json'),JSON.stringify(provenance,null,2)+'\n');
console.log('Recorded pinned inputs and served-asset hashes.');

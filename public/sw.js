// SPDX-License-Identifier: GPL-2.0-only
const PREFIX='browser-linux:'+self.registration.scope+':';
const CACHE=PREFIX+'1c07e403b4b152fd';
const ASSETS=["./","app.js","assets/addon-fit.js","assets/initramfs.cpio.gz","assets/vmlinux.wasm","assets/xterm.css","assets/xterm.js","bootstrap.js","capabilities.js","capability-worker.js","compatibility-exchange.js","compatibility-images.js","compatibility-session.html","compatibility-session.js","compatibility-storage.js","compatibility.css","compatibility.html","compatibility.js","icon.svg","index.html","integrity.js","licenses/GPL-2.0.txt","licenses/xterm-addon-fit.txt","licenses/xterm.txt","machine.js","manifest.webmanifest","runtime/browser-agent.js","runtime/linux-worker.js","runtime/linux.js","sources.html","storage.js","style.css"];
self.addEventListener('install',event=>event.waitUntil((async()=>{
  const cache=await caches.open(CACHE);
  try{await cache.addAll(ASSETS);}catch(error){await caches.delete(CACHE);throw error;}
})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{
  for(const name of await caches.keys())if(name.startsWith(PREFIX)&&name!==CACHE)await caches.delete(name);
  await self.clients.claim();
})()));
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET'||new URL(event.request.url).origin!==self.location.origin)return;
  if(event.request.cache==='only-if-cached'&&event.request.mode!=='same-origin')return;
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE);
    let response=await cache.match(event.request,{ignoreSearch:true});
    // Explicitly downloaded compatibility images survive shell updates. Their
    // checksums are revalidated by the guest loader; never precache them here.
    if(!response&&event.request.url.startsWith(self.registration.scope+'compatibility/builds/')){
      response=await (await caches.open('browser-linux-image-v1:'+self.registration.scope)).match(event.request);
    }
    if(!response&&event.request.mode==='navigate')response=await cache.match('index.html');
    if(!response)response=await fetch(event.request);
    if(response.status===0)return response;
    const headers=new Headers(response.headers);
    headers.set('Cross-Origin-Opener-Policy','same-origin');
    headers.set('Cross-Origin-Embedder-Policy','require-corp');
    headers.set('Cross-Origin-Resource-Policy','same-origin');
    return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
  })());
});

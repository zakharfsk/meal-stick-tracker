const CACHE="meal-stick-v20";
const ASSETS=["./","./index.html","./manifest.webmanifest","./icons/icon-192.png","./icons/icon-512.png","./icons/apple-touch-icon.png"];
self.addEventListener("install",e=>{e.waitUntil(caches.open(CACHE).then(c=>Promise.all(ASSETS.map(a=>fetch(a,{cache:"no-store"}).then(r=>c.put(a,r)).catch(()=>{})))).then(()=>self.skipWaiting()));});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener("message",e=>{if(e.data==="skipWaiting")self.skipWaiting();});
self.addEventListener("fetch",e=>{
  if(e.request.method!=="GET")return;
  const url=new URL(e.request.url);
  if(url.origin!==location.origin)return;
  // network first, bypassing the browser HTTP cache (GitHub Pages sends max-age=600); cache is the offline fallback
  e.respondWith(fetch(e.request,{cache:"no-store"}).then(r=>{if(r.ok){const c=r.clone();caches.open(CACHE).then(cc=>cc.put(e.request,c));}return r;}).catch(()=>caches.match(e.request,{ignoreSearch:true}).then(r=>r||caches.match("./index.html"))));
});

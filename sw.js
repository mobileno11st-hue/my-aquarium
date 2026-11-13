// 인터넷 없이도 앱이 열리게 파일을 폰에 보관한다
const CACHE = 'aquarium-v1';
const SHELL = ['./', 'index.html', 'app.js', 'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-512.png'];
const HEAVY = ['vendor/vision_bundle.mjs', 'vendor/wasm/vision_wasm_internal.js', 'vendor/wasm/vision_wasm_internal.wasm', 'vendor/magic_touch.tflite'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll([...SHELL, ...HEAVY])).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const put = (res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); } return res; };
  if (url.pathname.includes('/vendor/')) {
    // 큰 파일은 보관본 먼저
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then(put)));
  } else {
    // 화면 파일은 새 버전 먼저, 인터넷이 없으면 보관본
    e.respondWith(fetch(e.request).then(put).catch(() => caches.match(e.request, { ignoreSearch: true })));
  }
});

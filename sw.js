// 주식회사 다우세라믹앤석재 - Service Worker
// 앱 셸을 캐시해 오프라인에서도 화면이 뜨도록 합니다.
// 실시간 데이터(Firestore)는 캐시하지 않습니다.

const CACHE = 'dauceramic-shell-v27';
const SHELL = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './firebase-config.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './fonts/Pretendard-Regular.subset.woff2',
  './fonts/Pretendard-Medium.subset.woff2',
  './fonts/Pretendard-SemiBold.subset.woff2',
  './fonts/Pretendard-Bold.subset.woff2'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(()=>self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(()=>self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Firebase / gstatic / googleapis 는 항상 네트워크
  if (/gstatic\.com|googleapis\.com|firebaseio\.com|firestore\.googleapis\.com/.test(url.hostname)) {
    return; // 기본 네트워크 사용
  }
  // 동일 출처 GET 만 캐시 응답
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      const fetcher = fetch(e.request).then(res => {
  
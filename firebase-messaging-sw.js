/* 다우세라믹앤석재 — 푸시 알림 수신 서비스워커
   앱이 꺼져 있어도 이 워커가 백그라운드 알림을 띄웁니다. */
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyDUEdf0BcPbkGaGJJmxuiFycTKNpbHLvOM",
  authDomain: "dawoo-tile-stone.firebaseapp.com",
  projectId: "dawoo-tile-stone",
  storageBucket: "dawoo-tile-stone.firebasestorage.app",
  messagingSenderId: "297532467454",
  appId: "1:297532467454:web:3fc9c61ab3b61432385daf"
});

const messaging = firebase.messaging();

// 서버(Cloud Functions)는 data 페이로드로 보냄 → 여기서 알림 표시
messaging.onBackgroundMessage(function (payload) {
  const d = (payload && payload.data) || (payload && payload.notification) || {};
  const title = d.title || '다우세라믹앤석재';
  const options = {
    body: d.body || '',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    tag: d.tag || undefined,
    data: d
  };
  return self.registration.showNotification(title, options);
});

// 알림 클릭 → 앱 열기/포커스
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (cl) {
      for (const c of cl) { if ('focus' in c) return c.focus(); }
      if (clients.openWindow) return clients.openWindow('./');
    })
  );
});

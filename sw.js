'use strict';
/*
 * VaultNote 서비스 워커 — 오프라인 동작 + 수동 업데이트 (PRD F-7)
 * 새 버전을 올릴 때는 이 VERSION과 app.js의 APP_VERSION을 똑같이 올린다.
 * 새 버전은 자동으로 적용되지 않는다. 앱에서 사용자가 "업데이트"를 눌러야 적용된다.
 */
const VERSION = '1.0.0';
const CACHE = `vaultnote-${VERSION}`;
const FILES = ['./', './index.html', './app.js', './manifest.json', './icon-192.png', './icon-512.png'];

// 설치: 이 버전의 파일을 모두 받아 둔다. 주소 끝에 ?v=버전을 붙여 서버의 옛 사본을 피한다.
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(FILES.map(async (file) => {
      const res = await fetch(`${file}?v=${VERSION}`, { cache: 'reload' });
      if (!res.ok) throw new Error(`받기 실패: ${file}`);
      await cache.put(file, res);
    }));
    // skipWaiting()을 부르지 않는다 → 사용자가 승인할 때까지 대기
  })());
});

// 활성화: 옛 버전 파일을 지우고 열린 화면을 맡는다
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('vaultnote-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'version' && event.ports[0]) event.ports[0].postMessage(VERSION);
  if (data.type === 'skipWaiting') self.skipWaiting(); // 사용자가 업데이트를 승인했을 때만
});

// 요청 처리: 저장해 둔 파일만 내준다 (다른 사이트 요청은 처리하지 않음, CSP로도 차단)
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true })
      || (req.mode === 'navigate' ? await cache.match('./index.html') : undefined);
    return hit || fetch(req);
  })());
});

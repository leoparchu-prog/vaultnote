'use strict';
/*
 * VaultNote 서비스 워커 — 오프라인 동작 + 수동 업데이트 (PRD F-7)
 * 새 버전을 올릴 때는 이 VERSION과 app.js의 APP_VERSION을 똑같이 올린다.
 * 새 버전은 자동으로 적용되지 않는다. 앱에서 사용자가 "업데이트"를 눌러야 적용된다.
 * 이 확인 단계는 실수를 막는 장치이며, 서버(GitHub 계정)가 해킹되면 막지 못한다.
 * FILE_HASHES는 배포할 때 계산해 넣는다. 받은 파일이 목록과 다르면 설치하지 않는다(배포 도중 섞임 방지).
 */
const VERSION = '1.1.1';
const FILE_HASHES = {
  "./index.html": "4e653df4fd9d37ee9c608742dc27c78a80f3f43e2217d8aa2b1c727d1658f93f",
  "./app.js": "fd22977e8829960251312a6d7c560641cd3c5d2364a93429605d52a6577ec7da",
  "./manifest.json": "97ec42e8c32513cfb38bc4755b172502eea2e9c3b0261b875d27bb2510bf0177",
  "./icon-192.png": "6cbe6d09cae7481cc13e643d9f453753dd8f28d56863dbb9ad566dc43c6feb7d",
  "./icon-512.png": "0ba88462de645afa916cf524533421d6820a2f59314f5ffb04fcc55cc84b57cd"
};
const CACHE = `vaultnote-${VERSION}`;
const FILES = ['./', './index.html', './app.js', './manifest.json', './icon-192.png', './icon-512.png'];

// 설치: 이 버전의 파일을 모두 받아 둔다. 주소 끝에 ?v=버전을 붙여 서버의 옛 사본을 피한다.
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(FILES.map(async (file) => {
      const res = await fetch(`${file}?v=${VERSION}`, { cache: 'reload' });
      if (!res.ok) throw new Error(`받기 실패: ${file}`);
      const expected = FILE_HASHES[file === './' ? './index.html' : file];
      const digest = await crypto.subtle.digest('SHA-256', await res.clone().arrayBuffer());
      const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
      if (hex !== expected) throw new Error(`파일 내용이 다름: ${file}`); // 설치 중단 → 다음에 다시 시도
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

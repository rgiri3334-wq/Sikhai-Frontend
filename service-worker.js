/**
 * ============================================================
 *  SIKAI SERVICE WORKER — सिकाइ
 *  Nepal's AI Learning Platform — Offline-First PWA
 *  Version: 1.0.0
 * ============================================================
 *
 *  CACHING STRATEGY:
 *  - Shell (HTML/CSS/JS/fonts)  → Cache First
 *  - API (AI tutor responses)   → Network First, fallback to cache
 *  - Lesson content (JSON/text) → Stale While Revalidate
 *  - Images/Audio               → Cache First with expiry
 *  - Uncached requests          → Network with offline fallback
 * ============================================================
 */

const APP_VERSION    = 'v1.0.0';
const SHELL_CACHE    = `sikai-shell-${APP_VERSION}`;
const CONTENT_CACHE  = `sikai-content-${APP_VERSION}`;
const MEDIA_CACHE    = `sikai-media-${APP_VERSION}`;
const API_CACHE      = `sikai-api-${APP_VERSION}`;

// Files to cache immediately on install (App Shell)
const SHELL_FILES = [
  '/sikai.html',
  '/manifest.json',
  '/offline.html',
  // Google Fonts preloaded
  'https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,300;0,400;0,700;0,900;1,300;1,700&family=DM+Sans:wght@300;400;500;600&family=Noto+Sans+Devanagari:wght@400;600;700&display=swap'
];

// Lesson packs to prefetch for offline use (cache top lessons)
const PREFETCH_LESSONS = [
  '/lessons/photosynthesis-beginner.json',
  '/lessons/photosynthesis-intermediate.json',
  '/lessons/nepal-geography-beginner.json',
  '/lessons/loksewa-constitution.json',
  '/lessons/python-basics.json'
];

const MAX_MEDIA_AGE_SECONDS = 7 * 24 * 60 * 60; // 7 days
const MAX_API_ENTRIES       = 50;
const MAX_CONTENT_ENTRIES   = 100;

// ============================================================
//  INSTALL — Cache the app shell
// ============================================================
self.addEventListener('install', event => {
  console.log('[Sikai SW] Installing version:', APP_VERSION);

  event.waitUntil(
    (async () => {
      const shellCache = await caches.open(SHELL_CACHE);

      // Cache shell files (ignore failures for external fonts)
      await Promise.allSettled(
        SHELL_FILES.map(url =>
          shellCache.add(url).catch(err =>
            console.warn('[Sikai SW] Shell cache miss:', url, err.message)
          )
        )
      );

      // Prefetch lesson packs silently (best effort)
      const contentCache = await caches.open(CONTENT_CACHE);
      await Promise.allSettled(
        PREFETCH_LESSONS.map(url =>
          contentCache.add(url).catch(() => {
            // Lesson files may not exist yet in dev — ignore silently
          })
        )
      );

      console.log('[Sikai SW] Shell cached successfully');
      // Activate immediately without waiting
      await self.skipWaiting();
    })()
  );
});

// ============================================================
//  ACTIVATE — Clean up old caches
// ============================================================
self.addEventListener('activate', event => {
  console.log('[Sikai SW] Activating version:', APP_VERSION);

  const currentCaches = [SHELL_CACHE, CONTENT_CACHE, MEDIA_CACHE, API_CACHE];

  event.waitUntil(
    (async () => {
      const cacheNames = await caches.keys();

      // Delete all caches not belonging to this version
      await Promise.all(
        cacheNames
          .filter(name => !currentCaches.includes(name))
          .map(name => {
            console.log('[Sikai SW] Deleting old cache:', name);
            return caches.delete(name);
          })
      );

      // Take control of all open clients immediately
      await self.clients.claim();
      console.log('[Sikai SW] Active and controlling all clients');
    })()
  );
});

// ============================================================
//  FETCH — Route every request through the right strategy
// ============================================================
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET and browser-extension requests
  if (request.method !== 'GET') return;
  if (!url.protocol.startsWith('http')) return;

  // --- Route decisions ---

  // 1. Anthropic API → Network first, lightweight cache
  if (url.hostname === 'api.anthropic.com') {
    event.respondWith(networkFirstWithCache(request, API_CACHE, MAX_API_ENTRIES));
    return;
  }

  // 2. Lesson JSON content → Stale While Revalidate
  if (url.pathname.startsWith('/lessons/') && url.pathname.endsWith('.json')) {
    event.respondWith(staleWhileRevalidate(request, CONTENT_CACHE, MAX_CONTENT_ENTRIES));
    return;
  }

  // 3. Audio/Image media → Cache first with expiry
  if (/\.(mp3|ogg|wav|webm|jpg|jpeg|png|webp|svg|gif)$/i.test(url.pathname)) {
    event.respondWith(cacheFirstWithExpiry(request, MEDIA_CACHE, MAX_MEDIA_AGE_SECONDS));
    return;
  }

  // 4. Google Fonts → Cache first (they never change for a given URL)
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
    return;
  }

  // 5. App shell (HTML pages) → Cache first with network fallback + offline page
  if (request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(shellWithOfflineFallback(request));
    return;
  }

  // 6. Everything else (CSS, JS, manifests) → Cache first
  event.respondWith(cacheFirst(request, SHELL_CACHE));
});

// ============================================================
//  STRATEGY: Cache First
//  Return from cache; fetch and cache if missing
// ============================================================
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    return offlineFallback(request);
  }
}

// ============================================================
//  STRATEGY: Network First with Cache
//  Try network; fall back to cache; limit cache size
// ============================================================
async function networkFirstWithCache(request, cacheName, maxEntries) {
  const cache = await caches.open(cacheName);

  try {
    const response = await fetch(request);
    if (response.ok) {
      await cache.put(request, response.clone());
      await trimCache(cache, maxEntries);
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    return offlineFallback(request);
  }
}

// ============================================================
//  STRATEGY: Stale While Revalidate
//  Return cached immediately; update cache in background
// ============================================================
async function staleWhileRevalidate(request, cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  // Revalidate in background regardless
  const networkFetch = fetch(request).then(async response => {
    if (response.ok) {
      await cache.put(request, response.clone());
      await trimCache(cache, maxEntries);
    }
    return response;
  }).catch(() => null);

  return cached || await networkFetch || offlineFallback(request);
}

// ============================================================
//  STRATEGY: Cache First with Expiry
//  Serve from cache unless older than maxAgeSeconds
// ============================================================
async function cacheFirstWithExpiry(request, cacheName, maxAgeSeconds) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  if (cached) {
    const dateHeader = cached.headers.get('date');
    if (dateHeader) {
      const ageMs = Date.now() - new Date(dateHeader).getTime();
      if (ageMs < maxAgeSeconds * 1000) return cached;
    } else {
      return cached; // No date header → assume fresh
    }
  }

  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    if (cached) return cached; // Return stale if network fails
    return offlineFallback(request);
  }
}

// ============================================================
//  STRATEGY: Shell with Offline Fallback (for HTML nav)
// ============================================================
async function shellWithOfflineFallback(request) {
  const cache = await caches.open(SHELL_CACHE);

  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    // Try exact match first
    const cached = await cache.match(request);
    if (cached) return cached;

    // Fall back to main app shell
    const shell = await cache.match('/sikai.html');
    if (shell) return shell;

    // Last resort: offline page
    const offline = await cache.match('/offline.html');
    return offline || new Response(offlineHTML(), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }
}

// ============================================================
//  OFFLINE FALLBACK for non-HTML requests
// ============================================================
function offlineFallback(request) {
  const url = new URL(request.url);

  // Return empty JSON for API calls
  if (url.hostname === 'api.anthropic.com') {
    return new Response(
      JSON.stringify({
        content: [{
          type: 'text',
          text: 'तपाईं हाल offline हुनुहुन्छ। Internet connection भएपछि फेरि try गर्नुस्। (You are offline. Please reconnect to use the AI Tutor.)'
        }]
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Return empty JSON for lesson files
  if (url.pathname.endsWith('.json')) {
    return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
  }

  // Return 1x1 transparent PNG for images
  if (/\.(jpg|jpeg|png|webp|gif)$/i.test(url.pathname)) {
    const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    return new Response(atob(pixel), { headers: { 'Content-Type': 'image/png' } });
  }

  return new Response('', { status: 503 });
}

// ============================================================
//  TRIM CACHE — Keep only latest N entries
// ============================================================
async function trimCache(cache, maxEntries) {
  const keys = await cache.keys();
  if (keys.length > maxEntries) {
    const toDelete = keys.slice(0, keys.length - maxEntries);
    await Promise.all(toDelete.map(key => cache.delete(key)));
  }
}

// ============================================================
//  INLINE OFFLINE PAGE HTML
// ============================================================
function offlineHTML() {
  return `<!DOCTYPE html>
<html lang="ne">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>Offline — सिकाइ Sikai</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box;}
  body{
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    background:#0b1118;color:#eef2f7;
    min-height:100vh;display:flex;align-items:center;
    justify-content:center;text-align:center;padding:40px 20px;
  }
  .icon{font-size:64px;margin-bottom:24px;}
  h1{font-size:28px;font-weight:800;margin-bottom:12px;}
  .np{font-size:18px;color:#f0a500;margin-bottom:16px;}
  p{font-size:16px;color:#7a8fa6;line-height:1.7;max-width:400px;margin:0 auto 32px;}
  .btn{
    display:inline-block;background:linear-gradient(135deg,#f0a500,#e05c2a);
    color:#000;font-weight:700;font-size:16px;padding:14px 32px;
    border-radius:100px;text-decoration:none;cursor:pointer;border:none;
    font-family:inherit;
  }
  .tip{margin-top:24px;font-size:13px;color:#4a5f75;line-height:1.6;}
  .tip strong{color:#7a8fa6;}
</style>
</head>
<body>
  <div>
    <div class="icon">📶</div>
    <h1>You're Offline</h1>
    <div class="np">तपाईं अहिले offline हुनुहुन्छ</div>
    <p>
      No internet connection detected. Your last 5 lessons are still available offline.
      Reconnect to access the AI Tutor and generate new courses.
    </p>
    <button class="btn" onclick="window.location.reload()">
      🔄 Try Again
    </button>
    <div class="tip">
      <strong>Tip:</strong> Download lesson packs while online<br/>
      to study anytime — even in remote areas of Nepal.
    </div>
  </div>
</body>
</html>`;
}

// ============================================================
//  BACKGROUND SYNC — Queue failed AI requests for retry
// ============================================================
self.addEventListener('sync', event => {
  if (event.tag === 'sync-progress') {
    event.waitUntil(syncLearningProgress());
  }
});

async function syncLearningProgress() {
  // Retrieve queued progress updates from IndexedDB and POST when back online
  try {
    const db = await openProgressDB();
    const pending = await getAllPending(db);

    for (const item of pending) {
      try {
        await fetch('/api/progress', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(item)
        });
        await deletePending(db, item.id);
      } catch {
        // Still offline — leave in queue, retry next sync
        break;
      }
    }
  } catch (err) {
    console.warn('[Sikai SW] Background sync failed:', err);
  }
}

// ============================================================
//  PUSH NOTIFICATIONS — Daily quiz reminders
// ============================================================
self.addEventListener('push', event => {
  if (!event.data) return;

  let data;
  try {
    data = event.data.json();
  } catch {
    data = {
      title: 'सिकाइ Sikai',
      body: event.data.text() || 'आजको quiz तयार छ! 📝 Daily practice गर्नुस्।',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-72.png',
      tag: 'daily-reminder',
      url: '/sikai.html?action=quiz'
    };
  }

  event.waitUntil(
    self.registration.showNotification(data.title || 'सिकाइ Sikai', {
      body: data.body,
      icon: data.icon || '/icons/icon-192.png',
      badge: data.badge || '/icons/icon-72.png',
      tag: data.tag || 'sikai-notification',
      data: { url: data.url || '/sikai.html' },
      actions: [
        { action: 'open',    title: '📖 Open Sikai' },
        { action: 'dismiss', title: 'Later'         }
      ],
      vibrate: [200, 100, 200],
      requireInteraction: false
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();

  if (event.action === 'dismiss') return;

  const targetURL = event.notification.data?.url || '/sikai.html';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      // Focus existing window if open
      for (const client of clients) {
        if (client.url.includes('sikai') && 'focus' in client) {
          client.navigate(targetURL);
          return client.focus();
        }
      }
      // Open new window
      if (self.clients.openWindow) return self.clients.openWindow(targetURL);
    })
  );
});

// ============================================================
//  MINIMAL IndexedDB HELPERS for progress sync
// ============================================================
function openProgressDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('sikai-progress', 1);
    req.onupgradeneeded = e => {
      e.target.result.createObjectStore('pending', { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess  = e => resolve(e.target.result);
    req.onerror    = e => reject(e.target.error);
  });
}

function getAllPending(db) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction('pending', 'readonly');
    const req = tx.objectStore('pending').getAll();
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

function deletePending(db, id) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction('pending', 'readwrite');
    const req = tx.objectStore('pending').delete(id);
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(e.target.error);
  });
}

console.log('[Sikai SW] सिकाइ Service Worker loaded —', APP_VERSION);

/* Hear Clearly — service worker
   Cache-first app shell so the app opens with zero internet connection,
   even from a cold start. Bump CACHE_VERSION when shipping updated files. */

var CACHE_VERSION = "hear-clearly-v6.0";
var SHELL_FILES = [
  "./",
  "index.html",
  "style.css",
  "app.js",
  "manifest.json",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-192.png",
  "icons/icon-maskable-512.png"
];

self.addEventListener("install", function(event){
  event.waitUntil(
    caches.open(CACHE_VERSION).then(function(cache){
      // "no-cache" bypasses stale HTTP/CDN copies (e.g. GitHub Pages' ~10 min
      // cache) so the precached shell is a fresh, mutually consistent set —
      // never a mix of old and new files.
      return cache.addAll(SHELL_FILES.map(function(url){
        return new Request(url, {cache: "no-cache"});
      }));
    }).then(function(){
      return self.skipWaiting();
    })
  );
});

self.addEventListener("activate", function(event){
  event.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.map(function(key){
        if(key !== CACHE_VERSION) return caches.delete(key);
      }));
    }).then(function(){
      return self.clients.claim();
    })
  );
});

self.addEventListener("fetch", function(event){
  var request = event.request;
  if(request.method !== "GET") return;

  var url = new URL(request.url);
  if(url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request, {ignoreSearch: true}).then(function(cached){
      if(cached) return cached;
      return fetch(request).then(function(response){
        // Cache successful same-origin responses so any file missed at
        // install time still becomes available offline afterwards.
        if(response && response.ok){
          var copy = response.clone();
          caches.open(CACHE_VERSION).then(function(cache){ cache.put(request, copy); });
        }
        return response;
      }).catch(function(){
        // Offline cold start on a navigation: serve the cached app shell.
        if(request.mode === "navigate"){
          return caches.match("index.html");
        }
        throw new Error("offline and not cached: " + request.url);
      });
    })
  );
});

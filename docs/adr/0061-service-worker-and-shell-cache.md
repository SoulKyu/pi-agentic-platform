# ADR 0061: the service worker and the shell cache

Status: accepted (M12, Tasks 13 to 15a)
Date: 2026-10-17
Spec: D19. Rulings: M12R14, M12R15, M12R28, M12R30, W6-R5.

## Decision

A hand-written classic worker (`apps/web/sw/sw.ts`, scope `/`, `updateViaCache: none`) precaches every shell file of the build, lazy chunks included, in a cache named by a build id (the hash of the shell files and of the worker code), so an old shell keeps its lazy chunks after `pap update`. It intercepts same-origin GET only, never caches API, auth, file, socket or `no-store` responses, redirects or non-200s, and answers navigations network-first (8 s) with the cached index as fallback. It does not call `skipWaiting` on its own: the page shows "La page a une mise à jour" and the owner's Reload click sends `skip-waiting`. The page checks for updates after each reconnect and when visible. A click opens only `/n/<22-character id>` or `/`, never a URL from the payload. A push with a malformed payload still shows a generic notification.

## Alternatives

Workbox (a dependency for a small, security-sensitive file); `skipWaiting` at install (a running page would meet new code with old lazy chunks); caching API responses (an authenticated response served to the wrong person).

## Consequences

One full shell download per update (hashed assets use the HTTP cache); a redirecting proxy fails the install and the page says so. The worker budget is 6 KB gzip (3.7 KB used). The banner is about the web shell, not a pap release.

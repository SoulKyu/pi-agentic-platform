# ADR 0004 — the session cookie omits Secure on plain-http loopback

Status: accepted · Date: 2026-10-10 · Spec: C §4.4 · Rulings: R24, R24b

Spec C §4.4 says the session cookie is `HttpOnly; Secure; SameSite=Strict`. The daemon serves plain HTTP on `127.0.0.1:7777` by default, and the M1 exit criterion includes a WebKit run against exactly that address. This ADR records the one case where `Secure` is left off and why nothing else is.

## Context

- A `Secure` cookie is only stored by a browser that considers the connection secure. Chromium and Firefox treat `http://localhost` and `http://127.0.0.1` as secure contexts and keep the cookie. Safari and WebKit do not: they drop a `Secure` cookie set over plain HTTP, even on loopback, so the owner could never stay signed in on the default local setup.
- No `X-Forwarded-*` or `Forwarded` header is read anywhere (R72; a `trustProxy` option is a later milestone), so the daemon cannot learn from a header that a proxy terminated TLS in front of it. The scheme comes from the socket, the host from the `Host` header, and the rest from configuration.
- nginx's default `proxy_set_header Host $proxy_host` rewrites `Host` to the upstream address (`127.0.0.1:7777`). To the daemon such a request looks like plain-HTTP loopback although the browser is on https.

## Decision

- `HttpOnly` and `SameSite=Strict` are always set; `Path=/`; `Max-Age` is 30 days; there is never a `Domain` attribute.
- `Secure` is set when any of these holds: the configured public origin (`PAP_PUBLIC_ORIGIN`, or the origin derived from the listener) is `https:`; the request URL, as built from the socket and the `Host` header, is `https:` (the daemon itself serves TLS); the request host is not one of `localhost`, `127.0.0.1` and `[::1]`.
- `Secure` is omitted only for a plain-`http:` request to one of those three names while the public origin is itself `http:`, which is the default local setup. Any other host name, any other address (including `127.0.0.2`), a trailing-dot `localhost.` and an unreadable URL all keep `Secure`.
- The logout cookie that expires the session follows the same rule, so it can always replace the cookie it clears.
- The rule is two pure functions (`cookieNeedsSecure`, `sessionCookieAttributes` in `apps/daemon/src/modules/auth/cookies.ts`); the public-origin half is computed once at startup. Unit tests cover loopback http (no `Secure`), non-loopback http (`Secure`), https (`Secure`) and an https public origin with a plain loopback request (`Secure` on login, status and logout). An integration test runs the same cases against a real plain and a real TLS listener and shows that forged `X-Forwarded-Proto` and `X-Forwarded-Host` headers change nothing.

## Consequences

- The default `pap serve` works in Safari and WebKit with no setup, and the WebKit end-to-end journey is deterministic.
- A daemon configured with an https public origin always sets `Secure`, so a Host-rewriting proxy cannot downgrade the cookie. The price: Safari and WebKit lose the session when the same daemon is reached directly on `http://localhost:7777`, because the browser drops the `Secure` cookie there. Use the public https URL, or leave `PAP_PUBLIC_ORIGIN` unset for local work.
- Cookies are not scoped to a port. Any server listening on localhost, on any port (a dev server running third-party npm code, for example), receives `pap_session` whether or not the cookie is `Secure`, because Chromium and Firefox send `Secure` cookies to `http://localhost` too. `HttpOnly` keeps page scripts away from the value, not other servers on the host. This is an accepted risk; sessions are revocable (logout) and expire after 30 days without use.
- Exposing the daemon on another interface with `--host 0.0.0.0` and no TLS gives non-loopback hosts a `Secure` cookie that a browser refuses to store over plain HTTP. That is intended: a session must not travel over an unencrypted non-loopback link, so the owner has to front it with TLS.

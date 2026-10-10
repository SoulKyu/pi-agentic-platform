# ADR 0004 — the session cookie omits Secure on plain-http loopback

Status: accepted · Date: 2026-10-10 · Spec: C §4.4 · Ruling: R24

Spec C §4.4 says the session cookie is `HttpOnly; Secure; SameSite=Strict`. The daemon serves plain HTTP on `127.0.0.1:7777` by default, and the M1 exit criterion includes a WebKit run against exactly that address. This ADR records the one case where `Secure` is left off and why nothing else is.

## Context

- A `Secure` cookie is only stored by a browser that considers the connection secure. Chromium and Firefox treat `http://localhost` and `http://127.0.0.1` as secure contexts and keep the cookie. Safari and WebKit do not: they drop a `Secure` cookie set over plain HTTP, even on loopback, so the owner could never stay signed in on the default local setup.
- Loopback traffic never leaves the host. The only parties that can read it are processes on the same machine, and those can already reach the daemon's port and the owner's files.
- No `X-Forwarded-*` or `Forwarded` header is read anywhere (R72; a `trustProxy` option is a later milestone), so the daemon cannot learn from a header that a proxy terminated TLS in front of it. The decision can only use what the socket and the `Host` header say.

## Decision

- `HttpOnly` and `SameSite=Strict` are always set. `Path=/` and `Max-Age` are 30 days.
- `Secure` is set when the request URL, as built from the socket and the `Host` header, is `https:` (the daemon itself serves TLS) or its host is not one of `localhost`, `127.0.0.1` and `[::1]`.
- `Secure` is omitted only for a plain-`http:` request whose host is one of those three names. Any other host name, any other address (including `127.0.0.2`), a trailing-dot `localhost.` and an unreadable URL all keep `Secure`.
- The logout cookie that expires the session uses the same rule, so it can always replace the cookie it clears.
- The rule is one pure function (`cookieNeedsSecure` in `apps/daemon/src/modules/auth/cookies.ts`). Unit tests cover loopback http (no `Secure`), non-loopback http (`Secure`) and https (`Secure`); an integration test runs the same cases against a real plain and a real TLS listener and shows that forged `X-Forwarded-Proto` and `X-Forwarded-Host` headers change nothing.

## Consequences

- The default `pap serve` works in Safari and WebKit with no setup, and the WebKit end-to-end journey is deterministic.
- A local attacker who can already connect to the loopback port could read a non-`Secure` cookie from the wire of that port. They could equally call the daemon directly, so this adds no capability.
- A reverse proxy that terminates TLS and forwards to the daemon with a loopback `Host` header (for example `Host: 127.0.0.1:7777`) gets a cookie without `Secure` over a connection the browser sees as https. `HttpOnly` and `SameSite=Strict` still apply. Until the opt-in `trustProxy` option exists, such a proxy should pass the public `Host` header through (`proxy_set_header Host $host`), which makes the host non-loopback and brings `Secure` back.
- Exposing the daemon on another interface with `--host 0.0.0.0` and no TLS gives non-loopback hosts a `Secure` cookie that a browser refuses to store over plain HTTP. That is intended: a session must not travel over an unencrypted non-loopback link, so the owner has to front it with TLS.

# Auth module

Code: `apps/daemon/src/modules/auth/`. Cookie policy: ADR 0004.

## Flow

- First start: no owner, so the daemon holds a one-time setup token in memory (a restart issues a new one) and `setupUrl()` returns `<publicOrigin>/setup#token=...`. The composition root prints it once with `logger.info("setup_url", { url })`; the field is `url`, never `token`, so the logger does not redact it. Nothing else may log it.
- `POST /auth/setup` verifies the token by SHA-256 digest in constant time, creates the single owner (12+ characters, scrypt N=2^15 r=8 p=3, parameters stored in the hash) and consumes the token.
- Sessions: opaque 32-byte id in `pap_session`, stored as SHA-256, 30-day expiry that slides at most once a day from `clock.now()`. `GET /auth/status` re-issues the cookie so the browser copy slides too.

## Sign-in throttle and its trade-offs

- Keys: socket address (`ip:`) and lower-cased account name (`user:`). Failures double the wait from 1 s to 60 s; a key is forgotten after 5 idle minutes or a success. A failure is counted before the scrypt, so parallel guesses queue behind the first.
- Anyone who knows the owner's username can deny the owner password sign-in indefinitely. Every failure re-arms the `user:` key, and a poller that retries the moment each window reopens wins almost every window, so the owner's own attempt nearly always lands on a throttled key (at most 60 s per window, but a new one opens each time). The password is never bypassed, only made unusable while the attack lasts. Passkey sign-in is the recovery path: it has its own throttle and is never gated by the password keys, so enroll a passkey right after setup.
- The IP key is the socket address. Behind a reverse proxy every client shares the proxy's address, so one noisy client can throttle all of them until `trustProxy` exists.
- Because the lockout is cheap and otherwise invisible, four warn events exist: `auth_login_failed`, `auth_setup_failed`, `auth_passkey_failed` and `auth_throttled`. Each carries the socket address `ip` and `retryAfterMs`, nothing else: never the username (people paste passwords into it), the password, the token or a credential id. `auth_throttled` is written at most once per address every 10 s, so a client retrying every few milliseconds cannot flood the log; a steady stream of it is the sign of an attack.

## Passkeys

Code: `passkeys.ts` (ceremonies), `passkey-http.ts` (routes), `passkey-store.ts` (table `passkeys`). The library is `@simplewebauthn/server`, pinned to 13.3.3 to match the `@simplewebauthn/browser` 13 the web app uses.

- RP ID is the host name of the public origin; the accepted origins are the allowed origins with that same host name. An IP-address origin cannot carry passkeys (WebAuthn rejects IP RP IDs): `GET /auth/status` reports `passkeysAvailable: false` and every passkey route answers 404 (the enrollment routes answer 401 first when there is no session). Use a host name (or `localhost`) to enable them.
- `POST /auth/passkey/register/options` and `/register/verify` need a session. `POST /auth/passkey/login/options` and `/login/verify` do not; a successful verify always starts a new session (`startSession`) and sets a fresh cookie, so a cookie sent with the request is never reused or promoted.
- User verification is required in both ceremonies (R81): `userVerification: "required"` in the options and `requireUserVerification: true` when verifying. A passkey replaces the password, so a stolen authenticator alone must not open the daemon. Consequence: an authenticator without PIN or biometrics (a security key with no PIN set) cannot be enrolled; the enrollment ends in a plain 401.
- A flow (challenge plus the user it is bound to) is single-use: it is deleted on the first verify attempt, whether that succeeds or fails, and after 5 minutes. Login and enrollment flows are kept apart, 100 pending each, the oldest evicted first, so unauthenticated `login/options` cannot grow memory and cannot evict an enrollment in progress. There is no per-address cap yet: one client that requests 100 login options within a flow's lifetime evicts every other pending sign-in, which denies passkey sign-in for as long as it keeps doing that.
- The signature counter is stored at enrollment and replaced after each sign-in. The library refuses an assertion whose counter did not advance when either side is non-zero (a cloned authenticator); authenticators that always report 0, such as synced passkeys, stay accepted. Two parallel sign-ins that present the same counter let one through: the loser finds the stored counter moved and is refused.
- A credential id that is already registered is refused with 409 `conflict`; the first row is left untouched.
- Failed verifications (either ceremony) count on a throttle of their own, keyed by the socket address only, never by account and never shared with the password keys, in both directions (R80, R81): password failures do not block passkey sign-in, passkey failures do not block password sign-in. Each failure is logged as `auth_passkey_failed` and doubles the wait from 1 s to 60 s like the password throttle; a request inside the wait gets 429 with `Retry-After` and no further log line, so the failure lines are the whole signal. Malformed bodies and 404s are not failures. The reason the library gave (wrong origin, no user verification, counter) is deliberately neither answered nor logged.
- Verification against the real library, with a software authenticator, is in `apps/daemon/src/testing/passkey-ceremony.test.ts`; browser behaviour is covered by the Chromium virtual-authenticator journey in Task 27.

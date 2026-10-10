# Auth module

Code: `apps/daemon/src/modules/auth/`. Cookie policy: ADR 0004.

## Flow

- First start: no owner, so the daemon holds a one-time setup token in memory (a restart issues a new one) and `setupUrl()` returns `<publicOrigin>/setup#token=...`. The composition root prints it once with `logger.info("setup_url", { url })`; the field is `url`, never `token`, so the logger does not redact it. Nothing else may log it.
- `POST /auth/setup` verifies the token by SHA-256 digest in constant time, creates the single owner (12+ characters, scrypt N=2^15 r=8 p=3, parameters stored in the hash) and consumes the token.
- Sessions: opaque 32-byte id in `pap_session`, stored as SHA-256, 30-day expiry that slides at most once a day from `clock.now()`. `GET /auth/status` re-issues the cookie so the browser copy slides too.

## Sign-in throttle and its trade-offs

- Keys: socket address (`ip:`) and lower-cased account name (`user:`). Failures double the wait from 1 s to 60 s; a key is forgotten after 5 idle minutes or a success. A failure is counted before the scrypt, so parallel guesses queue behind the first.
- Anyone who knows the owner's username can keep the `user:` key throttled by polling, so password sign-in can be delayed (at most 60 s per attempt) but never bypassed. The owner can still sign in with a passkey: Task 18's passkey login is not gated by the password account key.
- The IP key is the socket address. Behind a reverse proxy every client shares the proxy's address, so one noisy client can throttle all of them until `trustProxy` exists.
- Because the lockout is cheap and otherwise invisible, three warn events exist: `auth_login_failed`, `auth_setup_failed` and `auth_throttled`. Each carries the socket address `ip` and `retryAfterMs`, nothing else: never the username (people paste passwords into it), the password or the token. `auth_throttled` is written at most once per address every 10 s, so a client retrying every few milliseconds cannot flood the log; a steady stream of it is the sign of an attack.

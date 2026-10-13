# ADR 0021 — Bearer tokens on `/ws` without Origin; step-up confirmation

Status: accepted · Date: 2026-10-13 · Spec: C §4.4 (deviation) · Decisions: owner Q7 (b), Q10

## Context

Spec C §4.4 says "`Origin` is checked on the WS upgrade and on every POST", and that API tokens `pap_...` are stored hashed with permissions and an expiry. A script with a token is not a browser: it sends no `Origin`, and refusing every request without one would make tokens useless on `/ws`. The check exists against cross-site requests from a browser that attaches its cookies by itself.

## Decision

- A `pap_` token is accepted on `/ws` through `Authorization: Bearer pap_...` only: never by cookie, never by query string. A malformed `Authorization` header counts as absent, so it cannot hide or replace a cookie. The token may come without `Origin`, never with a foreign one.
- Upgrade order (`kernel/ws/ws-server.ts`): bad URL or path (400/404); an `Origin` that is present must be allowed, whatever the credential (403, `origin_refused`); a cookie and a bearer together, or two `Authorization` headers (400 `conflict`); no `Origin` and no well-formed bearer (403 `origin_refused`: a browser always sends `Origin`, so a malformed bearer without it is a 403, not a 401); another protocol (426); then authentication (401). Every request frame and every keepalive tick re-checks the credential; a revoked or expired one closes the socket with 4401.
- Tokens never hold an `auth:*` permission or `policy:admin` (owner Q7 b): a stolen token cannot mint tokens, remove passkeys, or change the rules that judge its own calls. Expiry is mandatory (7, 30, 90 or 365 days; 90 proposed), at most 50 tokens, stored as a hash, shown once.
- Creating a token and removing a passkey need a step-up: the owner types the password again (`POST /auth/confirm`) and the browser session is marked for 5 minutes. The mark is kept in memory per session, dropped at sign-out, revocation and passkey removal, and forgotten at a restart. Tokens never carry a mark, so a token cannot create a token. Revoking a device needs a browser session but no mark.
- Throttle keys, so a username under attack locks none of the routes that matter (owner Q10): password sign-in and passkey sign-in use the key of a known-device cookie (`pap_device`, HMAC-signed, never a credential) and fall back to address and username; step-up and passkey enrollment use the browser session's own key. Three tables are apart (`password`, `session`, `passkey`), and the one anybody can fill refuses when full while the others cannot be filled without a valid cookie.
- `Caller.kind` (`session` or `token`), `Caller.credentialId` and `Caller.stepUpUntil` are stamped by the transport and never read from params.

## Consequences

- Scripts get a narrow credential that expires; a stolen cookie alone cannot mint one, and a stolen token cannot widen itself.
- The `Origin` rule now has one recorded exception, and the check order is part of the contract: a test pins it for every unsafe route, `/ws` with a cookie and with a token.
- Behind a reverse proxy every client shares the proxy's address until `trustProxy` exists; a known device is not behind that key.
- A persisted receipt of `auth.devices.revokeOthers` can replay across two credentials of the same owner (it needs a `commandId` collision).

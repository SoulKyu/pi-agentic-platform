# ADR 0042: webhook authentication

Status: accepted (M10, Task 24)
Date: 2026-10-15
Spec: C §4.4, §6.4. Rulings: M10R17, M10R18, M10R51 to M10R58, M10R140, M10R161.

## Context

`POST /hooks/<trigger id>` is the one public route that starts work with no cookie and no session. Senders are Alertmanager, Grafana, GitHub and scripts. The route sits behind the owner's tunnel (ngrok), so anyone who learns a URL can send to it.

## Decision

- The route is `POST /hooks/<v4 uuid in lower case>`, JSON out, `Cache-Control: no-store`, `connection: close` on every refusal. It reads no cookie and never echoes a payload or a secret. The Origin guard exempts exactly that path; every other unsafe request keeps the Origin check. In read-only mode it answers `503 read_only` before it reads anything.
- Two modes (the combined `secret+hmac` mode is dropped: its key travelled in the header, so the HMAC proved nothing):
  - `secret`: `Authorization: Bearer <secret>` (the scheme in any case) or `X-Pap-Secret`; two different secrets are refused;
  - `hmac`: HMAC-SHA256 over the raw body under the trigger's secret, hex with or without `sha256=`, in the header the trigger names (`x-pap-signature-256`, `x-hub-signature-256`, `x-grafana-alerting-signature`).
- The secret is `pwh_` plus 32 random bytes in base64url, shown once (create, update, rotate), kept only in `$PAP_HOME/secrets/triggers/<id>.key` (0600, atomic replace), compared in constant time. Rotation replaces the file at once. A trigger whose file is missing refuses every delivery.
- Authentication comes before any backoff. After 10 refused deliveries (401, 413, 400) within 60 s on one trigger, failing requests answer `429 backoff`; a request that authenticates is never refused by it (a `secret` delivery whose header passes skips it, an `hmac` delivery is judged after its body).
- Two body pools: an `hmac` read takes a slot of the unauthenticated pool (8 in the daemon, 2 per trigger), a `secret` read takes a slot of the authenticated pool (4, 2 per trigger) that unauthenticated readers cannot reach. Past a cap: `503 capacity`, never queued. 10 s to read a body, 64 KiB counted as it streams (`413` at 64 KiB + 1, or at once for a larger declared length).
- At most 60 authenticated deliveries per trigger per minute (`429 rate`) and 20 queued tasks per trigger (`429 queue_full`).
- Dedup is the replay protection: the same identity (an alert group, else the body hash) within `dedupMinutes` is `409 dedup`.
- Statuses: `202 {taskId}`, `409` (`disabled`, `paused`, `resolved`, `budget`, `dedup`), `429` (`rate`, `queue_full`, `backoff`, `changed`) with `Retry-After`, `401`, `404`, `413`, `400`, `503`. Refusals are HTTP statuses with a closed reason, not error codes.
- Unauthenticated attempts are one collapsed journal line per trigger and 10-minute window with a count, and a log line (`hook_unauthorized`) with the trigger id and the count, never a header or a body.

## Consequences

Residuals, accepted and named:

- A captured `hmac` body can be replayed once its dedup window (at most 1 440 minutes) has passed. Levers: a longer `dedupMinutes`, the sender's own redelivery checks. Pap keeps no hash of every signed body for longer.
- An outsider who knows four `hmac` URLs can hold the unauthenticated pool (8 slots, 2 per trigger) and make other `hmac` triggers answer `503`. `secret` triggers are untouched.
- Someone who knows one `hmac` URL can keep that trigger's 2 slots busy with slow bodies, so its real deliveries get `503 capacity` until the 10 s read limit frees a slot.
- Journal growth: authenticated deliveries are capped at 60 a minute, so at worst about 86 000 `fired` rows per trigger per day (60 x 1 440) when every body differs and tasks keep draining. Housekeeping cuts the journal to the newest 500 rows per trigger but never cuts a `fired` row newer than the trigger's `dedupMinutes` (RT-17: a storm must not reopen a dedup window), so a storm can hold many rows for that long. Unauthenticated attempts collapse and do not grow it.
- The hook id is not a secret: it shows in the editor and in a sender's logs. Nothing an outsider can do with it may refuse the real sender, which is why authenticated requests skip the backoff.

# ADR 0062: presence by real activity, HTTPS gating and the supervisor

Status: accepted (M12, Tasks 2, 11, 16, 17)
Date: 2026-10-17
Spec: C 4, D19. Rulings: M12R11, M12R16, M12R31, M12R38, W6-R2.

## Decision

Presence is a heartbeat, not connection tracking: a tab calls `push.presence` every 20 s and on focus and visibility changes; `focused` means focused, visible and input in the last 2 minutes; an entry is fresh for 45 s. A dead tab lapses by itself, an idle desktop tab does not silence the phone, and the connection id comes from the authenticated session. `kernel/push-readiness.ts` is the only place that classifies origin, TLS and `--insecure-http`; plain HTTP disables the enable button but not presence. The worker is registered only on a secure context. The connection supervisor changes stay client-side: after 30 s hidden it reconnects at once with the backoff reset, a manual retry skips the ladder, the banner counts down, drafts are kept, and the stream resumes from cursors.

## Notes

`STABLE_AFTER_MS` is 10 s: a connection counts as stable (the backoff resets) only after staying open that long, so a server that accepts and drops immediately keeps backing off. A page restored from the bfcache (`pageshow`) is not covered by resume.

## Alternatives

Tracking sockets in the kernel ws server (an edit to shared code, and a socket is not attention).

## Consequences

One small RPC per 20 s per open tab; a hidden desktop tab may lapse, which means not looking. Over plain HTTP the owner sees the one-line message and the routes in `docs/agents/notifications.md#https`.

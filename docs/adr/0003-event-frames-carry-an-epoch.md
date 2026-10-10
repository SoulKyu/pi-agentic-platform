# ADR 0003 — event frames carry an epoch

Status: accepted · Date: 2026-10-10 · Spec: C §4.2–4.3 · Decision: 34

Spec C §4.3 (as amended by decision 34) says the client resumes with `after = {epoch, seq}`, where `epoch` changes at every daemon start and a cursor from another epoch always gets a snapshot. This ADR records why the cursor has two parts and what that puts on the wire.

## Why

Sequence numbers live in daemon memory and restart at 0 whenever the daemon restarts. A cursor that was only a `seq` is ambiguous across restarts: a tab reconnecting with `after: 500` after a restart could match a new, unrelated event 500 and silently skip everything before it. The epoch makes the cursor name the run of the daemon it belongs to, so a stale cursor is recognised and answered with a snapshot instead of a wrong gap.

## Decision

- An event frame is `{sub, epoch, seq, event}`; the table in §4.2 abbreviates it to `{sub, seq, event}`. Each frame tells the client which epoch its `seq` counts in, so the client can store a complete cursor without a second source.
- A cursor is `{epoch, seq}` (`Cursor` in `@pap/contracts`). `epoch` is a random 64-bit hex string created once per daemon start (`createStreamHub`).
- On subscribe, the hub replays the gap only when all of these hold: same epoch, `seq` not ahead of the stream, and the first missing event still in the ring (at most 128 events and 1 MiB per stream, §4.3). Any other cursor, or none, gets a snapshot frame carrying the stream's current `seq`, and live events continue from there.
- A cursor that is ahead of the stream (same epoch, `seq` higher than anything published) also gets a snapshot: it cannot have come from this run of the daemon.

## Consequences

- The web client keeps `{epoch, seq}` per subscription and sends it back as `after` on reconnect; it never has to compare `seq` across epochs.
- A daemon restart costs each reconnecting tab one snapshot per subscription, which is the same price as a gap larger than the ring.

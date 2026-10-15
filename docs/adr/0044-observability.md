# ADR 0044: observability

Status: accepted (M10, Task 24)
Date: 2026-10-15
Spec: C §9.4. Rulings: M10R91 to M10R99, M10R146.

## Context

C §9.4 promises zero telemetry. The owner still needs to see rates, stalls and spend, and may run a collector of their own.

## Decision

- Trace file: `tracer.span(name, attrs?)` writes one NDJSON line per ended span to `$PAP_HOME/logs/trace.jsonl` (rotating, 10 MiB x 10, 0600). Names are a closed set (`rpc.<method>` of the catalogue only, `outbox.<kind>`, `hook`, `fire`, `precheck`, `feed.fetch`, `task.start`, `run`, `scheduler.tick`, `event_loop.stall`); `outcome` is `ok` or an error code; attributes have closed keys (`verdict`, `status`, `origin`, `code`, `bytes`, `count`) with numbers, booleans or closed strings, never an id, param, path, name or text. A line over 1 KiB is dropped and counted. `pap trace summary [--since 15m|2h|1d]` reads the files without the instance lock, so it works while pap runs; the CLI escapes terminal control characters in span names.
- `GET /metrics` is off (404) unless `PAP_METRICS_TOKEN` (32 to 256 characters) is set; it has its own bearer, compared on SHA-256 digests; a cookie or a pap token is never accepted. Counters that must not go back (`pap_runs_total`, tokens, cost, duration) are read from the `runs` table (cached 15 s) so they survive restarts. `pap_trigger_fires_total` is an in-process counter incremented at each journal write, because the journal's own counts fall when the 500-row cut runs and `rate()` would spike. `provider` and `model` labels go through `labelValue` and `topLabels` keep the 100 most expensive models (same choice at every scrape), the rest `other`. Never a session id, task id, trigger name, owner, path or text.
- OTLP JSON export is opt-in and off by default: no exporter object and no timer exists unless `PAP_OTLP_ENDPOINT` is set (`https://`, or `http://` to `localhost`, `127.0.0.1` or `[::1]`; no userinfo, query or fragment). Spans (queue of 2 048, 512 per POST every 10 s, `/v1/traces`) and a `/metrics` snapshot every 60 s (`/v1/metrics`); 10 s timeout, no redirect, no retry before the next interval; resource attributes `service.name` and `service.version` only; secret headers (`PAP_OTLP_HEADERS`) are never logged. The flush is a closer at the end of the daemon's stop, at most 2 s.
- Stall monitor: `monitorEventLoopDelay` sampled every 30 s on the Clock; a delay beyond 2 s while active is an `event_loop_stall` warning, an `event_loop.stall` span and two counters.

## Consequences

- The only outbound request pap starts for telemetry is the OTLP export the owner enabled. Workers keep `PI_TELEMETRY=0`.
- `usage:read` sees the OTLP host and whether `/metrics` is on in Settings (never a secret).
- In read-only mode the trace file and the OTLP timer are off; the stall counters still run.

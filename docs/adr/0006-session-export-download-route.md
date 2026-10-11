# ADR 0006 — exported transcripts are served by a download route

Status: accepted · Date: 2026-10-11 · Spec: C §4.5 (HTTP routes) · Rulings: M2R95–M2R99

## Context
Pi's `export_html` writes one self-contained HTML file with inline script, built from the transcript: model output,
tool output, file contents. It can exceed a WebSocket frame (1 MiB). Served from the pap origin as a page, its script
would run on the origin of the session cookie. Spec C §4.5 lists no export route.

## Decision
`sessions.exportHtml` (a mutation: `sessions:operate`, `commandId`, owner check) has the session's worker write the file
under `$PAP_HOME/exports/<random>.html` (0700 directory) and answers `/api/sessions/:sessionId/export/:token`.

The route:
- needs the session cookie (`401` otherwise) and a token that is 43 base64url characters (32 random bytes), checked,
  like the session id, before any lookup; nothing of the URL becomes a path;
- takes the token once: the entry and its timer are gone before the file is opened, and a token that is unknown, used,
  expired, or bound to another session or owner gets the same `404`;
- opens the file, unlinks it while it is open (so nothing stays on disk whatever happens to the response), and streams it
  with its length;
- answers `Content-Disposition: attachment` (name from the session's name: ASCII fallback plus RFC 5987 `filename*`, no
  quote, separator or control character; a fixed name without one), `Content-Security-Policy: sandbox; default-src
  'none'`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`.

The HTTP app lets a route that sets `ownCsp` replace the global CSP on a successful answer; every other route and every
error page keeps the global one.

Tokens live in memory: at most 16 pending, 10 minutes each on the kernel clock. Pending files are deleted at stop and the
directory is emptied at boot. A request that times out keeps its entry until the TTL (Pi may still write the file); a
refusal, a lost worker or a worker that cannot start discards it at once.

Before serving, the daemon makes the template's three recursive tree helpers (`sortChildren`, `mapNodes`, `markActive`)
iterative, with pap's own code: each anchor must match exactly once or nothing is patched and `export_patch_skipped` is
logged. A file over 64 MiB, or one that cannot be read or written, is served as Pi wrote it.

## Consequences
- A browser saves the file; opened from disk it runs as a local file, outside the pap origin. The CSP `sandbox` also
  denies scripts if a browser were to render it in place.
- A token is useless without the owner's cookie, and a cross-site request carries no cookie (SameSite=Strict).
- A restart loses pending exports: the user exports again.
- The file holds everything the agent saw, secrets in tool output included; the UI says so before the download (Task 28a).
- The patch is tied to Pi 1.1.0's template; a Pi upgrade that changes it serves exports unpatched (logged) until the
  anchors are updated.

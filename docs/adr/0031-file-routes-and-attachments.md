# ADR 0031 — File routes by query path, cookie-only HTTP, uploads with reservations, attachments claimed per session

Status: accepted · Date: 2026-10-14 · Spec: C §4.5 (HTTP routes: `POST /upload`, `GET /files/*`) · Rulings: M8R31-M8R43, M8R105-M8R109, MC4, MC21

## Context

Spec C §4.5 lists `POST /upload` and `GET /files/*` ("cookie or token + permission", pi-web's allowlist kept). Three things do not fit M8:

- A path in the URL tail (`/files/<abs path>`) goes through the router, proxies and logs, and every layer has its own idea of `..`, `%2e`, `//` and encoded slashes. The path is also a secret of the owner's layout.
- A file is untrusted content. Served as a page of the pap origin it would run on the origin of the session cookie.
- An upload of tens of megabytes must not sit in memory, nor stay on disk when its body stops short, and a prompt must not trust a path that a client names.

## Decision

Routes (`modules/files/`, mounted by `compose-workspace.ts`):

- `GET /files/raw?path=<abs>[&download=1]` (`files:read`), `PUT /files/raw?path=<abs>&conflict=skip|replace[&confirmProtected=1]` (`files:operate`) and `POST /upload?sessionId=<id>&name=<name>` (`sessions:operate`). The path is a query value, decoded once, and judged by the path boundary (`docs/agents/files.md`); an answer never says why a path was refused (`not_found`).
- Cookie only. A request with an `Authorization` header, or without a live browser session, is `401` (`kernel/http/caller.ts`). A token uses the RPC methods (`files.list`, `files.read`, `files.search`, `files.write`), where the same boundary applies with the token rules. This replaces "or token" for HTTP: bearer tokens stay on `/ws` (ADR 0021). `Origin` is checked by the existing guard on every unsafe method, and the cookie is `SameSite=Strict`.
- The raw route serves an image (png, jpeg, gif, webp, avif, bmp, ico, svg) inline up to 20 MiB and everything else as an `application/octet-stream` attachment, with `Content-Security-Policy: sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'` (its own, through `ownCsp` as in ADR 0006), `nosniff`, `no-store`, `no-referrer` and a safe download name. HTML and XML are never served inline; an SVG is only ever shown inline under the `sandbox` policy (an opaque origin, no script).
- Uploads are one file per request with a counted body: `Content-Length` is required and at most 25 MiB; the boundary and the write gate answer before the first byte is read; the body is checked against its declared length while it streams and lands through a temporary file and an atomic rename. At most 4 uploads in flight per owner (`503 capacity`, never queued). Node's request timeout is written down in `kernel/http/server.ts`: 300 s (MC4), about 700 kbit/s for 25 MiB.
- `POST /upload` makes a pending attachment. Its declared length is reserved before the body is read (per owner: 32 uploads and 200 MiB, else `409 limit_reached`; refuse, never evict). The file is stored under `$PAP_HOME/attachments/pending/<id>` with mode 0600, its kind sniffed from the bytes (png, jpeg, gif, webp: `image`; anything else: `file`), and expires after an hour. The index is in memory; the folder is emptied at boot.
- `sessions.prompt` carries `attachments: [id]` (at most 10). The daemon claims them for that session and owner (`attachments-store.ts`, one claim at a time): another owner's or another session's id is `not_found`; the pending file is re-opened through the deny set. Images stay in `pending/` and travel to the worker as paths; files are copied to `attachments/<session>/<id>/<name>` and announced in the message as an `Attached files:` list of paths. The agent reads them with its own tools.
- The worker reads an image itself, from `pending/` only: a real path inside that folder, `nlink` 1, at most 10 MiB, the header's pixel size checked before decoding, then Pi's `resizeImage`. A prompt goes with all of its images or none (`pap:image_unreadable`). Pi's echo of the message and tool results leave the image data out on the wire (`omitted: true`, the size kept).
- What the owner attaches does not taint the session (M8R99).

## Consequences

- No route parses a path out of a URL tail. A proxy that rewrites query strings would break the routes; none is supported.
- A script cannot upload or download files over HTTP with a token. It uses `files.read` and `files.write` (frames of at most 1 MiB, files up to 384 KiB for a write); a larger transfer needs a browser session. This is a deliberate narrowing.
- A slow link fails a large upload with a clear message after five minutes instead of hanging; the web shows "The upload stopped before the end".
- Pending uploads are lost at a restart and expire after an hour; copies of claimed files stay in `attachments/<session>/` until M10's cleanup (the folder's size is logged at boot as `attachments_size`).
- The `attachments/` folder is under `$PAP_HOME`, so no files route lists or serves it; the deny walk skips it so that its churn never fills the private-inode set (MC21).

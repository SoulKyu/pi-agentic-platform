# ADR 0026: a masked editor for models.json

Status: accepted (M7, Task 12a)

## Context

Settings › Models lets the owner edit Pi's `models.json` as text. The file can hold literal API keys and header values. The browser must not receive them, and a save must not lose them, without the daemon keeping any secret state. A saved provider entry can also point Pi at any URL or run a `!command`, so the write is a code-running change (owner c3, M7R133).

## Decision

- The helper masks: every literal secret becomes `"<redacted:N>"` (N in document order), by a tokenizer (`scanJsonc`) that sees comments and escapes. A value is masked when a key above it contains a credential word on the key's letters (key, token, secret, password, passwd, auth, bearer, credential, cookie, pwd, passphrase, session, signature: the list shared with the MCP masker, `helper/credential-words.ts`, MC41), sits under `headers`, or is a URL with user information. References (`$NAME`, `${NAME}`) and commands (`!...`) stay readable. In a comment, from right after the first credential word to the end of the line is masked. Over-masking is accepted. A file that does not parse is not shown (`text: null` plus positions): masking is only trusted on valid JSON.
- The save is stateless: it re-reads the file, checks its revision (an HMAC of the text under a key made at each daemon boot), re-masks it, restores an original only at the exact key path it was masked at (a moved, duplicated or unknown placeholder is refused as `masked_value_moved`), validates (Pi's own tolerance, a lenient shape, Pi's loader on a temporary copy) and writes through `pi-file.ts` (atomic, 0600, links confined to the agent directory and the home). Refusals for content carry JSON paths only.
- The save takes the password step-up and `pi:admin` (a token never holds it). It shares the models service's write queue with the settings writes.
- After a save, `enabledModels` is re-asserted for the providers that were fully enabled (`resync`). Deviation from pi-web: renames are not tracked, because the editor is text, not a structured form; the owner prunes.
- The file may be a symlink anywhere inside `$HOME` (dotfiles, owner m13, M7R146).

## Consequences

- `models.config.get` requires `pi:admin` (MC33): browser sessions only, never a token, since masking is best effort. Shown to the owner's session: a `!command` that embeds a literal, a secret under a name with no credential word, a comment value on another line than its credential word or before it, free text in a comment with no credential word. Listed in `docs/agents/models.md`.
- The revision is an HMAC under a per-boot key, so it is no oracle for guessing a weak secret; the cost is one `conflict` and a reload after a daemon restart.
- A hard link made between the check and the rename is split by the rename, and an outside writer landing between the second revision check and the rename loses its change; a folder sync failure after the rename does not fail the write. All are same-user residuals.

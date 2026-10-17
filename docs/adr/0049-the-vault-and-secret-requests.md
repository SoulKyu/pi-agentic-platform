# ADR 0049: the vault and secret requests

Status: accepted (M11a, Task 28)
Date: 2026-10-16
Spec: C §5.3, §5.5. Rulings: M11R83 to M11R88, M11R103 to M11R107, M11R165, M11R166, W5-R17, W5-R37, W5-R38, W5-R52. Owner answers m5, m6.

## Context

An agent that works alone needs credentials: a token for a forge, a database password. They must not live in its role text, in its home (the agent writes there and a backup copies it), in an environment file the owner edits by hand, or in the model's context. The owner must be able to give one when the agent asks, and to take it back.

## Decision

Storage (`modules/secrets/vault-store.ts`):

- `$PAP_HOME/secrets/vault/key` holds 32 random bytes, mode 0600, made once. `$PAP_HOME/secrets/vault/<ownerId>/<scope>.json` (0600 in 0700) holds one AES-256-GCM entry per name with a fresh 12-byte IV. The additional data bind the owner, the scope and the name, so a ciphertext copied to another agent or renamed does not open. Writes go through a temporary file, `fsync`, rename and a folder `fsync`; every byte is written or the write throws. Reads refuse a link, a group- or world-readable file, a file of another uid and an oversize file (1 MiB).
- Scopes: `agent-<id>` (M11) and `user` (reserved for M14's per-user GitHub token, read by the forge adapter only and never given to an agent; nothing in M11 writes it).
- Names are `^[A-Z][A-Z0-9_]{0,63}$` minus the environment-hijack list (`isVaultName` in contracts: `PATH`, `LD_*`, `GLIBC_TUNABLES`, `*_PROXY`, glibc's unsecure-environment names and the rest). A scope holds 50 names; a value is 1 to 4 096 characters. The schema, the service and the store each refuse a bad name.
- The key is never replaced over sealed files. If the key file is missing while sealed files exist, the vault reads `unreadable` (the list says so and gives no names), and a `secrets.set` answers `command_failed` and logs `vault_key_lost`. The owner restores the key file or removes the vault folder. There is no key rotation in M11. The key is created with a hard link (Linux); a file system without hard links cannot make the key, so it cannot open the vault.
- Methods are names-only: `secrets.list` (names and update times), `secrets.set`, `secrets.delete`. A token gets `forbidden` on all three (`secrets:*` is a browser permission). The value of `secrets.set` and of `secrets.answerRequest` is a sensitive parameter: the receipt of the call hashes the selector (`agentId`, `name`, or `requestId`, `mode`) and never the value. Every set and delete writes an audit row with the agent id, the name and the operation. Through pap's own paths no value reaches a response, an audit row, a log line, a receipt or a stream. That claim stops where pap's code stops: a command the agent runs with the value in its environment can print it, and the redactor does not catch a value under 8 characters or an encoded one (see Known limits).

What it protects against and what it does not:

- It protects against a copy of one vault file taken without the key file (a stray `cat`, a backup that leaves `secrets/vault/key` out), and against an agent or session reading pap's files through tools (`secrets/` is a protected read, M5R29, and `$PAP_HOME` is hidden in the sandbox).
- It does not protect against a process of the owner that reads both files, as with `auth.json`.
- **A backup of the whole `$PAP_HOME` is as good as plaintext unless it leaves `secrets/vault/key` out.** The key sits beside the vault by design: pap has no passphrase to ask for at boot.

In use:

- The daemon decrypts an agent's scope when the thread's or a task's worker starts (`init.vault`), and pushes `vault_update` to the live workers of that agent after a change (never to a child, never to a worker whose sandbox is off). A change made while a worker boots reaches it too: the daemon compares the vault in `init` with the current one after the worker is live and sends the difference.
- The worker adds every value of 8 characters or more to its redactor (stage 06: `[SECRET:NAME]`, never restored into a write or an edit) and to the environment of its sandboxed shell. A name removed from the vault stays redacted until the worker exits. Without the sandbox the vault is not given to the shell.

`secret.request` and one-use values:

- The agent calls `secret_request {name, reason}` in a thread whose sandbox is on. The owner answers in the thread's request card or in the Inbox, typing the value into a masked field, and chooses "Use once" (the default, owner m6) or "Save in <agent>'s vault". The answer is a browser session's; a token cannot give or decline one.
- The tool returns `secret-ref:<32 hex>` (an HMAC-SHA-256 of the request id under a 32-byte salt in `secrets/vault/ref-salt`, made when the first ref is made), the name and the mode. The ref is never resolved by any RPC. The request row keeps the ref's hash, not the ref.
- "Use once": the value waits in the daemon's memory (24 hours, 3 per agent; a fourth is refused with `limit_reached` and the request stays open) and in the asking worker's. It goes into the environment of the first sandboxed command whose text names `$NAME` or `${NAME}` exactly (not `$NAME2`), then the worker forgets it and reports `secret_used`. `vault_update.once` is the full list of waiting values and replaces the worker's set at each record (W5-R37), which also heals a lost `secret_used`. A thread reset, an agent delete and a quarantine drop the waiting values (W5-R52); so does a daemon restart.
- An answer is audited before the value is kept, and the audit row is written before the request closes. A refusal after that (a full vault, a full quota) writes a second row "secret answer failed" with the code only.
- The card says when the asking thread has read external content (its current taint, W5-R38). The asking text is the agent's: shown as untrusted text, stripped and cut to 500.

Known limits:

- "Use once" bounds how long a value is available, not who sees it. Within that command the agent can print the value, and whatever the agent can reach can receive it (ADR 0047: hosts, not content).
- Values under 8 characters are never redacted.
- Redaction is literal: an encoding of a value (base64, split, reversed) is not recognised.
- After a worker restart the redactor no longer knows a one-use value that was already used.
- A vault value sits in the sandbox's environment for the life of the command; same-user processes outside can read it through `/proc/<bwrap pid>/environ` (ADR 0048).
- An agent row whose id is not valid is skipped from the agent list and logged (`agent_row_unlistable`); its vault cannot be seen or deleted from the UI.
- A backup of the whole `$PAP_HOME` holds the key (RT-13).

## Consequences

- An owner who loses the key file loses the vault: the entries stay on disk and unreadable until they remove the vault folder and enter the values again.
- Moving a `$PAP_HOME` between hosts means moving `secrets/vault/` whole.
- A new agent has no vault entry; an agent without its sandbox that calls `secret_request` is answered `sandbox_unavailable` before any request opens.

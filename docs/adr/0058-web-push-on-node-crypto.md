# ADR 0058: Web Push on node:crypto, one VAPID key under secrets/push

Status: accepted (M12, Tasks 3 and 6)
Date: 2026-10-17
Spec: C 6.2, D17. Rulings: M12R4 to M12R6, owner n3 and c5, W6-R8.

## Decision

Encryption (RFC 8291, aes128gcm) and the VAPID JWT (ES256) are written on `node:crypto` in `modules/push/transport/` (54 lines for the encryption, `encrypt.ts`), pinned by the RFC's own test vector and a round-trip decryptor in the test kit. The transport owns the encryption: `send(target, plaintext)` seals inside, no caller does. One P-256 pair per `$PAP_HOME` lives in `secrets/push/vapid.json` (dir 0700, file 0600), created with `O_EXCL|O_NOFOLLOW` and a `link()` so a concurrent writer is never overwritten, read with a size cap, an owner check and `O_NONBLOCK`, and checked by signing and verifying a probe. A damaged, linked or too-open file turns push off (`keys_unreadable`) and is never regenerated, because a new pair would orphan every subscription. A missing file is a first boot or a deliberate reset: a new pair is minted and subscriptions with another key id are purged.

## Alternatives

The `web-push` package: it pulls a tree for ECE, JWT and HTTP that would still have to be wrapped to enforce the guarded DNS lookup, the deadline and the no-redirect rule. Storing the key in `state.db`: a backup of the database alone would then carry a key that lets its holder push arbitrary text to the owner's devices.

## Consequences

We own the crypto: a bug makes every push undecryptable, mitigated by the vector. `secrets/push/` is excluded from plain backups (like `secrets/`); after a plain restore each device re-enables when it next opens pap. The readiness truth (`kernel/push-readiness.ts`) is a pure function; `keys_unreadable` is a status of the key store and of the doctor's `push` check, not an origin fact (W6-R2).

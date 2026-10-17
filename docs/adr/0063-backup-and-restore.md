# ADR 0063: backup and restore

Status: accepted (M6b, tasks 1 to 5b, 16)
Date: 2026-10-17
Spec: D21. ADRs 0049, 0057. Rulings: M6bR1 to M6bR9, M6bR48, M6bR49, M6bR55, owner b1 to b3 and c5, M6b-RT-01, RT-08, RT-10, RT-20 to RT-22, M6b-C1, C2, C8, C9. Guide: `docs/agents/backup.md`.

## Decision: format

- One file, `pap-backup-<UTC stamp>.tar.gz`, or the same name plus `.enc`. `tar --format=pax` with `--owner=0 --group=0 --numeric-owner`, then gzip. Members, in order: `manifest.json`, `state.db`, `attachments/`, `agents/`, `exports/`, `secrets/` (rule below) and Pi's `sessions/` as `pi-agent/sessions/`.
- `state.db` is a `VACUUM INTO` snapshot taken from a read-only connection, so a backup works while the daemon runs and leaves no `-wal` or `-shm`. The manifest carries its SHA-256 and its migration ids; restore re-reads both and refuses when they disagree. Other files carry no per-file hash.
- Encrypted container: `PAPB1\n`, scrypt cost (log2 N 17, r 8, p 1), salt, IV, AES-256-GCM, tag; the header is the additional data. `node:crypto` only, no dependency. The stream is encrypted as it is produced, so no plain archive ever exists on disk. There is no key-check value (M6b-C2): restore is rare, and a check value is an offline verifier for the passphrase and a format change; a typo costs one full read.

## Decision: the secrets rule (owner b1, c5)

`secrets/` (vault key and scopes, `ref-salt`, `device.key`, `triggers/*.key`, `secrets/push/vapid.json`) is excluded by default and the summary says so. `--secrets include` is accepted only with `--encrypt`. The rule is one pure function with a truth-table test. A plain backup is allowed (owner b2) with one line of warning and is still not a clean file: Pi transcripts, agent folders and `state.db` can hold a value someone pasted or a tool printed, so the copy says "treat this file as sensitive, and use --encrypt before copying it off this machine". After a plain restore the vault, the webhook keys, the known-device key and the push key are gone; the restore summary says so and prints "Notifications: each device re-enables when it next opens pap." because M12 mints a new push key pair at the next start.

## Decision: what a plain backup detects

Corruption (gzip CRC, the database hash and migration ids), not tampering. A swapped agent file in a plain backup restores silently. Encryption (GCM) detects tampering. Cost if wrong: an attacker who can write to the backup medium can plant an agent file in a plain backup; the answer is `--encrypt`.

## Decision: the archive is untrusted, three layers (M6bR6, M6b-RT-01)

None of them is enough alone, and each has tests and mutation checks.

1. `listMembers`, a hand-written header reader, runs before anything is extracted: every checksum verified (ASCII only, M6b-C8), only plain files and folders, safe relative names, a pax header with only `path` and the times, a folder mode that keeps owner read and execute (M6b-C9), count and size caps.
2. `tar -xzf` with `--no-same-owner --no-same-permissions --no-overwrite-dir` into a private stage in the home.
3. `assertPlainTree` lstat-walks the stage and refuses anything that is not a regular file or folder, or a file with another hard link, before any chmod or placement. Then `ownerOnly` keeps `mode & 0o700`.

The pax lesson: the first reader accepted a pax `size` record. GNU tar honours it and a naive reader reads the ustar size, so a hidden symbolic link member was parsed as content by one and as headers by the other. The reader now refuses every pax record but `path`, `mtime`, `atime` and `ctime`, and a differential test against GNU tar pins the two readers together. A file of 8 GiB or more makes GNU tar write a pax `size`; such a backup fails its own check at creation and is removed.

## Decision: restore

Order of refusals (M6bR7): another operation holds `update/op.lock`; the daemon holds the instance lock; an existing `state.db` without `--replace`; not a pap backup; a `format` or schema from a newer pap; free space. With `--replace` nothing is deleted: the old database becomes `backups/pre-restore-<stamp>.db` and the replaced folders move under `backups/pre-restore-<stamp>/`. Pi sessions are added only when missing (`COPYFILE_EXCL`, M6bR8). A power cut between the folder renames and the `state.db` rename leaves a mixed home whose old data is under those paths; no marker or automatic undo exists (M6b-RT-22, deferred).

## Not covered

Encrypted backups are not re-read at creation (M6b-RT-20). A directory fsync failure after the final rename is reported as a failure although the file is there. A backup outside the home is the owner's to move; `--keep` only prunes `pap-backup-*` names in the output folder. Worst case for the reader: about 7,900 members with 1024-unit two-byte paths reach 1.85 GB of peak memory before the cap refuses (same bound as before; fails closed).

# ADR 0057: archive integrity pinned in the installer

Status: accepted (M6, Task 7)
Date: 2026-10-15
Spec: A success criterion 3. ADR 0055. Rulings: M6R9, M6R20 to M6R26, M6R38, M6R39, M6R41, W5-R10.

## Threat model

The installer script embeds the SHA-256 of the final `.tar.gz`. It protects against corruption and tampering of the archive in transit, if the script itself came over a trusted channel. It does not protect against a compromised build host, nor against script and archive taken together from an untrusted channel. Signing and an SBOM come after v1 (ADR 0066). Messages say "the archive matches the checksum pinned in this script", never "the archive is safe".

## Decision: builder

- Release id `<version>-<sha7>[-dirty]-<UTC yyyymmddHHMM>`, checked against `[A-Za-z0-9._-]{1,64}`; template values (checksum, id, archive name, glibc) are validated and nothing else is interpolated. A dirty tree is refused without `--allow-dirty`.
- The stage carries an allowlisted `.npmrc` (only `engine-strict`) or none, never the builder's file; the staged `.npmrc`, `pnpm-workspace.yaml`, `package.json` and the workspace manifests (`apps/*/package.json`, `packages/*/package.json`) are scanned for registry credentials (`_authToken`, `_password`, `_auth=`, `//registry` auth, `npm_` tokens) and the build refuses. `node_modules/.modules.yaml` and pnpm's `.bin` shims are removed and node-gyp leftovers under node-pty's `build/` pruned (they named the builder's paths), and the build fails closed if any staged file still names the stage or the builder's home (W5-R10).
- `tar --sort=name --owner=0 --group=0 --numeric-owner --mtime=@<epoch>`: byte-identical given the same staged tree; real pnpm output (hardlinks, mtimes) was verified across two runs, not by the fake-runner test.

## Decision: installer

- Refuses root, a non-Linux-x64 host and an unsafe `HOME` before anything is hashed, copied or written.
- Private copy: the archive is copied once into a 0700 stage folder; the hash, the listing and the extraction all read that copy, so they see the same bytes. The same-user race that remains (the owner's own account changing files in its own 0700 folder) is the user's own account.
- `unset TAR_OPTIONS` first: a user-set tar option (`-P`, `--exclude`) must not change how the archive is read or where it writes.
- Listing check: `tar --numeric-owner -tvzf` parsed with awk; every member under `pap-<id>/` without a `..` segment, only files, folders, symlinks and hardlinks, no link target outside the release, a listing the parser cannot read is refused (GNU tar required).
- Extraction with `--no-same-owner --no-same-permissions` under `umask 077`, then `chmod -R u+rwX` (a restrictive folder must not hide anything) and fatal `find` checks: no member that is not a file, folder or link, and every link resolves inside the release. A failing `find` is fatal, never read as "nothing found".
- Completeness: `node/bin/node` and `app/apps/daemon/dist/main.js`; an incomplete `releases/<id>` is replaced.
- Order: switch `current` only after verification; run `pap service install`; on failure put the previous `current` back (after `reset-failed`) and restart the service; exit 3 from it (installed, unverified: unreadable journal) keeps the new release, rolls nothing back and exits 3 itself (W5-R22); prune releases other than the new and the previous last, and skip pruning when the new id is already `current` (the rollback target stays). Prune failures only warn (a successful install is never rolled back for a cleanup problem), and symlinked release entries are skipped.
- `~/.pap` is never read or written.

## Not covered (after v1; the update path of M6b is ADR 0064)

Archive signature, SBOM, a provenance channel. The link check runs against the stage location. Installed files lose read-only modes (folders are owner-only). Cost if wrong: a pinned but malicious archive from a bad build still runs as the owner once installed, which is the point of the trusted-channel sentence above.

# ADR 0077: the licence

Status: accepted · Date: 2026-10-18 · Spec: the release gate of `docs/agents/release.md`. Rulings: M13R57; owner q14.

## Context

The package said `UNLICENSED`. A public release needs a licence. The recommendation was Apache-2.0; the owner chose AGPL-3.0 (q14) and then the SPDX id `AGPL-3.0-or-later` on 2026-10-18.

## Decision

pap is licensed under **AGPL-3.0-or-later**. Commit `e264c2b9` on `main` adds the official `LICENSE` text, `"license": "AGPL-3.0-or-later"` in the root and `apps/daemon` `package.json` files and a README section.

- One file derived from vercel/ai-elements stays under Apache-2.0: `LICENSES/Apache-2.0.txt` is kept and named in `THIRD_PARTY_NOTICES.md`. Apache-2.0 code can be combined into an AGPLv3 work.
- `pnpm release:check` accepts exactly: `UNLICENSED` with no `LICENSE` file, or an `AGPL-3.0-only` or `AGPL-3.0-or-later` id with a root `LICENSE` whose first line is the GNU Affero title, the same id in both `package.json` files, and the Apache text present and named. Anything else fails.
- The npm builder copies the root id and the `LICENSE` file into the package and refuses to build without them.
- The repository `SoulKyu/pi-agentic-platform` went public the same day (2026-10-18).

## Consequences

Network users of a modified pap are owed its source (AGPL section 13). Cost if wrong: one constant (the allowed ids) and the `LICENSE` text.

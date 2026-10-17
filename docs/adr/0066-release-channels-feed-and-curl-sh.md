# ADR 0066: release channels, the feed and `curl | sh`

Status: accepted (M6b, tasks 2, 9, 13 to 15, 16)
Date: 2026-10-17
Spec: D21. ADR 0055 (which deferred `curl | sh` and npm), ADR 0057. Rulings: M6bR20 to M6bR23, M6bR33 to M6bR36, M6bR57, owner b4, b5 and b10, M6b-RT-15, RT-16, RT-17, M6b-C7. Guide: `docs/agents/install.md` (Releases and channels, One-line install), `docs/agents/update.md`.

## Decision: what pap trusts, and where

The only outbound requests of pap's update path are the feed, the installer and the archive (T2's `fetchLimited`): `https:` only, a host in `{github.com, objects.githubusercontent.com, release-assets.githubusercontent.com}`, a `github.com` URL only under `/SoulKyu/pi-agentic-platform/releases/` (one constant, `FEED_REPO`, M6bR57), no credentials and no port, at most 3 redirects each re-checked, a deadline and a byte cap enforced while reading, nothing about the machine sent. `FeedSchema` (strict, format 1) additionally refuses encoded separators in a path, pre-release identifiers that are empty, release ids `.` and `..`, and an asset URL whose last segment is not the asset's name. Cost if wrong: if the owner renames the repository, `FEED_REPO` is the one line to change (and the canonical owner casing is checked with a `curl -sI` redirect chain at the v1 flip: a private repository answers 404, so Appendix A cannot run it).

## Decision: channels

- `stable`: a `vX.Y.Z` release made by release-please, each carrying `pap-feed-stable.json` and `.env`; `releases/latest/download/` serves the newest. A stable `--tag` must be `v<root version>` (`release:assets` refuses otherwise).
- `next`: one rolling pre-release with the fixed tag `next`, assets replaced with `--clobber`; its versions look like `1.3.0-next.12`. The `next` tag keeps the commit of its first run; the feed carries the real version.
- Choice: `--channel`, else `PAP_UPDATE_CHANNEL`, else `stable`. A feed of the other channel is refused.
- The version source of truth is the root `package.json`, mirrored into `apps/daemon/package.json` by release-please and held in `.release-please-manifest.json`; `pnpm release:check` fails when they differ.

## Decision: what the feed does and does not prove (owner b5)

No signature before v1. The feed names the hosts it trusts and the SHA-256 of the installer; the installer pins the archive's SHA-256 (ADR 0057). Together they detect corruption, a half-replaced download and a swapped asset. They do not detect a compromised GitHub account or release. Every message says "the feed comes from github.com, a trusted host; the release is not signed", never that the release is safe. What signing will add after v1: a detached signature over the feed and the installer checked with a key printed in the README (Sigstore or minisign, to be chosen then), an SBOM and a provenance attestation; each is an additional file in the release and a check in `update install` and `get-pap.sh`, with no change to the transaction.

## Decision: `curl | sh` (`scripts/get-pap.sh`)

The script is 73 lines, one function called on the last line (a download cut at a line boundary runs nothing), reads the `.env` feed as data (seven fixed `KEY=value` lines validated against fixed shapes, never `source`d), downloads the installer, compares its SHA-256 with the feed's and only then fetches the archive and runs the installer with `bash` and standard input from `/dev/null`. All downloads are `https` only with a size and time cap. Its trust root is the same host as the files it fetches: `curl | sh` runs a script the reader has not read, so the docs tell them to read it, pin it to a tag, or download it first. It needs a public repository and a published release; while the repository is private it stops at "download failed". The tests drive it against a fake `curl`: they pin the flags it passes, not what a real `curl` enforces with them (a `--max-filesize` without a `Content-Length` is a no-op; the hash check makes that safe).

## Decision: the v1 flip (owner b10, M6bR22, M6bR36)

Until the repository is public, no workflow runs by itself and the daily update check is off. The flip is one reviewed commit that (1) adds `push: branches: [main]` to `on:` of `.github/workflows/release.yml` (and relaxes `release:check`'s trigger rule accordingly), (2) sets `UPDATE_CHECK_DEFAULT` to `true` in `apps/daemon/src/update-check.ts`, (3) checks the canonical casing of `FEED_REPO` with a `curl -sI` redirect chain (it cannot run while the repository is private: it answers 404), (4) removes the pnpm cache restore from the jobs that hold `contents: write` in `release.yml` (`setup-node` with `cache: pnpm` through `.github/actions/setup`: a poisoned cache would run in a job with a write token), and (5) enables the repository setting "Allow GitHub Actions to create and approve pull requests" that release-please needs. `PAP_UPDATE_CHECK=1` enables the check before the flip and `0` disables it always. The workflow has never been run: the action pins were resolved with `gh api` on 2026-10-17 and nothing else is tested. Owner actions before any `npm publish`: confirm or reserve the `@soulkyu` scope and check who owns `@pap` on npmjs (the published name is `@soulkyu/pi-agentic-platform`, owner b4); choose a licence (the package says `UNLICENSED`); generate `npm-shrinkwrap.json` with both `@pap/*` entries `inBundle` (M6b-C7), because otherwise a missing bundled copy would resolve `@pap/contracts@0.0.0` from the registry by name.

## Cost

The feed host is a single point of trust, and a private repository makes every URL answer 404 until v1. Both are the owner's accepted trade-off for a KISS release path without signing infrastructure.

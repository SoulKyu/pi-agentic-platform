# Release runbook (v1.0.0)

Every step below is the owner's. No step is run by the M13 plan or by a task: the release workflow has never run. The licence and the public repository are already done (step 0). Order matters. Each step says what it verifies and when to stop.

pap does not replace pi-web (owner q12). There is no cutover step: pap and pi-web keep sharing `~/.pi/agent`, and the preview keeps its run mode. The rule for the shared folder is in `docs/agents/sessions.md`.

Background: ADR 0066 (channels, feed, the flip) as amended by ADR 0076; the licence is ADR 0077. Install side: `docs/agents/install.md`; update side: `docs/agents/update.md`.

## 0. What is already done

- Licence (owner q14), done 2026-10-18 in commit `e264c2b9` on `main`: `AGPL-3.0-or-later`, a `LICENSE` file at the root with the GNU Affero General Public License v3 text, the same `license` in `package.json` and `apps/daemon/package.json`. `LICENSES/Apache-2.0.txt` and `THIRD_PARTY_NOTICES.md` stay (they cover the one derived ai-elements file). ADR 0077 is the licence decision.
- Repository public (owner q16), done 2026-10-18: the owner set the visibility. `ci.yml` therefore runs on pull requests and on pushes to `main` on GitHub. `GITHUB_TOKEN` is automatic.
- `pnpm release:check` (`scripts/release-check.ts`) accepts exactly two shapes of `.github/workflows/release.yml`: before the flip (`workflow_dispatch` only, both `if:` strings dispatch-only) and after it (`push: branches: [main]` plus `workflow_dispatch`, `stable` also runs on a push). Anything else fails, including a half-flipped file.
- The two jobs that hold `contents: write` pass `cache: "false"` to `.github/actions/setup` (ADR 0066 item 4): no pnpm cache is restored where a write token exists. `release:check` fails without it.
- `pnpm release:check` also checks the licence state: `UNLICENSED` with no `LICENSE` file, or `AGPL-3.0-only` / `AGPL-3.0-or-later` with a `LICENSE` file whose first line is `GNU AFFERO GENERAL PUBLIC LICENSE`, the same `license` in both `package.json` files, `LICENSES/Apache-2.0.txt`, and `THIRD_PARTY_NOTICES.md` naming it. The second shape is the one the repository is in once `e264c2b9` is on the branch you check.
- `scripts/release-flip.ts` makes the flip edits (step 4.1).

## 1. Accept M13

Merge the M13 branch to `main` (squash, as every milestone). Stop if `pnpm lint && pnpm typecheck && pnpm knip && pnpm test:unit` is not green on `main`.

## 2. npm scope (owner q15)

Reserve the `@soulkyu` scope on npmjs and check who owns `@pap` there. The published name is `@soulkyu/pi-agentic-platform`; it stays the `--name` flag of `pnpm build:npm`. Stop if the scope is taken by someone else: pick another name before step 7, nothing else changes.

## 3. CI on `main`

Wait for the `e2e` job (and the rest of CI) to be green on `main` on GitHub. `ci.yml` ignores docs-only changes (`paths-ignore: docs/**, **/*.md`), so a push that only edits docs does not start it: check the run of the last push that changed code. Stop if any job is red: nothing is flipped or tagged until it is green. Read the failing job log first; the `e2e` job has not run on GitHub before, so a first failure can be the job and not the product.

## 4. The v1 flip (one reviewed commit)

On a branch from `main`:

1. Run `node --disable-warning=ExperimentalWarning scripts/release-flip.ts`. It rewrites `.github/workflows/release.yml` (`push: branches: [main]` and the `stable` job's `if:`), `.github/workflows/pi-compat.yml` (it restores the nightly `schedule:`; `pnpm release:check` accepts dispatch only before the flip and dispatch plus that schedule after it), `UPDATE_CHECK_DEFAULT` in `apps/daemon/src/update-check.ts` and its pinned assertion in `apps/daemon/src/update-check.test.ts`. Read the diff. It refuses to run twice ("already flipped") and writes nothing if a file is not in the expected shape. Then `pnpm release:check` and `pnpm test:unit`.
2. Edit the prose that is true before the flip and stale after it, in the same commit. The script prints the same list, by file and section; the places are:
   - `apps/daemon/src/update-check.ts`, the doc comment above `UPDATE_CHECK_DEFAULT`: the daily check is on by default; `PAP_UPDATE_CHECK=0` turns it off, `=1` forces it on.
   - `AGENTS.md`, the bullet of "Backup, update, doctor, release (M6b)" that says the repository is private until v1: the repository is public; `release.yml` also runs on push to main (ADR 0066, ADR 0076).
   - `docs/agents/update.md`: in "Daily check", the sentence about `UPDATE_CHECK_DEFAULT` being `false`, and the troubleshooting row "the update check never says anything": the check is on by default; if it says nothing, look for `PAP_UPDATE_CHECK=0` in the unit.
   - `docs/agents/doctor.md`, the `update_available` row: written by the daily check (on by default) or `PAP_UPDATE_CHECK=1`.
   - `docs/agents/install.md`: the paragraph under "Container, npm, releases", the `release-please` row of its table, the first sentence of "Releases and channels", and in that section the bullets that say the workflow is `workflow_dispatch` only: the workflow runs on push to main and on `workflow_dispatch`, `stable` also runs on a push (the flip adds `push: branches: [main]` and rewrites the `stable` `if:`), and the release PR needs the setting of step 4.4.
   Do this before other edits move the lines the script prints.
3. ADR 0066 item 3, the casing of `FEED_REPO` in `apps/daemon/src/update-check.ts`: `curl -sIL -o /dev/null -w '%{url_effective}\n' https://github.com/<FEED_REPO>`. The final URL must carry the same casing; fix the constant if not.
4. ADR 0066 item 5: enable "Allow GitHub Actions to create and approve pull requests" (Settings, Actions, General), or `gh api -X PUT repos/<owner>/<repo>/actions/permissions/workflow -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true`. Without it release-please cannot open its PR.
5. Commit with the message `feat: v1 release flip` and a body ending with the footer `Release-As: 1.0.0` (owner q17; the manifest is `0.0.0`, so `bump-minor-pre-major` would otherwise give 0.1.0). Open the PR, rebase on `main`, squash-merge with the footer kept in the squash message; the `e2e` job must be green on GitHub first. `pnpm release:check` runs in the `stable` job and passes because it accepts the flipped shape. There is no "cutover done" condition.

## 5. Cut v1.0.0

The merge is a push to `main`: the `stable` job runs and release-please opens the release PR for 1.0.0. Review and merge it. That second push runs `stable` again: release-please creates the tag `v1.0.0` and the GitHub release, and the same job builds and uploads the assets (the archive and its `.sha256`, the installer, `pap-feed-stable.json` and `pap-feed-stable.env`). Never tag by hand.

Fallback if a push does not start the job: `gh workflow run release.yml -f channel=stable`, once to open the PR and once after merging it. Stop and read the job log if `pnpm release:check` fails in the job.

## 6. Verify the release

From a clean machine: `gh release view v1.0.0 --json tagName,assets`; `get-pap.sh` from the tag (`curl -fsSL -o get-pap.sh https://raw.githubusercontent.com/SoulKyu/pi-agentic-platform/v1.0.0/scripts/get-pap.sh`, read it, then `sh get-pap.sh stable`); `pap doctor`; open the setup URL; run a session; `pap update check`. Stop at the first failure: do not publish to npm.

## 7. Publish to npm (owner q15)

Only after step 6 passes: `pnpm build && pnpm build:npm`, then `cd .pap-npm/package && npm pack` and inspect the tarball (shrinkwrap and `LICENSE` present), then `npm publish --access public` from a 2FA session; `NPM_TOKEN` is never stored in CI. Never from CI in v1.

## After v1

Signing, an SBOM and provenance attestations are not part of v1 (ADR 0066, "What the feed does and does not prove"). pi-web is not replaced.

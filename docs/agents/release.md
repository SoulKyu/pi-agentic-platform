# Release runbook (v1.0.0)

Every step is the owner's. No step is run by the M13 plan or by a task: nothing here has been executed, and the release workflow has never run. Order matters. Each step says what it verifies and when to stop.

pap does not replace pi-web (owner q12). There is no cutover step: pap and pi-web keep sharing `~/.pi/agent`, and the preview keeps its run mode. The rule for the shared folder is in `docs/agents/sessions.md`.

Background: ADR 0066 (channels, feed, the flip) as amended by ADR 0076; the licence is ADR 0077. Install side: `docs/agents/install.md`; update side: `docs/agents/update.md`.

## 0. What is already done

- `pnpm release:check` (`scripts/release-check.ts`) accepts exactly two shapes of `.github/workflows/release.yml`: before the flip (`workflow_dispatch` only, both `if:` strings dispatch-only) and after it (`push: branches: [main]` plus `workflow_dispatch`, `stable` also runs on a push). Anything else fails, including a half-flipped file.
- The two jobs that hold `contents: write` pass `cache: "false"` to `.github/actions/setup` (ADR 0066 item 4): no pnpm cache is restored where a write token exists. `release:check` fails without it.
- `pnpm release:check` also checks the licence state: `UNLICENSED` with no `LICENSE` file (today), or `AGPL-3.0-only` / `AGPL-3.0-or-later` with every file below (step 2).
- `scripts/release-flip.ts` makes the flip edits (step 5.1).

## 1. Accept M13

Merge the M13 branch to `main` (squash, as every milestone). Stop if `pnpm lint && pnpm typecheck && pnpm knip && pnpm test:unit` is not green on `main`.

## 2. Licence (owner q14)

1. Confirm the SPDX id: `AGPL-3.0-or-later` (default, GNU's standard notice) or `AGPL-3.0-only`.
2. Add `LICENSE` at the root: the GNU Affero General Public License v3 text, first line the title `GNU AFFERO GENERAL PUBLIC LICENSE`.
3. Set the same `license` in `package.json` and `apps/daemon/package.json`. The npm builder reads the root one and ships `LICENSE`.
4. Keep `LICENSES/Apache-2.0.txt` and `THIRD_PARTY_NOTICES.md` (they cover the one derived ai-elements file).
5. Write ADR 0077.

Verify: `pnpm release:check` prints `release-check: ok`; `pnpm build && pnpm build:npm` succeeds. Stop on any finding: the message names the file.

## 3. npm scope (owner q15)

Reserve the `@soulkyu` scope on npmjs and check who owns `@pap` there. The published name is `@soulkyu/pi-agentic-platform`; it stays the `--name` flag of `pnpm build:npm`. Stop if the scope is taken by someone else: pick another name before step 8, nothing else changes.

## 4. Make the repository public (owner q16)

1. Confirm no private data is in the history (the plan's review found none; look again for tokens, hostnames and personal paths).
2. Set the repository visibility to public. `GITHUB_TOKEN` is automatic; `NPM_TOKEN` is only needed by hand at step 8.
3. Wait for the `e2e` job (and the rest of CI) to be green on `main` on GitHub. Stop if red: the repository stays public but nothing is tagged.

## 5. The v1 flip (one reviewed commit)

On a branch from `main`:

1. Run `node --disable-warning=ExperimentalWarning scripts/release-flip.ts`. It rewrites `.github/workflows/release.yml` (`push: branches: [main]` and the `stable` job's `if:`), `UPDATE_CHECK_DEFAULT` in `apps/daemon/src/update-check.ts` and its pinned assertion in `apps/daemon/src/update-check.test.ts`. Read the diff. It refuses to run twice ("already flipped") and writes nothing if a file is not in the expected shape. Then `pnpm release:check` and `pnpm test:unit`.
2. ADR 0066 item 3, the casing of `FEED_REPO` in `apps/daemon/src/update-check.ts`: `curl -sIL -o /dev/null -w '%{url_effective}\n' https://github.com/<FEED_REPO>`. The final URL must carry the same casing; fix the constant if not.
3. ADR 0066 item 5: enable "Allow GitHub Actions to create and approve pull requests" (Settings, Actions, General), or `gh api -X PUT repos/<owner>/<repo>/actions/permissions/workflow -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true`. Without it release-please cannot open its PR.
4. Commit with the message `feat: v1 release flip` and a body ending with the footer `Release-As: 1.0.0` (owner q17; the manifest is `0.0.0`, so `bump-minor-pre-major` would otherwise give 0.1.0). Open the PR, rebase on `main`, squash-merge with the footer kept in the squash message. There is no "cutover done" condition.

## 6. Cut v1.0.0

The merge is a push to `main`: the `stable` job runs and release-please opens the release PR for 1.0.0. Review and merge it. That second push runs `stable` again: release-please creates the tag `v1.0.0` and the GitHub release, and the same job builds and uploads the assets (archive, installer, feed, `SHA256SUMS`). Never tag by hand.

Fallback if a push does not start the job: `gh workflow run release.yml -f channel=stable`, once to open the PR and once after merging it. Stop and read the job log if `pnpm release:check` fails in the job.

## 7. Verify the release

From a clean machine: `gh release view v1.0.0 --json tagName,assets`; read `get-pap.sh` from the release, then run it; `pap doctor`; open the setup URL; run a session; `pap update check`. Stop at the first failure: do not publish to npm.

## 8. Publish to npm (owner q15)

Only after step 7 passes: `pnpm build && pnpm build:npm`, then `cd .pap-npm/package && npm pack` and inspect the tarball (shrinkwrap and `LICENSE` present), then `npm publish --access public` from a 2FA session. Never from CI in v1.

## After v1

Signing, an SBOM and provenance attestations are not part of v1 (ADR 0066, "What the feed does and does not prove"). pi-web is not replaced.

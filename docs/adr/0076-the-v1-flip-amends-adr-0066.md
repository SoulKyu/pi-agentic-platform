# ADR 0076: the v1 flip amends ADR 0066

Status: accepted · Date: 2026-10-18 · Spec: ADR 0066 (D21). Amends ADR 0066. Rulings: M13R36, M13R22, M13R23, M13R33, M13-C9.

This ADR records a deviation from ADR 0066: the v1 flip it described is incomplete. It adds the `if:` rewrite, moves the cache removal ahead of the flip, adds `scripts/release-flip.ts`, and re-enables the pi-compat schedule at the flip.

## Context

ADR 0066 listed five flip items. A sixth was missing: both jobs of `release.yml` guard on `inputs.channel`, which is empty on a `push`, so adding the push trigger alone starts nothing. `release:check` also rejected any trigger but `workflow_dispatch`. The pi-compat workflow lost its nightly schedule while the repository was private.

## Decision

- `scripts/release-check.ts` accepts exactly the pre-flip and post-flip shapes of `on:` and of the two `if:` strings, and pins them. A licence rule (ADR 0077), the shrinkwrap rule (ADR 0073) and the `cache: "false"` rule for the write-token jobs sit beside it.
- **`scripts/release-flip.ts`** (tested) applies item 1 (`push: branches: [main]`), item 2 (`UPDATE_CHECK_DEFAULT` to `true`, with the pinned assertion in `update-check.test.ts`), the `if:` rewrite so `stable` also runs on a push, and the re-enabled pi-compat nightly schedule. It prints the owner-only items and a checklist of prose that becomes stale. The owner reviews the diff and commits.
- Item 4 (no pnpm cache in the jobs that hold `contents: write`) is done before the flip, through a `cache` input of the setup action, since it is harmless early.
- Items 3 (casing of `FEED_REPO`) and 5 ("Allow GitHub Actions to create and approve pull requests") stay owner steps with commands.
- The cut is push-driven: the flip commit carries a `Release-As: 1.0.0` footer (the manifest is `0.0.0`), the release PR is opened and merged, and the second push creates the tag and uploads. `gh workflow run release.yml -f channel=stable` is the fallback. `pnpm release:check --tag` never existed and is gone from the runbook.
- Nothing in the plan pushes a tag. The runbook is `docs/agents/release.md`.

## Consequences

- The workflow has never run on GitHub; the fallback is two manual dispatches. Cost if wrong: a failed first release run, fixed before the tag.
- Prose that says "private until v1" is edited in the flip commit; the script cannot know the wording, so it prints the checklist.

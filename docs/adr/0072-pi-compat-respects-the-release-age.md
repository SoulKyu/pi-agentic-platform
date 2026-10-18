# ADR 0072: Pi-compat respects the release age

Status: accepted · Date: 2026-10-18 · Spec: `docs/specs/2026-10-10-A-product-scope.md`. Rulings: M13R9, M13R33, M13R49; owner q3.

## Context

The compat check installed the newest Pi SDK with the release-age rule turned off, so the nightly job could run code younger than the supply-chain control (`minimumReleaseAge`, 4320 minutes) allows.

## Decision

Pi-compat tests "the newest release of `@earendil-works/pi-coding-agent`, `pi-ai` and `pi-tui` that exists for all three at the same version and is at least `minimumReleaseAge` old". The version is written as an exact version in the catalog before install: no `latest`, no age override (`minimum-release-age=0` is gone from the workflow).

- `pnpm pi-compat` (`scripts/pi-compat.ts`, helpers in `scripts/pi-compat-bump.ts`) fetches the registry first, then works in a scratch git worktree: the owner's `node_modules`, `pnpm-workspace.yaml` and lockfile are never touched, and an offline run exits before it creates anything. It runs install, typecheck, unit and integration tests in that tree.
- The workflow `.github/workflows/pi-compat.yml` is `workflow_dispatch` only until the v1 flip (M13R33). The flip script re-enables the nightly schedule (ADR 0076).

## Consequences

- A Pi release is tested at least three days after it ships. Cost: a breaking release is seen late; the supply-chain rule is worth that.
- A pre-release, a missing or unreadable `time` entry, or a version one of the three packages lacks is not picked; `pi-compat-bump.pick.test.ts` pins the choice. The age is measured against the runner's own clock (`Date.now()`); a skewed clock is not detected.

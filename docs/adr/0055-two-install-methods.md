# ADR 0055: two install methods, a git checkout and an offline archive

Status: accepted (M6, Task 7)
Date: 2026-10-15
Spec: A success criterion 3. Decision 87. Rulings: M6R31, M6R40, M6R20 to M6R24.

## Context

A stranger must install pap in one step on a Linux host with systemd and no sudo. The repository is private (a mirror), there is no release channel, no signing key and no registry account.

## Decision

Two methods, one service command (`pap service install`) behind both:

- Method 1, `scripts/install.sh`: from a git checkout, builds with the pinned pnpm lockfile, installs from the checkout.
- Method 2, `pnpm build:archive`: a self-contained linux-x64 `.tar.gz` (builder's Node, production dependencies with node-pty compiled) and an installer script pinned to the archive's SHA-256. Works offline on the target.

Rejected, and why:

- `curl | sh`: no trust root today (private mirror, no signature). Viable at v1 (public repository, published releases, a signature); the archive and installer of this plan stay unchanged under it (M6b).
- OCI image: needs R52b (`--security-opt systempaths=unconfined` for the bwrap sandbox), the PID-namespace lock story and volume modes, about four more tasks and a security review.
- npm package: node-pty still compiles on the target; needs a registry account and provenance (M6b).

## Consequences

- Method 1 runs from the checkout: changing it changes the running code, with no integrity check (documented in `docs/agents/install.md`).
- Method 2 depends on the build host: build on the oldest glibc you target; the installer refuses an older one.
- Cost if wrong: a second channel is added later without changing either method.

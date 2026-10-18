# ADR 0073: npm shrinkwrap from the lockfile

Status: accepted · Date: 2026-10-18 · Spec: `docs/specs/2026-10-10-A-product-scope.md` (one-step install). Amends ADR 0066 on the npm package. Rulings: M13R15, M13R47, M13R48, M13-C3; Appendix A defect D3 of `docs/research/m6b-final-review.md`.

## Context

The npm package resolved floating transitive ranges at install time, so a stranger could install versions CI never tested (Appendix A, defect D3). A missing bundled copy of `@pap/contracts` or `@pap/pi-host` would also resolve `@pap/contracts@0.0.0` from the registry by name.

## Decision

`pnpm build:npm` writes an `npm-shrinkwrap.json` (npm lockfile v3) into the package, generated offline from `pnpm-lock.yaml` by `scripts/npm-shrinkwrap.ts` (reader in `scripts/npm-lock-closure.ts`).

- Scope: the production closure of `apps/daemon`, `packages/contracts` and `packages/pi-host`. Every entry copies `version` and `integrity` from the lockfile and gets the registry URL; a git, tarball or directory resolution makes the builder refuse. `@pap/*` entries are `inBundle` and nothing is fetched for them.
- Semantics: `optional: true` for entries reachable only through optional edges; `os`, `cpu` and `libc` kept; peer suffixes stripped; root dependencies hoisted first at their exact pins; `hasInstallScript` only for the `onlyBuiltDependencies` allowlist; `bin` links not carried (npm recreates them from each package's manifest).
- **Ruling M13-C3: diverging peer variants make the build throw.** If the snapshots of one production package have different stripped dependencies, one npm entry cannot stand for both, so `productionClosure` fails closed.
- `pnpm release:check` refuses a package without the file, with an entry that differs from the lockfile, or with any field that differs from a shrinkwrap regenerated from the lockfile (`scripts/release-check-shrinkwrap.ts`).
- Acceptance (step CB6, run once online by the controller): the set of `(path, version, resolved, integrity)` tuples is unchanged by `npm install --package-lock-only`, `npm ci --dry-run` exits 0, and `npm ls --omit=dev` shows no invalid, missing or extraneous entry. A byte diff can never pass, since npm adds `engines`, `license`, `funding`, `bin` and flags.

## Consequences

- A stranger installs exactly what CI tested. A future Pi bump that creates diverging peer variants blocks `build:npm` until handled by hand; acceptable, because `npm publish` is a manual owner step after v1.
- The file is never edited by hand: change the lockfile and rebuild.

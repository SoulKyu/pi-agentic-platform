# M7 rulings after the lane join

Continuation of [m7-rulings.md](m7-rulings.md) (MC1-MC53), split off to keep both files under the 400-line cap. Where a ruling differs from the code, the code is the reference and `docs/agents/skills.md` says what it does.

- MC54 [25, 30] Task 25 review:
  - **I1, fix.** M7R115's binding regexes are tightened, because Pi reads some accepted sources as local paths, or a ref as a git flag.
    - `git:` host: must contain a dot.
    - `git:` path: at least two segments, and no `.` or `..` segment.
    - Ref: may not start with `-`.
    - `https://` paths: no `.` or `..` segment.
    - Tests: the reproduced `git:a/../../../../outside/evil`, plus `git:host/a/b@--upload-pack`, both at the source level and at the op level (nothing written to `settings.json`), with a mutation check.
  - **Concern 2, accepted for M7.** An install holds the shared write queue for up to about 330 s. Pi re-reads `settings.json` under its own lock, so no save is lost. Documented in `daemon.md` and `skills.md`; revisit if it bites.
  - **Concern 3, kept.** Re-enabling a global package takes no step-up (M7R133: switches never ask; MCP behaves the same). An option for the owner's final report: one ruling for both MCP and plugin enable switches.
  - **Speed rule A.** The 14 Minors are parked.
  — why: a project-scope install could write a path outside home into `settings.json` with no step-up. — cost if wrong: about 20 min.
- MC55 [24, 25, 30] Minor sweep B fixes the Task 24 and 25 Minors.
  - `plugins.list` and `skills.list` become `pi:admin`. This amends the brief's `pi:read`, extending MC38: they serve masked or path views, and the `npm root -g` fallback can run a trusted project's `npmCommand`.
  - The `npx` child gets `npm_config_before`, so transitive dependencies are frozen.
  - Project settings writes are guarded.
  - Local plugin paths are checked on their realpath.
  - The rest are residuals (documented in `skills.md`), or owner options (provider keys in the `npx` env; install audit rows).
  — why: several of these Minors are security hardening on security-contract code. — cost if wrong: about 45 min.
- MC56 [30] Owner answer (2026-10-14): `idleWorkerRssMb` goes from 191 to 210 MB.
  - Measured idle worker RSS: 177-184 MB on main (M8), 183-191 MB with M7, so M7 adds about 6 MB.
  - 210 is about 191 × 1.10, the same 10 % rule as M7R130.
  - `WORKER_BUDGET_MB` (285) is unchanged.
  - Task 30b sets it in `budgets.json` and adds decision 78 to the decisions log.
  — cost if wrong: a looser idle-memory alarm, by 19 MB.
- MC57 [30] The helper pool logs the stderr tail of a failed op only for `skills.install`, whose output the helper masks line by line. Sweep B had logged it for every op, which could put unmasked helper stderr in the daemon log and tripped the network-guard canary of `models/service.int.test.ts`. The case "another op logs no tail" is pinned in `pool.test.ts`. — cost if wrong: one line.
- M7R129/M7R130 results (30b): the D10 parity rows are green (`docs/agents/models.md` §Parity). `initialBundleGzipKb` is `min(ceil(207.3 × 1.10), 300)` = 229.
- M7R130 override (final review, MC59): `initialBundleGzipKb` stays at 300 in `budgets.json`. Owner decision 75 (Q8, a flat 300 KB gzip ceiling until M13) overrides the plan rule M7R130 (`min(ceil(measured × 1.10), 300)` = 229), which was never put to the owner. The 30b line above that gives 229 is superseded; `docs/agents/web.md` already says 300.

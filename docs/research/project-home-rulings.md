# Project home — execution rulings

Plan: `docs/plans/2026-10-15-project-home.md` · Spec: `docs/specs/2026-10-15-project-home-design.md` · Merged as one squash commit (decision 86).

Plan-time spec rulings PH1–PH14 are in the plan; PH15 (`read_only` declared on `projects.add`) was added before execution.

## Owner decisions during the run

- Initial-bundle limit for this feature raised from the plan's 223.7 KB to **226 KB gzip** (shipped: 225.4 KB). CI `budgets.json` stays at 300 KB (owner, at merge).
- At merge: sessions keep starting at the project root only (no folder field, spec §3.1); no "Remove from list" for projects for now.

## Controller rulings (from the SDD ledger)

1. `projects.add` declares `read_only` as a fourth error (PH15) — the service maps a newer-pap database refusal to it and the automation methods declare it the same way; spec §4 lists three codes — cost if wrong: one extra declared code, harmless.
2. An added root that is an ANCESTOR of `$PAP_HOME`/Pi's agent dir (e.g. `~`) is accepted — `sessions.create` already allows it and the files module's deny set (`kernel/fs/deny-set.ts`) refuses pap's and Pi's private files under any root — cost if wrong: a browsable `~` exposes non-private dotfiles, as `sessions.create { cwd: "~" }` already does.
3. T3 plan-mandated findings fixed anyway — spec §3.2/§7 ("disabled says why", aria-describedby) and the stale-response lesson bind over the plan's prescribed code; Cancel/Escape allowed while busy (late response dropped; PH2 accepts a checked-then-cancelled project staying) — cost if wrong: a few lazy strings, one ref token
4. T8 plan-mandated silent catch fixed anyway — a hidden failure drops archived-only fan-outs that §3.4 promises to reopen; one muted line + Retry (click, no polling) — cost if wrong: two lazy strings
5. parked T5 minor (TriggerPane ignores a second prefill when the new:<id> pane is mounted) carried into T10 as a requirement — T10 creates the launch path that hits it — cost if wrong: small extra scope in T10
6. "use no memo" on ProjectHome/ModeChips accepted (owner's 226 KB limit; correctness safe, perf negligible) on condition that compiler-gate asserts the exact allowlist of opted-out files + a why-comment; T12 documents it in web.md — cost if wrong: two components skip compiler memo + bailout checks
7. T11 plan-mandated sticky Terminal fixed anyway — PH12 binds (only a root refusal disables); failure becomes a notice, pending flag prevents duplicates — cost if wrong: a few lines + one string
8. T12's one-sentence doc fix folded into the minor sweep (item 11) instead of a separate fix round — same worktree, the sweep re-review verifies it — cost if wrong: none (docs)
9. final fix wave = I1, I2 + cheap minors M2 (bad_request copy overstates), M3 (RecentWork new-tab links), M8 (stale launch error after project change), M9 (stale docs/comments) — one Sonnet dispatch, one scoped re-review
10. final M5 (picker launches without the picked project's facts), M6 (Launch offline no reason), M7 (Archived lanes count owner-wide), M10 (failureText duplicated), M11 (226 KB not CI-enforced) parked — none is data loss or security; the dialog/editor refuse invalid launches — cost if wrong: small UX papercuts

# Project home — final whole-branch review (Opus, 2026-10-15)

Range 177dce9..d99688f (25 commits, merge commit 7dc9d28 included). Verdict: **ready to merge with fixes**. 0 Critical, 2 Important; both fixed in 11b27e9 with four cheap minors, verified by a scoped re-review. Full gate on 11b27e9: unit 1159 files / 13 997 tests, int 182 files, smoke ok, initial bundle 225.4 KB gzip.

## Strengths
- `projects.add` is safe as wired: `resolveSessionCwd` (real path, folder), both the real path and its scope (PH1) checked against the state folders' real paths, so a link into `$PAP_HOME` or Pi's agent folder is refused; `internal` when `folders` is missing; every store query filters by `owner_id`; one-line handler. The integration test pins the link refusal, another owner's identical root and token parity with `sessions.create`. It is stricter than `sessions.create`, which still files a folder inside `$PAP_HOME`. A new root exposes nothing `sessions.create` could not already expose; the files deny set and the home's dot-entry protection (M8R118) still apply under any root.
- Snapshot and events are owner-scoped; active projects come first under the 500 cap.
- The lazy boundary is guarded: `build-output.int` markers (dialog, body, picker, launch strings), a test refusing static imports of lazy files into the composer, the compiler gate pinning the `"use no memo"` allowlist.
- No typed text is lost on a failed launch (Review Focus 1); a timed-out create is never re-sent (R105); Launch frees itself when the chunk fails or a hand-off throws.
- Stale async answers are dropped the same way everywhere (current flags or a request token).
- The JOIN is clean; no cross-feature imports; the `HomeActions` boundary holds.
- The rulings that overrode plan-mandated code (T3, T8, T11) were right.

## Important (fixed in 11b27e9)
1. Sign-out did not reset `useAddProjectRequest` / `usePaletteRequest`: after a forced sign-out with Add project open from the picker, the next account on the same tab could run the previous account's continuation (its typed text) — MC34 says every client store resets at sign-out.
2. Spec §7 focus return failed on picker → "Add project…" → Cancel/Escape/X (the picker's focused button unmounted before the dialog recorded `returnTo`).

## Minor
1. Lost capability: sessions start only at the project root (spec §3.1); the old home's folder field is gone. Owner: keep as is.
2. `addProject.error.bad_request` copy overstated the rule ("holds" pap's data) — fixed ("is inside").
3. Recent work links broke "open in a new tab" — fixed.
4. PH2 + PH3 create projects that cannot be removed (Check files a project; trigger-only projects now listed as unused). Owner: not now.
5. The picker launches without the picked project's facts (the dialog/editor then refuses) — parked.
6. Launch disabled offline has no stated reason (the connection banner partly covers it) — parked.
7. "Archived lanes (N)" counts all projects — parked.
8. The launch error stayed after the chip changed project — fixed.
9. Stale docs and comments (trigger prefill, current-project, MobileShell, sessions/shell.ts) — fixed.
10. `failureText` duplicated in `features/home/run-launch.ts` and `features/sessions/failure.ts` — parked.
11. The 226 KB limit is not enforced by CI (`budgets.json` 300) — owner: keep 300 in CI.

## Declined to judge
Ancestor roots (`~`, `/`) accepted by `projects.add` (owner-facing ruling matching `sessions.create`); case-sensitive `within` on case-insensitive filesystems (Linux target); composer auto-focus raising the phone keyboard (§3.1, M12); composer text not kept as a draft; search hits crowded out by other projects (PH8 residual); a project whose sessions are all archived not listed after reload (PH3 residual); Enter as a new line on narrow desktop windows (PH6); no rate limit on `projects.add` beyond the 2000 cap; the 60 s age interval (precedent); no per-project spend (non-goal).

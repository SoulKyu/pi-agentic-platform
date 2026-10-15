# M10 final whole-branch review (Opus, owner c6)

Branch `feat/m10-outbox-automation` @ `db35c37` against `main`: 72 commits, 529 files. This review is read-only. The checkout was not touched. Two probes were written in the session scratchpad (`probe/taskof.test.ts`, `probe/hidden.test.ts`, run with `probe/vitest.probe.config.ts`) and both pass. They demonstrate I1 and I2. One targeted run of 8 money-path unit files at HEAD gave 85/85 green: `resume*.test.ts`, `runner.limits*.test.ts`, `compose-join2.test.ts`, `metrics.test.ts` and `fire-counts.test.ts`.

The review was done in passes:
1. the composition, boot and stop path;
2. the money path from end to end;
3. authority (RT-04) and owner isolation over every new RPC and stream;
4. how untrusted text enters, and where it goes out;
5. the AGENTS.md rules;
6. the M9 rebase (read-only look at `feat/m9-worktrees-lanes`);
7. the parked Minors, from the review files.

## Strengths

- **Outbox recovery comes first, and it holds by construction.**
  - `composeM10Early` is called right after the receipt store, before auth, the workspace modules (and M9's `lanes.recover()` after the rebase) and the sessions module (`daemon.ts:143-147`).
  - It closes crashed runs (`compose-runs.ts:44-47`), then recovers the outbox inside `composeOutbox` (`compose-automation.ts:40-51`).
  - The task boot runs inside `composeAutomation` before the server listens (`compose-automation.ts:121`).
  - Read-only mode is checked at each layer: inert observer, no trace file, no exporter, no listeners, no timers, and the hook route answers 503.
- **One synchronous fire path.**
  - `fire.ts:149-241` re-reads the trigger by revision and runs the gates in the M10R57 order. Journal, task and `task.start` are written in one transaction, and the outbox is poked after the commit.
  - The precheck step predicts pause and budget before it spawns anything, and the fire transaction re-checks them (`precheck-step.ts:119-121`), so a refused fire never spawns the command.
- **The budget counts every run once.**
  - `spentToday` is the finished rows (`status <> 'running'`, `store.ts:242`) plus the in-memory live cost of the open runs (`observer.ts:314-321`). An open run is never counted twice.
  - The click-resume exemption is one set (`limits.ts:48,108,165`) that serves both lines, and it is proved at exit level with the price trick (`security/automation-rulings.int.test.ts`).
- **The resume handler has no `await` between its checks and the sent mark** (`resume.ts:150-187`). The T24 fix put pause and auto-resume ahead of the budget skips, and ADR 0045 now matches the code.
- **Token authority is tight where it matters.**
  - `automation:admin` is outside `TOKEN_PERMISSIONS` (`contracts/auth.ts:11-18`).
  - The settings service refuses a token write to `automation`, and the real service is tested (`settings/service.ts:58-59`, `service.automation.test.ts`).
  - `models.usage` is `pi:admin`. A token's dry-run never spawns a precheck. `releaseTools` takes the step-up and is audited.
- **The hook route keeps its promises.**
  - Authentication comes before the backoff. The two pools are separate. `connection: close` is sent on every non-202 answer, including the outer catch (`hooks-http.ts:63-68,193-200`).
  - Only closed reasons go out. Payloads and secrets are never echoed.
- **Lifecycle discipline.**
  - No raw `setTimeout`, `setInterval` or `AbortSignal.timeout` remains in M10's production code. Every timer is on the kernel Clock, and the stop path clears each one.
  - The C3 order is respected: `m10Late.stop()` first, then the workers, with the OTLP flush as a closer at the very end (`compose-m10.ts:92-99,166-173`).
- **Repo rules.**
  - Every file is 400 lines or fewer. The largest is `runner-bed.ts` at exactly 400.
  - No module crosses a boundary except through `index.ts`. Every RPC declares a permission.
  - `daemon.ts` grows by 11 lines net (14 touched, budget 14).
  - Only `eslint-disable-next-line … -- reason` directives are used (3, all `no-control-regex`). No raw colours were added in the new web features.
- **Docs.** ADRs 0040–0046 and `automation.md` / `finops.md` describe the code as it stands. I spot-checked the outbox classes, the resume order, the hook statuses, the metric families and the precheck order.

## Issues

### Critical (Must Fix)

None.

### Important (Should Fix)

#### I1. `taskOf` resolves a finished task, so the owner's own later work in that session is charged to, or skipped by, the old trigger's budget

- **Where:** `apps/daemon/src/modules/automation/index.ts:256-262`, used by `modules/runs/resume.ts:144` (the skip) and `:177-181` (the `expectOrigin` task id).
- **What:** the J3 I1 fix resolves "the task of this session" without looking at the task's state. Once a task is over (`done`, `failed`, `cancelled`, `interrupted`), its session is an ordinary session the owner can continue. The tool list stays until "Use my normal tools".
  - If one of the owner's own runs there ends `limited`, the scheduled `run.resume` still finds the old task.
  - **When that trigger is over its own daily budget,** the owner's auto-resume is skipped with `budget`. The task cannot move (it is terminal), so the session just stays limited.
  - **When it is not over,** the continuation is recorded `origin: "resume"` with `task_id = <the finished task>`. It is then counted in that trigger's `spentTodayOf` (the 48 h window of its task ids), which can make the trigger refuse its next fires with `budget`. It also shows in the old task's journal cost.
- **Proof:** `scratchpad/probe/taskof.test.ts`, built on the composed `compose-join2` rig, passes all three cases:
  - `taskOf` answers `{taskId: "task1", overBudget: true}` for a `done` task;
  - a later owner run that ends limited gets its resume skipped with `["budget"]`;
  - under budget, the continuation's row is `{origin: "resume", task_id: "task1"}`.
- **Why it matters:** this is a money-attribution bug in exactly the resume chain J3 just fixed. It is narrow, but it is wrong in both directions: a false refusal and a misattribution.
- **Fix:** one condition. Return a task only while it is `limited` or `running`, for example `if (!row || row.owner_id !== ownerId || (row.state !== "limited" && row.state !== "running")) return null;`. The J3 case is unaffected, because the task is `limited` when the post-click resume runs. Add the probe's three cases to `compose-join2.test.ts`.

#### I2. Hidden characters still reach the model through the precheck output and the manual or token fire payload

- **Where:**
  - `modules/automation/prompt.ts:13-14`: `fence()` drops only NUL;
  - the precheck output reaches it unstripped (`precheck.ts:77`, then `precheck-step.ts:140`, then `fire` / `renderPrompt` `{{precheck}}`);
  - the manual fire payload (`manual.ts:91-96`, `automation.fire {payload}` from a browser or a token, `FirePayload` with no character rule at `contracts/automation-views.ts:176-179`) is fenced raw.
- **What:** the T22 ruling and the sweep strip `\p{Cf}` and C0/C1 controls when text comes in, "so the agent never receives them". They do it for the webhook raw text (`payload.ts:29,71-75`), the alert lines and the feed entries. The two other untrusted inputs that end up in a prompt were not covered. One is precheck output, which the global constraints name as untrusted ("Webhook payloads, feed entries and precheck output reach the model only inside pap's one fence"). The other is a token's or the owner's manual payload, which is fenced as `webhook` for a webhook trigger.
- **Proof:** `scratchpad/probe/hidden.test.ts` passes:
  - a raw webhook body loses its Unicode tag characters and RLO;
  - the same characters pass through `renderPrompt` for `{{precheck}}` and for a manual payload.
- **Why it matters:** Unicode tag characters can carry a whole invisible instruction. That is the reason for the ruling. A precheck like `curl … | jq` feeds outside text. Schedule triggers default to `auto-accept-edits`, and taint and fencing still apply. The UI marker (`hidden-runs.ts`) only shows the owner afterwards that the agent received something hidden.
- **Fix:** strip once, at the one choke point every fenced input passes through: `fence()` in `prompt.ts` (`text.replace(/\p{Cf}+|(?:(?![\t\n])\p{Cc})+/gu, "")`, the `RAW_HIDDEN` class). Then the webhook, alert, feed, precheck and manual paths all agree, and future sources do too. Add the probe's two cases to `prompt.test.ts`. This also makes Minor m4 easier to fix.

### Minor (Nice to Have)

1. **A token's `usage.resumeNow` is gated but not counted, contrary to the binding constraint and to `finops.md`.**
   - `resume.ts:202-233` sends a token's resume like the owner's click, with no `expectOrigin`. The run is recorded `origin: "user"`, so it is not counted in `spentToday`, and `limits.ts` exempts it (`ownerRuns`) from both lines. Only the owner line is checked at the start (J3 m3).
   - `global-constraints.md:23` says "a token's … `usage.resumeNow` are budget-gated **and counted**". `docs/agents/finops.md:30` says `automation-tokens.int.test.ts` proves "counted and gated", but that test (`:265-305`) proves only the gate.
   - The impact is low, because a token with `sessions:operate` can prompt uncounted anyway.
   - Fix: either give a token's call `expectOrigin({origin: "resume", taskId: taskOf?.taskId})` and check the trigger line, or correct the constraint and the docs to "gated (owner line), not counted".
2. **"Use my normal tools" cannot be reached once the task row is gone.**
   - The daemon accepts a lift by session (M10R153, `release-tools.ts:31-47`). The web only tries it as a fallback on a board card that is already stale (`use-task-actions.ts:53-65`). After a reload the card is gone.
   - No session-side control and no hint tells the owner that a session still carries a trigger's tool list.
   - A session reopened more than 30 days after its task therefore keeps the list with no visible way to lift it. It fails safe, but goes against ask-instead-of-block.
   - Fix: a small control in the session header (or the limit chip area) when `sessionPolicy.recorded && toolAllowlist !== null` and no live task.
3. **The journal's detail column shows untrusted text outside the UNTRUSTED frame.** It holds the first line of a precheck's output (`journal.vm.ts:57`, `FireJournal.tsx:127`). The text is escaped and clipped, which is safe, but DESIGN §2 and the global constraint want the dashed `UNTRUSTED · <source>` frame. Either wrap that cell in the frame (or a small `precheck` tag), or record the exception.
4. **The hidden-character rule is written about eight times, with different sets.**
   - `tasks.ts:64` and `inbox/service.ts:43` are verbatim duplicates.
   - The others: `payload.ts:29` (`RAW_HIDDEN`), `feed-parse.ts:33` (adds Cs/Co), `precheck.ts:83`, contracts `HIDDEN_IN_TEXT` / `INVISIBLE`, and web `escape-hidden.ts` / `hidden-runs.ts`.
   - I2 is the direct cost of having no shared helper. Move one `stripHidden(text, {keepLines})` into contracts and reuse it.
5. **Test seams and loose types in the production composition.**
   - `SEAMS` / `fireManual` (`compose-m10.ts:114-115,134-149,175-181`) and `DRAINS` (`compose-usage.ts:152-153,193`) are module-level registries in production code, guarded only by `testProviderScript`.
   - `M10Modules` has an index signature (`compose-m10.ts:59-63`), so `daemon.ts:225` passes `auth` and `wk`, which nothing reads.
   - Either is acceptable, but drop the dead arguments before the M9 rebase touches that line.
6. **Any owner can dismiss a system failure for everyone.** `dismissFailure` (`kernel/outbox/store.ts:323-330`) and `tasks-stream.ts:115-118` accept rows with `owner_id IS NULL` from any owner, and the other owners' banners lose the row without being told (T5a m9). This only matters with several users (`pap user add`). Either make system rows read-only on the banners, or dismiss them per owner.
7. **The owner's own "Resume now" goes through the automation port** (`resume.ts:220,232` to `automation-port.ts:259-276`). It therefore pays the automation reserve: `keepOneFree` asks for two free workers for a cold session. With `PAP_MAX_WORKERS=2` and one other live session, the owner's click answers `capacity`, while typing in the session would work. Any audit the prompt path writes names the actor `system`. Use the owner's ordinary prompt path for a browser click.
8. **`pap_trigger_fires_total` counts inside the fire transaction, before the commit** (`fire-journal.ts:23`). A fire that rolls back (for example an `enqueueEffect` error) still counts. This is tiny. Count after the commit, or accept it and say so in ADR 0044.
9. **Gaps in the M9 rebase checklist.** See § "M9 rebase" below. They are listed as one Minor here, because the rebase gates would catch each one, but the checklist should name them.

## M9 rebase (checklist review)

The ledger's checklist (progress.md l.216) and the plan's ten rebase steps cover these points:
- the palette;
- `promptPending` and `beforePrompt`;
- the swap to `releaseIdle`;
- the migration stamps (already `2026101420xx`, after M9's `2026101410xx`);
- `child-env.ts` and `fence.ts`. The contracts sources are identical on both branches; only the tests and the comment and position of the pi-host re-export differ, so take M9's;
- the unions in `daemon.ts` and the C3 stop line;
- `lanes:admin` in `NEVER_FOR_TOKENS`.

The projected line counts after both are under the caps:

| File | Projected lines | Cap |
|---|---|---|
| `daemon.ts` | about 350 | 355 |
| `sessions/service.ts` | 339 | 400 (agreement ≤ 331 broken, not a CI rule) |
| `sessions/index.ts` | 227 | 400 |
| `config.ts` | 344 | 400 |
| web `build-output.int.test.ts` | 359 | 390 (no data table needed) |

Missing from the checklist:

- **R1. The disk floor is not a two-line wiring.**
  - M9 expects `diskFloor(path: string): void` (throws), in `lanes/create.ts:62`, `checkpoints.ts:43` and `copy-link.ts:37` (which may return a promise).
  - M10 exports `diskFloor(path, floorMb)`, which returns `{ok}`, and `createDiskGuard({path})`, which has a fixed path (`kernel/disk.ts:30-61`).
  - An adapter is needed: `(path) => { if (!diskFloor(path, config.minFreeDiskMb).ok) throw new PapError("disk_low"); }`.
  - M9's own fallback `localDiskFloor` (`lanes/disk-floor.ts`) duplicates `freeMb`'s walk, throws `capacity` and has a fixed floor that cannot be switched off. After the wiring:
    - delete it, or keep it test-only;
    - change M9's tests and error lists that expect `capacity` to `disk_low` (`lanes.create`, and the copy-link path);
    - note that `PAP_MIN_FREE_DISK_MB=0` then also turns off the lanes floor.
- **R2.** Turn M9's older-home tests into `kernel/testing/old-kernel.ts` style, and boot on a copy of the preview `state.db` (T2 m10). This is only in the Task 2 review.
- **R3.** In `automation-tokens.int.test.ts:112-116`, add `expect(lanes.length).toBeGreaterThan(0)` once M9's methods exist (T11 m12). Otherwise a renamed permission keeps the `lanes:admin` check vacuous.
- **R4.** Check that M9 strips hidden characters from issue text when it comes in (the T22 sweep ruling covers "both milestones"). Then recheck I2's fix point against M9's `issue` fences, which `FencedPart` will render with markers.
- **R5.** The `releaseIdle` swap (T4b m5):
  - the `service()` Pick (`automation-port.ts:201`) must gain `releaseIdle`;
  - M9's answer must be mapped to `released | busy | cold`;
  - M9's idle rule (commands in flight, retry) replaces `quiet()`;
  - so `release.test` / `automation-port.test` need their expectations re-read, not just a re-run.
- **R6. Process.**
  - 72 M10 commits replay over M9. Seven of them touch `daemon.ts`, and M9 has seven of its own. Five touch `methods.ts` and six touch `i18n/index.ts`.
  - `rerere` is enabled. Expect the same union to repeat commit after commit; the intermediate commits will not build.
  - Run the full gate (step 9) only at the end, and keep the rebase's resolutions in one reviewed fix-up commit for the join notes.

Nothing in M10 makes the rebase unsafe in a way the gates would miss, apart from R4, which is a behaviour check and not a compile error.

## Parked Minors I would un-park (fix before merge)

1. **T17 m5: a resume expectation outlives a prompt that started no run** (`resume.ts:102-115` clears it only on a throw).
   - A `handled` disposition, or a `queued` one that never runs, leaves `expectOrigin("resume")` armed for 5 minutes. The owner's next prompt then runs as `resume`: it is counted as automation, and `limits.ts` aborts it when the budget is crossed.
   - This is the I1/I5 class the owner already ruled on.
   - Fix: clear it unless the disposition is `started` or `queued`. One line.
2. **T3 m6: `pwh_` webhook secrets are not in `scrubKnownSecrets`** (`audit/scrub.ts:5-17`). A tool call that carries a hook secret is stored unscrubbed in the audit log, although the prefix exists so that scanners recognise it. One line.
3. **T3 m7: a token sees a feed URL's query** (`triggers.ts:146-149` redacts only `precheck` and `env`). Private feeds (for example GitHub's `….private.atom?token=…`) carry a credential in the query. Redact the query for token callers, the same reasoning as M10R24.
4. **T12 M1: a run that crosses local midnight reopens today's budget when it ends.**
   - While open it counts through the live sum; once finished it is dropped by `started_at >= midnight` (`store.ts:242`).
   - Fix: count finished rows by `ended_at >= $since`. That is monotonic and conservative, and one line.
5. **T2 m4: requeuing at recovery does not count an attempt.** A replay-safe effect that crashes the daemon (an OOM in a `feed.poll`, for example) is replayed at every boot. Under systemd that is a crash loop. Add `attempts = attempts + 1`, failing at 5, in the binding recovery SQL. This is a reliability fix for an SRE owner.
6. **T5a m15 (needs an owner ruling): a token's Retry re-runs the stored policy snapshot and ignores `disabled`** (`retry.ts:38`, `exemptDisabled ?? true`; `rpc.ts:44`).
   - If the owner later narrowed the trigger (for example removed `bash`) or switched it off, a token can still re-run an old failed task with the wider list.
   - Options: take the narrower of the snapshot and the trigger's current execution, or refuse a token's retry on a disabled trigger or a changed revision.
7. **J3 m3 / Minor 1: token `resumeNow`.** At least fix the docs claim in `finops.md:30` and the constraint, if the code stays as it is.

## Recommendations

- Fix I1 and I2 (each a line or two plus the probe cases as tests), and the un-parked items 1–5. Then run a fix-round gate of lint, typecheck, unit, and the `runs` + `automation` int files.
- Before the rebase, add R1–R6 to the checklist in `progress.md`.
- After the merge, add one exit proof that a finished task's session behaves like an ordinary session for money: no trigger attribution, and no trigger-budget skip.

## Declined to judge

- **The per-run cap and deadline also apply to a click-resumed task**, so an owner's "Resume now" on a webhook task can be cut at $1 or at `maxRunMinutes`. This is consistent with "a task resume restarts the deadline and gets a fresh run cap" and with J2 M6's reading. The ruling only exempts the click from the budget lines.
- **A token's manual fire also fires a disabled trigger.** This is plan-mandated (M10R63, tested in `manual.test.ts:61-66`). The retry half is in un-park item 6.
- **`automation.dryRun` is `idempotent: true` although a browser dry-run can spawn the saved precheck.** M10R64 defines it so, and it writes nothing.
- **The housekeeping's time zone is that of the owner of the oldest trigger** (`index.ts:237-242`). It only names the cleanup receipt's day (T5b m12).
- **The unattended block of unknown tools and unreadable commands** is owner decision m10a2, and the deviation is documented in ADR 0041.
- **The bundle is 216.7 KB**, under the 250 KB question line. The +2 KB from `nextOccurrence` is a later sweep (T21 m3).
- **Click-resume runs are uncounted** by owner ruling (I5 / M10R106). Only the token half (Minor 1) is in scope here.

## Assessment

**Ready to merge?** With fixes. Verdict: Needs fixes.

**Reasoning:** the branch is well integrated. Recovery comes first, the stop order is right, the money arithmetic counts each run once, authority is tight and the repo rules hold. Two cross-cutting defects remain, both cheap and both probe-confirmed. First, the J3 `taskOf` resolution charges or blocks the owner's own later work in a finished task's session against the old trigger's budget. Second, the hidden-character stripping misses the precheck output and the manual or token payload at the one place where every fenced input enters the prompt. Fix both, with the five cheap un-parked items, before merging.

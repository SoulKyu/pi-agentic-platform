# UX-1 final whole-branch review (Opus)

- Range: `4d4be11f..52aaa4ab` (9 commits, 153 files, +6609 / -77), branch `feat/ux-1`.
- Read against: spec `docs/specs/2026-10-28-ux-1-design.md` (decision 138), plan `docs/plans/2026-10-28-ux-1.md` (Global Constraints, Review Focus, Conflict scan, Merge notes), rulings PF-A to PF-G, the ledger `progress.md`, AGENTS.md, `docs/agents/web.md`, the M1 lessons checklist.
- Method: the review package diff read in passes (shell hand-off chain; path links and Files; template write daemon + helper + dialog; cost wire daemon + web; quote, composer insert, Escape; renderer seams; docs and copy). New files read whole from the worktree. Production wiring traced from `daemon.ts` / `composeM10` / `composePi` / `AppShell` / `PaneHost` / `MobileShell` / `AgentScreen`.
- Probes run (read-only, under the heavy-gate flock, `--project unit --maxWorkers=2`):
  - shell and path chain plus the compiler gate: `compiler-gate.test.ts`, `ShellBlock.test.tsx`, `MessageRow.shell.test.tsx`, `reply-markdown.test.tsx`, `terminal-hand-off.test.ts`, `use-terminal.handoff.test.ts`, `shell-text.test.ts`, `path-links*.test.ts`: 9 files, 545 tests, pass;
  - every root scan test of `apps/web/src` and `packages/ui/src` (label case, inline error, glyph icons, browser floor, compiler gate, tokens, icons, …) that `vitest related` never reaches: 26 files, 574 tests, pass;
  - `packages/contracts/src/`, the helper op tests, `templates.test.ts`, `session-cost.test.ts`, `apps/web/src/stores/`, `quote/`, `SaveTemplateDialog.test.tsx`, `apps/web/src/routes/shell/`: 248 files, 1885 tests, pass;
  - `scripts/docs-truth`, `parity-doc`, `class-coverage`, `literal-coverage`, `budgets-keys`: pass;
  - `eslint --max-warnings=0` over every added or modified `.ts`/`.tsx`: clean;
  - a node probe of `findPaths` (scratchpad, imports the worktree file): confirms Minor m4 below.
- Not re-run (read-only worktree; the contracts build writes `dist`): `pnpm typecheck`, `knip`, `build && budgets`, the int project (`templates.int`, `session-cost.int`, `m14.matrix.int`, `build-output.int`) and e2e. The ledger reports them green per task.

## Strengths

- **Review Focus 1 holds.** Nothing a block holds can run before Enter.
  - `shellText` (`features/sessions/shell-text.ts:12`) runs `stripHidden` first. Its class is `(?![\t\n])\p{Cc}`, so CR, ESC, BEL, DEL, every C1 (U+009B included), ^O and ^J-as-CR are gone, and `ESC[201~` cannot end a paste. Blank edges and the final new line go.
  - `controller.handOff` (`use-terminal.ts:231-236`) refuses multi-line text unless xterm reports bracketed paste, and types only when `typing` is true (live, replay written, screen set). Typing goes through `term.paste`. A single line carries no CR or LF, so it is inert whatever the mode.
  - The terminal is only ever the session's own (`taggedTerminal`, else one `terminal.create`), keyed by terminal id in `terminal-typists.ts`.
  - The 10 s wait starts once the id is known. A second click is deduplicated per block (`reply-markdown.ts:47`) and per session (`terminal-hand-off.ts:62-63`; the R24 amendment answers `busy` for different text).
  - J17 proves it in Chromium and WebKit.
- **The 52aaa4ab rewire is correct.**
  - `ShellBlock` reads `useSyncExternalStore(handOff.subscribe, () => handOff.statusOf(code, lang))`.
  - `statusOf` returns `IDLE` or the stored object, and `useShellAnswers.set` keeps every other entry's reference, so the snapshot is stable and cannot loop.
  - `subscribe` is a property of the memoised hand-off object, so it is stable per port, language and `finished`.
  - Status survives the chat's remount on split and pane switch (`MessageRow.shell.test.tsx` "the answer survives the chat mounting again").
  - The compiler gate passes.
- **Review Focus 2 holds.** `findPaths` (`path-links.ts`) accepts only `[\p{L}\p{N}._@+/-]` tokens. It refuses empty, `.` and `..` segments (so `//x` too), `~`, URLs, `host.tld/…` and over-long tokens.
  - Each candidate must sit under `scope.roots` and then under `scope.filesRoot`.
  - In agent scope only `/agent/{home,inbox,knowledge}` maps to `/agents/<id>/…`.
  - The click pushes a target for that root only. `FilesPane` takes it after `onListed`, so a stopped box shows START and no click starts a box. The daemon's `files.*` rules still decide.
  - No request is made while a reply streams.
- **Review Focus 5 holds.** `writeTemplate` (`prompt-template.ts`) checks the folder three ways: an `O_NOFOLLOW|O_DIRECTORY` open, `uid`, and the `/proc/self/fd` name.
  - It writes an exclusive `O_NOFOLLOW` 0600 temporary file, then `link` for a new name (atomic: a name planted in between is `conflict`) or `rename` for `replace` (never through a link).
  - `replace` refuses a non-regular or hard-linked target.
  - On the daemon side: the step-up comes first (`templates.ts:31`), then the shared Pi write queue, and one audit row with `{ name }` only after success.
  - `sensitiveParams: ["name","replace"]` has the right meaning: selectors hashed, body never in a receipt.
  - `pi:admin` plus the `FORBIDDEN` m14 row cover members. A token is refused (int test).
  - The contract refuses hidden characters in the body and description rather than stripping them.
- **Production wiring is real, not test-bed only.**
  - `composeSessionCost` is called in `composeM10`. Its listeners are removed before `sessions.shutdownAll` (`daemon.ts:385/388`), and `cost.stop()` clears the windows.
  - The snapshot carries `cost`.
  - Ports are registered by `SurfaceBar` (desktop, session tabs only) and `SurfaceSwitch` (phone `SessionSurface`; `PaneHost` with `shown` mounts no bar, so there is never a double registration), and by `AgentSpace`.
  - `composePi` passes `audit` to skills.
  - `resetReplyTools()` sits in the `AppShell` unmount cleanup and covers all six new stores.
- **Shared-renderer agreement with UX-2 is kept.**
  - `MarkdownProps` is exported, and the tools pass through `...tools`.
  - The providers (`ReplyTools`, `ShellHandOffContext`) wrap the body from outside.
  - The `<ReactMarkdown …>` line and `CodeBlock.tsx` are byte-for-byte untouched.
  - `@pap/ui` imports nothing from `@pap/contracts` (one comment mention only).
  - `methods.ts` stays at 399 lines.
- **Discipline.**
  - Every touched file is at or under 400 lines; the largest is `methods.test.ts` at 399.
  - No arbitrary values, no `title`, no eslint directive. Inline `style` is used only for computed geometry.
  - Stores import no feature (PF-A).
  - The new strings are proven out of the initial chunk by the markers row.
  - EN and FR have the same keys and slots.

## Issues

### Critical

None.

### Important

**I1. The template dialog and `skills.md` promise something pap does not do. Box projects and agents never get a saved template.**

- Where:
  - `apps/web/src/i18n/catalog/reply-tools.ts:35` and `:76-77` (`reply.template.box`), shown after a save at `SaveTemplateDialog.tsx:126`;
  - `docs/agents/skills.md:55` ("box projects and agents get it with their next Pi profile image build");
  - the source: spec §4.5 line 105 and plan Exact copy line 138.
- What is wrong: the Pi profile image build (`apps/daemon/src/modules/agent-vm/image-inputs.ts`, `build()` at `:316-345`) copies only these into the profile:
  - `settings.json` (sanitised);
  - `models.json`;
  - `skills/` (`:328`);
  - the package folders (`npm/`, `git/`, `local/`).
  - `<agent dir>/prompts/` is never copied. It is not a copied root and is not in the fingerprint, so no rebuild is even triggered.
  - `agents-vm.md:186/266` confirms that box sessions do not use the host's Pi configuration helpers or resources.
- Why it matters:
  - The owner is the only one offered the button, and it is offered on box-session rows too. They are told, at the point of saving, that their boxes will get `/name`. They never will.
  - Spec anti-goals and the lessons checklist ("no overclaiming") cover exactly this.
  - It is a spec error carried through the plan, not a builder slip.
- Fix (recommended for this merge):
  - Change the copy to the truth, for example EN "Box projects and agents do not get it: their Pi runs in its own VM." / FR « Les projets en box et les agents ne le reçoivent pas : leur Pi tourne dans sa propre VM. ».
  - Narrow `reply.template.when` to "sessions on this machine started from now on" / « des sessions de cette machine démarrées à partir de maintenant ».
  - Fix `skills.md:55`, and add a controller ruling that amends spec §4.5 and the plan's Exact copy.
  - Making it true is a different change: `b.copy(join(agentDir, "prompts"), "prompts", "prompts")` in `build()` plus the fingerprint. That is a third daemon change, it moves every profile image and it goes through the secret scan. It is the owner's call, as a follow-up.

### Minor (new findings)

**m1. A throw inside the poll never settles the hand-off.** `apps/web/src/routes/shell/terminal-hand-off.ts:20-25`.

- What happens:
  - `attempt()` runs inside `timers.set` callbacks. If `typist.handOff` throws there (for example xterm refusing `paste`/`focus` on a screen disposed between the check and the call), the promise never resolves.
  - `inFlight` for the session is never cleared, so every later click in that session answers `busy` or shares the dead promise.
  - The block stays pending forever.
- A smaller wrong claim: only the first, synchronous attempt is caught, and that path answers `unavailable` "Nothing was typed" even if `paste` ran before `focus` threw.
- Fix: wrap the attempt body in `try { … } catch { reportClientIssue("terminal_hand_off_failed"); resolve("unavailable"); }`. Unlikely in practice; one line.

**m2. `ShellBlock` fires `send` with no rejection path.** `packages/ui/src/ai/markdown/ShellBlock.tsx:46` calls `void handOff.send(code, lang)` without `.catch`.

- The app's `send` never rejects today: `handOff` catches, `shellText` and `t` do not throw.
- The `ShellHandOff` contract (`reply-tools.ts:38-39`) does not say so, and the lessons checklist asks every unawaited promise for a `.catch`.
- Fix: state "never rejects; failures are an answer" on `send`, or add `.catch(() => undefined)` with that comment.

**m3. To terminal replaces a Files split with unsaved edits without asking.** `apps/web/src/routes/shell/surface.ts:70-80` (`reveal` → `split`).

- What happens:
  - Clicking To terminal while the tab's split is Files with unsaved edits replaces the split, and the edits go.
  - It is the same pre-existing gap as the bar's Terminal button: `web.md:152` says "replacing a split pane … is not guarded yet".
  - UX-1 adds a trigger in the chat.
- Fix later: in `reveal`, when the current split is a `files` item with `hasUnsavedFiles(root)`, ask as `mayDiscard` does (`tab-actions.ts:34`). That one place covers both callers.

**m4. Absolute folders become links.** `apps/web/src/features/sessions/path-links.ts:37-55`.

- What happens:
  - Only a trailing `/` keeps a folder as text. An absolute token without an extension links, including a folder or the root itself.
  - The probe gives: `/w/p/src` → link, `/w/p` → link, `/agent/home` → `/agents/a1/home`.
  - The click opens a folder in the file viewer, which shows its error state.
- This is not an escape: the target is still under the Files root. It does contradict R14's "folders stay text".
- Fix later: for absolute tokens, require a known name as relative ones do, or accept it and document it in `web.md`'s Links paragraph.

**m5. A refusal is announced again on every remount.** `ShellBlock.tsx:38-40` with `stores/shell-answers.ts`.

- The answer is kept per block until reset (32 kept), and `InlineError announce="action"` is an alert that mounts with it.
- A split, a phone pane switch, or scrolling a virtualised transcript re-announces "This shell cannot hold several lines…" long after the click. "Typed…" also stays on the block indefinitely; this extends the deferred minor.
- DESIGN: only the result of the owner's own click is an alert.
- Fix later: keep `answer` with a `shownAt`/`announced` flag and render a later mount as plain text, or clear the answer at the next status change of the session.

**m6. A residual of the bracketed-paste check is not written down.** `docs/agents/terminal.md` ("Shell blocks of a reply").

- `bracketedPaste()` is xterm's record of the last `ESC[?2004h/l` it parsed.
- A program that exits or crashes without resetting the mode, over a shell with no line editor (`sh`/`dash` never asks for the mode itself), leaves it on. Several lines would then be wrapped in markers that shell ignores, and the CR between lines would run the first line.
- Bash, zsh and fish re-assert the mode at every prompt, and J17 covers bash turning it off.
- Fix: one residual line in `terminal.md`. No code change is asked.

**m7. Merge-note precision for UX-2's rebase.** Plan Merge notes 5.

- `MarkdownBody` now delegates to a new `MarkdownTree({ text, copyLabels })` (`render.tsx:201`).
- A prop UX-2 adds "to `MarkdownProps` and `MarkdownBody` only" will not reach `COMPONENTS` unless UX-2 also provides it through a context in `MarkdownBody`, as UX-1 does with `ReplyTools` and `ShellHandOffContext`, or threads it through `MarkdownTree`.
- `packages/contracts/src/methods.test.ts` is also at 399 lines now, so UX-2 cannot add a line there either.
- UX-1's `code` entry wraps `<PathText whole>`, and UX-2's inline-math line lands in the same entry: keep both.
- Fix: add these three facts to the plan's Merge notes, or to the UX-2 RB brief.

**m8. Nit, copy.** FR `reply.template.nameHint` says « compositeur ». The French UI elsewhere says « zone de saisie » (`settings-appearance.ts:192`). Plan-prescribed, so a controller call.

## Deferred-minor triage (ledger)

**Fix before merge, in the same small wave as I1:**

1. **T3, "AppShell `resetReplyTools()` call not pinned by a test".**
   - House rule `web.md:142`: "A new M8-style store … goes in the same place, with a line in the sign-out test."
   - `AppShell.signout.test.tsx` (90 lines, room to spare) was not extended. Deleting the `resetReplyTools()` line today fails no test, yet it is the MC34 property for six stores, which hold another account's reply ports, typists and queued quote text.
   - Fix: push one value into `useReplyPorts`, `useComposerInsert` and `useShellAnswers` before the unmount in the existing test, and assert they are empty after.
2. **T4, "stream test 'ends inside prefix' assertion cannot fail".** It is Review Focus 3's evidence.
   - `path-links.stream.test.ts:12`: spans are computed from the prefix itself, so `span.end <= end` is always true.
   - Fix (one line): also assert `prefix.slice(span.start, span.end) === span.text` and that the spans are ordered and do not overlap. That is the property `LinkedText` relies on to never drop or duplicate characters.

**Can wait (follow-up or accept):**

- T1:
  - `O_NOFOLLOW` not pinned alone: two guards, and either refuses on Linux.
  - `methods-idempotent.ts` out of order: cosmetic; fix when UX-2 adds lines there.
  - Silent `.catch` on cleanup: commented, and the primary outcome is reported.
  - `rm(temp)` throws after a successful link: practically unreachable. If it happens, the answer is `helper_failed` and the leftover temporary file makes a later `replace` answer `config_hard_link` until it is removed. Worth a follow-up line.
  - `service.ts` import order: cosmetic.
- T2:
  - `{parent:true}` wiring has no test: the parent's refresh lag is accepted by the spec.
  - The int test's weak equality: the event's existence already proves the wiring.
  - `snapshot.test.ts` self-referential default.
  - `Intl.NumberFormat` built per render.
- T3:
  - `listedRoot` never cleared: no box start, the viewer shows the stopped state.
  - Null-cwd fallback untested: fail-safe.
  - Unconsumed target kept: bounded at 32.
  - `FilesPane` import order.
- T4:
  - h1 to h6 duplication.
  - No `mod`/`sum` extensions and no dotfiles: tightening is allowed by R14.
  - The unsafe-href `<span>` branch keeps linking its children: scope still applies, cosmetic.
- T5:
  - J17 checks file absence at one instant: the unit tests pin the bytes, so a stronger e2e oracle can come later.
  - `handle.input`'s return value ignored.
  - Stale "Typed" status, and `inFlight` not in the sign-out reset: it settles within about 10 s plus the create deadline; see m5.
  - The fix report's aggregate counts: process only.
- T6:
  - Toolbar geometry asserted by bounds.
  - Scroll re-read re-renders.
  - Composer insert joins without a bound: the owner's clicks only.
  - "Saved" lost if the dialog closes mid-save: the next save says `conflict`, nothing is replaced silently.
  - `use-insert` focus listener stale if the textarea is replaced.

**Ledger warnings still open (preconditions, not findings):**

- Merge note 1, the controller's full `pnpm test:e2e` (J16 at 320 px with the usage line), is not yet in the ledger.
- Long inline path buttons in WebKit and Safari are not yet checked: J16, or the owner's preview check.

## Declined to judge

- **Pi's template argument syntax** (`$1`, `$@`, `${1:-text}` in `reply.template.help`): taken from the builder's report and the plan. Pi's docs live under `node_modules`, which the user's rules keep closed without an explicit ask.
- **xterm 6 `term.paste` internals** (new line to CR, bracketed wrap, no CR appended): not read, for the same reason. I relied on J17 on both engines and the plan's scratch check.
- **Visual layout** (320 px wrap, inline button wrapping, toolbar placement, the FR toolbar width): needs a browser. It belongs to the pre-merge full e2e and the preview.
- **Typecheck, knip, build and budgets, int and e2e suites**: not re-run, because the review was read-only and the contracts build writes `dist`. The ledger has them green per task.
- **Q1, project trigger task sessions keeping To terminal**: an owner ruling.
- **The 1 s cost window and the parent's lag**: accepted by the spec (§4.4).

## Recommendations

- One Sonnet fix wave: I1 (copy EN/FR, `when` line, `skills.md:55`, plus a controller ruling that amends spec §4.5 and the plan's Exact copy) and the two "fix before merge" deferred minors. m1, m2 and m6 are one line each and can ride along. m3, m4 and m5 can become follow-ups.
- The owner should decide whether templates should reach boxes and agents: `prompts/` in the Pi profile (`image-inputs.ts` `build()` and its fingerprint).
- Then do the scoped re-review of that wave, run the controller's full `pnpm test:e2e`, and merge UX-1 before UX-2 with m7's notes handed to UX-2's RB.

## Verdict

**Ready after fixes.** No security invariant is broken: a shell block never runs by itself, links stay inside what Files can open, and the template write never follows a link or replaces silently. The production wiring is real. One Important finding remains: a false claim at the template save point, inherited from the spec. Two cheap gaps should go in the same wave: the sign-out reset is not pinned by a test (a house rule), and one Review Focus test assertion is vacuous.

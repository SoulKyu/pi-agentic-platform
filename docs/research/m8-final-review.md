# M8 final review (archived 2026-10-14)

The Opus whole-branch review (verdict: ready after fixes), then the scoped re-review of the single fix round (verdict: ready). Copied verbatim.

# M8 final whole-branch review (Opus)

Range: `a29d52a..fdcb3b2` (branch `feat/m8-files-git-terminal`, 50 commits, 414 files). Reviewer: final whole-branch review, read-only.

Method: passes over contracts → `kernel/fs`, `kernel/git`, `kernel/pty` → `modules/files`, `vcs`, `terminal`, attachments, `kernel/ws` binary → pi-host → web runtime → panes and composer → docs, against the plan (Global Constraints, exit criteria, merge notes), the rulings MC1–MC37 and the parked minors of the ledger. Two probes, nothing in the checkout touched:

- **fd probe** (scratchpad script, the worktree's own `node-pty` 1.1.0, Node 24.14.1): a real PTY master (`/dev/ptmx`, fdinfo flags `0104002`, no `O_CLOEXEC`) is inherited by a default `spawn`; with a `stdio` array that maps that index to an fd opened on `/dev/null`, the child sees `/dev/null` at that number. Detail below.
- **Dry merge** with the current M7 branch: `git merge-tree --write-tree feat/m8-files-terminal feat/m7-models-tools` gives 26 conflicted files. All are union-type hunks (imports, list entries, `projects` port `roots` + `covers`, the stop line in `daemon.ts`, the TextField class line). None is structural.

The full gate suite was not re-run: the ledger records it green (unit 7571, int 550+1, smoke, budgets 201.2 KB).

## Strengths

- **One boundary everywhere.** Every route that takes a path goes through `judgePath` and then the checked open: `files.list/read/search/write`, raw GET/PUT, the `vcs` root and blob names (`judgeName` before git runs), the terminal `cwd`. Uploads go through the pending guard and the deny set. Both spellings are judged, then the descriptor via `/proc/self/fd`, then the deny set. `refusal()` makes every failure `not_found`, so a refusal never says whether the path exists. The security suite runs every hostile form against every route, the vcs and terminal routes included.
- **Fail-closed choices.** No walk finished, a walk past its deadline, a full key set, or an unreadable entry all refuse. `O_NOCTTY | O_NONBLOCK | O_NOFOLLOW` is set on every open. The final name is re-judged on the temp descriptor (MC8 I7). Remembered keys never evict.
- **The git runner** combines a subcommand allowlist, an exact option allowlist, its own `--no-ext-diff --no-textconv`, blanked program config, an allowlisted environment, a discovery ceiling, process-group kills and a 4/64 concurrency cap. After four Opus rounds the only program a repository can still start is the documented filter driver.
- **Token rules** are enforced twice: `GRANTABLE ∩ owner` at authentication (`auth/tokens.ts:143`, so a tampered row widens nothing), then `gateWrite` and `token_hidden`. The HTTP file routes are cookie-only. Terminals can never be reached with a token.
- **The terminal core** gets the subtle cases right. Server flow control follows MC27: the 2 s count starts at the beginning of a pause, only a resuming ack clears stale, and while the PTY is paused the shell is polled for exit. One stream per connection matches MC31 on both sides. The stop order and the `closing` flag cover a create that was still waiting on the judge (MC28). The kill ladder covers the whole session, guards against reused pids and handles EPERM.
- **Process hygiene.** Workers close inherited PTY fds as the first import, before any agent code. The shell environment shares `isDaemonOnly` with workers. The umask comes from a fixed wrapper, never a flipped process umask.
- **Contract discipline.** M8 adds exactly two error codes, in the agreed position. Method domains are spread per file. `HandlerContext.binary` is optional. There is no migration. `daemon.ts` grew by exactly 10 lines and `live-session.ts` by 1 (+1 net). No eslint directive was added. No file is over 400 lines. Module imports go only through `index.ts`. No AI trailer appears in the 50 commits.
- **Docs.** The residual lists are long and mostly honest. MC13 and MC29 are stated plainly, and the spawn-site list in `terminal.md` is a good handoff.

## Critical

None.

## Important

### I1. `PUT /files/raw` answers `{ written, meta }`, but the web client decodes a bare `FileMeta`

- **Where.** The server returns `UploadResult` (`apps/daemon/src/modules/files/upload-http.ts:82`, `upload.ts:72,86`): `{ written: false }`, or `{ written: true, meta }`. The client's `uploadFile` (`apps/web/src/runtime/upload.ts:87-91`) runs `FileMeta.safeParse(body)` on the whole body. `FileMeta` is a strict object (`packages/contracts/src/files.ts:43`), so every successful upload and every `skip` would surface as `UploadError("internal")` while the file was in fact written.
- **Why the tests are green.** `upload.test.ts:5-13,133` stubs a bare `FileMeta`, so client and test agree with each other, not with the server.
- **Why it matters.** It is latent today: `uploadFile` has no production caller. No explorer upload UI was planned or built. D04 "uploads (explorer)" therefore exists only as a server route plus a client function that would mis-decode on its first use. Task 6b's review (minor 3) saw "Task 14 decodes it as a FileMeta" but read it as the inner `meta`. Each per-task review saw only its own half, which is why this crossed both.
- **Minimal fix.** Either:
  - export an `UploadAnswer` schema from `contracts/files.ts` (a union on `written`), return it from the route, decode it in `uploadFile`, and stub the server's shape in the test; or
  - delete `uploadFile` and its test until a UI exists.

  In both cases, tell the owner that explorer upload has no UI in M8, and fix `files.md:71` ("the explorer asks `files.read` for the rest").

### I2. No written M7 rebase brief carries M8's load-bearing items

- **What is missing.** MC29 says "M7's helper entry calls the same function first (REBASE-BRIEF)", and the ledger's Task 21 line mentions "REBASE-BRIEF M7". No such file exists: I checked `.superpowers/` in both checkouts and `docs/`.
- **Why it matters (security).** M7's helper is a Node child forked by the daemon (`feat/m7-models-tools:apps/daemon/src/kernel/helper/pool.ts:90`, entry `packages/pi-host/src/helper/main.ts`). After the rebase, every helper forked while a terminal is open inherits the owner's PTY masters unless its entry imports `close-inherited-fds.ts` first. That is exactly the escalation MC29 fixed for workers.
- **Other carries recorded only in rulings or the ledger:**
  - **Stop order.** The dry merge conflicts at `daemon.ts:322`. The resolution must be `await Promise.all([pi.stopAll(), sessions.shutdownAll()]); await wk.shutdown();`, per agreement 9.
  - **Composer menus.** M7 must call `useComposerFieldProps([mentions, commands], attachments)`, and `useComposerCommands` must receive `mentions.fieldRef`. TextField's `inputRef` is the first menu's `fieldRef` (`composer/menus.ts:39`), so a second ref created by M7 never attaches and M7's caret reads return null.
  - **Projects port.** Union of `roots` (M8) and `covers` (M7).
  - **MC13.** The vcs runner should consult M7's repo config guard.
  - **MC37.** The new hook name.
  - **Reruns.** `host.images.int.test.ts` alongside M7's host tests.
- **Minimal fix (docs only, before merge).** Write `.superpowers/m7-rebase-brief-from-m8.md`, or a "For M7's rebase" section in `docs/research/m8-rulings.md`, listing the items above. Most important is the helper-entry import; optionally also the I4 spawn mask for the helper pool.

### I3. Any session's agent can read every pending upload and other sessions' attached files without a card (undocumented)

- **Where.** Task 7's review flagged this (minor 2: "plan level, controller decision"), and it was parked with no ruling. pi-host's read check protects `PAP_SENSITIVE` and other sessions' transcripts (`packages/pi-host/src/policy/read-target.ts:6-15,65-70`), but not `$PAP_HOME/attachments/`.
- **What this allows.** A prompt-injected session can `ls` and `read` both of these without any question:
  - `~/.pap/attachments/pending/*`: other sessions' images in flight;
  - `~/.pap/attachments/<other session>/**`: the owner's documents attached elsewhere.
- **Why it matters.** `policy.md:21` states that other sessions' transcripts are a protected read; attachments are the same kind of content and get no protection. Combined with taint, the content still reaches the model provider even though network exfiltration asks. Neither `files.md`, `policy.md` nor ADR 0031 mentions it.
- **Minimal fix.**
  - Before merge: document it as an accepted residual in `files.md` and `policy.md`, and record a ruling.
  - Follow-up for the owner of the policy folder (M7, agreement 15): add `attachments/pending` and `attachments/<sid ≠ own>` to read-target's sensitive set. The worker reads pending images itself, so the agent never needs `pending/`.

### I4. Mask the daemon's PTY masters in git's children (recommended before merge; see the dedicated section)

- **Where.** `apps/daemon/src/kernel/git/runner.ts:93`. Git's children inherit every PTY master the daemon holds.
- **What can use them.** A repository-local filter driver (MC13) runs under the daemon's `git status` and `git diff`. With a master it can type into the owner's open shell. That is more than same-user code execution:
  - sudo's default `timestamp_type=tty` makes a terminal with cached credentials worth root;
  - an open `ssh` session reaches other hosts.
- **Precondition.** Planting a filter driver needs an approved write to `.git/config`.
- **Why now.** The fix is about 25 lines plus one int test, sound (probe below), and independent of M7's guard.
- **Owner's call.** If the owner prefers not to do it, the documented residual is acceptable, but `terminal.md` should then name the tty-injection consequence.

## Minor

1. **Two saves of one file can both succeed** (`modules/files/write.ts:81-84`, `upload.ts:72-76`). The base check and the rename are separate awaits, with no per-path serialisation on the server. The client's `saving` set is per page (`use-save.ts:47`).
   - Two tabs, or a save plus an upload, with the same base etag both succeed, and the first is silently lost.
   - An agent write that lands between the check and the rename (milliseconds, including fsync) is overwritten.
   - Fix: a per-real-path promise chain around check + write in the files service. Document the agent window in `files.md` (Review Focus 4 promises "nothing overwritten silently").
2. **A claimed image can be swept before the worker reads it** (`attachments-store.ts:144-147` vs `:179`).
   - The claim checks expiry, but the sweep may unlink a claimed image before the worker reads it. This happens when the claim lands near 60 min, or when the prompt waits behind an extension command (a documented wait). The result is `pap:image_unreadable`.
   - Fix: set `entry.expiresAt = now + PENDING_TTL_MS` on claim (one line).
3. **Sent files hold the upload budget for up to an hour.** File attachments keep their pending share until expiry (by M8R39), so an owner gets about 32 uploads per hour, then `limit_reached`, even after the files were sent and copied.
   - This is not said in `files.md` or `web.md`.
   - Fix: document it, or forget file entries in `accepted()` (the copies exist).
4. **An explorer row dropped on the composer skips the invisible-character rule.** `dropPath` inserts the raw relative path (`composer/use-mentions.ts:137-140`). The `@` index refuses names holding bidi, zero-width or line-break characters (`search-index.ts:55-62`), and the menu filters with `isShowable` (`mention.vm.ts:64`). A dragged row bypasses both and reaches the prompt.
   - Fix: refuse, or strip, when `!isShowable`.
5. **`terminal.md:17` overclaims.** It says "no daemon descriptor reaches it". The test pins that only for the first terminal (`terminal-boundary.int.test.ts:68,76`), and the residual paragraph says sibling masters are inherited.
   - Fix: "…none but sibling terminals' masters (residual below)".
6. **`files.md:41` understates how much the deny set refuses before its first walk.** The doc says it "refuses everything linked". The code refuses every file, linked or not (`deny-set.ts:186-187`), until the first walk completes, and again whenever a walk outruns its deadline. Reads and lists answer `not_found` for up to 15 s after boot, or longer on a slow walk (for example a big `~/.kube/cache`).
   - Fix: the wording, and a `warn` when the first walk is late.
7. **The composer hook is called inside JSX.** `useComposerFieldProps(...)` runs inside the JSX spread (`Composer.tsx:116`). That is legal, but a hook hidden in markup is easy to move under a condition during M7's rebase.
   - Fix: hoist it to a `const fieldProps = …` line beside the other hooks.
8. **Refused upload bodies are still drained** (parked Task 6b m1).
   - `c.header("connection","close")` runs after `receiveBody` has built its Response (`upload-http.ts:58`, `attachments-http.ts:41`), so the header never reaches the wire.
   - Node then drains refused bodies for up to 300 s, outside the in-flight cap. Only the owner can do this.
   - Fix: set the header on the returned Response.
9. **Temporary files are left behind after a crash** (parked Task 6b m2). A crash or stop during an upload leaves `.pap-*.tmp` files (up to 25 MiB each) in the project; nothing sweeps them and the explorer lists them.
   - Fix: hide `isTempName` entries in listings.
10. **The `insecure_http` boot hint does not mention terminals** (`daemon.ts:295`). The LAN preview over plain HTTP now gives a shell to whoever sniffs the cookie.
    - Before M8 a stolen cookie could already approve the agent's commands, so the stakes change in convenience more than in kind.
    - Fix: one clause in the hint and in ADR 0004.
11. **Rebase on `main` before merge** (AGENTS.md rule). `main` has `1eeb3f9` (`docs/plans/roadmap.html` only, no overlap).

## Declined to judge

- **Real-browser behaviour** (xterm/WebGL, iOS keyboard, Safari drag and drop, hidden-tab throttling): headless host. These are the owner's preview checks.
- **The full gate suite:** not re-run, per instruction; the ledger records it green.
- **Tokens and other files that run code later** (`package.json` scripts, `Makefile`, `.github/workflows`): whether tokens should be refused them is a spec choice. M8 reuses M5's protected lists by design (agreement 5).
- **The git runner's real `setTimeout`** (unref'd) for git's deadline, instead of the kernel Clock: it is a deadline on a real process, in binding Task 4 code, and tested with real git.
- **systemd scope accounting under load:** the scope tests run on CI only.
- **The M7 branch itself:** only its conflict surface with M8 was examined.
- **`.git`-file and `core.worktree` redirections** (Task 4 m11): they need a `.git` write, the same precondition class as MC13.
- **node-pty internals** beyond the descriptor probe.

## The git-child fd mitigation (requested evaluation)

**Verdict: sound, cheap, worth doing before merge (I4).** It is not a blocker on its own; if declined, keep the residual and name the tty-injection consequence.

### Probe

Scratch script, the worktree's own `node-pty` 1.1.0, Node 24.14.1:

- The parent holds `20 -> /dev/ptmx`, fdinfo `flags: 0104002` (`O_RDWR | O_NONBLOCK | O_LARGEFILE`, **no** `O_CLOEXEC`).
- `spawn(sh, …, { stdio: ["ignore","pipe","pipe"] })`: the child lists `20 -> /dev/ptmx`. The residual is real.
- The same spawn with `stdio[20] = fs.openSync("/dev/null","r+")` and indices 3–19 set to `"ignore"`: the child lists `20 -> /dev/null`. libuv `dup2`s `stdio[k]` onto `k` in the child, which closes the inherited master there. Git's own children (filters) inherit git's table, so they see `/dev/null` as well.
- The parent's `/dev/null` descriptor itself is not inherited: libuv opens it with `O_CLOEXEC`.
- The other inherited fds 3–19 are unaffected. Node 24 itself marks fds inherited at startup with `O_CLOEXEC` (verified with fdinfo); only fds that native code creates at runtime, such as node-pty's masters, lack it.

### Two traps the implementation must avoid

1. **Holes in the array.** A sparse array (`arr[20] = fd` on a length-3 array) is compacted by Node's stdio normalisation. In the first probe the `/dev/null` fd landed at index 3 and fd 20 stayed unmasked. Fill every index up to the highest masked one with `"ignore"`.
2. **Compute the list at the spawn.** Read the list of master fds synchronously, in the same tick as `spawn`. node-pty opens masters synchronously on the main thread, so there is no race.

### Shape (about 25 lines)

A `kernel/pty/fd-mask.ts`:

- `maskedStdio(base)` reads `/proc/self/fd`, keeps the fds above 2 that link to `/dev/ptmx` or `/dev/pts/*`, and returns `base` unchanged when there are none or when `/proc` is missing.
- It opens `/dev/null` once, lazily.
- It returns a dense array with the masked indices pointing at that descriptor.

`execGit` passes `stdio: maskedStdio(["pipe","pipe","pipe"])`. The cost is one `readdir` plus a few `readlink` calls per git spawn, negligible against git itself.

### Test

In `terminal-boundary.int.test.ts`, with a terminal open, run a real-git `status` in a repository whose `.git/config` defines a `clean` filter that writes `readlink /proc/$$/fd/*` to a file. Assert there is no `/dev/ptmx`. A mutant without the mask must turn it red.

### Reach

The same helper can be a second layer for `supervisor/worker.ts`'s `fork`/`spawn` and M7's helper pool. Those children then never hold a master even before their first import runs. It does **not** cover node-pty's own shells (native fork), so the sibling-shell residual stays as documented.

## Merge readiness

**Verdict: Ready after fixes.**

- **Before merge:** I1–I3 (a few lines of code plus docs) and I4 (about 25 lines plus one int test; the owner may downgrade it to a documented residual). Then rebase on `main`.
- **Owner's discretion:** the minors. Minors 1–4 are the ones with user-visible effects.
- **Nothing found that breaks an exit criterion.** The traversal suite, the reconnect test and the stop test cover what they claim.


---

# M8 final fix round: scoped re-review (MC38)

Range: `fdcb3b2..6e59520` (9 commits). Read-only. Inputs: `final-review.md`, MC38 (`rulings.md:178-194`), `final-fix-report.md`, the review diff.

Checks run:

- `test:int kernel/git/fd-mask.int.test.ts`: green.
- Unit: `fd-mask`, `deny-set.deadline`, `attachments-store`, `list`, `upload-http`, `attachments-http`, `service.attachments`, web `upload`, `use-mentions` (9 files, 99 tests): green.
- `path-lock.test.ts` run 12 times: all green.
- A scratch wire probe for m8: the real `startServer` (`@hono/node-server`) plus the real `mountUploadRoute` and `mountAttachmentsRoute`, a raw socket, `Content-Length: 26214401`, and the body kept trickling in.
  - With the fix, both routes answer `413` with `connection: close`, and the socket closes in 2 to 11 ms.
  - Control with the old `c.header` form: `Connection: keep-alive`.

Repo rules:

- Every changed `.ts`/`.tsx` file is under 400 lines (`daemon.ts` stays at 328).
- No eslint directive was added.
- `kernel/git/runner.ts` → `kernel/pty/fd-mask.ts` is a kernel-internal import. `modules/files` imports only its own files.
- No AI trailers in the 9 commits.

## Finding Verdicts

| # | Verdict | Where | Notes |
| --- | --- | --- | --- |
| I1 | ADDRESSED | `packages/contracts/src/files.ts:57-61`, `apps/daemon/src/modules/files/upload.ts:20`, `apps/web/src/runtime/upload.ts:87-91`, `apps/web/src/runtime/upload.test.ts` | See I1 below. |
| I3 | ADDRESSED (docs-only residual, as ruled) | `docs/agents/files.md:47`, `docs/agents/policy.md:63`, `/home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.superpowers/m7-rebase-brief.md:14-16` | See I3 below. |
| I4 | ADDRESSED | `apps/daemon/src/kernel/pty/fd-mask.ts`, `apps/daemon/src/kernel/git/runner.ts:96-101`, `apps/daemon/src/kernel/git/fd-mask.int.test.ts`, `docs/agents/terminal.md:49` | See the I4 section. One Minor: N1. |
| m1 | ADDRESSED | `apps/daemon/src/modules/files/path-lock.ts`, `write.ts:80`, `upload.ts:70`, `service.ts` (`locks: createPathLock()`), `docs/agents/files.md:73` | See the m1 section. One Minor: N2, about the test. |
| m2 | ADDRESSED | `attachments-store.ts:195` | See m2 below. |
| m3 | ADDRESSED | `attachments-store.ts:271`, `prompt-attachments.ts:47` | See m3 below. |
| m4 | ADDRESSED | `apps/web/src/features/sessions/composer/use-mentions.ts:138-141` | See m4 below. |
| m5 | ADDRESSED | `docs/agents/terminal.md:17` | Now reads "no daemon descriptor reaches it but its sibling terminals' masters". |
| m6 | ADDRESSED | `apps/daemon/src/kernel/fs/deny-set.ts:158`, `docs/agents/files.md:41` | See m6 below. Nit N4. |
| m7 | ADDRESSED | `apps/web/src/features/sessions/Composer.tsx:36` | `const fieldProps = useComposerFieldProps(...)` is called without a condition, next to the other hooks. |
| m8 | ADDRESSED | `upload-http.ts:58`, `attachments-http.ts:41` | See m8 below. Minor N3. |
| m9 | ADDRESSED | `apps/daemon/src/modules/files/list.ts:139` | See m9 below. |
| m10 | ADDRESSED | `apps/daemon/src/daemon.ts:296`, `docs/adr/0004-loopback-http-cookie-without-secure.md:27` | The hint and the ADR both say that a sniffed cookie is a shell as the daemon's user. |
| m11 | OPEN (controller step) | n/a | `main` (`1eeb3f9`, roadmap doc only) is not yet an ancestor of HEAD. MC38 gives the rebase to the controller before the merge. |

**I1**

- A single `UploadAnswer` schema in contracts: a discriminated union on `written`.
- The server's `UploadResult` is that type, and the route answers it with `c.json(done)`.
- The client decodes `UploadAnswer`.
- The web test stubs `{written:true, meta}` and `{written:false}`, and checks that a bare `FileMeta` now fails as `internal`.
- The server tests already pin `{written, meta}` (`upload-http.test.ts:68,124,128`).
- `files.md:72` now says M8 has no explorer upload UI.

**I3**

- `files.md` and `policy.md` state the residual honestly and precisely:
  - the paths: `attachments/pending/*` and `attachments/<other sid>/**`;
  - "without a card";
  - taint still applies, but the content can reach the provider.
- The fix is deferred to M7's rebase, and the rebase brief, item 2, carries exactly that change to the sensitive set.

**m2**

- A claim sets `entry.expiresAt = now + PENDING_TTL_MS` once the pending file has been re-opened.
- The sweep reads the field that can now change.
- The test claims at 59:59, checks the file is still there 5 minutes later, and checks it is gone an hour after that.
- The rewritten expiry test still proves that an unclaimed upload expires (the `late` upload).

**m3**

- `release` forgets every id the owner owns.
- `accepted()` passes images and files.
- The copy under `attachments/<sid>/<id>/` stays; the test asserts it.
- Re-claiming answers `not_found`, and the budget is freed.
- Retry paths: see the m3 section.

**m4**

- `dropPath` returns before inserting when `!isShowable(relative)`.
- The test covers bidi, zero-width and line-break characters.
- The refusal is silent (no toast). That is acceptable: the `@` menu also hides such names silently.

**m6**

- `deny_first_walk_late` is logged when the deadline timer fires while `builtAt === null`.
- Production passes the logger (`compose-workspace.ts:117-119`), so the warning does reach the log.
- The doc now says "refuses every file, linked or not", and when.

**m8**

- The header is set on the Response that is actually returned.
- The probe above proves the header reaches the wire and the socket closes.

**m9**

- The filter is `isTempName`, which is exactly `/^\.pap-[0-9a-f]{12}\.tmp$/` on the basename (`safe-open.ts:174`).
- The test shows that `.pap-notours.tmp` stays listed. A user file is hidden only if it matches pap's exact temp form, which `uploadName` already reserves.
- The temp files are hidden with `showIgnored` as well.

### I4: the mask itself

- **Dense array.** Indices 3 up to the highest master are filled. A master index gets the null fd and every other index gets `"ignore"`. The unit test pins the exact array.
  - libuv `dup2`s the fd entries over the child's numbers.
  - An `"ignore"` entry at an index of 3 or more leaves the child's inherited fd untouched, which is no worse than before the fix.
  - The case where the null fd's own number falls inside the range is safe. libuv first moves a source below its target to a number at or above `stdio_count`, and the parent's copy is close-on-exec.
- **Same tick.** `maskedStdio(...)` is evaluated as an argument of `spawn`: synchronous `readdirSync` and `readlinkSync`, then the fork. Nothing can open a master in between.
- **The /dev/null fd's lifetime.** It is opened once, lazily (`nullFd ??=`), through `openSync`. libuv sets `O_CLOEXEC`, so workers and PTYs never inherit the parent's copy.
  - It is never closed, so there is no leak per spawn and it cannot be closed while a spawn is using it.
  - If the open fails (`EMFILE`), `maskedStdio` throws inside the Promise executor, so git does not run (fail closed), and the next spawn tries again.
- **Platforms.** On Linux the mask applies. Elsewhere `/proc` cannot be read and `base` is returned (no-op), as the doc says.
- **Integration test.**
  - It opens a real PTY, then installs a clean filter that writes `ls -l /proc/$$/fd`, then runs `runner.run(status)`.
  - A control asserts that the filter ran.
  - It asserts that the filter's fd table holds neither `/dev/ptmx` nor `/dev/pts/`.
  - The fix report records a mutant (plain pipes) going red with `22 -> /dev/ptmx`.
- **`terminal.md:49`.**
  - It names the mask and the two traps (holes in the array, same tick).
  - It lists what stays unmasked: sibling shells, `systemd-run`/`systemctl`/`loginctl`, and M7's helpers before their first import.
  - It states the tty-injection consequence: sudo's `timestamp_type=tty`, open `ssh` sessions.
- **Can systemd-run leak a master into the worker before the worker's own close?** No agent or project code runs in between:
  - **What happens.** `worker.ts:89-98` runs `systemd-run --user --scope --quiet --unit=… --slice=… -- <node> <execArgv> <entry>`. With `--scope`, systemd-run registers its own PID as the scope over D-Bus and then `execvp`s node in the same process. No child, no pager and no ask-password agent: `--quiet`, a user manager, stdio not a tty.
  - **Node's arguments.** Node starts with only `--conditions=*` and the semi-space flag (`config.ts:84-86`, which explicitly refuses `--import`).
  - **Node's environment.** `NODE_OPTIONS` is stripped (`supervisor/env.ts:24-25`).
  - **Evaluation order.** ESM evaluates `close-inherited-fds.ts` first (`packages/pi-host/src/main.ts:2`). Parsing and linking the rest of the graph runs no code.
  - **Conclusion.** The only code that holds a master before the close is the systemd-run binary and Node's bootstrap, both trusted. The doc's mention of `systemd-run` as unmasked is conservative, not wrong. The scope probe (`-- true`) and the `systemctl`/`loginctl` calls are short-lived trusted binaries.
  - **Spawn sites.** The list in `terminal.md` is complete for production code: search uses `worker_threads`, which stays in the same process.

### m1: the path lock

- **Keyed after realpath.** The key is `judged().real`, the result of `landing()` (`boundary.ts:131-137`).
  - For an existing file it is the file's `realpath`.
  - For a new file it is `realpath(folder)` plus the name.
  - Two spellings of one file therefore share a chain.
- **The window left open.** `target.exists` is still computed outside the lock, but the outcomes stay correct:
  - existing file: the second writer's `checkBase` re-reads the disk inside the lock and answers `conflict`;
  - creation: `writeAtomic` with `replace:false` links exclusively, so the second creation gets `exists`, then `conflict` (or `skip` for an upload).
- **Bounded map.** An entry lives only while work is queued, and is deleted on settle when it is still the tail. The size is bounded by concurrent writers (uploads are capped at 4 in flight per owner and route).
- **No poisoning.** The tail swallows both outcomes, and `previous.then(work)` turns a synchronous throw into a rejection. The unit test covers a rejection followed by a success, and that the size goes back to 0.
- **The upload streams while holding the lock.**
  - **No deadlock.** The chain's body does not wait on anything that needs the lock. `writeAtomic` pulls the request stream directly, and a refused or `skip` upload returns before pulling.
  - **WS dispatch is concurrent.** Frames are dispatched without waiting for one another (`ws-server.ordering.int.test.ts`), so a save waiting on the chain blocks no other RPC.
  - **The wait is bounded.** A stalled upload blocks saves of the same file only, for at most `requestTimeout` (300 s, `kernel/http/server.ts:30`). When the socket is destroyed, `writeAtomic` rejects and the chain moves on.
  - **Documentation.** `files.md:73` documents this, and the agent and shell window.
- **Tests.**
  - Two saves on one base etag: `[ok, conflict]`, and the file holds the first.
  - An upload, then a save: the save gets `conflict`.
  - The fix report records a mutant (the chain removed) turning 3 tests red.

### m3: retry paths

No legitimate retry needs the forgotten entry:

- A resend with the same `commandId` replays the stored receipt (`dispatcher.ts:120-125`) or joins the run still in flight (`:129-137`). The handler, and therefore `claim`, never runs twice.
- After an unknown outcome, "Edit" gives the tray fresh ids (MC36).
- The only path that would re-claim is both a failed receipt save and a lost response. Images have already behaved that way since M8R43.
- A prompt that Pi refuses is never `accepted()`, so its entries stay claimable.

## New Breakage in the Fix Diff

None Critical or Important.

- **N1 (Minor).** `fd-mask.ts:32` matches only `readlink === "/dev/ptmx"`.
  - **Where it fails.** Where `/dev/ptmx` is a symlink to `pts/ptmx` (Docker or podman containers, some devpts setups), `/proc/self/fd` shows `/dev/pts/ptmx`. The mask then silently does nothing.
  - **Inconsistency.** The worker's closer uses `isPty = link === "/dev/ptmx" || link.startsWith("/dev/pts/")` (`packages/pi-host/src/close-pty-fds.ts:17`).
  - **Who is affected.** Not the owner's host: `/dev/ptmx` is a character device here, and the int test asserts no `/dev/pts/`, so it would go red in a container CI.
  - **Fix.** One line: also match `/dev/pts/ptmx`, or reuse the `isPty` predicate (masking slaves too is harmless for git), plus a unit case.
- **N2 (Minor, test robustness).** `path-lock.test.ts:59-76` and `:78-98` assume the first call's judgement settles first.
  - **Why it can flip.** Each judgement is one `realpath` on the libuv pool (`boundary.ts:132`), and the two run in parallel on two threads. Under CI load the second can win the lock, which gives `["conflict","ok"]` or a save that beats the upload, and the test goes red.
  - **Observed.** Green 12 out of 12 runs locally.
  - **Fix.** Assert the outcomes in any order (one `ok`, one `conflict`, and the file holds the winner's text), or start the second call once the first is inside the chain.
- **N3 (Minor).** m8's tests read the header from the in-memory `app.request` Response, not from the wire. The scratch probe above shows that it does reach the wire. A real-socket int test would pin that against a future `@hono/node-server` change. Optional.
- **N4 (Nit).** The `deny-set.deadline.test.ts:55` title says "and not when a later one is", but the test never runs a later late walk. The `builtAt === null` guard is what guarantees that behaviour.
- **N5 (Nit).** `fd-mask.ts` caches `nullFd` at module level, so the unit test's fake `99` stays for that file's module instance. This has no effect on production or other files (masters are absent in the unit beds, and vitest isolates modules per file).

## Residual adjudication notes

- **I3.** The docs-only residual is acceptable as ruled. The text is precise, it names the owner of the fix, and the rebase brief carries the exact change.
- **I4.** The sibling-shell residual stays: node-pty forks natively, outside libuv's stdio. The unmasked trusted binaries are documented. The spawn mask for M7's helper pool is optional: the brief's item 1 (the helper entry's first import) is the binding control.
- **m1.** The agent and shell write window is documented as not covered. That is honest: a cross-process lock cannot be had cheaply.
- **The "Owner's call" on I4** is moot: it was implemented.

## Merge readiness

**Ready.** Every finding MC38 binds is addressed. The fix diff introduces nothing Critical or Important. All that remains is the controller's rebase on `main` (m11), the step MC38 already plans. N1 (a one-line widening of the master match) and N2 (an order-agnostic assertion) are cheap Minors, best applied before the merge but not blocking.

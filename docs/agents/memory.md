# Memory: pi-mem0's files, the review queue, the trust entry (M11b)

ADR 0052; rulings M11R142 to M11R152. Code: daemon `apps/daemon/src/modules/memory/` (the files, the views, the queue), `modules/sessions/memory-trust.ts` (what each worker is told, the release), `packages/pi-host/src/memory-entry.ts` (the entry), contracts `memory.ts` and `memory-methods.ts`, web `features/memory/`, `features/agents/RecentMemory.tsx`. pi-mem0's source is `/home/ubuntu/Workspace/soulkyu/pi-mem0` (read-only reference; its README "staging contract" is the contract).

## The contract

- pap never opens pi-mem0's store. It reads snapshots and writes request files in `PI_MEM0_DIR` (absolute) or `<Pi agent dir>/mem0` (`mem0Dir`; a relative or empty value warns once, `memory_pi_mem0_dir_not_absolute`, and is ignored). No folder: `memory.status` says `installed: false`, every list is empty, nothing fails (log `memory_pi_mem0_not_installed` at boot).
- Reads (`snapshots.ts`; `readSmall`: a regular file of the daemon's uid, no link, at most 1 MiB, never throws; a wrong field skips the item):

| File | Shape (pi-mem0's, not an invention) | pap reads |
| --- | --- | --- |
| `scopes/user.json`, `scopes/project-<id>.json` | `{scope, updatedAt, memories}` | `memories`: `{id, text, createdAt, source}`; `createdAt` may be `""`; the 200 newest; text cut to 4 096 |
| `agents/<agent id>.json` | `{agent, updatedAt, memories, events}` | the same `memories`; `events`: `{at, kind, id, text, source, scope, sessionId?}`, the newest 100; an unknown `kind` is skipped |
| `scopes/index.json` | `{projects: {<id>: {label, cwd}}}` | the key (id, checked) and `label`; the `cwd` is never read out |
| `health.json` | `{watcherAt, lastCaptureAt, lastCaptureError, pid, ...}` | `watcherAt` (fresh for 2 minutes, else `stale`; none: `unknown`), `lastCaptureAt`, `lastCaptureError` (pi-mem0 redacts and cuts it to 300; pap cuts again and shows it as text) |

  The keys `items`, `journal`, `projects.json` and `updatedAt` as the watcher stamp are not pi-mem0's and are ignored (a test pins it).
- Writes (`mem0-files.ts`; 0600, under a temp name, renamed, because pi-mem0 claims by rename; the folders `forget/`, `save/`, `staging/` must be real directories, made 0700 when absent, a link refuses):
  - `forget/<uuid>.json` `{memoryId, scope}`: at most 4 KB; scope spelled `user`, `project:<id>` or `agent:<id>`.
  - `save/<uuid>.json` `{scope, text, replaces?, source: "pi-web"}`: at most 8 KB; text 1 to 4 096 characters after trim, no `[REDACTED]`. `source` must be the literal `pi-web` or pi-mem0 drops the request. pi-mem0 drops without a word what it dislikes, so pap checks first and answers `bad_request`.
  - `staging/<fact id>.decision.json` `{approved}`.
- An applied request shows up in the next snapshot; the UI says "pi-mem0 will apply the change" and does not poll.

## Methods (`memory.*`)

All are `memory:admin` (browser only, outside the token permissions: memories can hold private facts) and refuse a token a second time in the service, except `memory.status` (`memory:read`; a token gets `lastCaptureError` and `lastCaptureAt` as null, since the error text can quote what was being extracted). Mutations are `idempotent: false`.

- `memory.scopes`: user, each project of the index, each of the owner's agents. `memory.list {scope}`: items and, for an agent, its journal. An agent that is not the caller's is `not_found`.
- `memory.forget {scope, ids}`: at most 50 ids. Every id is checked against one read of the scope's snapshot first; an unknown one writes nothing (`not_found`). The audit row is written for the requests that were written, even after a partial failure.
- `memory.save {scope, text, replaces?}`: without `replaces` it is a promotion and only the `user` scope receives it (any other scope is `bad_request`); with `replaces` it is a correction in the same scope, checked against the snapshot (`not_found`).
- `memory.staged`, `memory.decide {factId, approved}`: below.
- Audit: kind `policy`, `info`, detail `{scope, op, count}` (op `forget`, `promote`, `correct`, `approve`, `reject`); never the text.
- A read-only database answers `read_only` to the three writes.

## The review queue

- pi-mem0 stages the `memory_save` of an untrusted run (and an agent whose policy says `save: staged`) as `staging/<uuid>.json` `{id, agent, text, sourceSession, createdAt}`. pap lists them oldest first: the agent id must be pi-mem0's shape, the file at most 16 KB, `createdAt` at most 64 characters; a malformed one is skipped and counted (`memory_staged_skipped` when the count changes). The agent filter runs before the 200 cap, so another agent's or a deleted agent's facts never hide yours (orphans are logged once per agent, `memory_staged_orphan`).
- Every 30 s a guarded Clock timer (`review.ts`) raises one `memory_review` Inbox item per pending fact of an existing agent (`ref_id` = fact id, `agent_id`, `detail: null`) and closes the item of a fact that was settled or vanished. The item says "<agent> has memories to review"; it carries no fact text (W5-R61), because tokens can read the Inbox. The text is shown only through `memory.staged`, fenced and `untrusted: true`, in Settings › Memory.
- States of a fact: pending (no decision); decided but not claimed ("waiting for pi-mem0": both buttons stay, the owner can change the decision); `applying` (pi-mem0 renamed the decision to `<id>.processing`, and the claim is 10 minutes old or less): the fact is settled, its item closes as answered, a second `memory.decide` answers `conflict`, quarantine leaves it where it is. A claim older than 10 minutes is abandoned: the fact is pending again and the owner is asked again.
- `memory.decide` on a fact that is gone (or whose agent is not yours) closes any item that points at it and answers `not_found`.
- Quarantine step `memory`: the agent's facts and decisions are renamed into `staging/quarantine-<stamp>/` (0700), never rewritten; the Inbox items close. A fact being applied makes the step answer `applying` after the rest was moved.

## What each worker is told (ADR 0052)

- `memoryTrustOf(kind, launch)` runs at every worker start, in the same synchronous step as the rules (`service-launch.ts`). Its result is `init.memory` (`{profile, trust, memory?}`) and, for a closed session, `PI_MEM0_CAPTURE=0` in that worker's environment only.
- The worker appends the custom entry `pi-web:agent-profile` (pi-mem0's name and shape; version 1; pap writes it; it only compares with the newest entry before appending and never acts on it) before it binds the extensions, because pi-mem0 reads entries at `session_start`. It appends only when the newest such entry differs.
- An agent thread untainted: trusted, profile = the agent id, `memory` = the agent's policy (`AgentInput.memory`: `capture`, `save`, `hint` at most 500, `recallLimit` 0..20, `recallThreshold` 0..1; the form's Memory group). Tainted thread or agent task: untrusted under its profile. Child, M10 task, a tainted plain, lane, child or task: profile `""` and untrusted (pi-mem0 fails closed on an invalid profile). Untainted plain or lane: no entry. An unknown type is closed.
- Taint that rises mid-run (stage 07 only; the clean report of a networked shell does not count): the worker appends `pap:memory-trust {version: 1, trust: "untrusted"}` once (`appendMidRunUntrusted`); no pi-mem0 reads it. The barrier is the release: `createMemoryRelease` watches the workers that started with no entry or a trusted one, and on the policy port's session change with taint true it releases the worker (`releaseIdle`), or defers (`memory_release_deferred {sessionId, reason}`: `busy`, `cold`) and retries when the run settles (`status: idle`) or a reopen settles. `renew` runs inside `prompt`: a release still pending with an idle, not busy worker stops it and the prompt goes to a new worker, which starts closed. It returns null when nothing is pending, because an `await` there would add a tick and break the busy rule (M2R88).
- `memory_save` and `memory_forget` (pi-mem0's tools) are unknown external tools for pap's policy: they ask in the default mode, Deny / Allow once when tainted.

## Screens

- Settings › Memory (lazy `routes/settings/MemorySettings.tsx`; `SETTINGS_SECTIONS` has `memory` before `account`): status (not installed; watcher fresh with the age, stale, unknown; the last capture error as plain text), the residual in one sentence, "To review" (`ReviewList`: dashed attention frame `UNTRUSTED · staged memory`, agent name, Approve / Reject; `conflict` reads "Being applied", `not_found` "Already handled"), the scope picker (User, "Project · name", "Agent · name"), the list with a filter, Forget (several, at most 50 picked, confirm dialog with the sentence that earlier sessions keep what they already recalled), Promote to you (non-user scopes), Correct (inline, counter `used / 4 096`). Memory and fact text is React text with hidden characters stripped.
- A `memory_review` Inbox row opens Settings › Memory (not the agent tab) and marks itself read; Approve is never reachable from it.
- Status panel (`RecentMemory`, in the agent chunk): the agent's 5 newest memories and a Journal tab (20 newest, "Added" / "Forgotten"); one read of `memory.list`, a wrong-shaped answer is a failed read with Try again.

## Traps

- A session closed by a tainted start stays closed after the owner clears the taint: pap writes no entry for an untainted plain session, so the closed one stays the newest. Adopted sessions start tainted, so this reaches the owner's own Pi files (`pi` CLI resumes and forks also run pi-mem0 closed; `memory_save` fails there). An adopted pi-web file whose taint is cleared before pap's first start keeps pi-web's trusted entry.
- A prompt between Pi's `agent_settled` and the daemon's confirmation probe (three probes 100 ms apart) starts a second loop on the old worker; a run no prompt started (an extension message after a dialog) skips `renew`.
- pi-mem0 stores recalled memories in the session files, so Forget does not remove them from sessions that already recalled them.
- Tests never touch `~/.pi/agent` or `~/.pap`: `memory/testing/layout.ts` makes a temp pi-mem0 layout; the worker and security int tests use a fake memory extension (pi-mem0 itself is not installed there). `mem0-files.test.ts` runs the request bodies, modes, temp files, linked folders and ids against it. `memory-entry.test.ts` holds a faithful copy of pi-mem0's reader (`agentSessionFromEntries`, `parseMemoryPolicy`) and pins that pap's entry reads back as intended, including a policy at every limit.
- `PI_MEM0_CAPTURE` is refused by the worker test bed (`PI_*`), so only the daemon tests assert it.

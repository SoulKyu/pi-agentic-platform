# ADR 0052: memory through pi-mem0's file contract

Status: superseded by 0082 (OKF knowledge replaces pi-mem0; pap no longer integrates it). Accepted in M11b, Task 35
Date: 2026-10-17
Spec: A D14 (pi-mem0 scopes, approval queue, forget, promote / correct); C §5.2, §5.3 (taint). Rulings: M11R142 to M11R152, M11R156, M11R171, W5-R61. Owner answer m11. Builds on ADR 0020 (sticky taint) and ADR 0047.

## Context

pap has no memory store of its own. pi-mem0 is a Pi extension the owner installs in `~/.pi/agent`: it recalls memories into a session, captures facts after a run, and offers the tools `memory_save`, `memory_forget` and `memory_search`. Its memories are real data (a decision, a preference), and an untrusted run (a session that read external content) must not write to them as if it were the owner. pap must show the memories, forget, promote and correct them, queue what untrusted runs stage, and tell pi-mem0 which sessions it may learn from, without a second store, a copy of pi-mem0's code, or a change in `/home/ubuntu/Workspace/soulkyu/pi-mem0`.

## Decision

- **pi-mem0's files are the only contract.** `PI_MEM0_DIR` when absolute (a relative value is logged once and ignored), else `<Pi agent dir>/mem0`. pap reads snapshots and writes request files; it never opens the store. A missing folder is a status (`installed: false`), never a failure.
- **Reads** (`modules/memory/snapshots.ts`): `scopes/user.json`, `scopes/project-<id>.json`, `agents/<id>.json` with `memories` (`{id, text, createdAt, source}`, the 200 newest), the agent snapshot's `events` (`{at, kind, id, text, source, scope, sessionId?}`, the newest 100), `scopes/index.json` (`{projects: {<id>: {label, cwd}}}`; the `cwd` is never read out) and `health.json` (`watcherAt`, `lastCaptureAt`, `lastCaptureError`). Each file: a regular file of the owner, no link (`O_NOFOLLOW`), at most 1 MiB, field-checked; an item with a wrong field is skipped. The watcher is `fresh` for two minutes after `watcherAt`.
- **Writes** (`mem0-files.ts`), each a file written 0600 under a temp name and renamed, because pi-mem0 claims files by rename: `forget/<uuid>.json` `{memoryId, scope}` (at most 4 KB), `save/<uuid>.json` `{scope, text, replaces?, source: "pi-web"}` (at most 8 KB; text 1 to 4 096 characters, no `[REDACTED]`; pi-mem0 drops anything else without a word, so pap refuses first), and `staging/<fact>.decision.json` `{approved}`. pi-mem0 applies them later, from its own watcher; an applied change shows in the next snapshot.
- **Methods** (`memory.*`): all `memory:admin`, browser only, except `memory.status` (`memory:read`). A token never reads a memory. `forget` takes at most 50 ids, each checked against one read of that scope's snapshot first (an unknown id writes nothing, `not_found`). `save` without `replaces` is a promotion and only the user scope receives it; with `replaces` it is a correction in the same scope, checked against the snapshot. Forget, save and decide write an audit row (kind `policy`, detail `{scope, op, count}`), never the text.
- **The review queue.** pi-mem0 stages the saves of an untrusted run in `staging/<id>.json`. A guarded 30 s Clock timer lists them and writes one `memory_review` Inbox item per pending fact of an agent that exists (`ref_id` = the fact id, 200 at most). The item carries no text (`detail: null`, W5-R61): `inbox.list` and `inbox.get` can be read by a token, and the fact came from an untrusted run. The text is shown only through `memory.staged`, fenced, to a browser. A decision is `memory.decide`. pi-mem0 claims an approved or rejected fact by renaming it to `.processing`; a claim younger than 10 minutes is `applying` (the fact is settled and a second decision answers `conflict`); an older claim is abandoned and the owner is asked again. A decision pi-mem0 has not claimed is shown as "waiting for pi-mem0" and can still be changed. Quarantine moves the agent's facts and decisions into `staging/quarantine-<stamp>/` (0700) by rename, never rewriting them; a fact being applied stays and the step answers `applying`.
- **Telling pi-mem0 who may learn: its own entry, written by pap.** pi-mem0 reads the newest version-1 custom entry `pi-web:agent-profile` of the session at `session_start`; the name is pi-mem0's, pap writes it; it only compares with the newest entry before appending and never acts on it. The worker appends it before the extensions bind (`pi-host/memory-entry.ts`), only when it differs from the newest one (a reopen adds nothing). The daemon decides at every worker start (`memoryTrustOf`, from the session's type and its taint then):

| Session | Entry | `PI_MEM0_CAPTURE=0` | pi-mem0 then |
| --- | --- | --- | --- |
| untainted agent thread | `{profile: <agent id>, trust: "trusted", memory: <the agent's policy>}` | no | recalls, captures per the policy, saves directly, forgets in its own scope |
| tainted agent thread, agent task | `{profile: <agent id>, trust: "untrusted"}` | no | no capture, saves are staged for the owner, no forget |
| child, M10 task, any tainted plain, lane, child or task | `{profile: "", trust: "untrusted"}` | yes | no valid profile: fails closed, no capture, no save, no forget |
| untainted plain or lane session | none | no | an ordinary pi-mem0 session |

  A type the table does not name is closed. The agent's policy (`AgentInput.memory`: `capture` auto or off, `save` direct or staged, `hint` of at most 500 characters, `recallLimit` 0 to 20, `recallThreshold` 0 to 1) only narrows a trusted thread; a block with any invalid field makes pi-mem0 drop all of it and fail closed, and trust always wins. Only a real taint (stage 07) closes a session: the clean report of a networked shell (ADR 0047) does not.
- **A taint that rises during a run.** pi-mem0 fixes its policy at `session_start` and reads nothing later, so a session that started untainted is still open when it reads external content. pap does three things: the worker appends `pap:memory-trust {version: 1, trust: "untrusted"}` once (for a future pi-mem0; no pi-mem0 reads it today); the daemon releases that worker when the run settles, or at once when it is quiet (`createMemoryRelease`, only for workers that started with no entry or a trusted one); and whatever the release could not do (a dialog open, a queued prompt, a reopen or a start under way) stays pending and is enforced at the next prompt: `renew` stops the idle worker and the prompt runs on a new one, which starts closed. A running worker is never stopped (a steering prompt joins its run). The release is the barrier, not the note.
- `memory_save` and `memory_forget` are pi-mem0's extension tools. pap classifies them as unknown external tools, so they ask in the default mode and offer Deny / Allow once in a tainted session (ADR 0020). pap adds nothing (a test with a fake extension of those names pins it).
- Quarantine gains a last step, `memory`, that moves the agent's staged facts aside. Settings › Memory lists the scopes, forgets (the confirmation says that earlier sessions keep what they already recalled: pi-mem0 stores recalled memories in their session files), promotes, corrects, shows the review queue and pi-mem0's last capture error as text.

## The residual the owner accepted (m11)

A session that reads external content during a run can still be captured by pi-mem0 until the release takes effect. Stated precisely, because the first wording ("captured once") was too small:

- pi-mem0 never reads `pap:memory-trust`. The worker release, enforced at the next prompt, is the only barrier.
- The exposure is the daemon run in which the taint rose: one or more Pi loops (`agent_start` to `agent_settled`), each of which pi-mem0 may capture. It ends when the run settles.
- A prompt that arrives between Pi's `agent_settled` and the daemon's confirmation probe (up to three probes 100 ms apart, about 200 ms) starts a second loop on the old worker; that worker is released when the run really settles.
- A run that no prompt started (an extension's message after a dialog) does not pass through `renew`, so it can start on the old worker.
- A cleared taint keeps a plain session closed. Sessions adopted from Pi's folder start tainted, so pap writes the closed entry into the owner's own Pi file; later `pi` CLI resumes and forks of that file also run pi-mem0 closed, and `memory_save` fails there ("this agent session has an invalid profile entry"). Clearing the taint writes no entry (an untainted plain session gets none), so nothing reopens it.
- An adopted pi-web file keeps pi-web's trusted profile entry when its taint is cleared before pap's first start there, because pap then writes nothing.
- A child, an M10 task and a session that started tainted are closed from their worker's start; the memory release never touches them.

## Recommended change in pi-mem0 (owner m11; not built, a repository pap does not write)

- Re-read the session's entries at capture time and honour `pap:memory-trust` `untrusted` there. This closes the exposure of a taint that rises mid-run, so the residual above shrinks to nothing.
- Rank the two entry kinds by their position in the session, newest decides: a `pap:memory-trust` after the newest profile entry wins and can only close; a profile entry written after it replaces it, because pap writes that entry from a fresh decision at every worker start (a tainted start already writes the closed one).
- Define a reopen form, an entry pap would write when the owner clears a taint on a session whose newest entry is the closed one, so a cleared taint opens memory again instead of leaving the session closed for good.

## Consequences

- No second memory store and no pi-mem0 code in pap; a change in pi-mem0's file layout touches `snapshots.ts` and `mem0-files.ts` only.
- The owner sees and corrects every memory, and a fact an untrusted run staged waits fenced in the Inbox and in Settings › Memory until approved.
- A tainted plain session restarts its worker once, after its run: its next prompt waits for a cold start.
- A cleared taint does not reopen memory for a session that was closed; nothing in pap or pi-mem0 reopens it today.
- Until pi-mem0 reads `pap:memory-trust` at capture time, the residual above stays and Settings › Memory says so in one sentence.

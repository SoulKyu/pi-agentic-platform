# ADR 0050: agents

Status: accepted (M11a, Task 28). A deviation from pi-web's design in one place (event cards, below).
Date: 2026-10-16
Spec: C §5.3, §6.1. Rulings: M11R43 to M11R63, M11R64 to M11R82, M11R93 to M11R96, M11R115 to M11R117, M11R167, M11R174, M11R175, M11R177, M11R179 to M11R183, W5-R4, W5-R23, W5-R26, W5-R28, W5-R30 to W5-R32, W5-R39, W5-R44. Owner answers m1, m9, m10, m14, m15, m17, m18.

## Context

pi-web's long-term agents lived in files and a poll. pap has a database, streams, a policy pipeline and a sandbox, and its sessions are Pi's. An agent is a named profile with a home folder, one trusted thread, triggers, and runs outside the thread. M10 already runs project triggers as isolated sessions. M11 adds the agent beside them without changing them (ADR 0041 stays for project triggers).

## Decision

The agent:

- A row in `agents` (`AgentInput` as validated JSON, parsed again at every read: a row that no longer parses is `unreadable`, listed, never started, deletable). At most 32 per owner; the name is one word (`@Name`), unique per owner whatever the case; the id is `<slug>-<4 hex>` and names the home, the vault file and the scratch folders, so a rename keeps all three.
- The profile: role text (appended to the system prompt), model and thinking, approval mode (default `auto-accept-edits`), tool preset, sandbox `{required (default true), network (default false)}`, `allowHosts` (null: the owner's list), extra blocked commands (added to the owner's, never instead), an optional daily budget, `acceptsDelegation`, memory policy, `trustedSources`, `trustedAutonomy`. No folder of the owner's home can be added (owner m7; the schema refuses the key).
- Editing is compare-and-set on `revision`. A change that lets the agent do more later asks for the password: the sandbox off, the network on, a higher mode or preset, a wider or removed host list (a list of its own is judged against the owner's current list, W5-R36), a removed blocked command, autonomy on, a new autonomy host or trusted source. Creating an agent asks only if it is wider than the defaults. Narrowing and the budget never ask. Delete and quarantine always ask. A change applies at the thread worker's next start: the agents module asks the sessions module to release an idle thread; a running worker keeps the profile it started with (its mode, preset, hosts and autonomy are a snapshot, W5-R26), a model or thinking change reaches a live thread at once. The owner's session mode and preset can narrow a running agent, never widen it past the profile (W5-R23, W5-R28; `owner_preset` on the session row).
- Creation, edits and deletes are audited (kind `policy`, `info`) with the agent id and the names of the changed fields.

The home:

- `$PAP_HOME/agents/<id>/` (0700), made without `recursive` (an existing folder is `conflict`): `MEMORY.md` (0600, a six-line header), `prompts/` (0700, `.md` files the thread shows as prompt chips), `.gitignore` (`.pi/`), and a git repository with one commit `chore: init <name> home` made through the kernel git runner (no template, no hooks, a repository-local identity, `GIT_CONFIG_NOSYSTEM=1`). pap runs git in a home at creation only: the runner accepts `add`, `commit` and three fixed read-only `config` scans (filters, push configuration, origin URLs) on an agent's git dir, nothing else. The agent commits its own work from its shell. The row is written last; any failure removes the folder made by this call and writes no row.
- At every launch the home is opened with `O_DIRECTORY | O_NOFOLLOW`; a link, a file, a missing entry or a path behind a link is `invalid_cwd`; a home whose mode opened to group or others is made 0700 again and logged once (`agent_home_mode_repaired`).
- `sessions.create` in `$PAP_HOME/agents` or below is `invalid_cwd` in every spelling, and `fork` and `clone` of an agent session are `bad_request`. Project trust is never given to an agent session.
- Agent sessions are left out of the sidebar's project tree, the counts and the recent work of the home (they belong to the agent); search still finds them.
- Isolated tasks do not write `MEMORY.md`; they report through their summary card. Their scratch folder is `$PAP_HOME/agents/.runs/<agent>/<task>/` beside the home, so a search of the home never reaches it (W5-R4). A scratch folder is removed when its task's session is deleted. "Retry" makes a new task with a new, empty folder; an outbox re-run of the same task reuses its folder and starts tainted when the folder holds files (W5-R30).
- Deleting an agent pauses it first, refuses while its thread or a task of it runs or starts (`session_busy`, the pause undone), then deletes its triggers, cancels its queued tasks, archives its thread, drops its vault scope, moves the home to `$PAP_HOME/agents/.trash/<id>-<stamp>` (and its scratch folders to `.runs` beside), drops its waiting one-use values and removes its Inbox items, then deletes the row (cards and requests cascade). A failure after the move leaves the agent quarantined and logs `agent_delete_incomplete`. The answer names the trash entry.

The thread:

- One trusted thread per agent (`agents_thread` unique index), opened by `agents.openThread` (serialised per agent) and the only way a thread is made. Its profile is `agent-thread`, in the agent's home. A paused agent opens (the owner talks to it); a quarantined one does not. Reset (`agents.resetThread`, browser only) archives the thread, clears its unread count and reply item, and drops its host grants; the next open starts a new thread. Profile, home, triggers and queued tasks stay.
- No ten-minute deadline in a thread: the owner answers in the thread or the Inbox (owner m9). A task a trigger puts into the thread keeps its deadlines.
- Unread: +1 when a thread run ends `completed` and +1 per card, capped at 1 000 000; `agents.markRead` clears it.
- The rail state, highest first: `needs_input` (an open dialog or a pending request), `running`, `failed`, `paused`, `idle`; `quarantined` replaces all of them; an unreadable profile reads `paused`. The `agents` stream carries at most 32 agents and 200 requests, batched per 250 ms.

Event cards (deviation from pi-web):

- pi-web wrote its thread's cards as custom entries in Pi's session file. pap keeps them in its own table `agent_events` (kinds `schedule`, `task`, `isolated`, `delegation`, `reminder`, `notify`; at most 20 000 bytes each, 500 newest per agent, read 100 at a time). A card never reaches the model and never needs a Pi file write, so a reset or Pi's file format cannot lose or reorder it.
- The text of an isolated run's summary, a delegation result, a reminder note and a notify text is untrusted: stripped of hidden characters, clipped (summary 2 000, delegation 16 000, note 2 000, notify 500) and shown as text. Inject fills the composer with the fenced text and never sends.

Triggers and tasks:

- A trigger runs as an agent (`TriggerInput.execution.agent {agentId, target}`) instead of in a project folder, with `target` `thread` (a prompt in the agent's thread) or `isolated` (a fresh `agent-task` session). Webhook and feed triggers can only be `isolated`. A thread-target trigger may not use `{{precheck}}` (W5-R32). A thread-target fire with a payload is `bad_request` for any caller, and a token's fire of one is `forbidden` (owner m15).
- An agent trigger keeps the step-up of every save. Its precheck runs in the agent's sandbox, always (ADR 0048), with the system view and the agent's network through the proxy.
- An isolated run's session has role `task`, mode the trigger's (never `full-access`), home read-only, a scratch folder, and M10's closed tool list; unknown tools and unreadable commands block and a question waits 10 minutes in the Inbox, then is denied.
- A thread task is admitted only into an idle thread, one per agent at a time (the next is put off 10 s, not an attempt). The card is written before the prompt; the prompt's first line is fixed and says pap sent it (`[pap <kind> · <title>] Sent by pap for the owner, not typed by them.`; a delegation's says it is not from the owner, W5-R39). A tainted thread prompt fails closed (`tainted_prompt`), except a reminder set by the same session (ADR 0047).
- A paused agent's fires journal `paused`; queued tasks stay queued and start about 30 s after resume. A quarantined agent's queued tasks are cancelled.
- Owner-side queueing: `agents.queueTask` queues a task for the thread (20 per agent, prompt up to 20 000 characters, an optional hand-off quote fenced under a fixed header). A token is `forbidden`. A hand-off from another agent's thread is typed as `@Name` in the composer.
- The per-agent budget (owner m14): none by default. M10's owner-wide automation budget still applies to the agent's automatic runs. When set, `usdPerDay` and `tokensPerDay` gate the agent's automatic fires, delegations to it, reminders and thread tasks, and abort its running gated work across the run (`budget`); the owner's own messages in the thread are counted, not gated. Spend comes from the `runs` table (`agent_id`, and `parent_session_id` for children); there is no second counter. A change applies at once.

Quarantine and safety views:

- `agents.quarantine` (browser, password): pauses with `quarantined_at`, cancels running and queued tasks, aborts and archives the thread, cancels pending requests and drops one-use values, rotates the agent's webhook secrets, and lists the vault names to rotate by hand. Each step reports a code, never an error text. Resuming a quarantined agent also asks for the password.
- `agents.permissions` (browser only) names what the agent may do and can do now: tools, the sandbox (effective), hosts, blocked commands, vault names, triggers, trusted sources and autonomy, and the three conditions of the lethal trifecta (private data, untrusted content, a path out).

## Consequences

- Thirty-two agents per owner keep the rail and the `agents` stream bounded.
- A home that holds a link to somewhere else is refused rather than followed; the agent cannot lock itself out, because a mode change on the home is repaired.
- Profile edits do not interrupt a running worker.
- M11 has no import of pi-web's agents.

# A trigger's isolated task keeps its folder between runs

Owner request (2026-10-26): an agent's feed trigger (CyberNews's pulse) cannot do a delta between runs.
- Every isolated task gets a blank disk, which is deleted when its VM stops (`docs/agents/agents-vm.md`, "Disks").
- A feed or webhook trigger can only run as an isolated task (C §6.1).

The owner picked option B: keep the flow and the isolation, and give the trigger a disk of its own that survives its runs (decision 137).

## 1. Goals

- A trigger that runs an agent's **isolated task** can **keep its folder between runs**. This is an opt-in setting on the trigger, off by default.
- With it on:
  - every run of that trigger starts its task VM on the trigger's own disk;
  - the disk holds the whole agent folder, so `home/`, `knowledge/` and `inbox/` are as the previous run left them;
  - the disk is never shared with the agent's thread VM or with another trigger.
- The run is told that its folder is kept for the next run of this trigger.

**Non-goals:**
- a kept folder for a thread-target trigger (the thread already has its disk);
- for a delegated task or a reminder;
- for a project box;
- showing the kept disk in the Files explorer;
- a way to read the kept disk from the host.

**Anti-goals:**
- two runs on the same disk at once;
- a run that reads what an untrusted run wrote and starts trusted;
- a kept disk that outlives its trigger.

## 2. Rules

- **Taint.** Every run of a trigger with a kept folder starts tainted, whatever its source (my call). What an earlier run read from outside is on the disk.
  - A feed or webhook run is tainted already, so nothing changes for the owner's case.
- **One run at a time.** A run of that trigger waits while another run of the same trigger is starting or running.
  - Waiting is not an attempt. The other triggers' tasks go first.
  - pap-vmd also refuses to attach a kept disk that a live VM holds (`conflict`).
- **The disk itself.**
  - It is made blank, at the agent's disk size, by the first run that needs it.
  - It is reused after that and grown when the agent's disk size grows. It never shrinks.
  - pap-vmd keeps it at `/var/lib/pap-vm/<uid>/agents/<agent>/kept/<trigger key>/disk.img`. The key is the trigger id with no dashes (`TaskKey`).
  - The daily sweep of task disks leaves `kept/` alone.
- **When the disk is deleted** (best effort, logged on failure; my call):
  - the trigger is deleted;
  - its setting is turned off;
  - it runs as another agent or another target;
  - or its agent is deleted (with the agent's folder, as today).
- **Version skew.** A pap-vmd older than this answers `bad_request` to a start that names a kept disk. The task fails with that code, and the docs say to run `sudo pap vm setup` after the update. There is no protocol bump (my call).
- **Tests.** Process backend only, as for any agent test. Under the process backend, the kept folder is the task layout's root keyed by the trigger key, so it survives the run.

## 3. What the person sees

- **Trigger editor.** Under Target, when the trigger runs as an agent with "Isolated task", a switch appears (copy is my call):
  - EN: "Keep its folder between runs", with the help line "Each run finds what the previous one left. Every run starts as untrusted."
  - FR: « Garder son dossier entre les runs », with the help line « Chaque run retrouve ce que le précédent a laissé. Chaque run démarre comme non fiable. »
- **A run that waits** for the previous one shows as queued, as a task held for slots does.

## 4. Left to the builder

- where the wait lives (admission or the agent start);
- how pap-vmd checks that a kept disk is held (the reclaim's file check, or its own list of live VMs);
- how the "kept" note reaches the isolated task's prompt (`packages/pi-host/src/agent-prompt.ts`).

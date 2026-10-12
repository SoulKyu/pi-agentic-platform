# S4 follow-up (M2, R45) — worker RSS over a 300-turn scripted session

- Date / machine / Node / Pi SDK: 2026-10-12 / Linux 7.0.0-38-generic x86_64, AMD Ryzen 7 5800X3D (6 cores visible to the VM), 19 995 MB total RAM / v24.14.1 / 1.1.0 (`@earendil-works/pi-coding-agent`) · measured on commit bdbc916 plus the changes of the follow-up commit

## Question
R45: is `WORKER_BUDGET_MB` = 236 (ceil(157 × 1.5), `docs/spikes/s4.md`) still right after a long session? M2R116: the budget is about the worker process alone (its `/proc` RSS and PSS), never the scope. If the long session's p95 RSS exceeds 236, the budget becomes `ceil(p95 × 1.25)` and the owner confirms the number before it lands. M2R117: measured by hand on this host, not in CI.

## Method
- `scripts/measure-worker-rss.ts --turns 300 [--compaction on|off]` (run: `node --disable-warning=ExperimentalWarning --conditions=development scripts/measure-worker-rss.ts --turns 300`). It forks one `pi-host` worker through `createHostBed` (temp root for `PI_CODING_AGENT_DIR`, `HOME`, `PAP_HOME` and cwd; the network guard is preloaded; `PI_OFFLINE=1`, `PI_TELEMETRY=0`), on the scripted provider only. No real LLM, no outbound network, nothing under the real `~/.pi` or `~/.pap`.
- 300 prompts, one after the other, each waiting for `agent_settled` (60 s deadline per turn). Each turn is two scripted steps: a `read` of `big.txt` (40 KB, in the cwd), then a 2 KB text reply. The script checks at the end that 300 `tool_execution_end` records arrived, none with an error.
- Compaction on (default of the script): Pi's auto-compaction runs and the scripted model answers its summarization request with the script's `summary` field, which does not consume a step (`scriptedReplies` in `packages/pi-host/src/scripted-provider.ts`). 33 compactions happened in each run. Compaction off: `settings.json` `compaction.enabled: false`. The first measurement of this task had no `summary` support: with compaction on, the summarization calls consumed the steps meant for later turns and only 11 reads ended, so that measurement ran with compaction off.
- After every 25th turn (12 samples) the script reads the worker pid's own `VmRSS` and `VmHWM` (`/proc/<pid>/status`) and `Pss` (`/proc/<pid>/smaps_rollup`). The pid is the forked worker (no wrapper); no scope is involved. `idleRssMb` is `VmRSS` right after `ready`.
- Percentiles use S4's convention on the 12 samples: median = `sorted[floor(n × 0.5)]`, p95 = `sorted[floor(n × 0.95)]`, which is the maximum for n = 12.
- "flag" = the worker started with `--max-semi-space-size=16` (the beds' `DEV_EXEC_ARGV` after this follow-up). "no flag" = the same run in a scratch copy of the worktree with that flag removed from `packages/pi-host/src/testing/fork-host.ts` (the copy was deleted afterwards). Two complete runs of each of the four configurations, same host.

## Investigation (summary, by the coordinator's investigation of the same day)
The full report is `.superpowers/m2-t23-rss-investigation.md` (outside the repository); what it found, as measured there:
- After a forced full GC the live heap at turn 300 was 68.6 MB (compaction off) or 57.6 MB (compaction on); an idle worker 42 MB. The 650 MB RSS was V8 old-space garbage ahead of rare major GCs (5 mark-compacts in 300 turns), and RSS did not fall after a GC or after 40 s idle.
- With compaction off the transcript grows to 12 MB and each provider call re-serialises it; with compaction on RSS was 302-311 MB (six runs).
- Growth that stayed live was Pi's own `SessionManager.fileEntries` and agent state (about 41 KB per turn, the tool result held by reference); pap-side objects about 1 KB per turn.
- `--max-semi-space-size=16` brought compaction-on RSS to 224-227 MB (three runs) at the same wall time (2.5 s), with scavenges going from 44 to 111; it had no effect with compaction off. `--max-old-space-size` variants and an idle-GC emulation were also tried there and not adopted.

## Raw numbers (MB)
### flag, compaction on

Run 1 (`wallSeconds` 2.2, compactions 33, `idleRssMb` 173.7):

| turn | 25 | 50 | 75 | 100 | 125 | 150 | 175 | 200 | 225 | 250 | 275 | 300 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| RSS | 178.5 | 184.4 | 189.1 | 193.7 | 197.8 | 202.4 | 207 | 212.1 | 216.6 | 221.5 | 225.8 | 230.8 |
| PSS | 127.8 | 133.6 | 138.3 | 142.9 | 147.5 | 151.7 | 156.3 | 161.4 | 166.3 | 170.7 | 175 | 180.5 |
| peak RSS (`VmHWM`) | 178.5 | 184.4 | 189.2 | 193.7 | 197.8 | 202.6 | 207 | 212.1 | 216.6 | 221.5 | 225.8 | 230.8 |

Run 2 (`wallSeconds` 2.2, compactions 33, `idleRssMb` 170.9):

| turn | 25 | 50 | 75 | 100 | 125 | 150 | 175 | 200 | 225 | 250 | 275 | 300 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| RSS | 175.7 | 179 | 184.1 | 188 | 192.2 | 196.5 | 201.3 | 206.4 | 209.8 | 214.6 | 218.9 | 223.9 |
| PSS | 125 | 128.2 | 133.3 | 137.2 | 141.4 | 146.1 | 150.5 | 155.6 | 159.2 | 163.8 | 168.1 | 173.5 |
| peak RSS (`VmHWM`) | 175.9 | 179.2 | 184.1 | 188 | 192.2 | 196.6 | 201.5 | 206.4 | 209.8 | 214.6 | 219.1 | 223.9 |

### flag, compaction off

Run 1 (`wallSeconds` 6.3, compactions 0, `idleRssMb` 172.4):

| turn | 25 | 50 | 75 | 100 | 125 | 150 | 175 | 200 | 225 | 250 | 275 | 300 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| RSS | 176.8 | 181.8 | 232.7 | 302.3 | 474.6 | 496.1 | 497.3 | 510.6 | 548.5 | 618.9 | 654.7 | 666.4 |
| PSS | 125.5 | 130.5 | 181.4 | 251.1 | 423.8 | 445.3 | 446.5 | 459.7 | 497.6 | 567.6 | 603.5 | 615.6 |
| peak RSS (`VmHWM`) | 176.8 | 181.8 | 233.9 | 302.3 | 474.6 | 498.9 | 498.9 | 510.6 | 548.5 | 618.9 | 654.7 | 667.3 |

Run 2 (`wallSeconds` 5.8, compactions 0, `idleRssMb` 171.1):

| turn | 25 | 50 | 75 | 100 | 125 | 150 | 175 | 200 | 225 | 250 | 275 | 300 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| RSS | 175.4 | 180.7 | 234.1 | 315.3 | 427.8 | 525.7 | 527 | 528.9 | 539.2 | 566 | 643.3 | 695.1 |
| PSS | 124.6 | 129.9 | 183.3 | 264.6 | 377.1 | 474.9 | 476.3 | 478.1 | 488.4 | 515.2 | 592.4 | 644.3 |
| peak RSS (`VmHWM`) | 175.4 | 180.7 | 235.4 | 315.3 | 427.8 | 525.7 | 527 | 528.9 | 539.2 | 566 | 643.3 | 695.1 |

### no flag, compaction on

Run 1 (`wallSeconds` 2.2, compactions 33, `idleRssMb` 179.4):

| turn | 25 | 50 | 75 | 100 | 125 | 150 | 175 | 200 | 225 | 250 | 275 | 300 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| RSS | 204.5 | 211 | 237.9 | 268.1 | 273.3 | 279.2 | 283.7 | 289.3 | 292.7 | 300 | 304.2 | 308.9 |
| PSS | 153.7 | 160.2 | 187.1 | 217.2 | 222.4 | 228.4 | 232.9 | 238.5 | 241.8 | 249.2 | 253.4 | 258.1 |
| peak RSS (`VmHWM`) | 204.5 | 211.1 | 239 | 268.2 | 273.6 | 280.1 | 284.8 | 289.3 | 292.8 | 300 | 304.2 | 310 |

Run 2 (`wallSeconds` 2.2, compactions 33, `idleRssMb` 177.2):

| turn | 25 | 50 | 75 | 100 | 125 | 150 | 175 | 200 | 225 | 250 | 275 | 300 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| RSS | 205.5 | 212.5 | 221.9 | 265.8 | 273.5 | 278.7 | 284.4 | 288.9 | 293.7 | 298.8 | 303.7 | 307.8 |
| PSS | 154.7 | 161.7 | 171.1 | 215 | 222.7 | 227.9 | 233.6 | 238.1 | 242.9 | 248 | 252.9 | 257 |
| peak RSS (`VmHWM`) | 205.5 | 212.7 | 221.9 | 266.3 | 273.5 | 278.7 | 284.4 | 288.9 | 293.7 | 299 | 303.7 | 307.8 |

### no flag, compaction off

Run 1 (`wallSeconds` 5.3, compactions 0, `idleRssMb` 175.8):

| turn | 25 | 50 | 75 | 100 | 125 | 150 | 175 | 200 | 225 | 250 | 275 | 300 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| RSS | 209.1 | 268.8 | 286 | 293.7 | 301.2 | 312.6 | 316.9 | 323.4 | 399.4 | 655.2 | 679.8 | 679.8 |
| PSS | 158.3 | 218 | 235.2 | 242.9 | 250.4 | 261.8 | 266.3 | 272.8 | 348.7 | 604.5 | 629 | 629.1 |
| peak RSS (`VmHWM`) | 209.1 | 268.8 | 287 | 293.7 | 301.2 | 312.6 | 316.9 | 323.4 | 399.9 | 655.2 | 679.8 | 691 |

Run 2 (`wallSeconds` 5.3, compactions 0, `idleRssMb` 177.2):

| turn | 25 | 50 | 75 | 100 | 125 | 150 | 175 | 200 | 225 | 250 | 275 | 300 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| RSS | 209.5 | 269.2 | 286.3 | 294.2 | 299.9 | 305.5 | 310.8 | 316.3 | 406.3 | 657.6 | 675.5 | 675.5 |
| PSS | 158.8 | 218.6 | 235.7 | 243.6 | 249.2 | 254.8 | 260.3 | 265.7 | 355 | 606.9 | 624.8 | 624.9 |
| peak RSS (`VmHWM`) | 209.5 | 269.2 | 287.7 | 294.2 | 299.9 | 308.4 | 310.8 | 316.3 | 406.3 | 657.6 | 675.5 | 686.5 |

## Summary (MB; median / p95 / max over the 12 samples)

| configuration | run | RSS | PSS | peak RSS (`VmHWM`, max) | wall (s) |
|---|---|---|---|---|---|
| flag, compaction on | 1 | 207 / 230.8 / 230.8 | 156.3 / 180.5 / 180.5 | 230.8 | 2.2 |
| flag, compaction on | 2 | 201.3 / 223.9 / 223.9 | 150.5 / 173.5 / 173.5 | 223.9 | 2.2 |
| flag, compaction off | 1 | 497.3 / 666.4 / 666.4 | 446.5 / 615.6 / 615.6 | 667.3 | 6.3 |
| flag, compaction off | 2 | 527 / 695.1 / 695.1 | 476.3 / 644.3 / 644.3 | 695.1 | 5.8 |
| no flag, compaction on | 1 | 283.7 / 308.9 / 308.9 | 232.9 / 258.1 / 258.1 | 310 | 2.2 |
| no flag, compaction on | 2 | 284.4 / 307.8 / 307.8 | 233.6 / 257 / 257 | 307.8 | 2.2 |
| no flag, compaction off | 1 | 316.9 / 679.8 / 679.8 | 266.3 / 629.1 / 629.1 | 691 | 5.3 |
| no flag, compaction off | 2 | 310.8 / 675.5 / 675.5 | 260.3 / 624.9 / 624.9 | 686.5 | 5.3 |

- The first measurement of this task (compaction off, no flag, commit bdbc916) gave RSS 316.3 / 665.5 / 665.5 and 316.4 / 656.7 / 656.7, PSS 265.7 / 614.7 / 614.7 and 265.7 / 605.9 / 605.9, wall 5.3 s; the "no flag, compaction off" rows above are a repeat of it.
- Wall time of a 300-turn run: 2.2 s with compaction on, 5.3-6.3 s with it off (the scripted provider answers at once).
- With the flag and compaction on, RSS grows by about 4-5 MB per 25 turns over the 300 turns (no plateau within the run).
- Idle RSS at `ready` with the flag, ten fresh workers (`--turns 1`): 169.3, 169.7, 169.8, 170.6, 170.8, 171.1, 171.9, 172.8, 172.9, 173.0 (median 171.1, p95 173.0). The integration test read 169-172 MB over eight runs through the sessions module (flag on). S4's idle figure, 155-157 MB, predates the later pi-host code.

## Caveats (what this does not show)
- Scripted provider only: no real provider SDK client, no streaming of real token volumes, no MCP server, no extensions loaded. A `read` tool only; no `bash` children, no codemode.
- The summary is a short fixed text; a real summary is larger and costs a model call.
- 300 turns only. The compaction-on series was still rising at turn 300.
- RSS counts file-backed pages shared with other Node processes; PSS divides them (here PSS is 50-60 MB below RSS). `WORKER_BUDGET_MB` is derived from RSS on purpose (S4).
- Warm cache; one host; two runs per configuration. With compaction off the step up in RSS happens at different turns from run to run.

## Decision
Owner decision, 2026-10-12, after the investigation above: workers start with `--max-semi-space-size=16` (always appended by `workerExecArgv`, and present in the test beds), `WORKER_BUDGET_MB` = 285. The compaction-on, flag-on series peaks at 230.8 and 223.9 MB RSS; the formula `ceil(p95 × 1.25)` gives 289 on 230.8 and 280 on 223.9, and the owner's figure of 285 comes from the investigation's runs (p95 226.6, ceil(283.25) = 284, rounded up to 285). 285 is 1.23 × the highest value measured here.
- Default worker cap, `floor(totalMemMb × 0.5 / 285)` clamped to 2-16: 3 / 7 / 14 / 16 on 2 / 4 / 8 / 16 GB hosts (it was 4 / 8 / 16 / 16 with 236); 16 on this host.
- The never-compacting session (compaction off) still reaches 666-695 MB RSS with the flag; the flag does nothing for it, and the budget does not cover it.
- `idleWorkerRssMb`: idle p95 173.0 leaves 9.2 % headroom under 189 (below the 10 % that the task asks for), so it becomes `ceil(173.0 × 1.10)` = 191.

Decision: RAISE WORKER_BUDGET_MB to 285 with --max-semi-space-size=16 (owner, 2026-10-12)

# S4 follow-up (M2, R45) — worker RSS over a 300-turn scripted session

- Date / machine / Node / Pi SDK: 2026-10-12 / Linux 7.0.0-38-generic x86_64, AMD Ryzen 7 5800X3D (6 cores visible to the VM), 19 995 MB total RAM / v24.14.1 / 1.1.0 (`@earendil-works/pi-coding-agent`) · commit d4ceb7a plus the uncommitted measurement script

## Question
R45: is `WORKER_BUDGET_MB` = 236 (ceil(157 × 1.5), `docs/spikes/s4.md`) still right after a long session? M2R116: the budget is about the worker process alone (its `/proc` RSS and PSS), never the scope. If the long session's p95 RSS exceeds 236, the budget becomes `ceil(p95 × 1.25)`, `defaultMaxWorkers` is recomputed, and the owner confirms the number before it lands. M2R117: measured by hand on this host, not in CI.

## Method
- `scripts/measure-worker-rss.ts --turns 300` (run: `node --disable-warning=ExperimentalWarning --conditions=development scripts/measure-worker-rss.ts --turns 300`). It forks one `pi-host` worker through `createHostBed` (temp root for `PI_CODING_AGENT_DIR`, `HOME`, `PAP_HOME` and cwd; the network guard is preloaded; `PI_OFFLINE=1`, `PI_TELEMETRY=0`), on the scripted provider only. No real LLM, no outbound network, nothing under the real `~/.pi` or `~/.pap`.
- 300 prompts, one after the other, each waiting for `agent_settled` (60 s deadline per turn). Each turn is two scripted steps: a `read` of `big.txt` (40 KB, in the cwd), then a 2 KB text reply. The script checks at the end that 300 `tool_execution_end` records arrived, none with an error.
- Auto-compaction is off (`settings.json` `compaction.enabled: false`). With it on, the first run compacted from turn 10 on; the compaction summary calls consumed scripted steps and the session stopped reading after 11 turns (11 reads ended, 300 expected), so that run measured nothing. The session below therefore never compacts.
- After every 25th turn (12 samples) the script reads the worker pid's own `VmRSS` and `VmHWM` (`/proc/<pid>/status`) and `Pss` (`/proc/<pid>/smaps_rollup`). The pid is the forked worker (no wrapper); no scope is involved. `idleRssMb` is `VmRSS` right after `ready`.
- Percentiles use S4's convention on the 12 samples: median = `sorted[floor(n × 0.5)]`, p95 = `sorted[floor(n × 0.95)]`, which is the maximum for n = 12.
- Two complete runs, same host, same commit.

## Raw numbers (MB)
Run 1 (`wallSeconds` 5.3; `idleRssMb` 181):

| turn | 25 | 50 | 75 | 100 | 125 | 150 | 175 | 200 | 225 | 250 | 275 | 300 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| RSS | 209.4 | 269.2 | 286 | 296.6 | 302.2 | 310.9 | 316.3 | 321.7 | 409 | 564.6 | 663.8 | 665.5 |
| PSS | 158.6 | 218.5 | 235.2 | 245.9 | 251.5 | 260.1 | 265.7 | 271.1 | 358.2 | 513.9 | 613.1 | 614.7 |
| peak RSS (`VmHWM`) | 209.4 | 269.2 | 286 | 296.6 | 302.2 | 310.9 | 316.3 | 321.7 | 409 | 564.6 | 663.8 | 675.1 |

Run 2 (`wallSeconds` 5.3; `idleRssMb` 181.5):

| turn | 25 | 50 | 75 | 100 | 125 | 150 | 175 | 200 | 225 | 250 | 275 | 300 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| RSS | 208.1 | 268.9 | 286.1 | 296.9 | 301.4 | 311 | 316.4 | 321.8 | 409.7 | 656.4 | 656.7 | 656.7 |
| PSS | 157.3 | 218.1 | 235.3 | 246.1 | 250.7 | 260.2 | 265.7 | 271.2 | 358.3 | 605.6 | 605.9 | 605.9 |
| peak RSS (`VmHWM`) | 208.1 | 268.9 | 286.1 | 296.9 | 301.4 | 311.1 | 316.4 | 321.8 | 409.7 | 656.4 | 656.7 | 667.8 |

| | RSS median / p95 / max | PSS median / p95 / max |
|---|---|---|
| run 1 | 316.3 / 665.5 / 665.5 | 265.7 / 614.7 / 614.7 |
| run 2 | 316.4 / 656.7 / 656.7 | 265.7 / 605.9 / 605.9 |

- Wall time: 5.3 s for 300 turns in each run (not minutes: the scripted provider answers at once).
- Samples above 236 MB RSS: 11 of 12 in both runs (all but turn 25). PSS first exceeds 236 at turn 100 (245.9 / 246.1; turn 75 reads 235.2 / 235.3).
- Idle RSS at `ready` (181 / 181.5) is higher than S4's 155-157. The integration test `sessions.budgets.int.test.ts` read 171 MB for an idle worker started through the daemon's sessions module (one reading, taken from the first `health` record).
- RSS rose in steps (409 at turn 225, 564-656 at turn 250) rather than linearly; the script did not look into what holds the memory.

## Caveats (what this does not show)
- Scripted provider only: no real provider SDK client, no streaming of real token volumes, no MCP server, no extensions loaded.
- Auto-compaction off (see Method). A real session compacts when its context nears the model's window; this one keeps all 300 turns (about 12 MB of tool output plus replies) for the whole run.
- A text `read` tool only; no `bash` children, no codemode.
- RSS counts file-backed pages shared with other Node processes; PSS divides them (here PSS is 50-60 MB below RSS). `WORKER_BUDGET_MB` is derived from RSS on purpose (S4).
- Warm cache; one host; two runs. The two runs differ by at most 1.3 MB at the same turn up to turn 225; at turn 250 they differ by 91.8 MB (564.6 and 656.4), so the step up happens at different turns, and from turn 275 on by at most 7.1 MB.

## Decision
The long session's p95 RSS (665.5 and 656.7) exceeds 236, so by M2R116 the budget becomes `ceil(p95 × 1.25)`: 832 from run 1 (831.875), 821 from run 2 (820.9). With 832, `defaultMaxWorkers` on this host is floor(19 995 × 0.5 / 832) = 12 (it is 16 with 236); on 2 / 4 / 8 / 16 GB hosts it is 2 / 2 / 4 / 9 (it is 4 / 8 / 16 / 16 with 236). `WORKER_BUDGET_MB`, `defaultMaxWorkers`, `config.ts` and `budgets.json` are NOT changed by this task: the owner confirms the number first, because it lowers the default worker cap.

Decision: PENDING owner confirmation of RAISE WORKER_BUDGET_MB to 832

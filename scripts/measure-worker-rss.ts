// By hand, never in CI (M2R117): drives one pi-host worker through a long scripted session and prints its own
// /proc RSS and PSS every SAMPLE_EVERY turns. Scripted provider only, temp dirs only, network guard on.
//   node --disable-warning=ExperimentalWarning --conditions=development scripts/measure-worker-rss.ts --turns 300 > /tmp/pap-rss.json
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createHostBed } from "../packages/pi-host/src/testing/host-bed.ts";

const SAMPLE_EVERY = 25;
const TURN_TIMEOUT_MS = 60_000;
const BIG_FILE_BYTES = 40 * 1024;
const REPLY_BYTES = 2 * 1024;

const kbOf = (file: string, field: string): number => {
  const line = readFileSync(file, "utf8")
    .split("\n")
    .find((candidate) => candidate.startsWith(`${field}:`));
  const kb = Number(line?.split(/\s+/)[1]);
  if (!Number.isFinite(kb)) throw new Error(`${file}: no ${field}`);
  return kb;
};
const mb = (kb: number) => Math.round((kb / 1024) * 10) / 10;

function turnsFromArgs(): number {
  const { values } = parseArgs({ options: { turns: { type: "string", default: "300" } } });
  const turns = Number(values.turns);
  if (!Number.isInteger(turns) || turns < 1) throw new Error("--turns must be a positive integer");
  return turns;
}

async function main(): Promise<void> {
  const turns = turnsFromArgs();
  const started = Date.now();
  const reply = { text: "r".repeat(REPLY_BYTES) };
  const bed = createHostBed();
  try {
    writeFileSync(join(bed.cwd, "big.txt"), "x".repeat(BIG_FILE_BYTES));
    const script = {
      steps: Array.from({ length: turns }, (_, i) => [
        { toolCalls: [{ name: "read", args: { path: "big.txt" }, id: `read-${i}` }] },
        reply,
      ]).flat(),
    };
    // Auto-compaction would call the scripted model for its summary and consume the steps meant for later turns.
    await bed.start(script, { settings: { compaction: { enabled: false } } });
    const host = bed.host();
    const pid = host.child.pid;
    if (pid === undefined || pid <= 1) throw new Error("no worker pid");
    const idleRssMb = mb(kbOf(`/proc/${pid}/status`, "VmRSS"));
    const rssMb: number[] = [];
    const pssMb: number[] = [];
    const peakRssMb: number[] = [];
    for (let i = 1; i <= turns; i++) {
      const from = host.records.length;
      const response = await host.request({ type: "prompt", message: `turn ${i}` });
      if (response.success !== true) throw new Error(`turn ${i}: prompt refused`);
      await host.waitFor((record) => record.type === "agent_settled", {
        from,
        timeoutMs: TURN_TIMEOUT_MS,
      });
      if (i % SAMPLE_EVERY === 0 || i === turns) {
        rssMb.push(mb(kbOf(`/proc/${pid}/status`, "VmRSS")));
        peakRssMb.push(mb(kbOf(`/proc/${pid}/status`, "VmHWM")));
        pssMb.push(mb(kbOf(`/proc/${pid}/smaps_rollup`, "Pss")));
      }
    }
    const reads = host.records.filter((record) => record.type === "tool_execution_end");
    const failed = reads.filter((record) => record.isError !== false).length;
    if (reads.length !== turns || failed > 0)
      throw new Error(
        `${reads.length} reads ended, ${failed} failed, ${turns} expected: not a read-per-turn session`,
      );
    const wallSeconds = Math.round((Date.now() - started) / 100) / 10;
    console.log(JSON.stringify({ turns, idleRssMb, rssMb, peakRssMb, pssMb, wallSeconds }));
  } finally {
    await bed.dispose();
  }
}

main().catch((error: unknown) => {
  console.error(`measure-worker-rss: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

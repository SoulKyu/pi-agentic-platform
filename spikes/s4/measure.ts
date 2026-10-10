import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { totalmem, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const SAMPLES = 10;
const CONCURRENT_WORKERS = 4;
const SETTLE_MS = 3000;
const STEP_TIMEOUT_MS = 20_000;
const SHUTDOWN_TIMEOUT_MS = 5000;
const KILL_GRACE_MS = 2000;
const host = fileURLToPath(new URL("../s1/host.ts", import.meta.url));
const script = fileURLToPath(new URL("../s1/fixtures/scenario.json", import.meta.url));

type Msg = { type: string; error?: unknown };
interface Worker { child: ChildProcess; pid: number; root: string; forkToReadyMs: number }

// Every forked child lives here until it has exited; the cleanup paths below walk this set.
const children = new Set<ChildProcess>();
const roots = new Set<string>();
const alive = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

async function terminate(child: ChildProcess): Promise<void> {
  if (!alive(child)) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const hardKill = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
  await exited;
  clearTimeout(hardKill);
}
const terminateAll = () => Promise.all([...children].map(terminate));

process.on("exit", () => {
  for (const child of children) if (alive(child)) child.kill("SIGKILL");
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => { void terminateAll().finally(() => process.exit(signal === "SIGINT" ? 130 : 143)); });
}

function waitFor(child: ChildProcess, type: string): Promise<Msg> {
  return new Promise((resolve, reject) => {
    const done = () => { clearTimeout(timer); child.off("message", onMessage); child.off("exit", onExit); };
    const onMessage = (record: Msg) => {
      if (record.type === type) { done(); resolve(record); }
      else if (record.type === "boot_error") { done(); reject(new Error(`boot_error: ${String(record.error)}`)); }
    };
    const onExit = (code: number | null, signal: string | null) => { done(); reject(new Error(`worker exited early (code ${code}, signal ${signal}) while waiting for ${type}`)); };
    const timer = setTimeout(() => { done(); reject(new Error(`timeout after ${STEP_TIMEOUT_MS} ms waiting for ${type}`)); }, STEP_TIMEOUT_MS);
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}

async function spawnWorker(builtins: boolean): Promise<Worker> {
  const root = mkdtempSync(join(tmpdir(), "pap-s4-"));
  roots.add(root);
  const forkedAt = performance.now();
  const child = fork(host, [], {
    cwd: root,
    env: { ...process.env, PI_CODING_AGENT_DIR: root, HOME: root, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
    stdio: ["ignore", 2, 2, "ipc"], // host stdout/stderr go to our stderr: results stay on stdout
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  const worker = { child, pid: child.pid ?? 0, root, forkToReadyMs: 0 };
  try {
    const ready = waitFor(child, "ready");
    child.send({ type: "init", cwd: root, agentDir: root, script, order: "policy-last", builtins });
    await ready;
    worker.forkToReadyMs = Math.round(performance.now() - forkedAt);
    return worker;
  } catch (error) {
    await release(worker);
    throw error;
  }
}

async function release({ child, root }: Worker): Promise<void> {
  if (alive(child)) {
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    if (child.connected) child.send({ type: "shutdown" });
    const timedOut = await Promise.race([exited.then(() => false), sleep(SHUTDOWN_TIMEOUT_MS).then(() => true)]);
    if (timedOut) await terminate(child);
  }
  rmSync(root, { recursive: true, force: true });
  roots.delete(root);
}

function memory(pid: number) {
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  const rollup = readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
  const kb = (text: string, key: string) => Number(new RegExp(`${key}:\\s+(\\d+)`).exec(text)?.[1] ?? Number.NaN);
  const mb = (value: number) => Math.round(value / 1024);
  return {
    rssMb: mb(kb(status, "VmRSS")),
    hwmMb: mb(kb(status, "VmHWM")),
    anonMb: mb(kb(status, "RssAnon")),
    fileMb: mb(kb(status, "RssFile")),
    pssMb: mb(kb(rollup, "Pss")),
    privateMb: mb(kb(rollup, "Private_Clean") + kb(rollup, "Private_Dirty")),
  };
}
const descendants = (pid: number) => readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean).length;

async function sample(builtins: boolean) {
  const worker = await spawnWorker(builtins);
  try {
    await sleep(SETTLE_MS);
    const idle = memory(worker.pid);
    const grandchildren = descendants(worker.pid);
    const settled = waitFor(worker.child, "agent_settled");
    worker.child.send({ type: "prompt", id: "p", message: "one" });
    await settled;
    await sleep(SETTLE_MS);
    return { idle, afterPrompt: memory(worker.pid), grandchildren, forkToReadyMs: worker.forkToReadyMs };
  } finally {
    await release(worker);
  }
}

async function concurrent(count: number, builtins: boolean) {
  const workers: Worker[] = [];
  try {
    for (let i = 0; i < count; i++) workers.push(await spawnWorker(builtins));
    await sleep(SETTLE_MS);
    const each = workers.map((worker) => memory(worker.pid));
    const sum = (key: "rssMb" | "pssMb" | "privateMb") => each.reduce((total, one) => total + one[key], 0);
    return { workers: count, sumRssMb: sum("rssMb"), sumPssMb: sum("pssMb"), sumPrivateMb: sum("privateMb"), perWorkerPssMb: each.map((one) => one.pssMb) };
  } finally {
    await Promise.all(workers.map(release));
  }
}

const pick = (values: number[], q: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * q))] ?? 0;
const stat = (values: number[]) => ({ median: pick(values, 0.5), p95: pick(values, 0.95), min: Math.min(...values), max: Math.max(...values) });

async function main() {
  const report: { [key: string]: unknown } = { node: process.version, totalMemMb: Math.round(totalmem() / 1048576), samples: SAMPLES };
  await sample(false).catch(() => undefined); // discarded warm-up: page cache, V8 code cache; the numbers below are warm-cache
  for (const builtins of [false, true]) {
    const runs = [];
    for (let i = 0; i < SAMPLES; i++) runs.push(await sample(builtins));
    const col = (pickRun: (run: (typeof runs)[number]) => number) => runs.map(pickRun);
    report[builtins ? "builtins" : "baseline"] = {
      idleRss: stat(col((run) => run.idle.rssMb)),
      idlePss: stat(col((run) => run.idle.pssMb)),
      afterPromptRss: stat(col((run) => run.afterPrompt.rssMb)),
      afterPromptPss: stat(col((run) => run.afterPrompt.pssMb)),
      afterPromptPrivate: stat(col((run) => run.afterPrompt.privateMb)),
      afterPromptPeakRss: stat(col((run) => run.afterPrompt.hwmMb)),
      afterPromptRssAnon: stat(col((run) => run.afterPrompt.anonMb)),
      afterPromptRssFile: stat(col((run) => run.afterPrompt.fileMb)),
      forkToReadyMs: stat(col((run) => run.forkToReadyMs)),
      grandchildrenMax: Math.max(...col((run) => run.grandchildren)),
      raw: runs,
    };
  }
  report.concurrentIdleBuiltins = await concurrent(CONCURRENT_WORKERS, true);
  console.log(JSON.stringify(report, null, 2));
}

try {
  await main();
} finally {
  await terminateAll();
}

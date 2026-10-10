import { fork, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type Rec = { type: string; id?: string; [key: string]: unknown };
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const readySamples: Array<{ host: string; forkToReadyMs: number; importedAtMs: unknown; readyMs: unknown; rssMb: unknown }> = [];

interface HostOptions { order: string; script: string; builtins?: boolean; root?: string; sessionFile?: string; sessionId?: string }

function startHost({ order, script, builtins = false, root = mkdtempSync(join(tmpdir(), "pap-s1-")), sessionFile, sessionId }: HostOptions) {
  const forkedAt = performance.now();
  const child: ChildProcess = fork(here("./host.ts"), [], {
    cwd: root,
    env: { ...process.env, PI_CODING_AGENT_DIR: root, HOME: root, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    detached: true,
  });
  const records: Rec[] = [];
  const waiters = new Set<() => void>();
  child.on("message", (record: Rec) => { records.push(record); for (const wake of [...waiters]) wake(); });
  let seq = 0;
  const waitFor = (predicate: (record: Rec) => boolean, from = 0, timeoutMs = 15_000) =>
    new Promise<Rec>((resolve, reject) => {
      const check = () => {
        const hit = records.slice(from).find(predicate);
        if (hit) { waiters.delete(check); clearTimeout(timer); resolve(hit); }
      };
      const timer = setTimeout(() => { waiters.delete(check); reject(new Error("timeout")); }, timeoutMs);
      waiters.add(check);
      check();
    });
  const request = (record: Rec) => {
    const id = `q${++seq}`;
    child.send({ ...record, id });
    return waitFor((r) => r.type === "response" && r.id === id);
  };
  const settle = async (message: string) => {
    const from = records.length;
    await request({ type: "prompt", message });
    await waitFor((r) => r.type === "agent_settled", from);
  };
  const ready = async (label: string) => {
    const record = await waitFor((r) => r.type === "ready" || r.type === "boot_error");
    if (record.type === "boot_error") throw new Error(`${label}: ${String(record.error)}`);
    readySamples.push({ host: label, forkToReadyMs: Math.round(performance.now() - forkedAt), importedAtMs: record.importedAtMs, readyMs: record.readyMs, rssMb: record.rssMb });
    return record;
  };
  const shutdown = async () => {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.send({ type: "shutdown" });
    await exited;
  };
  child.send({ type: "init", cwd: root, agentDir: root, script: here(script), order, builtins, ...(sessionFile ? { sessionFile } : {}), ...(sessionId ? { sessionId } : {}) });
  return { child, records, waitFor, request, settle, ready, shutdown, root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

type Node = { entry: { id: string; type: string; message?: { role: string; content: unknown } }; children: Node[] };
const walk = (nodes: Node[]): Node[] => nodes.flatMap((node) => [node, ...walk(node.children)]);
const textOf = (content: unknown) => JSON.stringify(content);

const results: Record<string, unknown> = {};
const main = startHost({ order: "policy-first", script: "./fixtures/scenario.json" });
const t0 = performance.now();
const ready = await main.ready("main");
results.forkToReadyMs = Math.round(performance.now() - t0);
results.readyRssMb = ready.rssMb;
await main.settle("one");
await main.settle("two");
const tree1 = (await main.request({ type: "get_tree" })).data as { tree: Node[] };
const replyOne = walk(tree1.tree).find((node) => node.entry.message?.role === "assistant" && textOf(node.entry.message.content).includes("reply one"));
if (!replyOne) throw new Error("reply one not found in the tree");
const typesFrom = (from: number) => main.records.slice(from).map((r) => (r.type === "response" ? `response:${String(r.id)}` : r.type));
const navigateFrom = main.records.length;
results.navigate = (await main.request({ type: "navigate_tree", targetId: replyOne.entry.id })).data;
results.navigateRecords = typesFrom(navigateFrom);
await main.settle("three");
const tree2 = (await main.request({ type: "get_tree" })).data as { tree: Node[]; rssMb: number };
results.branched = (walk(tree2.tree).find((node) => node.entry.id === replyOne.entry.id)?.children.length ?? 0) === 2;
const panelFrom = main.records.length;
main.child.send({ type: "prompt", id: "panel", message: "/panel" });
const first = await main.waitFor((r) => r.type === "custom_render", panelFrom);
main.child.send({ type: "custom_input", id: first.id, data: "\u001b[B" });
await main.waitFor((r) => r.type === "custom_render" && JSON.stringify(r.lines).includes("> beta"), panelFrom);
main.child.send({ type: "custom_input", id: first.id, data: "\r" });
await main.waitFor((r) => r.type === "custom_close", panelFrom);
const notice = await main.waitFor((r) => r.type === "extension_ui_request" && r.method === "notify", panelFrom);
const panelResponse = await main.waitFor((r) => r.type === "response" && r.id === "panel", panelFrom);
results.panel = { firstLines: first.lines, notice: notice.message, response: panelResponse.data ?? panelResponse.error, records: typesFrom(panelFrom) };
await main.settle("probe");
results.afterRunRssMb = tree2.rssMb;
results["probe:policy-first"] = (await main.request({ type: "probe_report" })).data;
const exitStart = performance.now();
await main.shutdown();
results.shutdownMs = Math.round(performance.now() - exitStart);
main.cleanup();

for (const [label, order, builtins] of [["policy-last", "policy-last", false], ["override-last", "override-last", false], ["policy-first+builtins", "policy-first", true]] as const) {
  const host = startHost({ order, script: "./fixtures/probe.json", builtins });
  await host.ready(label);
  await host.settle("probe");
  results[`probe:${label}`] = (await host.request({ type: "probe_report" })).data;
  await host.shutdown();
  host.cleanup();
}

// R10: a created-but-never-prompted session, then a second worker that reopens its sessionFile,
// once with SessionManager.open(path) (the M1 worker's call) and once recreating it under its old id.
async function neverPrompted(label: string, reopenWithId: boolean) {
  const fresh = startHost({ order: "policy-first", script: "./fixtures/probe.json" });
  const freshReady = await fresh.ready(`never-prompted/${label}`);
  const sessionFile = String(freshReady.sessionFile);
  const existsAtReady = existsSync(sessionFile);
  await fresh.shutdown();
  const existsAfterShutdown = existsSync(sessionFile);
  const reopen = startHost({
    order: "policy-first",
    script: "./fixtures/probe.json",
    root: fresh.root,
    sessionFile,
    ...(reopenWithId ? { sessionId: String(freshReady.sessionId) } : {}),
  });
  const reopened = await reopen.ready(`reopen/${label}`);
  await reopen.settle("probe");
  const file = String(reopened.sessionFile);
  const header = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8").split("\n")[0] ?? "{}") as { id?: string }) : {};
  const report = (await reopen.request({ type: "probe_report" })).data as { sessionFileLog: unknown };
  await reopen.shutdown();
  reopen.cleanup();
  const tail = (path: string) => path.slice(fresh.root.length);
  return {
    existsAtReady,
    existsAfterShutdown,
    createdFile: tail(sessionFile),
    reopenedFile: tail(file),
    sameSessionFile: file === sessionFile,
    sameSessionId: reopened.sessionId === freshReady.sessionId,
    headerIdIsOriginal: header.id === freshReady.sessionId,
    log: report.sessionFileLog,
  };
}
results.sessionFile = {
  "reopen:open": await neverPrompted("open", false),
  "reopen:create-with-id": await neverPrompted("create-with-id", true),
};
results.readySamples = readySamples;
console.log(JSON.stringify(results, null, 2));

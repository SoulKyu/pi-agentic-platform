import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSystemClock } from "../../kernel/clock.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { createAgentFiles } from "./agent-files.ts";
import { createFilesDelivery } from "./deliver-files.ts";
import { layoutOf } from "./layouts.ts";
import { startRuntimeBed, type RuntimeBed } from "./testing/runtime-bed.ts";

/*
 * B2 with the real guest and a real pi-host worker (process backend): the owner's files reach the agent's home at a VM start,
 * for a thread VM and a task VM, and a removal reaches a running VM at once, a stopped one at its next start.
 */
const AGENT = "scout-ab12";
const TASK = "0123456789abcdef0123456789abcdef";
const CONFIG = ".kube/config";
let bed: RuntimeBed | undefined;
let secrets: string | undefined;
afterEach(async () => {
  await bed?.dispose();
  if (secrets) rmSync(secrets, { recursive: true, force: true });
  bed = undefined;
  secrets = undefined;
});

async function start() {
  secrets = mkdtempSync(join(tmpdir(), "pap-files-delivery-"));
  const files = createAgentFiles({ secretsDir: secrets, logger: silentLogger });
  const delivery = createFilesDelivery({ files, clock: createSystemClock(), logger: silentLogger });
  const started = await startRuntimeBed({ deliverFiles: delivery.start });
  delivery.live(started.runtime);
  bed = started;
  const homeOf = (taskKey?: string): string =>
    layoutOf("process", started.papHome, { agentId: AGENT, taskKey: taskKey ?? null }).home;
  return { files, bed: started, homeOf };
}
const present = (path: string) => vi.waitFor(() => expect(existsSync(path)).toBe(true), { timeout: 20_000 });
const gone = (path: string) => vi.waitFor(() => expect(existsSync(path)).toBe(false), { timeout: 20_000 });

describe("agent files reach the VM home", () => {
  it("an imported file is present in the agent's home after a start", async () => {
    const { files, bed: b, homeOf } = await start();
    files.put(AGENT, CONFIG, Buffer.from("token-1"));
    await b.spawnReady(AGENT);
    await present(join(homeOf(), CONFIG));
    expect(readFileSync(join(homeOf(), CONFIG), "utf8")).toBe("token-1");
    expect(statSync(join(homeOf(), CONFIG)).mode & 0o777).toBe(0o600);
    expect(statSync(join(homeOf(), ".kube")).mode & 0o777).toBe(0o700);
  }, 120_000);

  it("a task VM gets it too, and does not confirm a removal the thread VM has not seen", async () => {
    const { files, bed: b, homeOf } = await start();
    files.put(AGENT, CONFIG, Buffer.from("token-1"));
    files.put(AGENT, "old", Buffer.from("x"));
    files.remove(AGENT, "old");
    await b.spawnReady(AGENT, undefined, TASK);
    await present(join(homeOf(TASK), CONFIG));
    expect(readFileSync(join(homeOf(TASK), CONFIG), "utf8")).toBe("token-1");
    expect(files.pendingRemovals(AGENT)).toEqual(["old"]);
  }, 120_000);

  it("a file imported while the VM runs is written at once", async () => {
    const { files, bed: b, homeOf } = await start();
    await b.spawnReady(AGENT);
    files.put(AGENT, "late/key.pem", Buffer.from("pem"));
    await present(join(homeOf(), "late/key.pem"));
    expect(readFileSync(join(homeOf(), "late/key.pem"), "utf8")).toBe("pem");
  }, 120_000);

  it("removal while running deletes it at once and empties pendingRemovals", async () => {
    const { files, bed: b, homeOf } = await start();
    files.put(AGENT, CONFIG, Buffer.from("token-1"));
    await b.spawnReady(AGENT);
    await present(join(homeOf(), CONFIG));
    files.remove(AGENT, CONFIG);
    await gone(join(homeOf(), CONFIG));
    await vi.waitFor(() => expect(files.pendingRemovals(AGENT)).toEqual([]), { timeout: 20_000 });
  }, 120_000);

  it("removal while stopped deletes it after the next start, and pendingRemovals is then empty", async () => {
    const { files, bed: b, homeOf } = await start();
    files.put(AGENT, CONFIG, Buffer.from("token-1"));
    const first = await b.spawnReady(AGENT);
    await present(join(homeOf(), CONFIG));
    await first.handle.stop();
    await b.runtime.stop(AGENT);
    files.remove(AGENT, CONFIG);
    expect(files.pendingRemovals(AGENT)).toEqual([CONFIG]);
    // The VM kept (or lost) its disk; either way the file is there when the VM comes back.
    mkdirSync(dirname(join(homeOf(), CONFIG)), { recursive: true });
    writeFileSync(join(homeOf(), CONFIG), "stale");
    await b.spawnReady(AGENT);
    await gone(join(homeOf(), CONFIG));
    await vi.waitFor(() => expect(files.pendingRemovals(AGENT)).toEqual([]), { timeout: 20_000 });
  }, 120_000);
});

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEV_EXEC_ARGV, PI_HOST_MAIN } from "./testing/fork-host.ts";
import { bashScript, createHostBed, isApproval, isCallAudit, textOf, toolText } from "./testing/host-bed.ts";

let bed: ReturnType<typeof createHostBed>;
beforeEach(() => {
  bed = createHostBed();
});
afterEach(() => bed.dispose());

describe("pi-host worker: sessions", () => {
  it("reopens a session file under the same id and appends to it", async () => {
    const first = await bed.start({ steps: [{ text: "one" }] });
    const firstHost = bed.host();
    await firstHost.request({ type: "prompt", message: "first question" });
    await firstHost.waitFor((r) => r.type === "agent_settled");
    firstHost.send({ type: "shutdown", graceMs: 100 });
    expect(await firstHost.exited).toBe(0);
    const file = String(first.sessionFile);
    const before = readFileSync(file, "utf8");

    const second = await bed.start({ steps: [{ text: "two" }] }, { init: { sessionFile: file } });
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.sessionFile).toBe(file);
    const secondHost = bed.host();
    await secondHost.request({ type: "prompt", message: "second question" });
    await secondHost.waitFor((r) => r.type === "agent_settled");
    const after = readFileSync(file, "utf8");
    expect(after.startsWith(before)).toBe(true);
    const added = after
      .slice(before.length)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; message?: { role: string; content: unknown } });
    const messages = added.filter((e) => e.type === "message").map((e) => e.message);
    expect(messages.map((m) => m?.role)).toEqual(["user", "assistant"]);
    expect(textOf(messages[0])).toBe("second question");
    expect(textOf(messages[1])).toBe("two");
    expect(JSON.parse(before.split("\n")[0] ?? "{}")).toMatchObject({ type: "session", id: first.sessionId });
  });
});

describe("pi-host worker: records it cannot read", () => {
  it("answers a malformed command that has an id with a failure, and keeps working", async () => {
    await bed.start({ steps: [{ text: "hi" }] });
    const host = bed.host();
    host.send({ type: "prompt", id: "bad-1" });
    const failure = await host.waitFor((r) => r.type === "response" && r.id === "bad-1");
    expect(failure).toEqual({
      type: "response",
      id: "bad-1",
      command: "prompt",
      success: false,
      error: "malformed record",
    });
    expect((await host.request({ type: "get_state" })).success).toBe(true);
    expect(host.stderr()).toContain("dropped a malformed record (fields: message)");
  });

  it("closes the approval whose answer is malformed, which blocks the call (fail closed)", async () => {
    await bed.start(bashScript("echo never"));
    const host = bed.host();
    await host.request({ type: "prompt", message: "go" });
    const ask = await host.waitFor(isApproval);
    host.send({ type: "approval_response", id: ask.id, answer: "forever" });
    const end = await host.waitFor((r) => r.type === "tool_execution_end");
    expect(end.isError).toBe(true);
    expect(toolText(end)).toContain("could not evaluate this call");
    expect(host.records.find(isCallAudit)).toMatchObject({
      entry: { decision: "denied", reason: "dialog closed" },
    });
  });
});

describe("pi-host worker: lifetime", () => {
  it.each([{}, { graceMs: "soon" }, { graceMs: -1 }, { graceMs: 1.5 }])(
    "shuts down on a shutdown record that does not parse: %j",
    async (fields) => {
      await bed.start({ steps: [{ text: "hi" }] });
      bed.host().send({ type: "shutdown", ...fields });
      expect(await bed.host().exited).toBe(0);
    },
  );

  it.each([{ graceMs: 100 }, {}])(
    "shuts down while a dialog is pending, and the call it guards never runs: %j",
    async (fields) => {
      const marker = join(bed.root, "ran");
      await bed.start(bashScript(`touch ${marker}`));
      const host = bed.host();
      await host.request({ type: "prompt", message: "go" });
      await host.waitFor(isApproval);
      host.send({ type: "shutdown", ...fields });
      expect(await host.exited).toBe(0);
      expect(existsSync(marker)).toBe(false);
    },
  );

  it("tells extensions the session is closing before it exits (R106)", async () => {
    const probe = join(bed.root, "shutdown.txt");
    mkdirSync(join(bed.agentDir, "extensions"), { recursive: true });
    writeFileSync(
      join(bed.agentDir, "extensions", "shutdown-probe.js"),
      `import { appendFileSync } from "node:fs";\nexport default function (pi) { pi.on("session_shutdown", (event) => appendFileSync(${JSON.stringify(probe)}, event.reason + "\\n")); }\n`,
    );
    await bed.start({ steps: [{ text: "unused" }] });
    const host = bed.host();
    host.send({ type: "shutdown", graceMs: 1500 });
    expect(await host.exited).toBe(0);
    expect(readFileSync(probe, "utf8")).toBe("quit\n");
  });

  it("exits 0, with no channel error in its log, when the daemon closes the channel mid-dialog", async () => {
    await bed.start(bashScript("echo never"));
    const host = bed.host();
    await host.request({ type: "prompt", message: "go" });
    await host.waitFor(isApproval);
    host.child.disconnect();
    expect(await host.exited).toBe(0);
    expect(host.stderr()).not.toContain("ERR_IPC_CHANNEL_CLOSED");
  });

  it("exits on a shutdown that arrives while the session is still opening", async () => {
    const host = bed.launch({ steps: [{ text: "hi" }] });
    host.send({ type: "shutdown", graceMs: 0 });
    expect(await host.exited).toBe(0);
  });

  it("exits cleanly on shutdown", async () => {
    await bed.start({ steps: [{ text: "hi" }] });
    bed.host().send({ type: "shutdown", graceMs: 100 });
    expect(await bed.host().exited).toBe(0);
  });

  it("stops the command it is running when it shuts down", async () => {
    const seconds = `30.${Math.floor(Math.random() * 900) + 100}`;
    const running = () => spawnSync("pgrep", ["-f", `^sleep ${seconds.replace(".", "[.]")}`]).status === 0;
    await bed.start(bashScript(`sleep ${seconds}`));
    const host = bed.host();
    await host.request({ type: "prompt", message: "go" });
    host.send({ type: "approval_response", id: (await host.waitFor(isApproval)).id, answer: "once" });
    await vi.waitFor(() => expect(running()).toBe(true), { timeout: 5000, interval: 50 });
    host.send({ type: "shutdown", graceMs: 100 });
    expect(await host.exited).toBe(0);
    await vi.waitFor(() => expect(running()).toBe(false), { timeout: 5000, interval: 50 });
  });

  it("exits when its parent dies", async () => {
    const source = [
      'import { fork } from "node:child_process";',
      `const child = fork(${JSON.stringify(PI_HOST_MAIN)}, [], { execArgv: ${JSON.stringify(DEV_EXEC_ARGV)}, stdio: ["ignore", "ignore", "ignore", "ipc"] });`,
      'process.stdout.write(String(child.pid) + "\\n");',
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const parent = spawn(process.execPath, ["--input-type=module", "-e", source], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    const pid = await new Promise<number>((resolve) =>
      parent.stdout.once("data", (chunk: Buffer) => resolve(Number(chunk.toString().trim()))),
    );
    parent.kill("SIGKILL");
    const deadline = Date.now() + 5000;
    let alive = true;
    while (alive && Date.now() < deadline) {
      try {
        process.kill(pid, 0);
        await new Promise((resolve) => setTimeout(resolve, 50));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });
});

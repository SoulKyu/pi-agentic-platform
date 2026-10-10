import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEV_EXEC_ARGV, PI_HOST_MAIN } from "./testing/fork-host.ts";
import { bashScript, createHostBed, isConfirm, textOf, toolScript, toolText } from "./testing/host-bed.ts";

let bed: ReturnType<typeof createHostBed>;
beforeEach(() => {
  bed = createHostBed();
});
afterEach(() => bed.dispose());

describe("pi-host worker: boot", () => {
  it("reports ready with its session file and Pi version, and sets oom_score_adj", async () => {
    const ready = await bed.start({ steps: [{ text: "hi" }] });
    expect(String(ready.sessionFile).startsWith(join(bed.agentDir, "sessions"))).toBe(true);
    expect(String(ready.sessionFile)).toMatch(/\.jsonl$/);
    expect(ready.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(ready.piVersion).toBe(VERSION);
    if (process.platform === "linux") {
      expect(readFileSync(`/proc/${bed.host().child.pid}/oom_score_adj`, "utf8").trim()).toBe("800");
    }
  });

  it("reports its memory use", async () => {
    await bed.start({ steps: [{ text: "hi" }] });
    const health = await bed.host().waitFor((r) => r.type === "health");
    expect(health.rssMb).toBeGreaterThan(50);
    expect(health.rssMb).toBeLessThan(1024);
  });

  it("answers the records it received while the session was opening, after ready and in order", async () => {
    const host = bed.launch({ steps: [{ text: "hi" }] });
    host.send({ type: "get_state", id: "early-1" });
    host.send({ type: "prompt", id: "early-2", message: "go" });
    const ready = await host.waitFor((r) => r.type === "ready");
    const state = await host.waitFor((r) => r.type === "response" && r.id === "early-1");
    const prompt = await host.waitFor((r) => r.type === "response" && r.id === "early-2");
    expect(host.records.indexOf(ready)).toBeLessThan(host.records.indexOf(state));
    expect(host.records.indexOf(state)).toBeLessThan(host.records.indexOf(prompt));
    expect(state).toMatchObject({ success: true, data: { sessionId: ready.sessionId } });
    expect(prompt).toMatchObject({ success: true, data: { disposition: "started" } });
  });

  it.each([
    null,
    { bogus: true },
    { profile: "interactive" },
    { profile: "interactive", approvalMode: "yolo" },
  ])("refuses to start with the policy %j", async (policy) => {
    const host = bed.launch({ steps: [{ text: "hi" }] }, { policy });
    expect(await host.exited).toBe(70);
    expect(host.stderr()).toContain("invalid policy rules");
    expect(host.records.some((r) => r.type === "ready")).toBe(false);
  });

  it.each([
    ["has no pap data directory", { papHome: undefined }, "papHome"],
    ["has a relative pap data directory", { papHome: "pap" }, "papHome"],
    ["has a relative session directory", { cwd: "work" }, "cwd"],
  ])("refuses to start when the init record %s", async (_name, init, field) => {
    const host = bed.launch({ steps: [{ text: "hi" }] }, { init });
    expect(await host.exited).toBe(70);
    expect(host.stderr()).toContain(`dropped a malformed record (fields: ${field})`);
    expect(host.stderr()).toContain("the init record is malformed");
    expect(host.records.some((r) => r.type === "ready")).toBe(false);
  });

  it("refuses to start when its environment names another agent directory than the init record", async () => {
    const host = bed.launch({ steps: [{ text: "hi" }] }, { agentDirEnv: join(bed.root, "elsewhere") });
    expect(await host.exited).toBe(70);
    expect(host.stderr()).toContain("PI_CODING_AGENT_DIR must name the agent directory");
    expect(host.records.some((r) => r.type === "ready")).toBe(false);
  });

  it("refuses to start with a provider script it cannot read", async () => {
    const host = bed.launch(
      { steps: [{ text: "hi" }] },
      { init: { testProviderScript: join(bed.root, "missing.json") } },
    );
    expect(await host.exited).toBe(70);
    expect(host.records.some((r) => r.type === "ready")).toBe(false);
  });
});

describe("pi-host worker: runs", () => {
  it("streams a run, settles, reports idle, and keeps Unicode intact over IPC", async () => {
    const text = "Bonjour 👋 中文 fin";
    const ready = await bed.start({ steps: [{ text }] });
    const host = bed.host();
    const response = await host.request({ type: "prompt", message: "go" });
    expect(response).toMatchObject({ success: true, data: { disposition: "started" } });
    await host.waitFor((r) => r.type === "agent_settled");
    const end = await host.waitFor(
      (r) => r.type === "message_end" && (r.message as { role?: string }).role === "assistant",
    );
    expect(textOf(end.message)).toBe(text);
    const state = await host.request({ type: "get_state" });
    expect(state.data).toEqual({
      isStreaming: false,
      isCompacting: false,
      pendingMessageCount: 0,
      sessionFile: ready.sessionFile,
      sessionId: ready.sessionId,
    });
    // Pi writes an entry after subscribers saw its message_end, so the file is read once the run has settled (R38).
    const entries = readFileSync(String(ready.sessionFile), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; message?: { role: string; content: unknown } });
    expect(entries.filter((e) => e.type === "message").map((e) => e.message?.role)).toEqual([
      "system",
      "user",
      "assistant",
    ]);
  });

  it("sends message updates without the cumulative partial message", async () => {
    await bed.start({ steps: [{ text: "Hello there, world" }] });
    const host = bed.host();
    await host.request({ type: "prompt", message: "go" });
    await host.waitFor((r) => r.type === "agent_settled");
    const deltas = host.records.filter(
      (r) =>
        r.type === "message_update" && (r.assistantMessageEvent as { type: string }).type === "text_delta",
    );
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.map((r) => (r.assistantMessageEvent as { delta: string }).delta).join("")).toBe(
      "Hello there, world",
    );
    for (const record of deltas) expect(record.assistantMessageEvent).not.toHaveProperty("partial");
  });

  it("settles a run whose provider fails and reports the error on the last message", async () => {
    await bed.start(
      { steps: [{ stopReason: "error", errorMessage: "429 usage limit reached" }] },
      { settings: { retry: { enabled: false } } },
    );
    const host = bed.host();
    expect(await host.request({ type: "prompt", message: "go" })).toMatchObject({ success: true });
    expect(await host.waitFor((r) => r.type === "agent_settled")).toMatchObject({ aborted: false });
    const last = host.records.filter((r) => r.type === "message_end").at(-1);
    expect(last?.message).toMatchObject({
      role: "assistant",
      stopReason: "error",
      errorMessage: "429 usage limit reached",
    });
  });

  it("aborts a running command", async () => {
    await bed.start(bashScript("sleep 30"));
    const host = bed.host();
    await host.request({ type: "prompt", message: "go" });
    const ask = await host.waitFor(isConfirm);
    host.send({ type: "extension_ui_response", id: ask.id, confirmed: true });
    await host.waitFor((r) => r.type === "tool_execution_start");
    expect(await host.request({ type: "abort" })).toMatchObject({ success: true });
    expect(await host.waitFor((r) => r.type === "agent_settled")).toMatchObject({ aborted: true });
  });
});

describe("pi-host worker: policy", () => {
  it("asks before bash and runs it once approved", async () => {
    await bed.start(bashScript("echo pap-ok"));
    const host = bed.host();
    await host.request({ type: "prompt", message: "go" });
    const ask = await host.waitFor(isConfirm);
    expect(String(ask.message)).toContain("echo pap-ok");
    host.send({ type: "extension_ui_response", id: ask.id, confirmed: true });
    const end = await host.waitFor((r) => r.type === "tool_execution_end");
    expect(end.isError).toBe(false);
    expect(toolText(end)).toContain("pap-ok");
    expect(host.records.filter((r) => r.type === "audit")).toEqual([
      {
        type: "audit",
        entry: { toolCallId: "call-1", tool: "bash", category: "exec", decision: "approved" },
      },
    ]);
  });

  it("blocks a denied call and returns the reason to the model", async () => {
    await bed.start(bashScript("echo nope"));
    const host = bed.host();
    await host.request({ type: "prompt", message: "go" });
    const ask = await host.waitFor(isConfirm);
    host.send({ type: "extension_ui_response", id: ask.id, confirmed: false });
    const end = await host.waitFor((r) => r.type === "tool_execution_end");
    expect(end.isError).toBe(true);
    expect(toolText(end)).toContain("Denied by the user.");
    expect(host.records.find((r) => r.type === "audit")).toMatchObject({ entry: { decision: "denied" } });
  });

  it("writes inside the session directory without asking", async () => {
    await bed.start(toolScript("write", { path: "note.txt", content: "hello" }));
    const host = bed.host();
    await host.request({ type: "prompt", message: "go" });
    expect((await host.waitFor((r) => r.type === "tool_execution_end")).isError).toBe(false);
    expect(readFileSync(join(bed.cwd, "note.txt"), "utf8")).toBe("hello");
    expect(host.records.some(isConfirm)).toBe(false);
    expect(host.records.find((r) => r.type === "audit")).toMatchObject({
      entry: { category: "edit", decision: "allow" },
    });
  });

  it.each(["agentDir", "papHome"] as const)(
    "asks before a write into the %s of the init record",
    async (which) => {
      const target = join(bed[which], "state.db");
      await bed.start(toolScript("write", { path: target, content: "x" }));
      const host = bed.host();
      await host.request({ type: "prompt", message: "go" });
      const ask = await host.waitFor(isConfirm);
      expect(String(ask.message)).toContain(`→ ${target} (protected path)`);
      host.send({ type: "extension_ui_response", id: ask.id, confirmed: false });
      expect((await host.waitFor((r) => r.type === "tool_execution_end")).isError).toBe(true);
      expect(existsSync(target)).toBe(false);
    },
  );

  it("keeps the previous rules, and says so, when a policy update is invalid", async () => {
    await bed.start(bashScript("echo still-asked"));
    const host = bed.host();
    host.send({ type: "policy_update", rules: { bogus: true } });
    const report = await host.waitFor((r) => r.type === "extension_error");
    expect(report).toEqual({
      type: "extension_error",
      extensionPath: "<inline:pap-policy>",
      event: "policy_update",
      error: "invalid policy rules: the previous rules stay in force",
    });
    await host.request({ type: "prompt", message: "go" });
    await host.waitFor(isConfirm);
  });

  it("accepts a valid policy update without a report", async () => {
    await bed.start({ steps: [{ text: "hi" }] });
    const host = bed.host();
    host.send({
      type: "policy_update",
      rules: { profile: "interactive", approvalMode: "auto-accept-edits" },
    });
    await host.request({ type: "get_state" });
    expect(host.records.some((r) => r.type === "extension_error")).toBe(false);
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

  it("cancels the dialog whose answer is malformed, which denies the call", async () => {
    await bed.start(bashScript("echo never"));
    const host = bed.host();
    await host.request({ type: "prompt", message: "go" });
    const ask = await host.waitFor(isConfirm);
    host.send({ type: "extension_ui_response", id: ask.id, confirmed: "yes" });
    expect(await host.waitFor((r) => r.type === "extension_ui_closed")).toEqual({
      type: "extension_ui_closed",
      id: ask.id,
    });
    const end = await host.waitFor((r) => r.type === "tool_execution_end");
    expect(end.isError).toBe(true);
    expect(toolText(end)).toContain("Denied by the user.");
  });
});

describe("pi-host worker: lifetime", () => {
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
    host.send({ type: "extension_ui_response", id: (await host.waitFor(isConfirm)).id, confirmed: true });
    await vi.waitFor(() => expect(running()).toBe(true));
    host.send({ type: "shutdown", graceMs: 100 });
    expect(await host.exited).toBe(0);
    await vi.waitFor(() => expect(running()).toBe(false));
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

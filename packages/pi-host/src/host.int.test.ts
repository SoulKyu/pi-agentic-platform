import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProjectTrustStore, VERSION } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bashScript,
  createHostBed,
  isApproval,
  isCallAudit,
  textOf,
  toolScript,
  toolText,
} from "./testing/host-bed.ts";

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
    // Nothing the agent started runs yet; the bed forks the worker detached, so it leads its group and the count is real.
    expect(health.descendants).toBe(0);
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
    expect(host.stderr()).toContain("invalid policy rules (fields: policy");
    expect(host.records.some((r) => r.type === "ready")).toBe(false);
  });

  it("names the failing policy path and never its value", async () => {
    const host = bed.launch(
      { steps: [{ text: "hi" }] },
      { policy: { profile: "interactive", approvalMode: "SECRET-VALUE" } },
    );
    expect(await host.exited).toBe(70);
    expect(host.stderr()).toContain("policy.approvalMode");
    expect(host.stderr()).not.toContain("SECRET-VALUE");
  });

  it.each([
    ["has no pap data directory", { papHome: undefined }, "papHome"],
    ["has a relative pap data directory", { papHome: "pap" }, "papHome"],
    ["has a relative session directory", { cwd: "work" }, "cwd"],
    ["has no umask", { umask: undefined }, "umask"],
    ["has a umask out of range", { umask: 0o1000 }, "umask"],
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

  it("refuses a provider script unless the worker environment allows a test provider", async () => {
    const host = bed.launch({ steps: [{ text: "hi" }] }, { env: { PAP_TEST_PROVIDER: undefined } });
    expect(await host.exited).toBe(70);
    expect(host.stderr()).toContain("PAP_TEST_PROVIDER=1");
    expect(host.records.some((r) => r.type === "ready")).toBe(false);
  });

  it("exits 70 when more than 128 records arrive before ready", async () => {
    const host = bed.launch({ steps: [{ text: "hi" }] });
    for (let i = 0; i <= 128; i++) host.send({ type: "get_state", id: `q${i}` });
    expect(await host.exited).toBe(70);
    expect(host.stderr()).toContain("more than 128 records");
    expect(host.records.some((r) => r.type === "ready")).toBe(false);
  });

  it("answers all of 128 records that arrive before ready", async () => {
    const host = bed.launch({ steps: [{ text: "hi" }] });
    for (let i = 0; i < 128; i++) host.send({ type: "get_state", id: `q${i}` });
    const ready = await host.waitFor((r) => r.type === "ready");
    await host.waitFor((r) => r.type === "response" && r.id === "q127");
    const answers = host.records.filter((r) => r.type === "response");
    expect(answers.map((r) => r.id)).toEqual(Array.from({ length: 128 }, (_unused, i) => `q${i}`));
    expect(host.records.indexOf(ready)).toBeLessThan(host.records.indexOf(answers[0] as never));
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
    const text = "Hello there, world. ".repeat(6);
    await bed.start({ steps: [{ text }] });
    const host = bed.host();
    await host.request({ type: "prompt", message: "go" });
    await host.waitFor((r) => r.type === "agent_settled");
    const deltas = host.records.filter(
      (r) =>
        r.type === "message_update" && (r.assistantMessageEvent as { type: string }).type === "text_delta",
    );
    // The delta gate holds back only a tail that starts a known value (W5-R60), so a plain text streams in many pieces.
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.map((r) => (r.assistantMessageEvent as { delta: string }).delta).join("")).toBe(text);
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
    const ask = await host.waitFor(isApproval);
    host.send({ type: "approval_response", id: ask.id, answer: "once" });
    await host.waitFor((r) => r.type === "tool_execution_start");
    expect(await host.request({ type: "abort" })).toMatchObject({ success: true });
    expect(await host.waitFor((r) => r.type === "agent_settled")).toMatchObject({ aborted: true });
  });
});

describe("pi-host worker: policy", () => {
  it("sends the session entry before ready, with the tools the model can call (M5R15)", async () => {
    await bed.start({ steps: [{ text: "hi" }] });
    const records = bed.host().records;
    const first = records.findIndex((r) => r.type === "audit");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(records.findIndex((r) => r.type === "ready"));
    const entry = records[first]?.entry as { tools: string[] };
    expect(entry).toMatchObject({
      kind: "session",
      stages: [
        { stage: "00", outcome: "pass" },
        { stage: "05", outcome: "skip", reason: "no sandbox profile for interactive sessions" },
      ],
      mode: "auto-accept-edits",
      toolsTruncated: false,
    });
    expect(entry.tools).toContain("read");
    expect(entry.tools).toContain("bash");
  });

  it("asks before bash and runs it once approved", async () => {
    await bed.start(bashScript("echo pap-ok"));
    const host = bed.host();
    await host.request({ type: "prompt", message: "go" });
    const ask = await host.waitFor(isApproval);
    expect(String(ask.message)).toContain("echo pap-ok");
    host.send({ type: "approval_response", id: ask.id, answer: "once" });
    const end = await host.waitFor((r) => r.type === "tool_execution_end");
    expect(end.isError).toBe(false);
    expect(toolText(end)).toContain("pap-ok");
    expect(host.records.filter(isCallAudit)).toEqual([
      {
        type: "audit",
        entry: expect.objectContaining({
          kind: "call",
          toolCallId: "call-1",
          tool: "bash",
          category: "exec",
          decision: "approved",
          reason: "answer: once",
        }),
      },
    ]);
  });

  it("blocks a denied call and returns the reason to the model", async () => {
    await bed.start(bashScript("echo nope"));
    const host = bed.host();
    await host.request({ type: "prompt", message: "go" });
    const ask = await host.waitFor(isApproval);
    host.send({ type: "approval_response", id: ask.id, answer: "deny" });
    const end = await host.waitFor((r) => r.type === "tool_execution_end");
    expect(end.isError).toBe(true);
    expect(toolText(end)).toContain("Denied by the user.");
    expect(host.records.find(isCallAudit)).toMatchObject({ entry: { decision: "denied" } });
  });

  it("writes inside the session directory without asking", async () => {
    await bed.start(toolScript("write", { path: "note.txt", content: "hello" }));
    const host = bed.host();
    await host.request({ type: "prompt", message: "go" });
    expect((await host.waitFor((r) => r.type === "tool_execution_end")).isError).toBe(false);
    expect(readFileSync(join(bed.cwd, "note.txt"), "utf8")).toBe("hello");
    expect(host.records.some(isApproval)).toBe(false);
    expect(host.records.find(isCallAudit)).toMatchObject({
      entry: { category: "edit", decision: "allow" },
    });
  });

  // The daemon runs under umask 077 for its own files and sends the umask it was started with: the files a tool
  // creates in a user's project get that user's usual modes, not the daemon's (R114).
  it.each([
    { daemonMask: 0o077, initMask: 0o022, file: 0o644, directory: 0o755 },
    { daemonMask: 0o022, initMask: 0o077, file: 0o600, directory: 0o700 },
  ])("runs its tools under the umask of the init record, not the one it inherited: %j", async (masks) => {
    const inherited = process.umask(masks.daemonMask);
    try {
      await bed.start(toolScript("write", { path: "made/note.txt", content: "hello" }), {
        init: { umask: masks.initMask },
      });
    } finally {
      process.umask(inherited);
    }
    const host = bed.host();
    await host.request({ type: "prompt", message: "go" });
    expect((await host.waitFor((r) => r.type === "tool_execution_end")).isError).toBe(false);
    expect(statSync(join(bed.cwd, "made", "note.txt")).mode & 0o777).toBe(masks.file);
    expect(statSync(join(bed.cwd, "made")).mode & 0o777).toBe(masks.directory);
  });

  it.each(["agentDir", "papHome"] as const)(
    "asks before a write into the %s of the init record",
    async (which) => {
      const target = join(bed[which], "state.db");
      await bed.start(toolScript("write", { path: target, content: "x" }));
      const host = bed.host();
      await host.request({ type: "prompt", message: "go" });
      const ask = await host.waitFor(isApproval);
      expect(String(ask.message)).toContain(`→ ${target} (protected path)`);
      host.send({ type: "approval_response", id: ask.id, answer: "deny" });
      expect((await host.waitFor((r) => r.type === "tool_execution_end")).isError).toBe(true);
      expect(existsSync(target)).toBe(false);
    },
  );

  it("clips what a project extension says when it fails, at the worker", async () => {
    new ProjectTrustStore(bed.agentDir).set(bed.cwd, true);
    mkdirSync(join(bed.cwd, ".pi", "extensions"), { recursive: true });
    writeFileSync(
      join(bed.cwd, ".pi", "extensions", "thrower.js"),
      'export default function (pi) { pi.on("agent_start", () => { throw new Error("x".repeat(5000)); }); }\n',
    );
    await bed.start({ steps: [{ text: "hi" }] });
    const host = bed.host();
    await host.request({ type: "prompt", message: "go" });
    const report = await host.waitFor((r) => r.type === "extension_error" && r.event === "agent_start");
    expect(String(report.extensionPath)).toMatch(/thrower\.js$/);
    expect(String(report.error)).toHaveLength(2000);
    expect(String(report.error).startsWith("x")).toBe(true);
  });

  it("blocks every call after a malformed policy update, and says so (M5R11)", async () => {
    await bed.start(bashScript("echo never-runs"));
    const host = bed.host();
    host.send({ type: "policy_update", rules: { bogus: true } });
    const report = await host.waitFor((r) => r.type === "extension_error");
    expect(report).toEqual({
      type: "extension_error",
      extensionPath: "<inline:pap-policy>",
      event: "policy_update",
      error: "invalid policy rules: every call is blocked until the next valid update",
    });
    await host.request({ type: "prompt", message: "go" });
    const end = await host.waitFor((r) => r.type === "tool_execution_end");
    expect(end.isError).toBe(true);
    expect(toolText(end)).toContain("could not evaluate this call");
    expect(toolText(end)).not.toContain("never-runs");
    expect(host.records.some(isApproval)).toBe(false);
    expect(host.records.find(isCallAudit)).toMatchObject({
      entry: { decision: "block", reason: "no valid policy rules" },
    });
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

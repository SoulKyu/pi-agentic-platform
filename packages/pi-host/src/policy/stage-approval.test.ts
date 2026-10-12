import { mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PolicyRules } from "@pap/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createPipelineBed, interactiveRules } from "../testing/pipeline-bed.ts";
import { grantKey, grantPayload } from "./grant-key.ts";
import { FAIL_CLOSED_REASON, READ_ONLY_REASON } from "./pipeline.ts";
import { MCP_SOURCE } from "./tool-kind.ts";

let bed: Awaited<ReturnType<typeof createPipelineBed>>;
beforeAll(async () => {
  bed = await createPipelineBed();
  await mkdir(join(bed.papHome, "secrets"), { recursive: true });
  await writeFile(join(bed.papHome, "secrets", "device.key"), "k");
  await writeFile(join(bed.agentDir, "auth.json"), "{}");
  await symlink(join(bed.papHome, "secrets"), join(bed.cwd, "link"), "dir");
});
afterAll(() => bed.dispose());
afterEach(() => vi.restoreAllMocks());

const withMode = (approvalMode: PolicyRules["approvalMode"], extra: Partial<PolicyRules> = {}) => ({
  rules: () => ({ ...interactiveRules, approvalMode, ...extra }),
});
const DENY_ONCE = ["deny", "once"];

describe("stage 03: the four modes", () => {
  it("full access runs a command without a card and still asks for a hook write and a secret read", async () => {
    const h = bed.harness(withMode("full-access"));
    expect(await h.run("bash", { command: "make" })).toBeUndefined();
    expect(h.asks).toEqual([]);
    await h.run("write", { path: join(bed.cwd, ".git", "hooks", "pre-commit"), content: "x" });
    await h.run("read", { path: join(bed.papHome, "secrets", "device.key") });
    expect(h.asks.map((ask) => ask.answers)).toEqual([DENY_ONCE, DENY_ONCE]);
  });

  it("full access asks for a write outside the session folder and for the Pi credentials", async () => {
    const h = bed.harness(withMode("full-access"));
    await h.run("write", { path: join(bed.outside, "x.txt"), content: "x" });
    await h.run("read", { path: join(bed.agentDir, "auth.json") });
    expect(h.asks.map((ask) => ask.answers)).toEqual([DENY_ONCE, DENY_ONCE]);
    expect(await h.run("write", { path: "src/a.ts", content: "x" })).toBeUndefined();
    expect(h.asks).toHaveLength(2);
  });

  it("read-only blocks writes, commands and unknown tools without a card, and reads normally", async () => {
    const h = bed.harness(withMode("read-only"));
    for (const [tool, input] of [
      ["write", { path: "a", content: "x" }],
      ["bash", { command: "ls" }],
      ["mystery", {}],
    ] as const)
      expect(await h.run(tool, input)).toEqual({
        block: true,
        reason: "pap-policy blocked this call: the session is read-only.",
      });
    expect(await h.run("read", { path: "src/a.ts" })).toBeUndefined();
    expect(h.asks).toEqual([]);
    expect(h.entries.at(-1)).toMatchObject({ decision: "allow" });
  });

  it("read-only blocks a protected read instead of asking, with the read-only sentence", async () => {
    const h = bed.harness(withMode("read-only"));
    expect(await h.run("read", { path: "link/device.key" })).toEqual({
      block: true,
      reason: READ_ONLY_REASON,
    });
    expect(h.asks).toEqual([]);
    expect(h.entries.at(-1)?.stages.find((s) => s.stage === "03")).toMatchObject({
      outcome: "block",
      reason: "protected path",
    });
  });

  it("auto-accept edits lets an edit in the folder through and asks for a command, with four answers", async () => {
    const h = bed.harness();
    expect(await h.run("write", { path: "src/a.ts", content: "x" })).toBeUndefined();
    expect(h.asks).toEqual([]);
    await h.run("bash", { command: "make" });
    expect(h.asks[0]?.answers).toEqual(["deny", "session", "always", "once"]);
  });

  it("supervised asks for an edit in the folder, and an always rule for that exact edit lets it through", async () => {
    const input = { path: join(bed.cwd, "src", "a.ts"), content: "x" };
    const key = grantKey("write", grantPayload(input, false));
    const asked = bed.harness(withMode("supervised"));
    await asked.run("write", input);
    expect(asked.asks[0]?.answers).toEqual(["deny", "session", "always", "once"]);
    const granted = bed.harness(withMode("supervised", { alwaysAllow: [{ tool: "write", key }] }));
    expect(await granted.run("write", input)).toBeUndefined();
    expect(granted.asks).toEqual([]);
  });

  it("an always rule never lets a protected write through, in any mode", async () => {
    const input = { path: join(bed.cwd, ".git", "hooks", "pre-commit"), content: "x" };
    const alwaysAllow = [{ tool: "write", key: grantKey("write", grantPayload(input, false)) }];
    for (const mode of ["supervised", "auto-accept-edits", "full-access"] as const) {
      const h = bed.harness(withMode(mode, { alwaysAllow }));
      await h.run("write", input);
      expect(h.asks.map((ask) => ask.answers)).toEqual([DENY_ONCE]);
    }
  });
});

describe("stage 03: taint (M5R27)", () => {
  it("a tainted session asks for a command an always rule covers, and marks the question tainted", async () => {
    const key = grantKey("bash", grantPayload({ command: "echo exfil" }, true));
    const h = bed.harness({
      taint: true,
      ...withMode("full-access", { alwaysAllow: [{ tool: "bash", key }] }),
    });
    await h.run("bash", { command: "echo exfil" });
    expect(h.asks).toEqual([expect.objectContaining({ answers: DENY_ONCE, tainted: true })]);
    expect(h.entries.at(-1)?.stages.find((s) => s.stage === "03")).toMatchObject({
      outcome: "ask",
      reason: "external content",
    });
  });

  it("a session grant does not cover a tainted call either", async () => {
    let tainted = false;
    const h = bed.harness({
      taint: { current: () => tainted },
      answers: [{ answer: "session", closed: false }],
    });
    await h.run("bash", { command: "echo exfil" });
    expect(await h.run("bash", { command: "echo exfil" })).toBeUndefined();
    expect(h.asks).toHaveLength(1);
    tainted = true;
    await h.run("bash", { command: "echo exfil" });
    expect(h.asks).toHaveLength(2);
    expect(h.asks[1]?.answers).toEqual(DENY_ONCE);
  });

  it("an MCP read-only tool asks in a tainted session, Deny / Allow once, even under an always rule (MQ1)", async () => {
    const tools = { mcp__fetch__fetch: { path: MCP_SOURCE, readOnlyHint: true } };
    const input = { url: "https://example.com/?d=x" };
    const key = grantKey("mcp__fetch__fetch", grantPayload(input, false));
    const clean = bed.harness({ tools, ...withMode("full-access") });
    expect(await clean.run("mcp__fetch__fetch", input)).toBeUndefined();
    for (const approvalMode of ["supervised", "auto-accept-edits", "full-access"] as const) {
      const h = bed.harness({
        tools,
        taint: true,
        ...withMode(approvalMode, { alwaysAllow: [{ tool: "mcp__fetch__fetch", key }] }),
      });
      await h.run("mcp__fetch__fetch", input);
      expect(h.asks).toEqual([expect.objectContaining({ answers: DENY_ONCE, tainted: true })]);
    }
    const ro = bed.harness({ tools, taint: true, ...withMode("read-only") });
    expect(await ro.run("mcp__fetch__fetch", input)).toEqual({ block: true, reason: READ_ONLY_REASON });
    // Nested in a codemode script: judged like any call (M5R14).
    const nested = bed.harness({ tools, taint: true });
    await nested.run("mcp__fetch__fetch", input, "cm/1", "cm");
    expect(nested.asks).toEqual([expect.objectContaining({ tainted: true })]);
  });

  it("a built-in read and an edit in the folder are unchanged by taint", async () => {
    const h = bed.harness({ taint: true });
    expect(await h.run("read", { path: "src/a.ts" })).toBeUndefined();
    expect(await h.run("write", { path: "src/a.ts", content: "x" })).toBeUndefined();
    expect(h.asks).toEqual([]);
  });

  it("taint that turns true while a question is open: the answer applies, the next command asks as tainted", async () => {
    let tainted = false;
    const h = bed.harness({
      ...withMode("supervised"),
      taint: { current: () => tainted },
      ask: async () => {
        tainted = true;
        return { answer: "once", closed: false };
      },
    });
    expect(await h.run("write", { path: "src/a.ts", content: "x" })).toBeUndefined();
    await h.run("bash", { command: "make" });
    expect(h.asks.map((ask) => ask.tainted)).toEqual([false, true]);
    expect(h.asks[1]?.answers).toEqual(DENY_ONCE);
  });
});

describe("stage 03: reads of pap's own files (M5R29)", () => {
  it("asks for a grep over a parent of pap's home, and lets an ls of it through", async () => {
    const h = bed.harness();
    await h.run("grep", { pattern: "token", path: dirname(bed.papHome) });
    expect(h.asks).toHaveLength(1);
    expect(h.asks[0]?.message).toContain("(searches pap's data directory)");
    expect(await h.run("ls", { path: dirname(bed.papHome) })).toBeUndefined();
  });

  it("shows where a protected read lands, as for a write", async () => {
    const h = bed.harness();
    await h.run("read", { path: "link/device.key" });
    expect(h.asks[0]?.message).toContain(`→ ${join(bed.papHome, "secrets", "device.key")} (protected path)`);
    expect(h.asks[0]?.answers).toEqual(DENY_ONCE);
  });

  it("an extension tool named read is not judged as the built-in read", async () => {
    const h = bed.harness({ tools: { read: { path: "/ext/read.js" } } });
    await h.run("read", { path: join(bed.papHome, "secrets", "device.key") });
    expect(h.asks[0]?.answers).toEqual(["deny", "session", "once"]);
  });
});

describe("stage 03: hostile inputs", () => {
  it("a symlink into pap's home: reading through it asks, and so does writing through it", async () => {
    const h = bed.harness();
    await h.run("read", { path: "link/device.key" });
    await h.run("write", { path: "link/new.key", content: "x" });
    expect(h.asks.map((ask) => ask.answers)).toEqual([DENY_ONCE, DENY_ONCE]);
    expect(h.asks.map((ask) => ask.message.includes("(protected path)"))).toEqual([true, true]);
  });

  it("case spellings of protected names ask", async () => {
    const h = bed.harness();
    for (const path of [".IDEA/x", ".Zed/tasks.json", "Lefthook.yml", "é/.devcontainer/x.json"])
      await h.run("write", { path, content: "x" });
    expect(h.asks.map((ask) => ask.answers)).toEqual([DENY_ONCE, DENY_ONCE, DENY_ONCE, DENY_ONCE]);
  });

  it("a blank-spelled path shows the escaped name, so the card names the file", async () => {
    const h = bed.harness();
    await h.run("write", { path: "../ out.txt", content: "x" });
    expect(h.asks[0]?.message).toContain(`→ ${bed.base}/\\u{1680}out.txt (outside the session directory)`);
  });

  it("an unknown mode in the rules blocks with the evaluation error", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const yolo = { ...interactiveRules, approvalMode: "yolo" } as unknown as PolicyRules;
    const h = bed.harness({ rules: () => yolo });
    expect(await h.run("read", { path: "src/a.ts" })).toEqual({ block: true, reason: FAIL_CLOSED_REASON });
    expect(h.entries.at(-1)).toMatchObject({ decision: "block", reason: "evaluation error" });
    expect(stderr).toHaveBeenCalledWith("pi-host: policy evaluation failed (TypeError)\n");
  });
});

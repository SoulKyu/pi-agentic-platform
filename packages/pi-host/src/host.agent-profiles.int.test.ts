import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PolicyRules } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ForkedHost } from "./testing/fork-host.ts";
import { createHostBed, isApproval, isCallAudit, toolScript, toolText } from "./testing/host-bed.ts";

const TASK = "0a1b2c3d-0000-4000-8000-0123456789ab";
const WORKER = { timeoutMs: 30_000 };
let bed: ReturnType<typeof createHostBed>;
let home: string;
let other: string;
let scratch: string;

beforeEach(() => {
  bed = createHostBed();
  const agents = join(bed.papHome, "agents");
  home = join(agents, "atlas-1a2b");
  other = join(agents, "other-0000");
  scratch = join(agents, ".runs", "atlas-1a2b", TASK);
  for (const dir of [home, other, scratch]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(home, "a.txt"), "HOME NOTES");
  writeFileSync(join(home, "MEMORY.md"), "old note");
  writeFileSync(join(other, "MEMORY.md"), "other notes");
  writeFileSync(join(scratch, "out.txt"), "RUN OUTPUT");
  writeFileSync(join(bed.root, "outside.txt"), "OUTSIDE");
});
afterEach(() => bed.dispose());

// An extension tool pap cannot classify: `unknown`, blocked in an isolated task whatever the list says.
const LOOKUP_EXTENSION = `export default function (pi) {
  pi.registerTool({
    name: "lookup",
    label: "lookup",
    description: "looks something up",
    parameters: { type: "object", properties: { q: { type: "string" } }, additionalProperties: true },
    execute: async () => ({ content: [{ type: "text", text: "found" }], details: {} }),
  });
}
`;
const sandbox = { required: true, network: false };
const isolated = () =>
  PolicyRules.parse({
    profile: "isolated-task",
    approvalMode: "auto-accept-edits",
    agentHome: home,
    agentScratch: scratch,
    sandbox,
    readOnlyCommands: false,
  });
const thread = () =>
  PolicyRules.parse({
    profile: "agent-thread",
    approvalMode: "auto-accept-edits",
    agentHome: home,
    sandbox,
    readOnlyCommands: false,
  });

/** One call in a worker whose folder is `cwd`; resolves with the host once the call has ended or a question is open. */
async function callIn(
  cwd: string,
  policy: PolicyRules,
  name: string,
  args: Record<string, string | number | boolean>,
) {
  await bed.start(toolScript(name, args), { policy, init: { cwd } });
  const host = bed.host();
  await host.request({ type: "prompt", message: "go" });
  return host;
}
const ended = (host: ForkedHost) => host.waitFor((r) => r.type === "tool_execution_end", WORKER);
const blockedBy = (end: { isError?: unknown } & Record<string, unknown>) => {
  expect(end.isError).toBe(true);
  expect(toolText(end as never)).toContain("pap-policy blocked");
};

describe("pi-host worker: the isolated-task profile (M11R32)", () => {
  it("reads the agent home and writes the scratch folder unasked", async () => {
    const reading = await callIn(scratch, isolated(), "read", { path: join(home, "a.txt") });
    const end = await ended(reading);
    expect(end.isError).toBe(false);
    expect(toolText(end)).toContain("HOME NOTES");
    expect(reading.records.some(isApproval)).toBe(false);
  });

  it("writes the scratch folder unasked", async () => {
    const host = await callIn(scratch, isolated(), "write", { path: "out2.txt", content: "made" });
    expect((await ended(host)).isError).toBe(false);
    expect(readFileSync(join(scratch, "out2.txt"), "utf8")).toBe("made");
    expect(host.records.some(isApproval)).toBe(false);
  });

  it("blocks a write of the home's MEMORY.md", async () => {
    const host = await callIn(scratch, isolated(), "write", {
      path: join(home, "MEMORY.md"),
      content: "pwned",
    });
    blockedBy(await ended(host));
    expect(readFileSync(join(home, "MEMORY.md"), "utf8")).toBe("old note");
    expect(host.records.some(isApproval)).toBe(false);
  });

  it("blocks a read outside the home and the scratch folder", async () => {
    const host = await callIn(scratch, isolated(), "read", { path: join(bed.root, "outside.txt") });
    const end = await ended(host);
    blockedBy(end);
    expect(toolText(end)).not.toContain("OUTSIDE");
  });

  it("blocks Pi's bash: it is not the sandboxed shell", async () => {
    const host = await callIn(scratch, isolated(), "bash", { command: "echo hi" });
    blockedBy(await ended(host));
    expect(host.records.find(isCallAudit)).toMatchObject({ entry: { decision: "block", category: "exec" } });
  });

  it("blocks a tool of unknown kind: it neither runs nor asks", async () => {
    await bed.start(toolScript("lookup", { q: "x" }), {
      policy: isolated(),
      init: { cwd: scratch },
      agentFiles: { "extensions/lookup.js": LOOKUP_EXTENSION },
    });
    const host = bed.host();
    await host.request({ type: "prompt", message: "go" });
    blockedBy(await ended(host));
    expect(host.records.some(isApproval)).toBe(false);
    expect(host.records.find(isCallAudit)).toMatchObject({ entry: { decision: "block" } });
  });
});

describe("pi-host worker: the agent-thread profile (M11R28, M11R31)", () => {
  it("edits MEMORY.md in the home unasked in auto-accept-edits", async () => {
    const host = await callIn(home, thread(), "write", { path: "MEMORY.md", content: "new note" });
    expect((await ended(host)).isError).toBe(false);
    expect(readFileSync(join(home, "MEMORY.md"), "utf8")).toBe("new note");
    expect(host.records.some(isApproval)).toBe(false);
  });

  it("runs an edit call of the home's MEMORY.md without a question", async () => {
    const host = await callIn(home, thread(), "edit", { path: "MEMORY.md", oldText: "old", newText: "new" });
    await ended(host);
    expect(host.records.some(isApproval)).toBe(false);
    expect(host.records.find(isCallAudit)).toMatchObject({ entry: { category: "edit", decision: "allow" } });
  });

  it("blocks Pi's bash in a sandboxed agent, full access included (M11R34)", async () => {
    const full = PolicyRules.parse({ ...thread(), approvalMode: "full-access" });
    const host = await callIn(home, full, "bash", { command: `echo ran > ${join(home, "ran.txt")}` });
    blockedBy(await ended(host));
    expect(existsSync(join(home, "ran.txt"))).toBe(false);
    expect(host.records.find(isCallAudit)).toMatchObject({
      entry: { decision: "block", reason: "unsandboxed shell in a sandboxed agent" },
    });
  });

  it("asks for another agent's MEMORY.md", async () => {
    const host = await callIn(home, thread(), "write", { path: join(other, "MEMORY.md"), content: "x" });
    const ask = await host.waitFor(isApproval, WORKER);
    expect(String(ask.message)).toContain("(protected path)");
    host.send({ type: "approval_response", id: ask.id, answer: "deny" });
    await ended(host);
    expect(readFileSync(join(other, "MEMORY.md"), "utf8")).toBe("other notes");
  });

  it("reads its runs folder unasked, fenced, and the session is tainted", async () => {
    const host = await callIn(home, thread(), "read", { path: join(scratch, "out.txt") });
    const end = await ended(host);
    expect(end.isError).toBe(false);
    expect(host.records.some(isApproval)).toBe(false);
    expect(toolText(end)).toContain('<untrusted source=\\"agent-run\\"');
    expect(toolText(end)).toContain("RUN OUTPUT");
    expect(host.records.filter((r) => r.type === "taint")).toHaveLength(1);
  });

  it("does not fence a read of its own notes", async () => {
    const host = await callIn(home, thread(), "read", { path: "MEMORY.md" });
    const end = await ended(host);
    expect(toolText(end)).not.toContain("untrusted");
    expect(host.records.filter((r) => r.type === "taint")).toHaveLength(0);
  });
});

describe("pi-host worker: a plain session in an agent home owns nothing there (RT-12)", () => {
  it("asks for the home's MEMORY.md", async () => {
    const plain = PolicyRules.parse({
      profile: "interactive",
      approvalMode: "auto-accept-edits",
      readOnlyCommands: false,
    });
    const host = await callIn(home, plain, "write", { path: "MEMORY.md", content: "x" });
    const ask = await host.waitFor(isApproval, WORKER);
    expect(String(ask.message)).toContain("(protected path)");
    host.send({ type: "approval_response", id: ask.id, answer: "deny" });
    await ended(host);
    expect(existsSync(join(home, "MEMORY.md"))).toBe(true);
    expect(readFileSync(join(home, "MEMORY.md"), "utf8")).toBe("old note");
  });
});

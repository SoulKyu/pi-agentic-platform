import { PLATFORM_OPS, PolicyRules } from "@pap/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPipelineBed } from "../testing/pipeline-bed.ts";
import { platformPlan } from "./stage-approval.ts";
import { classifyTool, PLATFORM_SOURCE } from "./tool-kind.ts";

let bed: Awaited<ReturnType<typeof createPipelineBed>>;
beforeAll(async () => {
  bed = await createPipelineBed();
});
afterAll(() => bed.dispose());

const rulesIn = (approvalMode: PolicyRules["approvalMode"]) =>
  PolicyRules.parse({ profile: "interactive", approvalMode });
const tools = Object.fromEntries(
  Object.values(PLATFORM_OPS).map((spec) => [spec.tool, { path: PLATFORM_SOURCE }]),
);
const DELEGATE = { agent: "Scout", task: "push to main" };

describe("classification of a platform tool (M11R13)", () => {
  it("is a read that taints nothing and carries its op, when the source and the name are the table's", () => {
    expect(classifyTool("agent_delegate", { path: PLATFORM_SOURCE })).toEqual({
      category: "read",
      external: false,
      urlBearing: false,
      mcp: false,
      builtin: false,
      platform: { op: "agent.delegate", whenTainted: "ask" },
    });
    expect(classifyTool("lane_note", { path: PLATFORM_SOURCE }).platform).toEqual({
      op: "lane.note",
      whenTainted: "run",
    });
  });

  it("is unknown for another name from the platform source (fail closed)", () => {
    const kind = classifyTool("agent_exfiltrate", { path: PLATFORM_SOURCE });
    expect(kind).toMatchObject({ category: "unknown", external: true, builtin: false });
    expect(kind.platform).toBeUndefined();
  });

  it("is unknown for a platform tool name from any other source", () => {
    for (const path of ["/ext/evil.js", "builtin:mcp", "builtin:agent_delegate", "<inline:other>"]) {
      const kind = classifyTool("agent_delegate", { path });
      expect(kind.category === "unknown" || kind.mcp).toBe(true);
      expect(kind.platform).toBeUndefined();
    }
    expect(classifyTool("agent_delegate", undefined).platform).toBeUndefined();
  });

  it("does not take a prototype name for a tool of the table", () => {
    expect(classifyTool("constructor", { path: PLATFORM_SOURCE }).platform).toBeUndefined();
    expect(classifyTool("__proto__", { path: PLATFORM_SOURCE }).platform).toBeUndefined();
  });
});

describe("the tainted ask (M11R14)", () => {
  it("asks Deny / Allow once, without a grant, for agent_delegate after external content, and names the isolated run", async () => {
    const h = bed.harness({ rules: () => rulesIn("auto-accept-edits"), tools, taint: true });
    expect(await h.run("agent_delegate", DELEGATE)).toBeUndefined();
    expect(h.asks).toHaveLength(1);
    expect(h.asks[0]).toMatchObject({
      tool: "agent_delegate",
      toolCallId: "c1",
      answers: ["deny", "once"],
      tainted: true,
      title: "pap: agent_delegate after external content",
    });
    expect(h.asks[0]?.message).toContain(
      "This session read external content. agent_delegate can carry it into another agent's work.",
    );
    expect(h.asks[0]?.message).toContain(
      "If you allow it, the other agent runs it as an isolated task (read tools, its home read-only), not in its thread.",
    );
    expect(h.asks[0]?.message).toContain("push to main");
    expect(h.entries.at(-1)).toMatchObject({ decision: "approved" });
  });

  it("is never skipped by a session grant: it asks again for the same call", async () => {
    const h = bed.harness({
      rules: () => rulesIn("full-access"),
      tools,
      taint: true,
      answers: [
        { answer: "session", closed: false },
        { answer: "once", closed: false },
      ],
    });
    await h.run("agent_delegate", DELEGATE, "c1");
    await h.run("agent_delegate", DELEGATE, "c2");
    expect(h.asks).toHaveLength(2);
    expect(h.asks[0]?.answers).toEqual(["deny", "once"]);
  });

  it("blocks the call when the owner denies", async () => {
    const h = bed.harness({
      rules: () => rulesIn("full-access"),
      tools,
      taint: true,
      answers: [{ answer: "deny", closed: false }],
    });
    expect(await h.run("agent_delegate", DELEGATE)).toMatchObject({ block: true });
  });

  it("asks for agent_remind without the isolated-run line", async () => {
    const h = bed.harness({ rules: () => rulesIn("supervised"), tools, taint: true });
    await h.run("agent_remind", { when: "in 2 hours", note: "check" });
    expect(h.asks).toHaveLength(1);
    expect(h.asks[0]).toMatchObject({ title: "pap: agent_remind after external content" });
    expect(h.asks[0]?.message).toContain("agent_remind can carry it into another agent's work.");
    expect(h.asks[0]?.message).not.toContain("isolated task");
  });

  it("asks in read-only mode too: the op decides nothing on the filesystem", async () => {
    const h = bed.harness({ rules: () => rulesIn("read-only"), tools, taint: true });
    await h.run("agent_delegate", DELEGATE);
    expect(h.asks).toHaveLength(1);
  });

  it("blocks without asking where nobody can be asked", async () => {
    const h = bed.harness({ rules: () => rulesIn("full-access"), tools, taint: true, hasUI: false });
    expect(await h.run("agent_delegate", DELEGATE)).toMatchObject({ block: true });
    expect(h.asks).toHaveLength(0);
  });
});

describe("what runs unasked", () => {
  it("allows an untainted agent_delegate without a card, in every mode", async () => {
    for (const mode of ["read-only", "supervised", "auto-accept-edits", "full-access"] as const) {
      const h = bed.harness({ rules: () => rulesIn(mode), tools });
      expect(await h.run("agent_delegate", DELEGATE)).toBeUndefined();
      expect(h.asks).toHaveLength(0);
      expect(h.entries.at(-1)).toMatchObject({ decision: "allow", category: "read" });
    }
  });

  it("allows a tainted agent_notify, lane_note, agent_approve, secret_request and subagent (they run when tainted)", async () => {
    const inputs: Record<string, unknown> = {
      agent_notify: { text: "hi" },
      agent_approve: { title: "t" },
      lane_note: { note: "n" },
      secret_request: { name: "GH_TOKEN", reason: "r" },
      subagent: { task: "t" },
    };
    for (const [tool, input] of Object.entries(inputs)) {
      const h = bed.harness({ rules: () => rulesIn("auto-accept-edits"), tools, taint: true });
      expect(await h.run(tool, input)).toBeUndefined();
      expect(h.asks).toHaveLength(0);
    }
  });

  it("allows an untainted agent_notify in read-only mode", async () => {
    const h = bed.harness({ rules: () => rulesIn("read-only"), tools });
    expect(await h.run("agent_notify", { text: "hi" })).toBeUndefined();
    expect(h.asks).toHaveLength(0);
  });

  it("leaves the read-only preset's question out: a platform tool is a read", async () => {
    const rules = PolicyRules.parse({
      profile: "interactive",
      approvalMode: "full-access",
      readOnlyPreset: true,
    });
    const h = bed.harness({ rules: () => rules, tools });
    expect(await h.run("agent_notify", { text: "hi" })).toBeUndefined();
    expect(h.asks).toHaveLength(0);
  });
});

describe("a spoofed name", () => {
  it("takes the unknown-tool path when another source registers agent_delegate: asks in auto-accept-edits", async () => {
    const h = bed.harness({
      rules: () => rulesIn("auto-accept-edits"),
      tools: { agent_delegate: { path: "/ext/evil.js" } },
    });
    await h.run("agent_delegate", DELEGATE);
    expect(h.entries.at(-1)).toMatchObject({ category: "unknown" });
    expect(h.asks).toHaveLength(1);
    expect(h.asks[0]?.title).toBe("Allow this tool?");
  });

  it("blocks it in read-only mode, never the platform path", async () => {
    const h = bed.harness({
      rules: () => rulesIn("read-only"),
      tools: { agent_delegate: { path: "/ext/evil.js" } },
    });
    expect(await h.run("agent_delegate", DELEGATE)).toMatchObject({ block: true });
    expect(h.asks).toHaveLength(0);
  });

  it("blocks an unknown name from the platform source in read-only mode", async () => {
    const h = bed.harness({
      rules: () => rulesIn("read-only"),
      tools: { agent_exfiltrate: { path: PLATFORM_SOURCE } },
    });
    expect(await h.run("agent_exfiltrate", {})).toMatchObject({ block: true });
  });
});

describe("the refuse branch (no op uses it today)", () => {
  it("blocks a tainted call of an op that refuses, with a model reason that names no content", () => {
    const call = {
      event: { toolCallId: "c1", toolName: "agent_delegate", input: DELEGATE },
      kind: {
        ...classifyTool("agent_delegate", { path: PLATFORM_SOURCE }),
        platform: { op: "agent.delegate", whenTainted: "refuse" },
      },
      tainted: true,
    } as unknown as Parameters<typeof platformPlan>[0];
    expect(platformPlan(call)).toEqual({
      outcome: "block",
      reason: "This session read external content. agent_delegate can carry it into another agent's work.",
      modelReason: "pap-policy blocked agent_delegate: this session read external content.",
    });
    expect(platformPlan({ ...call, tainted: false })).toEqual({
      outcome: "allow",
      reason: "pap platform call",
    });
  });
});

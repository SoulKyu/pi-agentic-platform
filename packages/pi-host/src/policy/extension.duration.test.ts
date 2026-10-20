import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PolicyAuditEntry } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { idleTaint, interactiveRules, NO_SECRETS } from "../testing/pipeline-bed.ts";
import { createPapPolicyExtension } from "./extension.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

async function setup(
  ask: (advance: (ms: number) => void) => void = () => {},
  answer: "once" | "deny" = "once",
) {
  let now = 1_000;
  const advance = (ms: number): void => void (now += ms);
  const audits: PolicyAuditEntry[] = [];
  const handlers = new Map<string, Handler>();
  const extension = createPapPolicyExtension({
    taint: idleTaint(),
    rules: () => interactiveRules,
    rulesVersion: () => 0,
    audit: (entry) => void audits.push(entry),
    secrets: NO_SECRETS,
    agentDir: "/agent",
    papHome: "/pap",
    ask: async () => {
      ask(advance);
      return { answer, closed: false };
    },
    now: () => now,
  });
  await extension.factory({
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    getAllTools: () => [{ name: "bash", sourceInfo: { path: "builtin:bash" } }],
    getActiveTools: () => [],
  } as unknown as ExtensionAPI);
  const ctx = { hasUI: true, cwd: "/work" };
  return {
    audits,
    advance,
    call: (id: string, toolName: string, input: unknown) =>
      handlers.get("tool_call")?.({ toolCallId: id, toolName, input }, ctx),
    result: (id: string, toolName: string, extra: Record<string, unknown> = {}) =>
      handlers.get("tool_result")?.(
        {
          type: "tool_result",
          toolCallId: id,
          toolName,
          input: {},
          content: [{ type: "text", text: "ok" }],
          ...extra,
        },
        ctx,
      ),
    agentStart: () => handlers.get("agent_start")?.({}, ctx),
  };
}

describe("a result row carries the duration from the moment the call was allowed to run (decision 117, A4)", () => {
  it("measures a shell call with the injected clock and records its exit code", async () => {
    const t = await setup();
    await t.call("c1", "bash", { command: "ls" });
    t.advance(250);
    t.result("c1", "bash", { structuredContent: { exit_code: 3 }, isError: true });
    expect(t.audits.filter((entry) => entry.kind === "result")).toEqual([
      expect.objectContaining({ tool: "bash", exitCode: 3, durationMs: 250 }),
    ]);
  });

  it("starts the clock after the question is answered: the owner's time is not the command's", async () => {
    const t = await setup((advance) => advance(9_000));
    await t.call("c2", "bash", { command: "rm -rf build" });
    t.advance(40);
    t.result("c2", "bash", { structuredContent: { exit_code: 0 } });
    expect(t.audits.find((entry) => entry.kind === "result")).toMatchObject({ durationMs: 40 });
  });

  it("times only a call that runs: the result of a denied call has no duration", async () => {
    const t = await setup(() => {}, "deny");
    expect(await t.call("c5", "bash", { command: "rm -rf build" })).toMatchObject({ block: true });
    t.advance(10);
    t.result("c5", "bash", { structuredContent: { exit_code: 1 }, isError: true });
    expect(t.audits.find((entry) => entry.kind === "result")).not.toHaveProperty("durationMs");
  });

  it("gives a result nobody timed no duration, and forgets a call once its result came", async () => {
    const t = await setup();
    t.result("never-called", "bash", { structuredContent: { exit_code: 0 } });
    await t.call("c3", "bash", { command: "ls" });
    t.result("c3", "bash", { structuredContent: { exit_code: 0 } });
    t.result("c3", "bash", { structuredContent: { exit_code: 0 } });
    const rows = t.audits.filter((entry) => entry.kind === "result");
    expect(rows[0]).not.toHaveProperty("durationMs");
    expect(rows[1]).toHaveProperty("durationMs");
    expect(rows[2]).not.toHaveProperty("durationMs");
  });

  // Past 4 096 calls with no result (MAX_TIMED_CALLS) the whole map is cleared, not one entry: the calls before the
  // 4 097th lose their duration, the 4 097th keeps it.
  it("clears every timed call when 4 096 are waiting for a result, and times the one that crossed the cap", async () => {
    const t = await setup();
    for (let i = 0; i < 4_096; i++) await t.call(`w${i}`, "bash", { command: "ls" });
    await t.call("crossing", "bash", { command: "ls" });
    t.advance(30);
    t.result("w0", "bash", { structuredContent: { exit_code: 0 } });
    t.result("crossing", "bash", { structuredContent: { exit_code: 0 } });
    const rows = t.audits.filter((entry) => entry.kind === "result");
    expect(rows[0]).not.toHaveProperty("durationMs");
    expect(rows[1]).toMatchObject({ durationMs: 30 });
  });

  it("forgets the calls of an earlier run at agent_start", async () => {
    const t = await setup();
    await t.call("c4", "bash", { command: "ls" });
    t.agentStart();
    t.result("c4", "bash", { structuredContent: { exit_code: 0 } });
    expect(t.audits.find((entry) => entry.kind === "result")).not.toHaveProperty("durationMs");
  });
});

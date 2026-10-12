import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { grantKey, grantPayload } from "./policy/grant-key.ts";
import {
  bashScript,
  createHostBed,
  isApproval,
  isCallAudit,
  RULES,
  toolScript,
  toolText,
} from "./testing/host-bed.ts";

let bed: ReturnType<typeof createHostBed>;
beforeEach(() => {
  bed = createHostBed();
});
afterEach(() => bed.dispose());

describe("pi-host worker: approval channel", () => {
  it("asks the policy's question with its own record, and an extension's confirm stays a plain dialog", async () => {
    mkdirSync(join(bed.agentDir, "extensions"), { recursive: true });
    writeFileSync(
      join(bed.agentDir, "extensions", "asker.js"),
      `export default function (pi) { pi.registerCommand("ask", { handler: async (_a, ctx) => { await ctx.ui.confirm("Extension question", "yes?"); } }); }\n`,
    );
    await bed.start(bashScript("echo approved"));
    const host = bed.host();
    host.send({ type: "prompt", id: "p1", message: "/ask" });
    const plain = await host.waitFor((r) => r.type === "extension_ui_request");
    expect(plain.method).toBe("confirm");
    host.send({ type: "extension_ui_response", id: plain.id, confirmed: true });
    host.send({ type: "prompt", id: "p2", message: "go" });
    const ask = await host.waitFor(isApproval);
    expect(ask).toMatchObject({
      category: "exec",
      tool: "bash",
      answers: ["deny", "session", "always", "once"],
    });
    host.send({ type: "approval_response", id: ask.id, answer: "once" });
    await host.waitFor((r) => r.type === "tool_execution_end" && r.isError === false);
  });

  it("blocks the call when the daemon answers that it could not show the card", async () => {
    await bed.start(bashScript("echo never"));
    const host = bed.host();
    host.send({ type: "prompt", id: "p1", message: "go" });
    const ask = await host.waitFor(isApproval);
    host.send({ type: "approval_response", id: ask.id, answer: "deny", cancelled: true });
    const end = await host.waitFor((r) => r.type === "tool_execution_end");
    expect(end.isError).toBe(true);
    expect(toolText(end)).toContain("could not evaluate this call");
    expect(host.records.find(isCallAudit)).toMatchObject({
      entry: { decision: "denied", reason: "dialog closed" },
    });
  });

  it("treats an answer the card did not offer as a refusal", async () => {
    await bed.start(toolScript("write", { path: join(bed.root, "outside.txt"), content: "x" }));
    const host = bed.host();
    host.send({ type: "prompt", id: "p1", message: "go" });
    const ask = await host.waitFor(isApproval);
    expect(ask.answers).toEqual(["deny", "once"]);
    host.send({ type: "approval_response", id: ask.id, answer: "always" });
    const end = await host.waitFor((r) => r.type === "tool_execution_end");
    expect(end.isError).toBe(true);
    expect(toolText(end)).toContain("Denied by the user.");
  });

  it("closes the question on Stop, tells the daemon, and blocks the call", async () => {
    await bed.start(bashScript("echo never"));
    const host = bed.host();
    host.send({ type: "prompt", id: "p1", message: "go" });
    const ask = await host.waitFor(isApproval);
    expect(await host.request({ type: "abort" })).toMatchObject({ success: true });
    expect(await host.waitFor((r) => r.type === "extension_ui_closed")).toEqual({
      type: "extension_ui_closed",
      id: ask.id,
    });
    expect(await host.waitFor((r) => r.type === "agent_settled")).toMatchObject({ aborted: true });
    expect(host.records.find(isCallAudit)).toMatchObject({
      entry: { decision: "denied", reason: "dialog closed" },
    });
  });

  it("closes the question on shutdown", async () => {
    await bed.start(bashScript("echo never"));
    const host = bed.host();
    host.send({ type: "prompt", id: "p1", message: "go" });
    const ask = await host.waitFor(isApproval);
    host.send({ type: "shutdown", graceMs: 100 });
    expect(await host.waitFor((r) => r.type === "extension_ui_closed")).toEqual({
      type: "extension_ui_closed",
      id: ask.id,
    });
    expect(await host.exited).toBe(0);
  });

  it("ends a provisional always answer at every policy update, valid or malformed (M2R73, M5R11)", async () => {
    const call = { toolCalls: [{ name: "bash", args: { command: "echo granted" }, id: "c" }] };
    await bed.start({ steps: Array.from({ length: 5 }, (_, i) => [call, { text: String(i) }]).flat() });
    const host = bed.host();
    const asks = () => host.records.filter(isApproval);
    const settled = () => host.records.filter((r) => r.type === "agent_settled").length;
    const within = { timeout: 20_000 };
    const askAndAnswerAlways = async (id: string, asked: number) => {
      host.send({ type: "prompt", id, message: id });
      await vi.waitFor(() => expect(asks()).toHaveLength(asked), within);
      host.send({ type: "approval_response", id: asks().at(-1)?.id, answer: "always" });
      await vi.waitFor(() => expect(settled()).toBe(asked * 2 - 1), within);
    };
    const runHeld = async (id: string, done: number) => {
      host.send({ type: "prompt", id, message: id });
      await vi.waitFor(() => expect(settled()).toBe(done), within);
    };
    await askAndAnswerAlways("p1", 1);
    // Held until the daemon's push: the identical call runs without a question.
    await runHeld("p2", 2);
    expect(asks()).toHaveLength(1);
    // Malformed: the rules are null, the held answer is gone, and the call is blocked without a question.
    host.send({ type: "policy_update", rules: { profile: "nonsense" } });
    await runHeld("p3", 3);
    expect(asks()).toHaveLength(1);
    expect(host.records.filter(isCallAudit).at(-1)).toMatchObject({
      entry: { decision: "block", reason: "no valid policy rules" },
    });
    host.send({ type: "policy_update", rules: RULES });
    host.send({ type: "prompt", id: "p4", message: "p4" });
    await vi.waitFor(() => expect(asks()).toHaveLength(2), within);
  });

  it("takes a policy update that arrives before ready, and applies it before the first prompt", async () => {
    const key = grantKey("bash", grantPayload({ command: "echo early" }, true));
    const host = bed.launch(bashScript("echo early"));
    host.send({
      type: "policy_update",
      rules: { ...RULES, alwaysAllow: [{ tool: "bash", key }] },
    });
    host.send({ type: "prompt", id: "p1", message: "go" });
    await host.waitFor((r) => r.type === "tool_execution_end" && r.isError === false);
    expect(host.records.filter(isApproval)).toEqual([]);
    expect(host.records.find(isCallAudit)).toMatchObject({
      entry: { decision: "allow", reason: "always rule" },
    });
  });
});

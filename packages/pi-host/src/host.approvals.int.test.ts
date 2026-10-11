import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bashScript, createHostBed, isApproval, toolText } from "./testing/host-bed.ts";

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
    expect(ask).toMatchObject({ category: "exec", tool: "bash", answers: ["deny", "once"] });
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
    expect(host.records.find((r) => r.type === "audit")).toMatchObject({
      entry: { decision: "denied", reason: "dialog closed" },
    });
  });

  it("treats an answer the card did not offer as a refusal", async () => {
    await bed.start(bashScript("echo never"));
    const host = bed.host();
    host.send({ type: "prompt", id: "p1", message: "go" });
    const ask = await host.waitFor(isApproval);
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
    expect(host.records.find((r) => r.type === "audit")).toMatchObject({
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
});

import { realpathSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { createIntBed, promptAndSettle } from "./testing/int-bed.ts";

// The real pi-host and the real policy module on a scripted model, with the network closed.
it("remembers an always answer for the project across workers, and a revoke bites the live worker (M2-RT-01)", async () => {
  const call = { toolCalls: [{ name: "bash", args: { command: "echo granted" }, id: "c" }] };
  const bed = await createIntBed({ steps: [call, { text: "1" }, call, { text: "2" }, call, { text: "3" }] });
  try {
    const { sessionId } = await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx);
    const sub = await bed.subscribe(sessionId);
    const cards = () => sub.events().filter((event) => event.kind === "dialog_open");
    void bed.rpc["sessions.prompt"]({ sessionId, text: "first" }, bed.ctx);
    const ask = await sub.waitFor((event) => event.kind === "dialog_open");
    if (ask.kind !== "dialog_open") throw new Error("no card");
    expect(ask.dialog).toMatchObject({
      method: "approval",
      category: "exec",
      answers: ["deny", "session", "always", "once"],
    });
    await bed.rpc["sessions.respondDialog"](
      { sessionId, dialogId: ask.dialog.id, response: { answer: "always" } },
      bed.ctx,
    );
    // The first run ends before the next prompt: a prompt during a run is refused.
    await vi.waitFor(
      () => {
        const events = sub.events();
        const opened = events.findIndex((event) => event.kind === "dialog_open");
        const statuses = events
          .slice(opened)
          .flatMap((event) => (event.kind === "status" ? [event.status] : []));
        if (statuses.at(-1) !== "idle") throw new Error("still running");
      },
      { timeout: 20_000 },
    );
    await promptAndSettle(bed, sub, sessionId, "second");
    expect(cards()).toHaveLength(1);
    // Another session of the same project, in a worker of its own, starts with the rule: its run asks nothing.
    const other = (await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx)).sessionId;
    const otherSub = await bed.subscribe(other);
    await promptAndSettle(bed, otherSub, other, "elsewhere");
    expect(otherSub.events().filter((event) => event.kind === "dialog_open")).toEqual([]);
    // Revoked while the worker that took the answer lives: its next identical call asks again.
    const { rules } = await bed.policyRpc["policy.listRules"]({ cwd: bed.work }, bed.ctx);
    expect(rules).toEqual([
      expect.objectContaining({
        tool: "bash",
        scope: realpathSync(bed.work),
        label: expect.stringContaining("echo granted"),
      }),
    ]);
    await bed.policyRpc["policy.revokeRule"]({ ruleId: rules[0]?.id ?? "" }, bed.ctx);
    void bed.rpc["sessions.prompt"]({ sessionId, text: "third" }, bed.ctx);
    await vi.waitFor(() => expect(cards()).toHaveLength(2), { timeout: 20_000 });
  } finally {
    await bed.dispose();
  }
});

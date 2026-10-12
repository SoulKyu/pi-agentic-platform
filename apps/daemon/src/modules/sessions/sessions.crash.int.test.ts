import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HANGER, KILLER, PICKER, THROWER } from "./testing/extensions.ts";
import { createIntBed, type IntBed, promptAndSettle } from "./testing/int-bed.ts";

const beds: IntBed[] = [];
afterEach(async () => {
  for (const bed of beds.splice(0)) await bed.dispose();
});
const open = async (script: object, extensions: Record<string, string>) => {
  const bed = await createIntBed(script, { extensions });
  beds.push(bed);
  return bed;
};

describe("crash containment: extensions that throw, workers that die or hang (spec A success criterion 1)", () => {
  it("reports extension failures as fixed notices and keeps the session working", async () => {
    const bed = await open(
      {
        steps: [{ toolCalls: [{ name: "read", args: { path: "a.txt" }, id: "c1" }] }, { text: "still here" }],
      },
      { thrower: THROWER },
    );
    writeFileSync(join(bed.work, "a.txt"), "content");
    const { sessionId } = await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx);
    const sub = await bed.subscribe(sessionId);
    const snapshot = sub.events()[0];
    expect(snapshot?.kind === "snapshot" && snapshot.notices).toEqual([
      {
        level: "error",
        text: "An extension failed during session_start.",
        code: "extension_failed_during",
        params: { event: "session_start" },
      },
    ]);
    await promptAndSettle(bed, sub, sessionId, "read it");
    // Pi turns a throwing tool_call handler into an error result for that call (pi_host emits no extension_error for it), and the run goes on.
    const events = sub.events();
    expect(events).toContainEqual({
      kind: "pi",
      event: { type: "tool_execution_end", toolCallId: "c1", toolName: "read", isError: true },
    });
    expect(events.some((e) => e.kind === "notice" && e.text.startsWith("An extension failed"))).toBe(false);
    expect(JSON.stringify(sub.events())).toContain("still here");
  });

  it("a worker killed with a card, a panel and queued steers open: everything clears, the daemon and the other sessions carry on", async () => {
    const call = { toolCalls: [{ name: "bash", args: { command: "echo parked" }, id: "c1" }] };
    const bed = await open(
      { steps: [call, { text: "the other session works" }] },
      { killer: KILLER, picker: PICKER },
    );
    const doomed = (await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx)).sessionId;
    const other = (await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx)).sessionId;
    const sub = await bed.subscribe(doomed);
    void bed.rpc["sessions.prompt"]({ sessionId: doomed, text: "go" }, bed.ctx);
    const card = await sub.waitFor((e) => e.kind === "dialog_open");
    void bed.rpc["sessions.prompt"]({ sessionId: doomed, text: "/pick" }, bed.ctx).catch(() => undefined);
    const panel = await sub.waitFor((e) => e.kind === "panel");
    await bed.rpc["sessions.prompt"](
      { sessionId: doomed, text: "steer", streamingBehavior: "steer" },
      bed.ctx,
    );
    await sub.waitFor((e) => e.kind === "queue" && e.queue.count === 1);
    await expect(
      bed.rpc["sessions.prompt"]({ sessionId: doomed, text: "/die" }, bed.ctx),
    ).rejects.toMatchObject({
      code: "worker_failed",
    });
    const cold = await sub.waitFor((e) => e.kind === "status" && e.status === "cold");
    expect(cold).toEqual({
      kind: "status",
      status: "cold",
      cause: "Agent process killed (SIGKILL), possibly out of memory.",
      causeCode: "process_killed",
    });
    if (card.kind !== "dialog_open" || panel.kind !== "panel") throw new Error("missing events");
    expect(sub.events()).toEqual(
      expect.arrayContaining([
        { kind: "dialog_closed", id: card.dialog.id },
        { kind: "panel_closed", id: panel.panel.id },
      ]),
    );
    const after = await bed.subscribe(doomed);
    const snapshot = after.events()[0];
    if (snapshot?.kind !== "snapshot") throw new Error("no snapshot");
    expect([snapshot.dialogs, snapshot.panels, snapshot.queue.count, snapshot.status]).toEqual([
      [],
      [],
      0,
      "cold",
    ]);
    const otherSub = await bed.subscribe(other);
    await bed.rpc["sessions.rename"]({ sessionId: other, name: "Still alive" }, bed.ctx);
    await otherSub.waitFor((e) => e.kind === "name" && e.name === "Still alive");
    expect((await bed.rpc["sessions.list"]({}, bed.ctx)).sessions.map((s) => s.status).sort()).toEqual([
      "cold",
      "idle",
    ]);
    expect(bed.exits.map((exit) => [exit.sessionId, exit.exit.cause])).toEqual([[doomed, "killed"]]);
  });

  it("relaunches a killed worker on the next prompt", async () => {
    const bed = await open({ steps: [{ text: "back again" }] }, { killer: KILLER });
    const { sessionId } = await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx);
    const sub = await bed.subscribe(sessionId);
    await expect(bed.rpc["sessions.prompt"]({ sessionId, text: "/die" }, bed.ctx)).rejects.toMatchObject({
      code: "worker_failed",
    });
    await sub.waitFor((e) => e.kind === "status" && e.status === "cold");
    await promptAndSettle(bed, sub, sessionId, "hello");
    expect(JSON.stringify(sub.events())).toContain("back again");
  });

  it("stops a worker whose extension never finishes session_shutdown, cleanly, within its grace (M2-RT-32)", async () => {
    const bed = await open({ steps: [{ text: "unused" }] }, { hanger: HANGER });
    const { sessionId } = await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx);
    const started = performance.now();
    await bed.sessions.shutdownAll();
    // closeSession gives up on the hook at the 1.5 s grace and exits 0; the ladder's SIGTERM would come at 2 s.
    expect(performance.now() - started).toBeLessThan(2000);
    expect(bed.exits.map((exit) => [exit.sessionId, exit.exit.cause])).toEqual([[sessionId, "clean"]]);
  });
});

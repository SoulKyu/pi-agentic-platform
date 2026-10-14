import { expect, it, vi } from "vitest";
import { createIntBed, promptAndSettle } from "./testing/int-bed.ts";

type Loadout = { preset: string; tools: string[] };
type Seen = Array<{ kind: string; loadout?: Loadout | null }>;
// The loadout the worker said before the subscription is in the snapshot; later ones are events.
const current = (events: Seen): Loadout | null =>
  events.reduce<Loadout | null>(
    (latest, event) =>
      event.kind === "loadout" || event.kind === "snapshot" ? (event.loadout ?? latest) : latest,
    null,
  );

it("opens a session with a preset, changes it in place, and restarts the worker across the chat boundary (M7R77)", async () => {
  const bed = await createIntBed({ steps: [{ text: "one" }, { text: "two" }] });
  try {
    const { sessionId } = await bed.rpc["sessions.create"]({ cwd: bed.work, preset: "read-only" }, bed.ctx);
    const sub = await bed.subscribe(sessionId);
    const now = () => current(sub.events() as unknown as Seen);
    await vi.waitFor(() => expect(now()?.preset).toBe("read-only"), { timeout: 20_000 });
    expect(now()?.tools).not.toContain("bash");

    await bed.rpc["sessions.setTools"]({ sessionId, preset: "full" }, bed.ctx);
    await vi.waitFor(() => expect(now()?.preset).toBe("full"), { timeout: 20_000 });
    expect(now()?.tools).toEqual(expect.arrayContaining(["bash", "edit", "write"]));
    expect(bed.exits).toEqual([]);

    await bed.rpc["sessions.setTools"]({ sessionId, preset: "chat" }, bed.ctx);
    await sub.waitFor((event) => event.kind === "status" && event.status === "cold");
    expect(bed.exits.map((exit) => exit.exit.cause)).toEqual(["clean"]);
    await promptAndSettle(bed, sub, sessionId, "hello");
    await vi.waitFor(() => expect(now()?.preset).toBe("chat"), { timeout: 20_000 });
    expect(now()?.tools).toEqual([]);
  } finally {
    await bed.dispose();
  }
}, 60_000);

it("exposes the stored preset of a session without a worker, in the list and the snapshot (MC37)", async () => {
  const bed = await createIntBed({ steps: [{ text: "one" }] });
  try {
    const { sessionId } = await bed.rpc["sessions.create"]({ cwd: bed.work, preset: "read-only" }, bed.ctx);
    const first = await bed.subscribe(sessionId);
    await first.waitFor((event) => event.kind === "snapshot");
    await bed.rpc["sessions.setTools"]({ sessionId, preset: "chat" }, bed.ctx);
    await first.waitFor((event) => event.kind === "status" && event.status === "cold");
    const { sessions } = await bed.rpc["sessions.list"]({}, bed.ctx);
    expect(sessions.find((session) => session.id === sessionId)?.toolPreset).toBe("chat");
    const second = await bed.subscribe(sessionId);
    const snapshot = await second.waitFor((event) => event.kind === "snapshot");
    expect(snapshot).toMatchObject({ status: "cold", loadout: null, toolPreset: "chat" });
  } finally {
    await bed.dispose();
  }
}, 60_000);

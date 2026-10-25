import type { BoxRef, LaunchesStreamEvent } from "@pap/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { codeOf, startTwoUsers, type TwoUsers } from "../../testing/two-users.ts";

// A2: the launches stream over a whole daemon on the process backend.

let u: TwoUsers;
beforeAll(async () => void (u = await startTwoUsers()), 180_000);
afterAll(async () => u?.stop());

const boxOf = (id: string): BoxRef => ({ kind: "project", id });
const snapshotOf = (
  events: ReadonlyArray<{ event: unknown }>,
): Extract<LaunchesStreamEvent, { kind: "snapshot" }> =>
  events
    .map((frame) => frame.event as LaunchesStreamEvent)
    .filter((event): event is Extract<LaunchesStreamEvent, { kind: "snapshot" }> => event.kind === "snapshot")
    .at(-1) as never;

describe("the launches stream", () => {
  it("the launches snapshot lists live launches after a reconnect", async () => {
    const box = boxOf("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const handle = u.bed.vm.launches.open({ box, owner: u.owner.id, for: "session-1" });
    handle.step("checks", "done");
    handle.step("image", "running");
    const fresh = await u.bed.t.connect(u.owner.cookie);
    try {
      const sub = await fresh.call("subscribe.launches", {});
      expect(sub.ok).toBe(true);
      const frame = await fresh.waitForEvent(
        (f) => (f.event as { kind?: string }).kind === "snapshot",
        10_000,
      );
      const snapshot = frame.event as Extract<LaunchesStreamEvent, { kind: "snapshot" }>;
      // The bed's own session launches (A3) may be live too: this one is found by its id.
      expect(snapshot.launches.find((launch) => launch.id === handle.id)).toMatchObject({
        id: handle.id,
        box,
        for: "session-1",
        steps: expect.arrayContaining([
          expect.objectContaining({ step: "checks", state: "done" }),
          expect.objectContaining({ step: "image", state: "running" }),
        ]),
      });
      handle.end(true);
      const end = await fresh.waitForEvent((f) => (f.event as { kind?: string }).kind === "end", 10_000);
      expect(end.event).toEqual({ kind: "end", id: handle.id, done: true, ok: true });
    } finally {
      fresh.close();
    }
  });

  it("a member's launches stream holds only their boxes", async () => {
    const mine = boxOf("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    const theirs = boxOf("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    const member = u.bed.vm.launches.open({ box: mine, owner: u.member.id, for: "session-m" });
    const owner = u.bed.vm.launches.open({ box: theirs, owner: u.owner.id, for: "session-o" });
    const sub = await u.member.client.call("subscribe.launches", {});
    expect(sub.ok).toBe(true);
    await u.member.client.waitForEvent((f) => (f.event as { kind?: string }).kind === "snapshot", 10_000);
    owner.step("checks", "running");
    member.step("checks", "running");
    await u.member.client.waitForEvent(
      (f) => (f.event as { kind?: string; launch?: { box: BoxRef } }).launch?.box.id === mine.id,
      10_000,
    );
    owner.end(true);
    member.end(true);
    await u.member.client.waitForEvent((f) => (f.event as { kind?: string }).kind === "end", 10_000);
    const heard = JSON.stringify(u.member.client.events.map((frame) => frame.event));
    expect(heard).toContain(mine.id);
    expect(heard).not.toContain(theirs.id);
    expect(heard).not.toContain("session-o");
    expect(snapshotOf(u.member.client.events).launches.map((launch) => launch.box)).toEqual([mine]);
  });

  it("leaves no launch live once the bed's own sessions are up (A3: every opener ends its handle)", async () => {
    await vi.waitFor(() => {
      expect(u.bed.vm.launches.live(u.owner.id)).toEqual([]);
      expect(u.bed.vm.launches.live(u.member.id)).toEqual([]);
    }, 20_000);
  });

  it("launches.stop: a member cannot stop another user's launch, its owner can", async () => {
    const handle = u.bed.vm.launches.open({
      box: boxOf("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
      owner: u.owner.id,
      for: "session-s",
    });
    handle.step("vm", "running");
    expect(codeOf(await u.member.call("launches.stop", { id: handle.id }))).toBe("not_found");
    expect(u.bed.vm.launches.live(u.owner.id).some((launch) => launch.id === handle.id)).toBe(true);
    expect((await u.owner.call("launches.stop", { id: handle.id })).ok).toBe(true);
    expect(u.bed.vm.launches.live(u.owner.id).some((launch) => launch.id === handle.id)).toBe(false);
    expect(codeOf(await u.owner.call("launches.stop", { id: handle.id }))).toBe("not_found");
  });
});

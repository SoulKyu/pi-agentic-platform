import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { fakePolicyPort } from "./testing/fake-policy.ts";
import { type BedOptions, createServiceBed, OWNER } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const build = (options: BedOptions = {}) =>
  createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader }, options);
let bed: ReturnType<typeof build>;
afterEach(() => bed.dispose());

const snapshotNotices = async (sessionId: string) => {
  const late = await bed.subscribe(sessionId);
  const first = late[0]?.event as { kind: string; notices?: Array<{ text: string; source?: string }> };
  expect(first.kind).toBe("snapshot");
  return first.notices ?? [];
};

describe("pap's own notices reach the ring (final review M3)", () => {
  it("keeps the grant notice for a client that subscribes later, without a source", async () => {
    bed = build({ policy: fakePolicyPort({ full: true }) });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    bed.spawned[0]?.emit({
      type: "approval_request",
      id: "a1",
      category: "exec",
      title: "Run?",
      message: "bash: npm test",
      answers: ["deny", "session", "always", "once"],
      tool: "bash",
      key: "a".repeat(64),
    });
    await bed.clock.advance(0);
    bed.service.respondDialog({ sessionId, dialogId: "a1", response: { answer: "always" } }, OWNER);
    await bed.clock.advance(0);
    const notices = await snapshotNotices(sessionId);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.text).toContain("always-allowed calls");
    expect(notices[0]).not.toHaveProperty("source");
  });

  it("keeps the reload notice for a client that subscribes later, without a source", async () => {
    bed = build({ replies: { navigate_tree: { data: { cancelled: false, leafId: "a0" } } } });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    bed.writePiFile(0);
    await bed.subscribe(sessionId);
    const publish = bed.hub.publish.bind(bed.hub);
    const spy = vi.spyOn(bed.hub, "publish").mockImplementation((stream, key, event) => {
      if ((event as { kind: string }).kind === "snapshot") throw new Error("cannot build");
      return publish(stream, key, event);
    });
    await bed.service.navigate({ sessionId, targetId: "u0" }, OWNER);
    spy.mockRestore();
    const notices = await snapshotNotices(sessionId);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.text).toContain("Reload the page");
    expect(notices[0]).not.toHaveProperty("source");
  });
});

import { describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { silentLogger } from "../../kernel/logger.ts";
import type { FailedEffect } from "../../kernel/outbox/index.ts";
import type { StreamHub } from "../../kernel/ws/stream-hub.ts";
import { createHealthModule, healthRpc } from "./index.ts";

const ctx = (userId: string, openSubscription = vi.fn(() => "sub-1")) =>
  ({ caller: { userId, kind: "session" }, openSubscription }) as never;

describe("healthRpc", () => {
  it("ops.events.list calls the service once with the caller's owner", async () => {
    const page = vi.fn(() => ({ events: [], hasMore: false }));
    const handler = healthRpc({ page })["ops.events.list"];
    const result = await handler({ limit: 10 }, ctx("u1"));
    expect(page).toHaveBeenCalledTimes(1);
    expect(page).toHaveBeenCalledWith("u1", { limit: 10 });
    expect(result).toEqual({ events: [], hasMore: false });
  });

  it("subscribe.ops opens the ops subscription keyed by the caller", async () => {
    const openSubscription = vi.fn(() => "sub-1");
    const handler = healthRpc({ page: vi.fn() })["subscribe.ops"];
    expect(await handler({ after: undefined }, ctx("u1", openSubscription))).toEqual({ sub: "sub-1" });
    expect(openSubscription).toHaveBeenCalledWith("ops", "u1", undefined);
  });
});

/** The module over a fake outbox: the listeners the subscriptions pushed into it. */
function module() {
  const failed: Array<(failure: FailedEffect) => void> = [];
  const overdue: Array<(overdue: { id: number; kind: string; ownerId: string | null }) => void> = [];
  const published: Array<{ key: string; event: unknown }> = [];
  const hub: Pick<StreamHub, "publish" | "registerSnapshot"> = {
    registerSnapshot: vi.fn(),
    publish: vi.fn((_stream, key, event) => void published.push({ key, event })),
  };
  const health = createHealthModule({
    clock: createFakeClock(1_000),
    logger: silentLogger,
    hub,
    outbox: {
      onFailed: (listener) => (failed.push(listener), () => {}),
      onOverdue: (listener) => (overdue.push(listener), () => {}),
    },
  });
  const pageOf = async (ownerId: string) =>
    (await health.rpc["ops.events.list"]({}, ctx(ownerId))) as {
      events: Array<{ code: string; sourceRef: unknown }>;
      hasMore: boolean;
    };
  return { health, failed, overdue, published, pageOf };
}

describe("createHealthModule", () => {
  it("buffers an owned outbox failure and skips a system one", async () => {
    const { failed, pageOf, published, health } = module();
    failed[0]?.({ id: 7, kind: "task.start", ownerId: "u1", lastError: "x", settledAt: 0 });
    const page = await pageOf("u1");
    expect(page.events).toEqual([
      expect.objectContaining({ code: "outbox_handler_error", sourceRef: { kind: "effect", id: 7 } }),
    ]);
    expect(published).toEqual([{ key: "u1", event: expect.objectContaining({ kind: "event" }) }]);
    failed[0]?.({ id: 8, kind: "task.start", ownerId: null, lastError: "y", settledAt: 0 });
    expect((await pageOf("u1")).events).toHaveLength(1); // log-only in v1: no owner to page
    health.stop();
  });

  it("buffers an owned overdue effect and skips a system one", async () => {
    const { overdue, pageOf, health } = module();
    overdue[0]?.({ id: 9, kind: "feed.poll", ownerId: "u1" });
    overdue[0]?.({ id: 10, kind: "feed.poll", ownerId: null });
    const page = await pageOf("u1");
    expect(page.events).toEqual([
      expect.objectContaining({ code: "outbox_handler_overdue", sourceRef: { kind: "effect", id: 9 } }),
    ]);
    health.stop();
  });

  it("stops the subscriptions and the stream", async () => {
    const { health, failed, overdue, published } = module();
    health.stop();
    failed[0]?.({ id: 1, kind: "task.start", ownerId: "u1", lastError: "x", settledAt: 0 });
    overdue[0]?.({ id: 2, kind: "task.start", ownerId: "u1" });
    health.port.emit({ ownerId: "u1", kind: "sched", code: "missed", sourceRef: null });
    expect(published).toHaveLength(0);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { type Bed, connectLine, denyOf, exchange, scopeOf, startBed } from "./testing/bed.ts";

let bed: Bed;
afterEach(async () => {
  await bed.stop();
});

/** A resolver that answers only when the test says so. */
function slowResolver() {
  const pending: Array<(answers: string[]) => void> = [];
  return {
    pending,
    resolve: () => new Promise<string[]>((resolve) => pending.push(resolve)),
  };
}

describe("the lookup semaphore (W5-R43)", () => {
  it("at most 2 lookups run daemon-wide: a third waits for a slot", async () => {
    const slow = slowResolver();
    bed = await startBed({ resolve: slow.resolve });
    const paths = await Promise.all(["a", "b", "c"].map((sessionId) => bed.listen(scopeOf({ sessionId }))));
    const replies = paths.map((listener) => exchange(listener.path, connectLine("allowed.test:443")));
    await vi.waitFor(() => expect(bed.calls.resolve).toHaveLength(2), { timeout: 5000 });
    await bed.clock.advance(0);
    expect(bed.calls.resolve).toHaveLength(2);
    slow.pending[0]?.([]);
    await vi.waitFor(() => expect(bed.calls.resolve).toHaveLength(3), { timeout: 5000 });
    slow.pending[1]?.([]);
    slow.pending[2]?.([]);
    expect((await Promise.all(replies)).map(denyOf)).toEqual(["dns_failed", "dns_failed", "dns_failed"]);
  });

  it("one command runs one lookup at a time", async () => {
    const slow = slowResolver();
    bed = await startBed({ resolve: slow.resolve });
    const listener = await bed.listen(scopeOf({ hosts: null }));
    const a = exchange(listener.path, connectLine("allowed.test:443"));
    const b = exchange(listener.path, connectLine("allowed2.test:443"));
    await vi.waitFor(() => expect(bed.calls.resolve).toHaveLength(1), { timeout: 5000 });
    await bed.clock.advance(0);
    expect(bed.calls.resolve).toHaveLength(1);
    slow.pending[0]?.([]);
    await vi.waitFor(() => expect(bed.calls.resolve).toHaveLength(2), { timeout: 5000 });
    slow.pending[1]?.([]);
    await Promise.all([a, b]);
  });

  it("one session runs one lookup at a time across its commands, and another session is not held up", async () => {
    const slow = slowResolver();
    bed = await startBed({ resolve: slow.resolve });
    const [one, two] = await Promise.all([bed.listen(), bed.listen()]);
    const other = await bed.listen(scopeOf({ sessionId: "s2" }));
    const first = exchange((one as { path: string }).path, connectLine("allowed.test:443"));
    await vi.waitFor(() => expect(bed.calls.resolve).toHaveLength(1), { timeout: 5000 });
    // The session's second command waits behind the first; another session's command starts at once.
    const second = exchange((two as { path: string }).path, connectLine("allowed2.test:443"));
    await bed.clock.advance(0);
    const apart = exchange(other.path, connectLine("allowed.test:443"));
    await vi.waitFor(() => expect(bed.calls.resolve).toHaveLength(2), { timeout: 5000 });
    await bed.clock.advance(0);
    expect(bed.calls.resolve).toEqual(["allowed.test", "allowed.test"]);
    slow.pending[0]?.([]);
    await vi.waitFor(() => expect(bed.calls.resolve).toHaveLength(3), { timeout: 5000 });
    slow.pending[1]?.([]);
    slow.pending[2]?.([]);
    await Promise.all([first, second, apart]);
  });

  it("a precheck (no session) is counted per agent", async () => {
    const slow = slowResolver();
    bed = await startBed({ resolve: slow.resolve });
    const [one, two] = await Promise.all([
      bed.listen(scopeOf({ sessionId: null })),
      bed.listen(scopeOf({ sessionId: null })),
    ]);
    const first = exchange(one.path, connectLine("allowed.test:443"));
    const second = exchange(two.path, connectLine("allowed2.test:443"));
    await vi.waitFor(() => expect(bed.calls.resolve).toHaveLength(1), { timeout: 5000 });
    await bed.clock.advance(0);
    expect(bed.calls.resolve).toHaveLength(1);
    slow.pending[0]?.([]);
    await vi.waitFor(() => expect(bed.calls.resolve).toHaveLength(2), { timeout: 5000 });
    slow.pending[1]?.([]);
    await Promise.all([first, second]);
  });

  it("a queued lookup past the 5 s deadline answers dns_failed and never starts", async () => {
    const slow = slowResolver();
    bed = await startBed({ resolve: slow.resolve });
    const listeners = await Promise.all(
      ["a", "b", "c"].map((sessionId) => bed.listen(scopeOf({ sessionId }))),
    );
    const first = listeners.slice(0, 2).map((l) => exchange(l.path, connectLine("allowed.test:443")));
    await vi.waitFor(() => expect(bed.calls.resolve).toHaveLength(2), { timeout: 5000 });
    const armed = bed.clock.pending();
    const queued = exchange((listeners[2] as { path: string }).path, connectLine("allowed.test:443"));
    await vi.waitFor(() => expect(bed.clock.pending()).toBeGreaterThan(armed), { timeout: 5000 });
    await bed.clock.advance(5001);
    expect(denyOf(await queued)).toBe("dns_failed");
    expect(bed.calls.resolve).toHaveLength(2);
    expect((await Promise.all(first)).map(denyOf)).toEqual(["dns_failed", "dns_failed"]);
    // The slots free up, and the lookup that timed out in the queue still never starts.
    slow.pending[0]?.([]);
    slow.pending[1]?.([]);
    await bed.clock.advance(0);
    expect(bed.calls.resolve).toHaveLength(2);
  });
});

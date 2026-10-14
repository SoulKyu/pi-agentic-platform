import { describe, expect, it } from "vitest";
import { FLOW_RETRY_MS, FLOW_STALE_MS } from "./flow.ts";
import { RING_MAX_BYTES } from "./ring.ts";
import { makeBed } from "./testing/bed.ts";

const KIB = 1024;
const MIB = KIB * KIB;
const fill = (size: number, byte = 0x61) => new Uint8Array(size).fill(byte);

/** Pushes `size` bytes through the PTY in 64 KiB writes. */
function produce(bed: ReturnType<typeof makeBed>, size: number, byte = 0x61): void {
  for (let done = 0; done < size; done += 64 * KIB) bed.pty.emit(fill(Math.min(64 * KIB, size - done), byte));
}

const offsetsOf = (frames: ReadonlyArray<{ op: string; seq: number; payload: Uint8Array }>) =>
  frames.filter((f) => f.op === "output").map((f) => [f.seq, f.seq + f.payload.byteLength] as const);

describe("one stream: the ack window", () => {
  it("sends 512 KiB contiguously, then pauses the stream and the PTY; acks resume at 256 KiB of lag", () => {
    const bed = makeBed();
    const { stream } = bed.connect("c1");
    stream.commit();
    produce(bed, 600 * KIB);
    const output = offsetsOf(stream.frames);
    expect(output[0]?.[0]).toBe(0);
    for (let i = 1; i < output.length; i++) expect(output[i]?.[0]).toBe(output[i - 1]?.[1]);
    expect(output.at(-1)?.[1]).toBe(512 * KIB);
    expect(bed.pty.paused).toBe(true);

    stream.ack(200 * KIB);
    expect(offsetsOf(stream.frames).at(-1)?.[1]).toBe(512 * KIB);
    expect(bed.pty.paused).toBe(true);

    stream.ack(300 * KIB);
    expect(offsetsOf(stream.frames).at(-1)?.[1]).toBe(600 * KIB);
    expect(bed.pty.paused).toBe(false);
    expect(bed.pty.flow).toEqual(["pause", "resume"]);
    expect(stream.text().length).toBe(600 * KIB);
  });

  it("an ack below the last one does not lower it: the window stays measured from the highest ack", () => {
    const bed = makeBed();
    const { stream } = bed.connect("c1");
    stream.commit();
    produce(bed, 300 * KIB);
    stream.ack(250 * KIB);
    stream.ack(10 * KIB);
    produce(bed, 400 * KIB);
    expect(bed.pty.paused).toBe(false);
    expect(offsetsOf(stream.frames).at(-1)?.[1]).toBe(700 * KIB);
  });

  it("an ack at exactly 256 KiB of lag resumes, one byte less does not", () => {
    const bed = makeBed();
    const { stream } = bed.connect("c1");
    stream.commit();
    produce(bed, 600 * KIB);
    stream.ack(256 * KIB - 1);
    expect(bed.pty.paused).toBe(true);
    stream.ack(256 * KIB);
    expect(bed.pty.paused).toBe(false);
  });

  it("ignores an ack above what was sent and one below the last ack", () => {
    const bed = makeBed();
    const { stream } = bed.connect("c1");
    stream.commit();
    produce(bed, 600 * KIB);
    stream.ack(100 * KIB);
    stream.ack(50 * KIB);
    stream.ack(512 * KIB + 1);
    stream.ack(600 * KIB);
    expect(bed.pty.paused).toBe(true);
    expect(offsetsOf(stream.frames).at(-1)?.[1]).toBe(512 * KIB);
    stream.ack(300 * KIB);
    expect(bed.pty.paused).toBe(false);
  });
});

describe("a stream whose socket refuses", () => {
  it("pauses, loses nothing and retries from the same offset every 50 ms", async () => {
    const bed = makeBed();
    const { stream } = bed.connect("c1");
    stream.commit();
    bed.pty.emit("one");
    stream.accepting = false;
    bed.pty.emit("two");
    expect(stream.text()).toBe("one");
    expect(bed.pty.paused).toBe(true);
    await bed.clock.advance(FLOW_RETRY_MS);
    expect(stream.text()).toBe("one");
    expect(bed.pty.paused).toBe(true);
    stream.accepting = true;
    await bed.clock.advance(FLOW_RETRY_MS);
    expect(stream.shape()).toEqual([
      ["reset", 0],
      ["output", 0],
      ["output", 3],
    ]);
    expect(stream.text()).toBe("onetwo");
    expect(bed.pty.paused).toBe(false);
    expect(bed.clock.pending()).toBe(0);
  });

  it("a closed stream stops retrying", async () => {
    const bed = makeBed();
    const { stream } = bed.connect("c1");
    stream.commit();
    stream.accepting = false;
    bed.pty.emit("x");
    expect(bed.clock.pending()).toBeGreaterThan(0);
    stream.close();
    expect(bed.clock.pending()).toBe(0);
    expect(bed.pty.paused).toBe(false);
  });
});

describe("a hidden tab never pauses the PTY (owner f2)", () => {
  it("one stream that never acks: after 2 s the PTY runs again and output goes on into the ring", async () => {
    const bed = makeBed();
    const { stream } = bed.connect("c1");
    stream.commit();
    produce(bed, 600 * KIB);
    expect(bed.pty.paused).toBe(true);
    await bed.clock.advance(FLOW_STALE_MS - 1);
    expect(bed.pty.paused).toBe(true);
    await bed.clock.advance(1);
    expect(bed.pty.paused).toBe(false);
    produce(bed, 1 * MIB, 0x62);
    expect(bed.pty.paused).toBe(false);
    expect(offsetsOf(stream.frames).at(-1)?.[1]).toBe(512 * KIB);
    expect(stream.closes).toBe(0);
  });

  it("a stale stream that acks within the ring continues from its offset, no reset", async () => {
    const bed = makeBed();
    const { stream } = bed.connect("c1");
    stream.commit();
    produce(bed, 600 * KIB);
    await bed.clock.advance(FLOW_STALE_MS);
    produce(bed, 200 * KIB, 0x62);
    expect(offsetsOf(stream.frames).at(-1)?.[1]).toBe(512 * KIB);
    stream.ack(512 * KIB);
    expect(stream.frames.filter((f) => f.op === "reset").length).toBe(1);
    const output = offsetsOf(stream.frames);
    expect(output.at(8)?.[0]).toBe(512 * KIB);
    expect(output.at(-1)?.[1]).toBe(800 * KIB);
    expect(bed.pty.paused).toBe(false);
  });

  it("after 6 MiB the stale stream's ack gets a reset at safeStart(), then the ring", async () => {
    const bed = makeBed();
    const { stream } = bed.connect("c1");
    stream.commit();
    produce(bed, 600 * KIB);
    await bed.clock.advance(FLOW_STALE_MS);
    produce(bed, 6 * MIB, 0x62);
    expect(bed.pty.paused).toBe(false);
    const total = 600 * KIB + 6 * MIB;
    const before = stream.frames.length;
    stream.ack(512 * KIB);
    const fresh = stream.frames.slice(before);
    expect(fresh[0]?.op).toBe("reset");
    expect(fresh[0]?.payload.byteLength).toBe(0);
    const at = fresh[0]?.seq ?? 0;
    expect(at).toBeGreaterThanOrEqual(total - RING_MAX_BYTES);
    expect(at).toBeLessThanOrEqual(total - RING_MAX_BYTES + 64 * KIB);
    const output = offsetsOf(fresh);
    expect(output[0]?.[0]).toBe(at);
    for (let i = 1; i < output.length; i++) expect(output[i]?.[0]).toBe(output[i - 1]?.[1]);
    expect(output.at(-1)?.[1]).toBe(at + 512 * KIB);
  });

  it("partial acks do not keep the stream alive: it is stale 2 s after the pause began", async () => {
    const bed = makeBed();
    const { stream } = bed.connect("c1");
    stream.commit();
    produce(bed, 600 * KIB);
    expect(bed.pty.paused).toBe(true);
    for (let i = 1; i <= 3; i++) {
      await bed.clock.advance(500);
      stream.ack(i * 10 * KIB);
      expect(bed.pty.paused).toBe(true);
    }
    await bed.clock.advance(499);
    expect(bed.pty.paused).toBe(true);
    await bed.clock.advance(1);
    expect(bed.pty.paused).toBe(false);
  });

  it("an ack equal to the last one changes nothing, not even the 2 s count", async () => {
    const bed = makeBed();
    const { stream } = bed.connect("c1");
    stream.commit();
    produce(bed, 600 * KIB);
    stream.ack(100 * KIB);
    await bed.clock.advance(1900);
    stream.ack(100 * KIB);
    expect(bed.pty.paused).toBe(true);
    await bed.clock.advance(100);
    expect(bed.pty.paused).toBe(false);
  });

  it("a stale stream acking 64 KiB every second never pauses the PTY again until an ack resumes it", async () => {
    const bed = makeBed();
    const { stream } = bed.connect("c1");
    stream.commit();
    produce(bed, 600 * KIB);
    await bed.clock.advance(FLOW_STALE_MS);
    expect(bed.pty.flow).toEqual(["pause", "resume"]);
    let acked = 0;
    for (let second = 0; second < 3; second++) {
      acked += 64 * KIB;
      stream.ack(acked);
      await bed.clock.advance(1000);
      produce(bed, 64 * KIB, 0x62);
    }
    expect(acked).toBe(192 * KIB);
    expect(bed.pty.flow).toEqual(["pause", "resume"]);
  });

  it("a stale stream leaves the stale state only when an ack resumes it; its next pause counts from zero", async () => {
    const bed = makeBed();
    const { stream } = bed.connect("c1");
    stream.commit();
    produce(bed, 600 * KIB);
    await bed.clock.advance(FLOW_STALE_MS);
    produce(bed, 600 * KIB, 0x62);
    stream.ack(300 * KIB);
    expect(offsetsOf(stream.frames).at(-1)?.[1]).toBe(812 * KIB);
    expect(bed.pty.paused).toBe(true);
    await bed.clock.advance(FLOW_STALE_MS - 1);
    expect(bed.pty.paused).toBe(true);
    await bed.clock.advance(1);
    expect(bed.pty.paused).toBe(false);
  });

  it("two streams, the slow one never acks: the fast one gets everything and the PTY is never paused", async () => {
    const bed = makeBed();
    const fast = bed.connect("fast").stream;
    const slow = bed.connect("slow").stream;
    fast.commit();
    slow.commit();
    let total = 0;
    for (let i = 0; i < 100; i++) {
      produce(bed, 64 * KIB);
      total += 64 * KIB;
      fast.ack(total);
    }
    expect(bed.pty.flow).toEqual([]);
    expect(fast.text().length).toBe(total);
    expect(offsetsOf(slow.frames).at(-1)?.[1]).toBe(512 * KIB);
    await bed.clock.advance(FLOW_STALE_MS * 3);
    expect(bed.pty.flow).toEqual([]);
  });

  it("two streams: after 6 MiB the slow one acks and gets a reset at safeStart(), then the ring", () => {
    const bed = makeBed();
    const fast = bed.connect("fast").stream;
    const slow = bed.connect("slow").stream;
    fast.commit();
    slow.commit();
    let total = 0;
    for (let i = 0; i < 6 * 16; i++) {
      produce(bed, 64 * KIB);
      total += 64 * KIB;
      fast.ack(total);
    }
    expect(offsetsOf(slow.frames).at(-1)?.[1]).toBe(512 * KIB);
    const before = slow.frames.length;
    slow.ack(512 * KIB);
    const fresh = slow.frames.slice(before);
    expect(fresh[0]?.op).toBe("reset");
    expect(fresh[0]?.seq).toBe(total - RING_MAX_BYTES);
    const output = offsetsOf(fresh);
    expect(output[0]?.[0]).toBe(total - RING_MAX_BYTES);
    expect(output.at(-1)?.[1]).toBe(total - RING_MAX_BYTES + 512 * KIB);
    expect(bed.pty.flow).toEqual([]);
  });

  it("the PTY pauses only when every holding stream is paused", () => {
    const bed = makeBed();
    const a = bed.connect("a").stream;
    const b = bed.connect("b").stream;
    a.commit();
    b.commit();
    produce(bed, 600 * KIB);
    expect(bed.pty.paused).toBe(true);
    b.ack(600 * KIB - 256 * KIB);
    expect(bed.pty.paused).toBe(false);
    a.ack(512 * KIB);
    expect(bed.pty.paused).toBe(false);
  });

  it("a stream that is not committed yet does not hold the PTY; one that is up to date releases it", () => {
    const bed = makeBed();
    const a = bed.connect("a").stream;
    a.commit();
    produce(bed, 600 * KIB);
    expect(bed.pty.paused).toBe(true);
    const pending = bed.connect("b", 576 * KIB).stream;
    expect(bed.pty.paused).toBe(true);
    pending.commit();
    expect(bed.pty.paused).toBe(false);
    a.close();
    pending.close();
    expect(bed.pty.flow).toEqual(["pause", "resume"]);
  });

  it("the PTY resumes when the only paused stream goes away", () => {
    const bed = makeBed();
    const a = bed.connect("a").stream;
    a.commit();
    produce(bed, 600 * KIB);
    expect(bed.pty.paused).toBe(true);
    a.close();
    expect(bed.pty.paused).toBe(false);
  });

  it("a shell that dies while the PTY is paused is noticed within 50 ms: its last output is read before node-pty gives up", async () => {
    const bed = makeBed();
    const { stream } = bed.connect("c1");
    stream.commit();
    produce(bed, 600 * KIB);
    expect(bed.pty.paused).toBe(true);
    bed.pty.emit("LAST OUTPUT\n");
    bed.pty.exit(3);
    await bed.clock.advance(50);
    expect(bed.pty.paused).toBe(false);
    await bed.clock.advance(300);
    expect(bed.terminal.view()).toMatchObject({ status: "exited", exitCode: 3 });
    stream.ack(300 * KIB);
    expect(stream.text().endsWith("LAST OUTPUT\n")).toBe(true);
    expect(stream.frames.at(-1)?.op).toBe("exit");
    expect(bed.clock.pending()).toBe(0);
  });

  it("once the shell was seen dead the PTY is never paused again, whatever happens to the streams", async () => {
    const bed = makeBed();
    bed.connect("c1").stream.commit();
    produce(bed, 600 * KIB);
    // A stream joins in the moment between the resume and node-pty's `exit`.
    const resume = bed.pty.resume.bind(bed.pty);
    bed.pty.resume = () => {
      resume();
      bed.connect("c2").stream.commit();
    };
    bed.pty.exit(0);
    await bed.clock.advance(50);
    expect(bed.pty.flow).toEqual(["pause", "resume"]);
  });

  it("closing a terminal whose PTY is paused leaves no timer behind", async () => {
    const bed = makeBed();
    bed.connect("c1").stream.commit();
    produce(bed, 600 * KIB);
    expect(bed.pty.paused).toBe(true);
    bed.kill.mockImplementation(async () => {});
    await bed.terminal.close();
    expect(bed.clock.pending()).toBe(0);
  });

  it("while the shell lives the PTY stays paused and is polled, and the poll stops with the pause", async () => {
    const bed = makeBed();
    const { stream } = bed.connect("c1");
    stream.commit();
    produce(bed, 600 * KIB);
    await bed.clock.advance(150);
    expect(bed.pty.paused).toBe(true);
    stream.ack(600 * KIB - 100 * KIB);
    expect(bed.pty.paused).toBe(false);
    expect(bed.clock.pending()).toBe(0);
  });
});

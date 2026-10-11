import { describe, expect, it } from "vitest";
import { backoffDelay, createConnection, type ProbeResult, type SocketLike } from "./connection.ts";

class FakeSocket implements SocketLike {
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
  receive(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

function setup(probe: ProbeResult | (() => Promise<ProbeResult>) = "ok") {
  let now = 0;
  let nextId = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const sockets: FakeSocket[] = [];
  const connection = createConnection({
    url: "ws://localhost/ws?proto=1",
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    probe: typeof probe === "function" ? probe : async () => probe,
    timers: {
      set: (fn, ms) => {
        pending.set(nextId, { at: now + ms, fn });
        return nextId++;
      },
      clear: (id) => {
        pending.delete(id);
      },
    },
    random: () => 0.5,
  });
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at <= now && pending.has(id)) {
        pending.delete(id);
        timer.fn();
      }
    }
  };
  const latest = () => sockets[sockets.length - 1] as FakeSocket;
  const hello = (protocol = 1) =>
    latest().receive({ protocol, capabilities: ["rpc"], serverVersion: "0.0.0" });
  return {
    connection,
    sockets,
    advance,
    latest,
    hello,
    delays: () => [...pending.values()].map((t) => t.at - now),
  };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("connection supervisor", () => {
  it("opens after a matching hello and forwards later frames", () => {
    const { connection, hello, latest } = setup();
    const frames: unknown[] = [];
    connection.onFrame((frame) => frames.push(frame));
    connection.start();
    expect(connection.state).toBe("connecting");
    hello();
    expect(connection.state).toBe("open");
    latest().receive({ id: 1, ok: true, result: {} });
    expect(frames).toEqual([{ id: 1, ok: true, result: {} }]);
  });

  it("marks the tab outdated on a hello from another protocol version", () => {
    const { connection, hello } = setup();
    connection.start();
    hello(2);
    expect(connection.state).toBe("outdated");
  });

  it("closes the socket it rejects as outdated and does not retry", async () => {
    const { connection, hello, latest, delays } = setup();
    connection.start();
    hello(2);
    await flush();
    expect(latest().closed).toBe(true);
    expect(connection.state).toBe("outdated");
    expect(delays()).toEqual([]);
  });

  it("probes after a drop, then retries with jittered backoff capped at 30 s", async () => {
    const { connection, hello, latest, delays, advance } = setup();
    connection.start();
    hello();
    for (let attempt = 0; attempt < 8; attempt++) {
      latest().close();
      await flush();
      expect(connection.state).toBe("waiting");
      expect(delays()).toContain(backoffDelay(attempt, 0.5));
      advance(backoffDelay(attempt, 0.5));
    }
    expect(backoffDelay(10, 1)).toBe(30_000);
  });

  it("stops retrying when the probe says signed-out or outdated", async () => {
    const signedOut = setup("signed-out");
    signedOut.connection.start();
    signedOut.latest().close();
    await flush();
    expect(signedOut.connection.state).toBe("signed-out");
    expect(signedOut.delays()).toEqual([]);
    const outdated = setup("outdated");
    outdated.connection.start();
    outdated.latest().close();
    await flush();
    expect(outdated.connection.state).toBe("outdated");
  });

  it("closes a peer silent for 15 s, and nudge reconnects at once while waiting", async () => {
    const { connection, hello, sockets, advance } = setup();
    connection.start();
    hello();
    advance(15_000);
    await flush();
    expect(connection.state).toBe("waiting");
    connection.nudge();
    await flush();
    expect(sockets).toHaveLength(2);
    expect(connection.state).toBe("connecting");
  });

  it("gives up on a socket that never opens after 15 s", async () => {
    const { connection, sockets, advance } = setup();
    connection.start();
    advance(15_000);
    await flush();
    expect(sockets[0]?.closed).toBe(true);
    expect(connection.state).toBe("waiting");
  });

  it("does not wait for a close handshake that a dead peer never answers", async () => {
    const { connection, hello, latest, advance } = setup();
    connection.start();
    hello();
    const stuck = latest();
    stuck.close = () => {};
    advance(15_000);
    await flush();
    expect(connection.state).toBe("waiting");
  });

  it("treats a failing or hanging probe as offline and keeps retrying", async () => {
    const { connection, latest, delays } = setup(() => Promise.reject(new Error("boom")));
    connection.start();
    latest().close();
    await flush();
    expect(connection.state).toBe("waiting");
    expect(delays()).toEqual([backoffDelay(0, 0.5)]);
  });

  it("ignores a probe that answers after a stop and a new start", async () => {
    const probes: Array<(result: ProbeResult) => void> = [];
    const { connection, latest, sockets, delays } = setup(
      () => new Promise<ProbeResult>((resolve) => probes.push(resolve)),
    );
    connection.start();
    latest().close();
    await flush();
    connection.stop();
    connection.start();
    expect(sockets).toHaveLength(2);
    latest().close();
    await flush();
    probes[0]?.("ok");
    await flush();
    expect(delays()).toEqual([]);
    probes[1]?.("ok");
    await flush();
    expect(delays()).toHaveLength(1);
  });

  it("restarts the backoff only after 10 s of stable connection", async () => {
    const { connection, hello, latest, advance, delays } = setup();
    connection.start();
    hello();
    latest().close();
    await flush();
    advance(backoffDelay(0, 0.5));
    hello();
    latest().close();
    await flush();
    expect(delays()).toEqual([backoffDelay(1, 0.5)]);
    advance(backoffDelay(1, 0.5));
    hello();
    advance(10_000);
    latest().close();
    await flush();
    expect(delays()).toEqual([backoffDelay(0, 0.5)]);
    expect(connection.state).toBe("waiting");
  });

  it("stop closes the socket, ignores late frames and allows a fresh start", async () => {
    const { connection, hello, latest, sockets, delays } = setup();
    const frames: unknown[] = [];
    connection.onFrame((frame) => frames.push(frame));
    connection.start();
    hello();
    const first = latest();
    connection.stop();
    expect(first.closed).toBe(true);
    expect(connection.state).toBe("idle");
    first.receive({ id: 1, ok: true, result: {} });
    await flush();
    expect(frames).toEqual([]);
    expect(delays()).toEqual([]);
    connection.start();
    expect(sockets).toHaveLength(2);
    expect(connection.state).toBe("connecting");
  });

  it("sends only while open and reports whether the frame left", () => {
    const { connection, hello, latest } = setup();
    expect(connection.send({ id: 1 })).toBe(false);
    connection.start();
    expect(connection.send({ id: 1 })).toBe(false);
    hello();
    expect(connection.send({ id: 2 })).toBe(true);
    expect(latest().sent).toEqual(['{"id":2}']);
    latest().send = () => {
      throw new Error("InvalidStateError");
    };
    expect(connection.send({ id: 3 })).toBe(false);
  });

  it("ignores unparseable frames and notifies state listeners once per change", () => {
    const { connection, hello, latest } = setup();
    const states: string[] = [];
    connection.onState((state) => states.push(state));
    connection.start();
    hello();
    latest().onmessage?.({ data: "{not json" });
    connection.stop();
    expect(states).toEqual(["connecting", "open", "idle"]);
  });
});

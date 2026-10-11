import { describe, expect, it } from "vitest";
import {
  backoffDelay,
  createConnection,
  PROBE_TIMEOUT_MS,
  type ProbeResult,
  type SocketLike,
} from "./connection.ts";

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

function setup(
  probe: ProbeResult | (() => Promise<ProbeResult>) = "ok",
  options: { failCreates?: number } = {},
) {
  let failures = options.failCreates ?? 0;
  let now = 0;
  let nextId = 1;
  const pending = new Map<number, { at: number; ms: number; fn: () => void }>();
  const sockets: FakeSocket[] = [];
  const connection = createConnection({
    url: "ws://localhost/ws?proto=1",
    createSocket: () => {
      if (failures > 0) {
        failures--;
        throw new Error("SecurityError");
      }
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    probe: typeof probe === "function" ? probe : async () => probe,
    timers: {
      set: (fn, ms) => {
        pending.set(nextId, { at: now + ms, ms, fn });
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
    // the retry timers; the probe's own deadline is not one of them
    delays: () => [...pending.values()].filter((t) => t.ms !== PROBE_TIMEOUT_MS).map((t) => t.at - now),
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
  it("treats a socket that cannot even be created as a drop", async () => {
    const { connection, sockets, delays, advance } = setup("ok", { failCreates: 1 });
    connection.start();
    await flush();
    expect(connection.state).toBe("waiting");
    expect(delays()).toEqual([backoffDelay(0, 0.5)]);
    advance(backoffDelay(0, 0.5));
    expect(sockets).toHaveLength(1);
    expect(connection.state).toBe("connecting");
  });

  it("stops waiting on a probe that never answers and retries as if the network were down", async () => {
    const { connection, latest, delays, advance } = setup(() => new Promise<ProbeResult>(() => {}));
    connection.start();
    latest().close();
    await flush();
    expect(connection.state).toBe("waiting");
    expect(delays()).toEqual([]);
    advance(PROBE_TIMEOUT_MS);
    await flush();
    expect(delays()).toEqual([backoffDelay(0, 0.5)]);
  });

  describe("start", () => {
    it("revives a connection that ended signed-out, but not one that is outdated", async () => {
      const signedOut = setup("signed-out");
      signedOut.connection.start();
      signedOut.latest().close();
      await flush();
      expect(signedOut.connection.state).toBe("signed-out");
      signedOut.connection.start();
      expect(signedOut.connection.state).toBe("connecting");
      expect(signedOut.sockets).toHaveLength(2);
      const outdated = setup();
      outdated.connection.start();
      outdated.hello(2);
      outdated.connection.start();
      expect(outdated.connection.state).toBe("outdated");
      expect(outdated.sockets).toHaveLength(1);
    });

    it("begins the backoff again after a stop", async () => {
      const { connection, latest, advance, delays } = setup();
      connection.start();
      for (let attempt = 0; attempt < 3; attempt++) {
        latest().close();
        await flush();
        advance(backoffDelay(attempt, 0.5));
      }
      connection.stop();
      connection.start();
      latest().close();
      await flush();
      expect(delays()).toEqual([backoffDelay(0, 0.5)]);
    });
  });

  describe("nudge", () => {
    it("ends the wait when the probe says signed-out, without a new socket", async () => {
      let answer: ProbeResult = "ok";
      const { connection, latest, sockets, delays } = setup(async () => answer);
      connection.start();
      latest().close();
      await flush();
      answer = "signed-out";
      connection.nudge();
      await flush();
      expect(connection.state).toBe("signed-out");
      expect(sockets).toHaveLength(1);
      expect(delays()).toEqual([]);
    });

    it("does nothing while idle, open, or while a probe is already running", async () => {
      let probes = 0;
      const { connection, hello, latest, sockets } = setup(() => {
        probes++;
        return new Promise<ProbeResult>(() => {});
      });
      connection.nudge();
      expect(connection.state).toBe("idle");
      connection.start();
      hello();
      connection.nudge();
      expect(connection.state).toBe("open");
      latest().close();
      await flush();
      connection.nudge();
      await flush();
      expect(probes).toBe(1);
      expect(sockets).toHaveLength(1);
    });

    it("ignores a probe that answers after a stop", async () => {
      const answers: Array<(result: ProbeResult) => void> = [];
      let calls = 0;
      const { connection, latest, sockets } = setup(() =>
        calls++ === 0 ? Promise.resolve("ok") : new Promise<ProbeResult>((resolve) => answers.push(resolve)),
      );
      connection.start();
      latest().close();
      await flush();
      connection.nudge();
      connection.stop();
      answers[0]?.("ok");
      await flush();
      expect(sockets).toHaveLength(1);
      expect(connection.state).toBe("idle");
    });

    it("replaces a socket that is stuck connecting", () => {
      const { connection, hello, latest, sockets } = setup();
      connection.start();
      const stuck = latest();
      connection.nudge();
      expect(stuck.closed).toBe(true);
      expect(sockets).toHaveLength(2);
      expect(connection.state).toBe("connecting");
      stuck.receive({ protocol: 1, capabilities: [], serverVersion: "0" });
      expect(connection.state).toBe("connecting");
      hello();
      expect(connection.state).toBe("open");
    });
  });
});

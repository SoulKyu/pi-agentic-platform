import { describe, expect, it } from "vitest";
import { backoffDelay } from "./connection.ts";
import { connectionBed as setup, flush } from "./testing.ts";

describe("connection supervisor: manual retry and retry visibility", () => {
  it("retry.manual-skips-ladder: a manual retry goes back to the first rung and reconnects at once", async () => {
    const { connection, latest, sockets, advance, delays } = setup();
    connection.start();
    for (let rung = 0; rung < 3; rung++) {
      latest().close();
      await flush();
      advance(backoffDelay(rung, 0.5));
    }
    latest().close();
    await flush();
    expect(connection.attempt).toBe(4);
    expect(delays()).toEqual([backoffDelay(3, 0.5)]);
    const before = sockets.length;
    connection.retry();
    expect(connection.attempt).toBe(0);
    await flush();
    expect(sockets).toHaveLength(before + 1);
    expect(connection.state).toBe("connecting");
    latest().close();
    await flush();
    expect(delays()).toEqual([backoffDelay(0, 0.5)]);
  });

  it("retry.double-tap: a second tap during the probe opens no second socket", async () => {
    const { connection, latest, sockets } = setup();
    connection.start();
    latest().close();
    await flush();
    const before = sockets.length;
    connection.retry();
    connection.retry();
    await flush();
    expect(sockets).toHaveLength(before + 1);
  });

  it("retry.exposes-retryAt: now plus the delay while waiting, null once a socket is being opened", async () => {
    const { connection, latest, advance, hello } = setup();
    connection.start();
    expect(connection.retryAt).toBeNull();
    hello();
    advance(1_000);
    expect(connection.retryAt).toBeNull();
    latest().close();
    await flush();
    expect(connection.attempt).toBe(1);
    expect(connection.retryAt).toBe(1_000 + backoffDelay(0, 0.5));
    advance(backoffDelay(0, 0.5));
    expect(connection.state).toBe("connecting");
    expect(connection.retryAt).toBeNull();
    hello();
    expect(connection.retryAt).toBeNull();
  });

  it("retry.exposes-retryAt: stop clears it", async () => {
    const { connection, latest } = setup();
    connection.start();
    latest().close();
    await flush();
    expect(connection.retryAt).not.toBeNull();
    connection.stop();
    expect(connection.retryAt).toBeNull();
  });

  it("signed-out.stops-retrying: no timer, no socket and no retryAt once the probe says signed out", async () => {
    const { connection, latest, sockets, advance, delays } = setup("signed-out");
    connection.start();
    latest().close();
    await flush();
    expect(connection.state).toBe("signed-out");
    expect(connection.retryAt).toBeNull();
    expect(delays()).toEqual([]);
    advance(120_000);
    expect(sockets).toHaveLength(1);
    connection.retry();
    await flush();
    expect(sockets).toHaveLength(1);
  });
});

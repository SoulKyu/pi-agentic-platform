import { connect } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EGRESS_LIMITS } from "@pap/contracts";
import { blockedAddress } from "../../kernel/net/address.ts";
import {
  type Bed,
  bodyOf,
  closed,
  connectLine,
  denyOf,
  exchange,
  getLine,
  nextData,
  startBed,
  statusOf,
  tunnel,
} from "./testing/bed.ts";
import type { Limits } from "./index.ts";

let bed: Bed;
afterEach(async () => {
  await bed.stop();
});

const small = (over: Partial<Limits>): Limits => ({ ...EGRESS_LIMITS, ...over });

describe("limits (M11R236)", () => {
  it("the 33rd connection of a command is refused with limit, and a freed slot is reusable", async () => {
    bed = await startBed({ limits: small({ connections: 2 }) });
    const { path } = await bed.listen();
    const a = await tunnel(path, "allowed.test:443");
    const b = await tunnel(path, "allowed.test:443");
    const third = await exchange(path, connectLine("allowed.test:443"));
    expect(statusOf(third)).toBe("HTTP/1.1 503 Service Unavailable");
    expect(denyOf(third)).toBe("limit");
    a.socket.destroy();
    await vi.waitFor(
      async () => {
        const again = await tunnel(path, "allowed.test:443");
        again.socket.destroy();
        expect(statusOf(again.head)).toBe("HTTP/1.1 200 Connection Established");
      },
      { timeout: 5000 },
    );
    b.socket.destroy();
  });

  it("a request head past 16 KiB gets 431", async () => {
    bed = await startBed();
    const { path } = await bed.listen();
    const reply = await exchange(
      path,
      getLine("http://allowed.test/", `X-Pad: ${"a".repeat(17 * 1024)}\r\n`),
    );
    expect(statusOf(reply)).toBe("HTTP/1.1 431 Request Header Fields Too Large");
    expect(bed.seen).toEqual([]);
  });

  it("closes a connection whose head is slower than 10 s", async () => {
    bed = await startBed();
    const { path } = await bed.listen();
    const socket = connect(path);
    socket.on("error", () => {});
    socket.write("GET http://allowed.test/ HTT");
    await bed.clock.advance(EGRESS_LIMITS.headMs - 1);
    expect(socket.destroyed).toBe(false);
    await bed.clock.advance(2);
    await closed(socket);
    expect(bed.calls.resolve).toEqual([]);
  });

  it("closes an idle tunnel after 120 s, and activity postpones it", async () => {
    bed = await startBed();
    const { path } = await bed.listen();
    const { socket } = await tunnel(path, "allowed.test:443");
    await bed.clock.advance(EGRESS_LIMITS.idleMs - 1000);
    const echoed = nextData(socket);
    socket.write("alive");
    expect(await echoed).toBe("alive");
    await bed.clock.advance(EGRESS_LIMITS.idleMs - 1000);
    expect(socket.destroyed).toBe(false);
    await bed.clock.advance(1001);
    await closed(socket);
  });

  it("closes a connection that lives past its time cap even while it is busy", async () => {
    bed = await startBed({ limits: small({ idleMs: 1000, connectionMs: 2500 }) });
    const { path } = await bed.listen();
    const { socket } = await tunnel(path, "allowed.test:443");
    for (let round = 0; round < 2; round += 1) {
      await bed.clock.advance(900);
      const echoed = nextData(socket);
      socket.write("x");
      expect(await echoed).toBe("x");
    }
    await bed.clock.advance(900);
    await closed(socket);
  });

  it("closes the connection past the byte cap, counts exactly, and refuses new ones", async () => {
    bed = await startBed({ limits: small({ bytes: 10 }) });
    const listener = await bed.listen();
    const { socket } = await tunnel(listener.path, "allowed.test:443");
    const echoed = nextData(socket);
    socket.write("12345");
    expect(await echoed).toBe("12345");
    socket.write("678901");
    await closed(socket);
    const refused = await exchange(listener.path, connectLine("allowed.test:443"));
    expect(denyOf(refused)).toBe("limit");
    const report = await listener.close();
    expect(report.truncated).toBe(false);
    expect(report.up).toBe(11);
    expect(report.down).toBe(5);
  });

  it("refuses an upstream connection past the daemon-wide cap, across commands", async () => {
    bed = await startBed({ limits: small({ upstream: 1 }) });
    const first = await bed.listen();
    const second = await bed.listen();
    const held = await tunnel(first.path, "allowed.test:443");
    const refused = await exchange(second.path, connectLine("allowed.test:443"));
    expect(statusOf(refused)).toBe("HTTP/1.1 503 Service Unavailable");
    expect(denyOf(refused)).toBe("limit");
    expect(bodyOf(refused)).toBe("");
    held.socket.destroy();
    const report = await second.close();
    expect(report.hosts).toEqual([
      { host: "allowed.test", port: 443, kind: "connect", verdict: "refused", reason: "limit" },
    ]);
  });

  it("logs one egress_limit line per minute, with no host and no content", async () => {
    bed = await startBed({ limits: small({ connections: 1 }) });
    const { path } = await bed.listen();
    const held = await tunnel(path, "allowed.test:443");
    await exchange(path, connectLine("allowed.test:443"));
    await exchange(path, connectLine("allowed.test:443"));
    const lines = () => bed.lines.filter((line) => line["msg"] === "egress_limit");
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatchObject({ agentId: "atlas-1a2b", sessionId: "s1", what: "connections" });
    await bed.clock.advance(61_000);
    await exchange(path, connectLine("allowed.test:443"));
    expect(lines()).toHaveLength(2);
    expect(JSON.stringify(lines())).not.toContain("allowed.test");
    held.socket.destroy();
  });

  it("refuses a private answer with the real deny list", async () => {
    bed = await startBed({ resolve: async () => ["10.0.0.1"], denies: blockedAddress });
    const { path } = await bed.listen();
    expect(denyOf(await exchange(path, connectLine("allowed.test:443")))).toBe("blocked_ip");
  });
});

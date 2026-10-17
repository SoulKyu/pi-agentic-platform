import { Socket } from "node:net";
import { EGRESS_LIMITS } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { blockedAddress } from "../../kernel/net/address.ts";
import {
  type Bed,
  denyOf,
  exchange,
  nextData,
  scopeOf,
  startBed,
  statusOf,
  tunnel,
  connectLine,
} from "./testing/bed.ts";

let bed: Bed;
afterEach(async () => {
  await bed.stop();
});

const path = async (b: Bed, scope = scopeOf()): Promise<string> => {
  const listener = await b.listen(scope);
  return listener.path;
};

describe("CONNECT through the egress proxy (M11R235)", () => {
  it("opens a tunnel to a listed host on 443 and moves bytes both ways", async () => {
    bed = await startBed();
    const { socket, head } = await tunnel(await path(bed), "allowed.test:443");
    expect(statusOf(head)).toBe("HTTP/1.1 200 Connection Established");
    const echoed = nextData(socket);
    socket.write("ping");
    expect(await echoed).toBe("ping");
    socket.destroy();
  });

  it("refuses every port but 443 with the port reason", async () => {
    bed = await startBed();
    const socketPath = await path(bed);
    for (const target of ["allowed.test:80", "allowed.test:22", "allowed.test:8443"]) {
      const reply = await exchange(socketPath, connectLine(target));
      expect(statusOf(reply)).toBe("HTTP/1.1 403 Forbidden");
      expect(denyOf(reply)).toBe("port");
    }
    expect(bed.calls).toEqual({ resolve: [], connect: [] });
  });

  it("refuses a host that is not on the list before any lookup", async () => {
    bed = await startBed();
    const reply = await exchange(await path(bed), connectLine("evil.test:443"));
    expect(statusOf(reply)).toBe("HTTP/1.1 403 Forbidden");
    expect(denyOf(reply)).toBe("not_listed");
    expect(bed.calls).toEqual({ resolve: [], connect: [] });
  });

  it("refuses an IP literal whatever the list says", async () => {
    bed = await startBed();
    const socketPath = await path(bed, scopeOf({ hosts: null }));
    for (const target of ["[::1]:443", "127.0.0.1:443", "169.254.169.254:443", "[::ffff:7f00:1]:443"]) {
      expect(denyOf(await exchange(socketPath, connectLine(target)))).toBe("ip_literal");
    }
    expect(bed.calls.resolve).toEqual([]);
  });

  it("refuses names that are not host names", async () => {
    bed = await startBed();
    const socketPath = await path(bed, scopeOf({ hosts: null }));
    for (const target of ["a_b.example:443", "localhost:443", "nocolon", ":443", "a.example:"]) {
      expect(denyOf(await exchange(socketPath, connectLine(target)))).toBe("bad_target");
    }
    // Raw non-ASCII never reaches the proxy: the HTTP parser answers 400 first.
    expect(statusOf(await exchange(socketPath, connectLine("b\u00fccher.example:443")))).toBe(
      "HTTP/1.1 400 Bad Request",
    );
    expect(bed.calls.resolve).toEqual([]);
  });

  it("refuses the whole name when any answer is blocked, and never connects (anti-rebinding)", async () => {
    bed = await startBed({ resolve: async () => ["198.51.100.1", "10.0.0.1"], denies: blockedAddress });
    const reply = await exchange(await path(bed), connectLine("allowed.test:443"));
    expect(denyOf(reply)).toBe("blocked_ip");
    expect(bed.calls.connect).toEqual([]);
  });

  it("resolves once per request and connects to the checked address, not the name", async () => {
    const answers = [["203.0.113.7"], ["127.0.0.1"]];
    bed = await startBed({
      resolve: async () => answers.shift() ?? [],
      denies: (ip) => ip !== "203.0.113.7" && blockedAddress(ip),
    });
    const socketPath = await path(bed);
    const first = await tunnel(socketPath, "allowed.test:443");
    expect(statusOf(first.head)).toBe("HTTP/1.1 502 Bad Gateway");
    expect(bed.calls.resolve).toEqual(["allowed.test"]);
    expect(bed.calls.connect).toEqual([{ ip: "203.0.113.7", port: 443 }]);
    const second = await exchange(socketPath, connectLine("allowed.test:443"));
    expect(denyOf(second)).toBe("blocked_ip");
    expect(bed.calls.resolve).toEqual(["allowed.test", "allowed.test"]);
    expect(bed.calls.connect).toHaveLength(1);
  });

  it("tries every answer in order: a first address that refuses the connection falls through to the next", async () => {
    // 127.7.0.3 is dead.test: a loopback port nobody listens on. 127.7.0.1 is allowed.test: the echo server.
    bed = await startBed({ resolve: async () => ["127.7.0.3", "127.7.0.1"] });
    const { socket, head } = await tunnel(await path(bed), "allowed.test:443");
    expect(statusOf(head)).toBe("HTTP/1.1 200 Connection Established");
    const echoed = nextData(socket);
    socket.write("ping");
    expect(await echoed).toBe("ping");
    expect(bed.calls.connect).toEqual([
      { ip: "127.7.0.3", port: 443 },
      { ip: "127.7.0.1", port: 443 },
    ]);
    socket.destroy();
  });

  it("answers 502 once every answer has failed", async () => {
    bed = await startBed({ resolve: async () => ["127.7.0.3", "127.7.0.9"] });
    const { head } = await tunnel(await path(bed), "allowed.test:443");
    expect(statusOf(head)).toBe("HTTP/1.1 502 Bad Gateway");
    expect(bed.calls.connect.map((call) => call.ip)).toEqual(["127.7.0.3", "127.7.0.9"]);
  });

  /** A socket that stays "connecting" until the test emits `connect` or destroys it. */
  const hanging = (): Socket => Object.defineProperty(new Socket(), "connecting", { value: true });

  it("stops trying further answers once the command is gone", async () => {
    const first = hanging();
    bed = await startBed({ resolve: async () => ["127.7.0.3", "127.7.0.1"], connect: () => first });
    const listener = await bed.listen();
    const reply = exchange(listener.path, connectLine("allowed.test:443"));
    await vi.waitFor(() => expect(bed.calls.connect).toHaveLength(1), { timeout: 5000 });
    await listener.close();
    await reply;
    await bed.clock.advance(0);
    expect(bed.calls.connect).toHaveLength(1);
  });

  it("does not try a further answer once the upstream limit is reached meanwhile", async () => {
    const limits: Record<keyof typeof EGRESS_LIMITS, number> = { ...EGRESS_LIMITS };
    const first = hanging();
    bed = await startBed({
      resolve: async () => ["127.7.0.3", "127.7.0.1"],
      limits,
      connect: () => first,
    });
    const reply = exchange(await path(bed), connectLine("allowed.test:443"));
    await vi.waitFor(() => expect(bed.calls.connect).toHaveLength(1), { timeout: 5000 });
    limits.upstream = 0; // another command took the room while the first address was being tried
    first.destroy();
    expect(statusOf(await reply)).toBe("HTTP/1.1 502 Bad Gateway");
    expect(bed.calls.connect).toHaveLength(1);
  });

  it("opens nothing for a connection that went away just as its address answered", async () => {
    const up = hanging();
    bed = await startBed({ connect: () => up });
    const listener = await bed.listen();
    const reply = exchange(listener.path, connectLine("allowed.test:443"));
    await vi.waitFor(() => expect(bed.calls.connect).toHaveLength(1), { timeout: 5000 });
    up.emit("connect");
    void listener.close();
    await reply;
    await bed.clock.advance(0);
    expect(up.destroyed).toBe(true);
    expect(up.listenerCount("data")).toBe(0);
  });

  it("answers dns_failed when the name does not resolve", async () => {
    bed = await startBed({ resolve: async () => [] });
    expect(denyOf(await exchange(await path(bed), connectLine("allowed.test:443")))).toBe("dns_failed");
  });

  it("a thread grant added later opens the host for the next connection (read live)", async () => {
    bed = await startBed();
    const grants: string[] = [];
    const socketPath = await path(bed, scopeOf({ hosts: [] }, grants));
    expect(denyOf(await exchange(socketPath, connectLine("allowed2.test:443")))).toBe("not_listed");
    grants.push("allowed2.test");
    const { head, socket } = await tunnel(socketPath, "allowed2.test:443");
    expect(statusOf(head)).toBe("HTTP/1.1 200 Connection Established");
    socket.destroy();
  });

  it("a trusted source is allowed off the list", async () => {
    bed = await startBed();
    const { head, socket } = await tunnel(
      await path(bed, scopeOf({ hosts: [], trustedSources: ["allowed.test"] })),
      "allowed.test:443",
    );
    expect(statusOf(head)).toBe("HTTP/1.1 200 Connection Established");
    socket.destroy();
  });

  it("lower-cases the target and drops one final dot", async () => {
    bed = await startBed();
    const { head, socket } = await tunnel(await path(bed), "ALLOWED.Test.:443");
    expect(statusOf(head)).toBe("HTTP/1.1 200 Connection Established");
    expect(bed.calls.resolve).toEqual(["allowed.test"]);
    socket.destroy();
  });

  it("records each verdict in the report once, with the reason", async () => {
    bed = await startBed();
    const listener = await bed.listen();
    await exchange(listener.path, connectLine("evil.test:443"));
    await exchange(listener.path, connectLine("evil.test:443"));
    await exchange(listener.path, connectLine("allowed.test:22"));
    const tunneled = await tunnel(listener.path, "allowed.test:443");
    tunneled.socket.destroy();
    const report = await listener.close();
    expect(report.hosts).toEqual([
      { host: "evil.test", port: 443, kind: "connect", verdict: "refused", reason: "not_listed" },
      { host: "allowed.test", port: 22, kind: "connect", verdict: "refused", reason: "port" },
      { host: "allowed.test", port: 443, kind: "connect", verdict: "allowed" },
    ]);
    expect(report.truncated).toBe(false);
  });
});

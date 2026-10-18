import { afterEach, describe, expect, it } from "vitest";
import { blockedStrict } from "../../kernel/net/address-strict.ts";
import {
  type Bed,
  connectLine,
  denyOf,
  exchange,
  scopeOf,
  startBed,
  statusOf,
  tunnel,
  getLine,
} from "./testing/bed.ts";

/**
 * M13R14/R46: the egress proxy refuses the reserved ranges push already refuses. Every address below is only a value a
 * stub resolver returns and the check must refuse; no socket is opened to any of them (W5-R50).
 */
let bed: Bed;
afterEach(async () => {
  await bed.stop();
});

/** Connected before the change (`blockedAddress` lets them through): the RED set. */
const RESERVED = [
  "192.0.2.1",
  "198.51.100.7",
  "203.0.113.9",
  "192.88.99.1",
  "2001:db8::1",
  "2001::1",
  "100::1",
  "::ffff:192.0.2.1",
  "2002:c000:0201::",
  "3fff::1",
  "2001:2::1",
];

/** Refused by the base check already: kept as pins. */
const ALREADY_BLOCKED = [
  "64:ff9b::192.0.2.1",
  "10.0.0.1",
  "127.0.0.1",
  "169.254.169.254",
  "192.168.1.5",
  "::1",
  "fd00::1",
];

const path = async (b: Bed): Promise<string> => (await b.listen(scopeOf())).path;

describe("the egress proxy refuses the strict reserved ranges (M13R14)", () => {
  it.each([...RESERVED, ...ALREADY_BLOCKED])(
    "CONNECT to a name resolving to %s is blocked_ip, nothing is dialled",
    async (ip) => {
      bed = await startBed({ resolve: async () => [ip], denies: blockedStrict });
      const reply = await exchange(await path(bed), connectLine("allowed.test:443"));
      expect(statusOf(reply)).toBe("HTTP/1.1 403 Forbidden");
      expect(denyOf(reply)).toBe("blocked_ip");
      expect(bed.calls.connect).toEqual([]);
    },
  );

  it.each(RESERVED)(
    "a plain request to a name resolving to %s is blocked_ip, nothing is dialled",
    async (ip) => {
      bed = await startBed({ resolve: async () => [ip], denies: blockedStrict });
      const reply = await exchange(await path(bed), getLine("http://allowed.test/"));
      expect(denyOf(reply)).toBe("blocked_ip");
      expect(bed.calls.connect).toEqual([]);
    },
  );

  it("one reserved answer among public-looking ones refuses the whole name", async () => {
    // 127.7.0.1 stands in for a public answer (exempted by hand); only the reserved one can refuse the name.
    bed = await startBed({
      resolve: async () => ["127.7.0.1", "192.0.2.1"],
      denies: (ip) => ip !== "127.7.0.1" && blockedStrict(ip),
    });
    expect(denyOf(await exchange(await path(bed), connectLine("allowed.test:443")))).toBe("blocked_ip");
    expect(bed.calls.connect).toEqual([]);
  });

  it("a literal-IP CONNECT is refused before any lookup, whatever the list says", async () => {
    bed = await startBed({ denies: blockedStrict });
    const socketPath = (await bed.listen(scopeOf({ hosts: null }))).path;
    for (const target of ["192.0.2.1:443", "[2001:db8::1]:443", "[::ffff:192.0.2.1]:443"]) {
      expect(denyOf(await exchange(socketPath, connectLine(target)))).toBe("ip_literal");
    }
    expect(bed.calls).toEqual({ resolve: [], connect: [] });
  });

  it("an address outside every reserved range still reaches (the test seam maps it to the loopback echo)", async () => {
    // 127.7.0.1 is allowed.test on the loopback bed; the stand-in for "public" is exempted from the strict check by hand.
    bed = await startBed({ denies: (ip) => ip !== "127.7.0.1" && blockedStrict(ip) });
    const { socket, head } = await tunnel(await path(bed), "allowed.test:443");
    expect(statusOf(head)).toBe("HTTP/1.1 200 Connection Established");
    expect(bed.calls.connect).toEqual([{ ip: "127.7.0.1", port: 443 }]);
    socket.destroy();
  });
});

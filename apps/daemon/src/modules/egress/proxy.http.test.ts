import { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { blockedAddress } from "./address.ts";
import { type Bed, bodyOf, denyOf, exchange, getLine, scopeOf, startBed, statusOf } from "./testing/bed.ts";

let bed: Bed;
afterEach(async () => {
  await bed.stop();
});

const NOT_LISTED = (host: string): string =>
  `pap egress proxy: ${host} is not on this agent's host list. In the agent's thread, ask the owner with network_request {"host": "${host}"}.\n`;

describe("plain HTTP through the egress proxy (M11R235)", () => {
  it("forwards an absolute-URI GET with connection: close and without proxy-* headers", async () => {
    bed = await startBed();
    const { path } = await bed.listen();
    const reply = await exchange(
      path,
      getLine("http://allowed.test/a/b?q=1", "Authorization: Bearer t\r\nProxy-Authorization: Basic x\r\n"),
    );
    expect(statusOf(reply)).toBe("HTTP/1.1 200 OK");
    expect(bodyOf(reply)).toBe("origin ok");
    expect(bed.seen).toHaveLength(1);
    const seen = bed.seen[0];
    expect(seen?.url).toBe("/a/b?q=1");
    expect(seen?.headers["host"]).toBe("allowed.test");
    expect(seen?.headers["connection"]).toBe("close");
    expect(seen?.headers["authorization"]).toBe("Bearer t");
    expect(Object.keys(seen?.headers ?? {}).filter((name) => name.startsWith("proxy-"))).toEqual([]);
  });

  it("forwards any method with its body", async () => {
    bed = await startBed();
    const { path } = await bed.listen();
    const reply = await exchange(
      path,
      "POST http://allowed.test:80/submit HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\n\r\nhello",
    );
    expect(statusOf(reply)).toBe("HTTP/1.1 200 OK");
    expect(bed.seen[0]).toMatchObject({ method: "POST", url: "/submit", body: "hello" });
  });

  it("relays the origin's status and headers", async () => {
    bed = await startBed({ reply: () => ({ status: 404, headers: { "x-origin": "yes" }, body: "nope" }) });
    const { path } = await bed.listen();
    const reply = await exchange(path, getLine("http://allowed.test/missing"));
    expect(statusOf(reply)).toBe("HTTP/1.1 404 Not Found");
    expect(reply.toLowerCase()).toContain("x-origin: yes");
    expect(bodyOf(reply)).toBe("nope");
  });

  it("refuses a host off the list with 403, the header and the fixed sentence, before any lookup", async () => {
    bed = await startBed();
    const { path } = await bed.listen();
    const reply = await exchange(path, getLine("http://evil.test/"));
    expect(statusOf(reply)).toBe("HTTP/1.1 403 Forbidden");
    expect(denyOf(reply)).toBe("not_listed");
    expect(bodyOf(reply)).toBe(NOT_LISTED("evil.test"));
    expect(bed.calls).toEqual({ resolve: [], connect: [] });
    expect(bed.seen).toEqual([]);
  });

  it("refuses https: absolute URIs, OPTIONS * and a relative URI", async () => {
    bed = await startBed();
    const { path } = await bed.listen(scopeOf({ hosts: null }));
    const https = await exchange(path, getLine("https://allowed.test/"));
    expect(statusOf(https)).toBe("HTTP/1.1 403 Forbidden");
    expect(denyOf(https)).toBe("scheme");
    const star = await exchange(path, "OPTIONS * HTTP/1.1\r\nHost: x\r\n\r\n");
    expect(statusOf(star)).toBe("HTTP/1.1 403 Forbidden");
    expect(denyOf(star)).toBe("scheme");
    const relative = await exchange(path, getLine("/just/a/path"));
    expect(statusOf(relative)).toBe("HTTP/1.1 400 Bad Request");
    expect(denyOf(relative)).toBe("bad_request");
    expect(bed.calls).toEqual({ resolve: [], connect: [] });
  });

  it("allows port 80 only", async () => {
    bed = await startBed();
    const { path } = await bed.listen();
    const reply = await exchange(path, getLine("http://allowed.test:8080/"));
    expect(denyOf(reply)).toBe("port");
    expect(bodyOf(reply)).toBe("pap egress proxy: only ports 80 and 443 are open.\n");
  });

  it("refuses IP literals, including the spellings the URL parser turns into one", async () => {
    bed = await startBed();
    const { path } = await bed.listen(scopeOf({ hosts: null }));
    for (const url of [
      "http://127.0.0.1/",
      "http://[::1]/",
      "http://0x7f.1/",
      "http://2130706433/",
      "http://169.254.169.254/latest",
    ]) {
      expect(denyOf(await exchange(path, getLine(url)))).toBe("ip_literal");
    }
    expect(bed.calls.resolve).toEqual([]);
  });

  it("refuses a name with one blocked answer with its own sentence", async () => {
    bed = await startBed({ resolve: async () => ["198.51.100.1", "192.168.1.5"], denies: blockedAddress });
    const { path } = await bed.listen();
    const reply = await exchange(path, getLine("http://allowed.test/"));
    expect(denyOf(reply)).toBe("blocked_ip");
    expect(bodyOf(reply)).toBe("pap egress proxy: allowed.test resolves to a private or reserved address.\n");
    expect(bed.calls.connect).toEqual([]);
  });

  it("names an unreadable host as such", async () => {
    bed = await startBed();
    const { path } = await bed.listen(scopeOf({ hosts: null }));
    const reply = await exchange(path, getLine("http://a_b.test/"));
    expect(denyOf(reply)).toBe("bad_target");
    expect(bodyOf(reply)).toBe("pap egress proxy: a_b.test is not a valid host name.\n");
  });

  it("answers 502 when the checked address cannot be reached", async () => {
    bed = await startBed({ resolve: async () => ["203.0.113.7"] });
    const { path } = await bed.listen();
    const reply = await exchange(path, getLine("http://allowed.test/"));
    expect(statusOf(reply)).toBe("HTTP/1.1 502 Bad Gateway");
    expect(bed.calls.connect).toEqual([{ ip: "203.0.113.7", port: 80 }]);
  });

  it("tries every answer in order for a plain request too", async () => {
    bed = await startBed({ resolve: async () => ["127.7.0.3", "127.7.0.1"] });
    const { path } = await bed.listen();
    const reply = await exchange(path, getLine("http://allowed.test/"));
    expect(statusOf(reply)).toBe("HTTP/1.1 200 OK");
    expect(bed.calls.connect.map((call) => call.ip)).toEqual(["127.7.0.3", "127.7.0.1"]);
  });

  it("sends nothing upstream for a request whose connection went away just as its address answered", async () => {
    const up = Object.defineProperty(new Socket(), "connecting", { value: true });
    bed = await startBed({ connect: () => up });
    const listener = await bed.listen();
    const reply = exchange(listener.path, getLine("http://allowed.test/"));
    await vi.waitFor(() => expect(bed.calls.connect).toHaveLength(1), { timeout: 5000 });
    up.emit("connect");
    void listener.close();
    await reply;
    await bed.clock.advance(0);
    expect(up.destroyed).toBe(true);
    expect(up.listenerCount("data")).toBe(0);
    expect(bed.seen).toEqual([]);
  });

  it("records an http entry per verdict", async () => {
    bed = await startBed();
    const listener = await bed.listen();
    await exchange(listener.path, getLine("http://allowed.test/x"));
    await exchange(listener.path, getLine("http://evil.test/x"));
    const report = await listener.close();
    expect(report.hosts).toEqual([
      { host: "allowed.test", port: 80, kind: "http", verdict: "allowed" },
      { host: "evil.test", port: 80, kind: "http", verdict: "refused", reason: "not_listed" },
    ]);
  });
});

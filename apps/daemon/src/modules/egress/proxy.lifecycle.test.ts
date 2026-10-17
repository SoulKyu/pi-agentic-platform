import { existsSync, statSync } from "node:fs";
import { connect, createServer, Socket } from "node:net";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type Bed,
  closed,
  connectLine,
  exchange,
  getLine,
  scopeOf,
  startBed,
  tunnel,
} from "./testing/bed.ts";

const label = (host: string): string =>
  `h:${createHash("sha256").update(host).digest("hex").slice(0, 12)} (len ${host.length})`;

let bed: Bed;
afterEach(async () => {
  await bed.stop();
});

const lineOf = (name: string): Record<string, unknown> | undefined =>
  bed.lines.find((line) => line["msg"] === name);

describe("a command's listener (M11R232)", () => {
  it("close stops accepting, destroys live sockets and removes the socket file", async () => {
    bed = await startBed();
    const listener = await bed.listen();
    const live = await tunnel(listener.path, "allowed.test:443");
    expect(existsSync(listener.path)).toBe(true);
    await listener.close();
    await closed(live.socket);
    expect(existsSync(listener.path)).toBe(false);
    const refused = await new Promise<string>((resolve) => {
      const socket = connect(listener.path);
      socket.on("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "?"));
    });
    expect(["ENOENT", "ECONNREFUSED"]).toContain(refused);
  });

  it("the socket is readable by its owner alone (0600)", async () => {
    bed = await startBed();
    const listener = await bed.listen();
    expect(statSync(listener.path).mode & 0o777).toBe(0o600);
  });

  it("two commands keep separate reports", async () => {
    bed = await startBed();
    const one = await bed.listen();
    const two = await bed.listen();
    await exchange(one.path, getLine("http://allowed.test/"));
    await exchange(two.path, getLine("http://evil.test/"));
    expect((await one.close()).hosts.map((entry) => entry.host)).toEqual(["allowed.test"]);
    expect((await two.close()).hosts.map((entry) => entry.host)).toEqual(["evil.test"]);
  });

  it("a connection handled after the close is destroyed before any lookup or upstream byte", async () => {
    bed = await startBed();
    const listener = await bed.listen();
    await listener.close();
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const client = connect((server.address() as { port: number }).port, "127.0.0.1");
    const accepted = await new Promise<Socket>((resolve) => server.once("connection", resolve));
    accepted.on("error", () => {});
    client.on("error", () => {});
    listener.server.emit("connection", accepted);
    client.write(connectLine("allowed.test:443"));
    await closed(accepted);
    expect(bed.calls).toEqual({ resolve: [], connect: [] });
    client.destroy();
    server.close();
  });

  it("a lookup that finishes after the close connects to nothing", async () => {
    let release: (answers: string[]) => void = () => {};
    const pending = new Promise<string[]>((resolve) => {
      release = resolve;
    });
    bed = await startBed({ resolve: () => pending });
    const listener = await bed.listen();
    const reply = exchange(listener.path, connectLine("allowed.test:443"));
    await vi.waitFor(() => expect(bed.calls.resolve).toHaveLength(1), { timeout: 5000 });
    await listener.close();
    release(["203.0.113.7"]);
    await reply;
    await bed.clock.advance(0);
    expect(bed.calls.connect).toEqual([]);
  });

  it("deduplicates the report and marks the 65th distinct entry as truncated", async () => {
    bed = await startBed();
    const listener = await bed.listen(scopeOf({ hosts: [] }));
    await exchange(listener.path, getLine("http://h0.example/"));
    await exchange(listener.path, getLine("http://h0.example/other"));
    for (let i = 1; i <= 64; i += 1) await exchange(listener.path, getLine(`http://h${i}.example/`));
    const report = await listener.close();
    expect(report.hosts).toHaveLength(64);
    expect(report.hosts[0]).toMatchObject({ host: "h0.example" });
    expect(report.truncated).toBe(true);
  });

  it("closing twice answers the same report", async () => {
    bed = await startBed();
    const listener = await bed.listen();
    await exchange(listener.path, getLine("http://allowed.test/"));
    expect(await listener.close()).toEqual(await listener.close());
  });
});

describe("what the proxy records (M11R237)", () => {
  it("writes one egress_command line with hosts and counts, nothing else", async () => {
    bed = await startBed();
    const listener = await bed.listen();
    await exchange(listener.path, getLine("http://allowed.test/"));
    await exchange(listener.path, getLine("http://evil.test/"));
    await listener.close();
    expect(bed.lines.filter((line) => line["msg"] === "egress_command")).toHaveLength(1);
    expect(lineOf("egress_command")).toMatchObject({
      sessionId: "s1",
      agentId: "atlas-1a2b",
      allowed: 1,
      refused: 1,
      up: 0,
      down: 9,
      // The literal label of evil.test, pinned in pi-host's audit-args.test.ts too: the daemon's log and the worker's audit cannot drift apart.
      hosts: ["allowed.test", "h:9834f30f8b80 (len 9)"],
    });
  });

  it("keeps a canary in the path, headers and body out of every log line, report and error", async () => {
    bed = await startBed({ reply: () => ({ status: 200, body: "fine" }) });
    const listener = await bed.listen();
    const canary = "CANARY-7f3a";
    const request = `POST http://allowed.test/${canary}-path?q=${canary} HTTP/1.1\r\nHost: x\r\nX-Canary: ${canary}\r\nContent-Length: ${canary.length}\r\n\r\n${canary}`;
    await exchange(listener.path, request);
    await exchange(
      listener.path,
      `GET http://evil.test/${canary} HTTP/1.1\r\nHost: x\r\nX-Canary: ${canary}\r\n\r\n`,
    );
    const report = await listener.close();
    expect(JSON.stringify([bed.lines, report])).not.toContain(canary);
  });

  it("logs a host as is only when it equals a list entry, a trusted source or a grant (W5-R54)", async () => {
    bed = await startBed();
    const listener = await bed.listen(
      scopeOf({
        hosts: ["allowed.test", "*.wild.test"],
        trustedSources: ["allowed2.test"],
        grants: () => ["granted.test"],
      }),
    );
    for (const host of ["allowed.test", "allowed2.test", "granted.test"])
      await exchange(listener.path, getLine(`http://${host}/`));
    await listener.close();
    expect(lineOf("egress_command")?.["hosts"]).toEqual(["allowed.test", "allowed2.test", "granted.test"]);
  });

  it("logs a host matched by a wildcard, a refused host and an unlisted one as a hash and a length", async () => {
    bed = await startBed();
    const listener = await bed.listen(scopeOf({ hosts: ["*.wild.test"] }));
    for (const host of ["api.wild.test", "evil.test", "sk-live-abcdef12.exfil.test"])
      await exchange(listener.path, getLine(`http://${host}/`));
    await listener.close();
    expect(lineOf("egress_command")?.["hosts"]).toEqual([
      label("api.wild.test"),
      label("evil.test"),
      label("sk-live-abcdef12.exfil.test"),
    ]);
    expect(JSON.stringify(bed.lines)).not.toMatch(/wild\.test|evil|sk-live/);
  });

  it("logs at most 16 hosts", async () => {
    bed = await startBed();
    const listener = await bed.listen(scopeOf({ hosts: [] }));
    for (let i = 0; i < 20; i += 1) await exchange(listener.path, getLine(`http://h${i}.example/`));
    await listener.close();
    expect((lineOf("egress_command")?.["hosts"] as string[]).length).toBe(16);
    expect(lineOf("egress_command")).toMatchObject({ refused: 20 });
  });
});

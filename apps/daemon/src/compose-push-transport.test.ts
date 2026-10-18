import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PapError, type HandlerContext } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeClock } from "./kernel/clock.ts";
import { openOutboxBed, type OutboxBed } from "./kernel/testing/outbox-bed.ts";
import { testCaller } from "./testing/caller.ts";
import { composeTransportSide } from "./compose-push-transport.ts";
import { PUSH_MIGRATIONS } from "./modules/push/index.ts";
import { createTestBrowser, startFakePushService } from "./modules/push/testing/fake-push-service.ts";
import { subInput } from "./modules/push/testing/transport-bed.ts";
import { pushDepsOf } from "./modules/push/testing/push-deps.ts";

let bed: OutboxBed;
let home: string;
afterEach(() => {
  bed.close();
  rmSync(home, { recursive: true, force: true });
});

function build(
  over: { config?: object; readOnly?: boolean; sessionLive?: (o: string, c: string) => boolean } = {},
) {
  bed = openOutboxBed([PUSH_MIGRATIONS]);
  home = mkdtempSync(join(tmpdir(), "pap-push-compose-"));
  const sessionLive = vi.fn(over.sessionLive ?? (() => true));
  const append = vi.fn();
  const deps = pushDepsOf({
    db: bed.db,
    clock: createFakeClock(),
    logger: bed.logger,
    readOnly: over.readOnly === true,
    config: {
      home,
      publicOrigin: "https://pap.example.net",
      insecureHttp: false,
      tls: null,
      pushSubject: null,
      pushExtraHosts: [],
      testPushLoopback: false,
      ...over.config,
    },
    audit: { port: { append, reserve: () => true } },
    auth: { sessionLive },
  });
  const side = composeTransportSide(deps);
  const ctx = (caller = testCaller()): HandlerContext => ({
    caller,
    connectionId: "c1",
    openSubscription: () => "sub",
    closeSubscription: () => {},
  });
  return { side, sessionLive, append, ctx, deps };
}
const code = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error instanceof PapError ? error.code : error;
  }
  return "no error";
};

describe("the transport side in production wiring", () => {
  it("mints the key under $PAP_HOME/secrets/push at 0600 and reports push on with its public key", async () => {
    const { side, ctx } = build();
    expect(statSync(join(home, "secrets", "push", "vapid.json")).mode & 0o777).toBe(0o600);
    const status = side.transport.status();
    expect(status).toMatchObject({ on: true, reason: null });
    const config = await side.rpc["push.config"]({}, ctx());
    expect(config).toMatchObject({ status: "on", publicKey: status.publicKey, subscribed: 0 });
  });

  it("the rpc stores through the real store, which the port reads", async () => {
    const { side, ctx } = build();
    const { id } = await side.rpc["push.subscribe"]({ subscription: subInput(1) }, ctx());
    expect(side.subscriptions.targets("u1").map((t) => t.id)).toEqual([id]);
  });

  it("sessionLive is the auth module's, not a stub", () => {
    const { side, sessionLive } = build({ sessionLive: (_o, c) => c === "alive" });
    expect(side.sessionLive.sessionLive("u1", "alive")).toBe(true);
    expect(side.sessionLive.sessionLive("u1", "dead")).toBe(false);
    expect(sessionLive).toHaveBeenCalledWith("u1", "dead");
  });

  it("wires PAP_PUSH_EXTRA_HOSTS into the endpoint rules", async () => {
    const own = subInput(1, { endpoint: "https://push.example.net/send/aaaaaaaaaaaaaaaa" });
    const closed = build();
    expect(await code(closed.side.rpc["push.subscribe"]({ subscription: own }, closed.ctx()))).toBe(
      "bad_request",
    );
    bed.close();
    rmSync(home, { recursive: true, force: true });
    const open = build({ config: { pushExtraHosts: ["push.example.net"] } });
    expect(await open.side.rpc["push.subscribe"]({ subscription: own }, open.ctx())).toMatchObject({
      id: expect.any(String),
    });
  });

  it("wires the loopback switch from the config and from nothing else", async () => {
    const local = subInput(1, { endpoint: "http://127.0.0.1:4555/push/aaaaaaaaaa" });
    const off = build();
    expect(await code(off.side.rpc["push.subscribe"]({ subscription: local }, off.ctx()))).toBe(
      "bad_request",
    );
    bed.close();
    rmSync(home, { recursive: true, force: true });
    const on = build({ config: { testPushLoopback: true } });
    expect(await on.side.rpc["push.subscribe"]({ subscription: local }, on.ctx())).toMatchObject({
      id: expect.any(String),
    });
  });

  it("audits through the daemon's audit port", async () => {
    const { side, ctx, append } = build();
    await side.rpc["push.subscribe"]({ subscription: subInput(1) }, ctx());
    expect(append).toHaveBeenCalledWith(expect.objectContaining({ kind: "auth", reason: "push.subscribe" }));
  });

  it("plain http off localhost: push is off with insecure_http and push.config says so", async () => {
    const { side, ctx } = build({ config: { publicOrigin: "http://192.0.2.9:7777" } });
    expect(side.transport.status()).toMatchObject({ on: false, reason: "insecure_http" });
    expect(await side.rpc["push.config"]({}, ctx())).toMatchObject({
      status: "off",
      reason: "insecure_http",
      readiness: { status: "insecure_http" },
    });
  });

  it("pap serving TLS with an http:// origin: readiness is origin_mismatch (W6-R8), from a boolean only", async () => {
    const tls = { cert: Buffer.from("CERT"), key: Buffer.from("PRIVATE-KEY") };
    const { side, ctx } = build({ config: { publicOrigin: "http://pap.example.net", tls } });
    const config = await side.rpc["push.config"]({}, ctx());
    expect(config.readiness).toMatchObject({ status: "origin_mismatch" });
    expect(JSON.stringify(config)).not.toMatch(/CERT|PRIVATE-KEY/);
    const plain = build({ config: { publicOrigin: "http://pap.example.net" } });
    expect((await plain.side.rpc["push.config"]({}, plain.ctx())).readiness).toMatchObject({
      status: "insecure_http",
    });
  });

  it("read-only database: config says read_only and subscribe answers read_only", async () => {
    const { side, ctx } = build({ readOnly: true });
    expect(await side.rpc["push.config"]({}, ctx())).toMatchObject({ status: "off", reason: "read_only" });
    expect(await code(side.rpc["push.subscribe"]({ subscription: subInput(1) }, ctx()))).toBe("read_only");
  });

  it("a read-only boot does not mint, purge or write a thing", () => {
    build({ readOnly: true });
    expect(() => statSync(join(home, "secrets", "push", "vapid.json"))).toThrow();
  });

  it("the seams of a test bed replace the subscription port and the live-session check", () => {
    const { deps } = build();
    const subscriptions = { targets: () => [], drop: () => {}, markOk: () => {} };
    const sessionLive = { sessionLive: () => false };
    const side = composeTransportSide(deps, { subscriptions, sessionLive });
    expect(side.subscriptions).toBe(subscriptions);
    expect(side.sessionLive).toBe(sessionLive);
  });
});

describe("the real sender in production wiring (task 7)", () => {
  const OPTS = { ttlSeconds: 60, urgency: "normal" as const, topic: "topic-1" };
  const claimsOf = (authorization: string | undefined) => {
    const jwt = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=/.exec(authorization ?? "")?.[1] ?? "";
    return JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString()) as {
      aud: string;
      sub: string;
    };
  };

  it.each([
    ["the https public origin", { publicOrigin: "https://pap.example.net" }, "https://pap.example.net"],
    ["PAP_PUSH_SUBJECT when set", { pushSubject: "mailto:owner@pap.example" }, "mailto:owner@pap.example"],
    [
      "the project URL for a localhost origin",
      { publicOrigin: "http://localhost:7777" },
      "https://github.com/SoulKyu/pi-agentic-platform",
    ],
  ])(
    "with the loopback switch the real transport reaches the fake service; sub is %s",
    async (_name, config, sub) => {
      const fake = await startFakePushService();
      try {
        const { side } = build({ config: { ...config, testPushLoopback: true } });
        const browser = createTestBrowser();
        const outcome = await side.transport.send(
          browser.target(`${fake.url}/push/abc`),
          Buffer.from("hi"),
          OPTS,
          new AbortController().signal,
        );
        expect(outcome).toEqual({ kind: "ok" });
        const claims = claimsOf(fake.requests[0]?.headers.authorization);
        expect(claims).toMatchObject({ aud: fake.url, sub });
      } finally {
        await fake.close();
      }
    },
  );

  it("without the switch the same loopback endpoint is refused and nothing connects", async () => {
    const fake = await startFakePushService();
    try {
      const { side } = build();
      const outcome = await side.transport.send(
        createTestBrowser().target(`${fake.url}/push/abc`),
        Buffer.from("hi"),
        OPTS,
        new AbortController().signal,
      );
      expect(outcome).toEqual({ kind: "refused", reason: "endpoint" });
      expect(fake.connections()).toBe(0);
    } finally {
      await fake.close();
    }
  });

  it("a read-only boot has no key, so the sender is off and refuses", async () => {
    const { side } = build({ readOnly: true });
    expect(side.transport.status()).toEqual({ on: false, reason: null, publicKey: null });
    expect(
      await side.transport.send(
        createTestBrowser().target("https://push.example.net/x"),
        Buffer.from("hi"),
        OPTS,
        new AbortController().signal,
      ),
    ).toEqual({ kind: "refused", reason: "off" });
  });
});

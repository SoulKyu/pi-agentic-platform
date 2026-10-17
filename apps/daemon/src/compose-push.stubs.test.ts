import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "./kernel/clock.ts";
import { silentLogger } from "./kernel/logger.ts";
import { openOutboxBed } from "./kernel/testing/outbox-bed.ts";
import { createOutbox } from "./kernel/outbox/index.ts";
import { composePush } from "./compose-push.ts";
import { composeDeliverySide } from "./compose-push-delivery.ts";
import { composeTransportSide } from "./compose-push-transport.ts";
import { PUSH_MIGRATIONS, type PushDeps, type SubscriptionTarget } from "./modules/push/index.ts";
import { pushDepsOf } from "./modules/push/testing/push-deps.ts";

function deps(): { deps: PushDeps; close(): void } {
  const bed = openOutboxBed([PUSH_MIGRATIONS]);
  const home = mkdtempSync(join(tmpdir(), "pap-push-stubs-"));
  return {
    deps: pushDepsOf({
      db: bed.db,
      clock: createFakeClock(),
      logger: silentLogger,
      readOnly: false,
      closers: { push: () => undefined },
      config: {
        home,
        publicOrigin: "https://pap.example.net",
        insecureHttp: false,
        pushSubject: null,
        pushExtraHosts: ["push.example.net"],
        testPushLoopback: false,
        tls: null,
      },
      audit: { port: { append: () => {}, reserve: () => true } },
      m10: {
        outbox: createOutbox({ db: bed.db, clock: bed.clock, logger: bed.logger, readOnly: false }),
        runs,
      },
      auth: { ...auth, sessionLive: () => false },
      inbox,
      sessions,
      agents,
    }),
    close: () => {
      bed.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** The Inbox as the sources see it (task 10): it hears nothing here. */
const inbox = { onItem: () => () => undefined, get: () => null, registeredName: () => null };
/** The sessions and agents the sources read (task 11): no session is waiting, no agent is registered. */
const sessions = {
  ownerOf: () => null,
  kindOf: () => null,
  automation: { onAttention: () => () => undefined, state: () => null },
};
const agents = { port: { get: () => null } };
/** The runs port the budget source listens to (task 12) and the instance owner it checks at boot: none yet. */
const runs = { port: { onRunEnd: () => () => undefined, spentToday: () => 0 } };
const auth = { ownerId: () => null };

const TARGET: SubscriptionTarget = {
  id: "s1",
  endpoint: "https://push.example.net/x",
  p256dh: "p",
  auth: "a",
  credentialId: "c1",
  locale: "en",
};

describe("the stub sides of the compose split (task 1)", () => {
  it("the transport side sends through the real guarded sender: a target with a damaged key is refused, not stubbed", async () => {
    const { deps: d, close } = deps();
    const side = composeTransportSide(d);
    expect(
      await side.transport.send(
        TARGET,
        new Uint8Array(),
        { ttlSeconds: 1, urgency: "normal", topic: "t" },
        new AbortController().signal,
      ),
    ).toEqual({ kind: "refused", reason: "bad_keys" });
    close();
  });

  it("the transport side takes the seams of a test bed", () => {
    const { deps: d, close } = deps();
    const transport = {
      status: () => ({ on: true, reason: null, publicKey: "k" }),
      send: async () => ({ kind: "ok" as const }),
    };
    const side = composeTransportSide(d, { transport });
    expect(side.transport).toBe(transport);
    close();
  });

  it("the delivery side builds the real notifier and presence (task 8)", () => {
    const { deps: d, close } = deps();
    const side = composeDeliverySide(d, composeTransportSide(d));
    expect(
      side.notifier.notify({ ownerId: "u1", cls: "approval", refKind: "session", refId: "s1" }),
    ).not.toBeNull();
    expect(d.db.all("SELECT kind FROM outbox")).toEqual([{ kind: "push.send" }]);
    expect(side.notifier.keyOf("approval", "session", "s1")).toBe("push:approval:session:s1");
    expect(side.presence.looking("u1")).toBe(false);
    side.presence.report("u1", "c1", true);
    expect(side.presence.looking("u1")).toBe(true);
    close();
  });

  it("composePush merges the seven methods and warns once when the loopback switch is on", () => {
    const warnings: string[] = [];
    const logger = { ...silentLogger, warn: (msg: string) => warnings.push(msg) };
    // One outbox takes one `push.send` handler, so each composition gets its own.
    const first = deps();
    const second = deps();
    const build = (d: PushDeps, testPushLoopback: boolean) =>
      composePush(pushDepsOf({ ...d, logger, config: { ...d.config, testPushLoopback } }));
    expect(Object.keys(build(first.deps, false).rpc)).toHaveLength(7);
    expect(warnings).toEqual([]);
    build(second.deps, true);
    expect(warnings).toEqual(["push_test_loopback"]);
    first.close();
    second.close();
  });
});

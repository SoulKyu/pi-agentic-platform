import { afterEach, describe, expect, it } from "vitest";
import { createOutbox } from "../../../kernel/outbox/index.ts";
import { OWNER, openSendBed, type SendBed } from "../testing/send-bed.ts";
import { registerPushEffects } from "./index.ts";

let t: SendBed;
afterEach(() => t.close());

describe("restart.cancels-approvals-keeps-others (M12-RT-10)", () => {
  it("a pending approval is cancelled and sends nothing; failed and budget are sent once; a sent row is not sent again", async () => {
    t = openSendBed(["a"]);
    const ref = (kind: "session" | "budget", id: string) =>
      ({ ownerId: OWNER, refKind: kind, refId: id }) as const;
    t.notifier.notify({ ...ref("session", "done-before"), cls: "failed" });
    await t.step();
    expect(t.transport.sent).toHaveLength(1);

    t.notifier.notify({ ...ref("session", "q1"), cls: "approval" });
    t.notifier.notify({ ...ref("session", "s2"), cls: "failed" });
    t.notifier.notify({ ...ref("budget", "daily"), cls: "budget" });

    // The daemon died: workers are gone and their dialogs closed, so nothing waits for an answer any more.
    t.state.waitingFor = (event) => event.cls !== "approval";
    t.bed.db.run("UPDATE outbox SET status = 'leased', lease_until = 0 WHERE status = 'pending'");
    const reborn = createOutbox({ db: t.bed.db, clock: t.bed.clock, logger: t.bed.logger, readOnly: false });
    registerPushEffects(
      reborn,
      {
        db: t.bed.db,
        clock: t.bed.clock,
        logger: t.bed.logger,
        transport: t.transport,
        subscriptions: t.subs,
        sessionLive: t.subs,
        presence: t.presence,
        cooldown: t.cooldown,
        notifications: () => t.state.settings,
        quiet: () => false,
        onHold: () => {},
        stillWaiting: (event) => event.cls !== "approval",
      },
      { notifier: t.notifier, judge: () => "waiting" },
    );
    reborn.recover();
    await t.bed.clock.advance(60_000);
    await reborn.drain();

    expect(t.events().map((e) => `${e.cls}:${e.state}:${e.reason ?? ""}`)).toEqual([
      "failed:sent:",
      "approval:cancelled:gone",
      "failed:sent:",
      "budget:sent:",
    ]);
    expect(t.transport.sent).toHaveLength(3);

    t.bed.db.run("UPDATE outbox SET status = 'pending', settled_at = NULL");
    await reborn.drain();
    expect(t.transport.sent).toHaveLength(3);
  });
});

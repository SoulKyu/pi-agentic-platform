import { inQuietHours } from "@pap/contracts";
import type {
  DeliveryRpc,
  DigestVerdict,
  EventRow,
  PushDeps,
  PushNotifier,
  PushPresence,
} from "./modules/push/index.ts";
import {
  createCooldown,
  createDigestScheduler,
  createNotifier,
  createPresence,
  createPushHousekeeping,
  createTestPush,
  createOpenPush,
  deliveryRpc,
  registerPushEffects,
  wireBudgetSource,
  wireInboxSource,
  wireSessionSource,
} from "./modules/push/index.ts";
import { createAgentSpend } from "./modules/runs/index.ts";
import type { TransportSide } from "./compose-push-transport.ts";

/** What `composePush` needs back from the delivery side. */
export interface DeliverySide {
  readonly notifier: PushNotifier;
  readonly presence: PushPresence;
  readonly rpc: DeliveryRpc;
}

/** What the delivery side reads of the transport side. */
export type DeliveryPorts = Pick<TransportSide, "transport" | "subscriptions" | "sessionLive">;

/**
 * Chain B's side of the push composition (tasks 8 to 12): events, the rules, `push.send`, the sources and their RPC.
 * It reads the transport side's ports. Task 8: the real notifier and presence; task 9a: `push.send`; task 9b: the digest, the
 * purge and `push.test`; the other
 * handlers and the sources follow.
 */
export const composeDeliverySide: (deps: PushDeps, ports: DeliveryPorts) => DeliverySide = (deps, ports) => {
  const presence = createPresence(deps.clock);
  const notifier = createNotifier({
    db: deps.db,
    clock: deps.clock,
    outbox: deps.m10.outbox,
    readOnly: deps.readOnly,
  });
  const scheduleDigest = createDigestScheduler({
    db: deps.db,
    clock: deps.clock,
    outbox: deps.m10.outbox,
    quietWindow: (ownerId) => deps.settings.port.automation(ownerId),
  });
  // The registry name of an agent, nothing else of it (W6-R10). The agents module is composed before push: no late binding.
  const agentName = (ownerId: string, agentId: string) =>
    deps.agents.port.get(ownerId, agentId)?.name ?? null;
  const inboxSource = wireInboxSource({ inbox: deps.inbox, notifier, logger: deps.logger, agentName });
  deps.closers.push({ name: "push_inbox_source", close: inboxSource.stop });
  const sessionSource = wireSessionSource({
    sessions: deps.sessions,
    notifier,
    logger: deps.logger,
    agentName,
  });
  deps.closers.push({ name: "push_session_source", close: sessionSource.stop });
  // Budgets (task 12): a run end checks the owner-wide and the agent's day; the boot check follows the effects below.
  const budgetSource = wireBudgetSource({
    db: deps.db,
    clock: deps.clock,
    logger: deps.logger,
    notifier,
    runs: deps.m10.runs.port,
    spend: createAgentSpend({ db: deps.db, clock: deps.clock }),
    settings: (ownerId) => deps.settings.port.automation(ownerId),
    agents: deps.agents.port,
    kindOf: (sessionId) => deps.sessions.kindOf(sessionId),
    ownerId: () => deps.auth.ownerId(),
  });
  deps.closers.push({ name: "push_budget_source", close: budgetSource.stop });
  // One whole line per source, by the ref the event is about. A kind of ref with no line is an approval that no source
  // can vouch for: it fails closed (cancelled `gone`, a digest drops it); the other classes are news and still count.
  const lines: Readonly<
    Record<string, { waiting(e: EventRow): boolean; verdict(e: EventRow): DigestVerdict }>
  > = {
    inbox: inboxSource,
    session: sessionSource,
  };
  const line = (event: EventRow) => {
    const found = lines[event.refKind];
    if (!found && event.cls === "approval")
      deps.logger.info("push_approval_without_line", { refKind: event.refKind });
    return found;
  };
  registerPushEffects(
    deps.m10.outbox,
    {
      db: deps.db,
      clock: deps.clock,
      logger: deps.logger,
      transport: ports.transport,
      subscriptions: ports.subscriptions,
      sessionLive: ports.sessionLive,
      presence,
      cooldown: createCooldown(deps.clock),
      notifications: (ownerId) => deps.settings.port.notifications(ownerId),
      quiet: (ownerId, at) => {
        const automation = deps.settings.port.automation(ownerId);
        return inQuietHours(automation.quietHours, automation.timezone, at);
      },
      onHold: scheduleDigest,
      stillWaiting: (event) => line(event)?.waiting(event) ?? event.cls !== "approval",
    },
    {
      notifier,
      judge: (event) => line(event)?.verdict(event) ?? (event.cls === "approval" ? "gone" : "waiting"),
    },
  );
  budgetSource.boot();
  const housekeeping = createPushHousekeeping({
    db: deps.db,
    clock: deps.clock,
    logger: deps.logger,
    readOnly: deps.readOnly,
  });
  housekeeping.start();
  deps.closers.push({ name: "push_housekeeping", close: () => housekeeping.stop() });
  return {
    notifier,
    presence,
    rpc: deliveryRpc({
      presence,
      open: createOpenPush({ db: deps.db }),
      test: createTestPush({
        db: deps.db,
        clock: deps.clock,
        logger: deps.logger,
        transport: ports.transport,
        subscriptions: ports.subscriptions,
      }),
    }),
  };
};

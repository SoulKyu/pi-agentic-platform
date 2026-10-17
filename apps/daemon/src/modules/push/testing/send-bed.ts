import { inQuietHours, NotificationsSettings, type AutomationSettings } from "@pap/contracts";
import { createOutbox, type Outbox } from "../../../kernel/outbox/index.ts";
import type { MigrationSource } from "../../../kernel/db/migrate.ts";
import { openOutboxBed, type OutboxBed } from "../../../kernel/testing/outbox-bed.ts";
import {
  createCooldown,
  createNotifier,
  createPresence,
  createDigestScheduler,
  PUSH_MIGRATIONS,
  registerPushEffects,
  type DigestVerdict,
  type EventRow,
  type PushNotifier,
  type PushPresence,
  type SendDeps,
  type SubscriptionTarget,
} from "../index.ts";
import { createFakeTransport, type FakeTransport } from "./fake-transport.ts";
import { createMemorySubscriptions, type MemorySubscriptions } from "./memory-subscriptions.ts";

export const OWNER = "u1";
export const target = (id: string, locale: "en" | "fr" = "en"): SubscriptionTarget => ({
  id,
  endpoint: `https://push.example.net/secret-path-${id}`,
  p256dh: "p",
  auth: "a",
  credentialId: `c-${id}`,
  locale,
});

export interface SendBed {
  readonly bed: OutboxBed;
  readonly outbox: Outbox;
  readonly notifier: PushNotifier;
  readonly presence: PushPresence;
  readonly transport: FakeTransport;
  readonly subs: MemorySubscriptions;
  readonly cooldown: ReturnType<typeof createCooldown>;
  /** Mutable inputs the handler reads. */
  readonly state: {
    settings: NotificationsSettings;
    /** `"window"`: ask `quietHours` and `timezone` like the daemon does. */
    quiet: boolean | "window";
    waiting: boolean;
    holds: number;
    quietHours: AutomationSettings["quietHours"];
    timezone: string | null;
    /** Overrides `waiting` per event (the source of the event's ref). */
    waitingFor: ((event: EventRow) => boolean) | null;
    /** The digest's judgement of a held event. */
    judge: (event: EventRow) => DigestVerdict;
  };
  events(): Array<{ id: string; cls: string; state: string; reason: string | null; rechecks: number }>;
  deliveries(): Array<{ sub_id: string; state: string; attempts: number; reason: string | null }>;
  /** Moves the Clock and runs every due effect. */
  step(ms?: number): Promise<void>;
  close(): void;
}

/** A real temporary database, the real outbox and notifier, and the fake transport: the unit bed of `push.send`. */
export function openSendBed(
  subscribers: readonly string[] = ["a"],
  /** Another module's tables on the same database (a source's own store). */
  more: readonly MigrationSource[] = [],
): SendBed {
  const bed = openOutboxBed([PUSH_MIGRATIONS, ...more]);
  const outbox = createOutbox({ db: bed.db, clock: bed.clock, logger: bed.logger, readOnly: false });
  const transport = createFakeTransport();
  const subs = createMemorySubscriptions();
  for (const id of subscribers) subs.add(OWNER, target(id));
  const presence = createPresence(bed.clock);
  const cooldown = createCooldown(bed.clock);
  const state: SendBed["state"] = {
    settings: NotificationsSettings.parse({}),
    quiet: false,
    waiting: true,
    holds: 0,
    quietHours: { from: "22:00", to: "07:00" },
    timezone: "Europe/Paris",
    waitingFor: null,
    judge: () => "waiting",
  };
  const scheduleDigest = createDigestScheduler({
    db: bed.db,
    clock: bed.clock,
    outbox,
    quietWindow: () => ({ quietHours: state.quietHours, timezone: state.timezone }),
  });
  const deps: SendDeps = {
    db: bed.db,
    clock: bed.clock,
    logger: bed.logger,
    transport,
    subscriptions: subs,
    sessionLive: subs,
    presence,
    cooldown,
    notifications: () => state.settings,
    quiet: (_ownerId, at) =>
      state.quiet === "window" ? inQuietHours(state.quietHours, state.timezone, at) : state.quiet,
    onHold: (ownerId, at) => {
      state.holds += 1;
      scheduleDigest(ownerId, at);
    },
    stillWaiting: (event) => (state.waitingFor ? state.waitingFor(event) : state.waiting),
  };
  const notifier = createNotifier({ db: bed.db, clock: bed.clock, outbox, readOnly: false });
  registerPushEffects(outbox, deps, { notifier, judge: (event) => state.judge(event) });
  return {
    bed,
    outbox,
    notifier,
    presence,
    transport,
    subs,
    cooldown,
    state,
    events: () =>
      bed.db.all("SELECT id, cls, state, reason, rechecks FROM push_events ORDER BY created_at, rowid"),
    deliveries: () =>
      bed.db.all("SELECT sub_id, state, attempts, reason FROM push_deliveries ORDER BY rowid"),
    async step(ms = 0) {
      if (ms > 0) await bed.clock.advance(ms);
      await outbox.drain();
    },
    close: () => bed.close(),
  };
}

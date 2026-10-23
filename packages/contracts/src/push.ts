import { z } from "zod";
import { dropKey } from "./drop-key.ts";

/** The classes of push the owner can switch on or off (M12R2); `digest` and `test` are wire-only. */
export const PUSH_CLASSES = ["approval", "failed", "budget", "notify", "done", "reply"] as const;
export type PushClass = (typeof PUSH_CLASSES)[number];
export const WIRE_CLASSES = [...PUSH_CLASSES, "digest", "test"] as const;
export type WireClass = (typeof WIRE_CLASSES)[number];

/** The id of an event: `randomToken(16)`, also the wire id, the `Topic` header and the `/n/<id>` path (M12R1). */
export const PUSH_ID = /^[A-Za-z0-9_-]{22}$/;

/** What the service worker receives (M12R7): generic text and an opaque id, never a URL (M12R15). */
export const PushWire = z
  .object({
    v: z.literal(1),
    id: z.string().regex(PUSH_ID),
    cls: z.enum(WIRE_CLASSES),
    title: z.string().max(80),
    body: z.string().max(200),
    ts: z.number().int(),
  })
  .strict();
export type PushWire = z.infer<typeof PushWire>;

const ClassesFields = z
  .object({
    approval: z.boolean().default(true),
    failed: z.boolean().default(true),
    budget: z.boolean().default(true),
    notify: z.boolean().default(true),
    done: z.boolean().default(false),
    reply: z.boolean().default(false),
  })
  .strict();
/** Stored preferences may still hold the `review` class pi-mem0 had: accepted, dropped (decision 123). */
const Classes = z.preprocess(dropKey("review"), ClassesFields) as unknown as z.ZodType<
  z.output<typeof ClassesFields>,
  z.input<typeof ClassesFields>
>;

/**
 * The owner's `notifications` document (M12R18). `.prefault({})` feeds `{}` through the inner defaults: zod 4's
 * `.default({})` over an object with defaults would yield `{}` (M12-RT-14). Quiet hours stay in the automation settings.
 */
export const NotificationsSettings = z
  .object({
    classes: Classes.prefault({}),
    muteUntil: z.number().int().nonnegative().nullable().default(null),
    titles: z.enum(["generic", "names"]).default("generic"),
  })
  .strict();
export type NotificationsSettings = z.infer<typeof NotificationsSettings>;

export const PUSH_LIMITS = {
  subscriptionsPerOwner: 10,
  endpointMax: 2048,
  labelMax: 80,
  presenceTtlMs: 45_000,
  presenceEntries: 64,
} as const;

/** `PushSubscription.toJSON()` as the browser gives it, plus the device's locale and label (M12R9). */
export const PushSubscriptionInput = z
  .object({
    endpoint: z.string().min(16).max(PUSH_LIMITS.endpointMax),
    keys: z
      .object({
        p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
        auth: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
      })
      .strict(),
    locale: z.enum(["en", "fr"]),
    label: z.string().trim().min(1).max(PUSH_LIMITS.labelMax),
  })
  .strict();
export type PushSubscriptionInput = z.infer<typeof PushSubscriptionInput>;

/** Where a click lands (`push.open`): ids come from the daemon and are passed to the router as data (M12R33). */
export const PushTarget = z
  .object({ kind: z.enum(["inbox", "session", "agent", "settings"]), id: z.string().max(128).nullable() })
  .strict();
export type PushTarget = z.infer<typeof PushTarget>;

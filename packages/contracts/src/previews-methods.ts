import { z } from "zod";
import { BoxRef, ProjectId } from "./box-ref.ts";
import { defineMethod } from "./define.ts";
import { Cursor } from "./frames.ts";
import { SERVICE_LIMITS, ServiceCommand, ServiceName, ServicePort, ServiceView } from "./preview-service.ts";

export const PreviewView = ServiceView.extend({ box: BoxRef }).strict();
export type PreviewView = z.infer<typeof PreviewView>;

export const PreviewsEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("snapshot"), services: z.array(PreviewView).max(256) }).strict(),
  z.object({ type: z.literal("service"), service: PreviewView }).strict(),
  z.object({ type: z.literal("removed"), box: BoxRef, name: ServiceName }).strict(),
]);
export type PreviewsEvent = z.infer<typeof PreviewsEvent>;

/** A lease of a service token: 32 hex, the pane's to renew and close (decision 6). */
const Lease = z.string().regex(/^[0-9a-f]{32}$/);
/** The visible id of a Pi entry: what `entryText` looks up, never a path. */
const EntryId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7e]+$/);
/** A capability URL on the preview origin: `${origin}/p/<token>/` or `${origin}/a/<token>/`. */
const CapabilityUrl = z.string().max(2048);

/**
 * Minted, renewed or closed by the owner's own browser only (UX2-R32): a token caller is `forbidden` before anything else.
 * `previews.close` is here too: only a browser ever holds a lease.
 */
export const PREVIEWS_BROWSER_ONLY: ReadonlySet<string> = new Set([
  "previews.open",
  "previews.renew",
  "previews.close",
  "previews.artifact",
]);

const boxName = z.object({ box: BoxRef, name: ServiceName }).strict();

/**
 * UX-2 §9b: `sessions:operate` as declared; the service also checks `agents:operate` for an agent box and the box's owner.
 * `open` and `artifact` answer a capability URL: `secretResult`, so the dispatcher never stores it in a receipt (red team I7)
 * and a replayed command id answers `conflict` (the pane and the PREVIEW toggle mint again with a new id).
 */
export const previewsMethods = {
  "subscribe.previews": defineMethod({
    name: "subscribe.previews",
    permission: "sessions:read",
    idempotent: true,
    params: z.object({ after: Cursor.optional() }).strict(),
    result: z.object({ sub: z.string() }),
    errors: ["capacity"],
  }),
  "previews.list": defineMethod({
    name: "previews.list",
    permission: "sessions:operate",
    idempotent: true,
    params: z.object({ box: BoxRef }).strict(),
    result: z.object({ services: z.array(PreviewView).max(SERVICE_LIMITS.perBox) }).strict(),
    errors: ["not_found", "forbidden"],
  }),
  "previews.stop": defineMethod({
    name: "previews.stop",
    permission: "sessions:operate",
    idempotent: false,
    params: boxName,
    result: z.object({}).strict(),
    errors: ["not_found", "box_stopped", "forbidden", "timeout"],
  }),
  "previews.restart": defineMethod({
    name: "previews.restart",
    permission: "sessions:operate",
    idempotent: false,
    params: boxName,
    result: z.object({ service: PreviewView }).strict(),
    errors: ["not_found", "box_stopped", "forbidden", "timeout", "limit_reached"],
  }),
  "previews.startProject": defineMethod({
    name: "previews.startProject",
    permission: "sessions:operate",
    idempotent: false,
    /** The command and port the page showed (UX2-R74): the daemon starts the fresh declaration only when it is the same. */
    params: z.object({ projectId: ProjectId, command: ServiceCommand, port: ServicePort }).strict(),
    result: z.object({ service: PreviewView }).strict(),
    errors: ["not_found", "box_stopped", "forbidden", "timeout", "bad_request", "limit_reached", "conflict"],
  }),
  "previews.logs": defineMethod({
    name: "previews.logs",
    permission: "sessions:operate",
    idempotent: true,
    params: boxName,
    result: z
      .object({
        lines: z.array(z.string().max(SERVICE_LIMITS.lineChars)).max(SERVICE_LIMITS.logLines),
      })
      .strict(),
    errors: ["not_found", "box_stopped", "forbidden", "timeout"],
  }),
  "previews.open": defineMethod({
    name: "previews.open",
    permission: "sessions:operate",
    idempotent: false,
    secretResult: true,
    params: boxName,
    result: z.object({ url: CapabilityUrl, lease: Lease, leaseMs: z.number().int().positive() }).strict(),
    errors: ["not_found", "box_stopped", "forbidden", "limit_reached", "unavailable"],
  }),
  "previews.renew": defineMethod({
    name: "previews.renew",
    permission: "sessions:operate",
    idempotent: true,
    params: z.object({ lease: Lease }).strict(),
    result: z.object({ until: z.number().int().nonnegative() }).strict(),
    errors: ["not_found", "forbidden"],
  }),
  "previews.close": defineMethod({
    name: "previews.close",
    permission: "sessions:operate",
    idempotent: true,
    params: z.object({ lease: Lease }).strict(),
    result: z.object({}).strict(),
    errors: ["forbidden"],
  }),
  "previews.artifact": defineMethod({
    name: "previews.artifact",
    permission: "sessions:operate",
    idempotent: false,
    secretResult: true,
    params: z
      .object({
        sessionId: z.string().min(1).max(128),
        entryId: EntryId,
        fenceIndex: z.number().int().min(0).max(255),
      })
      .strict(),
    result: z.object({ url: CapabilityUrl, until: z.number().int().nonnegative() }).strict(),
    errors: ["not_found", "forbidden", "payload_too_large", "limit_reached", "unavailable"],
  }),
};

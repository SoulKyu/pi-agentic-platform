import { PapError, type Caller, type PushClass } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Config } from "../../kernel/config.ts";
import type { Db } from "../../kernel/db/database.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { Outbox } from "../../kernel/outbox/index.ts";
import type { StreamHub } from "../../kernel/ws/stream-hub.ts";
import type { AgentsPort } from "../agents/index.ts";
import type { AuditPort } from "../audit/index.ts";
import type { AuthModule } from "../auth/index.ts";
import type { Inbox } from "../inbox/index.ts";
import type { RunsPort } from "../runs/index.ts";
import type { SessionsModule } from "../sessions/index.ts";
import type { SettingsModule } from "../settings/index.ts";

/*
 * The ports the two chains of M12 share: the only file both import, written by Task 1 alone. Chain A (transport,
 * `transport/`) implements `PushTransport`, `SubscriptionsPort` and `SessionLive`; chain B (delivery, `delivery/`)
 * implements `PushNotifier` and `PushPresence` over them.
 */

export type SendOutcome =
  | { kind: "ok" }
  | { kind: "gone" }
  | { kind: "retry"; afterMs?: number }
  | { kind: "rejected"; status: number }
  | { kind: "refused"; reason: string };

export interface SubscriptionTarget {
  readonly id: string;
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly credentialId: string;
  readonly locale: "en" | "fr";
}

export interface PushTransport {
  status(): { on: boolean; reason: null | "keys_unreadable" | "insecure_http"; publicKey: string | null };
  /** Encrypts (RFC 8291) and sends; never throws: every failure is an outcome. */
  send(
    target: SubscriptionTarget,
    plaintext: Uint8Array,
    opts: { ttlSeconds: number; urgency: "normal" | "high"; topic: string },
    signal: AbortSignal,
  ): Promise<SendOutcome>;
}

export interface SubscriptionsPort {
  /** All of the owner's, or only one credential's (push.test); no side effects. */
  targets(ownerId: string, credentialId?: string): SubscriptionTarget[];
  drop(id: string, why: "gone" | "dead_session"): void;
  markOk(id: string, at: number): void;
}

export interface SessionLive {
  sessionLive(ownerId: string, credentialId: string): boolean;
}

export type PushRef = {
  refKind: "inbox" | "session" | "budget" | "digest" | "test";
  refId: string;
};

export interface PushNotifier {
  /** Null: a live event for this ref exists, or the outbox refused the effect. */
  notify(
    event: { ownerId: string; cls: PushClass | "digest" | "test" } & PushRef & { name?: string; at?: number },
  ): { id: string } | null;
  /** Pending events only. */
  cancel(refKey: string, reason: "answered" | "expired" | "gone"): void;
  keyOf(cls: PushClass, refKind: string, refId: string): string;
}

export interface PushPresence {
  report(ownerId: string, connectionId: string, focused: boolean): void;
  looking(ownerId: string): boolean;
}

/** The test bed's replacements for the transport side (never set by `main.ts`). */
export interface PushSeams {
  transport?: PushTransport;
  subscriptions?: SubscriptionsPort;
  sessionLive?: SessionLive;
}

/** The daemon's list of things to undo, in the order they were pushed; undone in reverse after the workers stop. */
interface PushClosers {
  push(closer: { readonly name: string; close(): void | Promise<void> }): unknown;
}

/** What `composePush` is given: the daemon's core and the modules the sources listen to. Both chains read it from here. */
export interface PushDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly readOnly: boolean;
  readonly env: NodeJS.ProcessEnv;
  readonly config: Pick<
    Config,
    "home" | "publicOrigin" | "insecureHttp" | "pushSubject" | "pushExtraHosts" | "testPushLoopback" | "tls"
  >;
  readonly closers: PushClosers;
  /** The daemon's event hub, as `core` carries it (W6-R1). */
  readonly hub: Pick<StreamHub, "publish" | "registerSnapshot">;
  /** The audit module as M11 modules receive it: its port (W6-R1). */
  readonly audit: { readonly port: Pick<AuditPort, "append" | "reserve"> };
  /** The agents registry, names only: a push names an agent by what the owner registered (W6-R10). */
  readonly agents: { readonly port: Pick<AgentsPort, "get"> };
  /** The outbox and the runs registry, as M10 built them before any module. */
  readonly m10: { readonly outbox: Outbox; readonly runs: { readonly port: RunsPort } };
  readonly inbox: Inbox;
  readonly auth: AuthModule;
  readonly settings: SettingsModule;
  readonly sessions: SessionsModule;
}

/** Every `push.*` method is for a browser session, checked before any read (M12R10); a token learns nothing. */
export function requireBrowser(caller: Caller): void {
  if (caller.kind !== "session") throw new PapError("forbidden");
}

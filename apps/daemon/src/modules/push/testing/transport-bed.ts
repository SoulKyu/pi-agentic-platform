import { generateKeyPairSync, randomBytes } from "node:crypto";
import type { PushSubscriptionInput } from "@pap/contracts";
import { type FakeClock } from "../../../kernel/clock.ts";
import type { Db } from "../../../kernel/db/database.ts";
import type { Logger } from "../../../kernel/logger.ts";
import { openOutboxBed } from "../../../kernel/testing/outbox-bed.ts";
import type { AuditPort } from "../../audit/index.ts";
import { createSubscriptionStore, hostRules, PUSH_MIGRATIONS, type Subscriptions } from "../index.ts";

export interface TransportBed {
  readonly db: Db;
  readonly clock: FakeClock;
  readonly logger: Logger;
  readonly logs: Array<Record<string, unknown>>;
  readonly store: Subscriptions;
  close(): void;
}

/** A real temporary database with the push tables, a fake clock and the real subscription store. */
export function openTransportBed(options: { keyId?: string | null; loopback?: boolean } = {}): TransportBed {
  const bed = openOutboxBed([PUSH_MIGRATIONS]);
  const store = createSubscriptionStore(bed.db, {
    clock: bed.clock,
    logger: bed.logger,
    keyId: options.keyId === undefined ? "kkkkkkkkkkkkkkkk" : options.keyId,
    hosts: hostRules([]),
    loopbackForTests: options.loopback === true,
  });
  return { db: bed.db, clock: bed.clock, logger: bed.logger, logs: bed.logs, store, close: bed.close };
}

/** A subscription as a browser would send it: a real P-256 point and a 16-byte secret. */
export function subInput(n: number, over: Partial<PushSubscriptionInput> = {}): PushSubscriptionInput {
  const jwk = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ format: "jwk" });
  const point = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x ?? "", "base64url"),
    Buffer.from(jwk.y ?? "", "base64url"),
  ]);
  return {
    endpoint: `https://web.push.apple.com/send/device-${n}-secretpath`,
    keys: { p256dh: point.toString("base64url"), auth: randomBytes(16).toString("base64url") },
    locale: "en",
    label: `Phone ${n}`,
    ...over,
  };
}

type AuditLine = Parameters<AuditPort["append"]>[0];
export interface FakeAudit {
  readonly rows: AuditLine[];
  append(line: AuditLine): void;
}
export const fakeAudit = (): FakeAudit => {
  const rows: AuditLine[] = [];
  return { rows, append: (line) => void rows.push(line) };
};

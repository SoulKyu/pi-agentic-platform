import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeClock, type FakeClock } from "../../../kernel/clock.ts";
import type { PushReadiness } from "../../../kernel/push-readiness.ts";
import { captureLogger } from "../../../testing/capture-logger.ts";
import {
  createHttpsTransport,
  hostRules,
  loadVapid,
  type HostRule,
  type HttpsTransportDeps,
  type PushTransport,
  type VapidIdentity,
} from "../index.ts";

/** A listed test push host: never resolved for real, the bed's default resolver answers nothing. */
export const TEST_HOST = "push.example.net";
export const BED_SUBJECT = "https://pap.example.net";
export const READY: PushReadiness = { status: "ready", origin: "https://pap.example.net" };

export interface HttpsBed {
  readonly transport: PushTransport;
  readonly identity: VapidIdentity;
  readonly clock: FakeClock;
  readonly lines: Array<Record<string, unknown>>;
  close(): void;
}

/** The real guarded transport over a real VAPID key in a temporary folder, a fake clock and a capturing logger. */
export function openHttpsBed(
  over: Partial<Pick<HttpsTransportDeps, "allowAddress" | "lookup" | "readiness" | "loopbackForTests">> & {
    hosts?: readonly HostRule[];
  } = {},
): HttpsBed {
  const dir = mkdtempSync(join(tmpdir(), "pap-https-bed-"));
  const { logger, lines } = captureLogger();
  const clock = createFakeClock();
  const vapid = loadVapid(dir, logger);
  if (vapid.kind !== "ready") throw new Error("the bed needs a ready key");
  const transport = createHttpsTransport({
    vapid,
    subject: BED_SUBJECT,
    readiness: over.readiness ?? READY,
    clock,
    logger,
    loopbackForTests: over.loopbackForTests ?? true,
    hosts: over.hosts ?? hostRules([TEST_HOST]),
    ...(over.allowAddress ? { allowAddress: over.allowAddress } : {}),
    lookup: over.lookup ?? ((_host, _options, callback) => callback(null, [])),
  });
  return {
    transport,
    identity: vapid.identity,
    clock,
    lines,
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}

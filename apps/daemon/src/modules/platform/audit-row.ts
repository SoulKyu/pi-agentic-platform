import type { PlatformError, PlatformOp, SessionType } from "@pap/contracts";
import type { AuditPort } from "../audit/index.ts";
import type { PlatformSessionRef } from "./registry.ts";

export type AuditLine = Parameters<AuditPort["append"]>[0];

/**
 * The daemon's one row per platform call (M11R40): the op, the caller's type and the outcome. Never the arguments or the
 * result (the worker's own `call` row has the arguments, redacted). `ok` is the code of a call that ran and answered.
 * `op` is `unknown` and `type` null when the refusal came before either was read.
 */
export function platformAuditLine(
  session: PlatformSessionRef,
  op: PlatformOp | "unknown",
  type: SessionType | null,
  code: PlatformError | "ok",
  relaxed = false,
): AuditLine {
  return {
    ownerId: session.ownerId,
    actor: "worker",
    kind: "policy",
    sessionId: session.id,
    tool: op,
    decision: code === "ok" ? "allow" : "block",
    reason: code,
    detail: { op, type, code, ...(relaxed ? { relaxed: "autonomy" } : {}) },
  };
}

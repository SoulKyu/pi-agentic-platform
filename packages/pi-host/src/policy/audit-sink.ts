import type { PolicyAuditEntry } from "@pap/contracts/pi-host";
import type { Outbound } from "../ipc.ts";

export class AuditNotSent extends Error {}

/** The worker's audit sink: a record the channel refused is a failed audit, and the pipeline blocks on it (M5R114). */
export function auditSinkOf(send: (record: Outbound) => boolean): (entry: PolicyAuditEntry) => void {
  return (entry) => {
    if (!send({ type: "audit", entry })) throw new AuditNotSent("audit record not sent");
  };
}

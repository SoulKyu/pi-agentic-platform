import type { TaskTrigger, TriggerView } from "@pap/contracts";
import { readTriggerSecret } from "./trigger-secrets.ts";
import type { TriggerRecord } from "./triggers.ts";

/** Whether a trigger can fire: its config parses and a webhook still has its secret file. */
export function stateOf(record: TriggerRecord, secretsDir: string): TriggerView["state"] {
  if (record.input === null) return "unreadable";
  return record.sourceType === "webhook" && readTriggerSecret(secretsDir, record.id) === null
    ? "no_secret"
    : "ok";
}

/** A feed address as a token may read it: a private feed carries its credential in the query or the userinfo. */
export function redactedFeedUrl(address: string): string {
  try {
    const url = new URL(address);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "";
  }
}

/** What the Tasks board lists of a trigger: no config, no secret. */
export function summaryOf(record: TriggerRecord, secretsDir: string): TaskTrigger {
  return {
    id: record.id,
    name: record.name,
    enabled: record.enabled,
    sourceType: record.sourceType as TaskTrigger["sourceType"],
    projectId: record.projectId,
    state: stateOf(record, secretsDir),
    nextFireAt: record.nextFireAt,
  };
}

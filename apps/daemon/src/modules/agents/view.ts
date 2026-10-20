import {
  AgentId,
  type AgentInput,
  type AgentView,
  type Caller,
  PapError,
  type ResultOf,
} from "@pap/contracts";
import { PAGE_BYTES, sizeOf } from "../../kernel/json-bytes.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { AgentRecord } from "./store.ts";

const VIEW_ENVELOPE_BYTES = sizeOf({ agents: [], truncated: true });

const PROFILE_MAX_CHARS = 32_768;

/** The profile as stored: the input as JSON, refused `bad_request` past the column's cap. */
export function profileOf(input: AgentInput): string {
  const profile = JSON.stringify(input);
  if (profile.length > PROFILE_MAX_CHARS) throw new PapError("bad_request");
  return profile;
}

export function viewOf(record: AgentRecord): AgentView {
  const state =
    record.input === null
      ? "unreadable"
      : record.quarantinedAt !== null
        ? "quarantined"
        : record.paused
          ? "paused"
          : "active";
  return {
    id: record.id,
    name: record.name,
    input: record.input,
    state,
    threadSessionId: record.threadSessionId,
    unread: record.unread,
    paused: record.paused,
    quarantinedAt: record.quarantinedAt,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** `automation` is an internal credential name; everything else is the caller. */
export function actorOf(caller: Caller): { actor: "user" | "token" | "system"; actorId: string } {
  const actorId = caller.credentialId.slice(0, 128);
  if (caller.credentialId === "automation") return { actor: "system", actorId };
  return { actor: caller.kind === "token" ? "token" : "user", actorId };
}

/**
 * Views up to one page. A row whose id no longer reads as an agent id (a hand edit) cannot be an `AgentView` and would fail
 * the whole answer: it is skipped, and told in the log.
 */
export function pageOf(records: readonly AgentRecord[], logger: Logger): ResultOf<"agents.list"> {
  const agents: AgentView[] = [];
  let used = VIEW_ENVELOPE_BYTES;
  for (const record of records) {
    if (!AgentId.safeParse(record.id).success) {
      logger.warn("agent_row_unlistable", { name: record.name });
      continue;
    }
    const view = viewOf(record);
    const size = sizeOf(view) + 1;
    if (used + size > PAGE_BYTES) return { agents, truncated: true };
    used += size;
    agents.push(view);
  }
  return { agents, truncated: false };
}

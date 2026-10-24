import { PapError } from "@pap/contracts";
import { PlatformRefusal } from "../../platform/index.ts";
import { createRequests, type RequestItems } from "../index.ts";
import { agentInput, createAgentsBed } from "./bed.ts";

export interface ItemCall {
  readonly kind: string;
  readonly refId: string;
  readonly agentId: string;
  readonly detail: string | null;
  readonly toHandle: boolean;
}

/** The agents bed with a real requests service over its database, and a recording Inbox port and stream. */
export async function createRequestsBed(options: { readOnly?: boolean; auditFails?: boolean } = {}) {
  const bed = createAgentsBed();
  const { id: agentId } = await bed.agents.create(bed.owner(), agentInput());
  const upserts: ItemCall[] = [];
  const resolved: Array<{ ownerId: string; kind: string; refId: string; resolution: string | null }> = [];
  const changed: Array<{ ownerId: string; requestId: string }> = [];
  const warnings: string[] = [];
  const audit = options.auditFails
    ? {
        append: (): never => {
          throw new Error("audit down");
        },
      }
    : bed.audit;
  const items: RequestItems = {
    upsertAgentItem(input) {
      upserts.push({
        kind: input.kind,
        refId: input.refId,
        agentId: input.agentId ?? "",
        detail: input.detail ?? null,
        toHandle: input.toHandle,
      });
      return true;
    },
    resolveRef(ownerId, kind, refId, resolution) {
      resolved.push({ ownerId, kind, refId, resolution });
      return true;
    },
  };
  const build = () =>
    createRequests({
      db: bed.db,
      clock: bed.clock,
      logger: { warn: (message: string) => void warnings.push(message), error: () => {} },
      items,
      audit,
      changed: (ownerId, requestId) => void changed.push({ ownerId, requestId }),
      readOnly: options.readOnly ?? false,
    });
  const requests = build();
  const input = (over: Partial<Parameters<typeof requests.open>[0]> = {}) => ({
    kind: "approve" as const,
    ownerId: "u1",
    agentId,
    sessionId: "t1",
    title: "Deploy to prod?",
    detail: null,
    expiresAt: bed.clock.now() + 60_000,
    ...over,
  });
  const stateOf = (id: string) =>
    bed.db.get<{ state: string; answered_at: number | null }>(
      "SELECT state, answered_at FROM agent_requests WHERE id = $id",
      { id },
    );
  return { bed, agentId, requests, build, input, upserts, resolved, changed, stateOf, warnings };
}
export type RequestsBed = Awaited<ReturnType<typeof createRequestsBed>>;

/** The code a synchronous call refuses with, else "none". */
export function refusalCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof PlatformRefusal ? error.code : `other: ${String(error)}`;
  }
  return "none";
}

/** The PapError code a call refuses with (sync or async), else "none". */
export async function papCode(fn: () => unknown): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return error instanceof PapError ? error.code : `other: ${String(error)}`;
  }
  return "none";
}

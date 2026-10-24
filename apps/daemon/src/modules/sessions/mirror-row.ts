import type { mirrorFileOf } from "../agent-vm/index.ts";
import type { MarksStore } from "./marks-store.ts";

/**
 * What a mirror lookup reads of a session's file: the file, the agent it belongs to, or the project of its box. A project
 * session has no agent, and its row does not carry the project: the marks do (a host project's id finds no mirror folder).
 */
export function mirrorRowOf(
  marks: Pick<MarksStore, "row">,
  row: { readonly id: string; readonly agentId?: string | undefined },
  piPath: string | null,
): Parameters<typeof mirrorFileOf>[1] {
  return { piPath, agentId: row.agentId, projectId: marks.row(row.id)?.projectId ?? undefined };
}

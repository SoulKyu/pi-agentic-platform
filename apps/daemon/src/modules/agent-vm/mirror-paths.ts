import { basename, dirname, join } from "node:path";
import { AgentId, PapError, SessionFileName } from "@pap/contracts";

/** The row facts a mirror lookup reads (structural: the sessions store's row has more). */
export interface MirrorRow {
  readonly piPath: string | null;
  readonly agentId?: string | undefined;
}

const mirrorsOf = (papHome: string): string => join(papHome, "agents", ".mirrors");

/** R23: `<papHome>/agents/.mirrors/<agent id>/<file>`; `file` is one session file name, never a path. */
export function mirrorPathOf(papHome: string, agentId: string, file: string): string {
  if (!AgentId.safeParse(agentId).success || !SessionFileName.safeParse(file).success)
    throw new PapError("bad_request");
  return join(mirrorsOf(papHome), agentId, file);
}

/** The basename of the row's Pi file when it sits directly in its agent's mirror folder, else null (a host file). */
export function mirrorFileOf(papHome: string, row: MirrorRow): string | null {
  if (row.piPath === null || row.agentId === undefined || !AgentId.safeParse(row.agentId).success)
    return null;
  const file = basename(row.piPath);
  if (!SessionFileName.safeParse(file).success) return null;
  return dirname(row.piPath) === join(mirrorsOf(papHome), row.agentId) ? file : null;
}

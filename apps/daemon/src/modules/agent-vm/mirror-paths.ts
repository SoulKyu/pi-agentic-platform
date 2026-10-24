import { basename, dirname, join } from "node:path";
import { AgentId, PapError, ProjectId, SessionFileName } from "@pap/contracts";

/** The row facts a mirror lookup reads (structural: the sessions store's row has more). */
export interface MirrorRow {
  readonly piPath: string | null;
  readonly agentId?: string | undefined;
  /** A session of a project's box has this and no `agentId` (the launcher names it: the sessions row does not carry it). */
  readonly projectId?: string | undefined;
}

const mirrorsOf = (papHome: string): string => join(papHome, "agents", ".mirrors");

/** R23: `<papHome>/agents/.mirrors/<agent id>/<file>`; `file` is one session file name, never a path. */
export function mirrorPathOf(papHome: string, agentId: string, file: string): string {
  if (!AgentId.safeParse(agentId).success || !SessionFileName.safeParse(file).success)
    throw new PapError("bad_request");
  return join(mirrorsOf(papHome), agentId, file);
}

const projectMirrorsOf = (papHome: string): string => join(papHome, "boxes", ".mirrors");

/** `<papHome>/boxes/.mirrors/<project id>/<file>`: a project box's session files, the same rules as an agent's. */
export function projectMirrorPathOf(papHome: string, projectId: string, file: string): string {
  if (!ProjectId.safeParse(projectId).success || !SessionFileName.safeParse(file).success)
    throw new PapError("bad_request");
  return join(projectMirrorsOf(papHome), projectId, file);
}

/** The mirror folder of an agent id or a project id (the quota counts what is in it); the two never share a spelling. */
export const mirrorFolderOf = (papHome: string, id: string): string =>
  ProjectId.safeParse(id).success ? join(projectMirrorsOf(papHome), id) : join(mirrorsOf(papHome), id);

/** The basename of the row's Pi file when it sits directly in its box's mirror folder, else null (a host file). */
export function mirrorFileOf(papHome: string, row: MirrorRow): string | null {
  if (row.piPath === null) return null;
  const folder = mirrorFolderFor(papHome, row);
  if (folder === null) return null;
  const file = basename(row.piPath);
  if (!SessionFileName.safeParse(file).success) return null;
  return dirname(row.piPath) === folder ? file : null;
}

function mirrorFolderFor(papHome: string, row: MirrorRow): string | null {
  if (row.agentId !== undefined)
    return AgentId.safeParse(row.agentId).success ? join(mirrorsOf(papHome), row.agentId) : null;
  return row.projectId !== undefined && ProjectId.safeParse(row.projectId).success
    ? join(projectMirrorsOf(papHome), row.projectId)
    : null;
}

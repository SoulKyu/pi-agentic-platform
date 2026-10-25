import { join } from "node:path";
import { type AgentResources, PapError, type VmLayout } from "@pap/contracts";
import type { BoxAuditActor, ProjectBoxRow } from "../../kernel/boxes.ts";
import type { SessionRow } from "./store.ts";
import { privateFolder, realFs, type VmGateFs } from "./vm-gate.ts";

/**
 * What the sessions module reads of the project boxes (spec boxes, task A3). `projectOf` is lexical: a row's cwd is matched
 * against the box roots by name, and no file system is asked (a box path may not exist on the host at all).
 */
export interface SessionBoxes {
  /** The project whose box the row runs in: a row with no agent whose cwd is in a box project's folder; null for any other row. */
  projectOf(row: Pick<SessionRow, "ownerId" | "cwd" | "agentId">): string | null;
  box(projectId: string): ProjectBoxRow | null;
  /** The box owner's own Claude token is set: the bridge's environment goes to a box only then. */
  claudeTokenSet(ownerId: string): boolean;
  /** The owner allowed a host for this project's box: the project's list, audited (the source's `addHost`). */
  addHost(projectId: string, host: string, actor: BoxAuditActor): void;
}

/** What a launch of a session in a project's box needs, read once by the gate. Never logged. */
export interface ProjectLaunch {
  readonly project: { readonly id: string };
  /** The box's resources now: the VM starts with them, and they bound the project's mirrors. */
  readonly resources: AgentResources;
  /** The project folder in the box: the rules' scope, in place of a host folder's. */
  readonly scope: string;
  /** The box's home: Claude Code's config folder is under it (ADR 0080). */
  readonly home: string;
  /** The session runs in a VM (the launcher's check that the row and the gate agree). */
  readonly vm: true;
  /** For a later task (the project's packages, ADR 0080): the extra environment of the worker. */
  readonly claudeEnv?: Readonly<Record<string, string>>;
}

/**
 * The launch gate of a session in a project's box (new, reopened or a task): the box exists, belongs to the row's owner and is
 * not being deleted, else `not_found` (never a hint which of the three). Null for a row that is not in a box. The one host
 * folder it makes is the project's mirror folder, `$PAP_HOME/boxes/.mirrors/<project id>/` (0700, a link or a file there is
 * `invalid_cwd`), like an agent's; the box's own paths are never looked at on the host.
 */
export function projectGate(
  row: SessionRow,
  deps: {
    readonly boxes: SessionBoxes;
    vmLayoutOf(row: SessionRow): VmLayout | null;
    readonly papHome: string;
    readonly fs?: VmGateFs;
  },
): ProjectLaunch | null {
  const id = deps.boxes.projectOf(row);
  if (id === null) return null;
  const box = deps.boxes.box(id);
  if (box === null || box.ownerId !== row.ownerId || box.deleting) throw new PapError("not_found");
  const layout = deps.vmLayoutOf(row);
  if (layout?.project === undefined) throw new PapError("sandbox_unavailable");
  const boxesDir = join(deps.papHome, "boxes");
  const mirrors = join(boxesDir, ".mirrors");
  for (const folder of [boxesDir, mirrors, join(mirrors, id)]) privateFolder(deps.fs ?? realFs, folder);
  return { project: { id }, resources: box.resources, scope: layout.project, home: layout.home, vm: true };
}

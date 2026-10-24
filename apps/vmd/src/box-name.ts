import { AgentId, BoxRef, TaskKey } from "@pap/contracts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROJECT_VM = /^pap_p_([0-9a-f]{32})$/;
const AGENT_VM = /^pap-(.+?)(?:-([0-9a-f]{32}))?$/;
const PROJECT_TRASH = /^project_([0-9a-f]{32})$/;

/**
 * A box's identity below the runtime. An agent keeps its historic names (`pap-<id>`, `agents/<id>`, trash `<id>-<stamp>`).
 * A project name always holds an underscore, which an `AgentId` never does, so no project name parses as an agent and the
 * other way round: container and volume `pap_p_<uuid without dashes>`, folder `projects/<uuid>`, trash `project_<hex>-<stamp>`.
 * The uuid is lowercase here: one project, one spelling, one disk.
 */
export function checkedBox(box: BoxRef): BoxRef {
  const parsed = BoxRef.parse(box);
  if (parsed.kind === "agent") return { kind: "agent", id: AgentId.parse(parsed.id) };
  if (!UUID.test(parsed.id)) throw new Error("box: a project id is a lowercase uuid");
  return parsed;
}

const hexOf = (id: string): string => id.replaceAll("-", "");
const uuidOf = (hex: string): string =>
  `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;

export function vmName(box: BoxRef, taskKey: string | null): string {
  const checked = checkedBox(box);
  if (checked.kind === "project") {
    if (taskKey !== null) throw new Error("box: a project box has no task");
    return `pap_p_${hexOf(checked.id)}`;
  }
  return taskKey === null ? `pap-${checked.id}` : `pap-${checked.id}-${taskKey}`;
}

/** The box and task key a container name stands for, or null for a name that is none of pap's. */
export function parseVmName(name: string): { box: BoxRef; taskKey: string | null } | null {
  const project = PROJECT_VM.exec(name);
  if (project?.[1] !== undefined) return { box: { kind: "project", id: uuidOf(project[1]) }, taskKey: null };
  const match = AGENT_VM.exec(name);
  const id = match?.[1];
  const taskKey = match?.[2] ?? null;
  if (id === undefined || !AgentId.safeParse(id).success) return null;
  if (taskKey !== null && !TaskKey.safeParse(taskKey).success) return null;
  return { box: { kind: "agent", id }, taskKey };
}

/** The folder of a box under the state root: `agents/<id>` or `projects/<uuid>`. */
export function boxFolder(box: BoxRef): readonly [string, string] {
  const checked = checkedBox(box);
  return [checked.kind === "agent" ? "agents" : "projects", checked.id];
}

/** The trash entry's prefix (before `-<stamp>`). */
export function trashPrefix(box: BoxRef): string {
  const checked = checkedBox(box);
  return checked.kind === "agent" ? checked.id : `project_${hexOf(checked.id)}`;
}

export function boxOfTrashPrefix(prefix: string): BoxRef | null {
  const project = PROJECT_TRASH.exec(prefix);
  if (project?.[1] !== undefined) return { kind: "project", id: uuidOf(project[1]) };
  return AgentId.safeParse(prefix).success ? { kind: "agent", id: prefix } : null;
}

export const sameBox = (a: BoxRef, b: BoxRef): boolean => a.kind === b.kind && a.id === b.id;

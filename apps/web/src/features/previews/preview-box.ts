import type { BoxRef, PreviewView } from "@pap/contracts";
import { boxProjectOf } from "../../stores/box-phase.ts";
import type { ShellView } from "../../stores/shell-reducer.ts";

/** The box a session runs in: its box project (by id, else by folder). Null for a host project, a bare session or an unknown one. */
export function boxOfSession(view: ShellView, sessionId: string): BoxRef | null {
  const session = view.sessions.get(sessionId);
  if (!session) return null;
  const project = session.projectId === null ? undefined : view.projects.get(session.projectId);
  const box =
    project?.kind === "box"
      ? project
      : session.projectId === null
        ? boxProjectOf(view.projects, session.cwd)
        : undefined;
  return box === undefined ? null : { kind: "project", id: box.id };
}

/** The running services of one box, by name: a failed or ended one has no strip line and no phone entry. */
export function runningOf(services: ReadonlyMap<string, PreviewView>, box: BoxRef): PreviewView[] {
  return [...services.values()]
    .filter((one) => one.box.kind === box.kind && one.box.id === box.id && one.state === "running")
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

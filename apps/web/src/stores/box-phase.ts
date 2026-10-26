import { AgentId, type BoxPhase, type ProjectSummary } from "@pap/contracts";
import { useEffect, useRef } from "react";
import { useIsLaunching } from "./launch-store.ts";
import { useShellStore } from "./shell-store.ts";

/** The box project whose root is `path` or holds it; a host project is never one (a host path never matches a box root). */
export function boxProjectOf(
  projects: ReadonlyMap<string, ProjectSummary>,
  path: string,
): ProjectSummary | undefined {
  for (const project of projects.values()) {
    if (project.kind === "box" && (path === project.root || path.startsWith(`${project.root}/`)))
      return project;
  }
  return undefined;
}

/** A box project's phase as the shell stream last said it; a box the stream has not described yet is stopped. */
export const phaseOf = (project: ProjectSummary): BoxPhase => project.box?.phase ?? "stopped";

/** The phase of the box holding `path`, or null when the path is not in a box project. */
export function useBoxPhase(path: string): BoxPhase | null {
  return useShellStore((state) => {
    const project = boxProjectOf(state.view.projects, path);
    return project === undefined ? null : phaseOf(project);
  });
}

/** The box project holding `path` (Files, Changes), for the START action of its stopped panel. */
export function useBoxProjectId(path: string): string | null {
  return useShellStore((state) => boxProjectOf(state.view.projects, path)?.id ?? null);
}

/** The agent whose folder is `path` (`/agents/<id>` or below), read lexically like the daemon; null for any other path. */
export function agentIdOfPath(path: string): string | null {
  if (!path.startsWith("/agents/")) return null;
  const parts = path.slice(1).split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return null;
  const id = parts[1];
  return id !== undefined && AgentId.safeParse(id).success ? id : null;
}

/**
 * Calls `onRunning` each time the box holding `path` turns `running` (R3: Files, Changes and knowledge read again). For
 * an agent's path it is each time a launch of that agent ends: the agent has no phase in the shell stream.
 */
export function useOnBoxRunning(path: string, onRunning: () => void): void {
  const phase = useBoxPhase(path);
  const agentId = agentIdOfPath(path);
  const launching = useIsLaunching(agentId === null ? null : { kind: "agent", id: agentId });
  const last = useRef(phase);
  const lastLaunching = useRef(launching);
  const callback = useRef(onRunning);
  useEffect(() => {
    callback.current = onRunning;
  });
  useEffect(() => {
    const before = last.current;
    last.current = phase;
    if (phase === "running" && before !== null && before !== "running") callback.current();
  }, [phase]);
  useEffect(() => {
    const before = lastLaunching.current;
    lastLaunching.current = launching;
    if (agentId !== null && before && !launching) callback.current();
  }, [launching, agentId]);
}

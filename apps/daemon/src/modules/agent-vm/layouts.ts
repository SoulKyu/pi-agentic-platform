import { BOX_MOUNT, PapError, projectBoxPaths, type ProjectBoxPaths, type VmLayout } from "@pap/contracts";
import { join } from "node:path";
import type { VmSpec } from "./runtime.ts";

/** Kata: every VM has its own `/agent`, whatever it runs (a thread or an isolated task). */
const KATA_LAYOUT: VmLayout = Object.freeze({
  root: "/agent",
  home: "/agent/home",
  knowledge: "/agent/knowledge",
  inbox: "/agent/inbox",
  pi: "/agent/.pi",
  sessions: "/agent/.pi/sessions",
  piAgentDir: "/agent/.pi/agent",
  imageAgentDir: "/opt/pap/pi-agent",
  shellOverlay: "/run/pap-shell",
});

/** The process backend's temp folder of one VM: `$PAP_HOME/tmp/agent-vm/<agent id>[-<task key>]`. */
export function processRootOf(papHome: string, spec: { agentId: string; taskKey: string | null }): string {
  return join(
    papHome,
    "tmp",
    "agent-vm",
    spec.taskKey === null ? spec.agentId : `${spec.agentId}-${spec.taskKey}`,
  );
}

/**
 * Where a project box lives: Kata mounts its disk at `/boxes/<id>`, the process backend (tests only) uses
 * `$PAP_HOME/tmp/boxes/<id>` with the same names inside.
 */
export function projectLayoutOf(
  backend: "kata" | "process",
  papHome: string,
  projectId: string,
): ProjectBoxPaths {
  return projectBoxPaths(
    backend === "kata" ? `${BOX_MOUNT}/${projectId}` : join(papHome, "tmp", "boxes", projectId),
  );
}

/** Where things are in a VM of this backend (pure, R28). */
export function layoutOf(
  backend: "kata" | "process",
  papHome: string,
  spec: { agentId: string; taskKey: string | null },
): VmLayout {
  if (backend === "kata") return { ...KATA_LAYOUT };
  const root = processRootOf(papHome, spec);
  return {
    root,
    home: join(root, "home"),
    knowledge: join(root, "knowledge"),
    inbox: join(root, "inbox"),
    pi: join(root, ".pi"),
    sessions: join(root, ".pi", "sessions"),
    piAgentDir: join(root, ".pi", "agent"),
    imageAgentDir: join(root, "image-agent"),
    shellOverlay: join(root, "run", "pap-shell"),
  };
}

/** The runtime's view of a VM spec. A project box's layout is not a `VmLayout` (spec boxes): its guest brings it (task A4). */
export function layoutOfSpec(
  backend: "kata" | "process",
  papHome: string,
  spec: Pick<VmSpec, "box" | "taskKey" | "keepKey">,
): VmLayout {
  if (spec.box.kind !== "agent") throw new PapError("sandbox_unavailable");
  // A kept task's folder is the trigger's, not the run's: the process backend names it by the keep key (K2).
  return layoutOf(backend, papHome, { agentId: spec.box.id, taskKey: spec.keepKey ?? spec.taskKey });
}

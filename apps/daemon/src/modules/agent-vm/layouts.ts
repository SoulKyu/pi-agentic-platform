import type { VmLayout } from "@pap/contracts";
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
export function processRootOf(papHome: string, spec: Pick<VmSpec, "agentId" | "taskKey">): string {
  return join(
    papHome,
    "tmp",
    "agent-vm",
    spec.taskKey === null ? spec.agentId : `${spec.agentId}-${spec.taskKey}`,
  );
}

/** Where things are in a VM of this backend (pure, R28). */
export function layoutOf(
  backend: "kata" | "process",
  papHome: string,
  spec: Pick<VmSpec, "agentId" | "taskKey">,
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

import { BOX_MOUNT, projectBoxPaths, type VmLayout } from "@pap/contracts";

/** Where things are under Kata for an agent; the process backend names its own folders in PAP_GUEST_LAYOUT (a VmLayout as JSON). */
export const KATA_LAYOUT: VmLayout = {
  root: "/agent",
  home: "/agent/home",
  knowledge: "/agent/knowledge",
  inbox: "/agent/inbox",
  pi: "/agent/.pi",
  sessions: "/agent/.pi/sessions",
  piAgentDir: "/agent/.pi/agent",
  imageAgentDir: "/opt/pap/pi-agent",
  shellOverlay: "/run/pap-shell",
};

/**
 * Where things are in a project's box under Kata: its disk is mounted at `/boxes/<id>`. The image's agent folder and the shell
 * overlay are the agents' (the daemon's `projectLayoutOf` names the same); the knowledge is the project's own folder.
 */
export const KATA_PROJECT_LAYOUT = (projectId: string): VmLayout => {
  const paths = projectBoxPaths(`${BOX_MOUNT}/${projectId}`);
  return {
    ...paths,
    knowledge: `${paths.project}/knowledge`,
    imageAgentDir: KATA_LAYOUT.imageAgentDir,
    shellOverlay: KATA_LAYOUT.shellOverlay,
  };
};

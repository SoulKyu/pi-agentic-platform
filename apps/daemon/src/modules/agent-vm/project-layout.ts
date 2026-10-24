import type { VmLayout } from "@pap/contracts";
import { projectLayoutOf as projectPathsOf } from "./layouts.ts";

/**
 * Where things are in a project's box, as the `vm` field of `init` names them. The paths are `projectBoxPaths`'s; the
 * knowledge is the project's own `<project>/knowledge` (OKF is per project, so a box has no `/agent/knowledge`). The image's
 * agent folder and the shell overlay sit where an agent's do: Kata has them at the image's fixed paths, the process backend
 * (tests only) under the box root.
 */
export function projectLayoutOf(backend: "kata" | "process", papHome: string, projectId: string): VmLayout {
  const paths = projectPathsOf(backend, papHome, projectId);
  return {
    ...paths,
    knowledge: `${paths.project}/knowledge`,
    imageAgentDir: backend === "kata" ? "/opt/pap/pi-agent" : `${paths.root}/image-agent`,
    shellOverlay: backend === "kata" ? "/run/pap-shell" : `${paths.root}/run/pap-shell`,
  };
}

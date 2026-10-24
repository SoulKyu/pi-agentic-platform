import type { ProjectGithubView } from "@pap/contracts";
import { useCallback, useEffect, useState } from "react";
import { getRuntime, RpcError, type RpcErrorCode } from "../../runtime/index.ts";

export type ProjectGithubState =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly code: RpcErrorCode }
  | { readonly kind: "ready"; readonly github: ProjectGithubView };

/** A clone that runs is read again this often until it ends. */
const CLONE_POLL_MS = 3000;

/**
 * `projects.github` for one project (the daemon caches the lists for 60 s): read on mount and on demand. A failed read is
 * a state of its own, and a ready view stays on screen while the next read runs. `replace` takes the answer of a call
 * that returns the view (`projects.linkGithub`).
 */
export function useProjectGithub(projectId: string) {
  const [state, setState] = useState<ProjectGithubState>({ kind: "loading" });
  const [reads, setReads] = useState(0);
  useEffect(() => {
    let current = true;
    getRuntime()
      .rpc.call("projects.github", { projectId })
      .then(
        ({ github }) => {
          if (current) setState({ kind: "ready", github });
        },
        (failure: unknown) => {
          if (current)
            setState({ kind: "failed", code: failure instanceof RpcError ? failure.code : "internal" });
        },
      );
    return () => {
      current = false;
    };
  }, [projectId, reads]);
  const cloning = state.kind === "ready" && state.github.clone?.state === "pending";
  useEffect(() => {
    if (!cloning) return undefined;
    const timer = setTimeout(() => setReads((count) => count + 1), CLONE_POLL_MS);
    return () => clearTimeout(timer);
  }, [cloning, reads]);
  const reload = useCallback(() => setReads((count) => count + 1), []);
  const replace = useCallback((github: ProjectGithubView) => setState({ kind: "ready", github }), []);
  return { state, reload, replace };
}

import type { BoxPhase, ProjectBoxView } from "@pap/contracts";
import { useCallback, useEffect, useState } from "react";
import { getRuntime } from "../../runtime/index.ts";

export type ProjectBoxState =
  | { readonly kind: "loading" }
  | { readonly kind: "failed" }
  | { readonly kind: "ready"; readonly box: ProjectBoxView };

/** The packages `.pi/project.yaml` asks for differ from the ones the image holds (as sets). */
export function packagesChanged(box: ProjectBoxView): boolean {
  const { built, wanted } = box.packages;
  if (wanted === null) return false;
  const have = new Set(built);
  return wanted.length !== have.size || wanted.some((name) => !have.has(name));
}

/**
 * `projects.box` for one project, read again when its phase moves (a start can change the packages).
 * A failed read is a state of its own: the facts that need it simply do not show.
 */
export function useProjectBox(projectId: string, phase: BoxPhase) {
  const [state, setState] = useState<ProjectBoxState>({ kind: "loading" });
  useEffect(() => {
    let current = true;
    getRuntime()
      .rpc.call("projects.box", { projectId })
      .then(
        ({ box }) => {
          if (current) setState({ kind: "ready", box });
        },
        () => {
          if (current) setState((was) => (was.kind === "ready" ? was : { kind: "failed" }));
        },
      );
    return () => {
      current = false;
    };
  }, [projectId, phase]);
  const replace = useCallback((box: ProjectBoxView) => setState({ kind: "ready", box }), []);
  return { state, replace };
}

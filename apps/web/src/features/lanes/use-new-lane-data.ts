import type { LanePreview } from "@pap/contracts";
import { useCallback, useEffect, useState } from "react";
import type { MessageKey } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { failureKey } from "./failure-text.ts";
import { type ModelChoice, modelChoices } from "./new-lane.vm.ts";

/**
 * `lanes.preview` of the picked project, read again on `reload` (after an approval). A later answer replaces an
 * earlier one and an answer for a project no longer picked is dropped; the last good preview stays while the next loads.
 */
export function useLanePreview(projectRoot: string | null) {
  const [state, setState] = useState<{ root: string; preview: LanePreview } | null>(null);
  const [failed, setFailed] = useState<{ root: string; key: MessageKey } | null>(null);
  const [loads, setLoads] = useState(0);
  useEffect(() => {
    if (projectRoot === null) return undefined;
    let current = true;
    getRuntime()
      .rpc.call("lanes.preview", { projectRoot })
      .then(
        (preview) => {
          if (!current) return;
          setState({ root: projectRoot, preview });
          setFailed(null);
        },
        (failure: unknown) => {
          if (current) setFailed({ root: projectRoot, key: failureKey(failure, "laneNew.previewFailed") });
        },
      );
    return () => {
      current = false;
    };
  }, [projectRoot, loads]);
  const reload = useCallback(() => setLoads((count) => count + 1), []);
  return {
    preview: state !== null && state.root === projectRoot ? state.preview : null,
    error: failed !== null && failed.root === projectRoot ? failed.key : null,
    reload,
  };
}

/** The project's enabled models (`models.overview` for its folder); empty while loading or when it cannot be read. */
export function useModelChoices(projectRoot: string | null): { choices: ModelChoice[]; truncated: boolean } {
  const [state, setState] = useState<{ root: string; choices: ModelChoice[]; truncated: boolean } | null>(
    null,
  );
  useEffect(() => {
    if (projectRoot === null) return undefined;
    let current = true;
    getRuntime()
      .rpc.call("models.overview", { cwd: projectRoot })
      .then(
        (overview) => {
          if (current)
            setState({ root: projectRoot, choices: modelChoices(overview), truncated: overview.truncated });
        },
        () => {
          if (current) setState({ root: projectRoot, choices: [], truncated: false });
        },
      );
    return () => {
      current = false;
    };
  }, [projectRoot]);
  return state !== null && state.root === projectRoot ? state : { choices: [], truncated: false };
}

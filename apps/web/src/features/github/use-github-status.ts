import "../../i18n/register-github.ts";
import type { GithubStatusView } from "@pap/contracts";
import { useCallback, useEffect, useState } from "react";
import { getRuntime } from "../../runtime/index.ts";

export type GithubStatusState =
  | { readonly kind: "loading" }
  | { readonly kind: "failed" }
  | { readonly kind: "ready"; readonly status: GithubStatusView };

/** `github.status` once on mount, read again on demand (after Disconnect or Delete). A failed read is a state of its own. */
export function useGithubStatus() {
  const [state, setState] = useState<GithubStatusState>({ kind: "loading" });
  const [reads, setReads] = useState(0);
  useEffect(() => {
    let current = true;
    getRuntime()
      .rpc.call("github.status", {})
      .then(
        ({ status }) => {
          if (current) setState({ kind: "ready", status });
        },
        () => {
          if (current) setState({ kind: "failed" });
        },
      );
    return () => {
      current = false;
    };
  }, [reads]);
  const reload = useCallback(() => setReads((count) => count + 1), []);
  return { state, reload };
}

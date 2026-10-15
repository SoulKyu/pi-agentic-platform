import { useEffect, useState } from "react";
import type { MessageKey } from "../../i18n/index.ts";
import { getRuntime, RpcError } from "../../runtime/index.ts";

/**
 * Whether the workspace module opens the project's root (`files.list`), once per root. Only its refusal
 * (`not_found`, `forbidden`) disables Files and Terminal; a timeout or an offline socket says nothing (PH12).
 */
export function useRootAccess(root: string | null): MessageKey | null {
  const [refused, setRefused] = useState<string | null>(null);
  useEffect(() => {
    if (root === null) return undefined;
    let current = true;
    getRuntime()
      .rpc.call("files.list", { path: root })
      .then(
        () => {
          if (current) setRefused(null);
        },
        (failure: unknown) => {
          if (
            current &&
            failure instanceof RpcError &&
            (failure.code === "not_found" || failure.code === "forbidden")
          )
            setRefused(root);
        },
      );
    return () => {
      current = false;
    };
  }, [root]);
  return root !== null && refused === root ? "home.reason.rootRefused" : null;
}

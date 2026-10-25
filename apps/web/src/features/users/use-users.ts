import type { InviteView, ProviderSharingView, UserView } from "@pap/contracts";
import { usePendingAction } from "@pap/ui";
import { useCallback, useEffect, useState } from "react";
import { errorKey, type MessageKey } from "../../i18n/index.ts";
import { getRuntime, RpcError } from "../../runtime/index.ts";

export type UsersState =
  | { readonly kind: "loading" }
  | { readonly kind: "failed" }
  | {
      readonly kind: "ready";
      readonly users: readonly UserView[];
      readonly invites: readonly InviteView[];
      readonly providers: readonly ProviderSharingView[];
    };

/** The list, the pending invitations and the provider switches, read together; `reload` reads them again after a change. */
export function useUsers() {
  const [state, setState] = useState<UsersState>({ kind: "loading" });
  const [reads, setReads] = useState(0);
  useEffect(() => {
    let current = true;
    const { rpc } = getRuntime();
    Promise.all([rpc.call("users.list", {}), rpc.call("users.providers", {})]).then(
      ([{ users, invites }, { providers }]) => {
        if (current) setState({ kind: "ready", users, invites, providers });
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
  const retry = useCallback(() => {
    setState({ kind: "loading" });
    setReads((count) => count + 1);
  }, []);
  return { state, reload, retry };
}

/** One action at a time: `since` feeds the button's `pendingSince` (§7.3); a refusal becomes `problem`, the code in words. */
export function useUserAction() {
  const pending = usePendingAction();
  const [problem, setProblem] = useState<MessageKey | null>(null);
  const run = (work: () => Promise<void>) =>
    void pending.run(async () => {
      setProblem(null);
      try {
        await work();
      } catch (failure) {
        setProblem(errorKey(failure instanceof RpcError ? failure.code : "internal"));
      }
    });
  return { since: pending.since, problem, run, setProblem };
}

import { usePendingAction } from "@pap/ui";
import type { ParamsOf } from "@pap/contracts";
import { getRuntime, RpcError } from "../../runtime/index.ts";

export type CallResult = { readonly ok: true } | { readonly ok: false; readonly code: string };

/** One memory write at a time: its answer (never thrown) and when it started, for a Button's `pendingSince`. */
export function useMemoryCall() {
  const pending = usePendingAction();
  const call = <M extends "memory.forget" | "memory.save" | "memory.decide">(
    method: M,
    params: ParamsOf<M>,
  ): Promise<CallResult | undefined> =>
    pending.run(async (): Promise<CallResult> => {
      const { rpc } = getRuntime();
      try {
        await rpc.call(method, params, { commandId: rpc.newCommandId() });
        return { ok: true };
      } catch (failure) {
        return { ok: false, code: failure instanceof RpcError ? failure.code : "internal" };
      }
    });
  return { since: pending.since, call };
}

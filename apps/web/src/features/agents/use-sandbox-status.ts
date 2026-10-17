import { EGRESS_UNKNOWN, type SandboxStatus } from "@pap/contracts";
import { useEffect, useState } from "react";
import { getRuntime, RpcError } from "../../runtime/index.ts";

/** `checkedAt: 0`: the daemon's first probe has not ended (M11R20). */
const CHECKING: SandboxStatus = {
  usable: false,
  path: null,
  reason: null,
  checkedAt: 0,
  egress: EGRESS_UNKNOWN,
};
const POLL_MS = 2000;
const MAX_POLLS = 5;

export type RecheckOutcome = "ok" | "rate_limited" | "failed";

export interface SandboxControl {
  readonly status: SandboxStatus;
  /** The first read failed: the page says so instead of waiting for an answer that will not come. */
  readonly readFailed: boolean;
  /** The daemon's first probe still has not ended after the last poll: the page stops saying "checking". */
  readonly slow: boolean;
  /** `agents.recheckSandbox`; the daemon allows one per 10 s. Never throws. */
  recheck(): Promise<RecheckOutcome>;
}

/**
 * The sandbox probe (W5-R21): read when the page opens, read again every 2 s (5 times at most) while the daemon's first
 * probe is still running, and again on "Check again". An answer older than the one shown is dropped.
 */
export function useSandboxStatus(): SandboxControl {
  const [state, setState] = useState({ status: CHECKING, readFailed: false });
  const [pollsEnded, setPollsEnded] = useState(false);
  const accept = (wire: Omit<SandboxStatus, "egress"> & { readonly egress?: SandboxStatus["egress"] }) => {
    const next: SandboxStatus = { ...wire, egress: wire.egress ?? EGRESS_UNKNOWN };
    setState((previous) =>
      next.checkedAt >= previous.status.checkedAt ? { status: next, readFailed: false } : previous,
    );
  };
  useEffect(() => {
    let live = true;
    let polls = 0;
    let timer: number | undefined;
    const read = () => {
      getRuntime()
        .rpc.call("agents.sandboxStatus", {})
        .then(
          (next) => {
            if (!live) return;
            accept(next);
            if (next.checkedAt === 0 && polls < MAX_POLLS) {
              polls += 1;
              timer = window.setTimeout(read, POLL_MS);
            } else if (next.checkedAt === 0) {
              setPollsEnded(true);
            }
          },
          () => {
            if (live) setState((previous) => ({ ...previous, readFailed: true }));
          },
        );
    };
    read();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, []);
  const recheck = async (): Promise<RecheckOutcome> => {
    try {
      accept(await getRuntime().rpc.call("agents.recheckSandbox", {}));
      return "ok";
    } catch (failure) {
      return failure instanceof RpcError && failure.code === "rate_limited" ? "rate_limited" : "failed";
    }
  };
  return {
    status: state.status,
    readFailed: state.readFailed,
    slow: pollsEnded && state.status.checkedAt === 0,
    recheck,
  };
}

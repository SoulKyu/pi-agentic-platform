import type { BoxRef } from "@pap/contracts";
import type { AgentRuntimeBackend, VmSpec } from "./runtime.ts";

/** Tests only: told of the VMs a backend starts and stops. */
export interface BackendObserver {
  started?(spec: VmSpec): void;
  stopped?(box: BoxRef, taskKey: string | null): void;
}

export function observedBackend(
  real: AgentRuntimeBackend,
  observer: BackendObserver | undefined,
): AgentRuntimeBackend {
  if (observer === undefined) return real;
  return {
    ...real,
    start(spec, launch) {
      observer.started?.(spec);
      return real.start(spec, launch);
    },
    stop(box, taskKey) {
      observer.stopped?.(box, taskKey);
      return real.stop(box, taskKey);
    },
  };
}

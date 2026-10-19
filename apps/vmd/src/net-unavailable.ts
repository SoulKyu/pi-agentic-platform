import { VmdFailure } from "./errors.ts";
import type { NetPort } from "./ops.ts";

/** Until T16a composes the real network, every start fails closed: no VM runs without its anti-spoofing guard (R22). */
export const unavailableNet: NetPort = {
  allocate() {
    throw new VmdFailure("unavailable");
  },
  attach: () => Promise.reject(new VmdFailure("unavailable")),
  detach: () => Promise.resolve(),
  restore: () => Promise.resolve(),
};

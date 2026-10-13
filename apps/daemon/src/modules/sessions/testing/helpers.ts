import type { PapError } from "@pap/contracts";

/** The error code a promise rejects with, or null when it resolves. */
export const codeOf = (promise: Promise<unknown>): Promise<string | null> =>
  promise.then(
    () => null,
    (error: PapError) => error.code,
  );

export { captureLogger } from "../../../testing/capture-logger.ts";

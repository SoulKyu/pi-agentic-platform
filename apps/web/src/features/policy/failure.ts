import { errorKey, t } from "../../i18n/index.ts";
import { RpcError } from "../../runtime/index.ts";

/** The code of a failed call: the server's or the client's own (`offline`, `connection_lost`...), `internal` for anything else. */
export const failureCode = (failure: unknown): string =>
  failure instanceof RpcError ? failure.code : "internal";

/** The i18n text of the code only: the server's message never reaches the screen. */
export const failureText = (failure: unknown): string => t(errorKey(failureCode(failure)));

/** After these a mutation may have gone through (R105): look at the state before anything else. */
export const outcomeUnknown = (failure: unknown): boolean =>
  ["timeout", "connection_lost"].includes(failureCode(failure));

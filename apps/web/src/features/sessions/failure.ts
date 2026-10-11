import { errorKey, t } from "../../i18n/index.ts";
import { RpcError } from "../../runtime/index.ts";

/** The code of a failed call: the server's or the client's own (`offline`, `connection_lost`...), `internal` for anything else. */
export const failureCode = (failure: unknown): string =>
  failure instanceof RpcError ? failure.code : "internal";

export const codeText = (code: string): string => t(errorKey(code));

export const failureText = (failure: unknown): string => codeText(failureCode(failure));

/** After these a mutation may have gone through (R105): do not offer it again as is, and look at the state. */
export const outcomeUnknown = (failure: unknown): boolean =>
  ["timeout", "connection_lost"].includes(failureCode(failure));

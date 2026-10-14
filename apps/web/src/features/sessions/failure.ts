import { errorKey, t } from "../../i18n/index.ts";
import { RpcError } from "../../runtime/index.ts";

/** The code of a failed call: the server's or the client's own (`offline`, `connection_lost`...), `internal` for anything else. */
export const failureCode = (failure: unknown): string =>
  failure instanceof RpcError ? failure.code : "internal";

export const codeText = (code: string): string => t(errorKey(code));

/** The sentence of a failed call; a capacity refusal from a daemon that counted adds "n / n workers". */
export const failureText = (failure: unknown): string => {
  const text = codeText(failureCode(failure));
  return failure instanceof RpcError && failure.workers
    ? `${text} ${t("error.capacityWorkers", { used: failure.workers.used, max: failure.workers.max })}`
    : text;
};

/** After these a mutation may have gone through (R105): do not offer it again as is, and look at the state. */
export const outcomeUnknown = (failure: unknown): boolean =>
  ["timeout", "connection_lost"].includes(failureCode(failure));

import { errorKey, t } from "../../i18n/index.ts";
import { RpcError } from "../../runtime/index.ts";

/** The code of a failed call: the server's or the client's own (`offline`, `connection_lost`...), `internal` for anything else. */
export const failureCode = (failure: unknown): string =>
  failure instanceof RpcError ? failure.code : "internal";

export const codeText = (code: string): string => t(errorKey(code));

/** The fixed text of the code only: the server's message never reaches the screen. */
export const failureText = (failure: unknown): string => codeText(failureCode(failure));

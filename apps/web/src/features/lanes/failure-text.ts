import { errorKey, type MessageKey } from "../../i18n/index.ts";
import { RpcError } from "../../runtime/index.ts";

/** A failed call in words: the server's code when there is one (forbidden, capacity, offline…), else the fallback. */
export const failureKey = (failure: unknown, fallback: MessageKey): MessageKey =>
  failure instanceof RpcError ? errorKey(failure.code) : fallback;

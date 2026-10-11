import { errorKey, t, type MessageKey } from "../../i18n/index.ts";
import type { AuthResult } from "./auth-api.ts";

/** `unauthenticated` reads differently on each screen: the screen passes its own words for it. */
export function authErrorText(
  result: Extract<AuthResult, { ok: false }>,
  unauthenticated: MessageKey = "error.unauthenticated",
): string {
  if (result.code === "rate_limited") return t("login.throttled", { seconds: result.retryAfterSeconds ?? 1 });
  if (result.code === "unauthenticated") return t(unauthenticated);
  return t(errorKey(result.code));
}

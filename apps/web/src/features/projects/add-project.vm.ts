import { errorKey, type MessageKey } from "../../i18n/index.ts";
import { RpcError } from "../../runtime/index.ts";

/** The one check made before any call: the daemon resolves the rest (`invalid_cwd`). */
export const isAbsolutePath = (text: string): boolean => text.trim().startsWith("/") && !text.includes("\0");

const WORDS: Readonly<Record<string, MessageKey>> = {
  invalid_cwd: "addProject.error.invalid_cwd",
  bad_request: "addProject.error.bad_request",
  capacity: "addProject.error.capacity",
  read_only: "addProject.error.read_only",
};

/** The daemon's code in the dialog's own words (§3.6); any other code says what it says everywhere. */
export function addProjectFailure(failure: unknown): MessageKey {
  const code = failure instanceof RpcError ? failure.code : "internal";
  return Object.hasOwn(WORDS, code) ? (WORDS[code] as MessageKey) : errorKey(code);
}

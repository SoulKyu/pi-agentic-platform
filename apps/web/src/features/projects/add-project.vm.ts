import { SHELL_LIMITS } from "@pap/contracts";
import { errorKey, type MessageKey } from "../../i18n/index.ts";
import { RpcError } from "../../runtime/index.ts";

/** The name `projects.create` is given: trimmed, never empty; the daemon judges the rest (`bad_request`). */
export const projectNameOf = (text: string): string | null => {
  const name = text.trim();
  return name === "" ? null : [...name].slice(0, SHELL_LIMITS.projectName * 2).join("");
};

const WORDS: Readonly<Record<string, MessageKey>> = {
  bad_request: "addProject.error.bad_request",
  capacity: "addProject.error.capacity",
  read_only: "addProject.error.read_only",
};

/** The daemon's code in the dialog's own words (§3.6); any other code says what it says everywhere. */
export function addProjectFailure(failure: unknown): MessageKey {
  const code = failure instanceof RpcError ? failure.code : "internal";
  return Object.hasOwn(WORDS, code) ? (WORDS[code] as MessageKey) : errorKey(code);
}

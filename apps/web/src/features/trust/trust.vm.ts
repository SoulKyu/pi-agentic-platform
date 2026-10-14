import type { TrustRefusal, TrustStatus } from "@pap/contracts";
import { errorKey, t } from "../../i18n/index.ts";
import { escapeHidden } from "../../lib/escape-hidden.ts";
import { RpcError } from "../../runtime/index.ts";

/** What the worker said about the folder (`SessionLoadout.projectTrust`); absent from older workers. */
export interface ProjectTrust {
  readonly required: boolean;
  readonly trusted: boolean;
}

/** The banner shows only when the worker says trust is required and not given (M7R109). */
export const needsTrust = (trust: ProjectTrust | null): boolean =>
  trust !== null && trust.required && !trust.trusted;

/** The words of one breadth rule (M7R104); the daemon names the rule, the page has the copy. */
export const refusalText = (refusal: TrustRefusal): string => t(`trust.refusal.${refusal}`);

/** The fixed text of the code only: the server's message never reaches the screen (C §4.1). */
export const trustFailureText = (failure: unknown): string =>
  t(errorKey(failure instanceof RpcError ? failure.code : "internal"));

/**
 * The list is complete only when pap listed everything: a cut list or a named gap says otherwise (MC47 I2), and the
 * dialog never shows such a list as the whole of what trusting turns on. Reasons are project text, escaped.
 */
export function incompleteness(status: TrustStatus): {
  readonly incomplete: boolean;
  readonly reasons: string[];
} {
  const reasons = status.resources.unlisted.map(escapeHidden);
  return { incomplete: status.resources.truncated || reasons.length > 0, reasons };
}

export const hasResources = ({ resources }: TrustStatus): boolean =>
  resources.mcpServers.length > 0 ||
  resources.extensions.length > 0 ||
  resources.skills.length > 0 ||
  resources.promptTemplates > 0 ||
  resources.settingsKeys.length > 0 ||
  resources.systemPrompt;

/** Project names as visible text: control, bidi and lookalike blank characters are written as `\uXXXX`. */
export const names = (list: readonly string[]): string => list.map(escapeHidden).join(", ");

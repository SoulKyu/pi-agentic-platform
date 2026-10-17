import { TrustedHost } from "@pap/contracts";
import { hostLabel } from "./audit-args.ts";
import type { ApprovalPlan, CallFacts } from "./pipeline.ts";

/** A grant changes nothing for an agent whose worker has no sandbox or no network (decision 90): no card, a fixed sentence. */
const NO_NETWORK = "This agent has no network: a host grant would change nothing.";

const hostOf = (input: unknown): unknown =>
  typeof input === "object" && input !== null ? (input as { host?: unknown }).host : undefined;

/**
 * Owner a2, M11R239: `network_request` in every mode and taint. A host the owner already allowed for this thread runs
 * unasked; any other asks Deny / Allow this host; a host that is not an exact lower-case name is blocked before a card.
 * The card names the parsed host, never the model's text. Where the worker's rules give the shell no network through the
 * proxy (sandbox off, or network off) the call is blocked before any card.
 */
export function networkRequestPlan(call: CallFacts): ApprovalPlan {
  const { sandbox } = call.rules;
  if (sandbox?.required !== true || !sandbox.network)
    return {
      outcome: "block",
      reason: NO_NETWORK,
      modelReason: `pap-policy blocked network_request: ${NO_NETWORK}`,
    };
  const parsed = TrustedHost.safeParse(hostOf(call.event.input));
  if (!parsed.success)
    return {
      outcome: "block",
      reason: "network_request: not an exact host name",
      modelReason: "pap-policy blocked network_request: the host is not a valid host name.",
    };
  const host = parsed.data;
  if (call.rules.hostGrants.includes(host))
    return { outcome: "allow", reason: "host already allowed for this thread" };
  return {
    outcome: "ask",
    title: "pap: allow a host for this thread?",
    reason: `network_request asks for ${host}. If you allow it, this agent's shell can reach that host until the thread is reset, and can send it data.`,
    auditReason: `network_request asks for ${hostLabel(host)}. If you allow it, this agent's shell can reach that host until the thread is reset, and can send it data.`,
    answers: ["deny", "host"],
    host,
    grantable: false,
  };
}

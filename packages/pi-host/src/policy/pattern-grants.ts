import type { AlwaysScope, AlwaysScopes, ToolRule } from "@pap/contracts";
import { coverCommand } from "./command-cover.ts";
import type { PolicyGrants } from "./grants.ts";
import type { CallFacts, PipelineDeps, PolicyContext } from "./pipeline.ts";
import { proposePrefix, type SessionFolder } from "./prefix-proposal.ts";
import { READ_ONLY_COMMAND_MODES } from "./stage-approval.ts";

/** M7R19: the source kind a tool rule may name, or null when the tool can never get one. */
export function toolRuleSource(call: CallFacts): ToolRule["source"] | null {
  const { kind } = call;
  if (kind.category !== "edit" && kind.category !== "network" && kind.category !== "external-write")
    return null;
  return kind.mcp ? "mcp" : kind.builtin ? "builtin" : null;
}

const commandOf = (call: CallFacts): string | null => {
  const command = (call.event.input as { command?: unknown } | null)?.command;
  return call.exec && call.event.toolName === "bash" && typeof command === "string" ? command : null;
};

/** M7R17, M7R19. Called only for a grantable question (M7R20). */
export async function patternGrant(
  call: CallFacts,
  ctx: PolicyContext,
  deps: PipelineDeps,
): Promise<"prefix rule" | "tool rule" | null> {
  const { rules, event } = call;
  // Defence in depth: a grantable question is never a tainted one (M7R20), and a rule is never valid past taint (MC17).
  if (call.tainted) return null;
  if (!call.exec) {
    const source = toolRuleSource(call);
    if (source === null) return null;
    const named = (rule: ToolRule) => rule.tool === event.toolName && rule.source === source;
    return rules.alwaysTools.some(named) || deps.grants.provisionalTools().some(named) ? "tool rule" : null;
  }
  const command = commandOf(call);
  const prefixes = [...rules.alwaysPrefixes.map((rule) => rule.prefix), ...deps.grants.provisionalPrefixes()];
  if (command === null || prefixes.length === 0) return null;
  const cover = await coverCommand(command, {
    cwd: ctx.cwd,
    home: deps.home,
    papHome: deps.papHome,
    agentDir: deps.agentDir,
    sessionId: deps.sessionId?.(),
    shell: deps.shell(),
    tainted: call.tainted,
    readOnly: rules.readOnlyCommands && READ_ONLY_COMMAND_MODES.has(rules.approvalMode),
    prefixes,
  });
  return cover.covered ? "prefix rule" : null;
}

/** What the card of a grantable question offers for "always" besides the exact call (M7R18, M7R19). */
export function alwaysScopesOf(call: CallFacts, folder?: SessionFolder): AlwaysScopes | undefined {
  const command = commandOf(call);
  const prefix = command === null ? null : proposePrefix(command, folder);
  const tool = !call.exec && toolRuleSource(call) !== null;
  if (prefix === null && !tool) return undefined;
  const source = toolRuleSource(call);
  return {
    ...(prefix === null ? {} : { prefix: [...prefix] }),
    ...(tool && source !== null ? { tool: true as const, toolSource: source } : {}),
  };
}

/** M7R21: whether the scope of an "always" answer is one the card offered. */
export const scopeOffered = (scope: AlwaysScope, offered: AlwaysScopes | undefined): boolean =>
  scope === "exact" || (scope === "prefix" ? offered?.prefix !== undefined : offered?.tool === true);

/** Remembers an offered, non-exact scope as a provisional rule. */
export function rememberScope(
  grants: PolicyGrants,
  scope: AlwaysScope,
  offered: AlwaysScopes | undefined,
  call: CallFacts,
  askedAt: number,
): void {
  const source = toolRuleSource(call);
  if (scope === "prefix" && offered?.prefix) grants.rememberAlwaysPrefix(offered.prefix, askedAt);
  else if (scope === "tool" && source !== null)
    grants.rememberAlwaysTool({ tool: call.event.toolName, source }, askedAt);
  else grants.rememberAlways(call.key, askedAt);
}

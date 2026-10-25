import type { ApprovalAnswer, ApprovalMode, ToolCategory } from "@pap/contracts/pi-host";

/** What the agent profiles add to a call's facts (stage 03). */
export interface AgentCallFacts {
  readonly category: ToolCategory;
  readonly external: boolean;
  /** The call is pap's own sandboxed `bash` (source `<inline:pap-sandbox>`), not Pi's or an extension's. */
  readonly sandboxedShell: boolean;
  /** The sandbox shares the host network (`sandbox.network`). */
  readonly sandboxNetwork: boolean;
}

/**
 * Owner m2: a sandboxed shell without network writes only its one writable folder (the home in a thread, the scratch
 * folder in an isolated task) and reaches nothing outside the machine, so it is judged as an edit there, never as an
 * exfiltration-capable call. With network it stays `exec` and external. Every other call keeps its category.
 */
export function agentCategory(call: AgentCallFacts): { category: ToolCategory; external: boolean } {
  if (call.sandboxedShell && !call.sandboxNetwork) return { category: "edit", external: false };
  if (call.sandboxedShell) return { category: "exec", external: true };
  return { category: call.category, external: call.external };
}

export type IsolatedVerdict =
  | { readonly decision: "allow"; readonly why: string }
  | { readonly decision: "ask"; readonly why: string; readonly answers: readonly ApprovalAnswer[] }
  | { readonly decision: "block"; readonly why: string };

export interface IsolatedInput extends AgentCallFacts {
  /** The trigger's mode (never full-access, M10); read-only lets reads through only. */
  readonly mode: Exclude<ApprovalMode, "full-access">;
  readonly tainted: boolean;
  /**
   * Every path the call names resolves inside the task's reach, both readings: the agent home or the task's scratch
   * folder for a read (`readsInside`), the scratch folder for a write (`checkEditTarget` against the session folder,
   * which is the scratch folder); for pap's sandboxed shell, which names no path: the rules name a real scratch folder.
   * False when unsure.
   */
  readonly insideReach: boolean;
  /** An egress host list is set: stage 02 already blocked every URL whose host is not on it (M5R21). */
  readonly hostList: boolean;
}

const ONCE: readonly ApprovalAnswer[] = ["deny", "once"];
const block = (why: string): IsolatedVerdict => ({ decision: "block", why });
const ask = (why: string): IsolatedVerdict => ({ decision: "ask", why, answers: ONCE });

/**
 * C §5.3, unattended column, for an agent's isolated task (agent trigger, tainted delegation): reads stay in the agent
 * home and the scratch folder, writes in the scratch folder (owner m17: the home is read-only), the shell runs only in
 * the sandbox, the network only through a host list, outside writes ask through the Inbox (M10: 10 minutes, then
 * denied), unknown tools never run (stage 02 blocks them first, M10R152). Questions are always Deny / Allow once.
 */
export function decideIsolated(input: IsolatedInput): IsolatedVerdict {
  const { category, external } = agentCategory(input);
  if (category === "unknown") return block("tool of unknown kind in an isolated task");
  if (category === "read") {
    if (!input.insideReach && !external) return block("outside the agent home and the task's scratch folder");
    if (external && !input.hostList) return block("no host list for an isolated task");
    return input.tainted && external
      ? ask("external content after untrusted input")
      : { decision: "allow", why: "read" };
  }
  if (input.mode === "read-only") return block("read-only task");
  if (category === "edit") {
    // pap's sandboxed shell without network: bwrap lets it write the scratch folder only, when the rules name one.
    if (!input.insideReach) return block("outside the task's scratch folder");
    return input.mode === "supervised"
      ? ask("supervised task")
      : { decision: "allow", why: "inside the task's scratch folder" };
  }
  if (category === "exec") {
    // Only pap's sandboxed shell reaches here as `exec` (with network): any other shell is not sandboxed.
    if (!input.sandboxedShell) return block("unsandboxed shell in an isolated task");
    if (!input.insideReach) return block("the rules name no scratch folder for the shell");
    if (!input.hostList) return block("a shell with network needs a host list");
    return ask("shell with network");
  }
  if (category === "network") {
    if (!input.hostList) return block("no host list for an isolated task");
    return input.tainted || input.mode === "supervised"
      ? ask("network after untrusted input")
      : { decision: "allow", why: "listed host" };
  }
  // external-write: an MCP write tool the list holds: the owner answers through the Inbox.
  return ask("external write");
}

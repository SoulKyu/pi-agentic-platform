import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { PolicyRules, ToolPreset } from "@pap/contracts";

/** Pi's own tools that read or change the machine. A preset replaces these and only these (M7R75). */
export const CODING_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "bash",
  "powershell",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
]);

const READ_ONLY = ["read", "grep", "find", "ls"] as const;
const DEFAULT = ["read", "bash", "edit", "write"] as const;
const NAMES: Readonly<Record<Exclude<ToolPreset, "configured">, readonly string[]>> = {
  none: [],
  chat: [],
  "read-only": READ_ONLY,
  default: DEFAULT,
  full: ["read", "bash", "edit", "write", "grep", "find", "ls"],
};

/** The coding tools a preset leaves active; null for `configured`, which pins nothing (M7R74). */
export function presetToolNames(preset: ToolPreset): readonly string[] | null {
  return preset === "configured" ? null : NAMES[preset];
}

// The session's preset, kept beside the session so that two sessions in one process (tests) never share it.
const presets = new WeakMap<AgentSession, ToolPreset>();
export const presetOf = (session: AgentSession): ToolPreset => presets.get(session) ?? "configured";

/** Pi's `defaultTools` setting resolved the way Pi does: plain names replace the four defaults, `+name` and `-name` edit them. */
function configuredCoding(session: AgentSession): string[] {
  const entries = session.settingsManager.getDefaultTools();
  if (entries === undefined) return [...DEFAULT];
  const edits = entries.filter((entry) => entry.startsWith("+") || entry.startsWith("-"));
  const plain = entries.filter((entry) => !edits.includes(entry));
  const chosen = new Set(plain.length > 0 || edits.length === 0 ? plain : DEFAULT);
  for (const edit of edits) {
    if (edit.startsWith("+")) chosen.add(edit.slice(1));
    else chosen.delete(edit.slice(1));
  }
  return [...chosen].filter((name) => CODING_TOOLS.has(name));
}

/**
 * Makes the preset's coding tools the active ones and leaves every other active tool as it is: MCP, codemode, tool_search
 * and an extension's tools, so a tool its extension switched off stays off (M7R75). The active set is only written when it
 * changes, and the answer says whether it did. `configured` pins nothing, except with `restore`, which returns the coding tools to Pi's own defaults.
 */
export function applyPreset(
  session: AgentSession,
  preset: ToolPreset,
  options: { restore?: boolean } = {},
): boolean {
  const wanted = presetToolNames(preset) ?? (options.restore ? configuredCoding(session) : null);
  let changed = false;
  if (wanted !== null) {
    const active = session.getActiveToolNames();
    const next = [...new Set([...wanted, ...active.filter((name) => !CODING_TOOLS.has(name))])];
    changed = !(next.length === active.length && next.every((name) => active.includes(name)));
    if (changed) session.setActiveToolsByName(next);
  }
  // After the write: if it throws, the preset the policy judges with is still the old one (nothing changes).
  presets.set(session, preset);
  return changed;
}

/**
 * The rules the policy judges with: the worker's own preset is added to the daemon's, so a rules update that is late
 * (or lost) cannot loosen it. A read-only flag the daemon sent stays. `presetTools` is the worker's alone.
 */
export function withPreset(rules: PolicyRules | null, preset: ToolPreset): PolicyRules | null {
  if (rules === null) return null;
  return {
    ...rules,
    readOnlyPreset: rules.readOnlyPreset || preset === "read-only",
    presetTools: presetToolNames(preset) === null ? null : [...(presetToolNames(preset) ?? [])],
  };
}

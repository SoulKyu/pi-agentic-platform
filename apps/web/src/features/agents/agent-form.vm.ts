import {
  AgentInput,
  type ApprovalMode,
  type ThinkingLevel,
  entryNeedsVm,
  type ToolPreset,
  widensReach,
} from "@pap/contracts";
import type { MessageKey } from "../../i18n/index.ts";

export interface Draft {
  readonly name: string;
  readonly initials: string;
  readonly role: string;
  readonly model: { readonly provider: string; readonly modelId: string } | null;
  readonly thinking: ThinkingLevel | null;
  readonly mode: ApprovalMode;
  readonly preset: ToolPreset;
  readonly sandboxRequired: boolean;
  readonly network: boolean;
  /** False: the owner's own host list applies (`allowHosts: null`). */
  readonly ownHosts: boolean;
  readonly hosts: string;
  /** Owner a1: hosts the person controls, one per line. */
  readonly trustedSources: string;
  /** Owner a6: off by default. */
  readonly trustedAutonomy: boolean;
  readonly denylist: string;
  /** Empty text is "no budget" (owner m14). */
  readonly usd: string;
  readonly tokens: string;
  readonly acceptsDelegation: boolean;
  readonly memoryOn: boolean;
  readonly capture: "auto" | "off";
  readonly save: "direct" | "staged";
  readonly memoryHint: string;
  readonly recallLimit: string;
  readonly recallThreshold: string;
  /** VM resources as typed; whole numbers, judged by `AgentInput` (memory and disk in MiB). */
  readonly memoryMb: string;
  readonly cpus: string;
  readonly diskMb: string;
  /** The disk the saved profile has: the disk can only be enlarged (0 for a new agent). */
  readonly savedDiskMb: number;
  readonly systemPackages: readonly string[];
  /** null: every package of the Pi profile (decision 108 Q4). */
  readonly packages: readonly string[] | null;
}

export type FormErrors = Readonly<Partial<Record<string, MessageKey>>>;
export type Built =
  { readonly ok: true; readonly input: AgentInput } | { readonly ok: false; readonly errors: FormErrors };

const lines = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
/**
 * A trusted source as the contract wants it: the ASCII form of the host (`new URL` does the IDNA step). A line with a
 * scheme, path, port, `*`, userinfo or `%` is kept as typed, so the schema refuses it rather than this code guessing.
 * A name `new URL` turns into an address (`1.2.3`, `0x7f.1`) comes back as digits, which the schema refuses.
 */
const sourceOf = (line: string): string => {
  if (/[/:*@?#%\\\s]/.test(line)) return line;
  try {
    return new URL(`https://${line}`).hostname;
  } catch {
    return line;
  }
};
const numberOrNull = (text: string): number | null => (text.trim() === "" ? null : Number(text.trim()));
/** A memory number the person left empty is left out, so pi-mem0's own default stays in force. */
const optional = (key: string, text: string): Record<string, number> => {
  const value = numberOrNull(text);
  return value === null ? {} : { [key]: value };
};
const text = (value: number | null | undefined): string =>
  value === null || value === undefined ? "" : String(value);

/** The form's starting values: the saved profile, or the schema's own defaults for a new agent (no budget, owner m14). */
export function draftFromInput(input: AgentInput | null): Draft {
  const base = input ?? AgentInput.parse({ name: "x" });
  return {
    name: input?.name ?? "",
    initials: base.initials ?? "",
    role: base.role,
    model: base.model,
    thinking: base.thinking,
    mode: base.mode,
    preset: base.preset,
    sandboxRequired: base.sandbox.required,
    network: base.sandbox.network,
    ownHosts: base.allowHosts === null,
    hosts: (base.allowHosts ?? []).join("\n"),
    trustedSources: base.trustedSources.join("\n"),
    trustedAutonomy: base.trustedAutonomy,
    denylist: base.denylist.join("\n"),
    usd: text(base.budget.usdPerDay),
    tokens: text(base.budget.tokensPerDay),
    acceptsDelegation: base.acceptsDelegation,
    memoryOn: base.memory !== null,
    capture: base.memory?.capture ?? "auto",
    save: base.memory?.save ?? "direct",
    memoryHint: base.memory?.hint ?? "",
    recallLimit: text(base.memory?.recallLimit),
    recallThreshold: text(base.memory?.recallThreshold),
    memoryMb: String(base.resources.memoryMb),
    cpus: String(base.resources.cpus),
    diskMb: String(base.resources.diskMb),
    savedDiskMb: input === null ? 0 : input.resources.diskMb,
    systemPackages: base.systemPackages,
    packages: base.packages,
  };
}

/** Clears one half of the budget (owner m14): the field goes back to "No budget". */
export const clearBudget = (draft: Draft, which: "usd" | "tokens"): Draft => ({ ...draft, [which]: "" });

/** The field a schema issue belongs to: its path, two levels deep inside `budget`, `memory` and `resources`. */
const fieldOf = (path: ReadonlyArray<PropertyKey>): string =>
  path
    .slice(0, path[0] === "budget" || path[0] === "memory" || path[0] === "resources" ? 2 : 1)
    .map(String)
    .join(".");

const ERROR_KEYS: Readonly<Record<string, MessageKey>> = {
  name: "agentForm.error.name",
  initials: "agentForm.error.initials",
  role: "agentForm.error.role",
  "budget.usdPerDay": "agentForm.error.budget.usdPerDay",
  "budget.tokensPerDay": "agentForm.error.budget.tokensPerDay",
  allowHosts: "agentForm.error.allowHosts",
  trustedSources: "agentForm.error.trustedSources",
  denylist: "agentForm.error.denylist",
  "memory.hint": "agentForm.error.memory.hint",
  "memory.recallLimit": "agentForm.error.memory.recallLimit",
  "memory.recallThreshold": "agentForm.error.memory.recallThreshold",
  "resources.memoryMb": "agentVm.error.number",
  "resources.cpus": "agentVm.error.number",
  "resources.diskMb": "agentVm.error.number",
};

/**
 * The profile the draft describes, judged by `AgentInput` itself: no second copy of its rules lives here. `hostMode`: pap runs
 * agents on the host, which matches names only, so a host entry with a port or an IP is a field error (the daemon refuses it
 * with a bare `bad_request`).
 */
export function toInput(draft: Draft, hostMode = false): Built {
  const initials = draft.initials.trim().toUpperCase();
  const hint = draft.memoryHint.trim();
  const parsed = AgentInput.safeParse({
    name: draft.name.trim().replace(/^@/, ""),
    ...(initials === "" ? {} : { initials }),
    role: draft.role,
    model: draft.model,
    thinking: draft.thinking,
    mode: draft.mode,
    preset: draft.preset,
    sandbox: { required: draft.sandboxRequired, network: draft.network },
    allowHosts: draft.ownHosts ? null : lines(draft.hosts),
    trustedSources: lines(draft.trustedSources).map(sourceOf),
    trustedAutonomy: draft.trustedAutonomy,
    denylist: lines(draft.denylist),
    budget: { usdPerDay: numberOrNull(draft.usd), tokensPerDay: numberOrNull(draft.tokens) },
    acceptsDelegation: draft.acceptsDelegation,
    memory: draft.memoryOn
      ? {
          capture: draft.capture,
          save: draft.save,
          ...(hint === "" ? {} : { hint }),
          ...optional("recallLimit", draft.recallLimit),
          ...optional("recallThreshold", draft.recallThreshold),
        }
      : null,
    resources: {
      memoryMb: numberOrNull(draft.memoryMb),
      cpus: numberOrNull(draft.cpus),
      diskMb: numberOrNull(draft.diskMb),
    },
    systemPackages: draft.systemPackages,
    packages: draft.packages,
  });
  const vmOnly = hostMode && !draft.ownHosts && lines(draft.hosts).some(entryNeedsVm);
  if (parsed.success && parsed.data.resources.diskMb < draft.savedDiskMb) {
    return { ok: false, errors: { "resources.diskMb": "agentVm.error.diskShrink" } };
  }
  if (parsed.success && !vmOnly) return { ok: true, input: parsed.data };
  const errors: Partial<Record<string, MessageKey>> = {};
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = fieldOf(issue.path);
      errors[field] ??= ERROR_KEYS[field] ?? "agentForm.error.field";
    }
  }
  if (vmOnly) errors["allowHosts"] = "agentForm.error.allowHosts.vmOnly";
  return { ok: false, errors };
}

/** Whether saving will ask for the password (M11R94): the contract's own rule, so the form and the server agree. */
export const needsStepUp = (
  before: AgentInput | null,
  draft: Draft,
  ownerHosts?: readonly string[] | null,
): boolean => {
  const built = toInput(draft);
  return built.ok && widensReach(before, built.input, ownerHosts);
};

/** The two-letter avatar the daemon derives when the field stays empty, shown as the field's placeholder. */
export const derivedInitials = (name: string): string =>
  name
    .replace(/^@/, "")
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, 2)
    .toUpperCase();

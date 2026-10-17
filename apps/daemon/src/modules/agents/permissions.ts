import {
  type Caller,
  PapError,
  PLATFORM_OPS,
  type PermissionsView,
  type ToolPreset,
  type TriggerView,
} from "@pap/contracts";
import type { AgentLinks } from "./links.ts";
import type { AgentStore } from "./store.ts";

/** The coding tools each preset leaves active in the worker (pi-host `tool-presets.ts`); `configured` is Pi's own and reads as all. */
export const PRESET_TOOLS: Readonly<Record<Exclude<ToolPreset, "configured">, readonly string[]>> = {
  none: [],
  chat: [],
  "read-only": ["read", "grep", "find", "ls"],
  default: ["read", "bash", "edit", "write"],
  full: ["read", "bash", "edit", "write", "grep", "find", "ls"],
};
const ALL_CODING = PRESET_TOOLS.full;
const FILE_TOOLS = new Set(["read", "edit", "write", "grep", "find", "ls"]);
const SHELL_TOOLS = new Set(["bash", "powershell"]);
const URL_TOOL = /web|fetch|url|http|browse/i;
/** Pi's coding tools and pap's own platform tools: every other active tool may be an MCP server's or an extension's. */
const KNOWN_TOOLS: ReadonlySet<string> = new Set([
  ...ALL_CODING,
  "powershell",
  ...Object.values(PLATFORM_OPS).map((op) => op.tool),
]);

export interface PermissionsDeps {
  readonly store: Pick<AgentStore, "get">;
  readonly links: () => AgentLinks;
  /** The last sandbox probe says bwrap can run here. */
  sandboxUsable(): boolean;
  /** The owner's host list (null: no list, which is no host for a shell and any host for a URL tool) and the count of commands blocked for every agent of the owner. */
  ownerPolicy(ownerId: string): { readonly allowHosts: readonly string[] | null; readonly blocked: number };
  /** The tools a live thread's worker said are active; null when no worker is up. Never starts one. */
  liveTools(
    ownerId: string,
    sessionId: string,
  ): { readonly tools: readonly string[]; readonly truncated: boolean } | null;
  /** The hosts the owner allowed for the rest of the thread (daemon memory, W5-R35). */
  hostGrants(sessionId: string): readonly string[];
}

const sourceOf = (view: TriggerView): PermissionsView["triggers"][number]["source"] | null =>
  view.source?.type ?? null;
const targetOf = (view: TriggerView): "thread" | "isolated" =>
  view.agent?.target ?? view.execution?.agent?.target ?? "isolated";

/**
 * `agents.permissions` (M11R116): what the agent can do, from its profile, the sandbox probe and, when a thread is up, the
 * tools that thread loaded. The trifecta is advice only; a leg is set when it cannot be ruled out. Nothing here starts a
 * worker or connects a server. Pi keeps every active tool that is neither a coding tool nor a platform tool under every
 * preset but `chat` (MCP servers and extensions included), so without a live thread they are assumed present unless the
 * preset is `chat`. A live loadout settles it: any tool outside the coding and platform tools (and not a URL tool) may be
 * one, and a cut tool list may hide one.
 */
export function createPermissions(deps: PermissionsDeps) {
  return {
    view(caller: Caller, agentId: string): PermissionsView {
      // The sheet names vault entries: the owner's browser only.
      if (caller.kind !== "session") throw new PapError("forbidden");
      const ownerId = caller.userId;
      const record = deps.store.get(ownerId, agentId);
      if (!record?.input) throw new PapError("not_found");
      const { input } = record;
      const links = deps.links();
      const loadout =
        record.threadSessionId === null ? null : deps.liveTools(ownerId, record.threadSessionId);
      const live = loadout?.tools ?? null;
      const tools = live ?? (input.preset === "configured" ? ALL_CODING : PRESET_TOOLS[input.preset]);
      const effective = !input.sandbox.required ? "off" : deps.sandboxUsable() ? "on" : "unavailable";
      const owner = deps.ownerPolicy(ownerId);

      const triggers: PermissionsView["triggers"] = [];
      for (const view of links.automation?.statusOf?.(caller, agentId).triggers ?? []) {
        const source = sourceOf(view);
        if (source !== null) triggers.push({ name: view.name, source, target: targetOf(view) });
      }
      // A vault that cannot be read lists nothing (`state: "unreadable"`); the secrets page says why.
      const vaultNames = links.vault?.list?.(caller, agentId).entries.map((entry) => entry.name) ?? [];

      const hasFileTool = tools.some((name) => FILE_TOOLS.has(name));
      const hasShell = tools.some((name) => SHELL_TOOLS.has(name));
      const hasUrlTool = live !== null && live.some((name) => URL_TOOL.test(name));
      const hasMcp =
        loadout !== null
          ? loadout.truncated ||
            loadout.tools.some(
              (name) => name.startsWith("mcp__") || (!KNOWN_TOOLS.has(name) && !URL_TOOL.test(name)),
            )
          : input.preset !== "chat";
      const hostList = input.allowHosts !== null || owner.allowHosts !== null;
      const own = input.allowHosts ?? owner.allowHosts;
      // What the egress proxy lets a networked shell reach: the host list (none when there is none, W5-R64 I2), the trusted
      // sources and the hosts granted in the thread.
      const grants = record.threadSessionId === null ? [] : deps.hostGrants(record.threadSessionId);
      const reachesAHost = (own?.length ?? 0) > 0 || input.trustedSources.length > 0 || grants.length > 0;
      const networked = input.sandbox.required && input.sandbox.network && effective === "on";

      return {
        tools: { preset: input.preset, active: live === null ? "unknown-until-start" : [...live] },
        sandbox: { required: input.sandbox.required, effective, network: input.sandbox.network },
        hosts: input.allowHosts ?? (owner.allowHosts === null ? "any" : "owner's list"),
        blocked: owner.blocked + input.denylist.length,
        vaultNames,
        triggers,
        mcp: "owner's servers",
        trustedSources: [...input.trustedSources],
        trustedAutonomy: input.trustedAutonomy,
        egress: networked ? "proxied" : "off",
        trifecta: {
          privateData: hasFileTool && effective !== "on",
          untrustedContent:
            hasUrlTool ||
            hasMcp ||
            triggers.some((each) => each.source === "webhook" || each.source === "feed"),
          exfiltration:
            (hasShell && (effective !== "on" || (networked && reachesAHost))) ||
            (hasUrlTool && !hostList) ||
            hasMcp,
        },
      };
    },
  };
}
export type Permissions = ReturnType<typeof createPermissions>;

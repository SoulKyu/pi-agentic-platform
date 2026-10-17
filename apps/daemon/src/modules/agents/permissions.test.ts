import { PermissionsView, type TriggerView } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentLinks } from "./links.ts";
import { createPermissions, PRESET_TOOLS } from "./permissions.ts";
import { agentInput, type AgentsBed, createAgentsBed } from "./testing/bed.ts";
import { bedHelpers } from "./testing/helpers.ts";
import { testCaller } from "../../testing/caller.ts";

let bed: AgentsBed;
const beds: AgentsBed[] = [];
afterEach(() => beds.splice(0).forEach((each) => each.dispose()));
const { refusalOf } = bedHelpers(() => bed);

const trigger = (name: string, type: string, target: "thread" | "isolated"): TriggerView =>
  ({
    name,
    source: { type },
    execution: { agent: { agentId: "x-0000", target } },
    agent: { agentId: "x-0000", target },
  }) as unknown as TriggerView;

interface World {
  input?: object;
  usable?: boolean;
  ownerHosts?: readonly string[] | null;
  triggers?: TriggerView[];
  live?: readonly string[] | null;
  /** The live loadout cut its tool list at 256. */
  truncated?: boolean;
  grants?: readonly string[];
  vault?: string[];
}

async function sheet(world: World = {}) {
  bed = createAgentsBed();
  beds.push(bed);
  const { id } = await bed.agents.create(bed.owner(), agentInput(world.input));
  if (world.live) bed.db.run("UPDATE agents SET thread_session_id = 's1'");
  const links: AgentLinks = {
    automation: {
      busy: () => false,
      deleteTriggersOf: () => undefined,
      cancelQueuedOf: () => undefined,
      statusOf: () => ({ tasks: [], triggers: world.triggers ?? [] }),
    },
    vault: {
      drop: () => undefined,
      list: () => ({
        entries: (world.vault ?? []).map((name) => ({ name, updatedAt: 1 })),
        state: "ok" as const,
      }),
    },
  };
  bed.agents.setLinks(links);
  const permissions = createPermissions({
    store: bed.agents.store,
    links: bed.agents.links,
    sandboxUsable: () => world.usable ?? true,
    ownerPolicy: () => ({ allowHosts: world.ownerHosts === undefined ? [] : world.ownerHosts, blocked: 4 }),
    liveTools: (_ownerId, sessionId) =>
      sessionId === "s1" && world.live ? { tools: world.live, truncated: world.truncated ?? false } : null,
    hostGrants: () => world.grants ?? [],
  });
  return { id, view: () => permissions.view(bed.owner(), id), permissions };
}

describe("agents.permissions (M11R116)", () => {
  it("answers the contract's shape for a default agent, with no folder list", async () => {
    const { view } = await sheet({ vault: ["API_TOKEN"] });
    const answer = view();
    expect(PermissionsView.parse(answer)).toEqual(answer);
    expect(answer).toMatchObject({
      tools: { preset: "default", active: "unknown-until-start" },
      sandbox: { required: true, effective: "on", network: false },
      hosts: "owner's list",
      blocked: 4,
      vaultNames: ["API_TOKEN"],
      mcp: "owner's servers",
      trustedSources: [],
      trustedAutonomy: false,
      egress: "off",
    });
    expect(Object.keys(answer)).not.toContain("folders");
    expect(JSON.stringify(answer)).not.toMatch(/value/i);
  });

  it("counts the agent's own blocked commands on top of the owner's", async () => {
    const { view } = await sheet({ input: { denylist: ["rm -rf *", "curl *"] } });
    expect(view().blocked).toBe(6);
  });

  it("reads the active tools from a live thread's loadout only", async () => {
    expect((await sheet({ live: ["read", "bash"] })).view().tools.active).toEqual(["read", "bash"]);
    expect((await sheet({ live: null })).view().tools.active).toBe("unknown-until-start");
    // A thread that is not up (no loadout) is unknown, never guessed from the preset.
    expect((await sheet({})).view().tools.active).toBe("unknown-until-start");
  });

  it("names the hosts: the agent's list, the owner's list, or any host", async () => {
    expect((await sheet({ input: { allowHosts: ["api.example.com"] } })).view().hosts).toEqual([
      "api.example.com",
    ]);
    expect((await sheet({ ownerHosts: ["a.example.com"] })).view().hosts).toBe("owner's list");
    expect((await sheet({ ownerHosts: null })).view().hosts).toBe("any");
  });

  it("the sandbox is effectively on, off, or unavailable on this machine", async () => {
    expect((await sheet({ usable: true })).view().sandbox.effective).toBe("on");
    expect((await sheet({ usable: false })).view().sandbox.effective).toBe("unavailable");
    expect((await sheet({ input: { sandbox: { required: false } } })).view().sandbox.effective).toBe("off");
  });

  it("egress is proxied only when the sandbox is effectively on and its network is on", async () => {
    const on = { sandbox: { required: true, network: true } };
    expect((await sheet({ input: on })).view().egress).toBe("proxied");
    expect((await sheet({ input: on, usable: false })).view().egress).toBe("off");
    expect((await sheet({ input: { sandbox: { required: false, network: true } } })).view().egress).toBe(
      "off",
    );
    expect((await sheet({ input: { sandbox: { required: true, network: false } } })).view().egress).toBe(
      "off",
    );
  });

  it("carries the trusted sources and the autonomy switch", async () => {
    const { view } = await sheet({ input: { trustedSources: ["docs.example.com"], trustedAutonomy: true } });
    expect(view()).toMatchObject({ trustedSources: ["docs.example.com"], trustedAutonomy: true });
  });

  it("lists the triggers by name, source and where they run", async () => {
    const { view } = await sheet({
      triggers: [trigger("Nightly", "schedule", "isolated"), trigger("Deploy hook", "webhook", "thread")],
    });
    expect(view().triggers).toEqual([
      { name: "Nightly", source: "schedule", target: "isolated" },
      { name: "Deploy hook", source: "webhook", target: "thread" },
    ]);
  });

  describe("the trifecta", () => {
    const legs = async (world: World) => (await sheet(world)).view().trifecta;

    it("private data: a file tool without the sandbox", async () => {
      const off = { sandbox: { required: false } };
      expect((await legs({ input: { ...off, preset: "read-only" } })).privateData).toBe(true);
      expect((await legs({ input: { preset: "read-only" } })).privateData).toBe(false);
      expect((await legs({ input: { ...off, preset: "chat" } })).privateData).toBe(false);
      expect((await legs({ input: { ...off, preset: "none" } })).privateData).toBe(false);
      expect(
        (await legs({ input: { sandbox: { required: true }, preset: "default" }, usable: false }))
          .privateData,
      ).toBe(true);
    });

    it("private data follows a live thread's tools over the preset", async () => {
      const off = { sandbox: { required: false }, preset: "read-only" };
      expect((await legs({ input: off, live: ["web_fetch"] })).privateData).toBe(false);
      expect((await legs({ input: off, live: ["edit"] })).privateData).toBe(true);
    });

    it("untrusted content: a webhook or a feed trigger, a URL tool, an MCP server", async () => {
      expect(
        (await legs({ triggers: [trigger("h", "webhook", "thread")], input: { preset: "chat" } }))
          .untrustedContent,
      ).toBe(true);
      expect(
        (await legs({ triggers: [trigger("f", "feed", "isolated")], input: { preset: "chat" } }))
          .untrustedContent,
      ).toBe(true);
      expect(
        (await legs({ triggers: [trigger("s", "schedule", "isolated")], input: { preset: "chat" } }))
          .untrustedContent,
      ).toBe(false);
      expect((await legs({ input: { preset: "none" }, live: ["web_fetch"] })).untrustedContent).toBe(true);
      expect((await legs({ input: { preset: "chat" } })).untrustedContent).toBe(false);
      // The owner's MCP servers and extensions stay active under every preset but chat (pi-host keeps non-coding tools).
      expect((await legs({ input: { preset: "default" } })).untrustedContent).toBe(true);
      expect((await legs({ input: { preset: "none" } })).untrustedContent).toBe(true);
    });

    it("MCP and extensions: unknown without a live thread, read from the loadout with one (I1)", async () => {
      const mcpLeg = async (world: World) => {
        const trifecta = await legs(world);
        return [trifecta.untrustedContent, trifecta.exfiltration];
      };
      expect(await mcpLeg({ input: { preset: "none" } })).toEqual([true, true]);
      expect(await mcpLeg({ input: { preset: "read-only" } })).toEqual([true, true]);
      expect(await mcpLeg({ input: { preset: "chat" } })).toEqual([false, false]);
      // Only coding tools and pap's platform tools: no MCP.
      expect(
        await mcpLeg({
          input: { preset: "none" },
          live: ["read", "bash", "agent_notify", "network_request"],
        }),
      ).toEqual([false, false]);
      // An MCP tool with a URL-like name is still an MCP server: the host list does not make it safe.
      expect(
        (
          await legs({
            input: { preset: "none" },
            live: ["mcp__playwright__browser_click"],
            ownerHosts: ["a.example.com"],
          })
        ).exfiltration,
      ).toBe(true);
      // A server behind a proxy tool is not named mcp: any other tool counts as possible MCP or extension.
      expect(await mcpLeg({ input: { preset: "none" }, live: ["read", "codemode"] })).toEqual([true, true]);
      expect(await mcpLeg({ input: { preset: "none" }, live: ["tool_search"] })).toEqual([true, true]);
      expect(await mcpLeg({ input: { preset: "none" }, live: ["mcp__github__create_issue"] })).toEqual([
        true,
        true,
      ]);
      // A cut tool list may hide any of them.
      expect(await mcpLeg({ input: { preset: "none" }, live: ["read"], truncated: true })).toEqual([
        true,
        true,
      ]);
    });

    it("exfiltration: a shell with the sandbox off, or with network and a host it may reach", async () => {
      const shell = { preset: "default" };
      expect((await legs({ input: { ...shell, sandbox: { required: false } } })).exfiltration).toBe(true);
      // Sandbox on, network on, the owner's list is empty and the agent has no other host: nothing to reach.
      const net = { ...shell, sandbox: { required: true, network: true } };
      expect((await legs({ input: { ...net, preset: "chat" } })).exfiltration).toBe(false);
      expect((await legs({ input: { ...net, preset: "none" }, live: ["bash"] })).exfiltration).toBe(false);
      expect(
        (await legs({ input: { ...net, preset: "none" }, live: ["bash"], ownerHosts: ["a.example.com"] }))
          .exfiltration,
      ).toBe(true);
      expect(
        (
          await legs({
            input: { ...net, preset: "none", allowHosts: [], trustedSources: ["docs.example.com"] },
            live: ["bash"],
          })
        ).exfiltration,
      ).toBe(true);
      expect(
        (
          await legs({
            input: { ...net, preset: "none", allowHosts: [] },
            live: ["bash"],
            grants: ["x.example.com"],
          })
        ).exfiltration,
      ).toBe(true);
      expect(
        (await legs({ input: { ...net, preset: "none", allowHosts: [] }, live: ["bash"], ownerHosts: null }))
          .exfiltration,
      ).toBe(false);
    });

    it("exfiltration: no list at all is no host for the shell, as the proxy reads it (W5-R64 I2)", async () => {
      const net = { sandbox: { required: true, network: true }, preset: "none" };
      expect(
        (await legs({ input: { ...net, allowHosts: null }, live: ["bash"], ownerHosts: null })).exfiltration,
      ).toBe(false);
    });

    it("exfiltration: a URL tool without a host list, and any MCP server", async () => {
      expect(
        (await legs({ input: { preset: "none", allowHosts: null }, live: ["web_fetch"], ownerHosts: null }))
          .exfiltration,
      ).toBe(true);
      expect(
        (await legs({ input: { preset: "none", allowHosts: [] }, live: ["web_fetch"] })).exfiltration,
      ).toBe(false);
      expect(
        (await legs({ input: { preset: "none", allowHosts: ["a.example.com"] }, live: ["web_fetch"] }))
          .exfiltration,
      ).toBe(false);
      expect((await legs({ input: { preset: "default" } })).exfiltration).toBe(true);
      expect((await legs({ input: { preset: "none" } })).exfiltration).toBe(true);
      expect((await legs({ input: { preset: "chat" } })).exfiltration).toBe(false);
    });

    it("is advice only: the sheet reads, it never changes the agent", async () => {
      const { id, view } = await sheet({ input: { sandbox: { required: false }, preset: "full" } });
      const before = bed.agents.port.get("u1", id);
      expect(view().trifecta).toEqual({ privateData: true, untrustedContent: true, exfiltration: true });
      expect(bed.agents.port.get("u1", id)).toEqual(before);
    });
  });

  it("is browser only: a token is forbidden", async () => {
    const { permissions, id } = await sheet();
    expect(await refusalOf(() => permissions.view(testCaller({ kind: "token" }), id))).toBe("forbidden");
  });

  it("is not_found for another owner's agent", async () => {
    const { permissions, id } = await sheet();
    expect(await refusalOf(() => permissions.view(testCaller({ userId: "u2" }), id))).toBe("not_found");
  });

  it("an agent whose profile does not parse is not_found for the sheet (nothing to claim)", async () => {
    bed = createAgentsBed();
    beds.push(bed);
    bed.db.run(
      `INSERT INTO agents (id, owner_id, name, name_key, profile, created_at, updated_at)
       VALUES ('bad-0001', 'u1', 'Bad', 'bad', '{}', 1, 1)`,
    );
    const permissions = createPermissions({
      store: bed.agents.store,
      links: bed.agents.links,
      sandboxUsable: () => true,
      ownerPolicy: () => ({ allowHosts: null, blocked: 0 }),
      liveTools: () => null,
      hostGrants: () => [],
    });
    expect(await refusalOf(() => permissions.view(bed.owner(), "bad-0001"))).toBe("not_found");
  });

  it("the preset table names the coding tools the way the worker does", () => {
    expect(PRESET_TOOLS["read-only"]).toEqual(["read", "grep", "find", "ls"]);
    expect(PRESET_TOOLS.default).toEqual(["read", "bash", "edit", "write"]);
    expect(PRESET_TOOLS.none).toEqual([]);
  });
});

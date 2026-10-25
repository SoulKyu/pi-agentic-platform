import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MethodName, ProjectView } from "@pap/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { writeScript } from "./security/testing/agent-bed.ts";
import { markOf, waitIdle } from "./security/testing/fixtures.ts";
import { FakeChild } from "./modules/agent-vm/testing/relay-link-bed.ts";
import type { RelayChild } from "./modules/agent-vm/index.ts";
import { addMember, type Person, startTwoUsers, type TwoUsers } from "./testing/two-users.ts";

// M14 J1, the Claude token and the project layer: each user's token is their own and rides in their boxes' relay policy only;
// the packages a project's `.pi/project.yaml` asks for are built into that project's layer alone.

const OWNER_TOKEN = "sk-ant-oat01-OWNER-0123456789-journey";
const MEMBER_TOKEN = "sk-ant-oat01-MEMBER-0123456789-journey";
const PROJECT_YAML = ".pi/project.yaml";

const PROVIDER = { baseUrl: "http://127.0.0.1:9", apiKey: "literal-key", api: "openai-completions" };
const child = new FakeChild();
let u: TwoUsers;
beforeAll(async () => {
  u = await startTwoUsers(undefined, {
    seams: { relay: { fork: () => child as unknown as RelayChild } },
    config: { agentsMemoryMaxMb: 65_536, maxWorkers: 32 },
    agentFiles: {
      "settings.json": JSON.stringify({ packages: ["npm:pi-claude-bridge@1.0.0"] }),
      // The bridge's provider and another one, both with a literal key (so Pi lists them): the bridge is exempt from sharing.
      "models.json": JSON.stringify({
        providers: {
          "claude-bridge": { ...PROVIDER, models: [{ id: "claude-sonnet" }] },
          acme: { ...PROVIDER, models: [{ id: "m-1" }] },
        },
      }),
    },
  });
  child.ready();
}, 180_000);
afterAll(async () => u?.stop());

const ask = async <T>(who: Person, method: string, params: object): Promise<T> => {
  const frame = await who.call(method as MethodName, params as never);
  if (!frame.ok) throw new Error(`${method}: ${frame.error.code}`);
  return frame.result as T;
};
interface Policy {
  box: { kind: string; id: string };
  claude: boolean;
  claudeToken: string | null;
  blocked: string | null;
}
/** The newest `box_policy` the relay was sent for a box. */
const policyOf = (boxId: string): Policy | undefined =>
  (child.sent as Array<{ type: string } & Partial<Policy>>)
    .filter((message) => message.type === "box_policy" && message.box?.id === boxId)
    .at(-1) as Policy | undefined;

describe("the relay and the Claude token", () => {
  it("each box's policy carries its own owner's token, or none; another user's token never reaches it", async () => {
    const { project: mine } = await ask<{ project: ProjectView }>(u.member, "projects.create", {
      name: "Garden",
    });
    await ask(u.member, "projects.startBox", { projectId: mine.id });
    const lone = await addMember(u.bed, "ned");
    const { project: nones } = await ask<{ project: ProjectView }>(lone, "projects.create", { name: "Shed" });
    await ask(lone, "projects.startBox", { projectId: nones.id });
    const ownerBox = u.seeds.project.id;

    await ask(u.owner, "agents.vm.setClaudeToken", { token: OWNER_TOKEN });
    await ask(u.member, "agents.vm.setClaudeToken", { token: MEMBER_TOKEN });
    await vi.waitFor(() => {
      expect(policyOf(ownerBox)).toMatchObject({ claude: true, claudeToken: OWNER_TOKEN });
      expect(policyOf(mine.id)).toMatchObject({ claude: true, claudeToken: MEMBER_TOKEN });
    });
    // A user with no token gets the relay's own no_claude_token refusal: the policy holds none, never another user's.
    expect(policyOf(nones.id)).toMatchObject({ claude: false, claudeToken: null });

    // Each user reads their own status only.
    expect((await ask<{ claudeToken: string }>(u.member, "agents.vmStatus", {})).claudeToken).toBe("set");
    expect((await ask<{ claudeToken: string }>(lone, "agents.vmStatus", {})).claudeToken).toBe("missing");

    // The member clears theirs: only their box loses it.
    await ask(u.member, "agents.vm.clearClaudeToken", {});
    await vi.waitFor(() => expect(policyOf(mine.id)).toMatchObject({ claude: false, claudeToken: null }));
    expect(policyOf(ownerBox)).toMatchObject({ claude: true, claudeToken: OWNER_TOKEN });

    // No token is ever in a box the owner of the token does not own, in any message the relay got.
    const sent = child.sent as Array<{ type: string; box?: { id: string }; claudeToken?: string | null }>;
    for (const message of sent) {
      if (message.claudeToken === OWNER_TOKEN) expect(message.box?.id).toBe(ownerBox);
      if (message.claudeToken === MEMBER_TOKEN) expect(message.box?.id).toBe(mine.id);
    }
    expect(sent.some((message) => message.type === "claude_token")).toBe(false);
    expect(JSON.stringify([u.member.answers, lone.answers])).not.toContain(OWNER_TOKEN);
  }, 120_000);

  it("a member's box lists the Claude bridge while their token is set, and the agents' packages list through agents.packages", async () => {
    const { project } = await ask<{ project: ProjectView }>(u.member, "projects.create", { name: "Bridge" });
    await ask(u.member, "projects.startBox", { projectId: project.id });
    await vi.waitFor(() => expect(policyOf(project.id)).toMatchObject({ claude: false, claudeToken: null }));
    await ask(u.member, "agents.vm.setClaudeToken", { token: MEMBER_TOKEN });
    await vi.waitFor(() =>
      expect(policyOf(project.id)).toMatchObject({ claude: true, claudeToken: MEMBER_TOKEN }),
    );
    // The picker lists the bridge's models for the member, with their token set, and still drops the unshared provider.
    const pickerOf = async (who: Person) =>
      (await ask<{ models: Array<{ provider: string }> }>(who, "sessions.availableModels", {})).models.map(
        (model) => model.provider,
      );
    expect(await pickerOf(u.member)).toEqual(expect.arrayContaining(["claude-bridge", "acme"]));
    await ask(u.owner, "users.setProviderShared", { provider: "acme", shared: false });
    expect(await pickerOf(u.member)).toEqual(["claude-bridge"]);
    expect(await pickerOf(u.owner)).toEqual(expect.arrayContaining(["claude-bridge", "acme"]));
    // Cleared, the bridge is still the member's to pick (it has no stored auth; their token gates its use), but the relay
    // is told there is none: this project box's policy is `claude: false`, `claudeToken: null`, and the relay answers
    // such a box's claude request with a refusal (`model`: the bridge is off) before it could ever forward the owner's token.
    await ask(u.member, "agents.vm.clearClaudeToken", {});
    await vi.waitFor(() => expect(policyOf(project.id)).toMatchObject({ claude: false, claudeToken: null }));
    expect(await pickerOf(u.member)).toEqual(["claude-bridge"]);
    // `agents.packages` is shared: the member sees the one Pi folder's packages (ids and masked sources), no more.
    const owner = await ask<{ packages: Array<{ id: string; source: string }> }>(
      u.owner,
      "agents.packages",
      {},
    );
    const member = await ask<{ packages: Array<{ id: string; source: string }> }>(
      u.member,
      "agents.packages",
      {},
    );
    expect(member.packages).toEqual(owner.packages);
    expect(member.packages.map((entry) => entry.source).join()).toContain("pi-claude-bridge");
  }, 120_000);
});

describe("a member's project.yaml packages", () => {
  it("are built into their project's layer only, and the owner's layer is the owner's", async () => {
    const { project: mine } = await ask<{ project: ProjectView }>(u.member, "projects.create", {
      name: "Layers",
    });
    await ask(u.member, "projects.startBox", { projectId: mine.id });
    // The folder `.pi` does not exist in a new project: a session's write tool makes it, as it does for anyone.
    const write = async (who: Person, root: string, packages: string) => {
      writeScript(u.bed.t, {
        steps: [
          {
            toolCalls: [
              {
                name: "write",
                args: { path: `${root}/${PROJECT_YAML}`, content: `packages: [${packages}]\n` },
                id: "w1",
              },
            ],
          },
          { text: "done" },
        ],
      });
      const { sessionId } = await ask<{ sessionId: string }>(who, "sessions.create", { cwd: root });
      await ask(who, "subscribe.session", { sessionId });
      const mark = markOf(who.client);
      await ask(who, "sessions.prompt", { sessionId, text: "write the project config" });
      await waitIdle(who.client, mark);
    };
    await write(u.member, mine.root, "ripgrep");
    await write(u.owner, u.seeds.project.root, "jq");
    await ask(u.member, "projects.restartBox", { projectId: mine.id });
    await ask(u.owner, "projects.restartBox", { projectId: u.seeds.project.id });
    await ask(u.member, "projects.rebuild", { projectId: mine.id });
    const saved = () =>
      (
        JSON.parse(readFileSync(join(u.bed.t.home, "vm", "project-images.json"), "utf8")) as {
          projects: Record<string, { built: string[]; wanted: string[] | null }>;
        }
      ).projects;
    await vi.waitFor(() => expect(saved()[mine.id]?.built).toEqual(["ripgrep"]));
    // The owner's project has been asked for jq, built nothing yet, and the member's rebuild touched no one else's layer.
    expect(saved()[u.seeds.project.id]?.built ?? []).toEqual([]);
    expect(saved()[u.seeds.project.id]?.wanted ?? ["jq"]).toEqual(["jq"]);
    expect(Object.values(saved()).flatMap((layer) => layer.built)).toEqual(["ripgrep"]);
    // And the member cannot rebuild the owner's project to get theirs into it.
    const foreign = await u.member.call("projects.rebuild", { projectId: u.seeds.project.id });
    expect(foreign.ok ? "ok" : foreign.error.code).toBe("not_found");
  }, 120_000);
});

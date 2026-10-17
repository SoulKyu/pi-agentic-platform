import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { TOKEN_PERMISSIONS } from "@pap/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openOwner, outcome, type Owner, result } from "../../security/testing/automation-bed.ts";
import { startTestDaemon, type TestDaemon } from "../../testing/harness.ts";
import type { TestClient } from "../../testing/ws-client.ts";

let t: TestDaemon;
let owner: Owner;
let bot: TestClient;

beforeAll(async () => {
  t = await startTestDaemon({ steps: [{ text: "ok" }] });
  owner = await openOwner(t);
  const minted = await owner.client.call("auth.tokens.create", {
    name: "ci",
    permissions: [...TOKEN_PERMISSIONS] as never,
    expiresInDays: 7,
  });
  bot = await t.connectBearer(result<{ value: string }>(minted).value);
});
afterAll(async () => {
  bot.close();
  owner.client.close();
  await t.stop();
});

describe("the agents registry through the socket", () => {
  it("a browser creates an agent: the home exists with its one commit, and it is listed", async () => {
    const created = result<{ id: string; name: string; revision: number }>(
      await owner.client.call("agents.create", { input: { name: "Atlas", role: "Help." } as never }),
    );
    expect(created).toMatchObject({ name: "Atlas", revision: 1 });
    const home = join(t.home, "agents", created.id);
    expect(statSync(home).mode & 0o777).toBe(0o700);
    const log = execFileSync("git", ["-C", home, "log", "--oneline"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: t.root, XDG_CONFIG_HOME: t.root, GIT_CONFIG_NOSYSTEM: "1" },
    })
      .trim()
      .split("\n");
    expect(log).toHaveLength(1);
    expect(log[0]).toContain("chore: init Atlas home");
    const listed = result<{ agents: Array<{ id: string }> }>(await owner.client.call("agents.list", {}));
    expect(listed.agents.map((agent) => agent.id)).toEqual([created.id]);
    // A token reads it, never writes it.
    expect(result<{ id: string }>(await bot.call("agents.get", { agentId: created.id })).id).toBe(created.id);
  });

  it("a token is forbidden to create, update and delete, and nothing changes", async () => {
    const before = result<{ agents: Array<{ id: string; revision: number }> }>(
      await owner.client.call("agents.list", {}),
    );
    const id = before.agents[0]?.id ?? "";
    expect(outcome(await bot.call("agents.create", { input: { name: "Evil" } as never }))).toBe("forbidden");
    expect(
      outcome(
        await bot.call("agents.update", { agentId: id, baseRevision: 1, input: { name: "Evil" } as never }),
      ),
    ).toBe("forbidden");
    expect(outcome(await bot.call("agents.delete", { agentId: id }))).toBe("forbidden");
    expect(result(await owner.client.call("agents.list", {}))).toEqual(before);
    expect(existsSync(join(t.home, "agents", id))).toBe(true);
  });

  it("the confirmed owner widens an agent, then deletes it: the home goes to the trash", async () => {
    const id =
      result<{ agents: Array<{ id: string }> }>(await owner.client.call("agents.list", {})).agents[0]?.id ??
      "";
    const widened = result<{ revision: number; input: { mode: string } }>(
      await owner.client.call("agents.update", {
        agentId: id,
        baseRevision: 1,
        input: { name: "Atlas", mode: "full-access" } as never,
      }),
    );
    expect(widened).toMatchObject({ revision: 2, input: { mode: "full-access" } });
    const deleted = result<{ trashedAs: string }>(await owner.client.call("agents.delete", { agentId: id }));
    expect(deleted.trashedAs.startsWith(`${id}-`)).toBe(true);
    expect(existsSync(join(t.home, "agents", id))).toBe(false);
    expect(existsSync(join(t.home, "agents", ".trash", deleted.trashedAs, "MEMORY.md"))).toBe(true);
    expect(result(await owner.client.call("agents.list", {}))).toEqual({ agents: [], truncated: false });
    expect(outcome(await owner.client.call("agents.get", { agentId: id }))).toBe("not_found");
  });
});

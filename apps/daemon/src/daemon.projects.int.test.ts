import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "./kernel/db/database.ts";
import { startTestDaemon, type TestDaemon } from "./testing/harness.ts";
import type { TestClient } from "./testing/ws-client.ts";

let t: TestDaemon;
beforeEach(async () => {
  t = await startTestDaemon({ steps: [{ text: "ok" }] });
});
afterEach(async () => {
  await t.stop();
});

type Added = { project: { id: string; root: string; name: string } };
const ok = <T>(frame: { ok: boolean; result?: unknown }): T => {
  if (!frame.ok) throw new Error(`call failed: ${JSON.stringify(frame)}`);
  return frame.result as T;
};
async function mint(cookie: string, owner: TestClient, permissions: string[]): Promise<TestClient> {
  await t.confirmStepUp(cookie);
  const created = await owner.call("auth.tokens.create", {
    name: "ci",
    permissions: permissions as never,
    expiresInDays: 7,
  });
  return t.connectBearer(ok<{ value: string }>(created).value);
}

describe("projects over /ws", () => {
  it("refuses an unknown project and an empty name", async () => {
    const client = await t.connect(await t.login());
    expect(
      await client.call("projects.update", {
        projectId: "nope",
        change: { kind: "move", before: null },
      } as never),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(
      await client.call("projects.update", {
        projectId: "nope",
        change: { kind: "rename", name: "" },
      } as never),
    ).toMatchObject({ ok: false, error: { code: "bad_request" } });
  });
});

describe("projects.add over /ws (decision 85)", () => {
  it("files a folder under its git root, answers the same project again, and never another owner's", async () => {
    const owner = await t.connect(await t.login());
    const repo = join(t.root, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, "src"));
    const db = openDatabase(join(t.home, "state.db"));
    db.run(
      "INSERT INTO projects (id, owner_id, root, name, position, created_at) VALUES ('ghost-p', 'ghost-owner', $root, 'ghost', 0, 0)",
      { root: repo },
    );
    db.close();
    const first = ok<Added>(await owner.call("projects.add", { root: join(repo, "src") }));
    expect(first.project).toMatchObject({ root: repo, name: "repo" });
    expect(first.project.id).not.toBe("ghost-p");
    expect(ok<Added>(await owner.call("projects.add", { root: `${repo}/` })).project.id).toBe(
      first.project.id,
    );
  });

  it("refuses pap's home, Pi's agent folder and a link into them; a missing folder is invalid_cwd", async () => {
    const owner = await t.connect(await t.login());
    const link = join(t.root, "work", "to-home");
    symlinkSync(t.home, link);
    for (const root of [t.home, join(t.root, "agent"), link])
      expect(await owner.call("projects.add", { root }), root).toMatchObject({
        ok: false,
        error: { code: "bad_request" },
      });
    expect(await owner.call("projects.add", { root: join(t.root, "missing") })).toMatchObject({
      ok: false,
      error: { code: "invalid_cwd" },
    });
  });

  it("lets a token add a project exactly when it may create a session, and the project is its owner's", async () => {
    const cookie = await t.login();
    const owner = await t.connect(cookie);
    const reader = await mint(cookie, owner, ["sessions:read"]);
    expect(await reader.call("projects.add", { root: t.cwd })).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
    expect(await reader.call("sessions.create", { cwd: t.cwd })).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
    const operator = await mint(cookie, owner, ["sessions:read", "sessions:operate"]);
    const added = ok<Added>(await operator.call("projects.add", { root: t.cwd }));
    expect(await operator.call("sessions.create", { cwd: t.cwd })).toMatchObject({ ok: true });
    expect(ok<Added>(await owner.call("projects.add", { root: t.cwd })).project.id).toBe(added.project.id);
  });
});

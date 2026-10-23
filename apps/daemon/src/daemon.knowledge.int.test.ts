import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { markOf, waitIdle } from "./security/testing/fixtures.ts";
import { startTestDaemon, type TestDaemon } from "./testing/harness.ts";
import type { TestClient } from "./testing/ws-client.ts";

let t: TestDaemon;
beforeEach(async () => {
  t = await startTestDaemon({ steps: [{ text: "ok" }] });
});
let scratch: string | undefined;
afterEach(async () => {
  await t.stop();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

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
async function project(owner: TestClient, root: string): Promise<string> {
  return ok<{ project: { id: string } }>(await owner.call("projects.add", { root })).project.id;
}

describe("project knowledge over /ws", () => {
  it("enables OKF, reads it back, and audits it once", async () => {
    const cookie = await t.login();
    const owner = await t.connect(cookie);
    const projectId = await project(owner, t.cwd);
    expect(ok(await owner.call("projects.knowledge", { projectId }))).toEqual({
      enabled: false,
      concepts: 0,
    });
    expect(ok(await owner.call("projects.enableKnowledge", { projectId }))).toEqual({ enabled: true });
    expect(ok(await owner.call("projects.knowledge", { projectId }))).toEqual({ enabled: true, concepts: 0 });
    writeFileSync(join(t.cwd, "knowledge", "build.md"), "---\ntype: procedure\n---\n");
    expect(ok(await owner.call("projects.knowledge", { projectId }))).toEqual({ enabled: true, concepts: 1 });
    const audit = ok<{ entries: Array<{ reason: string | null; detail: unknown }> }>(
      await owner.call("audit.list", {}),
    ).entries.filter((row) => row.reason === "knowledge_enabled");
    expect(audit).toHaveLength(1);
    expect(audit[0]?.detail).toEqual({ projectId });
  });

  it("refuses a token without files:operate and lets files:read read", async () => {
    const cookie = await t.login();
    const owner = await t.connect(cookie);
    const projectId = await project(owner, t.cwd);
    const reader = await mint(cookie, owner, ["files:read"]);
    expect(await reader.call("projects.enableKnowledge", { projectId })).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
    expect(existsSync(join(t.cwd, "knowledge"))).toBe(false);
    expect(ok(await reader.call("projects.knowledge", { projectId }))).toEqual({
      enabled: false,
      concepts: 0,
    });
  });

  it("refuses a knowledge link with conflict and writes nothing; an unknown project is not_found", async () => {
    const owner = await t.connect(await t.login());
    const projectId = await project(owner, t.cwd);
    mkdirSync(join(t.root, "elsewhere"));
    symlinkSync(join(t.root, "elsewhere"), join(t.cwd, "knowledge"));
    expect(await owner.call("projects.enableKnowledge", { projectId })).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    expect(existsSync(join(t.root, "elsewhere", "index.md"))).toBe(false);
    expect(await owner.call("projects.knowledge", { projectId: "nope" })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });

  it("a session started after ENABLE OKF gets the knowledge section; one before it does not", async () => {
    await t.stop();
    scratch = mkdtempSync(join(tmpdir(), "pap-knowledge-"));
    const captured = join(scratch, "prompts.jsonl");
    t = await startTestDaemon({
      steps: [{ text: "ok" }, { text: "ok" }],
      captureSystemPrompt: captured,
    } as never);
    const cookie = await t.login();
    const owner = await t.connect(cookie);
    const projectId = await project(owner, t.cwd);
    await runOnce(cookie);
    ok(await owner.call("projects.enableKnowledge", { projectId }));
    await runOnce(cookie);
    const prompts = readFileSync(captured, "utf8").trim().split("\n");
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain("OKF");
    expect(prompts[1]).toContain(`${join(t.cwd, "knowledge")}/index.md`);
  });
});

/** The stream's `seq` is per subscription: each run is watched on a client of its own. */
async function runOnce(cookie: string): Promise<void> {
  const watcher = await t.connect(cookie);
  try {
    const { sessionId } = ok<{ sessionId: string }>(await watcher.call("sessions.create", { cwd: t.cwd }));
    ok(await watcher.call("subscribe.session", { sessionId }));
    const mark = markOf(watcher);
    ok(await watcher.call("sessions.prompt", { sessionId, text: "go" }));
    await waitIdle(watcher, mark);
  } finally {
    watcher.close();
  }
}

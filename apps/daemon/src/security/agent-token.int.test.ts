import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentInput, TOKEN_PERMISSIONS } from "@pap/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDaemon, type TestDaemon } from "../testing/harness.ts";
import type { TestClient } from "../testing/ws-client.ts";
import { codeOf } from "./testing/agent-bed.ts";
import { openOwner, type Owner, result, rows } from "./testing/automation-bed.ts";

// M11R4 / W5-R64 I1: a token never makes an agent's trusted thread run. With every token permission it may open the
// thread (agents:operate), and every method that would start a run in it is `forbidden`, before anything starts.
let t: TestDaemon;
let owner: Owner;
let bot: TestClient;
let scratch: string;
let thread: string;

const users = (): string => {
  const file = join(scratch, "users.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
};

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "pap-agent-token-"));
  t = await startTestDaemon({
    steps: [{ text: "ran" }, { text: "ran again" }],
    captureUserMessages: join(scratch, "users.jsonl"),
  });
  owner = await openOwner(t);
  const minted = await result<{ value: string }>(
    await owner.client.call("auth.tokens.create", {
      name: "ci",
      permissions: [...TOKEN_PERMISSIONS],
      expiresInDays: 7,
    }),
  );
  bot = await t.connectBearer(minted.value);
  const agent = await result<{ id: string }>(
    await owner.client.call("agents.create", {
      input: AgentInput.parse({ name: "Atlas", preset: "read-only", sandbox: { required: false } }),
    }),
  );
  thread = (await result<{ sessionId: string }>(await bot.call("agents.openThread", { agentId: agent.id })))
    .sessionId;
});
afterAll(async () => {
  bot?.close();
  owner?.client.close();
  await t?.stop();
  rmSync(scratch, { recursive: true, force: true });
});

describe("a token and an agent's thread (W5-R64 I1)", () => {
  it("opens the thread, and every method that would run in it is forbidden", async () => {
    expect(thread).toBeTruthy();
    const calls: Array<[string, object]> = [
      ["sessions.prompt", { sessionId: thread, text: "do it" }],
      ["sessions.compact", { sessionId: thread }],
      ["sessions.navigate", { sessionId: thread, targetId: "x" }],
      ["sessions.autoName", { sessionId: thread }],
      ["usage.resumeNow", { sessionId: thread }],
    ];
    for (const [method, params] of calls) {
      expect(codeOf(await bot.call(method as never, params as never)), method).toBe("forbidden");
    }
    expect(users()).toBe("");
    expect(rows(t.home, "SELECT id FROM runs WHERE session_id = ?", thread)).toEqual([]);
  }, 60_000);

  it("the owner's browser still prompts the same thread", async () => {
    expect(
      codeOf(
        await owner.client.call("sessions.prompt" as never, { sessionId: thread, text: "hello" } as never),
      ),
    ).toBe("ok");
  }, 60_000);
});

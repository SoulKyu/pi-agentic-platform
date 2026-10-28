import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { EventFrame } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestDaemon, type TestDaemon } from "./testing/harness.ts";
import type { TestClient } from "./testing/ws-client.ts";

// A prompt template saved from pap, through a real helper, appears in the next session's / menu (UX-1).
let t: TestDaemon;
let client: TestClient;
let cookie: string;
beforeEach(async () => {
  t = await startTestDaemon({ steps: [{ text: "one" }] });
  cookie = await t.login();
  client = await t.connect(cookie);
});
afterEach(async () => {
  client.close();
  await t.stop();
});

const kindOf = (frame: EventFrame) => (frame.event as { kind?: string }).kind;
const result = (reply: unknown) => (reply as { result: Record<string, unknown> }).result;
const file = () => join(t.root, "agent", "prompts", "review.md");
const params = { name: "review", description: "Review it", body: "Review $1\n" };

describe("templates.save", () => {
  it("the owner with a step-up saves a template that a new session's / menu lists", async () => {
    await t.confirmStepUp(cookie);
    expect(await client.call("templates.save", params)).toMatchObject({
      ok: true,
      result: { name: "review", replaced: false },
    });
    expect(readFileSync(file(), "utf8")).toBe('---\ndescription: "Review it"\n---\nReview $1\n');
    const sessionId = result(await client.call("sessions.create", { cwd: realpathSync(t.cwd) }))
      .sessionId as string;
    const sub = result(await client.call("subscribe.session", { sessionId })).sub as string;
    await client.waitForEvent((f) => f.sub === sub && kindOf(f) === "snapshot");
    await client.waitForEvent(
      (f) => f.sub === sub && (f.event as { status?: string }).status === "idle",
      30_000,
    );
    const commands = result(await client.call("sessions.commands", { sessionId })).commands as Array<{
      name: string;
      source: string;
    }>;
    expect(commands).toContainEqual(expect.objectContaining({ name: "review", source: "prompt" }));
    const audit = result(await client.call("audit.list", {})).entries as Array<{
      reason: string | null;
      detail: unknown;
    }>;
    expect(audit.find((row) => row.reason === "prompt_template_saved")?.detail).toEqual({ name: "review" });
  });

  it("without the step-up: step_up_required and no file", async () => {
    expect(await client.call("templates.save", params)).toMatchObject({
      ok: false,
      error: { code: "step_up_required" },
    });
    expect(existsSync(file())).toBe(false);
  });

  it("a bearer token is refused forbidden", async () => {
    await t.confirmStepUp(cookie);
    const created = await client.call("auth.tokens.create", {
      name: "ci",
      permissions: ["sessions:read"] as never,
      expiresInDays: 7,
    });
    if (!created.ok) throw new Error(`create failed: ${created.error.code}`);
    const bot = await t.connectBearer((created.result as { value: string }).value);
    try {
      expect(await bot.call("templates.save", params)).toMatchObject({
        ok: false,
        error: { code: "forbidden" },
      });
      expect(existsSync(file())).toBe(false);
    } finally {
      bot.close();
    }
  });

  it("a second save answers conflict; replace true replaces", async () => {
    await t.confirmStepUp(cookie);
    expect(await client.call("templates.save", params)).toMatchObject({ ok: true });
    expect(await client.call("templates.save", { ...params, body: "Other\n" })).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    expect(readFileSync(file(), "utf8")).toContain("Review $1");
    expect(await client.call("templates.save", { ...params, body: "Other\n", replace: true })).toMatchObject({
      ok: true,
      result: { name: "review", replaced: true },
    });
    expect(readFileSync(file(), "utf8")).toContain("Other");
  });
});

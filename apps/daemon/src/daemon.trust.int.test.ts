import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EventFrame } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestDaemon, type TestDaemon } from "./testing/harness.ts";
import type { TestClient } from "./testing/ws-client.ts";

// A trust decision made from pap, through a real helper, applies to the next worker of the folder (M7R103, M7R105).
let t: TestDaemon;
let client: TestClient;
let cookie: string;
let cwd: string;
beforeEach(async () => {
  t = await startTestDaemon({ steps: [{ text: "one" }, { text: "two" }] });
  cookie = await t.login();
  client = await t.connect(cookie);
  cwd = realpathSync(t.cwd);
  // A prompt template needs a trust decision and runs nothing.
  mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "prompts", "hello.md"), "hello\n");
});
afterEach(async () => {
  client.close();
  await t.stop();
});

const kindOf = (frame: EventFrame) => (frame.event as { kind?: string }).kind;
const trustOf = (frame: EventFrame) =>
  (frame.event as { loadout?: { projectTrust?: unknown } | null }).loadout?.projectTrust;
const result = (reply: unknown) => (reply as { result: Record<string, unknown> }).result;
const trustFile = () => join(t.root, "agent", "trust.json");

async function openSession(folder: string) {
  const sessionId = result(await client.call("sessions.create", { cwd: folder })).sessionId as string;
  const sub = result(await client.call("subscribe.session", { sessionId })).sub as string;
  const snapshot = await client.waitForEvent((f) => f.sub === sub && kindOf(f) === "snapshot");
  return { sessionId, sub, snapshot };
}

describe("trust from pap", () => {
  it("asks for the step-up to trust, records the decision, audits the folder, and the next worker opens trusted", async () => {
    const { sessionId, sub, snapshot } = await openSession(cwd);
    const first =
      trustOf(snapshot) ??
      trustOf(await client.waitForEvent((f) => f.sub === sub && kindOf(f) === "loadout", 30_000));
    expect(first).toEqual({ required: true, trusted: false });

    expect(await client.call("trust.set", { cwd, decision: true })).toMatchObject({
      ok: false,
      error: { code: "step_up_required" },
    });
    expect(existsSync(trustFile())).toBe(false);

    await t.confirmStepUp(cookie);
    const mark = client.events.at(-1)?.seq ?? 0;
    expect(await client.call("trust.set", { cwd, decision: true })).toMatchObject({
      ok: true,
      result: { ok: true },
    });
    expect(JSON.parse(readFileSync(trustFile(), "utf8"))).toEqual({ [cwd]: true });
    // The idle worker of the folder is let go; the session stays, cold.
    await client.waitForEvent(
      (f) => f.sub === sub && f.seq > mark && (f.event as { status?: string }).status === "cold",
      30_000,
    );

    const audit = result(await client.call("audit.list", {})).entries as Array<{
      reason: string | null;
      detail: unknown;
    }>;
    expect(audit.find((row) => row.reason === "project_trusted")?.detail).toEqual({ folder: cwd });
    expect(result(await client.call("trust.status", { cwd }))).toMatchObject({
      decision: true,
      decisionPath: cwd,
      inherited: false,
      requiresTrust: true,
    });

    // The next prompt starts a worker that reads the decision.
    await client.call("sessions.prompt", { sessionId, text: "go" });
    const reopened = await client.waitForEvent(
      (f) => f.sub === sub && f.seq > mark && kindOf(f) === "loadout" && trustOf(f) !== undefined,
      30_000,
    );
    expect(trustOf(reopened)).toEqual({ required: true, trusted: true });
  });

  it("narrows without a step-up, clears only with one, and refuses to trust the home folder", async () => {
    const { sessionId } = await openSession(cwd);
    expect(sessionId).toBeTruthy();
    expect(await client.call("trust.set", { cwd, decision: false })).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(trustFile(), "utf8"))).toEqual({ [cwd]: false });
    expect(await client.call("trust.set", { cwd, decision: null })).toMatchObject({
      ok: false,
      error: { code: "step_up_required" },
    });
    expect(JSON.parse(readFileSync(trustFile(), "utf8"))).toEqual({ [cwd]: false });

    await t.confirmStepUp(cookie);
    expect(await client.call("trust.set", { cwd, decision: null })).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(trustFile(), "utf8"))).toEqual({});
    const home = realpathSync(join(t.root, "user"));
    await openSession(home);
    expect(await client.call("trust.set", { cwd: home, decision: true })).toMatchObject({
      ok: true,
      result: { ok: false, refusal: "home-or-above" },
    });
  });

  it("refuses a folder the owner has no session or project in", async () => {
    await t.confirmStepUp(cookie);
    expect(await client.call("trust.set", { cwd: "/etc", decision: true })).toMatchObject({
      ok: false,
      error: { code: "invalid_cwd" },
    });
    expect(await client.call("trust.status", { cwd: "/etc" })).toMatchObject({
      ok: false,
      error: { code: "invalid_cwd" },
    });
    expect(existsSync(trustFile())).toBe(false);
  });
});

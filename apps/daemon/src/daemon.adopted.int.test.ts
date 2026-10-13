import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { EventFrame } from "@pap/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startTestDaemon, type TestDaemon } from "./testing/harness.ts";

let t: TestDaemon;
beforeEach(async () => {
  t = await startTestDaemon({ steps: [{ text: "hi" }] });
  vi.stubEnv("PI_CODING_AGENT_DIR", join(t.root, "agent"));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await t.stop();
});

const kindOf = (frame: EventFrame) => (frame.event as { kind?: string }).kind;
const tainted = (frame: EventFrame) => (frame.event as { policy: { tainted: boolean } }).policy.tainted;

/** A session written as the `pi` CLI writes it, in the daemon's temporary agent folder (never `~/.pi/agent`). */
function writeCliSession(): string {
  const folder = join(
    t.root,
    "agent",
    "sessions",
    `--${t.cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`,
  );
  mkdirSync(folder, { recursive: true });
  const manager = SessionManager.create(t.cwd, folder);
  manager.appendMessage({ role: "user", content: "hello from the pi cli", timestamp: Date.now() });
  return manager.getSessionId();
}

it("starts a session adopted from a Pi file tainted, and a session pap creates not tainted (agreement 8)", async () => {
  const client = await t.connect(await t.login());
  expect(await client.call("subscribe.shell", {})).toMatchObject({ ok: true });
  await client.waitForEvent((frame) => kindOf(frame) === "snapshot", 10_000);
  writeCliSession();
  const adoptedEvent = await client.waitForEvent(
    (frame) =>
      kindOf(frame) === "session" && (frame.event as { session: { cwd: string } }).session.cwd === t.cwd,
    30_000,
  );
  const adoptedId = (adoptedEvent.event as { session: { id: string } }).session.id;

  const adopted = await client.call("subscribe.session", { sessionId: adoptedId });
  expect(adopted).toMatchObject({ ok: true });
  const adoptedSub = (adopted as unknown as { result: { sub: string } }).result.sub;
  const adoptedSnapshot = await client.waitForEvent(
    (frame) => frame.sub === adoptedSub && kindOf(frame) === "snapshot",
  );
  expect(tainted(adoptedSnapshot)).toBe(true);

  const created = await client.call("sessions.create", { cwd: t.cwd });
  expect(created).toMatchObject({ ok: true });
  const createdId = (created as unknown as { result: { sessionId: string } }).result.sessionId;
  const own = await client.call("subscribe.session", { sessionId: createdId });
  const ownSub = (own as unknown as { result: { sub: string } }).result.sub;
  const ownSnapshot = await client.waitForEvent(
    (frame) => frame.sub === ownSub && kindOf(frame) === "snapshot",
  );
  expect(tainted(ownSnapshot)).toBe(false);
  client.close();
}, 60_000);

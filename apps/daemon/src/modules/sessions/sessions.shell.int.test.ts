import type { ResponseFrame } from "@pap/contracts";
import { afterEach, expect, it } from "vitest";
import { startTestDaemon, type TestDaemon } from "../../testing/harness.ts";
import type { TestClient } from "../../testing/ws-client.ts";

let t: TestDaemon | undefined;
const clients: TestClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await t?.stop();
  t = undefined;
});

const resultOf = <T>(frame: ResponseFrame): T => {
  if (!frame.ok) throw new Error(`call failed: ${frame.error.code}`);
  return frame.result as T;
};
const kindOf = (frame: { event: unknown }) => (frame.event as { kind?: string }).kind;

it("tells a watching client about a session another socket of the same owner creates", async () => {
  t = await startTestDaemon({ steps: [{ text: "ok" }] });
  const cookie = await t.login();
  const watcher = await t.connect(cookie);
  const author = await t.connect(cookie);
  clients.push(watcher, author);
  resultOf<{ sub: string }>(await watcher.call("subscribe.shell", {}));
  const first = await watcher.waitForEvent((frame) => kindOf(frame) === "snapshot", 10_000);
  expect(first.event).toMatchObject({ kind: "snapshot", sessions: [], projects: [], archived: 0 });

  const { sessionId } = resultOf<{ sessionId: string }>(await author.call("sessions.create", { cwd: t.cwd }));
  const session = await watcher.waitForEvent(
    (frame) =>
      kindOf(frame) === "session" && (frame.event as { session: { id: string } }).session.id === sessionId,
    10_000,
  );
  expect(session.event).toMatchObject({ session: { cwd: expect.any(String), needsInput: false } });
  const project = await watcher.waitForEvent((frame) => kindOf(frame) === "project", 10_000);
  expect((project.event as { project: { root: string } }).project.root).toBe(t.cwd);
});

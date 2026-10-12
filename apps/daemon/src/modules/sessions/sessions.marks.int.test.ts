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

it("pins over /ws and tells the shell stream; a snooze in the past is bad_request", async () => {
  t = await startTestDaemon({ steps: [{ text: "ok" }] });
  const client = await t.connect(await t.login());
  clients.push(client);
  const { sessionId } = resultOf<{ sessionId: string }>(await client.call("sessions.create", { cwd: t.cwd }));
  resultOf<{ sub: string }>(await client.call("subscribe.shell", {}));
  await client.waitForEvent((frame) => kindOf(frame) === "snapshot", 10_000);

  const pinned = await client.call("sessions.mark", { sessionId, change: { kind: "pin", before: null } });
  expect(resultOf(pinned)).toEqual({ ok: true });
  const event = await client.waitForEvent(
    (frame) =>
      kindOf(frame) === "session" &&
      (frame.event as { session: { pinRank: number | null } }).session.pinRank === 1,
    10_000,
  );
  expect(event.event).toMatchObject({ session: { id: sessionId, pinRank: 1 } });

  const early = await client.call("sessions.mark", { sessionId, change: { kind: "snooze", until: 1 } });
  expect(early.ok).toBe(false);
  if (!early.ok) expect(early.error.code).toBe("bad_request");
});

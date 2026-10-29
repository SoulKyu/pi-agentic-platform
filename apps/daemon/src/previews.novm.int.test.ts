import type { ProjectView } from "@pap/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { markOf, waitIdle } from "./security/testing/fixtures.ts";
import { startTestDaemon, type TestDaemon } from "./testing/harness.ts";
import { previewPortOf, projectBox, through } from "./testing/preview-bed.ts";
import type { TestClient } from "./testing/ws-client.ts";

// PF-10: a daemon with no VM stack (agents unavailable, no KVM) still serves HTML artifacts, whose source is the daemon's own
// transcript; its previews list is empty and a service cannot be opened.

const REPLY = "```html\n<p>no vm</p>\n```\n";
let t: TestDaemon;
let client: TestClient;
beforeAll(async () => {
  t = await startTestDaemon({ steps: [{ text: REPLY }] });
  client = await t.connect(await t.login());
}, 120_000);
afterAll(async () => {
  client?.close();
  await t?.stop();
});

describe("previews with no VM stack", () => {
  it("previews.artifact still mints and the listener serves it; previews.list is empty and previews.open is box_stopped", async () => {
    const created = await client.call("sessions.create", { cwd: t.cwd });
    const sessionId = (created.ok ? created.result : { sessionId: "" }) as { sessionId: string };
    await client.call("subscribe.session", { sessionId: sessionId.sessionId });
    const mark = markOf(client);
    await client.call("sessions.prompt", { sessionId: sessionId.sessionId, text: "draw" });
    await waitIdle(client, mark);
    const subscribed = await client.call("subscribe.session", { sessionId: sessionId.sessionId });
    const sub = (subscribed.ok ? subscribed.result : { sub: "" }) as { sub: string };
    const snapshot = await client.waitForEvent((frame) => frame.sub === sub.sub);
    const rows = (snapshot.event as { rows: Array<{ entryId: string | null; message: { role?: string } }> })
      .rows;
    const entryId = rows.find((row) => row.message.role === "assistant")?.entryId ?? "";
    expect(entryId).not.toBe("");

    const minted = await client.call("previews.artifact", {
      sessionId: sessionId.sessionId,
      entryId,
      fenceIndex: 0,
    });
    if (!minted.ok) throw new Error(`not minted: ${minted.error.code}`);
    const served = await through(await previewPortOf(t), (minted.result as { url: string }).url);
    expect(served.status).toBe(200);
    expect(served.body).toBe("<p>no vm</p>");

    const project = await client.call("projects.create", { name: "Boxed" });
    const box = projectBox(
      ((project.ok ? project.result : { project: { id: "" } }) as { project: ProjectView }).project.id,
    );
    const listed = await client.call("previews.list", { box });
    expect(listed.ok ? listed.result : listed.error.code).toEqual({ services: [] });
    const opened = await client.call("previews.open", { box, name: "project" });
    expect(opened.ok ? "ok" : opened.error.code).toBe("box_stopped");
  });
});

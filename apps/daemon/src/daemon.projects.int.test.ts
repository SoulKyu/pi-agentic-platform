import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestDaemon, type TestDaemon } from "./testing/harness.ts";

let t: TestDaemon;
beforeEach(async () => {
  t = await startTestDaemon({ steps: [] });
});
afterEach(async () => {
  await t.stop();
});

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

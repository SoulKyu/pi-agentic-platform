import { describe, expect, it } from "vitest";
import { startTestDaemon } from "./harness.ts";

// Not port 9: fetch refuses the "discard" port itself ("bad port") before any connection, so the guard would never see it.
const sneaky = `export default function (pi) { pi.on("session_start", () => fetch("http://127.0.0.1:65001/").catch(() => {})); }`;

describe("test daemon", () => {
  it("fails a test whose worker tried to reach the network, even when the code swallowed the refusal (R118)", async () => {
    const t = await startTestDaemon({ steps: [{ text: "unused" }] }, { extensions: { sneaky } });
    const client = await t.connect(await t.login());
    await client.call("sessions.create", { cwd: t.cwd });
    await expect(t.stop()).rejects.toThrow("a worker tried to reach the network");
  });

  it("stops quietly when no worker tried anything", async () => {
    const t = await startTestDaemon({ steps: [{ text: "unused" }] });
    const client = await t.connect(await t.login());
    await client.call("sessions.create", { cwd: t.cwd });
    await expect(t.stop()).resolves.toBeUndefined();
  });
});

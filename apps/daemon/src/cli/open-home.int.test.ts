import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startTestDaemon } from "../testing/harness.ts";
import { openHomeForCli } from "./open-home.ts";
import { cliIo } from "./testing/cli-io.ts";

describe("openHomeForCli with a real daemon's home", () => {
  it("opens writable a home a real daemon created and stopped (M5R126)", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "pap-cli-home-"));
    try {
      const home = join(scratch, "home");
      const t = await startTestDaemon({ steps: [{ text: "hi" }] }, { config: { home } });
      await t.stop();
      const opened = await openHomeForCli(cliIo({ env: { PAP_HOME: home } }).io, { create: false });
      try {
        expect(() => opened.db.run("INSERT INTO meta (key, value) VALUES ('cli_probe', '1')")).not.toThrow();
      } finally {
        opened.close();
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

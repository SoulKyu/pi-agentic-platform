import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { acquireInstanceLock, InstanceLockError } from "../kernel/home.ts";
import { runCli } from "./run-cli.ts";
import { cliIo } from "./testing/cli-io.ts";
import { fakeTty } from "./testing/fake-tty.ts";

describe("pap user add holds the instance lock through the prompt", () => {
  it("keeps a daemon out while the owner types, and frees the lock on Ctrl-C", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "pap-user-add-lock-"));
    try {
      const home = join(scratch, "home");
      const tty = fakeTty();
      const { io, stderr } = cliIo({ env: { PAP_HOME: home } });
      const running = runCli(["user", "add", "owner"], { ...io, stdin: tty.stdin });
      await vi.waitFor(() => expect(tty.modes).toEqual([true]), { timeout: 10_000 });

      expect(() => acquireInstanceLock(home)).toThrow(InstanceLockError);

      tty.press("\u0003");
      expect(await running).toBe(130);
      expect(stderr()).toBe("pap: interrupted\n");
      acquireInstanceLock(home).release();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

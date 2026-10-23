import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { refuseLiveVmd } from "../../../scripts/smoke-lib.ts";
import { kataSeamsOf } from "./compose-agents-vm-socket.ts";
import { loadConfig } from "./kernel/config.ts";
import { startTestDaemon } from "./testing/harness.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const PLAIN = { dev: false, devVmd: false, home: "/h/.pap-dev/x" };
const SCRIPTED = { ...PLAIN, testProviderScript: "/tmp/script.json", testVmdSocket: null };

describe("no test path reaches the real pap-vmd", () => {
  it("refuses a scripted-provider daemon that names no pap-vmd, and uses the override when there is one", () => {
    expect(() => kataSeamsOf(SCRIPTED, undefined)).toThrow(/PAP_TEST_VMD_SOCKET/);
    expect(kataSeamsOf({ ...SCRIPTED, testVmdSocket: "/x/none.sock" }, undefined)).toEqual({
      socket: "/x/none.sock",
    });
    expect(kataSeamsOf(SCRIPTED, { socket: "/y.sock" })).toEqual({ socket: "/y.sock" });
    expect(kataSeamsOf({ ...PLAIN, testProviderScript: null, testVmdSocket: null }, undefined)).toEqual({});
  });

  it("a --dev daemon never dials the real pap-vmd unless PAP_DEV_VMD=1 (its boot stopAll would stop the preview's VMs)", () => {
    const dev = { ...PLAIN, dev: true, testProviderScript: null, testVmdSocket: null };
    expect(kataSeamsOf(dev, undefined)).toEqual({ socket: "/h/.pap-dev/x/no-vmd.sock" });
    expect(kataSeamsOf({ ...dev, devVmd: true }, undefined)).toEqual({});
    expect(kataSeamsOf(dev, { socket: "/y.sock" })).toEqual({ socket: "/y.sock" });
    const input = (env: NodeJS.ProcessEnv) => ({
      argv: ["--dev"],
      env,
      cwd: REPO,
      homedir: "/home/u",
      totalMemMb: 16_384,
      piHostEntry: "/x/main.js",
      piHostExecArgv: [],
      staticRoot: null,
    });
    expect(loadConfig(input({})).devVmd).toBe(false);
    expect(loadConfig(input({ PAP_DEV_VMD: "1" })).devVmd).toBe(true);
  });

  it("honours PAP_TEST_VMD_SOCKET only with the scripted provider", () => {
    const input = (env: NodeJS.ProcessEnv) => ({
      argv: [],
      env,
      cwd: "/tmp",
      homedir: "/home/u",
      totalMemMb: 16_384,
      piHostEntry: "/x/main.js",
      piHostExecArgv: [],
      staticRoot: null,
    });
    expect(() => loadConfig(input({ PAP_TEST_VMD_SOCKET: "/a.sock" }))).toThrow(/PAP_TEST_VMD_SOCKET/);
    const config = loadConfig(input({ PAP_TEST_VMD_SOCKET: "/a.sock", PAP_TEST_PROVIDER_SCRIPT: "/s.json" }));
    expect(config.testVmdSocket).toBe("/a.sock");
  });

  it("dials the named socket and nothing else at boot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pap-vmd-spy-"));
    const path = join(dir, "vmd.sock");
    let connections = 0;
    const spy = net.createServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) => spy.listen(path, resolve));
    try {
      const t = await startTestDaemon({ steps: [] }, { config: { testVmdSocket: path } });
      await t.stop();
      expect(connections).toBeGreaterThan(0);
    } finally {
      spy.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is set by every helper that starts the daemon with the scripted provider", () => {
    for (const file of [
      "apps/daemon/src/security/testing/daemon-process.ts",
      "apps/daemon/src/main.int.test.ts",
      "scripts/e2e/daemon.ts",
      "scripts/smoke-dist.ts",
    ]) {
      const text = readFileSync(join(REPO, file), "utf8");
      expect(text, file).toContain("PAP_TEST_PROVIDER_SCRIPT");
      expect(text, file).toContain("PAP_TEST_VMD_SOCKET");
    }
  });

  it("keeps the smoke scripts off a live pap-vmd: every one starts its daemon through startDaemon, which refuses", () => {
    expect(() => refuseLiveVmd({}, () => true)).toThrow(/live pap-vmd/);
    expect(() => refuseLiveVmd({}, () => false)).not.toThrow();
    expect(() => refuseLiveVmd({ PAP_TEST_VMD_SOCKET: "/x.sock" }, () => true)).not.toThrow();
    for (const file of ["scripts/smoke-dist.ts", "scripts/smoke-install.ts"])
      expect(readFileSync(join(REPO, file), "utf8"), file).toContain("startDaemon(");
  });
});

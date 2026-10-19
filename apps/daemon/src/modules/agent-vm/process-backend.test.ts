import { DEFAULT_AGENT_RESOURCES } from "@pap/contracts";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSystemClock } from "../../kernel/clock.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { layoutOf } from "./layouts.ts";
import { createProcessBackend } from "./process-backend.ts";
import type { VmSpec } from "./runtime.ts";

let root: string;
const spec = (taskKey: string | null = null): VmSpec => ({
  agentId: "a1",
  kind: taskKey === null ? "thread" : "isolated",
  taskKey,
  image: `pap-agent-agent-${"a".repeat(64)}`,
  resources: DEFAULT_AGENT_RESOURCES,
});
const launch = { launchId: "l".repeat(32), token: "t".repeat(64) };

function backend(testSwitch: string | null = "process") {
  const image = join(root, "image");
  mkdirSync(join(image, "sub"), { recursive: true });
  writeFileSync(join(image, "settings.json"), "{}");
  writeFileSync(join(image, "sub", "x"), "x");
  // The guest stand-in writes what it was given, then waits for a signal.
  const entry = join(root, "guest.mjs");
  writeFileSync(
    entry,
    `import { writeFileSync } from "node:fs";
writeFileSync(process.env.PAP_GUEST_RUN_DIR + "/seen.json", JSON.stringify({ env: process.env, cwd: process.cwd() }));
setInterval(() => {}, 1000);`,
  );
  return createProcessBackend({
    testSwitch,
    papHome: join(root, "pap"),
    guestEntry: entry,
    execArgv: [],
    imageAgentSource: image,
    gatewayAddress: () => ({ host: "127.0.0.1", port: 4321 }),
    providerScript: "/script.json",
    clock: createSystemClock(),
    logger: silentLogger,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pap-t7-"));
});
afterEach(() => {
  execFileSync("chmod", ["-R", "u+w", root]);
  rmSync(root, { recursive: true, force: true });
});

describe("process backend", () => {
  it("refuses to be built without PAP_TEST_AGENT_RUNTIME=process", () => {
    expect(() => backend(null)).toThrow("PAP_TEST_AGENT_RUNTIME=process");
    expect(() => backend("kata")).toThrow("PAP_TEST_AGENT_RUNTIME=process");
  });

  it("starts the guest with the gateway variables, makes the image folder read-only, lists and stops it", async () => {
    const b = backend();
    const layout = layoutOf("process", join(root, "pap"), spec());
    await expect(b.start(spec(), launch)).resolves.toEqual({ address: "127.0.0.1" });
    const seen = join(layout.root, "run", "seen.json");
    await expect
      .poll(
        () => {
          try {
            return readFileSync(seen, "utf8");
          } catch {
            return "";
          }
        },
        { timeout: 10_000 },
      )
      .not.toBe("");
    const { env, cwd } = JSON.parse(readFileSync(seen, "utf8")) as {
      env: Record<string, string>;
      cwd: string;
    };
    expect(env).toMatchObject({
      PAP_GATEWAY: "127.0.0.1:4321",
      PAP_GATEWAY_TOKEN: launch.token,
      PAP_LAUNCH_ID: launch.launchId,
      PAP_AGENT_ID: "a1",
      PAP_IMAGE_TAG: spec().image,
      PAP_GUEST_RUN_DIR: join(layout.root, "run"),
      PAP_TEST_PROVIDER_SCRIPT: "/script.json",
    });
    expect(JSON.parse(env.PAP_GUEST_LAYOUT ?? "")).toEqual(layout);
    expect(cwd).toBe(layout.home);
    expect(statSync(layout.imageAgentDir).mode & 0o777).toBe(0o555);
    expect(statSync(join(layout.imageAgentDir, "sub")).mode & 0o777).toBe(0o555);
    expect(statSync(join(layout.imageAgentDir, "settings.json")).mode & 0o777).toBe(0o444);
    expect(() => writeFileSync(join(layout.imageAgentDir, "new"), "x")).toThrow();
    await expect(b.list()).resolves.toEqual([{ agentId: "a1", taskKey: null }]);
    await b.stop("a1", null);
    await expect(b.list()).resolves.toEqual([]);
  });

  it("restarts into a folder it made read-only", async () => {
    const b = backend();
    await b.start(spec(), launch);
    await b.stop("a1", null);
    await b.start(spec(), launch);
    await expect(b.list()).resolves.toHaveLength(1);
    await b.stop("a1", null);
  });
});

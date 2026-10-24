import { type BoxRef, DEFAULT_AGENT_RESOURCES } from "@pap/contracts";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSystemClock } from "../../kernel/clock.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { layoutOf, projectLayoutOf } from "./layouts.ts";
import { createProcessBackend } from "./process-backend.ts";
import { projectLayoutOf as vmProjectLayoutOf } from "./project-layout.ts";
import type { VmSpec } from "./runtime.ts";

let root: string;
const agent: BoxRef = { kind: "agent", id: "a1" };
const project: BoxRef = { kind: "project", id: "0b1c2d3e-4f50-4162-8394-a5b6c7d8e9f0" };
const spec = (taskKey: string | null = null, box: BoxRef = agent): VmSpec => ({
  box,
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
    proxyAddress: () => ({ host: "127.0.0.1", port: 4322 }),
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
    const layout = layoutOf("process", join(root, "pap"), { agentId: "a1", taskKey: null });
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
      PAP_GUEST_PROXY: "127.0.0.1:4322",
      PAP_GATEWAY_TOKEN: launch.token,
      PAP_LAUNCH_ID: launch.launchId,
      PAP_BOX: "agent:a1",
      PAP_IMAGE_TAG: spec().image,
      PAP_GUEST_RUN_DIR: join(layout.root, "run"),
      PAP_TEST_PROVIDER_SCRIPT: "/script.json",
      // What the scripted provider's worker needs (ADR 0001), so the VM's init may name the script (AVM-E15).
      PAP_TEST_PROVIDER: "1",
      PI_OFFLINE: "1",
    });
    expect(JSON.parse(env.PAP_GUEST_LAYOUT ?? "")).toEqual(layout);
    expect(cwd).toBe(layout.home);
    expect(statSync(layout.imageAgentDir).mode & 0o777).toBe(0o555);
    expect(statSync(join(layout.imageAgentDir, "sub")).mode & 0o777).toBe(0o555);
    expect(statSync(join(layout.imageAgentDir, "settings.json")).mode & 0o777).toBe(0o444);
    expect(() => writeFileSync(join(layout.imageAgentDir, "new"), "x")).toThrow();
    await expect(b.list()).resolves.toEqual([{ box: agent, taskKey: null }]);
    await b.stop(agent, null);
    await expect(b.list()).resolves.toEqual([]);
  });

  it("starts a project box under tmp/boxes/<id> with PAP_BOX", async () => {
    const b = backend();
    const paths = projectLayoutOf("process", join(root, "pap"), project.id);
    expect(paths.root).toBe(join(root, "pap", "tmp", "boxes", project.id));
    await b.start(spec(null, project), launch);
    const seen = join(paths.root, "run", "seen.json");
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
    expect(env.PAP_BOX).toBe(`project:${project.id}`);
    expect(env).not.toHaveProperty("PAP_AGENT_ID");
    expect(env.HOME).toBe(paths.home);
    // The guest is given the box's VM layout (the project folder, the image's Pi folder), not the bare paths.
    const layout = vmProjectLayoutOf("process", join(root, "pap"), project.id);
    expect(JSON.parse(env.PAP_GUEST_LAYOUT ?? "")).toEqual(layout);
    expect(layout).toMatchObject({ ...paths, knowledge: `${paths.project}/knowledge` });
    expect(statSync(layout.imageAgentDir).isDirectory()).toBe(true);
    expect(cwd).toBe(paths.home);
    for (const dir of [paths.project, paths.inbox, paths.sessions, paths.piAgentDir]) {
      expect(statSync(dir).isDirectory()).toBe(true);
    }
    await expect(b.list()).resolves.toEqual([{ box: project, taskKey: null }]);
    await b.stop(project, null);
    await expect(b.list()).resolves.toEqual([]);
  });

  it("restarts into a folder it made read-only", async () => {
    const b = backend();
    await b.start(spec(), launch);
    await b.stop(agent, null);
    await b.start(spec(), launch);
    await expect(b.list()).resolves.toHaveLength(1);
    await b.stop(agent, null);
  });
});

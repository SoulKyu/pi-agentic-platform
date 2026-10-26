import { type BoxRef, DEFAULT_AGENT_RESOURCES } from "@pap/contracts";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSystemClock } from "../../kernel/clock.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { createProcessBackend } from "./process-backend.ts";
import type { VmSpec } from "./runtime.ts";

let root: string;
const agent: BoxRef = { kind: "agent", id: "a1" };
const KEEP = "d".repeat(32);
const task = (taskKey: string, keepKey: string | null = KEEP): VmSpec => ({
  box: agent,
  kind: "isolated",
  taskKey,
  ...(keepKey === null ? {} : { keepKey }),
  image: `pap-agent-agent-${"a".repeat(64)}`,
  resources: DEFAULT_AGENT_RESOURCES,
});
const launch = { launchId: "l".repeat(32), token: "t".repeat(64) };

function backend() {
  const image = join(root, "image");
  mkdirSync(image, { recursive: true });
  writeFileSync(join(image, "settings.json"), "{}");
  const entry = join(root, "guest.mjs");
  writeFileSync(entry, "setInterval(() => {}, 1000);");
  return createProcessBackend({
    testSwitch: "process",
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
  root = mkdtempSync(join(tmpdir(), "pap-keep-"));
});
afterEach(() => {
  execFileSync("chmod", ["-R", "u+w", root]);
  rmSync(root, { recursive: true, force: true });
});

describe("process backend: one live process per kept folder, as pap-vmd (K2)", () => {
  it("refuses `conflict` a kept start while another process uses the same key, and starts once it is gone", async () => {
    const b = backend();
    await b.start(task("1".repeat(32)), launch);
    await expect(b.start(task("2".repeat(32)), launch)).rejects.toMatchObject({ code: "conflict" });
    expect(await b.list()).toHaveLength(1);
    await b.stop(agent, "1".repeat(32));
    await expect(b.start(task("2".repeat(32)), launch)).resolves.toEqual({ address: "127.0.0.1" });
    await b.stop(agent, "2".repeat(32));
  });

  it("lets a kept task run beside a plain one or one with another key", async () => {
    const b = backend();
    await b.start(task("1".repeat(32)), launch);
    await b.start(task("2".repeat(32), null), launch);
    await b.start(task("3".repeat(32), "e".repeat(32)), launch);
    expect(await b.list()).toHaveLength(3);
    for (const key of ["1", "2", "3"]) await b.stop(agent, key.repeat(32));
  });
});

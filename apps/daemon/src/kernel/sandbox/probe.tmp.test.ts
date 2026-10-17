import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createFakeClock } from "../clock.ts";
import { silentLogger } from "../logger.ts";
import { createSandboxProbe, removeStaleProbes } from "./probe.ts";

let work: string;
beforeEach(() => {
  work = realpathSync(mkdtempSync(join(tmpdir(), "pap-probe-tmp-")));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

it("makes the canary folder where the daemon says ($PAP_HOME), not in os.tmpdir()", async () => {
  const hidden: string[] = [];
  const spawn = ((_command: string, args: string[]) => {
    hidden.push(args[args.lastIndexOf("--tmpfs") + 1] ?? "");
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), pid: 0 });
    queueMicrotask(() => child.emit("close", 1));
    return child;
  }) as never;
  const probe = createSandboxProbe({
    override: "/usr/bin/true",
    clock: createFakeClock(),
    logger: silentLogger,
    tmp: work,
    spawn,
  });
  await probe.recheck();
  expect(hidden).toHaveLength(1);
  expect(hidden[0]?.startsWith(`${work}/pap-probe-`)).toBe(true);
});

it("removes the canary folders a crashed probe left, and nothing else", () => {
  mkdirSync(join(work, "pap-probe-AbC123"));
  writeFileSync(join(work, "pap-probe-AbC123", "canary"), "");
  mkdirSync(join(work, "agents"));
  writeFileSync(join(work, "state.db"), "x");
  removeStaleProbes(work);
  expect(existsSync(join(work, "pap-probe-AbC123"))).toBe(false);
  expect(existsSync(join(work, "agents"))).toBe(true);
  expect(existsSync(join(work, "state.db"))).toBe(true);
});

it("unlinks a link named like a canary and never follows it; a plain file is left alone", () => {
  mkdirSync(join(work, "precious"));
  writeFileSync(join(work, "precious", "keep"), "x");
  symlinkSync(join(work, "precious"), join(work, "pap-probe-Link01"));
  writeFileSync(join(work, "pap-probe-File01"), "x");
  removeStaleProbes(work);
  expect(existsSync(join(work, "pap-probe-Link01"))).toBe(false);
  expect(existsSync(join(work, "precious", "keep"))).toBe(true);
  expect(existsSync(join(work, "pap-probe-File01"))).toBe(true);
});

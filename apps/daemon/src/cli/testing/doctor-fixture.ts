import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { defaultProbes, makeSystemChecks, type SystemProbes } from "../doctor/checks-system.ts";
import type { CheckResult, DoctorContext } from "../doctor/types.ts";
import { createSystemd } from "../service/systemd.ts";
import type { ParsedUnit } from "../service/unit-read.ts";
import { cliIo } from "./cli-io.ts";
import { fakeSystemd } from "./fake-systemd.ts";

/** Per-test temporary folders and fake systemd for the doctor's system checks; the hooks register where this is imported. */
export let scratch: string;
export let fake: ReturnType<typeof fakeSystemd>;
export let tools: string;
export let home: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "pap-doctor-sys-"));
  fake = fakeSystemd(join(scratch, "fake"));
  tools = join(scratch, "tools");
  home = join(scratch, "pap-home");
  mkdirSync(tools);
  fake.set("linger", "yes\n");
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

export const unitWith = (over: Partial<ParsedUnit> = {}): ParsedUnit => ({
  node: "/n",
  main: "/m",
  port: 7777,
  host: null,
  home: null,
  env: {},
  tls: false,
  insecureHttp: false,
  ...over,
});

export function ctx(over: Partial<DoctorContext> & { path?: string } = {}): DoctorContext {
  const { path, env: extra, ...rest } = over;
  const env: NodeJS.ProcessEnv = { PATH: path ?? `${fake.binDir}:/usr/bin:/bin`, HOME: scratch, ...extra };
  return {
    io: cliIo({ env, homedir: scratch }).io,
    env,
    homedir: scratch,
    home,
    homeSource: "default",
    unitName: "pap.service",
    unit: null,
    lockHeld: false,
    systemd: createSystemd(env),
    inContainer: false,
    clock: createFakeClock(),
    ...rest,
  };
}

export const probes = (over: Partial<SystemProbes> = {}): SystemProbes => ({
  ...defaultProbes(),
  journalDirExists: () => true,
  journaldConf: () => [],
  ...over,
});

export async function run(
  id: string,
  context: DoctorContext,
  over: Partial<SystemProbes> = {},
): Promise<CheckResult> {
  const check = makeSystemChecks(probes(over)).find((c) => c.id === id);
  if (check === undefined) throw new Error(`no check ${id}`);
  return check.run(context);
}

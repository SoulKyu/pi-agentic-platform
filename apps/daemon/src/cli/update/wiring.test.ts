import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Clock } from "../../kernel/clock.ts";
import { createFakeClock } from "../../kernel/clock.ts";
import { cliIo } from "../testing/cli-io.ts";
import { resolveTarget } from "../ops/target.ts";
import type { Systemd } from "../service/systemd.ts";
import type { HealthTarget } from "./probe-health.ts";
import { makeApplyDeps } from "./wiring.ts";

const ID = "0123456789abcdef0123456789abcdef";
const LISTENING = '{"msg":"listening","url":"http://localhost:7777","port":7777}';
const SETUP = '{"msg":"setup_url","url":"http://localhost:7777/setup?token=abc"}';

const unitText = (exec = "", home = "/data/pap") =>
  `[Service]\nExecStart=/opt/node --disable-warning=ExperimentalWarning /opt/main.js serve${exec}\nEnvironment=PAP_HOME=${home}\n`;

const targetOf = (text: string) => resolveTarget({ unit: "pap.service" }, {}, "/home/u", text);

/** A clock whose sleep advances time at once: no waiting, and the elapsed time is what the wiring measured. */
function steppingClock(): Clock & { elapsed(): number } {
  const base = createFakeClock(1_700_000_000_000);
  let moved = 0;
  return {
    ...base,
    now: () => 1_700_000_000_000 + moved,
    sleep: async (ms) => {
      moved += ms;
    },
    elapsed: () => moved,
  };
}

interface Fake {
  states: (string | null)[];
  journal?: string;
  any?: string;
  activeCalls: number;
}

function fakes(options: Partial<Fake> = {}) {
  const state: Fake = { states: ["activating"], activeCalls: 0, ...options };
  const systemd = {
    invocationId: async () => (options.journal === undefined ? null : ID),
    journal: async () => options.journal ?? "",
    journalAny: async () => options.any ?? "Started pap.service.\n",
    activeState: async () => {
      const at = Math.min(state.activeCalls++, state.states.length - 1);
      return state.states[at] ?? null;
    },
    restartCount: async () => 0,
    stop: async () => undefined,
    restart: async () => undefined,
    resetFailed: async () => undefined,
  } as unknown as Systemd;
  return { state, systemd };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function build(
  text: string,
  options: { systemd: Systemd; probe?: (target: HealthTarget) => Promise<boolean>; deadlineMs?: number },
  clock = steppingClock(),
) {
  const { io } = cliIo();
  const deps = await makeApplyDeps({ ...io, clock }, targetOf(text), {
    app: "/app",
    deadlineMs: options.deadlineMs ?? 120_000,
    settleMs: 10_000,
    systemd: options.systemd,
    ...(options.probe === undefined ? {} : { probe: options.probe }),
  });
  return { deps, clock };
}

describe("listening (M6bR11e)", () => {
  it("a unit that is failed ends the wait as never after the first chunk, long before the deadline", async () => {
    const { state, systemd } = fakes({ states: ["failed"] });
    const { deps, clock } = await build(unitText(), { systemd });
    expect(await deps.listening(new Date(), 120_000)).toEqual({ kind: "never" });
    expect(state.activeCalls).toBe(1);
    expect(clock.elapsed()).toBeLessThan(20_000);
  });

  it("keeps waiting while the unit is activating, and stops when it fails", async () => {
    const { state, systemd } = fakes({ states: ["activating", "activating", "failed"] });
    const { deps } = await build(unitText(), { systemd });
    expect(await deps.listening(new Date(), 120_000)).toEqual({ kind: "never" });
    expect(state.activeCalls).toBe(3);
  });

  it("a setup URL and an owner end the wait at once, without asking the unit state", async () => {
    const url = fakes({ journal: `${SETUP}\n${LISTENING}\n` });
    const first = await build(unitText(), { systemd: url.systemd });
    expect(await first.deps.listening(new Date(), 120_000)).toEqual({
      kind: "url",
      url: "http://localhost:7777/setup?token=abc",
    });
    expect(url.state.activeCalls).toBe(0);
    const owner = fakes({ journal: `${LISTENING}\n` });
    const second = await build(unitText(), { systemd: owner.systemd });
    expect(await second.deps.listening(new Date(), 120_000)).toEqual({ kind: "owner" });
    expect(owner.state.activeCalls).toBe(0);
  });

  it("the unit's port is the one the journal is read for", async () => {
    const other = '{"msg":"listening","url":"http://localhost:8123","port":8123}';
    const setup = '{"msg":"setup_url","url":"http://localhost:8123/setup?token=t"}';
    const { systemd } = fakes({ journal: `${setup}\n${other}\n` });
    const { deps } = await build(unitText(" --port 8123"), { systemd });
    expect(await deps.listening(new Date(), 120_000)).toMatchObject({ kind: "url" });
  });

  it("an unreadable journal stays unreadable at the deadline", async () => {
    const { state, systemd } = fakes({ states: ["activating"], any: "" });
    const { deps, clock } = await build(unitText(), { systemd });
    expect(await deps.listening(new Date(), 30_000)).toEqual({ kind: "unreadable" });
    expect(state.activeCalls).toBeGreaterThan(1);
    expect(clock.elapsed()).toBeGreaterThanOrEqual(30_000);
    expect(clock.elapsed()).toBeLessThan(60_000);
  });

  it("a journal with lines but no listening line is never at the deadline", async () => {
    const { systemd } = fakes({ states: ["activating"] });
    const { deps } = await build(unitText(), { systemd });
    expect(await deps.listening(new Date(), 30_000)).toEqual({ kind: "never" });
  });
});

describe("healthz (M6b-RT-02)", () => {
  const probeOf = async (text: string) => {
    const seen: HealthTarget[] = [];
    const { deps } = await build(text, {
      systemd: fakes().systemd,
      probe: async (target) => {
        seen.push(target);
        return true;
      },
    });
    expect(await deps.healthz()).toBe(true);
    return seen;
  };

  it("asks the unit's host, port and scheme", async () => {
    expect(
      await probeOf(unitText(" --host 192.0.2.1 --port 8080 --tls-cert /x/c.pem --tls-key /x/k.pem")),
    ).toEqual([{ host: "192.0.2.1", port: 8080, tls: true }]);
  });

  it("a unit without flags is loopback on 7777 over HTTP", async () => {
    expect(await probeOf(unitText())).toEqual([{ host: null, port: 7777, tls: false }]);
  });
});

describe("the rest of the wiring", () => {
  it("takes the home, the unit and the deadlines from the target and the options", async () => {
    const { deps } = await build(unitText(), { systemd: fakes().systemd });
    expect(deps).toMatchObject({
      app: "/app",
      home: "/data/pap",
      unit: "pap.service",
      deadlineMs: 120_000,
      settleMs: 10_000,
    });
    expect(deps.knownIds.size).toBeGreaterThan(0);
  });

  it("holdHome takes the instance lock of that home once and gives it back", async () => {
    const home = mkdtempSync(join(tmpdir(), "pap-wiring-"));
    dirs.push(home);
    const { deps } = await build(unitText("", home), { systemd: fakes().systemd });
    const release = deps.holdHome();
    expect(() => deps.holdHome()).toThrow(/already running|lock/);
    release();
    deps.holdHome()();
  });

  it("sleep goes through the CLI clock", async () => {
    const { deps, clock } = await build(unitText(), { systemd: fakes().systemd });
    await deps.sleep(2500);
    expect(clock.elapsed()).toBe(2500);
    expect(deps.now().getTime()).toBe(1_700_000_002_500);
  });
});

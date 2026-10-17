import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentInput, bwrapArgv, type PapError } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SandboxProbe } from "../../kernel/sandbox/probe.ts";
import { captureLogger } from "./testing/helpers.ts";
import { type AgentGateDeps, agentGate, type AgentProfile, SYSTEM_HIDDEN } from "./agent-gate.ts";
import type { SessionRow } from "./store.ts";

const ID = "atlas-1a2b";
const TASK = "0a1b2c3d-0000-4000-8000-0123456789ab";
let root: string;
let papHome: string;
let ownerHome: string;
let piDir: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pap-agent-gate-")));
  papHome = join(root, "pap");
  ownerHome = join(root, "home");
  piDir = join(root, "pi-agent");
  for (const dir of [papHome, ownerHome, piDir]) mkdirSync(dir, { mode: 0o700 });
  mkdirSync(join(papHome, "agents", ID), { recursive: true, mode: 0o700 });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const home = () => join(papHome, "agents", ID);
const scratch = () => join(papHome, "agents", ".runs", ID, TASK);
const row = (extra: Partial<SessionRow> = {}): SessionRow => ({
  id: "s1",
  piPath: null,
  piSessionId: null,
  cwd: home(),
  ownerId: "u1",
  name: null,
  createdAt: 0,
  updatedAt: 0,
  agentId: ID,
  agentRole: "thread",
  ...extra,
});

interface Options {
  input?: object;
  profile?: AgentProfile | null;
  probe?: SandboxProbe;
  vault?: Record<string, string>;
  ownerHomeSpelling?: string;
}
function deps(options: Options = {}) {
  const logs = captureLogger();
  const profile =
    options.profile === undefined
      ? {
          input: AgentInput.parse({ name: "Atlas", role: "Be brief.", ...options.input }),
          name: "Atlas",
          quarantined: false,
        }
      : options.profile;
  let probes = 0;
  const value: AgentGateDeps = {
    papHome,
    agentDir: piDir,
    homeDir: () => options.ownerHomeSpelling ?? ownerHome,
    profileOf: () => profile,
    vaultOf: () => options.vault ?? {},
    probe: {
      ensure: async () => {
        probes += 1;
        return options.probe ?? { usable: true, path: "/usr/bin/bwrap" };
      },
    },
    logger: logs.logger,
  };
  return { value, logs, probes: () => probes };
}
const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: PapError) => error.code,
  );

describe("agentGate (M11R53, M11R54)", () => {
  it("a thread gets the host view, its home writable, and the real folders that exist hidden", async () => {
    const { value } = deps({ vault: { TOKEN: "v" } });
    const launch = await agentGate(row(), value);
    expect(launch.sandbox).toEqual({
      bwrap: "/usr/bin/bwrap",
      view: "host",
      home: home(),
      writable: home(),
      hide: [
        ownerHome,
        papHome,
        piDir,
        ...SYSTEM_HIDDEN.filter((path) => existsSync(path)).map((path) => realpathSync(path)),
      ],
      network: false,
      egress: null,
    });
    expect(launch.sandbox).not.toHaveProperty("readOnly");
    expect(launch.sandbox?.hide.length).toBeLessThanOrEqual(12);
    for (const path of launch.sandbox?.hide ?? []) expect(path).toBe(realpathSync(path));
    expect(() => bwrapArgv(launch.sandbox as never, "true")).not.toThrow();
    expect(launch.agent).toEqual({ id: ID, name: "Atlas", role: "Be brief." });
    expect(launch.vault).toEqual({ TOKEN: "v" });
  });

  it("hides the places a core dump can land, when they exist (W5-R25)", () => {
    expect(SYSTEM_HIDDEN).toEqual(["/var/log", "/var/tmp", "/var/crash", "/var/lib/systemd/coredump"]);
  });

  it("hides the real folder of a linked home, not the link (the worker refuses a link)", async () => {
    const link = join(root, "home-link");
    symlinkSync(ownerHome, link);
    const { value } = deps({ ownerHomeSpelling: link });
    const hide = (await agentGate(row(), value)).sandbox?.hide ?? [];
    expect(hide).toContain(ownerHome);
    expect(hide).not.toContain(link);
  });

  it("leaves out a candidate that does not exist", async () => {
    rmSync(piDir, { recursive: true });
    const hide = (await agentGate(row(), deps().value)).sandbox?.hide ?? [];
    expect(hide).not.toContain(piDir);
  });

  it("an isolated task gets the system view, its home read-only and its scratch folder writable", async () => {
    mkdirSync(scratch(), { recursive: true, mode: 0o700 });
    const launch = await agentGate(
      row({ agentRole: "task", cwd: scratch() }),
      deps({ vault: { K: "v" } }).value,
    );
    expect(launch.sandbox).toMatchObject({ view: "system", home: home(), writable: scratch() });
    expect(launch.vault).toEqual({ K: "v" });
  });

  it("a task whose folder is not its own scratch folder is refused", async () => {
    expect(await codeOf(agentGate(row({ agentRole: "task", cwd: home() }), deps().value))).toBe(
      "invalid_cwd",
    );
  });

  it("without a required sandbox there is no sandbox and no vault, even when one is stored", async () => {
    const { value, probes } = deps({ input: { sandbox: { required: false } }, vault: { K: "v" } });
    const launch = await agentGate(row(), value);
    expect(launch).not.toHaveProperty("sandbox");
    expect(launch).not.toHaveProperty("vault");
    expect(probes()).toBe(0);
  });

  it("a child never gets the vault", async () => {
    const launch = await agentGate(row({ agentRole: "child" }), deps({ vault: { K: "v" } }).value);
    expect(launch).not.toHaveProperty("vault");
    expect(launch.sandbox?.view).toBe("host");
  });

  it("refuses a quarantined agent, a deleted one and a profile that does not parse", async () => {
    const quarantined = { input: AgentInput.parse({ name: "Atlas" }), name: "Atlas", quarantined: true };
    expect(await codeOf(agentGate(row(), deps({ profile: quarantined }).value))).toBe("agent_paused");
    expect(await codeOf(agentGate(row(), deps({ profile: null }).value))).toBe("not_found");
  });

  it("refuses a home made a link, and a thread whose folder is not its home", async () => {
    rmSync(home(), { recursive: true });
    symlinkSync(ownerHome, home());
    expect(await codeOf(agentGate(row(), deps().value))).toBe("invalid_cwd");
    rmSync(home());
    mkdirSync(home(), { mode: 0o700 });
    expect(await codeOf(agentGate(row({ cwd: ownerHome }), deps().value))).toBe("invalid_cwd");
  });

  it("repairs a home opened up, and logs it once", async () => {
    mkdirSync(home(), { recursive: true });
    const { value, logs } = deps();
    chmodSync(home(), 0o755); // the agent's own chmod, from its shell
    await agentGate(row(), value);
    expect(statSync(home()).mode & 0o777).toBe(0o700);
    expect(logs.lines.filter((line) => line.msg === "agent_home_mode_repaired")).toEqual([
      expect.objectContaining({ agentId: ID }),
    ]);
  });

  it.each(["missing", "unsafe_path", "refused", "timeout"] as const)(
    "a sandbox that is %s refuses the start and logs why",
    async (reason) => {
      const { value, logs } = deps({ probe: { usable: false, reason } });
      expect(await codeOf(agentGate(row(), value))).toBe("sandbox_unavailable");
      expect(logs.lines.find((line) => line.msg === "agent_sandbox_refused")).toMatchObject({
        agentId: ID,
        reason,
      });
    },
  );

  it("never logs the role or a vault value", async () => {
    const { value, logs } = deps({
      vault: { K: "vault-secret-value" },
      probe: { usable: false, reason: "refused" },
    });
    await codeOf(agentGate(row(), value));
    expect(JSON.stringify(logs.lines)).not.toMatch(/vault-secret-value|Be brief/);
  });
});

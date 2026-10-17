import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentInput, bwrapArgv, type PapError } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SandboxProbe } from "../../kernel/sandbox/probe.ts";
import { type AgentGateDeps, agentPrecheckSandbox, type AgentProfile, SYSTEM_HIDDEN } from "./agent-gate.ts";
import type { EgressPort } from "./egress-link.ts";
import { captureLogger } from "./testing/helpers.ts";

const ID = "atlas-1a2b";
let root: string;
let papHome: string;
let ownerHome: string;
let piDir: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pap-precheck-gate-")));
  papHome = join(root, "pap");
  ownerHome = join(root, "home");
  piDir = join(root, "pi-agent");
  for (const dir of [papHome, ownerHome, piDir]) mkdirSync(dir, { mode: 0o700 });
  mkdirSync(join(papHome, "agents", ID), { recursive: true, mode: 0o700 });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const home = () => join(papHome, "agents", ID);
function deps(options: { input?: object; profile?: AgentProfile | null; probe?: SandboxProbe } = {}) {
  const profile =
    options.profile === undefined
      ? { input: AgentInput.parse({ name: "Atlas", ...options.input }), name: "Atlas", quarantined: false }
      : options.profile;
  let probes = 0;
  const value: AgentGateDeps = {
    papHome,
    agentDir: piDir,
    homeDir: () => ownerHome,
    profileOf: () => profile,
    probe: {
      ensure: async () => {
        probes += 1;
        return options.probe ?? { usable: true, path: "/usr/bin/bwrap" };
      },
    },
    logger: captureLogger().logger,
    egress: {
      ready: async () => {},
      status: () => ({ usable: true, python: "/usr/bin/python3", reason: null }),
      forwarderPath: "/run/pap/egress/fwd.py",
    } as unknown as EgressPort,
  };
  return { value, probes: () => probes };
}
const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: PapError) => error.code,
  );

describe("the sandbox of an agent trigger's precheck (M11R68)", () => {
  it("is the system view with nothing writable, the home read-only and the hidden folders and the agent's network, behind the proxy", async () => {
    const { value } = deps({ input: { sandbox: { required: true, network: true } } });
    const spec = await agentPrecheckSandbox(value, "u1", ID);
    expect(spec).toEqual({
      bwrap: "/usr/bin/bwrap",
      view: "system",
      home: home(),
      writable: null,
      hide: expect.arrayContaining([
        ownerHome,
        papHome,
        piDir,
        ...SYSTEM_HIDDEN.filter((p) => p === "/var/log"),
      ]),
      network: true,
      egress: { python: "/usr/bin/python3", forwarder: "/run/pap/egress/fwd.py" },
    });
    expect(spec.hide.every((path) => !path.startsWith(`${home()}/`))).toBe(true);
    const argv = bwrapArgv(spec, "pwd", "/run/pap/egress/0/0.s");
    expect(argv).not.toContain("--share-net");
    expect(argv).toContain("--unshare-net");
    expect(argv.slice(-2)).toEqual(["pap-sh", "pwd"]);
    expect(argv).toContain("--chdir");
  });

  it("has no network when the agent has none", async () => {
    const spec = await agentPrecheckSandbox(deps().value, "u1", ID);
    expect(spec.network).toBe(false);
    expect(bwrapArgv(spec, "true")).toContain("--unshare-net");
  });

  it("is demanded even when the agent's own profile does not require the sandbox: nothing unsandboxed runs", async () => {
    const { value, probes } = deps({ input: { sandbox: { required: false, network: false } } });
    expect(await agentPrecheckSandbox(value, "u1", ID)).toMatchObject({ view: "system", writable: null });
    expect(probes()).toBe(1);
  });

  it("fails sandbox_unavailable on an unusable bwrap, whatever the reason", async () => {
    for (const reason of ["missing", "unsafe_path", "refused", "timeout"] as const) {
      const { value } = deps({ probe: { usable: false, reason } });
      expect(await codeOf(agentPrecheckSandbox(value, "u1", ID))).toBe("sandbox_unavailable");
    }
  });

  it("answers not_found for an agent that is not the owner's, and agent_paused for a quarantined one", async () => {
    expect(await codeOf(agentPrecheckSandbox(deps({ profile: null }).value, "u1", ID))).toBe("not_found");
    const quarantined = {
      input: AgentInput.parse({ name: "Atlas" }),
      name: "Atlas",
      quarantined: true,
    };
    expect(await codeOf(agentPrecheckSandbox(deps({ profile: quarantined }).value, "u1", ID))).toBe(
      "agent_paused",
    );
  });

  it("refuses a home that is a link, never following it", async () => {
    rmSync(home(), { recursive: true });
    mkdirSync(join(root, "elsewhere"));
    symlinkSync(join(root, "elsewhere"), home());
    expect(await codeOf(agentPrecheckSandbox(deps().value, "u1", ID))).toBe("invalid_cwd");
  });
});

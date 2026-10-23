import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentInput } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentGate, type AgentGateDeps } from "./agent-gate.ts";
import type { SessionRow } from "./store.ts";
import { codeOf } from "./testing/helpers.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { type VmGateFs, vmGate } from "./vm-gate.ts";

const ID = "atlas-1a2b";
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pap-vm-gate-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const row = (extra: Partial<SessionRow> = {}): SessionRow =>
  ({
    id: "s1",
    ownerId: "u1",
    agentId: ID,
    agentRole: "thread",
    cwd: join(home, "agents", ID),
    piPath: null,
    ...extra,
  }) as SessionRow;
const profile = (extra: object = {}) => ({
  input: AgentInput.parse({ name: "Atlas", sandbox: { required: true, network: true }, ...extra }),
  name: "Atlas",
  quarantined: false,
});
const deps = (found: ReturnType<typeof profile> | null = profile(), fs?: VmGateFs) => ({
  papHome: home,
  logger: silentLogger,
  profileOf: vi.fn(() => found),
  ...(fs ? { fs } : {}),
});

/** A fake file system that answers "nothing there" and records every path it is asked about. */
function recordingFs() {
  const paths: string[] = [];
  const fs: VmGateFs = {
    lstat: (path) => (paths.push(path), null),
    mkdir: (path) => void paths.push(path),
  };
  return { fs, paths };
}

describe("vmGate (T8a, RT-08)", () => {
  it("answers the profile, the role and vm: true, and nothing of a host sandbox", async () => {
    const launch = await vmGate(row(), deps());
    expect(launch).toMatchObject({ agent: { id: ID, name: "Atlas" }, role: "thread", vm: true });
    for (const key of ["sandbox", "vault", "once"]) expect(launch).not.toHaveProperty(key);
  });
  it("keeps the role of a task and a child", async () => {
    expect((await vmGate(row({ agentRole: "task" }), deps())).role).toBe("task");
    expect((await vmGate(row({ agentRole: "child" }), deps())).role).toBe("child");
  });
  it("refuses a row without an agent, an unknown agent and a quarantined one, touching nothing", async () => {
    const { fs, paths } = recordingFs();
    expect(await codeOf(vmGate(row({ agentId: undefined }), deps(profile(), fs)))).toBe("bad_request");
    expect(await codeOf(vmGate(row(), deps(null, fs)))).toBe("not_found");
    expect(await codeOf(vmGate(row(), deps({ ...profile(), quarantined: true }, fs)))).toBe("agent_paused");
    expect(paths).toEqual([]);
  });
  it("never opens the agent's host home: the only paths are the mirror folders", async () => {
    const { fs, paths } = recordingFs();
    await vmGate(row(), deps(profile(), fs));
    const agents = join(home, "agents");
    const mirrors = join(agents, ".mirrors");
    // lstat then mkdir of each folder, in order: nothing else, in particular not `agents/<id>` (the host home).
    expect(paths).toEqual([agents, agents, mirrors, mirrors, join(mirrors, ID), join(mirrors, ID)]);
  });
  it("makes $PAP_HOME/agents/.mirrors/<id> 0700 when missing", async () => {
    await vmGate(row(), deps());
    const folder = join(home, "agents", ".mirrors", ID);
    expect(statSync(folder).isDirectory()).toBe(true);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    // A second launch finds it and changes nothing.
    await vmGate(row(), deps());
  });
  // Mutant: `lstat` replaced by `stat`, which follows a link (a link at the mirror folder is accepted). Killed by the next case.
  // (Removing only `isSymbolicLink()` survives by design: the lstat of a link is never a directory.)
  it("refuses a link at .mirrors/<id>, at .mirrors and at agents (invalid_cwd)", async () => {
    mkdirSync(join(home, "agents", ".mirrors"), { recursive: true });
    mkdirSync(join(home, "elsewhere"));
    symlinkSync(join(home, "elsewhere"), join(home, "agents", ".mirrors", ID));
    expect(await codeOf(vmGate(row(), deps()))).toBe("invalid_cwd");
    rmSync(join(home, "agents"), { recursive: true });
    mkdirSync(join(home, "agents"));
    symlinkSync(join(home, "elsewhere"), join(home, "agents", ".mirrors"));
    expect(await codeOf(vmGate(row(), deps()))).toBe("invalid_cwd");
    rmSync(join(home, "agents"), { recursive: true });
    symlinkSync(join(home, "elsewhere"), join(home, "agents"));
    expect(await codeOf(vmGate(row(), deps()))).toBe("invalid_cwd");
  });
  it("refuses a file where the folder should be", async () => {
    mkdirSync(join(home, "agents", ".mirrors"), { recursive: true });
    writeFileSync(join(home, "agents", ".mirrors", ID), "x");
    expect(await codeOf(vmGate(row(), deps()))).toBe("invalid_cwd");
  });
  it("refuses a folder of another user", async () => {
    const owned: VmGateFs = {
      lstat: () => ({
        isDirectory: () => true,
        isSymbolicLink: () => false,
        uid: (process.getuid?.() ?? 0) + 1,
      }),
      mkdir: () => {},
    };
    expect(await codeOf(vmGate(row(), deps(profile(), owned)))).toBe("invalid_cwd");
  });
});

describe("agentGate in VM mode (T8a)", () => {
  function gateDeps(vm: boolean) {
    const vaultOf = vi.fn(() => ({ TOKEN: "s3cret" }));
    const onceOf = vi.fn(() => []);
    const value: AgentGateDeps = {
      papHome: home, // no agents/<id> folder: a host gate would refuse with invalid_cwd
      agentDir: join(home, "pi"),
      logger: silentLogger,
      profileOf: () => profile(),
      vaultOf,
      onceOf,
      vmLayoutOf: vm ? () => ({}) as never : () => null,
    };
    return { value, vaultOf, onceOf };
  }
  it("takes the VM gate: no home, and the vault and one-use values read once (ADR 0081)", async () => {
    const { value, vaultOf, onceOf } = gateDeps(true);
    const launch = await agentGate(row(), value);
    expect(launch.vm).toBe(true);
    expect(launch).not.toHaveProperty("sandbox");
    expect(launch.vault).toEqual({ TOKEN: "s3cret" });
    expect(launch).not.toHaveProperty("once");
    expect(vaultOf).toHaveBeenCalledOnce();
    expect(onceOf).toHaveBeenCalledOnce();
    expect(() => statSync(join(home, "agents", ID))).toThrow();
  });
  it("refuses a row with no VM layout: there is no host gate", async () => {
    const { value } = gateDeps(false);
    expect(await codeOf(agentGate(row(), value))).toBe("sandbox_unavailable");
  });
});

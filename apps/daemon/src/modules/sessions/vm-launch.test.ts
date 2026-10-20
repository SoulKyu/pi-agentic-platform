import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentInput, type InitRecord, PapError, PolicyRules, type VmLayout } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "../../kernel/logger.ts";
import { createFakeWorker } from "../../kernel/testing/fake-worker.ts";
import { layoutOf, type VmSpec } from "../agent-vm/index.ts";
import type { AgentLaunch } from "./agent-gate.ts";
import { createAgentRules } from "./agent-rules.ts";
import type { SessionRow } from "./store.ts";
import { codeOf } from "./testing/helpers.ts";
import { createVmLaunch, VM_BWRAP, VM_ROOT_VIEW, vmBranchOf, type VmLaunch } from "./vm-launch.ts";

const ID = "atlas-1a2b";
const TASK = "0f6c0f2e-1111-4222-8333-444455556666";
const KEY = "a".repeat(32);
const SLOT = "b".repeat(32);
const IMAGE = `pap-agent-agent-${"c".repeat(64)}`;
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pap-vm-launch-"));
  mkdirSync(join(home, "agents", ID), { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const row = (extra: Partial<SessionRow> = {}): SessionRow =>
  ({
    id: "s1",
    ownerId: "u1",
    agentId: ID,
    agentRole: "thread",
    cwd: home,
    piPath: null,
    ...extra,
  }) as SessionRow;
/** The id the agent form sent (AVM-E33) and the source the helper resolves it to: the runtime must get the source. */
const PICK_ID = "c".repeat(32);
const PICK_SOURCE = "npm:left-pad@1.0.0";
const input = AgentInput.parse({
  name: "Atlas",
  resources: { memoryMb: 2048, cpus: 2, diskMb: 8192 },
  packages: [PICK_ID],
});
const launch = (extra: Partial<AgentLaunch> = {}): AgentLaunch => ({
  agent: { id: ID, name: "Atlas", role: "r" },
  role: "thread",
  input,
  vm: true,
  ...extra,
});
const vmLayout = (r: SessionRow): VmLayout =>
  layoutOf("process", home, {
    agentId: ID,
    taskKey: r.agentRole === "task" ? r.id.replaceAll("-", "") : null,
  });
/** The rules a daemon composes for the row, with the VM layout wired (or not). */
function rulesFor(r: SessionRow, wired: boolean) {
  const compose = createAgentRules({
    papHome: home,
    profileOf: () => ({ input, name: "Atlas", quarantined: false }),
    hostGrants: () => [],
    logger: silentLogger,
    ...(wired ? { vmLayoutOf: vmLayout } : {}),
  });
  return PolicyRules.parse({
    profile: "agent-thread",
    approvalMode: "supervised",
    ...compose(r, { allowHosts: null, denylist: [] }),
  });
}
const hostInit = (r: SessionRow, wired = true): InitRecord => ({
  type: "init",
  cwd: join(home, "agents", ID),
  agentDir: join(home, "pi"),
  papHome: home,
  umask: 0o022,
  papSessionId: r.id,
  policy: rulesFor(r, wired),
  agent: { id: ID, name: "Atlas", role: "r" },
  vault: { TOKEN: "s3cret" },
});

function setup(
  layoutForRuntime?: (r: SessionRow) => VmLayout,
  copyProviderScript?: (layout: VmLayout) => string,
  imageTagOf: (agentId: string, input: AgentLaunch["input"]) => string | Promise<string> = () => IMAGE,
) {
  const worker = createFakeWorker({});
  const specs: VmSpec[] = [];
  const inputs: unknown[] = [];
  const packages: unknown[] = [];
  const spawn = vi.fn(async (spec: VmSpec, workerInput: unknown, picks: unknown) => {
    specs.push(spec);
    inputs.push(workerInput);
    packages.push(picks);
    const r = currentRow;
    return {
      handle: Object.assign(worker, { slot: SLOT, piFile: () => null }),
      layout: (layoutForRuntime ?? vmLayout)(r),
      relayKey: KEY,
      slot: SLOT,
    };
  });
  let currentRow = row();
  const inputFor = vi.fn((r: SessionRow) => ({
    sessionFile: null,
    sessionsDir: "/ignored",
    mirrorFor: () => "refused" as const,
    unsent: () => false,
    sent: () => {},
    marker: r.id,
  }));
  const vmLaunch = createVmLaunch({
    runtime: { spawn } as never,
    papHome: home,
    layoutOf: (r) => (r.agentId === undefined ? null : vmLayout(r)),
    imageTagOf,
    mirrors: { inputFor },
    logger: silentLogger,
    // Mutant: the ids go to the runtime as they are -> "hands the runtime the sources, never the ids" fails.
    toImageEntries: (_agentId, sources) =>
      sources === null
        ? null
        : sources.map((source) => (source === PICK_SOURCE ? `${PICK_SOURCE}#written` : source)),
    packageSources: async (ids) =>
      ids === null ? null : ids.map((id) => (id === PICK_ID ? PICK_SOURCE : id)),
    ...(copyProviderScript ? { copyProviderScript } : {}),
  });
  return {
    vmLaunch,
    worker,
    spawn,
    specs,
    inputs,
    packages,
    inputFor,
    use: (r: SessionRow) => (currentRow = r),
  };
}

describe("VM_BWRAP and VM_ROOT_VIEW", () => {
  it("are the image's bwrap and AVM-P3's read-only root", () => {
    expect(VM_BWRAP).toBe("/usr/bin/bwrap");
    expect(VM_ROOT_VIEW).toBe("read-only");
  });
});

describe("the scripted provider in a process-backend VM (AVM-E15)", () => {
  // Mutants: the init keeps the host's path (vmInitOf drops it, the copy is not named) -> "names the copy's VM path"; the
  // copier called at the dry run (before the spawn) -> "copies at the bind, not before the spawn".
  it("names the copy's VM path in the init, copied when the worker is bound", async () => {
    const copied: VmLayout[] = [];
    const bed = setup(undefined, (layout) => {
      copied.push(layout);
      return `${layout.root}/run/provider-script.json`;
    });
    const r = bed.use(row());
    const started = await bed.vmLaunch.spawn(r, launch(), hostInit(r));
    expect(copied).toEqual([]);
    const out = started.bind(() => ({ init: { ...hostInit(r), testProviderScript: "/host/script.json" } }));
    expect(copied).toEqual([vmLayout(r)]);
    expect(out.init.testProviderScript).toBe(`${vmLayout(r).root}/run/provider-script.json`);
  });

  it("leaves the field out when the backend is not the process backend (Kata never runs a test script)", async () => {
    const bed = setup();
    const r = bed.use(row());
    const started = await bed.vmLaunch.spawn(r, launch(), hostInit(r));
    const out = started.bind(() => ({ init: { ...hostInit(r), testProviderScript: "/host/script.json" } }));
    expect(out.init).not.toHaveProperty("testProviderScript");
  });
});

describe("the image tag of a launch (T15a: Kata builds it first)", () => {
  // Mutants: the tag read without await (a Promise reaches the spec), the tag asked before a bad task key is refused.
  const OTHER = `pap-agent-agent-${"d".repeat(64)}`;
  it("waits for the tag, handing the resolver the agent and the launch's profile", async () => {
    const asked: unknown[] = [];
    const bed = setup(undefined, undefined, async (agentId, launchInput) => {
      asked.push([agentId, launchInput]);
      return OTHER;
    });
    const r = bed.use(row());
    await bed.vmLaunch.spawn(r, launch(), hostInit(r));
    expect(asked).toEqual([[ID, input]]);
    expect(bed.specs[0]?.image).toBe(OTHER);
  });
  it("does not ask for a tag (a build) for a launch it refuses", async () => {
    const asked = vi.fn(() => IMAGE);
    const bed = setup(undefined, undefined, asked);
    const r = bed.use(row({ id: "not-a-uuid", agentRole: "task" }));
    expect(await codeOf(bed.vmLaunch.spawn(r, launch({ role: "task" }), hostInit(r)))).toBe("bad_request");
    expect(asked).not.toHaveBeenCalled();
  });
  it("passes a refusal of the resolver on, with nothing spawned", async () => {
    const bed = setup(undefined, undefined, () => Promise.reject(new PapError("sandbox_unavailable")));
    const r = bed.use(row());
    expect(await codeOf(bed.vmLaunch.spawn(r, launch(), hostInit(r)))).toBe("sandbox_unavailable");
    expect(bed.spawn).not.toHaveBeenCalled();
  });
});

describe("createVmLaunch (T8a)", () => {
  it("spawns a thread, a child and a thread task as kind thread in the agent's VM", async () => {
    for (const agentRole of ["thread", "child"] as const) {
      const bed = setup();
      const r = bed.use(row({ agentRole }));
      await bed.vmLaunch.spawn(r, launch({ role: agentRole }), hostInit(r));
      expect(bed.specs).toEqual([
        { agentId: ID, kind: "thread", taskKey: null, image: IMAGE, resources: input.resources },
      ]);
    }
  });
  it("spawns an isolated task as kind isolated with its id without dashes", async () => {
    const bed = setup();
    const r = bed.use(row({ id: TASK, agentRole: "task" }));
    await bed.vmLaunch.spawn(r, launch({ role: "task" }), hostInit(r));
    expect(bed.specs[0]).toMatchObject({ kind: "isolated", taskKey: TASK.replaceAll("-", "") });
    expect(bed.specs[0]?.taskKey).toMatch(/^[0-9a-f]{32}$/);
  });
  it("refuses a task whose id is not a task key, before any spawn", async () => {
    const bed = setup();
    const r = bed.use(row({ id: "not-a-uuid", agentRole: "task" }));
    expect(await codeOf(bed.vmLaunch.spawn(r, launch({ role: "task" }), hostInit(r)))).toBe("bad_request");
    expect(bed.spawn).not.toHaveBeenCalled();
  });
  it("hands the runtime the sources of the picks, never the ids, and null stays null (AVM-E33)", async () => {
    const bed = setup();
    const r = bed.use(row());
    await bed.vmLaunch.spawn(r, launch(), hostInit(r));
    await bed.vmLaunch.spawn(
      r,
      launch({ input: AgentInput.parse({ ...input, packages: null }) }),
      hostInit(r),
    );
    expect(bed.packages).toEqual([[`${PICK_SOURCE}#written`], null]);
  });
  it("hands the runtime the mirror input with the VM's sessions folder, and the profile's packages", async () => {
    const bed = setup();
    const r = bed.use(row());
    await bed.vmLaunch.spawn(r, launch(), hostInit(r));
    // The launch's resources go with the row: the mirror's quota is the agent's diskMb (R32).
    expect(bed.inputFor).toHaveBeenCalledWith(r, launch().input.resources);
    expect(bed.inputs[0]).toMatchObject({ marker: "s1", sessionsDir: vmLayout(r).sessions });
    expect(bed.packages[0]).toEqual([`${PICK_SOURCE}#written`]);
  });
  it("never sends the host init: bind returns the VM's init for startLiveSession to send", async () => {
    const bed = setup();
    const r = bed.use(row());
    const started = await bed.vmLaunch.spawn(r, launch(), hostInit(r));
    expect(bed.worker.sent).toEqual([]);
    const out = started.bind(() => ({ init: hostInit(r), tag: 7 }));
    expect(out.tag).toBe(7);
    const layout = vmLayout(r);
    expect(out.init).toMatchObject({
      cwd: layout.home,
      agentDir: layout.piAgentDir,
      vm: { layout, bwrap: VM_BWRAP, relayKey: KEY, slot: SLOT, rootView: VM_ROOT_VIEW },
    });
    for (const key of ["sandbox", "vault", "once", "memory"]) expect(out.init).not.toHaveProperty(key);
    expect(JSON.stringify(out.init)).not.toContain("s3cret");
    expect(bed.worker.sent).toEqual([]);
  });
  // Mutant: the dry-run vmInitOf before runtime.spawn removed. Killed by the two cases below (the spawn would happen).
  it("spawns nothing when the init is not the VM's (host rules, the layout unwired)", async () => {
    const bed = setup();
    const r = bed.use(row());
    expect(await codeOf(bed.vmLaunch.spawn(r, launch(), hostInit(r, false)))).toBe("bad_request");
    expect(bed.spawn).not.toHaveBeenCalled();
  });
  it("spawns nothing when the rules lack the VM's sandbox", async () => {
    const bed = setup();
    const r = bed.use(row());
    const init = hostInit(r);
    const rules = { ...(init.policy as PolicyRules), sandbox: { required: false, network: false } };
    expect(await codeOf(bed.vmLaunch.spawn(r, launch(), { ...init, policy: rules }))).toBe("internal");
    expect(bed.spawn).not.toHaveBeenCalled();
  });
  it("refuses a launch that is not a VM launch, a row without an agent and a row the layout does not know", async () => {
    const bed = setup();
    const r = bed.use(row());
    expect(await codeOf(bed.vmLaunch.spawn(r, launch({ vm: undefined }), hostInit(r)))).toBe("internal");
    const plain = row({ agentId: undefined });
    expect(await codeOf(bed.vmLaunch.spawn(plain, launch(), hostInit(r)))).toBe("internal");
    expect(bed.spawn).not.toHaveBeenCalled();
  });
  it("stops the spawned worker when the composition after the wait throws, and rethrows", async () => {
    const bed = setup();
    const r = bed.use(row());
    const started = await bed.vmLaunch.spawn(r, launch(), hostInit(r));
    const stop = vi.spyOn(bed.worker, "stop");
    expect(() =>
      started.bind(() => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(stop).toHaveBeenCalledTimes(1);
  });
  // Mutant: the stop on a failed translation removed. Killed here: the runtime's layout differs from the rules' root.
  it("stops the spawned worker when the translation after the spawn refuses", async () => {
    const bed = setup(() => layoutOf("process", home, { agentId: "other-9z9z", taskKey: null }));
    const r = bed.use(row());
    const started = await bed.vmLaunch.spawn(r, launch(), hostInit(r));
    const stop = vi.spyOn(bed.worker, "stop");
    expect(() => started.bind(() => ({ init: hostInit(r) }))).toThrow(
      expect.objectContaining({ code: "bad_request" }),
    );
    expect(stop).toHaveBeenCalledTimes(1);
  });
  it("names the session file of a row whose Pi file is its mirror, none for a new session", async () => {
    const bed = setup();
    const mirror = join(home, "agents", ".mirrors", ID, "s.jsonl");
    const r = bed.use(row({ piPath: mirror }));
    const started = await bed.vmLaunch.spawn(r, launch(), { ...hostInit(r), sessionFile: mirror });
    const out = started.bind(() => ({ init: { ...hostInit(r), sessionFile: mirror } }));
    expect(out.init.sessionFile).toBe(`${vmLayout(r).sessions}/s.jsonl`);
    const fresh = setup();
    const f = fresh.use(row());
    const second = await fresh.vmLaunch.spawn(f, launch(), hostInit(f));
    expect(second.bind(() => ({ init: hostInit(f) })).init).not.toHaveProperty("sessionFile");
  });
});

describe("vmBranchOf: one predicate, no half-VM launch (fail closed)", () => {
  const launcher = { spawn: vi.fn() } as unknown as VmLaunch;
  it("a host row without a VM launch is the host branch", () => {
    expect(vmBranchOf(false, null, undefined)).toBeNull();
    expect(vmBranchOf(false, launch({ vm: undefined }), launcher)).toBeNull();
  });
  it("a VM row with the VM gate's answer and a launcher is the VM branch", () => {
    expect(vmBranchOf(true, launch(), launcher)).toBe(launcher);
  });
  it("refuses every disagreement with internal", () => {
    expect(() => vmBranchOf(true, launch(), undefined)).toThrow(
      expect.objectContaining({ code: "internal" }),
    );
    expect(() => vmBranchOf(true, launch({ vm: undefined }), launcher)).toThrow(
      expect.objectContaining({ code: "internal" }),
    );
    expect(() => vmBranchOf(true, null, launcher)).toThrow(expect.objectContaining({ code: "internal" }));
    expect(() => vmBranchOf(false, launch(), launcher)).toThrow(
      expect.objectContaining({ code: "internal" }),
    );
  });
});

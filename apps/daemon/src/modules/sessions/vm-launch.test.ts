import { join } from "node:path";
import { AgentInput, PapError, PolicyRules, type VmLayout } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { layoutOf } from "../agent-vm/index.ts";
import { codeOf } from "./testing/helpers.ts";
import {
  hostInit,
  homeDir,
  ID,
  IMAGE,
  input,
  KEY,
  launch,
  PICK_SOURCE,
  row,
  setup,
  SLOT,
  TASK,
  useVmLaunchHome,
  vmLayout,
} from "./vm-launch-fixtures.ts";
import { VM_BWRAP, VM_ROOT_VIEW, vmBranchOf, type VmLaunch } from "./vm-launch.ts";

useVmLaunchHome();

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
  // S1 item 5. Mutant: the check removed (or made before the tag wait) -> a quarantine during the build still spawns the VM.
  it("asks the agent's state again after the wait, and a quarantine meanwhile spawns nothing", async () => {
    let quarantined = false;
    const bed = setup(
      undefined,
      undefined,
      async () => {
        quarantined = true; // the owner quarantines the agent while its image builds
        return IMAGE;
      },
      () => {
        if (quarantined) throw new PapError("agent_paused");
      },
    );
    const r = bed.use(row());
    expect(await codeOf(bed.vmLaunch.spawn(r, launch(), hostInit(r)))).toBe("agent_paused");
    expect(bed.spawn).not.toHaveBeenCalled();
  });
  // S1 round 1 (M1). Mutant: the check back before the package helper -> a quarantine during the helper still spawns the VM.
  it("asks again after the package helper too: a quarantine during it spawns nothing", async () => {
    let quarantined = false;
    const bed = setup(
      undefined,
      undefined,
      undefined,
      () => {
        if (quarantined) throw new PapError("agent_paused");
      },
      async () => {
        quarantined = true;
        return [];
      },
    );
    const r = bed.use(row());
    expect(await codeOf(bed.vmLaunch.spawn(r, launch(), hostInit(r)))).toBe("agent_paused");
    expect(bed.spawn).not.toHaveBeenCalled();
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
        { ...bed.specs[0], box: { kind: "agent", id: ID }, kind: "thread", taskKey: null },
      ]);
      expect(bed.specs[0]).toMatchObject({ image: IMAGE, resources: input.resources });
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
    for (const key of ["sandbox", "once"]) expect(out.init).not.toHaveProperty(key);
    expect(out.init.vault).toEqual({ TOKEN: "s3cret" });
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
    const bed = setup(() => layoutOf("process", homeDir(), { agentId: "other-9z9z", taskKey: null }));
    const r = bed.use(row());
    const started = await bed.vmLaunch.spawn(r, launch(), hostInit(r));
    const stop = vi.spyOn(bed.worker, "stop");
    expect(() => started.bind(() => ({ init: hostInit(r) }))).toThrow(
      expect.objectContaining({ code: "bad_request" }),
    );
    expect(stop).toHaveBeenCalledTimes(1);
  });
  it("hands the claude-bridge environment to the runtime in the worker input, and none otherwise", async () => {
    const bed = setup();
    const r = bed.use(row());
    await bed.vmLaunch.spawn(r, launch({ claudeEnv: { IS_SANDBOX: "1" } }), hostInit(r));
    await bed.vmLaunch.spawn(r, launch(), hostInit(r));
    expect(bed.inputs[0]).toMatchObject({ env: { IS_SANDBOX: "1" } });
    expect(bed.inputs[1]).not.toHaveProperty("env");
  });
  it("names the session file of a row whose Pi file is its mirror, none for a new session", async () => {
    const bed = setup();
    const mirror = join(homeDir(), "agents", ".mirrors", ID, "s.jsonl");
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

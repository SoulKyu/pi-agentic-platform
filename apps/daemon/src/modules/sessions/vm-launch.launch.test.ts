import { PapError } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { silentLogger } from "../../kernel/logger.ts";
import { createFakeClock } from "../../kernel/clock.ts";
import { createLaunchRegistry } from "../agent-vm/index.ts";
import { recordLaunches } from "../agent-vm/testing/launch-recorder.ts";
import { codeOf } from "./testing/helpers.ts";
import {
  hostInit,
  ID,
  IMAGE,
  launch,
  row,
  setup as baseSetup,
  useVmLaunchHome,
} from "./vm-launch-fixtures.ts";
import type { AgentLaunch } from "./agent-gate.ts";
import type { ImageObserver } from "../../kernel/launches.ts";

useVmLaunchHome();

/** `setup` with a recording registry: the launch steps are what these tests read. */
function setup(
  imageTagOf?: (
    a: string,
    i: AgentLaunch["input"],
    k: "thread" | "isolated",
    observe?: ImageObserver,
  ) => string | Promise<string>,
  recheck?: () => void,
  spawnError?: Error,
) {
  const recorder = recordLaunches(createLaunchRegistry({ clock: createFakeClock(), logger: silentLogger }));
  const bed = baseSetup(undefined, undefined, imageTagOf, recheck, undefined, spawnError, recorder.registry);
  return { ...bed, recorder };
}

describe("launch steps (launch progress)", () => {
  const OTHER = `pap-agent-agent-${"d".repeat(64)}`;
  it("a session launch reports its image build then worker ready", async () => {
    const bed = setup(async (_agentId, _input, _kind, observe) => {
      observe?.waiting(1);
      observe?.waiting(null);
      observe?.building(OTHER);
      return OTHER;
    });
    const r = bed.use(row());
    const started = await bed.vmLaunch.spawn(r, launch(), hostInit(r));
    expect(bed.recorder.log).toEqual(["image:running", "wait:image_build", "wait:none", "image:done"]);
    // The launch goes on to the session layer: it marks the worker and ends it.
    expect(started.launch).toBeDefined();
    started.launch?.step("worker", "running");
    started.launch?.step("worker", "done");
    started.launch?.end(true);
    expect(bed.recorder.log.slice(-3)).toEqual(["worker:running", "worker:done", "end:ok"]);
  });

  it("an image the resolver found built is skipped", async () => {
    const bed = setup(async (_a, _i, _k, observe) => {
      observe?.skipped();
      return IMAGE;
    });
    const r = bed.use(row());
    await bed.vmLaunch.spawn(r, launch(), hostInit(r));
    expect(bed.recorder.log).toEqual(["image:running", "image:skipped"]);
  });

  it("ends the launch with the code of a refusal: the resolver's, the recheck's, the runtime's", async () => {
    const refused = setup(() => Promise.reject(new PapError("sandbox_unavailable")));
    const r1 = refused.use(row());
    expect(await codeOf(refused.vmLaunch.spawn(r1, launch(), hostInit(r1)))).toBe("sandbox_unavailable");
    expect(refused.recorder.log).toEqual(["image:running", "image:failed", "end:sandbox_unavailable"]);

    const rechecked = setup(undefined, () => {
      throw new PapError("agent_paused");
    });
    const r2 = rechecked.use(row());
    expect(await codeOf(rechecked.vmLaunch.spawn(r2, launch(), hostInit(r2)))).toBe("agent_paused");
    expect(rechecked.recorder.log.at(-1)).toBe("end:agent_paused");

    const full = setup(undefined, undefined, new PapError("capacity"));
    const r3 = full.use(row());
    expect(await codeOf(full.vmLaunch.spawn(r3, launch(), hostInit(r3)))).toBe("capacity");
    expect(full.recorder.log.at(-1)).toBe("end:capacity");
  });

  it("opens nothing for a launch it refuses before any step, and uses the launch it is handed", async () => {
    const bed = setup();
    const r = bed.use(row({ id: "not-a-uuid", agentRole: "task" }));
    expect(await codeOf(bed.vmLaunch.spawn(r, launch({ role: "task" }), hostInit(r)))).toBe("bad_request");
    expect(bed.recorder.opened()).toBe(0);
    const r2 = bed.use(row());
    const given = bed.recorder.registry.open({ box: { kind: "agent", id: ID }, owner: "u1", for: "s1" });
    await bed.vmLaunch.spawn(r2, launch(), hostInit(r2), given);
    expect(bed.recorder.opened()).toBe(1);
  });
});

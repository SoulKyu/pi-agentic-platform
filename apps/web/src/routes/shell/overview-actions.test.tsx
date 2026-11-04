// @vitest-environment happy-dom
import type { OverviewBox, OverviewSnapshot } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { box, memberSnapshot, ownerSnapshot } from "../../features/overview/overview-fixtures.ts";
import { PROJECT_BOX } from "../../testing/launch-bed.ts";
import { setLocale } from "../../i18n/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { RpcError } from "../../runtime/index.ts";
import { useLaunchStore } from "../../stores/launch-store.ts";
import { alerts, button, click, hasButton, mount, settle, text } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { overviewActions } from "./overview-actions.tsx";

vi.mock("../../lib/report.ts", () => ({ reportClientIssue: vi.fn() }));
const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let bed: ReturnType<typeof fakeRuntime>;
beforeEach(() => {
  bed = fakeRuntime();
  current.runtime = bed.runtime;
});
afterEach(() => {
  setLocale("en");
  useLaunchStore.getState().reset();
});

const OWNER = ownerSnapshot({
  capacity: {
    role: "owner",
    memory: { usedMb: 9728, maxMb: 10240, full: false },
    workers: { used: 0, max: 6 },
    cost: { totalUsd: 0, membersUsd: 0, apiEquivalent: false },
    failures: null,
  },
}).capacity;
const MEMBER = memberSnapshot().capacity;

const show = (b: OverviewBox, capacity: OverviewSnapshot["capacity"] = OWNER) =>
  mount(<>{overviewActions(b, capacity)}</>);

const PROJECT = { kind: "project", id: PROJECT_BOX } as const;
const stopped = (patch: Partial<OverviewBox> = {}) =>
  box({ ref: PROJECT, name: "Alpha", state: "stopped", phase: "stopped", needMb: 2560, ...patch });
const dialog = () => document.body;

const launching = (stoppable: boolean) =>
  useLaunchStore.getState().apply({
    kind: "snapshot",
    launches: [{ id: "l1", box: PROJECT, for: "start", startedAt: 1, stoppable, steps: [] }],
    helpers: { active: 0, max: 4, waiting: 0 },
  });

describe("overviewActions: START", () => {
  it("a box that does not fit is disabled with the owner copy, described by it", async () => {
    const page = await show(stopped({ fits: false }));
    const start = button(page.container, "Start");
    expect(start.disabled).toBe(true);
    expect(text(page.container)).toContain(
      "Not enough memory: 2.5 GB needed, 0.5 GB free. Stop a box to start another.",
    );
    const reason = document.getElementById(start.getAttribute("aria-describedby") ?? "");
    expect(reason?.textContent).toContain("Not enough memory");
    await click(start);
    expect(bed.called("projects.startBox")).toHaveLength(0);
  });

  it("a member gets the shared-memory copy with no free figure", async () => {
    const page = await show(stopped({ fits: false }), MEMBER);
    expect(text(page.container)).toContain(
      "Not enough shared memory: this box needs 2.5 GB. Stop one of your boxes or try again later.",
    );
    expect(text(page.container)).not.toContain("free");
  });

  it("speaks French with a comma decimal", async () => {
    setLocale("fr");
    const page = await show(stopped({ fits: false }));
    expect(text(page.container)).toContain("2,5 Go demandés, 0,5 Go libres");
  });

  it("a box that fits starts with a command id", async () => {
    const page = await show(stopped());
    await click(button(page.container, "Start"));
    await settle();
    const [call] = bed.called("projects.startBox");
    expect(call?.params).toEqual({ projectId: PROJECT_BOX });
    expect(call?.options?.commandId).toMatch(/^bed-cmd-/);
  });

  it("an agent starts through agents.startBox", async () => {
    const page = await show(stopped({ ref: { kind: "agent", id: "atlas-1a2b" }, name: "Atlas" }));
    await click(button(page.container, "Start"));
    await settle();
    expect(bed.called("agents.startBox")[0]?.params).toEqual({ agentId: "atlas-1a2b" });
  });

  it("a host project has no action", async () => {
    const page = await show(stopped({ ref: { kind: "host", id: "h1" }, phase: null }));
    expect(page.container.querySelector("button")).toBeNull();
  });

  it("an unusable VM stack (owner memory null) shows no START and no memory reason", async () => {
    const owner = ownerSnapshot().capacity;
    if (owner.role !== "owner") throw new Error("fixture");
    const page = await show(stopped({ fits: false }), { ...owner, memory: null });
    expect(page.container.querySelector("button")).toBeNull();
    expect(text(page.container)).not.toContain("Not enough");
  });

  it("an unusable VM stack (member sharedPercent null) shows no START and no memory reason", async () => {
    const member = memberSnapshot().capacity;
    if (member.role !== "member") throw new Error("fixture");
    const page = await show(stopped({ fits: false }), { ...member, sharedPercent: null });
    expect(page.container.querySelector("button")).toBeNull();
    expect(text(page.container)).not.toContain("Not enough");
  });

  it("START is not a primary: the view has ANSWER for that", async () => {
    const page = await show(stopped());
    expect(button(page.container, "Start").getAttribute("data-variant")).toBe("secondary");
  });
});

describe("overviewActions: follow the phase", () => {
  it("a FAILED box whose box is stopped offers START", async () => {
    const page = await show(stopped({ state: "failed" }));
    await click(button(page.container, "Start"));
    await settle();
    expect(bed.called("projects.startBox")).toHaveLength(1);
  });

  it("a WAITING box whose box is stopped offers START", async () => {
    const page = await show(stopped({ state: "waiting" }));
    expect(hasButton(page.container, "Start")).toBe(true);
  });

  it("a paused project offers its restart, never STOP", async () => {
    const page = await show(box({ ref: PROJECT, state: "failed", phase: "paused" }));
    expect(hasButton(page.container, "Stop")).toBe(false);
    await click(button(page.container, "Restart box"));
    await settle();
    expect(bed.called("projects.restartBox")[0]?.params).toEqual({ projectId: PROJECT_BOX });
  });

  it("a paused agent has no button", async () => {
    const page = await show(box({ state: "failed", phase: "paused" }));
    expect(page.container.querySelector("button")).toBeNull();
  });

  it("a waiting box that runs keeps STOP", async () => {
    const page = await show(box({ ref: PROJECT, state: "waiting", phase: "running" }));
    expect(hasButton(page.container, "Stop")).toBe(true);
  });
});

describe("overviewActions: STOP", () => {
  const busy = (patch: Partial<OverviewBox> = {}) =>
    box({
      ref: PROJECT,
      name: "Alpha",
      busy: true,
      activities: [{ kind: "task", id: "t1", title: "Tidy", since: null, stoppable: true }],
      ...patch,
    });

  it("a busy box asks first: Cancel calls nothing, the confirm stops the project", async () => {
    const page = await show(busy());
    await click(button(page.container, "Stop"));
    expect(text(dialog())).toContain("Stop Alpha's box?");
    expect(text(dialog())).toContain("interrupted: Task · Tidy.");
    expect(bed.called("projects.stopBox")).toHaveLength(0);
    await click(button(dialog(), "Cancel"));
    expect(bed.called("projects.stopBox")).toHaveLength(0);
    await click(button(page.container, "Stop"));
    await click(button(dialog(), "Stop the box"));
    await settle();
    const [call] = bed.called("projects.stopBox");
    expect(call?.params).toEqual({ projectId: PROJECT_BOX });
    expect(call?.options?.commandId).toMatch(/^bed-cmd-/);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("a busy agent is stopped through agents.stopBox", async () => {
    const page = await show(busy({ ref: { kind: "agent", id: "atlas-1a2b" }, name: "Atlas" }));
    await click(button(page.container, "Stop"));
    await click(button(dialog(), "Stop the box"));
    await settle();
    expect(bed.called("agents.stopBox")[0]?.params).toEqual({ agentId: "atlas-1a2b" });
    expect(bed.called("projects.stopBox")).toHaveLength(0);
  });

  it("a box that is not busy stops at once, with no dialog", async () => {
    const page = await show(busy({ busy: false, activities: [] }));
    await click(button(page.container, "Stop"));
    await settle();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(bed.called("projects.stopBox")).toHaveLength(1);
  });

  it("a refused stop stays in the dialog as an action alert", async () => {
    bed.handlers["projects.stopBox"] = () => {
      throw new RpcError("not_found");
    };
    const page = await show(busy());
    await click(button(page.container, "Stop"));
    await click(button(dialog(), "Stop the box"));
    await settle();
    expect(alerts(dialog())).toHaveLength(1);
    expect(alerts(dialog())[0]).toContain("Nothing was changed");
    expect(hasButton(dialog(), "Stop the box")).toBe(true);
  });

  it("a refused immediate stop shows the alert under the button", async () => {
    bed.handlers["projects.stopBox"] = () => {
      throw new RpcError("not_found");
    };
    const page = await show(busy({ busy: false, activities: [] }));
    await click(button(page.container, "Stop"));
    await settle();
    expect(alerts(page.container)).toHaveLength(1);
  });

  it("a starting box stops its launch", async () => {
    launching(true);
    const page = await show(box({ ref: PROJECT, state: "starting", phase: "starting" }));
    await click(button(page.container, "Stop"));
    await settle();
    expect(bed.called("launches.stop")[0]?.params).toEqual({ id: "l1" });
    expect(bed.called("projects.stopBox")).toHaveLength(0);
  });

  it("a starting box whose launch is not stoppable has STOP disabled", async () => {
    launching(false);
    const page = await show(box({ ref: PROJECT, state: "starting", phase: "starting" }));
    expect(button(page.container, "Stop").disabled).toBe(true);
  });

  it("a starting box with no launch yet has STOP disabled", async () => {
    const page = await show(box({ ref: PROJECT, state: "starting", phase: "starting" }));
    expect(button(page.container, "Stop").disabled).toBe(true);
  });
});

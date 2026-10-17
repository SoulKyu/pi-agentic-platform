// @vitest-environment happy-dom
import { DEFAULT_HOME_LAYOUT } from "@pap/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { button, click, mount, settle } from "../../testing/dom.ts";
import { fakeHomeActions, SHORTCUTS } from "../../testing/home-actions.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { shellProject } from "../../testing/shell-snapshot.ts";
import { ActionRow } from "./ActionRow.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

beforeEach(() => {
  const bed = fakeRuntime("open");
  bed.handlers["files.list"] = () => ({ entries: [], truncated: false });
  current.runtime = bed.runtime;
});

describe("New agent on the home (M11R96, decision 85)", () => {
  it("is an action of the Automate group, and works with no project", async () => {
    const actions = fakeHomeActions();
    const page = await mount(
      <ActionRow project={null} layout={DEFAULT_HOME_LAYOUT} actions={actions} shortcuts={SHORTCUTS} />,
    );
    await settle();
    const action = button(page.container, "New agent");
    expect(action.closest("section")?.querySelector("h2")?.textContent).toBe("Automate");
    expect(action.disabled).toBe(false);
    await click(action);
    expect(actions.newAgent).toHaveBeenCalledOnce();
  });

  it("goes with its group when Automate is hidden", async () => {
    const actions = fakeHomeActions();
    const project = shellProject({ id: "p1", name: "api", root: "/w/api", sessions: 1 });
    const page = await mount(
      <ActionRow
        project={project}
        layout={{ ...DEFAULT_HOME_LAYOUT, automate: false }}
        actions={actions}
        shortcuts={SHORTCUTS}
      />,
    );
    await settle();
    expect(page.container.textContent).not.toContain("New agent");
  });
});

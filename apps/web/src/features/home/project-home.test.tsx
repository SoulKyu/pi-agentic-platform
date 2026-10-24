// @vitest-environment happy-dom
import { DEFAULT_HOME_LAYOUT } from "@pap/contracts";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { useCurrentProject } from "../../stores/current-project.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { boxProject } from "../../testing/box-fixtures.ts";
import { button, mount, settle } from "../../testing/dom.ts";
import { chip, resetHome, showHome } from "../../testing/home-bed.tsx";
import { fakeHomeActions, SHORTCUTS } from "../../testing/home-actions.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { shellSnapshot } from "../../testing/shell-snapshot.ts";
import { ActionRow } from "./ActionRow.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("./HomeBody.tsx", () => ({ default: () => null }));

let bed: ReturnType<typeof fakeRuntime>;
beforeAll(async () => {
  await import("./ProjectFacts.tsx");
});
beforeEach(() => {
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  bed.handlers["lanes.preview"] = () => ({ repo: true });
  resetHome("b1");
  useShellStore.getState().apply(shellSnapshot([], { projects: [boxProject("stopped")] }));
  useCurrentProject.setState({ projectId: "b1" });
});

const reasonOf = (node: HTMLElement) =>
  document.getElementById(node.getAttribute("aria-describedby") ?? "")?.textContent;

describe("a box project's page", () => {
  it("a box project has Lane and Fan-out off, and Terminal on", async () => {
    await showHome();
    // The host's git probe is never asked about a box root.
    expect(bed.called("lanes.preview")).toEqual([]);
    for (const mode of ["Lane", "Fan-out"]) {
      expect(chip(mode).getAttribute("aria-disabled")).toBe("true");
      expect(reasonOf(chip(mode))).toBe("Not available in a box yet.");
    }
    expect(chip("Session").getAttribute("aria-disabled")).toBeNull();

    const page = await mount(
      <ActionRow
        project={boxProject("running")}
        layout={DEFAULT_HOME_LAYOUT}
        actions={fakeHomeActions()}
        shortcuts={SHORTCUTS}
      />,
    );
    await settle();
    const terminal = button(page.container, "Terminal");
    expect(terminal.disabled).toBe(false);
    expect(button(page.container, "Files").disabled).toBe(false);
  });
});

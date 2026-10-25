// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { useLaunchStore } from "../../stores/launch-store.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { boxProject, boxView } from "../../testing/box-fixtures.ts";
import { button, click, mount, settle } from "../../testing/dom.ts";
import { launchAt, PROJECT_BOX } from "../../testing/launch-bed.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { shellSnapshot } from "../../testing/shell-snapshot.ts";
import { BoxFact } from "./BoxFact.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return {
    Link: (props: { to: string; children: ReactNode }) =>
      createElement("a", { href: props.to }, props.children),
    useNavigate: () => () => Promise.resolve(),
  };
});

const project = () => boxProject("starting", { id: PROJECT_BOX, root: "/boxes/p/project" });
const launching = () =>
  act(async () => {
    useLaunchStore.getState().apply({ kind: "launch", launch: launchAt("vm", Date.now() - 2000) });
  });

beforeEach(() => {
  useLaunchStore.getState().reset();
  useShellStore.getState().reset();
  useShellStore.getState().apply(shellSnapshot([], { projects: [project()] }));
});

describe("BoxFact launch progress", () => {
  it("BoxFact puts the strip on the phase chip's line", async () => {
    const bed = fakeRuntime("open");
    bed.handlers["projects.box"] = () => ({ box: boxView() });
    current.runtime = bed.runtime;
    const page = await mount(<BoxFact project={project()} onSettings={() => {}} />);
    await settle();
    await launching();
    const strip = page.container.querySelector("[data-launch-strip]") as HTMLElement;
    expect(strip.textContent).toBe("Starting the VM…");
    expect(strip.closest("[data-phase-row]")?.querySelector('[data-slot="chip"]')).not.toBeNull();
  });

  it("BoxFact opens and closes the full steps with a toggle", async () => {
    const bed = fakeRuntime("open");
    bed.handlers["projects.box"] = () => ({ box: boxView() });
    current.runtime = bed.runtime;
    const page = await mount(<BoxFact project={project()} onSettings={() => {}} />);
    await settle();
    expect(page.container.textContent).not.toContain("Show the steps");
    await launching();
    expect(page.container.querySelector("[data-launch-panel]")).toBeNull();
    const toggle = button(page.container, "Show the steps");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await click(toggle);
    await vi.waitFor(() => expect(page.container.querySelector("[data-launch-panel]")).not.toBeNull());
    expect(button(page.container, "Hide the steps").getAttribute("aria-expanded")).toBe("true");
    await click(button(page.container, "Hide the steps"));
    expect(page.container.querySelector("[data-launch-panel]")).toBeNull();
  });
});

// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { useLaunchStore } from "../../stores/launch-store.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { boxProject } from "../../testing/box-fixtures.ts";
import { launchAt, PROJECT_BOX } from "../../testing/launch-bed.ts";
import { screenBed } from "../../testing/screen-bed.tsx";
import { shellSnapshot } from "../../testing/shell-snapshot.ts";

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

const screen = screenBed(current);
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

describe("SessionScreen launch progress", () => {
  it("the session's status chip carries the strip while its box starts", async () => {
    const container = await screen.show({ status: "starting", cwd: "/boxes/p/project" });
    expect(container.querySelector("header [data-launch-strip]")).toBeNull();
    await launching();
    const strip = container.querySelector("header [data-launch-strip]");
    expect(strip?.textContent).toBe("Starting the VM…");
  });
});

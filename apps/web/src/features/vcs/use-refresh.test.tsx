// @vitest-environment happy-dom
import { TooltipProvider } from "@pap/ui";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { useVcsStore } from "../../stores/vcs-store.ts";
import { mount, settle } from "../../testing/dom.ts";
import { vcsFile, vcsStatus } from "../../testing/m8-fixtures.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { shellSession, shellSnapshot } from "../../testing/shell-snapshot.ts";
import { ChangesPane } from "./ChangesPane.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("@pap/ui/code", () => ({ DiffView: () => null, languageFor: () => null }));

let bed: ReturnType<typeof fakeRuntime>;
let clock = 0;
beforeEach(() => {
  clock = 10_000;
  useVcsStore.getState().reset();
  useShellStore.getState().reset();
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  useVcsStore
    .getState()
    .apply("/p", { kind: "snapshot", status: vcsStatus("/p", { files: [vcsFile("a.ts")] }) });
});

async function show() {
  await mount(
    <TooltipProvider>
      <ChangesPane root="/p" onOpenFile={() => {}} now={() => clock} />
    </TooltipProvider>,
  );
  await settle();
}
const refreshes = () => bed.called("vcs.refresh").length;
const setSessions = async (...sessions: Array<[id: string, cwd: string, status: "idle" | "running"]>) => {
  await act(async () => {
    useShellStore
      .getState()
      .apply(shellSnapshot(sessions.map(([id, cwd, status]) => shellSession({ id, cwd, status }))));
  });
  await settle();
};
const focus = async () => {
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
  await settle();
};

describe("refresh triggers", () => {
  it("refreshes once when a session under the root goes from running to idle", async () => {
    await setSessions(["s1", "/p/sub", "running"]);
    await show();
    expect(refreshes()).toBe(0);
    await setSessions(["s1", "/p/sub", "idle"]);
    expect(refreshes()).toBe(1);
    await setSessions(["s1", "/p/sub", "idle"]);
    expect(refreshes()).toBe(1);
  });

  it("ignores sessions outside the root, other transitions, and a session that starts idle", async () => {
    await setSessions(["s1", "/q", "running"], ["s2", "/pp", "running"], ["s3", "/p", "idle"]);
    await show();
    await setSessions(["s1", "/q", "idle"], ["s2", "/pp", "idle"], ["s3", "/p", "running"]);
    expect(refreshes()).toBe(0);
  });

  it("refreshes on window focus at most once a second", async () => {
    await show();
    await focus();
    expect(refreshes()).toBe(1);
    clock += 999;
    await focus();
    expect(refreshes()).toBe(1);
    clock += 1;
    await focus();
    expect(refreshes()).toBe(2);
  });

  it("stops listening when the pane closes", async () => {
    const page = await mount(
      <TooltipProvider>
        <ChangesPane root="/p" onOpenFile={() => {}} now={() => clock} />
      </TooltipProvider>,
    );
    await settle();
    await page.unmount();
    await focus();
    await setSessions(["s1", "/p", "running"]);
    await setSessions(["s1", "/p", "idle"]);
    expect(refreshes()).toBe(0);
  });
});

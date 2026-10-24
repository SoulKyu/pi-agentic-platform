// @vitest-environment happy-dom
import { DEFAULT_HOME_LAYOUT } from "@pap/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { useTerminalStore } from "../../stores/terminal-store.ts";
import { boxProject } from "../../testing/box-fixtures.ts";
import { button, click, mount, settle } from "../../testing/dom.ts";
import { fakeHomeActions, SHORTCUTS } from "../../testing/home-actions.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { shellSnapshot } from "../../testing/shell-snapshot.ts";
import { ActionRow } from "./ActionRow.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const TERMINAL = "B".repeat(22);
let bed: ReturnType<typeof fakeRuntime>;

beforeEach(() => {
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  bed.handlers["files.list"] = () => ({ entries: [], truncated: false });
  bed.handlers["terminal.create"] = () => ({ terminalId: TERMINAL });
  useShellStore.getState().reset();
  useTerminalStore.getState().reset();
  useShellStore.getState().apply(shellSnapshot([], { projects: [boxProject("running")] }));
});

describe("a box project's terminal", () => {
  it("a box project's terminal button is enabled and opens a terminal in the box folder", async () => {
    const actions = fakeHomeActions();
    const page = await mount(
      <ActionRow
        project={boxProject("running")}
        layout={DEFAULT_HOME_LAYOUT}
        actions={actions}
        shortcuts={SHORTCUTS}
      />,
    );
    await settle();
    const terminal = button(page.container, "Terminal");
    expect(terminal.disabled).toBe(false);
    expect(terminal.getAttribute("aria-describedby")).toBeNull();
    await click(terminal);
    await settle();
    expect(bed.called("terminal.create")[0]?.params).toMatchObject({ cwd: "/boxes/b1/project" });
    expect(actions.open).toHaveBeenCalledExactlyOnceWith({ kind: "terminal", id: TERMINAL });
  });
});

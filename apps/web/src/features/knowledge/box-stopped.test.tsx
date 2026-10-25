// @vitest-environment happy-dom
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { boxProject } from "../../testing/box-fixtures.ts";
import { button, click, mount, settle, text } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { shellSnapshot } from "../../testing/shell-snapshot.ts";
import { KnowledgeRow } from "./KnowledgeRow.tsx";
import { useKnowledgeStore } from "./knowledge-store.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let bed: ReturnType<typeof fakeRuntime>;
let running = false;
beforeEach(() => {
  running = false;
  bed = fakeRuntime("open");
  bed.handlers["projects.knowledge"] = () => {
    if (!running) throw new RpcError("box_stopped");
    return { enabled: true, concepts: 4 };
  };
  current.runtime = bed.runtime;
  useKnowledgeStore.setState({ versions: {}, pending: {}, origin: {} });
  useShellStore.getState().reset();
  useShellStore.getState().apply(shellSnapshot([], { projects: [boxProject("stopped")] }));
});

describe("the knowledge row of a stopped box", () => {
  it("shows the stopped copy with START, and reads again when the box runs", async () => {
    const page = await mount(<KnowledgeRow projectId="b1" />);
    await settle();
    expect(text(page.container)).toContain("The project's box is stopped. Start it to see its files.");
    await click(button(page.container, "Start"));
    expect(bed.called("projects.startBox")[0]?.params).toEqual({ projectId: "b1" });

    running = true;
    await act(async () => {
      useShellStore.getState().apply({ kind: "project", project: boxProject("running") });
    });
    await settle();
    expect(text(page.container)).toContain("OKF knowledge in knowledge/ · 4 concepts");
    expect(text(page.container)).not.toContain("is stopped");
  });
});

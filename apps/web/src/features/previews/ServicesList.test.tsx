// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { RpcError } from "../../runtime/rpc.ts";
import { usePreviewsStore } from "../../stores/previews-store.ts";
import { boxView } from "../../testing/box-fixtures.ts";
import { button, hasButton, mount } from "../../testing/dom.ts";
import { AGENT_BOX, PROJECT_BOX, PROJECT_ID, previewView } from "../../testing/previews-fixtures.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { ServicesList } from "./ServicesList.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let bed: ReturnType<typeof fakeRuntime>;
const settle = () => act(async () => {});
const declared = { command: "python3 -m http.server 8000", port: 8000 };

beforeEach(() => {
  bed = fakeRuntime();
  bed.handlers["projects.box"] = () => ({ box: boxView({ phase: "running", preview: declared }) });
  current.runtime = bed.runtime;
  usePreviewsStore.getState().reset();
  usePreviewsStore.getState().apply({ type: "snapshot", services: [previewView()] });
});
afterEach(() => vi.useRealTimers());

const project = { box: PROJECT_BOX, phase: "running" } as const;

describe("ServicesList", () => {
  it("chips carry words, and a failed service says why in a polite line", async () => {
    usePreviewsStore.getState().apply({
      type: "snapshot",
      services: [
        previewView(),
        previewView({ id: "b".repeat(32), name: "api", port: 3000, state: "failed", reason: "port_timeout" }),
        previewView({ id: "c".repeat(32), name: "old", state: "exited" }),
        previewView({ id: "d".repeat(32), name: "gone", state: "stopped" }),
      ],
    });
    const page = await mount(<ServicesList {...project} />);
    await settle();
    const chips = [...page.container.querySelectorAll("[data-tone]")].map((chip) => [
      chip.getAttribute("data-tone"),
      chip.textContent,
    ]);
    expect(chips).toEqual([
      ["err", "failed"],
      ["mut", "stopped"],
      ["mut", "ended by itself"],
      ["run", "running"],
    ]);
    expect(page.container.textContent).toContain("Nothing listened on port 3000 within 30 s.");
    expect(page.container.querySelector('[role="alert"]')).toBeNull();
  });

  it("shows the port and an uptime refreshed by the minute tick", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(1 + 5 * 60_000);
    const page = await mount(<ServicesList {...project} />);
    expect(page.container.textContent).toContain("port 8000");
    expect(page.container.textContent).toContain("up 5 min");
    await act(async () => {
      vi.setSystemTime(1 + 6 * 60_000);
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(page.container.textContent).toContain("up 7 min");
  });

  it("says nothing before the stream's first snapshot, and a quiet line when no service runs", async () => {
    usePreviewsStore.getState().reset();
    const page = await mount(<ServicesList box={AGENT_BOX} />);
    await settle();
    expect(page.container.querySelector("[data-services-list]")).toBeNull();
    act(() => usePreviewsStore.getState().apply({ type: "snapshot", services: [] }));
    expect(page.container.textContent).toContain("No preview runs in this box.");
  });

  it("lists only the services of its own box", async () => {
    usePreviewsStore
      .getState()
      .apply({ type: "snapshot", services: [previewView(), previewView({ box: AGENT_BOX, name: "other" })] });
    const page = await mount(<ServicesList {...project} />);
    await settle();
    expect(page.container.textContent).toContain("Preview web");
    expect(page.container.textContent).not.toContain("other");
  });

  it("STOP and RESTART call their methods with a command id", async () => {
    bed.handlers["previews.stop"] = () => ({});
    bed.handlers["previews.restart"] = () => ({ service: previewView() });
    const page = await mount(<ServicesList {...project} />);
    await settle();
    await act(async () => button(page.container, "Stop").click());
    await act(async () => button(page.container, "Restart").click());
    expect(bed.called("previews.stop")[0]?.params).toEqual({ box: PROJECT_BOX, name: "web" });
    expect(bed.called("previews.restart")[0]?.params).toEqual({ box: PROJECT_BOX, name: "web" });
    expect(bed.called("previews.stop")[0]?.options?.commandId).toMatch(/^bed-cmd-/);
  });

  it("a refused STOP says why", async () => {
    bed.handlers["previews.stop"] = () => {
      throw new RpcError("box_stopped");
    };
    const page = await mount(<ServicesList {...project} />);
    await settle();
    await act(async () => button(page.container, "Stop").click());
    expect(page.container.querySelector('[role="alert"]')?.textContent).toContain("box is stopped");
  });

  it("OPEN PREVIEW asks the shell to open the preview item and mints nothing itself", async () => {
    const page = await mount(<ServicesList {...project} />);
    await settle();
    await act(async () => button(page.container, "Open preview").click());
    expect(usePreviewsStore.getState().requested).toEqual({ box: `project:${PROJECT_ID}`, name: "web" });
    expect(bed.called("previews.open")).toHaveLength(0);
  });

  it("a service that does not run offers no OPEN PREVIEW and no STOP", async () => {
    usePreviewsStore.getState().apply({ type: "snapshot", services: [previewView({ state: "stopped" })] });
    const page = await mount(<ServicesList {...project} />);
    await settle();
    expect(button(page.container, "Open preview").disabled).toBe(true);
    expect(button(page.container, "Stop").disabled).toBe(true);
    expect(hasButton(page.container, "Restart")).toBe(true);
  });

  describe("the preview .pi/project.yaml declares", () => {
    beforeEach(() => usePreviewsStore.getState().apply({ type: "snapshot", services: [] }));

    it("shows the declared command as text, cut at 200 characters", async () => {
      const command = `<img src=x onerror=alert(1)> ${"a".repeat(300)}`;
      bed.handlers["projects.box"] = () => ({
        box: boxView({ phase: "running", preview: { command, port: 8000 } }),
      });
      const page = await mount(<ServicesList {...project} />);
      await settle();
      const shown = page.container.querySelector("code");
      expect(shown?.textContent).toBe(`${command.slice(0, 200)}…`);
      expect(shown?.textContent?.length).toBe(201);
      expect(page.container.querySelector("img")).toBeNull();
      expect(page.container.textContent).toContain("Preview in .pi/project.yaml · port 8000");
    });

    it("starts nothing by itself: START PREVIEW sends the shown command and port with a command id", async () => {
      bed.handlers["previews.startProject"] = () => ({ service: previewView({ name: "project" }) });
      const page = await mount(<ServicesList {...project} />);
      await settle();
      expect(bed.called("previews.startProject")).toHaveLength(0);
      await act(async () => button(page.container, "Start preview").click());
      const [call] = bed.called("previews.startProject");
      expect(call?.params).toEqual({ projectId: PROJECT_ID, ...declared });
      expect(call?.options?.commandId).toMatch(/^bed-cmd-/);
    });

    it("a declaration that changed re-reads the box and shows the new command with previews.changed", async () => {
      bed.handlers["previews.startProject"] = () => {
        throw new RpcError("conflict");
      };
      const page = await mount(<ServicesList {...project} />);
      await settle();
      bed.handlers["projects.box"] = () => ({
        box: boxView({ phase: "running", preview: { command: "node new.js", port: 9000 } }),
      });
      await act(async () => button(page.container, "Start preview").click());
      expect(page.container.textContent).toContain(
        "The preview in .pi/project.yaml changed. Check the new command, then start it.",
      );
      expect(page.container.querySelector("code")?.textContent).toBe("node new.js");
      expect(bed.called("previews.startProject")).toHaveLength(1);
    });

    it("an invalid declaration is said, with no button", async () => {
      bed.handlers["projects.box"] = () => ({
        box: boxView({ phase: "running", preview: null, previewInvalid: true }),
      });
      const page = await mount(<ServicesList {...project} />);
      await settle();
      expect(page.container.textContent).toContain("The preview in .pi/project.yaml is not valid.");
      expect(hasButton(page.container, "Start preview")).toBe(false);
    });

    it("a running project service hides the declaration", async () => {
      usePreviewsStore
        .getState()
        .apply({ type: "snapshot", services: [previewView({ name: "project", port: 8000 })] });
      const page = await mount(<ServicesList {...project} />);
      await settle();
      expect(hasButton(page.container, "Start preview")).toBe(false);
    });

    it("an agent's box reads no declaration", async () => {
      const page = await mount(<ServicesList box={AGENT_BOX} />);
      await settle();
      expect(bed.called("projects.box")).toHaveLength(0);
      expect(hasButton(page.container, "Start preview")).toBe(false);
    });
  });
});

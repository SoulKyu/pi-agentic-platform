// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PREVIEW_SANDBOX } from "@pap/ui";
import type { Runtime } from "../../runtime/index.ts";
import { RpcError } from "../../runtime/rpc.ts";
import { usePreviewsStore } from "../../stores/previews-store.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { boxProject, boxView } from "../../testing/box-fixtures.ts";
import { button, mount } from "../../testing/dom.ts";
import {
  AGENT_BOX,
  keepFramesUnloaded,
  previewView,
  PROJECT_BOX,
  PROJECT_ID,
} from "../../testing/previews-fixtures.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { shellSnapshot } from "../../testing/shell-snapshot.ts";
import { PreviewPane } from "./PreviewPane.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let bed: ReturnType<typeof fakeRuntime>;
const CAPABILITY = "https://p.example:7778/p/SECRETTOKEN/";

beforeEach(() => {
  keepFramesUnloaded();
  bed = fakeRuntime();
  bed.handlers["previews.open"] = () => ({ url: CAPABILITY, lease: "1".repeat(32), leaseMs: 300_000 });
  bed.handlers["previews.renew"] = () => ({ until: 1 });
  bed.handlers["previews.close"] = () => ({});
  bed.handlers["projects.box"] = () => ({ box: boxView({ phase: "running" }) });
  current.runtime = bed.runtime;
  usePreviewsStore.getState().reset();
  usePreviewsStore.getState().apply({ type: "snapshot", services: [previewView()] });
  useShellStore.getState().reset();
  useShellStore.getState().apply(
    shellSnapshot([], {
      projects: [boxProject("running", { id: PROJECT_ID, root: `/boxes/${PROJECT_ID}/project` })],
    }),
  );
});
afterEach(() => vi.restoreAllMocks());

const settle = () => act(async () => {});
const frame = (container: HTMLElement) => container.querySelector("iframe") as HTMLIFrameElement;
const props = { box: PROJECT_BOX, name: "web", onOpenAgent: () => {} };

describe("PreviewPane", () => {
  it("an armed pane frames the URL previews.open answered, sandboxed, under the untrusted label", async () => {
    const page = await mount(<PreviewPane {...props} armed />);
    await settle();
    expect(frame(page.container).getAttribute("src")).toBe(CAPABILITY);
    expect(frame(page.container).getAttribute("sandbox")).toBe(PREVIEW_SANDBOX);
    expect(page.container.querySelector("figcaption")?.textContent).toBe("UNTRUSTED · preview web");
    expect(page.container.textContent).toContain(
      "Logins that use cookies or an Authorization header do not work in a preview.",
    );
  });

  it("RELOAD loads the frame again from the same URL", async () => {
    const page = await mount(<PreviewPane {...props} armed />);
    await settle();
    const before = frame(page.container);
    await act(async () => button(page.container, "Reload").click());
    expect(frame(page.container)).not.toBe(before);
    expect(frame(page.container).getAttribute("src")).toBe(CAPABILITY);
    expect(bed.called("previews.open")).toHaveLength(1);
  });

  it("OPEN IN A NEW TAB opens pap's own window, never the capability URL", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const page = await mount(<PreviewPane {...props} armed />);
    await settle();
    await act(async () => button(page.container, "Open in a new tab").click());
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(`/preview/project:${PROJECT_ID}/web`, "_blank", "noopener");
    expect(JSON.stringify(open.mock.calls)).not.toContain("SECRETTOKEN");
  });

  it("LOGS opens the service's logs dialog", async () => {
    bed.handlers["previews.logs"] = () => ({ lines: ["listening on 8000"] });
    const page = await mount(<PreviewPane {...props} armed />);
    await settle();
    await act(async () => button(page.container, "Logs").click());
    await vi.waitFor(() => expect(document.body.textContent).toContain("listening on 8000"));
    expect(bed.called("previews.logs")[0]?.params).toEqual({ box: PROJECT_BOX, name: "web" });
    expect(document.body.textContent).toContain("Logs of web");
  });

  it("STOP stops the service", async () => {
    bed.handlers["previews.stop"] = () => ({});
    const page = await mount(<PreviewPane {...props} armed />);
    await settle();
    await act(async () => button(page.container, "Stop").click());
    expect(bed.called("previews.stop")[0]?.params).toEqual({ box: PROJECT_BOX, name: "web" });
  });

  it("a lost connection on renewal is said in words, the frame stays", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    bed.handlers["previews.renew"] = () => {
      throw new RpcError("connection_lost");
    };
    const page = await mount(<PreviewPane {...props} armed />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(page.container.querySelector('[role="status"]')?.textContent).toBeTruthy();
    expect(frame(page.container)).toBeTruthy();
  });

  it("a refused STOP says why", async () => {
    bed.handlers["previews.stop"] = () => {
      throw new RpcError("box_stopped");
    };
    const page = await mount(<PreviewPane {...props} armed />);
    await settle();
    await act(async () => button(page.container, "Stop").click());
    expect(page.container.querySelector('[role="alert"]')?.textContent).toContain("box is stopped");
  });

  it("a stopped box shows START and never starts it by itself", async () => {
    useShellStore
      .getState()
      .apply(shellSnapshot([], { projects: [boxProject("stopped", { id: PROJECT_ID })] }));
    const page = await mount(<PreviewPane {...props} armed={false} />);
    await settle();
    expect(page.container.textContent).toContain(
      "The box is stopped. Start it, then start the preview again.",
    );
    expect(button(page.container, "Start")).toBeTruthy();
    expect(bed.called("projects.startBox")).toHaveLength(0);
    expect(bed.called("previews.open")).toHaveLength(0);
    expect(page.container.querySelector("iframe")).toBeNull();
  });

  it("an agent's stopped VM says so and offers OPEN AGENT, never a start", async () => {
    bed.handlers["previews.open"] = () => {
      throw new RpcError("box_stopped");
    };
    const onOpenAgent = vi.fn();
    usePreviewsStore.getState().apply({ type: "snapshot", services: [previewView({ box: AGENT_BOX })] });
    const page = await mount(<PreviewPane box={AGENT_BOX} name="web" armed onOpenAgent={onOpenAgent} />);
    await settle();
    expect(page.container.textContent).toContain("The agent's VM is stopped.");
    await act(async () => button(page.container, "Open the agent").click());
    expect(onOpenAgent).toHaveBeenCalledWith("atlas-1a2b");
    expect(bed.called("agents.startBox")).toHaveLength(0);
  });

  it("a gone service shows previews.gone and no frame", async () => {
    usePreviewsStore.getState().apply({ type: "snapshot", services: [] });
    const page = await mount(<PreviewPane {...props} armed />);
    await settle();
    expect(page.container.textContent).toContain(
      "This preview is not running. Ask the agent to start it again.",
    );
    expect(page.container.querySelector("iframe")).toBeNull();
  });

  it("a restored pane shows notOpen and never calls previews.open until its OPEN PREVIEW is clicked", async () => {
    const page = await mount(<PreviewPane {...props} armed={false} />);
    await settle();
    expect(page.container.textContent).toContain("Open the preview to load the page.");
    expect(page.container.querySelector("iframe")).toBeNull();
    expect(bed.called("previews.open")).toHaveLength(0);
    await act(async () => button(page.container, "Open preview").click());
    expect(bed.called("previews.open")).toHaveLength(1);
    expect(frame(page.container).getAttribute("src")).toBe(CAPABILITY);
  });

  it("a restarted service loads nothing new and says so", async () => {
    const page = await mount(<PreviewPane {...props} armed />);
    await settle();
    act(() =>
      usePreviewsStore.getState().apply({ type: "service", service: previewView({ id: "c".repeat(32) }) }),
    );
    expect(page.container.textContent).toContain(
      "This preview restarted. Open it again to load the new page.",
    );
    expect(page.container.querySelector("iframe")).toBeNull();
    expect(bed.called("previews.open")).toHaveLength(1);
  });

  it("a refused open says why, in words", async () => {
    bed.handlers["previews.open"] = () => {
      throw new RpcError("unavailable");
    };
    const page = await mount(<PreviewPane {...props} armed />);
    await settle();
    expect(page.container.textContent).toContain("Previews are not available");
  });

  describe("a gone service of a project that declares a preview", () => {
    const declared = { command: "python3 -m http.server 8000", port: 8000 };
    beforeEach(() => {
      usePreviewsStore.getState().apply({ type: "snapshot", services: [] });
      bed.handlers["projects.box"] = () => ({ box: boxView({ phase: "running", preview: declared }) });
    });

    it("shows the declared command as text and starts it only on the click", async () => {
      bed.handlers["previews.startProject"] = () => ({ service: previewView() });
      const page = await mount(<PreviewPane {...props} armed={false} />);
      await settle();
      expect(page.container.textContent).toContain("Runs python3 -m http.server 8000");
      expect(bed.called("previews.startProject")).toHaveLength(0);
      await act(async () => button(page.container, "Start preview").click());
      expect(bed.called("previews.startProject")[0]?.params).toEqual({ projectId: PROJECT_ID, ...declared });
    });

    it("a declaration that changed since the page read it says so", async () => {
      bed.handlers["previews.startProject"] = () => {
        throw new RpcError("conflict");
      };
      const page = await mount(<PreviewPane {...props} armed={false} />);
      await settle();
      await act(async () => button(page.container, "Start preview").click());
      expect(page.container.textContent).toContain(
        "The preview in .pi/project.yaml changed. Check the new command, then start it.",
      );
    });
  });

  describe("recovery on an armed pane (UX2-R77: the owner opens with a click, never by itself)", () => {
    const stopped = () =>
      act(() => usePreviewsStore.getState().apply({ type: "removed", box: PROJECT_BOX, name: "web" }));
    const running = (patch = {}) =>
      act(() =>
        usePreviewsStore
          .getState()
          .apply({ type: "service", service: previewView({ id: "d".repeat(32), startedAt: 9, ...patch }) }),
      );

    it("the service stops, then the same name runs again: OPEN PREVIEW is offered and nothing mints until the click", async () => {
      const page = await mount(<PreviewPane {...props} armed />);
      await settle();
      stopped();
      expect(page.container.textContent).toContain("This preview is not running.");
      running();
      expect(page.container.textContent).toContain("Open the preview to load the page.");
      expect(page.container.textContent).not.toContain("This preview is not running.");
      expect(page.container.querySelector("iframe")).toBeNull();
      expect(bed.called("previews.open")).toHaveLength(1);
      await act(async () => button(page.container, "Open preview").click());
      expect(bed.called("previews.open")).toHaveLength(2);
      expect(frame(page.container).getAttribute("src")).toBe(CAPABILITY);
    });

    it("START PREVIEW clicked: once the service runs, OPEN PREVIEW is offered", async () => {
      bed.handlers["projects.box"] = () => ({
        box: boxView({ phase: "running", preview: { command: "serve", port: 8000 } }),
      });
      bed.handlers["previews.startProject"] = () => ({ service: previewView() });
      const page = await mount(<PreviewPane {...props} armed />);
      await settle();
      stopped();
      await settle();
      await act(async () => button(page.container, "Start preview").click());
      running();
      expect(button(page.container, "Open preview")).toBeTruthy();
      expect(bed.called("previews.open")).toHaveLength(1);
    });

    it("a refusal because the project box was stopped is gone once its phase is running", async () => {
      useShellStore
        .getState()
        .apply(shellSnapshot([], { projects: [boxProject("stopped", { id: PROJECT_ID })] }));
      bed.handlers["previews.open"] = () => {
        throw new RpcError("box_stopped");
      };
      const page = await mount(<PreviewPane {...props} armed />);
      await settle();
      expect(page.container.textContent).toContain("The box is stopped.");
      useShellStore
        .getState()
        .apply(shellSnapshot([], { projects: [boxProject("running", { id: PROJECT_ID })] }));
      await settle();
      expect(page.container.textContent).not.toContain("The box is stopped.");
      expect(page.container.textContent).not.toContain("box is stopped");
      expect(page.container.textContent).toContain("Open the preview to load the page.");
      expect(bed.called("previews.open")).toHaveLength(1);
    });

    it("a refusal because the agent's VM was stopped is gone once its service runs again", async () => {
      bed.handlers["previews.open"] = () => {
        throw new RpcError("box_stopped");
      };
      usePreviewsStore.getState().apply({ type: "snapshot", services: [previewView({ box: AGENT_BOX })] });
      const page = await mount(<PreviewPane box={AGENT_BOX} name="web" armed onOpenAgent={() => {}} />);
      await settle();
      expect(page.container.textContent).toContain("The agent's VM is stopped.");
      act(() =>
        usePreviewsStore.getState().apply({
          type: "service",
          service: previewView({ box: AGENT_BOX, id: "e".repeat(32), startedAt: 7 }),
        }),
      );
      expect(page.container.textContent).not.toContain("The agent's VM is stopped.");
      expect(page.container.textContent).toContain("Open the preview to load the page.");
    });
  });
});

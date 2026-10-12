// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { screenBed } from "../../testing/screen-bed.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return {
    Link: (props: { to: string; children: unknown }) =>
      createElement("a", { href: props.to }, props.children as never),
    useNavigate: () => vi.fn(),
  };
});

const screen = screenBed(current);
const approval = {
  id: "a1",
  method: "approval",
  title: "Run a command?",
  message: "1 line\nbash: ls",
  category: "exec",
  answers: ["deny", "once"],
};
const live = (container: HTMLElement) => container.querySelector("[data-announcer]");

describe("polite live regions (DESIGN §12)", () => {
  it("is one polite status region that starts empty", async () => {
    const container = await screen.show({ status: "idle" });
    expect(live(container)?.getAttribute("role")).toBe("status");
    expect(live(container)?.getAttribute("aria-live")).toBe("polite");
    expect(live(container)?.textContent).toBe("");
  });

  it("announces the end of a run, and again at the end of the next one", async () => {
    const container = await screen.show({ status: "idle" });
    await screen.emit({ kind: "status", status: "running" });
    expect(live(container)?.textContent).toBe("");
    await screen.emit({ kind: "status", status: "idle" });
    expect(live(container)?.textContent).toBe("The agent has finished.");
    await screen.emit({ kind: "status", status: "running" });
    expect(live(container)?.textContent).toBe("");
    await screen.emit({ kind: "status", status: "idle" });
    expect(live(container)?.textContent).toBe("The agent has finished.");
  });

  it("announces a new approval", async () => {
    const container = await screen.show({ status: "running" });
    await screen.emit({ kind: "dialog_open", dialog: approval });
    expect(live(container)?.textContent).toBe("The agent is waiting for your approval.");
  });

  it("does not announce an extension's dialog as an approval", async () => {
    const container = await screen.show({ status: "running" });
    await screen.emit({ kind: "dialog_open", dialog: { id: "i1", method: "input", title: "Name?" } });
    expect(live(container)?.textContent).toBe("");
  });
});

// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { useCurrentProject } from "../../stores/current-project.ts";
import { button, click, mount, settle } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { useWorkspaceStore } from "../workspace/index.ts";
import { KnowledgeChip } from "./KnowledgeChip.tsx";
import { useKnowledgeStore } from "./knowledge-store.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined, navigate: vi.fn() }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => current.navigate }));

let enabled = false;
let bed: ReturnType<typeof fakeRuntime>;
const chip = (status = "idle") => <KnowledgeChip projectId="p1" sessionId="s1" status={status} />;

beforeEach(() => {
  setLocale("en");
  enabled = false;
  bed = fakeRuntime("open");
  bed.handlers["projects.knowledge"] = () => ({ enabled, concepts: 0 });
  current.runtime = bed.runtime;
  current.navigate.mockReset();
  current.navigate.mockResolvedValue(undefined);
  useKnowledgeStore.setState({ versions: {}, pending: {}, origin: {} });
});

describe("KnowledgeChip", () => {
  it("asks with the project and the session and draws OKF in the ok tone", async () => {
    enabled = true;
    const page = await mount(chip());
    await settle();
    const drawn = page.container.querySelector("[data-slot=chip]");
    expect(drawn?.textContent).toBe("OKF");
    expect(drawn?.getAttribute("data-tone")).toBe("ok");
    expect(bed.called("projects.knowledge").map((call) => call.params)).toEqual([
      { projectId: "p1", sessionId: "s1" },
    ]);
  });

  it("draws NO OKF as a muted chip inside a button that opens the project home", async () => {
    const page = await mount(chip());
    await settle();
    const link = button(page.container, "Enable OKF for this project");
    expect(link.querySelector("[data-slot=chip]")?.getAttribute("data-tone")).toBe("mut");
    expect(link.textContent).toBe("No OKF");
    expect(link.className).toContain("focus-ring");
    expect(link.className).toContain("pointer-coarse:min-h-11");
    expect(link.className).toContain("pointer-coarse:min-w-11");
    await click(link);
    expect(useCurrentProject.getState().projectId).toBe("p1");
    expect(useWorkspaceStore.getState().ws.tabs.some((tab) => tab.item.kind === "home")).toBe(true);
    expect(current.navigate).toHaveBeenCalledWith({ to: "/" });
  });

  it("speaks French", async () => {
    setLocale("fr");
    const page = await mount(chip());
    await settle();
    expect(button(page.container, "Activer OKF pour ce projet").textContent).toBe("Sans OKF");
  });

  it("reads again after an enable here and says it applies from the next start, until the worker restarts", async () => {
    const page = await mount(chip("idle"));
    await settle();
    enabled = true;
    useKnowledgeStore.getState().bump("p1");
    await settle();
    const label = "OKF enabled; it applies from this session's next start";
    expect(page.container.querySelector(`[aria-label="${label}"]`)?.textContent).toBe("OKF");
    await page.rerender(chip("cold"));
    await page.rerender(chip("idle"));
    expect(page.container.querySelector(`[aria-label="${label}"]`)).toBeNull();
    expect(page.container.querySelector("[data-slot=chip]")?.textContent).toBe("OKF");
  });

  it("records the session before it navigates, so the project page and the pending label follow it", async () => {
    useShellStore.getState().apply({
      kind: "project",
      project: { id: "p1", root: "/work/app", name: "app", position: 1, sessions: 1 },
    });
    const page = await mount(
      <KnowledgeChip projectId="p1" sessionId="s1" status="idle" cwd="/work/app-lane" />,
    );
    await settle();
    await click(button(page.container, "Enable OKF for this project"));
    expect(useKnowledgeStore.getState().origin["p1"]).toEqual({ sessionId: "s1", live: true, lane: true });
    await page.unmount();
    // Back on the session: a new chip, no memory of the enable, still pending once the page marked it.
    enabled = true;
    useKnowledgeStore.getState().markPending("s1");
    const back = await mount(chip("idle"));
    await settle();
    expect(back.container.querySelector('[aria-label^="OKF enabled; it applies"]')).not.toBeNull();
  });

  it("records a session inside the project root as not a lane", async () => {
    useShellStore.getState().apply({
      kind: "project",
      project: { id: "p1", root: "/work/app", name: "app", position: 1, sessions: 1 },
    });
    const page = await mount(
      <KnowledgeChip projectId="p1" sessionId="s1" status="cold" cwd="/work/app/src" />,
    );
    await settle();
    await click(button(page.container, "Enable OKF for this project"));
    expect(useKnowledgeStore.getState().origin["p1"]).toEqual({ sessionId: "s1", live: false, lane: false });
  });
});

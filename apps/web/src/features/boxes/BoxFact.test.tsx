// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { boxProject, boxView } from "../../testing/box-fixtures.ts";
import { button, click, mount, settle, text } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { BoxFact } from "./BoxFact.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let bed: ReturnType<typeof fakeRuntime>;
const onSettings = vi.fn();
beforeEach(() => {
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  bed.handlers["projects.box"] = () => ({ box: boxView() });
  onSettings.mockReset();
});

const show = async (phase: "stopped" | "starting" | "running") => {
  const page = await mount(<BoxFact project={boxProject(phase)} onSettings={onSettings} />);
  await settle();
  return page.container.querySelector("[data-box-fact]") as HTMLElement;
};

describe("the box fact", () => {
  it("says BOX, STOPPED (neutral) and START, starts the box, and carries the no-backup note", async () => {
    const fact = await show("stopped");
    expect(text(fact)).toContain("Box");
    expect(text(fact)).toContain("Stopped");
    expect(text(fact)).toContain("This project's files live only in its box: push them to keep a copy.");
    expect(fact.querySelector('[data-tone="mut"]')).not.toBeNull();
    await click(button(fact, "Start"));
    expect(bed.called("projects.startBox")[0]?.params).toEqual({ projectId: "b1" });
  });

  it("disables START at once and shows the failed start in words", async () => {
    bed.handlers["projects.startBox"] = () => {
      throw new RpcError("internal");
    };
    const fact = await show("stopped");
    await click(button(fact, "Start"));
    await settle();
    expect(fact.querySelector('[data-slot="inline-error"][role="alert"]')).not.toBeNull();
    expect(text(fact)).toContain("Your files are intact.");
  });

  it("shows a starting box with START off", async () => {
    const fact = await show("starting");
    expect(text(fact)).toContain("Starting");
    expect(button(fact, "Start").disabled).toBe(true);
  });

  it("shows a running box without START, and PACKAGES CHANGED when the yaml wants other packages", async () => {
    bed.handlers["projects.box"] = () => ({
      box: boxView({ phase: "running", packages: { built: ["git"], wanted: ["git", "ripgrep"] } }),
    });
    const fact = await show("running");
    expect(text(fact)).toContain("Running");
    expect(text(fact)).toContain("Packages changed");
    expect(fact.querySelectorAll("button")).toHaveLength(1);
  });

  it("opens the settings of the project", async () => {
    const fact = await show("running");
    await click(button(fact, "Project settings"));
    expect(onSettings).toHaveBeenCalledExactlyOnceWith("b1");
  });

  it("says its words in French", async () => {
    const { setLocale } = await import("../../i18n/index.ts");
    setLocale("fr");
    const fact = await show("stopped");
    expect(text(fact)).toContain("Arrêtée");
    expect(button(fact, "Démarrer")).toBeDefined();
    setLocale("en");
  });

  it.each([
    ["capacity", "the server is at capacity. Your files are intact."],
    ["vm_bundle_stale", "its code is older than pap. Your files are intact. Run sudo pap vm setup"],
    ["agent_paused", "crashed 3 times in 10 minutes and is paused. Your files are intact."],
    ["sandbox_unavailable", "no microVM support set up. Your files are intact."],
  ] as const)("says a start refused with %s in three parts", async (code, words) => {
    bed.handlers["projects.startBox"] = () => {
      throw new RpcError(code);
    };
    const fact = await show("stopped");
    await click(button(fact, "Start"));
    await settle();
    expect(text(fact)).toContain(words);
    expect(fact.querySelector('[data-slot="inline-error"][role="alert"]')).not.toBeNull();
  });
});

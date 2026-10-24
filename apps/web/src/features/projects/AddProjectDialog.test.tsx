// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { alerts, button, click, field, mount, settle, text, typeInto } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { AddProjectDialog } from "./AddProjectDialog.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const created = { id: "p9", root: "/boxes/p9/project", name: "api", position: -3, kind: "box" as const };
let bed: ReturnType<typeof fakeRuntime>;
const onClose = vi.fn();
const onAdded = vi.fn();
const dialog = () => document.querySelector("[data-add-project]") as HTMLElement;
const open = () => mount(<AddProjectDialog onClose={onClose} onAdded={onAdded} />);

beforeEach(() => {
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  bed.handlers["projects.create"] = () => ({ project: created });
  useShellStore.getState().reset();
  onClose.mockReset();
  onAdded.mockReset();
});
afterEach(() => setLocale("en"));

describe("New project", () => {
  it("creates a project from a name", async () => {
    await open();
    expect(text(document.body)).toContain("New project");
    expect(text(dialog())).toContain("Its files live in its own box, not on this machine.");
    await typeInto(field(document.body, "Project name"), "  api  ");
    await click(button(document.body, "Create"));
    await settle();
    expect(bed.called("projects.create")[0]?.params).toEqual({ name: "api" });
    expect(useShellStore.getState().view.projects.get("p9")).toEqual({
      ...created,
      sessions: 0,
      unused: true,
    });
    expect(onAdded).toHaveBeenCalledExactlyOnceWith("p9");
  });

  it("refuses an empty name before any call", async () => {
    await open();
    await click(button(document.body, "Create"));
    await settle();
    expect(alerts(document.body)).toContain("Write a name for the project.");
    expect(bed.called("projects.create")).toEqual([]);
  });

  it.each([
    ["bad_request", "This name is not accepted. Nothing was created. Write another one."],
    ["capacity", "This account has 2000 projects, the most pap keeps."],
    ["read_only", "The database was written by a newer pap and is read-only."],
  ] as const)("says what %s means, inline, and creates nothing", async (code, words) => {
    bed.handlers["projects.create"] = () => {
      throw new RpcError(code);
    };
    await open();
    await typeInto(field(document.body, "Project name"), "api");
    await click(button(document.body, "Create"));
    await settle();
    expect(alerts(document.body)).toContain(words);
    expect(onAdded).not.toHaveBeenCalled();
    expect(useShellStore.getState().view.projects.size).toBe(0);
  });

  it("says its words in French", async () => {
    setLocale("fr");
    await open();
    expect(text(document.body)).toContain("Nouveau projet");
    expect(text(dialog())).toContain("Ses fichiers vivent dans sa propre box, pas sur cette machine.");
    await typeInto(field(document.body, "Nom du projet"), "api");
    await click(button(document.body, "Créer"));
    await settle();
    expect(onAdded).toHaveBeenCalledExactlyOnceWith("p9");
  });

  it("Cancel closes without creating", async () => {
    await open();
    await click(button(document.body, "Cancel"));
    expect(onClose).toHaveBeenCalledOnce();
    expect(bed.called("projects.create")).toEqual([]);
  });
});

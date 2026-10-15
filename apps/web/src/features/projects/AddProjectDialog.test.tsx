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

const added = { id: "p9", root: "/w/new", name: "new", position: -3 };
let bed: ReturnType<typeof fakeRuntime>;
const onClose = vi.fn();
const onAdded = vi.fn();
const dialog = () => document.querySelector("[data-add-project]") as HTMLElement;
const open = () => mount(<AddProjectDialog onClose={onClose} onAdded={onAdded} />);
async function check(path: string) {
  await typeInto(field(document.body, "Folder"), path);
  await click(button(document.body, "Check"));
  await settle();
}

beforeEach(() => {
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  bed.handlers["projects.add"] = () => ({ project: added });
  bed.handlers["lanes.preview"] = () => ({ repo: true });
  useShellStore.getState().reset();
  onClose.mockReset();
  onAdded.mockReset();
});
afterEach(() => setLocale("en"));

describe("Add project (§3.6)", () => {
  it("checks the folder, shows its project folder and that it is a git repository, then adds it", async () => {
    await open();
    expect(button(document.body, "Add").disabled).toBe(true);
    await check("  /w/new/src ");
    expect(bed.called("projects.add")[0]?.params).toEqual({ root: "/w/new/src" });
    expect(bed.called("lanes.preview")[0]?.params).toEqual({ projectRoot: "/w/new" });
    expect(text(dialog())).toContain("Project folder: /w/new");
    expect(text(dialog())).toContain("Git repository: lanes and fan-outs can start here.");
    expect(useShellStore.getState().view.projects.get("p9")).toEqual({ ...added, sessions: 0, unused: true });
    await click(button(document.body, "Add"));
    expect(onAdded).toHaveBeenCalledExactlyOnceWith("p9");
  });

  it("says when the folder is not a git repository, and when pap could not tell", async () => {
    bed.handlers["lanes.preview"] = () => ({ repo: false });
    await open();
    await check("/w/new");
    expect(text(dialog())).toContain("Not a git repository: sessions and triggers only.");
    bed.handlers["lanes.preview"] = () => {
      throw new RpcError("timeout");
    };
    await check("/w/new/");
    expect(text(dialog())).toContain("pap could not tell whether this folder is a git repository.");
  });

  it("refuses a path that is not absolute before any call", async () => {
    await open();
    await check("w/new");
    expect(alerts(document.body)).toContain("Write an absolute path, starting with /.");
    expect(bed.called("projects.add")).toEqual([]);
  });

  it.each([
    ["invalid_cwd", "No folder exists at this path, or pap cannot open it."],
    ["bad_request", "This folder is inside pap's or Pi's own data folder."],
    ["capacity", "This account has 2000 projects, the most pap keeps."],
    ["read_only", "The database was written by a newer pap and is read-only."],
    [
      "timeout",
      "The session did not answer in time. The action may still have gone through: check before trying again.",
    ],
  ] as const)("says what %s means, inline, and keeps Add off", async (code, words) => {
    bed.handlers["projects.add"] = () => {
      throw new RpcError(code);
    };
    await open();
    await check("/w/new");
    expect(alerts(document.body)).toContain(words);
    expect(button(document.body, "Add").disabled).toBe(true);
  });

  it("says the daemon's codes in French", async () => {
    setLocale("fr");
    bed.handlers["projects.add"] = () => {
      throw new RpcError("bad_request");
    };
    await open();
    await typeInto(field(document.body, "Dossier"), "/w/new");
    await click(button(document.body, "Vérifier"));
    await settle();
    expect(alerts(document.body)).toContain(
      "Ce dossier se trouve dans le dossier de données de pap ou de Pi.",
    );
  });

  it("forgets a check once the path changes", async () => {
    await open();
    await check("/w/new");
    await typeInto(field(document.body, "Folder"), "/w/other");
    expect(text(dialog())).not.toContain("Project folder:");
    expect(button(document.body, "Add").disabled).toBe(true);
  });

  it("Cancel closes without adding", async () => {
    await open();
    await click(button(document.body, "Cancel"));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onAdded).not.toHaveBeenCalled();
  });

  it("drops a check whose path was edited meanwhile: Add stays off, no project folder shown", async () => {
    const release: Array<() => void> = [];
    bed.handlers["projects.add"] = () =>
      new Promise((resolve) => release.push(() => resolve({ project: added })));
    await open();
    await typeInto(field(document.body, "Folder"), "/w/old");
    await click(button(document.body, "Check"));
    await typeInto(field(document.body, "Folder"), "/w/other");
    release.forEach((go) => go());
    await settle();
    expect(text(dialog())).not.toContain("Project folder:");
    expect(button(document.body, "Add").disabled).toBe(true);
    expect(bed.called("lanes.preview")).toEqual([]);
  });

  it("closing during a pending check works, and the late answer changes nothing but the stored project", async () => {
    const release: Array<() => void> = [];
    bed.handlers["projects.add"] = () =>
      new Promise((resolve) => release.push(() => resolve({ project: added })));
    const page = await open();
    await typeInto(field(document.body, "Folder"), "/w/new");
    await click(button(document.body, "Check"));
    await click(button(document.body, "Cancel"));
    expect(onClose).toHaveBeenCalledOnce();
    await page.unmount();
    release.forEach((go) => go());
    await settle();
    expect(bed.called("lanes.preview")).toEqual([]);
    expect(onAdded).not.toHaveBeenCalled();
    expect(useShellStore.getState().view.projects.get("p9")).toEqual({ ...added, sessions: 0, unused: true });
  });

  it("says why Add and Check are off, tied to the buttons by aria-describedby, in both languages", async () => {
    await open();
    const why = (name: string) => {
      const id = button(document.body, name).getAttribute("aria-describedby");
      return id === null ? null : document.getElementById(id)?.textContent;
    };
    expect(why("Check")).toBe("Type a folder path first.");
    expect(why("Add")).toBe("Check the folder first.");
    await typeInto(field(document.body, "Folder"), "/w/new");
    expect(button(document.body, "Check").getAttribute("aria-describedby")).toBeNull();
    await click(button(document.body, "Check"));
    await settle();
    expect(button(document.body, "Add").getAttribute("aria-describedby")).toBeNull();
  });

  it("says those reasons in French", async () => {
    setLocale("fr");
    await open();
    const why = (name: string) =>
      document.getElementById(button(document.body, name).getAttribute("aria-describedby") ?? "")
        ?.textContent;
    expect(why("Vérifier")).toBe("Saisissez d'abord le chemin d'un dossier.");
    expect(why("Ajouter")).toBe("Vérifiez d'abord le dossier.");
  });
});

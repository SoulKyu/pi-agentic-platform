// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
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

const created = { id: "p9", root: "/boxes/p9/project", name: "notes", position: -3, kind: "box" as const };
let bed: ReturnType<typeof fakeRuntime>;
const onAdded = vi.fn();
const open = () => mount(<AddProjectDialog onClose={vi.fn()} onAdded={onAdded} />);
const pickGithub = async () => {
  const tab = [...document.querySelectorAll("button")].find((node) => node.textContent === "From GitHub");
  await click(tab as HTMLButtonElement);
  await settle();
};

beforeEach(() => {
  setLocale("en");
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  bed.handlers["github.repositories"] = () => ({
    repositories: [
      { fullName: "octo/notes", private: true, defaultBranch: "main" },
      { fullName: "octo/site", private: false, defaultBranch: "main" },
    ],
  });
  bed.handlers["projects.createFromGithub"] = () => ({ project: created });
  useShellStore.getState().reset();
  onAdded.mockReset();
});

describe("New project from GitHub", () => {
  it("offers Empty and From GitHub, and lists the owner's repositories", async () => {
    await open();
    expect(text(document.body)).toContain("Empty");
    await pickGithub();
    expect(text(document.body)).toContain("owner/name, or pick one of yours.");
    expect(text(document.body)).toContain("octo/notes");
    expect(text(document.body)).toContain("PRIVATE");
    expect(bed.called("projects.create")).toEqual([]);
  });

  it("clone and fork call createFromGithub", async () => {
    await open();
    await pickGithub();
    await click(button(document.body, "octo/notes"));
    expect(field(document.body, "Repository").value).toBe("octo/notes");
    await click(button(document.body, "CLONE"));
    await settle();
    expect(bed.called("projects.createFromGithub")[0]?.params).toEqual({
      repository: "octo/notes",
      mode: "clone",
    });
    expect(onAdded).toHaveBeenCalledExactlyOnceWith("p9");
    expect(useShellStore.getState().view.projects.has("p9")).toBe(true);

    await typeInto(field(document.body, "Repository"), "upstream/lib");
    await click(button(document.body, "FORK"));
    await settle();
    expect(bed.called("projects.createFromGithub")[1]?.params).toEqual({
      repository: "upstream/lib",
      mode: "fork",
    });
  });

  it("refuses a repository that is not owner/name before any call", async () => {
    await open();
    await pickGithub();
    await typeInto(field(document.body, "Repository"), "../etc");
    await click(button(document.body, "CLONE"));
    expect(alerts(document.body)).toContain("Write the repository as owner/name.");
    expect(bed.called("projects.createFromGithub")).toEqual([]);
  });

  it("says that GitHub is not set up, with where to fix it", async () => {
    bed.handlers["github.repositories"] = () => {
      throw new RpcError("github_unavailable");
    };
    await open();
    await pickGithub();
    expect(text(document.body)).toContain(
      "GitHub is not set up for pap: create or reconnect the App in Settings › GitHub.",
    );
  });

  it("says its words in French", async () => {
    setLocale("fr");
    await open();
    const tab = [...document.querySelectorAll("button")].find((node) => node.textContent === "Depuis GitHub");
    await click(tab as HTMLButtonElement);
    await settle();
    expect(text(document.body)).toContain("propriétaire/nom, ou choisissez un des vôtres.");
    expect(button(document.body, "CLONER")).toBeDefined();
    expect(button(document.body, "FORKER")).toBeDefined();
  });
});

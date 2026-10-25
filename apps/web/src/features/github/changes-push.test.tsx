// @vitest-environment happy-dom
import { TooltipProvider } from "@pap/ui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { boxProject } from "../../testing/box-fixtures.ts";
import { button, click, field, hasButton, mount, settle, text, typeInto } from "../../testing/dom.ts";
import { githubView } from "../../testing/github-fixtures.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { shellProject, shellSnapshot } from "../../testing/shell-snapshot.ts";
import { PushBar } from "./PushBar.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let bed: ReturnType<typeof fakeRuntime>;
const ROOT = "/boxes/b1/project";
const bar = async (root = ROOT) => {
  const page = await mount(
    <TooltipProvider>
      <PushBar root={root} />
    </TooltipProvider>,
  );
  await settle();
  return page.container;
};
const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement;

async function openPr(title = "Add notes") {
  await click(button(document.body, "Open a pull request"));
  await typeInto(field(dialog(), "Title"), title);
  await click(button(dialog(), "Open a pull request"));
  await settle();
}

beforeEach(() => {
  setLocale("en");
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  bed.handlers["projects.github"] = () => ({ github: githubView() });
  useShellStore.getState().reset();
  useShellStore.getState().apply(
    shellSnapshot([], {
      projects: [boxProject("running"), shellProject({ id: "h1", name: "host", root: "/w/host" })],
    }),
  );
});

describe("the Changes panel's push bar", () => {
  it("commits and pushes with the message, once it is written", async () => {
    bed.handlers["projects.commitPush"] = () => ({ sha: "abc1234", branch: "pap/notes" });
    const container = await bar();
    await click(button(container, "Commit and push"));
    expect(text(container)).toContain("Write a commit message.");
    expect(bed.called("projects.commitPush")).toEqual([]);
    await typeInto(field(container, "Commit message"), "  Add notes  ");
    await click(button(container, "Commit and push"));
    await settle();
    expect(bed.called("projects.commitPush")[0]?.params).toEqual({ projectId: "b1", message: "Add notes" });
    expect(text(container)).toContain("Pushed pap/notes.");
  });

  it("says nothing was committed when there was nothing to commit", async () => {
    bed.handlers["projects.commitPush"] = () => ({ sha: null, branch: "main" });
    const container = await bar();
    await typeInto(field(container, "Commit message"), "x");
    await click(button(container, "Commit and push"));
    await settle();
    expect(text(container)).toContain("Nothing new to commit on main.");
  });

  it("a refused push says what happened and what is intact", async () => {
    bed.handlers["projects.commitPush"] = () => {
      throw new RpcError("box_stopped");
    };
    const container = await bar();
    await typeInto(field(container, "Commit message"), "x");
    await click(button(container, "Commit and push"));
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("stopped");
  });

  it("a pull request that GitHub created says its number and links to it", async () => {
    bed.handlers["projects.prCreate"] = () => ({
      kind: "created",
      number: 9,
      url: "https://github.com/octo/notes/pull/9",
    });
    await bar();
    await openPr();
    expect(bed.called("projects.prCreate")[0]?.params).toEqual({
      projectId: "b1",
      title: "Add notes",
      body: "",
    });
    expect(text(dialog())).toContain("Pull request #9 created.");
    expect(dialog().querySelector("a")?.getAttribute("href")).toBe("https://github.com/octo/notes/pull/9");
  });

  it("a fork opens the compare page", async () => {
    bed.handlers["projects.github"] = () => ({
      github: githubView({ link: { repository: "me/notes", upstream: "octo/notes", fork: true } }),
    });
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    bed.handlers["projects.prCreate"] = () => ({
      kind: "compare",
      url: "https://github.com/octo/notes/compare/main...me:notes:pap",
    });
    const container = await bar();
    expect(text(container)).toContain("GitHub opens its compare page: create the pull request there.");
    await openPr();
    const link = dialog().querySelector("a") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://github.com/octo/notes/compare/main...me:notes:pap");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it.each([
    "http://evil.test/x",
    "https://evil.test/x",
    "https://github.com.evil.test/",
    "http://github.com/o/r/pull/1",
    "javascript:alert(1)",
    "data:text/html,x",
  ])("never links to %s, and says why", async (url) => {
    bed.handlers["projects.prCreate"] = () => ({ kind: "compare", url });
    await bar();
    await openPr();
    expect(dialog().querySelector("a")).toBeNull();
    expect(text(dialog())).toContain("GitHub is not set up for pap");
  });

  it("asks for a title before any call", async () => {
    await bar();
    await click(button(document.body, "Open a pull request"));
    await click(button(dialog(), "Open a pull request"));
    expect(text(dialog())).toContain("Write a title for the pull request.");
    expect(bed.called("projects.prCreate")).toEqual([]);
  });

  it("shows nothing for a host folder or an unlinked project", async () => {
    expect(hasButton(await bar("/w/host"), "Commit and push")).toBe(false);
    expect(bed.called("projects.github")).toEqual([]);
    bed.handlers["projects.github"] = () => ({ github: githubView({ link: null }) });
    expect(hasButton(await bar(), "Commit and push")).toBe(false);
  });
});

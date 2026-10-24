// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { button, click, field, hasButton, mount, settle, text, typeInto } from "../../testing/dom.ts";
import { githubView } from "../../testing/github-fixtures.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { ProjectGithubSettings } from "./ProjectGithubSettings.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let bed: ReturnType<typeof fakeRuntime>;
const show = async () => {
  const page = await mount(<ProjectGithubSettings projectId="b1" />);
  await settle();
  return page.container;
};

beforeEach(() => {
  setLocale("en");
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  bed.handlers["github.repositories"] = () => ({ repositories: [] });
});

describe("project settings › GitHub", () => {
  it("links a repository that is typed", async () => {
    bed.handlers["projects.github"] = () => ({ github: githubView({ link: null, key: "absent" }) });
    bed.handlers["projects.linkGithub"] = () => ({ github: githubView() });
    const container = await show();
    expect(text(container)).toContain("This project is not linked to a repository.");
    await click(button(container, "LINK"));
    expect(text(container)).toContain("Write the repository as owner/name.");
    await typeInto(field(container, "Repository"), "octo/notes");
    await click(button(container, "LINK"));
    await settle();
    expect(bed.called("projects.linkGithub")[0]?.params).toEqual({
      projectId: "b1",
      repository: "octo/notes",
    });
    expect(text(container)).toContain("Linked to octo/notes.");
    expect(text(container)).toContain("KEY ADDED");
  });

  it("unlinks with a danger button and shows the key's state in words", async () => {
    bed.handlers["projects.github"] = () => ({ github: githubView({ key: "failed" }) });
    const container = await show();
    expect(text(container)).toContain("KEY FAILED");
    expect(text(container)).toContain("pap could not add the signing key on GitHub");
    const unlink = button(container, "UNLINK");
    expect(unlink.className).toContain("border-err");
    await click(unlink);
    await settle();
    expect(bed.called("projects.unlinkGithub")[0]?.params).toEqual({ projectId: "b1" });
  });

  it("a repository GitHub does not know says so without blaming the project", async () => {
    bed.handlers["projects.github"] = () => ({ github: githubView({ link: null, key: "absent" }) });
    bed.handlers["projects.linkGithub"] = () => {
      throw new RpcError("not_found");
    };
    const container = await show();
    await typeInto(field(container, "Repository"), "octo/missing");
    await click(button(container, "LINK"));
    await settle();
    expect(text(container)).toContain("GitHub does not know this repository");
    expect(hasButton(container, "UNLINK")).toBe(false);
  });
});

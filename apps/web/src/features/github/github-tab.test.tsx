// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { button, click, hasButton, mount, settle, text } from "../../testing/dom.ts";
import { githubView } from "../../testing/github-fixtures.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { GithubHomeEntry } from "./GithubHomeEntry.tsx";
import { GithubTab } from "./GithubTab.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let bed: ReturnType<typeof fakeRuntime>;
const onOpenSession = vi.fn();
const tab = async (github = githubView()) =>
  (
    await mount(
      <GithubTab projectId="b1" github={github} onRefresh={vi.fn()} onOpenSession={onOpenSession} />,
    )
  ).container;
const BAD_LOG = "<script>alert(1)</script>\n[x](javascript:alert(2)) https://evil.test";

beforeEach(() => {
  setLocale("en");
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  bed.handlers["projects.checkLog"] = () => ({ text: BAD_LOG, truncated: true });
  bed.handlers["projects.sendToSession"] = () => ({ sessionId: "s7" });
  onOpenSession.mockReset();
});

describe("the project's GitHub tab", () => {
  it("lists pull requests with check chips that carry a word", async () => {
    const container = await tab();
    const body = text(container);
    for (const words of ["Pull requests", "Issues", "Releases", "#7", "by hubot", "Passing", "Failing"])
      expect(body).toContain(words);
    expect(body).toContain("v1.0.0");
    const tones = [...container.querySelectorAll('[data-slot="chip"]')].map((chip) =>
      chip.getAttribute("data-tone"),
    );
    expect(tones).toEqual(["ok", "err"]);
  });

  it("a failed check opens its log fenced", async () => {
    const container = await tab();
    expect(container.querySelector('[data-slot="fence"]')).toBeNull();
    await click(button(container, "Show log"));
    await settle();
    expect(bed.called("projects.checkLog")[0]?.params).toEqual({ projectId: "b1", checkId: "c2" });
    const fence = container.querySelector('[data-slot="fence"]') as HTMLElement;
    expect(fence.querySelector("figcaption")?.textContent).toBe("UNTRUSTED · github log");
    expect(fence.textContent).toContain(BAD_LOG);
    expect(text(container)).toContain("The log is cut: only its end shows.");
    await click(button(container, "Hide log"));
    expect(container.querySelector('[data-slot="fence"]')).toBeNull();
  });

  it("GitHub text is never HTML", async () => {
    const container = await tab();
    await click(button(container, "Show log"));
    await settle();
    expect(container.querySelector("script, img, b, a, strong, em")).toBeNull();
    expect(text(container)).toContain("Fix <b>the</b> build");
    expect(text(container)).toContain("test <img src=x onerror=alert(1)>");
    expect(text(container)).toContain("Crash on **start**");
  });

  it("send to a session calls sendToSession for a check and for an issue, then opens the session", async () => {
    const container = await tab();
    const sends = [...container.querySelectorAll("button")].filter(
      (node) => node.textContent === "Send to a session",
    );
    expect(sends).toHaveLength(2);
    await click(sends[0] as HTMLButtonElement);
    await settle();
    expect(bed.called("projects.sendToSession")[0]?.params).toEqual({
      projectId: "b1",
      source: { kind: "check", checkId: "c2" },
    });
    expect(onOpenSession).toHaveBeenCalledExactlyOnceWith("s7");
    await click(sends[1] as HTMLButtonElement);
    await settle();
    expect(bed.called("projects.sendToSession")[1]?.params).toEqual({
      projectId: "b1",
      source: { kind: "issue", number: 12 },
    });
  });

  it("a refused send says why and opens nothing", async () => {
    bed.handlers["projects.sendToSession"] = () => {
      throw new RpcError("github_unavailable");
    };
    const container = await tab();
    await click(
      [...container.querySelectorAll("button")].filter(
        (node) => node.textContent === "Send to a session",
      )[1] as HTMLButtonElement,
    );
    await settle();
    expect(text(container)).toContain("GitHub is not set up for pap");
    expect(onOpenSession).not.toHaveBeenCalled();
  });
});

describe("the GitHub part of the project page", () => {
  const entry = async () => {
    const page = await mount(<GithubHomeEntry projectId="b1" onOpenSession={onOpenSession} />);
    await settle();
    return page.container;
  };

  it("shows the tab only for a linked project, behind its disclosure", async () => {
    bed.handlers["projects.github"] = () => ({ github: githubView() });
    const container = await entry();
    expect(container.querySelector("[data-github-tab]")).toBeNull();
    await click(button(container, "octo/notes"));
    expect(container.querySelector("[data-github-tab]")).not.toBeNull();
  });

  it("shows nothing for a project without a link or a clone", async () => {
    bed.handlers["projects.github"] = () => ({
      github: githubView({ link: null, clone: null, pulls: [], issues: [], releases: [] }),
    });
    expect((await entry()).textContent).toBe("");
  });

  it("shows nothing when GitHub is not set up", async () => {
    bed.handlers["projects.github"] = () => {
      throw new RpcError("github_unavailable");
    };
    expect((await entry()).textContent).toBe("");
  });

  it("a failed clone says why, that the project is intact, and RETRY clones again", async () => {
    bed.handlers["projects.github"] = () => ({
      github: githubView({ clone: { state: "failed", error: "auth" } }),
    });
    const container = await entry();
    expect(text(container)).toContain(
      "The clone of octo/notes failed: GitHub refused the access. The project is intact and empty.",
    );
    await click(button(container, "Retry"));
    await settle();
    expect(bed.called("projects.cloneAgain")[0]?.params).toEqual({ projectId: "b1" });
    expect(bed.called("projects.github")).toHaveLength(2);
  });

  it("says nothing of a clone whose repository is unknown", async () => {
    bed.handlers["projects.github"] = () => ({
      github: githubView({ link: null, clone: { state: "failed", error: "auth" } }),
    });
    expect((await entry()).textContent).toBe("");
  });

  it("a clone that runs shows a neutral-work chip, not an error", async () => {
    bed.handlers["projects.github"] = () => ({
      github: githubView({ clone: { state: "pending", error: null } }),
    });
    const container = await entry();
    expect(text(container)).toContain("Cloning octo/notes…");
    expect(hasButton(container, "Retry")).toBe(false);
  });
});

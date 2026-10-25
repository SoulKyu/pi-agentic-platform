// @vitest-environment happy-dom
import { DEFAULT_HOME_LAYOUT } from "@pap/contracts";
import { act } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { useComposerPrefill } from "../../stores/composer-prefill.ts";
import { useCurrentProject } from "../../stores/current-project.ts";
import { alerts, button, click, settle, typeInto } from "../../testing/dom.ts";
import { composer, resetHome, showHome } from "../../testing/home-bed.tsx";
import { fakeRuntime } from "../../testing/runtime-bed.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
const body = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
vi.mock("./HomeBody.tsx", () => ({
  default: (props: Record<string, unknown>) => {
    body.props = props;
    return null;
  },
}));

let bed: ReturnType<typeof fakeRuntime>;
const runtime = (state: "open" | "waiting" = "open") => {
  bed = fakeRuntime(state);
  current.runtime = bed.runtime;
  bed.handlers["lanes.preview"] = () => ({ repo: true });
  bed.handlers["sessions.create"] = () => ({ sessionId: "new-1" });
  bed.handlers["sessions.prompt"] = () => ({ disposition: "started" });
};
// The launch is a lazy chunk: its first transform is paid here, not inside a test.
beforeAll(async () => {
  await import("./run-launch.ts");
});
beforeEach(() => {
  runtime();
  useComposerPrefill.setState({ items: {} });
  resetHome();
});

describe("ProjectHome: the composer and a Session launch (§3.1)", () => {
  it("renders the lazy body under the composer with the project and the Settings › Home layout", async () => {
    await showHome();
    await vi.waitFor(() => expect(body.props).not.toBeNull(), { timeout: 2_000 });
    expect(body.props).toMatchObject({ project: { id: "p1" }, layout: DEFAULT_HOME_LAYOUT });
  });

  it("comes first: the composer has the focus, and the page names the project", async () => {
    const { page } = await showHome();
    expect(document.activeElement).toBe(composer());
    expect(composer().getAttribute("placeholder")).toBe("Fix the flaky login test, then open a PR");
    expect(page.container.querySelector("h1")?.textContent).toBe("api");
  });

  it("creates the session in the project's root with the preset, sends the text first, and opens it", async () => {
    const { page, actions } = await showHome(undefined, "read-only");
    await typeInto(composer(), "  Fix the login  ");
    await click(button(page.container, "Launch a session"));
    await settle();
    expect(bed.called("sessions.create")[0]?.params).toEqual({ cwd: "/w/api", preset: "read-only" });
    expect(bed.called("sessions.prompt")[0]?.params).toEqual({ sessionId: "new-1", text: "Fix the login" });
    expect(actions.open).toHaveBeenCalledExactlyOnceWith({ kind: "session", id: "new-1" });
  });

  it("opens an empty session for an empty launch, as the old home did", async () => {
    const { page, actions } = await showHome();
    await click(button(page.container, "Launch a session"));
    await settle();
    expect(bed.called("sessions.create")).toHaveLength(1);
    expect(bed.called("sessions.prompt")).toEqual([]);
    expect(actions.open).toHaveBeenCalledExactlyOnceWith({ kind: "session", id: "new-1" });
  });

  it.each(["prompt_rejected", "timeout"] as const)(
    "keeps the text in the new session's composer when the first message does not go (%s, Review Focus 1)",
    async (code) => {
      bed.handlers["sessions.prompt"] = () => {
        throw new RpcError(code);
      };
      const { page, actions } = await showHome();
      await typeInto(composer(), "Fix the login");
      await click(button(page.container, "Launch a session"));
      await settle();
      expect(actions.open).toHaveBeenCalledExactlyOnceWith({ kind: "session", id: "new-1" });
      expect(useComposerPrefill.getState().take("new-1")).toBe("Fix the login");
    },
  );

  it("shows the server's refusal of the folder and stays", async () => {
    bed.handlers["sessions.create"] = () => {
      throw new RpcError("invalid_cwd");
    };
    const { page, actions } = await showHome();
    await click(button(page.container, "Launch a session"));
    await settle();
    expect(alerts(page.container)).toEqual([
      "The working directory must be an absolute path to an existing folder.",
    ]);
    expect(actions.open).not.toHaveBeenCalled();
  });

  it("says a create whose outcome is unknown may have gone through, and does not send it again (R105)", async () => {
    bed.handlers["sessions.create"] = () => {
      throw new RpcError("timeout");
    };
    const { page } = await showHome();
    await click(button(page.container, "Launch a session"));
    await settle();
    expect(alerts(page.container)[0]).toContain("may still have gone through");
    expect(bed.called("sessions.create")).toHaveLength(1);
  });

  it("cannot launch while the connection is not open", async () => {
    runtime("waiting");
    const { page } = await showHome();
    expect(button(page.container, "Launch a session").disabled).toBe(true);
  });

  it("shows the tool preset under Session options, and only in Session mode", async () => {
    const { page } = await showHome();
    expect(document.querySelector("[data-preset-field]")).toBeNull();
    await click(button(page.container, "Session options"));
    expect(document.querySelector("[data-preset-field]")?.getAttribute("data-preset-field")).toBe("false");
  });

  it("New session here is an explicit action: Session mode, the composer focused", async () => {
    localStorage.setItem("pap.home.mode.v1", "trigger");
    const { page } = await showHome();
    button(page.container, "Launch a trigger").focus();
    await act(async () => useCurrentProject.getState().startHere("p1"));
    expect(button(page.container, "Launch a session")).toBeDefined();
    expect(document.activeElement).toBe(composer());
  });
});

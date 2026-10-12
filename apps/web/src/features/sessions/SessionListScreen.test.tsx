// @vitest-environment happy-dom
import type { ShellSession } from "@pap/contracts";
import { act, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import {
  alerts,
  button,
  click,
  field,
  mount,
  settle,
  text,
  typeInto,
  type Mounted,
} from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { shellProject, shellSession, shellSnapshot } from "../../testing/shell-snapshot.ts";
import { useCurrentProject } from "../../stores/current-project.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { SessionListScreen } from "./SessionListScreen.tsx";

const current = vi.hoisted(() => ({
  runtime: undefined as Runtime | undefined,
  navigate: vi.fn(),
  runCommand: vi.fn(),
}));
vi.mock("../../lib/command-registry.ts", () => ({ runCommand: current.runCommand }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return {
    useNavigate: () => current.navigate,
    Link: (props: { to: string; params: { sessionId: string }; children: ReactNode }) =>
      createElement("a", { href: props.to.replace("$sessionId", props.params.sessionId) }, props.children),
  };
});

let bed: ReturnType<typeof fakeRuntime>;
let page: Mounted | null = null;

const listed = (...sessions: ShellSession[]) => useShellStore.getState().apply(shellSnapshot(sessions));
const loadedEmpty = () => listed();

async function show(state: "open" | "waiting" = "open") {
  bed = fakeRuntime(state);
  current.runtime = bed.runtime;
  page = await mount(<SessionListScreen />);
  await settle();
  return page.container;
}

beforeEach(() => {
  useShellStore.getState().reset();
  current.navigate.mockReset();
  current.runCommand.mockReset();
  useCurrentProject.setState({ projectId: null, storageRefused: false });
});
afterEach(async () => {
  await page?.unmount();
  page = null;
});

describe("SessionListScreen", () => {
  it("lists the sessions of the store, the most recently used first, each linking to its screen", async () => {
    listed(
      shellSession({ id: "a", cwd: "/work/old", updatedAt: 10 }),
      shellSession({ id: "b", cwd: "/work/new", updatedAt: 20, status: "running" }),
    );
    const container = await show();
    const links = [...container.querySelectorAll("a")];
    expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["new", "/s/b"],
      ["old", "/s/a"],
    ]);
    expect(text(container)).toContain("Working");
    expect(bed.called("sessions.list")).toEqual([]);
  });

  it("shows the name as the link and the folder below it, and a name that looks like markup as text only", async () => {
    listed(
      shellSession({ id: "a", cwd: "/work/a", updatedAt: 20, name: "Fix login" }),
      shellSession({ id: "b", cwd: "/work/b", updatedAt: 10, name: "<b>x</b>" }),
    );
    const container = await show();
    const links = [...container.querySelectorAll("a")];
    expect(links.map((link) => link.textContent)).toEqual(["Fix login", "<b>x</b>"]);
    expect(container.querySelector("b")).toBeNull();
    expect(text(container)).toContain("/work/a");
    expect(text(container)).toContain("/work/b");
  });

  it("labels an unnamed session with the start of its first message, else its folder, and shows the path below", async () => {
    listed(
      shellSession({ id: "a", cwd: "/work/a", updatedAt: 20, preview: "fix the tests" }),
      shellSession({ id: "b", cwd: "/work/b", updatedAt: 10 }),
    );
    const container = await show();
    expect([...container.querySelectorAll("a")].map((link) => link.textContent)).toEqual([
      "fix the tests",
      "b",
    ]);
    expect(text(container)).toContain("/work/a");
    expect(text(container)).toContain("/work/b");
  });

  it("shows the 10 newest sessions that are not archived", async () => {
    listed(
      ...Array.from({ length: 60 }, (_, i) =>
        shellSession({ id: `s${i}`, cwd: `/w/${i}`, updatedAt: i + 1 }),
      ),
      shellSession({ id: "gone", cwd: "/w/gone", updatedAt: 1000, archivedAt: 5 }),
    );
    const container = await show();
    const hrefs = [...container.querySelectorAll("a")].map((link) => link.getAttribute("href"));
    expect(hrefs).toHaveLength(10);
    expect(hrefs[0]).toBe("/s/s59");
    expect(hrefs.at(-1)).toBe("/s/s50");
  });

  it("follows the stream: a session that arrives as an event appears", async () => {
    listed(shellSession({ id: "a", cwd: "/work/a" }));
    const container = await show();
    await act(async () =>
      useShellStore
        .getState()
        .apply({ kind: "session", session: shellSession({ id: "n", cwd: "/work/n", updatedAt: 9 }) }),
    );
    expect([...container.querySelectorAll("a")].map((link) => link.textContent)).toEqual(["n", "a"]);
  });

  it("says there is no session yet once the stream has said so", async () => {
    loadedEmpty();
    const container = await show();
    expect(text(container)).toContain("No session yet.");
    expect(container.querySelector("h1")?.textContent).toBe("Sessions");
  });

  it("shows loading, not an empty list, until the shell stream has loaded", async () => {
    const container = await show();
    expect(text(container)).toContain("Loading sessions");
    expect(text(container)).not.toContain("No session yet.");
  });

  it.each([
    ["refused", () => useShellStore.getState().fail("capacity")],
    ["unreadable", () => useShellStore.getState().apply({ kind: "snapshot" })],
  ])("a %s shell stream shows the error and a Retry that asks the stream again", async (_name, break_) => {
    break_();
    const container = await show();
    expect(text(container)).toContain("The session list did not load.");
    expect(text(container)).not.toContain("No session yet.");
    const resync = vi.spyOn(bed.runtime.subscriptions, "resync");
    await click(button(container, "Retry"));
    expect(resync).toHaveBeenCalledExactlyOnceWith("shell", "me");
  });

  it("creates a session in the trimmed directory and opens it", async () => {
    const container = await show();
    expect(button(container, "New session").disabled).toBe(true);
    bed.handlers["sessions.create"] = () => ({ sessionId: "new-1" });
    await typeInto(field(container, "Working directory"), "  /work/project  ");
    await click(button(container, "New session"));
    await settle();
    expect(bed.called("sessions.create")[0]?.params).toEqual({ cwd: "/work/project" });
    expect(current.navigate).toHaveBeenCalledExactlyOnceWith({
      to: "/s/$sessionId",
      params: { sessionId: "new-1" },
    });
  });

  it("shows the server's refusal of a directory and stays on the page", async () => {
    const container = await show();
    bed.handlers["sessions.create"] = () => {
      throw new RpcError("invalid_cwd");
    };
    await typeInto(field(container, "Working directory"), "relative/path");
    await click(button(container, "New session"));
    await settle();
    expect(alerts(container)).toEqual([
      "The working directory must be an absolute path to an existing folder.",
    ]);
    expect(current.navigate).not.toHaveBeenCalled();
    expect(button(container, "New session").disabled).toBe(false);
  });

  it("cannot create a session while the connection is not open", async () => {
    const container = await show("waiting");
    await typeInto(field(container, "Working directory"), "/work/project");
    expect(button(container, "New session").disabled).toBe(true);
    expect(bed.called("sessions.list")).toEqual([]);
  });

  it("shows a create whose outcome is unknown and does not list: the stream shows the session if it was made (R105)", async () => {
    for (const code of ["timeout", "connection_lost"] as const) {
      const container = await show();
      bed.handlers["sessions.create"] = () => {
        throw new RpcError(code);
      };
      await typeInto(field(container, "Working directory"), "/work/maybe");
      await click(button(container, "New session"));
      await settle();
      expect(bed.called("sessions.list"), code).toEqual([]);
      expect(alerts(container)[0], code).toContain("may still have gone through");
      await page?.unmount();
      page = null;
    }
  });
});

describe("the home narrowed to the current project", () => {
  const twoProjects = (extra: ShellSession[] = []) =>
    useShellStore.getState().apply(
      shellSnapshot(
        [
          shellSession({ id: "a", cwd: "/w/api/a", projectId: "api", updatedAt: 30 }),
          shellSession({ id: "w1", cwd: "/w/web/1", projectId: "web", updatedAt: 20 }),
          shellSession({ id: "w2", cwd: "/w/web/2", projectId: "web", updatedAt: 40 }),
          shellSession({ id: "gone", cwd: "/w/web/g", projectId: "web", updatedAt: 99, archivedAt: 5 }),
          ...extra,
        ],
        {
          projects: [
            shellProject({ id: "api", name: "api", root: "/w/api", position: 1, sessions: 1 }),
            shellProject({ id: "web", name: "web", root: "/w/web", position: 2, sessions: 2 }),
          ],
        },
      ),
    );

  it("starts the folder field with the project's root and lists only its sessions, newest first, under Recent", async () => {
    useCurrentProject.setState({ projectId: "web" });
    twoProjects();
    const container = await show();
    expect(field(container, "Working directory").value).toBe("/w/web");
    expect(container.querySelector("h2")?.textContent).toBe("Recent");
    expect([...container.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual([
      "/s/w2",
      "/s/w1",
    ]);
  });

  it("lists 10 at most", async () => {
    useCurrentProject.setState({ projectId: "web" });
    twoProjects(
      Array.from({ length: 15 }, (_, i) =>
        shellSession({ id: `m${i}`, projectId: "web", updatedAt: 100 + i, cwd: `/w/web/m${i}` }),
      ),
    );
    const container = await show();
    const hrefs = [...container.querySelectorAll("a")].map((link) => link.getAttribute("href"));
    expect(hrefs).toHaveLength(10);
    expect(hrefs[0]).toBe("/s/m14");
  });

  it("with no project, the field is empty and every project's sessions are listed", async () => {
    twoProjects();
    const container = await show();
    expect(field(container, "Working directory").value).toBe("");
    expect([...container.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual([
      "/s/w2",
      "/s/a",
      "/s/w1",
    ]);
  });

  it("a stored project the store does not know narrows nothing and leaves the field empty (RT-36)", async () => {
    useCurrentProject.setState({ projectId: "ghost" });
    twoProjects();
    const container = await show();
    expect(field(container, "Working directory").value).toBe("");
    expect(container.querySelectorAll("a")).toHaveLength(3);
  });

  it("typed text stays when the project changes; an untouched field follows the project", async () => {
    useCurrentProject.setState({ projectId: "web" });
    twoProjects();
    const container = await show();
    await act(async () => useCurrentProject.getState().choose("api"));
    expect(field(container, "Working directory").value).toBe("/w/api");
    await typeInto(field(container, "Working directory"), "/typed");
    await act(async () => useCurrentProject.getState().choose("web"));
    expect(field(container, "Working directory").value).toBe("/typed");
  });

  it("creates the session in the project's root when the field is untouched", async () => {
    useCurrentProject.setState({ projectId: "web" });
    twoProjects();
    const container = await show();
    bed.handlers["sessions.create"] = () => ({ sessionId: "new-2" });
    await click(button(container, "New session"));
    await settle();
    expect(bed.called("sessions.create")[0]?.params).toEqual({ cwd: "/w/web" });
  });

  it("All sessions opens the tree through the command", async () => {
    twoProjects();
    const container = await show();
    await click(button(container, "All sessions"));
    expect(current.runCommand).toHaveBeenCalledExactlyOnceWith("drawer.tree.toggle");
  });
});

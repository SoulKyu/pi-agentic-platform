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
import { shellSession, shellSnapshot } from "../../testing/shell-snapshot.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { SessionListScreen } from "./SessionListScreen.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined, navigate: vi.fn() }));
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
      ["/work/new", "/s/b"],
      ["/work/old", "/s/a"],
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

  it("shows the 50 newest sessions that are not archived", async () => {
    listed(
      ...Array.from({ length: 60 }, (_, i) =>
        shellSession({ id: `s${i}`, cwd: `/w/${i}`, updatedAt: i + 1 }),
      ),
      shellSession({ id: "gone", cwd: "/w/gone", updatedAt: 1000, archivedAt: 5 }),
    );
    const container = await show();
    const hrefs = [...container.querySelectorAll("a")].map((link) => link.getAttribute("href"));
    expect(hrefs).toHaveLength(50);
    expect(hrefs[0]).toBe("/s/s59");
    expect(hrefs.at(-1)).toBe("/s/s10");
  });

  it("follows the stream: a session that arrives as an event appears", async () => {
    listed(shellSession({ id: "a", cwd: "/work/a" }));
    const container = await show();
    await act(async () =>
      useShellStore
        .getState()
        .apply({ kind: "session", session: shellSession({ id: "n", cwd: "/work/n", updatedAt: 9 }) }),
    );
    expect([...container.querySelectorAll("a")].map((link) => link.textContent)).toEqual([
      "/work/n",
      "/work/a",
    ]);
  });

  it("says there is no session yet", async () => {
    const container = await show();
    expect(text(container)).toContain("No session yet.");
    expect(container.querySelector("h1")?.textContent).toBe("Sessions");
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

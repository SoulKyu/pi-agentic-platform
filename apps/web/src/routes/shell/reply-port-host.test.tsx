// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RoleContext } from "../../lib/role-context.ts";
import { useFilesTarget } from "../../stores/files-target.ts";
import { useReplyPorts } from "../../stores/reply-ports.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { mount } from "../../testing/dom.ts";
import { shellProject, shellSession, shellSnapshot } from "../../testing/shell-snapshot.ts";
import { useReplyPort } from "./reply-port-host.ts";

const shown = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
vi.mock("./surface.ts", async (original) => ({
  ...(await original<typeof import("./surface.ts")>()),
  showSurface: shown,
}));

function Host({ tabKey, sessionId }: { readonly tabKey: string; readonly sessionId: string }) {
  useReplyPort(tabKey, sessionId);
  return null;
}
const AsMember = ({ children }: { readonly children: ReactNode }) => (
  <RoleContext.Provider value="member">{children}</RoleContext.Provider>
);
const AsOwner = ({ children }: { readonly children: ReactNode }) => (
  <RoleContext.Provider value="owner">{children}</RoleContext.Provider>
);

const seed = (
  projects = [shellProject({ id: "p1", root: "/w/p1" })],
  sessions = [shellSession({ id: "s1", cwd: "/w/p1/sub", projectId: "p1" })],
) =>
  act(async () => {
    useShellStore.getState().apply(shellSnapshot(sessions, { projects }));
  });

beforeEach(() => {
  shown.mockClear();
  useShellStore.getState().reset();
  useReplyPorts.getState().reset();
  useFilesTarget.getState().reset();
});

describe("useReplyPort", () => {
  it("a session tab registers the session's scope, with the project root as Files root", async () => {
    await seed();
    await mount(<Host tabKey="t1" sessionId="s1" />);
    expect(useReplyPorts.getState().ports["s1"]?.scope).toEqual({
      base: "/w/p1/sub",
      roots: ["/w/p1/sub", "/w/p1"],
      filesRoot: "/w/p1",
      agentId: null,
    });
  });

  it("openFile pushes the target and splits the tab with Files", async () => {
    await seed();
    await mount(<Host tabKey="t1" sessionId="s1" />);
    useReplyPorts.getState().ports["s1"]?.openFile("/w/p1/src/a.ts", 12);
    expect(useFilesTarget.getState().targets["/w/p1"]).toMatchObject({ path: "/w/p1/src/a.ts", line: 12 });
    expect(shown).toHaveBeenCalledExactlyOnceWith("t1", "s1", "files");
  });

  it("no port while the shell store does not hold the session or its project has no root", async () => {
    await mount(<Host tabKey="t1" sessionId="s1" />);
    expect(useReplyPorts.getState().ports).toEqual({});
    await seed([shellProject({ id: "p1", root: "relative" })]);
    expect(useReplyPorts.getState().ports).toEqual({});
  });

  it("the port goes when the bar unmounts", async () => {
    await seed();
    const page = await mount(<Host tabKey="t1" sessionId="s1" />);
    expect(Object.keys(useReplyPorts.getState().ports)).toEqual(["s1"]);
    await page.unmount();
    expect(useReplyPorts.getState().ports).toEqual({});
  });

  it("toTerminal only where terminalAllowed and the session is not a child", async () => {
    await seed();
    await mount(
      <AsOwner>
        <Host tabKey="t1" sessionId="s1" />
      </AsOwner>,
    );
    expect(useReplyPorts.getState().ports["s1"]?.toTerminal).toBeTypeOf("function");

    useReplyPorts.getState().reset();
    await mount(
      <AsMember>
        <Host tabKey="t1" sessionId="s1" />
      </AsMember>,
    );
    expect(useReplyPorts.getState().ports["s1"]).toBeDefined();
    expect(useReplyPorts.getState().ports["s1"]?.toTerminal).toBeUndefined();
  });

  it("a subagent's session has no toTerminal, and a session with no folder of its own none either", async () => {
    await seed(undefined, [
      shellSession({ id: "s1", cwd: "/w/p1/sub", projectId: "p1" }),
      shellSession({ id: "c1", cwd: "/w/p1/sub", projectId: "p1", parentId: "s1" }),
      shellSession({ id: "r1", cwd: "relative", projectId: "p1" }),
    ]);
    await mount(
      <AsOwner>
        <Host tabKey="t1" sessionId="c1" />
        <Host tabKey="t2" sessionId="r1" />
      </AsOwner>,
    );
    expect(useReplyPorts.getState().ports["c1"]).toBeDefined();
    expect(useReplyPorts.getState().ports["c1"]?.toTerminal).toBeUndefined();
    expect(useReplyPorts.getState().ports["r1"]?.toTerminal).toBeUndefined();
  });

  it("a member's box session has it", async () => {
    await seed(
      [{ ...shellProject({ id: "b1", root: "/boxes/b1/project" }), kind: "box" } as never],
      [shellSession({ id: "sb", cwd: "/boxes/b1/project", projectId: "b1" })],
    );
    await mount(
      <AsMember>
        <Host tabKey="t1" sessionId="sb" />
      </AsMember>,
    );
    expect(useReplyPorts.getState().ports["sb"]?.toTerminal).toBeTypeOf("function");
  });
});

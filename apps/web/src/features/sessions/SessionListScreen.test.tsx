// @vitest-environment happy-dom
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

const summary = (id: string, cwd: string, updatedAt: number, status = "idle") => ({
  id,
  cwd,
  status,
  createdAt: 1,
  updatedAt,
});

async function show(state: "open" | "waiting" = "open") {
  bed = fakeRuntime(state);
  current.runtime = bed.runtime;
  page = await mount(<SessionListScreen />);
  await settle();
  return page.container;
}

beforeEach(() => {
  current.navigate.mockReset();
});
afterEach(async () => {
  await page?.unmount();
  page = null;
});

describe("SessionListScreen", () => {
  it("lists the sessions, the most recently used first, each linking to its screen", async () => {
    const list = vi.fn(() => ({
      sessions: [summary("a", "/work/old", 10), summary("b", "/work/new", 20, "running")],
    }));
    bed = fakeRuntime();
    bed.handlers["sessions.list"] = list;
    current.runtime = bed.runtime;
    page = await mount(<SessionListScreen />);
    await settle();
    const links = [...page.container.querySelectorAll("a")];
    expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["/work/new", "/s/b"],
      ["/work/old", "/s/a"],
    ]);
    expect(text(page.container)).toContain("Working");
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

  it("lists once the connection opens", async () => {
    const container = await show("waiting");
    bed.handlers["sessions.list"] = () => ({ sessions: [summary("a", "/work/x", 1)] });
    await act(async () => {
      bed.fake.setState("open");
    });
    await settle();
    expect(text(container)).toContain("/work/x");
  });

  it("shows a refused listing, but not a dropped connection", async () => {
    bed = fakeRuntime();
    current.runtime = bed.runtime;
    bed.handlers["sessions.list"] = () => {
      throw new RpcError("internal");
    };
    page = await mount(<SessionListScreen />);
    await settle();
    expect(alerts(page.container)).toEqual(["Something went wrong."]);
    await page.unmount();
    bed = fakeRuntime();
    current.runtime = bed.runtime;
    bed.handlers["sessions.list"] = () => {
      throw new RpcError("connection_lost");
    };
    page = await mount(<SessionListScreen />);
    await settle();
    expect(alerts(page.container)).toEqual([]);
  });
});

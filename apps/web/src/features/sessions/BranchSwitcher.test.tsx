// @vitest-environment happy-dom
// The session chunk registers these strings when it loads; the component is rendered here without it.
import "./register-session-catalog.ts";
import { describe, expect, it, vi } from "vitest";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { alerts, button, click, hasButton, settle, statuses, text } from "../../testing/dom.ts";
import { screenBed } from "../../testing/screen-bed.tsx";
import { sessionSnapshot } from "../../testing/session-snapshot.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return {
    Link: (props: { to: string; children: unknown }) =>
      createElement("a", { href: props.to }, props.children as never),
    useNavigate: () => vi.fn(),
  };
});

const screen = screenBed(current);
const rows = {
  rows: [
    { entryId: "u2", message: { role: "user", content: "second try", timestamp: 2 } },
    {
      entryId: "a2",
      message: { role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: 3 },
    },
  ],
};
const choice = (entryId: string, target: string) => ({
  entryId,
  preview: `${entryId} try`,
  target,
  timestamp: null,
  onPath: entryId === "u2",
});
const three = {
  leafId: "a2",
  truncated: false,
  points: [{ parentId: "a0", choices: [choice("u1", "a1"), choice("u2", "a2"), choice("u3", "a3")] }],
};
const two = {
  leafId: "a2",
  truncated: false,
  points: [{ parentId: "a0", choices: [choice("u2", "a2"), choice("u3", "a3")] }],
};
const deferred = () => {
  let resolve: (value: unknown) => void = () => {};
  const promise = new Promise((ok) => {
    resolve = ok;
  });
  return { promise, resolve };
};
const control = (container: HTMLElement, label: string) =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const asked = () => screen.bed.called("sessions.branches");

describe("branch switcher", () => {
  it("asks for the choices after a snapshot and shows the row's place among them", async () => {
    screen.bed.handlers["sessions.branches"] = () => three;
    const container = await screen.show(rows);
    expect(asked()).toEqual([{ method: "sessions.branches", params: { sessionId: "sess-1" } }]);
    expect(text(container)).toContain("2/3");
  });

  it("shows nothing on a row that is not a fork choice", async () => {
    screen.bed.handlers["sessions.branches"] = () => ({ leafId: null, truncated: false, points: [] });
    const container = await screen.show(rows);
    expect(control(container, "Next branch")).toBeNull();
  });

  it("goes to the neighbour choice's target through sessions.navigate", async () => {
    screen.bed.handlers["sessions.branches"] = () => three;
    screen.bed.handlers["sessions.navigate"] = () => ({ cancelled: false });
    const container = await screen.show(rows);
    await click(control(container, "Next branch") as HTMLElement);
    await settle();
    expect(screen.bed.called("sessions.navigate")).toEqual([
      {
        method: "sessions.navigate",
        params: { sessionId: "sess-1", targetId: "a3" },
        options: { commandId: "bed-cmd-00000001" },
      },
    ]);
    await click(control(container, "Previous branch") as HTMLElement);
    await settle();
    expect(screen.bed.called("sessions.navigate")[1]?.params).toEqual({
      sessionId: "sess-1",
      targetId: "a1",
    });
  });

  it("names the group with the position and announces the branch a switch landed on", async () => {
    screen.bed.handlers["sessions.branches"] = () => three;
    screen.bed.handlers["sessions.navigate"] = () => ({ cancelled: false });
    const container = await screen.show(rows);
    expect(container.querySelector("[data-branch-switcher]")?.getAttribute("aria-label")).toBe(
      "Branch 2 of 3",
    );
    expect(container.querySelector("[data-announcer]")?.textContent).toBe("");
    await click(control(container, "Next branch") as HTMLElement);
    await settle();
    expect(container.querySelector("[data-announcer]")?.textContent).toBe("Branch 3 of 3");
  });

  it("announces nothing when the navigation was cancelled", async () => {
    screen.bed.handlers["sessions.branches"] = () => three;
    screen.bed.handlers["sessions.navigate"] = () => ({ cancelled: true });
    const container = await screen.show(rows);
    await click(control(container, "Next branch") as HTMLElement);
    await settle();
    expect(container.querySelector("[data-announcer]")?.textContent).toBe("");
  });

  it("disables the arrow that has no neighbour", async () => {
    screen.bed.handlers["sessions.branches"] = () => ({
      ...three,
      points: [{ parentId: "a0", choices: [choice("u2", "a2"), choice("u3", "a3")] }],
    });
    const container = await screen.show(rows);
    expect(control(container, "Previous branch")?.disabled).toBe(true);
    expect(control(container, "Next branch")?.disabled).toBe(false);
  });

  it("keeps Stop reachable and the row buttons disabled while the switch runs, and sends once", async () => {
    const reply = deferred();
    screen.bed.handlers["sessions.branches"] = () => three;
    screen.bed.handlers["sessions.navigate"] = () => reply.promise;
    const container = await screen.show(rows);
    await click(control(container, "Next branch") as HTMLElement);
    await click(control(container, "Next branch") as HTMLElement);
    expect(screen.bed.called("sessions.navigate")).toHaveLength(1);
    expect(control(container, "Next branch")?.disabled).toBe(true);
    expect(control(container, "Previous branch")?.disabled).toBe(true);
    expect(button(container, "Edit from here").disabled).toBe(true);
    expect(button(container, "Fork from here").disabled).toBe(true);
    expect(hasButton(container, "Stop")).toBe(true);
    reply.resolve({ cancelled: false });
    await settle();
    expect(control(container, "Next branch")?.disabled).toBe(false);
  });

  it("shows the error of a refused switch", async () => {
    screen.bed.handlers["sessions.branches"] = () => three;
    screen.bed.handlers["sessions.navigate"] = () => {
      throw new RpcError("session_busy");
    };
    const container = await screen.show(rows);
    await click(control(container, "Next branch") as HTMLElement);
    await settle();
    expect(alerts(container)).toEqual(["The session is working. Wait for it to finish, or stop it first."]);
  });

  it("is disabled while a run is in progress and asks again once it has settled", async () => {
    screen.bed.handlers["sessions.branches"] = () => three;
    const container = await screen.show(rows);
    await screen.emit({ kind: "status", status: "running" });
    expect(control(container, "Next branch")?.disabled).toBe(true);
    expect(control(container, "Previous branch")?.disabled).toBe(true);
    expect(asked()).toHaveLength(1);
    screen.bed.handlers["sessions.branches"] = () => two;
    await screen.emit({ kind: "status", status: "idle" });
    expect(asked()).toHaveLength(2);
    expect(text(container)).toContain("1/2");
    expect(control(container, "Next branch")?.disabled).toBe(false);
  });

  it("drops an answer that lands after a new snapshot (M2-RT-12) and asks again", async () => {
    const first = deferred();
    const second = deferred();
    let calls = 0;
    screen.bed.handlers["sessions.branches"] = () => (++calls === 1 ? first.promise : second.promise);
    const container = await screen.show(rows);
    await screen.emit(sessionSnapshot(rows));
    first.resolve(three);
    await settle();
    expect(text(container)).not.toContain("2/3");
    expect(control(container, "Next branch")).toBeNull();
    second.resolve(two);
    await settle();
    expect(asked()).toHaveLength(2);
    expect(text(container)).toContain("1/2");
    expect(text(container)).not.toContain("2/3");
  });

  it("drops an answer that lands after the leaf moved", async () => {
    const first = deferred();
    const second = deferred();
    let calls = 0;
    screen.bed.handlers["sessions.branches"] = () => (++calls === 1 ? first.promise : second.promise);
    const container = await screen.show(rows);
    await screen.emit({ kind: "entry", entry: { id: "a9", parentId: "a2", type: "message" } });
    first.resolve(three);
    await settle();
    expect(text(container)).not.toContain("2/3");
    expect(control(container, "Next branch")).toBeNull();
    second.resolve(two);
    await settle();
    expect(text(container)).toContain("1/2");
  });

  it("keeps one request in flight and folds a burst of snapshots into one more", async () => {
    const first = deferred();
    let calls = 0;
    screen.bed.handlers["sessions.branches"] = () => (++calls === 1 ? first.promise : two);
    const container = await screen.show(rows);
    for (let n = 0; n < 5; n++) await screen.emit(sessionSnapshot(rows));
    expect(asked()).toHaveLength(1);
    first.resolve(three);
    await settle();
    expect(asked()).toHaveLength(2);
    expect(text(container)).toContain("1/2");
  });

  it("says when the choices could not be loaded and keeps the last ones", async () => {
    screen.bed.handlers["sessions.branches"] = () => three;
    const container = await screen.show(rows);
    screen.bed.handlers["sessions.branches"] = () => {
      throw new RpcError("internal");
    };
    await screen.emit(sessionSnapshot(rows));
    expect(statuses(container)).toContain(
      "pap hit an unexpected error. The action may not have completed: check its result, then try again. If it repeats, run pap doctor.",
    );
    expect(text(container)).toContain("2/3");
  });

  it("shows that a navigation an extension cancelled did not happen", async () => {
    screen.bed.handlers["sessions.branches"] = () => three;
    screen.bed.handlers["sessions.navigate"] = () => ({ cancelled: true });
    const container = await screen.show(rows);
    await click(control(container, "Next branch") as HTMLElement);
    await settle();
    expect(alerts(container)).toEqual(["The navigation was cancelled."]);
  });

  it("shows no error for a failed refresh that the view has moved past", async () => {
    const first = deferred();
    let calls = 0;
    const second = deferred();
    screen.bed.handlers["sessions.branches"] = () => (++calls === 1 ? first.promise : second.promise);
    const container = await screen.show(rows);
    await screen.emit(sessionSnapshot(rows));
    first.resolve(Promise.reject(new RpcError("internal")));
    await settle();
    expect(alerts(container)).toEqual([]);
    second.resolve(three);
    await settle();
    expect(text(container)).toContain("2/3");
  });

  it("asks nothing for a transcript that offers no row actions", async () => {
    const { Transcript } = await import("./Transcript.tsx");
    const { mount } = await import("../../testing/dom.ts");
    const { EMPTY_VIEW } = await import("../../stores/session-reducer.ts");
    const { useSessionStore } = await import("../../stores/session-store.ts");
    const view = { ...EMPTY_VIEW, loaded: true, generation: 1 };
    useSessionStore.setState({ views: { "sess-1": view } });
    const page = await mount(<Transcript sessionId="sess-1" view={view} />);
    await settle();
    expect(asked()).toHaveLength(0);
    await page.unmount();
  });
});

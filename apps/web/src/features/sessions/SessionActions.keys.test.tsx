// @vitest-environment happy-dom
// The session chunk registers these strings when it loads; the component is rendered here without it.
import "./register-session-catalog.ts";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { EMPTY_VIEW, type SessionView } from "../../stores/session-reducer.ts";
import {
  alerts,
  button,
  click,
  field,
  hasButton,
  mount,
  press,
  settle,
  typeInto,
} from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { SessionActions } from "./SessionActions.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined, navigate: vi.fn() }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => current.navigate }));

let bed: ReturnType<typeof fakeRuntime>;
let page: Awaited<ReturnType<typeof mount>> | null = null;
const viewOf = (patch: Partial<SessionView> = {}): SessionView => ({ ...EMPTY_VIEW, ...patch });
async function show(view: SessionView = viewOf(), track?: <T>(call: Promise<T>) => Promise<T>) {
  page = await mount(<SessionActions sessionId="sess-1" view={view} track={track} />);
  return page.container;
}
const deferred = () => {
  let resolve: (value: unknown) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise((ok, no) => {
    resolve = ok;
    reject = no;
  });
  return { promise, resolve, reject };
};

beforeEach(() => {
  bed = fakeRuntime();
  current.runtime = bed.runtime;
  current.navigate.mockReset();
  current.navigate.mockResolvedValue(undefined);
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await page?.unmount();
  page = null;
});

describe("SessionActions keyboard, focus and errors", () => {
  it("marks the rename field as an inline edit, for the page's key dispatcher", async () => {
    const container = await show();
    await click(button(container, "Rename"));
    expect(container.querySelector("[data-inline-edit] input")).not.toBeNull();
  });

  it("Enter on Cancel is left to the button: it saves nothing", async () => {
    const container = await show({ ...EMPTY_VIEW, name: "Old" });
    await click(button(container, "Rename"));
    await typeInto(field(container, "Rename"), "Changed");
    const event = await press(button(container, "Cancel"), { key: "Enter" });
    expect(event.defaultPrevented).toBe(false);
    expect(bed.called("sessions.rename")).toHaveLength(0);
    await click(button(container, "Cancel"));
    expect(hasButton(container, "Rename")).toBe(true);
    expect(bed.called("sessions.rename")).toHaveLength(0);
  });

  it("sends one rename when Enter comes twice before the screen has re-rendered", async () => {
    const reply = deferred();
    bed.handlers["sessions.rename"] = () => reply.promise;
    const container = await show();
    await click(button(container, "Rename"));
    await typeInto(field(container, "Rename"), "Name");
    await act(async () => {
      for (let i = 0; i < 2; i++)
        field(container, "Rename").dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
        );
    });
    expect(bed.called("sessions.rename")).toHaveLength(1);
    reply.resolve({ ok: true });
    await settle();
  });

  it("returns focus to the Rename button after a save and after a cancel", async () => {
    const frames: Array<() => void> = [];
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => frames.push(callback));
    const container = await show();
    await click(button(container, "Rename"));
    await typeInto(field(container, "Rename"), "Name");
    await click(button(container, "Save"));
    await settle();
    frames.splice(0).forEach((frame) => frame());
    expect(document.activeElement).toBe(button(container, "Rename"));
    (document.activeElement as HTMLElement).blur();
    await click(button(container, "Rename"));
    await click(button(container, "Cancel"));
    frames.splice(0).forEach((frame) => frame());
    expect(document.activeElement).toBe(button(container, "Rename"));
  });

  it("gives each action its own error line", async () => {
    bed.handlers["sessions.autoName"] = () => {
      throw new RpcError("session_empty");
    };
    bed.handlers["sessions.clone"] = () => {
      throw new RpcError("capacity");
    };
    const container = await show();
    await click(button(container, "Name it"));
    await settle();
    await click(button(container, "Duplicate"));
    await settle();
    expect(alerts(container)).toEqual([
      "This session has no messages to work with yet.",
      "The server is at capacity. Try again later.",
    ]);
  });

  it.each([
    "//evil.example/api/sessions/x",
    "https://evil.example/api/sessions/x",
    "/other/path",
    "api/sessions/x",
    "/api/sessions/../../x",
    "/api/sessions/%2e%2e/x",
    "/api/sessions/%2E%2E/%2e%2e/x",
    "/api/sessions/\\evil.com",
    "/api/sessions/..\\..\\x",
  ])("refuses to download from %s", async (url) => {
    bed.handlers["sessions.exportHtml"] = () => ({ url });
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    try {
      const container = await show();
      await click(button(container, "Export"));
      await click(button(container, "Download"));
      await settle();
      expect(clicked).not.toHaveBeenCalled();
      expect(alerts(container)).toEqual(["Something went wrong."]);
    } finally {
      clicked.mockRestore();
    }
  });
});

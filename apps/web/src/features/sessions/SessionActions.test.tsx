// @vitest-environment happy-dom
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
  text,
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

const EXPORT_URL = `/api/sessions/sess-1/export/${"A".repeat(43)}`;
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

describe("SessionActions rename", () => {
  it("saves on Enter with a command id, and closes the field", async () => {
    const container = await show(viewOf({ name: "Old" }));
    await click(button(container, "Rename"));
    expect(field(container, "Rename").value).toBe("Old");
    await typeInto(field(container, "Rename"), "New name");
    await press(field(container, "Rename"), { key: "Enter" });
    await settle();
    expect(bed.called("sessions.rename")).toEqual([
      {
        method: "sessions.rename",
        params: { sessionId: "sess-1", name: "New name" },
        options: { commandId: "bed-cmd-00000001" },
      },
    ]);
    expect(hasButton(container, "Rename")).toBe(true);
  });

  it("Escape cancels, sends nothing and never reaches the page's own key handler", async () => {
    const onDocument = vi.fn();
    document.addEventListener("keydown", onDocument);
    try {
      const container = await show(viewOf({ name: "Old" }));
      await click(button(container, "Rename"));
      await typeInto(field(container, "Rename"), "Changed");
      await press(field(container, "Rename"), { key: "Escape" });
      expect(onDocument).not.toHaveBeenCalled();
      expect(bed.called("sessions.rename")).toHaveLength(0);
      expect(hasButton(container, "Rename")).toBe(true);
    } finally {
      document.removeEventListener("keydown", onDocument);
    }
  });

  it("shows the name clipped to 256 characters, counted by code point, and sends exactly that", async () => {
    const container = await show();
    await click(button(container, "Rename"));
    await typeInto(field(container, "Rename"), "😀".repeat(300));
    expect([...field(container, "Rename").value]).toHaveLength(256);
    await click(button(container, "Save"));
    await settle();
    expect(bed.called("sessions.rename")[0]?.params).toEqual({
      sessionId: "sess-1",
      name: "😀".repeat(256),
    });
  });

  it("does not save a blank name", async () => {
    const container = await show();
    await click(button(container, "Rename"));
    await typeInto(field(container, "Rename"), "   ");
    expect(button(container, "Save").disabled).toBe(true);
    await press(field(container, "Rename"), { key: "Enter" });
    expect(bed.called("sessions.rename")).toHaveLength(0);
  });

  it("keeps the field open on a failure and says the outcome is unknown after a timeout, without retrying", async () => {
    bed.handlers["sessions.rename"] = () => {
      throw new RpcError("timeout");
    };
    const container = await show();
    await click(button(container, "Rename"));
    await typeInto(field(container, "Rename"), "Name");
    await click(button(container, "Save"));
    await settle();
    expect(bed.called("sessions.rename")).toHaveLength(1);
    expect(alerts(container)[0]).toContain("may still have gone through");
    expect(field(container, "Rename").value).toBe("Name");
  });
});

describe("SessionActions auto-name", () => {
  it("shows the error text of a failed call, never raw text", async () => {
    bed.handlers["sessions.autoName"] = () => {
      throw new RpcError("session_empty");
    };
    const container = await show();
    await click(button(container, "Name it"));
    await settle();
    expect(alerts(container)).toEqual(["This session has no messages to work with yet."]);
    expect(button(container, "Name it").disabled).toBe(false);
  });

  it("is disabled while a call runs, and says Naming… only after one second", async () => {
    vi.useFakeTimers();
    const reply = deferred();
    bed.handlers["sessions.autoName"] = () => reply.promise;
    const container = await show();
    await click(button(container, "Name it"));
    expect(button(container, "Name it").disabled).toBe(true);
    expect(hasButton(container, "Naming…")).toBe(false);
    await act(async () => {
      vi.advanceTimersByTime(999);
    });
    expect(hasButton(container, "Naming…")).toBe(false);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(button(container, "Naming…").disabled).toBe(true);
    await click(button(container, "Naming…"));
    expect(bed.called("sessions.autoName")).toHaveLength(1);
    reply.resolve({ name: "Done" });
    await act(async () => {});
    expect(button(container, "Name it").disabled).toBe(false);
  });
});

describe("SessionActions compact", () => {
  it("is disabled while the agent runs and while the session compacts, and asks no confirmation", async () => {
    let container = await show(viewOf({ status: "running" }));
    expect(button(container, "Compact").disabled).toBe(true);
    await page?.unmount();
    container = await show(viewOf({ activity: { compacting: true, retry: null } }));
    expect(button(container, "Compact").disabled).toBe(true);
    await page?.unmount();
    container = await show(viewOf({ status: "idle" }));
    await click(button(container, "Compact"));
    await settle();
    expect(bed.called("sessions.compact")).toHaveLength(1);
    expect(bed.called("sessions.compact")[0]?.options).toEqual({ commandId: "bed-cmd-00000001" });
  });

  it("hands its call to the screen so that Stop stays reachable while it runs", async () => {
    const reply = deferred();
    bed.handlers["sessions.compact"] = () => reply.promise;
    const tracked: Array<Promise<unknown>> = [];
    const container = await show(viewOf(), (call) => {
      tracked.push(call);
      return call;
    });
    await click(button(container, "Compact"));
    expect(tracked).toHaveLength(1);
    await click(button(container, "Compact"));
    expect(bed.called("sessions.compact")).toHaveLength(1);
    reply.resolve({ tokensBefore: 1, estimatedTokensAfter: null });
    await settle();
  });

  it("after a timeout tells that it may have happened and does not call again", async () => {
    bed.handlers["sessions.compact"] = () => {
      throw new RpcError("connection_lost");
    };
    const container = await show();
    await click(button(container, "Compact"));
    await settle();
    expect(alerts(container)[0]).toContain("may still have gone through");
    expect(bed.called("sessions.compact")).toHaveLength(1);
  });
});

describe("SessionActions export", () => {
  it("shows the warning first and calls nothing until Download", async () => {
    const container = await show();
    await click(button(container, "Export"));
    expect(text(container)).toContain("The file holds everything the agent saw, secrets included.");
    expect(bed.calls.filter((call) => call.method !== "subscribe.session")).toEqual([]);
    expect(hasButton(container, "Download")).toBe(true);
  });

  it("Cancel calls nothing and closes the warning", async () => {
    const container = await show();
    await click(button(container, "Export"));
    await click(button(container, "Cancel"));
    expect(bed.called("sessions.exportHtml")).toHaveLength(0);
    expect(text(container)).not.toContain("secrets included");
  });

  it("Download clicks one detached download link on the returned URL, with no fetch, no Blob and no new tab", async () => {
    bed.handlers["sessions.exportHtml"] = () => ({ url: EXPORT_URL });
    const fetchSpy = vi.fn();
    const openSpy = vi.fn();
    const blobSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("open", openSpy);
    URL.createObjectURL = blobSpy;
    const clicked: Array<{
      href: string | null;
      download: string | null;
      attached: boolean;
      target: string | null;
    }> = [];
    const click$ = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push({
        href: this.getAttribute("href"),
        download: this.getAttribute("download"),
        attached: this.isConnected,
        target: this.getAttribute("target"),
      });
    });
    try {
      const container = await show();
      await click(button(container, "Export"));
      await click(button(container, "Download"));
      await settle();
      expect(bed.called("sessions.exportHtml")).toEqual([
        {
          method: "sessions.exportHtml",
          params: { sessionId: "sess-1" },
          options: { commandId: "bed-cmd-00000001" },
        },
      ]);
      expect(clicked).toEqual([{ href: EXPORT_URL, download: "", attached: false, target: null }]);
      expect(document.querySelectorAll("a[download]")).toHaveLength(0);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(openSpy).not.toHaveBeenCalled();
      expect(blobSpy).not.toHaveBeenCalled();
      expect(text(container)).not.toContain("secrets included");
    } finally {
      click$.mockRestore();
    }
  });

  it("keeps the warning open and shows the error when the export fails", async () => {
    bed.handlers["sessions.exportHtml"] = () => {
      throw new RpcError("timeout");
    };
    const container = await show();
    await click(button(container, "Export"));
    await click(button(container, "Download"));
    await settle();
    expect(alerts(container)[0]).toContain("may still have gone through");
    expect(bed.called("sessions.exportHtml")).toHaveLength(1);
  });
});

describe("SessionActions duplicate", () => {
  it("clones, then opens the new session", async () => {
    bed.handlers["sessions.clone"] = () => ({ sessionId: "copy-1" });
    const container = await show();
    await click(button(container, "Duplicate"));
    await settle();
    expect(bed.called("sessions.clone")[0]?.params).toEqual({ sessionId: "sess-1" });
    expect(current.navigate).toHaveBeenCalledWith({ to: "/s/$sessionId", params: { sessionId: "copy-1" } });
  });

  it("shows the error and does not navigate when the clone fails", async () => {
    bed.handlers["sessions.clone"] = () => {
      throw new RpcError("capacity");
    };
    const container = await show();
    await click(button(container, "Duplicate"));
    await settle();
    expect(alerts(container)).toEqual(["The server is at capacity. Try again later."]);
    expect(current.navigate).not.toHaveBeenCalled();
  });
});

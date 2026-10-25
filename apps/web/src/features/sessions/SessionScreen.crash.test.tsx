// @vitest-environment happy-dom
import { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { useSessionStore } from "../../stores/session-store.ts";
import { alerts, button, click, mount, settle, text, type Mounted } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { SessionScreen } from "./SessionScreen.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return {
    Link: (props: { to: string; children: ReactNode }) =>
      createElement("a", { href: props.to }, props.children),
    useNavigate: () => () => Promise.resolve(),
  };
});

let bed: ReturnType<typeof fakeRuntime>;
let page: Mounted | null = null;

const oom = {
  kind: "status",
  status: "cold",
  cause: "Agent process ran out of memory and was stopped.",
  causeCode: "process_oom",
};

async function show() {
  page = await mount(<SessionScreen sessionId="sess-1" />);
  await settle();
  return page.container;
}
async function emit(event: unknown) {
  bed.emit(event);
  await settle();
}

beforeEach(() => {
  bed = fakeRuntime();
  current.runtime = bed.runtime;
  useSessionStore.setState({ views: {} });
});
afterEach(async () => {
  await page?.unmount();
  page = null;
});

describe("SessionScreen crash banner", () => {
  it("says why, that the transcript is intact, and lists the code under Details", async () => {
    const container = await show();
    await emit(oom);
    const banner = container.querySelector('[data-slot="banner"][data-tone="crash"]');
    expect(banner?.getAttribute("role")).toBe("alert");
    expect(text(container)).toContain("The session stopped");
    expect(container.querySelector("[data-crash-cause]")?.textContent).toBe(
      "Agent process ran out of memory and was stopped.",
    );
    expect(text(container)).toContain("The transcript is intact.");
    const details = container.querySelector("[data-crash-details]");
    expect(details?.textContent).toContain("Code: process_oom");
    expect(details?.textContent).toContain("worker_exited");
  });

  it("Retry reopens the worker, and the banner goes when the worker starts", async () => {
    bed.handlers["sessions.reopen"] = () => ({ ok: true });
    const container = await show();
    await emit(oom);
    await click(button(container, "Retry"));
    expect(bed.called("sessions.reopen")).toEqual([
      expect.objectContaining({ method: "sessions.reopen", params: { sessionId: "sess-1" } }),
    ]);
    await emit({ kind: "status", status: "starting" });
    expect(container.querySelector('[data-tone="crash"]')).toBeNull();
  });

  it("shows why a Retry failed, with the worker counter when the cap is reached", async () => {
    bed.handlers["sessions.reopen"] = () => {
      throw new RpcError("capacity", { used: 6, max: 6 });
    };
    const container = await show();
    await emit(oom);
    await click(button(container, "Retry"));
    expect(container.querySelector("[data-crash-error]")?.textContent).toBe(
      "pap is at capacity: every worker slot is in use. Nothing was started. Try again when a session finishes, or stop one. 6 / 6 workers running.",
    );
    // the crash banner and the answer to the person's own Retry click
    expect(alerts(container)).toHaveLength(2);
  });

  it("does not bring a crash back after a clean stop", async () => {
    const container = await show();
    await emit(oom);
    await emit({ kind: "status", status: "starting" });
    await emit({ kind: "status", status: "cold" });
    expect(container.querySelector('[data-tone="crash"]')).toBeNull();
  });
});

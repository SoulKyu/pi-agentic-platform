// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { EMPTY_VIEW } from "../../stores/session-reducer.ts";
import { useSessionStore } from "../../stores/session-store.ts";
import { mount, settle, text, type Mounted } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { sessionSnapshot } from "../../testing/session-snapshot.ts";
import { Transcript } from "./Transcript.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let page: Mounted | null = null;

function Live() {
  const view = useSessionStore((state) => state.views["sess-1"]) ?? EMPTY_VIEW;
  return <Transcript sessionId="sess-1" view={view} toolDetail="expanded" />;
}
const emit = async (event: unknown) => {
  useSessionStore.getState().apply("sess-1", event);
  await settle();
};

beforeEach(() => {
  current.runtime = fakeRuntime().runtime;
  useSessionStore.setState({ views: {} });
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
});
afterEach(async () => {
  await page?.unmount();
  page = null;
  vi.unstubAllGlobals();
});

describe("the streaming row (M4R112)", () => {
  it("keeps its DOM node when Pi writes the final message", async () => {
    useSessionStore.getState().apply("sess-1", sessionSnapshot({ status: "running" }));
    page = await mount(<Live />);
    await settle();
    await emit({
      kind: "pi",
      event: { type: "message_start", message: { role: "assistant", timestamp: 7 } },
    });
    await emit({
      kind: "pi",
      event: {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "All " },
      },
    });
    const selector = '[data-slot="message"][data-author="agent"]';
    const streaming = page.container.querySelector(selector);
    expect(streaming?.textContent).toContain("All");
    await emit({
      kind: "pi",
      event: {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "All green." }], timestamp: 7 },
      },
    });
    expect(text(page.container)).toContain("All green.");
    expect(page.container.querySelectorAll(selector)).toHaveLength(1);
    expect(page.container.querySelector(selector)).toBe(streaming);
  });
});

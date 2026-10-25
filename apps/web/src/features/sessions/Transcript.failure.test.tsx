// @vitest-environment happy-dom
import "./register-session-catalog.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { EMPTY_VIEW } from "../../stores/session-reducer.ts";
import { useSessionStore } from "../../stores/session-store.ts";
import { mount, settle, type Mounted } from "../../testing/dom.ts";
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
  return <Transcript sessionId="sess-1" view={view} />;
}
beforeEach(() => {
  current.runtime = fakeRuntime().runtime;
  useSessionStore.setState({ views: {} });
});
afterEach(async () => {
  await page?.unmount();
  page = null;
});

describe("a model failure in the transcript", () => {
  it("says the transcript is intact and how to retry", async () => {
    const rows = [
      { entryId: "e1", message: { role: "user", content: "go", timestamp: 1 } },
      {
        entryId: "e2",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "overloaded",
          timestamp: 2,
        },
      },
    ];
    useSessionStore.getState().apply("sess-1", sessionSnapshot({ rows }));
    page = await mount(<Live />);
    await settle();
    const failure = page.container.querySelector("[data-failure]") as HTMLElement;
    expect(failure.textContent).toContain("overloaded");
    expect(failure.textContent).toContain(
      "The transcript is intact. Send your message again to retry, or choose another model.",
    );
  });
});

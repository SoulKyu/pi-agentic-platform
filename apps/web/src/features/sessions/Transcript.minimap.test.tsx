// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { EMPTY_VIEW } from "../../stores/session-reducer.ts";
import { useSessionStore } from "../../stores/session-store.ts";
import { button, click, mount, settle, text, type Mounted } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { sessionSnapshot } from "../../testing/session-snapshot.ts";
import { Transcript } from "./Transcript.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let bed: ReturnType<typeof fakeRuntime>;
let page: Mounted | null = null;
const row = (entryId: string, content: string) => ({
  entryId,
  message: { role: "user", content, timestamp: Number(entryId.slice(1)) },
});

function Live({ id }: { id: string }) {
  const view = useSessionStore((state) => state.views[id]) ?? EMPTY_VIEW;
  return <Transcript sessionId={id} view={view} />;
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

describe("Transcript with its minimap", () => {
  it("pages older turns in through the one load the transcript has, and scopes row ids per screen", async () => {
    let release: (value: unknown) => void = () => {};
    bed.handlers["sessions.history"] = () => new Promise((resolve) => (release = resolve));
    useSessionStore.getState().apply(
      "sess-1",
      sessionSnapshot({
        rows: [row("e5", "newest")],
        history: { hasMore: true, oldestEntryId: "e5", turnsBefore: 2 },
      }),
    );
    page = await mount(
      <>
        <Live id="sess-1" />
        <Live id="sess-1" />
      </>,
    );
    await settle();
    const ids = [...page.container.querySelectorAll("[id^='row-']")].map((li) => li.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    const first = page.container.querySelector("nav") as HTMLElement;
    await click(button(first, "2 earlier turns"));
    await click(button(first, "2 earlier turns"));
    expect(bed.called("sessions.history")).toHaveLength(1);
    await act(async () =>
      release({ rows: [row("e1", "older question")], hasMore: false, oldestEntryId: "e1", turnsBefore: 0 }),
    );
    await settle();
    expect(text(page.container)).toContain("older question");
  });
});

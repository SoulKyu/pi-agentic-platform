// @vitest-environment happy-dom
// The session chunk registers these strings when it loads; the component is rendered here without it.
import "./register-session-catalog.ts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { EMPTY_VIEW } from "../../stores/session-reducer.ts";
import { useSessionStore } from "../../stores/session-store.ts";
import type { Interleave, InterleaveRow } from "../../stores/thread-interleave.ts";
import { mount, settle } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { sessionSnapshot } from "../../testing/session-snapshot.ts";
import { Transcript } from "./Transcript.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const T0 = Date.UTC(2026, 9, 15, 8, 0);
const message = (entryId: string, role: "user" | "assistant", content: string, at: number) => ({
  entryId,
  message: { role, content, timestamp: at },
});

function Live({ interleave }: { interleave?: Interleave }) {
  const view = useSessionStore((state) => state.views["sess-1"]) ?? EMPTY_VIEW;
  return <Transcript sessionId="sess-1" view={view} {...(interleave ? { interleave } : {})} />;
}
beforeEach(() => {
  current.runtime = fakeRuntime().runtime;
  useSessionStore.setState({ views: {} });
});

describe("Transcript interleave (M11R118)", () => {
  it("hands the rows with their time to the interleave and draws what it places between them", async () => {
    useSessionStore.getState().apply(
      "sess-1",
      sessionSnapshot({
        rows: [
          message("e1", "user", "first", T0),
          message("e2", "assistant", "second", T0 + 60_000),
          message("e3", "assistant", "third", T0 + 120_000),
        ],
      }),
    );
    const seen: InterleaveRow[][] = [];
    const interleave: Interleave = {
      arrange: (rows) => {
        seen.push([...rows]);
        const e3 = rows[2]?.key ?? "";
        return {
          before: new Map([[e3, [<div key="x" data-extra="card" />]]]),
          after: [<div key="y" data-extra="tail" />],
          hidden: new Set(),
          breaks: new Set([e3]),
        };
      },
    };
    const page = await mount(<Live interleave={interleave} />);
    await settle();
    expect(seen.at(-1)?.map((row) => [row.author, row.at, row.text])).toEqual([
      ["you", T0, "first"],
      ["agent", T0 + 60_000, "second"],
      ["agent", T0 + 120_000, "third"],
    ]);
    const extras = [...page.container.querySelectorAll("[data-extra]")].map((one) =>
      one.getAttribute("data-extra"),
    );
    expect(extras).toEqual(["card", "tail"]);
    // Your run, the second row, the card, the third row (the break gives it a run of its own), the tail.
    expect(page.container.querySelectorAll("ol > li").length).toBe(5);
  });

  it("does not draw a hidden row", async () => {
    useSessionStore.getState().apply(
      "sess-1",
      sessionSnapshot({
        rows: [message("e1", "user", "folded away", T0), message("e2", "assistant", "kept", T0 + 1)],
      }),
    );
    const interleave: Interleave = {
      arrange: (rows) => ({
        before: new Map(),
        after: [],
        hidden: new Set([rows[0]?.key ?? ""]),
        breaks: new Set(),
      }),
    };
    const page = await mount(<Live interleave={interleave} />);
    await settle();
    expect(page.container.textContent).not.toContain("folded away");
    expect(page.container.textContent).toContain("kept");
  });

  it("draws the transcript as before without an interleave", async () => {
    useSessionStore
      .getState()
      .apply("sess-1", sessionSnapshot({ rows: [message("e1", "user", "plain", T0)] }));
    const page = await mount(<Live />);
    await settle();
    expect(page.container.textContent).toContain("plain");
    expect(page.container.querySelectorAll("[data-extra]").length).toBe(0);
  });
});

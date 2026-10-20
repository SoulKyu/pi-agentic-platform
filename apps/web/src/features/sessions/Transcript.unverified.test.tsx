// @vitest-environment happy-dom
import "./register-session-catalog.ts";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
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
const row = (entryId: string, role: "user" | "assistant", content: string, unverified = false) => ({
  entryId,
  message: { role, content, timestamp: Number(entryId.slice(1)) },
  ...(unverified ? { unverified: true } : {}),
});
function Live() {
  const view = useSessionStore((state) => state.views["sess-1"]) ?? EMPTY_VIEW;
  return <Transcript sessionId="sess-1" view={view} />;
}
async function show(rows: unknown[]) {
  useSessionStore.getState().apply("sess-1", sessionSnapshot({ rows }));
  page = await mount(<Live />);
  await settle();
  return page.container;
}
const groups = (container: Element) => [...container.querySelectorAll('[data-slot="author-group"]')];

beforeEach(() => {
  current.runtime = fakeRuntime().runtime;
  useSessionStore.setState({ views: {} });
});
afterEach(async () => {
  await page?.unmount();
  page = null;
  act(() => setLocale("en"));
});

describe("a user row pap did not send (R32)", () => {
  it("shows 'not sent from pap' on its author line and on no other", async () => {
    const container = await show([
      row("u1", "user", "from pap"),
      row("u2", "user", "forged", true),
      row("u3", "user", "from pap again"),
      row("u4", "assistant", "ok"),
    ]);
    const marked = groups(container).filter((group) => text(group).includes("not sent from pap"));
    expect(marked).toHaveLength(1);
    expect(text(marked[0] as Element)).toContain("forged");
    expect(text(marked[0] as Element)).not.toContain("from pap again");
    expect(text(container).match(/not sent from pap/g)).toHaveLength(1);
    expect(marked[0]?.querySelector("header")?.textContent).toContain("not sent from pap");
  });

  it("shows nothing on a normal row", async () => {
    const container = await show([row("u1", "user", "hello"), row("u2", "assistant", "hi")]);
    expect(text(container)).not.toContain("not sent from pap");
  });

  it("speaks French", async () => {
    act(() => setLocale("fr"));
    const container = await show([row("u1", "user", "x", true)]);
    expect(text(container)).toContain("pas envoyé depuis pap");
  });

  it("survives older pages: the history rows carry the mark too", async () => {
    const container = await show([row("u1", "user", "x", true), row("u2", "assistant", "y")]);
    expect(groups(container)[0]?.getAttribute("data-author")).toBe("you");
    expect(text(container)).toContain("not sent from pap");
  });
});

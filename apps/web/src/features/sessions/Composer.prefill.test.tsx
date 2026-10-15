// @vitest-environment happy-dom
import "./register-session-catalog.ts";
import type { ReactNode } from "react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { field, settle } from "../../testing/dom.ts";
import { screenBed } from "../../testing/screen-bed.tsx";
import { useComposerPrefill } from "../../stores/composer-prefill.ts";

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

const { show } = screenBed(current);

describe("Composer prefill (the review batch)", () => {
  it("appends a waiting text once after the draft, saves it, and focuses the field", async () => {
    localStorage.setItem("pap.draft.sess-1", "my draft");
    useComposerPrefill.setState({ items: {} });
    useComposerPrefill.getState().push("sess-1", "Review comments on the current changes:");
    const container = await show({ status: "idle" });
    const message = field(container, "Message");
    expect(message.value).toBe("my draft\n\nReview comments on the current changes:");
    expect(localStorage.getItem("pap.draft.sess-1")).toBe(message.value);
    expect(document.activeElement).toBe(message);
    expect(useComposerPrefill.getState().take("sess-1")).toBeNull();
  });

  it("takes a text pushed while the composer is already open, and does not replay it", async () => {
    useComposerPrefill.setState({ items: {} });
    const container = await show({ status: "idle" });
    expect(field(container, "Message").value).toBe("");
    await act(async () => {
      useComposerPrefill.getState().push("sess-1", "batch");
    });
    await settle();
    expect(field(container, "Message").value).toBe("batch");
    await act(async () => {
      useComposerPrefill.getState().push("sess-1", "more");
    });
    await settle();
    expect(field(container, "Message").value).toBe("batch\n\nmore");
  });

  it("leaves the text of another session alone", async () => {
    useComposerPrefill.setState({ items: {} });
    useComposerPrefill.getState().push("sess-2", "not for you");
    const container = await show({ status: "idle" });
    expect(field(container, "Message").value).toBe("");
    expect(useComposerPrefill.getState().take("sess-2")).toBe("not for you");
  });
});

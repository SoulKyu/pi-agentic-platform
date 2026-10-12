// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reportClientIssue } from "../../lib/report.ts";
import { mount, type Mounted } from "../../testing/dom.ts";
import { MessageRow } from "./MessageRow.tsx";

vi.mock("../../lib/report.ts", () => ({ reportClientIssue: vi.fn() }));
// The renderer's chunk "fails to load": the real Markdown calls this when it falls back to plain text.
vi.mock("@pap/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@pap/ui")>()),
  Markdown: ({ text, onLoadError }: { text: string; onLoadError?: () => void }): ReactNode => {
    onLoadError?.();
    return <div data-plain>{text}</div>;
  },
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => () => Promise.resolve() }));

let page: Mounted | null = null;
afterEach(async () => {
  await page?.unmount();
  page = null;
  vi.mocked(reportClientIssue).mockClear();
});

describe("agent text and the markdown renderer", () => {
  it("reports a renderer that failed to load as lazy_chunk_failed, and keeps the text", async () => {
    page = await mount(
      <MessageRow
        item={{ kind: "message", key: "m", author: "agent", text: "hello", thinking: "", entryId: null }}
      />,
    );
    expect(reportClientIssue).toHaveBeenCalledWith("lazy_chunk_failed");
    expect(page.container.querySelector("[data-plain]")?.textContent).toBe("hello");
  });

  it("does not send your own text through markdown", async () => {
    page = await mount(
      <MessageRow
        item={{ kind: "message", key: "m", author: "you", text: "**as typed**", thinking: "", entryId: null }}
      />,
    );
    expect(page.container.querySelector("[data-plain]")).toBeNull();
    expect(page.container.textContent).toContain("**as typed**");
    expect(reportClientIssue).not.toHaveBeenCalled();
  });
});

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
    rendered.texts.push(text);
    return <div data-plain>{text}</div>;
  },
}));
const rendered = vi.hoisted(() => ({ texts: [] as string[] }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => () => Promise.resolve() }));

let page: Mounted | null = null;
afterEach(async () => {
  await page?.unmount();
  page = null;
  vi.mocked(reportClientIssue).mockClear();
  rendered.texts.length = 0;
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

  it("renders a streaming reply block by block and parses only the growing one again", async () => {
    const partial = (text: string) => ({ kind: "partial" as const, key: "p", text, thinking: "" });
    page = await mount(<MessageRow item={partial("p1\n\np2\n\np3")} />);
    expect(rendered.texts).toEqual(["p1", "p2", "p3"]);
    rendered.texts.length = 0;
    await page.rerender(<MessageRow item={partial("p1\n\np2\n\np3 more")} />);
    expect(rendered.texts).toEqual(["p3 more"]);
    expect([...page.container.querySelectorAll("[data-plain]")].map((node) => node.textContent)).toEqual([
      "p1",
      "p2",
      "p3 more",
    ]);
  });

  it("renders a finished message as one Markdown with the whole text", async () => {
    const text = "p1\n\np2\n\np3";
    page = await mount(
      <MessageRow item={{ kind: "message", key: "m", author: "agent", text, thinking: "", entryId: null }} />,
    );
    expect(rendered.texts).toEqual([text]);
  });
});

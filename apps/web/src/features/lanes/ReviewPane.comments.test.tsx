// @vitest-environment happy-dom
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useComposerPrefill } from "../../stores/composer-prefill.ts";
import { button, click, field, hasButton, mount, press, settle, text, typeInto } from "../../testing/dom.ts";
import { current, inShell } from "./lanes-bed.tsx";
import { reviewComment, reviewFile, reviewBed } from "./review-bed.tsx";
import { ReviewPane } from "./ReviewPane.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("@pap/ui/code", async () => (await import("./review-bed.tsx")).mockReviewDiffView());

const opened = vi.fn();
const chat = vi.fn();
const show = async (props: Partial<Parameters<typeof ReviewPane>[0]> = {}) => {
  const page = await mount(
    inShell(
      <ReviewPane
        laneId="a-1a2b"
        worktree="/p/worktrees/a-1a2b"
        sessionId="sess-1"
        sessionLabel="Atlas"
        onOpenFile={opened}
        onOpenChat={chat}
        {...props}
      />,
    ),
  );
  await settle();
  return page;
};
const pickFile = async (container: ParentNode, path: string) => {
  await click(container.querySelector(`[data-review-file="${path}"]`) as Element);
  await settle();
};

beforeEach(() => {
  opened.mockClear();
  chat.mockClear();
  useComposerPrefill.setState({ items: {} });
  localStorage.clear();
});

describe("review pane: comments", () => {
  const withFile = async (options: Parameters<typeof reviewBed>[1] = {}) => {
    const rig = reviewBed([reviewFile("src/a.ts")], options);
    const page = await show();
    await pickFile(page.container, "src/a.ts");
    return { ...rig, page };
  };

  it("opens an editor under the line, and saves the comment with its line, side and excerpt", async () => {
    const { bed, page, server } = await withFile();
    await click(button(page.container, "probe add after 2"));
    expect(page.container.querySelector('[data-probe-editor="2:after"]')).not.toBeNull();
    await typeInto(field(page.container, "Comment"), 'Say "why".');
    await click(button(page.container, "Save"));
    await settle();
    expect(bed.called("lanes.reviewState.set")[0]?.params).toMatchObject({ baseRevision: 1 });
    expect(server.doc.comments).toEqual([
      expect.objectContaining({
        path: "src/a.ts",
        side: "after",
        line: 2,
        excerpt: "TWO",
        body: 'Say "why".',
        sentAt: null,
        resolvedAt: null,
        id: expect.stringMatching(/^[A-Za-z0-9_-]{1,64}$/),
      }),
    ]);
    expect(page.container.querySelector("[data-probe-editor]")).toBeNull();
    expect(text(page.container)).toContain("probe open");
  });

  it("takes the excerpt of a removed line from the before side", async () => {
    const { page, server } = await withFile();
    await click(button(page.container, "probe add before 1"));
    await typeInto(field(page.container, "Comment"), "gone?");
    await click(button(page.container, "Save"));
    await settle();
    expect(server.doc.comments[0]).toMatchObject({ side: "before", line: 1, excerpt: "one" });
  });

  it("keeps the text typed on line A when another line is pressed, and gives it back on return", async () => {
    const { page } = await withFile();
    await click(button(page.container, "probe add after 2"));
    await typeInto(field(page.container, "Comment"), "unsaved thought");
    await click(button(page.container, "probe add before 1"));
    expect(page.container.querySelector('[data-probe-editor="1:before"]')).not.toBeNull();
    expect(field(page.container, "Comment").value).toBe("");
    await click(button(page.container, "probe add after 2"));
    expect(field(page.container, "Comment").value).toBe("unsaved thought");
  });

  it("forgets a draft once it is cancelled", async () => {
    const { page } = await withFile();
    await click(button(page.container, "probe add after 2"));
    await typeInto(field(page.container, "Comment"), "gone");
    await click(button(page.container, "Cancel"));
    await click(button(page.container, "probe add after 2"));
    expect(field(page.container, "Comment").value).toBe("");
  });

  it("cancels with Escape and with Cancel, without saving", async () => {
    const { bed, page } = await withFile();
    await click(button(page.container, "probe add after 2"));
    await typeInto(field(page.container, "Comment"), "draft");
    await press(field(page.container, "Comment"), { key: "Escape" });
    expect(page.container.querySelector("[data-probe-editor]")).toBeNull();
    await click(button(page.container, "probe add after 2"));
    await click(button(page.container, "Cancel"));
    expect(page.container.querySelector("[data-probe-editor]")).toBeNull();
    expect(bed.called("lanes.reviewState.set")).toHaveLength(0);
  });

  it("does not save a blank comment, and stops at 4000 characters", async () => {
    const { page } = await withFile();
    await click(button(page.container, "probe add after 2"));
    expect(button(page.container, "Save").disabled).toBe(true);
    await typeInto(field(page.container, "Comment"), "   ");
    expect(button(page.container, "Save").disabled).toBe(true);
    await typeInto(field(page.container, "Comment"), "x".repeat(4100));
    expect(field(page.container, "Comment").value).toHaveLength(4000);
    expect(text(page.container)).toContain("4000 / 4000");
  });

  it("lists the file's comments with Edit, Resolve and Delete; Edit clears sentAt", async () => {
    const { page, server } = await withFile({
      doc: {
        seen: [],
        comments: [reviewComment("1", { sentAt: 5 }), reviewComment("2", { path: "other.ts" })],
      },
    });
    const list = page.container.querySelector("[data-review-comments]") as HTMLElement;
    expect(text(list)).toContain("body 1");
    expect(text(list)).not.toContain("body 2");
    expect(text(list)).toContain("sent");
    await click(button(list, "Edit"));
    await typeInto(field(page.container, "Comment"), "changed");
    await click(button(page.container, "Save"));
    await settle();
    expect(server.doc.comments[0]).toMatchObject({ id: "1", body: "changed", sentAt: null });
    await click(button(list, "Resolve"));
    await settle();
    expect(server.doc.comments[0]?.resolvedAt).toEqual(expect.any(Number));
    await click(button(list, "Delete"));
    await settle();
    expect(server.doc.comments.map((comment) => comment.id)).toEqual(["2"]);
  });

  it("opens a comment for editing from the diff", async () => {
    const { page } = await withFile({ doc: { seen: [], comments: [reviewComment("1")] } });
    await click(button(page.container, "probe open 1: You · line 2"));
    expect(field(page.container, "Comment").value).toBe("body 1");
  });

  it("draws the comments as text with a heading that names the line, removed lines included", async () => {
    const { page } = await withFile({
      doc: {
        seen: [],
        comments: [reviewComment("1", { body: "<b>x</b>" }), reviewComment("2", { side: "before", line: 1 })],
      },
    });
    expect(text(page.container)).toContain("probe open 1: You · line 2");
    expect(text(page.container)).toContain("probe open 2: You · line 1 (removed)");
    expect(page.container.querySelector("b")).toBeNull();
  });

  it("tells what went wrong when the review cannot be saved", async () => {
    const { bed, page } = await withFile();
    bed.handlers["lanes.reviewState.set"] = () => {
      throw new Error("x");
    };
    await click(button(page.container, "probe add after 2"));
    await typeInto(field(page.container, "Comment"), "kept");
    await click(button(page.container, "Save"));
    await settle();
    expect(text(page.container)).toContain("The review could not be saved.");
  });
});

describe("review pane: sending", () => {
  const withComments = async (props: Partial<Parameters<typeof ReviewPane>[0]> = {}) => {
    const rig = reviewBed([reviewFile("src/a.ts")], {
      doc: {
        seen: [],
        comments: [
          reviewComment("1"),
          reviewComment("2", { line: 7, body: 'say "x"' }),
          reviewComment("3", { resolvedAt: 4 }),
          reviewComment("4", { sentAt: 4 }),
        ],
      },
    });
    const page = await show(props);
    return { ...rig, page };
  };

  it("counts the comments ready and sends them to the session's composer, marks them sent and opens the chat", async () => {
    const { page, server } = await withComments();
    expect(text(page.container)).toContain("2 comments ready");
    await click(button(page.container, "Send to Atlas"));
    await settle();
    const waiting = useComposerPrefill.getState().take("sess-1");
    expect(waiting).toBe(
      [
        "Review comments on the current changes:",
        "",
        "File: src/a.ts",
        "Line: 2",
        "Code: two",
        'User comment: "body 1"',
        "",
        "File: src/a.ts",
        "Line: 7",
        "Code: two",
        'User comment: "say \\"x\\""',
      ].join("\n"),
    );
    expect(server.doc.comments.map((comment) => comment.sentAt === null)).toEqual([
      false,
      false,
      true,
      false,
    ]);
    expect(chat).toHaveBeenCalledExactlyOnceWith("sess-1");
    expect(text(page.container)).toContain("No comments to send");
  });

  it("starts a new session first when asked, and sends to that one", async () => {
    const { bed, page } = await withComments();
    bed.handlers["lanes.newSession"] = () => ({ sessionId: "sess-new" });
    await click(button(page.container, "New session"));
    await settle();
    expect(bed.called("lanes.newSession")[0]).toMatchObject({
      params: { laneId: "a-1a2b" },
      options: { commandId: expect.any(String) },
    });
    expect(useComposerPrefill.getState().take("sess-new")).toContain(
      "Review comments on the current changes:",
    );
    expect(chat).toHaveBeenCalledExactlyOnceWith("sess-new");
  });

  it("sends nothing and keeps the comments unsent when the new session cannot start", async () => {
    const { bed, page, server } = await withComments();
    bed.handlers["lanes.newSession"] = () => {
      throw new Error("x");
    };
    await click(button(page.container, "New session"));
    await settle();
    expect(text(page.container)).toContain("The comments could not be sent.");
    expect(server.doc.comments.filter((comment) => comment.sentAt !== null)).toHaveLength(1);
    expect(chat).not.toHaveBeenCalled();
  });

  it("keeps the batch in the composer's queue only when the review could be marked, and not twice", async () => {
    const { bed, page } = await withComments();
    bed.handlers["lanes.reviewState.set"] = () => {
      throw new Error("x");
    };
    await click(button(page.container, "Send to Atlas"));
    await settle();
    expect(useComposerPrefill.getState().take("sess-1")).toBeNull();
    expect(text(page.container)).toContain("The comments could not be sent.");
    expect(chat).not.toHaveBeenCalled();
  });

  it("has no Send to when there is no session, only New session", async () => {
    const { page } = await withComments({ sessionId: null, sessionLabel: "" });
    expect(hasButton(page.container, "Send to Atlas")).toBe(false);
    expect(hasButton(page.container, "New session")).toBe(true);
  });

  it("turns both buttons off when nothing is ready", async () => {
    reviewBed([reviewFile("a.ts")]);
    const page = await show();
    expect(button(page.container, "Send to Atlas").disabled).toBe(true);
    expect(button(page.container, "New session").disabled).toBe(true);
    await act(async () => {});
  });
});

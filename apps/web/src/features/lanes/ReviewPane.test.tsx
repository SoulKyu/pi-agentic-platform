// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useComposerPrefill } from "../../stores/composer-prefill.ts";
import { button, click, mount, press, settle, text } from "../../testing/dom.ts";
import { menuLabels, openMenu, pickItem } from "../../testing/menu.ts";
import { current, inShell } from "./lanes-bed.tsx";
import { BLOB, FROM, reviewComment, reviewFile, reviewBed, TO } from "./review-bed.tsx";
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

describe("review pane: the list", () => {
  it("lists the files by path with their counts, status words and the Seen progress", async () => {
    reviewBed(
      [
        reviewFile("web/b.tsx", { additions: 77, deletions: 20, status: "A" }),
        reviewFile("a.go", { additions: 12, deletions: 0 }),
        reviewFile("img.png", { binary: true, additions: null, deletions: null }),
      ],
      {
        doc: {
          seen: [{ path: "a.go", identity: BLOB(4) }],
          comments: [reviewComment("1"), reviewComment("2", { resolvedAt: 3 })],
        },
      },
    );
    const page = await show();
    const rows = [...page.container.querySelectorAll("[data-review-file]")].map((row) =>
      row.getAttribute("data-review-file"),
    );
    expect(rows).toEqual(["a.go", "img.png", "web/b.tsx"]);
    const content = text(page.container);
    expect(content).toContain("+12 −0");
    expect(content).toContain("+77 −20");
    expect(content).toContain("binary");
    expect(content).toContain("added");
    expect(content).toContain("Seen 1 / 3");
    expect(content).toContain("1 comment");
    expect(page.container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("1");
    expect(
      page.container
        .querySelector('[data-review-file="a.go"]')
        ?.closest("li")
        ?.querySelector('[role="checkbox"]')
        ?.getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("asks for the branch scope first", async () => {
    const { bed } = reviewBed([reviewFile("a.ts")]);
    await show();
    expect(bed.called("lanes.review")[0]?.params).toEqual({ laneId: "a-1a2b", scope: { kind: "branch" } });
  });

  it("says No changes yet for an empty list", async () => {
    reviewBed([]);
    expect(text((await show()).container)).toContain("No changes yet");
  });

  it("says so when the list was cut at the contract's cap", async () => {
    reviewBed([reviewFile("a.ts")], { list: { truncated: true } });
    expect(text((await show()).container)).toContain("Only the first files are listed");
  });

  it("shows a path as text, hidden characters written out, never as markup", async () => {
    reviewBed([reviewFile("<img src=x onerror=1>‮evil.ts")]);
    const page = await show();
    expect(page.container.querySelector("img")).toBeNull();
    expect(text(page.container)).toContain("<img src=x onerror=1>\\u202Eevil.ts");
  });

  it("shows a rename as old path and new path", async () => {
    reviewBed([reviewFile("new.ts", { oldPath: "old.ts", status: "R" })]);
    const content = text((await show()).container);
    expect(content).toContain("old.ts → new.ts");
    expect(content).toContain("renamed");
  });

  it("offers Try again when the list cannot be read", async () => {
    const { bed } = reviewBed([reviewFile("a.ts")]);
    let fail = true;
    bed.handlers["lanes.review"] = () => {
      if (fail) throw new Error("x");
      return {
        from: { oid: FROM, label: "main" },
        to: { kind: "live", tree: TO },
        files: [],
        truncated: false,
      };
    };
    const page = await show();
    expect(text(page.container)).toContain("The review could not be read");
    fail = false;
    await click(button(page.container, "Try again"));
    await settle();
    expect(text(page.container)).toContain("No changes yet");
  });

  it("moves between the files with the arrow keys and opens one with Enter", async () => {
    reviewBed([reviewFile("a.ts"), reviewFile("b.ts"), reviewFile("c.ts")]);
    const page = await show();
    const rows = () => [...page.container.querySelectorAll<HTMLElement>("[data-review-file]")];
    rows()[0]?.focus();
    await press(rows()[0] as Element, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows()[1]);
    await press(rows()[1] as Element, { key: "ArrowDown" });
    await press(rows()[2] as Element, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows()[2]);
    await press(rows()[2] as Element, { key: "ArrowUp" });
    expect(document.activeElement).toBe(rows()[1]);
    await click(rows()[1] as Element);
    await settle();
    expect(rows()[1]?.getAttribute("aria-current")).toBe("true");
  });
});

describe("review pane: Seen", () => {
  it("ticks a file with its identity and unticks it", async () => {
    const { bed, server } = reviewBed([reviewFile("a.ts", { identity: BLOB(7) })]);
    const page = await show();
    const box = () => page.container.querySelector('[role="checkbox"]') as HTMLElement;
    await click(box());
    await settle();
    expect(bed.called("lanes.reviewState.set")[0]?.params).toMatchObject({
      laneId: "a-1a2b",
      baseRevision: 1,
      doc: { seen: [{ path: "a.ts", identity: BLOB(7) }] },
    });
    expect(box().getAttribute("aria-checked")).toBe("true");
    await click(box());
    await settle();
    expect(server.doc.seen).toEqual([]);
    expect(box().getAttribute("aria-checked")).toBe("false");
  });

  it("shows a file unticked when its identity moved since it was Seen", async () => {
    reviewBed([reviewFile("a.ts", { identity: BLOB(8) })], {
      doc: { seen: [{ path: "a.ts", identity: BLOB(7) }], comments: [] },
    });
    const page = await show();
    expect(page.container.querySelector('[role="checkbox"]')?.getAttribute("aria-checked")).toBe("false");
    expect(text(page.container)).toContain("Seen 0 / 1");
  });
});

describe("review pane: the diff of a file", () => {
  it("reads both sides with vcs.fileDiff, as the sides of the list", async () => {
    const { bed } = reviewBed([reviewFile("new.ts", { oldPath: "old.ts", status: "R" })]);
    const page = await show();
    await pickFile(page.container, "new.ts");
    expect(bed.called("vcs.fileDiff")[0]?.params).toEqual({
      root: "/p/worktrees/a-1a2b",
      path: "new.ts",
      oldPath: "old.ts",
      from: { kind: "commit", oid: FROM },
      to: { kind: "worktree" },
    });
    const probe = page.container.querySelector("[data-slot=diff-probe]");
    expect(probe?.getAttribute("data-before")).toBe("one\ntwo\nthree");
    expect(probe?.getAttribute("data-after")).toBe("one\nTWO\nthree");
  });

  it("reads a committed turn's end against the commit, not the worktree", async () => {
    const { bed } = reviewBed([reviewFile("a.ts")], {
      list: { to: { kind: "commit", oid: TO, label: "turn 2" } },
    });
    const page = await show();
    await pickFile(page.container, "a.ts");
    expect(bed.called("vcs.fileDiff")[0]?.params).toMatchObject({ to: { kind: "commit", oid: TO } });
  });

  it("says Binary file changed without asking for the texts", async () => {
    const { bed } = reviewBed([reviewFile("i.png", { binary: true, additions: null, deletions: null })]);
    const page = await show();
    await pickFile(page.container, "i.png");
    expect(text(page.container)).toContain("Binary file changed");
    expect(bed.called("vcs.fileDiff")).toHaveLength(0);
  });

  it("says Too large to show here when truncated, with Open in Files", async () => {
    reviewBed([reviewFile("big.ts")], {
      texts: { "big.ts": { before: "", after: "", binary: false, truncated: true } },
    });
    const page = await show();
    await pickFile(page.container, "big.ts");
    expect(text(page.container)).toContain("Too large to show here");
    await click(button(page.container, "Open in Files"));
    expect(opened).toHaveBeenCalledExactlyOnceWith("/p/worktrees/a-1a2b/big.ts");
  });

  it("offers Try again when the texts cannot be read", async () => {
    const { bed } = reviewBed([reviewFile("a.ts")]);
    let fail = true;
    bed.handlers["vcs.fileDiff"] = () => {
      if (fail) throw new Error("x");
      return { before: "a", after: "b", binary: false, truncated: false };
    };
    const page = await show();
    await pickFile(page.container, "a.ts");
    expect(text(page.container)).toContain("The file could not be read");
    fail = false;
    await click(button(page.container, "Try again"));
    await settle();
    expect(page.container.querySelector("[data-slot=diff-probe]")?.getAttribute("data-after")).toBe("b");
  });
});

describe("review pane: scopes", () => {
  const turns = [
    { index: 2, userEntryId: "e2", preview: "second ask", from: FROM, to: TO },
    { index: 1, userEntryId: "e1", preview: "first ask", from: null, to: FROM },
  ];

  it("opens a menu of the session's turns, newest first, and reviews the picked one", async () => {
    const { bed } = reviewBed([reviewFile("a.ts")], { turns });
    const page = await show();
    await click(page.container.querySelector('[data-scope="turn"]') as Element);
    await settle();
    expect(bed.called("lanes.turns")[0]?.params).toEqual({ laneId: "a-1a2b", sessionId: "sess-1" });
    await openMenu(button(page.container, "Turns of this session"));
    expect(menuLabels()).toEqual(["Turn 2 · second ask", "Turn 1 · first ask"]);
    await pickItem(button(page.container, "Turns of this session"), "Turn 1 · first ask");
    expect(bed.called("lanes.review").at(-1)?.params).toEqual({
      laneId: "a-1a2b",
      scope: { kind: "turn", sessionId: "sess-1", userEntryId: "e1" },
    });
  });

  it("goes back to the branch scope", async () => {
    const { bed } = reviewBed([reviewFile("a.ts")], { turns });
    const page = await show();
    await click(page.container.querySelector('[data-scope="turn"]') as Element);
    await settle();
    await click(page.container.querySelector('[data-scope="branch"]') as Element);
    await settle();
    expect(bed.called("lanes.review").at(-1)?.params).toEqual({
      laneId: "a-1a2b",
      scope: { kind: "branch" },
    });
  });

  it("asks for a session before it can show turns", async () => {
    const { bed } = reviewBed([reviewFile("a.ts")]);
    const page = await show({ sessionId: null, sessionLabel: "" });
    await click(page.container.querySelector('[data-scope="turn"]') as Element);
    await settle();
    expect(text(page.container)).toContain("Start a session to review its turns");
    expect(bed.called("lanes.turns")).toHaveLength(0);
  });
});

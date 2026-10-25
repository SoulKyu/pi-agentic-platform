// @vitest-environment happy-dom
import type { VcsFile, VcsStatus } from "@pap/contracts";
import { TooltipProvider } from "@pap/ui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { RpcError } from "../../runtime/rpc.ts";
import { useVcsStore } from "../../stores/vcs-store.ts";
import { button, click, mount, settle, text } from "../../testing/dom.ts";
import { vcsFile, vcsStatus } from "../../testing/m8-fixtures.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { ChangesPane } from "./ChangesPane.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
// CodeMirror and the merge view have their own tests (@pap/ui); here the view is a probe of what the pane hands it.
vi.mock("@pap/ui/code", async () => {
  const { createElement } = await import("react");
  return {
    DiffView: (props: { before: string; after: string }) =>
      createElement("div", {
        "data-slot": "diff-probe",
        "data-before": props.before,
        "data-after": props.after,
      }),
    languageFor: () => null,
  };
});

let bed: ReturnType<typeof fakeRuntime>;
beforeEach(() => {
  useVcsStore.getState().reset();
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
});

const provide = (status: VcsStatus | null) =>
  useVcsStore.getState().apply("/p", { kind: "snapshot", status });
const diffs = () => bed.called("vcs.fileDiff").map((call) => call.params);
const answer = (before: string | null, after: string | null, flags = {}) => ({
  before,
  after,
  binary: false,
  truncated: false,
  ...flags,
});

async function show(onOpenFile: (path: string) => void = () => {}) {
  const page = await mount(
    <TooltipProvider>
      <ChangesPane root="/p" onOpenFile={onOpenFile} />
    </TooltipProvider>,
  );
  await settle();
  return page.container;
}
const rowOf = (c: HTMLElement, path: string) => {
  const found = [...c.querySelectorAll<HTMLElement>("[data-path]")].find((row) => row.dataset.path === path);
  if (!found) throw new Error(`no row ${path}`);
  return found;
};
const probe = (c: HTMLElement) => c.querySelector<HTMLElement>('[data-slot="diff-probe"]');
const withFiles = (files: VcsFile[], patch: Partial<VcsStatus> = {}) =>
  provide(vcsStatus("/p", { files, ...patch }));

describe("ChangesPane states", () => {
  it("waits for the first snapshot", async () => {
    const c = await show();
    expect(c.querySelector('[role="status"]')?.getAttribute("aria-label")).toBe("Loading the changes…");
  });

  it("says a folder is not a repository, for a null snapshot and for repo false", async () => {
    provide(null);
    expect(text(await show())).toContain("This folder is not a git repository");
    useVcsStore.getState().reset();
    provide(vcsStatus("/p", { repo: false }));
    expect(text(await show())).toContain("This folder is not a git repository");
  });

  it("says when git is missing, slow or failed, and when there are too many changes", async () => {
    const expected = {
      git_missing: "Git is not installed on the server",
      timeout: "Git took too long; Refresh to try again",
      failed: "Git could not read this folder",
      too_large: "There are too many changes to list",
    } as const;
    for (const [error, words] of Object.entries(expected)) {
      useVcsStore.getState().reset();
      provide(vcsStatus("/p", { error: error as VcsStatus["error"] }));
      const c = await show();
      expect(text(c), error).toContain(words);
    }
  });

  it("says when the list is cut short, and still lists what it has", async () => {
    withFiles([vcsFile("a.ts")], { truncated: true });
    const c = await show();
    expect(text(c)).toContain("Showing the first 2 000 changes");
    expect(rowOf(c, "a.ts")).toBeDefined();
  });

  it("says when nothing changed", async () => {
    withFiles([]);
    expect(text(await show())).toContain("No changes");
  });

  it("says when the stream was refused", async () => {
    bed.handlers["subscribe.vcs"] = () => {
      throw new RpcError("not_found");
    };
    const c = await show();
    expect(text(c)).toContain("The changes of this folder cannot be followed right now");
  });

  it("follows the folder's vcs stream: a snapshot from the server fills the list", async () => {
    const c = await show();
    expect(bed.called("subscribe.vcs").map((call) => call.params)).toEqual([{ root: "/p" }]);
    const { act } = await import("react");
    await act(async () => {
      bed.emitTo("subscribe.vcs", {
        kind: "snapshot",
        status: vcsStatus("/p", { files: [vcsFile("live.ts")] }),
      });
    });
    expect(rowOf(c, "live.ts")).toBeDefined();
  });
});

describe("ChangesPane header and list", () => {
  it("shows the branch, ahead and behind, and the totals", async () => {
    withFiles([vcsFile("a.ts")], {
      branch: "feat/x",
      upstream: "origin/feat/x",
      ahead: 2,
      behind: 1,
      additions: 12,
      deletions: 3,
    });
    const c = await show();
    const header = c.querySelector<HTMLElement>('[data-slot="changes-header"]');
    expect(header?.textContent).toContain("feat/x");
    expect(header?.textContent).toContain("↑2");
    expect(header?.textContent).toContain("↓1");
    expect(header?.textContent).toContain("+12 −3");
  });

  it("says detached for a detached head", async () => {
    withFiles([vcsFile("a.ts")], { branch: null, detached: true });
    expect(text(await show())).toContain("Detached HEAD");
  });

  it("Refresh asks the daemon for the root", async () => {
    withFiles([vcsFile("a.ts")]);
    const c = await show();
    await click(button(c, "Refresh"));
    await settle();
    expect(bed.called("vcs.refresh").map((call) => call.params)).toEqual([{ root: "/p" }]);
  });

  it("says when a refresh failed", async () => {
    withFiles([vcsFile("a.ts")]);
    bed.handlers["vcs.refresh"] = () => {
      throw new RpcError("capacity");
    };
    const c = await show();
    await click(button(c, "Refresh"));
    await settle();
    expect(text(c)).toContain("Could not refresh. Try again.");
  });

  it("groups conflicts, changes and untracked, each row with a word, its path and its counts", async () => {
    withFiles([
      vcsFile("z.ts", { additions: 12, deletions: 3 }),
      vcsFile("fresh.txt", { kind: "untracked", additions: null, deletions: null }),
      vcsFile("both.ts", { kind: "conflicted" }),
      vcsFile("new.ts", { kind: "renamed", oldPath: "old.ts", additions: 0, deletions: 0 }),
    ]);
    const c = await show();
    const headings = [...c.querySelectorAll("h3")].map((h) => h.textContent?.replace(/\s*\d+$/, ""));
    expect(headings).toEqual(["Conflicts", "Changes", "Untracked"]);
    const z = rowOf(c, "z.ts");
    expect(z.textContent).toContain("Modified");
    expect(z.textContent).toContain("+12 −3");
    expect(rowOf(c, "both.ts").textContent).toContain("Conflict");
    expect(rowOf(c, "fresh.txt").textContent).toContain("Untracked");
    expect(rowOf(c, "fresh.txt").textContent).not.toContain("+");
    expect(rowOf(c, "new.ts").textContent).toContain("old.ts → new.ts");
    expect(rowOf(c, "new.ts").textContent).toContain("Renamed");
  });
});

describe("ChangesPane diffs", () => {
  it("loads head against the worktree into the diff view and marks the row current", async () => {
    withFiles([vcsFile("a.ts"), vcsFile("b.ts")]);
    bed.handlers["vcs.fileDiff"] = () => answer("old text", "new text");
    const c = await show();
    expect(diffs()).toEqual([]);
    expect(text(c)).toContain("Select a file to see its changes.");
    await click(rowOf(c, "a.ts"));
    await settle();
    expect(diffs()).toEqual([{ root: "/p", path: "a.ts", from: { kind: "head" }, to: { kind: "worktree" } }]);
    expect(probe(c)?.dataset.before).toBe("old text");
    expect(probe(c)?.dataset.after).toBe("new text");
    expect(rowOf(c, "a.ts").getAttribute("aria-current")).toBe("true");
    expect(rowOf(c, "b.ts").getAttribute("aria-current")).toBeNull();
  });

  it("treats a side git does not have as empty text", async () => {
    withFiles([vcsFile("a.ts", { kind: "untracked" })]);
    bed.handlers["vcs.fileDiff"] = () => answer(null, "fresh");
    const c = await show();
    await click(rowOf(c, "a.ts"));
    await settle();
    expect(probe(c)?.dataset.before).toBe("");
    expect(probe(c)?.dataset.after).toBe("fresh");
  });

  it("gives a rename its old path", async () => {
    withFiles([vcsFile("new.ts", { kind: "renamed", oldPath: "old.ts" })]);
    bed.handlers["vcs.fileDiff"] = () => answer("x", "x");
    const c = await show();
    await click(rowOf(c, "new.ts"));
    await settle();
    expect(diffs()).toEqual([
      { root: "/p", path: "new.ts", oldPath: "old.ts", from: { kind: "head" }, to: { kind: "worktree" } },
    ]);
  });

  it("shows a note for a binary file and asks for no diff", async () => {
    withFiles([vcsFile("logo.png", { binary: true, additions: null, deletions: null })]);
    const c = await show();
    await click(rowOf(c, "logo.png"));
    await settle();
    expect(text(c)).toContain("Binary file changed");
    expect(diffs()).toEqual([]);
    expect(probe(c)).toBeNull();
  });

  it("shows the note when the server finds the file binary", async () => {
    withFiles([vcsFile("blob")]);
    bed.handlers["vcs.fileDiff"] = () => answer(null, null, { binary: true });
    const c = await show();
    await click(rowOf(c, "blob"));
    await settle();
    expect(text(c)).toContain("Binary file changed");
    expect(probe(c)).toBeNull();
  });

  it("says a diff is too large and offers Open in Files with the absolute path", async () => {
    const onOpenFile = vi.fn();
    withFiles([vcsFile("src/big.txt")]);
    bed.handlers["vcs.fileDiff"] = () => answer(null, null, { truncated: true });
    const c = await show(onOpenFile);
    await click(rowOf(c, "src/big.txt"));
    await settle();
    expect(text(c)).toContain("Too large to show here");
    expect(probe(c)).toBeNull();
    await click(button(c, "Open in Files"));
    expect(onOpenFile).toHaveBeenCalledExactlyOnceWith("/p/src/big.txt");
  });

  it("says an untracked folder has no diff and asks for none", async () => {
    withFiles([vcsFile("tmp", { kind: "untracked", folder: true, additions: null, deletions: null })]);
    const c = await show();
    await click(rowOf(c, "tmp"));
    await settle();
    expect(text(c)).toContain("An untracked folder: it has no diff to show.");
    expect(diffs()).toEqual([]);
  });

  it("drops the answer of a file left before it came", async () => {
    withFiles([vcsFile("a.ts"), vcsFile("b.ts")]);
    const pending = new Map<string, (value: unknown) => void>();
    bed.handlers["vcs.fileDiff"] = (params) =>
      new Promise((resolve) => pending.set((params as { path: string }).path, resolve));
    const c = await show();
    await click(rowOf(c, "a.ts"));
    await click(rowOf(c, "b.ts"));
    pending.get("b.ts")?.(answer("b0", "b1"));
    await settle();
    pending.get("a.ts")?.(answer("a0", "a1"));
    await settle();
    expect(probe(c)?.dataset.after).toBe("b1");
    expect(rowOf(c, "b.ts").getAttribute("aria-current")).toBe("true");
  });

  it("drops the older answer of the same file when it comes after the newer one", async () => {
    withFiles([vcsFile("a.ts", { additions: 1 })], { at: 1 });
    const pending: Array<(value: unknown) => void> = [];
    bed.handlers["vcs.fileDiff"] = () => new Promise((resolve) => pending.push(resolve));
    const c = await show();
    await click(rowOf(c, "a.ts"));
    const { act } = await import("react");
    await act(async () => {
      withFiles([vcsFile("a.ts", { additions: 2 })], { at: 2 });
    });
    await settle();
    expect(pending).toHaveLength(2);
    pending[1]?.(answer("n0", "new"));
    await settle();
    pending[0]?.(answer("o0", "old"));
    await settle();
    expect(probe(c)?.dataset.after).toBe("new");
  });

  it("says why a diff failed and retries on request", async () => {
    withFiles([vcsFile("a.ts")]);
    bed.handlers["vcs.fileDiff"] = () => {
      throw new RpcError("timeout");
    };
    const c = await show();
    await click(rowOf(c, "a.ts"));
    await settle();
    expect(text(c)).toContain("Git took too long to produce this diff");
    bed.handlers["vcs.fileDiff"] = () => answer("1", "2");
    await click(button(c, "Retry"));
    await settle();
    expect(diffs()).toHaveLength(2);
    expect(probe(c)?.dataset.after).toBe("2");
  });

  it("reads the diff again when the file's counts move, and not when only the status time does", async () => {
    withFiles([vcsFile("a.ts", { additions: 1 })], { at: 1 });
    bed.handlers["vcs.fileDiff"] = () => answer("0", "1");
    const c = await show();
    await click(rowOf(c, "a.ts"));
    await settle();
    expect(diffs()).toHaveLength(1);
    const { act } = await import("react");
    await act(async () => {
      withFiles([vcsFile("a.ts", { additions: 1 })], { at: 2 });
    });
    await settle();
    expect(diffs()).toHaveLength(1);
    await act(async () => {
      withFiles([vcsFile("a.ts", { additions: 2 })], { at: 3 });
    });
    await settle();
    expect(diffs()).toHaveLength(2);
  });

  it("goes back to the prompt when the selected file leaves the list", async () => {
    withFiles([vcsFile("a.ts"), vcsFile("b.ts")]);
    bed.handlers["vcs.fileDiff"] = () => answer("0", "1");
    const c = await show();
    await click(rowOf(c, "a.ts"));
    await settle();
    const { act } = await import("react");
    await act(async () => {
      withFiles([vcsFile("b.ts")], { at: 2 });
    });
    await settle();
    expect(probe(c)).toBeNull();
    expect(text(c)).toContain("Select a file to see its changes.");
  });

  it("never renders git's text as markup", async () => {
    withFiles([vcsFile("<img src=x onerror=alert(1)>.ts")]);
    const c = await show();
    expect(c.querySelector("img")).toBeNull();
    expect(text(c)).toContain("<img src=x onerror=alert(1)>.ts");
  });
});

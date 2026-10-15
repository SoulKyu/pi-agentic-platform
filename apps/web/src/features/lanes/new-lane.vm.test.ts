import type { IssueView, LanePreview, ModelsOverview } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import {
  addSlot,
  baseOptions,
  canCreate,
  createParams,
  emptyDraft,
  HEAD_BASE,
  isForeignBase,
  modelChoices,
  prefillDraft,
  removeSlot,
  setModel,
  withBranch,
  withIssue,
  withText,
  withTitle,
} from "./new-lane.vm.ts";

const oid = "a".repeat(40);
const preview = (patch: Partial<LanePreview> = {}): LanePreview => ({
  repo: true,
  current: "main",
  refs: [
    { ref: "refs/heads/feature", label: "feature", oid, at: 3, inLineage: false },
    { ref: "refs/heads/main", label: "main", oid, at: 2, inLineage: true },
    { ref: "refs/remotes/origin/main", label: "origin/main", oid, at: 2, inLineage: true },
    { ref: "refs/remotes/origin/theirs", label: "origin/theirs", oid, at: 1, inLineage: false },
  ],
  config: {
    found: true,
    error: null,
    warnings: [],
    branchPrefix: "pi/",
    waitForSetup: true,
    copy: [],
    link: [],
    scripts: [],
  },
  remote: null,
  forge: null,
  ...patch,
});
const issue: IssueView = {
  forge: "github",
  url: "https://github.com/o/r/issues/412",
  number: 412,
  title: "HighMemory on api pods",
  body: "text",
  state: "open",
  labels: ["bug"],
  truncated: false,
};

describe("title and branch prefills", () => {
  it("the title is the description's first line and the branch is prefix + slug", () => {
    const draft = withText(emptyDraft(), "Fix the cache\nand more", "pi/");
    expect(draft.title).toBe("Fix the cache");
    expect(draft.branch).toBe("pi/fix-the-cache");
  });

  it("an issue's title prefills both, over the pasted link", () => {
    const pasted = withText(emptyDraft(), issue.url, "pi/");
    expect(pasted.title).toBe("");
    expect(pasted.branch).toBe("");
    const fetched = withIssue(pasted, issue, "pi/");
    expect(fetched.title).toBe("HighMemory on api pods");
    expect(fetched.branch).toBe("pi/highmemory-on-api-pods");
  });

  it("a hand-edited title and a hand-edited branch survive later typing", () => {
    let draft = withText(emptyDraft(), "first", "pi/");
    draft = withTitle(draft, "My own title", "pi/");
    expect(draft.branch).toBe("pi/my-own-title");
    draft = withBranch(draft, "feat/mine");
    draft = withText(draft, "second thing", "pi/");
    draft = withTitle(draft, "Another", "pi/");
    expect(draft).toMatchObject({ title: "Another", branch: "feat/mine" });
    draft = withText(draft, "third", "pi/");
    expect(draft.title).toBe("Another");
  });

  it("an answer for a link the field no longer holds is not applied", () => {
    const edited = withText(emptyDraft(), "https://github.com/o/r/issues/413", "pi/");
    expect(withIssue(edited, issue, "pi/")).toBe(edited);
    const typed = withText(emptyDraft(), "something else", "pi/");
    expect(withIssue(typed, issue, "pi/").issue).toBeNull();
  });

  it("editing the pasted link after the fetch drops the issue", () => {
    const fetched = withIssue(withText(emptyDraft(), issue.url, "pi/"), issue, "pi/");
    expect(withText(fetched, `${issue.url}  `, "pi/").issue).not.toBeNull();
    expect(withText(fetched, "https://github.com/o/r/issues/413", "pi/").issue).toBeNull();
  });
});

describe("description cap", () => {
  it("keeps at most the 20 000 characters the daemon takes", () => {
    expect(withText(emptyDraft(), "x".repeat(25_000), "pi/").text).toHaveLength(20_000);
  });
});

describe("branch check", () => {
  it("accepts the prefill and refuses what BranchName refuses", () => {
    const ok = withText(emptyDraft(), "Fix it", "pi/");
    expect(canCreate(ok)).toBe(true);
    for (const bad of ["a..b", "has space", "x.lock", "HEAD", "-lead"])
      expect(canCreate(withBranch(ok, bad)), bad).toBe(false);
  });

  it("an empty branch is left to the daemon, and an empty title or description blocks Create", () => {
    const ok = withText(emptyDraft(), "Fix it", "pi/");
    expect(canCreate(withBranch(ok, ""))).toBe(true);
    expect(canCreate(withTitle(ok, "   ", "pi/"))).toBe(false);
    expect(canCreate(emptyDraft())).toBe(false);
    expect(canCreate(withIssue(withText(emptyDraft(), issue.url, "pi/"), issue, "pi/"))).toBe(true);
  });
});

describe("base refs", () => {
  it("the current branch comes first and is not listed twice", () => {
    const options = baseOptions(preview(), "main (current)");
    expect(options.map((one) => one.value)).toEqual([
      HEAD_BASE,
      "refs/heads/feature",
      "refs/remotes/origin/main",
      "refs/remotes/origin/theirs",
    ]);
    expect(options[0]?.label).toBe("main (current)");
  });

  it("a detached HEAD lists every ref", () => {
    expect(baseOptions(preview({ current: null }), "HEAD (detached)")).toHaveLength(5);
  });

  it("a base outside the HEAD lineage is someone else's, by the daemon's answer and not by the name", () => {
    const view = preview();
    expect(isForeignBase(HEAD_BASE, view)).toBe(false);
    expect(isForeignBase("refs/heads/main", view)).toBe(false);
    expect(isForeignBase("refs/remotes/origin/main", view)).toBe(false);
    expect(isForeignBase("refs/remotes/origin/theirs", view)).toBe(true);
    // a local branch is flagged the same way: `gh pr checkout` makes local branches of other people's work
    expect(isForeignBase("refs/heads/feature", view)).toBe(true);
    expect(isForeignBase("refs/heads/unknown", view)).toBe(false);
  });
});

describe("models and fan-out", () => {
  const overview = {
    providers: [
      {
        id: "anthropic",
        models: [
          { provider: "anthropic", id: "sonnet", name: "Sonnet", reasoning: true, enabled: true },
          { provider: "anthropic", id: "opus", name: "Opus", reasoning: true, enabled: false },
        ],
      },
      {
        id: "openai",
        models: [{ provider: "openai", id: "gpt", name: "GPT", reasoning: false, enabled: true }],
      },
    ],
  } as unknown as ModelsOverview;

  it("offers the enabled models only", () => {
    expect(modelChoices(overview).map((one) => `${one.provider}/${one.id}`)).toEqual([
      "anthropic/sonnet",
      "openai/gpt",
    ]);
  });

  it("starts with one lane on Pi's default and adds up to four", () => {
    let draft = withText(emptyDraft(), "Fix it", "pi/");
    expect(draft.slots).toHaveLength(1);
    for (let i = 0; i < 6; i++) draft = addSlot(draft);
    expect(draft.slots).toHaveLength(4);
    draft = removeSlot(draft, draft.slots[1]?.key ?? -1);
    expect(draft.slots).toHaveLength(3);
    draft = removeSlot(draft, draft.slots[0]?.key ?? -1);
    draft = removeSlot(draft, draft.slots[0]?.key ?? -1);
    expect(draft.slots).toHaveLength(1);
    expect(removeSlot(draft, draft.slots[0]?.key ?? -1).slots).toHaveLength(1);
  });

  it("sends one model per lane, null for Pi's default", () => {
    let draft = addSlot(withText(emptyDraft(), "Fix it", "pi/"));
    draft = setModel(draft, draft.slots[1]?.key ?? -1, { provider: "anthropic", modelId: "sonnet" });
    expect(createParams(draft, "/p").models).toEqual([null, { provider: "anthropic", modelId: "sonnet" }]);
  });
});

describe("create params", () => {
  it("sends the description, the branch and an explicit base only when picked", () => {
    const draft = withText(emptyDraft(), "Fix the cache", "pi/");
    expect(createParams(draft, "/p")).toEqual({
      projectRoot: "/p",
      title: "Fix the cache",
      description: "Fix the cache",
      branch: "pi/fix-the-cache",
      models: [null],
    });
    expect(createParams({ ...draft, base: "refs/remotes/origin/main" }, "/p")).toMatchObject({
      baseRef: "refs/remotes/origin/main",
    });
  });

  it("carries the fetched issue as the daemon gave it", () => {
    const draft = withIssue(withText(emptyDraft(), issue.url, "pi/"), issue, "pi/");
    expect(createParams(draft, "/p")).toMatchObject({
      title: issue.title,
      description: issue.url,
      issue,
    });
  });

  it("prefills Run again with the text, a slot per model, and no invented branch", () => {
    const sonnet = { provider: "anthropic", modelId: "sonnet" };
    const draft = prefillDraft("Replace the cache\nkeep the API", [null, sonnet]);
    expect(draft).toMatchObject({
      text: "Replace the cache\nkeep the API",
      title: "Replace the cache",
      branch: "",
    });
    expect(draft.slots.map((slot) => slot.model)).toEqual([null, sonnet]);
    expect(canCreate(draft)).toBe(true);
    expect(prefillDraft("x", [null, null, null, null, null]).slots).toHaveLength(4);
    expect(prefillDraft("x", []).slots).toHaveLength(1);
  });
});

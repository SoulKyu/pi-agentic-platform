// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError } from "../../runtime/rpc.ts";
import { alerts, button, click, field, hasButton, press, settle } from "../../testing/dom.ts";
import { current, newBed } from "./lanes-bed.tsx";
import {
  body,
  calls,
  choose,
  issue,
  open,
  other,
  preview,
  project,
  resetCalls,
  say,
} from "./new-lane-bed.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

beforeEach(resetCalls);

describe("new lane dialog: the plain case", () => {
  it("reads the project and prefills the title and the branch from the description", async () => {
    const { bed } = await open();
    expect(bed.called("lanes.preview")[0]?.params).toEqual({ projectRoot: "/w/proj" });
    expect(bed.called("models.overview")[0]?.params).toEqual({ cwd: "/w/proj" });
    await say("Issue or description", "Fix the cache\nit leaks");
    expect((field(document.body, "Title") as HTMLInputElement).value).toBe("Fix the cache");
    expect((field(document.body, "Branch") as HTMLInputElement).value).toBe("pi/fix-the-cache");
  });

  it("creates under a command id and hands the result over", async () => {
    const { bed } = await open();
    await say("Issue or description", "Fix the cache");
    await click(button(document.body, "Create lane"));
    await settle();
    const call = bed.called("lanes.create")[0];
    expect(call?.params).toEqual({
      projectRoot: "/w/proj",
      title: "Fix the cache",
      description: "Fix the cache",
      branch: "pi/fix-the-cache",
      models: [null],
    });
    expect(call?.options?.commandId).toMatch(/^bed-cmd-/);
    expect(calls.created).toHaveBeenCalledWith({ laneIds: ["fix-it-1a2b"], fanoutId: null });
    expect(calls.closed).toHaveBeenCalledTimes(1);
  });

  it("checks a hand-edited branch against the branch rule and blocks Create", async () => {
    await open();
    await say("Issue or description", "Fix the cache");
    await say("Branch", "bad..name");
    expect(body()).toContain("This is not a branch name pap can create.");
    expect(button(document.body, "Create lane").disabled).toBe(true);
    await say("Branch", "feat/good");
    expect(button(document.body, "Create lane").disabled).toBe(false);
  });

  it("Ctrl+Enter in the description creates", async () => {
    const { bed } = await open();
    await say("Issue or description", "Fix the cache");
    await press(field(document.body, "Issue or description"), { key: "Enter", ctrlKey: true });
    await settle();
    expect(bed.called("lanes.create")).toHaveLength(1);
  });

  it("says a folder that is not a repository cannot hold lanes", async () => {
    await open(preview({ repo: false, refs: [], current: null }));
    expect(body()).toContain("Lanes need the top level of a git repository");
    expect(button(document.body, "Create lane").disabled).toBe(true);
  });

  it("shows the base choices with the current branch first, and a note only for a base outside the HEAD line", async () => {
    await open();
    expect(body()).not.toContain("Someone else's branch");
    await choose("From", "origin/main");
    expect(body()).not.toContain("Someone else's branch");
    await choose("From", "origin/theirs");
    expect(body()).toContain("Someone else's branch: its package scripts run in your setup");
    await say("Issue or description", "Fix");
    await click(button(document.body, "Create lane"));
    await settle();
  });

  it("sends the picked base", async () => {
    const { bed } = await open();
    await say("Issue or description", "Fix");
    await choose("From", "origin/theirs");
    await click(button(document.body, "Create lane"));
    await settle();
    expect(bed.called("lanes.create")[0]?.params).toMatchObject({ baseRef: "refs/remotes/origin/theirs" });
  });

  it("says GitHub issues only for now", async () => {
    await open();
    expect(body()).toContain("GitHub issues only for now");
  });
});

describe("new lane dialog: refusals", () => {
  it.each([
    ["not_found", "This project or base is gone"],
    ["bad_request", "pap refused the title, the branch or the base"],
    ["conflict", "A lane or a branch with this name exists already"],
    ["limit_reached", "You have 64 open lanes"],
    ["capacity", "Four lanes are being created already"],
    ["read_only", "read-only"],
    ["timeout", "may still have gone through"],
  ] as const)("a %s answer is said in words and keeps the dialog open", async (code, words) => {
    const { bed } = await open();
    bed.handlers["lanes.create"] = () => {
      throw new RpcError(code);
    };
    await say("Issue or description", "Fix");
    await click(button(document.body, "Create lane"));
    await settle();
    expect(alerts(document.body).join(" ")).toContain(words);
    expect(calls.closed).not.toHaveBeenCalled();
    expect(button(document.body, "Create lane").disabled).toBe(false);
  });
});

describe("new lane dialog: an issue", () => {
  const paste = async (bed: ReturnType<typeof newBed>, answer: unknown = { ok: true, issue }) => {
    bed.handlers["lanes.issue"] = () => answer;
    await say("Issue or description", issue.url);
  };

  it("offers Fetch only for a link the daemon would take", async () => {
    await open();
    expect(hasButton(document.body, "Fetch issue")).toBe(false);
    await say("Issue or description", "see https://github.com/o/r/issues/412");
    expect(hasButton(document.body, "Fetch issue")).toBe(false);
    await say("Issue or description", issue.url);
    expect(hasButton(document.body, "Fetch issue")).toBe(true);
  });

  it("shows the issue as text in the dashed UNTRUSTED frame and prefills the title and branch", async () => {
    const { bed } = await open();
    await paste(bed);
    await click(button(document.body, "Fetch issue"));
    await settle();
    expect(bed.called("lanes.issue")[0]?.params).toEqual({ projectRoot: "/w/proj", url: issue.url });
    const card = document.querySelector('[data-slot="fence"]') as HTMLElement;
    expect(card.className).toContain("border-dashed");
    expect(card.querySelector("figcaption")?.textContent).toBe("UNTRUSTED · github issue");
    expect(card.textContent).toContain(issue.title);
    expect(card.textContent).toContain("o/r");
    expect(card.textContent).toContain("open");
    expect(card.textContent).toContain("bug");
    // the body is text, never markup
    expect(card.querySelector("img")).toBeNull();
    expect(card.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(card.innerHTML).not.toContain("<img");
    expect((field(document.body, "Title") as HTMLInputElement).value).toBe(issue.title);
    expect((field(document.body, "Branch") as HTMLInputElement).value).toBe(
      "pi/highmemory-on-api-pods-after-1-18",
    );
  });

  it("collapses the body to three lines", async () => {
    const { bed } = await open();
    await paste(bed);
    await click(button(document.body, "Fetch issue"));
    await settle();
    expect(document.querySelector("[data-issue-body]")?.className).toContain("line-clamp-3");
  });

  it("creates with the fetched issue", async () => {
    const { bed } = await open();
    await paste(bed);
    await click(button(document.body, "Fetch issue"));
    await settle();
    await click(button(document.body, "Create lane"));
    await settle();
    expect(bed.called("lanes.create")[0]?.params).toMatchObject({ issue, description: issue.url });
  });

  it("ignores an answer that arrives after the link was edited, so Create cannot send issue A for link B", async () => {
    const { bed } = await open();
    let answer: (value: unknown) => void = () => {};
    bed.handlers["lanes.issue"] = () => new Promise((resolve) => (answer = resolve));
    await say("Issue or description", issue.url);
    await click(button(document.body, "Fetch issue"));
    await say("Issue or description", "https://github.com/o/r/issues/413");
    answer({ ok: true, issue });
    await settle();
    expect(document.querySelector('[data-slot="fence"]')).toBeNull();
    await say("Title", "Mine");
    await click(button(document.body, "Create lane"));
    await settle();
    const params = bed.called("lanes.create")[0]?.params as Record<string, unknown>;
    expect(params.issue).toBeUndefined();
    expect(params.description).toBe("https://github.com/o/r/issues/413");
  });

  it("drops the card when the link is edited", async () => {
    const { bed } = await open();
    await paste(bed);
    await click(button(document.body, "Fetch issue"));
    await settle();
    await say("Issue or description", `${issue.url.slice(0, -1)}9`);
    expect(document.querySelector('[data-slot="fence"]')).toBeNull();
  });

  it("an unsupported link is told in the brief's words", async () => {
    const { bed } = await open();
    await paste(bed, { ok: false, reason: "unsupported_url" });
    await click(button(document.body, "Fetch issue"));
    await settle();
    expect(alerts(document.body).join(" ")).toContain(
      "Only GitHub issues of this project's forge can be fetched; paste the text instead",
    );
  });

  it.each([
    ["forge_missing", "not installed"],
    ["not_signed_in", "not signed in"],
    ["not_found", "not found"],
    ["failed", "could not be fetched"],
  ] as const)("a %s answer is said in words", async (reason, words) => {
    const { bed } = await open();
    await paste(bed, { ok: false, reason });
    await click(button(document.body, "Fetch issue"));
    await settle();
    expect(alerts(document.body).join(" ")).toContain(words);
  });
});

describe("new lane dialog: the project and the keyboard", () => {
  it("asks which project when there are several, and reads the one picked", async () => {
    const { bed } = await open(preview(), [project, other]);
    await choose("Project", "other");
    expect(bed.called("lanes.preview").map((call) => call.params)).toEqual([
      { projectRoot: "/w/proj" },
      { projectRoot: "/w/other" },
    ]);
  });

  it("Escape closes and gives the focus back to the opener", async () => {
    const { trigger } = await open();
    expect(document.querySelector('[data-slot="dialog"]')?.contains(document.activeElement)).toBe(true);
    await press(document.activeElement as Element, { key: "Escape" });
    await settle();
    expect(calls.closed).toHaveBeenCalled();
    expect(trigger.isConnected).toBe(true);
  });

  it("puts the first focus in the description", async () => {
    await open();
    expect(document.activeElement).toBe(field(document.body, "Issue or description"));
  });
});

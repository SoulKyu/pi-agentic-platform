import { describe, expect, it } from "vitest";
import { checksOf, GhIssue, GhPr, issueViewOf, prViewOf } from "./github-json.ts";

const pr = { number: 3, url: "https://github.com/o/r/pull/3", state: "OPEN", isDraft: false };

describe("github json", () => {
  it("counts a five-check rollup", () => {
    const rollup = [
      { conclusion: "SUCCESS" },
      { conclusion: "SKIPPED" },
      { conclusion: "FAILURE" },
      { status: "IN_PROGRESS", conclusion: "" },
      { state: "PENDING" },
    ];
    expect(checksOf(rollup)).toEqual({ total: 5, passed: 2, failed: 1, pending: 2 });
  });
  it("maps mergeable to conflicts", () => {
    expect(prViewOf(GhPr.parse({ ...pr, mergeable: "CONFLICTING" }), 1).conflicts).toBe(true);
    expect(prViewOf(GhPr.parse({ ...pr, mergeable: "MERGEABLE" }), 1).conflicts).toBe(false);
    expect(prViewOf(GhPr.parse({ ...pr, mergeable: "UNKNOWN" }), 1).conflicts).toBeNull();
    expect(prViewOf(GhPr.parse(pr), 1).conflicts).toBeNull();
  });
  it("maps the state in lower case", () => {
    expect(prViewOf(GhPr.parse({ ...pr, state: "MERGED" }), 9)).toMatchObject({
      state: "merged",
      checkedAt: 9,
      error: null,
    });
  });
  it("refuses an unknown state and an issue without a body", () => {
    expect(GhPr.safeParse({ ...pr, state: "LOCKED" }).success).toBe(false);
    expect(GhIssue.safeParse({ number: 1, title: "t", state: "OPEN", labels: [], url: "u" }).success).toBe(
      false,
    );
  });
  it("keeps a field the contract does not know out of the view", () => {
    const view = prViewOf(GhPr.parse({ ...pr, extra: "secret" }), 1);
    expect(Object.keys(view).sort()).toEqual([
      "checkedAt",
      "checks",
      "conflicts",
      "draft",
      "error",
      "number",
      "state",
      "url",
    ]);
    const issue = issueViewOf(
      GhIssue.parse({ number: 1, title: "t", body: "b", state: "OPEN", labels: [], url: "u", extra: 1 }),
    );
    expect(Object.keys(issue).sort()).toEqual([
      "body",
      "forge",
      "labels",
      "number",
      "state",
      "title",
      "truncated",
      "url",
    ]);
  });
  it("drops variation selectors U+E0100-E01EF and U+2028/2029 along with bidi and tag characters", () => {
    const issue = issueViewOf(
      GhIssue.parse({
        number: 1,
        title: "a\u{E0100}b\u{E01EF}c\u2028d",
        body: "x\u2029y\u202Ez\u{E0049}\n\tw",
        state: "OPEN",
        labels: [],
        url: "u",
      }),
    );
    expect(issue.title).toBe("abcd");
    expect(issue.body).toBe("xyz\n\tw");
  });
  it("clips the title, the body and the labels, and drops NUL", () => {
    const labels = Array.from({ length: 30 }, (_, i) => ({ name: `l${i}`.padEnd(80, "x") }));
    const issue = issueViewOf(
      GhIssue.parse({
        number: 1,
        title: `a\0${"t".repeat(300)}`,
        body: "b".repeat(30_000),
        state: "OPEN",
        labels,
        url: "u",
      }),
    );
    expect(issue.title).toHaveLength(256);
    expect(issue.title).not.toContain("\0");
    expect(issue.body).toHaveLength(20_000);
    expect(issue.truncated).toBe(true);
    expect(issue.labels).toHaveLength(20);
    expect(issue.labels[0]).toHaveLength(64);
    expect(
      issueViewOf(GhIssue.parse({ number: 1, title: "t", body: "b", state: "OPEN", labels: [], url: "u" }))
        .truncated,
    ).toBe(false);
  });
  it("strips format and control characters, keeps newline and tab", () => {
    const tags = String.fromCodePoint(0xe0049, 0xe0067, 0xe006e);
    const raw = `ok\u202e\u200b${tags}\u0007\u0085\r a\tb\nc`;
    const issue = issueViewOf(
      GhIssue.parse({ number: 1, title: raw, body: raw, state: "OPEN", labels: [{ name: raw }], url: "u" }),
    );
    expect(issue.title).toBe("ok a\tb\nc");
    expect(issue.body).toBe("ok a\tb\nc");
    expect(issue.labels).toEqual(["ok a\tb\nc"]);
  });
});

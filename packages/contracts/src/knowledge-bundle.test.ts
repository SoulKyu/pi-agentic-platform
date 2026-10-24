import { describe, expect, it } from "vitest";
import { isOkfIndex, OKF_INDEX_TEXT } from "./knowledge-bundle.ts";

describe("isOkfIndex", () => {
  it("accepts an okf_version 0.x line (frontmatter block or not)", () => {
    expect(isOkfIndex(OKF_INDEX_TEXT)).toBe(true);
    expect(isOkfIndex('---\nokf_version: "0.12"\n---\n# x')).toBe(true);
    expect(isOkfIndex('okf_version: "0.3"\n')).toBe(true);
  });

  it("refuses a missing, unquoted or other-major version", () => {
    for (const head of [
      "",
      "# Knowledge\n",
      "---\nokf_version: 0.2\n---\n",
      '---\nokf_version: "1.0"\n---\n',
    ])
      expect(isOkfIndex(head), head).toBe(false);
  });
});

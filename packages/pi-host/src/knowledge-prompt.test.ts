import { describe, expect, it } from "vitest";
import { knowledgePrompt } from "./knowledge-prompt.ts";

describe("the knowledge section of the system prompt", () => {
  for (const path of ["/work/api/knowledge", "/agent/knowledge"]) {
    it(`names ${path}, its index and its log`, () => {
      const text = knowledgePrompt(path);
      expect(text).toContain(`${path}/index.md`);
      expect(text).toContain(`${path}/log.md`);
      expect(text).toContain(`the folder ${path}.`);
    });
  }

  it("asks for one file per concept with the OKF frontmatter, and an index that lists them", () => {
    const text = knowledgePrompt("/k");
    expect(text).toContain("one markdown file per concept");
    for (const key of ["type", "title", "description", "tags", "generated", "sources"])
      expect(text).toContain(key);
    expect(text).toContain("index.md listing");
  });

  it("forbids secrets and marks what follows external content as a draft", () => {
    const text = knowledgePrompt("/k");
    expect(text).toContain("Never store secrets");
    expect(text).toContain("status: draft");
    expect(text).toContain("no verified");
    expect(text).toMatch(/draft and unverified concepts are hints, not truth/i);
  });

  it("is short and fixed", () => {
    expect(knowledgePrompt("/k").length).toBeLessThan(900);
    expect(knowledgePrompt("/k")).toBe(knowledgePrompt("/k"));
  });
});

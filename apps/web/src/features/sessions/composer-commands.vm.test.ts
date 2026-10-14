import { describe, expect, it } from "vitest";
import {
  activeTrigger,
  completeCommand,
  MAX_ROWS,
  pickSkill,
  rowsFor,
  skillPrefix,
  stripSkillPrefix,
  type ListedCommand,
} from "./composer-commands.vm.ts";

const command = (
  name: string,
  source: ListedCommand["source"] = "extension",
  description: string | null = null,
) => ({ name, description, source, builtinMcp: false }) satisfies ListedCommand;

describe("activeTrigger", () => {
  it("finds a / at the start of the text and the query typed after it", () => {
    expect(activeTrigger("/re", 3)).toEqual({ char: "/", query: "re", start: 0 });
    expect(activeTrigger("/", 1)).toEqual({ char: "/", query: "", start: 0 });
  });

  it("finds a $ at the start of a word", () => {
    expect(activeTrigger("see $pd", 7)).toEqual({ char: "$", query: "pd", start: 4 });
    expect(activeTrigger("$pd", 3)).toEqual({ char: "$", query: "pd", start: 0 });
  });

  it("finds nothing for a $ inside a word, a / that is not first, a blank before the caret or a caret before the sigil", () => {
    expect(activeTrigger("a$b", 3)).toBeNull();
    expect(activeTrigger("see /re", 7)).toBeNull();
    expect(activeTrigger("/re ", 4)).toBeNull();
    expect(activeTrigger("see $pd", 3)).toBeNull();
    expect(activeTrigger("", 0)).toBeNull();
  });

  it("reads the query only up to the caret", () => {
    expect(activeTrigger("/review", 3)).toEqual({ char: "/", query: "re", start: 0 });
  });
});

describe("skill prefix", () => {
  it("is /skill:<name> and a blank at the start of the text", () => {
    expect(skillPrefix("/skill:pdf please")).toBe("pdf");
    expect(skillPrefix("/skill:pdf")).toBeNull();
    expect(skillPrefix("please /skill:pdf ")).toBeNull();
    expect(skillPrefix("/skills:pdf x")).toBeNull();
  });

  it("is removed with its blank", () => {
    expect(stripSkillPrefix("/skill:pdf please")).toBe("please");
    expect(stripSkillPrefix("no prefix")).toBe("no prefix");
  });
});

describe("picking", () => {
  it("completes /<name> and a blank in place of the typed token", () => {
    expect(completeCommand("/re", { char: "/", query: "re", start: 0 }, "review")).toEqual({
      text: "/review ",
      caret: 8,
    });
  });

  it("puts /skill:<name> at the start of the text and takes the $token out", () => {
    expect(pickSkill("please $pd", { char: "$", query: "pd", start: 7 }, "pdf")).toEqual({
      text: "/skill:pdf please ",
      caret: 11,
    });
  });

  it("leaves one space where a mid-text $token was", () => {
    expect(pickSkill("see $pd now", { char: "$", query: "pd", start: 4 }, "pdf")).toEqual({
      text: "/skill:pdf see now",
      caret: 11,
    });
  });

  it("swaps a skill already chosen: one skill per message (M7R141)", () => {
    expect(pickSkill("/skill:old do it $pd", { char: "$", query: "pd", start: 17 }, "pdf")).toEqual({
      text: "/skill:pdf do it ",
      caret: 11,
    });
  });

  it("turns a / token into the skill prefix alone", () => {
    expect(pickSkill("/pd", { char: "/", query: "pd", start: 0 }, "pdf")).toEqual({
      text: "/skill:pdf ",
      caret: 11,
    });
  });
});

describe("rowsFor", () => {
  const all = [
    command("review", "prompt", "Review the diff"),
    command("mcp"),
    command("skill:pdf", "skill", "Read PDFs"),
    command("skill:docx", "skill"),
  ];

  it("lists everything for a bare /, prefix matches first, then the others", () => {
    expect(rowsFor(all, { char: "/", query: "", start: 0 }).map((row) => row.label)).toEqual([
      "/review",
      "/mcp",
      "/skill:pdf",
      "/skill:docx",
    ]);
    expect(rowsFor(all, { char: "/", query: "pdf", start: 0 }).map((row) => row.label)).toEqual([
      "/skill:pdf",
    ]);
    expect(rowsFor(all, { char: "/", query: "s", start: 0 }).map((row) => row.label)).toEqual([
      "/skill:pdf",
      "/skill:docx",
    ]);
  });

  it("offers skills only after a $, named without the skill: prefix", () => {
    const rows = rowsFor(all, { char: "$", query: "p", start: 0 });
    expect(rows.map((row) => [row.label, row.skill])).toEqual([["$pdf", "pdf"]]);
  });

  it("clips an untrusted description to 200 characters and caps the rows at 50", () => {
    const long = command("big", "prompt", "d".repeat(500));
    expect(rowsFor([long], { char: "/", query: "", start: 0 })[0]?.description).toHaveLength(200);
    const many = Array.from({ length: 80 }, (_, index) => command(`c${index}`));
    expect(rowsFor(many, { char: "/", query: "", start: 0 })).toHaveLength(MAX_ROWS);
  });

  it("leaves out a name that has a blank, a control or an invisible character", () => {
    const hostile = [command("a b"), command("a\nb"), command("a‮b"), command("a​b"), command("fine")];
    expect(rowsFor(hostile, { char: "/", query: "", start: 0 }).map((row) => row.label)).toEqual(["/fine"]);
  });

  it("flags the built-in /mcp row", () => {
    const rows = rowsFor([{ ...command("mcp"), builtinMcp: true }], { char: "/", query: "m", start: 0 });
    expect(rows[0]?.builtinMcp).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import {
  PromptTemplateName,
  TemplateBody,
  TemplateDescription,
  TemplatesSaveParams,
} from "./prompt-templates.ts";

const ok = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;

describe("prompt template contracts", () => {
  it("a name is 1 to 64 lower-case letters, digits and -, starting with a letter or a digit", () => {
    for (const name of ["review", "a", "x-1", "9lives", "a".repeat(64)])
      expect(ok(PromptTemplateName, name), name).toBe(true);
    for (const name of ["", "-a", "A", "a_b", "a/b", "..", "a.md", "a".repeat(65)])
      expect(ok(PromptTemplateName, name), name).toBe(false);
  });

  it("Pi's built-in names are refused", () => {
    for (const name of ["compact", "reload", "model"]) expect(ok(PromptTemplateName, name), name).toBe(false);
  });

  it("a description is one plain line of at most 200 characters", () => {
    for (const text of ["a\nb", "a\tb", "a\u0000b", `a${String.fromCodePoint(0x202e)}b`, "é".repeat(201)])
      expect(ok(TemplateDescription, text), JSON.stringify(text)).toBe(false);
    for (const text of ["é".repeat(200), 'a "b": #c']) expect(ok(TemplateDescription, text)).toBe(true);
  });

  it("a body refuses NUL, ESC, bidi controls and lone surrogates, allows tab, CRLF and an emoji with a joiner, and stops at 32 KiB in bytes", () => {
    const refused = [
      "a\u0000b",
      `a${String.fromCharCode(27)}b`,
      `a${String.fromCodePoint(0x202e)}b`,
      `a${String.fromCodePoint(0x2066)}b`,
      `a${String.fromCodePoint(0x2028)}b`,
      `a${String.fromCharCode(0xd800)}b`,
    ];
    for (const text of refused) expect(ok(TemplateBody, text), JSON.stringify(text)).toBe(false);
    const joiner = String.fromCodePoint(0x1f468, 0x200d, 0x1f469);
    expect(ok(TemplateBody, `a\tb\r\nc ${joiner}\n`)).toBe(true);
    expect(ok(TemplateBody, "   \n")).toBe(false);
    expect(ok(TemplateBody, "é".repeat(16_384))).toBe(true);
    expect(ok(TemplateBody, `${"é".repeat(16_384)}a`)).toBe(false);
  });

  it("the params object is strict", () => {
    expect(ok(TemplatesSaveParams, { name: "review", body: "x" })).toBe(true);
    expect(ok(TemplatesSaveParams, { name: "review", body: "x", replace: true })).toBe(true);
    expect(ok(TemplatesSaveParams, { name: "review", body: "x", extra: 1 })).toBe(false);
  });
});

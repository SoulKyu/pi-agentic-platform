import { describe, expect, it } from "vitest";
import { attachmentDisposition } from "./content-disposition.ts";

const RAW = { fallback: "pap-file", suffix: "", leadingDot: "underscore" } as const;
const EXPORT = { fallback: "pap-session", suffix: ".html", leadingDot: "strip" } as const;

describe("attachmentDisposition with the raw file options", () => {
  it("turns a leading dot into an underscore: .env downloads as _env", () => {
    expect(attachmentDisposition(".env", RAW)).toBe(`attachment; filename="_env"; filename*=UTF-8''_env`);
  });

  it("keeps an html name as it is, always as an attachment", () => {
    expect(attachmentDisposition("a.html", RAW)).toBe(
      `attachment; filename="a.html"; filename*=UTF-8''a.html`,
    );
  });

  it("keeps the extension through the 64 code point cut", () => {
    const header = attachmentDisposition(`${"x".repeat(80)}.tar.gz`, RAW);
    const name = /filename="([^"]*)"/.exec(header)?.[1] ?? "";
    expect([...name]).toHaveLength(64);
    expect(name).toBe(`${"x".repeat(61)}.gz`);
    expect(header).toContain(`filename*=UTF-8''${"x".repeat(61)}.gz`);
  });

  it("falls back to an ASCII name and keeps the RFC 5987 form for other scripts", () => {
    expect(attachmentDisposition("日本.pdf", RAW)).toBe(
      `attachment; filename="__.pdf"; filename*=UTF-8''%E6%97%A5%E6%9C%AC.pdf`,
    );
  });

  it("drops bidi controls and replaces separators and quotes", () => {
    expect(attachmentDisposition("a‮b.txt", RAW)).toBe(
      `attachment; filename="ab.txt"; filename*=UTF-8''ab.txt`,
    );
    expect(attachmentDisposition('a"b/c.txt', RAW)).toBe(
      `attachment; filename="a_b_c.txt"; filename*=UTF-8''a_b_c.txt`,
    );
  });

  it("uses the fixed name when nothing usable is left", () => {
    for (const name of ["", null, undefined, "‮", "   "])
      expect(attachmentDisposition(name, RAW), String(name)).toBe(`attachment; filename="pap-file"`);
  });
});

describe("attachmentDisposition with the export options", () => {
  it("strips leading dots and appends the suffix", () => {
    expect(attachmentDisposition("...hidden", EXPORT)).toBe(
      `attachment; filename="hidden.html"; filename*=UTF-8''hidden.html`,
    );
    expect(attachmentDisposition("...", EXPORT)).toBe(`attachment; filename="pap-session.html"`);
  });
});

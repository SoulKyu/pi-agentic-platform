import { describe, expect, it } from "vitest";
import { uploadName } from "./names.ts";

const E_ACUTE = "é";

describe("uploadName", () => {
  it("refuses what is not one visible segment", () => {
    const refused: unknown[] = [
      "",
      ".",
      "..",
      "a/b",
      "a\\b",
      " a",
      "a ",
      "a‮b.txt",
      "a​b",
      "a\u0007b",
      "a\u0000b",
      "a\uD800",
      ".pap-0123456789ab.tmp",
      E_ACUTE.repeat(128),
      42,
      undefined,
    ];
    for (const raw of refused) expect(uploadName(raw), String(raw)).toBeNull();
  });

  it("refuses Default_Ignorable code points the shared list misses (MC9)", () => {
    for (const code of [0x3164, 0xffa0, 0x115f, 0x1160, 0x180e, 0xfe0f, 0xe0100, 0x034f, 0x2064, 0x00ad]) {
      expect(uploadName(`a${String.fromCodePoint(code)}b.txt`), code.toString(16)).toBeNull();
    }
  });

  it("accepts ordinary names, in NFC", () => {
    expect(uploadName("report.pdf")).toBe("report.pdf");
    expect(uploadName("Été 2026.md")).toBe("Été 2026.md");
    expect(uploadName("CON")).toBe("CON");
    expect(uploadName("a b")).toBe("a b");
    expect(uploadName(E_ACUTE.repeat(127))).toBe(E_ACUTE.repeat(127));
  });
});

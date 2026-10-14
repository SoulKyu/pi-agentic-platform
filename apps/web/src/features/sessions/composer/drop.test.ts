import { describe, expect, it } from "vitest";
import { acceptsDrag, filesOf, pastedFiles } from "./drop.ts";

const file = (name: string) => new File(["x"], name);
const item = (f: File | null, directory = false) => ({
  kind: "file",
  getAsFile: () => f,
  webkitGetAsEntry: () => ({ isDirectory: directory }),
});

describe("filesOf", () => {
  it("lists files and counts folders from the entries", () => {
    const a = file("a.png");
    const transfer = { items: [item(a), item(null, true)], files: [a] } as unknown as DataTransfer;
    expect(filesOf(transfer)).toEqual({ files: [a], folders: 1 });
  });

  it("falls back to the files list when the browser gives no entries", () => {
    const a = file("a.png");
    const transfer = { items: [], files: [a] } as unknown as DataTransfer;
    expect(filesOf(transfer)).toEqual({ files: [a], folders: 0 });
  });
});

describe("acceptsDrag and pastedFiles", () => {
  it("accepts a drag carrying files or an explorer path only", () => {
    expect(acceptsDrag({ types: ["Files"] } as unknown as DataTransfer)).toBe(true);
    expect(acceptsDrag({ types: ["application/x-pap-path"] } as unknown as DataTransfer)).toBe(true);
    expect(acceptsDrag({ types: ["text/plain"] } as unknown as DataTransfer)).toBe(false);
  });

  it("takes pasted files only when no text came with them", () => {
    const a = file("shot.png");
    const board = (text: string) =>
      ({ files: [a], getData: () => text, items: [item(a)] }) as unknown as DataTransfer;
    expect(pastedFiles(board(""))).toEqual([a]);
    expect(pastedFiles(board("some text"))).toEqual([]);
  });
});

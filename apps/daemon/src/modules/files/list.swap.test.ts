import { renameSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openFolder } from "../../kernel/fs/safe-open.ts";
import { listFolder } from "./list.ts";
import { createFilesBed, type FilesBed } from "./testing/files-bed.ts";

vi.mock("../../kernel/fs/safe-open.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../kernel/fs/safe-open.ts")>();
  return { ...actual, openFolder: vi.fn(actual.openFolder) };
});

let bed: FilesBed;
beforeEach(() => {
  bed = createFilesBed();
});
afterEach(() => bed.dispose());

describe("a folder swapped for a link after the judgement (M8R104, RT-15)", () => {
  it("lists nothing from outside the root", async () => {
    const folder = join(bed.repo, "swap");
    bed.file(join(folder, "inside.txt"));
    bed.file(join(bed.bb.outside, "outside-name.txt"));
    const real = (
      await vi.importActual<typeof import("../../kernel/fs/safe-open.ts")>("../../kernel/fs/safe-open.ts")
    ).openFolder;
    // The judgement has seen a real folder; by the time it is opened, a link to a folder outside stands in its place.
    vi.mocked(openFolder).mockImplementationOnce(async (path, guard) => {
      renameSync(folder, `${folder}.moved`);
      symlinkSync(bed.bb.outside, folder);
      return real(path, guard);
    });
    await expect(listFolder(bed.env(), bed.scope([bed.repo]), folder, false)).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

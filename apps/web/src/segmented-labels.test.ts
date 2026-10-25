import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = new URL(".", import.meta.url).pathname;

/** The files whose Segmented keeps its label for screen readers only: a heading or the control around it names the choice. */
const HIDDEN_SEGMENTED = [
  "features/automation/FireJournal.tsx",
  "features/files/FileViewer.tsx",
  "features/inbox/InboxPanel.tsx",
  "features/home/RecentWork.tsx",
  "features/lanes/LaneBody.tsx",
  "features/sessions/Composer.tsx",
  "gallery/Gallery.tsx",
];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : [];
  });
}

describe("Segmented labels", () => {
  it("labelHidden appears only in the reviewed files", () => {
    const found = sources(root)
      .filter((file) => readFileSync(file, "utf8").includes("labelHidden"))
      .map((file) => relative(root, file))
      .sort();
    expect(found).toEqual([...HIDDEN_SEGMENTED].sort());
  });
});

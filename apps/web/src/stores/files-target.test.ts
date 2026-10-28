import { beforeEach, describe, expect, it } from "vitest";
import { useFilesTarget } from "./files-target.ts";

beforeEach(() => useFilesTarget.getState().reset());

describe("files target", () => {
  it("push then take once", () => {
    useFilesTarget.getState().push("/p", "/p/a.ts", 12);
    expect(useFilesTarget.getState().take("/p2")).toBeNull();
    expect(useFilesTarget.getState().take("/p")).toMatchObject({ path: "/p/a.ts", line: 12 });
    expect(useFilesTarget.getState().take("/p")).toBeNull();
  });

  it("a second push for the same root replaces the first and n rises", () => {
    useFilesTarget.getState().push("/p", "/p/a.ts", null);
    const first = useFilesTarget.getState().targets["/p"];
    useFilesTarget.getState().push("/p", "/p/b.ts", 3);
    const second = useFilesTarget.getState().targets["/p"];
    expect(second).toMatchObject({ path: "/p/b.ts", line: 3 });
    expect(second?.n).toBeGreaterThan(first?.n ?? Infinity);
    expect(Object.keys(useFilesTarget.getState().targets)).toEqual(["/p"]);
  });

  it("a 33rd root drops the oldest", () => {
    for (let index = 0; index < 33; index++)
      useFilesTarget.getState().push(`/r${index}`, `/r${index}/f`, null);
    const roots = Object.keys(useFilesTarget.getState().targets);
    expect(roots).toHaveLength(32);
    expect(roots).not.toContain("/r0");
    expect(roots).toContain("/r32");
  });
});

import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { judgePath, type Intent, type Refusal } from "./boundary.ts";
import { createBoundaryBed } from "../testing/boundary-bed.ts";

let bed: ReturnType<typeof createBoundaryBed>;
beforeEach(() => {
  bed = createBoundaryBed();
});
afterEach(() => bed.dispose());

const refusal = async (path: unknown, roots: string[], intent: Intent = "read"): Promise<Refusal | "ok"> => {
  const judged = await judgePath(path, { roots, config: bed.config(), caller: "session" }, intent);
  return judged.ok ? "ok" : judged.why;
};

describe("a path that is not canonical", () => {
  it("is malformed, whatever the intent", async () => {
    const cases: unknown[] = [
      `${bed.proj}/../outside/secret.txt`,
      `${bed.proj}/./a`,
      `${bed.proj}//a`,
      `${bed.proj}/a/`,
      `${bed.proj}/a\u0000b`,
      `/${"a".repeat(4096)}`,
      "proj/a.txt",
      123,
      undefined,
    ];
    for (const path of cases)
      for (const intent of ["list", "read", "write"] as const)
        expect(await refusal(path, [bed.proj], intent), `${String(path).slice(0, 40)} ${intent}`).toBe(
          "malformed",
        );
  });

  it("never resolves the .. that would follow a link out", async () => {
    bed.link(join(bed.outside, "deep"), join(bed.proj, "lnk"));
    expect(await refusal(`${bed.proj}/lnk/../x`, [bed.proj], "write")).toBe("malformed");
  });
});

describe("a link out of the roots", () => {
  it("is outside", async () => {
    bed.link(bed.outside, join(bed.proj, "link-out"));
    expect(await refusal(join(bed.proj, "link-out", "secret.txt"), [bed.proj])).toBe("outside");
  });

  it("is outside through a relative link, the classic slip", async () => {
    bed.link("../../outside", join(bed.proj, "rel-out"));
    expect(await refusal(join(bed.proj, "rel-out", "secret.txt"), [bed.proj])).toBe("outside");
    bed.link("../home/proj/a.txt", join(bed.outside, "rel-back"));
    expect(await refusal(join(bed.outside, "rel-back"), [bed.proj])).toBe("outside");
  });

  it("is outside to write a new file through it", async () => {
    bed.link(bed.outside, join(bed.proj, "link-out"));
    expect(await refusal(join(bed.proj, "link-out", "new.txt"), [bed.proj], "write")).toBe("outside");
  });

  it("is outside when the spelling is outside, though the link leads into a root", async () => {
    bed.link(join(bed.proj, "a.txt"), join(bed.outside, "back"));
    expect(await refusal(join(bed.outside, "back"), [bed.proj])).toBe("outside");
  });

  it("is outside for /proc/self/cwd and /proc/self/root", async () => {
    bed.link("/proc/self/cwd", join(bed.proj, "cwd"));
    bed.link("/proc/self/root", join(bed.proj, "root"));
    expect(await refusal(join(bed.proj, "cwd"), [bed.proj])).toBe("outside");
    expect(await refusal(join(bed.proj, "root"), [bed.proj])).toBe("outside");
  });

  it("is outside when a root was replaced by a link to /", async () => {
    const root = join(bed.base, "rootlink");
    bed.link("/", root);
    expect(await refusal(join(root, "etc", "passwd"), [root])).toBe("outside");
  });
});

describe("a strange name", () => {
  it("is just missing", async () => {
    expect(await refusal(join(bed.proj, "%2e%2e", "outside"), [bed.proj])).toBe("missing");
  });

  it("is missing when a link loops", async () => {
    bed.link(join(bed.proj, "loop"), join(bed.proj, "loop"));
    expect(await refusal(join(bed.proj, "loop"), [bed.proj])).toBe("missing");
  });
});

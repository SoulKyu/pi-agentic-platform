import type { LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { withoutPiMem0 } from "./without-mem0.ts";

const extension = (path: string, resolvedPath = path) => ({ path, resolvedPath }) as never;
const result = (...paths: Array<[string, string?]>): LoadExtensionsResult =>
  ({ extensions: paths.map(([p, r]) => extension(p, r)), errors: [], runtime: {} }) as never;

describe("withoutPiMem0", () => {
  it("drops a pi-mem0 extension by path or resolved path and keeps the others", () => {
    const report = vi.fn();
    const out = withoutPiMem0(report)(
      result(["/a/pi-tools/index.js"], ["/x/Pi-Mem0/src/index.ts"], ["ext", "/home/me/pi-mem0/index.js"]),
    );
    expect(out.extensions.map((e) => e.path)).toEqual(["/a/pi-tools/index.js"]);
  });

  it("reports once per worker with the package name only", () => {
    const report = vi.fn();
    const filter = withoutPiMem0(report);
    filter(result(["/secret/dir/pi-mem0/index.js"]));
    filter(result(["/secret/dir/pi-mem0/index.js"]));
    expect(report).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(report.mock.calls)).not.toContain("/secret");
  });

  it("returns the same result and reports nothing when there is no pi-mem0", () => {
    const report = vi.fn();
    const base = result(["/a/b.js"]);
    expect(withoutPiMem0(report)(base)).toBe(base);
    expect(report).not.toHaveBeenCalled();
  });
});

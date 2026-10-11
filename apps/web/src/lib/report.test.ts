import { describe, expect, it } from "vitest";
import { reportClientIssue } from "./report.ts";

describe("client issues", () => {
  it("warns once per code per 10 s, with the code only", () => {
    const lines: string[] = [];
    let now = 1_000_000;
    const deps = { warn: (line: string) => lines.push(line), now: () => now };
    reportClientIssue("storage_refused", deps);
    reportClientIssue("storage_refused", deps);
    reportClientIssue("boot_cache_refused", deps);
    now += 10_000;
    reportClientIssue("storage_refused", deps);
    expect(lines).toEqual(["pap: storage_refused", "pap: boot_cache_refused", "pap: storage_refused"]);
  });
});

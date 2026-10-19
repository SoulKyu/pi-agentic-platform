import { statSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { appendOf } from "./mirror-fixtures.ts";
import { bed, cleanup, fresh, open, refusals } from "./mirror-harness.ts";

afterEach(cleanup);

// Mutant M-HEADER-UNSCANNED: skip the scan compare for the header (id ?? headerId): killed by the first two cases (N3).
describe("the header is checked by the scanner too (AVM-E29)", () => {
  const header = (text: string) => `${text}\n`;
  it.each([
    ["a duplicate id key", '{"type":"session","id":"h0","id":"h1"}'],
    ["an escaped id key", '{"type":"session","\\u0069d":"h1"}'],
    ["no id", '{"type":"session","version":3}'],
  ])("refuses a header with %s", (_name, line) => {
    fresh();
    const mirror = open();
    expect(mirror.onSessionAppend(appendOf(0, header(line)))).toBe("refused");
    expect(refusals().at(-1)?.reason).toBe("not_entry");
    expect(statSync(bed.path).size).toBe(0);
  });

  it("takes a header whose id is the top-level one, with an id nested in data", () => {
    fresh();
    const mirror = open();
    expect(
      mirror.onSessionAppend(appendOf(0, header('{"type":"session","data":{"id":"h0"},"id":"h1"}'))),
    ).toBe("ok");
    expect(mirror.facts().lastEntryId).toBe("h1");
  });
});

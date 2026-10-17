import type { LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { platformFirst } from "./platform-tools.ts";
import { PLATFORM_SOURCE } from "./policy/tool-kind.ts";

const extension = (path: string, tools: string[]) => ({ path, tools: new Map(tools.map((t) => [t, {}])) });
const loaded = (...extensions: ReturnType<typeof extension>[]) =>
  ({ extensions, errors: [], runtime: {} }) as unknown as LoadExtensionsResult;

describe("platformFirst", () => {
  it("reports only a name pap registered itself: an op pap left out is not 'the one in use'", () => {
    const reports: Array<{ event: string; error: string }> = [];
    const order = platformFirst((error) => reports.push(error));
    const mine = extension(PLATFORM_SOURCE, ["lane_note"]);
    const other = extension("/x/ext.ts", ["lane_note", "agent_notify"]);
    const result = order(loaded(other, mine));
    expect(result.extensions[0]).toBe(mine);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.error).toContain("another extension registered lane_note,");
  });

  it("reports a name once, however often the extensions are loaded", () => {
    const reports: unknown[] = [];
    const order = platformFirst((error) => reports.push(error));
    const again = () =>
      order(loaded(extension("/x/ext.ts", ["lane_note"]), extension(PLATFORM_SOURCE, ["lane_note"])));
    again();
    again();
    expect(reports).toHaveLength(1);
  });
});

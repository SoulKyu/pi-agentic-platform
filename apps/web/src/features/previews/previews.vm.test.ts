import { describe, expect, it } from "vitest";
import { AGENT_BOX, PROJECT_BOX } from "../../testing/previews-fixtures.ts";
import { parseWindowPath, windowPath } from "./previews.vm.ts";

describe("the preview window path", () => {
  it("round-trips a box and a service name", () => {
    expect(parseWindowPath(windowPath(PROJECT_BOX, "web"))).toEqual({ box: PROJECT_BOX, name: "web" });
    expect(parseWindowPath(windowPath(AGENT_BOX, "api-2"))).toEqual({ box: AGENT_BOX, name: "api-2" });
  });

  it("refuses everything else: other paths, a bad box, a bad name, extra segments", () => {
    for (const path of [
      "/",
      "/s/abc",
      "/preview/",
      "/preview/nope/web",
      "/preview/project:not-a-uuid/web",
      `/preview/${"project"}:${PROJECT_BOX.id}/Bad_Name`,
      `/preview/project:${PROJECT_BOX.id}/web/extra`,
      `/preview/project:${PROJECT_BOX.id}/`,
    ])
      expect(parseWindowPath(path)).toBeNull();
  });
});

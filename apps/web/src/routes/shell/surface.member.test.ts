import type { ProjectSummary, ShellSession } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { isBoxPath } from "../../stores/box-path.ts";
import type { ShellView } from "../../stores/shell-reducer.ts";
import { placeOf, terminalAllowed } from "./surface.ts";

const project = (id: string, kind: "box" | "host", root: string) =>
  ({ id, root, name: id, position: 0, kind }) as unknown as ProjectSummary;
const session = (id: string, projectId: string, cwd: string) =>
  ({ id, projectId, cwd }) as unknown as ShellSession;
const view = {
  projects: new Map([
    ["b", project("b", "box", "/boxes/b/project")],
    ["h", project("h", "host", "/home/ana/p")],
  ]),
  sessions: new Map([
    ["sb", session("sb", "b", "/boxes/b/project")],
    ["sh", session("sh", "h", "/home/ana/p")],
  ]),
} as unknown as ShellView;

describe("a member's terminal entries", () => {
  it("are allowed from a box session, on its box root", () => {
    const place = placeOf(view, "sb");
    expect(place).toMatchObject({ box: true, cwd: "/boxes/b/project" });
    expect(terminalAllowed(place, "member")).toBe(true);
  });
  it("are absent for a host folder or an unknown session, but stay for the owner", () => {
    expect(terminalAllowed(placeOf(view, "sh"), "member")).toBe(false);
    expect(terminalAllowed(placeOf(view, "none"), "member")).toBe(false);
    expect(terminalAllowed(placeOf(view, "sh"), "owner")).toBe(true);
  });
  it("tells a box path from a host one", () => {
    expect(isBoxPath(view, "/boxes/b/project/src")).toBe(true);
    expect(isBoxPath(view, "/home/ana/p")).toBe(false);
  });
});

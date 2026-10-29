import { describe, expect, it } from "vitest";
import { boxProject } from "../../testing/box-fixtures.ts";
import { AGENT_BOX, previewView, PROJECT_BOX } from "../../testing/previews-fixtures.ts";
import { shellProject, shellSession } from "../../testing/shell-snapshot.ts";
import { EMPTY_SHELL, reduceShell } from "../../stores/shell-reducer.ts";
import { boxOfSession, runningOf } from "./preview-box.ts";
import { previewKey } from "../../stores/previews-store.ts";

const shell = (sessions: ReturnType<typeof shellSession>[], projects: ReturnType<typeof shellProject>[]) =>
  reduceShell(EMPTY_SHELL, { kind: "snapshot", projects, sessions, more: 0, moreProjects: 0, archived: 0 });

describe("boxOfSession", () => {
  it("is the box of a box project's session", () => {
    const view = shell([shellSession({ id: "s1", projectId: "b1" })], [boxProject("running")]);
    expect(boxOfSession(view, "s1")).toEqual({ kind: "project", id: "b1" });
  });

  it("is null for a host project, a session without a project and an unknown session", () => {
    const view = shell(
      [shellSession({ id: "s1", projectId: "h1" }), shellSession({ id: "s2", cwd: "/elsewhere" })],
      [shellProject({ id: "h1", kind: "host" })],
    );
    expect(boxOfSession(view, "s1")).toBeNull();
    expect(boxOfSession(view, "s2")).toBeNull();
    expect(boxOfSession(view, "nope")).toBeNull();
  });
});

describe("runningOf", () => {
  const services = (...list: ReturnType<typeof previewView>[]) =>
    new Map(list.map((one) => [previewKey(one.box, one.name), one]));

  it("lists the running services of the box by name, not a failed one, not another box's", () => {
    const map = services(
      previewView({ name: "web", id: "1".repeat(32) }),
      previewView({ name: "api", id: "2".repeat(32) }),
      previewView({ name: "broken", id: "3".repeat(32), state: "failed", reason: "exited" }),
      previewView({ name: "other", id: "4".repeat(32), box: AGENT_BOX }),
    );
    expect(runningOf(map, PROJECT_BOX).map((one) => one.name)).toEqual(["api", "web"]);
    expect(runningOf(map, AGENT_BOX).map((one) => one.name)).toEqual(["other"]);
  });
});

import { describe, expect, it } from "vitest";
import { methods } from "./index.ts";

describe("project box methods", () => {
  it("declares the permissions of boxes B1", () => {
    const permissions = Object.fromEntries(
      Object.entries(methods)
        .filter(([name]) =>
          /^projects\.(create|scratch|delete|box|setBox|startBox|restartBox|rebuild)$/.test(name),
        )
        .map(([name, def]) => [name, def.permission]),
    );
    expect(permissions).toEqual({
      "projects.create": "sessions:operate",
      "projects.scratch": "sessions:operate",
      "projects.startBox": "sessions:operate",
      "projects.restartBox": "sessions:operate",
      "projects.box": "sessions:read",
      "projects.setBox": "sessions:admin",
      "projects.rebuild": "sessions:admin",
      "projects.delete": "sessions:admin",
    });
  });

  it("asks for the password to delete, like agents.delete", () => {
    expect(methods["projects.delete"].errors).toEqual([
      "step_up_required",
      "not_found",
      "conflict",
      "read_only",
    ]);
  });

  it("refuses unknown params and a name that is empty", () => {
    expect(methods["projects.create"].params.safeParse({ name: "" }).success).toBe(false);
    expect(methods["projects.create"].params.safeParse({ name: "a", extra: 1 }).success).toBe(false);
    expect(methods["projects.setBox"].params.safeParse({ projectId: "p" }).success).toBe(true);
  });
});

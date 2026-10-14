import { describe, expect, it } from "vitest";
import { isProtectedName } from "./index.ts";

describe("isProtectedName", () => {
  it.each([
    "/p/.git/hooks/pre-commit",
    "/p/.GIT/config",
    "/p/.vscode/tasks.json",
    "/p/.envrc",
    "/p/lefthook.yml",
    "/p/.lefthook-local.toml",
    "/p/.config/mise/config.toml",
    "/p/mise.local.toml",
    "/p/.pi/settings.json",
  ])("protects %s", (path) => {
    expect(isProtectedName(path)).toBe(true);
  });

  it.each(["/p/.github/workflows/ci.yml", "/p/.gitignore", "/p/src/mise.ts", "/p/docs/lefthook.md"])(
    "leaves %s ordinary",
    (path) => {
      expect(isProtectedName(path)).toBe(false);
    },
  );
});

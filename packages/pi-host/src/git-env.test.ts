import { describe, expect, it } from "vitest";
import { pinBareRepositoryExplicit } from "./git-env.ts";

describe("pinBareRepositoryExplicit", () => {
  it("sets the first entry in an environment with none", () => {
    const env: NodeJS.ProcessEnv = {};
    pinBareRepositoryExplicit(env);
    expect(env).toEqual({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "safe.bareRepository",
      GIT_CONFIG_VALUE_0: "explicit",
    });
  });

  it("appends after the entries already there and keeps them", () => {
    const env: NodeJS.ProcessEnv = {
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_VALUE_0: "a",
      GIT_CONFIG_KEY_1: "safe.bareRepository",
      GIT_CONFIG_VALUE_1: "all",
    };
    pinBareRepositoryExplicit(env);
    expect(env).toEqual({
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_VALUE_0: "a",
      GIT_CONFIG_KEY_1: "safe.bareRepository",
      GIT_CONFIG_VALUE_1: "all",
      GIT_CONFIG_KEY_2: "safe.bareRepository",
      GIT_CONFIG_VALUE_2: "explicit",
    });
  });

  it.each(["", "-1", "1.5", "x", " 1", "01", "1e2", "99999", "1001"])(
    "refuses the count %j and changes nothing",
    (count) => {
      const env: NodeJS.ProcessEnv = { GIT_CONFIG_COUNT: count };
      expect(() => pinBareRepositoryExplicit(env)).toThrow();
      expect(env).toEqual({ GIT_CONFIG_COUNT: count });
    },
  );
});

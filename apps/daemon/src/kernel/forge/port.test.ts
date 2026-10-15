import { describe, expect, it } from "vitest";
import { silentLogger } from "../logger.ts";
import { createSystemClock } from "../clock.ts";
import { forgeFor } from "./port.ts";

const deps = { env: {}, forgeDir: "/x", logger: silentLogger, clock: createSystemClock() };

describe("forgeFor", () => {
  it("returns the GitHub adapter only for github", () => {
    expect(forgeFor("github", deps)?.kind).toBe("github");
    expect(forgeFor("gitlab", deps)).toBeNull();
    expect(forgeFor("gitea", deps)).toBeNull();
  });
});

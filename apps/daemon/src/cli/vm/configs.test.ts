import { describe, expect, it } from "vitest";
import { KATA_MARKER, kataConfig, vmdConfig } from "./configs.ts";
import { SHIPPED_KATA } from "./testing/bed.ts";

/* Mutant: a Kata key written without checking the shipped file has it (the replace falls back to appending).
   Killed by "stops naming a key the shipped file lacks". */
describe("kataConfig", () => {
  it("starts with pap's line and sets exactly the three values", () => {
    const text = kataConfig(SHIPPED_KATA);
    expect(text.startsWith(`${KATA_MARKER}\n`)).toBe(true);
    expect(text).toBe(
      `${KATA_MARKER}\n${SHIPPED_KATA.replace("default_memory = 2048", "default_memory = 256").replace("static_sandbox_resource_mgmt = false", "static_sandbox_resource_mgmt = true")}`,
    );
  });

  for (const key of ["default_memory", "default_vcpus", "static_sandbox_resource_mgmt"])
    it(`stops naming a key the shipped file lacks: ${key}`, () => {
      const without = SHIPPED_KATA.split("\n")
        .filter((l) => !l.startsWith(key))
        .join("\n");
      expect(() => kataConfig(without)).toThrow(key);
      expect(() => kataConfig(without.replace("[runtime]", `#${key} = 1\n[runtime]`))).toThrow(key);
    });
});

describe("vmdConfig", () => {
  it("has exactly papUid, papGid and papHome", () => {
    expect(JSON.parse(vmdConfig({ uid: 1, gid: 2, home: "/h" }))).toEqual({
      papUid: 1,
      papGid: 2,
      papHome: "/h",
    });
  });
});

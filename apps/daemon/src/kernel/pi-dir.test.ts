import { describe, expect, it } from "vitest";
import { ConfigError } from "./config.ts";
import { piAgentDirFrom } from "./pi-dir.ts";

describe("piAgentDirFrom", () => {
  it("defaults to ~/.pi/agent", () => {
    expect(piAgentDirFrom({}, "/home/u")).toBe("/home/u/.pi/agent");
    expect(piAgentDirFrom({ PI_CODING_AGENT_DIR: "" }, "/home/u")).toBe("/home/u/.pi/agent");
  });
  it("expands ~ and ~/", () => {
    expect(piAgentDirFrom({ PI_CODING_AGENT_DIR: "~" }, "/home/u")).toBe("/home/u");
    expect(piAgentDirFrom({ PI_CODING_AGENT_DIR: "~/pi" }, "/home/u")).toBe("/home/u/pi");
  });
  it("keeps an absolute path", () => {
    expect(piAgentDirFrom({ PI_CODING_AGENT_DIR: "/srv/pi" }, "/home/u")).toBe("/srv/pi");
  });
  it("a relative path throws ConfigError", () => {
    expect(() => piAgentDirFrom({ PI_CODING_AGENT_DIR: "pi/agent" }, "/home/u")).toThrow(ConfigError);
    expect(() => piAgentDirFrom({ PI_CODING_AGENT_DIR: "~x" }, "/home/u")).toThrow(ConfigError);
  });
});

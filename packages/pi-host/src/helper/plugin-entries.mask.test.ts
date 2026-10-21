import { describe, expect, it } from "vitest";
import { maskSource } from "./plugin-entries.ts";

describe("maskSource keeps a package name readable", () => {
  it.each([
    "npm:pi-mcp-adapter@5.1.0",
    "npm:pi-subagents@0.76.1",
    "npm:pi-web-access@0.37.0",
    "npm:pi-goal-x@0.32.3",
    "npm:pi-beautiful-tui@0.2.4",
    "npm:pi-claude-bridge@0.9.1",
    "npm:pi-extensible-workflows@6.0.0",
    "npm:pi-tools",
    "npm:left-pad@1.3.0-beta.1+build.5",
    "npm:@juicesharp/rpiv-todo@2.12.0",
    "git:github.com/example/pi-tools@0123abc",
    "../../Workspace/soulkyu/superpowers",
  ])("shows %s unchanged", (source) => {
    expect(maskSource(source)).toBe(source);
  });

  it.each([
    ["git+https://user:tok@host.tld/repo.git", "git+https://•••@host.tld/repo.git"],
    ["https://user:tok@host.tld/x", "https://•••@host.tld/x"],
    ["git:user:tok@host.tld/a/b", "•••@host.tld/a/b"],
    ["npm:user:tok@host.tld/x", "•••@host.tld/x"],
  ])("still hides the userinfo of %s", (source, shown) => {
    expect(maskSource(source)).toBe(shown);
  });

  it("still hides a query string and a token-like value in a URL", () => {
    expect(maskSource("https://host.tld/x?token=abc")).not.toContain("abc");
    expect(maskSource("https://host.tld/x#access_token=abc")).not.toContain("abc");
  });
});

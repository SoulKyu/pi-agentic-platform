import { describe, expect, it } from "vitest";
import { pluginSource } from "./plugin-source.ts";

const home = "/home/owner";

describe("pluginSource (M7R115)", () => {
  it.each([
    "npm:@example/pi-tools@1.0.0",
    "npm:pi-tools",
    "git:github.com/example/pi-tools@v1",
    "git:github.com/example/pi-tools",
    "https://github.com/example/pi-tools",
    `${home}/pkgs/x`,
  ])("accepts %s", (source) => {
    expect(pluginSource(source, home)).toBe(source);
  });

  it("trims the text and drops trailing slashes of a local path", () => {
    expect(pluginSource("  npm:pi-tools  ", home)).toBe("npm:pi-tools");
    expect(pluginSource(`${home}/pkgs/x/`, home)).toBe(`${home}/pkgs/x`);
  });

  it.each([
    "--registry=x",
    "-x",
    "npm:-x",
    "npm:@scope",
    "npm:x y",
    "git:a/../../../../outside/evil",
    "git:host.tld/a/../b",
    "git:host.tld/./b/c",
    "git:host.tld/a/b@--upload-pack",
    "git:host.tld/a/b@-x",
    "git:-oProxyCommand.x.tld/a/b",
    "git:.host.tld/a/b",
    "git:host.tld-/a/b",
    "https://-x.tld/a",
    "git:nodot/a/b",
    "git:host.tld/single",
    "git:host.tld/a//b",
    "https://host.tld/a/../b",
    "https://host.tld/a/./b",
    "https://u:p@h/x",
    "https://h/x?y=1",
    "https://h/x#frag",
    "https://h",
    "http://h/x",
    "ssh://h/x",
    "./x",
    "pkgs/x",
    "~/x",
    `${home}/../etc`,
    `${home}/pkgs/../../etc`,
    "/etc/x",
    "/home/ownership/x",
    `${home}/a\0b`,
    "file:///x",
    "",
  ])("refuses %j", (source) => {
    expect(pluginSource(source, home)).toBeNull();
  });
});

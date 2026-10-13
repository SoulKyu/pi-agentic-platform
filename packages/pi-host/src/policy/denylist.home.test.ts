import { beforeAll, describe, expect, it, vi } from "vitest";

// The home directory is stubbed (os.homedir and $HOME), so no row depends on the runner's home (M5 final review, I3).
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => "/home/tester",
}));

let rmRoot: (argv: string[]) => boolean;
beforeAll(async () => {
  vi.stubEnv("HOME", "/srv//data/tester-alt/");
  vi.resetModules();
  const { BUILTIN_CHECKS } = await import("./denylist.ts");
  const check = BUILTIN_CHECKS.find((entry) => entry.id === "rm-root");
  if (!check) throw new Error("rm-root check is gone");
  rmRoot = (argv) => check.matches(argv, { words: argv, depth: 0, operators: new Set() });
});

describe("rm -rf of the home directory written as a literal path (M5R16)", () => {
  it.each([
    "/home/tester",
    "/home/tester/",
    "/home/tester/*",
    "//home//tester//",
    "/home/tester/.",
    "/home",
    "/home/",
    "/home/*",
    "/srv/data/tester-alt",
    "/srv/data/tester-alt/",
    "/srv/data/tester-alt/*",
    "/srv/data",
    "/srv/data/*",
    "/srv",
    "~tester",
    "~tester/",
    "~someone/*",
  ])("blocks rm -rf %s", (target) => {
    expect(rmRoot(["rm", "-rf", target])).toBe(true);
  });

  it.each([
    "/home/tester/project",
    "/home/tester/project/*",
    "/home/tester/.cache",
    "/home/other",
    "/homework",
    "/home/tester2",
    "/srv/data/tester-alt/work",
    "/srv/other",
    "/tmp/build",
    "~/project",
    "~tester/project",
  ])("lets rm -rf %s through", (target) => {
    expect(rmRoot(["rm", "-rf", target])).toBe(false);
  });
});

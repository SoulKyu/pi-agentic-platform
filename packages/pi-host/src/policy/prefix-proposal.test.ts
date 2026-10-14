import { describe, expect, it } from "vitest";
import { proposePrefix } from "./prefix-proposal.ts";

describe("the prefix a card offers for always (M7R18)", () => {
  it.each([
    ["pnpm test", ["pnpm", "test"]],
    ["pnpm test -- src/a.test.ts", ["pnpm", "test"]],
    ["npm run build", ["npm", "run", "build"]],
    ["pnpm exec vitest --run", ["pnpm", "exec", "vitest"]],
    ["make test", ["make", "test"]],
    ["git push origin main", ["git", "push"]],
    ["npm run", ["npm", "run"]],
    ["npm run Build", ["npm", "run"]],
  ])("offers the prefix of %s", (command, prefix) => {
    expect(proposePrefix(command)).toEqual(prefix);
  });

  it.each([
    "ls",
    "python3 -c 1",
    "bash -c x",
    "sh test",
    "sudo pnpm test",
    "env X=1 pnpm test",
    "X=1 pnpm test",
    "xargs rm",
    "eval x",
    "exec test",
    "source x",
    ". x",
    "nohup pnpm test",
    "pnpm test && ls",
    "pnpm test; ls",
    "pnpm test | tee x",
    "pnpm test > out",
    "pnpm test < in",
    "pnpm test $(id)",
    "pnpm test `id`",
    "./run.sh test",
    "/usr/bin/pnpm test",
    "pnpm Test",
    "pnpm 1test",
    "\"${a:-'x'}\" test",
    "pn$x test",
    "",
    "pnpm test\nrm x",
    `${"p".repeat(65)} test`,
    `pnpm ${"t".repeat(65)}`,
    "true;".repeat(1001),
  ])("offers only the exact command for %j", (command) => {
    expect(proposePrefix(command)).toBeNull();
  });
});

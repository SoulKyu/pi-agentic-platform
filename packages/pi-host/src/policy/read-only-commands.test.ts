import { READ_ONLY_COMMAND_NAMES } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { GIT_READ_ONLY, READ_ONLY_COMMANDS } from "./read-only-commands.ts";

describe("READ_ONLY_COMMAND_NAMES (the list Settings shows)", () => {
  it("names every command of the table and every git read subcommand, and nothing else", () => {
    const table = [...READ_ONLY_COMMANDS.keys(), ...[...GIT_READ_ONLY.keys()].map((sub) => `git ${sub}`)];
    expect([...READ_ONLY_COMMAND_NAMES].sort()).toEqual(table.sort());
  });
});

import { describe, expect, it } from "vitest";
import { statusCells } from "./status-cells.ts";

describe("status cells", () => {
  it("turns command keys into buttons, keeps text statuses with their colours, drops empty ones, commands first then key order", () => {
    expect(
      statusCells([
        { key: "z-git", text: "main\t\tdirty" },
        { key: "y-ci", text: "\u001b[31mfailing\u001b[0m" },
        { key: "command:/mode build", text: "\u001b[32mBuild\u001b[0m" },
        { key: "command:x", text: "not a slash command" },
        { key: "empty", text: "\u001b[0m  " },
        { key: "command:/", text: "too short" },
      ]),
    ).toEqual([
      { kind: "command", key: "command:/mode build", command: "/mode build", label: "Build" },
      { kind: "text", key: "command:/", text: "too short" },
      { kind: "text", key: "command:x", text: "not a slash command" },
      { kind: "text", key: "y-ci", text: "\u001b[31mfailing\u001b[0m" },
      { kind: "text", key: "z-git", text: "main dirty" },
    ]);
  });

  it("labels a command button with the command when its text is empty, and cleans the command of control characters", () => {
    expect(
      statusCells([
        { key: "command:/deploy", text: "\u001b[0m" },
        { key: "command:/ev‮il\n/rm", text: "Go" },
      ]),
    ).toEqual([
      { kind: "command", key: "command:/deploy", command: "/deploy", label: "/deploy" },
      { kind: "command", key: "command:/ev‮il\n/rm", command: "/evil/rm", label: "Go" },
    ]);
  });
});

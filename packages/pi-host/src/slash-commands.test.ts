import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { MAX_LISTED_COMMANDS } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { handleGetCommands } from "./slash-commands.ts";

type Sent = Record<string, unknown>;
const info = (path: string) => ({ path, source: "test", scope: "user", origin: "top-level" });

interface Fakes {
  extension?: Array<{ invocationName: string; description?: string; sourceInfo: ReturnType<typeof info> }>;
  prompts?: Array<{ name: string; description: string; sourceInfo: ReturnType<typeof info> }>;
  skills?: Array<{ name: string; description: string; sourceInfo: ReturnType<typeof info> }>;
}
const sessionOf = (fakes: Fakes) =>
  ({
    extensionRunner: { getRegisteredCommands: () => fakes.extension ?? [] },
    promptTemplates: fakes.prompts ?? [],
    resourceLoader: { getSkills: () => ({ skills: fakes.skills ?? [], diagnostics: [] }) },
  }) as unknown as AgentSession;

function run(fakes: Fakes) {
  const sent: Sent[] = [];
  handleGetCommands(sessionOf(fakes), { id: "r1" }, (record) => void sent.push(record as Sent));
  return sent;
}
const dataOf = (sent: Sent[]) =>
  (sent[0] as { data: { commands: Array<Record<string, unknown>>; truncated: boolean } }).data;

describe("get_commands", () => {
  it("lists extension commands, prompt templates and skills, with the built-in /mcp flagged", () => {
    const sent = run({
      extension: [
        { invocationName: "mcp", description: "MCP servers", sourceInfo: info("builtin:mcp") },
        { invocationName: "mcp", sourceInfo: info("/home/u/.pi/extensions/own.js") },
      ],
      prompts: [{ name: "review", description: "Review the diff", sourceInfo: info("/p/review.md") }],
      skills: [{ name: "pdf", description: "Read PDFs", sourceInfo: info("/s/pdf/SKILL.md") }],
    });
    expect(sent).toEqual([
      {
        type: "response",
        id: "r1",
        command: "get_commands",
        success: true,
        data: {
          commands: [
            { name: "mcp", description: "MCP servers", source: "extension", builtinMcp: true },
            { name: "mcp", description: null, source: "extension", builtinMcp: false },
            { name: "review", description: "Review the diff", source: "prompt", builtinMcp: false },
            { name: "skill:pdf", description: "Read PDFs", source: "skill", builtinMcp: false },
          ],
          truncated: false,
        },
      },
    ]);
  });

  it("cuts the list at 500 and says so", () => {
    const prompts = Array.from({ length: MAX_LISTED_COMMANDS + 3 }, (_, index) => ({
      name: `p${index}`,
      description: "d",
      sourceInfo: info("/p.md"),
    }));
    const data = dataOf(run({ prompts }));
    expect(data.commands).toHaveLength(MAX_LISTED_COMMANDS);
    expect(data.truncated).toBe(true);
  });

  it("cuts the list at 600 000 bytes, below 500 entries, and says so", () => {
    // 1000 three-byte characters a description: about 3 KB an entry, so the bytes cross the cap first.
    const prompts = Array.from({ length: 300 }, (_, index) => ({
      name: `p${index}`,
      description: "\u4e16".repeat(1000),
      sourceInfo: info("/p.md"),
    }));
    const data = dataOf(run({ prompts }));
    expect(data.truncated).toBe(true);
    expect(data.commands.length).toBeGreaterThan(150);
    expect(data.commands.length).toBeLessThan(250);
    expect(Buffer.byteLength(JSON.stringify(data.commands))).toBeLessThanOrEqual(600_000);
  });

  it("clips a description to 1000 characters and leaves a hostile name out of the wire", () => {
    const data = dataOf(
      run({
        prompts: [
          { name: "long", description: "x".repeat(5000), sourceInfo: info("/p.md") },
          { name: "", description: "empty name", sourceInfo: info("/p.md") },
          { name: "n".repeat(300), description: "name too long", sourceInfo: info("/p.md") },
        ],
      }),
    );
    expect(data.commands.map((command) => command["name"])).toEqual(["long"]);
    expect(String(data.commands[0]?.["description"])).toHaveLength(1000);
  });

  it("answers a failure of Pi's registry as a failed response with a clipped message", () => {
    const session = {
      extensionRunner: {
        getRegisteredCommands: () => {
          throw new Error("boom");
        },
      },
    } as unknown as AgentSession;
    const sent: Sent[] = [];
    handleGetCommands(session, { id: "r2" }, (record) => void sent.push(record as Sent));
    expect(sent).toEqual([
      { type: "response", id: "r2", command: "get_commands", success: false, error: "boom" },
    ]);
  });
});

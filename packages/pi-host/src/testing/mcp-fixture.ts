import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface McpFixtureTool {
  readonly name: string;
  readonly annotations?: Readonly<Record<string, unknown>>;
  /** The text `tools/call` answers. */
  readonly reply: string;
}

const FIXTURE_PATH = fileURLToPath(new URL("./mcp-fixture.mjs", import.meta.url));
// One resource, so that Pi registers its resource tools (`read_mcp_resource`).
const RESOURCES = [{ uri: "fixture://note", name: "note", text: "a note" }];

/** The files of an agent directory that make Pi start the fixture as MCP server `fix` (tools are `mcp__fix__<name>`). */
export function mcpFixtureFiles(tools: readonly McpFixtureTool[]): Record<string, string> {
  const config = JSON.stringify({ tools, resources: RESOURCES });
  return {
    "mcp.json": JSON.stringify({
      mcpServers: { fix: { command: process.execPath, args: [FIXTURE_PATH, config] } },
    }),
  };
}

export function writeMcpFixture(agentDir: string, options: { tools: readonly McpFixtureTool[] }): void {
  for (const [file, content] of Object.entries(mcpFixtureFiles(options.tools))) {
    mkdirSync(dirname(join(agentDir, file)), { recursive: true });
    writeFileSync(join(agentDir, file), content);
  }
}

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runServerTest } from "./mcp-test.ts";
import { classifyTestOutcome } from "./mcp-test-outcome.ts";

// A local HTTP server on 127.0.0.1 (ephemeral port) that answers every request 401: Pi's MCP client then says the server
// needs a sign-in. This pins the SDK's own wording that `classifyTestOutcome` reads (M7R96). It uses the loopback only.
let root: string;
let http: Server;
let previousAgentDir: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pap-mcpt-si-"));
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
});
afterEach(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await new Promise<void>((resolve) => (http ? http.close(() => resolve()) : resolve()));
  rmSync(root, { recursive: true, force: true });
});

describe("mcp.test: the SDK's sign-in notice (M7R96)", () => {
  it("reads 'needs sign-in' from the notice Pi's MCP extension raises for a server that answers 401", async () => {
    http = createServer((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const port = (http.address() as AddressInfo).port;
    const home = join(root, "home");
    const agentDir = join(home, ".pi", "agent");
    mkdirSync(agentDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeFileSync(
      join(agentDir, "mcp.json"),
      JSON.stringify({ mcpServers: { remote: { url: `http://127.0.0.1:${port}/mcp` } } }),
    );
    const ctx = { agentDir, papHome: join(root, "pap"), home, signal: new AbortController().signal };
    const run = await runServerTest({ scope: "global", name: "remote", deadlineMs: 15_000 }, ctx);
    expect(run.timedOut).toBe(false);
    expect(run.tools).toEqual([]);
    expect(run.notices).toEqual(["MCP servers need attention:\n  remote: needs sign-in\nRun /mcp to fix."]);
    expect(classifyTestOutcome(run.notices, run.tools, run.timedOut)).toMatchObject({
      state: "needs-sign-in",
      message: null,
    });
  });
});

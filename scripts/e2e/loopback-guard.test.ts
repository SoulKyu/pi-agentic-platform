import { spawn } from "node:child_process";
import { createServer, type Server } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const GUARD = fileURLToPath(new URL("./loopback-guard.ts", import.meta.url));

/** A child under the guard that runs `code`; resolves to what it printed. The server of the test lives here. */
function runUnderGuard(code: string): Promise<{ stdout: string; stderr: string }> {
  const child = spawn(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", `--import=${GUARD}`, "-e", code],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  return new Promise((resolve) => child.on("close", () => resolve({ stdout, stderr })));
}

const connectFrom = (host: string, port: number) =>
  runUnderGuard(`const socket = require("node:net").connect({ host: "${host}", port: ${port} });
    socket.on("connect", () => { console.log("connected"); socket.end(); });
    socket.on("error", (error) => console.log("error " + error.code));`);

// As the daemon's push sender does it: a URL handed to http.request, which gives net a `hostname` and no `host`.
const requestTo = (port: number) =>
  runUnderGuard(`require("node:http")
    .request(new URL("http://127.0.0.1:${port}/push/e2e"), { method: "POST", agent: false }, (res) => { console.log("status " + res.statusCode); res.resume(); })
    .on("error", (error) => console.log("error " + error.code))
    .end("x");`);

describe("loopback-guard", () => {
  const servers: Server[] = [];
  afterEach(() => {
    for (const server of servers.splice(0)) server.close();
  });

  const listen = (): Promise<number> =>
    new Promise((resolve) => {
      const server = createServer((socket) => socket.end()).listen(0, "127.0.0.1", () => {
        servers.push(server);
        const address = server.address();
        resolve(typeof address === "object" && address !== null ? address.port : 0);
      });
    });

  it("lets a connect to 127.0.0.1 through", async () => {
    const result = await connectFrom("127.0.0.1", await listen());
    expect(result.stdout.trim()).toBe("connected");
    expect(result.stderr).not.toContain("pap-network-guard");
  });

  it("lets an http request to a 127.0.0.1 URL through", async () => {
    const result = await requestTo(await listen());
    // The server closes the socket without an answer: the request got as far as the server.
    expect(result.stdout).toMatch(/error ECONNRESET|status/);
    expect(result.stderr).not.toContain("pap-network-guard");
  });

  // Only the literal 127.0.0.1 is let through: a name or another spelling of the same machine is refused even though a
  // server listens on the port (A4 review).
  it.each(["localhost", "::1", "::ffff:127.0.0.1"])(
    "still refuses %s although a server listens",
    async (host) => {
      const result = await connectFrom(host, await listen());
      expect(result.stderr).toContain("pap-network-guard: blocked");
      expect(result.stdout).not.toContain("connected");
    },
  );

  it("still refuses any other address (a documentation address, nothing is sent)", async () => {
    const result = await connectFrom("192.0.2.1", 9);
    expect(result.stderr).toContain("pap-network-guard: blocked");
    expect(result.stdout).not.toContain("connected");
  });
});

import { spawn } from "node:child_process";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// The ProxyCommand of a box's ssh: CONNECT through the box's egress proxy, its refusal printed as the reason.
const HELPER = join(import.meta.dirname, "../../bin/pap-connect");

let server: Server | null = null;
afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

/** A proxy that records the request head and answers `reply` to it, then closes. */
async function proxy(reply: string): Promise<{ url: string; heads: string[] }> {
  const heads: string[] = [];
  server = createServer((socket) => {
    let head = "";
    socket.on("data", (chunk) => {
      head += chunk.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      heads.push(head);
      socket.end(reply);
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, heads };
}

function run(proxyUrl: string, host: string, port: string) {
  const child = spawn(process.execPath, [HELPER, host, port], {
    env: { PATH: process.env.PATH ?? "", HTTPS_PROXY: proxyUrl },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) =>
    child.on("close", (code) => resolve({ code, stdout, stderr })),
  );
}

describe("pap-connect", () => {
  it("asks the proxy for host:port and passes what follows its 200 through", async () => {
    const { url, heads } = await proxy("HTTP/1.1 200 Connection established\r\n\r\nSSH-2.0-fake\r\n");
    const result = await run(url, "box.test", "22");
    expect(heads[0]).toBe("CONNECT box.test:22 HTTP/1.1\r\nHost: box.test:22\r\n\r\n");
    expect(result).toEqual({ code: 0, stdout: "SSH-2.0-fake\r\n", stderr: "" });
  });

  it("brackets an IPv6 target", async () => {
    const { url, heads } = await proxy("HTTP/1.1 200 OK\r\n\r\n");
    await run(url, "fd00::5", "22");
    expect(heads[0]?.split("\r\n")[0]).toBe("CONNECT [fd00::5]:22 HTTP/1.1");
  });

  it("prints the proxy's refusal and exits 1", async () => {
    const body = "pap egress proxy: box.test:22 is not on this agent's host list (not_listed).\n";
    const { url } = await proxy(`HTTP/1.1 403 Forbidden\r\nx-pap-deny: not_listed\r\n\r\n${body}`);
    const result = await run(url, "box.test", "22");
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`pap-connect: ${body}`);
  });
});

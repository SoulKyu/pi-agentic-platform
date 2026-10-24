import { spawn } from "node:child_process";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_VM_MAX_FRAME_BYTES, createFrameDecoder } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";

const TRANSPORT = join(dirname(fileURLToPath(import.meta.url)), "transport.ts");
const TOKEN = "ab".repeat(32);

// The six other names stay in the initial environment block (they are not secret); only the token matters (R24).
// The child starts as the guest starts a worker: the token on fd 3 (written, then closed), the rest in its environment.
const PROBE = `
const { readFileSync } = require("node:fs");
import(${JSON.stringify(TRANSPORT)}).then(async ({ transportFromEnv }) => {
  await transportFromEnv(process.env);
  const environ = readFileSync("/proc/self/environ", "latin1");
  console.log(JSON.stringify({
    token: environ.includes(${JSON.stringify(TOKEN)}),
    name: environ.includes("PAP_GATEWAY_TOKEN"),
    transport: environ.includes("PAP_WORKER_TRANSPORT=socket"),
  }));
  process.exit(0);
}).catch((error) => { console.error(String(error)); process.exit(70); });
`;

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

describe.runIf(process.platform === "linux")("a worker started like the guest starts it", () => {
  it("has no token and no PAP_GATEWAY_TOKEN in its /proc/self/environ", async () => {
    const server = net.createServer();
    cleanup.push(() => server.close());
    const hello = new Promise<unknown>((resolve) => {
      server.once("connection", (socket) => {
        cleanup.push(() => socket.destroy());
        const decoder = createFrameDecoder({
          maxBytes: () => AGENT_VM_MAX_FRAME_BYTES,
          onFrame: (value) => resolve(value),
          onError: () => undefined,
        });
        socket.on("data", (chunk) => decoder.push(chunk));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as net.AddressInfo;
    const child = spawn(
      process.execPath,
      ["--conditions=development", "--disable-warning=ExperimentalWarning", "-e", PROBE],
      {
        stdio: ["ignore", "pipe", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH ?? "",
          PAP_WORKER_TRANSPORT: "socket",
          PAP_GATEWAY: `127.0.0.1:${port}`,
          PAP_LAUNCH_ID: "a".repeat(32),
          PAP_BOX: "agent:scout-ab12",
          PAP_WORKER_SLOT: "d".repeat(32),
          PAP_IMAGE_TAG: `pap-agent-agent-${"c".repeat(64)}`,
        },
      },
    );
    expect((child.pid ?? 0) > 1).toBe(true);
    cleanup.push(() => child.kill("SIGKILL"));
    let out = "";
    let err = "";
    child.stdout?.on("data", (chunk) => (out += String(chunk)));
    child.stderr?.on("data", (chunk) => (err += String(chunk)));
    const exit = new Promise<number | null>((resolve) => child.once("exit", resolve));
    const pipe = child.stdio[3] as NodeJS.WritableStream;
    pipe.end(TOKEN);
    expect(await exit, err).toBe(0);
    expect(JSON.parse(out)).toEqual({ token: false, name: false, transport: true });
    expect(await hello).toMatchObject({
      type: "hello",
      role: "worker",
      token: TOKEN,
      box: { kind: "agent", id: "scout-ab12" },
    });
  });
});

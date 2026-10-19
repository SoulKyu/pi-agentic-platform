import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_VM_MAX_FRAME_BYTES, createFrameDecoder, encodeSocketFrame } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

const MAIN = join(dirname(fileURLToPath(import.meta.url)), "main.ts");
const TOKEN = "ab".repeat(32);
const SLOT = "1".repeat(32);
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

describe.runIf(process.platform === "linux")("pap-guest as a process", () => {
  it("scrubs the token for real, seeds the folder, says hello and hands a real worker its token on fd 3", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pap-guest-int-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const root = join(dir, "agent");
    const layout = {
      root,
      home: join(root, "home"),
      knowledge: join(root, "knowledge"),
      inbox: join(root, "inbox"),
      pi: join(root, ".pi"),
      sessions: join(root, ".pi", "sessions"),
      piAgentDir: join(root, ".pi", "agent"),
      imageAgentDir: join(dir, "image"),
      shellOverlay: join(dir, "shell"),
    };
    for (const folder of [root, layout.imageAgentDir, join(dir, "run")]) mkdirSync(folder);
    writeFileSync(join(layout.imageAgentDir, "settings.json"), "{}");

    const frames: Array<{ role: string; frames: unknown[] }> = [];
    const sockets: net.Socket[] = [];
    const server = net.createServer((socket) => {
      sockets.push(socket);
      const entry = { role: "", frames: [] as unknown[] };
      frames.push(entry);
      const decoder = createFrameDecoder({
        maxBytes: () => AGENT_VM_MAX_FRAME_BYTES,
        onFrame: (value) => {
          if (entry.frames.length === 0) entry.role = (value as { role: string }).role;
          entry.frames.push(value);
        },
        onError: () => undefined,
      });
      socket.on("data", (chunk) => decoder.push(chunk));
      socket.on("error", () => undefined);
    });
    cleanup.push(() => {
      for (const socket of sockets) socket.destroy();
      server.close();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as net.AddressInfo;

    const guest = spawn(
      process.execPath,
      ["--conditions=development", "--disable-warning=ExperimentalWarning", MAIN],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH ?? "",
          PAP_GATEWAY_TOKEN: TOKEN,
          PAP_GATEWAY: `127.0.0.1:${port}`,
          PAP_AGENT_ID: "scout-ab12",
          PAP_LAUNCH_ID: "a".repeat(32),
          PAP_IMAGE_TAG: `pap-agent-agent-${"c".repeat(64)}`,
          PAP_GUEST_RUN_DIR: join(dir, "run"),
          PAP_GUEST_LAYOUT: JSON.stringify(layout),
        },
      },
    );
    cleanup.push(() => guest.kill("SIGKILL"));
    let err = "";
    guest.stderr?.on("data", (chunk) => (err += String(chunk)));
    const exit = new Promise<number | null>((resolve) => guest.once("exit", resolve));

    await vi.waitFor(() => expect(frames.find((f) => f.role === "guest")?.frames.length).toBeGreaterThan(0), {
      timeout: 20_000,
    });
    expect(frames.find((f) => f.role === "guest")?.frames[0]).toMatchObject({ type: "hello", token: TOKEN });
    // The re-executed image holds no token in its initial environment block (R24), and the parked file is gone.
    const environ = readFileSync(`/proc/${guest.pid}/environ`, "latin1");
    expect(environ).not.toContain(TOKEN);
    expect(environ).not.toContain("PAP_GATEWAY_TOKEN");
    expect(() => readFileSync(join(dir, "run", "pap", "launch"))).toThrow(/ENOENT/);
    expect(readFileSync(join(layout.piAgentDir, "settings.json"), "utf8")).toBe("{}");

    const guestSocket = sockets[frames.findIndex((f) => f.role === "guest")] as net.Socket;
    guestSocket.write(encodeSocketFrame({ type: "spawn", slot: SLOT, sessionFile: null, packages: null }));
    // The real pi-host dials as a worker and presents the token it read from fd 3.
    await vi.waitFor(
      () => expect(frames.find((f) => f.role === "worker")?.frames.length).toBeGreaterThan(0),
      {
        timeout: 40_000,
      },
    );
    expect(frames.find((f) => f.role === "worker")?.frames[0]).toMatchObject({
      type: "hello",
      role: "worker",
      slot: SLOT,
      token: TOKEN,
    });

    guestSocket.write(encodeSocketFrame({ type: "shutdown" }));
    expect(await exit, err).toBe(0);
  });
});

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_VM_MAX_FRAME_BYTES, createFrameDecoder, encodeSocketFrame } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

const MAIN = join(dirname(fileURLToPath(import.meta.url)), "main.ts");
const TOKEN = "ab".repeat(32);
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

/** Kills every process whose command line holds `marker`: a service the guest started lives in its own session and outlives a killed guest. */
function killMarked(marker: string): void {
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    try {
      if (readFileSync(`/proc/${entry}/cmdline`, "latin1").includes(marker))
        process.kill(Number(entry), "SIGKILL");
    } catch {
      // gone already, or not ours
    }
  }
}

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });

interface Frame {
  type: string;
  id?: string;
  ok?: boolean;
  value?: unknown;
  code?: string;
  role?: string;
  slot?: string;
  data?: string;
  tail?: string;
}

/** The real `main.ts` as a guest over a fake gateway, with the process backend's plain services. */
async function boot() {
  const dir = mkdtempSync(join(tmpdir(), "pap-guest-svc-"));
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

  const frames: Frame[] = [];
  let peer: net.Socket | undefined;
  const server = net.createServer((socket) => {
    peer = socket;
    const decoder = createFrameDecoder({
      maxBytes: () => AGENT_VM_MAX_FRAME_BYTES,
      onFrame: (value) => frames.push(value as Frame),
      onError: () => undefined,
    });
    socket.on("data", (chunk) => decoder.push(chunk));
    socket.on("error", () => undefined);
  });
  cleanup.push(() => {
    peer?.destroy();
    server.close();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const gatewayPort = (server.address() as net.AddressInfo).port;

  const guest = spawn(
    process.execPath,
    ["--conditions=development", "--disable-warning=ExperimentalWarning", MAIN],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH ?? "",
        PAP_GATEWAY_TOKEN: TOKEN,
        PAP_GATEWAY: `127.0.0.1:${gatewayPort}`,
        PAP_BOX: "agent:scout-ab12",
        PAP_LAUNCH_ID: "a".repeat(32),
        PAP_IMAGE_TAG: `pap-agent-agent-${"c".repeat(64)}`,
        PAP_GUEST_RUN_DIR: join(dir, "run"),
        PAP_GUEST_LAYOUT: JSON.stringify(layout),
        PAP_GUEST_SERVICES: "plain",
      },
    },
  );
  cleanup.push(() => guest.kill("SIGKILL"));
  let err = "";
  guest.stderr?.on("data", (chunk) => (err += String(chunk)));
  const exit = new Promise<number | null>((resolve) => guest.once("exit", resolve));
  await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0), { timeout: 20_000 });

  const ask = async (id: string, op: Record<string, unknown>) => {
    peer?.write(encodeSocketFrame({ type: "op", id, op }));
    await vi.waitFor(() => expect(frames.some((frame) => frame.id === id)).toBe(true), { timeout: 20_000 });
    return frames.find((frame) => frame.id === id) as Frame;
  };
  const port = await freePort();
  // Whatever the test does or fails to do, no service started here outlives it: found by this marker in its command line.
  const marker = `pap-guest-svc-${dir.split("-").pop() ?? "x"}-${port}`;
  cleanup.push(() => killMarked(marker));
  const script = `/*${marker}*/console.log("hello from the service");require("http").createServer((q,r)=>r.end("ok")).listen(Number(process.env.PORT),"127.0.0.1")`;
  const command = `exec '${process.execPath}' -e '${script}'`;
  return {
    guest,
    frames,
    exit,
    err: () => err,
    ask,
    port,
    command,
    send: (value: unknown) => peer?.write(encodeSocketFrame(value)),
  };
}

describe.runIf(process.platform === "linux")(
  "pap-guest supervising a plain service (the process backend)",
  () => {
    it("runs a service on its PORT, owns the port through the real /proc, keeps its output and stops it", async () => {
      const { ask, port, command, send, exit, err } = await boot();
      const started = await ask("01".repeat(16), {
        name: "svc.start",
        service: "web",
        command,
        port,
        network: false,
      });
      expect(started).toMatchObject({
        ok: true,
        value: { name: "web", port, state: "running", reason: null },
      });
      expect(await fetch(`http://127.0.0.1:${port}/`).then((res) => res.text())).toBe("ok");
      const logs = await ask("02".repeat(16), { name: "svc.logs", service: "web" });
      expect(logs.value).toEqual({ lines: ["hello from the service"] });

      expect(await ask("03".repeat(16), { name: "svc.stop", service: "web" })).toMatchObject({
        ok: true,
        value: { stopped: true },
      });
      await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();

      const quick = await ask("04".repeat(16), {
        name: "svc.start",
        service: "gone",
        command: "exit 3",
        port,
        network: false,
      });
      expect(quick).toMatchObject({ ok: true, value: { state: "failed", reason: "exited" } });

      send({ type: "shutdown" });
      expect(await exit, err()).toBe(0);
    });

    it("relays a request through a tunnel to the service and half-closes it", async () => {
      const { ask, port, command, send, frames } = await boot();
      const slot = "9".repeat(32);
      const started = (await ask("06".repeat(16), {
        name: "svc.start",
        service: "web",
        command,
        port,
        network: false,
      })) as Frame & { value: { id: string } };
      expect(started).toMatchObject({ ok: true, value: { state: "running" } });
      send({ type: "tunnel_open", slot, service: started.value.id });
      // The side connection becomes the gateway's newest peer: what is sent from here on reaches the tunnel.
      await vi.waitFor(() => expect(frames.find((frame) => frame.role === "tunnel")).toMatchObject({ slot }));
      send({ type: "tunnel_data", data: Buffer.from("GET / HTTP/1.0\r\n\r\n").toString("base64") });
      await vi.waitFor(
        () => {
          const body = frames
            .filter((frame) => frame.type === "tunnel_data")
            .map((frame) => Buffer.from(frame.data ?? "", "base64").toString())
            .join("");
          expect(body).toContain("ok");
        },
        { timeout: 20_000 },
      );
      expect(frames).toContainEqual({ type: "tunnel_ack", bytes: 18 });

      send({ type: "tunnel_end" });
      await vi.waitFor(() => expect(frames.some((frame) => frame.type === "tunnel_end")).toBe(true), {
        timeout: 20_000,
      });
    });

    it("leaves no service process and frees the port when the box is stopped with SIGTERM to the guest", async () => {
      const { guest, ask, port, command, exit } = await boot();
      const started = await ask("05".repeat(16), {
        name: "svc.start",
        service: "web",
        command,
        port,
        network: false,
      });
      expect(started).toMatchObject({ ok: true, value: { state: "running" } });
      expect(await fetch(`http://127.0.0.1:${port}/`).then((res) => res.text())).toBe("ok");
      // What the process backend does on a box stop: SIGTERM to the guest's group, nothing to the services' own sessions.
      guest.kill("SIGTERM");
      await exit;
      await vi.waitFor(async () => await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow(), {
        timeout: 10_000,
      });
    });
  },
);

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, vi } from "vitest";
import {
  AGENT_VM_MAX_FRAME_BYTES,
  createFrameDecoder,
  encodeSocketFrame,
  type PtyCommand,
  type VmLayout,
} from "@pap/contracts";
import { fakeClock, IDENTITY, layout, SLOT, TOKEN } from "../../testing/guest-harness.ts";
import { loadNodePty } from "./load.ts";
import { createPtyHost } from "./pty.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
});

export const open = (cwd: string, extra: Record<string, unknown> = {}) =>
  ({ type: "pty_open", slot: SLOT, cwd, cols: 80, rows: 24, ...extra }) as const;
export const b64 = (text: string): string => Buffer.from(text).toString("base64");

/** A fake gateway for terminal connections, and a pty host wired to it with the real node-pty. */
export async function rig() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pap-pty-")));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const project = join(dir, "project");
  const home = join(dir, "home");
  mkdirSync(join(project, "sub"), { recursive: true });
  mkdirSync(home);
  symlinkSync(dir, join(project, "out"));
  const vmLayout: VmLayout = { ...layout, home, project };

  const frames: Array<Record<string, unknown>> = [];
  let hello: Record<string, unknown> | undefined;
  let received = Buffer.alloc(0);
  let peer: net.Socket | undefined;
  const server = net.createServer((socket) => {
    peer = socket;
    const decoder = createFrameDecoder({
      maxBytes: () => AGENT_VM_MAX_FRAME_BYTES,
      onFrame: (value) => {
        const frame = value as Record<string, unknown>;
        if (hello === undefined) hello = frame;
        else {
          frames.push(frame);
          if (frame.type === "pty_output") {
            received = Buffer.concat([received, Buffer.from(frame.data as string, "base64")]);
          }
        }
      },
      onError: () => undefined,
    });
    socket.on("data", (chunk) => decoder.push(chunk));
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  cleanups.push(() => {
    peer?.destroy();
    server.close();
  });

  const refused: Array<[string, string]> = [];
  const logs: string[] = [];
  let connects = 0;
  const host = createPtyHost({
    env: { ...IDENTITY, PAP_GATEWAY: `127.0.0.1:${port}`, PATH: process.env.PATH },
    token: TOKEN,
    layout: vmLayout,
    clock: fakeClock(),
    connect: () => {
      connects += 1;
      return net.connect(port, "127.0.0.1");
    },
    load: loadNodePty,
    refuse: (slot, why) => void refused.push([slot, why]),
    log: (line) => void logs.push(line),
  });
  cleanups.push(() => host.closeAll());

  const send = (command: PtyCommand): void => void peer?.write(encodeSocketFrame(command));
  const type = (text: string): void => send({ type: "pty_input", data: b64(text) });
  const output = (): string => received.toString("utf8");
  const sawOutput = (text: string) => vi.waitFor(() => expect(output()).toContain(text), { timeout: 10_000 });
  const exits = () => frames.filter((frame) => frame.type === "pty_exit");
  return {
    dir,
    project,
    home,
    host,
    refused,
    logs,
    frames,
    send,
    type,
    output,
    sawOutput,
    exits,
    connects: () => connects,
    hello: () => hello,
    receivedBytes: () => received.length,
    hangUp: () => peer?.destroy(),
  };
}

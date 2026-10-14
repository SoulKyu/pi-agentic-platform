import { randomBytes } from "node:crypto";
import { encodeFrame, FRAME_OPS, type BinaryFrame, type ParamsOf, type ResultOf } from "@pap/contracts";
import { expect, vi } from "vitest";
import { startTestDaemon, type TestDaemon, type TestDaemonOptions } from "../../../testing/harness.ts";
import type { TestClient } from "../../../testing/ws-client.ts";

export interface Wire {
  readonly t: TestDaemon;
  readonly cookie: string;
  readonly client: TestClient;
}

/** A test daemon whose owner has one project (the harness's `work` folder) and a `/bin/sh` for terminals. */
export async function startWire(options: TestDaemonOptions = {}): Promise<Wire> {
  const t = await startTestDaemon(
    { steps: [{ text: "hi" }] },
    { ...options, workerEnv: { SHELL: "/bin/sh", ...options.workerEnv } },
  );
  try {
    const cookie = await t.login();
    const client = await t.connect(cookie);
    const created = (await client.call("sessions.create", { cwd: t.cwd })) as { ok: boolean };
    expect(created.ok).toBe(true);
    return { t, cookie, client };
  } catch (error) {
    await t.stop();
    throw error;
  }
}

export const newRequestId = (): string => randomBytes(16).toString("base64url");

type TerminalMethod =
  "terminal.create" | "terminal.attach" | "terminal.resize" | "terminal.close" | "terminal.detach";

export async function rpc<M extends TerminalMethod>(
  client: TestClient,
  method: M,
  params: ParamsOf<M>,
): Promise<ResultOf<M>> {
  const reply = (await client.call(method, params)) as {
    ok: boolean;
    result?: unknown;
    error?: { code: string };
  };
  if (!reply.ok) throw new Error(`${method} failed: ${reply.error?.code}`);
  return reply.result as ResultOf<M>;
}

export async function createTerminal(
  client: TestClient,
  cwd: string,
  requestId = newRequestId(),
): Promise<string> {
  const { terminalId } = await rpc(client, "terminal.create", { requestId, cwd, cols: 80, rows: 24 });
  return terminalId;
}

/** One attached binary stream as a client sees it. */
export interface TermStream {
  readonly streamId: number;
  readonly info: ResultOf<"terminal.attach">;
  frames(): BinaryFrame[];
  text(): string;
  type(text: string): void;
  ack(offset: number): void;
  /** The offset after the last output byte received (the ack to send). */
  received(): number;
}

export async function attach(client: TestClient, terminalId: string, after?: number): Promise<TermStream> {
  const info = await rpc(client, "terminal.attach", {
    terminalId,
    ...(after === undefined ? {} : { after }),
  });
  const { streamId } = info;
  let inputSeq = 0;
  const frames = (): BinaryFrame[] => client.binaryFrames.filter((frame) => frame.streamId === streamId);
  const outputs = (): BinaryFrame[] => frames().filter((frame) => frame.op === FRAME_OPS.output);
  return {
    streamId,
    info,
    frames,
    text: () => Buffer.concat(outputs().map((frame) => frame.payload)).toString("utf8"),
    type: (text) =>
      client.sendBinary(
        encodeFrame({ op: FRAME_OPS.input, streamId, seq: ++inputSeq, payload: Buffer.from(text) }),
      ),
    ack: (offset) =>
      client.sendBinary(
        encodeFrame({ op: FRAME_OPS.ack, streamId, seq: offset, payload: new Uint8Array(0) }),
      ),
    received: () => {
      const last = outputs().at(-1);
      return last ? last.seq + last.payload.byteLength : info.start;
    },
  };
}

/** Waits (bounded, real time: a real shell) until the stream's text contains `needle`. */
export const untilText = (stream: TermStream, needle: string, timeout = 15_000): Promise<void> =>
  vi.waitFor(() => expect(stream.text()).toContain(needle), { timeout, interval: 20 });

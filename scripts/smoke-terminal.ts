// The smoke's terminal step: node-pty must load from the built daemon (apps/daemon/dist), and a shell must answer
// over the binary frames of /ws. A terminal is created in the smoke's project folder, attached on the raw socket,
// typed into, and closed.
import { randomBytes } from "node:crypto";
import { asJson, type SmokeSocket, step } from "./smoke-lib.ts";

const OP_INPUT = 16;

export async function checkTerminal(context: {
  readonly cwd: string;
  readonly socket: SmokeSocket;
}): Promise<void> {
  const { cwd, socket } = context;
  const requestId = randomBytes(16).toString("base64url");
  const created = asJson(await socket.call("terminal.create", { requestId, cwd, cols: 80, rows: 24 }));
  const terminalId = String(created.terminalId);
  const attached = asJson(await socket.call("terminal.attach", { terminalId }));
  const streamId = Number(attached.streamId);
  socket.sendBinary(OP_INPUT, streamId, 1, Buffer.from("echo pap-smoke-$((6*7))\r"));
  await socket.waitForOutput(streamId, "pap-smoke-42", "the terminal to print pap-smoke-42");
  await socket.call("terminal.close", { terminalId });
  step("terminal: created, typed into over binary frames, closed");
}

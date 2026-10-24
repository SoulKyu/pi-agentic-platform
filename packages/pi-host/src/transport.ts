import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import net from "node:net";
import { basename } from "node:path";
import { AGENT_VM_PROTOCOL, GatewayToken, parseBoxKey, SessionFileName, WorkerHello } from "@pap/contracts";
import { createIpc, type Ipc } from "./ipc.ts";
import { createSocketIpc } from "./socket-ipc.ts";

/** The guest writes the gateway token to this pipe and closes it (R24): it is never in an environment. */
export const TOKEN_FD = 3;
const HELLO_ENV = [
  "PAP_GATEWAY",
  "PAP_LAUNCH_ID",
  "PAP_BOX",
  "PAP_WORKER_SLOT",
  "PAP_IMAGE_TAG",
  "PAP_SESSION_FILE",
] as const;
/** How much of a session file's end is read to find the last entry id; a longer last line has none. */
const TAIL_BYTES = 1024 * 1024;
const CONNECT_TIMEOUT_MS = 10_000;

interface SessionFacts {
  file: string | null;
  lastEntryId: string | null;
  size: number;
}

export function sessionFacts(path: string | undefined): SessionFacts {
  const none: SessionFacts = { file: null, lastEntryId: null, size: 0 };
  if (!path) return none;
  const file = SessionFileName.safeParse(basename(path));
  if (!file.success) return none;
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const tail = Buffer.alloc(length);
    readSync(fd, tail, 0, length, size - length);
    return { file: file.data, lastEntryId: lastEntryId(tail), size };
  } catch {
    return none;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function lastEntryId(tail: Buffer): string | null {
  const text = tail.toString("utf8").replace(/\n+$/, "");
  const start = text.lastIndexOf("\n");
  // A last line that starts before the tail is cut, does not parse and has no id.
  try {
    const id = (JSON.parse(text.slice(start + 1)) as { id?: unknown }).id;
    return typeof id === "string" && id.length >= 1 && id.length <= 128 ? id : null;
  } catch {
    return null;
  }
}

function connect(gateway: string): Promise<net.Socket> {
  const split = gateway.lastIndexOf(":");
  const port = Number(gateway.slice(split + 1));
  if (split < 1 || !Number.isInteger(port) || port < 1 || port > 65535) {
    return Promise.reject(new Error("PAP_GATEWAY must be host:port"));
  }
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: gateway.slice(0, split), port });
    socket.setNoDelay(true);
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => socket.destroy(new Error("gateway connect timed out")));
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.setTimeout(0);
      socket.off("error", reject);
      resolve(socket);
    });
  });
}

/**
 * With `PAP_WORKER_TRANSPORT=socket` the worker dials the gateway: the token comes from `readToken` (fd 3), the other
 * names from `env`, and the six of them are deleted from `process.env` before anything else runs. A failure rejects;
 * `main.ts` exits 70 on it. Otherwise the worker keeps Node's IPC.
 */
export async function transportFromEnv(
  env: NodeJS.ProcessEnv,
  readToken: () => string = () => readFileSync(TOKEN_FD, "utf8"),
): Promise<Ipc> {
  if (env.PAP_WORKER_TRANSPORT !== "socket") return createIpc(process);
  const values: Record<string, string | undefined> = {};
  for (const name of HELLO_ENV) {
    values[name] = env[name];
    Reflect.deleteProperty(env, name);
    Reflect.deleteProperty(process.env, name);
  }
  let token: string;
  try {
    token = readToken();
  } catch {
    throw new Error("the gateway token could not be read from fd 3");
  }
  const checked = GatewayToken.safeParse(token.replace(/\n$/, ""));
  if (!checked.success) throw new Error("the gateway token on fd 3 is malformed");
  for (const name of HELLO_ENV) {
    if (name !== "PAP_SESSION_FILE" && !values[name]) throw new Error(`${name} is required`);
  }
  const hello = WorkerHello.safeParse({
    type: "hello",
    role: "worker",
    box: parseBoxKey(values.PAP_BOX ?? ""),
    launchId: values.PAP_LAUNCH_ID,
    token: checked.data,
    protocol: AGENT_VM_PROTOCOL,
    imageTag: values.PAP_IMAGE_TAG,
    slot: values.PAP_WORKER_SLOT,
    session: sessionFacts(values.PAP_SESSION_FILE),
  });
  if (!hello.success) {
    const fields = [...new Set(hello.error.issues.map((issue) => issue.path.join(".")))];
    throw new Error(`the worker hello is invalid (fields: ${fields.join(", ")})`);
  }
  const socket = await connect(values.PAP_GATEWAY as string);
  return createSocketIpc(socket, hello.data);
}

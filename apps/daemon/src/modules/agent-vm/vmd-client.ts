import net from "node:net";
import { type ErrorCode, PapError, VMD_MAX_FRAME_BYTES, VmdRequest, VmdResponse } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";

/** R36: owned by pap's uid, mode 0600; the daemon is the only client. */
export const VMD_SOCKET = "/run/pap-vm/vmd.sock";
export const DEFAULT_DEADLINE_MS = 60_000;
/** `image.build` copies trees and runs `apt`: pap-vmd's own build timeout (30 minutes) and a minute more (AVM-E47). */
export const BUILD_DEADLINE_MS = 31 * 60_000;

/** `image.progress` is a quick look at a tail in memory: a vmd that does not answer in this time has no sign of life to give. */
export const PROGRESS_DEADLINE_MS = 5_000;

/** What pap-vmd answered (`VmdResponse`), or why no answer came: `timeout`, `protocol` (not one valid frame). */
export type VmdErrorCode =
  | "bad_request"
  | "not_found"
  | "conflict"
  | "capacity"
  | "disk_low"
  | "unavailable"
  | "failed"
  | "timeout"
  | "protocol";

/** The text is fixed: a request holds a launch token (R8), so no error ever carries one. */
export class VmdError extends Error {
  readonly code: VmdErrorCode;
  constructor(code: VmdErrorCode) {
    super(`vmd ${code}`);
    this.name = "VmdError";
    this.code = code;
  }
}

const PAP_CODE: Record<VmdErrorCode, ErrorCode> = {
  bad_request: "bad_request",
  not_found: "not_found",
  conflict: "conflict",
  capacity: "capacity",
  disk_low: "disk_low",
  unavailable: "sandbox_unavailable",
  failed: "worker_failed",
  timeout: "timeout",
  protocol: "sandbox_unavailable",
};

/** What a caller of the daemon's own API sees of a pap-vmd failure; a `PapError` passes, anything else is `internal`. */
export function papErrorOf(error: unknown): PapError {
  if (error instanceof PapError) return error;
  return new PapError(error instanceof VmdError ? PAP_CODE[error.code] : "internal");
}

export interface VmdClient {
  /** The `result` of an ok answer; a `VmdError` otherwise. */
  request(request: VmdRequest): Promise<unknown>;
}

const refuse = (code: VmdErrorCode): never => {
  throw new VmdError(code);
};

const decoder = new TextDecoder("utf-8", { fatal: true });

/** One answer line, or `protocol`: not UTF-8, not one JSON line, not a `VmdResponse`. */
function resultOf(frames: Buffer[]): unknown {
  let text: string;
  try {
    text = decoder.decode(Buffer.concat(frames));
  } catch {
    throw new VmdError("protocol");
  }
  const line = text.endsWith("\n") ? text.slice(0, -1) : text;
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    json = undefined;
  }
  const answer = VmdResponse.safeParse(json);
  if (!answer.success) throw new VmdError("protocol");
  if (!answer.data.ok) throw new VmdError(answer.data.code);
  return answer.data.result;
}

/**
 * RT-33: one connection per request. The request is validated against the schemas the server uses and bounded both ways by
 * `VMD_MAX_FRAME_BYTES` (an answer over it is refused as it arrives); a deadline from the injected clock ends a wait.
 */
export function createVmdClient(socketPath: string, clock: Clock): VmdClient {
  return {
    request(request) {
      const parsed = VmdRequest.safeParse(request);
      const line = parsed.success ? JSON.stringify(parsed.data) : "";
      if (!parsed.success || Buffer.byteLength(line) > VMD_MAX_FRAME_BYTES)
        return Promise.reject(new VmdError("bad_request"));
      const deadline =
        parsed.data.op === "image.build"
          ? BUILD_DEADLINE_MS
          : parsed.data.op === "image.progress"
            ? PROGRESS_DEADLINE_MS
            : DEFAULT_DEADLINE_MS;
      return new Promise<unknown>((resolve, reject) => {
        const frames: Buffer[] = [];
        let size = 0;
        let settled = false;
        const socket = net.connect({ path: socketPath });
        const settle = (outcome: () => unknown): void => {
          if (settled) return;
          settled = true;
          clock.clearTimeout(timer);
          socket.destroy();
          try {
            resolve(outcome());
          } catch (error) {
            reject(error);
          }
        };
        const timer = clock.setTimeout(() => settle(() => refuse("timeout")), deadline);
        socket.on("connect", () => socket.end(`${line}\n`));
        socket.on("data", (chunk: Buffer) => {
          size += chunk.length;
          // The answer line is at most the frame bound plus its newline.
          if (size > VMD_MAX_FRAME_BYTES + 1) settle(() => refuse("protocol"));
          else frames.push(chunk);
        });
        socket.on("error", () => settle(() => refuse("unavailable")));
        socket.on("close", () => settle(() => resultOf(frames)));
      });
    },
  };
}

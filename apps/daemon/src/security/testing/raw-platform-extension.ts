import { existsSync, readFileSync } from "node:fs";
import { PLATFORM_OP_NAMES, type PlatformOp } from "@pap/contracts";

// Test only. The raw `platform_call` a compromised worker would send, for every op, from inside a real worker. The worker
// registers a platform tool only where its session type allows the op, so no tool can make these calls: the scripted
// provider (running inside the worker, honoured only beside PAP_TEST_PROVIDER_SCRIPT) puts the records on the worker's
// own IPC channel, exactly as written, and appends the daemon's answers to `captureRawResults`.

export interface RawCall {
  readonly op: string;
  readonly toolCallId?: string;
  readonly args: unknown;
}

/** Well-formed arguments for every op: only the caller's session type, taint and approval decide what happens to a call. */
export const RAW_ARGS: Readonly<Record<PlatformOp, object>> = {
  "agent.notify": { text: "raw notify" },
  "agent.approve": { title: "raw approve", summary: "asked by a raw call" },
  "agent.delegate": { agent: "Scout", task: "raw delegation" },
  "agent.remind": { when: "30m", note: "raw reminder" },
  "lane.note": { note: "raw lane note" },
  "secret.request": { name: "RAW_TOKEN", reason: "asked by a raw call" },
  "network.request": { host: "raw.test", reason: "asked by a raw call" },
  "subagent.run": { task: "raw subagent task" },
  "preview.start": { name: "raw-site", command: "exit 3", port: 8000 },
  "preview.stop": { name: "raw-site" },
};

export const rawCall = (op: PlatformOp, toolCallId = `raw-${op}`, args: object = RAW_ARGS[op]): RawCall => ({
  op,
  toolCallId,
  args,
});

/** One call per op, in the table's order, each with its own tool call id. */
export const everyOp = (): RawCall[] => PLATFORM_OP_NAMES.map((op) => rawCall(op));

/** A script step that sends `calls` as the model's reply is served, then ends the run with a line of text. */
export const rawStep = (calls: readonly RawCall[]) => ({ text: "raw calls sent", rawPlatformCalls: calls });

export interface RawAnswer {
  readonly id: string;
  readonly ok: boolean;
  readonly error?: string;
  readonly result?: unknown;
}

/** The daemon's answers the worker saw, in arrival order (`r1`, `r2`... are the calls in the order they were sent). */
export function rawAnswers(file: string): RawAnswer[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as RawAnswer);
}

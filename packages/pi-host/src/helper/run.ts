import { userInfo } from "node:os";
import {
  DaemonToHelper,
  HELPER_MAX_RECORD_BYTES,
  type HelperRun,
  type HelperToDaemon,
} from "@pap/contracts/pi-host";
import { type HelperContext, HelperOpError, type OpTable } from "./ops.ts";

type DoneRecord = Extract<HelperToDaemon, { type: "helper_done" }>;
type Io = Pick<HelperContext, "emit" | "prompt">;

export interface HelperChannel {
  /** Resolves once the record is flushed; rejects when the channel is closed. */
  send(record: HelperToDaemon): Promise<void>;
  onMessage(listener: (raw: unknown) => void): void;
}

const failed = (code: Extract<DoneRecord, { ok: false }>["code"], detail?: string): DoneRecord => ({
  type: "helper_done",
  ok: false,
  code,
  ...(detail === undefined ? {} : { detail }),
});

// First line only, so a stack never travels; at most 200 characters, under the record's 256.
const detailOf = (error: unknown): string =>
  (error instanceof Error ? `${error.name}: ${error.message}` : "a value was thrown")
    .split("\n")[0]
    ?.slice(0, 200) ?? "";

export async function executeOp(
  run: HelperRun,
  ops: OpTable,
  where: { readonly home: string },
  signal: AbortSignal,
  io: Io,
): Promise<DoneRecord> {
  // Own keys only: "constructor" and "__proto__" are not operations.
  const op = Object.hasOwn(ops, run.op) ? ops[run.op] : undefined;
  if (!op) return failed("unknown_op");
  const params = op.params.safeParse(run.params);
  if (!params.success) return failed("bad_params");
  try {
    const result = await op.run(params.data, {
      agentDir: run.agentDir,
      papHome: run.papHome,
      home: where.home,
      ...(run.cwd === undefined ? {} : { cwd: run.cwd }),
      signal,
      ...io,
    });
    return { type: "helper_done", ok: true, result };
  } catch (error) {
    if (error instanceof HelperOpError)
      return failed(error.code, error.message.split("\n")[0]?.slice(0, 200));
    return failed("failed", detailOf(error));
  }
}

const sizeOf = (record: unknown): number => Buffer.byteLength(JSON.stringify(record) ?? "");

/**
 * The home folder the breadth rule protects: `$HOME`, else the account's own (Pi does the same). Never `/`, which
 * would make `home-or-above` protect nothing (M7R104).
 */
export function homeOf(env: NodeJS.ProcessEnv, account: () => string = () => userInfo().homedir): string {
  const given = env.HOME;
  return given !== undefined && given.startsWith("/") ? given : account();
}

/** Serves the one run record of this process, then returns once the answer was sent. */
export async function serveHelper(
  channel: HelperChannel,
  ops: OpTable,
  where: { readonly home: string } = { home: homeOf(process.env) },
): Promise<void> {
  const controller = new AbortController();
  const waiting = new Map<string, (value: string | null) => void>();
  let started = false;
  let nextPrompt = 0;
  const first = new Promise<DaemonToHelper>((resolve) => {
    channel.onMessage((raw) => {
      const parsed = DaemonToHelper.safeParse(raw);
      if (!parsed.success) return;
      const record = parsed.data;
      if (record.type === "helper_cancel") {
        controller.abort();
        for (const answer of waiting.values()) answer(null);
        waiting.clear();
        if (!started) resolve(record);
      } else if (record.type === "helper_answer") {
        const answer = waiting.get(record.promptId);
        waiting.delete(record.promptId);
        answer?.(record.value);
      } else if (!started) {
        started = true;
        resolve(record);
      }
    });
  });
  const record = await first;
  if (record.type !== "helper_run") return void (await channel.send(failed("bad_params")));
  const send = (message: HelperToDaemon): void => {
    if (sizeOf(message) > HELPER_MAX_RECORD_BYTES) throw new Error("record too large");
    void channel.send(message).catch(() => {});
  };
  const io: Io = {
    emit: (event) => send({ type: "helper_event", event }),
    prompt: (prompt) =>
      new Promise<string | null>((resolve) => {
        if (controller.signal.aborted) return resolve(null);
        const promptId = `p${++nextPrompt}`;
        waiting.set(promptId, resolve);
        try {
          send({ type: "helper_prompt", promptId, prompt });
        } catch {
          waiting.delete(promptId);
          resolve(null);
        }
      }),
  };
  const done = await executeOp(record, ops, where, controller.signal, io);
  await channel.send(sizeOf(done) > HELPER_MAX_RECORD_BYTES ? failed("failed", "result too large") : done);
}

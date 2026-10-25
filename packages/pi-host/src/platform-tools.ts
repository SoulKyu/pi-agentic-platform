import type { LoadExtensionsResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import {
  isVaultName,
  PLATFORM_OPS,
  PLATFORM_RESULTS,
  type PlatformError,
  type PlatformOp,
  type PlatformResultRecord,
} from "@pap/contracts/pi-host";
import { errorClass } from "./bounded.ts";
import type { Outbound } from "./ipc.ts";
import type { NamedInlineExtension } from "./policy/extension.ts";
import { PLATFORM_SOURCE } from "./policy/tool-kind.ts";
import { refusalText, subagentText, successText } from "./platform-text.ts";

export const MAX_PLATFORM_IN_FLIGHT = 8;
const MAX_TOOL_CALL_ID = 256;
/** The worker waits this long past the op's own deadline before it gives up (M11R11). */
const DEADLINE_GRACE_MS = 5_000;
const LOG_EVERY_MS = 60_000;

export type PlatformOutcome =
  { readonly ok: true; readonly result: unknown } | { readonly ok: false; readonly error: PlatformError };

/** What the tools talk to: in the worker, the IPC to the daemon (`createPlatformPort`). */
export interface PlatformPort {
  call(
    op: PlatformOp,
    toolCallId: string,
    args: unknown,
    signal: AbortSignal | undefined,
  ): Promise<PlatformOutcome>;
}

export interface PlatformTimers {
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}
const REAL_TIMERS: PlatformTimers = {
  setTimer: (fn, ms) => setTimeout(fn, ms).unref(),
  clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface PlatformBridge {
  readonly port: PlatformPort;
  /** The daemon's `platform_result`: settles the call of that id; an id nobody waits for is dropped. */
  resolve(record: PlatformResultRecord): void;
}

export interface PlatformPortOptions {
  readonly timers?: PlatformTimers;
  readonly newId?: () => string;
  readonly log?: (line: string) => void;
  readonly now?: () => number;
}

const failed = (error: PlatformError): PlatformOutcome => ({ ok: false, error });

/**
 * M11R11 and M11R16: the pending calls of one worker. At most 8 in flight (the ninth settles `rate_limited` without a
 * record), each with a deadline of the op's own plus five seconds, a `platform_cancel` on Stop or timeout, and the
 * timer and abort listener cleared on every path.
 */
export function createPlatformPort(
  send: (record: Outbound) => boolean,
  options: PlatformPortOptions = {},
): PlatformBridge {
  const timers = options.timers ?? REAL_TIMERS;
  const log = options.log ?? ((line) => void process.stderr.write(line));
  const now = options.now ?? Date.now;
  let counter = 0;
  const newId = options.newId ?? (() => `p${++counter}`);
  const pending = new Map<string, (outcome: PlatformOutcome) => void>();
  let lastLogged = Number.NEGATIVE_INFINITY;

  const trySend = (record: Outbound): boolean => {
    try {
      return send(record);
    } catch (error) {
      log(`pi-host: a platform record was not sent (${errorClass(error)})\n`);
      return false;
    }
  };

  const port: PlatformPort = {
    call(op, toolCallId, args, signal) {
      if (signal?.aborted) return Promise.resolve(failed("cancelled"));
      // The record schema allows 1 to 256 characters: any other id would only wait for its deadline.
      if (toolCallId.length < 1 || toolCallId.length > MAX_TOOL_CALL_ID)
        return Promise.resolve(failed("bad_request"));
      if (pending.size >= MAX_PLATFORM_IN_FLIGHT) return Promise.resolve(failed("rate_limited"));
      const id = newId();
      return new Promise<PlatformOutcome>((resolve) => {
        const onAbort = () => end(failed("cancelled"), true);
        const end = (outcome: PlatformOutcome, tellDaemon: boolean) => {
          if (!pending.delete(id)) return;
          timers.clearTimer(timer);
          signal?.removeEventListener("abort", onAbort);
          if (tellDaemon) trySend({ type: "platform_cancel", id });
          resolve(outcome);
        };
        pending.set(id, (outcome) => end(outcome, false));
        const timer = timers.setTimer(
          () => end(failed("timeout"), true),
          PLATFORM_OPS[op].deadlineMs + DEADLINE_GRACE_MS,
        );
        signal?.addEventListener("abort", onAbort, { once: true });
        if (!trySend({ type: "platform_call", id, op, toolCallId, args })) end(failed("unavailable"), false);
      });
    },
  };

  return {
    port,
    resolve(record) {
      const settle = pending.get(record.id);
      if (!settle) {
        // A late answer after Stop or a timeout, or an id the worker never used: nothing of it is logged.
        if (now() - lastLogged >= LOG_EVERY_MS) {
          lastLogged = now();
          log("pi-host: a platform_result nobody waits for was dropped\n");
        }
        return;
      }
      if (!record.ok) return settle(failed(record.error ?? "internal"));
      settle({ ok: true, result: record.result });
    },
  };
}

/** Tool text for the model: written here (TypeBox mirrors `PLATFORM_ARGS`; the daemon parses again and never trusts this). */
const DESCRIPTIONS: Readonly<Record<PlatformOp, string>> = {
  "agent.notify":
    "Tell the owner something they should see: an Inbox item and a card in this thread. Not for questions; use agent_approve to ask.",
  "agent.approve":
    "Ask the owner to approve or deny something before you do it. It waits up to 25 minutes; no answer counts as denied.",
  "agent.delegate":
    "Hand a task to another agent by its name. The result comes back later as a card in this thread. After external content the owner is asked first.",
  "agent.remind":
    "Set a one-shot reminder for yourself: a task on this thread at a later time, such as 'in 2 hours' or an ISO 8601 date and time. After external content the owner is asked first.",
  "lane.note": "Set the one-line note shown for this lane. It replaces the previous note.",
  "secret.request":
    "Ask the owner for a secret by its UPPER_CASE name. You get a reference, never the value; your sandboxed shell reads it as an environment variable.",
  "network.request":
    "Ask the owner to allow one exact host (such as api.example.com) for your shell's network until this thread is reset. Use it when the network refused a host.",
  "subagent.run":
    "Run a task in a separate child session and get its final answer back. Give it everything it needs: it does not see this conversation.",
};

const one = (max: number) => Type.String({ minLength: 1, maxLength: max });
const PARAMETERS = {
  "agent.notify": Type.Object({ text: one(500) }, { additionalProperties: false }),
  "agent.approve": Type.Object(
    { title: one(120), summary: Type.Optional(one(1000)) },
    { additionalProperties: false },
  ),
  "agent.delegate": Type.Object(
    { agent: Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_-]{0,31}$" }), task: one(8000) },
    { additionalProperties: false },
  ),
  "agent.remind": Type.Object(
    { when: Type.String({ minLength: 2, maxLength: 64 }), note: one(2000) },
    { additionalProperties: false },
  ),
  "lane.note": Type.Object({ note: Type.String({ maxLength: 2000 }) }, { additionalProperties: false }),
  "secret.request": Type.Object(
    { name: Type.String({ pattern: "^[A-Z][A-Z0-9_]{0,63}$" }), reason: one(500) },
    { additionalProperties: false },
  ),
  "network.request": Type.Object(
    { host: Type.String({ minLength: 1, maxLength: 253 }), reason: Type.Optional(one(200)) },
    { additionalProperties: false },
  ),
  "subagent.run": Type.Object(
    {
      task: one(8000),
      profile: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" })),
    },
    { additionalProperties: false },
  ),
} as const satisfies Record<PlatformOp, unknown>;

const internal = (op: PlatformOp): never => {
  throw new Error(refusalText(op, "internal"));
};

function definitionOf(op: PlatformOp, port: PlatformPort, autonomous: () => boolean): ToolDefinition {
  const tool = PLATFORM_OPS[op].tool;
  return {
    name: tool,
    label: tool,
    description: DESCRIPTIONS[op],
    parameters: PARAMETERS[op],
    async execute(toolCallId, args, signal) {
      // The pattern above is only the shape; the daemon's `VaultName` also refuses a name that hijacks the shell: fail here too.
      if (op === "secret.request" && !isVaultName((args as { name?: string }).name ?? ""))
        throw new Error(refusalText(op, "bad_request", autonomous()));
      const outcome = await port.call(op, toolCallId, args, signal);
      // Pi turns a throw into the tool's error result: the message is a fixed sentence.
      if (!outcome.ok) throw new Error(refusalText(op, outcome.error, autonomous()));
      const parsed = PLATFORM_RESULTS[op].safeParse(outcome.result);
      if (!parsed.success) return internal(op);
      if (op === "subagent.run") {
        const answer = parsed.data as Parameters<typeof subagentText>[0];
        // `details.tainted` is what stage 07 reads (M11R15): set here, from the daemon's own result.
        return {
          content: [{ type: "text", text: subagentText(answer) }],
          details: { op, tainted: answer.tainted },
        };
      }
      const text = successText(op, parsed.data);
      return text === null ? internal(op) : { content: [{ type: "text", text }], details: { op } };
    },
  };
}

/**
 * M11R10: an inline extension (not `builtin`: a Pi setting could disable a builtin and its source would be
 * `builtin:<name>`), whose tools' source is `<inline:pap-platform>`. One tool per op of the list, nothing for an empty one.
 */
export function createPlatformTools(
  ops: readonly PlatformOp[],
  port: PlatformPort,
  /** Whether this worker started with trusted autonomy (its start-time rules). */
  autonomous: () => boolean = () => false,
): NamedInlineExtension {
  return {
    name: "pap-platform",
    factory: (pi) => {
      for (const op of ops) pi.registerTool(definitionOf(op, port, autonomous));
    },
  };
}

/**
 * W5-R12: Pi keeps the first registration of a tool name, and file extensions load before inline factories. Moving
 * pap-platform first makes its tools win; any other extension that registered the same name lost, and that is
 * reported once per session with a fixed sentence (the tool name is one pap registered, never the extension's own text).
 */
export function platformFirst(
  report: (error: { extensionPath: string; event: string; error: string }) => void,
): (base: LoadExtensionsResult) => LoadExtensionsResult {
  const reported = new Set<string>();
  return (base) => {
    const mine = base.extensions.find((extension) => extension.path === PLATFORM_SOURCE);
    if (!mine) return base;
    // The names pap registered in this session, not the whole op table: an op left out is not "the one in use".
    const names = new Set<string>(mine.tools.keys());
    for (const extension of base.extensions) {
      if (extension === mine) continue;
      for (const name of extension.tools.keys()) {
        if (!names.has(name) || reported.has(name)) continue;
        reported.add(name);
        report({
          extensionPath: PLATFORM_SOURCE,
          event: "tool_name_collision",
          error: `another extension registered ${name}, a name pap uses for a platform tool; pap's tool is the one in use.`,
        });
      }
    }
    return { ...base, extensions: [mine, ...base.extensions.filter((extension) => extension !== mine)] };
  };
}

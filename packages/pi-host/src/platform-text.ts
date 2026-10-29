import {
  PLATFORM_OPS,
  type PLATFORM_RESULTS,
  type PlatformError,
  type PlatformOp,
  VaultName,
} from "@pap/contracts/pi-host";
import type { z } from "zod";

/**
 * M11R12: the only words a platform tool shows the model. Every sentence is fixed English written here: nothing the
 * daemon or the owner wrote reaches a refusal (a refusal is a code, and the code picks the sentence). Placeholders are
 * `{tool}` (a name from the op table), and for `secret_request` a validated `{ref}` and `{name}`. Two texts come from
 * outside this file: a subagent's answer (stage 07 fences it when the child was tainted) and that ref.
 */
export const REFUSAL_TEMPLATES: Readonly<Record<PlatformError, string>> = {
  forbidden: "pap refused {tool}: this kind of session may not use it.",
  tainted: "pap refused {tool}: this session read external content and the owner did not allow it.",
  bad_request: "pap refused {tool}: the request was not valid.",
  not_found: "pap refused {tool}: the target does not exist.",
  refused: "pap refused {tool}: the owner's settings do not allow it.",
  limit_reached: "pap refused {tool}: a limit is reached; try again later.",
  rate_limited: "pap refused {tool}: too many calls; wait and try again.",
  paused: "pap refused {tool}: the agent is paused.",
  budget: "pap refused {tool}: the budget is used up.",
  sandbox_unavailable: "pap refused {tool}: the sandbox is not available.",
  timeout: "pap gave up on {tool}: no answer in time; it may have run.",
  cancelled: "{tool} was cancelled.",
  unavailable: "pap could not run {tool}: the platform is not available.",
  internal: "pap could not run {tool}: an internal error.",
};

export const SUCCESS_TEMPLATES: Readonly<Record<string, string>> = {
  "agent.notify": "The owner was notified.",
  "agent.approve:approved": "The owner approved.",
  "agent.approve:denied": "The owner denied.",
  "agent.delegate": "The task was delegated; its result comes back as a card in this thread.",
  "agent.remind": "The reminder is set.",
  "lane.note": "The note is saved.",
  "network.request:granted": "The owner allowed that host for this thread.",
  "network.request:denied": "The owner did not allow that host.",
  // M11R106: what the agent reads of an answered secret request.
  "secret.request:vault":
    "The owner provided {name} (ref {ref}). It is in your shell's environment as ${name} for every command. Never print it; outputs show it as [SECRET:{name}].",
  "secret.request:once":
    "The owner provided {name} (ref {ref}). It is in your shell's environment as ${name} for your next command that uses ${name}. Never print it; outputs show it as [SECRET:{name}].",
  "preview.start:running":
    "The preview {name} runs on port {port}. The owner opens it from the chat; you never get its address. Links inside it must be relative.",
  "preview.start:failed:port_timeout":
    "pap started {name}, but nothing listened on port {port} within 30 s. Run the command in your shell to see its output.",
  "preview.start:failed:port_not_owned":
    "Another program in your VM already listens on port {port}. Pick another port.",
  "preview.start:failed:exited":
    "The command of {name} ended before it listened. Run it in your shell to see why.",
  "preview.start:failed:spawn_failed": "The command of {name} could not start.",
  "preview.stop:stopped": "The preview is stopped.",
  "preview.stop:none": "No preview of that name runs.",
};

/** M11R103: the one refusal with a sentence of its own, because the generic one does not tell the agent why. */
export const SECRET_SANDBOX_REFUSAL =
  "pap refused secret_request: secrets go only to a sandboxed shell, and this agent's sandbox is off or unavailable.";

const fill = (template: string, values: Readonly<Record<string, string>>): string =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "");

/** A `tainted` refusal of a worker that started with trusted autonomy can only mean the owner turned it off since (W5-R26). */
export const AUTONOMY_OFF = "pap refused {tool}: trusted autonomy was turned off for this agent.";

export const refusalText = (op: PlatformOp, code: PlatformError, autonomyWas = false): string =>
  op === "secret.request" && code === "sandbox_unavailable"
    ? SECRET_SANDBOX_REFUSAL
    : fill(code === "tainted" && autonomyWas ? AUTONOMY_OFF : REFUSAL_TEMPLATES[code], {
        tool: PLATFORM_OPS[op].tool,
      });

const REF = /^secret-ref:[0-9a-f]{32}$/;

/** The sentence for a result that already passed `PLATFORM_RESULTS[op]`; null when a value does not have its fixed format. */
export function successText(op: Exclude<PlatformOp, "subagent.run">, result: unknown): string | null {
  const value = result as Record<string, unknown>;
  switch (op) {
    case "agent.approve":
      return SUCCESS_TEMPLATES[`agent.approve:${value.approved === true ? "approved" : "denied"}`] ?? null;
    case "network.request":
      return SUCCESS_TEMPLATES[`network.request:${value.granted === true ? "granted" : "denied"}`] ?? null;
    case "secret.request": {
      const name = VaultName.safeParse(value.name);
      if (!name.success || typeof value.ref !== "string" || !REF.test(value.ref)) return null;
      const template = SUCCESS_TEMPLATES[`secret.request:${value.mode === "vault" ? "vault" : "once"}`];
      return template === undefined ? null : fill(template, { name: name.data, ref: value.ref });
    }
    case "preview.start": {
      const key = value.status === "running" ? "running" : `failed:${String(value.reason)}`;
      const template = SUCCESS_TEMPLATES[`preview.start:${key}`];
      return template === undefined
        ? null
        : fill(template, { name: String(value.name), port: String(value.port) });
    }
    case "preview.stop":
      return SUCCESS_TEMPLATES[`preview.stop:${value.stopped === true ? "stopped" : "none"}`] ?? null;
    default:
      return SUCCESS_TEMPLATES[op] ?? null;
  }
}

export const CUT_NOTE = "[pap: the answer was cut at 50 KiB.]";
export const EMPTY_NOTE = "[pap: the subagent returned no text.]";

/** The child's own words (the one text from outside pi-host), plus a fixed note when it was cut or empty. */
export function subagentText(result: z.infer<(typeof PLATFORM_RESULTS)["subagent.run"]>): string {
  if (result.answer === "") return EMPTY_NOTE;
  return result.clipped ? `${result.answer}\n\n${CUT_NOTE}` : result.answer;
}

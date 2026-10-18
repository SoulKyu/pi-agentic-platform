import { getLocale, translate, type Locale, type MessageKey } from "./index.ts";

// Literal codes on purpose: `SERVER_CODES` of the contract would pull its object into the initial bundle. A test checks every
// code of the contract has a sentence here.
const MAX = 500;

interface Sentence {
  readonly code: string;
  readonly key: MessageKey;
  /** The English sentence of an older daemon that sent no code; its capture groups fill `vars`. */
  readonly re: RegExp;
  readonly vars?: readonly string[];
}

const SENTENCES: readonly Sentence[] = [
  {
    code: "message_too_large",
    key: "server.notice.messageTooLarge",
    re: /^A message was too large to stream\.$/,
  },
  {
    code: "dialog_too_large",
    key: "server.notice.dialogTooLarge",
    re: /^An extension asked a question that was too large to show\. It was cancelled\.$/,
  },
  {
    code: "dialog_limit",
    key: "server.notice.dialogLimit",
    re: /^An extension asked a question while too many were waiting\. It was cancelled\.$/,
  },
  {
    code: "approval_unshown",
    key: "server.notice.approvalUnshown",
    re: /^A question about a tool call could not be shown\. The call was blocked\.$/,
  },
  { code: "extension_failed", key: "server.notice.extensionFailed", re: /^An extension failed\.$/ },
  {
    code: "extension_failed_during",
    key: "server.notice.extensionFailedDuring",
    re: /^An extension failed during ([\w:.-]{1,64})\.$/,
    vars: ["event"],
  },
  {
    code: "panels_limit",
    key: "server.notice.panelsLimit",
    re: /^An extension opened too many panels\. The extra one was cancelled\.$/,
  },
  {
    code: "notices_held_one",
    key: "server.notice.heldOne",
    re: /^1 more notice from extensions was not shown\.$/,
  },
  {
    code: "notices_held_many",
    key: "server.notice.heldMany",
    re: /^(\d{1,5}) more notices from extensions were not shown\.$/,
    vars: ["count"],
  },
  {
    code: "rules_full",
    key: "server.notice.rulesFull",
    re: /^This project already has (\d{1,5}) always-allowed calls: this one is allowed until this project's rules change\.$/,
    vars: ["max"],
  },
  {
    code: "rules_not_saved",
    key: "server.notice.rulesNotSaved",
    re: /^This call is allowed until this project's rules change: its always rule could not be saved\.$/,
  },
  {
    code: "view_not_refreshed",
    key: "server.notice.viewNotRefreshed",
    re: /^The view could not be refreshed\. Reload the page\.$/,
  },
  { code: "process_stopped", key: "server.cause.stopped", re: /^Agent process stopped\.$/ },
  {
    code: "process_exit_code",
    key: "server.cause.exitCode",
    re: /^Agent process exited with code (-?\d{1,5}|unknown)\.$/,
    vars: ["code"],
  },
  {
    code: "process_signal",
    key: "server.cause.signal",
    re: /^Agent process stopped by (SIG[A-Z0-9]{1,12})\.$/,
    vars: ["signal"],
  },
  {
    code: "process_signal_unknown",
    key: "server.cause.signalUnknown",
    re: /^Agent process stopped by a signal\.$/,
  },
  {
    code: "process_killed",
    key: "server.cause.killed",
    re: /^Agent process killed \(SIGKILL\), possibly out of memory\.$/,
  },
  {
    code: "process_oom",
    key: "server.cause.oom",
    re: /^Agent process ran out of memory and was stopped\.$/,
  },
  {
    code: "process_spawn_failure",
    key: "server.cause.spawnFailure",
    re: /^Agent process could not start\.$/,
  },
  {
    code: "agent_model_refused",
    key: "server.notice.agentModelRefused",
    re: /^This agent's model (.{1,400}) is not offered to its worker: it runs on (.{1,400}) instead\. Settings › Models › Available models decides what is offered\.$/,
    vars: ["model", "running"],
  },
  {
    code: "agent_model_refused_default",
    key: "server.notice.agentModelRefusedDefault",
    re: /^This agent's model (.{1,400}) is not offered to its worker: it runs on Pi's default model instead\. Settings › Models › Available models decides what is offered\.$/,
    vars: ["model"],
  },
  {
    code: "agent_model_refused_chat",
    key: "server.notice.agentModelRefusedChat",
    re: /^This agent uses Chat only, which loads no extension: its model (.{1,400}) is not offered there, so it runs on another model\. Choose a model Pi has, or another tool preset\.$/,
    vars: ["model"],
  },
  {
    code: "agent_model_not_applied",
    key: "server.notice.agentModelNotApplied",
    re: /^This agent's model (.{1,400}) could not be applied when its worker started, so it runs on another model\. Settings › Models shows the provider's state\.$/,
    vars: ["model"],
  },
];

const clipped = (text: string): string => (text.length > MAX ? `${text.slice(0, MAX)}…` : text);

/** The fallback for an older daemon that sends no code: the English sentence is matched, a text it does not know is shown as sent. */
export function serverText(text: string, locale: Locale = getLocale()): string {
  for (const { re, key, vars = [] } of SENTENCES) {
    const match = re.exec(text);
    if (match)
      return translate(locale, key, Object.fromEntries(vars.map((name, i) => [name, match[i + 1] ?? ""])));
  }
  return clipped(text);
}

/**
 * pap's own notice or cause, in the session's language: by its code when it has one (a code this build does not know
 * shows the English text as sent), by the English sentence when it has none.
 */
export function codedServerText(
  server: {
    readonly text: string;
    readonly code?: string;
    readonly params?: Readonly<Record<string, string>>;
  },
  locale: Locale = getLocale(),
): string {
  if (server.code === undefined) return serverText(server.text, locale);
  const sentence = SENTENCES.find(({ code }) => code === server.code);
  // A slot with no value (version skew) would show as a raw `{event}`: the English text as sent is better.
  if (!sentence || (sentence.vars ?? []).some((name) => server.params?.[name] === undefined))
    return clipped(server.text);
  return translate(locale, sentence.key, { ...server.params });
}

/** The codes this table translates, for the test that pins it to the contract's list. */
export const translatedServerCodes = (): string[] => SENTENCES.map(({ code }) => code);

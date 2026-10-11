import { getLocale, translate, type Locale, type MessageKey } from "./index.ts";

// The daemon's notice and cause sentences are English today (M1 contracts carry text, not codes). Known sentences
// map to a key; anything else is shown as sent, clipped. Post-merge task P4 moves the contract to codes.
const MAX = 500;
const PATTERNS: ReadonlyArray<{
  readonly re: RegExp;
  readonly key: MessageKey;
  readonly vars?: readonly string[];
}> = [
  { re: /^A message was too large to stream\.$/, key: "server.notice.messageTooLarge" },
  {
    re: /^An extension asked a question that was too large to show\. It was cancelled\.$/,
    key: "server.notice.dialogTooLarge",
  },
  {
    re: /^An extension asked a question while too many were waiting\. It was cancelled\.$/,
    key: "server.notice.dialogLimit",
  },
  { re: /^An extension failed\.$/, key: "server.notice.extensionFailed" },
  {
    re: /^An extension failed during ([\w:.-]{1,64})\.$/,
    key: "server.notice.extensionFailedDuring",
    vars: ["event"],
  },
  { re: /^Agent process stopped\.$/, key: "server.cause.stopped" },
  {
    re: /^Agent process exited with code (-?\d{1,5}|unknown)\.$/,
    key: "server.cause.exitCode",
    vars: ["code"],
  },
  { re: /^Agent process stopped by (SIG[A-Z0-9]{1,12})\.$/, key: "server.cause.signal", vars: ["signal"] },
  { re: /^Agent process stopped by a signal\.$/, key: "server.cause.signalUnknown" },
  { re: /^Agent process killed \(SIGKILL\), possibly out of memory\.$/, key: "server.cause.killed" },
  { re: /^Agent process could not start\.$/, key: "server.cause.spawnFailure" },
];

export function serverText(text: string, locale: Locale = getLocale()): string {
  for (const { re, key, vars = [] } of PATTERNS) {
    const match = re.exec(text);
    if (match)
      return translate(locale, key, Object.fromEntries(vars.map((name, i) => [name, match[i + 1] ?? ""])));
  }
  return text.length > MAX ? `${text.slice(0, MAX)}…` : text;
}

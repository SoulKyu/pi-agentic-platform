/** An extension that writes the reason of every `session_shutdown` it is told of (R106) to `path`, one line each. */
export const shutdownProbe = (path: string): string =>
  `import { appendFileSync } from "node:fs";\nexport default function (pi) { pi.on("session_shutdown", (event) => appendFileSync(${JSON.stringify(path)}, event.reason + "\\n")); }\n`;

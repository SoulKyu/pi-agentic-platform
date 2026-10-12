/** An extension that writes the reason of every `session_shutdown` it is told of (R106) to `path`, one line each. */
export const shutdownProbe = (path: string): string =>
  `import { appendFileSync } from "node:fs";\nexport default function (pi) { pi.on("session_shutdown", (event) => appendFileSync(${JSON.stringify(path)}, event.reason + "\\n")); }\n`;

/** Like `shutdownProbe`, but its `session_shutdown` handler takes `ms` longer: the worker is closing for at least that long. */
export const slowShutdownProbe = (path: string, ms: number): string =>
  `import { appendFileSync } from "node:fs";\nexport default function (pi) { pi.on("session_shutdown", async (event) => { await new Promise((resolve) => setTimeout(resolve, ${ms})); appendFileSync(${JSON.stringify(path)}, event.reason + "\\n"); }); }\n`;

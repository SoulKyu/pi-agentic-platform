import { Worker } from "node:worker_threads";
import { parseThreadExecArgv } from "./mirror-parse.ts";

export type DigestRunner = (dir: string, format: string) => Promise<string>;

/** The thread file next to this module: TypeScript in the sources, JavaScript in the build. */
export const digestThreadEntry = (moduleUrl: string): URL =>
  new URL(moduleUrl.endsWith(".ts") ? "./digest-thread.ts" : "./digest-thread.js", moduleUrl);

/** One worker thread per digest. A thread that throws, dies or answers nothing usable rejects, never hangs. */
export const threadDigestRunner: DigestRunner = (dir, format) =>
  new Promise<string>((resolve, reject) => {
    let done = false;
    const finish = (settle: () => void): void => {
      if (done) return;
      done = true;
      settle();
    };
    const thread = new Worker(digestThreadEntry(import.meta.url), {
      workerData: { dir, format },
      execArgv: parseThreadExecArgv(import.meta.url),
    });
    thread.on("message", (message: unknown) =>
      finish(() =>
        typeof message === "string"
          ? resolve(message)
          : reject(new Error("the digest thread answered nothing usable")),
      ),
    );
    thread.on("error", (error) => finish(() => reject(error)));
    thread.on("exit", (code) =>
      finish(() => reject(new Error(`the digest thread ended without an answer (exit ${code})`))),
    );
  });

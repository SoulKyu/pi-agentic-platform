import { Worker } from "node:worker_threads";
import { parseThreadExecArgv } from "./mirror-parse.ts";
import type { ProfileJob, ProfileOutcome } from "./profile-job.ts";

export type ProfileRunner = (job: ProfileJob) => Promise<ProfileOutcome>;

/** The thread file next to this module: TypeScript in the sources, JavaScript in the build. */
export const profileThreadEntry = (moduleUrl: string): URL =>
  new URL(moduleUrl.endsWith(".ts") ? "./profile-thread.ts" : "./profile-thread.js", moduleUrl);

/** What came back from the thread is data from a thread, checked like data: anything but an outcome is a failure. */
export function outcomeOf(message: unknown): ProfileOutcome {
  const kind = (message as { kind?: unknown } | null)?.kind;
  return kind === "unchanged" || kind === "made" || kind === "secret" || kind === "failed"
    ? (message as ProfileOutcome)
    : { kind: "failed", message: "the profile thread answered nothing usable" };
}

/** One worker thread per preparation. A thread that dies or answers nothing usable is a failed preparation, never a hang. */
export const threadProfileRunner: ProfileRunner = (job) =>
  new Promise<ProfileOutcome>((resolve) => {
    let done = false;
    const finish = (outcome: ProfileOutcome): void => {
      if (done) return;
      done = true;
      resolve(outcome);
    };
    const thread = new Worker(profileThreadEntry(import.meta.url), {
      workerData: job,
      execArgv: parseThreadExecArgv(import.meta.url),
    });
    thread.on("message", (message: unknown) => finish(outcomeOf(message)));
    thread.on("error", (error) => finish({ kind: "failed", message: error.message }));
    thread.on("exit", () => finish({ kind: "failed", message: "the profile thread ended without an answer" }));
  });

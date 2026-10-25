import { type LoginEvent, PapError } from "@pap/contracts";
import { createFakeClock } from "../../../kernel/clock.ts";
import type { HelperHandle, HelperPool, HelperRunOptions } from "../../../kernel/helper/pool.ts";
import { captureLogger } from "../../../testing/capture-logger.ts";

export interface Fake {
  readonly op: string;
  readonly params: unknown;
  readonly options: HelperRunOptions;
  readonly answers: Array<[string, string | null]>;
  cancelled: number;
  open: Set<string>;
  finish(result?: unknown): void;
  fail(error: unknown): void;
}

export function bed<Deps, Flows>(create: (deps: Deps) => Flows) {
  const clock = createFakeClock();
  const { logger, lines } = captureLogger();
  const fakes: Fake[] = [];
  const events: Array<{ flowId: string; event: LoginEvent }> = [];
  const forgotten: string[] = [];
  const signedIn: unknown[] = [];
  let poolFull = false;
  const helpers: Pick<HelperPool, "run"> = {
    run(op, params, options): HelperHandle {
      if (poolFull) throw new PapError("pi_busy");
      let resolve: (value: unknown) => void = () => {};
      let reject: (error: unknown) => void = () => {};
      const done = new Promise<unknown>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      done.catch(() => {});
      const fake: Fake = {
        op,
        params,
        options,
        answers: [],
        cancelled: 0,
        open: new Set(),
        finish: (result = { ok: true }) => resolve(result),
        fail: (error) => reject(error),
      };
      fakes.push(fake);
      return {
        done,
        answer: (promptId, value) => {
          if (!fake.open.has(promptId)) return false;
          fake.open.delete(promptId);
          fake.answers.push([promptId, value]);
          return true;
        },
        cancel: () => void (fake.cancelled += 1),
      };
    },
  };
  let next = 0;
  const flows = create({
    helpers,
    clock,
    logger,
    publisher: {
      publish: (flowId: string, event: LoginEvent) => void events.push({ flowId, event }),
      forget: (flowId: string) => void forgotten.push(flowId),
    },
    newId: () => `flow${++next}`,
    onSignedIn: (line: unknown) => void signedIn.push(line),
  } as Deps);
  const emit = (fake: Fake, event: unknown) => fake.options.onEvent?.(event);
  const ask = (fake: Fake, promptId: string, prompt: unknown) => {
    fake.open.add(promptId);
    fake.options.onPrompt?.(promptId, prompt);
  };
  const doneOf = (flowId: string) => events.filter((e) => e.flowId === flowId && e.event.kind === "done");
  return {
    clock,
    flows,
    fakes,
    events,
    forgotten,
    signedIn,
    lines,
    emit,
    ask,
    doneOf,
    setPoolFull: (full: boolean) => void (poolFull = full),
  };
}
export const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoxOp, BoxOpError } from "@pap/contracts";
import { BUNDLE_BIN } from "./github-env.ts";
import { stopSigningAgent } from "./github-agent.ts";
import { createGuestOps, type GuestOps } from "./index.ts";

export interface OpsBed {
  /** The project folder, real and empty. */
  readonly project: string;
  /** The folder holding the project (a place for links to point at, outside it). */
  readonly outside: string;
  /** The folder holding the project, the home and the box's guest-only `.pap`. */
  readonly base: string;
  /** The box's home and the stand-in for `/run`, both beside the project. */
  readonly home: string;
  readonly run: string;
  call(op: BoxOp): ReturnType<GuestOps>;
  /** The value of a successful operation. */
  value(op: BoxOp): Promise<unknown>;
  /** The code of a refused operation. */
  refusal(op: BoxOp): Promise<BoxOpError>;
  clean(): void;
}

export function opsBed(now: () => number = () => Date.now(), guestEnv: NodeJS.ProcessEnv = {}): OpsBed {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pap-guest-ops-")));
  const project = join(base, "project");
  const outside = join(base, "outside");
  mkdirSync(project);
  const home = join(base, "home");
  const run = join(base, "run");
  mkdirSync(outside);
  mkdirSync(home);
  const env = { PATH: process.env.PATH, ...guestEnv };
  const deps = { home, runDir: run, binDir: BUNDLE_BIN, env };
  const ops = createGuestOps(project, now, deps);
  return {
    base,
    project,
    outside,
    home,
    run,
    call: ops,
    async value(op) {
      const answer = await ops(op);
      if (!answer.ok) throw new Error(`${op.name} was refused: ${answer.code}`);
      return answer.value;
    },
    async refusal(op) {
      const answer = await ops(op);
      if (answer.ok) throw new Error(`${op.name} was answered`);
      return answer.code;
    },
    clean: () => {
      stopSigningAgent(deps);
      rmSync(base, { recursive: true, force: true });
    },
  };
}

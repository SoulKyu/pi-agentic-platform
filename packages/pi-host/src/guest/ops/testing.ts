import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoxOp, BoxOpError } from "@pap/contracts";
import { createGuestOps, type GuestOps } from "./index.ts";

export interface OpsBed {
  /** The project folder, real and empty. */
  readonly project: string;
  /** The folder holding the project (a place for links to point at, outside it). */
  readonly outside: string;
  call(op: BoxOp): ReturnType<GuestOps>;
  /** The value of a successful operation. */
  value(op: BoxOp): Promise<unknown>;
  /** The code of a refused operation. */
  refusal(op: BoxOp): Promise<BoxOpError>;
  clean(): void;
}

export function opsBed(now: () => number = () => Date.now()): OpsBed {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pap-guest-ops-")));
  const project = join(base, "project");
  const outside = join(base, "outside");
  mkdirSync(project);
  mkdirSync(outside);
  const ops = createGuestOps(project, now);
  return {
    project,
    outside,
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
    clean: () => rmSync(base, { recursive: true, force: true }),
  };
}

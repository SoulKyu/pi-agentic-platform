import type { SessionsScanPort } from "../../sessions/index.ts";

type Claim = ReturnType<SessionsScanPort["claim"]>;
type PiFileHeader = Parameters<SessionsScanPort["claim"]>[1];

export interface FakeScanPort {
  readonly port: Pick<SessionsScanPort, "claim" | "touched" | "named" | "previewed">;
  readonly claims: Array<{ path: string; header: PiFileHeader }>;
  readonly touched: Array<{ sessionId: string; at: number; active: boolean }>;
  readonly named: Array<{ sessionId: string; raw: string | null }>;
  readonly previewed: Array<{ sessionId: string; text: string }>;
  /** Answers the next `claim` calls in order; afterwards the default session. */
  answer(...next: Claim[]): void;
}

const DEFAULT_CLAIM: Claim = { kind: "session", sessionId: "s1", ownerId: "u1" };

export function fakeScanPort(): FakeScanPort {
  const queue: Claim[] = [];
  const claims: FakeScanPort["claims"] = [];
  const touched: FakeScanPort["touched"] = [];
  const named: FakeScanPort["named"] = [];
  const previewed: FakeScanPort["previewed"] = [];
  return {
    claims,
    touched,
    named,
    previewed,
    answer: (...next) => {
      queue.push(...next);
    },
    port: {
      claim: (path, header) => {
        claims.push({ path, header });
        return queue.shift() ?? DEFAULT_CLAIM;
      },
      touched: (sessionId, at, active) => {
        touched.push({ sessionId, at, active });
      },
      named: (sessionId, raw) => {
        named.push({ sessionId, raw });
      },
      previewed: (sessionId, text) => {
        previewed.push({ sessionId, text });
      },
    },
  };
}

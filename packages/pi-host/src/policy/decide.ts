import type { ApprovalAnswer, ApprovalMode, ToolCategory } from "@pap/contracts/pi-host";
import type { EditReview } from "./target-path.ts";

export type Decision = "allow" | "ask" | "block";
const MATRIX: Readonly<Record<ApprovalMode, Readonly<Record<ToolCategory, Decision>>>> = {
  "read-only": {
    read: "allow",
    edit: "block",
    exec: "block",
    network: "block",
    "external-write": "block",
    unknown: "block",
  },
  supervised: {
    read: "allow",
    edit: "ask",
    exec: "ask",
    network: "ask",
    "external-write": "ask",
    unknown: "ask",
  },
  "auto-accept-edits": {
    read: "allow",
    edit: "allow",
    exec: "ask",
    network: "ask",
    "external-write": "ask",
    unknown: "ask",
  },
  "full-access": {
    read: "allow",
    edit: "allow",
    exec: "allow",
    network: "allow",
    "external-write": "allow",
    unknown: "allow",
  },
};
/** What can carry data out of the machine: after untrusted content it always asks (spec C §5.3). */
export const EXFILTRATION_CAPABLE: ReadonlySet<ToolCategory> = new Set([
  "exec",
  "network",
  "external-write",
  "unknown",
]);
const ONE_CALL: readonly ApprovalAnswer[] = ["deny", "once"];

export interface DecideInput {
  readonly mode: ApprovalMode;
  readonly category: ToolCategory;
  readonly tainted: boolean;
  /** A write outside the session folder or to a protected path (R14, R14b). */
  readonly review?: EditReview | undefined;
  /** Why a read touches pap's sensitive files (M5R29). */
  readonly protectedRead?: string | undefined;
  /** The tool reaches outside the machine (`ToolKind.external`, M5R24, M5R116). */
  readonly external: boolean;
}
export interface Verdict {
  readonly decision: Decision;
  /** Session and always grants may skip this question. */
  readonly grantable: boolean;
  readonly why: string;
  readonly answers: readonly ApprovalAnswer[];
}

/** Stage 03's table (spec C §5.3) and its overrides. A mode the table does not know throws: the pipeline blocks. */
export function decide(input: DecideInput): Verdict {
  const once = (decision: Decision, why: string): Verdict => ({
    decision,
    grantable: false,
    why,
    answers: decision === "ask" ? ONE_CALL : [],
  });
  if (!Object.hasOwn(MATRIX, input.mode)) throw new TypeError("the approval mode is not in the matrix");
  const row = MATRIX[input.mode];
  // M5R27: after untrusted content, whatever can carry data out asks — an external read included (MQ1).
  const exposed = input.tainted && (EXFILTRATION_CAPABLE.has(input.category) || input.external);
  if (input.mode === "read-only") {
    if (input.category === "read" && input.protectedRead === undefined && !exposed)
      return { decision: "allow", grantable: false, why: "read allowed", answers: [] };
    return once(
      "block",
      input.protectedRead ??
        input.review?.why ??
        (exposed
          ? "external content in a read-only session"
          : `${input.category} blocked in a read-only session`),
    );
  }
  if (input.review) return once("ask", input.review.why);
  if (input.protectedRead !== undefined) return once("ask", input.protectedRead);
  if (exposed) return once("ask", "external content");
  if (!Object.hasOwn(row, input.category)) throw new TypeError("the tool category is not in the matrix");
  const decision = row[input.category];
  if (decision === "ask")
    return {
      decision,
      grantable: true,
      why: `${input.category} asks`,
      answers:
        input.category === "unknown" ? ["deny", "session", "once"] : ["deny", "session", "always", "once"],
    };
  return {
    decision,
    grantable: false,
    why: `${input.category} ${decision === "allow" ? "allowed" : "blocked"}`,
    answers: [],
  };
}

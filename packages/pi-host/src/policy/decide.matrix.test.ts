import type { ApprovalMode } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { decide, EXFILTRATION_CAPABLE } from "./decide.ts";

const CATEGORIES = ["read", "edit", "exec", "network", "external-write", "unknown"] as const;
const TABLE: Record<ApprovalMode, readonly ("allow" | "ask" | "block")[]> = {
  "read-only": ["allow", "block", "block", "block", "block", "block"],
  supervised: ["allow", "ask", "ask", "ask", "ask", "ask"],
  "auto-accept-edits": ["allow", "allow", "ask", "ask", "ask", "ask"],
  "full-access": ["allow", "allow", "allow", "allow", "allow", "allow"],
};
const MODES = ["supervised", "auto-accept-edits", "full-access"] as const;
const review = { why: "protected path" as const, target: "/p/.git/hooks/x" };

describe("decide: the matrix", () => {
  it.each(
    Object.entries(TABLE).flatMap(([mode, row]) =>
      CATEGORIES.map((category, i) => [mode, category, row[i]] as const),
    ),
  )("%s × %s → %s, untainted", (mode, category, decision) => {
    const verdict = decide({ mode: mode as ApprovalMode, category, tainted: false, external: false });
    expect(verdict.decision).toBe(decision);
    expect(verdict.grantable).toBe(decision === "ask");
    expect(verdict.answers).toEqual(
      decision !== "ask"
        ? []
        : category === "unknown"
          ? ["deny", "session", "once"]
          : ["deny", "session", "always", "once"],
    );
  });

  it("an untainted external call is judged by its category alone, in every mode", () => {
    for (const mode of Object.keys(TABLE) as ApprovalMode[])
      for (const [i, category] of CATEGORIES.entries())
        expect(decide({ mode, category, tainted: false, external: true }).decision).toBe(TABLE[mode][i]);
  });

  it("names the exfiltration-capable categories", () => {
    expect([...EXFILTRATION_CAPABLE].sort()).toEqual(["exec", "external-write", "network", "unknown"]);
  });
});

describe("decide: taint", () => {
  it.each(MODES)(
    "%s: a tainted session asks for every exfiltration-capable or external call, not grantable",
    (mode) => {
      const ask = { decision: "ask", grantable: false, why: "external content", answers: ["deny", "once"] };
      for (const category of ["exec", "network", "external-write", "unknown"] as const)
        expect(decide({ mode, category, tainted: true, external: false })).toEqual(ask);
      // An MCP `readOnlyHint` tool or `read_mcp_resource`: a read that reaches the open world (M5R27, MQ1).
      expect(decide({ mode, category: "read", tainted: true, external: true })).toEqual(ask);
      expect(decide({ mode, category: "read", tainted: false, external: true }).decision).toBe("allow");
      expect(decide({ mode, category: "read", tainted: true, external: false }).decision).toBe("allow");
      expect(decide({ mode, category: "edit", tainted: true, external: false }).decision).toBe(
        mode === "supervised" ? "ask" : "allow",
      );
    },
  );

  it("a tainted edit in supervised mode stays grantable: taint does not touch an edit", () => {
    expect(decide({ mode: "supervised", category: "edit", tainted: true, external: false })).toMatchObject({
      decision: "ask",
      grantable: true,
    });
  });
});

describe("decide: read-only, review and protected reads", () => {
  it("blocks in read-only whatever else holds, a tainted external read included", () => {
    const base = { mode: "read-only", tainted: false, external: false } as const;
    expect(decide({ ...base, category: "edit", review }).decision).toBe("block");
    expect(decide({ ...base, category: "read", protectedRead: "protected path" }).decision).toBe("block");
    expect(decide({ ...base, category: "read", tainted: true, external: true }).decision).toBe("block");
    expect(decide({ ...base, category: "read", external: true }).decision).toBe("allow");
    expect(decide({ ...base, category: "read", tainted: true }).decision).toBe("allow");
  });

  it.each(MODES)("%s asks, Deny / Allow once, for a review write and a protected read", (mode) => {
    expect(decide({ mode, category: "edit", tainted: false, external: false, review })).toEqual({
      decision: "ask",
      grantable: false,
      why: "protected path",
      answers: ["deny", "once"],
    });
    expect(
      decide({ mode, category: "read", tainted: false, external: false, protectedRead: "protected path" }),
    ).toMatchObject({ decision: "ask", grantable: false, answers: ["deny", "once"] });
  });

  it("fails closed on a mode it does not know", () => {
    const yolo = "yolo" as unknown as ApprovalMode;
    expect(() => decide({ mode: yolo, category: "read", tainted: false, external: false })).toThrow(
      TypeError,
    );
  });

  it.each(["toString", "constructor", "__proto__", "hasOwnProperty"])(
    "fails closed on the prototype key %s as a mode and as a category",
    (key) => {
      const mode = key as unknown as ApprovalMode;
      expect(() => decide({ mode, category: "read", tainted: false, external: false })).toThrow(TypeError);
      const category = key as unknown as "read";
      expect(() => decide({ mode: "full-access", category, tainted: false, external: false })).toThrow(
        TypeError,
      );
    },
  );

  it("fails closed on a prototype-key mode whatever else is present: review, protected read, taint, read-only look-alike", () => {
    const mode = "toString" as unknown as ApprovalMode;
    expect(() => decide({ mode, category: "edit", tainted: false, external: false, review })).toThrow(
      TypeError,
    );
    expect(() =>
      decide({ mode, category: "read", tainted: false, external: false, protectedRead: "protected path" }),
    ).toThrow(TypeError);
    expect(() => decide({ mode, category: "exec", tainted: true, external: false })).toThrow(TypeError);
    expect(() => decide({ mode, category: "read", tainted: true, external: true })).toThrow(TypeError);
  });
});

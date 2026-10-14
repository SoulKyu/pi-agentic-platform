import { mcpMethods } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { registerCatalog, setLocale, translate } from "../../i18n/index.ts";
import { RpcError } from "../../runtime/index.ts";
import type { RpcErrorCode } from "../../runtime/rpc.ts";
import { serverOf } from "./mcp-bed.tsx";
import { settingsMcpEn, settingsMcpFr } from "../../i18n/catalog/settings-mcp.ts";
import { escapeHidden, groupSwitch, mcpFailureText, rowChip } from "./mcp.vm.ts";

registerCatalog({ en: settingsMcpEn, fr: settingsMcpFr });

describe("group switch", () => {
  it("is on only while every row is on; a partial group reads off with n/m", () => {
    expect(groupSwitch([serverOf(), serverOf({ name: "b" })])).toMatchObject({
      on: true,
      enabled: 2,
      total: 2,
    });
    expect(groupSwitch([serverOf(), serverOf({ name: "b", enabled: false })])).toMatchObject({
      on: false,
      enabled: 1,
      total: 2,
    });
    expect(groupSwitch([])).toMatchObject({ on: false, total: 0 });
  });

  it("leaves an invalid row out of the count and out of the rows it writes", () => {
    const rows = [serverOf(), serverOf({ name: "bad", kind: "invalid", enabled: false, state: "invalid" })];
    const result = groupSwitch(rows);
    expect(result).toMatchObject({ on: true, enabled: 1, total: 1 });
    expect(result.rows.map((row) => row.name)).toEqual(["fs"]);
  });
});

describe("row chip precedence", () => {
  const lastTest = { at: 1, ok: false, state: "needs-sign-in", tools: null } as const;
  it("goes invalid > disabled > not-trusted > replaced > overridden > last Test > on", () => {
    const all = serverOf({ kind: "invalid", enabled: false, state: "invalid", lastTest });
    expect(rowChip(all)).toBe("invalid");
    expect(rowChip({ ...all, kind: "stdio", state: "disabled" })).toBe("disabled");
    expect(rowChip({ ...all, kind: "stdio", enabled: true, state: "not-trusted" })).toBe("not-trusted");
    expect(rowChip({ ...all, kind: "stdio", enabled: true, state: "replaced" })).toBe("replaced");
    expect(rowChip({ ...all, kind: "stdio", enabled: true, state: "overridden" })).toBe("overridden");
    expect(rowChip({ ...all, kind: "stdio", enabled: true, state: "on" })).toBe("needs-sign-in");
    expect(rowChip(serverOf())).toBe("on");
  });

  it("reads a disabled row as disabled whatever the state says", () => {
    expect(rowChip(serverOf({ enabled: false, state: "on" }))).toBe("disabled");
  });
});

describe("escapeHidden (M7R86)", () => {
  it("writes bidi, zero-width and control characters as visible escapes and keeps plain text", () => {
    expect(escapeHidden("ev‮il")).toBe("ev\\u202Eil");
    expect(escapeHidden("a​b c\n")).toBe("a\\u200Bb\\u00A0c\\u000A");
    expect(escapeHidden("plain é 日本")).toBe("plain é 日本");
    expect(escapeHidden("tag\u{E0041}")).toBe("tag\\u{E0041}");
  });
});

describe("failure text", () => {
  const codes = new Set(
    Object.values(mcpMethods).flatMap((method) => [...(method.errors as readonly string[])]),
  );
  it("gives every declared error code a fixed message in both languages, never a raw key", () => {
    expect(codes.size).toBeGreaterThan(10);
    for (const locale of ["en", "fr"] as const) {
      setLocale(locale);
      for (const code of codes)
        for (const action of ["write", "remove", "undo", "add", "test", "codemode", "overview"] as const) {
          const text = mcpFailureText(new RpcError(code as RpcErrorCode), action);
          expect(text, `${locale} ${action} ${code}`).not.toMatch(/^(error|settingsMcp)\./);
        }
    }
    setLocale("en");
  });

  it("does not call a forbidden overview answer an untrusted project", () => {
    expect(mcpFailureText(new RpcError("forbidden"), "overview")).toBe(translate("en", "error.forbidden"));
  });

  it("says what the refusal means for undo and add", () => {
    expect(mcpFailureText(new RpcError("conflict"), "undo")).toBe(
      translate("en", "settingsMcp.err.undoConflict"),
    );
    expect(mcpFailureText(new RpcError("conflict"), "add")).toBe(
      translate("en", "settingsMcp.err.addConflict"),
    );
    expect(mcpFailureText(new RpcError("limit_reached"), "remove")).toBe(
      translate("en", "settingsMcp.err.undoFull"),
    );
    expect(mcpFailureText(new RpcError("forbidden"), "test")).toBe(
      translate("en", "settingsMcp.err.untrusted"),
    );
  });
});

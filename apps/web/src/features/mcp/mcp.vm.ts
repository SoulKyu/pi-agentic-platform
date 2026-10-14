import type { McpRowCode, McpServerView } from "@pap/contracts";
import { errorKey, t } from "../../i18n/index.ts";
import { escapeHidden } from "../../lib/escape-hidden.ts";
import { RpcError } from "../../runtime/index.ts";

export type McpAction = "write" | "remove" | "undo" | "add" | "test" | "codemode" | "overview";

const failureCode = (failure: unknown): string => (failure instanceof RpcError ? failure.code : "internal");

/**
 * What a failed call says: a fixed text per refusal that means something here, else the code's own text. The
 * server's message never reaches the screen (C §4.1). A timeout says the outcome is unknown: the list is read again.
 */
export function mcpFailureText(failure: unknown, action: McpAction): string {
  const code = failureCode(failure);
  switch (code) {
    case "timeout":
    case "connection_lost":
      return t("settingsMcp.err.unknownOutcome");
    case "conflict":
      if (action === "undo") return t("settingsMcp.err.undoConflict");
      if (action === "add") return t("settingsMcp.err.addConflict");
      break;
    case "limit_reached":
      return t("settingsMcp.err.undoFull");
    case "forbidden":
      if (action !== "codemode" && action !== "overview") return t("settingsMcp.err.untrusted");
      break;
  }
  return t(errorKey(code));
}

export function rowFailureText(name: string, code: McpRowCode | undefined): string {
  const label = escapeHidden(name);
  switch (code) {
    case "not_found":
      return t("settingsMcp.row.notFound", { name: label });
    case "invalid_name":
      return t("settingsMcp.row.badName", { name: label });
    case "invalid_entry":
      return t("settingsMcp.row.badEntry", { name: label });
    default:
      return t("settingsMcp.row.failed", { name: label });
  }
}

export { escapeHidden } from "../../lib/escape-hidden.ts";

export type RowChip =
  | "invalid"
  | "disabled"
  | "not-trusted"
  | "replaced"
  | "overridden"
  | "connected"
  | "needs-sign-in"
  | "failed"
  | "timeout"
  | "on";

/** One chip per row, by precedence: invalid > disabled > not trusted > replaced > overridden > last Test > on. */
export function rowChip(server: McpServerView): RowChip {
  if (server.kind === "invalid" || server.state === "invalid") return "invalid";
  if (!server.enabled || server.state === "disabled") return "disabled";
  if (server.state === "not-trusted") return "not-trusted";
  if (server.state === "replaced") return "replaced";
  if (server.state === "overridden") return "overridden";
  return server.lastTest?.state ?? "on";
}

export interface GroupSwitch {
  /** On only while every switchable row is on (M7R98). */
  readonly on: boolean;
  readonly enabled: number;
  readonly total: number;
  /** The rows a group write names: an invalid line cannot be switched. */
  readonly rows: readonly McpServerView[];
}

export function groupSwitch(servers: readonly McpServerView[]): GroupSwitch {
  const rows = servers.filter((server) => server.kind !== "invalid");
  const enabled = rows.filter((server) => server.enabled).length;
  return { on: rows.length > 0 && enabled === rows.length, enabled, total: rows.length, rows };
}

export const serverKey = (server: Pick<McpServerView, "scope" | "name">): string =>
  `${server.scope}/${server.name}`;

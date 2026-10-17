import type { DoctorReport } from "./types.ts";

/** A detail may hold a path or a command output: no control character reaches the terminal. */
export function plain(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    out += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? "?" : char;
  }
  return out;
}

/** `[status] id detail`, then `  fix: ...` under a result that has one. */
export function renderText(report: DoctorReport): string {
  const lines: string[] = [];
  for (const r of report.results) {
    lines.push(`[${r.status}] ${r.id} ${plain(r.detail)}`);
    if (r.fix !== undefined && r.status !== "ok" && r.status !== "skip") lines.push(`  fix: ${plain(r.fix)}`);
  }
  return `${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`;
}

export function renderJson(report: DoctorReport): string {
  return `${JSON.stringify({ exit: report.exit, results: report.results })}\n`;
}

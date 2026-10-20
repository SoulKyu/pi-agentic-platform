import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homeFrom } from "../kernel/config.ts";
import { openDatabase } from "../kernel/db/database.ts";
import { traceFilePaths } from "../kernel/observability/trace-file.ts";
import { CliError } from "./open-home.ts";
import { percentile } from "./percentile.ts";
import type { Command } from "./run-cli.ts";
import { renderApprovals, summarizeApprovals } from "./trace-approvals.ts";
import { UsageError } from "./usage.ts";

const SINCE = /^([1-9]\d{0,3})([mhd])$/;
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
const MIN_WINDOW_MS = 60_000;

export interface SummaryRow {
  readonly name: string;
  readonly count: number;
  readonly ratePerMinute: number;
  readonly p50: number;
  readonly p90: number;
  readonly p99: number;
  readonly max: number;
  readonly failures: number;
}

interface Span {
  readonly name: string;
  readonly start: number;
  readonly durationMs: number;
  readonly ok: boolean;
}

function parseSpan(line: string): Span | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { name, start, durationMs, outcome } = value as Record<string, unknown>;
  if (typeof name !== "string" || typeof outcome !== "string") return null;
  if (typeof start !== "number" || !Number.isFinite(start)) return null;
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) return null;
  return { name, start, durationMs, ok: outcome === "ok" };
}

/**
 * Per span name: count, rate per minute, p50/p90/p99/max and failures. A line that is not a span (a torn write, a
 * foreign shape) is skipped and counted; a span started before `now - sinceMs` is left out and is not "skipped".
 * The rate divides by `sinceMs`, or by the time the spans cover (one minute at least) without it.
 */
export function summarizeTrace(
  files: readonly string[],
  options: { now: number; sinceMs?: number },
): { rows: SummaryRow[]; skipped: number } {
  const byName = new Map<string, Span[]>();
  let skipped = 0;
  let first = Infinity;
  let last = -Infinity;
  const oldest = options.sinceMs === undefined ? -Infinity : options.now - options.sinceMs;
  for (const text of files) {
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      const span = parseSpan(line);
      if (!span) {
        skipped++;
        continue;
      }
      if (span.start < oldest) continue;
      first = Math.min(first, span.start);
      last = Math.max(last, span.start);
      const spans = byName.get(span.name) ?? [];
      spans.push(span);
      byName.set(span.name, spans);
    }
  }
  const windowMs = options.sinceMs ?? Math.max(last - first, MIN_WINDOW_MS);
  const rows = [...byName.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, spans]): SummaryRow => {
      const sorted = spans.map((span) => span.durationMs).sort((a, b) => a - b);
      return {
        name,
        count: spans.length,
        ratePerMinute: spans.length / (windowMs / 60_000),
        p50: percentile(sorted, 50),
        p90: percentile(sorted, 90),
        p99: percentile(sorted, 99),
        max: sorted.at(-1) ?? 0,
        failures: spans.filter((span) => !span.ok).length,
      };
    });
  return { rows, skipped };
}

const HEADER = ["name", "count", "rate/min", "p50", "p90", "p99", "max", "failures"] as const;

const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** A span name comes from a file: a control or invisible character never reaches the terminal. */
const printable = (name: string): string => name.replace(UNPRINTABLE, "?");

function renderTable(rows: readonly SummaryRow[]): string {
  const cells = [
    [...HEADER] as string[],
    ...rows.map((row) => [
      printable(row.name),
      String(row.count),
      row.ratePerMinute.toFixed(1),
      String(row.p50),
      String(row.p90),
      String(row.p99),
      String(row.max),
      String(row.failures),
    ]),
  ];
  const widths = HEADER.map((_, col) => Math.max(...cells.map((row) => (row[col] ?? "").length)));
  return cells
    .map((row) =>
      row
        .map((cell, col) => (col === 0 ? cell.padEnd(widths[col] ?? 0) : cell.padStart(widths[col] ?? 0)))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

function readIfThere(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new CliError(`cannot read ${path}`);
  }
}

/**
 * The approvals block (decision 117, A4): read from the audit of `state.db`, opened read-only, so it works while the
 * daemon runs. Null when there is no database, or one from before the card timing columns.
 */
function approvalsBlock(home: string, now: number, sinceMs: number | undefined): string | null {
  const path = join(home, "state.db");
  if (!existsSync(path)) return null;
  let db;
  try {
    db = openDatabase(path, { readOnly: true });
    return renderApprovals(summarizeApprovals(db, { now, ...(sinceMs === undefined ? {} : { sinceMs }) }));
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/**
 * `pap trace summary [--since <15m|2h|1d>]` (M10R94): reads `logs/trace.jsonl` and `.1` … `.9`, then the approvals of
 * the audit. It takes no instance lock and opens the database read-only, so it works while the daemon runs or is stopped.
 */
export const traceSummary: Command = {
  options: { since: { type: "string" } },
  async run({ values, positionals, io }) {
    if (positionals.length > 0) throw new UsageError("trace summary takes no argument");
    const since = typeof values.since === "string" ? values.since : undefined;
    const match = since === undefined ? null : SINCE.exec(since);
    if (since !== undefined && !match) throw new UsageError("--since must look like 15m, 2h or 1d");
    const sinceMs = match ? Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS] : undefined;
    const home = homeFrom(io.env, io.homedir);
    const files = traceFilePaths(home).flatMap((path) => readIfThere(path) ?? []);
    if (files.length === 0) io.stdout.write("no trace yet\n");
    else {
      const { rows, skipped } = summarizeTrace(files, { now: io.clock.now(), sinceMs });
      if (rows.length === 0) io.stdout.write(`no spans in the last ${since ?? "window"}\n`);
      else io.stdout.write(`${renderTable(rows)}\n`);
      io.stdout.write(`skipped lines: ${skipped}\n`);
    }
    const approvals = approvalsBlock(home, io.clock.now(), sinceMs);
    if (approvals !== null) io.stdout.write(`\n${approvals}\n`);
    return 0;
  },
};

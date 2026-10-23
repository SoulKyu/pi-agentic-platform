import type { HealthEvent, HealthKind, HealthSeverity } from "@pap/contracts";

export interface HealthFilters {
  readonly kind: "all" | HealthKind;
  readonly severities: Readonly<Record<HealthSeverity, boolean>>;
  readonly search: string;
}

export const DEFAULT_FILTERS: HealthFilters = {
  kind: "all",
  severities: { err: true, att: true, mut: true },
  search: "",
};

const KEY = "pap.health.filters";
const KINDS = ["all", "feed", "sched", "task", "outbox", "agent"] as const;
const SEVERITIES = ["err", "att", "mut"] as const;

/** The device-scoped filters, restored from localStorage; anything off falls back to the defaults. */
export function loadFilters(): HealthFilters {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return DEFAULT_FILTERS;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return DEFAULT_FILTERS;
    const { kind, severities, search } = value as Record<string, unknown>;
    if (typeof kind !== "string" || !KINDS.includes(kind as (typeof KINDS)[number])) return DEFAULT_FILTERS;
    if (typeof search !== "string") return DEFAULT_FILTERS;
    if (typeof severities !== "object" || severities === null) return DEFAULT_FILTERS;
    const on = severities as Record<string, unknown>;
    const clean = Object.fromEntries(
      SEVERITIES.map((severity) => [severity, on[severity] === true]),
    ) as Record<HealthSeverity, boolean>;
    return { kind: kind as HealthFilters["kind"], severities: clean, search };
  } catch {
    return DEFAULT_FILTERS;
  }
}

export function saveFilters(filters: HealthFilters): void {
  localStorage.setItem(KEY, JSON.stringify(filters));
}

/** At least one severity always stays on (spec §5): turning the last one off is a no-op. */
export function withSeverity(filters: HealthFilters, severity: HealthSeverity, on: boolean): HealthFilters {
  const others = SEVERITIES.some((s) => s !== severity && filters.severities[s]);
  if (!on && !others) return filters;
  return { ...filters, severities: { ...filters.severities, [severity]: on } };
}

export const keeps = (event: HealthEvent, filters: HealthFilters): boolean =>
  (filters.kind === "all" || event.kind === filters.kind) &&
  filters.severities[event.severity] &&
  (filters.search === "" ||
    event.code.toLowerCase().includes(filters.search.toLowerCase()) ||
    ((event.sourceRef?.kind === "trigger" || event.sourceRef?.kind === "agent") &&
      (event.sourceRef.name ?? "").toLowerCase().includes(filters.search.toLowerCase())));

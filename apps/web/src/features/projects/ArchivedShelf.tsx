import type { ShellSession } from "@pap/contracts";
import { Banner, Button, Collapsible, LoadingLine } from "@pap/ui";
import { useId, useRef, useState } from "react";
import { errorKey, useT } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { RpcError } from "../../runtime/rpc.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { SessionRow } from "./SessionRow.tsx";

/** The most archived rows the shelf holds: five pages; older ones are reached by search (M4R140). */
export const ARCHIVED_ROWS = 500;

/** The daemon's order: `archived_at` then `id`, newest first. */
function newestArchived(a: ShellSession, b: ShellSession): number {
  const byTime = (b.archivedAt ?? 0) - (a.archivedAt ?? 0);
  if (byTime !== 0) return byTime;
  return a.id < b.id ? 1 : -1;
}

interface ArchivedShelfProps {
  /** The archived count the shell stream reports. */
  readonly count: number;
  readonly chord: string | null;
  readonly now: number;
  onPick(id: string): void;
}

/** Archived sessions, fetched page by page on first open and held in this component only. */
export function ArchivedShelf({ count, chord, now, onPick }: ArchivedShelfProps) {
  const t = useT();
  const held = useShellStore((state) => state.view.sessions);
  const [open, setOpen] = useState(false);
  const [asked, setAsked] = useState(false);
  const [rows, setRows] = useState<readonly ShellSession[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [phase, setPhase] = useState<"idle" | "loading" | "failed">("idle");
  const [failure, setFailure] = useState("internal");
  const inFlight = useRef(false);
  const titleId = useId();

  const load = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPhase("loading");
    const last = rows.at(-1);
    const params = last?.archivedAt == null ? {} : { before: { archivedAt: last.archivedAt, id: last.id } };
    try {
      const page = await getRuntime().rpc.call("sessions.listArchived", params);
      setRows((previous) => {
        const known = new Set(previous.map((row) => row.id));
        const fresh = page.sessions.filter((row) => row.archivedAt !== null && !known.has(row.id));
        return [...previous, ...fresh.slice(0, Math.max(0, ARCHIVED_ROWS - previous.length))];
      });
      setHasMore(page.hasMore);
      setPhase("idle");
    } catch (error) {
      setFailure(error instanceof RpcError ? error.code : "internal");
      setPhase("failed");
    }
    inFlight.current = false;
  };

  const toggle = (next: boolean) => {
    setOpen(next);
    if (next && !asked) {
      setAsked(true);
      void load();
    }
  };

  // The store's copy is the newer one: a session it reports as not archived (unarchived here, in another tab or on
  // another device) leaves the shelf, and one archived here joins it, in the order the pages come in.
  const fetched = new Set(rows.map((row) => row.id));
  const shown = [
    ...rows.map((row) => held.get(row.id) ?? row).filter((row) => row.archivedAt !== null),
    ...[...held.values()].filter((row) => row.archivedAt !== null && !fetched.has(row.id)),
  ]
    .toSorted(newestArchived)
    .slice(0, ARCHIVED_ROWS);
  const capped = rows.length >= ARCHIVED_ROWS;
  return (
    <section data-shelf="archived" aria-labelledby={titleId} className="flex flex-col gap-s1">
      <Collapsible
        open={open}
        onOpenChange={toggle}
        trigger={
          <span id={titleId} className="label-hud text-muted">
            {t("sidebar.archived", { count: Math.max(count, shown.length) })}
          </span>
        }
      >
        <ul className="flex flex-col gap-s1">
          {shown.map((session) => (
            <SessionRow key={session.id} session={session} now={now} onPick={onPick} />
          ))}
        </ul>
        {phase === "loading" && rows.length === 0 ? <LoadingLine label={t("sidebar.loading")} /> : null}
        {phase === "failed" ? (
          <Banner
            tone="capacity"
            title={t(errorKey(failure))}
            actions={
              <Button variant="secondary" size="sm" onClick={() => void load()}>
                {t("sidebar.retry")}
              </Button>
            }
          />
        ) : null}
        {phase !== "failed" && hasMore && !capped ? (
          <Button variant="ghost" size="sm" disabled={phase === "loading"} onClick={() => void load()}>
            {t("sidebar.loadMore")}
          </Button>
        ) : null}
        {hasMore && capped ? (
          <p className="text-ui text-muted">
            {chord === null ? t("sidebar.archivedCapNoChord") : t("sidebar.archivedCap", { chord })}
          </p>
        ) : null}
      </Collapsible>
    </section>
  );
}

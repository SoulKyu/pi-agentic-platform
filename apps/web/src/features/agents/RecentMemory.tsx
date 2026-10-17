import { type MemoryItemView, type MemoryJournalView, memoryMethods } from "@pap/contracts";
import { Button, Chip, Segmented } from "@pap/ui";
import { useEffect, useState } from "react";
import { memoryEn, memoryFr } from "../../i18n/catalog/memory.ts";
import { registerCatalog, useT } from "../../i18n/index.ts";
import { reportClientIssue } from "../../lib/report.ts";
import { getRuntime } from "../../runtime/index.ts";
import { lineOf } from "./untrusted-text.ts";

registerCatalog({ en: memoryEn, fr: memoryFr });

/** The status panel shows the newest of each (M11R152); the daemon sends newest first. */
export const RECENT_ITEMS = 5;
export const RECENT_JOURNAL = 20;

type Tab = "memory" | "journal";
type Load =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly items: MemoryItemView[]; readonly journal: MemoryJournalView[] }
  | { readonly kind: "failed" };

/** Reads the agent's scope once on open (memory moves slowly; Retry reads it again). */
function useAgentMemory(agentId: string) {
  const [state, setState] = useState<{ readonly agentId: string; readonly load: Load } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    getRuntime()
      .rpc.call("memory.list", { scope: { kind: "agent", id: agentId } })
      .then((raw) => memoryMethods["memory.list"].result.parse(raw))
      .then(
        (parsed) => {
          if (live) setState({ agentId, load: { kind: "ready", ...parsed } });
        },
        () => {
          reportClientIssue("memory_read_failed");
          if (live) setState({ agentId, load: { kind: "failed" } });
        },
      );
    return () => {
      live = false;
    };
  }, [agentId, attempt]);
  const load: Load = state?.agentId === agentId ? state.load : { kind: "loading" };
  return { load, retry: () => setAttempt((value) => value + 1) };
}

/** "Recent memory" and the journal of one agent, as text: both may hold words from any session. */
export function RecentMemory({ agentId }: { readonly agentId: string }) {
  const t = useT();
  const { load, retry } = useAgentMemory(agentId);
  const [tab, setTab] = useState<Tab>("memory");
  return (
    <div data-slot="agent-memory-recent" className="flex flex-col gap-s2">
      <Segmented<Tab>
        label={t("memory.recent.tab")}
        value={tab}
        options={[
          { value: "memory", label: t("memory.recent.tab.memory") },
          { value: "journal", label: t("memory.journal.title") },
        ]}
        onChange={setTab}
      />
      {load.kind === "loading" ? (
        <p role="status" className="text-ui text-muted">
          {t("memory.loading")}
        </p>
      ) : null}
      {load.kind === "failed" ? (
        <div className="flex flex-col items-start gap-s2">
          <p role="alert" className="text-ui text-attn">
            {t("memory.recent.failed")}
          </p>
          <Button size="sm" onClick={retry}>
            {t("memory.retry")}
          </Button>
        </div>
      ) : null}
      {load.kind === "ready" && tab === "memory" ? <Items items={load.items.slice(0, RECENT_ITEMS)} /> : null}
      {load.kind === "ready" && tab === "journal" ? (
        <Journal lines={load.journal.slice(0, RECENT_JOURNAL)} />
      ) : null}
    </div>
  );
}

function Items({ items }: { readonly items: readonly MemoryItemView[] }) {
  const t = useT();
  if (items.length === 0) return <p className="text-ui text-muted">{t("memory.recent.none")}</p>;
  return (
    <ul className="flex flex-col gap-s2">
      {items.map((item) => (
        <li key={item.id} className="break-words text-ui text-fg">
          {lineOf(item.text)}
        </li>
      ))}
    </ul>
  );
}

function Journal({ lines }: { readonly lines: readonly MemoryJournalView[] }) {
  const t = useT();
  if (lines.length === 0) return <p className="text-ui text-muted">{t("memory.journal.none")}</p>;
  return (
    <ul className="flex flex-col gap-s2">
      {lines.map((line, index) => (
        <li key={`${line.at}:${index}`} className="flex items-start gap-s2">
          <Chip
            tone={line.kind === "add" ? "ok" : "mut"}
            label={t(line.kind === "add" ? "memory.journal.add" : "memory.journal.forget")}
          />
          <span className="min-w-0 flex-1 break-words text-ui text-fg">{lineOf(line.text)}</span>
        </li>
      ))}
    </ul>
  );
}

import "./register-space-catalog.ts";
import { fenceText, type AgentEventView } from "@pap/contracts";
import { Button, Chip, type ChipTone, formatCost, formatDuration } from "@pap/ui";
import { type ReactNode, useState } from "react";
import { EgressRefusalDialog } from "./EgressRefusalDialog.tsx";
import { type MessageKey, type Translate, useLocale, useT } from "../../i18n/index.ts";
import { papText } from "../../i18n/pap-text.ts";
import { UntrustedText } from "./UntrustedText.tsx";
import { lineOf, newFenceId, stripHidden } from "./untrusted-text.ts";

type CardState = "running" | "done" | "failed" | "cancelled" | "interrupted";
const STATE_TONE: Readonly<Record<CardState, ChipTone>> = {
  running: "run",
  done: "ok",
  failed: "err",
  cancelled: "mut",
  interrupted: "att",
};
/** The kinds whose text is not pap's: a dashed attention frame (DESIGN §2). */
const DASHED = new Set<AgentEventView["kind"]>(["isolated", "delegation"]);

export interface EventCardProps {
  readonly event: AgentEventView;
  /** The `[pap <kind> · …]` message that followed the card, folded under it. */
  readonly folded: string | null;
  readonly mode: "cards" | "compact";
  /** Puts text in the composer; it never sends. */
  onInject(text: string): void;
  /** Whose thread this is: the refused-host card names it and edits its list. Without it the card has no button. */
  readonly agent?: { readonly id: string; readonly name: string };
}

function stateOf(event: AgentEventView): CardState | null {
  switch (event.kind) {
    case "schedule":
    case "task":
    case "delegation":
    case "isolated":
      return event.data.state;
    default:
      return null;
  }
}

/** The line a card is in compact mode: what it is, and what it says in a few words. */
function headlineOf(event: AgentEventView, t: Translate): string {
  switch (event.kind) {
    case "schedule":
    case "task":
    case "isolated":
      return stripHidden(papText(t, event.data.title));
    case "delegation":
      return stripHidden(event.data.fromName);
    case "reminder":
      return stripHidden(event.data.note.split("\n")[0] ?? "");
    case "notify":
      return stripHidden(event.data.text.split("\n")[0] ?? "");
    case "egress_refused":
      return `${event.data.host}:${event.data.port}`;
  }
}

function useKindLabel(event: AgentEventView): string {
  const t = useT();
  if (event.kind === "egress_refused") return t("agentEgress.card.title");
  return event.kind === "delegation"
    ? t("agentSpace.event.delegation", { name: stripHidden(event.data.fromName) })
    : t(`agentSpace.event.${event.kind}` as MessageKey);
}

function Figures({ event }: { readonly event: AgentEventView }) {
  const t = useT();
  if (event.kind !== "schedule" && event.kind !== "task" && event.kind !== "isolated") return null;
  const { durationMs, costUsd } = event.data;
  const billing = event.kind === "isolated" ? undefined : event.data.billing;
  const parts: string[] = [];
  if (durationMs !== null && durationMs !== undefined) parts.push(formatDuration(durationMs));
  if (costUsd !== undefined)
    parts.push(
      t(billing === "subscription" ? "agentSpace.event.costApi" : "agentSpace.event.cost", {
        amount: formatCost(costUsd),
      }),
    );
  return parts.length === 0 ? null : <p className="font-mono text-label text-muted">{parts.join(" · ")}</p>;
}

function Untrusted({ source, children }: { readonly source: string; readonly children: ReactNode }) {
  const t = useT();
  return (
    <figure data-untrusted="" className="flex flex-col gap-s1">
      <figcaption className="label-hud text-attn">{t("agentSpace.event.untrusted", { source })}</figcaption>
      {children}
    </figure>
  );
}

/** The refused host (spec §6): pap's own sentence, then "Add…" unless the address is one pap never reaches. */
function EgressBody({
  data,
  agent,
}: {
  readonly data: Extract<AgentEventView, { kind: "egress_refused" }>["data"];
  readonly agent: EventCardProps["agent"];
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const addable = data.reason !== "blocked_address" && agent !== undefined;
  const name = agent === undefined ? t("agentEgress.someone") : stripHidden(agent.name);
  return (
    <>
      <p className="min-w-0 break-words text-ui text-fg">
        {t(`agentEgress.card.${data.reason}`, { name, host: data.host, port: data.port })}
      </p>
      {data.count > 1 ? (
        <p className="font-mono text-label text-muted">
          {t("agentEgress.card.count", { count: data.count })}
        </p>
      ) : null}
      {data.reason === "blocked_address" ? (
        <p className="text-label text-muted">{t("agentEgress.card.always")}</p>
      ) : null}
      {addable ? (
        <div>
          <Button size="sm" onClick={() => setOpen(true)}>
            {t("agentEgress.add")}
          </Button>
        </div>
      ) : null}
      {open && agent !== undefined ? (
        <EgressRefusalDialog agent={agent} data={data} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

function Body({ event, onInject, agent }: Pick<EventCardProps, "event" | "onInject" | "agent">) {
  const t = useT();
  switch (event.kind) {
    case "egress_refused":
      return <EgressBody data={event.data} agent={agent} />;
    case "schedule":
    case "task":
      return (
        <p className="min-w-0 break-words text-ui text-fg">{stripHidden(papText(t, event.data.title))}</p>
      );
    case "reminder":
      return <UntrustedText text={event.data.note} />;
    case "notify":
      return <UntrustedText text={event.data.text} />;
    case "isolated":
      return (
        <>
          <p className="min-w-0 break-words text-ui text-fg">{stripHidden(papText(t, event.data.title))}</p>
          <p data-scratch="" className="break-all font-mono text-label text-muted">
            {t("agentSpace.event.scratch", { path: stripHidden(event.data.scratch) })}
          </p>
          <Untrusted source={lineOf(event.data.source)}>
            <UntrustedText text={event.data.summary} />
          </Untrusted>
        </>
      );
    case "delegation": {
      const { summary, fromName, isolated, clipped } = event.data;
      const inject = () =>
        onInject(
          `${t("agentSpace.event.injectLead", { name: stripHidden(fromName) })}\n${fenceText(stripHidden(summary), "delegation", newFenceId())}`,
        );
      return (
        <>
          {isolated ? <p className="text-ui text-muted">{t("agentSpace.event.isolatedTask")}</p> : null}
          <Untrusted source="delegation">
            <UntrustedText text={summary} />
          </Untrusted>
          {clipped ? <p className="text-label text-muted">{t("agentSpace.event.clipped")}</p> : null}
          <div>
            <Button size="sm" onClick={inject}>
              {t("agentSpace.event.inject")}
            </Button>
          </div>
        </>
      );
    }
  }
}

/**
 * One card of the agent's thread (M11R119, DESIGN §2). A solid frame is the platform speaking; a dashed attention frame
 * with `UNTRUSTED · <source>` is text from outside (an isolated run, a delegation). The card is display only: nothing
 * in it is sent to a model, and Inject only fills the composer.
 */
export function EventCard({ event, folded, mode, onInject, agent }: EventCardProps) {
  const t = useT();
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const label = useKindLabel(event);
  const state = stateOf(event);
  const stateChip =
    state === null ? null : <Chip tone={STATE_TONE[state]} label={t(`agentSpace.state.${state}`)} />;
  const dashed = DASHED.has(event.kind);

  if (mode === "compact" && !open) {
    return (
      <div data-event-line={event.kind} className="flex min-w-0 items-center gap-s2">
        <button
          type="button"
          aria-expanded={false}
          aria-label={t("agentSpace.event.open", { title: `${label} ${headlineOf(event, t)}`.trim() })}
          onClick={() => setOpen(true)}
          className={`flex min-w-0 flex-1 items-center gap-s2 border-l-2 px-s2 py-s1 text-left text-ui ${dashed ? "border-attn" : "border-border-strong"}`}
        >
          <span className="label-hud text-muted">{label}</span>
          <span className="min-w-0 flex-1 truncate text-fg">{headlineOf(event, t)}</span>
          {stateChip}
          {event.kind === "egress_refused" ? <Chip tone="att" label={t("agentEgress.chip")} /> : null}
        </button>
      </div>
    );
  }
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(event.at);
  return (
    <article
      data-event-card={event.kind}
      data-frame={dashed ? "dashed" : "solid"}
      className={`flex flex-col gap-s1 rounded-md border p-s2 ${dashed ? "border-dashed border-attn" : "border-border-strong"}`}
    >
      <header className="flex flex-wrap items-center gap-s2">
        <h3 className="label-hud text-muted">{label}</h3>
        {stateChip}
        {event.kind === "egress_refused" ? <Chip tone="att" label={t("agentEgress.chip")} /> : null}
        {event.kind === "isolated" && event.data.tainted ? (
          <Chip tone="ext" label={t("agentSpace.header.external")} />
        ) : null}
        {event.kind === "delegation" && event.data.tainted ? (
          <Chip tone="ext" label={t("agentSpace.header.external")} />
        ) : null}
        <time dateTime={new Date(event.at).toISOString()} className="ml-auto font-mono text-label text-muted">
          {time}
        </time>
        {mode === "compact" ? (
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
            {t("agentSpace.event.fold")}
          </Button>
        ) : null}
      </header>
      <Body event={event} onInject={onInject} agent={agent} />
      <Figures event={event} />
      {folded !== null ? (
        <details>
          <summary className="cursor-pointer label-hud text-muted">{t("agentSpace.event.prompt")}</summary>
          <UntrustedText text={folded} />
        </details>
      ) : null}
    </article>
  );
}

import "./register-memory-catalog.ts";
import { MEMORY_LIMITS, type StagedFactView } from "@pap/contracts";
import { Button, Chip } from "@pap/ui";
import { useState } from "react";
import { errorKey, type MessageKey, useT } from "../../i18n/index.ts";
import { cutUnits, stripHidden } from "../../lib/untrusted-text.ts";
import { agentById } from "../../stores/agents-reducer.ts";
import { useAgents } from "../../stores/agents-store.ts";
import { decideOutcome } from "./memory.vm.ts";
import { useMemoryCall } from "./use-memory-call.ts";

export interface ReviewListProps {
  readonly facts: readonly StagedFactView[];
  /** Reads the queue again (after any answer, so a settled row leaves or changes). */
  onChanged(): void;
}

/**
 * The facts untrusted runs staged (M11R151, W5-R61). The fact is somebody else's text: React text in the dashed
 * `UNTRUSTED` frame, hidden characters removed, never markup. Approving asks pi-mem0 to remember it; nothing else does.
 */
export function ReviewList({ facts, onChanged }: ReviewListProps) {
  const t = useT();
  if (facts.length === 0) return null;
  return (
    <section data-slot="memory-review" aria-labelledby="memory-review-title" className="flex flex-col gap-s2">
      <h3 id="memory-review-title" className="label-hud text-fg">
        {t("memory.review.title")}
      </h3>
      <p className="text-ui text-muted">{t("memory.review.intro")}</p>
      <ul className="flex flex-col gap-s2">
        {facts.map((fact) => (
          <FactRow key={fact.factId} fact={fact} onChanged={onChanged} />
        ))}
      </ul>
    </section>
  );
}

function FactRow({ fact, onChanged }: { readonly fact: StagedFactView; onChanged(): void }) {
  const t = useT();
  const name = useAgents((view) => agentById(view, fact.agentId)?.name);
  const call = useMemoryCall();
  const [word, setWord] = useState<MessageKey | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // Only a fresh claim blocks an answer. A decision nobody claimed (pi-mem0 stopped, or its claim went stale) can be
  // given again: the owner is never stuck behind it.
  const applying = fact.applying || word === "memory.review.applying";
  const waiting = fact.decision !== null && !applying;
  const handled = word === "memory.review.handled";

  const decide = async (approved: boolean) => {
    setProblem(null);
    const result = await call.call("memory.decide", { factId: fact.factId, approved });
    if (result === undefined) return;
    if (!result.ok) {
      const outcome = decideOutcome(result.code);
      if (outcome.key === null) return setProblem(t(errorKey(result.code)));
      setWord(outcome.key);
    }
    onChanged();
  };

  return (
    <li data-fact-id={fact.factId} className="flex flex-col gap-s2">
      <figure
        data-untrusted=""
        className="flex flex-col gap-s1 rounded-md border border-dashed border-attn p-s2"
      >
        <figcaption className="label-hud text-attn">{t("memory.review.fence")}</figcaption>
        <p className="whitespace-pre-wrap break-words font-mono text-code text-muted">
          {stripHidden(cutUnits(fact.text, MEMORY_LIMITS.textChars))}
        </p>
      </figure>
      <div className="flex flex-wrap items-center gap-s2">
        <span className="text-ui text-muted">
          {t("memory.review.from", { name: name ?? t("memory.review.anAgent") })}
        </span>
        <span className="flex-1" />
        {applying ? <Chip tone="run" label={t("memory.review.applying")} /> : null}
        {waiting ? <Chip tone="mut" label={t("memory.review.waiting")} /> : null}
        {handled ? <Chip tone="mut" label={t("memory.review.handled")} /> : null}
        <Button
          size="sm"
          disabled={applying || handled}
          pendingSince={call.since}
          onClick={() => void decide(false)}
        >
          {t("memory.review.reject")}
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={applying || handled}
          pendingSince={call.since}
          onClick={() => void decide(true)}
        >
          {t("memory.review.approve")}
        </Button>
      </div>
      {problem !== null ? (
        <p role="alert" className="text-ui text-attn">
          {problem}
        </p>
      ) : null}
    </li>
  );
}

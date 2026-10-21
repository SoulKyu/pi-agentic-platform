import { Chip, Tooltip } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import { COMPOSER_LIFECYCLES, LIFECYCLE_TONE, type Lifecycle } from "./agent-lifecycle.ts";

/** The agent's state as a chip: the word, and a one-sentence tooltip (focusable, so the keyboard reads it too). */
export function LifecycleChip({ lifecycle }: { readonly lifecycle: Lifecycle }) {
  const t = useT();
  return (
    <Tooltip label={t(`shell.agent.tip.${lifecycle}`)}>
      <span tabIndex={0} data-lifecycle={lifecycle} className="inline-flex">
        <Chip
          tone={LIFECYCLE_TONE[lifecycle]}
          label={t(`shell.agent.state.${lifecycle}`)}
          dot={lifecycle === "working" || lifecycle === "needs_input"}
        />
      </span>
    </Tooltip>
  );
}

/** Above the composer: a chip only for a state that asks for an action or explains a delay, never for "all is well". */
export function ComposerLifecycle({ lifecycle }: { readonly lifecycle: Lifecycle | null }) {
  return lifecycle === null || !COMPOSER_LIFECYCLES.has(lifecycle) ? null : (
    <div data-composer-lifecycle="">
      <LifecycleChip lifecycle={lifecycle} />
    </div>
  );
}

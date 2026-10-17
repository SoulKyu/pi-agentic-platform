import { THINKING_LEVELS, type ThinkingLevel } from "@pap/contracts";

export interface ModelChoice {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
  /** Whether the model reasons; a model that does not offers only `off` (M7R45). */
  readonly reasoning: boolean;
}

const nameOf = (choice: ModelChoice): string => choice.name || choice.id;

/** The menu's labels: the name, and the provider too wherever two providers list the same name. */
export function choiceLabels(
  choices: readonly ModelChoice[],
  withProvider: (name: string, provider: string) => string,
): string[] {
  const seen = new Map<string, Set<string>>();
  for (const choice of choices) {
    const providers = seen.get(nameOf(choice)) ?? new Set<string>();
    providers.add(choice.provider);
    seen.set(nameOf(choice), providers);
  }
  return choices.map((choice) =>
    (seen.get(nameOf(choice))?.size ?? 0) > 1
      ? withProvider(nameOf(choice), choice.provider)
      : nameOf(choice),
  );
}

/** The thinking levels a model allows. An unlisted model (the default one, a saved one) is not known to lack them. */
export const levelsFor = (choice: ModelChoice | undefined): readonly ThinkingLevel[] =>
  choice !== undefined && !choice.reasoning ? ["off"] : THINKING_LEVELS;

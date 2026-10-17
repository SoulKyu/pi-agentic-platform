import { THINKING_LEVELS, type ThinkingLevel } from "@pap/contracts";

/** The thinking levels a model allows. An unlisted model (the default one, a saved one) is not known to lack them. */
export const levelsFor = (model: { readonly reasoning: boolean } | undefined): readonly ThinkingLevel[] =>
  model !== undefined && !model.reasoning ? ["off"] : THINKING_LEVELS;

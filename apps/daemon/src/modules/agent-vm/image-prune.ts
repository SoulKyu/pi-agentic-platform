/** `image.prune`'s `keep` holds at most this many tags (contracts `vmd.ts`). */
export const MAX_KEEP = 256;

/**
 * Final review I2: the tags pap-vmd must not remove. The base, the newest profile, every image just built, the newest image of
 * each agent this boot has seen, every image a VM runs on, and the recorded images of agents not seen since the boot (their
 * newest is unknown until they start again; they are pruned the next time). pap-vmd also skips any image a container uses.
 */
export function keepSet(input: {
  readonly base: string;
  readonly profile: string | null;
  readonly built: readonly string[];
  readonly latest: ReadonlyMap<string, string>;
  readonly running: readonly string[];
  readonly held: ReadonlyArray<{ readonly agentId: string; readonly image: string }>;
}): string[] {
  const keep = new Set<string>([input.base, ...input.built, ...input.latest.values(), ...input.running]);
  if (input.profile !== null) keep.add(input.profile);
  for (const one of input.held) if (!input.latest.has(one.agentId)) keep.add(one.image);
  return [...keep];
}

/** A large diff for the scale check: the real fixture pair repeated, so highlighting cost stays realistic. */
export function bigFixture(before: string, after: string, lines: number): { before: string; after: string } {
  const repeat = Math.ceil(lines / after.split("\n").length);
  return { before: before.repeat(repeat), after: after.repeat(repeat) };
}

/** Two columns on a desktop, one on a phone (DESIGN.md §8): the sections stack. */
export const columns = (stack: boolean): string =>
  stack ? "flex flex-col gap-s3" : "grid grid-cols-2 items-start gap-s3";

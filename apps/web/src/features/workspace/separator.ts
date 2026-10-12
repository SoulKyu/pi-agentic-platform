import { MAX_RATIO, MIN_RATIO } from "./model.ts";

const round = (n: number) => Math.round(n * 1e6) / 1e6;

export function ratioBounds(widthPx: number, minPx: number): readonly [number, number] {
  if (widthPx < minPx * 2) return [0.5, 0.5];
  return [round(Math.max(MIN_RATIO, minPx / widthPx)), round(Math.min(MAX_RATIO, 1 - minPx / widthPx))];
}

export function clampRatio(ratio: number, widthPx: number, minPx: number): number {
  const [low, high] = ratioBounds(widthPx, minPx);
  return round(Math.min(high, Math.max(low, ratio)));
}

/** Orca CsvColumnResizeHandle: arrows step 8 px (40 with Shift), Home resets. */
export function ratioAfterKey(
  ratio: number,
  key: string,
  shift: boolean,
  widthPx: number,
  minPx: number,
): number | null {
  if (key === "Home") return 0.5;
  const step = (shift ? 40 : 8) / Math.max(widthPx, 1);
  if (key === "ArrowLeft") return clampRatio(ratio - step, widthPx, minPx);
  if (key === "ArrowRight") return clampRatio(ratio + step, widthPx, minPx);
  return null;
}

export const ratioFromPointer = (clientX: number, left: number, widthPx: number, minPx: number): number =>
  clampRatio((clientX - left) / Math.max(widthPx, 1), widthPx, minPx);

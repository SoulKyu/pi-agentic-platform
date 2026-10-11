interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

function parse(hex: string): Rgba {
  const value = hex.replace("#", "");
  const channel = (i: number) => parseInt(value.slice(i, i + 2), 16);
  return { r: channel(0), g: channel(2), b: channel(4), a: value.length === 8 ? channel(6) / 255 : 1 };
}

const toHex = ({ r, g, b }: Rgba): string =>
  `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;

/** sRGB interpolation from a to b; t = 0 is a, 1 is b. */
export function mix(a: string, b: string, t: number): string {
  const x = parse(a);
  const y = parse(b);
  return toHex({ r: x.r + (y.r - x.r) * t, g: x.g + (y.g - x.g) * t, b: x.b + (y.b - x.b) * t, a: 1 });
}

function over(color: Rgba, backdrop: Rgba): Rgba {
  return {
    r: color.r * color.a + backdrop.r * (1 - color.a),
    g: color.g * color.a + backdrop.g * (1 - color.a),
    b: color.b * color.a + backdrop.b * (1 - color.a),
    a: 1,
  };
}

function luminance({ r, g, b }: Rgba): number {
  const linear = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG 2.x contrast ratio. A translucent background is composited over `backdrop` (default white). */
export function contrastRatio(foreground: string, background: string, backdrop = "#ffffff"): number {
  const bg = over(parse(background), parse(backdrop));
  const fg = over(parse(foreground), bg);
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Moves `color` toward `toward` in 5 % steps until it reaches `target` on `background` (DESIGN.md §13.2). */
export function ensureContrast(color: string, background: string, target: number, toward: string): string {
  let current = toHex(parse(color));
  for (let step = 1; step <= 20 && contrastRatio(current, background) < target; step++)
    current = mix(color, toward, step / 20);
  return current;
}

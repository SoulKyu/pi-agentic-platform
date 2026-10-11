import { Theme, type ThemeBg, type ThemeColor, type ThemeStyle } from "@earendil-works/pi-coding-agent";

/**
 * The SGR foreground code of each theme token, among the 8 basic colours (30–37) and bright black (90) only: the web
 * client maps exactly these to role tokens (DESIGN.md §9.2, owner C2) and ignores 256-colour and truecolor codes. A
 * token not listed keeps the default colour; a muted token is rendered dim (SGR 2).
 */
const FG: Partial<Record<ThemeColor, number>> = {
  error: 31,
  toolDiffRemoved: 31,
  success: 32,
  toolDiffAdded: 32,
  syntaxString: 32,
  warning: 33,
  syntaxNumber: 33,
  accent: 34,
  borderAccent: 34,
  mdHeading: 34,
  mdLink: 34,
  toolTitle: 34,
  syntaxKeyword: 34,
  customMessageLabel: 35,
  bashMode: 35,
  mdCode: 36,
  mdLinkUrl: 36,
  syntaxFunction: 36,
  syntaxType: 36,
  border: 90,
  scrollbarTrack: 90,
  dim: 90,
};
const DIM: ReadonlySet<ThemeColor> = new Set<ThemeColor>([
  "muted",
  "borderMuted",
  "thinkingText",
  "mdQuote",
  "mdQuoteBorder",
  "mdHr",
  "toolDiffContext",
  "syntaxComment",
  "thinkingOff",
  "thinkingMinimal",
  "thinkingLow",
  "thinkingMedium",
  "thinkingHigh",
  "thinkingXhigh",
  "thinkingMax",
]);
const opening = (color: ThemeColor): string => {
  const code = FG[color];
  return code !== undefined ? `\u001b[${code}m` : DIM.has(color) ? "\u001b[2m" : "";
};
const closing = (color: ThemeColor): string =>
  FG[color] !== undefined ? "\u001b[39m" : DIM.has(color) ? "\u001b[22m" : "";

class AnsiTheme extends Theme {
  constructor() {
    super(
      { muted: "", text: "", thinkingXhigh: "", searchMatchText: "" } as ConstructorParameters<
        typeof Theme
      >[0],
      { selectedBg: "" } as ConstructorParameters<typeof Theme>[1],
      "256color",
    );
  }

  override fg(color: ThemeColor, text: string): string {
    return `${opening(color)}${text}${closing(color)}`;
  }
  override bg(_color: ThemeBg, text: string): string {
    return text;
  }
  override style(text: string, options: ThemeStyle): string {
    let out = typeof options.fg === "string" ? this.fg(options.fg, text) : text;
    if (options.bold) out = this.bold(out);
    if (options.dim) out = `\u001b[2m${out}\u001b[22m`;
    if (options.italic) out = this.italic(out);
    if (options.underline) out = this.underline(out);
    return out;
  }
  override bold(text: string): string {
    return `\u001b[1m${text}\u001b[22m`;
  }
  override italic(text: string): string {
    return `\u001b[3m${text}\u001b[23m`;
  }
  override underline(text: string): string {
    return `\u001b[4m${text}\u001b[24m`;
  }
  override inverse(text: string): string {
    return text;
  }
  override strikethrough(text: string): string {
    return text;
  }
  override getFgAnsi(color: ThemeColor): string {
    return opening(color);
  }
  override getBgAnsi(): string {
    return "";
  }
  override getThinkingBorderColor(): (text: string) => string {
    return (text) => this.fg("dim", text);
  }
  override getBashModeBorderColor(): (text: string) => string {
    return (text) => this.fg("bashMode", text);
  }
}

/** What `ctx.ui.theme` is in pap, and what panels and widgets render with. */
export const ANSI_THEME: Theme = new AnsiTheme();

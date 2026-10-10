import { Theme } from "@earendil-works/pi-coding-agent";

class PlainTheme extends Theme {
  constructor() {
    super(
      { muted: "", text: "", thinkingXhigh: "", searchMatchText: "" } as ConstructorParameters<
        typeof Theme
      >[0],
      { selectedBg: "" } as ConstructorParameters<typeof Theme>[1],
      "truecolor",
    );
  }

  override fg(...[, text]: Parameters<Theme["fg"]>): string {
    return text;
  }
  override bg(...[, text]: Parameters<Theme["bg"]>): string {
    return text;
  }
  override bold(text: string): string {
    return text;
  }
  override italic(text: string): string {
    return text;
  }
  override underline(text: string): string {
    return text;
  }
  override inverse(text: string): string {
    return text;
  }
  override strikethrough(text: string): string {
    return text;
  }
  override getFgAnsi(): string {
    return "";
  }
  override getBgAnsi(): string {
    return "";
  }
  override getThinkingBorderColor(): (text: string) => string {
    return (text) => text;
  }
  override getBashModeBorderColor(): (text: string) => string {
    return (text) => text;
  }
}

export const PLAIN_THEME: Theme = new PlainTheme();

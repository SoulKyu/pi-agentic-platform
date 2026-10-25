import { renderToStaticMarkup } from "react-dom/server";
import { Banner, EmptyState, InlineError } from "@pap/ui";
import { describe, expect, it } from "vitest";
import { CODE_COPY_KEYS } from "./i18n/code-copy.ts";
import { agentsPhoneEn, agentsPhoneFr } from "./i18n/catalog/agents-phone.ts";
import { boxesEn, boxesFr } from "./i18n/catalog/boxes.ts";
import { shellEn, shellFr } from "./i18n/catalog/shell.ts";

const EN: Readonly<Record<string, string>> = { ...agentsPhoneEn, ...boxesEn, ...shellEn };
const FR: Readonly<Record<string, string>> = { ...agentsPhoneFr, ...boxesFr, ...shellFr };

describe("CODE_COPY_KEYS", () => {
  it("each key renders through its component with code and no backtick", () => {
    for (const [key, component] of Object.entries(CODE_COPY_KEYS)) {
      for (const text of [EN[key] ?? "", FR[key] ?? ""]) {
        expect(text, key).toContain("`");
        const html = renderToStaticMarkup(
          component === "EmptyState" ? (
            <EmptyState title="t" purpose={text} />
          ) : component === "Banner" ? (
            <Banner tone="crash" title="t">
              {text}
            </Banner>
          ) : (
            <InlineError announce="background">{text}</InlineError>
          ),
        );
        expect(html, key).toContain("<code");
        expect(html, key).not.toContain("`");
      }
    }
  });
});

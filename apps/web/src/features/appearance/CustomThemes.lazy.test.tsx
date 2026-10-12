// @vitest-environment happy-dom
import { Toaster, TooltipProvider } from "@pap/ui";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { settingsScreenEn, settingsScreenFr } from "../../i18n/catalog/settings-screen.ts";
import { registerCatalog } from "../../i18n/index.ts";
import { click, mount } from "../../testing/dom.ts";
import { CustomThemes } from "./CustomThemes.tsx";
import { useAppearanceStore } from "./appearance-store.ts";
import { DEFAULT_ACCOUNT } from "./model.ts";

registerCatalog({ en: settingsScreenEn, fr: settingsScreenFr });
vi.mock("../../lib/report.ts", () => ({ reportClientIssue: vi.fn() }));
vi.mock("./ThemeEditor.tsx", () => {
  throw new Error("Failed to fetch dynamically imported module: chunk.js");
});

afterEach(() => vi.restoreAllMocks());

describe("the theme editor chunk", () => {
  it("a chunk that does not load closes the editor and says to reload (M3R117)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {}); // React logs the caught error
    const ocean = {
      id: "ocean",
      name: "Ocean",
      base: "night",
      roles: {
        bg: "#0E1626",
        surface: "#132033",
        text: "#E6EDF7",
        agent: "#38BDF8",
        you: "#FB923C",
        attn: "#EC4899",
        ok: "#34D399",
        err: "#F87171",
      },
    } as const;
    useAppearanceStore.setState({ account: { ...DEFAULT_ACCOUNT, customThemes: [ocean] } });
    await mount(
      <TooltipProvider>
        <Toaster closeLabel="Close" regionLabel="Notifications" />
        <CustomThemes />
      </TooltipProvider>,
    );
    await click(document.querySelector('button[aria-label="Edit Ocean"]') as Element);
    await act(async () => {
      await vi.waitFor(
        () =>
          expect(document.body.textContent).toContain(
            "This part of pap did not load. pap may have been updated: reload the page.",
          ),
        { timeout: 2_000 },
      );
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});

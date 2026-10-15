// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { alerts, button, click, field, text, typeInto } from "../../testing/dom.ts";
import { showWithStepUp } from "./board-bed.tsx";
import { DraftHarness, segmentOn } from "./editor-bed.tsx";
import { emptyDraft, type Draft } from "./editor.vm.ts";
import { SourceSection } from "./SourceSection.tsx";

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const initial = (over: Partial<Draft> = {}): Draft => ({
  ...emptyDraft("/work/atlas", "Europe/Paris"),
  ...over,
});

const show = (
  draft: Draft,
  extra: { webhookUrl?: string | null; canRotate?: boolean; onRotate?: () => void } = {},
) =>
  showWithStepUp(
    <DraftHarness initial={draft}>
      {(current, set) => (
        <SourceSection
          draft={current}
          set={set}
          errors={{}}
          now={NOW}
          webhookUrl={extra.webhookUrl ?? null}
          canRotate={extra.canRotate ?? false}
          onRotate={extra.onRotate ?? (() => {})}
        />
      )}
    </DraftHarness>,
  );

describe("SourceSection: schedule", () => {
  it("lists the next five fires in the trigger's zone and follows a preset", async () => {
    const page = await show(initial());
    const fires = () => [...page.container.querySelectorAll('[data-slot="next-fires"] li')];
    expect(fires()).toHaveLength(5);
    expect((field(page.container, "Schedule (RRULE)") as HTMLInputElement).value).toBe(
      "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
    );
    await click(button(page.container, "Weekdays"));
    expect((field(page.container, "Schedule (RRULE)") as HTMLInputElement).value).toContain(
      "BYDAY=MO,TU,WE,TH,FR",
    );
    expect(fires()).toHaveLength(5);
  });

  it("shows the contract's refusal for a weekly rule without BYHOUR, instead of fires", async () => {
    const page = await show(initial());
    await typeInto(field(page.container, "Schedule (RRULE)") as HTMLInputElement, "FREQ=WEEKLY;BYDAY=MO");
    expect(alerts(page.container).join(" ")).toContain("Not supported: a schedule pap supports");
    expect(alerts(page.container).join(" ")).toContain("BYHOUR is missing");
    expect(page.container.querySelectorAll('[data-slot="next-fires"] li')).toHaveLength(0);
  });

  it("shows the zone of the trigger and the catch-up switch", async () => {
    const page = await show(initial({ timezone: "America/New_York" }));
    expect(text(page.container)).toContain("America/New_York");
    expect(page.container.querySelector('[role="switch"]')).not.toBeNull();
  });
});

describe("SourceSection: webhook", () => {
  const webhook = (over: Partial<Draft> = {}) => initial({ sourceType: "webhook", ...over });

  it("shows the URL with Copy, the limits line with the dedup window, and the format", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const page = await show(webhook({ dedupMinutes: "15" }), {
      webhookUrl: "https://pap.home.arpa/hooks/g1",
    });
    expect(text(page.container)).toContain("https://pap.home.arpa/hooks/g1");
    expect(text(page.container)).toContain("64 KB · 60/min · 20 queued · dedup 15 min");
    await click(button(page.container, "Copy"));
    expect(writeText).toHaveBeenCalledWith("https://pap.home.arpa/hooks/g1");
    expect(segmentOn(page.container, "Format")).toBe("Raw");
    await click(button(page.container, "Alertmanager"));
    expect(segmentOn(page.container, "Format")).toBe("Alertmanager");
    vi.unstubAllGlobals();
  });

  it("says the URL comes after the first save, and offers the signature header only for HMAC", async () => {
    const page = await show(webhook());
    expect(text(page.container)).toContain("The URL appears after the first save.");
    expect(text(page.container)).not.toContain("Signature header");
    await click(button(page.container, "HMAC"));
    expect(text(page.container)).toContain("Signature header");
    expect(segmentOn(page.container, "Authentication")).toBe("HMAC");
  });

  it("offers Rotation only for a saved trigger, and Run on resolved alerts for Alertmanager", async () => {
    const onRotate = vi.fn();
    const unsaved = await show(webhook());
    expect(button(unsaved.container, "Rotate secret").disabled).toBe(true);
    const page = await show(webhook({ format: "alertmanager" }), { canRotate: true, onRotate });
    expect(text(page.container)).toContain("Run on resolved alerts");
    await click(button(page.container, "Rotate secret"));
    expect(onRotate).toHaveBeenCalledOnce();
  });
});

describe("SourceSection: feed and manual", () => {
  it("takes the address and the interval of a feed", async () => {
    const page = await show(initial({ sourceType: "feed" }));
    await typeInto(
      field(page.container, "Feed address (https)") as HTMLInputElement,
      "https://example.org/a.xml",
    );
    expect((field(page.container, "Check every (minutes)") as HTMLInputElement).value).toBe("360");
  });

  it("switches source with the Segmented control", async () => {
    const page = await show(initial());
    await click(button(page.container, "Manual"));
    expect(segmentOn(page.container, "Source type")).toBe("Manual");
    expect(page.container.querySelector('[data-slot="next-fires"]')).toBeNull();
  });
});

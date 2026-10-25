// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { mount, text } from "../../testing/dom.ts";
import "./register-automation-settings-catalog.ts";
import { ObservabilityState } from "./ObservabilityState.tsx";

afterEach(() => setLocale("en"));

const lines = (container: HTMLElement) =>
  [...container.querySelectorAll("li")].map((item) => item.textContent);

describe("ObservabilityState", () => {
  it("says both exports are off, and how to turn /metrics on", async () => {
    const page = await mount(<ObservabilityState metrics={false} otlpHost={null} />);
    expect(lines(page.container).slice(0, 2)).toEqual([
      "Prometheus /metrics: off (set PAP_METRICS_TOKEN)",
      "OTLP export: off",
    ]);
  });

  it("says /metrics is on without naming a token", async () => {
    const page = await mount(<ObservabilityState metrics otlpHost={null} />);
    expect(lines(page.container).slice(0, 2)).toEqual(["Prometheus /metrics: on", "OTLP export: off"]);
    expect(text(page.container)).not.toMatch(/token/i);
  });

  it("says where OTLP goes, by host only", async () => {
    const page = await mount(<ObservabilityState metrics={false} otlpHost="otel.example.net:4318" />);
    expect(lines(page.container).slice(0, 2)).toEqual([
      "Prometheus /metrics: off (set PAP_METRICS_TOKEN)",
      "OTLP export: on, to otel.example.net:4318",
    ]);
  });

  it("shows both on with no secret anywhere, and the trace file hint", async () => {
    const page = await mount(<ObservabilityState metrics otlpHost="otel.example.net:4318" />);
    expect(lines(page.container).slice(0, 2)).toEqual([
      "Prometheus /metrics: on",
      "OTLP export: on, to otel.example.net:4318",
    ]);
    expect(text(page.container)).not.toMatch(/token|authorization|bearer|header/i);
    expect(lines(page.container)[2]).toContain("pap trace summary");
    expect(lines(page.container)[2]).toContain("logs/trace.jsonl");
  });

  it("is read-only: nothing to click", async () => {
    const page = await mount(<ObservabilityState metrics otlpHost={null} />);
    expect(page.container.querySelectorAll("button, input, a")).toHaveLength(0);
  });

  it("answers in French", async () => {
    setLocale("fr");
    const page = await mount(<ObservabilityState metrics={false} otlpHost="otel.example.net:4318" />);
    expect(lines(page.container).slice(0, 2)).toEqual([
      "Prometheus /metrics\u202f: désactivé (définir PAP_METRICS_TOKEN)",
      "Export OTLP\u202f: activé, vers otel.example.net:4318",
    ]);
  });
});

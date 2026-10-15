import { describe, expect, it } from "vitest";
import { mapPayload } from "./payload.ts";

const alert = (fingerprint: string, status = "firing", extra: Record<string, unknown> = {}) => ({
  status,
  labels: { alertname: "DiskFull", severity: "critical", instance: `host-${fingerprint}` },
  annotations: { summary: `disk ${fingerprint} is full` },
  fingerprint,
  startsAt: "2026-10-14T10:00:00Z",
  ...extra,
});
const group = (alerts: unknown[], status = "firing") => ({ version: "4", status, alerts });
const map = (format: "raw" | "alertmanager" | "grafana", body: unknown) =>
  mapPayload(format, body, JSON.stringify(body));

describe("mapPayload", () => {
  it("maps an Alertmanager v4 body of two firing alerts to two lines with a sorted identity", () => {
    const mapped = map("alertmanager", group([alert("fp2"), alert("fp1")]));
    expect(mapped.text.split("\n")).toEqual([
      "firing critical DiskFull host-fp2: disk fp2 is full",
      "firing critical DiskFull host-fp1: disk fp1 is full",
    ]);
    expect(mapped.identity).toBe("firing:fp1,fp2");
    expect(mapped.detail).toBe("firing critical DiskFull host-fp2: disk fp2 is full");
    expect(mapped.allResolved).toBe(false);
  });

  it("keeps the identity when the same group is re-sent with another startsAt", () => {
    const first = map("alertmanager", group([alert("fp1"), alert("fp2")]));
    const again = map(
      "alertmanager",
      group([alert("fp2", "firing", { startsAt: "2026-10-14T11:00:00Z" }), alert("fp1")]),
    );
    expect(again.identity).toBe(first.identity);
  });

  it("falls back to the labels' JSON when an alert has no fingerprint, key order aside", () => {
    const bare = (labels: Record<string, string>) => ({ status: "firing", labels });
    const one = map("alertmanager", group([bare({ a: "1", b: "2" })]));
    const two = map("alertmanager", group([bare({ b: "2", a: "1" })]));
    expect(one.identity).toBe(two.identity);
    expect(one.identity).toContain('"a":"1"');
  });

  it("reports allResolved only when every alert is resolved", () => {
    expect(
      map("alertmanager", group([alert("a", "resolved"), alert("b", "resolved")], "resolved")).allResolved,
    ).toBe(true);
    expect(map("alertmanager", group([alert("a", "resolved"), alert("b")])).allResolved).toBe(false);
    expect(map("alertmanager", group([])).allResolved).toBe(false);
  });

  it("caps at 50 lines and says how many more", () => {
    const many = Array.from({ length: 60 }, (_, index) => alert(`fp${index}`));
    const lines = map("alertmanager", group(many)).text.split("\n");
    expect(lines).toHaveLength(51);
    expect(lines.at(-1)).toBe("… and 10 more");
  });

  it("cuts a line at 512 characters", () => {
    const long = alert("a", "firing", { annotations: { summary: "x".repeat(5_000) } });
    for (const line of map("grafana", group([long])).text.split("\n"))
      expect(line.length).toBeLessThanOrEqual(512);
  });

  it("maps Grafana's shape, with the description when there is no summary", () => {
    const grafana = {
      status: "firing",
      alerts: [
        {
          status: "firing",
          labels: { alertname: "HighCpu", instance: "node1" },
          annotations: { description: "cpu above 90" },
          fingerprint: "abc",
        },
      ],
    };
    const mapped = map("grafana", grafana);
    expect(mapped.text).toBe("firing HighCpu node1: cpu above 90");
    expect(mapped.identity).toBe("firing:abc");
  });

  it("maps a body without alerts as raw", () => {
    const body = { hello: "world" };
    const mapped = mapPayload("alertmanager", body, JSON.stringify(body));
    expect(mapped).toMatchObject({ text: '{"hello":"world"}', identity: null, allResolved: false });
  });

  it("uses the JSON text field of a raw body when it is a string, the body as sent otherwise", () => {
    expect(mapPayload("raw", { text: "deploy failed" }, '{"text":"deploy failed"}').text).toBe(
      "deploy failed",
    );
    expect(mapPayload("raw", { text: 4 }, '{"text":4}').text).toBe('{"text":4}');
    expect(mapPayload("raw", undefined, "plain words\nsecond").text).toBe("plain words\nsecond");
  });

  it("strips format and control characters from the raw text itself, keeping line breaks and tabs", () => {
    const hidden = "\u202E\u200B\u2066\u{E0041}\u0007\u0085\u001B";
    expect(mapPayload("raw", undefined, `de${hidden}ploy\tfailed\nsecond\r\nthird`).text).toBe(
      "deploy\tfailed\nsecond\nthird",
    );
    const body = { text: `a${hidden}b\nc` };
    expect(mapPayload("raw", body, JSON.stringify(body)).text).toBe("ab\nc");
    expect(mapPayload("alertmanager", { note: `x${hidden}y` }, `{"note":"x${hidden}y"}`).text).toBe(
      '{"note":"xy"}',
    );
  });

  it("takes the detail from the first line, stripped of hidden characters", () => {
    const mapped = mapPayload("raw", undefined, "\u202Eevil\u200B title\nsecond line");
    expect(mapped.detail).toBe("evil title");
  });

  it("keeps each alert on one line and strips hidden characters from the labels", () => {
    const sneaky = alert("a", "firing", {
      labels: { alertname: "Dis\u202Ek\nFull", severity: "crit\u200Bical", instance: "h\r\nost" },
      annotations: { summary: "line1\nline2 \u0000" },
    });
    const mapped = map("alertmanager", group([sneaky]));
    expect(mapped.text).toBe("firing critical Disk Full h ost: line1 line2");
  });

  it("maps a hostile body within the size limit without throwing", () => {
    const deep = `${"[".repeat(30_000)}${"]".repeat(30_000)}`;
    const keys: Record<string, string> = {};
    for (let index = 0; index < 10_000; index += 1) keys[`k${index}`] = "v";
    const nested: unknown = JSON.parse(`{"a":${deep}}`);
    const hostile = [
      group([{ status: "firing", labels: keys, annotations: keys }]),
      group([{ status: "firing", labels: nested, annotations: nested, fingerprint: nested }]),
      group([nested, null, 4, "x"]),
      { alerts: { length: 10 } },
      nested,
    ];
    for (const body of hostile)
      for (const format of ["raw", "alertmanager", "grafana"] as const) {
        const mapped = mapPayload(format, body, "x".repeat(70_000));
        expect(mapped.text.length).toBeLessThanOrEqual(131_072);
        expect(mapped.detail.length).toBeLessThanOrEqual(200);
      }
  });
});

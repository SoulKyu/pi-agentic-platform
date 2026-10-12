import { UI_LIMITS } from "@pap/contracts";
import { afterEach, expect, it } from "vitest";
import { FLOOD } from "./testing/extensions.ts";
import { createIntBed, type IntBed } from "./testing/int-bed.ts";

const beds: IntBed[] = [];
afterEach(async () => {
  for (const bed of beds.splice(0)) await bed.dispose();
});

it("caps a flood of dialogs and decorations while the daemon answers other sessions", async () => {
  const bed = await createIntBed({ steps: [{ text: "unused" }] }, { extensions: { flood: FLOOD } });
  beds.push(bed);
  const { sessionId } = await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx);
  const other = (await bed.rpc["sessions.create"]({ cwd: bed.work }, bed.ctx)).sessionId;
  const otherSub = await bed.subscribe(other);
  const sub = await bed.subscribe(sessionId);
  void bed.rpc["sessions.prompt"]({ sessionId, text: "/flood" }, bed.ctx).catch(() => undefined);
  await sub.waitFor((e) => e.kind === "widget" && e.key === "huge");
  await sub.waitFor(
    (e) =>
      e.kind === "notice" && e.text.startsWith("An extension asked a question while too many were waiting"),
  );
  // The flood is parked on 64 open dialogs: another session still answers within a bound.
  const started = performance.now();
  await bed.rpc["sessions.rename"]({ sessionId: other, name: "Responsive" }, bed.ctx);
  await otherSub.waitFor((e) => e.kind === "name" && e.name === "Responsive", 5000);
  expect(performance.now() - started).toBeLessThan(5000);
  const widget = sub.events().find((e) => e.kind === "widget" && e.key === "huge");
  expect(widget?.kind === "widget" && [widget.widget?.lines.length, widget.widget?.lines[0]?.length]).toEqual(
    [UI_LIMITS.widgetLines, UI_LIMITS.widgetLineChars],
  );
  expect(sub.events().filter((e) => e.kind === "dialog_open")).toHaveLength(64);
  const snapshot = (await bed.subscribe(sessionId)).events()[0];
  if (snapshot?.kind !== "snapshot") throw new Error("no snapshot");
  expect([snapshot.dialogs.length, snapshot.widgets.length, snapshot.widgets[0]?.lines.length]).toEqual([
    64,
    1,
    UI_LIMITS.widgetLines,
  ]);
  expect(
    sub
      .events()
      .filter(
        (e) =>
          e.kind === "notice" &&
          e.text.startsWith("An extension asked a question while too many were waiting"),
      ),
  ).toHaveLength(1);
});

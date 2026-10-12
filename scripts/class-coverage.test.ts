import { describe, expect, it } from "vitest";
import { classCandidates, trackedSources, unknownClasses } from "./class-coverage.ts";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));

describe("class candidates", () => {
  it("reads className, cn() and UPPER_CASE class constants, nothing else", () => {
    const source = [
      'const VARIANTS = { primary: "bg-you-fill text-you-ink", ghost: "bg-transparent" } as const;',
      'const label = t("sessions.create");',
      'const FOCUS_RING = "focus-ring";',
      'const x = <div className={cn("flex gap-s2", open ? "state-open:opacity-100" : "hidden", busy && "opacity-50")} />;',
      'const y = <p className="text-ui text-muted">{"not a class"}</p>;',
      "const z = <i className={`w-${size} h-4`} />;",
    ].join("\n");
    const names = classCandidates("x.tsx", source).map((c) => c.className);
    expect(names).toEqual(
      expect.arrayContaining([
        "bg-you-fill",
        "text-you-ink",
        "bg-transparent",
        "focus-ring",
        "flex",
        "gap-s2",
        "state-open:opacity-100",
        "hidden",
        "opacity-50",
        "text-ui",
        "text-muted",
        "w-",
        "h-4",
      ]),
    );
    expect(names).not.toContain("sessions.create");
    expect(names).not.toContain("not");
  });
});

describe("class coverage", () => {
  it("every class in packages/ui and apps/web compiles to a rule", async () => {
    const unknown = await unknownClasses(REPO);
    expect(unknown.map((c) => `${c.file}:${c.line} ${c.className}`)).toEqual([]);
  }, 60_000);

  it("catches a typo and a dynamic fragment", async () => {
    const files = [
      {
        file: "fixture.tsx",
        text: 'const a = <b className="bg-surfce p-s2" />; const b = <i className={`w-${n}`} />;',
      },
    ];
    const unknown = await unknownClasses(REPO, files);
    expect(unknown.map((c) => c.className).sort()).toEqual(["bg-surfce", "w-"]);
  });

  it("reports a fragment or a truncated name even when a longer class compiles next to it (M3-RT-03)", async () => {
    const files = [
      {
        file: "fixture.tsx",
        text: 'const a = <b className={`w-full w-${n}`} />; const b = <i className="text-muted text-mut bg-surface-2 bg-surfac" />;',
      },
    ];
    const unknown = await unknownClasses(REPO, files);
    expect(unknown.map((c) => c.className).sort()).toEqual(["bg-surfac", "text-mut", "w-"]);
  });

  it("scans M2's session screens", () => {
    const files = trackedSources(REPO).map((source) => source.file);
    expect(files).toContain("apps/web/src/features/sessions/SessionScreen.tsx");
    expect(files).toContain("apps/web/src/features/auth/LoginScreen.tsx");
  });
});

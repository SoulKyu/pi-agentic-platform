import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalCard } from "./ApprovalCard.tsx";

interface Seen {
  readonly variant: string | undefined;
  readonly disabled: boolean | undefined;
  readonly onClick: (() => void) | undefined;
}

const LABELS = { deny: "Deny", session: "Session", always: "Always", once: "Allow once" } as const;

const seen = vi.hoisted((): Seen[] => []);

vi.mock("../primitives/Button.tsx", () => ({
  Button: (props: Seen) => {
    seen.push({ variant: props.variant, disabled: props.disabled, onClick: props.onClick });
    return null;
  },
}));

describe("ApprovalCard answers once", () => {
  beforeEach(() => {
    seen.length = 0;
  });

  it("sends the first answer only, whichever button follows", () => {
    const onChoose = vi.fn();
    renderToStaticMarkup(
      <ApprovalCard title="t" detail="h" answers={["deny", "once"]} labels={LABELS} onChoose={onChoose} />,
    );
    const allow = seen.find((button) => button.variant === "primary");
    const deny = seen.find((button) => button.variant === "secondary");
    expect(allow?.disabled).toBe(false);
    expect(deny?.disabled).toBe(false);
    allow?.onClick?.();
    allow?.onClick?.();
    deny?.onClick?.();
    expect(onChoose).toHaveBeenCalledExactlyOnceWith("once");
  });

  it("answers deny when Deny comes first", () => {
    const onChoose = vi.fn();
    renderToStaticMarkup(
      <ApprovalCard title="t" detail="h" answers={["deny", "once"]} labels={LABELS} onChoose={onChoose} />,
    );
    seen.find((button) => button.variant === "secondary")?.onClick?.();
    seen.find((button) => button.variant === "primary")?.onClick?.();
    expect(onChoose).toHaveBeenCalledExactlyOnceWith("deny");
  });
});

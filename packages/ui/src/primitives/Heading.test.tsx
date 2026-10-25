// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { mount } from "../testing/dom.ts";
import { Heading } from "./Heading.tsx";

describe("Heading", () => {
  it("renders the asked level with the section, group and card classes", async () => {
    const page = await mount(
      <>
        <Heading level={2} variant="section" id="s">
          Section
        </Heading>
        <Heading level={3} variant="group">
          Group
        </Heading>
        <Heading level={4} variant="card" tone="agent">
          Card
        </Heading>
        <Heading level={4} variant="card">
          Muted
        </Heading>
      </>,
    );
    const [section, group, agent, muted] = [...page.container.children] as HTMLElement[];
    expect([section?.tagName, group?.tagName, agent?.tagName]).toEqual(["H2", "H3", "H4"]);
    expect(section?.id).toBe("s");
    expect(section?.className).toContain("text-h2");
    expect(section?.className).toContain("text-fg");
    expect(group?.className).toContain("text-ui");
    expect(group?.className).toContain("font-semibold");
    expect(agent?.className).toContain("label-hud");
    expect(agent?.className).toContain("text-agent");
    expect(muted?.className).toContain("text-muted");
  });

  it("takes the attn tone, a focus target and a ref without changing its level", async () => {
    let node: HTMLHeadingElement | null = null;
    const page = await mount(
      <>
        <Heading level={3} variant="group" tone="attn">
          Pink
        </Heading>
        <Heading
          level={2}
          variant="group"
          tabIndex={-1}
          ref={(el) => {
            node = el;
          }}
        >
          Target
        </Heading>
      </>,
    );
    const [pink, target] = [...page.container.children] as HTMLElement[];
    expect(pink?.className).toContain("text-attn");
    expect(pink?.className).not.toContain("text-fg");
    expect(pink?.hasAttribute("tabindex")).toBe(false);
    expect(target?.getAttribute("tabindex")).toBe("-1");
    expect(target?.className).toContain("focus-ring");
    expect(node).toBe(target);
  });
});

// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { mount } from "../../testing/dom.ts";
import { OpenStatus } from "./AgentScreenParts.tsx";

const show = (code: string) =>
  mount(
    <OpenStatus
      agentId="atlas-1a2b"
      unusable={null}
      state={{ kind: "failed", code }}
      onRetry={() => {}}
      onOpenSettings={() => {}}
    />,
  );

describe("the agent thread after a failed open", () => {
  it("a launch the person stopped shows no error, only the way to try again", async () => {
    const page = await show("stopped");
    expect(page.container.querySelector('[data-slot="inline-error"]')).toBeNull();
    expect(page.container.querySelector("button")).not.toBeNull();
  });

  it("any other failure still shows its words", async () => {
    const page = await show("worker_failed");
    expect(page.container.querySelector('[data-slot="inline-error"]')).not.toBeNull();
  });
});

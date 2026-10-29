// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { mount } from "../testing/dom.ts";
import { ARTIFACT_SANDBOX, PREVIEW_SANDBOX, SandboxedFrame } from "./SandboxedFrame.tsx";

const FORBIDDEN = [
  "allow-same-origin",
  "allow-popups",
  "allow-popups-to-escape-sandbox",
  "allow-top-navigation",
  "allow-top-navigation-by-user-activation",
  "allow-top-navigation-to-custom-protocols",
  "allow-modals",
  "allow-storage-access-by-user-activation",
  "allow-presentation",
  "allow-pointer-lock",
  "allow-orientation-lock",
];

// happy-dom would fetch the frame's `src`: a test never reaches the network.
beforeEach(() => {
  (
    window as unknown as { happyDOM: { settings: { disableIframePageLoading: boolean } } }
  ).happyDOM.settings.disableIframePageLoading = true;
});

describe("SandboxedFrame", () => {
  it("pins the two sandbox sets token by token", () => {
    expect(PREVIEW_SANDBOX.split(" ")).toEqual(["allow-scripts", "allow-forms", "allow-downloads"]);
    expect(ARTIFACT_SANDBOX.split(" ")).toEqual(["allow-scripts"]);
    for (const set of [PREVIEW_SANDBOX, ARTIFACT_SANDBOX])
      for (const token of FORBIDDEN) expect(set.split(" ")).not.toContain(token);
  });

  it.each([
    ["the preview set", PREVIEW_SANDBOX],
    ["the artifact set", ARTIFACT_SANDBOX],
  ] as const)(
    "renders sandbox=…, no referrer, and the label outside the iframe (%s)",
    async (_name, sandbox) => {
      const page = await mount(
        <SandboxedFrame
          src="https://p.example/p/tok/"
          sandbox={sandbox}
          label="UNTRUSTED · preview web"
          title="Preview of web"
        />,
      );
      const frame = page.container.querySelector("iframe") as HTMLIFrameElement;
      expect(frame.getAttribute("sandbox")).toBe(sandbox);
      expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
      expect(frame.getAttribute("src")).toBe("https://p.example/p/tok/");
      expect(frame.getAttribute("title")).toBe("Preview of web");
      const label = page.container.querySelector("figcaption") as HTMLElement;
      expect(label.textContent).toBe("UNTRUSTED · preview web");
      expect(frame.contains(label)).toBe(false);
      expect(label.parentElement).toBe(frame.parentElement);
      const figure = page.container.querySelector('[data-slot="sandboxed-frame"]') as HTMLElement;
      expect(figure.className).toContain("border-dashed");
    },
  );
});

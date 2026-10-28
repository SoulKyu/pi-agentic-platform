// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { click, mount } from "../../testing/dom.ts";
import MarkdownBody from "./render.tsx";
import type { ShellHandOff, ShellStatus } from "./reply-tools.ts";

const COPY = { copy: "Copy", copied: "Copied" };

type Answer = { ok: boolean; text: string };

/** The app's side, in miniature: a status the block reads, kept outside it. */
function handOff(
  run: (code: string, lang: string) => Promise<Answer> = () => Promise.resolve({ ok: true, text: "Typed." }),
) {
  let status: ShellStatus = { since: null, answer: null };
  const listeners = new Set<() => void>();
  const move = (next: ShellStatus) => {
    status = next;
    for (const listener of listeners) listener();
  };
  const send = vi.fn(async (code: string, lang: string) => {
    move({ since: performance.now(), answer: null });
    const answer = await run(code, lang);
    move({ since: null, answer });
  });
  const fake: ShellHandOff = {
    label: "To terminal",
    canSend: (code) => code.trim() !== "",
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    statusOf: () => status,
    send,
  };
  return { fake, send };
}
const fence = (lang: string, code = "ls -la") => `\`\`\`${lang}\n${code}\n\`\`\``;
const buttons = (container: ParentNode) =>
  [...container.querySelectorAll("button")].map(
    (node) => node.textContent?.trim() || node.getAttribute("aria-label"),
  );

describe("shell blocks", () => {
  it("bash, sh, shell, zsh and console in any case get the button; python does not", async () => {
    for (const lang of ["bash", "SH", "Shell", "zsh", "Console"]) {
      const page = await mount(
        <MarkdownBody text={fence(lang)} copyLabels={COPY} shellHandOff={handOff().fake} />,
      );
      expect(page.container.querySelector("[data-shell-block]"), lang).not.toBeNull();
      expect(buttons(page.container), lang).toContain("To terminal");
      await page.unmount();
    }
    const python = await mount(
      <MarkdownBody text={fence("python", "print(1)")} copyLabels={COPY} shellHandOff={handOff().fake} />,
    );
    expect(python.container.querySelector("[data-shell-block]")).toBeNull();
    expect(buttons(python.container)).not.toContain("To terminal");
  });

  it("without a hand-off a shell block is the plain code block", async () => {
    const page = await mount(<MarkdownBody text={fence("bash")} copyLabels={COPY} />);
    expect(page.container.querySelector("[data-shell-block]")).toBeNull();
    expect(page.container.querySelector("[data-slot='code-block']")).not.toBeNull();
  });

  it("the copy button stays", async () => {
    const page = await mount(
      <MarkdownBody text={fence("bash")} copyLabels={COPY} shellHandOff={handOff().fake} />,
    );
    expect(buttons(page.container)).toContain("Copy");
  });

  it("the button is busy while send runs; ok text shows as a polite status, a refusal as an alert", async () => {
    let finish: (value: Answer) => void = () => {};
    const { fake, send } = handOff(() => new Promise<Answer>((resolve) => (finish = resolve)));
    const page = await mount(<MarkdownBody text={fence("bash")} copyLabels={COPY} shellHandOff={fake} />);
    const button = () =>
      page.container.querySelector("[data-shell-block] button[data-variant='ghost']") as HTMLButtonElement;
    await click(button());
    expect(send).toHaveBeenCalledExactlyOnceWith("ls -la", "bash");
    expect(button().getAttribute("aria-busy")).toBe("true");
    await click(button());
    expect(send).toHaveBeenCalledOnce();
    await act(async () => finish({ ok: true, text: "Typed there." }));
    expect(button().getAttribute("aria-busy")).toBeNull();
    const status = page.container.querySelector("[data-shell-block] [role='status']");
    expect(status?.textContent).toBe("Typed there.");
    expect(page.container.querySelector("[role='alert']")).toBeNull();

    await click(button());
    await act(async () => finish({ ok: false, text: "Refused." }));
    expect(page.container.querySelector("[data-shell-block] [role='alert']")?.textContent).toContain(
      "Refused.",
    );
    expect(page.container.querySelector("[data-shell-block] [role='status']")).toBeNull();
  });

  it("an empty block has no button", async () => {
    const page = await mount(
      <MarkdownBody text={"```bash\n\n```"} copyLabels={COPY} shellHandOff={handOff().fake} />,
    );
    expect(buttons(page.container)).not.toContain("To terminal");
  });
});

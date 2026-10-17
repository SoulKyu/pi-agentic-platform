import { EGRESS_UNKNOWN } from "@pap/contracts";
// @vitest-environment happy-dom
import type { SandboxStatus as Status } from "@pap/contracts";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { button, click, mount, settle, text } from "../../testing/dom.ts";
import { SandboxStatus } from "./SandboxStatus.tsx";
import { useSandboxStatus } from "./use-sandbox-status.ts";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const current: { runtime: Runtime | undefined } = { runtime: undefined };
const usable: Status = {
  usable: true,
  path: "/usr/bin/bwrap",
  reason: null,
  checkedAt: 10,
  egress: EGRESS_UNKNOWN,
};
const refusing = (reason: NonNullable<Status["reason"]>): Status => ({
  usable: false,
  path: null,
  reason,
  checkedAt: 11,
  egress: EGRESS_UNKNOWN,
});
const first: Status = { usable: false, path: null, reason: null, checkedAt: 0, egress: EGRESS_UNKNOWN };

function Harness() {
  const sandbox = useSandboxStatus();
  return <SandboxStatus sandbox={sandbox} />;
}

async function open(initial: Status | Error = usable) {
  const bed = fakeRuntime();
  current.runtime = bed.runtime;
  bed.handlers["agents.sandboxStatus"] = () => {
    if (initial instanceof Error) throw initial;
    return initial;
  };
  const page = await mount(<Harness />);
  await settle();
  return { bed, page };
}

beforeEach(() => setLocale("en"));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Settings › Agents › the sandbox", () => {
  it("reads the state once on open and says where bubblewrap is", async () => {
    const { bed, page } = await open();
    expect(bed.called("agents.sandboxStatus")).toHaveLength(1);
    expect(text(page.container)).toContain("Ready: bubblewrap at /usr/bin/bwrap");
  });

  it.each([
    ["missing", "Not usable: bubblewrap is not installed: sudo apt install bubblewrap"],
    ["unsafe_path", "Not usable: this binary is not owned by root"],
    ["refused", "Not usable: user namespaces are refused for it (AppArmor)"],
    ["timeout", "Not usable: it did not answer in 5 s"],
  ] as const)("says the %s reason in plain words", async (reason, sentence) => {
    const { page } = await open(refusing(reason));
    expect(text(page.container)).toContain(sentence);
    expect(text(page.container)).not.toContain("Ready:");
  });

  it("shows the install command as code", async () => {
    const { page } = await open(refusing("missing"));
    expect(page.container.querySelector("code")?.textContent).toBe("sudo apt install bubblewrap");
  });

  it("says it is checking while the first probe has not ended, and reads again until it has", async () => {
    vi.useFakeTimers();
    const bed = fakeRuntime();
    current.runtime = bed.runtime;
    const answers = [first, first, usable];
    bed.handlers["agents.sandboxStatus"] = () => answers.shift();
    const page = await mount(<Harness />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(text(page.container)).toContain("Checking the sandbox…");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(text(page.container)).toContain("Checking the sandbox…");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(text(page.container)).toContain("Ready: bubblewrap at /usr/bin/bwrap");
    expect(bed.called("agents.sandboxStatus")).toHaveLength(3);
  });

  it("after the last poll says the first check is taking longer than usual, and Check again still works", async () => {
    vi.useFakeTimers();
    const bed = fakeRuntime();
    current.runtime = bed.runtime;
    bed.handlers["agents.sandboxStatus"] = () => first;
    bed.handlers["agents.recheckSandbox"] = () => usable;
    const page = await mount(<Harness />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9999);
    });
    expect(text(page.container)).toContain("Checking the sandbox…");
    expect(bed.called("agents.sandboxStatus")).toHaveLength(5);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(bed.called("agents.sandboxStatus")).toHaveLength(6);
    expect(text(page.container)).toContain("The first check is taking longer than usual.");
    expect(text(page.container)).not.toContain("Checking the sandbox…");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(bed.called("agents.sandboxStatus")).toHaveLength(6);
    await click(button(page.container, "Check again"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(text(page.container)).toContain("Ready: bubblewrap at /usr/bin/bwrap");
    expect(text(page.container)).not.toContain("taking longer");
  });

  it("says so when the state cannot be read, and still offers Check again", async () => {
    const { page } = await open(new RpcError("internal"));
    expect(text(page.container)).toContain("The sandbox state could not be read.");
    expect(text(page.container)).not.toContain("Checking the sandbox");
    expect(button(page.container, "Check again").disabled).toBe(false);
  });
});

describe("Check again", () => {
  it("calls agents.recheckSandbox and shows the new answer", async () => {
    const { bed, page } = await open(refusing("missing"));
    bed.handlers["agents.recheckSandbox"] = () => ({ ...usable, checkedAt: 20 });
    await click(button(page.container, "Check again"));
    await settle();
    expect(bed.called("agents.recheckSandbox")).toHaveLength(1);
    expect(text(page.container)).toContain("Ready: bubblewrap at /usr/bin/bwrap");
    expect(text(page.container)).not.toContain("Not usable");
  });

  it("shows 'checking' only once the call has taken more than a second", async () => {
    const { bed, page } = await open();
    let release: (status: Status) => void = () => {};
    bed.handlers["agents.recheckSandbox"] = () =>
      new Promise<Status>((resolve) => {
        release = resolve;
      });
    let now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.useFakeTimers();
    await click(button(page.container, "Check again"));
    await act(async () => {
      now = 300;
      vi.advanceTimersByTime(200);
    });
    expect(button(page.container, "Check again").disabled).toBe(true);
    await act(async () => {
      now = 900;
      vi.advanceTimersByTime(600);
    });
    expect(text(page.container)).toContain("Ready: bubblewrap at /usr/bin/bwrap");
    expect(text(page.container)).not.toContain("Checking the sandbox…");
    await act(async () => {
      now = 1100;
      vi.advanceTimersByTime(200);
    });
    expect(text(page.container)).toContain("Checking the sandbox…");
    await act(async () => {
      release(refusing("refused"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(text(page.container)).toContain("Not usable: user namespaces are refused for it (AppArmor)");
    expect(button(page.container, "Check again").disabled).toBe(false);
  });

  it("answers rate_limited with 'try again in a few seconds' and keeps the last state", async () => {
    const { bed, page } = await open(refusing("timeout"));
    bed.handlers["agents.recheckSandbox"] = () => {
      throw new RpcError("rate_limited");
    };
    await click(button(page.container, "Check again"));
    await settle();
    expect(text(page.container)).toContain("Checked a moment ago: try again in a few seconds.");
    expect(text(page.container)).toContain("Not usable: it did not answer in 5 s");
  });

  it("says the check could not run on any other failure", async () => {
    const { bed, page } = await open();
    bed.handlers["agents.recheckSandbox"] = () => {
      throw new RpcError("forbidden");
    };
    await click(button(page.container, "Check again"));
    await settle();
    expect(text(page.container)).toContain("The check could not run. Try again.");
    expect(text(page.container)).toContain("Ready: bubblewrap at /usr/bin/bwrap");
  });

  it("never lets a slower, older answer replace a newer one", async () => {
    const bed = fakeRuntime();
    current.runtime = bed.runtime;
    let late: (status: Status) => void = () => {};
    bed.handlers["agents.sandboxStatus"] = () =>
      new Promise<Status>((resolve) => {
        late = resolve;
      });
    bed.handlers["agents.recheckSandbox"] = () => usable;
    const page = await mount(<Harness />);
    await settle();
    await click(button(page.container, "Check again"));
    await settle();
    await act(async () => {
      late({ usable: false, path: null, reason: "missing", checkedAt: 3, egress: EGRESS_UNKNOWN });
    });
    expect(text(page.container)).toContain("Ready: bubblewrap at /usr/bin/bwrap");
  });
});

describe("what the sandbox shows and does not cover", () => {
  it("lists what a shell sees, with no folder of the owner's home", async () => {
    const { page } = await open();
    const sees = page.container.querySelector('[data-slot="sandbox-sees"]') as HTMLElement;
    const items = [...sees.querySelectorAll("li")].map((item) => item.textContent);
    expect(items).toEqual([
      "A thread: the system, minus your home, pap's and Pi's folders, the system logs, crash dumps and /var/tmp. Its own home is writable.",
      "An isolated task: the system folders, its home read-only, and its scratch folder to write in.",
      "Neither sees any folder of your home.",
    ]);
  });

  it("lists the six things it does not cover, the node / rg / fd line among them", async () => {
    const { page } = await open();
    const gaps = page.container.querySelector('[data-slot="sandbox-gaps"]') as HTMLElement;
    const items = [...gaps.querySelectorAll("li")].map((item) => item.textContent);
    expect(items).toHaveLength(6);
    expect(items[0]).toContain("The worker itself");
    expect(items[5]).toBe("The shell has no node, rg or fd unless they are installed system-wide.");
  });

  it("speaks French", async () => {
    setLocale("fr");
    const { page } = await open(refusing("unsafe_path"));
    expect(text(page.container)).toContain("Inutilisable : ce binaire n'appartient pas à root");
    expect(button(page.container, "Vérifier à nouveau").disabled).toBe(false);
  });
});

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { button, click, hasButton, settle, text } from "../../testing/dom.ts";
import {
  CWD,
  current,
  newBed,
  overviewOf,
  PROJECT_FILE,
  rowButton,
  serverOf,
  show,
  switchOf,
} from "./mcp-bed.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

afterEach(() => {
  setLocale("en");
  vi.restoreAllMocks();
});

const ASK = `This changes ${PROJECT_FILE}, which can run commands later. Save anyway?`;

async function open(id: string, overview = overviewOf()) {
  const bed = newBed(overview);
  const page = await show();
  await settle();
  await click(rowButton(page.container, id));
  return { bed, page };
}

describe("list", () => {
  it("groups Global and Project, each row with its state chip, and reads the overview for the folder", async () => {
    const bed = newBed();
    const page = await show();
    await settle();
    const chips = (id: string) =>
      [...rowButton(page.container, id).querySelectorAll('[data-slot="chip"]')].map(
        (chip) => chip.textContent,
      );
    expect(chips("global/fs")).toEqual(["on"]);
    expect(chips("global/docs")).toEqual(["disabled"]);
    expect(chips("project/local")).toEqual(["on"]);
    expect(text(page.container)).toContain("Global");
    expect(text(page.container)).toContain("Project");
    expect(bed.called("mcp.overview").map((call) => call.params)).toEqual([{ cwd: CWD }]);
  });

  it("reads a partial group off with its n/m count, and says why a project is out of reach", async () => {
    newBed(
      overviewOf({
        project: {
          path: PROJECT_FILE,
          problem: null,
          trusted: false,
          servers: [serverOf({ name: "local", scope: "project", state: "not-trusted" })],
        },
      }),
    );
    const page = await show();
    await settle();
    expect(text(page.container)).toContain("1/2");
    expect(text(page.container)).toContain("This project is not trusted");
    expect(switchOf(page.container, "All project servers").disabled).toBe(true);
  });

  it("renders a hidden character of a name as a visible escape", async () => {
    newBed(
      overviewOf({
        global: { path: "/g", problem: null, trusted: null, servers: [serverOf({ name: "ev‮il" })] },
      }),
    );
    const page = await show();
    await settle();
    expect(text(page.container)).toContain("ev\\u202Eil");
    expect(text(page.container)).not.toContain("‮");
  });

  it("says the folder has no project file when none is chosen", async () => {
    const bed = newBed(overviewOf({ project: null }));
    const page = await show(null);
    await settle();
    expect(bed.called("mcp.overview").map((call) => call.params)).toEqual([{}]);
    expect(text(page.container)).toContain("Choose a project in the switcher");
  });

  it("is in French with no key left over", async () => {
    setLocale("fr");
    newBed();
    const page = await show();
    await settle();
    expect(text(page.container)).toContain("Global");
    expect(text(page.container)).toContain("Mode code");
    expect(text(page.container)).not.toMatch(/settingsMcp\./);
  });
});

describe("switches", () => {
  it("switches a global group with one call and no confirmation", async () => {
    const { bed, page } = await open("global/fs");
    bed.handlers["mcp.setEnabled"] = () => ({ results: [] });
    await click(switchOf(page.container, "All global servers"));
    await settle();
    expect(bed.called("mcp.setEnabled").map((call) => call.params)).toEqual([
      {
        servers: [
          { scope: "global", name: "fs" },
          { scope: "global", name: "docs" },
        ],
        enabled: true,
        cwd: CWD,
      },
    ]);
    expect(bed.called("mcp.overview")).toHaveLength(2);
  });

  it("asks 'Save anyway?' before a project row, sends nothing on Cancel, then confirmProtected on Save", async () => {
    const { bed, page } = await open("global/fs");
    bed.handlers["mcp.setEnabled"] = () => ({ results: [{ scope: "project", name: "local", ok: true }] });
    await click(switchOf(page.container, "Server local"));
    expect(text(page.container)).toContain(ASK);
    expect(bed.called("mcp.setEnabled")).toHaveLength(0);
    await click(button(page.container, "Cancel"));
    await settle();
    expect(text(page.container)).not.toContain(ASK);
    expect(bed.called("mcp.setEnabled")).toHaveLength(0);
    await click(switchOf(page.container, "Server local"));
    await click(button(page.container, "Save"));
    await settle();
    expect(bed.called("mcp.setEnabled").map((call) => call.params)).toEqual([
      { servers: [{ scope: "project", name: "local" }], enabled: false, cwd: CWD, confirmProtected: true },
    ]);
  });

  it("shows a row whose file failed to save, and reads the overview again", async () => {
    const { bed, page } = await open("global/fs");
    bed.handlers["mcp.setEnabled"] = () => ({
      results: [
        { scope: "global", name: "fs", ok: true },
        { scope: "global", name: "docs", ok: false, code: "write_failed" },
      ],
    });
    await click(switchOf(page.container, "All global servers"));
    await settle();
    expect(page.container.querySelector('[role="alert"]')?.textContent).toContain("docs");
    expect(page.container.querySelector('[role="alert"]')?.textContent).toContain("could not be saved");
    expect(bed.called("mcp.overview")).toHaveLength(2);
  });

  it("waits for the write in flight before taking another, and reads again after a timeout", async () => {
    const { bed, page } = await open("global/fs");
    let release: (value: unknown) => void = () => {};
    bed.handlers["mcp.setEnabled"] = () => new Promise((resolve) => (release = resolve));
    await click(switchOf(page.container, "Server fs"));
    expect(switchOf(page.container, "Server docs").disabled).toBe(true);
    expect(button(page.container, "Remove").disabled).toBe(true);
    release({ results: [] });
    await settle();
    expect(switchOf(page.container, "Server docs").disabled).toBe(false);

    const { RpcError } = await import("../../runtime/index.ts");
    bed.handlers["mcp.setEnabled"] = () => Promise.reject(new RpcError("timeout"));
    expect(bed.called("mcp.overview")).toHaveLength(2);
    await click(switchOf(page.container, "Server fs"));
    await settle();
    expect(bed.called("mcp.overview")).toHaveLength(3);
    expect(page.container.querySelector('[role="alert"]')?.textContent).toBe(
      "The answer did not arrive. The change may or may not have been saved; the list was read again.",
    );
  });
});

describe("detail", () => {
  it("shows only what the overview sends: masked target, folder, names, !command fields, variables", async () => {
    const http = serverOf({
      name: "api",
      kind: "http",
      target: "https://x.example/•••",
      headerNames: ["Authorization"],
      commandFields: ["headers.Authorization"],
      variables: ["API_TOKEN"],
      cwd: "/srv/api",
    });
    const { page } = await open(
      "global/api",
      overviewOf({ global: { path: "/g", problem: null, trusted: null, servers: [http] } }),
    );
    const body = text(page.container);
    expect(body).toContain("https://x.example/•••");
    expect(body).toContain("/srv/api");
    expect(body).toContain("Authorization");
    expect(body).toContain("headers.Authorization");
    expect(body).toContain("API_TOKEN");
    expect(body).toContain("sends API_TOKEN to this server");
  });

  it("shows the exposure, and says why it cannot change for an untrusted project", async () => {
    const project = {
      path: PROJECT_FILE,
      problem: null,
      trusted: false,
      servers: [serverOf({ name: "local", scope: "project", exposure: "hidden" })],
    };
    const { page } = await open("project/local", overviewOf({ project }));
    const trigger = page.container.querySelector('[data-slot="select"] button') as HTMLButtonElement;
    expect(trigger.textContent).toBe("Hidden");
    expect(trigger.disabled).toBe(true);
    expect(text(page.container)).toContain(
      "This project is not trusted, so this server cannot be changed or tested.",
    );
    expect(button(page.container, "Test").disabled).toBe(true);
  });
});

describe("remove and undo", () => {
  it("removes a global server, shows Undo for it, and Undo sends mcp.undo with the token", async () => {
    const { bed, page } = await open("global/fs");
    bed.handlers["mcp.remove"] = () => ({ token: "tok-1", expiresInMs: 60_000 });
    await click(button(page.container, "Remove"));
    await settle();
    expect(bed.called("mcp.remove").map((call) => call.params)).toEqual([
      { scope: "global", name: "fs", cwd: CWD },
    ]);
    expect(text(page.container)).toContain("Removed fs");
    await click(button(page.container, "Undo"));
    await settle();
    expect(bed.called("mcp.undo").map((call) => call.params)).toEqual([{ token: "tok-1" }]);
    expect(hasButton(page.container, "Undo")).toBe(false);
  });

  it("asks before removing from a project, and undoing it asks again", async () => {
    const { bed, page } = await open("project/local");
    bed.handlers["mcp.remove"] = () => ({ token: "tok-2", expiresInMs: 60_000 });
    await click(button(page.container, "Remove"));
    expect(text(page.container)).toContain(ASK);
    expect(bed.called("mcp.remove")).toHaveLength(0);
    await click(button(page.container, "Save"));
    await settle();
    expect(bed.called("mcp.remove")[0]?.params).toEqual({
      scope: "project",
      name: "local",
      cwd: CWD,
      confirmProtected: true,
    });
    await click(button(page.container, "Undo"));
    expect(text(page.container)).toContain(ASK);
    expect(bed.called("mcp.undo")).toHaveLength(0);
    await click(button(page.container, "Save"));
    await settle();
    expect(bed.called("mcp.undo")[0]?.params).toEqual({ token: "tok-2", confirmProtected: true });
  });

  it("maps an undo refusal to its own text", async () => {
    const { bed, page } = await open("global/fs");
    const { RpcError } = await import("../../runtime/index.ts");
    bed.handlers["mcp.remove"] = () => ({ token: "tok-3", expiresInMs: 60_000 });
    bed.handlers["mcp.undo"] = () => Promise.reject(new RpcError("conflict"));
    await click(button(page.container, "Remove"));
    await settle();
    await click(button(page.container, "Undo"));
    await settle();
    expect(page.container.querySelector('[role="alert"]')?.textContent).toContain("name is used again");
  });

  it("drops the Undo when its 60 seconds are over", async () => {
    const { bed, page } = await open("global/fs");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      bed.handlers["mcp.remove"] = () => ({ token: "tok-4", expiresInMs: 60_000 });
      await click(button(page.container, "Remove"));
      expect(hasButton(page.container, "Undo")).toBe(true);
      const { act } = await import("react");
      await act(async () => {
        vi.advanceTimersByTime(60_001);
      });
      expect(hasButton(page.container, "Undo")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Test", () => {
  it("runs through the step-up, lists the tools just found and shows sign-in guidance", async () => {
    const { bed, page } = await open("global/fs");
    bed.handlers["mcp.test"] = () => ({
      state: "connected",
      tools: ["read_file", "ev‮il"],
      toolsTruncated: true,
      message: null,
      at: 5,
    });
    await click(button(page.container, "Test"));
    await settle();
    expect(bed.called("mcp.test").map((call) => call.params)).toEqual([
      { scope: "global", name: "fs", cwd: CWD },
    ]);
    const body = text(page.container);
    expect(body).toContain("Connected");
    expect(body).toContain("read_file");
    expect(body).toContain("ev\\u202Eil");
    expect(body).toContain("more tools");
    bed.handlers["mcp.test"] = () => ({
      state: "needs-sign-in",
      tools: [],
      toolsTruncated: false,
      message: "401 •••",
      at: 6,
    });
    await click(button(page.container, "Test"));
    await settle();
    expect(text(page.container)).toContain(
      "Sign in from a session: type /mcp, pick the server, then Sign in; paste the address your browser ends on when asked",
    );
  });

  it("shows the guidance from the last Test of the overview, with a count and no tool names", async () => {
    const lastTest = { at: 1, ok: false, state: "needs-sign-in", tools: null } as const;
    const { page } = await open(
      "global/fs",
      overviewOf({ global: { path: "/g", problem: null, trusted: null, servers: [serverOf({ lastTest })] } }),
    );
    expect(text(page.container)).toContain("Sign in from a session: type /mcp");
  });

  it("does nothing when the person cancels the password prompt", async () => {
    const { prompt } = await import("./mcp-bed.tsx");
    const { RpcError } = await import("../../runtime/index.ts");
    const { bed, page } = await open("global/fs");
    prompt.answer = false;
    try {
      bed.handlers["mcp.test"] = () => Promise.reject(new RpcError("step_up_required"));
      await click(button(page.container, "Test"));
      await settle();
      expect(page.container.querySelector('[role="alert"]')).toBeNull();
      expect(bed.called("mcp.test")).toHaveLength(1);
    } finally {
      prompt.answer = true;
    }
  });
});

describe("code mode", () => {
  it("reads its state from settings and sends one key per change", async () => {
    const { bed, page } = await open("global/fs");
    bed.handlers["mcp.setCodemode"] = () => ({ choice: "always", mode: "on", inlineBudget: null });
    await click(switchOf(page.container, "Always on"));
    await settle();
    expect(bed.called("mcp.setCodemode").map((call) => call.params)).toEqual([{ choice: "always" }]);
  });

  it("disables Always on with the visible reason when the settings cannot be read", async () => {
    newBed(overviewOf({ settings: null }));
    const page = await show();
    await settle();
    expect(switchOf(page.container, "Always on").disabled).toBe(true);
    expect(text(page.container)).toContain("settings.json could not be read");
  });
});

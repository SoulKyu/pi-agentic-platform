// @vitest-environment happy-dom
import "../register-session-catalog.ts";
import { DEFAULT_POLICY_SETTINGS, type Dialog, type TaintCause } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../../i18n/index.ts";
import { RpcError, type Runtime } from "../../../runtime/index.ts";
import { alerts, button, click, hasButton, mount, settle, text, type Mounted } from "../../../testing/dom.ts";
import { fakeRuntime } from "../../../testing/runtime-bed.ts";
import { DialogList } from "./DialogList.tsx";

// Mutants (decision 117, A3), each run for real (see the A3 report):
//  W1 the button shows when only one cause is markable -> "offers Mark as local only when every cause is markable".
//  W2 setSettings sent without the revision read -> "reads the settings, adds the rule with the revision, then clears".
//  W3 the badge ignores which folder is named -> "does not hide a cd to another folder".
//  W4 a retry after the second conflict -> "shows the error after a second conflict and clears nothing".
const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const at = (hours: number, minutes: number) => new Date(2026, 9, 19, hours, minutes).getTime();
const cause = (tool: string, hours: number, minutes: number, markable: boolean, count = 1): TaintCause => ({
  tool,
  count,
  source: markable ? `/x/ext/${tool}.ts` : `builtin:${tool}`,
  at: at(hours, minutes),
  markable,
});
type Over = Omit<Partial<Dialog>, "taintCauses"> & {
  taintCauses?: readonly TaintCause[];
  /** Causes the worker dropped. */
  older?: number;
};
const dialog = ({ taintCauses, older = 0, ...over }: Over = {}): Dialog => ({
  id: "a1",
  method: "approval",
  category: "exec",
  title: "Run a command?",
  message: "20 characters, 1 line\nbash: npm test",
  answers: ["deny", "once"],
  tool: "bash",
  tainted: true,
  ...(taintCauses === undefined ? {} : { taintCauses: { list: [...taintCauses], older } }),
  ...over,
});

let bed: ReturnType<typeof fakeRuntime>;
let mounted: Mounted | null = null;
async function show(card: Dialog, cwd = "/s/p") {
  mounted = await mount(<DialogList sessionId="sess-1" dialogs={[card]} hidden={0} cwd={cwd} />);
  await settle();
  return mounted.container;
}
beforeEach(() => {
  setLocale("en");
  bed = fakeRuntime();
  current.runtime = bed.runtime;
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});
const line = (page: Element) => page.querySelector("[data-approval-taint]")?.textContent;
const methods = () => bed.calls.map((call) => call.method).filter((method) => method.startsWith("policy."));

describe("the card names what tainted the session", () => {
  it("names one cause with its time", async () => {
    const page = await show(dialog({ taintCauses: [cause("web_search", 14, 2, false)] }));
    expect(line(page)).toBe("This session read external content: web_search (14:02)");
  });

  it("names two causes, then 'and N others' for the rest", async () => {
    const two = await show(
      dialog({ taintCauses: [cause("web_search", 14, 2, false), cause("todo", 14, 5, true)] }),
    );
    expect(line(two)).toBe("This session read external content: web_search (14:02), todo (14:05)");
    await mounted?.unmount();
    const four = await show(
      dialog({
        taintCauses: [
          cause("web_search", 14, 2, false),
          cause("todo", 14, 5, true),
          cause("a", 14, 6, true),
          cause("b", 14, 7, true),
        ],
      }),
    );
    expect(line(four)).toBe("This session read external content: a (14:06), b (14:07) and 2 others");
    await mounted?.unmount();
    const three = await show(
      dialog({
        taintCauses: [cause("web_search", 9, 2, false), cause("todo", 9, 5, true), cause("a", 9, 6, true)],
      }),
    );
    expect(line(three)).toBe("This session read external content: todo (09:05), a (09:06) and 1 other");
  });

  it("speaks French", async () => {
    setLocale("fr");
    const page = await show(
      dialog({
        taintCauses: [cause("web_search", 14, 2, false), cause("todo", 14, 5, true), cause("a", 14, 6, true)],
      }),
    );
    expect(line(page)).toBe(
      "Cette session a lu du contenu externe\u202f: todo (14:05), a (14:06) et 1 autre",
    );
  });

  it("says nothing when the card is not tainted or the worker named no cause", async () => {
    expect((await show(dialog({ tainted: false }))).querySelector("[data-approval-taint]")).toBeNull();
    await mounted?.unmount();
    expect((await show(dialog())).querySelector("[data-approval-taint]")).toBeNull();
  });

  it("names the two newest causes, with their count, and counts the dropped ones among the others", async () => {
    const page = await show(
      dialog({ taintCauses: [cause("web_search", 14, 2, false), cause("todo", 14, 5, true, 20)], older: 3 }),
    );
    expect(line(page)).toBe(
      "This session read external content: web_search (14:02), todo (14:05, 20 times) and 3 others",
    );
    await mounted?.unmount();
    setLocale("fr");
    const fr = await show(dialog({ taintCauses: [cause("todo", 14, 5, true, 2)], older: 1 }));
    expect(line(fr)).toBe("Cette session a lu du contenu externe\u202f: todo (14:05, 2 fois) et 1 autre");
  });

  it("never offers Mark as local when the worker dropped a cause, even if every one listed is markable", async () => {
    const page = await show(dialog({ taintCauses: [cause("todo", 14, 5, true)], older: 1 }));
    expect(hasButton(page, "Mark as local tool")).toBe(false);
  });

  it("offers Mark as local only when every cause is markable", async () => {
    const mixed = await show(
      dialog({ taintCauses: [cause("web_search", 14, 2, false), cause("todo", 14, 5, true)] }),
    );
    expect(hasButton(mixed, "Mark as local tool")).toBe(false);
    await mounted?.unmount();
    const all = await show(dialog({ taintCauses: [cause("todo", 14, 5, true), cause("plan", 14, 6, true)] }));
    expect(hasButton(all, "Mark as local tool")).toBe(true);
  });
});

describe("Mark as local tool", () => {
  const settings = { ...DEFAULT_POLICY_SETTINGS };
  const todo = cause("todo", 14, 5, true);
  async function open() {
    const page = await show(dialog({ taintCauses: [todo] }));
    await click(button(page, "Mark as local tool"));
    return page;
  }

  it("says what a click allows and names each tool with its exact source", async () => {
    const page = await open();
    const said = text(page);
    expect(said).toContain("Results of todo will no longer mark any session.");
    expect(said).toContain("todo · source /x/ext/todo.ts");
    expect(said).toContain(
      "reads nothing from outside this machine, sends nothing outside and does not modify your files",
    );
    expect(said).toContain(
      "run without asking, in every mode including Read only, even after external content",
    );
    expect(said).toContain("This session's mark will be cleared.");
    expect(methods()).toEqual([]);
  });

  it("speaks French when it asks", async () => {
    setLocale("fr");
    const page = await show(dialog({ taintCauses: [todo] }));
    await click(button(page, "Marquer comme outil local"));
    const said = text(page);
    expect(said).toContain("Les résultats de todo ne marqueront plus aucune session.");
    expect(said).toContain("n'envoie rien à l'extérieur");
    expect(said).toContain("sans demander, dans tous les modes, y compris Lecture seule");
    expect(said).toContain("La marque de cette session sera levée.");
  });

  it("cancels without a call", async () => {
    const page = await open();
    await click(button(page, "Cancel"));
    expect(methods()).toEqual([]);
    expect(hasButton(page, "Mark as local tool")).toBe(true);
  });

  it("reads the settings, adds the rule with the revision, then clears the taint; the card is not answered", async () => {
    bed.handlers["policy.getSettings"] = () => ({ value: settings, revision: 4 });
    bed.handlers["policy.setSettings"] = () => ({ revision: 5 });
    const page = await open();
    await click(button(page, "Mark as local"));
    await settle();
    expect(methods()).toEqual(["policy.getSettings", "policy.setSettings", "policy.clearTaint"]);
    expect(bed.called("policy.setSettings")[0]?.params).toEqual({
      value: { ...settings, localTools: [{ tool: "todo", source: "/x/ext/todo.ts" }] },
      baseRevision: 4,
    });
    expect(bed.called("policy.clearTaint")[0]?.params).toEqual({ sessionId: "sess-1" });
    expect(bed.called("sessions.respondDialog")).toEqual([]);
    expect(text(page)).toContain("Marked as local. This question still needs your answer.");
  });

  it("adds only the rules that are missing and keeps the owner's own", async () => {
    const mine = { tool: "mine", source: "/y/mine.ts" };
    bed.handlers["policy.getSettings"] = () => ({
      value: { ...settings, localTools: [mine, { tool: "todo", source: "/x/ext/todo.ts" }] },
      revision: 7,
    });
    const page = await show(
      dialog({ taintCauses: [todo, cause("plan", 14, 6, true), cause("plan", 14, 7, true)] }),
    );
    await click(button(page, "Mark as local tool"));
    await click(button(page, "Mark as local"));
    await settle();
    expect(bed.called("policy.setSettings")[0]?.params).toMatchObject({
      value: {
        localTools: [
          mine,
          { tool: "todo", source: "/x/ext/todo.ts" },
          { tool: "plan", source: "/x/ext/plan.ts" },
        ],
      },
      baseRevision: 7,
    });
  });

  it("reads again and retries once on a conflict", async () => {
    let revision = 4;
    let writes = 0;
    bed.handlers["policy.getSettings"] = () => ({ value: settings, revision: revision++ });
    bed.handlers["policy.setSettings"] = () => {
      if (++writes === 1) throw new RpcError("conflict");
      return { revision: 9 };
    };
    const page = await open();
    await click(button(page, "Mark as local"));
    await settle();
    expect(methods()).toEqual([
      "policy.getSettings",
      "policy.setSettings",
      "policy.getSettings",
      "policy.setSettings",
      "policy.clearTaint",
    ]);
    expect(
      bed.called("policy.setSettings").map((call) => (call.params as { baseRevision: number }).baseRevision),
    ).toEqual([4, 5]);
    expect(alerts(page)).toEqual([]);
  });

  it("shows the error after a second conflict and clears nothing", async () => {
    bed.handlers["policy.getSettings"] = () => ({ value: settings, revision: 4 });
    bed.handlers["policy.setSettings"] = () => {
      throw new RpcError("conflict");
    };
    const page = await open();
    await click(button(page, "Mark as local"));
    await settle();
    expect(bed.called("policy.setSettings")).toHaveLength(2);
    expect(bed.called("policy.clearTaint")).toEqual([]);
    expect(alerts(page)).toHaveLength(1);
  });

  it("shows the error of a failed clear, and a second try writes nothing twice", async () => {
    bed.handlers["policy.getSettings"] = () => ({
      value: { ...settings, localTools: [{ tool: "todo", source: "/x/ext/todo.ts" }] },
      revision: 6,
    });
    bed.handlers["policy.clearTaint"] = () => {
      throw new RpcError("not_found");
    };
    const page = await open();
    await click(button(page, "Mark as local"));
    await settle();
    expect(bed.called("policy.setSettings")).toEqual([]);
    expect(alerts(page)).toHaveLength(1);
  });

  it("is not offered on a card that has no session to clear", async () => {
    mounted = await mount(<DialogList sessionId="" dialogs={[dialog({ taintCauses: [todo] })]} hidden={0} />);
    await settle();
    expect(hasButton(mounted.container, "Mark as local tool")).toBe(false);
  });
});

describe("a cd into the session folder", () => {
  const card = (command: string) =>
    dialog({ message: `${command.length} characters, 1 line\nbash: ${command}` });
  const shown = (page: Element) => page.querySelector("[data-approval-scroll]")?.textContent;
  const badge = (page: Element) => page.querySelector("[data-approval-cd]")?.textContent;

  it("hides cd <session folder> && and shows a badge; the toggle shows the full command", async () => {
    const page = await show(card("cd /s/p && go test ./..."));
    expect(shown(page)).toBe("bash: go test ./...");
    expect(badge(page)).toBe("in the session folder");
    await click(button(page, "Show full command"));
    expect(shown(page)).toBe("bash: cd /s/p && go test ./...");
    await click(button(page, "Hide full command"));
    expect(shown(page)).toBe("bash: go test ./...");
  });

  it("accepts the folder in single or double quotes and with one trailing slash", async () => {
    for (const command of ["cd '/s/p/' && go test", 'cd "/s/p" && go test', "cd /s/p/ && go test"]) {
      const page = await show(card(command));
      expect(shown(page), command).toBe("bash: go test");
      expect(badge(page)).toBe("in the session folder");
      await mounted?.unmount();
    }
  });

  it("does not hide a cd to another folder, a variable, home, the previous folder or a ; sequence", async () => {
    for (const command of [
      "cd /s/q && go test",
      "cd /s/p/sub && go test",
      "cd ~ && go test",
      "cd - && go test",
      'cd "$P" && go test',
      "cd /s/p; go test",
      "cd /s/p || go test",
      "cd /s/p &&",
      "cd /s/pp && go test",
      "cd '/s/p' x && go test",
      "go test && cd /s/p && go test",
    ]) {
      const page = await show(card(command));
      expect(shown(page), command).toBe(`bash: ${command}`);
      expect(badge(page), command).toBeUndefined();
      expect(hasButton(page, "Show full command"), command).toBe(false);
      await mounted?.unmount();
    }
  });

  it("does nothing without the session folder, on another tool, or when the folder has a shell character", async () => {
    mounted = await mount(
      <DialogList sessionId="sess-1" dialogs={[card("cd /s/p && go test")]} hidden={0} />,
    );
    await settle();
    expect(shown(mounted.container)).toBe("bash: cd /s/p && go test");
    await mounted.unmount();
    const other = await show({ ...card("cd /s/p && go test"), tool: "other" });
    expect(shown(other)).toBe("bash: cd /s/p && go test");
    await mounted?.unmount();
    const odd = await show(card('cd "/s/$x" && go test'), "/s/$x");
    expect(shown(odd)).toBe('bash: cd "/s/$x" && go test');
  });

  it("changes nothing about the answer", async () => {
    const page = await show({
      ...card("cd /s/p && go test"),
      answers: ["deny", "session", "always", "once"],
    });
    await click(button(page, "Allow once"));
    await settle();
    expect(bed.called("sessions.respondDialog").map((call) => call.params)).toEqual([
      { sessionId: "sess-1", dialogId: "a1", response: { answer: "once" } },
    ]);
  });

  it("speaks French", async () => {
    setLocale("fr");
    const page = await show(card("cd /s/p && go test"));
    expect(badge(page)).toBe("dans le dossier de la session");
    expect(hasButton(page, "Voir la commande complète")).toBe(true);
  });
});

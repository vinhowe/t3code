import { type ServerProviderSkill } from "@t3tools/contracts";
import type { Editor } from "@tiptap/core";
import { createRef, useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../test/render";

import { serializeEditorDoc } from "~/composer-rich-text-doc";
import { isComposerVimActive } from "~/composer-vim-editor";
import { createTextareaVimHost } from "~/textarea-vim";
import {
  ComposerPromptEditorTiptap as ComposerPromptEditor,
  type ComposerPromptEditorHandle,
  type ComposerPromptEditorProps,
} from "./ComposerPromptEditorTiptap";

vi.mock(import("../state/server"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const { compileResolvedKeybindingsConfig, DEFAULT_KEYBINDINGS } =
    await import("@t3tools/shared/keybindings");
  return {
    ...(await original()),
    primaryServerKeybindingsAtom: Atom.make(
      compileResolvedKeybindingsConfig([
        ...DEFAULT_KEYBINDINGS,
        { key: "mod+arrowup", command: "thread.previous" },
        { key: "mod+arrowdown", command: "thread.next" },
      ]),
    ),
  };
});

const babysit: ServerProviderSkill = {
  name: "babysit",
  path: "/skills/babysit/SKILL.md",
  enabled: true,
};

function Composer({
  value,
  richTextEnabled,
  skills,
  onChange,
  vimModeEnabled = false,
  onCommandKeyDown = () => false,
  importContextFragment,
  literalText = false,
  disabled = false,
  placeholder = "",
  placeholderSuffix,
}: {
  value: string;
  richTextEnabled: boolean;
  skills: ReadonlyArray<ServerProviderSkill>;
  onChange?: ComposerPromptEditorProps["onChange"] | undefined;
  vimModeEnabled?: boolean;
  onCommandKeyDown?: ComposerPromptEditorProps["onCommandKeyDown"] | undefined;
  importContextFragment?: ComposerPromptEditorProps["importContextFragment"];
  literalText?: boolean;
  disabled?: boolean;
  placeholder?: string;
  placeholderSuffix?: ComposerPromptEditorProps["placeholderSuffix"];
}) {
  const [prompt, setPrompt] = useState({ value, cursor: value.length });
  return (
    <ComposerPromptEditor
      editorRef={createRef<ComposerPromptEditorHandle>()}
      value={prompt.value}
      cursor={prompt.cursor}
      richTextEnabled={richTextEnabled}
      vimModeEnabled={vimModeEnabled}
      contextRecords={new Map()}
      skills={skills}
      disabled={disabled}
      placeholder={placeholder}
      placeholderSuffix={placeholderSuffix}
      onChange={(...args) => {
        setPrompt({ value: args[0], cursor: args[1] });
        onChange?.(...args);
      }}
      onPaste={() => {}}
      onCommandKeyDown={onCommandKeyDown}
      importContextFragment={importContextFragment}
      literalText={literalText}
    />
  );
}

function editorIn(container: HTMLElement) {
  const element = container.querySelector<HTMLElement & { editor: Editor }>(".tiptap");
  if (!element) throw new Error("Composer did not mount");
  return element.editor;
}

describe("vim mode", () => {
  const vimComposer = (value: string, props: Partial<Parameters<typeof Composer>[0]> = {}) => (
    <Composer value={value} richTextEnabled skills={[babysit]} vimModeEnabled {...props} />
  );

  // Focus can land after commands.focus resolves, and an earlier key would reach the body.
  async function focusAt(editor: Editor, position: number | "end") {
    await act(async () => {
      editor.commands.focus(position);
    });
    await vi.waitFor(() => expect(document.activeElement).toBe(editor.view.dom));
  }

  async function mountVim(
    value: string,
    props?: Partial<Parameters<typeof Composer>[0]>,
    wrap: (composer: React.ReactElement) => React.ReactElement = (composer) => composer,
  ) {
    await using stack = new AsyncDisposableStack();
    const screen = stack.use(await render(wrap(vimComposer(value, props))));
    const editor = editorIn(screen.container);
    // The engine is loaded on demand.
    await vi.waitFor(() => expect(isComposerVimActive(editor.view)).toBe(true));
    await focusAt(editor, "end");
    const environment = stack.move();
    return Object.assign(screen, {
      [Symbol.asyncDispose]: () => environment.disposeAsync(),
      editor,
      text: () => serializeEditorDoc(editor.state.doc).value,
    });
  }

  it("blocks typing in normal mode and returns to insert", async () => {
    await using screen = await mountVim("hello");
    await userEvent.keyboard("{Escape}");
    await expect.element(screen.getByRole("status")).toHaveTextContent("NORMAL");
    await userEvent.keyboard("zQ");
    expect(screen.text()).toBe("hello");
    await userEvent.keyboard("A!");
    expect(screen.text()).toBe("hello!");
    await expect.element(screen.getByRole("status")).not.toBeInTheDocument();
  });

  it("shows visual modes and acts on the selection", async () => {
    await using screen = await mountVim("hello world");
    await userEvent.keyboard("{Escape}0v");
    await expect.element(screen.getByRole("status")).toHaveTextContent("VISUAL");
    await userEvent.keyboard("ed");
    expect(screen.text()).toBe(" world");
    await userEvent.keyboard("V");
    await expect.element(screen.getByRole("status")).toHaveTextContent("V-LINE");
  });

  it("moves by visual line through wrapped text", async () => {
    await using screen = await mountVim("word ".repeat(200).trim(), {}, (composer) => (
      <div style={{ width: 200 }}>{composer}</div>
    ));
    const { view } = screen.editor;
    const top = () => view.coordsAtPos(view.state.selection.head).top;
    await userEvent.keyboard("{Escape}gg");
    const first = top();
    await userEvent.keyboard("gj");
    const second = top();
    expect(second).toBeGreaterThan(first);
    await userEvent.keyboard("g$");
    expect(top()).toBe(second);
    expect(view.state.selection.head).toBeGreaterThan(2);
    await userEvent.keyboard("g0");
    expect(top()).toBe(second);
    await userEvent.keyboard("gk");
    expect(top()).toBe(first);
    await userEvent.keyboard("G$");
    const end = view.state.selection.head;
    await userEvent.keyboard("gj");
    expect(view.state.selection.head).toBe(end);
  });

  // Keys use userEvent syntax: a literal { or [ is doubled.
  it.each([
    ["cw", "foo bar", "{Escape}0cwbaz{Escape}u", "foo bar"],
    ["cc", "foo bar", "{Escape}ccbaz{Escape}u", "foo bar"],
    ["3J", "a\nb\nc", "{Escape}gg3Ju", "a\nb\nc"],
    [":%s", "aa aa\naa", "{Escape}:%s/a/z/g{Enter}u", "aa aa\naa"],
    ["an insert with backspace", "foo", "{Escape}Aab{Backspace}c{Escape}u", "foo"],
    ["two inserts in turn", "x", "{Escape}Aa{Escape}Ab{Escape}u", "xa"],
    ["a cursor move inside an insert", "x", "{Escape}Aa{ArrowLeft}b{Escape}u", "xa"],
  ])("undoes %s the way vim does", async (_name, value, keys, expected) => {
    await using screen = await mountVim(value);
    await userEvent.keyboard(keys);
    expect(screen.text()).toBe(expected);
  });

  it("does not undo past a draft loaded from outside", async () => {
    await using screen = await mountVim("");
    await userEvent.keyboard("first");
    await act(async () => {
      screen.editor.commands.setContent("<p>loaded</p>", { emitUpdate: false });
      screen.editor.commands.focus("end");
    });
    await userEvent.keyboard(" more{Escape}u");
    expect(screen.text()).toBe("loaded");
  });

  it.each([
    ["a list below", "x\n\n- two\n- three", "{Escape}ggdd", "- two\n- three"],
    ["a code block below", "x\n\n```\ncode\n```", "{Escape}ggdd", "```\ncode\n```"],
    ["a quote below", "x\n\n> one\n> two", "{Escape}ggdd", "> one\n> two"],
    ["a rule below", "a\n\n---\n\nb", "{Escape}ggdd", "---\n\nb"],
    ["a lone heading", "# Title", "{Escape}dd", ""],
    ["a lone list item", "- item", "{Escape}dd", ""],
    ["an empty code block left behind", "```\ncode\n```\n\nafter", "{Escape}ggdddd", "after"],
    ["one line of a code block", "```\na\nb\n```", "{Escape}ggdd", "```\nb\n```"],
  ])("dd leaves %s intact", async (_name, value, keys, expected) => {
    await using screen = await mountVim(value);
    await userEvent.keyboard(keys);
    expect(screen.text().trim()).toBe(expected);
  });

  it.each([
    ["indents a list item", "- one\n- two", "{Escape}>>", "- one\n  - two"],
    ["outdents a list item", "- one\n  - two", "{Escape}<<", "- one\n- two"],
    ["keeps a top-level item in its list", "- one", "{Escape}<<", "- one"],
    ["continues a numbered list", "1. one\n2. two", "{Escape}ggonew", "1. one\n2. new\n3. two"],
    ["unchecks a new task", "- [x] done", "{Escape}onew", "- [x] done\n- [ ] new"],
    ["leaves a heading", "# Title", "{Escape}onew", "# Title\nnew"],
  ])("%s", async (_name, value, keys, expected) => {
    await using screen = await mountVim(value);
    await userEvent.keyboard(keys);
    expect(screen.text()).toBe(expected);
  });

  it.each([
    [
      "part of a code block after a line",
      "para\n\n```\nx\ny\nz\n```",
      "{Escape}ggd2j",
      "```\ny\nz\n```",
    ],
    [
      "part of a code block with 3dd",
      "para\n\n```\nx\ny\nz\n```",
      "{Escape}gg3dd",
      "```\ny\nz\n```",
    ],
    [
      "the tail of a code block and a line",
      "```\nx\ny\n```\n\nb\n\nc",
      "{Escape}ggj3dd",
      "```\nx\n```\n\nc",
    ],
    [
      "the last code line, keeping what follows",
      "```\na\nb\n```\n\nafter",
      "{Escape}ggjdd",
      "```\na\n```\n\nafter",
    ],
    ["lines to the end with dG", "a\nb\nc", "{Escape}ggjdG", "a"],
    ["lines to the end with 2dd", "a\nb\nc", "{Escape}ggj2dd", "a"],
    ["lines to the end in a list", "first\n\n- one\n- two", "{Escape}ggjdG", "first"],
  ])("dd removes only %s", async (_name, value, keys, expected) => {
    await using screen = await mountVim(value);
    await userEvent.keyboard(keys);
    expect(screen.text().trim()).toBe(expected);
  });

  it.each([
    ["a heading", "# Title"],
    ["a list item", "- item"],
    ["a quote", "> quote"],
    ["a code block", "```\ncode\n```"],
  ])("dd then p keeps %s", async (_name, value) => {
    await using screen = await mountVim(value);
    await userEvent.keyboard("{Escape}ddp");
    expect(screen.text().trim()).toBe(value);
  });

  it.each([
    [
      "a code block and a heading",
      "```\na\n```\n\n# Title\nx",
      "{Escape}gg3yyGp",
      "```\na\n```\n\n# Title\nx\n```\na\n```\n\n# Title",
    ],
    [
      "a plain line then a heading",
      "same\n# same\nx",
      "{Escape}gg2yyGp",
      "same\n# same\nx\nsame\n# same",
    ],
    [
      "a heading then a plain line",
      "# same\nsame\nx",
      "{Escape}gg2yyGp",
      "# same\nsame\nx\n# same\nsame",
    ],
    ["a counted paste", "# Title\nx", "{Escape}ggyyG2p", "# Title\nx\n# Title\n# Title"],
    ["the yank register", "# Title\nx", '{Escape}ggyyG"0p', "# Title\nx\n# Title"],
    ["a yank past a delete", "# Title\nx", '{Escape}ggyyjdd"0P', "# Title\n# Title"],
    ["the delete register", "# Title\nx", '{Escape}ggddG"1p', "x\n# Title"],
    ["a rotated delete", "# Title\nx\ny", '{Escape}ggddddG"2p', "y\n# Title"],
    [
      "code blocks in different languages",
      "```ts\na\n```\n```py\nb\n```\nx",
      "{Escape}gg2yyGp",
      "```ts\na\n```\n```py\nb\n```\nx\n```ts\na\n```\n```py\nb\n```",
    ],
  ])("pastes %s line by line", async (_name, value, keys, expected) => {
    await using screen = await mountVim(value);
    await userEvent.keyboard(keys);
    expect(screen.text()).toBe(expected);
  });

  it.each([
    ["a list item above itself", "- a", "{Escape}yyP", "- a\n- a"],
    ["a moved item", "- a\n- b\n- c", "{Escape}ggjddkP", "- b\n- a\n- c"],
    ["a quote line", "> a", "{Escape}yyP", "> a\n> a"],
    ["a task", "- [ ] a", "{Escape}yyP", "- [ ] a\n- [ ] a"],
    ["items into the middle", "- a\n- b\n- c", "{Escape}gg2yyGP", "- a\n- b\n- a\n- b\n- c"],
    ["checked state", "- [ ] todo\n- [x] done", "{Escape}gg2ddp", "\n- [ ] todo\n- [x] done"],
    ["item numbers", "1. one\n2. two", "{Escape}gg2ddp", "\n1. one\n2. two"],
    ["a heading beside a list", "# Title\n- item", "{Escape}ggddp", "- item\n# Title"],
    ["a heading after code", "# Title\n```\ncode\n```", "{Escape}ggddp", "```\ncode\n```\n# Title"],
    ["plain text above a heading", "plain\n# H1", "{Escape}ggddP", "plain\n# H1"],
    ["one heading above another", "## H2\n# H1", "{Escape}ggddP", "## H2\n# H1"],
    ["a nested item", "- one\n  - two\n\nx", "{Escape}ggjyyGp", "- one\n  - two\n\nx\n  - two"],
    ["a line ending in a blank", "# Title\n\nbody", "{Escape}gg2ddp", "body\n# Title\n"],
    ["a line starting with a blank", "\n\n# Title\nx", "{Escape}gg2yyGP", ""],
  ])("linewise paste keeps %s", async (_name, value, keys, expected) => {
    await using screen = await mountVim(value);
    await userEvent.keyboard(keys);
    if (expected) expect(screen.text()).toBe(expected);
    else expect(screen.text()).toContain("# Title");
  });

  it("pastes between a code block's blank first line and its code", async () => {
    await using screen = await mountVim("# H\n```\n\ncode\n```");
    await userEvent.keyboard("{Escape}ggyyjp");
    expect(screen.text()).toContain("# H\n```\ncode");
    await userEvent.keyboard("dd");
    expect(screen.text()).toContain("code");
    expect(screen.text().match(/# H/g)).toHaveLength(1);
  });

  it.each([
    ["a list into the next block", "- a\n\nb\n\nc", "{Escape}ggd2j", "b\n\nc"],
    ["through a list's end", "x\n\n- a\n- b\n\ny", "{Escape}Gkkd2k", "x\n\ny"],
  ])("deleting from %s leaves no marker", async (_name, value, keys, expected) => {
    await using screen = await mountVim(value);
    await userEvent.keyboard(keys);
    expect(screen.text()).not.toMatch(/^- $/m);
    expect(screen.text()).toContain(expected.split("\n").at(-1));
  });

  it("pastes a chip into code as its text", async () => {
    await using screen = await mountVim("$babysit now\n\n```\ncode\n```");
    await userEvent.keyboard("{Escape}gg0xjjp");
    expect(screen.editor.state.doc.lastChild?.textContent).toContain("$babysit");
  });

  it.each([
    ["keeps the blank line", "first para\n\nsecond para", "{Escape}Gdd", "first para\n"],
    [
      "pastes back in order",
      "first para\n\nsecond para",
      "{Escape}GddP",
      "first para\nsecond para\n",
    ],
    [
      "edits the kept blank line",
      "first para\n\nsecond para",
      "{Escape}Gddatail",
      "first para\ntail",
    ],
    // The blank line after a list is a separator, not a paragraph, so nothing is left after it.
    ["stays outside a list", "- a\n- b\n\nlast", "{Escape}Gdd", "- a\n- b"],
  ])("dd on the last line %s", async (_name, value, keys, expected) => {
    await using screen = await mountVim(value);
    await userEvent.keyboard(keys);
    expect(screen.text()).toBe(expected);
  });

  it("dd before a trailing rule keeps the rule", async () => {
    await using screen = await mountVim("a\n\n---");
    await userEvent.keyboard("{Escape}ggdd");
    expect(screen.text().trim()).toContain("---");
  });

  it("restores text pasted back after a charwise delete across blocks", async () => {
    await using screen = await mountVim("ab\ncd\nef");
    await userEvent.keyboard("{Escape}gg0vjdP");
    expect(screen.text()).toBe("ab\ncd\nef");
  });

  it("keeps formatting per named register", async () => {
    await using screen = await mountVim("# same\nsame\nx");
    await userEvent.keyboard('{Escape}gg"ayyj"byyG"ap');
    expect(screen.text()).toBe("# same\nsame\nx\n# same");
  });

  it.each([
    ["two items", "- a\n- b\n- c", "{Escape}gg2dd", "- c"],
    ["the last two items", "- a\n- b\n- c", "{Escape}Gdk", "- a"],
    ["items by line range", "- a\n- b\n- c", "{Escape}ggjdG", "- a"],
    ["numbered items", "1. a\n2. b\n3. c", "{Escape}gg2dd", "3. c"],
    ["tasks", "- [ ] a\n- [ ] b\n- [ ] c", "{Escape}gg2dd", "- [ ] c"],
  ])("deleting %s leaves no empty bullet", async (_name, value, keys, expected) => {
    await using screen = await mountVim(value);
    await userEvent.keyboard(keys);
    expect(screen.text()).toBe(expected);
  });

  it.each([
    ["v", "{Escape}0v{Enter}"],
    ["V", "{Escape}0V{Enter}"],
    ["d", "{Escape}0d{Enter}"],
  ])("Enter after %s does not send", async (_name, keys) => {
    const onCommandKeyDown = vi.fn((key: string) => key === "Enter");
    await using _screen = await mountVim("a\nb\nc", { onCommandKeyDown });
    await userEvent.keyboard(keys);
    expect(onCommandKeyDown).not.toHaveBeenCalledWith("Enter", expect.anything(), true);
  });

  it("reads AltGr characters as characters in normal mode", async () => {
    await using screen = await mountVim("a {b} c");
    await userEvent.keyboard("{Escape}0");
    await act(async () => {
      const init = { ctrlKey: true, altKey: true, bubbles: true, cancelable: true };
      for (const key of ["c", "i"]) {
        screen.editor.view.dom.dispatchEvent(
          new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
        );
      }
      const event = new KeyboardEvent("keydown", { ...init, key: "{", modifierAltGraph: true });
      screen.editor.view.dom.dispatchEvent(event);
    });
    expect(screen.text()).toBe("a {} c");
  });

  it("P keeps a heading above other text", async () => {
    await using screen = await mountVim("# Title\nbody");
    await userEvent.keyboard("{Escape}ggddP");
    expect(screen.text()).toBe("# Title\nbody");
  });

  it("keeps formatting when dot repeats a paste", async () => {
    await using screen = await mountVim("**bold**\nnext");
    await userEvent.keyboard("{Escape}ggddp.");
    expect(screen.text()).toBe("next\n**bold**\n**bold**");
  });

  it("does not treat a replace with p as a paste", async () => {
    await using screen = await mountVim("**p**b c");
    await userEvent.keyboard("{Escape}0x$rp");
    expect(screen.text()).toBe("*p**b p");
  });

  it("keeps a yank's formatting after moving a selection over matching text", async () => {
    await using screen = await mountVim("**bold**\nbold\nx");
    await userEvent.keyboard("{Escape}ggyyjv${Escape}Gp");
    expect(screen.text()).toBe("**bold**\nbold\nx\n**bold**");
  });

  it.each([
    [
      "an unchecked task above a checked one",
      "- [x] done",
      "{Escape}Otodo",
      "- [ ] todo\n- [x] done",
    ],
    ["a paragraph above a heading", "# Title", "{Escape}Oabove", "above\n# Title"],
    [
      "a renumbered item above the first",
      "1. one\n2. two",
      "{Escape}ggOzero",
      "1. zero\n2. one\n3. two",
    ],
  ])("O opens %s", async (_name, value, keys, expected) => {
    await using screen = await mountVim(value);
    await userEvent.keyboard(keys);
    expect(screen.text()).toBe(expected);
  });

  it("repeats O above the code block's neighbor with dot", async () => {
    await using screen = await mountVim("```\ncode\n```\n\nafter");
    await userEvent.keyboard("{Escape}GOx{Escape}.");
    expect(screen.editor.state.doc.firstChild?.textContent).toBe("code");
  });

  it("copies with Ctrl+C off macOS", async () => {
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    await using screen = await mountVim("abc");
    const reachedWindow = vi.fn();
    const listen = (event: KeyboardEvent) => {
      if (event.key === "c") reachedWindow(event.defaultPrevented);
    };
    window.addEventListener("keydown", listen);
    await userEvent.keyboard("{Control>}c{/Control}");
    await userEvent.keyboard("{Escape}0v");
    await userEvent.keyboard("{Control>}c{/Control}");
    window.removeEventListener("keydown", listen);
    expect(reachedWindow.mock.calls).toEqual([[false], [false]]);
    await expect.element(screen.getByRole("status").first()).toHaveTextContent("VISUAL");
  });

  it("leaves replace mode when focus leaves", async () => {
    await using screen = await mountVim("hello");
    await userEvent.keyboard("{Escape}0R");
    await act(async () => {
      screen.editor.view.dom.blur();
    });
    await act(async () => {
      screen.editor.view.focus();
    });
    await vi.waitFor(() => expect(document.activeElement).toBe(screen.editor.view.dom));
    await userEvent.keyboard("zz");
    expect(screen.text()).toBe("zzhello");
  });

  it("breaks the line on Enter in replace mode", async () => {
    const onCommandKeyDown = vi.fn(() => true);
    await using screen = await mountVim("ab", {
      onCommandKeyDown: (key) => key !== "Escape" && onCommandKeyDown(),
    });
    await userEvent.keyboard("{Escape}0R{Enter}");
    expect(onCommandKeyDown).not.toHaveBeenCalled();
    expect(screen.text()).toBe("\nab");
  });

  it.each([
    ["Shift+Backspace", "{Shift>}{Backspace}{/Shift}"],
    ["Alt+Backspace", "{Alt>}{Backspace}{/Alt}"],
    ["Backspace after a prefix", "g{Backspace}"],
    ["Delete after a prefix", "f{Delete}"],
  ])("%s never edits in normal mode", async (_name, keys) => {
    await using screen = await mountVim("hello world");
    await userEvent.keyboard("{Escape}");
    await userEvent.keyboard(keys);
    expect(screen.text()).toBe("hello world");
  });

  it("does not indent a code block with Tab in normal mode", async () => {
    await using screen = await mountVim("```\ncode\n```");
    await userEvent.keyboard("{Escape}{Tab}");
    expect(screen.editor.state.doc.firstChild?.textContent).toBe("code");
  });

  it("keeps the caret after a trailing emoji when focus leaves", async () => {
    await using screen = await mountVim("hi 👍");
    await userEvent.keyboard("{Escape}");
    await act(async () => {
      screen.editor.view.dom.blur();
    });
    await act(async () => {
      screen.editor.view.focus();
    });
    await vi.waitFor(() => expect(document.activeElement).toBe(screen.editor.view.dom));
    await userEvent.keyboard("!");
    expect(screen.text()).toBe("hi 👍!");
  });

  it("does not outrun the list when indenting past its nesting", async () => {
    await using screen = await mountVim("- one\n- two");
    await userEvent.keyboard("{Escape}>>>><<");
    expect(screen.text()).toBe("- one\n- two");
  });

  it("indents each selected line once per count", async () => {
    await using screen = await mountVim("a\nb");
    await userEvent.keyboard("{Escape}ggVj2>");
    expect(screen.text()).toBe("    a\n    b");
  });

  it("removes the panel with the setting", async () => {
    await using screen = await mountVim("a");
    await userEvent.keyboard("{Escape}:nonsense{Enter}");
    await screen.rerender(vimComposer("a", { vimModeEnabled: false }));
    await vi.waitFor(() => expect(document.querySelector("[data-vim-panel]")).toBe(null));
  });

  it("opens above a paragraph, not inside the code block before it", async () => {
    await using screen = await mountVim("```\ncode\n```\n\nafter");
    await userEvent.keyboard("{Escape}GOnew");
    expect(screen.editor.state.doc.firstChild?.textContent).toBe("code");
    expect(screen.text()).toContain("new");
  });

  it.each([
    ["in a code block", "```\ncode\n```", "{Enter}"],
    ["when send declines", "hello world", "{Enter}"],
    ["with Shift", "hello world", "{Shift>}{Enter}{/Shift}"],
  ])("Enter never edits in normal mode %s", async (_name, value, enter) => {
    const onCommandKeyDown = vi.fn(() => false);
    await using screen = await mountVim(value, { onCommandKeyDown });
    await userEvent.keyboard("{Escape}");
    const before = screen.text();
    await userEvent.keyboard(enter);
    expect(screen.text()).toBe(before);
    await expect.element(screen.getByRole("status").first()).toHaveTextContent("NORMAL");
  });

  it("dismisses a held message with Enter instead of sending", async () => {
    const onCommandKeyDown = vi.fn((key: string) => key === "Enter");
    await using screen = await mountVim("hi", { onCommandKeyDown });
    await userEvent.keyboard("{Escape}:registers{Enter}");
    await vi.waitFor(() => expect(document.activeElement).toBe(screen.editor.view.dom));
    expect(document.querySelector("[data-vim-panel]")?.textContent).toContain("ENTER");
    onCommandKeyDown.mockClear();
    await userEvent.keyboard("{Enter}");
    expect(onCommandKeyDown).not.toHaveBeenCalled();
  });

  it("leaves focus where it went when a prompt loses it", async () => {
    await using screen = await mountVim("draft", {}, (composer) => (
      <>
        {composer}
        <input aria-label="other" />
      </>
    ));
    await userEvent.keyboard("{Escape}/");
    await vi.waitFor(() => expect(document.activeElement?.tagName).toBe("INPUT"));
    await userEvent.click(screen.getByLabelText("other"));
    await vi.waitFor(() => expect(document.querySelector("[data-vim-panel] input")).toBe(null));
    await userEvent.keyboard("dd");
    expect(screen.text()).toBe("draft");
    await expect.element(screen.getByLabelText("other")).toHaveValue("dd");
    await expect.element(screen.getByText("NORMAL")).not.toBeInTheDocument();
  });

  it("cancels a pending register with Escape", async () => {
    await using screen = await mountVim("abc");
    await userEvent.keyboard('{Escape}0yl"z{Escape}$p');
    expect(screen.text()).toBe("abca");
    await userEvent.keyboard('"zp');
    expect(screen.text()).toBe("abca");
  });

  it("does not bold plain text that matches an earlier yank", async () => {
    await using screen = await mountVim("**bold**\nbold");
    await userEvent.keyboard("{Escape}ggyyjyyp");
    expect(screen.text()).toBe("**bold**\nbold\nbold");
  });

  it("does not add formatting to a replaced character", async () => {
    await using screen = await mountVim("**a**b c");
    await userEvent.keyboard("{Escape}0x$ra");
    // The caret shows the markers as text, so x takes one; the replaced a stays plain.
    expect(screen.text()).toBe("*a**b a");
  });

  it.each([
    ["a combining accent", "e\u0301x"],
    ["a joined emoji", "👨‍👩‍👧‍👦x"],
    ["a skin tone", "👍🏽x"],
  ])("yanks all of %s", async (_name, value) => {
    await using screen = await mountVim(value);
    await userEvent.keyboard("{Escape}0xP");
    expect(screen.text()).toBe(value);
  });

  it("writes a chip to the clipboard as prompt text", async () => {
    await using _screen = await mountVim("$babysit x");
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await userEvent.keyboard('{Escape}0"+yy');
    expect(writeText).toHaveBeenCalledWith("$babysit x\n");
    writeText.mockRestore();
  });

  it("survives the system clipboard being unavailable", async () => {
    await using screen = await mountVim("abc");
    const clipboard = Object.getOwnPropertyDescriptor(Navigator.prototype, "clipboard")!;
    using _restore = {
      [Symbol.dispose]: () => Object.defineProperty(Navigator.prototype, "clipboard", clipboard),
    };
    Object.defineProperty(Navigator.prototype, "clipboard", {
      configurable: true,
      value: undefined,
    });
    await userEvent.keyboard('{Escape}0v"+y');
    await expect.element(screen.getByRole("status").first()).toHaveTextContent("NORMAL");
  });

  it("stays in normal mode through a native paste", async () => {
    await using screen = await mountVim("hello");
    await userEvent.keyboard("{Escape}0");
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", "XX");
    await act(async () => {
      screen.editor.view.dom.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
      );
    });
    expect(screen.text()).toBe("XXhello");
    await expect.element(screen.getByRole("status").first()).toHaveTextContent("NORMAL");
  });

  it("keeps the caret after the last character when focus leaves", async () => {
    await using screen = await mountVim("");
    await userEvent.keyboard("hello{Escape}");
    await act(async () => {
      screen.editor.view.dom.blur();
    });
    await act(async () => {
      screen.editor.view.focus();
    });
    await vi.waitFor(() => expect(document.activeElement).toBe(screen.editor.view.dom));
    await userEvent.keyboard("X");
    expect(screen.text()).toBe("helloX");
  });

  it("keeps a click past the last character on a character", async () => {
    await using screen = await mountVim("abc");
    await userEvent.keyboard("{Escape}");
    await act(async () => {
      screen.editor.commands.setTextSelection(4);
    });
    await userEvent.keyboard("x");
    expect(screen.text()).toBe("ab");
  });

  it("does not open composer menus from normal mode motions", async () => {
    const onChange = vi.fn<NonNullable<ComposerPromptEditorProps["onChange"]>>();
    await using _screen = await mountVim("see @foo now", { onChange });
    await userEvent.keyboard("{Escape}0w");
    onChange.mockClear();
    await userEvent.keyboard("l");
    expect(onChange.mock.lastCall?.[3]).toBe(true);
  });

  it("undoes a whole insert in one step", async () => {
    await using screen = await mountVim("a");
    await userEvent.keyboard("{Escape}A one two{Enter}three{Escape}u");
    expect(screen.text()).toBe("a");
  });

  it("repeats the last change with dot", async () => {
    await using screen = await mountVim("a b c");
    await userEvent.keyboard("{Escape}0dw.");
    expect(screen.text()).toBe("c");
  });

  it("keeps formatting through delete and paste", async () => {
    await using screen = await mountVim("**bold** text\nnext");
    await userEvent.keyboard("{Escape}ggddp");
    expect(screen.text()).toBe("next\n**bold** text");
  });

  it("keeps two different chips apart in a register", async () => {
    await using screen = await mountVim("$babysit x");
    await userEvent.keyboard("{Escape}0yl$p");
    expect(screen.text()).toBe("$babysit x$babysit");
  });

  it("keeps real private-use text apart from chips", async () => {
    const glyphs = String.fromCharCode(...Array.from({ length: 64 }, (_, index) => 0xe000 + index));
    await using screen = await mountVim(`$babysit ${glyphs}`);
    await userEvent.keyboard("{Escape}$v0wyA ");
    await userEvent.keyboard("{Escape}p");
    expect(screen.text()).toBe(`$babysit ${glyphs} ${glyphs}`);
    using _readText = vi.spyOn(navigator.clipboard, "readText").mockResolvedValue(glyphs);
    await userEvent.keyboard('"+p');
    await vi.waitFor(() => expect(screen.text()).toBe(`$babysit ${glyphs} ${glyphs}${glyphs}`));
    await userEvent.keyboard(`A${glyphs}{Escape}.`);
    expect(screen.text()).toBe(`$babysit ${glyphs} ${glyphs}${glyphs}${glyphs}${glyphs}`);

    const textarea = document.body.appendChild(document.createElement("textarea"));
    using _textarea = { [Symbol.dispose]: () => textarea.remove() };
    textarea.value = glyphs;
    textarea.focus();
    const host = createTextareaVimHost(textarea);
    using _host = { [Symbol.dispose]: () => host.destroy() };
    for (const key of ["<Esc>", "y", "y", "p"]) host.sendKey(key);
    expect(textarea.value).toBe(`${glyphs}\n${glyphs}`);
  });

  it("does not submit the composer from the search prompt", async () => {
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    await using screen = await mountVim("foo bar", {}, (composer) => (
      <form onSubmit={onSubmit}>{composer}</form>
    ));
    await userEvent.keyboard("{Escape}0/bar");
    await vi.waitFor(() => expect(document.activeElement?.tagName).toBe("INPUT"));
    await userEvent.keyboard("{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.editor.view.dom);
    await userEvent.keyboard("x");
    expect(screen.text()).toBe("foo ar");
  });

  it("keeps a failed search from stranding focus", async () => {
    await using screen = await mountVim("foo");
    await userEvent.keyboard("{Escape}/nothing{Enter}");
    expect(document.activeElement).toBe(screen.editor.view.dom);
  });

  it("deletes across blocks and undoes one operator at a time", async () => {
    await using screen = await mountVim("one\ntwo\nthree");
    await userEvent.keyboard("{Escape}ggdd");
    expect(screen.text()).toBe("two\nthree");
    await userEvent.keyboard("dd");
    expect(screen.text()).toBe("three");
    await userEvent.keyboard("u");
    expect(screen.text()).toBe("two\nthree");
    await userEvent.keyboard("u");
    expect(screen.text()).toBe("one\ntwo\nthree");
  });

  it("stays in normal mode when dd empties the draft", async () => {
    await using screen = await mountVim("one");
    await userEvent.keyboard("{Escape}ddq");
    expect(screen.text()).toBe("");
    await expect.element(screen.getByRole("status")).toHaveTextContent("NORMAL");
  });

  it("pastes lines below and above", async () => {
    await using screen = await mountVim("one\ntwo");
    await userEvent.keyboard("{Escape}ggddp");
    expect(screen.text()).toBe("two\none");
    await userEvent.keyboard("ggyy2P");
    expect(screen.text()).toBe("two\ntwo\ntwo\none");
    await userEvent.keyboard("G2p");
    expect(screen.text()).toBe("two\ntwo\ntwo\none\ntwo\ntwo");
  });

  it("keeps a chip through delete and paste", async () => {
    await using screen = await mountVim("$babysit now");
    await userEvent.keyboard("{Escape}0x");
    expect(screen.text()).toBe(" now");
    await userEvent.keyboard("P");
    expect(screen.text()).toBe("$babysit now");
  });

  it("opens a new list item with o", async () => {
    await using screen = await mountVim("- one");
    await userEvent.keyboard("{Escape}otwo");
    expect(screen.text()).toBe("- one\n- two");
  });

  it("opens a new line inside a code block", async () => {
    await using screen = await mountVim("```\nab\n```\n");
    await focusAt(screen.editor, 3);
    await userEvent.keyboard("{Escape}oz");
    expect(screen.editor.state.doc.firstChild?.textContent).toBe("ab\nz");
  });

  it("lets an open menu claim Escape before normal mode", async () => {
    let menuOpen = true;
    await using screen = await mountVim("hi", {
      onCommandKeyDown: (key) => {
        if (key !== "Escape" || !menuOpen) return false;
        menuOpen = false;
        return true;
      },
    });
    await userEvent.keyboard("{Escape}");
    await userEvent.keyboard("x");
    expect(screen.text()).toBe("hix");
    await userEvent.keyboard("{Escape}");
    await expect.element(screen.getByRole("status")).toHaveTextContent("NORMAL");
  });

  it("passes Enter through in normal mode", async () => {
    const onCommandKeyDown = vi.fn((key: string) => key === "Enter");
    await using screen = await mountVim("hi", { onCommandKeyDown });
    await userEvent.keyboard("{Escape}{Enter}");
    // True keeps the handler's list continuation from editing the prompt.
    expect(onCommandKeyDown).toHaveBeenCalledWith("Enter", expect.anything(), true);
    expect(document.activeElement).toBe(screen.editor.view.dom);
    expect(screen.text()).toBe("hi");
  });

  it("returns to insert when focus leaves, so redirected typing stays text", async () => {
    await using screen = await mountVim("hi");
    await userEvent.keyboard("{Escape}");
    await act(async () => {
      screen.editor.view.dom.blur();
    });
    await focusAt(screen.editor, "end");
    await userEvent.keyboard("dd");
    expect(screen.text()).toBe("hidd");
  });

  it("returns to insert when the draft is cleared from outside", async () => {
    await using screen = await mountVim("hi");
    await userEvent.keyboard("{Escape}");
    await act(async () => {
      screen.editor.commands.clearContent(true);
    });
    await userEvent.keyboard("x");
    expect(screen.text()).toBe("x");
  });

  it("releases normal mode when the setting turns off", async () => {
    await using screen = await mountVim("hi");
    await userEvent.keyboard("{Escape}");
    await screen.rerender(vimComposer("hi", { vimModeEnabled: false }));
    await userEvent.keyboard("{End}x");
    expect(screen.text()).toBe("hix");
  });

  describe("block cursor", () => {
    const blockCursor = (screen: { container: HTMLElement }) =>
      screen.container.querySelector<HTMLElement>("[data-composer-vim-cursor]");

    it("covers the character under the cursor and hides the native caret", async () => {
      await using screen = await mountVim("hello");
      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() => expect(blockCursor(screen)?.textContent).toBe("o"));
      expect(screen.editor.view.dom.classList.contains("caret-transparent")).toBe(true);
      await userEvent.keyboard("i");
      await vi.waitFor(() => expect(blockCursor(screen)).toBeNull());
      expect(screen.editor.view.dom.classList.contains("caret-transparent")).toBe(false);
    });

    it("fills a cell in an empty composer", async () => {
      await using screen = await mountVim("");
      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() => expect(blockCursor(screen)).not.toBeNull());
      const cell = blockCursor(screen)!.getBoundingClientRect();
      expect(cell.width).toBeGreaterThan(0);
      expect(cell.height).toBeGreaterThan(0);
    });

    it("sits on an empty line between two lines", async () => {
      await using screen = await mountVim("a\n\nb");
      await userEvent.keyboard("{Escape}ggj");
      await vi.waitFor(() => expect(blockCursor(screen)).not.toBeNull());
      const { view } = screen.editor;
      const cell = blockCursor(screen)!.getBoundingClientRect();
      const first = view.coordsAtPos(1);
      const last = view.coordsAtPos(view.state.doc.content.size - 1);
      expect(cell.top).toBeGreaterThanOrEqual(first.bottom - 1);
      expect(cell.bottom).toBeLessThanOrEqual(last.top + 1);
    });

    it("does not change the height of an empty line", async () => {
      await using screen = await mountVim("a\n\nb");
      const height = screen.editor.view.dom.getBoundingClientRect().height;
      await userEvent.keyboard("{Escape}ggj");
      await vi.waitFor(() => expect(blockCursor(screen)).not.toBeNull());
      expect(screen.editor.view.dom.getBoundingClientRect().height).toBe(height);
    });
  });
});

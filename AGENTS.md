# kz-editor: notes for agents

Read this file before you work on this mod. Your global rules in `~/.claude/CLAUDE.md` also apply.

## What this mod is

kz-editor is a [Herdr](https://herdr.dev) mod that adds VS Code features to the Herdr window: a file tree, editor tabs, previews and a search. The public repo is `github.com/santikzz/kz-editor` (MIT). The main test machine is Windows 10 with Herdr 0.1.15. macOS and Linux are not tested.

Read these files first:

- `../../AGENTS.md`: the Herdr manual (layouts, keys, mods, commands). Herdr rewrites it on every start.
- `../../herdr.d.ts` and `gpui-kit.d.ts`: the real API. Trust them over memory.
- `RECIPE.md`: how this mod is built. Its "Watch out" section lists the traps that are already known.
- `README.md`: what the user sees.

## Files

| File | Job |
|---|---|
| `main.js` | Picks the part by `props.role`: tree (default), `file`, `menu`, `ask`. An overlay without a role is the search |
| `tree.js` | Side panel tree, git marks, `location()` (the folder to show) |
| `tabs.js` | Shared registry that links each tab to its file, `openFile()` |
| `file.js` | Editor tab: load, save, disk follow, conflicts |
| `binary.js`, `markdown.js` | Image, PDF and Markdown views |
| `menu.js`, `ops.js` | Tree right-click menu, dialogs, file operations |
| `search.js` | Ctrl+E search popup |
| `find.js` | `git ls-files` and `git grep`, `config.json` |
| `match.js` | Ranking and parsing. No Herdr imports. Check: `node match.test.mjs` |
| `lang.js`, `icons.js`, `ui.js` | Grammars, file icons, shared buttons |
| `config.json` | The user's settings. Git ignores it. The defaults are in `find.js` |

Do not edit `gpui-kit.d.ts` or `jsconfig.json`. Herdr writes them.

## How to work here

- For UI work, load the `/impeccable` and `/unslop` skills first. The search, menus and dialogs are an Operate surface: quiet chrome, keyboard first, scannable.
- Use only `theme()` colors. Fixed hex colors are allowed only where a file says why (the GitHub colors in `markdown.js`, the PDF match fills).
- No translucent backgrounds. Spacing on a 4 px grid. Sentence case. Lucide icons in `icons/`, never emoji or Unicode glyphs as icons. Show shortcuts as keycaps.
- Keep the code small and readable. Reuse what the mod already has (`ui.js` buttons, `icons.js`, `tabs.js`) before you write new code. Add no dependencies.
- Keys live only in `~/.config/herdr-app/keys.json`. A mod cannot bind keys itself. The mod commands are `mod.open:kz-editor` (search) and `kz-editor.save` (save). Do not take a plain Ctrl+letter from the shell unless the user asks.
- Settings go in `config.json` in the mod folder. Check the types. A missing file or a bad one must fall back to the defaults and show the error.
- Write all docs in ASD-STE100 Simplified Technical English.

## Check your work

1. Run `herdr-app check ~/.config/herdr-app/mods/kz-editor` after every change. It renders only the tree role.
2. If `match.js` changes, run `node match.test.mjs`.
3. Look at the result in the running app:
   - `herdr-app do mod.open --name kz-editor` opens or closes the search.
   - `herdr-app shot <file.png>` saves the window. Crop it with `magick`.
   - `herdr-app status` lists mod errors.
4. The CLI cannot type or press keys. To show a query, add a temporary line that ends with `// KZTEST` (for example `this.input.set_value("tabs"); this.query = "tabs"; // KZTEST`). Take the screenshot, then remove every `KZTEST` line. Wait for git work to finish before the screenshot.
5. Tell the user what you could not test, such as key presses.

## Known Herdr limits

Do not investigate these again:

- `EditorState` has only `value`, `set_value`, `on` and `release`. It cannot move the cursor, select or scroll to a line. The `__input_*` host calls do not take its handle.
- The editor has no find panel: ctrl+f does nothing. Undo is ctrl+z and redo is ctrl+y. A mod cannot call these native actions: `window.dispatch_action` goes to Herdr's commands.
- `rg` is not on the PATH that `exec` uses. Use `git ls-files` and `git grep`.
- A scroll area in a popup that fits its content gets no height. Give it a height from its rows.
- `.child()` takes one element. An array goes to `.children()`.
- `console.log` does not show in `herdr-app check`. To inspect a value, throw an error that contains it.
- When you save any file in the mod folder, `config.json` too, every copy of the mod loads again.
- Herdr stops a script call (a render, a handler, one step of a task) after about 50 ms with `interrupted`. No `catch` sees it. Split long work and `await cx.sleep(0)` between the parts. Each part gets a new budget.
- QuickJS tries a `^` regex at every position of the string. On a long string, each `exec` is slow. Run regex parsers on short parts.
- `list()` rows take no click handlers.

## When a feature is done

1. Update `README.md`: Features, Keybinds, Settings and Limits, as the change needs. Keep it short.
2. Update `RECIPE.md`: What you see, How it behaves, Built from, Watch out and Done when.
3. Do not commit unless the user asks.
4. End your last message with a suggested commit message. Use the style of the history: lowercase Conventional Commits, no period. For example: `feat: ctrl+e search for files and text`.

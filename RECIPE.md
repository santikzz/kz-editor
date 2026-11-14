# kz-editor

A file tree in the side panel and an editor tab for each file, in the style of VS Code. Click a file to open it in a reusable preview tab, double-click to keep the tab, edit, and save with `ctrl+s`. Markdown files show a preview in the GitHub style, with a switch to the source. Images and PDFs show as pictures. JSON files have a Format button.

![kz-editor](preview.png)

## What you see

- **Side panel tree** (a layout block, any width, best at 280 to 480 px): a 42 px header with "Files" and the root folder name. Rows are 24 px with 12 px indent per level, a chevron for folders, a Material Icon Theme icon, and the name. Git colors on names: added or untracked `ansi2` with a `U`, modified `ansi3` with an `M`, deleted or conflicted `ansi1`. Ignored files are `dim` at 55 % icon opacity. Folders show a 5 px dot in the color of the strongest change inside them. The row of the file in the shown tab uses the `selected` color.
- **File tab** (a tab whose only pane is this mod): a 34 px toolbar with the file icon, the name, the folder relative to the root (`dim`), and, on the right, the actions that apply: "Keep tab" (preview tabs), "Preview" and "Source" (Markdown and SVG), a `dim` size ("800 × 500  ·  2.3 MB" for an image, "12 pages" for a PDF), "Open in default app" (images, PDFs and other binary files), "Format" (JSON), and a solid "Save" button while there are unsaved edits. Under it, Herdr's built-in code editor with line numbers, folding and syntax colors from the theme's ANSI colors.
- **Image** (PNG, JPEG, GIF, WebP, BMP, ICO, TIFF, and SVG in Preview): centered on the `background` color with 24 px padding, at its own pixel size, made smaller to fit the tab, never larger.
- **PDF**: pages one under the other, centered on the `canvas` color, each at most 960 px wide with a 1 px `border` and 16 px between pages, in a scrolling list with a scrollbar. While pages render, the toolbar says "Rendering 3 of 12 pages". Over 50 pages, it says "50 of 60 pages" and the list ends with "Showing the first 50 of 60 pages."
- **Other binary files**: "kz-editor cannot show this file. It shows text files up to 1 MB, images and PDFs."
- **Tab name**: the file name, with "● " in front while there are unsaved edits.
- **Markdown preview**, in the GitHub style: a column of at most 960 px with 32 px padding, centered on the page background (`#0d1117` dark, `#ffffff` light), body text 16 px in Segoe UI (else Noto Sans, Helvetica, Arial). Headings at 32, 24, 20, 16, 14 and 13.6 px, weight 600, with a 1 px rule under h1 and h2. Blocks 16 px apart, 24 px above headings and rules. Rules are 4 px bars. Quotes have a 4 px left bar and muted text. Alerts (`[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]`) have a 4 px bar and an icon and title in the Primer alert color. Code blocks sit on `#151b23` (`#f6f8fa` light) with 6 px corners, 13.6 px code on 20 px lines, Primer token colors, and a Copy button in the top right corner that shows "Copied" for 1.5 s. Images and badges keep their aspect ratio and never grow wider than the column.

## How it behaves

- The tree follows the focused terminal's folder. When a file tab has focus, the tree stays on that file's root. Each root remembers which folders were open.
- Single click on a file: if a tab already shows it, select that tab. Otherwise reuse this space's preview tab, or open a new preview tab. Double-click: the tab is kept, so the next click opens a new tab. Editing a preview tab also keeps it.
- Save with `ctrl+s` (`cmd-s` on macOS) or the Save button. A CRLF file is written back with CRLF.
- Every 2 s the open file is read from disk. With no unsaved edits, the editor follows the disk. With unsaved edits, a bar says "This file changed on disk." with "Load disk version" and "Keep mine".
- Closing a tab with unsaved edits saves them. If the file changed on disk meanwhile, the edits go to `<file>.unsaved` beside it, so nothing is lost.
- Markdown links: `http`, `https` and `mailto` open in the browser. Relative links open the file in kz-editor.
- Read only: files on another machine, and files over 400 KB. Over 1 MB, or binary: a message instead of the editor.
- An image or PDF tab shows the new version when the file changes on disk. "Open in default app" opens the file in the app the system has for its type.
- Git colors refresh on a folder watch (local) and every 10 s.

## Built from

- `main.js`: one `View`, two roles by `props.role`: `tree` (default) and `file`.
- `tree.js`: folder listing (PowerShell `Get-ChildItem` on Windows, `sh` elsewhere, at most 500 entries per folder and 5,000 total), `git status --porcelain=v1 -z --untracked-files=all --ignored` for colors (`all` lists each file in a new folder, so those files are colored too), `watchFolder` for refresh.
- `tabs.js`: the registry in `shared("kz-editor.tabs")`, `{ [tabId]: { path, root, on, space, key, preview } }`. `openFile` runs `tab.new { space, name, mod: "kz-editor", props: { role: "file", file, key, space } }` and records the new tab id at once by comparing the space's tabs before and after. The `key` lets the tab's copy find its entry, also after a restart.
- `file.js`: `EditorState.new({ language, value, readonly, font_family, font_size, syntax })` and `Editor.new`, `readTextFile` and `writeTextFile(path, text, expected)` for conflict-safe saves, `tab.rename` for the "● " marker, `async close()` for the save on close, `on_size_change` for the pane width the preview scales images to, `cx.write_to_clipboard` for Copy.
- `markdown.js`: `lexer` from `vendor/marked.esm.js` (marked 15.0.12, MIT) splits the text into blocks. Paragraphs, lists and tables go to `TextView.markdown`, which draws inline formatting and keeps text selectable; `<kbd>` becomes inline code first. Headings, quotes, alerts, rules, images and code blocks are drawn as elements. HTML blocks keep their images and text, and `align="center"` centers them. A small tokenizer colors code: comments, strings, numbers, keywords, calls, JSON and YAML keys, HTML tags, diff lines.
- Images: local ones are copied, remote ones downloaded with `curl` (it prints the content type, which names the file), into `mods/kz-editor/.cache/`. The size comes from the file: the SVG root tag, or the PNG, GIF, JPEG or WebP header.
- `binary.js`: images and PDFs. An image is copied (`Copy-Item` or `cp`) into `mods/kz-editor/.cache/<hash>-<time>/`, and its size comes from its header (TIFF: tags 256 and 257 of the first directory). A PDF is rendered to `<index>.png` pages 1200 px wide: on Windows by `Windows.Data.Pdf` through PowerShell (WinRT tasks awaited with `AsTask`), elsewhere by `pdfinfo` and `pdftoppm -singlefile -scale-to-x 1200`. Pages render in batches (2, then 12 at a time) and show as each batch is ready. `list` draws only the pages on screen. `watchFolder` on the file's folder loads the file again. Each load writes a new folder and removes the older ones of that file; `close()` removes the last one.
- SVG preview: the editor text is written to `.cache/<hash of the text>.svg` and drawn with `image()`, so unsaved edits show.
- "Open in default app": `exec("explorer", [path])` on Windows, `open` on macOS, `xdg-open` on Linux.
- `lang.js`: file names and code fence languages to the editor grammar names.
- `icons.js`: reads `mods/better-icons/icons.json` (the Better Icons mod). Without it, the tree uses the Lucide icons in `icons/`.
- `keys.json`: `"mod:kz-editor": { "ctrl-s": "kz-editor.save" }`.
- Layout: a block `{ "mod": "kz-editor" }` where the file tree goes, for example the `files` child of the side panel stack.

## Watch out

- Herdr's editor has grammars for javascript, json, python, rust, go, yaml, bash, sql, ruby, java, c, cpp, lua, html, css and markdown. Other languages borrow the closest one: php and typescript use javascript, toml uses yaml, blade and vue use html. Pass an unknown name and the file shows without colors.
- A mod copy cannot learn its own tab id, and a new copy can start before `spaces()` shows its tab. Do not claim "the active tab": the old tab can still be active. Record the tab id in `openFile` and match by `key`.
- `run()` returns null; commands apply right after it returns, so `spaces()` already lists the new tab.
- Writing into the mod folder through a junction or symlink does not hot reload. Keep the real folder in `mods/`.
- `set_value` moves the cursor to the start when the disk version is loaded.
- The JS API of the editor has no cursor, selection or go-to-line control, no LSP and no find-in-files.
- `EditorState.new` throws during render, and a task spawned from render runs inside render until its first wait.
- The editor takes every wheel event over it, even with nothing to scroll, so an editor in the preview stops the page scrolling. Code blocks are drawn as rows of text instead.
- `image()` gives an image no layout size: without `w` and `h` it lays out at zero height and draws over the blocks below it. Always size images.
- The mod `fetch` has only `text()` and `json()`, and `fs.writeFile` writes nothing for binary data. Download with `curl`, and copy and move files with the OS (`Copy-Item`, `Move-Item`, `cp`, `mv`).
- `readTextFile` throws on a file that is not UTF-8 text, so most binary files never reach a `\0` check. Pick the viewer by extension before reading.
- `watchFolder` gives Windows paths with the `\\?\` prefix. Strip it before comparing.
- `cx.open_url` does nothing with a file path. Start the system opener with `exec`.
- PowerShell joins the arguments after `-Command` with spaces, so a path with a space splits. Put values inside the command as single-quoted literals, with `'` (and the typographic single quotes) doubled.
- Herdr keeps an image it drew by its path. Write a changed file to a new path.
- A PDF page decoded at 1200 px takes about 7 MB, so only 50 pages show.
- Herdr draws images only from inside its own folder. A hidden folder there (`.cache`) does not reload the mod when files change.

## Done when

- `herdr-app check mods/kz-editor` passes.
- A click on a file in the tree opens a tab named after it. A second click on another file reuses that tab. A double-click keeps the tab.
- Typing shows "● " on the tab name and a Save button. `ctrl+s` writes the file and removes both.
- A CRLF file stays CRLF after a save.
- A Markdown file opens in Preview, and Source shows the editor. A relative link opens the linked file.
- A README with a centered HTML logo, shields.io badges, alerts, a table, a fenced code block and a large screenshot renders all of them, and the page scrolls to its last line with the pointer over any block.
- Format on a one-line JSON file indents it with 2 spaces.
- A PNG, JPEG, BMP, ICO and TIFF each show at their own size, with the size in the toolbar. A 1620 px screenshot is made smaller to fit. A path with a space, an apostrophe and `ü` works.
- A 10-page PDF shows all 10 pages. A 60-page PDF shows "Rendering … of 60 pages", then "50 of 60 pages".
- Writing a new image over an open one shows the new image within 2 s.
- Closing an image or PDF tab removes its folder in `.cache`.
- "Open in default app" on a TIFF opens the system's photo viewer.
- An outside change to an open, unedited file shows within 2 s. With unsaved edits, the "changed on disk" bar shows.

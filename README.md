# kz-editor

Open files from the [Herdr](https://herdr.dev) side panel in their own tabs, next to your terminals and agents. Edit them and save with <kbd>Ctrl</kbd> <kbd>S</kbd>. When an agent changes a file that you have open, the tab follows the disk. When you have unsaved edits, kz-editor asks before it replaces anything.

![kz-editor in Herdr: a file tree with git marks on the right and invoices.js open in an editor tab](preview.png)

## What you get

- **A file tree** for the folder of the focused terminal. Files show git marks: `M` for modified, `U` for new, and dimmed names for ignored files.
- **A right-click menu** in the tree: open in the default app, Open with (Windows), reveal in File Explorer or Finder, open a terminal there, new file, new folder, cut, copy, paste, copy path, copy relative path, rename and delete. Delete moves the item to the Recycle Bin or the Trash.
- **A tab for each file.** A click opens the file in a preview tab, and the next click reuses that tab. A double-click or an edit keeps the tab.
- **An editor** with syntax colors, line numbers, folding, undo and multiple cursors.
- **Markdown** opens as a preview in the GitHub style: its fonts, sizes and colors, images and badges, alerts, task lists, tables, and code blocks with colors and a Copy button. Switch to Source to edit it. Relative links open the linked file.
- **Images** open at their own size, made smaller to fit the tab: PNG, JPEG, GIF, WebP, BMP, ICO and TIFF. Zoom with <kbd>Ctrl</kbd> and the mouse wheel or the toolbar, drag to move a zoomed image, and double-click to switch between Fit and 100 %. SVG files have Preview, which zooms the same way, and Source.
- **PDFs** show their pages one under the other. Zoom like an image, go to a page with the page box or <kbd>Page Up</kbd> and <kbd>Page Down</kbd>, and find text with <kbd>Ctrl</kbd> <kbd>F</kbd>.
- **A changed image or PDF** shows the new version when the file changes on disk.
- **Other binary files** have an **Open in default app** button.
- **JSON** has a Format button that keeps the indent of the file.
- **Line endings stay the same.** A file with CRLF line endings is saved with CRLF.

## Safe next to agents

Agents edit the files that you have open. kz-editor reads the open file from disk every 2 seconds and acts on what it finds.

| Your tab | The file on disk | What kz-editor does |
|---|---|---|
| No unsaved edits | Changes | Loads the new version |
| Unsaved edits | Changes | Shows a bar with **Load disk version** and **Keep mine** |
| Unsaved edits | You close the tab | Saves your edits. If the disk version changed, it writes them to `<file>.unsaved` |

A save never writes over a version that kz-editor has not seen.

## Install

1. Clone the repo into the Herdr mods folder:

   ```sh
   git clone https://github.com/santikzz/kz-editor ~/.config/herdr-app/mods/kz-editor
   ```

2. Put the tree in your layout. The layouts that come with Herdr are read-only, so make a copy first:

   ```sh
   herdr-app do layout.clone '{"name":"main","as":"my-main"}'
   ```

   In `~/.config/herdr-app/layouts/my-main.json`, change the Files panel block from `"mod": "files"` to `"mod": "kz-editor"`.

3. Add the save key to `~/.config/herdr-app/keys.json`:

   ```json
   "mod:kz-editor": { "ctrl-s": "kz-editor.save" }
   ```

4. Check the mod:

   ```sh
   herdr-app check ~/.config/herdr-app/mods/kz-editor
   ```

If the Better Icons mod is installed, the tree uses its Material file icons. Without it, the tree uses plain Lucide icons.

Tested on Windows 10 with Herdr 0.1.15. On macOS and Linux the tree lists folders with `sh`. That path is not tested yet.

## Keys

| Key | Action |
|---|---|
| Click a file | Open it in the preview tab |
| Double-click a file | Open it and keep the tab |
| <kbd>Ctrl</kbd> <kbd>S</kbd> | Save. On macOS, <kbd>Cmd</kbd> <kbd>S</kbd> |
| Right-click in the tree | Open the file menu |
| <kbd>Ctrl</kbd> + mouse wheel | Zoom an image or a PDF |
| <kbd>Ctrl</kbd> <kbd>F</kbd> | Find text in a PDF. <kbd>Enter</kbd> goes to the next match, <kbd>Shift</kbd> <kbd>Enter</kbd> to the one before |
| <kbd>Page Up</kbd> <kbd>Page Down</kbd> <kbd>Home</kbd> <kbd>End</kbd> | Go to a page of a PDF |

## Syntax colors

The Herdr editor has grammars for 15 languages: JavaScript, JSON, Python, Rust, Go, YAML, Bash, SQL, Ruby, Java, C, C++, Lua, HTML and CSS. Some other file types use the nearest grammar:

| Files | Colored as |
|---|---|
| `.ts` `.tsx` `.php` | JavaScript |
| `.blade.php` `.vue` `.svelte` `.xml` `.svg` | HTML |
| `.scss` `.less` | CSS |
| `.toml` | YAML |
| `.cs` `.kt` `.scala` | Java |
| `Dockerfile` `.env` | Bash |

All other files open without colors.

## Limits

- No IntelliSense, go to definition or search across files. Herdr does not give mods these parts of its editor.
- Files over 400 KB open read-only. Files over 1 MB and binary files other than images and PDFs do not open in the editor.
- Files on other machines open read-only.
- The tree shows at most 500 entries in a folder and 5,000 in total.
- When the disk version loads, the cursor moves to the first line.
- The Markdown preview shows Mermaid diagrams and math as code. Remote images need `curl`, which Windows 10, macOS and Linux include.
- A PDF shows its first 50 pages. On Windows, Windows renders the pages. On macOS and Linux, install `pdftoppm`, `pdfinfo` and `pdftotext` (poppler).
- PDF find on Windows reads the text with the Windows text recognition, so it also finds text in scanned pages, but it can miss a word that it reads wrong. It does not find text that continues on the next line. Pages are sharp up to about 150 %.
- The tree menu acts on one item at a time. Cut, copy and paste use the clipboard of kz-editor, not the system clipboard. On another machine, Delete removes the item for good. On Linux, Delete needs `gio`.
- Images and PDFs on other machines do not open. Audio and video files open only in their default app.

## How it works

[RECIPE.md](RECIPE.md) describes how the mod is built, in the Herdr format for shared mods. In short: one mod has two roles. In the side panel it draws the tree. In a tab it draws the editor. A shared registry links each file to its tab.

## License

[MIT](LICENSE). The Markdown parser is [marked](https://marked.js.org), in `vendor/` under its [MIT license](vendor/marked.LICENSE.md). The icons in `icons/` come from [Lucide](https://lucide.dev) under the [ISC license](icons/LICENSE-lucide.txt).

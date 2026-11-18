// A file in its own tab: an editor for code, Preview or Source for Markdown and SVG, Format
// for JSON, and a picture for images and PDFs (binary.js).
// Edits are saved with ctrl+s. A file changed on disk follows along while nothing is unsaved;
// with unsaved edits it asks first, so nobody's work is overwritten.
// An untitled tab (ctrl+n) has no file: ctrl+s asks for one, and its text goes when it closes.
import { div, image, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, InputState, VirtualListScrollHandle } from "gpui-base";
import { appHome, exec, home, nextCommand, openOverlay, readTextFile, run, settings, theme, writeTextFile } from "herdr";
import { activeSpace, activeTab, baseName, entries, isFileTab, openFile, setEntry, spaceTabs, takeOpening } from "./tabs.js";
import { iconFor, isLight, loadIcons } from "./icons.js";
import { extOf, languageOf } from "./lang.js";
import { Binary, cacheSvg, viewerOf } from "./binary.js";
import { buildMarkdown, imageSources, loadImage, parentOf, renderMarkdown, resolve } from "./markdown.js";
import { openOutside, platform } from "./ops.js";
import { button } from "./ui.js";
import { location, normalize } from "./tree.js";

const EDITABLE = 400000;
const DISK_MS = 2000;
const CLAIM_MS = 500;

// writeTextFile writes only here. A file on another machine goes through a temp file here
// and `hc file write --on`, which takes the text on stdin. Local Windows has no sh for that.
const writable = (on) => !on || platform() !== "windows";

async function write(file, text, expected) {
  if (!file.on) return writeTextFile(file.path, text, expected);
  // ponytail: read then write, so a change in the gap is lost; use a compare-and-write in hc if it gets one
  const current = await readTextFile(file.path, { on: file.on });
  if (current !== expected) throw new Error("The file changed on disk.");
  const dir = `${normalize(appHome())}/mods/kz-editor/.cache`;
  const tmp = `${dir}/save-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await exec("mkdir", ["-p", dir]);
  await writeTextFile(tmp, text, null);
  const script = 'hc file write --on "$1" "$2" < "$3" > /dev/null; c=$?; rm -f -- "$3"; exit $c';
  const r = await exec("sh", ["-c", script, "kz-editor", file.on, file.path, tmp]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || "Could not write on the other machine.");
}

const syntax = (t) => ({
  keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1,
  constant: t.ansi6, boolean: t.ansi6, "string.escape": t.ansi6,
});

export class FileTab {
  constructor(p) {
    this.file = p.file ?? null;
    this.untitled = !this.file && Boolean(p.untitled);
    this.key = p.key ?? null;
    this.images = new Map();
    this.space = p.space ?? activeSpace()?.id;
  }

  init(cx) {
    this.mode = "preview";
    this.viewer(cx);
    cx.spawn(async (cx) => {
      this.icons = await loadIcons();
      cx.notify();
    });
    if (this.file) this.load(cx);
    else if (this.untitled) this.show("");
    this.claim(cx);
    cx.timer.every(CLAIM_MS, (cx) => this.claim(cx));
    cx.timer.every(DISK_MS, (cx) => this.followDisk(cx));
    cx.spawn(async (cx) => {
      for (;;) if ((await nextCommand()) === "save") this.save(cx);
    });
  }

  // The image and PDF viewer's focus, scroll and inputs live as long as the tab: each file
  // shown gets a new Binary, and retained state can only be made here.
  viewer(cx) {
    this.ui = { focus: cx.focus_handle(), list: VirtualListScrollHandle.new(), find: InputState.new({ placeholder: "Find in PDF" }), page: InputState.new({}) };
    this.ui.find.on("change", (_e, cx) => this.binary?.search(cx));
    this.ui.find.on("submit", (e, cx) => this.binary?.step(e.shift ? -1 : 1, cx));
    this.ui.page.on("submit", (_e, cx) => {
      this.binary?.goToPage(Number(this.ui.page.value()) - 1, cx);
      this.ui.focus.focus();
    });
    this.ui.page.on("focus", () => (this.ui.pageFocused = true));
    this.ui.page.on("blur", (_e, cx) => {
      this.ui.pageFocused = false;
      this.binary?.sync(cx);
    });
    cx.timer.every(250, (cx) => this.binary?.sync(cx));
  }

  // Finds this copy's tab by the key the tree gave it. Without one (the tree did not see
  // the new tab yet), it takes the one file tab in its space that nobody has claimed.
  // The registry knows the file better than props: a preview tab may have moved on.
  claim(cx) {
    const all = entries();
    if (this.tab) {
      if (this.file && !all[this.tab]) setEntry(this.tab, { ...this.file, space: this.space, key: this.key, preview: false });
      return;
    }
    if (!this.file) return;
    const mine = (id) =>
      this.key ? all[id].key === this.key : !all[id].key && all[id].path === this.file.path && all[id].space === this.space;
    let tab = Object.keys(all).find(mine);
    if (!tab) {
      const name = baseName(this.file.path);
      tab = spaceTabs(this.space).find((t) => isFileTab(t.id) && !all[t.id] && t.name.replace(/^● /, "") === name)?.id;
      if (!tab) return;
      const asked = takeOpening(this.file.path);
      setEntry(tab, { ...this.file, space: this.space, key: this.key, preview: !asked?.keep });
    }
    this.tab = tab;
    this.follow(entries()[tab], cx);
    this.updateTitle();
  }

  // A renamed or moved file keeps its unsaved edits; anything else loads.
  follow(entry, cx) {
    if (!entry || entry.path === this.file?.path) return;
    this.file = { path: entry.path, root: entry.root, on: entry.on ?? null };
    if (this.dirty) return this.updateTitle();
    this.load(cx);
  }

  get name() {
    return this.file ? baseName(this.file.path) : "Untitled";
  }

  get isMarkdown() {
    return ["md", "markdown"].includes(extOf(this.file?.path ?? ""));
  }

  get isSvg() {
    return extOf(this.file?.path ?? "") === "svg";
  }

  get isJson() {
    return extOf(this.file?.path ?? "") === "json";
  }

  // Read from the editor every time, so no missed event can lose an edit.
  get dirty() {
    return Boolean(this.code) && this.editable && this.code.value() !== this.baseline;
  }

  load(cx) {
    const file = this.file;
    this.binary?.close();
    this.binary = null;
    this.unreadable = false;
    this.svg = null;
    this.svgText = null;
    this.code?.release();
    this.code = null;
    this.markdown = null;
    this.markdownKey = null;
    this.images = new Map();
    this.problem = null;
    this.notice = null;
    this.conflict = false;
    this.mode = "preview";
    const kind = viewerOf(file.path);
    if (kind) {
      this.binary = new Binary(file, kind, this.ui);
      this.binary.start(cx);
      return this.updateTitle();
    }
    cx.spawn(async (cx) => {
      let text;
      try {
        text = await readTextFile(file.path, { on: file.on });
      } catch {
        text = undefined;
      }
      if (this.file !== file) return;
      this.unreadable = text === undefined || Boolean(text?.includes("\0"));
      if (text === null) this.problem = "This file is no longer there.";
      else if (this.unreadable) this.problem = "kz-editor cannot show this file. It shows text files up to 1 MB, images and PDFs.";
      else this.show(text);
      this.updateTitle();
      cx.notify();
    });
  }

  show(text) {
    const t = theme();
    this.eol = text.includes("\r\n") ? "\r\n" : "\n";
    this.saved = text;
    this.editable = writable(this.file?.on) && text.length <= EDITABLE;
    this.code = EditorState.new({
      language: languageOf(this.name),
      value: this.editable ? text : text.slice(0, EDITABLE),
      readonly: !this.editable,
      font_family: settings().font_family,
      font_size: Number(settings().font_size) || 13,
      syntax: syntax(t),
    });
    this.baseline = this.code.value();
    this.code.on("change", (_e, cx) => this.changed(cx));
  }

  // An edited tab is kept, as in VS Code: the next click opens another tab.
  changed(cx) {
    this.notice = null;
    if (this.dirty && entries()[this.tab]?.preview) setEntry(this.tab, { preview: false });
    this.updateTitle();
    cx.notify();
  }

  updateTitle() {
    if (!this.tab || !this.file) return;
    const name = `${this.dirty ? "● " : ""}${baseName(this.file.path)}`;
    if (name === this.title) return;
    this.title = name;
    run("tab.rename", { id: this.tab, name });
  }

  // The editor may hand back plain newlines; a CRLF file is written back as CRLF.
  output() {
    const value = this.code.value();
    return this.eol === "\r\n" ? value.replace(/\r?\n/g, "\r\n") : value;
  }

  save(cx) {
    if (!this.dirty || this.saving) return;
    if (this.untitled) return this.saveAs();
    const file = this.file;
    const value = this.code.value();
    const text = this.output();
    const expected = this.saved;
    this.saving = true;
    this.notice = null;
    this.conflict = false;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await write(file, text, expected);
        if (this.file === file) {
          this.saved = text;
          this.baseline = value;
        }
      } catch (e) {
        const current = await readTextFile(file.path, { on: file.on }).catch(() => null);
        if (this.file === file) {
          if (current !== expected) this.conflict = true;
          else this.notice = `Could not save: ${e?.message ?? e}`;
        }
      } finally {
        this.saving = false;
        this.updateTitle();
        cx.notify();
      }
    });
  }

  // Only the shown tab gets the save command, so the active tab is this one. The dialog writes
  // the file, opens it in a kept tab and closes this one. writeTextFile writes only here.
  saveAs() {
    const tab = activeTab();
    if (!isFileTab(tab) || entries()[tab]) return;
    const { cwd, on } = location();
    const dir = !on && cwd ? cwd : normalize(home());
    openOverlay({
      mod: "kz-editor",
      kind: "dialog",
      width: 420,
      height: 196,
      props: { role: "ask", action: "save-as", target: { path: dir, dir: true, root: dir, on: null }, text: this.code.value(), tab },
    });
  }

  // Keep what is on screen and write it over the disk version.
  overwrite(cx) {
    const file = this.file;
    cx.spawn(async (cx) => {
      const current = await readTextFile(file.path, { on: file.on }).catch(() => null);
      if (this.file !== file) return;
      this.saved = current;
      this.conflict = false;
      this.save(cx);
      cx.notify();
    });
  }

  followDisk(cx) {
    const file = this.file;
    if (!file || !this.code || this.saving || this.reading) return;
    this.reading = true;
    cx.spawn(async (cx) => {
      const text = await readTextFile(file.path, { on: file.on }).catch(() => undefined);
      this.reading = false;
      if (this.file !== file || !this.code || text === undefined || text === this.saved) return;
      if (text === null) this.notice = "This file was deleted on disk. Save to write it again.";
      else if (this.dirty) this.conflict = true;
      else if (text.length > EDITABLE || text.includes("\0")) return this.load(cx);
      else {
        this.saved = text;
        this.eol = text.includes("\r\n") ? "\r\n" : "\n";
        this.code.set_value(text);
        this.baseline = this.code.value();
      }
      cx.notify();
    });
  }

  // Keeps the original indent and the final newline. Invalid JSON changes nothing.
  format(cx) {
    const text = this.code.value();
    try {
      const indent = /\n(\t| +)"/.exec(text)?.[1] ?? 2;
      this.code.set_value(JSON.stringify(JSON.parse(text), null, indent) + (text.endsWith("\n") ? "\n" : ""));
    } catch (e) {
      this.notice = `Invalid JSON: ${e?.message ?? e}`;
      return cx.notify();
    }
    this.changed(cx);
  }

  followLink(url, cx) {
    if (/^(https?|mailto):/i.test(url)) return cx.open_url(url);
    const path = resolve(parentOf(this.file.path), url);
    if (path && path !== this.file.path) openFile({ path, root: this.file.root, on: this.file.on ?? null });
  }

  // A closing tab cannot ask, so unsaved edits are written: over the file when it has not
  // changed on disk, else beside it as <name>.unsaved so nothing is lost. Untitled text is scratch.
  async close() {
    if (this.binary) return this.binary.close();
    if (!this.dirty || this.untitled) return;
    const text = this.output();
    try {
      await write(this.file, text, this.saved);
    } catch {
      await write({ ...this.file, path: `${this.file.path}.unsaved` }, text, null).catch(() => {});
    }
  }

  toggle(id, label, active, t, onClick) {
    return button(id, label, t, onClick).when(active, (el) => el.bg(t.selected).text_color(t.foreground));
  }

  bar(text, t, actions) {
    return h_flex()
      .min_h(34)
      .flex_none()
      .px(12)
      .py(4)
      .gap(6)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .bg(t.surface)
      .child(div().flex_1().min_w(0).text_size(12).child(text))
      .children(actions);
  }

  toolbar(t, entry) {
    const name = this.name;
    const folder = this.file ? this.file.path.slice(this.file.root.length + 1, -name.length - 1) : "";
    const icon = iconFor(this.icons, name, { light: isLight(t.background) });
    const readOnly = this.code && !this.editable ? (this.file.on ? "Read only: other machine" : "Read only: too large") : null;
    const info = this.binary?.info();
    const openable = !this.file?.on && (Boolean(this.binary) || this.unreadable);
    return h_flex()
      .h(34)
      .flex_none()
      .px(12)
      .gap(8)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .text_size(12)
      .child(icon ? image(icon).size(16).flex_none() : svg("mods/kz-editor/icons/file.svg").size(14).flex_none().text_color(t.muted))
      .child(div().flex_none().font_medium().child(name))
      .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(folder))
      .when(Boolean(readOnly), (el) => el.child(div().flex_none().text_color(t.dim).child(readOnly)))
      .when(Boolean(info), (el) => el.child(div().flex_none().text_color(t.dim).child(info)))
      .children((this.binary ?? (this.isSvg && this.mode === "preview" ? this.svg : null))?.controls(t) ?? [])
      .when(Boolean(entry?.preview), (el) =>
        el.child(button("kz-keep", "Keep tab", t, (cx) => {
          setEntry(this.tab, { preview: false });
          cx.notify();
        })),
      )
      .when((this.isMarkdown || this.isSvg) && Boolean(this.code), (el) =>
        el.child(
          h_flex()
            .gap(2)
            .child(this.toggle("kz-md-preview", "Preview", this.mode === "preview", t, (cx) => ((this.mode = "preview"), cx.notify())))
            .child(this.toggle("kz-md-source", "Source", this.mode !== "preview", t, (cx) => ((this.mode = "source"), cx.notify()))),
        ),
      )
      .when(openable, (el) => el.child(button("kz-open", "Open in default app", t, () => openOutside(this.file.path))))
      .when(this.isJson && this.editable, (el) => el.child(button("kz-format", "Format", t, (cx) => this.format(cx))))
      .when(this.dirty, (el) => el.child(button("kz-save", this.saving ? "Saving…" : "Save", t, (cx) => this.save(cx), true)));
  }

  // Parsed again only when the text or the appearance changes.
  preview(t, cx) {
    const light = isLight(t.background);
    const text = this.code.value();
    const key = `${light}\0${text}`;
    // Herdr stops a render that runs too long, and a long file takes longer to parse,
    // so it parses in a timer. The last preview stays until the next is ready.
    if (this.markdownKey !== key) {
      this.markdownKey = key;
      cx.timer.after(0, (cx) => {
        if (this.markdownKey !== key) return;
        try {
          this.markdown = buildMarkdown(text, light);
          this.markdownError = null;
          this.loadImages(cx);
        } catch (e) {
          this.markdownError = `This file cannot be previewed: ${e?.message ?? e}`;
        }
        cx.notify();
      });
    }
    if (this.markdownError) return div().p(16).text_color(t.dim).child(this.markdownError);
    if (!this.markdown) return div().p(16).text_color(t.dim).child("Loading…");
    const actions = {
      onLink: (url, cx) => this.followLink(url, cx),
      onCopy: (index, code, cx) => this.copyCode(index, code, cx),
      copied: this.copied,
    };
    return renderMarkdown(this.markdown, this.images, actions, this.width);
  }

  // Drawn from the editor text, so unsaved edits show. The last picture stays until the next is ready.
  svgPreview(t, cx) {
    const text = this.code.value();
    if (this.svgText !== text) {
      this.svgText = text;
      cx.spawn(async (cx) => {
        const picture = await cacheSvg(text).catch(() => null);
        if (this.svgText !== text || !picture) return;
        // One viewer per file, so the zoom stays while the text changes.
        this.svg ??= new Binary(this.file, "image", this.ui);
        this.svg.picture = picture;
        cx.notify();
      });
    }
    if (!this.svg) return div().p(16).text_color(t.dim).child("Loading…");
    return this.svg.view(t, this.box());
  }

  box() {
    return { width: this.width ?? 800, height: (this.height ?? 600) - 34 };
  }

  loadImages(cx) {
    const file = this.file;
    for (const src of imageSources(this.markdown)) {
      if (this.images.has(src)) continue;
      this.images.set(src, undefined);
      cx.spawn(async (cx) => {
        const loaded = await loadImage(src, parentOf(file.path), file.on).catch(() => null);
        if (this.file !== file) return;
        this.images.set(src, loaded);
        cx.notify();
      });
    }
  }

  copyCode(index, code, cx) {
    cx.write_to_clipboard(code);
    this.copied = index;
    cx.timer.after(1500, (cx) => {
      if (this.copied === index) this.copied = null;
      cx.notify();
    });
    cx.notify();
  }

  editor() {
    return v_flex()
      .id("kz-editor")
      .flex_1()
      .min_h(0)
      .on_key_down((event, cx) => {
        if (event.keystroke !== "cmd-s") return;
        cx.stop_propagation();
        this.save(cx);
      })
      .child(Editor.new(this.code).flex_1().min_h(0));
  }

  render(cx) {
    const entry = this.tab ? entries()[this.tab] : null;
    if (entry && entry.path !== this.file?.path) this.follow(entry, cx);
    const t = theme();
    const message = (text) => div().p(16).text_color(t.dim).child(text);
    const root = v_flex()
      .id("kz-file")
      .size_full()
      .min_h(0)
      .min_w(0)
      .bg(t.background)
      .text_color(t.foreground)
      .text_size(13)
      .on_size_change((size, cx) => {
        if (size.width === this.width && size.height === this.height) return;
        this.width = size.width;
        this.height = size.height;
        cx.notify();
      });
    if (!this.file && !this.untitled) return root.child(message("No file."));

    root
      .child(this.toolbar(t, entry))
      .when(this.conflict, (el) =>
        el.child(
          this.bar("This file changed on disk.", t, [
            button("kz-load-disk", "Load disk version", t, (cx) => this.load(cx)),
            button("kz-keep-mine", "Keep mine", t, (cx) => this.overwrite(cx), true),
          ]),
        ),
      )
      .when(Boolean(this.notice), (el) => el.child(this.bar(this.notice, t, [])));

    if (this.binary) return root.child(this.binary.view(t, this.box()));
    if (this.problem) return root.child(message(this.problem));
    if (!this.code) return root.child(message("Loading…"));
    if (this.isMarkdown && this.mode === "preview") return root.child(this.preview(t, cx));
    if (this.isSvg && this.mode === "preview") return root.child(this.svgPreview(t, cx));
    return root.child(this.editor());
  }
}

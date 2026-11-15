// The spotlight, like VS Code's Quick Open with its text search: Ctrl+E ("mod.open:kz-editor"
// in keys.json) finds files by name or path in the tree's folder, and lines of text in them.
// With nothing typed it lists the files open in this space.
import { div, image } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, ScrollHandle } from "gpui-base";
import { closeOverlay, props, settings, theme } from "herdr";
import { activeSpace, entries, isFileTab, openFile, spaceTabs } from "./tabs.js";
import { iconFor, isLight, loadIcons } from "./icons.js";
import { location } from "./tree.js";
import { grepText, listFiles, readConfig } from "./find.js";
import { rankFiles, snippet } from "./match.js";
import { icon } from "./ui.js";

const FILE_LIMIT = 12;
const TEXT_LIMIT = 200;
const TEXT_MIN = 2;
const TEXT_DELAY_MS = 150;
const LIST_HEIGHT = 432;
const PICKABLE = new Set(["file", "open", "line"]);
const HEIGHT = { head: 28, file: 32, open: 32, group: 32, line: 28 };

const count = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const plural = (n, word) => `${count(n)} ${word}${n === 1 ? "" : "s"}`;

// Text with some characters in the hit color, as one run per stretch.
function marked(text, hits, color, hit) {
  const on = new Set(hits);
  const runs = [];
  for (let i = 0; i < text.length; i++) {
    if (runs.at(-1)?.on === on.has(i)) runs.at(-1).text += text[i];
    else runs.push({ on: on.has(i), text: text[i] });
  }
  return runs.map((r) => div().flex_none().text_color(r.on ? hit : color).when(r.on, (el) => el.font_semibold()).child(r.text));
}

function group(found, query) {
  const files = new Map();
  for (const match of found.slice(0, TEXT_LIMIT)) {
    if (!files.has(match.path)) files.set(match.path, []);
    files.get(match.path).push(match);
  }
  return { query, files: [...files], lines: Math.min(found.length, TEXT_LIMIT), capped: found.length > TEXT_LIMIT };
}

export class Search {
  init(cx) {
    const { cwd, on } = location();
    this.on = on;
    this.root = cwd;
    this.query = "";
    this.at = 0;
    this.files = [];
    this.found = { items: [], total: 0 };
    this.text = null;
    this.textToken = 0;
    this.listing = Boolean(cwd);
    this.handle = cx.focus_handle();
    this.scroll = ScrollHandle.new();
    this.input = InputState.new({ placeholder: "Search files by name or text" });
    this.input.on("change", (_e, cx) => this.change(cx));
    this.input.on("submit", () => this.open(this.pickable()[this.at]));
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    cx.spawn(async (cx) => {
      this.icons = await loadIcons();
      cx.notify();
    });
    cx.spawn(async (cx) => this.list(cx));
  }

  async list(cx) {
    this.config = await readConfig();
    if (!this.root) return cx.notify();
    try {
      const listed = await listFiles(this.root, this.on, this.config);
      this.files = listed.files.map((path) => ({ path, lower: path.toLowerCase() }));
      this.scopes = listed.scopes;
      this.capped = listed.capped;
    } catch (e) {
      this.listError = String(e?.message ?? e);
    }
    this.listing = false;
    this.rank();
    this.searchText(cx);
    cx.notify();
  }

  change(cx) {
    this.query = this.input.value();
    this.at = 0;
    this.rank();
    this.searchText(cx);
    this.scroll.scroll_to_item(0);
    cx.notify();
  }

  rank() {
    this.found = rankFiles(this.files, this.query, FILE_LIMIT);
  }

  // Waits for a pause in typing. The last results stay until the new ones are ready.
  searchText(cx) {
    const query = this.query.trim();
    const token = ++this.textToken;
    if (query.length < TEXT_MIN || !this.scopes) {
      this.text = null;
      this.textBusy = false;
      this.textError = null;
      return;
    }
    this.textBusy = true;
    cx.timer.after(TEXT_DELAY_MS, (cx) => {
      if (token !== this.textToken) return;
      cx.spawn(async (cx) => {
        let found = null;
        let problem = null;
        try {
          found = await grepText(this.scopes, query, this.config);
        } catch (e) {
          problem = String(e?.message ?? e);
        }
        if (token !== this.textToken) return;
        this.textBusy = false;
        this.textError = problem;
        this.text = found ? group(found, query) : null;
        cx.notify();
      });
    });
  }

  openTabs() {
    const all = entries();
    return spaceTabs(activeSpace()?.id)
      .filter((tab) => all[tab.id] && isFileTab(tab.id))
      .map((tab) => ({ kind: "open", file: all[tab.id], path: all[tab.id].path.slice(all[tab.id].root.length + 1), hits: [] }));
  }

  rows() {
    if (!this.query.trim()) {
      const open = this.openTabs();
      return open.length ? [{ kind: "head", label: "Open", note: count(open.length) }, ...open] : [];
    }
    const out = [];
    const { items, total } = this.found;
    if (items.length)
      out.push({ kind: "head", label: "Files", note: total > items.length ? `${items.length} of ${count(total)}` : count(total) }, ...items.map((f) => ({ kind: "file", ...f })));
    if (this.text?.files.length) {
      const lines = this.text.capped ? `${TEXT_LIMIT}+ lines` : plural(this.text.lines, "line");
      out.push({ kind: "head", label: "Text", note: `${lines} in ${plural(this.text.files.length, "file")}` });
      for (const [path, matches] of this.text.files) {
        out.push({ kind: "group", path, note: count(matches.length) });
        for (const m of matches) out.push({ kind: "line", ...m });
      }
    }
    return out;
  }

  pickable() {
    return this.rows().filter((r) => PICKABLE.has(r.kind));
  }

  // VS Code opens files from Quick Open as kept tabs, not preview tabs.
  open(row) {
    if (!row) return;
    openFile(row.kind === "open" ? row.file : { path: `${this.root}/${row.path}`, root: this.root, on: this.on }, true);
    closeOverlay(props()?.overlay);
  }

  key(e, rows, pickable, cx) {
    if (!pickable.length) return;
    if (e.key === "down") this.at = (this.at + 1) % pickable.length;
    else if (e.key === "up") this.at = (this.at + pickable.length - 1) % pickable.length;
    else if (e.key === "enter") return this.open(pickable[this.at]);
    else return;
    cx.stop_propagation();
    const i = rows.indexOf(pickable[this.at]);
    this.scroll.scroll_to_item(this.at === 0 ? 0 : i);
    cx.notify();
  }

  fileIcon(name, t) {
    const path = iconFor(this.icons, name, { light: isLight(t.background) });
    return path ? image(path).size(16).flex_none() : icon("file", t.muted, 16);
  }

  row(id, selected, t) {
    return h_flex()
      .id(id)
      .flex_none()
      .px(12)
      .gap(8)
      .items_center()
      .rounded(6)
      .cursor_pointer()
      .when(selected, (el) => el.bg(t.selected))
      .when(!selected, (el) => el.hover((s) => s.bg(t.hover)));
  }

  // The name with its hits, then its folder, which shows hits too when the query named it.
  fileRow(r, i, selected, t) {
    const start = r.path.lastIndexOf("/") + 1;
    const name = r.path.slice(start);
    const folder = start ? r.path.slice(0, start - 1) : "";
    const nameHits = r.hits.filter((h) => h >= start).map((h) => h - start);
    const folderHits = r.hits.filter((h) => h < start - 1);
    return this.row(`kz-s-${i}`, selected, t)
      .h(32)
      .on_click(() => this.open(r))
      .child(this.fileIcon(name, t))
      .child(h_flex().flex_none().children(marked(name, nameHits, t.foreground, t.accent)))
      .child(
        folderHits.length
          ? h_flex().flex_1().min_w(0).overflow_hidden().text_size(12).children(marked(folder, folderHits, t.muted, t.foreground))
          : div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(folder),
      );
  }

  groupRow(r, t) {
    const start = r.path.lastIndexOf("/") + 1;
    return h_flex()
      .h(28)
      .flex_none()
      .mt(4)
      .px(12)
      .gap(8)
      .items_center()
      .child(this.fileIcon(r.path.slice(start), t))
      .child(div().flex_none().font_medium().text_color(t.foreground).child(r.path.slice(start)))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(start ? r.path.slice(0, start - 1) : ""))
      .child(div().flex_none().text_size(12).text_color(t.dim).child(r.note));
  }

  // Lines sit under their file's name: 12 px padding, a 16 px icon, an 8 px gap.
  lineRow(r, i, selected, t) {
    const { before, match, after } = snippet(r.text, this.text.query);
    return this.row(`kz-s-${i}`, selected, t)
      .h(28)
      .pl(36)
      .child(div().w(32).flex_none().text_right().text_size(12).text_color(t.dim).child(String(r.line)))
      .child(
        h_flex()
          .flex_1()
          .min_w(0)
          .overflow_hidden()
          .whitespace_nowrap()
          .font_family(settings().font_family)
          .text_size(12.5)
          .child(div().flex_none().text_color(t.muted).child(before))
          .child(div().flex_none().font_semibold().text_color(t.accent).child(match))
          .child(div().flex_none().text_color(t.muted).child(after)),
      )
      .on_click(() => this.open(r));
  }

  headRow(r, t) {
    return h_flex()
      .h(28)
      .flex_none()
      .px(12)
      .pt(4)
      .items_center()
      .justify_between()
      .text_size(12)
      .child(div().font_medium().text_color(t.muted).child(r.label))
      .child(div().text_color(t.dim).child(r.note));
  }

  // What the list says when it has no rows.
  message(t) {
    const line = (text, color = t.muted) => div().px(12).py(8).text_color(color).child(text);
    if (!this.root) return line("No folder. Focus a terminal or a file, then open the search again.");
    if (this.listError) return v_flex().child(line("Cannot list the files.", t.foreground)).child(line(this.listError, t.ansi1));
    if (this.listing) return line("Listing files…");
    if (!this.query.trim()) return line("Type a file name, a path such as src/components, or text to find in the files.");
    if (this.textBusy) return line("Searching…");
    return line(`Nothing matches “${this.query.trim()}”.`);
  }

  keycap(child, t) {
    return h_flex()
      .h(20)
      .min_w(20)
      .px(4)
      .flex_none()
      .items_center()
      .justify_center()
      .rounded(4)
      .border_1()
      .border_color(t.border)
      .bg(t.raised)
      .text_size(11)
      .text_color(t.muted)
      .child(child);
  }

  hint(keys, label, t) {
    return h_flex().gap(4).items_center().children(keys).child(div().pl(4).child(label));
  }

  status(t) {
    if (this.config?.problem) return div().text_color(t.ansi1).truncate().child(this.config.problem);
    if (this.textError) return div().text_color(t.ansi1).truncate().child(`Text search: ${this.textError}`);
    if (this.textBusy) return div().child("Searching…");
    if (this.listing || this.listError || !this.root) return div();
    return div().child(this.capped ? `First ${plural(this.files.length, "file")}` : plural(this.files.length, "file"));
  }

  render() {
    const t = theme();
    const rows = this.rows();
    const pickable = rows.filter((r) => PICKABLE.has(r.kind));
    this.at = Math.min(this.at, Math.max(0, pickable.length - 1));
    const selected = pickable[this.at];

    const list = rows.map((r, i) => {
      if (r.kind === "head") return this.headRow(r, t);
      if (r.kind === "group") return this.groupRow(r, t);
      if (r.kind === "line") return this.lineRow(r, i, r === selected, t);
      return this.fileRow(r, i, r === selected, t);
    });

    return v_flex()
      .id("kz-search")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .bg(t.popover)
      .text_color(t.foreground)
      .text_size(13)
      .on_key_down((e, cx) => this.key(e, rows, pickable, cx))
      .child(
        h_flex()
          .h(48)
          .flex_none()
          .px(16)
          .gap(12)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .child(icon("search", t.muted, 16))
          .child(Input.new(this.input).flex_1().h_full().text_size(14).text_color(t.foreground))
          .when(Boolean(this.root), (el) =>
            el.child(div().flex_none().max_w(160).truncate().text_size(12).text_color(t.muted).child(this.root.split("/").pop())),
          ),
      )
      .child(
        // A scroll area in a popup that fits its content gets no height of its own: give it one.
        list.length
          ? v_flex()
              .id("kz-search-list")
              .h(Math.min(LIST_HEIGHT, rows.reduce((h, r) => h + HEIGHT[r.kind], 8)))
              .flex_none()
              .overflow_y_scrollbar()
              .track_scroll(this.scroll)
              .p(4)
              .children(list)
          : div().p(4).child(this.message(t)),
      )
      .child(
        h_flex()
          .h(36)
          .flex_none()
          .px(16)
          .gap(16)
          .items_center()
          .border_t(1)
          .border_color(t.border)
          .text_size(12)
          .text_color(t.muted)
          .child(this.hint([this.keycap(icon("arrow-up", t.muted, 12), t), this.keycap(icon("arrow-down", t.muted, 12), t)], "Move", t))
          .child(this.hint([this.keycap(icon("corner-down-left", t.muted, 12), t)], "Open", t))
          .child(this.hint([this.keycap("Esc", t)], "Close", t))
          .child(h_flex().flex_1().min_w(0).justify_end().text_color(t.dim).child(this.status(t))),
      );
  }
}

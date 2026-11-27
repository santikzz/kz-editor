// Find in file, a spotlight over the editor like the ctrl+e search: a query with match case and
// regex toggles, a replace row that opens from the chevron, and every match as a line to pick.
// Go to line uses the same card. Herdr's editor has one selection and no find panel of its own,
// so picking a match selects it in the editor, which scrolls to it.
import { div } from "gpui-kit";
import { h_flex, v_flex, Input, InputState, ScrollHandle } from "gpui-base";
import { settings } from "herdr";
import { findIn, lineAt, matchLines, offsetOf, replaceAll, replaceOne } from "./match.js";
import { button, hint, icon, keycap } from "./ui.js";

const ROW = 28;
const ROWS_SHOWN = 12;
const LIMIT = 200;
const WIDTH = 640;

const count = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const stop = (_e, cx) => cx.stop_propagation();

export class FindCard {
  // Retained inputs can only be made in init, so the file tab makes the card there.
  constructor(tab) {
    this.tab = tab;
    this.mode = null;
    this.replacing = false;
    this.options = { matchCase: false, regex: false };
    this.found = { matches: [], error: null, capped: false };
    this.rows = [];
    this.at = 0;
    this.scroll = ScrollHandle.new();
    this.query = InputState.new({ placeholder: "Find in file" });
    this.replacement = InputState.new({ placeholder: "Replace with" });
    this.line = InputState.new({ placeholder: "Go to line, or line:column" });
    this.query.on("change", (_e, cx) => this.search(true, cx));
    this.query.on("submit", (_e, cx) => this.go(this.at, cx));
    this.replacement.on("submit", (_e, cx) => this.replace(cx));
    this.replacement.on("focus", (_e, cx) => ((this.replaceFocused = true), cx.notify()));
    this.replacement.on("blur", (_e, cx) => ((this.replaceFocused = false), cx.notify()));
    this.line.on("change", (_e, cx) => ((this.lines.bad = false), cx.notify()));
    this.line.on("submit", (_e, cx) => this.goToLine(cx));
  }

  get code() {
    return this.tab.code;
  }

  // mode: "find" or "line". A one-line selection becomes the query, as in VS Code.
  open(mode, replacing, cx) {
    const text = this.code.value();
    const range = this.code.selected_range();
    this.mode = mode;
    this.origin = range.start;
    if (mode === "line") {
      this.lines = { current: lineAt(text, range.start), total: lineAt(text, text.length), bad: false };
      this.line.set_value("");
      this.line.focus();
      return cx.notify();
    }
    this.replacing = replacing && this.tab.editable;
    const picked = text.slice(range.start, range.end);
    if (picked && !picked.includes("\n")) this.query.set_value(picked);
    const input = this.replacing && this.query.value() ? this.replacement : this.query;
    input.set_selected_range({ start: 0, end: input.value().length });
    input.focus();
    this.search(true, cx);
  }

  // refocus: false when a press outside closed it, so the press keeps the keyboard it gave.
  close(cx, refocus = true) {
    this.mode = null;
    if (refocus) this.code?.focus();
    cx.notify();
  }

  // fresh: a new query picks its first match from the cursor on. After an edit, the pick stays.
  search(fresh, cx) {
    if (this.mode !== "find" || !this.code) return;
    const text = this.code.value();
    this.found = findIn(text, this.query.value(), this.options);
    this.rows = matchLines(text, this.found.matches, LIMIT);
    if (fresh) this.at = Math.max(0, this.found.matches.slice(0, LIMIT).findIndex((m) => m.start >= this.origin));
    this.at = Math.min(this.at, Math.max(0, this.rows.length - 1));
    this.scroll.scroll_to_item(this.at);
    cx.notify();
  }

  move(dir, cx) {
    const n = this.rows.length;
    if (!n) return;
    this.at = (this.at + dir + n) % n;
    this.scroll.scroll_to_item(this.at);
    cx.notify();
  }

  go(index, cx) {
    const m = this.found.matches[index];
    if (!m) return;
    this.code.set_selected_range({ start: m.start, end: m.end });
    this.close(cx);
  }

  toggle(option, cx) {
    this.options = { ...this.options, [option]: !this.options[option] };
    this.search(true, cx);
  }

  expand(cx) {
    this.replacing = !this.replacing && this.tab.editable;
    (this.replacing ? this.replacement : this.query).focus();
    cx.notify();
  }

  // Replaces the picked match. The pick then sits on the match after it.
  replace(cx) {
    const m = this.found.matches[this.at];
    if (!m || !this.tab.editable) return;
    const matched = this.code.value().slice(m.start, m.end);
    this.code.set_selected_range({ start: m.start, end: m.end });
    this.code.replace(replaceOne(matched, this.query.value(), this.replacement.value(), this.options));
    this.tab.changed(cx);
  }

  // One undo step, and the cursor stays where it was.
  replaceAll(cx) {
    if (!this.found.matches.length || !this.tab.editable) return;
    const text = this.code.value();
    const range = this.code.selected_range();
    const next = replaceAll(text, this.query.value(), this.replacement.value(), this.options);
    this.code.set_selected_range({ start: 0, end: text.length });
    this.code.replace(next);
    const at = Math.min(range.start, next.length);
    this.code.set_selected_range({ start: at, end: at });
    this.tab.changed(cx);
  }

  goToLine(cx) {
    const [line, column] = this.line.value().split(/[:,]/).map((part) => parseInt(part.trim(), 10));
    if (!(line > 0)) {
      this.lines.bad = true;
      return cx.notify();
    }
    const at = offsetOf(this.code.value(), line, column > 0 ? column : 1);
    this.code.set_selected_range({ start: at, end: at });
    this.close(cx);
  }

  key(e, cx) {
    if (e.key === "escape") this.close(cx);
    else if (e.key === "down") this.move(1, cx);
    else if (e.key === "up") this.move(-1, cx);
    else if (e.keystroke === "alt-c" && this.mode === "find") this.toggle("matchCase", cx);
    else if (e.keystroke === "alt-r" && this.mode === "find") this.toggle("regex", cx);
    else return;
    cx.stop_propagation();
  }

  toggleButton(id, name, on, t, onClick) {
    return div()
      .id(id)
      .size(24)
      .flex_none()
      .flex()
      .items_center()
      .justify_center()
      .rounded(4)
      .cursor_pointer()
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => onClick(cx))
      .child(icon(name, on ? t.foreground : t.muted));
  }

  field(state) {
    return Input.new(state).flex_1().h_full().text_size(14);
  }

  findRow(t) {
    return h_flex()
      .h(44)
      .flex_none()
      .px(12)
      .gap(8)
      .items_center()
      .child(
        this.tab.editable
          ? this.toggleButton("kz-find-expand", this.replacing ? "chevron-down" : "chevron-right", false, t, (cx) => this.expand(cx))
          : div().size(24).flex().items_center().justify_center().child(icon("search", t.muted, 16)),
      )
      .child(this.field(this.query).text_color(t.foreground))
      .child(this.toggleButton("kz-find-case", "case-sensitive", this.options.matchCase, t, (cx) => this.toggle("matchCase", cx)))
      .child(this.toggleButton("kz-find-regex", "regex", this.options.regex, t, (cx) => this.toggle("regex", cx)));
  }

  replaceRow(t) {
    const some = this.found.matches.length > 0;
    const action = (id, label, onClick) =>
      some ? button(id, label, t, onClick) : div().h(22).px(8).flex().flex_none().items_center().text_size(12).text_color(t.dim).child(label);
    return h_flex()
      .h(44)
      .flex_none()
      .px(12)
      .gap(8)
      .items_center()
      .border_t(1)
      .border_color(t.border)
      .child(div().size(24).flex().flex_none().items_center().justify_center().child(icon("replace", t.muted)))
      .child(this.field(this.replacement).text_color(t.foreground))
      .child(action("kz-replace", "Replace", (cx) => this.replace(cx)))
      .child(action("kz-replace-all", "Replace all", (cx) => this.replaceAll(cx)));
  }

  // The text lines up with the query at 44 px: the list's 4 px, the row's 4 px, a 28 px line
  // number and an 8 px gap.
  matchRow(r, i, t) {
    const selected = i === this.at;
    return h_flex()
      .id(`kz-find-row-${i}`)
      .h(ROW)
      .flex_none()
      .px(4)
      .gap(8)
      .items_center()
      .rounded(6)
      .cursor_pointer()
      .when(selected, (el) => el.bg(t.selected))
      .when(!selected, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => this.go(i, cx))
      .child(div().w(28).flex_none().text_right().text_size(12).text_color(t.dim).child(String(r.line)))
      .child(
        h_flex()
          .flex_1()
          .min_w(0)
          .overflow_hidden()
          .whitespace_nowrap()
          .font_family(settings().font_family)
          .text_size(12.5)
          .child(div().flex_none().text_color(t.muted).child(r.before))
          .child(div().flex_none().font_semibold().text_color(t.accent).child(r.match))
          .child(div().flex_none().text_color(t.muted).child(r.after)),
      );
  }

  // The match list, or a line that says why there is none. Nothing before a query.
  body(t) {
    const note = (text, color = t.muted) => div().px(12).py(8).border_t(1).border_color(t.border).text_color(color).child(text);
    if (this.mode === "line") {
      const { current, total, bad } = this.lines;
      return note(bad ? "Type a line number, such as 12 or 12:5" : `Line ${count(current)} of ${count(total)}`, bad ? t.ansi1 : t.muted);
    }
    if (this.found.error) return note(this.found.error, t.ansi1);
    if (!this.query.value()) return null;
    if (!this.rows.length) return note(`No matches for “${this.query.value()}”`);
    // A scroll area that fits its content gets no height of its own: give it one.
    return v_flex()
      .id("kz-find-list")
      .h(Math.min(this.rows.length, ROWS_SHOWN) * ROW + 8)
      .flex_none()
      .p(4)
      .border_t(1)
      .border_color(t.border)
      .overflow_y_scrollbar()
      .track_scroll(this.scroll)
      .children(this.rows.map((r, i) => this.matchRow(r, i, t)));
  }

  status() {
    const n = this.found.matches.length;
    if (this.mode === "line" || !n) return "";
    const total = `${count(n)}${this.found.capped ? "+" : ""}`;
    return n > LIMIT ? `${this.at + 1} of the first ${LIMIT} of ${total}` : `${this.at + 1} of ${total}`;
  }

  footer(t) {
    const enter = keycap(icon("corner-down-left", t.muted, 12), t);
    const action = this.mode === "line" ? "Go" : this.replaceFocused ? "Replace" : "Go to match";
    return h_flex()
      .h(36)
      .flex_none()
      .px(12)
      .gap(16)
      .items_center()
      .border_t(1)
      .border_color(t.border)
      .text_size(12)
      .text_color(t.muted)
      .when(this.mode === "find", (el) =>
        el.child(hint([keycap(icon("arrow-up", t.muted, 12), t), keycap(icon("arrow-down", t.muted, 12), t)], "Move")),
      )
      .child(hint([enter], action))
      .child(hint([keycap("Esc", t)], "Close"))
      .child(div().flex_1().min_w(0).truncate().text_right().text_color(t.dim).child(this.status()));
  }

  // Over the top of the editor, centered. Presses and the wheel stop here, so the editor
  // under the card gets neither. A press outside closes it.
  view(t, width) {
    const w = Math.min(WIDTH, Math.max(320, (width ?? WIDTH) - 32));
    const lineMode = this.mode === "line";
    return v_flex()
      .id("kz-find")
      .absolute()
      .top(8)
      .left(Math.max(0, ((width ?? w) - w) / 2))
      .w(w)
      .rounded(8)
      .border_1()
      .border_color(t.border)
      .bg(t.popover)
      .shadow_lg()
      .overflow_hidden()
      .text_color(t.foreground)
      .text_size(13)
      .on_mouse_down("left", stop)
      .on_scroll_wheel(stop)
      .on_mouse_down_out((_e, cx) => this.close(cx, false))
      .on_key_down((e, cx) => this.key(e, cx))
      .child(
        lineMode
          ? h_flex()
              .h(44)
              .px(12)
              .gap(8)
              .items_center()
              .child(div().size(24).flex().items_center().justify_center().child(icon("arrow-down-to-line", t.muted, 16)))
              .child(this.field(this.line).text_color(t.foreground))
          : this.findRow(t),
      )
      .when(!lineMode && this.replacing, (el) => el.child(this.replaceRow(t)))
      .children([this.body(t)].filter(Boolean))
      .child(this.footer(t));
  }
}

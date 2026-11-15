// The tree's right-click menu, and the dialogs it opens: rename, new file, new folder, delete.
// Both are overlays of this mod: props { role: "menu", target } and { role: "ask", action, target },
// where target is { path, dir, root, on }.
import { div } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { closeOverlay, notify, openOverlay, props, run, theme } from "herdr";
import { baseName, openFile } from "./tabs.js";
import { parentOf } from "./markdown.js";
import * as ops from "./ops.js";

const ROW = 28;
const LINE = 9;
const TITLES = { rename: "Rename", "new-file": "New file", "new-folder": "New folder", delete: "Delete" };

const ask = (action, target) => () =>
  openOverlay({ mod: "kz-editor", kind: "dialog", width: 420, height: action === "delete" ? 150 : 196, props: { role: "ask", action, target } });

const pasteInto = (folder, on) =>
  ops.queue(async () => {
    const clip = ops.clipboard();
    if (!clip) return;
    try {
      await ops.paste(clip, folder, on);
    } catch (e) {
      notify({ title: "Paste failed", body: String(e?.message ?? e), level: "error" });
    }
  });

// Each item is [label, action]; an item without an action shows dimmed. "-" is a separator.
function items(target) {
  const { path, dir, root, on } = target;
  const local = !on;
  const top = path === root;
  const p = ops.platform();
  const folder = dir ? path : parentOf(path);
  const clip = ops.clipboard();
  const pasteable = Boolean(clip?.paths?.length) && ops.sameMachine(clip.on, on);
  const list = [
    !dir && local && ["Open in default app", () => ops.openOutside(path)],
    !dir && local && p === "windows" && ["Open with…", () => ops.openWith(path)],
    local && [p === "windows" ? "Reveal in File Explorer" : p === "macos" ? "Reveal in Finder" : "Open containing folder", () => ops.reveal(path)],
    ["Open in terminal", () => run("tab.new", { folder: ops.native(folder, on) })],
    "-",
    dir && ["New file…", ask("new-file", target)],
    dir && ["New folder…", ask("new-folder", target)],
    "-",
    !top && ["Cut", () => ops.setClipboard({ paths: [path], cut: true, on })],
    !top && ["Copy", () => ops.setClipboard({ paths: [path], cut: false, on })],
    ["Paste", pasteable ? () => pasteInto(folder, on) : null],
    "-",
    ["Copy path", (cx) => cx.write_to_clipboard(ops.native(path, on))],
    !top && ["Copy relative path", (cx) => cx.write_to_clipboard(ops.native(path.slice(root.length + 1), on))],
    "-",
    !top && ["Rename…", ask("rename", target)],
    !top && ["Delete", ask("delete", target)],
  ].filter(Boolean);
  return list.filter((it, i) => it !== "-" || (i > 0 && i < list.length - 1 && list[i - 1] !== "-"));
}

export function openMenu(target) {
  const height = 10 + items(target).reduce((h, it) => h + (it === "-" ? LINE : ROW), 0);
  openOverlay({ mod: "kz-editor", kind: "popup", width: 236, height, props: { role: "menu", target } });
}

export class Menu {
  constructor(p) {
    this.target = p.target;
  }

  init(cx) {
    this.at = -1;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  choose(item, cx) {
    if (!item?.[1]) return;
    item[1](cx);
    closeOverlay(props()?.overlay);
  }

  // Up and down move over the items that can run; Enter runs one.
  key(e, list, cx) {
    const ready = list.flatMap((it, i) => (it !== "-" && it[1] ? [i] : []));
    const at = ready.indexOf(this.at);
    if (e.key === "down") this.at = ready[(at + 1) % ready.length];
    else if (e.key === "up") this.at = ready[at <= 0 ? ready.length - 1 : at - 1];
    else if (e.key === "enter") return this.choose(list[this.at], cx);
    else if (e.key === "escape") return closeOverlay(props()?.overlay);
    else return;
    cx.notify();
  }

  render() {
    const t = theme();
    const list = items(this.target);
    return v_flex()
      .id("kz-menu")
      .track_focus(this.handle)
      .size_full()
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .on_key_down((e, cx) => this.key(e, list, cx))
      .children(
        list.map((it, i) =>
          it === "-"
            ? div().mx(7).my(4).h(1).flex_none().bg(t.border)
            : h_flex()
                .id(`kz-menu-${i}`)
                .h(ROW)
                .flex_none()
                .px(8)
                .rounded(6)
                .items_center()
                .text_color(it[1] ? t.foreground : t.dim)
                .when(i === this.at, (el) => el.bg(t.selected))
                .when(Boolean(it[1]), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.choose(it, cx)))
                .child(it[0]),
        ),
      );
  }
}

const dialogButton = (id, label, t, primary, onClick) =>
  h_flex()
    .id(id)
    .h(32)
    .px(14)
    .items_center()
    .rounded(8)
    .border_1()
    .border_color(primary ? t.solid : t.input)
    .bg(primary ? t.solid : t.raised)
    .text_color(primary ? t.solid_foreground : t.foreground)
    .text_size(12.5)
    .font_medium()
    .cursor_pointer()
    .when(!primary, (el) => el.hover((s) => s.bg(t.hover)))
    .on_click((_e, cx) => onClick(cx))
    .child(label);

// The dialog runs the operation itself and stays open with the error when it fails.
export class Ask {
  constructor(p) {
    this.action = p.action;
    this.target = p.target;
  }

  init(cx) {
    this.handle = cx.focus_handle();
    if (this.action === "delete") return this.handle.focus();
    const value = this.action === "rename" ? baseName(this.target.path) : "";
    this.input = InputState.new({ value });
    const dot = value.lastIndexOf(".");
    if (value) this.input.set_selected_range({ start: 0, end: !this.target.dir && dot > 0 ? dot : value.length });
    this.input.on("change", (_e, cx) => {
      this.error = null;
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.submit(cx));
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
  }

  submit(cx) {
    if (this.busy) return;
    const { action, target } = this;
    const name = this.input?.value() ?? "";
    const invalid = this.input ? ops.checkName(name, target.on, action !== "rename") : null;
    if (invalid) {
      this.error = invalid;
      return cx.notify();
    }
    this.busy = true;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (action === "rename") ops.moved(target.path, await ops.rename(target.path, name, target.on));
        else if (action === "delete") {
          await ops.remove(target.path, target.on);
          ops.deleted(target.path);
        } else {
          const path = await ops.create(target.path, name, action === "new-folder", target.on);
          ops.queue(async (cx, tree) => tree.show(path, cx));
          if (action === "new-file") openFile({ path, root: target.root, on: target.on ?? null }, true);
        }
        closeOverlay(props()?.overlay);
      } catch (e) {
        this.busy = false;
        this.error = String(e?.message ?? e);
        cx.notify();
      }
    });
  }

  render() {
    const t = theme();
    const { action, target } = this;
    const name = baseName(target.path);
    const trash = ops.platform() === "windows" ? "Recycle Bin" : "Trash";
    const detail =
      action === "delete"
        ? target.on
          ? `This deletes it on ${target.on} for good.`
          : `It goes to the ${trash}.`
        : action === "rename"
          ? ""
          : `In ${name}`;
    const close = () => closeOverlay(props()?.overlay);
    return v_flex()
      .id("kz-ask")
      .track_focus(this.handle)
      .size_full()
      .min_h(0)
      .p(18)
      .bg(t.popover)
      .text_color(t.foreground)
      .text_size(13)
      .on_key_down((e, cx) => {
        if (e.key === "escape") close();
        else if (e.key === "enter" && !this.input) this.submit(cx);
        else return;
        cx.stop_propagation();
      })
      .child(
        h_flex()
          .items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(15).font_semibold().child(action === "delete" ? `Delete “${name}”?` : TITLES[action]))
          .child(div().text_size(11).text_color(t.dim).child("Esc")),
      )
      .when(Boolean(this.input), (el) =>
        el.child(
          Input.new(this.input)
            .mt(16)
            .h(36)
            .px(10)
            .rounded(9)
            .border_1()
            .border_color(this.error ? t.ansi1 : t.accent)
            .bg(t.background)
            .text_size(12.8)
            .text_color(t.foreground),
        ),
      )
      .child(div().flex_1().min_h(0).pt(8).text_size(12).text_color(this.error ? t.ansi1 : t.dim).child(this.error ?? detail))
      .child(
        h_flex()
          .gap(8)
          .justify_end()
          .child(dialogButton("kz-ask-no", "Cancel", t, false, close))
          .child(dialogButton("kz-ask-yes", this.busy ? "Working…" : action === "rename" ? "Rename" : action === "delete" ? "Delete" : "Create", t, true, (cx) => this.submit(cx))),
      );
  }
}

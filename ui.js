// Small controls shared by the file tab, the image and PDF viewer and the tree menu.
import { div, svg } from "gpui-kit";

export const icon = (name, color, size = 14) => svg(`mods/kz-editor/icons/${name}.svg`).size(size).flex_none().text_color(color);

export function button(id, label, t, onClick, primary = false) {
  return div()
    .id(id)
    .px(8)
    .h(22)
    .flex_none()
    .flex()
    .items_center()
    .rounded(4)
    .text_size(12)
    .cursor_pointer()
    .when(primary, (el) => el.bg(t.solid).text_color(t.solid_foreground))
    .when(!primary, (el) => el.text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)))
    .on_click((_e, cx) => onClick(cx))
    .child(label);
}

export function iconButton(id, name, t, onClick, enabled = true) {
  return div()
    .id(id)
    .size(22)
    .flex_none()
    .flex()
    .items_center()
    .justify_center()
    .rounded(4)
    .when(enabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => onClick(cx)))
    .child(icon(name, enabled ? t.muted : t.dim));
}

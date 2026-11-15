// kz-editor: a file tree for the side panel and an editor tab for each file.
// One mod, chosen by props.role: "tree" (the default), "file" (a tab), and the tree's
// overlays "menu" (right-click) and "ask" (rename, new file or folder, delete).
import { View } from "gpui-kit";
import { props } from "herdr";
import { Tree } from "./tree.js";
import { FileTab } from "./file.js";
import { Ask, Menu } from "./menu.js";

const PARTS = { file: FileTab, menu: Menu, ask: Ask };

export default class Kzmod extends View {
  init(given, cx) {
    const p = given ?? props() ?? {};
    this.part = new (PARTS[p.role] ?? Tree)(p);
    this.part.init(cx);
  }

  render(cx) {
    return this.part.render(cx);
  }

  async close(cx) {
    await this.part.close?.(cx);
  }
}

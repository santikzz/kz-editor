// kz-editor: a file tree for the side panel and an editor tab for each file.
// One mod, two roles, chosen by props: "tree" (the default) or "file".
import { View } from "gpui-kit";
import { props } from "herdr";
import { Tree } from "./tree.js";
import { FileTab } from "./file.js";

export default class Kzmod extends View {
  init(given, cx) {
    const p = given ?? props() ?? {};
    this.part = p.role === "file" ? new FileTab(p) : new Tree();
    this.part.init(cx);
  }

  render(cx) {
    return this.part.render(cx);
  }

  async close(cx) {
    await this.part.close?.(cx);
  }
}

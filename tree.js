// The side panel: the focused pane's folder as a tree, with git colors.
// A click opens the file in a reusable tab, a double-click keeps that tab, a right-click
// opens the menu (menu.js).
import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, focused, panes, theme, watchFolder, window } from "herdr";
import { activeSpace, activeTab, entries, openFile } from "./tabs.js";
import { iconFor, isLight, loadIcons } from "./icons.js";
import { openMenu } from "./menu.js";
import { clipboard, lastChange, nextJob, sameMachine } from "./ops.js";

const PER_FOLDER = 500;
const TOTAL = 5000;
const ROW = 24;
const INDENT = 12;
const REFRESH_MS = 10000;
const RANK = { M: 1, A: 2, D: 3, U: 4 };

// Forward slashes and an upper-case drive, so paths match what git prints.
// watchFolder gives Windows paths with the \\?\ prefix.
export const normalize = (path) =>
  path.replace(/^\\\\\?\\/, "").replace(/\\/g, "/").replace(/\/+$/, "").replace(/^([a-z]):/, (_m, d) => `${d.toUpperCase()}:`);

// Where the tree should be. A file tab keeps the tree on that file's folder.
export function location() {
  const space = activeSpace();
  const f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  if (pane?.mod === "kz-editor") {
    const entry = entries()[pane.tab];
    if (entry) return { cwd: entry.root, on: entry.on ?? null };
  }
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : (space?.machine ?? null);
  const cwd = pane?.cwd || f?.cwd || space?.folder;
  return { cwd: cwd ? normalize(cwd) : null, on };
}

async function listFolder(path, on) {
  if (!on && window()?.platform === "windows") {
    const script =
      "& { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | " +
      "ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint)) } }) | ConvertTo-Json -Compress }";
    const r = await exec("powershell", ["-NoProfile", "-Command", script, path]);
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  }
  const script =
    'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; ' +
    'if [ -d "$p" ] && [ ! -L "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  const r = await exec("sh", ["-c", script, "files", path], { on });
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0");
  const out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

// A folder takes the strongest change inside it, the way VS Code colors them.
function folderMarks(marks) {
  const out = {};
  for (const [path, mark] of Object.entries(marks)) {
    for (let at = path.lastIndexOf("/"); at > 0; at = path.lastIndexOf("/", at - 1)) {
      const folder = path.slice(0, at);
      if ((RANK[out[folder]] ?? 0) < RANK[mark]) out[folder] = mark;
    }
  }
  return out;
}

export class Tree {
  init(cx) {
    this.entries = new Map();
    this.folders = new Set();
    this.pending = new Set();
    this.remembered = new Map();
    this.marks = {};
    this.folderMarks = {};
    this.ignored = new Set();
    this.icons = null;
    this.seenChange = lastChange();
    cx.spawn(async (cx) => {
      this.icons = await loadIcons();
      cx.notify();
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const job = await nextJob();
        await job(cx, this).catch(() => {});
        cx.notify();
      }
    });
    this.refresh(cx);
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
  }

  // Lists the open folders again and asks git for colors. A new place starts over,
  // but each root remembers which folders were open.
  refresh(cx) {
    const { cwd, on } = location();
    const context = JSON.stringify({ cwd, on });
    if (context !== this.context) {
      if (this.root) this.remembered.set(this.context, this.folders);
      this.context = context;
      this.root = cwd;
      this.on = on;
      this.entries = new Map();
      this.folders = new Set(this.remembered.get(context) ?? []);
      this.pending = new Set();
      this.marks = {};
      this.folderMarks = {};
      this.ignored = new Set();
      this.error = null;
      this.watched = null;
      this.loading = false;
    }
    if (!cwd) return;
    // A change while listing lists again after, so a new file is never missed.
    if (this.loading) {
      this.again = true;
      return;
    }
    this.loading = true;
    this.again = false;
    this.limited = false;
    cx.spawn(async (cx) => {
      try {
        for (const path of ["", ...this.folders]) await this.loadFolder(path, context);
        await this.readGit(context);
        if (this.context === context) {
          this.error = null;
          this.watch(cwd, context, cx);
        }
      } catch (e) {
        if (this.context === context) this.error = String(e?.message ?? e);
      } finally {
        if (this.context === context) this.loading = false;
        if (this.again && this.context === context) this.refresh(cx);
        cx.notify();
      }
    });
  }

  // Opens the folders down to a new file or folder.
  show(path, cx) {
    if (!this.root || !path.startsWith(`${this.root}/`)) return;
    const parts = path.slice(this.root.length + 1).split("/");
    for (let i = 1; i < parts.length; i++) this.folders.add(parts.slice(0, i).join("/"));
    this.refresh(cx);
  }

  async loadFolder(path, context) {
    const listed = await listFolder(path ? `${this.root}/${path}` : this.root, this.on);
    if (this.context !== context || (path && !this.folders.has(path))) return;
    const used = [...this.entries].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    const room = Math.max(0, Math.min(PER_FOLDER, TOTAL - used));
    if (listed.length > room) this.limited = true;
    this.entries.set(path, listed.slice(0, room).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
  }

  async readGit(context) {
    const { root: cwd, on } = this;
    const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
    const marks = {};
    const ignored = new Set();
    if (top?.code === 0) {
      // Writes nothing under .git (index lock, fsmonitor cookie), or the folder watch would fire again.
      const args = ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all", "--ignored"];
      const status = await exec("git", args, { cwd, on }).catch(() => null);
      const base = normalize(top.stdout.trim());
      if (status?.code === 0) {
        for (const line of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
          const xy = line.slice(0, 2);
          const path = normalize(`${base}/${line.slice(3)}`);
          if (xy === "!!") ignored.add(path);
          else marks[path] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
        }
      }
    }
    if (this.context !== context) return;
    this.marks = marks;
    this.folderMarks = folderMarks(marks);
    this.ignored = ignored;
  }

  // Only local folders can be watched; the timer covers other machines.
  watch(root, context, cx) {
    if (this.on || this.watched === context) return;
    this.watched = context;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === context) {
          await watchFolder(root);
          if (this.watched === context) this.refresh(cx);
        }
      } catch {
        if (this.watched === context) this.watched = null;
      }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders])
        if (folder === path || folder.startsWith(`${path}/`)) {
          this.folders.delete(folder);
          this.entries.delete(folder);
        }
      cx.notify();
      return;
    }
    this.folders.add(path);
    if (this.entries.has(path) || this.pending.has(path)) return cx.notify();
    const context = this.context;
    this.pending.add(path);
    cx.spawn(async (cx) => {
      try {
        await this.loadFolder(path, context);
      } catch (e) {
        if (this.context === context) this.error = String(e?.message ?? e);
      } finally {
        this.pending.delete(path);
        cx.notify();
      }
    });
    cx.notify();
  }

  isIgnored(absolute) {
    if (!this.ignored.size) return false;
    for (let at = absolute.length; at > 0; at = absolute.lastIndexOf("/", at - 1))
      if (this.ignored.has(absolute.slice(0, at))) return true;
    return false;
  }

  nameColor(mark, ignored, t) {
    if (ignored) return t.dim;
    if (mark === "A") return t.ansi2;
    if (mark === "D" || mark === "U") return t.ansi1;
    if (mark === "M") return t.ansi3;
    return t.muted;
  }

  icon(entry, open, ignored, t) {
    const path = iconFor(this.icons, entry.name, { dir: entry.dir, open, light: isLight(t.background) });
    if (!path) return svg(`mods/kz-editor/icons/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted);
    return image(path).size(16).flex_none().when(ignored, (el) => el.opacity(0.55));
  }

  rows(prefix, depth, out, selected, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = `${this.root}/${path}`;
      const open = this.folders.has(path);
      const ignored = this.isIgnored(absolute);
      const mark = ignored ? null : (this.marks[absolute] ?? (entry.dir ? this.folderMarks[absolute] : null));
      const color = this.nameColor(mark, ignored, t);

      out.push(
        h_flex()
          .id(`kz-row-${path}`)
          .h(ROW)
          .flex_none()
          .pl(6 + depth * INDENT)
          .pr(8)
          .gap(4)
          .items_center()
          .rounded(3)
          .cursor_pointer()
          .when(selected === absolute, (el) => el.bg(t.selected))
          .when(this.cut.has(absolute), (el) => el.opacity(0.5))
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_mouse_down("right", (_e, cx) => {
            cx.stop_propagation();
            openMenu({ path: absolute, dir: entry.dir, root: this.root, on: this.on });
          })
          .on_click((event, cx) => {
            if (entry.dir) {
              if (event?.click_count !== 2) this.toggle(path, cx);
              return;
            }
            openFile({ path: absolute, root: this.root, on: this.on }, event?.click_count === 2);
          })
          .child(
            entry.dir
              ? svg(`mods/kz-editor/icons/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim)
              : div().w(12).flex_none(),
          )
          .child(this.icon(entry, open, ignored, t))
          .child(div().flex_1().min_w(0).pl(2).truncate().text_color(color).child(entry.name))
          .when(Boolean(mark) && !entry.dir, (el) =>
            el.child(div().text_size(11).text_color(color).child(mark === "A" ? "U" : mark === "U" ? "!" : mark)),
          )
          .when(Boolean(mark) && entry.dir, (el) => el.child(div().size(5).flex_none().rounded(3).bg(color))),
      );

      if (entry.dir && open) this.rows(path, depth + 1, out, selected, t);
    }
    return out;
  }

  render(cx) {
    const { cwd, on } = location();
    if (JSON.stringify({ cwd, on }) !== this.context) this.refresh(cx);
    if (lastChange() !== this.seenChange) {
      this.seenChange = lastChange();
      this.refresh(cx);
    }
    const clip = clipboard();
    this.cut = new Set(clip?.cut && sameMachine(clip.on, this.on) ? clip.paths : []);
    const t = theme();
    const selected = entries()[activeTab()]?.path;
    const empty = !this.entries.get("")?.length;
    const message = this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder");

    return v_flex()
      .id("kz-tree")
      .size_full()
      .min_h(0)
      .rounded(10)
      .overflow_hidden()
      .bg(t.background)
      .border_1()
      .border_color(t.border)
      .text_color(t.muted)
      .text_size(13)
      .child(
        h_flex()
          .h(42)
          .flex_none()
          .px(14)
          .gap(8)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .child(div().font_semibold().text_color(t.foreground).child("Files"))
          .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.root?.split("/").pop() ?? "")),
      )
      .child(
        v_flex()
          .id("kz-tree-rows")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .px(4)
          .py(4)
          .on_mouse_down("right", () => {
            if (this.root) openMenu({ path: this.root, dir: true, root: this.root, on: this.on });
          })
          .children(this.rows("", 0, [], selected, t))
          .when(Boolean(this.error) || empty, (el) => el.child(div().p(8).text_size(12).text_color(t.dim).child(message)))
          .when(Boolean(this.limited), (el) =>
            el.child(div().p(8).text_size(11).text_color(t.dim).child("List limited to 500 entries per folder and 5,000 total")),
          ),
      );
  }
}

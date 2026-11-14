// Which tab shows which file, shared so the tree and every file tab agree.
// A mod copy cannot learn the id of the tab it opens, so a new file tab claims
// the shown tab when it first starts (tab.new selects the new tab).
import { panes, run, setShared, shared, spaces } from "herdr";

const KEY = "kz-editor.tabs";
const MOD = "kz-editor";
const OPENING_MS = 1500;

// Module scope is shared by every copy of this mod, so the tree and the new tab both see it.
let opening = null;

export const baseName = (path) => path.split("/").pop();
export const entries = () => shared(KEY) ?? {};
export const activeSpace = () => spaces().find((s) => s.active) ?? null;
export const activeTab = () => activeSpace()?.tabs.find((t) => t.active)?.id ?? null;
export const isFileTab = (tab) => panes().some((p) => p.tab === tab && p.mod === MOD);

// change: fields to merge, or null to forget the tab.
export function setEntry(tab, change) {
  const next = { ...entries() };
  if (change) next[tab] = { ...next[tab], ...change };
  else delete next[tab];
  setShared(KEY, next);
}

// keep: a double-click, so the tab stays instead of being reused by the next click.
export function openFile(file, keep = false) {
  const space = activeSpace()?.id;
  if (!space || !file?.path) return;

  const all = entries();
  const dead = Object.keys(all).filter((tab) => !isFileTab(tab));
  if (dead.length) setShared(KEY, Object.fromEntries(Object.entries(all).filter(([tab]) => !dead.includes(tab))));

  const live = Object.entries(entries()).filter(([, e]) => e.space === space);
  const open = live.find(([, e]) => e.path === file.path);

  if (open) {
    if (keep && open[1].preview) setEntry(open[0], { preview: false });
    run("tab.select", { id: open[0] });
    return;
  }

  if (opening?.path === file.path && Date.now() - opening.at < OPENING_MS) {
    if (keep) opening.keep = true;
    return;
  }

  const reusable = !keep && live.find(([, e]) => e.preview);
  if (reusable) {
    setEntry(reusable[0], { ...file });
    run("tab.rename", { id: reusable[0], name: baseName(file.path) });
    run("tab.select", { id: reusable[0] });
    return;
  }

  // The key lets the new tab's copy find its registry entry, even after a restart.
  const key = `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const before = new Set(spaceTabs(space).map((t) => t.id));
  opening = { path: file.path, at: Date.now(), keep };
  run("tab.new", { space, name: baseName(file.path), mod: MOD, props: { role: "file", file, key, space } });
  const tab = spaceTabs(space).find((t) => !before.has(t.id))?.id;
  if (tab) setEntry(tab, { ...file, space, key, preview: !keep });
}

export const spaceTabs = (space) => spaces().find((s) => s.id === space)?.tabs ?? [];

// Called by a new file tab: whether a double-click asked to keep it while it was opening.
export function takeOpening(path) {
  if (opening?.path !== path) return null;
  const taken = opening;
  opening = null;
  return taken;
}

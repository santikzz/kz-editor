// File and folder icons from the better-icons mod (Material Icon Theme).
// Returns null when better-icons is missing, so callers draw their own fallback.
import { appHome, readTextFile } from "herdr";

const PACK = "mods/better-icons";

export async function loadIcons() {
  try {
    const t = JSON.parse((await readTextFile(`${appHome()}/${PACK}/icons.json`)) ?? "null");
    return t?.file && t?.folder && t?.fileNames && t?.fileExtensions && t?.folderNames ? t : null;
  } catch {
    return null;
  }
}

export function isLight(color) {
  const hex = /^#([0-9a-f]{6})/i.exec(color ?? "")?.[1];
  if (!hex) return false;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 128;
}

// A full name beats an extension, and the longest extension wins (".spec.ts" before ".ts").
export function iconFor(table, name, { dir = false, open = false, light = false } = {}) {
  if (!table) return null;
  const n = name.toLowerCase();
  const pick = (kind, key) => (light && table.light?.[kind]?.[key]) || table[kind]?.[key];
  let icon = pick(dir ? "folderNames" : "fileNames", n);
  for (let dot = n.indexOf("."); !dir && !icon && dot !== -1; dot = n.indexOf(".", dot + 1))
    icon = pick("fileExtensions", n.slice(dot + 1));
  icon ??= dir ? table.folder : table.file;
  if (dir && open) icon = table.open?.[icon] ?? icon;
  return `${PACK}/icons/${icon}.svg`;
}

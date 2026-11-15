// File operations for the tree menu, on the machine that holds the files: PowerShell on
// Windows, sh elsewhere. The clipboard is kz-editor's own, shared by every copy of the mod.
import { exec, run, setShared, shared, window } from "herdr";
import { baseName, entries, setEntry } from "./tabs.js";
import { parentOf, ps } from "./markdown.js";

const CLIPBOARD = "kz-editor.clipboard";
const CHANGED = "kz-editor.changed";
const TIMEOUT = 120000;

export const clipboard = () => shared(CLIPBOARD) ?? null;
export const setClipboard = (value) => setShared(CLIPBOARD, value);
// Bumped after each operation, so the tree lists again at once, also on another machine.
export const lastChange = () => shared(CHANGED) ?? 0;

export const platform = () => window()?.platform;
const windows = (on) => !on && platform() === "windows";
export const native = (path, on) => (windows(on) ? path.replace(/\//g, "\\") : path);
export const sameMachine = (a, b) => (a ?? null) === (b ?? null);

// Long work runs in the tree's copy: a menu closes at once, and an overlay's tasks stop with it.
// The tree waits on nextJob(); a job gets the tree's cx and the tree.
const jobs = [];
let wake = null;
export function queue(job) {
  jobs.push(job);
  wake?.();
}
export async function nextJob() {
  while (!jobs.length) await new Promise((resolve) => (wake = resolve));
  return jobs.shift();
}

// PowerShell gets its values as literals in front of the script: it joins the arguments
// after -Command, so a path with a space would split. sh gets them as $1, $2, ...
async function shell(on, values, powershell, sh) {
  let r;
  if (windows(on)) {
    const head = Object.entries(values)
      .map(([name, v]) => `$${name} = ${typeof v === "boolean" ? `$${v}` : Array.isArray(v) ? `@(${v.map(ps).join(", ")})` : ps(v)}`)
      .join("; ");
    const script = `$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [Text.Encoding]::UTF8; try { ${head}; ${powershell} } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;
    r = await exec("powershell", ["-NoProfile", "-Command", script], { timeout: TIMEOUT });
  } else {
    const args = Object.values(values).flatMap((v) => (typeof v === "boolean" ? [v ? "1" : ""] : v));
    r = await exec("sh", ["-c", sh, "kz-editor", ...args], { on, timeout: TIMEOUT });
  }
  setShared(CHANGED, Date.now());
  if (r.code !== 0) throw new Error(r.stderr.trim().split("\n")[0] || "The operation failed.");
  return r.stdout;
}

// nested: a new file or folder may name folders on the way ("src/app.js"), a rename may not.
export function checkName(name, on, nested = false) {
  const n = name.trim();
  if (!n) return "Enter a name.";
  const parts = n.split(windows(on) ? /[\\/]/ : /\//);
  if (!nested && parts.length > 1) return "A name cannot contain / or \\.";
  if (parts.some((p) => !p || p === "." || p === "..")) return "This name is not allowed.";
  if (windows(on) && /[<>:"|?*]/.test(n)) return 'A name cannot contain < > : " | ? *';
  return null;
}

const taken = (path) => `“${baseName(path)}” already exists in this folder.`;

export async function rename(path, name, on) {
  const to = `${parentOf(path)}/${name.trim()}`;
  if (to === path) return path;
  await shell(
    on,
    { from: native(path, on), to: native(to, on), taken: taken(to) },
    "if ((Test-Path -LiteralPath $to) -and $from -ne $to) { throw $taken }; Move-Item -LiteralPath $from -Destination $to",
    '[ -e "$2" ] && { printf "%s\\n" "$3" >&2; exit 1; }; mv -- "$1" "$2"',
  );
  return to;
}

export async function create(folder, name, dir, on) {
  const to = `${folder}/${name.trim().replace(/\\/g, "/")}`;
  await shell(
    on,
    { to: native(to, on), dir, taken: `“${name.trim()}” already exists in this folder.` },
    "if (Test-Path -LiteralPath $to) { throw $taken }; if ($dir) { [void][IO.Directory]::CreateDirectory($to) } else { [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($to)); [IO.File]::Create($to).Close() }",
    '[ -e "$1" ] && { printf "%s\\n" "$3" >&2; exit 1; }; if [ -n "$2" ]; then mkdir -p -- "$1"; else mkdir -p -- "$(dirname -- "$1")" && : > "$1"; fi',
  );
  return to;
}

// Windows and macOS move the item to the Recycle Bin or the Trash, Linux to gio's trash.
// Another machine has no trash: the item is deleted for good, and the dialog says so.
export async function remove(path, on) {
  const p = platform();
  const sh = on
    ? 'rm -rf -- "$1"'
    : p === "macos"
      ? "osascript -e 'on run argv' -e 'tell application \"Finder\" to delete (POSIX file (item 1 of argv) as alias)' -e 'end run' \"$1\" >/dev/null"
      : 'command -v gio >/dev/null || { echo "Moving to the trash needs gio." >&2; exit 1; }; gio trash -- "$1"';
  await shell(
    on,
    { from: native(path, on) },
    "Add-Type -AssemblyName Microsoft.VisualBasic; $fs = [Microsoft.VisualBasic.FileIO.FileSystem]; " +
      "if (Test-Path -LiteralPath $from -PathType Container) { $fs::DeleteDirectory($from, 'OnlyErrorDialogs', 'SendToRecycleBin') } " +
      "else { $fs::DeleteFile($from, 'OnlyErrorDialogs', 'SendToRecycleBin') }",
    sh,
  );
}

// Copy keeps both: "name copy.ext", "name copy 2.ext". Cut moves, and stops at a name in use.
export async function paste(clip, folder, on) {
  for (const path of clip.paths)
    if (folder === path || folder.startsWith(`${path}/`)) throw new Error("A folder cannot go inside itself.");
  await shell(
    on,
    { dest: native(folder, on), cut: Boolean(clip.cut), sources: clip.paths.map((p) => native(p, on)) },
    "foreach ($from in $sources) { $name = [IO.Path]::GetFileName($from); $to = [IO.Path]::Combine($dest, $name); " +
      "if ($cut) { if ([IO.Path]::GetDirectoryName($from) -eq $dest) { continue }; if (Test-Path -LiteralPath $to) { throw ('“' + $name + '” already exists in this folder.') }; Move-Item -LiteralPath $from -Destination $to } " +
      "else { $stem = $name; $ext = ''; $dot = $name.LastIndexOf('.'); " +
      "if ($dot -gt 0 -and -not (Test-Path -LiteralPath $from -PathType Container)) { $stem = $name.Substring(0, $dot); $ext = $name.Substring($dot) }; " +
      "$n = 1; while (Test-Path -LiteralPath $to) { $to = [IO.Path]::Combine($dest, $stem + ' copy' + $(if ($n -gt 1) { ' ' + $n } else { '' }) + $ext); $n++ }; " +
      "Copy-Item -LiteralPath $from -Destination $to -Recurse } }",
    'dest=$1; cut=$2; shift 2; for from in "$@"; do name=${from##*/}; to="$dest/$name"; ' +
      'if [ -n "$cut" ]; then [ "${from%/*}" = "$dest" ] && continue; [ -e "$to" ] && { printf "“%s” already exists in this folder.\\n" "$name" >&2; exit 1; }; mv -- "$from" "$to" || exit 1; ' +
      'else stem=$name; ext=; if [ ! -d "$from" ]; then case "$name" in ?*.*) stem=${name%.*}; ext=.${name##*.};; esac; fi; ' +
      'n=1; while [ -e "$to" ]; do if [ $n = 1 ]; then to="$dest/$stem copy$ext"; else to="$dest/$stem copy $n$ext"; fi; n=$((n+1)); done; ' +
      'cp -R -- "$from" "$to" || exit 1; fi; done',
  );
  if (!clip.cut) return;
  setClipboard(null);
  for (const path of clip.paths) moved(path, `${folder}/${baseName(path)}`);
}

// Open tabs follow a renamed or moved file. The tab reloads it, or keeps its unsaved edits.
export function moved(from, to) {
  if (from === to) return;
  for (const [tab, e] of Object.entries(entries()))
    if (e.path === from || e.path.startsWith(`${from}/`)) setEntry(tab, { path: to + e.path.slice(from.length) });
}

// Tabs of a deleted file close. A tab with unsaved edits writes them to <file>.unsaved first.
export function deleted(path) {
  for (const [tab, e] of Object.entries(entries()))
    if (e.path === path || e.path.startsWith(`${path}/`)) {
      run("tab.close", { id: tab });
      setEntry(tab, null);
    }
}

// The system's own opener starts the default app for the file type.
export function openOutside(path) {
  const p = platform();
  if (p === "windows") exec("explorer", [native(path)]).catch(() => {});
  else exec(p === "macos" ? "open" : "xdg-open", [path]).catch(() => {});
}

// The Windows "Open with" dialog. rundll32 reads the rest of its command line as the path,
// so it must not be quoted: Start-Process passes the line as it is.
export function openWith(path) {
  const line = `shell32.dll,OpenAs_RunDLL ${native(path)}`;
  exec("powershell", ["-NoProfile", "-Command", `Start-Process rundll32 -ArgumentList ${ps(line)}`]).catch(() => {});
}

// The file manager with the item selected. Linux file managers have no common way to select.
export function reveal(path) {
  const p = platform();
  if (p === "windows") exec("explorer", ["/select,", native(path)]).catch(() => {});
  else if (p === "macos") exec("open", ["-R", path]).catch(() => {});
  else exec("xdg-open", [parentOf(path)]).catch(() => {});
}

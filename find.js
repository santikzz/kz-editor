// What the spotlight searches: the files git lists in the tree's folder, and their text through
// git grep. Both follow .gitignore and the excludes in config.json. A folder outside git gets
// an empty repository as its git dir, so the same two commands work there too.
// A repository inside the folder shows in git's list only as "name/": it is searched on its own.
import { appHome, exec, readTextFile } from "herdr";
import { excludeSpecs, parseGrep } from "./match.js";
import { normalize } from "./tree.js";

// The excludes VS Code has by default (files.exclude and search.exclude).
const DEFAULTS = { exclude: ["node_modules", "bower_components", ".git", ".svn", ".hg", ".DS_Store", "Thumbs.db"], gitignore: true };
const LIST_MS = 10000;
const GREP_MS = 15000;
const MAX_FILES = 50000;
const NESTED = 20;
const PER_FILE = 5;

const firstLine = (text) => text.trim().split("\n")[0];

// config.json in the mod folder: { "search": { "exclude": [...], "gitignore": true } }.
// A missing file uses the defaults. A bad one also does, and says why in `problem`.
export async function readConfig() {
  let text;
  try {
    text = await readTextFile(`${normalize(appHome())}/mods/kz-editor/config.json`);
  } catch (e) {
    return { ...DEFAULTS, problem: `config.json: ${e?.message ?? e}` };
  }
  if (text == null) return { ...DEFAULTS, problem: null };
  try {
    const search = JSON.parse(text)?.search ?? {};
    const exclude = search.exclude ?? DEFAULTS.exclude;
    if (!Array.isArray(exclude) || exclude.some((p) => typeof p !== "string")) throw new Error("search.exclude must be a list of strings");
    if (search.gitignore !== undefined && typeof search.gitignore !== "boolean") throw new Error("search.gitignore must be true or false");
    return { exclude, gitignore: search.gitignore ?? DEFAULTS.gitignore, problem: null };
  } catch (e) {
    return { ...DEFAULTS, problem: `config.json: ${e?.message ?? e}` };
  }
}

const empty = new Map();

async function emptyRepo(on) {
  if (empty.has(on)) return empty.get(on);
  let dir;
  if (on) {
    const r = await exec("sh", ["-c", 'd="$HOME/.cache/kz-editor/empty.git"; git init --bare -q "$d" && printf %s "$d"'], { on });
    if (r.code !== 0) throw new Error(firstLine(r.stderr) || "Cannot prepare git on this machine");
    dir = r.stdout;
  } else {
    dir = `${normalize(appHome())}/mods/kz-editor/.cache/empty.git`;
    const r = await exec("git", ["init", "--bare", "-q", dir]);
    if (r.code !== 0) throw new Error(firstLine(r.stderr) || "Cannot prepare git");
  }
  empty.set(on, dir);
  return dir;
}

// A scope is one git work tree: dir is its path from the root, with a trailing slash.
const git = (scope, args, timeout) => exec("git", [...scope.prefix, ...args], { cwd: scope.cwd, on: scope.on, timeout });

async function rootScope(cwd, on) {
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
  if (top?.code === 0) return { cwd, on, dir: "", prefix: [] };
  return { cwd, on, dir: "", prefix: ["--git-dir", await emptyRepo(on), "--work-tree", cwd] };
}

// Relative paths with forward slashes, and the scopes to grep.
export async function listFiles(root, on, config) {
  const files = [];
  const scopes = [];
  const ignore = config.gitignore ? ["--exclude-standard"] : [];
  const walk = async (scope, depth) => {
    const r = await git(scope, ["ls-files", "-z", "--cached", "--others", ...ignore, "--", ".", ...excludeSpecs(config.exclude)], LIST_MS);
    if (r.code !== 0) throw new Error(firstLine(r.stderr) || "git cannot list this folder");
    scopes.push(scope);
    const nested = [];
    for (const path of r.stdout.split("\0")) {
      if (path.endsWith("/")) nested.push(path);
      else if (path && files.length < MAX_FILES) files.push(scope.dir + path);
    }
    if (depth >= 2) return;
    for (const dir of nested.slice(0, NESTED))
      await walk({ cwd: `${scope.cwd}/${dir.slice(0, -1)}`, on, dir: scope.dir + dir, prefix: [] }, depth + 1).catch(() => {});
  };
  await walk(await rootScope(root, on), 0);
  return { files: [...new Set(files)], scopes, capped: files.length >= MAX_FILES };
}

// Literal text, case ignored, at most PER_FILE lines a file. git grep exits 1 for no match.
export async function grepText(scopes, query, config) {
  const args = ["grep", "-n", "-z", "-I", "-i", "-F", "--untracked", `--max-count=${PER_FILE}`];
  if (!config.gitignore) args.push("--no-exclude-standard");
  args.push("-e", query, "--", ".", ...excludeSpecs(config.exclude));
  const found = await Promise.all(
    scopes.map(async (scope) => {
      const r = await git(scope, args, GREP_MS);
      if (r.code > 1) throw new Error(firstLine(r.stderr) || "git grep failed");
      return parseGrep(r.stdout, scope.dir);
    }),
  );
  return found.flat();
}

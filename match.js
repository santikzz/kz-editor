// Ranking and parsing for the spotlight, after VS Code's fuzzyScorer.ts in short.
// No Herdr imports, so `node match.test.mjs` can check it.

const SEPARATORS = "/\\_-. '\":";
const isUpper = (c) => c !== c.toLowerCase();

// A hit at the start of a word scores more: after a separator, or on a camelCase hump.
const startBonus = (text, at) =>
  at === 0 || SEPARATORS.includes(text[at - 1]) ? 8 : isUpper(text[at]) && !isUpper(text[at - 1]) ? 2 : 0;

// Every character of the piece in order, case ignored. The whole piece in one run wins, the
// first run at a word start before any other. Else each hit scores 1, plus its start bonus,
// plus 5 next to the previous hit. Greedy: VS Code's matrix can find a better later hit.
export function fuzzy(text, lower, piece) {
  let run = -1;
  for (let at = lower.indexOf(piece); at !== -1; at = lower.indexOf(piece, at + 1)) {
    if (run === -1) run = at;
    if (startBonus(text, at)) {
      run = at;
      break;
    }
  }
  if (run !== -1) return { score: piece.length * 10 + startBonus(text, run) * 2, hits: [...piece].map((_c, i) => run + i) };

  const hits = [];
  let score = 0;
  for (let i = 0, from = 0; i < piece.length; i++) {
    const at = lower.indexOf(piece[i], from);
    if (at === -1) return null;
    score += 1 + startBonus(text, at) + (hits.at(-1) === at - 1 ? 5 : 0);
    hits.push(at);
    from = at + 1;
  }
  return { score, hits };
}

// Each piece must match. A piece without a slash tries the file name first, which scores
// double; a piece with a slash, or one the name misses, matches the whole path.
export function scoreFile(path, lower, pieces) {
  const start = path.lastIndexOf("/") + 1;
  const name = lower.slice(start);
  const hits = [];
  let score = 0;
  for (const piece of pieces) {
    const inName = piece.includes("/") ? null : fuzzy(path.slice(start), name, piece);
    if (inName) {
      score += inName.score * 2 + (name === piece ? 100 : name.startsWith(piece) ? 40 : 0);
      hits.push(...inName.hits.map((h) => h + start));
      continue;
    }
    // A leading slash anchors at the root: "/src" matches "src/app.js".
    const inPath = fuzzy(`/${path}`, `/${lower}`, piece);
    if (!inPath) return null;
    score += inPath.score;
    hits.push(...inPath.hits.map((h) => h - 1).filter((h) => h >= 0));
  }
  return { score, hits };
}

// files: [{ path, lower }]. The best first; a shorter path wins a tie.
export function rankFiles(files, query, limit) {
  const pieces = query.toLowerCase().replace(/\\/g, "/").split(/\s+/).filter(Boolean);
  if (!pieces.length) return { items: [], total: 0 };
  const found = [];
  for (const file of files) {
    const match = scoreFile(file.path, file.lower, pieces);
    if (match) found.push({ path: file.path, ...match });
  }
  found.sort((a, b) => b.score - a.score || a.path.length - b.path.length || (a.path < b.path ? -1 : 1));
  return { items: found.slice(0, limit), total: found.length };
}

// config.json excludes as git pathspecs. A pattern without a slash ("node_modules", "*.map")
// skips that name in any folder; one with a slash ("src/generated") is from the root.
export function excludeSpecs(patterns) {
  return patterns.flatMap((pattern) => {
    const clean = String(pattern).trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (!clean) return [];
    const glob = clean.includes("/") ? clean : `**/${clean}`;
    return [`:(exclude,glob)${glob}`, `:(exclude,glob)${glob}/**`];
  });
}

// git grep -n -z prints one "path\0line\0text" for each match.
export function parseGrep(out, dir = "") {
  const found = [];
  for (const row of out.split("\n")) {
    const a = row.indexOf("\0");
    const b = row.indexOf("\0", a + 1);
    if (a < 1 || b < 0) continue;
    found.push({ path: dir + row.slice(0, a), line: Number(row.slice(a + 1, b)), text: row.slice(b + 1).replace(/\r$/, "") });
  }
  return found;
}

const LEAD = 40;
const BEFORE = 16;
const AFTER = 160;

// A line cut down to the part around the match at [start, end), without its indent.
export function excerpt(text, start, end) {
  const indent = text.length - text.trimStart().length;
  const line = text.slice(indent);
  const at = Math.max(0, start - indent);
  const stop = Math.max(at, end - indent);
  const from = at > LEAD ? at - BEFORE : 0;
  return { before: (from ? "…" : "") + line.slice(from, at), match: line.slice(at, stop), after: line.slice(stop, stop + AFTER) };
}

export function snippet(text, query) {
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at === -1) return { before: text.trimStart().slice(0, AFTER), match: "", after: "" };
  return excerpt(text, at, at + query.length);
}

// The line of each of the first `limit` matches: its number from 1 and the excerpt around the
// match. A match over more than one line shows its first line.
export function matchLines(text, matches, limit) {
  const out = [];
  let line = 1;
  let lineStart = 0;
  for (const m of matches.slice(0, limit)) {
    for (let nl = text.indexOf("\n", lineStart); nl !== -1 && nl < m.start; nl = text.indexOf("\n", lineStart)) {
      line++;
      lineStart = nl + 1;
    }
    const nl = text.indexOf("\n", lineStart);
    const lineText = text.slice(lineStart, nl === -1 ? text.length : nl).replace(/\r$/, "");
    out.push({ line, ...excerpt(lineText, m.start - lineStart, m.end - lineStart) });
  }
  return out;
}

// Find and replace in a file tab, as UTF-16 offsets: the editor selection takes the same.
const MAX_MATCHES = 10000;

function patternOf(query, { matchCase = false, regex = false } = {}, global = true) {
  const source = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(source, `${global ? "g" : ""}${matchCase ? "" : "i"}m`);
}

// error: the pattern does not compile. capped: more than MAX_MATCHES, the rest are not listed.
export function findIn(text, query, options) {
  const found = { matches: [], error: null, capped: false };
  if (!query) return found;
  let re;
  try {
    re = patternOf(query, options);
  } catch {
    return { ...found, error: "Invalid pattern" };
  }
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (!m[0]) {
      re.lastIndex++;
      continue;
    }
    if (found.matches.length === MAX_MATCHES) return { ...found, capped: true };
    found.matches.push({ start: m.index, end: m.index + m[0].length });
  }
  return found;
}

// A regex replacement can use $1 and $&. A literal one is taken as it is.
// ponytail: one match is replaced without its surroundings, so a lookbehind or ^ in the pattern can miss
export function replaceOne(matched, query, replacement, options) {
  if (!options?.regex) return replacement;
  return matched.replace(patternOf(query, options, false), replacement);
}

export function replaceAll(text, query, replacement, options) {
  return text.replace(patternOf(query, options), options?.regex ? replacement : () => replacement);
}

const isWord = (c) => c !== undefined && /[\w$]/.test(c);

export function wordAt(text, at) {
  let start = at;
  let end = at;
  while (isWord(text[start - 1])) start--;
  while (isWord(text[end])) end++;
  return { start, end };
}

// ctrl+d: the word at the cursor, else the next copy of the selection, from the top after the last.
// A selected word matches whole words only, as in VS Code.
export function nextOccurrence(text, range) {
  if (range.start === range.end) {
    const word = wordAt(text, range.start);
    return word.start === word.end ? null : word;
  }
  const needle = text.slice(range.start, range.end);
  const whole = [...needle].every(isWord);
  const find = (from) => {
    for (let at = text.indexOf(needle, from); at !== -1; at = text.indexOf(needle, at + 1))
      if (!whole || (!isWord(text[at - 1]) && !isWord(text[at + needle.length]))) return at;
    return -1;
  };
  let at = find(range.end);
  if (at === -1) at = find(0);
  return { start: at, end: at + needle.length };
}

// Line and column count from 1. Past the end goes to the last line, or to the end of the line.
export function offsetOf(text, line, column = 1) {
  let at = 0;
  for (let i = 1; i < line; i++) {
    const next = text.indexOf("\n", at);
    if (next === -1) break;
    at = next + 1;
  }
  const end = text.indexOf("\n", at);
  return at + Math.min(Math.max(column, 1) - 1, (end === -1 ? text.length : end) - at);
}

export const lineAt = (text, offset) => text.slice(0, offset).split("\n").length;

// The indent of a file: tabs, or 2 or 4 spaces. Null when no line is indented.
export function indentOf(text) {
  let tabs = 0;
  let two = 0;
  let four = 0;
  for (const line of text.split("\n", 2000)) {
    if (line[0] === "\t") tabs++;
    if (line[0] !== " ") continue;
    const n = line.length - line.trimStart().length;
    if (n === line.length) continue;
    if (n % 4 === 0) four++;
    else if (n % 2 === 0) two++;
  }
  if (tabs > two + four) return { size: 4, tabs: true };
  if (!two && !four) return null;
  return { size: two * 4 > four ? 2 : 4, tabs: false };
}

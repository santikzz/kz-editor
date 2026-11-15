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

// A line cut down to the part around the match, without its indent.
export function snippet(text, query) {
  const line = text.replace(/^\s+/, "");
  const at = line.toLowerCase().indexOf(query.toLowerCase());
  if (at === -1) return { before: line.slice(0, AFTER), match: "", after: "" };
  const from = at > LEAD ? at - BEFORE : 0;
  const end = at + query.length;
  return { before: (from ? "…" : "") + line.slice(from, at), match: line.slice(at, end), after: line.slice(end, end + AFTER) };
}

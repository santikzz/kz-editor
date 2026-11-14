// Which of the Herdr editor grammars colors a file, or a Markdown code block.

// Grammars this Herdr build has. Others borrow the closest one: php reads well as javascript.
const GRAMMARS = new Set(["javascript", "json", "python", "rust", "go", "yaml", "bash", "sql", "ruby", "java", "c", "cpp", "lua", "html", "css", "markdown"]);
const ALIASES = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript", ts: "javascript", tsx: "javascript",
  mts: "javascript", cts: "javascript", typescript: "javascript", php: "javascript", vue: "html", svelte: "html",
  astro: "html", htm: "html", xml: "html", svg: "html", scss: "css", less: "css", jsonc: "json", json5: "json",
  md: "markdown", py: "python", rs: "rust", golang: "go", yml: "yaml", toml: "yaml", sh: "bash", zsh: "bash",
  shell: "bash", console: "bash", shellscript: "bash", ps1: "bash", powershell: "bash", rb: "ruby", kt: "java",
  kotlin: "java", cs: "java", csharp: "java", scala: "java", h: "c", cc: "cpp", cxx: "cpp", hpp: "cpp", "c++": "cpp",
};

export const extOf = (name) => (name.includes(".") ? name.split(".").pop().toLowerCase() : "");

// A grammar name, or "text" for none: the editor then shows the file without colors.
export function grammarOf(language) {
  const lower = (language ?? "").toLowerCase();
  const grammar = ALIASES[lower] ?? lower;
  return GRAMMARS.has(grammar) ? grammar : "text";
}

export function languageOf(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".blade.php")) return "html";
  if (lower === "dockerfile" || lower.startsWith(".env")) return "bash";
  return grammarOf(extOf(lower));
}

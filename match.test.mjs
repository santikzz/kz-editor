// Run with `node match.test.mjs`. Checks the spotlight ranking and parsing in match.js.
import assert from "node:assert/strict";
import { excludeSpecs, parseGrep, rankFiles, snippet } from "./match.js";

const files = ["src/index.ts", "src/components/Card.tsx", "test/index.ts.snap", "lib/indexer.ts", "README.md", "src/components/list/index.ts"].map(
  (path) => ({ path, lower: path.toLowerCase() }),
);
const paths = (query) => rankFiles(files, query, 10).items.map((f) => f.path);

assert.deepEqual(paths("index.ts").slice(0, 2), ["src/index.ts", "src/components/list/index.ts"]);
assert.deepEqual(paths("/components/"), ["src/components/Card.tsx", "src/components/list/index.ts"]);
assert.deepEqual(paths("comp card"), ["src/components/Card.tsx"]);
assert.equal(paths("/src/index")[0], "src/index.ts");
assert.equal(paths("ctsx")[0], "src/components/Card.tsx");
assert.deepEqual(paths("xyz"), []);
assert.deepEqual(paths("   "), []);
assert.deepEqual(rankFiles(files, "card", 10).items[0].hits, [15, 16, 17, 18]);

assert.deepEqual(excludeSpecs(["node_modules", "src/gen/", "\\dist", " "]), [
  ":(exclude,glob)**/node_modules",
  ":(exclude,glob)**/node_modules/**",
  ":(exclude,glob)src/gen",
  ":(exclude,glob)src/gen/**",
  ":(exclude,glob)**/dist",
  ":(exclude,glob)**/dist/**",
]);

assert.deepEqual(parseGrep("a.js\x0012\x00  return <div/>\r\nbad line\n", "sub/"), [{ path: "sub/a.js", line: 12, text: "  return <div/>" }]);

assert.deepEqual(snippet("    return <div/>;", "<DIV/>"), { before: "return ", match: "<div/>", after: ";" });
assert.equal(snippet(`${"x".repeat(60)}needle`, "needle").before, `…${"x".repeat(16)}`);

console.log("match.js: ok");

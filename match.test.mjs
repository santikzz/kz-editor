// Run with `node match.test.mjs`. Checks the spotlight ranking and parsing in match.js.
import assert from "node:assert/strict";
import { excerpt, excludeSpecs, findIn, matchLines, indentOf, lineAt, nextOccurrence, offsetOf, parseGrep, rankFiles, replaceAll, replaceOne, snippet } from "./match.js";

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

const code = "let a = 1;\nlet ab = a + A;\n";
assert.equal(findIn(code, "a").matches.length, 4);
assert.deepEqual(findIn(code, "a", { matchCase: true }).matches.map((m) => m.start), [4, 15, 20]);
assert.deepEqual(findIn(code, "\\ba\\b", { regex: true, matchCase: true }).matches, [{ start: 4, end: 5 }, { start: 20, end: 21 }]);
assert.deepEqual(findIn(code, "^", { regex: true }).matches, []);
assert.equal(findIn(code, "(", { regex: true }).error, "Invalid pattern");
assert.equal(findIn("a.b", ".").matches.length, 1);
assert.equal(findIn("x".repeat(10001), "x").capped, true);
assert.equal(replaceOne("ab", "(a)(b)", "$2$1", { regex: true }), "ba");
assert.equal(replaceOne("ab", "ab", "$1", {}), "$1");
assert.equal(replaceAll("a A", "a", "$&", {}), "$& $&");
assert.equal(replaceAll("a1 a2", "a(\\d)", "b$1", { regex: true }), "b1 b2");
assert.deepEqual(nextOccurrence(code, { start: 5, end: 5 }), { start: 4, end: 5 });
assert.deepEqual(nextOccurrence(code, { start: 4, end: 5 }), { start: 20, end: 21 });
assert.deepEqual(nextOccurrence(code, { start: 20, end: 21 }), { start: 4, end: 5 });
assert.equal(nextOccurrence(code, { start: 10, end: 10 }), null);
assert.equal(offsetOf(code, 2), 11);
assert.equal(offsetOf(code, 2, 5), 15);
assert.equal(offsetOf(code, 2, 99), 26);
assert.equal(offsetOf(code, 99), 27);
assert.equal(lineAt(code, 15), 2);
assert.deepEqual(indentOf("a\n  b\n    c\n  d"), { size: 2, tabs: false });
assert.deepEqual(indentOf("a\n    b\n        c\n    d\n     * doc"), { size: 4, tabs: false });
assert.deepEqual(indentOf("a\n\tb\n\t\tc"), { size: 4, tabs: true });
assert.equal(indentOf("a\nb"), null);

assert.deepEqual(excerpt("    let a = 1;", 8, 9), { before: "let ", match: "a", after: " = 1;" });
assert.deepEqual(matchLines(code, findIn(code, "a", { matchCase: true }).matches, 2), [
  { line: 1, before: "let ", match: "a", after: " = 1;" },
  { line: 2, before: "let ", match: "a", after: "b = a + A;" },
]);
assert.deepEqual(matchLines("x\r\ny", [{ start: 3, end: 4 }], 5), [{ line: 2, before: "", match: "y", after: "" }]);

console.log("match.js: ok");

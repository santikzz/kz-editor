// Markdown drawn the way GitHub draws a README: its sizes, spacing and Primer colors.
// marked splits the text into blocks. Paragraphs, lists and tables go to the Herdr TextView,
// which draws inline formatting and keeps text selectable. Everything else is drawn here.
import { div, image, svg } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { appHome, exec, fonts, settings, window } from "herdr";
import * as fs from "fs/promises";
import { lexer } from "./vendor/marked.esm.js";
import { extOf, grammarOf } from "./lang.js";

// Primer colors, as github.com draws a README in each appearance.
const DARK = {
  bg: "#0d1117", text: "#f0f6fc", muted: "#9198a1", rule: "#3d444d", pre: "#151b23",
  alert: { note: "#4493f8", tip: "#3fb950", important: "#ab7df8", warning: "#d29922", caution: "#f85149" },
  code: {
    comment: "#9198a1", keyword: "#ff7b72", string: "#a5d6ff", constant: "#79c0ff", function: "#d2a8ff",
    tag: "#7ee787", inserted: "#aff5b4", deleted: "#ffdcd7",
  },
};
const LIGHT = {
  bg: "#ffffff", text: "#1f2328", muted: "#59636e", rule: "#d1d9e0", pre: "#f6f8fa",
  alert: { note: "#0969da", tip: "#1a7f37", important: "#8250df", warning: "#9a6700", caution: "#cf222e" },
  code: {
    comment: "#59636e", keyword: "#cf222e", string: "#0a3069", constant: "#0550ae", function: "#6639ba",
    tag: "#116329", inserted: "#116329", deleted: "#82071e",
  },
};

const HEADING_SIZES = [32, 24, 20, 16, 14, 13.6];
const BODY_SIZE = 16;
const CODE_SIZE = 13.6;
const CODE_LINE = 20;
const COLUMN = 960;
const PADDING = 32;
const ALERTS = {
  note: ["Note", "info"], tip: ["Tip", "lightbulb"], important: ["Important", "message-square-warning"],
  warning: ["Warning", "triangle-alert"], caution: ["Caution", "octagon-alert"],
};
// GitHub's font stack; the first one this machine has.
const BODY_FONTS = ["Segoe UI", "Noto Sans", "Helvetica", "Arial"];
const CACHE = "mods/kz-editor/.cache";
const IMAGE_TYPES = [["svg", "svg"], ["png", "png"], ["jpeg", "jpg"], ["gif", "gif"], ["webp", "webp"]];
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"]);

export const parentOf = (path) => path.slice(0, path.lastIndexOf("/")) || "/";

// A link or image source as an absolute path, from the file's folder. Null for an anchor alone.
export function resolve(folder, link) {
  let target = link.replace(/^file:\/\//i, "").split("#")[0];
  try {
    target = decodeURIComponent(target);
  } catch {}
  if (!target) return null;
  if (/^\/[a-z]:\//i.test(target)) target = target.slice(1);
  const absolute = /^([a-z]:)?\//i.test(target) ? target : `${folder}/${target}`;
  const parts = [];
  for (const part of absolute.split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return `${absolute.startsWith("/") ? "/" : ""}${parts.join("/")}`;
}

// Code colors. A small tokenizer, not a grammar: comments, strings, numbers, keywords, calls,
// JSON and YAML keys, HTML tags and diff lines, which is most of what a README shows.
const KEYWORDS = new Set(
  ("abstract and as assert async await break case catch class const continue def default defer del delete do elif else " +
    "end enum except export extends final finally fn for from func function global go if impl implements import in " +
    "instanceof interface is lambda let local loop match mod module mut namespace new not of or package pass private " +
    "protected pub public raise readonly return select self static struct super switch then this throw throws trait try " +
    "type typeof unless until use using var void when where while with yield fi done esac echo").split(" "),
);
const CONSTANTS = new Set("true false null nil none undefined True False None NULL".split(" "));
const SLASH_COMMENTS = new Set(["javascript", "java", "c", "cpp", "rust", "go"]);
const HASH_COMMENTS = new Set(["bash", "python", "ruby", "yaml"]);
const DASH_COMMENTS = new Set(["sql", "lua"]);
const BLOCK_COMMENTS = new Set([...SLASH_COMMENTS, "css", "sql"]);
const HTML_TOKEN = /(<!--[\s\S]*?(?:-->|$(?![\s\S])))|(<\/?[A-Za-z][\w:-]*|\/?>)|("[^"]*"?|'[^']*'?)|([\w:-]+(?==))/g;

function codeToken(grammar) {
  const line = [SLASH_COMMENTS.has(grammar) && "\\/\\/.*", HASH_COMMENTS.has(grammar) && "#.*", DASH_COMMENTS.has(grammar) && "--.*"];
  const block = BLOCK_COMMENTS.has(grammar) ? "\\/\\*[\\s\\S]*?(?:\\*\\/|$(?![\\s\\S]))" : "(?!)";
  return new RegExp(
    `(${line.filter(Boolean).join("|") || "(?!)"})|(${block})` +
      "|(\"(?:\\\\.|[^\"\\\\\\n])*\"?|'(?:\\\\.|[^'\\\\\\n])*'?|`(?:\\\\.|[^`\\\\])*`?)" +
      "|(\\b\\d[\\w.]*)|([A-Za-z_$][\\w$]*)",
    "gm",
  );
}

function kindOf(m, rest, grammar) {
  if (grammar === "html") return m[1] ? "comment" : m[2] ? "tag" : m[3] ? "string" : "constant";
  if (m[1] || m[2]) return "comment";
  if (m[3]) return /^\s*:/.test(rest) ? "tag" : "string";
  if (m[4]) return "constant";
  if (grammar === "yaml" && /^\s*:/.test(rest)) return "tag";
  if (KEYWORDS.has(m[5])) return "keyword";
  if (CONSTANTS.has(m[5])) return "constant";
  return /^\s*\(/.test(rest) ? "function" : null;
}

// Lines of colored runs: [[{ text, kind }]].
export function highlight(text, grammar) {
  if (grammar === "diff")
    return text.split("\n").map((line) => {
      const kind = line.startsWith("+") ? "inserted" : line.startsWith("-") ? "deleted" : line.startsWith("@@") ? "constant" : null;
      return line ? [{ text: line, kind }] : [];
    });
  const runs = [];
  if (grammar === "text") runs.push({ text, kind: null });
  else {
    let at = 0;
    for (const m of text.matchAll(grammar === "html" ? HTML_TOKEN : codeToken(grammar))) {
      if (!m[0]) continue;
      if (m.index > at) runs.push({ text: text.slice(at, m.index), kind: null });
      runs.push({ text: m[0], kind: kindOf(m, text.slice(m.index + m[0].length, m.index + m[0].length + 40), grammar) });
      at = m.index + m[0].length;
    }
    runs.push({ text: text.slice(at), kind: null });
  }
  const lines = [[]];
  for (const run of runs)
    run.text.split("\n").forEach((part, i) => {
      if (i) lines.push([]);
      if (part) lines.at(-1).push({ text: part, kind: run.kind });
    });
  return lines;
}

const plain = (tokens = []) => tokens.map((t) => (t.tokens ? plain(t.tokens) : t.type === "image" ? "" : (t.text ?? ""))).join("");
const attr = (tag, name) => new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag)?.[1] ?? null;
const decode = (text) =>
  text.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

// TextView draws <kbd> as plain text, so a key becomes inline code, the closest look it has.
const tidy = (md) => md.replace(/<!--[\s\S]*?-->/g, "").replace(/<kbd>([\s\S]*?)<\/kbd>/gi, (_m, key) => `\`${key}\``);

function htmlImage(tag) {
  const src = attr(tag, "src");
  return src ? { src, alt: attr(tag, "alt") ?? "", width: Number(attr(tag, "width")) || null } : null;
}

// A paragraph of nothing but images (badges, screenshots, linked or not) is drawn as images.
function imagesOf(tokens = []) {
  const images = [];
  for (const t of tokens) {
    if (t.type === "image") images.push({ src: t.href, alt: t.text });
    else if (t.type === "link" && t.tokens?.length === 1 && t.tokens[0].type === "image")
      images.push({ src: t.tokens[0].href, alt: t.tokens[0].text, href: t.href });
    else if (t.type === "html" && /^<img\b/i.test(t.raw.trim()) && htmlImage(t.raw)) images.push(htmlImage(t.raw));
    else if (t.type !== "br" && !(t.type === "text" && !t.text.trim())) return null;
  }
  return images.length ? images : null;
}

// READMEs use HTML for centered logos, badges and titles. Images and text are kept, the tags are not.
function htmlBlocks(raw) {
  const html = raw.replace(/<!--[\s\S]*?-->/g, "").trim();
  if (!html) return [];
  const center = /\balign\s*=\s*["']?center/i.test(html);
  const images = [...html.matchAll(/<img\b[^>]*>/gi)].map(([tag]) => htmlImage(tag)).filter(Boolean);
  const text = decode(html.replace(/<img\b[^>]*>/gi, "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")).trim();
  const heading = /^<h([1-6])\b/i.exec(html);
  const blocks = images.length ? [{ kind: "images", images, center }] : [];
  if (text && heading) blocks.push({ kind: "heading", depth: Number(heading[1]), text, center });
  else if (text) blocks.push({ kind: "text", md: text, center });
  return blocks;
}

export function buildMarkdown(text, light) {
  const blocks = [];
  for (const token of lexer(text, { gfm: true })) {
    if (token.type === "heading") blocks.push({ kind: "heading", depth: token.depth, text: plain(token.tokens) });
    else if (token.type === "paragraph") {
      const images = imagesOf(token.tokens);
      blocks.push(images ? { kind: "images", images } : { kind: "text", md: tidy(token.raw) });
    } else if (token.type === "code") {
      const lang = token.lang?.split(/\s/)[0]?.toLowerCase();
      blocks.push({ kind: "code", text: token.text, lines: highlight(token.text, lang === "diff" ? "diff" : grammarOf(lang)) });
    } else if (token.type === "blockquote") {
      const alert = /^\s*\[!(note|tip|important|warning|caution)\][^\n]*\n?/i.exec(token.text);
      blocks.push(
        alert
          ? { kind: "alert", type: alert[1].toLowerCase(), md: tidy(token.text.slice(alert[0].length)) }
          : { kind: "quote", md: tidy(token.text) },
      );
    } else if (token.type === "hr") blocks.push({ kind: "rule" });
    else if (token.type === "html") blocks.push(...htmlBlocks(token.raw));
    else if (token.type !== "space" && token.type !== "def") blocks.push({ kind: "text", md: tidy(token.raw) });
  }
  return { blocks, palette: light ? LIGHT : DARK };
}

export const imageSources = (md) => md.blocks.flatMap((b) => (b.kind === "images" ? b.images.map((i) => i.src) : []));

function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16);
}

// image() gives an image no layout size of its own, so the size comes from the file: the SVG
// root tag, or the header of a PNG, GIF, JPEG or WebP.
async function imageSize(path) {
  if (path.endsWith(".svg")) {
    const tag = /<svg\b[^>]*>/i.exec(await fs.readFile(`${appHome()}/${path}`, "utf8").catch(() => ""))?.[0] ?? "";
    const box = attr(tag, "viewBox")?.trim().split(/[\s,]+/).map(Number) ?? [];
    const width = parseFloat(attr(tag, "width")) || box[2];
    const height = parseFloat(attr(tag, "height")) || box[3];
    return width > 0 && height > 0 ? { width, height } : null;
  }
  const b = await fs.readFile(`${appHome()}/${path}`).catch(() => null);
  if (!b || b.length < 30) return null;
  const be16 = (i) => (b[i] << 8) | b[i + 1];
  const le16 = (i) => b[i] | (b[i + 1] << 8);
  const le24 = (i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
  const be32 = (i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  if (b[0] === 0x89 && b[1] === 0x50) return { width: be32(16), height: be32(20) };
  if (b[0] === 0x47 && b[1] === 0x49) return { width: le16(6), height: le16(8) };
  if (b[0] === 0xff && b[1] === 0xd8)
    for (let i = 2; i + 9 < b.length && b[i] === 0xff; i += 2 + be16(i + 2)) {
      const marker = b[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: be16(i + 7), height: be16(i + 5) };
    }
  if (String.fromCharCode(b[8], b[9], b[10], b[11]) === "WEBP") {
    const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (chunk === "VP8X") return { width: 1 + le24(24), height: 1 + le24(27) };
    if (chunk === "VP8 ") return { width: le16(26) & 0x3fff, height: le16(28) & 0x3fff };
    if (chunk === "VP8L") return { width: 1 + (le16(21) & 0x3fff), height: 1 + ((le24(22) >> 6) & 0x3fff) };
  }
  return null;
}

// Herdr draws images only from inside its own folder, so each one is copied or downloaded into
// a hidden cache there (hidden files do not reload the mod). Resolves with { path, width, height },
// or null when the image cannot be shown.
export async function loadImage(src, folder, on) {
  const path = await cacheImage(src, folder, on);
  return path ? { path, ...((await imageSize(path)) ?? {}) } : null;
}

async function cacheImage(src, folder, on) {
  const remote = /^https?:\/\//i.test(src);
  if (/^data:/i.test(src) || (!remote && on)) return null;
  const source = remote ? src : resolve(folder, src);
  if (!source) return null;
  await fs.mkdir(`${appHome()}/${CACHE}`, { recursive: true }).catch(() => {});

  // The mod fetch reads only text, so curl downloads. It prints the content type, which names
  // the file: image() tells an SVG from a PNG by its extension.
  if (remote) {
    const download = `${appHome()}/${CACHE}/${hash(source)}.download`;
    const got = await exec("curl", ["-sfL", "--max-time", "20", "-o", download, "-w", "%{content_type}", source], { timeout: 25000 });
    if (got.code !== 0) return null;
    const ext = IMAGE_TYPES.find(([name]) => got.stdout.includes(name))?.[1] ?? (extOf(source.split("?")[0]) || "png");
    const path = `${CACHE}/${hash(source)}.${ext}`;
    const moved = await fileOp("Move-Item", "mv", download, `${appHome()}/${path}`);
    return moved.code === 0 ? path : null;
  }

  const ext = extOf(source);
  if (!IMAGE_EXTS.has(ext)) return null;
  const path = `${CACHE}/${hash(source)}.${ext}`;
  const copied = await fileOp("Copy-Item", "cp", source, `${appHome()}/${path}`);
  return copied.code === 0 ? path : null;
}

// Files are copied and moved by the OS: the mod's fs.writeFile loses binary data.
const fileOp = (powershell, unix, from, to) =>
  window()?.platform === "windows"
    ? exec("powershell", ["-NoProfile", "-Command", `& { param($a, $b) ${powershell} -LiteralPath $a -Destination $b -Force }`, from, to])
    : exec(unix, ["-f", "--", from, to]);

const textView = (id, md, color, actions) =>
  TextView.markdown(id, md)
    .w_full()
    .min_w(0)
    .text_size(BODY_SIZE)
    .text_color(color)
    .scrollable(false)
    .selectable(true)
    .on_link_click((url, cx) => actions.onLink(url, cx));

// A width from the HTML wins, never wider than the column, and the height keeps the aspect ratio.
// An image of unknown size gets a 16:9 box, so the blocks after it never slide under it.
function sized(picture, wanted, loaded, max) {
  const w = Math.min(wanted ?? loaded.width ?? max, max);
  const h = loaded.width && loaded.height ? (w * loaded.height) / loaded.width : (w * 9) / 16;
  return picture.w(w).h(h);
}

function drawImages(block, i, p, shown, actions, max) {
  return h_flex()
    .w_full()
    .flex_wrap()
    .gap(4)
    .when(Boolean(block.center), (el) => el.justify_center())
    .children(
      block.images.map((img, j) => {
        const loaded = shown.get(img.src);
        const picture = loaded
          ? sized(image(loaded.path).flex_none(), img.width, loaded, max)
          : div().text_size(14).text_color(p.muted).child(img.alt || (loaded === null ? "Image not found" : "Loading image"));
        if (!img.href) return picture;
        return div().id(`kz-md-img-${i}-${j}`).cursor_pointer().on_click((_e, cx) => actions.onLink(img.href, cx)).child(picture);
      }),
    );
}

// Rows of colored runs that scroll sideways, and a Copy button, as on GitHub.
function drawCode(block, i, p, actions) {
  return div()
    .id(`kz-md-code-${i}`)
    .relative()
    .w_full()
    .rounded(6)
    .bg(p.pre)
    .child(
      div()
        .id(`kz-md-code-rows-${i}`)
        .w_full()
        .overflow_x_scroll()
        .p(16)
        .child(
          v_flex()
            .font_family(settings().font_family)
            .text_size(CODE_SIZE)
            .children(
              block.lines.map((runs) =>
                h_flex()
                  .h(CODE_LINE)
                  .whitespace_nowrap()
                  .children(runs.map((run) => div().flex_none().text_color(run.kind ? p.code[run.kind] : p.text).child(run.text))),
              ),
            ),
        ),
    )
    .child(
      div()
        .id(`kz-md-copy-${i}`)
        .absolute()
        .top(8)
        .right(8)
        .h(28)
        .px(10)
        .flex()
        .items_center()
        .rounded(6)
        .border_1()
        .border_color(p.rule)
        .bg(p.bg)
        .text_size(12)
        .text_color(p.muted)
        .cursor_pointer()
        .hover((s) => s.text_color(p.text))
        .on_click((_e, cx) => actions.onCopy(i, block.text, cx))
        .child(actions.copied === i ? "Copied" : "Copy"),
    );
}

function drawBlock(block, i, p, shown, actions, max) {
  const id = `kz-md-${i}`;
  if (block.kind === "heading")
    return div()
      .w_full()
      .text_size(HEADING_SIZES[block.depth - 1])
      .font_weight(600)
      .text_color(block.depth === 6 ? p.muted : p.text)
      .when(block.depth <= 2, (el) => el.pb(block.depth === 1 ? 10 : 7).border_b(1).border_color(p.rule))
      .when(Boolean(block.center), (el) => el.text_center())
      .child(block.text);
  if (block.kind === "code") return drawCode(block, i, p, actions);
  if (block.kind === "quote") return div().w_full().border_l(4).border_color(p.rule).pl(16).child(textView(id, block.md, p.muted, actions));
  if (block.kind === "alert") {
    const [title, icon] = ALERTS[block.type];
    const color = p.alert[block.type];
    return v_flex()
      .w_full()
      .border_l(4)
      .border_color(color)
      .pl(16)
      .py(8)
      .gap(8)
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .text_size(BODY_SIZE)
          .font_weight(500)
          .text_color(color)
          .child(svg(`mods/kz-editor/icons/${icon}.svg`).size(16).flex_none().text_color(color))
          .child(title),
      )
      .when(Boolean(block.md.trim()), (el) => el.child(textView(id, block.md, p.text, actions)));
  }
  if (block.kind === "rule") return div().w_full().h(4).bg(p.rule);
  if (block.kind === "images") return drawImages(block, i, p, shown, actions, max);
  return textView(id, block.md, p.text, actions).when(Boolean(block.center), (el) => el.text_center());
}

// shown: image source to { path, width, height } (null: cannot be shown, missing: still loading).
// actions: { onLink(url, cx), onCopy(index, text, cx), copied }. width: the pane's width.
export function renderMarkdown(md, shown, actions, width) {
  const p = md.palette;
  const font = BODY_FONTS.find((name) => fonts().includes(name));
  const max = Math.max(120, Math.min(width || COLUMN, COLUMN) - PADDING * 2);
  // GitHub gives every block 16 px below and headings and rules 24 px above; the larger wins.
  const gap = (block, i) => (i === 0 ? 0 : block.kind === "heading" || block.kind === "rule" ? 24 : 16);
  return v_flex()
    .id("kz-preview")
    .flex_1()
    .min_h(0)
    .overflow_y_scrollbar()
    .bg(p.bg)
    .child(
      v_flex()
        .w_full()
        .max_w(COLUMN)
        .mx_auto()
        .p(PADDING)
        .text_size(BODY_SIZE)
        .text_color(p.text)
        .when(Boolean(font), (el) => el.font_family(font))
        .children(md.blocks.map((block, i) => drawBlock(block, i, p, shown, actions, max).mt(gap(block, i)))),
    );
}

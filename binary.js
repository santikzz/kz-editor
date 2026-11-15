// Images and PDFs. Herdr draws images only from inside its own folder, so an image is copied,
// and a PDF rendered to one PNG per page, into the mod's cache first. A change on disk loads
// the file again. Both zoom; an image pans, a PDF goes to a page and finds text.
import { div, image } from "gpui-kit";
import { v_flex, h_flex, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { appHome, exec, watchFolder, window } from "herdr";
import * as fs from "fs/promises";
import { extOf } from "./lang.js";
import { CACHE, fileOp, hash, imageSize, parentOf, ps } from "./markdown.js";
import { normalize } from "./tree.js";
import { button, iconButton } from "./ui.js";

const IMAGES = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tif", "tiff"]);
const PAD = 24;
const GAP = 16;
const COLUMN = 960;
const PAGE_PX = 1200;
// ponytail: a page decoded at 1200 px takes about 7 MB, so only the first 50 pages show.
// The button in the toolbar opens the whole file in the system viewer.
const MAX_PAGES = 50;
const FIRST_PAGES = 2;
const BATCH = 12;
const TEXT_BATCH = 10;
// A page is drawn as strips, so the list can bring a part of a page into view: a match, the next lines.
const STRIPS = 8;
const FOOTER = 56;
const LEVELS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 6, 8];
// Past 4 a PDF page is drawn larger than it was rendered.
const MAX_ZOOM = { image: 8, pdf: 4 };
const WHEEL_ZOOM = 0.003;
// Find marks lie over the page, so the words show through them. A PDF page is paper, whatever the theme.
const MATCH = "#3b82f659";
const CURRENT = "#1d4ed880";
const CURRENT_EDGE = "#1d4ed8";

export const viewerOf = (path) => (IMAGES.has(extOf(path)) ? "image" : extOf(path) === "pdf" ? "pdf" : null);

const windows = () => window()?.platform === "windows";
const backslashes = (path) => path.replace(/\//g, "\\");
const ctrlOf = (e) => e.modifiers.control || e.modifiers.platform;

// Windows renders PDF pages itself (Windows.Data.Pdf). PowerShell 5 waits on WinRT tasks
// through AsTask. One line: the arguments after -Command are joined into one command.
const WINDOWS_OPEN = [
  "$ErrorActionPreference = 'Stop'",
  "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
  "Add-Type -AssemblyName System.Runtime.WindowsRuntime",
  "$m = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 }",
  "$op = $m | Where-Object { $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' }",
  "$act = $m | Where-Object { $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' }",
  "function Await($o, $t) { $k = $op.MakeGenericMethod($t).Invoke($null, @($o)); $k.Wait(-1) | Out-Null; $k.Result }",
  "$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]",
  "$null = [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime]",
  "$null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]",
  "$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($pdf)) ([Windows.Storage.StorageFile])",
  "$doc = Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])",
].join("; ");
const EACH_PAGE =
  "for ($i = $from; $i -lt [Math]::Min($doc.PageCount, $to); $i++) { $page = $doc.GetPage($i); " +
  "$options = New-Object Windows.Data.Pdf.PdfPageRenderOptions; $options.DestinationWidth = $width; " +
  "$stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream; " +
  "$act.Invoke($null, @($page.RenderToStreamAsync($stream, $options))).Wait(-1) | Out-Null";

// Prints the page count and the first page's width in px at 100 %, and writes <out>/<index>.png.
const WINDOWS_RENDER = [
  WINDOWS_OPEN,
  "[Console]::Out.WriteLine(('{0} {1}' -f $doc.PageCount, $(if ($doc.PageCount) { [int]$doc.GetPage(0).Size.Width } else { 0 })))",
  `${EACH_PAGE}; $source = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream.GetInputStreamAt(0)); ` +
    "$target = [System.IO.File]::Create((Join-Path $out ('{0}.png' -f $i))); $source.CopyTo($target); $target.Close(); $page.Dispose() }",
].join("; ");

// Windows.Data.Pdf gives no text, so Windows reads the words off each page with its own text
// recognition (Windows.Media.Ocr). Prints "P index width height" for a page, then
// "W line x y w h word" for each word, in pixels, separated by tabs.
const WINDOWS_TEXT = [
  WINDOWS_OPEN,
  "$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]",
  "$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]",
  "$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()",
  "if (-not $engine) { throw 'Windows has no text recognition for your languages' }",
  `${EACH_PAGE}; $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder]); ` +
    "$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap]); " +
    "$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult]); " +
    "[Console]::Out.WriteLine(('P\t{0}\t{1}\t{2}' -f $i, $bitmap.PixelWidth, $bitmap.PixelHeight)); $n = 0; " +
    "foreach ($line in $result.Lines) { foreach ($w in $line.Words) { $r = $w.BoundingRect; " +
    "[Console]::Out.WriteLine(('W\t{0}\t{1}\t{2}\t{3}\t{4}\t{5}' -f $n, [int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height, $w.Text)) }; $n++ }; " +
    "$page.Dispose() }",
].join("; ");

async function powershell(script, pdf, out, from, to) {
  const values = `$pdf = ${ps(backslashes(pdf))}; $out = ${ps(backslashes(out))}; $width = ${PAGE_PX}; $from = ${from}; $to = ${to}`;
  const r = await exec("powershell", ["-NoProfile", "-Command", `${values}; ${script}`], { timeout: 120000 });
  if (r.code !== 0) throw new Error(r.stderr.trim().split("\n")[0] || "PowerShell failed");
  return r.stdout;
}

// Renders pages [from, to) to <out>/<index>.png. Returns the page count and the width of the
// first page in px at 100 % (96 per inch).
async function renderPages(pdf, out, from, to) {
  if (windows()) {
    const [count, width] = (await powershell(WINDOWS_RENDER, pdf, out, from, to)).trim().split(/\s+/).map(Number);
    return { count: count || 0, width: width || 816 };
  }
  const info = await exec("pdfinfo", [pdf]);
  if (info.code !== 0) throw new Error(info.stderr.trim().split("\n")[0] || "pdfinfo failed");
  const count = Number(/^Pages:\s+(\d+)/m.exec(info.stdout)?.[1]) || 0;
  const points = Number(/^Page size:\s+([\d.]+)/m.exec(info.stdout)?.[1]) || 612;
  for (let i = from; i < Math.min(count, to); i++) {
    const n = String(i + 1);
    const r = await exec("pdftoppm", ["-png", "-singlefile", "-f", n, "-l", n, "-scale-to-x", String(PAGE_PX), "-scale-to-y", "-1", pdf, `${out}/${i}`], { timeout: 60000 });
    if (r.code !== 0) throw new Error(r.stderr.trim().split("\n")[0] || "pdftoppm failed");
  }
  return { count, width: (points * 96) / 72 };
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" };
const decode = (text) => text.replace(/&(amp|lt|gt|quot|apos|#39);/g, (_m, e) => ENTITIES[e]);

// The words of pages [from, to), by page index: { lines: [[{ text, x, y, w, h }]] }, where
// the box is a share of the page, so it fits the page at any zoom.
async function readText(pdf, from, to) {
  const pages = new Map();
  if (windows()) {
    let page = null;
    for (const row of (await powershell(WINDOWS_TEXT, pdf, "", from, to)).split(/\r?\n/)) {
      const f = row.split("\t");
      if (f[0] === "P") pages.set(Number(f[1]), (page = { width: Number(f[2]), height: Number(f[3]), lines: [] }));
      else if (f[0] === "W" && page)
        (page.lines[Number(f[1])] ??= []).push({
          text: f.slice(6).join("\t"),
          x: f[2] / page.width,
          y: f[3] / page.height,
          w: f[4] / page.width,
          h: f[5] / page.height,
        });
    }
    return pages;
  }
  const r = await exec("pdftotext", ["-bbox-layout", "-f", String(from + 1), "-l", String(to), pdf, "-"], { timeout: 60000 });
  if (r.code !== 0) throw new Error(r.stderr.trim().split("\n")[0] || "pdftotext failed");
  let index = from;
  for (const part of r.stdout.split("<page ").slice(1)) {
    const width = Number(/width="([\d.]+)"/.exec(part)?.[1]) || 1;
    const height = Number(/height="([\d.]+)"/.exec(part)?.[1]) || 1;
    const words = /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g;
    const lines = part
      .split("<line")
      .slice(1)
      .map((line) =>
        [...line.matchAll(words)].map((m) => ({
          text: decode(m[5]),
          x: m[1] / width,
          y: m[2] / height,
          w: (m[3] - m[1]) / width,
          h: (m[4] - m[2]) / height,
        })),
      );
    pages.set(index++, { lines });
  }
  return pages;
}

// Every place the query is, in page order: { page, rects }. Words on one line are joined with
// one space, so a query of several words is found too, but not across two lines.
function findAll(text, query) {
  const q = query.trim().replace(/\s+/g, " ").toLowerCase();
  const out = [];
  if (!q) return out;
  text.forEach((page, index) => {
    for (const line of page?.lines ?? []) {
      if (!line?.length) continue;
      let joined = "";
      const starts = line.map((w) => {
        if (joined) joined += " ";
        const at = joined.length;
        joined += w.text.toLowerCase();
        return at;
      });
      for (let at = joined.indexOf(q); at !== -1; at = joined.indexOf(q, at + q.length)) {
        const end = at + q.length;
        out.push({ page: index, rects: line.filter((w, k) => starts[k] < end && starts[k] + w.text.length > at) });
      }
    }
  });
  return out;
}

async function removeFolder(folder) {
  const dir = `${appHome()}/${folder}`;
  for (const name of await fs.readdir(dir).catch(() => [])) await fs.unlink(`${dir}/${name}`).catch(() => {});
  await fs.rmdir(dir).catch(() => {});
}

const sizeText = (bytes) =>
  bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;

// The next zoom level up or down from a scale.
const stepZoom = (scale, dir) =>
  dir > 0 ? (LEVELS.find((z) => z > scale * 1.01) ?? LEVELS.at(-1)) : ([...LEVELS].reverse().find((z) => z < scale * 0.99) ?? LEVELS[0]);

// The picture at its own size, made smaller to fit the box. A size the header did not give
// fills the box: GPUI keeps the aspect ratio.
function imageView(picture, box, t) {
  const room = { w: Math.max(box.width - 2 * PAD, 16), h: Math.max(box.height - 2 * PAD, 16) };
  const scale = picture.width && picture.height ? Math.min(1, room.w / picture.width, room.h / picture.height) : null;
  return div()
    .flex_1()
    .min_h(0)
    .p(PAD)
    .flex()
    .items_center()
    .justify_center()
    .bg(t.background)
    .child(scale ? image(picture.path).w(picture.width * scale).h(picture.height * scale) : image(picture.path).size_full());
}

// An SVG drawn from the editor's text, so the preview shows unsaved edits too.
export async function cacheSvg(text) {
  const path = `${CACHE}/${hash(text)}.svg`;
  await fs.mkdir(`${appHome()}/${CACHE}`, { recursive: true }).catch(() => {});
  await fs.writeFile(`${appHome()}/${path}`, text);
  return { path, ...((await imageSize(path)) ?? {}) };
}

// ui: what the file tab keeps for every file it shows: { focus, list, find, page, pageFocused }.
export class Binary {
  constructor(file, kind, ui) {
    this.file = file;
    this.kind = kind;
    this.ui = ui;
    this.version = 0;
    this.pages = [];
    this.zoom = null;
    this.offset = { x: 0, y: 0 };
    this.box = { width: 800, height: 600 };
    this.current = 0;
    this.find = null;
    this.text = null;
  }

  start(cx) {
    if (this.file.on) {
      this.problem = "Images and PDFs on another machine cannot be shown yet.";
      return;
    }
    cx.spawn(async (cx) => this.load(cx));
    // The cache's own writes are left out: a file in the mod's folder would load forever.
    cx.spawn(async (cx) => {
      const path = this.file.path;
      const dir = parentOf(path);
      const cache = normalize(`${appHome()}/${CACHE}`);
      while (!this.closed) {
        const changed = await watchFolder(dir).catch(() => null);
        if (this.closed || !changed) return;
        if (changed.map(normalize).some((p) => !p.startsWith(cache) && (p === path || p === dir))) await this.load(cx);
      }
    });
  }

  // Each load writes to a new folder, as Herdr keeps an image it drew by its path.
  async load(cx) {
    const version = ++this.version;
    const folder = `${CACHE}/${hash(this.file.path)}-${Date.now()}`;
    const stale = () => this.closed || version !== this.version;
    this.text = null;
    await fs.mkdir(`${appHome()}/${folder}`, { recursive: true }).catch(() => {});
    try {
      if (this.kind === "image") await this.loadImage(folder, stale);
      else await this.loadPdf(folder, stale, cx);
      if (stale()) return removeFolder(folder);
      this.problem = null;
    } catch (e) {
      if (stale()) return removeFolder(folder);
      this.problem = `${this.kind === "pdf" ? "This PDF" : "This image"} cannot be shown: ${e?.message ?? e}`;
      if (this.kind === "pdf" && !windows()) this.problem += ". PDF pages need pdftoppm and pdfinfo (poppler).";
      removeFolder(folder);
    }
    if (this.find && !stale()) this.readAll(cx);
    cx.notify();
  }

  async loadImage(folder, stale) {
    const path = `${folder}/image.${extOf(this.file.path)}`;
    const copied = await fileOp("Copy-Item", "cp", this.file.path, `${appHome()}/${path}`);
    if (copied.code !== 0) throw new Error(copied.stderr.trim().split("\n")[0] || "the copy failed");
    const bytes = (await fs.readFile(`${appHome()}/${path}`)).length;
    const size = await imageSize(path);
    if (stale()) return;
    this.swap(folder);
    this.picture = { path, bytes, ...(size ?? {}) };
  }

  // The first pages show at once, the rest as each batch is ready.
  async loadPdf(folder, stale, cx) {
    const pages = [];
    let from = 0;
    let to = FIRST_PAGES;
    for (;;) {
      const { count, width } = await renderPages(this.file.path, `${appHome()}/${folder}`, from, to);
      if (stale()) return;
      for (let i = from; i < Math.min(count, to); i++) {
        const path = `${folder}/${i}.png`;
        pages.push({ path, ...((await imageSize(path)) ?? { width: 1, height: 1.294 }) });
      }
      if (stale()) return;
      if (from === 0) {
        this.swap(folder);
        if (this.version === 1) {
          this.ui.page.set_value("1");
          this.ui.list.scroll_to_item(0, "top");
        }
      }
      this.pages = pages;
      this.count = count;
      this.natural = width;
      this.rendering = pages.length < Math.min(count, MAX_PAGES);
      cx.notify();
      if (!this.rendering) return;
      from = to;
      to = Math.min(from + BATCH, MAX_PAGES);
    }
  }

  // Older folders of this file go too: a mod reload or a crash leaves them without a close().
  async swap(folder) {
    this.folder = folder;
    const prefix = `${hash(this.file.path)}-`;
    for (const name of await fs.readdir(`${appHome()}/${CACHE}`).catch(() => []))
      if (name.startsWith(prefix) && `${CACHE}/${name}` !== this.folder) removeFolder(`${CACHE}/${name}`);
  }

  close() {
    this.closed = true;
    if (this.folder) return removeFolder(this.folder);
  }

  info() {
    if (this.problem) return null;
    if (this.kind === "image")
      return this.picture ? [this.picture.width && `${this.picture.width} × ${this.picture.height}`, sizeText(this.picture.bytes)].filter(Boolean).join("  ·  ") : null;
    if (this.count === undefined) return null;
    const pages = `${this.count} ${this.count === 1 ? "page" : "pages"}`;
    if (this.rendering) return `Rendering ${this.pages.length + 1} of ${pages}`;
    return this.count > MAX_PAGES ? `${MAX_PAGES} of ${pages}` : null;
  }

  // Zoom. A scale of 1 is the image's own pixels, or the PDF page at 96 px per inch.
  // null fits: the image to the box, the PDF page to the column.
  canZoom() {
    return this.kind === "image" ? Boolean(this.picture?.width && this.picture?.height) : this.pages.length > 0;
  }

  fit() {
    if (this.kind === "pdf") return Math.min(COLUMN, Math.max(this.box.width - 2 * PAD, 100)) / this.natural;
    const p = this.picture;
    return Math.min(1, Math.max(this.box.width - 2 * PAD, 16) / p.width, Math.max(this.box.height - 2 * PAD, 16) / p.height);
  }

  scale() {
    return this.zoom ?? this.fit();
  }

  // anchor: a point of the box that stays over the same pixel of the image (the pointer).
  setZoom(next, anchor, cx) {
    if (!this.canZoom()) return;
    const zoom = next === null ? null : Math.min(MAX_ZOOM[this.kind], Math.max(LEVELS[0], next));
    if (this.kind === "image" && zoom !== null) {
      const s = this.scale();
      const at = this.imageAt(s);
      const a = anchor ?? { x: this.box.width / 2, y: this.box.height / 2 };
      this.offset = this.clampAt({ x: a.x - ((a.x - at.x) * zoom) / s, y: a.y - ((a.y - at.y) * zoom) / s }, zoom);
    }
    this.zoom = zoom;
    // The strip at the top stays at the top.
    if (this.kind === "pdf" && this.range) this.ui.list.scroll_to_item(this.range.start, "top");
    cx.notify();
  }

  zoomBy(dir, cx) {
    if (this.canZoom()) this.setZoom(stepZoom(this.scale(), dir), null, cx);
  }

  // Where the image's top left corner is at a scale: centered on an axis where it fits.
  clampAt(at, s) {
    const axis = (pos, size, room) => (size <= room ? (room - size) / 2 : Math.min(0, Math.max(room - size, pos)));
    return { x: axis(at.x, this.picture.width * s, this.box.width), y: axis(at.y, this.picture.height * s, this.box.height) };
  }

  imageAt(s) {
    return this.clampAt(this.zoom === null ? { x: 0, y: 0 } : this.offset, s);
  }

  // ctrl+wheel zooms at the pointer. Without ctrl, the wheel moves a zoomed image.
  wheel(e, cx) {
    if (ctrlOf(e)) return this.setZoom(this.scale() * Math.exp(e.delta.y * WHEEL_ZOOM), e.local_position ?? null, cx);
    if (this.kind !== "image" || this.zoom === null) return;
    const dx = e.modifiers.shift ? e.delta.y : e.delta.x;
    const dy = e.modifiers.shift ? 0 : e.delta.y;
    this.offset = this.clampAt({ x: this.imageAt(this.zoom).x + dx, y: this.imageAt(this.zoom).y + dy }, this.zoom);
    cx.notify();
  }

  // PDF pages: the current page is the one with the most of its strips on screen.
  currentPage() {
    const r = this.range;
    if (!r || !this.geometry?.length) return 0;
    const shown = new Map();
    for (let i = r.start; i < Math.min(r.end, this.geometry.length); i++) {
      const g = this.geometry[i];
      shown.set(g.page, (shown.get(g.page) ?? 0) + g.height);
    }
    let best = this.current;
    let most = -1;
    for (const [page, height] of shown)
      if (height > most) {
        best = page;
        most = height;
      }
    return best;
  }

  // Called on a timer: the list scrolls without a render, so the page number follows here.
  sync(cx) {
    if (this.kind !== "pdf" || this.closed) return;
    const page = this.currentPage();
    if (page === this.current) return;
    this.current = page;
    if (!this.ui.pageFocused) this.ui.page.set_value(String(page + 1));
    cx.notify();
  }

  goToPage(page, cx) {
    if (!this.pages.length || Number.isNaN(page)) return;
    const n = Math.max(0, Math.min(this.pages.length - 1, page));
    this.ui.list.scroll_to_item(n * STRIPS, "top");
    this.current = n;
    this.ui.page.set_value(String(n + 1));
    cx.notify();
  }

  // One strip, about an eighth of a page.
  scrollBy(dir) {
    if (!this.range || !this.geometry?.length) return;
    this.ui.list.scroll_to_item(Math.max(0, Math.min(this.geometry.length - 1, this.range.start + dir)), "top");
  }

  key(e, cx) {
    const k = e.key;
    if (ctrlOf(e)) {
      if (k === "f") this.openFind(cx);
      else if (k === "=" || k === "+") this.zoomBy(1, cx);
      else if (k === "-") this.zoomBy(-1, cx);
      else if (k === "0") this.setZoom(null, null, cx);
      else return;
      return cx.stop_propagation();
    }
    if (k === "escape" && this.find) return this.closeFind(cx);
    if (this.kind !== "pdf" || !this.ui.focus.is_focused()) return;
    if (k === "pagedown" || k === "right") this.goToPage(this.current + 1, cx);
    else if (k === "pageup" || k === "left") this.goToPage(this.current - 1, cx);
    else if (k === "home") this.goToPage(0, cx);
    else if (k === "end") this.goToPage(this.pages.length - 1, cx);
    else if (k === "down") this.scrollBy(1);
    else if (k === "up") this.scrollBy(-1);
    else return;
    cx.stop_propagation();
  }

  // Find. The text is read once per load, ten pages at a time; matches show as they come.
  openFind(cx) {
    if (this.kind !== "pdf" || !this.pages.length) return;
    this.find ??= { query: "", matches: [], index: -1, byPage: new Map() };
    const value = this.ui.find.value();
    this.ui.find.set_selected_range({ start: 0, end: value.length });
    this.ui.find.focus();
    if (!this.text) this.readAll(cx);
    this.search(cx);
  }

  closeFind(cx) {
    this.find = null;
    this.ui.focus.focus();
    cx.notify();
  }

  readAll(cx) {
    const version = this.version;
    const total = Math.min(this.count ?? 0, MAX_PAGES);
    this.text = [];
    this.reading = { read: 0, total, problem: null };
    cx.spawn(async (cx) => {
      try {
        for (let from = 0; from < total; from += TEXT_BATCH) {
          const pages = await readText(this.file.path, from, Math.min(from + TEXT_BATCH, total));
          if (this.closed || version !== this.version) return;
          for (const [i, page] of pages) this.text[i] = page;
          this.reading.read = Math.min(from + TEXT_BATCH, total);
          this.search(cx);
        }
      } catch (e) {
        if (version === this.version) this.reading.problem = `The text cannot be read: ${e?.message ?? e}`;
      }
      if (version === this.version) this.reading.done = true;
      cx.notify();
    });
  }

  // A new query goes to its first match from the current page on. More text keeps the place.
  search(cx) {
    const f = this.find;
    if (!f) return;
    const query = this.ui.find.value();
    const fresh = query !== f.query || f.index < 0;
    f.query = query;
    f.matches = findAll(this.text ?? [], query);
    if (fresh) f.index = f.matches.length ? Math.max(0, f.matches.findIndex((m) => m.page >= this.current)) : -1;
    this.mark();
    if (fresh) this.reveal();
    cx.notify();
  }

  step(dir, cx) {
    const f = this.find;
    if (!f?.matches.length) return;
    f.index = (f.index + dir + f.matches.length) % f.matches.length;
    this.mark();
    this.reveal();
    cx.notify();
  }

  mark() {
    const f = this.find;
    f.byPage = new Map();
    f.matches.forEach((m, i) => {
      if (!f.byPage.has(m.page)) f.byPage.set(m.page, []);
      f.byPage.get(m.page).push(...m.rects.map((r) => ({ r, current: i === f.index })));
    });
  }

  reveal() {
    const m = this.find?.matches[this.find.index];
    if (!m) return;
    const strip = Math.min(STRIPS - 1, Math.max(0, Math.floor(m.rects[0].y * STRIPS)));
    this.ui.list.scroll_to_item(m.page * STRIPS + strip, "center");
  }

  // Toolbar controls: page, zoom, find.
  controls(t) {
    if (this.problem) return [];
    const out = [];
    if (this.kind === "pdf" && this.pages.length) {
      out.push(
        h_flex()
          .gap(2)
          .items_center()
          .child(iconButton("kz-page-prev", "chevron-up", t, (cx) => this.goToPage(this.current - 1, cx), this.current > 0))
          .child(Input.new(this.ui.page).w(34).h(22).px(4).rounded(4).border_1().border_color(t.input).bg(t.background).text_size(12).text_color(t.foreground))
          .child(div().pl(2).text_color(t.dim).child(`/ ${this.pages.length}`))
          .child(iconButton("kz-page-next", "chevron-down", t, (cx) => this.goToPage(this.current + 1, cx), this.current < this.pages.length - 1)),
      );
    }
    if (this.canZoom())
      out.push(
        h_flex()
          .gap(2)
          .items_center()
          .child(iconButton("kz-zoom-out", "minus", t, (cx) => this.zoomBy(-1, cx)))
          .child(button("kz-zoom-actual", `${Math.round(this.scale() * 100)}%`, t, (cx) => this.setZoom(1, null, cx)).min_w(48).justify_center())
          .child(iconButton("kz-zoom-in", "plus", t, (cx) => this.zoomBy(1, cx)))
          .child(button("kz-zoom-fit", "Fit", t, (cx) => this.setZoom(null, null, cx)).when(this.zoom === null, (el) => el.bg(t.selected).text_color(t.foreground))),
      );
    if (this.kind === "pdf" && this.pages.length) out.push(iconButton("kz-find", "search", t, (cx) => this.openFind(cx)));
    return out;
  }

  view(t, box) {
    this.box = box;
    const message = (text) => div().p(16).text_color(t.dim).child(text);
    let body;
    if (this.problem) body = message(this.problem);
    else if (this.kind === "image") body = !this.picture ? message("Loading…") : this.canZoom() ? this.imageArea(t) : imageView(this.picture, box, t);
    else if (!this.pages.length) body = message(this.count === 0 ? "This PDF has no pages." : "Rendering…");
    else body = this.pdfArea(t);
    return v_flex()
      .id("kz-binary")
      .track_focus(this.ui.focus)
      .flex_1()
      .min_h(0)
      .on_key_down((e, cx) => this.key(e, cx))
      .when(Boolean(this.find), (el) => el.child(this.findBar(t)))
      .child(body);
  }

  // A double-click switches between fit and the image's own size.
  imageArea(t) {
    const p = this.picture;
    const s = this.scale();
    const at = this.imageAt(s);
    const movable = this.zoom !== null && (p.width * s > this.box.width || p.height * s > this.box.height);
    return div()
      .id("kz-image")
      .relative()
      .flex_1()
      .min_h(0)
      .overflow_hidden()
      .bg(t.background)
      .when(movable, (el) => (this.drag ? el.cursor_grabbing() : el.cursor_grab()))
      .on_scroll_wheel((e, cx) => this.wheel(e, cx))
      .on_mouse_down("left", (e, cx) => {
        this.ui.focus.focus();
        this.pointer = e.local_position ?? null;
        if (movable) this.drag = { x: e.position.x, y: e.position.y, at };
        cx.notify();
      })
      .on_mouse_move((e, cx) => {
        if (!this.drag) return;
        this.offset = this.clampAt({ x: this.drag.at.x + e.position.x - this.drag.x, y: this.drag.at.y + e.position.y - this.drag.y }, this.zoom);
        cx.notify();
      })
      .on_mouse_up("left", (_e, cx) => {
        this.drag = null;
        cx.notify();
      })
      .on_hover((hovered, cx) => {
        if (hovered || !this.drag) return;
        this.drag = null;
        cx.notify();
      })
      .on_click((e, cx) => {
        if (e.click_count === 2) this.setZoom(this.zoom === null ? 1 : null, this.pointer ?? null, cx);
      })
      .child(image(p.path).absolute().left(at.x).top(at.y).w(p.width * s).h(p.height * s));
  }

  pdfArea(t) {
    const width = Math.round(this.natural * this.scale());
    const more = this.count > MAX_PAGES && !this.rendering;
    const geometry = [];
    const sizes = [];
    this.pages.forEach((p, n) => {
      const pageHeight = Math.round((width * p.height) / p.width);
      const lastPage = n === this.pages.length - 1;
      for (let s = 0; s < STRIPS; s++) {
        const top = Math.round((s * pageHeight) / STRIPS);
        const g = {
          page: n,
          top,
          height: Math.round(((s + 1) * pageHeight) / STRIPS) - top,
          pageHeight,
          first: s === 0,
          last: s === STRIPS - 1,
          before: n === 0 && s === 0 ? PAD : 0,
        };
        const after = g.last ? (lastPage && !more ? PAD : GAP) : 0;
        geometry.push(g);
        sizes.push(g.before + (g.first ? 1 : 0) + g.height + (g.last ? 1 : 0) + after);
      }
    });
    if (more) sizes.push(FOOTER);
    this.geometry = geometry;

    const marks = (g) =>
      (this.find?.byPage.get(g.page) ?? [])
        .filter(({ r }) => (r.y + r.h) * g.pageHeight + 3 > g.top && r.y * g.pageHeight - 3 < g.top + g.height)
        .map(({ r, current }) =>
          div()
            .absolute()
            .left(r.x * width - 2)
            .top(r.y * g.pageHeight - g.top - 2)
            .w(r.w * width + 4)
            .h(r.h * g.pageHeight + 4)
            .rounded(2)
            .bg(current ? CURRENT : MATCH)
            .when(current, (el) => el.border(2).border_color(CURRENT_EDGE)),
        );
    const strip = (i) => {
      const g = geometry[i];
      if (!g) return div().h(FOOTER).w_full().flex().items_center().justify_center().text_color(t.dim).child(`Showing the first ${MAX_PAGES} of ${this.count} pages.`);
      return div()
        .h(sizes[i])
        .w_full()
        .flex()
        .flex_col()
        .items_center()
        .pt(g.before)
        .child(
          div()
            .w(width + 2)
            .border_x(1)
            .border_color(t.border)
            .when(g.first, (el) => el.border_t(1))
            .when(g.last, (el) => el.border_b(1))
            .child(
              div()
                .relative()
                .w(width)
                .h(g.height)
                .overflow_hidden()
                .child(image(this.pages[g.page].path).absolute().left(0).top(-g.top).w(width).h(g.pageHeight))
                .children(marks(g)),
            ),
        );
    };

    const id = `kz-pdf-${this.folder}`;
    const wide = width + 2 + 2 * PAD > this.box.width;
    return div()
      .relative()
      .flex_1()
      .min_h(0)
      .bg(t.canvas ?? t.background)
      .on_mouse_down("left", () => this.ui.focus.focus())
      .on_scroll_wheel((e, cx) => {
        if (ctrlOf(e)) this.setZoom(this.scale() * Math.exp(e.delta.y * WHEEL_ZOOM), null, cx);
      })
      .child(
        div()
          .id(`${id}-x`)
          .size_full()
          .overflow_x_scroll()
          .child(
            v_virtual_list(id, sizes.length, sizes, (i) => `${this.folder}-${i}`, (range) => {
              this.range = range;
              const out = [];
              for (let i = range.start; i < range.end; i++) out.push(strip(i));
              return out;
            })
              .track_scroll(this.ui.list)
              .w(wide ? width + 2 + 2 * PAD : this.box.width)
              .h_full(),
          ),
      )
      .child(Scrollbar.vertical(id).absolute().inset_0())
      .when(wide, (el) => el.child(Scrollbar.horizontal(`${id}-x`).absolute().inset_0()));
  }

  findBar(t) {
    const f = this.find;
    const r = this.reading ?? {};
    const reading = !r.done && !r.problem ? ` · reading page ${Math.min(r.read + 1, r.total)} of ${r.total}` : "";
    const status =
      r.problem ??
      (!f.query.trim()
        ? reading.slice(3)
        : f.matches.length
          ? `${f.index + 1} of ${f.matches.length}${reading}`
          : r.done
            ? "No results"
            : `Searching${reading}`);
    return h_flex()
      .id("kz-find-bar")
      .h(34)
      .flex_none()
      .px(12)
      .gap(6)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .bg(t.surface)
      .text_size(12)
      .child(Input.new(this.ui.find).w(240).h(24).px(8).rounded(4).border_1().border_color(t.accent).bg(t.background).text_size(12).text_color(t.foreground))
      .child(div().flex_1().min_w(0).truncate().text_color(r.problem ? t.ansi1 : t.dim).child(status))
      .child(iconButton("kz-find-prev", "chevron-up", t, (cx) => this.step(-1, cx), f.matches.length > 0))
      .child(iconButton("kz-find-next", "chevron-down", t, (cx) => this.step(1, cx), f.matches.length > 0))
      .child(iconButton("kz-find-close", "x", t, (cx) => this.closeFind(cx)));
  }
}

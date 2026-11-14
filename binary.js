// Images and PDFs. Herdr draws images only from inside its own folder, so an image is copied,
// and a PDF rendered to one PNG per page, into the mod's cache first. A change on disk loads
// the file again.
import { div, image, list } from "gpui-kit";
import { v_flex, Scrollbar } from "gpui-base";
import { appHome, exec, watchFolder, window } from "herdr";
import * as fs from "fs/promises";
import { extOf } from "./lang.js";
import { CACHE, fileOp, hash, imageSize, parentOf, ps } from "./markdown.js";
import { normalize } from "./tree.js";

const IMAGES = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tif", "tiff"]);
const PAD = 24;
const COLUMN = 960;
const PAGE_PX = 1200;
// ponytail: a page decoded at 1200 px takes about 7 MB, so only the first 50 pages show.
// The button in the toolbar opens the whole file in the system viewer.
const MAX_PAGES = 50;
const FIRST_PAGES = 2;
const BATCH = 12;

export const viewerOf = (path) => (IMAGES.has(extOf(path)) ? "image" : extOf(path) === "pdf" ? "pdf" : null);

const windows = () => window()?.platform === "windows";
const backslashes = (path) => path.replace(/\//g, "\\");

// Windows renders PDF pages itself (Windows.Data.Pdf). PowerShell 5 waits on WinRT tasks
// through AsTask. One line: the arguments after -Command are joined into one command.
const WINDOWS_PDF = [
  "$ErrorActionPreference = 'Stop'",
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
  "[Console]::Out.WriteLine($doc.PageCount)",
  "for ($i = $from; $i -lt [Math]::Min($doc.PageCount, $to); $i++) {" +
    " $page = $doc.GetPage($i); $options = New-Object Windows.Data.Pdf.PdfPageRenderOptions; $options.DestinationWidth = $width;" +
    " $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream;" +
    " $act.Invoke($null, @($page.RenderToStreamAsync($stream, $options))).Wait(-1) | Out-Null;" +
    " $source = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream.GetInputStreamAt(0));" +
    " $target = [System.IO.File]::Create((Join-Path $out ('{0}.png' -f $i))); $source.CopyTo($target); $target.Close(); $page.Dispose() }",
].join("; ");

// Renders pages [from, to) to <out>/<index>.png and returns the page count.
async function renderPages(pdf, out, from, to) {
  if (windows()) {
    const values = `$pdf = ${ps(backslashes(pdf))}; $out = ${ps(backslashes(out))}; $width = ${PAGE_PX}; $from = ${from}; $to = ${to}`;
    const r = await exec("powershell", ["-NoProfile", "-Command", `${values}; ${WINDOWS_PDF}`], { timeout: 120000 });
    if (r.code !== 0) throw new Error(r.stderr.trim().split("\n")[0] || "PowerShell failed");
    return Number(r.stdout.trim()) || 0;
  }
  const info = await exec("pdfinfo", [pdf]);
  if (info.code !== 0) throw new Error(info.stderr.trim().split("\n")[0] || "pdfinfo failed");
  const count = Number(/^Pages:\s+(\d+)/m.exec(info.stdout)?.[1]) || 0;
  for (let i = from; i < Math.min(count, to); i++) {
    const n = String(i + 1);
    const r = await exec("pdftoppm", ["-png", "-singlefile", "-f", n, "-l", n, "-scale-to-x", String(PAGE_PX), "-scale-to-y", "-1", pdf, `${out}/${i}`], { timeout: 60000 });
    if (r.code !== 0) throw new Error(r.stderr.trim().split("\n")[0] || "pdftoppm failed");
  }
  return count;
}

async function removeFolder(folder) {
  const dir = `${appHome()}/${folder}`;
  for (const name of await fs.readdir(dir).catch(() => [])) await fs.unlink(`${dir}/${name}`).catch(() => {});
  await fs.rmdir(dir).catch(() => {});
}

const sizeText = (bytes) =>
  bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;

// The picture at its own size, made smaller to fit the box. A size the header did not give
// fills the box: GPUI keeps the aspect ratio.
export function imageView(picture, box, t) {
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

export class Binary {
  constructor(file, kind) {
    this.file = file;
    this.kind = kind;
    this.version = 0;
    this.pages = [];
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
      const count = await renderPages(this.file.path, `${appHome()}/${folder}`, from, to);
      if (stale()) return;
      for (let i = from; i < Math.min(count, to); i++) {
        const path = `${folder}/${i}.png`;
        pages.push({ path, ...((await imageSize(path)) ?? { width: 1, height: 1.294 }) });
      }
      if (stale()) return;
      if (from === 0) this.swap(folder);
      this.pages = pages;
      this.count = count;
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
    return this.count > MAX_PAGES ? `${MAX_PAGES} of ${pages}` : pages;
  }

  view(t, box) {
    const message = (text) => div().p(16).text_color(t.dim).child(text);
    if (this.problem) return message(this.problem);
    if (this.kind === "image") return this.picture ? imageView(this.picture, box, t) : message("Loading…");
    if (!this.pages.length) return message(this.count === 0 ? "This PDF has no pages." : "Rendering…");

    const width = Math.min(Math.max(box.width - 2 * PAD, 100), COLUMN);
    const more = this.count > MAX_PAGES && !this.rendering;
    const items = this.pages.length + (more ? 1 : 0);
    const page = (i) => {
      const p = this.pages[i];
      return div()
        .w_full()
        .flex()
        .justify_center()
        .pt(i === 0 ? PAD : 0)
        .pb(i === this.pages.length - 1 && !more ? PAD : 16)
        .child(div().border(1).border_color(t.border).child(image(p.path).w(width).h((width * p.height) / p.width)));
    };
    const footer = () =>
      div().w_full().pb(PAD).flex().justify_center().text_color(t.dim).child(`Showing the first ${MAX_PAGES} of ${this.count} pages.`);
    return v_flex()
      .relative()
      .flex_1()
      .min_h(0)
      .bg(t.canvas ?? t.background)
      .child(list(`kz-pdf-${this.folder}`, items, (i) => `${this.folder}-${i}`, (i) => (i < this.pages.length ? page(i) : footer())))
      .child(Scrollbar.vertical(`kz-pdf-${this.folder}`).absolute().inset_0());
  }
}

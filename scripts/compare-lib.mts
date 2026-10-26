/**
 * Local Bridge の書き出し (/export の展開先) を 2 つ比べ、変わったところを文字の差分と画像の差分にする。
 * Figma を書き換える前後の確かめに使う。手順は .claude/skills/figma-safe-edit/SKILL.md。
 */
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImageChange {
  /** 書き出しの中のパス (名前が変わったものは after 側のパス) */
  file: string;
  /** 色が 1 つでも違う画素の数。大きさが違えば、広げた側の画素も数える。片方にしか無い画像は全画素 */
  changedPixels: number;
  width: number;
  height: number;
  /** 違う画素を囲む範囲。片方にしか無い画像は null */
  region: Region | null;
}

export interface Rename {
  before: string;
  after: string;
}

export interface CompareSummary {
  same: boolean;
  added: string[];
  removed: string[];
  /** 名前が変わったファイル (ノード ID が同じもの)。中身も変わっていれば changed にも after 側のパスで入る */
  renamed: Rename[];
  changed: string[];
  images: ImageChange[];
  outDir: string;
  /** 文字のファイルの差分 (diff -u) を書いたファイル。変わった文字のファイルが無ければ null */
  changesDiff: string | null;
  report: string;
}

const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([".json", ".md", ".svg", ".txt"]);
/** 比べ終えた置き場所の印。--out に既にある置き場所を消してよいかは、これがあるかで決める */
const SUMMARY_FILE = "summary.json";
const CHANGES_DIFF_FILE = "changes.diff";
const REPORT_FILE = "report.html";
/** 比べた結果の置き場所に作るもの。これ以外があれば、人の置いたものとみて消さない */
const OUT_ENTRIES: ReadonlySet<string> = new Set([
  "before",
  "after",
  "diff",
  "crop",
  CHANGES_DIFF_FILE,
  REPORT_FILE,
  SUMMARY_FILE,
]);
/** 違う画素を囲む範囲の外に足す余白 (画素) */
const CROP_MARGIN = 24;
/** 切り出しが全体のこの割合より小さいときだけ、切り出した画像を作る */
const CROP_MAX_AREA_RATIO = 0.5;
/** report に載せる文字の差分の上限。超えたら changes.diff を開いてもらう */
const REPORT_TEXT_DIFF_MAX = 2 * 1024 * 1024;
/** これより行の多いファイルの差分は、report で閉じておく */
const OPEN_DIFF_MAX_LINES = 300;
/** 構造の json でノードの始まりを示す行 (diff -F に渡す) */
const NODE_ID_LINE = '"id": "';

function listFiles(root: string, dir = ""): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(root, rel));
    else if (entry.isFile()) files.push(rel);
  }
  return files.sort();
}

/**
 * 前後のファイルを組にする鍵。書き出しのファイル名は <名前>.<ノード ID>.<拡張子> (フォルダは <名前>.<ノード ID>) で、
 * ノードの名前を変えるとパスが変わるので、名前の部分を外してノード ID で組にする
 */
function pairKey(rel: string): string {
  const segments = rel.split("/");
  return segments
    .map((segment, i) => {
      const ext = i === segments.length - 1 ? path.extname(segment) : "";
      const stem = segment.slice(0, segment.length - ext.length);
      return stem.slice(stem.lastIndexOf(".") + 1) + ext;
    })
    .join("/");
}

/** 鍵からパスへの対応。同じ鍵になるファイルが片側に 2 つ以上あれば、それらはパスのまま組にする */
function keyed(files: readonly string[]): Map<string, string> {
  const count = new Map<string, number>();
  for (const rel of files) count.set(pairKey(rel), (count.get(pairKey(rel)) ?? 0) + 1);
  return new Map(files.map((rel) => [count.get(pairKey(rel)) === 1 ? pairKey(rel) : rel, rel]));
}

function readIndex(dir: string): void {
  const file = path.join(dir, "index.json");
  if (!existsSync(file)) throw new Error(`書き出しの置き場所でない (index.json が無い): ${dir}`);
  try {
    JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`index.json を読めない: ${file} (${e instanceof Error ? e.message : String(e)})`);
  }
}

/** 書き出しの時刻は書き出すたびに変わるので、比べる前に外す */
function normalized(root: string, rel: string): Buffer {
  const data = readFileSync(path.join(root, rel));
  if (rel !== "index.json") return data;
  const index = JSON.parse(data.toString("utf8")) as { meta?: Record<string, unknown> } | null;
  if (index?.meta) delete index.meta.exportedAt;
  return Buffer.from(JSON.stringify(index, null, 2) + "\n");
}

function readPng(data: Buffer, label: string): PNG {
  try {
    return PNG.sync.read(data);
  } catch (e) {
    throw new Error(`PNG を読めない: ${label} (${e instanceof Error ? e.message : String(e)})`);
  }
}

/** 左上をそろえて、透明で大きさを広げる */
function padded(png: PNG, width: number, height: number): PNG {
  if (png.width === width && png.height === height) return png;
  const out = new PNG({ width, height });
  PNG.bitblt(png, out, 0, 0, png.width, png.height, 0, 0);
  return out;
}

/** pixelmatch の差分画像で、違う画素は赤 (diffColor の既定) に、同じ画素は灰色に塗られる */
function changedRegion(diff: PNG): Region | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < diff.height; y++) {
    for (let x = 0; x < diff.width; x++) {
      const i = (y * diff.width + x) * 4;
      if (diff.data[i] !== 255 || diff.data[i + 1] !== 0 || diff.data[i + 2] !== 0) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return maxX === -1 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** 範囲に余白を足す。全体の大きさに対して小さくないなら、切り出さない (null) */
function cropRegion(region: Region, width: number, height: number): Region | null {
  const x = Math.max(0, region.x - CROP_MARGIN);
  const y = Math.max(0, region.y - CROP_MARGIN);
  const crop = {
    x,
    y,
    width: Math.min(width, region.x + region.width + CROP_MARGIN) - x,
    height: Math.min(height, region.y + region.height + CROP_MARGIN) - y,
  };
  return crop.width * crop.height < width * height * CROP_MAX_AREA_RATIO ? crop : null;
}

function cropped(png: PNG, r: Region): Buffer {
  const out = new PNG({ width: r.width, height: r.height });
  PNG.bitblt(png, out, r.x, r.y, r.width, r.height, 0, 0);
  return PNG.sync.write(out);
}

function writeFile(file: string, data: Buffer | string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, data);
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** 前の比べた結果だけを消す。比べた結果の置き場所でなければ断る */
function prepareOutDir(outDir: string, inputs: readonly string[]): void {
  for (const dir of inputs) {
    if (isInside(path.resolve(dir), path.resolve(outDir))) {
      throw new Error(`比べる書き出しが --out の中にある: ${dir}`);
    }
  }
  if (existsSync(outDir)) {
    const entries = readdirSync(outDir);
    const unknown = entries.filter((e) => !OUT_ENTRIES.has(e));
    if (!entries.includes(SUMMARY_FILE) || unknown.length > 0) {
      const detail = unknown.length > 0 ? ` (比べた結果が作らないもの: ${unknown.join(", ")})` : "";
      throw new Error(`比べた結果の置き場所でないものがすでにある: ${outDir}${detail}`);
    }
    for (const entry of entries) rmSync(path.join(outDir, entry), { recursive: true });
  }
  mkdirSync(outDir, { recursive: true });
  // 途中で失敗しても、次の実行がこの置き場所を比べた結果のものと見て置き換えられるよう、先に印を置く
  writeFileSync(path.join(outDir, SUMMARY_FILE), JSON.stringify({ incomplete: true }) + "\n");
}

/** 画像の比べ方は文字のファイルと違う (diff/ と crop/ を作る) ので、分けて扱う */
function compareImage(
  outDir: string,
  rel: string,
  before: Buffer | undefined,
  after: Buffer | undefined,
  labels: { before: string; after: string }
): ImageChange | null {
  if (before === undefined || after === undefined) {
    const png = readPng((before ?? after)!, before === undefined ? labels.after : labels.before);
    return { file: rel, changedPixels: png.width * png.height, width: png.width, height: png.height, region: null };
  }
  const a = readPng(before, labels.before);
  const b = readPng(after, labels.after);
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const diff = new PNG({ width, height });
  const pa = padded(a, width, height);
  const pb = padded(b, width, height);
  const changedPixels = pixelmatch(pa.data, pb.data, diff.data, width, height, { threshold: 0, includeAA: true });
  if (changedPixels === 0 && a.width === b.width && a.height === b.height) return null;
  writeFile(path.join(outDir, "diff", rel), PNG.sync.write(diff));
  const region = changedRegion(diff);
  const crop = region === null ? null : cropRegion(region, width, height);
  if (crop !== null) {
    writeFile(path.join(outDir, "crop", "before", rel), cropped(pa, crop));
    writeFile(path.join(outDir, "crop", "after", rel), cropped(pb, crop));
    writeFile(path.join(outDir, "crop", "diff", rel), cropped(diff, crop));
  }
  return { file: rel, changedPixels, width, height, region };
}

/** before/ と after/ の写しを diff -ruN で比べ、changes.diff に書く (大きくても書き切れるよう、ファイルへ直に出す) */
function writeTextDiff(outDir: string): string {
  const file = path.join(outDir, CHANGES_DIFF_FILE);
  const fd = openSync(file, "w");
  let result;
  try {
    // 画像は diff/ で見るので、文字の差分からは外す。
    // -F で、変わった箇所の直前のノード ID を差分の区切りの行に出し、どのノードの変化かを追えるようにする
    result = spawnSync(
      "diff",
      ["-ruN", "-F", NODE_ID_LINE, "-x", "*.png", "-x", "*.jpg", "-x", "*.jpeg", "-x", "*.gif", "-x", "*.webp", "before", "after"],
      { cwd: outDir, stdio: ["ignore", fd, "pipe"], encoding: "utf8" }
    );
  } finally {
    closeSync(fd);
  }
  if (result.error) throw new Error(`diff を実行できない: ${result.error.message}`);
  // diff の終了コードは、同じなら 0・違えば 1・失敗なら 2
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`diff が失敗した (終了コード ${result.status}): ${result.stderr.trim()}`);
  }
  return file;
}

/**
 * beforeDir と afterDir を比べ、outDir に before/・after/ (変わったファイルの写し)・diff/ (差分画像)・crop/ (変わった範囲の切り出し)・
 * changes.diff・report.html・summary.json を書く。
 * PNG は画素で比べ、色が 1 つでも違う画素を赤く塗った差分画像を作る (書き出しの符号化が違うだけなら変わっていないと見る)
 */
export function compareExports(beforeDir: string, afterDir: string, outDir: string): CompareSummary {
  readIndex(beforeDir);
  readIndex(afterDir);
  prepareOutDir(outDir, [beforeDir, afterDir]);

  const beforeFiles = keyed(listFiles(beforeDir));
  const afterFiles = keyed(listFiles(afterDir));
  const keys = [...new Set([...beforeFiles.keys(), ...afterFiles.keys()])].sort();
  const added: string[] = [];
  const removed: string[] = [];
  const renamed: Rename[] = [];
  const changed: string[] = [];
  const images: ImageChange[] = [];
  let textChanged = false;

  for (const key of keys) {
    const beforeRel = beforeFiles.get(key);
    const afterRel = afterFiles.get(key);
    // 写しは after 側のパスにそろえ、名前が変わったファイルも diff -ruN で組になるようにする
    const rel = (afterRel ?? beforeRel)!;
    if (beforeRel !== undefined && afterRel !== undefined && beforeRel !== afterRel) {
      renamed.push({ before: beforeRel, after: afterRel });
    }
    const before = beforeRel === undefined ? undefined : normalized(beforeDir, beforeRel);
    const after = afterRel === undefined ? undefined : normalized(afterDir, afterRel);
    if (before !== undefined && after !== undefined && before.equals(after)) continue;
    const ext = path.extname(rel).toLowerCase();
    if (ext === ".png") {
      const labels = { before: `before/${beforeRel}`, after: `after/${afterRel}` };
      const image = compareImage(outDir, rel, before, after, labels);
      if (image === null) continue;
      images.push(image);
    } else if (TEXT_EXTENSIONS.has(ext)) {
      textChanged = true;
    }
    if (before !== undefined) writeFile(path.join(outDir, "before", rel), before);
    if (after !== undefined) writeFile(path.join(outDir, "after", rel), after);
    if (before === undefined) added.push(rel);
    else if (after === undefined) removed.push(rel);
    else changed.push(rel);
  }

  const changesDiff = textChanged ? writeTextDiff(outDir) : null;
  const same = added.length === 0 && removed.length === 0 && renamed.length === 0 && changed.length === 0;
  const report = path.join(outDir, REPORT_FILE);
  const summary: CompareSummary = { same, added, removed, renamed, changed, images, outDir, changesDiff, report };
  writeFile(report, reportHtml(summary, beforeDir, afterDir));
  writeFile(path.join(outDir, SUMMARY_FILE), JSON.stringify(summary, null, 2) + "\n");
  return summary;
}

/** 比べた結果の置き場所の既定。<書き出しの置き場所>/compare/<before の名前>-<after の名前> (latest などのリンクはたどる) */
export function defaultCompareDir(beforeDir: string, afterDir: string): string {
  const before = realpathSync(beforeDir);
  const resultsParent = path.dirname(path.dirname(before));
  return path.join(resultsParent, "compare", `${path.basename(before)}-${path.basename(realpathSync(afterDir))}`);
}

export function isDirectory(p: string): boolean {
  return existsSync(p) && statSync(p).isDirectory();
}

// ---------------------------------------------------------------------------
// report.html
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** img の src に使えるよう、パスの区切りごとに符号化する (ノード名に # や空白が入りうる) */
function src(...parts: string[]): string {
  return escapeHtml(path.posix.join(...parts).split("/").map(encodeURIComponent).join("/"));
}

function percent(image: ImageChange): string {
  const ratio = (image.changedPixels / (image.width * image.height)) * 100;
  return ratio < 0.1 ? "0.1% 未満" : `${ratio.toFixed(1)}%`;
}

function figure(caption: string, url: string): string {
  return `<figure><figcaption>${caption}</figcaption><a href="${url}" target="_blank"><img src="${url}" loading="lazy" alt=""></a></figure>`;
}

function imageArticle(image: ImageChange, index: number, summary: CompareSummary, hasCrop: boolean): string {
  const id = `img-${index + 1}`;
  const title = `<h3><code>${escapeHtml(image.file)}</code></h3>`;
  if (summary.added.includes(image.file) || summary.removed.includes(image.file)) {
    const side = summary.added.includes(image.file) ? "after" : "before";
    const label = side === "after" ? "足された" : "消えた";
    return `<article id="${id}">${title}<p class="meta"><span class="tag">${label}</span> ${image.width}×${image.height}</p>
<div class="row single">${figure(side, src(side, image.file))}</div></article>`;
  }
  const r = image.region;
  const meta = `<p class="meta">違う画素 ${image.changedPixels.toLocaleString("en-US")} (${percent(image)}) ・ ${image.width}×${image.height}${
    r === null ? "" : ` ・ 変わった範囲 x ${r.x} y ${r.y} から ${r.width}×${r.height}`
  }</p>`;
  const full = `<div class="row">${figure("before", src("before", image.file))}${figure("after", src("after", image.file))}${figure(
    "差分 (赤が違う画素)",
    src("diff", image.file)
  )}</div>`;
  if (!hasCrop) return `<article id="${id}">${title}${meta}${full}</article>`;
  const crop = `<div class="row">${figure("before (変わった範囲)", src("crop/before", image.file))}${figure(
    "after (変わった範囲)",
    src("crop/after", image.file)
  )}${figure("差分 (変わった範囲)", src("crop/diff", image.file))}</div>`;
  return `<article id="${id}">${title}${meta}${crop}<details><summary>全体を見る</summary>${full}</details></article>`;
}

interface FileDiff {
  file: string;
  lines: string[];
  added: number;
  removed: number;
}

/** diff -ruN の出力をファイルごとに分ける。ファイル名は +++ after/<パス> の行から取る */
function splitDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: FileDiff | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff ")) {
      current = { file: "", lines: [], added: 0, removed: 0 };
      files.push(current);
      continue;
    }
    if (current === null) continue;
    if (line.startsWith("+++ ")) {
      current.file = line.slice(4).split("\t")[0].replace(/^after\//, "");
      continue;
    }
    if (line.startsWith("--- ")) continue;
    if (line.startsWith("+")) current.added++;
    else if (line.startsWith("-")) current.removed++;
    current.lines.push(line);
  }
  return files.filter((f) => f.file !== "");
}

/** 構造の json の写しから、ノード ID と名前の対応を集める (差分の区切りの行にノードの名前を出すため) */
function nodeNames(outDir: string, file: string): Map<string, string> {
  const names = new Map<string, string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (typeof value === "object" && value !== null) {
      const record = value as Record<string, unknown>;
      if (typeof record.id === "string" && typeof record.name === "string") names.set(record.id, record.name);
      Object.values(record).forEach(walk);
    }
  };
  for (const side of ["before", "after"]) {
    const copy = path.join(outDir, side, file);
    if (!file.endsWith(".json") || !existsSync(copy)) continue;
    try {
      walk(JSON.parse(readFileSync(copy, "utf8")));
    } catch {
      // 名前を出せないだけで、差分はそのまま載せられる
    }
  }
  return names;
}

function diffLine(line: string, names: Map<string, string>): string {
  if (line.startsWith("@@")) {
    const end = line.indexOf("@@", 2) + 2;
    const id = /"id": "([^"]+)"/.exec(line.slice(end))?.[1];
    const node =
      id === undefined ? "" : ` <span class="node">${escapeHtml(names.get(id) ?? "")} <code>${escapeHtml(id)}</code></span>`;
    return `<span class="hunk">${escapeHtml(line.slice(0, end))}${node}</span>`;
  }
  const cls = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
  return `<span class="${cls}">${escapeHtml(line)}</span>`;
}

function fileDiffBlock(diff: FileDiff, outDir: string): string {
  const names = nodeNames(outDir, diff.file);
  const isSvg = diff.file.toLowerCase().endsWith(".svg");
  const long = diff.lines.length > OPEN_DIFF_MAX_LINES;
  const note = isSvg ? "SVG のコード" : long ? `${diff.lines.length} 行あるので閉じている` : "";
  return `<details class="file"${isSvg || long ? "" : " open"}><summary><code>${escapeHtml(diff.file)}</code> <span class="add">+${
    diff.added
  }</span> <span class="del">-${diff.removed}</span>${note === "" ? "" : ` <span class="note">${note}</span>`}</summary>
<pre>${diff.lines.map((line) => diffLine(line, names)).join("")}</pre></details>`;
}

function fileList(label: string, files: readonly string[]): string {
  if (files.length === 0) return "";
  return `<details><summary>${label} (${files.length})</summary><ul>${files
    .map((f) => `<li><code>${escapeHtml(f)}</code></li>`)
    .join("")}</ul></details>`;
}

function reportHtml(summary: CompareSummary, beforeDir: string, afterDir: string): string {
  const images = [...summary.images].sort((a, b) => b.changedPixels - a.changedPixels);
  const hasCrop = (image: ImageChange) => existsSync(path.join(summary.outDir, "crop", "diff", image.file));
  const thumb = (image: ImageChange) =>
    summary.added.includes(image.file)
      ? src("after", image.file)
      : summary.removed.includes(image.file)
        ? src("before", image.file)
        : src(hasCrop(image) ? "crop/diff" : "diff", image.file);
  const cards = images
    .map(
      (image, i) =>
        `<a class="card" href="#img-${i + 1}"><img src="${thumb(image)}" loading="lazy" alt=""><span class="name">${escapeHtml(
          path.posix.basename(image.file)
        )}</span><span class="meta">${
          summary.added.includes(image.file) ? "足された" : summary.removed.includes(image.file) ? "消えた" : percent(image)
        }</span></a>`
    )
    .join("");

  let textSection = "";
  if (summary.changesDiff !== null) {
    const size = statSync(summary.changesDiff).size;
    const body =
      size > REPORT_TEXT_DIFF_MAX
        ? `<p>差分が大きい (${Math.round(size / 1024)} KB) ので載せていない。<a href="${CHANGES_DIFF_FILE}">${CHANGES_DIFF_FILE}</a> を開く。</p>`
        : splitDiff(readFileSync(summary.changesDiff, "utf8"))
            .map((diff) => fileDiffBlock(diff, summary.outDir))
            .join("\n");
    textSection = `<section id="text"><h2>構造の差分</h2>
<p class="hint">SVG のコードと長い差分は閉じてある。見出しを押すと開く。全部は <a href="${CHANGES_DIFF_FILE}">${CHANGES_DIFF_FILE}</a></p>
${body}</section>`;
  }
  const textFiles = [...summary.changed, ...summary.added, ...summary.removed].filter((f) =>
    TEXT_EXTENSIONS.has(path.extname(f).toLowerCase())
  ).length;
  const count = (label: string, n: number, href = "") =>
    n === 0 ? "" : `<li>${href === "" ? label : `<a href="${href}">${label}</a>`} <b>${n}</b></li>`;

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>書き出しの比較</title>
<style>
  :root { --fg: #1a1a1a; --muted: #6b6b6b; --line: #e3e3e3; --bg: #fff; --panel: #f6f6f6; --add: #1a7f37; --add-bg: #e6f4ea; --del: #b42318; --del-bg: #fde8e7; --hunk: #6b6b6b; }
  @media (prefers-color-scheme: dark) {
    :root { --fg: #e8e8e8; --muted: #a0a0a0; --line: #3a3a3a; --bg: #1c1c1c; --panel: #262626; --add: #6fd08c; --add-bg: #1f3326; --del: #ff8b80; --del-bg: #3d2220; --hunk: #a0a0a0; }
  }
  * { box-sizing: border-box; }
  body { font: 13px/1.6 -apple-system, "Hiragino Sans", sans-serif; margin: 0; color: var(--fg); background: var(--bg); }
  header { position: sticky; top: 0; z-index: 1; background: var(--bg); border-bottom: 1px solid var(--line); padding: 10px 16px; }
  h1 { font-size: 15px; margin: 0 0 4px; }
  .counts { display: flex; flex-wrap: wrap; gap: 4px 16px; list-style: none; margin: 0; padding: 0; color: var(--muted); }
  .counts b { color: var(--fg); }
  main { padding: 0 16px 32px; }
  h2 { font-size: 14px; margin: 24px 0 8px; }
  h3 { font-size: 13px; margin: 0 0 4px; }
  a { color: inherit; }
  .hint, .meta, figcaption, .note { color: var(--muted); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 8px; }
  .card { display: flex; flex-direction: column; gap: 2px; padding: 6px; border: 1px solid var(--line); border-radius: 6px; text-decoration: none; }
  .card img { height: 96px; object-fit: contain; }
  .card .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  article { border-top: 1px solid var(--line); padding: 16px 0; scroll-margin-top: 80px; }
  .row { display: flex; gap: 12px; align-items: flex-start; margin-top: 8px; }
  .row.single figure { flex: 0 1 50%; }
  figure { flex: 1; min-width: 0; margin: 0; }
  img { display: block; max-width: 100%; border: 1px solid var(--line); background: repeating-conic-gradient(#c8c8c8 0 25%, #e8e8e8 0 50%) 0 0 / 16px 16px; }
  body[data-bg="white"] img { background: #fff; }
  body[data-bg="black"] img { background: #000; }
  .bg { display: inline-flex; gap: 4px; margin-left: 16px; }
  .bg button { font: inherit; color: inherit; background: none; border: 1px solid var(--line); border-radius: 4px; padding: 0 6px; cursor: pointer; }
  .bg button[aria-pressed="true"] { background: var(--panel); border-color: var(--muted); }
  .tag { border: 1px solid var(--line); border-radius: 4px; padding: 0 6px; }
  details { margin: 8px 0; }
  summary { cursor: pointer; }
  details.file { border: 1px solid var(--line); border-radius: 6px; }
  details.file > summary { padding: 6px 10px; background: var(--panel); border-radius: 6px; }
  pre { margin: 0; padding: 8px 0; overflow: auto; font: 12px/1.5 ui-monospace, Menlo, monospace; }
  pre > span { display: block; padding: 0 10px; white-space: pre; }
  span.add { color: var(--add); }
  span.del { color: var(--del); }
  pre .add { background: var(--add-bg); }
  pre .del { background: var(--del-bg); }
  pre .hunk { color: var(--hunk); background: var(--panel); margin-top: 4px; }
  pre .node { color: var(--fg); font-weight: 600; }
  pre .node code { color: var(--muted); font-weight: normal; }
  footer { color: var(--muted); padding: 16px; border-top: 1px solid var(--line); }
  @media (max-width: 640px) { .row { flex-direction: column; } .row.single figure { flex-basis: auto; } }
</style>
</head>
<body>
<header>
<h1>${summary.same ? "変わったところは無い" : "変わったところがある"}</h1>
<ul class="counts">
${
  images.length === 0
    ? ""
    : `<li class="bg">画像の背景 <button type="button" data-bg="checker" aria-pressed="true">市松</button><button type="button" data-bg="white" aria-pressed="false">白</button><button type="button" data-bg="black" aria-pressed="false">黒</button></li>`
}
${count("見た目が変わった画像", images.length, "#images")}
${count("構造の差分があるファイル", textFiles, "#text")}
${count("足された", summary.added.length, "#files")}
${count("消えた", summary.removed.length, "#files")}
${count("名前が変わった", summary.renamed.length, "#files")}
</ul>
</header>
<main>
${
  images.length === 0
    ? ""
    : `<section id="images"><h2>見た目が変わった画像 (違う画素の多い順)</h2>
<p class="hint">変わった範囲が小さい画像は、その範囲を切り出して大きく見せる。画像を押すと原寸で開く。</p>
<div class="grid">${cards}</div>
${images.map((image, i) => imageArticle(image, i, summary, hasCrop(image))).join("\n")}
</section>`
}
${textSection}
<section id="files"><h2>ファイルの一覧</h2>
${fileList("変わった", summary.changed)}
${fileList("足された", summary.added)}
${fileList("消えた", summary.removed)}
${fileList("名前が変わった", summary.renamed.map((r) => `${r.before} → ${r.after}`))}
</section>
</main>
<footer>before: <code>${escapeHtml(beforeDir)}</code><br>after: <code>${escapeHtml(afterDir)}</code></footer>
<script>
  // 白や黒の図形は市松の背景に溶けるので、背景を切り替えられるようにする
  for (const button of document.querySelectorAll(".bg button")) {
    button.addEventListener("click", () => {
      document.body.dataset.bg = button.dataset.bg;
      for (const b of document.querySelectorAll(".bg button")) b.setAttribute("aria-pressed", String(b === button));
    });
  }
</script>
</body>
</html>
`;
}

/**
 * Local Bridge の書き出し (/export の展開先) を 2 つ比べ、変わったところを文字の差分と画像の差分にする。
 * Figma を書き換える前後の確かめに使う。手順は .claude/skills/figma-safe-edit/SKILL.md。
 * 人が見る report.html の組み立ては compare-report.mts。
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
import { type BridgeMeta, readBridgeMeta } from "./bridge-meta.mts";
import { CHANGES_DIFF_FILE, cropFile, NODE_ID_LINE, reportHtml, sameChangesOf, TEXT_EXTENSIONS } from "./compare-report.mts";

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImageChange {
  /** 書き出しの中のパス (名前が変わったものは after 側のパス) */
  file: string;
  /** 色が 1 つでも違う画素の数。大きさが違えば広げた側も比べる (透明どうしは同じと見る)。片方にしか無い画像は全画素 */
  changedPixels: number;
  width: number;
  height: number;
  /** 違う画素を全部囲む範囲。片方にしか無い画像と、違う画素が無い (大きさだけ違う) 画像は null */
  region: Region | null;
  /** 離れた変化ごとに分けた範囲 (上から順。変わった所が多すぎるときは 1 つにまとめる)。crop/<side>/<パス>.<番号>.png に、この順で切り出す */
  regions: Region[];
}

export interface Rename {
  before: string;
  after: string;
}

export interface SameChange {
  /** この変化がある箇所の数 */
  count: number;
  /** 足した・消した行 (diff -u の + と - の行) */
  lines: string[];
  /** 箇所ごとのファイルと、変わった箇所の直前に始まるノード (diff -F で分かったもの)。inAfter は、そのノードが after の書き出しにあるか (無ければ Figma で開けない) */
  places: { file: string; nodeId: string | null; name: string | null; inAfter: boolean }[];
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
  /** 構造の差分のうち、同じ中身の変化が 2 箇所以上あるもの (多い順) */
  sameChanges: SameChange[];
  report: string;
  /** 書き出した Figma のファイル (dev サーバーが添えた印から。after が無ければ before の印)。無ければ null で、report に Figma を開くリンクを付けない */
  fileKey: string | null;
}

/** 比べた結果の置き場所の印。--out に既にある置き場所を消してよいかは、これに SUMMARY_MARK が入っているかで決める */
const SUMMARY_FILE = "summary.json";
/** compare が書いた summary.json だけに入れる値。名前が同じだけのファイルを、比べた結果と取り違えて消さないため */
const SUMMARY_MARK = { tool: "figma-plugins compare" } as const;
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
/** 違う画素の範囲を分けるときのます目の大きさ (画素) */
const REGION_CELL = 8;
/** この数のます目 (REGION_CELL × この数の画素) より近い変化は、1 箇所にまとめる */
const REGION_GAP_CELLS = 12;
/** 範囲の外に足す余白 (画素) */
const CROP_MARGIN = 64;
/** 切り出しが全体のこの割合より小さい範囲だけ切り出す */
const CROP_MAX_AREA_RATIO = 0.5;
/** 切り出す範囲の数の上限。超えた分は全体の画像で見る */
export const MAX_CROPS = 30;
/** 違う画素のあるます目がこれより多い (全面が変わったなど) ときは、分けずに 1 つの範囲にする (分ける計算が重くなるため) */
const MAX_REGION_CELLS = 20000;

/** 隠しファイル (.DS_Store など) は書き出しの中身でないので比べない */
function listFiles(root: string, dir = ""): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
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

/**
 * report のリンクに使う fileKey。before と after で違えば (別のファイルの書き出しを比べている)、
 * どちらのノードもそのファイルに無いかもしれないので null (リンクを付けない)
 */
function sharedFileKey(before: BridgeMeta | null, after: BridgeMeta | null): string | null {
  if (before !== null && after !== null && before.fileKey !== after.fileKey) return null;
  return (after ?? before)?.fileKey ?? null;
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
function isChanged(diff: PNG, i: number): boolean {
  return diff.data[i] === 255 && diff.data[i + 1] === 0 && diff.data[i + 2] === 0;
}

function union(a: Region | null, b: Region): Region {
  if (a === null) return b;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

/**
 * 違う画素を、離れた変化ごとの範囲に分ける。
 * 画像を REGION_CELL のます目に分け、違う画素のあるます目どうしが REGION_GAP_CELLS 以内なら同じ変化とみてつなぐ
 */
function changedRegions(diff: PNG): Region[] {
  const cols = Math.ceil(diff.width / REGION_CELL);
  const rows = Math.ceil(diff.height / REGION_CELL);
  const cells = new Map<number, Region>();
  for (let y = 0; y < diff.height; y++) {
    for (let x = 0; x < diff.width; x++) {
      if (!isChanged(diff, (y * diff.width + x) * 4)) continue;
      const cell = Math.floor(y / REGION_CELL) * cols + Math.floor(x / REGION_CELL);
      cells.set(cell, union(cells.get(cell) ?? null, { x, y, width: 1, height: 1 }));
    }
  }
  if (cells.size > MAX_REGION_CELLS) return [[...cells.values()].reduce<Region | null>(union, null)!];
  const regions: Region[] = [];
  const seen = new Set<number>();
  for (const start of cells.keys()) {
    if (seen.has(start)) continue;
    seen.add(start);
    let region: Region | null = null;
    const stack = [start];
    while (stack.length > 0) {
      const cell = stack.pop()!;
      region = union(region, cells.get(cell)!);
      const cx = cell % cols;
      const cy = Math.floor(cell / cols);
      for (let ny = Math.max(0, cy - REGION_GAP_CELLS); ny <= Math.min(rows - 1, cy + REGION_GAP_CELLS); ny++) {
        for (let nx = Math.max(0, cx - REGION_GAP_CELLS); nx <= Math.min(cols - 1, cx + REGION_GAP_CELLS); nx++) {
          const next = ny * cols + nx;
          if (cells.has(next) && !seen.has(next)) {
            seen.add(next);
            stack.push(next);
          }
        }
      }
    }
    regions.push(region!);
  }
  return regions.sort((a, b) => a.y - b.y || a.x - b.x);
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

/** シンボリックリンクをたどった実際の場所。まだ無いパスは、在る親までをたどって残りをつなぐ */
function realPathOf(p: string): string {
  const abs = path.resolve(p);
  if (existsSync(abs)) return realpathSync(abs);
  const parent = path.dirname(abs);
  return parent === abs ? abs : path.join(realPathOf(parent), path.basename(abs));
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * 前の比べた結果だけを消す。比べた結果の置き場所でなければ断る。
 * 比べた結果の置き場所の中には人がファイルを置かない前提で、中身までは確かめずに置き換える。
 */
function prepareOutDir(outDir: string, inputs: readonly string[]): void {
  const out = realPathOf(outDir);
  for (const dir of inputs) {
    if (isInside(realPathOf(dir), out)) throw new Error(`比べる書き出しが --out の中にある: ${dir}`);
    if (isInside(out, realPathOf(dir))) throw new Error(`--out が比べる書き出しの中にある: ${outDir}`);
  }
  if (existsSync(outDir)) {
    // 隠しファイル (Finder が作る .DS_Store など) は、比べた結果の中身でないので数えず、消さずに残す
    const entries = readdirSync(outDir).filter((e) => !e.startsWith("."));
    const unknown = entries.filter((e) => !OUT_ENTRIES.has(e));
    const detail =
      unknown.length > 0
        ? ` (比べた結果が作らないもの: ${unknown.join(", ")})`
        : !entries.includes(SUMMARY_FILE)
          ? " (summary.json が無い)"
          : !hasSummaryMark(path.join(outDir, SUMMARY_FILE))
            ? " (summary.json が compare の書いたものでない)"
            : null;
    if (entries.length > 0 && detail !== null) {
      throw new Error(`比べた結果の置き場所でないものがすでにある: ${outDir}${detail}`);
    }
    // 途中で止まっても印が残り、次の実行が置き換えられるよう、印は最後に消す
    for (const entry of entries.filter((e) => e !== SUMMARY_FILE)) rmSync(path.join(outDir, entry), { recursive: true });
  }
  mkdirSync(outDir, { recursive: true });
  // 途中で失敗しても、次の実行がこの置き場所を比べた結果のものと見て置き換えられるよう、先に印を置く
  writeFileSync(path.join(outDir, SUMMARY_FILE), JSON.stringify({ ...SUMMARY_MARK, incomplete: true }) + "\n");
}

function hasSummaryMark(file: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return typeof parsed === "object" && parsed !== null && (parsed as Record<string, unknown>).tool === SUMMARY_MARK.tool;
  } catch {
    return false;
  }
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
    return { file: rel, changedPixels: png.width * png.height, width: png.width, height: png.height, region: null, regions: [] };
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
  const regions = changedRegions(diff);
  regions.slice(0, MAX_CROPS).forEach((region, i) => {
    const crop = cropRegion(region, width, height);
    if (crop === null) return;
    writeFile(path.join(outDir, cropFile("before", rel, i)), cropped(pa, crop));
    writeFile(path.join(outDir, cropFile("after", rel, i)), cropped(pb, crop));
    writeFile(path.join(outDir, cropFile("diff", rel, i)), cropped(diff, crop));
  });
  const region = regions.reduce<Region | null>(union, null);
  return { file: rel, changedPixels, width, height, region, regions };
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
  const sameChanges = changesDiff === null ? [] : sameChangesOf(outDir, changesDiff);
  const fileKey = sharedFileKey(readBridgeMeta(beforeDir), readBridgeMeta(afterDir));
  const summary: CompareSummary = {
    same,
    added,
    removed,
    renamed,
    changed,
    images,
    outDir,
    changesDiff,
    sameChanges,
    report,
    fileKey,
  };
  writeFile(report, reportHtml(summary, beforeDir, afterDir));
  writeFile(path.join(outDir, SUMMARY_FILE), JSON.stringify({ ...SUMMARY_MARK, ...summary }, null, 2) + "\n");
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

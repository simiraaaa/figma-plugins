/**
 * Local Bridge の書き出し (/export の展開先) を 2 つ比べ、変わったところを文字の差分と画像の差分にする。
 * Figma を書き換える前後の確かめに使う。手順は .claude/skills/figma-safe-edit/SKILL.md。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

export interface ImageChange {
  /** 書き出しの中のパス */
  file: string;
  /** 色が 1 つでも違う画素の数。大きさが違えば、広げた側の画素も数える */
  changedPixels: number;
  width: number;
  height: number;
}

export interface CompareSummary {
  same: boolean;
  added: string[];
  removed: string[];
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

function listFiles(root: string, dir = ""): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(root, rel));
    else if (entry.isFile()) files.push(rel);
  }
  return files.sort();
}

/** 書き出しの時刻は書き出すたびに変わるので、比べる前に外す */
function normalized(root: string, rel: string): Buffer {
  const data = readFileSync(path.join(root, rel));
  if (rel !== "index.json") return data;
  const index = JSON.parse(data.toString("utf8")) as { meta?: Record<string, unknown> };
  if (index.meta) delete index.meta.exportedAt;
  return Buffer.from(JSON.stringify(index, null, 2) + "\n");
}

function readPng(data: Buffer | undefined): PNG {
  return data === undefined ? new PNG({ width: 0, height: 0 }) : PNG.sync.read(data);
}

/** 左上をそろえて、透明で大きさを広げる */
function padded(png: PNG, width: number, height: number): Buffer {
  if (png.width === width && png.height === height) return png.data;
  const out = new PNG({ width, height });
  PNG.bitblt(png, out, 0, 0, png.width, png.height, 0, 0);
  return out.data;
}

function writeFile(file: string, data: Buffer | string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, data);
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function reportHtml(
  summary: CompareSummary,
  textDiff: string | null,
  beforeDir: string,
  afterDir: string
): string {
  const list = (label: string, files: string[]) =>
    files.length === 0 ? "" : `<p>${label}: ${files.map((f) => `<code>${escapeHtml(f)}</code>`).join("、")}</p>`;
  const images = summary.images
    .map((image) => {
      const src = (side: string) => escapeHtml(path.posix.join(side, image.file));
      return `<h2><code>${escapeHtml(image.file)}</code> (違う画素 ${image.changedPixels})</h2>
<div class="row">
  <figure><figcaption>before</figcaption><img src="${src("before")}"></figure>
  <figure><figcaption>after</figcaption><img src="${src("after")}"></figure>
  <figure><figcaption>差分 (赤が違う画素)</figcaption><img src="${src("diff")}"></figure>
</div>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>書き出しの比較</title>
<style>
  body { font: 13px/1.6 -apple-system, "Hiragino Sans", sans-serif; margin: 16px; color: #1a1a1a; background: #fff; }
  h1 { font-size: 16px; }
  h2 { font-size: 13px; margin: 24px 0 8px; }
  .row { display: flex; gap: 12px; align-items: flex-start; }
  figure { flex: 1; min-width: 0; margin: 0; }
  figcaption { color: #777; }
  img { max-width: 100%; border: 1px solid #ddd; background: repeating-conic-gradient(#f2f2f2 0 25%, #fff 0 50%) 0 0 / 16px 16px; }
  pre { background: #f5f5f5; padding: 12px; overflow: auto; }
</style>
</head>
<body>
<h1>${summary.same ? "変わったところは無い" : "変わったところがある"}</h1>
<p>before: <code>${escapeHtml(beforeDir)}</code><br>after: <code>${escapeHtml(afterDir)}</code></p>
${list("足された", summary.added)}
${list("消えた", summary.removed)}
${list("変わった", summary.changed)}
${images}
${textDiff === null ? "" : `<h2>文字の差分</h2>\n<pre>${escapeHtml(textDiff)}</pre>`}
</body>
</html>
`;
}

/**
 * beforeDir と afterDir を比べ、outDir に before/・after/・diff/ (変わったファイルの写しと差分画像)・changes.diff・report.html・summary.json を書く。
 * PNG は画素で比べ、色が 1 つでも違う画素を赤く塗った差分画像を作る (書き出しの符号化が違うだけなら変わっていないと見る)
 */
export function compareExports(beforeDir: string, afterDir: string, outDir: string): CompareSummary {
  for (const dir of [beforeDir, afterDir]) {
    if (!existsSync(path.join(dir, "index.json"))) throw new Error(`書き出しの置き場所でない (index.json が無い): ${dir}`);
  }
  if (existsSync(outDir)) {
    if (!existsSync(path.join(outDir, SUMMARY_FILE))) {
      throw new Error(`比べた結果の置き場所でないものがすでにある: ${outDir}`);
    }
    rmSync(outDir, { recursive: true });
  }
  mkdirSync(outDir, { recursive: true });

  const beforeFiles = new Set(listFiles(beforeDir));
  const afterFiles = new Set(listFiles(afterDir));
  const all = [...new Set([...beforeFiles, ...afterFiles])].sort();
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  const images: ImageChange[] = [];
  let textChanged = false;

  for (const rel of all) {
    const before = beforeFiles.has(rel) ? normalized(beforeDir, rel) : undefined;
    const after = afterFiles.has(rel) ? normalized(afterDir, rel) : undefined;
    if (before !== undefined && after !== undefined && before.equals(after)) continue;
    const ext = path.extname(rel).toLowerCase();
    if (ext === ".png") {
      const a = readPng(before);
      const b = readPng(after);
      const width = Math.max(a.width, b.width);
      const height = Math.max(a.height, b.height);
      const diff = new PNG({ width, height });
      const changedPixels = pixelmatch(padded(a, width, height), padded(b, width, height), diff.data, width, height, {
        threshold: 0,
        includeAA: true,
      });
      if (changedPixels === 0 && a.width === b.width && a.height === b.height) continue;
      images.push({ file: rel, changedPixels, width, height });
      writeFile(path.join(outDir, "diff", rel), PNG.sync.write(diff));
    } else if (TEXT_EXTENSIONS.has(ext)) {
      textChanged = true;
    }
    if (before !== undefined) writeFile(path.join(outDir, "before", rel), before);
    if (after !== undefined) writeFile(path.join(outDir, "after", rel), after);
    if (before === undefined) added.push(rel);
    else if (after === undefined) removed.push(rel);
    else changed.push(rel);
  }

  let textDiff: string | null = null;
  let changesDiff: string | null = null;
  if (textChanged) {
    // 画像は diff/ で見るので、文字の差分からは外す
    const result = spawnSync("diff", ["-ruN", "-x", "*.png", "-x", "*.jpg", "-x", "*.jpeg", "-x", "*.gif", "-x", "*.webp", "before", "after"], {
      cwd: outDir,
      encoding: "utf8",
    });
    if (result.error) throw new Error(`diff を実行できない: ${result.error.message}`);
    textDiff = result.stdout;
    changesDiff = path.join(outDir, "changes.diff");
    writeFile(changesDiff, textDiff);
  }

  const same = added.length === 0 && removed.length === 0 && changed.length === 0;
  const report = path.join(outDir, "report.html");
  const summary: CompareSummary = { same, added, removed, changed, images, outDir, changesDiff, report };
  writeFile(report, reportHtml(summary, textDiff, beforeDir, afterDir));
  writeFile(path.join(outDir, SUMMARY_FILE), JSON.stringify(summary, null, 2) + "\n");
  return summary;
}

/** 比べた結果の置き場所の既定。<書き出しの置き場所>/compare/<before の名前>-<after の名前> */
export function defaultCompareDir(beforeDir: string, afterDir: string): string {
  const resultsParent = path.dirname(path.dirname(path.resolve(beforeDir)));
  return path.join(resultsParent, "compare", `${path.basename(beforeDir)}-${path.basename(afterDir)}`);
}

export function isDirectory(p: string): boolean {
  return existsSync(p) && statSync(p).isDirectory();
}

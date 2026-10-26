/**
 * 書き出しの比較 (compare-lib.mts) の結果を、人が見る report.html にする。
 * 変更が多くても追えるよう、画像は離れた変化ごとに切り出して並べ、構造の差分は同じ変化をまとめてから、ファイルごとに畳んで並べる。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { CompareSummary, ImageChange, SameChange } from "./compare-lib.mts";

export const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([".json", ".md", ".svg", ".txt"]);
export const CHANGES_DIFF_FILE = "changes.diff";
/** 構造の json でノードの始まりを示す行 (diff -F に渡す) */
export const NODE_ID_LINE = '"id": "';
/** report に載せる文字の差分の上限。超えたら changes.diff を開いてもらう */
const REPORT_TEXT_DIFF_MAX = 2 * 1024 * 1024;
/** これより行の多いファイルの差分は閉じておく */
const OPEN_DIFF_MAX_LINES = 300;
/** 差分のあるファイルがこれより多いか、行の合計がこれより多ければ、どのファイルも閉じておく */
const OPEN_FILES_MAX = 10;
const OPEN_TOTAL_LINES_MAX = 1000;
/** 「同じ変化」に載せる変化の種類の上限 */
const MAX_GROUPS = 20;
/** 「同じ変化」で最初に見せる行の数。残りは畳む */
const GROUP_PREVIEW_LINES = 8;

/** 離れた変化ごとの切り出し画像の置き場所 (index は 0 から) */
export function cropFile(side: "before" | "after" | "diff", rel: string, index: number): string {
  return path.posix.join("crop", side, rel.replace(/\.png$/i, `.${index + 1}.png`));
}

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

function missing(caption: string): string {
  return `<figure><figcaption>${caption}</figcaption><div class="missing">無い</div></figure>`;
}

function pct(value: number, whole: number): string {
  return `${((value / whole) * 100).toFixed(3)}%`;
}

// ---------------------------------------------------------------------------
// 画像
// ---------------------------------------------------------------------------

/** 切り出した範囲の番号 (0 から)。範囲が大きくて切り出さなかったものは含まない */
function croppedIndexes(image: ImageChange, outDir: string): number[] {
  return image.regions
    .map((_, i) => i)
    .filter((i) => existsSync(path.join(outDir, cropFile("diff", image.file, i))));
}

/** after の画像に、変わった箇所の枠と番号を重ねる */
function regionMap(image: ImageChange): string {
  const boxes = image.regions
    .map(
      (r, i) =>
        `<span class="box" style="left:${pct(r.x, image.width)};top:${pct(r.y, image.height)};width:${pct(
          r.width,
          image.width
        )};height:${pct(r.height, image.height)}"><b>${i + 1}</b></span>`
    )
    .join("");
  // 枠の座標は前後の大きい方にそろえた画像のものなので、同じ大きさの差分の画像に重ねる (after に重ねると、小さくなったときにずれる)
  return `<figure class="map"><figcaption>変わった箇所 (番号は下の切り出しと同じ)</figcaption><div class="map-inner"><img src="${src(
    "diff",
    image.file
  )}" loading="lazy" alt="">${boxes}</div></figure>`;
}

function imageArticle(image: ImageChange, index: number, summary: CompareSummary): string {
  const id = `img-${index + 1}`;
  const title = `<h3><code>${escapeHtml(image.file)}</code></h3>`;
  if (summary.added.includes(image.file) || summary.removed.includes(image.file)) {
    const added = summary.added.includes(image.file);
    const row = added
      ? `${missing("before")}${figure("after", src("after", image.file))}`
      : `${figure("before", src("before", image.file))}${missing("after")}`;
    return `<article id="${id}">${title}<p class="meta"><span class="tag">${added ? "足された" : "消えた"}</span> ${image.width}×${
      image.height
    }</p><div class="row">${row}</div></article>`;
  }
  const meta = `<p class="meta">違う画素 ${image.changedPixels.toLocaleString("en-US")} (${percent(image)}) ・ ${image.width}×${
    image.height
  }${image.regions.length === 0 ? "" : ` ・ 変わった箇所 ${image.regions.length}`}</p>`;
  const full = `<div class="row">${figure("before", src("before", image.file))}${figure("after", src("after", image.file))}${figure(
    "差分 (赤が違う画素)",
    src("diff", image.file)
  )}</div>`;
  const crops = croppedIndexes(image, summary.outDir);
  if (crops.length === 0) return `<article id="${id}">${title}${meta}${full}</article>`;
  const cards = crops
    .map((i) => {
      const r = image.regions[i];
      return `<div class="region"><h4><span class="num">${i + 1}</span> x ${r.x} y ${r.y} ・ ${r.width}×${r.height}</h4><div class="row">${figure(
        "before",
        src(cropFile("before", image.file, i))
      )}${figure("after", src(cropFile("after", image.file, i)))}${figure("差分", src(cropFile("diff", image.file, i)))}</div></div>`;
    })
    .join("");
  const rest =
    crops.length < image.regions.length
      ? `<p class="hint">切り出していない箇所 (範囲が広いか、数が多いもの) は、全体の画像で見る。</p>`
      : "";
  return `<article id="${id}">${title}${meta}<div class="overview">${regionMap(image)}<div class="regions">${cards}</div></div>${rest}
<details><summary>全体を見る</summary>${full}</details></article>`;
}

// ---------------------------------------------------------------------------
// 構造の差分
// ---------------------------------------------------------------------------

interface Hunk {
  header: string;
  /** 区切りの行に出たノード ID (diff -F)。変わった箇所の直前に始まるノード */
  nodeId: string | null;
  lines: string[];
}

interface FileDiff {
  file: string;
  hunks: Hunk[];
  added: number;
  removed: number;
  lineCount: number;
}

/** diff -ruN の出力をファイルと区切りごとに分ける。--- と +++ は diff の行の直後だけ見出しとして読む */
function splitDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: FileDiff | null = null;
  let inHeader = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff ")) {
      current = { file: "", hunks: [], added: 0, removed: 0, lineCount: 0 };
      files.push(current);
      inHeader = true;
      continue;
    }
    if (current === null) continue;
    if (inHeader && line.startsWith("--- ")) continue;
    if (inHeader && line.startsWith("+++ ")) {
      current.file = line.slice(4).split("\t")[0].replace(/^after\//, "");
      continue;
    }
    if (line.startsWith("@@")) {
      inHeader = false;
      const end = line.indexOf("@@", 2) + 2;
      const nodeId = /"id": "([^"]+)"/.exec(line.slice(end))?.[1] ?? null;
      current.hunks.push({ header: line.slice(0, end), nodeId, lines: [] });
      current.lineCount++;
      continue;
    }
    const hunk = current.hunks.at(-1);
    if (hunk === undefined || line === "") continue;
    if (line.startsWith("+")) current.added++;
    else if (line.startsWith("-")) current.removed++;
    hunk.lines.push(line);
    current.lineCount++;
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

function nodeLabel(nodeId: string | null, names: Map<string, string>): string {
  return nodeId === null ? "" : `${escapeHtml(names.get(nodeId) ?? "")} <code>${escapeHtml(nodeId)}</code>`;
}

function changeLine(line: string): string {
  const cls = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
  return `<span class="${cls}">${escapeHtml(line)}</span>`;
}

function hunkBlock(hunk: Hunk, names: Map<string, string>): string {
  const node = hunk.nodeId === null ? "" : ` <span class="node">${nodeLabel(hunk.nodeId, names)}</span>`;
  return `<span class="hunk">${escapeHtml(hunk.header)}${node}</span>${hunk.lines.map(changeLine).join("")}`;
}

/** 足した・消した行の中身 (字下げを除く) が同じ区切りを、同じ変化としてまとめる。2 箇所以上のものだけ、多い順に返す */
function groupSameChanges(files: readonly FileDiff[], names: ReadonlyMap<string, Map<string, string>>): SameChange[] {
  const groups = new Map<string, SameChange>();
  // SVG のコードは閉じておく約束なので、まとめにも出さない (同じ変化は構造の json の側に出る)
  for (const file of files.filter((f) => !f.file.toLowerCase().endsWith(".svg"))) {
    for (const hunk of file.hunks) {
      const changes = hunk.lines.filter((l) => l.startsWith("+") || l.startsWith("-"));
      if (changes.length === 0) continue;
      const key = changes.map((l) => l[0] + l.slice(1).trim()).join("\n");
      const group = groups.get(key) ?? { count: 0, lines: changes, places: [] };
      group.count++;
      const name = hunk.nodeId === null ? null : (names.get(file.file)!.get(hunk.nodeId) ?? null);
      group.places.push({ file: file.file, nodeId: hunk.nodeId, name });
      groups.set(key, group);
    }
  }
  return [...groups.values()].filter((g) => g.count >= 2).sort((a, b) => b.count - a.count);
}

/** changes.diff から同じ変化のまとめを作る (summary.json と report の両方で使う)。report に載せきれない大きな差分でも作る */
export function sameChangesOf(outDir: string, changesDiff: string): SameChange[] {
  const files = splitDiff(readFileSync(changesDiff, "utf8"));
  const names = new Map(files.map((f) => [f.file, nodeNames(outDir, f.file)]));
  return groupSameChanges(files, names);
}

function groupSection(groups: readonly SameChange[]): string {
  if (groups.length === 0) return "";
  return `<h3>同じ変化のまとめ</h3>
<p class="hint">同じ中身の変化 (足した・消した行が同じもの) をまとめ、多い順に並べる。場所を開くと、どのノードかが分かる。</p>
${groups.slice(0, MAX_GROUPS).map(groupBlock).join("\n")}${
    groups.length > MAX_GROUPS
      ? `<p class="hint">ほかに ${groups.length - MAX_GROUPS} 種類ある (全部は summary.json の sameChanges)。</p>`
      : ""
  }`;
}

function groupBlock(group: SameChange): string {
  const places = group.places
    .map(
      (p) =>
        `<li>${p.nodeId === null ? "(ノード不明)" : `${escapeHtml(p.name ?? "")} <code>${escapeHtml(p.nodeId)}</code>`} <span class="file">${escapeHtml(
          p.file
        )}</span></li>`
    )
    .join("");
  const head = group.lines.slice(0, GROUP_PREVIEW_LINES).map(changeLine).join("");
  const rest =
    group.lines.length > GROUP_PREVIEW_LINES
      ? `<details><summary>ほか ${group.lines.length - GROUP_PREVIEW_LINES} 行</summary><pre>${group.lines
          .slice(GROUP_PREVIEW_LINES)
          .map(changeLine)
          .join("")}</pre></details>`
      : "";
  return `<div class="group"><p><b>同じ変化が ${group.count} 箇所</b></p><pre>${head}</pre>${rest}
<details><summary>場所</summary><ul>${places}</ul></details></div>`;
}

function fileDiffBlock(diff: FileDiff, names: Map<string, string>, openAll: boolean): string {
  const isSvg = diff.file.toLowerCase().endsWith(".svg");
  const long = diff.lineCount > OPEN_DIFF_MAX_LINES;
  const open = openAll && !isSvg && !long;
  const note = isSvg ? "SVG のコード" : long ? `${diff.lineCount} 行` : "";
  return `<details class="file"${open ? " open" : ""}><summary><code>${escapeHtml(diff.file)}</code> <span class="add">+${
    diff.added
  }</span> <span class="del">-${diff.removed}</span> <span class="note">${diff.hunks.length} 箇所${note === "" ? "" : ` ・ ${note}`}</span></summary>
<pre>${diff.hunks.map((h) => hunkBlock(h, names)).join("")}</pre></details>`;
}

function textSection(summary: CompareSummary): string {
  if (summary.changesDiff === null) return "";
  const size = statSync(summary.changesDiff).size;
  if (size > REPORT_TEXT_DIFF_MAX) {
    return `<section id="text"><h2>構造の差分</h2>
${groupSection(summary.sameChanges)}
<p>ファイルごとの差分は大きい (${Math.round(size / 1024)} KB) ので載せていない。<a href="${CHANGES_DIFF_FILE}">${CHANGES_DIFF_FILE}</a> を開く。</p></section>`;
  }
  const files = splitDiff(readFileSync(summary.changesDiff, "utf8"));
  const names = new Map(files.map((f) => [f.file, nodeNames(summary.outDir, f.file)]));
  const groups = summary.sameChanges;
  const totalLines = files.reduce((n, f) => n + f.lineCount, 0);
  const openAll = files.length <= OPEN_FILES_MAX && totalLines <= OPEN_TOTAL_LINES_MAX;
  const groupsHtml = groups.length === 0 ? "" : `${groupSection(groups)}\n<h3>ファイルごとの差分</h3>`;
  return `<section id="text"><h2>構造の差分</h2>
<p class="hint">${
    openAll ? "SVG のコードと長い差分は閉じてある。" : "ファイルや行が多いので、全部閉じてある。"
  }見出しを押すと開く。区切りの行には、変わった箇所の直前に始まるノードの名前と ID が出る。全部は <a href="${CHANGES_DIFF_FILE}">${CHANGES_DIFF_FILE}</a></p>
${groupsHtml}
${files.map((f) => fileDiffBlock(f, names.get(f.file)!, openAll)).join("\n")}</section>`;
}

// ---------------------------------------------------------------------------
// 全体
// ---------------------------------------------------------------------------

function fileList(label: string, files: readonly string[]): string {
  if (files.length === 0) return "";
  return `<details><summary>${label} (${files.length})</summary><ul>${files
    .map((f) => `<li><code>${escapeHtml(f)}</code></li>`)
    .join("")}</ul></details>`;
}

const STYLE = `
  :root { --fg: #1a1a1a; --muted: #6b6b6b; --line: #e3e3e3; --bg: #fff; --panel: #f6f6f6; --add: #1a7f37; --add-bg: #e6f4ea; --del: #b42318; --del-bg: #fde8e7; --hunk: #6b6b6b; --mark: #ff2d55; }
  @media (prefers-color-scheme: dark) {
    :root { --fg: #e8e8e8; --muted: #a0a0a0; --line: #3a3a3a; --bg: #1c1c1c; --panel: #262626; --add: #6fd08c; --add-bg: #1f3326; --del: #ff8b80; --del-bg: #3d2220; --hunk: #a0a0a0; }
  }
  * { box-sizing: border-box; }
  body { font: 13px/1.6 -apple-system, "Hiragino Sans", sans-serif; margin: 0; color: var(--fg); background: var(--bg); }
  header { position: sticky; top: 0; z-index: 2; background: var(--bg); border-bottom: 1px solid var(--line); padding: 10px 16px; }
  h1 { font-size: 15px; margin: 0 0 4px; }
  .counts { display: flex; flex-wrap: wrap; gap: 4px 16px; list-style: none; margin: 0; padding: 0; color: var(--muted); }
  .counts b { color: var(--fg); }
  main { padding: 0 16px 32px; }
  h2 { font-size: 14px; margin: 24px 0 8px; }
  h3 { font-size: 13px; margin: 16px 0 4px; }
  h4 { font-size: 12px; margin: 0 0 4px; font-weight: normal; color: var(--muted); }
  a { color: inherit; }
  .hint, .meta, figcaption, .note, .file { color: var(--muted); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 8px; }
  .card { display: flex; flex-direction: column; gap: 2px; padding: 6px; border: 1px solid var(--line); border-radius: 6px; text-decoration: none; }
  .card img { height: 96px; object-fit: contain; }
  .card .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  article { border-top: 1px solid var(--line); padding: 16px 0; scroll-margin-top: 80px; }
  .row { display: flex; gap: 12px; align-items: flex-start; margin-top: 8px; }
  figure { flex: 1; min-width: 0; margin: 0; }
  img { display: block; max-width: 100%; border: 1px solid var(--line); background: repeating-conic-gradient(#c8c8c8 0 25%, #e8e8e8 0 50%) 0 0 / 16px 16px; }
  body[data-bg="white"] img { background: #fff; }
  body[data-bg="black"] img { background: #000; }
  .missing { display: flex; align-items: center; justify-content: center; min-height: 96px; border: 1px dashed var(--line); color: var(--muted); }
  .overview { display: flex; gap: 16px; align-items: flex-start; margin-top: 8px; }
  .map { flex: 0 0 280px; position: sticky; top: 80px; }
  .map-inner { position: relative; }
  .map-inner img { width: 100%; }
  .box { position: absolute; border: 2px solid var(--mark); min-width: 6px; min-height: 6px; }
  .box b { position: absolute; top: -2px; left: -2px; transform: translateY(-100%); background: var(--mark); color: #fff; font-size: 10px; line-height: 1; padding: 2px 3px; border-radius: 2px; }
  .regions { flex: 1; min-width: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: 12px; }
  .region { border: 1px solid var(--line); border-radius: 6px; padding: 8px; }
  .region .row { margin-top: 0; }
  .region img { width: 100%; }
  .num { display: inline-block; min-width: 18px; text-align: center; background: var(--mark); color: #fff; border-radius: 3px; margin-right: 4px; }
  .tag { border: 1px solid var(--line); border-radius: 4px; padding: 0 6px; }
  .bg { display: inline-flex; gap: 4px; }
  .bg button { font: inherit; color: inherit; background: none; border: 1px solid var(--line); border-radius: 4px; padding: 0 6px; cursor: pointer; }
  .bg button[aria-pressed="true"] { background: var(--panel); border-color: var(--muted); }
  details { margin: 8px 0; }
  summary { cursor: pointer; }
  details.file, .group { border: 1px solid var(--line); border-radius: 6px; }
  details.file > summary { padding: 6px 10px; background: var(--panel); border-radius: 6px; }
  .group { padding: 6px 10px; margin: 8px 0; }
  .group p { margin: 0; }
  pre { margin: 0; padding: 8px 0; overflow: auto; font: 12px/1.5 ui-monospace, Menlo, monospace; }
  pre > span { display: block; padding: 0 10px; white-space: pre; }
  span.add { color: var(--add); }
  span.del { color: var(--del); }
  pre .add { background: var(--add-bg); }
  pre .del { background: var(--del-bg); }
  pre .hunk { color: var(--hunk); background: var(--panel); margin-top: 4px; }
  pre .node, .group li { color: var(--fg); }
  pre .node { font-weight: 600; }
  pre .node code { color: var(--muted); font-weight: normal; }
  footer { color: var(--muted); padding: 16px; border-top: 1px solid var(--line); }
  @media (max-width: 760px) { .row, .overview { flex-direction: column; } .map { position: static; flex-basis: auto; width: 100%; } .regions { grid-template-columns: 1fr; } }
`;

const SCRIPT = `
  // 白や黒の図形は市松の背景に溶けるので、背景を切り替えられるようにする
  for (const button of document.querySelectorAll(".bg button")) {
    button.addEventListener("click", () => {
      document.body.dataset.bg = button.dataset.bg;
      for (const b of document.querySelectorAll(".bg button")) b.setAttribute("aria-pressed", String(b === button));
    });
  }
`;

export function reportHtml(summary: CompareSummary, beforeDir: string, afterDir: string): string {
  const images = [...summary.images].sort((a, b) => b.changedPixels - a.changedPixels);
  const thumb = (image: ImageChange) => {
    if (summary.added.includes(image.file)) return src("after", image.file);
    if (summary.removed.includes(image.file)) return src("before", image.file);
    const first = croppedIndexes(image, summary.outDir)[0];
    return first === undefined ? src("diff", image.file) : src(cropFile("diff", image.file, first));
  };
  const cardMeta = (image: ImageChange) =>
    summary.added.includes(image.file)
      ? "足された"
      : summary.removed.includes(image.file)
        ? "消えた"
        : `${percent(image)}${image.regions.length > 1 ? ` ・ ${image.regions.length} 箇所` : ""}`;
  const cards = images
    .map(
      (image, i) =>
        `<a class="card" href="#img-${i + 1}"><img src="${thumb(image)}" loading="lazy" alt=""><span class="name">${escapeHtml(
          path.posix.basename(image.file)
        )}</span><span class="meta">${cardMeta(image)}</span></a>`
    )
    .join("");
  const textFiles = [...summary.changed, ...summary.added, ...summary.removed].filter((f) =>
    TEXT_EXTENSIONS.has(path.extname(f).toLowerCase())
  ).length;
  const count = (label: string, n: number, href: string) =>
    n === 0 ? "" : `<li><a href="${href}">${label}</a> <b>${n}</b></li>`;
  const bgSwitch =
    images.length === 0
      ? ""
      : `<li class="bg">画像の背景 <button type="button" data-bg="checker" aria-pressed="true">市松</button><button type="button" data-bg="white" aria-pressed="false">白</button><button type="button" data-bg="black" aria-pressed="false">黒</button></li>`;

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>書き出しの比較</title>
<style>${STYLE}</style>
</head>
<body>
<header>
<h1>${summary.same ? "変わったところは無い" : "変わったところがある"}</h1>
<ul class="counts">
${count("見た目が変わった画像", images.length, "#images")}
${count("構造の差分があるファイル", textFiles, "#text")}
${count("足された", summary.added.length, "#files")}
${count("消えた", summary.removed.length, "#files")}
${count("名前が変わった", summary.renamed.length, "#files")}
${bgSwitch}
</ul>
</header>
<main>
${
  images.length === 0
    ? ""
    : `<section id="images"><h2>見た目が変わった画像 (違う画素の多い順)</h2>
<p class="hint">離れた所の変化は、1 箇所ずつ切り出して並べる。左の図の枠の番号が、切り出しの番号。画像を押すと原寸で開く。</p>
<div class="grid">${cards}</div>
${images.map((image, i) => imageArticle(image, i, summary)).join("\n")}
</section>`
}
${textSection(summary)}
<section id="files"><h2>ファイルの一覧</h2>
${fileList("変わった", summary.changed)}
${fileList("足された", summary.added)}
${fileList("消えた", summary.removed)}
${fileList("名前が変わった", summary.renamed.map((r) => `${r.before} → ${r.after}`))}
</section>
</main>
<footer>before: <code>${escapeHtml(beforeDir)}</code><br>after: <code>${escapeHtml(afterDir)}</code></footer>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
